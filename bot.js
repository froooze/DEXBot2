#!/usr/bin/env node
/**
 * bot.js - PM2-friendly entry point for single bot instance
 *
 * Standalone bot launcher executed by PM2 for each configured bot.
 * Handles bot initialization, authentication, and trading loop management.
 *
 * 1. Bot Configuration Loading
 *    - Reads bot settings from profiles/bots.json by bot name (from argv)
 *    - Validates bot exists in configuration
 *    - Reports market pair and account being used
 *
 * 2. Master Password Authentication
 *    - First checks MASTER_PASSWORD environment variable (set by pm2.js)
 *    - Falls back to interactive prompt if env var not set
 *    - Suppresses BitShares client logs during password entry
 *    - Password never written to disk
 *
 * 3. Bot Initialization
 *    - Waits for BitShares connection (30 second timeout)
 *    - Loads private key for configured account
 *    - Resolves account ID from BitShares
 *    - Initializes OrderManager with bot configuration
 *
 * 4. Grid Initialization or Resume
 *    - Loads persisted grid if it exists and matches on-chain orders
 *    - Places initial orders if no existing grid found
 *    - Synchronizes grid state with BitShares blockchain
 *
 * 5. Trading Loop
 *    - Continuously monitors for fill events
 *    - Updates order status from chain
 *    - Regenerates grid as needed
 *    - Runs indefinitely (PM2 manages restart/stop)
 *
 * Usage:
 *   Direct (single bot): node bot.js <bot-name>
 *   Via PM2 ecosystem: pm2 start profiles/ecosystem.config.js
 *   Full setup: npm run pm2:unlock-start or node dexbot.js pm2
 *
 * Environment Variables:
 *   MASTER_PASSWORD - Master password for account (set by pm2.js)
 *   RUN_LOOP_MS     - Trading loop interval in ms (default: 5000)
 *   BOT_NAME        - Bot name (alternative to argv)
 *
 * Logs:
 *   - Bot output: profiles/logs/{botname}.log
 *   - Bot errors: profiles/logs/{botname}-error.log
 *   - Rotated automatically by PM2
 *
 * Security:
 *   - Master password from environment variable (RAM only)
 *   - No password written to disk
 *   - Private key loaded into memory
 *   - All sensitive operations in encrypted BitShares module
 */

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./modules/bitshares_client');
const chainKeys = require('./modules/chain_keys');
const chainOrders = require('./modules/chain_orders');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./modules/order');
const { persistGridSnapshot, retryPersistenceIfNeeded } = OrderUtils;
const { ORDER_STATES } = require('./modules/constants');
const { attemptResumePersistedGridByPriceMatch, decideStartupGridAction } = require('./modules/order/startup_reconcile');
const { AccountOrders, createBotKey } = require('./modules/account_orders');
const accountBots = require('./modules/account_bots');
const { parseJsonWithComments } = accountBots;

const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

// Get bot name from args or environment
let botNameArg = process.argv[2];
if (botNameArg && botNameArg.startsWith('--')) {
    botNameArg = botNameArg.substring(2);
}
const botNameEnv = process.env.BOT_NAME || process.env.PREFERRED_ACCOUNT;
const botName = botNameArg || botNameEnv;

if (!botName) {
    console.error('[bot.js] No bot name provided. Usage: node bot.js <bot-name>');
    console.error('[bot.js] Or set BOT_NAME or PREFERRED_ACCOUNT environment variable');
    process.exit(1);
}

console.log(`[bot.js] Starting bot: ${botName}`);

// Load bot configuration from profiles/bots.json
function loadBotConfig(name) {
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        console.error('[bot.js] profiles/bots.json not found. Run: npm run bootstrap:profiles');
        process.exit(1);
    }

    try {
        const content = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
        const config = parseJsonWithComments(content);
        const bots = config.bots || [];
        const botEntry = bots.find(b => b.name === name);

        if (!botEntry) {
            console.error(`[bot.js] Bot '${name}' not found in profiles/bots.json`);
            console.error(`[bot.js] Available bots: ${bots.map(b => b.name).join(', ') || 'none'}`);
            process.exit(1);
        }

        return botEntry;
    } catch (err) {
        console.error(`[bot.js] Error loading bot config:`, err.message);
        process.exit(1);
    }
}

// Authenticate master password
async function authenticateMasterPassword() {
    // Check environment variable first
    if (process.env.MASTER_PASSWORD) {
        console.log('[bot.js] Master password loaded from environment');
        return process.env.MASTER_PASSWORD;
    }

    // Try interactive prompt
    try {
        console.log('[bot.js] Prompting for master password...');

        // Suppress BitShares client logs during password prompt
        const originalLog = console.log;
        console.log = (...args) => {
            const msg = args.join(' ');
            if (!msg.includes('bitshares_client') && !msg.includes('modules/')) {
                originalLog(...args);
            }
        };

        const masterPassword = await chainKeys.authenticate();

        // Restore console output
        console.log = originalLog;
        console.log('[bot.js] Master password authenticated successfully');
        return masterPassword;
    } catch (err) {
        if (err && err.message && err.message.includes('No master password set')) {
            console.error('[bot.js] No master password set. Run: node dexbot.js keys');
            process.exit(1);
        }
        throw err;
    }
}

// Normalize bot entry with metadata
function normalizeBotEntry(entry, index = 0) {
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
    return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
}

/**
 * DEXBot - Core trading bot class (copied from dexbot.js)
 */
class DEXBot {
    constructor(config) {
        this.config = config;
        this.account = null;
        this.privateKey = null;
        this.manager = null;
        this.accountOrders = null;  // Will be initialized in start()
        this.isResyncing = false;
        this.triggerFile = path.join(PROFILES_DIR, `recalculate.${config.botKey}.trigger`);
        this._recentlyProcessedFills = new Map();
        this._fillDedupeWindowMs = 5000;
        this._processingFill = false;
        this._pendingFills = [];
    }

    async initialize(masterPassword = null) {
        await waitForConnected(30000);
        let accountData = null;
        if (this.config && this.config.preferredAccount) {
            try {
                const pwd = masterPassword || await chainKeys.authenticate();
                const privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, pwd);
                let accId = null;
                try {
                    const full = await BitShares.db.get_full_accounts([this.config.preferredAccount], false);
                    if (full && full[0]) {
                        const maybe = full[0][0];
                        if (maybe && String(maybe).startsWith('1.2.')) accId = maybe;
                        else if (full[0][1] && full[0][1].account && full[0][1].account.id) accId = full[0][1].account.id;
                    }
                } catch (e) { /* best-effort */ }

                if (accId) chainOrders.setPreferredAccount(accId, this.config.preferredAccount);
                accountData = { accountName: this.config.preferredAccount, privateKey, id: accId };
            } catch (err) {
                console.warn('[bot.js] Auto-selection of preferredAccount failed:', err.message);
                throw err;
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
        this.account = accountData.accountName;
        this.accountId = accountData.id || null;
        this.privateKey = accountData.privateKey;
        console.log(`[bot.js] Initialized DEXBot for account: ${this.account}`);
    }

    async placeInitialOrders() {
        if (!this.manager) {
            this.manager = new OrderManager(this.config);
            this.manager.accountOrders = this.accountOrders;  // Enable pendingProceeds persistence
        }
        try {
            const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await this.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch) {
            console.warn('[bot.js] Could not fetch account totals before initializing grid:', errFetch && errFetch.message ? errFetch.message : errFetch);
        }

        await Grid.initializeGrid(this.manager);

        if (this.config.dryRun) {
            this.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
            return;
        }

        this.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = this.manager.getInitialOrdersToActivate();

        const sellOrders = ordersToActivate.filter(o => o.type === 'sell');
        const buyOrders = ordersToActivate.filter(o => o.type === 'buy');
        const interleavedOrders = [];
        const maxLen = Math.max(sellOrders.length, buyOrders.length);
        for (let i = 0; i < maxLen; i++) {
            if (i < sellOrders.length) interleavedOrders.push(sellOrders[i]);
            if (i < buyOrders.length) interleavedOrders.push(buyOrders[i]);
        }

        const { assetA, assetB } = this.manager.assets;

        const buildCreateOrderArgs = (order) => {
            let amountToSell, sellAssetId, minToReceive, receiveAssetId;
            if (order.type === 'sell') {
                amountToSell = order.size;
                sellAssetId = assetA.id;
                minToReceive = order.size * order.price;
                receiveAssetId = assetB.id;
            } else {
                amountToSell = order.size;
                sellAssetId = assetB.id;
                minToReceive = order.size / order.price;
                receiveAssetId = assetA.id;
            }
            return { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        };

        const createAndSyncOrder = async (order) => {
            this.manager.logger.log(`Placing ${order.type} order: size=${order.size}, price=${order.price}`, 'debug');
            const args = buildCreateOrderArgs(order);
            const result = await chainOrders.createOrder(
                this.account, this.privateKey, args.amountToSell, args.sellAssetId,
                args.minToReceive, args.receiveAssetId, null, false
            );
            const chainOrderId = result && result[0] && result[0].trx && result[0].trx.operation_results && result[0].trx.operation_results[0] && result[0].trx.operation_results[0][1];
            if (!chainOrderId) {
                throw new Error('Order creation response missing order_id');
            }
            await this.manager.synchronizeWithChain({ gridOrderId: order.id, chainOrderId }, 'createOrder');
        };

        const placeOrderGroup = async (ordersGroup) => {
            const settled = await Promise.allSettled(ordersGroup.map(order => createAndSyncOrder(order)));
            settled.forEach((result, index) => {
                if (result.status === 'rejected') {
                    const order = ordersGroup[index];
                    const reason = result.reason;
                    const errMsg = reason && reason.message ? reason.message : `${reason}`;
                    this.manager.logger.log(`Failed to place ${order.type} order ${order.id}: ${errMsg}`, 'error');
                }
            });
        };

        const orderGroups = [];
        for (let i = 0; i < interleavedOrders.length;) {
            const current = interleavedOrders[i];
            const next = interleavedOrders[i + 1];
            if (next && current.type === 'sell' && next.type === 'buy') {
                orderGroups.push([current, next]);
                i += 2;
            } else {
                orderGroups.push([current]);
                i += 1;
            }
        }

        for (const group of orderGroups) {
            await placeOrderGroup(group);
        }
        persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
    }

    async updateOrdersOnChainBatch(rebalanceResult) {
        const { ordersToPlace, ordersToRotate, partialMoves = [] } = rebalanceResult;

        if (this.config.dryRun) {
            if (ordersToPlace && ordersToPlace.length > 0) {
                this.manager.logger.log(`Dry run: would place ${ordersToPlace.length} new orders on-chain`, 'info');
            }
            if (ordersToRotate && ordersToRotate.length > 0) {
                this.manager.logger.log(`Dry run: would update ${ordersToRotate.length} orders on-chain`, 'info');
            }
            if (partialMoves && partialMoves.length > 0) {
                this.manager.logger.log(`Dry run: would move ${partialMoves.length} partial order(s) on-chain`, 'info');
            }
            return;
        }

        const { assetA, assetB } = this.manager.assets;
        const operations = [];
        const opContexts = [];

        const buildCreateOrderArgs = (order) => {
            let amountToSell, sellAssetId, minToReceive, receiveAssetId;
            if (order.type === 'sell') {
                amountToSell = order.size;
                sellAssetId = assetA.id;
                minToReceive = order.size * order.price;
                receiveAssetId = assetB.id;
            } else {
                amountToSell = order.size;
                sellAssetId = assetB.id;
                minToReceive = order.size / order.price;
                receiveAssetId = assetA.id;
            }
            return { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        };

        // Step 1: Build create operations
        if (ordersToPlace && ordersToPlace.length > 0) {
            for (const order of ordersToPlace) {
                try {
                    const args = buildCreateOrderArgs(order);
                    const op = await chainOrders.buildCreateOrderOp(
                        this.account, args.amountToSell, args.sellAssetId,
                        args.minToReceive, args.receiveAssetId, null
                    );
                    operations.push(op);
                    opContexts.push({ kind: 'create', order });
                } catch (err) {
                    this.manager.logger.log(`Failed to prepare create op for ${order.type} order ${order.id}: ${err.message}`, 'error');
                }
            }
        }

        // Step 2: Build update operations for partial order moves (processed before rotations for atomic swap semantics)
        if (partialMoves && partialMoves.length > 0) {
            for (const moveInfo of partialMoves) {
                try {
                    const { partialOrder, newMinToReceive } = moveInfo;
                    if (!partialOrder.orderId) continue;

                    const op = await chainOrders.buildUpdateOrderOp(
                        this.account, partialOrder.orderId,
                        { minToReceive: newMinToReceive }
                    );

                    if (op) {
                        operations.push(op);
                        opContexts.push({ kind: 'partial-move', moveInfo });
                        this.manager.logger.log(
                            `Prepared partial move op: ${partialOrder.orderId} price ${partialOrder.price.toFixed(4)} -> ${moveInfo.newPrice.toFixed(4)}`,
                            'info'
                        );
                    } else {
                        this.manager.logger.log(`No change needed for partial move of ${partialOrder.orderId}`, 'debug');
                    }
                } catch (err) {
                    this.manager.logger.log(`Failed to prepare partial move op: ${err.message}`, 'error');
                }
            }
        }

        // Step 3: Build update operations (rotation)
        if (ordersToRotate && ordersToRotate.length > 0) {
            const seenOrderIds = new Set();
            const uniqueRotations = ordersToRotate.filter(r => {
                const orderId = r?.oldOrder?.orderId;
                if (!orderId || seenOrderIds.has(orderId)) {
                    if (orderId) this.manager.logger.log(`Skipping duplicate rotation for ${orderId}`, 'debug');
                    return false;
                }
                seenOrderIds.add(orderId);
                return true;
            });

            for (const rotation of uniqueRotations) {
                try {
                    const { oldOrder, newPrice, newSize, type } = rotation;
                    if (!oldOrder.orderId) continue;

                    let newAmountToSell, newMinToReceive;
                    if (type === 'sell') {
                        newAmountToSell = newSize;
                        newMinToReceive = newSize * newPrice;
                    } else {
                        newAmountToSell = newSize;
                        newMinToReceive = newSize / newPrice;
                    }

                    const op = await chainOrders.buildUpdateOrderOp(
                        this.account, oldOrder.orderId,
                        { amountToSell: newAmountToSell, minToReceive: newMinToReceive }
                    );

                    if (op) {
                        operations.push(op);
                        opContexts.push({ kind: 'rotation', rotation });
                    } else {
                        this.manager.logger.log(`No change needed for rotation of ${oldOrder.orderId}`, 'debug');
                    }
                } catch (err) {
                    this.manager.logger.log(`Failed to prepare update op for rotation: ${err.message}`, 'error');
                }
            }
        }

        if (operations.length === 0) {
            return;
        }

        // Step 4: Execute Batch
        try {
            this.manager.logger.log(`Broadcasting batch with ${operations.length} operations...`, 'info');
            const result = await chainOrders.executeBatch(this.account, this.privateKey, operations);

            // Step 5: Map results in operation order (supports atomic partial-move + rotation swaps)
            const results = (result && result[0] && result[0].trx && result[0].trx.operation_results) || [];

            for (let i = 0; i < opContexts.length; i++) {
                const ctx = opContexts[i];
                const res = results[i];

                if (ctx.kind === 'create') {
                    const { order } = ctx;
                    const chainOrderId = res && res[1];
                    if (chainOrderId) {
                        await this.manager.synchronizeWithChain({ gridOrderId: order.id, chainOrderId }, 'createOrder');
                        this.manager.logger.log(`Placed ${order.type} order ${order.id} -> ${chainOrderId}`, 'info');
                    } else {
                        this.manager.logger.log(`Batch result missing ID for created order ${order.id}`, 'warn');
                    }
                    continue;
                }

                if (ctx.kind === 'partial-move') {
                    const { moveInfo } = ctx;
                    this.manager.completePartialOrderMove(moveInfo);
                    await this.manager.synchronizeWithChain(
                        { gridOrderId: moveInfo.newGridId, chainOrderId: moveInfo.partialOrder.orderId },
                        'createOrder'
                    );
                    this.manager.logger.log(
                        `Partial move complete: ${moveInfo.partialOrder.orderId} moved to ${moveInfo.newPrice.toFixed(4)}`,
                        'info'
                    );
                    continue;
                }

                if (ctx.kind === 'rotation') {
                    const { rotation } = ctx;
                    const { oldOrder, newPrice, newGridId } = rotation;

                    if (rotation.usingOverride) {
                        const slot = this.manager.orders.get(newGridId) || { id: newGridId, type: rotation.type, price: newPrice, size: 0, state: ORDER_STATES.VIRTUAL };
                        const updatedSlot = {
                            ...slot,
                            id: newGridId,
                            type: rotation.type,
                            size: rotation.newSize,
                            price: newPrice,
                            state: ORDER_STATES.VIRTUAL,
                            orderId: null
                        };
                        this.manager._updateOrder(updatedSlot);
                    }

                    this.manager.completeOrderRotation(oldOrder);
                    await this.manager.synchronizeWithChain({ gridOrderId: newGridId, chainOrderId: oldOrder.orderId }, 'createOrder');
                    this.manager.logger.log(`Rotation complete: ${oldOrder.orderId} moved to ${newPrice.toFixed(4)}`, 'info');
                }
            }

        } catch (err) {
            this.manager.logger.log(`Batch transaction failed: ${err.message}`, 'error');
            // If batch fails, should we try to revert or just let the next sync fix it?
            // The next sync/loop will see discrepancies and fix them, though funds might be momentarily desync.
        }
    }

    async start(masterPassword = null) {
        await this.initialize(masterPassword);
        
        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });
        
        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;  // Enable pendingProceeds persistence
        }

        // Ensure fee cache is initialized before any fill processing that calls getAssetFees().
        // This must run after we have a BitShares connection and before we can process offline fills.
        try {
            await OrderUtils.initializeFeeCache([this.config || {}], BitShares);
        } catch (err) {
            console.warn(`[bot.js] Fee cache initialization failed: ${err.message}`);
        }

        // Start listening for fills
        await chainOrders.listenForFills(this.account || undefined, async (fills) => {
            if (this.manager && !this.isResyncing && !this.config.dryRun) {
                // Queue fills if already processing to prevent concurrent operations
                if (this._processingFill) {
                    this._pendingFills.push(...fills);
                    this.manager.logger.log(`Fill processing in progress, queued ${fills.length} fill(s)`, 'debug');
                    return;
                }
                this._processingFill = true;

                try {
                    const allFills = [...fills, ...this._pendingFills];
                    this._pendingFills = [];

                    const validFills = [];
                    const processedFillKeys = new Set();

                    // 1. Filter and Deduplicate
                    for (const fill of allFills) {
                        if (fill && fill.op && fill.op[0] === 4) {
                            const fillOp = fill.op[1];
                            if (fillOp.is_maker === false) {
                                this.manager.logger.log(`Skipping taker fill (is_maker=false)`, 'debug');
                                continue;
                            }

                            // Use (order_id, block_num, history_id) as unique key to handle multiple fills in same block
                            // History ID is unique per operation entry: format is "1.11.XXXXX"
                            const fillKey = `${fillOp.order_id}:${fill.block_num}:${fill.id || ''}`;
                            const now = Date.now();
                            if (this._recentlyProcessedFills.has(fillKey)) {
                                const lastProcessed = this._recentlyProcessedFills.get(fillKey);
                                if (now - lastProcessed < this._fillDedupeWindowMs) {
                                    this.manager.logger.log(`Skipping duplicate fill for ${fillOp.order_id} (processed ${now - lastProcessed}ms ago)`, 'debug');
                                    continue;
                                }
                            }

                            // Check local dedupe set for this batch
                            if (processedFillKeys.has(fillKey)) continue;

                            processedFillKeys.add(fillKey);
                            this._recentlyProcessedFills.set(fillKey, now);
                            validFills.push(fill);

                            // Log nicely formatted fill info
                            const paysAmount = fillOp.pays ? fillOp.pays.amount : '?';
                            const paysAsset = fillOp.pays ? fillOp.pays.asset_id : '?';
                            const receivesAmount = fillOp.receives ? fillOp.receives.amount : '?';
                            const receivesAsset = fillOp.receives ? fillOp.receives.asset_id : '?';
                            console.log(`\n===== FILL DETECTED =====`);
                            console.log(`Order ID: ${fillOp.order_id}`);
                            console.log(`Pays: ${paysAmount} (asset ${paysAsset})`);
                            console.log(`Receives: ${receivesAmount} (asset ${receivesAsset})`);
                            console.log(`is_maker: ${fillOp.is_maker}`);
                            console.log(`Block: ${fill.block_num}, Time: ${fill.block_time}`);
                            console.log(`History ID: ${fill.id || 'N/A'}`);
                            console.log(`=========================\n`);
                        }
                    }

                    // Clean up old entries
                    const now = Date.now();
                    for (const [key, timestamp] of this._recentlyProcessedFills) {
                        if (now - timestamp > this._fillDedupeWindowMs * 2) {
                            this._recentlyProcessedFills.delete(key);
                        }
                    }

                    if (validFills.length === 0) return;

                    // 2. Sync and Collect Filled Orders
                    const allFilledOrders = [];
                    let ordersNeedingCorrection = [];
                    const fillMode = chainOrders.getFillProcessingMode();

                    if (fillMode === 'history') {
                        this.manager.logger.log(`Processing batch of ${validFills.length} fills using 'history' mode`, 'info');
                        for (const fill of validFills) {
                            const fillOp = fill.op[1];
                            const result = this.manager.syncFromFillHistory(fillOp);
                            if (result.filledOrders) allFilledOrders.push(...result.filledOrders);
                        }
                    } else {
                        // Open orders mode: fetch once, then sync each fill against it
                        this.manager.logger.log(`Processing batch of ${validFills.length} fills using 'open' mode`, 'info');
                        const chainOpenOrders = await chainOrders.readOpenOrders(this.account);
                        const result = this.manager.syncFromOpenOrders(chainOpenOrders, validFills[0].op[1]);
                        if (result.filledOrders) allFilledOrders.push(...result.filledOrders);
                        if (result.ordersNeedingCorrection) ordersNeedingCorrection = result.ordersNeedingCorrection;
                    }

                    // 3. Handle Price Corrections (immediate, loose - keeping original logic for now)
                    if (ordersNeedingCorrection.length > 0) {
                        this.manager.logger.log(`Correcting ${ordersNeedingCorrection.length} order(s) with price mismatch...`, 'info');
                        const correctionResult = await OrderUtils.correctAllPriceMismatches(
                            this.manager, this.account, this.privateKey, chainOrders
                        );
                        if (correctionResult.failed > 0) {
                            this.manager.logger.log(`${correctionResult.failed} order correction(s) failed`, 'error');
                        }
                    }

                    // 4. Batch Rebalance and Execution
                    if (allFilledOrders.length > 0) {
                        this.manager.logger.log(`Aggregating ${allFilledOrders.length} filled orders for batch processing...`, 'info');

                        // This updates funds with proceeds from ALL filled orders and returns the rebalance result
                        const rebalanceResult = await this.manager.processFilledOrders(allFilledOrders);

                        // Execute batch transaction
                        await this.updateOrdersOnChainBatch(rebalanceResult);
                    }

                    // Always persist snapshot after processing fills if we did anything
                    if (validFills.length > 0) {
                        persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                    }

                    // Attempt to retry any previously failed persistence operations
                    retryPersistenceIfNeeded(this.manager);
                } catch (err) {
                    this.manager?.logger?.log(`Error processing fill: ${err.message}`, 'error');
                } finally {
                    this._processingFill = false;
                    // Process any fills that arrived while we were busy
                    if (this._pendingFills.length > 0) {
                        const pending = this._pendingFills;
                        this._pendingFills = [];
                        // Re-invoke the listener with pending fills
                        setTimeout(() => {
                            chainOrders.listenForFills(this.account, () => { }); // dummy to trigger
                        }, 100);
                    }
                }
            }
        });

        // Ensure entries exist for ALL active bots (prevents pruning other bots)
        // Must be done BEFORE loading persisted grid to avoid overwriting saved grids
        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        const allActiveBots = allBotsConfig
            .filter(b => b.active !== false)
            .map((b, idx) => normalizeBotEntry(b, idx));
        this.accountOrders.ensureBotEntries(allActiveBots);

        const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey);
        const persistedCacheFunds = this.accountOrders.loadCacheFunds(this.config.botKey);
        const persistedPendingProceeds = this.accountOrders.loadPendingProceeds(this.config.botKey);
        const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed(this.config.botKey);

        // Restore cacheFunds to manager if found
        if (persistedCacheFunds) {
            this.manager.funds.cacheFunds = { ...persistedCacheFunds };
        }

        // CRITICAL: Restore pendingProceeds from partial fills
        // This ensures fill proceeds from before the restart are not lost
        if (persistedPendingProceeds) {
            this.manager.funds.pendingProceeds = { ...persistedPendingProceeds };
            console.log(`[bot.js] ✓ Restored pendingProceeds from startup: Buy ${(persistedPendingProceeds.buy || 0).toFixed(8)}, Sell ${(persistedPendingProceeds.sell || 0).toFixed(8)}`);
        } else {
            console.log(`[bot.js] ℹ No pendingProceeds to restore (fresh start or no partial fills)`);
        }

        // CRITICAL: Restore BTS fees owed from blockchain operations
        // This ensures fees are properly deducted from proceeds, preventing fund loss on restart
        if (persistedBtsFeesOwed > 0) {
            this.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
            console.log(`[bot.js] ✓ Restored BTS fees owed: ${persistedBtsFeesOwed.toFixed(8)} BTS`);
        }
        
        // Use this.accountId which was set during initialize()
        const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

        const debugStartup = process.env.DEBUG_STARTUP === '1';
        if (debugStartup) {
            console.log(`[bot.js] DEBUG STARTUP: chainOpenOrders.length = ${chainOpenOrders.length}`);
            console.log(`[bot.js] DEBUG STARTUP: persistedGrid.length = ${persistedGrid ? persistedGrid.length : 0}`);
        }

        let shouldRegenerate = false;
        if (!persistedGrid || persistedGrid.length === 0) {
            shouldRegenerate = true;
            console.log('[bot.js] No persisted grid found. Generating new grid.');
        } else {
            await this.manager._initializeAssets();
            const decision = await decideStartupGridAction({
                persistedGrid,
                chainOpenOrders,
                manager: this.manager,
                logger: { log: (msg) => console.log(`[bot.js] ${msg}`) },
                storeGrid: (orders) => {
                    // Temporarily replace manager.orders to persist the specific orders
                    const originalOrders = this.manager.orders;
                    this.manager.orders = new Map(orders.map(o => [o.id, o]));
                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                    this.manager.orders = originalOrders;
                },
                attemptResumeFn: attemptResumePersistedGridByPriceMatch,
            });
            shouldRegenerate = decision.shouldRegenerate;

            if (debugStartup) {
                console.log(`[bot.js] DEBUG STARTUP: hasActiveMatch = ${decision.hasActiveMatch}`);
            }

            if (shouldRegenerate && chainOpenOrders.length === 0) {
                console.log('[bot.js] Persisted grid found, but no matching active orders on-chain. Generating new grid.');
            }
        }

        if (shouldRegenerate) {
            await this.manager._initializeAssets();
            console.log('[bot.js] Generating new grid.');
            await Grid.initializeGrid(this.manager);
            this.manager.funds.pendingProceeds = { buy: 0, sell: 0 };
            
            // If there are existing on-chain orders, reconcile them with the new grid
            if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                console.log(`[bot.js] Found ${chainOpenOrders.length} existing chain orders. Syncing them onto the new grid.`);
                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                const { reconcileStartupOrders } = require('./modules/order/startup_reconcile');
                await reconcileStartupOrders({
                    manager: this.manager,
                    config: this.config,
                    account: this.account,
                    privateKey: this.privateKey,
                    chainOrders,
                    chainOpenOrders,
                    syncResult,
                });
            } else {
                // No existing orders: place initial orders on-chain
                console.log('[bot.js] No existing chain orders found. Placing initial orders.');
                await this.placeInitialOrders();
            }
            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
        } else {
            console.log('[bot.js] Found active session. Loading and syncing existing grid.');
            await Grid.loadGrid(this.manager, persistedGrid);
            const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

            // Reconcile existing on-chain orders to the configured target counts.
            // This ensures activeOrders changes in bots.json are applied on restart:
            // - If user increased activeOrders (e.g., 10→20), new virtual orders activate
            // - If user decreased activeOrders (e.g., 20→10), excess orders are cancelled
            const { reconcileStartupOrders } = require('./modules/order/startup_reconcile');
            await reconcileStartupOrders({
                manager: this.manager,
                config: this.config,
                account: this.account,
                privateKey: this.privateKey,
                chainOrders,
                chainOpenOrders,
                syncResult,
            });

            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
        }

        // Main loop
        const loopDelayMs = Number(process.env.RUN_LOOP_MS || 5000);
        console.log(`[bot.js] DEXBot started. Running loop every ${loopDelayMs}ms (dryRun=${!!this.config.dryRun})`);

        while (true) {
            try {
                if (this.manager && !this.isResyncing) {
                    await this.manager.fetchOrderUpdates();
                }
            } catch (err) {
                console.error('[bot.js] Order manager loop error:', err.message);
            }
            await new Promise(resolve => setTimeout(resolve, loopDelayMs));
        }
    }
}

// Main entry point
(async () => {
    try {
        // Load bot configuration
        const botConfig = loadBotConfig(botName);
        console.log(`[bot.js] Loaded configuration for bot: ${botName}`);
        console.log(`[bot.js] Market: ${botConfig.assetA}-${botConfig.assetB}, Account: ${botConfig.preferredAccount}`);

        // Load all bots from configuration to prevent pruning other active bots
        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        const allActiveBots = allBotsConfig
            .filter(b => b.active !== false)
            .map((b, idx) => normalizeBotEntry(b, idx));
        
        // Find the correct index for the current bot in the bots.json list
        const botIndex = allBotsConfig.findIndex(b => b.name === botName);
        if (botIndex === -1) {
            throw new Error(`Bot "${botName}" not found in ${PROFILES_BOTS_FILE}`);
        }
        
        // Normalize config for current bot with correct index
        const normalizedConfig = normalizeBotEntry(botConfig, botIndex);

        // Authenticate master password
        const masterPassword = await authenticateMasterPassword();

        // Create and start bot
        const bot = new DEXBot(normalizedConfig);
        await bot.start(masterPassword);

    } catch (err) {
        console.error('[bot.js] Failed to start bot:', err.message);
        process.exit(1);
    }
})();

/**
 * DEXBot - Core trading bot class
 * Shared implementation used by both bot.js (single bot) and dexbot.js (multi-bot orchestration)
 *
 * This class handles:
 * - Bot initialization and account setup
 * - Order placement and batch operations
 * - Fill processing and synchronization
 * - Grid rebalancing and rotation
 * - Divergence detection and correction
 */

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./bitshares_client');
const chainKeys = require('./chain_keys');
const chainOrders = require('./chain_orders');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./order');
const { persistGridSnapshot, retryPersistenceIfNeeded, buildCreateOrderArgs } = OrderUtils;
const { ORDER_STATES } = require('./constants');
const { attemptResumePersistedGridByPriceMatch, decideStartupGridAction, reconcileStartupOrders } = require('./order/startup_reconcile');
const { AccountOrders } = require('./account_orders');

const PROFILES_BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

class DEXBot {
    /**
     * Create a new DEXBot instance
     * @param {Object} config - Bot configuration from profiles/bots.json
     * @param {Object} options - Optional settings
     * @param {string} options.logPrefix - Prefix for console logs (e.g., "[bot.js]")
     */
    constructor(config, options = {}) {
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
        this._runningDivergenceCorrections = false;  // Prevent rotation during divergence check/update
        this.logPrefix = options.logPrefix || '';
    }

    _log(msg) {
        if (this.logPrefix) {
            console.log(`${this.logPrefix} ${msg}`);
        } else {
            console.log(msg);
        }
    }

    _warn(msg) {
        if (this.logPrefix) {
            console.warn(`${this.logPrefix} ${msg}`);
        } else {
            console.warn(msg);
        }
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
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                // dexbot.js has fallback to selectAccount, bot.js throws
                if (typeof chainOrders.selectAccount === 'function') {
                    accountData = await chainOrders.selectAccount();
                } else {
                    throw err;
                }
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
        this.account = accountData.accountName;
        this.accountId = accountData.id || null;
        this.privateKey = accountData.privateKey;
        this._log(`Initialized DEXBot for account: ${this.account}`);
    }

    async placeInitialOrders() {
        if (!this.manager) {
            this.manager = new OrderManager(this.config);
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
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
            this._warn(`Could not fetch account totals before initializing grid: ${errFetch && errFetch.message ? errFetch.message : errFetch}`);
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

        const createAndSyncOrder = async (order) => {
            this.manager.logger.log(`Placing ${order.type} order: size=${order.size}, price=${order.price}`, 'debug');
            const args = buildCreateOrderArgs(order, assetA, assetB);
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

        // Step 1: Build create operations
        if (ordersToPlace && ordersToPlace.length > 0) {
            for (const order of ordersToPlace) {
                try {
                    const args = buildCreateOrderArgs(order, assetA, assetB);
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
                    const { partialOrder, newPrice } = moveInfo;
                    if (!partialOrder.orderId) continue;

                    const op = await chainOrders.buildUpdateOrderOp(
                        this.account, partialOrder.orderId,
                        {
                            newPrice: newPrice,
                            orderType: partialOrder.type
                        }
                    );

                    if (op) {
                        operations.push(op);
                        opContexts.push({ kind: 'partial-move', moveInfo });
                        this.manager.logger.log(
                            `Prepared partial move op: ${partialOrder.orderId} price ${partialOrder.price.toFixed(4)} -> ${moveInfo.newPrice.toFixed(4)}`,
                            'debug'
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
                        // Round both to their respective asset precision
                        const baseAssetPrecision = this.manager.assets?.assetA?.precision || 8;
                        const quoteAssetPrecision = this.manager.assets?.assetB?.precision || 8;
                        const baseScaleFactor = Math.pow(10, baseAssetPrecision);
                        const quoteScaleFactor = Math.pow(10, quoteAssetPrecision);
                        const newAmountToSellBeforeRound = newAmountToSell;
                        const newMinToReceiveBeforeRound = newMinToReceive;
                        newAmountToSell = Math.round(newAmountToSell * baseScaleFactor) / baseScaleFactor;
                        newMinToReceive = newAmountToSell * newPrice;
                        newMinToReceive = Math.round(newMinToReceive * quoteScaleFactor) / quoteScaleFactor;
                        this.manager.logger.log(
                            `[Rotation SELL] oldOrder=${oldOrder.orderId}, newPrice=${newPrice.toFixed(4)}, ` +
                            `newSize=${newSize.toFixed(8)} (amount before rounding=${newAmountToSellBeforeRound.toFixed(8)}, after=${newAmountToSell.toFixed(8)}), ` +
                            `minReceive before=${newMinToReceiveBeforeRound.toFixed(8)}, after=${newMinToReceive.toFixed(8)} ` +
                            `(basePrec=${baseAssetPrecision}, quotePrec=${quoteAssetPrecision})`,
                            'debug'
                        );
                    } else {
                        newAmountToSell = newSize;
                        newMinToReceive = newSize / newPrice;
                        // Round both to their respective asset precision
                        const baseAssetPrecision = this.manager.assets?.assetA?.precision || 8;
                        const quoteAssetPrecision = this.manager.assets?.assetB?.precision || 8;
                        const baseScaleFactor = Math.pow(10, baseAssetPrecision);
                        const quoteScaleFactor = Math.pow(10, quoteAssetPrecision);
                        const newAmountToSellBeforeRound = newAmountToSell;
                        const newMinToReceiveBeforeRound = newMinToReceive;
                        newAmountToSell = Math.round(newAmountToSell * quoteScaleFactor) / quoteScaleFactor;
                        newMinToReceive = newAmountToSell / newPrice;
                        newMinToReceive = Math.round(newMinToReceive * baseScaleFactor) / baseScaleFactor;
                        this.manager.logger.log(
                            `[Rotation BUY] oldOrder=${oldOrder.orderId}, newPrice=${newPrice.toFixed(4)}, ` +
                            `newSize=${newSize.toFixed(8)} (amount before rounding=${newAmountToSellBeforeRound.toFixed(8)}, after=${newAmountToSell.toFixed(8)}), ` +
                            `minReceive before=${newMinToReceiveBeforeRound.toFixed(8)}, after=${newMinToReceive.toFixed(8)} ` +
                            `(basePrec=${baseAssetPrecision}, quotePrec=${quoteAssetPrecision})`,
                            'debug'
                        );
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
            return { executed: false, hadRotation: false };  // No batch executed
        }

        // Step 4: Execute Batch
        let hadRotation = false;
        let updateOperationCount = 0;  // Track update operations for fee accounting
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
                    updateOperationCount++;  // Count as update operation
                    continue;
                }

                if (ctx.kind === 'rotation') {
                    // Skip rotation if we're running divergence corrections (prevents feedback loops)
                    if (this._runningDivergenceCorrections) {
                        this.manager.logger.log(`Skipping rotation during divergence correction phase: ${ctx.rotation?.oldOrder?.orderId}`, 'debug');
                        continue;
                    }

                    hadRotation = true;
                    const { rotation } = ctx;
                    const { oldOrder, newPrice, newGridId, newSize } = rotation;

                    // ALWAYS update target grid slot with new rotation size (not just when usingOverride)
                    const actualSize = newSize;  // Use the rounded newAmountToSell/newMinToReceive
                    const slot = this.manager.orders.get(newGridId) || { id: newGridId, type: rotation.type, price: newPrice, size: 0, state: ORDER_STATES.VIRTUAL };
                    const updatedSlot = {
                        ...slot,
                        id: newGridId,
                        type: rotation.type,
                        size: actualSize,
                        price: newPrice,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: null
                    };
                    this.manager._updateOrder(updatedSlot);

                    // Detect if rotation was placed with partial proceeds (size < grid slot size)
                    const isPartialPlacement = slot.size > 0 && actualSize < slot.size;

                    this.manager.completeOrderRotation(oldOrder);
                    await this.manager.synchronizeWithChain({ gridOrderId: newGridId, chainOrderId: oldOrder.orderId, isPartialPlacement }, 'createOrder');
                    this.manager.logger.log(`Order size updated: ${oldOrder.orderId} new price ${newPrice.toFixed(4)}, new size ${actualSize.toFixed(8)}`, 'info');
                    updateOperationCount++;  // Count as update operation
                }
            }

            // Account for BTS update fees paid during batch operations
            // Only if BTS is in the trading pair
            if (updateOperationCount > 0 && (this.manager.config.assetA === 'BTS' || this.manager.config.assetB === 'BTS')) {
                try {
                    const { getAssetFees } = require('./order/utils');
                    const btsFeeData = getAssetFees('BTS', 1);
                    const totalUpdateFees = btsFeeData.updateFee * updateOperationCount;

                    this.manager.funds.btsFeesOwed += totalUpdateFees;
                    this.manager.logger.log(
                        `BTS update fees for batch: ${updateOperationCount} update operations × ${btsFeeData.updateFee.toFixed(8)} = +${totalUpdateFees.toFixed(8)} BTS (total owed: ${this.manager.funds.btsFeesOwed.toFixed(8)} BTS)`,
                        'info'
                    );

                    // Persist the updated fees owed
                    await this.manager._persistBtsFeesOwed();
                } catch (err) {
                    this.manager.logger.log(`Warning: Could not account for BTS update fees: ${err.message}`, 'warn');
                }
            }

        } catch (err) {
            this.manager.logger.log(`Batch transaction failed: ${err.message}`, 'error');
            return { executed: false, hadRotation: false };
        }
        return { executed: true, hadRotation };  // Return whether batch executed and if rotation happened
    }

    _schedulePendingFillsRetry(chainOrders) {
        if (!chainOrders || this._pendingFills.length === 0) return;

        const pendingCount = this._pendingFills.length;
        this.manager?.logger?.log(
            `Scheduling retry for ${pendingCount} pending fill(s) in 100ms`,
            'debug'
        );

        // Schedule on next event loop iteration (non-blocking)
        setImmediate(() => {
            if (this._pendingFills.length > 0) {
                // Small delay allows additional fills to accumulate before retry
                setTimeout(() => {
                    chainOrders.listenForFills(this.account, () => { });
                }, 100);
            }
        });
    }

    async start(masterPassword = null) {
        await this.initialize(masterPassword);

        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });

        // Ensure bot metadata is properly initialized in storage BEFORE any Grid operations
        const { parseJsonWithComments } = require('./account_bots');
        const { createBotKey } = require('./account_orders');

        const normalizeBotEntry = (entry, index = 0) => {
            const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
            return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
        };

        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        const allActiveBots = allBotsConfig
            .filter(b => b.active !== false)
            .map((b, idx) => normalizeBotEntry(b, idx));

        this._log(`DEBUG ensureBotEntries: passing ${allActiveBots.length} active bot(s):`);
        allActiveBots.forEach(bot => {
          this._log(`  - name=${bot.name}, assetA=${bot.assetA}, assetB=${bot.assetB}, active=${bot.active}, index=${bot.botIndex}, botKey=${bot.botKey}`);
        });

        this.accountOrders.ensureBotEntries(allActiveBots);

        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }

        // Fetch account totals from blockchain at startup to initialize funds
        try {
            if (this.accountId && this.config.assetA && this.config.assetB) {
                await this.manager._initializeAssets();
                await this.manager.fetchAccountTotals(this.accountId);
                this._log('Fetched blockchain account balances at startup');
            }
        } catch (err) {
            this._warn(`Failed to fetch account totals at startup: ${err.message}`);
        }

        // Ensure fee cache is initialized before any fill processing that calls getAssetFees().
        try {
            await OrderUtils.initializeFeeCache([this.config || {}], BitShares);
        } catch (err) {
            this._warn(`Fee cache initialization failed: ${err.message}`);
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

                        // Execute batch transaction (returns object with executed flag and hadRotation flag)
                        const batchResult = await this.updateOrdersOnChainBatch(rebalanceResult);

                        // Always persist snapshot after placing orders on-chain
                        persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                        // Only run divergence checks if rotation was completed
                        if (batchResult.hadRotation) {
                            try {
                                // Set flag to prevent rotation during divergence correction phase
                                this._runningDivergenceCorrections = true;

                                // After rotation, run grid comparisons to detect divergence and update _gridSidesUpdated
                                await OrderUtils.runGridComparisons(this.manager, this.accountOrders, this.config.botKey);

                                // Update grid with recalculated sizes BEFORE applying corrections
                                // (matches startup and 4-hour timer flows)
                                if (this.manager._gridSidesUpdated && this.manager._gridSidesUpdated.length > 0) {
                                    const orderType = Grid._getOrderTypeFromUpdatedFlags(
                                        this.manager._gridSidesUpdated.includes('buy'),
                                        this.manager._gridSidesUpdated.includes('sell')
                                    );
                                    await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, false);
                                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                                }

                                // Apply order corrections for sides marked by grid comparisons
                                await OrderUtils.applyGridDivergenceCorrections(
                                    this.manager,
                                    this.accountOrders,
                                    this.config.botKey,
                                    this.updateOrdersOnChainBatch.bind(this)
                                );
                            } finally {
                                // Always clear flag when done, even if divergence corrections fail
                                this._runningDivergenceCorrections = false;
                            }
                        } else {
                            this.manager.logger.log(`No rotation occurred - skipping divergence checks`, 'debug');
                        }
                    }

                    // Attempt to retry any previously failed persistence operations
                    retryPersistenceIfNeeded(this.manager);
                } catch (err) {
                    this.manager?.logger?.log(`Error processing fill: ${err.message}`, 'error');
                } finally {
                    this._processingFill = false;
                    // Safely schedule retry for any fills that arrived during processing
                    this._schedulePendingFillsRetry(chainOrders);
                }
            }
        });

        const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey);
        const persistedCacheFunds = this.accountOrders.loadCacheFunds(this.config.botKey);
        const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed(this.config.botKey);

        // Restore and consolidate cacheFunds
        this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
        if (persistedCacheFunds) {
            this.manager.funds.cacheFunds.buy += Number(persistedCacheFunds.buy || 0);
            this.manager.funds.cacheFunds.sell += Number(persistedCacheFunds.sell || 0);
        }

        // Use this.accountId which was set during initialize()
        const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

        const debugStartup = process.env.DEBUG_STARTUP === '1';
        if (debugStartup) {
            this._log(`DEBUG STARTUP: chainOpenOrders.length = ${chainOpenOrders.length}`);
            this._log(`DEBUG STARTUP: persistedGrid.length = ${persistedGrid ? persistedGrid.length : 0}`);
        }

        let shouldRegenerate = false;
        if (!persistedGrid || persistedGrid.length === 0) {
            shouldRegenerate = true;
            this._log('No persisted grid found. Generating new grid.');
        } else {
            await this.manager._initializeAssets();
            const decision = await decideStartupGridAction({
                persistedGrid,
                chainOpenOrders,
                manager: this.manager,
                logger: { log: (msg) => this._log(msg) },
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
                this._log(`DEBUG STARTUP: hasActiveMatch = ${decision.hasActiveMatch}`);
            }

            if (shouldRegenerate && chainOpenOrders.length === 0) {
                this._log('Persisted grid found, but no matching active orders on-chain. Generating new grid.');
            }
        }

        // Restore BTS fees owed ONLY if we're NOT regenerating the grid
        if (!shouldRegenerate) {
            // CRITICAL: Restore BTS fees owed from blockchain operations
            if (persistedBtsFeesOwed > 0) {
                this.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
                this._log(`✓ Restored BTS fees owed: ${persistedBtsFeesOwed.toFixed(8)} BTS`);
            }
        } else {
            this._log(`ℹ Grid regenerating - resetting cacheFunds and BTS fees to clean state`);
            this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
            this.manager.funds.btsFeesOwed = 0;
        }

        if (shouldRegenerate) {
            await this.manager._initializeAssets();
            this._log('Generating new grid.');
            await Grid.initializeGrid(this.manager);

            // If there are existing on-chain orders, reconcile them with the new grid
            if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                this._log(`Found ${chainOpenOrders.length} existing chain orders. Syncing them onto the new grid.`);
                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
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
                this._log('No existing chain orders found. Placing initial orders.');
                await this.placeInitialOrders();
            }
            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
        } else {
            this._log('Found active session. Loading and syncing existing grid.');
            await Grid.loadGrid(this.manager, persistedGrid);
            const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

            // Reconcile existing on-chain orders to the configured target counts.
            // This ensures activeOrders changes in bots.json are applied on restart:
            // - If user increased activeOrders (e.g., 10→20), new virtual orders activate
            // - If user decreased activeOrders (e.g., 20→10), excess orders are cancelled
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

        // Check if newly fetched blockchain funds or divergence trigger a grid update at startup
        // Note: Grid checks only run if no fills are being processed
        // Since fill listener was just set up, fills should not be processing yet at startup

        // Step 1: Threshold check (available funds)
        try {
            // Only run grid checks if no fills are being processed
            if (this.manager && this.manager.orders && this.manager.orders.size > 0) {
                const gridCheckResult = Grid.checkAndUpdateGridIfNeeded(this.manager, this.manager.funds.cacheFunds);
                if (gridCheckResult.buyUpdated || gridCheckResult.sellUpdated) {
                    this._log(`Grid updated at startup due to available funds (buy: ${gridCheckResult.buyUpdated}, sell: ${gridCheckResult.sellUpdated})`);
                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                    // Apply grid corrections on-chain immediately to use new funds
                    try {
                        await OrderUtils.applyGridDivergenceCorrections(
                            this.manager,
                            this.accountOrders,
                            this.config.botKey,
                            this.updateOrdersOnChainBatch.bind(this)
                        );
                        this._log(`Grid corrections applied on-chain at startup`);
                    } catch (err) {
                        this._warn(`Error applying grid corrections at startup: ${err.message}`);
                    }
                }

                // Step 2: Divergence check (only if threshold didn't trigger)
                // Detects structural mismatch between calculated and persisted grid
                if (!gridCheckResult.buyUpdated && !gridCheckResult.sellUpdated) {
                    try {
                        const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey) || [];
                        const calculatedGrid = Array.from(this.manager.orders.values());
                        const comparisonResult = Grid.compareGrids(calculatedGrid, persistedGrid, this.manager, this.manager.funds.cacheFunds);

                        if (comparisonResult.buy.updated || comparisonResult.sell.updated) {
                            this._log(`Grid divergence detected at startup: buy=${comparisonResult.buy.metric.toFixed(6)}, sell=${comparisonResult.sell.metric.toFixed(6)}`);

                            // Update grid with blockchain snapshot already fresh from initialization
                            // fromBlockchainTimer=true because blockchain was just fetched at startup (line 499)
                            const orderType = Grid._getOrderTypeFromUpdatedFlags(comparisonResult.buy.updated, comparisonResult.sell.updated);
                            await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);

                            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                            // Apply grid corrections on-chain immediately
                            try {
                                await OrderUtils.applyGridDivergenceCorrections(
                                    this.manager,
                                    this.accountOrders,
                                    this.config.botKey,
                                    this.updateOrdersOnChainBatch.bind(this)
                                );
                                this._log(`Grid divergence corrections applied on-chain at startup`);
                            } catch (err) {
                                this._warn(`Error applying divergence corrections at startup: ${err.message}`);
                            }
                        }
                    } catch (err) {
                        this._warn(`Error running divergence check at startup: ${err.message}`);
                    }
                }
            }
        } catch (err) {
            this._warn(`Error checking grid at startup: ${err.message}`);
        }

        /**
         * Perform a full grid resync: cancel orphan orders and regenerate grid.
         * Triggered by the presence of a `recalculate.<botKey>.trigger` file.
         */
        const performResync = async () => {
            if (this.isResyncing) {
                this._log('Resync already in progress, skipping trigger.');
                return;
            }
            this.isResyncing = true;
            try {
                this._log('Grid regeneration triggered. Performing full grid resync...');
                const readFn = () => chainOrders.readOpenOrders(this.accountId);
                await Grid.recalculateGrid(this.manager, {
                    readOpenOrdersFn: readFn,
                    chainOrders,
                    account: this.account,
                    privateKey: this.privateKey,
                    config: this.config,
                });
                // Reset cacheFunds when grid is regenerated
                this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
                this.manager.funds.btsFeesOwed = 0;
                persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                if (fs.existsSync(this.triggerFile)) {
                    fs.unlinkSync(this.triggerFile);
                    this._log('Removed trigger file.');
                }
            } catch (err) {
                this._log(`Error during triggered resync: ${err.message}`);
            } finally {
                this.isResyncing = false;
            }
        };

        if (fs.existsSync(this.triggerFile)) {
            await performResync();
        }

        // Debounced watcher to avoid duplicate rapid triggers on some platforms
        let _triggerDebounce = null;
        try {
            fs.watch(PROFILES_DIR, (eventType, filename) => {
                try {
                    if (filename === path.basename(this.triggerFile)) {
                        if ((eventType === 'rename' || eventType === 'change') && fs.existsSync(this.triggerFile)) {
                            if (_triggerDebounce) clearTimeout(_triggerDebounce);
                            _triggerDebounce = setTimeout(() => {
                                _triggerDebounce = null;
                                performResync();
                            }, 200);
                        }
                    }
                } catch (err) {
                    this._warn(`fs.watch handler error: ${err && err.message ? err.message : err}`);
                }
            });
        } catch (err) {
            this._warn(`Failed to setup file watcher: ${err.message}`);
        }

        // Start periodic blockchain fetch to keep blockchain variables updated
        this._setupBlockchainFetchInterval();

        // Main loop
        const loopDelayMs = Number(process.env.RUN_LOOP_MS || 5000);
        this._log(`DEXBot started. Running loop every ${loopDelayMs}ms (dryRun=${!!this.config.dryRun})`);

        (async () => {
            while (true) {
                try {
                    if (this.manager && !this.isResyncing) {
                        await this.manager.fetchOrderUpdates();
                    }
                } catch (err) { console.error('Order manager loop error:', err.message); }
                await new Promise(resolve => setTimeout(resolve, loopDelayMs));
            }
        })();

        console.log('DEXBot started. OrderManager running (dryRun=' + !!this.config.dryRun + ')');
    }

    /**
     * Set up periodic blockchain account balance fetch interval.
     * Fetches available funds at regular intervals to keep blockchain variables up-to-date.
     * @private
     */
    _setupBlockchainFetchInterval() {
        const { TIMING } = require('./constants');
        const intervalMin = TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN;

        // Validate the interval setting
        if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
            this._log(`Blockchain fetch interval disabled (value: ${intervalMin}). Periodic blockchain updates will not run.`);
            return;
        }

        // Validate manager and account ID
        if (!this.manager || typeof this.manager.fetchAccountTotals !== 'function') {
            this._warn('Cannot start blockchain fetch interval: manager or fetchAccountTotals method missing');
            return;
        }

        if (!this.accountId) {
            this._warn('Cannot start blockchain fetch interval: account ID not available');
            return;
        }

        // Convert minutes to milliseconds
        const intervalMs = intervalMin * 60 * 1000;

        // Set up the periodic fetch
        this._blockchainFetchInterval = setInterval(async () => {
            try {
                this._log(`Fetching blockchain account values (interval: every ${intervalMin}min)`);
                await this.manager.fetchAccountTotals(this.accountId);

                // Check if newly fetched blockchain funds trigger a grid update
                // Only update grid if no fills are being processed (prevent concurrent modifications)
                if (!this._processingFill && !this._runningDivergenceCorrections &&
                    this.manager && this.manager.orders && this.manager.orders.size > 0) {
                    const gridCheckResult = Grid.checkAndUpdateGridIfNeeded(this.manager, this.manager.funds.cacheFunds);
                    if (gridCheckResult.buyUpdated || gridCheckResult.sellUpdated) {
                        this._log(`Cache ratio threshold triggered grid update (buy: ${gridCheckResult.buyUpdated}, sell: ${gridCheckResult.sellUpdated})`);

                        // Update grid with fresh blockchain snapshot from 4-hour timer
                        const orderType = Grid._getOrderTypeFromUpdatedFlags(gridCheckResult.buyUpdated, gridCheckResult.sellUpdated);
                        await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);

                        persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                        // Apply grid corrections on-chain to use new funds
                        try {
                            await OrderUtils.applyGridDivergenceCorrections(
                                this.manager,
                                this.accountOrders,
                                this.config.botKey,
                                this.updateOrdersOnChainBatch.bind(this)
                            );
                            this._log(`Grid corrections applied on-chain from periodic blockchain fetch`);
                        } catch (err) {
                            this._warn(`Error applying grid corrections during periodic fetch: ${err.message}`);
                        }
                    }
                }
            } catch (err) {
                this._warn(`Error during periodic blockchain fetch: ${err && err.message ? err.message : err}`);
            }
        }, intervalMs);

        this._log(`Started periodic blockchain fetch interval: every ${intervalMin} minute(s)`);
    }

    /**
     * Stop the periodic blockchain fetch interval.
     * @private
     */
    _stopBlockchainFetchInterval() {
        if (this._blockchainFetchInterval !== null && this._blockchainFetchInterval !== undefined) {
            clearInterval(this._blockchainFetchInterval);
            this._blockchainFetchInterval = null;
            this._log('Stopped periodic blockchain fetch interval');
        }
    }
}

module.exports = DEXBot;

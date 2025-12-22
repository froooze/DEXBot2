#!/usr/bin/env node
/**
 * DEXBot2 - Primary CLI driver for automated BitShares DEX market making
 * 
 * This is the main entry point that manages tracked bots and provides helper
 * utilities such as key/bot editors. The bot creates grid-based limit orders
 * across a price range and automatically replaces filled orders.
 * 
 * Main features:
 * - Grid-based order placement with configurable spread and increment
 * - Automatic order replacement when fills occur
 * - Master password encryption for private keys
 * - Dry-run mode for testing without broadcasting transactions
 * - CLI commands: start, drystart, reset, stop, keys, bots
 */
const { BitShares, waitForConnected, setSuppressConnectionLog } = require('./modules/bitshares_client');
const fs = require('fs');
const path = require('path');
const readline = require('readline-sync');
const chainOrders = require('./modules/chain_orders');
const chainKeys = require('./modules/chain_keys');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./modules/order');
const { persistGridSnapshot, retryPersistenceIfNeeded } = OrderUtils;
const { ORDER_STATES } = require('./modules/constants');
const { reconcileStartupOrders, attemptResumePersistedGridByPriceMatch, decideStartupGridAction } = require('./modules/order/startup_reconcile');
const accountKeys = require('./modules/chain_keys');
const accountBots = require('./modules/account_bots');
const { parseJsonWithComments } = accountBots;
const { AccountOrders, createBotKey } = require('./modules/account_orders');

// Note: accountOrders is now per-bot only. Each bot has its own AccountOrders instance
// created in DEXBot.start() (line 663). This eliminates shared-file race conditions.

// Primary CLI driver that manages tracked bots and helper utilities such as key/bot editors.
const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

// Initialize profiles directory if it doesn't exist
function ensureProfilesDirectory() {
    if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
        console.log('✓ Created profiles directory');
        return true;
    }
    return false;
}


const CLI_COMMANDS = ['start', 'reset', 'stop', 'drystart', 'keys', 'bots', 'pm2'];
const CLI_HELP_FLAGS = ['-h', '--help'];
const CLI_EXAMPLES_FLAG = '--cli-examples';
const CLI_EXAMPLES = [
    { title: 'Start a bot from the tracked config', command: 'dexbot start bot-name', notes: 'Targets the named entry in profiles/bots.json.' },
    { title: 'Dry-run a bot without broadcasting', command: 'dexbot drystart bot-name', notes: 'Forces the run into dry-run mode even if the stored config was live.' },
    { title: 'Manage keys', command: 'dexbot keys', notes: 'Runs modules/chain_keys.js to add or update master passwords.' },
    { title: 'Edit bot definitions', command: 'dexbot bots', notes: 'Launches the interactive modules/account_bots.js helper for the JSON config.' },
    { title: 'Start bots with PM2', command: 'dexbot pm2', notes: 'Generates ecosystem config, authenticates, and starts PM2.' },
    { title: 'Reset a bot grid', command: 'dexbot reset bot-name', notes: 'Triggers a full grid regeneration for the named bot.' }
];
const cliArgs = process.argv.slice(2);

// Show the CLI usage/help text when requested or upon invalid commands.
function printCLIUsage() {
    console.log('Usage: dexbot [command] [bot-name]');
    console.log('Commands:');
    console.log('  start <bot>       Start the named bot using the tracked config.');
    console.log('  drystart <bot>    Same as start but forces dry-run execution.');
    console.log('  reset <bot>       Trigger a grid reset (auto-reloads if running, or applies on next start).');
    console.log('  stop <bot>        Mark the bot inactive in config (stop running instance separately).');
    console.log('  keys              Launch the chain key helper (modules/chain_keys.js).');
    console.log('  bots              Launch the interactive bot configurator (modules/account_bots.js).');
    console.log('  pm2               Start all active bots with PM2 (authenticate + generate config + start).');
    console.log('Options:');
    console.log('  --cli-examples    Print curated CLI snippets.');
    console.log('  -h, --help        Show this help text.');
    console.log('Envs: RUN_LOOP_MS controls the polling delay; LIVE_BOT_NAME or BOT_NAME selects a single entry.');
}

// Print curated CLI snippets for quick reference.
function printCLIExamples() {
    console.log('CLI Examples:');
    CLI_EXAMPLES.forEach((example, index) => {
        console.log(`${index + 1}. ${example.title}`);
        console.log(`   ${example.command}`);
        if (example.notes) console.log(`   ${example.notes}`);
    });
    console.log(`Read the README “CLI usage” section for more details (file: ${PROFILES_BOTS_FILE}).`);
}

if (cliArgs.some(arg => CLI_HELP_FLAGS.includes(arg))) {
    printCLIUsage();
    process.exit(0);
}

if (cliArgs.includes(CLI_EXAMPLES_FLAG)) {
    printCLIExamples();
    process.exit(0);
}

// `parseJsonWithComments` is provided by `modules/account_bots.js` (shared single-source)

// Load the tracked bot settings file, handling missing files or parse failures gracefully.
function loadSettingsFile({ silent = false } = {}) {
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        if (!silent) {
            console.error('profiles/bots.json not found. Run `npm run bootstrap:profiles` to create it from the tracked examples.');
        }
        return { config: {}, filePath: PROFILES_BOTS_FILE };
    }
    try {
        const content = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
        if (!content || !content.trim()) return { config: {}, filePath: PROFILES_BOTS_FILE };
        return { config: parseJsonWithComments(content), filePath: PROFILES_BOTS_FILE };
    } catch (err) {
        console.warn('Failed to load bot settings from', PROFILES_BOTS_FILE, '-', err.message);
        return { config: {}, filePath: PROFILES_BOTS_FILE };
    }
}

// Persist the tracked bot settings to disk when users edit via CLI.
function saveSettingsFile(config, filePath) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Failed to save bot settings to', filePath, '-', err.message);
        throw err;
    }
}

// Normalize the root data structure so we always operate on an array of bot entries.
function resolveRawBotEntries(settings) {
    if (!settings || typeof settings !== 'object') return [];
    if (Array.isArray(settings.bots)) return settings.bots;
    if (Object.keys(settings).length > 0) return [settings];
    return [];
}

// Decorate each bot entry with metadata (botKey, index, default active) for runtime use.
function normalizeBotEntries(rawEntries) {
    return rawEntries.map((entry, index) => {
        const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
        return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
    });
}

// Connection handled centrally by modules/bitshares_client; use waitForConnected() when needed

/**
 * DEXBot - Core trading bot class that manages grid-based market making
 * 
 * Responsibilities:
 * - Initializes connection to BitShares and authenticates account
 * - Creates and manages an OrderManager instance for grid operations
 * - Places initial orders and listens for fills to replace them
 * - Handles grid synchronization with on-chain state
 * - Supports dry-run mode for testing without broadcasting
 * 
 * @class
 */
class DEXBot {
    /**
     * Create a new DEXBot instance
     * @param {Object} config - Bot configuration from profiles/bots.json
     * @param {string} config.assetA - Base asset symbol (e.g., 'IOB.XRP')
     * @param {string} config.assetB - Quote asset symbol (e.g., 'BTS')
     * @param {string|number} config.marketPrice - Target price or 'pool'/'market' for auto-derive
     * @param {boolean} config.dryRun - If true, skip broadcasting transactions
     * @param {string} config.preferredAccount - BitShares account name to use
     */
    constructor(config) {
        this.config = config;
        this.account = null;
        this.privateKey = null;
        this.manager = null;
        this.accountOrders = null;  // Will be initialized in start()
        this.isResyncing = false;
        this.triggerFile = path.join(PROFILES_DIR, `recalculate.${config.botKey}.trigger`);
        // Track recently processed fills to avoid duplicate processing
        this._recentlyProcessedFills = new Map(); // orderId -> timestamp
        this._fillDedupeWindowMs = 5000; // 5 second window to prevent duplicate processing
        this._processingFill = false; // Lock to prevent concurrent fill processing
        this._pendingFills = []; // Queue for fills that arrive while processing
        this._runningDivergenceCorrections = false;  // Prevent rotation during divergence check/update
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
                console.warn('Auto-selection of preferredAccount failed:', err.message);
                accountData = await chainOrders.selectAccount();
            }
        } else {
            accountData = await chainOrders.selectAccount();
        }
        this.account = accountData.accountName;
        this.accountId = accountData.id || null;
        this.privateKey = accountData.privateKey;
        console.log(`Initialized DEXBot for account: ${this.account}`);
    }

    /**
     * Place the initial grid orders on-chain after computing the order grid.
     * This method:
     * 1. Initializes the OrderManager if not already done
     * 2. Fetches account balances for percentage-based botFunds
     * 3. Generates the virtual order grid
     * 4. Places orders on-chain in an interleaved pattern (sell, buy, sell, buy...)
     * 5. Persists the grid snapshot to profiles/orders/{botKey}.json
     */
    async placeInitialOrders() {
        if (!this.manager) {
            this.manager = new OrderManager(this.config);
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }
        // If botFunds are percentage-based and account info is available, try to
        // fetch on-chain balances first so percentages resolve correctly.
        try {
            const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await this.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch) {
            console.warn('Could not fetch account totals before initializing grid:', errFetch && errFetch.message ? errFetch.message : errFetch);
        }

        await Grid.initializeGrid(this.manager);

        if (this.config.dryRun) {
            this.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            // Legacy `pendingProceeds` reset removed; persisted proceeds are migrated to `cacheFunds`.
            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
            return;
        }

        this.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = this.manager.getInitialOrdersToActivate();

        // Separate sell and buy orders, then interleave them (sell, buy, sell, buy, ...)
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

    /**
     * Place new replacement orders on-chain after fills.
     * Called by the fill listener when orders are fully filled.
     * Creates new orders on the opposite side of the spread.
     * @param {Array} orders - Array of order objects to place
     */
    async placeNewOrders(orders) {
        if (!orders || orders.length === 0) return;
        if (this.config.dryRun) {
            this.manager.logger.log(`Dry run: would place ${orders.length} new orders on-chain`, 'info');
            return;
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

        for (const order of orders) {
            try {
                this.manager.logger.log(`Placing ${order.type} order on-chain: size=${order.size.toFixed(8)}, price=${order.price.toFixed(4)}`, 'info');
                const args = buildCreateOrderArgs(order);
                const result = await chainOrders.createOrder(
                    this.account, this.privateKey, args.amountToSell, args.sellAssetId,
                    args.minToReceive, args.receiveAssetId, null, false
                );
                const chainOrderId = result && result[0] && result[0].trx && result[0].trx.operation_results && result[0].trx.operation_results[0] && result[0].trx.operation_results[0][1];
                if (chainOrderId) {
                    await this.manager.synchronizeWithChain({ gridOrderId: order.id, chainOrderId }, 'createOrder');
                } else {
                    this.manager.logger.log(`Order ${order.id} placement response missing order_id`, 'warn');
                }
            } catch (err) {
                this.manager.logger.log(`Failed to place ${order.type} order ${order.id}: ${err.message}`, 'error');
            }
        }
    }

    /**
     * Update orders on-chain using the "rotate furthest" strategy.
     * 
     * 1. Place new orders for activated virtual orders (ordersToPlace)
     * 2. For each rotation: UPDATE the existing order to new price/size (using limit_order_update)
     * 
     * @param {Object} rebalanceResult - { ordersToPlace: [], ordersToRotate: [] }
     */
    /**
     * Update orders on-chain using batched transactions.
     * 
     * 1. Collect create operations for ordersToPlace
     * 2. Collect update operations for ordersToRotate
     * 3. Execute all in one batch transaction
     * 4. Process results to update grid state
     * 
     * @param {Object} rebalanceResult - { ordersToPlace: [], ordersToRotate: [] }
     */
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
                    const { partialOrder, newPrice } = moveInfo;
                    if (!partialOrder.orderId) continue;

                    // Pass newPrice instead of pre-calculated minToReceive so buildUpdateOrderOp can recalculate
                    // minToReceive based on the ACTUAL current on-chain amount (not stale grid amount)
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
                        // Round both to their respective asset precision
                        const baseAssetPrecision = this.manager.assets?.assetA?.precision || 8;
                        const quoteAssetPrecision = this.manager.assets?.assetB?.precision || 8;
                        const baseScaleFactor = Math.pow(10, baseAssetPrecision);
                        const quoteScaleFactor = Math.pow(10, quoteAssetPrecision);
                        const newAmountToSellBeforeRound = newAmountToSell;
                        const newMinToReceiveBeforeRound = newMinToReceive;
                        newAmountToSell = Math.round(newAmountToSell * baseScaleFactor) / baseScaleFactor;
                        // CRITICAL: After rounding amount, recalculate minToReceive based on ROUNDED amount
                        // to ensure price consistency: rounded_amount * newPrice
                        newMinToReceive = newAmountToSell * newPrice;
                        newMinToReceive = Math.round(newMinToReceive * quoteScaleFactor) / quoteScaleFactor;
                        this.manager.logger.log(
                            `[Rotation SELL] oldOrder=${oldOrder.orderId}, newPrice=${newPrice.toFixed(4)}, ` +
                            `newSize=${newSize.toFixed(8)} (amount before rounding=${newAmountToSellBeforeRound.toFixed(8)}, after=${newAmountToSell.toFixed(8)}), ` +
                            `minReceive before=${newMinToReceiveBeforeRound.toFixed(8)}, after=${newMinToReceive.toFixed(8)} ` +
                            `(basePrec=${baseAssetPrecision}, quotePrec=${quoteAssetPrecision})`,
                            'info'
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
                        // CRITICAL: After rounding amount, recalculate minToReceive based on ROUNDED amount
                        // to ensure price consistency: rounded_amount / newPrice
                        newMinToReceive = newAmountToSell / newPrice;
                        newMinToReceive = Math.round(newMinToReceive * baseScaleFactor) / baseScaleFactor;
                        this.manager.logger.log(
                            `[Rotation BUY] oldOrder=${oldOrder.orderId}, newPrice=${newPrice.toFixed(4)}, ` +
                            `newSize=${newSize.toFixed(8)} (amount before rounding=${newAmountToSellBeforeRound.toFixed(8)}, after=${newAmountToSell.toFixed(8)}), ` +
                            `minReceive before=${newMinToReceiveBeforeRound.toFixed(8)}, after=${newMinToReceive.toFixed(8)} ` +
                            `(basePrec=${baseAssetPrecision}, quotePrec=${quoteAssetPrecision})`,
                            'info'
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
                    // Skip rotation if we're running divergence corrections (prevents feedback loops)
                    if (this._runningDivergenceCorrections) {
                        this.manager.logger.log(`Skipping rotation during divergence correction phase: ${ctx.rotation?.oldOrder?.orderId}`, 'debug');
                        continue;
                    }

                    hadRotation = true;
                    const { rotation } = ctx;
                    const { oldOrder, newPrice, newGridId, newSize } = rotation;

                    // ALWAYS update target grid slot with new rotation size (not just when usingOverride)
                    // This ensures the grid order size matches what was actually placed on-chain
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

                    // Detect if rotation was placed with partial proceeds (size < grid slot size)
                    // This order should be marked PARTIAL, not ACTIVE, so it's filtered from divergence calculations
                    const isPartialPlacement = slot.size > 0 && rotation.newSize < slot.size;

                    this.manager.completeOrderRotation(oldOrder);
                    await this.manager.synchronizeWithChain({ gridOrderId: newGridId, chainOrderId: oldOrder.orderId, isPartialPlacement }, 'createOrder');
                    this.manager.logger.log(`Order size updated: ${oldOrder.orderId} new price ${newPrice.toFixed(4)}, new size ${newSize.toFixed(8)}`, 'info');
                }
            }

        } catch (err) {
            this.manager.logger.log(`Batch transaction failed: ${err.message}`, 'error');
            // If batch fails, should we try to revert or just let the next sync fix it?
            // The next sync/loop will see discrepancies and fix them, though funds might be momentarily desync.
            return { executed: false, hadRotation: false };
        }
        return { executed: true, hadRotation };  // Return whether batch executed and if rotation happened
    }

    /**
     * Safely drain pending fills queue on next event loop iteration.
     *
     * This method schedules a retry of fill processing when there are queued fills.
     * Using setImmediate() ensures we don't block and prevents race conditions.
     *
     * Key design principles:
     * - Called only from finally block (cleanup phase)
     * - Uses setImmediate() to defer to next iteration (not blocking)
     * - Prevents infinite loops with iteration limits in listenForFills
     * - Allows new fills to arrive during the delay
     *
     * Why this is safe:
     * - _processingFill flag is already false when called
     * - New fills can queue while we schedule the retry
     * - Timeout (100ms) gives time for batch accumulation
     * - No re-entrancy into finally block
     */
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

    /**
     * Start the bot's main operation loop.
     * This method:
     * 1. Initializes the account connection and OrderManager
     * 2. Sets up fill listeners for automatic order replacement
     * 3. Loads or generates the order grid based on persisted state
     * 4. Watches for trigger files to force grid regeneration
     * 5. Runs a continuous update loop for order monitoring
     *
     * @param {string|null} masterPassword - Pre-authenticated master password (optional)
     */
    async start(masterPassword = null) {
        await this.initialize(masterPassword);

        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });

        // Ensure bot metadata is properly initialized in storage BEFORE any Grid operations
        // This prevents new order files from being created with null values for assetA, assetB, name
        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        // Normalize all bots first (to get correct indices), then filter to active ones
        const allActiveBots = normalizeBotEntries(allBotsConfig)
            .filter(b => b.active !== false);

        console.log(`[dexbot.js] DEBUG ensureBotEntries: passing ${allActiveBots.length} active bot(s):`);
        allActiveBots.forEach(bot => {
          console.log(`  - name=${bot.name}, assetA=${bot.assetA}, assetB=${bot.assetB}, active=${bot.active}, index=${bot.botIndex}, botKey=${bot.botKey}`);
        });

        this.accountOrders.ensureBotEntries(allActiveBots);

        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            // Attach account identifiers so OrderManager can fetch on-chain totals when needed
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }

        // Start listening for fills BEFORE any order operations to avoid missing fills
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
                        // Open orders mode: fetch once, then sync each fill against it?
                        // Or fetch once, sync once?
                        // syncFromOpenOrders updates the grid based on missing orders.
                        // If we have multiple fills, they are all missing orders.
                        // Calling syncFromOpenOrders ONCE will detect all missing orders.
                        // But we need to pass a fillOp for logging?
                        // Let's call it for each fillOp but pass the SAME chainOpenOrders snapshot to be efficient.
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
                    const persistenceOk = retryPersistenceIfNeeded(this.manager);
                    if (persistenceOk) {
                        this.manager.logger.log(`Persistence recovery check passed`, 'debug');
                    }
                } catch (err) {
                    this.manager?.logger?.log(`Error processing fill: ${err.message}`, 'error');
                } finally {
                    this._processingFill = false;
                    // Safely schedule retry for any fills that arrived during processing
                    this._schedulePendingFillsRetry(chainOrders);
                }
            }
        });

        /**
         * Perform a full grid resync: cancel orphan orders and regenerate grid.
         * Triggered by the presence of a `recalculate.<botKey>.trigger` file.
         */
        const performResync = async () => {
            if (this.isResyncing) {
                this.manager.logger.log('Resync already in progress, skipping trigger.', 'warn');
                return;
            }
            this.isResyncing = true;
            try {
                this.manager.logger.log('Grid regeneration triggered. Performing full grid resync...', 'info');
                const readFn = () => chainOrders.readOpenOrders(this.accountId);
                await Grid.recalculateGrid(this.manager, {
                    readOpenOrdersFn: readFn,
                    chainOrders,
                    account: this.account,
                    privateKey: this.privateKey,
                    config: this.config,
                });
                // Grid regenerated; legacy pending proceeds removed from schema.
                persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                if (fs.existsSync(this.triggerFile)) {
                    fs.unlinkSync(this.triggerFile);
                    this.manager.logger.log('Removed trigger file.', 'debug');
                }
            } catch (err) {
                this.manager.logger.log(`Error during triggered resync: ${err.message}`, 'error');
            } finally {
                this.isResyncing = false;
            }
        };

        if (fs.existsSync(this.triggerFile)) {
            await performResync();
        } else {
            const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey);
            const persistedCacheFunds = this.accountOrders.loadCacheFunds(this.config.botKey);
            const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed(this.config.botKey);

            // Restore cacheFunds to manager if found
            if (persistedCacheFunds) {
                this.manager.funds.cacheFunds = { ...persistedCacheFunds };
            }

            // Legacy `pendingProceeds` handling removed; migrate using the provided script if needed.

            // CRITICAL: Restore BTS fees owed from blockchain operations
            // This ensures fees are properly deducted from proceeds, preventing fund loss on restart
            if (persistedBtsFeesOwed > 0) {
                this.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
                this.manager.logger.log(`✓ Restored BTS fees owed: ${persistedBtsFeesOwed.toFixed(8)} BTS`, 'info');
            }
            
            const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

            let shouldRegenerate = false;
            if (!persistedGrid || persistedGrid.length === 0) {
                shouldRegenerate = true;
                this.manager.logger.log('No persisted grid found. Generating new grid.', 'info');
            } else {
                await this.manager._initializeAssets();
                const decision = await decideStartupGridAction({
                    persistedGrid,
                    chainOpenOrders,
                    manager: this.manager,
                    logger: this.manager.logger,
                    storeGrid: (orders) => {
                        // Temporarily replace orders for persistence
                        const originalOrders = this.manager.orders;
                        this.manager.orders = new Map(orders.map(o => [o.id, o]));
                        const result = persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                        this.manager.orders = originalOrders;
                        return result;
                    },
                    attemptResumeFn: attemptResumePersistedGridByPriceMatch,
                });
                shouldRegenerate = decision.shouldRegenerate;

                if (shouldRegenerate && chainOpenOrders.length === 0) {
                    this.manager.logger.log('Persisted grid found, but no matching active orders on-chain. Generating new grid.', 'info');
                }
            }

            if (shouldRegenerate) {
                // Initialize assets first
                await this.manager._initializeAssets();

                // Always generate a full virtual grid so orders.json contains the complete grid
                // (virtual + spread placeholders), not only currently active on-chain orders.
                this.manager.logger.log('Generating new grid.', 'info');
                await Grid.initializeGrid(this.manager);

                // Legacy `pendingProceeds` reset removed; persisted proceeds are migrated to `cacheFunds`.

                // If there are existing on-chain orders, sync them onto the new grid
                // using price+size matching, then reconcile counts by updating/cancelling/creating.
                if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                    this.manager.logger.log(`Found ${chainOpenOrders.length} existing chain orders. Syncing them onto the new grid (price+size matching).`, 'info');
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
                    this.manager.logger.log('No existing chain orders found. Placing initial orders.', 'info');
                    await this.placeInitialOrders();
                }

                persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
            } else {
                this.manager.logger.log('Found active session. Loading and syncing existing grid.', 'info');

                // If using percentage-based funds, ensure we have valid account totals before proceeding
                const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
                const needsPercent = (v) => typeof v === 'string' && v.includes('%');
                if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                    this.manager.logger.log('Percentage-based funds detected on restart. Verifying account totals...', 'info');
                    let retries = 0;
                    let validTotals = false;

                    while (retries < 10) {
                        try {
                            if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                                await this.manager._fetchAccountBalancesAndSetTotals();
                            }
                            const { buy, sell } = this.manager.accountTotals || {};
                            // We consider it valid if we successfully fetched numbers (even 0 is a valid balance)
                            // null indicates fetch failed or hasn't run
                            if (buy !== null && buy !== undefined && sell !== null && sell !== undefined) {
                                validTotals = true;
                                break;
                            }
                        } catch (err) {
                            this.manager.logger.log(`Error fetching totals: ${err.message}`, 'warn');
                        }

                        this.manager.logger.log(`Waiting for account totals (attempt ${retries + 1}/10)...`, 'debug');
                        await new Promise(r => setTimeout(r, 1000));
                        retries++;
                    }

                    if (!validTotals) {
                        this.manager.logger.log('Timeout waiting for account totals. No funds available or fetch failed.', 'error');
                        throw new Error('No funds available');
                    }
                }

                await Grid.loadGrid(this.manager, persistedGrid);
                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

                // If startup sync detected missing orders (fills), it returns rebalance instructions
                if (syncResult && syncResult.rebalanceResult) {
                    const { ordersToPlace, ordersToRotate } = syncResult.rebalanceResult;
                    if ((ordersToPlace && ordersToPlace.length > 0) || (ordersToRotate && ordersToRotate.length > 0)) {
                        this.manager.logger.log(`Startup: Detected missing orders (offline fills). executing rebalancing...`, 'info');
                        if (!this.config.dryRun) {
                            await this.updateOrdersOnChainBatch(syncResult.rebalanceResult);
                        } else {
                            this.manager.logger.log(`Dry run: would execute startup rebalancing (${ordersToPlace.length} new, ${ordersToRotate.length} rotated)`, 'info');
                        }
                    }
                }

                // Reconcile existing on-chain orders to the configured target counts.
                // IMPORTANT: Call unconditionally, not just when unmatched orders exist!
                // This ensures activeOrders changes in bots.json are applied on restart:
                // - If user increased activeOrders (e.g., 10→20), new virtual orders activate
                // - If user decreased activeOrders (e.g., 20→10), excess orders are cancelled
                // Without this check, reconciliation is skipped if all current orders match,
                // leaving the bot with the wrong number of active orders
                await reconcileStartupOrders({
                    manager: this.manager,
                    config: this.config,
                    account: this.account,
                    privateKey: this.privateKey,
                    chainOrders,
                    chainOpenOrders,
                    syncResult,
                });

                // Correct any orders with price mismatches at startup
                if (syncResult.ordersNeedingCorrection && syncResult.ordersNeedingCorrection.length > 0) {
                    this.manager.logger.log(`Startup: Correcting ${syncResult.ordersNeedingCorrection.length} order(s) with price mismatch...`, 'info');
                    const correctionResult = await OrderUtils.correctAllPriceMismatches(
                        this.manager, this.account, this.privateKey, chainOrders
                    );
                    if (correctionResult.failed > 0) {
                        this.manager.logger.log(`${correctionResult.failed} startup order correction(s) failed`, 'error');
                    }
                }

                // Show updated funds status after syncing with chain (active orders now counted)
                if (this.manager.logger && typeof this.manager.logger.logFundsStatus === 'function') {
                    this.manager.logger.logFundsStatus(this.manager);
                }

                persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
            }
        }

        // Debounced watcher to avoid duplicate rapid triggers on some platforms
        let _triggerDebounce = null;
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
                console.warn('fs.watch handler error:', err && err.message ? err.message : err);
            }
        });

        const loopDelayMs = Number(process.env.RUN_LOOP_MS || 5000);
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
}

let accountKeysAutostarted = false;

// Launch the account key manager helper with optional BitShares handshake and cleanup.
async function runAccountManager({ waitForConnection = false, exitAfter = false, disconnectAfter = false } = {}) {
    if (waitForConnection) {
        try {
            await waitForConnected();
        } catch (err) {
            console.warn('Timed out waiting for BitShares connection before launching key manager.');
        }
    }

    let succeeded = false;
    try {
        await accountKeys.main();
        succeeded = true;
    } finally {
        if (disconnectAfter) {
            try {
                BitShares.disconnect();
            } catch (err) {
                console.warn('Failed to disconnect BitShares connection after key manager exited:', err.message || err);
            }
        }
    }

    if (exitAfter && succeeded) {
        process.exit(0);
    }
}

/**
 * Handle master password authentication with auto-launch fallback.
 * If no master password is set, automatically launches the key manager
 * to guide the user through initial setup.
 * @returns {Promise<string>} The authenticated master password
 */
async function authenticateMasterPassword() {
    try {
        return await chainKeys.authenticate();
    } catch (err) {
        if (!accountKeysAutostarted && err && err.message && err.message.includes('No master password set')) {
            accountKeysAutostarted = true;
            console.log('no master password set');
            console.log('autostart account keys');
            await runAccountManager();
            return await chainKeys.authenticate();
        }
        throw err;
    }
}

/**
 * Validate a bot configuration entry for required fields.
 * Checks for: assetA, assetB, activeOrders (buy/sell), botFunds (buy/sell)
 * @param {Object} b - Bot entry from bots.json
 * @param {number} i - Index in the bots array
 * @param {string} src - Source name for error messages
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateBotEntry(b, i, src) {
    const problems = [];
    const required = ['assetA', 'assetB', 'activeOrders', 'botFunds'];
    for (const k of required) {
        if (!(k in b)) problems.push(`missing '${k}'`);
    }

    if ('activeOrders' in b) {
        if (typeof b.activeOrders !== 'object' || b.activeOrders === null) problems.push("'activeOrders' must be an object");
        else {
            if (!('buy' in b.activeOrders)) problems.push("activeOrders missing 'buy'");
            if (!('sell' in b.activeOrders)) problems.push("activeOrders missing 'sell'");
        }
    }

    if ('botFunds' in b) {
        if (typeof b.botFunds !== 'object' || b.botFunds === null) problems.push("'botFunds' must be an object");
        else {
            if (!('buy' in b.botFunds)) problems.push("botFunds missing 'buy'");
            if (!('sell' in b.botFunds)) problems.push("botFunds missing 'sell'");
        }
    }

    if (problems.length) {
        const name = b.name || `<unnamed-${i}>`;
        return `Bot[${i}] '${name}' (${src}) -> ${problems.join('; ')}`;
    }
    return null;
}

function collectValidationIssues(entries, sourceName) {
    const errors = [];
    const warnings = [];
    entries.forEach((entry, index) => {
        const issue = validateBotEntry(entry, index, sourceName);
        if (issue) {
            if (entry.active) errors.push(issue);
            else warnings.push(issue);
        }
    });
    return { errors, warnings };
}

/**
 * Execute the provided bot entries after validation and authentication.
 * This is the main orchestration function that:
 * 1. Validates all bot configurations
 * 2. Prompts for master password if any bot needs it
 * 3. Creates DEXBot instances and starts them
 * 
 * @param {Array} botEntries - Array of normalized bot configurations
 * @param {Object} options - Execution options
 * @param {boolean} options.forceDryRun - Force all bots into dry-run mode
 * @param {string} options.sourceName - Source label for logging
 * @returns {Promise<Array>} Array of started DEXBot instances
 */
async function runBotInstances(botEntries, { forceDryRun = false, sourceName = 'settings' } = {}) {
    if (!botEntries.length) {
        console.log(`No bot entries were found in ${sourceName}.`);
        return [];
    }

    const prepared = botEntries.map(entry => ({
        ...entry,
        dryRun: forceDryRun ? true : entry.dryRun,
    }));

    // Note: ensureBotEntries is no longer needed here. Each bot creates its own AccountOrders
    // instance with per-bot file when it starts, eliminating the need for shared initialization.

    const { errors, warnings } = collectValidationIssues(prepared, sourceName);
    if (warnings.length) {
        console.warn(`Found problems in inactive bot entries (${sourceName}):`);
        warnings.forEach(w => console.warn('  -', w));
    }

    if (errors.length) {
        console.error('ERROR: Invalid configuration for one or more **active** bots:');
        errors.forEach(e => console.error('  -', e));
        console.error('Fix the configuration problems in profiles/bots.json and restart. Aborting.');
        process.exit(1);
    }

    const needMaster = prepared.some(b => b.active && b.preferredAccount);
    let masterPassword = null;
    if (needMaster) {
        try {
            await waitForConnected();
        } catch (err) {
            console.warn('Timed out waiting for BitShares connection before prompting for master password.');
        }
        try {
            masterPassword = await authenticateMasterPassword();
        } catch (err) {
            console.warn('Master password entry failed or was cancelled. Bots requiring preferredAccount may need interactive selection.');
            masterPassword = null;
        }
    }

    // Fee cache is required for fill processing (getAssetFees), including offline fill reconciliation at startup.
    // Initialize it once per process for the assets used by active bots.
    try {
        await waitForConnected();
        await OrderUtils.initializeFeeCache(prepared.filter(b => b.active), BitShares);
    } catch (err) {
        console.warn(`Fee cache initialization failed: ${err.message}`);
    }

    const instances = [];
    for (const entry of prepared) {
        if (!entry.active) {
            console.log('Skipping inactive bot entry (active=false) — settings preserved.');
            continue;
        }

        try {
            const bot = new DEXBot(entry);
            await bot.start(masterPassword);
            instances.push(bot);
        } catch (err) {
            console.error('Failed to start bot:', err.message);
            if (err && err instanceof chainKeys.MasterPasswordError) {
                console.error('Aborting because the master password failed 3 times.');
                process.exit(1);
            }
            if (err && err.message && String(err.message).toLowerCase().includes('marketprice')) {
                console.info('Hint: marketPrice could not be derived.');
                console.info(' - If using profiles/bots.json with "pool" or "market" signals, ensure the chain contains a matching liquidity pool or orderbook for the configured pair.');
                console.info(' - Alternatively, set a numeric `marketPrice` directly in profiles/bots.json for this bot to avoid auto-derive.');
                console.info(' - You can also set LIVE_BOT_NAME or BOT_NAME to select a different bot from the profiles settings.');
            }
        }
    }

    if (instances.length === 0) {
        console.log('No active bots were started. Check bots.json and ensure at least one bot is active.');
    }

    return instances;
}

/**
 * Start a specific bot by name or all active bots if no name provided.
 * Looks up the bot in profiles/bots.json and starts it.
 * @param {string|null} botName - Name of the bot to start, or null for all active
 * @param {Object} options - Start options
 * @param {boolean} options.dryRun - Run in dry-run mode (no broadcasts)
 */
async function startBotByName(botName, { dryRun = false } = {}) {
    if (!botName) {
        return runDefaultBots({ forceDryRun: dryRun, sourceName: dryRun ? 'CLI drystart (all)' : 'CLI start (all)' });
    }
    const { config } = loadSettingsFile();
    const entries = resolveRawBotEntries(config);
    if (!entries.length) {
        console.error('No bot definitions exist in the tracked settings.');
        process.exit(1);
    }
    const match = entries.find(b => b.name === botName);
    if (!match) {
        console.error(`Could not find any bot named '${botName}' in the tracked settings.`);
        process.exit(1);
    }
    const entryCopy = JSON.parse(JSON.stringify(match));
    entryCopy.active = true;
    if (dryRun) entryCopy.dryRun = true;
    const normalized = normalizeBotEntries([entryCopy]);
    await runBotInstances(normalized, { forceDryRun: dryRun, sourceName: dryRun ? 'CLI drystart' : 'CLI start' });
}

/**
 * Mark a bot (or all bots) as inactive in profiles/bots.json.
 * Note: This only updates the config file; running processes must be
 * stopped manually (Ctrl+C).
 * @param {string|null} botName - Name of the bot to stop, or null for all
 */
async function stopBotByName(botName) {
    const { config, filePath } = loadSettingsFile();
    const entries = resolveRawBotEntries(config);
    if (!botName) {
        let updated = false;
        entries.forEach(entry => {
            if (entry.active) {
                entry.active = false;
                updated = true;
            }
        });
        if (!updated) {
            console.log('No active bots were found to stop.');
            return;
        }
        saveSettingsFile(config, filePath);
        console.log(`Marked all bots inactive in ${path.basename(filePath)}.`);
        return;
    }
    const match = entries.find(b => b.name === botName);
    if (!match) {
        console.error(`Could not find any bot named '${botName}' to stop.`);
        process.exit(1);
    }
    if (!match.active) {
        console.log(`Bot '${botName}' is already inactive.`);
        return;
    }
    match.active = false;
    saveSettingsFile(config, filePath);
    console.log(`Marked '${botName}' inactive in ${path.basename(filePath)}. Stop the running process manually (Ctrl+C).`);
}

/**
 * Reset a bot by regenerating its grid and starting it fresh.
 * This method creates a trigger file that signals the bot instance
 * (whether running locally or via PM2) to perform a full grid resync.
 *
 * 1. Creates profiles/recalculate.<botKey>.trigger
 * 2. If bot is running, it detects file -> resyncs grid -> deletes file
 * 3. If bot is stopped, it detects file on startup -> resyncs grid -> deletes file
 *
 * @param {string|null} botName - Name of the bot to reset, or null for all active
 */
async function resetBotByName(botName) {
    const { config } = loadSettingsFile();
    const entries = normalizeBotEntries(resolveRawBotEntries(config));

    // Filter targets
    const targets = botName ? entries.filter(b => b.name === botName) : entries.filter(b => b.active);
    if (botName && targets.length === 0) {
        console.error(`Could not find any bot named '${botName}' to reset.`);
        process.exit(1);
    }

    console.log(`Setting regeneration trigger for ${targets.length} bot(s)...`);

    for (const bot of targets) {
        try {
            const triggerFile = path.join(PROFILES_DIR, `recalculate.${bot.botKey}.trigger`);
            fs.writeFileSync(triggerFile, '');
            console.log(`✓ Trigger set for '${bot.name}' (${path.basename(triggerFile)})`);
        } catch (err) {
            console.warn(`Failed to set trigger for '${bot.name}': ${err.message}`);
        }
    }

    console.log();
    console.log('Action complete.');
    console.log('- If the bot is running (CLI or PM2), it will detect the trigger and reset automatically.');
    console.log('- If the bot is stopped, the grid will be regenerated the next time you run `dexbot start`.');
}

/**
 * Parse and execute CLI commands.
 * Supported commands: start, drystart, reset, stop, keys, bots
 * @returns {Promise<boolean>} True if a command was handled, false otherwise
 */
async function handleCLICommands() {
    if (!cliArgs.length) return false;
    const [command, target] = cliArgs;
    if (!CLI_COMMANDS.includes(command)) {
        console.error(`Unknown command '${command}'.`);
        printCLIUsage();
        process.exit(1);
    }
    switch (command) {
        case 'start':
            await startBotByName(target, { dryRun: false });
            return true;
        case 'drystart':
            await startBotByName(target, { dryRun: true });
            return true;
        case 'reset':
            await resetBotByName(target);
            process.exit(0);
        case 'stop':
            await stopBotByName(target);
            process.exit(0);
        case 'keys':
            await runAccountManager({ waitForConnection: true, exitAfter: true, disconnectAfter: true });
            return true;
        case 'bots':
            await accountBots.main();
            try {
                BitShares.disconnect();
            } catch (err) {
                console.warn('Failed to disconnect BitShares after bot helper exit:', err && err.message ? err.message : err);
            }
            process.exit(0);
            return true;
        case 'pm2':
            try {
                const pm2Launcher = require('./pm2.js');
                await pm2Launcher.main();
                // Close stdin and exit cleanly after PM2 startup
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } catch (err) {
                console.error('Error:', err.message);
                process.exit(1);
            }
            return true;
        default:
            printCLIUsage();
            process.exit(1);
    }
}

// Run whatever bots are marked active in the tracked settings file.
async function runDefaultBots({ forceDryRun = false, sourceName = 'settings' } = {}) {
    const { config } = loadSettingsFile();
    const entries = resolveRawBotEntries(config);
    const normalized = normalizeBotEntries(entries);
    await runBotInstances(normalized, { forceDryRun, sourceName });
}

// Entry point combining CLI shortcuts and default bot execution.
async function bootstrap() {
    // Ensure profiles directory exists
    const isNewSetup = ensureProfilesDirectory();

    // If this is a new setup, prompt to set up keys
    if (isNewSetup) {
        // Suppress BitShares connection log during first-time setup
        setSuppressConnectionLog(true);
        console.log();
        console.log('='.repeat(50));
        console.log('Welcome to DEXBot2!');
        console.log('='.repeat(50));
        console.log();
        console.log('To get started, you need to configure your master password.');
        console.log('This password will encrypt your private keys.');
        console.log();
        const setupKeys = readline.keyInYN('Set up master password now?');
        if (setupKeys) {
            console.log();
            await accountKeys.main();
            console.log();
            console.log('Master password configured! Now you can:');
            console.log('  node dexbot bots   - Create and manage bots');
            console.log('  node dexbot        - Run your configured bots');
            console.log();
        } else {
            console.log();
            console.log('You can set up your master password later by running:');
            console.log('  node dexbot keys');
            console.log();
        }
        return;
    }

    // Handle CLI commands first (before checking for bots.json)
    if (await handleCLICommands()) return;

    // Check if bots.json exists - if not, guide user
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        // Suppress BitShares connection log when no bots configured
        setSuppressConnectionLog(true);
        console.log();
        console.log('No bot configuration found.');
        console.log();
        console.log('First, set up your master password:');
        console.log('  node dexbot keys');
        console.log();
        console.log('Then, create your first bot:');
        console.log('  node dexbot bots');
        console.log();
        process.exit(0);
    }

    await runDefaultBots();
}

bootstrap().catch(console.error);

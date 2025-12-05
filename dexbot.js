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
 * - CLI commands: start, drystart, restart, stop, keys, bots
 */
const { BitShares, waitForConnected } = require('./modules/bitshares_client');
const fs = require('fs');
const path = require('path');
const chainOrders = require('./modules/chain_orders');
const chainKeys = require('./modules/chain_keys');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./modules/order');
const accountKeys = require('./modules/chain_keys');
const accountBots = require('./modules/account_bots');
const { parseJsonWithComments } = accountBots;
const { AccountOrders, createBotKey } = require('./modules/account_orders');

// Primary CLI driver that manages tracked bots and helper utilities such as key/bot editors.
const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');


const CLI_COMMANDS = ['start', 'restart', 'stop', 'drystart', 'keys', 'bots'];
const CLI_HELP_FLAGS = ['-h', '--help'];
const CLI_EXAMPLES_FLAG = '--cli-examples';
const CLI_EXAMPLES = [
    { title: 'Start a bot from the tracked config', command: 'dexbot start bbot9', notes: 'Targets the named entry in profiles/bots.json.' },
    { title: 'Dry-run a bot without broadcasting', command: 'dexbot drystart bbot9', notes: 'Forces the run into dry-run mode even if the stored config was live.' },
    { title: 'Manage keys', command: 'dexbot keys', notes: 'Runs modules/chain_keys.js to add or update master passwords.' },
    { title: 'Edit bot definitions', command: 'dexbot bots', notes: 'Launches the interactive modules/account_bots.js helper for the JSON config.' }
];
const cliArgs = process.argv.slice(2);

// Show the CLI usage/help text when requested or upon invalid commands.
function printCLIUsage() {
    console.log('Usage: dexbot [command] [bot-name]');
    console.log('Commands:');
    console.log('  start <bot>       Start the named bot using the tracked config.');
    console.log('  drystart <bot>    Same as start but forces dry-run execution.');
    console.log('  restart <bot>     Re-run the named bot, regenerating the grid.');
    console.log('  stop <bot>        Mark the bot inactive in config (stop running instance separately).');
    console.log('  keys              Launch the chain key helper (modules/chain_keys.js).');
    console.log('  bots              Launch the interactive bot configurator (modules/account_bots.js).');
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
function loadSettingsFile() {
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        console.error('profiles/bots.json not found. Run `npm run bootstrap:profiles` to create it from the tracked examples.');
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

const accountOrders = new AccountOrders();

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
        this.isResyncing = false;
        this.triggerFile = path.join(PROFILES_DIR, `recalculate.${config.botKey}.trigger`);
    }

    async initialize(masterPassword = null) {
        await waitForConnected(30000);
        let accountData = null;
        if (this.config && this.config.preferredAccount) {
            try {
                const pwd = masterPassword || chainKeys.authenticate();
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
     * 5. Persists the grid snapshot to profiles/orders.json
     */
    async placeInitialOrders() {
        if (!this.manager) this.manager = new OrderManager(this.config);
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
            accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));
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
        for (let i = 0; i < interleavedOrders.length; ) {
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
        accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));
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
        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            // Attach account identifiers so OrderManager can fetch on-chain totals when needed
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
        }

        // Start listening for fills BEFORE any order operations to avoid missing fills
        await chainOrders.listenForFills(this.account || undefined, async (fills) => {
            if (this.manager && !this.isResyncing && !this.config.dryRun) {
                for (const fill of fills) {
                    if (fill && fill.op && fill.op[0] === 4) {
                            const fillOp = fill.op[1];
                            // Skip taker fills (is_maker = false means this is not our order being filled)
                            // is_maker = true means our limit order was filled (we are the maker/liquidity provider)
                            if (fillOp.is_maker === false) {
                                this.manager.logger.log(`Skipping taker fill (is_maker=false)`, 'debug');
                                continue;
                            }
                            
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
                            console.log(`=========================\n`);

                            // Process fill based on configured mode
                            const fillMode = chainOrders.getFillProcessingMode();
                            let syncResult;
                            
                            if (fillMode === 'history') {
                                // Use fill event data directly - match by order_id (preferred, faster)
                                this.manager.logger.log(`Processing fill using 'history' mode (order_id matching)`, 'info');
                                syncResult = this.manager.syncFromFillHistory(fillOp);
                                // History mode doesn't detect price mismatches - no ordersNeedingCorrection
                                syncResult.ordersNeedingCorrection = [];
                            } else {
                                // Fallback: Fetch open orders from blockchain and sync (backup method)
                                this.manager.logger.log(`Processing fill using 'open' mode (blockchain sync)`, 'info');
                                const chainOpenOrders = await chainOrders.readOpenOrders(this.account);
                                syncResult = this.manager.syncFromOpenOrders(chainOpenOrders, fillOp);
                            }
                            
                            // Correct any orders with price mismatches (orderId matched but price outside tolerance)
                            // Only applicable in 'open' mode
                            if (syncResult.ordersNeedingCorrection && syncResult.ordersNeedingCorrection.length > 0) {
                                this.manager.logger.log(`Correcting ${syncResult.ordersNeedingCorrection.length} order(s) with price mismatch...`, 'info');
                                const correctionResult = await OrderUtils.correctAllPriceMismatches(
                                    this.manager, this.account, this.privateKey, chainOrders
                                );
                                if (correctionResult.failed > 0) {
                                    this.manager.logger.log(`${correctionResult.failed} order correction(s) failed`, 'error');
                                }
                            }
                            
                            // Process any fully filled orders (create new orders on opposite side)
                            if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                                const newOrders = await this.manager.processFilledOrders(syncResult.filledOrders);
                                if (newOrders && newOrders.length > 0) {
                                    await this.placeNewOrders(newOrders);
                                }
                            }
                            
                            // Always persist snapshot after processing fills
                            accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));
                    }
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
                const cancelFn = (orderId) => chainOrders.cancelOrder(this.account, this.privateKey, orderId);
                await Grid.recalculateGrid(this.manager, readFn, cancelFn);
                accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));

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
            const persistedGrid = accountOrders.loadBotGrid(this.config.botKey);
            const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);
            
            let shouldRegenerate = false;
            if (!persistedGrid || persistedGrid.length === 0) {
                shouldRegenerate = true;
                this.manager.logger.log('No persisted grid found. Generating new grid.', 'info');
            } else {
                await this.manager._initializeAssets();
                const chainOrderIds = new Set(chainOpenOrders.map(o => o.id));
                const hasActiveMatch = persistedGrid.some(order => order.state === 'active' && chainOrderIds.has(order.orderId));
                if (!hasActiveMatch) {
                    shouldRegenerate = true;
                    this.manager.logger.log('Persisted grid found, but no matching active orders on-chain. Generating new grid.', 'info');
                }
            }

            if (shouldRegenerate) {
                // Cancel unmatched on-chain orders immediately (before fetching
                // any account totals). Use the persisted grid to determine which
                // on-chain orders are expected; any others will be cancelled.
                if (!this.config.dryRun) {
                    try {
                        const persistedIds = new Set((persistedGrid || []).map(o => o.orderId).filter(Boolean));
                        if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                            for (const co of chainOpenOrders) {
                                try {
                                    if (!persistedIds.has(co.id)) {
                                        this.manager && this.manager.logger && this.manager.logger.log && this.manager.logger.log(`Cancelling unmatched on-chain order ${co.id} before initializing grid.`, 'info');
                                        await chainOrders.cancelOrder(this.account, this.privateKey, co.id);
                                    }
                                } catch (err) {
                                    this.manager && this.manager.logger && this.manager.logger.log && this.manager.logger.log(`Failed to cancel order ${co.id}: ${err && err.message ? err.message : err}`, 'error');
                                }
                            }
                        }
                    } catch (err) {
                        this.manager && this.manager.logger && this.manager.logger.log && this.manager.logger.log(`Failed to cancel unmatched on-chain orders: ${err && err.message ? err.message : err}`, 'error');
                    }
                }

                await this.placeInitialOrders();
            } else {
                this.manager.logger.log('Found active session. Loading and syncing existing grid.', 'info');
                Grid.loadGrid(this.manager, persistedGrid);
                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                
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
                
                accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));
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
        return chainKeys.authenticate();
    } catch (err) {
        if (!accountKeysAutostarted && err && err.message && err.message.includes('No master password set')) {
            accountKeysAutostarted = true;
            console.log('no master password set');
            console.log('autostart account keys');
            await runAccountManager();
            return chainKeys.authenticate();
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

    accountOrders.ensureBotEntries(prepared);

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
 * Restart a bot by regenerating its grid and starting it fresh.
 * This method:
 * 1. Generates a new order grid from current configuration
 * 2. Persists the grid snapshot to profiles/orders.json
 * 3. Starts the bot with the new grid
 * 
 * @param {string|null} botName - Name of the bot to restart, or null for all active
 */
async function restartBotByName(botName) {
    const { config } = loadSettingsFile();
    const entries = normalizeBotEntries(resolveRawBotEntries(config));

    // Ensure BitShares connection so we can derive prices/assets when building the grid.
    try {
        await waitForConnected(10000);
    } catch (err) {
        console.warn('Timed out waiting for BitShares connection before generating grid snapshots. Will attempt generation without connection where possible.');
    }

    // Generate a fresh grid snapshot for the selected bots and persist to profiles/orders.json
    const targets = botName ? entries.filter(b => b.name === botName) : entries.filter(b => b.active);
    if (botName && targets.length === 0) {
        console.error(`Could not find any bot named '${botName}' to restart.`);
        process.exit(1);
    }

    for (const bot of targets) {
        try {
            // Build an OrderManager with the bot config and initialize the order grid
            const manager = new OrderManager(bot);
            // Populate assets/marketPrice and compute the virtual grid (best-effort)
            try {
                await Grid.initializeGrid(manager);
            } catch (e) {
                // Initialization may fail if on-chain lookups are unavailable; log and continue with whatever grid was built.
                console.warn(`Grid initialization for '${bot.name}' failed: ${e && e.message ? e.message : e}`);
            }

            // Ensure persisted account-orders metadata exists for this bot and persist the generated grid
            accountOrders.ensureBotEntries([bot]);
            accountOrders.storeMasterGrid(bot.botKey, Array.from(manager.orders.values()));
            console.log(`Generated and stored grid snapshot for '${bot.name}' to profiles/orders.json`);
        } catch (err) {
            console.warn(`Failed to generate grid for '${bot.name}': ${err && err.message ? err.message : err}`);
        }
    }

    // When invoked directly via `dexbot restart` we rebuild and persist the
    // grid immediately and do NOT create the `recalculate.*.trigger` files
    // (those remain available as an external hook that other processes
    // can create manually to request a resync). Proceed to start the bot.
    const target = botName ? ` '${botName}'` : ' all active bots';
    console.log(`Restarting${target}. Ensure any previous run is stopped.`);
    await startBotByName(botName, { dryRun: false });
}

/**
 * Parse and execute CLI commands.
 * Supported commands: start, drystart, restart, stop, keys, bots
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
        case 'restart':
            await restartBotByName(target);
            return true;
        case 'stop':
            await stopBotByName(target);
            return true;
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
    if (await handleCLICommands()) return;
    await runDefaultBots();
}

bootstrap().catch(console.error);

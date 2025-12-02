#!/usr/bin/env node
const { BitShares, waitForConnected } = require('./modules/bitshares_client');
const fs = require('fs');
const path = require('path');
const accountOrders = require('./modules/account_orders');
const { OrderManager } = require('./modules/order');
const accountKeys = require('./modules/account_keys');
const accountBots = require('./modules/account_bots');
const { IndexDB, createBotKey } = require('./modules/indexdb');

// Tracked runtime bot definitions live in profiles/bots.json
const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');

const CLI_COMMANDS = ['start', 'restart', 'stop', 'drystart', 'keys', 'bots'];
const CLI_HELP_FLAGS = ['-h', '--help'];
const CLI_EXAMPLES_FLAG = '--cli-examples';
const CLI_EXAMPLES = [
    { title: 'Start a bot from the tracked config', command: 'dexbot start bbot9', notes: 'Targets the named entry in profiles/bots.json.' },
    { title: 'Dry-run a bot without broadcasting', command: 'dexbot drystart bbot9', notes: 'Forces the run into dry-run mode even if the stored config was live.' },
    { title: 'Manage keys', command: 'dexbot keys', notes: 'Runs modules/account_keys.js to add or update master passwords.' },
    { title: 'Edit bot definitions', command: 'dexbot bots', notes: 'Launches the interactive modules/account_bots.js helper for the JSON config.' }
];
const cliArgs = process.argv.slice(2);

function printCLIUsage() {
    console.log('Usage: dexbot [command] [bot-name]');
    console.log('Commands:');
    console.log('  start <bot>       Start the named bot using the tracked config.');
    console.log('  drystart <bot>    Same as start but forces dry-run execution.');
    console.log('  restart <bot>     Re-run the named bot (stop existing process manually first).');
    console.log('  stop <bot>        Mark the bot inactive in config (stop running instance separately).');
    console.log('  keys              Launch the account key helper (modules/account_keys.js).');
    console.log('  bots              Launch the interactive bot configurator (modules/account_bots.js).');
    console.log('Options:');
    console.log('  --cli-examples    Print curated CLI snippets.');
    console.log('  -h, --help        Show this help text.');
    console.log('Envs: RUN_LOOP_MS controls the polling delay; LIVE_BOT_NAME or BOT_NAME selects a single entry.');
}

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

function parseJsonWithComments(raw) {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped);
}

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

function saveSettingsFile(config, filePath) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Failed to save bot settings to', filePath, '-', err.message);
        throw err;
    }
}

function resolveRawBotEntries(settings) {
    if (!settings || typeof settings !== 'object') return [];
    if (Array.isArray(settings.bots)) return settings.bots;
    if (Object.keys(settings).length > 0) return [settings];
    return [];
}

function normalizeBotEntries(rawEntries) {
    return rawEntries.map((entry, index) => {
        const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
        return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
    });
}

const indexDB = new IndexDB();

// Connection handled centrally by modules/bitshares_client; use waitForConnected() when needed

/**
 * Real DEX Bot using BitShares API
 */
class DEXBot {
    constructor(config) {
        this.config = config;
        this.account = null;
        this.privateKey = null;
        this.orderGrid = [];
        this.manager = null;
    }

    async initialize(masterPassword = null) {
        // Wait for shared BitShares connection (wrap with explicit timeout)
        await waitForConnected(30000);

        // Select account.
        // If settings specify a preferredAccount, use that (requires master password entry).
        let accountData = null;
        if (this.config && this.config.preferredAccount) {
            try {
            // Authenticate and fetch the private key. If a masterPassword was
            // provided by the caller we reuse it to avoid prompting each bot
            // separately. Otherwise prompt interactively.
            const pwd = masterPassword || accountOrders.authenticate();
            const privateKey = accountOrders.getPrivateKey(this.config.preferredAccount, pwd);

                // build account data and set preferred account id using shared DB lookup
                let accId = null;
                try {
                    const full = await BitShares.db.get_full_accounts([this.config.preferredAccount], false);
                    if (full && full[0]) {
                        const maybe = full[0][0];
                        if (maybe && String(maybe).startsWith('1.2.')) accId = maybe;
                        else if (full[0][1] && full[0][1].account && full[0][1].account.id) accId = full[0][1].account.id;
                    }
                } catch (e) {
                    // best-effort
                }

                if (accId) accountOrders.setPreferredAccount(accId, this.config.preferredAccount);

                accountData = { accountName: this.config.preferredAccount, privateKey, id: accId };
            } catch (err) {
                console.warn('Auto-selection of preferredAccount failed:', err.message);
                // fall back to interactive selection
                accountData = await accountOrders.selectAccount();
            }
        } else {
            accountData = await accountOrders.selectAccount();
        }
        this.account = accountData.accountName;
        // prefer explicit account id returned by selectAccount or earlier branch
        this.accountId = accountData.id || null;
        this.privateKey = accountData.privateKey;

        console.log(`Initialized DEXBot for account: ${this.account}`);
    }

    async createOrderGrid() {
        // Use the centralized OrderManager as the single order engine
        console.log('Initializing OrderManager for order grid...');

        // Create an order manager instance if not already present
        if (!this.manager) this.manager = new OrderManager(this.config || {});

        // Optionally set account totals if we can derive them from chain (best-effort)
        try {
            if (this.account) {
                // attempt to fetch balances for the preferred account and set totals
                // Best-effort: try to read full account and infer totals (non-fatal)
                const accFull = await BitShares.db.get_full_accounts([this.account], false);
                if (accFull && accFull[0] && accFull[0][1]) {
                    const balances = accFull[0][1].balances || [];
                    // We'll set simple totals only if we can identify base/quote using config.assetA/assetB
                    const assetMap = {};
                    for (const b of balances) {
                        // b is { asset_type, balance }
                        assetMap[b.asset_type] = Number(b.amount || 0);
                    }
                    // NOTE: this is best-effort; manager expects totals as float amounts in base/quote units
                    // We will not attempt complex precision conversion here to avoid mistakes in production
                }
            }
        } catch (err) {
            console.warn('Could not fetch account totals (non-fatal):', err.message);
        }

        // Initialize the in-memory order grid (this will throw if marketPrice out of range)
        try {
            await this.manager.initialize();
            const snapshot = Array.from(this.manager.orders.values());
            try {
                indexDB.storeMasterGrid(this.config.botKey, snapshot);
            } catch (gridErr) {
                console.warn('indexdb: could not persist master grid for', this.config.botKey, gridErr.message);
            }
        } catch (err) {
            // If auto-derive left marketPrice non-numeric (or outside bounds) try a secondary
            // auto-derive attempt by toggling the strategy: if configured as 'pool', try 'market'
            // and vice versa. This gives a best-effort chance to start a bot when one path fails.
            const curMP = this.manager && this.manager.config && this.manager.config.marketPrice;
            const wasPool = typeof curMP === 'string' && String(curMP).trim().toLowerCase() === 'pool';
            const wasMarket = typeof curMP === 'string' && String(curMP).trim().toLowerCase() === 'market';

            if (wasPool || wasMarket || !Number.isFinite(Number(curMP))) {
                try {
                    const alt = wasPool ? 'market' : (wasMarket ? 'pool' : 'market');
                    console.warn(`marketPrice auto-derive failed (${err.message}). Attempting fallback '${alt}' auto-derive for bot '${this.config.name || this.config.assetA + '/' + this.config.assetB}'`);
                    this.manager.config.marketPrice = alt;
                    // Try to re-initialize only the order grid discovery portion
                    await this.manager.initializeOrderGrid();
                    // Continue with synchronize step if it exists
                    if (typeof this.manager.synchronizeOrders === 'function') await this.manager.synchronizeOrders();
                    console.log('Fallback auto-derive succeeded');
                } catch (err2) {
                    console.error('Fallback auto-derive also failed:', err2 && err2.message ? err2.message : err2);
                    throw err;
                }
            } else {
                // Not a marketPrice problem; rethrow to let outer handler report
                throw err;
            }
        }

        // If not in dry-run mode, warn: currently on-chain order creation is not wired here
        if (!this.config.dryRun) {
            console.log('WARNING: live run is enabled but dexbot.js does not yet translate virtual orders into on-chain createOrder calls automatically. Use account_orders.createOrder if required.');
        }
    }

    async start(masterPassword = null) {
        await this.initialize(masterPassword);
        await this.createOrderGrid();

        // Start listening for on-chain fills and forward them to a simple handler
        // Prefer explicit account id per-listener to avoid module-level race conditions
        await accountOrders.listenForFills(this.account || undefined, (fills) => {
            console.log('On-chain fill detected:', fills);
            // TODO: map chain fills to manager orders & trigger reconciliation (future enhancement)
        });

        // Run the OrderManager periodically (keep it synced) \u2014 do NOT trigger full calculations here.
        // Calculation runs (calculate: true) are intentionally left for explicit on-demand usage
        // or a separate workflow. This loop therefore only polls for updates (no calculation).
        const loopDelayMs = Number(process.env.RUN_LOOP_MS || 5000);
        (async () => {
            while (true) {
                try {
                    // Only fetch updates (active orders / status). Calculations will be triggered
                    // explicitly elsewhere when needed.
                    await this.manager.fetchOrderUpdates();
                } catch (err) {
                    console.error('Order manager loop error:', err.message);
                }
                await new Promise(resolve => setTimeout(resolve, loopDelayMs));
            }
        })();

        console.log('DEXBot started. OrderManager running (dryRun=' + !!this.config.dryRun + ')');
    }
}

let accountKeysAutostarted = false;

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

async function authenticateMasterPassword() {
    try {
        return accountOrders.authenticate();
    } catch (err) {
        if (!accountKeysAutostarted && err && err.message && err.message.includes('No master password set')) {
            accountKeysAutostarted = true;
            console.log('no master password set');
            console.log('autostart account keys');
            await runAccountManager();
            return accountOrders.authenticate();
        }
        throw err;
    }
}

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

async function runBotInstances(botEntries, { forceDryRun = false, sourceName = 'settings' } = {}) {
    if (!botEntries.length) {
        console.log(`No bot entries were found in ${sourceName}.`);
        return [];
    }

    const prepared = botEntries.map(entry => ({
        ...entry,
        dryRun: forceDryRun ? true : entry.dryRun,
    }));

    indexDB.ensureBotEntries(prepared);

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

async function restartBotByName(botName) {
    const target = botName ? ` '${botName}'` : ' all active bots';
    console.log(`Restarting${target}. Ensure any previous run is stopped (Ctrl+C) before new execution.`);
    await startBotByName(botName, { dryRun: false });
}

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

async function runDefaultBots({ forceDryRun = false, sourceName = 'settings' } = {}) {
    const { config } = loadSettingsFile();
    const entries = resolveRawBotEntries(config);
    const normalized = normalizeBotEntries(entries);
    await runBotInstances(normalized, { forceDryRun, sourceName });
}

async function bootstrap() {
    if (await handleCLICommands()) return;
    await runDefaultBots();
}

bootstrap().catch(console.error);

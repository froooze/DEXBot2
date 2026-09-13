#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { CLI_COLORS } from './modules/cli_colors.js';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);
// node-only entry point — primary CLI driver (process.argv, process.exit, process.stdout/stderr, process.stdin)
/**
 * dexbot.ts - DEXBot2 Primary CLI Driver
 *
 * Main entry point for DEXBot2 grid trading bot system.
 * Manages tracked bots and provides helper utilities (key/bot editors).
 * Creates grid-based limit orders across price ranges and auto-replaces fills.
 *
 * ===============================================================================
 * FEATURES
 * ===============================================================================
 *
 * GRID TRADING:
 * - Configurable grid spacing with geometric increments (e.g., 0.5%)
 * - Independent BUY and SELL order counts per bot
 * - Dynamic spread zone around market price
 * - Automatic order replacement when fills occur
 * - Fund allocation controls (percentage of wallet)
 * - Copy-on-Write rebalancing: Safe concurrent updates with isolated working grids
 * - Automatic grid reconciliation: Detects offline fills and syncs with blockchain
 *
 * SECURITY:
 * - Master password encryption for stored private keys (AES-256-GCM)
 * - Optional credential daemon for multi-bot key management
 * - No private keys in environment variables
 * - Per-bot configuration and state isolation
 *
 * OPERATION MODES:
 * - Live trading: Real orders on blockchain
 * - Dry-run mode: Simulate operations without broadcasting
 * - Manual control: Enable/disable/reset individual bots
 *
 * ===============================================================================
 * CLI COMMANDS
 * ===============================================================================
 *
 * TRADING OPERATIONS:
 *   dexbot test <bot>             - Test-run single bot (live trading)
 *   dexbot drystart <bot>         - Start bot in dry-run mode (no transactions)
 *
 * 🛠️ BOT MANAGEMENT:
 *   dexbot reset all              - Reset all active bot grids (full regeneration)
 *   dexbot reset <bot>            - Reset bot grid (full regeneration)
 *   dexbot default                - Reset settings to defaults (deletes general.settings.json, market_profiles.json, market_adapter_settings.json)
 *   dexbot disable all            - Mark all bots inactive in config
 *   dexbot disable <bot>          - Mark bot inactive in config
 *   dexbot clear                  - Clear all log files in <profiles>/logs/
 *
 * CONFIGURATION:
 *   dexbot key                    - Set up master password and keyring
 *   dexbot bot                    - Interactive editor for bot definitions
 *
 * PM2 ORCHESTRATION:
 *   dexbot pm2                    - Start all bots via PM2 with daemon
 *   dexbot pm2 stop all           - Stop all PM2 bot processes
 *   dexbot pm2 stop <bot>         - Stop specific bot
 *   dexbot pm2 delete all         - Delete all bots from PM2
 *   dexbot pm2 delete <bot>       - Delete specific bot from PM2
 *   dexbot pm2 help               - Show PM2 command help
 *
 * STATUS:
 *   dexbot status                 - Show bot runtime status (unlock monolithic/isolated or PM2)
 *
 * MAINTENANCE:
 *   dexbot update                 - Update to latest version (pull + install + restart)
 *   dexbot stop                   - Stop the monolithic runtime
 *   dexbot reload                 - Reload the monolithic runtime (leaves credential daemon untouched)
 *   dexbot restart                - Restart the monolithic runtime (re-unlocks credential daemon)
 *   dexbot delete                 - Stop/delete all runtime processes
  *   dexbot export <bot>           - Export trading history to CSV/JSON for local analysis/
 *   dexbot order                  - Analyze persisted order grids in profiles/orders/
 *   dexbot order [<bot>]          - Analyze only the specified bot's order grid
 *   dexbot order --export         - Export order analysis as standalone HTML report
 *   dexbot order [<bot>] --export - Export only the specified bot's analysis
 *   dexbot credit               - Show live summed MPA + borrowed-credit positions per asset per bot
 *   dexbot credit [<bot>]       - Show only the specified bot's positions
 *   dexbot tv <bot|pool|pair>   - TradingView chart: 1h candles, N months (default 3, --month N)
 *   dexbot help                   - Show this help message
 *
 * NPM SCRIPTS (alternative invocation):
 *   npm run pm2:start                - Start bots (requires ecosystem.config.cjs pre-generated)
 *   npm run pm2:stop                 - Stop all PM2 bots
 *
 * ===============================================================================
 * CONFIGURATION
 * ===============================================================================
 *
 * Bots:  <profiles>/bots.json
 * Keys:  <profiles>/keys.json (encrypted)
 * State: <profiles>/orders/{botKey}.json (per-bot grid snapshots)
 * Logs:  <profiles>/logs/<bot>.log
 *
 * <profiles> resolves to ~/.config/dexbot2/profiles by default for all
 * installs (override: DEXBOT_PROFILE_ROOT); a source checkout with a
 * populated profiles/ dir in the repo keeps using it.
 *
 * ===============================================================================
 */

// Restrict default file permissions: files created by this process default to
// 0o600 (owner-only) unless explicitly opened with a wider mode.  Protects
// keys.json and daemon-policies.json from world-readable exposure.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { setUmask } = require('./modules/config');
setUmask(0o077);

const { BitShares, waitForConnected, setSuppressConnectionLog, disconnectClient } = require('./modules/bitshares_client');
const { path } = require('./modules/path_api');
const { getStorage } = require('./modules/storage');
const storage = getStorage();
const chainKeys = require('./modules/chain_keys');
const { initializeFeeCache, ensureProfilesDirectory, readInput } = require('./modules/order/utils/system');
const accountBots = require('./modules/account_bots');
const SharedDEXBot = require('./modules/dexbot_class').default;
const fundRegistry = require('./modules/fund_registry');

/**
 * Resolve a collateral asset reference (symbol or ID) to its canonical asset ID.
 * Uses the already-connected BitShares DB instance.
 * Caches results per reference to avoid redundant lookups in the registration loop.
 */
const _collateralAssetIdCache = new Map<string, string | null>();
async function _resolveCollateralAssetId(ref: string): Promise<string | null> {
    if (_collateralAssetIdCache.has(ref)) return _collateralAssetIdCache.get(ref) ?? null;
    let result: string | null = null;
    try {
        if (typeof ref === 'string' && ref.startsWith('1.3.')) {
            result = ref;
        } else if (typeof ref === 'string') {
            const res = await BitShares.db.lookup_asset_symbols([ref]);
            if (res && res[0] && res[0].id) result = String(res[0].id);
        }
    } catch (_err: any) {
        result = null;
    }
    _collateralAssetIdCache.set(ref, result);
    return result;
}

const { setupGracefulShutdown, registerCleanup, unregisterCleanup } = require('./modules/graceful_shutdown');
const {
    collectValidationIssues,
    loadSettingsFile,
    normalizeBotEntries,
    resolveRawBotEntries,
    saveSettingsFile,
} = require('./modules/bot_settings');
const { buildRuntimeScriptArgs } = require('./modules/launcher/runtime_entry');
const { PATHS, getHomeProfilesDir, getRecalculateTriggerFile } = require('./modules/paths');
const credentialPolicy = require('./modules/credential_policy');
const { Config } = require('./modules/config');
const { getErrorMessage } = require('./modules/utils/errors');
const { isSameBotName } = require('./modules/utils/sanitize_key');

// Setup graceful shutdown handlers

// Setup graceful shutdown handlers
setupGracefulShutdown();

// Verify keys file permissions early — refuse to run if keys.json is
// world-readable (would indicate a prior run with a permissive umask).
if (typeof chainKeys.checkKeysFileSecurity === 'function') chainKeys.checkKeysFileSecurity();
// Same migration-aware check for daemon-policies.json.
if (typeof credentialPolicy.checkPolicyFileSecurity === 'function') credentialPolicy.checkPolicyFileSecurity(PATHS.PROFILES.DAEMON_POLICIES_JSON);

// Note: accountOrders is now per-bot only. Each bot has its own AccountOrders instance
// created in DEXBot.start() in modules/dexbot_class.ts. This eliminates shared-file race conditions.

// Primary CLI driver that manages tracked bots and helper utilities such as key/bot editors.
const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const PROFILES_DIR = PATHS.PROFILES_DIR;

const CLI_COMMANDS = ['start', 'test', 'reset', 'default', 'disable', 'enable', 'drystart', 'key', 'bot', 'pm2', 'update', 'export', 'order', 'credit', 'tv', 'clear', 'clear-orders', 'clear-market-adapter', 'clear-all', 'status', 'whitelist', 'unlock', 'delete', 'stop', 'restart', 'reload', 'help'];
const COMMAND_ALIASES: Record<string, string> = { orders: 'order', keys: 'key', bots: 'bot', white: 'whitelist', stat: 'status', stats: 'status', start: 'unlock', defaults: 'default', stp: 'stop', stopall: 'stop', restartall: 'restart', reloadall: 'reload' };
const CLI_HELP_FLAGS = ['-h', '--help'];
const CLI_EXAMPLES_FLAG = '--cli-examples';
const CLI_EXAMPLES = [
    { title: 'Test-run a bot from the tracked config', command: 'dexbot test <bot>', notes: 'Targets the named entry in profiles/bots.json.' },
    { title: 'Dry-run a bot without broadcasting', command: 'dexbot drystart <bot>', notes: 'Forces the run into dry-run mode even if the stored config was live.' },
    { title: 'Disable a bot in config', command: 'dexbot disable <bot>', notes: 'Marks the bot inactive in config.' },
    { title: 'Enable a bot in config', command: 'dexbot enable <bot>', notes: 'Marks the bot active in config.' },
    { title: 'Reset all active bot grids', command: 'dexbot reset all', notes: 'Triggers full grid regeneration for every active bot.' },
    { title: 'Reset a bot grid', command: 'dexbot reset <bot>', notes: 'Triggers a full grid regeneration for the named bot.' },
    { title: 'Manage keys', command: 'dexbot key', notes: 'Runs modules/chain_keys.ts to add or update master passwords.' },
    { title: 'Edit bot definitions', command: 'dexbot bot', notes: 'Launches the interactive modules/account_bots.ts helper for the JSON config.' },
    { title: 'Start bots with PM2', command: 'dexbot pm2', notes: 'Generates ecosystem config, authenticates, and starts PM2.' },
    { title: 'Update DEXBot2', command: 'dexbot update', notes: 'Fetches latest code, updates dependencies, and restarts PM2.' },
    { title: 'Export bot trades for local analysis', command: 'dexbot export <bot>', notes: 'Exports trading history and settings to CSV/JSON (see analysis/).' },
    { title: 'Analyze persisted order grids', command: 'dexbot order', notes: 'Runs the order analyzer across the orders directory (<profiles>/orders) and prints spread/increment/funds/distribution metrics. Add a bot key to render only that bot, and --export for an HTML report.' },
    { title: 'Show live credit/MPA positions', command: 'dexbot credit', notes: 'Queries get_margin_positions + get_credit_deals_by_borrower per preferredAccount and prints debt/collateral sums plus one Curr. CR line per whitelisted pair (active CR, else borrow-now CR vs funds avail. on the offer) and one Avar. CR line per bot. CR covers only pairs whitelisted in bots.json and listed on the current credit offer. Add a bot key to render only that bot.' },
    { title: 'TradingView chart for a bot, pool, or pair', command: 'dexbot tv <bot|pool-id|AssetA/AssetB> --month 3', notes: 'Fetches 1h candles for N months (default 3, pool-first with orderbook fallback; --feed charts MPA price-feed history) and writes an auto-named HTML chart.' },
    { title: 'Clear all bot log files', command: 'dexbot clear', notes: 'Runs scripts/clear-logs.sh to remove log files from the logs directory (<profiles>/logs).' },
    { title: 'Reset settings to defaults', command: 'dexbot default', notes: 'Runs scripts/reset-settings.sh to delete general.settings.json, market_profiles.json, and market_adapter_settings.json.' }
];

const STARTUP_COLORS = {
    reset: CLI_COLORS.reset,
    ok: CLI_COLORS.brightGreen,
    error: CLI_COLORS.boldRed,
};

function colorStartupOutput(text: string, color: string, stream: any = process.stdout): string {
    return stream.isTTY && !Config.NO_COLOR
        ? `${color}${text}${STARTUP_COLORS.reset}`
        : text;
}

function startupSuccess(text: string): string {
    return colorStartupOutput(text, STARTUP_COLORS.ok);
}

function startupError(text: string): string {
    return colorStartupOutput(text, STARTUP_COLORS.error, process.stderr);
}

function colorStartupActiveBotName(name: string): string {
    return startupSuccess(name);
}
const cliArgs = process.argv.slice(2);

/**
 * Show the CLI usage/help text when requested or upon invalid commands.
 */
function printCLIUsage() {
    console.log('Usage: dexbot [command] [bot]');
    console.log('Commands:');
    console.log('  test <bot>        Test-run the named bot (one-shot, live trading).');
    console.log('  start [bot]       Start the monolithic runtime. Counterpart to stop.');
    console.log('  drystart <bot>    Same as test but forces dry-run execution.');
    console.log('  reset all         Trigger grid resets for all active bots.');
    console.log('  reset <bot>       Trigger a grid reset (auto-reloads if running, or applies on next start).');
    console.log('  default, defaults Reset settings to defaults (deletes general.settings.json, market_profiles.json, market_adapter_settings.json).');
    console.log('  disable all       Mark all bots inactive in config.');
    console.log('  disable <bot>     Mark the bot inactive in config.');
    console.log('  enable all        Mark all bots active in config.');
    console.log('  enable <bot>      Mark the bot active in config.');
    console.log('  export <bot>      Export bot trades and settings to CSV/JSON for local analysis/.');
    console.log('  key               Launch the chain key helper (modules/chain_keys.ts).');
    console.log('  bot               Launch the interactive bot configurator (modules/account_bots.ts).');
    console.log('  pm2               Start all active bots with PM2 (authenticate + generate config + start).');
    console.log('  update            Update DEXBot2 from the repository and restart active bots.');
    console.log('  order             Analyze persisted order grids in <profiles>/orders/ (spread, increment, funds). Use --export for HTML.');
    console.log('  credit [<bot>]    Show live summed MPA + borrowed-credit positions per asset per bot.');
    console.log('  tv <target>       TradingView chart: 1h candles for <bot|pool-id|AssetA/AssetB> over --month N (default 3).');
    console.log('  order [<bot>]     Analyze only the specified bot.');
    console.log('  status, stat, stats  Show bot runtime status (unlock monolithic/isolated or PM2).');
    console.log('  unlock            Legacy alias for start (repo-root: `./unlock`).');
    console.log('  stop              Stop the monolithic runtime.');
    console.log('  reload            Reload the monolithic runtime (leaves credential daemon untouched).');
    console.log('  restart           Restart the monolithic runtime (re-unlocks credential daemon).');
    console.log('  delete            Stop/delete all runtime processes.');
    console.log('  whitelist, white  Generate market adapter whitelist from AMA bot configs. Flags (--dynamic-weight, --asymmetric-bounds, --prune, --bot <key>) are forwarded. --bot implies overwrite for that key.');
    console.log('  clear             Remove all log files from <profiles>/logs/ (runs scripts/clear-logs.sh).');
    console.log('  clear-orders      Remove all persisted order files from <profiles>/orders/.');
    console.log('  clear-market-adapter  Remove market adapter data, state, and logs.');
    console.log('  clear-all         Remove orders, logs, and market adapter files (combines the above).');
    console.log('Options:');
    console.log('  --cli-examples    Print curated CLI snippets.');
    console.log('  -h, --help        Show this help text.');
    console.log('Envs: OPEN_ORDERS_SYNC_LOOP_MS controls the open-orders sync polling delay; LIVE_BOT_NAME or BOT_NAME selects a single entry.');
}

/**
 * Print curated CLI snippets for quick reference.
 */
function printCLIExamples() {
    console.log('CLI Examples:');
    CLI_EXAMPLES.forEach((example, index) => {
        console.log(`${index + 1}. ${example.title}`);
        console.log(`   ${example.command}`);
        if (example.notes) console.log(`   ${example.notes}`);
    });
    console.log(`Read the README "CLI usage" section for more details (file: ${PROFILES_BOTS_FILE}).`);
}

if (cliArgs.some(arg => CLI_HELP_FLAGS.includes(arg))) {
    // Commands whose target scripts own their `--help` output keep the flag
    // so the script prints its usage. Only scripts with offline help handling
    // belong here — forwarding to a script without it could misinterpret the
    // flag as input (e.g. a bot-name filter triggering live work).
    const HELP_OWNING_COMMANDS = new Set(['credit', 'tv']);
    const requestedCommand = COMMAND_ALIASES[cliArgs[0]] ?? cliArgs[0];
    if (!HELP_OWNING_COMMANDS.has(requestedCommand)) {
        printCLIUsage();
        process.exit(0);
    }
}

if (cliArgs.includes(CLI_EXAMPLES_FLAG)) {
    printCLIExamples();
    process.exit(0);
}

// Connection handled centrally by modules/bitshares_client; use waitForConnected() when needed

/**
 * DEXBot - Thin wrapper around SharedDEXBot for dexbot.ts CLI context.
 * All trading lifecycle (grid, order management, sync) is handled by SharedDEXBot.
 *
 * @class
 */
// Extend SharedDEXBot for dexbot.ts context (thin wrapper)
class DEXBot extends SharedDEXBot {
    constructor(config: any) {
        super(config, { logPrefix: '' });
    }
}

// Register BitShares cleanup on shutdown
registerCleanup('BitShares connection', () => {
    try {
        disconnectClient();
    } catch (err) {
        // BitShares may already be disconnected
    }
});

// Track attempts to prevent infinite loops while allowing retries after key setup
let keySetupInProgress = false;

/**
 * Launch the account key manager helper.
 * @param {Object} [options={}] - Manager options.
 * @param {boolean} [options.waitForConnection=false] - Whether to wait for BitShares connection.
 * @param {boolean} [options.exitAfter=false] - Whether to exit the process after completion.
 * @param {boolean} [options.disconnectAfter=false] - Whether to disconnect BitShares after completion.
 * @returns {Promise<void>}
 */
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
         await chainKeys.main();
         succeeded = true;
     } finally {
         if (disconnectAfter) {
             try {
                 disconnectClient();
     } catch (err: any) {
         console.warn('Failed to disconnect BitShares connection after key manager exited:', getErrorMessage(err) || err);
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
    } catch (err: any) {
        if (!keySetupInProgress && err && getErrorMessage(err) && getErrorMessage(err).includes('No master password set')) {
            keySetupInProgress = true;
            try {
                await runAccountManager();
                keySetupInProgress = false;
                return await chainKeys.authenticate();
            } catch (setupErr) {
                keySetupInProgress = false;
                 throw setupErr;
             }
         }
        throw err;
    }
}

function printStartLauncherHeader({ botName = null, dryRun = false } = {}) {
    console.log('='.repeat(50));
    console.log('DEXBot2 Start Launcher');
    if (botName) {
        console.log(`Starting bot: ${botName}`);
    } else {
        console.log('Starting all bots');
    }
    if (dryRun) {
        console.log('Dry-run mode enabled');
    }
    console.log('='.repeat(50));
    console.log();
}

function printStartLauncherSuccess({ botName = null, dryRun = false } = {}) {
    const dryrunFlag = dryRun ? ' --dryrun' : '';
    console.log();
    console.log('='.repeat(50));
    console.log(startupSuccess('DEXBot2 started successfully!'));
    if (botName) {
        console.log(`If the bot stops, rerun \`dexbot start${dryrunFlag} ${botName}\`.`);
    } else {
        console.log(`If the bots stop, rerun \`dexbot start${dryrunFlag}\`.`);
    }
    console.log('='.repeat(50));
    console.log();
}

function printMasterPasswordFailure(err: any) {
    console.error();
    console.error(startupError(`❌ ${getErrorMessage(err)}`));
}

const BOT_START_RESTART = Object.freeze({ MAX_ATTEMPTS: 3, RETRY_DELAY_MS: 30000 });
const botStartRetryState = new Map<string, { attempts: number; timer: any }>();

function botRetryKey(entry: any): string {
    return String(entry?.name || entry?.botKey || 'unnamed');
}

function clearBotStartRetry(botName: string): void {
    const state = botStartRetryState.get(botName);
    if (state && state.timer) {
        clearTimeout(state.timer);
    }
    botStartRetryState.delete(botName);
}

function scheduleBotStartRetry(entry: any, { forceDryRun = false, reason = '' }: { forceDryRun?: boolean; reason?: string } = {}): void {
    const botName = botRetryKey(entry);
    if (botName === 'unnamed') return;
    const state = botStartRetryState.get(botName) || { attempts: 0, timer: null };
    botStartRetryState.set(botName, state);
    if (state.attempts >= BOT_START_RESTART.MAX_ATTEMPTS) {
        botStartRetryState.delete(botName);
        console.error(startupError(
            `Bot '${botName}' failed to start ${BOT_START_RESTART.MAX_ATTEMPTS + 1} time(s); giving up — ` +
            `manual restart required ('dexbot restart ${botName}'). Last error: ${reason}`
        ));
        return;
    }
    state.attempts += 1;
    console.warn(
        `Bot '${botName}' failed to start; scheduling restart in ${BOT_START_RESTART.RETRY_DELAY_MS / 1000}s ` +
        `(attempt ${state.attempts}/${BOT_START_RESTART.MAX_ATTEMPTS}): ${reason}`
    );
    state.timer = setTimeout(async () => {
        state.timer = null;
        try {
            const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
            const entries = resolveRawBotEntries(config);
            const match = entries.find((b: any) => isSameBotName(b.name, botName));
            if (!match || match.active === false) {
                console.log(`Auto-restart: bot '${botName}' is no longer active in ${path.basename(PROFILES_BOTS_FILE)}; giving up.`);
                clearBotStartRetry(botName);
                return;
            }
            const entryCopy = JSON.parse(JSON.stringify(match));
            entryCopy.active = true;
            if (forceDryRun) entryCopy.dryRun = true;
            await runBotInstances([entryCopy], {
                forceDryRun,
                sourceName: `auto-restart (attempt ${state.attempts}/${BOT_START_RESTART.MAX_ATTEMPTS})`,
            });
        } catch (err: any) {
            scheduleBotStartRetry(entry, { forceDryRun, reason: getErrorMessage(err) });
        }
    }, BOT_START_RESTART.RETRY_DELAY_MS);
}

/**
 * Execute the provided bot entries after validation and authentication.
 * This is the main orchestration function that:
 * 1. Validates all bot configurations
 * 2. Prompts for master password if any bot needs it
 * 3. Creates DEXBot instances and starts them
 *
 * @param {Array} botEntries - Array of normalized bot configurations
 * @param {Object} [options] - Execution options
 * @param {boolean} [options.forceDryRun=false] - Force all bots into dry-run mode
 * @param {string} [options.sourceName='settings'] - Source label for logging
 * @param {Object} [options.launcherStyle=null] - Launcher presentation options
 * @returns {Promise<Array>} Array of started DEXBot instances
 */
async function runBotInstances(botEntries: any[], { forceDryRun = false, sourceName = 'settings', launcherStyle }: { forceDryRun?: boolean; sourceName?: string; launcherStyle?: any } = {}) {
    setSuppressConnectionLog(true);

    const shouldAnnounceLauncher = !!launcherStyle;
    const launcherBotName = launcherStyle?.botName || null;
    const launcherDryRun = !!launcherStyle?.dryRun;
    let connectionAnnounced = false;
    let authenticationAnnounced = false;
    const activeCount = (botEntries || []).filter((entry: any) => entry && entry.active !== false).length;

    const announceConnection = () => {
        if (shouldAnnounceLauncher && !connectionAnnounced) {
            console.log(startupSuccess('Connected to BitShares'));
            connectionAnnounced = true;
        }
    };

    const announceAuthentication = () => {
        if (shouldAnnounceLauncher && !authenticationAnnounced) {
            console.log(startupSuccess('✓ Authentication successful'));
            authenticationAnnounced = true;
        }
    };

    try {
        if (shouldAnnounceLauncher) {
            printStartLauncherHeader({ botName: launcherBotName, dryRun: launcherDryRun });
        }

        if (!botEntries.length) {
            console.log(`No bot entries were found in ${sourceName}.`);
            return [];
        }

        const prepared = botEntries.map((entry: any) => ({
            ...entry,
            dryRun: forceDryRun ? true : entry.dryRun,
        }));

        // Note: each bot creates its own AccountOrders instance with per-bot file when it
        // starts and syncs its own meta via syncMeta(). No shared initialization needed here.

        const { errors } = collectValidationIssues(prepared, sourceName);

        if (errors.length) {
            console.error(startupError('ERROR: Invalid configuration for one or more **active** bots:'));
            errors.forEach((e: any) => console.error(startupError(`  - ${e}`)));
            console.error(startupError(`Fix the configuration problems in ${PROFILES_BOTS_FILE} and restart. Aborting.`));
            process.exit(1);
        }

        const needMaster = prepared.some((b: any) => b.active && b.preferredAccount);
        let masterPassword = null;
        if (needMaster) {
            const daemonReady = await chainKeys.isDaemonResponsive();

            try {
                await waitForConnected();
                announceConnection();
            } catch (err) {
                // Continue; the bot startup path will retry through the normal runtime flow.
            }

            if (!daemonReady) {
                try {
                    masterPassword = await authenticateMasterPassword();
                    announceAuthentication();
                } catch (err) {
                    if (chainKeys.isMasterPasswordFailure(err)) {
                        throw err;
                    }
                    masterPassword = null;
                }
            }
        }

        // Fee cache is required for fill processing (getAssetFees), including offline fill reconciliation at startup.
        // Initialize it once per process for the assets used by active bots.
        try {
            await waitForConnected();
            announceConnection();
            await initializeFeeCache(prepared.filter((b: any) => b.active), BitShares);
        } catch (err: any) {
            console.error(startupError(`Fee cache initialization failed: ${getErrorMessage(err)}`));
            console.error(startupError('Cannot proceed without fee cache for fill processing. Aborting.'));
            process.exit(1);
        }

        if (shouldAnnounceLauncher) {
            console.log(`Number active bots: ${activeCount}`);
            if (activeCount > 0) {
                console.log('Active bots:');
                for (const entry of prepared) {
                    if (!entry.active) {
                        continue;
                    }
                    const botName = String(entry.name || entry.botKey || 'unnamed');
                    console.log(`  - ${colorStartupActiveBotName(botName)}`);
                }
            }
            console.log();
            console.log('Starting bot runtime...');
        }

        // Phase 5: Atomic startup — pre-register all bot allocations before any bot starts.
        // This ensures proportional fund allocation is computed correctly for shared accounts.
        const activeBots = prepared.filter((e: any) => e.active);
        const accountGroups: Record<string, any[]> = {};
        for (const entry of activeBots) {
            const account = entry.preferredAccount;
            if (account) {
                if (!accountGroups[account]) accountGroups[account] = [];
                accountGroups[account].push(entry);
            }
        }
        const sharedAccounts = Object.keys(accountGroups).filter((a) => accountGroups[a].length > 1);
        if (sharedAccounts.length > 0) {
            console.log(`Shared accounts detected: ${sharedAccounts.join(', ')} — pre-registering fund allocations atomically.`);
            // Phase 5a: Collect all unique collateral asset refs and resolve them in bulk
            const allCollateralRefs = new Set<string>();
            for (const entry of activeBots) {
                if (entry.debtPolicy?.lending && (entry.preferredAccount && accountGroups[entry.preferredAccount]?.length > 1)) {
                    for (const item of entry.debtPolicy.lending) {
                        if (item.collateralAsset) allCollateralRefs.add(item.collateralAsset);
                    }
                }
            }
            if (allCollateralRefs.size > 0) {
                await Promise.all([...allCollateralRefs].map(ref => _resolveCollateralAssetId(ref)));
            }

            for (const account of sharedAccounts) {
                for (const entry of accountGroups[account]) {
                    const botName = entry.botKey;
                    if (botName && entry.botFunds) {
                        const sides = ['buy', 'sell'] as const;
                        for (const side of sides) {
                            const pct = entry.botFunds[side];
                            if (pct !== undefined && pct !== null) {
                                await fundRegistry.registerAllocation(account, botName, side, pct);
                            }
                        }
                    }

                    // Register credit/MPA collateral allocations
                    if (botName && entry.debtPolicy?.lending) {
                        const dp = entry.debtPolicy;
                        const globalPct = dp.maxCollateralAmount ?? '100%';
                        for (const item of dp.lending) {
                            const collateralRef = item.collateralAsset;
                            if (!collateralRef) continue;
                            const collateralAssetId = _collateralAssetIdCache.get(collateralRef) ?? null;
                            if (!collateralAssetId) {
                                console.error(`  ERROR: unable to resolve collateral asset '${collateralRef}' for credit bot ${botName}. Credit bot will run WITHOUT proportional allocation. Check chain connectivity and asset configuration.`);
                                continue;
                            }
                            await fundRegistry.registerCollateralAllocation(account, botName, collateralAssetId, globalPct);
                        }
                    }
                }
            }
        }

        const instances: any[] = [];
        for (const entry of prepared) {
            if (!entry.active) {
                continue;
            }

            const botCleanupName = `Bot: ${entry.name || entry.botKey || instances.length + 1}`;
            let bot: any = null;
            let botCleanupHandler: (() => Promise<void>) | null = null;
            try {
                bot = new DEXBot(entry);
                botCleanupHandler = () => bot.shutdown();
                registerCleanup(botCleanupName, botCleanupHandler);
                await bot.start(masterPassword);
                clearBotStartRetry(botRetryKey(entry));
                instances.push(bot);
            } catch (err: any) {
                // The bot's _runStartupSequence already invoked shutdown() once on
                // the failure path. Remove the registered cleanup so the LIFO
                // cleanup loop in graceful_shutdown.ts does not call shutdown() a
                // second time, and avoid the "double graceful shutdown" log pattern.
                if (botCleanupHandler) {
                    unregisterCleanup(botCleanupHandler);
                }
                // Attempt graceful cleanup before continuing. Idempotent via the
                // _shuttingDown guard, so a redundant call is a no-op.
                if (bot) {
                    try {
                        await bot.shutdown();
                    } catch (shutdownErr: any) {
                        console.error(startupError(`Error during cleanup: ${getErrorMessage(shutdownErr)}`));
                    }
                }
                if (chainKeys.isMasterPasswordFailure(err)) {
                    printMasterPasswordFailure(err);
                    process.exit(1);
                    return;
                }
                console.error(startupError(`Failed to start bot: ${getErrorMessage(err)}`));
                if (err && getErrorMessage(err) && String(getErrorMessage(err)).toLowerCase().includes('marketprice')) {
                    console.info('Hint: startPrice could not be derived.');
                    console.info(` - If using ${PROFILES_BOTS_FILE} with "pool" or "book" signals, ensure the chain contains a matching liquidity pool or order book for the configured pair.`);
                    console.info(` - Alternatively, set a numeric \`startPrice\` directly in ${PROFILES_BOTS_FILE} for this bot to avoid auto-derive.`);
                    console.info(' - You can also set LIVE_BOT_NAME or BOT_NAME to select a different bot from the profiles settings.');
                }
                scheduleBotStartRetry(entry, { forceDryRun, reason: getErrorMessage(err) });
            }
        }

        if (instances.length === 0) {
            console.log('No active bots were started. Check bots.json and ensure at least one bot is active.');
            return instances;
        }

        if (shouldAnnounceLauncher) {
            printStartLauncherSuccess({ botName: launcherBotName, dryRun: launcherDryRun });
        }

        return instances;
    } finally {
        setSuppressConnectionLog(false);
    }
}

/**
 * Start a specific bot by name or all active bots if no name provided.
 * Looks up the bot in profiles/bots.json and starts it.
 * @param {string|null|undefined} botName - Name of the bot to start, or null/undefined for all active
 * @param {Object} [options] - Start options
 * @param {boolean} [options.dryRun=false] - Run in dry-run mode (no broadcasts)
 */
async function startBotByName(botName: string | null | undefined, { dryRun = false }: { dryRun?: boolean } = {}) {
    if (!botName) {
        return runDefaultBots({
            forceDryRun: dryRun,
            sourceName: dryRun ? 'CLI drystart (all)' : 'CLI start (all)',
            launcherStyle: { botName: null, dryRun },
        });
    }
    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = resolveRawBotEntries(config);
    if (!entries.length) {
        console.error(startupError('No bot definitions exist in the tracked settings.'));
        process.exit(1);
    }
    const match = entries.find((b: any) => isSameBotName(b.name, botName));
    if (!match) {
        console.error(startupError(`Could not find any bot named '${botName}' in the tracked settings.`));
        process.exit(1);
    }
    const entryCopy = JSON.parse(JSON.stringify(match));
    entryCopy.active = true;
    if (dryRun) entryCopy.dryRun = true;
    const normalized = normalizeBotEntries([entryCopy]);
    await runBotInstances(normalized, {
        forceDryRun: dryRun,
        sourceName: dryRun ? 'CLI drystart' : 'CLI start',
        launcherStyle: { botName, dryRun },
    });
}

/**
 * Mark a bot (or all bots) as active/inactive in profiles/bots.json.
 * Note: This only updates the config file; running processes must be
 * started/stopped separately (e.g. `dexbot start <bot>`).
 * @param {string|null|undefined} botName - Name of the bot, or null/undefined for all
 * @param {boolean} active - Target active state (true = enable, false = disable)
 */
async function setBotActiveState(botName: string | null | undefined, active: boolean) {
    const { config, filePath } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = resolveRawBotEntries(config);
    const action = active ? 'enable' : 'disable';
    const inWord = active ? 'active' : 'inactive';
    const outWord = active ? 'inactive' : 'active';
    if (!botName) {
        let updated = false;
        entries.forEach((entry: any) => {
            const effectiveActive = entry.active !== false;
            if (effectiveActive !== active) {
                entry.active = active;
                updated = true;
            }
        });
        if (!updated) {
            console.log(`No ${outWord} bots were found to ${action}.`);
            return;
        }
        saveSettingsFile(config, filePath);
        console.log(`Marked all bots ${inWord} in ${path.basename(filePath)}.`);
        return;
    }
    const match = entries.find((b: any) => isSameBotName(b.name, botName));
    if (!match) {
        console.error(startupError(`Could not find any bot named '${botName}' to ${action}.`));
        process.exit(1);
    }
    if ((match.active !== false) === active) {
        console.log(`Bot '${botName}' is already ${inWord}.`);
        return;
    }
    match.active = active;
    saveSettingsFile(config, filePath);
    const markedMessage = `Marked '${botName}' ${inWord} in ${path.basename(filePath)}.`;
    if (active) {
        console.log(markedMessage + ` Start it using 'dexbot start ${botName}'.`);
    } else {
        console.log(markedMessage);
    }
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
 * @param {string|null|undefined} botName - Name of the bot to reset, or null/undefined for all active
 */
async function resetBotByName(botName: string | null | undefined) {
    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = normalizeBotEntries(resolveRawBotEntries(config));

    // Filter targets
    const targets = botName ? entries.filter((b: any) => isSameBotName(b.name, botName)) : entries.filter((b: any) => b.active);
    if (botName && targets.length === 0) {
        console.error(startupError(`Could not find any bot named '${botName}' to reset.`));
        process.exit(1);
    }

    console.log(`Setting regeneration trigger for ${targets.length} ${targets.length === 1 ? 'bot' : 'bots'}...`);

    for (const bot of targets) {
        try {
            const triggerFile = getRecalculateTriggerFile(bot.botKey);
            storage.writeFile(triggerFile, '');
            console.log(startupSuccess(`✓ Trigger set for '${bot.name}' (${path.basename(triggerFile)})`));
        } catch (err: any) {
            console.warn(`Failed to set trigger for '${bot.name}': ${getErrorMessage(err)}`);
        }
    }

    console.log();
    console.log(startupSuccess('Action complete.'));
    console.log('- If the bot is running (CLI or PM2), it will detect the trigger and reset automatically.');
    console.log('- If the bot is stopped, the grid will be regenerated the next time you run `dexbot test`.');
}

/**
 * Export bot trading history and settings to CSV/JSON for local analysis/
 * @param {string|undefined} botName - Bot name; may be undefined from CLI when no target provided to export
 */
async function exportBotTrades(botName: string | undefined) {
    if (!botName) {
        console.error(startupError('Please specify a bot name: dexbot export <bot>'));
        process.exit(1);
    }

    try {
        const exporter = require('./modules/order/export');

        // Load bots configuration
        const { config: botsData } = loadSettingsFile(PROFILES_BOTS_FILE);
        const bot = resolveRawBotEntries(botsData).find((b: any) => isSameBotName(b.name, botName));

        if (!bot) {
            console.error(startupError(`Bot '${botName}' not found in ${PROFILES_BOTS_FILE}`));
            process.exit(1);
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Exporting bot: ${botName}`);
        console.log(`${'='.repeat(60)}\n`);

        // Create bot key from bot name (lowercase, replace spaces with hyphens)
        const botKey = botName.toLowerCase().replace(/\s+/g, '-');

        // Export trades and settings
        const result = await exporter.exportBotTrades(botKey, bot, path.join(PATHS.PROFILES_DIR, 'exports'));

        if (result.success) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(startupSuccess(`✓ Export successful!`));
            console.log(`${'='.repeat(60)}`);
            console.log(`Bot:              ${botName}`);
            console.log(`Trades exported:  ${result.trades_exported}`);
            console.log(`CSV file:         ${result.csv_path}`);
            console.log(`Settings file:    ${result.settings_path}`);
            console.log(`Output directory: ${result.output_dir}`);
            console.log(`Timestamp:        ${result.timestamp}`);
            console.log(`\nYou can now inspect these files locally (see analysis/ for trade tooling).\n`);
        } else {
            console.error(startupError(`\n✗ Export failed: ${result.error || 'Unknown error'}\n`));
            process.exit(1);
        }
    } catch (err: any) {
        console.error(startupError(`\nExport error: ${getErrorMessage(err)}\n`));
        process.exit(1);
    }
}

/**
 * Parse and execute CLI commands.
  * Supported commands: test, drystart, reset, default, disable, enable, key, bot, pm2, update, export, order, credit, tv, clear, status, whitelist, unlock, help
 * @returns {Promise<boolean>} True if a command was handled, false otherwise
 */
async function handleCLICommands() {
    if (!cliArgs.length) return false;
    const [rawCommand, target] = cliArgs;
    const command = COMMAND_ALIASES[rawCommand] ?? rawCommand;
    if (!CLI_COMMANDS.includes(command)) {
        console.error(startupError(`Unknown command '${command}'.`));
        printCLIUsage();
        process.exit(1);
    }
    switch (command) {
        case 'test':
            await startBotByName(target, { dryRun: false });
            return true;
        case 'drystart':
            await startBotByName(target, { dryRun: true });
            return true;
        case 'reset':
            if (!target) {
                console.error('Error: Target required. Specify "all" or a bot name.');
                printCLIUsage();
                process.exit(1);
            }
            await resetBotByName(target === 'all' ? null : target);
            process.exit(0);
        case 'default': {
            const { spawnSync } = require('child_process') as any as any;
            const resetScript = path.join(PATHS.PROJECT_ROOT, 'scripts', 'reset-settings.sh');
            const scriptEnv = {
                ...process.env,
                DEXBOT_PROFILE_ROOT: PATHS.PROFILES_DIR,
                DEXBOT_MARKET_ADAPTER_DATA_DIR: PATHS.MARKET_ADAPTER.DATA_DIR,
                DEXBOT_MARKET_ADAPTER_STATE_DIR: PATHS.MARKET_ADAPTER.STATE_DIR,
                DEXBOT_CLAW_DATA_DIR: PATHS.CLAW.DATA_DIR,
            };
            const result = spawnSync('bash', [resetScript], {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
                env: scriptEnv,
            });
            if (result.error) {
                console.error(`default: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'disable':
            if (!target) {
                console.error('Error: Target required. Specify "all" or a bot name.');
                printCLIUsage();
                process.exit(1);
            }
            await setBotActiveState(target === 'all' ? null : target, false);
            process.exit(0);
        case 'enable':
            if (!target) {
                console.error('Error: Target required. Specify "all" or a bot name.');
                printCLIUsage();
                process.exit(1);
            }
            await setBotActiveState(target === 'all' ? null : target, true);
            process.exit(0);
        case 'key':
            await runAccountManager({ exitAfter: true });
            return true;
         case 'bot':
             setSuppressConnectionLog(true);
             try {
                 await accountBots.main();
             } finally {
                 try {
                     disconnectClient();
                  } catch (err: any) {
                      console.warn('Failed to disconnect BitShares after bot helper exit:', err && getErrorMessage(err) ? getErrorMessage(err) : err);
                  }
             }
             process.exit(0);
             return true;
        case 'pm2': {
            const { spawnSync } = require('child_process') as any as any;
            // Forward the remaining CLI args to pm2.js so subcommands work
            // (`dexbot pm2 stop <bot>`, `dexbot pm2 restart all`, `dexbot pm2
            // help`...). Previously the subcommand was silently dropped and the
            // full-setup path ran, so `dexbot pm2 start X` started ALL bots and
            // `dexbot pm2 stop X` no-oped into a full setup.
            // buildRuntimeScriptArgs resolves the pm2 entry point under the
            // dist-only runtime layout (dist/pm2.js); plain node executes
            // compiled entries since the tsx removal.
            const pm2Args = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['pm2'],
                scriptArgs: cliArgs.slice(1),
            });
            const result = spawnSync(Config.EXEC_PATH, pm2Args, {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
            });
            if (result.error) {
                console.error(`pm2: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'update':
            setSuppressConnectionLog(true);
            require('./scripts/update');
            return true;
        case 'export':
            setSuppressConnectionLog(true);
            await exportBotTrades(target);
            process.exit(0);
            return true;
        case 'whitelist': {
            const { spawnSync } = require('child_process') as any as any;
            const scriptArgs = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['scripts', 'generate_market_adapter_whitelist'],
                scriptArgs: cliArgs.slice(1),
            });
            const result = spawnSync(Config.EXEC_PATH, scriptArgs, {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
            });
            if (result.error) {
                console.error(`whitelist: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'order': {
            const { spawnSync } = require('child_process') as any as any;
            const scriptArgs = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['scripts', 'analyze-orders'],
                scriptArgs: cliArgs.slice(1),
            });
            const result = spawnSync(Config.EXEC_PATH, scriptArgs, {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
            });
            if (result.error) {
                console.error(`order: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'credit': {
            const { spawnSync } = require('child_process') as any as any;
            const scriptArgs = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['scripts', 'analyze-credit'],
                scriptArgs: cliArgs.slice(1),
            });
            const result = spawnSync(Config.EXEC_PATH, scriptArgs, {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
            });
            if (result.error) {
                console.error(`credit: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'tv': {
            const { spawnSync } = require('child_process') as any as any;
            const scriptArgs = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['scripts', 'tv'],
                scriptArgs: cliArgs.slice(1),
            });
            const result = spawnSync(Config.EXEC_PATH, scriptArgs, {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
            });
            if (result.error) {
                console.error(`tv: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'unlock': {
            const { spawnSync } = require('child_process') as any as any;
            // buildRuntimeScriptArgs resolves the unlock entry point for the
            // active runtime layout: dist/unlock.js when compiled, unlock.ts
            // in source layouts. A hard-coded dist path silently no-ops
            // (ENOENT -> exit 0), hiding the launcher.
            const unlockArgs = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['unlock'],
                scriptArgs: cliArgs.slice(1),
            });
            const result = spawnSync(Config.EXEC_PATH, unlockArgs, {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
            });
            process.exit(result.status ?? 0);
            return true;
        }
        case 'clear':
        case 'clear-orders':
        case 'clear-market-adapter':
        case 'clear-all': {
            const { spawnSync } = require('child_process') as any as any;
            const scriptMap: Record<string, string> = {
                clear: 'clear-logs.sh',
                'clear-orders': 'clear-orders.sh',
                'clear-market-adapter': 'clear-market-adapter.sh',
                'clear-all': 'clear-all.sh',
            };
            const scriptName = scriptMap[command];
            const scriptPath = path.join(PATHS.PROJECT_ROOT, 'scripts', scriptName);
            const scriptEnv = {
                ...process.env,
                DEXBOT_PROFILE_ROOT: PATHS.PROFILES_DIR,
                DEXBOT_MARKET_ADAPTER_DATA_DIR: PATHS.MARKET_ADAPTER.DATA_DIR,
                DEXBOT_MARKET_ADAPTER_STATE_DIR: PATHS.MARKET_ADAPTER.STATE_DIR,
                DEXBOT_CLAW_DATA_DIR: PATHS.CLAW.DATA_DIR,
            };
            const result = spawnSync('bash', [scriptPath], {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
                env: scriptEnv,
            });
            if (result.error) {
                console.error(`${command}: ${result.error.message}`);
                process.exit(1);
            }
            process.exit(result.status ?? 0);
            return true;
        }
        case 'status': {
            console.log(`DEXBot2 v${Config.VERSION}`);
            console.log();
            const { spawnSync, execSync } = require('child_process') as any as any;
            const MONOLITHIC_PID_FILE = PATHS.PROFILES.MONOLITHIC_PID;
            const MONOLITHIC_CRED_PID_FILE = PATHS.PROFILES.MONOLITHIC_CRED_PID;
            const SUPERVISOR_SOCK = PATHS.PROFILES.SUPERVISOR_SOCK;
            let unlockRunning = false;

            if (storage.exists(MONOLITHIC_PID_FILE)) {
                try {
                    const pid = Number(storage.readFile(MONOLITHIC_PID_FILE).trim());
                    if (Number.isInteger(pid) && pid > 0) {
                        try { process.kill(pid, 0); unlockRunning = true; } catch (err: any) {
                            if (err.code === 'EACCES') {
                                console.warn('[dexbot]', `process.kill(${pid}, 0) EACCES — process exists but permission denied`);
                                unlockRunning = true;
                            } else if (err.code !== 'ESRCH') {
                                console.warn('[dexbot]', `process.kill(${pid}, 0) unexpected error: ${getErrorMessage(err)}`);
                            }
                        }
                    }
                } catch (_) {}
            }

            if (!unlockRunning && storage.exists(SUPERVISOR_SOCK)) {
                unlockRunning = true;
            }

            // A credential daemon can outlive a `dexbot stop` (bots + market
            // adapter stop; the daemon stays up for fast re-unlock). Report it
            // too, so `stat` does not show "No DEXBot2 processes running." when
            // only the daemon remains.
            if (!unlockRunning && storage.exists(MONOLITHIC_CRED_PID_FILE)) {
                try {
                    const pid = Number(storage.readFile(MONOLITHIC_CRED_PID_FILE).trim());
                    if (Number.isInteger(pid) && pid > 0) {
                        try { process.kill(pid, 0); unlockRunning = true; } catch (err: any) {
                            if (err.code === 'EACCES') unlockRunning = true;
                        }
                    }
                } catch (_) {}
            }

            if (unlockRunning) {
                const unlockArgs = buildRuntimeScriptArgs({
                    codeRoot: __dirname,
                    scriptSegments: ['unlock'],
                    scriptArgs: ['status'],
                });
                const result = spawnSync(Config.EXEC_PATH, unlockArgs, {
                    cwd: PATHS.PROJECT_ROOT,
                    stdio: 'inherit',
                });
                process.exit(result.status ?? 0);
                return true;
            }

            try {
                const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).toString().trim();
                const jsonStart = output.indexOf('[');
                if (jsonStart === -1) {
                    console.log('No DEXBot2 processes running.');
                    process.exit(0);
                    return true;
                }

                const allProcs = JSON.parse(output.slice(jsonStart));
                if (!Array.isArray(allProcs) || allProcs.length === 0) {
                    console.log('No DEXBot2 processes running.');
                    process.exit(0);
                    return true;
                }

                const serviceNames = new Set(['dexbot-cred', 'dexbot-adapter', 'dexbot-update']);
                const botNames = new Set<string>();
                try {
                    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
                    const entries = resolveRawBotEntries(config);
                    for (const b of entries) {
                        if (b.name) botNames.add(b.name);
                    }
                } catch (_) {}

                const dexbotProcs = allProcs.filter((p: any) => {
                    const name = String(p?.name || '');
                    return serviceNames.has(name) || botNames.has(name);
                });

                if (dexbotProcs.length === 0) {
                    console.log('No DEXBot2 processes running.');
                    process.exit(0);
                    return true;
                }

                console.log('='.repeat(50));
                console.log('DEXBot2 PM2 Processes');
                console.log('='.repeat(50));
                console.log('');

                const fmtUptime = (p: any) => {
                    if (!p?.pm2_env?.pm_uptime) return '-';
                    const ms = Date.now() - new Date(p.pm2_env.pm_uptime).getTime();
                    const s = Math.floor(Math.abs(ms) / 1000);
                    if (s < 60) return `${s}s`;
                    const m = Math.floor(s / 60);
                    if (m < 60) return `${m}m ${s % 60}s`;
                    const h = Math.floor(m / 60);
                    if (h < 24) return `${h}h ${m % 60}m`;
                    const d = Math.floor(h / 24);
                    return `${d}d ${h % 24}h`;
                };

                const fmtMem = (p: any) => {
                    const bytes = p?.monit?.memory;
                    if (!bytes || bytes <= 0) return '-';
                    if (bytes < 1024) return `${bytes}B`;
                    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
                    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
                };

                const rows = dexbotProcs.map((p: any) => ({
                    pid: String(p?.pid || '-'),
                    name: String(p?.name || '-'),
                    status: String(p?.pm2_env?.status || '-'),
                    uptime: fmtUptime(p),
                    mem: fmtMem(p),
                }));

                const nameWidth = Math.max(...rows.map(r => r.name.length), 4);
                const statusWidth = Math.max(...rows.map(r => r.status.length), 6);
                const header = `${'PID'.padEnd(8)} ${'NAME'.padEnd(nameWidth)} ${'STATUS'.padEnd(statusWidth)} ${'UPTIME'.padEnd(12)} ${'MEMORY'}`;
                console.log(header);
                console.log('-'.repeat(header.length));
                for (const r of rows) {
                    console.log(`${r.pid.padEnd(8)} ${r.name.padEnd(nameWidth)} ${r.status.padEnd(statusWidth)} ${r.uptime.padEnd(12)} ${r.mem}`);
                }
            } catch {
                console.log('No DEXBot2 processes running.');
            }
            process.exit(0);
            return true;
        }
        case 'delete':
        case 'stop':
        case 'restart':
        case 'reload': {
            const { spawnSync } = require('child_process') as any as any;
            const unlockArgs = buildRuntimeScriptArgs({
                codeRoot: __dirname,
                scriptSegments: ['unlock'],
                scriptArgs: [command, ...cliArgs.slice(1)],
            });
            const result = spawnSync(Config.EXEC_PATH, unlockArgs, {
                cwd: PATHS.PROJECT_ROOT,
                stdio: 'inherit',
            });
            process.exit(result.status ?? 0);
            return true;
        }
        case 'help':
            printCLIUsage();
            process.exit(0);
        default:
            printCLIUsage();
            process.exit(1);
    }
}

/**
 * Run all bots marked as active in settings.
 * @param {Object} [options={}] - Run options.
 * @param {boolean} [options.forceDryRun=false] - Force dry-run mode.
 * @param {string} [options.sourceName='settings'] - Source label.
 * @param {Object} [options.launcherStyle=null] - Launcher presentation options.
 * @returns {Promise<void>}
 */
async function runDefaultBots({ forceDryRun = false, sourceName = 'settings', launcherStyle }: { forceDryRun?: boolean; sourceName?: string; launcherStyle?: any } = {}) {
    const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
    const entries = resolveRawBotEntries(config);
    const normalized = normalizeBotEntries(entries);

    // Validate all profile files at startup (skip for PM2 child processes and tests)
    if (!Config.DEXBOT_SKIP_PROFILE_VALIDATION && !Config.PM2_HOME) {
        const { validateAllProfiles, printValidationProblems } = require('./modules/validate_profiles');
        const result = validateAllProfiles();
        const ok = printValidationProblems(result);
        if (!ok) {
            console.error(startupError('Fix the configuration errors above and restart.'));
            process.exit(1);
        }
    }

    await runBotInstances(normalized, { forceDryRun, sourceName, launcherStyle });
}

/**
 * Main application entry point for DEXBot2 CLI.
 * Handles initial setup, command routing, and starting active bots.
 * @returns {Promise<void>}
 */
async function bootstrap() {
    // Ensure profiles directory exists
    let isNewSetup = false;
    try {
        isNewSetup = ensureProfilesDirectory(PROFILES_DIR);
    } catch (err: any) {
        if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
            const { spawnSync: respawn } = require('child_process') as any as any;
            const fallbackDir = getHomeProfilesDir();
            console.log(`Config directory not writable at: ${PROFILES_DIR}`);
            console.log(`Auto-using ${fallbackDir} instead. Set DEXBOT_PROFILE_ROOT to override.\n`);
            const newEnv = { ...process.env, DEXBOT_PROFILE_ROOT: fallbackDir };
            const respawnResult = respawn(Config.EXEC_PATH, [__filename, ...process.argv.slice(2)], {
                stdio: 'inherit',
                env: newEnv,
            });
            if (respawnResult.error) {
                console.error(`Respawn failed: ${respawnResult.error.message}`);
                process.exit(1);
            }
            process.exit(respawnResult.status ?? 0);
            return;
        }
        throw err;
    }

    // Handle CLI commands early — commands like 'update' must work even
    // when profiles/ was just cleaned (isNewSetup = true), otherwise the
    // new-setup wizard would block them before the CLI handler is reached.
    if (await handleCLICommands()) return;

    // If this is a new setup, prompt to set up keys
    if (isNewSetup) {
        // Suppress BitShares connection log during first-time setup
        setSuppressConnectionLog(true);
        console.log();
        console.log('='.repeat(50));
        console.log('Welcome to DEXBot2!');
        console.log('='.repeat(50));
        console.log();

        // Generate default general.settings.json for new installations
        const SETTINGS_FILE = path.join(PROFILES_DIR, 'general.settings.json');
        const {
            LOG_LEVEL, GRID_LIMITS, TIMING, UPDATER, NODE_MANAGEMENT,
            MARKET_ADAPTER, DEFAULT_CONFIG, FILL_PROCESSING,
            PIPELINE_TIMING, CREDENTIAL_PROMPTS, MAINTENANCE,
            COW_PERFORMANCE, INCREMENT_BOUNDS, FEE_PARAMETERS,
            API_LIMITS, LOGGING_CONFIG, NATIVE_CLIENT, LAUNCHER, ANCHOR,
        } = require('./modules/constants');
const { writeJSON } = storage;

        // Create NODES config from NODE_MANAGEMENT constants
        const nodesConfig = {
            enabled: NODE_MANAGEMENT.DEFAULT_ENABLED,
            list: NODE_MANAGEMENT.DEFAULT_NODES,
            healthCheck: {
                enabled: true,
                intervalMs: NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS,
                timeoutMs: NODE_MANAGEMENT.HEALTH_CHECK_TIMEOUT_MS,
                maxPingMs: NODE_MANAGEMENT.MAX_PING_MS,
                blacklistThreshold: NODE_MANAGEMENT.BLACKLIST_THRESHOLD
            },
            selection: {
                strategy: NODE_MANAGEMENT.SELECTION_STRATEGY,
                preferredNode: null
            }
        };

        const defaultSettings = {
            LOG_LEVEL,
            NODES: nodesConfig,
            GRID_LIMITS: { ...GRID_LIMITS },
            TIMING: { ...TIMING },
            UPDATER: { ...UPDATER },
            MARKET_ADAPTER: { ...MARKET_ADAPTER },
            DEFAULT_CONFIG: { ...DEFAULT_CONFIG },
            FILL_PROCESSING: { ...FILL_PROCESSING },
            PIPELINE_TIMING: { ...PIPELINE_TIMING },
            CREDENTIAL_PROMPTS: { ...CREDENTIAL_PROMPTS },
            MAINTENANCE: { ...MAINTENANCE },
            COW_PERFORMANCE: { ...COW_PERFORMANCE },
            INCREMENT_BOUNDS: { ...INCREMENT_BOUNDS },
            FEE_PARAMETERS: { ...FEE_PARAMETERS },
            API_LIMITS: { ...API_LIMITS },
            LOGGING_CONFIG: { ...LOGGING_CONFIG },
            NATIVE_CLIENT: { ...NATIVE_CLIENT },
            LAUNCHER: { ...LAUNCHER },
            ANCHOR: { ...ANCHOR },
        };
        writeJSON(SETTINGS_FILE, defaultSettings);
        console.log(startupSuccess('✓ Created default general.settings.json'));
        console.log();

        console.log('To get started, you need to configure your master password.');
        console.log('This password will encrypt your private keys.');
        console.log();
        const setupKeysAnswer = (await readInput('Set up master password now? [y/N]: ')).trim().toLowerCase();
        const setupKeys = setupKeysAnswer === 'y' || setupKeysAnswer === 'yes';
        if (setupKeys) {
            console.log();
            await chainKeys.main();
            console.log();
            console.log(startupSuccess('Master password configured! Now you can:'));
            console.log('  dexbot bot   - Create and manage bots');
            console.log('  dexbot        - Run your configured bots');
            console.log();
        } else {
            console.log();
            console.log('You can set up your master password later by running:');
            console.log('  dexbot key');
            console.log();
        }
        return;
    }

    // Check if bots.json exists - if not, guide user
    if (!storage.exists(PROFILES_BOTS_FILE)) {
        // Suppress BitShares connection log when no bots configured
        setSuppressConnectionLog(true);
        console.log();
        console.log('No bot configuration found.');
        console.log();
        console.log('First, set up your master password:');
        console.log('  dexbot key');
        console.log();
        console.log('Then, create your first bot:');
        console.log('  dexbot bot');
        console.log();
        process.exit(0);
    }

    await runDefaultBots();
}

function handleFatalBootstrapError(err: any) {
    if (chainKeys.isMasterPasswordFailure(err)) {
        printMasterPasswordFailure(err);
        process.exit(1);
        return;
    } else if (err && getErrorMessage(err)) {
        console.error(getErrorMessage(err));
    } else {
        console.error(err);
    }

    try {
        disconnectClient();
    } catch (disconnectErr) {
    }

    process.exit(1);
}

bootstrap().catch(handleFatalBootstrapError);
export {};

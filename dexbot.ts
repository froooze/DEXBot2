#!/usr/bin/env node

import { getErrorMessage, getErrorCode } from './modules/utils/errors.js';
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
 * `dexbot help` is the single source of truth (grouped one-liners below;
 * `dexbot --cli-examples` prints curated snippets):
 *
 * Runtime:   dexbot start [bot] | stop | reload | restart | delete | status | pm2
 * Trading:   dexbot test <bot> | drystart <bot> | reset {all|<bot>}
 * Config:    dexbot bot | key | enable {all|<bot>} | disable {all|<bot>} | default | update
 * Analysis:  dexbot order [<bot>] | export <bot> | credit [<bot>] | rich <asset...>
 *            dexbot tv <target> | dw <target> | liquid <target> | pnl <account>
 *            dexbot asset <bts|symbol> (shorthand: dexbot a <bts|symbol>)
 * Files:     dexbot clear | clear-orders | clear-market-adapter | clear-all
 *
 * NPM SCRIPTS (alternative invocation):
 *   npm run pm2:start                - Unlock + start bots via PM2 (alias of pm2:unlock)
 *   npm run pm2:stop                 - Stop all dexbot PM2 processes via the launcher
 *   npm run pm2:unlock               - Run dist/pm2.js (authenticate + generate config + start all)
 *   npm run pm2:claw-only            - Run dist/pm2.js claw-only
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
    // The collateral ref is free-text input from the fund-registration flow
    // ("tokena" resolves on the chain without error). Canonicalize before the
    // lookup AND before the cache key, so one asset never occupies two slots.
    const key = normalizeAssetRef(ref);
    if (_collateralAssetIdCache.has(key)) return _collateralAssetIdCache.get(key) ?? null;
    let result: string | null = null;
    try {
        if (key.startsWith('1.3.')) {
            result = key;
        } else if (key) {
            const res = await BitShares.db.lookup_asset_symbols([key]);
            if (res && res[0] && res[0].id) result = String(res[0].id);
        }
    } catch (_err) {
        result = null;
    }
    _collateralAssetIdCache.set(key, result);
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
const { buildRuntimeScriptPath, runRuntimeScript } = require('./modules/launcher/runtime_entry');
const { parseWorkerArgs, LAUNCHER_WORKER_COMMAND } = require('./modules/launcher/launch_modes');
const { detectRuntimeMode, runtimeControlHelp, runtimeModeLabel, checkStatusTarget, resolveStatusRoute } = require('./modules/launcher/runtime_mode');
const { PATHS, getHomeProfilesDir, getRecalculateTriggerFile, printRelocationNotices } = require('./modules/paths');
const credentialPolicy = require('./modules/credential_policy');
const { Config } = require('./modules/config');
const { isSameBotName } = require('./modules/utils/sanitize_key');
const { normalizeAssetRef } = require('./modules/utils/asset_symbols');
import type { BotEntry } from './modules/bot_settings.js';
import type { Pm2Proc, RuntimeHelpEntry, RuntimeInfo } from './modules/launcher/runtime_mode.js';

interface LauncherStyle {
    botName?: string | null;
    dryRun?: boolean;
}

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

const CLI_COMMANDS = ['start', 'test', 'reset', 'default', 'disable', 'enable', 'drystart', 'key', 'bot', 'pm2', 'update', 'export', 'order', 'credit', 'rich', 'tv', 'dw', 'liquid', 'pnl', 'asset', 'git', 'clear', 'clear-orders', 'clear-market-adapter', 'clear-all', 'status', 'unlock', 'delete', 'stop', 'restart', 'reload', 'help'];
const COMMAND_ALIASES: Record<string, string> = { orders: 'order', keys: 'key', bots: 'bot', stat: 'status', stats: 'status', start: 'unlock', defaults: 'default', stp: 'stop', stopall: 'stop', restartall: 'restart', reloadall: 'reload', liq: 'liquid', liqu: 'liquid', liquidity: 'liquid', a: 'asset' };
const CLI_HELP_FLAGS = ['-h', '--help'];
const CLI_EXAMPLES_FLAG = '--cli-examples';
const CLI_EXAMPLES = [
    { title: 'Run a bot live', command: 'dexbot test <bot>', notes: 'Runs the named entry in profiles/bots.json once.' },
    { title: 'Dry-run a bot', command: 'dexbot drystart <bot>', notes: 'Same as test, but never broadcasts.' },
    { title: 'Reset every grid', command: 'dexbot reset all', notes: 'Pass a bot name to reset just one.' },
    { title: 'Manage keys', command: 'dexbot key', notes: 'Set up the master password and keyring.' },
    { title: 'Edit bot config', command: 'dexbot bot', notes: 'Interactive bots.json editor.' },
    { title: 'Start bots with PM2', command: 'dexbot pm2', notes: 'Generate the ecosystem config and start PM2.' },
    { title: 'Update DEXBot2', command: 'dexbot update', notes: 'Pull, install, and restart active bots.' },
    { title: 'Export bot trades', command: 'dexbot export <bot>', notes: 'Write trades and settings to CSV/JSON.' },
    { title: 'Analyze order grids', command: 'dexbot order', notes: 'Spread, increment, and funds; --export for HTML.' },
    { title: 'Show live credit positions', command: 'dexbot credit', notes: 'Summed MPA + borrowed-credit positions per bot.' },
    { title: 'Asset rich list', command: 'dexbot rich <asset> [<asset...>]', notes: 'Top holder(s) per asset from the chain asset holders API.' },
    { title: 'Chart a bot, pool, or pair', command: 'dexbot tv <bot|pool|AssetA/AssetB> --month 3', notes: 'OHLC chart; pool = id (133) or pool token (LP share asset); --feed charts MPA price-feed history.' },
    { title: 'Liquidity depth chart', command: 'dexbot liquid <bot|pool|AssetA/AssetB>', notes: 'Order-book + AMM pool cumulative depth; pool = id or pool token (aliases: liq, liqu, liquidity).' },
    { title: 'Asset supply distribution', command: 'dexbot a bts', notes: 'Where BTS sits (collateral, pools, locks, residual) + HTML report. A bare symbol (dexbot a <symbol>) covers an issued asset; canonical: asset.' },
    { title: 'PnL report', command: 'dexbot pnl <bot|account> --month 3 [--pair BASE/QUOTE]', notes: 'Self-contained HTML PnL report for the resolved bot or chain account.' }
];

const STARTUP_COLORS = {
    reset: CLI_COLORS.reset,
    ok: CLI_COLORS.brightGreen,
    error: CLI_COLORS.boldRed,
};

function colorStartupOutput(text: string, color: string, stream: { isTTY?: boolean } = process.stdout): string {
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
    // Grouped so the full command set stays scannable; descriptions are one line each
    // and the description column is derived, so alignment never drifts. The
    // Runtime group is phrased for the runtime that is actually up — the
    // detection and the mode→instructions mapping are centralized in
    // modules/launcher/runtime_mode.ts so `help` and `status` agree.
    const runtime: RuntimeInfo = detectRuntimeMode();
    const groups: Array<[string, Array<[string, string]>]> = [
        ['Runtime', runtimeControlHelp(runtime.mode).map((entry: RuntimeHelpEntry) => [entry.command, entry.description] as [string, string])],
        ['Trading', [
            ['test <bot>', 'Run a bot live once.'],
            ['drystart <bot>', 'Run a bot without broadcasting.'],
            ['reset {all|<bot>}', 'Reset grid state (applies now or on next start).'],
        ]],
        ['Config', [
            ['bot', 'Interactive bots.json configurator.'],
            ['key', 'Set up the master password and keyring.'],
            ['enable {all|<bot>}', 'Mark bot(s) active in config.'],
            ['disable {all|<bot>}', 'Mark bot(s) inactive in config.'],
            ['default', 'Reset generated settings to defaults.'],
            ['update', 'Update DEXBot2 and restart active bots.'],
        ]],
        // Ordered by the investigation an operator actually runs: grid state and its
        // data export, then market research, then accounting/chain context. Keep the
        // README "Bot Management" block in the same order so the two cannot drift.
        ['Analysis', [
            ['order [<bot>]', 'Analyze persisted order grids; --export for HTML.'],
            ['export <bot>', 'Export bot trades/settings to CSV/JSON.'],
            ['tv <target>', 'OHLC chart for <bot|pool|AssetA/AssetB> (pool = id or pool token); --month N (default 3), --feed for MPA price-feed history.'],
            ['dw <target>', 'Dynamic-weight research chart; same targets and flags as tv.'],
            ['liquid <target>', 'Liquidity depth chart for <bot|pool|AssetA/AssetB> (pool = id or pool token); --range, --depth, --steps (aliases: liq, liqu, liquidity).'],
            ['pnl <account>', 'HTML PnL report for a bot or account; --month N, optional --pair BASE/QUOTE filter.'],
            ['credit [<bot>]', 'Show live MPA and borrowed-credit positions.'],
            ['asset <bts|symbol>', 'Supply distribution: bts = core asset, bare symbol/id = issued asset; --json, --html (shorthand: a, e.g. dexbot a bts).'],
            ['rich <asset...>', 'Per-asset rich list / top holder; --top N, --json.'],
        ]],
        ['Files', [
            ['clear', 'Delete log files. Stop the runtime first.'],
            ['clear-orders', 'Delete persisted grid state (regenerated on start).'],
            ['clear-market-adapter', 'Delete market adapter data and state.'],
            ['clear-all', 'Delete orders, logs, adapter, and claw data.'],
        ]],
    ];
    const width = Math.max(...groups.flatMap(([, entries]) => entries.map(([cmd]) => cmd.length))) + 2;
    console.log('Usage: dexbot [command] [bot]');
    console.log(`Active runtime: ${runtimeModeLabel(runtime)}`);
    if (runtime.mode === 'none') {
        console.log('  Standard start: dexbot start (monolithic)');
        console.log('  Alternatives:   dexbot start --isolated | dexbot pm2');
    }
    console.log();
    for (const [title, entries] of groups) {
        console.log(`${title}:`);
        for (const [cmd, desc] of entries) {
            console.log(`  ${cmd.padEnd(width)}${desc}`);
        }
    }
    console.log('Runtime flags (dexbot start):');
    console.log(`  ${'--foreground'.padEnd(width)}Watch in the terminal (no auto-restart).`);
    console.log(`  ${'--isolated'.padEnd(width)}One process per bot.`);
    console.log(`  ${'--dryrun'.padEnd(width)}Run without broadcasting.`);
    console.log(`  ${'--headless'.padEnd(width)}Non-interactive unlock (--password-file <path> or DEXBOT_MASTER_PASSWORD).`);
    console.log('Help & options:');
    console.log(`  ${'help, -h, --help'.padEnd(width)}Show this help.`);
    console.log(`  ${'--cli-examples'.padEnd(width)}Print curated CLI snippets.`);
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
    const HELP_OWNING_COMMANDS = new Set(['credit', 'rich', 'tv', 'dw', 'liquid', 'pnl', 'asset']);
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
    constructor(config: BotEntry) {
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
         succeeded = await chainKeys.main();
     } finally {
         if (disconnectAfter) {
             try {
                 disconnectClient();
     } catch (err) {
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
    } catch (err) {
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

function printStartLauncherHeader({ botName = null, dryRun = false }: { botName?: string | null; dryRun?: boolean } = {}): void {
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

function printStartLauncherSuccess({ botName = null, dryRun = false }: { botName?: string | null; dryRun?: boolean } = {}): void {
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

function printMasterPasswordFailure(err: unknown) {
    console.error();
    console.error(startupError(`❌ ${getErrorMessage(err)}`));
}

const BOT_START_RESTART = Object.freeze({ MAX_ATTEMPTS: 3, RETRY_DELAY_MS: 30000 });
const botStartRetryState = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }>();

function botRetryKey(entry: BotEntry | null | undefined): string {
    return String(entry?.name || entry?.botKey || 'unnamed');
}

function clearBotStartRetry(botName: string): void {
    const state = botStartRetryState.get(botName);
    if (state && state.timer) {
        clearTimeout(state.timer);
    }
    botStartRetryState.delete(botName);
}

function scheduleBotStartRetry(entry: BotEntry | null | undefined, { forceDryRun = false, reason = '' }: { forceDryRun?: boolean; reason?: string } = {}): void {
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
            const match = entries.find((b: BotEntry) => isSameBotName(b.name, botName));
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
        } catch (err) {
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
async function runBotInstances(botEntries: BotEntry[], { forceDryRun = false, sourceName = 'settings', launcherStyle }: { forceDryRun?: boolean; sourceName?: string; launcherStyle?: LauncherStyle } = {}) {
    setSuppressConnectionLog(true);

    const shouldAnnounceLauncher = !!launcherStyle;
    const launcherBotName = launcherStyle?.botName || null;
    const launcherDryRun = !!launcherStyle?.dryRun;
    let connectionAnnounced = false;
    let authenticationAnnounced = false;
    const activeCount = (botEntries || []).filter((entry) => entry && entry.active !== false).length;

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

        const prepared = botEntries.map((entry) => ({
            ...entry,
            dryRun: forceDryRun ? true : entry.dryRun,
        }));

        // Note: each bot creates its own AccountOrders instance with per-bot file when it
        // starts and syncs its own meta via syncMeta(). No shared initialization needed here.

        const { errors } = collectValidationIssues(prepared, sourceName);

        if (errors.length) {
            console.error(startupError('ERROR: Invalid configuration for one or more **active** bots:'));
            errors.forEach((e: string) => console.error(startupError(`  - ${e}`)));
            console.error(startupError(`Fix the configuration problems in ${PROFILES_BOTS_FILE} and restart. Aborting.`));
            process.exit(1);
        }

        const needMaster = prepared.some((b) => b.active && b.preferredAccount);
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
            await initializeFeeCache(prepared.filter((b) => b.active), BitShares);
        } catch (err) {
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
        const activeBots = prepared.filter((e) => e.active);
        const accountGroups: Record<string, BotEntry[]> = {};
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
                        if (item.collateralAsset) allCollateralRefs.add(String(item.collateralAsset));
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
                                await fundRegistry.registerAllocation(account, botName, side, Number(pct));
                            }
                        }
                    }

                    // Register credit/MPA collateral allocations
                    if (botName && entry.debtPolicy?.lending) {
                        const dp = entry.debtPolicy;
                        const globalPct = dp.maxCollateralAmount ?? '100%';
                        for (const item of dp.lending || []) {
                            const collateralRef = item.collateralAsset;
                            if (!collateralRef) continue;
                            const collateralAssetId = _collateralAssetIdCache.get(normalizeAssetRef(collateralRef)) ?? null;
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

        const instances: DEXBot[] = [];
        for (const entry of prepared) {
            if (!entry.active) {
                continue;
            }

            const botCleanupName = `Bot: ${entry.name || entry.botKey || instances.length + 1}`;
            let bot: DEXBot | null = null;
            let botCleanupHandler: (() => Promise<void>) | null = null;
            try {
                bot = new DEXBot(entry);
                botCleanupHandler = () => bot!.shutdown();
                registerCleanup(botCleanupName, botCleanupHandler);
                await bot.start(masterPassword);
                clearBotStartRetry(botRetryKey(entry));
                instances.push(bot);
            } catch (err) {
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
                    } catch (shutdownErr) {
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
    const match = entries.find((b: BotEntry) => isSameBotName(b.name, botName));
    if (!match) {
        console.error(startupError(`No bot named '${botName}' was found in the tracked settings.`));
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
        entries.forEach((entry: BotEntry) => {
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
    const match = entries.find((b: BotEntry) => isSameBotName(b.name, botName));
    if (!match) {
        console.error(startupError(`No bot named '${botName}' was found to ${action}.`));
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
    const targets = botName ? entries.filter((b: BotEntry) => isSameBotName(b.name, botName)) : entries.filter((b: BotEntry) => b.active);
    if (botName && targets.length === 0) {
        console.error(startupError(`No bot named '${botName}' was found to reset.`));
        process.exit(1);
    }

    console.log(`Setting regeneration trigger for ${targets.length} ${targets.length === 1 ? 'bot' : 'bots'}...`);

    for (const bot of targets) {
        try {
            const triggerFile = getRecalculateTriggerFile(bot.botKey);
            storage.writeFile(triggerFile, '');
            console.log(startupSuccess(`✓ Trigger set for '${bot.name}' (${path.basename(triggerFile)})`));
        } catch (err) {
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
        const bot = resolveRawBotEntries(botsData).find((b: BotEntry) => isSameBotName(b.name, botName));

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
    } catch (err) {
        console.error(startupError(`\nExport error: ${getErrorMessage(err)}\n`));
        process.exit(1);
    }
}

/**
 * Script-backed commands: command name → entry-point segments under the code
 * root. Every entry owns its own argument parsing and usage text (the
 * HELP_OWNING_COMMANDS set forwards `--help` to it), so the CLI only spawns it
 * and mirrors the exit code.
 */
const SCRIPT_COMMANDS: Record<string, string[]> = {
    order: ['scripts', 'analyze-orders'],
    credit: ['scripts', 'analyze-credit'],
    rich: ['scripts', 'rich_list'],
    git: ['scripts', 'analyze-git'],
    tv: ['scripts', 'tv'],
    dw: ['scripts', 'dw'],
    liquid: ['scripts', 'liquid'],
    pnl: ['scripts', 'pnl'],
    asset: ['scripts', 'asset'],
};

/**
 * Spawn a runtime entry point with inherited stdio and exit with its status.
 * `rest` defaults to the CLI arguments after the command.
 *
 * Returns `true` after `process.exit` so a caller whose exit is intercepted
 * (tests) still stops the command instead of falling through the switch.
 */
function exitWithRuntimeScript(segments: string[], label: string, rest: string[] = cliArgs.slice(1)): true {
    const status = runRuntimeScript(
        buildRuntimeScriptPath(__dirname, segments),
        rest,
        { label, cwd: PATHS.PROJECT_ROOT },
    );
    process.exit(status);
    return true;
}

/**
 * Parse and execute CLI commands.
  * Supported commands: test, drystart, reset, default, disable, enable, key, bot, pm2, update, export, order, credit, tv, dw, liquid, pnl, asset, clear, status, unlock, help
 * @returns {Promise<boolean>} True if a command was handled, false otherwise
 */
async function handleCLICommands() {
    if (!cliArgs.length) return false;

    // The unlock supervisor spawns the bot worker as `dexbot worker` with
    // DEXBOT_LAUNCHER_WORKER=1 so the process table identifies it as the bot
    // worker. Intercept before command validation (`worker` is internal).
    if (Config.DEXBOT_LAUNCHER_WORKER && cliArgs[0] === LAUNCHER_WORKER_COMMAND) {
        const worker = parseWorkerArgs(cliArgs.slice(1));
        await startBotByName(worker.botName, { dryRun: worker.dryrun });
        return true;
    }

    const [rawCommand, target] = cliArgs;
    const command = COMMAND_ALIASES[rawCommand] ?? rawCommand;
    // `start`/`unlock` and `pm2` delegate to child launchers that print the
    // relocation notices themselves (after they know whether onboarding is
    // needed); printing here too would duplicate them.
    const childOwnsRelocationNotices = command === COMMAND_ALIASES.start || command === 'pm2';
    if (!childOwnsRelocationNotices) printRelocationNotices();

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
            const { spawnSync } = require('child_process') as typeof import('node:child_process');
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
                  } catch (err) {
                      console.warn('Failed to disconnect BitShares after bot helper exit:', err && getErrorMessage(err) ? getErrorMessage(err) : err);
                  }
             }
             process.exit(0);
             return true;
        case 'pm2':
            // Forward the remaining CLI args to pm2.js so subcommands work
            // (`dexbot pm2 stop <bot>`, `dexbot pm2 restart all`, `dexbot pm2
            // help`...). A dropped subcommand used to make `dexbot pm2 start X`
            // start ALL bots and `dexbot pm2 stop X` no-op into a full setup.
            return exitWithRuntimeScript(['pm2'], 'pm2');
        case 'update':
            setSuppressConnectionLog(true);
            require('./scripts/update');
            return true;
        case 'export':
            setSuppressConnectionLog(true);
            await exportBotTrades(target);
            process.exit(0);
            return true;
        case 'order':
        case 'credit':
        case 'rich':
        case 'git':
        case 'tv':
        case 'dw':
        case 'liquid':
        case 'pnl':
        case 'asset':
            // Registered analysis/utility entry points; each one owns its
            // argument parsing, usage text and `--help` (see
            // HELP_OWNING_COMMANDS), so the CLI only forwards argv.
            return exitWithRuntimeScript(SCRIPT_COMMANDS[command], command);
        case 'unlock':
            // Resolved through buildRuntimeScriptPath for the active runtime
            // layout (dist/unlock.js when compiled). A hard-coded dist path used
            // to no-op silently (ENOENT -> exit 0), hiding the launcher.
            return exitWithRuntimeScript(['unlock'], 'unlock');
        case 'clear':
        case 'clear-orders':
        case 'clear-market-adapter':
        case 'clear-all': {
            const { spawnSync } = require('child_process') as typeof import('node:child_process');
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
            // Installed-vs-published version status, from the single shared
            // renderer in modules/version_notice.ts: green when current, orange
            // when a newer release exists, gray when the probe cannot answer.
            //
            // The probe is STAGED around the report instead of being awaited
            // inline (see startStagedVersionStatus):
            //   top    1s grace. A valid cache or a quick registry answer lands
            //          inside it and the report never notices the wait.
            //   bottom 1s more for the probe still in flight, then a forced
            //          re-probe with the full NOTICE_STATUS_TIMEOUT_MS budget.
            //          If even that is silent, the verdict says so explicitly
            //          rather than leaving a missing line to be read as
            //          "you are up to date".
            // So the report costs at most 1s up front, and the verdict is
            // printed at exactly one terminal point, which no early
            // `process.exit()` in a branch below can truncate.
            const { UPDATER } = require('./modules/constants');
            const { startStagedVersionStatus, printVersionStatusOrHeader } = require('./modules/version_notice');
            const versionWait = startStagedVersionStatus({
                graceMs: UPDATER.NOTICE_STAGE_GRACE_MS,
                timeoutMs: UPDATER.NOTICE_STATUS_TIMEOUT_MS,
                // DEXBOT_VERSION_CHECK_FORCE=1 re-probes instead of answering
                // from the cache: the escape hatch when a cached failure is
                // indistinguishable from a live one.
                force: Config.DEXBOT_VERSION_CHECK_FORCE,
            });
            // Top-of-report grace. The VALUE is unused on purpose, only the
            // timing matters: `settled` is what gets displayed at the end.
            await versionWait.quick;
            console.log();
            // The ONE terminal point of this command: every branch below ends
            // in `finish(...)` instead of `process.exit(...)`, so the deferred
            // version line is always printed — including on the "no processes"
            // and delegated-`unlock status` paths, which used to exit before
            // the probe had anything to say.
            const finish = async (code: number): Promise<true> => {
                // Blank line, then the verdict: it is the last thing the
                // operator reads, so it gets its own block at the bottom. With
                // the check switched off, the shared helper falls back to the
                // bare "DEXBot2 vX.Y.Z" header, so the running build is always
                // named - the inline path's long-standing behaviour.
                console.log();
                printVersionStatusOrHeader(await versionWait.settled, { indent: '', surround: false });
                process.exit(code);
                return true;
            };

            // Centralized detection (modules/launcher/runtime_mode.ts), shared
            // with the mode-aware help output so the two cannot disagree.
            const runtimeInfo: RuntimeInfo = detectRuntimeMode();

            // PM2 bots win over a stray credential daemon (resolveStatusRoute)
            // so the report matches the help banner; otherwise a live unlock
            // runtime is shown by delegating to `unlock status`.
            if (resolveStatusRoute(runtimeInfo) === 'unlock') {
                const status = runRuntimeScript(
                    buildRuntimeScriptPath(__dirname, ['unlock']),
                    ['status', ...(target ? [target] : [])],
                    { label: 'unlock', cwd: PATHS.PROJECT_ROOT },
                );
                return finish(status);
            }

            // status is whole-runtime on every surface. With no unlock bot
            // runtime up, validate and ignore a bot name here so the behavior
            // matches the `unlock status <bot>` path.
            const statusCheck = checkStatusTarget(target);
            if (statusCheck.error) {
                console.error(startupError(statusCheck.error));
                return finish(1);
            }
            if (statusCheck.notice) {
                console.warn(statusCheck.notice);
            }

            // No unlock runtime: render the PM2 table for this install's own
            // processes (already filtered by the shared detector).
            const dexbotProcs = runtimeInfo.pm2Processes;
            if (dexbotProcs.length === 0) {
                console.log('No DEXBot2 processes running.');
                return finish(0);
            }

            console.log('='.repeat(50));
            console.log('DEXBot2 PM2 Processes');
            console.log('='.repeat(50));
            console.log('');

            const fmtUptime = (p: Pm2Proc): string => {
                if (!p?.pm2_env?.pm_uptime) return '-';
                const ms = Date.now() - new Date(p.pm2_env.pm_uptime as string | number).getTime();
                const s = Math.floor(Math.abs(ms) / 1000);
                if (s < 60) return `${s}s`;
                const m = Math.floor(s / 60);
                if (m < 60) return `${m}m ${s % 60}s`;
                const h = Math.floor(m / 60);
                if (h < 24) return `${h}h ${m % 60}m`;
                const d = Math.floor(h / 24);
                return `${d}d ${h % 24}h`;
            };

            const fmtMem = (p: Pm2Proc): string => {
                const bytes = p?.monit?.memory;
                if (!bytes || bytes <= 0) return '-';
                if (bytes < 1024) return `${bytes}B`;
                if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
                return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
            };

            const rows = dexbotProcs.map((p: Pm2Proc) => ({
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

            // Mixed state: surface a stray unlock-mode credential daemon too —
            // it holds unlocked keys in memory and would otherwise be invisible
            // here because PM2 wins the status route.
            if (runtimeInfo.credentialDaemonPid > 0) {
                console.log();
                console.log(`Credential daemon also running (unlock mode), PID ${runtimeInfo.credentialDaemonPid}.`);
            }
            return finish(0);
        }
        case 'delete':
        case 'stop':
        case 'restart':
        case 'reload':
            // The unlock runtime owns every lifecycle verb (stop/restart/
            // reload/delete) for both modes, so the CLI forwards the verb plus
            // the remaining arguments and mirrors the exit code.
            return exitWithRuntimeScript(['unlock'], command, [command, ...cliArgs.slice(1)]);
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
async function runDefaultBots({ forceDryRun = false, sourceName = 'settings', launcherStyle }: { forceDryRun?: boolean; sourceName?: string; launcherStyle?: LauncherStyle } = {}): Promise<void> {
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
    } catch (err) {
        if (err && (getErrorCode(err) === 'EACCES' || getErrorCode(err) === 'EPERM' || getErrorCode(err) === 'EROFS')) {
            const { spawnSync: respawn } = require('child_process') as typeof import('node:child_process');
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

        // Generate default general.settings.json for new installations.
        // Single canonical defaults document (modules/constants.ts) — the same
        // builder the editor fallback and the local-overrides merge use. This
        // also drops the dead ANCHOR:{} key and adds NODE_MANAGEMENT, keeping
        // first-run files byte-compatible with editor-saved ones.
        const SETTINGS_FILE = path.join(PROFILES_DIR, 'general.settings.json');
        const { buildDefaultGeneralSettings } = require('./modules/constants');
const { writeJSON } = storage;

        const defaultSettings = buildDefaultGeneralSettings();
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
            const keySetupCompleted = await chainKeys.main();
            if (keySetupCompleted) {
                console.log();
                console.log(startupSuccess('Master password configured! Now you can:'));
                console.log('  dexbot bot   - Create and manage bots');
                console.log('  dexbot        - Run your configured bots');
                console.log();
            } else {
                console.log();
                console.log('Master password setup cancelled.');
                console.log('Run `dexbot key` when you are ready to configure it.');
                console.log();
            }
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

function handleFatalBootstrapError(err: unknown) {
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

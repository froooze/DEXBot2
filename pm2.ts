#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);
// node-only entry point — PM2 process orchestration (spawn, exec, fs, os)
/**
 * pm2.ts - PM2 Orchestration Launcher
 *
 * Unified PM2 launcher for DEXBot2 multi-bot system.
 * One-command startup with all setup required before starting bots.
 * Handles process management, configuration generation, and daemon startup.
 *
 * ===============================================================================
 * COMMANDS
 * ===============================================================================
 *
 * dexbot pm2                       - Default: unlock keystore and start all bots
 * dexbot pm2 <bot>                 - Unlock keystore and start specific bot
 * dexbot pm2 claw-only             - Credential daemon only, managed by PM2
 * dexbot pm2 update                - Run the update script immediately
 * dexbot pm2 stop all              - Stop all dexbot PM2 processes
 * dexbot pm2 stop <bot>            - Stop specific bot process
 * dexbot pm2 delete all            - Delete all dexbot processes from PM2
 * dexbot pm2 delete <bot>          - Delete specific bot from PM2
 * dexbot pm2 reload all            - Reload managed apps without touching dexbot-cred
 * dexbot pm2 reload <bot>          - Reload a bot without touching dexbot-cred
 * dexbot pm2 restart all           - Restart managed apps; re-unlock dexbot-cred only if needed
 * dexbot pm2 restart <target>      - Restart a bot or safely re-unlock dexbot-cred

 * dexbot pm2 --headless            - Non-interactive unlock with env var
 * dexbot pm2 --headless --password-file <path>
 *                                - Non-interactive unlock with password file
 * dexbot pm2 help                  - Show help message
 *
 * Repo-root users can run `./pm2` instead.
 *
 * ===============================================================================
 * SETUP SEQUENCE
 * ===============================================================================
 *
 * Step 0: BITSHARES CONNECTION VERIFICATION
 *    - Waits for BitShares blockchain network connection
 *    - Suppresses debug output to keep terminal clean
 *    - Validates node availability before proceeding
 *
 * Step 1: PM2 INSTALLATION CHECK
 *    - Detects local and global PM2 installations
 *    - Prompts to install PM2 if missing
 *    - Validates PM2 is available before proceeding
 *
 * Step 2: ECOSYSTEM CONFIGURATION GENERATION
 *    - Reads bot definitions from profiles/bots.json for bot mode
 *    - Generates profiles/ecosystem.config.cjs with absolute paths
 *    - Filters only active bots (active !== false)
 *    - If bot-name provided, filters to only that bot
 *    - In claw-only mode, generates only the credential daemon app
 *    - Each bot configured with:
 *      * Unique app name
 *      * Log file paths
 *      * Restart/memory policies
 *
 * Step 3: AUTHENTICATION & CLEANUP
 *    - Cleans up stale daemon socket files
 *    - Prompts interactively for the unlock secret once at startup
 *    - Authenticates against profiles/keys.json
 *    - Uses a one-shot local bootstrap channel for credential-daemon only
 *
 * Step 4: PM2 DAEMON STARTUP
 *    - Starts PM2 daemon if not already running
 *    - Waits for PM2 to be ready
 *    - Starts each configured bot as PM2 app
 *    - Credential daemon is started as a PM2 app after one-shot bootstrap
 *    - Bots request private keys from credential daemon via Unix socket
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { setUmask } from './modules/config.js';
import { path } from './modules/path_api.js';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseJsonWithComments } from './modules/order/utils/system.js';
import { readBotsFileWithLock } from './modules/bots_file_lock.js';
import { loadSettingsFile, selectActiveBotEntries, type BotEntry } from './modules/bot_settings.js';
import { getProcessDiscovery } from './modules/process_discovery.js';
import * as chainKeys from './modules/chain_keys.js';
import * as credentialPolicy from './modules/credential_policy.js';
import { readHeadlessPassword } from './modules/launcher/headless_password.js';
import { buildScopedChildEnv } from './modules/launcher/child_env.js';
import { createPasswordBootstrapServer } from './modules/launcher/credential_bootstrap.js';
import { parsePm2Args } from './modules/launcher/launch_modes.js';
import { setupGracefulShutdown } from './modules/graceful_shutdown.js';
import { UPDATER, TIMING } from './modules/constants.js';
import { PATHS, printRelocationNotices } from './modules/paths.js';
import { buildRuntimeScriptPath } from './modules/launcher/runtime_entry.js';
import { Config } from './modules/config.js';
import { waitForConnected } from './modules/bitshares_client.js';
import * as readline from 'node:readline';
import { getErrorMessage } from './modules/utils/errors.js';
import { isSameBotName } from './modules/utils/sanitize_key.js';
import { muteChainLogs } from './modules/utils/chain_logs.js';
import { startVersionStatusCheck, flushVersionStatusOrHeader } from './modules/version_notice.js';
import { CLI_COLORS } from './modules/cli_colors.js';
import { getStorage } from './modules/storage/index.js';
import { usesAmaGridPrice } from './modules/dexbot_maintenance_runtime.js';
setUmask(0o077);

const {
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialSocketPath,
} = require('./modules/credential_runtime');
const storage = getStorage();
const { ensureDir, unlink: safeUnlink } = storage;

// Setup graceful shutdown handlers
setupGracefulShutdown();

const PM2_COLORS = {
    reset: CLI_COLORS.reset,
    ok: CLI_COLORS.brightGreen,
    error: CLI_COLORS.boldRed,
};

interface Pm2App {
    name: string;
    script: string;
    cwd: string;
    args?: string;
    env?: Record<string, string>;
    [key: string]: unknown;
}

interface CredentialBootstrap {
    socketPath: string;
    waitForTransfer(): Promise<unknown>;
    close(): void;
}

function colorPm2Output(text: string, color: string, stream: { isTTY?: boolean } = process.stdout): string {
    return stream.isTTY && !Config.NO_COLOR
        ? `${color}${text}${PM2_COLORS.reset}`
        : text;
}

function pm2Success(text: string): string {
    return colorPm2Output(text, PM2_COLORS.ok);
}

function pm2Error(text: string): string {
    return colorPm2Output(text, PM2_COLORS.error, process.stderr);
}

const CODE_ROOT = __dirname;
const BOTS_JSON = PATHS.PROFILES.BOTS_JSON;
const ECOSYSTEM_FILE = PATHS.PROFILES.ECOSYSTEM_CONFIG_JS;
const POLICY_CONFIG_FILE = PATHS.PROFILES.DAEMON_POLICIES_JSON;
const LOGS_DIR = PATHS.LOGS_DIR;
const CREDENTIAL_DAEMON_APP_NAME = 'dexbot-cred';
const CREDENTIAL_SOCKET_PATH = getCredentialSocketPath();
const CREDENTIAL_READY_FILE = getCredentialReadyFilePath();

function runtimeScript(...segments: string[]) {
    return path.join(CODE_ROOT, ...segments);
}

function needsMarketAdapter(bots: BotEntry[] | null | undefined): boolean {
    return (bots || []).some((bot) => usesAmaGridPrice(bot));
}

function isServiceApp(app: Pm2App | null | undefined): boolean {
    const name = String(app?.name || '');
    return name === 'dexbot-update' || name === CREDENTIAL_DAEMON_APP_NAME || name === 'dexbot-adapter';
}

function countManagedBots(apps: Pm2App[] | null | undefined): number {
    return (apps || []).filter((app) => !isServiceApp(app)).length;
}

function isPm2TableLine(line: unknown): boolean {
    const trimmed = String(line || '').trim();
    if (!trimmed) return true;
    return /^[┌┬│├┤└┴─\s]+$/.test(trimmed) || /^[┌┬│├┤└┴]/.test(trimmed);
}

function transformPm2Line(line: unknown): string | null {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    if (isPm2TableLine(trimmed)) return null;
    if (/^\[PM2\] Starting\b/.test(trimmed)) return null;
    if (trimmed === '[PM2] Done.') return null;
    if (/^\[PM2\] cron restart at /.test(trimmed)) return null;
    if (/^\[PM2\]\[WARN\] Applications .* not running, starting\.\.\.$/.test(trimmed)) return null;
    if (/^\[PM2\] Applying action /.test(trimmed)) return null;
    return trimmed.replace(/\s+\(\d+ instances?\)$/, '');
}

function flushPm2Buffer(buffer: string, writer: (line: string) => void, { final = false }: { final?: boolean } = {}): string {
    if (!buffer) return '';
    const lines = buffer.split(/\r?\n/);
    const trailing = lines.pop();
    for (const line of lines) {
        const transformed = transformPm2Line(line);
        if (transformed) writer(transformed);
    }
    if (final && trailing && trailing.trim()) {
        const transformed = transformPm2Line(trailing);
        if (transformed) writer(transformed);
        return '';
    }
    return trailing || '';
}

/**
 * Build PM2 app definitions for the current runtime.
 * @param {Array<Object>} bots - Active bot entries.
 * @param {Object} [options] - Build options.
 * @param {boolean} [options.includeUpdater=true] - Whether to add the updater service.
 * @returns {Array<Object>} PM2 app definitions.
 */
function buildEcosystemApps(bots: BotEntry[] | null | undefined, { includeUpdater = true }: { includeUpdater?: boolean } = {}): Pm2App[] {
    const apps: Pm2App[] = (bots || []).map((bot, index) => {
        const botName = bot.name || `bot-${index}`;
        return {
            name: botName,
            script: buildRuntimeScriptPath(CODE_ROOT, ['bot']),
            args: botName,
            cwd: PATHS.PROJECT_ROOT,
            max_memory_restart: '250M',
            watch: false,
            autorestart: true,
            error_file: path.join(LOGS_DIR, `${botName}-error.log`),
            out_file: path.join(LOGS_DIR, `${botName}.log`),
            log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
            merge_logs: true,
            max_size: '100M',
            max_restarts: 13,
            min_uptime: 86400000,
            restart_delay: 3000
        };
    });

    if (needsMarketAdapter(bots)) {
        apps.unshift({
            name: 'dexbot-adapter',
            script: buildRuntimeScriptPath(CODE_ROOT, ['market_adapter', 'market_adapter']),
            cwd: PATHS.PROJECT_ROOT,
            watch: false,
            autorestart: true,
            max_memory_restart: '150M',
            error_file: path.join(LOGS_DIR, 'dexbot-adapter-error.log'),
            out_file: path.join(LOGS_DIR, 'dexbot-adapter.log'),
            log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
            merge_logs: true,
            max_size: '100M',
            max_restarts: 13,
            min_uptime: 60000,
            restart_delay: 3000
        });
    }

    if (includeUpdater && UPDATER.ACTIVE) {
        apps.push({
            name: "dexbot-update",
            script: runtimeScript('scripts', 'update.js'),
            cwd: PATHS.PROJECT_ROOT,
            autorestart: false,
            cron_restart: UPDATER.SCHEDULE,
            error_file: path.join(LOGS_DIR, `dexbot-update-error.log`),
            out_file: path.join(LOGS_DIR, `dexbot-update.log`),
            log_date_format: "YY-MM-DD HH:mm:ss.SSS",
            max_size: '100M'
        });
    }

    return apps;
}

function buildCredentialDaemonApp({ credentialEnv = {} }: { credentialEnv?: Record<string, string> } = {}): Pm2App {
    return {
        name: CREDENTIAL_DAEMON_APP_NAME,
        script: runtimeScript('credential-daemon.js'),
        cwd: PATHS.PROJECT_ROOT,
        autorestart: false,
        error_file: path.join(LOGS_DIR, 'dexbot-cred-error.log'),
        out_file: path.join(LOGS_DIR, 'dexbot-cred.log'),
        log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
        merge_logs: true,
        max_size: '100M',
        env: {
            DEXBOT_CRED_DAEMON_SOCKET: CREDENTIAL_SOCKET_PATH,
            DEXBOT_CRED_DAEMON_READY_FILE: CREDENTIAL_READY_FILE,
            ...credentialEnv,
        }
    };
}

/**
 * Generate ecosystem.config.cjs from bots.json or claw-only mode.
 * @param {Object} [options={}] - Generation options.
 * @param {string|null} [options.botNameFilter=null] - Optional bot name to filter by.
 * @param {boolean} [options.clawOnly=false] - Generate no managed bot apps.
 * @param {boolean} [options.exitOnError=true] - If true, calls process.exit(1) instead of throwing
 * @returns {Array<Object>} The generated app configurations.
 */
function generateEcosystemConfig({ botNameFilter = null, clawOnly = false, exitOnError = true }: { botNameFilter?: string | null; clawOnly?: boolean; exitOnError?: boolean } = {}) {
    function fail(message: unknown): never {
        if (exitOnError) {
            console.error(pm2Error(String(message)));
            process.exit(1);
        }
        throw new Error(String(message));
    }

    // Ensure logs directory exists
    if (!storage.exists(LOGS_DIR)) {
        ensureDir(LOGS_DIR);
    }

    try {
        if (clawOnly) {
            const appsClaw: Pm2App[] = [];
            const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: dexbot pm2 or node dist/dexbot.js pm2
module.exports = { apps: ${JSON.stringify(appsClaw, null, 2)} }
`;

            storage.writeFile(ECOSYSTEM_FILE, ecosystemContent);
            return appsClaw;
        }

        if (!storage.exists(BOTS_JSON)) {
            fail(`${BOTS_JSON} not found. Run: dexbot bot`);
        }

        const { config } = loadSettingsFile(BOTS_JSON, { exitOnError });
        const bots = selectActiveBotEntries(config);

        if (botNameFilter) {
            const filtered = bots.filter((b) => isSameBotName(b.name, botNameFilter));
            if (filtered.length === 0) {
                fail(`Bot '${botNameFilter}' not found or not active in ${BOTS_JSON}`);
            }
            const apps = buildEcosystemApps(filtered, { includeUpdater: false });
            const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: dexbot pm2 or node dist/dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

            storage.writeFile(ECOSYSTEM_FILE, ecosystemContent);
            return apps;
        }

        if (bots.length === 0) {
            fail(`No active bots found in ${BOTS_JSON}`);
        }

        const apps = buildEcosystemApps(bots, { includeUpdater: true });

        const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: dexbot pm2 or node dist/dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

        storage.writeFile(ECOSYSTEM_FILE, ecosystemContent);
        return apps;
    } catch (err) {
        fail(`Error reading bots.json: ${getErrorMessage(err)}`);
    }
}

async function runManagedAppsPm2Action(action: string, { regenerate = false }: { regenerate?: boolean } = {}): Promise<boolean> {
    if (regenerate) {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
    }
    if (!storage.exists(ECOSYSTEM_FILE)) {
        return false;
    }
    return execPM2CommandIgnoreMissing(action, ECOSYSTEM_FILE);
}

function cleanupStaleCredentialDaemonFiles() {
    try {
        safeUnlink(CREDENTIAL_SOCKET_PATH)
        safeUnlink(CREDENTIAL_READY_FILE)
    } catch (e) {
        // Socket files already cleaned, that's fine
    }
}

async function ensureCredentialDaemonPM2({ forceRefresh = false, headless = false, passwordFile = null }: {
    forceRefresh?: boolean;
    headless?: boolean;
    passwordFile?: string | null;
} = {}) {
    ensureCredentialRuntimeDirSync();
    credentialPolicy.ensurePolicyConfig(POLICY_CONFIG_FILE);
    const daemonReady = await chainKeys.isDaemonResponsive({
        socketPath: CREDENTIAL_SOCKET_PATH,
        readyFilePath: CREDENTIAL_READY_FILE,
    });

    if (daemonReady && !forceRefresh) {
        return false;
    }

    if (!daemonReady) {
        cleanupStaleCredentialDaemonFiles();
    }

    let bootstrap: CredentialBootstrap | null = null;
    try {
        let vaultSecret;

        if (headless) {
            vaultSecret = chainKeys.unlockWithPassword(readHeadlessPassword({ passwordFile }));
        } else {
            vaultSecret = await chainKeys.authenticate();
        }

        bootstrap = await createPasswordBootstrapServer({ secret: vaultSecret });
        console.log(pm2Success('✓ Authentication successful'));
        await startManagedRuntimePM2({ apps: [], bootstrap });
        return true;
    } catch (error) {
        if (bootstrap) bootstrap.close();
        throw error;
    }
}

async function assertActiveBotTarget(target: string): Promise<string> {
    try {
        const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
        const match = selectActiveBotEntries(config).find((b) => isSameBotName(b.name, target));
        if (!match) {
            throw new Error(`Bot '${target}' not found or not active in ${BOTS_JSON}`);
        }
        return match.name ?? target;
    } catch (err) {
        if (String(err && getErrorMessage(err) || '').includes('not found or not active')) {
            throw err;
        }
        throw new Error(`Failed to read bots configuration: ${getErrorMessage(err)}`);
    }
}

/**
 * Main application entry point for PM2 orchestration.
 * @param {Object} [options={}] - Launcher options.
 * @param {string|null} [options.botNameFilter=null] - Optional bot name to start.
 * @param {boolean} [options.clawOnly=false] - Start the credential daemon only.
 * @returns {Promise<void>}
 */
async function main({ botNameFilter = null, clawOnly = false, headless = false, passwordFile = null }: {
    botNameFilter?: string | null;
    clawOnly?: boolean;
    headless?: boolean;
    passwordFile?: string | null;
} = {}) {
    if (typeof chainKeys.checkKeysFileSecurity === 'function') chainKeys.checkKeysFileSecurity();
    if (typeof credentialPolicy.checkPolicyFileSecurity === 'function') credentialPolicy.checkPolicyFileSecurity(PATHS.PROFILES.DAEMON_POLICIES_JSON);

    console.log('='.repeat(50));
    console.log('DEXBot2 PM2 Launcher');
    if (clawOnly) {
        console.log('Starting credential daemon only');
    }
    if (botNameFilter) {
        console.log(`Starting bot: ${botNameFilter}`);
    }
    if (headless) {
        console.log('Mode: headless (non-interactive password)');
    }
    console.log('='.repeat(50));
    console.log();

    // Start the passive version check immediately but do not await it: the
    // BitShares connect in Step 0 (and the PM2 work below) takes seconds, which
    // fully hides the registry round-trip. The installed-vs-published status is
    // printed in the success block at the end, below the banner, so it can
    // never be mistaken for part of the startup status. The promise never
    // rejects.
    const versionStatus = startVersionStatusCheck();

    if (!clawOnly) {
        // Step 0: Wait for BitShares connection. The native chain stack
        // ([Transport]/[NodeManager]/[bitshares_client]) logs straight to
        // console regardless of setSuppressConnectionLog, so mute those
        // prefixed lines process-wide to keep the launcher banner and the
        // connection confirmation as the only startup output.
        muteChainLogs();

        // DOUBLE-CONTROLLER GUARD: a monolithic instance started via
        // `dexbot start` is a live controller for the same accounts this PM2
        // fleet is about to own. Two controllers on one account corrupt each
        // other's grids and fills (observed live 2026-11-14), so refuse here
        // instead of letting the per-bot instance lock kill each PM2 app 3
        // seconds later.
        const monoPid = readLiveMonolithicPidLite();
        if (monoPid > 0) {
            console.error(pm2Error(
                `DEXBot2 is already running outside PM2 (monolithic PID ${monoPid}).\n` +
                `Starting the PM2 fleet now would put two controllers on the same accounts.\n` +
                `Stop it first with 'dexbot stop', then rerun this command.`
            ));
            await flushVersionStatusOrHeader(versionStatus);
            process.exit(1);
        }

        await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);

        console.log(pm2Success('Connected to BitShares'));
    } else {
        console.log();
    }

    // Step 1: Check PM2
    if (!checkPM2Installed()) {
        console.error(pm2Error('PM2 is not installed'));
        await installPM2();
    }

    // Step 1b: Make sure PM2 rotates its captured logs
    await ensurePm2Logrotate();

    // Step 2: Ensure credential daemon availability
    try {
        await ensureCredentialDaemonPM2({ headless, passwordFile });
    } catch (error) {
        console.error(pm2Error(`\n❌ ${getErrorMessage(error)}`));
        // Surface the version state on the failure path too: a start that dies
        // here is exactly when the operator wants to know which build they are
        // on and whether it is current, and the probe is already in flight.
        await flushVersionStatusOrHeader(versionStatus);
        process.exit(1);
    }

    // Step 3: Generate ecosystem config
    const apps = generateEcosystemConfig({
        botNameFilter,
        clawOnly,
    });
    const botCount = countManagedBots(apps);
    console.log(`Number active bots: ${botCount}`);
    console.log();

    // Step 4: Start PM2
    console.log(clawOnly ? 'Starting PM2 with credential daemon only...' : 'Starting PM2 with all services...');
    await warnStaleDexbotApps(apps);
    await startManagedAppsPM2(apps);

    console.log();
    console.log('='.repeat(50));
    console.log(pm2Success('DEXBot2 started successfully!'));
    console.log('If dexbot-cred stops, rerun `dexbot pm2` to unlock it again.');
    console.log('='.repeat(50));
    console.log();

    // The status line names the installed version; with the check switched off
    // the shared helper falls back to the bare header, so `dexbot pm2` reports
    // the running build exactly as `dexbot stat` does.
    await flushVersionStatusOrHeader(versionStatus);
}

function startPM2Process(args: string[], env: ReturnType<typeof buildScopedChildEnv> = buildScopedChildEnv()): Promise<void> {
    return new Promise((resolve, reject) => {
        const pm2 = spawn('pm2', args, {
            cwd: PATHS.PROJECT_ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            shell: process.platform === 'win32'
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';

        pm2.stdout.on('data', (data: Buffer) => {
            stdoutBuffer += data.toString();
            stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: string) => console.log(line));
        });

        pm2.stderr.on('data', (data: Buffer) => {
            stderrBuffer += data.toString();
            stderrBuffer = flushPm2Buffer(stderrBuffer, (line: string) => console.error(line));
        });

        pm2.on('close', (code: number | null) => {
            stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: string) => console.log(line), { final: true });
            stderrBuffer = flushPm2Buffer(stderrBuffer, (line: string) => console.error(line), { final: true });
            if (code === 0) {
                // Ensure we disconnect from PM2's file descriptors
                setImmediate(resolve);
            } else {
                reject(new Error(`PM2 exited with code ${code}`));
            }
        });

        pm2.on('error', reject);
    });
}

function startManagedAppsPM2(apps: Pm2App[] | null | undefined): Promise<void> {
    if (!apps || apps.length === 0) {
        return Promise.resolve();
    }
    return startPM2Process(['start', ECOSYSTEM_FILE]);
}

/**
 * Lightweight "a `dexbot start` monolithic instance is live" probe.
 *
 * Reads the monolithic pid file, so it must confirm the pid still belongs to
 * an unlock process (a recycled pid must not block PM2 forever). Kept local
 * instead of importing launcher/monolithic_runtime: pm2.ts is loaded by the
 * ESM-mocked launcher tests, and that module drags in the whole launcher graph
 * (bot settings, supervisor, credential runtime) for one check. The
 * authoritative backstop remains the per-bot instance lock.
 *
 * @returns {number} Live monolithic pid, or 0 when absent/dead/unrelated
 */
function readLiveMonolithicPidLite(): number {
    try {
        const pid = Number(storage.readFile(PATHS.PROFILES.MONOLITHIC_PID).trim());
        if (!Number.isInteger(pid) || pid <= 0) return 0;
        const discovery = getProcessDiscovery();
        if (!discovery.isAlive(pid)) return 0;
        const cmdline = discovery.readCmdline(pid);
        if (!/(^|[\\/])unlock\.(?:js|ts)(?:\0|$| )/.test(cmdline)) return 0;
        return pid;
    } catch (_) {
        return 0;
    }
}

/**
 * Names of PM2 apps that are RUNNING dexbot bot/runtime scripts from this
 * project root. Returns [] when pm2 is unavailable or the query fails — the
 * caller treats that as "cannot know", never as "none running".
 */
async function listRunningDexbotAppNames(): Promise<string[]> {
    try {
        const list = await runPm2Raw(['jlist'], { timeoutMs: 15000 });
        if (list.code !== 0) return [];
        const parsed = JSON.parse(list.stdout || '[]') as Array<{ name?: unknown; pm2_env?: { pm_cwd?: unknown; pm_exec_path?: unknown; status?: unknown } }> | null;
        if (!Array.isArray(parsed)) return [];
        const names: string[] = [];
        for (const app of parsed) {
            const env = app?.pm2_env;
            if (!env) continue;
            if (String(env.pm_cwd || '') !== PATHS.PROJECT_ROOT) continue;
            if (!/(^|[\\/])(bot|dexbot|market_adapter|credential-daemon)\.(?:js|ts)$/.test(String(env.pm_exec_path || ''))) continue;
            const status = String(env.status || '');
            if (status && status !== 'online' && status !== 'launching') continue;
            if (typeof app.name === 'string' && app.name) names.push(app.name);
        }
        return names;
    } catch (_) {
        return [];
    }
}

/**
 * Warn about RUNNING dexbot apps from this project root whose names are not in
 * the current bots.json set (renamed bots, leftovers from an older ecosystem
 * generation, a hung interactive-unlock attempt). Such an app comes back on
 * every `pm2 resurrect`/reboot and can double-run an account against the
 * freshly generated fleet — the exact double-controller incident of
 * 2026-11-14. Warn only (never auto-delete): the single-controller instance
 * lock refuses them at runtime, and deleting operator processes silently
 * would hide the misconfiguration instead of surfacing it.
 *
 * Compared against the FULL configured bot set (not the possibly bot-filtered
 * `apps` subset) so `dexbot pm2 <bot>` does not flag the operator's other,
 * legitimately configured bots.
 */
async function warnStaleDexbotApps(apps: Pm2App[] | null | undefined): Promise<void> {
    try {
        const running = await listRunningDexbotAppNames();
        if (running.length === 0) return;
        const current = new Set((apps || []).map((a) => a.name));
        // Full configured set from bots.json (not the possibly bot-filtered
        // `apps` subset). Best-effort: a settings read failure just narrows
        // the comparison to `apps` instead of blocking startup.
        const configured = new Set<string>();
        try {
            if (storage.exists(BOTS_JSON)) {
                const { config } = loadSettingsFile(BOTS_JSON);
                for (const b of selectActiveBotEntries(config) as BotEntry[]) {
                    if (b && b.active !== false && b.name) configured.add(String(b.name));
                }
            }
        } catch (_) { /* best-effort */ }
        const serviceNames = new Set(['dexbot-adapter', 'dexbot-update', 'dexbot-cred']);
        for (const name of running) {
            if (current.has(name) || configured.has(name) || serviceNames.has(name)) continue;
            if ([...current].some((n) => isSameBotName(n, name)) || [...configured].some((n) => isSameBotName(n, name))) continue;
            console.warn(
                `[PM2] Stale dexbot app '${name}' is RUNNING but not in the current bots.json set ` +
                `(renamed bot or leftover from an older config). It will keep running across reboots and ` +
                `can double-run an account. Remove it with: pm2 delete ${name} && pm2 save`
            );
        }
    } catch (_) { /* diagnostics only — must never block startup */ }
}

function startCredentialDaemonPM2({ credentialEnv = {} }: { credentialEnv?: Record<string, string> } = {}): Promise<void> {
    const app = buildCredentialDaemonApp({ credentialEnv });
    const args = [
        'start',
        app.script,
        '--name', app.name,
        '--cwd', app.cwd as string,
        '--output', app.out_file as string,
        '--error', app.error_file as string,
        '--log-date-format', app.log_date_format as string,
        '--no-autorestart',
    ];
    return startPM2Process(args, buildScopedChildEnv({ extra: app.env }))
        .then(() => {
            console.log(`[PM2] App [${CREDENTIAL_DAEMON_APP_NAME}] launched`);
        });
}

async function startManagedRuntimePM2({ apps, bootstrap }: { apps?: Pm2App[] | null; bootstrap?: CredentialBootstrap | null } = {}) {
    if (bootstrap) {
        await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);

        // Write the bootstrap socket path to a stable file in the runtime dir.
        // The credential daemon reads this file instead of relying on a
        // PM2-persisted env var.  Once consumed the file is deleted, so a
        // future `pm2 restart dexbot-cred` or `pm2 resurrect` will not
        // find it and will fall through to interactive auth.
        const bootstrapPathFile = path.join(
            path.dirname(CREDENTIAL_SOCKET_PATH),
            '.dexbot-cred-bootstrap-path'
        );
        try {
            storage.writeFile(bootstrapPathFile, bootstrap.socketPath, { mode: 0o600 });
        } catch (err) {
            throw new Error(
                `Cannot write bootstrap path file at ${bootstrapPathFile}: ${getErrorMessage(err)}. ` +
                `The daemon needs this file to find the bootstrap socket.`
            );
        }

        // Start the daemon WITHOUT DEXBOT_CRED_BOOTSTRAP_SOCKET so PM2 never
        // persists the one-shot temp socket path.
        const daemonEnv = {
            DEXBOT_CRED_DAEMON_SOCKET: CREDENTIAL_SOCKET_PATH,
            DEXBOT_CRED_DAEMON_READY_FILE: CREDENTIAL_READY_FILE,
            DEXBOT_CRED_BOOTSTRAP_PATH_FILE: bootstrapPathFile,
        };
        await startCredentialDaemonPM2({ credentialEnv: daemonEnv });
        await Promise.all([
            bootstrap.waitForTransfer(),
            chainKeys.waitForDaemon(TIMING.DAEMON_STARTUP_TIMEOUT_MS, {
                socketPath: CREDENTIAL_SOCKET_PATH,
                readyFilePath: CREDENTIAL_READY_FILE,
            }),
        ]);
    }

    await startManagedAppsPM2(apps);
}

/**
 * Run a raw `pm2` command and capture its output verbatim. Used for module
 * management (`jlist`, `install`, `set`) whose verbs are not part of the
 * process-control whitelist in execPM2Command.
 * @param {string[]} args - PM2 arguments.
 * @param {Object} [options] - Execution options.
 * @param {number} [options.timeoutMs=0] - Kill the child after this many ms (0 = no limit).
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Command result.
 */
function runPm2Raw(args: string[], { timeoutMs = 0 }: { timeoutMs?: number } = {}) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('pm2', args, {
            cwd: PATHS.PROJECT_ROOT,
            env: buildScopedChildEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new Error(`pm2 ${args[0]} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn();
        };
        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        child.on('error', (err: Error) => finish(() => reject(err)));
        child.on('close', (code: number | null) => finish(() => resolve({ code: code ?? 0, stdout, stderr })));
    });
}

/**
 * Best-effort enablement of `pm2-logrotate`. PM2 core does not rotate logs —
 * the per-app `max_size` option is ignored without this module — so a
 * long-running fleet would grow `profiles/logs/*.log` without bound. Never
 * blocks or fails startup.
 * @returns {Promise<void>}
 */
async function ensurePm2Logrotate() {
    try {
        const list = await runPm2Raw(['jlist'], { timeoutMs: 15000 });
        if (list.code !== 0) return;

        let installed = false;
        try {
            const parsed = JSON.parse(list.stdout || '[]');
            installed = Array.isArray(parsed) && (parsed as unknown[]).some((app) => Boolean(app && (app as { name?: unknown }).name === 'pm2-logrotate'));
        } catch (err) {
            installed = false;
        }
        if (installed) return;

        const install = await runPm2Raw(['install', 'pm2-logrotate'], { timeoutMs: 120000 });
        if (install.code !== 0) {
            const detail = (install.stderr || install.stdout || '').trim() || 'pm2 install failed';
            console.warn(pm2Error(`PM2 log rotation not enabled: ${detail}`));
            return;
        }
        await runPm2Raw(['set', 'pm2-logrotate:max_size', '100M'], { timeoutMs: 15000 });
        await runPm2Raw(['set', 'pm2-logrotate:retain', '10'], { timeoutMs: 15000 });
        await runPm2Raw(['set', 'pm2-logrotate:compress', 'true'], { timeoutMs: 15000 });
        console.log('Enabled PM2 log rotation (pm2-logrotate: 100M files, retain 10, compressed).');
    } catch (err) {
        console.warn(`PM2 log rotation not enabled: ${getErrorMessage(err)}`);
    }
}

/**
 * Resolve the npm CLI that belongs to the running Node.
 *
 * The npm beside `process.execPath` shares this Node's global root; a version
 * manager (nvm/fnm/volta) can put a different Node's npm first on PATH, which
 * would install pm2 into a prefix this Node cannot see. Falls back to the bare
 * name (PATH lookup) for unusual launcher layouts such as npx or shims.
 *
 * On Windows the shim is spawned through the shell, where an absolute path
 * such as `C:\Program Files\nodejs\npm.cmd` would need quoting; the PATH
 * lookup already resolves the right shim, so keep the bare name there.
 * @returns {string} Absolute npm path, or 'npm' when none is found.
 */
function resolveNpmBinary() {
    if (process.platform === 'win32') return 'npm';
    const candidate = path.join(path.dirname(process.execPath), 'npm');
    return existsSync(candidate) ? candidate : 'npm';
}

/**
 * Check whether the pm2 CLI is reachable.
 * @returns {boolean} True if `pm2 --version` succeeds.
 */
function checkPM2Installed() {
    try {
        execSync('pm2 --version', { stdio: 'ignore' });
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Prompt the user to install PM2 globally.
 * @returns {Promise<void>}
 */
async function installPM2() {

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise<void>((resolve, reject) => {
        rl.question('PM2 is not installed. Install now? (Y/n): ', (answer: string) => {
            rl.close();

            const normalized = answer.trim().toLowerCase();
            if (normalized === 'n' || normalized === 'no') {
                console.log('PM2 installation cancelled. Run: npm install -g pm2');
                process.exit(1);
            }

            console.log('Installing PM2...');

            const npmBin = resolveNpmBinary();

            // Helper to run installation command
            const runInstall = (command: string, args: string[]) => {
                return new Promise<void>((res, rej) => {
                    const proc = spawn(command, args, {
                        stdio: 'inherit',
                        shell: process.platform === 'win32'
                    });
                    proc.on('close', (code: number | null) => {
                        if (code === 0) res();
                        else rej(code);
                    });
                    proc.on('error', (err: Error) => rej(err));
                });
            };

            // npm can report success while writing into a global bin dir that is
            // not on this PATH, so confirm `pm2` is actually reachable before
            // declaring victory.
            const confirmInstalled = (message: string) => {
                if (checkPM2Installed()) {
                    console.log(pm2Success(message));
                    resolve();
                } else {
                    console.error(pm2Error('PM2 was installed, but `pm2` is not on PATH. Add the npm global bin directory to PATH and rerun.'));
                    reject(new Error('PM2 installed but not found on PATH'));
                }
            };

            // Try standard install first
            runInstall(npmBin, ['install', '-g', 'pm2'])
                .then(() => confirmInstalled('PM2 installed successfully!'))
                .catch((_err) => {
                    // If failed and not on Windows, try sudo
                    if (process.platform !== 'win32') {
                        console.log('\nStandard installation failed (likely permissions). Trying with sudo...');
                        console.log('This covers Linux and macOS. Please enter your password if prompted:');

                        runInstall('sudo', [npmBin, 'install', '-g', 'pm2'])
                            .then(() => confirmInstalled('PM2 installed successfully with sudo!'))
                            .catch((_finalErr) => {
                                reject(new Error('PM2 installation failed even with sudo'));
                            });
                    } else {
                        // Windows handling
                        console.log('\nStandard installation failed (likely permissions).');
                        console.log('Attempting to install with Administrator privileges...');
                        console.log('Please accept the UAC dialog to proceed.');

                        // Run npm install in a new elevated window
                        // We use timeout so the user can see the result before window closes
                        const psCommand = "Start-Process cmd -ArgumentList '/c npm install -g pm2 & echo. & echo Installation complete. Closing in 5 seconds... & timeout /t 5' -Verb RunAs -Wait";

                        runInstall('powershell', ['-Command', psCommand])
                            .then(() => {
                                // Verify installation succeeded since we can't easily get the exit code from the elevated process
                                if (checkPM2Installed()) {
                                    console.log(pm2Success('PM2 installed successfully (Elevated)!'));
                                    resolve();
                                } else {
                                    reject(new Error('PM2 installation failed or was cancelled in the elevated window.'));
                                }
                            })
                            .catch((_winErr) => {
                                console.error(pm2Error('\nFailed to elevate permissions.'));
                                console.error(pm2Error('Please manually run "npm install -g pm2" as Administrator.'));
                                reject(new Error('PM2 installation failed.'));
                            });
                    }
                });
        });
    });
}

/**
 * Execute a PM2 command safely.
 * @param {string} action - PM2 action (start, stop, etc.).
 * @param {string} [target] - The target process name or configuration file.
 * @param {Object} [options] - Execution options
 * @param {boolean} [options.suppressStderrOnError=false] - Suppress stderr on failure
 * @param {boolean} [options.silent=false] - Suppress stdout output
 * @returns {Promise<Object>} Command result.
 * @throws {Error} If action is invalid or command fails.
 */
async function execPM2Command(action: string, target: string | null | undefined, { suppressStderrOnError = false, silent = false }: { suppressStderrOnError?: boolean; silent?: boolean } = {}): Promise<{ success: boolean; stdout: string; stderr: string }> {
    // Validate action to prevent injection
    const validActions = ['start', 'stop', 'delete', 'restart'];
    if (!validActions.includes(action)) {
        throw new Error(`Invalid PM2 action: ${action}`);
    }

    // Use spawn instead of shell to avoid injection vulnerabilities
    // spawn passes arguments as array, preventing shell interpretation
    return new Promise((resolve, reject) => {
        const args = [action];
        if (target) {
            args.push(target);
        }

        const pm2 = spawn('pm2', args, {
            cwd: PATHS.PROJECT_ROOT,
            env: buildScopedChildEnv(),
            stdio: 'pipe',
            shell: process.platform === 'win32'
        });

        let stdout = '';
        let stderr = '';
        let stdoutBuffer = '';

        pm2.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
            if (!silent) {
                stdoutBuffer += data.toString();
                stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: string) => console.log(line));
            }
        });

        pm2.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        pm2.on('close', (code: number | null) => {
            if (!silent) {
                stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: string) => console.log(line), { final: true });
            }
            if (code === 0) {
                resolve({ success: true, stdout, stderr });
            } else {
                if (stderr && !suppressStderrOnError) console.error(stderr);
                reject(new Error(`PM2 command failed with code ${code}: ${stderr || stdout}`));
            }
        });

        pm2.on('error', reject);
    });
}

async function execPM2CommandIgnoreMissing(action: string, target: string | null | undefined, options: { suppressStderrOnError?: boolean; silent?: boolean } = {}): Promise<boolean> {
    try {
        await execPM2Command(action, target, { suppressStderrOnError: true, ...options });
        return true;
    } catch (error) {
        const message = String(error && getErrorMessage(error) ? getErrorMessage(error) : error);
        if (message.includes('Process or Namespace') || message.includes('not found') || message.includes('does not exist')) {
            return false;
        }
        throw error;
    }
}

/**
 * Stop PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or stopping fails.
 */
async function stopPM2Processes(target: string): Promise<void> {
    console.log(`Stopping PM2 processes: ${target}`);

    if (target === 'all') {
        console.log('');
        // Stop the credential daemon first: it holds the only handle to keys,
        // so releasing it up front is the safety stop. Managed apps are stopped
        // afterwards; they can no longer sign, but they are already shutting down.
        await execPM2CommandIgnoreMissing('stop', CREDENTIAL_DAEMON_APP_NAME);
        if (storage.exists(ECOSYSTEM_FILE)) {
            await runManagedAppsPm2Action('stop');
        } else if (storage.exists(BOTS_JSON)) {
            try {
                await runManagedAppsPm2Action('stop', { regenerate: true });
            } catch (err) {
                console.warn(`Skipping managed bot stop: ${getErrorMessage(err)}`);
            }
        }
        console.log('');
        console.log('All dexbot PM2 processes stopped.');
        return;
    }

    if (target === CREDENTIAL_DAEMON_APP_NAME) {
        await execPM2CommandIgnoreMissing('stop', CREDENTIAL_DAEMON_APP_NAME);
        console.log(`PM2 process '${target}' stopped.`);
        return;
    }

    // Validate bot exists in configuration before stopping (with lock protection)
    // and resolve to the canonical stored name (PM2 process names are case-sensitive).
    try {
        const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
        const match = selectActiveBotEntries(config).find((b) => isSameBotName(b.name, target));

        if (!match) {
            throw new Error(`Bot '${target}' not found or not active in ${BOTS_JSON}`);
        }
        target = match.name ?? target;
    } catch (err) {
        throw new Error(`Failed to read bots configuration: ${getErrorMessage(err)}`);
    }

    // Stop specific bot by name
    await execPM2Command('stop', target);
    console.log(`PM2 process '${target}' stopped.`);
}

/**
 * Delete PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or deleting fails.
 */
async function deletePM2Processes(target: string): Promise<void> {
    console.log(`Deleting PM2 processes: ${target}`);

    if (target === 'all') {
        console.log('');
        await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);
        if (storage.exists(ECOSYSTEM_FILE)) {
            await runManagedAppsPm2Action('delete');
        } else if (storage.exists(BOTS_JSON)) {
            try {
                await runManagedAppsPm2Action('delete', { regenerate: true });
            } catch (err) {
                console.warn(`Skipping managed bot delete: ${getErrorMessage(err)}`);
            }
        }
        console.log('');
        console.log('All dexbot PM2 processes deleted.');
        return;
    } else {
        if (target === CREDENTIAL_DAEMON_APP_NAME) {
            await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);
            console.log(`PM2 process '${target}' deleted.`);
            return;
        }

        // Validate bot exists in configuration before deleting (with lock protection)
        // and resolve to the canonical stored name (PM2 process names are case-sensitive).
        try {
            const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
            const match = selectActiveBotEntries(config).find((b) => isSameBotName(b.name, target));

            if (!match) {
                throw new Error(`Bot '${target}' not found or not active in ${BOTS_JSON}`);
            }
            target = match.name ?? target;
        } catch (err) {
            throw new Error(`Failed to read bots configuration: ${getErrorMessage(err)}`);
        }

        // Delete specific bot by name
        await execPM2Command('delete', target);
        console.log(`PM2 process '${target}' deleted.`);
    }
}

async function restartPM2Processes(target: string, { headless = false, passwordFile = null }: { headless?: boolean; passwordFile?: string | null } = {}) {
    console.log(`Restarting PM2 processes: ${target}`);

    if (target === 'all') {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        await ensureCredentialDaemonPM2({ headless, passwordFile });
        await runManagedAppsPm2Action('restart');
        console.log('Managed dexbot PM2 apps restarted. dexbot-cred was left on the safe wrapper path.');
        return;
    }

    if (target === CREDENTIAL_DAEMON_APP_NAME) {
        await ensureCredentialDaemonPM2({ forceRefresh: true, headless, passwordFile });
        console.log(`Credential daemon '${target}' restarted with a fresh unlock.`);
        return;
    }

    target = await assertActiveBotTarget(target);
    await ensureCredentialDaemonPM2({ headless, passwordFile });
    await execPM2Command('restart', target);
    console.log(`PM2 process '${target}' restarted.`);
}

/**
 * Reload PM2 processes without touching the credential daemon.
 * Mirrors restartPM2Processes but never ensures or refreshes dexbot-cred,
 * so bots keep their existing key access.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found, is dexbot-cred, or reloading fails.
 */
async function reloadPM2Processes(target: string): Promise<void> {
    console.log(`Reloading PM2 processes: ${target}`);

    if (target === 'all') {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        await runManagedAppsPm2Action('restart');
        console.log('Managed dexbot PM2 apps reloaded. dexbot-cred was left untouched.');
        return;
    }

    if (target === CREDENTIAL_DAEMON_APP_NAME) {
        throw new Error(`reload does not apply to '${CREDENTIAL_DAEMON_APP_NAME}'; use 'dexbot pm2 restart ${CREDENTIAL_DAEMON_APP_NAME}' to re-unlock it.`);
    }

    target = await assertActiveBotTarget(target);
    await execPM2Command('restart', target);
    console.log(`PM2 process '${target}' reloaded (dexbot-cred untouched).`);
}

/**
 * Show help text for PM2 CLI usage.
 */
function showPM2Help() {
    console.log(`
Usage: dexbot pm2 [--headless] [--password-file <path>] [<target>]

Commands:
  (default)                 Unlock keystore and start all bots with PM2
  claw-only                 Start only the credential daemon with PM2
  update                    Run the update script immediately
  stop <bot-name|all>       Stop PM2 process(es) - only dexbot processes
  delete <bot-name|all>     Delete PM2 process(es) - only dexbot processes
  reload <bot-name|all>       Reload managed apps without touching dexbot-cred
  restart <bot-name|all|dexbot-cred>
                             Restart managed apps safely; dexbot-cred uses fresh unlock flow
  help                      Show this help message

Flags:
  --headless                Non-interactive unlock (requires DEXBOT_MASTER_PASSWORD env var
                            or --password-file)
  --password-file <path>    Read master password from file (first line)

Examples:
  dexbot pm2                       # Start all bots (unlock + start)
  dexbot pm2 claw-only             # Start only the credential daemon
  dexbot pm2 <bot>                 # Start a single bot
  dexbot pm2 --headless            # Start all bots (non-interactive)
  dexbot pm2 --password-file /run/secrets/bot-password
                                   # Start all bots with password from file
  dexbot pm2 stop all             # Stop all dexbot processes
  dexbot pm2 stop <bot>            # Stop specific bot
  dexbot pm2 delete all           # Delete all dexbot processes from PM2
  dexbot pm2 delete <bot>          # Delete specific bot from PM2
  dexbot pm2 reload all           # Reload managed apps, dexbot-cred untouched
  dexbot pm2 reload <bot>          # Reload a single bot, dexbot-cred untouched
  dexbot pm2 restart all          # Safe restart path for managed apps
  dexbot pm2 restart dexbot-cred  # Re-unlock credential daemon

  dexbot pm2 help                 # Show help

Repo-root users can run \`./pm2\` instead.
    `);
}

// Run if called directly or via the root-level pm2.js shim
const isPm2DirectRun = !!process.argv[1] && (
    import.meta.url === pathToFileURL(process.argv[1]).href ||
    path.basename(process.argv[1]).replace(/\.js$/, '') === 'pm2'
);
if (isPm2DirectRun) {
    // `dexbot pm2` delegates here without printing relocation notices, so the
    // child owns them: emit once for every pm2 invocation, before dispatch.
    printRelocationNotices();
    // Parse command line arguments
    const { command, target, clawOnly, headless, passwordFile } = parsePm2Args(process.argv);

    (async () => {
        try {
            if (!command) {
                // Full setup: unlock, generate config, authenticate, start PM2
                // Optional: filter to specific bot if provided
                await main({ botNameFilter: target || null, clawOnly, headless, passwordFile });
                // Close stdin to prevent hanging
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } else if (command === 'claw-only') {
                await main({ clawOnly: true, headless, passwordFile });
                // Close stdin to prevent hanging
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } else if (command === 'update') {
                const update = spawn(Config.EXEC_PATH, [runtimeScript('scripts', 'update.js')], { stdio: 'inherit' });
                update.on('close', (code: number | null) => process.exit(code));
            } else if (command === 'stop') {
                if (!target) {
                    console.error(pm2Error('Error: Target required. Specify bot name or "all".'));
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await stopPM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(pm2Error(`Failed to stop processes: ${getErrorMessage(err)}`));
                    process.exit(1);
                }
            } else if (command === 'delete') {
                if (!target) {
                    console.error(pm2Error('Error: Target required. Specify bot name or "all".'));
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await deletePM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(pm2Error(`Failed to delete processes: ${getErrorMessage(err)}`));
                    process.exit(1);
                }
            } else if (command === 'restart') {
                if (!target) {
                    console.error(pm2Error('Error: Target required. Specify bot name, "dexbot-cred", or "all".'));
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await restartPM2Processes(target, { headless, passwordFile });
                    process.exit(0);
                } catch (err) {
                    console.error(pm2Error(`Failed to restart processes: ${getErrorMessage(err)}`));
                    process.exit(1);
                }
            } else if (command === 'reload') {
                if (!target) {
                    console.error(pm2Error('Error: Target required. Specify bot name or "all".'));
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await reloadPM2Processes(target);
                    process.exit(0);
                } catch (err) {
                    console.error(pm2Error(`Failed to reload processes: ${getErrorMessage(err)}`));
                    process.exit(1);
                }
            } else if (command === 'help') {
                showPM2Help();
                process.exit(0);
            } else {
                console.error(pm2Error(`Unknown command: ${command}`));
                showPM2Help();
                process.exit(1);
            }
        } catch (err) {
            console.error(pm2Error(`Error: ${getErrorMessage(err)}`));
            process.exit(1);
        }
    })();
}
export { buildCredentialDaemonApp, buildEcosystemApps, buildScopedChildEnv, countManagedBots, deletePM2Processes, ensureCredentialDaemonPM2, generateEcosystemConfig, isServiceApp, main, needsMarketAdapter, reloadPM2Processes, restartPM2Processes, stopPM2Processes, startManagedRuntimePM2, usesAmaGridPrice };


export default {
    buildCredentialDaemonApp,
    buildEcosystemApps,
    buildScopedChildEnv,
    countManagedBots,
    deletePM2Processes,
    ensureCredentialDaemonPM2,
    generateEcosystemConfig,
    isServiceApp,
    main,
    needsMarketAdapter,
    reloadPM2Processes,
    restartPM2Processes,
    stopPM2Processes,
    startManagedRuntimePM2,
    usesAmaGridPrice
};


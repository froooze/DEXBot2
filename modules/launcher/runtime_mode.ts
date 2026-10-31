'use strict';

/**
 * Single source of truth for "which DEXBot2 runtime is running?".
 *
 * Used by `dexbot status` (delegate to `unlock status` vs render the PM2
 * table) and by `dexbot help`/usage output (describe controls in terms of the
 * active runtime). Keeping detection plus the mode→instructions mapping here
 * stops the two entry points from drifting.
 *
 * Unlock-mode liveness is read from pid files/socket (cheap). PM2 is only
 * probed when no unlock runtime is up, so a running monolithic/isolated bot
 * never pays for a `pm2` round-trip.
 *
 * Limitation: the isolated verdict is an `exists()` check on the supervisor
 * socket, so a leftover socket from a crashed supervisor still reads as
 * isolated. A live-connect probe would be more accurate but must stay off the
 * help/status hot path.
 */

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getStorage } from '../storage/index.js';
import { PATHS } from '../paths.js';
import { Config } from '../config.js';
import { loadSettingsFile, resolveRawBotEntries } from '../bot_settings.js';
import { isSameBotName } from '../utils/sanitize_key.js';
import { normalizeControlTarget, readLiveMonolithicPid, botNotFoundMessage, statusIgnoresTargetMessage } from './monolithic_runtime.js';

const storage = getStorage();

type RuntimeMode = 'monolithic' | 'isolated' | 'pm2' | 'none';

export interface Pm2Proc {
    pid?: number | string;
    name?: string;
    pm2_env?: { pm_uptime?: unknown; status?: string };
    monit?: { memory?: number };
    [key: string]: unknown;
}

export interface RuntimeInfo {
    mode: RuntimeMode;
    /** Live monolithic wrapper PID, or 0. */
    monolithicPid: number;
    /** A supervised (isolated) supervisor socket is present. */
    supervisorSocket: boolean;
    /** The credential daemon is still alive (e.g. after a `stop`). */
    credentialDaemonAlive: boolean;
    /** Live credential-daemon PID (unlock mode), or 0. */
    credentialDaemonPid: number;
    /** Any unlock-mode process is up (monolithic, isolated, or cred daemon). */
    unlockRunning: boolean;
    /** DexBot PM2 processes; empty unless the unlock runtime is down. */
    pm2Processes: Pm2Proc[];
}

/** PM2 app names owned by DEXBot2 (bot names are added from bots.json). */
const PM2_SERVICE_NAMES = new Set(['dexbot-cred', 'dexbot-adapter', 'dexbot-update']);

function configuredBotNames(): Set<string> {
    const names = new Set<string>();
    try {
        const { config } = loadSettingsFile(PATHS.PROFILES.BOTS_JSON);
        for (const b of resolveRawBotEntries(config)) {
            if (b?.name) names.add(String(b.name));
        }
    } catch (_) {}
    return names;
}

/** True when `name` matches a configured bot (case-insensitive). */
export function isConfiguredBotName(name: string): boolean {
    for (const configured of configuredBotNames()) {
        if (isSameBotName(configured, name)) return true;
    }
    return false;
}

interface StatusTargetCheck {
    error: string | null;
    notice: string | null;
}

/**
 * Validate the optional bot name on `dexbot status`. status is whole-runtime
 * on every surface, so a real name is announced-then-ignored and an unknown
 * one is rejected — the same contract the unlock control path applies.
 */
export function checkStatusTarget(target?: string | null): StatusTargetCheck {
    const requested = normalizeControlTarget(target);
    if (!requested) return { error: null, notice: null };
    if (!isConfiguredBotName(requested)) {
        return { error: botNotFoundMessage(requested), notice: null };
    }
    return { error: null, notice: statusIgnoresTargetMessage(requested) };
}

type StatusRoute = 'unlock' | 'pm2' | 'empty';

/**
 * Which branch `dexbot status` takes. PM2 wins when PM2 bots are running (even
 * if a stray credential daemon lingers) so the report and the help banner name
 * the same runtime; otherwise a live unlock process is shown by delegating to
 * `unlock status`. The cred-daemon-only case stays on the unlock route so the
 * daemon is still reported.
 */
export function resolveStatusRoute(info: RuntimeInfo): StatusRoute {
    if (info.pm2Processes.length > 0) return 'pm2';
    if (info.unlockRunning) return 'unlock';
    return 'empty';
}

function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // A live process owned by another user still exists (EACCES).
        return (err as NodeJS.ErrnoException)?.code === 'EACCES';
    }
}

/**
 * Whether a PM2 daemon looks alive in this install. PM2 always writes
 * `pm2.pid` under PM2_HOME (default `~/.pm2`), so its presence is a cheap
 * fast-path that avoids spawning `pm2 jlist` at all when PM2 was never run.
 */
function isPm2DaemonRunning(): boolean {
    try {
        const home = Config.PM2_HOME || process.env.PM2_HOME || join(homedir(), '.pm2');
        return storage.exists(join(home, 'pm2.pid'));
    } catch (_) {
        return false;
    }
}

/**
 * Parse `pm2 jlist` and keep only DEXBot2's own processes. Returns `[]` on any
 * failure (pm2 missing, daemon down, malformed output) so callers can treat
 * "no PM2" and "pm2 unavailable" the same way.
 */
export function listDexbotPm2Processes(): Pm2Proc[] {
    // Fast path: no daemon pid file means pm2 is not running here, so skip the
    // subprocess. Keeps `dexbot help`/typo-usage output free of a pm2 probe.
    if (!isPm2DaemonRunning()) return [];

    let allProcs: Pm2Proc[];
    try {
        const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).toString().trim();
        const jsonStart = output.indexOf('[');
        if (jsonStart === -1) return [];
        const parsed = JSON.parse(output.slice(jsonStart));
        if (!Array.isArray(parsed)) return [];
        allProcs = parsed as Pm2Proc[];
    } catch (_) {
        return [];
    }

    const botNames = configuredBotNames();
    return allProcs.filter((p) => {
        const name = String(p?.name || '');
        return PM2_SERVICE_NAMES.has(name) || botNames.has(name);
    });
}

/**
 * Detect the active runtime and the supporting state the callers need.
 * Monolithic wins over isolated if both markers linger; PM2 is probed last.
 */
export function detectRuntimeMode(): RuntimeInfo {
    const monolithicPid = readLiveMonolithicPid().pid;
    const supervisorSocket = storage.exists(PATHS.PROFILES.SUPERVISOR_SOCK);

    let credentialDaemonPid = 0;
    try {
        const pid = Number(storage.readFile(PATHS.PROFILES.MONOLITHIC_CRED_PID).trim());
        if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) credentialDaemonPid = pid;
    } catch (_) {}
    const credentialDaemonAlive = credentialDaemonPid > 0;

    const unlockRunning = monolithicPid > 0 || supervisorSocket || credentialDaemonAlive;

    let pm2Processes: Pm2Proc[] = [];
    let mode: RuntimeMode = 'none';
    if (monolithicPid > 0) {
        mode = 'monolithic';
    } else if (supervisorSocket) {
        mode = 'isolated';
    } else {
        pm2Processes = listDexbotPm2Processes();
        if (pm2Processes.length > 0) mode = 'pm2';
    }

    return { mode, monolithicPid, supervisorSocket, credentialDaemonAlive, credentialDaemonPid, unlockRunning, pm2Processes };
}

/** Human label for the active-runtime banner. */
export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
    monolithic: 'monolithic runtime (dexbot start)',
    isolated: 'isolated supervisor (dexbot start --isolated)',
    pm2: 'PM2 (dexbot pm2)',
    none: 'none detected — standard monolithic runtime',
};

/**
 * Banner label for a detection result. `none` with a live credential daemon
 * is called out so the banner agrees with `dexbot status` (which reports the
 * daemon that outlived a `stop`).
 */
export function runtimeModeLabel(info: RuntimeInfo): string {
    if (info.mode === 'none' && info.credentialDaemonAlive) {
        return 'credential daemon only — no bot runtime';
    }
    return RUNTIME_MODE_LABELS[info.mode];
}

export interface RuntimeHelpEntry {
    command: string;
    description: string;
}

/**
 * The Runtime command group, phrased for the runtime that is actually up.
 * `none` shows the standard monolithic runtime (the `dexbot start` default)
 * so the reference is always complete before anything is running.
 */
export function runtimeControlHelp(mode: RuntimeMode): RuntimeHelpEntry[] {
    switch (mode) {
        case 'isolated':
            return [
                { command: 'start [bot]', description: 'Start the runtime (flags below).' },
                { command: 'stop [<bot>]', description: 'Stop one bot, or all bots when <bot> is omitted.' },
                { command: 'reload [<bot>]', description: 'Reload one bot, or all bots, without re-unlocking keys.' },
                { command: 'restart [<bot>]', description: 'Restart one bot, or all bots, and re-unlock keys.' },
                { command: 'delete', description: 'Shut the supervisor down and clean up (all bots).' },
                { command: 'status', description: 'Show runtime status (a <bot> is validated, then ignored).' },
                { command: 'pm2 [<sub>]', description: 'Manage PM2 bots (see: dexbot pm2 help).' },
            ];
        case 'pm2':
            return [
                { command: 'pm2 [<bot>]', description: 'Start/replace the PM2 process set (unlocks the credential daemon).' },
                { command: 'pm2 stop <bot|all>', description: 'Stop PM2 bot process(es).' },
                { command: 'pm2 reload <bot|all>', description: 'Reload PM2 apps; dexbot-cred untouched.' },
                { command: 'pm2 restart <bot|all|dexbot-cred>', description: 'Restart PM2 apps; dexbot-cred re-unlocks.' },
                { command: 'pm2 delete <bot|all>', description: 'Delete PM2 bot process(es).' },
                { command: 'status', description: 'Show runtime status (a <bot> is validated, then ignored).' },
            ];
        case 'monolithic':
        default:
            return [
                { command: 'start [bot]', description: 'Start the runtime (flags below).' },
                { command: 'stop [<bot>]', description: 'Stop all bots (a <bot> argument folds into the whole runtime).' },
                { command: 'reload [<bot>]', description: 'Reload all bots without re-unlocking keys.' },
                { command: 'restart [<bot>]', description: 'Restart all bots and re-unlock keys.' },
                { command: 'delete', description: 'Stop and delete all runtime processes.' },
                { command: 'status', description: 'Show runtime status (a <bot> is validated, then ignored).' },
                { command: 'pm2 [<sub>]', description: 'Manage PM2 bots (see: dexbot pm2 help).' },
            ];
    }
}

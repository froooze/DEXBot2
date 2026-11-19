'use strict';

// node-only entry point — per-account bot instance lock (/proc liveness, fs)

/**
 * instance_lock.ts - Single-controller lock per trading account
 *
 * Prevents two bot processes (e.g. one started via `dexbot pm2` and one via a
 * normal `dexbot start` unlock) from controlling the SAME account at the same
 * time. Observed live (2026-11-14): two controllers kept independent in-memory
 * grids over the same 40 chain orders, cancelled each other's orders as
 * "duplicate orphans", attributed the same fill to different slots, and
 * finally stranded the grid out of spread for ~24h behind an off-market
 * LAST-FILL-GUARD pivot. This lock makes the second controller fail fast with
 * the holder's identity instead of silently double-trading.
 *
 * The lock is keyed by ACCOUNT, not bot name: the conflict domain is the chain
 * account's open orders and fills, so even two differently named bot entries
 * sharing an account are refused.
 *
 * Implementation reuses the market adapter's file-lock primitive (staleness +
 * heartbeat + ownership-checked release) with a process-liveness aliveCheck
 * that also compares /proc/<pid>/stat starttime, so a recycled pid can neither
 * keep a dead holder's lock alive nor steal a live holder's lock.
 */

import { path } from '../path_api.js';
import { getStorage } from '../storage/index.js';
import { PATHS } from '../paths.js';
import { runtime } from '../runtime.js';
import { getProcessDiscovery } from '../process_discovery.js';
import { acquireFileLockSync, releaseFileLockSync } from '../../market_adapter/utils/file_lock.js';
import { getErrorMessage } from '../utils/errors.js';

const storage = getStorage();

/** A held instance lock. release() is ownership-checked and idempotent. */
export interface BotInstanceLock {
    release(): void;
    /** Absolute path of the lock file (diagnostics/tests). */
    lockPath: string;
}

interface AcquireInstanceLockOptions {
    /** Best-effort logger (manager logger or launcher console shim). */
    log?: (message: string, level?: string) => void;
}

function sanitizeLockKey(raw: string): string {
    return String(raw || 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 64) || 'unknown';
}

function instanceLocksDir(): string {
    return PATHS.PROFILES.INSTANCE_LOCKS_DIR || path.join(PATHS.PROFILES_DIR, 'instance-locks');
}

function lockPathForAccount(account: string): string {
    return path.join(instanceLocksDir(), `${sanitizeLockKey(account)}.lock`);
}

interface LockPayload {
    pid?: number;
    botName?: string;
    account?: string;
    starttime?: number;
    at?: string;
    ownerId?: number | string;
}

function readLockPayload(lockPath: string): LockPayload | null {
    try {
        const parsed = storage.readJSON(lockPath);
        return parsed && typeof parsed === 'object' ? (parsed as LockPayload) : null;
    } catch (_) {
        return null;
    }
}

/**
 * Acquire the single-controller lock for `account`.
 *
 * Throws (never waits) when another LIVE process holds the lock — the error
 * message names the holder (pid, bot, start time) so the operator can stop the
 * right instance. A DEAD holder (crashed process, recycled pid) is detected
 * via /proc liveness + starttime match and its stale lock is taken over
 * immediately, so a PM2 restart after a crash is not blocked by its own
 * previous incarnation.
 *
 * @param {string} account - Chain account name (lock key)
 * @param {string} botName - Configured bot name (diagnostics only)
 * @param {Object} [options]
 * @returns {BotInstanceLock} Handle with release()
 */
export function acquireBotInstanceLock(account: string, botName: string = '', options: AcquireInstanceLockOptions = {}): BotInstanceLock {
    const lockPath = lockPathForAccount(account);
    const discovery = getProcessDiscovery();
    try {
        storage.ensureDir(instanceLocksDir());
    } catch (err) {
        throw new Error(`Cannot create instance-lock directory ${instanceLocksDir()}: ${getErrorMessage(err)}`);
    }

    const buildPayload = () => ({
        pid: runtime.pid,
        botName: String(botName || ''),
        account: String(account || ''),
        starttime: discovery.readStat(runtime.pid)?.starttime ?? 0,
        at: new Date().toISOString(),
    });

    const aliveCheck = (pid: number): boolean => {
        if (!discovery.isAlive(pid)) return false;
        // pid-recycle guard: the payload's starttime is the holder's boot
        // identity. A recycled pid whose /proc starttime differs is NOT the
        // holder — treat the lock as dead so a new controller can take over.
        const info = readLockPayload(lockPath);
        const holderStart = Number(info?.starttime);
        if (Number(info?.pid) === pid && holderStart > 0) {
            const stat = discovery.readStat(pid);
            if (stat && stat.starttime !== holderStart) return false;
        }
        return true;
    };

    const alreadyRunningMsg = () => {
        const info = readLockPayload(lockPath);
        const holderBot = info?.botName ? ` (bot ${info.botName})` : '';
        const holderAt = info?.at ? `, started ${info.at}` : '';
        return (
            `account '${account}' is already controlled by another bot process ` +
            `(pid ${info?.pid ?? 'unknown'}${holderBot}${holderAt}, lock: ${lockPath}). ` +
            `Stop that instance first (dexbot pm2 stop / dexbot stop) — two controllers ` +
            `on one account corrupt each other's grids and fills.`
        );
    };

    const lock = acquireFileLockSync(lockPath, {
        // Fail fast — the second controller must not wait out a live holder.
        contention: 'throw',
        // Only bounds an ALIVE-but-never-beating holder (heartbeat stopped
        // without process death); a dead holder is stolen immediately by the
        // aliveCheck above regardless of staleness.
        staleMs: 10 * 60 * 1000,
        aliveCheck,
        buildPayload,
        alreadyRunningMsg,
        timeoutMsg: `cannot acquire instance lock for account '${account}': ${lockPath}`,
    });

    options.log?.(
        `Instance lock acquired for account '${account}' (bot ${botName || 'n/a'}, pid ${runtime.pid})`,
        'info'
    );

    return {
        lockPath,
        release(): void {
            try {
                releaseFileLockSync({ fd: lock.fd, lockPath: lock.lockPath, heartbeat: lock.heartbeat, ownerId: lock.ownerId });
                options.log?.(`Instance lock released for account '${account}'`, 'info');
            } catch (err) {
                options.log?.(`Instance lock release failed for account '${account}': ${getErrorMessage(err)}`, 'warn');
            }
        },
    };
}

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
 * account's open orders and fills. Within one process, bots sharing an account
 * share one lock by bot name (monolithic shared-account mode); a DIFFERENT
 * process trying to control that account is refused.
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

interface HeldInstanceLock {
    /** The single process-level file lock shared by every bot on this account. */
    lock: BotInstanceLock;
    /** Live handle count per bot name (bot names are unique per config). */
    shares: Map<string, number>;
}

/** Logging is best-effort: a throwing logger must never leak a lock or a share. */
function _safeLog(options: AcquireInstanceLockOptions, message: string, level: string = 'info'): void {
    try { options.log?.(message, level); } catch (_) {}
}

/** One idempotent release() wrapper per acquisition, shared by both paths. */
function _lockHandle(lockPath: string, release: () => void): BotInstanceLock {
    let released = false;
    return {
        lockPath,
        release(): void {
            if (released) return;
            released = true;
            release();
        },
    };
}

let _unnamedShareSeq = 0;

/** Bot names are unique per config; unnamed callers still need distinct identities. */
function _shareIdentity(botName: string): string {
    // NUL cannot occur in a configured bot name, so generated identities can
    // never collide with a real one (e.g. a bot literally named 'unnamed-1').
    return botName || `\0unnamed-${++_unnamedShareSeq}`;
}

/**
 * Process-scoped registry of held account locks.
 *
 * The lock exists to keep TWO PROCESSES off one account. It must NOT keep two
 * bots in the SAME process apart: `dexbot start` runs every active bot in one
 * monolithic process and `dexbot.ts` pre-registers shared-account fund
 * allocations for them via fund_registry. So we hold one file lock per account
 * per process and track its in-process sharers by bot name (unique per config);
 * a second process still sees a live lock and fails fast as before. The map is
 * keyed by the RAW account name — not the sanitized lock path — so two distinct
 * accounts that sanitize to the same filename still hit the old file-lock
 * contention instead of silently sharing one controller.
 */
const _heldInstanceLocks = new Map<string, HeldInstanceLock>();

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
 * Acquire the process-level file lock for `account` (internal — the public
 * entry point below wraps this with in-process per-bot-name shares).
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
function acquireProcessInstanceLock(account: string, botName: string = '', options: AcquireInstanceLockOptions = {}): BotInstanceLock {
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

    _safeLog(options, `Instance lock acquired for account '${account}' (bot ${botName || 'n/a'}, pid ${runtime.pid})`);

    return _lockHandle(lockPath, () => {
        try {
            releaseFileLockSync({ fd: lock.fd, lockPath: lock.lockPath, heartbeat: lock.heartbeat, ownerId: lock.ownerId });
            _safeLog(options, `Instance lock released for account '${account}'`);
        } catch (err) {
            _safeLog(options, `Instance lock release failed for account '${account}': ${getErrorMessage(err)}`, 'warn');
        }
    });
}

/** Drop one handle's share; release the underlying file lock only when nobody is left. */
function _releaseSharedInstanceLock(account: string, held: HeldInstanceLock, identity: string): void {
    const count = held.shares.get(identity) ?? 0;
    if (count > 1) held.shares.set(identity, count - 1);
    else held.shares.delete(identity);
    if (held.shares.size > 0) return;
    if (_heldInstanceLocks.get(account) === held) _heldInstanceLocks.delete(account);
    // Underlying release is ownership-checked and idempotent, so a stale
    // handle cannot release a lock a later controller now owns.
    held.lock.release();
}

/**
 * Acquire the single-controller lock for `account`.
 *
 * The lock guards the account against OTHER PROCESSES. Multiple bots in this
 * process (monolithic `dexbot start` with a shared account) share one file lock
 * keyed by the account; their in-process shares are keyed by bot name, so a
 * sibling bot no longer trips the guard. The first bot acquires the file lock;
 * later bots on the same account only take a share; the file lock is released
 * when the last bot handle shuts down.
 *
 * @param {string} account - Chain account name (lock key)
 * @param {string} botName - Configured bot name (diagnostics only)
 * @param {Object} [options]
 * @returns {BotInstanceLock} Handle with release()
 */
export function acquireBotInstanceLock(account: string, botName: string = '', options: AcquireInstanceLockOptions = {}): BotInstanceLock {
    const lockPath = lockPathForAccount(account);
    const identity = _shareIdentity(botName);
    const held = _heldInstanceLocks.get(account);
    if (held) {
        held.shares.set(identity, (held.shares.get(identity) ?? 0) + 1);
        _safeLog(options, `Instance lock for account '${account}' already held by this process — sharing with bot ${botName || 'n/a'} (${held.shares.size} bots)`);
        return _lockHandle(lockPath, () => _releaseSharedInstanceLock(account, held, identity));
    }

    const lock = acquireProcessInstanceLock(account, botName, options);
    const entry: HeldInstanceLock = { lock, shares: new Map([[identity, 1]]) };
    _heldInstanceLocks.set(account, entry);
    return _lockHandle(lockPath, () => _releaseSharedInstanceLock(account, entry, identity));
}

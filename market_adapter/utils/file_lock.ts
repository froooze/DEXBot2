'use strict';

import { getErrorCode } from '../../modules/utils/errors.js';
import { getStorage } from '../../modules/storage/index.js';
import type { FileStat } from '../../modules/storage/types.js';
import type { UnknownRecord } from '../../modules/types.js';
import { getProcessDiscovery } from '../../modules/process_discovery.js';
import { runtime } from '../../modules/runtime.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
const storage = getStorage();
const { readJSON, unlink: safeUnlink } = storage;

interface AcquireLockOptions {
    staleMs?: number;
    timeoutMs?: number;
    retryMs?: number;
    maxAttempts?: number;
    contention?: 'throw' | 'wait';
    aliveCheck?: ((pid: number) => boolean) | null;
    buildPayload?: () => UnknownRecord;
    alreadyRunningMsg?: string | (() => string);
    timeoutMsg?: string;
}

interface AcquiredLock {
    fd: number | null;
    lockPath: string;
    heartbeat: ReturnType<typeof setInterval> | null;
    ownerId: number | string;
}

/**
 * Identity token for a lock acquisition. Always unique per acquire — NOT the
 * pid — so release-time token comparison stays correct even where pids can
 * collide across holders (e.g. containers sharing a mounted volume). The
 * composite fallback covers runtimes without crypto.randomUUID.
 */
function _lockOwnerId(): number | string {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    return `lock-${runtime.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadLockInfo(lockPath: string): UnknownRecord {
    try {
        const parsed = readJSON(lockPath);
        return parsed && typeof parsed === 'object' ? parsed as UnknownRecord : {};
    } catch (_) {
        return {};
    }
}

function isLikelyMarketAdapterProcess(pid: number): boolean {
    if (!getProcessDiscovery().isAlive(pid)) return false;
    const cmdline = getProcessDiscovery().readCmdline(pid);
    if (!cmdline) return false;
    // Market adapter holders run either standalone (market_adapter.ts) or
    // embedded in the dexbot runtime (runOnceForAma inside dexbot/bot/pm2
    // entrypoints). Matching both prevents a live holder's lock from being
    // stolen just because its cmdline does not name market_adapter directly.
    // Entrypoint names are anchored to an argv/path boundary so unrelated
    // scripts whose name merely CONTAINS one of them ("robot.js") do not
    // match; the failure mode without the anchor would be refusing to steal
    // genuinely stale locks.
    return cmdline.includes('node')
        && (/market_adapter[\\\/]market_adapter\.(?:js|ts)\b|(?:^|[\s\/\\])(?:dexbot|bot|pm2|credential-daemon|unlock)\.(?:js|ts)\b/.test(cmdline));
}

function sleepSync(ms: number): void {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
}

function sleepAsync(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isLockStaleOrDead(lockPath: string, staleMs: number, now: number, aliveCheck: ((pid: number) => boolean) | null): boolean {
    let stat: FileStat | null = null;
    try {
        stat = storage.stat(lockPath);
    } catch (_) {
        return true;
    }
    if ((now - stat.mtimeMs) > staleMs) return true;
    if (aliveCheck) {
        const info = loadLockInfo(lockPath);
        const pid = Number(info.pid);
        // Non-numeric owner ids (UUID fallback when runtime.pid is unusable)
        // cannot be liveness-checked — treat the holder as alive rather than
        // stealing a lock we cannot verify.
        if (!Number.isInteger(pid) || pid <= 0) return false;
        if (!aliveCheck(pid)) return true;
    }
    return false;
}

interface ResolvedLockPayload {
    ownerId: number | string;
    buildPayload: () => UnknownRecord;
    resolveRunningMsg: () => string;
    timeoutMsg: string;
}

/**
 * Resolve the ownership token, payload builder, and lazy error messages shared
 * by the sync and async lock cores.
 */
function _resolveLockPayload(lockPath: string, opts: AcquireLockOptions, timeoutMs: number): ResolvedLockPayload {
    const ownerId = _lockOwnerId();
    const buildPayloadFn = opts.buildPayload;
    const buildPayload = typeof buildPayloadFn === 'function'
        ? () => ({ ...buildPayloadFn(), ownerId })
        : () => ({ pid: runtime.pid, at: Date.now(), ownerId });
    const alreadyRunningMsg = opts.alreadyRunningMsg;
    const resolveRunningMsg = typeof alreadyRunningMsg === 'function'
        ? alreadyRunningMsg
        : () => (alreadyRunningMsg || `already locked: `);
    const timeoutMsg = opts.timeoutMsg || `Could not acquire lock on ${lockPath} within ${timeoutMs}ms`;
    return { ownerId, buildPayload, resolveRunningMsg, timeoutMsg };
}

/**
 * Shared file-lock primitive.
 *
 * Collapses the previous three lock variants (market-adapter lifecycle lock,
 * per-path short-lived lock, async per-path lock) into one EEXIST / stale-mtime
 * / unlink / retry loop. Behavior is parameterized via opts:
 *
 *   staleMs          - lock age (mtime) after which a lock is considered stale
 *   timeoutMs        - hard deadline; default Infinity (bounded by maxAttempts)
 *   retryMs          - sleep between failed attempts (0 = busy retry)
 *   maxAttempts      - cap on attempts (default Infinity)
 *   contention       - 'throw' | 'wait' when a fresh live lock is found
 *   aliveCheck       - fn(pid) => boolean; when false the lock may be stolen
 *   heartbeatMs      - derived internally as clamp(staleMs/2, 1s..30s) so the
 *                      beat always fires strictly inside the staleness window
 *   buildPayload     - fn() => object written into the lock file
 *   alreadyRunningMsg / timeoutMsg - error message string, or fn() => string
 *                      (evaluated lazily at throw time, so e.g. the pid is read
 *                      from the lock file only when contention is actually hit)
 */
function _acquireLockCore(lockPath: string, opts: AcquireLockOptions = {}): AcquiredLock {
    const staleMs = typeof opts.staleMs === 'number' && Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : Infinity;
    const retryMs = typeof opts.retryMs === 'number' && Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 0;
    const maxAttempts = typeof opts.maxAttempts === 'number' && Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : Infinity;
    const contention = opts.contention === 'wait' ? 'wait' : 'throw';
    const aliveCheck = typeof opts.aliveCheck === 'function' ? opts.aliveCheck : null;
    // The heartbeat must fire strictly inside the staleness window, otherwise a
    // live-held lock looks stale between beats and can be stolen.
    const heartbeatMs = Math.min(
        MARKET_ADAPTER.FILE_LOCK_HEARTBEAT_MAX_MS,
        Math.max(MARKET_ADAPTER.FILE_LOCK_HEARTBEAT_MIN_MS, Math.floor(staleMs / 2))
    );
    const { ownerId, buildPayload, resolveRunningMsg, timeoutMsg } = _resolveLockPayload(lockPath, opts, timeoutMs);

    const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Infinity;
    let attempts = 0;

    while (attempts < maxAttempts && Date.now() < deadline) {
        let fd: number | null = null;
        let acquiredThisIteration = false;
        try {
            fd = storage.open(lockPath, 'wx');
            acquiredThisIteration = true;
            storage.write(fd, `${JSON.stringify(buildPayload(), null, 2)}\n`);
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            if (heartbeatMs > 0) {
                heartbeat = setInterval(() => {
                    try {
                        const ts = new Date();
                        storage.utimes(lockPath, ts, ts);
                    } catch (_) {}
                }, heartbeatMs);
                if (typeof heartbeat.unref === 'function') heartbeat.unref();
            }
            return { fd, lockPath, heartbeat, ownerId };
        } catch (err) {
            if (fd !== null) {
                try { storage.close(fd); } catch (_) {}
            }
            if (acquiredThisIteration) {
                // We created the file but failed to write the payload (e.g.
                // ENOSPC). Remove the orphaned lock we just created so we do
                // not lock out every later contender with a "fresh" lock file.
                try { safeUnlink(lockPath); } catch (_) {}
            }
            if (getErrorCode(err) !== 'EEXIST') throw err;

            attempts++;
            if (_isLockStaleOrDead(lockPath, staleMs, Date.now(), aliveCheck)) {
                safeUnlink(lockPath);
                if (retryMs > 0) sleepSync(retryMs);
                continue;
            }
            if (contention === 'wait') {
                if (retryMs > 0) sleepSync(retryMs);
                continue;
            }
            throw new Error(resolveRunningMsg());
        }
    }

    throw new Error(timeoutMsg);
}

/**
 * Release helper shared by the sync/async variants: only unlink the lock file
 * when it still carries our ownership token. If the token differs (our stale
 * lock was already stolen and re-created by another process) the file belongs
 * to someone else and must be left alone.
 */
function _releaseOwnedLock(lockPath: string, ownerId: number | string | null | undefined, unlinkFn: (p: string) => void): boolean {
    const info = loadLockInfo(lockPath);
    if (info && info.ownerId != null && ownerId != null && info.ownerId !== ownerId) return false;
    unlinkFn(lockPath);
    return true;
}

async function _acquireLockCoreAsync(lockPath: string, opts: AcquireLockOptions = {}): Promise<() => void> {
    const staleMs = typeof opts.staleMs === 'number' && Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    const retryMs = typeof opts.retryMs === 'number' && Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 50;
    const aliveCheck = typeof opts.aliveCheck === 'function' ? opts.aliveCheck : null;
    const { ownerId, buildPayload, resolveRunningMsg, timeoutMsg } = _resolveLockPayload(lockPath, opts, timeoutMs);

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            storage.writeJSON(lockPath, buildPayload(), { flag: 'wx' });
            return () => {
                _releaseOwnedLock(lockPath, ownerId, (p: string) => storage.unlink(p));
            };
        } catch (err) {
            if (getErrorCode(err) !== 'EEXIST') {
                // A non-EEXIST failure may have left a partially written lock
                // file behind — clean it up if it still carries our token.
                try {
                    _releaseOwnedLock(lockPath, ownerId, (p: string) => safeUnlink(p));
                } catch (_) {}
                throw err;
            }
            if (_isLockStaleOrDead(lockPath, staleMs, Date.now(), aliveCheck)) {
                try {
                    try { storage.unlink(lockPath); } catch (_) {}
                    storage.writeJSON(lockPath, buildPayload(), { flag: 'wx' });
                    return () => {
                        _releaseOwnedLock(lockPath, ownerId, (p: string) => storage.unlink(p));
                    };
                } catch {
                    // Another writer beat us — fall through and retry
                }
                await sleepAsync(retryMs);
                continue;
            }
            if (aliveCheck) {
                throw new Error(resolveRunningMsg());
            }
            await sleepAsync(retryMs);
        }
    }

    throw new Error(timeoutMsg);
}

/**
 * Market-adapter lifecycle lock: long stale window + heartbeat + process-aware
 * ownership check, so a live adapter lock is never stolen by a newer process.
 */
function acquireFileLockSync(lockPath: string, opts: AcquireLockOptions = {}): AcquiredLock {
    const staleMs = typeof opts.staleMs === 'number' && Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : (6 * 3600 * 1000);
    return _acquireLockCore(lockPath, {
        staleMs,
        maxAttempts: 2,
        retryMs: 0,
        contention: 'throw',
        aliveCheck: isLikelyMarketAdapterProcess,
        // The payload's `pid` is display metadata for this message; the
        // release-time identity token is the core-injected `ownerId` (always a
        // fresh unique id, never reused across acquires).
        buildPayload: () => ({ pid: runtime.pid, createdAt: new Date().toISOString() }),
        // Evaluated lazily at throw time so the reported pid reflects the lock
        // holder at the moment contention is detected, not the state when this
        // function was first called (loadLockInfo tolerates a missing lock file).
        alreadyRunningMsg: () => `market adapter already running (lock: ${lockPath}, pid: ${loadLockInfo(lockPath).pid ?? 'unknown'})`,
        timeoutMsg: `cannot acquire lock: ${lockPath}`,
    });
}

function releaseFileLockSync(lock: { heartbeat?: ReturnType<typeof setInterval> | null; fd?: number | null; lockPath?: string; ownerId?: number | string } | null): void {
    if (!lock) return;
    try { if (lock.heartbeat) clearInterval(lock.heartbeat); } catch (_) {}
    try { if (typeof lock.fd === 'number') storage.close(lock.fd); } catch (_) {}
    if (lock.lockPath) {
        // Ownership-checked release: if our lock was stolen and re-created by
        // another process, leave the new holder's lock file alone.
        _releaseOwnedLock(lock.lockPath, lock.ownerId, (p: string) => safeUnlink(p));
    }
}

/**
 * Short-lived per-path lock (e.g. dynamic grid snapshots): waits for the holder
 * to release (or for the lock to go stale) up to timeoutMs.
 */
function acquirePathLockSync(filePath: string, opts: AcquireLockOptions = {}): AcquiredLock {
    const lockPath = `${filePath}.lock`;
    const staleMs = typeof opts.staleMs === 'number' && Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    const retryMs = typeof opts.retryMs === 'number' && Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 50;
    const lock = _acquireLockCore(lockPath, {
        staleMs,
        timeoutMs,
        retryMs,
        contention: 'wait',
        timeoutMsg: `Could not acquire lock on ${filePath} within ${timeoutMs}ms`,
    });
    return { fd: lock.fd, lockPath: lock.lockPath, heartbeat: lock.heartbeat, ownerId: lock.ownerId };
}

async function acquireFileLock(filePath: string, opts: AcquireLockOptions = {}): Promise<() => void> {
    const lockPath = `${filePath}.lock`;
    const staleMs = typeof opts.staleMs === 'number' && Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    return _acquireLockCoreAsync(lockPath, {
        staleMs,
        timeoutMs,
        aliveCheck: opts.aliveCheck,
        contention: 'wait',
        timeoutMsg: `Could not acquire lock on ${filePath} within ${timeoutMs}ms`,
    });
}

export { acquireFileLockSync, releaseFileLockSync, acquirePathLockSync, acquireFileLock, isLikelyMarketAdapterProcess };

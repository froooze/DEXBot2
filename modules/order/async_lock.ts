/**
 * modules/order/async_lock.ts - AsyncLock Engine
 *
 * Distributed mutual exclusion for async operations.
 * Exports the AsyncLock class (the lock itself) plus the `acquireIfNotHeld()`
 * re-entrancy guard that call sites delegate through instead of inlining the
 * `isReentrant()` check-and-acquire.
 *
 * Solves the Time-of-Check vs Time-of-Use (TOCTOU) race condition
 * where checking a flag and setting it are not atomic operations.
 *
 * In JavaScript async code, multiple callbacks can interleave between
 * check and set operations. This lock ensures only one caller can
 * enter a critical section at a time, with fair FIFO queueing.
 *
 * Usage:
 *   const lock = new AsyncLock();
 *
 *   const result = await lock.acquire(async () => {
 *       // Critical section - guaranteed only one execution at a time
 *       // Even if other callers check lock while this runs, they will wait
 *       return someAsyncOperation();
 *   });
 *
 * ===============================================================================
 * TABLE OF CONTENTS - AsyncLock Class (8 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor() - Create new AsyncLock with empty queue and unlocked state
 *
 * LOCK ACQUISITION (1 method)
 *   2. acquire(callback) - Acquire lock and execute callback exclusively (async)
 *      Returns promise that resolves with callback result
 *      Queues request if lock is already held, processes in FIFO order
 *
 * QUEUE PROCESSING (1 method - internal)
 *   3. _processQueue() - Process queued callbacks one at a time (async, internal)
 *      Marks as locked, executes callback, handles errors, unlocks, processes next
 *      Recursive: processes next item after each callback completes
 *
 * STATUS QUERIES (4 methods)
 *   4. isLocked() - Check if lock is currently acquired
 *   5. heldForMs() - Milliseconds the lock has been held (0 when free)
 *   6. isReentrant() - Whether the current async context already holds the lock
 *   7. getQueueLength() - Get number of operations waiting for lock
 *
 * LOCK RELEASE (1 method)
 *   8. forceRelease() - Force-release the lock, rejecting every queued waiter
 *      (used by shutdown/cleanup paths; returns whether it was held)
 *
 * MODULE-LEVEL EXPORT:
 *   acquireIfNotHeld(lock, fn) - Run `fn` under `lock` unless the current async
 *      context already holds it (canonical re-entrancy guard)
 *
 * ===============================================================================
 *
 * RACE CONDITION PREVENTION:
 * Problem: Check-then-act is not atomic in async code:
 *   if (!locked) {
 *       locked = true;  // <-- Another callback can run here!
 *       doWork();
 *   }
 *
 * Solution: FIFO queue with exclusive execution:
 *   1. Queue callback and handlers
 *   2. Set _locked = true (prevents concurrent entry)
 *   3. Execute callback (guaranteed alone)
 *   4. Set _locked = false and process next queued item
 *
 * REENTRANCY:
 * This lock IS reentrant. If a function holding the lock calls acquire()
 * again (nested call), the callback is executed immediately without
 * queueing. This eliminates the need for callers to track whether they
 * already hold the lock via external flags.
 *
 * Re-entrancy detection uses AsyncLocalStorage (Node.js) to distinguish
 * truly nested calls (same async context) from separate concurrent
 * callers. The store tracks a Set of all lock IDs held in the current
 * async context chain, preserving outer lock identity across nested
 * acquisitions. If AsyncLocalStorage is unavailable in the current
 * runtime (e.g. a browser bundle shim), the lock falls back to a
 * _syncPrologue check that ONLY treats a call made
 * synchronously inside the holder's own callback prologue as re-entrant;
 * any other call while the lock is held is queued, so mutual exclusion
 * is preserved (the previous fallback treated every concurrent caller as
 * re-entrant and ran it immediately, silently allowing overlapping
 * critical sections).
 *
 * CRITICAL INVARIANTS:
 * - _locked = true ONLY if callback is currently executing
 * - At most one callback in "await callback()" at any time
 * - All queued callbacks are guaranteed exclusive access
 * - If _locked = false and queue is empty, no operations pending
 *
 * ===============================================================================
 *
 * @class
 */



import { createRequire } from 'node:module';
import { hasProcess } from '../env.js';
interface QueueItem<T = unknown> {
    callback: () => Promise<T>;
    cancelToken?: { isCancelled: boolean };
    resolve(value: T): void;
    reject(reason: unknown): void;
    timer?: ReturnType<typeof setTimeout>;
}

interface AsyncLockOptions {
    timeout?: number;
    onContention?: () => void;
}

interface AcquireOptions {
    timeout?: number;
    cancelToken?: { isCancelled: boolean };
    onContention?: () => void;
}

interface AsyncLocalStorageLike {
    getStore(): Set<symbol> | undefined;
    run<T>(store: Set<symbol>, fn: () => T): T;
}
type AsyncLocalStorageCtor = new () => AsyncLocalStorageLike;
let _AsyncLocalStorage: AsyncLocalStorageCtor | null;
const _nodeRequire = createRequire(import.meta.url);
// Escape hatch (tests + browser-bundle shim verification): force the no-ALS
// fallback so the mutual-exclusion path that cannot detect re-entrancy is
// exercised. Read at module-load time — must be set before the module loads.
const _forceNoAls = hasProcess() && process.env?.DEXBOT_DISABLE_ASYNC_LOCAL_STORAGE === '1';
if (_nodeRequire && !_forceNoAls) {
    try {
        _AsyncLocalStorage = _nodeRequire('node:async_hooks')?.AsyncLocalStorage;
    } catch {
        _AsyncLocalStorage = null;
    }
} else {
    _AsyncLocalStorage = null;
}
const _lockCtx = _AsyncLocalStorage ? new _AsyncLocalStorage() : null;

class AsyncLock {
    private _queue: QueueItem<unknown>[];
    private _locked: boolean;
    private _holding: boolean;
    private _syncPrologue: boolean;
    private _generation: number;
    private _heldSince: number;
    private _defaultTimeout: number | null;
    private _onContention: (() => void) | null;
    private readonly _lockId: symbol;
    private _orphaned: boolean;

    constructor(options: AsyncLockOptions = {}) {
        this._queue = [];
        this._locked = false;
        this._holding = false;
        this._syncPrologue = false;
        this._generation = 0;
        this._heldSince = 0;
        this._defaultTimeout = options.timeout || null;
        this._onContention = options.onContention || null;
        this._lockId = Symbol('AsyncLock');
        this._orphaned = false;
    }

    /**
     * Acquire the lock and execute callback exclusively
     * @param {Function} callback - Async function to execute exclusively
     * @param {Object} [options] - Optional settings
     * @param {number} [options.timeout] - Optional timeout in ms for waiting in queue
     * @param {Object} [options.cancelToken] - Optional object with 'isCancelled' property
     * @returns {Promise} Result of callback execution
     */
    async acquire<T>(callback: () => Promise<T>, options: AcquireOptions = {}): Promise<T> {
        // Re-entrant detection: if we are already inside this lock's execution
        // context, run the callback directly. Uses AsyncLocalStorage (Node.js)
        // to distinguish truly nested calls from separate concurrent callers.
        // Without AsyncLocalStorage the lock falls back to a _syncPrologue
        // check: a call is only treated as nested when it happens
        // synchronously inside this lock's own callback prologue. A concurrent
        // caller arriving while the holder is suspended at an await (so
        // _syncPrologue === false) is QUEUED, preserving mutual exclusion
        // (the old fallback ran every concurrent
        // caller immediately, silently allowing overlapping critical sections).
        // Async-nested calls in the no-ALS fallback are not detected and wait
        // for the lock they already hold until the timeout — a fail-safe stall
        // (bounded, logged by the caller), never a concurrent execution.
        const contextSet: Set<symbol> | undefined = _lockCtx ? _lockCtx.getStore() : undefined;
        if ((contextSet && contextSet.has(this._lockId)) || (!_lockCtx && this._syncPrologue)) {
            return callback();
        }

        const timeout = options.timeout || this._defaultTimeout;
        const cancelToken = options.cancelToken;

        const wrappedCallback = _lockCtx
            ? () => {
                const prevSet: Set<symbol> = _lockCtx.getStore() || new Set();
                const newSet = new Set(prevSet);
                newSet.add(this._lockId);
                return _lockCtx.run(newSet, callback);
              }
            : () => {
                // Mark this lock's callback as inside its synchronous prologue
                // so a nested acquire() before the first await is recognized as
                // re-entrant. Cleared as soon as callback() returns its promise
                // (the first await), so concurrent callers that arrive while
                // the holder is suspended queue instead of auto-running.
                this._syncPrologue = true;
                try {
                    return callback();
                } finally {
                    this._syncPrologue = false;
                }
              };

        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            const item = {
                callback: wrappedCallback,
                cancelToken,
                resolve: (val: T) => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = undefined;
                    }
                    resolve(val);
                },
                reject: (err: unknown) => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = undefined;
                    }
                    reject(err);
                }
            };

            if (timeout) {
                timer = setTimeout(() => {
                    const index = this._queue.indexOf(item);
                    if (index !== -1) {
                        this._queue.splice(index, 1);
                        item.reject(new Error(`Lock acquisition timeout after ${timeout}ms`));
                    }
                }, timeout);
            }

            this._queue.push(item);
            this._processQueue();
            // After _processQueue returns, if the queue is non-empty, our
            // item could not run immediately and is waiting — that is
            // contention (the lock is held by another context, or there are
            // other waiters ahead of us). Calls that take the re-entrant
            // path (re-entrant check at the top) never reach here.
            // Note: the re-entrant path means this callback will miss the
            // common nested-call pattern; the gridLockContention metric
            // therefore only captures external contention (different async
            // contexts competing for the same lock), not re-entrant usage.
            if (this._queue.length > 0) {
                const cb = options.onContention || this._onContention;
                if (cb) cb();
            }
        });
    }

    /**
     * Process queued callbacks one at a time
     * @private
     */
    private async _processQueue(): Promise<void> {
        // If already locked, another call is executing, wait
        if (this._locked || this._queue.length === 0) {
            return;
        }

        // Mark as locked to prevent concurrent processing
        this._locked = true;

        const { callback, resolve, reject, cancelToken } = this._queue.shift()!;

        // If operation was cancelled while in queue, skip it
        if (cancelToken && cancelToken.isCancelled) {
            this._locked = false;
            reject(new Error('Lock acquisition cancelled (timeout)'));
            // Process next item immediately
            return this._processQueue();
        }

        const generation = ++this._generation;
        this._holding = true;
        this._heldSince = Date.now();

        try {
            // Execute the callback (guaranteed to be alone)
            const result = await callback();
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            this._holding = false;
            // Only release the lock if generation matches — if forceRelease
            // was called while this callback was running, the generation was
            // incremented and we must not touch _locked (a new acquirer may
            // be using it). The stale callback exits silently.
            if (generation === this._generation) {
                this._locked = false;
                this._heldSince = 0;
                this._processQueue();
            } else if (this._orphaned) {
                // Stale callback finishing after forceRelease. The
                // forceRelease deferred _locked = false to us via the
                // _orphaned flag. Release the lock so queued callbacks
                // can proceed. This prevents concurrent execution: the
                // stale callback continues to hold _locked until it
                // finishes, blocking any new acquirer.
                this._orphaned = false;
                this._locked = false;
                this._heldSince = 0;
                this._processQueue();
            }
            // After a callback completes, if there are still queued items
            // (but the previous _locked=false path already called
            // _processQueue which started the next one), check whether
            // items remain after _processQueue's shift. This catches
            // contention in deeply nested re-entrant patterns.
            if (this._queue.length > 0 && this._onContention) {
                this._onContention();
            }
        }
    }

    /**
     * Duration the lock has been held by its current callback.
     * Returns 0 when the lock is not held. Observability only: callers use
     * this to detect an over-long critical section, not to preempt it.
     * @returns {number} Milliseconds since the callback began, or 0
     */
    heldForMs(): number {
        return this._locked && this._heldSince ? Date.now() - this._heldSince : 0;
    }

    /**
     * Check if lock is currently acquired
     * @returns {boolean}
     */
    isLocked(): boolean {
        return this._locked;
    }

    /**
     * Check if the current execution context already holds this lock.
     * When true, callers can skip lock acquisition because the callback
     * would execute immediately via the re-entrant path anyway.
     */
    isReentrant(): boolean {
        if (_lockCtx) {
            const store: Set<symbol> | undefined = _lockCtx.getStore();
            return store ? store.has(this._lockId) : false;
        }
        // No-ALS fallback: only a call inside this lock's synchronous callback
        // prologue is re-entrant. Concurrent callers report false, so callers
        // that skip acquisition based on isReentrant() fall back to a real
        // (queueing) acquire instead of running unlocked.
        return this._syncPrologue;
    }

    /**
     * Get number of operations waiting for lock
     * @returns {number}
     */
    getQueueLength(): number {
        return this._queue.length;
    }

    /**
     * Force-release the lock and clear all queued operations.
     * Resets both the locked state AND the queue. Use when an operation has
     * timed out but the underlying callback may still be running — subsequent
     * acquirers will be allowed in while the stale callback eventually
     * completes and is silently ignored via the generation-guard in
     * _processQueue's finally block.
     *
     * SAFETY: The generation counter (_generation) is bumped before the
     * queue is cleared. When the stale callback's finally block runs, it
     * compares its captured generation against the current value — a
     * mismatch means the lock was force-released since acquire, so it
     * skips touching _locked / _processQueue entirely. This prevents the
     * stale callback from interfering with a new acquirer that claimed
     * the lock after forceRelease.
     *
     * CONCURRENT EXECUTION GUARD: If a callback is currently executing
     * (_holding is true), forceRelease defers _locked = false to the
     * stale callback's finally block via the _orphaned flag. This
     * prevents a new acquirer from entering while the stale callback
     * is still running, preserving mutual exclusion.
     *
     * REPEATED CALLS: While an orphan release is pending (_orphaned),
     * the deferred unlock is owned by the stale callback's finally
     * block; a repeated forceRelease clears the queue and bumps the
     * generation but leaves _locked untouched so it cannot break
     * exclusion by releasing the lock ahead of that pending orphan.
     *
     * @returns {number} Count of cleared items
     */
    forceRelease(): number {
        const count = this._queue.length;
        // Increment generation to invalidate any in-flight callback's
        // finally block — it will see generation mismatch and skip
        // touching _locked / _processQueue.
        this._generation++;
        const wasHolding = this._holding;
        this._holding = false;
        while (this._queue.length > 0) {
            const { reject, timer } = this._queue.shift()!;
            if (timer) clearTimeout(timer);
            reject(new Error('Lock force-released'));
        }
        if (this._orphaned) {
            // An earlier forceRelease already deferred the unlock to an
            // orphaned callback's finally block — do not clear _locked here.
            return count;
        }
        if (wasHolding) {
            // A callback is currently executing — defer lock release to
            // the stale callback's finally block, which detects the
            // orphan state via generation mismatch + _orphaned flag and
            // releases _locked when done. This prevents concurrent
            // execution between the stale callback and a new acquirer.
            this._orphaned = true;
        } else {
            this._locked = false;
            this._heldSince = 0;
        }
        return count;
    }
}

/**
 * Acquire `lock` around `fn` unless the caller already holds it (re-entrant)
 * or the lock is unavailable.
 *
 * Canonical re-entrancy guard for the shared _fillProcessingLock chokepoints:
 * callers that must never run concurrently with the fill consumer but that are
 * legitimately re-invoked from inside the lock (e.g. uncertain-broadcast
 * reconciliation, open-orders sync) delegate through this helper instead of
 * inlining `if (lock && !lock.isReentrant()) return lock.acquire(fn)`.
 * Centralizing the check-and-acquire keeps every future call site correct by
 * construction (no accidental lock bypass when the lock is present).
 *
 * @param {unknown} lock - AsyncLock (or lock-like { acquire, isReentrant }) to guard with
 * @param {() => Promise<T>} fn - Work to run exclusively; when the lock is held
 *   by the caller it runs directly (re-entrant)
 * @returns {Promise<T>}
 */
export function acquireIfNotHeld<T>(lock: { acquire<T>(fn: () => Promise<T>): Promise<T>; isReentrant(): boolean } | null | undefined, fn: () => Promise<T>): Promise<T> {
    if (lock && typeof lock.acquire === 'function' && !lock.isReentrant()) {
        return lock.acquire(fn);
    }
    return fn();
}

export default AsyncLock

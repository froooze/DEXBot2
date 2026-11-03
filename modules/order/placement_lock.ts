/**
 * modules/order/placement_lock.ts - Exclusive placement region
 *
 * One mutex shared by EVERY chain-mutating placement path (COW batches,
 * startup reconcile Phase 2, correction drains). The broadcast refcount in
 * OrderManager (startBroadcasting/stopBroadcasting) only tells fills to stand
 * aside; it does NOT stop two placement paths from broadcasting at the same
 * time. When two paths plan from the same chain snapshot but from different
 * masters (one update-first, one create-first) both generations can land at
 * identical prices — the duplicate-order incident this lock closes.
 *
 * Design notes:
 * - Token based (acquire returns a release lease) so callers can hold the
 *   region across a multi-chunk broadcast without wrapping the whole method
 *   in a callback.
 * - NOT reentrant. Placement paths do not nest: the COW re-plan calls
 *   performSafeRebalance, which only *observes* the lock (defers), it never
 *   acquires it. Keep that invariant if a new caller is added.
 * - FIFO queue with a bounded wait. A waiter that times out or observes
 *   shutdown gets `null` and MUST abort its batch instead of broadcasting.
 */

export interface PlacementLease {
    kind: string;
    release(): void;
}

export interface PlacementAcquireOptions {
    timeoutMs?: number;
    isShuttingDown?: () => boolean;
}

/**
 * Minimal manager surface needed by {@link withPlacement}. Kept structural so
 * callers in utils/ can use it without importing OrderManager (cycle safety).
 */
export interface PlacementCapableManager {
    acquirePlacement?(kind: string, options?: PlacementAcquireOptions): Promise<PlacementLease | null>;
    tryAcquirePlacement?(kind: string): PlacementLease | null;
    isPlacementActive?(): boolean;
    placementKind?(): string | null;
}

/** Used when the caller has no lock (dry-run mocks / browser shims). */
const NOOP_PLACEMENT_LEASE: PlacementLease = { kind: 'noop', release: () => { /* no lock */ } };

/**
 * Run `fn` inside the exclusive placement region.
 *
 * This is the single entry point every chain-mutating placement path should
 * use (COW broadcast, startup reconcile Phase 2, correction drains, dust /
 * residual cancels, pool swaps). It centralizes the acquire/release contract
 * so a path cannot forget to release, and it accepts an existing lease for
 * nested calls (a COW batch holds the region across its pre-batch correction
 * drain, so the drain must reuse that lease instead of deadlocking).
 *
 * @returns `null` when the region could not be acquired (timeout/shutdown);
 *   callers must abort/defer their broadcast in that case.
 */
export async function withPlacement<T>(
    manager: PlacementCapableManager | null | undefined,
    kind: string,
    fn: (lease: PlacementLease) => Promise<T>,
    options: PlacementAcquireOptions & { lease?: PlacementLease | null } = {}
): Promise<T | null> {
    if (options.lease) return await fn(options.lease);
    if (!manager || typeof manager.acquirePlacement !== 'function') {
        return await fn(NOOP_PLACEMENT_LEASE);
    }
    const acquireOptions: PlacementAcquireOptions = {
        ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.isShuttingDown ? { isShuttingDown: options.isShuttingDown } : {}),
    };
    const lease = await manager.acquirePlacement(kind, acquireOptions);
    if (!lease) return null;
    try {
        return await fn(lease);
    } finally {
        lease.release();
    }
}

interface PlacementWaiter {
    kind: string;
    resolve: (lease: PlacementLease | null) => void;
    timer: ReturnType<typeof setTimeout> | null;
}

class PlacementLock {
    _holder: string | null;
    _since: number;
    _waiters: PlacementWaiter[];
    _token: number;
    _onRegionEnd: (() => void) | null;

    constructor(onRegionEnd?: () => void) {
        this._holder = null;
        this._since = 0;
        this._waiters = [];
        this._token = 0;
        this._onRegionEnd = typeof onRegionEnd === 'function' ? onRegionEnd : null;
    }

    _notifyRegionEnd(): void {
        if (!this._onRegionEnd) return;
        try {
            this._onRegionEnd();
        } catch { /* listener errors must never escape a release */ }
    }

    isHeld(): boolean {
        return this._holder !== null;
    }

    kind(): string | null {
        return this._holder;
    }

    heldForMs(): number {
        return this._holder !== null && this._since > 0 ? Date.now() - this._since : 0;
    }

    queueLength(): number {
        return this._waiters.length;
    }

    /**
     * Acquire the exclusive placement region.
     * Resolves with a lease, or null when the wait timed out / shutdown began.
     */
    async acquire(kind: string, options: PlacementAcquireOptions = {}): Promise<PlacementLease | null> {
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
            ? Number(options.timeoutMs)
            : 30000;
        const isShuttingDown = typeof options.isShuttingDown === 'function'
            ? options.isShuttingDown
            : () => false;

        if (isShuttingDown()) return null;

        if (this._holder === null) {
            this._holder = kind;
            this._since = Date.now();
            this._token += 1;
            return this._makeLease(kind, this._token);
        }

        return await new Promise<PlacementLease | null>((resolve) => {
            const waiter: PlacementWaiter = { kind, resolve, timer: null };
            waiter.timer = setTimeout(() => {
                const idx = this._waiters.indexOf(waiter);
                if (idx >= 0) this._waiters.splice(idx, 1);
                resolve(null);
            }, timeoutMs);
            this._waiters.push(waiter);
            if (isShuttingDown()) {
                const idx = this._waiters.indexOf(waiter);
                if (idx >= 0) this._waiters.splice(idx, 1);
                if (waiter.timer) clearTimeout(waiter.timer);
                resolve(null);
            }
        });
    }

    /**
     * Non-blocking acquire used by paths that must defer instead of queue.
     * @returns a lease when the region was free, otherwise null.
     */
    tryAcquire(kind: string): PlacementLease | null {
        // Fairness: never barge ahead of waiters queued behind the holder.
        // Otherwise a rapid try-acquire loop can starve a bounded waiter until
        // its timeout even though the region is momentarily free.
        if (this._holder !== null || this._waiters.length > 0) return null;
        this._holder = kind;
        this._since = Date.now();
        this._token += 1;
        return this._makeLease(kind, this._token);
    }

    /**
     * Force-release the region on shutdown: every waiter resolves null and the
     * current holder's lease becomes a no-op. A hung broadcast can never block
     * process exit on this lock.
     */
    forceRelease(): void {
        const waiters = this._waiters.splice(0, this._waiters.length);
        for (const waiter of waiters) {
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve(null);
        }
        this._holder = null;
        this._since = 0;
        this._token += 1;
        this._notifyRegionEnd();
    }

    _makeLease(kind: string, token: number): PlacementLease {
        let released = false;
        return {
            kind,
            release: () => {
                if (released) return;
                released = true;
                this._release(token);
            },
        };
    }

    _release(token: number): void {
        // Stale-lease guard: a lease released after forceRelease (or after the
        // lock was re-acquired by someone else) must NOT release the current
        // holder. Only the token that still owns the region may release it.
        if (token !== this._token || this._holder === null) return;
        const next = this._waiters.shift();
        if (!next) {
            this._holder = null;
            this._since = 0;
            this._token += 1;
            // The region is fully free: wake any fill/rebalance that deferred
            // on isPlacementActive(). A handoff keeps the region contiguous and
            // must NOT wake intermediate work.
            this._notifyRegionEnd();
            return;
        }
        if (next.timer) clearTimeout(next.timer);
        this._holder = next.kind;
        this._since = Date.now();
        this._token += 1;
        next.resolve(this._makeLease(next.kind, this._token));
    }
}

export default PlacementLock;

/**
 * modules/order/lifecycle.ts - Order Lifecycle Registry
 *
 * ONE owner for "does this order exist on chain, and how sure are we?".
 *
 * The engine used to answer that question from seven independent structures,
 * each with its own clock:
 *
 *   - `_pendingBroadcasts`      (fingerprint -> entry,  PENDING_BROADCAST_TTL_MS)
 *   - `createUncertain`         (slot flag,             persisted, no clock)
 *   - `_committedOrderIds`      (Set + built-at stamp,  SYNC_LOCK_TIMEOUT_MS)
 *   - `_orderIdAssignedAt`      (orderId -> ts,         no clock)
 *   - `_placedAt`               (orderId -> ts,         SURPLUS_CANCEL_GRACE_MS)
 *   - `_chainSizeAppliedFills`  (orderId -> marker,     CHAIN_SIZE_APPLIED_MARKER_TTL_MS)
 *   - `_lastUnmatchedChainOrders` (array,               no clock)
 *
 * Four read sites consulted four different subsets and could therefore give
 * four different answers for the same order. That disagreement is the bug
 * class this module removes.
 *
 * MODEL
 * -----
 * A record is keyed by **slot** when the slot is known (a slot is the stable
 * identity across its order incarnations: intent -> chain id -> partial ->
 * gone), by **orderId** when only the chain id is known, and by **fingerprint**
 * when a CREATE has neither yet. `LifecycleView` is the single read surface:
 * every consumer asks the same questions of the same record.
 *
 * The legacy structures are preserved as *facade views* (`_placedAt`, ...)
 * backed by this registry, so existing call sites keep working while the
 * truth lives in one place. See `LifecycleRegistry` accessors below.
 */

import { TIMING } from '../constants.js';

// ===============================================================================
// SECTION 1: TYPES
// ===============================================================================

/**
 * Where an order is in its chain life.
 *
 * `unknown` is a real state, not an absence: a CREATE whose receipt was lost,
 * an ambiguous read, or a persisted `createUncertain` marker. Consumers must
 * treat it as "may exist on chain" — never as "gone", never as "absent".
 */
export type LifecyclePhase =
    | 'intent'        // planned locally; nothing was broadcast
    | 'broadcasting'  // CREATE sent, no receipt yet
    | 'landed'        // chain snapshot confirmed an open order
    | 'filling'       // chain snapshot shows a partial fill
    | 'gone'          // chain snapshot confirmed absence
    | 'unknown';      // receipt lost / ambiguous read — may exist

/** What backs the current phase. `none` means nothing was ever observed. */
export type LifecycleEvidence =
    | 'none'
    | 'local'
    | 'broadcast-receipt'
    | 'chain-snapshot'
    | 'fill-history'
    | 'adoption';

/** Minimal shape of a pending CREATE entry (mirrors `PendingBroadcast`). */
export interface PendingBroadcastLike {
    slotId?: string | null;
    order?: unknown;
    fingerprint?: string | null;
    recordedAt?: number;
    orderType?: string;
    [key: string]: unknown;
}

/** One lifecycle record. All clocks live here; nothing else owns a copy. */
export interface OrderLifecycleRecord {
    /** Stable registry key. */
    key: string;
    slotId: string | null;
    orderId: string | null;
    fingerprint: string | null;
    phase: LifecyclePhase;
    evidence: LifecycleEvidence;
    /** When the current phase was recorded (our clock). */
    recordedAt: number;
    /** When the CHAIN last told us anything (0 = never). */
    observedAt: number;
    /** When the current chain id was assigned locally. */
    assignedAt: number;
    /** When the current chain id was placed/adopted (surplus-cancel grace). */
    placedAt: number;
    /** When the current chain id was committed by the COW engine. */
    committedAt: number;
    /** Chain-size resize already absorbed by sync pass 1 (dedupe marker). */
    appliedFillInt: number | null;
    appliedFillAt: number | null;
    /** Snapshot stamp the COW engine published this id under (0 = per-id stamp). */
    committedSnapshotAt: number;
    /** The raw pending-CREATE entry, when this record is a broadcasting intent. */
    pending: PendingBroadcastLike | null;
    /** Bumped on every mutation; useful for change detection in tests. */
    revision: number;
}

/**
 * Read surface for one order. Methods take an explicit `now` where a clock
 * matters so tests never depend on wall time.
 */
export interface LifecycleView {
    slotId: string | null;
    orderId: string | null;
    phase: LifecyclePhase;
    evidence: LifecycleEvidence;
    recordedAt: number;
    observedAt: number;
    assignedAt: number;
    placedAt: number;
    committedAt: number;
    /** Phase is `unknown`: the order may or may not exist on chain. */
    isUnknown: boolean;
    /** Phase is `unknown` or `broadcasting`: unresolved evidence, not absence. */
    isUnresolved: boolean;
    /** Phase is `broadcasting`, `landed`, `filling` or `unknown`. */
    mayExistOnChain: boolean;
    /** The chain confirmed the order is absent. */
    isConfirmedGone: boolean;
    /** Planned only; nothing was ever sent. */
    isIntentOnly: boolean;
    /** The chain confirmed an open order (full or partial size). */
    isOnChain: boolean;
    /** Pending-CREATE payload, when this record is a broadcasting intent. */
    pending: PendingBroadcastLike | null;
    /** True while inside the fresh-placement grace window. */
    isFreshlyPlaced(graceMs?: number, now?: number): boolean;
    /** True when the chain id was assigned locally within `windowMs`. */
    isRecentlyAssigned(windowMs?: number, now?: number): boolean;
    /** True when committed within `windowMs`. */
    isRecentlyCommitted(windowMs?: number, now?: number): boolean;
    /**
     * True when this order's absence from a snapshot is NOT yet trustworthy.
     *
     * This is the single definition of the in-flight guard. The engine used to
     * answer it from four different subsets (`_committedOrderIds` only in one
     * place, `_orderIdAssignedAt` only in another, both in a third), so the
     * same order could be deferred in one path and virtualized-as-phantom in
     * another. Treating an unknown or recently-touched order as "maybe live"
     * is always the safe direction: the cost is one deferred cleanup cycle,
     * the alternative is a duplicated live order.
     *
     * Bounded in time: an unresolved record stops suppressing cleanup after
     * 2× `PENDING_BROADCAST_TTL_MS`, so a lagging node cannot park the grid.
     */
    isInFlight(windowMs?: number, now?: number): boolean;
    /** True when an unresolved phase is still inside the suppression bound. */
    isUnresolvedFresh(now?: number): boolean;
    /** True when sync pass 1 already absorbed this chain filled amount. */
    appliedFillMatches(filledInt: number): boolean;
    /** True when the phase was recorded by evidence from outside the process. */
    isChainBacked(): boolean;
}

interface ObserveInput {
    phase?: LifecyclePhase;
    evidence?: LifecycleEvidence;
    slotId?: string | null;
    orderId?: string | null;
    fingerprint?: string | null;
    observedAt?: number;
    at?: number;
}

/**
 * How much a piece of evidence proves, weakest first.
 *
 * Evidence is MONOTONIC within a phase: a local re-assertion of the same phase
 * (the write funnel runs after a sync pass already recorded what the chain said)
 * must not overwrite `chain-snapshot` with `local`. The rank makes that rule
 * mechanical instead of a convention every writer has to remember.
 */
const EVIDENCE_RANK: Record<LifecycleEvidence, number> = {
    none: 0,
    local: 1,
    'broadcast-receipt': 2,
    adoption: 3,
    'chain-snapshot': 4,
    'fill-history': 5,
};

/** True for the phases where the engine has evidence of a problem, not an answer. */
function isUnresolvedPhase(phase: LifecyclePhase): boolean {
    return phase === 'unknown' || phase === 'broadcasting';
}

/** True when the evidence came from outside the process. */
function isChainBacked(evidence: LifecycleEvidence): boolean {
    return evidence === 'chain-snapshot' || evidence === 'fill-history' || evidence === 'adoption';
}

/**
 * When the current uncertainty was recorded (0 = no clock).
 *
 * The newer of the two clocks: a chain answer that already told us "unreadable"
 * is the latest thing we know, and the local re-recording that followed it must
 * not restart the bound. Every consumer of the unresolved bound (isInFlight,
 * markIntentIfResolved, pruning) measures from here, so they cannot drift.
 */
function unresolvedAnchor(record: OrderLifecycleRecord | null | undefined): number {
    const recorded = Number(record?.recordedAt) || 0;
    const observed = Number(record?.observedAt) || 0;
    return Math.max(recorded, observed);
}

// ===============================================================================
// SECTION 2: WINDOWS
// ===============================================================================
//
// Every window the registry consults is read here, once, through
// `timingWindowMs`. The old shape — `Number(TIMING.X) > 0 ? Number(TIMING.X) :
// <literal>` copy-pasted per site — is how a window's value and its fallback
// drift apart from the constant they claim to describe.

/**
 * Read a timing window in milliseconds with a fallback for a missing constant.
 *
 * The fallback exists for fixtures that stub `TIMING` with a partial object. It
 * must never be a SECOND definition of the window: it is the value the constant
 * already carries (see modules/constants.ts), applied only when the constant is
 * absent or unusable.
 *
 * @param key - TIMING key
 * @param fallback - Value to use when the constant is missing/unusable
 * @returns {number} Positive window length in milliseconds
 */
export function timingWindowMs(key: string, fallback: number): number {
    const raw = Number((TIMING as Record<string, unknown>)[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Fresh-placement grace (surplus-cancel protection). */
function surplusCancelGraceMs(): number {
    return timingWindowMs('SURPLUS_CANCEL_GRACE_MS', 15 * 60 * 1000);
}

/** Post-commit protection window (a lagging snapshot must not virtualize). */
function commitProtectionWindowMs(): number {
    return timingWindowMs('SYNC_LOCK_TIMEOUT_MS', 20_000);
}

/** Retention of an unresolved pending-CREATE entry. */
export function pendingBroadcastTtlMs(): number {
    return timingWindowMs('PENDING_BROADCAST_TTL_MS', 30 * 60 * 1000);
}

/**
 * How long an unresolved (`unknown` / `broadcasting`) record may suppress an
 * absence decision.
 *
 * The old per-site guards each carried a time escape hatch — "a permanently
 * lagging node must not park CREATEs forever". Unifying the sources must not
 * drop that hatch, so the same bound (2× the pending-broadcast TTL, which is
 * the longest existing unblock window) applies to every unresolved phase.
 * Past it the order is presumed gone and normal cleanup proceeds.
 *
 * The bound is only honest if it is measured from when the uncertainty was
 * RECORDED: a caller re-asserting `unknown` without new evidence must not push
 * the deadline out (see `observe`).
 */
function unresolvedBoundMs(): number {
    return pendingBroadcastTtlMs() * 2;
}

// ===============================================================================
// SECTION 3: KEY HELPERS
// ===============================================================================

const SLOT_PREFIX = 'slot:';
const ORDER_PREFIX = 'order:';

function asKey(value: unknown): string | null {
    if (value == null) return null;
    const text = String(value);
    return text.length > 0 ? text : null;
}

// ===============================================================================
// SECTION 4: LIFECYCLE VIEW
// ===============================================================================

class LifecycleViewImpl implements LifecycleView {
    constructor(private readonly record: OrderLifecycleRecord | null, private readonly now: () => number) { }

    get slotId(): string | null { return this.record?.slotId ?? null; }
    get orderId(): string | null { return this.record?.orderId ?? null; }
    get phase(): LifecyclePhase { return this.record?.phase ?? 'intent'; }
    get evidence(): LifecycleEvidence { return this.record?.evidence ?? 'none'; }
    get recordedAt(): number { return this.record?.recordedAt ?? 0; }
    get observedAt(): number { return this.record?.observedAt ?? 0; }
    get assignedAt(): number { return this.record?.assignedAt ?? 0; }
    get placedAt(): number { return this.record?.placedAt ?? 0; }
    get committedAt(): number { return this.record?.committedAt ?? 0; }
    get pending(): PendingBroadcastLike | null { return this.record?.pending ?? null; }

    get isUnknown(): boolean { return this.phase === 'unknown'; }
    get isUnresolved(): boolean { return isUnresolvedPhase(this.phase); }
    get isConfirmedGone(): boolean { return this.phase === 'gone'; }
    get isIntentOnly(): boolean { return this.phase === 'intent'; }
    get isOnChain(): boolean { return this.phase === 'landed' || this.phase === 'filling'; }
    get mayExistOnChain(): boolean {
        // `intent` and `gone` are the only phases where nothing can be resting
        // on chain. `unknown` MUST count as "may exist" — guessing "absent" is
        // the exact failure this whole module exists to prevent.
        return this.phase === 'broadcasting' || this.isOnChain || this.isUnknown;
    }

    isFreshlyPlaced(graceMs?: number, now?: number): boolean {
        const placedAt = this.placedAt;
        if (!Number.isFinite(placedAt) || placedAt <= 0) return false;
        const window = Number.isFinite(Number(graceMs)) && Number(graceMs) > 0
            ? Number(graceMs)
            : surplusCancelGraceMs();
        const clock = Number.isFinite(Number(now)) ? Number(now) : this.now();
        return clock - placedAt < window;
    }

    isRecentlyCommitted(windowMs?: number, now?: number): boolean {
        if (!this.record) return false;
        const committedAt = this.record.committedSnapshotAt > 0
            ? this.record.committedSnapshotAt
            : this.committedAt;
        if (!Number.isFinite(committedAt) || committedAt <= 0) return false;
        const window = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
            ? Number(windowMs)
            : commitProtectionWindowMs();
        const clock = Number.isFinite(Number(now)) ? Number(now) : this.now();
        return clock - committedAt < window;
    }

    isRecentlyAssigned(windowMs?: number, now?: number): boolean {
        const assignedAt = this.assignedAt;
        if (!Number.isFinite(assignedAt) || assignedAt <= 0) return false;
        const window = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
            ? Number(windowMs)
            : commitProtectionWindowMs();
        const clock = Number.isFinite(Number(now)) ? Number(now) : this.now();
        return clock - assignedAt < window;
    }

    isInFlight(windowMs?: number, now?: number): boolean {
        if (this.isRecentlyAssigned(windowMs, now) || this.isRecentlyCommitted(windowMs, now)) return true;
        if (this.isUnknown || this.phase === 'broadcasting') return this.isUnresolvedFresh(now);
        return false;
    }

    isUnresolvedFresh(now?: number): boolean {
        const clock = Number.isFinite(Number(now)) ? Number(now) : this.now();
        const from = unresolvedAnchor(this.record);
        if (!(from > 0)) return false;
        return clock - from < unresolvedBoundMs();
    }

    isChainBacked(): boolean {
        return isChainBacked(this.evidence);
    }

    appliedFillMatches(filledInt: number): boolean {
        if (!this.record) return false;
        const applied = this.record.appliedFillInt;
        if (applied == null) return false;
        return Number(applied) === Number(filledInt);
    }
}

// ===============================================================================
// SECTION 5: MAP / SET FACADES
// ===============================================================================
//
// The legacy structures are read *and written* from many modules. Rather than
// rewriting every call site (and every test fixture) in one step, each legacy
// structure becomes a live view onto the registry. Writes through the view land
// in the record; reads see the record. There is exactly one copy of the data.

type MapSource<V> = {
    entries(): Iterable<[string, V]>;
    get(key: string): V | undefined;
    set(key: string, value: V): void;
    delete(key: string): void;
    clear(): void;
};

class LifecycleMapView<V> extends Map<string, V> {
    constructor(private readonly source: MapSource<V>) {
        super();
    }

    override get size(): number {
        let count = 0;
        for (const _ of this.source.entries()) count += 1;
        return count;
    }

    override get(key: string): V | undefined { return this.source.get(String(key)); }
    override has(key: string): boolean { return this.source.get(String(key)) !== undefined; }
    override set(key: string, value: V): this {
        this.source.set(String(key), value);
        return this;
    }
    override delete(key: string): boolean {
        if (this.source.get(String(key)) === undefined) return false;
        this.source.delete(String(key));
        return true;
    }
    override clear(): void { this.source.clear(); }

    override *keys(): MapIterator<string> {
        for (const [key] of this.source.entries()) yield key;
    }
    override *values(): MapIterator<V> {
        for (const [, value] of this.source.entries()) yield value;
    }
    override *entries(): MapIterator<[string, V]> {
        for (const pair of this.source.entries()) yield pair;
    }
    override forEach(callback: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
        for (const [key, value] of this.source.entries()) callback.call(thisArg, value, key, this);
    }
    override [Symbol.iterator](): MapIterator<[string, V]> { return this.entries(); }
}

type SetSource = {
    values(): Iterable<string>;
    has(value: string): boolean;
    add(value: string): void;
    delete(value: string): void;
    clear(): void;
};

class LifecycleSetView extends Set<string> {
    constructor(private readonly source: SetSource) {
        super();
    }

    override get size(): number {
        let count = 0;
        for (const _ of this.source.values()) count += 1;
        return count;
    }

    override has(value: string): boolean { return this.source.has(String(value)); }
    override add(value: string): this {
        this.source.add(String(value));
        return this;
    }
    override delete(value: string): boolean {
        if (!this.source.has(String(value))) return false;
        this.source.delete(String(value));
        return true;
    }
    override clear(): void { this.source.clear(); }

    override *values(): SetIterator<string> {
        for (const value of this.source.values()) yield value;
    }
    override *keys(): SetIterator<string> {
        for (const value of this.source.values()) yield value;
    }
    override *entries(): SetIterator<[string, string]> {
        for (const value of this.source.values()) yield [value, value];
    }
    override forEach(callback: (value: string, key: string, set: Set<string>) => void, thisArg?: unknown): void {
        for (const value of this.source.values()) callback.call(thisArg, value, value, this);
    }
    override [Symbol.iterator](): SetIterator<string> { return this.values(); }
}

// ===============================================================================
// SECTION 6: REGISTRY
// ===============================================================================

export interface LifecycleRegistryOptions {
    /** Clock seam for tests. Defaults to `Date.now`. */
    now?: () => number;
    /** Hard cap on retained records (GC bound, not a correctness gate). */
    maxRecords?: number;
}

export class LifecycleRegistry {
    private readonly records = new Map<string, OrderLifecycleRecord>();
    private readonly byOrderId = new Map<string, string>();
    private readonly bySlotId = new Map<string, string>();
    private readonly byFingerprint = new Map<string, string>();
    private readonly now: () => number;
    private readonly maxRecords: number;
    /**
     * The single "last committed snapshot" stamp. The COW engine publishes a
     * whole Set of committed ids at once, and the protection window is measured
     * from that publish, not from each id. Kept here so the stamp cannot drift
     * away from the ids it describes.
     */
    private committedSnapshotAt = 0;

    /** Facade for `manager._placedAt`. */
    readonly placedAt: Map<string, number>;
    /** Facade for `manager._orderIdAssignedAt`. */
    readonly assignedAt: Map<string, number>;
    /** Facade for `manager._committedOrderIds`. */
    readonly committedIds: Set<string>;
    /** Facade for `manager._pendingBroadcasts` (keyed by fingerprint). */
    readonly pendingBroadcasts: Map<string, PendingBroadcastLike>;
    /** Facade for `manager._chainSizeAppliedFills`. */
    readonly appliedFills: Map<string, { filledInt: number; at: number }>;

    constructor(options: LifecycleRegistryOptions = {}) {
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.maxRecords = Number.isFinite(Number(options.maxRecords)) && Number(options.maxRecords) > 0
            ? Number(options.maxRecords)
            : 5000;

        this.placedAt = new LifecycleMapView<number>({
            entries: () => this.placedEntries(),
            get: (key) => {
                const record = this.findByIdentity(key);
                return record && record.placedAt > 0 ? record.placedAt : undefined;
            },
            set: (key, value) => this.writePlacedAt(key, value),
            delete: (key) => this.writePlacedAt(key, 0),
            clear: () => this.clearPlacedAt(),
        });

        this.assignedAt = new LifecycleMapView<number>({
            entries: () => this.assignedEntries(),
            get: (key) => {
                const record = this.findByIdentity(key);
                return record && record.assignedAt > 0 ? record.assignedAt : undefined;
            },
            set: (key, value) => this.writeAssignedAt(key, value),
            delete: (key) => this.writeAssignedAt(key, 0),
            clear: () => this.clearAssignedAt(),
        });

        this.committedIds = new LifecycleSetView({
            values: () => this.committedValues(),
            has: (id) => {
                const record = this.findByIdentity(id);
                return !!record && record.committedAt > 0;
            },
            add: (id) => this.writeCommitted(id, this.now()),
            delete: (id) => this.writeCommitted(id, 0),
            clear: () => this.clearCommitted(),
        });

        this.pendingBroadcasts = new LifecycleMapView<PendingBroadcastLike>({
            entries: () => this.pendingEntries(),
            get: (fingerprint) => this.getPending(fingerprint),
            set: (fingerprint, entry) => { this.setPending(fingerprint, entry); },
            delete: (fingerprint) => { this.deletePending(fingerprint); },
            clear: () => { this.clearPending(); },
        });

        this.appliedFills = new LifecycleMapView<{ filledInt: number; at: number }>({
            entries: () => this.appliedEntries(),
            get: (id) => {
                const record = this.findByIdentity(id);
                if (!record || record.appliedFillInt == null) return undefined;
                return { filledInt: Number(record.appliedFillInt), at: Number(record.appliedFillAt) || 0 };
            },
            set: (id, value) => this.writeAppliedFill(id, value),
            delete: (id) => this.writeAppliedFill(id, null),
            clear: () => this.clearAppliedFills(),
        });
    }

    // ---------------------------------------------------------------------------
    // Record plumbing
    // ---------------------------------------------------------------------------

    private createRecord(key: string): OrderLifecycleRecord {
        const record: OrderLifecycleRecord = {
            key,
            slotId: null,
            orderId: null,
            fingerprint: null,
            phase: 'intent',
            evidence: 'none',
            recordedAt: this.now(),
            observedAt: 0,
            assignedAt: 0,
            placedAt: 0,
            committedAt: 0,
            appliedFillInt: null,
            appliedFillAt: null,
            committedSnapshotAt: 0,
            pending: null,
            revision: 1,
        };
        this.records.set(key, record);
        this.prune(key);
        return record;
    }

    private keyForSlot(slotId: string): string { return `${SLOT_PREFIX}${slotId}`; }
    private keyForOrder(orderId: string): string { return `${ORDER_PREFIX}${orderId}`; }

    /**
     * Find (or create) the record that owns this slot, claiming any order-only
     * record for `orderId` on the way so a slot's life never forks in two.
     */
    private recordForSlot(slotId: string | null, orderId?: string | null): OrderLifecycleRecord {
        if (slotId) {
            const existingKey = this.bySlotId.get(slotId);
            if (existingKey) {
                const existing = this.records.get(existingKey);
                if (existing) {
                    if (orderId) this.linkOrderId(existing, orderId);
                    return existing;
                }
            }
            // Claim an order-only record so the slot becomes the single owner.
            const orderKey = orderId ? this.byOrderId.get(orderId) : undefined;
            if (orderKey && orderKey !== this.keyForSlot(slotId)) {
                const claimed = this.records.get(orderKey);
                if (claimed && claimed.slotId == null) {
                    this.records.delete(orderKey);
                    claimed.key = this.keyForSlot(slotId);
                    claimed.slotId = slotId;
                    this.records.set(claimed.key, claimed);
                    this.bySlotId.set(slotId, claimed.key);
                    // The order index still points at the retired key; re-point it
                    // or every lookup by chain id would miss this record.
                    if (claimed.orderId) this.byOrderId.set(claimed.orderId, claimed.key);
                    claimed.revision += 1;
                    return claimed;
                }
            }
            const created = this.createRecord(this.keyForSlot(slotId));
            created.slotId = slotId;
            this.bySlotId.set(slotId, created.key);
            if (orderId) this.linkOrderId(created, orderId);
            return created;
        }
        if (orderId) {
            const existingKey = this.byOrderId.get(orderId);
            const existing = existingKey ? this.records.get(existingKey) : undefined;
            if (existing) return existing;
            const created = this.createRecord(this.keyForOrder(orderId));
            created.orderId = orderId;
            this.byOrderId.set(orderId, created.key);
            return created;
        }
        throw new Error('LifecycleRegistry: need a slotId, orderId or fingerprint');
    }

    private linkOrderId(record: OrderLifecycleRecord, orderId: string): void {
        if (!orderId) return;
        if (record.orderId === orderId) {
            this.byOrderId.set(orderId, record.key);
            return;
        }
        // If an order-only record already claimed this chain id (a stamp written
        // before the slot was known), fold its facts in and drop it. Without this
        // merge, every placement would leak one unreachable order-keyed record
        // and its `placedAt`/`committedAt` stamps would be stranded on it —
        // making the slot look never-freshly-placed.
        const previousKey = this.byOrderId.get(orderId);
        if (previousKey && previousKey !== record.key) {
            const orphan = this.records.get(previousKey);
            if (orphan && !orphan.slotId && !orphan.pending) {
                record.placedAt = Math.max(record.placedAt, orphan.placedAt);
                record.assignedAt = Math.max(record.assignedAt, orphan.assignedAt);
                record.committedAt = Math.max(record.committedAt, orphan.committedAt);
                record.observedAt = Math.max(record.observedAt, orphan.observedAt);
                if (record.appliedFillInt == null && orphan.appliedFillInt != null) {
                    record.appliedFillInt = orphan.appliedFillInt;
                    record.appliedFillAt = orphan.appliedFillAt;
                }
                // dropRecord (not a bare delete) so no stale index entry is left
                // pointing at a key that no longer exists.
                this.dropRecord(orphan);
            }
        }
        if (record.orderId) this.byOrderId.delete(record.orderId);
        record.orderId = orderId;
        this.byOrderId.set(orderId, record.key);
        record.revision += 1;
    }

    /** Record for a fingerprint whose CREATE has no slot id yet. */
    private recordForFingerprint(fingerprint: string): OrderLifecycleRecord {
        const existingKey = this.byFingerprint.get(fingerprint);
        const existing = existingKey ? this.records.get(existingKey) : undefined;
        if (existing) return existing;
        const created = this.createRecord(`fp:${fingerprint}`);
        created.fingerprint = fingerprint;
        this.byFingerprint.set(fingerprint, created.key);
        return created;
    }

    /** Resolve a record from any of the three identities. */
    private findByIdentity(id: string | null | undefined): OrderLifecycleRecord | undefined {
        const key = asKey(id);
        if (!key) return undefined;
        const bySlot = this.bySlotId.get(key);
        if (bySlot) return this.records.get(bySlot);
        const byOrder = this.byOrderId.get(key);
        if (byOrder) return this.records.get(byOrder);
        const byFp = this.byFingerprint.get(key);
        if (byFp) return this.records.get(byFp);
        // A raw registry key (tests / diagnostics).
        return this.records.get(key);
    }

    private prune(exceptKey?: string): void {
        if (this.records.size <= this.maxRecords) return;
        // Evict settled records oldest-first. `unknown`/`broadcasting` records
        // are never evicted while their uncertainty is live: they are the ones
        // that must not be forgotten. Past the unresolved bound they are no
        // longer consulted by any decision (isInFlight() released them), so they
        // become evictable like any other settled record — otherwise a bot that
        // keeps losing CREATE receipts grows this registry without a ceiling.
        // `exceptKey` is the record just created — it must survive its own
        // insertion even when it shares a millisecond with older records.
        const clock = this.now();
        const evictable: OrderLifecycleRecord[] = [];
        for (const record of this.records.values()) {
            if (record.key === exceptKey) continue;
            if (!this.isEvictable(record, clock)) continue;
            evictable.push(record);
        }
        evictable.sort((a, b) => a.recordedAt - b.recordedAt);
        const overflow = this.records.size - this.maxRecords;
        for (let i = 0; i < overflow && i < evictable.length; i += 1) {
            this.dropRecord(evictable[i]);
        }
    }

    /** True when a record carries no live uncertainty and may be evicted. */
    private isEvictable(record: OrderLifecycleRecord, clock: number): boolean {
        if (!isUnresolvedPhase(record.phase)) return true;
        const since = unresolvedAnchor(record);
        if (!(since > 0)) return true;
        return clock - since >= unresolvedBoundMs();
    }

    private dropRecord(record: OrderLifecycleRecord): void {
        this.records.delete(record.key);
        if (record.orderId) this.byOrderId.delete(record.orderId);
        if (record.slotId) this.bySlotId.delete(record.slotId);
        if (record.fingerprint) this.byFingerprint.delete(record.fingerprint);
    }

    // ---------------------------------------------------------------------------
    // Public reads
    // ---------------------------------------------------------------------------

    /** Resolve a read surface for any identity (slot / orderId / fingerprint). */
    view(id: string | null | undefined): LifecycleView {
        return new LifecycleViewImpl(this.findByIdentity(id) ?? null, this.now);
    }

    /** Raw record (diagnostics / tests). Returns a frozen copy. */
    snapshot(id: string | null | undefined): Readonly<OrderLifecycleRecord> | null {
        const record = this.findByIdentity(id);
        return record ? Object.freeze({ ...record }) : null;
    }

    size(): number { return this.records.size; }

    /**
     * A read-only view with one phase overridden, without touching the record.
     *
     * Used where a caller holds extra evidence the registry does not (a
     * persisted per-slot flag): the read must reflect it, but a read must not
     * write. Mutating here would also refresh `recordedAt` on every call and
     * keep `isUnresolvedFresh` eternally true.
     *
     * @param identity - Slot id, chain order id or fingerprint
     * @param phase - Phase to report
     * @param evidence - Evidence backing the overridden phase
     * @returns {LifecycleView} Read surface over a copy
     */
    withPhase(identity: string | null | undefined, phase: LifecyclePhase, evidence: LifecycleEvidence): LifecycleView {
        const record = this.findByIdentity(identity);
        const base: OrderLifecycleRecord = record
            ? { ...record }
            : {
                key: `transient:${String(identity)}`,
                slotId: null,
                orderId: asKey(identity),
                fingerprint: null,
                phase,
                evidence,
                // No recorded clock: a synthesized record has no evidence time,
                // and stamping `now` here would make an aged marker look fresh on
                // every read (the suppression bound would never expire).
                recordedAt: 0,
                observedAt: 0,
                assignedAt: 0,
                placedAt: 0,
                committedAt: 0,
                appliedFillInt: null,
                appliedFillAt: null,
                committedSnapshotAt: 0,
                pending: null,
                revision: 1,
            };
        base.phase = phase;
        base.evidence = evidence;
        if (phase === 'unknown') base.pending = null;
        return new LifecycleViewImpl(base, this.now);
    }

    // ---------------------------------------------------------------------------
    // Public writes
    // ---------------------------------------------------------------------------

    /** Record a planned-only order (nothing broadcast). */
    markIntent(identity: { slotId?: string | null; orderId?: string | null }, at?: number): LifecycleView {
        const record = this.recordForSlot(identity.slotId ?? null, identity.orderId ?? null);
        record.phase = 'intent';
        record.evidence = 'local';
        record.recordedAt = this.clock(at);
        // Explicit resolution: drop the pending payload AND its index entry, so
        // the facade the engine reads and `pendingSize()` cannot disagree.
        this.dropPending(record);
        record.revision += 1;
        return this.view(identity.slotId ?? identity.orderId ?? null);
    }

    /**
     * Mark a slot as holding no chain order, but only when nothing unresolved is
     * on record.
     *
     * "Nothing is out there" is a claim that requires evidence. If the record is
     * still `unknown` or `broadcasting`, an unrelated slot mutation (a size tweak,
     * a re-plan) must not silently erase that: the only ways out are an explicit
     * decision by the caller (`markIntent`) or the chain answering.
     *
     * @param slotId - Slot id
     * @param at - Clock override (tests)
     * @returns {LifecycleView}
     */
    markIntentIfResolved(slotId: string | null | undefined, at?: number): LifecycleView {
        const identity = asKey(slotId);
        if (!identity) return this.view(null);
        const existing = this.findByIdentity(identity);
        if (existing && isUnresolvedPhase(existing.phase)) {
            // Inside the bound the uncertainty still speaks. Past it the bound has
            // already released every absence decision (isInFlight()), so leaving
            // the phase at `unknown` would persist a suppression the engine no
            // longer honours — `mayExistOnChain` true forever, and the record
            // un-evictable. Resolve it here, where the caller is explicitly
            // re-declaring the slot as a clean intent.
            const clock = this.clock(at);
            const since = unresolvedAnchor(existing);
            const expired = !(since > 0) || clock - since >= unresolvedBoundMs();
            if (!expired) return new LifecycleViewImpl(existing, this.now);
        }
        return this.markIntent({ slotId: identity }, at);
    }

    /**
     * Record a state transition observed from an external source.
     *
     * Two rules make the clocks trustworthy:
     *
     * - `observedAt` only advances for chain-backed evidence, so "when did we
     *   last hear the truth" cannot be advanced by local bookkeeping.
     * - `recordedAt` (the anchor of the unresolved bound) only advances when the
     *   phase actually changes or chain-backed evidence arrives. Re-asserting the
     *   same unresolved phase is not new information; refreshing the clock for it
     *   would keep `isInFlight()` true forever, which is the opposite of the
     *   documented 2× TTL escape hatch.
     *
     * Evidence is monotonic within a phase (see EVIDENCE_RANK): a local write
     * that follows a chain observation keeps the stronger evidence.
     */
    observe(orderId: string | null | undefined, input: ObserveInput = {}): LifecycleView {
        const slotId = input.slotId ?? null;
        const id = asKey(orderId) ?? slotId;
        if (!id) return this.view(null);
        const record = this.recordForSlot(slotId, orderId ?? null);
        const at = this.clock(input.at);
        const phaseChanged = input.phase != null && input.phase !== record.phase;
        const nextEvidence = input.evidence;
        const chainBacked = nextEvidence != null && isChainBacked(nextEvidence);
        const keepsStrongerEvidence = nextEvidence != null
            && !phaseChanged
            && EVIDENCE_RANK[nextEvidence] < EVIDENCE_RANK[record.evidence];
        if (input.phase) record.phase = input.phase;
        if (nextEvidence && !keepsStrongerEvidence) record.evidence = nextEvidence;
        // `recordedAt` doubles as the retention ordering used by `prune`, so a
        // settled record may refresh it freely. The one case that must NOT is a
        // repeated re-assertion of an unresolved phase: that clock is also the
        // anchor of the suppression bound, and refreshing it would make the
        // bound infinite.
        const reassertsUnresolved = !phaseChanged && isUnresolvedPhase(record.phase);
        if (!reassertsUnresolved || chainBacked) record.recordedAt = at;
        if (chainBacked) {
            const observed = Number(input.observedAt);
            record.observedAt = Number.isFinite(observed) && observed > 0 ? observed : at;
        }
        if (input.phase !== 'broadcasting' && input.phase !== 'unknown') {
            // The pending CREATE resolved (or was superseded): drop the entry AND
            // its index, so `pendingSize()`/`getPending()` cannot disagree with
            // the facade the rest of the engine reads.
            if (record.pending) this.dropPending(record);
        }
        record.revision += 1;
        return this.view(record.slotId ?? record.orderId);
    }

    /** The chain confirmed an open order (full or partial). */
    markLanded(orderId: string, input: ObserveInput = {}): LifecycleView {
        return this.observe(orderId, { ...input, phase: input.phase ?? 'landed', evidence: input.evidence ?? 'chain-snapshot' });
    }

    /** A receipt was lost / a read was ambiguous: the order may exist. */
    markUnknown(orderId: string | null | undefined, input: ObserveInput = {}): LifecycleView {
        return this.observe(orderId, { ...input, phase: 'unknown', evidence: input.evidence ?? 'local' });
    }

    /** Record the chain id assigned to a slot. */
    markAssigned(slotId: string | null | undefined, orderId: string | null | undefined, at?: number): LifecycleView {
        const record = this.recordForSlot(slotId ?? null, orderId ?? null);
        if (orderId) this.linkOrderId(record, orderId);
        record.assignedAt = this.clock(at);
        record.revision += 1;
        return this.view(slotId ?? orderId);
    }

    /** Record a fresh on-chain placement (surplus-cancel grace anchor). */
    markPlaced(orderId: string | null | undefined, at?: number, slotId?: string | null): LifecycleView {
        const id = asKey(orderId);
        if (!id) return this.view(null);
        const record = this.recordForSlot(slotId ?? null, id);
        this.linkOrderId(record, id);
        record.placedAt = this.clock(at);
        record.revision += 1;
        return this.view(record.slotId ?? id);
    }

    /**
     * Publish a whole committed-id snapshot atomically (COW commit path).
     * This is the only writer that moves the snapshot stamp.
     */
    markCommittedSnapshot(orderIds: Iterable<string>, at?: number): void {
        const stamp = this.clock(at);
        const next = new Set<string>();
        for (const id of orderIds) {
            const text = asKey(id);
            if (text) next.add(text);
        }
        for (const record of this.records.values()) {
            if (record.orderId && next.has(record.orderId)) {
                record.committedAt = stamp;
                record.committedSnapshotAt = stamp;
                record.revision += 1;
            } else if (record.committedAt > 0) {
                // Leaving the committed set means leaving it for the protection
                // window too. Keeping a per-id stamp here would keep an order
                // protected that the engine deliberately dropped (a filled or
                // virtualized order drops out of the next commit's finalMap).
                record.committedAt = 0;
                record.committedSnapshotAt = 0;
            }
        }
        for (const id of next) {
            const record = this.recordForSlot(null, id);
            record.committedAt = stamp;
            record.committedSnapshotAt = stamp;
            record.revision += 1;
        }
        this.committedSnapshotAt = stamp;
    }

    /** The stamp of the last published committed-id snapshot (0 = none). */
    get committedBuiltAt(): number { return this.committedSnapshotAt; }
    set committedBuiltAt(value: number) {
        const stamp = Number(value) > 0 ? Number(value) : 0;
        this.committedSnapshotAt = stamp;
        for (const record of this.records.values()) {
            if (record.committedAt > 0) record.committedSnapshotAt = stamp;
        }
    }

    /** Record that sync pass 1 already absorbed this chain filled amount. */
    markAppliedFill(orderId: string | null | undefined, filledInt: number, at?: number): void {
        const id = asKey(orderId);
        if (!id) return;
        const record = this.recordForSlot(null, id);
        record.appliedFillInt = Number(filledInt);
        record.appliedFillAt = this.clock(at);
        record.revision += 1;
    }

    /** Forget everything about an identity (cancel confirmed, slot cleared). */
    forget(id: string | null | undefined): void {
        const record = this.findByIdentity(id);
        if (!record) return;
        this.dropPending(record);
        this.dropRecord(record);
    }

    // ---------------------------------------------------------------------------
    // Pending CREATE broadcasts (keyed by fingerprint)
    // ---------------------------------------------------------------------------

    setPending(fingerprint: string, entry: PendingBroadcastLike | null | undefined): void {
        const fp = asKey(fingerprint);
        if (!fp) return;
        if (entry == null) { this.deletePending(fp); return; }
        const slotId = entry.slotId != null && String(entry.slotId).length > 0 ? String(entry.slotId) : null;
        const existingKey = this.byFingerprint.get(fp);
        // A pending entry may carry no slot id yet (the CREATE's target was not
        // resolved). It still needs a record, keyed by fingerprint.
        const record = existingKey
            ? this.records.get(existingKey)
            : (slotId ? this.recordForSlot(slotId, null) : this.recordForFingerprint(fp));
        if (!record) return;
        // A record owns at most ONE fingerprint. Re-recording under a new one
        // (a rebuilt CREATE for the same slot) must retire the previous index
        // entry, or the stale key keeps yielding this record's pending payload.
        if (record.fingerprint && record.fingerprint !== fp) {
            this.byFingerprint.delete(record.fingerprint);
        }
        record.fingerprint = fp;
        record.pending = entry;
        record.phase = 'broadcasting';
        record.evidence = 'local';
        record.recordedAt = this.clock(undefined);
        record.revision += 1;
        this.byFingerprint.set(fp, record.key);
        if (slotId) this.bySlotId.set(slotId, record.key);
    }

    getPending(fingerprint: string | null | undefined): PendingBroadcastLike | undefined {
        const fp = asKey(fingerprint);
        if (!fp) return undefined;
        const key = this.byFingerprint.get(fp);
        const record = key ? this.records.get(key) : undefined;
        return record?.pending ?? undefined;
    }

    deletePending(fingerprint: string | null | undefined): void {
        const fp = asKey(fingerprint);
        if (!fp) return;
        const key = this.byFingerprint.get(fp);
        if (!key) return;
        const record = this.records.get(key);
        this.byFingerprint.delete(fp);
        if (!record) return;
        this.dropPending(record);
        record.revision += 1;
        // Dropping a pending entry means the CREATE resolved. If the record
        // still reads `broadcasting`, nothing was observed afterwards, so the
        // slot is a clean intent again. (A pending entry that expires in the
        // manager's TTL sweep goes through `_expirePendingBroadcast`, which
        // leaves `unknown` instead — the two cases must not collapse into one.)
        if (record.phase === 'broadcasting') record.phase = 'intent';
        if (!record.orderId && !record.slotId) this.dropRecord(record);
    }

    /** Drop a record's pending-CREATE payload and its fingerprint index entry. */
    private dropPending(record: OrderLifecycleRecord): void {
        if (record.fingerprint) this.byFingerprint.delete(record.fingerprint);
        record.pending = null;
        record.fingerprint = null;
    }

    clearPending(): void {
        for (const fingerprint of [...this.byFingerprint.keys()]) this.deletePending(fingerprint);
    }

    pendingSize(): number {
        return this.byFingerprint.size;
    }

    private *pendingEntries(): IterableIterator<[string, PendingBroadcastLike]> {
        for (const [fingerprint, key] of [...this.byFingerprint]) {
            const record = this.records.get(key);
            if (record?.pending) yield [fingerprint, record.pending];
        }
    }

    // ---------------------------------------------------------------------------
    // Facade write paths
    // ---------------------------------------------------------------------------

    private clock(at?: number): number {
        return Number.isFinite(Number(at)) ? Number(at) : this.now();
    }

    private writePlacedAt(key: string, value: number): void {
        const id = asKey(key);
        if (!id) return;
        const record = this.recordForSlot(null, id);
        this.linkOrderId(record, id);
        record.placedAt = Number(value) > 0 ? Number(value) : 0;
        record.revision += 1;
    }

    private writeAssignedAt(key: string, value: number): void {
        const id = asKey(key);
        if (!id) return;
        const record = this.recordForSlot(null, id);
        this.linkOrderId(record, id);
        record.assignedAt = Number(value) > 0 ? Number(value) : 0;
        record.revision += 1;
    }

    private writeCommitted(key: string, value: number): void {
        const id = asKey(key);
        if (!id) return;
        const record = this.recordForSlot(null, id);
        this.linkOrderId(record, id);
        record.committedAt = Number(value) > 0 ? Number(value) : 0;
        // A per-id write supersedes the published snapshot for this record, in
        // both directions: a re-add stamps fresh, a delete clears protection
        // even if a snapshot had been published earlier.
        record.committedSnapshotAt = 0;
        record.revision += 1;
    }

    private writeAppliedFill(key: string, value: { filledInt: number; at: number } | null): void {
        const id = asKey(key);
        if (!id) return;
        const record = this.recordForSlot(null, id);
        this.linkOrderId(record, id);
        if (value == null) {
            record.appliedFillInt = null;
            record.appliedFillAt = null;
        } else {
            record.appliedFillInt = Number(value.filledInt);
            record.appliedFillAt = Number(value.at) || 0;
        }
        record.revision += 1;
    }

    private *placedEntries(): IterableIterator<[string, number]> {
        for (const record of [...this.records.values()]) {
            if (record.orderId && record.placedAt > 0) yield [record.orderId, record.placedAt];
        }
    }

    private *assignedEntries(): IterableIterator<[string, number]> {
        for (const record of [...this.records.values()]) {
            if (record.orderId && record.assignedAt > 0) yield [record.orderId, record.assignedAt];
        }
    }

    private *appliedEntries(): IterableIterator<[string, { filledInt: number; at: number }]> {
        for (const record of [...this.records.values()]) {
            if (record.orderId && record.appliedFillInt != null) {
                yield [record.orderId, { filledInt: Number(record.appliedFillInt), at: Number(record.appliedFillAt) || 0 }];
            }
        }
    }

    private *committedValues(): IterableIterator<string> {
        for (const record of [...this.records.values()]) {
            if (record.orderId && record.committedAt > 0) yield record.orderId;
        }
    }

    private clearPlacedAt(): void {
        for (const record of this.records.values()) record.placedAt = 0;
    }

    private clearAssignedAt(): void {
        for (const record of this.records.values()) record.assignedAt = 0;
    }

    private clearCommitted(): void {
        for (const record of this.records.values()) {
            record.committedAt = 0;
            record.committedSnapshotAt = 0;
        }
        this.committedSnapshotAt = 0;
    }

    private clearAppliedFills(): void {
        for (const record of this.records.values()) {
            record.appliedFillInt = null;
            record.appliedFillAt = null;
        }
    }
}

// ===============================================================================
// SECTION 7: PHASE PREDICATES
// ===============================================================================

/**
 * True when a slot carries a persisted "the CREATE result was lost" marker.
 *
 * This is the single definition; the registry phase and the slot flag must
 * never disagree, so every site that used to read `slot.createUncertain`
 * directly goes through here.
 */
export function isSlotCreateUncertain(slot: unknown): boolean {
    if (!slot || typeof slot !== 'object') return false;
    return (slot as { createUncertain?: boolean }).createUncertain === true;
}

// ===============================================================================
// SECTION 8: MANAGER-AGNOSTIC READ
// ===============================================================================

/**
 * Read an order's lifecycle from any manager-shaped object.
 *
 * Production managers expose `getLifecycle`; partial test doubles and legacy
 * call sites that only carry the raw maps still work, because the fallback
 * synthesizes a record from exactly those maps. That keeps the *vocabulary*
 * unified (callers ask one question) without requiring every fixture to grow a
 * registry.
 *
 * @param manager - OrderManager, its interface, or a partial test double
 * @param identity - Slot id, chain order id, or pending-broadcast fingerprint
 * @returns {LifecycleView} Unified read surface (never null)
 */
export function readLifecycle(manager: unknown, identity: string | null | undefined): LifecycleView {
    const candidate = manager as {
        getLifecycle?: (id: string | null | undefined) => LifecycleView;
        _placedAt?: Map<string, number>;
        _orderIdAssignedAt?: Map<string, number>;
        _committedOrderIds?: Set<string>;
        _committedOrderIdsBuiltAt?: number;
    } | null | undefined;
    if (candidate && typeof candidate.getLifecycle === 'function') {
        return candidate.getLifecycle(identity);
    }
    const key = asKey(identity);
    if (!key || !candidate) return new LifecycleViewImpl(null, () => Date.now());
    const placedAt = Number(candidate._placedAt instanceof Map ? candidate._placedAt.get(key) : 0) || 0;
    const assignedAt = Number(candidate._orderIdAssignedAt instanceof Map ? candidate._orderIdAssignedAt.get(key) : 0) || 0;
    const committed = !!candidate._committedOrderIds?.has?.(key);
    // Mirror the registry: the protection window is measured from the PUBLISHED
    // stamp, and a missing stamp is not a fresh one. Substituting `Date.now()`
    // here would invent a commit window production never had.
    const committedAt = committed ? (Number(candidate._committedOrderIdsBuiltAt) || 0) : 0;
    const synthesized: OrderLifecycleRecord = {
        key: `legacy:${key}`,
        slotId: null,
        orderId: key,
        fingerprint: null,
        // A partial double cannot know the phase. `landed` is chosen so the WINDOW
        // predicates (isInFlight / isRecentlyAssigned / isRecentlyCommitted)
        // behave exactly as they did before the registry existed; only those are
        // meaningful on a synthesized record.
        phase: committed || assignedAt > 0 || placedAt > 0 ? 'landed' : 'intent',
        evidence: committed || assignedAt > 0 || placedAt > 0 ? 'chain-snapshot' : 'none',
        recordedAt: Math.max(placedAt, assignedAt, committedAt),
        observedAt: committed || assignedAt > 0 ? Math.max(assignedAt, committedAt) : 0,
        assignedAt,
        placedAt,
        committedAt,
        appliedFillInt: null,
        appliedFillAt: null,
        committedSnapshotAt: committedAt,
        pending: null,
        revision: 1,
    };
    return new LifecycleViewImpl(synthesized, () => Date.now());
}

/**
 * Read an order's lifecycle from a SLOT (preferred over an identity lookup).
 *
 * A slot is the stable identity (intent → chain id → partial → gone) and can
 * carry evidence the registry does not: the persisted `createUncertain` marker,
 * which must report `unknown` (may exist on chain) rather than a clean intent.
 * Every absence decision that has the slot object in hand must go through this
 * helper, not `readLifecycle(manager, slot.orderId)` — an orderId-keyed read
 * silently ignores the marker and can virtualize an order whose CREATE landed.
 *
 * Falls back to the identity read for partial test doubles.
 *
 * @param manager - OrderManager, its interface, or a partial test double
 * @param slot - Grid slot the decision is about
 * @returns {LifecycleView} Unified read surface (never null)
 */
export function readSlotLifecycle(
    manager: unknown,
    slot: { id?: string; orderId?: string | null; createUncertain?: boolean } | null | undefined
): LifecycleView {
    const candidate = manager as {
        getSlotLifecycle?: (slot: unknown) => LifecycleView;
    } | null | undefined;
    if (candidate && typeof candidate.getSlotLifecycle === 'function') {
        return candidate.getSlotLifecycle(slot);
    }
    return readLifecycle(manager, slot?.orderId ?? slot?.id ?? null);
}

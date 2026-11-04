/**
 * modules/timing_policy.ts - Timing window classification
 *
 * The engine has 84 timing knobs. The reason that number kept growing is that
 * every "the state was briefly wrong" bug got fixed by adding a window, and
 * nothing ever removed one. A window is a substitute for evidence: it says
 * "wait, then guess". Some of that is unavoidable (a block takes as long as it
 * takes); most of it is not.
 *
 * This module is the audit. Every window key is classified into one of four
 * kinds, and a test fails when a new unclassified window appears — so the
 * inventory can only shrink by decision, never grow by accident.
 *
 *   EXTERNAL      encodes how long the OUTSIDE world takes. Legitimate.
 *                 (block time, node lag, RPC deadline, poll cadence)
 *   BOUND         a leak/GC bound. Caps retention, never a correctness gate.
 *                 Deleting one leaks memory; it cannot create a wrong decision.
 *   POLICY        a deliberate product choice (grace, cooldown, backoff).
 *                 Defensible, but each one is a place where behaviour is
 *                 encoded in milliseconds instead of in state.
 *   SELF_HEALING  compensates for our OWN lost or divergent state.
 *                 REMOVAL TARGET: the fix is evidence (a lifecycle phase),
 *                 not patience. See `removal` for the precondition.
 *
 * `derived` marks a value computed from another timing. Those are the worst
 * offenders when they are also user-tunable, because the relationship is
 * correctness and the surface is a settings file. constants.ts recomputes them
 * post-merge and throws on a broken ordering, so they are safe to keep — but
 * they must be declared, not discovered.
 *
 * Browser-safe: no Node APIs.
 */

/** What a timing window means. See the module doc for the definitions. */
export type TimingClass = 'external' | 'bound' | 'policy' | 'self-healing';

export interface TimingClassification {
    /** What kind of thing this window is. */
    kind: TimingClass;
    /** Why it exists, in one line. */
    rationale: string;
    /**
     * For `self-healing`: what evidence must exist before the window can be
     * deleted. Absent for other kinds.
     */
    removal?: string;
    /** Computed from another timing rather than declared. */
    derived?: boolean;
}

/**
 * Classifications keyed by TIMING key.
 *
 * Keep entries alphabetical. A key that is not here and looks like a window
 * fails `tests/test_timing_policy.ts` — that is the point.
 */
export const TIMING_CLASSIFICATIONS: Readonly<Record<string, TimingClassification>> = Object.freeze({
    // --- transport / external world -----------------------------------------
    ACCOUNT_TOTALS_TIMEOUT_MS: { kind: 'external', rationale: 'RPC deadline for the account-balances read.' },
    BLOCKCHAIN_FETCH_INTERVAL_MIN: { kind: 'external', rationale: 'How often chain state is polled (minutes).' },
    BLOCKCHAIN_SETTLE_DELAY_MS: { kind: 'external', rationale: 'Block-production latency before a write is expected to be visible.' },
    BOTS_CONFIG_POLL_INTERVAL_MS: { kind: 'external', rationale: 'Bots-config file poll cadence.' },
    BROADCAST_DEFER_SAFETY_MARGIN_MS: { kind: 'external', rationale: 'Headroom over the stale-broadcast watchdog; feeds a derived bound.', derived: true },
    BROADCAST_STALE_CLEAR_MS: { kind: 'external', rationale: 'Single authority for how long a broadcast may stay unresolved before the watchdog clears it.' },
    CHECK_INTERVAL_MS: { kind: 'external', rationale: 'Readiness poll cadence.' },
    CONNECTION_TIMEOUT_MS: { kind: 'external', rationale: 'Connection-establishment deadline.' },
    CREDENTIAL_BROADCAST_TIMEOUT_MS: { kind: 'external', rationale: 'Outer deadline for a daemon broadcast.' },
    CREDENTIAL_DAEMON_BROADCAST_BACKOFF_MS: { kind: 'external', rationale: 'Delay between pinned-node broadcast attempts.' },
    CREDENTIAL_DAEMON_INNER_DEADLINE_MS: { kind: 'external', rationale: 'Inner daemon deadline, deliberately under the outer timeout.' },
    CREDENTIAL_DAEMON_SOCKET_TIMEOUT_MS: { kind: 'external', rationale: 'Idle socket timeout for the credential daemon.' },
    DAEMON_PING_TIMEOUT_MS: { kind: 'external', rationale: 'Daemon healthcheck deadline.' },
    DAEMON_STARTUP_TIMEOUT_MS: { kind: 'external', rationale: 'Daemon startup deadline.' },
    FETCH_HISTORY_PAGE_TIMEOUT_MS: { kind: 'external', rationale: 'Per-page fill-history deadline.' },
    FETCH_HISTORY_TOTAL_DEADLINE_MS: { kind: 'external', rationale: 'Total fill-history crawl deadline.' },
    LOGGER_DRAIN_TIMEOUT_MS: { kind: 'bound', rationale: 'Caps how long shutdown waits for the log sink.' },
    MPA_FEED_MAX_AGE_MS: { kind: 'external', rationale: 'External feed staleness (on-chain feed publication cadence).' },
    OFFER_CACHE_TTL_MS: { kind: 'bound', rationale: 'Cache-retention bound for credit offers.' },
    SAFETY_NET_SYNC_TIMEOUT_MS: { kind: 'external', rationale: 'Deadline for the end-of-tick safety-net sync.' },
    SAFETY_PAUSE_TIMEOUT_MS: { kind: 'external', rationale: 'Upper bound on a paused pipeline before the watchdog releases it.' },
    SLOW_RECONNECT_INTERVAL_MS: { kind: 'external', rationale: 'Reconnect cadence for a slow/flapping node.' },
    SYNC_DELAY_MS: { kind: 'external', rationale: 'Pacing between sync attempts; keeps a burst from hammering the node.' },
    SYNC_EMPTY_READ_CONFIRM_DELAY_MS: { kind: 'external', rationale: 'Node lag: wait before re-reading a suspiciously empty snapshot.' },
    SYNC_LOCK_TIMEOUT_MS: { kind: 'external', rationale: 'Lock acquisition deadline; also the observed-latency scale for in-flight windows.' },
    CREDIT_DEAL_CHECK_INTERVAL_MIN: { kind: 'external', rationale: 'Credit-deal poll cadence.' },
    CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: { kind: 'external', rationale: 'External deal expiry horizon.' },
    CREDIT_RATE_MAX_AGE_MS: { kind: 'external', rationale: 'Staleness bound for an externally quoted rate.' },
    CREDIT_DEAL_SPLIT_MAX_PIECES: { kind: 'bound', rationale: 'Caps how many pieces a credit deal may be split into.' },
    CREDIT_REBORROW_MAX_ATTEMPTS: { kind: 'policy', rationale: 'Retry budget for reborrowing.' },
    DUST_HEALTH_CHECK_INTERVAL_MS: { kind: 'external', rationale: 'Dust-sweep cadence.' },
    DUST_CANCEL_TIMEOUT_MS: { kind: 'external', rationale: 'How long a dust cancel waits for the fill-processing lock.' },
    LIGHTWEIGHT_SYNC_CHECK_INTERVAL_MS: { kind: 'external', rationale: 'Cadence for the cheap open-orders check.' },
    RUN_LOOP_DEFAULT_MS: { kind: 'external', rationale: 'Default open-orders sync cycle length.' },
    SHARED_ACCOUNT_FETCH_INTERVAL_MIN: { kind: 'external', rationale: 'Shared-account balance fetch cadence.' },
    BTS_ACQUIRE_COOLDOWN_MIN: { kind: 'policy', rationale: 'Cooldown between attempts to acquire BTS for fees.' },

    // --- retry / backoff (bounded policy) -----------------------------------
    RETRY_BACKOFF_CAP_MS: { kind: 'policy', rationale: 'Upper bound on exponential backoff.' },
    FILL_TOTALS_RETRY_BASE_MS: { kind: 'policy', rationale: 'Backoff base for re-processing a fill whose totals were unavailable.' },
    FILL_TOTALS_RETRY_MAX_MS: { kind: 'policy', rationale: 'Backoff ceiling for the same retry.' },
    CREDENTIAL_DAEMON_BROADCAST_RETRIES: { kind: 'policy', rationale: 'Attempt budget for a pinned-node broadcast.' },
    CREDENTIAL_DAEMON_WATCHDOG_MS: { kind: 'external', rationale: 'Watchdog poll cadence.' },
    CREDENTIAL_DAEMON_WATCHDOG_FAILURE_THRESHOLD: { kind: 'policy', rationale: 'Consecutive watchdog failures that mark the daemon dead.' },

    // --- resource bounds (never a correctness gate) -------------------------
    AUDIT_LOG_MAX_FILES: { kind: 'bound', rationale: 'Audit-log rotation bound.' },
    AUDIT_LOG_MAX_SIZE: { kind: 'bound', rationale: 'Audit-log size bound.' },
    CREDENTIAL_DAEMON_MAX_BUFFER_SIZE: { kind: 'bound', rationale: 'Daemon socket buffer bound.' },
    FILL_RECORD_RETENTION_MS: { kind: 'bound', rationale: 'How long persisted fill records are kept (double-credit window).' },
    PROCESSED_FILL_PERSIST_BATCH_SIZE: { kind: 'bound', rationale: 'Coalescing bound for processed-fill writes.' },
    PROCESSED_FILL_PERSIST_BATCH_MS: { kind: 'bound', rationale: 'Coalescing window for processed-fill writes.' },
    MILLISECONDS_PER_SECOND: { kind: 'bound', rationale: 'Unit constant, not a window.' },
    OPEN_ORDERS_SYNC_LOOP_ENABLED: { kind: 'policy', rationale: 'Feature flag, not a window.' },
    GRID_LOCK_HOLD_WARN_MS: { kind: 'bound', rationale: 'Observability: warn when a grid lock is held too long.' },
    LOG_THROTTLE_INTERVAL_MS: { kind: 'bound', rationale: 'Log rate limit.' },
    STALE_TOTALS_WARN_RATE_LIMIT_MS: { kind: 'bound', rationale: 'Log rate limit.' },
    LOCK_REFRESH_MIN_MS: { kind: 'bound', rationale: 'Lease-refresh cadence during long operations.' },
    LOCK_TIMEOUT_MS: { kind: 'external', rationale: 'Order-lock lease length (network latency scale).' },
    MAX_ACCOUNT_TOTALS_AGE_MS: { kind: 'bound', rationale: 'Staleness bound before totals are refetched.' },

    // --- policy windows (real product choices) ------------------------------
    BOUNDARY_HOLD_RESYNC_COOLDOWN_MS: { kind: 'policy', rationale: 'Rate limit on boundary-hold resync escalation.' },
    BOUNDARY_HOLD_RESYNC_THRESHOLD: { kind: 'policy', rationale: 'Consecutive boundary holds before escalation.' },
    GRID_BLOAT_RESYNC_GRACE_MS: { kind: 'policy', rationale: 'Grace before a bloat resync is re-requested.' },
    GRID_PRICE_INVARIANT_RESYNC_COOLDOWN_MS: { kind: 'policy', rationale: 'Rate limit on invariant resync escalation.' },
    GRID_PRICE_INVARIANT_RESYNC_THRESHOLD: { kind: 'policy', rationale: 'Consecutive invariant failures before escalation.' },
    SPREAD_CORRECTION_MAX_ATTEMPTS: { kind: 'policy', rationale: 'Attempt budget for spread correction.' },
    SPREAD_CORRECTION_SYNC_FRESH_MS: { kind: 'policy', rationale: 'How fresh the last sync must be to trust a spread decision.' },
    SPREAD_STALE_ESCALATE_MS: { kind: 'policy', rationale: 'Out-of-spread persistence before escalation.' },
    SPREAD_STALE_FUND_ESCALATE_MS: { kind: 'policy', rationale: 'Shortened escalation window when the cause is fundability.' },
    SPREAD_STALE_GEOMETRY_ESCALATE_MS: { kind: 'policy', rationale: 'Shortened escalation window when the cause is geometry.' },
    SPREAD_STALE_IN_TOLERANCE_RESET_MS: { kind: 'policy', rationale: 'How long in-tolerance must hold before the watchdog resets.' },
    SPREAD_STALE_RESYNC_COOLDOWN_MS: { kind: 'policy', rationale: 'Rate limit on spread-correction resyncs.' },
    SPREAD_STALE_TRANSIENT_GRACE: { kind: 'policy', rationale: 'Consecutive transient corrections tolerated before escalating.' },
    SPREAD_STALE_WARN_MS: { kind: 'policy', rationale: 'Out-of-spread persistence before a warning.' },
    TARGETED_DRIFT_SYNC_COOLDOWN_MS: { kind: 'policy', rationale: 'Rate limit on targeted drift syncs.' },
    DEFERRED_HOLD_ESCALATE_MS: { kind: 'policy', rationale: 'How long an unchanged deferred-hold signature is tolerated.' },
    DEFERRED_HOLD_RESYNC_COOLDOWN_MS: { kind: 'policy', rationale: 'Rate limit on deferred-hold resyncs.' },

    // --- self-healing windows -----------------------------------------------
    //
    // These exist because the engine could not tell two local states apart.
    // modules/order/lifecycle.ts now records the difference explicitly, so each
    // of these is a candidate for deletion once its evidence path is proven in
    // live operation.
    SURPLUS_CANCEL_GRACE_MS: {
        kind: 'self-healing',
        rationale: 'A just-placed order may be missing from a slightly stale reconcile snapshot; wait instead of cancelling it.',
        removal: 'Delete when the COW planner reads the chain id from the lifecycle record (phase landed) instead of tolerating its absence.',
    },
    PENDING_BROADCAST_TTL_MS: {
        kind: 'self-healing',
        rationale: 'A CREATE whose receipt was lost used to be forgotten after a timeout; now it also becomes lifecycle phase unknown.',
        removal: 'Keep as a GC/abandon bound until lost receipts are resolved by evidence (adoption or confirmed absence). The correctness role is already gone — only the retention cap remains.',
    },
    CHAIN_SIZE_APPLIED_MARKER_TTL_MS: {
        kind: 'self-healing',
        rationale: 'Dedupe marker for a chain-size resize already absorbed by sync pass 1.',
        removal: 'Delete when the fill-history path can identify an already-applied resize from the lifecycle record rather than a timestamped marker.',
    },
    BATCH_INFLIGHT_STALE_MS: {
        kind: 'bound',
        rationale: 'Leak watchdog for an in-flight batch flag. Cannot affect a decision.',
    },
    RECOVERY_INFLIGHT_STALE_MS: {
        kind: 'bound',
        rationale: 'Leak watchdog for an in-flight recovery flag.',
    },
    PLACEMENT_STALE_CLEAR_MS: {
        kind: 'bound',
        rationale: 'Leak watchdog for a placement lease.',
    },
    STRUCTURAL_REBUILD_DEFER_MAX_MS: {
        kind: 'self-healing',
        rationale: 'Caps how long a fill-driven rebalance may defer behind a structural rebuild.',
        removal: 'Delete when the rebuild publishes a completion event the rebalance can await instead of polling a deadline.',
    },
    FILL_BROADCAST_DEFER_MAX_MS: {
        kind: 'self-healing',
        rationale: 'Bound on fill-consumer deferral while a broadcast is unresolved.',
        removal: 'Delete when the fill consumer can query the lifecycle phase instead of a clock.',
        derived: true,
    },
    SYNC_LOCK_FORCE_RELEASE_AGE_MS: {
        kind: 'bound',
        rationale: 'Force-release a sync lock held past 2× its timeout (deadlock escape hatch).',
        removal: 'Keep: this is a liveness bound on a lock, not a state guess.',
        derived: true,
    },
    SYNC_SUSPECT_EMPTY_READ_LIMIT: {
        kind: 'policy', rationale: 'Consecutive empty reads before an empty snapshot is believed.',
    },
    FILL_DEDUPE_WINDOW_MS: {
        kind: 'self-healing',
        rationale: 'Lease on a fill CLAIM accepted but not yet booked (deferral/crash). The dedupe horizon is the processed-fill store (FILL_RECORD_RETENTION_MS); a booked key is refused at any age.',
        removal: 'Delete once startup recovery reconciles a restored claim against chain-balance evidence (recomputing the credit from chain truth) instead of bounding it by age.',
    },
});

/**
 * Keys that must never be classified as a time window (units, flags, counts).
 * Kept explicit so the audit list stays honest.
 */
export const NON_WINDOW_KEYS: ReadonlySet<string> = new Set([
    'AUDIT_LOG_MAX_FILES',
    'CREDENTIAL_DAEMON_BROADCAST_RETRIES',
    'CREDIT_DEAL_SPLIT_MAX_PIECES',
    'CREDIT_REBORROW_MAX_ATTEMPTS',
    'MILLISECONDS_PER_SECOND',
    'OPEN_ORDERS_SYNC_LOOP_ENABLED',
    'PROCESSED_FILL_PERSIST_BATCH_SIZE',
    'SPREAD_CORRECTION_MAX_ATTEMPTS',
    'SPREAD_STALE_TRANSIENT_GRACE',
    'BOUNDARY_HOLD_RESYNC_THRESHOLD',
    'GRID_PRICE_INVARIANT_RESYNC_THRESHOLD',
    'CREDENTIAL_DAEMON_WATCHDOG_FAILURE_THRESHOLD',
    'CREDENTIAL_DAEMON_MAX_BUFFER_SIZE',
    'AUDIT_LOG_MAX_SIZE',
    'SYNC_SUSPECT_EMPTY_READ_LIMIT',
]);

/** Name shape that makes a key look like a time window. */
const WINDOW_PATTERN = /(_MS|_MIN|_HOURS|_TTL|_GRACE|_COOLDOWN|_WINDOW|_DELAY|_INTERVAL|_DEADLINE|_TIMEOUT|_AGE|_LIFETIME)$/;

/** True when the key looks like a time window (and is not a declared non-window). */
export function looksLikeTimingWindow(key: string): boolean {
    if (NON_WINDOW_KEYS.has(key)) return false;
    return WINDOW_PATTERN.test(key);
}

/** Classify a timing key, or null when it is not a window or not classified. */
export function classifyTiming(key: string): TimingClassification | null {
    return TIMING_CLASSIFICATIONS[key] ?? null;
}

/**
 * Timing keys that look like windows but carry no classification.
 *
 * This is the growth gate: a new window with no rationale fails the test.
 *
 * @param timing - The live TIMING map (or a fixture)
 * @returns {string[]} Unclassified window keys, sorted
 */
export function unclassifiedTimingKeys(timing: Record<string, unknown>): string[] {
    return Object.keys(timing)
        .filter((key) => looksLikeTimingWindow(key) && classifyTiming(key) === null)
        .sort();
}

/** All classified self-healing windows, ordered by key. */
export function selfHealingWindows(): Array<{ key: string; classification: TimingClassification }> {
    return Object.entries(TIMING_CLASSIFICATIONS)
        .filter(([, classification]) => classification.kind === 'self-healing')
        .map(([key, classification]) => ({ key, classification }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/** All classified derived timings (computed from another timing). */
export function derivedTimings(): string[] {
    return Object.entries(TIMING_CLASSIFICATIONS)
        .filter(([, classification]) => classification.derived === true)
        .map(([key]) => key)
        .sort();
}

/** Count of classified keys per kind, for reporting. */
export function timingKindCounts(): Record<TimingClass, number> {
    const counts: Record<TimingClass, number> = { external: 0, bound: 0, policy: 0, 'self-healing': 0 };
    for (const classification of Object.values(TIMING_CLASSIFICATIONS)) {
        counts[classification.kind] += 1;
    }
    return counts;
}

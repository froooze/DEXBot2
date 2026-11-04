'use strict';
/**
 * modules/node_flap_score.ts - Time-decayed connection-churn (flapping) scoring
 *
 * Node selection used to rank nodes by raw RPC latency only, so the
 * lowest-ping node won even when it dropped its socket every few hours. Live
 * logs showed exactly that: three Cloudflare-fronted endpoints answered in
 * 50-120ms and accounted for every abnormal close, while three
 * 300-360ms endpoints never dropped once — and were never selected.
 *
 * This module turns transport drop *timestamps* into a ranking input:
 *
 *   effectiveLatency = latencyMs + flapPenaltyMs
 *   flapScore        = Σ 0.5 ^ (age_i / halfLife)
 *   flapPenaltyMs    = min(flapScore * DEFAULT_FLAP_PENALTY_MS_PER_DROP, DEFAULT_FLAP_PENALTY_MAX_MS)
 *
 * A node with no recent drops ranks on its ping alone. One undecayed drop costs
 * DEFAULT_FLAP_PENALTY_MS_PER_DROP of effective latency and then fades with the
 * half-life, so a node that flaps once and then behaves is re-admitted
 * automatically, a node that keeps flapping stays at the back of the list, and
 * nothing has to be "reset" by a lucky health probe (the old
 * LIVE_FAILURE_HEALTH_SUCCESS_STREAK wipe-on-success counter).
 *
 * Everything here is pure: callers own persistence and logging. Drop history
 * is bounded by the window (24h default) and capped by MAX_DROP_TIMES, so it
 * is safe to persist in the shared health cache (see node_health_cache.ts).
 */

/** Trailing window of drops that may influence selection. */
const DEFAULT_FLAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Time for a drop's penalty weight to halve. */
const DEFAULT_FLAP_HALF_LIFE_MS = 12 * 60 * 60 * 1000;
/** Effective-latency cost of one *undecayed* drop. */
const DEFAULT_FLAP_PENALTY_MS_PER_DROP = 5_000;
/** Ceiling for the decayed penalty, so a badly degraded node stays usable as a last resort. */
const DEFAULT_FLAP_PENALTY_MAX_MS = 10 * 60 * 1000;
/** Hard cap on retained drop timestamps per node (bounded persistence). */
const MAX_DROP_TIMES = 64;
/** Trailing window used for the reported drops/hour counters. */
const DROP_RATE_WINDOW_MS = 60 * 60 * 1000;

interface FlapScoreOptions {
    nowMs?: number;
    windowMs?: number;
    halfLifeMs?: number;
    penaltyMsPerDrop?: number;
    maxPenaltyMs?: number;
}

interface DropCounters {
    /** Drops inside the last hour (the literal "drops/h" signal). */
    dropsLastHour: number;
    /** Drops inside the trailing `windowMs` (24h by default). */
    drops24h: number;
    /** Averaged drops per hour across the window. */
    dropsPerHour: number;
    /** Decayed drop weight used for ranking. */
    flapScore: number;
    /** Effective latency penalty in ms. */
    penaltyMs: number;
}

function positiveOr(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Drop timestamps that are valid finite numbers, ascending. */
function normalizeDropTimes(dropTimes: unknown): number[] {
    if (!Array.isArray(dropTimes)) return [];
    return dropTimes
        .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0)
        .sort((a, b) => a - b);
}

/**
 * Drop `dropTimes` down to the ones inside the trailing window and cap the
 * retained history. Always returns a new array.
 */
function pruneDropTimes(dropTimes: unknown, nowMs: number = Date.now(), windowMs: number = DEFAULT_FLAP_WINDOW_MS): number[] {
    const window = positiveOr(windowMs, DEFAULT_FLAP_WINDOW_MS);
    const cutoff = nowMs - window;
    const kept = normalizeDropTimes(dropTimes).filter((t) => t > cutoff && t <= nowMs);
    return kept.length > MAX_DROP_TIMES ? kept.slice(kept.length - MAX_DROP_TIMES) : kept;
}

/**
 * Append one drop and return the pruned history. The same millisecond is
 * collapsed (a close + keep-alive trip for the same socket is one event).
 */
function recordDrop(dropTimes: unknown, nowMs: number = Date.now(), windowMs: number = DEFAULT_FLAP_WINDOW_MS): number[] {
    const pruned = pruneDropTimes(dropTimes, nowMs, windowMs);
    if (pruned.length > 0 && pruned[pruned.length - 1] === nowMs) return pruned;
    return pruneDropTimes([...pruned, nowMs], nowMs, windowMs);
}

/**
 * Decayed drop weight: 1.0 for a drop that just happened, 0.5 after one
 * half-life, ~0 after a few. Entries outside the window are ignored.
 */
function flapScore(dropTimes: unknown, nowMs: number = Date.now(), halfLifeMs: number = DEFAULT_FLAP_HALF_LIFE_MS, windowMs: number = DEFAULT_FLAP_WINDOW_MS): number {
    const halfLife = positiveOr(halfLifeMs, DEFAULT_FLAP_HALF_LIFE_MS);
    let score = 0;
    for (const t of pruneDropTimes(dropTimes, nowMs, windowMs)) {
        score += Math.pow(0.5, (nowMs - t) / halfLife);
    }
    return score;
}

/** Effective-latency penalty in ms for the node's recent drops. */
function flapPenaltyMs(dropTimes: unknown, options: FlapScoreOptions = {}): number {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs! : Date.now();
    const score = flapScore(dropTimes, nowMs, options.halfLifeMs, options.windowMs);
    if (score <= 0) return 0;
    const perDrop = positiveOr(options.penaltyMsPerDrop, DEFAULT_FLAP_PENALTY_MS_PER_DROP);
    const maxPenalty = positiveOr(options.maxPenaltyMs, DEFAULT_FLAP_PENALTY_MAX_MS);
    return Math.min(score * perDrop, maxPenalty);
}

/**
 * Latency + decayed flap penalty, the value node selection sorts on.
 * Unknown latency stays `Infinity` so it never outranks a measured node.
 */
function effectiveLatencyMs(latencyMs: number | null | undefined, dropTimes: unknown, options: FlapScoreOptions = {}): number {
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return Infinity;
    return latencyMs + flapPenaltyMs(dropTimes, options);
}

/**
 * Churn counters for logging/persistence: exact trailing-window counts plus
 * the decayed score used for ranking.
 */
function dropCounters(dropTimes: unknown, options: FlapScoreOptions = {}): DropCounters {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs! : Date.now();
    const windowMs = positiveOr(options.windowMs, DEFAULT_FLAP_WINDOW_MS);
    const pruned = pruneDropTimes(dropTimes, nowMs, windowMs);
    const dropsLastHour = pruned.filter((t) => nowMs - t <= DROP_RATE_WINDOW_MS).length;
    const score = flapScore(pruned, nowMs, options.halfLifeMs, windowMs);
    return {
        dropsLastHour,
        drops24h: pruned.length,
        // Round to 2 decimals: a 24h average is meaningless beyond that and the
        // value is persisted in JSON.
        dropsPerHour: Math.round((pruned.length / (windowMs / (60 * 60 * 1000))) * 100) / 100,
        flapScore: Math.round(score * 1000) / 1000,
        penaltyMs: Math.round(flapPenaltyMs(pruned, { ...options, nowMs })),
    };
}

export {
    DEFAULT_FLAP_HALF_LIFE_MS,
    DEFAULT_FLAP_PENALTY_MAX_MS,
    DEFAULT_FLAP_PENALTY_MS_PER_DROP,
    DEFAULT_FLAP_WINDOW_MS,
    DROP_RATE_WINDOW_MS,
    MAX_DROP_TIMES,
    dropCounters,
    effectiveLatencyMs,
    flapPenaltyMs,
    flapScore,
    pruneDropTimes,
    recordDrop,
};
export type { DropCounters, FlapScoreOptions };

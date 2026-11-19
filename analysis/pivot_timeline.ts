#!/usr/bin/env node
'use strict';

/**
 * RUNTIME PIVOT TIMELINE — mirror of the runtime's own LAST-FILL-GUARD state,
 * reconstructed from a bot log (profiles/logs/<bot>.log).
 *
 * Why this exists (2026-11-16 incident, retrospective §9.12 addendum): since
 * `66667052`/`bc7b5232` the pivot only arms on WINDOW fills — wrong-side,
 * too-far (premium sweep) and gap-band fills are refused. A sweep of the bot's
 * own premium rail therefore leaves the pivot several grid steps BELOW the true
 * last fill, and the runtime's gate legitimately passes re-quotes that the
 * strict all-fills checker (which feeds true consecutive fills into the same
 * predicate) flags as violations. The fix is not to change the runtime — the
 * refusal policy is deliberate and protects the rail from the 24h unquoted-side
 * deadlock — but to make the checker audit the gate the runtime ACTUALLY ran.
 *
 * This module parses the log's own pivot bookkeeping into a timeline:
 *
 *   observations  pivot values with timestamps, from (INFO unless noted):
 *                   [FILL-PIVOT] pivot=P(type) ...                (INFO)
 *                   [LAST-FILL-GUARD] mode=... pivot=P(type) ...  (INFO)
 *                   [LAST-FILL-GUARD] Final gate: queue .. pivot A(type)->B(type) (DEBUG, post value)
 *                   [LAST-FILL-GUARD] Re-armed on the new generation: P(type)
 *                 ("Pivot refreshed from N pending queued fill(s)" is NOT an
 *                 observation: it logs the queue content, which may be a fill
 *                 the arming policy just refused; the effective pivot is in
 *                 the adjacent Final-gate / mode= lines.)
 *   refusals      [LAST-FILL-GUARD] Refusing to arm pivot P(type): ...
 *   placements    order-id -> (timestamp, price) gate-judgement anchors, from:
 *                   Placed buy order slot-X @P xS -> 1.7.x        (INFO)
 *                   [COW] Plan action: update slot-X -> slot-Y (orderId=1.7.x, size=.., price=P)
 *   allowances    guard bypasses that keep a below-pivot placement:
 *                   [LAST-FILL-GUARD] Allowing SELL P against pivot ...
 *                   [LAST-FILL-GUARD] Allowing buy evacuation UPDATE ... at P
 *
 * and classifies a strict-mode candidate transition against the pivot the
 * runtime held when the filled order was last priced:
 *
 *   policy-divergence  the runtime pivot would NOT have blocked the placement —
 *                      the pivot lagged the strict last fill because the strict
 *                      fill was refused from arming (sweep/edge/gap-band policy)
 *                      or the placement ran under a guard allowance.
 *   violation          the runtime's OWN pivot would have blocked the
 *                      placement — a real gate failure.
 *   unverifiable       no placement event or no pivot observation near the
 *                      gate — the caller keeps the strict violation (fail
 *                      toward reporting, never toward silence).
 *
 * Approximations (documented, offline-inherent):
 *   - The pivot is selected by ANCHOR KIND. For a `plan-action` anchor the
 *     gate follows the plan, so the FIRST observation at/after the event
 *     within PIVOT_LOOKAHEAD_MS is used (a dropped plan re-planned into a later
 *     batch resolves to that later batch's pivot). For a `placed` anchor the
 *     gate and the broadcast PRECEDE the commit log line, so the LAST
 *     GATE line at/before the event is used (bounded by PIVOT_LOOKBACK_MS) —
 *     `mode`/`final-gate`/`rearm` only. A `fill-pivot` is a fill event, not a
 *     gate, and is never used as a fallback; with no gate line the candidate
 *     is `unverifiable`. Using a forward lookup picks the NEXT batch's pivot
 *     — audit-side false violations (retrospective §9.14). The placement anchor is the
 *     order's event whose PRICE matches the filled price (a rotation to
 *     another level belongs to a different epoch); without a price match the
 *     latest event in the window is used.
 *   - Band-exempt allowances are logged at DEBUG; without debug logs such a
 *     transition stays a violation (conservative: fail toward reporting).
 *   - Spread-correction placements go through the same Plan/Placed lines, so
 *     they are covered; a correction order whose placement event is missing
 *     resolves to 'unverifiable' (kept as a strict violation).
 */

import { isLastFillGuardBlocked } from '../modules/order/utils/system.js';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface PivotObservation {
    t: number;
    price: number;
    type: string;
    src: 'fill-pivot' | 'mode' | 'final-gate' | 'rearm';
}
export interface RefusalEvent {
    t: number;
    price: number;
    type: string;
}
export interface PlacementEvent {
    t: number;
    orderId: string;
    price: number;
    kind: 'placed' | 'plan-action';
}
export interface AllowanceEvent {
    t: number;
    direction: string;
    price: number;
}
export interface RuntimeLogIndex {
    observations: PivotObservation[];
    refusals: RefusalEvent[];
    placements: Map<string, PlacementEvent[]>;
    allowances: AllowanceEvent[];
}
export interface TransitionCandidate {
    prevTime: string;
    currTime: string;
    prevPrice: number;
    currPrice: number;
    direction: 'buy' | 'sell';
    currOrderId: string;
}
export interface TransitionVerdict {
    verdict: 'policy-divergence' | 'violation' | 'unverifiable';
    reason: string;
    /** The runtime pivot used at the gate (null when unverifiable). */
    pivot: { price: number; type: string; t: number; src?: PivotObservation['src'] } | null;
    /** Refusals logged between the two fills (sweep-policy context). */
    refusalsInRange: number;
    /** The placement event used as the gate anchor (null when unverifiable). */
    anchor: { kind: PlacementEvent['kind']; t: number; price: number; orderId: string } | null;
    /** Which pivot-selection rule produced the verdict (null when unverifiable). */
    pivotSelection: 'forward' | 'backward' | null;
}

/** Audit-only classifier options. Default is the corrected source-aware rule. */
export interface ClassifyOptions {
    /**
     * `forward` reproduces the pre-§9.14 bug (every anchor judged against the
     * first observation after it). Used by the checker to report reclassified
     * candidates as `pivot-anchor-artifact` instead of silently dropping them.
     */
    pivotRule?: 'source-aware' | 'forward';
}

/** How far after a placement event the judging gate may log its pivot. */
export const PIVOT_LOOKAHEAD_MS = 120_000;
/** How far before a `placed` event its pre-commit gate pivot may still be. */
export const PIVOT_LOOKBACK_MS = 120_000;
/** How wide an allowance match may drift around the gate pivot. */
export const ALLOWANCE_WINDOW_MS = 120_000;
/**
 * Kibana truncates fill timestamps to the second while the runtime logs the
 * order's Placed/Plan-action line a few hundred ms later, so a naive
 * `placement.t <= fill.t` test can miss the anchor. An order cannot fill
 * before it exists, so placements slightly AFTER the (truncated) fill
 * timestamp are still valid anchors.
 */
export const PLACEMENT_AFTER_FILL_MS = 5_000;
/** Relative price tolerance when matching an allowance to a fill price. */
const ALLOWANCE_PRICE_TOL = 5e-5;
/**
 * Relative price tolerance when picking the placement anchor for a fill:
 * maker fills average slightly off the quote price, so the anchor is the
 * placement whose price is within 0.1% of the filled price. A rotation to a
 * different grid level is far outside this band and never matches.
 */
const PLACEMENT_PRICE_TOL = 1e-3;

// ─── Line parsing ─────────────────────────────────────────────────────────────
const TS_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/;

function lineTs(line: string): number | null {
    const m = TS_RE.exec(line);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : null;
}

/** "1,538.559125" | "1538.559125" | "1.3534" -> number | null */
function num(raw: string): number | null {
    if (!raw) return null;
    const v = Number(raw.replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
}

const FILL_PIVOT_RE = /\[FILL-PIVOT\] pivot=([\d.,eE+-]+)\((buy|sell)\)/;
const MODE_RE = /\[LAST-FILL-GUARD\] mode=\S+ pivot=([\d.,eE+-]+)\((buy|sell)\)/;
const FINAL_GATE_RE = /\[LAST-FILL-GUARD\] Final gate: queue \S+ pivot [\d.,eE+-]+\((?:buy|sell)\)->([\d.,eE+-]+)\((buy|sell)\)/;
const REARM_RE = /\[LAST-FILL-GUARD\] Re-armed on the new generation: ([\d.,eE+-]+)\((buy|sell)\)/;
const REFUSAL_RE = /\[LAST-FILL-GUARD\] Refusing to arm pivot ([\d.,eE+-]+)\((buy|sell)\)/;
const PLACED_RE = /\[DEXBot\] Placed (buy|sell) order slot-[\w-]+ @([\d.,eE+-]+) x[\d.,eE+-]+ -> (1\.7\.\d+)/;
const PLAN_ACTION_RE = /\[COW\] Plan action: (?:update|create) \S+(?: -> \S+)? \(orderId=(1\.7\.\d+)[^)]*?price=([\d.,eE+-]+)/;
// "Allowing buy evacuation UPDATE for slot-X -> slot-Y at P: ..." (price after "at")
// "Allowing SELL P against pivot Q: ..." (placement price right after the direction word)
const ALLOW_AT_RE = /\s+at\s+([\d.,eE+-]+)/;
const ALLOW_AGAINST_RE = /\b(?:BUY|SELL) ([\d.,eE+-]+) against/;
const ALLOW_DIR_RE = /\b(buy|sell|BUY|SELL)\b/;

/**
 * Parse a bot log into the runtime pivot index. Unknown lines are skipped;
 * the parser is deliberately tolerant of level/tag variation because it must
 * work on rotated and filtered logs too.
 */
export function parseRuntimeLog(text: string): RuntimeLogIndex {
    const observations: PivotObservation[] = [];
    const refusals: RefusalEvent[] = [];
    const placements = new Map<string, PlacementEvent[]>();
    const allowances: AllowanceEvent[] = [];

    for (const line of text.split('\n')) {
        const t = lineTs(line);
        if (t == null) continue;

        let m = FILL_PIVOT_RE.exec(line);
        if (m) {
            const price = num(m[1]);
            if (price != null && price > 0) observations.push({ t, price, type: m[2], src: 'fill-pivot' });
            continue;
        }
        m = MODE_RE.exec(line);
        if (m) {
            const price = num(m[1]);
            if (price != null && price > 0) observations.push({ t, price, type: m[2], src: 'mode' });
            continue;
        }
        m = FINAL_GATE_RE.exec(line);
        if (m) {
            const price = num(m[1]);
            if (price != null && price > 0) observations.push({ t, price, type: m[2], src: 'final-gate' });
            continue;
        }
        m = REARM_RE.exec(line);
        if (m) {
            const price = num(m[1]);
            if (price != null && price > 0) observations.push({ t, price, type: m[2], src: 'rearm' });
            continue;
        }
        m = REFUSAL_RE.exec(line);
        if (m) {
            const price = num(m[1]);
            if (price != null && price > 0) refusals.push({ t, price, type: m[2] });
            continue;
        }
        m = PLACED_RE.exec(line);
        if (m) {
            const price = num(m[2]);
            if (price != null) pushPlacement(placements, { t, orderId: m[3], price, kind: 'placed' });
            continue;
        }
        m = PLAN_ACTION_RE.exec(line);
        if (m) {
            const price = num(m[2]);
            if (price != null) pushPlacement(placements, { t, orderId: m[1], price, kind: 'plan-action' });
            continue;
        }
        if (line.includes('[LAST-FILL-GUARD] Allowing')) {
            const dm = ALLOW_DIR_RE.exec(line.slice(line.indexOf('Allowing')));
            const am = ALLOW_AT_RE.exec(line) ?? ALLOW_AGAINST_RE.exec(line);
            if (dm && am) {
                const price = num(am[1]);
                if (price != null) allowances.push({ t, direction: dm[1].toLowerCase(), price });
            }
            continue;
        }
    }

    observations.sort((a, b) => a.t - b.t);
    refusals.sort((a, b) => a.t - b.t);
    allowances.sort((a, b) => a.t - b.t);
    for (const list of placements.values()) list.sort((a, b) => a.t - b.t);
    return { observations, refusals, placements, allowances };
}

/**
 * Kibana fills carry an operation suffix on the order id (e.g. `1.7.x:se`),
 * while the runtime log's Plan/Placed lines use the plain `1.7.x`. Normalize
 * to the plain id on both sides so the join works.
 */
function normalizeOrderId(orderId: string): string {
    const colon = orderId.indexOf(':');
    return colon === -1 ? orderId : orderId.slice(0, colon);
}

function pushPlacement(map: Map<string, PlacementEvent[]>, ev: PlacementEvent): void {
    ev.orderId = normalizeOrderId(ev.orderId);
    const list = map.get(ev.orderId);
    if (list) list.push(ev);
    else map.set(ev.orderId, [ev]);
}

/**
 * Gate-decision observations only. A `fill-pivot` line reports a fill event,
 * not a placement gate, so it must never re-judge an order already priced.
 * Cached per index so repeated classifyTransition calls do not re-filter the
 * full observation timeline (relevant for multi-month logs). Assumes the index
 * is immutable after parseRuntimeLog — both call sites only read it; sorting
 * or appending observations afterwards would leave this cache stale.
 */
const gateIndexCache = new WeakMap<RuntimeLogIndex, PivotObservation[]>();
function gateObservationsOf(index: RuntimeLogIndex): PivotObservation[] {
    let cached = gateIndexCache.get(index);
    if (!cached) {
        cached = index.observations.filter(o => o.src !== 'fill-pivot');
        gateIndexCache.set(index, cached);
    }
    return cached;
}

/** Latest pivot observation at or before `t` (binary search), or null. */
export function pivotAtOrBefore(observations: PivotObservation[], t: number): PivotObservation | null {
    let lo = 0;
    let hi = observations.length - 1;
    let best: PivotObservation | null = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (observations[mid].t <= t) {
            best = observations[mid];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

/** First pivot observation at or after `t`, or null when none within the window. */
export function pivotAtOrAfter(observations: PivotObservation[], t: number, windowMs: number = PIVOT_LOOKAHEAD_MS): PivotObservation | null {
    let lo = 0;
    let hi = observations.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (observations[mid].t < t) lo = mid + 1;
        else hi = mid;
    }
    if (lo < observations.length && observations[lo].t - t <= windowMs) return observations[lo];
    return null;
}

function lastPlacementBefore(map: Map<string, PlacementEvent[]>, orderId: string, t: number, fillPrice: number | null): PlacementEvent | null {
    const limit = t + PLACEMENT_AFTER_FILL_MS;
    const list = map.get(orderId);
    if (!list || list.length === 0) return null;
    let latest: PlacementEvent | null = null;
    let priced: PlacementEvent | null = null;
    for (const ev of list) {
        if (ev.t > limit) break;
        latest = ev;
        if (fillPrice != null) {
            const denom = Math.max(Math.abs(fillPrice), 1e-12);
            if (Math.abs(ev.price - fillPrice) / denom <= PLACEMENT_PRICE_TOL) priced = ev;
        }
    }
    // Prefer the epoch the fill actually belongs to (price-matched re-quote);
    // the latest event is only a fallback when no quote matches the fill.
    return priced ?? latest;
}

function countRefusalsBetween(refusals: RefusalEvent[], from: number, to: number): number {
    let n = 0;
    for (const r of refusals) {
        if (r.t > from && r.t <= to) n++;
        if (r.t > to) break;
    }
    return n;
}

function findAllowance(allowances: AllowanceEvent[], direction: string, price: number, from: number, to: number): AllowanceEvent | null {
    for (const a of allowances) {
        if (a.t < from) continue;
        if (a.t > to) break;
        if (a.direction !== direction) continue;
        const denom = Math.max(Math.abs(price), 1e-12);
        if (Math.abs(a.price - price) / denom <= ALLOWANCE_PRICE_TOL) return a;
    }
    return null;
}

/**
 * Parse an ISO timestamp. Kibana fill times are UTC but written naive
 * (`2026-11-16T14:08:18`, no offset); Date.parse would read those as LOCAL
 * time and shift the timeline by the host's UTC offset. Treat any timestamp
 * without an explicit offset as UTC — the log lines and Kibana agree on UTC.
 */
function parseIso(t: string): number {
    if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(t)) return Date.parse(t + 'Z');
    return Date.parse(t);
}

/**
 * Classify one strict-mode candidate transition against the pivot the runtime
 * held when `currOrderId` was last priced. Verdicts and the fail direction are
 * documented in the module header: anything unprovable stays a violation.
 */
export function classifyTransition(
    cand: TransitionCandidate,
    index: RuntimeLogIndex,
    opts: ClassifyOptions = {},
): TransitionVerdict {
    const currT = parseIso(cand.currTime);
    const prevT = parseIso(cand.prevTime);
    const unverifiable = (
        reason: string,
        anchor: TransitionVerdict['anchor'] = null,
        pivotSelection: TransitionVerdict['pivotSelection'] = null,
    ): TransitionVerdict => ({
        verdict: 'unverifiable',
        reason,
        pivot: null,
        refusalsInRange: Number.isFinite(prevT) && Number.isFinite(currT)
            ? countRefusalsBetween(index.refusals, prevT, currT)
            : 0,
        anchor,
        pivotSelection,
    });

    if (!Number.isFinite(currT)) return unverifiable('unparseable curr fill timestamp');
    const placement = lastPlacementBefore(index.placements, normalizeOrderId(cand.currOrderId), currT, cand.currPrice);
    if (!placement) {
        return unverifiable(`no placement event for order ${cand.currOrderId} before the fill`);
    }
    // A plan-action anchor precedes the gate; a placed anchor FOLLOWS it (the
    // Placed line is emitted at commit, after runFinalPivotGate and broadcast).
    // Using a forward lookup on a placed anchor picks the NEXT batch's pivot —
    // the §9.14 audit defect. Legacy `forward` reproduces that old verdict for
    // the checker's artifact section; it is not the default.
    const useBackward = opts.pivotRule !== 'forward' && placement.kind === 'placed';
    const anchor = {
        kind: placement.kind,
        t: placement.t,
        price: placement.price,
        orderId: placement.orderId,
    };
    let obs: PivotObservation | null;
    let tooOld = false;
    if (!useBackward) {
        obs = pivotAtOrAfter(index.observations, placement.t);
    } else {
        // A `fill-pivot` line is a FILL-processing event, not a gate decision.
        // For a `placed` anchor the effective pivot is ONLY in the batch's
        // mode=/Final-gate/re-arm line. There is deliberately no fallback to
        // a fill-pivot: a fill between the gate and the commit must not
        // re-judge an order that was already priced. If no gate line is
        // available (cold/unuarded batch), the candidate is unverifiable.
        obs = pivotAtOrBefore(gateObservationsOf(index), placement.t);
        if (obs && placement.t - obs.t > PIVOT_LOOKBACK_MS) {
            tooOld = true;
            obs = null;
        }
    }
    if (!obs) {
        return unverifiable(
            tooOld
                ? `gate pivot observation is older than ${PIVOT_LOOKBACK_MS / 1000}s before the placed event`
                : useBackward
                    ? `no gate pivot observation at/before the ${placement.kind} event`
                    : `no pivot observation within ${PIVOT_LOOKAHEAD_MS / 1000}s of the placement event`,
            anchor,
            useBackward ? 'backward' : 'forward',
        );
    }
    const refusalsInRange = Number.isFinite(prevT)
        ? countRefusalsBetween(index.refusals, prevT, currT)
        : 0;
    const pivot = { price: obs.price, type: obs.type, t: obs.t, src: obs.src };
    const check = isLastFillGuardBlocked(cand.currPrice, cand.direction, obs.price, obs.type);
    const pivotSelection = useBackward ? 'backward' : 'forward' as const;
    if (!check.blocked) {
        return {
            verdict: 'policy-divergence',
            reason: refusalsInRange > 0
                ? `runtime pivot ${obs.price}(${obs.type}) at the gate excluded the strict last fill from arming (window-trade policy, ${refusalsInRange} refusal(s) between the fills)`
                : `runtime pivot ${obs.price}(${obs.type}) at the gate was older than the strict last fill`,
            pivot,
            refusalsInRange,
            anchor,
            pivotSelection,
        };
    }
    const allowed = findAllowance(index.allowances, cand.direction, cand.currPrice, pivot.t - ALLOWANCE_WINDOW_MS, pivot.t + 5000);
    if (allowed) {
        return {
            verdict: 'policy-divergence',
            reason: `guard allowance logged at the gate (band-exempt / stamped evacuation; pivot ${obs.price}(${obs.type}))`,
            pivot,
            refusalsInRange,
            anchor,
            pivotSelection,
        };
    }
    return {
        verdict: 'violation',
        reason: `the runtime's own pivot ${obs.price}(${obs.type}) would have blocked this placement`,
        pivot,
        refusalsInRange,
        anchor,
        pivotSelection,
    };
}

#!/usr/bin/env node
'use strict';

/**
 * LAST-FILL-GUARD CHECK
 *
 * Validates LAST-FILL-GUARD discipline — DIRECTION ONLY, relative to the last
 * fill price (v1.6.17+, retrospective §9.7):
 *   BUY  blocked if price >= pivot
 *   SELL blocked if price <= pivot
 *   e.g. pivot 1000 => BUY must be < 1000, SELL must be > 1000.
 *   Cold start (no previous fill) is disabled.
 *
 * The older rule judged against `pivot ± increment/2` and ignored the fill
 * side, which blocked a BUY below a SELL fill and a SELL one tick above our
 * cost — i.e. it reported the tightening placements the current engine
 * legitimately makes as violations. Do not reintroduce an increment term here.
 *
 * MODES — the strict check above is available as `--strict`. The DEFAULT is
 * policy-aware: it additionally reconstructs the pivot the runtime ACTUALLY
 * held when each filled order was last priced (from the bot log's own pivot
 * bookkeeping — FILL-PIVOT / mode= / Final-gate / refusal lines, parsed by
 * `analysis/pivot_timeline.ts`) and re-judges every strict candidate against
 * that pivot:
 *   - violation          the runtime's OWN pivot would have blocked the
 *                        placement — a real gate failure.
 *   - policy-divergence  the runtime pivot would have passed it — expected
 *                        under the pivot-arming policy (see gaps below);
 *                        reported in its own section, not counted as FAIL.
 *   - unverifiable       no placement event / pivot observation near the gate
 *                        — kept as a violation (fail toward reporting).
 *
 * Anchor selection is source-aware (§9.14): a `plan-action` anchor looks FORWARD
 * to the gate, a `placed` anchor looks BACKWARD to the gate line (preferring
 * mode=/Final-gate/rearm over an intervening fill-pivot). Candidates that were
 * in the old FAIL list but pass the corrected rule are reported under
 * `pivot-anchor-artifact` — neither failures nor ordinary divergences.
 *
 * Intentional offline gaps (documented, acceptable):
 *   - Runtime pivots on _lastFilledPrice/_lastFilledType at decision time; tool
 *     checks consecutive fill pairs. For batch-placed orders (multiple orders
 *     guarded against the same pivot in one COW batch) this diverges — inherent
 *     offline approximation.
 *   - Spread-correction bypass (cowResult.origin === 'spread-correction') is
 *     not simulated — every consecutive pair is checked (correction placements
 *     do appear in the runtime log's Plan/Placed lines, so the policy-aware
 *     mirror can still excuse them when the pivot passes them).
 *   - EDGE-pinned insurance fills no longer arm the runtime pivot
 *     (recordLastFilledPrices skips them); this reconstruction has no slot
 *     identity for a fill, so it cannot classify edge fills and will still
 *     judge the pair after one. Expect rare false positives on wick fills.
 *   - PIVOT-ARMING REFUSALS (HISTORICAL, pre-§9.16; 66667052 / bc7b5232): a
 *     fill refused from arming the pivot (wrong-side, too-far premium sweep,
 *     gap-band stranded residual) leaves the pivot behind the true last fill,
 *     and a re-quote the gate passes is NOT a discipline breach. The strict
 *     mode flags these; policy-aware mode classifies them as divergences.
 *     Without a usable runtime log the tool falls back to strict and says so.
 *
 * Uses the runtime's own predicate (`modules/order/utils/system.ts:`
 * `isLastFillGuardBlocked`); the checker never re-implements it.
 *
 * Fetches fill_order operations from Kibana (same pipeline as
 * trade_profitability.ts) and checks for last-fill guard violations.
 *
 * Usage:
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 168
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --start 2025-01-01 --end 2025-06-01
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --account 1.2.123
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --json results.json
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --csv violations.csv
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --increment 0.5
 *   node dist/analysis/grid_correction_check.js --list-bots
 */

import { getErrorMessage, getErrorField } from '../modules/utils/errors.js';
import { isLastFillGuardBlocked } from '../modules/order/utils/system.js';
import { pricesWithinHalfStep } from '../modules/order/utils/math.js';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as KC from '../market_adapter/core/kibana_client.js';
import * as C from '../modules/constants.js';
import { loadBotSettings, computeBotKey } from './bot_key_utils.js';
import { resolveBotAccount } from './account_resolver.js';
import {
    FillRecord,
    classifyFill,
    assetSymbol,
    fetchAllFills,
    resolveAssetPrecisions,
} from './fills_source.js';
import {
    parseRuntimeLog,
    classifyTransition,
    TransitionCandidate,
    RuntimeLogIndex,
} from './pivot_timeline.js';
import type { RefusalEvent } from './pivot_timeline.js';
import path from 'node:path';

const { kibanaSearch, DEFAULT_CONFIG: BASE_CONFIG } = KC;

const OP_LIMIT_ORDER_UPDATE = 77;

// ─── Types ────────────────────────────────────────────────────────────────────
interface OrderUpdate {
    orderId: string;
    sequence: number;
}
interface TradeFill {
    time: string;
    orderId: string;
    direction: 'buy' | 'sell';
    baseAsset: string;
    quoteAsset: string;
    baseAmount: number;
    quoteAmount: number;
    price: number;
    isMaker: boolean;
    sequence: number;
}
interface Violation {
    index: number;
    pair: string;
    direction: 'buy' | 'sell';
    expected: string;
    prev: TradeFill;
    curr: TradeFill;
    priceDelta: number;
    priceDeltaPct: number;
    pivot: number;
    /** Direction-only rule has no band; kept at 0 so the JSON/CSV shape is stable. */
    halfInc: number;
    /** The pivot itself (BUY must be below / SELL above it). */
    threshold: number;
    /**
     * Same-level re-fill (§0 "equal is a violation — a re-place at the
     * just-filled level"; §9.12/P2): the transition stayed within half a grid
     * step of the previous same-side fill (the runtime's own same-level test,
     * pricesWithinHalfStep). Realized fill prices of one re-placed level differ
     * by sub-sat rounding dust, so a float-exact compare passes such a loop.
     * Present on the violation regardless of which rule caught it.
     */
    sameLevel?: boolean;
    /** Policy-aware mirror evidence: absent in --strict or the same-level-marker path. */
    mirrorVerdict?: 'violation' | 'unverifiable' | null;
    mirrorReason?: string | null;
    /** Runtime gate pivot used by the mirror (distinct from the strict `pivot`). */
    mirrorPivot?: { price: number; type: string; t: number; src?: string } | null;
    anchor?: { kind: string; t: number; price: number; orderId: string } | null;
    pivotSelection?: 'forward' | 'backward' | null;
}
interface AggregatedOrder {
    orderId: string;
    direction: 'buy' | 'sell';
    baseAsset: string;
    quoteAsset: string;
    baseAmount: number;
    quoteAmount: number;
    price: number;
    time: string;
    sequence: number;
    fillCount: number;
    isMaker: boolean;
}
/** A strict candidate the runtime's own gate would have passed (policy-aware mode). */
interface PolicyDivergence {
    index: number;
    pair: string;
    direction: 'buy' | 'sell';
    prev: TradeFill;
    curr: TradeFill;
    pivot: { price: number; type: string; t: number; src?: string } | null;
    reason: string;
    refusalsInRange: number;
    priceDeltaPct: number;
    /** True when the candidate is a same-level re-fill (within half a grid step of the previous same-side fill). */
    sameLevel?: boolean;
    anchor: { kind: string; t: number; price: number; orderId: string } | null;
    pivotSelection: 'forward' | 'backward' | null;
}

/**
 * A strict candidate that was in the pre-§9.14 FAIL list (the old forward
 * lookup either blocked it or could not verify it) but passes the corrected
 * source-aware rule. Kept in its own report section so the audit correction
 * stays visible instead of silently shrinking the FAIL count.
 * NOT a gate failure and NOT an ordinary policy divergence.
 */
interface PivotAnchorArtifact {
    index: number;
    pair: string;
    direction: 'buy' | 'sell';
    prev: TradeFill;
    curr: TradeFill;
    anchor: { kind: string; t: number; price: number } | null;
    legacyPivot: { price: number; type: string; t: number; src?: string } | null;
    correctedPivot: { price: number; type: string; t: number; src?: string } | null;
    reason: string;
    priceDeltaPct: number;
}

/**
 * SAME-LEVEL REFUSAL MARKER (HISTORICAL, pre-§9.16; §9.12/P2): did the runtime refuse the
 * pivot-arm of the just-filled level shortly before this same-level re-fill?
 * The amended runtime writes a same-level re-fill block when it refuses a
 * pivot arm, so a same-level fill that the log shows SHOULD have been blocked
 * is a gate failure — a violation even in policy-aware mode — not a policy
 * divergence. Fail-open: no log, no matching refusal => normal mirror verdict.
 * Returns the MATCHED refusal event, not a boolean, so the FAIL entry can carry
 * the price/timestamp that decided it (Finding 1 provenance).
 */
function sameLevelRefusalMarker(
    index: RuntimeLogIndex | null,
    v: Violation,
    incrementPercent: number,
): RefusalEvent | null {
    if (!index) return null;
    const prevT = Date.parse(v.prev.time + (/[Zz]|[+-]\d\d:?(\d\d)?$/.test(v.prev.time) ? '' : 'Z'));
    const currT = Date.parse(v.curr.time + (/[Zz]|[+-]\d\d:?(\d\d)?$/.test(v.curr.time) ? '' : 'Z'));
    if (!Number.isFinite(prevT) || !Number.isFinite(currT)) return null;
    const ttl = Number(C.GRID_LIMITS?.LAST_FILL_REFUSED_LEVEL_TTL_MS ?? 0);
    if (!(ttl > 0)) return null;
    for (const r of index.refusals) {
        if (r.type !== v.direction) continue;
        if (r.t > currT) continue;
        if (currT - r.t > ttl) continue;
        // The marker must postdate the just-filled trade itself (5s slack for
        // block-time vs log-clock skew), else it describes an older level.
        if (r.t < prevT - 5000) continue;
        if (pricesWithinHalfStep(r.price, v.prev.price, incrementPercent)) return r;
    }
    return null;
}

/**
 * Policy-aware mirror: re-judge every strict violation against the pivot the
 * runtime held when the filled order was last priced (parsed from the bot log
 * by pivot_timeline.ts). Candidates the runtime's OWN pivot would have passed
 * become policy divergences — expected under the pivot-arming policy, not gate
 * failures — and are dropped from the FAIL count. Anything unprovable stays a
 * violation (fail toward reporting). A missing log falls back to strict mode.
 */
function applyRuntimeMirror(
    violations: Violation[],
    logPath: string,
    incrementPercent: number,
): {
    kept: Violation[];
    divergences: PolicyDivergence[];
    artifacts: PivotAnchorArtifact[];
    index: RuntimeLogIndex | null;
    logError: string | null;
} {
    let text: string;
    try {
        text = fs.readFileSync(logPath, 'utf-8');
    } catch (e) {
        return { kept: violations, divergences: [], artifacts: [], index: null, logError: getErrorMessage(e) };
    }
    const index = parseRuntimeLog(text);
    const kept: Violation[] = [];
    const divergences: PolicyDivergence[] = [];
    const artifacts: PivotAnchorArtifact[] = [];
    for (const v of violations) {
        // Same-level re-fill whose just-filled level carries a fresh refusal
        // marker in the log: the amended §9.12/P2 gate would have blocked the
        // re-placement — it filled anyway => gate failure, keep as violation.
        const marker = v.sameLevel ? sameLevelRefusalMarker(index, v, incrementPercent) : null;
        if (marker) {
            kept.push({
                ...v,
                mirrorVerdict: 'violation',
                mirrorReason: `same-level refusal marker (§9.12/P2): ${marker.price}(${marker.type}) at ${new Date(marker.t).toISOString()} — the amended gate would have blocked this re-placement`,
                mirrorPivot: null,
                anchor: null,
                pivotSelection: null,
            });
            continue;
        }
        const cand: TransitionCandidate = {
            prevTime: v.prev.time,
            currTime: v.curr.time,
            prevPrice: v.prev.price,
            currPrice: v.curr.price,
            direction: v.direction,
            currOrderId: v.curr.orderId,
        };
        const verdict = classifyTransition(cand, index);
        if (verdict.verdict === 'policy-divergence') {
            // Audit trail for the §9.14 correction: anything that was in the
            // OLD FAIL list (violation OR unverifiable, both kept as failures)
            // but passes the corrected source-aware rule is reclassified into
            // its own section — never silently dropped from the report.
            const legacy = classifyTransition(cand, index, { pivotRule: 'forward' });
            if (legacy.verdict !== 'policy-divergence') {
                artifacts.push({
                    index: v.index,
                    pair: v.pair,
                    direction: v.direction,
                    prev: v.prev,
                    curr: v.curr,
                    anchor: verdict.anchor
                        ? { kind: verdict.anchor.kind, t: verdict.anchor.t, price: verdict.anchor.price }
                        : null,
                    legacyPivot: legacy.pivot,
                    correctedPivot: verdict.pivot,
                    reason: verdict.reason,
                    priceDeltaPct: v.priceDeltaPct,
                });
            } else {
                divergences.push({
                    index: v.index,
                    pair: v.pair,
                    direction: v.direction,
                    prev: v.prev,
                    curr: v.curr,
                    pivot: verdict.pivot,
                    reason: verdict.reason,
                    refusalsInRange: verdict.refusalsInRange,
                    priceDeltaPct: v.priceDeltaPct,
                    sameLevel: v.sameLevel,
                    anchor: verdict.anchor ? { ...verdict.anchor } : null,
                    pivotSelection: verdict.pivotSelection,
                });
            }
        } else {
            // Keep the mirror evidence on every FAIL entry so the verdict can
            // be re-checked from the JSON/CSV without re-running the checker.
            kept.push({
                ...v,
                mirrorVerdict: verdict.verdict,
                mirrorReason: verdict.reason,
                mirrorPivot: verdict.pivot ? { ...verdict.pivot } : null,
                anchor: verdict.anchor ? { ...verdict.anchor } : null,
                pivotSelection: verdict.pivotSelection,
            });
        }
    }
    return { kept, divergences, artifacts, index, logError: null };
}

// ─── LAST-FILL-GUARD (the runtime's own predicate) ──────────────────────────────
//
// `isLastFillGuardBlocked` is IMPORTED from modules/order/utils/system.ts, not
// re-implemented. The old local copy was labelled "mirrors 1:1" and had already
// kept the removed band term; a copy of a rule is a second rule waiting to drift
// (retrospective R3.5 / §9.10/P5). The module returns `{blocked, pivot}`
// — there is no `halfInc`, because the increment no longer participates.

function resolveIncrementPercent(botMeta: { incrementPercent?: unknown } | null | undefined, override: number | null): number {
    if (override != null && Number.isFinite(override) && override > 0) return override;
    const fromBot = Number(botMeta?.incrementPercent);
    if (Number.isFinite(fromBot) && fromBot > 0) return fromBot;
    const fromDefault = Number(C.DEFAULT_CONFIG?.incrementPercent ?? 0.5);
    if (Number.isFinite(fromDefault) && fromDefault > 0) return fromDefault;
    return 0.5;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function printHelp() {
    console.log(`\
Usage: node dist/analysis/grid_correction_check.js --bot-key <key> [options]

Validates LAST-FILL-GUARD discipline (DIRECTION ONLY relative to the last fill):
  BUY must be < last fill price, SELL must be > last fill price.
  Equal price counts as blocked (a re-place at the just-filled level); so does
  a same-level re-fill within half a grid step of the just-filled level
  (the runtime's own pricesWithinHalfStep test, §9.12/P2).
  Uses the runtime's own predicate (isLastFillGuardBlocked); not a copy.
  Cold start (no previous fill) is disabled.

Required:
  --bot-key <key>        Bot key (e.g. my-grid-bot) or bot name (use --list-bots)

Time range (one of):
  --hours <n>            Lookback hours from now (default: 168)
  --start <iso>          Start time (ISO 8601)
  --end <iso>            End time (ISO 8601, default: now)

Options:
  --account <id>         Override account ID (default: from bot preferredAccount)
  --refresh-account      Force re-resolution of preferredAccount and update the
                         stored accountId when it changed (default: reuse the
                         stored accountId with no chain lookup)
  --increment <pct>      Grid increment percent, informational only — the
                         direction-only guard does not use a band
                         (default: from bot config or ${Number(C.DEFAULT_CONFIG?.incrementPercent ?? 0.5)})
  --runtime-log <path>   Bot log for the policy-aware mirror (default:
                         profiles/logs/<bot name>.log when it exists)
  --strict               Skip the runtime-pivot mirror; report every
                         consecutive-fill descent as a violation (legacy
                         behaviour — false positives on pivot-arm refusals)
  --per-fill             Check at fill granularity (default: per-order aggregated)
  --include-cross-pair   Check consecutive fills across different pairs (default: same pair only)
  --json <file>          Export violations, divergences and artifacts as JSON
  --csv <file>           Export violations as CSV
  --verbose              Print the fetched trade sequence before checking
  --list-bots            List available bot keys and exit
  --help, -h             Show this help

Examples:
  node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720
  node dist/analysis/grid_correction_check.js --bot-key "<bot-key>" --start 2025-01-01 --end 2025-06-01
  node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 168 --increment 1.0
`);
}

interface CliOpts {
    botKey: string | null;
    hours: number | null;
    start: string | null;
    end: string | null;
    account: string | null;
    refreshAccount: boolean;
    perFill: boolean;
    includeCrossPair: boolean;
    incrementPercent: number | null;
    json: string | null;
    csv: string | null;
    verbose: boolean;
    runtimeLog: string | null;
    strict: boolean;
}

function parseArgs(): CliOpts {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) { printHelp(); process.exit(0); }
    if (args.includes('--list-bots')) {
        const settings = loadBotSettings();
        const entries = settings?.bots ?? [];
        if (!entries.length) { console.log('No bots in profiles/bots.json'); process.exit(0); }
        console.log('Available bot keys:');
        for (let i = 0; i < entries.length; i++) {
            const k = computeBotKey(entries[i], i);
            console.log(`  ${k}  (name: ${entries[i].name ?? '-'}, ${entries[i].assetA}/${entries[i].assetB}, account: ${entries[i].preferredAccount ?? '-'})`);
        }
        process.exit(0);
    }

    const opts: CliOpts = {
        botKey: null,
        hours: null,
        start: null,
        end: null,
        account: null,
        refreshAccount: false,
        perFill: false,
        includeCrossPair: false,
        incrementPercent: null as number | null,
        json: null,
        csv: null,
        verbose: false,
        runtimeLog: null as string | null,
        strict: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--bot-key': opts.botKey = args[++i]; break;
            case '--hours': opts.hours = parseInt(args[++i], 10); break;
            case '--start': opts.start = args[++i]; break;
            case '--end': opts.end = args[++i]; break;
            case '--account': opts.account = args[++i]; break;
            case '--refresh-account': opts.refreshAccount = true; break;
            case '--per-fill': opts.perFill = true; break;
            case '--include-cross-pair': opts.includeCrossPair = true; break;
            case '--increment': opts.incrementPercent = parseFloat(args[++i]); break;
            case '--runtime-log': opts.runtimeLog = args[++i]; break;
            case '--strict': opts.strict = true; break;
            case '--json': opts.json = args[++i]; break;
            case '--csv': opts.csv = args[++i]; break;
            case '--verbose': opts.verbose = true; break;
            default:
                console.error(`Unknown option: ${args[i]}`);
                printHelp();
                process.exit(1);
        }
    }

    if (!opts.botKey) {
        console.error('Error: --bot-key is required (use --list-bots to see available keys)');
        printHelp();
        process.exit(1);
    }
    if (!opts.hours && !opts.start) opts.hours = 168;
    if (opts.incrementPercent != null && (isNaN(opts.incrementPercent) || opts.incrementPercent < 0)) {
        console.error('Error: --increment must be a non-negative number');
        process.exit(1);
    }
    return opts;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────
function resolveTimeRange(opts: CliOpts): { gte: string; lte: string; label: string } {
    let gte: string, lte: string;
    if (opts.start) {
        const s = new Date(opts.start);
        if (isNaN(s.getTime())) { console.error(`Invalid --start: ${opts.start}`); process.exit(1); }
        gte = s.toISOString();
    } else {
        const h = opts.hours ?? 168;
        gte = new Date(Date.now() - h * 3600_000).toISOString();
    }
    if (opts.end) {
        const e = new Date(opts.end);
        if (isNaN(e.getTime())) { console.error(`Invalid --end: ${opts.end}`); process.exit(1); }
        lte = e.toISOString();
    } else {
        lte = new Date().toISOString();
    }
    const label = `${gte} → ${lte}`;
    return { gte, lte, label };
}

// ─── Account resolution errors ────────────────────────────────────────────────
/** Map a shared account-resolver failure onto this tool's operator-facing hint. */
function reportAccountFailure(resolved: { reason?: unknown; botMeta?: { preferredAccount?: unknown } | null } | null | undefined, opts: CliOpts): void {
    switch (resolved?.reason) {
        case 'bot-not-found':
            console.error(`Error: bot key '${opts.botKey}' not found in profiles/bots.json and no --account provided.`);
            console.error('Use --list-bots to see available keys, or pass --account <1.2.x> explicitly.');
            break;
        case 'override-unresolved':
            console.error(`Error: failed to resolve --account '${opts.account}' to 1.2.x`);
            break;
        case 'no-preferred-account':
            console.error(`Error: bot '${opts.botKey}' has no preferredAccount and no --account provided.`);
            break;
        default:
            console.error(`Error: failed to resolve account name '${resolved?.botMeta?.preferredAccount ?? opts.botKey}' to 1.2.x`);
    }
}

// ─── Kibana fetch ─────────────────────────────────────────────────────────────
async function fetchAllOrderUpdates(config: Record<string, unknown>, accountId: string, gte: string, lte: string): Promise<OrderUpdate[]> {
    const pageSize = 10000;
    const updates: OrderUpdate[] = [];
    let searchAfter: unknown[] | null = null;
    const cfg = { ...BASE_CONFIG, timeout: 60000, ...config };
    while (true) {
        const query: Record<string, unknown> = {
            size: pageSize,
            track_total_hits: false,
            _source: [
                'block_data.block_num', 'operation_id_num',
                'operation_history.op_object.order',
                'operation_history.op_object.seller',
            ],
            query: { bool: { filter: [
                { term: { operation_type: OP_LIMIT_ORDER_UPDATE } },
                { term: { 'operation_history.op_object.seller.keyword': accountId } },
                { range: { 'block_data.block_time': { gte, lte } } },
            ] } },
            sort: [
                { 'block_data.block_num': { order: 'asc' } },
                { operation_id_num: { order: 'asc' } },
            ],
        };
        if (searchAfter) query.search_after = searchAfter;
        const result = await kibanaSearch(cfg as never, query) as { hits?: { hits?: unknown[] } } | null;
        const hits = result?.hits?.hits ?? [];
        if (!hits.length) break;
        for (const hit of hits) {
            const source = ((hit as { _source?: unknown } | null | undefined)?._source || {}) as { operation_history?: { op_object?: { order?: string } }; block_data?: { block_num?: unknown }; operation_id_num?: unknown };
            const op = source.operation_history?.op_object || {};
            const orderId = op.order;
            if (!orderId) continue;
            const blockNum = Number(source.block_data?.block_num ?? 0);
            const opNum = Number(source.operation_id_num ?? 0);
            updates.push({ orderId, sequence: blockNum * 1e6 + opNum });
        }
        const last = hits[hits.length - 1] as { sort?: unknown[] } | undefined;
        searchAfter = last?.sort ?? null;
        if (!searchAfter || hits.length < pageSize) break;
    }
    return updates;
}

// ─── Fill classification ─────────────────────────────────────────────────────
// Direction/base/quote resolution is shared with trade_profitability via
// fills_source.classifyFill; this wrapper only owns the skip count and the
// TradeFill shape (no market-fee fields — grid checks prices, not PnL).
function classifyFills(fills: FillRecord[]): { trades: TradeFill[]; skipped: number } {
    const trades: TradeFill[] = [];
    let skipped = 0;
    for (const f of fills) {
        const c = classifyFill(f);
        if (!c) { skipped++; continue; }
        trades.push({
            time: f.time,
            orderId: f.orderId,
            direction: c.direction,
            baseAsset: c.baseAsset,
            quoteAsset: c.quoteAsset,
            baseAmount: c.baseAmount,
            quoteAmount: c.quoteAmount,
            price: c.price,
            isMaker: f.isMaker,
            sequence: f.blockNum * 1e6 + f.opNum,
        });
    }
    return { trades, skipped };
}

// ─── Per-order/price-epoch aggregation ───────────────────────────────────────
// Collapses partial fills at one order lifetime, but never mixes fills from
// different native limit_order_update repricings of the same order ID.
function aggregateByOrder(trades: TradeFill[], updates: OrderUpdate[] = []): AggregatedOrder[] {
    const updatesByOrder = new Map<string, number[]>();
    for (const update of updates) {
        const list = updatesByOrder.get(update.orderId) || [];
        list.push(update.sequence);
        updatesByOrder.set(update.orderId, list);
    }
    for (const list of updatesByOrder.values()) list.sort((a, b) => a - b);

    const map = new Map<string, { trades: TradeFill[] }>();
    for (const t of trades) {
        // An update is ordered before the fills it can affect. The epoch is
        // therefore the latest update sequence at or before this fill.
        const orderUpdates = updatesByOrder.get(t.orderId) || [];
        let epoch = 0;
        for (const sequence of orderUpdates) {
            if (sequence <= t.sequence) epoch = sequence;
            else break;
        }
        const k = t.orderId
            ? `${t.orderId}:${t.direction}:${t.baseAsset}:${t.quoteAsset}:${epoch}`
            : `__fill_${t.sequence}`;
        if (!map.has(k)) map.set(k, { trades: [] });
        map.get(k)!.trades.push(t);
    }
    const orders: AggregatedOrder[] = [];
    for (const [orderId, group] of map) {
        const first = group.trades[0];
        // All fills for same order should share direction/pair, but validate
        const directions = new Set(group.trades.map(t => t.direction));
        const pairs = new Set(group.trades.map(t => `${t.baseAsset}:${t.quoteAsset}`));
        if (directions.size > 1 || pairs.size > 1) {
            // Mixed direction/pair for same orderId should not happen; keep fills separate
            for (const t of group.trades) {
                orders.push({
                    orderId: t.orderId, direction: t.direction, baseAsset: t.baseAsset, quoteAsset: t.quoteAsset,
                    baseAmount: t.baseAmount, quoteAmount: t.quoteAmount, price: t.price,
                    time: t.time, sequence: t.sequence, fillCount: 1, isMaker: t.isMaker,
                });
            }
            continue;
        }
        const baseAmount = group.trades.reduce((s, t) => s + t.baseAmount, 0);
        const quoteAmount = group.trades.reduce((s, t) => s + t.quoteAmount, 0);
        const price = baseAmount > 0 ? quoteAmount / baseAmount : first.price;
        // Use earliest time / smallest sequence for ordering; last time for display is earliest fill
        const sorted = [...group.trades].sort((a, b) => a.sequence - b.sequence);
        orders.push({
            orderId, direction: first.direction, baseAsset: first.baseAsset, quoteAsset: first.quoteAsset,
            baseAmount, quoteAmount, price,
            time: sorted[0].time,
            sequence: sorted[0].sequence,
            fillCount: group.trades.length,
            isMaker: group.trades.every(t => t.isMaker),
        });
    }
    return orders.sort((a, b) => a.sequence - b.sequence);
}

// ─── Violation detection (LAST-FILL-GUARD 1:1) ────────────────────────────────
function detectViolations(
    items: (TradeFill | AggregatedOrder)[],
    includeCrossPair: boolean,
    incrementPercent: number,
): { violations: Violation[]; checkedTransitions: number } {
    const violations: Violation[] = [];
    let checkedTransitions = 0;

    // Helper for a single chronological sequence (already filtered to one pair or global)
    function checkSequence(seq: (TradeFill | AggregatedOrder)[]) {
        for (let i = 1; i < seq.length; i++) {
            const prev = seq[i - 1];
            const curr = seq[i];
            // Skip same orderId (multi-fill split of one order) — aggregated mode already collapsed, but per-fill may split
            if (prev.orderId && prev.orderId === curr.orderId) continue;
            checkedTransitions++;

            const check = isLastFillGuardBlocked(curr.price, curr.direction, prev.price, prev.direction);
            // SAME-LEVEL RE-FILL (§9.12/P2): judged with the runtime's OWN
            // same-level predicate (pricesWithinHalfStep, exactly what
            // isLastFillPlacementBlocked applies) — never a copy of it. Same
            // direction only: the counter-side is governed by the direction
            // rule above. A re-placed level's realized fill prices differ by
            // sub-sat rounding dust, so a float-exact compare would pass a
            // loop that re-placed at the IDENTICAL level (live 2026-11-16:
            // one premium spread slot, 5 full fills in 2.5 minutes).
            const sameLevel = prev.direction === curr.direction
                && pricesWithinHalfStep(curr.price, prev.price, incrementPercent);
            if (check.blocked || sameLevel) {
                const delta = curr.price - prev.price;
                const deltaPct = prev.price !== 0 ? (delta / prev.price) * 100 : 0;
                const isSell = curr.direction === 'sell';
                violations.push({
                    index: i,
                    pair: `${curr.baseAsset}:${curr.quoteAsset}`,
                    direction: curr.direction,
                    expected: check.blocked
                        ? (isSell ? `> ${check.pivot?.toFixed(6)} (last fill)` : `< ${check.pivot?.toFixed(6)} (last fill)`)
                        : `different level (> half a step of ${prev.price.toFixed(6)} — same-level re-fill, §9.12/P2)`,
                    prev: prev as TradeFill,
                    curr: curr as TradeFill,
                    priceDelta: delta,
                    priceDeltaPct: deltaPct,
                    pivot: (check.pivot ?? prev.price) as number,
                    halfInc: 0,
                    threshold: (check.pivot ?? prev.price) as number,
                    sameLevel: sameLevel || undefined,
                });
            }
        }
    }

    if (includeCrossPair) {
        // Global consecutive check regardless of pair
        const sorted = [...items].sort((a, b) => a.sequence - b.sequence);
        checkSequence(sorted);
    } else {
        // Per-pair independent sequences (bot trades one pair; cross-pair interleaving is irrelevant)
        const byPair = new Map<string, (TradeFill | AggregatedOrder)[]>();
        for (const it of items) {
            const k = `${it.baseAsset}:${it.quoteAsset}`;
            if (!byPair.has(k)) byPair.set(k, []);
            byPair.get(k)!.push(it);
        }
        for (const [, seq] of byPair) {
            seq.sort((a, b) => a.sequence - b.sequence);
            checkSequence(seq);
        }
    }
    // Sort violations chronologically for reporting
    violations.sort((a, b) => new Date(a.curr.time).getTime() - new Date(b.curr.time).getTime());
    return { violations, checkedTransitions };
}

// ─── Reporting ────────────────────────────────────────────────────────────────
function fmt(n: number, d = 4): string {
    if (!Number.isFinite(n)) return 'NaN';
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function printReport(
    trades: TradeFill[],
    orders: AggregatedOrder[] | null,
    violations: Violation[],
    checkedTransitions: number,
    skipped: number,
    rangeLabel: string,
    botKey: string,
    accountId: string,
    botMeta: { name?: unknown; assetA?: unknown; assetB?: unknown; incrementPercent?: unknown } | null,
    perFill: boolean,
    includeCrossPair: boolean,
    incrementPercent: number,
    gte: string,
    _lte: string,
    divergences: PolicyDivergence[],
    artifacts: PivotAnchorArtifact[],
    mirrorMode: 'policy-aware' | 'strict',
    runtimeLogPath: string | null,
    logError: string | null,
    strictCandidates: number,
) {
    const pairGroups = new Map<string, TradeFill[]>();
    for (const t of trades) {
        const k = `${assetSymbol(t.baseAsset)}/${assetSymbol(t.quoteAsset)}`;
        if (!pairGroups.has(k)) pairGroups.set(k, []);
        pairGroups.get(k)!.push(t);
    }

    // Direction-only guard: no band. The Violation row keeps halfInc = 0 so the
    // JSON/CSV shape stays stable for existing consumers.

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  LAST-FILL-GUARD CHECK (direction only)');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Bot key:      ${botKey}${botMeta?.name ? `  (name: ${botMeta.name})` : ''}`);
    if (botMeta) console.log(`  Pair:         ${botMeta.assetA ?? '?'} / ${botMeta.assetB ?? '?'}`);
    console.log(`  Account:      ${accountId}`);
    console.log(`  Range:        ${rangeLabel}`);
    console.log(`  Mode:         ${perFill ? 'per-fill' : 'per-order (aggregated)'}${includeCrossPair ? ', cross-pair enabled' : ', same-pair only'}`);
    console.log(`  Mirror:       ${mirrorMode === 'policy-aware' ? `policy-aware (runtime pivot from ${runtimeLogPath})` : 'strict (all consecutive fills)'}`);
    if (mirrorMode === 'strict' && runtimeLogPath) {
        console.log(`                (strict fallback${logError ? `: ${logError}` : ' — --strict requested'})`);
    }
    console.log(`  Increment:    ${incrementPercent}%  (informational — the guard is direction-only)`);
    console.log('  Guard:        BUY < last fill / SELL > last fill  — both sides, global pivot');
    console.log('                (+ same-level re-fill: within half a step of the just-filled level, §9.12/P2)');
    console.log('');

    const buyCount = trades.filter(t => t.direction === 'buy').length;
    const sellCount = trades.filter(t => t.direction === 'sell').length;
    console.log(`  Fills fetched:        ${trades.length}  (buy: ${buyCount}, sell: ${sellCount})`);
    if (orders) console.log(`  Orders (aggregated):  ${orders.length}  (from ${trades.length} fills)`);
    console.log(`  Pairs observed:       ${[...pairGroups.keys()].join(', ') || '-'}`);
    if (skipped > 0) console.log(`  Skipped (precision):  ${skipped}`);
    console.log(`  Transitions checked:  ${checkedTransitions} consecutive fill/order transitions`);
    if (mirrorMode === 'policy-aware') {
        console.log(`  Strict candidates:    ${strictCandidates}`);
        console.log(`  Policy divergences:   ${divergences.length}  (runtime gate would have passed them)`);
        console.log(`  Pivot-anchor artifacts: ${artifacts.length}  (legacy forward-pivot verdicts reclassified — not failures)`);
    }
    console.log(`  Violations:           ${violations.length}${strictCandidates > 0 ? `  (${((violations.length / strictCandidates) * 100).toFixed(2)}% of strict candidates)` : ''}`);
    const sameLevelViolations = violations.filter(v => v.sameLevel).length;
    const sameLevelDivergences = divergences.filter(d => d.sameLevel).length;
    if (sameLevelViolations + sameLevelDivergences > 0) {
        console.log(`  Same-level re-fills:  ${sameLevelViolations + sameLevelDivergences}  (within half a grid step of the just-filled level, §9.12/P2 — ${sameLevelViolations} violation(s), ${sameLevelDivergences} divergence(s))`);
    }
    console.log('');

    if (violations.length === 0) {
        console.log('  ✅  PASS — no LAST-FILL-GUARD gate failures detected (all BUY < pivot, all SELL > pivot).');
        if (mirrorMode === 'policy-aware') {
            console.log('  The runtime\'s own pivot was the reference for every transition that reached the gate.');
        }
        console.log('');
        if (checkedTransitions === 0) {
            console.log('  Note: no consecutive transitions in range to check.');
            console.log('  (Need at least two fills/orders to form a transition.)');
            console.log('');
        }
        if (divergences.length > 0) printDivergences(divergences);
        if (artifacts.length > 0) printPivotAnchorArtifacts(artifacts);
        return;
    }

    console.log(`  ❌  FAIL — ${violations.length} violation(s) detected:`);
    console.log('');

    // Per-direction breakdown (blocked side = curr direction)
    const buyV = violations.filter(v => v.direction === 'buy').length;
    const sellV = violations.filter(v => v.direction === 'sell').length;
    console.log(`  Breakdown:  sell violations: ${sellV}  (SELL <= last fill),  buy violations: ${buyV}  (BUY >= last fill)`);
    console.log('');

    // Timeline clustering by day
    const dayBuckets = new Map<string, number>();
    for (const v of violations) {
        const day = (v.curr.time || '').slice(0, 10) || 'unknown';
        dayBuckets.set(day, (dayBuckets.get(day) || 0) + 1);
    }
    const sortedDays = [...dayBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    console.log('  Incidents by day:');
    for (const [day, count] of sortedDays) {
        const bar = '█'.repeat(Math.min(count, 40));
        console.log(`    ${day}  ${String(count).padStart(3)}  ${bar}`);
    }
    // Overall incident time span
    const times = violations.map(v => v.curr.time).filter(Boolean).sort();
    if (times.length > 0) {
        console.log(`\n  Incident range: ${times[0]} → ${times[times.length - 1]}`);
        // Also show in hours from start
        const gteMs = new Date(gte).getTime();
        const firstMs = new Date(times[0]).getTime();
        const lastMs = new Date(times[times.length - 1]).getTime();
        if (!isNaN(gteMs) && !isNaN(firstMs)) {
            const firstH = ((firstMs - gteMs) / 3600000).toFixed(1);
            const lastH = ((lastMs - gteMs) / 3600000).toFixed(1);
            console.log(`  (hours into range: ${firstH}h → ${lastH}h)`);
        }
    }
    console.log('');

    // Detailed violation table
    console.log('  ── Violations (direction only) ──');
    console.log('');
    const hdr = '  #  Pair          Dir   Prev Price     Curr Price     Last Fill      Δ%        Prev Time              Curr Time              Prev Order          Curr Order';
    console.log(hdr);
    console.log('  ' + '─'.repeat(hdr.length - 2));
    for (let i = 0; i < violations.length; i++) {
        const v = violations[i];
        const pairLabel = `${assetSymbol(v.prev.baseAsset)}/${assetSymbol(v.prev.quoteAsset)}`.padEnd(12);
        const dir = v.direction.padEnd(4);
        const pPrice = fmt(v.prev.price, 6).padStart(12);
        const cPrice = fmt(v.curr.price, 6).padStart(12);
        const thr = fmt(v.threshold, 6).padStart(12);
        const delta = (v.priceDeltaPct >= 0 ? '+' : '') + v.priceDeltaPct.toFixed(4) + '%';
        const deltaStr = delta.padStart(9);
        const pTime = (v.prev.time || '').slice(0, 19).replace('T', ' ').padEnd(19);
        const cTime = (v.curr.time || '').slice(0, 19).replace('T', ' ').padEnd(19);
        const pOrd = (v.prev.orderId || '-').slice(0, 16).padEnd(16);
        const cOrd = (v.curr.orderId || '-').slice(0, 16).padEnd(16);
        const marker = v.sameLevel
            ? `SAME-LEVEL (≤ half step of ${fmt(v.threshold, 4)})`
            : v.direction === 'sell' ? `SELL < ${fmt(v.threshold,4)}` : `BUY > ${fmt(v.threshold,4)}`;
        console.log(`  ${(String(i + 1)).padStart(2)}  ${pairLabel}  ${dir}  ${pPrice}  ${cPrice}  ${thr}  ${deltaStr}  ${pTime}  ${cTime}  ${pOrd}  ${cOrd}  ${marker}`);
    }
    console.log('');
    console.log('  Guard: BUY must be < the last fill price, SELL > it; the just-filled level itself');
    console.log('  (equal price, or within half a grid step — the runtime\'s same-level test) is a');
    console.log('  same-level re-fill and blocked/violation too (§9.12/P2).');
    console.log(`  No band: the grid increment (${incrementPercent}%) is reported for context only.`);
    console.log('');
    if (divergences.length > 0) printDivergences(divergences);
    if (artifacts.length > 0) printPivotAnchorArtifacts(artifacts);
}

/**
 * Report the strict candidates the runtime's own gate would have passed.
 * These are NOT discipline breaches under the HISTORICAL pre-§9.16 policy:
 * the pivot-arming policy (§9.12/P1) deliberately excluded wrong-side /
 * too-far premium-sweep / gap-band fills from arming the pivot, so a re-quote
 * below such a fill was expected. New logs produce no refusal-based divergences
 * (older pivots and guard allowances still can). Listing them keeps the policy
 * auditable instead of silently hidden.
 */
function printDivergences(divergences: PolicyDivergence[]) {
    console.log('  ── Policy divergences (strict candidate vs the runtime pivot at the gate) ──');
    console.log('  The gate pivot differed from the strict last fill: older pivot, guard');
    console.log('  allowance, or a historical pre-§9.16 refusal (wrong-side / premium-sweep /');
    console.log('  gap-band). Only the last class is gone from new logs.');
    console.log('');
    const hdr = '  #  Pair          Dir   Prev Price     Curr Price     Runtime Pivot  Δ%         Prev Time              Curr Time              Curr Order          Refusals  Reason';
    console.log(hdr);
    console.log('  ' + '─'.repeat(hdr.length - 2));
    for (let i = 0; i < divergences.length; i++) {
        const d = divergences[i];
        const pairLabel = `${assetSymbol(d.prev.baseAsset)}/${assetSymbol(d.prev.quoteAsset)}`.padEnd(12);
        const dir = d.direction.padEnd(4);
        const pPrice = fmt(d.prev.price, 6).padStart(12);
        const cPrice = fmt(d.curr.price, 6).padStart(12);
        const piv = d.pivot ? `${fmt(d.pivot.price, 4)}(${d.pivot.type[0]})` : '-';
        const pivStr = piv.padStart(14);
        const delta = (d.priceDeltaPct >= 0 ? '+' : '') + d.priceDeltaPct.toFixed(4) + '%';
        const deltaStr = delta.padStart(9);
        const pTime = (d.prev.time || '').slice(0, 19).replace('T', ' ').padEnd(19);
        const cTime = (d.curr.time || '').slice(0, 19).replace('T', ' ').padEnd(19);
        const cOrd = (d.curr.orderId || '-').slice(0, 16).padEnd(16);
        const ref = String(d.refusalsInRange).padStart(8);
        const reason = d.sameLevel
            ? `SAME-LEVEL re-fill (${d.refusalsInRange > 0
                ? 'pivot-arm refused in window'
                : d.pivot ? 'pivot older / guard allowance' : 'no refusal evidence'})`
            : d.pivot
            ? (d.refusalsInRange > 0 ? 'pivot-arm refusal(s) in window' : 'pivot older than strict last fill')
            : 'unverifiable pivot';
        console.log(`  ${(String(i + 1)).padStart(2)}  ${pairLabel}  ${dir}  ${pPrice}  ${cPrice}  ${pivStr}  ${deltaStr}  ${pTime}  ${cTime}  ${cOrd}  ${ref}  ${reason}`);
    }
    console.log('');
}

/**
 * §9.14: candidates that were in the old FAIL list (the forward lookup either
 * blocked them or could not verify them) but pass the corrected source-aware
 * rule. Reported in their own section so the audit correction stays auditable —
 * they are neither failures nor divergences.
 */
function printPivotAnchorArtifacts(artifacts: PivotAnchorArtifact[]) {
    console.log('  ── Pivot-anchor artifacts (old FAIL-list entries reclassified) ──');
    console.log('  A `Placed` line is emitted at commit, after the gate; the old forward rule');
    console.log('  judged it against the NEXT batch\'s pivot (or found no observation at all).');
    console.log('  The corrected rule uses the last pivot at/before the placement. These are');
    console.log('  not gate failures and no longer count toward the FAIL total.');
    console.log('');
    const hdr = '  #  Pair          Dir   Curr Price     Legacy Pivot        Corrected Pivot     Anchor    Δ%       Reason';
    console.log(hdr);
    console.log('  ' + '─'.repeat(hdr.length - 2));
    for (let i = 0; i < artifacts.length; i++) {
        const a = artifacts[i];
        const pairLabel = `${assetSymbol(a.prev.baseAsset)}/${assetSymbol(a.prev.quoteAsset)}`.padEnd(12);
        const dir = a.direction.padEnd(4);
        const cPrice = fmt(a.curr.price, 6).padStart(12);
        const fmtPivot = (p: { price: number; type: string; t: number; src?: string } | null) =>
            p ? `${fmt(p.price, 4)}(${(p.type || '?')[0]})${p.src ? `[${p.src}]` : ''}` : '-';
        const legacy = fmtPivot(a.legacyPivot).padStart(18);
        const corrected = fmtPivot(a.correctedPivot).padStart(18);
        const anchor = (a.anchor ? a.anchor.kind : '-').padEnd(9);
        const delta = (a.priceDeltaPct >= 0 ? '+' : '') + a.priceDeltaPct.toFixed(4) + '%';
        const reason = a.reason.replace(/^runtime pivot /, 'pivot ').slice(0, 60);
        console.log(`  ${String(i + 1).padStart(2)}  ${pairLabel}  ${dir}  ${cPrice}  ${legacy}  ${corrected}  ${anchor}  ${delta.padStart(9)}  ${reason}`);
    }
    console.log('');
}

function exportJson(
    filePath: string,
    violations: Violation[],
    trades: TradeFill[],
    rangeLabel: string,
    botKey: string,
    accountId: string,
    incrementPercent: number,
    divergences: PolicyDivergence[] = [],
    artifacts: PivotAnchorArtifact[] = [],
    mirrorMode: 'policy-aware' | 'strict' = 'strict',
    runtimeLogPath: string | null = null,
) {
    const payload = {
        botKey, accountId, range: rangeLabel,
        incrementPercent,
        totalFills: trades.length,
        mirror: { mode: mirrorMode, runtimeLog: runtimeLogPath },
        pivotAnchorArtifacts: artifacts.map(a => ({
            index: a.index,
            pair: `${assetSymbol(a.prev.baseAsset)}/${assetSymbol(a.prev.quoteAsset)}`,
            direction: a.direction,
            reason: a.reason,
            prev: { time: a.prev.time, orderId: a.prev.orderId, price: a.prev.price },
            curr: { time: a.curr.time, orderId: a.curr.orderId, price: a.curr.price },
            anchor: a.anchor,
            legacyPivot: a.legacyPivot,
            correctedPivot: a.correctedPivot,
            priceDeltaPct: a.priceDeltaPct,
        })),
        policyDivergences: divergences.map(d => ({
            pair: `${assetSymbol(d.prev.baseAsset)}/${assetSymbol(d.prev.quoteAsset)}`,
            direction: d.direction,
            reason: d.reason,
            prev: { time: d.prev.time, orderId: d.prev.orderId, price: d.prev.price },
            curr: { time: d.curr.time, orderId: d.curr.orderId, price: d.curr.price },
            runtimePivot: d.pivot,
            anchor: d.anchor,
            pivotSelection: d.pivotSelection,
            refusalsInRange: d.refusalsInRange,
            priceDeltaPct: d.priceDeltaPct,
        })),
        violations: violations.map(v => ({
            pair: `${assetSymbol(v.prev.baseAsset)}/${assetSymbol(v.prev.quoteAsset)}`,
            pairIds: { base: v.prev.baseAsset, quote: v.prev.quoteAsset },
            direction: v.direction,
            expected: v.expected,
            prev: { time: v.prev.time, orderId: v.prev.orderId, price: v.prev.price, baseAmount: v.prev.baseAmount, quoteAmount: v.prev.quoteAmount, isMaker: v.prev.isMaker },
            curr: { time: v.curr.time, orderId: v.curr.orderId, price: v.curr.price, baseAmount: v.curr.baseAmount, quoteAmount: v.curr.quoteAmount, isMaker: v.curr.isMaker },
            pivot: v.pivot,
            halfInc: v.halfInc,
            threshold: v.threshold,
            priceDelta: v.priceDelta,
            priceDeltaPct: v.priceDeltaPct,
            mirror: {
                verdict: v.mirrorVerdict ?? null,
                reason: v.mirrorReason ?? null,
                runtimePivot: v.mirrorPivot ?? null,
                anchor: v.anchor ?? null,
                pivotSelection: v.pivotSelection ?? null,
            },
        })),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`  JSON exported to ${filePath}`);
}

function exportCsv(filePath: string, violations: Violation[]) {
    const header = 'index,pair,direction,expected,prev_time,prev_order,prev_price,curr_time,curr_order,curr_price,threshold,halfInc,pivot,delta_pct,mirror_verdict,mirror_reason,mirror_pivot,anchor_kind,anchor_time,pivot_selection';
    const rows = violations.map((v, i) =>
        [
            i + 1,
            `${assetSymbol(v.prev.baseAsset)}/${assetSymbol(v.prev.quoteAsset)}`,
            v.direction, v.expected,
            v.prev.time, v.prev.orderId, v.prev.price,
            v.curr.time, v.curr.orderId, v.curr.price,
            v.threshold, v.halfInc, v.pivot,
            v.priceDeltaPct.toFixed(6),
            v.mirrorVerdict ?? '',
            v.mirrorReason ?? '',
            v.mirrorPivot ? `${v.mirrorPivot.price}(${v.mirrorPivot.type})${v.mirrorPivot.src ? `[${v.mirrorPivot.src}]` : ''}@${new Date(v.mirrorPivot.t).toISOString()}` : '',
            v.anchor?.kind ?? '',
            v.anchor ? new Date(v.anchor.t).toISOString() : '',
            v.pivotSelection ?? '',
        ].map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')
    );
    fs.writeFileSync(filePath, [header, ...rows].join('\n') + '\n', 'utf-8');
    console.log(`  CSV exported to ${filePath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();
    const { gte, lte, label } = resolveTimeRange(opts);

    console.log(`\nLast-fill guard check — bot-key: ${opts.botKey}`);
    console.log(`Range: ${label}`);

    const resolvedAccount = await resolveBotAccount(String(opts.botKey), {
        overrideAccount: opts.account,
        refresh: opts.refreshAccount,
    });
    if (!resolvedAccount.accountId) {
        reportAccountFailure(resolvedAccount, opts);
        process.exit(1);
    }
    const accountId = resolvedAccount.accountId;
    const botMeta = resolvedAccount.botMeta;
    console.log(`Account: ${accountId}${botMeta ? `  (${botMeta.assetA}/${botMeta.assetB})` : ''}`);
    const incrementPercent = resolveIncrementPercent(botMeta, opts.incrementPercent);
    console.log(`Increment: ${incrementPercent}% (informational; the guard is direction-only)${opts.incrementPercent == null && botMeta?.incrementPercent != null ? ' — from bot config' : opts.incrementPercent != null ? ' — from --increment' : ' — default'}`);

    console.log(`\nFetching fills and order updates from Kibana...`);
    const [fills, orderUpdates] = await Promise.all([
        fetchAllFills({}, accountId, gte, lte),
        fetchAllOrderUpdates({}, accountId, gte, lte),
    ]);
    console.log(`  Fetched ${fills.length} fill_order operation(s)`);
    console.log(`  Fetched ${orderUpdates.length} limit_order_update operation(s)`);

    if (fills.length === 0) {
        console.log('\nNo fills in range — nothing to check.');
        process.exit(0);
    }

    await resolveAssetPrecisions(fills);

    const { trades, skipped } = classifyFills(fills);
    console.log(`  Classified ${trades.length} trade(s)${skipped > 0 ? `, ${skipped} skipped (unknown precision)` : ''}`);
    if (trades.length < 2) {
        console.log('\nFewer than 2 trade fills — no consecutive pairs to check.');
        process.exit(0);
    }

    // Sort chronologically
    trades.sort((a, b) => a.sequence - b.sequence);

    if (opts.verbose) {
        console.log('\n  ── Trade sequence ──');
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            const pair = `${assetSymbol(t.baseAsset)}/${assetSymbol(t.quoteAsset)}`;
            console.log(`    ${String(i + 1).padStart(3)}  ${t.time.slice(0, 19)}  ${t.direction.padEnd(4)}  ${pair.padEnd(18)}  price ${fmt(t.price, 6)}  order ${t.orderId}`);
        }
    }

    // Choose per-fill or per-order mode
    let items: (TradeFill | AggregatedOrder)[];
    if (opts.perFill) {
        items = trades;
    } else {
        const orders = aggregateByOrder(trades, orderUpdates);
        console.log(`  Aggregated into ${orders.length} order epoch(s) (partial fills collapsed; repriced orders kept separate)`);
        items = orders;
    }

    const { violations: strictCandidatesList, checkedTransitions } = detectViolations(items, opts.includeCrossPair, incrementPercent);

    // Policy-aware mirror: re-judge strict candidates against the pivot the
    // runtime held at each order's gate. Default on; --strict skips it.
    let violations = strictCandidatesList;
    let divergences: PolicyDivergence[] = [];
    let artifacts: PivotAnchorArtifact[] = [];
    let mirrorMode: 'policy-aware' | 'strict' = 'strict';
    let runtimeLogPath: string | null = null;
    let logError: string | null = null;
    if (!opts.strict) {
        const defaultLog = botMeta && typeof botMeta.name === 'string' && botMeta.name
            ? path.resolve('profiles/logs', `${botMeta.name}.log`)
            : null;
        runtimeLogPath = opts.runtimeLog ?? defaultLog;
        if (runtimeLogPath) {
            if (fs.existsSync(runtimeLogPath)) {
                const mirror = applyRuntimeMirror(strictCandidatesList, runtimeLogPath, incrementPercent);
                violations = mirror.kept;
                divergences = mirror.divergences;
                artifacts = mirror.artifacts;
                logError = mirror.logError;
                if (mirror.index) {
                    mirrorMode = 'policy-aware';
                    console.log(`  Runtime mirror: ${mirror.index.observations.length} pivot observation(s), ${mirror.index.refusals.length} refusal(s), ${mirror.index.allowances.length} allowance(s) from ${runtimeLogPath}`);
                } else {
                    console.log(`  Runtime mirror unavailable (${logError}) — falling back to the strict all-fills check`);
                    runtimeLogPath = null;
                }
            } else {
                console.log(`  Runtime mirror unavailable (log not found: ${runtimeLogPath}) — falling back to the strict all-fills check`);
                runtimeLogPath = null;
            }
        }
    }

    const ordersForReport = opts.perFill ? null : (items as AggregatedOrder[]);
    printReport(trades, ordersForReport, violations, checkedTransitions, skipped, label, String(opts.botKey), accountId, botMeta, opts.perFill, opts.includeCrossPair, incrementPercent, gte, lte, divergences, artifacts, mirrorMode, runtimeLogPath, logError, strictCandidatesList.length);

    if (opts.json) exportJson(opts.json, violations, trades, label, String(opts.botKey), accountId, incrementPercent, divergences, artifacts, mirrorMode, runtimeLogPath);
    if (opts.csv) exportCsv(opts.csv, violations);

    process.exit(violations.length > 0 ? 2 : 0);
}

export { isLastFillGuardBlocked, detectViolations, applyRuntimeMirror, classifyFills, exportJson, exportCsv };
export type { TradeFill, AggregatedOrder, Violation, PolicyDivergence, PivotAnchorArtifact };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => {
        console.error('\n[fatal]', getErrorMessage(e));
        if (process.env.DEBUG) console.error(getErrorField<string>(e, 'stack'));
        process.exit(1);
    });
}

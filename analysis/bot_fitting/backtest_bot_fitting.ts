'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateAMA, getAmaWarmupBars } from '../../market_adapter/core/strategies/ama.js';
import { computeAmaSlopeEmaSeries } from '../../market_adapter/core/strategies/ama_slope_model.js';
import { normalizeAmaSlopeEmaAlpha } from '../../market_adapter/core/config_normalizers.js';
import { applyAsymmetricBounds } from '../../market_adapter/core/asymmetric_bounds.js';
import { range } from '../math_utils.js';
import { loadLpData, fmt, loadAmaStrategies, consumeBacktestArg, slopeResetThresholdPct, DEFAULT_FEE_ROUNDTRIP_PCT, DEFAULT_MIN_SPREAD_FACTOR, DEFAULT_BTS_CREATE_FEE, DEFAULT_BTS_CANCEL_FEE, DEFAULT_BTS_MAKER_CREATE_FACTOR, DEFAULT_TX_FEE_PRICE, DEFAULT_REPOSITION_PCT, SLOPE_TRIGGER_FACTOR, SLOPE_MAX_PCT, SLOPE_LOOKBACK_BARS } from './shared_utils.js';
import { getStorage } from '../../modules/storage/index.js';
import { PATHS } from '../../modules/paths.js';
import { GRID_LIMITS, MARKET_ADAPTER } from '../../modules/constants.js';
const { ensureDir, writeJSON } = getStorage();


// Default mirrors production sizing: createOrderGrid sizes EVERY rail slot in
// bounds (modules/order/grid.ts), it does not cap per side. Infinity = all
// slots; --active-orders N restores a bounded run.
const DEFAULT_ACTIVE_ORDERS = Infinity;

// BTS operation fees are shared with backtest_ama_sweep via shared_utils; the
// fee-capital base (the notional the fee percentage is measured against) is
// bot_fitting-specific.
//
// Every placement (initial grid, reset rebuild, per-cycle slot refill) pays a
// maker create fee, every cancel pays a cancel fee. Fees are converted into
// percentage points against --bts-fee-capital so they deduct from net capture
// in the same units as the rest of the accounting.
const DEFAULT_BTS_FEE_CAPITAL = 10000;

// ── Production grid-reset triggers (MARKET_ADAPTER, modules/constants.ts) ────
//
// Trigger A — AMA delta: the live adapter records the AMA center and writes a
// recalculate.<botKey>.trigger when AMA moves ±AMA_DELTA_THRESHOLD_PERCENT
// from that recorded center; the center re-records only when a trigger fires
// (ratchet semantics — see analyze_ama_price_changes.trackRepositions).
// --reposition-pct overrides the default.
//
// Trigger B — AMA slope delta, plus the grid price offset, are BOTH gated in
// production behind the per-bot asymmetricBounds whitelist
// (market_adapter_service.ts: isGridRangeScalingWhitelisted consumes both
// shouldTrigger at the slope-reset write and computeGridPriceOffsetPlan via
// README "asymmetricBounds whitelist also enables gridPriceOffsetPct").
// The sim therefore exposes one switch, default OFF (typical non-whitelisted
// bot): --asymmetric-bounds enables slope-delta resets AND slope-ratio offset.
// Trigger B fires when |slopePct_now − baseline| reaches
// (AMA_SLOPE_DELTA_THRESHOLD_PERCENT / 100) × DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
// where slopePct is the production Huber-robust per-bar AMA slope over
// DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS with the canonical EMA applied
// (computeAmaSlopeEmaSeries), matching the live published slope, and the
// baseline mirrors botState.gridRangeScalingAmaSlope (re-seeded every reset).
// --slope-ema-alpha can pin the smoothing (1 = raw Huber) for what-if runs.
const SLOPE_NEUTRAL_ZONE_PCT = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;

const RISK_W_DURATION = 1.0;   // avg open bars
const RISK_W_PEAK_OPEN = 2.0;  // peak simultaneous open orders
const RISK_W_IMBALANCE = 1.2;  // avg |openBuy-openSell|
const RISK_W_CANCEL = 0.15;    // canceled on reposition

const DEFAULT_SPREAD_VALUES = range(0.4, 1.6, 0.1);
const DEFAULT_INCREMENT_VALUES = range(0.2, 0.8, 0.1);
const DEFAULT_RATIO_VALUES = [1.5, 1.75, 2, 2.5, 3, 4, 5, 8, 10];

function parseArgs() {
    const args = process.argv.slice(2);
    const out: {
        dataPath: string | null;
        resultsPath: string | null;
        spreadValues: number[];
        incrementValues: number[];
        ratioValues: number[];
        activeOrders: number;
        feeRoundtripPct: number;
        minSpreadFactor: number;
        repositionPct: number;
        asymmetricBounds: boolean;
        btsCreateFee: number;
        btsCancelFee: number;
        makerCreateFactor: number;
        txFeePrice: number;
        btsFeeCapital: number;
        riskWDuration: number;
        riskWPeakOpen: number;
        riskWImbalance: number;
        riskWCancel: number;
        slopeEmaAlpha: number;
    } = {
        dataPath: null,
        resultsPath: null,
        spreadValues: DEFAULT_SPREAD_VALUES,
        incrementValues: DEFAULT_INCREMENT_VALUES,
        ratioValues: DEFAULT_RATIO_VALUES,
        activeOrders: DEFAULT_ACTIVE_ORDERS,
        feeRoundtripPct: DEFAULT_FEE_ROUNDTRIP_PCT,
        minSpreadFactor: DEFAULT_MIN_SPREAD_FACTOR,
        repositionPct: DEFAULT_REPOSITION_PCT,
        asymmetricBounds: false,
        btsCreateFee: DEFAULT_BTS_CREATE_FEE,
        btsCancelFee: DEFAULT_BTS_CANCEL_FEE,
        makerCreateFactor: DEFAULT_BTS_MAKER_CREATE_FACTOR,
        txFeePrice: DEFAULT_TX_FEE_PRICE,
        btsFeeCapital: DEFAULT_BTS_FEE_CAPITAL,
        riskWDuration: RISK_W_DURATION,
        riskWPeakOpen: RISK_W_PEAK_OPEN,
        riskWImbalance: RISK_W_IMBALANCE,
        riskWCancel: RISK_W_CANCEL,
        slopeEmaAlpha: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        // Valueless boolean flag — must be handled before the value lookup
        // below (and before the trailing-arg `if (!val) continue` guard).
        if (arg === '--asymmetric-bounds') { out.asymmetricBounds = true; continue; }
        const val = args[i + 1];
        if (!val) continue;
        if (consumeBacktestArg(arg, val, out, {
            spreadValues: DEFAULT_SPREAD_VALUES,
            incrementValues: DEFAULT_INCREMENT_VALUES,
            ratioValues: DEFAULT_RATIO_VALUES,
        })) { i++; continue; }
        switch (arg) {
            case '--active-orders':
                out.activeOrders = Number(val);
                i++;
                break;
            case '--bts-fee-capital':
                out.btsFeeCapital = Number(val);
                i++;
                break;
            case '--risk-duration':
                out.riskWDuration = Number(val);
                i++;
                break;
            case '--risk-peak-open':
                out.riskWPeakOpen = Number(val);
                i++;
                break;
            case '--risk-imbalance':
                out.riskWImbalance = Number(val);
                i++;
                break;
            case '--risk-cancel':
                out.riskWCancel = Number(val);
                i++;
                break;
            case '--slope-ema-alpha':
                out.slopeEmaAlpha = Number(val);
                i++;
                break;
        }
    }

    if (!out.dataPath) {
        throw new Error('--data <path-to-lp-candles.json> is required');
    }

    if (!out.resultsPath) {
        out.resultsPath = resolveAutoResultsPath(out.dataPath);
    }

    return out;
}

/**
 * Auto-derive the AMA optimizer results file for a given LP candle data file.
 *
 * The optimizer names results `optimization_results_<base>_w<λ1>_<λ2>_<λ3>_<λ4>.json`
 * (per-AMA distance weights appended as a `_w...` suffix). To stay robust against
 * weight overrides, pick the most recently written `optimization_results_<base>_w*.json`
 * in the analysis results dir (legacy ama_fitting location still scanned); fall
 * back to the legacy `optimization_results_<base>.json` name if no suffixed file exists.
 */
function resolveAutoResultsPath(dataPath: string): string {
    const base = path.basename(dataPath, '.json');
    // Canonical results dir first, then the legacy ama_fitting location so
    // previously generated files are still discovered.
    const dirs = [PATHS.ANALYSIS.RESULTS_DIR, path.join(PATHS.PROJECT_ROOT, 'analysis', 'ama_fitting')];
    const prefix = `optimization_results_${base}_w`;
    let newest: { file: string; mtimeMs: number } | null = null;
    try {
        for (const dir of dirs) {
            for (const entry of fs.readdirSync(dir)) {
                if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
                const full = path.join(dir, entry);
                const stat = fs.statSync(full);
                if (!newest || stat.mtimeMs > newest.mtimeMs) {
                    newest = { file: full, mtimeMs: stat.mtimeMs };
                }
            }
        }
    } catch {
        // dir unreadable — fall through to legacy name check
    }
    if (newest) return newest.file;
    return path.join(PATHS.ANALYSIS.RESULTS_DIR, `optimization_results_${base}.json`);
}

interface AmaStrategy {
    id: string;
    name: string;
    er: number;
    fast: number;
    slow: number;
}

/**
 * Spread-gap width in slots — direct port of calculateGapSlots
 * (modules/order/utils/math.ts). The effective target spread is clamped
 * up to incrementPercent × MIN_SPREAD_FACTOR and the gap never drops below
 * MIN_SPREAD_ORDERS slots. `incrementPercent`/`targetSpreadPercent` in PERCENT
 * units, matching the production signature.
 */
function computeGapSlots(incrementPercent: number, targetSpreadPercent: number) {
    const step = 1 + (incrementPercent / 100);
    const minSpreadPercent = incrementPercent * GRID_LIMITS.MIN_SPREAD_FACTOR;
    const effectiveTargetSpread = Math.max(targetSpreadPercent || 0, minSpreadPercent);
    const requiredSteps = Math.ceil(Math.log(1 + (effectiveTargetSpread / 100)) / Math.log(step));
    return Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS, requiredSteps - 1);
}

/**
 * Slope-ratio grid price offset — port of computeGridPriceOffsetPlan
 * (market_adapter/core/market_adapter_service.ts) combined with the
 * trend/slopeRatio semantics of computeAmaSlopeWeights
 * (market_adapter/core/strategies/ama_slope_model.ts):
 *
 *   maxGridPriceOffsetPct = targetSpreadPercent / 2
 *   slopeRatio           = min(|slopePct| / DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT, 1)
 *   direction            = sign(slopePct) (0 inside the neutral zone)
 *   offsetPct            = direction × slopeRatio × maxGridPriceOffsetPct
 *
 * Production applies this to startPrice (modules/order/grid.ts,
 * initializeGrid: startPrice × (1 + offset/100)) only for
 * asymmetricBounds-whitelisted bots; the sim applies it
 * to the placement center on every grid build when asymmetricBounds is on.
 */
function computeGridPriceOffsetPct(slopePct: number, targetSpreadPercent: number) {
    if (!Number.isFinite(slopePct)) return 0;
    if (Math.abs(slopePct) <= SLOPE_NEUTRAL_ZONE_PCT) return 0;
    const slopeRatio = Math.min(Math.abs(slopePct) / SLOPE_MAX_PCT, 1);
    const maxGridPriceOffsetPct = targetSpreadPercent / 2;
    const direction = slopePct > 0 ? 1 : -1;
    const offsetPct = direction * slopeRatio * maxGridPriceOffsetPct;
    return Math.round(offsetPct * 1e6) / 1e6;
}

/**
 * Build a persistent grid with FIXED chain prices from a master rail —
 * port of createOrderGrid (modules/order/grid.ts):
 *
 *   - Master rail: geometric progression starting at √(1±inc) × center and
 *     expanding by (1±inc) steps outward, bounded by
 *     [center/maxMinRatio, center×maxMinRatio] (rail expansion:
 *     derivePriceLevels in modules/order/utils/math.ts).
 *   - Spread gap: gapSlots empty slots centered on the center price
 *     (calculateIdealBoundary: boundaryIdx = splitIdx − floor(gap/2) − 1;
 *     sells start at boundaryIdx + gapSlots + 1).
 *   - By default every rail slot in bounds is sized (activeOrders = Infinity,
 *     matching production); an explicit cap keeps only the slots nearest the
 *     gap on each side.
 *
 * Order prices are placement-time constants — exactly like on-chain orders,
 * they do NOT follow AMA after placement.
 */
function buildProductionGrid(center: number, spreadPct: number, incrementPctFrac: number, maxMinRatio: number, activeOrders: number) {
    const stepUp = 1 + incrementPctFrac;
    const stepDown = 1 - incrementPctFrac;
    const minBound = center / maxMinRatio;
    const maxBound = center * maxMinRatio;

    const rail: number[] = [];
    let p = center * Math.sqrt(stepUp);
    while (p <= maxBound) { rail.push(p); p *= stepUp; }
    p = center * Math.sqrt(stepDown);
    while (p >= minBound) { rail.push(p); p *= stepDown; }
    rail.sort((a, b) => a - b);
    if (rail.length === 0) return { buys: [], sells: [], rail: [], buySliceStart: 0, sellStartIdx: 0 };

    const gapSlots = computeGapSlots(incrementPctFrac * 100, spreadPct);
    let splitIdx = rail.findIndex((v) => v >= center);
    if (splitIdx === -1) splitIdx = rail.length;
    const buySpread = Math.floor(gapSlots / 2);
    const boundaryIdx = Math.max(0, Math.min(rail.length - 1, splitIdx - buySpread - 1));
    const sellStartIdx = boundaryIdx + gapSlots + 1;

    // Buys closest to the gap = highest priced below boundary; sells closest =
    // lowest priced above sellStartIdx. Rail + slice offsets are returned so
    // callers can map each placed slot onto its MASTER-RAIL index (rotation
    // walks adjacent rail nodes, exactly like the live anchor-&-refill hop).
    const buySliceStart = Math.max(0, boundaryIdx - activeOrders + 1);
    const sellsArr = rail.slice(sellStartIdx, sellStartIdx + activeOrders);
    return {
        buys: rail.slice(buySliceStart, boundaryIdx + 1),
        sells: sellsArr,
        rail,
        buySliceStart,
        sellStartIdx,
    };
}

/**
 * Slot-rotation simulation with FIXED chain prices, mirroring production
 * anchor-&-refill (strategy.ts) on top of the createOrderGrid geometry:
 *
 *   - Initial grid built once at the post-warmup AMA (createOrderGrid geometry
 *     via buildProductionGrid); order prices never follow AMA afterwards. When
 *     asymmetricBounds is enabled the placement center is shifted by the
 *     slope-ratio offset (#3) exactly like the live startPrice offset.
 *   - Rotation economics (#1/#2/#15): a FILLED BUY at rail node k instantly
 *     re-offers that base at the ADJACENT MASTER-RAIL NODE k+1; when that
 *     refill sells, the rotation books exactly one rail hop minus the
 *     round-trip fee, and the freed quote re-bids the node k-1 below. Slots
 *     cycle on small oscillations between resets — the earnings model of a
 *     refilled live slot, not a cross-gap differential.
 *   - Inventory-funded selling: an INITIAL (unlinked) sell can only execute
 *     against held inventory — it books its proceeds against the weighted
 *     average entry of the position (the live bot funds sells from real
 *     balances; unfundable sells stay open and retry, never shorting). Base
 *     bought in the SAME bar does not fund unlinked sales until the next bar
 *     (live balance updates propagate on the next maintenance tick).
 *   - Same-bar guard: newly armed/refill orders carry a one-bar cooldown, so
 *     a slot that just cycled cannot fill again inside the completion bar.
 *   - Grid reset fires on EITHER production trigger:
 *       (A) |AMA − recordedCenter| / recordedCenter ≥ repositionThresholdPct
 *           (ratchet: recordedCenter updates only when the trigger fires),
 *       (B) slope-delta reset, ONLY when asymmetricBounds (whitelist gate):
 *           |slopePct_now − slopeBaseline| ≥ slopeDeltaThresholdPct
 *           (= AMA_SLOPE_DELTA_THRESHOLD_PERCENT/100 ×
 *              DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT), where slopePct is the
 *           DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS average-slope series and
 *           slopeBaseline mirrors botState.gridRangeScalingAmaSlope — seeded
 *           at start and re-seeded on every reset.
 *     On reset ALL unfilled orders are canceled (counted); bought-and-held
 *     base REMAINS as inventory (live resync never market-sells) and merges
 *     into the weighted-average-entry pool; a fresh grid is placed at the
 *     new center.
 *   - Scoring uses REALIZED rotations and op fees ONLY. The end-of-run
 *     inventory position (units × mark-vs-avg-entry) is reported as an
 *     informational field — it is real carried risk, but including unrealized
 *     bag marks in the ranking objective let trend-following combos dump
 *     phantom paper profit into the score.
 *   - BTS operation fees (#9): every order placement (initial grid + every
 *     armed refill/rebid) pays makerCreateFee × btsCreateFee, every reset
 *     cancel pays btsCancelFee; totals are converted to percentage points
 *     against the --bts-fee-capital reference and deducted from net capture.
 *
 * Differences from production (by design, documented):
 *   #6 bar-granularity triggers and reset-vs-fill ordering (OHLC sim);
 *   #7 all-or-nothing fills on raw hi/lo touch (no partial fills/dust/queue);
 *   #8 unit sizes / percentage-point accounting instead of capital-weighted
 *      dynamic sizing;
 *   #10 pool-price fills (no book depth/slippage);
 *   #11 no consolidation/dust-cancel/COW/collision mechanics.
 */
interface SimCandle {
    open?: number;
    high: number;
    low: number;
    close: number;
    time?: number;
    [key: string]: unknown;
}

interface SimOrder {
    side: 'buy' | 'sell';
    price: number;
    railIdx: number;
    linkedBuyPrice: number | null;
    linkedEntryBar: number;
    cooldownUntil: number;
}

interface SimParams {
    spreadPct: number;
    incrementPct: number;
    maxMinRatio: number;
    activeOrders: number;
    feeRoundtripPct: number;
    repositionThresholdPct: number;
    asymmetricBounds: boolean;
    risk: { duration: number; peakOpen: number; imbalance: number; cancel: number };
    btsCreateFee: number;
    btsCancelFee: number;
    makerCreateFactor: number;
    txFeePrice: number;
    btsFeeCapital: number;
    warmupBars: number;
    [key: string]: unknown;
}

type SimResult = ReturnType<typeof simulateForParams>;

interface SimRun {
    strategy: AmaStrategy;
    best: SimResult | null;
}

function simulateForParams(candles: SimCandle[], amaValues: number[], params: SimParams) {
    const { spreadPct, incrementPct, maxMinRatio, activeOrders, feeRoundtripPct,
            repositionThresholdPct, asymmetricBounds, risk,
            btsCreateFee, btsCancelFee, makerCreateFactor, txFeePrice, btsFeeCapital } = params;
    // Warmup follows production AMA seeding/convergence (getAmaWarmupBars)
    // instead of an arbitrary fraction of the dataset, so simulations never
    // start on SMA-warmup values when the fitted ER period is large.
    const skip = Math.min(params.warmupBars, Math.max(0, candles.length - 2));
    const singleLegFeePct = feeRoundtripPct / 2;
    const slopeDeltaThresholdPct = slopeResetThresholdPct();
    const makerCreateFeeBts = btsCreateFee * makerCreateFactor;
    const stepUpFrac = 1 + incrementPct; // one-rail-step rotation distance
    // Optional gate/band overrides. `slopePersistBars` follows the production
    // default (constants) unless the caller pins a value, so the fill model's
    // reset path matches live whenever asymmetricBounds enables trigger B.
    //   slopePersistBars persistence gate on trigger B
    //   bandTilt         apply applyAsymmetricBounds to the built band
    const slopeLookbackRaw = Number(params.slopeLookbackBars);
    const slopeLookbackBars = Number.isFinite(slopeLookbackRaw) && slopeLookbackRaw >= 2
        ? Math.round(slopeLookbackRaw) : SLOPE_LOOKBACK_BARS;
    const slopePersistRaw = Number(params.slopePersistBars);
    const slopePersistBars = Number.isFinite(slopePersistRaw) && slopePersistRaw >= 1
        ? Math.round(slopePersistRaw)
        : (MARKET_ADAPTER.AMA_SLOPE_PERSIST_ENABLED === true && Number(MARKET_ADAPTER.AMA_SLOPE_PERSIST_BARS) >= 1
            ? Math.round(Number(MARKET_ADAPTER.AMA_SLOPE_PERSIST_BARS)) : 1);
    const bandTilt = params.bandTilt === true;
    const maxAsymmetryFactor = Number.isFinite(params.maxAsymmetryFactor)
        ? Number(params.maxAsymmetryFactor) : MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR;

    // First tradable bar: need a finite positive AMA to anchor the chain.
    let startIdx = Math.min(skip, candles.length - 1);
    let gridCenter = Number.NaN;
    for (let j = startIdx; j < candles.length; j++) {
        const v = amaValues[j];
        if (Number.isFinite(v) && v > 0) { gridCenter = v; startIdx = j; break; }
    }

    // Production AMA slope series (%/bar): the canonical Huber -> EMA replay
    // the live adapter publishes. Raw Huber would make trigger B diverge from
    // the live reset cadence. erPeriod mirrors the live readiness guard; callers
    // without one (unit fixtures) start at the Huber window like before.
    const erRaw = Number(params.erPeriod);
    const erPeriod = Number.isFinite(erRaw) && erRaw > 0 ? Math.ceil(erRaw) : 0;
    const slopeEmaAlpha = normalizeAmaSlopeEmaAlpha(params.slopeEmaAlpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
    const shapedSlopes = computeAmaSlopeEmaSeries(amaValues, erPeriod, slopeLookbackBars, slopeEmaAlpha);
    const slopeAt: (number | null)[] = new Array(candles.length).fill(null);
    for (let j = slopeLookbackBars; j < candles.length; j++) {
        const s = shapedSlopes[j];
        if (s != null && Number.isFinite(s)) slopeAt[j] = s;
    }

    // Open orders keyed by running id: { side, price, linkedBuyPrice,
    // linkedEntryBar, cooldownUntil }. linkedBuyPrice != null marks an armed
    // refill sell created by a specific filled buy (one-increment rotation).
    const orders = new Map<number, SimOrder>();
    let nextOrderId = 0;
    // Bought-and-held base across the whole run (weighted-average entry
    // pool). Never negative — sells without inventory stay pending.
    const inv = { units: 0, cost: 0 };

    let btsFeesBts = 0;
    let offsetAppliedCount = 0;
    // Master rail of the CURRENT epoch — rotation hops read adjacent nodes.
    let activeRail: number[] = [];

    const placeInitialGrid = (center: number, slopePct: number | null) => {
        const offsetPct = (asymmetricBounds && slopePct != null)
            ? computeGridPriceOffsetPct(slopePct, spreadPct)
            : 0;
        if (offsetPct !== 0) offsetAppliedCount++;
        // applyAsymmetricBounds scales BOTH base bounds by one factor, so the
        // tilted band is exactly a same-ratio band centred at center*scale
        // (when the narrowing-side guard does not bind).
        let scale = 1;
        if (bandTilt && slopePct != null && Math.abs(slopePct) > SLOPE_NEUTRAL_ZONE_PCT) {
            const trend = slopePct > 0 ? 'UP' : 'DOWN';
            const tilt = applyAsymmetricBounds({
                centerPrice: center,
                minPrice: center / maxMinRatio,
                maxPrice: center * maxMinRatio,
                trend,
                slopeOffset: Math.abs(slopePct),
                maxSlopeOffset: SLOPE_MAX_PCT,
                maxAsymmetryFactor,
            });
            const baseMax = center * maxMinRatio;
            if (Number.isFinite(tilt.resolvedMaxPrice) && baseMax > 0) scale = tilt.resolvedMaxPrice / baseMax;
        }
        const effCenter = center * scale * (1 + offsetPct / 100);
        const built = buildProductionGrid(effCenter, spreadPct, incrementPct, maxMinRatio, activeOrders);
        activeRail = built.rail;
        orders.clear();
        // Rail indices matter: rotation re-offers/re-bids walk ADJACENT
        // master-rail nodes (buy at node k arms a sell at node k+1; the freed
        // quote re-bids node k-1), preserving the exact production hop sizes.
        built.buys.forEach((price, i) => orders.set(nextOrderId++, {
            side: 'buy', price, railIdx: built.buySliceStart + i,
            linkedBuyPrice: null, linkedEntryBar: -1, cooldownUntil: -1,
        }));
        built.sells.forEach((price, i) => orders.set(nextOrderId++, {
            side: 'sell', price, railIdx: built.sellStartIdx + i,
            linkedBuyPrice: null, linkedEntryBar: -1, cooldownUntil: -1,
        }));
        btsFeesBts += (built.buys.length + built.sells.length) * makerCreateFeeBts;
    };

    let touchedOrders = 0;
    let cyclesTotal = 0;
    let rotationCount = 0;       // linked ping-pong rotations (buy → refill sell)
    let inventorySaleCount = 0;  // unlinked sells executed against held bags
    let canceledOnReposition = 0;
    let repositionCount = 0;
    let driftTriggerCount = 0;
    let slopeTriggerCount = 0;
    let totalGrossCapturePct = 0;
    let totalNetCapturePct = 0;
    let peakOpenOrders = 0;
    let imbalanceSum = 0;
    let imbalanceSamples = 0;
    let matchedOpenDurationBars = 0;

    const invAvgEntry = () => (inv.units > 0 ? inv.cost / inv.units : 0);

    if (Number.isFinite(gridCenter)) placeInitialGrid(gridCenter, slopeAt[startIdx]);

    // Slope-delta baseline: mirrors botState.gridRangeScalingAmaSlope —
    // seeded at bootstrap (first cycle) and re-seeded to the current slope on
    // EVERY grid reset (advanceTriggeredBotState), so trigger B measures how
    // far slope has moved SINCE THE LAST RESET, not bar-over-bar jitter.
    let slopeBaseline: number | null = null;
    for (let j = startIdx + 1; j < candles.length; j++) {
        if (slopeAt[j] != null) { slopeBaseline = slopeAt[j]; break; }
    }
    // Persistence-gate state for trigger B.
    let slopePersistCount = 0;
    let slopePersistDir = 0;

    for (let i = startIdx + 1; i < candles.length; i++) {
        const ama = amaValues[i];
        const hi = candles[i].high;
        const lo = candles[i].low;

        // ── Grid-reset check: trigger A (AMA delta) always; trigger B
        //    (slope delta) only under the asymmetricBounds whitelist gate.
        let shouldReset = false;
        if (Number.isFinite(ama) && ama > 0) {
            const driftPct = (Math.abs(ama - gridCenter) / gridCenter) * 100;
            if (driftPct >= repositionThresholdPct) { shouldReset = true; driftTriggerCount++; }
        }
        if (!shouldReset && asymmetricBounds && slopeBaseline != null && slopeAt[i] != null) {
            const crossed = Math.abs(slopeAt[i]! - slopeBaseline) >= slopeDeltaThresholdPct;
            if (slopePersistBars <= 1) {
                if (crossed) { shouldReset = true; slopeTriggerCount++; }
            } else if (!crossed) {
                slopePersistCount = 0;
                slopePersistDir = 0;
            } else {
                const dir = Math.sign(slopeAt[i]! - slopeBaseline);
                if (dir !== 0 && dir === slopePersistDir) slopePersistCount++;
                else { slopePersistDir = dir; slopePersistCount = 1; }
                if (slopePersistCount >= slopePersistBars) { shouldReset = true; slopeTriggerCount++; }
            }
        }

        if (shouldReset && Number.isFinite(ama) && ama > 0) {
            slopePersistCount = 0;
            slopePersistDir = 0;
            canceledOnReposition += orders.size;
            btsFeesBts += orders.size * btsCancelFee;
            orders.clear(); // inventory survives — resync never market-sells
            repositionCount++;
            gridCenter = ama; // ratchet the recorded center to the current AMA
            // Re-seed the slope baseline with the current slope (falls back to
            // the previous baseline when slope is not ready — same as
            // advanceTriggeredBotState's `|| previous` chain).
            if (slopeAt[i] != null) slopeBaseline = slopeAt[i];
            placeInitialGrid(gridCenter, slopeAt[i]);
        }

        const currentOpen = orders.size;
        if (currentOpen > peakOpenOrders) peakOpenOrders = currentOpen;
        let buyCount = 0;
        for (const [, o] of orders) { if (o.side === 'buy') buyCount++; }
        imbalanceSum += Math.abs(buyCount - (orders.size - buyCount));
        imbalanceSamples++;

        // ── Fill detection against FIXED chain prices ───────────────────
        const filledBuys: { id: number; order: SimOrder }[] = [];
        const filledSells: { id: number; order: SimOrder }[] = [];
        for (const [id, o] of orders) {
            if (i < o.cooldownUntil) continue;
            if (o.side === 'buy' && lo <= o.price) filledBuys.push({ id, order: o });
            else if (o.side === 'sell' && hi >= o.price) filledSells.push({ id, order: o });
        }
        touchedOrders += filledBuys.length + filledSells.length;
        // Base held BEFORE this bar's intakes — an unlinked sell may only
        // dispose against pre-existing funds (live balance updates propagate
        // on the next maintenance tick; same-bar funding is not assumed).
        const invAtBarStart = inv.units;

        // ── Buy intakes first: base enters inventory, refill armed at the
        //    ADJACENT MASTER-RAIL NODE above (anchor-&-refill hop; cooldown
        //    blocks same-bar recycles).
        for (const f of filledBuys) {
            orders.delete(f.id);
            inv.units += 1;
            inv.cost += f.order.price;
            const upIdx = (f.order.railIdx ?? -1) + 1;
            const refillPrice = activeRail[upIdx] ?? f.order.price * stepUpFrac;
            orders.set(nextOrderId++, {
                side: 'sell',
                price: refillPrice,
                railIdx: upIdx,
                linkedBuyPrice: f.order.price,
                linkedEntryBar: i,
                cooldownUntil: i + 1,
            });
            btsFeesBts += makerCreateFeeBts;
        }

        // ── Sell disposals: linked refills book the one-rail-hop rotation;
        //     unlinked (initial-grid) sells need held inventory — no shorting.
        //     Linked refills resolve FIRST so same-bar cross-gap inventory
        //     sales against a fresh bag cannot happen.
        filledSells.sort((a, b) => ((a.order.linkedBuyPrice != null ? 0 : 1) - (b.order.linkedBuyPrice != null ? 0 : 1)));
        let disposables = invAtBarStart;
        for (const f of filledSells) {
            const o = f.order;
            if (o.linkedBuyPrice != null) {
                const grossPct = (o.price / o.linkedBuyPrice - 1) * 100;
                totalGrossCapturePct += grossPct;
                totalNetCapturePct += grossPct - feeRoundtripPct;
                cyclesTotal++;
                rotationCount++;
                matchedOpenDurationBars += Math.abs(i - o.linkedEntryBar);
                // Dispose the unit its own rotation bought.
                const applied = Math.min(1, inv.units);
                inv.cost -= applied * invAvgEntry();
                inv.units -= applied;
                // Its disposal also drains the pre-bar funding budget —
                // otherwise later unlinked sales could overspend stock.
                disposables -= applied;
                // Freed quote re-bids the ADJACENT RAIL NODE below.
                const downIdx = (o.railIdx ?? 0) - 1;
                const rebidPrice = activeRail[downIdx] ?? o.price / stepUpFrac;
                orders.delete(f.id);
                orders.set(nextOrderId++, {
                    side: 'buy',
                    price: rebidPrice,
                    railIdx: downIdx,
                    linkedBuyPrice: null,
                    linkedEntryBar: -1,
                    cooldownUntil: i + 1,
                });
                btsFeesBts += makerCreateFeeBts;
            } else if (disposables >= 1) {
                const avgEntry = invAvgEntry();
                const grossPct = (o.price / avgEntry - 1) * 100;
                totalGrossCapturePct += grossPct;
                totalNetCapturePct += grossPct - feeRoundtripPct;
                cyclesTotal++;
                inventorySaleCount++;
                inv.cost -= avgEntry; // remove that unit at pool-average cost
                inv.units -= 1;
                disposables -= 1;
                orders.delete(f.id); // sold bag is gone; slot not re-armed
            } else {
                // Unfundable (no base to sell): stays open, retries next bar.
                o.cooldownUntil = i + 1;
            }
        }
    }

    // ── End-of-run inventory mark (informational, NOT in score) ────────
    // Bought-and-held base is real carried risk, but unrealized bag marks are
    // excluded from ranking so trend-following combos can't dump phantom
    // paper profit into the objective. Marked once at the final close with a
    // single-leg exit fee per unit.
    const lastClose = candles.length > 0 ? candles[candles.length - 1].close : NaN;
    const inventoryUnits = inv.units;
    const inventoryAvgEntry = invAvgEntry();
    const inventoryNetPts = inventoryUnits > 0 && Number.isFinite(lastClose) && lastClose > 0
        ? (((lastClose / inventoryAvgEntry) - 1) * 100 - singleLegFeePct) * inventoryUnits
        : 0;

    // BTS operation fees → percentage points against the reference capital.
    const btsFeePts = (btsFeesBts * txFeePrice) / Math.max(1, btsFeeCapital) * 100;
    const totalNetCaptureAfterFeesPct = totalNetCapturePct - btsFeePts;

    const fillEfficiency = touchedOrders > 0 ? (cyclesTotal / touchedOrders) * 100 : 0;
    const avgNetPerPair = cyclesTotal > 0 ? totalNetCapturePct / cyclesTotal : 0;
    const utilization = (touchedOrders / Math.max(1, candles.length - skip)) * 100;
    const avgOpenDurationBars = rotationCount > 0 ? (matchedOpenDurationBars / rotationCount) : 0;
    const avgImbalance = imbalanceSamples > 0 ? (imbalanceSum / imbalanceSamples) : 0;
    const riskPenalty =
        (avgOpenDurationBars * risk.duration) +
        (peakOpenOrders * risk.peakOpen) +
        (avgImbalance * risk.imbalance) +
        (canceledOnReposition * risk.cancel);
    const baseScore = totalNetCaptureAfterFeesPct * (fillEfficiency / 100);
    const score = baseScore - riskPenalty;

    return {
        spreadPct,
        incrementPct,
        maxMinRatio,
        touchedOrders,
        matchedPairs: cyclesTotal,
        cyclesTotal,
        rotationCount,
        inventorySaleCount,
        avgCyclesPerSlot: cyclesTotal / Math.max(1, peakOpenOrders),
        fillEfficiency,
        totalGrossCapturePct,
        totalNetCapturePct,
        btsFeePts,
        btsFeesBts,
        totalNetCaptureAfterFeesPct,
        avgNetPerPair,
        canceledOnReposition,
        repositionCount,
        driftTriggerCount,
        slopeTriggerCount,
        inventoryUnits,
        inventoryAvgEntry,
        inventoryNetPts,
        offsetAppliedCount,
        avgOpenDurationBars,
        peakOpenOrders,
        avgImbalance,
        riskPenalty,
        baseScore,
        utilization,
        score,
    };
}

function run() {
    const cfg = parseArgs();
    if (!Number.isFinite(cfg.minSpreadFactor) || cfg.minSpreadFactor <= 0) {
        throw new Error(`Invalid min spread factor: ${cfg.minSpreadFactor}`);
    }
    for (const [k, v] of Object.entries({
        riskDuration: cfg.riskWDuration,
        riskPeakOpen: cfg.riskWPeakOpen,
        riskImbalance: cfg.riskWImbalance,
        riskCancel: cfg.riskWCancel,
    })) {
        if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${k}: ${v}`);
    }
    const loaded = loadLpData(cfg.dataPath!);
    const candles = loaded.candles;
    const closes = candles.map((c) => c.close);
    const strategies = loadAmaStrategies(cfg.resultsPath!, {
        requireAllFields: true,
        exactCount: 4,
        labels: { AMA1: 'AMA1', AMA2: 'AMA2', AMA3: 'AMA3', AMA4: 'AMA4' },
    });

    if (!Number.isFinite(cfg.repositionPct) || cfg.repositionPct <= 0) {
        throw new Error(`Invalid reposition threshold: ${cfg.repositionPct}`);
    }

    const totalCombos = cfg.spreadValues.length * cfg.incrementValues.length * cfg.ratioValues.length;

    console.log('================================================================================');
    console.log(' BOT FITTING BACKTEST (1h LP candles)');
    console.log('================================================================================');
    console.log(`  Data:         ${path.basename(cfg.dataPath!)} (${candles.length} candles)`);
    console.log(`  Results file: ${path.basename(cfg.resultsPath!)}`);
    console.log(`  Spread grid:  ${cfg.spreadValues[0]}..${cfg.spreadValues[cfg.spreadValues.length - 1]}% (${cfg.spreadValues.length})`);
    console.log(`  Increment:    ${cfg.incrementValues[0]}..${cfg.incrementValues[cfg.incrementValues.length - 1]}% (${cfg.incrementValues.length})`);
    console.log(`  Max/Min ratio:${cfg.ratioValues[0]}..${cfg.ratioValues[cfg.ratioValues.length - 1]} (${cfg.ratioValues.length})`);
    console.log(`  Active orders:${Number.isFinite(cfg.activeOrders) ? cfg.activeOrders : 'all'} per side (Infinity = every rail slot, matching production)`);
    console.log(`  Fee RT:       ${cfg.feeRoundtripPct}%`);
    console.log(`  Spread floor: spread >= ${cfg.minSpreadFactor} x increment`);
    console.log(`  Reset (A):    AMA drift >= ${cfg.repositionPct}% from recorded center${cfg.repositionPct === DEFAULT_REPOSITION_PCT ? ' (AMA_DELTA_THRESHOLD_PERCENT)' : ''}`);
    console.log(`  Asym. bounds: ${cfg.asymmetricBounds ? 'ON — slope reset (B) + grid price offset enabled (whitelist semantics)' : 'OFF — typical non-whitelisted bot (production default)'}`);
    console.log(`  Reset (B):    |slope - slope@lastReset| >= ${slopeResetThresholdPct()}% (${SLOPE_TRIGGER_FACTOR}% x ${SLOPE_MAX_PCT}, lookback ${SLOPE_LOOKBACK_BARS}, ema ${normalizeAmaSlopeEmaAlpha(cfg.slopeEmaAlpha)})${cfg.asymmetricBounds ? '' : ' [gated off]'}`);
    console.log(`  Tx fees:      create=${fmt(cfg.btsCreateFee * cfg.makerCreateFactor, 5)} BTS, cancel=${fmt(cfg.btsCancelFee, 5)} BTS, 1 BTS=${fmt(cfg.txFeePrice, 2)} units, capital=${fmt(cfg.btsFeeCapital, 0)}`);
    console.log(`  Risk W:       duration=${cfg.riskWDuration}, peakOpen=${cfg.riskWPeakOpen}, imbalance=${cfg.riskWImbalance}, cancel=${cfg.riskWCancel}`);
    console.log(`  Combos/AMA:   ${totalCombos}\n`);

    const byAma: SimRun[] = [];

    for (const s of strategies) {
        const amaValues = calculateAMA(closes, { erPeriod: s.er, fastPeriod: s.fast, slowPeriod: s.slow });
        // Production-aligned warmup: ER window + convergence (getAmaWarmupBars).
        const warmupBars = getAmaWarmupBars(s.er, s.slow, 0, s.fast);
        let best: SimResult | null = null;

        for (const spreadPct of cfg.spreadValues) {
            for (const incrementPct of cfg.incrementValues) {
                // Dedup guard only: computeGapSlots clamps the effective target
                // spread up to increment × MIN_SPREAD_FACTOR, so combos below the
                // floor would build an identical grid to the floored combo.
                if (spreadPct + Number.EPSILON < (cfg.minSpreadFactor * incrementPct)) continue;
                for (const maxMinRatio of cfg.ratioValues) {
                    const sim = simulateForParams(candles, amaValues, {
                        spreadPct,
                        incrementPct: incrementPct / 100,
                        maxMinRatio,
                        activeOrders: cfg.activeOrders,
                        feeRoundtripPct: cfg.feeRoundtripPct,
                        repositionThresholdPct: cfg.repositionPct,
                        asymmetricBounds: cfg.asymmetricBounds,
                        erPeriod: s.er,
                        slopeEmaAlpha: cfg.slopeEmaAlpha,
                        btsCreateFee: cfg.btsCreateFee,
                        btsCancelFee: cfg.btsCancelFee,
                        makerCreateFactor: cfg.makerCreateFactor,
                        txFeePrice: cfg.txFeePrice,
                        btsFeeCapital: cfg.btsFeeCapital,
                        warmupBars,
                        risk: {
                            duration: cfg.riskWDuration,
                            peakOpen: cfg.riskWPeakOpen,
                            imbalance: cfg.riskWImbalance,
                            cancel: cfg.riskWCancel,
                        },
                    });
                    if (!best || sim.score > best.score) best = sim;
                }
            }
        }

        byAma.push({ strategy: s, best });
    }

    console.log('BEST PARAMS PER AMA');
    console.log('--------------------------------------------------------------------------------');
    console.log('AMA                              | spread | incr | ratio | cyc   | fill% | net%   | risk  | score | inv-units (info)');
    console.log('---------------------------------|--------|------|-------|-------|-------|--------|-------|-------|-----------------');
    for (const row of byAma) {
        const b = row.best;
        if (!b) continue;
        console.log(
            `${row.strategy.name.padEnd(33)}| ` +
            `${fmt(b.spreadPct, 2).padStart(6)} | ` +
            `${fmt(b.incrementPct * 100, 2).padStart(4)} | ` +
            `${fmt(b.maxMinRatio, 2).padStart(5)} | ` +
            `${String(b.matchedPairs).padStart(5)} | ` +
            `${fmt(b.fillEfficiency, 1).padStart(5)} | ` +
            `${fmt(b.totalNetCapturePct, 1).padStart(6)} | ` +
            `${fmt(b.riskPenalty, 1).padStart(5)} | ` +
            `${fmt(b.score, 1).padStart(5)} | ` +
            `${fmt(b.inventoryUnits, 0).padStart(8)} (${fmt(b.inventoryNetPts, 1)} pts)`
        );
    }
    console.log('(* end-of-run inventory mark: informational only — excluded from scoring)');
    console.log();

    const outName = `bot_fitting_results_${path.basename(cfg.dataPath!, '.json')}.json`;
    const outPath = path.join(PATHS.ANALYSIS.RESULTS_DIR, outName);
    ensureDir(PATHS.ANALYSIS.RESULTS_DIR);
    writeJSON(outPath, {
        meta: {
            generatedAt: new Date().toISOString(),
            dataPath: path.relative(process.cwd(), cfg.dataPath!),
            resultsPath: path.relative(process.cwd(), cfg.resultsPath!),
            candles: candles.length,
            activeOrders: Number.isFinite(cfg.activeOrders) ? cfg.activeOrders : 'all',
            feeRoundtripPct: cfg.feeRoundtripPct,
            btsCreateFee: cfg.btsCreateFee,
            btsCancelFee: cfg.btsCancelFee,
            makerCreateFactor: cfg.makerCreateFactor,
            txFeePrice: cfg.txFeePrice,
            btsFeeCapital: cfg.btsFeeCapital,
            search: {
                spreadValues: cfg.spreadValues,
                incrementValues: cfg.incrementValues,
                ratioValues: cfg.ratioValues,
                minSpreadFactor: cfg.minSpreadFactor,
                repositionPct: cfg.repositionPct,
                asymmetricBounds: cfg.asymmetricBounds,
                combosPerAma: totalCombos,
            },
            scoring: {
                baseScore: 'totalNetCaptureAfterFeesPct * (fillEfficiency / 100)',
                gridModel: 'persistent fixed chain prices (createOrderGrid port): master rail at sqrt(1±inc) offsets bounded by [center/ratio, center*ratio], gapSlots spread zone centered on center; prices never follow AMA after placement',
                spreadParam: 'targetSpreadPercent for calculateGapSlots (floored at increment * MIN_SPREAD_FACTOR)',
                resetTriggers: `(A) AMA drift >= ${cfg.repositionPct}% from recorded center (ratchet)${cfg.asymmetricBounds ? ` OR (B) |slope - slopeAtLastReset| >= ${slopeResetThresholdPct()}% over ${SLOPE_LOOKBACK_BARS}-bar average slope (baseline re-seeded on every reset)` : ' (trigger B gated off — asymmetricBounds whitelist)'}`,
                gridPriceOffset: cfg.asymmetricBounds ? 'slope-ratio offset applied to placement center (direction * min(|slope|/maxSlopePct,1) * targetSpread/2) on every grid build' : 'disabled (asymmetricBounds whitelist)',
                repositionAccounting: 'unfilled orders canceled + counted (incl armed refills/rebids); bought-and-held base carries across resets in a weighted-average-entry inventory pool (resync never market-sells); end-of-run inventory mark is informational and excluded from scoring',
                cycleEconomics: 'slot rotation: filled buy re-offers one rail step up; that refill selling books ~increment% minus round-trip fee and the freed quote re-bids one step down; unlinked initial-grid sells only execute against held inventory at weighted-average entry (no shorting)',
                totalGrossCapturePct: 'sum of realized per-rotation gross from actual fixed prices (linked rotations + inventory sales)',
                totalNetCapturePct: 'realized gross - roundtrip fee per completed disposition; excludes the end-of-run inventory mark',
                btsFees: `every order placement (initial grid + armed refills/rebids) pays maker create (${cfg.btsCreateFee}*${cfg.makerCreateFactor} BTS), every reset cancel pays ${cfg.btsCancelFee} BTS; btsFeePts = total BTS * txFeePrice / btsFeeCapital * 100 deducted from net before scoring`,
                warmup: 'getAmaWarmupBars(er, slow, 0, fast)',
                riskPenalty: `avgOpenDurationBars*${cfg.riskWDuration} + peakOpenOrders*${cfg.riskWPeakOpen} + avgImbalance*${cfg.riskWImbalance} + canceledOnReposition*${cfg.riskWCancel}`,
                finalScore: 'baseScore - riskPenalty',
            },
        },
        results: byAma,
    });

    console.log(`Saved: ${path.relative(process.cwd(), outPath)}`);
}

// Main-thread entry guard: importing this module (e.g. from the logic tests)
// must not execute the CLI run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run();
}

export { computeGapSlots, computeGridPriceOffsetPct, buildProductionGrid, simulateForParams };

'use strict';

import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { calculateAMA, getAmaWarmupBars } from '../../market_adapter/core/strategies/ama.js';
import { computeAmaSlopeEmaSeries } from '../../market_adapter/core/strategies/ama_slope_model.js';
import { normalizeAmaSlopeEmaAlpha } from '../../market_adapter/core/config_normalizers.js';
import { range } from '../math_utils.js';
import { runModuleWorker } from '../worker_pool.js';
import { loadLpData, fmt, loadAmaStrategies, consumeBacktestArg, slopeResetThresholdPct, DEFAULT_FEE_ROUNDTRIP_PCT, DEFAULT_MIN_SPREAD_FACTOR, DEFAULT_BTS_CREATE_FEE, DEFAULT_BTS_CANCEL_FEE, DEFAULT_BTS_MAKER_CREATE_FACTOR, DEFAULT_TX_FEE_PRICE, DEFAULT_REPOSITION_PCT, SLOPE_LOOKBACK_BARS } from './shared_utils.js';
import { getStorage } from '../../modules/storage/index.js';
import { PATHS } from '../../modules/paths.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
// Production grid geometry + slope-ratio offset — shared with bot_fitting so
// both tools build byte-identical grids for identical params (#12).
import { buildProductionGrid, computeGridPriceOffsetPct } from './backtest_bot_fitting.js';
const { writeJSON } = getStorage();

/**
 * AMA SWEEP BACKTEST — persistent grid simulation
 *
 * Models the real bot mechanics:
 *   - Orders sit at FIXED chain prices until canceled or filled
 *   - Slot rotation: a filled buy re-offers its base ONE RAIL STEP UP; when
 *     that refill sells, one increment (minus fees) is booked and the freed
 *     quote re-bids one rail step down — anchor-&-refill cycling
 *   - Unlinked (initial-grid) sells execute only against held inventory;
 *     bought-and-held base carries across resets as a weighted-average-entry
 *     position whose final mark is reported informationally, not scored
 *   - Order sizing depends on capital, ratio (range width), and weight profile
 *   - Three weight profiles: valley, neutral, mountain (symmetric buy/sell)
 *
 * Usage:
 *   node dist/analysis/bot_fitting/backtest_ama_sweep.js --data <path-to-lp-candles.json>
 *   node dist/analysis/bot_fitting/backtest_ama_sweep.js --data <path-to-lp-candles.json> --spread 4:16:1 --increment 0.5:4:0.25
 */

const DEFAULT_MAX_ORDERS = 20; // weight-profile sizing cap per side (search abstraction)
const DEFAULT_CAPITAL = 10000; // notional units per side

// Weight profiles (symmetric for both sides)
//   valley:   heavier at edges (outer levels), lighter near center
//   neutral:  equal across all levels
//   mountain: heavier near center, lighter at edges
const WEIGHT_PROFILES = {
    valley:   -0.8,   // negative = invert decay → outer levels get more
    neutral:   0,     // flat = equal distribution
    mountain:  1.5,   // strong decay → inner levels get more
};

// Search grid defaults — centered around bot defaults (spread=2%, increment=0.5%)
// Spread = targetSpreadPercent for the gapSlots spread zone (production
// semantics, matching bot_fitting — the legacy half-spread dead zone is gone).
// Increment = geometric rail step between successive orders on the same side.
const DEFAULT_SPREAD_VALUES = [...range(0.5, 4, 0.25), ...range(5, 12, 1)];
const DEFAULT_INCREMENT_VALUES = [...range(0.2, 2, 0.1), ...range(2.5, 8, 0.5)];
const DEFAULT_RATIO_VALUES = [1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 2, 3, 5, 10];

function parseArgs() {
    const args = process.argv.slice(2);
    const out: {
        dataPath: string | null;
        resultsPath: string | null;
        spreadValues: number[];
        incrementValues: number[];
        ratioValues: number[];
        maxOrders: number;
        feeRoundtripPct: number;
        minSpreadFactor: number;
        capital: number;
        repositionPct: number;
        asymmetricBounds: boolean;
        btsCreateFee: number;
        btsCancelFee: number;
        makerCreateFactor: number;
        txFeePrice: number;
        topN: number;
        lookbackBars: number | null;
        slopeEmaAlpha: number;
    } = {
        dataPath: null,
        resultsPath: null,
        spreadValues: DEFAULT_SPREAD_VALUES,
        incrementValues: DEFAULT_INCREMENT_VALUES,
        ratioValues: DEFAULT_RATIO_VALUES,
        maxOrders: DEFAULT_MAX_ORDERS,
        feeRoundtripPct: DEFAULT_FEE_ROUNDTRIP_PCT,
        minSpreadFactor: DEFAULT_MIN_SPREAD_FACTOR,
        capital: DEFAULT_CAPITAL,
        repositionPct: DEFAULT_REPOSITION_PCT,
        asymmetricBounds: false,
        btsCreateFee: DEFAULT_BTS_CREATE_FEE,
        btsCancelFee: DEFAULT_BTS_CANCEL_FEE,
        makerCreateFactor: DEFAULT_BTS_MAKER_CREATE_FACTOR,
        txFeePrice: DEFAULT_TX_FEE_PRICE,
        topN: 15,
        lookbackBars: null,
        slopeEmaAlpha: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--asymmetric-bounds') { out.asymmetricBounds = true; continue; }
        const val = args[i + 1];
        if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
        if (!val) continue;
        if (consumeBacktestArg(arg, val, out, {
            spreadValues: DEFAULT_SPREAD_VALUES,
            incrementValues: DEFAULT_INCREMENT_VALUES,
            ratioValues: DEFAULT_RATIO_VALUES,
        })) { i++; continue; }
        switch (arg) {
            case '--max-orders': out.maxOrders = Number(val); i++; break;
            case '--capital': out.capital = Number(val); i++; break;
            case '--top': out.topN = Number(val); i++; break;
            case '--lookback': out.lookbackBars = Math.max(1, Math.round(Number(val))); i++; break;
            case '--slope-ema-alpha': out.slopeEmaAlpha = Number(val); i++; break;
        }
    }
    if (!out.dataPath) {
        throw new Error('--data <path-to-lp-candles.json> is required');
    }
    if (!out.resultsPath) {
        throw new Error('--results <path-to-optimization-results.json> is required');
    }
    return out;
}

function printHelp() {
    console.log('AMA Sweep Backtest — persistent grid simulation with weight profiles');
    console.log('');
    console.log('Usage:');
    console.log('  node dist/analysis/bot_fitting/backtest_ama_sweep.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --data <path>           LP candle JSON');
    console.log('  --results <path>        AMA optimizer results JSON');
    console.log('  --spread <spec>         Target spread % (gapSlots zone): 1:10:0.5 or 2,4,8');
    console.log('  --increment <spec>      Increment values (%): 0.5:5:0.5 or 1,2,3');
    console.log('  --ratio <spec>          Max/min ratio: 1.5,2,3,5');
    console.log('  --max-orders <n>        Size cap per side (default: 20)');
    console.log('  --fee <pct>             Round-trip fee % (default: 0.20)');
    console.log('  --min-spread-factor <n> Spread >= factor * increment (default: 2.1)');
    console.log('  --capital <n>           Notional capital per side (default: 10000)');
    console.log('  --reposition <pct>      AMA drift % to trigger re-center (default: 1.00, production)');
    console.log('  --asymmetric-bounds     Enable slope-delta reset (B) + grid price offset (whitelist semantics)');
    console.log('  --bts-create-fee <n>    BTS create fee (default: 0.48260)');
    console.log('  --bts-cancel-fee <n>    BTS cancel fee (default: 0.00482)');
    console.log('  --maker-create-factor   Maker share of create fee (default: 0.10)');
    console.log('  --tx-fee-price <n>      Convert BTS fees into backtest units (default: 1.0)');
    console.log('  --top <n>               Show top N results (default: 15)');
    console.log(`  --lookback <bars>       Huber slope lookback override (default: ${SLOPE_LOOKBACK_BARS})`);
    console.log(`  --slope-ema-alpha <a>   Slope EMA alpha (default: ${MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA}, 1 = raw Huber)`);
}

interface AmaStrategy {
    id: string;
    name: string;
    er: number;
    fast: number;
    slow: number;
}

interface GridOrder {
    level: number;
    price: number;
    railIdx: number;
    cooldownUntil: number;
    size: number;
    [key: string]: unknown;
}

// ── Order sizing with weight profiles ────────────────────────────────────────

/**
 * Allocate capital across N levels using weight profile.
 *   weight > 0: mountain (more near center, exponential decay outward)
 *   weight = 0: neutral (equal)
 *   weight < 0: valley (more at edges, inverted decay)
 *
 * @param {number} totalFunds   Capital for this side
 * @param {number} n            Number of levels
 * @param {number} weight       Profile weight factor
 * @param {number} incrementFactor  Increment as fraction (e.g. 0.02 for 2%)
 * @returns {number[]}          Size per level, index 0 = closest to center
 */
function allocateFundsByWeights(totalFunds: number, n: number, weight: number, incrementFactor: number): number[] {
    if (n <= 0) return [];
    if (weight === 0) {
        const sz = totalFunds / n;
        return new Array(n).fill(sz);
    }

    const base = 1 - incrementFactor;
    const absWeight = Math.abs(weight);
    const raw = new Array(n);
    for (let i = 0; i < n; i++) {
        // i=0 is closest to center
        raw[i] = Math.pow(base, i * absWeight);
    }
    if (weight < 0) {
        // Valley: reverse so outer levels (high i) get the large weights
        raw.reverse();
    }
    const total = raw.reduce((s, w) => s + w, 0) || 1;
    return raw.map((w) => (w / total) * totalFunds);
}

// ── Persistent grid simulation ───────────────────────────────────────────────

/**
 * Build a fresh grid centered at `center` using the SHARED production
 * geometry (buildProductionGrid from backtest_bot_fitting — createOrderGrid
 * port): master rail at √(1±inc) offsets bounded by [center/ratio,
 * center*ratio] with a calculateGapSlots spread zone. This guarantees the
 * sweep and bot_fitting build byte-identical grids for identical params
 * (#12). Weight-profile sizing is applied over the capped nearest-to-gap
 * levels, index 0 = closest to the gap.
 *
 * Returns arrays of buy and sell order objects with fixed chain prices and sizes.
 */
function buildGrid(center: number, params: { incrementPct: number; maxMinRatio: number; maxOrders: number; spreadPct: number }, capitalPerSide: number, weightFactor: number) {
    const { incrementPct, maxMinRatio, maxOrders, spreadPct } = params;
    const built = buildProductionGrid(center, spreadPct, incrementPct, maxMinRatio, maxOrders);

    const buySizes = allocateFundsByWeights(capitalPerSide, built.buys.length, weightFactor, incrementPct);
    const sellSizes = allocateFundsByWeights(capitalPerSide, built.sells.length, weightFactor, incrementPct);

    // Level k = k-th slot from the gap on each side. Each placed slot also
    // carries its MASTER-RAIL index so rotation hops land on adjacent rail
    // nodes (live anchor-&-refill hop) instead of a flat ×(1+inc).
    const buys: GridOrder[] = built.buys.map((price: number, i: number) => {
        const k = built.buys.length - i;
        return { level: k, price, railIdx: built.buySliceStart + i, cooldownUntil: -1, size: buySizes[k - 1] || 0 };
    });
    const sells: GridOrder[] = built.sells.map((price: number, i: number) => ({
        level: i + 1, price, railIdx: built.sellStartIdx + i, cooldownUntil: -1, size: sellSizes[i] || 0,
    }));
    return { buys, sells, rail: built.rail };
}

/**
 * Mark the held inventory position to `markPrice` in capital units.
 *
 * Carried bags are a REAL risk the drawdown tracker should see bar-by-bar,
 * but their mark is informational for scoring: realized rotation profit plus
 * op fees drive netProfit, and the end-of-run position is reported separately
 * instead of being dumped into totals.
 */
function markInventoryAtPrice(inventory: { units: number; cost: number }, exitPrice: number, feeRoundtripPct: number) {
    if (!Number.isFinite(exitPrice) || exitPrice <= 0 || inventory.units <= 0) {
        return { grossUnits: 0, profitUnits: 0 };
    }
    const avgEntry = inventory.cost / inventory.units;
    const grossUnits = (exitPrice - avgEntry) * inventory.units;
    const feeUnits = avgEntry * inventory.units * ((feeRoundtripPct / 2) / 100);
    return { grossUnits, profitUnits: grossUnits - feeUnits };
}

type SimResult = ReturnType<typeof simulatePersistentGrid>;

interface SweepResult {
    strategy: AmaStrategy;
    best: SimResult | null;
    top5: SimResult[];
    allSims: SimResult[];
    evaluated: number;
}

interface RankedResult {
    strategy: AmaStrategy;
    sim: SimResult;
}

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
    size: number;
    railIdx: number;
    linkedBuyPrice: number | null;
    linkedEntryBar: number;
    cooldownUntil: number;
}

interface SimParams {
    spreadPct: number;
    incrementPct: number;
    maxMinRatio: number;
    maxOrders: number;
    feeRoundtripPct: number;
    capital: number;
    repositionThreshold: number;
    asymmetricBounds: boolean;
    btsCreateFee: number;
    btsCancelFee: number;
    makerCreateFactor: number;
    txFeePrice: number;
    warmupBars: number;
    lookbackBars: number;
    [key: string]: unknown;
}

function simulatePersistentGrid(candles: SimCandle[], amaValues: number[], params: SimParams, weightName: string, weightFactor: number) {
    const { spreadPct, incrementPct, maxMinRatio, feeRoundtripPct,
            capital, repositionThreshold, asymmetricBounds, btsCreateFee, btsCancelFee,
            makerCreateFactor, txFeePrice } = params;
    // Slope-delta persistence gate: follow the production default (constants)
    // unless the caller pins a value, so the sweep's reset path matches live
    // whenever asymmetricBounds enables trigger B.
    const slopePersistBarsRaw = Number(params.slopePersistBars);
    const slopePersistBars = Number.isFinite(slopePersistBarsRaw) && slopePersistBarsRaw >= 1
        ? Math.round(slopePersistBarsRaw)
        : (MARKET_ADAPTER.AMA_SLOPE_PERSIST_ENABLED === true && Number(MARKET_ADAPTER.AMA_SLOPE_PERSIST_BARS) >= 1
            ? Math.round(Number(MARKET_ADAPTER.AMA_SLOPE_PERSIST_BARS))
            : 1);
    // Warmup follows production AMA seeding/convergence (getAmaWarmupBars,
    // passed via params.warmupBars from sweepOneAma) instead of an arbitrary
    // fraction of the dataset. Direct callers that omit warmupBars fall back
    // to the legacy 10% cut.
    const warmupParam = Number.isFinite(params.warmupBars)
        ? params.warmupBars
        : Math.max(20, Math.floor(candles.length * 0.1));
    const skip = Math.min(warmupParam, Math.max(0, candles.length - 2));
    const capitalPerSide = capital;
    const makerCreateFeeBts = btsCreateFee * makerCreateFactor;
    const slopeDeltaThresholdPct = slopeResetThresholdPct();

    // First tradable bar: need a finite positive AMA to anchor the grid.
    let startIdx = Math.min(skip, candles.length - 1);
    let gridCenter = Number.NaN;
    for (let j = startIdx; j < candles.length; j++) {
        const v = amaValues[j];
        if (Number.isFinite(v) && v > 0) { gridCenter = v; startIdx = j; break; }
    }

    // Production AMA slope series (%/bar) — feeds trigger B and the grid price
    // offset when asymmetricBounds is on. The canonical Huber -> EMA replay
    // mirrors the slope the live adapter publishes; raw Huber diverges from
    // the live reset cadence. Lookback is overridable for research (params.lookbackBars);
    // production callers leave it unset and get the centralized constant.
    const slopeLookbackBars = Number.isFinite(params.lookbackBars) && params.lookbackBars >= 1
        ? Math.round(params.lookbackBars)
        : SLOPE_LOOKBACK_BARS;
    const erRaw = Number(params.erPeriod);
    const erPeriod = Number.isFinite(erRaw) && erRaw > 0 ? Math.ceil(erRaw) : 0;
    const slopeEmaAlpha = normalizeAmaSlopeEmaAlpha(params.slopeEmaAlpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
    const shapedSlopes = computeAmaSlopeEmaSeries(amaValues, erPeriod, slopeLookbackBars, slopeEmaAlpha);
    const slopeAt: (number | null)[] = new Array(candles.length).fill(null);
    for (let j = slopeLookbackBars; j < candles.length; j++) {
        const s = shapedSlopes[j];
        if (s != null && Number.isFinite(s)) slopeAt[j] = s;
    }

    // State — slot-rotation engine (mirrors simulateForParams in
    // backtest_bot_fitting, with weight-profile sized orders):
    // orders: id -> { side, price, size, linkedBuyPrice, linkedEntryBar,
    //                 cooldownUntil }. linkedBuyPrice != null marks an armed
    // refill sell created by a specific filled buy (one-increment rotation).
    const orders = new Map<number, SimOrder>();
    let nextOrderId = 0;
    // Bought-and-held base across the whole run (weighted-average entry pool).
    // Never negative — unfundable sells stay pending instead of shorting.
    const inventory = { units: 0, cost: 0 };
    const stepUpFrac = 1 + incrementPct; // one-rail-step rotation distance

    let btsFeesBts = 0;
    let offsetAppliedCount = 0;
    // Master rail of the CURRENT epoch — rotation hops read adjacent nodes.
    let activeRail: number[] = [];

    const placeInitialGrid = (center: number, slopePct: number | null) => {
        const offsetPct = (asymmetricBounds && slopePct != null)
            ? computeGridPriceOffsetPct(slopePct, spreadPct)
            : 0;
        if (offsetPct !== 0) offsetAppliedCount++;
        const effCenter = center * (1 + offsetPct / 100);
        const grid = buildGrid(effCenter, params, capitalPerSide, weightFactor);
        activeRail = grid.rail;
        orders.clear();
        for (const o of grid.buys) {
            orders.set(nextOrderId++, { side: 'buy', price: o.price, size: o.size, railIdx: o.railIdx, linkedBuyPrice: null, linkedEntryBar: -1, cooldownUntil: -1 });
        }
        for (const o of grid.sells) {
            orders.set(nextOrderId++, { side: 'sell', price: o.price, size: o.size, railIdx: o.railIdx, linkedBuyPrice: null, linkedEntryBar: -1, cooldownUntil: -1 });
        }
        btsFeesBts += (grid.buys.length + grid.sells.length) * makerCreateFeeBts;
    };

    if (Number.isFinite(gridCenter)) placeInitialGrid(gridCenter, slopeAt[startIdx]);
    let lastRepositionBar = startIdx;

    let matchedPairs = 0;
    let cyclesTotal = 0;
    let rotationCount = 0;       // linked ping-pong rotations (buy → refill sell)
    let inventorySaleCount = 0;  // unlinked sells executed against held bags
    let totalProfitUnits = 0; // REALIZED profit in capital units (size * netPct)
    let totalGrossUnits = 0;
    let touchedOrders = 0;
    let canceledOnReposition = 0;
    let repositionCount = 0;
    let driftTriggerCount = 0;
    let slopeTriggerCount = 0;
    let peakOpenOrders = 0;
    let imbalanceSum = 0;
    let imbalanceSamples = 0;
    let matchedOpenDurationBars = 0;
    let gridAgeSumBars = 0;
    let maxGridAgeBars = 0;
    let centerDriftSumPct = 0;
    let maxCenterDriftPct = 0;
    let nearThresholdBars = 0;
    let triggerDriftSumPct = 0;
    let runningProfit = 0;
    let peakEquityProfit = 0;
    let maxDrawdown = 0;
    // Track inventory risk: bought-and-held base, carried across resets —
    // resets never realize inventory (#4). Long-only (no unfunded shorts).
    let inventoryExposure = 0; // held base units (long-only, ≥ 0)
    let maxInventoryExposure = 0;

    const invAvgEntry = () => (inventory.units > 0 ? inventory.cost / inventory.units : 0);
    const liveBars = candles.length - startIdx - 1;
    const ordersPerSide = [...orders.values()].filter((o) => o.side === 'buy').length;

    // Slope-delta baseline: mirrors botState.gridRangeScalingAmaSlope —
    // seeded at bootstrap and re-seeded on every reset.
    let slopeBaseline: number | null = null;
    // Persistence-gate state for trigger B.
    let slopePersistCount = 0;
    let slopePersistDir = 0;
    for (let j = startIdx + 1; j < candles.length; j++) {
        if (slopeAt[j] != null) { slopeBaseline = slopeAt[j]; break; }
    }

    for (let i = startIdx + 1; i < candles.length; i++) {
        const ama = amaValues[i];
        const hi = candles[i].high;
        const lo = candles[i].low;
        const gridAgeBars = i - lastRepositionBar;

        // ── Reposition check: trigger A (AMA drift, ratchet) or trigger B
        //    (slope delta, only under the asymmetricBounds whitelist gate).
        const drift = Math.abs(ama - gridCenter) / gridCenter;
        const driftPct = drift * 100;
        centerDriftSumPct += driftPct;
        if (driftPct > maxCenterDriftPct) maxCenterDriftPct = driftPct;
        gridAgeSumBars += gridAgeBars;
        if (gridAgeBars > maxGridAgeBars) maxGridAgeBars = gridAgeBars;
        if (drift >= repositionThreshold * 0.5) nearThresholdBars++;

        let shouldReposition = drift >= repositionThreshold;
        if (shouldReposition) { triggerDriftSumPct += driftPct; driftTriggerCount++; }
        if (!shouldReposition && asymmetricBounds && slopeBaseline != null && slopeAt[i] != null) {
            const crossed = Math.abs(slopeAt[i]! - slopeBaseline) >= slopeDeltaThresholdPct;
            if (slopePersistBars <= 1) {
                if (crossed) { shouldReposition = true; slopeTriggerCount++; }
            } else if (!crossed) {
                slopePersistCount = 0;
                slopePersistDir = 0;
            } else {
                const dir = Math.sign(slopeAt[i]! - slopeBaseline);
                if (dir !== 0 && dir === slopePersistDir) slopePersistCount++;
                else { slopePersistDir = dir; slopePersistCount = 1; }
                if (slopePersistCount >= slopePersistBars) { shouldReposition = true; slopeTriggerCount++; }
            }
        }

        if (shouldReposition && Number.isFinite(ama) && ama > 0) {
            slopePersistCount = 0;
            slopePersistDir = 0;
            canceledOnReposition += orders.size;
            btsFeesBts += orders.size * btsCancelFee;
            orders.clear(); // inventory survives — resync never market-sells
            repositionCount++;
            // Re-center grid
            gridCenter = ama;
            if (slopeAt[i] != null) slopeBaseline = slopeAt[i];
            placeInitialGrid(gridCenter, slopeAt[i]);
            lastRepositionBar = i;
        }

        // ── Track imbalance & peak ──────────────────────────────────────
        const currentOpen = orders.size;
        if (currentOpen > peakOpenOrders) peakOpenOrders = currentOpen;
        let buyCountNow = 0;
        for (const [, o] of orders) { if (o.side === 'buy') buyCountNow++; }
        imbalanceSum += Math.abs(buyCountNow - (orders.size - buyCountNow));
        imbalanceSamples++;

        // ── Fill detection against FIXED chain prices ───────────────────
        const filledBuysThisBar: { id: number; order: SimOrder }[] = [];
        const filledSellsThisBar: { id: number; order: SimOrder }[] = [];
        for (const [id, o] of orders) {
            if (i < o.cooldownUntil || !(o.size > 0)) continue;
            if (o.side === 'buy' && lo <= o.price) filledBuysThisBar.push({ id, order: o });
            else if (o.side === 'sell' && hi >= o.price) filledSellsThisBar.push({ id, order: o });
        }
        touchedOrders += filledBuysThisBar.length + filledSellsThisBar.length;
        // Base held BEFORE this bar's intakes — unlinked sells may only
        // dispose against pre-existing funds (same-bar funding not assumed).
        const disposablesAtBarStart = inventory.units;

        // ── Buy intakes first: base enters the inventory pool, refill armed
        //    at the ADJACENT MASTER-RAIL NODE above (cooldown blocks same-bar).
        for (const fb of filledBuysThisBar) {
            orders.delete(fb.id);
            inventory.units += fb.order.size;
            inventory.cost += fb.order.price * fb.order.size;
            const upIdx = (fb.order.railIdx ?? -1) + 1;
            const refillPrice = activeRail[upIdx] ?? fb.order.price * stepUpFrac;
            orders.set(nextOrderId++, {
                side: 'sell',
                price: refillPrice,
                size: fb.order.size,
                railIdx: upIdx,
                linkedBuyPrice: fb.order.price,
                linkedEntryBar: i,
                cooldownUntil: i + 1,
            });
            btsFeesBts += makerCreateFeeBts;
        }

        // ── Sell disposals: linked refills book the one-rail-hop rotation;
        //     unlinked sells need held inventory. Linked resolve FIRST.
        filledSellsThisBar.sort((a, b) => ((a.order.linkedBuyPrice != null ? 0 : 1) - (b.order.linkedBuyPrice != null ? 0 : 1)));
        let disposables = disposablesAtBarStart;
        for (const fs of filledSellsThisBar) {
            const order = fs.order;
            const size = order.size;
            if (order.linkedBuyPrice != null) {
                const grossPct = (order.price / order.linkedBuyPrice - 1) * 100;
                const netPct = grossPct - feeRoundtripPct;
                totalGrossUnits += size * (grossPct / 100);
                totalProfitUnits += size * (netPct / 100);
                runningProfit += size * (netPct / 100);
                cyclesTotal++;
                rotationCount++;
                matchedPairs++;
                matchedOpenDurationBars += Math.abs(i - order.linkedEntryBar);
                // Dispose the base this rotation bought (at pool-average cost).
                const applied = Math.min(size, inventory.units);
                inventory.cost -= applied * invAvgEntry();
                inventory.units -= applied;
                // Its disposal also drains the pre-bar funding budget —
                // otherwise later unlinked sales could overspend stock.
                disposables -= applied;
                // Freed quote re-bids the ADJACENT RAIL NODE below.
                const downIdx = (order.railIdx ?? 0) - 1;
                const rebidPrice = activeRail[downIdx] ?? order.price / stepUpFrac;
                orders.delete(fs.id);
                orders.set(nextOrderId++, {
                    side: 'buy',
                    price: rebidPrice,
                    size,
                    railIdx: downIdx,
                    linkedBuyPrice: null,
                    linkedEntryBar: -1,
                    cooldownUntil: i + 1,
                });
                btsFeesBts += makerCreateFeeBts;
            } else if (disposables >= size - 1e-12) {
                const avgEntry = invAvgEntry();
                const grossPct = (order.price / avgEntry - 1) * 100;
                const netPct = grossPct - feeRoundtripPct;
                totalGrossUnits += size * (grossPct / 100);
                totalProfitUnits += size * (netPct / 100);
                runningProfit += size * (netPct / 100);
                cyclesTotal++;
                inventorySaleCount++;
                matchedPairs++;
                inventory.cost -= avgEntry * size;
                inventory.units -= size;
                disposables -= size;
                orders.delete(fs.id); // sold bag is gone; slot not re-armed
            } else {
                // Unfundable (not enough base): stays open, retries next bar.
                order.cooldownUntil = i + 1;
            }
        }

        // Track max inventory exposure (long-only)
        if (inventory.units > maxInventoryExposure) maxInventoryExposure = inventory.units;

        // ── Drawdown tracking ───────────────────────────────────────────
        // Realized equity only: carried bags are reported informationally and
        // excluded from scoring, so their (unbounded, balance-free) marks must
        // not distort the risk term either. Bag risk stays visible via
        // finalInventoryUnits / finalInventoryMarkUnits.
        const equityProfit = runningProfit;
        if (equityProfit > peakEquityProfit) peakEquityProfit = equityProfit;
        const dd = peakEquityProfit - equityProfit;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // ── End-of-run inventory mark (informational, NOT in profit) ────────
    // Bought-and-held base is real carried risk but unrealized bag marks are
    // excluded from netProfit/scoring so trend combos can't dump phantom
    // paper profit into the objective. Drawdown likewise tracks REALIZED
    // equity only; bag risk stays visible through these info fields.
    inventoryExposure = inventory.units;
    const lastClose = candles.length > 0 ? candles[candles.length - 1].close : NaN;
    const finalInventoryMark = markInventoryAtPrice(inventory, lastClose, feeRoundtripPct);

    const fillEfficiency = touchedOrders > 0 ? (cyclesTotal / touchedOrders) * 100 : 0;
    const pairsPerDay = liveBars > 0 ? matchedPairs / (liveBars / 24) : 0;
    const avgOpenDurationBars = rotationCount > 0 ? matchedOpenDurationBars / rotationCount : 0;
    const avgImbalance = imbalanceSamples > 0 ? imbalanceSum / imbalanceSamples : 0;
    const avgProfitPerPair = matchedPairs > 0 ? totalProfitUnits / matchedPairs : 0;
    const profitPerCapital = capital > 0 ? totalProfitUnits / (capital * 2) : 0; // total capital = 2 sides
    const maxDrawdownPct = capital > 0 ? (maxDrawdown / (capital * 2)) * 100 : 0;
    const avgGridAgeBars = liveBars > 0 ? gridAgeSumBars / liveBars : 0;
    const avgCenterDriftPct = liveBars > 0 ? centerDriftSumPct / liveBars : 0;
    const nearThresholdBarsPct = liveBars > 0 ? (nearThresholdBars / liveBars) * 100 : 0;
    const avgTriggerDriftPct = repositionCount > 0 ? triggerDriftSumPct / repositionCount : 0;
    const avgCancelOrdersPerReposition = repositionCount > 0 ? canceledOnReposition / repositionCount : 0;
    // Exact BTS fee totals (creates + cancels + per-cycle refills), not an
    // estimate — the live bot pays the same per-op fees.
    const totalRepositionFeesBts = btsFeesBts;
    const feePerDayBts = liveBars > 0 ? totalRepositionFeesBts / (liveBars / 24) : 0;
    const estimatedFeePerRepositionBts = repositionCount > 0 ? totalRepositionFeesBts / repositionCount : 0;
    const totalRepositionFeeUnits = totalRepositionFeesBts * txFeePrice;
    const netProfitUnits = totalProfitUnits - totalRepositionFeeUnits;
    const netProfitPerCapital = capital > 0 ? netProfitUnits / (capital * 2) : 0;

    // Score: profit per capital scaled by activity (log pairs to avoid pure frequency chasing)
    const activityBonus = matchedPairs > 0 ? Math.log10(matchedPairs) : null;
    const grossScore = activityBonus == null ? -Infinity : (profitPerCapital * 100 * activityBonus - maxDrawdownPct * 0.5);
    const netScore = activityBonus == null ? -Infinity : (netProfitPerCapital * 100 * activityBonus - maxDrawdownPct * 0.5);
    const score = netScore;

    return {
        weightName,
        spreadPct,
        incrementPct: incrementPct * 100, // store as %
        maxMinRatio,
        matchedPairs,
        cyclesTotal,
        rotationCount,
        inventorySaleCount,
        touchedOrders,
        fillEfficiency,
        totalProfitUnits,
        totalGrossUnits,
        finalInventoryUnits: inventoryExposure,
        finalInventoryAvgEntry: inventory.units > 0 ? inventory.cost / inventory.units : 0,
        finalInventoryMarkUnits: finalInventoryMark.profitUnits, // informational
        profitPerCapital,
        pairsPerDay,
        avgOpenDurationBars,
        avgProfitPerPair,
        peakOpenOrders,
        avgImbalance,
        canceledOnReposition,
        repositionCount,
        driftTriggerCount,
        slopeTriggerCount,
        maxDrawdown,
        maxDrawdownPct,
        maxInventoryExposure,
        avgGridAgeBars,
        maxGridAgeBars,
        avgCenterDriftPct,
        maxCenterDriftPct,
        nearThresholdBarsPct,
        avgTriggerDriftPct,
        offsetAppliedCount,
        makerCreateFeeBts,
        btsCancelFee,
        avgCancelOrdersPerReposition,
        estimatedFeePerRepositionBts,
        totalRepositionFeesBts,
        feePerDayBts,
        netProfitUnits,
        netProfitPerCapital,
        ordersPerSide,
        grossScore,
        netScore,
        score,
    };
}

// ── Per-AMA sweep logic (runs in main thread or worker) ─────────────────────

function sweepOneAma(strategy: AmaStrategy, candles: SimCandle[], closes: number[], weightEntries: [string, number][], cfg: ReturnType<typeof parseArgs>) {
    const amaValues = calculateAMA(closes, { erPeriod: strategy.er, fastPeriod: strategy.fast, slowPeriod: strategy.slow });
    // Production-aligned warmup: ER window + convergence (getAmaWarmupBars).
    const warmupBars = getAmaWarmupBars(strategy.er, strategy.slow, 0, strategy.fast);
    let best: SimResult | null = null;
    const top5: SimResult[] = [];
    const allSims: SimResult[] = [];
    let evaluated = 0;
    const minSpreadFactor = Number.isFinite(cfg.minSpreadFactor) && cfg.minSpreadFactor > 0 ? cfg.minSpreadFactor : null;

    for (const spreadPct of cfg.spreadValues) {
        for (const incrementPctRaw of cfg.incrementValues) {
            if (spreadPct < cfg.feeRoundtripPct + 0.01) continue;
            if (minSpreadFactor != null && spreadPct < (incrementPctRaw * minSpreadFactor)) continue;
            for (const maxMinRatio of cfg.ratioValues) {
                for (const [weightName, weightFactor] of weightEntries) {
                    evaluated++;
                    const sim = simulatePersistentGrid(candles, amaValues, {
                        spreadPct,
                        incrementPct: incrementPctRaw / 100,
                        maxMinRatio,
                        maxOrders: cfg.maxOrders,
                        feeRoundtripPct: cfg.feeRoundtripPct,
                        capital: cfg.capital,
                        repositionThreshold: cfg.repositionPct / 100,
                        asymmetricBounds: cfg.asymmetricBounds,
                        erPeriod: strategy.er,
                        slopeEmaAlpha: cfg.slopeEmaAlpha,
                        btsCreateFee: cfg.btsCreateFee,
                        btsCancelFee: cfg.btsCancelFee,
                        makerCreateFactor: cfg.makerCreateFactor,
                        txFeePrice: cfg.txFeePrice,
                        warmupBars,
                        lookbackBars: cfg.lookbackBars as number,
                    }, weightName, weightFactor);

                    if (!best || sim.score > best.score) best = sim;

                    if (sim.matchedPairs > 0) {
                        const t5key = `${sim.spreadPct}|${sim.incrementPct}|${sim.maxMinRatio}|${sim.weightName}`;
                        const existing = top5.findIndex((t) =>
                            `${t.spreadPct}|${t.incrementPct}|${t.maxMinRatio}|${t.weightName}` === t5key);
                        if (existing < 0) {
                            top5.push(sim);
                            top5.sort((a, b) => b.score - a.score);
                            if (top5.length > 5) top5.length = 5;
                        }
                        allSims.push(sim);
                    }
                }
            }
        }
    }

    return { strategy, best, top5, allSims, evaluated };
}

// ── Worker thread handler ───────────────────────────────────────────────────

if (!isMainThread) {
    const { strategy, candles, closes, weightEntries, cfg } = workerData;
    const result = sweepOneAma(strategy, candles, closes, weightEntries, cfg);
    parentPort!.postMessage(result);
    // Exit naturally: an explicit process.exit(0) here can race the
    // postMessage flush and silently drop the result (same pattern as
    // optimizer_high_resolution.ts workers, which exit on their own).
}

// ── Parallel dispatch (main thread) ─────────────────────────────────────────

function runParallel(strategies: AmaStrategy[], candles: SimCandle[], closes: number[], weightEntries: [string, number][], cfg: ReturnType<typeof parseArgs>): Promise<SweepResult[]> {
    const numCpus = Math.min(os.cpus().length, strategies.length);
    console.log(`  Workers:      ${numCpus} threads (${os.cpus().length} CPUs available)\n`);

    return Promise.all(strategies.map((strategy) => {
        return runModuleWorker<SweepResult>(import.meta.url, { strategy, candles, closes, weightEntries, cfg }, {
            resolveOn: (msg) => ({ done: true, value: msg as SweepResult }),
        });
    }));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
    const cfg = parseArgs();

    const loaded = loadLpData(cfg.dataPath!);
    const candles = loaded.candles;
    const closes = candles.map((c) => (c as { close: number }).close);
    const strategies = loadAmaStrategies(cfg.resultsPath!, { sort: true });

    const weightEntries = Object.entries(WEIGHT_PROFILES);
    const totalCombos = cfg.spreadValues.length * cfg.incrementValues.length *
        cfg.ratioValues.length * weightEntries.length;

    console.log('================================================================================');
    console.log(' AMA SWEEP BACKTEST — persistent grid + weight profiles');
    console.log('================================================================================');
    console.log(`  Data:         ${path.basename(cfg.dataPath!)} (${candles.length} candles, ~${(candles.length / 24).toFixed(0)} days)`);
    console.log(`  AMAs:         ${strategies.map((s) => s.id).join(', ')}`);
    console.log(`  Weights:      ${weightEntries.map(([n, w]) => `${n}(${w})`).join(', ')}`);
    console.log(`  Spread:       ${cfg.spreadValues[0]}..${cfg.spreadValues[cfg.spreadValues.length - 1]}% (${cfg.spreadValues.length})`);
    console.log(`  Increment:    ${cfg.incrementValues[0]}..${cfg.incrementValues[cfg.incrementValues.length - 1]}% (${cfg.incrementValues.length})`);
    console.log(`  Ratio:        ${cfg.ratioValues[0]}..${cfg.ratioValues[cfg.ratioValues.length - 1]} (${cfg.ratioValues.length})`);
    console.log(`  Max orders:   ${cfg.maxOrders}/side (size cap) | Capital: ${cfg.capital}/side | Fee: ${cfg.feeRoundtripPct}%`);
    console.log(`  Spread floor: > fee (${cfg.feeRoundtripPct}%)`);
    console.log(`  Reset (A):    ${cfg.repositionPct}% AMA drift from grid center (ratchet)`);
    console.log(`  Asym. bounds: ${cfg.asymmetricBounds ? 'ON — slope reset (B) + grid price offset enabled (whitelist semantics)' : 'OFF — typical non-whitelisted bot (production default)'}`);
    console.log(`  Reset (B):    |slope - slope@lastReset| >= ${fmt(slopeResetThresholdPct(), 4)}% (lookback ${cfg.lookbackBars ?? SLOPE_LOOKBACK_BARS}, ema ${normalizeAmaSlopeEmaAlpha(cfg.slopeEmaAlpha)})${cfg.asymmetricBounds ? '' : ' [gated off]'}`);
    console.log(`  Tx model:     create=${fmt(cfg.btsCreateFee, 5)} BTS, cancel=${fmt(cfg.btsCancelFee, 5)} BTS, maker=${fmt(cfg.makerCreateFactor * 100, 1)}%, 1 BTS=${fmt(cfg.txFeePrice, 2)} units`);
    console.log(`  Combos/AMA:   ${totalCombos}  |  Total: ${totalCombos * strategies.length}\n`);

    // ── Run AMA sweeps in parallel (one worker per AMA strategy) ──────
    const byAma: SweepResult[] = [];
    const allResults: RankedResult[] = [];

    const workerResults = await runParallel(strategies, candles, closes, weightEntries, cfg);

    for (const wr of workerResults) {
        byAma.push(wr);
        for (const sim of wr.allSims) {
            allResults.push({ strategy: wr.strategy, sim });
        }
        const b = wr.best;
        const bestLabel = b && b.matchedPairs > 0
            ? `score=${fmt(b.score, 1)} pairs=${b.matchedPairs} net/cap=${fmt(b.netProfitPerCapital * 100, 1)}% gross=${fmt(b.profitPerCapital * 100, 1)}%`
            : 'no fills';
        process.stdout.write(`  ${wr.strategy.id} (ER=${wr.strategy.er}, F=${wr.strategy.fast}, S=${wr.strategy.slow}): ${wr.evaluated} combos, ${bestLabel}\n`);
    }

    // ── Per-AMA best ────────────────────────────────────────────────────────
    console.log('\n================================================================================');
    console.log(' BEST PARAMS PER AMA');
    console.log('================================================================================');
    console.log('AMA   | wt    | spr%  | inc%  | ratio | nOrd |  pairs | net/cap | gross/cap | drift | fee/d | score');
    console.log('------+-------+-------+-------+-------+------+--------+---------+-----------+-------+-------+------');
    for (const row of byAma) {
        const b = row.best;
        if (!b || b.matchedPairs === 0) {
            console.log(`${row.strategy.id.padEnd(5)} | (no fills)`);
            continue;
        }
        console.log(
            `${row.strategy.id.padEnd(5)} | ` +
            `${b.weightName.padEnd(5)} | ` +
            `${fmt(b.spreadPct, 1).padStart(5)} | ` +
            `${fmt(b.incrementPct, 1).padStart(5)} | ` +
            `${fmt(b.maxMinRatio, 2).padStart(5)} | ` +
            `${String(b.ordersPerSide).padStart(4)} | ` +
            `${String(b.matchedPairs).padStart(6)} | ` +
            `${fmt(b.netProfitPerCapital * 100, 2).padStart(7)}% | ` +
            `${fmt(b.profitPerCapital * 100, 2).padStart(10)}% | ` +
            `${fmt(b.avgCenterDriftPct, 2).padStart(5)}% | ` +
            `${fmt(b.feePerDayBts, 2).padStart(5)} | ` +
            `${fmt(b.score, 1).padStart(6)}`
        );
    }

    // ── Top 5 per AMA ───────────────────────────────────────────────────────
    for (const row of byAma) {
        if (row.top5.length === 0) continue;
        console.log(`\n  ${row.strategy.id} — Top 5:`);
        console.log('  # | wt    | spr%  | inc%  | ratio | nOrd |  pairs | net/cap | drift | gAge | fee/d | score');
        console.log('  --+-------+-------+-------+-------+------+--------+---------+-------+------+-------+------');
        row.top5.forEach((b: SimResult, idx: number) => {
            console.log(
                `  ${idx + 1} | ` +
                `${b.weightName.padEnd(5)} | ` +
                `${fmt(b.spreadPct, 1).padStart(5)} | ` +
                `${fmt(b.incrementPct, 1).padStart(5)} | ` +
                `${fmt(b.maxMinRatio, 2).padStart(5)} | ` +
                `${String(b.ordersPerSide).padStart(4)} | ` +
                `${String(b.matchedPairs).padStart(6)} | ` +
                `${fmt(b.netProfitPerCapital * 100, 2).padStart(7)}% | ` +
                `${fmt(b.avgCenterDriftPct, 2).padStart(5)}% | ` +
                `${fmt(b.avgGridAgeBars, 0).padStart(4)} | ` +
                `${fmt(b.feePerDayBts, 2).padStart(5)} | ` +
                `${fmt(b.score, 1).padStart(6)}`
            );
        });
    }

    // ── Global ranking (deduplicated) ───────────────────────────────────────
    allResults.sort((a, b) => b.sim.score - a.sim.score);
    const seen = new Set();
    const deduped: RankedResult[] = [];
    for (const r of allResults) {
        const key = `${r.strategy.id}|${r.sim.spreadPct}|${r.sim.incrementPct}|${r.sim.maxMinRatio}|${r.sim.weightName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(r);
    }

    if (deduped.length === 0) {
        console.log('\n  NO CONFIGURATIONS PRODUCED ANY MATCHED PAIRS.');
        return;
    }

    const topN = Math.min(cfg.topN, deduped.length);
    console.log(`\n================================================================================`);
    console.log(` GLOBAL TOP ${topN}`);
    console.log('================================================================================');
    console.log('#  | AMA   | wt    | spr%  | inc%  | ratio | nOrd |  pairs | net/cap | drift | fee/d | score');
    console.log('---+-------+-------+-------+-------+-------+------+--------+---------+-------+-------+------');
    for (let i = 0; i < topN; i++) {
        const { strategy, sim } = deduped[i];
        console.log(
            `${String(i + 1).padStart(2)} | ` +
            `${strategy.id.padEnd(5)} | ` +
            `${sim.weightName.padEnd(5)} | ` +
            `${fmt(sim.spreadPct, 1).padStart(5)} | ` +
            `${fmt(sim.incrementPct, 1).padStart(5)} | ` +
            `${fmt(sim.maxMinRatio, 2).padStart(5)} | ` +
            `${String(sim.ordersPerSide).padStart(4)} | ` +
            `${String(sim.matchedPairs).padStart(6)} | ` +
            `${fmt(sim.netProfitPerCapital * 100, 2).padStart(7)}% | ` +
            `${fmt(sim.avgCenterDriftPct, 2).padStart(5)}% | ` +
            `${fmt(sim.feePerDayBts, 2).padStart(5)} | ` +
            `${fmt(sim.score, 1).padStart(6)}`
        );
    }

    // ── Winner ──────────────────────────────────────────────────────────────
    const winner = deduped[0];
    console.log(`\n================================================================================`);
    console.log(` WINNER`);
    console.log('================================================================================');
    console.log(`  AMA:         ${winner.strategy.id} (ER=${winner.strategy.er}, Fast=${winner.strategy.fast}, Slow=${winner.strategy.slow})`);
    console.log(`  Weight:      ${winner.sim.weightName} (${WEIGHT_PROFILES[winner.sim.weightName as keyof typeof WEIGHT_PROFILES]})`);
    console.log(`  Spread:      ${fmt(winner.sim.spreadPct, 1)}%`);
    console.log(`  Increment:   ${fmt(winner.sim.incrementPct, 1)}%`);
    console.log(`  Ratio:       ${fmt(winner.sim.maxMinRatio, 1)}x`);
    console.log(`  Pairs:       ${winner.sim.matchedPairs} (${fmt(winner.sim.pairsPerDay, 2)}/day)`);
    console.log(`  Fill eff:    ${fmt(winner.sim.fillEfficiency, 1)}%`);
    console.log(`  Profit/cap:  gross ${fmt(winner.sim.profitPerCapital * 100, 2)}% | net ${fmt(winner.sim.netProfitPerCapital * 100, 2)}%`);
    console.log(`  Net profit:  ${fmt(winner.sim.netProfitUnits, 0)} units after ${fmt(winner.sim.totalRepositionFeesBts, 1)} BTS reposition fees`);
    console.log(`  Avg/pair:    ${fmt(winner.sim.avgProfitPerPair, 2)} units`);
    console.log(`  Max DD:      ${fmt(winner.sim.maxDrawdownPct, 2)}%`);
    console.log(`  Repositions: ${winner.sim.repositionCount}`);
    console.log(`  Grid age:    avg ${fmt(winner.sim.avgGridAgeBars, 1)} bars | max ${fmt(winner.sim.maxGridAgeBars, 0)} bars`);
    console.log(`  Drift:       avg ${fmt(winner.sim.avgCenterDriftPct, 2)}% | max ${fmt(winner.sim.maxCenterDriftPct, 2)}% | near-threshold ${fmt(winner.sim.nearThresholdBarsPct, 1)}%`);
    console.log(`  Tx burn:     ${fmt(winner.sim.estimatedFeePerRepositionBts, 4)} BTS/reposition | ${fmt(winner.sim.feePerDayBts, 2)} BTS/day (exact per-op totals)`);
    console.log(`  Cycles:      ${winner.sim.cyclesTotal} rotations (${winner.sim.rotationCount} rail-step + ${winner.sim.inventorySaleCount} inventory sales)`);
    console.log(`  Carried:     ${fmt(winner.sim.finalInventoryUnits, 4)} base @ ${fmt(winner.sim.finalInventoryAvgEntry, 6)} avg (mark ${fmt(winner.sim.finalInventoryMarkUnits, 2)} units — info only, not scored)`);
    console.log(`  Score:       ${fmt(winner.sim.score, 2)}`);

    // ── Save JSON ───────────────────────────────────────────────────────────
    const outName = `ama_sweep_results_${path.basename(cfg.dataPath!, '.json')}.json`;
    const outPath = path.join(PATHS.ANALYSIS.RESULTS_DIR, outName);
    writeJSON(outPath, {
        meta: {
            generatedAt: new Date().toISOString(),
            dataPath: path.relative(process.cwd(), cfg.dataPath!),
            resultsPath: path.relative(process.cwd(), cfg.resultsPath!),
            candles: candles.length,
            days: candles.length / 24,
            maxOrders: cfg.maxOrders,
            capitalPerSide: cfg.capital,
            feeRoundtripPct: cfg.feeRoundtripPct,
            repositionPct: cfg.repositionPct,
            asymmetricBounds: cfg.asymmetricBounds,
            btsCreateFee: cfg.btsCreateFee,
            btsCancelFee: cfg.btsCancelFee,
            makerCreateFactor: cfg.makerCreateFactor,
            txFeePrice: cfg.txFeePrice,
            weightProfiles: WEIGHT_PROFILES,
            search: {
                spreadValues: cfg.spreadValues,
                incrementValues: cfg.incrementValues,
                ratioValues: cfg.ratioValues,
                minSpreadFactor: cfg.minSpreadFactor,
                combosPerAma: totalCombos,
                totalCombos: totalCombos * strategies.length,
            },
            scoring: 'netProfitPerCapital * 100 * log10(max(1, matchedPairs)) - maxDrawdownPct * 0.5',
            gridModel: 'production createOrderGrid port (shared with bot_fitting): master rail sqrt(1±inc) + gapSlots spread zone; slot rotation (filled buy re-offers one rail step up, freed quote re-bids one step down, ~increment% per completed rotation); unlinked sells execute only against held inventory at weighted-average entry; bought base carries across resets and the end-of-run inventory mark is informational (excluded from scoring); exact per-op BTS fees',
        },
        strategies,
        perAma: byAma.map((row) => ({
            strategy: row.strategy,
            evaluated: row.evaluated,
            best: row.best,
            top5: row.top5,
        })),
        globalTop: deduped.slice(0, Math.max(cfg.topN, 20)).map(({ strategy, sim }) => ({
            ama: strategy.id,
            amaParams: { er: strategy.er, fast: strategy.fast, slow: strategy.slow },
            ...sim,
        })),
        winner: {
            ama: winner.strategy.id,
            amaParams: { er: winner.strategy.er, fast: winner.strategy.fast, slow: winner.strategy.slow },
            ...winner.sim,
        },
    });

    console.log(`\nSaved: ${path.relative(process.cwd(), outPath)}`);
}

// Main-thread only: workers inherit process.argv[1], so the entry guard alone
// would also match inside workers and re-run main() there.
if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch((err) => { console.error(err); process.exit(1); });
}

export { WEIGHT_PROFILES, allocateFundsByWeights, buildGrid, simulatePersistentGrid, sweepOneAma }


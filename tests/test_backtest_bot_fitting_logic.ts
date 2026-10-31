const assert = require('assert');
const { MARKET_ADAPTER } = require('../modules/constants');

console.log('Running backtest bot fitting logic tests');

const {
    computeGapSlots,
    computeGridPriceOffsetPct,
    buildProductionGrid,
    simulateForParams,
} = require('../analysis/bot_fitting/backtest_bot_fitting');

function approx(actual, expected, tol = 1e-6, msg = '') {
    assert.ok(
        Math.abs(actual - expected) <= tol,
        `${msg}: expected ${expected}, got ${actual}`
    );
}


function makeCandle(close, high = close, low = close) {
    return { timestamp: 0, open: close, high, low, close, volume: 1 };
}
// Quiet bar: body never reaches the rails or their rotation hops
// (B1=98.5038, U1=99.4987, initial sell=101.5037).
function quiet() { return { timestamp: 0, open: 100, high: 99.4, low: 99.0, close: 100, volume: 1 }; }

// ── Rail geometry constants (center 100, inc 1%, ratio 2) ────────────────────
// Master-rail nodes adjacent to the gap (odd exponent = sqrt-half-steps):
const B1 = 100 * Math.pow(0.99, 1.5);   // nearest buy below the gap
const U1 = 100 * Math.pow(0.99, 0.5);   // rail node directly above B1
const D2 = 100 * Math.pow(0.99, 2.5);   // rail node directly below B1
// Down-chain hop B1 -> U1 equals exactly one down-step inverse:
const ROTATION_GROSS_PCT = (U1 / B1 - 1) * 100;

// ── calculateGapSlots port ────────────────────────────────────────────────────
{
    // increment=0.5%, target spread=2% -> steps=ceil(ln(1.02)/ln(1.005))=4 -> gap=3
    assert.strictEqual(computeGapSlots(0.5, 2), 3, 'wide spread maps to slot count');
    // Floor: effective spread clamps up to increment * MIN_SPREAD_FACTOR (2.1)
    assert.strictEqual(computeGapSlots(0.5, 0.2), 2, 'spread floor clamps to MIN_SPREAD_ORDERS');
}

// ── createOrderGrid geometry port (master rail + centered gap) ───────────────
{
    const { buys, sells } = buildProductionGrid(100, 2, 0.01, 2, 3);
    // Rail: sqrt-step offsets around center; even 2-slot gap centered on 100
    // absorbs the first slot on EACH side, so the nearest tradeable pair sits
    // at ±increment^1.5 offsets (one down-slot + one up-slot held as spread).
    assert.strictEqual(buys.length, 3);
    assert.strictEqual(sells.length, 3);
    approx(buys[2], B1, 1e-6, 'nearest buy');
    approx(buys[1], D2, 1e-6, 'second buy');
    approx(sells[0], 100 * Math.pow(1.01, 1.5), 1e-6, 'nearest sell');
    approx(sells[1], 100 * Math.pow(1.01, 2.5), 1e-6, 'second sell');
}

{
    // Ratio bounds tighter than one step -> empty rails -> degenerate grid
    const { buys, sells } = buildProductionGrid(100, 2, 0.01, 1.001, 3);
    assert.strictEqual(buys.length, 0, 'no buy fits inside a sub-step ratio bound');
    assert.strictEqual(sells.length, 0, 'no sell fits inside a sub-step ratio bound');
}

{
    // Default cap = Infinity: every rail slot in bounds is sized (production
    // createOrderGrid behavior, #14). Ratio 2 / inc 1% yields dozens per side.
    const { buys, sells } = buildProductionGrid(100, 2, 0.01, 2, Infinity);
    assert.ok(buys.length > 20, 'unlimited cap sizes all rail slots');
    assert.ok(sells.length > 20, 'unlimited cap sizes all rail slots');
}

// ── computeGridPriceOffsetPct (service.ts:92-119 port) ───────────────────────
{
    const maxSlopePct = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
    approx(computeGridPriceOffsetPct(maxSlopePct, 2), 1, 1e-6, 'full-strength slope -> half spread');
    approx(computeGridPriceOffsetPct(-maxSlopePct / 2, 2), -0.5, 1e-6, 'half-strength down slope');
    approx(computeGridPriceOffsetPct(maxSlopePct / 9, 2), 0.111111, 1e-6, 'sub-strength slope scaled by ratio');
    assert.strictEqual(computeGridPriceOffsetPct(0, 2), 0, 'zero slope stays neutral');
    assert.strictEqual(computeGridPriceOffsetPct(NaN, 2), 0, 'non-finite slope -> no offset');
}

// ── Simulation base params ────────────────────────────────────────────────────
const RISK = { duration: 0, peakOpen: 0, imbalance: 0, cancel: 0 };
function simParams(extra = {}) {
    return {
        spreadPct: 2,
        incrementPct: 0.01,
        maxMinRatio: 2,
        activeOrders: 1,
        feeRoundtripPct: 0.2,
        repositionThresholdPct: 1,
        asymmetricBounds: false,
        btsCreateFee: 0,
        btsCancelFee: 0,
        makerCreateFactor: 0,
        txFeePrice: 0,
        btsFeeCapital: 10000,
        warmupBars: 0,
        risk: RISK,
        ...extra,
    };
}

// ── Fixed chain prices: fills happen at placement-time prices, grid does not ─
// follow AMA while drift stays below the reset threshold.
{
    const candles = Array.from({ length: 10 }, () => quiet());
    candles[3] = makeCandle(100, 100, 98.4); // wick touches nearest buy (B1)
    const amaValues = new Array(10).fill(100);

    const r = simulateForParams(candles, amaValues, simParams());
    assert.strictEqual(r.touchedOrders, 1, 'only the wick-touched buy fills');
    assert.strictEqual(r.matchedPairs, 0, 'refill never fills (flat candles)');
    assert.strictEqual(r.repositionCount, 0, 'flat AMA never triggers a reset');
    assert.strictEqual(r.inventoryUnits, 1, 'bought base is held as inventory');
    assert.strictEqual(r.totalNetCapturePct, 0, 'nothing realized without a completed rotation');
}

// ── Trigger A: AMA drift >= threshold cancels live orders and CARRIES the ────
// bought base; realized capture stays empty — inventory mark is informational.
{
    const candles = Array.from({ length: 10 }, () => makeCandle(98, 98.42, 97.95));
    candles[0] = makeCandle(100);
    candles[1] = makeCandle(100);
    candles[2] = makeCandle(100);
    candles[3] = makeCandle(100, 100, 98.4);  // buy fills @ B1
    candles[4] = makeCandle(98, 98.42, 97.95); // AMA drops 2% -> drift reset
    const amaValues = new Array(10).fill(100);
    for (let i = 4; i < 10; i++) amaValues[i] = 98; // AMA stays down post-reset

    const r = simulateForParams(candles, amaValues, simParams({
        activeOrders: 3,
    }));
    assert.strictEqual(r.driftTriggerCount, 1, 'drift trigger fires once');
    assert.strictEqual(r.slopeTriggerCount, 0, 'slope trigger silent (asymmetricBounds off)');
    assert.strictEqual(r.repositionCount, 1);
    assert.strictEqual(r.offsetAppliedCount, 0, 'no offset without asymmetricBounds');
    // Unfilled cancels at reset: leftover initial buys (2) + initial sells (3)
    // + the armed refill sell created by the filled buy = 6.
    assert.strictEqual(r.canceledOnReposition, 6, 'all live orders incl armed refills are canceled');
    // Nothing realized mid-run or after — carried bag is informational only.
    assert.strictEqual(r.totalNetCapturePct, 0, 'resync never liquidates at AMA (no forced PnL)');
    assert.strictEqual(r.inventoryUnits, 1, 'carried base survives the reset');
    const invNetExpected = ((98 / B1) - 1) * 100 - 0.1;
    approx(r.inventoryNetPts, invNetExpected, 1e-3, 'inventory mark vs avg entry with single-leg exit fee');
}

// ── Trigger B: slope moving away from the last-reset baseline (whitelist-gated) ──
{
    // The slope is the HUBER regression of ln(AMA) over the window, so a
    // single-step AMA reads as ~0%/bar and the fixture is flat -> a steady
    // geometric ramp -> flat at the new level. The fitted slope ramps 0 -> +r
    // over ~one window, holds at +r while the series climbs, then decays to 0.
    //
    // The ratchet baseline is re-seeded on every reset, so a monotonic slope
    // move of total |delta| fires ~|delta|/gate times. Keeping r (0.01 %/bar)
    // between one and two gates (gate = 0.0072 %/bar) makes the onset and decay
    // crossings single: 1 at onset, 1 at decay, silent while it holds.
    const n = 100;
    const rampFrom = 20, rampTo = 59, perBarPct = 0.01;
    const candles = Array.from({ length: n }, () => makeCandle(100));
    const amaValues = new Array(n).fill(100);
    for (let i = rampFrom; i <= rampTo; i++) amaValues[i] = 100 * Math.pow(1 + perBarPct / 100, i - rampFrom + 1);
    for (let i = rampTo + 1; i < n; i++) amaValues[i] = amaValues[rampTo];

    const r = simulateForParams(candles, amaValues, simParams({
        repositionThresholdPct: 50, // drift can never fire; isolate slope path
        asymmetricBounds: true,
        // Isolate the raw slope trigger; production gates it (default K=3).
        slopePersistBars: 1,
    }));
    assert.strictEqual(r.driftTriggerCount, 0, 'drift trigger disabled by huge threshold');
    assert.strictEqual(r.slopeTriggerCount, 2, 'fires once on slope onset and once on decay (smooth regression)');
    assert.strictEqual(r.repositionCount, 2);
    assert.strictEqual(r.offsetAppliedCount, 2, 'both crossings apply the asymmetric offset: unlike the old step, the smooth fit reads a non-neutral slope at the decay bar');
}

// ── Trigger B stays OFF without the whitelist gate (production default) ─────
{
    const n = 80;
    const candles = Array.from({ length: n }, () => makeCandle(100));
    const amaValues = new Array(n).fill(100);
    for (let i = 20; i <= 41; i++) amaValues[i] = 100 * Math.pow(1 + (1 / 9) / 100, i - 20 + 1);

    const r = simulateForParams(candles, amaValues, simParams({ repositionThresholdPct: 50 }));
    assert.strictEqual(r.slopeTriggerCount, 0, 'non-whitelisted bot: slope reset gated off');
    assert.strictEqual(r.repositionCount, 0, 'no resets at all without the gate');
}

// ── Rotation economics (#15): a filled buy re-offers the ADJACENT rail node ──
// above; when that sells, one rail hop minus the RT fee is booked and the
// freed quote re-bids the node below.
{
    const lift = makeCandle(100, 99.62, 99.4); // crosses U1 (99.4987) only
    const candles = Array.from({ length: 10 }, () => quiet());
    candles[3] = makeCandle(100, 100, 98.4);   // buy fills @ B1
    candles[4] = lift;                         // refill sells @ U1 -> rotation
    const amaValues = new Array(10).fill(100);

    const r = simulateForParams(candles, amaValues, simParams());
    assert.strictEqual(r.matchedPairs, 1);
    assert.strictEqual(r.rotationCount, 1, 'linked ping-pong rotation');
    assert.strictEqual(r.inventorySaleCount, 0);
    assert.strictEqual(r.inventoryUnits, 0, 'rotation disposes its own unit');
    approx(r.totalGrossCapturePct, ROTATION_GROSS_PCT, 1e-4, 'gross is one master-rail hop (B1 -> U1)');
    approx(r.avgNetPerPair, ROTATION_GROSS_PCT - 0.2, 1e-4, 'net subtracts round-trip fee only');
    assert.strictEqual(r.avgOpenDurationBars, 1, 'rotation duration spans the two fill bars');
}

// ── Anchor-&-refill cycling (#1/#2): the rebid/rearm pair keeps cycling ──────
// between resets, booking the same rail hop each oscillation.
{
    const dip = makeCandle(100, 100, 98.4);    // buy fills @ B1
    const lift = makeCandle(100, 99.62, 99.4); // refill @ U1 fills
    const candles = Array.from({ length: 10 }, () => quiet());
    candles[3] = dip;                          // buy #1 @ B1
    candles[4] = lift;                         // refill @ U1 -> rotation 1
    candles[5] = dip;                          // freed quote re-bids B1, fills again
    candles[6] = lift;                         // -> rotation 2
    const amaValues = new Array(10).fill(100);

    const r = simulateForParams(candles, amaValues, simParams());
    assert.strictEqual(r.rotationCount, 2, 'slot cycles twice between resets');
    assert.strictEqual(r.cyclesTotal, 2);
    assert.strictEqual(r.touchedOrders, 4, 'four leg fills across two rotations');
    approx(r.totalGrossCapturePct, ROTATION_GROSS_PCT * 2, 1e-4, 'both rotations book the same rail hop');
    approx(r.totalNetCapturePct, (ROTATION_GROSS_PCT - 0.2) * 2, 1e-4, 'two round trips netted');
}

// ── Same-bar guards: no intra-bar recycles and no same-bar-funded sales ──────
{
    const candles = Array.from({ length: 10 }, () => quiet());
    candles[3] = makeCandle(100, 102, 97);  // bar spans BOTH initial legs
    const amaValues = new Array(10).fill(100);

    const r = simulateForParams(candles, amaValues, simParams());
    assert.strictEqual(r.touchedOrders, 2, 'both legs touched once');
    assert.strictEqual(r.cyclesTotal, 0, 'armed refill blocked by cooldown; unlinked sale blocked until next bar');
    assert.strictEqual(r.inventorySaleCount, 0, 'unlinked sell cannot dispose same-bar-bought base');
    assert.strictEqual(r.inventoryUnits, 1, 'bought base held');
}

// ── Unfundable initial-grid sells never short: upside touch without base ─────
{
    const candles = Array.from({ length: 10 }, () => quiet());
    candles[5] = makeCandle(100, 102, 99.4); // touches nearest initial sell only
    const amaValues = new Array(10).fill(100);

    const r = simulateForParams(candles, amaValues, simParams());
    assert.strictEqual(r.touchedOrders, 1, 'sell fill detected');
    assert.strictEqual(r.inventorySaleCount, 0, 'no base to sell -> not executed');
    assert.strictEqual(r.totalNetCapturePct, 0, 'no phantom short profit');
    assert.strictEqual(r.inventoryUnits, 0, 'and nothing was bought either');
}

// ── BTS operation fees: creations charged per placement (initial grid + armed ─
// refills + rebids), resets charge cancel fees.
{
    const candles = Array.from({ length: 10 }, () => quiet());
    candles[3] = makeCandle(100, 100, 98.4);
    candles[4] = makeCandle(100, 99.62, 99.4); // rotation -> refill + rebid creates
    const amaValues = new Array(10).fill(100);

    const r = simulateForParams(candles, amaValues, simParams({
        activeOrders: 2,
        btsCreateFee: 1,
        btsCancelFee: 1,
        makerCreateFactor: 0.5,
        txFeePrice: 1,
        btsFeeCapital: 10000,
    }));
    // Initial placement: 2 buys + 2 sells = 4 creates @ 0.5; then one rotation
    // arms a refill sell (+1 create) and its freed quote re-bid (+1 create).
    approx(r.btsFeesBts, (4 + 2) * 0.5, 1e-6, 'create fees for initial grid + refill + rebid');
    approx(r.btsFeePts, (6 * 0.5) / 10000 * 100, 1e-6, 'bts fees converted to pp against reference capital');
    assert.strictEqual(r.canceledOnReposition, 0, 'no resets -> no cancel fees');
}

// ── End-of-run inventory is informational: realized totals stay clean ────────
{
    const candles = Array.from({ length: 10 }, () => quiet());
    candles[3] = makeCandle(100, 100, 98.4);
    candles[candles.length - 1] = makeCandle(98, 97.9, 97.8); // ends below entry
    const amaValues = new Array(10).fill(100);

    const r = simulateForParams(candles, amaValues, simParams({
        repositionThresholdPct: 50,
    }));
    assert.strictEqual(r.matchedPairs, 0);
    assert.strictEqual(r.totalNetCapturePct, 0, 'unrealized bag mark excluded from realized capture');
    assert.strictEqual(r.inventoryUnits, 1, 'held unit reported');
    const invNetExpected = ((98 / B1) - 1) * 100 - 0.1;
    approx(r.inventoryNetPts, invNetExpected, 1e-3, 'informational mark with single-leg fee');
}

console.log('backtest bot fitting logic tests passed');

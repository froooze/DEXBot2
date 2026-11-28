const assert = require('assert');

console.log('Running backtest AMA sweep logic tests');

const {
    simulatePersistentGrid,
    sweepOneAma,
} = require('../analysis/bot_fitting/backtest_ama_sweep');

function makeCandle(close, high = close, low = close) {
    return { timestamp: 0, open: close, high, low, close, volume: 1 };
}
// Quiet bar around 100 that never reaches rails or their rotation hops
// (B1=98.5038, U1=99.4987, initial sell=101.5037).
function quiet() { return { timestamp: 0, open: 100, high: 99.4, low: 99.0, close: 100, volume: 1 }; }

// Rail geometry (center 100, inc 1%): nearest buy B1, adjacent rail node U1.
const B1 = 100 * Math.pow(0.99, 1.5);
const U1 = 100 * Math.pow(0.99, 0.5);
const ROTATION_GROSS_PCT = (U1 / B1 - 1) * 100; // one down-chain hop

function baseParams(extra = {}) {
    return {
        spreadPct: 2,
        incrementPct: 0.01,
        maxMinRatio: 2,
        maxOrders: 3,
        feeRoundtripPct: 0.2,
        capital: 10000,
        repositionThreshold: 0.05,
        btsCreateFee: 0,
        btsCancelFee: 1,
        makerCreateFactor: 0,
        txFeePrice: 0,
        warmupBars: 0,
        ...extra,
    };
}

// Reposition should CARRY bought base across the reset (production resync
// never market-sells); realized profit stays clean — the carried position is
// reported informationally and every live order (incl armed refills) pays a
// cancel fee.
{
    const candles = Array.from({ length: 23 }, () => quiet());
    candles[21] = makeCandle(100, 100, 98); // fills nearest buy (B1)
    candles[22] = makeCandle(90, 89.5, 89); // AMA plunge -> drift reset

    const amaValues = new Array(23).fill(100);
    amaValues[22] = 90;

    const result = simulatePersistentGrid(candles, amaValues, baseParams(), 'neutral', 0);

    assert.strictEqual(result.matchedPairs, 0, 'scenario should not produce rotations');
    assert.strictEqual(result.repositionCount, 1, 'scenario should force one reposition');
    // Leftover initial buys (2) + initial sells (3) + armed refill sell = 6
    assert.strictEqual(result.canceledOnReposition, 6, 'all live orders incl armed refills are canceled');
    assert.strictEqual(result.avgCancelOrdersPerReposition, 6);
    assert.strictEqual(result.totalRepositionFeesBts, 6, 'cancel fees only for live orders (exact per-op totals)');
    assert.strictEqual(result.totalProfitUnits, 0, 'carried bags are NOT realized into totals');
    assert.ok(result.finalInventoryUnits > 0, 'bought base carried across the reset');
    assert.ok(result.finalInventoryMarkUnits < 0, 'informational mark at final close is negative below entry');
}

// Drawdown should reflect unrealized losses on held inventory even before any
// reposition, while realized totals stay clean.
{
    const candles = Array.from({ length: 23 }, () => quiet());
    candles[21] = makeCandle(100, 100, 98); // fills nearest buy (B1)
    candles[22] = makeCandle(90, 89.5, 89); // market-only plunge (no AMA trigger)

    const amaValues = new Array(23).fill(100);

    const result = simulatePersistentGrid(candles, amaValues, baseParams({
        repositionThreshold: 0.5,
        btsCancelFee: 0,
    }), 'neutral', 0);

    assert.strictEqual(result.repositionCount, 0, 'scenario should avoid repositioning');
    assert.strictEqual(result.totalProfitUnits, 0, 'leftover inventory is informational only');
    assert.ok(result.finalInventoryUnits > 0, 'held bag reported');
    assert.ok(result.finalInventoryMarkUnits < 0, 'mark to final close is negative below entry');
    assert.strictEqual(result.maxDrawdown, 0, 'realized-only equity: no trades -> no drawdown');
}

// Slot rotation: a filled buy re-offers the ADJACENT rail node above; that
// refill selling books one rail hop minus fees and the freed quote re-bids —
// the pair keeps cycling between resets on small oscillations.
{
    const dip = makeCandle(100, 100, 98.4);   // buy fills @ B1
    const lift = makeCandle(100, 99.62, 99.4); // refill @ U1 fills
    const candles = Array.from({ length: 12 }, () => quiet());
    candles[1] = dip;
    candles[2] = lift;                        // -> rotation 1
    candles[3] = dip;                         // rebid fills @ B1 again
    candles[4] = lift;                        // -> rotation 2
    const amaValues = new Array(12).fill(100);

    const params = baseParams({
        maxOrders: 1,
        repositionThreshold: 0.5,
        btsCancelFee: 0,
    });
    const result = simulatePersistentGrid(candles, amaValues, params, 'neutral', 0);

    assert.strictEqual(result.rotationCount, 2, 'slot cycles twice between resets');
    assert.strictEqual(result.cyclesTotal, 2);
    assert.strictEqual(result.inventorySaleCount, 0);
    assert.strictEqual(result.touchedOrders, 4, 'four leg fills across two rotations');
    // Each rotation books the same rail hop with weight-profile sizing.
    const size = result.totalGrossUnits / ((ROTATION_GROSS_PCT / 100) * 2);
    const expectedNet = size * ((ROTATION_GROSS_PCT - 0.2) / 100) * 2;
    assert.ok(result.totalProfitUnits > 0, 'rotations realize positive profit');
    assert.ok(
        Math.abs(result.totalProfitUnits - expectedNet) < Math.abs(expectedNet) * 1e-6 + 1e-9,
        `realized net matches rail-hop economics: ${result.totalProfitUnits} vs ${expectedNet}`
    );
}

// Same-bar guards in the sized sim too: no intra-bar recycles, no same-bar-
// funded inventory sales.
{
    const candles = Array.from({ length: 12 }, () => quiet());
    candles[3] = makeCandle(100, 102, 97); // bar spans both initial legs
    const amaValues = new Array(12).fill(100);

    const result = simulatePersistentGrid(candles, amaValues, baseParams({
        maxOrders: 1,
        repositionThreshold: 0.5,
        btsCancelFee: 0,
    }), 'neutral', 0);

    assert.strictEqual(result.touchedOrders, 2, 'both legs touched once');
    assert.strictEqual(result.cyclesTotal, 0, 'no same-bar disposition');
    assert.ok(result.finalInventoryUnits > 0, 'bought base held');
}

// minSpreadFactor should filter out invalid spread/increment combinations before simulation.
{
    const candles = Array.from({ length: 40 }, () => makeCandle(100));
    const closes = candles.map((c) => c.close);

    const result = sweepOneAma(
        { id: 'TEST', name: 'TEST', er: 2, fast: 2, slow: 10 },
        candles,
        closes,
        [['neutral', 0]],
        {
            spreadValues: [1],
            incrementValues: [1],
            ratioValues: [2],
            maxOrders: 1,
            feeRoundtripPct: 0.2,
            capital: 1000,
            repositionPct: 5,
            btsCreateFee: 0,
            btsCancelFee: 0,
            makerCreateFactor: 0,
            txFeePrice: 0,
            minSpreadFactor: 2,
        }
    );

    assert.strictEqual(result.evaluated, 0, 'spread/increment pairs below minSpreadFactor should be skipped');
    assert.strictEqual(result.best, null, 'no invalid combinations should be simulated');
    assert.deepStrictEqual(result.allSims, [], 'skipped combinations should not produce results');
}

// ── Trigger B mirrors production's EMA-shaped slope (not raw Huber) ──────────
{
    const n = 120, rampFrom = 30, rampTo = 70, perBarPct = 1;
    const candles = Array.from({ length: n }, () => quiet());
    const amaValues = new Array(n).fill(100);
    for (let i = rampFrom; i <= rampTo; i++) amaValues[i] = 100 * Math.pow(1 + perBarPct / 100, i - rampFrom + 1);
    for (let i = rampTo + 1; i < n; i++) amaValues[i] = amaValues[rampTo];
    const params = baseParams({
        asymmetricBounds: true,
        slopePersistBars: 1,
    });
    const raw = simulatePersistentGrid(candles, amaValues, { ...params, slopeEmaAlpha: 1 }, 'neutral', 0);
    const shaped = simulatePersistentGrid(candles, amaValues, params, 'neutral', 0);
    assert.ok(raw.slopeTriggerCount > 0, 'the fixture should cross the slope gate');
    assert.notStrictEqual(
        shaped.slopeTriggerCount,
        raw.slopeTriggerCount,
        'production EMA smoothing must change the slope-reset cadence vs raw Huber'
    );
}

console.log('backtest AMA sweep logic tests passed');
process.exit(0);

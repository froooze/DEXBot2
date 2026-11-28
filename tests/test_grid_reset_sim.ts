const assert = require('assert');

console.log('Running grid-reset simulation tests');

const {
    simulateGridResetSeries,
    gridSimSlopeSignal,
    GRID_RESET_NONE,
    GRID_RESET_BOOTSTRAP,
    GRID_RESET_PRICE,
    GRID_RESET_SLOPE,
} = require('../analysis/tradingview/grid_reset_sim');
const { computeAverageAmaSlopePct } = require('../market_adapter/core/strategies/dynamic_weight_series');

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
    try {
        fn();
        passed++;
    } catch (err: any) {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
}

// Price-trigger-only config (slope trigger off): isolates trigger A.
const PRICE_CFG = {
    priceDeltaThresholdPercent: 1,
    slopeDeltaThresholdPercent: 0.0072,
    slopeEnabled: false,
    erPeriod: 1,
    warmupBars: 0,
    lookbackBars: 1,
    maxSlopePct: 0.09,
    neutralZonePct: 0,
    maxSlopeOffset: 0.5,
    clipPercentile: 0,
    // These fixtures assert raw-Huber numbers; keep the EMA off. Production
    // charts supply the resolved 0.2 through payload.gridSim.emaAlpha.
    emaAlpha: 1,
};

function reasonsAt(sim: any, indices: number[]) {
    return indices.map((i) => sim.reason[i]);
}

// ── Bootstrap ────────────────────────────────────────────────
check('first finite AMA bar is the bootstrap snapshot, nothing else', () => {
    const sim = simulateGridResetSeries([null, null, 100, 100, 100], PRICE_CFG);
    assert.deepStrictEqual(reasonsAt(sim, [0, 1, 2, 3, 4]), [
        GRID_RESET_NONE, GRID_RESET_NONE, GRID_RESET_BOOTSTRAP, GRID_RESET_NONE, GRID_RESET_NONE,
    ]);
    assert.strictEqual(sim.stats.resets, 0, 'bootstrap is not counted as a delta reset');
    assert.strictEqual(sim.stats.priceResets, 0);
    assert.strictEqual(sim.stats.bootstrapIndex, 2);
    assert.strictEqual(sim.center[4], 100);
    assert.strictEqual(sim.center[1], null, 'no accepted center before the first snapshot');
});

check('empty input returns aligned empty series instead of throwing', () => {
    const sim = simulateGridResetSeries([], PRICE_CFG);
    assert.strictEqual(sim.center.length, 0);
    assert.deepStrictEqual(sim.events, []);
    assert.strictEqual(sim.stats.lastResetIndex, null);
});

// ── Trigger A: AMA price delta (ratchet) ─────────────────────
check('price drift at/over the threshold recenters, below it does not', () => {
    // +0.5 % (no reset), +1.0 % (at the threshold → reset), +0.9 % (no reset).
    const sim = simulateGridResetSeries([100, 100.5, 101, 101, 101.9, 102.9], PRICE_CFG);
    assert.strictEqual(sim.reason[0], GRID_RESET_BOOTSTRAP);
    assert.strictEqual(sim.reason[1], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[2], GRID_RESET_PRICE, 'drift >= threshold fires');
    assert.strictEqual(sim.reason[3], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[4], GRID_RESET_NONE, 'measured against the NEW baseline');
    assert.strictEqual(sim.reason[5], GRID_RESET_PRICE);
    assert.strictEqual(sim.stats.priceResets, 2);
    assert.strictEqual(sim.stats.resets, 2);
});

check('center ratchets to the AMA at the reset and stays there', () => {
    const sim = simulateGridResetSeries([100, 100.5, 101, 101, 101.9, 102.9], PRICE_CFG);
    assert.deepStrictEqual(sim.center, [100, 100, 101, 101, 101, 102.9]);
    assert.strictEqual(sim.events[1].previousCenter, 100);
    assert.strictEqual(sim.events[1].center, 101);
    assert.ok(Math.abs(sim.events[1].deltaPct - 1) < 1e-9);
    assert.strictEqual(sim.stats.lastResetIndex, 5);
    assert.strictEqual(sim.stats.barsSinceLastReset, 0);
    assert.strictEqual(sim.stats.avgBarsBetweenResets, 2.5);
});

check('a disabled/non-positive price threshold never fires trigger A', () => {
    const sim = simulateGridResetSeries([100, 200, 400], { ...PRICE_CFG, priceDeltaThresholdPercent: 0 });
    assert.strictEqual(sim.stats.priceResets, 0);
    assert.deepStrictEqual(sim.reason, [GRID_RESET_BOOTSTRAP, GRID_RESET_NONE, GRID_RESET_NONE]);
    assert.deepStrictEqual(sim.center, [100, 100, 100]);
});

check('non-finite AMA bars neither reset nor clear the accepted center', () => {
    const sim = simulateGridResetSeries([100, 100.5, null, NaN, 130], PRICE_CFG);
    assert.strictEqual(sim.reason[2], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[3], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[4], GRID_RESET_PRICE);
    assert.strictEqual(sim.center[3], 100, 'carried over the NaN bar');
});

// ── Trigger B: AMA slope delta ───────────────────────────────
const SLOPE_CFG = {
    ...PRICE_CFG,
    // Wide price threshold so only the slope trigger can fire.
    priceDeltaThresholdPercent: 1000,
    slopeDeltaThresholdPercent: 0.1,
    slopeEnabled: true,
    clipPercentile: 0,
};

function slopePctOf(series: any[], index: number, lookbackBars = 1) {
    return computeAverageAmaSlopePct(series[index], series[index - lookbackBars], lookbackBars);
}

// A geometric series gives an EXACT per-bar slope of `r` %
// (computeAverageAmaSlopePct = (cur - past) / past * 100 / lookback).
function geometric(start: number, perBarPct: number, count: number) {
    const out = [];
    let v = start;
    for (let i = 0; i < count; i++) { out.push(v); v = v * (1 + perBarPct / 100); }
    return out;
}

check('slope delta fires when the average per-bar slope moves past the threshold', () => {
    // +0.05 %/bar, then +0.2 %/bar: |Δ| = 0.15 >= 0.1 → slope reset.
    const ama = [100, 100.05, 100.1, 100.15, 100.35, 100.55, 100.75];
    // warmupBars 2 so the bootstrap lands on a bar whose slope is already
    // ready (erPeriod + lookbackBars = 2): the runtime seeds the accepted slope
    // baseline at the first accepted snapshot.
    const cfg = { ...SLOPE_CFG, lookbackBars: 1, erPeriod: 1, warmupBars: 2 };
    assert.ok(Math.abs(slopePctOf(ama, 2) - 0.05) < 0.001, 'sanity: ~0.05 %/bar in the calm leg');
    const calm = simulateGridResetSeries(geometric(100, 0.05, 6), { ...cfg, slopeDeltaThresholdPercent: 0.1 });
    assert.strictEqual(calm.stats.slopeResets, 0, 'a constant slope never drifts from its baseline');
    const sim = simulateGridResetSeries(ama, cfg);
    assert.strictEqual(sim.reason[2], GRID_RESET_BOOTSTRAP);
    assert.strictEqual(sim.reason[3], GRID_RESET_NONE, 'baseline seeded at 0.05 %/bar');
    assert.strictEqual(sim.reason[4], GRID_RESET_SLOPE);
    assert.strictEqual(sim.stats.slopeResets, 1);
    assert.ok(Math.abs(sim.slopeDeltaPct[4] - 0.1497) < 0.001, 'delta = |slope now − accepted baseline|');
    assert.strictEqual(sim.center[6], 100.35, 'the center stays at the last accepted value');
    assert.strictEqual(sim.center[3], 100.1, 'the center stays on the accepted snapshot until a reset');
    assert.strictEqual(sim.center[4], 100.35, 'the slope reset ratcheted the center to the AMA');
});

check('slope resets are suppressed when the bot is not range-scaling whitelisted', () => {
    const ama = [100, 100.05, 100.1, 100.15, 100.35, 100.55, 100.75];
    const sim = simulateGridResetSeries(ama, { ...SLOPE_CFG, lookbackBars: 1, erPeriod: 1, warmupBars: 2, slopeEnabled: false });
    assert.strictEqual(sim.stats.slopeResets, 0);
    assert.strictEqual(sim.stats.slopeTriggerArmed, false);
    assert.deepStrictEqual(sim.reason, [0, 0, GRID_RESET_BOOTSTRAP, 0, 0, 0, 0]);
});

check('a non-positive slope threshold disarms trigger B', () => {
    const ama = [100, 100.05, 100.1, 100.15, 100.35, 100.55, 100.75];
    const sim = simulateGridResetSeries(ama, { ...SLOPE_CFG, lookbackBars: 1, erPeriod: 1, warmupBars: 2, slopeDeltaThresholdPercent: 0 });
    assert.strictEqual(sim.stats.slopeResets, 0);
});

check('the price trigger is evaluated first and re-seeds the slope baseline', () => {
    // A constant 0.2 %/bar slope with a hair-trigger price threshold: every bar
    // resets on price, and the slope baseline is re-seeded to that same slope
    // each time, so trigger B can never fire.
    const cfg = { ...SLOPE_CFG, lookbackBars: 1, erPeriod: 1, priceDeltaThresholdPercent: 0.001 };
    const sim = simulateGridResetSeries(geometric(100, 0.2, 6), cfg);
    assert.ok(sim.stats.priceResets >= 3, 'price trigger fires on every bar');
    assert.strictEqual(sim.stats.slopeResets, 0, 'the re-seeded slope baseline blocks trigger B');
    for (let i = 0; i < sim.center.length; i++) {
        assert.ok(sim.acceptedSlopePct[i] == null || Math.abs(sim.acceptedSlopePct[i] - Math.log(1.002) * 100) < 1e-9);
    }
    assert.ok(Math.abs(sim.slopeDeltaPct[4]) < 1e-9, 'measured against the bar it was seeded from');
});

check('the accepted slope baseline survives a reset whose slope is not ready', () => {
    // Slope readiness needs erPeriod + lookbackBars bars of history. Right after
    // a reset at index 1 the next bar has no slope yet, so the baseline must be
    // kept (advanceTriggeredBotState's `amaSlope || previous` chain).
    const cfg = { ...SLOPE_CFG, erPeriod: 4, lookbackBars: 2, warmupBars: 0 };
    const ama = [null, 100, 100.02, 100.04, 100.06, 100.5, 100.9];
    const sim = simulateGridResetSeries(ama, cfg);
    // No slope is ready before index erPeriod + lookbackBars = 6, so the slope
    // trigger cannot fire at all and the price baseline stays at 100.02...
    assert.strictEqual(sim.reason[2], GRID_RESET_NONE);
    assert.strictEqual(sim.slopePct[5], null, 'slope not ready yet');
    assert.ok(Number.isFinite(sim.slopePct[6]));
});

// ── Warmup gate + center clamp ───────────────────────────────
check('bars before the warmup gate carry no accepted center', () => {
    const sim = simulateGridResetSeries([100, 130, 200, 400], { ...PRICE_CFG, warmupBars: 2 });
    assert.strictEqual(sim.reason[0], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[1], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[2], GRID_RESET_BOOTSTRAP, 'first post-warmup AMA is the snapshot');
    assert.strictEqual(sim.reason[3], GRID_RESET_PRICE);
    assert.strictEqual(sim.stats.warmupBars, 2);
});

check('absolute bounds pin the accepted center (clampGridPriceToBounds)', () => {
    const sim = simulateGridResetSeries([100, 130, 200], { ...PRICE_CFG, clampMin: 90, clampMax: 150 });
    assert.deepStrictEqual(sim.center, [100, 130, 150]);
    assert.strictEqual(sim.events[2].center, 150, 'the 200 AMA is clamped into the bot bounds');
    assert.ok(Math.abs(sim.events[2].previousCenter - 130) < 1e-9);
});

check('drift is measured against the clamped center, so an AMA beyond the bound resets once', () => {
    // The runtime compares clamp(AMA) with the accepted center. Once the
    // center is pinned at maxP, drift collapses to zero instead of growing —
    // no per-bar reset markers while price sits outside an absolute range.
    const sim = simulateGridResetSeries([100, 200, 300, 400], { ...PRICE_CFG, clampMin: 90, clampMax: 150 });
    assert.strictEqual(sim.stats.priceResets, 1, 'only the bar that first moved the clamped center fires');
    assert.deepStrictEqual(sim.reason, [GRID_RESET_BOOTSTRAP, GRID_RESET_PRICE, GRID_RESET_NONE, GRID_RESET_NONE]);
    assert.deepStrictEqual(sim.center, [100, 150, 150, 150]);
    assert.ok(Math.abs(sim.driftPct[2]) < 1e-9, 'drift against the pinned center is zero');
});

check('one-sided absolute bounds clamp only their side (mixed config)', () => {
    // minPrice absolute, maxPrice "Nx"/none: the runtime floors the center at
    // min but the relative max never binds, so only the floor applies.
    const sim = simulateGridResetSeries([100, 50, 40, 200], { ...PRICE_CFG, clampMin: 60, clampMax: null });
    assert.deepStrictEqual(sim.center, [100, 60, 60, 200]);
    assert.strictEqual(sim.stats.priceResets, 2, 'bootstrap floor move then the rise out of the floor');
    assert.ok(Math.abs(sim.driftPct[2]) < 1e-9, 'same clamped floor means zero drift');
});

// ── Accepted slope signal (range tilt input) ─────────────────
check('accepted trend/offset come from the clipped slope, frozen between resets', () => {
    // Warmup gate at bar 2 so the bootstrap already has a ready slope
    // (slope needs erPeriod + lookbackBars = 2 bars of history).
    const cfg = { ...SLOPE_CFG, priceDeltaThresholdPercent: 1000, maxSlopePct: 0.09, maxSlopeOffset: 0.5, neutralZonePct: 0, lookbackBars: 1, erPeriod: 1, warmupBars: 2 };
    // +0.2 %/bar over maxSlopePct 0.09 saturates the offset at +0.5.
    const ama = geometric(100, 0.2, 7);
    const sim = simulateGridResetSeries(ama, cfg);
    assert.strictEqual(sim.reason[0], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[1], GRID_RESET_NONE);
    assert.strictEqual(sim.reason[2], GRID_RESET_BOOTSTRAP);
    assert.strictEqual(sim.acceptedTrend[2], 'UP');
    assert.ok(Math.abs(sim.acceptedSlopeOffset[2] - 0.5) < 1e-9);
    for (let i = 3; i < ama.length; i++) {
        assert.strictEqual(sim.acceptedTrend[i], 'UP', 'frozen until the next reset');
        assert.ok(Math.abs(sim.acceptedSlopeOffset[i] - 0.5) < 1e-9);
    }
});

check('a slope inside the neutral zone stays NEUTRAL with zero offset', () => {
    const cfg = { ...SLOPE_CFG, priceDeltaThresholdPercent: 1000, neutralZonePct: 0.5, maxSlopePct: 0.09, lookbackBars: 1, erPeriod: 1, warmupBars: 2 };
    const sim = simulateGridResetSeries(geometric(100, 0.2, 6), cfg);
    assert.strictEqual(sim.acceptedTrend[2], null);
    assert.strictEqual(sim.acceptedSlopeOffset[2], 0);
});

check('EMA alpha shapes the replayed slope series', () => {
    const cfg = { ...SLOPE_CFG, maxSlopePct: 0.09, lookbackBars: 1, erPeriod: 1, warmupBars: 2 };
    // A spike in the middle of a calm ramp: raw slope jumps, EMA damps it.
    const calm = geometric(100, 0.05, 9);
    const spiked = calm.slice();
    spiked[5] = spiked[4] * 1.02;
    const raw = simulateGridResetSeries(spiked, { ...cfg, emaAlpha: 1 });
    const smooth = simulateGridResetSeries(spiked, { ...cfg, emaAlpha: 0.2 });
    assert.strictEqual(raw.stats.emaAlpha, 1);
    assert.strictEqual(smooth.stats.emaAlpha, 0.2);
    assert.ok(
        Math.abs(smooth.slopePct[6]) < Math.abs(raw.slopePct[6]),
        'EMA should reduce the spike-induced slope excursion'
    );
});

check('EMA alpha below the live minimum is clamped before replay and reporting', () => {
    const cfg = { ...SLOPE_CFG, maxSlopePct: 0.09, lookbackBars: 1, erPeriod: 1, warmupBars: 2 };
    const series = geometric(100, 0.05, 12);
    const { MARKET_ADAPTER } = require('../modules/constants');
    const min = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MIN;
    const max = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MAX;
    const tooLow = simulateGridResetSeries(series, { ...cfg, emaAlpha: 0.001 });
    assert.strictEqual(tooLow.stats.emaAlpha, min, 'replay must clamp alpha up to the live minimum');
    const { computeAmaSlopeEmaSeries } = require('../market_adapter/core/strategies/dynamic_weight_series');
    assert.deepStrictEqual(
        tooLow.slopePct,
        computeAmaSlopeEmaSeries(series, cfg.erPeriod, cfg.lookbackBars, min),
        'the replay must actually apply the clamped alpha, not just report it'
    );
    const tooHigh = simulateGridResetSeries(series, { ...cfg, emaAlpha: 2 });
    assert.strictEqual(tooHigh.stats.emaAlpha, max, 'replay must clamp alpha down to the live maximum');
});

check('gridSimSlopeSignal clamps to the configured max slope offset', () => {
    const cfg = { maxSlopePct: 0.09, neutralZonePct: 0, maxSlopeOffset: 0.5 };
    const up = gridSimSlopeSignal(0.5, Infinity, cfg);
    assert.strictEqual(up.trend, 'UP');
    assert.ok(Math.abs(up.slopeOffset - 0.5) < 1e-12);
    const clipped = gridSimSlopeSignal(0.5, 0.2, cfg);
    assert.ok(Math.abs(clipped.slopePct - 0.5) < 1e-12, 'the delta trigger compares the UNCLIPPED slope');
    assert.ok(Math.abs(clipped.slopeOffset - 0.5) < 1e-12, 'clipped slope saturates the offset');
    const down = gridSimSlopeSignal(-0.5, Infinity, cfg);
    assert.strictEqual(down.trend, 'DOWN');
    assert.ok(Math.abs(down.slopeOffset + 0.5) < 1e-12);
    const none = gridSimSlopeSignal(null, Infinity, cfg);
    assert.strictEqual(none.slopePct, null);
    assert.strictEqual(none.slopeOffset, 0);
});

if (failed > 0) {
    console.error(`grid-reset simulation tests FAILED: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`grid-reset simulation tests passed (${passed} checks)`);

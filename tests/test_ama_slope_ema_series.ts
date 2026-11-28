'use strict';

const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running AMA slope EMA series tests');

const {
    computeAmaSlopeEmaSeries,
    computeHuberWindowSlopePct,
    computeDynamicWeightSeries,
} = require('../market_adapter/core/strategies/dynamic_weight_series');
const { computeAmaSlopeWeights } = require('../market_adapter/core/strategies/ama_slope_model');
const { normalizeAmaSlopeEmaAlpha } = require('../market_adapter/core/config_normalizers');
const { MARKET_ADAPTER } = require('../modules/constants');

const ER = 10;
const LB = 8;

function ramp(n: number, perBarPct = 0.05) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(100 * Math.pow(1 + perBarPct / 100, i));
    return out;
}

function spike(series: number[], at: number, pct: number) {
    const out = series.slice();
    out[at] = out[at] * (1 + pct / 100);
    for (let i = at + 1; i < out.length; i++) out[i] = out[i - 1] * 1.0005;
    return out;
}

function testAlphaOneIsRawHuberBitForBit() {
    const series = ramp(80);
    const raw = computeAmaSlopeEmaSeries(series, ER, LB, 1);
    assert.strictEqual(raw.length, series.length);
    for (let i = 0; i < ER + LB; i++) {
        assert.strictEqual(raw[i], null, `pre-warmup bar ${i} should stay null`);
    }
    for (let i = ER + LB; i < series.length; i++) {
        assert.strictEqual(
            raw[i],
            computeHuberWindowSlopePct(series, i, LB),
            `alpha=1 must equal the raw Huber slope at bar ${i}`
        );
    }
}

function testEmaRecurrenceAndSpikeDamping() {
    const series = spike(ramp(80), 55, 3);
    const alpha = 0.2;
    const raw = computeAmaSlopeEmaSeries(series, ER, LB, 1);
    const ema = computeAmaSlopeEmaSeries(series, ER, LB, alpha);
    let prev: number | null = null;
    let maxRawJump = 0;
    let maxEmaJump = 0;
    for (let i = ER + LB; i < series.length; i++) {
        const expected = prev === null ? raw[i] : prev + alpha * (raw[i] - prev);
        assert.ok(Math.abs(ema[i] - expected) < 1e-12, `EMA recurrence mismatch at bar ${i}`);
        prev = expected;
        if (i > ER + LB + 1) {
            maxRawJump = Math.max(maxRawJump, Math.abs(raw[i] - raw[i - 1]));
            maxEmaJump = Math.max(maxEmaJump, Math.abs(ema[i] - ema[i - 1]));
        }
    }
    assert.ok(maxEmaJump < maxRawJump, 'EMA should damp the injected spike jump');
}

function testInvalidAlphaFallsBackToRaw() {
    const series = ramp(60);
    const raw = computeAmaSlopeEmaSeries(series, ER, LB, 1);
    for (const bad of [0, -0.5, 1.5, NaN]) {
        const out = computeAmaSlopeEmaSeries(series, ER, LB, bad as number);
        assert.deepStrictEqual(out, raw, `alpha ${bad} should fall back to raw Huber`);
    }
}

function testNormalizerClampsAndDefaults() {
    assert.strictEqual(normalizeAmaSlopeEmaAlpha(null), MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
    assert.strictEqual(normalizeAmaSlopeEmaAlpha(''), MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
    assert.strictEqual(normalizeAmaSlopeEmaAlpha(NaN), MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
    assert.strictEqual(normalizeAmaSlopeEmaAlpha(0), MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
    assert.strictEqual(normalizeAmaSlopeEmaAlpha(2), MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MAX);
    assert.strictEqual(normalizeAmaSlopeEmaAlpha(0.05), 0.05);
}

function testAmaSlopeWeightsUsesSuppliedSeries() {
    const series = ramp(80);
    const shaped = computeAmaSlopeEmaSeries(series, ER, LB, 0.2);
    const opts = {
        erPeriod: ER,
        lookbackBars: LB,
        maxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        neutralZonePct: 0,
        clipThreshold: Infinity,
    };
    const rawResult = computeAmaSlopeWeights(series, 0, opts);
    const shapedResult = computeAmaSlopeWeights(series, 0, { ...opts, slopePctSeries: shaped });
    assert.strictEqual(shapedResult.slopePct, shaped[series.length - 1], 'published slope should come from the shaped series');
    assert.notStrictEqual(shapedResult.slopePct, rawResult.slopePct, 'shaped slope should differ from raw Huber');
    // A too-short series must fall back to the canonical estimator.
    const short = computeAmaSlopeWeights(series, 0, { ...opts, slopePctSeries: shaped.slice(-2) });
    assert.strictEqual(short.slopePct, rawResult.slopePct, 'short series should fall back to raw Huber');
    const nullTail = shaped.slice();
    nullTail[nullTail.length - 1] = null;
    const notReady = computeAmaSlopeWeights(series, 0, { ...opts, slopePctSeries: nullTail });
    assert.strictEqual(notReady.isReady, false, 'null shaped value should report not-ready');
}

function testAmaSlopeWeightsRollingSliceUsesCurrentBar() {
    // Reproduces the research-runner pattern: compute the shaped series over
    // the full AMA history, then iterate over a minimal rolling slice. The
    // slice's last index is the first ready bar, NOT the current bar, so the
    // series form silently publishes a constant warm-up value.
    const series = spike(ramp(90), 55, 3);
    const shaped = computeAmaSlopeEmaSeries(series, ER, LB, 0.2);
    const windowBars = ER + LB + 1;
    const opts = {
        erPeriod: ER,
        lookbackBars: LB,
        maxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        neutralZonePct: 0,
        clipThreshold: Infinity,
    };
    const published: number[] = [];
    for (let i = windowBars - 1; i < series.length; i++) {
        const slice = series.slice(i + 1 - windowBars, i + 1);
        // Explicit current-bar value — what the research runner now passes.
        const explicit = computeAmaSlopeWeights(slice, 0, { ...opts, currentSlopePct: shaped[i] });
        assert.strictEqual(explicit.slopePct, shaped[i], `explicit slope should track bar ${i}`);
        assert.strictEqual(explicit.isReady, true, `slice should be ready at bar ${i}`);
        published.push(explicit.slopePct as number);
        // An explicitly aligned slice is equivalent to the series form.
        const aligned = computeAmaSlopeWeights(slice, 0, { ...opts, slopePctSeries: shaped.slice(i + 1 - windowBars, i + 1) });
        assert.strictEqual(aligned.slopePct, shaped[i], `aligned slice should track bar ${i}`);
        // The unaligned full series reproduces the old bug: always the warm-up bar.
        const stale = computeAmaSlopeWeights(slice, 0, { ...opts, slopePctSeries: shaped });
        assert.strictEqual(stale.slopePct, shaped[windowBars - 1], `full series should read the warm-up bar at ${i}`);
        // Explicit value must win over a stale full series (ternary ordering).
        const overridden = computeAmaSlopeWeights(slice, 0, {
            ...opts,
            slopePctSeries: shaped,
            currentSlopePct: shaped[i],
        });
        assert.strictEqual(overridden.slopePct, shaped[i], `explicit slope should override the full series at ${i}`);
    }
    assert.ok(new Set(published).size > 1, 'published research slope must vary across bars');
}

function testDynamicWeightSeriesConsumesShapedSeries() {
    const series = ramp(80);
    const shaped = computeAmaSlopeEmaSeries(series, ER, LB, 0.2);
    const base = {
        amaValues: series,
        lookbackBars: LB,
        amaErPeriod: ER,
        amaClipThreshold: Infinity,
        kalClipThreshold: Infinity,
        neutralZonePct: 0,
        amaMaxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        kalmanMaxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
        offsetClamp: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
        dispScaleMinPct: 1,
        alpha: 1,
        dw: 0.5,
        gain: 1,
        minOutputThreshold: 0,
        signalConfirmBars: 0,
    };
    const raw = computeDynamicWeightSeries(base);
    const shapedRes = computeDynamicWeightSeries({ ...base, amaSlopePctSeries: shaped });
    const idx = series.length - 1;
    assert.ok(Number.isFinite(shapedRes.amaOffsets[idx]) && shapedRes.amaOffsets[idx] !== 0,
        'shaped offset should be finite and directional on a ramp');
    let differences = 0;
    for (let i = ER + LB; i < idx; i++) {
        if (shapedRes.amaOffsets[i] !== raw.amaOffsets[i]) differences++;
    }
    assert.ok(differences > 0, 'shaped series should change the AMA offset channel');
}

async function run() {
    testAlphaOneIsRawHuberBitForBit();
    testEmaRecurrenceAndSpikeDamping();
    testInvalidAlphaFallsBackToRaw();
    testNormalizerClampsAndDefaults();
    testAmaSlopeWeightsUsesSuppliedSeries();
    testAmaSlopeWeightsRollingSliceUsesCurrentBar();
    testDynamicWeightSeriesConsumesShapedSeries();
}

run()
    .then(() => console.log('AMA slope EMA series tests passed'))
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });

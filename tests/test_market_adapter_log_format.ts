'use strict';

const assert = require('assert');

const {
    buildWeightSummary,
    buildDynamicWeightInputsLog,
    buildDynamicWeightTuningLog,
    buildAsymmetricBoundsLog,
    buildStartupDefaultsLog,
} = require('../market_adapter/log_format');
const { DEFAULT_CONFIG, MARKET_ADAPTER } = require('../modules/constants');
const { DEFAULT_AMA } = require('../market_adapter/market_adapter');
const { fixedTo } = require('../modules/order/utils/math');

console.log('Running market adapter log format tests');

function testBuildWeightSummaryFormatsSellBuyOrder() {
    assert.strictEqual(
        buildWeightSummary({ sell: 0.61, buy: 0.39 }),
        ' weights(sell/buy)=0.61/0.39',
        'weight summary should preserve sell/buy ordering'
    );
    assert.strictEqual(buildWeightSummary(null), '', 'missing weights should yield an empty suffix');
}

function testBuildDynamicWeightInputsLogFormatsFields() {
    const text = buildDynamicWeightInputsLog({
        staticSell: 0.6,
        staticBuy: 0.4,
        maxSlopeOffset: 0.5,
        maxVolatilityOffset: 0.25,
        atrPeriod: 14,
        signalConfirmBars: 2,
    }, {
        erPeriod: 781,
        fastPeriod: 5.2,
        slowPeriod: 82.7,
    });

    assert.ok(text.includes('ama=781/5.2/82.7'), 'AMA tuple should be formatted');
    assert.ok(text.includes('base=0.60/0.40'), 'base weights should be formatted');
    assert.ok(text.includes('clamp=0.50/0.25'), 'clamp pair should be formatted');
    assert.ok(text.includes('atr=14'), 'ATR period should be shown');
    assert.ok(text.includes('confirm=2'), 'confirm bars should be shown');
}

function testBuildDynamicWeightTuningLogFormatsKnobs() {
    const text = buildDynamicWeightTuningLog({
        amaSlope: { maxSlopePct: 0.9, emaAlpha: 0.2 },
        kalmanSlope: { maxSlopePct: 1.8 },
        alpha: 0.35,
        dw: 0.7,
        gain: 1.75,
        volatilityThreshold: 0.1,
        volatilityExponent: 0.5,
        volatilityScaleX: 10,
        clipPercentile: 10,
        neutralZonePct: 0.02,
        minOutputThreshold: 0.08,
        regimeSensitivity: 1,
        absoluteThreshold: 0.03,
        kalmanSmoothPct: 60,
        kalmanDispScaleMult: 1.7,
        kalmanDispThresholdMult: 1.15,
        kalmanSmoothSpanPct: 120,
    });

    assert.ok(text.includes('slopeMax=0.90'), 'AMA slope max should be formatted');
    assert.ok(text.includes('ema=0.20'), 'AMA slope EMA alpha should be formatted');
    assert.ok(text.includes('kalmanMax=1.80'), 'Kalman slope max should be formatted');
    assert.ok(text.includes('vol(thr/exp/x)=0.10/0.50/10.00'), 'volatility tuning tuple should be formatted');
    assert.ok(text.includes('reg(sens/abs)=1.00/0.03'), 'regime tuning tuple should be formatted');
    assert.ok(text.includes('kalman(sm/disp/th/span)=60.00/1.70/1.15/120.00'), 'Kalman tuning tuple should be formatted');
}

function testBuildDynamicWeightTuningLogKeepsTinyAmaKnobsVisible() {
    const text = buildDynamicWeightTuningLog({
        amaSlope: { maxSlopePct: 0.0417 },
        kalmanSlope: { maxSlopePct: 1.8 },
        neutralZonePct: 0.0021,
    });

    assert.ok(text.includes('slopeMax=0.0417'), 'small AMA slope max should retain fine precision');
    assert.ok(text.includes('nz=0.0021'), 'small neutral-zone values should retain fine precision');
}

function testBuildAsymmetricBoundsLogFormatsPercentages() {
    assert.strictEqual(
        buildAsymmetricBoundsLog({
            rawAsymmetryFactor: 0.24,
            appliedAsymmetryFactor: 0.11,
            maxAsymmetryFactor: 0.35,
        }),
        'raw=24.00%, applied=11.00%, maxAsym=35%',
        'asymmetric bounds log should format all percentages consistently'
    );
}

function testBuildStartupDefaultsLogReflectsExplicitOnlyDynamicBase() {
    const text = buildStartupDefaultsLog(DEFAULT_AMA, DEFAULT_CONFIG, MARKET_ADAPTER);
    const expectedFallback = `weightFallback=${fixedTo(DEFAULT_CONFIG.weightDistribution.sell, 2)}/${fixedTo(DEFAULT_CONFIG.weightDistribution.buy, 2)}`;

    const expectedAsymCap = `asymCap=${(MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR * 100).toFixed(0)}%`;

    assert.ok(text.includes('dynamicBase=explicit-only'), 'startup defaults should document explicit-only dynamic base weights');
    assert.ok(text.includes(expectedFallback), 'startup defaults should include fallback weights');
    assert.ok(text.includes(expectedAsymCap), 'startup defaults should include the merged asymmetry cap');
}

testBuildWeightSummaryFormatsSellBuyOrder();
testBuildDynamicWeightInputsLogFormatsFields();
testBuildDynamicWeightTuningLogFormatsKnobs();
testBuildDynamicWeightTuningLogKeepsTinyAmaKnobsVisible();
testBuildAsymmetricBoundsLogFormatsPercentages();
testBuildStartupDefaultsLogReflectsExplicitOnlyDynamicBase();

console.log('market adapter log format tests passed');

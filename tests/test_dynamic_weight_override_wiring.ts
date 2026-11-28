'use strict';

const assert = require('assert');
const fs = require('fs');
const { runEsmMockStages } = require('./helpers/esm_mocks');

// loadMarketAdapterSettings() caches parsed settings in module state for the
// lifetime of the process, and compiled ESM graphs cannot be re-loaded via
// require.cache tricks. Run every scenario in its own hooked child process
// (runEsmMockStages) so each one observes its own settings fixture.
console.log('Running dynamic weight override wiring tests');

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;

function installSettingsFixture(settingsJson) {
    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_settings.json')) return true;
        return originalExistsSync(filePath);
    };

    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_settings.json')) {
            return JSON.stringify(settingsJson, null, 2);
        }
        return originalReadFileSync(filePath, encoding);
    };
}

function restoreFs() {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
}

function testResolveBotCfgWiresMissingPairAndBotOverrides() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    maxSlopeOffset: 0.33,
                    dispScaleMinPct: 0.25,
                    hurstZoneBand: 0.08,
                    peNodes: [0.58, 0.70, 0.82],
                    amaSlopePercentMode: 'perBar',
                    amaSlopeDeltaThresholdPercent: 0.22,
                    amaSlope: {
                        maxSlopePct: 1.2,
                        emaAlpha: 0.05,
                    },
                    kalmanSlope: {
                        maxSlopePct: 1.2,
                    },
                },
                botOverrides: {
                    'AAA-BBB': {
                        maxSlopeOffset: 0.44,
                        dispScaleMinPct: 0.35,
                        hurstZoneBand: 0.09,
                        peNodes: [0.57, 0.69, 0.81],
                        amaSlopeDeltaThresholdPercent: 0.33,
                        amaSlope: {
                            maxSlopePct: 1.6,
                            emaAlpha: 0.1,
                        },
                        kalmanSlope: {
                            maxSlopePct: 1.6,
                        },
                    },
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter');

    const bot = {
        name: 'AAA-BBB',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.maxSlopeOffset, 0.44, 'bot override should win for maxSlopeOffset');
    assert.strictEqual(merged.dispScaleAtrMult, undefined, 'removed dispScaleAtrMult should not be carried forward');
    assert.strictEqual(merged.dispScaleMinPct, 0.35, 'bot override should win for dispScaleMinPct');
    assert.strictEqual(merged.hurstZoneBand, 0.09, 'bot override should win for hurstZoneBand');
    assert.deepStrictEqual(merged.peNodes, [0.57, 0.69, 0.81], 'bot override should win for peNodes');
    assert.strictEqual(
        merged.amaSlopeDeltaThresholdPercent,
        0.33,
        'bot override should win for amaSlopeDeltaThresholdPercent'
    );
    assert.strictEqual(merged.amaSlope.maxSlopePct, 1.6, 'bot override should win for amaSlope.maxSlopePct');
    assert.strictEqual(merged.amaSlope.emaAlpha, 0.1, 'bot override should win for amaSlope.emaAlpha');
    assert.strictEqual(merged.kalmanSlope.maxSlopePct, 1.6, 'bot override should win for kalmanSlope.maxSlopePct');
}

function testResolveBotCfgWiresMissingPairOverridesWithoutBotOverride() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    maxSlopeOffset: 0.31,
                    dispScaleMinPct: 0.2,
                    hurstZoneBand: 0.07,
                    peNodes: [0.59, 0.71, 0.83],
                    amaSlopePercentMode: 'perBar',
                    amaSlopeDeltaThresholdPercent: 0.21,
                    amaSlope: {
                        maxSlopePct: 1.15,
                        emaAlpha: 0.05,
                    },
                    kalmanSlope: {
                        maxSlopePct: 1.15,
                    },
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter');

    const bot = {
        name: 'Different Bot',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.maxSlopeOffset, 0.31, 'pair override should apply for maxSlopeOffset');
    assert.strictEqual(merged.dispScaleAtrMult, undefined, 'removed dispScaleAtrMult should not be carried forward');
    assert.strictEqual(merged.dispScaleMinPct, 0.2, 'pair override should apply for dispScaleMinPct');
    assert.strictEqual(merged.hurstZoneBand, 0.07, 'pair override should apply for hurstZoneBand');
    assert.deepStrictEqual(merged.peNodes, [0.59, 0.71, 0.83], 'pair override should apply for peNodes');
    assert.strictEqual(
        merged.amaSlopeDeltaThresholdPercent,
        0.21,
        'pair override should apply for amaSlopeDeltaThresholdPercent'
    );
    assert.strictEqual(merged.amaSlope.maxSlopePct, 1.15, 'pair override should apply for amaSlope.maxSlopePct');
    assert.strictEqual(merged.amaSlope.emaAlpha, 0.05, 'pair override should apply for amaSlope.emaAlpha');
    assert.strictEqual(merged.kalmanSlope.maxSlopePct, 1.15, 'pair override should apply for kalmanSlope.maxSlopePct');
}

function testResolveBotCfgPassesThroughUnmarkedAmaSlopePercents() {
    const settingsJson = {
        globals: {
            amaSlope: {
                lookbackBars: 9,
                maxSlopePct: 0.9,
                neutralZonePct: 0.18,
            },
            amaSlopeDeltaThresholdPercent: 0.09,
        },
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    amaSlope: {
                        lookbackBars: 18,
                        maxSlopePct: 1.8,
                    },
                    amaSlopeDeltaThresholdPercent: 0.18,
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter');

    const bot = {
        name: 'AAA-BBB',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.amaSlope.lookbackBars, 18, 'pair lookback should apply');
    assert.strictEqual(merged.amaSlope.maxSlopePct, 1.8, 'unmarked per-bar max slope should pass through');
    assert.strictEqual(merged.amaSlope.neutralZonePct, 0.18, 'unmarked per-bar neutral zone should pass through');
    assert.strictEqual(
        merged.amaSlopeDeltaThresholdPercent,
        0.18,
        'unmarked per-bar slope delta threshold should pass through'
    );
}

function testResolveBotCfgKeepsMarkedPerBarAmaSlopePercents() {
    const settingsJson = {
        globals: {
            amaSlopePercentMode: 'perBar',
            amaSlope: {
                lookbackBars: 72,
                maxSlopePct: 0.0417,
                neutralZonePct: 0.0021,
            },
            amaSlopeDeltaThresholdPercent: 0.0014,
        },
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    amaSlopeDeltaThresholdPercent: 0.0017,
                },
                botOverrides: {
                    'AAA-BBB': {
                        amaSlopeDeltaThresholdPercent: 0.0011,
                    },
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter');

    const bot = {
        name: 'AAA-BBB',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.amaSlope.maxSlopePct, 0.0417, 'marked per-bar max slope should stay unchanged');
    assert.strictEqual(merged.amaSlope.neutralZonePct, 0.0021, 'marked per-bar neutral zone should stay unchanged');
    assert.strictEqual(
        merged.amaSlopeDeltaThresholdPercent,
        0.0011,
        'marked per-bar bot threshold should stay unchanged'
    );
}

function testBilinearInterpolateUsesOverrideNodes() {
    const { bilinearInterpolate } = require('../market_adapter/core/strategies/regime_interp');

    const table = [
        [1.0, 0.7, 0.3],
        [0.6, 0.4, 0.15],
        [0.3, 0.2, 0.05],
    ];

    const defaultValue = bilinearInterpolate(0.56, 0.61, table);
    const overrideValue = bilinearInterpolate(0.56, 0.61, table, {
        hurstZoneBand: 0.08,
        peNodes: [0.58, 0.70, 0.82],
    });

    assert.notStrictEqual(overrideValue, defaultValue, 'override nodes should change interpolation');
}

function testResolveBotCfgSanitizesAtrPeriodAndVolatilityClampOverrides() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    atrPeriod: 0,
                    maxVolatilityOffset: -0.5,
                    volatilityThreshold: -1,
                },
                botOverrides: {
                    'AAA-BBB': {
                        atrPeriod: 14.5,
                        maxVolatilityOffset: 0,
                        volatilityThreshold: Number.NaN,
                    },
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter');
    const { MARKET_ADAPTER } = require('../modules/constants');

    const bot = {
        name: 'AAA-BBB',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });

    assert.strictEqual(merged.atrPeriod, 15, 'positive fractional ATR period should be normalized to an integer');
    assert.strictEqual(
        merged.maxVolatilityOffset,
        0,
        'zero volatility clamp overrides should remain valid and disable the symmetric shift'
    );
    assert.strictEqual(
        merged.volatilityThreshold,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD,
        'invalid volatility thresholds should fall back to the default threshold'
    );
}

function testResolveBotCfgDoesNotLeakNestedTopLevelOverridesAcrossBots() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    amaSlopePercentMode: 'perBar',
                    amaSlope: {
                        maxSlopePct: 1.23,
                        neutralZonePct: 0.12,
                    },
                    amaSlopeDeltaThresholdPercent: 0.19,
                    kalmanSlope: {
                        maxSlopePct: 1.24,
                    },
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter');
    const { MARKET_ADAPTER } = require('../modules/constants');
    const globalCfg = { ...DEFAULTS };

    const matched = resolveBotCfg({
        name: 'AAA-BBB',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    }, globalCfg);

    const unmatched = resolveBotCfg({
        name: 'OTHER-BTS',
        assetA: 'OTHER',
        assetB: 'BTS',
        assetAId: '1.3.999',
        assetBId: '1.3.0',
    }, globalCfg);

    assert.strictEqual(matched.amaSlope.maxSlopePct, 1.23, 'matched pair should receive AMA override');
    assert.strictEqual(matched.amaSlope.neutralZonePct, 0.12, 'matched pair should receive neutral-zone override');
    assert.strictEqual(
        matched.amaSlopeDeltaThresholdPercent,
        0.19,
        'matched pair should receive slope delta threshold override'
    );
    assert.strictEqual(matched.kalmanSlope.maxSlopePct, 1.24, 'matched pair should receive Kalman override');
    assert.strictEqual(
        unmatched.amaSlope.maxSlopePct,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        'unmatched bot should keep default AMA max slope'
    );
    assert.strictEqual(
        unmatched.amaSlope.neutralZonePct,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
        'unmatched bot should keep default neutral zone'
    );
    assert.strictEqual(
        unmatched.kalmanSlope.maxSlopePct,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
        'unmatched bot should keep default Kalman max slope'
    );
    assert.strictEqual(
        unmatched.amaSlopeDeltaThresholdPercent,
        undefined,
        'unmatched bot should not have an explicit AMA slope delta threshold (dynamic default)'
    );
}

function testResolveBotCfgPrefersExactPairOverFlippedFallback() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.0|1.3.1',
                assetASymbol: 'BTS',
                assetBSymbol: 'IOB.XRP',
                marketAdapterSettings: {
                    maxSlopeOffset: 0.11,
                },
            },
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {
                    maxSlopeOffset: 0.22,
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { DEFAULTS, resolveBotCfg } = require('../market_adapter/market_adapter');

    const bot = {
        name: 'AAA-BBB',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    const merged = resolveBotCfg(bot, { ...DEFAULTS });
    assert.strictEqual(merged.maxSlopeOffset, 0.22, 'exact pair orientation should win over a flipped fallback match');
}

function testResolveBotCfgMergesPartialKalmanOverride() {
    const settingsJson = {
        pairs: [
            {
                key: '1.3.1|1.3.0',
                assetASymbol: 'IOB.XRP',
                assetBSymbol: 'BTS',
                marketAdapterSettings: {},
                botOverrides: {
                    'AAA-BBB': {
                        kalman: { rNoise: 0.8 },
                    },
                },
            },
        ],
    };

    installSettingsFixture(settingsJson);
    const { resolveBotCfg } = require('../market_adapter/market_adapter');

    const bot = {
        name: 'AAA-BBB',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
    };

    // Higher-layer (globals) kalman config with multiple sub-keys.
    const globalCfg = {
        kalman: { rNoise: 0.5, qTactical: 0.1, qModal: 0.2, warmupBars: 30 },
    };

    const merged = resolveBotCfg(bot, globalCfg);

    assert.deepStrictEqual(
        merged.kalman,
        { rNoise: 0.8, qTactical: 0.1, qModal: 0.2, warmupBars: 30 },
        'partial kalman override must keep sibling keys from the higher layer'
    );
}

const STAGES = {
    wires_missing_pair_and_bot_overrides: testResolveBotCfgWiresMissingPairAndBotOverrides,
    merges_partial_kalman_override: testResolveBotCfgMergesPartialKalmanOverride,
    wires_missing_pair_overrides_without_bot_override: testResolveBotCfgWiresMissingPairOverridesWithoutBotOverride,
    passes_through_unmarked_ama_slope_percents: testResolveBotCfgPassesThroughUnmarkedAmaSlopePercents,
    keeps_marked_per_bar_ama_slope_percents: testResolveBotCfgKeepsMarkedPerBarAmaSlopePercents,
    bilinear_interpolate_uses_override_nodes: testBilinearInterpolateUsesOverrideNodes,
    sanitizes_atr_period_and_volatility_clamp_overrides: testResolveBotCfgSanitizesAtrPeriodAndVolatilityClampOverrides,
    does_not_leak_nested_top_level_overrides_across_bots: testResolveBotCfgDoesNotLeakNestedTopLevelOverridesAcrossBots,
    prefers_exact_pair_over_flipped_fallback: testResolveBotCfgPrefersExactPairOverFlippedFallback,
};

runEsmMockStages(Object.keys(STAGES), (stage) => {
    const fn = STAGES[stage];
    assert.strictEqual(typeof fn, 'function', `unknown stage ${stage}`);
    console.log(` - ${stage}`);
    try {
        fn();
    } finally {
        restoreFs();
    }
});

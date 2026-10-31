const assert = require('assert');
const { PATHS } = require('../modules/paths');;
const fs = require('fs');
const path = require('path');
const { MARKET_ADAPTER } = require('../modules/constants');

console.log('Running market_adapter logic tests');

const {
    DEFAULT_AMA,
    calculateBotThreshold,
    buildAmaRecord,
    computeCandleStaleness,
    resolveAmaForBot,
    normalizeMarketSource,
    normalizeNativeMarketHistoryCandles,
    fetchNativeMarketHistorySince,
    usesAmaGridPrice,
    applyRuntimeDefaultsFromGeneralSettings,
    __test: {
        resolveDeltaThresholdPercentFromGeneralSettings,
        resolveAmaSlopeDeltaThresholdPercentFromGeneralSettings,
        _setBitsharesClientForTests,
    },
} = require('../market_adapter/market_adapter');
const { resolveMarketSourceForBot } = require('../market_adapter/utils/chain');
const { parseNativeMarketHistoryTimestamp } = require('../market_adapter/utils/native_history').__test;
const { detectMissingCandleTimestamps, fillCandleGaps, pruneStaleTail, tradesToCandles } = require('../market_adapter/candle_utils');
const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { loadStrategiesFromProfiles } = require('../market_adapter/lp_chart_strategy_loader').__test;
const { ensureDir, writeJSON } = require('../modules/storage').getStorage();

const MARKET_PROFILES_FILE = PATHS.PROFILES.MARKET_PROFILES_JSON;

// Threshold behavior
assert.strictEqual(
    calculateBotThreshold({ deltaThresholdPercent: 1 }),
    1,
    'threshold should be fixed deltaThresholdPercent'
);

assert.strictEqual(
    calculateBotThreshold({ deltaThresholdPercent: 2.5 }),
    2.5,
    'custom delta threshold should be used directly'
);

assert.strictEqual(
    calculateBotThreshold({ deltaThresholdPercent: Number.NaN }),
    null,
    'invalid threshold should return null'
);

// Stale detection behavior
{
    const now = Date.now();
    const freshTs = now - (1 * 3600 * 1000);
    const staleTs = now - (7 * 3600 * 1000);

    const fresh = computeCandleStaleness(freshTs, 6);
    assert.strictEqual(fresh.staleData, false, '1h old candle should not be stale with 6h max');
    assert.ok(Number.isFinite(fresh.staleAgeHours), 'fresh staleAgeHours should be finite');

    const stale = computeCandleStaleness(staleTs, 6);
    assert.strictEqual(stale.staleData, true, '7h old candle should be stale with 6h max');
    assert.ok(Number.isFinite(stale.staleAgeHours), 'stale staleAgeHours should be finite');

    const missing = computeCandleStaleness(null, 6);
    assert.strictEqual(missing.staleData, true, 'missing candle timestamp should be treated as stale');
    assert.strictEqual(missing.staleAgeHours, null, 'missing candle timestamp should expose null staleAgeHours');
}

// Candle continuity behavior
{
    const candles = [
        [1700000000000, 100, 100, 100, 100, 1],
        [1700007200000, 102, 103, 101, 102, 2],
    ];
    const result = detectMissingCandleTimestamps(candles, 3600);
    assert.strictEqual(result.gapCount, 1, 'missing hourly bucket should be detected');
    assert.deepStrictEqual(
        result.missingTimestamps,
        [1700003600000],
        'gap detector should return the missing hourly bucket timestamp'
    );
}

{
    const candles = [
        [1700000000000, 100, 100, 100, 100, 1],
        [1700003600000, 101, 101, 101, 101, 1],
    ];
    const result = detectMissingCandleTimestamps(candles, 3600);
    assert.strictEqual(result.gapCount, 0, 'continuous candles should not report gaps');
    assert.deepStrictEqual(result.missingTimestamps, [], 'continuous series should not return missing timestamps');
}

// Native incremental gap fill behavior
{
    const base = 1700000000000;
    const hour = 3600000;
    const candles = [
        [base, 100, 100, 100, 100, 1],
        [base + hour, 100, 100, 100, 100, 0],
        [base + (2 * hour), 100, 100, 100, 100, 0],
    ];
    assert.deepStrictEqual(
        pruneStaleTail(candles, 2),
        [[base, 100, 100, 100, 100, 1]],
        'stale-tail pruning should remove zero-volume flat synthetic tail candles'
    );
}

{
    const base = 1700000000000;
    const hour = 3600000;
    const candles = [
        [base, 100, 100, 100, 100, 1],
        [base + hour, 100, 100, 100, 100, 2],
        [base + (2 * hour), 100, 100, 100, 100, 3],
    ];
    assert.deepStrictEqual(
        pruneStaleTail(candles, 2),
        candles,
        'stale-tail pruning must not remove real same-price traded candles'
    );
}

{
    const ts = 1700000000000;
    const assetA = { id: '1.3.1', precision: 0 };
    const assetB = { id: '1.3.2', precision: 0 };
    const candles = tradesToCandles([
        {
            tsMs: ts,
            sequence: 12,
            sell: { amount: 10, asset_id: assetA.id },
            received: { amount: 30, asset_id: assetB.id },
        },
        {
            tsMs: ts,
            sequence: 11,
            sell: { amount: 10, asset_id: assetA.id },
            received: { amount: 20, asset_id: assetB.id },
        },
    ], assetA, assetB, 3600);

    assert.deepStrictEqual(
        candles,
        [[Math.floor(ts / 3600000) * 3600000, 2, 3, 2, 3, 20]],
        'same-timestamp trades should be ordered by native sequence so OHLC close is the latest trade'
    );
}

{
    const hour = 3600 * 1000;
    const base = 1700002800000;
    const service = new MarketAdapterService({
        fillCandleGaps,
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            existing.forEach((c) => map.set(c[0], c));
            incoming.forEach((c) => map.set(c[0], c));
            return [...map.values()].sort((a, b) => a[0] - b[0]);
        },
    });

    const candles = [
        [base, 100, 100, 100, 100, 1],
        [base + (3 * hour), 103, 104, 102, 103, 2],
    ];
    const filled = service.fillNativeIncrementalClosedGaps(candles, base, 3600, base + (4 * hour) + 1);

    assert.deepStrictEqual(
        filled.map((c) => c[0]),
        [base, base + hour, base + (2 * hour), base + (3 * hour)],
        'native incremental fill should carry no-trade closed hours forward'
    );
    assert.deepStrictEqual(
        filled[1],
        [base + hour, 100, 100, 100, 100, 0],
        'filled no-trade candle should use previous close and zero volume'
    );
    assert.deepStrictEqual(
        filled[2],
        [base + (2 * hour), 100, 100, 100, 100, 0],
        'multiple no-trade closed hours should be filled before the next trade candle'
    );
}

{
    const hour = 3600 * 1000;
    const base = 1700002800000;
    const service = new MarketAdapterService({
        fillCandleGaps,
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            existing.forEach((c) => map.set(c[0], c));
            incoming.forEach((c) => map.set(c[0], c));
            return [...map.values()].sort((a, b) => a[0] - b[0]);
        },
    });

    const candles = [
        [base, 100, 100, 100, 100, 1],
    ];
    const filled = service.fillNativeIncrementalClosedGaps(candles, base, 3600, base + (2 * hour) + 1);

    assert.deepStrictEqual(
        filled.map((c) => c[0]),
        [base, base + hour],
        'native incremental fill should not synthesize the current in-progress hour'
    );
}

// General settings → runtime defaults behavior
assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 3.25 } }),
    3.25,
    'should read MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT when valid'
);

assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 0 } }),
    null,
    'non-positive settings value should be ignored'
);

assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { DELTA_THRESHOLD_PERCENT: 3.0 } }),
    null,
    'old DELTA_THRESHOLD_PERCENT should be ignored'
);

assert.strictEqual(
    resolveDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { GRID_RESET_FACTOR: 2.2 } }),
    null,
    'old GRID_RESET_FACTOR should be ignored'
);

{
    const cfg = applyRuntimeDefaultsFromGeneralSettings(
        { deltaThresholdPercent: 1 },
        { deltaThresholdPercent: false },
        { MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 4 } }
    );
    assert.strictEqual(cfg.deltaThresholdPercent, 4, 'settings should override default when CLI flag absent');
}

{
    const cfg = applyRuntimeDefaultsFromGeneralSettings(
        { deltaThresholdPercent: 2.5 },
        { deltaThresholdPercent: true },
        { MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 4 } }
    );
    assert.strictEqual(cfg.deltaThresholdPercent, 2.5, 'CLI-provided deltaPercent should win over settings');
}

// General settings → slope-trigger factor (the editor's `AMA-Slope Δ`)
assert.strictEqual(
    resolveAmaSlopeDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { AMA_SLOPE_DELTA_THRESHOLD_PERCENT: 5 } }),
    5,
    'should read MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT when valid'
);

assert.strictEqual(
    resolveAmaSlopeDeltaThresholdPercentFromGeneralSettings({ MARKET_ADAPTER: { AMA_SLOPE_DELTA_THRESHOLD_PERCENT: 0 } }),
    null,
    'non-positive slope settings value should be ignored'
);

{
    const cfg = applyRuntimeDefaultsFromGeneralSettings(
        { amaSlope: { deltaThresholdPct: 8, maxSlopePct: 0.09 } },
        {},
        { MARKET_ADAPTER: { AMA_SLOPE_DELTA_THRESHOLD_PERCENT: 5 } }
    );
    assert.strictEqual(cfg.amaSlope.deltaThresholdPct, 5, 'general settings should override the slope factor');
    assert.strictEqual(cfg.amaSlope.maxSlopePct, 0.09, 'other amaSlope fields must be preserved');
}

{
    const cfg = applyRuntimeDefaultsFromGeneralSettings(
        { amaSlope: { deltaThresholdPct: 8 } },
        {},
        { MARKET_ADAPTER: {} }
    );
    assert.strictEqual(cfg.amaSlope.deltaThresholdPct, 8, 'absent slope setting leaves the factor untouched');
}

// Bot AMA config behavior
assert.deepStrictEqual(
    DEFAULT_AMA,
    MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY],
    'built-in default AMA should match the configured default preset'
);

{
    const ama = resolveAmaForBot({
        ama: {
            enabled: true,
            erPeriod: 136,
            fastPeriod: 2.73,
            slowPeriod: 672,
        },
    });
    assert.strictEqual(ama.fastPeriod, 2.73, 'fractional fastPeriod from bot config should be preserved');
}

{
    const ama = resolveAmaForBot({ gridPrice: 'ama2' });
    assert.strictEqual(ama.slowPeriod, MARKET_ADAPTER.AMAS.AMA2.slowPeriod, 'ama2 keyword should resolve to built-in AMA2 slowPeriod');
    assert.strictEqual(ama.fastPeriod, MARKET_ADAPTER.AMAS.AMA2.fastPeriod, 'ama2 keyword should resolve to built-in AMA2 fastPeriod');
    assert.strictEqual(ama.erPeriod, MARKET_ADAPTER.AMAS.AMA2.erPeriod, 'ama2 keyword should resolve to built-in AMA2 erPeriod');
}

{
    const ama = resolveAmaForBot({ gridPrice: 'ama2', ama: { fastPeriod: 2.5 } });
    assert.strictEqual(ama.fastPeriod, 2.5, 'partial override: fastPeriod from bot.ama should take priority');
    assert.strictEqual(ama.erPeriod, MARKET_ADAPTER.AMAS.AMA2.erPeriod, 'partial override: erPeriod should fall back to preset');
    assert.strictEqual(ama.slowPeriod, MARKET_ADAPTER.AMAS.AMA2.slowPeriod, 'partial override: slowPeriod should fall back to preset');
}

assert.strictEqual(usesAmaGridPrice({ gridPrice: 'ama' }), true, 'ama should enable market adapter processing');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 'ama3' }), true, 'ama3 should enable market adapter processing');
assert.strictEqual(usesAmaGridPrice({ gridPrice: '  AMA4  ' }), true, 'ama4 matching should be case-insensitive');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 1.2345 }), false, 'numeric gridPrice should not enable market adapter processing');
assert.strictEqual(usesAmaGridPrice({ gridPrice: null }), false, 'missing gridPrice should not enable market adapter processing');

assert.strictEqual(normalizeMarketSource('pool'), 'pool', 'pool should normalize to pool');
assert.strictEqual(normalizeMarketSource('book'), 'book', 'book should stay book');
assert.strictEqual(normalizeMarketSource('orderbook'), null, 'orderbook should no longer normalize to book');
assert.strictEqual(normalizeMarketSource('market'), null, 'market should no longer normalize to book');
assert.strictEqual(normalizeMarketSource('anything-else'), null, 'unknown source should normalize to null');

assert.strictEqual(resolveMarketSourceForBot({ startPrice: 'pool' }), 'pool', 'startPrice=pool should select pool mode');
assert.strictEqual(resolveMarketSourceForBot({ startPrice: 'book' }), 'book', 'startPrice=book should select book mode');
assert.strictEqual(resolveMarketSourceForBot({ startPrice: 'orderbook' }), 'pool', 'startPrice=orderbook should fall back to pool source');
assert.strictEqual(
    resolveMarketSourceForBot({ startPrice: 'book', marketSource: 'pool' }),
    'book',
    'marketSource should not override startPrice for the market adapter'
);
assert.strictEqual(resolveMarketSourceForBot({ startPrice: 1.2345 }), null, 'numeric startPrice should disable market-source selection');

{
    const candles = normalizeNativeMarketHistoryCandles([{
        key: {
            base: '1.3.0',
            quote: '1.3.1',
            open: '2026-01-01T00:00:00',
        },
        open_base: '200000',
        open_quote: '40000',
        high_base: '160000',
        high_quote: '40000',
        low_base: '320000',
        low_quote: '40000',
        close_base: '800000',
        close_quote: '160000',
        base_volume: '360000',
        quote_volume: '180000',
    }], { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' }, { id: '1.3.0', precision: 5, symbol: 'BTS' });

    assert.strictEqual(candles.length, 1, 'native market history should normalize one candle');
    assert.strictEqual(candles[0][0], new Date('2026-01-01T00:00:00Z').getTime(), 'timestamp should be parsed as UTC');
    assert.strictEqual(candles[0][1], 0.5, 'IOB.XRP/BTS open should be normalized to BTS per XRP');
    assert.strictEqual(candles[0][2], 0.8, 'IOB.XRP/BTS high should remain the larger normalized price');
    assert.strictEqual(candles[0][3], 0.4, 'IOB.XRP/BTS low should remain the smaller normalized price');
    assert.strictEqual(candles[0][4], 0.5, 'IOB.XRP/BTS close should be normalized to BTS per XRP');
    assert.strictEqual(candles[0][5], 18, 'IOB.XRP/BTS volume should be expressed in XRP units');
}

// Timestamp: UTC parsing must be independent of the host timezone
{
    const inBerlinSummer = { key: { base: '1.3.0', quote: '1.3.1', open: '2026-07-15T12:00:00' } };
    const ts = parseNativeMarketHistoryTimestamp(inBerlinSummer);
    const expected = Date.UTC(2026, 6, 15, 12, 0, 0);
    assert.strictEqual(ts, expected,
        `parseNativeMarketHistoryTimestamp must parse UTC, got ${ts} (${ts - expected}ms off from ${expected})`
    );

    // Winter (no DST) should also be correct
    const inWinter = { key: { base: '1.3.0', quote: '1.3.1', open: '2026-01-15T12:00:00' } };
    const tsWinter = parseNativeMarketHistoryTimestamp(inWinter);
    const expectedWinter = Date.UTC(2026, 0, 15, 12, 0, 0);
    assert.strictEqual(tsWinter, expectedWinter,
        `parseNativeMarketHistoryTimestamp must parse winter UTC correctly`
    );

    // Already has Z suffix — should still work
    const withZ = { key: { base: '1.3.0', quote: '1.3.1', open: '2026-01-15T12:00:00Z' } };
    const tsZ = parseNativeMarketHistoryTimestamp(withZ);
    assert.strictEqual(tsZ, expectedWinter, 'Z suffix should also parse as UTC');

    // Epoch seconds (10-digit) should be normalized to ms
    const epochSec = { key: { base: '1.3.0', quote: '1.3.1', open: 1704067200 } };
    const tsEpochSec = parseNativeMarketHistoryTimestamp(epochSec);
    assert.strictEqual(tsEpochSec, 1704067200 * 1000, 'epoch seconds should be multiplied to ms');

    // Epoch ms (13-digit) should pass through
    const epochMs = { key: { base: '1.3.0', quote: '1.3.1', open: 1704067200000 } };
    const tsEpochMs = parseNativeMarketHistoryTimestamp(epochMs);
    assert.strictEqual(tsEpochMs, 1704067200000, 'epoch ms should pass through unchanged');
}

// Epoch-second normalization in normalizeNativeMarketHistoryCandles (array path)
{
    const candles = normalizeNativeMarketHistoryCandles(
        [[1704067200, 0.5, 0.6, 0.4, 0.55, 10]],
        { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
        { id: '1.3.0', precision: 5, symbol: 'BTS' },
    );
    assert.strictEqual(candles.length, 1);
    assert.strictEqual(candles[0][0], 1704067200000, 'array-path epoch seconds should be normalized to ms');

    // Epoch ms should pass through unchanged
    const candlesMs = normalizeNativeMarketHistoryCandles(
        [[1704067200000, 0.5, 0.6, 0.4, 0.55, 10]],
        { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
        { id: '1.3.0', precision: 5, symbol: 'BTS' },
    );
    assert.strictEqual(candlesMs[0][0], 1704067200000, 'array-path epoch ms should pass through unchanged');
}

async function testNativeMarketHistoryDirectOrder() {
    let callArgs = null;
    _setBitsharesClientForTests({
        BitShares: {
            history: {
                getMarketHistory: async (...args) => {
                    callArgs = args;
                    return [[1704067200000, 0.5, 0.6, 0.4, 0.55, 10]];
                },
            },
        },
    });

    try {
        const assetA = { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' };
        const assetB = { id: '1.3.0', precision: 5, symbol: 'BTS' };
        const candles = await fetchNativeMarketHistorySince(assetA, assetB, 1704067200000, 1704070800000, 3600);

        assert.strictEqual(candles.length, 1, 'native market history direct path should normalize returned candles');
        assert.strictEqual(callArgs[0], assetB.id, 'direct getMarketHistory should query quote/assetB first');
        assert.strictEqual(callArgs[1], assetA.id, 'direct getMarketHistory should query base/assetA second');
        assert.strictEqual(callArgs[2], 3600, 'direct getMarketHistory should preserve bucket size');
    } finally {
        _setBitsharesClientForTests(null);
    }
}

// AMA profile override behavior
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        ensureDir(path.dirname(MARKET_PROFILES_FILE));
        writeJSON(MARKET_PROFILES_FILE, {
            profiles: [
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA4',
                    updatedAt: '2026-03-07T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 351, fastPeriod: 3.26, slowPeriod: 802 },
                        AMA4: { erPeriod: 136, fastPeriod: 2.73, slowPeriod: 672 },
                    },
                },
            ],
        });

        const ama1 = resolveAmaForBot({ assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama1' });
        assert.strictEqual(ama1.fastPeriod, 3.26, 'market_profiles AMA1 override should preserve fractional fastPeriod');

        const amaDefault = resolveAmaForBot({ assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama' });
        assert.strictEqual(amaDefault.fastPeriod, 2.73, 'market_profiles default AMA should preserve fractional fastPeriod');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

// AMA comparison behavior should follow pair-specific profiles
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        ensureDir(path.dirname(MARKET_PROFILES_FILE));
        writeJSON(MARKET_PROFILES_FILE, {
            profiles: [
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA4',
                    updatedAt: '2026-03-07T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 2, fastPeriod: 2.1, slowPeriod: 6 },
                        AMA2: { erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
                        AMA3: { erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 },
                        AMA4: { erPeriod: 5, fastPeriod: 5.5, slowPeriod: 9 },
                    },
                },
            ],
        });

        const botAma = resolveAmaForBot(
            { assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama2' },
            null,
            null
        );
        assert.deepStrictEqual(
            {
                name: botAma.name,
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            { name: 'AMA2', erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
            'the resolved bot AMA should use the pair-specific profile preset for the requested keyword'
        );

        // The cycle records exactly ONE AMA — the one the bot trades on, reusing
        // the value the cycle already computed. No AMA1..AMA4 sweep.
        const record = buildAmaRecord(botAma, 42.5);
        assert.strictEqual(record.length, 1, 'exactly one AMA record is produced per bot');
        assert.deepStrictEqual(record[0], {
            name: 'AMA2',
            erPeriod: 3,
            fastPeriod: 3.3,
            slowPeriod: 7,
            value: 42.5,
            ok: true,
        }, 'the record must mirror the bot-configured parameters and the price the cycle already computed');

        // A bot on the profile default gets that preset, still exactly one record.
        const defaultAma = resolveAmaForBot({ assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama' }, null, null);
        assert.strictEqual(defaultAma.name, 'AMA4', 'gridPrice "ama" should follow the profile default');
        assert.strictEqual(defaultAma.slowPeriod, 9, 'profile default preset parameters must be used');
        assert.strictEqual(buildAmaRecord(defaultAma, 1).length, 1, 'still a single record');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

// Without a market profile the bot's own ama block decides, and the cycle still
// calculates exactly that one AMA.
{
    const custom = resolveAmaForBot({
        assetA: 'NOPROF_A',
        assetB: 'NOPROF_B',
        gridPrice: 'ama',
        ama: { erPeriod: 10, fastPeriod: 11, slowPeriod: 30 },
    });
    assert.deepStrictEqual(
        { name: custom.name, erPeriod: custom.erPeriod, fastPeriod: custom.fastPeriod, slowPeriod: custom.slowPeriod },
        { name: 'custom', erPeriod: 10, fastPeriod: 11, slowPeriod: 30 },
        'a bot with its own ama numbers must be reported as custom, not as a preset'
    );
    const customRecord = buildAmaRecord(custom, 7);
    assert.strictEqual(customRecord.length, 1, 'custom bots still get exactly one AMA record');
    assert.strictEqual(customRecord[0].erPeriod, 10, 'the record must use the bot\'s own erPeriod');

    const keyword = resolveAmaForBot({ assetA: 'NOPROF_A', assetB: 'NOPROF_B', gridPrice: 'ama1' });
    assert.strictEqual(keyword.name, 'AMA1', 'gridPrice keyword selects the built-in preset');
    assert.deepStrictEqual(
        { erPeriod: keyword.erPeriod, fastPeriod: keyword.fastPeriod, slowPeriod: keyword.slowPeriod },
        { erPeriod: MARKET_ADAPTER.AMAS.AMA1.erPeriod, fastPeriod: MARKET_ADAPTER.AMAS.AMA1.fastPeriod, slowPeriod: MARKET_ADAPTER.AMAS.AMA1.slowPeriod },
        'keyword-resolved parameters must match the built-in preset'
    );

    const bare = resolveAmaForBot({ assetA: 'NOPROF_A', assetB: 'NOPROF_B', gridPrice: 'ama' });
    assert.strictEqual(bare.name, 'AMA3', 'an unconfigured bot falls back to the default AMA key');
    assert.deepStrictEqual(
        { erPeriod: bare.erPeriod, fastPeriod: bare.fastPeriod, slowPeriod: bare.slowPeriod },
        { erPeriod: DEFAULT_AMA.erPeriod, fastPeriod: DEFAULT_AMA.fastPeriod, slowPeriod: DEFAULT_AMA.slowPeriod },
        'default parameters must match DEFAULT_AMA'
    );

    // A hybrid (bot numbers + keyword) is the bot's own configuration.
    const hybrid = resolveAmaForBot({
        assetA: 'NOPROF_A', assetB: 'NOPROF_B', gridPrice: 'ama1', ama: { slowPeriod: 44 },
    });
    assert.strictEqual(hybrid.name, 'custom', 'a partial override is a custom configuration');
    assert.strictEqual(hybrid.erPeriod, MARKET_ADAPTER.AMAS.AMA1.erPeriod, 'missing periods still come from the keyword preset');
    assert.strictEqual(hybrid.slowPeriod, 44, 'the bot override wins where it is set');

    // The name describes the SOURCE, not the values: a bot that hand-writes the
    // default preset's numbers is still its own configuration.
    const handwrittenDefault = resolveAmaForBot({
        assetA: 'NOPROF_A',
        assetB: 'NOPROF_B',
        gridPrice: 'ama',
        ama: { erPeriod: DEFAULT_AMA.erPeriod, fastPeriod: DEFAULT_AMA.fastPeriod, slowPeriod: DEFAULT_AMA.slowPeriod },
    });
    assert.strictEqual(handwrittenDefault.name, 'custom',
        'bot-supplied numbers must stay custom even when they equal the default preset');
    assert.deepStrictEqual(
        { erPeriod: handwrittenDefault.erPeriod, fastPeriod: handwrittenDefault.fastPeriod, slowPeriod: handwrittenDefault.slowPeriod },
        { erPeriod: DEFAULT_AMA.erPeriod, fastPeriod: DEFAULT_AMA.fastPeriod, slowPeriod: DEFAULT_AMA.slowPeriod },
        'the values themselves are unchanged'
    );

    // Non-finite prices must not produce a bogus record.
    assert.deepStrictEqual(buildAmaRecord({ erPeriod: Number.NaN }, 5), [], 'an unresolvable AMA yields no record');
    const notReady = buildAmaRecord(keyword, Number.NaN);
    assert.strictEqual(notReady.length, 1, 'the record is still reported when the value is not finite');
    assert.strictEqual(notReady[0].value, null, 'a non-finite price is reported as null');
    assert.strictEqual(notReady[0].ok, false, 'a non-finite price is flagged not ok');
}

// Flipped market_profiles entries should still match, but exact orientation should win if both exist.
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        ensureDir(path.dirname(MARKET_PROFILES_FILE));
        writeJSON(MARKET_PROFILES_FILE, {
            profiles: [
                {
                    assetA: 'TESTB',
                    assetB: 'TESTA',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA1',
                    updatedAt: '2026-03-08T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 2, fastPeriod: 2.2, slowPeriod: 6 },
                    },
                },
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA1',
                    updatedAt: '2026-03-07T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 2, fastPeriod: 1.1, slowPeriod: 5 },
                    },
                },
            ],
        });

        const exactAma = resolveAmaForBot({ assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama1' });
        assert.strictEqual(exactAma.fastPeriod, 1.1, 'exact profile orientation should win over a newer flipped profile');

        writeJSON(MARKET_PROFILES_FILE, {
            profiles: [
                {
                    assetA: 'TESTB',
                    assetB: 'TESTA',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA1',
                    updatedAt: '2026-03-08T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 2, fastPeriod: 2.2, slowPeriod: 6 },
                    },
                },
            ],
        });

        const flippedAma = resolveAmaForBot({ assetA: 'TESTA', assetB: 'TESTB', gridPrice: 'ama1' });
        assert.strictEqual(flippedAma.fastPeriod, 2.2, 'flipped profile should remain a valid fallback when no exact profile exists');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

// The AMA override layers, end to end. `profiles/market_profiles.json` supplies
// the per-market preset, `gridPrice` selects which one, `cfg.defaultAmaKey`
// overrides the profile default, and the bot's own `ama` block is the fallback
// when no profile matches. Every row is asserted on the resolved PARAMETERS, so
// a future refactor cannot quietly change which layer wins.
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        writeJSON(MARKET_PROFILES_FILE, {
            profiles: [
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    defaultAma: 'AMA3',
                    updatedAt: '2026-03-07T00:00:00.000Z',
                    amas: {
                        AMA1: { erPeriod: 2, fastPeriod: 2.1, slowPeriod: 6 },
                        AMA2: { erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
                        AMA3: { erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 },
                        AMA4: { erPeriod: 5, fastPeriod: 5.5, slowPeriod: 9 },
                    },
                },
            ],
        });

        const PROFILED = { assetA: 'TESTA', assetB: 'TESTB' };
        const UNPROFILED = { assetA: 'NOPROF_A', assetB: 'NOPROF_B' };
        const BUILTIN = (key) => ({
            name: key,
            erPeriod: MARKET_ADAPTER.AMAS[key].erPeriod,
            fastPeriod: MARKET_ADAPTER.AMAS[key].fastPeriod,
            slowPeriod: MARKET_ADAPTER.AMAS[key].slowPeriod,
        });
        const cases = [
            // [label, bot, cfg, expected]
            ['profile wins: gridPrice keyword picks the profile preset',
                { ...PROFILED, gridPrice: 'ama2' }, null, { name: 'AMA2', erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 }],
            ['profile wins: gridPrice "ama" uses the profile default',
                { ...PROFILED, gridPrice: 'ama' }, null, { name: 'AMA3', erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 }],
            ['cfg.defaultAmaKey overrides the profile default',
                { ...PROFILED, gridPrice: 'ama' }, { defaultAmaKey: 'AMA1' }, { name: 'AMA1', erPeriod: 2, fastPeriod: 2.1, slowPeriod: 6 }],
            ['an unknown defaultAmaKey falls back to the profile default',
                { ...PROFILED, gridPrice: 'ama' }, { defaultAmaKey: 'AMA9' }, { name: 'AMA3', erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 }],
            ['a matched profile outranks the bot ama numbers (documented precedence)',
                { ...PROFILED, gridPrice: 'ama2', ama: { erPeriod: 10, fastPeriod: 11, slowPeriod: 40 } }, null,
                { name: 'AMA2', erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 }],
            ['no profile: the bot ama block is the fallback',
                { ...UNPROFILED, gridPrice: 'ama2', ama: { erPeriod: 10, fastPeriod: 11, slowPeriod: 40 } }, null,
                { name: 'custom', erPeriod: 10, fastPeriod: 11, slowPeriod: 40 }],
            ['no profile: gridPrice keyword uses the built-in preset',
                { ...UNPROFILED, gridPrice: 'ama1' }, null, BUILTIN('AMA1')],
            ['no profile: a partial bot override fills the rest from the keyword preset',
                { ...UNPROFILED, gridPrice: 'ama4', ama: { erPeriod: 12 } }, null,
                { name: 'custom', erPeriod: 12, fastPeriod: BUILTIN('AMA4').fastPeriod, slowPeriod: BUILTIN('AMA4').slowPeriod }],
            ['no profile and no keyword: the built-in default preset',
                { ...UNPROFILED, gridPrice: 'fixed' }, null, BUILTIN('AMA3')],
        ];

        for (const [label, bot, cfg, expected] of cases) {
            const resolved = resolveAmaForBot(bot, null, cfg);
            assert.deepStrictEqual({
                name: resolved.name,
                erPeriod: resolved.erPeriod,
                fastPeriod: resolved.fastPeriod,
                slowPeriod: resolved.slowPeriod,
            }, expected, label);

            // The single persisted/logged record must mirror the resolved config
            // exactly — it is the same numbers the cycle computed the AMA with.
            const record = buildAmaRecord(resolved, 12.5);
            assert.strictEqual(record.length, 1, `${label}: exactly one AMA record`);
            assert.deepStrictEqual({
                name: record[0].name,
                erPeriod: record[0].erPeriod,
                fastPeriod: record[0].fastPeriod,
                slowPeriod: record[0].slowPeriod,
            }, expected, `${label}: the record must mirror the resolved config`);
        }

        // `gridPrice` is the ONLY switch that makes a bot AMA-driven, so a
        // leftover `ama.enabled: false` must not change what the adapter does.
        // It used to: the no-profile path honoured it (freezing the published
        // center while the bot kept trading on it) while the profile path
        // hardcoded true, so the same config behaved differently per pair.
        for (const [label, bot] of [
            ['profiled pair', { ...PROFILED, gridPrice: 'ama2', ama: { enabled: false } }],
            ['profile-less pair', { ...UNPROFILED, gridPrice: 'ama2', ama: { enabled: false } }],
        ]) {
            const resolved = resolveAmaForBot(bot, null, null);
            assert.strictEqual(resolved.enabled, true,
                `${label}: ama.enabled must not disable the adapter (gridPrice is the only switch)`);
        }
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

// LP chart profile loader should mirror runtime pair matching.
{
    const hadOriginal = fs.existsSync(MARKET_PROFILES_FILE);
    const original = hadOriginal ? fs.readFileSync(MARKET_PROFILES_FILE, 'utf8') : null;

    try {
        ensureDir(path.dirname(MARKET_PROFILES_FILE));
        writeJSON(MARKET_PROFILES_FILE, {
            profiles: [
                {
                    assetA: 'TESTB',
                    assetB: 'TESTA',
                    intervalSeconds: 3600,
                    updatedAt: '2026-03-08T00:00:00.000Z',
                    amas: {
                        AMA1: { name: 'Flipped AMA1', erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
                        AMA2: { name: 'Flipped AMA2', erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 },
                        AMA3: { name: 'Flipped AMA3', erPeriod: 5, fastPeriod: 5.5, slowPeriod: 9 },
                        AMA4: { name: 'Flipped AMA4', erPeriod: 6, fastPeriod: 6.6, slowPeriod: 10 },
                    },
                },
                {
                    assetA: 'TESTA',
                    assetB: 'TESTB',
                    intervalSeconds: 3600,
                    updatedAt: '2026-03-07T00:00:00.000Z',
                    amas: {
                        AMA1: { name: 'Exact AMA1', erPeriod: 1, fastPeriod: 1.1, slowPeriod: 5 },
                        AMA2: { name: 'Exact AMA2', erPeriod: 2, fastPeriod: 2.2, slowPeriod: 6 },
                        AMA3: { name: 'Exact AMA3', erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
                        AMA4: { name: 'Exact AMA4', erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 },
                    },
                },
            ],
        });

        const meta = {
            assetA: { symbol: 'TESTA', id: '1.3.1' },
            assetB: { symbol: 'TESTB', id: '1.3.0' },
            intervalSeconds: 3600,
        };
        const exactStrategies = loadStrategiesFromProfiles(MARKET_PROFILES_FILE, meta);
        assert.strictEqual(exactStrategies[0].name, 'Exact AMA1', 'LP chart loader should prefer an exact orientation match');

        writeJSON(MARKET_PROFILES_FILE, {
            profiles: [
                {
                    assetA: 'TESTB',
                    assetB: 'TESTA',
                    intervalSeconds: 3600,
                    updatedAt: '2026-03-08T00:00:00.000Z',
                    amas: {
                        AMA1: { name: 'Flipped AMA1', erPeriod: 3, fastPeriod: 3.3, slowPeriod: 7 },
                        AMA2: { name: 'Flipped AMA2', erPeriod: 4, fastPeriod: 4.4, slowPeriod: 8 },
                        AMA3: { name: 'Flipped AMA3', erPeriod: 5, fastPeriod: 5.5, slowPeriod: 9 },
                        AMA4: { name: 'Flipped AMA4', erPeriod: 6, fastPeriod: 6.6, slowPeriod: 10 },
                    },
                },
            ],
        });

        const flippedStrategies = loadStrategiesFromProfiles(MARKET_PROFILES_FILE, meta);
        assert.strictEqual(flippedStrategies[0].name, 'Flipped AMA1', 'LP chart loader should still accept a flipped profile as fallback');
    } finally {
        if (hadOriginal) {
            fs.writeFileSync(MARKET_PROFILES_FILE, original, 'utf8');
        } else if (fs.existsSync(MARKET_PROFILES_FILE)) {
            fs.unlinkSync(MARKET_PROFILES_FILE);
        }
    }
}

testNativeMarketHistoryDirectOrder()
    .then(() => {
        console.log('market_adapter logic tests passed');
        process.exit(0);
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

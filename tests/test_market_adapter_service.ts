const assert = require('assert');
const path = require('path');

console.log('Running market adapter service tests');

const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { detectMissingCandleTimestamps, fillCandleGaps, mergeCandles, pruneStaleTail } = require('../market_adapter/candle_utils');
const { calculateATR } = require('../market_adapter/core/strategies/atr/calculator');
const { getErrorMessage } = require('../modules/utils/errors');
const {
    computeAmaSlopeWeights,
    computeAmaSlopeEmaSeries,
    computeHuberWindowSlopePct,
} = require('../market_adapter/core/strategies/ama_slope_model');
const { normalizeAtrPeriod, normalizeMaxVolatilityOffset, normalizeVolatilityThreshold, normalizeAmaSlopeEmaAlpha } = require('../market_adapter/core/config_normalizers');
const { computeRegimeMultiplier } = require('../market_adapter/core/strategies/regime_gate');
const { MARKET_ADAPTER } = require('../modules/constants');
const { calculateAMA, getAmaWarmupBars } = require('../market_adapter/core/strategies/ama');
const { KalmanTrendAnalyzer } = require('../analysis/trend_detection/kalman_trend_analyzer');
const { buildKalmanVelocitySeries, computeAbsolutePercentileThreshold } = require('../analysis/trend_detection/kalman_velocity_smoothing');
const { computeDynamicWeightSeries } = require('../market_adapter/core/strategies/dynamic_weight_series');
const { sleepUntilAlignedBoundary, computeStartupDelayMs, evaluateStartupSleep } = require('../market_adapter/test_helpers');
const { roundToDecimals } = require('../modules/order/utils/math');

function generateCandles(count, price) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function generateVolatileFlatCandles(count, close = 100, high = 110, low = 90) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        candles.push([baseTs + i * 3600000, close, high, low, close, 1]);
    }
    return candles;
}

function generateTrendingCandles(count, start = 100, step = 0.2) {
    const candles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < count; i++) {
        const price = start + i * step;
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function generateTrendShiftCandles(count, start = 100) {
    const candles = [];
    const baseTs = 1700000000000;
    let open = start;
    for (let i = 0; i < count; i++) {
        let drift = 0.28;
        if (i >= 110 && i < 190) drift = -0.42;
        else if (i >= 190 && i < 250) drift = 0.06;
        else if (i >= 250) drift = 0.36;

        const wave = ((i % 9) - 4) * 0.035;
        const close = Math.max(1, open + drift + wave);
        const high = Math.max(open, close) + 0.45 + ((i % 5) * 0.03);
        const low = Math.max(0.01, Math.min(open, close) - 0.38 - ((i % 4) * 0.02));
        candles.push([baseTs + i * 3600000, open, high, low, close, 1]);
        open = close;
    }
    return candles;
}

function generateUpThenFlatCandles(upCount, flatCount, start = 100, step = 1) {
    const candles = [];
    const baseTs = 1700000000000;
    let price = start;
    for (let i = 0; i < upCount; i++) {
        price = start + i * step;
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    for (let i = 0; i < flatCount; i++) {
        const index = upCount + i;
        candles.push([baseTs + index * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function generateUpThenDownCandles(upCount, downCount, start = 100, upStep = 0.4, downStep = 0.5) {
    const candles = [];
    const baseTs = 1700000000000;
    let price = start;
    for (let i = 0; i < upCount; i++) {
        price = start + i * upStep;
        candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
    }
    for (let i = 0; i < downCount; i++) {
        const index = upCount + i;
        price = Math.max(1, price - downStep);
        candles.push([baseTs + index * 3600000, price, price, price, price, 1]);
    }
    return candles;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function buildDynamicWeightParityInputs(candles, cfg, botAma) {
    const closes = candles.map((c) => Number(c[4])).filter((value) => Number.isFinite(value) && value > 0);
    const amaErPeriod = cfg.amaSlope?.erPeriod ?? botAma.erPeriod;
    const amaSlowPeriod = cfg.amaSlope?.slowPeriod ?? botAma.slowPeriod;
    const rawLookbackBars = cfg.amaSlope?.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const lookbackBars = Number.isFinite(Number(rawLookbackBars)) && Number(rawLookbackBars) > 0
        ? Math.ceil(Number(rawLookbackBars))
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const amaValues = calculateAMA(closes, botAma);
    const amaPrice = amaValues[amaValues.length - 1] ?? null;
    const atrPeriod = normalizeAtrPeriod(cfg.atrPeriod);
    const atr = calculateATR(candles, atrPeriod);
    const weightVariance = Number.isFinite(atr) && amaPrice > 0 ? (atr / amaPrice) : 0;

    const clipPercentile = cfg.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
    const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
    const amaSlopeMaxPct = cfg.amaSlope?.maxSlopePct
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
    const kalmanSlopeMaxPct = cfg.kalmanSlope?.maxSlopePct
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
    const offsetClamp = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
    const volatilityClamp = normalizeMaxVolatilityOffset(cfg.maxVolatilityOffset);
    const amaFastPeriod = cfg.amaSlope?.fastPeriod ?? botAma.fastPeriod;
    const amaWarmupBars = getAmaWarmupBars(
        amaErPeriod,
        amaSlowPeriod,
        lookbackBars,
        amaFastPeriod
    );
    const amaSlopeReadyBars = Math.ceil(amaErPeriod) + lookbackBars;
    const emaAlpha = normalizeAmaSlopeEmaAlpha(cfg.amaSlope?.emaAlpha ?? cfg.amaSlopeEmaAlpha);
    const amaSlopePctSeries = computeAmaSlopeEmaSeries(amaValues, amaErPeriod, lookbackBars, emaAlpha);

    let amaClipThreshold = Infinity;
    if (clipPercentile > 0 && amaValues.length > amaSlopeReadyBars) {
        const amaSlopes = [];
        for (let i = amaSlopeReadyBars; i < amaValues.length; i++) {
            const slopePct = computeHuberWindowSlopePct(amaValues, i, lookbackBars);
            if (Number.isFinite(slopePct)) amaSlopes.push(Math.abs(slopePct));
        }
        if (amaSlopes.length > 0) {
            amaSlopes.sort((a, b) => a - b);
            const idx = Math.min(Math.floor((100 - clipPercentile) / 100 * amaSlopes.length), amaSlopes.length - 1);
            amaClipThreshold = amaSlopes[idx];
        }
    }

    const slopeCfg = {
        ...(cfg.amaSlope || {}),
        erPeriod: amaErPeriod,
        slowPeriod: amaSlowPeriod,
        fastPeriod: amaFastPeriod,
        maxSlopeOffset: cfg.maxSlopeOffset,
        maxVolatilityOffset: volatilityClamp,
        volatilityExponent: cfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
        volatilityScaleX: cfg.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
        volatilityThreshold: normalizeVolatilityThreshold(cfg.volatilityThreshold),
        neutralZonePct: nz,
        clipPercentile,
        clipThreshold: amaClipThreshold,
        slopePctSeries: amaSlopePctSeries,
    };

    const slopeResult = computeAmaSlopeWeights(amaValues, weightVariance, slopeCfg);

    const kalman = new KalmanTrendAnalyzer({
        rNoise: cfg.kalman?.rNoise ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_R_NOISE_DEFAULT,
        qTactical: cfg.kalman?.qTactical ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_TACTICAL_DEFAULT,
        qModal: cfg.kalman?.qModal ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_MODAL_DEFAULT,
        warmupBars: cfg.kalman?.warmupBars ?? 20,
    });
    const kalmanHistory = [];
    for (const close of closes) kalmanHistory.push(kalman.update(close));

    const kalmanRawPoints = kalmanHistory.map((kr) => ({
        velocityPct: kr.velocityRawPct ?? kr.velocityPct,
        displacementPct: kr.displacementRawPct ?? kr.displacementPct,
    }));
    const kalmanSmoothedVelocityPct = buildKalmanVelocitySeries(kalmanRawPoints, {
        kalmanSmoothPct: cfg.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT,
        kalmanDispScaleMult: cfg.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT,
        kalmanDispThresholdMult: cfg.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT,
        kalmanSmoothSpanPct: cfg.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT,
    });
    const kalClipThreshold = computeAbsolutePercentileThreshold(
        kalmanSmoothedVelocityPct,
        clipPercentile,
        Infinity
    );

    const regimeSensitivity = cfg.regimeSensitivity ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY;
    const absoluteThreshold = cfg.absoluteThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT;
    const regimeMultipliers = new Array(closes.length).fill(1.0);
    if (regimeSensitivity > 0) {
        const regimeResult = computeRegimeMultiplier(closes, {
            regimeSensitivity,
            regimeTable: cfg.regimeTable,
            hurstZoneBand: cfg.hurstZoneBand,
            peNodes: cfg.peNodes,
        });
        if (Array.isArray(regimeResult.series) && regimeResult.series.length === closes.length) {
            for (let i = 0; i < closes.length; i++) {
                const rawMult = regimeResult.series[i];
                regimeMultipliers[i] = Math.abs(rawMult - 1.0) >= absoluteThreshold ? rawMult : 1.0;
            }
        }
    }

    const alpha = cfg.alpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA;
    const dw = cfg.dw ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DW;
    const gain = cfg.gain ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN;
    const minOutputThreshold = cfg.minOutputThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD;
    const signalConfirmBars = Math.max(0, Math.min(5, Math.round(
        cfg.signalConfirmBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT
    )));
    const dispScaleMinPct = cfg.dispScaleMinPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT;

    // Per-bar series via the canonical shared pipeline (same module the live
    // service and the research chart use) — exposes the offset channels plus
    // the raw inputs so callers can re-run with a different clamp mode.
    const seriesResult = computeDynamicWeightSeries({
        amaValues,
        amaSlopePctSeries,
        kalmanVelocityPct: kalmanSmoothedVelocityPct,
        kalmanDisplacementPct: kalmanHistory.map((point) => point.displacementRawPct),
        kalmanIsReady: kalmanHistory.map((point) => point.isReady),
        regimeMultipliers,
        lookbackBars,
        amaErPeriod,
        amaClipThreshold,
        kalClipThreshold,
        neutralZonePct: nz,
        amaMaxSlopePct: amaSlopeMaxPct,
        kalmanMaxSlopePct: kalmanSlopeMaxPct,
        offsetClamp,
        dispScaleMinPct,
        alpha,
        dw,
        gain,
        minOutputThreshold,
        signalConfirmBars,
        clampFinalOutput: true,
    });

    return {
        alpha,
        gain,
        minOutputThreshold,
        signalConfirmBars,
        offsetClamp,
        emaAlpha,
        amaSlopePctSeries,
        amaValues,
        kalmanVelocityPct: kalmanSmoothedVelocityPct,
        kalmanDisplacementPct: kalmanHistory.map((point) => point.displacementRawPct),
        kalmanIsReady: kalmanHistory.map((point) => point.isReady),
        regimeMultipliers,
        lookbackBars,
        amaErPeriod,
        amaClipThreshold,
        kalClipThreshold,
        neutralZonePct: nz,
        amaMaxSlopePct: amaSlopeMaxPct,
        kalmanMaxSlopePct: kalmanSlopeMaxPct,
        dispScaleMinPct,
        dw,
        amaOffsets: seriesResult.amaOffsets,
        kalmanOffsets: seriesResult.kalmanOffsets,
        slopeResult,
    };
}

function computeDirectionalOffsetSeries(parityInputs, { clampFinalOutput }) {
    const seriesResult = computeDynamicWeightSeries({ ...parityInputs, clampFinalOutput });

    return {
        gatedOffSeries: seriesResult.gatedOffSeries,
        combinedOffSeries: seriesResult.combinedOffSeries,
        echoedOffSeries: seriesResult.echoedOffSeries,
        echoedGatedOffSeries: seriesResult.echoedGatedOffSeries,
        rawFinalOff: seriesResult.combinedOffSeries[seriesResult.combinedOffSeries.length - 1] ?? 0,
        rawFinalPreGainOff: seriesResult.gatedOffSeries[seriesResult.gatedOffSeries.length - 1] ?? 0,
        finalPreGainOff: seriesResult.echoedGatedOffSeries[seriesResult.echoedGatedOffSeries.length - 1] ?? 0,
        finalOff: seriesResult.echoedOffSeries[seriesResult.echoedOffSeries.length - 1] ?? 0,
    };
}

async function testTriggerHookCalledOnThreshold() {
    let triggerHookCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => null,
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => generateCandles(110, 105),
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-0': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {
        onTrigger: async (payload) => {
            triggerHookCalls += 1;
            assert.strictEqual(payload.botKey, 'aaa-bbb-0');
            assert.strictEqual(payload.triggerPath, '/tmp/recalculate.aaa-bbb-0.trigger');
        },
    });

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'trigger should fire when delta exceeds threshold');
    assert.strictEqual(triggerHookCalls, 1, 'onTrigger hook should be called exactly once');
}

async function testNumericStartPriceSkipsAllMarketFetches() {
    let resolveCalls = 0;
    let poolCalls = 0;
    let bookCalls = 0;
    let saveCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => {
            resolveCalls += 1;
            return {
                assetA: { id: '1.3.1', precision: 4, symbol: 'AAA' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: '1.19.133',
                marketSource: 'pool',
            };
        },
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_fixed_1h.json`),
        loadJson: () => {
            throw new Error('loadJson should not run for fixed startPrice bots');
        },
        saveJson: () => {
            saveCalls += 1;
        },
        calculateBotThreshold: () => 0.75,
        kibanaSource: {
            getLpCandlesForPool: async () => {
                poolCalls += 1;
                throw new Error('pool fetch should not run for fixed startPrice bots');
            },
        },
        kibanaMarketSource: {
            getMarketCandles: async () => {
                bookCalls += 1;
                throw new Error('book fetch should not run for fixed startPrice bots');
            },
        },
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'Fixed',
        botKey: 'fixed-start-price',
        assetA: 'AAA',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 1.25,
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should short-circuit successfully');
    assert.strictEqual(result.source, 'fixed-start-price', 'fixed startPrice should use the fixed-price source label');
    assert.strictEqual(resolveCalls, 0, 'resolveBotContext should not run for fixed startPrice bots');
    assert.strictEqual(poolCalls, 0, 'LP fetch should be skipped for fixed startPrice bots');
    assert.strictEqual(bookCalls, 0, 'book fetch should be skipped for fixed startPrice bots');
    assert.strictEqual(saveCalls, 0, 'no candle file should be written for fixed startPrice bots');
    assert.strictEqual((state.bots['fixed-start-price'] as any).priceMode, 'fixed', 'state should record fixed-price mode');
    assert.strictEqual((state.bots['fixed-start-price'] as any).candleFile, null, 'fixed-price state should clear any previous candle file reference');
    assert.strictEqual((state.bots['fixed-start-price'] as any).centerPrice, null, 'fixed-price state should clear any previous market center');
}

async function testBookNativeFetchUsesBitsharesHistory() {
    let savedPayload = null;
    let nativeCalls = 0;
    let kibanaCalls = 0;

    const lastTs = 1700003600000;
    const nowMs = 1700007200000;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: null,
            marketSource: 'book',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_book_1h.json`),
        loadJson: () => ({
            meta: { marketSource: 'book' },
            candles: Array.from({ length: 90 }, (_, idx) => {
                const ts = lastTs - ((89 - idx) * 3600000);
                const price = idx < 89 ? 0.19 : 0.2;
                return [ts, price, price, price, price, 8];
            }),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 0.75,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1 }),
        withRetries: async (fn) => fn(),
        fillCandleGaps,
        fetchNativeMarketHistorySince: async (assetA, assetB, sinceMs, untilMs, intervalSeconds, options) => {
            nativeCalls += 1;
            assert.strictEqual(assetA.symbol, 'IOB.XRP', 'native history should query the requested assetA');
            assert.strictEqual(assetB.symbol, 'BTS', 'native history should query the requested assetB');
            assert.strictEqual(intervalSeconds, 3600, 'native history should query the 1h bucket');
            assert.strictEqual(options.fillCandleGaps, fillCandleGaps, 'native history should use the shared gap filler');
            assert.strictEqual(sinceMs, lastTs - 3600000, 'incremental native fetch should overlap one bucket back');
            assert.strictEqual(untilMs, nowMs, 'native fetch should cap at the current cycle time');
            return [
                [lastTs, 0.2, 0.2, 0.2, 0.2, 18],
                [lastTs + 3600000, 0.22, 0.22, 0.22, 0.22, 19],
            ];
        },
        kibanaMarketSource: {
            getMarketCandles: async () => {
                kibanaCalls += 1;
                throw new Error('book Kibana fetch should not run when native history is available');
            },
        },
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('LP fetch should not run for book bots');
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            for (const candle of existing) map.set(candle[0], candle);
            for (const candle of incoming) map.set(candle[0], candle);
            return [...map.values()].sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.book.trigger',
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'IOB.XRP/BTS',
        botKey: 'iob-aaa-bbb-book',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 'book',
    };

    const state = {
        bots: {
            'iob-aaa-bbb-book': {
                centerPrice: 0.2,
                amaCenterPrice: 0.2,
                lastClosedCandleTs: lastTs,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 1,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed for book bots');
    assert.strictEqual(nativeCalls, 1, 'book mode should use native BitShares history');
    assert.strictEqual(kibanaCalls, 0, 'book mode should not hit Kibana when native history returns data');
    assert.strictEqual(result.source, 'native-book-history', 'book mode should label native history updates');
    assert.ok(savedPayload?.candles?.length >= 3, 'native merge should retain the prior candle and add new history');
    assert.strictEqual(savedPayload.meta.marketSource, 'book', 'saved payload should mark the bot as book sourced');
}

async function testBookIncrementalFillsVerifiedLongSilence() {
    let savedPayload = null;
    let silenceVerificationCalls = 0;
    let kibanaCalls = 0;
    const logs = [];
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (38 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: null,
            marketSource: 'book',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_book_1h.json`),
        loadJson: () => ({
            meta: { marketSource: 'book' },
            candles: Array.from({ length: 90 }, (_, idx) => {
                const ts = baseTs - ((89 - idx) * hour);
                const price = idx < 89 ? 90 + idx : 100;
                return [ts, price, price, price, price, 1];
            }),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        fetchNativeMarketHistorySince: async () => [],
        kibanaMarketSource: {
            getMarketCandles: async (_assetA, _assetB, cfg) => {
                kibanaCalls += 1;
                if (cfg.timeRange?.gte === new Date(baseTs + hour).toISOString()
                        && cfg.timeRange?.lte === new Date(baseTs + (37 * hour)).toISOString()) {
                    silenceVerificationCalls += 1;
                }
                return [];
            },
        },
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('LP fetch should not run for book silence verification');
            },
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.book-silence.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        logger: {
            log: (message, level) => logs.push({ message, level }),
        },
        root: process.cwd(),
        path,
    });

    const result = await service.processBot({
        name: 'IOB.XRP/BTS',
        botKey: 'iob-aaa-bbb-book-silence',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 'book',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 1,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'book processBot should complete after verified long silence');
    assert.ok(kibanaCalls >= 1, 'book flow should use book Kibana candles');
    assert.strictEqual(silenceVerificationCalls, 1, 'book verified silence query should cover the missing closed buckets once');
    assert.strictEqual(savedPayload.meta.marketSource, 'book', 'saved payload should remain book sourced');
    assert.ok(savedPayload.candles.length >= 38, 'book verified silence should preserve enough continuous flat candles');
    assert.strictEqual(savedPayload.candles[savedPayload.candles.length - 1][0], baseTs + (37 * hour), 'book verified silence should extend through the latest closed bucket');
    assert.strictEqual(savedPayload.candles[savedPayload.candles.length - 1][4], 100, 'book verified silence should carry the prior close');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedStartTs, baseTs + hour, 'book verified silence start should be saved');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedEndTs, baseTs + (37 * hour), 'book verified silence end should be saved');
    assert.strictEqual(result.staleData, false, 'book verified silence should not look like stale data');
    assert.ok(logs.some((entry) => entry.level === 'info' && entry.message.includes('verified no trades')), 'book verified silence should be logged');
}

async function testBookIncrementalFillsBoundedNoTradeSilence() {
    let savedPayload = null;
    let kibanaCalls = 0;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (5 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: null,
            marketSource: 'book',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_book_1h.json`),
        loadJson: () => ({
            meta: { marketSource: 'book' },
            candles: Array.from({ length: 90 }, (_, idx) => {
                const ts = baseTs - ((89 - idx) * hour);
                const price = idx < 89 ? 90 + idx : 100;
                return [ts, price, price, price, price, idx < 89 ? 1 : 0];
            }),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        fetchNativeMarketHistorySince: async () => [],
        kibanaMarketSource: {
            getMarketCandles: async () => {
                kibanaCalls += 1;
                throw new Error('bounded book silence should not require Kibana verification');
            },
        },
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('LP fetch should not run for book bots');
            },
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.book-bounded-silence.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const result = await service.processBot({
        name: 'IOB.XRP/BTS',
        botKey: 'iob-aaa-bbb-book-bounded-silence',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 'book',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 1,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'book processBot should complete after bounded no-trade silence');
    assert.strictEqual(kibanaCalls, 0, 'bounded book silence should not call Kibana');
    assert.strictEqual(savedPayload.meta.marketSource, 'book', 'saved payload should remain book sourced');
    assert.strictEqual(savedPayload.candles.length, 94, 'bounded book silence should be materialized as flat closed candles');
    assert.strictEqual(savedPayload.candles[93][0], baseTs + (4 * hour), 'bounded book silence should extend through the latest closed bucket');
    assert.strictEqual(savedPayload.candles[93][4], 100, 'bounded book silence should carry the prior close');
    assert.strictEqual(result.triggerSuppressedReason, null, 'bounded silence should pass the closed-candle gate');
    assert.strictEqual(result.unresolvedGapCount, 0, 'bounded book silence should not leave unresolved gaps');
}

async function testBookIncrementalFillsVerifiedLongSilenceBeforeLaterNativeActivity() {
    let savedPayload = null;
    let kibanaCalls = 0;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (70 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: null,
            marketSource: 'book',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_book_1h.json`),
        loadJson: () => ({
            meta: { marketSource: 'book' },
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        fetchNativeMarketHistorySince: async () => [
            [baseTs + (50 * hour), 120, 120, 120, 120, 2],
        ],
        kibanaMarketSource: {
            getMarketCandles: async (_assetA, _assetB, cfg) => {
                kibanaCalls += 1;
                assert.deepStrictEqual(
                    cfg.timeRange,
                    {
                        gte: new Date(baseTs + hour).toISOString(),
                        lte: new Date(baseTs + (49 * hour)).toISOString(),
                    },
                    'book silence verification should stop before the first later native candle'
                );
                return [];
            },
        },
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('LP fetch should not run for book silence verification');
            },
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.book-silence-later-activity.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const result = await service.processBot({
        name: 'IOB.XRP/BTS',
        botKey: 'iob-aaa-bbb-book-silence-later-activity',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 'book',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 1,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'book processBot should complete when later native activity follows verified silence');
    assert.strictEqual(kibanaCalls, 1, 'book mixed silence verification should call Kibana once');
    assert.strictEqual(savedPayload.candles.length, 70, 'book mixed silence should remain a continuous hourly series');
    assert.strictEqual(savedPayload.candles[49][4], 100, 'book verified pre-activity silence should keep the prior close');
    assert.strictEqual(savedPayload.candles[50][4], 120, 'book later native activity should remain a real candle');
    assert.strictEqual(savedPayload.candles[69][4], 120, 'book bounded post-activity silence should be filled from the later native close');
    assert.strictEqual(result.unresolvedGapCount, 0, 'book mixed silence should not leave unresolved gaps');
}

async function testBookIncrementalIgnoresNativeOverlapWhenVerifyingSilenceBeforeActivity() {
    let savedPayload = null;
    let kibanaCalls = 0;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (70 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: null,
            marketSource: 'book',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_book_1h.json`),
        loadJson: () => ({
            meta: { marketSource: 'book' },
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        fetchNativeMarketHistorySince: async () => [
            [baseTs, 100, 100, 100, 100, 3],
            [baseTs + (50 * hour), 120, 120, 120, 120, 2],
        ],
        kibanaMarketSource: {
            getMarketCandles: async (_assetA, _assetB, cfg) => {
                kibanaCalls += 1;
                assert.deepStrictEqual(
                    cfg.timeRange,
                    {
                        gte: new Date(baseTs + hour).toISOString(),
                        lte: new Date(baseTs + (49 * hour)).toISOString(),
                    },
                    'book silence verification should ignore overlap candles and stop before later activity'
                );
                return [];
            },
        },
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('LP fetch should not run for book silence verification');
            },
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.book-silence-overlap-later-activity.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const result = await service.processBot({
        name: 'IOB.XRP/BTS',
        botKey: 'iob-aaa-bbb-book-silence-overlap-later-activity',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        startPrice: 'book',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 1,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'book processBot should complete when native history includes overlap plus later activity');
    assert.strictEqual(kibanaCalls, 1, 'book overlap scenario should verify the long silence once');
    assert.strictEqual(savedPayload.candles.length, 70, 'book overlap scenario should remain a continuous hourly series');
    assert.strictEqual(savedPayload.candles[49][4], 100, 'verified pre-activity silence should keep the prior close');
    assert.strictEqual(savedPayload.candles[50][4], 120, 'later native activity should remain a real candle');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedStartTs, null, 'post-activity bounded fill should not be marked as verified long silence');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedEndTs, null, 'verified silence metadata should not extend across later native activity');
    assert.strictEqual(result.unresolvedGapCount, 0, 'book overlap mixed silence should not leave unresolved gaps');
}

async function testAmaWithFlatCandlesComputesValidPrice() {
    let triggerWrites = 0;
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(30, 105) }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-warmup.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        isBotAsymmetricBoundsWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-warmup',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    const state = { bots: { 'aaa-bbb-warmup': { centerPrice: 100, amaCenterPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete with valid AMA');
    assert.strictEqual(result.amaPrice, 105, 'AMA price should be computed (SMA init from flat 105 candles)');
    assert.strictEqual(triggerWrites, 1, 'amaPrice drift from centerPrice=100 triggers recenter');
}

async function testKibanaBackfillFillsHistoricalShortfall() {
    let kibanaCalls = 0;
    const backfillCandles = [];
    const baseTs = 1700000000000;
    for (let i = 0; i < 54; i++) {
        backfillCandles.push([baseTs - (54 - i) * 3600000, 100, 100, 100, 100, 1]);
    }

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(60, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (poolId, assetA, assetB, options) => {
                kibanaCalls += 1;
                if (options.timeRange) {
                    return backfillCandles;
                }
                return [];
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            [...existing, ...incoming].forEach(c => map.set(c[0], c));
            return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles, keepCount) => {
            if (candles.length <= keepCount) return candles;
            return candles.slice(candles.length - keepCount);
        },
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-backfill.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-backfill',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete with backfill');
    assert.strictEqual(result.kibanaBackfillCount, 54, 'backfill should report all candles returned by Kibana');
    assert.strictEqual(result.candleCount, 114, 'total candles should equal merged set when rawKeepCount exceeds available candles');
    assert.ok(result.source.includes('kibana-backfill'), 'source label should include backfill marker');
    assert.strictEqual(kibanaCalls, 1, 'kibana should be called exactly once for backfill');
}

function buildRestartCandles(rawCount, nowMs, price = 100, intervalSeconds = 3600) {
    const bucketMs = intervalSeconds * 1000;
    const currentBucketStartMs = Math.floor(nowMs / bucketMs) * bucketMs;
    const firstTs = currentBucketStartMs - ((rawCount - 1) * bucketMs);
    const candles = [];
    for (let i = 0; i < rawCount; i++) {
        const ts = firstTs + (i * bucketMs);
        candles.push([ts, price, price, price, price, 1]);
    }
    return candles;
}

function buildOlderBackfillCandles(existingOldestTs, count, price = 100, intervalSeconds = 3600) {
    const bucketMs = intervalSeconds * 1000;
    const candles = [];
    for (let i = count; i >= 1; i--) {
        const ts = existingOldestTs - (i * bucketMs);
        candles.push([ts, price, price, price, price, 1]);
    }
    return candles;
}

async function testRestartBackfillsOldAma3WindowBeforeWaitingForNextClosedCandle() {
    const ama3 = MARKET_ADAPTER.AMAS.AMA3;
    const intervalSeconds = 3600;
    const nowMs = Date.parse('2026-05-06T12:30:00Z');
    const analysisKeepCount = getAmaWarmupBars(
        ama3.erPeriod,
        ama3.slowPeriod,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        ama3.fastPeriod
    ) + 1;
    const rawKeepCount = analysisKeepCount + 1;
    const oldRawCount = 1700;
    const missingCount = rawKeepCount - oldRawCount;
    const oldCandles = buildRestartCandles(oldRawCount, nowMs, 100, intervalSeconds);
    const latestClosedTs = oldCandles[oldCandles.length - 2][0];
    const backfillCandles = buildOlderBackfillCandles(oldCandles[0][0], missingCount, 100, intervalSeconds);
    let kibanaCalls = 0;
    let triggerWrites = 0;
    let dynamicGridWrites = 0;
    let savedPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, ...ama3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_restart_wait_1h.json`),
        loadJson: () => ({ candles: oldCandles }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.5 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, options) => {
                kibanaCalls += 1;
                return options.timeRange ? backfillCandles : [];
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            [...existing, ...incoming].forEach((c) => map.set(c[0], c));
            return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles, keepCount) => candles.length <= keepCount ? candles : candles.slice(candles.length - keepCount),
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-restart-wait.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-restart-wait',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama3',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'aaa-bbb-restart-wait': {
                centerPrice: 100,
                lastClosedCandleTs: latestClosedTs,
            },
        },
    };

    const cfg = {
        intervalSeconds,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'restart should complete successfully');
    assert.strictEqual(result.pendingClosedCandle, true, 'without a new closed candle the adapter should wait after backfilling');
    assert.strictEqual(result.triggered, false, 'backfilling an old window alone must not trigger a grid update');
    assert.strictEqual(result.triggerSuppressedReason, 'waiting_for_new_closed_candle', 'restart should report the closed-candle gate when history was repaired but no new close exists');
    assert.strictEqual(result.kibanaBackfillCount, missingCount, 'restart should fetch exactly the missing historical candles');
    assert.strictEqual(result.candleCount, rawKeepCount, 'raw retained candle count should be expanded to the new AMA3 target');
    assert.strictEqual(result.analysisCandleCount, analysisKeepCount, 'effective analysis candles should exclude only the live partial bucket');
    assert.strictEqual(result.rawKeepCount, rawKeepCount, 'result should expose the updated raw retention target');
    assert.strictEqual(result.analysisKeepCount, analysisKeepCount, 'result should expose the updated analysis retention target');
    assert.ok(result.source.includes('kibana-backfill'), 'restart source should show that historical repair occurred');
    assert.strictEqual(kibanaCalls, 1, 'restart should perform a single targeted historical backfill request');
    assert.strictEqual(triggerWrites, 0, 'closed-candle gate should prevent a grid trigger after backfill');
    assert.strictEqual(dynamicGridWrites, 0, 'closed-candle gate should prevent AMA center persistence after backfill');
    assert.ok(savedPayload, 'repaired candle file should be persisted');
    assert.strictEqual(savedPayload.meta.candleCount, rawKeepCount, 'saved raw candle file should contain the expanded retention window');
    assert.strictEqual(savedPayload.meta.analysisCandleCount, analysisKeepCount, 'saved metadata should record the effective closed-candle window');
}

async function testRestartBackfillsOldAma3WindowEvenWhenGapRepairWasAttempted() {
    const ama3 = MARKET_ADAPTER.AMAS.AMA3;
    const intervalSeconds = 3600;
    const nowMs = Date.parse('2026-05-06T12:30:00Z');
    const analysisKeepCount = getAmaWarmupBars(
        ama3.erPeriod,
        ama3.slowPeriod,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        ama3.fastPeriod
    ) + 1;
    const rawKeepCount = analysisKeepCount + 1;
    const oldRawCount = 1700;
    const missingCount = rawKeepCount - oldRawCount;
    const oldCandles = buildRestartCandles(oldRawCount, nowMs, 100, intervalSeconds);
    const latestClosedTs = oldCandles[oldCandles.length - 2][0];
    const backfillCandles = buildOlderBackfillCandles(oldCandles[0][0], missingCount, 100, intervalSeconds);
    let kibanaCalls = 0;
    let savedPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, ...ama3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_restart_gap_backfill_1h.json`),
        loadJson: () => ({ candles: oldCandles }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.5 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, options) => {
                kibanaCalls += 1;
                if (!options.timeRange) return [];
                return kibanaCalls === 1 ? [] : backfillCandles;
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            [...existing, ...incoming].forEach((c) => map.set(c[0], c));
            return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles, keepCount) => candles.length <= keepCount ? candles : candles.slice(candles.length - keepCount),
        detectMissingCandleTimestamps: () => ({
            gapCount: 2,
            missingTimestamps: [
                oldCandles[250][0] + (intervalSeconds * 1000),
                oldCandles[250][0] + (intervalSeconds * 2000),
            ],
        }),
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-restart-gap-backfill.trigger',
        writeBotDynamicGrid: () => true,
        isBotDynamicWeightWhitelisted: () => false,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-restart-gap-backfill',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama3',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'aaa-bbb-restart-gap-backfill': {
                centerPrice: 100,
                lastClosedCandleTs: latestClosedTs,
            },
        },
    };

    const cfg = {
        intervalSeconds,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        maxNativeGapFillCandles: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'restart should still complete successfully when gap repair was attempted');
    assert.strictEqual(result.pendingClosedCandle, true, 'closed-candle gate should still apply after repairing history');
    assert.strictEqual(result.triggerSuppressedReason, 'waiting_for_new_closed_candle', 'historical repair should happen before the closed-candle wait');
    assert.strictEqual(result.kibanaBackfillCount, missingCount, 'restart should still fetch the missing historical candles after gap repair');
    assert.strictEqual(result.candleCount, rawKeepCount, 'raw retained candle count should still expand to the AMA3 target');
    assert.strictEqual(result.analysisCandleCount, analysisKeepCount, 'effective analysis candles should still reach the target window');
    assert.ok(result.source.includes('kibana-backfill'), 'source label should still report the historical backfill');
    assert.strictEqual(kibanaCalls, 2, 'gap repair and historical backfill should both query Kibana');
    assert.ok(savedPayload, 'repaired candle file should be persisted');
    assert.strictEqual(savedPayload.meta.candleCount, rawKeepCount, 'saved raw candle file should include the repaired retention window');
}

async function testRestartBackfillsOldAma3WindowAndTriggersWhenDeltaThresholdIsExceeded() {
    const ama3 = MARKET_ADAPTER.AMAS.AMA3;
    const intervalSeconds = 3600;
    const nowMs = Date.parse('2026-05-06T12:30:00Z');
    const analysisKeepCount = getAmaWarmupBars(
        ama3.erPeriod,
        ama3.slowPeriod,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        ama3.fastPeriod
    ) + 1;
    const rawKeepCount = analysisKeepCount + 1;
    const oldRawCount = 1700;
    const missingCount = rawKeepCount - oldRawCount;
    const oldCandles = buildRestartCandles(oldRawCount, nowMs, 100, intervalSeconds);
    const latestClosedTs = oldCandles[oldCandles.length - 2][0];
    const backfillCandles = buildOlderBackfillCandles(oldCandles[0][0], missingCount, 100, intervalSeconds);
    let kibanaCalls = 0;
    let triggerWrites = 0;
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, ...ama3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_restart_trigger_1h.json`),
        loadJson: () => ({ candles: oldCandles }),
        saveJson: () => {},
        calculateBotThreshold: () => MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.5 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, options) => {
                kibanaCalls += 1;
                return options.timeRange ? backfillCandles : [];
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => {
            const map = new Map();
            [...existing, ...incoming].forEach((c) => map.set(c[0], c));
            return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
        },
        pruneCandles: (candles, keepCount) => candles.length <= keepCount ? candles : candles.slice(candles.length - keepCount),
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-restart-trigger.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-restart-trigger',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama3',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'aaa-bbb-restart-trigger': {
                centerPrice: 95,
                lastClosedCandleTs: latestClosedTs - (intervalSeconds * 1000),
            },
        },
    };

    const cfg = {
        intervalSeconds,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'restart should complete successfully');
    assert.strictEqual(result.kibanaBackfillCount, missingCount, 'restart should fetch the missing historical candles before analysis');
    assert.strictEqual(result.candleCount, rawKeepCount, 'raw retained candle count should be expanded to the new AMA3 target');
    assert.strictEqual(result.analysisCandleCount, analysisKeepCount, 'effective analysis candles should match the updated AMA3 window');
    assert.strictEqual(result.triggered, true, 'after a repaired restart window, a threshold breach should still trigger a grid update');
    assert.ok(result.deltaPercent > MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT, 'restart trigger should be driven by a real AMA delta above threshold');
    assert.strictEqual(result.amaPrice, 100, 'flat repaired history should yield the expected AMA center');
    assert.ok(result.source.includes('kibana-backfill'), 'restart source should show the historical repair path');
    assert.strictEqual(kibanaCalls, 1, 'restart should perform one targeted historical backfill request');
    assert.strictEqual(dynamicGridWrites, 1, 'threshold trigger should persist the refreshed AMA center once');
    assert.strictEqual(triggerWrites, 1, 'threshold trigger should write exactly one grid-reset marker');
    assert.strictEqual((state.bots['aaa-bbb-restart-trigger'] as any).lastClosedCandleTs, latestClosedTs, 'restart should advance the consumed closed-candle cursor after a successful trigger');
    assert.strictEqual((state.bots['aaa-bbb-restart-trigger'] as any).centerPrice, 100, 'restart should persist the new AMA center after the trigger');
}

async function testBootstrapFallsBackWhenKibanaIsEmpty() {
    let kibanaCalls = 0;
    let nativeCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => null,
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => {
                kibanaCalls += 1;
                return [];
            },
        },
        fetchNativeTradesSince: async () => {
            nativeCalls += 1;
            return {
                trades: [{
                    tsMs: 1700000000000,
                    sell: { asset_id: '1.3.1', amount: 10000 },
                    received: { asset_id: '1.3.0', amount: 100000 },
                }],
                truncated: false,
                pages: 1,
            };
        },
        tradesToCandles: () => [[1700000000000, 100, 100, 100, 100, 1]],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-0.trigger',
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with native bootstrap source');
    assert.strictEqual(result.source, 'native-bootstrap', 'bootstrap should use native candles when Kibana is empty');
    assert.strictEqual(kibanaCalls, 1, 'Kibana should be attempted once');
    assert.strictEqual(nativeCalls, 1, 'native bootstrap should be called once');
}

async function testAmaGridPriceIsCaseInsensitive() {
    const baseTs = Date.parse("2026-04-28T00:00:00Z");
    const hour = 3600000;
    let writeAmaCenterCalls = 0;
    let triggerWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => ([
                [baseTs + hour, 100, 100, 100, 100, 0],
                [baseTs + (2 * hour), 100, 100, 100, 100, 0],
                [baseTs + (3 * hour), 100, 100, 100, 100, 0],
            ]),
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-0.trigger';
        },
        writeBotDynamicGrid: () => {
            writeAmaCenterCalls += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'AMA',
    };

    const state = {
        bots: {
            'aaa-bbb-0': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'trigger should fire on threshold breach');
    assert.strictEqual(writeAmaCenterCalls, 1, 'AMA center should be written for uppercase AMA mode');
    assert.strictEqual(triggerWrites, 1, 'trigger file should be written');
}

async function testAmaTriggerSuppressedWhenCenterPersistFails() {
    let triggerWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-0.trigger';
        },
        writeBotDynamicGrid: () => false,
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = {
        bots: {
            'aaa-bbb-0': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete');
    assert.strictEqual(result.triggered, false, 'trigger should be suppressed if AMA center cannot be persisted');
    assert.strictEqual(result.triggerSuppressedReason, 'ama_center_persist_failed', 'suppression reason should be reported');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written when center persistence fails');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).centerPrice, 100, 'center price should not advance when trigger is suppressed');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).amaCenterPrice, 100, 'raw AMA center should remain aligned with the persisted snapshot');
}

async function testAmaCenterPersistFailureBlocksSlopeTriggerFallback() {
    let triggerWrites = 0;
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateUpThenDownCandles(160, 160, 100, 0.55, 0.75),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.01,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-center-slope-fail.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return false;
        },
        isBotDynamicWeightWhitelisted: () => true,
        isBotAsymmetricBoundsWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-center-slope-fail',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-center-slope-fail': {
                centerPrice: 100,
                amaCenterPrice: 100,
                amaSlope: {
                    trend: 'UP',
                    slopePct: 1.0,
                    slopeOffset: 0.5,
                    isReady: true,
                },
                gridRangeScalingAmaSlope: {
                    trend: 'UP',
                    slopePct: 1.0,
                    slopeOffset: 0.5,
                    isReady: true,
                },
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlopeDeltaThresholdPercent: 0.12,
        amaSlopePersistBars: 1,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete');
    assert.strictEqual(result.triggered, false, 'slope trigger should not run after center persistence fails');
    assert.strictEqual(result.triggerSuppressedReason, 'ama_center_persist_failed', 'center persistence failure should remain the reported reason');
    assert.strictEqual(triggerWrites, 0, 'no trigger file should be written after a failed center snapshot write');
    assert.strictEqual(dynamicGridWrites, 1, 'failed center snapshot should not be followed by a second slope snapshot write');
    assert.strictEqual((state.bots['aaa-bbb-center-slope-fail'] as any).centerPrice, 100, 'center price should not advance after persistence failure');
    assert.strictEqual((state.bots['aaa-bbb-center-slope-fail'] as any).gridRangeScalingAmaSlope.trend, 'UP', 'slope reset baseline should not advance after persistence failure');
}

async function testBootstrapCenterDoesNotAdvanceWhenPersistFails() {
    let triggerWrites = 0;
    let writeAttempts = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-bootstrap.trigger';
        },
        writeBotDynamicGrid: () => {
            writeAttempts += 1;
            return writeAttempts > 1;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-bootstrap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const contextCache = new Map();
    const firstResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(firstResult.ok, true, 'processBot should still complete on bootstrap persistence failure');
    assert.strictEqual(firstResult.triggered, false, 'bootstrap persistence failure should not produce a trigger');
    assert.strictEqual(firstResult.triggerSuppressedReason, 'ama_center_persist_failed', 'bootstrap failure should be reported');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written during bootstrap persistence failure');
    assert.strictEqual((state.bots['aaa-bbb-bootstrap'] as any).centerPrice, undefined, 'bootstrap baseline should remain unset so the next cycle retries');
    assert.strictEqual((state.bots['aaa-bbb-bootstrap'] as any).amaCenterPrice, undefined, 'bootstrap raw AMA center should remain unset when snapshot persistence fails');
    assert.strictEqual((state.bots['aaa-bbb-bootstrap'] as any).lastGridResetAt, undefined, 'bootstrap state should not pretend a reset happened');
    assert.strictEqual((state.bots['aaa-bbb-bootstrap'] as any).lastClosedCandleTs, null, 'failed bootstrap persistence should not consume the closed candle');

    const secondResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(secondResult.ok, true, 'bootstrap retry should still complete');
    assert.strictEqual(secondResult.triggered, true, 'bootstrap retry should create trigger to recalibrate after fresh bootstrap');
    assert.strictEqual(secondResult.triggerSuppressedReason, null, 'successful bootstrap retry should clear the suppression reason');
    assert.strictEqual(writeAttempts, 2, 'the same closed candle should be retried after bootstrap persistence failure');
    assert.strictEqual(secondResult.pendingClosedCandle, false, 'successful retry should process the closed candle rather than skip it');
    assert.ok(Number.isFinite((state.bots['aaa-bbb-bootstrap'] as any).centerPrice), 'bootstrap retry should establish the center baseline');
    assert.strictEqual((state.bots['aaa-bbb-bootstrap'] as any).lastGridResetAt, undefined, 'bootstrap trigger request should not pretend the bot reset already completed');
    assert.ok(Number.isFinite((state.bots['aaa-bbb-bootstrap'] as any).lastClosedCandleTs), 'successful bootstrap retry should finally consume the closed candle');
}

// Center remains AMA when there is no offset. Trigger fires from AMA delta.
async function testCenterEqualsAmaTriggeredByAmaDelta() {
    let triggerWrites = 0;
    let writeArgs = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 100),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-0.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            writeArgs = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    // Previous center 95 → AMA moved to 100 → delta = 5.26% > threshold 0.25% → triggered
    const state = {
        bots: {
            'aaa-bbb-0': {
                centerPrice: 95,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'AMA movement should trigger recenter');
    assert.strictEqual(triggerWrites, 1, 'trigger file should be written');
    assert.ok(Array.isArray(writeArgs), 'writeBotDynamicGrid should be called');
    assert.strictEqual(writeArgs[0], 'aaa-bbb-0');
    assert.strictEqual(writeArgs[1], 100, 'written center should be the AMA center');
    assert.strictEqual(writeArgs[2].amaCenterPrice, 100, 'raw AMA center should be persisted separately');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).centerPrice, 100, 'center updates to new AMA');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).amaCenterPrice, 100, 'raw AMA center tracked separately');
}

// When AMA equals previous center, the center is unchanged → no trigger even with low threshold.
// The adapter still refreshes the dynamic snapshot so the bot side can consume the latest
// calculation output on the next grid reset.
async function testNoTriggerWhenCenterMatchesAma() {
    let triggerWrites = 0;
    let lastWrite = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 100),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-0.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            lastWrite = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    // Previous center = AMA → center unchanged → no trigger
    const state = {
        bots: {
            'aaa-bbb-0': {
                centerPrice: 100,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.deltaPercent, 0, 'delta should be zero when center is unchanged');
    assert.strictEqual(result.triggered, false, 'no trigger when effective center equals previous center');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written');
    assert.ok(Array.isArray(lastWrite), 'unchanged center should still refresh the dynamic snapshot');
    assert.strictEqual(lastWrite[0], 'aaa-bbb-0');
    assert.strictEqual(lastWrite[1], 100, 'snapshot refresh should preserve the current center');
    assert.strictEqual(lastWrite[2].amaCenterPrice, 100, 'snapshot refresh should persist the AMA center');
    assert.ok(lastWrite[2].dynamicWeights, 'snapshot refresh should persist dynamic weight metadata');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).centerPrice, 100, 'stored center should remain unchanged');
}

async function testGridCenterPriceOnlyStateRestoresBaseline() {
    let triggerWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(110, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-grid-center.trigger';
        },
        writeBotDynamicGrid: () => true,
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-grid-center',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-grid-center': {
                gridCenterPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };

    const result = await service.processBot(bot, state, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.deltaPercent, 0, 'gridCenterPrice-only state should be used as the reset baseline');
    assert.strictEqual(result.triggered, false, 'gridCenterPrice-only state should not bootstrap a new reset');
    assert.strictEqual(triggerWrites, 0, 'trigger file must not be written');
    assert.strictEqual((state.bots['aaa-bbb-grid-center'] as any).gridCenterPrice, 100);
    assert.strictEqual((state.bots['aaa-bbb-grid-center'] as any).centerPrice, 100, 'compatibility alias should be restored');
}

// Center is clamped to bot.minPrice/maxPrice bounds when AMA drifts outside them.
async function testCenterClampedByBotBounds() {
    let triggerWrites = 0;
    let lastWrite = null;

    // AMA = 110, bot bounds [99, 101] → center = 101 (clamped to maxPrice)
    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(110, 110),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-1.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            lastWrite = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    // AMA=110 is above maxPrice=101 → clamped to 101. Previous center=110 → delta = 8.2% > 0.5% → triggered.
    const clampedBot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-1',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        minPrice: 99,
        maxPrice: 101,
        incrementPercent: 0.4,
    };
    const clampedState = {
        bots: {
            'aaa-bbb-1': {
                centerPrice: 110,
            },
        },
    };

    const clampedResult = await service.processBot(clampedBot, clampedState, cfg, new Map(), {});
    assert.strictEqual(clampedResult.ok, true);
    assert.strictEqual(clampedResult.triggered, true, 'clamped center change should trigger recenter');
    assert.strictEqual((clampedState.bots['aaa-bbb-1'] as any).centerPrice, 101, 'center should be clamped to maxPrice');
    assert.strictEqual((clampedState.bots['aaa-bbb-1'] as any).lastGridResetAt, undefined, 'adapter trigger request should not record actual reset completion');
    assert.strictEqual(lastWrite[1], 101, 'written center should match clamped value');
    assert.strictEqual(lastWrite[2].amaCenterPrice, 110, 'raw AMA center should be persisted separately');

    // AMA=110, previous=101 (already at clamp boundary) → no center change → no trigger.
    const noOpBot = { ...clampedBot, botKey: 'aaa-bbb-3' };
    const noOpState = {
        bots: {
            'aaa-bbb-3': {
                centerPrice: 101,
            },
        },
    };
    const noOpResult = await service.processBot(noOpBot, noOpState, cfg, new Map(), {});
    assert.strictEqual(noOpResult.ok, true);
    assert.strictEqual(noOpResult.triggered, false, 'no trigger when clamping keeps center unchanged');
    assert.strictEqual((noOpState.bots['aaa-bbb-3'] as any).centerPrice, 101, 'center should remain at clamp boundary');
    assert.strictEqual(triggerWrites, 1, 'only the initial clamp move should have triggered');
}

// The slope-delta persistence gate: fires only after K consecutive confirming
// bars, clears on a broken candidate, and honors an explicit per-bot override.
async function testAmaSlopePersistenceGate() {
    const service = new MarketAdapterService({});
    const cfg = { amaSlopeDeltaThresholdPercent: 0.1 };
    const details = service.buildAmaSlopeResetDetails(
        { slopePct: 1.0, isReady: true },
        { slopePct: 0.5, isReady: true },
        cfg,
    );
    assert.strictEqual(details.thresholdCrossed, true, 'raw slope threshold crossed');

    const bars = Number(MARKET_ADAPTER.AMA_SLOPE_PERSIST_BARS);
    const state: any = {};
    for (let i = 1; i <= bars; i++) {
        const gate = service.advanceAmaSlopePersistence(details, cfg, state);
        assert.strictEqual(gate.persistBars, bars, 'gate length follows the global default');
        assert.strictEqual(gate.shouldTrigger, i >= bars, `gate fires on confirming bar ${i} of ${bars}`);
    }

    // A single-bar blip (candidate then cleared) must not fire.
    const blipState: any = {};
    service.advanceAmaSlopePersistence(details, cfg, blipState);
    const cleared = service.advanceAmaSlopePersistence({ ...details, thresholdCrossed: false }, cfg, blipState);
    assert.strictEqual(cleared.shouldTrigger, false, 'a cleared candidate does not fire');
    assert.strictEqual(blipState.amaSlopePersistCount, 0, 'counter resets when the candidate clears');

    // Explicit per-bot override of 1 restores legacy immediate firing.
    const legacy = service.advanceAmaSlopePersistence(details, { amaSlopePersistBars: 1 }, {});
    assert.strictEqual(legacy.shouldTrigger, true, 'explicit persistBars:1 fires immediately');
    assert.strictEqual(legacy.persistBars, 1, 'explicit persistBars:1 is honored');

    // Per-bot overrides must beat the global default (both directions).
    // Regression: the old `||` chain let the global `true` mask a per-bot
    // `persistEnabled:false`, so the documented per-bot rollback did nothing.
    assert.strictEqual(service.resolveAmaSlopePersistBars({ amaSlope: { persistEnabled: false } }), 1,
        'explicit persistEnabled:false disables the gate despite the global default');
    assert.strictEqual(service.resolveAmaSlopePersistBars({ amaSlopePersistEnabled: false }), 1,
        'flat persistEnabled:false disables the gate');
    assert.strictEqual(service.resolveAmaSlopePersistBars({ amaSlope: { persistBars: 0 } }), 1,
        'persistBars:0 disables the gate instead of silently falling through');
    assert.strictEqual(service.resolveAmaSlopePersistBars({ amaSlope: { persistBars: 2 } }), 2,
        'explicit persistBars >= 1 wins');
    assert.strictEqual(service.resolveAmaSlopePersistBars({ amaSlope: { persistEnabled: true } }), bars,
        'explicit persistEnabled:true follows the global gate length');

    console.log(' - AMA slope persistence gate ok');
}

// A stable AMA center should still reset when the AMA slope delta crosses the threshold.
async function testCenterStableButSlopeDeltaTriggersReset() {
    let triggerWrites = 0;
    let lastTrigger = null;
    let lastWrite = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateUpThenDownCandles(160, 160, 100, 0.55, 0.75),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 9999,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: (_, payload) => {
            triggerWrites += 1;
            lastTrigger = payload;
            return '/tmp/recalculate.aaa-bbb-slope.trigger';
        },
        writeBotDynamicGrid: (...args) => {
            lastWrite = args;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        isBotAsymmetricBoundsWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-slope',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-slope': {
                centerPrice: 100,
                amaCenterPrice: 100,
                amaSlope: {
                    trend: 'UP',
                    slopePct: 1.0,
                    slopeOffset: 0.5,
                    isReady: true,
                },
                gridRangeScalingAmaSlope: {
                    trend: 'UP',
                    slopePct: 1.0,
                    slopeOffset: 0.5,
                    isReady: true,
                },
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlopeDeltaThresholdPercent: 0.12,
        amaSlopePersistBars: 1,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.triggered, true, 'slope delta should trigger a recenter');
    assert.strictEqual(triggerWrites, 1, 'slope delta should write one trigger');
    assert.ok(lastTrigger, 'trigger payload should be captured');
    assert.strictEqual(lastTrigger.reason, 'market_adapter_ama_slope_delta_threshold', 'delta-threshold reason should be explicit');
    assert.ok(Number.isFinite(lastTrigger.deltaPercent), 'trigger payload should carry the slope delta');
    assert.ok(lastTrigger.previousGridResetAmaSlope, 'trigger payload should carry the last grid-reset slope baseline');
    assert.ok(Number.isFinite(result.amaSlopeDeltaPercent), 'result should expose the slope delta');
    assert.ok(Array.isArray(lastWrite), 'dynamic snapshot should be persisted with slope metadata');
    assert.ok(lastWrite[2].amaSlope, 'dynamic snapshot should persist the current slope snapshot');
    assert.ok(Number.isFinite(lastWrite[2].gridPriceOffsetPct), 'dynamic snapshot should persist the AMA spread offset');
    assert.ok(lastWrite[2].gridPriceOffsetPct < 0, 'downtrend should persist a negative spread offset');
    assert.strictEqual(lastWrite[2].dynamicWeights, undefined, 'range-scaling snapshot should not persist live dynamic weights without dynamic whitelist');
    assert.strictEqual(result.dynamicWeightApplied, false, 'range-scaling snapshot should not report live dynamic weights as applied');
    assert.strictEqual((state.bots['aaa-bbb-slope'] as any).effectiveWeights, null, 'range-only snapshot should not advance live effective weights');
    assert.strictEqual((state.bots['aaa-bbb-slope'] as any).amaSlope.trend, 'DOWN', 'state should retain current slope direction');
    assert.strictEqual((state.bots['aaa-bbb-slope'] as any).gridRangeScalingAmaSlope.trend, 'DOWN', 'reset baseline should advance only after the slope reset');
    assert.ok(Number.isFinite((state.bots['aaa-bbb-slope'] as any).amaSlopeDeltaPercent), 'state should retain the slope delta');
}

// The published slope was already covered by the parity test; this closes the
// remaining gap: the SAME shaped slope must reach amaSlopeDeltaPercent and the
// reset-trigger payload, not a parallel raw-Huber computation.
async function testAmaSlopeEmaAlphaDrivesLiveResetDelta() {
    const candles = generateUpThenDownCandles(160, 160, 100, 0.55, 0.75);
    const botAma = { enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 };
    const baseline = { trend: 'UP', slopePct: 1.0, slopeOffset: 0.5, isReady: true };

    async function runWithAlpha(emaAlpha: number) {
        let trigger: any = null;
        let snapshot: any = null;
        const cfg = {
            intervalSeconds: 3600,
            bootstrapLookbackHours: 100,
            nativeBackfillHours: 6,
            pageLimit: 100,
            maxPages: 80,
            sourceRetries: 1,
            retryDelayMs: 0,
            maxStaleHours: 6,
            amaSlopeDeltaThresholdPercent: 0.12,
            amaSlopePersistBars: 1,
            amaSlope: { emaAlpha },
        };
        const service = new MarketAdapterService({
            resolveBotContext: async () => ({
                assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: '1.19.133',
            }),
            resolveAmaForBot: () => botAma,
            candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
            loadJson: () => ({ candles }),
            saveJson: () => {},
            calculateBotThreshold: () => 9999,
            computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
            withRetries: async (fn) => fn(),
            kibanaSource: { getLpCandlesForPool: async () => [] },
            fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
            tradesToCandles: () => [],
            mergeCandles: (existing, incoming) => [...existing, ...incoming],
            pruneCandles: (series) => series,
            buildAmaRecord: () => [],
            writeGridResetTrigger: (_, payload) => {
                trigger = payload;
                return '/tmp/recalculate.aaa-bbb-slope-ema.trigger';
            },
            writeBotDynamicGrid: (_key, _center, payload) => {
                snapshot = payload;
                return true;
            },
            isBotDynamicWeightWhitelisted: () => false,
            isBotAsymmetricBoundsWhitelisted: () => true,
            root: process.cwd(),
            path,
        });
        const bot = {
            name: 'AAA-BBB',
            botKey: 'aaa-bbb-slope-ema',
            assetA: 'IOB.XRP',
            assetB: 'BTS',
            gridPrice: 'ama',
            incrementPercent: 0.4,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        };
        const state = {
            bots: {
                [bot.botKey]: {
                    centerPrice: 100,
                    amaCenterPrice: 100,
                    // Keep the baseline in per-bar units so the expected delta
                    // is a direct slope difference, not a legacy window divide.
                    amaSlopePercentMode: 'perBar',
                    amaSlope: { ...baseline },
                    gridRangeScalingAmaSlope: { ...baseline },
                },
            },
        };
        const result = await service.processBot(bot, state, cfg, new Map(), {});
        // Independently replay the same config through the canonical parity
        // helper so the expected slope is not taken from the service output.
        const expectedSlopePct = buildDynamicWeightParityInputs(candles, cfg, botAma).slopeResult.slopePct;
        return { result, trigger, snapshot, expectedSlopePct };
    }

    const raw = await runWithAlpha(1);
    const smooth = await runWithAlpha(0.2);
    for (const run of [raw, smooth]) {
        assert.strictEqual(run.result.ok, true, 'processBot should succeed');
        assert.ok(run.snapshot?.amaSlope, 'live snapshot must publish the slope');
        assert.strictEqual(run.snapshot.amaSlope.slopePct, run.expectedSlopePct,
            'reset-delta path must read the shaped slope the live service published');
        const expectedDelta = Math.abs(run.expectedSlopePct - baseline.slopePct);
        assert.ok(Math.abs(run.result.amaSlopeDeltaPercent - expectedDelta) < 1e-12,
            'result slope delta must be computed from the shaped slope');
        assert.ok(run.trigger, 'the slope-delta reset must actually fire');
        assert.ok(Math.abs(run.trigger.deltaPercent - expectedDelta) < 1e-12,
            'reset trigger payload must carry the delta of the shaped slope');
    }
    const closes = candles.map((c) => Number(c[4])).filter((v) => Number.isFinite(v) && v > 0);
    const amaValues = calculateAMA(closes, botAma);
    assert.strictEqual(raw.expectedSlopePct, computeHuberWindowSlopePct(amaValues, amaValues.length - 1, MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS),
        'alpha=1 must keep the raw Huber reading on the reset path');
    assert.notStrictEqual(smooth.expectedSlopePct, raw.expectedSlopePct,
        'alpha must change the slope the reset path measures');
    assert.notStrictEqual(smooth.result.amaSlopeDeltaPercent, raw.result.amaSlopeDeltaPercent,
        'alpha must change the actual amaSlopeDeltaPercent, not just diagnostics');
}

async function testSlopeTriggerRecoversBaselineFromDynamicGridAfterStateClear() {
    let triggerWrites = 0;
    let lastTrigger = null;
    let dynamicGridWrites = 0;

    const persistedGridRangeScalingAmaSlope = {
        trend: 'UP',
        slopePct: 1.0,
        slopeOffset: 0.5,
        isReady: true,
    };

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: (filePath) => {
            if (String(filePath).endsWith('.dynamicgrid.json')) {
                return {
                    centerPrice: 100,
                    amaCenterPrice: 100,
                    amaSlope: {
                        trend: 'NEUTRAL',
                        slopePct: 0.03,
                        slopeOffset: 0,
                        isReady: true,
                    },
                    gridRangeScalingAmaSlope: persistedGridRangeScalingAmaSlope,
                    amaSlopeDeltaPercent: 0.01,
                    amaSlopeThresholdPercent: 0.12,
                };
            }
            return {
                candles: generateUpThenDownCandles(160, 160, 100, 0.55, 0.75),
            };
        },
        saveJson: () => {},
        calculateBotThreshold: () => 9999,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: (_, payload) => {
            triggerWrites += 1;
            lastTrigger = payload;
            return '/tmp/recalculate.aaa-bbb-slope-after-clear.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        isBotAsymmetricBoundsWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-slope-after-clear',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlopeDeltaThresholdPercent: 0.12,
        amaSlopePersistBars: 1,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed after state clear');
    assert.strictEqual(result.triggered, true, 'slope trigger should still fire after recovering the persisted baseline');
    assert.strictEqual(triggerWrites, 1, 'recovered baseline should produce one slope trigger');
    assert.strictEqual(dynamicGridWrites, 1, 'successful slope trigger should refresh the persisted snapshot once');
    assert.ok(lastTrigger, 'trigger payload should be captured');
    assert.strictEqual(lastTrigger.previousGridResetAmaSlope.trend, persistedGridRangeScalingAmaSlope.trend);
    assert.strictEqual(lastTrigger.previousGridResetAmaSlope.slopeOffset, persistedGridRangeScalingAmaSlope.slopeOffset);
    assert.strictEqual(
        roundToDecimals(lastTrigger.previousGridResetAmaSlope.slopePct, 6),
        roundToDecimals(persistedGridRangeScalingAmaSlope.slopePct / MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS, 6),
        'slope trigger should normalize the persisted grid reset baseline from dynamicgrid.json before comparison'
    );
    assert.strictEqual(result.previousCenterPrice, 100, 'previous center should be restored from dynamicgrid.json after state clear');
    assert.strictEqual((state.bots['aaa-bbb-slope-after-clear'] as any).centerPrice > 0, true, 'state should be rebuilt from the recovered snapshot');
}

function testSlopeDirectionChangeDoesNotTriggerBelowDeltaThreshold() {
    const service = new MarketAdapterService({});
    const details = service.buildAmaSlopeResetDetails(
        { trend: 'UP', slopePct: 0.02, isReady: true },
        { trend: 'DOWN', slopePct: -0.02, isReady: true },
        { amaSlopeDeltaThresholdPercent: 0.1 }
    );

    assert.strictEqual(details.thresholdCrossed, false, 'small near-zero reversal should stay below threshold');
    assert.strictEqual(details.shouldTrigger, false, 'direction change alone should not trigger a grid reset');
}

function testNonPositiveSlopeThresholdDisablesTrigger() {
    const service = new MarketAdapterService({});
    // A large delta that would cross any positive threshold, but the resolved
    // threshold is 0 (factor/maxSlopePct missing). Zero must DISABLE the
    // trigger rather than make `delta >= 0` fire every cycle.
    const details = service.buildAmaSlopeResetDetails(
        { trend: 'UP', slopePct: 5, isReady: true },
        { trend: 'DOWN', slopePct: -5, isReady: true },
        {}
    );

    assert.strictEqual(details.thresholdPercent, 0, 'no explicit threshold and no factor resolves to 0');
    assert.strictEqual(details.deltaPercent, 10, 'delta itself is still reported');
    assert.strictEqual(details.thresholdCrossed, false, 'a non-positive threshold must not cross');
    assert.strictEqual(details.shouldTrigger, false);
}

function testUnreadySlopeBaselineDoesNotTrigger() {
    const service = new MarketAdapterService({});
    // Bootstrap can persist the not-ready slope result (slopePct 0, isReady
    // false) before AMA warmup. A later ready slope must not be measured
    // against that phantom 0 baseline.
    const details = service.buildAmaSlopeResetDetails(
        { trend: 'UP', slopePct: 0.2, isReady: true },
        { trend: 'NEUTRAL', slopePct: 0, isReady: false },
        { amaSlopeDeltaThresholdPercent: 0.05 }
    );

    assert.strictEqual(details.deltaPercent, null, 'no ready previous baseline means no delta');
    assert.strictEqual(details.thresholdCrossed, false);
    assert.strictEqual(details.shouldTrigger, false, 'a phantom 0 baseline must not trip the slope trigger');
}

function testLegacyStateSlopeDiagnosticsConvertToPerBar() {
    const service = new MarketAdapterService({});
    const normalized = service.normalizePersistedBotState({
        amaSlope: { trend: 'UP', slopePct: 0.9, slopeOffset: 0.3, isReady: true },
        gridRangeScalingAmaSlope: { trend: 'DOWN', slopePct: -1.8, slopeOffset: -0.5, isReady: true },
        amaSlopeDeltaPercent: 0.18,
        amaSlopeThresholdPercent: 0.09,
    }, 9);

    assert.strictEqual(normalized.amaSlopePercentMode, 'perBar', 'legacy state should be promoted to per-bar mode');
    assert.strictEqual(roundToDecimals(normalized.amaSlope.slopePct, 6), 0.1, 'legacy amaSlope should be divided by lookback');
    assert.strictEqual(roundToDecimals(normalized.gridRangeScalingAmaSlope.slopePct, 6), -0.2, 'legacy reset baseline should be divided by lookback');
    assert.strictEqual(roundToDecimals(normalized.amaSlopeDeltaPercent, 6), 0.02, 'legacy slope delta should be divided by lookback');
    assert.strictEqual(roundToDecimals(normalized.amaSlopeThresholdPercent, 6), 0.01, 'legacy slope threshold should be divided by lookback');
}

function testMarkedPerBarStateSlopeDiagnosticsStayUnchanged() {
    const service = new MarketAdapterService({});
    const normalized = service.normalizePersistedBotState({
        amaSlopePercentMode: 'perBar',
        amaSlope: { trend: 'UP', slopePct: 0.0417, slopeOffset: 0.2, isReady: true },
        gridRangeScalingAmaSlope: { trend: 'UP', slopePct: 0.0381, slopeOffset: 0.18, isReady: true },
        amaSlopeDeltaPercent: 0.0011,
        amaSlopeThresholdPercent: 0.0014,
    }, 72);

    assert.strictEqual(normalized.amaSlopePercentMode, 'perBar', 'explicit per-bar mode should be preserved');
    assert.strictEqual(normalized.amaSlope.slopePct, 0.0417, 'per-bar amaSlope should remain unchanged');
    assert.strictEqual(normalized.gridRangeScalingAmaSlope.slopePct, 0.0381, 'per-bar reset baseline should remain unchanged');
    assert.strictEqual(normalized.amaSlopeDeltaPercent, 0.0011, 'per-bar slope delta should remain unchanged');
    assert.strictEqual(normalized.amaSlopeThresholdPercent, 0.0014, 'per-bar slope threshold should remain unchanged');
}

async function testLegacyDynamicGridSlopeBaselineIsNormalizedBeforeComparison() {
    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-legacy-slope-baseline',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };
    const candles = generateUpThenDownCandles(160, 160, 100, 0.55, 0.75);
    const baseDeps = {
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: (filePath) => {
            if (String(filePath).endsWith('.dynamicgrid.json')) return null;
            return { candles };
        },
        saveJson: () => {},
        calculateBotThreshold: () => 9999,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (input) => input,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-legacy-slope-baseline.trigger',
        writeBotDynamicGrid: () => true,
        isBotDynamicWeightWhitelisted: () => false,
        isBotAsymmetricBoundsWhitelisted: () => true,
        root: process.cwd(),
        path,
    };

    const baselineService = new MarketAdapterService(baseDeps);
    const baselineState = { bots: {} };
    const baselineCfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlopeDeltaThresholdPercent: 0.5,
        amaSlopePersistBars: 1,
    };
    const baselineResult = await baselineService.processBot(bot, baselineState, baselineCfg, new Map(), {});
    const currentSlopePct = Number(baselineResult.amaSlope?.slopePct);
    assert.ok(Number.isFinite(currentSlopePct), 'baseline run should compute a slope percent');

    const lookbackBars = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const legacyWindowSlopePct = currentSlopePct * lookbackBars;
    const falseDelta = Math.abs(currentSlopePct - legacyWindowSlopePct);
    let triggerWrites = 0;

    const comparisonService = new MarketAdapterService({
        ...baseDeps,
        loadJson: (filePath) => {
            if (String(filePath).endsWith('.dynamicgrid.json')) {
                return {
                    centerPrice: 100,
                    amaCenterPrice: 100,
                    gridRangeScalingAmaSlope: {
                        trend: baselineResult.amaSlope.trend,
                        slopePct: legacyWindowSlopePct,
                        slopeOffset: baselineResult.amaSlope.slopeOffset,
                        isReady: true,
                    },
                    amaSlopeDeltaPercent: falseDelta,
                    amaSlopeThresholdPercent: falseDelta / 2,
                };
            }
            return { candles };
        },
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-legacy-slope-baseline.trigger';
        },
        isBotAsymmetricBoundsWhitelisted: () => true,
    });

    const state = { bots: {} };
    const cfg = {
        ...baselineCfg,
        amaSlopeDeltaThresholdPercent: falseDelta / 2,
        amaSlopePersistBars: 1,
    };
    const result = await comparisonService.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'comparison run should succeed');
    assert.strictEqual(result.triggered, false, 'legacy window baseline should not false-trigger after normalization');
    assert.strictEqual(triggerWrites, 0, 'legacy window baseline should not emit a reset trigger');
    assert.strictEqual((state.bots[bot.botKey] as any).amaSlopePercentMode, 'perBar', 'state should persist the normalized unit marker');
    assert.strictEqual(
        roundToDecimals((state.bots[bot.botKey] as any).gridRangeScalingAmaSlope.slopePct, 6),
        roundToDecimals(currentSlopePct, 6),
        'legacy reset baseline should be converted to the current per-bar slope before comparison'
    );
}

async function testSlopePersistFailurePreservesRetryBaseline() {
    let triggerWrites = 0;
    let dynamicGridWrites = 0;
    const candles = generateUpThenDownCandles(160, 160, 100, 0.55, 0.75);
    const previousClosedCandleTs = candles[candles.length - 2][0];
    const previousAmaSlope = {
        trend: 'UP',
        slopePct: 1.0,
        slopeOffset: 0.5,
        isReady: true,
    };

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles }),
        saveJson: () => {},
        calculateBotThreshold: () => 9999,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (values) => values,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-slope-retry.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return dynamicGridWrites > 1;
        },
        isBotDynamicWeightWhitelisted: () => true,
        isBotAsymmetricBoundsWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-slope-retry',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };
    const state = {
        bots: {
            'aaa-bbb-slope-retry': {
                centerPrice: 100,
                amaCenterPrice: 100,
                lastClosedCandleTs: previousClosedCandleTs,
                amaSlope: previousAmaSlope,
                gridRangeScalingAmaSlope: previousAmaSlope,
                amaSlopeDeltaPercent: 0.01,
                amaSlopeThresholdPercent: 0.12,
                amaSlopePercentMode: 'perBar',
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlopeDeltaThresholdPercent: 0.12,
        amaSlopePersistBars: 1,
    };

    const failed = await service.processBot(bot, state, cfg, new Map(), {});
    assert.strictEqual(failed.triggered, false, 'failed slope snapshot write should suppress the trigger');
    assert.strictEqual(failed.triggerSuppressedReason, 'ama_slope_persist_failed');
    assert.strictEqual(triggerWrites, 0, 'trigger file should not be written when snapshot persistence fails');
    assert.strictEqual((state.bots['aaa-bbb-slope-retry'] as any).lastClosedCandleTs, previousClosedCandleTs, 'failed closed candle should remain retryable');
    assert.deepStrictEqual((state.bots['aaa-bbb-slope-retry'] as any).amaSlope, previousAmaSlope, 'failed retry should not advance accepted slope baseline');
    assert.deepStrictEqual((state.bots['aaa-bbb-slope-retry'] as any).gridRangeScalingAmaSlope, previousAmaSlope, 'failed retry should not advance grid range scaling baseline');
    assert.strictEqual((state.bots['aaa-bbb-slope-retry'] as any).amaSlopeDeltaPercent, 0.01, 'failed retry should keep previous slope delta diagnostic');

    const retried = await service.processBot(bot, state, cfg, new Map(), {});
    assert.strictEqual(retried.triggered, true, 'preserved slope baseline should allow the next cycle to retry the trigger');
    assert.strictEqual(triggerWrites, 1, 'retry should write the slope trigger after snapshot persistence succeeds');
    assert.notDeepStrictEqual((state.bots['aaa-bbb-slope-retry'] as any).amaSlope, previousAmaSlope, 'successful retry should advance accepted slope baseline');
    assert.notDeepStrictEqual((state.bots['aaa-bbb-slope-retry'] as any).gridRangeScalingAmaSlope, previousAmaSlope, 'successful retry should advance grid range scaling baseline');
    assert.strictEqual((state.bots['aaa-bbb-slope-retry'] as any).lastClosedCandleTs, candles[candles.length - 1][0], 'successful retry should consume the closed candle');
}

async function testContextCacheInvalidatesOnPoolChange() {
    let resolveCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async (bot) => {
            resolveCalls += 1;
            return {
                assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: bot.poolId,
            };
        },
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 0.5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };
    const contextCache = new Map();

    const firstBot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        poolId: '1.19.133',
    };

    const secondBot = {
        ...firstBot,
        poolId: '1.19.999',
    };

    await service.processBot(firstBot, state, cfg, contextCache, {});
    await service.processBot(secondBot, state, cfg, contextCache, {});

    assert.strictEqual(resolveCalls, 2, 'context should be re-resolved after pool change');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).poolId, '1.19.999', 'state should store refreshed pool context');
}

async function testKibanaGapRepairPatchesMissingCandles() {
    let savedPayload = null;
    let kibanaCalls = 0;
    let kibanaTimeRange = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [1700000000000, 100, 100, 100, 100, 1],
                [1700007200000, 102, 102, 102, 102, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, cfg) => {
                kibanaCalls += 1;
                kibanaTimeRange = cfg.timeRange;
                return [
                    [1700003600000, 100.5, 100.5, 100.5, 100.5, 1.5],
                ];
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        detectMissingCandleTimestamps,
        mergeCandles: (existing, incoming) => [...existing, ...incoming].sort((a, b) => a[0] - b[0]),
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-0.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        maxNativeGapFillCandles: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with Kibana gap repair');
    assert.strictEqual(kibanaCalls, 1, 'Kibana should be queried once to patch the gap');
    assert.deepStrictEqual(
        kibanaTimeRange,
        {
            gte: '2023-11-14T23:13:19.999Z',
            lte: '2023-11-15T01:13:19.999Z',
        },
        'Kibana repair should fetch slightly more than the missing bucket window'
    );
    assert.strictEqual(result.kibanaGapRepairCount, 1, 'patched gap count should be reported in result');
    assert.strictEqual(result.unresolvedGapCount, 0, 'no gaps should remain after Kibana repair');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).kibanaGapRepairCount, 1, 'state should track retained Kibana repairs');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).unresolvedGapCount, 0, 'state should track remaining gaps');
    assert.strictEqual(savedPayload.meta.kibanaGapRepairCount, 1, 'saved candle payload should include Kibana repair count');
    assert.strictEqual(savedPayload.meta.unresolvedGapCount, 0, 'saved candle payload should include remaining gap count');
    assert.deepStrictEqual(
        savedPayload.candles,
        [
            [1700000000000, 100, 100, 100, 100, 1],
            [1700003600000, 100.5, 100.5, 100.5, 100.5, 1.5],
            [1700007200000, 102, 102, 102, 102, 1],
        ],
        'AMA should be computed from the Kibana-patched candle series'
    );
}

function testGapRepairRangeUsesSuspiciousGapThresholdInsteadOfNativeBackfillWindow() {
    const service = new MarketAdapterService({});
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const missingTimestamps = Array.from({ length: 12 }, (_, i) => baseTs + ((i + 1) * hour));

    const maxHours = service.getGapRepairMaxHours({
        intervalSeconds: 3600,
        nativeBackfillHours: 6,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    });
    const range = service.buildGapRepairTimeRange(missingTimestamps, 3600, maxHours);

    assert.strictEqual(maxHours, 26, 'gap repair should be capped by the suspicious-gap threshold plus context, not nativeBackfillHours');
    assert.deepStrictEqual(
        range,
        {
            gte: new Date(baseTs).toISOString(),
            lte: new Date(baseTs + (14 * hour) - 1).toISOString(),
        },
        'a 12-hour repair range should not be truncated to the 6h native backfill window'
    );
}

async function testInternalNoTradeGapsAreAutoFilledWithinTrustedThreshold() {
    let savedPayload = null;
    let triggerWrites = 0;
    let dynamicGridWrites = 0;
    const logs = [];

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 100).filter((_c, index) => index !== 10),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        detectMissingCandleTimestamps,
        mergeCandles: (existing, incoming) => [...existing, ...incoming].sort((a, b) => a[0] - b[0]),
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-0.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        logger: {
            log: (message, level) => logs.push({ message, level }),
        },
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete when no-trade internal gap is auto-filled');
    assert.strictEqual(result.kibanaGapRepairCount, 1, 'synthesized no-trade gaps should count as repaired');
    assert.strictEqual(result.unresolvedGapCount, 0, 'auto-filled no-trade internal gaps should not remain unresolved');
    assert.notStrictEqual(result.triggerSuppressedReason, 'unresolved_candle_gaps', 'auto-filled no-trade gaps should not suppress writes as unresolved');
    assert.strictEqual(triggerWrites, 1, 'auto-filled no-trade gaps should allow the grid reset trigger to proceed');
    assert.strictEqual(dynamicGridWrites, 1, 'auto-filled no-trade gaps should allow dynamic grid persistence');
    assert.ok(Number.isFinite((state.bots['aaa-bbb-0'] as any).lastClosedCandleTs), 'no-trade repair should consume the closed candle');
    assert.strictEqual((state.bots['aaa-bbb-0'] as any).unresolvedGapCount, 0, 'state should clear unresolved gap count after synthesized repair');
    assert.strictEqual(savedPayload.meta.unresolvedGapCount, 0, 'saved payload should clear unresolved gap count after synthesized repair');
    assert.ok(
        savedPayload.candles.some((c) => c[0] === 1700036000000 && c[4] === 100 && Number(c[5]) === 0),
        'the missing internal candle should be synthesized as a zero-volume flat candle'
    );
    assert.ok(
        logs.some((entry) => entry.level === 'info'
            && entry.message.includes('synthesized 1 no-trade candle(s) within trusted threshold')
            && entry.message.includes('2023-11-15T08:13:20.000Z')),
        'gap repair logging should note when a missing internal gap was auto-synthesized within trusted threshold'
    );
}

async function testEmptyKibanaResponseResolvesAllGapsInWindow() {
    let savedPayload = null;
    let triggerWrites = 0;
    let dynamicGridWrites = 0;
    let kibanaTimeRange = null;
    let kibanaCalls = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            // Remove 1 candle (within threshold, auto-filled by Step 1) and
            // a block of 25 candles (beyond 24‑candle threshold, goes to Kibana)
            candles: generateCandles(60, 100).filter((_c, index) => index !== 5 && (index < 15 || index >= 40)),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 5,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, options) => {
                kibanaCalls += 1;
                kibanaTimeRange = options?.timeRange || null;
                return [];
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        detectMissingCandleTimestamps,
        mergeCandles: (existing, incoming) => [...existing, ...incoming].sort((a, b) => a[0] - b[0]),
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-windowed.trigger';
        },
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const state = { bots: {} };
    const result = await service.processBot({
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-windowed',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    }, state, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    }, new Map(), {});

    assert.strictEqual(kibanaCalls, 1, 'Kibana should be queried once for beyond-threshold gaps');
    assert.ok(kibanaTimeRange, 'Kibana time range should be set');
    assert.strictEqual(result.ok, true, 'processBot should complete when all gaps are resolved');
    // 1 from Step 1 (within-threshold) + 25 from Step 2 (Kibana empty = verification)
    assert.strictEqual(result.kibanaGapRepairCount, 26, 'all gaps should count as repaired');
    assert.strictEqual(result.unresolvedGapCount, 0, 'no gaps should remain — Kibana empty is verification');
    assert.notStrictEqual(result.triggerSuppressedReason, 'unresolved_candle_gaps', 'writes should not be suppressed');
    assert.strictEqual(triggerWrites, 1, 'all gaps resolved — trigger should proceed');
    assert.strictEqual(dynamicGridWrites, 1, 'all gaps resolved — dynamic grid writes should proceed');
    assert.strictEqual((state.bots['aaa-bbb-windowed'] as any).unresolvedGapCount, 0, 'state should show 0 unresolved gaps');
    assert.strictEqual(savedPayload.meta.unresolvedGapCount, 0, 'saved payload should show 0 unresolved gaps');
    // All synthesized gaps should be in the saved candles
    const allMissingTimestamps = [1700018000000, ...new Array(25).fill(0).map((_, i) => 1700054000000 + i * 3600000)];
    for (const ts of allMissingTimestamps) {
        assert.ok(
            savedPayload.candles.some((c) => c[0] === ts && c[4] === 100 && Number(c[5]) === 0),
            `timestamp ${ts} should be synthesized as zero-volume flat candle`
        );
    }
}

async function testNativeIncrementalFillsNoTradeGapsUpToStaleTailThreshold() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (14 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [{ tsMs: baseTs + (13 * hour) }], truncated: false, pages: 1 }),
        tradesToCandles: () => [
            [baseTs + (13 * hour), 113, 113, 113, 113, 2],
        ],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-gap.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-gap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete after bounded native no-trade fill');
    assert.deepStrictEqual(
        savedPayload.candles.map((c) => c[0]),
        Array.from({ length: 14 }, (_, i) => baseTs + (i * hour)),
        'a 12-hour no-trade gap before the next trade should be kept as continuous hourly candles'
    );
    assert.strictEqual(savedPayload.candles[1][4], 100, 'filled no-trade candles should carry the previous close');
    assert.strictEqual(savedPayload.candles[12][4], 100, 'all no-trade candles before the new trade should stay flat');
    assert.strictEqual(savedPayload.candles[13][4], 113, 'the new trade candle should remain the real incoming candle');
    assert.strictEqual(result.unresolvedGapCount, 0, 'bounded no-trade gaps should not be reported as unresolved');
}

async function testNativeIncrementalDoesNotFillNoTradeGapsPastStaleTailThreshold() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (38 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: true, staleAgeHours: 30.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('verification unavailable');
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-long-gap.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-long-gap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete when long no-trade verification fails');
    assert.deepStrictEqual(
        savedPayload.candles,
        [[baseTs, 100, 100, 100, 100, 1]],
        'no-trade gaps beyond the stale-tail threshold should not be synthesized when verification fails'
    );
    assert.strictEqual(result.staleData, true, 'long no-trade runs should surface as stale data');
}

async function testNativeIncrementalFillsVerifiedLongSilence() {
    let savedPayload = null;
    const logs = [];
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (38 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, cfg) => {
                assert.deepStrictEqual(
                    cfg.timeRange,
                    {
                        gte: new Date(baseTs + hour).toISOString(),
                        lte: new Date(baseTs + (37 * hour)).toISOString(),
                    },
                    'verified silence query should cover only the missing closed buckets'
                );
                return [];
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-verified-silence.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        logger: {
            log: (message, level) => logs.push({ message, level }),
        },
        root: process.cwd(),
        path,
    });

    const result = await service.processBot({
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-verified-silence',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete after verified long silence');
    assert.strictEqual(savedPayload.candles.length, 38, 'verified long silence should be materialized as continuous flat candles');
    assert.strictEqual(savedPayload.candles[1][4], 100, 'verified silence candles should carry the last known close');
    assert.strictEqual(savedPayload.candles[37][4], 100, 'verified silence should extend through the latest closed bucket');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedStartTs, baseTs + hour, 'verified silence start should be saved');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedEndTs, baseTs + (37 * hour), 'verified silence end should be saved');
    assert.strictEqual(result.unresolvedGapCount, 0, 'verified silence should not be reported as unresolved gaps');
    assert.strictEqual(result.staleData, false, 'verified silence should not look like stale data');
    assert.ok(logs.some((entry) => entry.level === 'info' && entry.message.includes('verified no trades')), 'verified silence should be logged');
}

async function testNativeIncrementalFillsVerifiedLongSilenceBeforeLaterActivity() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (70 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async (_poolId, _assetA, _assetB, cfg) => {
                assert.deepStrictEqual(
                    cfg.timeRange,
                    {
                        gte: new Date(baseTs + hour).toISOString(),
                        lte: new Date(baseTs + (49 * hour)).toISOString(),
                    },
                    'verified silence query should stop before the first later native candle'
                );
                return [];
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [{ tsMs: baseTs + (50 * hour), sequence: 1 }], truncated: false, pages: 1 }),
        tradesToCandles: () => [
            [baseTs + (50 * hour), 120, 120, 120, 120, 2],
        ],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-verified-silence-later-activity.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const result = await service.processBot({
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-verified-silence-later-activity',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete when later native activity follows verified silence');
    assert.strictEqual(savedPayload.candles.length, 70, 'mixed verified silence should remain a continuous hourly series');
    assert.strictEqual(savedPayload.candles[49][4], 100, 'verified pre-activity silence should keep the prior close');
    assert.strictEqual(savedPayload.candles[50][4], 120, 'later native activity should remain a real candle');
    assert.strictEqual(savedPayload.candles[69][4], 120, 'bounded post-activity silence should be filled from the later native close');
    assert.strictEqual(result.unresolvedGapCount, 0, 'mixed verified silence should not leave unresolved gaps');
    assert.strictEqual(result.staleData, false, 'mixed verified silence should not look like stale data');
}

async function testNativeIncrementalMergesKibanaActivityInsteadOfSilence() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (38 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: true, staleAgeHours: 30.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [
                [baseTs + (20 * hour), 120, 120, 120, 120, 2],
            ],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-kibana-activity.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const result = await service.processBot({
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-kibana-activity',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete when Kibana finds activity');
    assert.strictEqual(savedPayload.candles[0][4], 100, 'the cached starting candle should remain intact');
    // Internal gaps within the 24-candle trusted threshold are now auto-filled with synthetic candles.
    // The Kibana activity at baseTs + 20h is still present but shifted to index 20.
    assert.strictEqual(savedPayload.candles[20][0], baseTs + (20 * hour), 'Kibana activity should still be merged at the correct timestamp');
    assert.strictEqual(savedPayload.candles[20][4], 120, 'Kibana activity should remain a real candle');
    assert.strictEqual(savedPayload.candles[savedPayload.candles.length - 1][0], baseTs + (37 * hour), 'bounded post-activity silence should extend through the latest closed bucket');
    assert.strictEqual(savedPayload.candles[savedPayload.candles.length - 1][4], 120, 'bounded post-activity silence should carry the later real close');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedStartTs, null, 'real activity should not save a silence marker');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedEndTs, null, 'real activity should not save a silence marker');
    assert.strictEqual(result.unresolvedGapCount, 0, 'within-threshold internal gaps should be auto-filled');
}

async function testStaleTailThresholdCanBeOverriddenPerConfig() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (3 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
                [baseTs + hour, 100, 100, 100, 100, 0],
                [baseTs + (2 * hour), 100, 100, 100, 100, 0],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-stale-tail.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-stale-tail',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        staleTailThreshold: 2,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with a custom stale-tail threshold');
    assert.deepStrictEqual(
        savedPayload.candles,
        [[baseTs, 100, 100, 100, 100, 1]],
        'custom staleTailThreshold should prune the trailing zero-volume flat tail'
    );
}

async function testStaleTailVerificationRangeIsPersisted() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;
    const nowMs = baseTs + (4 * hour) + 1;

    const service = new MarketAdapterService({
        getNowMs: () => nowMs,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_stale-meta_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
                [baseTs + hour, 100, 100, 100, 100, 0],
                [baseTs + (2 * hour), 100, 100, 100, 100, 0],
                [baseTs + (3 * hour), 100, 100, 100, 100, 0],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => ([
                [baseTs + hour, 100, 100, 100, 100, 0],
                [baseTs + (2 * hour), 100, 100, 100, 100, 0],
                [baseTs + (3 * hour), 100, 100, 100, 100, 0],
            ]),
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-stale-meta.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-stale-meta',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    await service.processBot(bot, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        staleTailThreshold: 2,
    }, new Map(), {});

    assert.strictEqual(savedPayload.meta.staleTailVerifiedStartTs, baseTs + hour, 'saved metadata should persist the verified stale-tail start');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedEndTs, baseTs + (3 * hour), 'saved metadata should persist the verified stale-tail end');
}

async function testLegacyStaleTailVerificationTimestampIsHonored() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        getNowMs: () => baseTs + (4 * hour) + 1,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_legacy-stale-meta_1h.json`),
        loadJson: () => ({
            meta: {
                staleTailVerifiedStartTs: baseTs + hour,
                staleTailVerifiedEndTs: baseTs + (3 * hour),
            },
            candles: [
                [baseTs, 100, 100, 100, 100, 1],
                [baseTs + hour, 100, 100, 100, 100, 0],
                [baseTs + (2 * hour), 100, 100, 100, 100, 0],
                [baseTs + (3 * hour), 100, 100, 100, 100, 0],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => {
                throw new Error('legacy verified stale tail should not require Kibana revalidation');
            },
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        detectStaleTail: require('../market_adapter/candle_utils').detectStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-legacy-stale-meta.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    await service.processBot({
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-legacy-stale-meta',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        staleTailThreshold: 2,
    }, new Map(), {});

    assert.strictEqual(savedPayload.candles.length, 4, 'legacy verified stale tail should be kept without revalidation');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedStartTs, baseTs + hour, 'verified range start should be preserved');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedEndTs, baseTs + (3 * hour), 'verified range end should cover the full stale tail');
}

async function testSourceMismatchClearsPersistedStaleTailVerificationRange() {
    let savedPayload = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        getNowMs: () => baseTs + (2 * hour) + 1,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: null,
            marketSource: 'book',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_source-mismatch_1h.json`),
        loadJson: () => ({
            meta: {
                marketSource: 'pool',
                pool: '1.19.133',
                staleTailVerifiedStartTs: baseTs,
                staleTailVerifiedEndTs: baseTs + hour,
            },
            candles: generateCandles(10, 100),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaMarketSource: { getMarketCandles: async () => [] },
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeMarketHistorySince: async () => generateCandles(10, 100),
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        pruneStaleTail,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-source-mismatch.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-source-mismatch',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 'book',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    await service.processBot(bot, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
    }, new Map(), {});

    assert.strictEqual(savedPayload.meta.marketSource, 'book', 'saved metadata should reflect the new source');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedStartTs, null, 'source mismatch should clear the persisted stale-tail start');
    assert.strictEqual(savedPayload.meta.staleTailVerifiedEndTs, null, 'source mismatch should clear the persisted stale-tail end');
}

async function testNativeIncrementalUsesTradeSequenceOverlap() {
    let savedPayload = null;
    let tradesToCandlesInput = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        getNowMs: () => baseTs + (2 * hour) + 1,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            meta: {
                nativeRecentTradeSequences: [100, 99],
                nativeLastTradeTs: baseTs + 1000,
            },
            candles: [
                [baseTs, 100, 110, 90, 100, 10],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => {
            throw new Error('time-based native fetch should not run when sequence overlap metadata exists');
        },
        fetchNativeTradesUntilOverlap: async (_poolId, overlapSequences, minOverlap) => {
            assert.deepStrictEqual(overlapSequences, [100, 99], 'stored native sequence watermark should drive overlap fetch');
            assert.strictEqual(minOverlap, 2, 'incremental fetch should require two overlapping trades');
            return {
                pages: 1,
                overlapCount: 2,
                trades: [
                    { tsMs: baseTs + 3000, sequence: 102 },
                    { tsMs: baseTs + 2000, sequence: 101 },
                    { tsMs: baseTs + 1000, sequence: 100 },
                    { tsMs: baseTs + 500, sequence: 99 },
                ],
            };
        },
        tradesToCandles: (trades) => {
            tradesToCandlesInput = trades;
            return [
                [baseTs, 108, 120, 105, 115, 2],
            ];
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-overlap.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-overlap',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const result = await service.processBot(bot, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete with sequence-overlap native fetch');
    assert.deepStrictEqual(
        tradesToCandlesInput.map((t) => t.sequence),
        [102, 101],
        'overlapping native trades must validate continuity but must not be re-aggregated'
    );
    assert.deepStrictEqual(
        savedPayload.candles[0],
        [baseTs, 100, 120, 90, 115, 12],
        'new trades in an existing bucket should merge into the saved candle instead of replacing it with a partial candle'
    );
    assert.deepStrictEqual(savedPayload.meta.nativeRecentTradeSequences, [102, 101, 100, 99], 'native sequence watermark should advance from fetched rows');
    assert.strictEqual(savedPayload.meta.nativeOverlapCount, 2, 'saved metadata should expose overlap count');
    assert.strictEqual(savedPayload.meta.nativePagesFetched, 1, 'saved metadata should expose native page count');
}

async function testNativeIncrementalFallsBackWhenOverlapNotReached() {
    let tradesToCandlesInput = null;
    let timeBasedFetchCalled = false;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        getNowMs: () => baseTs + (2 * hour) + 1,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            meta: {
                nativeRecentTradeSequences: [100, 99],
                nativeLastTradeTs: baseTs + 1000,
            },
            candles: [
                [baseTs, 100, 110, 90, 100, 10],
            ],
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesUntilOverlap: async () => ({
            pages: 80,
            overlapCount: 0,
            reachedOverlap: false,
            trades: [
                { tsMs: baseTs - 1000, sequence: 98 },
                { tsMs: baseTs - 2000, sequence: 97 },
            ],
        }),
        fetchNativeTradesSince: async () => {
            timeBasedFetchCalled = true;
            return {
                trades: [
                    { tsMs: baseTs + hour + 1000, sequence: 101 },
                ],
                truncated: false,
                pages: 1,
            };
        },
        tradesToCandles: (trades) => {
            tradesToCandlesInput = trades;
            return [
                [baseTs + hour, 120, 120, 120, 120, 2],
            ];
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-overlap-fallback.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        logger: { warn: () => {} },
        root: process.cwd(),
        path,
    });

    await service.processBot({
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-overlap-fallback',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    }, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(timeBasedFetchCalled, true, 'incomplete overlap scan should fall back to time-based fetch');
    assert.deepStrictEqual(
        tradesToCandlesInput.map((t) => t.sequence),
        [101],
        'partial overlap fetch rows must not be re-aggregated when no overlap is reached'
    );
}

async function testTimeBasedNativeIncrementalDoesNotReaggregateExistingBuckets() {
    let savedPayload = null;
    let tradesToCandlesInput = null;
    const baseTs = Date.parse('2026-04-28T00:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        getNowMs: () => baseTs + (2 * hour) + 1,
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: [
                [baseTs, 100, 110, 90, 105, 3],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({
            trades: [
                { tsMs: baseTs + 3000, sequence: null },
                { tsMs: baseTs + hour + 1000, sequence: null },
            ],
            truncated: false,
            pages: 1,
        }),
        tradesToCandles: (trades) => {
            tradesToCandlesInput = trades;
            return [
                [baseTs + hour, 120, 120, 120, 120, 2],
            ];
        },
        fillCandleGaps,
        detectMissingCandleTimestamps,
        mergeCandles,
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-native-time-window.trigger',
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-native-time-window',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const result = await service.processBot(bot, { bots: {} }, {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 24,
        maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    }, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should complete with time-based native fallback');
    assert.deepStrictEqual(
        tradesToCandlesInput.map((t) => t.tsMs),
        [baseTs + hour + 1000],
        'time-based native fallback should not re-aggregate trades from existing candle buckets'
    );
    assert.deepStrictEqual(
        savedPayload.candles,
        [
            [baseTs, 100, 110, 90, 105, 3],
            [baseTs + hour, 120, 120, 120, 120, 2],
        ],
        'existing candle OHLCV should remain unchanged when fallback fetch overlaps its bucket'
    );
}

async function testClosedCandleGateSkipsCurrentPartialHour() {
    let triggerWrites = 0;
    let weightWrites = 0;
    let savedPayload = null;
    const nowMs = Date.parse('2026-01-01T01:30:00Z');
    const closedTs = Date.parse('2026-01-01T00:00:00Z');
    const partialTs = Date.parse('2026-01-01T01:00:00Z');

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: (() => {
                const candles = [];
                // Prehistory: enough closed candles to satisfy AMA convergence warmup
                for (let i = 0; i < 23; i++) {
                    candles.push([closedTs - (23 - i) * 3600000, 100, 100, 100, 100, 1]);
                }
                candles.push([closedTs, 100, 100, 100, 100, 1],
                             [partialTs, 110, 110, 110, 110, 1]);
                return candles;
            })(),
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => {
            throw new Error('buildAmaRecord should not run before a new closed candle exists');
        },
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-closed-hour.trigger';
        },
        writeBotDynamicGrid: () => {
            weightWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-closed-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-closed-0': {
                centerPrice: 100,
                lastClosedCandleTs: closedTs,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});
    const expectedAnalysisKeepCount = getAmaWarmupBars(1, 3, MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS, 2) + 1;
    const expectedRawKeepCount = expectedAnalysisKeepCount + 1;

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.pendingClosedCandle, true, 'current partial hour should be ignored');
    assert.strictEqual(result.triggered, false, 'no trigger should fire before a new closed candle exists');
    assert.strictEqual(result.analysisCandleCount, 24, 'all closed prehistory candles + the new closed candle should be used for analysis');
    assert.strictEqual(result.rawKeepCount, expectedRawKeepCount, 'result should surface the retained raw candle target');
    assert.strictEqual(result.analysisKeepCount, expectedAnalysisKeepCount, 'result should surface the effective closed-candle target');
    assert.strictEqual(result.lastCandleTs, partialTs, 'raw latest candle timestamp should still be reported');
    assert.strictEqual(result.lastClosedCandleTs, closedTs, 'closed candle timestamp should drive the signal');
    assert.strictEqual(triggerWrites, 0, 'grid reset should not run for a partial candle');
    assert.strictEqual(weightWrites, 0, 'weight writes should not run for a partial candle');
    assert.ok(savedPayload, 'raw candle file should still be persisted');
    assert.strictEqual(savedPayload.meta.candleCount, 25, 'raw candle payload should keep prehistory + closed + partial candles');
    assert.strictEqual(savedPayload.meta.analysisCandleCount, 24, 'raw candle payload should record closed-candle count including prehistory');
    assert.strictEqual(savedPayload.meta.rawKeepCount, expectedRawKeepCount, 'raw candle payload should persist the retained raw target');
    assert.strictEqual(savedPayload.meta.analysisKeepCount, expectedAnalysisKeepCount, 'raw candle payload should persist the closed-candle target');
    assert.strictEqual((state.bots['aaa-bbb-closed-0'] as any).centerPrice, 100, 'state should remain unchanged when waiting for a close');
}

async function testClosedCandleGateSurfacesStaleData() {
    let savedPayload = null;
    let stalenessChecks = 0;
    const staleTs = Date.parse('2026-01-01T00:00:00Z');

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 3 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_stale_1h.json`),
        loadJson: () => ({
            candles: [
                [staleTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: (_filePath, payload) => {
            savedPayload = payload;
        },
        calculateBotThreshold: () => 0.25,
        computeCandleStaleness: () => {
            stalenessChecks += 1;
            return { staleData: true, staleAgeHours: 13.5 };
        },
        withRetries: async (fn) => fn(),
        kibanaSource: {
            getLpCandlesForPool: async () => [],
        },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => {
            throw new Error('buildAmaRecord should not run while stale data blocks closed-candle processing');
        },
        getNowMs: () => Date.parse('2026-01-01T13:30:00Z'),
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-stale-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
    };

    const state = {
        bots: {
            'aaa-bbb-stale-0': {
                centerPrice: 100,
                lastClosedCandleTs: staleTs,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete when data is stale');
    assert.strictEqual(stalenessChecks, 1, 'staleness must be evaluated before returning from the closed-candle gate');
    assert.strictEqual(result.staleData, true, 'stale status should be surfaced to the caller');
    assert.strictEqual(result.staleAgeHours, 13.5, 'stale age should be preserved');
    assert.strictEqual(result.pendingClosedCandle, false, 'stale data should not masquerade as a normal pending close');
    assert.strictEqual(result.triggerSuppressedReason, 'stale_candle_data', 'suppression reason should distinguish stale data from a normal wait');
    assert.ok(savedPayload, 'raw candle payload should still be persisted');
    assert.strictEqual((state.bots['aaa-bbb-stale-0'] as any).pendingClosedCandle, false, 'state should not mark stale data as a pending close');
    assert.strictEqual((state.bots['aaa-bbb-stale-0'] as any).staleData, true, 'state should retain stale status');
    assert.strictEqual((state.bots['aaa-bbb-stale-0'] as any).lastTriggerSuppressedReason, 'stale_candle_data', 'state should persist the stale suppression reason');
}

async function testClosedCandlePruningRetainsFullDynamicWeightWarmup() {
    let writtenPayload = null;
    let pruneKeepCount = null;
    const intervalSeconds = 3600;
    const bucketMs = intervalSeconds * 1000;
    const baseTs = Date.parse('2026-01-01T00:00:00Z');
    const candles = [
        [baseTs + 0 * bucketMs, 100, 100, 100, 100, 1],
        [baseTs + 1 * bucketMs, 101, 101, 101, 101, 1],
        [baseTs + 2 * bucketMs, 102, 102, 102, 102, 1],
        [baseTs + 3 * bucketMs, 103, 103, 103, 103, 1],
        [baseTs + 4 * bucketMs, 104, 104, 104, 104, 1],
        [baseTs + 5 * bucketMs, 105, 105, 105, 105, 1],
        [baseTs + 6 * bucketMs, 106, 106, 106, 106, 1],
        [baseTs + 7 * bucketMs, 107, 107, 107, 107, 1],
        [baseTs + 8 * bucketMs, 108, 108, 108, 108, 1],
        [baseTs + 9 * bucketMs, 109, 109, 109, 109, 1],
        [baseTs + 10 * bucketMs, 110, 110, 110, 110, 1],
        [baseTs + 11 * bucketMs, 111, 111, 111, 111, 1],
        [baseTs + 12 * bucketMs, 112, 112, 112, 112, 1],
        [baseTs + 13 * bucketMs, 113, 113, 113, 113, 1],
    ];

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 2, slowPeriod: 2 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_prune_1h.json`),
        loadJson: () => ({ candles }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.5 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (inputCandles, keepCount) => {
            pruneKeepCount = keepCount;
            if (inputCandles.length <= keepCount) return inputCandles;
            return inputCandles.slice(inputCandles.length - keepCount);
        },
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-prune.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        getNowMs: () => baseTs + (13 * bucketMs) + (30 * 60 * 1000),
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-prune',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-prune': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        amaSlope: {
            lookbackBars: 1,
            maxSlopePct: 0.5,
            neutralZonePct: 0,
        },
        kalmanSlope: {
            maxSlopePct: 0.5,
        },
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});
    const expectedAnalysisKeepCount = getAmaWarmupBars(1, 2, cfg.amaSlope.lookbackBars, 2) + 1;
    const expectedRawKeepCount = expectedAnalysisKeepCount + 1;

    assert.strictEqual(result.ok, true, 'processBot should succeed with a partial trailing candle');
    assert.strictEqual(result.analysisCandleCount, 11, 'analysis should retain the full closed-candle warmup window');
    assert.strictEqual(result.rawKeepCount, expectedRawKeepCount, 'raw keep target should remain one candle larger than the closed-candle window');
    assert.strictEqual(result.analysisKeepCount, expectedAnalysisKeepCount, 'analysis keep target should match the effective closed-candle window');
    assert.strictEqual(pruneKeepCount, expectedRawKeepCount, 'raw candle pruning should keep one extra bucket beyond the analysis window');
    assert.ok(writtenPayload, 'dynamic weights should still persist when the warmup window is fully retained');
    assert.strictEqual(writtenPayload.dynamicWeights.isReady, true, 'dynamic weights should stay ready after pruning away only the partial bucket');
}

function testSleepUntilAlignedBoundaryAnchorsToCycleStart() {
    const intervalSeconds = 3600;
    const startedAt = Date.parse('2026-01-01T12:59:59.900Z');
    const finishedAt = Date.parse('2026-01-01T13:00:01.500Z');
    const midCycleStartedAt = Date.parse('2026-01-01T12:15:00.000Z');
    const midCycleFinishedAt = Date.parse('2026-01-01T12:20:00.000Z');

    const crossedBoundaryDelay = sleepUntilAlignedBoundary(intervalSeconds, startedAt, finishedAt);
    const midCycleDelay = sleepUntilAlignedBoundary(intervalSeconds, midCycleStartedAt, midCycleFinishedAt);

    assert.strictEqual(crossedBoundaryDelay, 1000, 'crossing a boundary during the cycle should rerun immediately after the buffer');
    assert.strictEqual(midCycleDelay, 2401000, 'sleep should still target the next aligned boundary from the cycle start');
}

function testComputeStartupDelayMsHonorsPollBoundary() {
    const pollSeconds = 3600;
    const cfg = { pollSeconds, intervalSeconds: pollSeconds };
    // Mid-hour respawn: 24 minutes into the hour, previous cycle consumed the
    // newest closed bucket (23:00).
    const now = Date.parse('2026-09-28T00:24:30.000Z');
    const current = { bots: { 'aaa-bbb': { lastClosedCandleTs: Date.parse('2026-09-27T23:00:00.000Z') } } };

    const delay = computeStartupDelayMs(cfg, current, now);
    assert.strictEqual(
        delay,
        sleepUntilAlignedBoundary(pollSeconds, now, now),
        'a current state must sleep to the same aligned boundary the loop uses'
    );
    assert.ok(delay > 0 && delay <= pollSeconds * 1000, 'sleep must never exceed one poll period');

    // Behind (adapter was down during its slot) → catch up immediately.
    const behind = { bots: { 'aaa-bbb': { lastClosedCandleTs: Date.parse('2026-09-27T22:00:00.000Z') } } };
    assert.strictEqual(computeStartupDelayMs(cfg, behind, now), 0, 'a missed cycle must run a catch-up cycle at once');

    // Fresh / cleared / unusable state → bootstrap now, never sleep.
    assert.strictEqual(computeStartupDelayMs(cfg, { bots: {} }, now), 0, 'empty state must bootstrap immediately');
    assert.strictEqual(computeStartupDelayMs(cfg, null, now), 0, 'missing state must bootstrap immediately');
    assert.strictEqual(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': {} } }, now),
        0,
        'state without a consumed marker must bootstrap immediately'
    );

    // Marker ahead of the wall clock: clocks disagree, so do not trust it.
    const ahead = { bots: { 'aaa-bbb': { lastClosedCandleTs: Date.parse('2026-09-27T23:00:00.000Z') + 3600000 } } };
    assert.strictEqual(computeStartupDelayMs(cfg, ahead, now), 0, 'a marker ahead of the clock must run, not sleep');

    // A deleted bot's stale state entry is ignored when the active set is
    // known (the daemon always passes it). Without an active set we cannot
    // tell a removed bot from a lagging one, so every row is judged and the
    // old marker vetoes — conservative, and never wrong.
    const withStaleEntry = {
        bots: {
            'deleted-bot': { lastClosedCandleTs: Date.parse('2026-06-01T00:00:00.000Z') },
            'aaa-bbb': { lastClosedCandleTs: Date.parse('2026-09-27T23:00:00.000Z') },
        },
    };
    assert.ok(
        computeStartupDelayMs(cfg, withStaleEntry, now, ['aaa-bbb']) > 0,
        'an older entry for a removed bot must not defeat the sleep-first path'
    );
    assert.strictEqual(
        computeStartupDelayMs(cfg, withStaleEntry, now, null),
        0,
        'without an active bot set, a stale row is indistinguishable from a lagging bot and must veto'
    );

    // The poll setting is honoured, not hardcoded: a 10-minute cadence sleeps
    // within 10 minutes.
    const shortPoll = computeStartupDelayMs(
        { pollSeconds: 600, intervalSeconds: 600 },
        { bots: { 'aaa-bbb': { lastClosedCandleTs: Math.floor(now / 600000) * 600000 - 600000 } } },
        now
    );
    assert.ok(shortPoll > 0 && shortPoll <= 600 * 1000, 'a 10-minute poll must sleep at most 10 minutes');
}

function testStartupSleepIsPerBotNeverAggregated() {
    // A max() over the bots hides a lagging one behind a current sibling, and
    // that lagging bot is exactly what a catch-up cycle exists for: runOnce
    // leaves its marker un-advanced after a per-bot failure, so a closed
    // candle can already be waiting for it.
    const pollSeconds = 3600;
    const cfg = { pollSeconds, intervalSeconds: pollSeconds };
    const now = Date.parse('2026-09-28T00:24:30.000Z'); // newest closed bucket 23:00
    const current = Date.parse('2026-09-27T23:00:00.000Z');
    const hour = 3600000;
    const clean = (ts: number) => ({ lastClosedCandleTs: ts, candleCount: 1800, rawKeepCount: 1800, unresolvedGapCount: 0 });

    const mixed = { bots: { 'a-current': clean(current), 'b-behind': clean(current - hour) } };
    assert.strictEqual(
        computeStartupDelayMs(cfg, mixed, now, ['a-current', 'b-behind']),
        0,
        'one lagging bot must veto the sleep even when a sibling is current'
    );
    assert.ok(
        computeStartupDelayMs(cfg, mixed, now, ['a-current']) > 0,
        'a fleet where every bot is current may still sleep'
    );

    // A marker ahead of the clock is equally a veto, and is reported apart.
    const ahead = evaluateStartupSleep(cfg, { bots: { 'a-skewed': clean(current + hour) } }, now, ['a-skewed']);
    assert.strictEqual(ahead.delayMs, 0, 'a marker ahead of the clock must run');
    assert.strictEqual(ahead.veto?.reason, 'marker_ahead_of_clock', 'skew must be distinguishable from lagging');

    const behind = evaluateStartupSleep(cfg, mixed, now, ['a-current', 'b-behind']);
    assert.strictEqual(behind.veto?.reason, 'behind_latest_closed_candle', 'lagging must be named in the veto');
    assert.deepStrictEqual(behind.veto?.botKeys, ['b-behind'], 'the veto must name the bot that caused it');

    // Several distinct problems are all reported, so a permanent veto is
    // diagnosable from the log instead of looking like "never sleeps".
    const messy = {
        bots: {
            'a-current': clean(current),
            'b-behind': clean(current - hour),
            'c-gaps': { ...clean(current), unresolvedGapCount: 2 },
        },
    };
    const verdict = evaluateStartupSleep(cfg, messy, now, ['a-current', 'b-behind', 'c-gaps', 'd-new']);
    assert.strictEqual(verdict.delayMs, 0, 'any outstanding problem vetoes the sleep');
    assert.strictEqual(
        verdict.veto?.reason,
        'behind_latest_closed_candle+no_state_row+unresolved_gaps',
        'all distinct reasons must be reported, in a stable order'
    );
    assert.deepStrictEqual(
        verdict.veto?.botKeys.sort(),
        ['b-behind', 'c-gaps', 'd-new'],
        'every offending bot must be named once'
    );

    // Whole-fleet refusals carry NO bot list: the condition is about config or
    // inputs, not a bot. A per-bot reason must never inherit another bot's
    // keys, so the two shapes stay distinguishable. One case per denied() call
    // site, each with the inputs that actually reach it.
    const goodState = { bots: { 'a-current': clean(current) } };
    const fleetCases: any[] = [
        ['interval_mismatch', { pollSeconds: 3600, intervalSeconds: 7200 }, goodState, now, ['a-current']],
        ['clock_unusable', cfg, goodState, NaN, ['a-current']],
        ['state_unusable', cfg, null, now, ['a-current']],
        ['no_active_bots', cfg, goodState, now, []],
        // Only reachable on the unreadable-bot-list fallback (null scope) with
        // an empty state: an empty list is caught earlier by no_active_bots.
        ['no_state_rows', cfg, { bots: {} }, now, null],
    ];
    assert.strictEqual(
        fleetCases.length,
        5,
        'every denied() call site must be covered: adding one without a case here is a silent gap'
    );
    for (const [reason, caseCfg, caseState, caseNow, caseKeys] of fleetCases) {
        const fleet = evaluateStartupSleep(caseCfg, caseState, caseNow, caseKeys);
        assert.strictEqual(fleet.delayMs, 0, `${reason} must run a catch-up cycle`);
        assert.strictEqual(fleet.veto?.reason, reason, `${reason} must be reported as itself`);
        assert.deepStrictEqual(fleet.veto?.botKeys, [], `${reason} is a fleet-level refusal and must name no bot`);
    }
}

function testStartupSleepIgnoresInactiveStateRows() {
    const pollSeconds = 3600;
    const cfg = { pollSeconds, intervalSeconds: pollSeconds };
    const now = Date.parse('2026-09-28T00:24:30.000Z');
    const current = Date.parse('2026-09-27T23:00:00.000Z');
    const healthy = { lastClosedCandleTs: current, candleCount: 1800, rawKeepCount: 1800, unresolvedGapCount: 0 };

    // A removed bot whose row has no marker at all (never bootstrapped, or a
    // cleared state entry) must not veto the sleep for the live bots.
    const withMarkerlessGhost = {
        bots: {
            'removed-bot': { botName: 'Removed' },
            'aaa-bbb': healthy,
        },
    };
    assert.ok(
        computeStartupDelayMs(cfg, withMarkerlessGhost, now, ['aaa-bbb']) > 0,
        'a markerless row for a bot that is no longer active must not defeat the sleep'
    );

    // Without an active bot list (unreadable bots.json) every row counts again.
    assert.strictEqual(
        computeStartupDelayMs(cfg, withMarkerlessGhost, now, null),
        0,
        'an unknown active set must stay conservative'
    );

    // An active bot that has never run — with or without a state row — owes a
    // bootstrap, so it vetoes the sleep and goes live on the next cycle.
    assert.strictEqual(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': { botName: 'AAA-BBB' } } }, now, ['aaa-bbb']),
        0,
        'an active bot without a consumed marker must run now'
    );
    assert.strictEqual(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': healthy } }, now, ['aaa-bbb', 'brand-new-bot']),
        0,
        'a brand-new active bot with no state row must run now, same as a markerless row'
    );
    assert.strictEqual(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': healthy } }, now, []),
        0,
        'an empty active set means nothing to do, not an unknown scope'
    );
}

function testStartupSleepDefersToRepairWhenOutstanding() {
    const pollSeconds = 3600;
    const cfg = { pollSeconds, intervalSeconds: pollSeconds };
    const now = Date.parse('2026-09-28T00:24:30.000Z');
    const current = Date.parse('2026-09-27T23:00:00.000Z');
    const base = { lastClosedCandleTs: current, candleCount: 1800, rawKeepCount: 1800, unresolvedGapCount: 0 };

    assert.ok(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': base } }, now, ['aaa-bbb']) > 0,
        'a bot whose last cycle finished clean may sleep'
    );
    assert.strictEqual(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': { ...base, unresolvedGapCount: 4 } } }, now, ['aaa-bbb']),
        0,
        'unresolved gaps from the last cycle must be repaired now, not after a sleep'
    );
    assert.strictEqual(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': { ...base, candleCount: 900 } } }, now, ['aaa-bbb']),
        0,
        'a cache below its warmup target must not sleep'
    );
    // kibanaBackfillCount / kibanaGapRepairCount are ACTION counts from a cycle
    // that already applied their work, and a skip carries the entry forward —
    // so they must NOT veto the sleep. Standing signals are checked above.
    assert.ok(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': { ...base, kibanaBackfillCount: 120 } } }, now, ['aaa-bbb']) > 0,
        'a completed backfill must not keep vetoing the sleep'
    );
    assert.ok(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': { ...base, kibanaGapRepairCount: 7 } } }, now, ['aaa-bbb']) > 0,
        'a completed gap repair must not keep vetoing the sleep'
    );
    // Absent counters (older state files) are not treated as outstanding.
    assert.ok(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': { lastClosedCandleTs: current } } }, now, ['aaa-bbb']) > 0,
        'missing repair counters must not block the sleep'
    );
    // A known warmup target with an UNKNOWN current count is not "nothing
    // owed": an older or half-written row would otherwise read as healthy.
    const unknownCount = evaluateStartupSleep(
        cfg,
        { bots: { 'aaa-bbb': { lastClosedCandleTs: current, rawKeepCount: 1800 } } },
        now,
        ['aaa-bbb']
    );
    assert.strictEqual(unknownCount.delayMs, 0, 'a target without a candle count must not sleep');
    assert.strictEqual(
        unknownCount.veto?.reason,
        'cache_count_unknown',
        'an unknown candle count must be distinguishable from a short cache'
    );
    // Neither field set at all (very old row) stays non-blocking.
    assert.ok(
        computeStartupDelayMs(cfg, { bots: { 'aaa-bbb': { lastClosedCandleTs: current } } }, now, ['aaa-bbb']) > 0,
        'a row with no retention fields at all must not block the sleep'
    );
}

function testStartupSleepNeverDelaysTheHourlyCandle() {
    // Property: for a respawn at any moment T with a current state, the first
    // cycle lands on the same boundary the steady loop would have used, so the
    // sleep-first path adds NO latency to the newest closed candle. If this
    // ever regresses, a respawn would silently push an hourly candle one full
    // period (or more) into the future.
    const hourMs = 3600000;
    const cfg = { pollSeconds: 3600, intervalSeconds: 3600 };
    let checked = 0;
    for (let minutes = 0; minutes < 60; minutes += 7) {
        for (const hour of [0, 5, 17]) {
            const respawnAt = Date.parse('2026-09-28T00:00:00.000Z') + ((hour * 60 + minutes) * 60000);
            // State is current: the last cycle consumed the newest closed bucket.
            const marker = Math.floor(respawnAt / hourMs) * hourMs - hourMs;
            const state = { bots: { 'aaa-bbb': { lastClosedCandleTs: marker } } };

            const delay = computeStartupDelayMs(cfg, state, respawnAt);
            assert.ok(delay > 0, `respawn at ${new Date(respawnAt).toISOString()} should sleep`);
            const firstCycleAt = respawnAt + delay;

            // Same instant the always-running loop would have reached.
            const steadyLoopDelay = sleepUntilAlignedBoundary(3600, respawnAt, respawnAt);
            assert.strictEqual(
                firstCycleAt,
                respawnAt + steadyLoopDelay,
                'sleep-first must reach the identical boundary as the steady loop'
            );

            // The candle the first cycle processes is the newest closed one at
            // that boundary — i.e. it is exactly as fresh as in steady state,
            // and never older than one poll period.
            const bucketAtCycle = Math.floor(firstCycleAt / hourMs) * hourMs - hourMs;
            assert.ok(
                bucketAtCycle >= marker,
                'the first cycle must not be asked to reprocess an already consumed candle'
            );
            assert.ok(
                bucketAtCycle - marker <= hourMs,
                'a respawn must not leave more than one poll period of candles unprocessed'
            );

            // And it must be ahead of where the previous cycle stopped, unless
            // the respawn happened before the previous cycle could have closed.
            const ageAtCycle = bucketAtCycle - marker;
            assert.ok(
                ageAtCycle === 0 || ageAtCycle === hourMs,
                `unexpected unprocessed span: ${ageAtCycle}ms`
            );
            checked++;
        }
    }
    assert.ok(checked >= 24, `expected a broad sweep of respawn times, checked ${checked}`);
}

function testComputeStartupDelayMsNeverSleepsOnMismatchedGrids() {
    // 2h candles polled hourly: the newest closed bucket (poll grid) and the
    // state markers (candle grid) only coincide by accident, and sleeping on
    // that coincidence would delay a real cycle by up to a full period. The
    // adapter must fall back to running a cycle at startup instead.
    const now = Date.parse('2026-09-28T01:30:00.000Z');
    const twoHourMarker = Date.parse('2026-09-28T00:00:00.000Z'); // newest closed 2h bucket
    const state = { bots: { 'aaa-bbb': { lastClosedCandleTs: twoHourMarker } } };

    assert.strictEqual(
        computeStartupDelayMs({ pollSeconds: 3600, intervalSeconds: 7200 }, state, now),
        0,
        'hourly polling of 2h candles must not sleep'
    );
    assert.strictEqual(
        computeStartupDelayMs({ pollSeconds: 7200, intervalSeconds: 3600 }, state, now),
        0,
        '2h polling of 1h candles must not sleep'
    );
    // An unconfigured interval (older state/config) also stays on the safe side.
    assert.strictEqual(
        computeStartupDelayMs({ pollSeconds: 3600 }, state, now),
        0,
        'a missing interval must not sleep'
    );
    // Aligned grids still sleep, so the guard does not disable the feature.
    assert.ok(
        computeStartupDelayMs(
            { pollSeconds: 3600, intervalSeconds: 3600 },
            { bots: { 'aaa-bbb': { lastClosedCandleTs: Date.parse('2026-09-27T23:00:00.000Z') } } },
            Date.parse('2026-09-28T00:24:30.000Z')
        ) > 0,
        'aligned 1h candles polled hourly must still sleep'
    );
}

function testAppliedAsymmetryMetricsClampToSafeBounds() {
    const service = new MarketAdapterService();
    const metrics = service.computeAppliedAsymmetryMetrics({
        minPrice: '2x',
        maxPrice: '1.1x',
        asymmetricBounds: { maxAsymmetryFactor: 0.35 },
    }, 100, {
        slopeOffset: 0.5,
        maxSlopeOffset: 0.5,
        trend: 'DOWN',
    });

    assert.strictEqual(metrics.rawAsymmetryFactor, 0.35, 'raw asymmetry should reflect the full configured cap');
    assert.ok(Math.abs(metrics.appliedAsymmetryFactor - (1.1 - 1)) < 1e-12,
        'applied asymmetry should be clamped to the log-symmetric safe bound (baseMaxMult - 1)');
    assert.strictEqual(metrics.maxAsymmetryFactor, 0.35, 'resolved maxAsymmetryFactor should be preserved');
}

function testAppliedAsymmetryMetricsPreferRawSlopeOffset() {
    const service = new MarketAdapterService();
    const metrics = service.computeAppliedAsymmetryMetrics({
        minPrice: '2x',
        maxPrice: '2x',
        asymmetricBounds: { maxAsymmetryFactor: 0.35 },
    }, 100, {
        slopeOffset: 0.01,
        rawSlopeOffset: 0.01896502787963161,
        maxSlopeOffset: 0.5,
        trend: 'DOWN',
    });

    assert.ok(Math.abs(metrics.rawAsymmetryFactor - 0.013275519515742126) < 1e-12,
        'range asymmetry should use the precise offset instead of the rounded weight offset');
}

async function testIdOnlyBotIsNotRejected() {
    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 5 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({
            candles: generateCandles(30, 101),
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.id-bot.trigger',
        writeBotDynamicGrid: () => true,
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    // Bot with only assetAId/assetBId (no assetA/assetB symbols)
    const bot = {
        name: 'ID-Only-Bot',
        botKey: 'id-only-bot-0',
        assetAId: '1.3.1',
        assetBId: '1.3.0',
        incrementPercent: 0.4,
        gridPrice: 'ama',
    };

    const state = { bots: {} };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});
    assert.strictEqual(result.ok, true, 'ID-only bot should not be rejected by processBot');
    assert.notStrictEqual(result.reason, 'missing asset pair', 'should not fail with missing asset pair');
}

// Flat candles → finalOff = 0, which is below the configured 0.25 threshold.
// Bot side should receive isReady=false and effectiveWeights == baseWeights.
// Requires 1000 candles so slopeResult.isReady=true (AMA3 erPeriod=781, lookback=72 → needs 854+).
async function testDynamicWeightBelowMinOutputThresholdFallsBackToStaticWeights() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-0.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-0',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-dw-0': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0.25,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'writeBotDynamicGrid should be called via weight-only update path');

    const dw = writtenPayload.dynamicWeights;
    assert.ok(dw, 'dynamicWeights payload should be present');
    assert.strictEqual(dw.belowMinOutputThreshold, true, 'flat candles produce finalOff=0 < configured threshold 0.25');
    assert.strictEqual(dw.isReady, false, 'isReady should be false when below min output threshold');
    assert.strictEqual(dw.effectiveWeights.sell, 0.6, 'effectiveWeights.sell should equal static sell when below threshold');
    assert.strictEqual(dw.effectiveWeights.buy, 0.4, 'effectiveWeights.buy should equal static buy when below threshold');
    assert.deepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'effectiveWeights should equal baseWeights when below threshold');
    assert.strictEqual(dw.minOutputThreshold, 0.25, 'minOutputThreshold should reflect the configured 0.25 override');
}

// With minOutputThreshold=0 the gate is disabled: even finalOff=0 passes, isReady reflects
// slopeResult.isReady (true with enough flat candles), and belowMinOutputThreshold is false.
async function testDynamicWeightMinOutputThresholdZeroDisablesGate() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-1.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-1',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-dw-1': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'writeBotDynamicGrid should be called');

    const dw = writtenPayload.dynamicWeights;
    assert.ok(dw, 'dynamicWeights payload should be present');
    assert.strictEqual(dw.belowMinOutputThreshold, false, 'minOutputThreshold=0 disables the gate');
    assert.strictEqual(dw.isReady, true, 'isReady should be true when gate is disabled and slopeResult is ready');
    assert.strictEqual(dw.minOutputThreshold, 0, 'cfg.minOutputThreshold=0 should be reflected in payload');
}

async function testDynamicWeightGainScalesOutputLinearly() {
    const runWithGain = async (gain) => {
        let writtenPayload = null;

        const service = new MarketAdapterService({
            resolveBotContext: async () => ({
                assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: '1.19.133',
            }),
            resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
            candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
            loadJson: () => ({ candles: generateTrendingCandles(300, 100, 1) }),
            saveJson: () => {},
            calculateBotThreshold: () => 100,
            computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
            withRetries: async (fn) => fn(),
            kibanaSource: { getLpCandlesForPool: async () => [] },
            fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
            tradesToCandles: () => [],
            mergeCandles: (existing, incoming) => [...existing, ...incoming],
            pruneCandles: (candles) => candles,
            buildAmaRecord: () => [],
            writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-gain-neutral.trigger',
            writeBotDynamicGrid: (_botKey, _center, payload) => {
                writtenPayload = payload;
                return true;
            },
            isBotDynamicWeightWhitelisted: () => true,
            root: process.cwd(),
            path,
        });

        const bot = {
            name: 'AAA-BBB',
            botKey: 'aaa-bbb-dw-gain-neutral',
            assetA: 'IOB.XRP',
            assetB: 'BTS',
            gridPrice: 'ama',
            incrementPercent: 0.4,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        };

        const state = { bots: { 'aaa-bbb-dw-gain-neutral': { centerPrice: 100 } } };
        const cfg = {
            intervalSeconds: 3600,
            bootstrapLookbackHours: 1200,
            nativeBackfillHours: 6,
            pageLimit: 100,
            maxPages: 80,
            sourceRetries: 1,
            retryDelayMs: 0,
            maxStaleHours: 6,
            gain,
            minOutputThreshold: 0,
            signalConfirmBars: 0,
            regimeSensitivity: 0,
            maxSlopeOffset: 10,
        };

        const result = await service.processBot(bot, state, cfg, new Map(), {});
        assert.strictEqual(result.ok, true, 'processBot should succeed');
        assert.ok(writtenPayload, 'dynamic weights should be persisted');
        return writtenPayload.dynamicWeights;
    };

    const lowGain = await runWithGain(0.25);
    const highGain = await runWithGain(2.0);

    assert.ok(Number.isFinite(lowGain.rawFinalOffset), 'low-gain output should be finite');
    assert.ok(Number.isFinite(highGain.rawFinalOffset), 'high-gain output should be finite');
    const normalizedLow = lowGain.rawFinalOffset / 0.25;
    const normalizedHigh = highGain.rawFinalOffset / 2.0;
    assert.ok(Math.abs(normalizedLow - normalizedHigh) < 0.01,
        'gain should act as a linear end-stage scale factor once the blended shape is decided');
    assert.notDeepStrictEqual(lowGain.effectiveWeights, highGain.effectiveWeights,
        'different gain values should produce different effective weights when the signal survives gating');
}

async function testFractionalAmaLookbackIsNormalizedBeforeSeriesLoops() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(300, 100, 1) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-fractional-lookback.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-fractional-lookback',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        signalConfirmBars: 0,
        regimeSensitivity: 0,
        alpha: 1,
        maxSlopeOffset: 10,
        amaSlope: {
            lookbackBars: 1.2,
            maxSlopePct: 0.01,
            neutralZonePct: 0,
        },
    };

    const state = { bots: { 'aaa-bbb-dw-fractional-lookback': { centerPrice: 100 } } };
    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed with fractional lookback config');
    assert.ok(writtenPayload?.dynamicWeights, 'dynamicWeights payload should be written');
    assert.strictEqual(writtenPayload.dynamicWeights.isReady, true, 'fractional lookback should not suppress readiness');
    assert.ok(
        writtenPayload.dynamicWeights.rawFinalOffset > 0,
        'AMA-only trend offset should be non-zero after lookback normalization'
    );
}

async function testDynamicWeightSignalConfirmBarsCanLatchFlatState() {
    let writtenPayload = null;
    const candles = generateUpThenFlatCandles(90, 8, 100, 1);

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (series) => series,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-confirm-flat.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-confirm-flat',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        alpha: 1,
        gain: 1,
        minOutputThreshold: 0,
        signalConfirmBars: 2,
        regimeSensitivity: 0,
        maxSlopeOffset: 0.5,
        maxVolatilityOffset: 0,
        amaSlope: {
            lookbackBars: 1,
            maxSlopePct: 1,
            neutralZonePct: 0,
            // This scenario tests the signal-confirm latch on raw Huber; keep
            // the EMA off so the flat tail really is a zero slope.
            emaAlpha: 1,
        },
    };

    const state = { bots: { 'aaa-bbb-dw-confirm-flat': { centerPrice: 100 } } };
    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload?.dynamicWeights, 'dynamic weights should be persisted');
    assert.strictEqual(writtenPayload.dynamicWeights.rawFinalOffset, 0, 'raw final signal should be flat');
    assert.strictEqual(writtenPayload.dynamicWeights.finalOffset, 0, 'confirmed final signal should latch back to flat');
    assert.strictEqual(result.weights.meta.trendOffset, 0, 'stale positive trend offset should not survive confirmed flat bars');
    assert.deepStrictEqual(writtenPayload.dynamicWeights.effectiveWeights, { sell: 0.6, buy: 0.4 },
        'flat confirmed state should restore static weights');
}

async function testDynamicWeightChartParityMatchesLiveService() {
    let writtenPayload = null;

    const candles = generateTrendShiftCandles(360, 100);
    const botAma = { enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 };
    const staticWeights = { sell: 0.6, buy: 0.4 };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        alpha: 0.35,
        dw: 0.7,
        gain: 1.75,
        signalConfirmBars: 2,
        minOutputThreshold: 0.08,
        regimeSensitivity: 1.0,
        maxSlopeOffset: 0.5,
        clipPercentile: 10,
        kalmanSmoothPct: 60,
        kalmanDispScaleMult: 1.7,
        kalmanDispThresholdMult: 1.15,
        kalmanSmoothSpanPct: 120,
        amaSlope: {
            lookbackBars: 2,
            maxSlopePct: 0.45,
            neutralZonePct: 0.01,
        },
        kalmanSlope: {
            maxSlopePct: 1.8,
        },
    };

    const parityInputs = buildDynamicWeightParityInputs(candles, cfg, botAma);
    const chartSeries = computeDirectionalOffsetSeries(parityInputs, { clampFinalOutput: false });
    const liveSeries = computeDirectionalOffsetSeries(parityInputs, { clampFinalOutput: true });

    assert.ok(
        chartSeries.combinedOffSeries.some((value) => Math.abs(value) > parityInputs.offsetClamp),
        'fixture should exercise chart values above the runtime clamp'
    );
    assert.ok(
        liveSeries.echoedOffSeries.some((value, index) => index > 0 && value !== liveSeries.combinedOffSeries[index]),
        'fixture should exercise signalConfirmBars latching'
    );
    assert.deepStrictEqual(
        liveSeries.gatedOffSeries,
        chartSeries.gatedOffSeries,
        'chart and live runtime should share the same pre-gain gated series'
    );
    assert.deepStrictEqual(
        liveSeries.echoedGatedOffSeries,
        chartSeries.echoedGatedOffSeries,
        'chart and live runtime should share the same confirmed pre-gain state'
    );
    assert.deepStrictEqual(
        liveSeries.combinedOffSeries,
        chartSeries.gatedOffSeries.map((value) => roundToDecimals(clamp(value * parityInputs.gain, -parityInputs.offsetClamp, parityInputs.offsetClamp), 3)),
        'live output should equal the chart shape after final gain and runtime clamping'
    );

    const expectedBelowThreshold = Math.abs(liveSeries.finalPreGainOff) < parityInputs.minOutputThreshold;
    const expectedVolatilityPenalty = parityInputs.slopeResult.isReady ? (parityInputs.slopeResult.symmetricDelta ?? 0) : 0;
    const expectedTrendOffset = expectedBelowThreshold ? 0 : liveSeries.finalOff;
    const expectedEffectiveWeights = {
        sell: roundToDecimals(
            clamp(
                staticWeights.sell - expectedTrendOffset + expectedVolatilityPenalty,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT
            ),
            2
        ),
        buy: roundToDecimals(
            clamp(
                staticWeights.buy + expectedTrendOffset + expectedVolatilityPenalty,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT,
                MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT
            ),
            2
        ),
    };

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => botAma,
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (series) => series,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-parity.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-parity',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: staticWeights,
    };

    const state = { bots: { 'aaa-bbb-dw-parity': { centerPrice: 100 } } };
    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.rawFinalOffset, liveSeries.rawFinalOff, 'persisted raw final offset should match the parity model');
    assert.strictEqual(dw.finalOffset, liveSeries.finalOff, 'persisted final offset should match the parity model');
    assert.strictEqual(dw.belowMinOutputThreshold, expectedBelowThreshold, 'persisted threshold gate should match the confirmed pre-gain state');
    assert.deepStrictEqual(dw.effectiveWeights, expectedEffectiveWeights, 'persisted effective weights should match the parity model');
    assert.notStrictEqual(expectedTrendOffset, 0, 'fixture should exercise a directional trend offset');
    if (expectedTrendOffset > 0) {
        assert.ok(dw.effectiveWeights.buy > staticWeights.buy, 'positive trend offset should increase buy weight');
        assert.ok(dw.effectiveWeights.sell < staticWeights.sell, 'positive trend offset should decrease sell weight');
    } else {
        assert.ok(dw.effectiveWeights.buy < staticWeights.buy, 'negative trend offset should decrease buy weight');
        assert.ok(dw.effectiveWeights.sell > staticWeights.sell, 'negative trend offset should increase sell weight');
    }
    assert.strictEqual(dw.regimeSensitivity, cfg.regimeSensitivity, 'persisted payload should retain regimeSensitivity for snapshot parity');
    assert.strictEqual(dw.absoluteThreshold, MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT,
        'persisted payload should retain absoluteThreshold for snapshot parity');
    assert.strictEqual(result.weights.meta.rawFinalOffset, liveSeries.rawFinalOff, 'service metadata should expose the same raw final offset');
    assert.strictEqual(result.weights.meta.finalOffset, liveSeries.finalOff, 'service metadata should expose the same final offset');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, expectedBelowThreshold, 'service metadata should expose the same threshold decision');
    assert.strictEqual(result.weights.meta.trendOffset, expectedTrendOffset, 'applied trend offset should match the parity model');
    assert.strictEqual(dw.regimeSensitivity, result.weights.meta.regimeSensitivity, 'snapshot and live metadata should agree on regimeSensitivity');
    assert.strictEqual(dw.absoluteThreshold, result.weights.meta.absoluteThreshold, 'snapshot and live metadata should agree on absoluteThreshold');
    assert.deepStrictEqual(
        { sell: result.weights.sell, buy: result.weights.buy },
        expectedEffectiveWeights,
        'service weights should match the parity model'
    );

    const narrowKalCfg = {
        ...cfg,
        kalmanSlope: { maxSlopePct: 0.45 },
    };
    const wideKalCfg = {
        ...cfg,
        kalmanSlope: { maxSlopePct: 1.8 },
    };
    const narrowKalInputs = buildDynamicWeightParityInputs(candles, narrowKalCfg, botAma);
    const wideKalInputs = buildDynamicWeightParityInputs(candles, wideKalCfg, botAma);

    assert.deepStrictEqual(
        narrowKalInputs.amaOffsets,
        wideKalInputs.amaOffsets,
        'AMA offsets should not change when only the Kalman slope knob changes'
    );
    assert.notDeepStrictEqual(
        narrowKalInputs.kalmanOffsets,
        wideKalInputs.kalmanOffsets,
        'Kalman offsets should respond to the separate Kalman slope knob'
    );

    // Non-default EMA alpha must reach the service, be published, and change
    // the slope the parity model computes (config layering is covered elsewhere).
    assert.strictEqual(dw.amaSlope.emaAlpha, 0.2, 'default EMA alpha should be reported in the persisted payload');
    assert.strictEqual(result.weights.meta.amaSlope.emaAlpha, 0.2, 'default EMA alpha should be reported in service metadata');
    const emaCfg = { ...cfg, amaSlope: { ...cfg.amaSlope, emaAlpha: 0.05 } };
    const emaInputs = buildDynamicWeightParityInputs(candles, emaCfg, botAma);
    assert.strictEqual(emaInputs.emaAlpha, 0.05, 'parity model should honour a non-default EMA alpha');
    assert.notStrictEqual(
        emaInputs.slopeResult.slopePct,
        parityInputs.slopeResult.slopePct,
        'non-default EMA alpha should change the published slope input'
    );
    const emaResult = await service.processBot(bot, { bots: { 'aaa-bbb-dw-parity': { centerPrice: 100 } } }, emaCfg, new Map(), {});
    assert.strictEqual(emaResult.ok, true);
    assert.strictEqual(writtenPayload.dynamicWeights.amaSlope.emaAlpha, 0.05,
        'service should publish the applied non-default EMA alpha');
    assert.strictEqual(emaResult.weights.meta.amaSlope.emaAlpha, 0.05,
        'service metadata should expose the applied non-default EMA alpha');
}

async function testDynamicWeightVolatilityOnlyPathRemainsReady() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-vol.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-vol',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-dw-vol': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0.08,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.profile, 'volatility', 'volatility-only path should identify its profile');
    assert.ok(result.weights.meta.volatilityPenalty < 0, 'volatility penalty should reduce weights');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, true, 'trend component should remain gated off');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.belowMinOutputThreshold, true, 'flat candles should still fail the trend threshold');
    assert.strictEqual(dw.isReady, true, 'volatility-only payload should remain ready');
    assert.ok(dw.volatilityPenalty < 0, 'payload should expose a negative volatility penalty');
    assert.ok(dw.effectiveWeights.sell < dw.baseWeights.sell, 'sell weight should be reduced by volatility');
    assert.ok(dw.effectiveWeights.buy < dw.baseWeights.buy, 'buy weight should be reduced by volatility');
    assert.notDeepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'volatility-only weights should differ from the static baseline');
}

async function testDynamicWeightVolatilityOverridesFlowIntoService() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-override.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-override',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-dw-override': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        volatilityExponent: 1.0,
        volatilityScaleX: 0.2,
        volatilityThreshold: 0.01,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.volatilityPenalty, -0.2, 'service should clamp volatility scaleX to the live/research minimum');
    assert.strictEqual(dw.effectiveWeights.sell, 0.4, 'sell weight should reflect the clamped volatility penalty');
    assert.strictEqual(dw.effectiveWeights.buy, 0.2, 'buy weight should reflect the clamped volatility penalty');
    assert.strictEqual(result.weights.meta.volatilityPenalty, -0.2, 'service metadata should reflect the clamped volatility penalty');
}

async function testDynamicWeightSuppressedTrendUsesFlatProfile() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.2) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-flat-profile.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-flat-profile',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-dw-flat-profile': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        gain: 2.0,
        minOutputThreshold: 2.0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.meta.trend, 'UP', 'raw trend should remain available in metadata');
    assert.strictEqual(result.weights.meta.belowMinOutputThreshold, true, 'trend output should be gated off by threshold');
    assert.strictEqual(result.weights.meta.trendOffset, 0, 'no trend offset should be applied when threshold suppresses it');
    assert.strictEqual(result.weights.profile, 'flat', 'profile should reflect the applied weighting mode');

    const dw = writtenPayload.dynamicWeights;
    assert.strictEqual(dw.isReady, false, 'suppressed trend without volatility should not be ready');
    assert.strictEqual(dw.outputThreshold, 2, 'live output threshold should stay in pre-gain space');
    assert.deepStrictEqual(dw.effectiveWeights, dw.baseWeights, 'effective weights should fall back to the static baseline');
}

async function testDynamicWeightWeightOnlyWritesPersistOnClosedCandle() {
    let writeCount = 0;
    let lastPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-persist.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writeCount += 1;
            lastPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-persist',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const previousGridResetAmaSlope = {
        trend: 'UP',
        slopePct: 0.25,
        slopeOffset: 0.1,
        isReady: true,
    };
    const state = {
        bots: {
            'aaa-bbb-dw-persist': {
                centerPrice: 100,
                amaSlopePercentMode: 'perBar',
                gridRangeScalingAmaSlope: previousGridResetAmaSlope,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const firstResult = await service.processBot(bot, state, cfg, new Map(), {});
    const firstWeights = { ...lastPayload.dynamicWeights.effectiveWeights };
    assert.strictEqual((state.bots['aaa-bbb-dw-persist'] as any).pendingClosedCandle, false, 'successful closed candle processing should clear the pending flag');
    const secondResult = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(firstResult.pendingClosedCandle, false, 'first closed candle cycle should process normally');
    assert.strictEqual((state.bots['aaa-bbb-dw-persist'] as any).pendingClosedCandle, true, 'state should mark the waiting poll after the second pass');
    assert.strictEqual(secondResult.pendingClosedCandle, true, 'second poll with no new closed candle should be skipped');
    assert.strictEqual(writeCount, 1, 'weight-only dynamic weights should only persist when a new closed candle is available');
    assert.deepStrictEqual(lastPayload.dynamicWeights.effectiveWeights, firstWeights, 'identical closed-candle data should yield identical effective weights');
    assert.deepStrictEqual(lastPayload.gridRangeScalingAmaSlope, previousGridResetAmaSlope, 'weight-only snapshot should preserve the last grid-reset slope baseline');
    assert.deepStrictEqual((state.bots['aaa-bbb-dw-persist'] as any).gridRangeScalingAmaSlope, previousGridResetAmaSlope, 'weight-only state update should not advance the reset slope baseline');
}

async function testDynamicWeightWeightOnlyWriteFailureDoesNotAdvanceState() {
    let writeCount = 0;
    let lastPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-fail.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writeCount += 1;
            lastPayload = payload;
            return writeCount > 1;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-fail',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-dw-fail': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const contextCache = new Map();
    const firstResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(firstResult.ok, true, 'processBot should still complete when weight-only persistence fails');
    assert.strictEqual(firstResult.triggered, false, 'weight-only persistence failure should not create a trigger');
    assert.strictEqual(firstResult.triggerSuppressedReason, 'dynamic_weight_persist_failed', 'failed weight-only write should be surfaced');
    assert.strictEqual(writeCount, 1, 'weight-only persistence should still be attempted');
    assert.strictEqual((state.bots['aaa-bbb-dw-fail'] as any).effectiveWeights, null, 'effective weights should not advance when snapshot write fails');
    assert.strictEqual((state.bots['aaa-bbb-dw-fail'] as any).amaCenterPrice, 100, 'raw AMA center should remain aligned with the last persisted snapshot');
    assert.strictEqual((state.bots['aaa-bbb-dw-fail'] as any).lastClosedCandleTs, null, 'failed weight-only persistence should not consume the closed candle');

    const secondResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(secondResult.ok, true, 'retry after weight-only persistence failure should complete');
    assert.strictEqual(secondResult.pendingClosedCandle, false, 'successful retry should process the same closed candle instead of skipping it');
    assert.strictEqual(secondResult.triggerSuppressedReason, null, 'successful retry should clear the persistence failure reason');
    assert.strictEqual(writeCount, 2, 'the same closed candle should be retried after weight-only persistence failure');
    assert.ok(lastPayload?.dynamicWeights, 'successful retry should write the dynamic weight payload');
    assert.ok((state.bots['aaa-bbb-dw-fail'] as any).effectiveWeights, 'effective weights should advance after a successful retry');
    assert.ok(Number.isFinite((state.bots['aaa-bbb-dw-fail'] as any).lastClosedCandleTs), 'successful retry should finally consume the closed candle');
}

async function testPlainAmaSnapshotRefreshFailureDoesNotConsumeClosedCandle() {
    let writeCount = 0;
    let lastPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.2) }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-ama-refresh-fail.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writeCount += 1;
            lastPayload = payload;
            return writeCount > 1;
        },
        isBotDynamicWeightWhitelisted: () => false,
        isBotAsymmetricBoundsWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-ama-refresh-fail',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-ama-refresh-fail': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const contextCache = new Map();
    const firstResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(firstResult.ok, true, 'processBot should still complete when plain AMA snapshot refresh fails');
    assert.strictEqual(firstResult.triggered, false, 'plain snapshot refresh failure should not create a trigger');
    assert.strictEqual(firstResult.triggerSuppressedReason, 'ama_center_persist_failed', 'plain snapshot refresh failure should reuse the AMA center persistence reason');
    assert.strictEqual(writeCount, 1, 'plain AMA snapshot refresh should be attempted');
    assert.strictEqual((state.bots['aaa-bbb-ama-refresh-fail'] as any).effectiveWeights, null, 'non-whitelisted refresh should not advance effective weights');
    assert.strictEqual((state.bots['aaa-bbb-ama-refresh-fail'] as any).amaCenterPrice, 100, 'raw AMA center should remain aligned with the last persisted snapshot');
    assert.strictEqual((state.bots['aaa-bbb-ama-refresh-fail'] as any).lastClosedCandleTs, null, 'failed plain snapshot refresh should not consume the closed candle');

    const secondResult = await service.processBot(bot, state, cfg, contextCache, {});

    assert.strictEqual(secondResult.ok, true, 'retry after plain snapshot refresh failure should complete');
    assert.strictEqual(secondResult.pendingClosedCandle, false, 'successful retry should process the same closed candle instead of skipping it');
    assert.strictEqual(secondResult.triggerSuppressedReason, null, 'successful retry should clear the persistence failure reason');
    assert.strictEqual(writeCount, 2, 'the same closed candle should be retried after plain snapshot refresh failure');
    assert.strictEqual(lastPayload?.dynamicWeights, undefined, 'plain AMA snapshot refresh should not persist dynamic weights without whitelist flags');
    assert.ok(Number.isFinite((state.bots['aaa-bbb-ama-refresh-fail'] as any).lastClosedCandleTs), 'successful retry should finally consume the closed candle');
}

async function testDynamicWeightWeightOnlyWritesAreSuppressedForStaleData() {
    let writeCount = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateCandles(1000, 100) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: true, staleAgeHours: 12.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-stale.trigger',
        writeBotDynamicGrid: () => {
            writeCount += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-stale',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-dw-stale': {
                centerPrice: 100,
                amaCenterPrice: 100,
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should still complete with stale data');
    assert.strictEqual(result.staleData, true, 'stale flag should be surfaced');
    assert.strictEqual(result.triggered, false, 'stale data should not create a trigger');
    assert.strictEqual(writeCount, 0, 'stale data should suppress weight-only snapshot writes');
    assert.strictEqual((state.bots['aaa-bbb-dw-stale'] as any).effectiveWeights, null, 'stale cycles should not update effective weights');
    assert.strictEqual((state.bots['aaa-bbb-dw-stale'] as any).amaCenterPrice, 100, 'raw AMA center should remain aligned with the last persisted snapshot');
}

async function testDynamicWeightInvalidAtrPeriodAndClampAreSanitized() {
    let writtenPayload = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateVolatileFlatCandles(1000, 100, 110, 90) }),
        saveJson: () => {},
        calculateBotThreshold: () => 100,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-sanitized.trigger',
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            writtenPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-sanitized',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-dw-sanitized': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        atrPeriod: 0,
        maxVolatilityOffset: -0.25,
        volatilityThreshold: 0.01,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.ok(writtenPayload, 'dynamic weights should be persisted');
    assert.strictEqual(result.weights.meta.atrPeriod, 14, 'invalid ATR periods should fall back to the default window');
    assert.strictEqual(result.weights.meta.maxVolatilityOffset, 0.5, 'invalid volatility clamps should fall back to the default cap');
    assert.ok(Number.isFinite(result.weights.meta.volatilityPenalty), 'sanitized volatility penalty should stay finite');
    assert.ok(result.weights.meta.volatilityPenalty < 0, 'sanitized volatility penalty should remain downward-only');
}

async function testDynamicWeightDiagnosticsComputeWithoutWhitelistForAmaBots() {
    let dynamicGridWrites = 0;
    let lastDynamicGridPayload = null;
    let triggerWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.5) }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => {
            triggerWrites += 1;
            return '/tmp/recalculate.aaa-bbb-dw-diagnostic.trigger';
        },
        writeBotDynamicGrid: (_botKey, _center, payload) => {
            dynamicGridWrites += 1;
            lastDynamicGridPayload = payload;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-diagnostic',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = {
        bots: {
            'aaa-bbb-dw-diagnostic': {
                centerPrice: 100,
                gridRangeScalingAmaSlope: { trend: 'UP', slopePct: 1.0, isReady: true },
            },
        },
    };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        regimeSensitivity: 0,
        signalConfirmBars: 0,
        maxVolatilityOffset: 0,
        amaSlopeDeltaThresholdPercent: 0.01,
        amaSlopePersistBars: 1,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(dynamicGridWrites, 1, 'non-whitelisted AMA bots should still refresh the AMA dynamic grid snapshot');
    assert.ok(lastDynamicGridPayload, 'dynamic grid payload should be captured');
    assert.strictEqual(lastDynamicGridPayload.amaSlope, null, 'non-whitelisted snapshot should not include dynamic-weight slope diagnostics');
    assert.strictEqual(lastDynamicGridPayload.dynamicWeights, undefined, 'non-whitelisted diagnostics should not persist live dynamic weights');
    assert.strictEqual(triggerWrites, 0, 'non-grid-range-scaling bots should not emit slope reset triggers');
    assert.strictEqual(result.dynamicWeightWhitelisted, false, 'whitelist flag should remain false');
    assert.strictEqual(result.dynamicWeightReady, false, 'non-whitelisted bots should not compute dynamic weights');
    assert.strictEqual(result.dynamicWeightApplied, false, 'non-whitelisted weights should not be reported as applied');
    assert.strictEqual(result.weights, null, 'non-whitelisted bots should not return dynamic-weight diagnostics');
    assert.strictEqual(result.amaSlope, null, 'non-whitelisted bots should not return dynamic-weight slope diagnostics');
    assert.strictEqual((state.bots['aaa-bbb-dw-diagnostic'] as any).effectiveWeights, null, 'non-whitelisted diagnostics should not update live effective weights');
}

async function testDynamicWeightRequiresAmaAndDynamicWeightWhitelist() {
    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.5) }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-ama-required.trigger',
        writeBotDynamicGrid: () => true,
        isBotWhitelisted: () => false,
        isBotDynamicWeightWhitelisted: () => true,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-ama-required',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };
    const state = { bots: { 'aaa-bbb-dw-ama-required': { centerPrice: 100 } } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        regimeSensitivity: 0,
        signalConfirmBars: 0,
        maxVolatilityOffset: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(result.dynamicWeightWhitelisted, false, 'dynamic weights require AMA whitelist plus dynamicWeight flag');
    assert.strictEqual(result.dynamicWeightReady, false, 'dynamicWeight-only whitelist should not compute dynamic weights');
    assert.strictEqual(result.weights, null, 'dynamicWeight-only whitelist should not expose weights');
    assert.strictEqual((state.bots['aaa-bbb-dw-ama-required'] as any).effectiveWeights, null, 'dynamicWeight-only whitelist should not update state weights');
}

async function testDynamicWeightDiagnosticsDoNotLeakIntoBootstrapState() {
    let dynamicGridWrites = 0;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_1h.json`),
        loadJson: () => ({ candles: generateTrendingCandles(1000, 100, 0.5) }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 1.0 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => [...existing, ...incoming],
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeGridResetTrigger: () => '/tmp/recalculate.aaa-bbb-dw-bootstrap-diagnostic.trigger',
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => false,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dw-bootstrap-diagnostic',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.6, buy: 0.4 },
    };

    const state = { bots: { 'aaa-bbb-dw-bootstrap-diagnostic': {} } };
    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 1200,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        minOutputThreshold: 0,
        regimeSensitivity: 0,
        signalConfirmBars: 0,
        maxVolatilityOffset: 0,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(dynamicGridWrites, 1, 'bootstrap should still persist the AMA center snapshot');
    assert.strictEqual(result.dynamicWeightReady, false, 'non-whitelisted bootstrap should not compute dynamic weights');
    assert.strictEqual(result.dynamicWeightApplied, false, 'bootstrap weights should not be reported as applied');
    assert.strictEqual((state.bots['aaa-bbb-dw-bootstrap-diagnostic'] as any).effectiveWeights, null, 'non-whitelisted bootstrap diagnostics should not update live effective weights');
}

async function testWeightOnlyUpdateInDryRunUpdatesState() {
    let dynamicGridWrites = 0;
    const closedTs = Date.parse('2026-01-01T12:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: (botKey) => path.join('/tmp', `market_adapter_${botKey}_dry_run.json`),
        loadJson: () => ({
            candles: [
                [closedTs - 3 * hour, 100, 100, 100, 100, 1],
                [closedTs - 2 * hour, 100, 100, 100, 100, 1],
                [closedTs - 1 * hour, 100, 100, 100, 100, 1],
                [closedTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 10,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing, incoming) => existing,
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeBotDynamicGrid: () => {
            dynamicGridWrites += 1;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        getNowMs: () => closedTs + hour + 60 * 1000,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-dry-run',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.5, buy: 0.5 },
    };

    const state = {
        bots: {
            'aaa-bbb-dry-run': {
                centerPrice: 100,
                amaCenterPrice: 100,
                lastClosedCandleTs: closedTs - hour,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlope: {
            lookbackBars: 0,
            maxSlopePct: 1,
            neutralZonePct: 0
        }
    };

    const result = await service.processBot(bot, state, cfg, new Map(), { isDryRun: true });

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(dynamicGridWrites, 0, 'writeBotDynamicGrid should not be called in dry run');
    assert.ok((state.bots['aaa-bbb-dry-run'] as any).effectiveWeights, 'state should be updated with effective weights even in dry run');
}

async function testOffHourSkipAvoidsNetworkWhenClosedCandleConsumed() {
    // Newest CLOSED bucket is 11:00; the adapter is inspected at 12:24, i.e.
    // 24 minutes into the following hour, exactly like a mid-hour respawn.
    const hour = 3600000;
    const newestClosedTs = Date.parse('2026-01-01T11:00:00Z');
    const nowMs = newestClosedTs + hour + 24 * 60 * 1000;
    let avoidableWork = 0;
    // Healthy cache: enough history for the (tiny) AMA warmup, and covering
    // the newest closed bucket — that is what makes the off-hour skip safe.
    const cachedCandles = Array.from({ length: 400 }, (_, idx) => {
        const ts = newestClosedTs - ((399 - idx) * hour);
        return [ts, 100, 100, 100, 100, 1];
    });
    // The still-forming 12:00 bar, as a live cache would hold it.
    cachedCandles.push([newestClosedTs + hour, 100, 100, 100, 100, 1]);

    const service = new MarketAdapterService({
        // Context resolution stays (it is what yields the real AMA config the
        // warmup target depends on) and only costs a couple of lookups on the
        // already-open connection, so it is NOT charged as avoidable work.
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, name: 'AMA1', erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: () => path.join('/tmp', 'market_adapter_off_hour_skip.json'),
        loadJson: (filePath) => {
            // The local candle read is expected; the dynamic-grid snapshot load
            // is charged, because the skip must not need it.
            if (String(filePath).includes('dynamicgrid')) {
                avoidableWork++;
                return null;
            }
            return { meta: { marketSource: 'pool' }, candles: cachedCandles };
        },
        saveJson: () => { avoidableWork++; },
        calculateBotThreshold: () => 1,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.1 }),
        withRetries: async (fn) => { avoidableWork++; return fn(); },
        kibanaSource: { getLpCandlesForPool: async () => { avoidableWork++; return []; } },
        fetchNativeTradesSince: async () => { avoidableWork++; return { trades: [], truncated: false, pages: 1 }; },
        tradesToCandles: () => [],
        mergeCandles: (existing) => existing,
        pruneCandles: (candles) => candles,
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        buildAmaRecord: () => [],
        writeBotDynamicGrid: () => { avoidableWork++; return true; },
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-off-hour-skip',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
    };

    const state = {
        bots: {
            'aaa-bbb-off-hour-skip': {
                botName: 'AAA-BBB',
                botKey: 'aaa-bbb-off-hour-skip',
                gridCenterPrice: 100,
                centerPrice: 100,
                lastClosedCandleTs: newestClosedTs,
            },
        },
    };

    const cfg = { intervalSeconds: 3600 };
    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'off-hour skip should succeed');
    assert.strictEqual(result.source, 'off-hour-skip', 'consumed closed candle should skip before any fetch');
    assert.strictEqual(result.pendingClosedCandle, true, 'skip should report the pending closed candle');
    assert.strictEqual(result.triggerSuppressedReason, 'waiting_for_new_closed_candle', 'skip should use the closed-candle gate reason');
    assert.strictEqual(avoidableWork, 0, 'skip must not fetch candles, verify gaps, or write snapshots/state files');
    assert.strictEqual((state.bots['aaa-bbb-off-hour-skip'] as any).gridCenterPrice, 100, 'skip must preserve the stored center');
    assert.strictEqual((state.bots['aaa-bbb-off-hour-skip'] as any).lastCycleSource, 'off-hour-skip', 'skip should mark the cycle source');
}

async function testOffHourSkipIsDisabledForOneShotRuns() {
    // --once / runOnceForAma exist to produce a result on demand (the signal
    // runner prints the AMA, an operator asks for a fresh cycle). A
    // state-only "skipped" record would report nulls instead, so one-shot
    // entry points must always run the full cycle.
    const hour = 3600000;
    const newestClosedTs = Date.parse('2026-01-01T11:00:00Z');
    const nowMs = newestClosedTs + hour + 24 * 60 * 1000;
    const cachedCandles = Array.from({ length: 400 }, (_, idx) => {
        const ts = newestClosedTs - ((399 - idx) * hour);
        return [ts, 100, 100, 100, 100, 1];
    });
    cachedCandles.push([newestClosedTs + hour, 100, 100, 100, 100, 1]);

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, name: 'AMA1', erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: () => path.join('/tmp', 'market_adapter_once_full_cycle.json'),
        loadJson: () => ({ meta: { marketSource: 'pool' }, candles: cachedCandles }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing) => existing,
        pruneCandles: (candles) => candles,
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        buildAmaRecord: () => [],
        writeBotDynamicGrid: () => true,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = { name: 'AAA-BBB', botKey: 'aaa-bbb-once', assetA: 'IOB.XRP', assetB: 'BTS', gridPrice: 'ama' };
    const state = {
        bots: { 'aaa-bbb-once': { gridCenterPrice: 100, centerPrice: 100, lastClosedCandleTs: newestClosedTs } },
    };

    const onceResult = await service.processBot(bot, state, { intervalSeconds: 3600, once: true }, new Map(), {});
    assert.strictEqual(onceResult.ok, true, 'one-shot run should succeed');
    assert.notStrictEqual(onceResult.source, 'off-hour-skip', '--once must always run a full cycle');

    // Same state, same clock — the daemon cycle is allowed to skip.
    const daemonResult = await service.processBot(
        bot,
        state,
        { intervalSeconds: 3600 },
        new Map(),
        {}
    );
    assert.strictEqual(daemonResult.source, 'off-hour-skip', 'the long-running daemon may still skip');
}

async function testOffHourSkipDeclinedWhenCacheNeedsRepair() {
    const hour = 3600000;
    const newestClosedTs = Date.parse('2026-01-01T11:00:00Z');
    const nowMs = newestClosedTs + hour + 24 * 60 * 1000;
    // Cache stops BEFORE the newest closed bucket: the backfill path still has
    // work to do, so the cycle must run even though the state marker already
    // equals the newest closed bucket.
    const shortCandles = Array.from({ length: 400 }, (_, idx) => {
        const ts = newestClosedTs - ((400 - idx) * hour);
        return [ts, 100, 100, 100, 100, 1];
    });
    let ran = false;

    const service = new MarketAdapterService({
        resolveBotContext: async () => {
            ran = true;
            return {
                assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
                assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
                poolId: '1.19.133',
            };
        },
        resolveAmaForBot: () => ({ enabled: true, name: 'AMA1', erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: () => path.join('/tmp', 'market_adapter_off_hour_repair.json'),
        loadJson: () => ({ meta: { marketSource: 'pool' }, candles: shortCandles }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing) => existing,
        pruneCandles: (candles) => candles,
        detectMissingCandleTimestamps: () => ({ gapCount: 0, missingTimestamps: [] }),
        buildAmaRecord: () => [],
        writeBotDynamicGrid: () => true,
        getNowMs: () => nowMs,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-off-hour-repair',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
    };
    const state = {
        bots: {
            'aaa-bbb-off-hour-repair': { gridCenterPrice: 100, centerPrice: 100, lastClosedCandleTs: newestClosedTs },
        },
    };

    const result = await service.processBot(bot, state, { intervalSeconds: 3600 }, new Map(), {});

    assert.strictEqual(result.ok, true, 'repair cycle should succeed');
    assert.notStrictEqual(result.source, 'off-hour-skip', 'a cache that misses the newest closed bucket must not skip');
    assert.ok(ran, 'a cache that needs repair must reach the full path');
}

async function testOffHourSkipFallsThroughWhenClosedCandleIsNew() {
    const closedTs = Date.parse('2026-01-01T12:00:00Z');
    const hour = 3600000;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: () => path.join('/tmp', 'market_adapter_off_hour_run.json'),
        loadJson: () => ({
            candles: [
                [closedTs - 3 * hour, 100, 100, 100, 100, 1],
                [closedTs - 2 * hour, 100, 100, 100, 100, 1],
                [closedTs - hour, 100, 100, 100, 100, 1],
                [closedTs, 100, 100, 100, 100, 1],
            ],
        }),
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing) => existing,
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeBotDynamicGrid: () => true,
        getNowMs: () => closedTs + hour + 60 * 1000,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey: 'aaa-bbb-off-hour-run',
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
    };

    const state = {
        bots: {
            'aaa-bbb-off-hour-run': {
                gridCenterPrice: 100,
                centerPrice: 100,
                lastClosedCandleTs: closedTs - hour,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'new closed candle should run the full cycle');
    assert.notStrictEqual(result.source, 'off-hour-skip', 'new closed candle must not take the skip path');
}

function testLatestClosedBucketStartMsArithmetic() {
    const service = new MarketAdapterService({});
    const now = Date.parse('2026-09-28T00:24:30.000Z');
    assert.strictEqual(
        service.latestClosedBucketStartMs(3600, now),
        Date.parse('2026-09-27T23:00:00.000Z'),
        'latest closed bucket at :24 past the hour is the previous hour'
    );
    assert.strictEqual(service.latestClosedBucketStartMs(0, now), null, 'invalid interval must not evaluate');
    assert.strictEqual(service.latestClosedBucketStartMs(3600, NaN), null, 'invalid clock must not evaluate');
}

function testShouldSkipBotForClosedCandleVerdicts() {
    const service = new MarketAdapterService({});
    const now = Date.parse('2026-09-28T00:24:30.000Z');
    const consumed = Date.parse('2026-09-27T23:00:00.000Z');
    const skip = service.shouldSkipBotForClosedCandle({}, { lastClosedCandleTs: consumed }, 3600, now);
    assert.ok(skip, 'consumed newest closed bucket should skip');
    assert.strictEqual(skip.previousClosedCandleTs, consumed, 'skip should report the consumed marker');
    assert.strictEqual(
        service.shouldSkipBotForClosedCandle({}, { lastClosedCandleTs: consumed - 3600000 }, 3600, now),
        null,
        'older marker means a new candle is available: run'
    );
    assert.strictEqual(
        service.shouldSkipBotForClosedCandle({}, { lastClosedCandleTs: consumed + 3600000 }, 3600, now),
        null,
        'marker ahead of the wall clock must not skip (clock skew / carried state)'
    );
    assert.strictEqual(service.shouldSkipBotForClosedCandle({}, {}, 3600, now), null, 'fresh state must run bootstrap');
    assert.strictEqual(service.shouldSkipBotForClosedCandle(null, null, 3600, now), null, 'unknown state must run');
    assert.strictEqual(service.shouldSkipBotForClosedCandle({}, { lastClosedCandleTs: consumed }, 0, now), null, 'invalid interval must run');
}

function testCandleFileCoversClosedBucketGuards() {
    const service = new MarketAdapterService({});
    const closed = Date.parse('2026-09-27T23:00:00.000Z');
    const covering = [[closed, 1, 1, 1, 1, 1]];
    assert.strictEqual(
        service.candleFileCoversClosedBucket(covering, { marketSource: 'pool' }, 'pool', closed, 1),
        true,
        'a cache holding the newest closed bucket covers it'
    );
    assert.strictEqual(
        service.candleFileCoversClosedBucket(covering, { marketSource: 'book' }, 'pool', closed, 1),
        false,
        'a source switch must never be skipped'
    );
    assert.strictEqual(
        service.candleFileCoversClosedBucket(covering, { marketSource: 'pool', pool: '1.19.133' }, 'book', closed, 1),
        false,
        'a legacy pool cache under a book-configured bot must never be skipped'
    );
    assert.strictEqual(
        service.candleFileCoversClosedBucket(covering, { marketSource: 'book' }, 'pool', closed, 1),
        false,
        'a book cache under a pool-configured bot must never be skipped'
    );
    assert.strictEqual(
        service.candleFileCoversClosedBucket(covering, { marketSource: 'pool', unresolvedGapCount: 3 }, 'pool', closed, 1),
        false,
        'unresolved gaps must still be repaired'
    );
    assert.strictEqual(
        service.candleFileCoversClosedBucket(covering, { marketSource: 'pool' }, 'pool', closed, 5),
        false,
        'history shorter than the warmup target must still be backfilled'
    );
    assert.strictEqual(
        service.candleFileCoversClosedBucket([[closed - 3600000, 1, 1, 1, 1, 1]], { marketSource: 'pool' }, 'pool', closed, 1),
        false,
        'a cache that stops before the closed bucket does not cover it'
    );
    assert.strictEqual(
        service.candleFileCoversClosedBucket([], { marketSource: 'pool' }, 'pool', closed, 1),
        false,
        'an empty cache does not cover anything'
    );
}

function testCandleSourceMismatchIsSharedWithFullPath() {
    const service = new MarketAdapterService({});
    // The predicate the gate uses must be the same one the full path resets on.
    assert.strictEqual(service.isCandleSourceMismatch({ marketSource: 'book' }, 'pool'), true, 'book cache under a pool bot');
    assert.strictEqual(service.isCandleSourceMismatch({ marketSource: 'pool', pool: '1.19.133' }, 'book'), true, 'pool context under a book bot');
    assert.strictEqual(service.isCandleSourceMismatch({ marketSource: 'pool' }, 'pool'), false, 'matching pool source');
    assert.strictEqual(service.isCandleSourceMismatch({ marketSource: 'book' }, 'book'), false, 'matching book source');
    assert.strictEqual(service.isCandleSourceMismatch({}, 'pool'), false, 'no stored source is not a mismatch');
}

async function testNewerDynamicGridResetCenterOverridesStaleAdapterState() {
    const botKey = 'aaa-bbb-newer-reset-center';
    const closedTs = Date.parse('2026-01-01T12:00:00Z');
    const hour = 3600000;
    let writtenCenter = null;

    const service = new MarketAdapterService({
        resolveBotContext: async () => ({
            assetA: { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
            poolId: '1.19.133',
        }),
        resolveAmaForBot: () => ({ enabled: true, erPeriod: 1, fastPeriod: 1, slowPeriod: 1 }),
        candleFileForBot: () => path.join('/tmp', `market_adapter_${botKey}_newer_reset.json`),
        loadJson: (filePath) => {
            if (String(filePath).endsWith(`${botKey}.dynamicgrid.json`)) {
                return {
                    gridCenterPrice: 130,
                    centerPrice: 130,
                    amaCenterPrice: 130,
                    lastGridResetAt: '2026-05-15T00:01:00.327Z',
                    lastGridResetSource: 'manual_grid_resync',
                    updatedAt: '2026-05-15T00:01:00.327Z',
                };
            }
            return {
                candles: [
                    [closedTs - 3 * hour, 130, 130, 130, 130, 1],
                    [closedTs - 2 * hour, 130, 130, 130, 130, 1],
                    [closedTs - hour, 130, 130, 130, 130, 1],
                    [closedTs, 130, 130, 130, 130, 1],
                ],
            };
        },
        saveJson: () => {},
        calculateBotThreshold: () => 1000,
        computeCandleStaleness: () => ({ staleData: false, staleAgeHours: 0.1 }),
        withRetries: async (fn) => fn(),
        kibanaSource: { getLpCandlesForPool: async () => [] },
        fetchNativeTradesSince: async () => ({ trades: [], truncated: false, pages: 1 }),
        tradesToCandles: () => [],
        mergeCandles: (existing) => existing,
        pruneCandles: (candles) => candles,
        buildAmaRecord: () => [],
        writeBotDynamicGrid: (_botKey, center) => {
            writtenCenter = center;
            return true;
        },
        isBotDynamicWeightWhitelisted: () => true,
        getNowMs: () => closedTs + hour + 60 * 1000,
        root: process.cwd(),
        path,
    });

    const bot = {
        name: 'AAA-BBB',
        botKey,
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        gridPrice: 'ama',
        incrementPercent: 0.4,
        weightDistribution: { sell: 0.5, buy: 0.5 },
    };

    const state = {
        bots: {
            [botKey]: {
                centerPrice: 100,
                gridCenterPrice: 100,
                amaCenterPrice: 100,
                lastGridResetAt: '2026-05-13T18:00:01.190Z',
                lastClosedCandleTs: closedTs - hour,
            },
        },
    };

    const cfg = {
        intervalSeconds: 3600,
        bootstrapLookbackHours: 100,
        nativeBackfillHours: 6,
        pageLimit: 100,
        maxPages: 80,
        sourceRetries: 1,
        retryDelayMs: 0,
        maxStaleHours: 6,
        amaSlope: {
            lookbackBars: 0,
            maxSlopePct: 1,
            neutralZonePct: 0
        }
    };

    const result = await service.processBot(bot, state, cfg, new Map(), {});

    assert.strictEqual(result.ok, true, 'processBot should succeed');
    assert.strictEqual(writtenCenter, 130, 'weight-only snapshot write should preserve the newer reset center');
    assert.strictEqual((state.bots[botKey] as any).gridCenterPrice, 130);
    assert.strictEqual((state.bots[botKey] as any).centerPrice, 130);
    assert.strictEqual((state.bots[botKey] as any).lastGridResetAt, '2026-05-15T00:01:00.327Z');
    assert.strictEqual((state.bots[botKey] as any).lastGridResetSource, 'manual_grid_resync');
}

async function run() {
    await testTriggerHookCalledOnThreshold();
    await testNumericStartPriceSkipsAllMarketFetches();
    await testBookNativeFetchUsesBitsharesHistory();
    await testBookIncrementalFillsVerifiedLongSilence();
    await testBookIncrementalFillsBoundedNoTradeSilence();
    await testBookIncrementalFillsVerifiedLongSilenceBeforeLaterNativeActivity();
    await testBookIncrementalIgnoresNativeOverlapWhenVerifyingSilenceBeforeActivity();
    await testAmaWithFlatCandlesComputesValidPrice();
    await testKibanaBackfillFillsHistoricalShortfall();
    await testRestartBackfillsOldAma3WindowBeforeWaitingForNextClosedCandle();
    await testRestartBackfillsOldAma3WindowEvenWhenGapRepairWasAttempted();
    await testRestartBackfillsOldAma3WindowAndTriggersWhenDeltaThresholdIsExceeded();
    await testIdOnlyBotIsNotRejected();
    await testBootstrapFallsBackWhenKibanaIsEmpty();
    await testAmaGridPriceIsCaseInsensitive();
    await testAmaTriggerSuppressedWhenCenterPersistFails();
    await testAmaCenterPersistFailureBlocksSlopeTriggerFallback();
    await testBootstrapCenterDoesNotAdvanceWhenPersistFails();
    await testCenterEqualsAmaTriggeredByAmaDelta();
    await testNoTriggerWhenCenterMatchesAma();
    await testGridCenterPriceOnlyStateRestoresBaseline();
    await testCenterClampedByBotBounds();
    await testContextCacheInvalidatesOnPoolChange();
    await testKibanaGapRepairPatchesMissingCandles();
    testGapRepairRangeUsesSuspiciousGapThresholdInsteadOfNativeBackfillWindow();
    await testInternalNoTradeGapsAreAutoFilledWithinTrustedThreshold();
    await testEmptyKibanaResponseResolvesAllGapsInWindow();
    await testNativeIncrementalFillsNoTradeGapsUpToStaleTailThreshold();
    await testNativeIncrementalDoesNotFillNoTradeGapsPastStaleTailThreshold();
    await testNativeIncrementalFillsVerifiedLongSilence();
    await testNativeIncrementalFillsVerifiedLongSilenceBeforeLaterActivity();
    await testNativeIncrementalMergesKibanaActivityInsteadOfSilence();
    await testStaleTailThresholdCanBeOverriddenPerConfig();
    await testStaleTailVerificationRangeIsPersisted();
    await testLegacyStaleTailVerificationTimestampIsHonored();
    await testSourceMismatchClearsPersistedStaleTailVerificationRange();
    await testNativeIncrementalUsesTradeSequenceOverlap();
    await testNativeIncrementalFallsBackWhenOverlapNotReached();
    await testTimeBasedNativeIncrementalDoesNotReaggregateExistingBuckets();
    await testClosedCandleGateSkipsCurrentPartialHour();
    await testClosedCandleGateSurfacesStaleData();
    await testClosedCandlePruningRetainsFullDynamicWeightWarmup();
    testSleepUntilAlignedBoundaryAnchorsToCycleStart();
    testComputeStartupDelayMsHonorsPollBoundary();
    testComputeStartupDelayMsNeverSleepsOnMismatchedGrids();
    testStartupSleepIsPerBotNeverAggregated();
    testStartupSleepIgnoresInactiveStateRows();
    testStartupSleepDefersToRepairWhenOutstanding();
    testStartupSleepNeverDelaysTheHourlyCandle();
    testAppliedAsymmetryMetricsClampToSafeBounds();
    testAppliedAsymmetryMetricsPreferRawSlopeOffset();
    await testDynamicWeightBelowMinOutputThresholdFallsBackToStaticWeights();
    await testDynamicWeightMinOutputThresholdZeroDisablesGate();
    await testDynamicWeightGainScalesOutputLinearly();
    await testFractionalAmaLookbackIsNormalizedBeforeSeriesLoops();
    await testDynamicWeightSignalConfirmBarsCanLatchFlatState();
    await testCenterStableButSlopeDeltaTriggersReset();
    await testAmaSlopeEmaAlphaDrivesLiveResetDelta();
    await testAmaSlopePersistenceGate();
    await testSlopeTriggerRecoversBaselineFromDynamicGridAfterStateClear();
    testSlopeDirectionChangeDoesNotTriggerBelowDeltaThreshold();
    testNonPositiveSlopeThresholdDisablesTrigger();
    testUnreadySlopeBaselineDoesNotTrigger();
    testLegacyStateSlopeDiagnosticsConvertToPerBar();
    testMarkedPerBarStateSlopeDiagnosticsStayUnchanged();
    await testLegacyDynamicGridSlopeBaselineIsNormalizedBeforeComparison();
    await testSlopePersistFailurePreservesRetryBaseline();
    await testDynamicWeightChartParityMatchesLiveService();
    await testDynamicWeightVolatilityOnlyPathRemainsReady();
    await testDynamicWeightVolatilityOverridesFlowIntoService();
    await testDynamicWeightSuppressedTrendUsesFlatProfile();
    await testDynamicWeightWeightOnlyWritesPersistOnClosedCandle();
    await testDynamicWeightWeightOnlyWriteFailureDoesNotAdvanceState();
    await testPlainAmaSnapshotRefreshFailureDoesNotConsumeClosedCandle();
    await testDynamicWeightWeightOnlyWritesAreSuppressedForStaleData();
    await testDynamicWeightInvalidAtrPeriodAndClampAreSanitized();
    await testDynamicWeightDiagnosticsComputeWithoutWhitelistForAmaBots();
    await testDynamicWeightRequiresAmaAndDynamicWeightWhitelist();
    await testDynamicWeightDiagnosticsDoNotLeakIntoBootstrapState();
    await testWeightOnlyUpdateInDryRunUpdatesState();
    await testNewerDynamicGridResetCenterOverridesStaleAdapterState();
    await testOffHourSkipAvoidsNetworkWhenClosedCandleConsumed();
    await testOffHourSkipIsDisabledForOneShotRuns();
    await testOffHourSkipDeclinedWhenCacheNeedsRepair();
    await testOffHourSkipFallsThroughWhenClosedCandleIsNew();
    testLatestClosedBucketStartMsArithmetic();
    testShouldSkipBotForClosedCandleVerdicts();
    testCandleFileCoversClosedBucketGuards();
    testCandleSourceMismatchIsSharedWithFullPath();
}

run()
    .then(() => {
        console.log('market adapter service tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exitCode = 1;
    });

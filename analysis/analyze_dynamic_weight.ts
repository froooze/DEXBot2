#!/usr/bin/env node
'use strict';

/**
 * DYNAMIC WEIGHT RESEARCH TOOL
 *
 * Computes AMA slope + Kalman + Hurst + PE signals and generates an
 * interactive HTML chart for researching dynamic weight parameters.
 *
 * Usage:
 *   node dist/analysis/analyze_dynamic_weight.js \
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

import { getErrorMessage } from '../modules/utils/errors.js';
import type { TrendAnalysis } from './trend_detection/kalman_trend_analyzer.js';
import path from 'node:path';
import { KalmanTrendAnalyzer } from './trend_detection/kalman_trend_analyzer.js';
import { HurstAnalyzer } from './trend_detection/hurst_analyzer.js';
import { PermutationEntropyAnalyzer } from './trend_detection/permutation_entropy_analyzer.js';
import { generateHTML } from './trend_detection/dynamic_weight_chart_generator.js';
import { calculateAMA } from '../market_adapter/core/strategies/ama.js';
import { computeAmaSlopeWeights, createAmaSlopeClipTracker } from '../market_adapter/core/strategies/ama_slope_model.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { PATHS } from '../modules/paths.js';
import { writeChartFile, toFileUrl } from './chart_utils.js';
import { CLI_TAGS, savedLine } from '../modules/cli_progress.js';
import { getCandleClose } from './math_utils.js';
import { resolveSource, listAvailableBots, type SourceConfig } from './resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from './analyze_args.js';


// AMA Slope weight calculation config — use DEFAULTS from market adapter
const AMA_WEIGHT_CONFIG = {
    lookbackBars:           MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
    amaMaxSlopePct:         MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
    kalmanMaxSlopePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
    neutralZonePct:         MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
    volatilityExponent:     MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
    volatilityScaleX:       MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
    volatilityThreshold:    MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD,
    maxSlopeOffset:         MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
    maxVolatilityOffset:    MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP,
};

// Kalman configuration
const KALMAN_CONFIG = {
    rNoise: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_R_NOISE_DEFAULT,
    qTactical: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_TACTICAL_DEFAULT,
    qModal: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_MODAL_DEFAULT,
};

// Regime analyzers configuration (Hurst + Permutation Entropy)
const { HURST_CONFIG, PE_CONFIG } = MARKET_ADAPTER;


function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: SourceConfig };
        chartFile: string;
        title: string | null;
        alpha?: number;
        gain?: number;
        dispWeight?: number;
        clipPct?: number;
        quiet: boolean;
        listBots: boolean;
        lookbackBars?: number;
        dispScaleMinPct?: number;
    } = {
        ...baseAnalysisConfig(),
        chartFile: path.join(PATHS.ANALYSIS.CHARTS_DIR, 'dynamic_weight_chart.html'),
        title: null,
        alpha: MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA,
        gain: MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN,
        dispWeight: MARKET_ADAPTER.DYNAMIC_WEIGHT_DW,
        clipPct: MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--title') config.title = args[++i] ?? null;
        else if (arg === '--alpha') config.alpha = parseFloat(args[++i]);
        else if (arg === '--gain') config.gain = parseFloat(args[++i]);
        else if (arg === '--dw') config.dispWeight = parseFloat(args[++i]);
        else if (arg === '--lb') config.lookbackBars = parseInt(args[++i], 10);
        else if (arg === '--clip') config.clipPct = parseFloat(args[++i]);
    }

    return config;
}

async function main() {
    try {
        const config = parseArgs();

        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source, amaConfig, amaKey } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });

        const AMA_CONFIG = amaConfig;
        if (!config.quiet) console.log(`[DynamicWeight] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Kalman analysis ──────────────────────────────────────────────────
        const analyzer = new KalmanTrendAnalyzer({
            rNoise: KALMAN_CONFIG.rNoise,
            qTactical: KALMAN_CONFIG.qTactical,
            qModal: KALMAN_CONFIG.qModal,
        });

        // ── Hurst & PE analyzers ──────────────────────────────────────────────
        const hurstAnalyzer = new HurstAnalyzer({
            window: HURST_CONFIG.window,
            scales: HURST_CONFIG.scales,
        });
        const peAnalyzer = new PermutationEntropyAnalyzer({
            m:      PE_CONFIG.m,
            delay:  PE_CONFIG.delay,
            window: PE_CONFIG.window,
        });

        interface DynamicWeightResult extends Omit<TrendAnalysis, 'hurst' | 'pe'> {
            timestamp: number;
            price: number;
            hurst: number | null;
            pe: number | null;
            ama3Price?: number | null;
            atr?: number;
            weightVariance?: number;
            amaSlopePct?: number | null;
            amaWeightReady?: boolean;
            amaSlopeOffset?: number | null;
            amaSymmetricDelta?: number | null;
        }

        const allResults: DynamicWeightResult[] = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const result = analyzer.update(marketPrice) as DynamicWeightResult;
            const hurst = hurstAnalyzer.update(marketPrice);
            const pe    = peAnalyzer.update(marketPrice);
            result.timestamp = timestamp;
            result.price = marketPrice;
            result.hurst = hurst.isReady ? hurst.hurst : null;
            result.pe    = pe.isReady    ? pe.normalizedEntropy : null;
            allResults.push(result);
        }

        // ── AMA weight calculation ───────────────────────────────────────────
        const closes = candles.map(c => getCandleClose(c) ?? 0);
        const amaValues = calculateAMA(closes, AMA_CONFIG);
        const lbBars = config.lookbackBars ?? AMA_WEIGHT_CONFIG.lookbackBars;
        const clipPercentile = config.clipPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;

        // Incremental percentile clip threshold (shared with the market adapter)
        // so the research offset matches the live asymmetry. Feeding bar-by-bar
        // keeps the pool prefix-only — no look-ahead, same thresholds the live
        // service would have seen at each point in time.
        const clipTracker = createAmaSlopeClipTracker(AMA_CONFIG.erPeriod, lbBars, clipPercentile);
        // Minimal history window computeAmaSlopeWeights can act on (guard is
        // erPeriod + lookbackBars + 1 and it only reads the last two sampled
        // bars), so a rolling slice avoids O(n²) prefix copies.
        const weightWindowBars = Math.ceil(AMA_CONFIG.erPeriod) + lbBars + 1;

        for (let i = 0; i < allResults.length; i++) {
            // The research chart keeps ATR out of the Kalman branch on purpose.
            // Production applies ATR later as a separate symmetric volatility penalty.
            const atr = 0;
            const weightVariance = 0;
            const amaClipThreshold = clipTracker.push(amaValues[i] ?? NaN);
            const slice = amaValues.slice(Math.max(0, i + 1 - weightWindowBars), i + 1);

            const weights = computeAmaSlopeWeights(slice, weightVariance, {
                erPeriod: AMA_CONFIG.erPeriod,
                lookbackBars: lbBars,
                maxSlopePct: AMA_WEIGHT_CONFIG.amaMaxSlopePct,
                neutralZonePct: AMA_WEIGHT_CONFIG.neutralZonePct,
                volatilityExponent: AMA_WEIGHT_CONFIG.volatilityExponent,
                volatilityScaleX: AMA_WEIGHT_CONFIG.volatilityScaleX,
                volatilityThreshold: AMA_WEIGHT_CONFIG.volatilityThreshold,
                maxSlopeOffset: AMA_WEIGHT_CONFIG.maxSlopeOffset,
                maxVolatilityOffset: AMA_WEIGHT_CONFIG.maxVolatilityOffset,
                clipThreshold: amaClipThreshold,
            });

            allResults[i].ama3Price = amaValues[i] ?? null;
            allResults[i].atr = atr;
            allResults[i].weightVariance = weightVariance;
            allResults[i].amaSlopePct = weights.slopePct;
            allResults[i].amaWeightReady = weights.isReady;
            allResults[i].amaSlopeOffset = weights.slopeOffset;
            allResults[i].amaSymmetricDelta = weights.symmetricDelta;
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const html = generateHTML({
            allResults,
            amaConfig: AMA_CONFIG,
            amaKey,
            amaWeightConfig: {
                ...AMA_WEIGHT_CONFIG,
                lookbackBars: config.lookbackBars ?? AMA_WEIGHT_CONFIG.lookbackBars,
            },
            alpha: config.alpha,
            gain: config.gain,
            dispWeight: config.dispWeight,
            clipPct: config.clipPct,
            regimeSensitivity: MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY,
            dispScaleMinPct:  config.dispScaleMinPct  ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT,
            minOutputThreshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD,
            outputClamp: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
            marketAdapter: {
                alpha:                   MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA,
                gain:                    MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN,
                dispWeight:              MARKET_ADAPTER.DYNAMIC_WEIGHT_DW,
                clipPercentile:         MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE,
                regimeSensitivity:       MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY,
                minOutputThreshold:      MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD,
                outputClamp:             MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
                amaLookbackBars:        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
                amaMaxSlopePct:         MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
                kalmanMaxSlopePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
                amaNeutralZonePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
                dispScaleMinPct:        MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT,
            },
        }, config.title || 'Dynamic Weight Research Tool');

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(savedLine(CLI_TAGS.dynamicWeight, 'Chart', toFileUrl(config.chartFile)));
    } catch (err: unknown) {
        console.error(`[DynamicWeight] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

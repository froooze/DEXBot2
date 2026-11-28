#!/usr/bin/env node
'use strict';

/**
 * KALMAN TREND ANALYSIS RUNNER
 *
 * Runs KalmanTrendAnalyzer over candle data and generates an interactive HTML chart.
 *
 * Usage:
 *   node dist/analysis/analyze_kalman.js \
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

import { getErrorMessage } from '../modules/utils/errors.js';
import path from 'node:path';
import { KalmanTrendAnalyzer } from './trend_detection/kalman_trend_analyzer.js';
import { generateHTML } from './trend_detection/kalman_chart_generator.js';
import type { KalmanRow } from './trend_detection/kalman_chart_generator.js';
import { calculateAMA } from '../market_adapter/core/strategies/ama.js';
import { computeAmaSlopeWeights, computeAmaSlopeEmaSeries, createAmaSlopeClipTracker } from '../market_adapter/core/strategies/ama_slope_model.js';
import { normalizeAmaSlopeEmaAlpha } from '../market_adapter/core/config_normalizers.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { getCandleClose } from './math_utils.js';
import { writeChartFile, toFileUrl } from './chart_utils.js';
import { CLI_TAGS, savedLine } from '../modules/cli_progress.js';
import { PATHS } from '../modules/paths.js';
import { resolveSource, listAvailableBots, type SourceConfig } from './resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from './analyze_args.js';



function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: SourceConfig };
        rNoise: number | null;
        qTactical: number | null;
        qModal: number | null;
        qNoise: number | null;
        chartFile: string;
        quiet: boolean;
        listBots: boolean;
    } = {
        ...baseAnalysisConfig(),
        // Defaults resolve to the live MARKET_ADAPTER Kalman constants so
        // runs are directly comparable with production (qTactical 0.01,
        // qModal 0.0001 — NOT a single shared Q for both filters).
        rNoise: null,
        qTactical: null,
        qModal: null,
        qNoise: null,
        chartFile: path.join(PATHS.ANALYSIS.CHARTS_DIR, 'kalman_chart.html'),
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if (arg === '--r') config.rNoise = parseFloat(args[++i]);
        else if (arg === '--q') config.qNoise = parseFloat(args[++i]);
        else if (arg === '--q-tactical') config.qTactical = parseFloat(args[++i]);
        else if (arg === '--q-modal') config.qModal = parseFloat(args[++i]);
        else if (arg === '--chart') config.chartFile = args[++i];
    }

    return config;
}

async function main() {
    const config = parseArgs();

    try {
        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source, amaConfig } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        if (!config.quiet) console.log(`[Kalman] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Kalman analysis ──────────────────────────────────────────────────
        // Unset flags fall through to the live KalmanTrendAnalyzer defaults
        // (MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_*_DEFAULT). --q still maps to
        // both filters for quick what-ifs, but per-filter overrides
        // (--q-tactical / --q-modal) exist so runs can mirror production
        // exactly: Q = (0.01 tactical, 0.0001 modal).
        const analyzer = new KalmanTrendAnalyzer({
            rNoise: config.rNoise ?? undefined,
            qTactical: config.qTactical ?? config.qNoise ?? undefined,
            qModal: config.qModal ?? config.qNoise ?? undefined,
        });

        const allResults: KalmanRow[] = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const result = analyzer.update(marketPrice);
            result.timestamp = timestamp;
            allResults.push(result as unknown as KalmanRow);
        }

        // ── AMA weight offset (for comparison panel) ─────────────────────────
        // Runs the production path (canonical Huber -> EMA slope fed into
        // computeAmaSlopeWeights + percentile clip) so this panel is directly
        // comparable to the live amaSlopeOffset. Without the EMA this panel
        // reads raw Huber and drifts from production by the smoothing lag.
        const closes    = candles.map(c => getCandleClose(c) ?? 0);
        const amaValues = calculateAMA(closes, amaConfig);
        const amaLb     = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
        const clipPct   = MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
        // First ready bar: computeAmaSlopeEmaSeries emits from ceil(er)+lb and a
        // rolling slice of that length satisfies computeAmaSlopeWeights' guard
        // (er + lookback + 1 bars). Skipping one bar further would drop the
        // first valid offset from the comparison panel.
        const warmup    = Math.ceil(amaConfig.erPeriod) + amaLb;

        // Incremental, prefix-only clip pool (no look-ahead) — same thresholds
        // the live service would have seen at each point in time.
        const clipTracker = createAmaSlopeClipTracker(amaConfig.erPeriod, amaLb, clipPct);
        const weightWindowBars = Math.ceil(amaConfig.erPeriod) + amaLb + 1;
        // Same normalized alpha and canonical replay the live service uses.
        // The clip pool intentionally stays on raw Huber (no feedback loop).
        const emaAlpha = normalizeAmaSlopeEmaAlpha(MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
        const emaSlopeSeries = computeAmaSlopeEmaSeries(amaValues, amaConfig.erPeriod, amaLb, emaAlpha);

        for (let i = 0; i < allResults.length; i++) {
            const amaClipThreshold = clipTracker.push(amaValues[i] ?? NaN);
            if (i < warmup) { allResults[i].amaWeightOffset = null; continue; }
            const slice = amaValues.slice(Math.max(0, i + 1 - weightWindowBars), i + 1);
            const weights = computeAmaSlopeWeights(slice, 0, {
                erPeriod:              amaConfig.erPeriod,
                lookbackBars:          amaLb,
                maxSlopePct:           MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
                neutralZonePct:        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
                volatilityExponent:    MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
                volatilityScaleX:      MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
                volatilityThreshold:   MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD,
                maxSlopeOffset:        MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
                maxVolatilityOffset:   MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP,
                clipThreshold:         amaClipThreshold,
                // Rolling window: pass the aligned current-bar value, not the
                // full series indexed by the slice's last position.
                currentSlopePct:       emaSlopeSeries[i],
            });
            allResults[i].amaWeightOffset = weights.rawSlopeOffset;
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const html = generateHTML({ allResults, amaConfig, clipPct: MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE }, 'Kalman Trend Analysis');
        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(savedLine(CLI_TAGS.kalman, 'Chart', toFileUrl(config.chartFile)));
    } catch (err: unknown) {
        console.error(`[Kalman] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

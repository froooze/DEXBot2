#!/usr/bin/env node
'use strict';

/**
 * VOLATILITY / SYMMETRIC SHIFT RESEARCH TOOL
 *
 * Computes the symmetric volatility shift used by the market adapter.
 *
 * Signal path:
 *   ATR(period, default 14) -> weightVariance = atr / amaPrice
 *   rawSymmetricDelta = -pow(weightVariance, volatilityExponent) * volatilityScaleX
 *   clampedRawDelta = clamp(rawSymmetricDelta, -DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP, 0)
 *   symmetricDelta = |clampedRawDelta| < volatilityThreshold ? 0 : clampedRawDelta
 *
 * The live adapter adds this penalty to both sides after the trend term is built.
 * This runner intentionally omits the directional trend branch so the volatility
 * effect can be researched in isolation.
 *
 * Usage:
 *   node dist/analysis/analyze_volatility.js \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

import { getErrorMessage } from '../modules/utils/errors.js';
import path from 'node:path';

import { calculateAMA } from '../market_adapter/core/strategies/ama.js';
import { computeATRSeries } from '../market_adapter/core/strategies/atr/calculator.js';
import { normalizeAtrPeriod } from '../market_adapter/core/config_normalizers.js';
import { computeVolatilityShift } from '../market_adapter/core/strategies/volatility_shift.js';
import { generateHTML } from './trend_detection/volatility_chart_generator.js';
import type { VolatilityRow } from './trend_detection/volatility_chart_generator.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { PATHS } from '../modules/paths.js';
import { getCandleClose } from './math_utils.js';
import { writeChartFile, toFileUrl } from './chart_utils.js';
import { CLI_TAGS, savedLine } from '../modules/cli_progress.js';
import { resolveSource, listAvailableBots, type SourceConfig } from './resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from './analyze_args.js';


const DEFAULT_ATR_PERIOD = MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT;
const MIN_WEIGHT = MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
const MAX_WEIGHT = MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
const DEFAULT_THRESHOLD = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD;
const DEFAULT_CLAMP = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP;
const DEFAULT_CHART_DIR = PATHS.ANALYSIS.CHARTS_DIR;
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'volatility_chart.html');

function computeATRSeriesNormalized(candles: unknown, period = DEFAULT_ATR_PERIOD) {
    return computeATRSeries(candles, normalizeAtrPeriod(period));
}

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source:    { type: string; config: SourceConfig };
        chartFile: string;
        threshold: number;
        atrPeriod: number;
        exponent:  number;
        scaleX:    number;
        clamp:     number;
        quiet:     boolean;
        listBots:  boolean;
    } = {
        ...baseAnalysisConfig(),
        chartFile: DEFAULT_CHART_FILE,
        threshold: DEFAULT_THRESHOLD,
        atrPeriod: DEFAULT_ATR_PERIOD,
        exponent: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
        scaleX: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
        clamp: DEFAULT_CLAMP,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--threshold') config.threshold = parseFloat(args[++i]);
        else if (arg === '--atr-period') {
            const next = parseInt(args[++i], 10);
            if (Number.isFinite(next)) config.atrPeriod = normalizeAtrPeriod(next);
        }
        else if (arg === '--exp') config.exponent = parseFloat(args[++i]);
        else if (arg === '--scale-x') config.scaleX = parseFloat(args[++i]);
        else if (arg === '--clamp') config.clamp = parseFloat(args[++i]);
    }

    return config;
}

function computeShift(weightVariance: number, exponent: number, scaleX: number, threshold: number, clampValue: number) {
    const shift = computeVolatilityShift(weightVariance, {
        exponent,
        scaleX,
        threshold,
        clampValue,
        minWeight: MIN_WEIGHT,
        maxWeight: MAX_WEIGHT,
    });
    return {
        rawSymmetricDelta: shift.rawSymmetricDelta,
        symmetricDelta: shift.symmetricDelta,
        effectiveWeight: shift.effectiveWeight,
        sellW: shift.sellW,
        buyW: shift.buyW,
    };
}

async function main() {
    try {
        const config = parseArgs();

        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source, amaConfig } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        if (!config.quiet) console.log(`[Volatility] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const closes = candles.map(c => getCandleClose(c) ?? 0);
        const ama3Values = calculateAMA(closes, amaConfig);
        const atrPeriod = normalizeAtrPeriod(config.atrPeriod);
        const atrs = computeATRSeriesNormalized(candles, atrPeriod);

        const allResults: VolatilityRow[] = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const amaPrice = ama3Values[i] ?? null;
            const atr = atrs[i] ?? 0;
            const weightVariance = amaPrice > 0 ? atr / amaPrice : 0;
            const shift = computeShift(weightVariance, config.exponent, config.scaleX, config.threshold, config.clamp);

            allResults.push({
                timestamp,
                price: marketPrice,
                ama3Price: amaPrice,
                atr,
                weightVariance,
                rawSymmetricDelta: shift.rawSymmetricDelta,
                symmetricDelta: shift.symmetricDelta,
                effectiveWeight: shift.effectiveWeight,
                sellW: shift.sellW,
                buyW: shift.buyW,
            });
        }

        const html = generateHTML({
            allResults,
            candles,
            volatilityThreshold: config.threshold,
            volatilityExponent: config.exponent,
            volatilityScaleX: config.scaleX,
            volatilityClamp: config.clamp,
            atrPeriod,
            minWeight: MIN_WEIGHT,
            maxWeight: MAX_WEIGHT,
            marketAdapter: MARKET_ADAPTER,
        }, 'ATR Volatility Research');

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(savedLine(CLI_TAGS.volatility, 'Chart', toFileUrl(config.chartFile)));
    } catch (err: unknown) {
        console.error(`[Volatility] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

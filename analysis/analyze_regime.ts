#!/usr/bin/env node
'use strict';

/**
 * REGIME ANALYSIS TOOL
 *
 * Computes Hurst Exponent and Permutation Entropy over historical candle data.
 *
 *   Hurst H > 0.55 = trending (persistent)  → trust trend-following signals
 *   Hurst H ≈ 0.50 = random walk            → no edge, stay flat
 *   Hurst H < 0.45 = mean-reverting         → suppress or invert trend signals
 *
 *   Norm. PE < 0.60 = structured            → signals are reliable
 *   Norm. PE > 0.85 = noise                 → no exploitable structure
 *
 * Usage:
 *   node dist/analysis/analyze_regime.js \
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

import { getErrorMessage } from '../modules/utils/errors.js';
import path from 'node:path';
import { MARKET_ADAPTER }              from '../modules/constants.js';
import { PATHS }                       from '../modules/paths.js';
import { HurstAnalyzer }               from './trend_detection/hurst_analyzer.js';
import { PermutationEntropyAnalyzer }  from './trend_detection/permutation_entropy_analyzer.js';
import { generateRegimeHTML }          from './trend_detection/regime_chart_generator.js';
import type { RegimeRow } from './trend_detection/regime_chart_generator.js';
import { calculateAMA }                from '../market_adapter/core/strategies/ama.js';
import { writeChartFile, toFileUrl } from './chart_utils.js';
import { CLI_TAGS, savedLine } from '../modules/cli_progress.js';
import { getCandleClose }              from './math_utils.js';
import { resolveSource, listAvailableBots, type SourceConfig } from './resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from './analyze_args.js';

const HURST_CONFIG = MARKET_ADAPTER.HURST_CONFIG;
const PE_CONFIG = MARKET_ADAPTER.PE_CONFIG;


function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source:      { type: string; config: SourceConfig };
        chartFile:   string;
        hurstWindow: number;
        peWindow:    number;
        peM:         number;
        quiet:       boolean;
        listBots:    boolean;
    } = {
        ...baseAnalysisConfig(),
        chartFile:   path.join(PATHS.ANALYSIS.CHARTS_DIR, 'regime_chart.html'),
        hurstWindow: HURST_CONFIG.window,
        peWindow:    PE_CONFIG.window,
        peM:         PE_CONFIG.m,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if      (arg === '--chart')        config.chartFile                = args[++i];
        else if (arg === '--hurst-window') config.hurstWindow              = parseInt(args[++i], 10);
        else if (arg === '--pe-window')    config.peWindow                 = parseInt(args[++i], 10);
        else if (arg === '--pe-m')         config.peM                      = parseInt(args[++i], 10);
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
        if (!config.quiet) console.log(`[Regime] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Regime analyzers ─────────────────────────────────────────────────
        const hurstAnalyzer = new HurstAnalyzer({
            window: config.hurstWindow,
            scales: HURST_CONFIG.scales,
        });
        const peAnalyzer = new PermutationEntropyAnalyzer({
            m:      config.peM,
            delay:  PE_CONFIG.delay,
            window: config.peWindow,
        });

        const allResults: RegimeRow[] = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const hurst = hurstAnalyzer.update(marketPrice);
            const pe    = peAnalyzer.update(marketPrice);

            allResults.push({
                timestamp,
                price:               marketPrice,
                hurst:               hurst.hurst,
                hurstRegime:         hurst.regime,
                hurstRegimeStrength: hurst.regimeStrength,
                hurstReady:          hurst.isReady,
                normalizedEntropy:   pe.normalizedEntropy,
                entropy:             pe.entropy,
                peRegime:            pe.regime,
                peRegimeStrength:    pe.regimeStrength,
                peReady:             pe.isReady,
            });
        }

        // ── AMA3 overlay for price panel ─────────────────────────────────────
        const closes    = candles.map(c => getCandleClose(c) ?? 0);
        const ama3Values = calculateAMA(closes, amaConfig);
        for (let i = 0; i < allResults.length; i++) {
            allResults[i].ama3Price = ama3Values[i] ?? null;
        }

        // ── Print tail summary ───────────────────────────────────────────────
        if (!config.quiet) {
            const last = allResults[allResults.length - 1];
            console.log(`[Regime] ${candles.length} bars processed`);
            console.log(`[Regime] Last bar:`);
            console.log(`         Hurst H=${last.hurst}  regime=${last.hurstRegime}`);
            console.log(`         PE    e=${last.normalizedEntropy}  regime=${last.peRegime}`);
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const html = generateRegimeHTML({
            allResults,
            hurstConfig: { window: config.hurstWindow, scales: HURST_CONFIG.scales },
            peConfig:    { m: config.peM, window: config.peWindow },
        }, 'Regime Analysis \u2014 Hurst \u00b7 Permutation Entropy');

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(savedLine(CLI_TAGS.regime, 'Chart', toFileUrl(config.chartFile)));

    } catch (err: unknown) {
        console.error(`[Regime] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

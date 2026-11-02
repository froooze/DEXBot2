#!/usr/bin/env node
'use strict';

/**
 * DERIVATIVE TREND ANALYSIS
 *
 * Runs DerivativeAnalyzer over candle data and generates an interactive HTML chart.
 * Trend is detected from SMA, MACD, and RSI only.
 *
 * Usage:
 *   node dist/analysis/legacy/analyze_derivatives.js \\
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 *
 *   node dist/analysis/legacy/analyze_derivatives.js \\
 *     --source market_adapter \
 *     --bot-key <bot>
 *
 * Output:
 *   analysis/charts/derivative_chart.html
 */


import { getErrorMessage } from '../../modules/utils/errors.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DerivativeAnalyzer } from './derivative_analyzer.js';
import { generateHTML } from './derivative_chart_generator.js';
import type { DerivativeAnalyzer as DerivativeAnalyzerType } from './derivative_analyzer.js';

type DerivativeRow = ReturnType<DerivativeAnalyzerType['update']>;
import { writeChartFile, toFileUrl } from '../chart_utils.js';
import { CLI_TAGS, savedLine } from '../../modules/cli_progress.js';
import { PATHS } from '../../modules/paths.js';
import { resolveSource, listAvailableBots, type SourceConfig } from '../resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from '../analyze_args.js';


interface CliConfig {
    source: { type: string; config: SourceConfig };
    slowSmaPeriod: number;
    fastSmaPeriod: number | undefined;
    minBarsForConfirmation: number;
    macdFastPeriod: number;
    macdSlowPeriod: number;
    macdSignalPeriod: number;
    macdMinHist: number;
    trendFilter: boolean;
    trendFilterMinBars: number;
    momentumGateEnabled: boolean;
    momentumGateMinBars: number;
    momentumGateRsiZone: number;
    fastSmaCommitmentBars: number;
    priceRegimeGate: boolean;
    priceRegimeMinDistancePct: number;
    rsiPeriod: number;
    interpConfirmBars: number;
    interpHoldBars: number;
    rsiZone: number;
    rsiExtreme: number;
    chartFile: string;
    quiet: boolean;
    listBots: boolean;
}

interface PriceSource {
    name: string;
    fetchCandles(): Promise<unknown[]>;
    extractMarketPrice(candle: unknown): { marketPrice: number; timestamp: number };
}

function parseArgs(): CliConfig {
    const args = process.argv.slice(2);
    const config: CliConfig = {
        ...baseAnalysisConfig(),
        slowSmaPeriod:        500,
        fastSmaPeriod:        undefined,
        minBarsForConfirmation: 3,
        macdFastPeriod: 12,
        macdSlowPeriod: 26,
        macdSignalPeriod: 9,
        macdMinHist: 0.02,
        trendFilter: false,
        trendFilterMinBars: 3,
        momentumGateEnabled: false,
        momentumGateMinBars: 3,
        momentumGateRsiZone: 35,
        fastSmaCommitmentBars: 2,
        priceRegimeGate: true,
        priceRegimeMinDistancePct: 0.35,
        rsiPeriod: 14,
        interpConfirmBars: 3,
        interpHoldBars: 3,
        rsiZone: 10,
        rsiExtreme: 90,
        chartFile: path.join(PATHS.ANALYSIS.CHARTS_DIR, 'derivative_chart.html'),
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if      (arg === '--sma')       config.slowSmaPeriod                = parseInt(args[++i]);
        else if (arg === '--fast-sma')  config.fastSmaPeriod                = parseInt(args[++i]);
        else if (arg === '--confirm')   config.minBarsForConfirmation       = parseInt(args[++i]);
        else if (arg === '--macd-fast')  { config.macdFastPeriod            = parseInt(args[++i]); }
        else if (arg === '--macd-slow')  { config.macdSlowPeriod            = parseInt(args[++i]); }
        else if (arg === '--macd-signal'){ config.macdSignalPeriod          = parseInt(args[++i]); }
        else if (arg === '--macd-min-hist') { config.macdMinHist            = parseFloat(args[++i]); }
        else if (arg === '--rsi')          { const v = parseInt(args[i + 1]); if (!isNaN(v)) { config.rsiPeriod = v; i++; } }
        else if (arg === '--interp-confirm') config.interpConfirmBars        = parseInt(args[++i]);
        else if (arg === '--interp-hold')    config.interpHoldBars           = parseInt(args[++i]);
        else if (arg === '--rsi-zone')       config.rsiZone                  = parseFloat(args[++i]);
        else if (arg === '--rsi-extreme')    config.rsiExtreme               = parseFloat(args[++i]);
        else if (arg === '--trend-filter')          config.trendFilter          = true;
        else if (arg === '--trend-filter-min-bars') config.trendFilterMinBars  = parseInt(args[++i]);
        else if (arg === '--momentum-gate')         config.momentumGateEnabled  = true;
        else if (arg === '--momentum-gate-bars')    config.momentumGateMinBars  = parseInt(args[++i]);
        else if (arg === '--momentum-gate-rsi-zone') config.momentumGateRsiZone = parseFloat(args[++i]);
        else if (arg === '--fast-sma-commitment-bars') config.fastSmaCommitmentBars = parseInt(args[++i]);
        else if (arg === '--no-price-regime-gate')  config.priceRegimeGate      = false;
        else if (arg === '--price-regime-buffer-pct') config.priceRegimeMinDistancePct = parseFloat(args[++i]);
        else if (arg === '--chart')       config.chartFile                  = args[++i];
        else if (arg === '--help' || arg === '-h') { showHelp(); process.exit(0); }
    }

    return config;
}

function showHelp() {
    console.log(`
Derivative Trend Analysis

Analyzes candle data using SMA, MACD, and RSI as trend signals.
Generates an interactive HTML chart.

Usage:
  node dist/analysis/legacy/analyze_derivatives.js \\
    --source <type> \\
    [--bot-key KEY] [--file PATH]

Sources:
  market_adapter   Use market_adapter state (default)   --bot-key KEY
  json             JSON candles file                    --file path/to/file.json

Analyzer options:
  Core indicators:
    --sma N        SMA period (default 500)
    --fast-sma N   Fast SMA period (optional, enables trend filter source + fast-SMA commitment)
    --macd-fast N  MACD fast period (default 12)
    --macd-slow N  MACD slow period (default 26)
    --macd-signal N  MACD signal period (default 9)
    --macd-min-hist N  MACD histogram/line threshold (default 0.02)
    --rsi [N]      RSI period (default 14)
    --rsi-zone N   RSI bull/bear zone offset from 50 (default 10)
    --rsi-extreme N  RSI extreme threshold (default 90)

  Confirmation and hysteresis:
    --confirm N    Bars required for confirmation (default 3)
    --interp-confirm N  Bars required to confirm BULL/BEAR (default 3)
    --interp-hold N  Bars to hold confirmed BULL/BEAR downgrades (default 3)

  Trend filters and gates:
    --trend-filter  Enable derivative trend filter
    --trend-filter-min-bars N  Sustained bars for trend filter (default 3)
    --momentum-gate  Enable MACD+RSI recovery gate
    --momentum-gate-bars N  Momentum gate persistence (default 3)
    --momentum-gate-rsi-zone N  RSI divergence threshold (default 35)
    --fast-sma-commitment-bars N  Consecutive bars price must stay beyond fastSMA (default 2)
    --no-price-regime-gate  Disable slow-SMA macro regime gate
    --price-regime-buffer-pct N  Required slow-SMA clearance in % (default 0.35)

  Source input:
    --source <type>  Data source (default market_adapter)
    --bot-key KEY    Market adapter bot key (required)
    --file PATH      JSON candle input

  Output:
    --chart FILE   Chart output path (default: <analysis charts dir>/derivative_chart.html)
    --list-bots    List available bot keys from bots.json
    --quiet        Suppress log output
    `);
}

async function analyze(source: PriceSource, config: CliConfig): Promise<{
    config: {
        source: string;
        slowSmaPeriod: number;
        fastSmaPeriod: number | undefined;
        macdFastPeriod: number;
        macdSlowPeriod: number;
        macdSignalPeriod: number;
        macdMinHist: number;
        trendFilter: boolean;
        trendFilterMinBars: number;
        momentumGateEnabled: boolean;
        momentumGateMinBars: number;
        momentumGateRsiZone: number;
        fastSmaCommitmentBars: number;
        priceRegimeGate: boolean;
        priceRegimeMinDistancePct: number;
        rsiPeriod: number;
        interpConfirmBars: number;
        interpHoldBars: number;
        rsiZone: number;
        rsiExtreme: number;
        minBarsForConfirmation: number;
    };
    allResults: DerivativeRow[];
    lastAnalysis: DerivativeRow | null;
}> {
    if (!config.quiet) console.log(`[Derivatives] Loading candles from ${source.name}...`);

    const candles = await source.fetchCandles();
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('No candles returned from source');
    }
    if (!config.quiet) console.log(`[Derivatives] Loaded ${candles.length} candles`);

    const analyzer = new DerivativeAnalyzer({
        slowSmaPeriod:          config.slowSmaPeriod,
        fastSmaPeriod:          config.fastSmaPeriod,
        macdFastPeriod:         config.macdFastPeriod,
        macdSlowPeriod:         config.macdSlowPeriod,
        macdSignalPeriod:       config.macdSignalPeriod,
        macdMinHist:            config.macdMinHist,
        trendFilterEnabled:     config.trendFilter,
        trendFilterMinBars:     config.trendFilterMinBars,
        momentumGateEnabled:    config.momentumGateEnabled,
        momentumGateMinBars:    config.momentumGateMinBars,
        momentumGateRsiZone:    config.momentumGateRsiZone,
        fastSmaCommitmentBars:  config.fastSmaCommitmentBars,
        priceRegimeGateEnabled: config.priceRegimeGate,
        priceRegimeMinDistancePct: config.priceRegimeMinDistancePct,
        rsiPeriod:              config.rsiPeriod,
        interpConfirmBars:      config.interpConfirmBars,
        interpHoldBars:         config.interpHoldBars,
        rsiBullThreshold:       50 + config.rsiZone,
        rsiBearThreshold:       50 - config.rsiZone,
        rsiOverboughtLevel:     config.rsiExtreme,
        rsiOversoldLevel:       100 - config.rsiExtreme,
        minBarsForConfirmation: config.minBarsForConfirmation,
    });

    const allResults: DerivativeRow[] = [];
    for (let i = 0; i < candles.length; i++) {
        const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
        try {
            allResults.push(analyzer.update(marketPrice, timestamp));
        } catch (err: unknown) {
            throw new Error(`Failed at candle ${i}: ${getErrorMessage(err)}`);
        }
    }

    const last = allResults[allResults.length - 1]!;
    if (!config.quiet) {
        const parts: string[] = [];
        if (config.slowSmaPeriod)    parts.push(`SMA(${config.slowSmaPeriod}): ${last.smaRawTrend} (${last.smaBarsInTrend} bars)`);
        if (config.fastSmaPeriod)    parts.push(`fastSMA(${config.fastSmaPeriod}): ${last.fastSmaRawTrend} (${last.fastSmaBarsInTrend} bars)`);
        parts.push(`MACD: ${last.macdTrend} hist=${last.macdHistogram}`);
        parts.push(`RSI(${config.rsiPeriod}): ${last.rsi != null ? last.rsi.toFixed(1) : 'n/a'} [${last.rsiZone}]`);
        console.log(`[Derivatives] Done — ${last.isReady ? '' : '(warming up) '}${parts.join('  ')}`);
    }

    return {
        config: {
            source:              source.name,
            slowSmaPeriod:       config.slowSmaPeriod,
            fastSmaPeriod:       config.fastSmaPeriod,
            macdFastPeriod:      config.macdFastPeriod,
            macdSlowPeriod:      config.macdSlowPeriod,
            macdSignalPeriod:    config.macdSignalPeriod,
            macdMinHist:         config.macdMinHist,
            trendFilter:         config.trendFilter,
            trendFilterMinBars:  config.trendFilterMinBars,
            momentumGateEnabled: config.momentumGateEnabled,
            momentumGateMinBars: config.momentumGateMinBars,
            momentumGateRsiZone: config.momentumGateRsiZone,
            fastSmaCommitmentBars: config.fastSmaCommitmentBars,
            priceRegimeGate:     config.priceRegimeGate,
            priceRegimeMinDistancePct: config.priceRegimeMinDistancePct,
            rsiPeriod:           config.rsiPeriod,
            interpConfirmBars:   config.interpConfirmBars,
            interpHoldBars:      config.interpHoldBars,
            rsiZone:             config.rsiZone,
            rsiExtreme:          config.rsiExtreme,
            minBarsForConfirmation: config.minBarsForConfirmation,
        },
        allResults,
        lastAnalysis: last,
    };
}

async function main(): Promise<void> {
    const config = parseArgs();

    try {
        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        const report = await analyze(source, config);

        const html = generateHTML(report as unknown as Parameters<typeof generateHTML>[0], 'Derivative Trend Analysis');
        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(savedLine(CLI_TAGS.derivatives, 'Chart', toFileUrl(config.chartFile)));
    } catch (err: unknown) {
        console.error(`[Derivatives] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err: unknown) => { console.error(err); process.exit(1); });
}

export { analyze }


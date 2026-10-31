'use strict';

import { path } from '../modules/path_api.js';
import { getStorage } from '../modules/storage/index.js';
import { exec } from 'node:child_process';
import { getErrorMessage } from '../modules/utils/errors.js';
import { calculateAMA } from './core/strategies/ama.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { generateHTML } from './lp_chart_core.js';
import { loadStrategiesForLpChart } from './lp_chart_strategy_loader.js';
import { findLatestLpData, loadLatestLpSeries, loadLpSeriesFromPath } from './utils/data_discovery.js';
import { PATHS } from '../modules/paths.js';

/**
 * LP CHART RUNNER — Shared LP chart orchestration
 *
 * Owns the reusable chart workflow used by:
 * - scripts/generate_lp_chart.ts
 * - package.json `lp:chart`
 *
 * Responsibilities:
 * - resolve the input LP data file
 * - load candles and metadata
 * - resolve AMA strategies from optimizer results and/or market profiles
 * - calculate AMA series and comparison metrics
 * - choose output paths
 * - render and write HTML via `lp_chart_core`
 *
 * Non-responsibilities:
 * - rendering HTML internals (`lp_chart_core.ts`)
 * - synthetic comparison mode (kept in analysis/ama_fitting)
 * - fetch/export of LP data (`market_adapter/inputs/fetch_lp_data.ts`)
 */

const storage = getStorage();
const { ensureDir } = storage;


const ANALYSIS_CHARTS_DIR = PATHS.ANALYSIS.CHARTS_DIR;
const AMA_PROFILES_FILE = PATHS.PROFILES.MARKET_PROFILES_JSON;
const DEFAULT_COMPARISON_COLORS = ['#26a69a', '#fb8c00', '#5c9ee6', '#ef5350'];
const DEFAULT_COMPARISON_DASHES = ['dot', 'solid', 'dash', 'dashdot'];
const DEFAULT_COMPARISON_STRATEGIES = Object.keys(MARKET_ADAPTER.AMAS).map((key: string, index: number) => {
    const ama = (MARKET_ADAPTER.AMAS as Record<string, AmaConfig>)[key];
    return {
        name: ama.name || key,
        erPeriod: ama.erPeriod,
        fastPeriod: ama.fastPeriod,
        slowPeriod: ama.slowPeriod,
        color: DEFAULT_COMPARISON_COLORS[index % DEFAULT_COMPARISON_COLORS.length],
        dash: DEFAULT_COMPARISON_DASHES[index % DEFAULT_COMPARISON_DASHES.length],
    };
});

/* ── Type declarations ───────────────────────────────────── */

type NormalizedLpCandle = [number, number, number, number, number, number];

interface LpCandleObject {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface LpMeta {
    pool?: string;
    assetA?: { symbol?: string };
    assetB?: { symbol?: string };
    intervalSeconds?: number;
    [key: string]: unknown;
}

interface AmaConfig {
    name: string;
    erPeriod: number;
    fastPeriod: number;
    slowPeriod: number;
    color?: string;
    dash?: string;
    lineWidth?: number;
}

interface AmaResult extends AmaConfig {
    values: number[];
}

interface LpDataBundle {
    dataFile: string;
    meta: LpMeta | null;
    candleArrays: NormalizedLpCandle[];
    candleObjects: LpCandleObject[];
}

interface CliArgOptions {
    dataFlags?: string[];
    allowPositional?: boolean;
    includeNoOpen?: boolean;
}

interface MarketChartOptions {
    dataFile?: string;
    dataBundle?: LpDataBundle;
    logger?: { log: (...args: unknown[]) => void };
    profilesFile?: string;
    outFile?: string;
    noOpen?: boolean;
}

interface ComparisonChartOptions {
    dataFile?: string;
    dataBundle?: LpDataBundle;
    logger?: { log: (...args: unknown[]) => void };
    defaultStrategies?: AmaConfig[];
    profilesFile?: string | null;
    outFile?: string;
    noOpen?: boolean;
}

interface BundleChartOptions {
    dataFile?: string;
    dataBundle?: LpDataBundle;
    logger?: { log: (...args: unknown[]) => void };
    profilesFile?: string;
    defaultStrategies?: AmaConfig[];
    comparisonProfilesFile?: string | null;
    openComparison?: boolean;
    noOpen?: boolean;
}

interface ChartHtmlParams {
    meta: LpMeta | null;
    candleArrays: NormalizedLpCandle[];
    amaResults: AmaResult[];
    outFile: string;
}

interface MetricsResult {
    maxDriftUp: number;
    maxDriftDown: number;
    cumDevAbove: number;
    cumDevBelow: number;
    totalDeviation: number;
    maxDistance: number;
}

function parseLpChartCliArgs(argv: string[], options: CliArgOptions = {}): { dataFile: string | null; noOpen: boolean } {
    const args = Array.isArray(argv) ? argv : [];
    const dataFlags = new Set(options.dataFlags ?? ['--data', '--file']);
    const allowPositional = options.allowPositional !== false;
    const includeNoOpen = options.includeNoOpen !== false;
    let dataFile: string | null = null;
    let noOpen = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (dataFlags.has(arg) && args[i + 1]) {
            dataFile = path.resolve(args[i + 1]);
            i++;
            continue;
        }
        if (includeNoOpen && arg === '--no-open') {
            noOpen = true;
            continue;
        }
        if (allowPositional && !arg.startsWith('--') && !dataFile) {
            dataFile = path.resolve(arg);
        }
    }

    return { dataFile, noOpen };
}

function normalizeLpCandle(candle: unknown, index: number): NormalizedLpCandle {
    if (Array.isArray(candle)) {
        if (candle.length < 5) {
            throw new Error(`Invalid candle row at index ${index}: expected at least 5 entries`);
        }
        return [
            candle[0] as number,
            candle[1] as number,
            candle[2] as number,
            candle[3] as number,
            candle[4] as number,
            (candle[5] ?? 0) as number,
        ];
    }

    if (candle && typeof candle === 'object') {
        const rec = candle as Record<string, unknown>;
        const timestamp = rec.timestamp as number;
        const open = rec.open as number;
        const high = rec.high as number;
        const low = rec.low as number;
        const close = rec.close as number;
        const volume = (rec.volume ?? 0) as number;
        if ([timestamp, open, high, low, close].some((value) => value == null)) {
            throw new Error(`Invalid candle object at index ${index}: missing OHLC fields`);
        }
        return [timestamp, open, high, low, close, volume];
    }

    throw new Error(`Invalid candle row at index ${index}: unsupported format`);
}

function resolveLpDataFile(dataFile?: string): string {
    // Explicit path wins. Otherwise resolve through the assembling loader so a
    // shard-only cache yields a representative source path instead of null.
    const resolved: string | null = dataFile
        ? path.resolve(dataFile)
        : (loadLatestLpSeries()?.path ?? findLatestLpData());
    if (!resolved) {
        throw new Error('No LP data file found. Use --data <path> or run the fetch step first.');
    }
    if (!storage.exists(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    return resolved;
}

function bundleFrom(dataFile: string, meta: LpMeta | null, candles: unknown[]): LpDataBundle {
    return {
        dataFile,
        meta,
        candleArrays: candles.map((c, index) => normalizeLpCandle(c, index)),
        candleObjects: candles.map((c, index) => {
            const normalized = normalizeLpCandle(c, index);
            return {
                timestamp: normalized[0],
                open: normalized[1],
                high: normalized[2],
                low: normalized[3],
                close: normalized[4],
                volume: normalized[5] ?? 0,
            };
        }),
    };
}

function loadLpDataFile(dataFile?: string): LpDataBundle {
    // Explicit path: read the file as before. Auto-discovery: assemble the
    // complete series (merging month shards when they are the newest source),
    // so a shard-only cache charts the whole history, not one month.
    if (!dataFile) {
        const series = loadLatestLpSeries();
        if (!series || series.candles.length === 0) {
            throw new Error('No LP data found. Use --data <path> or run the fetch step first.');
        }
        return bundleFrom(series.path, series.meta as LpMeta | null, series.candles);
    }

    const resolved = resolveLpDataFile(dataFile);
    const series = loadLpSeriesFromPath(resolved);
    if (!series || series.candles.length === 0) {
        throw new Error('No candles in data file.');
    }
    return bundleFrom(series.path, series.meta as LpMeta | null, series.candles);
}

function openInBrowser(filePath: string): void {
    const url = `file://${filePath}`;
    const cmd = process.platform === 'darwin'
        ? `open "${url}"`
        : process.platform === 'win32'
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
    exec(cmd, (err: Error | null) => {
        if (err) console.warn(`  Could not auto-open browser: ${getErrorMessage(err)}`);
    });
}

function defaultMarketChartPath(meta: LpMeta | null): string {
    const suffix = meta?.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${meta?.assetA?.symbol || '?'}_${meta?.assetB?.symbol || '?'}`;
    return path.join(ANALYSIS_CHARTS_DIR, `lp_AMA_chart_${suffix}.html`).replace(/\./g, '_').replace('_html', '.html');
}

function defaultComparisonChartPath(meta: LpMeta | null, dataFile?: string): string {
    if (meta?.pool) {
        const suffix = String(meta.pool).replace('1.19.', '');
        return path.join(ANALYSIS_CHARTS_DIR, `lp_chart_pool_${suffix}.comparison.html`);
    }

    const fromMetaA = String(meta?.assetA?.symbol || '').trim();
    const fromMetaB = String(meta?.assetB?.symbol || '').trim();
    if (fromMetaA && fromMetaB) {
        return path.join(ANALYSIS_CHARTS_DIR, `lp_chart_${fromMetaA}_${fromMetaB}.comparison.html`)
            .replace(/\./g, '_')
            .replace('_html', '.html');
    }

    return path.join(ANALYSIS_CHARTS_DIR, `lp_chart_${path.basename(dataFile || 'comparison', '.json')}.comparison.html`)
        .replace(/\./g, '_')
        .replace('_html', '.html');
}

function calculateMetrics(amaValues: number[], candles: LpCandleObject[]): MetricsResult {
    let maxDriftUp = 0;
    let maxDriftDown = 0;
    let cumDevAbove = 0;
    let cumDevBelow = 0;
    const skip = Math.max(20, Math.floor(candles.length * 0.1));

    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const driftUp = (candles[i].high - ama) / ama;
        const driftDown = (ama - candles[i].low) / ama;
        if (driftUp > maxDriftUp) maxDriftUp = driftUp;
        if (driftDown > maxDriftDown) maxDriftDown = driftDown;
        if (candles[i].high > ama) cumDevAbove += driftUp;
        if (candles[i].low < ama) cumDevBelow += driftDown;
    }

    return {
        maxDriftUp,
        maxDriftDown,
        cumDevAbove,
        cumDevBelow,
        totalDeviation: cumDevAbove + cumDevBelow,
        maxDistance: Math.max(maxDriftUp, maxDriftDown),
    };
}

function writeChartHtml({ meta, candleArrays, amaResults, outFile }: ChartHtmlParams): void {
    const html = generateHTML(meta, candleArrays, amaResults);
    ensureDir(path.dirname(outFile));
    storage.writeFile(outFile, html);
}

function generateMarketLpChart(options: MarketChartOptions = {}): { dataFile: string; outFile: string; amaResults: AmaResult[]; meta: LpMeta | null; candleArrays: NormalizedLpCandle[] } {
    const logger = options.logger ?? console;
    const { dataFile, meta, candleArrays } = options.dataBundle ?? loadLpDataFile(options.dataFile);

    logger.log(`Reading: ${path.relative(process.cwd(), dataFile)}`);
    const poolLabel = meta?.pool ? `pool ${meta.pool}` : `${meta?.assetA?.symbol || '?'}\/${meta?.assetB?.symbol || '?'}`;
    logger.log(`  ${candleArrays.length} candles · ${poolLabel}`);

    const closes: number[] = candleArrays.map((c) => c[4]);
    const amaConfigs: AmaConfig[] | null = loadStrategiesForLpChart({
        dataFile,
        meta,
        profilesFile: options.profilesFile ?? AMA_PROFILES_FILE,
    }) as AmaConfig[] | null;
    if (!amaConfigs) {
        const pair = `${meta?.assetA?.symbol || '?'} / ${meta?.assetB?.symbol || '?'}`;
        throw new Error(`AMA profile not found for pair ${pair}`);
    }

    const amaResults: AmaResult[] = amaConfigs.map((cfg: AmaConfig) => ({
        ...cfg,
        values: calculateAMA(closes, cfg),
    }));

    const lastClose = closes[closes.length - 1];
    for (const ama of amaResults) {
        const lastAma = ama.values[ama.values.length - 1];
        const deviation = ((lastClose - lastAma) / lastAma) * 100;
        logger.log(`  ${ama.name.padEnd(24)} AMA: ${lastAma.toFixed(6)}  dev: ${deviation >= 0 ? '+' : ''}${deviation.toFixed(3)}%`);
    }

    const outFile = options.outFile ? path.resolve(options.outFile) : defaultMarketChartPath(meta);
    writeChartHtml({ meta, candleArrays, amaResults, outFile });

    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    if (!options.noOpen) {
        logger.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        logger.log(`Open manually: file://${outFile}`);
    }

    return { dataFile, outFile, amaResults, meta, candleArrays };
}

function generateComparisonLpChart(options: ComparisonChartOptions = {}): { dataFile: string; outFile: string; amaResults: AmaResult[]; meta: LpMeta | null; candleArrays: NormalizedLpCandle[] } {
    const logger = options.logger ?? console;
    const { dataFile, meta, candleArrays, candleObjects } = options.dataBundle ?? loadLpDataFile(options.dataFile);
    const defaultStrategies: AmaConfig[] = options.defaultStrategies ?? DEFAULT_COMPARISON_STRATEGIES;
    const strategies: AmaConfig[] = (loadStrategiesForLpChart({
        dataFile,
        meta,
        profilesFile: options.profilesFile ?? null,
    }) as AmaConfig[] | null) ?? defaultStrategies;

    logger.log(`Data:        ${path.basename(dataFile)}  (${candleObjects.length} candles)`);
    if (strategies.length && strategies !== defaultStrategies) {
        logger.log('Strategies:  loaded from shared strategy loader');
        strategies.forEach((s: AmaConfig) => logger.log(`  ${s.name.padEnd(28)} ER=${s.erPeriod}  Fast=${s.fastPeriod}  Slow=${s.slowPeriod}`));
    } else {
        logger.log('Strategies:  results file not found — using defaults');
    }

    const closes: number[] = candleObjects.map((c: LpCandleObject) => c.close);
    const amaResults: AmaResult[] = [];
    logger.log('');
    for (const [index, strategy] of strategies.entries()) {
        const values: number[] = calculateAMA(closes, strategy);
        const metrics: MetricsResult = calculateMetrics(values, candleObjects);
        amaResults.push({ ...strategy, lineWidth: index === 0 ? 2 : 1.5, values });

        logger.log(`${strategy.name}`);
        logger.log(`   ├─ Total Deviation: ${metrics.totalDeviation.toFixed(2)}%`);
        logger.log(`   ├─ Max UP:         ${(metrics.maxDriftUp * 100).toFixed(2)}%`);
        logger.log(`   ├─ Max DOWN:       ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        logger.log(`   └─ Band Factor:    ${(metrics.maxDistance * 200).toFixed(2)}%\n`);
    }

    const outFile = options.outFile ? path.resolve(options.outFile) : defaultComparisonChartPath(meta, dataFile);
    logger.log(`Generating chart (${amaResults.length} AMAs)...`);
    writeChartHtml({ meta, candleArrays, amaResults, outFile });
    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    if (!options.noOpen) {
        logger.log('Opening in browser...');
        openInBrowser(outFile);
    } else {
        logger.log(`Open:        file://${outFile}`);
    }

    return { dataFile, outFile, amaResults, meta, candleArrays };
}

function generateLpChartBundle(options: BundleChartOptions = {}): { dataFile: string; marketChart: ReturnType<typeof generateMarketLpChart>; comparisonChart: ReturnType<typeof generateComparisonLpChart> } {
    const logger = options.logger ?? console;
    // Resolve/assemble ONCE, then hand the same loaded bundle to both charts —
    // auto-discovery over shards would otherwise re-read and re-merge the whole
    // family for each sub-chart.
    const bundle = options.dataBundle ?? loadLpDataFile(options.dataFile);
    logger.log(`Generating LP charts from ${path.relative(process.cwd(), bundle.dataFile)}`);

    const marketChart = generateMarketLpChart({
        dataBundle: bundle,
        noOpen: options.noOpen,
        logger,
        profilesFile: options.profilesFile,
    });
    const comparisonChart = generateComparisonLpChart({
        dataBundle: bundle,
        noOpen: options.openComparison === true ? !!options.noOpen : true,
        logger,
        defaultStrategies: options.defaultStrategies ?? DEFAULT_COMPARISON_STRATEGIES,
        profilesFile: options.comparisonProfilesFile ?? null,
    });

    return {
        dataFile: bundle.dataFile,
        marketChart,
        comparisonChart,
    };
}

export { calculateMetrics, defaultMarketChartPath, findLatestLpData, generateComparisonLpChart, generateLpChartBundle, generateMarketLpChart, loadLpDataFile, parseLpChartCliArgs }

/** Internal seams exercised directly by tests. */
export const __test = { DEFAULT_COMPARISON_STRATEGIES };


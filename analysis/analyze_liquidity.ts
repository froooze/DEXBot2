#!/usr/bin/env node
'use strict';

/**
 * LIQUIDITY DEPTH CHART
 *
 * Blends one asset pair's live limit-order book with its constant-product AMM
 * pool into a single cumulative-depth chart (PoolTool-style), rendered with the
 * vendored uPlot runtime. Read-only: the tool opens an ephemeral chain
 * connection and never touches a running bot's client state.
 *
 * Usage:
 *   node dist/analysis/analyze_liquidity.js --pair TOKENA/TOKENB
 *   node dist/analysis/analyze_liquidity.js --base TOKENA --quote TOKENB
 *   node dist/analysis/analyze_liquidity.js --pool 1.19.133
 *   node dist/analysis/analyze_liquidity.js --pool <pool-token-symbol>
 *   node dist/analysis/analyze_liquidity.js --pair TOKENA/TOKENB --range 0.25
 *   npm run analysis:liquidity -- --pair TOKENA/TOKENB --depth 200
 *
 * Output: analysis/charts/liquidity_<base>_<quote>.html (overridable via --chart)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PATHS } from '../modules/paths.js';
import { getErrorMessage } from '../modules/utils/errors.js';
import { formatCurrency, formatFundsValue } from '../modules/order/format.js';
import { muteChainLogs } from '../modules/utils/chain_logs.js';
import { withReadOnlyClient } from './chain_pool.js';
import {
    computeBookStats,
    computePoolPrice,
    resolvePriceWindow,
    buildDepthSeries,
    DEFAULT_STEPS,
} from './liquidity/liquidity_depth_model.js';
import type { BookOrder, BookSides, PoolState } from './liquidity/liquidity_depth_model.js';
import { resolveAsset, fetchOrderBook, fetchPools, resolvePool, selectPool } from './liquidity/liquidity_chain.js';
import type { ChainAsset, RawPool } from './liquidity/liquidity_chain.js';
import { poolAssetIds } from '../modules/liquidity_pool_ref.js';
import { generateLiquidityHTML } from './liquidity/liquidity_chart_generator.js';
import { writeChartFile, toFileUrl } from './chart_utils.js';

const DEFAULT_DEPTH = 300;
const DEFAULT_RANGE = 0.5;

interface LiquidityConfig {
    base: string;
    quote: string;
    poolId: string | null;
    depth: number;
    range: number;
    steps: number;
    chartFile: string | null;
    jsonFile: string | null;
    quiet: boolean;
    help: boolean;
}

function usage(): string {
    return [
        'Liquidity depth chart (order book + AMM pool, uPlot)',
        '',
        'Usage: node dist/analysis/analyze_liquidity.js [options]',
        '',
        'Options:',
        '  --base <symbol|id>    base asset (required unless --pair or --pool is used)',
        '  --quote <symbol|id>   quote asset (required unless --pair or --pool is used)',
        '  --pair <base>/<quote> shorthand for --base + --quote',
        '  --pool <ref>          one pool: id (133 / 1.19.133) or its pool token symbol;',
        '                        both legs are derived from it when --base/--quote are omitted',
        `  --depth <n>           order-book levels per side (default ${DEFAULT_DEPTH}; get_limit_orders cap is commonly 300)`,
        `  --range <f>           price window half-width as a fraction (default ${DEFAULT_RANGE} => +-50%)`,
        `  --steps <n>           price samples across the window (default ${DEFAULT_STEPS})`,
        '  --chart <path>        HTML output path',
        '  --json <path>         optional JSON dump of the sampled depth series',
        '  --quiet               suppress the console summary',
        '  --help                show this help',
        '',
        'Conventions: price is quote per base (e.g. QUOTE per BASE); depth is',
        'cumulative quote liquidity (QUOTE) at or better than that price.',
    ].join('\n');
}

function parsePositiveNumber(raw: string | undefined, flag: string): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} expects a positive number`);
    return value;
}

function parseArgs(argv: string[]): LiquidityConfig {
    const config: LiquidityConfig = {
        base: '',
        quote: '',
        poolId: null,
        depth: DEFAULT_DEPTH,
        range: DEFAULT_RANGE,
        steps: DEFAULT_STEPS,
        chartFile: null,
        jsonFile: null,
        quiet: false,
        help: false,
    };
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') config.help = true;
        else if (arg === '--quiet') config.quiet = true;
        else if (arg === '--base') config.base = argv[++i];
        else if (arg === '--quote') config.quote = argv[++i];
        else if (arg === '--pair') {
            const [base, quote] = String(argv[++i] ?? '').split(/[/:]/);
            if (!base || !quote) throw new Error('--pair expects <base>/<quote>');
            config.base = base;
            config.quote = quote;
        } else if (arg === '--pool') {
            // A missing value must not silently fall back to "no pool".
            const ref = argv[++i];
            if (!ref || ref.startsWith('--')) throw new Error('--pool expects <133|1.19.133|POOLTOKEN>');
            config.poolId = ref;
        }
        else if (arg === '--depth') config.depth = Math.max(1, Math.floor(parsePositiveNumber(argv[++i], '--depth')));
        else if (arg === '--range') config.range = parsePositiveNumber(argv[++i], '--range');
        else if (arg === '--steps') config.steps = Math.max(2, Math.floor(parsePositiveNumber(argv[++i], '--steps')));
        else if (arg === '--chart') config.chartFile = argv[++i] ?? null;
        else if (arg === '--json') config.jsonFile = argv[++i] ?? null;
        else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        else positional.push(arg);
    }

    if (positional.length > 0) config.base = positional[0];
    if (positional.length > 1) config.quote = positional[1];
    if (positional.length > 2) throw new Error('Too many positional arguments (expected base quote)');
    if (config.range >= 0.95) throw new Error('--range must be below 0.95');
    // `--help` alone must print the usage (not fail target validation).
    if (config.help) return config;
    // A pool reference carries both legs, so `--pool` alone is a valid target —
    // but half a pair next to it is ambiguous (which leg would win?).
    const hasBase = Boolean(config.base);
    const hasQuote = Boolean(config.quote);
    if (config.poolId && hasBase !== hasQuote) {
        throw new Error('Pass both --base and --quote, or neither when using --pool');
    }
    if (!config.poolId && (!hasBase || !hasQuote)) {
        throw new Error('Both base and quote assets are required (use --pair A/B, --base + --quote, or --pool <133|1.19.133|POOLTOKEN>)');
    }
    return config;
}

function sanitizeFilePart(value: string): string {
    return String(value || 'asset').replace(/[^A-Za-z0-9._-]+/g, '_');
}

function defaultChartPath(base: ChainAsset, quote: ChainAsset): string {
    return path.join(
        PATHS.ANALYSIS.CHARTS_DIR,
        `liquidity_${sanitizeFilePart(base.symbol)}_${sanitizeFilePart(quote.symbol)}.html`,
    );
}

interface Snapshot {
    base: ChainAsset;
    quote: ChainAsset;
    pool: PoolState | null;
    pools: RawPool[];
    sides: BookSides;
    center: number;
    window: { min: number; max: number };
}

function pickWindowCenter(pool: PoolState | null, sides: BookSides): number {
    const poolPrice = computePoolPrice(pool);
    if (poolPrice != null) return poolPrice;
    const stats = computeBookStats(sides);
    if (stats.mid != null && stats.mid > 0) return stats.mid;
    const all: BookOrder[] = [...sides.bids, ...sides.asks];
    if (all.length > 0) {
        const sum = all.reduce((acc, o) => acc + o.price, 0);
        return sum / all.length;
    }
    throw new Error('No order-book levels and no pool: nothing to chart for this pair');
}

async function loadSnapshot(config: LiquidityConfig): Promise<Snapshot> {
    return withReadOnlyClient(async (client) => {
        let base: ChainAsset;
        let quote: ChainAsset;
        let poolId: string | null = null;

        if (config.poolId) {
            // Pool id or pool token: the pool object carries both legs, so it is
            // resolved first and supplies base/quote when they were omitted.
            const rawPool = await resolvePool(client, config.poolId);
            poolId = String(rawPool.id);
            const [assetA, assetB] = poolAssetIds(rawPool);
            if (!assetA || !assetB) throw new Error(`Liquidity pool ${poolId} reports no asset pair`);
            if (config.base && config.quote) {
                base = await resolveAsset(client, config.base);
                quote = await resolveAsset(client, config.quote);
                const wanted = new Set([base.id, quote.id]);
                if (base.id === quote.id || !wanted.has(assetA) || !wanted.has(assetB)) {
                    const [poolBase, poolQuote] = await Promise.all([
                        resolveAsset(client, assetA),
                        resolveAsset(client, assetB),
                    ]);
                    throw new Error(
                        `Liquidity pool ${poolId} holds ${poolBase.symbol}/${poolQuote.symbol}, not ${base.symbol}/${quote.symbol}`,
                    );
                }
            } else {
                base = await resolveAsset(client, assetA);
                quote = await resolveAsset(client, assetB);
            }
        } else {
            base = await resolveAsset(client, config.base);
            quote = await resolveAsset(client, config.quote);
        }
        if (base.id === quote.id) throw new Error('Base and quote assets must differ');

        const [sides, pools] = await Promise.all([
            fetchOrderBook(client, base, quote, config.depth),
            fetchPools(client, base.id, quote.id),
        ]);
        const pool = selectPool(pools, base, quote, poolId);
        if (poolId && !pool) {
            throw new Error(`Pool ${poolId} was not found for ${base.symbol}/${quote.symbol}`);
        }
        if (sides.bids.length === 0 && sides.asks.length === 0 && !pool) {
            throw new Error(`No order-book levels and no AMM pool for ${base.symbol}/${quote.symbol}`);
        }

        const center = pickWindowCenter(pool, sides);
        const window = resolvePriceWindow(center, config.range);
        return { base, quote, pool, pools, sides, center, window };
    });
}

function nearestIndex(prices: number[], target: number): number {
    let lo = 0, hi = prices.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (prices[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    if (lo > 0 && Math.abs(prices[lo - 1] - target) <= Math.abs(prices[lo] - target)) return lo - 1;
    return lo;
}

function printSummary(snapshot: Snapshot, seriesResult: ReturnType<typeof buildDepthSeries>, chartFile: string, config: LiquidityConfig): void {
    const { base, quote, pool, sides, window } = snapshot;
    const stats = computeBookStats(sides);
    const poolPrice = seriesResult.poolPrice;
    const fmtPrice = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '-' : formatCurrency(v));
    const fmtAmount = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? '-' : formatFundsValue(v));
    const priceLabel = `${quote.symbol} per ${base.symbol}`;

    console.log(`[Liquidity] ${base.symbol}/${quote.symbol}  (price: ${priceLabel}, depth: ${quote.symbol})`);
    if (pool) {
        console.log(`  pool      ${pool.id ?? 'unknown'}  price=${fmtPrice(poolPrice)}  reserves=${fmtAmount(pool.baseReserve)} ${base.symbol} / ${fmtAmount(pool.quoteReserve)} ${quote.symbol}${pool.feePercent != null ? `  fee=${fmtPrice(pool.feePercent)}%` : ''}`);
    } else {
        console.log('  pool      none');
    }
    console.log(`  book      ${stats.bidOrders} bids / ${stats.askOrders} asks  best bid=${fmtPrice(stats.bestBid)}  best ask=${fmtPrice(stats.bestAsk)}  mid=${fmtPrice(stats.mid)}  spread=${fmtPrice(stats.spreadPercent)}%`);
    console.log(`  window    ${fmtPrice(window.min)} .. ${fmtPrice(window.max)}  (${seriesResult.priceCount} samples, range=${config.range})`);
    // The sampled series is wider than the displayed window so the inverted
    // (1/p) view can stay centered; report depth at the actual window edges.
    const first = nearestIndex(seriesResult.prices, window.min);
    const last = nearestIndex(seriesResult.prices, window.max);
    console.log(`  depth at window edges  book: bids=${fmtAmount(seriesResult.bookBid[first])} / asks=${fmtAmount(seriesResult.bookAsk[last])} ${quote.symbol}`);
    console.log(`                          pool: bids=${fmtAmount(seriesResult.poolBid[first])} / asks=${fmtAmount(seriesResult.poolAsk[last])} ${quote.symbol}`);
    console.log(`\n[Liquidity] ✓ Chart saved. Open chart: (${toFileUrl(chartFile)})`);
}

async function main(): Promise<void> {
    // Drop [Transport]/[NodeManager]/[bitshares_client] connection chatter;
    // real errors still go to console.error.
    muteChainLogs();
    let config: LiquidityConfig;
    try {
        config = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`[Liquidity] ${getErrorMessage(err)}`);
        console.error(usage());
        process.exitCode = 1;
        return;
    }
    if (config.help) {
        console.log(usage());
        return;
    }

    try {
        if (!config.quiet) console.log('[Liquidity] Loading order book and pool from chain...');
        const snapshot = await loadSnapshot(config);
        const stats = computeBookStats(snapshot.sides);
        // Sample beyond the displayed high-price edge so the inverted view can
        // use a symmetric window around 1/p0. p0/(1-range) maps exactly to the
        // reciprocal window's low-price endpoint q0*(1-range).
        const sampleWindow = {
            min: snapshot.window.min,
            max: Math.max(snapshot.window.max, snapshot.center / (1 - config.range)),
        };
        const expansion = (sampleWindow.max - sampleWindow.min) / (snapshot.window.max - snapshot.window.min);
        const seriesResult = buildDepthSeries({
            bids: snapshot.sides.bids,
            asks: snapshot.sides.asks,
            pool: snapshot.pool,
            window: sampleWindow,
            steps: Math.max(config.steps, Math.ceil(config.steps * expansion)),
        });

        const html = generateLiquidityHTML({
            base: snapshot.base,
            quote: snapshot.quote,
            pool: snapshot.pool,
            book: stats,
            series: seriesResult,
            window: snapshot.window,
        });
        const chartFile = config.chartFile || defaultChartPath(snapshot.base, snapshot.quote);
        writeChartFile(chartFile, html);

        if (config.jsonFile) {
            const dump = {
                generatedAt: new Date().toISOString(),
                base: snapshot.base,
                quote: snapshot.quote,
                pool: snapshot.pool,
                book: stats,
                window: snapshot.window,
                series: seriesResult,
            };
            fs.mkdirSync(path.dirname(config.jsonFile), { recursive: true });
            fs.writeFileSync(config.jsonFile, JSON.stringify(dump, null, 2), 'utf8');
        }

        if (!config.quiet) printSummary(snapshot, seriesResult, chartFile, config);
    } catch (err) {
        console.error(`[Liquidity] ${getErrorMessage(err)}`);
        process.exitCode = 1;
    }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) void main();

export { parseArgs };
export type { LiquidityConfig };

#!/usr/bin/env node
'use strict';


import fs from 'node:fs';
import path from 'node:path';
import { generateHTML } from './tradingview_uplot_chart_generator.js';
import { resolveGridResetSimConfig, toGridSimPayload } from './grid_reset_config.js';
import { resolveAmaConfig } from '../bot_key_utils.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { loadCandleFile } from '../math_utils.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { toIntervalLabel } from '../../market_adapter/interval_utils.js';
import { loadBotMeta } from '../bot_key_utils.js';
import { resolveSource, listAvailableBots } from '../resolve_source.js';
import { writeChartFile, toFileUrl } from '../chart_utils.js';
import { CLI_TAGS, savedLine } from '../../modules/cli_progress.js';
import { PATHS } from '../../modules/paths.js';


const DEFAULT_CHART_DIR = PATHS.ANALYSIS.CHARTS_DIR;
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'tradingview_chart.html');
const DEFAULT_AMA = MARKET_ADAPTER.AMAS.AMA3;
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);

interface GridSlotToggle {
    price?: unknown;
    state?: unknown;
    type?: unknown;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: { filePath?: string; botKey?: string } };
        chartFile: string;
        title: string | null;
        priceScale: string;
        smaPeriod: number;
        amaErPeriod: number | undefined;
        amaFastPeriod: number | undefined;
        amaSlowPeriod: number | undefined;
        smaEnabled: boolean;
        vwapEnabled: boolean;
        vwapBars: number;
        rangeSpan: number | undefined;
        ordersFile: string | null;
        noOrders: boolean;
        gridResetEnabled: boolean;
        gridDeltaPct: number | undefined;
        gridSlopeDeltaPct: number | undefined;
        gridWarmupBars: number | undefined;
        noUpdateMarker: boolean;
        updateMarkerTsSec: number | null;
        updateMarkerNewBars: number | null;
        quiet: boolean;
        listBots: boolean;
    } = {
        source: { type: 'market_adapter', config: { botKey: '', filePath: undefined } },
        chartFile: DEFAULT_CHART_FILE,
        title: null,
        priceScale: 'log',
        smaPeriod: 500,
        amaErPeriod: undefined,
        amaFastPeriod: undefined,
        amaSlowPeriod: undefined,
        smaEnabled: false,
        vwapEnabled: false,
        vwapBars: 500,
        rangeSpan: undefined,
        ordersFile: null,
        noOrders: false,
        gridResetEnabled: true,
        gridDeltaPct: undefined,
        gridSlopeDeltaPct: undefined,
        gridWarmupBars: undefined,
        noUpdateMarker: false,
        updateMarkerTsSec: null,
        updateMarkerNewBars: null,
        quiet: false,
        listBots: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--source') config.source.type = String(args[++i] || 'json');
        else if (arg === '--file') {
            config.source.type = 'json';
            config.source.config.filePath = args[++i];
        }
        else if (arg === '--bot-key') config.source.config.botKey = args[++i];
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--title') config.title = args[++i];
        else if (arg === '--price-scale' || arg === '--scale') config.priceScale = String(args[++i] || 'log');
        else if (arg === '--sma-period') config.smaPeriod = Math.max(1, parseInt(args[++i], 10) || 500);
        else if (arg === '--ama-er-period') config.amaErPeriod = Math.max(1, parseInt(args[++i], 10) || DEFAULT_AMA.erPeriod);
        else if (arg === '--ama-fast-period') config.amaFastPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.fastPeriod);
        else if (arg === '--ama-slow-period') config.amaSlowPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.slowPeriod);
        else if (arg === '--no-sma') config.smaEnabled = false;
        else if (arg === '--no-vwap') config.vwapEnabled = false;
        else if (arg === '--vwap-bars') config.vwapBars = Math.max(5, parseInt(args[++i], 10) || 500);
        else if (arg === '--range-span') config.rangeSpan = parseFloat(args[++i]);
        else if (arg === '--orders-file') config.ordersFile = String(args[++i] || '');
        else if (arg === '--no-orders') config.noOrders = true;
        else if (arg === '--grid-reset') config.gridResetEnabled = true;
        else if (arg === '--no-grid-reset') config.gridResetEnabled = false;
        else if (arg === '--grid-delta-pct') {
            const v = parseFloat(args[++i]);
            if (Number.isFinite(v) && v > 0) config.gridDeltaPct = Math.max(0.01, v);
            else console.warn('[TradingView] --grid-delta-pct requires a positive number; ignoring.');
        }
        else if (arg === '--grid-slope-delta-pct') {
            const v = parseFloat(args[++i]);
            if (Number.isFinite(v) && v > 0) config.gridSlopeDeltaPct = Math.max(0.0001, v);
            else console.warn('[TradingView] --grid-slope-delta-pct requires a positive number; ignoring.');
        }
        else if (arg === '--grid-warmup') {
            const v = parseFloat(args[++i]);
            if (Number.isFinite(v) && v >= 0) config.gridWarmupBars = Math.max(0, Math.round(v));
            else console.warn('[TradingView] --grid-warmup requires a non-negative bar count; ignoring.');
        }
        else if (arg === '--no-update-marker') config.noUpdateMarker = true;
        else if (arg === '--update-marker-ts') config.updateMarkerTsSec = Math.max(0, parseInt(args[++i], 10) || 0) || null;
        else if (arg === '--update-marker-bars') config.updateMarkerNewBars = Math.max(0, parseInt(args[++i], 10) || 0) || null;
        else if (arg === '--list-bots') config.listBots = true;
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function loadJsonMeta(filePath: string | null | undefined) {
    if (!filePath || !fs.existsSync(filePath)) return { meta: null, candles: null };
    return loadCandleFile(filePath);
}

// ── Order overlay: live grid levels (buys/sells) + full-grid bounds ──
// Canonical source is profiles/orders/<botKey>.json (same files
// scripts/analyze-orders.ts reads); --orders-file overrides, --no-orders
// disables. Pool/pair charts without a bot key render without overlay,
// silently — no hardcoded personal paths.
function resolveOrdersFile(botKey: string | null | undefined, explicit: string | null | undefined, disabled: boolean): string | null {
    if (disabled) return null;
    if (explicit) {
        try { if (fs.existsSync(explicit)) return explicit; } catch { /* fall through to warning */ }
        console.warn(`[TradingView] --orders-file not found: ${explicit} (rendering without order overlay)`);
        return null;
    }
    if (!botKey) return null;
    try {
        const ordersDir = (PATHS as { ORDERS_DIR?: string }).ORDERS_DIR || path.join(path.dirname(PATHS.PROFILES.BOTS_JSON), 'orders');
        const direct = path.join(ordersDir, `${botKey}.json`);
        if (fs.existsSync(direct)) return direct;
    } catch { /* silent when absent */ }
    return null;
}

// Single-pass read of the order grid, like the runtime sees it: live
// (active/partial) levels for the overlay plus full-grid bounds (live +
// planned/virtual slots). Virtual slots carry the same slot geometry
// without an on-chain order, so excluding them would shrink the shown
// grid to the live extremes. Spread-type slots are neither buys nor
// sells and stay out of both.
function loadOrdersData(filePath: string | null): { buys: number[]; sells: number[]; low: number | null; high: number | null } {
    if (!filePath) return { buys: [], sells: [], low: null, high: null };
    try {
        const od = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const grid = Array.isArray(od?.grid) ? od.grid : (Array.isArray(od?.orders) ? od.orders : []);
        const buys: number[] = [];
        const sells: number[] = [];
        let low: number | null = null;
        let high: number | null = null;
        for (const s of grid) {
            const price = Number((s as GridSlotToggle)?.price);
            if (!Number.isFinite(price) || price <= 0) continue;
            const st = (s as GridSlotToggle)?.state;
            if (st !== 'active' && st !== 'partial' && st !== 'virtual') continue;
            if ((s as GridSlotToggle)?.type === 'buy') {
                if (low == null || price < low) low = price;
                if (st !== 'virtual') buys.push(price);
            } else if ((s as GridSlotToggle)?.type === 'sell') {
                if (high == null || price > high) high = price;
                if (st !== 'virtual') sells.push(price);
            }
        }
        buys.sort((a, b) => a - b);
        sells.sort((a, b) => a - b);
        return { buys, sells, low, high };
    } catch { return { buys: [], sells: [], low: null, high: null }; }
}

function inferTitle(meta: { pool?: unknown; intervalSeconds?: unknown; assetA?: { symbol?: unknown; id?: unknown }; assetB?: { symbol?: unknown; id?: unknown } } | null | undefined, fallback: string) {
    const pool = meta?.pool ? `Pool ${String(meta.pool).replace(/^1\.19\./, '')}` : null;
    const a = meta?.assetA?.symbol || meta?.assetA?.id || null;
    const b = meta?.assetB?.symbol || meta?.assetB?.id || null;
    const pair = a && b ? `${a}/${b}` : fallback;
    const label = pool || pair;
    const interval = Number(meta?.intervalSeconds) > 0 ? toIntervalLabel(Number(meta?.intervalSeconds)) : '1h';
    return `${label} · ${interval} · TradingView`;
}

async function main() {
    try {
        const config = parseArgs();

        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source, botKey, amaConfig, meta: sourceMeta } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        if (!config.quiet) console.log(`[TradingView] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const isJsonSource = config.source.type === 'json';
        const filePath = config.source.config.filePath;
        const rawJson = isJsonSource ? loadJsonMeta(filePath) : { meta: null, candles: null };
        const botMeta = botKey ? loadBotMeta(botKey) : null;
        // Prefer meta from the actual candle file (has pool + asset ids) over
        // the bots.json fallback, which only knows the asset symbols.
        const jsonMeta = rawJson.meta || sourceMeta || (botMeta ? {
            assetA: { symbol: botMeta.assetA },
            assetB: { symbol: botMeta.assetB },
            intervalSeconds: 3600,
        } : null);
        const title = config.title || inferTitle(jsonMeta, path.basename(filePath || 'tradingview'));
        const hasAmaGridPrice = AMA_KEYWORDS.has(String(botMeta?.gridPrice || '').trim().toLowerCase());
        // AMA is auto-enabled for gridPrice "ama"/"ama1-4" bots; there is no
        // CLI switch any more (the in-chart AMA toggle owns that choice).
        const amaEnabled = hasAmaGridPrice;

        // Bot grid bounds for the range highlight: mirrors the runtime grid
        // (center = AMA, min "Nx" = center/N, max "Nx" = center*N) with the
        // live asymmetric tilt. Null when no bot key (width% fallback in-page).
        const asym = botMeta?.asymmetricBounds as { maxAsymmetryFactor?: unknown; minScaleSlots?: unknown } | null | undefined;
        const grid = botMeta?.minPrice != null && botMeta?.maxPrice != null ? {
            minPrice: botMeta.minPrice,
            maxPrice: botMeta.maxPrice,
            incrementPercent: Number(botMeta.incrementPercent) > 0 ? Number(botMeta.incrementPercent) : null,
            maxAsymmetryFactor: Number.isFinite(Number(asym?.maxAsymmetryFactor))
                ? Number(asym?.maxAsymmetryFactor)
                : null,
            minScaleSlots: Number.isFinite(Number(asym?.minScaleSlots))
                ? Number(asym?.minScaleSlots)
                : null,
        } : null;
        // Order overlay (canonical profiles/orders/<botKey>.json; silent when absent)
        const ordersFile = resolveOrdersFile(botKey, config.ordersFile, config.noOrders);
        const ordersData = loadOrdersData(ordersFile);
        const orderBuys = ordersData.buys;
        const orderSells = ordersData.sells;
        const gridBounds = { low: ordersData.low, high: ordersData.high };
        if (!config.quiet && ordersFile) console.log(`[TradingView] Order overlay: ${orderBuys.length} buys + ${orderSells.length} sells from ${ordersFile}`);
        // Grid-reset simulation (docs/GRID_RECALCULATION.md §3/§4): resolve the
        // AMA-price and AMA-slope delta thresholds exactly like the running
        // adapter does (constants → general.settings → market_adapter_settings
        // globals/pair/bot), so the chart replays the real recentering points.
        const simOverrides = {
            priceDeltaThresholdPercent: config.gridDeltaPct,
            slopeDeltaThresholdPercent: config.gridSlopeDeltaPct,
            warmupBars: config.gridWarmupBars,
        };
        const gridSim = botKey
            ? toGridSimPayload(resolveGridResetSimConfig({
                botKey,
                bot: botMeta,
                ama: resolveAmaConfig(botKey),
                overrides: simOverrides,
            }))
            : null;
        if (!config.quiet && gridSim) {
            console.log(
                `[TradingView] Grid resets: AMA Δ ${gridSim.priceDeltaThresholdPercent}% (${gridSim.priceSource})`
                + ` | AMA-Slope Δ ${gridSim.slopeDeltaThresholdPercent}%/bar (${gridSim.slopeSource})`
                + ` | slope trigger ${gridSim.slopeEnabled ? 'on' : 'off'}`,
            );
        }
        const html = generateHTML({
            candles,
            meta: jsonMeta || {
                assetA: { symbol: 'Asset A' },
                assetB: { symbol: 'Asset B' },
            },
            smaPeriod: config.smaPeriod,
            amaDefaults: {
                // Canonical 3-param AMA (er/fast/slow). The in-page AMA
                // recomputation mirrors the live adapter exactly; `dexbot tv`
                // stays a plain candle chart.
                erPeriod: config.amaErPeriod ?? amaConfig.erPeriod,
                fastPeriod: config.amaFastPeriod ?? amaConfig.fastPeriod,
                slowPeriod: config.amaSlowPeriod ?? amaConfig.slowPeriod,
            },
            smaEnabled: config.smaEnabled,
            amaEnabled,
            vwapEnabled: config.vwapEnabled,
            vwapBars: config.vwapBars,
            rangeSpan: config.rangeSpan,
            grid,
            gridSim,
            gridSimEnabled: config.gridResetEnabled,
            priceScale: config.priceScale === 'linear' ? 'linear' : 'log',
            defaultTimeframe: '1h',
            marketAdapter: MARKET_ADAPTER,
            orders: { buys: orderBuys, sells: orderSells },
            gridBounds,
            // Update marker ("updated from here" line): explicit CLI flags win,
            // otherwise fall back to stamped data-file meta when present.
            updateMarkerTsSec: config.noUpdateMarker ? null : (config.updateMarkerTsSec
                ?? (Number((jsonMeta as { prevUpdateLastCandleSec?: unknown } | null | undefined)?.prevUpdateLastCandleSec) > 0 ? Number((jsonMeta as { prevUpdateLastCandleSec?: unknown }).prevUpdateLastCandleSec) : null)),
            updateMarkerNewBars: config.noUpdateMarker ? null : (config.updateMarkerNewBars
                ?? (Number((jsonMeta as { prevUpdateNewBars?: unknown } | null | undefined)?.prevUpdateNewBars) || null)),
        }, title);

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(savedLine(CLI_TAGS.tradingView, 'Chart', toFileUrl(config.chartFile)));
    } catch (err) {
        console.error(`[TradingView] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

export { main, parseArgs }

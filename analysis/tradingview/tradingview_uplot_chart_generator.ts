'use strict';

import fs from 'node:fs';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { escapeHtml, serializeJsonForScript, UPLOT_SHARED_SCRIPT, embedFunctionSources } from '../chart_utils.js';
import { cursorCSS, uplotBgCSS } from '../chart_css.js';
import { zoomResetScript } from '../chart_ui.js';
import { normalizeCandle } from '../math_utils.js';
import { PATHS } from '../../modules/paths.js';
import { getStorage } from '../../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../../modules/utils/errors.js';
import { parseRelativeMultiplier } from '../../modules/order/utils/math.js';
import { computeAverageAmaSlopePct, computeAmaSlopeClipThreshold } from '../../market_adapter/core/strategies/dynamic_weight_series.js';
import {
    resolveBaseBounds,
    computeAsymmetricBoundsMetrics,
    applyAsymmetricBounds,
    applyNarrowingSideGuard,
} from '../../market_adapter/core/asymmetric_bounds.js';


function inferBaseIntervalSeconds(candles: any[], fallback: any = 3600) {
    if (!Array.isArray(candles) || candles.length < 2) return fallback;
    const deltas: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = Number(candles[i - 1]?.time);
        const curr = Number(candles[i]?.time);
        if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
        const d = curr - prev;
        if (d > 0) deltas.push(d);
    }
    if (deltas.length === 0) return fallback;
    deltas.sort((a: any, b: any) => a - b);
    const mid = Math.floor(deltas.length / 2);
    const med = deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
    return Math.max(60, Math.round(med));
}

function loadMarketProfiles(filePath: any = PATHS.PROFILES.MARKET_PROFILES_JSON) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return readJSON(filePath);
    } catch (err: any) {
        console.warn(`[WARN] Failed to parse ${filePath}: ${getErrorMessage(err)}. Falling back to built-in AMA defaults.`);
        return null;
    }
}

function findMarketProfile(profiles: any, meta: any = {}) {
    const entries = Array.isArray(profiles?.profiles) ? profiles.profiles : [];
    if (!entries.length) return null;
    const assetA = meta.assetA?.symbol || meta.assetA?.id || meta.assetA;
    const assetB = meta.assetB?.symbol || meta.assetB?.id || meta.assetB;
    const intervalSeconds = Number(meta.intervalSeconds);
    return entries.find((entry: any) => {
        if (!entry || typeof entry !== 'object') return false;
        if (assetA && assetB) {
            const matchesPair = (String(entry.assetA) === String(assetA) || String(entry.assetAId) === String(assetA))
                && (String(entry.assetB) === String(assetB) || String(entry.assetBId) === String(assetB));
            if (!matchesPair) return false;
        } else {
            return false;
        }
        if (Number.isFinite(intervalSeconds) && intervalSeconds > 0 && Number(entry.intervalSeconds) !== intervalSeconds) {
            return false;
        }
        return true;
    }) || null;
}

function resolveAmaDefaults({ meta, data, marketProfiles }: any = {}) {
    const amaDefaultsSource = MARKET_ADAPTER.AMAS.AMA3;
    const profile = findMarketProfile(marketProfiles, meta);
    const profileAmaKey = profile?.defaultAma && profile.amas && profile.amas[profile.defaultAma]
        ? profile.defaultAma
        : null;
    const profileAma = profileAmaKey ? profile.amas[profileAmaKey] : null;
    const source = data?.amaDefaults || profileAma || amaDefaultsSource;
    return {
        erPeriod: Math.max(1, Math.round(Number(data?.amaErPeriod ?? source.erPeriod))),
        fastPeriod: Number.isFinite(Number(data?.amaFastPeriod))
            ? Number(data.amaFastPeriod)
            : Number(source.fastPeriod),
        slowPeriod: Number.isFinite(Number(data?.amaSlowPeriod))
            ? Number(data.amaSlowPeriod)
            : Number(source.slowPeriod),
    };
}

const TRADINGVIEW_PREFS_KEY_PREFIX = 'dexbot2-tradingview-uplot-v3';
const TRADINGVIEW_SYNC_KEY = 'dexbot2-tradingview-sync';

function sanitizeStorageComponent(value: any, fallback: string) {
    // Objects (e.g. a meta asset node missing both id and symbol) stringify to
    // "[object Object]", which would collapse distinct assets onto one key.
    if (value == null || typeof value === 'object') return fallback;
    const raw = String(value).trim();
    const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || fallback;
}

// Prefer asset ids over symbols: ids are immutable, symbols can be relabeled.
function resolveChartStorageKey(meta: any = {}, baseIntervalSeconds: any = 0) {
    const pool = sanitizeStorageComponent(meta?.pool ?? meta?.poolId, 'nipool');
    const assetA = sanitizeStorageComponent(meta?.assetA?.id ?? meta?.assetA?.symbol ?? meta?.assetA, 'assetA');
    const assetB = sanitizeStorageComponent(meta?.assetB?.id ?? meta?.assetB?.symbol ?? meta?.assetB, 'assetB');
    const interval = Number(baseIntervalSeconds) > 0 ? Math.round(Number(baseIntervalSeconds)) : 0;
    return `${TRADINGVIEW_PREFS_KEY_PREFIX}:${pool}:${assetA}_${assetB}:${interval || 'base'}`;
}

function generateHTML(data: any, title: any = 'TradingView Style Research') {
    const rawCandles = Array.isArray(data.candles) ? data.candles : [];
    const candles = rawCandles.map(normalizeCandle).filter(Boolean);
    if (candles.length === 0) throw new Error('No candle data in input');

    const meta = data.meta || {};
    const baseIntervalSeconds = Number(meta.intervalSeconds) > 0
        ? Number(meta.intervalSeconds)
        : inferBaseIntervalSeconds(candles, 3600);

    const timeframes = [
        { label: '1h', seconds: 3600 },
        { label: '4h', seconds: 14400 },
        { label: '1d', seconds: 86400 },
        { label: '1w', seconds: 604800 },
        { label: '1M', seconds: 2592000, calendar: 'month' },
    ].map((item: any) => ({ ...item, enabled: item.seconds >= baseIntervalSeconds }));

    const defaultTimeframe = timeframes.find((item: any) => item.label === data.defaultTimeframe && item.enabled)
        || timeframes.find((item: any) => item.enabled)
        || timeframes[0];

    const marketProfiles = data.marketProfiles || loadMarketProfiles();
    const defaultAmaConfig = resolveAmaDefaults({ meta, data, marketProfiles });
    const rangeSlope = {
        lookbackBars: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        maxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        neutralZonePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
        maxSlopeOffset: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
        maxAsymmetryFactor: MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR,
        minScaleSlots: MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MIN_SCALE_SLOTS,
        clipPercentile: MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE,
    };
    function defaultRangeSpan(input: { rangeSpan?: unknown; grid?: { minPrice?: unknown; maxPrice?: unknown } | null }): number {
        const cli = Number(input.rangeSpan);
        if (Number.isFinite(cli)) return Math.min(2, Math.max(1.2, cli));
        const down = parseRelativeMultiplier(input.grid?.minPrice);
        const up = parseRelativeMultiplier(input.grid?.maxPrice);
        if (down != null && down > 1 && up != null && up > 1) return Math.min(2, Math.max(1.2, (down + up) / 2));
        const vd = Number(input.grid?.minPrice);
        const vu = Number(input.grid?.maxPrice);
        if (Number.isFinite(vd) && Number.isFinite(vu) && vd > 0 && vu > vd) {
            const ref = Math.sqrt(vd * vu);
            return Math.min(2, Math.max(1.2, (ref / vd + vu / ref) / 2));
        }
        return 1.55;
    }
    const defaults = {
        smaPeriod: Math.max(1, Math.round(data.smaPeriod ?? 500)),
        amaDefaults: defaultAmaConfig,
        smaEnabled: data.smaEnabled === true,
        amaEnabled: data.amaEnabled === true,
        vwapEnabled: data.vwapEnabled === true,
        vwapBars: Math.max(5, Math.round(data.vwapBars ?? 500)),
        priceScale: data.priceScale === 'linear' ? 'linear' : 'log',
        rangeEnabled: data.rangeEnabled === true,
        rangeScaleEnabled: data.rangeScaleEnabled === true,
        rangeWidthPct: Number.isFinite(Number(data.rangeWidthPct)) && Number(data.rangeWidthPct) > 0
            ? Number(data.rangeWidthPct)
            : 2,
        rangeSpan: defaultRangeSpan(data),
        grid: data.grid && data.grid.minPrice != null && data.grid.maxPrice != null ? {
            minPrice: data.grid.minPrice,
            maxPrice: data.grid.maxPrice,
            incrementPercent: Number(data.grid.incrementPercent) > 0 ? Number(data.grid.incrementPercent) : null,
            maxAsymmetryFactor: Number.isFinite(Number(data.grid.maxAsymmetryFactor)) && Number(data.grid.maxAsymmetryFactor) > 0
                ? Number(data.grid.maxAsymmetryFactor)
                : rangeSlope.maxAsymmetryFactor,
        } : null,
        rangeSlope,
    };

    const assetLabelA = meta.assetA?.symbol || meta.assetA?.id || 'Asset A';
    const assetLabelB = meta.assetB?.symbol || meta.assetB?.id || 'Asset B';
    const pairLabelNormal = `${assetLabelA}/${assetLabelB}`;
    const pairLabelInverse = `${assetLabelB}/${assetLabelA}`;
    const poolLabel = meta.pool ? `Pool ${String(meta.pool).replace(/^1\.19\./, '')}` : 'Pair';
    const intervalLabel = baseIntervalSeconds >= 86400
        ? `${Math.round(baseIntervalSeconds / 86400)}d`
        : `${Math.round(baseIntervalSeconds / 3600)}h`;
    const defaultPairMode = data.defaultPairMode === 'inverse' ? 'inverse' : 'normal';
    const storageKey = typeof data.storageKey === 'string' && data.storageKey.length > 0
        ? data.storageKey
        : resolveChartStorageKey(meta, baseIntervalSeconds);

    const payload = {
        storageKey,
        syncKey: TRADINGVIEW_SYNC_KEY,
        candles,
        timeframes,
        defaultTimeframe: defaultTimeframe.label,
        smaPeriod: defaults.smaPeriod,
        amaDefaults: defaultAmaConfig,
        smaEnabled: defaults.smaEnabled,
        amaEnabled: defaults.amaEnabled,
        vwapEnabled: defaults.vwapEnabled,
        vwapBars: defaults.vwapBars,
        priceScale: defaults.priceScale,
        rangeEnabled: defaults.rangeEnabled,
        rangeScaleEnabled: defaults.rangeScaleEnabled,
        rangeWidthPct: defaults.rangeWidthPct,
        rangeSpan: defaults.rangeSpan,
        grid: defaults.grid,
        orderBuys: Array.isArray((data as any).orders?.buys) ? (data as any).orders.buys.map(Number).filter(Number.isFinite) : [],
        orderSells: Array.isArray((data as any).orders?.sells) ? (data as any).orders.sells.map(Number).filter(Number.isFinite) : [],
        gridBounds: {
            low: Number.isFinite(Number((data as any).gridBounds?.low)) && Number((data as any).gridBounds.low) > 0 ? Number((data as any).gridBounds.low) : null,
            high: Number.isFinite(Number((data as any).gridBounds?.high)) && Number((data as any).gridBounds.high) > 0 ? Number((data as any).gridBounds.high) : null,
        },
        updateMarkerTsSec: Number((data as any).updateMarkerTsSec) > 0 ? Number((data as any).updateMarkerTsSec) : null,
        updateMarkerNewBars: Number((data as any).updateMarkerNewBars) || null,
        rangeSlope,
        defaultPairMode,
        assetLabelA,
        assetLabelB,
        pairLabelNormal,
        pairLabelInverse,
        poolLabel,
        intervalLabel,
        amaDefaultsSource: marketProfiles ? 'market_profiles' : 'constants',
        volumeIsCount: !!((meta as any)?.feed),
    };

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="../uplot/uPlot.min.css">
    <script src="../uplot/uPlot.iife.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        :root { color-scheme: dark; }
        body {
            margin: 0;
            overflow: hidden;
            background: linear-gradient(180deg, #090d12 0%, #0b0f14 40%, #0a0c11 100%);
            color: #d7e0ea;
            font-family: Inter, "Segoe UI", system-ui, sans-serif;
        }
        #app { height: 100vh; display: flex; flex-direction: column; }
        #topbar {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 12px 16px 10px;
            border-bottom: 1px solid #263241;
            background: rgba(15,19,26,0.94);
            backdrop-filter: blur(10px);
        }
        #brand { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
        #title { font-size: 15px; font-weight: 700; color: #f5f8fb; }
        #subtitle { font-size: 11px; color: #b9c6d4; text-transform: uppercase; letter-spacing: 0.6px; }
        #toolbar { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .toolbar-row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 12px; align-items: center; }
        .group { display: inline-flex; align-items: center; gap: 8px; padding-left: 12px; border-left: 1px solid #263241; }
        .group:first-child { padding-left: 0; border-left: 0; }
        .primary-toolbar-row .group { padding-left: 0; border-left: 0; }
        :root {
            --control-height: 36px;
        }
        .time-btn {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(24,30,39,0.85);
            color: #8290a2;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            padding: 7px 10px;
            border-radius: 8px;
            cursor: pointer;
        }
        .time-btn.active {
            color: #fff;
            border-color: rgba(94,161,255,0.85);
            background: linear-gradient(180deg, rgba(35,53,79,0.95), rgba(22,32,47,0.98));
        }
        .time-btn:disabled { opacity: 0.35; cursor: not-allowed; text-decoration: line-through; }
        .ama-preset-btn.active {
            color: #fff;
            border-color: rgba(250,204,21,0.85);
            background: linear-gradient(180deg, rgba(79,66,22,0.95), rgba(47,40,18,0.98));
        }
        .indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            min-height: var(--control-height);
            padding: 0 13px;
            border: 1px solid #263241;
            border-radius: 10px;
            background: rgba(20,25,33,0.86);
        }
        .indicator label {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-height: var(--control-height);
            font-size: 11px;
            font-weight: 700;
            color: #d7e0ea;
            text-transform: uppercase;
            white-space: nowrap;
        }
        .indicator input[type="checkbox"] { width: 14px; height: 14px; accent-color: #5ea1ff; }
        .indicator input[type="number"], .indicator select {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(10,14,19,0.92);
            color: #d7e0ea;
            border-radius: 8px;
            padding: 7px 10px;
            font-size: 11px;
            outline: none;
            width: 79px;
            min-width: 79px;
            height: calc(var(--control-height) - 8px);
        }
        .pair-toggle {
            appearance: none;
            width: 32px;
            height: 32px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid #263241;
            border-radius: 999px;
            background: radial-gradient(circle at 30% 30%, rgba(94,161,255,0.18), rgba(10,14,19,0.96));
            color: #d7e0ea;
            cursor: pointer;
            padding: 0;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
            transition: transform 120ms ease, border-color 120ms ease, background 120ms ease, color 120ms ease;
        }
        .pair-toggle:hover {
            transform: translateY(-1px);
            border-color: rgba(94,161,255,0.85);
            color: #fff;
        }
        .pair-toggle:active {
            transform: translateY(0);
        }
        .pair-toggle svg {
            width: 17px;
            height: 17px;
            fill: currentColor;
            display: block;
        }
        .pair-toggle.is-inverse {
            color: #5ea1ff;
            border-color: rgba(94,161,255,0.45);
        }
        .indicator .step-stack {
            display: inline-flex;
            flex-direction: column;
            vertical-align: middle;
            margin-left: 2px;
        }
        .indicator .step-btn {
            appearance: none;
            display: block;
            width: 24px;
            height: 13px;
            border: 1px solid #3d4a5a;
            background: #1a2332;
            color: #8b949e;
            font-size: 9px;
            line-height: 1;
            cursor: pointer;
            padding: 0;
            margin: 0;
        }
        .indicator .step-btn:first-child {
            border-radius: 3px 3px 0 0;
            border-bottom: none;
        }
        .indicator .step-btn:last-child {
            border-radius: 0 0 3px 3px;
        }
        .indicator .step-btn:hover {
            background: #263241;
        }
        .indicator .step-btn:active {
            background: #3d4a5a;
        }
        .indicator input[type="text"] {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(6,8,12,0.95);
            color: #d7e0ea;
            border-radius: 8px;
            padding: 7px 4px;
            font-size: 12px;
            outline: none;
            width: 44px;
            text-align: center;
        }
        .indicator input[type="text"]:focus {
            border-color: #5ea1ff;
        }
        #ama-fast {
            width: 38px;
        }
        .scale-toggle {
            appearance: none;
            min-width: 76px;
            height: 32px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid #263241;
            border-radius: 999px;
            background: rgba(10,14,19,0.92);
            color: #d7e0ea;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.45px;
            text-transform: uppercase;
            cursor: pointer;
            padding: 0 11px;
            transition: transform 120ms ease, border-color 120ms ease, background 120ms ease, color 120ms ease;
        }
        .scale-toggle:hover {
            transform: translateY(-1px);
            border-color: rgba(94,161,255,0.85);
            color: #fff;
        }
        .scale-toggle:active {
            transform: translateY(0);
        }
        .scale-toggle.is-linear {
            color: #5ea1ff;
            border-color: rgba(94,161,255,0.45);
        }
        .reset-btn {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(24,30,39,0.85);
            color: #d7e0ea;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.45px;
            text-transform: uppercase;
            padding: 6px 11px;
            border-radius: 8px;
            cursor: pointer;
        }
        .reset-btn:hover {
            border-color: rgba(94,161,255,0.85);
            color: #fff;
        }
        .indicator .tag { font-size: 10px; color: #8290a2; text-transform: uppercase; letter-spacing: 0.5px; }
        #chart-shell { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
        #price-chart { position: relative; flex: 1 1 auto; min-height: 0; }
        #volume-chart { position: relative; flex: 0 0 19%; min-height: 0; border-top: 1px solid #263241; }
        #legend {
            position: absolute;
            top: 14px;
            left: 14px;
            z-index: 4;
            padding: 10px 12px;
            min-width: 280px;
            max-width: calc(100vw - 28px);
            border: 1px solid #263241;
            border-radius: 12px;
            background: rgba(10,14,20,0.72);
            backdrop-filter: blur(10px);
        }
        .legend-line { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; font-size: 12px; }
        .legend-line + .legend-line { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); }
        .legend-item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
        .legend-dot { width: 10px; height: 10px; border-radius: 999px; flex: 0 0 auto; }
        .legend-label { color: #8290a2; text-transform: uppercase; letter-spacing: 0.45px; font-size: 12px; }
        .legend-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #eef4fb; font-weight: 700; }
        .status { display: inline-flex; align-items: center; gap: 8px; font-size: 10px; color: #8290a2; text-transform: uppercase; letter-spacing: 0.5px; }
        .pill { border: 1px solid rgba(255,255,255,0.06); border-radius: 999px; padding: 4px 8px; background: rgba(255,255,255,0.03); }
        ${uplotBgCSS('#0b0f14')}
        ${cursorCSS()}
        @media (max-width: 980px) {
            #topbar { flex-direction: column; align-items: flex-start; }
            #toolbar { align-items: flex-start; }
            .toolbar-row { justify-content: flex-start; }
            .group { padding-left: 0; border-left: 0; flex-wrap: wrap; }
            #legend { min-width: 0; max-width: calc(100vw - 24px); }
        }
    </style>
</head>
<body>
    <div id="app">
        <div id="topbar">
            <div id="brand">
                <div id="title">${escapeHtml(title)}</div>
                <div id="subtitle">${escapeHtml(poolLabel)} · ${escapeHtml(pairLabelNormal)} · ${escapeHtml(intervalLabel)} base · indicators from 1h · volume · uPlot</div>
            </div>
            <div id="toolbar">
                <div class="toolbar-row primary-toolbar-row">
                <div class="group">
                    <div class="indicator">
                        <span class="tag">pair</span>
                        <button type="button" class="pair-toggle${defaultPairMode === 'inverse' ? ' is-inverse' : ''}" id="pair-toggle" aria-label="Swap pair orientation" title="Swap pair orientation" data-pair-mode="${escapeHtml(defaultPairMode)}">
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path d="M6.5 7H19v2H6.5v3L2 8.5 6.5 5v2Zm11 10H5v-2h12.5v-3L22 15.5 17.5 19v-2Z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="indicator">
                        <span class="tag">scale</span>
                        <button type="button" class="scale-toggle${defaults.priceScale === 'linear' ? ' is-linear' : ''}" id="scale-toggle" data-scale="${escapeHtml(defaults.priceScale)}" aria-label="Toggle price scale" title="Toggle price scale">${defaults.priceScale === 'linear' ? 'Linear' : 'Log'}</button>
                    </div>
                </div>
                <div class="group" id="tf-group">
                    ${timeframes.map((item: any) => `<button class="time-btn${item.label === defaultTimeframe.label ? ' active' : ''}" data-timeframe="${escapeHtml(item.label)}"${item.enabled ? '' : ' disabled'}>${escapeHtml(item.label)}</button>`).join('')}
                </div>
                <div class="group">
                    <div class="indicator">
                        <label><input type="checkbox" id="sma-toggle"${defaults.smaEnabled ? ' checked' : ''}> SMA</label>
                        <input type="text" inputmode="numeric" id="sma-period" value="${defaults.smaPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="sma-period-inc">▲</button>
                            <button type="button" class="step-btn" id="sma-period-dec">▼</button>
                        </span>
                    </div>
                    <div class="indicator">
                        <label><input type="checkbox" id="vwap-toggle"${defaults.vwapEnabled ? ' checked' : ''}> VWMA</label>
                        <input type="text" inputmode="numeric" id="vwap-bars" value="${defaults.vwapBars}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="vwap-bars-inc">▲</button>
                            <button type="button" class="step-btn" id="vwap-bars-dec">▼</button>
                        </span>
                    </div>
                    <div class="indicator"><label><input type="checkbox" id="volume-toggle" checked> Volume</label> <button type="button" class="reset-btn" id="volume-unit-toggle" data-volume-mode="base" title="Volume units: base asset — click for quote asset">${escapeHtml(defaultPairMode === 'inverse' ? assetLabelB : assetLabelA)}</button></div>
                    ${(((payload.orderBuys?.length || 0) + (payload.orderSells?.length || 0) > 0 || payload.gridBounds?.low != null || payload.gridBounds?.high != null) ? '<div class="indicator"><label><input type="checkbox" id="orders-toggle" checked> Orders</label></div>' : '')}
                </div>
                </div>
                <div class="toolbar-row">
                <div class="group">
                    <div class="indicator">
                        <label><input type="checkbox" id="ama-toggle"${defaults.amaEnabled ? ' checked' : ''}> AMA</label>
                        <span class="tag">er</span>
                        <input type="text" inputmode="numeric" id="ama-er" value="${defaults.amaDefaults.erPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="ama-er-inc">▲</button>
                            <button type="button" class="step-btn" id="ama-er-dec">▼</button>
                        </span>
                        <span class="tag">fast</span>
                        <input type="text" inputmode="decimal" id="ama-fast" value="${defaults.amaDefaults.fastPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="ama-fast-inc">▲</button>
                            <button type="button" class="step-btn" id="ama-fast-dec">▼</button>
                        </span>
                        <span class="tag">slow</span>
                        <input type="text" inputmode="decimal" id="ama-slow" value="${defaults.amaDefaults.slowPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="ama-slow-inc">▲</button>
                            <button type="button" class="step-btn" id="ama-slow-dec">▼</button>
                        </span>
                        <button type="button" class="reset-btn ama-preset-btn" data-ama-preset="AMA1" title="AMA1 (slow 62.1)">1</button>
                        <button type="button" class="reset-btn ama-preset-btn" data-ama-preset="AMA2" title="AMA2 (slow 72.0)">2</button>
                        <button type="button" class="reset-btn ama-preset-btn" data-ama-preset="AMA3" title="AMA3 (slow 83.6)">3</button>
                        <button type="button" class="reset-btn ama-preset-btn" data-ama-preset="AMA4" title="AMA4 (slow 96.9)">4</button>
                    </div>
                    <div class="indicator" title="Range min/max built only from the live AMA price (red above, green below); Scale sizes it by AMA slope like the grid build">
                        <label><input type="checkbox" id="range-toggle"${defaults.rangeEnabled ? ' checked' : ''}> Range</label>
                        <label title="Range Scaling: size the band by AMA slope like the grid build (trend side widens, opposite tightens) and fit the price axis to it"><input type="checkbox" id="range-scale-toggle"${defaults.rangeScaleEnabled ? ' checked' : ''}> Scale</label>
                        <span id="range-grid-wrap" style="display:inline" title="x-range around AMA (1.2x–2.0x)">
                            <input type="range" id="range-span" min="1.2" max="2" step="0.05" value="${defaults.rangeSpan.toFixed(2)}" style="width:90px;vertical-align:middle">
                            <span id="range-span-val" style="font-size:11px;color:#8b949e;width:40px;display:inline-block;text-align:right">${defaults.rangeSpan.toFixed(2)}x</span>
                        </span>
                    </div>
                    <div class="indicator">
                        <label><input type="checkbox" id="ama-init-offset-toggle"> Init Offset</label>
                        <input type="range" id="ama-init-offset" min="-50" max="50" value="0" step="1" style="width:90px;vertical-align:middle" disabled>
                        <span id="ama-init-offset-val" style="font-size:11px;color:#8b949e;width:32px;display:inline-block;text-align:right">0%</span>
                    </div>
                </div>
                </div>
            </div>
        </div>
        <div id="chart-shell">
            <div id="legend">
                <div class="legend-line">
                    <span class="legend-item"><span class="legend-label">Time</span> <span class="legend-value" id="legend-time">-</span></span>
                    <span class="legend-item"><span class="legend-label">C</span> <span class="legend-value" id="legend-close">-</span></span>
                    <span class="legend-item"><span class="legend-label">Delta</span> <span class="legend-value" id="legend-delta">-</span></span>
                    <span class="legend-item"><span class="legend-label">Vol</span> <span class="legend-value" id="legend-volume" title="${payload.volumeIsCount ? 'Volume: feed publish count per bucket' : 'Volume units — click to switch base/quote'}" style="cursor:${payload.volumeIsCount ? 'default' : 'pointer'}">-</span></span>
                </div>
                <div class="legend-line">
                    <span class="legend-item"><span class="legend-dot" style="background:#f59e0b"></span><span class="legend-label">SMA</span> <span class="legend-value" id="legend-sma">-</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#93c5fd"></span><span class="legend-label">VWMA</span> <span class="legend-value" id="legend-vwap">-</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#22c55e"></span><span class="legend-label">AMA Init</span> <span class="legend-value" id="legend-sma-init">-</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#2dd4bf"></span><span class="legend-label">AMA</span> <span class="legend-value" id="legend-ama">-</span></span>
                </div>
            </div>
            <div id="price-chart" title="Wheel: zoom time (out = empty space around data) · Shift+wheel: zoom price · Drag: pan time + price (sets manual price scale) · Wheel/drag on price axis: zoom price · Drag on time axis: zoom time · Double-click price axis: autofit"></div>
            <div id="volume-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript(payload)}</script>
    <script>
    (function () {
        const payload = JSON.parse(document.getElementById('payload').textContent);
        const priceEl = document.getElementById('price-chart');
        const volumeEl = document.getElementById('volume-chart');
        const baseCandles = Array.isArray(payload.candles) ? payload.candles.slice() : [];
        const baseCloseValues = baseCandles.map((c) => c.close);
        const timeframes = Array.isArray(payload.timeframes) ? payload.timeframes.slice() : [];
        const timeframeMap = new Map(timeframes.map((item) => [item.label, item]));
        const STORAGE_KEY = typeof payload.storageKey === 'string' && payload.storageKey.length > 0
            ? payload.storageKey
            : 'dexbot2-tradingview-uplot-v3:default';
        const SYNC_KEY = typeof payload.syncKey === 'string' && payload.syncKey.length > 0
            ? payload.syncKey
            : 'dexbot2-tradingview-sync';

        const state = loadState();
        let currentTimeframe = state.timeframe || payload.defaultTimeframe || '1h';
        let currentSmaEnabled = state.smaEnabled ?? !!payload.smaEnabled;
        let currentSmaPeriod = Number.isFinite(state.smaPeriod) ? state.smaPeriod : Number(payload.smaPeriod || 500);
        let currentAmaEnabled = state.amaEnabled ?? !!payload.amaEnabled;
        let currentAmaErPeriod = Number.isFinite(state.amaErPeriod)
            ? Number(state.amaErPeriod)
            : Number(payload.amaDefaults?.erPeriod || ${MARKET_ADAPTER.AMAS.AMA3.erPeriod});
        let currentAmaFastPeriod = Number.isFinite(state.amaFastPeriod)
            ? Number(state.amaFastPeriod)
            : Number(payload.amaDefaults?.fastPeriod || ${MARKET_ADAPTER.AMAS.AMA3.fastPeriod});
        let currentAmaSlowPeriod = Number.isFinite(state.amaSlowPeriod)
            ? Number(state.amaSlowPeriod)
            : Number(payload.amaDefaults?.slowPeriod || ${MARKET_ADAPTER.AMAS.AMA3.slowPeriod});
        let currentVwapEnabled = state.vwapEnabled ?? !!payload.vwapEnabled;
        let currentVwapBars = Number.isFinite(state.vwapBars) ? state.vwapBars : Number(payload.vwapBars || 500);
        let currentRangeEnabled = state.rangeEnabled ?? !!payload.rangeEnabled;
        let currentRangeScaleEnabled = state.rangeScaleEnabled ?? !!payload.rangeScaleEnabled;
        let currentRangeWidthPct = Number.isFinite(state.rangeWidthPct) && Number(state.rangeWidthPct) > 0
            ? Number(state.rangeWidthPct)
            : (Number.isFinite(Number(payload.rangeWidthPct)) && Number(payload.rangeWidthPct) > 0 ? Number(payload.rangeWidthPct) : 2);
        let currentRangeSpan = Number.isFinite(state.rangeSpan) && Number(state.rangeSpan) > 0
            ? Math.min(2, Math.max(1.2, Number(state.rangeSpan)))
            : (Number.isFinite(Number(payload.rangeSpan)) && Number(payload.rangeSpan) > 0 ? Math.min(2, Math.max(1.2, Number(payload.rangeSpan))) : 1.55);
        let currentOrdersVisible = state.ordersVisible ?? true;
        let currentVolumeVisible = state.volumeVisible ?? true;
        let currentVolumeMode = state.volumeMode === 'quote' ? 'quote' : 'base';
        // Static per generation: the overlay (levels, reserve/ceiling lines,
        // spread label) exists only when order data was embedded.
        // --no-orders or a missing orders file therefore removes the whole
        // overlay, including the reserve/ceiling lines.
        const hasOrders = ((payload.orderBuys?.length || 0) + (payload.orderSells?.length || 0)) > 0;
        // Bounds-only grids (virtual slots, no live levels yet) still show
        // the reserve/ceiling lines; levels/spread/panel rows need live data.
        const hasBounds = payload.gridBounds?.low != null || payload.gridBounds?.high != null;
        let currentAmaInitOffsetEnabled = false;
        let currentAmaInitOffset = Number.isFinite(state.amaInitOffset) ? state.amaInitOffset : 0;
        let currentPriceScale = state.priceScale || payload.priceScale || 'log';
        let currentPairMode = state.pairMode === 'inverse' ? 'inverse' : (payload.defaultPairMode === 'inverse' ? 'inverse' : 'normal');
        let currentCandles = [];
        let currentSeriesState = null;
        let currentSeriesCandles = baseCandles;
        let currentSeriesCloseValues = baseCloseValues;
        let currentOpen = [];
        let currentHigh = [];
        let currentLow = [];
        let currentClose = [];
        let currentDisplayCandles = [];
        let currentPriceData = [];
        let currentVolumeData = [];
        let currentSma = [];
        let currentAma = [];
        let currentVwap = [];
        let currentSmaInit = [];
        let currentSmaInitOff = [];
        let currentAmaOff = [];
        let currentRangeUpper = [];
        let currentRangeLower = [];
        let priceChart = null;
        let volumeChart = null;
        let lastRenderedPriceScale = null;
        let charts = [];
        let chartEventsBound = false;
        let manualYRange = null;
        let lastCandleKey = null;
        let pendingRange = null;
        let pendingRangeRaf = 0;
        let rangePanelRaf = 0;
        let yRefitRaf = 0;
        let xMin = 0;
        let xMax = 0;
        let smaWorker = null;
        let smaWorkerJob = null;
        let smaWorkerStartRaf = 0;
        let smaWorkerPaintRaf = 0;
        let smaWorkerSeq = 0;
        const aggregateCache = new Map();
        const smaCache = new Map();
        const amaCache = new Map();
        const vwapCache = new Map();
        const seriesCache = new Map();

        ${UPLOT_SHARED_SCRIPT}

        // TradingView-exporter interaction overrides (PR #3 / #11 feature):
        // redeclare after UPLOT_SHARED_SCRIPT so these hoisted declarations win
        // for this page only, without mutating the shared stack used by other charts.
        function bindWheelZoom(chart) {
            chart.root.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                e.preventDefault();
                const rect = chart.root.getBoundingClientRect();
                const pxRatio = chart.pxRatio || 1;
                const bboxLeft = chart.bbox ? chart.bbox.left / pxRatio : 0;
                const bboxTop = chart.bbox ? chart.bbox.top / pxRatio : 0;
                // Shift+wheel scales price (cursor-anchored) anywhere over the
                // price pane — same as wheeling over the price axis. Volume has
                // no manual Y lock, so it keeps the timeframe zoom.
                if (chart === priceChart && (e.shiftKey || inYAxisZone(chart, e.clientX))) {
                    const centerY = chart.posToVal(e.clientY - rect.top - bboxTop, 'y');
                    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
                    zoomYAt(chart, centerY, delta < 0 ? 0.91 : 1.10);
                    return;
                }
                e.stopPropagation();
                const left = e.clientX - rect.left - bboxLeft;
                const center = chart.posToVal(left, 'x');
                const s = chart.scales.x || {};
                const currMin = Number.isFinite(s.min) ? s.min : xMin;
                const currMax = Number.isFinite(s.max) ? s.max : xMax;
                const span = currMax - currMin;
                if (!Number.isFinite(span) || span <= 0) return;
                const factor = e.deltaY < 0 ? 0.85 : 1.15;
                // Uloszoomaus datan reunojen yli: kokonaisnakyyma enintaan 2.5x datan pituus
                const fullSpan = Math.max(1, xMax - xMin);
                const nextSpan = Math.max(1, Math.min(fullSpan * 2.5, span * factor));
                const ratio = (center - currMin) / span;
                syncXRange(center - nextSpan * ratio, center - nextSpan * ratio + nextSpan);
            }, { passive: false });
        }
        function clampRange(min, max) {
            if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin) return null;
            if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
            // Allow empty space on both sides of the data (TradingView-style):
            // enintaan 75 % datan pituudesta reunapuskurina kummallekin puolelle.
            // Span-locked: pans slide the window and never squash it — only a
            // deliberate over-wide zoom-out is centered down to the limit.
            // Plot drags therefore move but never scale; scaling lives on
            // the axis gutters alone.
            const dataSpan = Math.max(1, xMax - xMin);
            const maxPad = dataSpan * 0.75;
            const lo = xMin - maxPad;
            const hi = xMax + maxPad;
            const span = max - min;
            if (span > hi - lo) {
                const center = (min + max) / 2;
                const half = (hi - lo) / 2;
                return { min: center - half, max: center + half };
            }
            let nMin = min;
            if (nMin < lo) nMin = lo;
            if (nMin + span > hi) nMin = hi - span;
            return { min: nMin, max: nMin + span };
        }
        function syncXRange(min, max) {
            pendingRange = clampRange(min, max);
            if (pendingRangeRaf) return;
            pendingRangeRaf = requestAnimationFrame(() => {
                const next = pendingRange;
                pendingRange = null;
                pendingRangeRaf = 0;
                if (!next || charts.length === 0) return;
                charts.forEach((chart) => chart.batch(() => chart.setScale('x', next)));
            });
        }
        function bindPan(chart) {
            let dragging = false;
            let startClientX = 0;
            let startClientY = 0;
            let startMin = 0;
            let startMax = 0;
            let startYRange = null;
            let startBboxLeft = 0;
            let startBboxTop = 0;
            let panRaf = 0;
            let pendingPan = null;
            const applyPendingPan = () => {
                panRaf = 0;
                const p = pendingPan;
                pendingPan = null;
                if (!dragging || !p) return;
                // Plot drag pans time and price (TradingView-style): the price
                // move sets a manual Y range; double-click the price axis to
                // return to autofit. Axis gutters never pan — they scale.
                if (chart === priceChart && startYRange && Number.isFinite(p.clientY)) {
                    // Plot-relative coords: subtract the axis gutter offset
                    // (bbox) like bindWheelZoom. On linear scales the offset
                    // cancels in subtraction, but on log scale the ratio
                    // corrupts and vertical drag dies without it.
                    const vStart = chart.posToVal(p.startY - p.rectTop - p.bboxTop, 'y');
                    const vCur = chart.posToVal(p.clientY - p.rectTop - p.bboxTop, 'y');
                    if (Number.isFinite(vStart) && Number.isFinite(vCur) && vCur !== vStart) {
                        // Rigid move only: the span is locked by construction so a
                        // plot drag can never rescale — Y scaling happens solely
                        // on the price-axis gutter (wheel/drag there).
                        if (currentPriceScale === 'log') {
                            const ratio = Math.max(1e-12, vStart) / Math.max(1e-12, vCur);
                            const spanRatio = startYRange.max / startYRange.min;
                            if (Number.isFinite(ratio) && ratio > 0 && Number.isFinite(spanRatio) && spanRatio > 0) {
                                const nextMin = startYRange.min * ratio;
                                applyYRange(chart, nextMin, nextMin * spanRatio);
                            }
                        } else {
                            const dy = vStart - vCur;
                            const span = startYRange.max - startYRange.min;
                            if (Number.isFinite(dy) && Number.isFinite(span) && span > 0) {
                                const nextMin = startYRange.min + dy;
                                applyYRange(chart, nextMin, nextMin + span);
                            }
                        }
                    }
                }
                const delta = chart.posToVal(p.clientX - p.rectLeft - p.bboxLeft, 'x') - chart.posToVal(p.startX - p.rectLeft - p.bboxLeft, 'x');
                syncXRange(startMin - delta, startMax - delta);
            };
            const onMove = (e) => {
                if (!dragging) return;
                e.preventDefault();
                const rect = chart.root.getBoundingClientRect();
                pendingPan = {
                    clientX: e.clientX, clientY: e.clientY,
                    startX: startClientX, startY: startClientY,
                    rectLeft: rect.left, rectTop: rect.top,
                    bboxLeft: startBboxLeft, bboxTop: startBboxTop,
                };
                if (!panRaf) panRaf = requestAnimationFrame(applyPendingPan);
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                startYRange = null;
                pendingPan = null;
                if (panRaf) { cancelAnimationFrame(panRaf); panRaf = 0; }
                document.body.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', endDrag);
            };
            chart.root.addEventListener('mousedown', (e) => {
                if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
                const rect = chart.root.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                if (chart === priceChart && inYAxisZone(chart, e.clientX)) return;
                if (inXAxisZone(chart, e.clientY)) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startClientX = e.clientX;
                startClientY = e.clientY;
                const startPxRatio = chart.pxRatio || 1;
                startBboxLeft = chart.bbox ? chart.bbox.left / startPxRatio : 0;
                startBboxTop = chart.bbox ? chart.bbox.top / startPxRatio : 0;
                const s = chart.scales.x || {};
                startMin = Number.isFinite(s.min) ? s.min : currentCandles[0].time;
                startMax = Number.isFinite(s.max) ? s.max : currentCandles[currentCandles.length - 1].time;
                if (chart === priceChart) startYRange = currentYRange(chart);
                document.body.style.cursor = 'grabbing';
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            });
        }
        function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
        // Significant-digit price formatting (4 "active" digits), matching the
        // DEXBot order-price style (formatCurrency).
        // Very small values get SI micro-suffixes (m/µ/n/p/...); large values
        // get comma grouping. Examples: 34.94 -> "34.94", 119.98 -> "120.0",
        // 3014.9 -> "3,015", 0.00567 -> "5.670m".
        function fmtPrice(v) {
            if (v == null || !Number.isFinite(v)) return '-';
            const num = Number(v);
            if (num === 0) return '0';
            const abs = Math.abs(num);
            if (abs < 0.1) {
                if (abs >= 0.001) return fmtPrice(num * 1000) + 'm';
                if (abs >= 0.000001) return fmtPrice(num * 1e6) + 'µ';
                if (abs >= 1e-9) return fmtPrice(num * 1e9) + 'n';
                if (abs >= 1e-12) return fmtPrice(num * 1e12) + 'p';
                if (abs >= 1e-15) return fmtPrice(num * 1e15) + 'f';
                if (abs >= 1e-18) return fmtPrice(num * 1e18) + 'a';
                return num.toFixed(6);
            }
            const digits = 4;
            let intDigits = Math.floor(Math.log10(abs)) + 1;
            if (abs < 1) intDigits = 1;
            const formatted = intDigits >= digits ? String(Math.round(num)) : num.toFixed(digits - intDigits);
            return intDigits >= 4 ? formatted.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : formatted;
        }
        function fmtPriceAxis(vals) {
            if (!Array.isArray(vals) || vals.length === 0) return [];
            return vals.map((v) => (v == null || !Number.isFinite(v)) ? '' : fmtPrice(v));
        }
        function fmtPriceLabel(v) {
            if (v == null || !Number.isFinite(v)) return '-';
            return fmtPrice(v);
        }
        function logAxisSplits(self, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace) {
            if (!Number.isFinite(scaleMin) || !Number.isFinite(scaleMax) || scaleMin <= 0 || scaleMax <= 0) return [];
            let h = 600;
            if (self && self.bbox && Number.isFinite(self.bbox.height)) h = self.bbox.height / (self.pxRatio || 1);
            else if (self && self.over && self.over.clientHeight) h = self.over.clientHeight;
            const target = Math.max(8, Math.min(16, Math.floor(h / 30)));
            const lmin = Math.log10(scaleMin);
            const lmax = Math.log10(scaleMax);
            const out = [];
            for (let i = 0; i <= target; i++) {
                out.push(Math.pow(10, lmin + (lmax - lmin) * (i / target)));
            }
            return out;
        }
        // Significant-digit volume formatting (4 "active" digits) with K/M/B/T
        // suffixes, matching the price-axis style. Examples: 1234567 -> "1235K",
        // 1234567890 -> "1.235B".
        function fmtVolume(v) {
            if (v == null || !Number.isFinite(v)) return '-';
            const num = Number(v);
            if (num === 0) return '0';
            const abs = Math.abs(num);
            const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
            for (const [factor, suffix] of units) {
                if (abs >= factor) {
                    const scaled = num / factor;
                    const a = Math.abs(scaled);
                    let intDigits = Math.floor(Math.log10(a)) + 1;
                    if (a < 1) intDigits = 1;
                    const digits = 4;
                    const formatted = intDigits >= digits ? String(Math.round(scaled)) : scaled.toFixed(digits - intDigits);
                    return formatted + suffix;
                }
            }
            let intDigits = Math.floor(Math.log10(abs)) + 1;
            if (abs < 1) intDigits = 1;
            const digits = 4;
            return intDigits >= digits ? String(Math.round(num)) : num.toFixed(digits - intDigits);
        }
        function candleDirection(open, close) {
            if (close > open) return 'up';
            if (close < open) return 'down';
            return 'flat';
        }
        function fmtTime(ts) {
            if (!Number.isFinite(ts)) return '-';
            const d = new Date(ts * 1000);
            return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
        function pad2(n) {
            return String(n).padStart(2, '0');
        }
        function formatTimeLabel(tsSec, spanSec) {
            const d = new Date(tsSec * 1000);
            if (!Number.isFinite(spanSec)) spanSec = 0;
            if (spanSec >= 365 * 24 * 3600 * 2) {
                return String(d.getUTCFullYear());
            }
            if (spanSec >= 90 * 24 * 3600) {
                return d.toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
            }
            if (spanSec >= 14 * 24 * 3600) {
                return d.toLocaleString(undefined, { month: 'short', day: '2-digit', timeZone: 'UTC' });
            }
            return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
        }
        function makeTimeAxis(showLabels) {
            return {
                show: true,
                size: showLabels ? 24 : 14,
                stroke: '#ffffff',
                grid: { stroke: '#1c2128' },
                ticks: { stroke: '#30363d', width: 1 },
                font: '11px Segoe UI, sans-serif',
                values: showLabels ? (u, vals) => {
                    if (String(currentTimeframe) === '1M') {
                        return vals.map((ts) => new Date(ts * 1000).toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }));
                    }
                    const xScale = u.scales.x || {};
                    const spanSec = Number.isFinite(xScale.min) && Number.isFinite(xScale.max)
                        ? Math.max(0, xScale.max - xScale.min)
                        : 0;
                    return vals.map((ts) => formatTimeLabel(ts, spanSec));
                } : () => [],
            };
        }
        function loadState() {
            try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; }
        }
        function saveState() {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    timeframe: currentTimeframe,
                    smaEnabled: currentSmaEnabled,
                    smaPeriod: currentSmaPeriod,
                    amaEnabled: currentAmaEnabled,
                    amaErPeriod: currentAmaErPeriod,
                    amaFastPeriod: currentAmaFastPeriod,
                    amaSlowPeriod: currentAmaSlowPeriod,
                    vwapEnabled: currentVwapEnabled,
                    vwapBars: currentVwapBars,
                    rangeEnabled: currentRangeEnabled,
                    rangeScaleEnabled: currentRangeScaleEnabled,
                    rangeWidthPct: currentRangeWidthPct,
                    rangeSpan: currentRangeSpan,
                    ordersVisible: currentOrdersVisible,
                    volumeVisible: currentVolumeVisible,
                    volumeMode: currentVolumeMode,
                    amaInitOffset: currentAmaInitOffset,
                    priceScale: currentPriceScale,
                    pairMode: currentPairMode,
                }));
            } catch (e) {}
        }
        function normalizePairMode(mode) {
            return String(mode).toLowerCase() === 'inverse' ? 'inverse' : 'normal';
        }
        function getPairLabel(mode = currentPairMode) {
            return normalizePairMode(mode) === 'inverse'
                ? (payload.pairLabelInverse || (payload.assetLabelB + '/' + payload.assetLabelA))
                : (payload.pairLabelNormal || (payload.assetLabelA + '/' + payload.assetLabelB));
        }
        // Volume units: base = displayed pair's base asset (TradingView
        // standard, VWMA-correct), quote = base * display close (per-candle
        // approximation of true quote volume). Persisted per chart in
        // localStorage like the AMA settings (volumeMode).
        function getVolumeSymbols() {
            const inverse = normalizePairMode(currentPairMode) === 'inverse';
            return {
                base: inverse ? payload.assetLabelB : payload.assetLabelA,
                quote: inverse ? payload.assetLabelA : payload.assetLabelB,
            };
        }
        function getVolumeUnit() {
            if (payload.volumeIsCount) return { mode: 'count', symbol: 'feeds' };
            const syms = getVolumeSymbols();
            return currentVolumeMode === 'quote'
                ? { mode: 'quote', symbol: syms.quote }
                : { mode: 'base', symbol: syms.base };
        }
        function getDisplayVolume(c) {
            const v = Number(c?.volume);
            if (!Number.isFinite(v)) return NaN;
            if (payload.volumeIsCount) return v;
            if (currentVolumeMode === 'quote') {
                const p = Number(c?.close);
                return Number.isFinite(p) && p > 0 ? v * p : NaN;
            }
            return v;
        }
        function fmtVolumeWithSym(v) {
            const s = fmtVolume(v);
            if (s == null || s === '-') return '-';
            const u = getVolumeUnit();
            return u.symbol ? s + ' ' + u.symbol : s;
        }
        function setActiveVolumeUnit() {
            const btn = document.getElementById('volume-unit-toggle');
            if (!btn) return;
            const u = getVolumeUnit();
            btn.dataset.volumeMode = u.mode;
            btn.textContent = u.symbol || u.mode;
            btn.title = payload.volumeIsCount
                ? 'Volume: feed publish count per bucket'
                : (u.mode === 'quote'
                    ? 'Volume units: quote asset (' + u.symbol + ') — click for base asset'
                    : 'Volume units: base asset (' + u.symbol + ') — click for quote asset');
            btn.disabled = !!payload.volumeIsCount;
            btn.style.opacity = payload.volumeIsCount ? '0.45' : '';
            btn.style.cursor = payload.volumeIsCount ? 'not-allowed' : 'pointer';
            const lv = document.getElementById('legend-volume');
            if (lv) {
                lv.style.cursor = payload.volumeIsCount ? 'default' : 'pointer';
                lv.title = payload.volumeIsCount
                    ? 'Volume: feed publish count per bucket'
                    : 'Volume units — click to switch base/quote';
            }
            const vp = document.getElementById('vol-panel');
            if (vp) {
                vp.style.cursor = payload.volumeIsCount ? 'default' : 'pointer';
                vp.title = payload.volumeIsCount
                    ? 'Volume: feed publish count per bucket'
                    : 'Volume units — click to switch base/quote';
            }
        }
        function toggleVolumeUnit() {
            if (payload.volumeIsCount) return;
            currentVolumeMode = currentVolumeMode === 'quote' ? 'base' : 'quote';
            setActiveVolumeUnit();
            rerender(true);
        }
        function refreshSubtitle() {
            const subtitleEl = document.getElementById('subtitle');
            if (!subtitleEl) return;
            subtitleEl.textContent = payload.poolLabel + ' · ' + getPairLabel() + ' · ' + payload.intervalLabel + ' base · indicators from 1h · volume · uPlot';
        }
        function snapInitOffset(value) {
            const next = Math.round(Number(value) || 0);
            return Math.abs(next) <= 2 ? 0 : next;
        }
        function setActivePairMode(mode) {
            const label = normalizePairMode(mode);
            const btn = document.getElementById('pair-toggle');
            if (!btn) return;
            btn.dataset.pairMode = label;
            btn.classList.toggle('is-inverse', label === 'inverse');
            btn.title = label === 'inverse' ? 'Swap to A/B' : 'Swap to B/A';
            btn.setAttribute('aria-label', label === 'inverse' ? 'Swap to A/B' : 'Swap to B/A');
        }
        function invertCandle(candle) {
            const open = Number(candle?.open);
            const high = Number(candle?.high);
            const low = Number(candle?.low);
            const close = Number(candle?.close);
            if (![open, high, low, close].every(Number.isFinite) || open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
            const volume = Number(candle?.volume);
            return {
                time: candle.time,
                open: 1 / open,
                high: 1 / low,
                low: 1 / high,
                close: 1 / close,
                // Convert base-asset volume into the inverse pair's base units approximately.
                volume: Number.isFinite(volume) ? volume * close : 0,
            };
        }
        function getSeriesState(mode = currentPairMode) {
            const key = normalizePairMode(mode);
            if (seriesCache.has(key)) return seriesCache.get(key);
            const candles = key === 'inverse'
                ? baseCandles.map(invertCandle).filter(Boolean)
                : baseCandles.slice();
            const state = {
                candles,
                closeValues: candles.map((c) => c.close),
            };
            seriesCache.set(key, state);
            return state;
        }
        function aggregateCandles(rows, seconds, label) {
            const monthly = String(label || '') === '1M';
            const bucketSec = Math.max(1, Math.round(seconds || 3600));
            const cacheKey = currentPairMode + '|' + (monthly ? '1M' : String(bucketSec));
            if (aggregateCache.has(cacheKey)) return aggregateCache.get(cacheKey);
            const out = [];
            const idxs = [];
            let cur = null;
            let curBucket = null;
            let curIdx = -1;
            const finishBucket = (bucket) => {
                if (!bucket) return;
                // Feed volume is a publication rate, not trade quantity. Keep
                // it comparable across 1h/week/month views instead of turning
                // a monthly candle into a sum such as 388 publishes.
                if (payload.volumeIsCount && bucket.barCount > 0) {
                    bucket.volume /= bucket.barCount;
                }
                delete bucket.barCount;
                out.push(bucket);
            };
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const ts = Number(row.time);
                if (!Number.isFinite(ts)) continue;
                let bucket;
                if (monthly) {
                    const d = new Date(ts * 1000);
                    bucket = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
                } else {
                    bucket = Math.floor(ts / bucketSec) * bucketSec;
                }
                if (!cur || bucket !== curBucket) {
                    if (cur) {
                        finishBucket(cur);
                        idxs.push(curIdx);
                    }
                    curBucket = bucket;
                    curIdx = i;
                    cur = {
                        time: bucket,
                        open: row.open,
                        high: row.high,
                        low: row.low,
                        close: row.close,
                        volume: row.volume || 0,
                        barCount: 1,
                    };
                } else {
                    cur.high = Math.max(cur.high, row.high);
                    cur.low = Math.min(cur.low, row.low);
                    cur.close = row.close;
                    cur.volume += row.volume || 0;
                    cur.barCount += 1;
                    curIdx = i;
                }
            }
            if (cur) {
                finishBucket(cur);
                idxs.push(curIdx);
            }
            const result = { candles: out, idxs };
            aggregateCache.set(cacheKey, result);
            return result;
        }
        function sampleSeriesByIndex(series, idxs) {
            if (!Array.isArray(series) || !Array.isArray(idxs)) return [];
            return idxs.map((idx) => (Number.isFinite(idx) && series[idx] != null ? series[idx] : null));
        }
        function deriveDisplayCandles(candles) {
            if (!Array.isArray(candles) || candles.length === 0) return [];
            return candles.map((c, i) => {
                const prevClose = i > 0 ? candles[i - 1].close : c.close;
                const open = Number.isFinite(prevClose) ? prevClose : c.close;
                const close = c.close;
                return {
                    time: c.time,
                    open,
                    close,
                    volume: c.volume,
                };
            });
        }
        function computeSMA(candles, period) {
            const safePeriod = Math.max(1, Math.round(period));
            const cacheKey = currentPairMode + '|' + safePeriod + '|' + candles.length;
            if (smaCache.has(cacheKey)) return smaCache.get(cacheKey);
            const out = [];
            let sum = 0;
            const window = new Array(safePeriod);
            let head = 0;
            let count = 0;
            for (const candle of candles) {
                const price = candle.close;
                if (count < safePeriod) {
                    window[count] = price;
                    sum += price;
                    count++;
                    out.push(count === safePeriod ? (sum / safePeriod) : null);
                    continue;
                }
                sum -= window[head];
                window[head] = price;
                sum += price;
                head = (head + 1) % safePeriod;
                out.push(sum / safePeriod);
            }
            smaCache.set(cacheKey, out);
            return out;
        }
        function getSmaCacheKey(period) {
            return currentPairMode + '|' + Math.max(1, Math.round(period)) + '|' + currentSeriesCloseValues.length;
        }
        function createSMAWorker() {
            if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return null;
            const workerSource = [
                'self.onmessage = function(e) {',
                '  const data = e.data || {};',
                '  const id = data.id;',
                '  const key = data.key;',
                '  const closes = Array.isArray(data.closes) ? data.closes : [];',
                '  const period = Math.max(1, Math.round(Number(data.period) || 1));',
                '  const out = new Array(closes.length);',
                '  const window = new Array(period);',
                '  let sum = 0;',
                '  let head = 0;',
                '  let count = 0;',
                '  for (let i = 0; i < closes.length; i++) {',
                '    const price = Number(closes[i]);',
                '    if (count < period) {',
                '      window[count] = price;',
                '      sum += price;',
                '      count++;',
                '      out[i] = count === period ? (sum / period) : null;',
                '      continue;',
                '    }',
                '    sum -= window[head];',
                '    window[head] = price;',
                '    sum += price;',
                '    head = (head + 1) % period;',
                '    out[i] = sum / period;',
                '  }',
                '  self.postMessage({ id, key, series: out });',
                '};',
            ].join('\\n');
            const blob = new Blob([workerSource], { type: 'text/javascript' });
            const worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = (e) => {
                const msg = e && e.data ? e.data : {};
                if (!smaWorkerJob || msg.id !== smaWorkerJob.id || msg.key !== smaWorkerJob.key) return;
                smaCache.set(msg.key, Array.isArray(msg.series) ? msg.series : []);
                smaWorkerJob = null;
                if (currentSmaEnabled && msg.key === getSmaCacheKey(currentSmaPeriod)) {
                    rerender(false);
                }
            };
            worker.onerror = () => {
                try { worker.terminate(); } catch (e) {}
                smaWorker = null;
                smaWorkerJob = null;
            };
            return worker;
        }
        function clearSMAWorker() {
            if (smaWorkerStartRaf) {
                cancelAnimationFrame(smaWorkerStartRaf);
                smaWorkerStartRaf = 0;
            }
            if (smaWorkerPaintRaf) {
                cancelAnimationFrame(smaWorkerPaintRaf);
                smaWorkerPaintRaf = 0;
            }
            if (!smaWorker) return;
            try { smaWorker.terminate(); } catch (e) {}
            smaWorker = null;
            smaWorkerJob = null;
        }
        function requestSMA(period) {
            const safePeriod = Math.max(1, Math.round(period));
            const key = getSmaCacheKey(safePeriod);
            if (smaCache.has(key)) return;
            if (smaWorkerJob && smaWorkerJob.key === key) return;
            if (smaWorkerJob && smaWorkerJob.key !== key) clearSMAWorker();
            if (!smaWorker) smaWorker = createSMAWorker();
            if (!smaWorker) {
                smaCache.set(key, computeSMA(currentSeriesCandles, safePeriod));
                if (currentSmaEnabled && key === getSmaCacheKey(currentSmaPeriod)) rerender(false);
                return;
            }
            smaWorkerJob = { id: ++smaWorkerSeq, key };
            if (smaWorkerStartRaf) cancelAnimationFrame(smaWorkerStartRaf);
            if (smaWorkerPaintRaf) cancelAnimationFrame(smaWorkerPaintRaf);
            smaWorkerStartRaf = requestAnimationFrame(() => {
                smaWorkerStartRaf = 0;
                smaWorkerPaintRaf = requestAnimationFrame(() => {
                    smaWorkerPaintRaf = 0;
                    if (!smaWorker || !smaWorkerJob || smaWorkerJob.key !== key || !currentSmaEnabled) return;
                    smaWorker.postMessage({
                        id: smaWorkerJob.id,
                        key,
                        period: safePeriod,
                        closes: currentSeriesCloseValues,
                    });
                });
            });
        }
        function currentAmaConfig() {
            return {
                erPeriod: Math.max(1, Math.round(currentAmaErPeriod)),
                fastPeriod: Math.max(0.1, Number(currentAmaFastPeriod) || 0.1),
                slowPeriod: Math.max(0.1, Number(currentAmaSlowPeriod) || 0.1),
            };
        }
        function computeAMA(candles, cfg, initOffset = 0) {
            const params = cfg || currentAmaConfig();
            const erPeriod = Math.max(1, Math.round(params.erPeriod ?? 10));
            const fastPeriod = Math.max(0.1, Number(params.fastPeriod ?? 2));
            const slowPeriod = Math.max(0.1, Number(params.slowPeriod ?? 30));
            const cacheKey = currentPairMode + '|' + erPeriod + '|' + fastPeriod + '|' + slowPeriod + '|' + candles.length + '|' + initOffset;
            if (amaCache.has(cacheKey)) return amaCache.get(cacheKey);
            const fastSC = 2 / (fastPeriod + 1);
            const slowSC = 2 / (slowPeriod + 1);
            const out = [];
            const windowSize = erPeriod + 1;
            const history = new Array(windowSize);
            let head = 0;
            let len = 0;
            let volatility = 0;
            let prev = null;
            let smaSum = 0;
            for (const candle of candles) {
                const price = candle.close;
                if (len < windowSize) {
                    history[(head + len) % windowSize] = price;
                    smaSum += price;
                    if (len > 0) {
                        volatility += Math.abs(price - history[(head + len - 1) % windowSize]);
                    }
                    len++;
                    if (len < windowSize) {
                        out.push(null);
                        continue;
                    }
                    prev = initOffset !== 0 ? (smaSum / windowSize) * (1 + initOffset / 100) : smaSum / windowSize;
                    out.push(prev);
                    continue;
                }
                const oldest = history[head];
                const second = history[(head + 1) % windowSize];
                const last = history[(head + windowSize - 1) % windowSize];
                volatility += Math.abs(price - last) - Math.abs(second - oldest);
                history[head] = price;
                head = (head + 1) % windowSize;
                const first = history[head];
                const direction = Math.abs(price - first);
                const er = volatility === 0 ? 0 : (direction / volatility);
                const smoothing = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
                const ama = prev + smoothing * (price - prev);
                prev = ama;
                out.push(ama);
            }
            amaCache.set(cacheKey, out);
            return out;
        }
        function computeVWMA(candles, bars) {
            const safeBars = Math.max(1, Math.round(bars || 500));
            const cacheKey = currentPairMode + '|' + safeBars + '|' + candles.length;
            if (vwapCache.has(cacheKey)) return vwapCache.get(cacheKey);
            const out = [];
            let cumPV = 0;
            let cumVol = 0;
            const window = new Array(safeBars);
            let head = 0;
            let count = 0;
            for (const candle of candles) {
                const typical = (candle.high + candle.low + candle.close) / 3;
                const volume = Number.isFinite(candle.volume) ? candle.volume : 0;
                cumPV += typical * volume;
                cumVol += volume;
                if (count < safeBars) {
                    window[count] = { typical, volume };
                    count++;
                } else {
                    const old = window[head];
                    cumPV -= old.typical * old.volume;
                    cumVol -= old.volume;
                    window[head] = { typical, volume };
                    head = (head + 1) % safeBars;
                }
                out.push(cumVol > 0 ? (cumPV / cumVol) : null);
            }
            vwapCache.set(cacheKey, out);
            return out;
        }
        // Bot-grid range band: min/max derive ONLY from the live AMA price.
        // All math below runs the canonical market_adapter/grid sources,
        // embedded verbatim (not hand-copied): computeAverageAmaSlopePct,
        // computeAmaSlopeClipThreshold, applyAsymmetricBounds (+ metrics/base),
        // applyNarrowingSideGuard, parseRelativeMultiplier. With Range Scaling
        // on, the clipped AMA slope tilts the span-symmetric band like the
        // grid build: trend side widens, opposite side tightens. Painted
        // red [AMA, upper], green [lower, AMA].
        // Never reads candles, pair-display mapping, or axis/zoom state —
        // inversion and timeframe sampling apply to the AMA first.
        ${embedFunctionSources([computeAverageAmaSlopePct, computeAmaSlopeClipThreshold, resolveBaseBounds, computeAsymmetricBoundsMetrics, applyAsymmetricBounds, applyNarrowingSideGuard, parseRelativeMultiplier])}
        function computeRangeBand(baseAma) {
            const n = Array.isArray(baseAma) ? baseAma.length : 0;
            const upper = new Array(n).fill(null);
            const lower = new Array(n).fill(null);
            const trend = new Array(n).fill(0);
            const slopeCfg = payload.rangeSlope || {};
            const gridCfg = payload.grid || null;
            const lookback = Math.max(1, Math.round(Number(slopeCfg.lookbackBars) || 9));
            const maxSlope = Number(slopeCfg.maxSlopePct) > 0 ? Number(slopeCfg.maxSlopePct) : 0.09;
            const neutral = Number(slopeCfg.neutralZonePct) >= 0 ? Number(slopeCfg.neutralZonePct) : 0;
            const maxSlopeOffset = Number(slopeCfg.maxSlopeOffset) > 0 ? Number(slopeCfg.maxSlopeOffset) : 0.5;
            const maxAsym = gridCfg && Number(gridCfg.maxAsymmetryFactor) > 0
                ? Number(gridCfg.maxAsymmetryFactor)
                : (Number(slopeCfg.maxAsymmetryFactor) > 0 ? Number(slopeCfg.maxAsymmetryFactor) : 0.35);
            const inc = gridCfg && Number(gridCfg.incrementPercent) > 0 ? Number(gridCfg.incrementPercent) : null;
            const minSlots = Math.floor(Number(gridCfg && gridCfg.minScaleSlots) > 0 ? Number(gridCfg.minScaleSlots) : (Number(slopeCfg.minScaleSlots) || 0));
            // User x-range span (slider 1.2x–2.0x, default 1.55x): the only
            // width input — symmetric base min = AMA/span, max = AMA*span.
            const span = Math.min(2, Math.max(1.2, Number(currentRangeSpan) > 0 ? Number(currentRangeSpan) : 1.55));
            // Canonical grid pipeline (ama_slope_model): adaptive percentile
            // clip over the AMA history, then offset + trend — the same numbers
            // the live grid build feeds into applyAsymmetricBounds.
            const clipPct = Number(slopeCfg.clipPercentile) >= 0 ? Number(slopeCfg.clipPercentile) : 10;
            const clipEr = Number.isFinite(currentAmaErPeriod) && currentAmaErPeriod > 0
                ? Math.ceil(currentAmaErPeriod)
                : Math.ceil(Number(payload.amaDefaults?.erPeriod) || 781);
            const clipThreshold = computeAmaSlopeClipThreshold(baseAma, clipEr, lookback, clipPct);
            const slopeScaling = !!currentRangeScaleEnabled;
            if (!currentAmaEnabled || n === 0) return { upper, lower, trend };
            for (let i = 0; i < n; i++) {
                const ama = baseAma[i];
                const past = i - lookback >= 0 ? baseAma[i - lookback] : null;
                if (!Number.isFinite(ama) || ama <= 0 || !Number.isFinite(past) || past <= 0) continue;
                const slopePct = computeAverageAmaSlopePct(ama, past, lookback);
                if (slopePct == null || !Number.isFinite(slopePct)) continue;
                const csp = Math.max(-clipThreshold, Math.min(clipThreshold, slopePct));
                const dir = Math.abs(csp) <= neutral ? 0 : (csp > 0 ? 1 : -1);
                // Symmetric base from this bar's AMA and the user span —
                // no chart or config price level.
                let rMin = ama / span;
                let rMax = ama * span;
                if (slopeScaling && dir !== 0) {
                    // Canonical tilt: clipped slope offset applied through
                    // asymmetric_bounds, then the narrowing-side guard.
                    const trendName = dir > 0 ? 'UP' : 'DOWN';
                    const slopeOffset = clamp(csp / maxSlope, -1, 1) * maxSlopeOffset;
                    const tilt = applyAsymmetricBounds({
                        centerPrice: ama,
                        minPrice: ama / span,
                        maxPrice: ama * span,
                        trend: trendName,
                        slopeOffset,
                        maxSlopeOffset,
                        maxAsymmetryFactor: maxAsym,
                    });
                    const guard = applyNarrowingSideGuard({
                        centerPrice: ama,
                        minPrice: tilt.resolvedMinPrice,
                        maxPrice: tilt.resolvedMaxPrice,
                        trend: trendName,
                        incrementPercent: inc,
                        minScaleSlots: minSlots,
                    });
                    rMin = guard.minPrice;
                    rMax = guard.maxPrice;
                }
                if (!Number.isFinite(rMin) || !Number.isFinite(rMax) || rMin <= 0 || rMax <= rMin) continue;
                upper[i] = rMax;
                lower[i] = rMin;
                trend[i] = dir;
            }
            return { upper, lower, trend };
        }
        function lowerBound(arr, value) {
            let lo = 0;
            let hi = arr.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (arr[mid] < value) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }
        function visiblePriceRange(u) {
            if (!currentCandles.length) return null;
            const xs = u.data[0];
            const xScale = u.scales.x || {};
            const minX = Number.isFinite(xScale.min) ? xScale.min : xs[0];
            const maxX = Number.isFinite(xScale.max) ? xScale.max : xs[xs.length - 1];
            let start = Math.max(0, lowerBound(xs, minX) - 1);
            let end = Math.min(xs.length, lowerBound(xs, maxX) + 2);
            let min = Infinity;
            let max = -Infinity;
            // Range scaling active: fit the price axis to the full envelope
            // (lower ↔ upper through AMA) instead of the candles, so the
            // switch visibly adjusts the range. Falls through to the candle
            // fit when the band has no finite values in view.
            if (currentRangeEnabled && currentRangeScaleEnabled && currentAmaEnabled) {
                let bmin = Infinity;
                let bmax = -Infinity;
                for (let i = start; i < end; i++) {
                    const a = currentAma[i];
                    const up = currentRangeUpper[i];
                    const lo = currentRangeLower[i];
                    if (Number.isFinite(a) && a > 0) { if (a < bmin) bmin = a; if (a > bmax) bmax = a; }
                    if (Number.isFinite(up) && up > 0) { if (up < bmin) bmin = up; if (up > bmax) bmax = up; }
                    if (Number.isFinite(lo) && lo > 0) { if (lo < bmin) bmin = lo; if (lo > bmax) bmax = lo; }
                }
                if (Number.isFinite(bmin) && Number.isFinite(bmax) && bmin > 0 && bmax > bmin) {
                    return [bmin * 0.97, bmax * 1.03];
                }
            }
            for (let i = start; i < end; i++) {
                const lo = currentLow[i];
                const hi = currentHigh[i];
                if (Number.isFinite(lo) && lo > 0 && lo < min) min = lo;
                if (Number.isFinite(hi) && hi > max) max = hi;
                const s = currentSma[i];
                const a = currentAma[i];
                const v = currentVwap[i];
                if (Number.isFinite(s)) { if (s < min) min = s; if (s > max) max = s; }
                if (Number.isFinite(a)) { if (a < min) min = a; if (a > max) max = a; }
                if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
            }
            if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;
            if (min === max) return [min * 0.96, max * 1.04];
            // ~7 % hengitystilaa yla- ja alapuolelle (TradingView-tyyli)
            return [min * 0.93, max * 1.07];
        }
        function visibleVolumeRange(u) {
            if (!currentCandles.length) return null;
            const xs = u.data[0];
            const xScale = u.scales.x || {};
            const minX = Number.isFinite(xScale.min) ? xScale.min : xs[0];
            const maxX = Number.isFinite(xScale.max) ? xScale.max : xs[xs.length - 1];
            let start = Math.max(0, lowerBound(xs, minX) - 1);
            let end = Math.min(xs.length, lowerBound(xs, maxX) + 2);
            let max = 0;
            for (let i = start; i < end; i++) {
                const v = getDisplayVolume(currentCandles[i]);
                if (Number.isFinite(v) && v > max) max = v;
            }
            if (!Number.isFinite(max) || max <= 0) return [0, 1];
            return [0, max * 1.15];
        }
        function setActiveTimeframe(label) {
            document.querySelectorAll('.time-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.timeframe === label));
        }
        function setActivePriceScale(label) {
            const btn = document.getElementById('scale-toggle');
            if (!btn) return;
            const next = label === 'linear' ? 'linear' : 'log';
            btn.dataset.scale = next;
            btn.classList.toggle('is-linear', next === 'linear');
            btn.textContent = next === 'linear' ? 'Linear' : 'Log';
            btn.title = next === 'linear' ? 'Toggle to log scale' : 'Toggle to linear scale';
            btn.setAttribute('aria-label', next === 'linear' ? 'Toggle to log scale' : 'Toggle to linear scale');
        }
        // AMA presets for the quick buttons (values from constants.ts AMAS).
        const AMA_PRESETS = {
            AMA1: { erPeriod: ${MARKET_ADAPTER.AMAS.AMA1.erPeriod}, fastPeriod: ${MARKET_ADAPTER.AMAS.AMA1.fastPeriod}, slowPeriod: ${MARKET_ADAPTER.AMAS.AMA1.slowPeriod} },
            AMA2: { erPeriod: ${MARKET_ADAPTER.AMAS.AMA2.erPeriod}, fastPeriod: ${MARKET_ADAPTER.AMAS.AMA2.fastPeriod}, slowPeriod: ${MARKET_ADAPTER.AMAS.AMA2.slowPeriod} },
            AMA3: { erPeriod: ${MARKET_ADAPTER.AMAS.AMA3.erPeriod}, fastPeriod: ${MARKET_ADAPTER.AMAS.AMA3.fastPeriod}, slowPeriod: ${MARKET_ADAPTER.AMAS.AMA3.slowPeriod} },
            AMA4: { erPeriod: ${MARKET_ADAPTER.AMAS.AMA4.erPeriod}, fastPeriod: ${MARKET_ADAPTER.AMAS.AMA4.fastPeriod}, slowPeriod: ${MARKET_ADAPTER.AMAS.AMA4.slowPeriod} },
        };
        function markActiveAmaPreset() {
            const cur = { e: Math.round(Number(currentAmaErPeriod)), f: Number(currentAmaFastPeriod), s: Number(currentAmaSlowPeriod) };
            document.querySelectorAll('.ama-preset-btn').forEach((b) => {
                const p = AMA_PRESETS[b.dataset.amaPreset];
                const match = p && Math.round(p.erPeriod) === cur.e && Number(p.fastPeriod) === cur.f && Number(p.slowPeriod) === cur.s;
                b.classList.toggle('active', !!match);
            });
        }
        function applyAmaPreset(key) {
            const p = AMA_PRESETS[key];
            if (!p) return;
            document.getElementById('ama-er').value = String(p.erPeriod);
            document.getElementById('ama-fast').value = String(p.fastPeriod);
            document.getElementById('ama-slow').value = String(p.slowPeriod);
            document.getElementById('ama-toggle').checked = true;
            syncInputs();
        }
        function setIndicatorSeriesVisible(seriesIndex, visible) {
            if (!priceChart) return;
            priceChart.setSeries(seriesIndex, { show: visible }, false, false);
        }
        function syncIndicatorSeriesVisibility() {
            if (!priceChart) return;
            setIndicatorSeriesVisible(5, currentSmaEnabled);
            setIndicatorSeriesVisible(6, currentAmaEnabled);
            setIndicatorSeriesVisible(7, currentVwapEnabled);
            setIndicatorSeriesVisible(8, currentAmaEnabled);
            setIndicatorSeriesVisible(9, currentAmaEnabled && currentAmaInitOffset !== 0);
            setIndicatorSeriesVisible(10, currentAmaEnabled && currentAmaInitOffset !== 0);
        }
        function hideSmaSeriesImmediate() {
            clearSMAWorker();
            currentSma = new Array(currentCandles.length).fill(null);
            if (Array.isArray(currentPriceData) && currentPriceData.length >= 11) {
                currentPriceData[5] = currentSma;
            }
            setIndicatorSeriesVisible(5, false);
            refreshLegend();
            saveState();
        }
        function hideRangeBandImmediate() {
            currentRangeUpper = new Array(currentCandles.length).fill(null);
            currentRangeLower = new Array(currentCandles.length).fill(null);
            // The band is a draw hook with no uPlot series: nothing else
            // repaints on hide, so redraw explicitly (stale pixels otherwise linger).
            if (priceChart && typeof priceChart.redraw === 'function') priceChart.redraw();
            refreshLegend();
            saveState();
        }
        function hideAmaSeriesImmediate() {
            currentAma = new Array(currentCandles.length).fill(null);
            currentAmaOff = new Array(currentCandles.length).fill(null);
            currentSmaInit = new Array(currentCandles.length).fill(null);
            currentSmaInitOff = new Array(currentCandles.length).fill(null);
            currentRangeUpper = new Array(currentCandles.length).fill(null);
            currentRangeLower = new Array(currentCandles.length).fill(null);
            if (Array.isArray(currentPriceData) && currentPriceData.length >= 11) {
                currentPriceData[6] = currentAma;
                currentPriceData[8] = currentSmaInit;
                currentPriceData[9] = currentSmaInitOff;
                currentPriceData[10] = currentAmaOff;
            }
            setIndicatorSeriesVisible(6, false);
            setIndicatorSeriesVisible(8, false);
            setIndicatorSeriesVisible(9, false);
            setIndicatorSeriesVisible(10, false);
            refreshLegend();
            saveState();
        }
        function hideVwapSeriesImmediate() {
            currentVwap = new Array(currentCandles.length).fill(null);
            if (Array.isArray(currentPriceData) && currentPriceData.length >= 11) {
                currentPriceData[7] = currentVwap;
            }
            setIndicatorSeriesVisible(7, false);
            refreshLegend();
            saveState();
        }
        function updateLegend(idx) {
            const c = currentCandles[idx];
            if (!c) return;
            const smaKey = getSmaCacheKey(currentSmaPeriod);
            const smaPending = currentSmaEnabled && smaWorkerJob && smaWorkerJob.key === smaKey && !smaCache.has(smaKey);
            document.getElementById('legend-time').textContent = fmtTime(c.time);
            document.getElementById('legend-close').textContent = fmtPrice(c.close);
            const delta = Number.isFinite(c.open) && Number.isFinite(c.close) ? (c.close - c.open) : null;
            document.getElementById('legend-delta').textContent = Number.isFinite(delta)
                ? ((delta >= 0 ? '+' : '') + fmtPrice(delta))
                : '-';
            document.getElementById('legend-volume').textContent = fmtVolumeWithSym(getDisplayVolume(c));
            document.getElementById('legend-sma').textContent = Number.isFinite(currentSma[idx]) ? fmtPrice(currentSma[idx]) : (smaPending ? '...' : '-');
            document.getElementById('legend-vwap').textContent = Number.isFinite(currentVwap[idx]) ? fmtPrice(currentVwap[idx]) : '-';
            document.getElementById('legend-sma-init').textContent = Number.isFinite(currentSmaInit[idx]) ? fmtPrice(currentSmaInit[idx]) : '-';
            document.getElementById('legend-ama').textContent = Number.isFinite(currentAma[idx]) ? fmtPrice(currentAma[idx]) : '-';
        }
        function candlePlugin() {
            function drawCandles(u) {
                u.ctx.save();

                const offset = 0.5;
                u.ctx.translate(offset, offset);

                const [iMin, iMax] = u.series[0].idxs;

                for (let i = iMin; i <= iMax; i++) {
                    const xVal = u.scales.x.distr == 2 ? i : u.data[0][i];
                    const open = u.data[1][i];
                    const high = u.data[2][i];
                    const low = u.data[3][i];
                    const close = u.data[4][i];

                    const x = u.valToPos(xVal, 'x', true);
                    const openY = u.valToPos(open, 'y', true);
                    const highY = u.valToPos(high, 'y', true);
                    const lowY = u.valToPos(low, 'y', true);
                    const closeY = u.valToPos(close, 'y', true);
                    if (![x, openY, highY, lowY, closeY].every(Number.isFinite)) continue;

                    const nextX = i + 1 <= iMax ? u.valToPos(u.scales.x.distr == 2 ? (i + 1) : u.data[0][i + 1], 'x', true) : null;
                    const prevX = i - 1 >= iMin ? u.valToPos(u.scales.x.distr == 2 ? (i - 1) : u.data[0][i - 1], 'x', true) : null;
                    const spacing = Number.isFinite(nextX) ? (nextX - x) : (Number.isFinite(prevX) ? (x - prevX) : 12);
                    // Wider bodies read better when zoomed in and reduce empty space between candles.
                    const bodyW = Math.max(
                        4,
                        Math.min(
                            Math.abs(spacing) * 0.86,
                            Math.max(18, Math.abs(spacing) * 0.94),
                        ),
                    );
                    const dir = candleDirection(open, close);
                    const bodyColor = dir === 'up' ? '#26a69a' : (dir === 'down' ? '#ef5350' : '#64748b');
                    const wickColor = dir === 'up' ? '#b3fff3' : (dir === 'down' ? '#ffb3b3' : '#94a3b8');
                    const bodyTop = Math.min(openY, closeY);
                    const bodyBottom = Math.max(openY, closeY);
                    const bodyH = Math.max(dir === 'flat' ? 2 : 3, Math.round(bodyBottom - bodyTop));
                    const bodyX = Math.round(x - bodyW / 2);
                    const bodyY = Math.round(bodyTop);

                    const wickW = Math.max(1, Math.min(5, Math.round(Math.abs(spacing) * 0.14)));
                    u.ctx.strokeStyle = wickColor;
                    u.ctx.lineWidth = wickW;
                    u.ctx.beginPath();
                    u.ctx.moveTo(x, highY);
                    u.ctx.lineTo(x, lowY);
                    u.ctx.stroke();

                    u.ctx.fillStyle = bodyColor;
                    u.ctx.fillRect(bodyX, bodyY, Math.round(bodyW), bodyH);
                    if (bodyW > 2 && bodyH > 2) {
                        u.ctx.strokeStyle = dir === 'up' ? '#0f7f77' : (dir === 'down' ? '#a92d35' : '#475569');
                        u.ctx.lineWidth = 1;
                        u.ctx.strokeRect(bodyX + 0.5, bodyY + 0.5, Math.round(bodyW) - 1, bodyH - 1);
                    }
                }

                u.ctx.translate(-offset, -offset);
                u.ctx.restore();
            }

                return {
                    opts: (u, opts) => {
                        uPlot.assign(opts, {
                            cursor: { drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                        });
                    opts.series.forEach((s, i) => {
                        if (i > 0 && i <= 4) {
                            s.paths = () => null;
                            s.points = { show: false };
                            s.stroke = 'transparent';
                        }
                    });
                },
                hooks: { drawAxes: [drawCandles] },
            };
        }
        function volumePlugin() {
            function drawVolumeBars(u) {
                u.ctx.save();

                const offset = 0.5;
                u.ctx.translate(offset, offset);

                const [iMin, iMax] = u.series[0].idxs;
                const xVals = u.data[0];
                const volVals = u.data[1];

                for (let i = iMin; i <= iMax; i++) {
                    const vol = volVals[i];
                    if (!Number.isFinite(vol) || vol <= 0) continue;

                    const xVal = u.scales.x.distr == 2 ? i : xVals[i];
                    const x = u.valToPos(xVal, 'x', true);
                    const top = u.valToPos(vol, 'y', true);
                    const bottom = u.valToPos(0, 'y', true);
                    if (![x, top, bottom].every(Number.isFinite)) continue;

                    const nextX = i + 1 <= iMax ? u.valToPos(u.scales.x.distr == 2 ? (i + 1) : xVals[i + 1], 'x', true) : null;
                    const prevX = i - 1 >= iMin ? u.valToPos(u.scales.x.distr == 2 ? (i - 1) : xVals[i - 1], 'x', true) : null;
                    const spacing = Number.isFinite(nextX) ? (nextX - x) : (Number.isFinite(prevX) ? (x - prevX) : 12);
                    const barW = Math.max(
                        4,
                        Math.min(
                            Math.abs(spacing) * 0.86,
                            Math.max(18, Math.abs(spacing) * 0.94),
                        ),
                    );

                    const left = Math.round(x - barW / 2);
                    const topY = Math.round(Math.min(top, bottom));
                    const h = Math.max(1, Math.round(Math.abs(bottom - top)));

                    u.ctx.fillStyle = '#ffffff';
                    u.ctx.fillRect(left, topY, Math.round(barW), h);
                }

                u.ctx.translate(-offset, -offset);
                u.ctx.restore();
            }

            return {
                opts: (u, opts) => {
                    uPlot.assign(opts, {
                        cursor: { drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                    });
                    opts.series.forEach((s, i) => {
                        if (i === 1) {
                            s.paths = () => null;
                            s.points = { show: false };
                            s.stroke = 'transparent';
                            s.fill = 'transparent';
                        }
                    });
                },
                hooks: { drawAxes: [drawVolumeBars] },
            };
        }
        function rangeBandPlugin() {
            function drawRangeBand(u) {
                if (!currentRangeEnabled || !currentAmaEnabled || !currentCandles.length) return;
                const xs = u.data[0];
                if (!Array.isArray(xs) || xs.length === 0) return;
                u.ctx.save();
                u.ctx.beginPath();
                u.ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
                u.ctx.clip();
                // Behind candles/AMA lines (same trick as the dynamic-weight signal background).
                u.ctx.globalCompositeOperation = 'destination-over';
                const UP_FILL = 'rgba(239,83,80,0.16)';
                const DOWN_FILL = 'rgba(38,166,154,0.16)';
                // Symmetric envelope, always both sides: red [AMA, upper]
                // plus green [lower, AMA] along the whole AMA, tilted by the
                // grid's range scaling. Paint per contiguous valid segment.
                let segTop = [];
                let segBot = [];
                const flush = () => {
                    if (segTop.length > 1) {
                        u.ctx.fillStyle = UP_FILL;
                        u.ctx.beginPath();
                        u.ctx.moveTo(segTop[0][0], segTop[0][1]);
                        for (let k = 1; k < segTop.length; k++) u.ctx.lineTo(segTop[k][0], segTop[k][1]);
                        for (let k = segTop.length - 1; k >= 0; k--) u.ctx.lineTo(segTop[k][0], segTop[k][2]);
                        u.ctx.closePath();
                        u.ctx.fill();
                    }
                    if (segBot.length > 1) {
                        u.ctx.fillStyle = DOWN_FILL;
                        u.ctx.beginPath();
                        u.ctx.moveTo(segBot[0][0], segBot[0][1]);
                        for (let k = 1; k < segBot.length; k++) u.ctx.lineTo(segBot[k][0], segBot[k][1]);
                        for (let k = segBot.length - 1; k >= 0; k--) u.ctx.lineTo(segBot[k][0], segBot[k][2]);
                        u.ctx.closePath();
                        u.ctx.fill();
                    }
                    u.ctx.strokeStyle = 'rgba(239,83,80,0.55)';
                    u.ctx.lineWidth = 1;
                    u.ctx.beginPath();
                    segTop.forEach((p, k) => { if (k === 0) u.ctx.moveTo(p[0], p[1]); else u.ctx.lineTo(p[0], p[1]); });
                    u.ctx.stroke();
                    u.ctx.strokeStyle = 'rgba(38,166,154,0.55)';
                    u.ctx.beginPath();
                    segBot.forEach((p, k) => { if (k === 0) u.ctx.moveTo(p[0], p[1]); else u.ctx.lineTo(p[0], p[1]); });
                    u.ctx.stroke();
                    segTop = [];
                    segBot = [];
                };
                for (let i = 0; i < xs.length; i++) {
                    const a = currentAma[i];
                    const up = currentRangeUpper[i];
                    const lo = currentRangeLower[i];
                    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(up) || up <= a
                            || !Number.isFinite(lo) || lo <= 0 || lo >= a) {
                        flush();
                        continue;
                    }
                    const x = u.valToPos(xs[i], 'x', true);
                    const yA = u.valToPos(a, 'y', true);
                    const yU = u.valToPos(up, 'y', true);
                    const yL = u.valToPos(lo, 'y', true);
                    if (!Number.isFinite(x) || !Number.isFinite(yA) || !Number.isFinite(yU) || !Number.isFinite(yL)) {
                        flush();
                        continue;
                    }
                    segTop.push([x, yU, yA]);
                    segBot.push([x, yL, yA]);
                }
                flush();
                u.ctx.restore();
            }
            return { hooks: { draw: [drawRangeBand] } };
        }
        function buildData() {
            const tf = timeframeMap.get(currentTimeframe) || timeframeMap.get(defaultTimeframe.label) || timeframes[0];
            currentSeriesState = getSeriesState(currentPairMode);
            currentSeriesCandles = currentSeriesState.candles;
            currentSeriesCloseValues = currentSeriesState.closeValues;
            const aggregated = aggregateCandles(currentSeriesCandles, tf?.seconds || 3600, tf?.label || currentTimeframe);
            currentCandles = aggregated.candles;
            if (currentCandles.length) {
                xMin = currentCandles[0].time;
                xMax = currentCandles[currentCandles.length - 1].time;
            }
            currentDisplayCandles = deriveDisplayCandles(currentCandles);
            currentOpen = currentDisplayCandles.map((c) => c.open);
            currentHigh = currentCandles.map((c) => c.high);
            currentLow = currentCandles.map((c) => c.low);
            currentClose = currentDisplayCandles.map((c) => c.close);
            const baseAma = currentAmaEnabled ? computeAMA(currentSeriesCandles, currentAmaConfig()) : [];
            const baseAmaOff = currentAmaEnabled && currentAmaInitOffset !== 0
                ? computeAMA(currentSeriesCandles, currentAmaConfig(), currentAmaInitOffset)
                : [];
            const baseVwap = currentVwapEnabled ? computeVWMA(currentSeriesCandles, currentVwapBars) : [];
            if (currentSmaEnabled) {
                const smaKey = getSmaCacheKey(currentSmaPeriod);
                const baseSma = smaCache.get(smaKey);
                if (baseSma) {
                    currentSma = sampleSeriesByIndex(baseSma, aggregated.idxs);
                } else {
                    currentSma = new Array(currentCandles.length).fill(null);
                    requestSMA(currentSmaPeriod);
                }
            } else {
                currentSma = new Array(currentCandles.length).fill(null);
            }
            currentAma = currentAmaEnabled ? sampleSeriesByIndex(baseAma, aggregated.idxs) : new Array(currentCandles.length).fill(null);
            const baseRange = computeRangeBand(baseAma);
            currentRangeUpper = sampleSeriesByIndex(baseRange.upper, aggregated.idxs);
            currentRangeLower = sampleSeriesByIndex(baseRange.lower, aggregated.idxs);
            currentAmaOff = currentAmaEnabled && currentAmaInitOffset !== 0 ? sampleSeriesByIndex(baseAmaOff, aggregated.idxs) : new Array(currentCandles.length).fill(null);
            currentVwap = currentVwapEnabled ? sampleSeriesByIndex(baseVwap, aggregated.idxs) : new Array(currentCandles.length).fill(null);
            const amaCfg = currentAmaConfig();
            const warmupInit = currentAmaEnabled && baseAma.length > amaCfg.erPeriod ? baseAma[amaCfg.erPeriod] : null;
            // Build the init segment in the selected timeframe. Sampling the
            // 1h init series by each bucket's final 1h index can make it end
            // inside a week/month bucket, leaving a gap before the first
            // sampled AMA value appears.
            const firstAmaIndex = currentAma.findIndex((value) => Number.isFinite(value));
            // The first visible higher-timeframe AMA sample can already be
            // several 1h updates past the true warmup point. Anchor that
            // sample to the warmup average so the AMA starts where the init
            // line ends instead of appearing detached at a different value.
            if (warmupInit !== null && firstAmaIndex >= 0) currentAma[firstAmaIndex] = warmupInit;
            currentSmaInit = warmupInit !== null
                ? currentAma.map((value, i) => i <= firstAmaIndex || (firstAmaIndex < 0 && i === currentAma.length - 1) ? warmupInit : null)
                : new Array(currentCandles.length).fill(null);
            const offsetInit = currentAmaEnabled && currentAmaInitOffset !== 0 && baseAmaOff.length > amaCfg.erPeriod
                ? baseAmaOff[amaCfg.erPeriod]
                : null;
            const firstAmaOffIndex = currentAmaOff.findIndex((value) => Number.isFinite(value));
            currentSmaInitOff = offsetInit !== null
                ? currentAmaOff.map((value, i) => i < firstAmaOffIndex || (firstAmaOffIndex < 0 && i === currentAmaOff.length - 1) ? offsetInit : null)
                : new Array(currentCandles.length).fill(null);
            currentPriceData = [
                currentCandles.map((c) => c.time),
                currentOpen,
                currentHigh,
                currentLow,
                currentClose,
                currentSma,
                currentAma,
                currentVwap,
                currentSmaInit,
                currentSmaInitOff,
                currentAmaOff,
            ];
            currentVolumeData = [
                currentCandles.map((c) => c.time),
                currentCandles.map((c) => getDisplayVolume(c)),
            ];
            return {
                priceData: currentPriceData,
                volumeData: currentVolumeData,
            };
        }
        function makeChart() {
            const data = buildData();
            const isLogScale = currentPriceScale !== 'linear';

            const priceOpts = {
                width: priceEl.clientWidth,
                height: priceEl.clientHeight,
                padding: [14, 8, 8, 8],
                legend: { show: false },
                select: { show: false },
                cursor: { sync: { key: SYNC_KEY, setSeries: false, scales: ['x', null] }, drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                scales: {
                    x: { time: true },
                    y: {
                        auto: true,
                        distr: isLogScale ? 3 : 1,
                        log: isLogScale ? 10 : undefined,
                        range: (u, min, max) => {
                            if (manualYRange) return [manualYRange.min, manualYRange.max];
                            const vis = visiblePriceRange(u);
                            if (vis) return vis;
                            if (isLogScale) {
                                if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return [1, 10];
                            } else if (!Number.isFinite(min) || !Number.isFinite(max)) {
                                return [0, 1];
                            }
                            return [min * 0.97, max * 1.03];
                        },
                    },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Open' },
                    { label: 'High' },
                    { label: 'Low' },
                    { label: 'Close' },
                    { label: 'SMA', stroke: '#ffffff', width: 2, points: { show: false }, spanGaps: true },
                    { label: 'AMA', stroke: '#facc15', width: 2, points: { show: false }, spanGaps: true },
                    { label: 'VWMA', stroke: '#93c5fd', width: 2, points: { show: false }, spanGaps: true },
                    { label: 'AMA Init', stroke: '#22c55e', width: 1.5, dash: [6, 4], points: { show: false }, spanGaps: false },
                    { label: 'Off Init', stroke: '#a855f7', width: 1.5, dash: [6, 4], points: { show: false }, spanGaps: false },
                    { label: 'AMA Off', stroke: '#a855f7', width: 1.5, dash: [4, 4], points: { show: false }, spanGaps: false },
                ],
                axes: [
                    makeTimeAxis(false),
                    {
                        scale: 'y',
                        side: 1,
                        size: 84,
                        space: isLogScale ? 1 : 45,
                        stroke: '#ffffff',
                        grid: { stroke: '#272f3a' },
                        ticks: { stroke: '#414b57', width: 1 },
                        font: '600 13px Segoe UI, sans-serif',
                        splits: isLogScale ? logAxisSplits : undefined,
                        values: (u, vals) => isLogScale
                            ? vals.map((v) => (Number.isFinite(v) ? fmtPrice(v) : ''))
                            : fmtPriceAxis(vals),
                    },
                ],
                hooks: {
                    draw: [(u) => { positionPriceMarker(u); positionReserveLine(u); positionOrderLines(u); positionUpdateMarker(u, true); }],
                    // Keep the bottom-right stat badges glued to the visible
                    // window while zooming/panning (rAF-throttled text swap).
                    // Refit Y to the visible window on timeframe (x) moves —
                    // uPlot does not recompute Y on setScale('x') by itself.
                    setScale: [(u, key) => { if (key === 'x') scheduleYRefit(); scheduleStatPanels(); }],
                },
            };

            const plugin = candlePlugin();
            plugin.opts(null, priceOpts);
            priceOpts.plugins = [rangeBandPlugin(), plugin];
            if (!priceChart) priceChart = new uPlot(priceOpts, data.priceData, priceEl);
            else priceChart.setData(data.priceData, false);

            const volumeOpts = {
                width: volumeEl.clientWidth,
                height: volumeEl.clientHeight,
                padding: [6, 8, 8, 8],
                legend: { show: false },
                select: { show: false },
                cursor: { sync: { key: SYNC_KEY, setSeries: false, scales: ['x', null] }, drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                scales: {
                    x: { time: true },
                    y: {
                        auto: true,
                        range: (u, min, max) => {
                            const vis = visibleVolumeRange(u);
                            if (vis) return vis;
                            if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return [0, 1];
                            return [0, max * 1.15];
                        },
                    },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Volume', stroke: '#ffffff', fill: '#ffffff', width: 1, points: { show: false } },
                ],
                axes: [
                    makeTimeAxis(true),
                    { scale: 'y', side: 1, size: 84, space: 22, stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, font: '600 12px Segoe UI, sans-serif', values: (u, vals) => vals.map((v) => (v == null ? '' : fmtVolume(v))) },
                ],
                hooks: {
                    // x is synced from the price chart; refit volume Y to the
                    // visible window and refresh the max badge.
                    setScale: [(u, key) => { if (key === 'x') scheduleYRefit(); scheduleStatPanels(); }],
                },
            };

            const volumePluginInst = volumePlugin();
            volumePluginInst.opts(null, volumeOpts);
            volumeOpts.plugins = [volumePluginInst];
            if (!volumeChart) volumeChart = new uPlot(volumeOpts, data.volumeData, volumeEl);
            else volumeChart.setData(data.volumeData, false);

            charts = [priceChart, volumeChart];
            lastRenderedPriceScale = currentPriceScale;
            return priceChart;
        }
        // True when clientX sits over the true price-axis gutter (right of
        // the plot area). Keyed off uPlot's plot rect, not the container
        // width, so grabs on candles — even the newest ones at the plot's
        // right edge — always pan instead of scaling. Only the axis itself
        // zooms price; the rest pans time.
        function inYAxisZone(chart, clientX) {
            if (chart !== priceChart || !chart.over) return false;
            const overRect = chart.over.getBoundingClientRect();
            if (!overRect || overRect.width <= 0) return false;
            return clientX >= overRect.right - 2;
        }
        // True when the pointer sits over the time-axis gutter (below the
        // plot area) of either chart. Dragging there scales the timeframe;
        // drags on candles always pan instead.
        function inXAxisZone(chart, clientY) {
            if (!chart || !chart.over) return false;
            const overRect = chart.over.getBoundingClientRect();
            if (!overRect || overRect.height <= 0) return false;
            return clientY >= overRect.bottom - 2;
        }
        let priceMarkerLabel = null;
        function ensurePriceMarker(u) {
            if (priceMarkerLabel && priceMarkerLabel.parentNode === u.root) return;
            if (priceMarkerLabel && priceMarkerLabel.parentNode) priceMarkerLabel.parentNode.removeChild(priceMarkerLabel);
            try { if (getComputedStyle(u.root).position === 'static') u.root.style.position = 'relative'; } catch (e) {}
            priceMarkerLabel = document.createElement('div');
            priceMarkerLabel.style.cssText = 'position:absolute;z-index:30;pointer-events:none;font:600 12px Segoe UI, sans-serif;line-height:19px;height:19px;padding:0 7px;border-radius:3px;color:#ffffff;white-space:nowrap;box-sizing:border-box;text-align:center;overflow:hidden;';
            u.root.appendChild(priceMarkerLabel);
        }
        function positionPriceMarker(u) {
            if (!u || !u.over || !currentCandles.length) return;
            ensurePriceMarker(u);
            const last = currentCandles[currentCandles.length - 1];
            const prev = currentCandles.length > 1 ? currentCandles[currentCandles.length - 2] : last;
            const price = last.close;
            if (!Number.isFinite(price)) {
                priceMarkerLabel.style.display = 'none';
                return;
            }
            const up = price >= (Number.isFinite(prev.close) ? prev.close : price);
            const color = up ? '#26a69a' : '#ef5350';
            const s = u.scales.y || {};
            const sMin = Number.isFinite(s.min) ? s.min : null;
            const sMax = Number.isFinite(s.max) ? s.max : null;
            if (sMin == null || sMax == null || sMax <= sMin) {
                priceMarkerLabel.style.display = 'none';
                return;
            }
            let frac;
            if (currentPriceScale === 'log') {
                const lmin = Math.log10(sMin);
                const lmax = Math.log10(sMax);
                const lp = Math.log10(Math.max(price, 1e-12));
                frac = (lp - lmin) / (lmax - lmin);
            } else {
                frac = (price - sMin) / (sMax - sMin);
            }
            const rootRect = u.root.getBoundingClientRect();
            const overRect = u.over.getBoundingClientRect();
            if (!overRect || overRect.height <= 0) return;
            const plotTop = overRect.top - rootRect.top;
            const yRel = (1 - frac) * overRect.height;
            // No full-width dashed line by design (disturbs reading) — the
            // axis label above carries the last price on its own.
            priceMarkerLabel.style.display = 'block';
            priceMarkerLabel.textContent = fmtPriceLabel(price);
            priceMarkerLabel.style.background = color;
            priceMarkerLabel.style.top = (plotTop + Math.max(0, Math.min(overRect.height, yRel)) - 10) + 'px';
            const leftAxisW = overRect.left - rootRect.left;
            const rightAxisW = rootRect.right - overRect.right;
            if (leftAxisW >= rightAxisW) {
                priceMarkerLabel.style.left = '0px';
                priceMarkerLabel.style.right = '';
                priceMarkerLabel.style.width = Math.max(40, leftAxisW - 4) + 'px';
            } else {
                priceMarkerLabel.style.left = '';
                priceMarkerLabel.style.right = '0px';
                priceMarkerLabel.style.width = Math.max(40, rightAxisW - 4) + 'px';
            }
        }
        // ── Order overlay ──
        // Active grid orders as dashed levels: green = buys, red = sells.
        // Grid bounds span the full grid (live + virtual slots), never
        // calculated: reserve = lowest grid buy, ceiling = highest grid sell.
        // Spread = best buy/best sell gap.
        // Pair-aware: order prices invert (1/p) with the candles so B/A shows
        // the same levels in display units (side colors preserved).
        let reserveLine = null;
        let reserveLabel = null;
        let ceilingLine = null;
        let ceilingLabel = null;
        let spreadMidLabel = null;
        let orderLineDivs = [];
        let orderBuyLabel = null;
        let orderSellLabel = null;
        let orderPriceTags = [];
        let lastOverlayKey = '';
        function getDisplayOrders() {
            const rawBuys = Array.isArray(payload.orderBuys) ? payload.orderBuys.filter(Number.isFinite).filter((p) => p > 0) : [];
            const rawSells = Array.isArray(payload.orderSells) ? payload.orderSells.filter(Number.isFinite).filter((p) => p > 0) : [];
            if (normalizePairMode(currentPairMode) !== 'inverse') return { buys: rawBuys, sells: rawSells };
            const inv = (arr) => arr.map((p) => 1 / p).filter(Number.isFinite).filter((p) => p > 0);
            return { buys: inv(rawBuys), sells: inv(rawSells) };
        }
        function yForPriceCached(ys, overRect, rootRect, price) {
            const sMin = Number.isFinite(ys.min) ? ys.min : null;
            const sMax = Number.isFinite(ys.max) ? ys.max : null;
            if (sMin == null || sMax == null || sMax <= sMin) return null;
            let frac;
            if (currentPriceScale === 'log') {
                if (!(sMin > 0) || !(price > 0)) return null;
                const lmin = Math.log10(sMin), lmax = Math.log10(sMax);
                frac = (Math.log10(price) - lmin) / (lmax - lmin);
            } else {
                frac = (price - sMin) / (sMax - sMin);
            }
            if (frac < 0 || frac > 1) return null;
            return (overRect.top - rootRect.top) + (1 - frac) * overRect.height;
        }
        function hideOverlayNodes() {
            [reserveLine, reserveLabel, ceilingLine, ceilingLabel, spreadMidLabel, orderBuyLabel, orderSellLabel].forEach((n) => { if (n) n.style.display = 'none'; });
            orderLineDivs.forEach((d) => { d.style.display = 'none'; });
            orderPriceTags.forEach((t) => { t.style.display = 'none'; });
        }
        function positionReserveLine(u) {
            if (!u || !u.over || !currentCandles.length) return;
            if (!currentOrdersVisible || (!hasOrders && !hasBounds)) { hideOverlayNodes(); return; }
            try { if (getComputedStyle(u.root).position === 'static') u.root.style.position = 'relative'; } catch (e) {}
            if (!reserveLine || reserveLine.parentNode !== u.root) {
                if (reserveLine && reserveLine.parentNode) reserveLine.parentNode.removeChild(reserveLine);
                if (reserveLabel && reserveLabel.parentNode) reserveLabel.parentNode.removeChild(reserveLabel);
                reserveLine = document.createElement('div');
                reserveLine.style.cssText = 'position:absolute;z-index:1;pointer-events:none;height:0;border-top:2px dashed #f97316;opacity:0.7;left:0;right:0;display:none;';
                reserveLabel = document.createElement('div');
                reserveLabel.style.cssText = 'position:absolute;z-index:25;pointer-events:none;font:600 10px Segoe UI, sans-serif;line-height:15px;height:15px;padding:0 5px;border-radius:3px;color:#f97316;background:rgba(30,41,59,0.9);white-space:nowrap;display:none;';
                u.root.appendChild(reserveLine);
                u.root.appendChild(reserveLabel);
            }
            // Grid bounds span the full DEXBot grid (live + virtual slots
            // in base units), never calculated: bottom = lowest grid buy,
            // top = highest grid sell. Reciprocals flip the ordering, so
            // the sides swap in B/A view. A missing side hides its line
            // instead of drawing an invented level.
            const { buys: boundBuys, sells: boundSells } = getDisplayOrders();
            const rawLow = Number(payload.gridBounds?.low);
            const rawHigh = Number(payload.gridBounds?.high);
            const gridLow = Number.isFinite(rawLow) && rawLow > 0 ? rawLow : null;
            const gridHigh = Number.isFinite(rawHigh) && rawHigh > 0 ? rawHigh : null;
            const inversePairs = normalizePairMode(currentPairMode) === 'inverse';
            const reservePrice = inversePairs
                ? (gridHigh != null ? 1 / gridHigh : null)
                : gridLow;
            const ceilingPrice = inversePairs
                ? (gridLow != null ? 1 / gridLow : null)
                : gridHigh;
            const ys = u.scales.y || {};
            const rootRect = u.root.getBoundingClientRect();
            const overRect = u.over.getBoundingClientRect();
            const y = reservePrice != null ? yForPriceCached(ys, overRect, rootRect, reservePrice) : null;
            if (y == null) {
                reserveLine.style.display = 'none';
                reserveLabel.style.display = 'none';
            } else {
                reserveLine.style.display = 'block';
                reserveLine.style.top = y + 'px';
                const lastClose = currentCandles[currentCandles.length - 1].close;
                const dipRaw = Number.isFinite(lastClose) && lastClose > 0 ? (lastClose - reservePrice) / lastClose * 100 : NaN;
                const dipTxt = Number.isFinite(dipRaw) ? (dipRaw >= 0 ? '-' : '+') + Math.abs(Math.round(dipRaw)) + '%' : '-';
                reserveLabel.style.display = 'block';
                reserveLabel.textContent = 'reserve ' + fmtPriceLabel(reservePrice) + ' (' + dipTxt + ')';
                reserveLabel.style.left = '8px';
                reserveLabel.style.top = (y - 16) + 'px';
            }
            if (!ceilingLine || ceilingLine.parentNode !== u.root) {
                if (ceilingLine && ceilingLine.parentNode) ceilingLine.parentNode.removeChild(ceilingLine);
                if (ceilingLabel && ceilingLabel.parentNode) ceilingLabel.parentNode.removeChild(ceilingLabel);
                ceilingLine = document.createElement('div');
                ceilingLine.style.cssText = 'position:absolute;z-index:1;pointer-events:none;height:0;border-top:2px dashed #f97316;opacity:0.7;left:0;right:0;display:none;';
                ceilingLabel = document.createElement('div');
                ceilingLabel.style.cssText = 'position:absolute;z-index:25;pointer-events:none;font:600 10px Segoe UI, sans-serif;line-height:15px;height:15px;padding:0 5px;border-radius:3px;color:#f97316;background:rgba(30,41,59,0.9);white-space:nowrap;display:none;';
                u.root.appendChild(ceilingLine);
                u.root.appendChild(ceilingLabel);
            }
            const cY = ceilingPrice != null ? yForPriceCached(ys, overRect, rootRect, ceilingPrice) : null;
            if (cY == null) {
                ceilingLine.style.display = 'none';
                ceilingLabel.style.display = 'none';
            } else {
                ceilingLine.style.display = 'block';
                ceilingLine.style.top = cY + 'px';
                const lastCloseTop = currentCandles[currentCandles.length - 1].close;
                const upRaw = Number.isFinite(lastCloseTop) && lastCloseTop > 0 ? (ceilingPrice - lastCloseTop) / lastCloseTop * 100 : NaN;
                const upTxt = Number.isFinite(upRaw) ? (upRaw >= 0 ? '+' : '-') + Math.abs(Math.round(upRaw)) + '%' : '-';
                ceilingLabel.style.display = 'block';
                ceilingLabel.textContent = 'top ' + fmtPriceLabel(ceilingPrice) + ' (' + upTxt + ')';
                ceilingLabel.style.left = '8px';
                ceilingLabel.style.top = (cY + 4) + 'px';
            }
            if (!spreadMidLabel || spreadMidLabel.parentNode !== u.root) {
                if (spreadMidLabel && spreadMidLabel.parentNode) spreadMidLabel.parentNode.removeChild(spreadMidLabel);
                spreadMidLabel = document.createElement('div');
                spreadMidLabel.style.cssText = 'position:absolute;z-index:25;pointer-events:none;font:700 11px Segoe UI, sans-serif;line-height:16px;height:16px;padding:0 6px;border-radius:3px;color:#0b0f14;background:#facc15;white-space:nowrap;display:none;';
                u.root.appendChild(spreadMidLabel);
            }
            if (boundBuys.length && boundSells.length) {
                const bestBuy = Math.max(...boundBuys);
                const bestSell = Math.min(...boundSells);
                const yB = yForPriceCached(ys, overRect, rootRect, bestBuy);
                const yS = yForPriceCached(ys, overRect, rootRect, bestSell);
                if (yB != null && yS != null && bestBuy > 0) {
                    const spr = (bestSell - bestBuy) / bestBuy * 100;
                    spreadMidLabel.style.display = 'block';
                    spreadMidLabel.textContent = 'spread ' + spr.toFixed(2) + '%';
                    spreadMidLabel.style.left = '8px';
                    spreadMidLabel.style.top = ((yB + yS) / 2 - 8) + 'px';
                } else {
                    spreadMidLabel.style.display = 'none';
                }
            } else if (spreadMidLabel) {
                spreadMidLabel.style.display = 'none';
            }
        }
        function positionOrderLines(u) {
            if (!u || !u.over) return;
            if (!currentOrdersVisible) {
                orderLineDivs.forEach((d) => { d.style.display = 'none'; });
                orderPriceTags.forEach((t) => { t.style.display = 'none'; });
                if (orderBuyLabel) orderBuyLabel.style.display = 'none';
                if (orderSellLabel) orderSellLabel.style.display = 'none';
                return;
            }
            try { if (getComputedStyle(u.root).position === 'static') u.root.style.position = 'relative'; } catch (e) {}
            const { buys, sells } = getDisplayOrders();
            const total = buys.length + sells.length;
            if (orderLineDivs.length && orderLineDivs[0].parentNode !== u.root) {
                orderLineDivs.forEach((d) => u.root.appendChild(d));
                orderPriceTags.forEach((t) => u.root.appendChild(t));
                lastOverlayKey = '';
            }
            while (orderLineDivs.length < total) {
                const d = document.createElement('div');
                d.style.cssText = 'position:absolute;z-index:1;pointer-events:none;height:0;left:0;right:0;display:none;';
                u.root.appendChild(d);
                orderLineDivs.push(d);
            }
            const ys = u.scales.y || {};
            const overlayKey = (ys.min || 0) + '|' + (ys.max || 0) + '|' + (u.root.clientWidth || 0) + '|' + (u.root.clientHeight || 0) + '|' + currentPriceScale + '|' + currentPairMode;
            if (overlayKey === lastOverlayKey) return;
            lastOverlayKey = overlayKey;
            const rootRect = u.root.getBoundingClientRect();
            const overRect = u.over.getBoundingClientRect();
            if (!orderBuyLabel || orderBuyLabel.parentNode !== u.root) {
                if (orderBuyLabel && orderBuyLabel.parentNode) orderBuyLabel.parentNode.removeChild(orderBuyLabel);
                orderBuyLabel = document.createElement('div');
                orderBuyLabel.style.cssText = 'position:absolute;z-index:25;pointer-events:none;font:600 10px Segoe UI, sans-serif;line-height:15px;height:15px;padding:0 5px;border-radius:3px;color:#26a69a;background:rgba(30,41,59,0.9);white-space:nowrap;display:none;';
                u.root.appendChild(orderBuyLabel);
            }
            if (!orderSellLabel || orderSellLabel.parentNode !== u.root) {
                if (orderSellLabel && orderSellLabel.parentNode) orderSellLabel.parentNode.removeChild(orderSellLabel);
                orderSellLabel = document.createElement('div');
                orderSellLabel.style.cssText = 'position:absolute;z-index:25;pointer-events:none;font:600 10px Segoe UI, sans-serif;line-height:15px;height:15px;padding:0 5px;border-radius:3px;color:#ef5350;background:rgba(30,41,59,0.9);white-space:nowrap;display:none;';
                u.root.appendChild(orderSellLabel);
            }
            let idx = 0;
            const place = (price, color) => {
                const d = orderLineDivs[idx++];
                const y = yForPriceCached(ys, overRect, rootRect, price);
                if (y == null) { d.style.display = 'none'; return null; }
                d.style.display = 'block';
                d.style.top = y + 'px';
                d.style.borderTop = '1.5px dashed ' + color;
                d.style.opacity = '0.55';
                return y;
            };
            let botBuyY = null;
            buys.forEach((p) => { const y = place(p, '#26a69a'); if (y != null && (botBuyY == null || y > botBuyY)) botBuyY = y; });
            let topSellY = null;
            sells.forEach((p) => { const y = place(p, '#ef5350'); if (y != null && (topSellY == null || y < topSellY)) topSellY = y; });
            for (; idx < orderLineDivs.length; idx++) orderLineDivs[idx].style.display = 'none';
            if (orderPriceTags.length && orderPriceTags[0].parentNode !== u.root) {
                orderPriceTags.forEach((t) => u.root.appendChild(t));
            }
            const levels = [
                ...buys.map((p) => ({ p, c: '#26a69a', bg: 'rgba(20,30,28,0.92)' })),
                ...sells.map((p) => ({ p, c: '#ef5350', bg: 'rgba(30,20,22,0.92)' })),
            ].sort((a, b) => a.p - b.p);
            let ti = 0, lastTagY = -Infinity;
            const ensureTag = () => {
                if (ti >= orderPriceTags.length) {
                    const t = document.createElement('div');
                    t.style.cssText = 'position:absolute;z-index:25;pointer-events:none;font:600 9px Segoe UI, sans-serif;line-height:14px;height:14px;padding:0 4px;border-radius:3px;white-space:nowrap;display:none;';
                    u.root.appendChild(t);
                    orderPriceTags.push(t);
                }
                return orderPriceTags[ti++];
            };
            for (const lv of levels) {
                const tag = ensureTag();
                const y = yForPriceCached(ys, overRect, rootRect, lv.p);
                if (y == null || Math.abs(y - lastTagY) < 13) { tag.style.display = 'none'; continue; }
                tag.style.display = 'block';
                tag.style.top = (y - 7) + 'px';
                tag.style.right = '4px';
                tag.style.color = lv.c;
                tag.style.background = lv.bg;
                tag.style.border = '1px solid ' + lv.c;
                tag.textContent = fmtPriceLabel(lv.p);
                lastTagY = y;
            }
            for (; ti < orderPriceTags.length; ti++) orderPriceTags[ti].style.display = 'none';
            if (buys.length && botBuyY != null) {
                orderBuyLabel.style.display = 'block';
                orderBuyLabel.textContent = 'BUYS (' + buys.length + ') ' + fmtPriceLabel(Math.min(...buys));
                orderBuyLabel.style.left = '8px';
                orderBuyLabel.style.top = (botBuyY + 4) + 'px';
            } else {
                orderBuyLabel.style.display = 'none';
            }
            if (sells.length && topSellY != null) {
                orderSellLabel.style.display = 'block';
                orderSellLabel.textContent = 'SELLS (' + sells.length + ') ' + fmtPriceLabel(Math.max(...sells));
                orderSellLabel.style.left = '8px';
                orderSellLabel.style.top = (topSellY - 16) + 'px';
            } else {
                orderSellLabel.style.display = 'none';
            }
        }
        function resetOverlayNodes() {
            reserveLine = null;
            reserveLabel = null;
            ceilingLine = null;
            ceilingLabel = null;
            spreadMidLabel = null;
            orderLineDivs = [];
            orderBuyLabel = null;
            orderSellLabel = null;
            orderPriceTags = [];
            lastOverlayKey = '';
        }
        // ── Volume hover tooltip ──
        let volumeHoverTip = null;
        // ── Update marker ("updated from here"): vertical line where the
        // latest incremental fetch started, with a date label. Shown only
        // when the generator was given a marker timestamp.
        const UPDATE_MARKER_SEC = Number(payload.updateMarkerTsSec) > 0 ? Number(payload.updateMarkerTsSec) : null;
        function positionUpdateMarker(u, withLabel) {
            if (!UPDATE_MARKER_SEC || !u || !u.over || !currentCandles.length) return;
            let wrap = u.root.querySelector(':scope > .um-wrap');
            if (!wrap) {
                try { if (getComputedStyle(u.root).position === 'static') u.root.style.position = 'relative'; } catch (e) {}
                wrap = document.createElement('div');
                wrap.className = 'um-wrap';
                wrap.style.cssText = 'position:absolute;z-index:24;pointer-events:none;';
                wrap.innerHTML =
                    '<div class="um-line" style="position:absolute;top:0;height:100%;width:0;border-left:2px dashed #22d3ee;opacity:0.75;"></div>' +
                    '<div class="um-tag" style="position:absolute;top:2px;left:6px;font:600 10px Segoe UI, sans-serif;line-height:15px;color:#22d3ee;white-space:nowrap;"></div>';
                u.root.appendChild(wrap);
            }
            const s = u.scales.x || {};
            const sMin = Number.isFinite(s.min) ? s.min : null;
            const sMax = Number.isFinite(s.max) ? s.max : null;
            if (sMin == null || sMax == null || sMax <= sMin) { wrap.style.display = 'none'; return; }
            const frac = (UPDATE_MARKER_SEC - sMin) / (sMax - sMin);
            const inView = frac >= 0 && frac <= 1;
            if (!inView) { wrap.style.display = 'none'; return; }
            const rootRect = u.root.getBoundingClientRect();
            const overRect = u.over.getBoundingClientRect();
            const xRoot = (overRect.left - rootRect.left) + frac * overRect.width;
            wrap.style.display = 'block';
            wrap.style.left = xRoot + 'px';
            wrap.style.top = (overRect.top - rootRect.top) + 'px';
            wrap.style.height = overRect.height + 'px';
            if (withLabel) {
                const tag = wrap.querySelector('.um-tag');
                const d = new Date(UPDATE_MARKER_SEC * 1000);
                const hh = String(d.getUTCHours()).padStart(2, '0');
                const mm = String(d.getUTCMinutes()).padStart(2, '0');
                const bars = Number(payload.updateMarkerNewBars) > 0 ? ' (+' + Math.round(Number(payload.updateMarkerNewBars)) + ')' : '';
                tag.textContent = 'update ' + d.toLocaleDateString(undefined) + ' ' + hh + ':' + mm + bars + ' →';
                tag.style.left = (frac > 0.8 ? -(tag.offsetWidth + 8) : 6) + 'px';
            }
        }
        function ensureVolumeHoverTip(u) {
            if (volumeHoverTip && volumeHoverTip.parentNode === u.root) return;
            if (volumeHoverTip && volumeHoverTip.parentNode) volumeHoverTip.parentNode.removeChild(volumeHoverTip);
            volumeHoverTip = document.createElement('div');
            volumeHoverTip.style.cssText = 'position:absolute;z-index:31;pointer-events:none;display:none;font:600 11px Segoe UI, sans-serif;line-height:18px;height:18px;padding:0 8px;border-radius:4px;color:#ffffff;background:rgba(48,54,61,0.95);border:1px solid #6e7681;white-space:nowrap;box-sizing:border-box;';
            u.root.appendChild(volumeHoverTip);
        }
        function showVolumeHover(u) {
            if (!u || !u.over || !currentCandles.length) return;
            ensureVolumeHoverTip(u);
            const idx = u.cursor.idx;
            if (idx == null || idx < 0 || idx >= currentCandles.length) {
                volumeHoverTip.style.display = 'none';
                return;
            }
            const c = currentCandles[idx];
            const dv = getDisplayVolume(c);
            if (!Number.isFinite(dv)) {
                volumeHoverTip.style.display = 'none';
                return;
            }
            const barX = u.valToPos(u.data[0][idx], 'x', true);
            volumeHoverTip.style.display = 'block';
            volumeHoverTip.textContent = 'Vol ' + fmtVolumeWithSym(dv);
            volumeHoverTip.style.left = Math.max(2, barX - volumeHoverTip.offsetWidth / 2) + 'px';
            // Pinned to the panel top — never covers the bars
            volumeHoverTip.style.top = '2px';
        }
        function currentYRange(chart) {
            const s = chart.scales.y || {};
            let min = Number.isFinite(s.min) ? s.min : null;
            let max = Number.isFinite(s.max) ? s.max : null;
            if (min == null || max == null) {
                const vis = visiblePriceRange(chart);
                if (vis) { min = vis[0]; max = vis[1]; }
            }
            if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
            return { min: min, max: max };
        }
        let priceBounds = null;
        function computePriceBounds() {
            let min = Infinity;
            let max = -Infinity;
            for (let i = 0; i < currentCandles.length; i++) {
                const lo = currentLow[i];
                const hi = currentHigh[i];
                if (Number.isFinite(lo) && lo > 0 && lo < min) min = lo;
                if (Number.isFinite(hi) && hi > max) max = hi;
            }
            if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
                priceBounds = null;
                return;
            }
            // Uloszoomauksen rajat: alin naytettava hinta voi painua viimeistaan
            // ~1/2 datan minimin alapuolelle, ylin ~2x datan maksimin —
            // paneminen kayttaa tata 2x-bandia ja pysahtyy jaykkana sen
            // reunaan (ei siis paase "lipsahtamaan" candleita nakyvasta
            // kadottaen). Kokonaisvalille ei ole ylarajaa: pystyakselia saa
            // zoomata ulos vapaasti.
            priceBounds = { min: min, max: max, floor: min / 2, ceil: max * 2.0 };
        }
        function applyYRange(chart, min, max) {
            if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return false;
            const ref = Math.max(Math.abs(min), Math.abs(max), 1e-12);
            if (max - min < ref * 1e-9) return false;
            if (currentPriceScale === 'log' && min <= 0) {
                min = max > 0 ? max * 1e-6 : 1e-6;
                if (max <= min) return false;
            }
            if (priceBounds) {
                // Span-locked slide within the 2x zoom band: a pan that would
                // cross the zoom-out limits stops as a rigid block instead of
                // getting squashed (squashing reads as scaling halfway through
                // a drag). Only a span wider than the band itself snaps to the
                // full band. Scaling lives on the axis gutters alone.
                if (currentPriceScale === 'log') {
                    const spanRatio = max / min;
                    if (spanRatio > priceBounds.ceil / priceBounds.floor) {
                        min = priceBounds.floor;
                        max = priceBounds.ceil;
                    } else {
                        if (max > priceBounds.ceil) {
                            const f = max / priceBounds.ceil;
                            min /= f; max /= f;
                        }
                        if (min < priceBounds.floor) {
                            const f = priceBounds.floor / min;
                            min *= f; max *= f;
                        }
                    }
                } else {
                    const span = max - min;
                    if (span > priceBounds.ceil - priceBounds.floor) {
                        min = priceBounds.floor;
                        max = priceBounds.ceil;
                    } else {
                        if (max > priceBounds.ceil) { max = priceBounds.ceil; min = max - span; }
                        if (min < priceBounds.floor) { min = priceBounds.floor; max = min + span; }
                    }
                }
                if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return false;
            }
            manualYRange = { min: min, max: max };
            chart.setScale('y', { min: min, max: max });
            return true;
        }
        function zoomYAt(chart, centerY, factor) {
            const r = currentYRange(chart);
            if (!r) return;
            const span = r.max - r.min;
            let ratio = (centerY - r.min) / span;
            if (!Number.isFinite(ratio)) ratio = 0.5;
            ratio = Math.max(0.05, Math.min(0.95, ratio));
            const nextSpan = span * factor;
            const nextMin = centerY - nextSpan * ratio;
            applyYRange(chart, nextMin, nextMin + nextSpan);
        }
        function bindYAxisDrag(chart) {
            let dragging = false;
            let startClientY = 0;
            let startRange = null;
            const onMove = (e) => {
                if (!dragging || !startRange) return;
                e.preventDefault();
                chart.root.style.cursor = 'ns-resize';
                const deltaPx = e.clientY - startClientY;
                if (!Number.isFinite(deltaPx) || deltaPx === 0) return;
                const factor = Math.exp(deltaPx / 350);
                const span = startRange.max - startRange.min;
                const center = (startRange.min + startRange.max) / 2;
                const nextSpan = span * factor;
                applyYRange(chart, center - nextSpan / 2, center + nextSpan / 2);
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                startRange = null;
                chart.root.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', endDrag);
            };
            chart.root.addEventListener('mousedown', (e) => {
                if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
                // capture phase so we pre-empt uPlot's own plot drag when in the y-zone
                const rect = chart.root.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                if (chart !== priceChart || !inYAxisZone(chart, e.clientX)) return;
                const range = currentYRange(chart);
                if (!range) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startClientY = e.clientY;
                startRange = range;
                chart.root.style.cursor = 'ns-resize';
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            }, true);
        }
        // Time-axis drag scales the timeframe around its center (mirror of
        // the price-axis drag): drag right to zoom out, left to zoom in.
        // Synced across charts via syncXRange; capture phase pre-empts plot pan.
        function bindXAxisDrag(chart) {
            let dragging = false;
            let startClientX = 0;
            let startRange = null;
            const onMove = (e) => {
                if (!dragging || !startRange) return;
                e.preventDefault();
                chart.root.style.cursor = 'ew-resize';
                const deltaPx = e.clientX - startClientX;
                if (!Number.isFinite(deltaPx) || deltaPx === 0) return;
                const factor = Math.exp(deltaPx / 350);
                const span = startRange.max - startRange.min;
                if (!Number.isFinite(span) || span <= 0) return;
                const center = (startRange.min + startRange.max) / 2;
                const nextSpan = span * factor;
                syncXRange(center - nextSpan / 2, center + nextSpan / 2);
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                startRange = null;
                chart.root.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', endDrag);
            };
            chart.root.addEventListener('mousedown', (e) => {
                if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
                // capture phase so we pre-empt the plot pan when in the x-zone
                const rect = chart.root.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                if (!inXAxisZone(chart, e.clientY)) return;
                const s = chart.scales.x || {};
                const range = {
                    min: Number.isFinite(s.min) ? s.min : xMin,
                    max: Number.isFinite(s.max) ? s.max : xMax,
                };
                if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startClientX = e.clientX;
                startRange = range;
                chart.root.style.cursor = 'ew-resize';
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            }, true);
        }
        function bindYAxisReset(chart) {
            chart.root.addEventListener('dblclick', (e) => {
                if (chart !== priceChart) return;
                manualYRange = null;
                const vis = visiblePriceRange(chart);
                if (vis) chart.setScale('y', { min: vis[0], max: vis[1] });
            });
        }
        function refreshLegend() {
            updateLegend(Math.max(0, currentCandles.length - 1));
        }
        function setControls() {
            setActivePairMode(currentPairMode);
            setActivePriceScale(currentPriceScale);
            const ordersToggle = document.getElementById('orders-toggle');
            if (ordersToggle) ordersToggle.checked = currentOrdersVisible;
            const volumeToggleEl = document.getElementById('volume-toggle');
            if (volumeToggleEl) volumeToggleEl.checked = currentVolumeVisible;
            setActiveVolumeUnit();
            markActiveAmaPreset();
            document.getElementById('sma-toggle').checked = currentSmaEnabled;
            document.getElementById('sma-period').value = String(currentSmaPeriod);
            document.getElementById('ama-toggle').checked = currentAmaEnabled;
            document.getElementById('ama-er').value = String(currentAmaErPeriod);
            document.getElementById('ama-fast').value = currentAmaFastPeriod.toFixed(1);
            document.getElementById('ama-slow').value = currentAmaSlowPeriod.toFixed(1);
            document.getElementById('vwap-toggle').checked = currentVwapEnabled;
            document.getElementById('vwap-bars').value = String(currentVwapBars);
            document.getElementById('range-toggle').checked = currentRangeEnabled;
            document.getElementById('range-scale-toggle').checked = currentRangeScaleEnabled;
            document.getElementById('range-span').value = Number(currentRangeSpan).toFixed(2);
            document.getElementById('range-span-val').textContent = Number(currentRangeSpan).toFixed(2) + 'x';
            document.getElementById('range-grid-wrap').style.display = 'inline';
            document.getElementById('ama-init-offset-toggle').checked = currentAmaInitOffsetEnabled;
            document.getElementById('ama-init-offset').value = String(currentAmaInitOffset);
            document.getElementById('ama-init-offset').disabled = !currentAmaInitOffsetEnabled;
            document.getElementById('ama-init-offset-val').textContent = currentAmaInitOffset + '%';
            setActiveTimeframe(currentTimeframe);
            refreshSubtitle();
        }
        function rerender(keepRange = true) {
            const oldRange = keepRange && priceChart ? priceChart.scales.x : null;
            const needsRebuild = !priceChart || !volumeChart || lastRenderedPriceScale !== currentPriceScale;
            if (needsRebuild) {
                manualYRange = null;
                priceMarkerLabel = null;
                resetOverlayNodes();
                volumeHoverTip = null;
                if (priceEl) priceEl.innerHTML = '';
                if (volumeEl) volumeEl.innerHTML = '';
                priceChart = null;
                volumeChart = null;
                charts = [];
                chartEventsBound = false;
            }
            const data = buildData();
            // Dataset changed (timeframe switch, fresh candles): drop any manual
            // price scale so auto-fit takes over again for the new data shape.
            const candleKey = currentCandles.length
                ? currentCandles[0].time + ':' + currentCandles[currentCandles.length - 1].time + ':' + currentCandles.length
                : '';
            if (candleKey !== lastCandleKey) {
                lastCandleKey = candleKey;
                manualYRange = null;
            }
            computePriceBounds();
            if (needsRebuild) {
                makeChart();
            } else {
                priceChart.setData(data.priceData, false);
                volumeChart.setData(data.volumeData, false);
            }
            syncIndicatorSeriesVisibility();
            if (!priceChart || !volumeChart) return;
            if (!chartEventsBound) {
                charts.forEach((chart) => {
                    bindWheelZoom(chart);
                    bindPan(chart);
                    bindXAxisDrag(chart);
                    if (chart === priceChart) {
                        bindYAxisDrag(chart);
                        bindYAxisReset(chart);
                        chart.root.addEventListener('mousemove', (e) => {
                            chart.root.style.cursor = inYAxisZone(chart, e.clientX) ? 'ns-resize' : (inXAxisZone(chart, e.clientY) ? 'ew-resize' : '');
                        });
                        // Cursor price tag: floating label next to the mouse
                        // showing the price under the cursor (price chart only).
                        let cursorPriceTag = null;
                        const ensureCursorPriceTag = () => {
                            if (!cursorPriceTag || cursorPriceTag.parentNode !== chart.root) {
                                if (cursorPriceTag && cursorPriceTag.parentNode) cursorPriceTag.parentNode.removeChild(cursorPriceTag);
                                cursorPriceTag = document.createElement('div');
                                cursorPriceTag.style.cssText = 'position:absolute;z-index:30;pointer-events:none;font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:16px;height:16px;padding:0 6px;border-radius:3px;color:#0b0f14;background:#e8eef5;white-space:nowrap;display:none;';
                                chart.root.appendChild(cursorPriceTag);
                            }
                            return cursorPriceTag;
                        };
                        chart.over.addEventListener('mousemove', (e) => {
                            const tag = ensureCursorPriceTag();
                            const rect = chart.root.getBoundingClientRect();
                            const overRect = chart.over.getBoundingClientRect();
                            const price = chart.posToVal(e.clientY - overRect.top, 'y');
                            if (!Number.isFinite(price)) { tag.style.display = 'none'; return; }
                            tag.style.display = 'block';
                            tag.textContent = fmtPriceLabel(price);
                            let x = e.clientX - rect.left + 14;
                            const y = e.clientY - rect.top - 8;
                            const maxX = rect.width - tag.offsetWidth - 6;
                            if (x > maxX) x = e.clientX - rect.left - tag.offsetWidth - 14;
                            tag.style.left = Math.max(2, x) + 'px';
                            tag.style.top = Math.max(2, y) + 'px';
                        });
                        chart.over.addEventListener('mouseleave', () => {
                            if (cursorPriceTag) cursorPriceTag.style.display = 'none';
                        });
                    }
                    chart.root.addEventListener('mousemove', () => {
                        if (chart.cursor.idx != null) updateLegend(chart.cursor.idx);
                    });
                    if (chart === volumeChart) {
                        chart.over.addEventListener('mousemove', () => showVolumeHover(chart));
                        chart.over.addEventListener('mouseleave', () => {
                            if (volumeHoverTip) volumeHoverTip.style.display = 'none';
                        });
                    }
                    chart.root.addEventListener('mouseleave', refreshLegend);
                    chart.root.addEventListener('mouseenter', () => chart.root.classList.add('is-hovered'));
                    chart.root.addEventListener('mouseleave', () => chart.root.classList.remove('is-hovered'));
                });
                chartEventsBound = true;
            }
            if (oldRange && Number.isFinite(oldRange.min) && Number.isFinite(oldRange.max)) {
                const next = clampRange(oldRange.min, oldRange.max);
                if (next) charts.forEach((chart) => chart.batch(() => chart.setScale('x', next)));
            }
            refreshLegend();
            renderMarketPanel();
            renderRangePanel();
            renderVolumePanel();
            saveState();
        }

        setControls();
        rerender(false);
        document.querySelectorAll('.time-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                const label = btn.dataset.timeframe;
                if (!label || label === currentTimeframe) return;
                currentTimeframe = label;
                setActiveTimeframe(label);
                rerender(true);
            });
        });
        const scaleToggle = document.getElementById('scale-toggle');
        if (scaleToggle) {
            scaleToggle.addEventListener('click', () => {
                currentPriceScale = currentPriceScale === 'linear' ? 'log' : 'linear';
                setActivePriceScale(currentPriceScale);
                rerender(false);
            });
        }
        const pairToggle = document.getElementById('pair-toggle');
        if (pairToggle) {
            pairToggle.addEventListener('click', () => {
                currentPairMode = currentPairMode === 'inverse' ? 'normal' : 'inverse';
                manualYRange = null;
                lastOverlayKey = '';
                setControls();
                rerender(true);
                padXRight();
            });
        }
        const ordersToggle = document.getElementById('orders-toggle');
        if (ordersToggle) {
            ordersToggle.addEventListener('change', () => {
                currentOrdersVisible = ordersToggle.checked;
                lastOverlayKey = '';
                if (!currentOrdersVisible && priceChart) hideOverlayNodes();
                setControls();
                saveState();
                if (priceChart) {
                    positionReserveLine(priceChart);
                    positionOrderLines(priceChart);
                }
                renderMarketPanel();
            });
        }
        // Volume toggle: hide the volume chart so flex yields the space to
        // the price chart (larger). No rerender, resize only.
        const applyVolumeVisibility = () => {
            if (!volumeEl || !priceChart) return;
            volumeEl.style.display = currentVolumeVisible ? '' : 'none';
            requestAnimationFrame(() => {
                if (!priceChart) return;
                priceChart.setSize({ width: priceEl.clientWidth, height: priceEl.clientHeight });
                if (currentVolumeVisible && volumeChart && volumeEl.clientWidth > 0) {
                    volumeChart.setSize({ width: volumeEl.clientWidth, height: volumeEl.clientHeight });
                }
            });
        };
        const volumeToggleInit = document.getElementById('volume-toggle');
        if (volumeToggleInit) {
            volumeToggleInit.checked = currentVolumeVisible;
            volumeToggleInit.addEventListener('change', () => {
                currentVolumeVisible = volumeToggleInit.checked;
                saveState();
                applyVolumeVisibility();
            });
        }
        const volumeUnitToggle = document.getElementById('volume-unit-toggle');
        if (volumeUnitToggle) {
            volumeUnitToggle.addEventListener('click', () => toggleVolumeUnit());
        }
        const legendVolume = document.getElementById('legend-volume');
        if (legendVolume) {
            legendVolume.addEventListener('click', () => toggleVolumeUnit());
        }
        // Initial state on load (previously stored in localStorage)
        applyVolumeVisibility();
        document.querySelectorAll('.ama-preset-btn').forEach((b) => {
            b.addEventListener('click', () => applyAmaPreset(b.dataset.amaPreset));
        });

        const syncInputs = () => {
            currentSmaEnabled = document.getElementById('sma-toggle').checked;
            currentSmaPeriod = clamp(Math.round(Number(document.getElementById('sma-period').value) || 20), 1, 9999);
            currentAmaEnabled = document.getElementById('ama-toggle').checked;
            currentAmaErPeriod = clamp(Math.round(Number(document.getElementById('ama-er').value) || ${MARKET_ADAPTER.AMAS.AMA3.erPeriod}), 1, 999999);
            currentAmaFastPeriod = Math.round(clamp(Number(document.getElementById('ama-fast').value) || Number(payload.amaDefaults?.fastPeriod || ${MARKET_ADAPTER.AMAS.AMA3.fastPeriod}), 0.1, 999999) * 10) / 10;
            currentAmaSlowPeriod = Math.round(clamp(Number(document.getElementById('ama-slow').value) || Number(payload.amaDefaults?.slowPeriod || ${MARKET_ADAPTER.AMAS.AMA3.slowPeriod}), 0.1, 999999) * 10) / 10;
            currentAmaInitOffsetEnabled = document.getElementById('ama-init-offset-toggle').checked;
            currentAmaInitOffset = currentAmaInitOffsetEnabled ? snapInitOffset(document.getElementById('ama-init-offset').value) : 0;
            document.getElementById('ama-init-offset').value = String(currentAmaInitOffset);
            document.getElementById('ama-init-offset').disabled = !currentAmaInitOffsetEnabled;
            document.getElementById('ama-init-offset-val').textContent = currentAmaInitOffset + '%';
            currentVwapEnabled = document.getElementById('vwap-toggle').checked;
            currentVwapBars = clamp(Math.round(Number(document.getElementById('vwap-bars').value) || 500), 24, 2000);
            currentRangeEnabled = document.getElementById('range-toggle').checked;
            currentRangeScaleEnabled = document.getElementById('range-scale-toggle').checked;
            currentRangeSpan = Math.min(2, Math.max(1.2, Math.round((Number(document.getElementById('range-span').value) || 1.55) * 20) / 20));
            const ordersEl = document.getElementById('orders-toggle');
            if (ordersEl) currentOrdersVisible = ordersEl.checked;
            setControls();
            markActiveAmaPreset();
            rerender(false);
        };

        document.getElementById('sma-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('sma-toggle').checked;
            if (currentSmaEnabled === nextEnabled) return;
            currentSmaEnabled = nextEnabled;
            setControls();
            if (!currentSmaEnabled) {
                hideSmaSeriesImmediate();
                return;
            }
            rerender(false);
        });
        document.getElementById('ama-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('ama-toggle').checked;
            if (currentAmaEnabled === nextEnabled) return;
            currentAmaEnabled = nextEnabled;
            setControls();
            if (!currentAmaEnabled) {
                hideAmaSeriesImmediate();
                return;
            }
            rerender(false);
        });
        document.getElementById('vwap-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('vwap-toggle').checked;
            if (currentVwapEnabled === nextEnabled) return;
            currentVwapEnabled = nextEnabled;
            setControls();
            if (!currentVwapEnabled) {
                hideVwapSeriesImmediate();
                return;
            }
            rerender(false);
        });
        document.getElementById('ama-init-offset-toggle').addEventListener('change', syncInputs);
        document.getElementById('range-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('range-toggle').checked;
            if (currentRangeEnabled === nextEnabled) return;
            currentRangeEnabled = nextEnabled;
            setControls();
            if (!currentRangeEnabled) {
                hideRangeBandImmediate();
                return;
            }
            rerender(false);
        });
        document.getElementById('range-scale-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('range-scale-toggle').checked;
            if (currentRangeScaleEnabled === nextEnabled) return;
            currentRangeScaleEnabled = nextEnabled;
            manualYRange = null;
            setControls();
            rerender(false);
        });
        ['sma-period', 'ama-er', 'ama-fast', 'ama-slow', 'vwap-bars'].forEach((id) => {
            document.getElementById(id).addEventListener('change', syncInputs);
            document.getElementById(id).addEventListener('blur', syncInputs);
        });
        ['ama-er'].forEach((id) => {
            document.getElementById(id).addEventListener('input', syncInputs);
        });
        function makeStepper(id, step, lo, precision) {
            const dec = document.getElementById(id + '-dec');
            const inc = document.getElementById(id + '-inc');
            if (!dec || !inc) return;
            const input = document.getElementById(id);
            function stepVal(dir) {
                const val = parseFloat(input.value) || 0;
                let next = dir < 0 ? Math.max(lo, val - step) : val + step;
                if (precision === 0) next = Math.round(next);
                else if (precision > 0) next = Math.round(next * Math.pow(10, precision)) / Math.pow(10, precision);
                input.value = precision >= 0 ? next.toFixed(precision) : String(next);
                syncInputs();
            }
            function addHold(el, dir) {
                let timer = null;
                function start() {
                    stepVal(dir);
                    timer = setTimeout(() => {
                        timer = setInterval(() => stepVal(dir), 100);
                    }, 300);
                }
                function stop() {
                    if (timer) { clearInterval(timer); clearTimeout(timer); timer = null; }
                }
                el.addEventListener('mousedown', start);
                el.addEventListener('mouseup', stop);
                el.addEventListener('mouseleave', stop);
            }
            addHold(dec, -1);
            addHold(inc, 1);
        }
        makeStepper('sma-period', 1, 1, 0);
        makeStepper('vwap-bars', 1, 24, 0);
        makeStepper('ama-er', 1, 1, 0);
        makeStepper('ama-fast', 0.1, 0.1, 1);
        makeStepper('ama-slow', 1, 0.1, 1);
        document.getElementById('ama-init-offset').addEventListener('input', () => {
            const input = document.getElementById('ama-init-offset');
            const snapped = snapInitOffset(input.value);
            if (String(snapped) !== String(input.value)) input.value = String(snapped);
            document.getElementById('ama-init-offset-val').textContent = snapped + '%';
            syncInputs();
        });
        document.getElementById('range-span').addEventListener('input', () => {
            const input = document.getElementById('range-span');
            document.getElementById('range-span-val').textContent = Number(input.value).toFixed(2) + 'x';
            syncInputs();
        });

        // Room to the right past the last bar (~12%): for the market panel
        // and future candles. Applied at init and on pair flip; user
        // zoom/pan never trigger it, so it does not fight the user zoom.
        function padXRight() {
            if (!priceChart || !currentCandles.length) return;
            const first = currentCandles[0]?.time;
            const last = currentCandles[currentCandles.length - 1]?.time;
            if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return;
            const span = last - first;
            syncXRange(first - span * 0.02, last + span * 0.12);
        }
        // Market panel top-right: SELL / Market / BUY with distance-to-market
        // %. Pair-aware (same display levels as the overlay). Static per
        // generation, so drawn once (no draw hook); refreshed on pair flip
        // via rerender. Hidden while the Orders overlay is unchecked — the
        // BUY/SELL rows are overlay data, so they go away with it.
        function renderMarketPanel() {
            if (!priceChart) return;
            let panel = document.getElementById('mkt-panel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'mkt-panel';
                panel.style.cssText = 'position:absolute;z-index:26;top:10px;right:88px;pointer-events:none;font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;padding:8px 12px;border-radius:8px;background:rgba(13,17,23,0.85);border:1px solid #263241;white-space:nowrap;text-align:right;';
                priceChart.root.appendChild(panel);
            }
            if (!currentOrdersVisible && (hasOrders || hasBounds)) { panel.style.display = 'none'; return; }
            panel.style.display = 'block';
            const last = currentCandles[currentCandles.length - 1];
            const mkt = last ? last.close : NaN;
            const { buys, sells } = getDisplayOrders();
            let html = '';
            if (sells.length && Number.isFinite(mkt)) {
                const s = Math.min(...sells);
                const p = (s - mkt) / mkt * 100;
                html += '<div style="color:#ef5350">SELL ' + fmtPriceLabel(s) + ' ' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%</div>';
            }
            html += '<div style="color:#e8eef5">Market ' + (Number.isFinite(mkt) ? fmtPriceLabel(mkt) : '-') + '</div>';
            if (buys.length && Number.isFinite(mkt)) {
                const b = Math.max(...buys);
                const p = (b - mkt) / mkt * 100;
                html += '<div style="color:#26a69a">BUY ' + fmtPriceLabel(b) + ' ' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%</div>';
            }
            panel.innerHTML = html;
        }
        // Range panel bottom-right: visible-window candle High (red) /
        // Low (green) — sell-side red on top, buy-side green below, mirroring
        // the top-right market badge. Volume max lives in its own badge on
        // the volume chart below. Slightly smaller type than the top-right market badge.
        // Pair-aware via currentCandles (already inverted in B/A view).
        // Refreshed on rerender and on x zoom/pan through the setScale hooks.
        function visibleCandleStats() {
            if (!currentCandles.length) return null;
            let minX = NaN;
            let maxX = NaN;
            if (priceChart) {
                const xs = priceChart.scales.x || {};
                if (Number.isFinite(xs.min)) minX = xs.min;
                if (Number.isFinite(xs.max)) maxX = xs.max;
            }
            if (!Number.isFinite(minX)) minX = currentCandles[0].time;
            if (!Number.isFinite(maxX)) maxX = currentCandles[currentCandles.length - 1].time;
            const times = currentCandles.map((c) => c.time);
            const start = Math.max(0, lowerBound(times, minX) - 1);
            const end = Math.min(times.length, lowerBound(times, maxX) + 2);
            let hi = -Infinity;
            let lo = Infinity;
            let vol = 0;
            for (let i = start; i < end; i++) {
                const c = currentCandles[i];
                if (!c) continue;
                if (Number.isFinite(c.high) && c.high > hi) hi = c.high;
                if (Number.isFinite(c.low) && c.low < lo) lo = c.low;
                const dv = getDisplayVolume(c);
                if (Number.isFinite(dv) && dv > vol) vol = dv;
            }
            if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
            return { hi, lo, vol };
        }
        function renderRangePanel() {
            if (!priceChart) return;
            let panel = document.getElementById('range-panel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'range-panel';
                panel.style.cssText = 'position:absolute;z-index:26;bottom:10px;right:88px;pointer-events:none;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;padding:6px 10px;border-radius:8px;background:rgba(13,17,23,0.85);border:1px solid #263241;white-space:nowrap;text-align:right;';
                priceChart.root.appendChild(panel);
            }
            const stats = visibleCandleStats();
            if (!stats) { panel.style.display = 'none'; return; }
            panel.style.display = 'block';
            panel.innerHTML = '<div style="color:#ef5350">H ' + fmtPriceLabel(stats.hi) + '</div>'
                + '<div style="color:#26a69a">L ' + fmtPriceLabel(stats.lo) + '</div>';
        }
        // Volume badge top-right on the volume chart: max volume of the
        // visible window only. Same small type as the range panel. Lives on
        // the volume root, so hiding the volume chart hides the badge too.
        function renderVolumePanel() {
            if (!volumeChart) return;
            let panel = document.getElementById('vol-panel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'vol-panel';
                panel.style.cssText = 'position:absolute;z-index:26;top:10px;right:88px;pointer-events:auto;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;padding:6px 10px;border-radius:8px;background:rgba(13,17,23,0.85);border:1px solid #263241;white-space:nowrap;text-align:right;';
                panel.addEventListener('click', () => toggleVolumeUnit());
                volumeChart.root.appendChild(panel);
            }
            panel.style.cursor = payload.volumeIsCount ? 'default' : 'pointer';
            panel.title = payload.volumeIsCount
                ? 'Volume: feed publish count per bucket'
                : 'Volume units — click to switch base/quote';
            const stats = visibleCandleStats();
            if (!stats) { panel.style.display = 'none'; return; }
            panel.style.display = 'block';
            panel.innerHTML = '<div style="color:#e8eef5">max ' + fmtVolumeWithSym(stats.vol) + '</div>';
        }
        function scheduleStatPanels() {
            if (rangePanelRaf) return;
            rangePanelRaf = requestAnimationFrame(() => {
                rangePanelRaf = 0;
                renderRangePanel();
                renderVolumePanel();
            });
        }
        // uPlot does not recompute an auto Y scale when X moves via
        // setScale('x') — the scale range fns only run on init/data
        // change. Refit Y to the visible window after every timeframe
        // move so candles/volume follow the pan/zoom instead of getting
        // stuck outside the view. A user-locked price range (axis
        // wheel/drag → manualYRange) is respected; double-click the
        // price axis to return to autofit. y-keyed setScale calls never
        // schedule a refit, so this cannot loop with itself.
        function yRangeDirty(u, vis) {
            const s = u.scales.y || {};
            if (!Number.isFinite(s.min) || !Number.isFinite(s.max)) return true;
            const span = Math.max(1e-12, Math.abs(vis[1] - vis[0]));
            return Math.abs(s.min - vis[0]) / span > 1e-9 || Math.abs(s.max - vis[1]) / span > 1e-9;
        }
        function scheduleYRefit() {
            if (yRefitRaf) return;
            yRefitRaf = requestAnimationFrame(() => {
                yRefitRaf = 0;
                if (priceChart && !manualYRange) {
                    const vis = visiblePriceRange(priceChart);
                    if (vis && yRangeDirty(priceChart, vis)) priceChart.setScale('y', { min: vis[0], max: vis[1] });
                }
                if (volumeChart) {
                    const vvis = visibleVolumeRange(volumeChart);
                    if (vvis && yRangeDirty(volumeChart, vvis)) volumeChart.setScale('y', { min: vvis[0], max: vvis[1] });
                }
            });
        }
        padXRight();
        renderMarketPanel();
        renderRangePanel();
        renderVolumePanel();

        window.addEventListener('resize', () => {
            if (!charts.length) return;
            charts.forEach((chart) => {
                const el = chart === priceChart ? priceEl : volumeEl;
                if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
                chart.setSize({ width: el.clientWidth, height: el.clientHeight });
            });
        });

        window.addEventListener('keydown', (e) => {
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if ((e.ctrlKey || e.metaKey) && e.key === '0' && charts.length) {
                const first = currentCandles[0]?.time;
                const last = currentCandles[currentCandles.length - 1]?.time;
                if (Number.isFinite(first) && Number.isFinite(last)) syncXRange(first, last);
            }
        });

        ${zoomResetScript()}
    })();
    </script>
</body>
</html>`;
}

export { generateHTML, normalizeCandle, loadMarketProfiles, resolveChartStorageKey, sanitizeStorageComponent, TRADINGVIEW_PREFS_KEY_PREFIX, TRADINGVIEW_SYNC_KEY }


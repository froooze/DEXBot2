'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import {
    getCandleClose,
    getCandleTimestamp,
    normalizeCandle,
} from '../market_adapter/candle_utils.js';


/**
 * Math utilities for analysis scripts.
 *
 * Candle accessors are centralized in market_adapter (candle_utils.ts) and
 * re-exported here so analysis tooling shares one logic path with the
 * live adapter and the browser-embedded chart scripts.
 */

function range(min: number, max: number, step: number, decimals: number = 4) {
    const out: number[] = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(decimals)));
    return [...new Set(out)];
}

function calcStdDev(arr: number[]) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sqDiffs = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0);
    return Math.sqrt(sqDiffs / arr.length);
}

/**
 * Median of a numeric array (average of the two middle values for even
 * lengths). Returns `null` for an empty array. Shared by the analysis
 * backtests instead of each keeping a local copy.
 */
function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface PercentileOptions {
    /** 'linear' interpolates between the two bracketing ranks (R-7, default);
     *  'nearest' picks a single rank. */
    interpolation?: 'linear' | 'nearest';
    /** For 'nearest': round the rank (default) or floor it. */
    rounding?: 'round' | 'floor';
    /** Skip the internal sort when the input is already ascending. */
    sorted?: boolean;
    /** Value returned for an empty input (default null). */
    empty?: number | null;
}

/**
 * Percentile of a numeric array.
 *
 * Single home for the four copies previously kept by optimizer_high_resolution
 * (fractional q, linear), backtest_ama_slope_huber (nearest/round),
 * trade_profitability (pre-sorted, linear) and backtest_lookback_drawdown
 * (nearest/floor). The options preserve each caller's exact ranking rule so
 * centralizing does not silently change any reported number.
 *
 * @param values numeric array (copied + sorted unless `sorted` is true)
 * @param p      percentile position in [0, 100]
 */
function percentile(values: number[], p: number, opts: PercentileOptions & { empty: number }): number;
function percentile(values: number[], p: number, opts?: PercentileOptions): number | null;
function percentile(
    values: number[],
    p: number,
    { interpolation = 'linear', rounding = 'round', sorted = false, empty = null }: PercentileOptions = {},
): number | null {
    if (values.length === 0) return empty;
    const s = sorted ? values : values.slice().sort((a, b) => a - b);
    const pct = Math.max(0, Math.min(100, p));
    const idx = (pct / 100) * (s.length - 1);
    if (interpolation === 'linear') {
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        if (lo === hi) return s[lo];
        const t = idx - lo;
        return s[lo] * (1 - t) + s[hi] * t;
    }
    const i = rounding === 'floor' ? Math.floor(idx) : Math.round(idx);
    return s[Math.min(s.length - 1, Math.max(0, i))];
}

interface FmtNumOptions {
    /** Text returned for a value that is not finite. */
    fallback?: string;
    /** When true, only a real finite `number` counts (null/undefined fall back);
     *  when false (default), values are coerced with `Number()` first, so
     *  `null` formats as `0`. */
    strict?: boolean;
}

/**
 * Fixed-decimal number formatting with a non-finite fallback.
 *
 * Single home for the identical `fmt(x, d)` copies in backtest_ama_slope_huber
 * and backtest_lookback_drawdown, plus the strict/padded variant in
 * bot_fitting/shared_utils (`fmt(x, d, { fallback: '  n/a', strict: true })`).
 */
function fmtNum(x: number | null | undefined, d = 2, { fallback = 'n/a', strict = false }: FmtNumOptions = {}): string {
    const finite = strict ? Number.isFinite(x) : Number.isFinite(Number(x));
    return finite ? Number(x).toFixed(d) : fallback;
}

function quantize(value: number, quantum: number | null | undefined): number {
    if (quantum == null || !Number.isFinite(quantum) || quantum <= 0) return value;
    return Math.round(value / quantum) * quantum;
}

/**
 * Evenly spaced geometric progression from `min` to `max` (endpoints forced).
 * Values are optionally snapped to `quantum` and clamped back into the range,
 * rounded to `decimals`, deduped and sorted ascending. Single home for the
 * helper previously copied into analyze_lambda_vs_slow and
 * optimizer_high_resolution (which used different rounding precision).
 */
function geometricRange(
    min: number,
    max: number,
    count: number,
    { decimals = 10, quantum = null as number | null } = {},
) {
    const out: number[] = [];
    const ratio = Math.pow(max / min, 1 / (count - 1));
    for (let i = 0; i < count; i++) {
        let v = min * Math.pow(ratio, i);
        if (i === 0) v = min;
        if (i === count - 1) v = max;
        v = quantize(v, quantum);
        v = Math.max(min, Math.min(max, v));
        out.push(parseFloat(v.toFixed(decimals)));
    }
    return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Parse a candle JSON file with format detection:
 * flat array → {candles: [...]} → {data: [...]}
 */
interface CandleFile {
    candles: Record<string, unknown>[];
    meta: Record<string, unknown> | null;
}

function loadCandleFile(filePath: string): CandleFile {
    if (!filePath || !fs.existsSync(filePath)) return { candles: [], meta: null };
    const raw = readJSON(filePath);
    if (Array.isArray(raw)) return { candles: raw as Record<string, unknown>[], meta: null };
    const r = raw as { candles?: Record<string, unknown>[]; data?: Record<string, unknown>[]; meta?: Record<string, unknown> } | null;
    if (r && Array.isArray(r.candles)) return { candles: r.candles, meta: r.meta || (r as Record<string, unknown>) };
    if (r && Array.isArray(r.data)) return { candles: r.data, meta: r as Record<string, unknown> };
    return { candles: [], meta: null };
}

/** Normalized OHLCV candle (millisecond-free epoch seconds, like the adapter). */
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

/**
 * Load candle records from a single JSON file or a directory of monthly JSON
 * shards.
 *
 * Directory entries are filtered to `*.json` (manifests skipped) and sorted;
 * shards are merged and deduped by candle time (a later file overwrites an
 * earlier duplicate). Returns the merged candles, the first non-null `meta` and
 * the file count. Single home for the loader previously copied into
 * backtest_ama_slope_huber.
 */
function loadCandleSeries(input: string): { candles: Candle[]; meta: Record<string, unknown> | null; files: number } {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`Data path not found: ${resolved}`);
    const stat = fs.statSync(resolved);
    const files = stat.isDirectory()
        ? fs.readdirSync(resolved)
            .filter((name) => /\.json$/i.test(name) && !/manifest/i.test(name))
            .map((name) => path.join(resolved, name))
            .sort()
        : [resolved];

    const byTime = new Map<number, Candle>();
    let meta: Record<string, unknown> | null = null;
    for (const file of files) {
        let raw: { candles?: unknown; meta?: Record<string, unknown> } | null = null;
        try { raw = readJSON(file) as { candles?: unknown; meta?: Record<string, unknown> }; } catch { continue; }
        const arr = Array.isArray(raw?.candles) ? raw.candles : (Array.isArray(raw) ? raw : null);
        if (!arr || arr.length === 0) continue;
        if (!meta && raw?.meta) meta = raw.meta;
        for (const c of arr) {
            const n = normalizeCandle(c);
            if (n) byTime.set(n.time, { time: n.time, open: n.open, high: n.high, low: n.low, close: n.close, volume: n.volume });
        }
    }

    const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (candles.length === 0) throw new Error(`No candles found under ${resolved}`);
    return { candles, meta, files: files.length };
}

export {
    range,
    calcStdDev,
    geometricRange,
    median,
    percentile,
    fmtNum,
    getCandleClose,
    getCandleTimestamp,
    normalizeCandle,
    loadCandleFile,
    loadCandleSeries,
}

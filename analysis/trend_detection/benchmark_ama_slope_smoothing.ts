'use strict';

/**
 * AMA-SLOPE SMOOTHING BENCHMARK
 *
 * Compares candidate smoothers for the per-bar AMA slope on the SAME data the
 * dynamic-weight research charts embed, reporting the two things that matter
 * for the choice: LAG (how late the causal signal confirms a change) and TOTAL
 * SMOOTHING (how much bar-to-bar noise is removed).
 *
 * Data source: one or more `dw_pool_<id>_1h_<range>.html` charts. The chart's
 * embedded payload carries `prices` (closes) and `ama3Prices` (the production
 * AMA values), so no separate candle download is needed. Every candidate sees
 * the identical Huber slope series produced by the canonical production
 * estimator; only the smoothing stage differs.
 *
 * Candidates:
 *   raw_huber          current estimator, EMA off (alpha = 1)
 *   ema_a              current production smoothing, computeAmaSlopeEmaSeries
 *   ema2_a             two cascaded EMAs (the naive "another smoother on top")
 *   med3               trailing median of 3 on the Huber slope
 *   kama               KAMA/AMA applied to the slope (ER from the slope itself)
 *   kama_slow          KAMA with a longer ER window
 *   kama_on_ema        KAMA on top of the current EMA (the literal stacked idea)
 *   ew_huber           exponential taper of older bars INSIDE the Huber IRLS fit
 *   kalman_slope       scalar random-walk Kalman filter on the slope
 *   hysteresis         stateful trend latch (hi/lo around the mean |slope|)
 *
 * Metrics (real data):
 *   lagAmaBars      cross-correlation peak vs a centred (zero-lag) Huber
 *                   reference, with parabolic interpolation (group delay)
 *   wobble             mean |delta slope| in %/bar; noiseRed% = 1 - wobble/raw
 *   roughness          mean squared second difference; roughRed% vs raw
 *   zeroCrossPer1k     sign flips per 1000 bars
 *   stdPct / maeTruth  slope dispersion and mean |causal - centred truth|
 *
 * Metrics (synthetic, independent of the pool):
 *   step50 / step90    bars from a unit step in slope until 50% / 90% reached
 *   noiseGain          output/input std on fixed-seed white noise (lower =
 *                      more of the high-frequency noise removed)
 *
 * Usage:
 *   node dist/analysis/trend_detection/benchmark_ama_slope_smoothing.js \
 *     [--chart <dw-chart.html>]... [--out <results.json>] [--lookback 16]
 */

import fs from 'node:fs';
import path from 'node:path';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import {
    computeHuberWindowSlopePct,
    computeAmaSlopeEmaSeries,
} from '../../market_adapter/core/strategies/dynamic_weight_series.js';
import { createHuberEstimator } from './huber_scale_variants.js';
import { simulateGridResetSeries, GRID_RESET_BOOTSTRAP } from '../tradingview/grid_reset_sim.js';

type Num = number | null;

interface ChartData {
    name: string;
    file: string;
    prices: number[];
    ama: number[];
    lookbackBars: number;
    erPeriod: number;
    readyBar: number;
    warmupBars: number;
    emaAlpha: number;
    barCount: number;
}

interface Candidate {
    name: string;
    note: string;
    apply: (d: ChartData, raw: Num[]) => Num[];
    /** Post-filter-only candidates can be exercised on synthetic inputs. */
    synth?: (input: number[]) => Num[];
}

interface Metrics {
    lagAmaBars: number;
    lagAmaCorr: number | null;
    wobble: number;
    noiseRedPct: number;
    roughness: number;
    roughRedPct: number;
    zeroCrossPer1k: number;
    stdPct: number;
    maeTruth: number | null;
}

interface SynthMetrics {
    step50: number | null;
    step90: number | null;
    noiseGain: number | null;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {
        charts: [] as string[],
        lookback: null as number | null,
        outPath: path.resolve('analysis/results/ama_slope_smoothing_benchmark.json'),
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const val = args[i + 1];
        if (arg === '--chart' && val) { out.charts.push(path.resolve(val)); i++; }
        else if (arg === '--lookback' && val) { out.lookback = Number(val); i++; }
        else if (arg === '--out' && val) { out.outPath = path.resolve(val); i++; }
        else if (arg === '--help' || arg === '-h') {
            console.log('Usage: node dist/analysis/trend_detection/benchmark_ama_slope_smoothing.js --chart <dw-chart.html> [--chart <dw-chart.html>]... [--lookback 16] [--out results.json]');
            process.exit(0);
        }
    }
    if (out.charts.length === 0) throw new Error('Pass at least one --chart <dw-chart.html>');
    return out;
}

// ─── Data ────────────────────────────────────────────────────────────────────

function loadChart(file: string, lookbackOverride: number | null): ChartData {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<script[^>]*id="payload"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`No embedded payload in ${file}`);
    const p = JSON.parse(m[1]);
    const prices = (p.prices ?? []).map(Number);
    const ama = (p.ama3Prices ?? []).map(Number);
    if (prices.length < 100 || ama.length !== prices.length) {
        throw new Error(`Unexpected payload series lengths in ${file}`);
    }
    const bars = lookbackOverride != null && Number.isFinite(lookbackOverride) && lookbackOverride >= 2
        ? Math.round(lookbackOverride)
        : Number(p.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS);
    const er = Number(p.amaErPeriod ?? MARKET_ADAPTER.AMAS.AMA3.erPeriod);
    const emaAlpha = Number(p.amaSlopeEmaAlpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA);
    // Production computeAmaSlopeEmaSeries starts at er + lookback; keep the same
    // readiness boundary so every candidate sees the same finite bars.
    const readyBar = Math.ceil(er) + bars;
    return {
        name: path.basename(file).replace(/\.html$/, ''),
        file,
        prices,
        ama,
        lookbackBars: bars,
        erPeriod: er,
        readyBar,
        warmupBars: Number(p.amaWarmupBars ?? readyBar),
        emaAlpha,
        barCount: prices.length,
    };
}

function rawSlopeSeries(d: ChartData): Num[] {
    const out: Num[] = new Array(d.ama.length).fill(null);
    for (let i = d.readyBar; i < d.ama.length; i++) {
        out[i] = computeHuberWindowSlopePct(d.ama, i, d.lookbackBars);
    }
    return out;
}

/** Centred Huber slope: zero-lag reference used only for metrics, never fed to a candidate. */
function centredTruth(d: ChartData): Num[] {
    const half = d.lookbackBars;
    const out: Num[] = new Array(d.ama.length).fill(null);
    for (let t = half; t <= d.ama.length - 1 - half; t++) {
        out[t] = computeHuberWindowSlopePct(d.ama, t + half, half * 2);
    }
    return out;
}

// ─── Candidate smoothers ─────────────────────────────────────────────────────

/** Same recursion as computeAmaSlopeEmaSeries, usable on any aligned series. */
function emaOfSeries(series: Num[], alpha: number): Num[] {
    const a = Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : 1;
    const out: Num[] = new Array(series.length).fill(null);
    let prev: number | null = null;
    for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (v == null || !Number.isFinite(v)) { prev = null; continue; }
        prev = a === 1 || prev === null ? v : prev + a * (v - prev);
        out[i] = prev;
    }
    return out;
}

function trailingMedian(series: Num[], k: number): Num[] {
    const out: Num[] = new Array(series.length).fill(null);
    for (let i = 0; i < series.length; i++) {
        const pool: number[] = [];
        for (let j = Math.max(0, i - k + 1); j <= i; j++) {
            const v = series[j];
            if (v != null && Number.isFinite(v)) pool.push(v);
        }
        if (pool.length === 0) continue;
        pool.sort((a, b) => a - b);
        const mid = pool.length >> 1;
        out[i] = pool.length % 2 === 1 ? pool[mid] : (pool[mid - 1] + pool[mid]) / 2;
    }
    return out;
}

/** Kaufman AMA applied to a slope series; ER is computed from the slope itself. */
function kamaOfSeries(series: Num[], erPeriod: number, fastPeriod: number, slowPeriod: number): Num[] {
    const er = Math.max(2, Math.round(erPeriod));
    const fastSC = 2 / (fastPeriod + 1);
    const slowSC = 2 / (slowPeriod + 1);
    const out: Num[] = new Array(series.length).fill(null);
    let prev: number | null = null;
    for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (v == null || !Number.isFinite(v)) { prev = null; continue; }
        const past = series[i - er];
        // The ER window must be fully finite. On real data the Huber slope is
        // null for the first er+bars bars, so KAMA needs er extra warmup bars
        // past Huber readiness; using a null (coerced to 0) there would fabricate
        // a huge ER and blow up the recursion.
        if (prev === null || i < er || past == null || !Number.isFinite(past)) {
            prev = v; out[i] = v; continue;
        }
        const direction = Math.abs(v - past);
        let volatility = 0;
        let contiguous = true;
        for (let j = i - er + 1; j <= i; j++) {
            const a = series[j - 1], b = series[j];
            if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) { contiguous = false; break; }
            volatility += Math.abs(b - a);
        }
        if (!contiguous) { prev = v; out[i] = v; continue; }
        const ratio = volatility > 0 ? direction / volatility : 0;
        const smooth = (ratio * (fastSC - slowSC) + slowSC) ** 2;
        prev = prev + smooth * (v - prev);
        out[i] = prev;
    }
    return out;
}

/**
 * Huber IRLS as in production, but with older bars in the window exponentially
 * down-weighted. This smooths at the estimator level (no extra recursion/lag
 * stage): long-window stability with short-window responsiveness. Exposed as a
 * single-bar estimator so it can be fed to the PRODUCTION EMA helper too.
 */
function ewHuberAt(
    amaValues: unknown[] | null | undefined,
    index: number,
    lookbackBars: unknown,
    decay: number,
): number | null {
    const hub = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER;
    const bars = Number.isFinite(lookbackBars) && Number(lookbackBars) > 0
        ? Math.ceil(Number(lookbackBars)) : 0;
    if (!Array.isArray(amaValues) || bars < 1) return null;
    if (!Number.isFinite(index) || index < bars || index >= amaValues.length) return null;
    const n = bars + 1;
    const xMean = (n - 1) / 2;
    const y = new Array<number>(n);
    const ones = new Array<number>(n).fill(1);
    const resid = new Array<number>(n);
    const abs = new Array<number>(n);
    const w = new Array<number>(n);
    const taper = new Array<number>(n);
    for (let i = 0; i < n; i++) taper[i] = decay ** (n - 1 - i);
    const wls = (weights: number[]) => {
        let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
        for (let i = 0; i < n; i++) {
            const xi = i - xMean;
            sw += weights[i]; swx += weights[i] * xi; swy += weights[i] * y[i];
            swxx += weights[i] * xi * xi; swxy += weights[i] * xi * y[i];
        }
        const den = sw * swxx - swx * swx;
        const b = den === 0 ? 0 : (sw * swxy - swx * swy) / den;
        return { a: sw === 0 ? 0 : (swy - b * swx) / sw, b };
    };
    for (let i = 0; i < n; i++) {
        const v = Number(amaValues[index - bars + i]);
        if (!Number.isFinite(v) || v <= 0) return null;
        y[i] = Math.log(v);
    }
    let fit = wls(ones);
    for (let iter = 0; iter < hub.ITERATIONS; iter++) {
        for (let i = 0; i < n; i++) resid[i] = y[i] - (fit.a + fit.b * (i - xMean));
        for (let i = 0; i < n; i++) abs[i] = Math.abs(resid[i]);
        abs.sort((a, b) => a - b);
        const mid = n >> 1;
        const mad = n % 2 === 1 ? abs[mid] : (abs[mid - 1] + abs[mid]) / 2;
        const s = Math.max(1.4826 * mad, hub.SCALE_FLOOR);
        for (let i = 0; i < n; i++) {
            w[i] = Math.min(1, (hub.C * s) / Math.max(Math.abs(resid[i]), 1e-12)) * taper[i];
        }
        fit = wls(w);
    }
    const slope = fit.b * 100;
    return Number.isFinite(slope) && Math.abs(slope) < hub.ZERO_EPSILON ? 0 : slope;
}

function ewHuberSlope(d: ChartData, decay: number): Num[] {
    const out: Num[] = new Array(d.ama.length).fill(null);
    for (let i = d.readyBar; i < d.ama.length; i++) {
        out[i] = ewHuberAt(d.ama, i, d.lookbackBars, decay);
    }
    return out;
}

function kalmanSlope(series: Num[], q: number, r: number): Num[] {
    const out: Num[] = new Array(series.length).fill(null);
    let x: number | null = null;
    let p = 0;
    for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (v == null || !Number.isFinite(v)) { x = null; continue; }
        if (x === null) { x = v; p = r; out[i] = v; continue; }
        p += q;
        const k = p / (p + r);
        x = x + k * (v - x);
        p = (1 - k) * p;
        out[i] = x;
    }
    return out;
}

function hysteresis(series: Num[], hiMult: number, loMult: number): Num[] {
    let meanAbs = 0, count = 0;
    for (const v of series) if (v != null && Number.isFinite(v)) { meanAbs += Math.abs(v); count++; }
    const hi = (meanAbs / Math.max(1, count)) * hiMult;
    const lo = hi * loMult;
    const out: Num[] = new Array(series.length).fill(null);
    let state = 0;
    for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (v == null || !Number.isFinite(v)) { state = 0; continue; }
        const sign = Math.sign(v);
        if (Math.abs(v) >= hi) { state = sign; out[i] = v; }
        else if (state !== 0 && sign === state && Math.abs(v) >= lo) out[i] = v;
        else { state = 0; out[i] = 0; }
    }
    return out;
}

const candidates: Candidate[] = [
    { name: 'raw_huber', note: 'EMA off (alpha=1); baseline',
      apply: (_d, raw) => raw, synth: (x) => x.slice() },
    { name: 'ema_020', note: 'CURRENT production EMA alpha=0.2',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, d.emaAlpha),
      synth: (x) => emaOfSeries(x, 0.2) },
    { name: 'ema_050', note: 'lighter EMA alpha=0.5',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, 0.5),
      synth: (x) => emaOfSeries(x, 0.5) },
    { name: 'ema_010', note: 'heavier EMA alpha=0.1',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, 0.1),
      synth: (x) => emaOfSeries(x, 0.1) },
    { name: 'ema_002', note: 'heaviest allowed EMA alpha=2/101',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, 2 / 101),
      synth: (x) => emaOfSeries(x, 2 / 101) },
    { name: 'ema2_020', note: 'two cascaded EMA(0.2) stages',
      apply: (_d, raw) => emaOfSeries(emaOfSeries(raw, 0.2), 0.2),
      synth: (x) => emaOfSeries(emaOfSeries(x, 0.2), 0.2) },
    { name: 'med3', note: 'trailing median of 3 on Huber slope',
      apply: (_d, raw) => trailingMedian(raw, 3),
      synth: (x) => trailingMedian(x, 3) },
    { name: 'kama', note: 'KAMA on slope: ER=16, fast=2, slow=20',
      apply: (_d, raw) => kamaOfSeries(raw, 16, 2, 20),
      synth: (x) => kamaOfSeries(x, 16, 2, 20) },
    { name: 'kama_slow', note: 'KAMA on slope: ER=32, fast=2, slow=40',
      apply: (_d, raw) => kamaOfSeries(raw, 32, 2, 40),
      synth: (x) => kamaOfSeries(x, 32, 2, 40) },
    { name: 'kama_on_ema', note: 'KAMA(16,2,20) stacked on EMA(0.2)',
      apply: (_d, raw) => kamaOfSeries(emaOfSeries(raw, 0.2), 16, 2, 20),
      synth: (x) => kamaOfSeries(emaOfSeries(x, 0.2), 16, 2, 20) },
    { name: 'ew_huber_090', note: 'Huber IRLS with 0.9 taper on older bars (NO EMA)',
      apply: (d) => ewHuberSlope(d, 0.9) },
    { name: 'ew_huber_080', note: 'Huber IRLS with 0.8 taper on older bars (NO EMA)',
      apply: (d) => ewHuberSlope(d, 0.8) },
    { name: 'ew090_ema020', note: 'taper 0.9 estimator + CURRENT EMA 0.2',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, d.emaAlpha,
          (v, i, bars) => ewHuberAt(v, i, bars, 0.9)) },
    { name: 'ew090_ema010', note: 'taper 0.9 estimator + EMA 0.1',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, 0.1,
          (v, i, bars) => ewHuberAt(v, i, bars, 0.9)) },
    { name: 'ew080_ema020', note: 'taper 0.8 estimator + CURRENT EMA 0.2',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, d.emaAlpha,
          (v, i, bars) => ewHuberAt(v, i, bars, 0.8)) },
    { name: 'scale_df_ema020', note: 'Huber df-scale correction + CURRENT EMA 0.2',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, d.emaAlpha,
          createHuberEstimator('df')) },
    { name: 'scale_ms_ema020', note: 'Huber proposal-2 M-scale + CURRENT EMA 0.2',
      apply: (d) => computeAmaSlopeEmaSeries(d.ama, d.erPeriod, d.lookbackBars, d.emaAlpha,
          createHuberEstimator('mscale')) },
    { name: 'kalman_q01', note: 'scalar Kalman random walk, q=0.01 r=1',
      apply: (_d, raw) => kalmanSlope(raw, 0.01, 1),
      synth: (x) => kalmanSlope(x, 0.01, 1) },
    { name: 'hysteresis', note: 'trend latch: enter 1.5x, exit 0.5x mean |slope|',
      apply: (_d, raw) => hysteresis(raw, 1.5, 1 / 3),
      synth: (x) => hysteresis(x, 1.5, 1 / 3) },
];

// ─── Metrics ─────────────────────────────────────────────────────────────────

/** Cross-correlation peak: positive lag means `sig` trails `ref` by k bars. */
function crossCorrelationLag(sig: Num[], ref: Num[], maxLag: number) {
    const corrs: number[] = new Array(maxLag + 1).fill(-Infinity);
    let bestLag = 0, bestCorr = -Infinity;
    for (let k = 0; k <= maxLag; k++) {
        let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
        for (let t = k; t < sig.length; t++) {
            const x = sig[t], y = ref[t - k];
            if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
            n++; sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
        }
        if (n < 100) continue;
        const mx = sx / n, my = sy / n;
        const vx = sxx / n - mx * mx, vy = syy / n - my * my;
        const corr = vx > 0 && vy > 0 ? (sxy / n - mx * my) / Math.sqrt(vx * vy) : -Infinity;
        corrs[k] = corr;
        if (corr > bestCorr) { bestCorr = corr; bestLag = k; }
    }
    // Parabolic interpolation around the discrete peak: the integer peak alone
    // cannot separate, say, a 4-bar from a 6-bar filter that both round to 5.
    let lagBars = bestLag;
    if (bestLag > 0 && bestLag < maxLag) {
        const lo = corrs[bestLag - 1], mid = corrs[bestLag], hi = corrs[bestLag + 1];
        const denom = lo - 2 * mid + hi;
        if (Number.isFinite(lo) && Number.isFinite(hi) && denom < 0) {
            const offset = 0.5 * (lo - hi) / denom;
            if (Number.isFinite(offset) && Math.abs(offset) <= 0.5) lagBars = bestLag + offset;
        }
    }
    return { lagBars, corr: Number.isFinite(bestCorr) ? bestCorr : null };
}

function mean(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function metrics(series: Num[], raw: Num[], truth: Num[], truthHalf: number): Metrics {
    let finite = 0, sumSq = 0, sumSigned = 0;
    let prev: number | null = null, prevDelta: number | null = null;
    let deltaCount = 0, sumAbsDelta = 0, secondCount = 0, secondSq = 0;
    let rawDeltaCount = 0, rawSumAbsDelta = 0, rawSecondCount = 0, rawSecondSq = 0;
    let rawPrev: number | null = null, rawPrevDelta: number | null = null;
    let zeroCross = 0, lastSign = 0;
    let maeSum = 0, maeCount = 0;

    const accumulate = (s: number, isRaw: boolean) => {
        const p = isRaw ? rawPrev : prev;
        const pd = isRaw ? rawPrevDelta : prevDelta;
        if (isRaw) {
            if (p != null) { rawSumAbsDelta += Math.abs(s - p); rawDeltaCount++; if (pd != null) rawSecondSq += ((s - p) - pd) ** 2, rawSecondCount++; }
            rawPrevDelta = p != null ? s - p : null;
            rawPrev = s;
            return;
        }
        finite++;
        sumSigned += s; sumSq += s * s;
        const sign = Math.sign(s);
        if (sign !== 0) { if (lastSign !== 0 && sign !== lastSign) zeroCross++; lastSign = sign; }
        if (p != null) { sumAbsDelta += Math.abs(s - p); deltaCount++; if (pd != null) secondSq += ((s - p) - pd) ** 2, secondCount++; }
        prevDelta = p != null ? s - p : null;
        prev = s;
    };

    for (let i = 0; i < series.length; i++) {
        const s = series[i];
        if (s != null && Number.isFinite(s)) accumulate(s, false);
        const r = raw[i];
        if (r != null && Number.isFinite(r)) accumulate(r, true);
        const t = truth[i];
        if (s != null && t != null && Number.isFinite(s) && Number.isFinite(t)) { maeSum += Math.abs(s - t); maeCount++; }
    }
    const rawWobble = rawDeltaCount > 0 ? rawSumAbsDelta / rawDeltaCount : 0;
    const rawRough = rawSecondCount > 0 ? rawSecondSq / rawSecondCount : 0;
    const wobble = deltaCount > 0 ? sumAbsDelta / deltaCount : 0;
    const roughness = secondCount > 0 ? secondSq / secondCount : 0;
    const meanSlope = finite > 0 ? sumSigned / finite : 0;
    // Wide enough that the heaviest allowed EMA (alpha=2/101, ~49-bar group
    // delay) does not hit the search cap and report a censored lag.
    const maxLag = Math.max(1, truthHalf * 4);
    const xc = crossCorrelationLag(series, truth, maxLag);

    return {
        lagAmaBars: xc.lagBars,
        lagAmaCorr: xc.corr,
        wobble,
        noiseRedPct: rawWobble > 0 ? (1 - wobble / rawWobble) * 100 : 0,
        roughness,
        roughRedPct: rawRough > 0 ? (1 - roughness / rawRough) * 100 : 0,
        zeroCrossPer1k: finite > 0 ? (zeroCross / finite) * 1000 : 0,
        stdPct: Math.sqrt(Math.max(0, finite > 0 ? sumSq / finite - meanSlope * meanSlope : 0)),
        maeTruth: maeCount > 0 ? maeSum / maeCount : null,
    };
}

function synthMetrics(fn: (x: number[]) => Num[]): SynthMetrics {
    const stepInput: number[] = new Array(400).fill(0).map((_v, i) => (i >= 100 ? 1 : 0));
    const stepped = fn(stepInput);
    const firstAt = (level: number): number | null => {
        for (let i = 100; i < stepped.length; i++) {
            const v: Num = stepped[i];
            if (typeof v === 'number' && Number.isFinite(v) && v >= level) return i - 100;
        }
        return null;
    };
    // Fixed-seed white noise (LCG), no external RNG dependency.
    let seed = 123456789;
    const noise: number[] = new Array(20000).fill(0).map(() => {
        seed = (1103515245 * seed + 12345) & 0x7fffffff;
        return (seed / 0x3fffffff) - 1;
    });
    const filtered = fn(noise).filter((v): v is number => v != null && Number.isFinite(v));
    const inVar = mean(noise.map((v) => v * v));
    const outVar = mean(filtered.map((v) => v * v));
    return {
        step50: firstAt(0.5),
        step90: firstAt(0.9),
        noiseGain: inVar > 0 && filtered.length > 0 ? Math.sqrt(outVar / inVar) : null,
    };
}

// ─── Reset replay (what the smoothed slope actually decides) ────────────────

interface ResetResult {
    label: string;
    resets: number;
    priceResets: number;
    slopeResets: number;
    resetsPerDay: number;
    whipsaws: number;
    medianGapBars: number | null;
}

/**
 * Replays the production grid-recentering triggers with the same slope series
 * each candidate would publish. Only estimator-level variants can be injected
 * into the replay; post-filters (KAMA/median/etc.) are compared on lag/wobble
 * only. `clipPercentile: 0` is deliberate: clipping never moves reset timing,
 * and skipping it keeps the replay fast.
 */
function resetComparison(d: ChartData): ResetResult[] {
    const MA = MARKET_ADAPTER;
    const specs: Array<{
        label: string;
        alpha: number;
        estimator?: ((values: unknown, index: number, bars: unknown) => number | null) | null;
    }> = [
        { label: 'current (huber + EMA0.2)', alpha: d.emaAlpha },
        { label: 'taper0.9 + EMA0.2', alpha: d.emaAlpha,
            estimator: (v, i, b) => ewHuberAt(v as unknown[], i, b, 0.9) },
        { label: 'taper0.8 + EMA0.2', alpha: d.emaAlpha,
            estimator: (v, i, b) => ewHuberAt(v as unknown[], i, b, 0.8) },
        { label: 'huber df-scale + EMA0.2', alpha: d.emaAlpha, estimator: createHuberEstimator('df') },
        { label: 'huber M-scale + EMA0.2', alpha: d.emaAlpha, estimator: createHuberEstimator('mscale') },
        { label: 'current estimator + EMA0.1', alpha: 0.1 },
    ];
    const liveBars = Math.max(1, d.ama.length - d.warmupBars);
    return specs.map((s) => {
        const sim = simulateGridResetSeries(d.ama, {
            priceDeltaThresholdPercent: MA.AMA_DELTA_THRESHOLD_PERCENT,
            slopeDeltaThresholdPercent: (MA.AMA_SLOPE_DELTA_THRESHOLD_PERCENT / 100) * MA.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
            slopeEnabled: true,
            erPeriod: d.erPeriod,
            lookbackBars: d.lookbackBars,
            warmupBars: d.warmupBars,
            maxSlopePct: MA.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
            neutralZonePct: MA.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
            maxSlopeOffset: MA.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
            clipPercentile: 0,
            emaAlpha: s.alpha,
            slopePersistBars: MA.AMA_SLOPE_PERSIST_BARS,
            slopeEstimator: s.estimator ?? null,
        });
        const idx = sim.events.filter((e) => e.reason !== GRID_RESET_BOOTSTRAP)
            .map((e) => Number(e.index));
        const gaps: number[] = [];
        for (let i = 1; i < idx.length; i++) gaps.push(idx[i] - idx[i - 1]);
        gaps.sort((a, b) => a - b);
        return {
            label: s.label,
            resets: sim.stats.resets,
            priceResets: sim.stats.priceResets,
            slopeResets: sim.stats.slopeResets,
            resetsPerDay: (sim.stats.resets / liveBars) * 24,
            whipsaws: gaps.filter((g) => g <= 3).length,
            medianGapBars: gaps.length === 0 ? null
                : gaps.length % 2 === 1 ? gaps[(gaps.length - 1) >> 1]
                    : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2,
        };
    });
}

// ─── Output ──────────────────────────────────────────────────────────────────

function f(v: number | null | undefined, d = 2): string {
    return v == null || !Number.isFinite(v) ? '  n/a' : v.toFixed(d).padStart(6);
}

/** Compact scientific notation for the tiny second-difference energy values. */
function fe(v: number | null | undefined): string {
    return v == null || !Number.isFinite(v) ? '  n/a' : v.toExponential(1).padStart(8);
}

function printTable(title: string, header: string, rows: string[]) {
    console.log(`\n${title}`);
    console.log(header);
    rows.forEach((r) => console.log(r));
}

function run() {
    const cfg = parseArgs();
    const datasets = cfg.charts.map((f) => loadChart(f, cfg.lookback));
    const results: Record<string, Record<string, { metrics: Metrics; synth: SynthMetrics | null }>> = {};
    const resetResults: Record<string, ResetResult[]> = {};

    console.log('================================================================================');
    console.log(' AMA-SLOPE SMOOTHING BENCHMARK');
    console.log('================================================================================');
    for (const d of datasets) {
        console.log(`  ${d.name}: ${d.barCount} bars, AMA er=${d.erPeriod}, lookback=${d.lookbackBars}, current EMA a=${d.emaAlpha}`);
    }

    for (const d of datasets) {
        const raw = rawSlopeSeries(d);
        const truth = centredTruth(d);
        results[d.name] = {};
        console.log('\n================================================================================');
        console.log(` ${d.name}`);
        console.log('================================================================================');
        console.log(' candidate   | lagAma | wobble noiseRed% roughness  roughRed% | zc/1k  std   maeTruth');
        console.log('-------------+--------+-----------------------------------------+--------------------');
        for (const c of candidates) {
            const series = c.apply(d, raw);
            const m = metrics(series, raw, truth, d.lookbackBars);
            const s = c.synth ? synthMetrics(c.synth) : { step50: null, step90: null, noiseGain: null };
            results[d.name][c.name] = { metrics: m, synth: s };
            console.log(
                ` ${c.name.padEnd(11)} | ${f(m.lagAmaBars, 1)} | ` +
                `${f(m.wobble, 4)} ${f(m.noiseRedPct, 1)} ${fe(m.roughness)} ${f(m.roughRedPct, 1)} | ` +
                `${f(m.zeroCrossPer1k, 1)} ${f(m.stdPct, 4)} ${f(m.maeTruth, 4)}`
            );
        }
        printTable(
            ' SYNTHETIC (causal step at bar 100; white-noise input gain)',
            ' candidate   | step50 step90 | noiseGain',
            candidates.filter((c) => c.synth).map((c) => {
                const s = results[d.name][c.name].synth as SynthMetrics;
                return ` ${c.name.padEnd(11)} | ${f(s.step50, 0)}  ${f(s.step90, 0)} | ${f(s.noiseGain, 3)}`;
            })
        );
        printTable(
            ' CANDIDATE NOTES',
            '',
            candidates.map((c) => ` ${c.name.padEnd(11)} ${c.note}`)
        );

        const resets = resetComparison(d);
        resetResults[d.name] = resets;
        printTable(
            ' GRID RESET REPLAY (canonical drift + slope-delta triggers, persist=3)',
            ' variant                      | resets price slope /day | whipsaw medGap',
            resets.map((r) =>
                ` ${r.label.padEnd(28)} | ${String(r.resets).padStart(6)} ${String(r.priceResets).padStart(5)} ` +
                `${String(r.slopeResets).padStart(5)} ${f(r.resetsPerDay, 2)} | ${String(r.whipsaws).padStart(6)} ${f(r.medianGapBars, 0)}`
            )
        );
    }

    fs.mkdirSync(path.dirname(cfg.outPath), { recursive: true });
    fs.writeFileSync(cfg.outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        datasets: results,
        gridResets: resetResults,
    }, null, 2));
    console.log(`\nWrote ${cfg.outPath}`);
}

run();

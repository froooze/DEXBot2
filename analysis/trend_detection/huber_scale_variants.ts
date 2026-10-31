'use strict';

/**
 * RESEARCH-ONLY scale variants for the canonical Huber AMA-slope estimator.
 *
 * `computeHuberWindowSlopePct` (market_adapter/core/strategies/dynamic_weight_series.ts)
 * estimates the robust scale as a PLUG-IN `1.4826 * MAD` of the residuals of the
 * current fit, recomputed each IRLS pass. Those residuals are shrunk relative to
 * the true errors (n - 2 degrees of freedom), so the plug-in scale is biased low
 * — measured ~0.93x sigma at a 16-bar window, ~0.86x at 8 bars — which lowers the
 * effective Huber constant below the nominal 1.345 and makes short windows more
 * conservative than intended.
 *
 * scikit-learn's `HuberRegressor` avoids this by optimizing sigma JOINTLY with the
 * coefficients (sklearn/linear_model/_huber.py); its reference is Huber &
 * Ronchetti, "Concomitant scale estimates", p. 172. This module reproduces the
 * baseline exactly and offers two corrected scale estimates so the effect can be
 * measured without touching production:
 *
 *   'none'   — exact production behaviour (plug-in 1.4826 * MAD).
 *   'df'     — plug-in MAD inflated by the finite-sample factor sqrt(n / (n - 2)).
 *   'mscale' — Huber proposal-2 M-scale: solve mean(rho_C(r_i / s)) = delta_C,
 *              where delta_C = E[rho_C(Z)] under N(0, 1), iterated with the fit.
 *
 * Also returns an outlier fraction (share of |residual| > C * s), the sklearn
 * `outliers_` analogue, for observability.
 *
 * Not imported by production code and not embedded in any chart — a research
 * harness for the scale-bias hypothesis only.
 */

import { MARKET_ADAPTER } from '../../modules/constants.js';

export type HuberScaleMode = 'none' | 'df' | 'mscale';

/** One-bar diagnostic snapshot returned alongside the slope. */
interface HuberDiagnostics {
    slopePct: number;
    scale: number;
    outlierFraction: number;
}

/** Accumulated stats attached to an estimator built by {@link createHuberEstimator}. */
interface HuberEstimatorStats {
    calls: number;
    outlierFractionSum: number;
    scaleSum: number;
}

/** Estimator function shape accepted by simulateGridResetSeries (cfg.slopeEstimator). */
interface HuberConsts {
    C?: number;
    ITERATIONS?: number;
    SCALE_FLOOR?: number;
    ZERO_EPSILON?: number;
}

export type HuberEstimator = ((amaValues: unknown, index: number, lookbackBars: unknown) => number | null) & {
    stats: HuberEstimatorStats;
};

// Abramowitz & Stegun 7.1.26 approximation — max abs error ~1.5e-7, ample for a
// consistency constant that only needs ~1e-6 relative accuracy.
function erf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    return sign * (1 - poly * Math.exp(-ax * ax));
}

function standardNormalCdf(x: number): number {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

function standardNormalPdf(x: number): number {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Huber rho: z^2 inside the band, linear beyond. */
function huberRho(z: number, c: number): number {
    const a = Math.abs(z);
    return a <= c ? z * z : 2 * c * a - c * c;
}

/**
 * delta_C = E[rho_C(Z)] for Z ~ N(0,1), the proposal-2 consistency constant:
 *   delta_C = 2*Phi(c) - 1 + 2*c*phi(c) - 2*c^2*(1 - Phi(c)).
 */
export function huberConsistencyConstant(c: number): number {
    const Phi = standardNormalCdf(c);
    const phi = standardNormalPdf(c);
    return 2 * Phi - 1 + 2 * c * phi - 2 * c * c * (1 - Phi);
}

/**
 * Proposal-2 M-scale: the s satisfying mean(rho_C(r_i / s)) = delta_C.
 * Fixed-point iteration s <- s * sqrt(mean(rho_C(r / s)) / delta_C), seeded from
 * the plug-in MAD so it starts near the answer.
 */
function solveMScale(resid: number[], c: number, seed: number, floor: number): number {
    const delta = huberConsistencyConstant(c);
    let s = Math.max(seed, floor);
    for (let it = 0; it < 60; it++) {
        let acc = 0;
        for (let i = 0; i < resid.length; i++) acc += huberRho(resid[i] / s, c);
        const ratio = acc / (resid.length * delta);
        const next = s * Math.sqrt(Math.max(ratio, 1e-12));
        if (!Number.isFinite(next)) return s;
        if (Math.abs(next - s) <= 1e-13 * s) return next;
        s = next;
    }
    return s;
}

/**
 * Core fit. Reproduces `computeHuberWindowSlopePct` byte-for-byte for
 * `mode='none'`; the other modes change only the scale estimate fed to the
 * Huber weight `min(1, C*s/|r|)`.
 */
export function huberSlopeCore(
    amaValues: unknown,
    index: number,
    lookbackBars: unknown,
    mode: HuberScaleMode = 'none',
    hub: HuberConsts = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER,
): HuberDiagnostics | null {
    const bars = Number.isFinite(lookbackBars) && Number(lookbackBars) > 0
        ? Math.ceil(Number(lookbackBars))
        : 0;
    if (!Array.isArray(amaValues) || bars < 1) return null;
    if (!Number.isFinite(index) || index < bars || index >= amaValues.length) return null;

    const y: number[] = [];
    for (let k = index - bars; k <= index; k++) {
        const v = Number(amaValues[k]);
        if (!Number.isFinite(v) || v <= 0) return null;
        y.push(Math.log(v));
    }
    const n = y.length;
    const c = Number.isFinite(Number(hub?.C)) ? Number(hub.C) : 1.345;
    const iterations = Number.isFinite(Number(hub?.ITERATIONS)) ? Number(hub.ITERATIONS) : 5;
    const scaleFloor = Number.isFinite(Number(hub?.SCALE_FLOOR)) ? Number(hub.SCALE_FLOOR) : 1e-6;
    const zeroEpsilon = Number.isFinite(Number(hub?.ZERO_EPSILON)) ? Number(hub.ZERO_EPSILON) : 1e-9;

    const xMean = (n - 1) / 2;
    const wls = (w: number[]) => {
        let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
        for (let i = 0; i < n; i++) {
            const xi = i - xMean;
            sw += w[i]; swx += w[i] * xi; swy += w[i] * y[i];
            swxx += w[i] * xi * xi; swxy += w[i] * xi * y[i];
        }
        const den = sw * swxx - swx * swx;
        const b = den === 0 ? 0 : (sw * swxy - swx * swy) / den;
        const a = sw === 0 ? 0 : (swy - b * swx) / sw;
        return { a, b };
    };

    let fit = wls(new Array(n).fill(1));
    let scale = scaleFloor;
    for (let iter = 0; iter < iterations; iter++) {
        const resid = y.map((v, i) => v - (fit.a + fit.b * (i - xMean)));
        const abs = resid.map(Math.abs).sort((p, q) => p - q);
        const mid = abs.length >> 1;
        const mad = abs.length % 2 === 1 ? abs[mid] : (abs[mid - 1] + abs[mid]) / 2;
        let s = 1.4826 * mad;
        if (mode === 'df') s = s * Math.sqrt(n / Math.max(1, n - 2));
        else if (mode === 'mscale') s = solveMScale(resid, c, s, scaleFloor);
        s = Math.max(s, scaleFloor);
        scale = s;
        const w = resid.map((r) => Math.min(1, (c * s) / Math.max(Math.abs(r), 1e-12)));
        const next = wls(w);
        const moved = Math.abs(next.b - fit.b);
        fit = next;
        if (moved < 1e-12) break;
    }

    // Outlier fraction at the final fit (sklearn outliers_ analogue).
    let outliers = 0;
    for (let i = 0; i < n; i++) {
        const r = y[i] - (fit.a + fit.b * (i - xMean));
        if (Math.abs(r) > c * scale) outliers++;
    }

    let slope = fit.b * 100;
    if (Number.isFinite(slope) && Math.abs(slope) < zeroEpsilon) slope = 0;
    if (!Number.isFinite(slope)) return null;
    return { slopePct: slope, scale, outlierFraction: outliers / n };
}

/**
 * Build the `(series, index, lookbackBars)` estimator the reset replay expects,
 * accumulating the mean outlier fraction and scale across calls in `.stats`.
 */
export function createHuberEstimator(
    mode: HuberScaleMode = 'none',
    hub: HuberConsts = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER,
): HuberEstimator {
    const stats: HuberEstimatorStats = { calls: 0, outlierFractionSum: 0, scaleSum: 0 };
    const fn = ((amaValues: unknown, index: number, lookbackBars: unknown) => {
        const d = huberSlopeCore(amaValues, index, lookbackBars, mode, hub);
        if (d == null) return null;
        stats.calls++;
        stats.outlierFractionSum += d.outlierFraction;
        stats.scaleSum += d.scale;
        return d.slopePct;
    }) as HuberEstimator;
    fn.stats = stats;
    return fn;
}

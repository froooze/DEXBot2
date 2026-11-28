'use strict';

import { MARKET_ADAPTER } from '../../../modules/constants.js';

/**
 * Dynamic weight per-bar series — canonical implementation shared by the live
 * market adapter service, the research test harness, and the browser-embedded
 * dynamic-weight chart script.
 *
 * Computes the per-bar AMA/Kalman offset channels, the alpha-blended combined
 * series, the pre-gain dead-band gate, the final gain/clamp, and the signal
 * confirmation latch — the exact shape both the live `_computeDynamicWeights`
 * and the interactive research chart render.
 *
 * The pure functions below stay self-contained so the chart generators can embed
 * their exact source via fn.toString(). The one shared config they read — the
 * canonical Huber-slope parameters — is centralised in
 * MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER and aliased here as AMA_SLOPE_HUBER;
 * generated HTML declares the same const from the same constant. Node callers
 * keep their existing import path through strategies/ama_slope_model.ts.
 */

const AMA_SLOPE_HUBER = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER;

interface HuberParams {
    C: number;
    ITERATIONS: number;
    SCALE_FLOOR: number;
    ZERO_EPSILON: number;
}

interface DynamicWeightSeriesInputs {
    amaValues: unknown[] | null | undefined;
    kalmanVelocityPct?: Array<number | null> | null;
    kalmanDisplacementPct?: Array<number | null> | null;
    kalmanIsReady?: Array<boolean | null> | null;
    regimeMultipliers?: Array<number | null> | null;
    /** Optional pre-computed AMA slope series (%/bar). When supplied, the AMA
     *  offset channel uses these values instead of re-fitting the Huber window;
     *  null entries are skipped. The live adapter passes its EMA-shaped series;
     *  callers that omit it keep the raw Huber estimator. */
    amaSlopePctSeries?: Array<number | null> | null;
    lookbackBars: number;
    amaErPeriod: number;
    amaClipThreshold: number;
    kalClipThreshold: number;
    neutralZonePct: number;
    amaMaxSlopePct: number;
    kalmanMaxSlopePct: number;
    offsetClamp: number;
    dispScaleMinPct: number;
    alpha: number;
    dw: number;
    gain: number;
    minOutputThreshold: number;
    signalConfirmBars: number;
    clampFinalOutput?: boolean;
}

function computeAverageAmaSlopePct(current: number, past: number, lookbackBars: unknown): number | null {
    const safeLookbackBars = Number.isFinite(Number(lookbackBars)) && Number(lookbackBars) > 0
        ? Math.ceil(Number(lookbackBars))
        : 1;
    if (!Number.isFinite(current) || !Number.isFinite(past) || past === 0) {
        return null;
    }
    return ((current - past) / past * 100) / safeLookbackBars;
}

/**
 * Canonical AMA slope series with an optional recursive EMA applied to the
 * Huber slope values (one step per bar). This is the single definition used by
 * the live market adapter, the DW research chart, the TradingView grid-reset
 * replay and range band (all embedded verbatim via embedFunctionSources), and
 * the research runner.
 *
 * Stateless replay over the full AMA history: alpha=1 returns the raw Huber
 * slope bit-for-bit; lower alpha adds (1-alpha)/alpha bars of lag. Output is
 * index-aligned with `amaValues`, with nulls before er+lookback readiness and
 * for any unusable window. No module-scope references so fn.toString()
 * embedding stays valid — computeHuberWindowSlopePct is embedded alongside it.
 *
 * @param amaValues Full AMA series (index-addressable).
 * @param erPeriod  AMA ER period (defines the warmup window with lookbackBars).
 * @param lookbackBars Huber window length in bars.
 * @param alpha     EMA alpha in (0, 1]; 1 disables smoothing.
 * @param estimator Optional per-bar slope estimator (defaults to the canonical
 *                  Huber fit). Grid-reset research can pass its own estimator
 *                  while still sharing this single EMA recursion.
 */
function computeAmaSlopeEmaSeries(
    amaValues: unknown[] | null | undefined,
    erPeriod: number,
    lookbackBars: number,
    alpha: number,
    estimator: (values: unknown[] | null | undefined, index: number, bars: unknown) => number | null = computeHuberWindowSlopePct,
): Array<number | null> {
    const n = Array.isArray(amaValues) ? amaValues.length : 0;
    const out: Array<number | null> = new Array(n).fill(null);
    const bars = Number.isFinite(lookbackBars) && lookbackBars > 0 ? Math.ceil(lookbackBars) : 0;
    // A zero window is unusable for Huber, but research can script a custom
    // estimator (e.g. grid_reset_sim gate tests) that ignores the window.
    if (bars < 1 && estimator === computeHuberWindowSlopePct) return out;
    const er = Number.isFinite(erPeriod) && erPeriod > 0 ? Math.ceil(erPeriod) : 0;
    const a = Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : 1;
    let prev: number | null = null;
    for (let i = er + bars; i < n; i++) {
        const raw = estimator(amaValues, i, bars);
        if (raw == null || !Number.isFinite(raw)) continue;
        // Keep alpha=1 bit-for-bit identical to the raw estimator: the
        // recurrence algebra (prev + 1*(raw-prev)) can differ by one ulp.
        prev = a === 1 || prev === null ? raw : prev + a * (raw - prev);
        out[i] = prev;
    }
    return out;
}

/**
 * Per-bar AMA trend in %/bar over `lookbackBars`, fitted as a Huber-robust
 * linear regression of ln(AMA) against bar index (uniform weights, no kernel).
 *
 * This is the canonical slope used by the live adapter (dynamic weight series,
 * AMA slope model, both clip paths), the grid-reset replay and the research
 * charts, which embed this exact source via `embedFunctionSources`. One
 * definition, one set of numbers — do not re-implement it per caller. Selected
 * experimentally on a real 1h pool: it is the smoothest robust option measured
 * (second-difference energy ~25x lower than the median's, max |dSlope|
 * comparable to the two-point endpoint), because its influence function is
 * continuous and bounded rather than an order statistic.
 *
 * The fit is local linear over `lookbackBars` intervals (bars+1 points, the same
 * 16h span the endpoint uses), so a window-wide regime change tilts the line
 * continuously instead of waiting for a majority, and a lone off-trend spike is
 * bounded rather than given full endpoint weight. Output is the log-return per
 * bar x 100. That differs from the arithmetic per-bar return by ~beta^2/2,
 * which is negligible at the sub-0.1 %/bar magnitudes the defaults use (order
 * 1e-9 at 0.1 %/bar) but grows quadratically with the reading — ln(1.06)*100 =
 * 5.83, ~3% below a 6%/bar arithmetic rate. A pre-existing user override of
 * maxSlopePct / neutralZonePct was tuned against the arithmetic reading, so a
 * saturated override now clamps a hair tighter than before.
 *
 * Persistence note: `slopePct` is a different quantity from any pre-Huber
 * reading (log-return regression vs the old median/endpoint). The first cycle
 * after deploying compares a Huber reading against the still-persisted old
 * baseline (botState.gridRangeScalingAmaSlope); the two magnitudes agree
 * closely, so that delta sits below the reset gate on ~98% of bars (p50
 * 0.00043, p90 0.00277 %/bar) — roughly one whitelisted bot in fifty costs one
 * extra recenter, once. No version marker is persisted to suppress it.
 *
 * Parameters come from MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER (aliased as
 * AMA_SLOPE_HUBER; injected into generated charts). `hub` is overridable only so
 * tests can prove the values are threaded through — production never passes it.
 *
 * @param amaValues Full AMA series (index-addressable).
 * @param index     Bar to measure at (evaluated at the window edge).
 * @param lookbackBars Window length in bars (fixed at 16 for every estimator).
 * @param hub       Parameter block; defaults to the centralized constant.
 * @returns %/bar, or null when the window is unusable.
 */
function computeHuberWindowSlopePct(amaValues: unknown[] | null | undefined, index: number, lookbackBars: unknown, hub: Partial<HuberParams> = AMA_SLOPE_HUBER): number | null {
    const bars = Number.isFinite(lookbackBars) && Number(lookbackBars) > 0
        ? Math.ceil(Number(lookbackBars))
        : 0;
    if (!Array.isArray(amaValues) || bars < 1) return null;
    if (!Number.isFinite(index) || index < bars || index >= amaValues.length) return null;

    // Local linear fit needs the full window at both ends; reject non-positive
    // values anywhere in the window (Number(null) is 0) before fitting.
    // The window is exactly [index - bars, index], so n is known up front and
    // y can be pre-sized (no per-bar push growth).
    const n = bars + 1;
    const y: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const v = Number(amaValues[index - bars + i]);
        if (!Number.isFinite(v) || v <= 0) return null;
        y[i] = Math.log(v);
    }
    // Fill any missing field from the canonical constant. Production never passes
    // `hub` (the default is the constant), so this only guards a partial override
    // from silently skipping the IRLS loop or injecting NaN weights.
    const hubC = Number.isFinite(hub?.C) ? (hub?.C as number) : AMA_SLOPE_HUBER.C;
    const hubIterations = Number.isFinite(hub?.ITERATIONS) ? (hub?.ITERATIONS as number) : AMA_SLOPE_HUBER.ITERATIONS;
    const hubScaleFloor = Number.isFinite(hub?.SCALE_FLOOR) ? (hub?.SCALE_FLOOR as number) : AMA_SLOPE_HUBER.SCALE_FLOOR;
    const hubZeroEpsilon = Number.isFinite(hub?.ZERO_EPSILON) ? (hub?.ZERO_EPSILON as number) : AMA_SLOPE_HUBER.ZERO_EPSILON;

    // Weighted least squares of y on the CENTERED index x_i = i - (n-1)/2. The
    // x-centering keeps the normal equations well-conditioned, but the FULL
    // two-variable solution is required: with non-uniform Huber weights the
    // cross term Sx != 0, so b = Sxy/Sxx alone is not the minimiser (it would
    // not decrease the objective). Kept inline (and therefore self-contained
    // for chart embedding): { a, b } with b the log-slope.
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

    // Scratch buffers are reused across the IRLS passes instead of allocating a
    // fresh resid/abs/w triple (plus the sort copy) every iteration. This is the
    // per-bar hot path of the dynamic-weight series, so the allocations dominate
    // the fit arithmetic at the 16-bar window. The loops keep the original
    // operation order so the returned slope is bit-for-bit unchanged.
    const ones = new Array(n).fill(1);
    const resid = new Array(n);
    const abs = new Array(n);
    const w = new Array(n);

    let fit = wls(ones); // OLS initialisation
    for (let iter = 0; iter < hubIterations; iter++) {
        for (let i = 0; i < n; i++) resid[i] = y[i] - (fit.a + fit.b * (i - xMean));
        for (let i = 0; i < n; i++) abs[i] = Math.abs(resid[i]);
        abs.sort((p, q) => p - q);
        const mid = n >> 1;
        const mad = n % 2 === 1 ? abs[mid] : (abs[mid - 1] + abs[mid]) / 2;
        // Floor the robust scale. On piecewise-perfect data (a pure ramp, a
        // constant series) the MAD can collapse to ~0, which makes the Huber
        // weights degenerate and the weighted fit unstable; the floor is far
        // below any real per-bar signal (the reset gate is ~7e-5 here).
        const s = Math.max(1.4826 * mad, hubScaleFloor);
        for (let i = 0; i < n; i++) w[i] = Math.min(1, (hubC * s) / Math.max(Math.abs(resid[i]), 1e-12));
        const next = wls(w);
        const moved = Math.abs(next.b - fit.b);
        fit = next;
        if (moved < 1e-12) break;
    }
    const slope = fit.b * 100;
    // A constant window has zero true slope, but centred WLS leaves ~1e-14 of
    // rounding, which would flip a zero neutral zone to a trend (UP/DOWN).
    // Snap anything below ZERO_EPSILON (far under the reset gate).
    if (Number.isFinite(slope) && Math.abs(slope) < hubZeroEpsilon) return 0;
    return Number.isFinite(slope) ? slope : null;
}

function echoLatchSeries(appliedSeries: number[], preGainSeries: number[] | null | undefined, confirmBars: unknown) {
    const n = Array.isArray(appliedSeries) ? appliedSeries.length : 0;
    const echoedAppliedSeries = new Array(n).fill(0);
    const echoedPreGainSeries = new Array(n).fill(0);

    const safeConfirmBars = Math.max(0, Math.min(5, Math.round(Number(confirmBars))));
    if (safeConfirmBars === 0) {
        for (let i = 0; i < n; i++) {
            echoedAppliedSeries[i] = appliedSeries[i];
            echoedPreGainSeries[i] = preGainSeries?.[i];
        }
        return { echoedAppliedSeries, echoedPreGainSeries };
    }

    let latchedSign = 0;
    let pendingSign = 0;
    let pendingCount = 0;
    let latchedOff = 0;
    let latchedGatedOff: number | undefined = 0;
    for (let i = 0; i < n; i++) {
        const raw = appliedSeries[i];
        const sign = raw > 0 ? 1 : raw < 0 ? -1 : 0;
        if (sign === latchedSign) {
            pendingSign = 0;
            pendingCount = 0;
            latchedOff = raw;
            latchedGatedOff = preGainSeries?.[i];
        } else {
            if (pendingSign !== sign) {
                pendingSign = sign;
                pendingCount = 1;
            } else {
                pendingCount++;
            }
            if (pendingCount >= safeConfirmBars) {
                latchedSign = sign;
                pendingSign = 0;
                pendingCount = 0;
                latchedOff = raw;
                latchedGatedOff = preGainSeries?.[i];
            }
        }
        echoedAppliedSeries[i] = latchedOff;
        echoedPreGainSeries[i] = latchedGatedOff;
    }

    return { echoedAppliedSeries, echoedPreGainSeries };
}

function roundToN(value: number, factor: number): number {
    if (!Number.isFinite(value)) return NaN;
    return Math.round(value * factor) / factor;
}

function computeDynamicWeightSeries(inputs: DynamicWeightSeriesInputs) {
    const {
        amaValues,
        kalmanVelocityPct,
        kalmanDisplacementPct,
        kalmanIsReady,
        regimeMultipliers,
        amaSlopePctSeries = null,
        lookbackBars,
        amaErPeriod,
        amaClipThreshold,
        kalClipThreshold,
        neutralZonePct,
        amaMaxSlopePct,
        kalmanMaxSlopePct,
        offsetClamp,
        dispScaleMinPct,
        alpha,
        dw,
        gain,
        minOutputThreshold,
        signalConfirmBars,
        clampFinalOutput = true,
    } = inputs;

    const n = Array.isArray(amaValues) ? amaValues.length : 0;
    const channelNorm = Math.max(Math.abs(offsetClamp), 1e-9);
    const amaReadyBar = lookbackBars + Math.max(0, Math.ceil(amaErPeriod));
    const amaOffsets = new Array(n).fill(0);
    const kalmanOffsets = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
        if (i < amaReadyBar) continue;
        // Research charts can supply an EMA-smoothed slope series; without it,
        // use the canonical Huber fit as before.
        const sp = amaSlopePctSeries
            ? (amaSlopePctSeries[i] ?? null)
            : computeHuberWindowSlopePct(amaValues, i, lookbackBars);
        if (sp == null || !Number.isFinite(sp)) continue;
        const csp = Math.max(-amaClipThreshold, Math.min(amaClipThreshold, sp));
        // Inclusive dead-band boundary (matches computeAmaSlopeWeights): a
        // slope exactly at neutralZonePct counts as neutral. With the default
        // neutralZonePct of 0 this also keeps exact-zero slopes out of the
        // offset channel.
        if (Math.abs(csp) <= neutralZonePct) continue;
        amaOffsets[i] = Math.max(-offsetClamp, Math.min(offsetClamp, (csp / amaMaxSlopePct) * offsetClamp));
    }

    for (let i = 0; i < n; i++) {
        const vp = kalmanVelocityPct?.[i];
        const dp = kalmanDisplacementPct?.[i];
        if (!kalmanIsReady?.[i] || vp == null || dp == null) continue;
        const clippedV = Math.max(-kalClipThreshold, Math.min(kalClipThreshold, vp));
        if (Math.abs(clippedV) < neutralZonePct) continue;
        const dispScale = Math.max(1e-6, dispScaleMinPct);
        const dispConf = Math.min(Math.abs(dp) / dispScale, 1.0);
        const momAlign = Math.max(0, (clippedV * dp) / (Math.abs(clippedV) * Math.abs(dp) + 1e-10));
        const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
        kalmanOffsets[i] = Math.max(-offsetClamp, Math.min(offsetClamp, (composite / kalmanMaxSlopePct) * offsetClamp));
    }

    const combinedOffSeries = new Array(n).fill(0);
    const gatedOffSeries = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const blendedOff = (alpha * (amaOffsets[i] / channelNorm) + (1 - alpha) * (kalmanOffsets[i] / channelNorm));
        const regimeAdjusted = blendedOff * (regimeMultipliers?.[i] ?? 1.0);
        const gatedOff = Math.abs(regimeAdjusted) < minOutputThreshold ? 0 : regimeAdjusted;
        const applied = clampFinalOutput
            ? Math.max(-offsetClamp, Math.min(offsetClamp, gatedOff * gain))
            : (gatedOff * gain);
        gatedOffSeries[i] = gatedOff;
        combinedOffSeries[i] = roundToN(applied, 1000);
    }

    const latched = echoLatchSeries(combinedOffSeries, gatedOffSeries, signalConfirmBars);

    return {
        amaOffsets,
        kalmanOffsets,
        combinedOffSeries,
        gatedOffSeries,
        echoedOffSeries: latched.echoedAppliedSeries,
        echoedGatedOffSeries: latched.echoedPreGainSeries,
    };
}

/**
 * Percentile lookup over an already-sorted ascending array. Returns `Infinity`
 * for an empty pool so callers treat it as "no clipping". Both the percentile
 * and the resulting index are clamped so a misconfigured clipPercentile above
 * 100 cannot select a negative (undefined) entry.
 */
function percentileFromSorted(sorted: number[], clipPercentile: number): number {
    if (!Array.isArray(sorted) || sorted.length === 0) return Infinity;
    const pct = Math.min(clipPercentile, 100);
    const idx = Math.max(0, Math.min(Math.floor((100 - pct) / 100 * sorted.length), sorted.length - 1));
    return sorted[idx];
}

/**
 * Canonical AMA slope clip threshold used to bound `rawSlopeOffset` in
 * `computeAmaSlopeWeights` — one logic path shared by the live market adapter
 * service, the research runners, and the browser-embedded chart script.
 *
 * The threshold is the `(100 - clipPercentile)`-th percentile of
 * `|average AMA slope %|` over the AMA history (skipping the ER + lookback
 * warmup window). Returns `Infinity` when clipping is disabled or there is
 * insufficient history.
 *
 * Embedding note: lives in this import-free module so fn.toString() injection
 * into generated research charts stays valid after transpilation.
 *
 * For per-bar research loops prefer {@link createAmaSlopeClipTracker}, which
 * yields identical thresholds while maintaining a single sorted pool
 * incrementally (O(n) per push for the sorted insertion, O(n²) total) instead
 * of re-deriving and re-sorting the whole slope history each bar.
 *
 * @param amaValues   Full AMA series for the cycle.
 * @param erPeriod    AMA ER period (defines the warmup window with lookbackBars).
 * @param lookbackBars Bars averaged per slope sample.
 * @param clipPercentile Percentile to clip at (e.g. 10 → use 90th pct). 0 disables.
 */
function computeAmaSlopeClipThreshold(
    amaValues: unknown[] | null | undefined,
    erPeriod: number,
    lookbackBars: number,
    clipPercentile: number,
): number {
    if (!Number.isFinite(clipPercentile) || clipPercentile <= 0) return Infinity;
    if (!Array.isArray(amaValues)) return Infinity;
    const readyBars = Math.ceil(erPeriod) + lookbackBars;
    if (amaValues.length <= readyBars) return Infinity;

    const slopes: number[] = [];
    for (let i = readyBars; i < amaValues.length; i++) {
        const s = computeHuberWindowSlopePct(amaValues, i, lookbackBars);
        if (Number.isFinite(s)) slopes.push(Math.abs(s as number));
    }
    if (slopes.length === 0) return Infinity;

    const sorted = slopes.slice().sort((a, b) => a - b);
    // Clamp both the percentile and index: values above 100 would otherwise
    // produce a negative index (undefined threshold -> NaN clip bounds).
    const pct = Math.min(clipPercentile, 100);
    const idx = Math.max(0, Math.min(Math.floor((100 - pct) / 100 * sorted.length), sorted.length - 1));
    return sorted[idx];
}

/**
 * Incremental equivalent of calling {@link computeAmaSlopeClipThreshold} on
 * every growing prefix of the AMA series. Feed exactly one AMA value per bar
 * via `push`; it returns the same threshold the batch function would return
 * for `amaValues.slice(0, consumed)`, without re-deriving the whole slope pool
 * each call. Maintains one sorted pool with binary-search insertion: O(log n)
 * search + O(n) array shift per push, O(n²) total — a constant-factor win over
 * the batch-per-bar loop's O(n² log n), and the same bound at research scale.
 *
 * Non-finite values keep their position in the sequence (they invalidate only
 * the pairs they belong to), matching the batch function's per-pair guards.
 */
function createAmaSlopeClipTracker(erPeriod: number, lookbackBars: number, clipPercentile: number) {
    const enabled = Number.isFinite(clipPercentile) && clipPercentile > 0;
    const readyBars = Math.ceil(erPeriod) + lookbackBars;
    const buffer: number[] = [];
    const sorted: number[] = [];

    return {
        push(value: number): number {
            buffer.push(value);
            if (!enabled) return Infinity;
            const i = buffer.length - 1;
            if (i >= readyBars) {
                const s = computeHuberWindowSlopePct(buffer, i, lookbackBars);
                if (Number.isFinite(s)) {
                    const v = Math.abs(s as number);
                    let lo = 0;
                    let hi = sorted.length;
                    while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (sorted[mid] < v) lo = mid + 1; else hi = mid;
                    }
                    sorted.splice(lo, 0, v);
                }
            }
            return percentileFromSorted(sorted, clipPercentile);
        },
    };
}

export {
    computeDynamicWeightSeries,
    computeAverageAmaSlopePct,
    computeAmaSlopeEmaSeries,
    computeHuberWindowSlopePct,
    echoLatchSeries,
    roundToN,
    computeAmaSlopeClipThreshold,
    createAmaSlopeClipTracker,
    // Exported so chart generators can embed the clip tracker's exact
    // dependency set via fn.toString() (see embedFunctionSources): the tracker
    // itself calls this, and embedding one without the other breaks the page.
    percentileFromSorted,
}

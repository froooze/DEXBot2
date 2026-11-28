'use strict';

import { clamp } from '../../../modules/order/utils/math.js';
import { MARKET_ADAPTER } from '../../../modules/constants.js';
import { roundTo } from '../../../modules/order/utils/math.js';
import {
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} from '../config_normalizers.js';
import { computeVolatilityShift } from './volatility_shift.js';
// Canonical AMA slope % lives in dynamic_weight_series.ts (self-contained so the
// chart generators can embed its exact source); re-exported here for compat.
import {
    computeAverageAmaSlopePct,
    computeAmaSlopeEmaSeries,
    computeHuberWindowSlopePct,
    computeAmaSlopeClipThreshold,
    createAmaSlopeClipTracker,
} from './dynamic_weight_series.js';



const _DEFAULT_AMA_KEY = MARKET_ADAPTER.DEFAULT_AMA_KEY as keyof typeof MARKET_ADAPTER.AMAS;
const DEFAULT_ER_PERIOD = MARKET_ADAPTER.AMAS[_DEFAULT_AMA_KEY].erPeriod;

/**
 * Compute AMA slope and volatility offsets from the AMA series.
 *
 * Two independent additive factors:
 *   slopeOffset (asymmetric): AMA slope magnitude → trend direction
 *   symmetricDelta (symmetric): ATR/price ratio → noise level
 *
 * @param {number[]} amaValues           Full AMA series (output of calculateAMA)
 * @param {number}   weightVariance      ATR(period) / amaPrice  (0 = no volatility)
 * @param {Object}   [opts]              Market-reading tuning — no offset bounds here
 * @param {number}   [opts.lookbackBars=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS]  Bars to look back for slope
 * @param {number}   [opts.maxSlopePct=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT]  Average per-bar slope % that saturates slopeOffset
 * @param {number}   [opts.neutralZonePct=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT]  Dead-band around zero average slope
 * @param {number}   [opts.volatilityExponent=1.0]      Exponent for ATR-based penalty
 * @param {number}   [opts.volatilityScaleX=10.0]       Scale factor penalty (10.0 = normal start)
 * @param {number}   [opts.volatilityThreshold=0.1]      Minimum |symmetricDelta| before penalty applies
 * @param {number}   [opts.erPeriod=DEFAULT_ER_PERIOD]  AMA warm-up bars to skip in isReady guard
 * @param {number}   [opts.maxSlopeOffset=MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP]  Per-bot cap on buy/sell asymmetry offset
 * @param {number}   [opts.maxVolatilityOffset=MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP]  Per-bot cap on volatility shift
 * @param {number}   [opts.clipThreshold=Infinity]      Pre-computed clip threshold from slope history (percentile clipping is done by the caller)
 * @param {number[]} [opts.slopePctSeries]              Optional EMA-shaped slope series, index-aligned with amaValues; when set, its last value replaces the raw Huber reading
 * @param {number}   [opts.currentSlopePct]             Explicit current-bar slope %; overrides slopePctSeries. Use this when amaValues is a rolling slice whose indices no longer line up with the full series.
 * @returns {{ slopeOffset, rawSlopeOffset, symmetricDelta, slopePct, clippedSlopePct, confidence, trend, isReady }}
 */
interface AmaSlopeOpts {
    lookbackBars?: unknown;
    maxSlopePct?: unknown;
    neutralZonePct?: unknown;
    volatilityExponent?: unknown;
    volatilityScaleX?: unknown;
    volatilityThreshold?: unknown;
    erPeriod?: unknown;
    maxSlopeOffset?: unknown;
    maxVolatilityOffset?: unknown;
    clipThreshold?: unknown;
    /** Optional pre-computed (EMA-shaped) slope series from computeAmaSlopeEmaSeries.
     *  Must be index-aligned with amaValues: the element at N-1 is used for a
     *  full-length call. When supplied, the last element replaces the raw Huber
     *  reading so the published slope, offset and grid-reset delta all see the
     *  same signal. */
    slopePctSeries?: Array<number | null> | null;
    /** Explicit current-bar slope %. Takes precedence over slopePctSeries.
     *  Prefer this for rolling AMA slices, where indexing a full-length series
     *  by the slice's last position would silently read the warm-up bar.
     *  Named `currentSlopePct` rather than `slopePct` because live callers
     *  spread `cfg.amaSlope` (open-ended config) into these options. */
    currentSlopePct?: number | null;
    [key: string]: unknown;
}

function computeAmaSlopeWeights(amaValues: unknown, weightVariance: number, opts: AmaSlopeOpts = {}) {
    const lookbackBars = Number.isFinite(Number(opts.lookbackBars)) && Number(opts.lookbackBars) >= 0
        ? Math.ceil(Number(opts.lookbackBars))
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const maxSlopePct = Number(opts.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT);
    const neutralZonePct = Number(opts.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT);
    const volatilityExponent = Number(opts.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT);
    const volatilityScaleX = Number(opts.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT);
    const volatilityThreshold = normalizeVolatilityThreshold(Number(opts.volatilityThreshold));
    const erPeriod = Number.isFinite(Number(opts.erPeriod)) && Number(opts.erPeriod) > 0
        ? Math.ceil(Number(opts.erPeriod))
        : DEFAULT_ER_PERIOD;
    // Reject negative caps outright (a negative cap would silently invert the
    // trend-bias sign); fall back to the default like other invalid values.
    const rawMaxSlopeOffset = Number(opts.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP);
    const maxSlopeOffset = Number.isFinite(rawMaxSlopeOffset) && rawMaxSlopeOffset >= 0
        ? rawMaxSlopeOffset
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
    const maxVolatilityOffset = normalizeMaxVolatilityOffset(Number(opts.maxVolatilityOffset));
    const clipThreshold = Number(opts.clipThreshold ?? Infinity);
    const hasDirectionalOffset = Number.isFinite(maxSlopeOffset) && maxSlopeOffset > 0;
    const safeWeightVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
    const safeVolatilityExponent = Number.isFinite(volatilityExponent) && volatilityExponent >= 0
        ? volatilityExponent
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const safeVolatilityScaleX = Number.isFinite(volatilityScaleX) && volatilityScaleX >= 0
        ? volatilityScaleX
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;

    const notReady = {
        isReady: false,
        slopeOffset: 0,
        rawSlopeOffset: 0,
        symmetricDelta: 0,
        slopePct: 0,
        clippedSlopePct: 0,
        confidence: 0,
        trend: 'NEUTRAL',
    };

    // 1. Guard: need ER window + lookback + current bar for valid slope.
    if (!Array.isArray(amaValues) || amaValues.length < erPeriod + lookbackBars + 1) {
        return notReady;
    }

    const N = amaValues.length;

    // 2. Slope percent per bar over the lookback window, as a Huber-robust
    // linear regression of ln(AMA) (canonical: computeHuberWindowSlopePct). The
    // two-point endpoint difference is kept in dynamic_weight_series as the
    // reference definition, but it gives the window-edge bar full weight: a
    // single-bar impulse moves it 7x-70x the reset gate while the robust fit
    // bounds that influence without the lag of a rank-based estimator.
    // Live callers pass the canonical EMA-shaped slope in opts.slopePctSeries;
    // without it this stays the raw Huber reading (e.g. legacy research calls).
    // A rolling AMA slice cannot use the series form: its last index N-1 is the
    // first ready bar of the full history, not the current bar. Those callers
    // pass the aligned value explicitly via opts.currentSlopePct instead.
    // lookback stays a smoothing/lag knob rather than adding gain in sustained
    // trends. The estimator validates every bar in the window (both ends
    // strictly positive), so it subsumes the old two-endpoint guard here.
    const series = opts.slopePctSeries;
    const slopePct = opts.currentSlopePct !== undefined
        ? opts.currentSlopePct
        : (Array.isArray(series) && series.length >= N
            ? series[N - 1]
            : computeHuberWindowSlopePct(amaValues, N - 1, lookbackBars));
    if (slopePct == null || !Number.isFinite(slopePct)) {
        return notReady;
    }

    // 2b. Percentile clip — symmetric clip on slope magnitude
    const clippedSlopePct = Math.max(-(clipThreshold as number), Math.min((clipThreshold as number), slopePct as number));

    // 3. Slope offset (asymmetric) — based on clipped slope.
    //    Inclusive boundary (<=) matches the canonical per-bar series in
    //    dynamic_weight_series.ts, and with the default neutralZonePct of 0
    //    it keeps exact-zero slopes NEUTRAL instead of flipping to DOWN.
    let slopeOffset;
    let trend;
    if (Math.abs(clippedSlopePct) <= neutralZonePct) {
        slopeOffset = 0;
        trend = 'NEUTRAL';
    } else {
        slopeOffset = clamp(clippedSlopePct / maxSlopePct, -1, 1) * maxSlopeOffset;
        trend = clippedSlopePct > 0 ? 'UP' : 'DOWN';
    }

    // 4. Confidence derived from slope offset magnitude (0–100)
    const roundedSlopeOffset = roundTo(slopeOffset, 100);
    const confidence = hasDirectionalOffset
        ? Math.round((Math.abs(slopeOffset) / maxSlopeOffset) * 100)
        : 0;

    // 5. Volatility penalty — symmetric downward shift from ATR/price ratio.
    //    Canonical implementation shared with the volatility research tool and
    //    the browser-embedded chart scripts (see strategies/volatility_shift.ts).
    const shift = computeVolatilityShift(safeWeightVariance, {
        exponent: safeVolatilityExponent,
        scaleX: safeVolatilityScaleX,
        threshold: volatilityThreshold,
        clampValue: maxVolatilityOffset,
    });

    const roundedSymmetricDelta = (roundTo(shift.symmetricDelta, 100)) || 0;

    return {
        slopeOffset: roundedSlopeOffset,
        rawSlopeOffset: slopeOffset,
        symmetricDelta: roundedSymmetricDelta,
        slopePct,
        clippedSlopePct,
        confidence,
        trend,
        isReady: true,
    };
}

// computeAmaSlopeClipThreshold and createAmaSlopeClipTracker live in
// dynamic_weight_series.ts (self-contained so the chart generators can embed
// their exact source); re-exported here so Node callers keep this import path.
export {
    computeAmaSlopeWeights,
    computeAverageAmaSlopePct,
    computeAmaSlopeEmaSeries,
    computeHuberWindowSlopePct,
    computeAmaSlopeClipThreshold,
    createAmaSlopeClipTracker,
}


'use strict';

function formatLogNumber(value: unknown, digits = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function formatAdaptiveLogNumber(value: unknown, coarseDigits = 2, fineDigits = 4, fineThreshold = 0.1) {
    if (!Number.isFinite(value)) return 'n/a';
    return Math.abs(Number(value)) < fineThreshold
        ? Number(value).toFixed(fineDigits)
        : Number(value).toFixed(coarseDigits);
}

function formatLogPercent(value: unknown, digits = 2) {
    return Number.isFinite(value) ? `${Number(value).toFixed(digits)}%` : 'n/a';
}

function formatLogPair(first: unknown, second: unknown, digits = 2) {
    return `${formatLogNumber(first, digits)}/${formatLogNumber(second, digits)}`;
}

function formatAmaTuple(ama: unknown) {
    if (!ama) return 'n/a';
    const a = ama as { erPeriod?: unknown; fastPeriod?: unknown; slowPeriod?: unknown };
    return `${formatLogNumber(a.erPeriod, 0)}/${formatLogNumber(a.fastPeriod, 1)}/${formatLogNumber(a.slowPeriod, 1)}`;
}

function formatAsymmetryFactor(value: unknown, digits = 1) {
    return Number.isFinite(value) ? `${(Number(value) * 100).toFixed(digits)}%` : 'n/a';
}

function buildWeightSummary(weights: unknown) {
    const w = weights as { sell?: unknown; buy?: unknown } | null | undefined;
    return w ? ` weights(sell/buy)=${formatLogPair(w.sell, w.buy, 2)}` : '';
}

function buildDynamicWeightInputsLog(meta: unknown, amaConfig: unknown) {
    const m = meta as Record<string, unknown> | null | undefined;
    return [
        `ama=${formatAmaTuple(amaConfig)}`,
        `base=${formatLogPair(m?.staticSell, m?.staticBuy, 2)}`,
        `clamp=${formatLogPair(m?.maxSlopeOffset, m?.maxVolatilityOffset, 2)}`,
        `atr=${formatLogNumber(m?.atrPeriod, 0)}`,
        `confirm=${Number.isFinite(Number(m?.signalConfirmBars)) ? Math.round(Number(m?.signalConfirmBars)) : 'n/a'}`,
    ].join(' | ');
}

function buildDynamicWeightTuningLog(meta: unknown) {
    const m = meta as Record<string, unknown> | null | undefined;
    return [
        `slopeMax=${formatAdaptiveLogNumber((m?.amaSlope as { maxSlopePct?: unknown } | null | undefined)?.maxSlopePct, 2, 4)}`,
        `ema=${formatAdaptiveLogNumber((m?.amaSlope as { emaAlpha?: unknown } | null | undefined)?.emaAlpha, 2, 3)}`,
        `kalmanMax=${formatLogNumber((m?.kalmanSlope as { maxSlopePct?: unknown } | null | undefined)?.maxSlopePct, 2)}`,
        `alpha=${formatLogNumber(m?.alpha, 2)}`,
        `dw=${formatLogNumber(m?.dw, 2)}`,
        `gain=${formatLogNumber(m?.gain, 2)}`,
        `vol(thr/exp/x)=${formatLogNumber(m?.volatilityThreshold, 2)}/${formatLogNumber(m?.volatilityExponent, 2)}/${formatLogNumber(m?.volatilityScaleX, 2)}`,
        `clip=${formatLogPercent(m?.clipPercentile, 0)}`,
        `nz=${formatAdaptiveLogNumber(m?.neutralZonePct, 2, 4)}`,
        `minOut=${formatLogNumber(m?.minOutputThreshold, 2)}`,
        `reg(sens/abs)=${formatLogNumber(m?.regimeSensitivity, 2)}/${formatLogNumber(m?.absoluteThreshold, 2)}`,
        `kalman(sm/disp/th/span)=${formatLogNumber(m?.kalmanSmoothPct, 2)}/${formatLogNumber(m?.kalmanDispScaleMult, 2)}/${formatLogNumber(m?.kalmanDispThresholdMult, 2)}/${formatLogNumber(m?.kalmanSmoothSpanPct, 2)}`,
    ].join(' | ');
}

function buildAsymmetricBoundsLog(meta: unknown) {
    const m = meta as Record<string, unknown> | null | undefined;
    return `raw=${formatAsymmetryFactor(m?.rawAsymmetryFactor, 2)}, applied=${formatAsymmetryFactor(m?.appliedAsymmetryFactor, 2)}, maxAsym=${formatAsymmetryFactor(m?.maxAsymmetryFactor, 0)}`;
}

function buildStartupDefaultsLog(defaultAma: unknown, defaultConfig: unknown, marketAdapterCfg: unknown) {
    const c = defaultConfig as { weightDistribution?: { sell?: unknown; buy?: unknown } } | null | undefined;
    const cfg = marketAdapterCfg as Record<string, unknown> | null | undefined;
    return `  defaults: ama=${formatAmaTuple(defaultAma)} | `
        + `weightFallback=${formatLogPair(c?.weightDistribution?.sell, c?.weightDistribution?.buy, 2)} | `
        + `dynamicBase=explicit-only | `
        + `clamp=${formatLogPair(cfg?.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP, cfg?.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP, 2)} | `
        + `asymCap=${formatAsymmetryFactor(cfg?.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR, 0)}`;
}

export { formatLogPercent, buildWeightSummary, buildDynamicWeightInputsLog, buildDynamicWeightTuningLog, buildAsymmetricBoundsLog, buildStartupDefaultsLog }


'use strict';

import { MARKET_ADAPTER } from '../../modules/constants.js';


function normalizeAtrPeriod(period: unknown, defaultValue = MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT) {
    // Treat null/undefined/empty as "not provided" BEFORE Number() coercion:
    // Number(null) === 0 would otherwise turn explicit JSON null into a
    // fallback hit instead of using the default.
    if (period == null || period === '') return defaultValue;
    const value = Number(period);
    if (!Number.isFinite(value) || value <= 0) return defaultValue;

    const rounded = Math.round(value);
    return Math.max(MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MIN, Math.min(MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MAX, rounded));
}

/**
 * Coerce to a finite, non-negative number, else `defaultValue`. `null`,
 * `undefined` and `''` are treated as "not provided" before `Number()`
 * coercion so explicit JSON null does not become 0. Zero is allowed (it
 * explicitly disables the volatility shift).
 */
function normalizeNonNegative(value: unknown, defaultValue: number) {
    if (value == null || value === '') return defaultValue;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : defaultValue;
}

function normalizeMaxVolatilityOffset(value: unknown, defaultValue = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP) {
    return normalizeNonNegative(value, defaultValue);
}

function normalizeVolatilityThreshold(value: unknown, defaultValue = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD) {
    return normalizeNonNegative(value, defaultValue);
}

/**
 * AMA-slope EMA alpha. 1 = off; finite positive values are clamped to
 * [2/101, 1] (2/101 = 100-bar variance-equivalent). Null, empty, non-finite
 * and non-positive values fall back to the centralized default. Kept here so
 * config, applied value and reported payload agree.
 */
function normalizeAmaSlopeEmaAlpha(value: unknown, defaultValue = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA) {
    if (value == null || value === '') return defaultValue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return defaultValue;
    return Math.max(
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MIN,
        Math.min(MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA_MAX, numeric)
    );
}

export { normalizeAtrPeriod, normalizeMaxVolatilityOffset, normalizeVolatilityThreshold, normalizeAmaSlopeEmaAlpha }


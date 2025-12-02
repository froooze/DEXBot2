// Utility helpers for calculate_orders
function isPercentageString(v) {
    return typeof v === 'string' && v.trim().endsWith('%');
}

function parsePercentageString(v) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    if (Number.isNaN(num)) return null;
    return num / 100.0;
}

function blockchainToFloat(intValue, precision) {
    if (intValue === null || intValue === undefined) return 0;
    const p = Number(precision || 0);
    return Number(intValue) / Math.pow(10, p);
}

function floatToBlockchainInt(floatValue, precision) {
    const p = Number(precision || 0);
    // Return a JS Number integer representing the blockchain integer (not BigInt)
    return Math.round(Number(floatValue) * Math.pow(10, p));
}

function isRelativeMultiplierString(value) {
    return typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value);
}

function parseRelativeMultiplierString(value) {
    if (!isRelativeMultiplierString(value)) return null;
    const cleaned = value.trim().toLowerCase();
    const numeric = parseFloat(cleaned.slice(0, -1));
    return Number.isNaN(numeric) ? null : numeric;
}

function resolveRelativePrice(value, marketPrice, mode = 'min') {
    const multiplier = parseRelativeMultiplierString(value);
    if (multiplier === null || !Number.isFinite(marketPrice) || multiplier === 0) return null;
    if (mode === 'min') return marketPrice / multiplier;
    if (mode === 'max') return marketPrice * multiplier;
    return null;
}

module.exports = {
    isPercentageString,
    parsePercentageString,
    blockchainToFloat,
    floatToBlockchainInt,
    resolveRelativePrice
};


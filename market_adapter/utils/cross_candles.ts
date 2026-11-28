'use strict';
/**
 * SHARED SYNTHETIC CROSS CANDLES
 *
 * Build a `left/right` OHLCV series from two legs quoted against the same
 * third asset (e.g. (TOKENA/USD) / (TOKENB/USD) = TOKENB per TOKENA). Both legs must use
 * the same bucket size and carry the base volume in their sixth column.
 *
 * Aggregation is deliberately conservative: the cross high uses the
 * numerator's high against the denominator's low, and the cross low uses the
 * numerator's low against the denominator's high, then includes open/close so
 * the row stays a valid OHLC bar even when the two legs peak in different
 * buckets. Volume is the numerator leg's base volume (the quote leg's volume
 * is not meaningful in the synthetic base unit).
 *
 * Only exact timestamp matches are crossed. Sources that gap-fill both legs
 * to the same requested range therefore produce a continuous series; sources
 * with independent leading gaps simply drop those buckets instead of inventing
 * a price from a one-sided leg.
 *
 * Pure and browser-safe: no node built-ins, no I/O.
 */

type Candle = number[];

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** Cross two aligned OHLCV rows into `left / right`. Null when either leg is unusable. */
function buildSyntheticCandle(left: unknown, right: unknown): Candle | null {
    const l = asArray(left).map(Number);
    const r = asArray(right).map(Number);
    const leftPrices = [l[1], l[2], l[3], l[4]];
    const rightPrices = [r[1], r[2], r[3], r[4]];
    if (!leftPrices.every((v) => Number.isFinite(v) && v > 0)
        || !rightPrices.every((v) => Number.isFinite(v) && v > 0)) {
        return null;
    }
    const open = l[1] / r[1];
    const close = l[4] / r[4];
    const high = Math.max(l[2] / r[3], open, close);
    const low = Math.min(l[3] / r[2], open, close);
    if (![open, high, low, close].every(Number.isFinite)) return null;
    const volume = Number(l[5] || 0);
    return [l[0], open, high, low, close, Number.isFinite(volume) ? volume : 0];
}

/** Join two candle series on exact timestamps and cross each aligned pair. */
function synthesizeCrossCandles(leftCandles: unknown, rightCandles: unknown): Candle[] {
    const leftRows = asArray(leftCandles).filter((row): row is Candle => Array.isArray(row) && Number.isFinite(Number(row[0])));
    const rightRows = asArray(rightCandles).filter((row): row is Candle => Array.isArray(row) && Number.isFinite(Number(row[0])));
    const leftMap = new Map<number, Candle>(leftRows.map((row) => [Number(row[0]), row]));
    const rightMap = new Map<number, Candle>(rightRows.map((row) => [Number(row[0]), row]));
    const timestamps = Array.from(leftMap.keys()).filter((ts) => rightMap.has(ts)).sort((a, b) => a - b);
    const out: Candle[] = [];
    for (const ts of timestamps) {
        const row = buildSyntheticCandle(leftMap.get(ts), rightMap.get(ts));
        if (row) out.push(row);
    }
    return out;
}

export { buildSyntheticCandle, synthesizeCrossCandles };

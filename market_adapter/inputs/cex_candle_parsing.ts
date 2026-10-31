'use strict';

/**
 * Shared OHLC row parsing for the CEX synthetic-candle adapters.
 *
 * Each exchange returns candle arrays with a different field order (and some,
 * like HTX, also return objects). Centralizing the row validation /
 * timestamp normalization / sorting here keeps every adapter's `parseCandles`
 * a one-liner and guarantees identical handling across exchanges.
 */

export type CandleRow = [number, number, number, number, number, number];

interface OhlcIndexes {
    minLength: number;
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// Declarative field layouts for each exchange's OHLC row arrays.
// [ts, open, high, low, close, volume] — Binance, Bybit, Bitget, OKX, MEXC.
export const OHLC_STANDARD: OhlcIndexes = { minLength: 6, ts: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
// KuCoin and HTX array payloads order close before high/low.
export const OHLC_CLOSE_HIGH_LOW: OhlcIndexes = { minLength: 6, ts: 0, open: 1, high: 3, low: 4, close: 2, volume: 5 };
// Gate candlesticks: [ts, quoteVolume, close, high, low, open, baseVolume, windowClosed].
export const OHLC_GATE: OhlcIndexes = { minLength: 7, ts: 0, open: 5, high: 3, low: 4, close: 2, volume: 6 };
// Kraken OHLC: [tsSeconds, open, high, low, close, vwap, volume, count].
export const OHLC_KRAKEN: OhlcIndexes = { minLength: 7, ts: 0, open: 1, high: 2, low: 3, close: 4, volume: 6 };

/** Normalize a seconds- or milliseconds-epoch timestamp to milliseconds. */
function normalizeTimestamp(raw: unknown): number {
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return Number.NaN;
    return ts >= 1e12 ? Math.trunc(ts) : Math.trunc(ts * 1000);
}

export function parseCandleRow(row: unknown, idx: OhlcIndexes): CandleRow | null {
    if (!Array.isArray(row) || row.length < idx.minLength) return null;
    const ts = normalizeTimestamp(row[idx.ts]);
    const open = Number(row[idx.open]);
    const high = Number(row[idx.high]);
    const low = Number(row[idx.low]);
    const close = Number(row[idx.close]);
    const volume = Number(row[idx.volume]);
    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
}

export function parseCandleRows(rows: unknown[], idx: OhlcIndexes): CandleRow[] {
    return rows
        .map((row) => parseCandleRow(row, idx))
        .filter((x): x is CandleRow => x != null)
        .sort((a, b) => a[0] - b[0]);
}

/** HTX can return objects instead of arrays; map those to the shared shape. */
export function parseHtxObjectRow(row: unknown): CandleRow | null {
    if (!row || typeof row !== 'object') return null;
    const o = row as Record<string, unknown>;
    const ts = normalizeTimestamp(o.id ?? o.timestamp ?? o.time);
    const open = Number(o.open);
    const high = Number(o.high);
    const low = Number(o.low);
    const close = Number(o.close);
    const volume = Number(o.amount ?? o.vol ?? o.volume ?? 0);
    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
}

/** Internal seams exercised directly by tests. */
export const __test = { normalizeTimestamp };

'use strict';

import { blockchainToFloat } from '../../modules/order/utils/math.js';
import type { UnknownRecord } from '../../modules/types.js';
import { isUnknownRecord } from '../../modules/types.js';

/** Asset identity/precision needed to convert chain amounts. */
interface NativeHistoryAssetMeta {
    id?: unknown;
    precision?: number;
}

interface HistoryKey extends UnknownRecord {
    base?: unknown;
    quote?: unknown;
    open?: unknown;
    time?: unknown;
    timestamp?: unknown;
    date?: unknown;
}

interface HistoryEntry extends UnknownRecord {
    key?: HistoryKey;
    open_time?: unknown;
    time?: unknown;
    timestamp?: unknown;
    block_time?: unknown;
    base_volume?: unknown;
    quote_volume?: unknown;
}

/** Normalized OHLCV candle: [tsMs, open, high, low, close, volume]. */
type NativeHistoryCandle = [number, number, number, number, number, number];
interface PairOrientation {
    baseIsAssetA: boolean;
    baseIsAssetB: boolean;
    basePrecision: number | undefined;
    quotePrecision: number | undefined;
}

/**
 * Native BitShares market history parsing utilities.
 *
 * Converts raw bucket_objects / get_market_history responses into
 * normalized OHLCV candles. Handles both the compact array format and
 * the raw object format with key.base / key.quote / open_base / etc.
 */


function parseNativeMarketHistoryTimestamp(entry: unknown): number | null {
    if (!isUnknownRecord(entry)) return null;
    const historyEntry = entry as HistoryEntry;
    const candidates: unknown[] = [
        historyEntry.key?.open,
        historyEntry.key?.time,
        historyEntry.key?.timestamp,
        historyEntry.key?.date,
        historyEntry.open_time,
        historyEntry.time,
        historyEntry.timestamp,
        historyEntry.block_time,
    ];

    for (const candidate of candidates) {
        if (candidate == null) continue;
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            if (candidate >= 1000000000 && candidate <= 9999999999) return candidate * 1000;
            return candidate;
        }
        let candidateStr = String(candidate);
        if (/^\d{10}$/.test(candidateStr)) return Number(candidateStr) * 1000;
        // 13-digit epoch-ms strings: Date.parse returns NaN for digit-only
        // strings in V8, so handle them explicitly (mirrors the numeric path).
        if (/^\d{13}$/.test(candidateStr)) return Number(candidateStr);
        const match = candidateStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        if (match) {
            const [_, y, m, d, hh, mm, ss] = match.map(Number);
            return Date.UTC(y, m - 1, d, hh, mm, ss);
        }
        const ts = Date.parse(candidateStr);
        if (Number.isFinite(ts)) return ts;
    }

    return null;
}

function resolvePairOrientation(keyBase: string, keyQuote: string, assetA: NativeHistoryAssetMeta, assetB: NativeHistoryAssetMeta): PairOrientation | null {
    const baseIsAssetA = keyBase === String(assetA?.id) && keyQuote === String(assetB?.id);
    const baseIsAssetB = keyBase === String(assetB?.id) && keyQuote === String(assetA?.id);
    if (!baseIsAssetA && !baseIsAssetB) return null;
    const basePrecision = baseIsAssetA ? assetA?.precision : assetB?.precision;
    const quotePrecision = baseIsAssetA ? assetB?.precision : assetA?.precision;
    return { baseIsAssetA, baseIsAssetB, basePrecision, quotePrecision };
}

function resolveNativeMarketHistoryRatio(entry: HistoryEntry, field: string, assetA: NativeHistoryAssetMeta, assetB: NativeHistoryAssetMeta): number {
    const keyBase = String(entry?.key?.base || '');
    const keyQuote = String(entry?.key?.quote || '');
    const orientation = resolvePairOrientation(keyBase, keyQuote, assetA, assetB);
    if (!orientation) return Number.NaN;

    const { baseIsAssetA, basePrecision, quotePrecision } = orientation;
    const baseField = entry?.[`${field}_base`];
    const quoteField = entry?.[`${field}_quote`];
    const numericField = Number(entry?.[field]);
    if (Number.isFinite(numericField)) return numericField;

    if (Number.isFinite(Number(baseField)) && Number.isFinite(Number(quoteField)) && Number(baseField) > 0) {
        const base = blockchainToFloat(baseField, basePrecision);
        const quote = blockchainToFloat(quoteField, quotePrecision);
        if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
            return Number.NaN;
        }
        return baseIsAssetA ? quote / base : base / quote;
    }

    const nested = entry?.[field];
    if (nested && typeof nested === 'object') {
        const nestedRecord = nested as UnknownRecord;
        const base = Number(nestedRecord.base ?? nestedRecord.amount_base ?? nestedRecord.base_amount ?? nestedRecord.amount);
        const quote = Number(nestedRecord.quote ?? nestedRecord.amount_quote ?? nestedRecord.quote_amount ?? nestedRecord.value);
        if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
            return Number.NaN;
        }
        return baseIsAssetA ? quote / base : base / quote;
    }

    return Number.NaN;
}

function normalizeNativeMarketHistoryCandles(history: unknown, assetA: NativeHistoryAssetMeta, assetB: NativeHistoryAssetMeta): NativeHistoryCandle[] {
    const historyRecord = isUnknownRecord(history) ? history : undefined;
    const source: unknown[] = Array.isArray(history)
        ? history
        : Array.isArray(historyRecord?.buckets)
            ? historyRecord.buckets as unknown[]
            : Array.isArray(historyRecord?.history)
                ? historyRecord.history as unknown[]
                : Array.isArray(historyRecord?.result)
                    ? historyRecord.result as unknown[]
                    : [];

    if (!Array.isArray(source) || source.length === 0) return [];

    if (Array.isArray(source[0])) {
        return source
            .filter((c): c is unknown[] => Array.isArray(c) && Number.isFinite(c[0]))
            .map((c): NativeHistoryCandle | null => {
                let ts = Number(c[0]);
                if (ts >= 1000000000 && ts <= 9999999999) ts *= 1000;
                const open = Number(c[1]);
                const high = Number(c[2]);
                const low = Number(c[3]);
                const close = Number(c[4]);
                const volume = Number(c[5]);
                if (![ts, open, high, low, close].every(Number.isFinite)) return null;
                return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
            })
            .filter((c): c is NativeHistoryCandle => c !== null)
            .sort((a, b) => a[0] - b[0]);
    }

    const candles: NativeHistoryCandle[] = [];
    for (const entry of source) {
        if (!isUnknownRecord(entry)) continue;
        const historyEntry = entry as HistoryEntry;
        const tsMs = parseNativeMarketHistoryTimestamp(historyEntry);
        if (tsMs === null || !Number.isFinite(tsMs)) continue;

        const keyBase = String(historyEntry?.key?.base || '');
        const keyQuote = String(historyEntry?.key?.quote || '');
        const orientation = resolvePairOrientation(keyBase, keyQuote, assetA, assetB);
        if (!orientation) continue;

        const { baseIsAssetA, basePrecision, quotePrecision } = orientation;
        const baseVolume = Number(historyEntry?.base_volume);
        const quoteVolume = Number(historyEntry?.quote_volume);

        const open = resolveNativeMarketHistoryRatio(historyEntry, 'open', assetA, assetB);
        const resolvedHigh = resolveNativeMarketHistoryRatio(historyEntry, 'high', assetA, assetB);
        const resolvedLow = resolveNativeMarketHistoryRatio(historyEntry, 'low', assetA, assetB);
        const high = Math.max(resolvedHigh, resolvedLow);
        const low = Math.min(resolvedHigh, resolvedLow);
        const close = resolveNativeMarketHistoryRatio(historyEntry, 'close', assetA, assetB);

        if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
            continue;
        }

        const volume = baseIsAssetA
            ? (Number.isFinite(baseVolume) ? blockchainToFloat(baseVolume, basePrecision) : Number.isFinite(quoteVolume) && Number.isFinite(close) && close > 0 ? blockchainToFloat(quoteVolume, quotePrecision) / close : 0)
            : (Number.isFinite(quoteVolume) ? blockchainToFloat(quoteVolume, quotePrecision) : Number.isFinite(baseVolume) && Number.isFinite(close) && close > 0 ? blockchainToFloat(baseVolume, basePrecision) / close : 0);

        candles.push([tsMs, open, high, low, close, Number.isFinite(volume) ? volume : 0]);
    }

    return candles.sort((a, b) => a[0] - b[0]);
}

export { normalizeNativeMarketHistoryCandles }

/** Internal seams exercised directly by tests. */
export const __test = { parseNativeMarketHistoryTimestamp };


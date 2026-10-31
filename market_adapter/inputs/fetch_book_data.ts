'use strict';
/**
 * FETCH BOOK CANDLES — order-book fill history with disk cache
 *
 * Sequential cached fetch for fill_order (op_type 4) market candles, mirroring
 * the LP fetcher (fetch_lp_data.ts) and the feed fetcher
 * (kibana_feed_source.ts fetchFeedCandlesSequentially).
 *
 * Without this, every `dexbot tv` run on a pool-less pair re-queries all
 * windows from Kibana. Chunk files live under
 * MARKET_ADAPTER.DATA_DIR/book/<assetA>_<assetB>/ and reuse the shared
 * bucket-cache machinery (see window_cache.js): shifted reruns reuse local
 * buckets and query only what is missing (plus a tail refresh for
 * late-indexed fills).
 *
 * Correctness note: each bucket is built from its own fills (no cross-range
 * state like the feed cross forward-fill), so sub-range fetches are safe and
 * allowSubFetch stays enabled.
 *
 * Node-only (disk I/O via storage). Browser-safe code must not import this —
 * use getMarketCandles from core/kibana_market_candles.js instead.
 */

import { getMarketCandles } from '../core/kibana_market_candles.js';
import { path } from '../../modules/path_api.js';
import { PATHS } from '../../modules/paths.js';
import { toIntervalLabel } from '../interval_utils.js';
import { buildFetchWindowsFromRange, runCachedWindows } from './window_cache.js';
import { canonicalPair, pairFolderSlug, sameAssets, swappedAssets, inverseSiblingOutPath, invertCandleSeries } from '../utils/pair_orientation.js';

interface AssetRef {
    id?: string | null;
    precision?: unknown;
    symbol?: string | null;
}

interface BookRequestKey {
    source: string;
    pair: string;
    assetA: AssetRef;
    assetB: AssetRef;
    intervalSeconds: number;
}

interface BookMeta {
    source?: string;
    pair?: string;
    intervalSeconds?: number;
    assetA?: AssetRef;
    assetB?: AssetRef;
    [key: string]: unknown;
}

interface BookFetchOpts {
    intervalSeconds?: unknown;
    chunkMonths?: unknown;
    timeRange?: { gte?: string; lte?: string } | null;
    outPath?: string;
    onPage?: (info: Record<string, unknown>) => void;
    [key: string]: unknown;
}

function bookCacheKey(assetA: AssetRef | null | undefined, assetB: AssetRef | null | undefined): string {
    // Canonical orientation: A/B and B/A share one cache family. Candles are
    // B-per-A, so the stored series is always the canonical one and the
    // fetcher inverts it back for an inverse request.
    const pair = canonicalPair(assetA || {}, assetB || {});
    return pairFolderSlug(pair.assetA, pair.assetB);
}

function bookOutputPath(assetA: AssetRef | null | undefined, assetB: AssetRef | null | undefined, intervalSeconds: number): string {
    const label = toIntervalLabel(intervalSeconds);
    const folder = bookCacheKey(assetA, assetB);
    return path.join(PATHS.MARKET_ADAPTER.DATA_DIR, 'book', folder, `book_${folder}_${label}.json`);
}

function isBookChunkMatch(metaInput: unknown, requestKeyInput: unknown): boolean {
    const meta = metaInput as BookMeta;
    const requestKey = requestKeyInput as BookRequestKey;
    if (meta.source !== 'book' || requestKey.source !== 'book') return false;
    if (meta.pair !== requestKey.pair) return false;
    if (meta.intervalSeconds !== requestKey.intervalSeconds) return false;
    return sameAssets(meta, requestKey);
}

/** Same identity, opposite orientation (legacy pre-canonicalization shard). */
function isBookChunkMatchInverse(metaInput: unknown, requestKeyInput: unknown): boolean {
    const meta = metaInput as BookMeta;
    const requestKey = requestKeyInput as BookRequestKey;
    if (meta.source !== 'book' || requestKey.source !== 'book') return false;
    if (meta.intervalSeconds !== requestKey.intervalSeconds) return false;
    return swappedAssets(meta, requestKey);
}

/**
 * OHLC order-book fill candles for an asset pair with chunk-level disk reuse.
 *
 * @param {Object} assetA – tv pair leg A { id, precision, symbol }
 * @param {Object} assetB – tv pair leg B { id, precision, symbol }
 * @param {Object} [opts] – { intervalSeconds, chunkMonths, timeRange { gte, lte }, outPath, apiKey, timeout, signal, kibanaSearch, onPage }
 * @returns {Promise<Array>} [[timestamp_ms, open, high, low, close, volume_A], ...]
 */
async function fetchMarketCandlesSequentially(assetA: AssetRef, assetB: AssetRef, opts: BookFetchOpts = {}) {
    const intervalSeconds = Number(opts.intervalSeconds) || 3600;
    const chunkMonths = Number(opts.chunkMonths) || 1;
    const timeRange = opts.timeRange;
    if (!timeRange?.gte || !timeRange?.lte) {
        throw new Error('fetchMarketCandlesSequentially requires opts.timeRange { gte, lte }');
    }
    // Canonical storage: fetch/query the lower-id leg as A, invert the result
    // back if the caller asked for the other side. One cache family per pair.
    const canon = canonicalPair(assetA, assetB);
    const storeA = canon.assetA;
    const storeB = canon.assetB;
    const flipped = canon.flipped;
    const pair = bookCacheKey(storeA, storeB);
    const outPath = opts.outPath || bookOutputPath(storeA, storeB, intervalSeconds);
    const requestKey = {
        source: 'book',
        pair,
        assetA: { id: storeA.id, precision: storeA.precision, symbol: storeA.symbol },
        assetB: { id: storeB.id, precision: storeB.precision, symbol: storeB.symbol },
        intervalSeconds,
    };

    const plainWindows = buildFetchWindowsFromRange(timeRange, chunkMonths);
    // Windows are fetch-planning splits only; storage is fixed month shards.
    const windows = plainWindows.map((w, idx) => ({
        index: idx + 1,
        gte: w.gte,
        lte: w.lte,
    }));

    // Passthrough for auth/transport overrides; the window range itself is
    // always the sub-range being fetched.
    const passthrough: Record<string, unknown> = {};
    for (const key of ['apiKey', 'timeout', 'signal', 'kibanaSearch', 'onPage', 'kibanaPageSize', 'kibanaPageRetries', 'kibanaRetryDelayMs', 'kibanaMaxPages']) {
        if (opts[key] !== undefined) passthrough[key] = opts[key];
    }

    // A partial window (one fill direction failed) is still returned for
    // this run's output, but flagged so the shared runner withholds it from
    // disk — persisting it would bake the missing side in as gap-filled
    // zeros that are never re-queried.
    // The runner passes its abort signal as the 4th argument when a window
    // timeout is configured; it wins over a caller-provided signal so a
    // timed-out range actually aborts instead of timing out and retrying
    // against a still-hung request.
    const fetchRange = async (gte: string, lte: string, _window: unknown, signal?: AbortSignal) => {
        let sawPartial = false;
        const userOnPage = passthrough.onPage as ((info: Record<string, unknown>) => void) | undefined;
        const onPage = (info: Record<string, unknown>) => {
            if (info?.event === 'partial') sawPartial = true;
            try { userOnPage?.(info); } catch (_) { /* progress must never fail the fetch */ }
        };
        const candles = await getMarketCandles(storeA, storeB, {
            ...passthrough,
            ...(signal ? { signal } : {}),
            onPage,
            intervalSeconds,
            timeRange: { gte, lte },
        });
        return sawPartial ? { candles, complete: false as const } : candles;
    };

    const merged = await runCachedWindows({
        windows,
        outPath,
        requestKey,
        isMatch: isBookChunkMatch,
        inverse: (() => {
            const invFolder = pairFolderSlug(storeB, storeA);
            const legacy = inverseSiblingOutPath(outPath, storeA, storeB, `book_${invFolder}_${toIntervalLabel(intervalSeconds)}.json`);
            return legacy
                ? { outPath: legacy, isMatch: isBookChunkMatchInverse, toRequest: (c: number[][]) => invertCandleSeries(c, { volume: 'scale' }) }
                : undefined;
        })(),
        metaForWindow: (window: { index: number; gte: string; lte: string }) => ({
            source: 'book',
            esSource: 'https://kibana.bitshares.dev (bitshares-*, op_type 4, fill_order)',
            pair,
            assetA: requestKey.assetA,
            assetB: requestKey.assetB,
            intervalSeconds,
            timeRange: { gte: window.gte, lte: window.lte },
            format: '[timestamp_ms, open, high, low, close, volume_A]',
        }),
        fetchRange,
        bucketMs: intervalSeconds * 1000,
        allowSubFetch: true,
    });
    return flipped ? (invertCandleSeries(merged, { volume: 'scale' }) as number[][]) : merged;
}

export { fetchMarketCandlesSequentially };

/** Internal seams exercised directly by tests. */
export const __test = { bookCacheKey, bookOutputPath, isBookChunkMatch };

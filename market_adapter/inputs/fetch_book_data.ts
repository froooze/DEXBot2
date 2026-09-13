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
import { toIntervalLabel, slugPart } from '../interval_utils.js';
import { buildFetchWindowsFromRange, runCachedWindows } from './window_cache.js';

function bookCacheKey(assetA: any, assetB: any) {
    // Orientation matters: candles are B-per-A, so A/B and B/A are different series.
    return `${slugPart(assetA?.symbol || assetA?.id)}_${slugPart(assetB?.symbol || assetB?.id)}`;
}

function bookOutputPath(assetA: any, assetB: any, intervalSeconds: any) {
    const label = toIntervalLabel(intervalSeconds);
    const folder = bookCacheKey(assetA, assetB);
    return path.join(PATHS.MARKET_ADAPTER.DATA_DIR, 'book', folder, `book_${folder}_${label}.json`);
}

function isBookChunkMatch(meta: any, requestKey: any) {
    if (meta.source !== 'book' || requestKey.source !== 'book') return false;
    if (meta.pair !== requestKey.pair) return false;
    if (meta.intervalSeconds !== requestKey.intervalSeconds) return false;
    if (meta.assetA?.id !== requestKey.assetA.id || meta.assetB?.id !== requestKey.assetB.id) return false;
    if (meta.assetA?.precision !== requestKey.assetA.precision || meta.assetB?.precision !== requestKey.assetB.precision) return false;
    return true;
}

/**
 * OHLC order-book fill candles for an asset pair with chunk-level disk reuse.
 *
 * @param {Object} assetA – tv pair leg A { id, precision, symbol }
 * @param {Object} assetB – tv pair leg B { id, precision, symbol }
 * @param {Object} [opts] – { intervalSeconds, chunkMonths, timeRange { gte, lte }, outPath, apiKey, timeout, signal, kibanaSearch, onPage }
 * @returns {Promise<Array>} [[timestamp_ms, open, high, low, close, volume_A], ...]
 */
async function fetchMarketCandlesSequentially(assetA: any, assetB: any, opts: any = {}) {
    const intervalSeconds = Number(opts.intervalSeconds) || 3600;
    const chunkMonths = Number(opts.chunkMonths) || 1;
    const timeRange = opts.timeRange;
    if (!timeRange?.gte || !timeRange?.lte) {
        throw new Error('fetchMarketCandlesSequentially requires opts.timeRange { gte, lte }');
    }
    const pair = bookCacheKey(assetA, assetB);
    const outPath = opts.outPath || bookOutputPath(assetA, assetB, intervalSeconds);
    const requestKey = {
        source: 'book',
        pair,
        assetA: { id: assetA.id, precision: assetA.precision, symbol: assetA.symbol },
        assetB: { id: assetB.id, precision: assetB.precision, symbol: assetB.symbol },
        intervalSeconds,
    };

    const plainWindows = buildFetchWindowsFromRange(timeRange, chunkMonths);
    // Windows are fetch-planning splits only; storage is fixed month shards.
    const windows = plainWindows.map((w: any, idx: any) => ({
        index: idx + 1,
        gte: w.gte,
        lte: w.lte,
    }));

    // Passthrough for auth/transport overrides; the window range itself is
    // always the sub-range being fetched.
    const passthrough: any = {};
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
    const fetchRange = async (gte: string, lte: string, _window: any, signal?: AbortSignal) => {
        let sawPartial = false;
        const userOnPage = passthrough.onPage;
        const onPage = (info: any) => {
            if (info?.event === 'partial') sawPartial = true;
            try { userOnPage?.(info); } catch (_) { /* progress must never fail the fetch */ }
        };
        const candles = await getMarketCandles(assetA, assetB, {
            ...passthrough,
            ...(signal ? { signal } : {}),
            onPage,
            intervalSeconds,
            timeRange: { gte, lte },
        });
        return sawPartial ? { candles, complete: false as const } : candles;
    };

    return runCachedWindows({
        windows,
        outPath,
        requestKey,
        isMatch: isBookChunkMatch,
        metaForWindow: (window: any) => ({
            source: 'book',
            esSource: 'https://kibana.bitshares.dev (bitshares-*, op_type 4, fill_order)',
            pair,
            assetA: requestKey.assetA,
            assetB: requestKey.assetB,
            intervalSeconds,
            chunkIndex: window.index,
            timeRange: { gte: window.gte, lte: window.lte },
            format: '[timestamp_ms, open, high, low, close, volume_A]',
        }),
        fetchRange,
        bucketMs: intervalSeconds * 1000,
        allowSubFetch: true,
    });
}

export {
    bookCacheKey,
    bookOutputPath,
    isBookChunkMatch,
    fetchMarketCandlesSequentially,
};

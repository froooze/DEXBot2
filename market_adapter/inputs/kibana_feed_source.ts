'use strict';
/**
 * KIBANA FEED SOURCE — MPA settlement-price history
 *
 * Fetches historical price-feed publications (op_type 19, asset_publish_feed)
 * for a Market Pegged Asset and buckets them into OHLCV candles. Unlike
 * kibana_source.ts (LP pool swaps, op_type 63) and kibana_market_candles.ts
 * (order book fills, op_type 4), this module tracks the on-chain feed itself:
 * the settlement_price the chain uses for margin calls, force settlement,
 * and collateral-ratio math.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*
 *   Operation type: 19 (asset_publish_feed)
 *
 * ES field paths for asset_publish_feed:
 *   operation_history.op_object.asset_id             – published MPA asset ID
 *   operation_history.op_object.feed.settlement_price.base.amount / .asset_id
 *   operation_history.op_object.feed.settlement_price.quote.amount / .asset_id
 *
 * Output: [[timestamp_ms, open, high, low, close, feed_publish_count], ...]
 * Prices are in backing-per-MPA units by default (e.g. BTS per HONEST.USD),
 * matching the live feed_price_source convention. Use
 * getFeedCandlesForPair() for tv-style B-per-A orientation.
 *
 * Notes:
 * - Every publisher's feed is kept (no publisher filter); each 1h bucket
 *   aggregates all publishes in that hour (open = first, close = last).
 * - Volume is the feed publish count per bucket, NOT traded asset volume.
 */

import { fillCandleGaps } from '../candle_utils.js';
import { resolveRequestedFillRange, hitSortKey, hitSequence } from '../core/kibana_candles.js';
import { parseChainTimeToMs } from '../interval_utils.js';
import { kibanaSearch, DEFAULT_CONFIG as BASE_CONFIG } from '../core/kibana_client.js';
import { path } from '../../modules/path_api.js';
import { PATHS } from '../../modules/paths.js';
import { toIntervalLabel, slugPart } from '../interval_utils.js';
import { buildFetchWindowsFromRange, runCachedWindows } from './window_cache.js';
import { canonicalPair, pairFolderSlug, sameAssets, swappedAssets, inverseSiblingOutPath, compareAssetIds } from '../utils/pair_orientation.js';
import { isTransientNetworkError, sleepMs } from '../../modules/utils/errors.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_TYPE_FEED = 19; // asset_publish_feed

const FEED_ASSET_ID_FIELD = 'operation_history.op_object.asset_id.keyword';

// Minimal _source projection: timestamp + ordering + the settlement price.
// Amounts sometimes serialize as strings (observed on core_exchange_rate
// siblings), so the whole settlement_price branch is fetched and coerced.
const FEED_SOURCE_FIELDS = [
    'block_data.block_time',
    'operation_id_num',
    'account_history.operation_id',
    'account_history.sequence',
    'operation_history.op_object.asset_id',
    'operation_history.op_object.feed.settlement_price',
];

// ─── Default Config ───────────────────────────────────────────────────────────

interface AssetRef {
    id?: string;
    precision?: number;
    symbol?: string;
    [key: string]: unknown;
}

interface FeedPoint {
    tsMs: number;
    price: number;
    sequence?: number;
    kibanaSortKey?: string;
    feedPublishCount?: number;
}

interface RatioPoint {
    tsMs: number;
    price: number;
    feedPublishCount?: number;
}

interface FeedBucket {
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    count: number;
    firstTs: number;
    lastTs: number;
}

interface FeedLeg {
    mpa?: AssetRef;
    backing?: AssetRef;
    [key: string]: unknown;
}

interface FeedContext {
    kind?: string;
    legs: FeedLeg[];
    [key: string]: unknown;
}

interface FeedConfig {
    intervalSeconds?: number;
    lookbackHours?: number;
    timeRange?: { gte?: string; lte?: string } | null;
    kibanaPageSize?: number;
    kibanaPageRetries?: number;
    kibanaRetryDelayMs?: number;
    kibanaMaxPages?: number;
    kibanaSearch?: (...args: unknown[]) => Promise<unknown>;
    fillGaps?: boolean;
    fillGapsToRequestedRange?: boolean;
    [key: string]: unknown;
}

interface FetchWindow {
    index: number;
    gte: string;
    lte: string;
}

const DEFAULT_CONFIG: FeedConfig & { intervalSeconds: number; lookbackHours: number; kibanaPageSize: number; kibanaPageRetries: number; kibanaRetryDelayMs: number; kibanaMaxPages: number } = {
    ...BASE_CONFIG,
    intervalSeconds: 3600,
    lookbackHours: 500,
    // Same paging discipline as the trade candle sources: the Kibana console
    // proxy resets connections when a single page streams too much data.
    kibanaPageSize: 2000,
    kibanaPageRetries: 4,
    kibanaRetryDelayMs: 1000,
    // Runaway guard for search_after pagination (see kibana_candles.ts).
    kibanaMaxPages: 500,
};

// ─── Price math ───────────────────────────────────────────────────────────────

/**
 * Integer blockchain amount → float. Amounts may arrive as numbers or
 * numeric strings; anything else yields NaN.
 */
function floatAmount(raw: unknown, precision: unknown): number {
    const n = Number(raw);
    const p = Number(precision);
    if (!Number.isFinite(n) || !Number.isFinite(p) || p < 0) return Number.NaN;
    return n / Math.pow(10, p);
}

/**
 * Backing-per-MPA from a settlement_price { base, quote } object, handling
 * either base/quote orientation. Returns null when the price does not span
 * exactly the mpa/backing pair.
 */
function backingPerMpa(settlement: unknown, mpaAsset: AssetRef | null | undefined, backingAsset: AssetRef | null | undefined): number | null {
    const s = settlement as { base?: { asset_id?: unknown; amount?: unknown }; quote?: { asset_id?: unknown; amount?: unknown } } | null | undefined;
    const base = s?.base;
    const quote = s?.quote;
    if (!base || !quote) return null;
    const baseId = String(base.asset_id || '');
    const quoteId = String(quote.asset_id || '');
    const mpaId = String(mpaAsset?.id || '');
    const backingId = String(backingAsset?.id || '');
    if (!baseId || !quoteId || !mpaId || !backingId) return null;
    const ids = new Set([baseId, quoteId]);
    if (!ids.has(mpaId) || !ids.has(backingId)) return null;

    const baseFloat = floatAmount(base.amount, baseId === mpaId ? mpaAsset?.precision : backingAsset?.precision);
    const quoteFloat = floatAmount(quote.amount, quoteId === mpaId ? mpaAsset?.precision : backingAsset?.precision);
    if (!Number.isFinite(baseFloat) || !Number.isFinite(quoteFloat) || baseFloat <= 0 || quoteFloat <= 0) return null;

    // backing-per-MPA: divide the backing side by the MPA side.
    if (baseId === backingId && quoteId === mpaId) return baseFloat / quoteFloat;
    if (baseId === mpaId && quoteId === backingId) return quoteFloat / baseFloat;
    return null;
}

function parseFeedTimestamp(source: unknown): number | null {
    const raw = (source as { block_data?: { block_time?: unknown } } | null | undefined)?.block_data?.block_time;
    if (raw == null) return null;
    const tsMs = parseChainTimeToMs(String(raw));
    return Number.isFinite(tsMs) ? tsMs : null;
}

/**
 * Kibana hit → { tsMs, price, sequence, kibanaSortKey } in backing-per-MPA,
 * or null when the hit carries no usable settlement price for the pair.
 */
function hitToFeedPrice(hit: unknown, { mpaAsset, backingAsset }: { mpaAsset: AssetRef | null | undefined; backingAsset: AssetRef | null | undefined }): FeedPoint | null {
    const source = ((hit as { _source?: unknown } | null | undefined)?._source || {}) as { operation_history?: { op_object?: { feed?: { settlement_price?: unknown } } } };
    const tsMs = parseFeedTimestamp(source);
    if (tsMs == null) return null;
    const settlement = source?.operation_history?.op_object?.feed?.settlement_price;
    const price = backingPerMpa(settlement, mpaAsset, backingAsset);
    if (!Number.isFinite(price as number) || (price as number) <= 0) return null;
    return {
        tsMs,
        price: price as number,
        sequence: hitSequence(source, 'account_history.operation_id'),
        kibanaSortKey: hitSortKey(hit),
    };
}

// ─── Query ────────────────────────────────────────────────────────────────────

function buildFeedDocumentQuery({ mpaAssetId, lookbackHours, timeRange, size, searchAfter }: { mpaAssetId: string; lookbackHours?: number; timeRange?: { gte?: string; lte?: string } | null; size: number; searchAfter: unknown[] | null }): Record<string, unknown> {
    const rangeValue = timeRange
        ? { gte: timeRange.gte, lte: timeRange.lte }
        : { gte: `now-${lookbackHours}h`, lte: 'now' };

    const query: Record<string, unknown> = {
        size,
        track_total_hits: false,
        _source: FEED_SOURCE_FIELDS,
        query: {
            bool: {
                filter: [
                    { term: { operation_type: OP_TYPE_FEED } },
                    { term: { [FEED_ASSET_ID_FIELD]: String(mpaAssetId) } },
                    { range: { 'block_data.block_time': rangeValue } },
                ],
            },
        },
        sort: [
            { 'block_data.block_time': { order: 'asc' } },
            { operation_id_num: { order: 'asc' } },
        ],
    };

    if (Array.isArray(searchAfter)) query.search_after = searchAfter;
    return query;
}

/**
 * All feed price points for the MPA in the requested window, time-ascending.
 */
async function fetchFeedPricePoints({ mpaAsset, backingAsset, config = {} }: { mpaAsset: AssetRef; backingAsset: AssetRef; config?: FeedConfig }): Promise<FeedPoint[]> {
    const cfg: FeedConfig = { ...DEFAULT_CONFIG, ...config };
    const search = typeof cfg.kibanaSearch === 'function' ? cfg.kibanaSearch : kibanaSearch;
    const size = Math.min(Math.max(1, Number(cfg.kibanaPageSize) || DEFAULT_CONFIG.kibanaPageSize), 10000);
    const retriesRaw = Number(cfg.kibanaPageRetries);
    const retries = Number.isFinite(retriesRaw) && retriesRaw >= 1 ? Math.floor(retriesRaw) : DEFAULT_CONFIG.kibanaPageRetries;
    const delayRaw = Number(cfg.kibanaRetryDelayMs);
    const retryDelayMs = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : DEFAULT_CONFIG.kibanaRetryDelayMs;
    const maxPagesRaw = Number(cfg.kibanaMaxPages);
    const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw >= 1 ? Math.floor(maxPagesRaw) : DEFAULT_CONFIG.kibanaMaxPages;
    // The page loop owns the retry budget here (see kibana_candles.ts).
    const pageCfg = { ...cfg, kibanaSearchRetries: 1 };

    const points: FeedPoint[] = [];
    let searchAfter: unknown[] | null = null;
    let page = 0;
    let droppedTotal = 0;

    while (true) {
        page += 1;
        if (page > maxPages) {
            throw new Error(
                `Kibana feed pagination exceeded kibanaMaxPages=${maxPages} for ${mpaAsset?.symbol || mpaAsset?.id} ` +
                `— stuck search_after cursor or range too deep for one fetch. ` +
                `Narrow the timeRange or raise kibanaMaxPages.`
            );
        }
        const query = buildFeedDocumentQuery({
            mpaAssetId: String(mpaAsset.id),
            lookbackHours: cfg.lookbackHours,
            timeRange: cfg.timeRange ?? null,
            size,
            searchAfter,
        });

        // A failed page is safe to retry: search_after pagination is
        // stateless on the server, so replaying the same page yields the
        // same documents.
        let result: { hits?: { hits?: unknown[] } } | null = null;
        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                result = await search(pageCfg, query) as { hits?: { hits?: unknown[] } } | null;
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
                if (attempt >= retries || !isTransientNetworkError(err)) throw err;
                if (retryDelayMs > 0) await sleepMs(retryDelayMs * attempt);
            }
        }
        if (lastErr) throw lastErr;
        const hits = result?.hits?.hits || [];
        if (!Array.isArray(hits) || hits.length === 0) break;

        for (const hit of hits) {
            const point = hitToFeedPrice(hit, { mpaAsset, backingAsset });
            if (point) points.push(point);
            else droppedTotal += 1;
        }

        if (hits.length < size) break;
        const lastSort = (hits[hits.length - 1] as { sort?: unknown[] } | undefined)?.sort;
        if (!Array.isArray(lastSort)) {
            throw new Error('Kibana document pagination requires sort values on hits');
        }
        searchAfter = lastSort;
    }

    if (droppedTotal > 0) {
        console.warn(
            `[kibana] feed ${mpaAsset?.symbol || mpaAsset?.id}: skipped ${droppedTotal} unparseable document(s) ` +
            `across ${page} page(s) — kept ${points.length} price point(s)`
        );
    }

    points.sort((a, b) => {
        const tsDelta = a.tsMs - b.tsMs;
        if (tsDelta !== 0) return tsDelta;
        const aSeq = Number(a.sequence);
        const bSeq = Number(b.sequence);
        if (Number.isFinite(aSeq) && Number.isFinite(bSeq) && aSeq !== bSeq) return aSeq - bSeq;
        return String(a.kibanaSortKey || '').localeCompare(String(b.kibanaSortKey || ''));
    });
    return points;
}

// ─── Bucketing ────────────────────────────────────────────────────────────────

/**
 * Price points → OHLC candles per interval bucket.
 * Pure function (no I/O) for unit testing.
 *
 * @param {Array} points – [{ tsMs, price }] time-ascending preferred
 * @param {number} intervalSeconds – bucket size (1h default)
 * @returns {Array} [[timestamp_ms, open, high, low, close, publishCount], ...]
 */
function bucketPricesToCandles(points: unknown, intervalSeconds = 3600): number[][] {
    const bucketMs = Number(intervalSeconds) * 1000;
    if (!Array.isArray(points) || points.length === 0) return [];
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) return [];

    const buckets = new Map<number, FeedBucket>();
    for (const point of points || []) {
        const tsMs = Number(point?.tsMs);
        const price = Number(point?.price);
        if (!Number.isFinite(tsMs) || !Number.isFinite(price) || price <= 0) continue;
        const bucketTs = Math.floor(tsMs / bucketMs) * bucketMs;
        let bucket = buckets.get(bucketTs);
        if (!bucket) {
            bucket = { ts: bucketTs, open: price, high: price, low: price, close: price, count: 0, firstTs: tsMs, lastTs: tsMs };
            buckets.set(bucketTs, bucket);
        }
        // Points may arrive unordered; open tracks the earliest timestamp,
        // close the latest, while high/low span the whole bucket.
        if (tsMs < bucket.firstTs) {
            bucket.open = price;
            bucket.firstTs = tsMs;
        }
        if (tsMs >= bucket.lastTs) {
            bucket.close = price;
            bucket.lastTs = tsMs;
        }
        if (price > bucket.high) bucket.high = price;
        if (price < bucket.low) bucket.low = price;
        // Cross-feed points may carry an averaged publication count for the
        // bucket; ordinary feed points count one publication each.
        const pointCount = Number(point?.feedPublishCount);
        bucket.count += Number.isFinite(pointCount) && pointCount >= 0 ? pointCount : 1;
    }

    return [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => [b.ts, b.open, b.high, b.low, b.close, b.count]);
}

/**
 * Invert candles (1/price, high/low swapped). Pure function for pair
 * orientation when the MPA is the B leg (B-per-A = MPA-per-backing).
 */
function invertCandles(candles: unknown): number[][] {
    const list = Array.isArray(candles) ? (candles as number[][]) : [];
    return list
        .filter((c) => Array.isArray(c) && c.slice(1, 5).every((v) => Number.isFinite(Number(v)) && Number(v) > 0))
        .map((c) => [c[0], 1 / c[4], 1 / c[3], 1 / c[2], 1 / c[1], c[5]]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * OHLC feed candles for an MPA in backing-per-MPA units
 * (e.g. BTS per HONEST.USD).
 *
 * @param {Object} mpaAsset – { id, precision, symbol }
 * @param {Object} backingAsset – { id, precision, symbol }
 * @param {Object} [config] – { intervalSeconds, timeRange | lookbackHours, fillGaps, fillGapsToRequestedRange, kibanaSearch, ... }
 */
async function getFeedCandlesForMpa(mpaAsset: AssetRef, backingAsset: AssetRef, config: FeedConfig = {}): Promise<number[][]> {
    const cfg: FeedConfig = { ...DEFAULT_CONFIG, ...config };
    const points = await fetchFeedPricePoints({ mpaAsset, backingAsset, config: cfg });
    return applyGapFill(bucketPricesToCandles(points, cfg.intervalSeconds), cfg);
}

function applyGapFill(consolidated: number[][], cfg: FeedConfig): number[][] {
    if (cfg.fillGaps === false) {
        return consolidated;
    }

    if (cfg.fillGapsToRequestedRange === false) {
        return fillCandleGaps(consolidated, Number(cfg.intervalSeconds));
    }

    const { startTs, endTs } = resolveRequestedFillRange(cfg);
    return fillCandleGaps(consolidated, Number(cfg.intervalSeconds), startTs, endTs);
}

/**
 * Cross-rate price points for two MPAs sharing one backing asset.
 *
 * Both feeds are fetched in backing-per-MPA units, then each numerator-side
 * publish is paired with the latest denominator-side publish at or before
 * its timestamp (forward-fill). Ratios are therefore B-per-A directly: the
 * backing leg cancels ((backing/A) / (backing/B) = B/A).
 *
 * Numerator publishes predating the first denominator publish are dropped
 * (no reference price yet). Pure function of two point lists otherwise.
 */
function crossPointsToRatios(numeratorPoints: unknown, denominatorPoints: unknown, intervalSeconds: number = 0): RatioPoint[] {
    const numer = Array.isArray(numeratorPoints) ? (numeratorPoints as FeedPoint[]) : [];
    const denom = Array.isArray(denominatorPoints) ? (denominatorPoints as FeedPoint[]) : [];
    const ratios: RatioPoint[] = [];
    let j = 0;
    let lastDenominator: FeedPoint | null = null;
    const bucketMs = Number(intervalSeconds) * 1000;
    const numeratorCounts = new Map<number, number>();
    const denominatorCounts = new Map<number, number>();
    const countedBuckets = new Set<number>();

    if (Number.isFinite(bucketMs) && bucketMs > 0) {
        for (const point of numer) {
            const tsMs = Number(point?.tsMs);
            if (Number.isFinite(tsMs)) {
                const bucket = Math.floor(tsMs / bucketMs) * bucketMs;
                numeratorCounts.set(bucket, (numeratorCounts.get(bucket) || 0) + 1);
            }
        }
        for (const point of denom) {
            const tsMs = Number(point?.tsMs);
            if (Number.isFinite(tsMs)) {
                const bucket = Math.floor(tsMs / bucketMs) * bucketMs;
                denominatorCounts.set(bucket, (denominatorCounts.get(bucket) || 0) + 1);
            }
        }
    }

    for (const point of numer) {
        const tsMs = Number(point?.tsMs);
        const price = Number(point?.price);
        if (!Number.isFinite(tsMs) || !Number.isFinite(price) || price <= 0) continue;
        while (j < denom.length && Number(denom[j]?.tsMs) <= tsMs) {
            lastDenominator = denom[j];
            j++;
        }
        const refPrice = Number(lastDenominator?.price);
        if (!Number.isFinite(refPrice) || refPrice <= 0) continue;
        const ratio: RatioPoint = { tsMs, price: price / refPrice };
        if (Number.isFinite(bucketMs) && bucketMs > 0) {
            const bucket = Math.floor(tsMs / bucketMs) * bucketMs;
            if (!countedBuckets.has(bucket)) {
                ratio.feedPublishCount = ((numeratorCounts.get(bucket) || 0) + (denominatorCounts.get(bucket) || 0)) / 2;
                countedBuckets.add(bucket);
            } else {
                ratio.feedPublishCount = 0;
            }
        }
        ratios.push(ratio);
    }
    return ratios;
}

async function fetchFeedCrossPoints({ mpaA, mpaB, backing, config = {} }: { mpaA: AssetRef; mpaB: AssetRef; backing: AssetRef; config?: FeedConfig }): Promise<RatioPoint[]> {
    if (String(mpaA?.id || '') === String(mpaB?.id || '')) {
        throw new Error('Feed cross requires two distinct MPAs');
    }
    const [pointsA, pointsB] = await Promise.all([
        fetchFeedPricePoints({ mpaAsset: mpaA, backingAsset: backing, config }),
        fetchFeedPricePoints({ mpaAsset: mpaB, backingAsset: backing, config }),
    ]);
    return crossPointsToRatios(pointsA, pointsB, Number(config.intervalSeconds) || 3600);
}

/**
 * Feed candles oriented for a tv pair (B-per-A units).
 *
 * - pair (backing, MPA): B-per-A = MPA-per-backing → inverted feed.
 * - pair (MPA, backing): B-per-A = backing-per-MPA → feed as-is.
 * - any other pair (MPA vs non-backing asset): throws — a single MPA feed
 *   cannot price that pair; use pool/orderbook candles instead, or
 *   getFeedCandlesForMpaCross() when both legs are MPAs.
 */
async function getFeedCandlesForPair(assetA: AssetRef, assetB: AssetRef, mpaAsset: AssetRef, backingAsset: AssetRef, config: FeedConfig = {}): Promise<number[][]> {
    const aId = String(assetA?.id || '');
    const bId = String(assetB?.id || '');
    const mpaId = String(mpaAsset?.id || '');
    const backingId = String(backingAsset?.id || '');

    const candles = await getFeedCandlesForMpa(mpaAsset, backingAsset, config);
    if (aId === backingId && bId === mpaId) return invertCandles(candles);
    if (aId === mpaId && bId === backingId) return candles;
    throw new Error(
        `Feed candles cover ${backingAsset?.symbol || backingId}/${mpaAsset?.symbol || mpaId} only; ` +
        `cannot price ${assetA?.symbol || aId}/${assetB?.symbol || bId} from the feed`
    );
}

/**
 * Cross-rate feed candles for an MPA/MPA pair sharing one backing asset
 * (e.g. HONEST.USD/HONEST.EUR, both BTS-backed), in B-per-A units.
 *
 * Both feeds are queried and the quote of both is calculated per bucket via
 * forward-fill (see crossPointsToRatios). Legs may be passed in either
 * order; orientation follows assetA/assetB.
 *
 * @param {Object} assetA – tv pair leg A { id, precision, symbol }
 * @param {Object} assetB – tv pair leg B { id, precision, symbol }
 * @param {Object} legA – { mpa, backing } for one MPA leg
 * @param {Object} legB – { mpa, backing } for the other MPA leg
 */
async function getFeedCandlesForMpaCross(assetA: AssetRef, assetB: AssetRef, legA: FeedLeg, legB: FeedLeg, config: FeedConfig = {}): Promise<number[][]> {
    const aId = String(assetA?.id || '');
    const bId = String(assetB?.id || '');
    const mpaAId = String(legA?.mpa?.id || '');
    const mpaBId = String(legB?.mpa?.id || '');
    const backingAId = String(legA?.backing?.id || '');
    const backingBId = String(legB?.backing?.id || '');
    if (!mpaAId || !mpaBId || mpaAId === mpaBId) {
        throw new Error('Feed cross requires two distinct MPA legs');
    }
    if (!backingAId || backingAId !== backingBId) {
        throw new Error(
            `Feed cross requires one shared backing asset, got ${legA?.backing?.symbol || backingAId} vs ${legB?.backing?.symbol || backingBId}`
        );
    }
    // Numerator leg is the A leg so ratios come out as B-per-A directly.
    const flip = aId === mpaBId && bId === mpaAId;
    if (!flip && !(aId === mpaAId && bId === mpaBId)) {
        throw new Error(
            `Feed cross covers ${legA?.mpa?.symbol || mpaAId}/${legB?.mpa?.symbol || mpaBId} only; ` +
            `cannot price ${assetA?.symbol || aId}/${assetB?.symbol || bId} from the feed`
        );
    }
    const cfg: FeedConfig = { ...DEFAULT_CONFIG, ...config };
    const points = flip
        ? await fetchFeedCrossPoints({ mpaA: legB.mpa as AssetRef, mpaB: legA.mpa as AssetRef, backing: legA.backing as AssetRef, config: cfg })
        : await fetchFeedCrossPoints({ mpaA: legA.mpa as AssetRef, mpaB: legB.mpa as AssetRef, backing: legA.backing as AssetRef, config: cfg });
    return applyGapFill(bucketPricesToCandles(points, cfg.intervalSeconds), cfg);
}

// ─── Sequential cached fetch (tv --feed) ───────────────────────────────────────
// Without this, every `dexbot tv --feed` re-queries all windows from Kibana.
// Chunk files live under MARKET_ADAPTER.FEED_DATA_DIR and reuse the shared
// bucket-cache machinery (see window_cache.js): shifted reruns reuse local
// buckets and query only what is missing.
//
// Correctness note: single-MPA pairs allow sub-range fetches (each bucket is
// built from its own publishes). MPA/MPA crosses forward-fill the denominator
// leg, which needs history before the query start — so crosses reuse exact
// ranges but always take full-window fetches otherwise (same boundary
// semantics as the uncached path: only the window-start edge is affected).

function feedCacheKey(feedCtx: FeedContext): string {
    if (feedCtx?.kind === 'cross') {
        const a = feedCtx.legs[0]?.mpa?.symbol || feedCtx.legs[0]?.mpa?.id || 'legA';
        const b = feedCtx.legs[1]?.mpa?.symbol || feedCtx.legs[1]?.mpa?.id || 'legB';
        return `cross_${slugPart(a)}_${slugPart(b)}`;
    }
    return slugPart(feedCtx?.legs[0]?.mpa?.symbol || feedCtx?.legs[0]?.mpa?.id || 'feed');
}

function feedOutputPath(feedKey: string, intervalSeconds: number, assetA: AssetRef, assetB: AssetRef): string {
    const label = toIntervalLabel(intervalSeconds);
    // Canonical orientation: the inverse pair shares one feed cache folder.
    const canon = canonicalPair(assetA || {}, assetB || {});
    const folder = pairFolderSlug(canon.assetA, canon.assetB);
    return path.join(PATHS.MARKET_ADAPTER.FEED_DATA_DIR, folder, `feed_${slugPart(feedKey)}_${label}.json`);
}

/**
 * Cross legs sorted by MPA id so the feed key is orientation-independent; a
 * single leg is returned untouched.
 */
function normalizeFeedLegs(feedCtx: FeedContext): FeedContext {
    if (feedCtx?.kind !== 'cross' || !Array.isArray(feedCtx.legs)) return feedCtx;
    const legs = [...feedCtx.legs].sort((a, b) => compareAssetIds(a?.mpa?.id, b?.mpa?.id));
    return { ...feedCtx, legs };
}

function isFeedChunkMatch(metaInput: unknown, requestKeyInput: unknown): boolean {
    const meta = metaInput as { feed?: unknown; intervalSeconds?: unknown; assetA?: AssetRef; assetB?: AssetRef };
    const requestKey = requestKeyInput as { feed: string; intervalSeconds: number; assetA: AssetRef; assetB: AssetRef };
    if (meta.feed !== requestKey.feed) return false;
    if (meta.intervalSeconds !== requestKey.intervalSeconds) return false;
    return sameAssets(meta, requestKey);
}

/** Same identity, opposite orientation (legacy pre-canonicalization shard). */
function isFeedChunkMatchInverse(metaInput: unknown, requestKeyInput: unknown): boolean {
    const meta = metaInput as { feed?: unknown; intervalSeconds?: unknown; assetA?: AssetRef; assetB?: AssetRef };
    const requestKey = requestKeyInput as { feed: string; intervalSeconds: number; assetA: AssetRef; assetB: AssetRef };
    if (meta.feed !== requestKey.feed) return false;
    if (meta.intervalSeconds !== requestKey.intervalSeconds) return false;
    return swappedAssets(meta, requestKey);
}

async function fetchFeedCandlesSequentially(feedCtx: FeedContext, assetA: AssetRef, assetB: AssetRef, opts: { intervalSeconds?: number; chunkMonths?: number; timeRange?: { gte?: string; lte?: string }; outPath?: string } = {}): Promise<number[][]> {
    const intervalSeconds = Number(opts.intervalSeconds) || 3600;
    const chunkMonths = Number(opts.chunkMonths) || 1;
    const timeRange = opts.timeRange;
    if (!timeRange?.gte || !timeRange?.lte) {
        throw new Error('fetchFeedCandlesSequentially requires opts.timeRange { gte, lte }');
    }
    // Canonical storage: fetch/cache the lower-id leg as A and invert the
    // result back if the caller asked for the other side.
    const canon = canonicalPair(assetA, assetB);
    const storeA = canon.assetA;
    const storeB = canon.assetB;
    const flipped = canon.flipped;
    const normalizedCtx = normalizeFeedLegs(feedCtx);
    const feedKey = feedCacheKey(normalizedCtx);
    const outPath = opts.outPath || feedOutputPath(feedKey, intervalSeconds, storeA, storeB);
    const requestKey = {
        feed: feedKey,
        assetA: { id: storeA.id, precision: storeA.precision, symbol: storeA.symbol },
        assetB: { id: storeB.id, precision: storeB.precision, symbol: storeB.symbol },
        intervalSeconds,
    };
    const isCross = normalizedCtx?.kind === 'cross';

    const plainWindows = buildFetchWindowsFromRange(timeRange, chunkMonths);
    // Windows are fetch-planning splits only; storage is fixed month shards.
    const windows: FetchWindow[] = plainWindows.map((w, idx) => ({
        index: idx + 1,
        gte: w.gte,
        lte: w.lte,
    }));

    const fetchRange = isCross
        ? (gte: string, lte: string) => getFeedCandlesForMpaCross(
            storeA, storeB, normalizedCtx.legs[0], normalizedCtx.legs[1],
            { intervalSeconds, timeRange: { gte, lte } },
        )
        : (gte: string, lte: string) => getFeedCandlesForPair(
            storeA, storeB, normalizedCtx.legs[0].mpa as AssetRef, normalizedCtx.legs[0].backing as AssetRef,
            { intervalSeconds, timeRange: { gte, lte } },
        );

    const merged = await runCachedWindows({
        windows,
        outPath,
        requestKey,
        isMatch: isFeedChunkMatch,
        inverse: (() => {
            const legacy = inverseSiblingOutPath(outPath, storeA, storeB);
            return legacy
                ? { outPath: legacy, isMatch: isFeedChunkMatchInverse, toRequest: (c: number[][]) => invertCandles(c) }
                : undefined;
        })(),
        metaForWindow: (window) => ({
            source: `https://kibana.bitshares.dev (bitshares-*, op_type 19, feed ${feedKey})`,
            feed: feedKey,
            assetA: requestKey.assetA,
            assetB: requestKey.assetB,
            intervalSeconds,
            timeRange: { gte: window.gte, lte: window.lte },
            format: '[timestamp_ms, open, high, low, close, feed_publish_count]',
        }),
        fetchRange,
        bucketMs: intervalSeconds * 1000,
        // Crosses forward-fill across the query start: sub-range fetches
        // would drop leading ratios, so only exact reuse applies to them.
        allowSubFetch: !isCross,
    });
    return flipped ? (invertCandles(merged) as number[][]) : merged;
}

export { fetchFeedCandlesSequentially }

/** Internal seams exercised directly by tests. */
export const __test = {
    OP_TYPE_FEED,
    backingPerMpa,
    hitToFeedPrice,
    buildFeedDocumentQuery,
    crossPointsToRatios,
    bucketPricesToCandles,
    invertCandles,
    getFeedCandlesForMpa,
    getFeedCandlesForPair,
    getFeedCandlesForMpaCross,
};

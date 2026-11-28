'use strict';
/**
 * POOL CROSS CANDLES — synthetic pair candles via two liquidity pools
 *
 * Some pairs have no direct liquidity pool and no direct order-book fills,
 * but both legs trade against a common bridge asset (e.g. TOKENA/CORE and
 * TOKENB/CORE). This module finds such a bridge on chain and derives the pair's
 * candles from the two pool series:
 *
 *   (bridge per A) / (bridge per B) = B per A
 *
 * The two legs are fetched with the normal cached LP fetcher, so month shards,
 * retries and gap filling behave exactly as for a direct pool chart. Legs are
 * joined on exact timestamps by the shared synthetic-candle helper (see
 * utils/cross_candles.ts). Routes are ranked by the smaller of the two bridge
 * reserves, so a shallow leg cannot hide behind a deep one.
 *
 * Node-only: chain discovery and the disk-backed LP fetcher are used.
 */

import { API_LIMITS } from '../../modules/constants.js';
import { isUnknownRecord } from '../../modules/types.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { fetchCandlesSequentially, outputPath } from './fetch_lp_data.js';
import { synthesizeCrossCandles } from '../utils/cross_candles.js';

interface CrossAsset {
    id?: string;
    precision?: number;
    symbol?: string;
    [key: string]: unknown;
}

interface PoolRecord {
    id?: string | null;
    asset_a?: string | null;
    asset_b?: string | null;
    asset_ids?: unknown[];
    balance_a?: string | number | null;
    balance_b?: string | number | null;
    [key: string]: unknown;
}

interface CrossLeg {
    pool: PoolRecord;
}

interface CrossRoute {
    quote: CrossAsset;
    legs: [CrossLeg, CrossLeg];
    score: number;
}

// Mirrors DEFAULT_PRICE_BRIDGES in modules/order/utils/system.ts: when several
// bridges are usable, the core asset is the least surprising default.
const PREFERRED_BRIDGE_SYMBOLS = ['BTS'];
const PREFERRED_BRIDGE_IDS = ['1.3.0'];

type DbRecord = Record<string, (...args: unknown[]) => Promise<unknown>>;
interface CrossClient {
    BitShares?: { db?: DbRecord; [key: string]: unknown };
    [key: string]: unknown;
}

interface CrossFetchOpts {
    intervalSeconds?: number;
    timeRange?: { gte?: string; lte?: string } | null;
    chunkMonths?: number;
    /** Test seam: replace the per-leg cached fetch without touching Kibana or disk. */
    fetchLeg?: (poolId: string, legAsset: CrossAsset, quote: CrossAsset, opts: CrossFetchOpts) => Promise<number[][]>;
    /** Test seam: skip chain discovery and try a fixed ordered route list. */
    routes?: CrossRoute[];
    [key: string]: unknown;
}

function poolAssetIds(pool: PoolRecord): string[] {
    const ids = Array.isArray(pool.asset_ids)
        ? pool.asset_ids
        : [pool.asset_a, pool.asset_b];
    return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function quoteReserve(pool: PoolRecord, quoteId: string): number {
    const idx = poolAssetIds(pool).indexOf(quoteId);
    if (idx < 0) return Number.NaN;
    return Number(idx === 0 ? pool.balance_a : pool.balance_b);
}

/** Paginate `get_liquidity_pools_by_one_asset`; empty when the node lacks it. */
async function listPoolsByAsset(db: DbRecord | undefined, assetId: string): Promise<PoolRecord[]> {
    const fn = db?.get_liquidity_pools_by_one_asset;
    if (typeof fn !== 'function') return [];
    const page = Math.max(1, Number(API_LIMITS.POOL_BATCH_SIZE) || 100);
    const maxBatches = Math.max(1, Number(API_LIMITS.MAX_POOL_SCAN_BATCHES) || 100);
    const seen = new Set<string>();
    const out: PoolRecord[] = [];
    let start: string | null = null;
    for (let batch = 0; batch < maxBatches; batch++) {
        const rows: unknown = await fn.call(db, assetId, page, start);
        if (!Array.isArray(rows) || rows.length === 0) break;
        let fresh = 0;
        for (const row of rows) {
            if (!isUnknownRecord(row) || typeof row.id !== 'string' || seen.has(row.id)) continue;
            seen.add(row.id);
            out.push(row as PoolRecord);
            fresh++;
        }
        if (rows.length < page || fresh === 0) break;
        const last: unknown = rows[rows.length - 1];
        start = isUnknownRecord(last) && typeof last.id === 'string' ? last.id : null;
        if (!start) break;
    }
    return out;
}

/** Node-without-one-asset-API fallback: one paged scan of the whole pool list. */
async function scanAllPools(db: DbRecord | undefined): Promise<PoolRecord[]> {
    const fn = db?.list_liquidity_pools ?? db?.get_liquidity_pools;
    if (typeof fn !== 'function') return [];
    const page = Math.max(1, Number(API_LIMITS.POOL_BATCH_SIZE) || 100);
    const maxBatches = Math.max(1, Number(API_LIMITS.MAX_POOL_SCAN_BATCHES) || 100);
    const out: PoolRecord[] = [];
    let startId = '1.19.0';
    for (let batch = 0; batch < maxBatches; batch++) {
        const rows: unknown = await fn.call(db, page, startId);
        if (!Array.isArray(rows) || rows.length === 0) break;
        // The 1.19.x listing includes startId; later pages must skip it.
        for (const row of startId === '1.19.0' ? rows : rows.slice(1)) {
            if (isUnknownRecord(row) && typeof row.id === 'string') out.push(row as PoolRecord);
        }
        if (rows.length < page) break;
        const last: unknown = rows[rows.length - 1];
        if (!isUnknownRecord(last) || typeof last.id !== 'string') break;
        startId = last.id;
    }
    return out;
}

async function resolveQuoteAssets(client: CrossClient | null, ids: string[]): Promise<Map<string, CrossAsset>> {
    const out = new Map<string, CrossAsset>();
    const db = client?.BitShares?.db;
    const fn = db?.get_assets;
    if (typeof fn === 'function' && ids.length > 0) {
        try {
            const rows: unknown = await fn.call(db, ids);
            if (Array.isArray(rows)) {
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    if (!isUnknownRecord(row) || typeof row.id !== 'string') continue;
                    const precision = Number(row.precision);
                    out.set(row.id, {
                        id: row.id,
                        symbol: String(row.symbol ?? ids[i] ?? row.id),
                        precision: Number.isFinite(precision) ? precision : undefined,
                    });
                }
            }
        } catch (_) { /* symbol is cosmetic; id is enough for the fetch */ }
    }
    for (const id of ids) {
        if (!out.has(id)) out.set(id, { id, symbol: id });
    }
    return out;
}

/**
 * Discover usable bridge routes, best first. Both legs must have their own
 * pool; a pool containing A and B directly is not a cross route.
 */
async function findCrossRoutes(assetA: CrossAsset, assetB: CrossAsset, client: CrossClient | null): Promise<CrossRoute[]> {
    const aId = String(assetA?.id ?? '');
    const bId = String(assetB?.id ?? '');
    if (!aId || !bId || aId === bId) return [];

    const db = client?.BitShares?.db;
    let poolsA: PoolRecord[] = [];
    let poolsB: PoolRecord[] = [];
    if (typeof db?.get_liquidity_pools_by_one_asset === 'function') {
        try {
            [poolsA, poolsB] = await Promise.all([
                listPoolsByAsset(db, aId),
                listPoolsByAsset(db, bId),
            ]);
        } catch (_) {
            // Some nodes advertise the call but reject it (method allow-list).
            poolsA = [];
            poolsB = [];
        }
    }
    if (poolsA.length === 0 || poolsB.length === 0) {
        try {
            const all = await scanAllPools(db);
            if (all.length > 0) {
                poolsA = all.filter((p) => poolAssetIds(p).includes(aId));
                poolsB = all.filter((p) => poolAssetIds(p).includes(bId));
            }
        } catch (_) {
            // A node may advertise the list call but reject it; degrade to
            // whatever the per-asset calls returned instead of failing the CLI.
        }
    }

    const byQuoteA = new Map<string, PoolRecord>();
    const byQuoteB = new Map<string, PoolRecord>();
    // Several pools can share one bridge; keep the deepest one per side so
    // a later-listed shallow pool cannot win the route ranking by accident.
    const keepDeeper = (map: Map<string, PoolRecord>, id: string, pool: PoolRecord) => {
        const prev = map.get(id);
        if (!prev || quoteReserve(pool, id) > quoteReserve(prev, id)) map.set(id, pool);
    };
    for (const pool of poolsA) {
        for (const id of poolAssetIds(pool)) {
            if (id !== aId && id !== bId) keepDeeper(byQuoteA, id, pool);
        }
    }
    for (const pool of poolsB) {
        for (const id of poolAssetIds(pool)) {
            if (id !== aId && id !== bId) keepDeeper(byQuoteB, id, pool);
        }
    }
    const quoteIds = [...byQuoteA.keys()].filter((id) => byQuoteB.has(id));
    if (quoteIds.length === 0) return [];

    const quotes = await resolveQuoteAssets(client, quoteIds);
    const routes: CrossRoute[] = [];
    for (const id of quoteIds) {
        const poolA = byQuoteA.get(id) as PoolRecord;
        const poolB = byQuoteB.get(id) as PoolRecord;
        const quote = quotes.get(id) ?? { id, symbol: id };
        // Compare in human units: raw reserves of a p8 token and a p5 token
        // are not on the same scale, so ranking them directly picks the
        // token with the most decimals rather than the deepest market.
        const scale = Math.pow(10, Number.isFinite(Number(quote.precision)) ? Number(quote.precision) : 0);
        const score = Math.min(quoteReserve(poolA, id), quoteReserve(poolB, id)) / scale;
        if (!Number.isFinite(score) || score <= 0) continue;
        routes.push({ quote, legs: [{ pool: poolA }, { pool: poolB }], score });
    }
    const preferred = (route: CrossRoute) => {
        const symbol = String(route.quote.symbol || '').toUpperCase();
        const id = String(route.quote.id || '');
        return PREFERRED_BRIDGE_SYMBOLS.includes(symbol) || PREFERRED_BRIDGE_IDS.includes(id) ? 0 : 1;
    };
    return routes.sort((x, y) => preferred(x) - preferred(y) || y.score - x.score);
}

async function defaultFetchLeg(poolId: string, legAsset: CrossAsset, quote: CrossAsset, opts: CrossFetchOpts): Promise<number[][]> {
    const interval = Number(opts.intervalSeconds) || 3600;
    return fetchCandlesSequentially(poolId, legAsset, quote, {
        intervalSeconds: interval,
        timeRange: opts.timeRange ?? undefined,
        chunkMonths: Number(opts.chunkMonths) || 1,
    }, outputPath(poolId, interval, legAsset, quote));
}

/**
 * Try each bridge route in liquidity order until one yields crossed candles.
 * Returns null when no route has data on both sides.
 */
async function fetchCrossPoolCandlesForPair(
    assetA: CrossAsset,
    assetB: CrossAsset,
    opts: CrossFetchOpts,
    client: CrossClient | null,
): Promise<{ route: CrossRoute; candles: number[][] } | null> {
    const routes = opts.routes ?? await findCrossRoutes(assetA, assetB, client);
    const fetchLeg = typeof opts.fetchLeg === 'function' ? opts.fetchLeg : defaultFetchLeg;
    for (const route of routes) {
        const quoteLabel = route.quote.symbol || route.quote.id || '?';
        try {
            const left = await fetchLeg(String(route.legs[0].pool.id ?? ''), assetA, route.quote, opts);
            if (!Array.isArray(left) || left.length === 0) continue;
            const right = await fetchLeg(String(route.legs[1].pool.id ?? ''), assetB, route.quote, opts);
            if (!Array.isArray(right) || right.length === 0) continue;
            const candles = synthesizeCrossCandles(left, right);
            if (candles.length > 0) return { route, candles };
        } catch (err) {
            console.warn(`[cross] route via ${quoteLabel} failed: ${getErrorMessage(err)}`);
        }
    }
    return null;
}

export { findCrossRoutes, fetchCrossPoolCandlesForPair }
export type { CrossAsset, CrossClient, CrossRoute, CrossFetchOpts }
export const __test = { poolAssetIds, quoteReserve, listPoolsByAsset, scanAllPools, resolveQuoteAssets };

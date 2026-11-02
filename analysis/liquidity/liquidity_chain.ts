'use strict';

/**
 * CHAIN READ HELPERS for the liquidity depth chart.
 *
 * Thin, dependency-injected wrappers over the read-only chain client so the
 * order-book/pool decoding can be unit-tested with a stub `db()` function.
 * Analysis connections never use the production singleton client (see
 * analysis/chain_pool.ts).
 */

import { blockchainToFloat } from '../../modules/order/utils/math.js';
import type { BookSides, PoolState, RawOrderBook } from './liquidity_depth_model.js';
import { normalizeOrderBook } from './liquidity_depth_model.js';

interface ChainDbClient {
    db(method: string, args?: unknown[]): Promise<unknown>;
}

interface ChainAsset {
    id: string;
    symbol: string;
    precision: number;
}

interface RawLimitOrder {
    id?: string;
    for_sale?: string | number;
    sell_price?: {
        base?: { amount?: string | number; asset_id?: string };
        quote?: { amount?: string | number; asset_id?: string };
    };
}

interface RawPool {
    id?: string;
    asset_a?: string;
    asset_b?: string;
    asset_ids?: string[];
    balance_a?: string | number;
    balance_b?: string | number;
    share_asset?: string;
    taker_fee_percent?: number;
}

const ASSET_ID_RE = /^1\.3\.\d+$/;

async function resolveAsset(client: ChainDbClient, ref: string): Promise<ChainAsset> {
    const probe = String(ref || '').trim();
    if (!probe) throw new Error('Asset reference is empty');
    const method = ASSET_ID_RE.test(probe) ? 'get_assets' : 'lookup_asset_symbols';
    const raw = await client.db(method, [[probe]]);
    const asset = Array.isArray(raw) ? raw[0] as Partial<ChainAsset> | null : null;
    if (!asset?.id || !asset.symbol || typeof asset.precision !== 'number') {
        throw new Error(`Cannot resolve asset '${probe}' on chain`);
    }
    return { id: asset.id, symbol: asset.symbol, precision: asset.precision };
}

/**
 * Decode raw limit orders into real bid/ask sides with display prices
 * (quote per base) and quote/base amounts.
 *
 * `get_order_book` and `get_limit_orders` share the same side convention: an
 * order whose `sell_price.base` is the requested base SELLS the base (real
 * ask); the other side sells the quote (real bid).
 */
function normalizeLimitOrders(
    orders: unknown,
    base: ChainAsset,
    quote: ChainAsset,
): BookSides {
    const bids: BookSides['bids'] = [];
    const asks: BookSides['asks'] = [];
    if (!Array.isArray(orders)) return { bids, asks };
    for (const entry of orders as RawLimitOrder[]) {
        const sellAsset = entry?.sell_price?.base?.asset_id;
        const baseRaw = Number(entry?.sell_price?.base?.amount);
        const quoteRaw = Number(entry?.sell_price?.quote?.amount);
        const forSale = Number(entry?.for_sale ?? baseRaw);
        if (!(baseRaw > 0) || !(quoteRaw > 0) || !(forSale > 0)) continue;
        const sellsBase = sellAsset === base.id;
        const sellsQuote = sellAsset === quote.id;
        if (!sellsBase && !sellsQuote) continue;

        // `received` is the amount of the other asset the seller gets for the
        // whole order; scaling by for_sale/baseRaw handles reduced fractions.
        const receivedRaw = forSale * (quoteRaw / baseRaw);
        if (sellsBase) {
            const soldBase = blockchainToFloat(forSale, base.precision);
            const receivedQuote = blockchainToFloat(receivedRaw, quote.precision);
            if (soldBase > 0 && receivedQuote > 0) {
                asks.push({ price: receivedQuote / soldBase, quote: receivedQuote, base: soldBase });
            }
        } else {
            const soldQuote = blockchainToFloat(forSale, quote.precision);
            const receivedBase = blockchainToFloat(receivedRaw, base.precision);
            if (soldQuote > 0 && receivedBase > 0) {
                bids.push({ price: soldQuote / receivedBase, quote: soldQuote, base: receivedBase });
            }
        }
    }
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);
    return { bids, asks };
}

/**
 * Fetch the order book, preferring `get_limit_orders` because nodes usually
 * cap `get_order_book` at 50 levels while `get_limit_orders` allows up to
 * ~300 per side. Falls back to `get_order_book` when the wider API is not
 * available. `depth` is per side.
 */
async function fetchOrderBook(
    client: ChainDbClient,
    base: ChainAsset,
    quote: ChainAsset,
    depth: number,
): Promise<BookSides> {
    const requested = Math.max(1, Math.floor(depth));
    const limits: number[] = [];
    for (const candidate of [requested, 300, 100, 50]) {
        if (candidate <= requested && !limits.includes(candidate)) limits.push(candidate);
    }

    for (const limit of limits) {
        try {
            const orders = await client.db('get_limit_orders', [base.id, quote.id, limit]);
            if (Array.isArray(orders)) return normalizeLimitOrders(orders, base, quote);
        } catch (err) {
            const message = String((err as Error)?.message ?? err);
            if (!/limit|configured_limit|unknown|not found|method/i.test(message)) throw err;
        }
    }

    // Conservative fallback: the classic order-book API (commonly capped at 50).
    for (const limit of limits) {
        if (limit > 50) continue;
        try {
            const raw = await client.db('get_order_book', [base.id, quote.id, limit]) as RawOrderBook | null;
            return normalizeOrderBook(raw);
        } catch (err) {
            const message = String((err as Error)?.message ?? err);
            if (!/limit|configured_limit/i.test(message)) throw err;
        }
    }
    const raw = await client.db('get_order_book', [base.id, quote.id, 50]) as RawOrderBook | null;
    return normalizeOrderBook(raw);
}

async function fetchPools(
    client: ChainDbClient,
    baseId: string,
    quoteId: string,
): Promise<RawPool[]> {
    const raw = await client.db('get_liquidity_pools_by_both_assets', [baseId, quoteId]);
    return Array.isArray(raw) ? raw as RawPool[] : [];
}

function poolAssetIds(pool: RawPool): [string | null, string | null] {
    const ids = Array.isArray(pool.asset_ids) ? pool.asset_ids : [];
    return [pool.asset_a ?? ids[0] ?? null, pool.asset_b ?? ids[1] ?? null];
}

/** Decode one raw pool into display reserves (base = asset A, quote = asset B). */
function decodePool(
    pool: RawPool | null | undefined,
    base: ChainAsset,
    quote: ChainAsset,
): PoolState | null {
    if (!pool) return null;
    const [assetA, assetB] = poolAssetIds(pool);
    const aIsBase = assetA === base.id;
    const aIsQuote = assetA === quote.id;
    if (!aIsBase && !aIsQuote) return null;
    if (aIsBase && assetB !== quote.id) return null;
    if (aIsQuote && assetB !== base.id) return null;

    const baseRaw = aIsBase ? pool.balance_a : pool.balance_b;
    const quoteRaw = aIsBase ? pool.balance_b : pool.balance_a;
    if (baseRaw == null || quoteRaw == null) return null;

    const baseReserve = blockchainToFloat(baseRaw, base.precision);
    const quoteReserve = blockchainToFloat(quoteRaw, quote.precision);
    if (!(baseReserve > 0) || !(quoteReserve > 0)) return null;

    // Chain stores the taker fee in 1/10000 units (50 => 0.5%).
    const feePercent = typeof pool.taker_fee_percent === 'number'
        ? pool.taker_fee_percent / 100
        : null;

    return {
        id: pool.id,
        shareAsset: pool.share_asset,
        baseReserve,
        quoteReserve,
        feePercent,
    };
}

/**
 * Decode and select a pool. With `poolId`, only that pool is considered;
 * otherwise the deepest pool (largest quote reserve) wins.
 */
function selectPool(
    pools: RawPool[],
    base: ChainAsset,
    quote: ChainAsset,
    poolId?: string | null,
): PoolState | null {
    const wanted = poolId ? String(poolId).trim() : null;
    const decoded = pools
        .filter((p) => !wanted || p.id === wanted)
        .map((p) => decodePool(p, base, quote))
        .filter((p): p is PoolState => p != null);
    if (decoded.length === 0) return null;
    decoded.sort((a, b) => b.quoteReserve - a.quoteReserve);
    return decoded[0];
}

export { resolveAsset, fetchOrderBook, normalizeLimitOrders, fetchPools, decodePool, selectPool };
export type { ChainDbClient, ChainAsset, RawLimitOrder, RawPool };

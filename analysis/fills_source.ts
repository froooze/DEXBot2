'use strict';

/**
 * SHARED FILLS SOURCE (analysis)
 *
 * Single implementation of the Kibana `fill_order` pipeline and the asset
 * precision table/cache used by the fill-based analysis tools. Both
 * trade_profitability.ts and grid_correction_check.ts carried verbatim copies
 * of this (43-entry ASSETS table, toReal/assetPrec helpers, on-chain precision
 * resolution, query builder and paginated fetch); all of it lives here now.
 */

import { getErrorMessage } from '../modules/utils/errors.js';
import * as KC from '../market_adapter/core/kibana_client.js';
import { withReadOnlyClient } from './chain_pool.js';

const { kibanaSearch, DEFAULT_CONFIG: BASE_CONFIG } = KC;

/** operation_type of a fill_order operation in the chain history index. */
const OP_FILL_ORDER = 4;
const BTS_ID = '1.3.0';

interface AssetInfo {
    symbol: string;
    precision: number;
}

interface AssetAmount {
    amount: number;
    asset_id: string;
}

interface FillRecord {
    time: string;
    blockNum: number;
    opNum: number;
    orderId: string;
    accountId: string;
    pays: AssetAmount;
    receives: AssetAmount;
    fee: AssetAmount;
    isMaker: boolean;
    sort: unknown[];
}

const ASSETS: Record<string, AssetInfo> = {
    '1.3.0':    { symbol: 'BTS',          precision: 5 },
    '1.3.118':  { symbol: 'GBP',          precision: 4 },
    '1.3.119':  { symbol: 'JPY',          precision: 2 },
    '1.3.120':  { symbol: 'EUR',          precision: 4 },
    '1.3.1325': { symbol: 'RUBLE',        precision: 5 },
    '1.3.2512': { symbol: 'EVRAZ',        precision: 4 },
    '1.3.3291': { symbol: 'TWENTIX',      precision: 5 },
    '1.3.4099': { symbol: 'XBTSX.STH',    precision: 6 },
    '1.3.4156': { symbol: 'XBTSX.DOGE',   precision: 5 },
    '1.3.4157': { symbol: 'XBTSX.BTC',    precision: 8 },
    '1.3.4159': { symbol: 'XBTSX.LTC',    precision: 8 },
    '1.3.4176': { symbol: 'XBTSX.DASH',   precision: 8 },
    '1.3.4274': { symbol: 'XBTSX.BCH',    precision: 8 },
    '1.3.4760': { symbol: 'XBTSX.ETH',    precision: 7 },
    '1.3.5537': { symbol: 'IOB.XRP',      precision: 4 },
    '1.3.5541': { symbol: 'XBTSX.BNB',    precision: 7 },
    '1.3.5589': { symbol: 'XBTSX.USDT',   precision: 6 },
    '1.3.5641': { symbol: 'HONEST.CNY',   precision: 4 },
    '1.3.5649': { symbol: 'HONEST.USD',   precision: 4 },
    '1.3.5650': { symbol: 'HONEST.BTC',   precision: 8 },
    '1.3.5659': { symbol: 'HONEST.ETH',   precision: 6 },
    '1.3.5870': { symbol: 'XBTSX.FIL',    precision: 6 },
    '1.3.5887': { symbol: 'XBTSX.RUB',    precision: 4 },
    '1.3.5902': { symbol: 'XBTSX.USDC',   precision: 6 },
    '1.3.6013': { symbol: 'XBTSX.HIVE',   precision: 6 },
    '1.3.6124': { symbol: 'XBTSX.AVAX',   precision: 6 },
    '1.3.6139': { symbol: 'XBTSX.XAUT',   precision: 6 },
    '1.3.6166': { symbol: 'XBTSX.MATIC',  precision: 5 },
    '1.3.6241': { symbol: 'XBTSX.ETC',    precision: 7 },
    '1.3.6268': { symbol: 'BTWTY.EOS',    precision: 4 },
    '1.3.6301': { symbol: 'HONEST.MONEY', precision: 8 },
    '1.3.6304': { symbol: 'HONEST.ADA',   precision: 8 },
    '1.3.6305': { symbol: 'HONEST.DOT',   precision: 8 },
    '1.3.6309': { symbol: 'HONEST.ATOM',  precision: 8 },
    '1.3.6311': { symbol: 'HONEST.ALGO',  precision: 8 },
    '1.3.6312': { symbol: 'HONEST.FIL',   precision: 8 },
    '1.3.6313': { symbol: 'HONEST.EOS',   precision: 8 },
    '1.3.6315': { symbol: 'HONEST.EUR',   precision: 4 },
    '1.3.6316': { symbol: 'HONEST.GBP',   precision: 4 },
    '1.3.6317': { symbol: 'HONEST.JPY',   precision: 4 },
    '1.3.6444': { symbol: 'IOB.XLM',      precision: 4 },
    '1.3.6573': { symbol: 'XBTSX.DAI',    precision: 6 },
    '1.3.6620': { symbol: 'XBTSX.A',      precision: 6 },
    '1.3.6627': { symbol: 'XBTSX.LINK',   precision: 6 },
};

/** Precisions/symbols learned on-chain this run (populated by resolveAssetPrecisions). */
const resolvedPrecisions: Record<string, number> = {};
const resolvedSymbols: Record<string, string> = {};

function assetSymbol(id: string): string {
    return ASSETS[id]?.symbol ?? resolvedSymbols[id] ?? id;
}

function assetPrec(id: string): number | undefined {
    return ASSETS[id]?.precision ?? resolvedPrecisions[id];
}

function toReal(amount: number, assetId: string): number {
    const p = assetPrec(assetId);
    if (p === undefined) return NaN;
    return amount / Math.pow(10, p);
}

/**
 * A fill needs strictly positive, finite amounts on both legs. A zero base
 * amount would produce an infinite price (quoteAmount / 0) that poisons
 * downstream inventory lots and PnL aggregates.
 */
function isValidFillAmounts(baseAmount: number, quoteAmount: number): boolean {
    return Number.isFinite(baseAmount) && Number.isFinite(quoteAmount)
        && baseAmount > 0 && quoteAmount > 0;
}

/** Match a user-supplied pair leg against a chain asset id or its symbol. */
function matchesAssetRef(ref: string, assetId: string): boolean {
    const want = String(ref).trim().toUpperCase();
    if (!want) return false;
    return assetId.toUpperCase() === want || assetSymbol(assetId).toUpperCase() === want;
}

interface ClassifiedFill {
    direction: 'buy' | 'sell';
    baseAsset: string;
    quoteAsset: string;
    baseAmount: number;
    quoteAmount: number;
    price: number;
}

/**
 * Resolve a raw fill's buy/sell direction, base/quote assets and real amounts.
 *
 * Direction/base/quote rules (single home for trade_profitability and
 * grid_correction_check, which previously carried verbatim copies):
 *  - BTS on the pays side  → buy the received asset, quote = BTS.
 *  - BTS on the receives side → sell the paid asset, quote = BTS.
 *  - any other cross-pair   → lower asset id is the base; sell when pays < receives.
 *
 * Returns `null` when an asset precision is unknown or either real amount is
 * not strictly positive/finite. Callers own the skip counting and any extra
 * validation (e.g. the market-fee asset check in trade_profitability).
 */
function classifyFill(f: FillRecord): ClassifiedFill | null {
    const pAsset = f.pays.asset_id;
    const rAsset = f.receives.asset_id;
    let direction: 'buy' | 'sell';
    let baseAsset: string;
    let quoteAsset: string;
    let baseAmount: number;
    let quoteAmount: number;

    if (pAsset === BTS_ID && rAsset !== BTS_ID) {
        direction = 'buy';
        baseAsset = rAsset;
        quoteAsset = BTS_ID;
        baseAmount = toReal(f.receives.amount, rAsset);
        quoteAmount = toReal(f.pays.amount, BTS_ID);
    } else if (rAsset === BTS_ID && pAsset !== BTS_ID) {
        direction = 'sell';
        baseAsset = pAsset;
        quoteAsset = BTS_ID;
        baseAmount = toReal(f.pays.amount, pAsset);
        quoteAmount = toReal(f.receives.amount, BTS_ID);
    } else {
        // Non-BTS cross-pair: consistent ordering (lower asset id = base).
        const baseForCheck = pAsset < rAsset ? pAsset : rAsset;
        const quoteForCheck = pAsset < rAsset ? rAsset : pAsset;
        if (assetPrec(baseForCheck) === undefined || assetPrec(quoteForCheck) === undefined) return null;
        const isSell = pAsset < rAsset;
        direction = isSell ? 'sell' : 'buy';
        baseAsset = isSell ? pAsset : rAsset;
        quoteAsset = isSell ? rAsset : pAsset;
        baseAmount = toReal(isSell ? f.pays.amount : f.receives.amount, baseAsset);
        quoteAmount = toReal(isSell ? f.receives.amount : f.pays.amount, quoteAsset);
    }

    if (!isValidFillAmounts(baseAmount, quoteAmount)) return null;
    return { direction, baseAsset, quoteAsset, baseAmount, quoteAmount, price: quoteAmount / baseAmount };
}

/**
 * Collect all unique non-BTS asset IDs from fills, resolve unknown precisions
 * from the blockchain, and populate the runtime cache.
 */
async function resolveAssetPrecisions(fills: FillRecord[]): Promise<void> {
    const unknownIds = new Set<string>();
    for (const f of fills) {
        for (const id of [f.pays.asset_id, f.receives.asset_id, f.fee.asset_id]) {
            if (id !== BTS_ID && !(id in ASSETS) && !(id in resolvedPrecisions)) {
                unknownIds.add(id);
            }
        }
    }
    if (unknownIds.size === 0) return;

    const ids = [...unknownIds];
    console.log(`  Resolving ${ids.length} unknown asset(s) from blockchain...`);
    try {
        await withReadOnlyClient(async (client) => {
            const assets = await client.db('get_assets', [ids]);
            if (Array.isArray(assets)) {
                for (const asset of assets) {
                    if (asset?.id && asset.precision != null) {
                        resolvedPrecisions[asset.id] = asset.precision;
                        if (asset.symbol) resolvedSymbols[asset.id] = String(asset.symbol);
                        console.log(`    ${asset.id} → ${asset.symbol || '?'} (precision ${asset.precision})`);
                    }
                }
            }
            const missing = ids.filter(id => !(id in resolvedPrecisions));
            if (missing.length > 0) {
                console.warn(`  [warn] ${missing.length} asset(s) not found on chain: ${missing.join(', ')}. Fills referencing them will be skipped.`);
            }
        });
    } catch (e) {
        console.warn(`  [warn] Asset resolution failed: ${getErrorMessage(e)}. Fills with unknown assets will be skipped.`);
    }
}

function buildFillQuery(accountId: string, gte: string, lte: string, size: number) {
    return {
        size,
        track_total_hits: false,
        _source: [
            'block_data.block_time',
            'block_data.block_num',
            'operation_id_num',
            'operation_history.op_object.pays',
            'operation_history.op_object.receives',
            'operation_history.op_object.fee',
            'operation_history.op_object.order_id',
            'operation_history.op_object.account_id',
            'operation_history.op_object.is_maker',
        ],
        query: {
            bool: {
                filter: [
                    { term: { operation_type: OP_FILL_ORDER } },
                    { term: { 'operation_history.op_object.account_id.keyword': accountId } },
                    { range: { 'block_data.block_time': { gte, lte } } },
                ],
            },
        },
        sort: [
            { 'block_data.block_time': { order: 'asc' } },
            { operation_id_num: { order: 'asc' } },
        ],
    };
}

interface FillHit {
    _source?: {
        operation_history?: { op_object?: {
            pays?: { amount?: unknown; asset_id?: unknown };
            receives?: { amount?: unknown; asset_id?: unknown };
            fee?: { amount?: unknown; asset_id?: unknown };
            order_id?: unknown;
            account_id?: unknown;
            is_maker?: unknown;
        } };
        block_data?: { block_time?: unknown; block_num?: unknown };
        operation_id_num?: unknown;
    };
    sort?: unknown[];
}

/** Fetch every fill_order for an account in [gte, lte], paginated via search_after. */
async function fetchAllFills(config: Record<string, unknown>, accountId: string, gte: string, lte: string): Promise<FillRecord[]> {
    const pageSize = 10000;
    const fills: FillRecord[] = [];
    let searchAfter: unknown[] | null = null;
    const cfg = { ...BASE_CONFIG, timeout: 60000, ...config };

    while (true) {
        const query = buildFillQuery(accountId, gte, lte, pageSize);
        if (searchAfter) (query as { search_after?: unknown[] }).search_after = searchAfter;

        const result = await kibanaSearch(cfg as never, query) as { hits?: { hits?: unknown[] } } | null;
        const hits = result?.hits?.hits ?? [];
        if (!hits.length) break;

        for (const rawHit of hits) {
            const hit = rawHit as FillHit;
            const src = hit?._source;
            const op = src?.operation_history?.op_object;
            if (!op || !op.pays || !op.receives) continue;

            fills.push({
                time: String(src.block_data?.block_time ?? ''),
                blockNum: Number(src.block_data?.block_num ?? 0),
                opNum: Number(src.operation_id_num ?? 0),
                orderId: String(op.order_id ?? ''),
                accountId: String(op.account_id ?? ''),
                pays: { amount: Number(op.pays.amount ?? 0), asset_id: String(op.pays.asset_id ?? '') },
                receives: { amount: Number(op.receives.amount ?? 0), asset_id: String(op.receives.asset_id ?? '') },
                fee: { amount: Number(op.fee?.amount ?? 0), asset_id: String(op.fee?.asset_id ?? '') },
                isMaker: Boolean(op.is_maker ?? false),
                sort: hit.sort ?? [],
            });
        }

        if (hits.length < pageSize) break;
        searchAfter = (hits[hits.length - 1] as FillHit).sort ?? null;
        if (!Array.isArray(searchAfter)) break;
    }

    return fills;
}

export {
    BTS_ID,
    assetSymbol,
    assetPrec,
    matchesAssetRef,
    classifyFill,
    resolveAssetPrecisions,
    fetchAllFills,
    FillRecord,
};

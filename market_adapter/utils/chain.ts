'use strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);


import { API_LIMITS } from '../../modules/constants.js';
import { normalizeAssetSymbol } from '../../modules/utils/asset_symbols.js';
import type { UnknownRecord } from '../../modules/types.js';
import { isUnknownRecord } from '../../modules/types.js';

/** A dynamic JSON-RPC proxy: any method returns a promise of an unknown result. */
interface RpcProxy {
    [method: string]: (...args: unknown[]) => Promise<unknown>;
}

/** The read-only BitShares client shape this module consumes. */
interface RpcClient {
    BitShares: {
        db: RpcProxy;
        history: RpcProxy;
        [method: string]: unknown;
    };
}

/** The adapter_client module shape (superset of {@link RpcClient}). */
interface BitsharesClient extends RpcClient {
    connectClient: (servers?: string[]) => Promise<unknown>;
    disconnectClient: () => unknown;
    [key: string]: unknown;
}

/** Resolved asset identity used by the pool/context helpers. */
interface ResolvedAsset {
    id: string;
    precision: number;
    symbol: string;
}

interface PoolObject extends UnknownRecord {
    id?: string;
}

interface FindPoolOptions {
    bitsharesClient?: RpcClient;
    sortBy?: 'totalBalance' | 'assetABalance';
}

let _bitsharesClient: BitsharesClient | null = null;

function getBitsharesClient(): BitsharesClient {
    // lazy require to avoid circular dependencies at module load time
    if (!_bitsharesClient) {
        _bitsharesClient = require('./adapter_client') as BitsharesClient;
    }
    return _bitsharesClient;
}

function setBitsharesClientForTests(client: BitsharesClient | null): void {
    _bitsharesClient = client;
}

async function resolveAsset(symbol: unknown, bitsharesClient: RpcClient | null = null): Promise<ResolvedAsset> {
    if (!symbol || typeof symbol !== 'string') {
        throw new Error(`Cannot resolve asset: invalid or missing symbol "${String(symbol)}"`);
    }
    // BitShares symbols are canonical UPPERCASE and `lookup_asset_symbols` is
    // case-sensitive (a lowercase symbol resolves to null), so normalize here
    // and hand the canonical symbol downstream (cache keys, Kibana terms,
    // chart labels) instead of the raw input.
    const canonical = normalizeAssetSymbol(symbol);
    const client = bitsharesClient || getBitsharesClient();
    const results = await client.BitShares.db.lookup_asset_symbols([canonical]);
    const asset = Array.isArray(results) ? results[0] : undefined;
    if (!isUnknownRecord(asset) || typeof asset.id !== 'string' || typeof asset.precision !== 'number') {
        throw new Error(`Cannot resolve asset "${canonical}": lookup failed`);
    }
    return { id: asset.id, precision: asset.precision, symbol: String(asset.symbol || canonical) };
}

/** Balance of `idAStr` in a pool object (both `asset_a` and `asset_ids[]` shapes). */
function poolBalanceFor(idAStr: string, p: UnknownRecord): number {
    const assetIds = Array.isArray(p.asset_ids) ? p.asset_ids : null;
    const value = String(p.asset_a ?? assetIds?.[0] ?? '') === idAStr
        ? Number(p.balance_a)
        : String(p.asset_b ?? assetIds?.[1] ?? '') === idAStr
            ? Number(p.balance_b)
            : Number.NEGATIVE_INFINITY;
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Total liquidity of a pool object. */
function poolTotalBalance(p: UnknownRecord): number {
    return Number(p.balance_a ?? 0) + Number(p.balance_b ?? 0);
}

async function findPoolByAssets(assetAId: string, assetBId: string, options: FindPoolOptions = {}): Promise<PoolObject> {
    const client = options.bitsharesClient || getBitsharesClient();
    const { BitShares } = client;
    const sortBy = options.sortBy || 'totalBalance'; // 'totalBalance' or 'assetABalance'

    if (typeof BitShares.db?.get_liquidity_pools_by_both_assets === 'function') {
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_both_assets(assetAId, assetBId);
            if (Array.isArray(pools) && pools.length > 0) {
                const valid = pools.filter((p): p is UnknownRecord => isUnknownRecord(p) && Boolean(p.id));
                if (valid.length) {
                    const idAStr = String(assetAId);
                    if (sortBy === 'assetABalance') {
                        return valid.slice().sort((a, b) => poolBalanceFor(idAStr, b) - poolBalanceFor(idAStr, a))[0] as PoolObject;
                    }
                    return valid.slice().sort((x, y) => poolTotalBalance(y) - poolTotalBalance(x))[0] as PoolObject;
                }
            }
        } catch (_) {
            console.warn(`[chain] get_liquidity_pools_by_both_assets failed for ${assetAId}/${assetBId}`);
        }
    }

    const listFn = BitShares.db?.list_liquidity_pools ?? BitShares.db?.get_liquidity_pools;
    if (typeof listFn === 'function') {
        let startId = '1.19.0';
        const page = API_LIMITS.POOL_BATCH_SIZE;
        const a = String(assetAId);
        const b = String(assetBId);

        let scannedBatches = 0;
        while (true) {
            if (scannedBatches++ >= API_LIMITS.MAX_POOL_SCAN_BATCHES) break;
            const pools = await listFn(page, startId);
            if (!Array.isArray(pools) || pools.length === 0) break;

            const effective = startId === '1.19.0' ? pools : pools.slice(1);
            const matches = effective.filter((p): p is UnknownRecord => {
                if (!isUnknownRecord(p)) return false;
                const ids = (Array.isArray(p.asset_ids) ? p.asset_ids : [p.asset_a, p.asset_b]).map(String);
                return ids.includes(a) && ids.includes(b);
            });
            if (matches.length > 0) {
                if (sortBy === 'assetABalance') {
                    const idAStr = String(assetAId);
                    return matches.slice().sort((x, y) => poolBalanceFor(idAStr, y) - poolBalanceFor(idAStr, x))[0] as PoolObject;
                }
                return matches.slice().sort((x, y) => poolTotalBalance(y) - poolTotalBalance(x))[0] as PoolObject;
            }

            if (pools.length < page) break;
            const last = pools[pools.length - 1];
            if (!isUnknownRecord(last) || typeof last.id !== 'string') break;
            startId = last.id;
        }
    }

    throw new Error(`No liquidity pool found for ${assetAId}/${assetBId}`);
}

function isExactPair(a: unknown, b: unknown, targetA: unknown, targetB: unknown): boolean {
    const na = normalizeAssetSymbol(a);
    const nb = normalizeAssetSymbol(b);
    const nta = normalizeAssetSymbol(targetA);
    const ntb = normalizeAssetSymbol(targetB);
    return na === nta && nb === ntb;
}

function isSamePair(a: unknown, b: unknown, targetA: unknown, targetB: unknown): boolean {
    return isExactPair(a, b, targetA, targetB) || isExactPair(a, b, targetB, targetA);
}

function isExactPairIds(aId: unknown, bId: unknown, targetAId: unknown, targetBId: unknown): boolean {
    const sa = String(aId || '');
    const sb = String(bId || '');
    const sta = String(targetAId || '');
    const stb = String(targetBId || '');
    return sa === sta && sb === stb;
}

function isSamePairIds(aId: unknown, bId: unknown, targetAId: unknown, targetBId: unknown): boolean {
    return isExactPairIds(aId, bId, targetAId, targetBId) || isExactPairIds(aId, bId, targetBId, targetAId);
}

function normalizeMarketSource(raw: unknown): 'pool' | 'book' | null {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'pool') return 'pool';
    if (value === 'book') return 'book';
    return null;
}

function hasNumericStartPrice(raw: unknown): boolean {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
}

function resolveMarketSourceForBot(bot: unknown): 'pool' | 'book' | null {
    if (!isUnknownRecord(bot)) return 'pool';
    if (hasNumericStartPrice(bot.startPrice)) return null;
    return normalizeMarketSource(bot.startPrice) || 'pool';
}

function normalizePoolId(id: unknown): string | null {
    if (id == null) return null;
    const s = String(id).trim();
    return s.startsWith('1.19.') ? s : `1.19.${s}`;
}

interface ResolvedBotContext {
    assetA: ResolvedAsset;
    assetB: ResolvedAsset;
    poolId: string | null;
    marketSource: 'pool' | 'book' | null;
}

async function resolveBotContext(bot: UnknownRecord): Promise<ResolvedBotContext> {
    if (!bot.assetAId && !bot.assetA) {
        throw new Error(`Bot "${String(bot.botKey)}" config is missing assetA symbol or ID`);
    }
    if (!bot.assetBId && !bot.assetB) {
        throw new Error(`Bot "${String(bot.botKey)}" config is missing assetB symbol or ID`);
    }

    const assetA: ResolvedAsset = typeof bot.assetAId === 'string' && typeof bot.assetAPrecision === 'number' && Number.isFinite(bot.assetAPrecision)
        ? { id: bot.assetAId, precision: bot.assetAPrecision, symbol: String(bot.assetA ?? '') }
        : await resolveAsset(bot.assetA);

    const assetB: ResolvedAsset = typeof bot.assetBId === 'string' && typeof bot.assetBPrecision === 'number' && Number.isFinite(bot.assetBPrecision)
        ? { id: bot.assetBId, precision: bot.assetBPrecision, symbol: String(bot.assetB ?? '') }
        : await resolveAsset(bot.assetB);

    if (hasNumericStartPrice(bot.startPrice)) {
        return {
            assetA,
            assetB,
            poolId: null,
            marketSource: null,
        };
    }

    const marketSource = normalizeMarketSource(bot.startPrice) || 'pool';

    let poolId: string | null = null;
    if (marketSource === 'pool') {
        poolId = bot.poolId
            ? normalizePoolId(bot.poolId)
            : normalizePoolId((await findPoolByAssets(assetA.id, assetB.id)).id);
    }

    return { assetA, assetB, poolId, marketSource };
}

export { resolveAsset, findPoolByAssets, normalizeAssetSymbol, normalizeMarketSource, normalizePoolId, hasNumericStartPrice, resolveMarketSourceForBot, resolveBotContext, isExactPair, isSamePair, isExactPairIds, isSamePairIds, getBitsharesClient, setBitsharesClientForTests }

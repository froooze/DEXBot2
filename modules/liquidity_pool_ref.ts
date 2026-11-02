'use strict';

/**
 * modules/liquidity_pool_ref.ts - Liquidity-pool reference resolution.
 *
 * Every command that takes a pool or an asset pair (`dexbot liq`, `dexbot tv`,
 * `dexbot dw`, and the liquidity analyzer behind them) accepts the same two
 * pool spellings:
 *
 *   - object id:  133  or  1.19.133
 *   - pool token: the symbol of the pool's LP share asset — the same value a
 *                 bot can name in its `pool` setting.
 *
 * Parsing and chain lookup live here so those commands cannot drift (numeric
 * ids recognised by one, pool tokens by another) and so they all report the
 * same "not a pool" error.
 *
 * Browser-safe: the chain is reached through a caller-supplied read function,
 * so the same logic serves the script wrappers (shared client), the analysis
 * entries (ephemeral RPC client) and unit tests (stubs).
 */

import { resolveAssetRef } from './asset_lookup.js';

interface RawPoolLike {
    id?: string;
    asset_a?: string;
    asset_b?: string;
    asset_ids?: string[];
    share_asset?: string;
}

/** Minimal database_api read surface: `(method, args) → decoded result`. */
type ChainRead = (method: string, args?: unknown[]) => Promise<unknown>;

const POOL_ID_RE = /^1\.19\.\d+$/;
const POOL_NUM_RE = /^\d+$/;

/** `133` / `1.19.133` → `1.19.133`; anything else (a pool token) → null. */
function normalizePoolRef(ref: unknown): string | null {
    const probe = String(ref ?? '').trim();
    if (POOL_ID_RE.test(probe)) return probe;
    if (POOL_NUM_RE.test(probe)) return `1.19.${probe}`;
    return null;
}

/** True when the reference is a numeric pool id rather than a pool token. */
function isPoolIdRef(ref: unknown): boolean {
    return normalizePoolRef(ref) !== null;
}

// Deliberately a junk filter, not a symbol validator: the chain owns the real
// symbol rules, so this only rejects references that could never name anything
// (empty, whitespace, or pair syntax) and lets every plausible token through.
const POOL_REF_SHAPE_RE = /^[^\s/]{1,64}$/;

/**
 * True when the reference *could* name a pool (numeric id or pool-token shape).
 * Used by the CLI wrappers to fail fast on junk while still accepting tokens;
 * only the chain can confirm a token exists.
 */
function isPoolRefLike(ref: unknown): boolean {
    const probe = String(ref ?? '').trim();
    return isPoolIdRef(probe) || POOL_REF_SHAPE_RE.test(probe);
}

/** Pool asset ids, tolerating both `asset_a`/`asset_b` and the `asset_ids` array. */
function poolAssetIds(pool: RawPoolLike | null | undefined): [string | null, string | null] {
    if (!pool) return [null, null];
    const ids = Array.isArray(pool.asset_ids) ? pool.asset_ids : [];
    return [pool.asset_a ?? ids[0] ?? null, pool.asset_b ?? ids[1] ?? null];
}

/**
 * Normalize one `get_objects` / share-asset result entry: nodes answer with the
 * pool object, occasionally nested in a result array, and some wrap it as
 * `{ pool: {...} }`. All three shapes resolve to the pool itself.
 */
function unwrapPool(entry: unknown): RawPoolLike | null {
    if (Array.isArray(entry)) {
        for (const inner of entry) {
            const pool = unwrapPool(inner);
            if (pool) return pool;
        }
        return null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as RawPoolLike & { pool?: RawPoolLike };
    if (record.id) return record;
    return record.pool && record.pool.id ? record.pool : null;
}

/**
 * Resolve one pool reference to its raw chain object.
 *
 * Numeric references hit `get_objects` directly; a pool token is resolved
 * through `lookup_asset_symbols` (the symbol as typed, then its canonical
 * UPPERCASE form) and `get_liquidity_pools_by_share_asset`.
 */
async function resolvePoolRef(read: ChainRead, ref: unknown): Promise<RawPoolLike> {
    const probe = String(ref ?? '').trim();
    if (!probe) throw new Error('Pool reference is empty');

    const poolId = normalizePoolRef(probe);
    if (poolId) {
        const raw = await read('get_objects', [[poolId]]);
        const pool = unwrapPool(raw);
        if (!pool?.id) throw new Error(`Liquidity pool ${poolId} not found on chain`);
        return pool;
    }

    const shareAsset = await resolveShareAsset(read, probe);
    const raw = await read('get_liquidity_pools_by_share_asset', [[shareAsset.id], false, false]);
    const pools = (Array.isArray(raw) ? raw : [])
        .map(unwrapPool)
        .filter((entry): entry is RawPoolLike => entry != null);
    if (pools.length === 0) {
        throw new Error(`'${probe}' (${shareAsset.id}) is not a liquidity-pool token; pass a pool id (133/1.19.133) or the pool token symbol`);
    }
    return pools[0];
}

/** Look up the LP share asset by symbol, case-insensitively (shared resolver). */
async function resolveShareAsset(read: ChainRead, symbol: string): Promise<{ id: string; symbol: string }> {
    const asset = await resolveAssetRef(read, symbol);
    if (!asset?.id) {
        throw new Error(`Pool token '${symbol}' not found on chain (expected the pool's LP share-asset symbol or a pool id like 133/1.19.133)`);
    }
    return { id: String(asset.id), symbol: String(asset.symbol ?? symbol) };
}

export { normalizePoolRef, isPoolIdRef, isPoolRefLike, poolAssetIds, resolvePoolRef };
export type { RawPoolLike, ChainRead };

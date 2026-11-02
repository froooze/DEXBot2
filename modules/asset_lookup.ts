'use strict';

/**
 * CHAIN ASSET LOOKUP (case-insensitive, one implementation)
 *
 * Every CLI path that takes an asset from a human — `dexbot asset <symbol>`,
 * `dexbot rich <asset...>`, `dexbot liq`/`tv`/`dw` pairs, the liquidity
 * analyzer's `--base/--quote`, pool tokens — resolves it through here.
 *
 * BitShares stores symbols canonically UPPERCASE and `get_assets` /
 * `lookup_asset_symbols` are case-sensitive, so `dexbot asset token.sym`
 * found nothing while `TOKEN.SYM` worked. The reference is therefore
 * normalized with `normalizeAssetSymbol` (modules/utils/asset_symbols.ts) and
 * looked up in ONE batched `get_assets` call, which accepts symbols and
 * `1.3.x` ids alike and returns the extended asset object.
 *
 * Only when the canonical spelling misses is the spelling as typed retried, so
 * a node that really does hold a non-canonical symbol still resolves.
 *
 * The reader is injected, so the module stays browser-safe.
 */

import { assetSymbolCandidates } from './utils/asset_symbols.js';

/** Ids/refs per `get_assets` call; get_assets has no page limit to respect. */
const LOOKUP_BATCH = 250;

type ChainRead = (method: string, args: unknown[]) => Promise<unknown>;

interface RawAssetObject {
    id?: string;
    symbol?: string;
    precision?: number;
    [key: string]: unknown;
}

interface AssetLookupResult {
    /** The reference exactly as the caller passed it (for error messages). */
    request: string;
    /** The chain object, or null when the reference does not exist. */
    asset: RawAssetObject | null;
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

async function getAssets(read: ChainRead, refs: string[]): Promise<(RawAssetObject | null)[]> {
    const out: (RawAssetObject | null)[] = [];
    for (const batch of chunk(refs, LOOKUP_BATCH)) {
        const rows = await read('get_assets', [batch]) as (RawAssetObject | null)[] | null;
        for (let i = 0; i < batch.length; i++) {
            const row = Array.isArray(rows) ? rows[i] : null;
            out.push(row && typeof row.id === 'string' ? row : null);
        }
    }
    return out;
}

/**
 * Resolve asset references (symbols in any case, or `1.3.x` ids), preserving
 * the caller's order. Unresolvable references come back with `asset: null`.
 */
async function lookupAssetRefs(read: ChainRead, refs: unknown[]): Promise<AssetLookupResult[]> {
    const requested = refs.map((ref) => String(ref ?? '').trim());
    // Canonical spelling first (ids pass through), spelling as typed as fallback.
    const candidates = requested.map((ref) => assetSymbolCandidates(ref));
    const primary = candidates.map((list) => list[1] ?? list[0] ?? '');
    // Nothing to look up for empty refs; keep the slots so order is preserved.
    const indexes = requested.map((_, index) => index).filter((index) => primary[index] !== '');
    const resolved = new Map<number, RawAssetObject | null>();

    if (indexes.length > 0) {
        const rows = await getAssets(read, indexes.map((index) => primary[index]));
        indexes.forEach((index, offset) => resolved.set(index, rows[offset] ?? null));

        // A node could hold a non-canonical (lowercase) symbol: retry just those
        // refs with the spelling as typed, once, in a single batch.
        const retry = indexes.filter((index) => !resolved.get(index) && (candidates[index][0] ?? '') !== primary[index]);
        if (retry.length > 0) {
            const retried = await getAssets(read, retry.map((index) => candidates[index][0]));
            retry.forEach((index, offset) => {
                if (retried[offset]) resolved.set(index, retried[offset]);
            });
        }
    }

    return requested.map((request, index) => ({ request, asset: resolved.get(index) ?? null }));
}

/** Resolve one asset reference, or null when it does not exist on chain. */
async function resolveAssetRef(read: ChainRead, ref: unknown): Promise<RawAssetObject | null> {
    const [result] = await lookupAssetRefs(read, [ref]);
    return result?.asset ?? null;
}

export { LOOKUP_BATCH, lookupAssetRefs, resolveAssetRef };
export type { ChainRead, RawAssetObject, AssetLookupResult };

/**
 * modules/order/utils/system.ts - System and I/O Utilities
 * 
 * Price derivation, persistence, grid correction, and UI/interactive utilities.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (43 exported functions + 11 structural view types)
 * ===============================================================================
 *
 * SECTION 1: PRICE DERIVATION (9 functions + 1 internal)
 *   - lookupAsset(BitShares, symbol) - Lookup asset metadata from blockchain
 *   - resolveAssetByRef(BitShares, ref) - Resolve a full asset object from id/symbol
 *   - deriveMarketPrice(BitShares, symA, symB) - Derive price from order book
 *   - derivePoolPrice(BitShares, symA, symB) - Derive price from liquidity pool
 *   - setDerivePriceTestHook(hook) - Test-only seam for derivePrice
 *   - derivePrice(BitShares, symA, symB, mode) - Derive price with fallback chain
 *   - derivePriceViaBridges(BitShares, symA, symB, bridges, mode) - Multi-hop price via bridge assets
 *   - derivePriceWithBridges(BitShares, symA, symB, bridges, mode) - Direct price, else bridge hops
 *   - deriveLiquidityPoolTokenValue(BitShares, symA, symB) - Derive LP token value
 *   - resolveLiquidityPoolByShareAsset(BitShares, shareAsset) - Resolve LP by share asset (internal)
 *
 * SECTION 2: AMA CENTER SNAPSHOT (2 functions)
 *   - loadAmaCenterSnapshot(manager) - Load the full dynamic-grid snapshot
 *   - loadAmaCenterPrice(manager) - Load the AMA center price
 *
 * SECTION 3: FEE MANAGEMENT (1 function)
 *   - initializeFeeCache(botsConfig, BitShares) - Initialize fee cache from blockchain
 *
 * SECTION 4: GRID STATE MANAGEMENT (5 functions)
 *   - persistGridSnapshot(manager, accountOrders) - Persist grid to storage
 *   - restoreGapEvacStreaks(manager) - Restore persisted gap-evacuation streaks
 *   - retryPersistenceIfNeeded(manager) - Retry persistence if previous failed
 *   - applyGridDivergenceCorrections(manager, ...) - Apply grid divergence corrections
 *   - applyPersistedPendingCrawls(...) - Apply persisted-but-uncommitted fill crawls
 *
 * SECTION 5: SPREAD-CORRECTION READINESS (7 functions)
 *   - resolveSpreadFreshnessMs(manager) - The single freshness window for spread trust
 *   - resolveSpreadCrossingFloor(manager) - Crossing floor spread correction must not trade through
 *   - refreshLiveMarketPrice(manager) - Refresh the cached live market price
 *   - maybeRefreshLiveMarketPrice(manager) - Refresh if stale, paced to one attempt per window
 *   - evaluateSpreadCorrectionReadiness(manager) - Evaluate whether spread correction may act
 *   - resolveSpreadMarketReference(manager) - Resolve the last real FILL price
 *   - resolveLastFillGuardReference(manager) - Resolve the reference the LAST-FILL-GUARD judges
 *
 * SECTION 6: LAST-FILL / MARKET-FILL PERSISTENCE (6 functions)
 *   - restoreLastMarketFill(manager) - Restore the persisted last-market-fill reference
 *   - normalizeLastFillPivot(row) - Normalize a persisted LAST-FILL-GUARD pivot row
 *   - normalizeLastMarketFill(row) - Normalize a persisted last-market-fill row
 *   - setLastFillPivot(manager, ...) - Write the LAST-FILL-GUARD pivot scalar family
 *   - resetLastFillPivot(manager) - Clear the pivot to cold state
 *   - restoreLastFillPivot(manager) - Restore the persisted pivot into the manager
 *
 * SECTION 7: UI & INTERACTIVE UTILITIES (6 functions)
 *   - ensureProfilesDirectory(profilesDir) - Ensure profiles directory exists
 *   - sleep(ms) - Pause execution for specified duration
 *   - readInput(prompt, options) - Read user input from stdin
 *   - readPassword(prompt) - Read password with masked echo
 *   - withRetry(fn, options) - Execute async function with exponential backoff
 *   - withBlockchainRetry(fn, label, options) - Blockchain op with timeout + retry + node failover
 *   (withTimeout lives in ./timeout)
 *
 * SECTION 8: GENERAL UTILITIES (7 functions)
 *   - resolveAccountRef(manager, account) - Resolve best account reference
 *   - deepFreeze(obj) - Recursively freeze object for immutability
 *   - cloneMap(map) - Create shallow clone of Map
 *   - ensureDir(dirPath) - Ensure directory exists, creating recursively
 *   - nowIso() - Current time as an ISO string
 *   - fireStructuralResync(manager, ...) - Fire-and-forget structural grid resync
 *   - parseJsonWithComments(raw) - Parse JSON with comment stripping
 *
 * STRUCTURAL VIEW TYPES:
 *   AssetMeta, PoolReserve, PoolEntry, BitSharesClient, AmaCenterSnapshot,
 *   FeeCacheEntryData, SpreadCorrectionRefusalReason, SpreadCorrectionReadiness,
 *   UnmatchedChainOrderLike, GridResizeResult, CowResult
 *
 * ===============================================================================
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { path } from '../../path_api.js';
import { getStorage } from '../../storage/index.js';
const storage = getStorage();
import { API_LIMITS, ORDER_TYPES, ORDER_STATES, COW_ACTIONS, FEE_PARAMETERS, BTS_PRECISION, PIPELINE_TIMING, NATIVE_CLIENT, GRID_LIMITS, TIMING } from '../../constants.js';
import { PATHS } from '../../paths.js';
import { toFiniteNumber, isValidNumber, toKnownNumber } from '../format.js';
import * as MathUtils from './math.js';
import * as OrderUtils from './order.js';
import Logger from '../../order/logger.js';
import { runtime } from '../../runtime.js';
import { getErrorMessage, sleepMs } from '../../utils/errors.js';
import { normalizeAssetRef } from '../../utils/asset_symbols.js';
import { withTimeout } from './timeout.js';
import type { OrderManagerLike, BotLike, AccountOrdersLike, ManagedOrder, AccountTotals, CowAction } from '../../types.js';
import type { WorkingGrid as WorkingGridType } from '../working_grid.js';
const { ensureDir, readJSON } = storage;
const systemLogger = new Logger('System');

/** Minimal structural views of the external BitShares client used here. */
export interface AssetMeta {
    id?: string;
    precision?: number;
    symbol?: string;
    [key: string]: unknown;
}
export interface PoolReserve {
    asset_id?: string;
    amount?: number | string;
    [key: string]: unknown;
}
export interface PoolEntry {
    id?: string;
    asset_a?: string;
    asset_b?: string;
    asset_ids?: string[];
    balance_a?: number | string;
    balance_b?: number | string;
    reserves?: PoolReserve[];
    [key: string]: unknown;
}
interface BitSharesDb {
    lookup_asset_symbols?: (refs: string[]) => Promise<unknown[]>;
    get_assets?: (refs: string[]) => Promise<unknown[]>;
    get_objects?: (ids: string[]) => Promise<unknown[]>;
    get_order_book?: (base: string, quote: string, depth: number) => Promise<{ bids?: Array<{ price?: unknown }>; asks?: Array<{ price?: unknown }> }>;
    get_ticker?: (base: string, quote: string) => Promise<{ latest?: unknown; latest_price?: unknown }>;
    get_liquidity_pools_by_both_assets?: (a: string, b: string) => Promise<PoolEntry[]>;
    get_liquidity_pools_by_share_asset?: (ids: string[], a: boolean, b: boolean) => Promise<PoolEntry[]>;
    list_liquidity_pools?: (pageSize: number, startId: string) => Promise<PoolEntry[]>;
    get_liquidity_pools?: (pageSize: number, startId: string) => Promise<PoolEntry[]>;
    getGlobalProperties?: () => Promise<unknown>;
    call?: (method: string, args: unknown[]) => Promise<unknown>;
    [key: string]: unknown;
}
interface BitSharesAssets {
    [symbol: string]: Promise<unknown> | unknown;
}
export interface BitSharesClient {
    db?: BitSharesDb;
    assets?: BitSharesAssets;
    [key: string]: unknown;
}

/**
 * Lazily-bound ladder validator: resolveOnGridPivot from the COW runtime,
 * imported on first use (not at module top level). utils/system.ts Must not
 * statically import dexbot_cow_runtime (the runtime is a startup-graph
 * heavyweight and the static edge would pull the whole COW engine into
 * everything that touches persistence helpers); the runtime CAN statically
 * import utils/system (it already does), so this edge stays one-directional
 * and cycle-free in practice.
 *
 * Shared on purpose (centralization): one ladder-validation implementation
 * — the increment fallback chain (manager.config → DEFAULT_CONFIG) and the
 * one-increment drift refusal — serves both the live guard's per-probe
 * validation and the persisted-pivot restore. The restorer must never
 * accept a pivot value the runtime would itself refuse per probe.
 *
 * @param {Object} manager - OrderManager instance
 * @param {number} price - Candidate pivot price
 * @returns {Object|null} {price, slotIdx, snapped, nearestDrift} or null
 */
function cowRuntimeLadderValidator(manager: OrderManagerLike, price: number): { price: number; slotIdx: number | null; snapped: boolean; nearestDrift: number | null } | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { resolveOnGridPivot } = require('../../dexbot_cow_runtime');
        const validated = resolveOnGridPivot(manager, price);
        if (!validated || validated.price == null || validated.idx == null) return null;
        return { price: validated.price, slotIdx: validated.idx, snapped: !!validated.snapped, nearestDrift: validated.nearestDrift };
    } catch (e) {
        systemLogger.warn(`restoreLastFillPivot: ladder validator unavailable (${getErrorMessage(e)})`);
        return null;
    }
}

function _debugLogAndNull(method: string, symA: string, symB: string) {
    return (err: unknown) => {
        // debug level: underlying derivePoolPrice/deriveMarketPrice already log at warn
        systemLogger.debug(`derivePrice(${method}) for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    };
}

// ================================================================================
// SECTION 1: PRICE DERIVATION
// ================================================================================

const poolIdCache = new Map();

/**
 * @private Lookup asset by symbol from BitShares blockchain.
 * Tries cached assets first, then falls back to lookup API methods.
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} s - Asset symbol to lookup
 * @returns {Promise<Object>} Asset metadata with id, symbol, precision
 * @throws {Error} If asset cannot be found on blockchain
 */
export const lookupAsset = async (BitShares: BitSharesClient, s: string): Promise<AssetMeta | null> => {
    if (!BitShares) return null;
    // BitShares symbols are canonical UPPERCASE and object ids ("1.3.x") are
    // passed through; normalizing here means every caller (price derivation,
    // fee cache, pool lookup) hits the chain with the canonical spelling.
    // Only real symbols are rewritten: a blank/non-string ref must keep its
    // original spelling in the CRITICAL error below.
    if (typeof s === 'string' && s.trim()) s = normalizeAssetRef(s);
    let cached: AssetMeta | null = null;
    if (BitShares?.assets) {
        try {
            cached = (await BitShares.assets[s]) as AssetMeta | null;
        } catch (_) {
            systemLogger.debug(`lookupAsset: cache access failed for ${s}`);
        }
    }

    if (cached?.id && typeof cached.precision === 'number') {
        return cached;
    }

    const methods = [
        () => BitShares.db?.lookup_asset_symbols?.([s]),
        () => BitShares.db?.get_assets?.([s])
    ];

    for (const method of methods) {
        try {
            if (typeof method !== 'function') continue;
            const r = await method();
            const first = r?.[0] as AssetMeta | undefined;
            if (first?.id && typeof first.precision === 'number') {
                return { ...(cached || {}), ...first };
            }
        } catch (e) {
            systemLogger.debug(`lookupAsset: method failed for ${s}: ${getErrorMessage(e)}`);
        }
    }

    throw new Error(`CRITICAL: Cannot fetch asset precision for '${s}'`);
};

/**
 * Resolve a full asset object from an asset reference (object ID like 1.3.x or symbol).
 * Routes object IDs to get_assets and symbols to lookup_asset_symbols, trying
 * camelCase, snake_case, and db.call() forms. Shared by chain_orders, credit_runtime,
 * and credential_policy so asset resolution behavior stays consistent.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {*} ref - Asset ID (e.g. '1.3.0') or symbol (e.g. 'BTS')
 * @returns {Promise<Object|null>} Asset object or null if unresolvable
 */
export const resolveAssetByRef = async (BitShares: BitSharesClient, ref: unknown): Promise<AssetMeta | null> => {
    if (!BitShares?.db) return null;
    // Same rule as lookupAsset: canonicalize real symbols, leave anything else
    // (object ids pass through, junk keeps its original spelling) untouched.
    const cacheKey = typeof ref === 'string' ? normalizeAssetRef(ref) : String(ref);
    const method = /^1\.3\.\d+$/.test(cacheKey) ? 'get_assets' : 'lookup_asset_symbols';
    const camelMethod = method.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
    try {
        const camelFn = BitShares.db[camelMethod] as ((refs: string[]) => Promise<unknown[]>) | undefined;
        if (typeof camelFn === 'function') {
            const result = await camelFn([cacheKey]);
            return (Array.isArray(result) ? (result[0] as AssetMeta) : null) || null;
        }
        const snakeFn = BitShares.db[method] as ((refs: string[]) => Promise<unknown[]>) | undefined;
        if (typeof snakeFn === 'function') {
            const result = await snakeFn([cacheKey]);
            return (Array.isArray(result) ? (result[0] as AssetMeta) : null) || null;
        }
        const callFn = BitShares.db.call;
        if (typeof callFn === 'function') {
            const result = await callFn(method, [[cacheKey]]);
            return (Array.isArray(result) ? (result[0] as AssetMeta) : null) || null;
        }
    } catch (e) {
        systemLogger.debug(`resolveAssetByRef failed for ${cacheKey}: ${getErrorMessage(e)}`);
    }
    return null;
};

/**
 * Derive price from BitShares DEX order book.
 * Returns price in B/A format (units of asset B per 1 unit of asset A).
 * Uses best bid and ask from order book, with fallback to ticker.
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol
 * @param {string} symB - Second asset symbol
 * @returns {Promise<number|null>} Derived market price or null if unavailable
 */
export const deriveMarketPrice = async (BitShares: BitSharesClient, symA: string, symB: string): Promise<number | null> => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        const baseId = aMeta.id;
        const quoteId = bMeta.id;
        let mid: number | null = null;

        if (typeof BitShares.db?.get_order_book === 'function') {
            try {
                const ob = await BitShares.db.get_order_book(baseId, quoteId, API_LIMITS.ORDERBOOK_DEPTH);
                const bestBid = isValidNumber(ob.bids?.[0]?.price) ? toFiniteNumber(ob.bids?.[0]?.price) : null;
                const bestAsk = isValidNumber(ob.asks?.[0]?.price) ? toFiniteNumber(ob.asks?.[0]?.price) : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            } catch (e) {
                systemLogger.debug(`deriveMarketPrice: get_order_book failed for ${symA}/${symB}: ${getErrorMessage(e)}`);
            }
        }

        if (mid === null && typeof BitShares.db?.get_ticker === 'function') {
            try {
                const t = await BitShares.db.get_ticker(baseId, quoteId);
                mid = isValidNumber(t?.latest) ? toFiniteNumber(t.latest) : (isValidNumber(t?.latest_price) ? toFiniteNumber(t.latest_price) : null);
            } catch (err) {
                systemLogger.debug(`deriveMarketPrice: get_ticker failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
            }
        }

        // Return B/A orientation to match market price format
        const finalPrice = (mid !== null && mid !== 0) ? 1 / mid : null;
        if (finalPrice) {
            systemLogger.info(`deriveMarketPrice: ${symA}/${symB} rawMid=${mid?.toFixed(8)} -> finalPrice(B/A)=${finalPrice.toFixed(8)}`);
        }
        return finalPrice;
    } catch (err) {
        systemLogger.warn(`deriveMarketPrice failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    }
};

/**
 * Derive price from BitShares Liquidity Pool (AMM).
 * Returns price in B/A format (units of asset B per 1 unit of asset A).
 * Handles internal BitShares ID-based asset ordering (asset_a/asset_b).
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol
 * @param {string} symB - Second asset symbol
 * @returns {Promise<number|null>} Derived pool price or null if unavailable
 */
export const derivePoolPrice = async (BitShares: BitSharesClient, symA: string, symB: string): Promise<number | null> => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        let chosen: PoolEntry | null = null;
        const cacheKey = [aMeta.id, bMeta.id].sort().join(':');
        const cachedPoolId = poolIdCache.get(cacheKey);

        if (typeof BitShares.db?.get_liquidity_pools_by_both_assets === 'function') {
            try {
                const pools = await BitShares.db.get_liquidity_pools_by_both_assets(aMeta.id, bMeta.id);
                if (Array.isArray(pools) && pools.length > 0) {
                    const valid = pools.filter((p) => p?.id);
                    if (valid.length) {
                        chosen = valid.sort((a, b) => {
                            const getBal = (p: PoolEntry) => toFiniteNumber(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
                            return getBal(b) - getBal(a);
                        })[0];
                        if (chosen) poolIdCache.set(cacheKey, chosen.id);
                    }
                }
            } catch (e) {
                systemLogger.debug(`derivePoolPrice: get_liquidity_pools_by_both_assets failed: ${getErrorMessage(e)}`);
            }
        }

        if (!chosen && cachedPoolId && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [pool] = await BitShares.db.get_objects([cachedPoolId]);
                if (pool) chosen = pool as unknown as PoolEntry;
            } catch (e) {
                poolIdCache.delete(cacheKey);
            }
        }

        if (!chosen) {
            const listFn = BitShares.db?.list_liquidity_pools || BitShares.db?.get_liquidity_pools;
            if (typeof listFn === 'function') {
                try {
                    let startId = '1.19.0';
                    const pageSize = API_LIMITS.POOL_BATCH_SIZE;
                    const allMatches: PoolEntry[] = [];

                    let scannedBatches = 0;
                    while (true) {
                        if (scannedBatches++ >= API_LIMITS.MAX_POOL_SCAN_BATCHES) break;
                        const pools = await listFn(pageSize, startId);
                        if (!pools || pools.length === 0) break;

                        // BitShares list_liquidity_pools is inclusive of startId.
                        // Skip the first pool in subsequent pages to avoid duplicate processing.
                        const effectivePools = (startId === '1.19.0') ? pools : pools.slice(1);
                        if (effectivePools.length === 0) break;

                        const matches = effectivePools.filter((p) => {
                            const ids = (p.asset_ids || [p.asset_a, p.asset_b]).map(String);
                            return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                        });

                        if (matches.length) {
                            allMatches.push(...matches);
                        }

                        if (pools.length < pageSize) {
                            break;
                        } else {
                            startId = String(pools[pools.length - 1].id);
                        }
                    }

                    if (allMatches.length) {
                        // Select pool with highest balance for our assetA
                        chosen = allMatches.sort((a, b) => {
                            const getBal = (p: PoolEntry) => toFiniteNumber(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
                            return getBal(b) - getBal(a);
                        })[0];
                        if (chosen) poolIdCache.set(cacheKey, chosen.id);
                    }
                } catch (e) {
                    systemLogger.warn(`derivePoolPrice: pool pagination failed: ${getErrorMessage(e) || e}`);
                }
            }
        }

        if (!chosen) return null;

        if (!chosen.reserves && !isValidNumber(chosen.balance_a) && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [full] = await BitShares.db.get_objects([chosen.id as string]);
                if (full) chosen = full as PoolEntry;
            } catch (e) {
                systemLogger.debug(`derivePoolPrice: get_objects failed for pool ${chosen.id}: ${getErrorMessage(e)}`);
            }
        }

        let amtA: number | null = null, amtB: number | null = null;
        if (isValidNumber(chosen.balance_a) && isValidNumber(chosen.balance_b)) {
            // Pools store assets ordered by ID: lower ID is always first (asset_a)
            const aIdNum = toFiniteNumber(String(aMeta.id).split('.')[2]);
            const bIdNum = toFiniteNumber(String(bMeta.id).split('.')[2]);
            const aIsFirst = aIdNum < bIdNum;

            // If config's assetA has lower ID, it's the pool's first asset (asset_a)
            // Otherwise, our assetA corresponds to pool's second asset (asset_b)
            if (aIsFirst) {
                amtA = toFiniteNumber(chosen.balance_a);
                amtB = toFiniteNumber(chosen.balance_b);
            } else {
                amtA = toFiniteNumber(chosen.balance_b);
                amtB = toFiniteNumber(chosen.balance_a);
            }
        } else if (Array.isArray(chosen.reserves)) {
            const resA = chosen.reserves.find((r) => String(r.asset_id) === String(aMeta.id));
            const resB = chosen.reserves.find((r) => String(r.asset_id) === String(bMeta.id));
            if (resA && resB) {
                amtA = Number(resA.amount);
                amtB = Number(resB.amount);
            }
        }

        if (!isValidNumber(amtA) || !isValidNumber(amtB) || toFiniteNumber(amtB) === 0) return null;

        const floatA = MathUtils.blockchainToFloat(amtA, aMeta.precision);
        const floatB = MathUtils.blockchainToFloat(amtB, bMeta.precision);

        // Return B/A orientation to match market price format
        const finalPrice = floatB > 0 ? floatB / floatA : null;
        if (finalPrice) {
            systemLogger.info(`derivePoolPrice: ${symA}/${symB} pool=${chosen.id} amtA=${amtA}(prec=${aMeta.precision}) amtB=${amtB}(prec=${bMeta.precision}) -> finalPrice(B/A)=${finalPrice.toFixed(8)}`);
        }
        return finalPrice;
    } catch (err) {
        systemLogger.warn(`derivePoolPrice failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    }
};

/**
 * Derive price from blockchain using specified mode.
 * Attempts pool or market derivation based on mode, with fallback chain.
 * 
 * @param {Object} BitShares - BitShares client instance
  * @param {string} symA - First asset symbol
  * @param {string} symB - Second asset symbol
  * @param {string} [mode='auto'] - Derivation mode: "pool", "book", or "auto" (pool → book).
  * @returns {Promise<number|null>} Derived price or null if all methods fail
  */
 let _derivePriceTestHook: ((...args: unknown[]) => number | null | Promise<number | null>) | null = null;

 /**
  * Test-only seam: compiled ESM exports cannot be monkey-patched, so tests
  * install a hook here to short-circuit price derivation (offline runs).
  */
 export const setDerivePriceTestHook = (fn: ((...args: unknown[]) => number | null | Promise<number | null>) | null): void => {
     _derivePriceTestHook = fn;
 };

 export const derivePrice = async (BitShares: BitSharesClient, symA: string, symB: string, mode: string = 'auto'): Promise<number | null> => {
    if (_derivePriceTestHook) return await _derivePriceTestHook(BitShares, symA, symB, mode);
    mode = String(mode).toLowerCase();
    const validModes = new Set(['pool', 'book', 'auto']);

    if (!validModes.has(mode)) {
        systemLogger.debug(`derivePrice: invalid mode "${mode}" for ${symA}/${symB}`);
        return null;
    }

    if (mode === 'pool') {
        return await derivePoolPrice(BitShares, symA, symB).catch(_debugLogAndNull('pool', symA, symB));
    }

    if (mode === 'book') {
        return await deriveMarketPrice(BitShares, symA, symB).catch(_debugLogAndNull('book', symA, symB));
    }

    // mode === 'auto': pool preferred, market fallback
    let poolP: number | null = null;
    poolP = await derivePoolPrice(BitShares, symA, symB).catch(_debugLogAndNull('auto/pool', symA, symB));
    if (poolP != null && poolP > 0) return poolP;

    const m = await deriveMarketPrice(BitShares, symA, symB).catch(_debugLogAndNull('auto/book', symA, symB));
    if (m != null && m > 0) return m;

    systemLogger.debug(`derivePrice: all methods failed for ${symA}/${symB}`);
    return null;
};

/**
 * Default bridge assets for multi-hop price derivation. BTS is the core
 * asset with the deepest markets, so almost every listed asset has a price
 * path against it even when no direct market exists for an exotic pair.
 */
const DEFAULT_PRICE_BRIDGES = ['BTS'];

function isPositiveRate(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Derive price via bridge assets only (no direct market attempt).
 * Returns price in B/A format (units of asset B per 1 unit of asset A) as
 * price(A in X) * price(X in B) for the first bridge X with both legs
 * available. Skips bridges equal to either side; identity (A === B) is 1.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol or ID
 * @param {string} symB - Second asset symbol or ID
 * @param {string[]} [bridges] - Bridge asset symbols/IDs to try in order
 * @param {string} [mode='auto'] - Price derivation mode passed to derivePrice
 * @returns {Promise<{rate:number,path:string}|null>} Rate plus 'bridge:<ref>' path, or null
 */
export async function derivePriceViaBridges(BitShares: BitSharesClient, symA: string, symB: string, bridges: string[] = DEFAULT_PRICE_BRIDGES, mode: string = 'auto'): Promise<{ rate: number; path: string } | null> {
    try {
        if (String(symA) === String(symB)) {
            return { rate: 1, path: 'identity' };
        }
        const list = Array.isArray(bridges) ? bridges : [];
        for (const bridge of list) {
            if (!bridge || String(bridge) === String(symA) || String(bridge) === String(symB)) continue;
            const [legA, legB] = await Promise.all([
                derivePrice(BitShares, symA, bridge, mode).catch(() => null),
                derivePrice(BitShares, bridge, symB, mode).catch(() => null),
            ]);
            if (isPositiveRate(legA) && isPositiveRate(legB)) {
                return { rate: legA * legB, path: `bridge:${bridge}` };
            }
        }
        return null;
    } catch (err) {
        systemLogger.debug(`derivePriceViaBridges failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    }
}

/**
 * Derive price with universal fallback: direct pool/book market first, then
 * multi-hop via bridge assets. Unlike derivePrice (null when no direct
 * market exists), this resolves a rate for every pair whose assets each
 * have some market against a shared bridge — the last-resort pricing used
 * for credit collateral conversion when the lending offer lists no price
 * for the collateral (or the pool cannot be valued directly).
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol or ID
 * @param {string} symB - Second asset symbol or ID
 * @param {string[]} [bridges] - Bridge asset symbols/IDs to try in order
 * @param {string} [mode='auto'] - Price derivation mode passed to derivePrice
 * @returns {Promise<{rate:number,path:string}|null>} Rate plus 'direct' | 'identity' | 'bridge:<ref>' path, or null
 */
export async function derivePriceWithBridges(BitShares: BitSharesClient, symA: string, symB: string, bridges: string[] = DEFAULT_PRICE_BRIDGES, mode: string = 'auto'): Promise<{ rate: number; path: string } | null> {
    if (String(symA) === String(symB)) {
        return { rate: 1, path: 'identity' };
    }
    const direct = await derivePrice(BitShares, symA, symB, mode).catch(() => null);
    if (isPositiveRate(direct)) {
        return { rate: direct, path: 'direct' };
    }
    return derivePriceViaBridges(BitShares, symA, symB, bridges, mode);
}

/**
 * Resolve a liquidity pool from a share asset reference.
 * Looks up the share asset, then queries the blockchain for associated pools.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} shareAssetRef - Share asset symbol or reference
 * @returns {Promise<Object|null>} Object with {shareAsset, pool} or null if not found
 */
async function resolveLiquidityPoolByShareAsset(BitShares: BitSharesClient, shareAssetRef: string): Promise<{ shareAsset: AssetMeta; pool: PoolEntry } | null> {
    if (!BitShares?.db || typeof BitShares.db.get_liquidity_pools_by_share_asset !== 'function') {
        return null;
    }

    const shareAsset = await lookupAsset(BitShares, shareAssetRef).catch((e) => {
        systemLogger.debug(`resolveLiquidityPoolByShareAsset: lookupAsset failed for ${shareAssetRef}: ${getErrorMessage(e)}`);
        return null;
    });
    if (!shareAsset?.id) {
        return null;
    }

    const response = await BitShares.db.get_liquidity_pools_by_share_asset([shareAsset.id], false, false).catch((e) => {
        systemLogger.debug(`resolveLiquidityPoolByShareAsset: get_liquidity_pools_by_share_asset failed for ${shareAssetRef}: ${getErrorMessage(e)}`);
        return null;
    });
    if (!Array.isArray(response)) {
        return null;
    }

    const pool = response.find((entry) => entry && (entry.id || (entry.pool as PoolEntry | undefined)?.id)) || null;
    if (!pool) {
        return null;
    }

    return {
        shareAsset,
        pool: (pool.pool as PoolEntry | undefined) || pool,
    };
}

interface ExtendedAssetMeta extends AssetMeta {
    current_supply?: number | string | { amount?: number; value?: number };
    dynamic_asset_data_id?: string;
    dynamicDataId?: string;
    dynamic_data_id?: string;
}

async function getAssetCurrentSupply(BitShares: BitSharesClient, assetRef: string | ExtendedAssetMeta): Promise<number | null> {
    const asset: ExtendedAssetMeta | null = typeof assetRef === 'object' && assetRef !== null
        ? assetRef
        : await lookupAsset(BitShares, assetRef as string).catch((e) => {
            systemLogger.debug(`getAssetCurrentSupply: lookupAsset failed for ${assetRef}: ${getErrorMessage(e)}`);
            return null;
        });
    if (!asset) {
        return null;
    }

    const hasDirectSupply = asset.current_supply != null;
    const directSupply = hasDirectSupply
        ? toFiniteNumber(typeof asset.current_supply === 'object' ? asset.current_supply?.amount : asset.current_supply, -1)
        : -1;
    if (hasDirectSupply && Number.isFinite(directSupply) && directSupply >= 0) {
        return directSupply;
    }

    const dynamicId = asset.dynamic_asset_data_id || asset.dynamicDataId || asset.dynamic_data_id || null;
    if (!dynamicId || typeof BitShares?.db?.get_objects !== 'function') {
        return null;
    }

    const objects = await BitShares.db.get_objects([dynamicId]).catch((e) => {
        systemLogger.debug(`getAssetCurrentSupply: get_objects failed for ${dynamicId}: ${getErrorMessage(e)}`);
        return null;
    });
    const dynamicData = (Array.isArray(objects) ? objects[0] : null) as { current_supply?: { amount?: number; value?: number } | number } | null;
    const supply = toFiniteNumber(
        typeof dynamicData?.current_supply === 'object'
            ? (dynamicData.current_supply?.amount ?? dynamicData.current_supply?.value)
            : dynamicData?.current_supply,
        undefined
    );
    return Number.isFinite(supply) && supply >= 0 ? supply : null;
}

/**
 * Derive the value of a liquidity pool share token in a denomination asset.
 * Resolves the pool, fetches reserves and supply, then prices both pool assets
 * against the denomination asset to compute total value per share.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} shareAssetRef - Share asset symbol
 * @param {string} denominationAssetRef - Denomination asset symbol
 * @param {string} [mode='auto'] - Price derivation mode ("pool", "book", or "auto")
 * @param {boolean} [allowBridges=false] - When true, a reserve leg with no
 *   direct market may be priced via bridge assets (see derivePriceViaBridges).
 *   Defaults to false so existing callers keep the previous direct-only
 *   behavior; the credit runtime opts in explicitly.
 * @returns {Promise<number|null>} Value per share in denomination asset, or null
 */
export async function deriveLiquidityPoolTokenValue(BitShares: BitSharesClient, shareAssetRef: string, denominationAssetRef: string, mode: string = 'auto', allowBridges: boolean = false): Promise<number | null> {
    try {
        const [shareAsset, denominationAsset] = await Promise.all([
            lookupAsset(BitShares, shareAssetRef),
            lookupAsset(BitShares, denominationAssetRef),
        ]);

        if (!shareAsset?.id || !denominationAsset?.id) {
            return null;
        }

        const poolInfo = await resolveLiquidityPoolByShareAsset(BitShares, shareAsset.id);
        if (!poolInfo?.pool) {
            return null;
        }

        const [assetA, assetB, supply] = await Promise.all([
            lookupAsset(BitShares, poolInfo.pool.asset_a ?? ''),
            lookupAsset(BitShares, poolInfo.pool.asset_b ?? ''),
            getAssetCurrentSupply(BitShares, shareAsset),
        ]);

        if (!assetA?.id || !assetB?.id || supply == null || !Number.isFinite(supply) || supply <= 0) {
            return null;
        }

        const reserveA = MathUtils.blockchainToFloat(poolInfo.pool.balance_a, assetA.precision);
        const reserveB = MathUtils.blockchainToFloat(poolInfo.pool.balance_b, assetB.precision);
        if (!isValidNumber(reserveA) || !isValidNumber(reserveB)) {
            return null;
        }

        // Each reserve leg is priced directly first, then — only when the
        // caller opts in via allowBridges — via bridge assets (e.g.
        // reserve -> BTS -> denomination). Without the bridge fallback the
        // whole LP valuation fails when a single exotic reserve has no
        // direct market against the denomination asset.
        const priceReserveLeg = async (asset: AssetMeta): Promise<number | null> => {
            if (String(asset.id) === String(denominationAsset.id)) return 1;
            const direct = await derivePrice(BitShares, asset.id as string, denominationAsset.id as string, mode).catch((e) => {
                systemLogger.debug(`deriveLiquidityPoolTokenValue: derivePrice failed for ${asset.id}/${denominationAsset.id}: ${getErrorMessage(e)}`);
                return null;
            });
            if (isPositiveRate(direct)) return direct;
            if (!allowBridges) return null;
            const bridged = await derivePriceViaBridges(BitShares, asset.id as string, denominationAsset.id as string, DEFAULT_PRICE_BRIDGES, mode).catch(() => null);
            if (bridged && isPositiveRate(bridged.rate)) {
                systemLogger.debug(`deriveLiquidityPoolTokenValue: bridged reserve leg ${asset.id}/${denominationAsset.id} via ${bridged.path}`);
                return bridged.rate;
            }
            return null;
        };

        const priceA = await priceReserveLeg(assetA);
        const priceB = await priceReserveLeg(assetB);

        if (priceA == null || priceB == null || !isValidNumber(priceA) || !isValidNumber(priceB) || priceA <= 0 || priceB <= 0) {
            return null;
        }

        const supplyFloat = MathUtils.blockchainToFloat(supply, shareAsset.precision);
        if (!isValidNumber(supplyFloat) || supplyFloat <= 0) {
            return null;
        }

        const totalValue = reserveA * priceA! + reserveB * priceB!;
        const valuePerShare = totalValue / supplyFloat;
        return isValidNumber(valuePerShare) && valuePerShare > 0 ? valuePerShare : null;
    } catch (err) {
        systemLogger.debug(`deriveLiquidityPoolTokenValue failed for ${shareAssetRef}/${denominationAssetRef}: ${getErrorMessage(err)}`);
        return null;
    }
}

/**
 * Load the full dynamic grid snapshot written by market_adapter for a bot.
 * The snapshot is stored atomically at profiles/orders/<botKey>.dynamicgrid.json
 * and is updated every market adapter cycle. It contains the persisted grid
 * center and, for dynamic-weight-whitelisted bots, any computed effective weight offsets.
 * On full grid resets the bot may rewrite gridCenterPrice to the latest AMA baseline, but
 * amaCenterPrice remains the raw AMA output for diagnostics and comparison.
 * The snapshot may also expose AMA slope diagnostics and a gridPriceOffsetPct
 * that downstream grid initialization can apply to the raw center price.
 * Called by initializeGrid() when manager.config.gridPrice uses an AMA keyword,
 * by performGridResync(), and by refreshDynamicWeightDistribution() before every
 * rebalance so new orders use live weights — not only on grid reset.
 * @param {string} botKey - Bot key (e.g. "iob-aaa-bbb-0")
 * @returns {Object|null} Snapshot with center and optional dynamicWeights fields, or null if invalid
 */
export interface AmaCenterSnapshot {
    gridCenterPrice: number;
    centerPrice: number;
    amaCenterPrice: number | null;
    source: string | null;
    updatedAt: string | null;
    amaSlopePercentMode: unknown;
    amaSlope: unknown;
    gridRangeScalingAmaSlope: unknown;
    gridPriceOffsetPct: number | null;
    amaSlopeDeltaPercent: number | null;
    amaSlopeThresholdPercent: number | null;
    dynamicWeights: unknown;
    asymmetricBounds: unknown;
}

export function loadAmaCenterSnapshot(botKey: string): AmaCenterSnapshot | null {
    try {
        const gridPriceFile = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);
        const data = readJSON<Record<string, unknown>>(gridPriceFile);
        const gridCenterPrice = Number(data?.gridCenterPrice ?? data?.centerPrice);
        const amaCenterPrice = Number(data?.amaCenterPrice);
        if (!Number.isFinite(gridCenterPrice) || gridCenterPrice <= 0) {
            return null;
        }
        return {
            gridCenterPrice,
            centerPrice: gridCenterPrice,
            amaCenterPrice: Number.isFinite(amaCenterPrice) && amaCenterPrice > 0 ? amaCenterPrice : null,
            source: (data?.source as string | null) || null,
            updatedAt: (data?.updatedAt as string | null) || null,
            amaSlopePercentMode: data?.amaSlopePercentMode || null,
            amaSlope: data?.amaSlope ?? null,
            gridRangeScalingAmaSlope: data?.gridRangeScalingAmaSlope ?? null,
            gridPriceOffsetPct: Number.isFinite(Number(data?.gridPriceOffsetPct))
                ? Number(data.gridPriceOffsetPct)
                : null,
            amaSlopeDeltaPercent: Number.isFinite(Number(data?.amaSlopeDeltaPercent))
                ? Number(data.amaSlopeDeltaPercent)
                : null,
            amaSlopeThresholdPercent: Number.isFinite(Number(data?.amaSlopeThresholdPercent))
                ? Number(data.amaSlopeThresholdPercent)
                : null,
            dynamicWeights: data?.dynamicWeights || null,
            asymmetricBounds: data?.asymmetricBounds && typeof data.asymmetricBounds === 'object'
                ? data.asymmetricBounds
                : null,
        };
    } catch (_) {
        return null;
    }
}

/**
 * Load the AMA grid center price written by market_adapter for a bot.
 * This is the numeric accessor used by the order engine.
 * @param {string} botKey - Bot key (e.g. "iob-aaa-bbb-0")
 * @returns {number|null} Grid center price in B/A format, or null if file absent/invalid
 */
export function loadAmaCenterPrice(botKey: string): number | null {
    const snapshot = loadAmaCenterSnapshot(botKey);
    return snapshot ? snapshot.gridCenterPrice : null;
}

// ================================================================================
// SECTION 2: FEE MANAGEMENT (INIT)
// ================================================================================

/**
 * Load previously persisted fee cache from disk.
 * @returns {Record<string, any>} Cached fee data or empty object
 */
function _loadFeeCacheFromDisk(): Record<string, FeeCacheEntryData> {
    try {
        const filePath = PATHS.PROFILES.FEE_CACHE_JSON;
        if (storage.exists(filePath)) {
            const diskCache = storage.readJSON<Record<string, FeeCacheEntryData>>(filePath);
            if (diskCache && typeof diskCache === 'object') {
                systemLogger.debug(`_loadFeeCacheFromDisk: loaded fee cache (${Object.keys(diskCache).length} assets)`);
                return diskCache;
            }
        }
    } catch (e) {
        systemLogger.debug(`_loadFeeCacheFromDisk: ${getErrorMessage(e)}`);
    }
    return {};
}

interface AssetOptions {
    flags?: number | string;
    market_fee_percent?: number;
    taker_fee_percent?: number;
    max_market_fee?: number | string;
}

export interface FeeCacheEntryData {
    assetId?: string;
    symbol?: string;
    precision?: number;
    chargesMarketFees?: boolean;
    marketFee?: { percent: number };
    takerFee?: { percent: number } | null;
    maxMarketFee?: { raw: number | string; float: number };
    limitOrderCreate?: { raw: number; satoshis: number; bts: number };
    limitOrderCancel?: { raw: number; satoshis: number; bts: number };
    limitOrderUpdate?: { raw: number; satoshis: number; bts: number };
    makerFeeDiscountPercent?: number;
}

interface GlobalProps {
    parameters?: {
        current_fees?: { parameters?: Array<[number, { fee?: number | string }]> };
        extensions?: { maker_fee_discount_percent?: number };
    };
}

/**
 * Persist fee cache to disk for recovery across restarts.
 * @param {Record<string, any>} cache - Fee cache to persist
 */
function _saveFeeCacheToDisk(cache: Record<string, FeeCacheEntryData>): void {
    try {
        storage.writeJSON(PATHS.PROFILES.FEE_CACHE_JSON, cache);
    } catch (e) {
        systemLogger.debug(`_saveFeeCacheToDisk: ${getErrorMessage(e)}`);
    }
}

/**
 * Initialize fee cache from blockchain.
 * Fetches BTS operation fees and asset market fees for all unique assets in config.
 * Populates internal fee cache used by math.js::getAssetFees.
 * Falls back to disk-persisted cache if blockchain lookup fails.
 * 
 * @param {Array<Object>} botsConfig - Array of bot configurations
 * @param {Object} BitShares - BitShares client instance
 * @returns {Promise<Object>} Fee cache object keyed by asset symbol
 */
export async function initializeFeeCache(botsConfig: Array<{ assetA?: string; assetB?: string }>, BitShares: BitSharesClient): Promise<Record<string, FeeCacheEntryData>> {
    const uniqueAssets = new Set(['BTS']);
    for (const bot of botsConfig) {
        if (bot.assetA) uniqueAssets.add(bot.assetA);
        if (bot.assetB) uniqueAssets.add(bot.assetB);
    }

    // Seed from disk so previously cached assets survive transient API failures
    const cache: Record<string, FeeCacheEntryData> = _loadFeeCacheFromDisk();

    const maxAttempts = FEE_PARAMETERS.FEE_CACHE_RETRY_ATTEMPTS;
    const baseDelay = FEE_PARAMETERS.FEE_CACHE_RETRY_DELAY_MS;

    for (const assetSymbol of uniqueAssets) {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                if (assetSymbol === 'BTS') {
                    if (typeof BitShares.db?.getGlobalProperties !== 'function') throw new Error('getGlobalProperties unavailable');
                    const globalProps = await BitShares.db.getGlobalProperties() as GlobalProps;
                    const currentFees = globalProps.parameters?.current_fees?.parameters;
                    const findFee = (opCode: number) => {
                        const param = currentFees?.find((p) => p[0] === opCode);
                        const fee = param?.[1]?.fee;
                        const feeNum = toFiniteNumber(fee);
                        return {
                            raw: feeNum,
                            satoshis: feeNum,
                            bts: MathUtils.blockchainToFloat(feeNum, BTS_PRECISION)
                        };
                    };
                    const makerFeeDiscountRaw = toFiniteNumber(
                        globalProps?.parameters?.extensions?.maker_fee_discount_percent,
                        FEE_PARAMETERS.MAKER_REFUND_PERCENT * NATIVE_CLIENT.CHAIN.PERCENT_100
                    );
                    cache.BTS = {
                        limitOrderCreate: findFee(NATIVE_CLIENT.OPERATIONS.LIMIT_ORDER_CREATE),
                        limitOrderCancel: findFee(NATIVE_CLIENT.OPERATIONS.LIMIT_ORDER_CANCEL),
                        limitOrderUpdate: findFee(NATIVE_CLIENT.OPERATIONS.LIMIT_ORDER_UPDATE),
                        makerFeeDiscountPercent: Math.max(0, makerFeeDiscountRaw) / NATIVE_CLIENT.CHAIN.PERCENT_100
                    };
                } else {
                    const fullAsset = await lookupAsset(BitShares, assetSymbol);
                    if (!fullAsset) throw new Error(`asset ${assetSymbol} not found`);
                    const options = (fullAsset.options ?? {}) as AssetOptions;
                    cache[assetSymbol] = {
                        assetId: fullAsset.id,
                        symbol: assetSymbol,
                        precision: fullAsset.precision,
                        chargesMarketFees: (Number(options.flags || 0) & 0x01) !== 0,
                        marketFee: { percent: (options.market_fee_percent || 0) / 100 },
                        takerFee: options.taker_fee_percent ? { percent: options.taker_fee_percent / 100 } : null,
                        maxMarketFee: {
                            raw: options.max_market_fee || 0,
                            float: MathUtils.blockchainToFloat(options.max_market_fee || 0, fullAsset.precision)
                        }
                    };
                }
                lastError = null;
                break; // success
            } catch (error) {
                lastError = error as Error;
                if (attempt < maxAttempts) {
                    const delay = baseDelay * attempt;
                    systemLogger.warn(
                        `initializeFeeCache: attempt ${attempt}/${maxAttempts} failed for ${assetSymbol}: ${getErrorMessage(error)}. Retrying in ${delay}ms...`
                    );
                    await sleep(delay);
                }
            }
        }

        if (lastError) {
            const hasDiskFallback = cache[assetSymbol] !== undefined;
            systemLogger.warn(
                `initializeFeeCache: all ${maxAttempts} attempts failed for ${assetSymbol}: ${getErrorMessage(lastError)}` +
                (hasDiskFallback ? '. Using previously cached value from disk.' : '.')
            );
        }
    }

    MathUtils._setFeeCache(cache as unknown as Record<string, import('./math.js').FeeCacheEntry>);
    _saveFeeCacheToDisk(cache);
    return cache;
}

// ================================================================================
// SECTION 3: GRID STATE MANAGEMENT
// ================================================================================

/**
 * Persist current grid state to storage.
 * Saves all orders, cache funds, fees, boundary index, and asset info.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders data accessor
 * @returns {Promise<boolean>} True if persistence succeeded, false on error
 */
export async function persistGridSnapshot(manager: OrderManagerLike, accountOrders: AccountOrdersLike, snapshotOrders?: ManagedOrder[], recentFillKeys?: Record<string, number>, fundSnapshot?: { btsFeesOwed: number; accountTotals: AccountTotals | null }): Promise<boolean> {
    if (!manager || !accountOrders) return false;
    try {
        const orders = Array.isArray(snapshotOrders)
            ? snapshotOrders
            : Array.from(manager.orders.values());
        const pricing = manager._lastGridPricingContext || null;
        let debugConfig = manager.config || null;
        if (debugConfig && pricing) {
            const {
                gridPrice: _gridPrice,
                configuredMinPrice: _configuredMinPrice,
                configuredMaxPrice: _configuredMaxPrice,
                rangeScalingFactor: _rangeScalingFactor,
                ...restConfig
            } = debugConfig;
            debugConfig = {
                gridPrice: pricing.gridPrice,
                configuredMinPrice: pricing.configuredMinPrice,
                configuredMaxPrice: pricing.configuredMaxPrice,
                rangeScalingFactor: pricing.rangeScalingFactor,
                ...restConfig
            };
        }
        const btsBalance = (manager.config?.assetA !== 'BTS' && manager.config?.assetB !== 'BTS')
            ? (manager.btsBalance || { free: 0, total: 0, locked: 0 })
            : null;

        const fillKeys = recentFillKeys || manager._recentFillKeysSnapshot || undefined;
        const btsFeesOwed = fundSnapshot?.btsFeesOwed ?? manager.funds.btsFeesOwed;
        const accountTotals = (fundSnapshot?.accountTotals ?? manager.accountTotals) || null;
        const genesis = manager._genesis || null;
        // Gap-evacuation streaks (Phase 3 restart resilience): Map -> plain
        // object; empty map persists as cleared so stale ids never resurrect.
        // Non-Map (legacy callers without the field) passes undefined so
        // storeMasterGrid leaves any previously stored streaks untouched.
        const gapEvacStreaks = manager._gapEvacStreaks instanceof Map
            ? Object.fromEntries([...manager._gapEvacStreaks.entries()].filter(([, n]) => Number.isFinite(Number(n)) && Number(n) > 0))
            : undefined;
        // Pending fill crawls (restart resilience): fills whose boundary
        // crawl was recorded but never committed. Plain-array snapshot of
        // manager._pendingFillCrawls, sanitized and length-capped; an empty
        // array persists as cleared so consumed entries never resurrect.
        // Non-array (legacy callers) passes undefined so storeMasterGrid
        // leaves previously stored entries untouched.
        const pendingFillCrawls = Array.isArray(manager._pendingFillCrawls)
            ? manager._pendingFillCrawls
                .filter((e) => e && typeof e.slotId === 'string' && e.slotId.length > 0
                    && (e.side === 'buy' || e.side === 'sell') && Number.isFinite(Number(e.ts)))
                .slice(-500)
                .map((e) => ({ slotId: e.slotId, side: e.side, ts: Number(e.ts) }))
            : undefined;
        // LAST-FILL-GUARD pivot (restart resilience): only a fill-provenanced
        // pivot is eligible — a book-seeded heuristic is never persisted as if
        // it were market truth. Every other case (book seed, cold manager,
        // legacy stub without the flags) passes null, which storeMasterGrid
        // treats as an explicit clear; the row carries the CURRENT live
        // genesis hash so a restore that sees a re-derived genesis refuses it.
        const lastFillPivot = buildLastFillPivotPayload(manager);
        // Bot-scoped market-fill reference: survives grid regeneration, used
        // by spread correction as the price it must not trade through.
        const lastMarketFill = buildLastMarketFillPayload(manager);
        await accountOrders.storeMasterGrid(
            orders,
            btsFeesOwed,
            manager.boundaryIdx,
            manager.assets || null,
            {
                persistedAt: nowIso(),
                config: debugConfig,
                accountTotals,
                btsBalance
            },
            fillKeys,
            genesis,
            gapEvacStreaks,
            pendingFillCrawls,
            lastFillPivot,
            lastMarketFill
        );
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Restore persisted gap-evacuation streaks into the manager (Phase 3
 * restart resilience). Entries are pruned to slots that still exist in the
 * loaded grid and to finite positive counts, so a grid reset (or a renamed
 * slot scheme) can never resurrect stale streaks. The queued-once cancel
 * markers (_gapEvacCancelQueued) deliberately stay in-memory: they are only
 * meaningful alongside the in-memory corrections queue, which is empty
 * after a restart.
 *
 * @param {Object} manager - OrderManager instance
 * @param {Object|null} persisted - {slotId: count} from loadGapEvacStreaks
 * @returns {number} Number of streak entries restored
 */
export function restoreGapEvacStreaks(manager: OrderManagerLike, persisted: unknown): number {
    if (!manager) return 0;
    const streaks = new Map<string, number>();
    if (persisted && typeof persisted === 'object') {
        for (const [id, count] of Object.entries(persisted as Record<string, unknown>)) {
            const n = Math.floor(Number(count));
            if (id && Number.isFinite(n) && n > 0
                && manager.orders instanceof Map && manager.orders.has(id)) {
                streaks.set(id, n);
            }
        }
    }
    manager._gapEvacStreaks = streaks;
    return streaks.size;
}

/**
 * Build the persist payload for the LAST-FILL-GUARD pivot, or null when there
 * is nothing durable to write.
 *
 * Source-of-truth contract (single ledger): the manager's in-memory pivot is
 * authoritative during runtime; the disk row is a mirror that follows the
 * grid snapshot, so it invalidates whenever the snapshot does:
 * - Only a 'fill'-provenance pivot is eligible — a book-seeded pivot is a
 *   heuristic, not market truth, and must not fossilize into the snapshot.
 * - The row carries the CURRENT live genesis hash, so a restore that sees a
 *   different (re-derived/regenerated) genesis refuses it (a pivot from an
 *   old generation is not valid after a grid regeneration).
 * - A pivot without a live genesis is not persistable: null always clears,
 *   so an expired generation never leaves a stale row behind on disk.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {Object|null} {price, type, fillsAt, genesisHash} or null to clear
 */
function buildLastFillPivotPayload(manager: OrderManagerLike): { price: number; type: string; fillsAt: number; genesisHash: string } | null {
    const price = Number(manager?._lastFilledPrice);
    const type = manager?._lastFilledType;
    if (manager.lastFillPivotSource !== 'fill') return null;
    if (!Number.isFinite(price) || price <= 0) return null;
    if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) return null;
    const fillsAt = Number(manager._lastFilledAt);
    if (!Number.isFinite(fillsAt)) return null;
    const genesisHash = manager?._genesis?.priceLevelsHash;
    if (typeof genesisHash !== 'string' || genesisHash.length === 0) return null;
    return { price, type, fillsAt, genesisHash };
}

/**
 * Build the persist payload for the bot-scoped last-market-fill reference.
 *
 * Unlike buildLastFillPivotPayload this row has NO genesis binding and is
 * never cleared by a grid regeneration/rejection: it records the last price
 * the ACCOUNT traded at, which is market truth independent of the current
 * grid. Returns `undefined` (storeMasterGrid no-op) while cold so a cold
 * manager never erases a previously stored row; the restore path applies the
 * TTL and drops an expired row instead.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {{price:number,type:string,fillsAt:number}|undefined} Row, or undefined to leave untouched
 */
function buildLastMarketFillPayload(manager: OrderManagerLike): { price: number; type: string; fillsAt: number } | undefined {
    const price = Number(manager?._lastMarketFillPrice);
    const type = manager?._lastMarketFillType;
    const fillsAt = Number(manager?._lastMarketFillAt);
    if (!Number.isFinite(price) || price <= 0) return undefined;
    if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) return undefined;
    if (!Number.isFinite(fillsAt) || fillsAt <= 0) return undefined;
    return { price, type, fillsAt };
}

/** Why spread correction is degraded or refused for a cycle. */
export type SpreadCorrectionRefusalReason = 'cold-book' | 'stale-snapshot' | 'unmatched-orders';

export interface SpreadCorrectionReadiness {
    /** False => hard refusal (cold book): the planner must not act this cycle. */
    ok: boolean;
    /** Degraded cause ('stale-snapshot'/'unmatched-orders') or hard cause ('cold-book'). */
    reason: SpreadCorrectionRefusalReason | null;
    /**
     * Crossing floor for the planner's filter: the freshest live market read
     * when available, else the fill-derived reference. null => no floor
     * (fail-open). Not a refusal premise.
     */
    marketRef: number | null;
    /** Fill-derived reference only (live pivot or persisted row); gates the COW bypass. */
    fillMarketRef: number | null;
    /** False => the local snapshot cannot license the LAST-FILL-GUARD bypass. */
    snapshotTrusted: boolean;
    /** Known-unmatched chain orders from the last sync (price-level collision filter input). */
    unmatched: UnmatchedChainOrderLike[];
}

/** Narrowed read-only view of an unmatched chain order used by the readiness gate. */
export interface UnmatchedChainOrderLike extends Record<string, unknown> {
    price?: number;
    orderId?: string;
    chainOrderId?: string;
}

/**
 * The single freshness window shared by the spread-correction trust decisions
 * that are time-based: snapshot staleness (and therefore the COW bypass) and
 * the live-market-price refresh pacing. Resolved once so a per-bot
 * `config.timing` override cannot make one check trust what another rejects.
 * The crossing floor itself does NOT use a time window — it picks the newer
 * of the live read and the fill.
 *
 * 0 (constant unset) => no time bound: staleness never triggers and the
 * live-price refresh is never forced, so the crossing floor stays on the fill
 * anchor. Fail-open, matching the never-synced first-tick behavior.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {number} Freshness window in ms (0 => no bound => fail-open)
 */
export function resolveSpreadFreshnessMs(manager: OrderManagerLike): number {
    const configured = Number((manager?.config as { timing?: Record<string, unknown> } | undefined)?.timing?.SPREAD_CORRECTION_SYNC_FRESH_MS);
    if (configured > 0) return configured;
    const fallback = Number(TIMING?.SPREAD_CORRECTION_SYNC_FRESH_MS);
    return fallback > 0 ? fallback : 0;
}

/**
 * Resolve the crossing floor spread correction must not trade through.
 *
 * Two pieces of real market evidence can supply the floor: an externally
 * observed live price (order book/ticker) and the fill-derived reference
 * (last account trade). Neither is judged by a threshold — the NEWER one wins.
 * A live read older than the last fill loses to the fill (an executed trade is
 * fresher market truth); a live read at least as new wins; with no live read
 * at all the fill is used; with neither the floor is null (fail-open).
 *
 * This is what lets us drop the arbitrary "how far is too far" distance cap:
 * we keep the floor fresh and compare evidence by recency, rather than guessing
 * when an old floor went stale.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {number|null} Crossing floor or null (fail-open)
 */
export function resolveSpreadCrossingFloor(manager: OrderManagerLike): number | null {
    const fill = resolveSpreadMarketReference(manager);
    const live = Number(manager?._liveMarketPrice);
    const liveAt = Number(manager?._liveMarketPriceAt);
    const liveValid = Number.isFinite(live) && live > 0 && Number.isFinite(liveAt) && liveAt > 0;
    if (!liveValid) return fill;
    const fillAt = Math.max(Number(manager?._lastFilledAt) || 0, Number(manager?._lastMarketFillAt) || 0);
    if (fill == null || fillAt <= 0 || liveAt >= fillAt) return live;
    return fill;
}

/**
 * Refresh the cached live market price from the order book/ticker.
 * Best-effort; caches only a finite positive price. Returns the new price or
 * null. Call through maybeRefreshLiveMarketPrice to respect the pacing bound.
 *
 * @param {Object} manager - OrderManager instance
 * @param {unknown} BitShares - BitShares client
 * @returns {Promise<number|null>} New price or null
 */
export async function refreshLiveMarketPrice(manager: OrderManagerLike, BitShares: unknown): Promise<number | null> {
    try {
        const symA = (manager?.assets as { assetA?: { symbol?: string } } | undefined)?.assetA?.symbol;
        const symB = (manager?.assets as { assetB?: { symbol?: string } } | undefined)?.assetB?.symbol;
        // Require a real client surface: tests and dry paths pass `{}` and must
        // not trigger (or await) a pointless lookup.
        const client = BitShares as { db?: unknown } | null | undefined;
        if (!symA || !symB || !client || !client.db) return null;
        const raw = await deriveMarketPrice(client as BitSharesClient, symA, symB);
        const price = Number(raw);
        if (Number.isFinite(price) && price > 0) {
            manager._liveMarketPrice = price;
            manager._liveMarketPriceAt = Date.now();
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Live market price refreshed ${price} (${symA}/${symB})`,
                'debug'
            );
            return price;
        }
    } catch { /* best-effort: fall back to the fill anchor */ }
    return null;
}

/**
 * Refresh the live market price if none is fresh, pacing attempts to one per
 * freshness window so a chain that keeps failing cannot turn the spread check
 * into an RPC loop. The spread path stays RPC-free while the cache is fresh.
 *
 * @param {Object} manager - OrderManager instance
 * @param {unknown} BitShares - BitShares client
 * @param {Object} [options]
 * @param {number} [options.now] - Injectable clock (tests)
 * @returns {Promise<number|null>} Cached/new price or null
 */
export async function maybeRefreshLiveMarketPrice(manager: OrderManagerLike, BitShares: unknown, options: { now?: number } = {}): Promise<number | null> {
    const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
    const freshMs = resolveSpreadFreshnessMs(manager);
    if (freshMs <= 0) return Number(manager?._liveMarketPrice) || null; // no bound => never force a read
    const liveAt = Number(manager?._liveMarketPriceAt);
    if (Number.isFinite(liveAt) && liveAt > 0 && (now - liveAt) <= freshMs) {
        return Number(manager?._liveMarketPrice) || null;
    }
    const attemptedAt = Number(manager?._liveMarketPriceAttemptedAt);
    if (Number.isFinite(attemptedAt) && attemptedAt > 0 && (now - attemptedAt) <= freshMs) {
        return null; // attempted recently; do not storm the chain
    }
    // No usable client surface: leave the floor on the fill anchor. Debug only
    // (expected for tests/dry paths) and paced like a real attempt so it cannot
    // fire on every tick.
    const client = BitShares as { db?: unknown } | null | undefined;
    if (!client || !client.db) {
        manager._liveMarketPriceAttemptedAt = now;
        manager.logger?.log?.(
            '[SPREAD-CORRECTION] Live market price refresh skipped: no order-book client; crossing floor stays on the fill anchor',
            'debug'
        );
        return null;
    }
    manager._liveMarketPriceAttemptedAt = now;
    const refreshed = await refreshLiveMarketPrice(manager, BitShares);
    if (refreshed == null) {
        // One warn per pacing window: a persistently failing order-book/ticker
        // read silently degrades the floor to the fill anchor otherwise.
        manager.logger?.log?.(
            '[SPREAD-CORRECTION] Live market price refresh failed; crossing floor stays on the fill anchor until the next attempt',
            'warn'
        );
    }
    return refreshed;
}

/**
 * Evaluate whether spread correction may act on the current local snapshot,
 * in ONE place. Pure: reads manager state, returns a verdict, no side effects;
 * the caller maps the reason to a stall and the existing wiring arms the
 * targeted sync.
 *
 * Premises:
 *  - P-A cold book (no live order on either side): `ok=false` — hard refusal,
 *    there is no realized spread to repair and only the reconcile path owns
 *    the first window. Requires `options.onChainOrders`; skipped otherwise.
 *  - P-B stale snapshot (a completed sync is older than the freshness window):
 *    degraded-ok — the planner may still act, but `snapshotTrusted=false` so
 *    the LAST-FILL-GUARD bypass is withheld. Never-synced is treated as fresh
 *    (historical fail-open for the first tick).
 *  - P-C known-unmatched chain orders: degraded-ok — plan, but the collision
 *    filter drops their price levels and `snapshotTrusted=false`.
 *
 * The market anchor is deliberately NOT a refusal premise — it is returned for
 * the crossing filter, and a real fill denies the bypass via `fillMarketRef`.
 *
 * @param {Object} manager - OrderManager instance
 * @param {Object} [options]
 * @param {number} [options.now] - Injectable clock (tests)
 * @param {Object|null} [options.onChainOrders] - Live local window view; enables P-A
 * @returns {SpreadCorrectionReadiness} Readiness verdict
 */
export function evaluateSpreadCorrectionReadiness(
    manager: OrderManagerLike,
    options: { now?: number; onChainOrders?: { buys: unknown[]; sells: unknown[] } | null } = {}
): SpreadCorrectionReadiness {
    // The gate must never throw into the planner or the bypass check: a failure
    // is caught and turned into a refusal (correct-by-refusal), not a plan with
    // no floor. Callers surface it as the 'readiness-gate' stall.
    try {
        const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
        const freshMs = resolveSpreadFreshnessMs(manager);
        const marketRef = resolveSpreadCrossingFloor(manager);
        const fillMarketRef = resolveSpreadMarketReference(manager);
        const unmatched: UnmatchedChainOrderLike[] = Array.isArray(manager?._lastUnmatchedChainOrders)
            ? (manager!._lastUnmatchedChainOrders as UnmatchedChainOrderLike[])
            : [];
        const synced = Number.isFinite(Number(manager?._lastSyncAt)) && Number(manager?._lastSyncAt) > 0;
        // Never-synced, or no usable window => fresh (fail-open for the first tick).
        const stale = synced && freshMs > 0 && (now - Number(manager?._lastSyncAt) > freshMs);

        const cold = !!options?.onChainOrders
            && options.onChainOrders.buys.length === 0
            && options.onChainOrders.sells.length === 0;
        const unmatchedPresent = unmatched.length > 0;

        let reason: SpreadCorrectionRefusalReason | null = null;
        if (cold) reason = 'cold-book';
        else if (stale) reason = 'stale-snapshot';
        else if (unmatchedPresent) reason = 'unmatched-orders';

        return {
            ok: !cold,
            reason,
            marketRef,
            fillMarketRef,
            snapshotTrusted: !stale && !unmatchedPresent,
            unmatched,
        };
    } catch (err) {
        // Correct-by-refusal: a gate that cannot read state refuses the cycle.
        // reason stays null (the cause is not a real premise, it is a fault);
        // callers map null to the 'readiness-gate' stall so the targeted sync
        // arms and triage logs name the fault. Detail-only log: the caller owns
        // the operator warning, so a gate-failure cycle is reported once.
        manager.logger?.log?.(
            `[SPREAD-CORRECTION] Readiness gate failed (${getErrorMessage(err)}); refusing the cycle`,
            'debug'
        );
        return { ok: false, reason: null, marketRef: null, fillMarketRef: null, snapshotTrusted: false, unmatched: [] };
    }
}

/**
 * Resolve the last real FILL price — the fill-derived market reference.
 * Returns null (fail-open) when no real fill is known.
 *
 * The bot's grid anchor (AMA/startPrice) and its own book mid are NOT market
 * references — they are grid geometry or the bot's own quotes — so they are
 * deliberately not used here. Only a real fill price qualifies: the live
 * LAST-FILL-GUARD pivot when it is fill-provenanced, else the bot-scoped
 * persisted reference that survives grid regeneration.
 *
 * Feeds the COW bypass gate (via the readiness verdict's `fillMarketRef`) and
 * is the fallback crossing floor when no fresh live market read exists.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {number|null} Reference price or null
 */
export function resolveSpreadMarketReference(manager: OrderManagerLike): number | null {
    const live = Number(manager?._lastFilledPrice);
    const liveType = manager?._lastFilledType;
    if (manager?.lastFillPivotSource === 'fill' && Number.isFinite(live) && live > 0 && (liveType === ORDER_TYPES.BUY || liveType === ORDER_TYPES.SELL)) {
        return live;
    }
    const market = Number(manager?._lastMarketFillPrice);
    const marketType = manager?._lastMarketFillType;
    if (Number.isFinite(market) && market > 0 && (marketType === ORDER_TYPES.BUY || marketType === ORDER_TYPES.SELL)) {
        return market;
    }
    return null;
}

/**
 * Resolve the reference the generic LAST-FILL-GUARD judges against.
 *
 * Prefers the live armed pivot. When that is cold (a grid regeneration
 * cleared it, or a rejected-snapshot reset ran) it falls back to the
 * bot-scoped last-market-fill row — the same market truth spread correction
 * already uses. This is what stops a rebuild from silently un-arming the
 * guard until the next fill: the price the account last traded at is known,
 * so a CREATE/rotation must still not cross it.
 *
 * Read-time fallback only: it does NOT mutate the pivot or persist an
 * old-generation value, so the genesis-bound pivot/persist contract is
 * unchanged. The guard still validates the value onto the CURRENT ladder via
 * resolveOnGridPivot at the call site (off-ladder → raw value + warn), so a
 * regenerated geometry stays the authority on which placements are off-grid.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {{price: number|null, type: string|null}} Effective pivot (both null when cold)
 */
/**
 * Re-anchor the boundary so the newest REAL fill sits outside its own window.
 *
 * A boundary crawl is ±1 slot per committed fill, so a window that ended up
 * behind the fill (a sweep filled several slots while the commit dropped the
 * owed crawls, or the crawl was capped) cannot catch up by crawling: every
 * tightening slot on that side is then at/through the last fill and the
 * last-fill guard refuses all of them, while the funds sit in the resting
 * (stranded) inventory — the 2026-10-25 deadlock (7 sells swept slots 147-153,
 * the boundary ended at 146 and stayed there; `last-fill-blocked` thereafter).
 *
 * The fill itself is the anchor, so place it outside its window:
 *   SELL fill at slot f  -> boundary >= f - gapSlots  (sellStart = f + 1)
 *   BUY  fill at slot f  -> boundary <= f - 1         (buy window ends below f)
 *
 * Only a genuine on-ladder fill price is accepted (same one-increment drift
 * bound as `resolveOnGridPivot`), and the candidate must pass the same
 * placed-order-aware validation the boundary commit gate uses, so a re-anchor
 * can never strand a live order inside the re-typed band.
 *
 * @param {Object} manager - OrderManager (pivot + genesis)
 * @param {number|null} boundaryIdx - Boundary the derivation would commit
 * @param {Array<Object>} slots - Grid slots (current generation)
 * @param {number} gapSlots - Gap band width
 * @returns {{boundaryIdx: number|null, reanchored: boolean, from?: number|null, to?: number, side?: string, fillSlot?: number, reason?: string}}
 */
export function reanchorBoundaryFromLastFill(manager: OrderManagerLike, boundaryIdx: number | null | undefined, slots: ManagedOrder[] | null | undefined, gapSlots: number): { boundaryIdx: number | null; reanchored: boolean; from?: number | null; to?: number; side?: string; fillSlot?: number; reason?: string } {
    // NB: Number(null) === 0 and Number('') === 0 — a boundary-less manager must
    // not be re-anchored onto slot 0 (same absent-value trap as
    // consumePendingFillCrawls).
    if (boundaryIdx === null || boundaryIdx === undefined || (boundaryIdx as unknown) === '') {
        return { boundaryIdx: (boundaryIdx as number | null | undefined) ?? null, reanchored: false, reason: 'no-boundary' };
    }
    const boundary = Number(boundaryIdx);
    if (!Number.isFinite(boundary)) return { boundaryIdx: boundaryIdx ?? null, reanchored: false, reason: 'no-boundary' };
    // An absolute re-anchor must be a FILL fact, never a book seed. The
    // generic guard deliberately accepts a one-sided book seed as a pricing
    // hint, but using that heuristic as the geometry anchor would move the
    // boundary off our own resting order price. Prefer the live pivot only
    // when its provenance is 'fill'; otherwise fall back to the bot-scoped
    // last-market-fill row (a real trade that survives grid regeneration).
    const ref = resolveFillProvenancedReference(manager);
    const price = Number(ref?.price);
    if (!Number.isFinite(price) || price <= 0) return { boundaryIdx: boundary, reanchored: false, reason: 'cold-pivot' };
    const side = ref.type === ORDER_TYPES.SELL ? ORDER_TYPES.SELL : ref.type === ORDER_TYPES.BUY ? ORDER_TYPES.BUY : null;
    if (!side) return { boundaryIdx: boundary, reanchored: false, reason: 'no-fill-side' };
    const genesis = (manager as unknown as { _genesis?: Parameters<typeof MathUtils.slotIndexForPrice>[1] })?._genesis;
    const levels = genesis?.priceLevels;
    if (!genesis || !Array.isArray(levels) || levels.length === 0) {
        return { boundaryIdx: boundary, reanchored: false, reason: 'no-genesis' };
    }
    let idx: number;
    try {
        idx = Number(MathUtils.slotIndexForPrice(price, genesis));
    } catch {
        return { boundaryIdx: boundary, reanchored: false, reason: 'unresolvable-price' };
    }
    if (!Number.isFinite(idx) || idx < 0) return { boundaryIdx: boundary, reanchored: false, reason: 'unresolvable-price' };
    // Only a genuine ladder level: an off-ladder (orphan/adopted) fill price
    // must not be snapped into geometry. One increment is the caller's drift
    // bound everywhere else (resolveOnGridPivot), so reuse it here.
    const levelPrice = Number(MathUtils.priceForSlot(idx, genesis));
    const incrementPct = Math.abs(Number((manager as unknown as { config?: { incrementPercent?: unknown } })?.config?.incrementPercent));
    const maxDrift = Number.isFinite(incrementPct) && incrementPct > 0 ? incrementPct / 100 : 0.005;
    if (!Number.isFinite(levelPrice) || levelPrice <= 0 || Math.abs(levelPrice - price) / price > maxDrift) {
        return { boundaryIdx: boundary, reanchored: false, reason: 'off-ladder-fill' };
    }
    const gap = Number.isFinite(Number(gapSlots)) && Number(gapSlots) >= 0 ? Math.floor(Number(gapSlots)) : 0;
    const slotCount = Array.isArray(slots) ? slots.length : 0;
    if (slotCount === 0) return { boundaryIdx: boundary, reanchored: false, reason: 'no-slots' };
    const ceiling = (slotCount - gap - 1) >= 0 ? (slotCount - gap - 1) : (slotCount - 1);
    const required = side === ORDER_TYPES.SELL ? idx - gap : idx - 1;
    if (side === ORDER_TYPES.SELL ? boundary >= required : boundary <= required) {
        return { boundaryIdx: boundary, reanchored: false, reason: 'already-outside' };
    }
    const candidate = Math.max(0, Math.min(ceiling, required));
    if (candidate === boundary) return { boundaryIdx: boundary, reanchored: false, reason: 'no-op' };
    // Clamping can defeat the anchor: a fill near the grid ceiling needs
    // `required > ceiling`, so the clamped candidate still leaves the fill
    // inside its own window. Fail closed instead of reporting a re-anchor that
    // did not move the fill outside.
    const outsideWindow = side === ORDER_TYPES.SELL ? candidate >= required : candidate <= required;
    if (!outsideWindow) {
        return { boundaryIdx: boundary, reanchored: false, reason: 'ceiling-clamped' };
    }
    // The fill's OWN residual is not a stranding placement: a partial fill
    // leaves the remainder at the fill slot, and any boundary that puts the
    // fill outside its window necessarily puts that slot inside the implied
    // band. Allow exactly that residual (PARTIAL, same side, same ladder
    // level); every other in-band order still refuses the re-anchor.
    const allowedInBandSlotIds: string[] = [];
    const fillSlotOrder = Array.isArray(slots) ? slots[idx] : null;
    if (fillSlotOrder && fillSlotOrder.orderId
        && fillSlotOrder.state === ORDER_STATES.PARTIAL
        && fillSlotOrder.type === side) {
        let orderIdx: number | null = null;
        try { orderIdx = Number(MathUtils.slotIndexForPrice(Number(fillSlotOrder.price), genesis)); } catch { orderIdx = null; }
        const orderPrice = Number(fillSlotOrder.price);
        if (orderIdx === idx && Number.isFinite(orderPrice) && orderPrice > 0
            && Math.abs(orderPrice - price) / price <= maxDrift) {
            allowedInBandSlotIds.push(String(fillSlotOrder.id));
        }
    }
    let check: { ok: boolean; reason?: string } = { ok: true };
    try {
        check = MathUtils.validatePersistedBoundary(
            candidate,
            slots ?? [],
            gap,
            allowedInBandSlotIds.length > 0 ? { allowInBandSlotIds: allowedInBandSlotIds } : undefined
        );
    } catch (err) {
        check = { ok: false, reason: getErrorMessage(err) };
    }
    if (!check || check.ok !== true) {
        return { boundaryIdx: boundary, reanchored: false, reason: `unsafe: ${check?.reason ?? 'unknown'}` };
    }
    try {
        manager.logger?.log?.(
            `[BOUNDARY] Re-anchored from the last fill: ${side} filled at slot ${idx} ` +
            `(${price.toFixed(6)}); boundary ${boundary} -> ${candidate} so the fill sits outside ` +
            `its own window (crawl alone cannot recover a window behind the fill)`,
            'warn'
        );
    } catch { /* logging is best-effort */ }
    return { boundaryIdx: candidate, reanchored: true, from: boundary, to: candidate, side, fillSlot: idx };
}

/**
 * Resolve a FILL-PROVENANCED reference for absolute geometry repairs.
 *
 * `resolveLastFillGuardReference` intentionally accepts a one-sided book seed
 * as a guard hint. A re-anchor is different: it moves the boundary, so a
 * heuristic max-bid/min-ask price must never be treated as a trade. Accept the
 * live pivot only when `lastFillPivotSource === 'fill'`; otherwise fall back to
 * the bot-scoped last-market-fill row, which is written only by real fills and
 * survives grid regeneration.
 * @param {Object} manager - OrderManager instance
 * @returns {{price: number|null, type: string|null}}
 */
function resolveFillProvenancedReference(manager: OrderManagerLike): { price: number | null; type: string | null } {
    if (manager?.lastFillPivotSource === 'fill') {
        const livePrice = Number(manager?._lastFilledPrice);
        const liveType = manager?._lastFilledType;
        if (Number.isFinite(livePrice) && livePrice > 0 && (liveType === ORDER_TYPES.BUY || liveType === ORDER_TYPES.SELL)) {
            return { price: livePrice, type: liveType };
        }
    }
    const marketPrice = Number(manager?._lastMarketFillPrice);
    const marketType = manager?._lastMarketFillType;
    if (Number.isFinite(marketPrice) && marketPrice > 0 && (marketType === ORDER_TYPES.BUY || marketType === ORDER_TYPES.SELL)) {
        return { price: marketPrice, type: marketType };
    }
    return { price: null, type: null };
}

export function resolveLastFillGuardReference(manager: OrderManagerLike): { price: number | null; type: string | null } {
    const livePrice = Number(manager?._lastFilledPrice);
    const liveType = manager?._lastFilledType;
    if (Number.isFinite(livePrice) && livePrice > 0 && (liveType === ORDER_TYPES.BUY || liveType === ORDER_TYPES.SELL)) {
        return { price: livePrice, type: liveType };
    }
    const marketPrice = Number(manager?._lastMarketFillPrice);
    const marketType = manager?._lastMarketFillType;
    if (Number.isFinite(marketPrice) && marketPrice > 0 && (marketType === ORDER_TYPES.BUY || marketType === ORDER_TYPES.SELL)) {
        return { price: marketPrice, type: marketType };
    }
    return { price: null, type: null };
}

/**
 * LAST-FILL-GUARD — DIRECTION ONLY, relative to the last fill price.
 *
 *   BUY  blocked if price >= pivot   (never place a higher BUY)
 *   SELL blocked if price <= pivot   (never place a lower SELL)
 *
 * Lives here (not in the COW runtime) so the spread-correction PLANNER and the
 * broadcast guard judge candidates with literally the same predicate: a batch
 * must never be built from a create the guard will drop, and a dropped batch
 * must never be reported as an unexplained "prepared but not executed".
 *
 * A placement on the permitted side is always profitable against the last trade
 * we actually did: a BUY below the last sell, a SELL above the last buy. Equal
 * price counts as blocked — that is a re-place at the just-filled level, the
 * immediate re-fill loop this guard exists to prevent. Cold (no numeric pivot,
 * or no fill side recorded — e.g. a book-seeded pivot) => disabled. The grid
 * increment takes no part (kept in the signature for call-site stability).
 *
 * @param {number} price - Target order price
 * @param {number} _size - Order size (unused, kept for compat)
 * @param {string} type - ORDER_TYPES.BUY/SELL
 * @param {number|null} lastPrice - Most recent fill price
 * @param {string|null} lastType - Most recent fill side; null keeps the guard cold
 * @param {number|any} _incrementPercent - Unused (kept for signature compat)
 * @returns {{blocked: boolean, pivot: number|null, threshold?: number|null}}
 */
export function isLastFillGuardBlocked(price: number, _size: number, type: unknown, lastPrice: number | null, lastType: string | null, _incrementPercent?: number): { blocked: boolean; pivot: number|null; threshold?: number|null } {
    const numPrice = Number(price);
    if (!Number.isFinite(numPrice)) return { blocked: false, pivot: null };
    if (lastPrice == null || !Number.isFinite(Number(lastPrice)) || lastType == null) return { blocked: false, pivot: null };
    const pivot = Number(lastPrice);
    if (type === ORDER_TYPES.BUY && numPrice >= pivot) return { blocked: true, pivot, threshold: pivot };
    if (type === ORDER_TYPES.SELL && numPrice <= pivot) return { blocked: true, pivot, threshold: pivot };
    return { blocked: false, pivot: null, threshold: null };
}

/**
 * Restore the persisted bot-scoped last-market-fill reference into the
 * manager. Deliberately independent of the boundary and the genesis: this is
 * the anchor spread correction uses to avoid trading through the last real
 * fill price, and it must survive a grid regeneration (the genesis-bound
 * LAST-FILL-GUARD pivot does not). TTL-expired rows are erased from disk,
 * mirroring restoreLastFillPivot's dead-row hygiene.
 *
 * @param {Object} manager - OrderManager instance
 * @param {unknown} persisted - {price, type, fillsAt} from loadLastMarketFill
 * @param {Object} [options]
 * @param {number} [options.now] - Injectable clock (tests)
 * @returns {boolean} True when the reference was restored
 */
export function restoreLastMarketFill(manager: OrderManagerLike, persisted: unknown, options: { now?: number } = {}): boolean {
    if (!manager) return false;
    const row = normalizeLastMarketFill(persisted);
    if (!row) return false;
    // Shared dead-row contract with restoreLastFillPivot: erase a rejected
    // row so it cannot re-arm the same rejection on every restart.
    const dropPersistedRow = () => {
        try {
            const acct = manager.accountOrders;
            if (acct && typeof acct.clearPersistedLastMarketFill === 'function') {
                void acct.clearPersistedLastMarketFill();
            }
        } catch { /* best-effort */ }
    };
    const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
    const ttl = Number(GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS);
    if (Number.isFinite(ttl) && ttl > 0 && now - row.fillsAt > ttl) {
        manager.logger?.log?.(
            `[SPREAD-CORRECTION] Persisted last-market-fill expired (age ${Math.round((now - row.fillsAt) / 1000)}s > TTL ${Math.round(ttl / 1000)}s) — reference dropped`,
            'info'
        );
        dropPersistedRow();
        return false;
    }
    manager._lastMarketFillPrice = row.price;
    manager._lastMarketFillType = row.type;
    manager._lastMarketFillAt = row.fillsAt;
    manager.logger?.log?.(
        `[SPREAD-CORRECTION] Restored last-market-fill ${row.price}(${row.type}) age=${Math.round((now - row.fillsAt) / 1000)}s — spread correction will not trade through it`,
        'info'
    );
    return true;
}

/**
 * Shared field gate for a persisted fill-derived row: finite price > 0,
 * BUY/SELL side, finite positive timestamp. One shape contract for the
 * LAST-FILL-GUARD pivot row and the bot-scoped last-market-fill row.
 *
 * @param {unknown} row - Raw candidate row
 * @returns {{price:number,type:string,fillsAt:number}|null} Core fields or null
 */
function normalizeFillRow(row: unknown): { price: number; type: string; fillsAt: number } | null {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    const price = Number(r.price);
    const type = r.type;
    const fillsAt = Number(r.fillsAt);
    if (!Number.isFinite(price) || price <= 0) return null;
    if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) return null;
    if (!Number.isFinite(fillsAt) || fillsAt <= 0) return null;
    return { price, type, fillsAt };
}

/**
 * Normalize a persisted LAST-FILL-GUARD pivot row (shared by the
 * AccountOrders sanitizer/loader and the payload builder's row contract).
 *
 * The shared normalizeFillRow gate plus a non-empty string genesisHash (the
 * pivot is bound to the grid generation; the market row deliberately is not).
 *
 * @param {unknown} row - Raw candidate row
 * @returns {Object|null} Normalized row or null
 */
export function normalizeLastFillPivot(row: unknown): { price: number; type: string; fillsAt: number; genesisHash: string } | null {
    const core = normalizeFillRow(row);
    if (!core) return null;
    const genesisHash = (row as Record<string, unknown>).genesisHash;
    if (typeof genesisHash !== 'string' || genesisHash.length === 0) return null;
    return { ...core, genesisHash };
}

/**
 * Normalize a persisted bot-scoped last-market-fill row.
 *
 * Same normalizeFillRow contract as normalizeLastFillPivot but deliberately
 * WITHOUT the genesisHash binding: this row is market truth about the account
 * (the last price it traded at), not grid geometry, so it must survive a grid
 * regeneration/rejection. It is used only as a market reference by spread
 * correction, never as the COW LAST-FILL-GUARD pivot.
 *
 * @param {unknown} row - Raw candidate row
 * @returns {{price:number,type:string,fillsAt:number}|null} Normalized row or null
 */
export function normalizeLastMarketFill(row: unknown): { price: number; type: string; fillsAt: number } | null {
    return normalizeFillRow(row);
}

/**
 * Write the LAST-FILL-GUARD pivot scalar family in one place (free
 * implementation shared by the manager method, cow_runtime's queued-fill
 * refresh, and restoreLastFillPivot).
 *
 * Writes _lastFilledPrice, _lastFilledType, _lastFilledAt,
 * lastFillPivotSource and the per-side mirror (_lastFilledBuyPrice or
 * _lastFilledSellPrice). `atMs` lets restoreLastFillPivot preserve the
 * persisted fill timestamp (otherwise every restart would re-stamp "now"
 * and the TTL would degrade to "time since last restart"); ordinary fill
 * calls omit it and take Date.now().
 *
 * @param {Object} manager - OrderManager instance (or legacy stub)
 * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} price - Pivot price (finite, > 0)
 * @param {string} provenance - 'fill' (persist-eligible) or 'book' (seed heuristic)
 * @param {number} [atMs] - Fill timestamp to preserve (defaults to now)
 * @returns {boolean} True when the pivot was written
 */
export function setLastFillPivot(manager: OrderManagerLike, type: string, price: unknown, provenance: 'fill' | 'book', atMs?: number): boolean {
    if (!manager) return false;
    if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) return false;
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return false;
    const now = Number.isFinite(Number(atMs)) && Number(atMs) > 0 ? Number(atMs) : Date.now();
    manager._lastFilledPrice = p;
    manager._lastFilledType = type;
    manager._lastFilledAt = now;
    manager.lastFillPivotSource = provenance;
    if (type === ORDER_TYPES.BUY) manager._lastFilledBuyPrice = p;
    else manager._lastFilledSellPrice = p;
    // Bot-scoped market-fill reference: only a real fill is market truth. It
    // is deliberately NOT cleared by resetLastFillPivot/clearGrid — it must
    // survive a grid regeneration so spread correction still has a price it
    // cannot trade through (the genesis-bound pivot above does not).
    if (provenance === 'fill') {
        manager._lastMarketFillPrice = p;
        manager._lastMarketFillType = type;
        manager._lastMarketFillAt = now;
    }
    return true;
}

/**
 * Clear the manager's LAST-FILL-GUARD pivot to cold state — the FULL scalar
 * family, per-side mirrors included. Clearing only the primary fields would
 * leave seedLastFilledPricesFromBook's early-return (both mirrors set)
 * silently suppressing the startup book seed after every grid rebuild — the
 * exact cold window the persist/restore feature exists to close.
 *
 * Used whenever the pivot's generation is invalidated: grid rebuild via
 * initializeGrid, rejected snapshot reset, and any path that re-anchors the
 * boundary outside the fill flow. The guard re-arms on the next real fill
 * (or via the startup book seed), never against a boundary that no longer
 * exists. Must not touch disk: the pivot is a live-grid invariant, and the
 * persist pipeline clears the stored row on the next flush by passing null.
 *
 * @param {Object} manager - OrderManager instance
 * @param {string} reason - Log/debug label
 * @returns {boolean} True when an armed pivot was cleared
 */
export function resetLastFillPivot(manager: OrderManagerLike, reason: string = 'unspecified'): boolean {
    if (!manager) return false;
    const wasArmed = manager._lastFilledPrice != null && manager._lastFilledType != null;
    manager._lastFilledPrice = null;
    manager._lastFilledType = null;
    manager._lastFilledAt = 0;
    manager.lastFillPivotSource = null;
    manager._lastFilledBuyPrice = null;
    manager._lastFilledSellPrice = null;
    if (wasArmed) {
        try {
            manager.logger?.log?.(`[LAST-FILL-GUARD] Pivot cleared (${reason}); guard re-arms on the next fill`, 'info');
        } catch { /* logging is best-effort */ }
    }
    return wasArmed;
}

/**
 * Restore the persisted LAST-FILL-GUARD pivot into the manager.
 *
 * MUST run with the boundary (after loadGrid has applied the persisted
 * genesis + re-typed the grid, before the first reconcile/broadcast) so the
 * guard is never armed against a geometry the snapshot does not describe.
 *
 * Validation chain (fail → no-op, never arm on a poisoned value):
 * 1. Shape: normalizeLastFillPivot re-validates the row (shared gate).
 * 2. TTL: a pivot older than GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS expires
 *    instead of vetoing legitimate placements after long downtime (the
 *    pivot is a "latest fill" fact, not a permanent ratchet). Expired rows
 *    are dead rows: the shared drop path (clearPersistedLastFillPivot
 *    under the bot's persistence lock, best-effort) erases them so a later
 *    validation failure cannot leave a half-invalid row armed.
 * 3. Genesis binding: a row whose genesisHash differs from the manager's
 *    current genesis belongs to a dead generation — dropped through the
 *    same shared drop path (erased from disk so it cannot re-arm on the
 *    next restart).
 * 4. On-grid check reuses the runtime's own ladder validator
 *    (resolveOnGridPivot in dexbot_cow_runtime, safe to import from here —
 *    utils/system never imports it otherwise, so no cycle). One
 *    implementation for both the live guard and the restore path, same
 *    increment fallback chain. On success the snapped ladder level is
 *    restored — the guard's own convention — never the raw persisted
 *    float, and the ORIGINAL fillsAt is preserved through
 *    setLastFillPivot's atMs so the TTL keeps meaning "age of the last
 *    fill", not "time since this restart".
 *
 * @param {Object} manager - OrderManager instance
 * @param {Object|null} persisted - {price, type, fillsAt, genesisHash} from loadLastFillPivot
 * @param {Object} [options]
 * @param {number} [options.now] - Injectable clock (tests)
 * @returns {boolean} True when the guard was re-armed from the snapshot
 */
export function restoreLastFillPivot(manager: OrderManagerLike, persisted: unknown, options: { now?: number } = {}): boolean {
    if (!manager || !persisted || typeof persisted !== 'object') return false;
    const row = normalizeLastFillPivot(persisted);
    if (!row) return false;

    // Shared drop path for every "this row is dead" verdict: erase the
    // persisted row best-effort so a rejected value can never re-arm the
    // same rejection on the next restart (storeMasterGrid deliberately
    // keeps untouched rows for legacy `undefined` callers, so without the
    // erase the verdict has no TTL guarantee across restarts either).
    const dropPersistedRow = () => {
        try {
            const acct = manager.accountOrders;
            if (acct && typeof acct.clearPersistedLastFillPivot === 'function') {
                void acct.clearPersistedLastFillPivot();
            }
        } catch { /* best-effort */ }
    };

    // TTL first: an expired pivot is dropped, not re-armed.
    const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
    if (now - row.fillsAt > Number(GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS)) {
        manager.logger?.log?.(
            `[LAST-FILL-GUARD] Persisted pivot expired (age ${Math.round((now - row.fillsAt) / 1000)}s > TTL ${Math.round(Number(GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS) / 1000)}s) — guard re-arms on the next fill`,
            'info'
        );
        dropPersistedRow();
        return false;
    }

    // Genesis binding: a persisted pivot from another genesis is not valid
    // after a regeneration/re-derive. Drop the row so it cannot resurrect,
    // and let the startup book seed take over.
    const liveHash = manager._genesis?.priceLevelsHash;
    if (typeof liveHash !== 'string' || liveHash.length === 0 || liveHash !== row.genesisHash) {
        manager.logger?.log?.(
            `[LAST-FILL-GUARD] Persisted pivot genesis mismatch (stored ${row.genesisHash} vs live ${liveHash ?? 'none'}) — dropping (grid regenerated); book seed will arm instead`,
            'warn'
        );
        dropPersistedRow();
        return false;
    }

    // On-grid validation through the runtime's own ladder validator — the
    // exact same one-increment drift rule, snap, and off-grid refusal the
    // live guard applies per probe. Import is safe: utils/system.ts does not
    // otherwise import the cow runtime, and the runtime's own module top
    // level already imports utils/system (sleep, then the pivot helpers),
    // so this adds no new edge to the graph.
    try {
        const validated = cowRuntimeLadderValidator(manager, row.price);
        if (!validated) return false;
        // Arm through the shared writer, preserving the persisted timestamp.
        setLastFillPivot(manager, row.type, validated.price, 'fill', row.fillsAt);
        manager.logger?.log?.(
            `[LAST-FILL-GUARD] Restored persisted pivot ${validated.price}(${row.type})` +
            `${validated.slotIdx != null ? ` slot=${validated.slotIdx}` : ''}` +
            `${validated.snapped ? ' (snapped)' : ''} age=${Math.round((now - row.fillsAt) / 1000)}s from snapshot`,
            'info'
        );
        return true;
    } catch {
        return false;
    }
}

export interface GridResizeResult {
    workingGrid?: WorkingGridType;
    actions?: CowAction[];
    hasWorkingChanges?: boolean;
}

export interface CowResult {
    actions: CowAction[];
    workingGrid: WorkingGridType;
    workingIndexes: unknown;
    workingBoundary: number | null;
    refillSlotIds?: unknown;
    aborted: boolean;
    localOnly?: boolean;
}

/**
 * Retry grid persistence if previous attempt failed.
 * Clears persistence warning flag if successful.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {Promise<boolean>} True if persisted successfully or no warning, false on error
 */
export async function retryPersistenceIfNeeded(manager: OrderManagerLike): Promise<boolean> {
    if (!manager || !manager._persistenceWarning) return true;
    try {
        const result = typeof manager.persistGrid === 'function' ? await manager.persistGrid() : true;
        const success = result === true || (result && !result.skipped && result.isValid !== false);
        if (success) delete manager._persistenceWarning;
        return success;
    } catch (e) {
        systemLogger.warn(`retryPersistenceIfNeeded failed: ${getErrorMessage(e)}`);
        return false;
    }
}

/**
 * Apply grid corrections for divergence between calculated and active orders.
 * Uses COW (Copy-on-Write): builds a working grid, plans updates/cancels/creates,
 * executes blockchain operations, and commits working grid only on success.
 *
 * Surplus on-chain orders are cancelled (not resized to zero).
 * Size updates are emitted only for committed ACTIVE/PARTIAL orders.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders data accessor
 * @param {string} botKey - Bot identifier for persistence
 * @param {Function} updateOrdersOnChainBatchFn - Batch update function for blockchain operations
 * @param {Function} updateGridFromBlockchainSnapshotFn - Grid resize function (injected to avoid circular dependency with grid.ts)
 * @returns {Promise<void>}
 */
export async function applyGridDivergenceCorrections(manager: OrderManagerLike, accountOrders: AccountOrdersLike, _botKey: string, updateOrdersOnChainBatchFn: (cowResult: unknown) => Promise<{ executed?: boolean; reason?: string } | null | undefined>, updateGridFromBlockchainSnapshotFn: (manager: OrderManagerLike, orderType: string, force: boolean, pendingBoundaryIdx: number | null) => Promise<GridResizeResult | undefined>): Promise<{ committed: boolean, reason?: string } | undefined> {
    if (!manager._gridLock) return;
    if (typeof updateGridFromBlockchainSnapshotFn !== 'function') {
        manager.logger?.log?.('[DIVERGENCE-COW] updateGridFromBlockchainSnapshotFn is not a function — aborting', 'error');
        return undefined;
    }
    const { WorkingGrid } = require('../working_grid') as { WorkingGrid: new (orders: Map<string, ManagedOrder>, options?: { baseVersion?: number }) => WorkingGridType };
    const { hasActionForOrder, removeActionsForOrder, optimizeRebalanceActions } = require('./validate') as {
        hasActionForOrder: (actions: CowAction[], actionType: string | null, orderRef: { id?: string | null; orderId?: string | null }) => boolean;
        removeActionsForOrder: (actions: CowAction[], actionType: string | null, orderRef: { id?: string | null; orderId?: string | null }) => void;
        optimizeRebalanceActions: (actions: CowAction[], masterGrid: Map<string, ManagedOrder>, options?: { logger?: (msg: string, level?: string) => void; boundaryIdx?: number | null; gapSlots?: number; assets?: unknown }) => CowAction[];
    };

    // Phase 1: Pre-lock grid resizing using COW
    // This calculates new sizes from blockchain state but DOES NOT modify master.
    // The boundary stays pinned to the committed value: fund changes resize
    // orders through the budget allocation below but never shift rails.  The
    // fund-ratio writer was removed — it moved the boundary without guaranteed
    // same-batch refills, so a guard-vetoed refill stranded empty slots past
    // the new boundary (<bot> 91->94) with no repair path.  Remaining writers:
    // fills (deriveTargetBoundary, same-cycle rotations) and spread promotion
    // (shifts only onto slots placed in the same atomic batch).
    let resizeCowResult: GridResizeResult | null | undefined = null;
    const pendingBoundaryIdx = manager.boundaryIdx;
    if (manager._gridSidesUpdated && manager._gridSidesUpdated.size > 0) {
        const hasBuy = manager._gridSidesUpdated.has(ORDER_TYPES.BUY);
        const hasSell = manager._gridSidesUpdated.has(ORDER_TYPES.SELL);
        let resizeOrderType = hasBuy && hasSell
            ? 'both'
            : hasBuy
                ? ORDER_TYPES.BUY
                : ORDER_TYPES.SELL;

        try {
            resizeCowResult = await updateGridFromBlockchainSnapshotFn(manager, resizeOrderType, true, pendingBoundaryIdx);
        } catch (err) {
            manager.logger?.log?.(`[DIVERGENCE-COW] Grid resize failed: ${getErrorMessage(err)}`, 'error');
            manager._gridSidesUpdated.clear();
            return undefined;
        }
    }

    // Phase 2: Create working grid for divergence corrections
    // Use the resize working grid as starting point if available
    let cowResult: CowResult | null = null;
    await manager._gridLock.acquire(async () => {
        if (!manager._gridSidesUpdated || manager._gridSidesUpdated.size === 0) return;

        // Start from resize result if available, otherwise create fresh working grid
        const workingGrid = resizeCowResult?.workingGrid 
            ? resizeCowResult.workingGrid 
            : new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        
        const actions = resizeCowResult?.actions ? [...resizeCowResult.actions] : [];

        // Geometric rail constraint for desired-slot selection.  The gap band
        // is derived from the working boundary (== committed: divergence never
        // shifts it).  Uses the shared MathUtils.isSlotInRail helper (also used
        // by the strategy window and _pickVirtualSlotsToActivate): the SPREAD
        // GUARD keeps gap-band strays typed BUY/SELL (never SPREAD+ACTIVE), so
        // without a geometric filter they are selected as "closest to market"
        // and left inside the gap — collapsing the spread when a fill-driven
        // boundary shift moves into the rail (<bot>: boundary 107->110 left
        // the sell rail parked at 111-130 with the bottom three, 111-113,
        // inside the new spread gap; real spread 0.5% instead of the 2.0%
        // target).
        // Absent-aware: Number(null)/Number('') === 0 would fabricate a
        // boundary-0 rail; only a real finite pending boundary wins.
        const workingBoundaryIdx = Number.isFinite(toKnownNumber(pendingBoundaryIdx))
            ? Number(pendingBoundaryIdx)
            : manager.boundaryIdx;
        const gapSlots = manager._genesis?.gapSlots ?? manager._gapSlots ?? MathUtils.calculateGapSlots(
            manager.config?.incrementPercent,
            manager.config?.targetSpreadPercent,
            manager.config?.gridLimits
        );
        const inRailByType = (orderType: string) => (slot: ManagedOrder) =>
            MathUtils.isSlotInRail(workingBoundaryIdx, gapSlots, orderType, slot);

        for (const orderType of manager._gridSidesUpdated) {
            const sideName = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
            const sidePrecision = MathUtils.getPrecisionByOrderType(manager.assets, orderType);
            
            // Get current on-chain orders for this side.
            // Filter by WORKING GRID type (not master type) so that slots whose
            // type changed during the boundary shift (e.g. SPREAD→BUY) are correctly
            // attributed to their new side.  Using master types here while the
            // rest of Phase 2 uses working-grid types (allSideSlots, desiredSlots)
            // creates a mismatch: SPREAD→BUY crossers appear as "holes" and get
            // spurious CREATEs queued, causing the COW batch to be rejected by
            // validateCreateTargetSlots and aborting the entire correction cycle.
            const currentOnChainOrders = (Array.from(manager.orders.values()) as ManagedOrder[])
                .filter((o) => OrderUtils.isOrderPlaced(o))
                .filter((o) => {
                    const wSlot = workingGrid.get(o.id);
                    return wSlot && wSlot.type === orderType;
                });

            // Get all slots for this side from working grid.
            // Exclude gap-band strays by geometry (inRailByType) so the desired
            // window always matches the working boundary's rails.  Otherwise a
            // stray on-chain SELL inside the new spread band (kept typed SELL by
            // the SPREAD GUARD) would be picked as "closest to market" and never
            // relocated, collapsing the spread after a boundary shift.
            const allSideSlots = (Array.from(workingGrid.values()) as ManagedOrder[])
                .filter((o) => o.type === orderType)
                .filter(inRailByType(orderType))
                .sort((a, b) => sideName === 'buy' ? b.price - a.price : a.price - b.price);

            // Calculate target count
            const coreOrdersCfg = manager.config.coreOrders;
            const baseTargetCount = (coreOrdersCfg && typeof coreOrdersCfg === 'object' && Number.isFinite(Number(coreOrdersCfg[sideName])))
                ? Math.max(1, Number(coreOrdersCfg[sideName]))
                : currentOnChainOrders.length;
            const targetCount = baseTargetCount;

            // Determine desired slots (closest to market) + edge-pinned orders.
            // Buys pin at the floor, sells at the ceiling. Edge orders rest live
            // without consuming the window: the middle stays undesired and gets
            // cancelled as surplus.
            const windowSlots = allSideSlots.slice(0, targetCount);
            let desiredSlots = windowSlots;
            const edgeCount = OrderUtils.resolveEdgeCount(manager.config, sideName);
            if (edgeCount > 0) {
                const asc = allSideSlots.slice().sort((a, b) => a.price - b.price);
                const edge = sideName === 'sell' ? 'ceiling' : 'floor';
                // Both edges anchor at the live grid's own edge (single source).
                const edgeAnchor = OrderUtils.resolveLiveEdgeAnchorPrice(manager, sideName);
                const edgeSlots = OrderUtils.selectEdgeSlots(
                    asc,
                    edgeCount,
                    new Set(windowSlots.map((s) => s.id)),
                    edge,
                    edgeAnchor
                );
                desiredSlots = [...windowSlots, ...edgeSlots];
            }
            const desiredSlotIds = new Set(desiredSlots.map((s) => s.id));
            const onChainBySlotId = new Map(currentOnChainOrders.map((o) => [o.id, o]));

            // Process on-chain orders:
            // - In desired window: keep/update committed size (if not already queued by Phase 1)
            // - Outside desired window: cancel surplus order
            for (const onChainOrder of currentOnChainOrders) {
                // Get current slot from working grid (may have been updated in Phase 1)
                const slot = workingGrid.get(onChainOrder.id);
                const isDesired = desiredSlotIds.has(onChainOrder.id);

                if (!isDesired || !slot || !(toFiniteNumber(slot.size) > 0)) {
                    // Update removal is intentional, before the fresh check:
                    // the slot reached this branch because it is not desired /
                    // size 0, so a surviving Phase-1 committed-size UPDATE
                    // could emit a stale target or a size-to-zero op on a live
                    // fresh order ("surplus is never updated to size 0"
                    // invariant). Dropping it with the deferred cancel keeps
                    // the slot exactly as master holds it for the cycle; the
                    // resize is re-derived next tick.
                    removeActionsForOrder(actions, COW_ACTIONS.UPDATE, onChainOrder);
                    // Fresh-placement grace: a surplus placed seconds ago must
                    // not be cancelled here (fee bleed, empty level, no net
                    // change). Leave it active in the working grid; the
                    // surplus is re-derived next cycle once the order has had
                    // time to prove itself.
                    if (onChainOrder.orderId && OrderUtils.isFreshlyPlacedOrder(manager, onChainOrder.orderId)) {
                        manager.logger.log(
                            `[DIVERGENCE-COW] Deferring cancel of freshly placed ${onChainOrder.orderId} (${onChainOrder.id}) — inside grace window`,
                            'info'
                        );
                        continue;
                    }
                    const hasQueuedCancel = hasActionForOrder(actions, COW_ACTIONS.CANCEL, onChainOrder);

                    if (!hasQueuedCancel) {
                        manager.logger.log(`[DIVERGENCE-COW] Queueing cancel for surplus ${onChainOrder.id} (chain id ${onChainOrder.orderId})`, 'info');
                        actions.push({
                            type: COW_ACTIONS.CANCEL,
                            id: onChainOrder.id,
                            orderId: onChainOrder.orderId
                        });
                    }

                    const current = slot || onChainOrder;
                    // Rail-aware hole (Phase 2): a cancelled in-rail surplus
                    // stays a rail-typed VIRTUAL hole (size preserved for the
                    // rotation pairing downstream); only true gap-band slots
                    // become side-neutral SPREAD.
                    const holeGeoType = OrderUtils.geometryTypeForSlotIndex(
                        OrderUtils.parseSlotIndex
                            ? OrderUtils.parseSlotIndex(current?.id)
                            : null,
                        workingBoundaryIdx,
                        gapSlots
                    );
                    workingGrid.set(
                        onChainOrder.id,
                        (holeGeoType === ORDER_TYPES.BUY || holeGeoType === ORDER_TYPES.SELL)
                            ? OrderUtils.toRailHolePlaceholder(current, holeGeoType)
                            : OrderUtils.convertToSpreadPlaceholder(current)
                    );
                    continue;
                }

                // Phase 1 already queued committed size updates. Avoid duplicate UPDATEs.
                const hasQueuedUpdate = hasActionForOrder(actions, COW_ACTIONS.UPDATE, onChainOrder);
                const hasQueuedCancel = hasActionForOrder(actions, COW_ACTIONS.CANCEL, onChainOrder);

                if (hasQueuedUpdate || hasQueuedCancel) {
                    continue;
                }

                const newSize = toFiniteNumber(slot.size);
                const currentSize = toFiniteNumber(onChainOrder.size);
                const sizeChanged = Number.isFinite(sidePrecision)
                    ? MathUtils.floatToBlockchainInt(newSize, sidePrecision) !== MathUtils.floatToBlockchainInt(currentSize, sidePrecision)
                    : newSize !== currentSize;

                if (sizeChanged) {
                    manager.logger.log(`[DIVERGENCE-COW] Queueing size update for ${onChainOrder.id}: ${currentSize} -> ${newSize}`, 'info');
                    actions.push({
                        type: COW_ACTIONS.UPDATE,
                        id: onChainOrder.id,
                        orderId: onChainOrder.orderId,
                        newGridId: onChainOrder.id,
                        newSize,
                        newPrice: slot.price,
                        order: {
                            id: onChainOrder.id,
                            type: onChainOrder.type,
                            price: slot.price,
                            size: newSize
                        } as unknown as ManagedOrder
                    });
                }
            }

            // Process holes: CREATE new orders for empty desired slots
            for (const slot of desiredSlots) {
                const hasCreate = hasActionForOrder(actions, COW_ACTIONS.CREATE, slot);
                if (!onChainBySlotId.has(slot.id) && slot.size > 0 && !hasCreate) {
                    manager.logger.log(`[DIVERGENCE-COW] Queueing new placement for slot ${slot.id}`, 'info');
                    actions.push({
                        type: COW_ACTIONS.CREATE,
                        id: slot.id,
                        order: {
                            id: slot.id,
                            price: slot.price,
                            size: slot.size,
                            type: slot.type
                        } as unknown as ManagedOrder
                    });
                }
            }
        }

        // Convert same-side surplus-CANCEL + hole-CREATE pairs into in-place
        // rotation UPDATEs (reprice the existing order to the hole slot) instead
        // of cancel+recreate. Mirrors the reconcile path (manager.ts:210) and
        // removes churn when a fill-driven boundary shift re-types slots. The COW
        // executor already handles rotation UPDATEs (newGridId + newPrice remap).
        const optimizedActions = optimizeRebalanceActions(actions, manager.orders, {
            logger: (msg: string, level?: string) => manager.logger?.log?.(msg, level),
            boundaryIdx: pendingBoundaryIdx ?? undefined,
            gapSlots: manager._gapSlots,
            assets: manager.assets
        });
        if (optimizedActions !== actions) {
            actions.length = 0;
            actions.push(...optimizedActions);
        }
        // Refill-slot wire (boundary-hold): unpairable hole-CREATEs surviving
        // the fold above justify the pending boundary shift. The executor
        // holds the committed boundary when a listed refill is guard-skipped.
        // Edge-ladder CREATEs are excluded by collectRefillSlotIds — static
        // edge insurance, never a justification for a boundary shift.
        const refillSlotIds = OrderUtils.collectRefillSlotIds(actions, {
            config: manager.config,
            slots: manager.orders,
            edgeAnchors: {
                buy: OrderUtils.resolveLiveEdgeAnchorPrice(manager, 'buy'),
                sell: OrderUtils.resolveLiveEdgeAnchorPrice(manager, 'sell')
            },
            manager
        });

        // Build COW result with all actions
        if (actions.length > 0) {
            cowResult = {
                actions,
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: pendingBoundaryIdx,
                refillSlotIds,
                aborted: false
            };
        } else if (resizeCowResult?.hasWorkingChanges) {
            // No on-chain operations required, but working grid changed (typically virtual sizing).
            // Commit locally to keep master in sync with latest sizing context.
            cowResult = {
                actions: [],
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: pendingBoundaryIdx,
                localOnly: true,
                aborted: false
            };
        }
    });

    // Phase 3: Execute corrections via COW batch
    const committedCow = cowResult as CowResult | null;
    if (committedCow && !committedCow.aborted) {
        try {
            let result: { executed?: boolean; reason?: string; localOnly?: boolean; commitSkipped?: boolean } | null | undefined = null;

            if (committedCow.localOnly) {
                const committed = await manager._commitWorkingGrid(
                    committedCow.workingGrid,
                    committedCow.workingIndexes,
                    committedCow.workingBoundary
                );

                if (committed) {
                    if (typeof manager.persistGrid === 'function') {
                        await manager.persistGrid();
                    } else {
                        await persistGridSnapshot(manager, accountOrders);
                    }
                    result = { executed: true, localOnly: true };
                    manager.logger.log(`[DIVERGENCE-COW] Applied local-only sizing updates (no blockchain ops)`, 'info');
                } else {
                    result = { executed: false, localOnly: true, commitSkipped: true };
                    manager.logger.log(`[DIVERGENCE-COW] Skipped local-only commit (working grid not committed)`, 'warn');
                }
            } else {
                result = await updateOrdersOnChainBatchFn(committedCow);
            }
            
            if (result && result.executed) {
                manager.logger.log(`[DIVERGENCE-COW] Successfully applied divergence corrections`, 'info');
                manager._gridSidesUpdated.clear();
                // NOTE: We do NOT reset manager.outOfSpread here — it's overwritten
                // every tick by checkSpreadCondition (grid.ts:1691).  Resetting it
                // here would be redundant 99% of the time, and would mask a stale-value
                // window between this commit and the next checkSpreadCondition call
                // for any code path that reads outOfSpread in between.  Currently no
                // such path exists, but if one is added, the reader may see a stale
                // count until the next checkSpreadCondition runs.
                // Grid already persisted via _commitWorkingGrid in updateOrdersOnChainBatch
                return { committed: true };
            } else {
                manager.logger.log(`[DIVERGENCE-COW] Divergence corrections not executed (working grid discarded)`, 'warn');
                manager._gridSidesUpdated.clear();
                return { committed: false, reason: result?.reason };
            }
        } catch (err) {
            manager.logger.log(`[DIVERGENCE-COW] Error executing divergence corrections: ${getErrorMessage(err)}`, 'error');
            manager._gridSidesUpdated.clear();
            return { committed: false };
        }
    } else {
        // No actions needed or aborted
        manager._gridSidesUpdated.clear();
        return undefined;
    }
}


// ================================================================================
// SECTION 5: UI & INTERACTIVE UTILITIES
// ================================================================================

/**
 * Ensure profiles directory exists, creating if necessary.
 * 
 * @param {string} profilesDir - Path to profiles directory
 * @returns {boolean} True if directory was created, false if it already existed
 */
export function ensureProfilesDirectory(profilesDir: string): boolean {
    if (!storage.exists(profilesDir)) { ensureDir(profilesDir); return true; }
    return false;
}

/**
 * Returns the current date and time in ISO format.
 * @returns {string} ISO timestamp.
 */
export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Sleep for a duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms: number): Promise<void> {
    return sleepMs(ms);
}

/**
 * Read user input from stdin with optional masking.
 * Handles raw terminal mode for interactive prompts.
 * Supports password masking and backspace handling.
 * 
 * @param {string} prompt - Prompt text to display
 * @param {Object} [options={}] - Input options
 * @param {boolean} [options.hideEchoBack=false] - Hide input echo (for passwords)
 * @param {string} [options.mask=''] - Character to display instead of input
 * @param {Function} [options.colorize] - Live colorizer applied to the typed input on redraw
 * @param {boolean} [options.trimInput=true] - Trim surrounding whitespace before
 *        resolving; pass false when the caller must tell a bare Enter from a
 *        whitespace-only entry (the live echo already distinguishes them)
 * @returns {Promise<string>} User input (trimmed unless trimInput=false)
 */
export function readInput(prompt: string, options: { hideEchoBack?: boolean; mask?: string; validate?: (input: string) => boolean; colorize?: (input: string) => string; trimInput?: boolean } = {}): Promise<string> {
    return new Promise<string>((resolve) => {
        const stdin = runtime.stdin!; const stdout = runtime.stdout;
        const ESC_SEQUENCE_TIMEOUT_MS = 150;
        let input = '';
        let cursorPos = 0;
        let escBuf = '';
        let escTimer: ReturnType<typeof setTimeout> | null = null;
        stdout.write(prompt);
        const isRaw = stdin.isRaw ?? false; if (stdin.isTTY) stdin.setRawMode?.(true);
        stdin.resume(); stdin.setEncoding?.('utf8');

        function redraw() {
            const shouldMask = options.hideEchoBack || typeof options.mask === 'string';
            const maskChar = options.mask || '*';
            let display = shouldMask ? maskChar.repeat(input.length) : input;
            if (!shouldMask && input.length > 0 && typeof options.colorize === 'function') {
                display = options.colorize(input);
            }
            stdout.write('\r\x1b[K' + prompt + display);
            if (cursorPos < input.length) {
                stdout.write('\x1b[' + (input.length - cursorPos) + 'D');
            }
        }

        function handleSequence(seq: string) {
            // Arrow keys
            if (seq === 'D') { if (cursorPos > 0) { cursorPos--; redraw(); } return true; }
            if (seq === 'C') { if (cursorPos < input.length) { cursorPos++; redraw(); } return true; }
            // Home / End
            if (seq === 'H' || seq === 'OH') { cursorPos = 0; redraw(); return true; }
            if (seq === 'F' || seq === 'OF') { cursorPos = input.length; redraw(); return true; }
            // Delete
            if (seq === '3~') {
                if (cursorPos < input.length) {
                    input = input.slice(0, cursorPos) + input.slice(cursorPos + 1);
                    redraw();
                }
                return true;
            }
            // Insert
            if (seq === '2~') { return true; }
            return false;
        }

        function processEscBuf() {
            escTimer = null;
            const buf = escBuf;
            escBuf = '';
            // Standalone ESC
            if (buf === '\x1b') { cleanup(); stdout.write('\r\x1b[K\n'); return resolve('\x1b'); }
            // CSI sequence: ESC [ <params> <final>
            if (buf.length >= 3 && buf[1] === '[') {
                const seq = buf.substring(2);
                if (handleSequence(seq)) return;
                // Unhandled sequence — ignore
                return;
            }
            // ESC + something else (e.g. Alt+key) — ignore
        }

        function handleChar(ch: string) {
            if (ch === '\r' || ch === '\n' || ch === '\u0004') { cleanup(); stdout.write('\n'); return resolve(options.trimInput === false ? input : input.trim()); }
            if (ch === '\u0003') { cleanup(); stdout.write('\r\x1b[K\n'); runtime.exit(0); }

            // Backspace
            if (ch === '\u007f' || ch === '\u0008') {
                if (cursorPos > 0) {
                    input = input.slice(0, cursorPos - 1) + input.slice(cursorPos);
                    cursorPos--;
                    redraw();
                }
                return;
            }

            // Printable character — insert at cursor
            if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126) {
                input = input.slice(0, cursorPos) + ch + input.slice(cursorPos);
                cursorPos++;
                redraw();
            }
        }

        const onData = (chunk: unknown) => {
            const s = String(chunk);
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];

                // Accumulating an escape sequence
                if (escBuf) {
                    escBuf += ch;
                    // CSI: after ESC [, collect up to final byte (@-~)
                    if (escBuf.length === 2 && escBuf[1] === '[') continue;
                    if (escBuf.length > 2 && ch >= '@' && ch <= '~') {
                        if (escTimer) clearTimeout(escTimer);
                        processEscBuf();
                    }
                    continue;
                }

                // Start of potential escape sequence
                if (ch === '\x1b') {
                    escBuf = ch;
                    escTimer = setTimeout(processEscBuf, ESC_SEQUENCE_TIMEOUT_MS);
                    continue;
                }

                handleChar(ch);
            }
        };
        const cleanup = () => { if (escTimer) clearTimeout(escTimer); escBuf = ''; stdin.removeListener('data', onData); if (stdin.isTTY) stdin.setRawMode?.(isRaw); };
        stdin.on('data', onData);
    });
}

/**
 * Read password input from user with masked echo.
 * 
 * @param {string} prompt - Prompt text to display
 * @returns {Promise<string>} User-entered password
 */
export async function readPassword(prompt: string): Promise<string> { return readInput(prompt, { mask: '*', hideEchoBack: false }); }

/**
 * Execute async function with exponential backoff retry logic.
 * Retries on failure with increasing delays up to maxDelayMs.
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} [options={}] - Retry options
 * @param {number} [options.maxAttempts=3] - Maximum retry attempts
 * @param {number} [options.baseDelayMs=1000] - Base delay in milliseconds
 * @param {number} [options.maxDelayMs=10000] - Maximum delay in milliseconds
 * @param {Object} [options.logger=null] - Optional logger for retry messages
 * @param {string} [options.operationName='operation'] - Name for log messages
 * @returns {Promise<*>} Result of function execution
 * @throws {Error} If all attempts fail, throws the final error
 */
export async function withRetry<T>(fn: () => Promise<T>, options: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; logger?: { log?: Function } | null; operationName?: string } = {}): Promise<T> {
    const { maxAttempts = PIPELINE_TIMING.RETRY_MAX_ATTEMPTS, baseDelayMs = PIPELINE_TIMING.RETRY_BASE_DELAY_MS, maxDelayMs = PIPELINE_TIMING.RETRY_MAX_DELAY_MS, logger = null, operationName = 'operation' } = options;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === maxAttempts) throw err;
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            logger?.log?.(`${operationName} attempt ${attempt} failed. Retrying in ${delay}ms...`, 'warn');
            await sleep(delay);
        }
    }
    throw new Error(`${operationName} failed after ${maxAttempts} attempts`);
}

/**
 * Execute a blockchain operation with timeout, retry, and node failover reporting.
 * Reports each failure to NodeManager so the node gets blacklisted after
 * consecutive failures, triggering automatic failover to a healthy node.
 *
 * After exhausting the retry budget, force-blacklists the current node and
 * reconnects to a different healthy node, then makes one final attempt.
 * This prevents the bot from hanging indefinitely on a stuck node.
 *
 * Defaults: 30s timeout, 3 retries (PIPELINE_TIMING.RETRY_MAX_ATTEMPTS), 2s retry delay.
 * All configurable via options.
 *
 * @param fn - Async function wrapping the blockchain operation
 * @param label - Short human-readable label for error messages
 * @param options.logger - Optional logger for retry warnings
 * @param options.timeoutMs - Override timeout per attempt (default 30000)
 * @param options.maxRetries - Override max retry count (default PIPELINE_TIMING.RETRY_MAX_ATTEMPTS)
 * @param options.retryDelayMs - Override delay between retries (default 2000)
 */
export async function withBlockchainRetry<T>(
    fn: () => Promise<T>,
    label: string,
    options?: {
        logger?: { log?: Function } | null;
        timeoutMs?: number;
        maxRetries?: number;
        retryDelayMs?: number;
    }
): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? 30000;
    const maxRetries = options?.maxRetries ?? PIPELINE_TIMING.RETRY_MAX_ATTEMPTS;
    const retryDelayMs = options?.retryDelayMs ?? 2000;
    const logger = options?.logger;
    let lastError: unknown;

    /** Run fn() with a timeout via shared withTimeout utility. */
    function raceWithTimeout(attemptLabel: string): Promise<T> {
        const p = fn();
        Promise.resolve(p).catch(() => {});
        return withTimeout(p, timeoutMs, { label: `${label} ${attemptLabel}` });
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await raceWithTimeout(`attempt ${attempt}/${maxRetries}`);
        } catch (err) {
            lastError = err;

            // Report node failure so NodeManager can blacklist and trigger failover
            try {
                const { getNodeManager } = require('../../bitshares_client');
                const nodeManager = getNodeManager?.();
                const nodeUrl = nodeManager?.getBestNode?.();
                if (nodeUrl && typeof nodeManager.reportNodeFailure === 'function') {
                    nodeManager.reportNodeFailure(nodeUrl, getErrorMessage(err), 'blockchain-op');
                }
            } catch (_) { /* reporting errors are non-fatal */ }

            if (attempt < maxRetries) {
                logger?.log?.(
                    `${label} attempt ${attempt}/${maxRetries} failed: ${getErrorMessage(err)}. Retrying in ${retryDelayMs}ms...`,
                    'warn'
                );
                await sleep(retryDelayMs);
            }
        }
    }

    // All retries exhausted — force-switch to a different node and retry once more
    try {
        const { getNodeManager, reconnectForCycle } = require('../../bitshares_client');
        const nodeManager = getNodeManager?.();
        const failedNode = nodeManager?.getBestNode?.();
        if (failedNode && typeof nodeManager.blacklistNode === 'function') {
            nodeManager.blacklistNode(failedNode);
            logger?.log?.(
                `${label}: blacklisted node ${failedNode.substring(0, 40)}... after ${maxRetries} failed attempts. Switching nodes...`,
                'warn'
            );
        }
        const reconnected = await reconnectForCycle(label + ' failover');
        if (reconnected) {
            logger?.log?.(`${label}: reconnected to different node. Retrying operation...`, 'warn');
            return await raceWithTimeout('failover attempt');
        }
    } catch (_) { /* failover recovery errors are non-fatal — throw original error */ }

    throw new Error(`${label} failed after ${maxRetries} attempts: ${getErrorMessage(lastError)}`);
}

// ================================================================================
// SECTION 6: GENERAL UTILITIES
// ================================================================================

/**
 * Resolve the best account reference for blockchain reads.
 * Prefer account ID when available, fall back to account name.
 * Used by recovery and startup paths where implicit account context may be unavailable.
 * @param {Object} manager - OrderManager instance (optional)
 * @param {string} account - Account name (optional)
 * @returns {string|null} Resolved account reference or null
 */
export function resolveAccountRef(manager: OrderManagerLike, account: string): string | null {
    if (manager && typeof manager.accountId === 'string' && manager.accountId) {
        return manager.accountId;
    }
    if (manager && typeof manager.account === 'string' && manager.account) {
        return manager.account;
    }
    if (typeof account === 'string' && account) {
        return account;
    }
    return null;
}

/**
 * Recursively freezes an object to ensure immutability.
 * @param {Object} obj 
 * @returns {Object}
 */
export function deepFreeze<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    const rec = obj as Record<string, unknown>;
    Object.getOwnPropertyNames(obj).forEach((prop: string) => {
        if (Object.prototype.hasOwnProperty.call(obj, prop) &&
            rec[prop] !== null &&
            (typeof rec[prop] === 'object' || typeof rec[prop] === 'function') &&
            !Object.isFrozen(rec[prop])) {
            deepFreeze(rec[prop]);
        }
    });
    return obj;
}

/**
 * Creates a shallow clone of a Map.
 * @param {Map} map 
 * @returns {Map}
 */
export function cloneMap<K, V>(map: Map<K, V>): Map<K, V> {
    return new Map(map);
}

/**
 * Fire-and-forget structural grid resync. Invokes the manager's handler and
 * logs both a synchronous throw and an async rejection through the manager
 * logger, so escalation sites share one error-handling footer. No-op when the
 * manager has no handler.
 */
export function fireStructuralResync(
    bot: BotLike,
    reason: string,
    details: Record<string, unknown>,
    errorLabel: string,
    level: string = 'error',
): void {
    try {
        const res = bot.manager?.requestStructuralGridResync?.(reason, details);
        res?.catch?.((err: unknown) => bot.manager?.logger?.log?.(`${errorLabel}: ${getErrorMessage(err)}`, level));
    } catch (err) {
        bot.manager?.logger?.log?.(`${errorLabel}: ${getErrorMessage(err)}`, level);
    }
}

/**
 * Parses JSON content that may contain comments (/* or //).
 * Strips block comments then line comments before parsing.
 * @param {string} raw - The raw string content with possible comments.
 * @returns {Object} The parsed JSON object.
 */
export function parseJsonWithComments(raw: string): Record<string, unknown> {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped) as Record<string, unknown>;
}

export { ensureDir };

/**
 * Apply persisted-but-uncommitted fill crawls onto the restored boundary.
 *
 * Fills record a crawl at intake and the derivation consumes it on commit; a
 * refused broadcast, an aborted plan, or a restart in between leaves the crawl
 * owed and the boundary stale, so reconcile would refill the holes same-side.
 * Every grid-load path that restores a persisted boundary must therefore apply
 * the stored records BEFORE it syncs/reconciles — the startup resume path and
 * the recovery reload both go through here, so the two can never drift.
 *
 * Records are relative deltas applied by consumePendingFillCrawls onto a
 * FINITE restored boundary (a null boundary re-anchors absolutely from live
 * fills instead, which subsumes every owed delta). The candidate is validated
 * placed-order-aware; on failure the records are dropped rather than stranding
 * live orders. Best-effort: the caller proceeds with the restored boundary
 * either way.
 *
 * @param {Object} bot - DEXBot (accountOrders + manager required)
 * @param {Object} [options]
 * @param {(message: string, level?: any) => void} [options.log] - Log sink;
 *   defaults to the manager logger (startup passes bot._log)
 * @param {boolean} [options.forceReload=false] - Re-read the store from disk
 *   before applying (recovery reloads already re-read the grid; startup has a
 *   freshly-constructed store)
 * @returns {Promise<{applied: boolean, from?: number, to?: number, count?: number, reason?: string}>}
 */
export async function applyPersistedPendingCrawls(
    bot: BotLike,
    options: { log?: (message: string, level?: string) => void; forceReload?: boolean } = {}
): Promise<{ applied: boolean; from?: number; to?: number; count?: number; reason?: string }> {
    const log = typeof options.log === 'function'
        ? options.log
        : (message: string, level?: string) => {
            try { bot?.manager?.logger?.log?.(message, level); } catch { /* best-effort */ }
        };
    try {
        const load = bot?.accountOrders?.loadPendingFillCrawls;
        const persisted = typeof load === 'function'
            ? (load.call(bot.accountOrders, options.forceReload === true) ?? [])
            : [];
        if (Array.isArray(persisted) && persisted.length > 0 && Array.isArray(bot?.manager?._pendingFillCrawls)) {
            bot.manager._pendingFillCrawls = persisted as Array<{ slotId: string; side: string; ts: number }>;
        }
        const result = OrderUtils.consumePendingFillCrawls(bot.manager!);
        if (result?.applied) {
            log(
                `[BOUNDARY] Applied ${result.count} pending fill crawl(s): boundary ${result.from} -> ${result.to}; ` +
                `persisting before reconcile`,
                'warn'
            );
            try { await bot.manager?.persistGrid?.(); } catch { /* best-effort */ }
        } else if (result?.reason === 'restore-failed') {
            // consumePendingFillCrawls deliberately does NOT clear the ledger
            // on a restore failure, so these records are retained and retried —
            // they were not dropped.
            log(`[BOUNDARY] Pending fill crawls retained (${result.reason}); restored boundary kept`, 'warn');
        } else if (result?.reason && result.reason !== 'nothing-owed'
            && result.reason !== 'no-op' && result.reason !== 'null-boundary') {
            log(`[BOUNDARY] Pending fill crawls dropped (${result.reason})`, 'warn');
        }
        return result ?? { applied: false };
    } catch (err) {
        log(`[BOUNDARY] Pending-crawl application failed (${err}); continuing with restored boundary`, 'warn');
        return { applied: false, reason: 'error' };
    }
}

/**
 * modules/order/sync_engine.ts - SyncEngine
 *
 * Blockchain synchronization and reconciliation engine.
 * Exports a single SyncEngine class handling all blockchain state matching.
 *
 * Responsibilities:
 * - Match blockchain open orders to grid orders
 * - Detect and handle partial fills
 * - Process fill history events
 * - Update fund state based on blockchain
 * - Fetch and cache account balances
 * - Initialize asset metadata
 *
 * Uses AsyncLock to prevent concurrent sync operations (defense-in-depth locking).
 *
 * ===============================================================================
 * TABLE OF CONTENTS - SyncEngine Class (12 methods) + module-level helpers
 * ===============================================================================
 *
 * MODULE-LEVEL HELPERS (internal, not exported):
 *   readSingleOrderSeam / batchReadOrdersSeam - Chain-order read indirection seams
 *   confirmSuspectEmptyRead(mgr) - Re-read after a suspicious empty snapshot
 *   describeNearestAdoptionCandidates(mgr, chainOrder, precision, matchedIds) -
 *      Diagnostic candidates for nearest-slot adoption
 *   chainPriceOnSameLevel(...) - Chain price vs a grid level under precision rules
 *   adoptedSlotKeepsItsOwnPrice(mgr, adopted, chainOrderId, path) - Adoption guard
 *   adoptChainOrderIntoSlot(...) - Adopt an unmatched chain order into a free slot
 *
 * INITIALIZATION (1 method)
 *   1. constructor(manager) - Create new SyncEngine with manager reference
 *
 * BLOCKCHAIN SYNCHRONIZATION (3 methods - async)
 *   2. syncFromOpenOrders(chainOrders, options) - Main sync entry point (async)
 *      Reconciles grid against fresh blockchain snapshot
 *      Uses AsyncLock to ensure only one sync at a time (defense-in-depth)
 *      Performs two-pass reconciliation (grid→chain, then chain→grid)
 *
 *   3. _doSyncFromOpenOrders(chainOrders, options) - Execute sync with locking (async, internal)
 *      Acquires _syncLock, validates chain orders, calls _performSyncFromOpenOrders
 *
 *   4. _performSyncFromOpenOrders(mgr, precA, precB, parsedChain, rawChain, options) - Core sync logic (internal)
 *      Performs actual two-pass reconciliation without locking
 *      Pass 1: Match grid orders to chain (known grid → chain, includes orphan cleanup)
 *      Pass 2: Add missing chain orders (unknown chain → grid)
 *
 * FILL PROCESSING (5 methods)
 *   5. _findMatchingGridOrder(mgr, orderId) - Look up the grid slot owning a chain order (internal)
 *
 *   6. _computeFillContext(mgr, matchedGridOrder, paysAssetId, paysAmountRaw) -
 *      Resolve the asset/side context for a fill (internal)
 *
 *   7. _computeFillTransitionResult(mgr, params) - Compute the post-fill slot
 *      transition and fund deltas without mutating state (internal, async)
 *
 *   8. syncFromFillHistory(fill) - Process single fill event synchronously
 *      Updates grid order state based on fill data
 *      Updates fund state and accounting
 *      Handles both maker and taker fills
 *
 *   9. syncFromFillHistoryBatch(fills) - Process multiple fill events in batch
 *      Acquires _gridLock once for all fills in block group
 *      Batches drift refetch into one get_objects RPC call
 *      Applies all grid mutations in a single applyGridUpdateBatch
 *
 * FULL SYNCHRONIZATION (2 methods - async)
 *  10. _assertGenesisInvariant(mgr) - Fail-closed check that a snapshot has a genesis ladder (internal)
 *
 *  11. synchronizeWithChain(chainData, source) - Full sync (fetch + sync) (async)
 *      Fetches fresh account balances
 *      Calls syncFromOpenOrders() with chain data
 *      Source: event type that triggered sync (fill, poll, broadcast, etc.)
 *
 * ACCOUNT STATE (2 methods - async)
 *  12. fetchAccountBalancesAndSetTotals() - Fetch account totals (async)
 *      Retrieves BUY/SELL totals and free balances from blockchain
 *      Sets manager.accountTotals
 *      Triggers fund recalculation
 *
 *  13. initializeAssets() - Initialize asset metadata (async)
 *      Fetches asset precision and other metadata
 *      Sets manager.assets
 *      Called once at bot startup
 *
 * ===============================================================================
 *
 * GLOBAL LOCK HIERARCHY (see manager.ts for canonical 5-level definition):
 *   Level 0: _fillProcessingLock  →  Level 1: _divergenceLock  →  Level 2: _syncLock
 *   →  Level 3: _gridLock  →  Level 4: _fundLock
 * Acquire in ascending order only.
 *
 * SYNC-LOCAL HIERARCHY (nested inside _syncLock):
 * 1. _syncLock (AsyncLock): Ensures only one full-sync at a time
 * 2. Per-order locks (shadowOrderIds): Protect specific orders during sync
 * 3. Lock refresh mechanism: Prevents timeout during long reconciliation
 *
 * TWO-PASS RECONCILIATION:
 * PASS 1: Grid → Chain
 * - For each grid order with orderId, find matching chain order
 * - Detect partial fills (chain size < grid size)
 * - Update sizes and mark as filled if needed
 * - Downgrade to VIRTUAL if not found on-chain
 *
 * PASS 2: Chain → Grid
 * - For each chain order not matched to grid order
 * - Create new grid order for unexpected chain order
 * - Mark as ACTIVE with blockchain orderId
 *
 * ===============================================================================
 */


import { ORDER_TYPES, ORDER_STATES, TIMING, BTS_PRECISION } from '../constants.js';
import * as Format from './format.js';
import { lookupAsset, sleep, resolveAccountRef } from './utils/system.js';
import * as chainOrders from '../chain_orders.js';
import * as client from '../bitshares_client.js';
/**
 * Test seam for targeted single-order refetches (drift refetch + sub-dust
 * residual verification). When manager._readSingleOrderFn is a function it
 * is used instead of the chain read. The chain path starts with
 * waitForConnected (30s timeout against live nodes); tests that drive fill
 * paths with a drift signal or a sub-dust residual would otherwise hang on
 * that connect for a read whose result they do not even assert on.
 * Production never sets this; default is the chain.
 */
function readSingleOrderSeam(mgr: OrderManagerLike, orderId: string, timeoutMs: number): Promise<unknown> {
    const seam = mgr._readSingleOrderFn;
    if (typeof seam === 'function') return (seam as (id: string, timeout: number) => Promise<unknown>)(orderId, timeoutMs);
    return chainOrders.readSingleOrder(orderId, timeoutMs);
}
/** Same seam for the batched drift refetch (batch path). */
function batchReadOrdersSeam(mgr: OrderManagerLike, orderIds: string[], timeoutMs: number): Promise<unknown> {
    const seam = mgr._batchReadOrdersFn;
    if (typeof seam === 'function') return (seam as (ids: string[], timeout: number) => Promise<unknown>)(orderIds, timeoutMs);
    return chainOrders.batchReadOrders(orderIds, timeoutMs);
}
const { BitShares } = client;
import { NATIVE_CLIENT } from '../constants.js';
const { toFiniteNumber } = Format;
import {
    blockchainToFloat,
    floatToBlockchainInt,
    getAssetFees,
    getBtsSide,
    slotIndexForPrice,
    isChainPriceOutOfGrid,
    isSlotInRail,
    priceForSlot,
    priceSlotEqual,
    pricesOnSameLevel
} from './utils/math.js';
import {
    parseChainOrder,
    geometryTypeForSlotIndex,
    applyChainSizeToGridOrder,
    convertToSpreadPlaceholder,
    virtualizeOrder,
    buildFillKey,
    isOrderPlaced,
    hasOnChainId,
    isOrderVirtual,
    resolveSpreadOrderSide,
    duplicateOrphanLogInfo,
    _stampCorrectionProvenance,
    _filterUnmatchedChainOrders
} from './utils/order.js';
import { parseSlotIndex } from './utils/slot.js';
import {
    resolveProcessedFillPersistenceMode
} from './processed_fill_store.js';
import { hasGenesisLadder } from './genesis_policy.js';
import { getErrorMessage } from '../utils/errors.js';
import type { OrderManagerLike, SyncResult, ManagedOrder, UnmatchedChainOrder, ParsedChainOrder, PendingPriceCorrection, ChainOrder, OrderType, AssetInfo, AssetPair } from '../types.js';
import type { GridGenesis } from './utils/math.js';

interface SyncFillEvent {
    op?: [unknown, FillOpInput?];
    block_num?: number;
    id?: string;
    [key: string]: unknown;
}

interface FillOpInput {
    order_id?: string;
    is_maker?: boolean;
    pays?: { amount?: number; asset_id?: string };
    receives?: { amount?: number; asset_id?: string };
}

interface FillEntry {
    fill: SyncFillEvent;
    fillOp: FillOpInput;
    blockNum?: number;
    historyId?: string;
    orderId: string | undefined;
    fillKey: string;
    isMaker: boolean;
    paysAmountRaw: number;
    paysAssetId: string | null | undefined;
    receivesAmountRaw: number;
    receivesAssetId: string | null | undefined;
}

interface FillEntryContext {
    entry: FillEntry;
    matchedGridOrder: ManagedOrder;
    orderType: OrderType;
    precision: number;
    filledAmount: number;
    filledAmountInt: number;
    currentSizeIntFromGrid: number;
    rawForSaleInt: number;
    /** Execution price from the fill amounts (quote per base), null when unknown. */
    fillPrice: number | null;
}

interface FillTransitionParams {
    matchedGridOrder: ManagedOrder;
    orderType: OrderType;
    precision: number;
    filledAmount: number;
    filledAmountInt: number;
    currentSizeIntFromGrid: number;
    rawForSaleInt?: number;
    chainRefetched: boolean;
    chainConfirmsEmpty: boolean;
    effectiveRawForSale: number;
    blockNum?: number;
    historyId?: string;
    isMaker: boolean;
    /**
     * Execution price (quote per base) from the chain fill / chain order, when
     * known. The fill record must carry the REAL trade price: `matchedGridOrder`
     * is keyed by slot, and a refused-commit adoption can leave that slot at a
     * stale generation price (e.g. slot-118 @1267 while the chain order traded
     * at 1345.7). The last-fill pivot / re-anchor read this field, never the
     * slot price. The slot's own identity price is intentionally NOT rewritten
     * (GRID-PRICE-INVARIANT).
     */
    fillPrice?: number | null;
}

interface SyncChainData {
    gridOrderId?: string;
    chainOrderId?: string;
    orderId?: string;
    isPartialPlacement?: boolean;
    expectedType?: string;
    fee?: number;
    order?: { type?: string; price?: number; size?: number } | null;
    skipAccounting?: boolean;
    deferredFee?: number | null;
    clearSize?: boolean;
    [key: string]: unknown;
}

interface BtsFeeData {
    total: number;
    createFee: number;
    updateFee: number;
    cancelFee: number;
    makerNetFee: number;
    takerNetFee: number;
    netFee: number;
    isMaker: boolean;
}

/** Minimal shape of a raw chain/open-order entry used by the sync helpers. */
interface ChainOrderInput {
    id?: string;
    orderId?: string | null;
    price?: number;
    size?: number;
    type?: string;
}

/**
 * Confirming re-read for the suspect-empty-read guard: after
 * SYNC_SUSPECT_EMPTY_READ_LIMIT consecutive 0-order snapshots with placed
 * grid orders still present, one more read after
 * SYNC_EMPTY_READ_CONFIRM_DELAY_MS decides whether the account is genuinely
 * empty. A lagging node serves consecutive empties, so the count alone is
 * not authoritative.
 *
 * Test seam: when manager._confirmEmptyReadFn is a function it is used
 * instead of the chain read (must resolve to a raw order array, or null
 * when the re-read itself is ambiguous). A throwing seam is 'ambiguous'.
 * When manager._skipEmptyReadConfirmDelay is truthy the production
 * SYNC_EMPTY_READ_CONFIRM_DELAY_MS pacing is skipped (tests); the confirm
 * semantics (confirmed / contradicted / ambiguous / unavailable) are unchanged.
 *
 * @param {Object} mgr - OrderManager instance (accountId, config, logger).
 * @returns {Promise<string>} 'confirmed' (still empty — accept),
 *   'contradicted' (non-empty — reset counter, refuse this round),
 *   'ambiguous' (truncated/read-error — refuse, re-confirm next round), or
 *   'unavailable' (no chain identity or dry-run — caller falls back to the
 *   legacy count-based acceptance, preserving unit-test semantics).
 */
async function confirmSuspectEmptyRead(mgr: OrderManagerLike): Promise<string> {
    try {
        if (mgr?.config?.dryRun) return 'unavailable';
        const seam = mgr._confirmEmptyReadFn;
        const delay = mgr._skipEmptyReadConfirmDelay
            ? 0
            : Math.max(0, Number(TIMING.SYNC_EMPTY_READ_CONFIRM_DELAY_MS) || 0);
        if (typeof seam === 'function') {
            if (delay > 0) await sleep(delay);
            let fresh: unknown = null;
            try {
                fresh = await (seam as () => Promise<unknown>)();
            } catch {
                return 'ambiguous';
            }
            if (fresh === null || fresh === undefined) return 'ambiguous';
            if (Array.isArray(fresh) && fresh.length > 0) return 'contradicted';
            return 'confirmed';
        }
        let accountRef: string | null = null;
        try {
            accountRef = resolveAccountRef(mgr, mgr.accountId ?? '');
        } catch {
            return 'unavailable';
        }
        if (!accountRef) return 'unavailable';
        if (delay > 0) await sleep(delay);
        const fresh = await chainOrders.readOpenOrdersGuarded(chainOrders, accountRef, {
            log: (message: string, level?: string) => mgr?.logger?.log?.(message, level),
            label: 'SYNC-CONFIRM',
            detail: 'suspect-empty confirm re-read',
        });
        if (fresh === null) return 'ambiguous';
        if (Array.isArray(fresh) && fresh.length > 0) return 'contradicted';
        return 'confirmed';
    } catch {
        return 'ambiguous';
    }
}

/**
 * Describe the nearest same-side (or spread) candidate slots for a chain order
 * that could not be adopted, so a log read says WHICH slot blocked it.
 *
 * Ladder-based, not tolerance-based: a candidate is "at this price" when the
 * chain order and the candidate's slot price map to the same ladder level
 * (`chainPriceOnSameLevel` — the adoption rule itself). The price diff is
 * reported against the slot's own level for the human reader.
 */
function describeNearestAdoptionCandidates(mgr: OrderManagerLike, chainOrder: ChainOrderInput, precision: number | null, matchedGridOrderIds: Set<string> | null = null) {
    if (!mgr?.orders || !chainOrder || typeof precision !== 'number') return 'candidate diagnostics unavailable';

    const chainPrice = toFiniteNumber(chainOrder.price);
    const chainSize = toFiniteNumber(chainOrder.size);
    const chainInt = floatToBlockchainInt(chainSize, precision);
    const candidates: Array<{ slot: ManagedOrder; typeMatch: boolean; spreadMatch: boolean; priceDiff: number; priceEqual: boolean; sizeDiffInt: number; hasOrderId: boolean; alreadyMatched: boolean; primaryEligible: boolean; adoptable: boolean }> = [];

    for (const slot of mgr.orders.values()) {
        if (!slot || ![ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL, ORDER_STATES.VIRTUAL].includes(slot.state)) continue;
        const typeMatch = slot.type === chainOrder.type;
        const spreadMatch = slot.type === ORDER_TYPES.SPREAD;
        if (!typeMatch && !spreadMatch) continue;

        const price = toFiniteNumber(slot.price);
        const priceDiff = Math.abs(price - chainPrice);
        let priceEqual = false;
        try { priceEqual = chainPriceOnSameLevel(chainPrice, price, mgr?._genesis, precision, mgr?.assets, chainSize, toFiniteNumber(slot.size), chainOrder.type, mgr?.config?.incrementPercent); } catch { priceEqual = chainPrice === price; }
        const gridInt = floatToBlockchainInt(toFiniteNumber(slot.size), precision);
        const sizeDiffInt = chainInt - gridInt;
        const hasOrderId = Boolean(slot.orderId);
        const alreadyMatched = Boolean(matchedGridOrderIds?.has?.(slot.id));
        const sizeOk = Math.abs(sizeDiffInt) <= 1;
        const primaryEligible = typeMatch && priceEqual && sizeOk;
        const adoptable = (typeMatch || spreadMatch) && priceEqual && sizeOk && !hasOrderId && !alreadyMatched;

        candidates.push({
            slot,
            typeMatch,
            spreadMatch,
            priceDiff,
            priceEqual,
            sizeDiffInt,
            hasOrderId,
            alreadyMatched,
            primaryEligible,
            adoptable,
        });
    }

    candidates.sort((a, b) => a.priceDiff - b.priceDiff);
    if (candidates.length === 0) return 'no same-side or spread candidate slots exist';

    return candidates.slice(0, 5).map((candidate) => {
        const slot = candidate.slot;
        const reasons: string[] = [];
        if (!candidate.typeMatch && !candidate.spreadMatch) reasons.push('type');
        if (!candidate.priceEqual) reasons.push('price');
        if (Math.abs(candidate.sizeDiffInt) > 1) reasons.push('size');
        if (candidate.hasOrderId) reasons.push(`occupied:${slot.orderId}`);
        if (candidate.alreadyMatched) reasons.push('alreadyMatched');
        if (candidate.primaryEligible) reasons.push('primary-matchable');
        if (candidate.adoptable) reasons.push('adoptable');
        return `${slot.id || 'unknown'} ${slot.type}/${slot.state}` +
            ` orderId=${slot.orderId || 'none'}` +
            ` price=${Format.formatPrice6(slot.price)}` +
            ` diff=${Format.formatPrice6(candidate.priceDiff)}` +
            ` size=${Format.formatSizeByOrderType(slot.size || 0, chainOrder.type ?? ORDER_TYPES.SPREAD, mgr.assets)}` +
            ` sizeDiffInt=${candidate.sizeDiffInt}` +
            ` reason=${reasons.join('|') || 'unknown'}`;
    }).join('; ');
}

/**
 * Whether a chain order rests on the SAME LADDER LEVEL as a slot (the slot's
 * own index), which is the "has this order moved?" test the pass-1 path needs.
 *
 * Level identity, not float equality: a chain order legitimately rests a few
 * quanta off its slot's level (a regeneration leaves old orders at old levels,
 * a broadcast rounds), and both prices still map to the same slot. An order that
 * maps to a DIFFERENT slot really has moved, and only then is a price
 * correction / duplicate / re-slot warranted. Unjudgeable inputs (no ladder,
 * non-finite price) fall back to integer equality at the asset precision.
 */
function chainPriceOnSameLevel(
    chainPrice: number,
    slotPrice: number,
    genesis: unknown,
    precision: number,
    assets: AssetPair | null = null,
    chainSize: number = 0,
    slotSize: number = 0,
    type: string | null = null,
    incrementPercent: number | null = null
): boolean {
    if (hasGenesisLadder(genesis)) {
        try {
            const g = genesis as Parameters<typeof slotIndexForPrice>[1];
            return slotIndexForPrice(chainPrice, g) === slotIndexForPrice(slotPrice, g);
        } catch { /* unjudgeable — fall through to price-level comparison */ }
    }
    // No ladder (legacy/migration window): compare the chain price to the slot
    // price with the chain-representable tolerance, capped to half a grid step.
    // NOT priceSlotEqual at the asset amount precision, which collapses
    // adjacent levels for a low-precision asset.
    if (assets != null) {
        return pricesOnSameLevel(chainPrice, chainSize, type, slotPrice, slotSize, type, assets, incrementPercent);
    }
    try { return priceSlotEqual(chainPrice, slotPrice, precision); } catch { return chainPrice === slotPrice; }
}

/**
 * Assert (non-fatally) that an adopted slot still carries its own genesis
 * level, not a price inherited from the chain order.
 *
 * Adoption keeps the slot's price by NOT assigning it — an absence of a write.
 * That is correct but invisible: nothing would notice if a later edit added
 * `price: chainOrder.price` back, and nothing would notice a slot whose price
 * had already been corrupted before it reached adoption. This makes the rule
 * explicit and warns when it is broken.
 *
 * Deliberately non-throwing: adoption already has handled rejection paths, and
 * turning a warning into a crash here would strand a live chain order. The
 * caller's existing rejection handling stays the enforcement; this is the
 * signal that surfaces the corruption in the log.
 *
 * @returns {boolean} true when the slot's price is its genesis level (or its id
 *   cannot address a level); false when it demonstrably is not, or when the
 *   manager holds no ladder at all (INV-GRID-004 fault, not a pass).
 */
function adoptedSlotKeepsItsOwnPrice(mgr: OrderManagerLike, adopted: ManagedOrder | null, chainOrderId: string, path: string): boolean {
    try {
        const genesis = mgr._genesis;
        const levels = genesis?.priceLevels;
        if (!Array.isArray(levels) || levels.length === 0) {
            // Undefined grid (INV-GRID-004): no ladder means no authority for
            // the slot's price, so there is nothing to check the adoption
            // against. Report it — the caller's return value is informational
            // (adoption is never blocked), so the log is the signal.
            mgr.logger?.log?.(
                `[SYNC] Adoption (${path}) for ${chainOrderId} into slot ${adopted?.id}: the manager holds no price ladder ` +
                `(INV-GRID-004), so the slot's price cannot be verified against its genesis level.`,
                'error'
            );
            return false;
        }
        const idx = parseSlotIndex(adopted?.id);
        if (idx === null || !Number.isFinite(idx) || idx < 0 || idx >= levels.length) return true;
        const expected = Number(priceForSlot(idx, genesis as Parameters<typeof priceForSlot>[1]));
        const got = Number(adopted?.price);
        if (!Number.isFinite(expected) || expected <= 0) return true;
        if (!Number.isFinite(got)) return true;
        const diff = Math.abs(got - expected);
        const rel = diff / Math.max(1e-12, Math.abs(expected));
        if (rel > 1e-9 && diff > 1e-12) {
            mgr.logger?.log?.(
                `[SYNC] Adoption (${path}) for ${chainOrderId} into slot ${adopted?.id}: slot price ${got} is NOT the slot's ` +
                `genesis level ${expected} (drift ${(rel * 100).toFixed(3)}%). Adoption must not write the chain order's price ` +
                `into slot.price — the slot keeps its own level. Adopting anyway (the chain order is real); investigate what ` +
                `corrupted this slot's price.`,
                'warn'
            );
            return false;
        }
        return true;
    } catch {
        return true; // never let an observability check break adoption
    }
}

async function adoptChainOrderIntoSlot(mgr: OrderManagerLike, slot: ManagedOrder, chainOrder: ChainOrderInput, chainOrderId: string, rawChainOrders: Map<string, unknown>, matchedGridOrderIds: Set<string>, chainOrderIdsOnGrid: Set<string>, filledOrders: ManagedOrder[], updatedOrders: ManagedOrder[], skipAccounting: boolean): Promise<boolean> {
    // ADOPTION NEVER TAKES THE CHAIN ORDER'S PRICE.
    //
    // Two different prices are conflated on this path, and only one of them is
    // a grid position:
    //
    //   slot.price   what this slot's LEVEL is        -> must equal priceForSlot(idx, genesis)
    //   chainOrder.price  where the order RESTS on chain -> may differ legitimately
    //
    // They legitimately differ after a grid regeneration: the grid is
    // recentered, old chain orders keep resting at the OLD grid's levels, and
    // adoption adopts the order into the nearest slot (slotIndexForPrice). That
    // is normal and is why this function accepts a differing chainOrder.price.
    //
    // It must not WRITE it. The resting price is chain metadata about where the
    // order was placed; it disappears on the next rotation/cancel. Writing it
    // into slot.price is the S1 corruption this whole invariant exists to
    // prevent, so `price` is deliberately absent from the assignments below and
    // the slot keeps its own level in `bestMatch` (spread from `slot`).
    //
    // Size is the opposite: size IS real state, so the chain value is adopted.
    let bestMatch: ManagedOrder = { ...slot };
    const wasVirtual = slot.state === ORDER_STATES.VIRTUAL;
    const wasPartial = slot.state === ORDER_STATES.PARTIAL;
    // SPREAD slots are legitimate adoption targets (typeCompat allows them),
    // but the slot must be re-typed to the real on-chain side BEFORE activation:
    // validateOrder treats SPREAD + orderId/on-chain state as fatal
    // ILLEGAL_SPREAD_STATE, and the size precision below depends on the
    // resolved side. Every other activation path (COW rotation destinations,
    // grid load) performs the same re-type.
    if (bestMatch.type === ORDER_TYPES.SPREAD && (chainOrder.type === ORDER_TYPES.BUY || chainOrder.type === ORDER_TYPES.SELL)) {
        bestMatch.type = chainOrder.type;
    }
    bestMatch.orderId = chainOrderId;
    bestMatch.state = wasVirtual ? ORDER_STATES.ACTIVE : slot.state;
    const bestMatchRaw = rawChainOrders.get(chainOrderId);
    bestMatch.rawOnChain = bestMatchRaw
        ? ({ ...(bestMatchRaw as Record<string, unknown>), fetchedAt: Date.now() } as ManagedOrder['rawOnChain'])
        : (bestMatchRaw as ManagedOrder['rawOnChain']);
    matchedGridOrderIds.add(bestMatch.id);
    if (bestMatch.rawOnChain) {
        const rawRecord = bestMatch.rawOnChain as Record<string, unknown>;
        const rawDeferredFee = toFiniteNumber(rawRecord.deferred_fee, null);
        if (rawDeferredFee !== null && rawDeferredFee > 0) {
            bestMatch.btsFeeState = { deferredFee: blockchainToFloat(rawDeferredFee, BTS_PRECISION) };
        } else if (wasVirtual && rawDeferredFee !== null && rawDeferredFee <= 0 && Number(rawRecord.for_sale) > 0) {
            bestMatch.state = ORDER_STATES.PARTIAL;
        }
    }
    const assets = mgr.assets;
    if (!assets?.assetA || !assets?.assetB) return false;
    const precision = (bestMatch.type === ORDER_TYPES.SELL) ? assets.assetA.precision : assets.assetB.precision;
    const targetInt = floatToBlockchainInt(slot.size, precision);
    const chainInt = floatToBlockchainInt(chainOrder.size, precision);
    if (targetInt !== chainInt) {
        const updated = await applyChainSizeToGridOrder(mgr, bestMatch, toFiniteNumber(chainOrder.size));
        if (updated) bestMatch = { ...bestMatch, ...updated };
        if (chainInt > 0) {
            if (wasVirtual && bestMatch.state !== ORDER_STATES.PARTIAL) bestMatch.state = ORDER_STATES.ACTIVE;
            else if (chainInt < targetInt) bestMatch.state = ORDER_STATES.PARTIAL;
            else if (wasPartial) bestMatch.state = ORDER_STATES.PARTIAL;
            else bestMatch.state = ORDER_STATES.ACTIVE;
        } else {
            const spreadOrder = convertToSpreadPlaceholder(bestMatch);
            const applied = await mgr._applyOrderUpdate(spreadOrder, 'sync-pass2-filled', { skipAccounting: skipAccounting, fee: 0 });
            if (applied === false) {
                // Rejected adoption must not poison the slot for the next
                // chain order: the slot was marked matched above, so release
                // it — B's adoption re-fails the same validation and gets
                // the existing cancelOnly handling if the rejection was
                // slot-specific.
                matchedGridOrderIds.delete(bestMatch.id);
                return false;
            }
            filledOrders.push({
                ...bestMatch,
                // Pass-2 adoption of an already-gone order: the parsed chain
                // price is the only trade fact available (bestMatch.price is
                // the slot identity and may be stale).
                ...(Number.isFinite(Number(chainOrder.price)) && Number(chainOrder.price) > 0
                    ? { price: Number(chainOrder.price) }
                    : {})
            });
            updatedOrders.push(spreadOrder);
            chainOrderIdsOnGrid.add(chainOrderId);
            try { _filterUnmatchedChainOrders(mgr, chainOrderId); } catch { /* counting hygiene only */ }
            return true; // filled path
        }
    } else if (wasPartial) {
        bestMatch.state = ORDER_STATES.PARTIAL;
    }
    adoptedSlotKeepsItsOwnPrice(mgr, bestMatch, chainOrderId, 'genesis');
    const applied = await mgr._applyOrderUpdate(bestMatch, 'sync-pass2-orphan', { skipAccounting: skipAccounting, fee: 0 });
    if (applied === false) {
        // Same un-poisoning as the filled path above: the slot counts as
        // matched only once the update lands.
        matchedGridOrderIds.delete(bestMatch.id);
        return false;
    }
    updatedOrders.push(bestMatch);
    chainOrderIdsOnGrid.add(chainOrderId);
    // Adopted means matched: drop any deferred-orphan record so fund counting
    // (which adds unmatched locks) never double-counts the slot.
    try { _filterUnmatchedChainOrders(mgr, chainOrderId); } catch { /* counting hygiene only */ }
    return true;
}

class SyncEngine {
    private manager: OrderManagerLike;
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager: OrderManagerLike) {
        this.manager = manager;
    }

    /**
     * Reconcile grid orders against fresh blockchain open orders snapshot.
     * This is the MAIN SYNCHRONIZATION MECHANISM that corrects the grid state when
     * the blockchain state diverges from our local expectations.
     *
     * CRITICAL: This method uses AsyncLock (defense-in-depth) to ensure only one
     * full-sync operation runs at a time. WITHIN that lock, per-order locks prevent
     * concurrent createOrder/cancelOrder races.
     *
     * LOCK HIERARCHY:
     * 1. _syncLock (AsyncLock): Ensures only one full-sync at a time
     * 2. Per-order locks (shadowOrderIds): Protect specific orders during sync
     * 3. Lock refresh mechanism: Prevents timeout during long reconciliation
     *
     * RECONCILIATION FLOW:
     * ========================================================================
     * This method performs a two-pass reconciliation:
     *
     * PASS 1: Match grid orders to chain orders (known grid → chain lookup)
     * - For each grid order with an orderId, find the matching chain order
     * - Detect partial fills: if chain size < grid size, downgrade to PARTIAL state
     * - Detect full fills: if order no longer exists on chain, convert to SPREAD
     * - Detect price slippage: flag orders for price correction if needed
     * - Update grid order sizes to match chain reality
     *
     * PASS 2: Orphan chain orders (chain → grid lookup)
     * - For chain orders not matched in Pass 1, find best grid slot match
     * - This handles cases where an order was placed but grid lost track (race condition)
     * - Uses price tolerance and geometric proximity to find the best match
     * - Once matched, retroactively assign orderId and synchronize state
     *
     * CRITICAL RULES:
     * 1. ACTIVE orders can only stay ACTIVE if size matches chain exactly
     *    If chain size < grid size → must transition to PARTIAL
     * 2. If an ACTIVE order is not found on chain → it filled → convert to SPREAD
     * 3. Precision matters: Use blockchain integer arithmetic to compare sizes
     *    Floating point comparisons can give false positives for partial fills
     * 4. Size updates are applied via applyChainSizeToGridOrder() which handles
     *    precision conversion and may adjust sizes slightly for blockchain granularity
     *
      * PRICE TOLERANCE CALCULATION:
      * calculatePriceTolerance() can return null in these cases:
      *   1. assets parameter is null/missing
      *   2. gridPrice is 0 or null (invalid price)
      *   3. orderSize is 0 or null (invalid size - orders should not sync with 0 size)
      *   4. assetA or assetB precision is undefined (asset metadata not loaded)
      * When tolerance is null, we treat it as 0 (strict: any price difference flagged).
      * This is safe because null signals a configuration/data issue, not a real order.
      *
      * RETURNS: { filledOrders, updatedOrders, ordersNeedingCorrection }
      * - filledOrders: Orders that completed (now SPREAD placeholders)
      * - updatedOrders: All orders modified during sync (state changes, size updates)
      * - ordersNeedingCorrection: Orders with price slippage requiring correction
     *
     * EDGE CASES HANDLED:
     * - Orphan chain orders (placed but grid lost track due to race condition)
     * - Partial fills (size reduced on chain)
     * - Full fills (order removed from chain completely)
     * - Price tolerance (small slippage acceptable, large slippage flagged)
     * - Precision mismatches (blockchain integer precision vs float grid)
     * - Double spending prevention (each chain order matched to at most one grid order)
     */
    /**
     * Synchronize grid orders with blockchain open orders snapshot.
     * @param {Array|null} chainOrders - Array of blockchain order objects
     * @param {Object} [options={}] - Sync options (e.g., { skipAccounting: true })
     * @returns {Promise<Object>} Result with filledOrders, updatedOrders, ordersNeedingCorrection
     */
    async syncFromOpenOrders(chainOrders: unknown[] | null, options: Record<string, unknown> = {}): Promise<SyncResult> {
        const mgr = this.manager;

        if (!mgr) {
            throw new Error('manager required for syncFromOpenOrders');
        }
        // E2 (defence in depth): a populated grid MUST have a price ladder
        // before the first sync touches it. loadGrid (E1) and the startup gate
        // (E3) establish that invariant; this assert exists to catch a future
        // path that skips both. It is FAIL-CLOSED: without a ladder there is no
        // authority for a slot's price, so the sync returns without touching
        // the grid (no locks taken, nothing adopted, nothing queued for
        // correction) and a structural resync re-derives the ladder. There is no
        // tolerance matcher left to fall back to. See docs/GRID_PRICE_INVARIANT.md.
        //
        // Note: unlike the normal path (which snapshots the result into
        // `_lastUnmatchedChainOrders`), this early return does NOT rewrite that
        // snapshot. The refusal is itself the resync signal, and leaving any
        // prior holds in place keeps the maintenance stranded-hold escalation
        // able to act on them until the next successful sync.
        if (!this._assertGenesisInvariant(mgr)) {
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }
        if (!mgr._syncLock) {
            mgr.logger?.log?.('Error: syncLock not initialized', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }

        // CRITICAL: The gate below is the recursion breaker. syncFromOpenOrders
        // re-invokes itself as the acquire() callback, so without this check the
        // acquire() re-entrant short-circuit alone would recurse forever (each
        // nested call is re-entrant and runs the body again). Only run through
        // the lock when the caller does NOT already hold it.
        if (mgr._fillProcessingLock && !mgr._fillProcessingLock.isReentrant()) {
            return mgr._fillProcessingLock.acquire(async () => {
                return this.syncFromOpenOrders(chainOrders, options);
            });
        }

        const timeoutMs = TIMING.SYNC_LOCK_TIMEOUT_MS;
        const forceReleaseMs = TIMING.SYNC_LOCK_FORCE_RELEASE_AGE_MS;
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let forceReleaseHandle: ReturnType<typeof setTimeout> | undefined;
        const syncStartedAt = Date.now();
        // Capture sync generation so the orphan callback can detect that it
        // was force-released and abort early instead of running to completion.
        const captureGeneration = mgr._syncGeneration ?? 0;
        try {
            const result = await Promise.race([
                mgr._syncLock.acquire(async () => {
                    // Early-abort check: if forceRelease incremented _syncGeneration
                    // while we were waiting in the lock queue, this callback is
                    // orphaned and should return immediately.
                    if ((mgr._syncGeneration ?? 0) !== captureGeneration) {
                        mgr.logger?.log?.('[SYNC] Sync abandoned: force-released before lock acquired', 'warn');
                        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
                    }

                    // Snapshot the correction queue length so we can roll back
                    // side-effect pushes if forceRelease fires during the sync.
                    const preSyncCorrectionLen = Array.isArray(mgr.ordersNeedingPriceCorrection)
                        ? mgr.ordersNeedingPriceCorrection.length
                        : 0;

                    // If fill accounting applied balances but the order update
                    // failed, flag forces a fresh chain-balance fetch to correct
                    // the negative free balance before the next sync cycle.
                    if (mgr.accountTotalsStale) {
                        mgr.accountTotalsStale = false;
                        try {
                            await mgr.fetchAccountTotals(mgr.accountId || mgr.config?.accountId);
                        } catch (fetchErr) {
                            mgr.logger?.log?.(`[SYNC] Stale-totals refresh failed: ${getErrorMessage(fetchErr)}`, 'warn');
                        }
                    }

                    const innerResult: SyncResult = await this._doSyncFromOpenOrders(chainOrders, options);

                    // Re-check generation after sync completes: if forceRelease fired
                    // during the sync, this result is orphaned — discard it.
                    if ((mgr._syncGeneration ?? 0) !== captureGeneration) {
                        mgr.logger?.log?.(
                            `[SYNC] Sync abandoned: force-released during sync (${Date.now() - syncStartedAt}ms); discarding result`,
                            'warn'
                        );
                        // Roll back any corrections that _performSyncFromOpenOrders may
                        // have pushed to the manager-level queue — the caller discarding
                        // the result will never process them, leaving orphaned entries.
                        if (Array.isArray(mgr.ordersNeedingPriceCorrection) && mgr.ordersNeedingPriceCorrection.length > preSyncCorrectionLen) {
                            mgr.ordersNeedingPriceCorrection.length = preSyncCorrectionLen;
                        }
                        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
                    }

                    if (timedOut) {
                        mgr.logger?.log?.(
                            `[SYNC] Sync completed after timeout (${Date.now() - syncStartedAt}ms) — ` +
                            `timeout won the race; next sync will reconcile chain state`,
                            'warn'
                        );
                        return innerResult;
                    }
                    clearTimeout(forceReleaseHandle);
                    const unmatchedCount = Array.isArray(innerResult.unmatchedChainOrders)
                        ? innerResult.unmatchedChainOrders.length
                        : 0;
                    mgr._lastUnmatchedChainOrders = unmatchedCount > 0
                        ? (innerResult.unmatchedChainOrders ?? []).map((order) => ({ ...(order as Record<string, unknown>) }) as UnmatchedChainOrder)
                        : [];
                    mgr._lastUnmatchedChainOrdersAt = unmatchedCount > 0 ? Date.now() : 0;
                    // Freshness stamp for the spread-correction bypass gate:
                    // only a completed open-orders sync makes the local anchor
                    // trustworthy enough to bypass the LAST-FILL-GUARD.
                    mgr._lastSyncAt = Date.now();
                    mgr.logger?.log?.(
                        `[SYNC] Synchronization complete: ${innerResult.filledOrders.length} filled, ` +
                        `${innerResult.updatedOrders.length} updated, ` +
                        `${innerResult.ordersNeedingCorrection.length} needing correction.`, 'info');
                    return innerResult;
                }),
                new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        reject(new Error(`Sync timed out after ${timeoutMs}ms`));
                    }, timeoutMs);
                })
            ]);
            clearTimeout(timeoutHandle);
            clearTimeout(forceReleaseHandle);
            return result;
        } catch (err) {
            clearTimeout(timeoutHandle);
            clearTimeout(forceReleaseHandle);
            if (getErrorMessage(err)?.includes('timed out')) {
                // Gap 3: Schedule a force-release of the sync lock if the inner
                // operation doesn't complete within the grace window. This prevents
                // a single stuck sync from permanently blocking all subsequent syncs.
                if (forceReleaseMs > 0 && mgr._syncLock && typeof mgr._syncLock.forceRelease === 'function') {
                    forceReleaseHandle = setTimeout(() => {
                        if (mgr._syncLock.isLocked()) {
                            // Increment the sync generation so the orphan callback
                            // can detect it was force-released and abort early.
                            mgr._syncGeneration = (mgr._syncGeneration || 0) + 1;
                            const released = mgr._syncLock.forceRelease();
                            mgr.logger?.log?.(
                                `[SYNC] Force-released sync lock (generation=${mgr._syncGeneration}, ${released} queued ops cleared) after ${forceReleaseMs}ms grace period`,
                                'warn'
                            );
                        }
                    }, Math.max(1000, forceReleaseMs - (Date.now() - syncStartedAt)));
                }
                mgr.logger?.log?.(
                    '[SYNC] Lock may be held by orphan after timeout; will release when inner work completes',
                    'warn'
                );
            }
            mgr.logger?.log?.(`Sync lock error: ${getErrorMessage(err)}`, 'error');
            throw err;
        }
    }

    /**
     * Internal method that performs the actual sync logic within lock context.
     *
     * This is the core synchronization implementation that runs inside _syncLock
     * to ensure exclusive access. It validates inputs, parses chain orders, and
     * delegates to _performSyncFromOpenOrders for the actual reconciliation.
     *
     * VALIDATION CHECKS:
     * - Manager must be initialized
     * - Chain orders must be a valid array
     * - Manager.orders must be initialized as Map
     * - Asset precisions must be available
     *
     * PARSING:
     * Converts raw blockchain order objects to normalized format using parseChainOrder()
     * with appropriate asset precision.
     *
     * @param {Array<Object>|null} chainOrders - Array of raw blockchain order objects
     *   Each object contains sell_price, for_sale, id, etc. from blockchain
     * @param {Object} options - Sync options
     * @returns {Promise<Object>} Sync result:
     *   - filledOrders {Array}: Orders that were detected as filled
     *   - updatedOrders {Array}: Orders that were updated during sync
     *   - ordersNeedingCorrection {Array}: Orders flagged for price correction
     * @async
     * @private
     */
    async _doSyncFromOpenOrders(chainOrders: unknown[] | null, options: Record<string, unknown>) {
        const mgr = this.manager;

        // Validate inputs
        if (!mgr) {
            throw new Error('manager required');
        }

        if (!chainOrders || !Array.isArray(chainOrders)) {
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }
        if (!mgr.orders || !(mgr.orders instanceof Map)) {
            mgr.logger?.log?.('Error: manager.orders is not initialized as a Map', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }
        if (mgr.assets?.assetA?.precision === undefined || mgr.assets?.assetB?.precision === undefined) {
            mgr.logger?.log?.('Error: manager.assets precision missing', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }

        const assetAPrecision = mgr.assets.assetA.precision;
        const assetBPrecision = mgr.assets.assetB.precision;
        const assetAId = mgr.assets.assetA.id;
        const assetBId = mgr.assets.assetB.id;

        if (!assetAId || !assetBId) {
            mgr.logger?.log?.('Error: manager.assets asset IDs missing', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }

        // Use separate maps: parsed (floats) and raw (blockchain integers)
        // This eliminates type confusion - each map has a single, clear purpose
        const parsedChainOrders = new Map<string, ParsedChainOrder>();
        const rawChainOrders = new Map<string, Record<string, unknown>>();

        for (const order of chainOrders) {
            try {
                const parsed = parseChainOrder(order as ChainOrder, mgr.assets);
                if (!parsed) continue;

                // Store parsed (converted) data in parsedChainOrders
                parsedChainOrders.set((order as { id: string }).id, parsed);
                // Store raw blockchain data in separate map - clean separation of concerns
                rawChainOrders.set((order as { id: string }).id, order as Record<string, unknown>);
            } catch (e) {
                mgr.logger?.log?.(`Warning: Error parsing chain order ${(order as { id?: string }).id}: ${getErrorMessage(e)}`, 'warn');
                continue;
            }
        }

        mgr.logger?.log?.(`[SYNC] Starting synchronization from ${parsedChainOrders.size} blockchain orders...`, 'info');

        // SUSPECT EMPTY READ GUARD (Fix C): an empty chain read while the grid
        // still holds placed orders (slots with orderIds) is far more likely a
        // lagging/partial node response than a genuinely emptied account — a
        // 0-order read treated as authoritative has virtualized live orders
        // ("phantom" resets). Refuse to reconcile on a
        // suspect empty; the guard is self-expiring: after
        // TIMING.SYNC_SUSPECT_EMPTY_READ_LIMIT consecutive empty reads the
        // account really is empty and the sync accepts it — but only after one
        // confirming re-read (see below). Any non-empty read
        // resets the counter.
        if (parsedChainOrders.size === 0) {
            const gridOrderIds = (Array.from(mgr.orders.values()) as ManagedOrder[]).filter((o) => o?.orderId).length;
            if (gridOrderIds > 0) {
                const suspect = mgr._suspectEmptyReads ?? { count: 0, firstAt: 0 };
                suspect.count += 1;
                if (!suspect.firstAt) suspect.firstAt = Date.now();
                mgr._suspectEmptyReads = suspect;
                const limit = Math.max(1, Number(TIMING.SYNC_SUSPECT_EMPTY_READ_LIMIT) || 3);
                if (suspect.count < limit) {
                    mgr.logger?.log?.(
                        `[SYNC] Suspect empty read (${suspect.count}/${limit} consecutive) with ${gridOrderIds} grid orderIds — ` +
                        `refusing reconciliation (phantom protection); accepting after ${limit} consecutive empties or next non-empty read`,
                        'warn'
                    );
                    return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
                }
                // Limit reached: a lagging node serves CONSECUTIVE 0-order
                // snapshots, so the count alone is not authoritative. Require
                // one confirming re-read after SYNC_EMPTY_READ_CONFIRM_DELAY_MS
                // before reconciling to empty; a contradicted re-read
                // (non-empty) resets the counter and refuses this round (the
                // next sync reconciles against the fresh snapshot), while an
                // ambiguous re-read (truncated/read-error) refuses and retries
                // the confirm on the next empty round.
                const confirm = await confirmSuspectEmptyRead(mgr);
                if (confirm === 'contradicted') {
                    mgr.logger?.log?.(
                        `[SYNC] Suspect empty read contradicted by confirm re-read with ${gridOrderIds} grid orderIds — ` +
                        `resetting empty-read counter; reconciling on the next non-empty sync`,
                        'warn'
                    );
                    mgr._suspectEmptyReads = { count: 0, firstAt: 0 };
                    return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
                }
                if (confirm === 'ambiguous') {
                    mgr.logger?.log?.(
                        `[SYNC] Suspect empty read confirm re-read ambiguous with ${gridOrderIds} grid orderIds — ` +
                        `refusing reconciliation; re-confirming on the next empty read`,
                        'warn'
                    );
                    mgr._suspectEmptyReads = { count: limit, firstAt: suspect.firstAt || Date.now() };
                    return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
                }
                // 'confirmed' (still empty on re-read) or 'unavailable' (no
                // chain identity / dry-run — legacy count-based acceptance,
                // preserving unit-test semantics): reconcile to empty.
                mgr.logger?.log?.(
                    `[SYNC] Empty read confirmed after ${suspect.count} consecutive attempts` +
                    (confirm === 'unavailable' ? ' (no chain identity for confirm re-read)' : ' (+ confirming re-read)') +
                    ` — reconciling to empty account`,
                    'warn'
                );
                mgr._suspectEmptyReads = { count: 0, firstAt: 0 };
            } else {
                mgr._suspectEmptyReads = { count: 0, firstAt: 0 };
            }
        } else {
            mgr._suspectEmptyReads = { count: 0, firstAt: 0 };
        }

        // Collect all order IDs that might be modified during reconciliation
        // Lock them to prevent concurrent modifications from createOrder/cancelOrder
        const orderIdsToLock = new Set<string>();
        for (const gridOrder of mgr.orders.values()) {
            // Lock any order with a chain orderId (already on-chain)
            if (gridOrder.orderId) {
                orderIdsToLock.add(gridOrder.id);
                orderIdsToLock.add(gridOrder.orderId);
            }
            // Also lock ACTIVE/PARTIAL orders that might transition to/from SPREAD
            if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                orderIdsToLock.add(gridOrder.id);
            }
        }

        // Collection and locking are synchronous (no await in between), so no
        // order can disappear here — lock the whole collected set. Both slot
        // ids and chain order ids are kept: they are aliases of the same order.
        // The old re-verification validated chain ids with
        // mgr.orders.has(chainId), which never matches (chain ids are values,
        // not keys) and logged every placed order as "disappeared between
        // collection and locking" (~40 false lines per sync).
        const orderIdsToLockFinal = [...orderIdsToLock];

        const chainOrderIdsOnGrid = new Set<string>();
        const matchedGridOrderIds = new Set<string>();
        const filledOrders: ManagedOrder[] = [];
        const updatedOrders: ManagedOrder[] = [];
        const ordersNeedingCorrection: PendingPriceCorrection[] = [];
        const unmatchedChainOrders: UnmatchedChainOrder[] = [];

        // Lock orders before reconciliation
        mgr.lockOrders(orderIdsToLockFinal);

        // Keep lock leases alive during long reconciliation runs.
        const refreshEveryMs = Math.max(TIMING.LOCK_REFRESH_MIN_MS, Math.floor(TIMING.LOCK_TIMEOUT_MS / 3));
        const refreshLockLeases = () => {
            const expiresAt = Date.now() + TIMING.LOCK_TIMEOUT_MS;
            for (const id of orderIdsToLockFinal) {
                mgr.shadowOrderIds.set(id, expiresAt);
            }
            mgr.logger?.log?.(`Refreshed lock leases for ${orderIdsToLockFinal.length} orders`, 'debug');
        };

        refreshLockLeases();
        const lockRefreshTimer = setInterval(refreshLockLeases, refreshEveryMs);

        try {
            const runReconciliation = async () => {
                mgr.pauseFundRecalc();
                try {
                    await this._performSyncFromOpenOrders(
                        mgr,
                        assetAPrecision,
                        assetBPrecision,
                        parsedChainOrders,
                        rawChainOrders,
                        chainOrderIdsOnGrid,
                        matchedGridOrderIds,
                        filledOrders,
                        updatedOrders,
                        ordersNeedingCorrection,
                        unmatchedChainOrders,
                        options
                    );
                } finally {
                    await mgr.resumeFundRecalc();
                }
            };

            await mgr._gridLock.acquire(runReconciliation);
        } finally {
            clearInterval(lockRefreshTimer);
            // Unlock after reconciliation completes
            mgr.unlockOrders(orderIdsToLockFinal);
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection, unmatchedChainOrders };
    }

    /**
     * Internal two-pass reconciliation with locks already held.
     * @param {Object} mgr - OrderManager instance
     * @param {number} assetAPrecision - Asset A precision
     * @param {number} assetBPrecision - Asset B precision
     * @param {Map<string, any>} parsedChainOrders - Parsed chain orders by ID
     * @param {Map<string, Object>} rawChainOrders - Raw blockchain order objects by ID
     * @param {Set<string>} chainOrderIdsOnGrid - Output set: chain order IDs matched to grid
     * @param {Set<string>} matchedGridOrderIds - Output set: grid order IDs matched to chain
     * @param {Array<Object>} filledOrders - Output array: orders detected as filled
     * @param {Array<Object>} updatedOrders - Output array: orders updated during sync
     * @param {Array<Object>} ordersNeedingCorrection - Output array: orders flagged for price correction
     * @param {Array<Object>} unmatchedChainOrders - Output array: open chain orders with no adoptable grid slot
     * @param {Object} options - Sync options (skipAccounting, etc.)
     * @returns {Promise<any>}
     */
    async _performSyncFromOpenOrders(mgr: OrderManagerLike, assetAPrecision: number, assetBPrecision: number, parsedChainOrders: Map<string, ParsedChainOrder>, rawChainOrders: Map<string, Record<string, unknown>>,
        chainOrderIdsOnGrid: Set<string>, matchedGridOrderIds: Set<string>, filledOrders: ManagedOrder[], updatedOrders: ManagedOrder[], ordersNeedingCorrection: PendingPriceCorrection[], unmatchedChainOrders: UnmatchedChainOrder[], options: Record<string, unknown>) {
        const skipAccounting = (options?.skipAccounting ?? true) as boolean;

        const queueCorrection = (entry: PendingPriceCorrection) => {
            // Provenance: classify the detector so a stale replay at drain
            // time logs who queued it and when. Classification from entry
            // flags: cancelOnly orphans vs surplus/type-mismatch cancels vs
            // plain price updates.
            const source = entry?.cancelOnly === true
                ? 'sync-duplicate-orphan'
                : entry?.isSurplus === true
                    ? 'sync-type-mismatch'
                    : 'sync-price-mismatch';
            ordersNeedingCorrection.push(_stampCorrectionProvenance({ ...entry }, source));
            if (!Array.isArray(mgr.ordersNeedingPriceCorrection)) return;

            const existingIndex = mgr.ordersNeedingPriceCorrection.findIndex((queued) =>
                queued?.chainOrderId === entry.chainOrderId && Boolean(queued?.isSurplus) === Boolean(entry.isSurplus)
            );

            if (existingIndex >= 0) {
                // Merge: fresh detection overwrites price/size intent, but
                // first-seen provenance survives (entry without provenance
                // keeps the original queuedAt/queuedBy).
                mgr.ordersNeedingPriceCorrection[existingIndex] = _stampCorrectionProvenance({
                    ...mgr.ordersNeedingPriceCorrection[existingIndex],
                    ...entry
                }, source);
            } else {
                mgr.ordersNeedingPriceCorrection.push(_stampCorrectionProvenance({ ...entry }, source));
            }
        };

        // ====================================================================
        // PASS 1: GRID → CHAIN - Match grid orders to blockchain
        // ====================================================================
        for (const gridOrder of mgr.orders.values()) {

            if (gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) {
                const chainOrder = parsedChainOrders.get(gridOrder.orderId);
                if (!chainOrder) continue;
                let updatedOrder = { ...gridOrder };
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                // Store raw blockchain data in grid slot for later update calculation.
                // Tag the snapshot with `fetchedAt` so the drift check in
                // syncFromFillHistory can distinguish a fresh chain read from a
                // never-synced entry (the latter has no fetchedAt and is treated
                // as if grid-equals-chain, since the cache is just a thin mirror
                // of the grid baseline at this point).
                const rawSnapshot = rawChainOrders.get(gridOrder.orderId);
                updatedOrder.rawOnChain = rawSnapshot
                    ? ({ ...rawSnapshot, fetchedAt: Date.now() } as ManagedOrder['rawOnChain'])
                    : (rawSnapshot as ManagedOrder['rawOnChain']);

                // Side mismatch: keep slot untouched and queue cancellation for stale chain order.
                if (gridOrder.type !== chainOrder.type) {
                    mgr.logger?.log?.(
                        `[SYNC] Type mismatch for ${gridOrder.id}: grid=${gridOrder.type}, chain=${chainOrder.type}. ` +
                        `Queuing stale chain order ${gridOrder.orderId} for cancellation to prevent fund tracking corruption.`,
                        'warn'
                    );
                    queueCorrection({
                        gridOrder: { ...gridOrder },
                        chainOrderId: gridOrder.orderId,
                        expectedPrice: gridOrder.price,
                        actualPrice: chainOrder.price,
                        size: chainOrder.size,
                        type: chainOrder.type,
                        typeMismatch: true,
                        isSurplus: true,
                        sideUpdated: chainOrder.type
                    });
                    continue;
                } else {
                    // "Did the chain order move?" is level identity: both prices
                    // must map to the same slot (see chainPriceOnSameLevel). A
                    // drift of a few quanta inside one level is normal and must
                    // not queue a price correction.
                    const precision = gridOrder.type === ORDER_TYPES.SELL ? assetAPrecision : assetBPrecision;
                    const isPriceEqual = chainPriceOnSameLevel(chainOrder.price, gridOrder.price, mgr._genesis, precision, mgr.assets, toFiniteNumber(chainOrder.size), gridOrder.size, gridOrder.type, mgr.config?.incrementPercent);
                    if (!isPriceEqual) {
                        // GAP-EVACUATION PRECEDENCE: classify the order's REAL
                        // chain price against the live band before queueing a
                        // plain price correction. An order whose live price maps
                        // inside the gap band must be cancelled, not "corrected"
                        // back to a stale slot price (the correction would leave
                        // it resting inside the spread). A refused-commit
                        // adoption can leave the local slot id in-rail while the
                        // order actually trades in-band.
                        let inBand = false;
                        try {
                            if (Array.isArray(mgr._genesis?.priceLevels) && mgr._genesis.priceLevels.length > 0) {
                            const liveIdx = Number(slotIndexForPrice(chainOrder.price, mgr._genesis as GridGenesis));
                            inBand = Number.isFinite(liveIdx) && liveIdx >= 0
                                && geometryTypeForSlotIndex(liveIdx, mgr.boundaryIdx, mgr._gapSlots) === ORDER_TYPES.SPREAD;
                            }
                        } catch { inBand = false; }
                        if (inBand) {
                            // Drop an opposite-kind queued entry for the same
                            // chain order so the cancel and a price update cannot
                            // both drain.
                            if (Array.isArray(mgr.ordersNeedingPriceCorrection)) {
                                for (let i = mgr.ordersNeedingPriceCorrection.length - 1; i >= 0; i--) {
                                    const queued = mgr.ordersNeedingPriceCorrection[i];
                                    if (queued?.chainOrderId === gridOrder.orderId && queued.isSurplus !== true) {
                                        mgr.ordersNeedingPriceCorrection.splice(i, 1);
                                    }
                                }
                            }
                            queueCorrection({
                                gridOrder: { ...gridOrder },
                                chainOrderId: gridOrder.orderId,
                                expectedPrice: gridOrder.price,
                                actualPrice: chainOrder.price,
                                size: chainOrder.size,
                                type: chainOrder.type,
                                isSurplus: true,
                                gapEvacuation: true,
                                boundaryIdx: mgr.boundaryIdx
                            });
                            mgr.logger?.log?.(
                                `[SYNC] Gap-evacuation queued for ${gridOrder.orderId} (slot ${gridOrder.id}): ` +
                                `live price ${Format.formatPrice6(Number(chainOrder.price))} maps inside the gap band ` +
                                `(boundary ${mgr.boundaryIdx}, gap ${mgr._gapSlots}) — cancelling instead of re-pricing`,
                                'warn'
                            );
                        } else {
                            queueCorrection({
                                gridOrder: { ...gridOrder },
                                chainOrderId: gridOrder.orderId,
                                expectedPrice: gridOrder.price,
                                actualPrice: chainOrder.price,
                                size: chainOrder.size,
                                type: gridOrder.type
                            });
                        }
                    }
                }

                // Chain side determines which precision applies to for_sale.
                const precision = (chainOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const currentSizeInt = floatToBlockchainInt(gridOrder.size, precision);
                const chainSizeInt = floatToBlockchainInt(chainOrder.size, precision);

                if (currentSizeInt !== chainSizeInt) {
                    // SIZE-CONSISTENCY TIEBREAK (mis-tracked duplicate): the
                    // tracked order's chain size disagrees with the slot's
                    // booked remaining size. Before adopting the chain size,
                    // check whether ANOTHER chain order at this price level
                    // matches the booked size exactly. The grid allows at most
                    // one order per level, so a second order whose size equals
                    // the booked remaining means the slot's orderId was
                    // mis-assigned (duplicate-price order created by a stale
                    // rebuild racing the fill booking) and the real order is
                    // the other one. Rebind the slot to it; the previously
                    // tracked order falls through to pass 2 as a duplicate-
                    // price orphan and is queued for cancellation there.
                    let swapMatch: { id: string; order: ParsedChainOrder } | null = null;
                    if (currentSizeInt > 0) {
                        for (const [candidateId, candidateOrder] of parsedChainOrders) {
                            if (candidateId === gridOrder.orderId) continue;
                            if (chainOrderIdsOnGrid.has(candidateId)) continue;
                            if (!candidateOrder || candidateOrder.type !== chainOrder.type) continue;
                            // Price check: the candidate must belong to the same
                            // ladder level as the slot (the swap tiebreak's whole
                            // premise — a duplicate at this level).
                            const precision = gridOrder.type === ORDER_TYPES.SELL ? assetAPrecision : assetBPrecision;
                            if (!chainPriceOnSameLevel(candidateOrder.price, gridOrder.price, mgr._genesis, precision, mgr.assets, toFiniteNumber(candidateOrder.size), gridOrder.size, gridOrder.type, mgr.config?.incrementPercent)) continue;
                            if (floatToBlockchainInt(candidateOrder.size, precision) !== currentSizeInt) continue;
                            swapMatch = { id: candidateId, order: candidateOrder };
                            break;
                        }
                    }
                    if (swapMatch) {
                        const swapRaw = rawChainOrders.get(swapMatch.id);
                        const reboundOrder: ManagedOrder = {
                            ...gridOrder,
                            orderId: swapMatch.id,
                            rawOnChain: swapRaw
                                ? ({ ...swapRaw, fetchedAt: Date.now() } as ManagedOrder['rawOnChain'])
                                : gridOrder.rawOnChain,
                        };
                        // Restore fee lifecycle / partial-fill evidence from the
                        // adopted order's deferred_fee (same convention as the
                        // pass-2 adoption path below: deferred_fee > 0 → fee
                        // state; deferred_fee === 0 with for_sale > 0 → the
                        // order was partially filled).
                        const reboundRaw = reboundOrder.rawOnChain as Record<string, unknown> | null | undefined;
                        const rawDeferredFee = toFiniteNumber(reboundRaw?.deferred_fee, null);
                        if (rawDeferredFee !== null && rawDeferredFee > 0) {
                            reboundOrder.btsFeeState = { deferredFee: blockchainToFloat(rawDeferredFee, BTS_PRECISION) };
                        } else if (rawDeferredFee !== null && rawDeferredFee <= 0
                            && toFiniteNumber(reboundRaw?.for_sale, 0) > 0) {
                            reboundOrder.state = ORDER_STATES.PARTIAL;
                        }
                        const applied = await mgr._applyOrderUpdate(reboundOrder, 'sync-pass1-duplicate-swap', { skipAccounting: skipAccounting, fee: 0 });
                        if (applied === false) {
                            // Rejected rebind: the slot keeps its old binding
                            // (set ops must run only after the apply lands), so
                            // the old orderId stays matched on-grid and the swap
                            // candidate stays unmatched → pass 2 cancels it.
                            mgr.logger?.log?.(
                                `[SYNC] Size tiebreak for ${gridOrder.id}: rebind to ${swapMatch.id} rejected — slot keeps ${gridOrder.orderId}; duplicate falls to pass 2`,
                                'warn'
                            );
                            continue;
                        }
                        chainOrderIdsOnGrid.delete(gridOrder.orderId);
                        chainOrderIdsOnGrid.add(swapMatch.id);
                        updatedOrders.push(reboundOrder);
                        mgr.logger?.log?.(
                            `[SYNC] Size tiebreak for ${gridOrder.id}: tracked order ${gridOrder.orderId} ` +
                            `(chain size ${chainOrder.size}) disagrees with booked size ${gridOrder.size}, but ` +
                            `duplicate-price order ${swapMatch.id} (chain size ${swapMatch.order.size}) matches ` +
                            `it exactly — rebinding slot to ${swapMatch.id}; ${gridOrder.orderId} falls through ` +
                            `to pass 2 as a duplicate-price orphan (queued for cancellation).`,
                            'warn'
                        );
                        continue;
                    }
                    const newSize = blockchainToFloat(chainSizeInt, precision);
                    const newInt = floatToBlockchainInt(newSize, precision);

                    if (newInt > 0) {
                        const nextOrder = await applyChainSizeToGridOrder(mgr, updatedOrder, newSize);
                        if (nextOrder) {
                            // Merge updated state if size actually changed
                            updatedOrder = { ...updatedOrder, ...nextOrder };
                        }
                        // Transition to PARTIAL when chain size < grid size (partial fill).
                        // Real-time fill events set this via syncFromFillHistory, but
                        // downtime fills detected during open-orders sync must also update
                        // state so that checkWindowDust can identify dust orders.
                        updatedOrder.state = (chainSizeInt < currentSizeInt)
                            ? ORDER_STATES.PARTIAL
                            : gridOrder.state;
                        const partialApplied = await mgr._applyOrderUpdate(updatedOrder, 'sync-pass1-partial', { skipAccounting: skipAccounting, fee: 0 });
                        if (partialApplied === false) {
                            // Rejected resize: the slot keeps its booked size;
                            // divergence re-detects on the next sync.
                            mgr.logger?.log?.(
                                `[SYNC] Partial-size update for ${gridOrder.id} rejected — slot keeps booked size ${gridOrder.size}`,
                                'warn'
                            );
                        }
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                        const filledApplied = await mgr._applyOrderUpdate(spreadOrder, 'sync-pass1-filled', { skipAccounting: skipAccounting, fee: 0 });
                        if (filledApplied === false) {
                            // Rejected virtualization must not book a fill:
                            // neither the filled order nor the placeholder
                            // update leaves this path.
                            mgr.logger?.log?.(
                                `[SYNC] Filled virtualization for ${gridOrder.id} rejected — fill NOT booked`,
                                'error'
                            );
                            continue;
                        }
                        // Push the filled order with its REAL side (chain order
                        // type), not the SPREAD placeholder: downstream fill
                        // processing (deriveTargetBoundary) derives boundary
                        // movement from fill.type, and a SPREAD type would
                        // silently drop the shift for this completed order.
                        filledOrders.push({ ...gridOrder, type: chainOrder.type, price: toFiniteNumber(chainOrder.price, gridOrder.price) });
                        updatedOrders.push(spreadOrder);
                    }
                }
            } else if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                // Don't virtualize orders placed by a successful COW commit.
                // The chain snapshot may lag behind confirmed transactions,
                // causing correctly-placed orders to appear missing. _committedOrderIds
                // is atomically rebuilt from every successful COW commit
                // (manager.ts:_commitWorkingGrid) and is always active for all sync
                // paths.
                // filled/virtualized orders are absent from the next commit's
                // finalMap, so their IDs drop out on the next atomic rebuild.
                //
                // SAFETY: _committedOrderIds is replaced atomically (reference swap)
                // by _commitWorkingGrid. The sync reads has(gridOrder.orderId) against the
                // current reference. If a concurrent COW commit replaces the set mid-sync,
                // the new set is a superset (only adds entries for newly committed orders).
                // An order in the superset was just committed, so it is genuinely on-chain
                // and should not be virtualized. An order removed from the old set was
                // filled/virtualized, which the sync will detect independently via the
                // chain snapshot. Superset behavior is safe for this guard.
                //
                // ESCAPE HATCH 1 — Ghost orders (PARTIAL + size=0): These preserve the
                // original orderId only to block duplicate CREATEs after a full fill
                // that the chain hasn't closed yet. The orderId is in _committedOrderIds
                // because the original order was COW-placed, but the slot is already a
                // known fill. Allow phantom detection to proceed so the ghost is cleaned
                // up on the next sync cycle after the chain cancel succeeds.
                //
                // ESCAPE HATCH 2 — Time-based: If the most recent COW commit is older
                // than SYNC_LOCK_TIMEOUT_MS, the committed-but-missing order is
                // presumed genuinely filled. The chain should have confirmed or
                // rejected the transaction within the sync timeout window (~7 blocks
                // at 3s each). Prevents permanent stall when a fill event was missed
                // (reconnect gap, lossy subscription) and the only detection path is
                // this open-orders sync.
                if (gridOrder.orderId != null && mgr._committedOrderIds?.has(gridOrder.orderId)) {
                    const commitAge = Date.now() - (mgr._committedOrderIdsBuiltAt || 0);
                    const isGhost = gridOrder.size <= 0 && gridOrder.state === ORDER_STATES.PARTIAL;
                    if (!isGhost && commitAge < TIMING.SYNC_LOCK_TIMEOUT_MS) {
                        continue;
                    }
                }
                const currentGridOrder = mgr.orders.get(gridOrder.id) || gridOrder;
                const hadOrderId = Boolean(currentGridOrder?.orderId);
                const spreadOrder = convertToSpreadPlaceholder(currentGridOrder);
                const phantomApplied = await mgr._applyOrderUpdate(spreadOrder, 'sync-cleanup-phantom', { skipAccounting: skipAccounting, fee: 0 });
                if (phantomApplied === false) {
                    // Rejected virtualization books no phantom fill: the slot
                    // keeps its order and the disappearance re-detects next
                    // sync.
                    mgr.logger?.log?.(
                        `[SYNC] Phantom cleanup for ${gridOrder.id} rejected — fill NOT booked`,
                        'warn'
                    );
                    continue;
                }

                // Only genuine disappearances (had orderId) count as fills.
                if (hadOrderId) {
                    // A SPREAD slot can carry an on-chain order (spread-correction
                    // activation). Resolve the real side before pushing: the fill
                    // drives deriveTargetBoundary, which only shifts on BUY/SELL —
                    // a SPREAD-typed fill would silently drop the boundary crawl
                    // for this completed order. Same price-vs-startPrice convention
                    // as the funds check (manager.ts) since no chain order remains
                    // to resolve the side from.
                    let resolvedType = currentGridOrder.type;
                    if (resolvedType === ORDER_TYPES.SPREAD) {
                        resolvedType = resolveSpreadOrderSide(currentGridOrder.price, mgr.config.startPrice);
                    }
                    const liveChainPrice = (() => {
                        const raw = currentGridOrder?.rawOnChain;
                        if (!raw) return null;
                        try {
                            const parsed = parseChainOrder(raw as unknown as ChainOrder, mgr.assets);
                            if (!parsed) return null;
                            if (currentGridOrder.orderId && parsed.orderId !== currentGridOrder.orderId) return null;
                            return Number.isFinite(Number(parsed.price)) && Number(parsed.price) > 0 ? Number(parsed.price) : null;
                        } catch { return null; }
                    })();
                    filledOrders.push({
                        ...currentGridOrder,
                        type: resolvedType,
                        ...(liveChainPrice != null ? { price: liveChainPrice } : {})
                    });
                }
            }
        }

        // ====================================================================
        // PASS 2: CHAIN → GRID - Nearest-slot deterministic adoption (genesis-frozen)
        // ====================================================================
        const genesis = mgr._genesis;
        const genesisLadder = genesis as Parameters<typeof slotIndexForPrice>[1];
        // Genesis is mandatory for any populated grid, but an EMPTY grid
        // (slotCount 0) passes the E2 gate without a ladder, so the
        // `!hasGenesis` branch below is reachable when live chain orders exist
        // against no slots. There the anchor is meaningless and only orders the
        // deferred holds (every price is measured against 0, i.e. ascending).
        const hasGenesis = hasGenesisLadder(genesis);
        const anchorPrice = hasGenesis ? (genesis?.startPrice ?? 0) : 0;
        const sortedChainEntries = [...parsedChainOrders.entries()].sort((a, b) => {
            const pa = toFiniteNumber(a[1].price);
            const pb = toFiniteNumber(b[1].price);
            const da = Number.isFinite(pa) && Number.isFinite(anchorPrice) ? Math.abs(pa - anchorPrice) : Infinity;
            const db = Number.isFinite(pb) && Number.isFinite(anchorPrice) ? Math.abs(pb - anchorPrice) : Infinity;
            return da - db;
        });
        for (const [chainOrderId, chainOrder] of sortedChainEntries) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue;

            // Genesis is mandatory (INV-GRID-004): the frozen ladder is the single
            // authority for which slot a chain order belongs to. No tolerance
            // matcher remains — the E2 gate refuses to sync a ladder-less grid and
            // loadGrid cannot produce one — so this guard is defence in depth
            // against a future bypass, not a supported state. A chain order is
            // never price-matched into a slot.
            if (!hasGenesis) {
                // No candidateSlotId: without a ladder no slot index can be
                // derived, so there is nothing meaningful to name (unlike the
                // out-of-grid / rail holds, which have a resolved nearest slot).
                unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'no-genesis-deferred' });
                mgr.logger?.log?.(
                    `[SYNC] Orphaned chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, size=${chainOrder.size}) — NOT adopted: the grid has no price ladder (INV-GRID-004); deferred, never price-matched`,
                    'error'
                );
                continue;
            }
            let idx: number;
            try { idx = slotIndexForPrice(chainOrder.price, genesisLadder); } catch {
                unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'no-available-nearest-slot' });
                queueCorrection({ gridOrder: { id: `slot-unknown-${chainOrderId}`, type: chainOrder.type } as unknown as ManagedOrder, chainOrderId, expectedPrice: chainOrder.price, size: chainOrder.size, type: chainOrder.type, isSurplus: true, cancelOnly: true });
                continue;
            }
            const slotId = `slot-${idx}`;
            // Out-of-grid hold: slotIndexForPrice clamps below/above-rail
            // prices onto the edge slots (0/N-1), so the clamp is not a
            // real match. A below-grid buy is not slot-0 and an
            // above-grid sell is not slot-(N-1): never adopt into the
            // rail slot and never cancel as its duplicate — hold/defer
            // (no adopt, no cancelOnly), e.g. dip-protection levels
            // sitting below a fresh grid after a reset.
            {
                if (isChainPriceOutOfGrid(chainOrder.price, genesisLadder, toFiniteNumber(chainOrder.size), chainOrder.type, mgr.assets)) {
                    unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'out-of-grid-deferred', candidateSlotId: slotId });
                    mgr.logger?.log?.(`[SYNC] Orphaned chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, size=${chainOrder.size}) — NOT adopted: price outside grid range, deferred (nearest slot ${slotId})`, 'warn');
                    continue;
                }
            }
            const gapSlots = genesis?.gapSlots ?? mgr._gapSlots ?? 0;
            const boundaryIdx = mgr.boundaryIdx;
            // Pre-boundary sync: gap geometry is unknown, so adoption is
            // deferred entirely — touch nothing (no adopt, no cancelOnly).
            // The orphan stays visible to the crossing guards and the
            // validate orphan layer via _lastUnmatchedChainOrders and is
            // re-evaluated once the boundary commits. Accepted cost: a
            // legitimate in-rail orphan waits one sync cycle
            // post-boundary-commit before adoption. Strictly better than
            // adopting a gap stray into the wrong slot.
            // '' guard: Number('') === 0 is finite, so an empty-string
            // boundary would read as boundary 0 (same trap guarded in
            // runPreBroadcastGuards / resolveGapBand).
            if (boundaryIdx == null || (boundaryIdx as unknown) === '' || !Number.isFinite(Number(boundaryIdx))) {
                unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'boundary-unknown-deferred', candidateSlotId: slotId });
                mgr.logger?.log?.(`[SYNC] Orphaned chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, size=${chainOrder.size}) — NOT adopted: boundary unknown, deferred until boundary commits (nearest slot ${slotId})`, 'warn');
                continue;
            }
            // Duplicate-price guard becomes slotId equality: if placed order already occupies this slot
            const occupying = mgr.orders.get(slotId);
            if (occupying && isOrderPlaced(occupying) && occupying.type === chainOrder.type) {
                unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'duplicate-price-level', candidateSlotId: slotId });
                const { level, suffix } = duplicateOrphanLogInfo(chainOrderId);
                mgr.logger?.log?.(`[SYNC] Orphaned chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, size=${chainOrder.size}) — NOT adopted: duplicates slot ${slotId} (${occupying.orderId})${suffix}`, level);
                queueCorrection({ gridOrder: occupying, chainOrderId, expectedPrice: chainOrder.price, size: chainOrder.size, type: chainOrder.type, isSurplus: true, cancelOnly: true });
                continue;
            }
            // Gap exclusion: nearest slot in SPREAD gap → no adopt (boundary
            // is known here — the pre-boundary case continued above).
            {
                const inRail = isSlotInRail(boundaryIdx, gapSlots, chainOrder.type, { id: slotId });
                if (!inRail) {
                    unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'no-available-nearest-slot', candidateSlotId: slotId });
                    queueCorrection({ gridOrder: { id: slotId, type: chainOrder.type } as unknown as ManagedOrder, chainOrderId, expectedPrice: chainOrder.price, size: chainOrder.size, type: chainOrder.type, isSurplus: true, cancelOnly: true });
                    continue;
                }
            }
            const slot = mgr.orders.get(slotId);
            if (!slot || matchedGridOrderIds.has(slot.id) || slot.orderId) {
                unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'no-available-nearest-slot', candidateSlotId: slotId });
                const diag = describeNearestAdoptionCandidates(mgr, chainOrder, (chainOrder.type === ORDER_TYPES.SELL ? assetAPrecision : assetBPrecision), matchedGridOrderIds);
                mgr.logger?.log?.(`[SYNC] Unmatched chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, size=${chainOrder.size}): nearest slot ${slotId} not adoptable. Nearest candidates: ${diag}`, 'warn');
                continue;
            }
            const typeCompat = slot.type === chainOrder.type || slot.type === ORDER_TYPES.SPREAD;
            if (!typeCompat) {
                unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'no-available-nearest-slot', candidateSlotId: slotId });
                continue;
            }
            const adopted = await adoptChainOrderIntoSlot(mgr, slot, chainOrder, chainOrderId, rawChainOrders, matchedGridOrderIds, chainOrderIdsOnGrid, filledOrders, updatedOrders, skipAccounting);
            if (!adopted) {
                // Order update was rejected (fatal validation) — the chain
                // order stays untracked and must not dangle on the book.
                unmatchedChainOrders.push({ chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size, raw: rawChainOrders.get(chainOrderId), reason: 'adoption-rejected', candidateSlotId: slotId });
                queueCorrection({ gridOrder: slot, chainOrderId, expectedPrice: chainOrder.price, size: chainOrder.size, type: chainOrder.type, isSurplus: true, cancelOnly: true });
                mgr.logger?.log?.(`[SYNC] Chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}) NOT adopted into slot ${slotId}: order update rejected — queued for cancellation`, 'error');
            }
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection, unmatchedChainOrders };
    }

    // ------------------------------------------------------------------
    // Shared fill-processing helpers (used by syncFromFillHistory and
    // syncFromFillHistoryBatch)
    // ------------------------------------------------------------------

    _findMatchingGridOrder(mgr: OrderManagerLike, orderId: string | null | undefined): ManagedOrder | null {
        for (const gridOrder of mgr.orders.values()) {
            if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                return gridOrder;
            }
        }
        return null;
    }

    _computeFillContext(mgr: OrderManagerLike, matchedGridOrder: ManagedOrder, paysAssetId: string | null | undefined, paysAmountRaw: number, receivesAssetId: string | null | undefined = null, receivesAmountRaw: number | null = null) {
        const assets = mgr.assets;
        if (!assets?.assetA || !assets?.assetB) throw new Error('assets required for fill context');
        // A SPREAD slot can carry an on-chain order (e.g. spread-correction
        // activation). Resolve the real side from the fill's pays asset so the
        // transition result is BUY/SELL — never SPREAD with an on-chain state,
        // which validateOrder rejects as fatal ILLEGAL_SPREAD_STATE. When the
        // pays asset matches neither side (malformed fill event), fall back to
        // the price-vs-startPrice convention so the type can never leak SPREAD
        // into a fill result (which would drop the boundary shift downstream).
        let orderType: OrderType = matchedGridOrder.type;
        if (orderType === ORDER_TYPES.SPREAD) {
            if (paysAssetId === assets.assetB.id) orderType = ORDER_TYPES.BUY;
            else if (paysAssetId === assets.assetA.id) orderType = ORDER_TYPES.SELL;
            else orderType = resolveSpreadOrderSide(matchedGridOrder.price, mgr.config.startPrice) as OrderType;
        }
        const currentSize = toFiniteNumber(matchedGridOrder.size);
        const precision = (orderType === ORDER_TYPES.SELL) ? assets.assetA.precision : assets.assetB.precision;

        let filledAmount = 0;
        if (orderType === ORDER_TYPES.SELL) {
            if (paysAssetId === assets.assetA.id) filledAmount = blockchainToFloat(paysAmountRaw, precision);
        } else {
            if (paysAssetId === assets.assetB.id) filledAmount = blockchainToFloat(paysAmountRaw, precision);
        }

        const currentSizeIntFromGrid = floatToBlockchainInt(currentSize, precision);
        const rawForSale = matchedGridOrder?.rawOnChain?.for_sale;
        const rawForSaleInt = rawForSale !== undefined && rawForSale !== null ? toFiniteNumber(rawForSale) : NaN;
        const driftSignal = Number.isFinite(rawForSaleInt) && Math.round(rawForSaleInt) < currentSizeIntFromGrid;

        // Execution price from the actual paid/received amounts (quote per
        // base). This is the fill FACT the last-fill pivot and the re-anchor
        // need; the slot price is only a grid identity and may be stale after
        // a refused-commit chain adoption.
        let fillPrice: number | null = null;
        if (Number.isFinite(Number(receivesAmountRaw)) && Number(receivesAmountRaw) > 0
            && Number.isFinite(Number(paysAmountRaw)) && Number(paysAmountRaw) > 0) {
            const A = assets.assetA;
            const B = assets.assetB;
            let baseRaw: number | null = null;
            let quoteRaw: number | null = null;
            if (paysAssetId === A.id && receivesAssetId === B.id) {
                baseRaw = Number(paysAmountRaw);
                quoteRaw = Number(receivesAmountRaw);
            } else if (paysAssetId === B.id && receivesAssetId === A.id) {
                baseRaw = Number(receivesAmountRaw);
                quoteRaw = Number(paysAmountRaw);
            }
            if (baseRaw !== null && quoteRaw !== null) {
                const base = blockchainToFloat(baseRaw, A.precision);
                const quote = blockchainToFloat(quoteRaw, B.precision);
                if (base > 0 && quote > 0) {
                    const price = quote / base;
                    if (Number.isFinite(price) && price > 0) fillPrice = price;
                }
            }
        }

        return { orderType, currentSize, precision, filledAmount, currentSizeIntFromGrid, rawForSaleInt, driftSignal, fillPrice };
    }

    async _computeFillTransitionResult(mgr: OrderManagerLike, params: FillTransitionParams) {
        const { matchedGridOrder, orderType, precision, filledAmount, filledAmountInt, currentSizeIntFromGrid, chainRefetched, chainConfirmsEmpty, effectiveRawForSale, blockNum, historyId, isMaker, fillPrice } = params;
        // Fill price provenance: prefer the real execution price, fall back to
        // the slot level only when no chain price/amounts are available.
        const resolvedFillPrice = Number.isFinite(Number(fillPrice)) && Number(fillPrice) > 0
            ? Number(fillPrice)
            : matchedGridOrder.price;

        let resolvedChainConfirmsEmpty = chainConfirmsEmpty;
        if (chainRefetched && Number.isFinite(effectiveRawForSale) && Math.round(effectiveRawForSale) <= 0) {
            resolvedChainConfirmsEmpty = true;
        }

        const currentSizeInt = Number.isFinite(effectiveRawForSale)
            ? Math.max(0, Math.round(effectiveRawForSale))
            : currentSizeIntFromGrid;
        const newSizeInt = Math.max(0, currentSizeInt - filledAmountInt);
        const newSize = blockchainToFloat(newSizeInt, precision);

        if (Number.isFinite(effectiveRawForSale) && currentSizeInt !== currentSizeIntFromGrid) {
            mgr.logger.log(
                `[SYNC] Using rawOnChain.for_sale baseline for ${matchedGridOrder.orderId}: raw=${currentSizeInt}, grid=${currentSizeIntFromGrid}` +
                (chainRefetched ? ' (refetched)' : ''),
                'debug'
            );
        }

        const gridAlsoEmpty = currentSizeIntFromGrid <= 0;
        let isEffectivelyFull = resolvedChainConfirmsEmpty || gridAlsoEmpty;

        // If the chain retains a real residual order after this fill, the bot
        // must cancel it explicitly. The chain only auto-culls ("culls small")
        // an order when its residual value in the QUOTE asset truncates to 0
        // (amount_to_receive() == 0, i.e. for_sale × price == 0 in quote units,
        // see maybe_cull_small_order in bitshares-core). A residual of >= 1 base
        // unit whose quote value is non-zero is NOT culled — it would be
        // orphaned on-chain once the slot is converted to a SPREAD placeholder.
        // Verified fills stay authoritative (rotation proceeds), but the leftover
        // dust is handled by an explicit cancel rather than trusting the chain to
        // sweep it.
        let residualCancel: { orderId: string | null; id: string } | null = null;

        if (!isEffectivelyFull) {
            const assets = mgr.assets!;
            const otherPrecision = (orderType === ORDER_TYPES.SELL) ? assets.assetB.precision : assets.assetA.precision;
            const otherSidePrice = matchedGridOrder.price;
            const otherSize = (orderType === ORDER_TYPES.SELL) ? newSize * otherSidePrice : newSize / otherSidePrice;

            if (floatToBlockchainInt(otherSize, otherPrecision) <= 0) {
                // A fill event is authoritative: the order WAS on-chain and this
                // fill consumed the tradeable remainder. A fill is a fill — we do
                // not need to preserve the orderId as a "ghost" PARTIAL to block
                // a duplicate CREATE. Treating every sub-dust other-side fill as
                // a real full fill lets rotation immediately plan the opposite-side
                // replacement, preserving the grid invariant (each filled side
                // produces a new order on the other side). This replaces the legacy
                // ghost mechanism whose preserved orderIds caused instantly-filled
                // replacement orders to deadlock the COW create pipeline.
                //
                // However, the chain does NOT reliably cull the leftover residual:
                // maybe_cull_small_order only removes an order whose QUOTE-side
                // value rounds to zero. Verify the order against the chain; if it
                // still exists with for_sale > 0, schedule an explicit cancel so
                // the dust is not stranded on the book (previously it could remain
                // forever because the slot was virtualized and nothing referenced
                // the orderId anymore).
                isEffectivelyFull = true;
                // Reuse a drift-refetch result when present: it is a live
                // post-fill read, so for_sale > 0 already proves a real residual
                // remains. Avoids a second RPC for the same order in the exact
                // scenario that triggered this branch.
                let residualForSale: number | null = null;
                if (chainRefetched && Number.isFinite(effectiveRawForSale)) {
                    residualForSale = Math.round(effectiveRawForSale);
                } else {
                    try {
                        const residualOrder = await readSingleOrderSeam(mgr, matchedGridOrder.orderId ?? '', 3000);
                        residualForSale = residualOrder ? toFiniteNumber((residualOrder as { for_sale?: number }).for_sale, null) : null;
                    } catch (residualErr) {
                        // The read is best-effort: if it fails, fall back to the old
                        // behavior (rely on reconciliation) rather than blocking the
                        // authoritative fill transition.
                        mgr.logger.log(
                            `[SYNC] Order ${matchedGridOrder.orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. ` +
                            `Fill is authoritative: treating as full fill for rotation. Residual verification read failed (${getErrorMessage(residualErr)}); ` +
                            `relying on reconciliation for residuals.`,
                            'warn'
                        );
                    }
                }
                if (Number.isFinite(residualForSale) && Math.round(residualForSale as number) > 0) {
                    residualCancel = { orderId: matchedGridOrder.orderId, id: matchedGridOrder.id };
                    mgr.logger.log(
                        `[SYNC] Order ${matchedGridOrder.orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. ` +
                        `Fill is authoritative: treating as full fill for rotation, but chain still holds residual for_sale=${residualForSale} ` +
                        `(not culled); scheduling explicit cancel.`,
                        'warn'
                    );
                } else {
                    mgr.logger.log(
                        `[SYNC] Order ${matchedGridOrder.orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. ` +
                        `Fill is authoritative: treating as full fill for rotation; chain confirms residual gone (for_sale=0), no cancel needed.`,
                        'info'
                    );
                }
            }
        }

        let fullUpdate: ManagedOrder | undefined;
        let partialUpdate: ManagedOrder | undefined;
        let filledOrderResult: ManagedOrder & { blockNum?: number; historyId?: string; isMaker?: boolean };

        if (isEffectivelyFull) {
            fullUpdate = convertToSpreadPlaceholder(matchedGridOrder);
            filledOrderResult = {
                ...matchedGridOrder,
                type: orderType,
                price: resolvedFillPrice,
                blockNum,
                historyId,
                isMaker
            };
        } else {
            filledOrderResult = {
                ...matchedGridOrder,
                type: orderType,
                price: resolvedFillPrice,
                size: filledAmount,
                isPartial: true,
                blockNum,
                historyId,
                isMaker
            };
            const { btsFeeState, ...matchedWithoutDeferredFee } = matchedGridOrder;
            let updatedOrder: ManagedOrder = { ...matchedWithoutDeferredFee, type: orderType, state: ORDER_STATES.PARTIAL };

            if (updatedOrder.rawOnChain && updatedOrder.rawOnChain.for_sale !== undefined) {
                const baselineForSale = (chainRefetched && Number.isFinite(effectiveRawForSale))
                    ? effectiveRawForSale
                    : toFiniteNumber(updatedOrder.rawOnChain.for_sale);
                const nextForSaleInt = Math.max(0, Math.round(baselineForSale) - filledAmountInt);
                updatedOrder.rawOnChain = {
                    ...updatedOrder.rawOnChain,
                    for_sale: String(nextForSaleInt),
                    fetchedAt: Date.now()
                };
            }

            const nextOrder = await applyChainSizeToGridOrder(mgr, updatedOrder, newSize);
            if (nextOrder) {
                updatedOrder = { ...updatedOrder, ...nextOrder };
            }
            partialUpdate = updatedOrder;
        }

        return {
            isFull: isEffectivelyFull,
            filledOrder: filledOrderResult,
            fullUpdate,
            partialUpdate,
            newSize,
            residualCancel
        };
    }

    /**
     * Process one incremental fill-history event.
     * @param {Object} fill - Fill history event object
     * @param {Object} [options] - Persistence mode options
     * @returns {Promise<any>}
     */
    async syncFromFillHistory(fill: SyncFillEvent, options: Record<string, unknown> = {}) {
        const mgr = this.manager;
        const persistenceMode = resolveProcessedFillPersistenceMode(options);
        if (!fill || !fill.op || !fill.op[1]) return { filledOrders: [], updatedOrders: [], partialFill: false };

        const fillOp = fill.op[1];
        const blockNum = fill.block_num;
        const historyId = fill.id;
        const orderId = fillOp.order_id;
        if (orderId == null || orderId === '') {
            mgr.logger.log('[SYNC] Fill event missing order_id; deferring to open-orders sync', 'warn');
            return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: true };
        }
        if (fillOp.is_maker === undefined) {
            mgr.logger.log(`[SYNC] is_maker flag missing from fill data for order ${orderId}; defaulting to maker`, 'warn');
        }
        const isMaker = fillOp.is_maker !== false;
        const fillKey = buildFillKey({ orderId, blockNum, historyId });

        const paysAmountRaw = toFiniteNumber(fillOp.pays?.amount);
        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
        const receivesAmountRaw = toFiniteNumber(fillOp.receives?.amount);
        const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;

        mgr.logger.log(`[SYNC] Processing fill ${historyId} at block ${blockNum} for order ${orderId} (maker=${isMaker}). Pays=${paysAmountRaw}@${paysAssetId}, Receives=${receivesAmountRaw}@${receivesAssetId}`, 'debug');

        if (!fillKey) {
            mgr.logger.log(`[SYNC] Missing replay-safe fill key for order ${orderId} block ${blockNum}; deferring to open-orders sync`, 'warn');
            return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: true };
        }

        // Raise the fill-batch in-flight guard BEFORE the accountTotals refresh
        // (mirrors syncFromFillHistoryBatch): the refresh returns post-fill
        // balances while the grid still holds the filled order as committed, so
        // a fund-invariant check in this window would fire a spurious CRITICAL.
        // The guard is lowered before the final consolidated recalc so the
        // settled (re-anchored) state is still verified.
        mgr._fillBatchInFlight = (mgr._fillBatchInFlight ?? 0) + 1;
        let fillGuardLowered = false;

        try {
            const totalsGate = await mgr.refreshAccountTotalsIfStale();
            if (!totalsGate.ok) {
                mgr.logger.log(
                    `[SYNC] Deferring fill ${historyId}: accountTotals refresh failed (stale snapshot). Will be re-processed on the next cycle.`,
                    'warn'
                );
                return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: false, deferred: true };
            }

            const orderIdsToLock = new Set([orderId]);
            mgr.lockOrders([...orderIdsToLock]);

            try {
                mgr.pauseFundRecalc();
                try {
                    const appliedAccounting = await mgr.accountant.processFillAccounting(fillOp, fillKey, { persistenceMode });
                    if (!appliedAccounting) {
                        mgr.logger.log(`[SYNC] Replay detected for fill ${fillKey}; skipping duplicate order mutation`, 'debug');
                        return { filledOrders: [], updatedOrders: [], partialFill: false };
                    }

                    const assetAPrecision = mgr.assets?.assetA?.precision;
                    const assetBPrecision = mgr.assets?.assetB?.precision;
                    if (assetAPrecision === undefined || assetBPrecision === undefined) {
                        mgr.logger?.log?.('Error: manager.assets precision missing in syncFromFillHistory', 'error');
                        return { filledOrders: [], updatedOrders: [], partialFill: false };
                    }

                    const matchedGridOrder = this._findMatchingGridOrder(mgr, orderId);
                    if (!matchedGridOrder) {
                        mgr.logger.log(`[SYNC] Fill for order ${orderId} ignored: order not found in active grid.`, 'debug');
                        return { filledOrders: [], updatedOrders: [], partialFill: false };
                    }

                    const ctx = this._computeFillContext(mgr, matchedGridOrder, paysAssetId, paysAmountRaw, receivesAssetId, receivesAmountRaw);
                    mgr.logger.log(`[SYNC] Order ${orderId} (${ctx.orderType}) currentSize=${ctx.currentSize}, filledAmount=${ctx.filledAmount}`, 'debug');

                    let effectiveRawForSale = ctx.rawForSaleInt;
                    let chainConfirmsEmpty = false;
                    let chainRefetched = false;

                    if (ctx.driftSignal) {
                        try {
                            const fresh = await readSingleOrderSeam(mgr, orderId, 3000);
                            if (fresh) {
                                const freshForSale = toFiniteNumber((fresh as { for_sale?: number }).for_sale, null);
                                if (freshForSale !== null && Number.isFinite(freshForSale)) {
                                    effectiveRawForSale = freshForSale;
                                    chainRefetched = true;
                                    mgr.logger.log(
                                        `[SYNC] Drift detected for ${orderId} (cached=${ctx.rawForSaleInt} < grid=${ctx.currentSizeIntFromGrid}); ` +
                                        `refetched for_sale=${freshForSale}`,
                                        'warn'
                                    );
                                }
                            } else {
                                chainConfirmsEmpty = true;
                                mgr.logger.log(`[SYNC] Drift refetch for ${orderId} returned null; chain confirms empty`, 'info');
                            }
                        } catch (refetchErr) {
                            mgr.logger.log(`[SYNC] Drift refetch for ${orderId} failed; falling back to cache: ${getErrorMessage(refetchErr)}`, 'warn');
                        }
                    }

                    const result = await this._computeFillTransitionResult(mgr, {
                        matchedGridOrder,
                        orderType: ctx.orderType,
                        precision: ctx.precision,
                        filledAmount: ctx.filledAmount,
                        filledAmountInt: floatToBlockchainInt(ctx.filledAmount, ctx.precision),
                        currentSizeIntFromGrid: ctx.currentSizeIntFromGrid,
                        rawForSaleInt: ctx.rawForSaleInt,
                        chainRefetched,
                        chainConfirmsEmpty,
                        effectiveRawForSale,
                        blockNum,
                        historyId,
                        isMaker,
                        fillPrice: ctx.fillPrice
                    });

                    const filledOrders: ManagedOrder[] = [];
                    const updatedOrders: ManagedOrder[] = [];

                if (result.isFull) {
                    mgr.logger.log(`[SYNC] Full fill for order ${orderId} (slot ${matchedGridOrder.id}).`, 'info');
                    const fullOk = await mgr._updateOrder(result.fullUpdate!, 'handle-fill-full', { skipAccounting: false, fee: 0 });
                    if (fullOk === false) {
                        mgr.logger.log(`[SYNC] Failed to convert filled order ${orderId} to spread placeholder; marking totals stale for next sync cycle`, 'warn');
                        mgr.accountTotalsStale = true;
                    }
                    filledOrders.push(result.filledOrder);
                } else {
                    mgr.logger.log(`[SYNC] Partial fill for order ${orderId} (slot ${matchedGridOrder.id}): newSize=${result.newSize}`, 'info');
                    const partialOk = await mgr._updateOrder(result.partialUpdate!, 'handle-fill-partial', { skipAccounting: false, fee: 0 });
                    if (partialOk === false) {
                        mgr.logger.log(`[SYNC] Failed to update partially filled order ${orderId}; marking totals stale for next sync cycle`, 'warn');
                        mgr.accountTotalsStale = true;
                    }
                    updatedOrders.push(result.partialUpdate!);
                    filledOrders.push(result.filledOrder);
                }

                // Re-anchor accountTotals to authoritative post-fill chain truth
                // after the fill's optimistic accounting + grid update (see
                // syncFromFillHistoryBatch for rationale).
                await mgr.reanchorAccountTotals('fill-sync');

                return {
                    filledOrders,
                    updatedOrders,
                    partialFill: result.isFull ? false : true,
                    residualCancels: result.residualCancel ? [result.residualCancel] : []
                };
                } finally {
                    // Lower the guard before the final consolidated recalc so the
                    // settled (re-anchored) state is still verified.
                    fillGuardLowered = true;
                    mgr._fillBatchInFlight = Math.max(0, (mgr._fillBatchInFlight ?? 0) - 1);
                    await mgr.resumeFundRecalc();
                }
            } finally {
                mgr.unlockOrders([...orderIdsToLock]);
            }
        } finally {
            // Safety net: ensure the guard never leaks across cycles on early
            // returns (deferral) or exceptions in the refresh/lock region.
            // Skipped when the inner finally already lowered it for this
            // invocation so concurrent batches cannot zero each other's count.
            if (!fillGuardLowered && (mgr._fillBatchInFlight ?? 0) > 0) mgr._fillBatchInFlight--;
        }
    }

    /**
     * Process multiple fill-history events in a batch, acquiring _gridLock once.
     *
     * Locking: all order IDs locked once up-front; fund recalc paused once.
     *
     * @param {Array} fills - Array of fill history event objects (same block group)
     * @param {Object} [options] - Persistence mode options
     * @returns {Promise<any>}
     */
    async syncFromFillHistoryBatch(fills: SyncFillEvent[], options: Record<string, unknown> = {}) {
        const mgr = this.manager;
        const persistenceMode = resolveProcessedFillPersistenceMode(options);
        if (!Array.isArray(fills) || fills.length === 0) {
            return { filledOrders: [], updatedOrders: [], partialFill: false };
        }

        // Phase 1: Extract & validate fill data
        const fillEntries: FillEntry[] = [];
        let anyRequiresSync = false;

        for (const fill of fills) {
            if (!fill || !fill.op || !fill.op[1]) continue;
            const fillOp = fill.op[1];
            const blockNum = fill.block_num;
            const historyId = fill.id;
            const orderId = fillOp.order_id;
            if (fillOp.is_maker === undefined) {
                mgr.logger.log(`[SYNC] is_maker flag missing from fill data for order ${orderId}; defaulting to maker`, 'warn');
            }
            const isMaker = fillOp.is_maker !== false;
            const fillKey = buildFillKey({ orderId, blockNum, historyId });

            if (!fillKey) {
                mgr.logger.log(`[SYNC] Missing replay-safe fill key for order ${orderId} block ${blockNum}; deferring to open-orders sync`, 'warn');
                anyRequiresSync = true;
                continue;
            }

            const paysAmountRaw = toFiniteNumber(fillOp.pays?.amount);
            const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
            const receivesAmountRaw = toFiniteNumber(fillOp.receives?.amount);
            const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;

            mgr.logger.log(`[SYNC] Processing fill ${historyId} at block ${blockNum} for order ${orderId} (maker=${isMaker}). Pays=${paysAmountRaw}@${paysAssetId}, Receives=${receivesAmountRaw}@${receivesAssetId}`, 'debug');

            fillEntries.push({
                fill, fillOp, blockNum, historyId, orderId, fillKey,
                isMaker, paysAmountRaw, paysAssetId, receivesAmountRaw, receivesAssetId
            });
        }

        if (fillEntries.length === 0) {
            return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: anyRequiresSync };
        }

        // Phase 2: Lock all unique order IDs once
        const allOrderIds = [...new Set(fillEntries.map(e => e.orderId))].filter((id): id is string => typeof id === 'string');

        // Raise the fill-batch in-flight guard BEFORE the accountTotals refresh.
        // The refresh fetches post-fill balances, but the grid still holds the
        // filled orders as committed until the batch's grid mutation (Phase 7),
        // so any fund-invariant check in this window would fire a spurious
        // CRITICAL with diff == the fills' size. The guard is lowered right
        // before the final consolidated recalc so the settled state is still
        // verified.
        mgr._fillBatchInFlight = (mgr._fillBatchInFlight ?? 0) + 1;
        let fillGuardLowered = false;

        try {
            const totalsGate = await mgr.refreshAccountTotalsIfStale();
            if (!totalsGate.ok) {
                mgr.logger.log(
                    '[SYNC] Deferring fill batch: accountTotals refresh failed (stale snapshot). Fills will be re-processed on the next cycle.',
                    'warn'
                );
                return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: false, deferred: true };
            }

            mgr.lockOrders(allOrderIds);

            try {
                mgr.pauseFundRecalc();
                try {
                    // Phase 3: Process accounting for each fill
                    const validEntries: FillEntry[] = [];
                    for (const entry of fillEntries) {
                        try {
                            const appliedAccounting = await mgr.accountant.processFillAccounting(
                                entry.fillOp, entry.fillKey, { persistenceMode }
                            );
                            if (!appliedAccounting) {
                                mgr.logger.log(`[SYNC] Replay detected for fill ${entry.fillKey}; skipping duplicate order mutation`, 'debug');
                                continue;
                            }
                            validEntries.push(entry);
                        } catch (acctErr) {
                            mgr.logger.log(`[SYNC] Accounting error for fill ${entry.fillKey}: ${getErrorMessage(acctErr)}`, 'error');
                            continue;
                        }
                    }

                    if (validEntries.length === 0) {
                        return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: anyRequiresSync };
                    }

                    // Phase 4: Build per-fill context + identify drift candidates
                    const entryContexts: FillEntryContext[] = [];
                    const driftOrderIds = new Set<string>();

                    const assetAPrecision = mgr.assets?.assetA?.precision;
                    const assetBPrecision = mgr.assets?.assetB?.precision;
                    if (assetAPrecision === undefined || assetBPrecision === undefined) {
                        mgr.logger?.log?.('Error: manager.assets precision missing in syncFromFillHistoryBatch', 'error');
                        return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: anyRequiresSync };
                    }

                    for (const entry of validEntries) {
                        const { orderId, paysAmountRaw, paysAssetId } = entry;

                        const matchedGridOrder = this._findMatchingGridOrder(mgr, orderId);
                        if (!matchedGridOrder) {
                            mgr.logger.log(`[SYNC] Fill for order ${orderId} ignored: order not found in active grid.`, 'debug');
                            anyRequiresSync = true;
                            continue;
                        }

                        const ctx = this._computeFillContext(mgr, matchedGridOrder, paysAssetId, paysAmountRaw, entry.receivesAssetId, entry.receivesAmountRaw);
                        mgr.logger.log(`[SYNC] Order ${orderId} (${ctx.orderType}) currentSize=${ctx.currentSize}, filledAmount=${ctx.filledAmount}`, 'debug');

                        if (ctx.driftSignal && orderId) {
                            driftOrderIds.add(orderId);
                        }

                        entryContexts.push({
                            entry, matchedGridOrder,
                            orderType: ctx.orderType,
                            precision: ctx.precision,
                            filledAmount: ctx.filledAmount,
                            filledAmountInt: floatToBlockchainInt(ctx.filledAmount, ctx.precision),
                            currentSizeIntFromGrid: ctx.currentSizeIntFromGrid,
                            rawForSaleInt: ctx.rawForSaleInt,
                            fillPrice: ctx.fillPrice
                        });
                    }

                    // Phase 5: Batch drift refetch — one get_objects call for all order IDs
                    const refetchMap = new Map<string, { chainConfirmsEmpty: boolean; chainRefetched: boolean; effectiveRawForSale: number | null }>();

                    if (driftOrderIds.size > 0) {
                        try {
                            const batchResults = await batchReadOrdersSeam(mgr, [...driftOrderIds], 3000) as Map<string, { for_sale?: number }>;
                            for (const [orderId, freshOrder] of batchResults) {
                                if (freshOrder) {
                                    const freshForSale = toFiniteNumber(freshOrder.for_sale, null);
                                    if (freshForSale !== null && Number.isFinite(freshForSale)) {
                                        refetchMap.set(orderId, {
                                            chainConfirmsEmpty: Math.round(freshForSale) <= 0,
                                            chainRefetched: true,
                                            effectiveRawForSale: freshForSale
                                        });
                                    } else {
                                        refetchMap.set(orderId, {
                                            chainConfirmsEmpty: false,
                                            chainRefetched: true,
                                            effectiveRawForSale: null
                                        });
                                    }
                                } else {
                                    refetchMap.set(orderId, {
                                        chainConfirmsEmpty: true,
                                        chainRefetched: true,
                                        effectiveRawForSale: null
                                    });
                                }
                            }

                            for (const [orderId, { chainRefetched, chainConfirmsEmpty, effectiveRawForSale }] of refetchMap) {
                                if (chainRefetched && effectiveRawForSale != null) {
                                    mgr.logger.log(`[SYNC] Drift detected for ${orderId}; batch-refetched for_sale=${effectiveRawForSale}`, 'warn');
                                } else if (chainConfirmsEmpty) {
                                    mgr.logger.log(`[SYNC] Drift refetch for ${orderId} returned null; chain confirms empty`, 'info');
                                }
                            }
                        } catch (refetchErr) {
                            mgr.logger.log(`[SYNC] Batch drift refetch failed for ${driftOrderIds.size} orders; falling back to cache: ${getErrorMessage(refetchErr)}`, 'warn');
                        }
                    }

                    // Phase 6: Compute state transitions and collect grid updates.
                    // Multiple fills for the SAME order inside one batch are
                    // aggregated into a single cumulative transition. Each fill is
                    // still accounted individually (Phase 3), but the grid mutation
                    // must reflect the COMBINED consumption. Without aggregation every
                    // fill recomputes newSize from the same stale pre-batch baseline
                    // and the last update wins (`applyGridUpdateBatch` is last-wins
                    // per slot), leaving a phantom residual equal to the earlier
                    // fills' sum — exactly the fund-invariant CRITICAL seen in the
                    // AAA-BBB log whenever a batch contained 2+ fills of one order.
                    const gridUpdates: Array<ManagedOrder & { context: string }> = [];
                    const filledOrders: ManagedOrder[] = [];
                    const updatedOrders: ManagedOrder[] = [];
                    const residualCancels: Array<{ orderId: string | null; id: string }> = [];
                    let anyPartialFill = false;

                    const fillContextsBySlot = new Map<string, FillEntryContext[]>();
                    for (const ctx of entryContexts) {
                        const slotId = ctx.matchedGridOrder.id;
                        const group = fillContextsBySlot.get(slotId);
                        if (group) group.push(ctx);
                        else fillContextsBySlot.set(slotId, [ctx]);
                    }

                    for (const group of fillContextsBySlot.values()) {
                        const lastCtx = group[group.length - 1];
                        const { matchedGridOrder, orderType, precision, currentSizeIntFromGrid, rawForSaleInt } = lastCtx;
                        const { orderId } = lastCtx.entry;

                        // Sum the integer filled amounts across this order's fills so
                        // the single transition reflects the total consumption.
                        let totalFilledAmountInt = 0;
                        for (const ctx of group) {
                            totalFilledAmountInt += ctx.filledAmountInt;
                        }
                        const totalFilledAmount = blockchainToFloat(totalFilledAmountInt, precision);

                        if (group.length > 1) {
                            mgr.logger.log(
                                `[SYNC] Aggregated ${group.length} fill(s) for order ${orderId} (slot ${matchedGridOrder.id}): total filled=${totalFilledAmount}`,
                                'debug'
                            );
                        }

                        const refetchInfo = refetchMap.get(orderId ?? '');
                        const chainRefetched = refetchInfo?.chainRefetched || false;
                        const chainConfirmsEmpty = refetchInfo?.chainConfirmsEmpty || false;
                        const effectiveRawForSale = refetchInfo?.effectiveRawForSale != null ? refetchInfo.effectiveRawForSale : rawForSaleInt;

                        const result = await this._computeFillTransitionResult(mgr, {
                            matchedGridOrder,
                            orderType,
                            precision,
                            filledAmount: totalFilledAmount,
                            filledAmountInt: totalFilledAmountInt,
                            currentSizeIntFromGrid,
                            rawForSaleInt,
                            chainRefetched,
                            chainConfirmsEmpty,
                            effectiveRawForSale,
                            blockNum: lastCtx.entry.blockNum,
                            historyId: lastCtx.entry.historyId,
                            isMaker: lastCtx.entry.isMaker,
                            fillPrice: lastCtx.fillPrice
                        });

                        if (result.isFull) {
                            mgr.logger.log(`[SYNC] Full fill for order ${orderId} (slot ${matchedGridOrder.id}).`, 'info');
                            gridUpdates.push({ ...(result.fullUpdate as ManagedOrder), id: matchedGridOrder.id, context: 'handle-fill-full' });
                            filledOrders.push(result.filledOrder);
                            if (result.residualCancel) residualCancels.push(result.residualCancel);
                        } else {
                            mgr.logger.log(`[SYNC] Partial fill for order ${orderId} (slot ${matchedGridOrder.id}): newSize=${result.newSize}`, 'info');
                            gridUpdates.push({ ...(result.partialUpdate as ManagedOrder), id: matchedGridOrder.id, context: 'handle-fill-partial' });
                            updatedOrders.push(result.partialUpdate as ManagedOrder);
                            filledOrders.push(result.filledOrder);
                            anyPartialFill = true;
                        }
                    }

                    // Phase 7: Single grid batch update — acquires _gridLock once
                    if (gridUpdates.length > 0) {
                        const updateObjects = gridUpdates.map(u => {
                            const { context, ...orderData } = u;
                            return orderData;
                        });
                        const batchOk = await mgr.applyGridUpdateBatch(updateObjects, 'handle-fill-batch', { skipAccounting: false, fee: 0 });
                        if (batchOk === false) {
                            mgr.logger.log('[SYNC] Batch grid update failed for some fills; marking totals stale for next sync cycle', 'warn');
                            mgr.accountTotalsStale = true;
                        }
                    }

                    // Re-anchor accountTotals to authoritative post-fill chain truth
                    // after the batch's accounting + grid mutation. The up-front
                    // stale-totals refresh returns post-fill balances, so the batch's
                    // processFillAccounting pays/receives adjustments would otherwise
                    // double-count; the forced fetch overwrites them with the
                    // authoritative values and hands re-commitments
                    // (tryDeductFromChainFree) a fresh snapshot.
                    await mgr.reanchorAccountTotals('fill-batch');

                    return { filledOrders, updatedOrders, partialFill: anyPartialFill, requiresOpenOrdersSync: anyRequiresSync, residualCancels };
                } finally {
                    // Lower the guard before the final consolidated recalc so the
                    // settled (re-anchored) state is still verified.
                    fillGuardLowered = true;
                    mgr._fillBatchInFlight = Math.max(0, (mgr._fillBatchInFlight ?? 0) - 1);
                    await mgr.resumeFundRecalc();
                }
            } finally {
                mgr.unlockOrders(allOrderIds);
            }
        } finally {
            // Safety net: ensure the guard never leaks across cycles on early
            // returns (deferral) or exceptions in the refresh/lock region.
            // Skipped when the inner finally already lowered it for this
            // invocation so concurrent batches cannot zero each other's count.
            if (!fillGuardLowered && (mgr._fillBatchInFlight ?? 0) > 0) mgr._fillBatchInFlight--;
        }
    }

    /**
     * High-level dispatcher for different blockchain synchronization sources.
     * Routes to the appropriate sync strategy based on the data source.
     *
     * SOURCES AND STRATEGIES:
     * ========================================================================
     * source: 'createOrder'
     *   Purpose: Grid order was successfully placed on-chain
     *   Data: { gridOrderId, chainOrderId, isPartialPlacement, fee }
     *   Action:
     *     1. Look up grid order by gridOrderId
     *     2. Assign the returned chainOrderId (so we can find it later)
     *     3. Transition state based on isPartialPlacement:
     *        - false → ACTIVE (full order placed)
     *        - true → PARTIAL (placed as partial, likely due to insufficient funds)
     *     4. Update optimistic chainFree balance (deduct fees if BTS pair)
     *   Fund Impact: Funds transition from free → locked/committed
     *
     * source: 'cancelOrder'
     *   Purpose: Grid order was successfully cancelled on-chain
     *   Data: The chainOrderId to cancel
     *   Action:
     *     1. Find grid order by orderId (reverse lookup)
     *     2. Transition to VIRTUAL (order no longer on-chain)
     *     3. Clear orderId so it can be re-used
     *     4. Update optimistic chainFree balance (add funds back as free)
     *   Fund Impact: Funds transition from locked → free
     *   Note: This is used for direct cancellations (not rotation/consolidation)
     *
     * source: 'readOpenOrders' or 'periodicBlockchainFetch'
     *   Purpose: Full snapshot sync of all open orders from blockchain
     *   Data: Array of chain orders from blockchain API
     *   Action: Delegates to syncFromOpenOrders() for full reconciliation
     *   Use Case: Periodic health check or startup initialization
     *
     * FUND TRACKING:
     * Both 'createOrder' and 'cancelOrder' call updateOptimisticFreeBalance() to
     * keep the optimistic chainFree balance in sync with actual on-chain state.
     * This prevents fund leaks where placed orders weren't deducted or cancelled
     * orders weren't released.
     *
     * RETURNS: { newOrders, ordersNeedingCorrection }
     * Most callers use ordersNeedingCorrection to flag price corrections needed.
     * Only syncFromOpenOrders() populates ordersNeedingCorrection.
     *
     * @param {Object} chainData - Chain event data
     * @param {string} source - Source identifier ('createOrder', 'cancelOrder', 'readOpenOrders', etc.)
     * @returns {Promise<Object>} { newOrders, ordersNeedingCorrection }
     */
    /**
     * E2 invariant assert: a manager holding grid slots but no price ladder is
     * in the undefined state the grid-price invariant forbids (INV-GRID-004).
     *
     * Reports once per grid generation (latched on the manager, counted in
     * `_genesisInvariantViolations`) and, when the bot wired the structural
     * resync, requests one so the ladder is re-derived. Returns FALSE so the
     * caller ABORTS the sync untouched: with no ladder there is no authority for
     * a slot's price, and the legacy tolerance matcher that used to cover this
     * state is gone — continuing would let an off-grid chain price be adopted
     * into a slot.
     *
     * Non-throwing on purpose: the load-side gates (E1/E3) own the fail-closed
     * decision, this one makes a bypass loud without stranding a live manager.
     * @param {unknown} mgr - OrderManager instance
     * @returns {boolean} true when the grid may be synced (no slots, or a usable
     *   ladder is present); false when the sync must not run.
     */
    _assertGenesisInvariant(mgr: OrderManagerLike): boolean {
        try {
            const orders = mgr?.orders;
            const slotCount = orders instanceof Map ? orders.size : 0;
            if (slotCount === 0) return true;
            if (hasGenesisLadder(mgr._genesis)) return true;

            const count = (mgr._genesisInvariantViolations || 0) + 1;
            mgr._genesisInvariantViolations = count;
            const fault = mgr._missingGenesis as { reason?: string; detail?: string } | null | undefined;
            if (count > 1) return false; // already reported for this generation
            mgr._genesisInvariantLoggedAt = Date.now();
            mgr.logger?.log?.(
                `[GENESIS] INVARIANT: sync REFUSED against ${slotCount} grid slot(s) with NO price ladder` +
                (fault ? ` (refused earlier: ${fault.reason} — ${fault.detail})` : '') +
                `. Slot prices have no authority, so no chain order is matched, adopted or corrected this cycle. ` +
                `A structural resync re-derives the ladder.`,
                'error'
            );
            if (typeof mgr.requestStructuralGridResync === 'function') {
                Promise.resolve(mgr.requestStructuralGridResync('missing-genesis', { violations: count }))
                    .catch((err) => {
                        mgr.logger?.log?.(`[GENESIS] Structural resync request failed: ${getErrorMessage(err)}`, 'warn');
                    });
            }
            return false;
        } catch {
            // Never let observability break a sync — but an unevaluatable
            // check must not hand a ladder-less grid to the reconciler either.
            return false;
        }
    }

    async synchronizeWithChain(chainData: SyncChainData, source: string) {
        const mgr = this.manager;
        if (!mgr.assets) return { newOrders: [], filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };

        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId, isPartialPlacement, expectedType, fee } = chainData;
                // Optional placement descriptor for unknown-id recovery. Callers
                // pass the placed slot's price/size/type so a grid reset racing
                // the broadcast can't strand the live chain order untracked.
                // Callers that omit it take the no-descriptor error path.
                const placedDescriptor = chainData.order ?? null;
                const runCreate = async () => {
                    // Lock order to prevent concurrent modifications during state transition
                    mgr.lockOrders([gridOrderId as string]);
                    try {
                        const gridOrder = mgr.orders.get(gridOrderId as string);
                        if (gridOrder) {
                            // Check if this chain order already exists on grid (rotation case)
                            // If so, fee was already paid when original order was placed - don't deduct again
                            // CRITICAL: Look for ANY order with this orderId, even if it's been transitioned to VIRTUAL
                            const existingOrder = Array.from(mgr.orders.values()).find(
                                (o) => o.orderId === chainOrderId && o.id !== gridOrderId
                            );
                            const isRotation = !!existingOrder;

                            // For rotation: transition the old order to VIRTUAL, freeing its capital
                            if (isRotation && existingOrder) {
                                if (!isOrderVirtual(existingOrder)) {
                                    const oldVirtualOrder = convertToSpreadPlaceholder(existingOrder);
                                    await mgr._applyOrderUpdate(oldVirtualOrder, 'rotation-cleanup', {
                                        skipAccounting: chainData.skipAccounting || false,
                                        fee: 0
                                    });
                                } else if (hasOnChainId(existingOrder)) {
                                    // Already VIRTUAL but still has orderId (from rebalance)
                                    // Just clear the orderId to reflect blockchain state
                                    const clearedOrder = convertToSpreadPlaceholder(existingOrder);
                                    await mgr._applyOrderUpdate(clearedOrder, 'fill-cleanup', {
                                        skipAccounting: chainData.skipAccounting || false,
                                        fee: 0
                                    });
                                }
                            }

                            const newState = isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                            let normalizedExpectedType: OrderType | null = (expectedType === ORDER_TYPES.BUY || expectedType === ORDER_TYPES.SELL)
                                ? expectedType
                                : null;
                            // Defensive: a SPREAD slot must never transition to an on-chain
                            // state (validateOrder rejects SPREAD+ACTIVE/PARTIAL as fatal).
                            // Derive the side from the slot price vs start price — same
                            // convention as the funds check (manager.ts).
                            if (!normalizedExpectedType && gridOrder.type === ORDER_TYPES.SPREAD) {
                                normalizedExpectedType = resolveSpreadOrderSide(gridOrder.price, mgr.config.startPrice);
                            }
                            const updatedOrder: ManagedOrder = {
                                ...gridOrder,
                                type: normalizedExpectedType || gridOrder.type,
                                state: newState,
                                orderId: chainOrderId ?? null,
                            };
                            // Restore btsFeeState from raw chain order data if provided.
                            // After a grid reset, in-memory orders have no fee state but the
                            // chain's limit_order_object stores deferred_fee. Passing it through
                            // chainData.deferredFee allows reconstructing btsFeeState so the fee
                            // lifecycle (cancel refunds, fill maker discounts) uses correct values.
                            if (chainData.deferredFee !== undefined && chainData.deferredFee !== null) {
                                updatedOrder.btsFeeState = { deferredFee: Math.max(0, chainData.deferredFee) };
                            }
                            // Deduced fee (createFee or updateFee) must always be applied to reflect blockchain cost
                            const actualFee = fee;
                            const linked = await mgr._applyOrderUpdate(updatedOrder, 'fill-place', {
                                skipAccounting: chainData.skipAccounting || false,
                                fee: actualFee
                            });
                            // Linkage binds the chain order to a slot. Drop any
                            // deferred-orphan record for it: fund accounting counts
                            // unmatched locks too, so a kept record double-counts
                            // now that the slot loop also sees the order. Only on
                            // success — a rejected update leaves the order
                            // unmatched and the record must stay.
                            if (linked !== false) {
                                try { _filterUnmatchedChainOrders(mgr, chainOrderId as string); } catch { /* counting hygiene only */ }
                            }
                        } else {
                            // Unknown grid id: the broadcast landed but master no
                            // longer holds the slot (grid reset/regen raced the
                            // CREATE, or a first placement for an id never
                            // projected via projectTargetToWorkingGrid). The old
                            // code dropped the linkage silently, so the next
                            // cycle re-placed the same level (duplicate CREATEs,
                            // funds locked xN). Materialize-or-error: rebind when
                            // the chain id is already tracked, materialize the
                            // slot when the caller supplied its descriptor, and
                            // log an error otherwise so the order never vanishes
                            // quietly again.
                            const rebound = Array.from(mgr.orders.values()).find(
                                (o) => o.orderId === chainOrderId
                            );
                            if (rebound) {
                                mgr.logger?.log?.(
                                    `[SYNC] createOrder for unknown grid order ${gridOrderId}: chain order ${chainOrderId} already tracked on ${rebound.id} — linkage up to date, skipping`,
                                    'warn'
                                );
                            } else {
                                const rawType = placedDescriptor?.type ?? expectedType;
                                let materializeType: OrderType | null = (rawType === ORDER_TYPES.BUY || rawType === ORDER_TYPES.SELL)
                                    ? rawType
                                    : null;
                                const descriptorPrice = toFiniteNumber(placedDescriptor?.price, NaN);

                                // Resolve the slot's authority: the GENESIS LEVEL,
                                // not the descriptor. Used for BOTH price and type.
                                // Deriving the type from descriptorPrice (as this
                                // once did) let a corrupt descriptor pick the side
                                // while the price was corrected to the ladder, so a
                                // slot whose level is on the BUY side could
                                // materialize as SELL @ <buy-level> — price and type
                                // disagreeing in one order object.
                                const materializeIdx = parseSlotIndex(gridOrderId);
                                let ladderLevel: number | null = null;
                                // Distinguish the two reasons the ladder cannot
                                // price this slot, so the fault log names the
                                // real one: a missing ladder (INV-GRID-004) vs a
                                // ladder that exists but does not address this
                                // index (out-of-range slot id).
                                let ladderFault: 'missing-ladder' | 'out-of-range' | null = null;
                                try {
                                    const genesis = mgr._genesis;
                                    if (materializeIdx !== null) {
                                        if (hasGenesisLadder(genesis)) {
                                            const onLadder = Number(priceForSlot(materializeIdx, genesis as Parameters<typeof priceForSlot>[1]));
                                            if (Number.isFinite(onLadder) && onLadder > 0) ladderLevel = onLadder;
                                            else ladderFault = 'out-of-range';
                                        } else {
                                            ladderFault = 'missing-ladder';
                                        }
                                    }
                                } catch { ladderFault = 'out-of-range'; }

                                // A `slot-N` id the ladder cannot price leaves the
                                // slot with no authority for its price, so the
                                // descriptor can only be a stopgap. Keep the live
                                // chain order tracked (stranding it would be
                                // worse) but make the fault loud and ask for the
                                // ladder/slot to be re-derived, which re-prices
                                // the slot on reload.
                                if (materializeIdx !== null && ladderLevel === null) {
                                    const reason = ladderFault === 'out-of-range'
                                        ? `slot index ${materializeIdx} is outside the price ladder (${hasGenesisLadder(mgr._genesis) ? 'the ladder exists but does not address this slot' : 'no usable ladder'}); the slot id and ladder disagree`
                                        : 'the grid has no price ladder (INV-GRID-004)';
                                    mgr.logger?.log?.(
                                        `[GENESIS] createOrder materialized ${gridOrderId} from the placement descriptor ` +
                                        `because ${reason} — the slot price is unverified ` +
                                        `and will be re-derived on the next grid build`,
                                        'error'
                                    );
                                    if (typeof mgr.requestStructuralGridResync === 'function') {
                                        Promise.resolve(mgr.requestStructuralGridResync('missing-genesis', { reason: 'createOrder-materialize' }))
                                            .catch((err) => mgr.logger?.log?.(`[GENESIS] Structural resync request failed: ${getErrorMessage(err)}`, 'warn'));
                                    }
                                }

                                // Only fall back to the descriptor price when the
                                // ladder cannot address the slot (unparseable id).
                                if (!materializeType && Number.isFinite(descriptorPrice)) {
                                    const sidePrice = ladderLevel ?? descriptorPrice;
                                    materializeType = resolveSpreadOrderSide(sidePrice, mgr.config.startPrice);
                                }
                                const descriptorSize = toFiniteNumber(placedDescriptor?.size, NaN);
                                const hasDescriptor = !!materializeType
                                    && Number.isFinite(descriptorPrice) && descriptorPrice > 0
                                    && Number.isFinite(descriptorSize) && descriptorSize > 0;
                                if (!hasDescriptor) {
                                    mgr.logger?.log?.(
                                        `[SYNC] createOrder linkage LOST: grid order ${gridOrderId} not in master — chain order ${chainOrderId} placed but untracked (no placement descriptor; next readOpenOrders sync must adopt it as an orphan before the slot re-places)`,
                                        'error'
                                    );
                                } else {
                                    // Minimal slot shape: the raw chain object
                                    // isn't available here, so rawOnChain and
                                    // slot-scheme metadata are absent. The next
                                    // readOpenOrders pass repopulates rawOnChain
                                    // from the live order (slot-scheme ids only).
                                    //
                                    // PRICE comes from the GENESIS LADDER, not
                                    // from the descriptor. The descriptor is
                                    // whatever order object the caller carried
                                    // in, and writing it here made a slot's price
                                    // whichever price that object happened to
                                    // hold — the same carried-price-into-
                                    // slot.price class as the adoption writer,
                                    // and for a slot being materialized at a new
                                    // index it can be a price from a different
                                    // grid entirely. The descriptor price is kept
                                    // only when the ladder cannot address the slot
                                    // (unparseable id, or the undefined-grid fault
                                    // logged above).
                                    let materializePrice = descriptorPrice;
                                    let priceSource = 'descriptor';
                                    if (ladderLevel !== null && materializeIdx !== null) {
                                        materializePrice = ladderLevel;
                                        priceSource = 'genesis';
                                    }
                                    const materializedOrder: ManagedOrder = {
                                        id: gridOrderId as string,
                                        type: materializeType as OrderType,
                                        price: materializePrice,
                                        size: descriptorSize,
                                        state: isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE,
                                        orderId: chainOrderId as string,
                                    };
                                    if (priceSource === 'descriptor' && materializeIdx === null) {
                                        mgr.logger?.log?.(
                                            `[SYNC] createOrder for ${gridOrderId}: materialized with the DESCRIPTOR price ` +
                                            `${descriptorPrice} because the grid order id is not a slot-N addressable by the ` +
                                            `price ladder — verify this slot's price on the next sync`,
                                            'warn'
                                        );
                                    }
                                    if (chainData.deferredFee !== undefined && chainData.deferredFee !== null) {
                                        materializedOrder.btsFeeState = { deferredFee: Math.max(0, chainData.deferredFee) };
                                    }
                                    const materialized = await mgr._applyOrderUpdate(materializedOrder, 'createOrder-unknown-id-adopt', {
                                        skipAccounting: chainData.skipAccounting || false,
                                        fee: fee,
                                    });
                                    if (materialized === false) {
                                        mgr.logger?.log?.(
                                            `[SYNC] createOrder linkage FAILED: grid order ${gridOrderId} not in master and materializing chain order ${chainOrderId} (${materializeType} @${materializePrice} x${descriptorSize}) was rejected — chain order left untracked`,
                                            'error'
                                        );
                                    } else {
                                        try { _filterUnmatchedChainOrders(mgr, chainOrderId as string); } catch { /* counting hygiene only */ }
                                        mgr.logger?.log?.(
                                            `[SYNC] createOrder for unknown grid order ${gridOrderId}: materialized ${materializeType} @${materializePrice} x${descriptorSize} (price source: ${priceSource}) -> ${chainOrderId} (master lost the slot mid-broadcast)`,
                                            'warn'
                                        );
                                    }
                                }
                            }
                        }
                    } finally {
                        mgr.unlockOrders([gridOrderId]);
                    }
                };
                if (mgr._gridLock && typeof mgr._gridLock.acquire === 'function') {
                    await mgr._gridLock.acquire(runCreate);
                } else {
                    throw new Error('synchronizeWithChain(createOrder): _gridLock is missing — cannot proceed without lock');
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData.orderId;
                const clearSize = !!chainData.clearSize;
                let btsFeeData: BtsFeeData;
                try {
                    btsFeeData = getAssetFees('BTS') as BtsFeeData;
                } catch (err) {
                    mgr.logger?.log?.(
                        `[FILL-FEE] Failed to load BTS cancel fee cache: ${getErrorMessage(err)}. Using zero-fee fallback.`,
                        'warn'
                    );
                    btsFeeData = {
                        total: 0,
                        createFee: 0,
                        updateFee: 0,
                        cancelFee: 0,
                        makerNetFee: 0,
                        takerNetFee: 0,
                        netFee: 0,
                        isMaker: true,
                    };
                }
                const runCancel = async () => {
                    // Linkage is by chain orderId (authoritative) — no price matching: the slot
                    // that owns this order id is the slot, whatever its level.
                    const gridOrder = Array.from(mgr.orders.values()).find((o) => o && o.orderId === orderId);
                    if (gridOrder) {
                        // Lock both chain orderId and grid order ID to prevent concurrent modifications
                        const orderIds = [orderId, gridOrder.id].filter((x): x is string => Boolean(x));
                        mgr.lockOrders(orderIds);
                        try {
                            // Re-fetch to ensure we have latest state after acquiring lock
                            const currentGridOrder = mgr.orders.get(gridOrder.id);
                            if (currentGridOrder && currentGridOrder.orderId === orderId) {
                                const nextOrder = clearSize
                                    ? convertToSpreadPlaceholder(currentGridOrder)
                                    : virtualizeOrder(currentGridOrder);
                                await mgr._applyOrderUpdate(nextOrder, 'cancel-order', {
                                    skipAccounting: false,
                                    fee: btsFeeData?.cancelFee || 0
                                });
                            } else {
                                // Slot vanished or was rebound between lookup and
                                // lock — never skip quietly: the next
                                // readOpenOrders sync reconciles the slot, but the
                                // race must be visible when it happens.
                                mgr.logger?.log?.(
                                    `[SYNC] cancelOrder for ${orderId}: slot ${gridOrder.id} changed underneath (missing or rebound to ${currentGridOrder?.orderId ?? 'none'}) — linkage skipped, next sync reconciles`,
                                    'warn'
                                );
                            }
                        } finally {
                            mgr.unlockOrders(orderIds);
                        }
                    } else {
                        // CRITICAL: Even if order not in grid, the cancellation fee was still paid on blockchain
                        // Deduct it from account totals to prevent drift.
                        const btsSide = getBtsSide(mgr.config?.assetA, mgr.config?.assetB);
                        if (btsSide && (btsFeeData?.cancelFee ?? 0) > 0) {
                            await mgr.accountant.adjustTotalBalance(btsSide, -(btsFeeData?.cancelFee ?? 0), 'cancel-order-unmatched-fee');
                        }
                    }
                };
                if (mgr._gridLock && typeof mgr._gridLock.acquire === 'function') {
                    await mgr._gridLock.acquire(runCancel);
                } else {
                    throw new Error('synchronizeWithChain(cancelOrder): _gridLock is missing — cannot proceed without lock');
                }
                break;
            }
            case 'readOpenOrders':
                // Plain open-order syncs do not imply a fresh account balance fetch,
                // so they still use optimistic accounting deltas.
                return this.syncFromOpenOrders(chainData as unknown as unknown[], {
                    skipAccounting: false
                });

            case 'periodicBlockchainFetch': {
                // This source is used after fetchAccountTotals() has refreshed
                // authoritative chain free/locked totals. Applying optimistic
                // commitment deltas here double-deducts newly adopted or resized
                // open orders from already-fetched free balances.
                return this.syncFromOpenOrders(chainData as unknown as unknown[], {
                    skipAccounting: true
                });
            }
        }
        return { newOrders: [], filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
    }

    /**
     * Fetch account balances from blockchain and update optimistic fund totals.
     * This is a critical method for financial accuracy and must be called periodically.
     *
     * BALANCE FETCHING:
     * ========================================================================
     * This method queries the blockchain for the actual account balances in both
     * assetA and assetB. It retrieves:
     *   - total: Total balance (including locked amounts)
     *   - free: Available balance (not locked in orders)
     *
     * These are stored in mgr.accountTotals as:
     *   - sell: assetA total (what we can sell)
     *   - sellFree: assetA available
     *   - buy: assetB total (what we can buy with)
     *   - buyFree: assetB available
     *
     * IMPORTANCE FOR FUND TRACKING:
     * The grid maintains an "optimistic" free balance that tracks fund deductions
     * as orders transition states. However, the blockchain is the source of truth.
     * Periodically fetching actual balances allows us to:
     *
     * 1. RECONCILE: Detect if optimistic state diverged from reality
     *    Example: If we think buyFree=1000 but blockchain says 950,
     *    something was deducted (fee, slippage, etc.) that we didn't track.
     *
     * 2. RECOVER: Identify "orphaned" funds that got stuck somewhere
     *    If actual > optimistic, we can reabsorb the extra into available pool.
     *
     * 3. PREVENT OVERSPEND: Use actual totals as the hard ceiling
     *    Even if optimistic calc says we have X funds, we never exceed actual total.
     *
     * FUND FORMULA:
     * At any time, this should hold:
     *   chainTotal = chainFree + chainCommitted
     * Where:
     *   chainTotal = actual on-chain total from blockchain
     *   chainFree = free balance (unallocated)
     *   chainCommitted = sum of all ACTIVE/PARTIAL order sizes on-chain
     *
     * ASSET INITIALIZATION:
     * First calls initializeAssets() to ensure assetA and assetB metadata is loaded.
     * Without this, we can't convert between blockchain precision and float values.
     *
     * ERROR HANDLING:
     * Gracefully handles lookup failures. If blockchain fetch fails, we don't crash
     * but instead log a warning. The system continues with last-known balances.
     *
     * @returns {Promise<void>}
     */
    async fetchAccountBalancesAndSetTotals() {
        const mgr = this.manager;
        try {
            if (!BitShares || !BitShares.db) return;
            const accountIdOrName = mgr.accountId || mgr.account || null;
            if (!accountIdOrName) return;

            try { await this.initializeAssets(); } catch (err) { mgr.logger.log(`[SYNC] initializeAssets failed: ${getErrorMessage(err)}`, 'warn'); }
            const assetAId = mgr.assets?.assetA?.id;
            const assetBId = mgr.assets?.assetB?.id;
            if (!assetAId || !assetBId) return;

            const assetList = [assetAId, assetBId];

            // For non-BTS pairs, also fetch core asset (BTS) balance for fee management
            if (mgr.config.assetA !== 'BTS' && mgr.config.assetB !== 'BTS') {
                assetList.push(NATIVE_CLIENT.CHAIN.CORE_ASSET_ID);
            }

            const lookup = await chainOrders.getOnChainAssetBalances(accountIdOrName, assetList) as Record<string, { total?: number; free?: number } | undefined>;
            const aInfo = lookup?.[assetAId] || lookup?.[String(mgr.config.assetA)];
            const bInfo = lookup?.[assetBId] || lookup?.[String(mgr.config.assetB)];

             if (aInfo && bInfo) {
                 await mgr.setAccountTotals({ sell: aInfo.total, sellFree: aInfo.free, buy: bInfo.total, buyFree: bInfo.free });
             }

             // Store BTS balance for non-BTS pairs
             if (mgr.config.assetA !== 'BTS' && mgr.config.assetB !== 'BTS') {
                 const btsInfo = lookup?.[NATIVE_CLIENT.CHAIN.CORE_ASSET_ID];
                 if (btsInfo) {
                     mgr.btsBalance = { free: btsInfo.free ?? 0, total: btsInfo.total ?? 0, locked: 0 };
                 }
             }
        } catch (err) {
            mgr.logger.log(`Failed to fetch on-chain balances: ${getErrorMessage(err)}`, 'warn');
        }
    }

    /**
     * Initialize asset metadata for assetA and assetB.
     * This must be called before any blockchain operations, as asset metadata
     * (ID, precision) is required for all conversions and lookups.
     *
     * WHY ASSET METADATA MATTERS:
     * ========================================================================
     * The blockchain and grid use different representations for amounts:
     *
     * Blockchain: Uses integers (atomic units based on asset precision)
     *   - BTS: precision 5 → 1 BTS = 100000 satoshis
     *   - USDT: precision 6 → 1 USDT = 1000000 satoshis
     *   Storage on-chain is always integer to prevent floating-point errors
     *
     * Grid: Uses floats for all calculations
     *   - Easier to work with for price/size calculations
     *   - Must round-trip correctly through blockchain precision
     *
     * Asset Metadata Needed:
     * 1. asset_id: Required to match orders on-chain
     *    When we see an order selling assetA for assetB, we identify it by comparing
     *    the asset_ids in the sell_price object.
     *
     * 2. precision: Required for float ↔ integer conversions
     *    floatToBlockchainInt(1.5, precision=5) = 150000
     *    blockchainToFloat(150000, precision=5) = 1.5
     *
     * Without precision, we can't:
     * - Compare order sizes (float vs blockchain int)
     * - Calculate fills (precision matters at extreme sizes)
     * - Match chain orders to grid orders (need correct ID)
     * - Convert fill amounts to grid sizes
     *
     * INITIALIZATION STRATEGY:
     * Assets are looked up asynchronously via the BitShares API.
     * The lookup is idempotent: if assets are already initialized, returns immediately.
     * This allows safe calls from multiple places without redundant lookups.
     *
     * ERROR HANDLING:
     * If asset lookup fails (asset doesn't exist, API error, etc.), the error
     * is propagated (not caught). This is intentional - a missing asset is a
     * configuration error that must be fixed before the bot can operate.
     *
     * @returns {Promise<void>}
     */
    async initializeAssets() {
        const mgr = this.manager;
        if (mgr.assets) return;

        const fetchAssetWithFallback = async (symbol: string, side: 'A' | 'B'): Promise<AssetInfo> => {
            try {
                return await lookupAsset(BitShares, symbol) as AssetInfo;
            } catch (err) {
                // If blockchain lookup fails, check for persisted fallback
                if (mgr.accountOrders) {
                    const persistedAssets = mgr.accountOrders.loadPersistedAssets();
                    const assetData = (side === 'A') ? persistedAssets?.assetA : persistedAssets?.assetB;

                    if (assetData && assetData.symbol === symbol && typeof assetData.precision === 'number') {
                        mgr.logger.log(`Blockchain lookup failed for ${symbol}: ${getErrorMessage(err)}. Persisted data: id=${assetData.id}, precision=${assetData.precision} — refusing stale fallback`, 'error');
                    }
                }
                throw err;
            }
        };

        try {
            mgr.assets = {
                assetA: await fetchAssetWithFallback(mgr.config.assetA ?? '', 'A'),
                assetB: await fetchAssetWithFallback(mgr.config.assetB ?? '', 'B')
            };
        } catch (err) {
            mgr.logger.log(`Asset metadata lookup failed: ${getErrorMessage(err)}`, 'error');
            throw err;
        }
    }
}

export default SyncEngine

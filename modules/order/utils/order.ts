/**
 * modules/order/utils/order.ts - Order Domain Utilities
 *
 * Business rules for orders, state predicates, filtering, and reconciliation.
 * Includes grid indexing, order comparison, delta building, and strategy calculations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (76 exported functions)
 * ===============================================================================
 *
 * SECTION 1: CHAIN ORDER MATCHING & RECONCILIATION (7 functions)
 *   - parseChainOrder(chainOrder, assets) - Parse blockchain order to grid format
 *   - applyChainSizeToGridOrder(manager, gridOrder, chainSize) - Apply chain size to grid
 *   - correctOrderPriceOnChain(manager, correctionInfo, ...) - Correct order price on chain
 *   - correctAllPriceMismatches(manager, accountName, ...) - Correct all price mismatches
 *   - _validatePriceCorrectionEntry(...) - Drain-time staleness check for a queued correction
 *   - _stampCorrectionProvenance(...) - Stamp queue provenance on a correction entry
 *   - findLiveOrderOwnerByChainId(...) - Find the live grid slot that owns a chain order
 *
 * SECTION 2: CROSSING-PLACEMENT GUARDS (8 functions)
 *   - chainOrderMatchesSlot(...) - Exact chain-order/grid-slot match
 *   - chainOrderMatchesSlotWithTolerance(...) - Match within price tolerance
 *   - crossingCandidateChainId(order) - Chain id of a crossing-check candidate
 *   - isCrossingCheckCandidate(order) - Predicate for crossing-placement guards
 *   - buildCrossingCheckCandidates(...) - Candidate set for crossing-placement checks
 *   - chainOrderUnchangedFromCache(...) - Chain order still matches cached pre-update state
 *   - detectCrossedBookPlan(...) - Pre-broadcast crossed-book assert
 *   - collectKnownOnChainOrderIds(...) - On-chain ids master must converge against
 *
 * SECTION 3: ORDER CONSTRUCTION (5 functions)
 *   - buildCreateOrderArgs(order, assetA, assetB) - Build create order arguments
 *   - getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated) - Get type from update flags
 *   - resolveConfiguredPriceBound(value, fallback, startPrice, mode) - Resolve price bounds
 *   - buildFillKey(fillOrParts) - Build a stable fill dedupe key
 *   - buildCreateOpFingerprint(params) - Build fingerprint for create operations
 *
 * SECTION 4: STATE TRANSITIONS & PLACEHOLDERS (6 functions)
 *   - virtualizeOrder(order) - Convert order to VIRTUAL state
 *   - convertToSpreadPlaceholder(order) - Convert order to SPREAD placeholder
 *   - toRailHolePlaceholder(order) - Convert to a rail-typed hole placeholder
 *   - geometryTypeForSlotIndex(...) - BUY/SELL type for a slot index
 *   - resolveSpreadOrderSide(order) - Resolve the real side of a SPREAD slot
 *   - resolveOnChainRetypeType(...) - Type to keep when a live-order slot would retype
 *
 * SECTION 5: GAP EVACUATION (3 functions)
 *   - detectGapEvacuationCandidates(...) - Detect gap-evacuation candidates by geometry
 *   - updateGapEvacuationStreaks(...) - Tick per-slot gap-evacuation streak counter
 *   - collectRefillSlotIds(...) - Refill-slot wire for the COW boundary hold
 *
 * SECTION 6: FILTERING & DRIFT DIAGNOSTICS (12 functions)
 *   - parseSlotIndex(id) - Parse "slot-N" to its rail index
 *   - filterOrdersByType(orders, orderType) - Filter orders by type
 *   - buildOutsideInPairGroups(items, accessors) - Outside->center pair grouping
 *   - extractBatchOperationResults(result) - Extract operation_results from chain batch result
 *   - formatUnmatchedChainOrder(order) - Format structural drift diagnostics
 *   - isNonBlockingUnmatchedOrder(...) - Deliberate hold that must not read as drift
 *   - isStrandedHoldOrder(...) - Stranded hold detection
 *   - isOrderGoneErrorMessage(err) - Detect "chain order does not exist"
 *   - recordDuplicateOrphanDetection(orderId) - Record a duplicate-orphan detection
 *   - clearDuplicateOrphanDetection(orderId) - Clear the detection counter
 *   - duplicateOrphanLogInfo(...) - Log level + re-detection info for duplicate orphans
 *   - _filterUnmatchedChainOrders(...) - Drop a satisfied id from the unmatched list
 *
 * SECTION 7: STATE PREDICATES (8 functions)
 *   - isOrderOnChain(order) - Check if order is ACTIVE or PARTIAL
 *   - isOrderVirtual(order) - Check if order is VIRTUAL
 *   - hasOnChainId(order) - Check if order has blockchain orderId
 *   - isOrderPlaced(order) - Check if order is placed on chain
 *   - isPhantomOrder(order) - Check if order is phantom (ACTIVE without orderId)
 *   - isSlotAvailable(order) - Check if slot is available for placement
 *   - isEmptyGridSlot(order) - Empty reusable placeholder test
 *   - isOrderHealthy(order, context) - Comprehensive order health check
 *
 * SECTION 8: SIZE VALIDATION (2 functions)
 *   - checkSizeThreshold(size, threshold) - Check if size exceeds threshold
 *   - checkSizesBeforeMinimum(sizes, minSize) - Check sizes against minimum
 *
 * SECTION 9: GRID BOUNDARY & ROLES (5 functions)
 *   - calculateIdealBoundary(allSlots, startPrice, gapSlots) - Calculate ideal boundary
 *   - assignGridRoles(allSlots, boundaryIdx, gapSlots, ...) - Assign BUY/SELL roles
 *   - shouldFlagOutOfSpread(order, startPrice, configSpread) - Check if order is out of spread
 *   - deriveTargetBoundary(...) - Target boundary for a rebalance plan
 *   - isShiftEligibleFill(...) - Whether a fill may drive boundary shift/rotation
 *
 * SECTION 10: GRID INDEXING (2 functions)
 *   - buildIndexes(grid) - Build complete index set from grid
 *   - validateIndexes(grid, indexes) - Validate index consistency
 *
 * SECTION 11: ORDER COMPARISON & DELTA (2 functions)
 *   - ordersEqual(a, b) - Compare two orders for equality
 *   - buildDelta(masterGrid, workingGrid) - Build delta actions between grids
 *
 * SECTION 12: STRATEGY / EDGE / BUDGET (11 functions)
 *   - resolveEdgeCount(config, side) - Clamped per-side edge count (>=0 int, 0 disables)
 *   - resolveEdgeOrders(config) - Total edge orders buy+sell (fee/count totals)
 *   - selectEdgeSlots(sortedAsc, count, excludeIds, edge, anchorPrice?) - Shared position picker (both edges anchor toward their bound)
 *   - getCoreOrdersTotal(config) - Total target order count across both sides
 *   - getSideBudget(...) - Side budget after BTS fee deduction
 *   - calculateBudgetedSizes(...) - Sizes for all slots on a side using weighted distribution
 *   - edgeOrderIdSet(allSlots, config, orderType, anchorPrice?, excludeIds?) - Edge order id set (config count; shares the picker ordering; excludeIds carries the window exclusion)
 *   - liveWindowIdSet(...) - Window member ids for one side from the live manager
 *   - resolveEdgeAnchorPrice(config, side) - Config-bound anchor fallback (buy→minPrice, sell→maxPrice; null when unresolvable)
 *   - resolveLiveEdgeAnchorPrice(manager, side) - Live-grid edge anchor (genesis ladder extreme; null when no usable ladder)
 *   - compareEdge(a, b, edge, anchorPrice) - Shared anchored edge comparator (single ordering source)
 *
 * SECTION 13: GRID PRICE INVARIANT (2 functions)
 *   - checkGridPriceInvariant(...) - The price emitted for a slot must equal its genesis price
 *   - reportGridPriceInvariant(...) - Report one GRID-PRICE-INVARIANT check
 *
 * SECTION 14: PERSISTED CRAWL & PLACEMENT GRACE (3 functions)
 *   - consumePendingFillCrawls(...) - Apply recorded-but-uncommitted fill crawls to the boundary
 *   - recordOrderPlacement(...) - Record a fresh on-chain placement timestamp
 *   - isFreshlyPlacedOrder(...) - Chain order placed within the surplus-cancel grace
 *
 * ===============================================================================
 */


import { ORDER_TYPES, ORDER_STATES, TIMING, FEE_PARAMETERS, GRID_LIMITS, NATIVE_CLIENT, COW_PERFORMANCE, COW_ACTIONS, FILL_PROCESSING } from '../../constants.js';
import * as Format from '../format.js';
import * as MathUtils from './math.js';
import Logger from '../../order/logger.js';
import { sleep } from './system.js';
import { getErrorMessage, getErrorCode, getErrorName } from '../../utils/errors.js';
import { hasGenesisLadder } from '../genesis_policy.js';
import { parseSlotIndex as parseSlotIndexShared } from './slot.js';
import type { OrderManagerLike, PendingPriceCorrection, ChainOrder, ParsedChainOrder, AssetPair, AssetInfo, OrderType, ManagedOrder, UnmatchedChainOrder, CowAction, ProjectedFunds } from '../../types.js';
import type { GridGenesis } from './math.js';
const { isValidNumber, toFiniteNumber } = Format;
const { blockchainToFloat, floatToBlockchainInt, quantizeFloat, slotIndexForPrice, priceSlotEqual } = MathUtils;
const orderLogger = new Logger('Order');

interface CorrectionAccountOrdersLike {
    cancelOrder(account: string, privateKey: string, chainOrderId: string): Promise<unknown>;
    updateOrder(account: string, privateKey: string, chainOrderId: string, params: { amountToSell: unknown; minToReceive: unknown }): Promise<unknown>;
    buildCancelOrderOp(account: string, chainOrderId: string): Promise<unknown>;
    batchReadOrders(ids: string[]): Promise<Map<string, unknown>>;
    executeBatch(account: string, privateKey: string, ops: unknown[]): Promise<unknown>;
}

const ORDER_GONE_ERROR_FRAGMENT = 'not found';

/**
 * Detect a "chain order does not exist" error from a broadcast/read failure.
 * Single canonical implementation used by the correction, reconcile-cancel,
 * dust-cancel, and residual-cancel paths.
 *
 * The explicit "order ... does not exist" phrasings always match. The legacy
 * generic 'not found' fragment and the object-missing phrasings match as-is
 * when no orderId is given (legacy order.ts behavior for the correction path);
 * when an orderId IS given (dust/residual cancel paths) they additionally
 * require the orderId to appear in the message, so an unrelated missing-object
 * error is never mistaken for a gone order.
 * @param {string} message - Error message to inspect.
 * @param {string} [orderId] - Order ID required to be present in the message
 *   for generic object-missing phrasings (precision mode).
 * @returns {boolean} True if the message indicates the order is gone.
 */
function isOrderGoneErrorMessage(message: string | null | undefined, orderId?: string | null) {
    if (typeof message !== 'string' || message.length === 0) return false;
    if (/\border\b.*\bdoes not exist\b/i.test(message)) return true;
    if (/\bdoes not exist\b.*\border\b/i.test(message)) return true;
    if (orderId && !message.toLowerCase().includes(String(orderId).toLowerCase())) return false;
    if (message.includes(ORDER_GONE_ERROR_FRAGMENT)) return true;
    if (/\bdoes not exist\b/i.test(message)) return true;
    if (/\bcould not find object\b/i.test(message)) return true;
    if (/\bunable to find object\b/i.test(message)) return true;
    if (/\bobject\b.*\bnot found\b/i.test(message)) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Persistent duplicate-orphan detection escalation. A duplicate-price-level
// orphan is expected self-healing (fully filled order leaves a sub-dust
// residual that collides with the rotated replacement). First sightings log at
// info; if the SAME orderId keeps being re-detected — its cancel keeps failing
// or it keeps getting re-created — the detection sites escalate to warn so the
// silent loop is surfaced instead of degrading quietly. Reuses the existing
// warn-rate-limit and recent-orderId-map tuning from constants.ts rather than
// defining new knobs: repeats are rate-limited by TIMING.STALE_TOTALS_WARN_
// RATE_LIMIT_MS and the counter map is capped by ORDER_EVENTS.
// RECENT_OWN_CANCEL_MAX_ENTRIES (same lazy-GC pattern as chain_orders.ts).
// ---------------------------------------------------------------------------
const _duplicateOrphanDetections = new Map<string, { count: number; lastWarnAt: number | null }>();

/**
 * Record a duplicate-orphan detection for an orderId.
 * First sighting stays quiet (count 1). A repeated sighting of the same
 * orderId escalates, but no more often than TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS.
 * @param {string} orderId - Duplicate orphan chain order ID.
 * @returns {{ count: number; shouldEscalate: boolean }} Detection stats.
 */
function recordDuplicateOrphanDetection(orderId: string | null | undefined) {
    if (!orderId) return { count: 0, shouldEscalate: false };
    const warnRateLimitMs = Number.isFinite(TIMING?.STALE_TOTALS_WARN_RATE_LIMIT_MS)
        ? TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS
        : 60000;
    const maxEntries = Number.isFinite(NATIVE_CLIENT?.ORDER_EVENTS?.RECENT_OWN_CANCEL_MAX_ENTRIES)
        ? NATIVE_CLIENT.ORDER_EVENTS.RECENT_OWN_CANCEL_MAX_ENTRIES
        : 256;

    const now = Date.now();
    const existing = _duplicateOrphanDetections.get(String(orderId));
    const count = existing ? existing.count + 1 : 1;
    let shouldEscalate = false;
    let lastWarnAt = existing ? existing.lastWarnAt : null;
    if (count >= 2 && (lastWarnAt == null || now - lastWarnAt >= warnRateLimitMs)) {
        shouldEscalate = true;
        lastWarnAt = now;
    }
    _duplicateOrphanDetections.set(String(orderId), { count, lastWarnAt });

    // Lazy GC: drop the oldest entries when the map exceeds the shared budget.
    if (_duplicateOrphanDetections.size > maxEntries) {
        let toDelete = _duplicateOrphanDetections.size - maxEntries;
        for (const [id] of _duplicateOrphanDetections) {
            if (toDelete <= 0) break;
            _duplicateOrphanDetections.delete(id);
            toDelete--;
        }
    }
    return { count, shouldEscalate };
}

/**
 * Clear the detection counter for an orderId (e.g. after a confirmed cancel),
 * so a resolved orphan never lingers and false-escalates later.
 * @param {string} orderId - Chain order ID to forget.
 */
function clearDuplicateOrphanDetection(orderId: string | null | undefined) {
    if (orderId) _duplicateOrphanDetections.delete(String(orderId));
}

/**
 * Record a duplicate-orphan detection and return the log level + re-detection
 * suffix for the caller's diagnostic line. First sightings log at info; a
 * repeat escalates to warn (rate-limited).
 * @param {string} orderId - Duplicate orphan chain order ID.
 * @returns {{ level: 'info'|'warn'; suffix: string }} Log level and suffix text.
 */
function duplicateOrphanLogInfo(orderId: string | null | undefined) {
    const { count, shouldEscalate } = recordDuplicateOrphanDetection(orderId);
    return {
        level: shouldEscalate ? 'warn' : 'info',
        suffix: count > 1 ? ` [re-detected ${count}×; cancel may be failing or the order keeps getting re-created]` : '',
    };
}

function _filterUnmatchedChainOrders(manager: OrderManagerLike, chainOrderId: string): void {
    if (Array.isArray(manager._lastUnmatchedChainOrders)) {
        manager._lastUnmatchedChainOrders = manager._lastUnmatchedChainOrders.filter(
            (u) => (u?.id || u?.orderId || u?.chainOrderId) !== chainOrderId
        );
    }
}

/**
 * Record a fresh on-chain placement timestamp for surplus-cancel grace.
 * Called when a slot gains a chain orderId it did not have before (create,
 * adopt, rotation target). Powers isFreshlyPlacedOrder below.
 * @param {unknown} manager - OrderManager instance (owns `_placedAt`)
 * @param {string} chainOrderId - Chain order id that was just placed
 */
function recordOrderPlacement(manager: OrderManagerLike, chainOrderId: string | null | undefined): void {
    try {
        if (!manager || chainOrderId == null || String(chainOrderId).length === 0) return;
        if (!(manager._placedAt instanceof Map)) manager._placedAt = new Map();
        manager._placedAt.set(String(chainOrderId), Date.now());
        // Lazy GC: placement timestamps only matter inside the grace window.
        if (manager._placedAt.size > 500) {
            const cutoff = Date.now() - TIMING.SURPLUS_CANCEL_GRACE_MS * 2;
            for (const [id, ts] of manager._placedAt) {
                if (Number(ts) < cutoff) manager._placedAt.delete(id);
            }
        }
    } catch { /* bookkeeping must never break placement */ }
}

/**
 * True when the chain order was placed within the surplus-cancel grace
 * window. Surplus sweeps must skip such orders: a fill landing between two
 * controllers' count snapshots otherwise makes the second cancel what the
 * first just placed (fee bleed + empty levels, no net change).
 * @param {unknown} manager - OrderManager instance
 * @param {string} chainOrderId - Chain order id to test
 * @param {number} [graceMs] - Override grace window (defaults to TIMING.SURPLUS_CANCEL_GRACE_MS)
 * @returns {boolean} True while the order is still inside its grace window
 */
function isFreshlyPlacedOrder(manager: OrderManagerLike, chainOrderId: string | null | undefined, graceMs?: number): boolean {
    try {
        if (chainOrderId == null || String(chainOrderId).length === 0) return false;
        const placedAt = manager?._placedAt instanceof Map
            ? manager._placedAt.get(String(chainOrderId))
            : null;
        if (!Number.isFinite(Number(placedAt))) return false;
        const grace = Number.isFinite(Number(graceMs)) && Number(graceMs) > 0
            ? Number(graceMs)
            : TIMING.SURPLUS_CANCEL_GRACE_MS;
        return Date.now() - Number(placedAt) < grace;
    } catch {
        return false;
    }
}

/**
 * Remove a single correction entry by its full queue key
 * (chainOrderId + surplus flag). The queue's upsert key is
 * (chainOrderId, isSurplus), so a chain-order-only filter would silently
 * discard a sibling entry (e.g. a cancel-only orphan sharing the id with
 * a price update). Callers pass the entry's own isSurplus flag.
 */
function _removeCorrectionEntry(manager: OrderManagerLike, chainOrderId: string, isSurplus: boolean | null | undefined): void {
    const surplus = Boolean(isSurplus);
    if (manager && Array.isArray(manager.ordersNeedingPriceCorrection)) {
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(
            (c) => c?.chainOrderId !== chainOrderId || Boolean(c?.isSurplus) !== surplus
        );
    }
}

/**
 * Stamp queue provenance on a correction entry: queued-at timestamp plus
 * the detector that produced it. Existing provenance (e.g. a fresher
 * re-queue refreshing queuedAt) is preserved on merge — the sync_engine
 * upsert spreads the new entry over the old one, so a re-queued entry
 * keeps its original queuedAt unless the caller explicitly refreshes it.
 * @param {Object} entry - Correction entry being queued
 * @param {string} source - provenance tag (see queuedBy values)
 * @returns {Object} The same entry, stamped
 */
function _stampCorrectionProvenance(entry: PendingPriceCorrection, source: string): PendingPriceCorrection {
    if (entry && typeof entry === 'object') {
        if (entry.queuedAt == null) entry.queuedAt = Date.now();
        if (entry.queuedBy == null) entry.queuedBy = source;
    }
    return entry;
}

/**
 * Find the live grid slot that currently owns a chain order.
 * When slotId is supplied, only that exact slot is considered; otherwise all
 * live slots are searched. This keeps stale-decision guards consistent without
 * changing which owner is considered valid.
 */
function findLiveOrderOwnerByChainId(manager: OrderManagerLike, chainOrderId: string | null | undefined, slotId?: string | null): ManagedOrder | null {
    if (!(manager?.orders instanceof Map) || !chainOrderId) return null;
    if (slotId) {
        const slot = manager.orders.get(slotId);
        return slot?.orderId === chainOrderId && isOrderPlaced(slot) ? slot : null;
    }
    for (const order of manager.orders.values()) {
        if (order?.orderId === chainOrderId && isOrderPlaced(order)) return order;
    }
    return null;
}

/**
 * Drain-time staleness validation for a correction entry: verify the queued
 * intent still matches the LIVE grid geometry before broadcasting.
 *
 * A correction entry snapshots {slot id, chainOrderId, expectedPrice} at
 * queue time. Any geometry-changing resync (trigger-file resync,
 * reconcileGridOrders startup path, COW commit re-map) can re-slot the
 * chain order or move the slot's price afterwards, leaving the entry
 * stale. Broadcasting it would REVERT the resync's placement — the
 * duplicate-price-level incident class (stale UPDATE is the exact
 * negation of the resync's placement, to the satoshi).
 *
 * An entry is actionable only when the live slot:
 *   1. still exists in the master grid,
 *   2. still owns this chainOrderId (not re-slotted / adopted elsewhere),
 *   3. still targets the queued price — priceSlotEqual against the slot's own
 *      level (the same integer-round-trip predicate the pass-1 detector
 *      uses). A ladder-less manager is an INV-GRID-004 fault, so the entry is
 *      dropped rather than matched by tolerance.
 *
 * Cancel-only duplicate-orphan decisions need an ownership check. They are
 * queued when a chain order has no matching grid slot, but startup reconcile
 * can subsequently relocate that same chain id into an empty valid slot. A
 * replayed cancel would then destroy the freshly updated in-place order.
 *
 * Type-mismatch and gap-evacuation surplus decisions have their own source-
 * specific checks. A type mismatch is actionable only while the same live
 * slot still owns the id and still has the mismatched type. A gap evacuation
 * is actionable only while the same live slot remains in the current gap
 * band. Both otherwise use the old cancellation branch, so allowing either
 * decision to replay would recreate the same stale-replay regression.
 *
 * @param {Object} manager - OrderManager instance (live grid + assets)
 * @param {Object} entry - Queued correction entry
 * @returns {{valid: boolean, reason: string}} valid=false drops the entry
 */
function _validatePriceCorrectionEntry(manager: OrderManagerLike, entry: PendingPriceCorrection): { valid: boolean; reason: string } {
    if (!entry) return { valid: false, reason: 'missing correction entry' };
    if (entry.cancelOnly === true) {
        const owningSlot = findLiveOrderOwnerByChainId(manager, entry.chainOrderId);
        if (owningSlot) {
            return {
                valid: false,
                reason: `chain order is now owned by ${owningSlot.id || 'a live grid slot'}; queued duplicate-orphan cancel is stale`,
            };
        }
        return { valid: true, reason: 'cancel-only-untracked' };
    }
    if (entry.typeMismatch === true) {
        const targetType = entry.sideUpdated || entry.type;
        const slotId = entry?.gridOrder?.id;
        const slot = findLiveOrderOwnerByChainId(manager, entry.chainOrderId, slotId);
        if (!slot) {
            return { valid: false, reason: `type-mismatch target ${slotId || '?'} no longer owns ${entry.chainOrderId}` };
        }
        if (!targetType || slot.type === targetType) {
            return { valid: false, reason: `type-mismatch for ${entry.chainOrderId} was repaired (${slot.type} now matches ${targetType || 'chain type'})` };
        }
        return { valid: true, reason: 'type-mismatch-still-live' };
    }
    if (entry.gapEvacuation === true) {
        const slotId = entry?.gridOrder?.id;
        const slot = findLiveOrderOwnerByChainId(manager, entry.chainOrderId, slotId);
        if (!slot) {
            return { valid: false, reason: `gap-evacuation target ${slotId || '?'} no longer owns ${entry.chainOrderId}` };
        }
        // Live chain price first: a refused-commit adoption can leave the local
        // slot id in-rail while the order actually rests inside the band.
        const live = resolveLiveOrderLadderPosition(slot, manager?.assets, manager?._genesis);
        const geometry = geometryTypeForSlotIndex(live.idx, manager?.boundaryIdx, manager?._gapSlots);
        if (geometry !== ORDER_TYPES.SPREAD) {
            return { valid: false, reason: `gap-evacuation target ${slotId} is no longer in the current gap band` };
        }
        return { valid: true, reason: 'gap-evacuation-still-live' };
    }
    if (entry.isSurplus === true) return { valid: true, reason: 'surplus-cancel' };
    const slotId = entry?.gridOrder?.id;
    const slot = (slotId && manager?.orders instanceof Map) ? manager.orders.get(slotId) : null;
    if (!slot) {
        return { valid: false, reason: `slot ${slotId || '?'} no longer exists` };
    }
    if (slot.orderId !== entry.chainOrderId) {
        return { valid: false, reason: `slot ${slotId} now owns ${slot.orderId || 'no order'} (entry targets ${entry.chainOrderId})` };
    }
    const assets = manager?.assets;
    const precision = entry.type === ORDER_TYPES.SELL ? assets?.assetA?.precision : assets?.assetB?.precision;
    // A correction is stale when the slot no longer targets the price it was
    // queued for. That is integer equality at the asset precision (the slot's
    // level is its ladder level). A ladder-less manager is an INV-GRID-004
    // fault: no slot has a price authority, so the entry cannot be validated
    // and is dropped. The E2 sync gate refuses such a grid outright (queues
    // nothing); it is the structural resync that restores the ladder, after
    // which a later sync re-evaluates the slot.
    if (!hasGenesisLadder(manager?._genesis)) {
        return { valid: false, reason: `no price ladder (INV-GRID-004) — slot ${slotId} has no authoritative price` };
    }
    // Genesis is guaranteed here (guarded above), so compare ladder LEVELS --
    // not priceSlotEqual at the asset amount precision, which collapses
    // adjacent levels for a low-precision asset and would accept a stale entry.
    let sameLevel: boolean;
    try {
        const genesis = manager._genesis as GridGenesis;
        sameLevel = slotIndexForPrice(slot.price, genesis) === slotIndexForPrice(Number(entry.expectedPrice), genesis);
    } catch {
        sameLevel = priceSlotEqual(slot.price, Number(entry.expectedPrice), Number(precision));
    }
    if (!sameLevel) {
        return { valid: false, reason: `slot ${slotId} now targets ${slot.price} (entry queued ${entry.expectedPrice})` };
    }
    // Size check: the broadcast sends amountToSell from the QUEUED snapshot.
    // A partial fill between queue and drain changes the slot's booked size;
    // pushing the stale size would over-write the fill (chain side rebuilds
    // the delta from a live re-read, so it cannot corrupt, but it can still
    // surprise). Integer-quantum comparison, same convention as the
    // pass-1 size check — a fill-changed entry drops and the next sync
    // re-queues from the fresh size if the order is still off-target.
    try {
        const sizePrecision = entry.type === ORDER_TYPES.SELL ? assets?.assetA?.precision : assets?.assetB?.precision;
        if (isValidNumber(slot.size) && isValidNumber(entry.size)
            && floatToBlockchainInt(slot.size, sizePrecision) !== floatToBlockchainInt(entry.size, sizePrecision)) {
            return { valid: false, reason: `slot ${slotId} size moved ${entry.size} -> ${slot.size} (fill changed it after queueing)` };
        }
    } catch {
        // Precision unavailable — fail open on size (ownership + price hold).
    }
    return { valid: true, reason: 'live-slot-match' };
}

// ================================================================================
// SECTION 1: CHAIN ORDER MATCHING & RECONCILIATION
// ================================================================================

/**
 * Parse blockchain order into standard grid order format.
 * Extracts price, type (BUY/SELL), and size from blockchain order structure.
 * Handles precision scaling between assets.
 * 
 * @param {Object} chainOrder - Order from blockchain with sell_price and for_sale
 * @param {Object} assets - Asset metadata with assetA, assetB, and precisions
 * @returns {Object|null} Parsed order {orderId, price, type, size} or null if invalid
 */
function parseChainOrder(chainOrder: ChainOrder | null | undefined, assets: AssetPair | null | undefined): ParsedChainOrder | null {
    if (!chainOrder || !chainOrder.sell_price || !assets) return null;
    const { base, quote } = chainOrder.sell_price;
    if (!base || !quote || !base.asset_id || !quote.asset_id || toFiniteNumber(base.amount) === 0) return null;

    let price: number;
    let type: OrderType;
    const precisionDelta = assets.assetA.precision - assets.assetB.precision;
    const scaleFactor = precisionDelta >= 0
        ? Math.pow(10, precisionDelta)
        : Math.pow(10, Math.abs(precisionDelta));
    const baseAmount = toFiniteNumber(base.amount);
    const quoteAmount = toFiniteNumber(quote.amount);

    if (base.asset_id === assets.assetA.id && quote.asset_id === assets.assetB.id) {
        price = precisionDelta >= 0
            ? (quoteAmount / baseAmount) * scaleFactor
            : (quoteAmount / baseAmount) / scaleFactor;
        type = ORDER_TYPES.SELL;
    } else if (base.asset_id === assets.assetB.id && quote.asset_id === assets.assetA.id) {
        price = precisionDelta >= 0
            ? (baseAmount / quoteAmount) * scaleFactor
            : (baseAmount / quoteAmount) / scaleFactor;
        type = ORDER_TYPES.BUY;
    } else return null;

    let size: number | undefined;
    try {
        if (chainOrder.for_sale !== undefined && chainOrder.for_sale !== null) {
            const prec = (type === ORDER_TYPES.SELL) ? assets.assetA.precision : assets.assetB.precision;
            size = blockchainToFloat(toFiniteNumber(chainOrder.for_sale), prec);
        }
    } catch (e) {
        orderLogger.warn(`parseChainOrder failed for ${chainOrder?.id}: ${getErrorMessage(e)}`);
        return null;
    }

    return { orderId: chainOrder.id, price, type, size };
}

/**
 * Update grid order size based on blockchain state.
 * Detects partial fills and updates accounting if size changed.
 * 
 * Returns the updated order object or null if no update needed.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} gridOrder - Grid order to update
 * @param {number} chainSize - Size from blockchain
 * @returns {Promise<Object|null>} Updated order object or null
 * @throws {Error} If chainSize suspicious (possible data corruption)
 */
async function applyChainSizeToGridOrder(manager: OrderManagerLike, gridOrder: ManagedOrder, chainSize: number | string | null | undefined): Promise<ManagedOrder | null> {
    if (!manager || !gridOrder) return null;
    if (gridOrder.state !== ORDER_STATES.ACTIVE && gridOrder.state !== ORDER_STATES.PARTIAL) return null;

    const precision = (gridOrder.type === ORDER_TYPES.SELL) ? manager.assets?.assetA?.precision : manager.assets?.assetB?.precision;

    if (isValidNumber(precision) && isValidNumber(chainSize)) {
        const SUSPICIOUS_SATOSHI_LIMIT = 1e15;
        const suspiciousThreshold = SUSPICIOUS_SATOSHI_LIMIT / Math.pow(10, precision);
        if (Math.abs(toFiniteNumber(chainSize)) > suspiciousThreshold) {
            const msg = `CRITICAL: suspicious chainSize=${chainSize} exceeds limit ${suspiciousThreshold}. Possible blockchain sync error or data corruption.`;
            manager.logger?.log?.(msg, 'error');
            throw new Error(msg);
        }
    }

    const oldSize = toFiniteNumber(gridOrder.size);
    const newSize = isValidNumber(chainSize) ? toFiniteNumber(chainSize) : oldSize;

    if (floatToBlockchainInt(oldSize, precision) === floatToBlockchainInt(newSize, precision)) { 
        return null; 
    }

    const updatedOrder = { ...gridOrder, size: newSize };

    const delta = newSize - oldSize;
    if (delta < 0 && manager.logger) {
        if (typeof manager.logger.logFundsStatus === 'function') manager.logger.logFundsStatus(manager);
    }
    return updatedOrder;
}

/**
 * Build a stable fill dedupe key.
 * Accepts either a fill-history entry or explicit parts.
 * Returns null if required fields are missing — callers should
 * skip dedup rather than operate on a degraded key.
 *
 * @param {Object} fillOrParts - Fill entry ({ op, block_num, id }) or { orderId, blockNum, historyId }
 * @returns {string|null} Stable key in order:block:history form, or null if fields are missing
 */
function buildFillKey(fillOrParts: { op?: unknown[]; orderId?: string; block_num?: number; blockNum?: number; id?: string; historyId?: string } | null | undefined) {
    const fillOp = fillOrParts?.op?.[1] as { order_id?: string } | undefined;
    const orderId = fillOp?.order_id ?? fillOrParts?.orderId;
    const blockNum = fillOrParts?.block_num ?? fillOrParts?.blockNum;
    const historyId = fillOrParts?.id ?? fillOrParts?.historyId;
    if (!orderId || blockNum == null || !historyId) return null;
    return `${orderId}:${blockNum}:${historyId}`;
}

function _currentCorrectionGridOrder(manager: OrderManagerLike, correctionInfo: PendingPriceCorrection): ManagedOrder | null {
    const slotId = correctionInfo?.gridOrder?.id;
    if (!slotId || !(manager?.orders instanceof Map)) return null;
    const liveSlot = manager.orders.get(slotId);
    if (!liveSlot || liveSlot.orderId !== correctionInfo?.chainOrderId) return null;
    return liveSlot;
}

/**
 * Correct a single order's price on blockchain.
 * Cancels surplus orders; updates price for others.
 * Removes from correction queue after processing.
 * 
 * Surplus settlement is skipped when the live slot no longer owns the chain order; the next sync's pass-1 phantom cleanup virtualizes that slot.
 * @param {Object} manager - OrderManager instance
 * @param {Object} correctionInfo - Correction details {gridOrder, chainOrderId, expectedPrice, size, type, isSurplus}
 * @param {string} accountName - Account name for blockchain transaction
 * @param {string} privateKey - Private key for signing
 * @param {Object} accountOrders - AccountOrders accessor for blockchain ops
 * @returns {Promise<Object>} Result {success, cancelled, skipped, error, orderGone}
 */
async function correctOrderPriceOnChain(manager: OrderManagerLike, correctionInfo: PendingPriceCorrection, accountName: string, privateKey: string, accountOrders: CorrectionAccountOrdersLike) {
    const { gridOrder, chainOrderId, expectedPrice, size, type, isSurplus, cancelOnly } = correctionInfo;
    if (!chainOrderId) return { success: false, error: 'missing chainOrderId' };
    const expectedPriceNum = Number(expectedPrice);
    const sizeNum = Number(size);
    const typeStr = type == null ? '' : String(type);
    const stillNeeded = manager.ordersNeedingPriceCorrection?.some((c) => c.chainOrderId === chainOrderId);
    if (!stillNeeded) return { success: true, skipped: true };

    // Cancel-only entries (e.g., duplicate price level orphans) — cancel without
    // updating any grid slot. The orphan has no matching grid slot to convert.
    if (cancelOnly) {
        // Surplus-cancel grace: a fill landing between two controllers' count
        // snapshots must not get a seconds-old placement cancelled. Skip
        // quietly; the entry stays queued and re-evaluates next cycle.
        if (isFreshlyPlacedOrder(manager, chainOrderId)) {
            manager.logger?.log?.(`[CORRECTION] Skipping cancel-only for freshly placed ${chainOrderId} — inside grace window`, 'info');
            return { success: true, skipped: true };
        }
        let shouldRemove = false;
        try {
            const sideLabel = type === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
            manager.logger?.log?.(`[CORRECTION] Cancelling duplicate orphan ${sideLabel} order ${chainOrderId}`, 'info');
            await accountOrders.cancelOrder(accountName, privateKey, chainOrderId);
            clearDuplicateOrphanDetection(chainOrderId);
            _filterUnmatchedChainOrders(manager, chainOrderId);
            shouldRemove = true;
            return { success: true, cancelled: true };
        } catch (error) {
            const orderGone = isOrderGoneErrorMessage(getErrorMessage(error));
            if (orderGone) {
                clearDuplicateOrphanDetection(chainOrderId);
                shouldRemove = true;
                _filterUnmatchedChainOrders(manager, chainOrderId);
            }
            return { success: false, error: getErrorMessage(error), orderGone };
        } finally {
            if (shouldRemove) {
                _removeCorrectionEntry(manager, chainOrderId, correctionInfo?.isSurplus);
            }
        }
    }

    // Surplus/type-mismatch entries need cancellation, not a price update
    if (isSurplus) {
        if (isFreshlyPlacedOrder(manager, chainOrderId)) {
            manager.logger?.log?.(`[CORRECTION] Skipping surplus cancel for freshly placed ${chainOrderId} — inside grace window`, 'info');
            return { success: true, skipped: true };
        }
        let shouldRemove = false;
        try {
            const sideLabel = type === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
            manager.logger?.log?.(`[CORRECTION] Cancelling surplus/mismatched ${sideLabel} order ${chainOrderId} for slot ${gridOrder?.id || 'unknown'}`, 'info');
            await accountOrders.cancelOrder(accountName, privateKey, chainOrderId);
            const settlementGridOrder = _currentCorrectionGridOrder(manager, correctionInfo);
            if (settlementGridOrder && manager._applyOrderUpdate) {
                const spreadOrder = convertToSpreadPlaceholder(settlementGridOrder);
                await manager._applyOrderUpdate(spreadOrder, 'surplus-type-mismatch-cancel', {
                    skipAccounting: false,
                    fee: 0
                });
            }
            _filterUnmatchedChainOrders(manager, chainOrderId);
            shouldRemove = true;
            return { success: true, cancelled: true };
        } catch (error) {
            const orderGone = getErrorMessage(error)?.includes(ORDER_GONE_ERROR_FRAGMENT);
            if (orderGone) {
                shouldRemove = true;
                _filterUnmatchedChainOrders(manager, chainOrderId);
            }
            return { success: false, error: getErrorMessage(error), orderGone };
        } finally {
            if (shouldRemove) {
                _removeCorrectionEntry(manager, chainOrderId, correctionInfo?.isSurplus);
            }
        }
    }

    let amountToSell, minToReceive;
    if (type === ORDER_TYPES.SELL) {
        amountToSell = sizeNum;
        minToReceive = sizeNum * expectedPriceNum;
    } else {
        amountToSell = sizeNum;
        minToReceive = sizeNum / expectedPriceNum;
    }

    let shouldRemove = false;

    // CROSSING-PLACEMENT GUARD: re-pricing the chain order to its slot's
    // committed price must not cross an opposite-side live order (only
    // reachable when the grid geometry itself is broken). Candidates are the
    // shared master + pending-broadcast + orphan set so a re-price cannot
    // cross a pending CREATE from an earlier uncertain batch. Drop the entry —
    // the next sync's price-mismatch detection re-queues the correction
    // once the crossed order is resolved (same lifecycle as a 'skipped'
    // update below).
    const crossed = MathUtils.findCrossedOrder(
        buildCrossingCheckCandidates(manager),
        expectedPriceNum,
        typeStr,
        manager.assets,
        (o) => isCrossingCheckCandidate(o, chainOrderId)
    );
    if (crossed) {
        manager.logger?.log?.(
            `[CROSS-GUARD] Skipping price correction for ${chainOrderId} -> ${typeStr} @${expectedPriceNum}: ` +
            `crosses live ${crossed.type} ${crossed.id} (${crossed.orderId}) @${crossed.price}; ` +
            `retried after the crossed order resolves.`,
            'warn'
        );
        // The guard returns before the try/finally below, so drop the entry
        // from the correction queue here — otherwise it would linger forever
        // and re-attempt on every sync cycle.
        _removeCorrectionEntry(manager, chainOrderId, correctionInfo?.isSurplus);
        return { success: false, skipped: true, error: 'crossed-placement-guard' };
    }

    try {
        const updateResult = await accountOrders.updateOrder(accountName, privateKey, chainOrderId, { amountToSell, minToReceive });
        if (updateResult === null) {
            // Zero-delta no-op: the chain order already equals the target
            // (replayed correction, sub-unit rounding, or a landed update
            // observed via a lagging read). Resolved, not failed — counting
            // it as failed turns routine no-ops into permanent MAINT WARN
            // noise ("Delta is 0; skipping" every cycle) that hides real
            // reverts.
            shouldRemove = true;
            return { success: true, skipped: true };
        }
        shouldRemove = true;
        return { success: true };
    } catch (error) {
        const orderGone = getErrorMessage(error)?.includes(ORDER_GONE_ERROR_FRAGMENT);
        if (orderGone) {
            shouldRemove = true;
            _filterUnmatchedChainOrders(manager, chainOrderId);
        } else if (getErrorCode(error) === 'BROADCAST_UNCERTAIN' || getErrorName(error) === 'BroadcastUncertainError') {
            // Uncertain update: the delta may have landed. Re-applying the same
            // delta on a later (possibly lagging) read would double-shrink the
            // order. Drop the entry instead of re-queueing blindly — the next
            // sync's price-mismatch detection re-queues the correction if the
            // order is still off-target, and treats it as done if the update
            // actually landed.
            shouldRemove = true;
            manager.logger?.log?.(
                `[CORRECTION] Uncertain price update for ${chainOrderId}; deferring verification to next sync re-detection`,
                'warn'
            );
        }
        return { success: false, error: getErrorMessage(error), orderGone };
    } finally {
        if (shouldRemove) {
            _removeCorrectionEntry(manager, chainOrderId, correctionInfo?.isSurplus);
        }
    }
}

/**
 * Finalize bookkeeping for a correction whose chain order is confirmed gone
 * (batch-cancelled or discovered absent). Mirrors the per-entry cleanup in
 * correctOrderPriceOnChain: duplicate-orphan detection reset, unmatched-list
 * filter, queue removal, and (for surplus entries) grid-slot virtualization.
 */
async function _resolveCancelledCorrection(manager: OrderManagerLike, entry: PendingPriceCorrection): Promise<void> {
    const chainOrderId = entry.chainOrderId;
    if (!chainOrderId) return;
    if (entry.cancelOnly) {
        clearDuplicateOrphanDetection(chainOrderId);
    }
    const settlementGridOrder = !entry.cancelOnly && entry.isSurplus
        ? _currentCorrectionGridOrder(manager, entry)
        : null;
    if (settlementGridOrder && manager._applyOrderUpdate) {
        const spreadOrder = convertToSpreadPlaceholder(settlementGridOrder);
        await manager._applyOrderUpdate(spreadOrder, 'surplus-type-mismatch-cancel', {
            skipAccounting: false,
            fee: 0
        });
    }
    _filterUnmatchedChainOrders(manager, chainOrderId);
    _removeCorrectionEntry(manager, chainOrderId, entry?.isSurplus);
}

/**
 * Broadcast all cancel-type corrections (cancelOnly duplicate orphans +
 * surplus cancellations) together in chunked multi-op transactions.
 *
 * Rationale: the serial path issued one cancelOrder tx per orphan with a sleep
 * between each, draining at ~1 order per block (~3s). A large duplicate-orphan
 * backlog blocked CREATES for minutes while the queue drained
 * one-by-one. Cancels are zero-fee and reference no balance state, so they are
 * safe to pack densely (MAX_CANCELS_PER_BROADCAST).
 *
 * Safety:
 *  - Pre-broadcast existence read: a cancel op for an already-dead order makes
 *    the chain reject the ENTIRE transaction, so gone ids are resolved first
 *    and excluded from the batch.
 *  - Chunks are independent (cancels never interact), so a failed chunk does
 *    not abort the others. Failed-chunk ids are re-read post-broadcast: ids
 *    confirmed gone (uncertain broadcast that landed) are resolved; ids still
 *    live are returned UNRESOLVED so the caller retries them through the
 *    single-entry path (which keeps its own verified-after-failure logic).
 *
 * @returns {Promise<{corrected: number, failed: number, unresolved: Array}>}
 */
async function _batchCancelCorrections(manager: OrderManagerLike, entries: PendingPriceCorrection[], accountName: string, privateKey: string, accountOrders: CorrectionAccountOrdersLike): Promise<{ corrected: number; failed: number; unresolved: PendingPriceCorrection[] }> {
    const logger = manager?.logger;
    const unresolved: PendingPriceCorrection[] = [];
    let corrected = 0;
    let failed = 0;

    const byId = new Map<string, PendingPriceCorrection>();
    for (const e of entries) {
        if (e?.chainOrderId && !byId.has(e.chainOrderId)) byId.set(e.chainOrderId, e);
    }
    const ids = [...byId.keys()];

    let presentIds = ids;
    const preRead = typeof accountOrders?.batchReadOrders === 'function';
    if (preRead) {
        try {
            const orderMap = await accountOrders.batchReadOrders(ids);
            const goneIds: string[] = [];
            presentIds = [];
            for (const id of ids) {
                if (orderMap.get(id)) presentIds.push(id); else goneIds.push(id);
            }
            for (const id of goneIds) {
                await _resolveCancelledCorrection(manager, byId.get(id)!);
                corrected++;
            }
        } catch (err) {
            logger?.log?.(
                `[CORRECTION] Batch pre-read of ${ids.length} cancel candidate(s) failed; proceeding with broadcast: ${getErrorMessage(err)}`,
                'warn'
            );
            presentIds = ids;
        }
    }
    if (presentIds.length === 0) return { corrected, failed, unresolved };

    let ops: { id: string; op: unknown; }[] = [];
    try {
        for (const id of presentIds) {
            const op = await accountOrders.buildCancelOrderOp(accountName, id);
            ops.push({ id, op });
        }
    } catch (err) {
        // Op construction failed (e.g. account resolution): fall back entirely.
        logger?.log?.(
            `[CORRECTION] Batch cancel build failed (${presentIds.length} order(s)): ${getErrorMessage(err)}; falling back to serial cancels`,
            'warn'
        );
        return { corrected, failed, unresolved: entries.filter((e) => e.chainOrderId != null && presentIds.includes(e.chainOrderId)) };
    }

    const configuredMax = Number(COW_PERFORMANCE?.MAX_CANCELS_PER_BROADCAST);
    const maxCancels = Number.isFinite(configuredMax) && configuredMax >= 1 ? Math.floor(configuredMax) : 1;
    const chunks: typeof ops[] = [];
    for (let i = 0; i < ops.length; i += maxCancels) {
        chunks.push(ops.slice(i, i + maxCancels));
    }
    logger?.log?.(
        `[CORRECTION] Batch-cancelling ${ops.length} duplicate/surplus order(s) in ${chunks.length} transaction(s) (max ${maxCancels} cancels/broadcast)`,
        'info'
    );

    const failedChunks: typeof ops[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            await accountOrders.executeBatch(accountName, privateKey, chunk.map((o) => o.op));
            for (const { id } of chunk) {
                await _resolveCancelledCorrection(manager, byId.get(id)!);
                corrected++;
            }
            logger?.log?.(`[CORRECTION] Batch chunk ${i + 1}/${chunks.length} cancelled ${chunk.length} order(s)`, 'info');
        } catch (err) {
            logger?.log?.(
                `[CORRECTION] Batch chunk ${i + 1}/${chunks.length} failed (${chunk.length} order(s)): ${getErrorMessage(err)}; verifying per order`,
                'warn'
            );
            failedChunks.push(chunk);
        }
    }

    for (const chunk of failedChunks) {
        let verifyMap: Map<string, unknown> | null = null;
        if (preRead) {
            try {
                verifyMap = await accountOrders.batchReadOrders(chunk.map((o) => o.id));
            } catch (_) {
                verifyMap = null;
            }
        }
        for (const { id } of chunk) {
            const stillLive = verifyMap ? verifyMap.get(id) : true;
            if (!stillLive && verifyMap) {
                // Uncertain broadcast that actually landed — order is gone.
                await _resolveCancelledCorrection(manager, byId.get(id)!);
                corrected++;
            } else {
                unresolved.push(byId.get(id)!);
            }
        }
    }

    return { corrected, failed, unresolved };
}

/**
 * Read a numeric fillProcessing setting: bot config override first, then the
 * frozen default, then an optional extra default. Returns null when the raw
 * value is absent/non-finite or fails the minimum bound, so callers keep their
 * own fallback and rounding policy. Shared by the correction backlog resolvers
 * below (see resolveCorrectionHoldBudget et al.).
 * @param {unknown} manager
 * @param {string} key - fillProcessing key
 * @param {Object} [options]
 * @param {unknown} [options.extraDefault] - Third-level default (rare)
 * @param {number} [options.min=0] - Minimum accepted value
 * @param {boolean} [options.exclusive=false] - Require value strictly > min
 * @returns {number|null}
 */
function readFillProcessingNumber(
    manager: OrderManagerLike,
    key: string,
    options: { extraDefault?: unknown; min?: number; exclusive?: boolean } = {},
): number | null {
    const { extraDefault, min = 0, exclusive = false } = options;
    const raw = (manager?.config?.fillProcessing as Record<string, unknown> | undefined)?.[key]
        ?? (FILL_PROCESSING as unknown as Record<string, unknown>)?.[key]
        ?? extraDefault;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return exclusive ? (n > min ? n : null) : (n >= min ? n : null);
}

/**
 * Resolve the wall-clock budget for the sequential price-update drain in
 * correctAllPriceMismatches. Cancel-class entries are never budgeted; only
 * the SYNC_DELAY_MS-spaced update loop is bounded, so an unbounded backlog
 * cannot hold _gridLock (no acquisition timeout) for minutes. Reads the bot
 * config override first, then the frozen default. Non-finite/non-positive
 * falls back to the frozen default, then to 4000ms.
 * @param {unknown} manager
 * @returns {number} Positive hold budget in milliseconds
 */
function resolveCorrectionHoldBudget(manager: OrderManagerLike): number {
    const n = readFillProcessingNumber(manager, 'CORRECTION_LOCK_HOLD_BUDGET_MS', { exclusive: true });
    return n === null ? 4000 : Math.floor(n);
}

/**
 * Resolve the optional hard cap on price updates drained per cycle. Layered
 * on top of the hold-time budget: unset (null/undefined/non-finite) means no
 * count cap and the elapsed-time budget alone governs; a finite value >= 0 is
 * honored verbatim (0 intentionally drains no updates this cycle).
 * @param {unknown} manager
 * @returns {number} Finite cap, or Infinity when uncapped
 */
function resolveCorrectionMaxUpdates(manager: OrderManagerLike): number {
    const n = readFillProcessingNumber(manager, 'CORRECTION_MAX_UPDATES_PER_CYCLE');
    return n === null ? Infinity : Math.floor(n);
}

/**
 * Resolve the inter-op delay between successive correction broadcasts.
 * Reads the bot config override first, then the frozen default, falling back
 * to TIMING.SYNC_DELAY_MS. A finite value >= 0 is honored verbatim (0 lets
 * tests drive the drain with no wall-clock sleeps).
 * @param {unknown} manager
 * @returns {number} Non-negative delay in milliseconds
 */
function resolveCorrectionInterOpDelayMs(manager: OrderManagerLike): number {
    const n = readFillProcessingNumber(manager, 'CORRECTION_INTER_OP_DELAY_MS');
    return n === null ? TIMING.SYNC_DELAY_MS : Math.floor(n);
}

/**
 * Resolve the correction-backlog warn threshold (see
 * CORRECTION_QUEUE_WARN_THRESHOLD). Non-positive disables the alarm.
 * @param {unknown} manager
 * @returns {number}
 */
function resolveCorrectionWarnThreshold(manager: OrderManagerLike): number {
    const n = readFillProcessingNumber(manager, 'CORRECTION_QUEUE_WARN_THRESHOLD', { exclusive: true });
    return n === null ? 0 : Math.floor(n);
}

/**
 * Resolve the correction-backlog warn rate-limit window.
 * @param {unknown} manager
 * @returns {number}
 */
function resolveCorrectionWarnRateLimitMs(manager: OrderManagerLike): number {
    const n = readFillProcessingNumber(manager, 'CORRECTION_QUEUE_WARN_RATE_LIMIT_MS', {
        extraDefault: TIMING?.STALE_TOTALS_WARN_RATE_LIMIT_MS,
        exclusive: true,
    });
    return n === null ? 5 * 60 * 1000 : n;
}

/**
 * Correct all pending price mismatches atomically.
 * Cancel-type corrections (duplicate orphans, surplus) are batched into
 * chunked multi-op transactions; price updates run sequentially.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {string} accountName - Account name for blockchain transactions
 * @param {string} privateKey - Private key for signing
 * @param {Object} accountOrders - AccountOrders accessor for blockchain ops
 * @returns {Promise<Object>} Summary {corrected, failed, results}
 */
async function correctAllPriceMismatches(manager: OrderManagerLike, accountName: string, privateKey: string, accountOrders: CorrectionAccountOrdersLike) {
    if (!manager || !manager._gridLock) return { corrected: 0, failed: 0, results: [] };

    // 6b: backlog alarm (rate-limited). Emitted even when the drain defers
    // below, because deferral is exactly when the queue is growing.
    const queuedBefore = Array.isArray(manager.ordersNeedingPriceCorrection)
        ? manager.ordersNeedingPriceCorrection.length
        : 0;
    const warnThreshold = resolveCorrectionWarnThreshold(manager);
    if (warnThreshold > 0 && queuedBefore >= warnThreshold) {
        const now = Date.now();
        const warnRateLimitMs = resolveCorrectionWarnRateLimitMs(manager);
        const lastWarn = Number(manager._correctionQueueWarnAt) || 0;
        if (now - lastWarn >= warnRateLimitMs) {
            manager._correctionQueueWarnAt = now;
            manager?.logger?.log?.(
                `[CORRECTION] Backlog: ${queuedBefore} pending correction(s) (threshold ${warnThreshold}); ` +
                `draining budgeted price updates per cycle so _gridLock is not held across a long drain`,
                'warn'
            );
        }
    }

    // 7a: pre-acquire deferral. _gridLock has NO acquisition timeout, so
    // taking it while a broadcast/placement region is active holds it across
    // the region and starves every concurrent per-op lock acquisition (the
    // broadcaster's own _applySync/cancel calls). Leave corrections queued —
    // the next sync / maintenance tick drains them once the region ends.
    if (manager.isBroadcastingActive?.() === true) {
        manager?.logger?.log?.(
            `[CORRECTION] Drain deferred: broadcast/placement region active; ${queuedBefore} correction(s) stay queued`,
            'debug'
        );
        return { corrected: 0, failed: 0, results: [], staleDropped: 0, deferred: true, reason: 'broadcast-active' };
    }

    return await manager._gridLock.acquire(async () => {
        const results: Array<PendingPriceCorrection & { result: unknown }> = [];
        let corrected = 0; let failed = 0; let staleDropped = 0;
        // Dedupe on the full queue key (chainOrderId + surplus flag),
        // matching the sync upsert key. A chain-order-only key would drop a
        // sibling entry (price update + cancel sharing one chain id) before
        // it ever drains.
        const seen = new Set<string>();
        const ordersToCorrect = (manager.ordersNeedingPriceCorrection || []).filter(
            (c): c is PendingPriceCorrection & { chainOrderId: string } => {
                if (!c.chainOrderId) return false;
                const key = `${c.chainOrderId}|${Boolean(c.isSurplus)}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        // Drain-time staleness validation: a geometry-changing resync between
        // queue and drain can re-slot/re-price UPDATEs or adopt a previously
        // untracked chain order. Drop stale price updates before they revert
        // the resync, and stale cancel-only decisions before they cancel a
        // freshly relocated in-place order. The next sync re-queues if the
        // order is genuinely still off-target.
        const liveEntries: PendingPriceCorrection[] = [];
        for (const entry of ordersToCorrect) {
            const check = _validatePriceCorrectionEntry(manager, entry);
            if (check.valid) {
                liveEntries.push(entry);
                continue;
            }
            _removeCorrectionEntry(manager, entry.chainOrderId, entry?.isSurplus);
            if (entry?.cancelOnly === true) clearDuplicateOrphanDetection(entry.chainOrderId);
            if (entry?.cancelOnly === true || entry?.isSurplus === true) {
                _filterUnmatchedChainOrders(manager, entry.chainOrderId);
            }
            if (entry?.gapEvacuation === true && manager?._gapEvacCancelQueued instanceof Set && entry?.gridOrder?.id) {
                manager._gapEvacCancelQueued.delete(entry.gridOrder.id);
            }
            staleDropped++;
            results.push({ ...entry, result: { success: true, skipped: true, staleDropped: true, staleReason: check.reason } });
            const correctionKind = (entry?.cancelOnly === true || entry?.isSurplus === true) ? 'cancel' : 'price';
            manager?.logger?.log?.(
                `[CORRECTION] Dropping stale ${correctionKind} correction for ${entry.chainOrderId} ` +
                `(queued ${entry.queuedBy || 'unknown-source'}@${entry.queuedAt ? new Date(entry.queuedAt).toISOString() : 'unknown-time'}): ` +
                `${check.reason}; re-queued by next sync if still off-target`,
                'info'
            );
        }

        // 6a: cancel-class entries are always fully drained (batched, no
        // inter-op delay, fund-safety-critical). Only the SYNC_DELAY_MS-spaced
        // price-update loop is budgeted; the unselected remainder stays queued
        // durably and re-drains next cycle.
        //
        // Freshly placed orders are held back from BOTH the batched and the
        // serial cancel paths here: the per-entry grace check inside
        // correctOrderPriceOnChain cannot protect the batch path, which
        // bypasses it. Held-back entries are simply left in
        // ordersNeedingPriceCorrection (never removed) and re-drain next cycle.
        const cancelEntries = liveEntries.filter((c) => {
            if (!(c.cancelOnly === true || c.isSurplus === true)) return false;
            if (isFreshlyPlacedOrder(manager, c.chainOrderId)) {
                manager?.logger?.log?.(
                    `[CORRECTION] Deferring cancel of freshly placed ${c.chainOrderId} — inside grace window`,
                    'info'
                );
                return false;
            }
            return true;
        });
        const updateEntries = liveEntries.filter((c) => !(c.cancelOnly === true || c.isSurplus === true));
        const interOpDelayMs = resolveCorrectionInterOpDelayMs(manager);

        const canBatch = cancelEntries.length > 1
            && typeof accountOrders?.buildCancelOrderOp === 'function'
            && typeof accountOrders?.executeBatch === 'function';
        let serialCancels: PendingPriceCorrection[] = cancelEntries;
        if (canBatch) {
            const batchOutcome = await _batchCancelCorrections(
                manager, cancelEntries, accountName, privateKey, accountOrders
            );
            corrected += batchOutcome.corrected;
            failed += batchOutcome.failed;
            // Unresolved cancels still serialize (they must not be dropped).
            serialCancels = batchOutcome.unresolved;
        }

        for (const correctionInfo of serialCancels) {
            const result = await correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders);
            results.push({ ...correctionInfo, result });
            if (result && result.success) corrected++; else failed++;
            await sleep(interOpDelayMs);
        }

        // Price updates are bounded by wall-clock lock-hold budget (primary)
        // plus an optional hard count cap. The window opens *after* cancels so
        // fund-critical cancels are never delayed by the update budget, and it
        // is measured from the clock rather than a fixed count so a slow chain
        // (large RPC round-trip) drains fewer updates instead of holding
        // _gridLock past the 20s fill-lock timeout. Leftovers stay queued in
        // order for the next cycle.
        const holdBudgetMs = resolveCorrectionHoldBudget(manager);
        const maxUpdates = resolveCorrectionMaxUpdates(manager);
        const updateDeadline = Date.now() + holdBudgetMs;
        let updatesProcessed = 0;
        let deferredUpdates = 0;
        for (const correctionInfo of updateEntries) {
            if (updatesProcessed >= maxUpdates || Date.now() >= updateDeadline) {
                deferredUpdates++;
                continue;
            }
            const result = await correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders);
            results.push({ ...correctionInfo, result });
            if (result && result.success) corrected++; else failed++;
            updatesProcessed++;
            await sleep(interOpDelayMs);
        }
        // Persist master grid mutations from surplus-type-mismatch cancellations.
        // Without this, corrections that cancel an order and convert its grid slot
        // to a spread placeholder are in-memory only until the next fill-driven or
        // maintenance-driven persist cycle.
        if (corrected > 0 && typeof manager.persistGrid === 'function') {
            await manager.persistGrid();
        }
        if (deferredUpdates > 0) {
            const queuedAfter = Array.isArray(manager.ordersNeedingPriceCorrection)
                ? manager.ordersNeedingPriceCorrection.length
                : 0;
            manager?.logger?.log?.(
                `[CORRECTION] Deferred ${deferredUpdates} price update(s) to the next cycle ` +
                `(hold budget ${holdBudgetMs}ms${Number.isFinite(maxUpdates) ? `, cap ${maxUpdates}` : ''}, ` +
                `${queuedAfter} still queued)`,
                'info'
            );
        }
        return { corrected, failed, results, staleDropped, deferredUpdates };
    });
}

// ================================================================================
// SECTION 2-3: ORDER CONSTRUCTION & STATE TRANSITIONS
// ================================================================================

/**
 * Build blockchain order arguments from grid order.
 * Converts grid order data to blockchain-compatible amounts and asset IDs.
 * Handles both BUY and SELL order types.
 * 
 * @param {Object} order - Grid order with type, size, price
 * @param {Object} assetA - Asset metadata with id and precision
 * @param {Object} assetB - Asset metadata with id and precision
 * @returns {Object} Blockchain args {amountToSell, sellAssetId, minToReceive, receiveAssetId}
 * @throws {Error} If asset precision missing
 */
function buildCreateOrderArgs(order: { type: OrderType; size: number; price: number }, assetA: AssetInfo, assetB: AssetInfo) {
    let precision = (order.type === 'sell') ? assetA?.precision : assetB?.precision;
    if (typeof precision !== 'number') throw new Error("Asset precision missing");

    // IMPORTANT: create args must always come from target grid size.
    // Never reuse rawOnChain.for_sale here because stale metadata from a prior
    // slot role can inflate create amounts (e.g., SPREAD->BUY activation).
    const quantizedSize = quantizeFloat(order.size, precision);

    if (order.type === 'sell') {
        return { amountToSell: quantizedSize, sellAssetId: assetA.id, minToReceive: quantizedSize * order.price, receiveAssetId: assetB.id };
    } else {
        return { amountToSell: quantizedSize, sellAssetId: assetB.id, minToReceive: quantizedSize / order.price, receiveAssetId: assetA.id };
    }
}

/**
 * Build a deterministic fingerprint for a planned CREATE order.
 *
 * The fingerprint is used by the COW recovery path to match an
 * order the bot just tried to broadcast to an on-chain order that may or may
 * not have been accepted. Determinism is the key property: if the bot replays
 * the same CREATE op after a credential daemon timeout, the new fingerprint
 * must equal the old one so the chain side can be correlated.
 *
 * The fingerprint uses the (side, assetA, assetB, sellInt, receiveInt, slotId)
 * tuple. sellInt and receiveInt are the raw blockchain integer amounts from
 * buildCreateOrderOp's finalInts (see modules/chain_orders.ts). Using the
 * raw integer pair is more robust than re-deriving a price float because
 * it is invariant to human-side rounding.
 *
 * The slot id is included so two CREATEs with identical price+size on the
 * same side (theoretically possible across non-adjacent grid slots) are
 * still distinguishable.
 *
 * Returns null on any malformed input so callers can skip non-CREATE / non-
 * integer contexts without raising.
 *
 * @param {Object} params
 * @param {string} params.side - 'sell' or 'buy'
 * @param {string} params.assetA - Base asset id (e.g. '1.3.0')
 * @param {string} params.assetB - Quote asset id (e.g. '1.3.121')
 * @param {number|string} params.sellInt - Integer (blockchain-precision) amount-to-sell
 * @param {number|string} params.receiveInt - Integer (blockchain-precision) min-to-receive
 * @param {string} params.slotId - Grid slot id (e.g. 'sell-3', 'buy-7')
 * @returns {string|null} Fingerprint or null on bad input
 */
function buildCreateOpFingerprint(params: { side?: string; assetA?: string; assetB?: string; sellInt?: number | string; receiveInt?: number | string; slotId?: string } | null) {
    if (!params || typeof params !== 'object') return null;
    const { side, assetA, assetB, sellInt, receiveInt, slotId } = params;
    if (side !== 'sell' && side !== 'buy') return null;
    if (!assetA || !assetB) return null;
    if (!Number.isFinite(Number(sellInt)) || !Number.isFinite(Number(receiveInt))) return null;
    if (!slotId) return null;
    return `${side}:${assetA}:${assetB}:${Number(sellInt)}:${Number(receiveInt)}:${String(slotId)}`;
}

/**
 * Determine which order sides were updated based on update flags.
 * 
 * @param {boolean} buyUpdated - Whether buy side was updated
 * @param {boolean} sellUpdated - Whether sell side was updated
 * @returns {string} "buy", "sell", or "both"
 */
function getOrderTypeFromUpdatedFlags(buyUpdated: boolean | undefined, sellUpdated: boolean | undefined) {
    return (buyUpdated && sellUpdated) ? 'both' : (buyUpdated ? 'buy' : 'sell');
}

/**
 * Resolve configured price bound (minPrice/maxPrice) to numeric value.
 * Supports relative expressions like "2x" and fallback defaults.
 * 
 * @param {*} value - Configured value (number, percentage, relative, or empty)
 * @param {number} fallback - Fallback value if configured value is empty
 * @param {number} startPrice - Reference price for relative calculations
 * @param {string} mode - "min" or "max" for relative calculation mode
 * @returns {number} Resolved numeric price
 * @throws {Error} If value is invalid and cannot be interpreted
 */
function resolveConfiguredPriceBound(value: unknown, fallback: number | string | null | undefined, startPrice: number | string | null | undefined, mode: string) {
    const configuredValue = (value === null || value === undefined || value === '') ? fallback : value;

    // Bound x-multipliers must be > 1. With min semantics "Nx" => center/N and
    // max semantics "Nx" => center*N, any multiplier < 1 resolves to a bound on
    // the WRONG side of the grid (e.g. "0.7x" => 1.43x center), placing the
    // whole rail across the order book. Reject sub-1x up front so a misconfig
    // fails clearly instead of producing a broken grid (issue #15).
    const m = MathUtils.parseRelativeMultiplier(configuredValue);
    if (m !== null && m < 1) {
        const boundName = mode === 'min' ? 'minPrice' : mode === 'max' ? 'maxPrice' : 'price bound';
        const hint = mode === 'min'
            ? `'Nx' means center/N for minPrice, so use a value > 1 (e.g. '1.43x' to place the bound at 70% of center)`
            : `'Nx' means center*N for maxPrice, so use a value > 1`;
        throw new Error(`Invalid ${boundName} '${String(configuredValue).trim()}': a bound multiplier must be > 1. ${hint}.`);
    }

    const relative = MathUtils.resolveRelativePrice(configuredValue, startPrice, mode);
    if (Number.isFinite(relative)) {
        return relative;
    }

    const numeric = Number(configuredValue);
    if (!Number.isFinite(numeric)) {
        const boundName = mode === 'min' ? 'minPrice' : mode === 'max' ? 'maxPrice' : 'price bound';
        throw new Error(`Invalid ${boundName}: ${String(configuredValue)}. Expected a numeric value or multiplier like 3x.`);
    }

    return numeric;
}

/**
 * Convert order to virtual state.
 * Clears on-chain ID and raw blockchain data, marks as VIRTUAL.
 * 
 * @param {Object} order - Order to virtualize
 * @returns {Object} Virtualized order (VIRTUAL state, no orderId)
 */
interface CrossingCandidate {
    orderId?: string | null;
    chainOrderId?: string | null;
    slotId?: string;
    price?: number;
    type?: string;
    order?: { price?: number; [key: string]: unknown } | null;
    [key: string]: unknown;
}

interface SlotLike {
    id?: string;
    state?: string;
    orderId?: string | null;
    size?: number;
    type?: OrderType | null;
    price?: number;
}

function virtualizeOrder(order: ManagedOrder): ManagedOrder {
    if (!order) return order;
    // Drop btsFeeState and the createUncertain orphan marker: an explicit
    // virtualize is a known-clean hole transition, so durable "possibly
    // landed CREATE" evidence no longer applies to the resulting object.
    const { btsFeeState, createUncertain, ...rest } = order;
    return { ...rest, state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null };
}

/**
 * Convert order to spread placeholder (virtual, zero-sized spread order).
 * Used when clearing order slots during rotations or rebalancing.
 * 
 * @param {Object} order - Order to convert
 * @returns {Object} Spread placeholder order (VIRTUAL, SPREAD type, zero size)
 */
function convertToSpreadPlaceholder(order: ManagedOrder): ManagedOrder {
    return { ...virtualizeOrder(order), type: ORDER_TYPES.SPREAD, size: 0 };
}

/**
 * Convert an order to a rail-typed hole placeholder: VIRTUAL with the rail
 * (BUY/SELL) type and the booked size preserved.
 *
 * Phase 2 counterpart to convertToSpreadPlaceholder. A consumed/in-rail
 * source slot (e.g. a filled sell at slot-147, or a rotation source) must
 * stay on its rail so candidate-selection and evacuation geometry keep
 * working — only true gap-band slots become side-neutral SPREAD holes.
 * validateOrder accepts sized BUY/SELL VIRTUAL slots (phantom/ILLEGAL checks
 * only fire for on-chain states), so the size survives validation.
 *
 * @param {Object} order - Order to convert
 * @param {string} railType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} [sizeOverride] - Explicit size (defaults to booked size, 0 when non-finite)
 * @returns {Object} Rail hole placeholder (VIRTUAL, rail type, preserved size)
 */
function toRailHolePlaceholder(order: ManagedOrder, railType: string, sizeOverride: number | null = null): ManagedOrder {
    const rail = (railType === ORDER_TYPES.BUY || railType === ORDER_TYPES.SELL) ? railType : order?.type;
    const size = sizeOverride !== null && sizeOverride !== undefined
        ? Math.max(0, toFiniteNumber(sizeOverride))
        : Math.max(0, toFiniteNumber(order?.size));
    return { ...virtualizeOrder(order), type: rail, size };
}

/**
 * Geometry type for a slot index: BUY at/below the boundary, SELL at/above
 * sellStart, SPREAD inside the gap band. Null-safe — returns null when the
 * index, boundary, or gap width is unusable so callers fail closed.
 */
function geometryTypeForSlotIndex(idx: number | string | null | undefined, boundaryIdx: number | string | null | undefined, gapSlots: number | string | null | undefined): OrderType | null {
    // Explicit null/undefined/'' guard: Number(null) === 0 would silently
    // treat "no index" as slot 0 (BUY rail). Fail closed instead.
    if (idx === null || idx === undefined || idx === '') return null;
    if (boundaryIdx === null || boundaryIdx === undefined || boundaryIdx === '') return null;
    // Unknown gap width must also fail closed: Number(null)/Number('') === 0
    // would collapse the gap band and misclassify an in-band slot as a rail
    // slot (the same trap guarded in detectGapEvacuationCandidates).
    if (gapSlots === null || gapSlots === undefined || gapSlots === '') return null;
    const n = Number(idx);
    const b = Number(boundaryIdx);
    const g = Number(gapSlots);
    if (!Number.isFinite(n) || !Number.isFinite(b) || !Number.isFinite(g) || g < 0) return null;
    if (n <= b) return ORDER_TYPES.BUY;
    if (n >= MathUtils.getSellStartIdx(b, g)) return ORDER_TYPES.SELL;
    return ORDER_TYPES.SPREAD;
}

/**
 * Resolve a slot's LIVE ladder position from its on-chain price.
 *
 * `slot.id` is the local generation index; after a refused-commit adoption it
 * can be stale (an order still keyed at slot-117 can be resting at the
 * slot-138 price on chain). Evacuation geometry must therefore prefer the
 * chain order's real price, mapped onto the genesis ladder, and only fall back
 * to the stored slot index. The slot's identity price is NOT rewritten — this
 * is a read-only geometry probe (GRID-PRICE-INVARIANT stays intact).
 *
 * @param slot - Grid slot (needs id/orderId/rawOnChain)
 * @param assets - Asset pair (precision + ids) for parseChainOrder
 * @param genesis - Genesis ladder for price -> slot index
 * @returns {idx, price}: ladder index (null when unknown) and live price
 */
function resolveLiveOrderLadderPosition(
    slot: ManagedOrder | null | undefined,
    assets: AssetPair | null | undefined,
    genesis: unknown
): { idx: number | null; price: number | null } {
    const fallbackIdx = parseSlotIndex(slot?.id);
    const fallbackPrice = Number(slot?.price);
    const raw = slot?.rawOnChain as unknown as ChainOrder | null | undefined;
    if (!raw || !assets || !genesis) {
        return { idx: fallbackIdx, price: Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null };
    }
    try {
        const parsed = parseChainOrder(raw, assets);
        if (!parsed) return { idx: fallbackIdx, price: Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null };
        if (slot?.orderId && parsed.orderId !== slot.orderId) {
            // The raw snapshot belongs to a different chain order: not evidence
            // for this slot.
            return { idx: fallbackIdx, price: Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null };
        }
        const livePrice = Number(parsed.price);
        if (!Number.isFinite(livePrice) || livePrice <= 0) {
            return { idx: fallbackIdx, price: Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null };
        }
        let idx: number | null = fallbackIdx;
        try {
            const resolved = Number(MathUtils.slotIndexForPrice(livePrice, genesis as GridGenesis));
            if (Number.isFinite(resolved) && resolved >= 0) idx = resolved;
        } catch { /* keep the stored index */ }
        return { idx, price: livePrice };
    } catch {
        return { idx: fallbackIdx, price: Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null };
    }
}

/**
 * Detect gap-evacuation candidates by GEOMETRY ONLY: live on-chain orders
 * whose parsed slot index sits strictly inside the gap band
 * (boundary < idx < sellStartIdx). Never consults the stored slot type —
 * Phase 2 retypes in-band actives to rail types, so type-based detection
 * would go blind exactly when evacuation matters.
 *
 * The ladder index prefers the order's LIVE chain price (see
 * resolveLiveOrderLadderPosition): a refused-commit adoption can leave the
 * local slot id in-rail while the order actually rests inside the band.
 *
 * @param {Map} masterGrid - Master grid (slotId -> order)
 * @param {number} boundaryIdx - Last BUY slot index (frozen at plan-build)
 * @param {number} gapSlots - Spread gap slot count (frozen at plan-build)
 * @param {Object} [options] - assets/genesis for the live-price probe
 * @returns {Array} Candidates [{id, idx, type, price, size, orderId}]
 */
function detectGapEvacuationCandidates(masterGrid: Map<string, ManagedOrder>, boundaryIdx: number | string | null, gapSlots: number | string | null, options: { assets?: AssetPair | null; genesis?: unknown } = {}): Array<{ id: string; idx: number; type: OrderType; price: number; size: number; orderId: string }> {
    const out: Array<{ id: string; idx: number; type: OrderType; price: number; size: number; orderId: string }> = [];
    if (!masterGrid || typeof masterGrid.values !== 'function') return out;
    // Explicit null/undefined/'' guard BEFORE Number(): Number(null) === 0 and
    // Number('') === 0 are finite and would read an unknown boundary as slot 0,
    // selecting a fake gap band around it (same trap guarded in
    // geometryTypeForSlotIndex / isSlotIndexInGapBand).
    if (boundaryIdx === null || boundaryIdx === undefined || boundaryIdx === '') return out;
    if (gapSlots === null || gapSlots === undefined || gapSlots === '') return out;
    const b = Number(boundaryIdx);
    const g = Number(gapSlots);
    if (!Number.isFinite(b) || !Number.isFinite(g) || g < 0) return out;
    const sellStartIdx = MathUtils.getSellStartIdx(b, g);
    if (!Number.isFinite(sellStartIdx)) return out;
    for (const slot of masterGrid.values()) {
        if (!slot || !isOrderOnChain(slot) || !slot.orderId) continue;
        const live = resolveLiveOrderLadderPosition(slot, options.assets, options.genesis);
        const idx = live.idx;
        if (idx === null || idx === undefined) continue;
        if (Number(idx) > b && Number(idx) < sellStartIdx) {
            out.push({
                id: slot.id,
                idx: Number(idx),
                type: slot.type,
                price: live.price != null ? live.price : slot.price,
                size: slot.size,
                orderId: slot.orderId
            });
        }
    }
    return out;
}

/**
 * Tick the per-slot gap-evacuation streak counter. In-memory on the manager
 * (resets on restart — acceptable; a restart re-plans evacuation anyway).
 * Slots still in-band increment; resolved slots are dropped. Returns the ids
 * whose streak reached the threshold (stuck candidates).
 *
 * @param {Map} streakMap - Mutable Map slotId -> consecutive-cycle count
 * @param {Array} candidates - detectGapEvacuationCandidates output
 * @param {number} [threshold] - GRID_LIMITS.GAP_EVACUATION_STREAK_THRESHOLD default
 * @returns {{streaks: Object, ready: Array}}
 */
function updateGapEvacuationStreaks(streakMap: Map<string, number>, candidates: unknown, threshold: number | null = null): { streaks: Record<string, number>; ready: Array<{ id: string; [key: string]: unknown }> } {
    const thrRaw = threshold !== null && threshold !== undefined ? Number(threshold) : Number(GRID_LIMITS?.GAP_EVACUATION_STREAK_THRESHOLD);
    const thr = Number.isFinite(thrRaw) && thrRaw > 0 ? Math.floor(thrRaw) : 2;
    const seen = new Set<string>();
    const list: Array<{ id?: string; [key: string]: unknown }> = Array.isArray(candidates) ? candidates : [];
    for (const c of list) {
        if (!c?.id || seen.has(c.id)) continue;
        seen.add(c.id);
        if (streakMap instanceof Map) {
            streakMap.set(c.id, Number(streakMap.get(c.id) || 0) + 1);
        }
    }
    if (streakMap instanceof Map) {
        for (const id of Array.from(streakMap.keys())) {
            if (!seen.has(id)) streakMap.delete(id);
        }
    }
    const streaks: Record<string, number> = {};
    const ready: Array<{ id: string; [key: string]: unknown }> = [];
    if (streakMap instanceof Map) {
        for (const [id, count] of streakMap.entries()) {
            streaks[id] = Number(count);
            if (Number(count) >= thr) {
                const cand = list.find((c) => c?.id === id) || { id };
                ready.push(cand as { id: string });
            }
        }
    }
    return { streaks, ready };
}

/**
 * Resolve the real BUY/SELL side of a SPREAD-typed grid slot from its price
 * relative to the configured start price. SPREAD slots never carry an
 * on-chain state (validateOrder rejects SPREAD+ACTIVE/PARTIAL as fatal), so
 * every transition to an on-chain state (fill processing, sync, adoption)
 * must resolve the side first. Convention is strict: price below startPrice
 * is BUY, at or above is SELL.
 * @param {number} price - The slot's grid price.
 * @param {number} startPrice - The configured grid center price.
 * @returns {string} ORDER_TYPES.BUY or ORDER_TYPES.SELL
 */
function resolveSpreadOrderSide(price: number | string, startPrice: number | string | null | undefined): OrderType {
    return Number(price) < Number(startPrice) ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
}

/**
 * Parse a grid slot id ("slot-123") to its rail index. Delegates to
 * shared slot.ts single source (GRID_PRICE_SLOT_DETERMINISM_PLAN §2.1).
 * @param {unknown} id - grid slot id string
 * @returns {number|null}
 */
function parseSlotIndex(id: string | null | undefined): number | null {
    return parseSlotIndexShared(id);
}
/**
 * Precision governing both price and size comparison for a parsed chain
 * order: base (assetA) for sells, quote (assetB) for buys.
 */
function slotMatchPrecision(type: string, assets: AssetPair): number {
    return type === ORDER_TYPES.SELL ? assets.assetA.precision : assets.assetB.precision;
}

/**
 * Whether a parsed chain order's size matches a slot's, within the shared
 * 1%-of-size tolerance (min 2 quanta). Single source of truth for adoption
 * size matching so the strict and tolerant matchers cannot disagree.
 */
function slotSizeMatches(parsed: ParsedChainOrder, slot: ManagedOrder, precision: number): boolean {
    const sizeTolerance = Math.max(2, Math.floor(floatToBlockchainInt(slot.size, precision) * 0.01));
    return Math.abs(floatToBlockchainInt(parsed.size, precision) - floatToBlockchainInt(slot.size, precision)) <= sizeTolerance;
}

/**
 * Whether a parsed chain order matches a grid slot exactly:
 * type-compatible (slot may be SPREAD), price strictly equal via integer
 * round-trip (single epsilon), size within 1% quantum tolerance (floor 2
 * units). STRICT genesis-slot-mapping matcher — use only where the slot is
 * derived from the price (nearest-slot authority). Uncertain-landed
 * adoption (a broadcast whose on-chain price may have drifted by dust)
 * must use chainOrderMatchesSlotWithTolerance instead, or the drifted
 * order is never adopted and gets re-broadcast as a duplicate.
 * @param {Object} parsed - parseChainOrder output ({type, price, size, ...})
 * @param {Object} slot - Grid slot order object
 * @param {Object} assets - Manager assets ({assetA, assetB} with precision)
 * @returns {boolean}
 */
function chainOrderMatchesSlot(parsed: ParsedChainOrder, slot: ManagedOrder, assets: AssetPair): boolean {
    if (!parsed || !slot || !assets) return false;
    if (parsed.type !== slot.type && slot.type !== ORDER_TYPES.SPREAD) return false;
    // Genesis-frozen: price equality via integer round-trip (single epsilon); slot id is handled by caller via slotIndexForPrice
    const precision = slotMatchPrecision(parsed.type, assets);
    if (!priceSlotEqual(parsed.price, slot.price, precision)) return false;
    return slotSizeMatches(parsed, slot, precision);
}
/**
 * Whether a parsed chain order matches a grid slot within price tolerance:
 * type-compatible (slot may be SPREAD), price within calculatePriceTolerance
 * (clamped to ~2 price quanta so dust-inflated tolerances cannot adopt a
 * wrong order), size within the same 1% quantum tolerance as the strict
 * matcher. For the UNCERTAIN-ADOPT paths only (a just-broadcast create whose
 * on-chain price may have drifted by rounding dust): the strict
 * chainOrderMatchesSlot would miss the drifted order, the slot would stay
 * VIRTUAL, and the next cycle would re-broadcast it as a duplicate.
 * Genesis slot mapping keeps the strict matcher (nearest-slot authority).
 * @param {Object} parsed - parseChainOrder output ({type, price, size, ...})
 * @param {Object} slot - Grid slot order object
 * @param {Object} assets - Manager assets ({assetA, assetB} with precision)
 * @returns {boolean}
 */
function chainOrderMatchesSlotWithTolerance(parsed: ParsedChainOrder, slot: ManagedOrder, assets: AssetPair): boolean {
    if (!parsed || !slot || !assets) return false;
    if (parsed.type !== slot.type && slot.type !== ORDER_TYPES.SPREAD) return false;
    const precision = slotMatchPrecision(parsed.type, assets);
    let tolerance: number | null = null;
    try {
        tolerance = MathUtils.calculatePriceTolerance(
            Math.min(parsed.price, slot.price),
            Math.max(Number(parsed.size) || 0, slot.size),
            parsed.type,
            assets
        );
    } catch {
        tolerance = null;
    }
    // Clamp to ~2 price quanta (relative): dust-sized orders inflate the
    // tolerance past the grid increment, which would adopt a wrong order.
    // A null tolerance (invalid inputs) falls back to the clamp itself.
    const quantumCap = 2 * MathUtils.quantumForPrecision(precision) * Math.max(1, Math.max(parsed.price, slot.price));
    if (tolerance == null || !Number.isFinite(tolerance)) tolerance = quantumCap;
    else tolerance = Math.min(tolerance, quantumCap);
    if (Math.abs(parsed.price - slot.price) > tolerance) return false;
    return slotSizeMatches(parsed, slot, precision);
}
/**
 * Identity of a crossing-check candidate. Master orders carry orderId,
 * unmatched chain orders carry chainOrderId, pending-broadcast wrappers
 * carry slotId + order (their inner order has no chain id yet — it may not
 * even be on chain). All three classes must be visible to crossing guards:
 * an UPDATE-only rotation batch can otherwise re-price across a pending
 * CREATE from an earlier uncertain batch and self-trade (BitShares has no
 * self-trade prevention).
 * @param {Object} o - Candidate order or pending-broadcast wrapper entry
 * @returns {string|null} Chain/slot identity, or null when not placeable
 */
function crossingCandidateChainId(o: CrossingCandidate | null | undefined): string | null {
    if (!o) return null;
    if (o.orderId) return o.orderId;
    if (o.chainOrderId) return o.chainOrderId;
    if (o.slotId && o.order) return o.slotId;
    return null;
}
/**
 * Shared predicate for every crossing-placement guard (COW create/rotation/
 * fallback, startup reconcile placement, price-correction re-queue). Accepts
 * master orders (orderId), unmatched chain orders (chainOrderId), AND
 * pending-broadcast wrappers (slotId + order) — pending entries can never be
 * in cancelOpIndexByOrderId (keyed by chain ids; wrapper orderIds are slot
 * ids in a disjoint namespace), so the exclusion check is harmless for them.
 * VIRTUAL slots (no orderId) are rejected: they have no chain presence and
 * must never block placements.
 * @param {Object} o - Candidate order or pending-broadcast wrapper entry
 * @param {string|null} [excludeChainOrderId=null] - Chain id to exempt (the order being relocated itself)
 * @param {Map|null} [cancelOpIndexByOrderId=null] - orderId -> op index of its already-queued cancel
 * @returns {boolean} True when the candidate participates in crossing checks
 */
function isCrossingCheckCandidate(o: CrossingCandidate | null | undefined, excludeChainOrderId: string | null = null, cancelOpIndexByOrderId: Map<string, unknown> | null = null): boolean {
    if (!o) return false;
    const oid = crossingCandidateChainId(o);
    if (!oid) return false;
    if (excludeChainOrderId && oid === excludeChainOrderId) return false;
    if (cancelOpIndexByOrderId instanceof Map && cancelOpIndexByOrderId.has(oid)) return false;
    const price = o.price ?? o.order?.price;
    if (price == null || !Number.isFinite(Number(price))) return false;
    return true;
}
/**
 * Shared candidate set for crossing-placement checks: master orders plus
 * chain-side orders that may exist on chain but are not (yet) adopted into
 * the master grid — pending-broadcast wrappers from earlier uncertain
 * batches (pushed as wrappers so the predicate can see their slotId; their
 * inner order carries type/price via findCrossedOrder's item.order fallback)
 * and unmatched chain orders (orphans). Without these, an UPDATE-only
 * rotation batch can re-price across an un-adopted chain order that
 * master-grid-only checks cannot see (the pending/unmatched batch guards
 * fire only for CREATE batches).
 * @param {Object} manager - OrderManager instance (orders Map, _pendingBroadcasts, _lastUnmatchedChainOrders)
 * @returns {unknown[]} Candidate orders/wrappers for findCrossedOrder
 */
function buildCrossingCheckCandidates(manager: OrderManagerLike): CrossingCandidate[] {
    if (!manager) return [];
    // LIVE PRICE: a refused-commit adoption can leave a master slot keyed at an
    // old generation level while its chain order actually rests at another
    // price (live incident: the grid still said slot-117 @1263 while the buy
    // was live at 1345.7). Using the stored price let a sell be emitted at the
    // same 1345.728664, self-crossing the live buy. Parse the chain snapshot
    // for the crossing probe only — the slot's identity price is unchanged.
    const withLivePrice = (o: CrossingCandidate): CrossingCandidate => {
        const candidate = o as unknown as ManagedOrder;
        if (!candidate || typeof candidate !== 'object') return o;
        const live = resolveLiveOrderLadderPosition(candidate, manager.assets, manager._genesis);
        if (live.price == null || !Number.isFinite(Number(live.price)) || Number(live.price) <= 0) return o;
        return { ...o, price: Number(live.price) } as CrossingCandidate;
    };
    const candidates: CrossingCandidate[] = manager.orders instanceof Map
        ? [...manager.orders.values()].map(withLivePrice)
        : [];
    if (manager._pendingBroadcasts instanceof Map) {
        for (const entry of manager._pendingBroadcasts.values()) {
            if (entry && entry.slotId && entry.order) candidates.push(withLivePrice(entry as unknown as CrossingCandidate));
        }
    }
    if (Array.isArray(manager._lastUnmatchedChainOrders)) {
        // Unmatched chain orders already carry the chain price; keep as-is.
        for (const o of manager._lastUnmatchedChainOrders) {
            if (o && o.type != null && o.price != null) candidates.push(o);
        }
    }
    return candidates;
}

// ================================================================================
// SECTION 4-6: FILTERING, PREDICATES & SIZE VALIDATION
// ================================================================================

/**
 * Filter orders array by type.
 * 
 * @param {Array<Object>} orders - Orders to filter
 * @param {string} orderType - Order type to match (BUY, SELL, SPREAD)
 * @returns {Array<Object>} Filtered orders of specified type
 */
function filterOrdersByType(orders: ManagedOrder[], orderType: OrderType): ManagedOrder[] {
    return Array.isArray(orders) ? orders.filter((o) => o && o.type === orderType) : [];
}

/**
 * Build outside->center paired groups from mixed BUY/SELL items.
 * SELL items are ordered highest->lowest price, BUY items lowest->highest,
 * then zipped into groups: [sell0,buy0], [sell1,buy1], ...
 *
 * @param {Array<*>} items - Source items containing order-like data.
 * @param {Object} accessors - Accessor functions for item shape.
 * @param {(item: any) => boolean} [accessors.isValid=Boolean] - Validity predicate.
 * @param {(item: any) => string} accessors.getType - Returns ORDER_TYPES value.
 * @param {(item: any) => number|string} accessors.getPrice - Returns item price.
 * @returns {Array<Array<*>>} Grouped items in outside->center pair order.
 */
function buildOutsideInPairGroups<T>(items: T[], { isValid = Boolean, getType, getPrice }: { isValid?: (item: T) => boolean; getType: (item: T) => string; getPrice: (item: T) => number | string }): T[][] {
    const safeItems = Array.isArray(items) ? items.filter((item) => isValid(item)) : [];
    if (safeItems.length === 0) return [];

    const sellItems = safeItems
        .filter((item) => getType(item) === ORDER_TYPES.SELL)
        .sort((a, b) => Number(getPrice(b) || 0) - Number(getPrice(a) || 0));

    const buyItems = safeItems
        .filter((item) => getType(item) === ORDER_TYPES.BUY)
        .sort((a, b) => Number(getPrice(a) || 0) - Number(getPrice(b) || 0));

    const groups: T[][] = [];
    const maxLen = Math.max(sellItems.length, buyItems.length);
    for (let i = 0; i < maxLen; i++) {
        const group: T[] = [];
        if (i < sellItems.length) group.push(sellItems[i]);
        if (i < buyItems.length) group.push(buyItems[i]);
        if (group.length > 0) groups.push(group);
    }

    return groups;
}

/**
 * Extract operation_results from a chain batch execution result.
 * Handles the multiple result shapes returned by different chain library versions
 * and wrapped/unwrapped transaction formats.
 *
 * @param {Object|Array} result - Raw chain batch execution result.
 * @returns {Array} Array of operation result tuples, or empty array if unrecognized.
 */
function extractBatchOperationResults(result: unknown): unknown[][] | null {
    const r = result as {
        operation_results?: unknown[][];
        raw?: { operation_results?: unknown[][]; trx?: { operation_results?: unknown[][] } };
    } | null | undefined;
    const asArray = Array.isArray(result) ? result as Array<{ trx?: { operation_results?: unknown[][] } }> : null;
    const ops = (
        (r && Array.isArray(r.operation_results) && r.operation_results) ||
        (r && r.raw && Array.isArray(r.raw.operation_results) && r.raw.operation_results) ||
        (r && r.raw && r.raw.trx && Array.isArray(r.raw.trx.operation_results) && r.raw.trx.operation_results) ||
        (asArray && asArray[0] && asArray[0].trx && Array.isArray(asArray[0].trx.operation_results) && asArray[0].trx.operation_results) ||
        null
    );
    return (ops && ops.length > 0) ? ops : null;
}

/**
 * Format an unmatched chain order/blocker for operator logs.
 *
 * @param {Object} order - Unmatched chain order or structural blocker.
 * @returns {string} Compact human-readable diagnostic.
 */
function formatUnmatchedChainOrder(order: UnmatchedChainOrder | null | undefined) {
    if (!order) return 'unknown unmatched order';
    const parts = [
        `${order.chainOrderId || 'unknown'}:${order.type || 'unknown'}@${Format.formatPrice6(Number(order.price))}`,
    ];
    if (order.size !== undefined) parts.push(`size=${Format.formatAmount(Number(order.size))}`);
    if (order.slotId) parts.push(`slot=${order.slotId}`);
    if (order.reason) parts.push(`reason=${order.reason}`);
    if (order.fingerprint) parts.push(`fingerprint=${order.fingerprint}`);
    if (order.candidateDiagnostics) parts.push(`candidates=${order.candidateDiagnostics}`);
    return parts.join(' ');
}

/**
 * Whether an unmatched chain-order entry is a deliberate hold that must NOT
 * block CREATEs or snapshot recovery.
 *
 * Deferred entries (`reason` suffixed `-deferred`) are permanently
 * non-adoptable and non-cancellable: an out-of-grid hold sits outside the
 * frozen rail, and a boundary-unknown hold is re-evaluated once the boundary
 * commits. Treating one as a blocker freezes the whole grid (a single
 * dip-protection hold would stop every CREATE) and forces a full reset on
 * recovery. Classification is by the shared `-deferred` suffix, not an exact
 * reason string, so a new defer reason cannot silently regress into a
 * permanent blocker.
 *
 * @param {Object} order - Unmatched chain order entry.
 * @returns {boolean} True when the entry is a non-blocking deferred hold.
 */
function isNonBlockingUnmatchedOrder(order: { reason?: unknown } | null | undefined): boolean {
    const reason = order?.reason;
    return typeof reason === 'string' && reason.endsWith('-deferred');
}

/**
 * Reasons a deferred hold is a candidate for STRUCTURAL RESYNC escalation.
 *
 * Deliberately narrower than `isNonBlockingUnmatchedOrder`. That predicate is
 * a broad "do not treat this as a blocker" net (by design, so a new defer
 * reason cannot silently freeze the grid). Escalation asks a stricter
 * question: can a structural resync plausibly resolve this hold?
 *
 * The distinction matters because a resync cannot end a broadcast region or
 * re-evaluate a boundary that has not committed. Escalating on those holds
 * spends a full grid reload (and possibly a reset) on something the owning
 * machinery already resolves on its own. Excluded deliberately:
 *   - `broadcast-active-deferred`: transient; "rebalance retries after the
 *     region ends". Self-resolving, and unaffected by a resync.
 *   - `boundary-hold-trailing-market`: owned by boundary/trailing-market
 *     machinery, which re-evaluates when the market moves.
 *   - `held-plan-unchanged-deferred`: an identical replan was suppressed
 *     because nothing changed; it clears on the next fill, not on a reload.
 *   - `boundary-unknown-deferred`: gap geometry is unknown pre-boundary; the
 *     comment at sync_engine.ts names the accepted cost as one sync cycle
 *     after the boundary commits. Self-resolving, not stranded.
 *   - `no-genesis-deferred`: included deliberately — a ladder-less grid is
 *     repaired by exactly the reload this escalation performs.
 *
 * Anything not listed is treated as NOT escalatable, so a future transient
 * reason is excluded by default rather than silently becoming a resync
 * trigger.
 */
const STRANDED_HOLD_REASONS = new Set<string>([
    'out-of-rail-deferred',
    'out-of-grid-deferred',
    // Undefined grid (INV-GRID-004): a reload/rebuild IS the remedy, so this
    // hold escalates rather than sitting until a fill happens to trigger one.
    'no-genesis-deferred',
]);

/**
 * @param {Object} order - Unmatched chain order entry.
 * @returns {boolean} True when the hold is stranded and a structural resync is
 *   a plausible remedy (see STRANDED_HOLD_REASONS).
 */
function isStrandedHoldOrder(order: { reason?: unknown } | null | undefined): boolean {
    const reason = order?.reason;
    return typeof reason === 'string' && STRANDED_HOLD_REASONS.has(reason);
}

/**
 * GRID-PRICE-INVARIANT — the price emitted for a slot must be its genesis
 * level. Range guards (isChainPriceOutOfGrid) only test the configured min/max
 * bounds, so an off-grid price can sit inside the bounds while being far
 * outside the active window; that band has no check unless this one runs.
 *
 * Unjudgeable inputs evaluate to ok:true (missing genesis, unparseable slot id,
 * non-finite price) — the guard must never fire on bad metadata, only on a
 * genuine mismatch. Never throws.
 *
 * See docs/GRID_PRICE_INVARIANT.md.
 *
 * @param {string} slotId - Grid slot id (slot-<idx>)
 * @param {number} price - Price about to be emitted
 * @param {unknown} genesis - manager._genesis (priceLevels table)
 * @returns {{ok: boolean, reason: string, expected: number|null, idx: number|null, drift: number|null}}
 */
function checkGridPriceInvariant(slotId: string | null | undefined, price: number | string | null | undefined, genesis: GridGenesis | null | undefined): { ok: boolean; reason: string; expected: number | null; idx: number | null; drift: number | null } {
    const pass = { ok: true, expected: null as number | null, idx: null as number | null, drift: null as number | null };
    try {
        if (!genesis || !Array.isArray(genesis?.priceLevels) || genesis.priceLevels.length === 0) {
            return { ...pass, reason: 'no-genesis' };
        }
        const idx = (typeof slotId === 'string') ? parseSlotIndex(slotId) : null;
        if (idx === null || !Number.isFinite(idx) || idx < 0 || idx >= genesis.priceLevels.length) {
            return { ...pass, reason: 'uncheckable-slot' };
        }
        const p = Number(price);
        if (!Number.isFinite(p) || p <= 0) return { ...pass, reason: 'invalid-price', idx };
        const expected = Number(MathUtils.priceForSlot(idx, genesis));
        if (!Number.isFinite(expected) || expected <= 0) return { ...pass, reason: 'invalid-level', idx };
        // Same equality as assertSlotPriceInvariant at grid build/load:
        // relative 1e-9 with an absolute floor.
        const diff = Math.abs(p - expected);
        const rel = diff / Math.max(1e-12, Math.abs(expected));
        const ok = !(rel > 1e-9 && diff > 1e-12);
        return { ok, reason: ok ? 'ok' : 'off-grid-price', expected, idx, drift: rel };
    } catch {
        return { ...pass, reason: 'check-failed' };
    }
}

/**
 * Report one GRID-PRICE-INVARIANT check. Never throws: an unjudgeable check
 * returns true so a bad check can never block a legitimate emission. Warns on a
 * mismatch so the offending slot, site, expected level and drift are named at
 * the point of emission. Silent when the check passes or the price is not
 * checkable.
 *
 * Returns the check result so calling sites can choose their policy: the
 * reconcile sites treat `false` as blocking (skip the emission and let the next
 * cycle re-plan). See docs/GRID_PRICE_INVARIANT.md.
 *
 * @param {unknown} manager - OrderManager (reads _genesis, writes logger)
 * @param {string} slotId - Destination slot id whose level the price must match
 * @param {number} price - Price about to be emitted
 * @param {string} site - Emitting site label (CREATE / UPDATE / RECONCILE-*)
 * @returns {boolean} True when the price is acceptable (or unjudgeable). Callers
 *   at the reconcile sites treat `false` as a blocking mismatch and skip the
 *   emission, so this must return the check result rather than void.
 */
function reportGridPriceInvariant(manager: OrderManagerLike, slotId: string | null | undefined, price: number | string, site: string): boolean {
    try {
        const inv = checkGridPriceInvariant(slotId, price, hasGenesisLadder(manager?._genesis) ? manager._genesis : null);
        if (inv.ok) return true;
        manager?.logger?.log?.(
            `[GRID-PRICE-INVARIANT] ${site} for ${slotId} at ${Format.formatPrice6(Number(price))} ` +
            `is NOT the genesis level ${inv.expected != null ? Format.formatPrice6(inv.expected) : 'n/a'} ` +
            `(slot idx ${inv.idx}, drift ${inv.drift != null ? (inv.drift * 100).toFixed(4) + '%' : 'n/a'}) ` +
            `— off-grid price SKIPPED (emission blocked at this site)`,
            'warn'
        );
        return false;
    } catch { /* invariant check is best-effort: never block on a thrown check */ return true; }
}

/**
 * Check if order is on blockchain (ACTIVE or PARTIAL state).
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order has on-chain state
 */
function isOrderOnChain(order: SlotLike | null | undefined) {
    return (order?.state === ORDER_STATES.ACTIVE || order?.state === ORDER_STATES.PARTIAL) && !!order?.orderId;
}

/**
 * Resolve the type to keep when a slot holding a live on-chain order would
 * otherwise be reassigned to SPREAD. SPREAD+ACTIVE/PARTIAL is an illegal state
 * (validateOrder rejects it as fatal ILLEGAL_SPREAD_STATE), so the slot keeps
 * its stored BUY/SELL rail type; a stale SPREAD type is resolved by the slot
 * index vs the boundary (the same convention the grid type correction uses).
 * A genuinely misplaced order is later cancelled by sync pass-1 type-mismatch
 * handling. Shared by assignGridRoles (runtime boundary shifts) and the
 * load-time GRID-TYPE-CORRECT guard so the invariant lives in one place.
 * Filled orders are unaffected: a full fill first converts the slot via
 * convertToSpreadPlaceholder/virtualizeOrder, clearing orderId and state, so
 * isOrderOnChain is false and the placeholder remains freely retypable.
 *
 * @param {Object} slot - The slot being retyped
 * @param {number} idx - Slot index
 * @param {number} buyEndIdx - Boundary index (last BUY slot)
 * @param {Object} orderTypes - ORDER_TYPES constants
 * @returns {string} Type to keep for the on-chain slot
 */
function resolveOnChainRetypeType(slot: SlotLike, idx: number, buyEndIdx: number, orderTypes: { BUY: OrderType; SELL: OrderType }): OrderType {
    return (slot.type === orderTypes.BUY || slot.type === orderTypes.SELL)
        ? slot.type
        : (idx <= buyEndIdx ? orderTypes.BUY : orderTypes.SELL);
}

/**
 * Check if order is virtual (not on blockchain yet).
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order in VIRTUAL state
 */
function isOrderVirtual(order: SlotLike | null | undefined) { return order?.state === ORDER_STATES.VIRTUAL; }

/**
 * Whether a slot is an empty reusable placeholder: VIRTUAL, no chain order,
 * and zero size.  Empty slots are normalized to SPREAD (side-neutral) so their
 * stored type never pre-biases which rail reuses them.
 *
 * Shared by loadGrid (grid.ts) and assignGridRoles.  Callers differ in whether
 * a `type: null` slot counts as empty:
 * - loadGrid (defensive backstop for legacy persisted grids): any empty slot is
 *   forced to SPREAD, including null-typed ones (allowNullType: true).
 * - assignGridRoles (non-assignOnChain path): grid creation types fresh slots
 *   null and must let geometry assign BUY/SELL, so a null type is NOT empty.
 *
 * The resolved `liveSlot` (when provided) supplies the state/orderId/size
 * checks; the `slot` object supplies the type check.  `isOrderOnChain` is
 * intentionally not checked: VIRTUAL + !orderId already implies off-chain.
 *
 * @param {Object} slot - The slot whose type is inspected.
 * @param {Object|null} liveSlot - Runtime slot for state checks (defaults to slot).
 * @param {Object} [opts] - Options.
 * @param {boolean} [opts.allowNullType=false] - Treat `type: null` slots as empty.
 * @returns {boolean} True when the slot is a size-0 VIRTUAL placeholder.
 */
function isEmptyGridSlot(slot: SlotLike | null | undefined, liveSlot: SlotLike | null = null, opts: { allowNullType?: boolean } = {}): boolean {
    if (!slot) return false;
    const target = liveSlot || slot;
    if (target.state !== ORDER_STATES.VIRTUAL) return false;
    if (target.orderId) return false;
    if (Number(target.size || 0) !== 0) return false;
    if (opts.allowNullType !== true && slot.type === null) return false;
    return true;
}

/**
 * Check if order has on-chain ID.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order has orderId
 */
function hasOnChainId(order: { orderId?: string | null } | null | undefined) { return !!order?.orderId; }

/**
 * Check if order is placed and confirmed on blockchain.
 * Must be on-chain (ACTIVE/PARTIAL) with orderId.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order is confirmed placed
 */
function isOrderPlaced(order: SlotLike | null | undefined) { return isOrderOnChain(order) && hasOnChainId(order); }

/**
 * Check if order is phantom (on-chain but missing orderId).
 * Indicates a sync error or ghost order state.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order appears on-chain but has no ID
 */
function isPhantomOrder(order: SlotLike | null | undefined) {
    const inOnChainState = order?.state === ORDER_STATES.ACTIVE || order?.state === ORDER_STATES.PARTIAL;
    return inOnChainState && !hasOnChainId(order);
}

/**
 * Check if slot is available for new order placement.
 * Slot must be VIRTUAL (not on-chain) and have no orderId.
 * 
 * @param {Object} order - Order/slot to check
 * @returns {boolean} True if slot available
 */
function isSlotAvailable(order: SlotLike | null | undefined) { return isOrderVirtual(order) && !hasOnChainId(order); }

/**
 * Check if order size meets health thresholds.
 * Must be above absolute minimum and double-dust threshold.
 * 
 * @param {number} size - Order size to check
 * @param {string} type - Order type (BUY/SELL)
 * @param {Object} assets - Asset metadata with precisions
 * @param {number} idealSize - Ideal grid size for dust calculation
 * @returns {boolean} True if order is healthy
 */
function isOrderHealthy(size: number | string, type: OrderType, assets: AssetPair, idealSize: number | string) {
    const numericSize = Number(size);
    const numericIdeal = Number(idealSize);
    if (!Number.isFinite(numericSize) || numericSize <= 0) return false;
    if (!Number.isFinite(numericIdeal) || numericIdeal <= 0) return false;

    return MathUtils.validateOrderSize(
        numericSize,
        type,
        assets,
        GRID_LIMITS.MIN_ORDER_SIZE_FACTOR,
        numericIdeal,
        GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE
    ).isValid;
}

/**
 * Check if any size in array falls below threshold.
 * Used for validation before order placement.
 * 
 * @param {Array<number>} sizes - Sizes to check
 * @param {number} threshold - Minimum threshold value
 * @param {number} precision - Asset precision for quantization check
 * @param {boolean} [includeNonFinite=false] - Treat non-finite values as below threshold
 * @returns {boolean} True if any size is below threshold
 */
function checkSizeThreshold(sizes: number[], threshold: number, precision: number, includeNonFinite: boolean = false) {
    if (threshold <= 0 || !Array.isArray(sizes) || sizes.length === 0) return false;
    const precisionSlack = isValidNumber(precision)
        ? MathUtils.getPrecisionSlack(precision, 1)
        : Number.EPSILON;
    return sizes.some((sz) => {
        if (!Number.isFinite(sz)) return includeNonFinite;
        if (sz <= 0) return false;
        if (isValidNumber(precision)) return floatToBlockchainInt(sz, precision) < floatToBlockchainInt(threshold, precision);
        return sz < (threshold - precisionSlack);
    });
}

/**
 * Check if any sizes are below minimum (including non-finite values).
 * Wrapper for checkSizeThreshold with includeNonFinite=true.
 * 
 * @param {Array<number>} sizes - Sizes to check
 * @param {number} minSize - Minimum size threshold
 * @param {number} precision - Asset precision
 * @returns {boolean} True if any size is below minimum
 */
function checkSizesBeforeMinimum(sizes: number[], minSize: number, precision: number) {
    return checkSizeThreshold(sizes, minSize, precision, true);
}

/**
 * Bounded rail-center index for a slot array of `length` with `gapSlots`.
 * The same fallback used by `calculateIdealBoundary` (non-numeric reference)
 * and `deriveTargetBoundary` (Tier-4 recovery): never a rail edge, wrong by
 * at most half the rail. Shared so the two spellings cannot drift.
 *
 * @param {number} length - Slot count
 * @param {number} gapSlots - Gap band size
 * @returns {number} Clamped center index (0 when the rail is empty)
 */
function railCenterIndex(length: number, gapSlots: number): number {
    const len = Number(length);
    if (!Number.isFinite(len) || len <= 0) return 0;
    const gap = Number.isFinite(Number(gapSlots)) && Number(gapSlots) >= 0 ? Math.floor(Number(gapSlots)) : 0;
    return Math.max(0, Math.floor((len - 1 - gap) / 2));
}

/**
 * Calculate ideal grid boundary based on reference price.
 * Places boundary near reference price with gap spacing in mind.
 *
 * A non-numeric reference (e.g. the unresolved "pool"/"book" mode strings)
 * makes every `price >= reference` comparison false, which used to resolve
 * `splitIdx` to `allSlots.length` and fabricate a top-of-rail boundary —
 * the degenerate all-buy geometry behind the 02:03 slot-77→slot-192 (+58%)
 * teleport plan. Fail toward rail-center instead; callers with a real
 * anchor (genesis startPrice, live center) override before calling.
 *
 * @param {Array<Object>} allSlots - All grid slots sorted by price
 * @param {number} referencePrice - Reference/anchor price
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @returns {number} Ideal boundary index or -1 if slots empty
 */
function calculateIdealBoundary(allSlots: SlotLike[], referencePrice: number | string, gapSlots: number) {
    if (!allSlots || allSlots.length === 0) return -1;
    if (!Number.isFinite(Number(referencePrice))) {
        return railCenterIndex(allSlots.length, gapSlots);
    }
    let splitIdx = allSlots.findIndex((s) => Number(s.price) >= Number(referencePrice));
    if (splitIdx === -1) splitIdx = allSlots.length;
    const buySpread = Math.floor(gapSlots / 2);
    return Math.max(0, Math.min(allSlots.length - 1, splitIdx - buySpread - 1));
}

/**
 * Assign BUY/SELL/SPREAD roles to grid slots based on boundary.
 * Slots below boundary are BUY, above boundary are SELL, between are SPREAD.
 * Can optionally override even on-chain orders.
 * 
 * @param {Array<Object>} allSlots - All grid slots to assign
 * @param {number} boundaryIdx - Boundary index
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @param {Object} ORDER_TYPES - ORDER_TYPES constants
 * @param {Object} ORDER_STATES - ORDER_STATES constants
 * @param {Object} [options={}] - Options
 * @param {boolean} [options.assignOnChain=false] - Override on-chain orders if true
 * @returns {Array<Object>} Slots with updated type assignments
 */
interface DeltaAction {
    type: 'create' | 'update' | 'cancel';
    id: string;
    order?: ManagedOrder;
    prevOrder?: ManagedOrder;
    orderId?: string | null;
    [key: string]: unknown;
}

interface OrderConfigView {
    edgeOrders?: number | { buy?: number; sell?: number; [key: string]: unknown };
    coreOrders?: { buy?: number; sell?: number; [key: string]: unknown };
    startPrice?: number | string;
    minPrice?: number | string | null;
    maxPrice?: number | string | null;
    assetA?: string;
    assetB?: string;
    feeParams?: { BTS_RESERVATION_MULTIPLIER?: number; [key: string]: unknown };
    min_BTS_value?: number;
    incrementPercent?: number;
    targetSpreadPercent?: number;
    gridLimits?: { [key: string]: unknown };
    [key: string]: unknown;
}

interface ManagerFundsLike {
    allocatedBuy?: number;
    allocatedSell?: number;
    chainFreeBuy?: number;
    chainFreeSell?: number;
    btsBalance?: { free?: number; total?: number; locked?: number } | null;
}

function assignGridRoles<T extends SlotLike>(allSlots: T[], boundaryIdx: number, gapSlots: number, ORDER_TYPES: { BUY: OrderType; SELL: OrderType; SPREAD: OrderType }, _ORDER_STATES: unknown, options: { assignOnChain?: boolean; getCurrentSlot?: (id: string) => ManagedOrder | undefined } = {}): T[] {
    const assignOnChain = options.assignOnChain === true;
    const getCurrentSlot = (typeof options.getCurrentSlot === 'function') ? options.getCurrentSlot : null;
    const buyEndIdx = boundaryIdx;
    const sellStartIdx = MathUtils.getSellStartIdx(boundaryIdx, gapSlots);

    return allSlots.map((slot, i): T => {
        const liveSlot = getCurrentSlot && slot.id ? (getCurrentSlot(slot.id) || slot) : slot;

        // Empty VIRTUAL slots (size 0, no orderId) keep their RAIL type by
        // geometry (Phase 2): an in-rail hole stays BUY/SELL VIRTUAL so
        // candidate-selection and evacuation geometry keep working; only
        // true gap-band slots are side-neutral SPREAD. The stored type never
        // pre-biases reuse because every consumer filters by boundary
        // geometry (getSlotCorrectType / isSlotInRail), and spread-correction
        // accepts both rail and SPREAD stored types on the orphaned path.
        //
        // Only apply during non-assignOnChain paths (loadGrid, recalculateGrid
        // without boundary shift).  When assignOnChain is true, geometry must
        // win: strategy (calculateTargetGrid) and boundary-shift code re-type
        // empty slots by position so they appear in the correct rail's budget
        // and can be activated on the correct side.
        if (!assignOnChain && isEmptyGridSlot(slot, liveSlot)) {
            const parsed = parseSlotIndex(slot?.id);
            const geoType = geometryTypeForSlotIndex(parsed !== null && parsed !== undefined ? parsed : i, boundaryIdx, gapSlots);
            const wantType = geoType || ORDER_TYPES.SPREAD;
            if (slot.type === wantType) return slot;
            return { ...slot, type: wantType } as T;
        }

        const newType = (i <= buyEndIdx) ? ORDER_TYPES.BUY : (i >= sellStartIdx) ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD;
        if (slot.type === newType) return slot;

        // SPREAD GUARD: a slot holding a live on-chain order (state ACTIVE/PARTIAL
        // with an orderId, including ghost PARTIAL size-0 orders) must never be
        // reassigned to SPREAD, even when assignOnChain:true moves it into the gap
        // band. SPREAD+ACTIVE/PARTIAL is an illegal state (validateOrder rejects it
        // as fatal ILLEGAL_SPREAD_STATE), and retyping would orphan the live chain
        // order. Preserve the BUY/SELL rail type; any genuinely misplaced order is
        // cancelled by sync pass-1 type-mismatch handling. Mirrors the load-time
        // GRID-TYPE-CORRECT guard (grid.ts).
        if (newType === ORDER_TYPES.SPREAD && isOrderOnChain(liveSlot)) {
            return { ...slot, type: resolveOnChainRetypeType(slot, i, buyEndIdx, ORDER_TYPES) } as T;
        }

        const canAssign = assignOnChain || !isOrderOnChain(liveSlot);
        if (canAssign) {
            return { ...slot, type: newType } as T;
        }
        return slot;
    });
}

/**
 * Determine if grid is out of spread and by how many steps.
 * Compares current spread against nominal with tolerance.
 * Returns number of excess steps (0 = in-spread).
 *
 * @param {number} currentSpread - Current bid-ask spread percentage
 * @param {number} nominalSpread - Nominal spread percentage
 * @param {number} toleranceSteps - Tolerance in increment steps
 * @param {number} buyCount - Number of active buy orders
 * @param {number} sellCount - Number of active sell orders
 * @param {number} [incrementPercent=0.5] - Grid increment percentage
 * @returns {number} Excess steps (0 if in-spread, >0 if out-of-spread)
 */
function shouldFlagOutOfSpread(currentSpread: number, nominalSpread: number, toleranceSteps: number, buyCount: number, sellCount: number, incrementPercent: number = 0.5) {
    // Non-finite spread (one-sided book, zero best-buy) with placed orders on
    // both sides is pathological — treat like the empty side: flag the nominal
    // gap count, never propagate Infinity as an "extra slots" count.
    if (buyCount === 0 || sellCount === 0 || !Number.isFinite(Number(currentSpread))) {
        const step = 1 + (incrementPercent / 100);
        const gap = Math.ceil(Math.log(1 + (nominalSpread / 100)) / Math.log(step));
        return Math.max(1, gap);
    }
    const step = 1 + (incrementPercent / 100);
    const currentSteps = Math.log(1 + (currentSpread / 100)) / Math.log(step);
    const limitSteps = (Math.log(1 + (nominalSpread / 100)) / Math.log(step)) + toleranceSteps;
    if (currentSteps <= limitSteps) return 0;
    return Math.max(1, Math.ceil(currentSteps - limitSteps));
}

// ================================================================================
// SECTION 8: GRID INDEXING
// ================================================================================

/**
 * Build complete index set from grid
 * @param {Map} grid - Order grid
 * @returns {Object} - Index object with state and type indexes
 */
function buildIndexes(grid: Map<string, ManagedOrder>): Record<string, Set<string>> {
    const indexes: Record<string, Set<string>> = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set(),
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    for (const order of grid.values()) {
        const stateKey = order.state as string;
        const typeKey = order.type as string;
        if (indexes[stateKey]) indexes[stateKey].add(order.id);
        if (indexes[typeKey]) indexes[typeKey].add(order.id);
    }

    return indexes;
}

/**
 * Validate index consistency (for testing/debugging)
 * @param {Map} grid - Order grid
 * @param {Object} indexes - Index object
 * @returns {Object} - Validation result
 */
function validateIndexes(grid: Map<string, ManagedOrder>, indexes: Record<string, Set<string>>) {
    const errors: string[] = [];

    for (const [id, order] of grid.entries()) {
        const stateIndex = indexes[order.state];
        const typeIndex = indexes[order.type];

        if (!stateIndex || !stateIndex.has(id)) {
            errors.push(`Order ${id} missing from state index ${order.state}`);
        }
        if (!typeIndex || !typeIndex.has(id)) {
            errors.push(`Order ${id} missing from type index ${order.type}`);
        }
    }

    for (const [key, indexSet] of Object.entries(indexes)) {
        for (const id of (indexSet as Set<string>)) {
            if (!grid.has(id)) {
                errors.push(`Orphaned index entry: ${key} has ${id} but not in grid`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

// ================================================================================
// SECTION 9: ORDER COMPARISON & DELTA
// ================================================================================

function _getRelativeTolerance(configOverride?: { gridLimits?: { RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT?: number; [key: string]: unknown } }): number {
    const raw = configOverride?.gridLimits?.RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT
        ?? GRID_LIMITS.RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT;
    return Number(raw) / 100;
}
const ORDER_RELATIVE_TOLERANCE = _getRelativeTolerance();

function getDecimalPlaces(value: number | string) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;

    const text = numeric.toString().toLowerCase();
    if (!text.includes('e')) {
        const parts = text.split('.');
        return parts[1] ? parts[1].length : 0;
    }

    const [mantissa, exponentRaw] = text.split('e');
    const exponent = Number(exponentRaw);
    const dotIndex = mantissa.indexOf('.');
    const mantissaDecimals = dotIndex >= 0 ? (mantissa.length - dotIndex - 1) : 0;
    return Math.max(0, mantissaDecimals - exponent);
}

function parseOptionalPrecision(value: number | string | null | undefined) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return numeric;
}

function precisionToQuantum(precision: number | string | null | undefined) {
    const p = parseOptionalPrecision(precision);
    if (p === null) return null;
    const quantum = MathUtils.quantumForPrecision(p);
    return quantum > 0 ? quantum : Number.EPSILON;
}

function observedQuantum(a: number | string, b: number | string) {
    const maxDecimals = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
    if (maxDecimals <= 0) return Number.EPSILON;
    const quantum = MathUtils.quantumForPrecision(maxDecimals);
    return quantum > 0 ? quantum : Number.EPSILON;
}

function resolveOrderSizePrecision(orderType: OrderType, precisions: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number } = {}) {
    if (!precisions || typeof precisions !== 'object') return null;

    if (orderType === ORDER_TYPES.BUY) return parseOptionalPrecision(precisions.buyPrecision);
    if (orderType === ORDER_TYPES.SELL) return parseOptionalPrecision(precisions.sellPrecision);

    return parseOptionalPrecision(precisions.defaultPrecision);
}

function resolvePriceTolerance(precisions: { priceRelativeTolerance?: number } = {}, order: ManagedOrder | null | undefined, referenceOrder: ManagedOrder | null | undefined) {
    const leftPrice = Number(order?.price);
    const rightPrice = Number(referenceOrder?.price);
    const relativeToleranceRatio = Number(precisions.priceRelativeTolerance);
    if (!Number.isFinite(relativeToleranceRatio) || relativeToleranceRatio < 0) return 0;

    const scale = Math.max(Math.abs(leftPrice || 0), Math.abs(rightPrice || 0));
    return scale * relativeToleranceRatio;
}

function nearlyEqualAbsolute(a: number | string | null, b: number | string | null, tolerance: number | string | null | undefined) {
    const left = Number(a);
    const right = Number(b);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return left === right;
    }

    if (left === right) return true;

    const tol = Number.isFinite(Number(tolerance)) && Number(tolerance) > 0
        ? Number(tolerance)
        : Number.EPSILON;

    return Math.abs(left - right) <= tol;
}

function nearlyEqualRelative(a: number | string | null, b: number | string | null, options: { precision?: number } = {}) {
    const left = Number(a);
    const right = Number(b);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return left === right;
    }

    if (left === right) return true;

    const diff = Math.abs(left - right);
    const scale = Math.max(Math.abs(left), Math.abs(right));
    const configuredPrecisionQuantum = precisionToQuantum(options.precision);
    const minimumTolerance = configuredPrecisionQuantum || observedQuantum(left, right);
    const tolerance = Math.max(scale * ORDER_RELATIVE_TOLERANCE, minimumTolerance);
    return diff <= tolerance;
}

/**
 * Extract order size with fallback
 * @param {Object} order - Order object
 * @returns {number|null} - Size or null if not found
 */
function getOrderSize(order: ManagedOrder | null | undefined): number | null {
    const raw = order?.size;
    if (raw != null && !(typeof raw === 'number' && !Number.isFinite(raw))) {
        return toFiniteNumber(raw);
    }
    return toFiniteNumber(order?.amount);
}

/**
 * Compare two orders for equality
 * @param {Object} a - First order
 * @param {Object} b - Second order
 * @param {Object} [options={}] - Comparison options
 * @param {Object} [options.precisions] - Optional precision hints {buyPrecision, sellPrecision, defaultPrecision, priceRelativeTolerance}
 * @returns {boolean} - True if orders are equivalent
 */
function ordersEqual(a: ManagedOrder | null | undefined, b: ManagedOrder | null | undefined, options: { precisions?: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number }; comparePrecisions?: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number } } = {}) {
    if (!a || !b) return false;
    if (a === b) return true;

    const precisionHints: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number } = options.precisions || options.comparePrecisions || {};
    const sizePrecision = resolveOrderSizePrecision(a.type, precisionHints);
    const priceTolerance = resolvePriceTolerance(precisionHints, a, b);

    return a.id === b.id &&
           a.type === b.type &&
           a.state === b.state &&
           nearlyEqualAbsolute(a.price, b.price, priceTolerance) &&
           nearlyEqualRelative(getOrderSize(a), getOrderSize(b), { precision: sizePrecision ?? undefined }) &&
           a.orderId === b.orderId;
}

/**
 * Build delta actions between master and working grid
 * @param {Map} masterGrid - Source of truth grid
 * @param {Map} workingGrid - Modified working copy
 * @param {Object} [options={}] - Delta options forwarded to ordersEqual
 * @returns {Array} - Array of action objects
 */
function buildDelta(masterGrid: Map<string, ManagedOrder>, workingGrid: Map<string, ManagedOrder>, options: { precisions?: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number }; comparePrecisions?: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number } } = {}): DeltaAction[] {
    const actions: DeltaAction[] = [];

    for (const [id, workingOrder] of workingGrid.entries()) {
        const masterOrder = masterGrid.get(id);

        if (!masterOrder) {
            actions.push({
                type: 'create',
                id,
                order: workingOrder
            });
        } else if (!ordersEqual(workingOrder, masterOrder, options)) {
            actions.push({
                type: 'update',
                id,
                order: workingOrder,
                prevOrder: masterOrder,
                orderId: masterOrder.orderId
            });
        }
    }

    for (const [id, masterOrder] of masterGrid.entries()) {
        if (!workingGrid.has(id)) {
            actions.push({
                type: 'cancel',
                id,
                orderId: masterOrder.orderId
            });
        }
    }

    return actions;
}

// ================================================================================
// SECTION 10: STRATEGY CALCULATIONS
// ================================================================================

/**
 * A pending-crawl ledger entry as consumed by a derivation.
 * `ts` is carried so the commit clears exactly the records the derivation
 * folded — never a newer record for the same slot (recording happens at fill
 * intake, so a slot can be re-recorded between derivation and commit).
 */
type CrawlEntry = { slotId: string; side: string; ts?: number };

/** Normalise a ledger record into the identity the commit clears by. */
function toCrawlEntry(e: { slotId?: unknown; side?: unknown; ts?: unknown } | null | undefined): CrawlEntry {
    return {
        slotId: String(e?.slotId ?? ''),
        side: String(e?.side ?? ''),
        ts: Number.isFinite(Number(e?.ts)) ? Number(e?.ts) : undefined,
    };
}

/**
 * Check whether a fill is eligible to drive boundary shift / rotation.
 * Partials only count when they are delayed-rotation triggers.
 *
 * @param {Object} fill - Fill event
 * @returns {boolean} True when the fill may shift the boundary
 */
function isShiftEligibleFill(fill: { isPartial?: boolean; isDelayedRotationTrigger?: boolean; [key: string]: unknown } | null | undefined): boolean {
    return fill?.isPartial !== true || fill?.isDelayedRotationTrigger === true;
}

function deriveTargetBoundary(fills: Array<{ id?: string; price?: number; type?: string; [key: string]: unknown }> | null | undefined, currentBoundaryIdx: number | null | undefined, allSlots: ManagedOrder[], config: { startPrice?: number | string; genesisStartPrice?: number | string; coreOrders?: { buy?: number; sell?: number; [key: string]: unknown }; [key: string]: unknown } | null | undefined, gapSlots: number, crossChunkBudget?: number | null, pendingCrawls?: Array<{ slotId?: string; side?: string; [key: string]: unknown }> | null, edgeAnchors?: { buy?: number | null; sell?: number | null } | null): { boundaryIdx: number | null; remainingBudget: number; consumedCrawlIds: CrawlEntry[] } {
    let newBoundaryIdx: number | null = currentBoundaryIdx ?? null;

    // Recovery when the committed boundary is unknown (GRID-LOAD rejected a
    // poisoned snapshot, re-derivation failed, and no fill has re-anchored
    // since). Anchor tiers are position signals, weakest last. What must
    // never happen is fabricating a rail-edge boundary from an unresolved
    // config mode string: startPrice "pool" NaN-matches every price
    // comparison, resolving to the rail top (Sep-10: base 213, ceiling 211,
    // then 209 after 4 buy crawls — teleporting the buy rail 113 slots).
    let recovered = false;
    let anchoredFromFills = false;
    if (newBoundaryIdx === undefined || newBoundaryIdx === null) {
        // Tier 1 — live fills: gap-side extreme (highest buy / lowest sell,
        // midpoint when both sides filled). Any fill price, eligible or
        // dust, is real market position and beats every config guess.
        let topBuy = -Infinity;
        let botSell = Infinity;
        for (const fill of fills ?? []) {
            const p = Number(fill?.price);
            if (!Number.isFinite(p)) continue;
            if (fill?.type === ORDER_TYPES.BUY && p > topBuy) topBuy = p;
            if (fill?.type === ORDER_TYPES.SELL && p < botSell) botSell = p;
        }
        let referencePrice: number | null = null;
        if (topBuy > -Infinity && botSell < Infinity) { referencePrice = (topBuy + botSell) / 2; anchoredFromFills = true; }
        else if (topBuy > -Infinity) { referencePrice = topBuy; anchoredFromFills = true; }
        else if (botSell < Infinity) { referencePrice = botSell; anchoredFromFills = true; }
        // Tier 2 — explicit numeric config center.
        if (referencePrice === null) {
            const direct = Number(config?.startPrice);
            if (Number.isFinite(direct)) referencePrice = direct;
        }
        // Tier 3 — frozen genesis center (forwarded by the strategy when
        // config.startPrice is an unresolved mode string).
        if (referencePrice === null) {
    const genesis = Number((config as { genesisStartPrice?: number } | null | undefined)?.genesisStartPrice);
            if (Number.isFinite(genesis)) referencePrice = genesis;
        }
        // Stale-center guard: a Tier-2 numeric config center or a Tier-3
        // genesis center that falls outside the live rail would clamp
        // calculateIdealBoundary onto an edge slot — the same rail-edge
        // fabrication the mode-string fix prevents, just from a stale numeric
        // value. Drop such a reference so the bounded Tier-4 rail center is
        // used instead. Tier-1 fill anchors are exempt: a real (possibly
        // out-of-grid) fill price is live market position and wins everywhere.
        if (!anchoredFromFills && referencePrice !== null && Array.isArray(allSlots) && allSlots.length > 0) {
            let railMin = Infinity;
            let railMax = -Infinity;
            for (const s of allSlots) {
                const p = Number(s?.price);
                if (!Number.isFinite(p)) continue;
                if (p < railMin) railMin = p;
                if (p > railMax) railMax = p;
            }
            if ((Number.isFinite(railMin) && referencePrice < railMin)
                || (Number.isFinite(railMax) && referencePrice > railMax)) {
                orderLogger.debug(
                    `deriveTargetBoundary: recovery center ${referencePrice} outside live rail ` +
                    `[${railMin}, ${railMax}]; using bounded rail center instead of pinning an edge`
                );
                referencePrice = null;
            }
        }
        // Tier 4 — rail center: bounded and wrong by at most half the rail,
        // never a rail-edge fabrication. The next fill batch re-anchors
        // from live prices via Tier 1.
        if (referencePrice === null && Array.isArray(allSlots) && allSlots.length > 0) {
            const centerIdx = railCenterIndex(allSlots.length, gapSlots);
            const centerPrice = Number(allSlots[centerIdx]?.price);
            if (Number.isFinite(centerPrice)) referencePrice = centerPrice;
        }
        if (referencePrice === null) {
            const fallbackCap = Math.max(
                Math.floor((config?.coreOrders?.sell ?? 1) / 2),
                Math.floor((config?.coreOrders?.buy ?? 1) / 2),
                1
            );
            const effectiveBudget = crossChunkBudget ?? fallbackCap;
            return { boundaryIdx: null, remainingBudget: effectiveBudget, consumedCrawlIds: [] };
        }
        newBoundaryIdx = calculateIdealBoundary(allSlots, referencePrice, gapSlots);
        if (!Number.isFinite(newBoundaryIdx) || (newBoundaryIdx as number) < 0) {
            // Empty slot list with a Tier 1-3 reference: no honest index
            // exists (calculateIdealBoundary returns -1). Stay null rather
            // than letting the clamp below fabricate a slot-0 boundary.
            const fallbackCap = Math.max(
                Math.floor((config?.coreOrders?.sell ?? 1) / 2),
                Math.floor((config?.coreOrders?.buy ?? 1) / 2),
                1
            );
            return { boundaryIdx: null, remainingBudget: crossChunkBudget ?? fallbackCap, consumedCrawlIds: [] };
        }
        recovered = true;
    }

    // Apply shift from fills with rate-limiting (edge fills excluded: static insurance).
    let netShift = 0;
    // Edge ladder: fills from edge-pinned edge slots never crawl the
    // boundary — they are static fat-finger insurance, not market movement.
    // `edgeAnchors` (resolveLiveEdgeAnchorPrice) is the same anchor the
    // placement sites use; without it the classification falls back to the
    // config-bound anchor, which can disagree with the slots actually placed.
    // The window exclusion is the same one every placement picker applies: a
    // window that reaches the grid edge (e.g. a keep-low window sitting on
    // the floor) must not let the edge pick land on window members — otherwise
    // a genuine window fill is treated as a static edge fill and never
    // crawls, and the hole is refilled same-side. Unknown geometry
    // (null boundary) fails open to the previous classification.
    const windowBoundaryIdx = (currentBoundaryIdx === null || currentBoundaryIdx === undefined)
        ? newBoundaryIdx
        : currentBoundaryIdx;
    const windowBuyIds = windowIdSetFromSlots(allSlots, config, ORDER_TYPES.BUY, windowBoundaryIdx, gapSlots);
    const windowSellIds = windowIdSetFromSlots(allSlots, config, ORDER_TYPES.SELL, windowBoundaryIdx, gapSlots);
    const edgeBuyIds = edgeOrderIdSet(allSlots, config, ORDER_TYPES.BUY, edgeAnchors?.buy ?? null, windowBuyIds);
    const edgeSellIds = edgeOrderIdSet(allSlots, config, ORDER_TYPES.SELL, edgeAnchors?.sell ?? null, windowSellIds);
    // Pending crawls: fills recorded by earlier batches whose derivation
    // never committed (refused broadcast, P4 abort, or pre-restart loss —
    // the Sep-10 case: 4 fills consumed under a null boundary, crawl lost,
    // restart refilled the holes same-side). Entries for slots in the
    // CURRENT batch are excluded — those fills crawl below as usual;
    // anything older is still owed and shifts here. Edge-slot entries
    // never crawl (static insurance), same as live fills.
    const currentSlotIds = new Set(
        (fills ?? []).map((f) => f?.id).filter((id) => typeof id === 'string' && id.length > 0)
    );
    type LedgerEntry = { slotId?: string; side?: string; ts?: number; [key: string]: unknown };
    const allPending: Array<LedgerEntry & { slotId: string }> = (pendingCrawls ?? [])
        .filter((e): e is LedgerEntry & { slotId: string } => !!e
            && typeof e.slotId === 'string' && e.slotId.length > 0);
    const owedPending = allPending.filter((e) => e
        && !currentSlotIds.has(e.slotId)
        && (e.side === ORDER_TYPES.BUY || e.side === ORDER_TYPES.SELL)
        && !(e.side === ORDER_TYPES.BUY && edgeBuyIds && edgeBuyIds.has(e.slotId))
        && !(e.side === ORDER_TYPES.SELL && edgeSellIds && edgeSellIds.has(e.slotId)));
    /**
     * Ledger records this derivation CONSUMED:
     *   - everything it deliberately never counts (current-batch slots whose
     *     shift comes from `fills`, edge-classified slots which never crawl,
     *     malformed records), and
     *   - the owed entries whose shift it actually APPLIED.
     *
     * `applied` is the (possibly capped) net shift. A capped fold applies only
     * part of the owed net, so only that part may be consumed — the remainder
     * stays owed, or the next derivation would either lose it (clear-all) or
     * apply it twice (keep-all).
     */
    const consumedFor = (applied: number): CrawlEntry[] => {
        const never = allPending.filter((e) => !owedPending.includes(e));
        let appliedEntries: Array<LedgerEntry & { slotId: string }> = [];
        if (cap <= 0) {
            // No cross-chunk budget left: NOTHING was applied, so every owed
            // record stays owed (a net-zero reading here is not a cancellation).
            appliedEntries = [];
        } else if (applied === 0) {
            // A net-zero mix was fully accounted for by cancelling out.
            appliedEntries = owedPending;
        } else {
            // Consume same-side entries up to the applied magnitude; the mixed
            // remainder still nets out to (net - applied) for the next run.
            const dirSide = applied > 0 ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
            appliedEntries = owedPending
                .filter((e) => e.side === dirSide)
                .slice(0, Math.abs(applied));
        }
        return [...never, ...appliedEntries].map(toCrawlEntry);
    };
    /** Every owed record is subsumed (absolute anchor / generation discard). */
    const consumedAll = (): CrawlEntry[] => allPending.map(toCrawlEntry);
    for (const fill of fills ?? []) {
        if (!isShiftEligibleFill(fill)) continue;
        if (fill && fill.type === ORDER_TYPES.BUY && edgeBuyIds && fill.id != null && edgeBuyIds.has(fill.id)) continue;
        if (fill && fill.type === ORDER_TYPES.SELL && edgeSellIds && fill.id != null && edgeSellIds.has(fill.id)) continue;
        if (fill.type === ORDER_TYPES.SELL) netShift++;
        else if (fill.type === ORDER_TYPES.BUY) netShift--;
    }
    if (!anchoredFromFills) {
        // Owed deltas from earlier uncommitted batches shift on top of the
        // current fills. Skipped under an absolute fill anchor: the anchor
        // positions from live market prices, which already reflect all
        // consumed fills — shifting again would double-count.
        for (const e of owedPending) {
            if (e.side === ORDER_TYPES.SELL) netShift++;
            else netShift--;
        }
    }

    // Cap cumulative shift to prevent overreaction from burst fills.
    // Uses a cross-chunk budget managed by the caller — each chunk
    // consumes from the same pool so the total across all chunks
    // never exceeds half the active window.
    // Falls back to a per-call cap when no budget is set.
    const fallbackCap = Math.max(
        Math.floor((config?.coreOrders?.sell ?? 1) / 2),
        Math.floor((config?.coreOrders?.buy ?? 1) / 2),
        1
    );
    const effectiveBudget = crossChunkBudget ?? fallbackCap;
    const cap = Math.min(Math.abs(effectiveBudget), fallbackCap);
    if (recovered && anchoredFromFills) {
        // The anchor already contains this batch's fill information —
        // crawling would double-count the same fills (Sep-10 batch 1:
        // dust-sell anchor 97 plus a +1 crawl would have moved it to 98).
        // The next batch crawls normally from the anchored boundary.
        return {
            boundaryIdx: Math.max(0, Math.min(
                (allSlots.length - gapSlots - 1) >= 0 ? (allSlots.length - gapSlots - 1) : (allSlots.length - 1),
                newBoundaryIdx as number)),
            remainingBudget: effectiveBudget,
            // The absolute fill anchor positions from live prices, which already
            // reflect every owed delta. The remaining delta is NOT added on top
            // (double-count guard), so every record is subsumed regardless of
            // what the cap would have admitted.
            consumedCrawlIds: consumedAll(),
        };
    }
    // A truncated shift (or an exhausted cross-chunk budget) applies only part
    // of the owed net, so the consumed set below is scoped to WHAT WAS APPLIED:
    // the commit must neither lose the remainder (the 2026-10-25 leak: 7 fills,
    // boundary +3 planned, all 7 records dropped) nor leave an applied entry
    // owed for a second pass.
    if (Math.abs(netShift) > cap) {
        netShift = Math.sign(netShift) * cap;
    }
    const remainingBudget = effectiveBudget - Math.abs(netShift);

    newBoundaryIdx += netShift;
    // Clamp boundary — cap at one slot before the gap band's SELL rail.
    // Degenerate geometries (fewer slots than the gap needs) fall back to the
    // legacy length-1 ceiling instead of collapsing the boundary below its
    // current position.
    const gapAwareCeiling = allSlots.length - gapSlots - 1;
    const legacyCeiling = allSlots.length - 1;
    const ceiling = gapAwareCeiling >= 0
        ? gapAwareCeiling
        : Math.max(legacyCeiling, Number(currentBoundaryIdx ?? 0));
    return {
        boundaryIdx: Math.max(0, Math.min(ceiling, newBoundaryIdx)),
        remainingBudget,
        consumedCrawlIds: consumedFor(netShift),
    };
}

/**
 * Apply recorded-but-uncommitted fill crawls to the committed boundary.
 * Fills are recorded at intake (strategy) and consumed by derivation on
 * commit — but a refused broadcast, a plan abort, or a restart in between
 * leaves their crawl owed and the boundary stale. The next derivation
 * incorporates them in-run (pendingCrawls param); this consumes them onto
 * a restored boundary at startup, before reconcile refills holes.
 *
 * Safety: entries are relative deltas, so they apply only onto a FINITE
 * restored boundary (a null boundary is re-anchored absolutely from live
 * fill prices instead — subsuming every owed delta). The candidate is
 * validated placed-order-aware like GRID-LOAD; on failure the entries are
 * dropped rather than stranding live orders. Commits clear the record, so
 * entries present here predate every commit since recording — always owed.
 *
 * @param {unknown} manager - OrderManager (boundaryIdx, orders, config restored)
 * @returns {{applied: boolean, from?: number, to?: number, count?: number, reason?: string}}
 */
export function consumePendingFillCrawls(manager: OrderManagerLike): { applied: boolean; from?: number; to?: number; count?: number; reason?: string } {
    const pending = Array.isArray(manager?._pendingFillCrawls) ? manager._pendingFillCrawls : [];
    if (pending.length === 0) return { applied: false };
    // Clearing marks the grid dirty so the cleared record reaches disk on
    // the next flush — including drop paths (unsafe/null/no-op), whose
    // decisions re-derive identically but whose stale disk entries would
    // otherwise linger until an unrelated write.
    const clear = () => {
        manager._pendingFillCrawls = [];
        if (typeof manager?._markGridDirty === 'function') {
            try { manager._markGridDirty(); } catch { /* best-effort */ }
        }
    };
    // NB: Number(null) === 0 and Number('') === 0 — check null/undefined/''
    // explicitly (the '' case matches runPreBroadcastGuards), or a
    // boundary-less manager would "apply" onto slot 0.
    if (manager?.boundaryIdx === null || manager?.boundaryIdx === undefined || (manager?.boundaryIdx as unknown) === '') {
        clear();
        return { applied: false, reason: 'null-boundary' };
    }
    const boundary = Number(manager?.boundaryIdx);
    if (!Number.isFinite(boundary)) {
        clear();
        return { applied: false, reason: 'null-boundary' };
    }
    const config = manager?.config ?? {};
    const slots: SlotLike[] = Array.from(manager?.orders instanceof Map ? manager.orders.values() : []);
    // Classify with the SAME live anchors the strategy derivation uses, or the
    // two disagree: the config-bound fallback is null for mode-string/relative
    // bounds, so a restart would rank a stale below-rail slot as an edge order and
    // silently drop a crawl the live run recorded as ordinary market movement.
    // The window exclusion must match placement too (same source as the count
    // fix) — a window over the edge must not be read as an edge order, or
    // its owed crawl is dropped instead of applied.
    const windowBuyIds = liveWindowIdSet(manager, ORDER_TYPES.BUY);
    const windowSellIds = liveWindowIdSet(manager, ORDER_TYPES.SELL);
    const edgeBuyIds = edgeOrderIdSet(slots, config, ORDER_TYPES.BUY, resolveLiveEdgeAnchorPrice(manager, 'buy'), windowBuyIds);
    const edgeSellIds = edgeOrderIdSet(slots, config, ORDER_TYPES.SELL, resolveLiveEdgeAnchorPrice(manager, 'sell'), windowSellIds);
    let netShift = 0;
    let count = 0;
    for (const e of pending) {
        if (!e || typeof e.slotId !== 'string' || e.slotId.length === 0) continue;
        if (e.side !== ORDER_TYPES.BUY && e.side !== ORDER_TYPES.SELL) continue;
        if (e.side === ORDER_TYPES.BUY && edgeBuyIds && edgeBuyIds.has(e.slotId)) continue;
        if (e.side === ORDER_TYPES.SELL && edgeSellIds && edgeSellIds.has(e.slotId)) continue;
        netShift += e.side === ORDER_TYPES.SELL ? 1 : -1;
        count++;
    }
    if (count === 0) {
        clear();
        return { applied: false, reason: 'nothing-owed' };
    }
    const coreOrdersCfg = config?.coreOrders;
    const coreOrdersObj = (coreOrdersCfg && typeof coreOrdersCfg === 'object') ? coreOrdersCfg : {};
    const fallbackCap = Math.max(
        Math.floor(Number(coreOrdersObj.sell ?? 1) / 2),
        Math.floor(Number(coreOrdersObj.buy ?? 1) / 2),
        1
    );
    if (Math.abs(netShift) > fallbackCap) netShift = Math.sign(netShift) * fallbackCap;
    // Absent-aware: Number(null) === 0 is finite, so a plain Number() would use
    // a collapsed (0) gap instead of the config-derived fallback and let the
    // ceiling + validatePersistedBoundary run on the wrong band.
    let gapSlots = Format.toKnownNumber(manager?._gapSlots);
    if (!Number.isFinite(gapSlots)) {
        try {
            gapSlots = MathUtils.calculateGapSlots(config?.incrementPercent, config?.targetSpreadPercent, config?.gridLimits);
        } catch {
            gapSlots = 0;
        }
    }
    const ceiling = (slots.length - gapSlots - 1) >= 0 ? (slots.length - gapSlots - 1) : (slots.length - 1);
    const candidate = Math.max(0, Math.min(ceiling, boundary + netShift));
    if (candidate === boundary) {
        clear();
        return { applied: false, reason: 'no-op' };
    }
    let check: { ok: boolean; reason?: string; detail?: string } = { ok: true };
    try {
        check = MathUtils.validatePersistedBoundary(candidate, slots, gapSlots);
    } catch (err) {
        check = { ok: false, reason: 'validator-threw', detail: getErrorMessage(err) };
    }
    if (!check || check.ok !== true) {
        clear();
        return { applied: false, reason: `unsafe: ${check?.reason ?? 'unknown'}${check?.detail ? ` ${check.detail}` : ''}` };
    }
    try {
        manager._restoreBoundary(candidate);
    } catch {
        return { applied: false, reason: 'restore-failed' };
    }
    clear();
    return { applied: true, from: boundary, to: candidate, count };
}

/**
 * Per-side edge count (edge-pinned fat-finger insurance orders).
 * Buy edges pin at the grid floor, sell edges at the grid ceiling.
 * Non-finite/non-integer/negative values disable (0).
 *
 * The legacy numeric form (`edgeOrders: n`) is migrated here at read time
 * to `{ buy: n, sell: 0 }`: the editor seeder rewrites the persisted JSON, but
 * a hand-edited bots.json that bypassed the editor must not have its edge
 * count silently read as 0.
 *
 * @param {Object} config - Bot configuration
 * @param {string} side - 'buy' or 'sell'
 * @returns {number} Edge count for the side (>= 0 integer)
 */
function resolveEdgeCount(config: OrderConfigView | null | undefined, side: string) {
    const key = side === 'sell' ? 'sell' : 'buy';
    const rawEdge = config?.edgeOrders;
    if (typeof rawEdge === 'number') {
        if (side === 'sell') return 0;
        const n = Math.floor(rawEdge);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    const raw = Number(rawEdge?.[key] ?? 0);
    if (!Number.isInteger(raw) || raw < 0) return 0;
    return raw;
}

/**
 * Total edge count across both sides (fee/count totals).
 *
 * @param {Object} config - Bot configuration
 * @returns {number} Total edges (buy + sell)
 */
function resolveEdgeOrders(config: OrderConfigView | null | undefined) {
    return resolveEdgeCount(config, 'buy') + resolveEdgeCount(config, 'sell');
}

/**
 * Edge-pinned order id set for one side, or null when disabled.
 * Type/price-filtered, then ordered by the SAME edge order the placement
 * pickers use (compareEdge via selectEdgeSlots) — single source
 * of truth, so the no-crawl classification can never drift from placement.
 * Anchor: explicit live-grid edge when supplied, otherwise the config-bound
 * fallback (unresolved -> plain rank). Shelf/manual ids (non-slot-N, e.g.
 * fork-kept deep-* orders below the rail) are never edge orders: they would
 * otherwise win the cheapest-first rank and poison the deficit check while
 * the shelf is live (issue #27 follow-up). No-op upstream (grids only mint
 * slot-N).
 *
 * @param {Array<Object>} allSlots - All grid slots (need id/price/type)
 * @param {Object} config - Bot configuration (edge count source)
 * @param {string} orderType - ORDER_TYPES.BUY (floor) or SELL (ceiling)
 * @param {number|null} [anchorPrice] - Explicit edge anchor (live grid edge);
 *   callers that picked slots must pass the SAME anchor so no-crawl
 *   classification matches placement. NB: null/undefined falls back to the
 *   config-bound anchor (unresolved -> plain rank) — unlike
 *   selectEdgeSlots, where null alone means plain rank.
 * @param {Set<string>|null} [excludeIds] - Windowed ids to skip (same set the
 *   placement pickers exclude). Window + edge are additive in every target
 *   (order counts, fees, hold-back), so a window that reaches the grid edge
 *   (e.g. a keep-low window sitting on the floor) must not let the edge pick
 *   land on window members — otherwise counting reads N/N with zero
 *   dedicated edge orders and the deficit never fires (issue #27 follow-up).
 * @returns {Set<string>|null} Edge slot ids, or null when side disabled
 */
function edgeOrderIdSet(allSlots: SlotLike[], config: OrderConfigView | null | undefined, orderType: OrderType, anchorPrice: unknown = null, excludeIds: Set<string> | null = null): Set<string> | null {
    const isSell = orderType === ORDER_TYPES.SELL;
    const side = isSell ? 'sell' : 'buy';
    // Filter by the canonical side type, not the caller's token: the previous
    // per-side resolvers did the same, so a non-canonical token keeps the
    // floor behavior instead of silently matching nothing.
    const type = isSell ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
    const n = resolveEdgeCount(config, side);
    if (n <= 0) return null;
    const ids = new Set<string>();
    if (!Array.isArray(allSlots)) return ids;
    // NB: Number(null) === 0 is finite — null/undefined must mean "no anchor".
    const anchor = anchorPrice == null ? resolveEdgeAnchorPrice(config, side) : Number(anchorPrice);
    const ascending = allSlots
        .filter((s) => s && s.id != null && s.price != null && s.type === type && parseSlotIndex(s.id) !== null)
        .sort((a, b) => Number(a.price) - Number(b.price));
    for (const s of selectEdgeSlots(ascending, n, excludeIds, isSell ? 'ceiling' : 'floor', anchor)) {
        ids.add(String(s.id));
    }
    return ids;
}

/**
 * Window member ids for one side from an explicit slot list and geometry.
 *
 * Mirror of the window every placement picker excludes from its edge
 * pick: in-rail slots of the side (geometry via isSlotInRail), ordered
 * closest to market first (buys: highest price first; sells: lowest first),
 * sliced to the configured coreOrders count. The slice runs over the FULL
 * rail, not just live orders — window membership is geometric (a virtual
 * hole inside the window still blocks the edge pick there), so live-only
 * slices would misclassify live edge orders as window members whenever the
 * window itself is under-filled.
 *
 * Returns null when the boundary geometry is unknown (null boundary): the
 * pickers cannot place edge orders without it either, so callers fail open
 * (no exclusion) and keep their previous classification instead of guessing.
 *
 * @param {Array<Object>} allSlots - Slots (master grid or clone)
 * @param {Object} config - Bot configuration (coreOrders count source)
 * @param {string} orderType - ORDER_TYPES.BUY or SELL
 * @param {number|null|undefined} boundaryIdx - Boundary the rail is derived from
 * @param {number} gapSlots - Gap band size
 * @returns {Set<string>|null} Window slot ids, or null when geometry unknown
 */
function windowIdSetFromSlots(allSlots: SlotLike[], config: OrderConfigView | null | undefined, orderType: OrderType, boundaryIdx: number | null | undefined, gapSlots: number): Set<string> | null {
    try {
        const isSell = orderType === ORDER_TYPES.SELL;
        const type = isSell ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
        const side = isSell ? 'sell' : 'buy';
        const count = Math.max(0, Math.floor(Number(config?.coreOrders?.[side])) || 0);
        if (!(count > 0)) return new Set<string>();
        if (!Array.isArray(allSlots)) return new Set<string>();
        if (boundaryIdx === null || boundaryIdx === undefined || !Number.isFinite(Number(boundaryIdx))) return null;
        const gap = Number.isFinite(Number(gapSlots)) ? Number(gapSlots) : 0;
        const inRail = (o: SlotLike): boolean => MathUtils.isSlotInRail(boundaryIdx, gap, type, o);
        // Same type filter as the window pickers with known geometry: the
        // side's concrete type plus SPREAD placeholders (normalized empties
        // sitting in this side's rail).
        const typeFilter = (o: SlotLike): boolean => !!o && o.id != null && o.price != null && (o.type === type || o.type === ORDER_TYPES.SPREAD);
        const ids = allSlots
            .filter(typeFilter)
            .filter(inRail)
            .sort((a, b) => isSell ? Number(a.price) - Number(b.price) : Number(b.price) - Number(a.price))
            .slice(0, count)
            .map((o) => String(o.id));
        return new Set<string>(ids);
    } catch {
        return null;
    }
}

/**
 * Window member ids for one side from the live manager (see
 * windowIdSetFromSlots). Delegates so the manager and explicit-geometry
 * callers share one definition.
 *
 * @param {unknown} manager - OrderManager (orders Map, config, boundaryIdx)
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @returns {Set<string>|null} Window slot ids, or null when geometry unknown
 */
function liveWindowIdSet(manager: OrderManagerLike, orderType: OrderType): Set<string> | null {
    try {
        if (!manager?.orders || typeof manager.orders.values !== 'function') return new Set<string>();
        const resolved = MathUtils.resolveGapBand(manager);
        if (resolved?.boundaryIdx == null || resolved?.sellStartIdx == null) return null;
        return windowIdSetFromSlots(Array.from(manager.orders.values()), manager.config, orderType, resolved.boundaryIdx, resolved.gapSlots);
    } catch {
        return null;
    }
}

/**
 * Refill-slot wire for the COW boundary hold (single source for both plan
 * producers: the fill-driven COW engine and the divergence fold).
 *
 * The hold keeps the committed boundary when a listed refill is guard-skipped
 * at broadcast — the refill is what justified the plan's boundary shift, so
 * committing the shift without it would strand an empty rail slot past the
 * new boundary. The wire must therefore list only placements that justify the
 * shift:
 *
 *   - CREATE ids of the plan (the slots a fold did not convert into an
 *     UPDATE), minus
 *   - edge-ladder ids. Edge orders are static edge insurance; their fills
 *     never crawl (deriveTargetBoundary filters them), so a guard-skipped
 *     edge order must not pin geometry either. Without this exclusion an edge order
 *     CREATE skipped at the wrong moment (e.g. a floor BUY above the last-fill
 *     pivot while the market dumps below the grid) would hold the boundary for
 *     a cycle although nothing was stranded.
 *
 * Absent/disabled edge orders or an empty action list yield the plain CREATE ids,
 * so callers that never configured edge orders keep the previous behavior.
 *
 * @param {Array<Object>} actions - Optimized COW actions
 * @param {Object} [options]
 * @param {Object} [options.config] - Bot configuration (edge count source)
 * @param {Iterable<Object>} [options.slots] - Master slots (edge classification)
 * @param {{buy?: number|null, sell?: number|null}} [options.edgeAnchors] - Live
 *   edge anchors (same pair the strategy classifies edge fills against)
 * @param {unknown} [options.manager] - OrderManager for the window exclusion (same
 *   set the placement pickers exclude); omit to fall back to the previous
 *   exclusion-free classification (fail-open)
 * @returns {string[]} Refill slot ids (CREATE ids minus edge ids)
 */
function collectRefillSlotIds(actions: CowAction[], options: { config?: OrderConfigView | null; slots?: unknown; edgeAnchors?: { buy?: number | null; sell?: number | null } | null; manager?: OrderManagerLike | null } = {}): string[] {
    const { config = null, slots = null, edgeAnchors = null, manager = null } = options;
    const out: string[] = [];
    if (!Array.isArray(actions)) return out;
    const createIds = actions
        .filter((a) => a?.type === COW_ACTIONS.CREATE && typeof a?.id === 'string' && a.id.length > 0)
        .map((a) => a.id);
    if (createIds.length === 0) return out;
    let edgeIds: Set<string> | null = null;
    if (slots && config) {
        try {
            // Accept a Map (master grid), an array of slots, or any iterable of
            // slot objects. Map entries are [id, slot] pairs, so `.values()` is
            // required — Array.from(map) would hand edgeOrderIdSet pairs.
            const allSlots: SlotLike[] = Array.isArray(slots)
                ? slots as SlotLike[]
                : (slots && typeof (slots as { values?: unknown }).values === 'function'
                    ? Array.from((slots as { values(): Iterable<SlotLike> }).values())
                    : Array.from(slots as Iterable<SlotLike>));
            // Window exclusion keeps classification in agreement with the
            // placement pickers: a window reaching the grid edge must not have
            // its window hole-CREATEs dropped from the wire as if they were
            // edge orders, or a guard-skipped window refill would no longer pin
            // the committed boundary (stranding the hole it failed to fill).
            const windowBuyIds = manager ? liveWindowIdSet(manager, ORDER_TYPES.BUY) : null;
            const windowSellIds = manager ? liveWindowIdSet(manager, ORDER_TYPES.SELL) : null;
            const buyIds = edgeOrderIdSet(allSlots, config, ORDER_TYPES.BUY, edgeAnchors?.buy ?? null, windowBuyIds);
            const sellIds = edgeOrderIdSet(allSlots, config, ORDER_TYPES.SELL, edgeAnchors?.sell ?? null, windowSellIds);
            if (buyIds || sellIds) edgeIds = new Set<string>([...(buyIds ?? []), ...(sellIds ?? [])]);
        } catch { edgeIds = null; }
    }
    for (const id of createIds) {
        // Fail-open on classification errors: an id we cannot prove is an edge order
        // stays in the wire, so the hold keeps its previous (conservative) reach.
        if (edgeIds && edgeIds.has(id)) continue;
        out.push(id);
    }
    return out;
}

/**
 * Resolved bound anchor for edges from CONFIG alone.
 * BUY floor anchors toward minPrice (dip-insurance end), SELL ceiling toward
 * maxPrice (spike-insurance end). Resolves numeric and "Nx" relative forms
 * via resolveConfiguredPriceBound (startPrice-referenced); falls back to the
 * raw numeric bound. Returns null when unresolvable.
 *
 * Known limit: this is the statically resolved config bound, not the
 * gridPrice/AMA-referenced live rail bound. Placement call sites should use
 * resolveLiveEdgeAnchorPrice(manager, side), which prefers the genesis
 * ladder extreme and returns null when there is no usable ladder. Callers that
 * need a fallback (e.g. edgeOrderIdSet) still resolve this config bound when
 * the live anchor is null; the live resolver itself no longer computes it.
 *
 * @param {Object} config - Bot configuration
 * @param {string} side - 'buy' or 'sell'
 * @returns {number|null} Finite anchor price, or null
 */
function resolveEdgeAnchorPrice(config: OrderConfigView | null | undefined, side: string): number | null {
    const isSell = side === 'sell';
    const bound = isSell ? config?.maxPrice : config?.minPrice;
    const mode = isSell ? 'max' : 'min';
    try {
        const anchor = resolveConfiguredPriceBound(bound, Number.NaN, Number(config?.startPrice), mode);
        if (Number.isFinite(anchor)) return anchor;
    } catch (e) { /* fall through to raw bound */ }
    const raw = Number(bound);
    return Number.isFinite(raw) ? raw : null;
}

/** Manager surface the live edge anchor reads (structural view). */
type EdgeAnchorManager = {
    _genesis?: { priceLevels?: readonly unknown[] } | null;
    orders?: { values(): Iterable<unknown> } | null;
    boundaryIdx?: unknown;
    _gapSlots?: unknown;
    config?: unknown;
};

/**
 * Live-grid edge anchor (single source for edge placement).
 *
 * The anchor must come from the geometry the bot is actually trading, never
 * from a config value that can be a mode string ("pool"/"book"), a relative
 * multiplier, or a stale bound, and never from the live slot prices of a grid
 * whose levels have no authority. The only source is the genesis ladder:
 * `_genesis.priceLevels` is the exact ladder the loaded grid was built from —
 * sorted ascending, index-aligned with `slot-<idx>` (assertSlotPriceInvariant),
 * refreshed by initializeGrid, persisted with the grid, and unaffected by the
 * raw-profile re-merge a resync performs. Slot 0 is always on the buy rail and
 * the last level always on the sell rail, so the ladder extremes are the live
 * rail bounds.
 *
 * A manager with no usable ladder returns null. That is the undefined-grid state
 * (INV-GRID-004), which the load and sync gates refuse, not a degraded mode to
 * paper over. The former tiers — the live in-rail slot extreme and the resolved
 * config bound — are gone with the legacy matcher they only existed to cover;
 * any config-bound fallback is now resolved by the individual consumer that
 * wants one (see edgeOrderIdSet), not by this live-edge resolver. The fault
 * itself is reported
 * once per grid generation by the sync-entry gate; this resolver stays silent
 * because it is called from per-fill and per-placement paths.
 *
 * @param {Object} manager - OrderManager (needs _genesis)
 * @param {string} side - 'buy' or 'sell'
 * @returns {number|null} Finite anchor price, or null
 */
function resolveLiveEdgeAnchorPrice(manager: EdgeAnchorManager | null | undefined, side: unknown): number | null {
    const isSell = side === 'sell';

    const levels = manager?._genesis?.priceLevels;
    if (Array.isArray(levels) && levels.length > 0) {
        const extreme = Number(isSell ? levels[levels.length - 1] : levels[0]);
        if (Number.isFinite(extreme) && extreme > 0) return extreme;
    }

    return null;
}

/**
 * Shared anchored edge comparator for edge selection (single source).
 * With a finite anchor: in-bound slots first, nearest the anchor first
 * (floor ascending, ceiling descending); stale out-of-bound slots last,
 * still nearest the anchor first. Without one: plain rank fallback
 * (floor rank-lowest, ceiling rank-highest).
 *
 * @param {Object} a - Slot/order (needs price)
 * @param {Object} b - Slot/order (needs price)
 * @param {string} edge - 'floor' or 'ceiling'
 * @param {number|null} anchorPrice - Resolved bound anchor (null = rank fallback)
 * @returns {number} Comparator result for Array.prototype.sort
 */
function compareEdge(a: SlotLike, b: SlotLike, edge: string, anchorPrice: number | null): number {
    const ceil = edge === 'ceiling';
    // NB: Number(null) === 0 is finite — null/undefined must mean "no anchor".
    const anchor = anchorPrice == null ? Number.NaN : Number(anchorPrice);
    if (!Number.isFinite(anchor)) {
        return ceil ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price);
    }
    const pa = Number(a?.price);
    const pb = Number(b?.price);
    const aIn = ceil ? pa <= anchor : pa >= anchor;
    const bIn = ceil ? pb <= anchor : pb >= anchor;
    if (aIn !== bIn) return aIn ? -1 : 1;
    if (aIn) return ceil ? pb - pa : pa - pb;
    return ceil ? pa - pb : pb - pa;
}

/**
 * Central edge selector: take edge slots from a price-ascending list,
 * skipping already-windowed ids. Both edges anchor at the live grid's own
 * edge (resolveLiveEdgeAnchorPrice) when finite — floor: nearest
 * at/above the live floor first, slots below it rank last; ceiling: nearest
 * at/below the live ceiling first, slots above it rank last. Anchoring to the
 * live edge keeps the edge order on genuine live-rail slots when the grid still
 * carries leftovers from an older bound or the configured bound disagrees
 * with the geometry being traded. Callers pre-filter rail/type and apply
 * their own size gates; this only picks positions. A null anchor degrades to
 * plain rank (floor: lowest first; ceiling: highest first).
 *
 * @param {Array<Object>} sortedAsc - Slots sorted by price ascending
 * @param {number} count - Edge count
 * @param {Set<string>|null} excludeIds - Windowed ids to skip
 * @param {string} edge - 'floor' or 'ceiling'
 * @param {number|null} [anchorPrice] - Live edge anchor for the side (null = rank-based)
 * @returns {Array<Object>} Edge slots (ascending for floor, descending for ceiling)
 */
function selectEdgeSlots<T extends SlotLike>(sortedAsc: T[], count: number, excludeIds: Set<string> | null, edge: string, anchorPrice: number | null = null): T[] {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 0 || !Array.isArray(sortedAsc)) return [];
    const avail = sortedAsc.filter((s) => s && s.id != null && (!excludeIds || !excludeIds.has(s.id)));
    // NB: Number(null) === 0 is finite — null/undefined must mean "no anchor".
    const anchor = anchorPrice == null ? Number.NaN : Number(anchorPrice);
    if (!Number.isFinite(anchor)) {
        // No anchor: plain rank fallback (avail arrives ascending) —
        // floor rank-lowest, ceiling rank-highest.
        return edge === 'ceiling' ? avail.slice(-n).reverse() : avail.slice(0, n);
    }
    // Anchored: shared comparator — in-bound slots nearest the bound first,
    // stale out-of-bound slots last.
    return avail
        .sort((x, y) => compareEdge(x, y, edge, anchor))
        .slice(0, n);
}

/**
 * Total target order count across both sides (used for BTS fee calculation).
 * Single source of truth so every budget derivation sizes identically.
 * Includes per-side edge orders: they rest live on-chain and pay creation fees.
 *
 * @param {Object} config - Bot configuration
 * @returns {number} Total target order count
 */
function getCoreOrdersTotal(config: OrderConfigView | null | undefined) {
    const coreOrders = config?.coreOrders;
    return Math.max(0, coreOrders?.buy ?? 1) +
        Math.max(0, coreOrders?.sell ?? 1) +
        resolveEdgeOrders(config);
}
/**
 * Calculate side budget after BTS fee deduction.
 *
 * @param {string} side - 'buy' or 'sell'
 * @param {Object} funds - Snapshot of allocated funds
 * @param {Object} config - Bot configuration
 * @param {number} totalTarget - Total target order count (used for BTS fee calculation on both sides)
 * @returns {number} Available budget for the side
 */
function getSideBudget(side: string, funds: ManagerFundsLike | ProjectedFunds | null, config: OrderConfigView, totalTarget: number) {
    if (!funds) return 0;
    const isBuy = side === 'buy';
    const allocated = isBuy ? (funds.allocatedBuy || 0) : (funds.allocatedSell || 0);
    if (allocated <= 0) return 0;

    const btsOrderType = MathUtils.getBtsSide(config?.assetA, config?.assetB);
    const isBtsSide = isBuy ? (btsOrderType === ORDER_TYPES.BUY) : (btsOrderType === ORDER_TYPES.SELL);

    // Non-BTS side without btsBalance data: no fee adjustment to make.
    if (!isBtsSide && !funds.btsBalance) return allocated;

    const btsReservationMultiplier = config?.feeParams?.BTS_RESERVATION_MULTIPLIER ?? FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;
    const formulaBudget = MathUtils.calculateOrderCreationFees(
        config.assetA, config.assetB, totalTarget,
        btsReservationMultiplier
    );

    if (isBtsSide) {
        return MathUtils.adjustBudgetForBtsFees(allocated, true, formulaBudget, 0, 0, 0, 0);
    }

    return MathUtils.adjustBudgetForBtsFees(
        allocated,
        false,
        formulaBudget,
        config.min_BTS_value || 0,
        funds.btsBalance?.free || 0,
        isBuy ? (funds.allocatedBuy || funds.chainFreeBuy || 0) : (funds.allocatedSell || funds.chainFreeSell || 0),
        (funds.allocatedBuy || funds.chainFreeBuy || 0) + (funds.allocatedSell || funds.chainFreeSell || 0),
    );
}

/**
 * Calculate sizes for all slots on a side using weighted distribution.
 *
 * @param {Array} slots - Array of slots for the side
 * @param {string} side - 'buy' or 'sell'
 * @param {number} budget - Total budget for the side
 * @param {number} weightDist - Weight distribution factor
 * @param {number} incrementPercent - Grid increment percentage
 * @param {Object} assets - Asset metadata for precision
 * @returns {Array} Array of calculated sizes
 */
function calculateBudgetedSizes(slots: SlotLike[], side: string, budget: number, weightDist: unknown, incrementPercent: number | undefined, assets: AssetPair | null) {
    const isBuy = side === 'buy';

    let precision;
    if (assets?.assetA && assets?.assetB) {
        try {
            const { A: precA, B: precB } = MathUtils.getPrecisionsForManager(assets);
            precision = isBuy ? precB : precA;
        } catch (e) {
            // Precision not available — floatToBlockchainInt will throw
        }
    }

    const incrementFactor = Number(incrementPercent) / 100;

    return MathUtils.allocateFundsByWeights(
        budget,
        slots.length,
        weightDist,
        incrementFactor,
        isBuy, // Reverse for BUY (Market-Close is last in array)
        0,
        precision
    );
}

// ================================================================================
// SECTION: COW batch-shared pure helpers (moved from dexbot_cow_runtime.ts —
// no bot dependency; shared by the COW runtime and any future consumer).
// ================================================================================

/**
 * Whether a chain order still matches the cached pre-update state the
 * limit_order_update delta was built from. Only a provably-unchanged order
 * makes a re-broadcast of the identical delta safe (it applies to the same
 * base). Any other state (target applied, filled, resized) must defer.
 * @param {Object} chainOrder - Raw chain order object (get_full_accounts)
 * @param {Object|null} cachedRaw - The rawOnChain cache captured at build time
 * @returns {boolean}
 */
function chainOrderUnchangedFromCache(chainOrder: ChainOrder | null | undefined, cachedRaw: { sell_price?: { base?: { amount?: unknown }; quote?: { amount?: unknown } }; for_sale?: unknown } | null | undefined) {
    if (!chainOrder || !cachedRaw) return false;
    const base = chainOrder.sell_price?.base;
    const quote = chainOrder.sell_price?.quote;
    const cachedBase = cachedRaw.sell_price?.base?.amount;
    const cachedQuote = cachedRaw.sell_price?.quote?.amount;
    const cachedForSale = cachedRaw.for_sale;
    if (base === undefined || quote === undefined) return false;
    if (cachedForSale === undefined || cachedBase === undefined || cachedQuote === undefined) return false;
    return String(base.amount ?? '') === String(cachedBase)
        && String(quote.amount ?? '') === String(cachedQuote)
        && String(chainOrder.for_sale ?? '') === String(cachedForSale);
}

/**
 * PRE-BROADCAST CROSSED-BOOK ASSERT (defense-in-depth, any-writer detection).
 *
 * Simulates the post-batch book: currently placed master orders plus this
 * batch's action overlay (CREATEs add, CANCELs remove, UPDATEs reprice/move).
 * Returns a detail string when a planned BUY would price at-or-above a planned
 * SELL — a state no honest planner produces — so the caller can refuse the
 * broadcast instead of paying for adverse fills.  Placed order prices are
 * independent of grid geometry, so this catches boundary overruns regardless
 * of which writer produced them.
 *
 * Detector only: any internal failure returns null (never blocks a broadcast).
 */
function detectCrossedBookPlan(manager: OrderManagerLike, actions: CowAction[]): string | null {
    try {
        const startPrice = Number(manager?.config?.startPrice);
        const book = new Map<string, { type: string; price: number }>();
        for (const o of manager.orders.values()) {
            if (!o || !o.orderId || o.price == null) continue;
            const price = Number(o.price);
            if (!Number.isFinite(price)) continue;
            let type = o.type;
            if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) {
                // Legacy SPREAD-typed placed order: derive side from the same
                // price-vs-startPrice convention used across the codebase.
                if (!Number.isFinite(startPrice)) continue;
                type = price < startPrice ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
            }
            book.set(String(o.id), { type, price });
        }
        for (const a of actions ?? []) {
            const id = String(a.id ?? a.orderId ?? '');
            if (a.type === COW_ACTIONS.CANCEL) {
                if (id) book.delete(id);
            } else if (a.type === COW_ACTIONS.UPDATE) {
                const newPrice = Number(a.newPrice ?? a.order?.price);
                const newType = a.order?.type;
                if (id && Number.isFinite(newPrice)) {
                    const entry = book.get(id);
                    const type = (newType === ORDER_TYPES.BUY || newType === ORDER_TYPES.SELL)
                        ? newType
                        : entry?.type;
                    if (entry) book.delete(id);
                    const key = String(a.newGridId ?? id);
                    if (type === ORDER_TYPES.BUY || type === ORDER_TYPES.SELL) {
                        book.set(key, { type, price: newPrice });
                    }
                }
            } else if (a.type === COW_ACTIONS.CREATE) {
                const price = Number(a.order?.price);
                const type = a.order?.type;
                if (!Number.isFinite(price) || (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL)) continue;
                if (id) book.set(id, { type, price });
            }
        }
        let maxBuy = -Infinity;
        let minSell = Infinity;
        for (const { type, price } of book.values()) {
            if (type === ORDER_TYPES.BUY && price > maxBuy) maxBuy = price;
            else if (type === ORDER_TYPES.SELL && price < minSell) minSell = price;
        }
        if (Number.isFinite(maxBuy) && Number.isFinite(minSell) && minSell <= maxBuy) {
            return `bestPlacedBuy=${maxBuy} >= bestPlacedSell=${minSell}`;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Collect every on-chain order id master currently needs to converge against,
 * so adoption can re-read them by id (immune to the get_full_accounts window
 * truncation) instead of relying on a partial window read.
 *
 * Sources:
 *  - master's own tracked order ids (existing on-chain orders);
 *  - the batch's fresh CREATE ids extracted from the broadcast result
 *    (operation_results[i][1] aligns positionally with placedContexts[i]).
 *
 * @param {unknown} mgr - bot.manager
 * @param {unknown} placedResults - broadcast result (has operation_results); null when unavailable
 * @param {unknown[]} placedContexts - opContexts (aligned with operation_results); null when unavailable
 * @param {string[]|null} [extraCreateIds=null] - fresh CREATE chain ids from another
 *   authoritative source (e.g. the uncertain-broadcast poll confirmation) when
 *   no broadcast result exists; merged into createIds so the lagging-create
 *   retry guards them
 * @returns {string[]} Unique, well-formed 1.7.x order ids
 */
function collectKnownOnChainOrderIds(mgr: OrderManagerLike, placedResults: unknown, placedContexts: Array<{ kind?: string; order?: { orderId?: string | null } | null; rotation?: { oldOrder?: { orderId?: string | null } | null } | null; updateInfo?: { partialOrder?: { orderId?: string | null } | null } | null } | null> | null, extraCreateIds: string[] | null = null): { masterIds: string[]; createIds: string[]; all: string[] } {
    const masterIds = new Set<string>();
    const grid = (mgr as { grid?: unknown }).grid as SlotLike[] | undefined;
    if (Array.isArray(grid)) {
        for (const slot of grid) {
            if (slot && slot.orderId && /^1\.7\.\d+$/.test(String(slot.orderId))) {
                masterIds.add(String(slot.orderId));
            }
        }
    }
    // Master tracked ids live in the orders Map (mgr.grid is legacy and
    // unset on OrderManager — without this the by-id set omits every
    // pre-existing ACTIVE order and pass-1 phantom cleanup would virtualize
    // them as fills on a partial snapshot).
    if (mgr && mgr.orders instanceof Map) {
        for (const slot of mgr.orders.values()) {
            if (slot && slot.orderId && /^1\.7\.\d+$/.test(String(slot.orderId))) {
                masterIds.add(String(slot.orderId));
            }
        }
    }
    const createIds = new Set<string>();
    if (placedResults && Array.isArray(placedContexts)) {
        const opResults = extractBatchOperationResults(placedResults);
        if (Array.isArray(opResults)) {
            for (let i = 0; i < placedContexts.length; i++) {
                const ctx = placedContexts[i];
                if (!ctx || ctx.kind !== 'create') continue;
                const rawOpResult = opResults[i] ? opResults[i][1] : undefined;
                const opResult = typeof rawOpResult === 'string' ? rawOpResult : null;
                if (opResult && /^1\.7\.\d+$/.test(opResult)) {
                    createIds.add(opResult);
                }
            }
        }
    }
    if (Array.isArray(extraCreateIds)) {
        for (const id of extraCreateIds) {
            if (id && /^1\.7\.\d+$/.test(String(id))) createIds.add(String(id));
        }
    }
    // Existing chain ids referenced by non-create op contexts (cancel /
    // rotation / size-update) are already live: they belong to the master set
    // (cancels/fills in this batch), so they join the by-id set but never
    // the lagging-create guard.
    if (Array.isArray(placedContexts)) {
        for (const ctx of placedContexts) {
            if (!ctx || ctx.kind === 'create') continue;
            const refs: Array<string | null | undefined> = [];
            if (ctx.kind === 'cancel' && ctx.order) refs.push(ctx.order.orderId);
            else if (ctx.kind === 'rotation' && ctx.rotation?.oldOrder) refs.push(ctx.rotation.oldOrder.orderId);
            else if (ctx.kind === 'size-update' && ctx.updateInfo?.partialOrder) refs.push(ctx.updateInfo.partialOrder.orderId);
            for (const id of refs) {
                if (id && /^1\.7\.\d+$/.test(String(id))) masterIds.add(String(id));
            }
        }
    }
    const all = new Set<string>([...masterIds, ...createIds]);
    return { masterIds: [...masterIds], createIds: [...createIds], all: [...all] };
}

export { parseChainOrder, resolveLiveOrderLadderPosition, applyChainSizeToGridOrder,  buildFillKey, correctOrderPriceOnChain, correctAllPriceMismatches, _validatePriceCorrectionEntry, _stampCorrectionProvenance, findLiveOrderOwnerByChainId, buildCreateOrderArgs, getOrderTypeFromUpdatedFlags, resolveConfiguredPriceBound, virtualizeOrder, convertToSpreadPlaceholder, toRailHolePlaceholder, geometryTypeForSlotIndex, detectGapEvacuationCandidates, updateGapEvacuationStreaks, resolveSpreadOrderSide, chainOrderMatchesSlot, chainOrderMatchesSlotWithTolerance, crossingCandidateChainId, isCrossingCheckCandidate, buildCrossingCheckCandidates, parseSlotIndex, filterOrdersByType, buildOutsideInPairGroups, extractBatchOperationResults, formatUnmatchedChainOrder, isNonBlockingUnmatchedOrder, isStrandedHoldOrder, isOrderOnChain, isOrderVirtual, hasOnChainId, isOrderPlaced, isPhantomOrder, isSlotAvailable, isEmptyGridSlot, isOrderHealthy, checkSizeThreshold, checkSizesBeforeMinimum, calculateIdealBoundary, assignGridRoles, resolveOnChainRetypeType, shouldFlagOutOfSpread, buildIndexes, validateIndexes, ordersEqual, buildDelta, deriveTargetBoundary, isShiftEligibleFill, resolveEdgeCount, resolveEdgeOrders, selectEdgeSlots, getCoreOrdersTotal, getSideBudget, calculateBudgetedSizes, buildCreateOpFingerprint, isOrderGoneErrorMessage, recordDuplicateOrphanDetection, clearDuplicateOrphanDetection, duplicateOrphanLogInfo, chainOrderUnchangedFromCache, detectCrossedBookPlan, collectKnownOnChainOrderIds, edgeOrderIdSet, liveWindowIdSet, checkGridPriceInvariant, reportGridPriceInvariant };
export type { CrawlEntry }
export { resolveEdgeAnchorPrice, resolveLiveEdgeAnchorPrice, compareEdge, collectRefillSlotIds, recordOrderPlacement, isFreshlyPlacedOrder, _filterUnmatchedChainOrders };


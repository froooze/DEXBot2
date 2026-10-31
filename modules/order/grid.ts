/**
 * modules/order/grid.ts - Grid Engine
 *
 * Order grid creation, synchronization, and health management.
 * Exports plain functions for grid operations.
 *
 * Manages the complete lifecycle of the order grid:
 * - Creates geometric price grids with configurable spacing (increments)
 * - Synchronizes grid state with blockchain and fund changes
 * - Monitors grid health and handles spread corrections
 * - Calculates order sizes and allocations based on funds
 * - Detects and flags out-of-spread conditions
 *
 * ===============================================================================
 * TABLE OF CONTENTS - Grid Functions (34 exports)
 * ===============================================================================
 *
 * CONFIGURATION & CALCULATION (2 functions)
 *   1. resolveRmsThresholdPct(manager) - Resolve the structural-divergence threshold
 *   2. calculateGapSlots(incrementPercent, targetSpreadPercent) - Calculate spread gap size
 *
 * GRID SIZING & CONTEXT (1 function)
 *   3. _getSizingContext(manager, side, options) - Get budget and sizing parameters
 *      Determines budget from allocated funds and optionally deducts BTS fees
 *
 * GRID CREATION (1 function)
 *   4. createOrderGrid(config) - Create geometric price grid
 *      Returns price levels from minPrice to maxPrice with increment spacing
 *
 * GRID LOADING & INITIALIZATION (2 functions - async)
 *   5. loadGrid(manager, grid, boundaryIdx, genesisInput, options) - Load grid into manager orders
 *   6. initializeGrid(manager) - Full grid initialization from config
 *
 * GRID RECALCULATION (1 function - async)
 *   7. recalculateGrid(manager, opts) - Recalculate grid based on current state
 *
 * GRID STATE CHECKING (2 functions)
 *   8. checkAndUpdateGridIfNeeded(manager) - Complete fund trigger: available-
 *       funds ratio + over-allocation + on-chain committed-drift legs
 *   9. checkCommittedSizeDrift(manager) - Async committed-drift-only accessor
 *       (the drift core is folded into checkAndUpdateGridIfNeeded)
 *
 * BLOCKCHAIN SYNCHRONIZATION (2 functions - async)
 *  10. _recalculateGridOrderSizesFromBlockchain(manager, orderType, options) - Recalculate sizes from blockchain
 *  11. updateGridFromBlockchainSnapshot(manager, orderType, fromBlockchainTimer, overrideBoundaryIdx) - Update grid from blockchain
 *
 * GRID COMPARISON (2 functions - async)
 *  12. compareGrids(calculatedGrid, persistedGrid, manager) - Compare two grids
 *       Validates grid structure and reports divergence metrics
 *  13. monitorDivergence(manager, calculatedGrid, persistedGrid) - Unified divergence check
 *       Runs ratio-based + RMS-based checks and returns combined result
 *
 * SPREAD MANAGEMENT (2 functions)
 *  14. calculateCurrentSpread(manager) - Calculate current bid-ask spread
 *  15. checkSpreadCondition(manager, BitShares, updateOrdersOnChainBatch) - Check and flag spread condition
 *
 * GRID HEALTH MONITORING (4 functions)
 *  16. checkGridHealth(manager, updateOrdersOnChainBatch) - Monitor grid health
 *  17. checkWindowDust(manager) - Dust check scoped to the active buy/sell window
 *  18. hasAnyDust(manager, partials, side) - Check for dust orders
 *  19. getDustOrders(manager, partials, side) - Get dust order IDs
 *
 * SIDE SELECTION (1 function)
 *  20. determineOrderSideByFunds(manager, currentMarketPrice) - Determine priority side
 *
 * SPREAD CORRECTION PLANNING (11 exports)
 *  21. SPREAD_CORRECTION_REFUSAL - Refusal-cause vocabulary constant
 *  22. SpreadCorrectionRefusalCause - Refusal-cause union type
 *  23. isTransientSpreadRefusal(cause) - Whether a refusal cause is retryable
 *  24. classifySpreadRefusalCause(...) - Classify why a correction batch did not land
 *  25. recordSpreadCorrectionRefusal(...) - Record a refusal on the manager
 *  26. recordSpreadCorrectionRetry(...) - Count a bounded re-plan retry
 *  27. getOccupiedCorrectionSlots(...) - Planned CREATE destinations already occupied
 *  28. replanSpreadCorrectionFromFreshMaster(...) - Re-plan from the current master
 *  29. OccupiedCorrectionResolution - Outcome of plan-time collision resolution
 *  30. resolveOccupiedCorrection(...) - Resolve a correction whose destination was taken
 *  31. prepareSpreadCorrectionOrders(...) - Prepare orders to correct a wide spread
 *
 * BLOAT STATUS (3 functions)
 *  32. isGridBloated(manager, orders) - Check whether the grid is bloated
 *  33. isGridBloatGraceActive(manager) - Check the bloat grace state
 *  34. clearGridBloatFlag(manager) - Clear the bloat state
 *
 * ===============================================================================
 *
 * GRID STRUCTURE:
 * Grid = Array of slots with:
 * - id: Order ID (null for virtual)
 * - price: Price level
 * - size: Grid allocation
 * - grid: In-grid size (ACTIVE + PARTIAL orders)
 * - blockchain: On-blockchain size
 * - type: BUY, SELL, or SPREAD
 * - state: VIRTUAL, ACTIVE, PARTIAL
 *
 * GRID LIFECYCLE:
 * 1. createOrderGrid(config) - Generate price levels
 * 2. assignGridRoles() - Assign BUY/SELL/SPREAD roles based on boundary
 * 3. calculateOrderSizes() - Allocate funds to slots
 * 4. loadGrid() - Create grid Order objects in manager
 * 5. syncFromOpenOrders() - Load blockchain state
 * 6. recalculateGrid() - Keep in sync as market/funds change
 *
 * ===============================================================================
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, COW_ORIGINS, DEFAULT_CONFIG, GRID_LIMITS, TIMING, PIPELINE_TIMING, MARKET_ADAPTER, INCREMENT_BOUNDS } from '../constants.js';
import * as Format from './format.js';
import {
    resolveMaxAsymmetryFactor,
    applyAsymmetricBounds,
    applyNarrowingSideGuard,
} from '../../market_adapter/core/asymmetric_bounds.js';

// FIX: Extract magic numbers to named constants for maintainability
const GRID_CONSTANTS = {
    RMS_PERCENTAGE_SCALE: 100,  // Convert RMS percentage threshold from percent to decimal
};

type FundStateSnapshot = { buyFree: number; buyLocked: number; sellFree: number; sellLocked: number };

interface SpreadCorrectionRotation {
    id: string;
    orderId: string;
    oldOrder: ManagedOrder;
    newGridId: string;
    newPrice: number;
    newSize: number;
    type: OrderType;
}

interface SpreadCorrection {
    ordersToPlace: ManagedOrder[];
    // Create-only since the spread repair stopped top-uping partials (a PARTIAL
    // cannot be grown in place — clampPostFillUpdateSize). Kept as an explicit
    // empty array because updateOrdersOnChainBatch expects the field.
    ordersToUpdate: Array<{ partialOrder: ManagedOrder; newSize: number }>;
    // Fund-constrained promotion: when free funds cannot fund a tightening
    // create, move a resting same-side order into the promoted slot instead
    // (same booked size or smaller, never a new commitment). This is the only
    // repair path for a fully allocated rail; a plain CREATE would read 0 free
    // forever. Produced by prepareSpreadCorrectionOrders, consumed by
    // buildActionsFromPlan as an UPDATE rotation.
    ordersToRotate?: SpreadCorrectionRotation[];
    // Number of spread-tightening create targets found before the funding loop
    // ran. Lets the caller distinguish "no actionable candidate exists" from
    // "candidates existed but free funds could not fund any" (see
    // SpreadCorrectionStall). 0 whenever the candidate search itself was empty.
    plannedCount?: number;
    // Why no create target was produced when plannedCount is 0. A zero sizing
    // budget is a FUND condition ('unfunded'), not a structural one, so the
    // caller must not misclassify it as 'no-candidates' and suppress a refresh
    // that could actually repair a stale-balance read.
    stallHint?: SpreadCorrectionStall;
    boundaryIdx?: number;
    origin?: string;
    [key: string]: unknown;
}

interface PrioritizedTarget {
    kind: 'create';
    order: ManagedOrder;
    ideal: number;
}

/**
 * Fold a prepared correction (or the absence of one) into the stall cause the
 * caller reports. A plan that existed but funded nothing ('unfunded'), or a
 * zero sizing budget ('stallHint: unfunded'), is a FUND condition. The named
 * structural causes ('cold-book', 'unmatched-orders', 'readiness-gate') are
 * preserved verbatim; anything else is 'no-candidates'. The two sides are
 * merged with this so an unfunded plan on one side is never masked by an empty
 * plan on the other (e.g. chosen side planned 1 / placed 0, opposite 0).
 */
function classifySpreadStall(c: SpreadCorrection | null | undefined): SpreadCorrectionStall {
    const hint = c?.stallHint;
    // A plan that existed but funded nothing is a FUND condition and must win
    // over any structural hint (those are only set on empty returns today, but
    // the precedence is explicit so a future hint can never mask 'unfunded').
    if (Number(c?.plannedCount || 0) > 0 || hint === 'unfunded') return 'unfunded';
    // Preserve the named causes verbatim; they are operationally distinct (one
    // wants a sync, one wants a re-center) and the watchdog keys its escalation
    // window off them.
    if (hint === 'cold-book' || hint === 'unmatched-orders' || hint === 'readiness-gate'
        || hint === 'last-fill-blocked') return hint;
    return 'no-candidates';
}

/**
 * Merge two side stalls so the starvation fallback cannot mask a named cause.
 * 'unfunded' stays top (a refresh may repair it); 'unmatched-orders' next (a
 * sync repairs it); then the geometry bind; readiness causes; 'no-candidates'
 * is the floor. Exported for tests.
 */
export function mergeSpreadStalls(
    a: SpreadCorrectionStall | undefined,
    b: SpreadCorrectionStall | undefined
): SpreadCorrectionStall {
    const rank: Record<string, number> = {
        'unfunded': 5,
        'no-free-funds': 5,
        'unmatched-orders': 4,
        'last-fill-blocked': 3,
        'cold-book': 2,
        'readiness-gate': 2,
        'no-candidates': 1,
        'batch-not-executed': 1,
        'apply-error': 1
    };
    const ra = rank[String(a)] ?? 0;
    const rb = rank[String(b)] ?? 0;
    return (rb > ra ? String(b) : String(a)) as SpreadCorrectionStall;
}

/**
 * Spread-correction refusal causes — the single vocabulary shared by
 * classifySpreadRefusalCause, the retry/transience decision and the
 * spreadCorrectionRefusalCauses metric key. Keep every reader/writer keyed off
 * this map so a new cause cannot leave classification and transience out of
 * sync.
 */
export const SPREAD_CORRECTION_REFUSAL = Object.freeze({
    /** Post-broadcast working-grid commit rejected (orders may already be on chain). */
    COMMIT_REFUSED: 'commit-refused',
    /** Plan went stale / skipped before broadcast (base-version mismatch). */
    VERSION_MISMATCH: 'version-mismatch',
    /** A tracked UPDATE target was gone on chain (COW pre-broadcast guard). */
    UPDATE_TARGET_MISSING: 'update-target-missing',
    /** Destination slot already held an active order (plan-time dedupe). */
    CREATE_COLLISION: 'create-collision',
    /** Unmatched chain orders blocked the CREATE batch. */
    UNMATCHED_CHAIN_ORDERS: 'unmatched-chain-orders',
    /** Shutdown began while the batch was in flight. */
    SHUTDOWN: 'shutdown',
    /** Unclassified non-execution (fallback). */
    BATCH_NOT_EXECUTED: 'batch-not-executed'
} as const);

export type SpreadCorrectionRefusalCause =
    (typeof SPREAD_CORRECTION_REFUSAL)[keyof typeof SPREAD_CORRECTION_REFUSAL];

/**
 * Causes the bounded in-cycle re-plan can heal. `commit-refused` is deliberately
 * EXCLUDED: the batch reached the chain (chain adoption runs), so it is not a
 * clean pre-broadcast staleness a fresh-master re-plan repairs — it should count
 * toward the persistent-stale watchdog instead.
 */
const TRANSIENT_SPREAD_CORRECTION_REFUSALS: ReadonlySet<SpreadCorrectionRefusalCause> = new Set([
    SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH,
    SPREAD_CORRECTION_REFUSAL.CREATE_COLLISION,
    SPREAD_CORRECTION_REFUSAL.BATCH_NOT_EXECUTED
]);

/**
 * Whether a refusal cause is retryable by the bounded spread-correction re-plan.
 * @param {string} cause - A SPREAD_CORRECTION_REFUSAL value
 * @returns {boolean}
 */
export function isTransientSpreadRefusal(cause: SpreadCorrectionRefusalCause): boolean {
    return TRANSIENT_SPREAD_CORRECTION_REFUSALS.has(cause);
}

/**
 * P0 observability: classify WHY a spread-correction batch did not land
 * (executed !== true) from the COW batch result. Counter-only — never gates
 * placement. Returns a SPREAD_CORRECTION_REFUSAL value so the metric key, the
 * retry decision and the log all share one vocabulary.
 * @param {Object|null} batchResult - The COW batch result
 * @returns {string} A SPREAD_CORRECTION_REFUSAL value
 */
export function classifySpreadRefusalCause(batchResult: unknown): SpreadCorrectionRefusalCause {
    const r = (batchResult ?? {}) as Record<string, unknown>;
    const reason = String(r.reason ?? '').toUpperCase();
    if (r.commitRefused === true) return SPREAD_CORRECTION_REFUSAL.COMMIT_REFUSED;
    if (reason === 'UPDATE_TARGET_MISSING') return SPREAD_CORRECTION_REFUSAL.UPDATE_TARGET_MISSING;
    if (reason === 'UNMATCHED_CHAIN_ORDERS') return SPREAD_CORRECTION_REFUSAL.UNMATCHED_CHAIN_ORDERS;
    if (reason === 'SHUTDOWN_IN_PROGRESS') return SPREAD_CORRECTION_REFUSAL.SHUTDOWN;
    if (r.skippedStalePlan === true || reason.includes('STALE') || reason.includes('MISMATCH') || reason.includes('BASE VERSION')) return SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH;
    if (reason.includes('COLLISION') || reason.includes('EXISTING') || reason.includes('DUPLICATE')) return SPREAD_CORRECTION_REFUSAL.CREATE_COLLISION;
    return SPREAD_CORRECTION_REFUSAL.BATCH_NOT_EXECUTED;
}

/**
 * P0 observability: record a spread-correction refusal on the manager's
 * metrics (the only object reachable from this planner; getMetrics overlays
 * these onto the bot's counters). Counter-only; never throws, never gates.
 * @param {Object} manager - OrderManager instance
 * @param {string} cause - A SPREAD_CORRECTION_REFUSAL value
 */
export function recordSpreadCorrectionRefusal(manager: OrderManagerLike, cause: SpreadCorrectionRefusalCause): void {
    try {
        const m = (manager as unknown as { _metrics?: Record<string, unknown> })?._metrics;
        if (!m) return;
        m.spreadCorrectionRefusedCount = (Number(m.spreadCorrectionRefusedCount) || 0) + 1;
        const causes: Record<string, number> = (m.spreadCorrectionRefusalCauses && typeof m.spreadCorrectionRefusalCauses === 'object')
            ? m.spreadCorrectionRefusalCauses as Record<string, number>
            : (m.spreadCorrectionRefusalCauses = {});
        causes[cause] = (Number(causes[cause]) || 0) + 1;
    } catch { /* metrics are best-effort */ }
}

/**
 * P5 observability: count a bounded spread-correction re-plan retry. Churn
 * signal — a rising retry rate means concurrent commits are repeatedly
 * invalidating corrections. Counter-only; never throws.
 * @param {Object} manager - OrderManager instance
 */
export function recordSpreadCorrectionRetry(manager: OrderManagerLike): void {
    try {
        const m = (manager as unknown as { _metrics?: Record<string, unknown> })?._metrics;
        if (!m) return;
        m.spreadCorrectionRetryCount = (Number(m.spreadCorrectionRetryCount) || 0) + 1;
    } catch { /* metrics are best-effort */ }
}

/**
 * P2 plan-time dedupe: which of a correction's planned CREATE destinations are
 * now occupied by a live (ACTIVE/PARTIAL) order with a chain id?
 *
 * The correction is planned under _gridLock, then broadcast after the lock is
 * released. A concurrent fill rebalance can commit an order onto one of the
 * planned slots in that window; the COW build layer then rejects the whole
 * batch (`Rejecting CREATE … existing orderId`). Detecting it here turns that
 * into a cheap plan-time re-derive (see the retry loop in checkSpreadCondition)
 * instead of a mid-broadcast refusal and structural resync.
 *
 * Pure and never throws. A missing/non-Map orders store selects the empty set.
 * @param {Object} manager - OrderManager instance
 * @param {Object|null} correction - Prepared spread correction
 * @returns {string[]} Occupied planned slot ids
 */
export function getOccupiedCorrectionSlots(manager: OrderManagerLike, correction: SpreadCorrection | null | undefined): string[] {
    const occupied: string[] = [];
    try {
        const orders = (manager as unknown as { orders?: Map<string, ManagedOrder> }).orders;
        if (!(orders instanceof Map) || !correction) return occupied;
        for (const o of correction.ordersToPlace || []) {
            const cur = orders.get(o.id);
            if (!cur) continue;
            const liveState = cur.state === ORDER_STATES.ACTIVE || cur.state === ORDER_STATES.PARTIAL;
            if (liveState && cur.orderId) occupied.push(o.id);
        }
        // Rotation destinations are empty slots when planned; if one was
        // taken between plan and broadcast the UPDATE would overwrite/duplicate
        // it, so treat it exactly like an occupied CREATE destination.
        for (const r of correction.ordersToRotate || []) {
            const dest = r?.newGridId;
            if (!dest) continue;
            const cur = orders.get(dest);
            if (!cur) continue;
            const liveState = cur.state === ORDER_STATES.ACTIVE || cur.state === ORDER_STATES.PARTIAL;
            if (liveState && cur.orderId) occupied.push(dest);
        }
    } catch { /* best-effort detection */ }
    return occupied;
}

/**
 * Executable-action count for a spread correction: CREATEs plus fund-constrained
 * ROTATIONs. A rotation tightens the spread exactly like a create; callers that
 * test only ordersToPlace would misclassify a rotation-only plan as "nothing
 * to do" and skip the broadcast.
 * @param {Object|null|undefined} correction - Prepared spread correction
 * @returns {number} Number of actions the COW plan will execute
 */
export function getSpreadCorrectionActionCount(correction: SpreadCorrection | null | undefined): number {
    return (correction?.ordersToPlace?.length || 0) + (correction?.ordersToRotate?.length || 0);
}

/**
 * Rotation-only fallback when normal side selection has no fundable side.
 *
 * `determineOrderSideByFunds` is still pure-fund-driven, so a rail with
 * exactly zero free on both sides returns null. Rotations, however, need no
 * new commitment: a fully allocated rail can still be repaired by moving a
 * resting order into a promoted gap slot. Try both sides and accept the first
 * executable plan (create or rotation). Callers must only use this when the
 * side decision failed for INSUFFICIENT FREE FUNDS, not for an unavailable
 * market price where cross-asset side comparison is unsafe.
 * @param {Object} manager - Order manager
 * @returns {Promise<{correction: SpreadCorrection, side: OrderType}|null>}
 */
async function prepareZeroFreeRotationFallback(manager: OrderManagerLike): Promise<{ correction: SpreadCorrection; side: OrderType } | null> {
    for (const side of [ORDER_TYPES.BUY, ORDER_TYPES.SELL] as OrderType[]) {
        const correction = await prepareSpreadCorrectionOrders(manager, side, manager.outOfSpread);
        if (correction && getSpreadCorrectionActionCount(correction) > 0) {
            return { correction, side };
        }
    }
    return null;
}

/**
 * P1/P3 shared re-plan: derive a spread correction from the CURRENT master
 * state (side chosen from fresh on-chain book, opposite-side starvation
 * fallback). A zero-free decision still tries the rotation-only fallback.
 * Used both for the plan-time collision dedupe and the bounded refusal retry.
 * Read-only against the grid; no _gridLock needed (matches the existing TOCTOU
 * fund re-plan contract).
 * @param {Object} manager - OrderManager instance
 * @returns {Promise<Object|null>} A correction with at least one executable action, or null
 */
export async function replanSpreadCorrectionFromFreshMaster(manager: OrderManagerLike): Promise<SpreadCorrection | null> {
    const freshOnChain = _getOnChainOrders(manager);
    const freshBest = getGridBestPrices(freshOnChain.onChainBuys, freshOnChain.onChainSells);
    const freshPrice = (freshBest.bestBuy !== null && freshBest.bestSell !== null)
        ? (freshBest.bestBuy + freshBest.bestSell) / 2
        : Number(manager.config.startPrice) || 0;
    const decision = determineOrderSideByFunds(manager, freshPrice);
    if (!decision.side) {
        if (decision.code !== 'no-free-funds') return null;
        const fallback = await prepareZeroFreeRotationFallback(manager);
        return fallback?.correction ?? null;
    }
    let c = await prepareSpreadCorrectionOrders(manager, decision.side, manager.outOfSpread);
    if (getSpreadCorrectionActionCount(c) === 0) {
        const opposite = decision.side === ORDER_TYPES.BUY ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
        const oc = await prepareSpreadCorrectionOrders(manager, opposite, manager.outOfSpread);
        if (getSpreadCorrectionActionCount(oc) > 0) c = oc;
    }
    return c;
}

/**
 * Outcome of the P2 plan-time collision resolution.
 * - 'broadcast': no occupied destination (or the final attempt) — ship the plan.
 * - 'replanned': a destination was taken and a fresh correction was derived.
 * - 'blocked': a destination was taken and no fresh correction exists — refuse.
 */
export type OccupiedCorrectionResolution =
    | { action: 'broadcast' }
    | { action: 'replanned'; correction: SpreadCorrection; occupied: string[] }
    | { action: 'blocked'; occupied: string[] };

/**
 * P2: resolve a planned correction whose CREATE destination(s) were taken after
 * planning. Detects the collision, re-derives once from fresh master, and
 * reports whether the caller should broadcast, swap in the re-plan, or refuse.
 *
 * Extracted from checkSpreadCondition so the branch is a real, production-called
 * unit that tests can drive directly (no test-only hook in the production path).
 *
 * @param {Object} manager - OrderManager instance
 * @param {Object|null} correction - The plan about to broadcast
 * @param {number} attempt - 1-based attempt index
 * @param {number} maxAttempts - Total attempts allowed
 * @returns {Promise<OccupiedCorrectionResolution>}
 */
export async function resolveOccupiedCorrection(manager: OrderManagerLike, correction: SpreadCorrection | null | undefined, attempt: number, maxAttempts: number): Promise<OccupiedCorrectionResolution> {
    const occupied = getOccupiedCorrectionSlots(manager, correction);
    if (!(occupied.length > 0 && attempt < maxAttempts)) return { action: 'broadcast' };
    const replanned = await replanSpreadCorrectionFromFreshMaster(manager);
    if (replanned && getSpreadCorrectionActionCount(replanned) > 0) {
        return { action: 'replanned', correction: replanned, occupied };
    }
    return { action: 'blocked', occupied };
}

interface AmaSnapshot {
    gridCenterPrice?: number;
    gridPriceOffsetPct?: number;
    dynamicWeights?: {
        trend?: string;
        rawSlopeOffset?: number;
        slopeOffset: number;
        maxSlopeOffset: number;
        maxAsymmetryFactor: number;
        minScaleSlots: number;
        [key: string]: unknown;
    } | null;
    asymmetricBounds?: {
        appliedAsymmetryFactor?: number;
        trend?: string;
        minScaleSlots?: number;
        [key: string]: unknown;
    } | null;
    [key: string]: unknown;
}

/**
 * Central resolution for the RMS structural-divergence threshold (percent).
 * Single source of truth: per-bot override wins, global GRID_COMPARISON default
 * is the fallback. Used by compareGrids() and re-exported for the maintenance
 * runtime so the reset log always shows the level that actually fired.
 * @param {unknown} manager - OrderManager instance (may be null)
 * @returns {number} Threshold in percent (0 = disabled)
 */
export function resolveRmsThresholdPct(manager: OrderManagerLike | null | undefined): number {
    return manager?.config?.gridLimits?.GRID_COMPARISON?.RMS_PERCENTAGE
        ?? GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE;
}

function _snapshotFundState(manager: OrderManagerLike): FundStateSnapshot {
    return {
        buyFree: Number(manager.accountTotals?.buyFree || 0),
        sellFree: Number(manager.accountTotals?.sellFree || 0),
        buyLocked: Number(manager.accountTotals?.buyLocked || 0),
        sellLocked: Number(manager.accountTotals?.sellLocked || 0),
    };
}

import {
    floatToBlockchainInt,
    getPrecisionByOrderType,
    getPrecisionsForManager,
    calculateOrderCreationFees,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateAvailableFundsValue,
    calculateGridSideDivergenceMetric,
    getPrecisionSlack,
    getMinOrderSize,
    getSingleDustThreshold,
    getGridBestPrices,
    calculateSpreadFromOrders,
    allocateFundsByWeights,
    calculateGapSlots as _mathGapSlots,
    pricesOnSameLevel,
    sameGridLevel,
    getBtsSide,
    getSellStartIdx,
    resolveGapBand,
    countGapBandSpread,
    validatePersistedBoundary,
    isTransientInBandRejection,
    adjustBudgetForBtsFees,
    clamp,
    derivePriceLevels,
    buildGenesisFromPriceLevels,
    assertSlotPriceInvariant,
    priceForSlot,
    hashPriceLevels,
} from './utils/math.js';
import {
    filterOrdersByType,
    checkSizesBeforeMinimum,
    checkSizeThreshold,
    resolveConfiguredPriceBound,
    shouldFlagOutOfSpread,
    isOrderHealthy,
    isPhantomOrder,
    isSlotAvailable,
    isOrderOnChain,
    isOrderPlaced,
    hasOnChainId,
    isEmptyGridSlot,
    parseSlotIndex,
    calculateIdealBoundary,
    assignGridRoles,
    resolveOnChainRetypeType,
    resolveEdgeCount,
    edgeOrderIdSet,
    resolveLiveEdgeAnchorPrice,
    liveWindowIdSet,
    getOrderTypeFromUpdatedFlags
} from './utils/order.js';
import { loadAmaCenterPrice, loadAmaCenterSnapshot, withBlockchainRetry, restoreLastFillPivot, resetLastFillPivot, rearmLastFillPivotFromMarketFill, evaluateSpreadCorrectionReadiness, maybeRefreshLiveMarketPrice, resolveLastFillGuardReference, isLastFillGuardBlocked } from './utils/system.js';
import * as MathUtils from './utils/math.js';
import { derivePriceWithPoolRef, resolveStartPriceMode } from './utils/withPoolRef.js';
import { getWhitelistFlags } from '../market_adapter_whitelist.js';
import {
    hasGenesisLadder,
    recordMissingGenesisFault,
    resolvePersistedGenesis
} from './genesis_policy.js';

import { WorkingGrid } from './working_grid.js';
import type { OrderManagerLike, ChainFundsSnapshot, ManagedOrder, GridConfig, OrderType, OrderState, AccountTotals, CowAction, SpreadCorrectionStall } from '../types.js';
import type { GridGenesis } from './utils/math.js';
import { getErrorMessage } from '../utils/errors.js';

const calculateGapSlots = _mathGapSlots;
export { calculateGapSlots };

export function isGridBloated(manager: OrderManagerLike, orders: ManagedOrder[] | Map<string, ManagedOrder>): { bloated: boolean; details?: { gridSize: number; placedCount: number; numBuyActive: number; numSellActive: number; gapSlots: number; maxAllowed: number; railEstimate: number } } {
        const gridSize = Array.isArray(orders) ? orders.length : orders.size;
        if (!gridSize || !manager?.config) return { bloated: false };

        const config = manager.config;
        const incPct = config.incrementPercent || 0.3;
        if (incPct <= 0) return { bloated: false };

        const targetSpreadPct = config.targetSpreadPercent || incPct * 2;
        const orderList = Array.isArray(orders) ? orders : Array.from(orders.values());

        const numBuyActive = orderList.filter((o) =>
            o.type === ORDER_TYPES.BUY &&
            (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) &&
            o.orderId
        ).length;
        const numSellActive = orderList.filter((o) =>
            o.type === ORDER_TYPES.SELL &&
            (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) &&
            o.orderId
        ).length;
        const placedCount = numBuyActive + numSellActive;
        if (!placedCount) return { bloated: false };

        const gapSlots = calculateGapSlots(incPct, targetSpreadPct);

        // Estimate expected full-rail size from actual min/max prices in the grid.
        // A normal grid has one geometric price level per increment step across
        // the full price range, plus gapSlots for the spread zone.
        // This correctly handles the full-rail grid layout (many virtual slots
        // outside the active window) and only flags true bloat where spread-
        // correction inserts or other duplication have added EXTRA slots beyond
        // what the price range would produce.
        //
        // The buffer uses MIN_SPREAD_ORDERS to cover:
        //   1. Estimation error from createOrderGrid's sqrt(step) starting
        //      offset (~1 geometric level per side)
        //   2. Headroom for legitimate spread-correction inserts
        const prices = orderList
            .map((o) => o.price)
            .filter((p) => p != null && Number.isFinite(p));
        let expectedTotal = 0;
        if (prices.length > 0) {
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            if (minP > 0 && maxP > minP) {
                const step = 1 + incPct / 100;
                expectedTotal = Math.floor(Math.log(maxP / minP) / Math.log(step)) + 1;
            }
        }
        const railEstimate = Math.max(expectedTotal, placedCount);
        const buffer = (config.gridLimits?.MIN_SPREAD_ORDERS ?? GRID_LIMITS.MIN_SPREAD_ORDERS);
        const maxAllowed = railEstimate + gapSlots + buffer;

        return {
            bloated: gridSize > maxAllowed,
            details: { gridSize, placedCount, numBuyActive, numSellActive, gapSlots, maxAllowed, railEstimate }
        };
    }

    /**
     * Check whether the grid-bloat grace period is still active, i.e. a
     * bloat detection happened recently enough that a structural resync
     * has not had time to resolve it.
     *
     * Used by both Grid.loadGrid (to suppress redundant resync requests)
     * and the maintenance runtime (to decide when to re-check after the
     * grace window expires) so the two policies share one definition of
     * the grace window.
     *
     * @param {Object} manager - OrderManager instance.
     * @returns {{active: boolean, elapsed: number, graceMs: number}}
     */
export function isGridBloatGraceActive(manager: OrderManagerLike): { active: boolean; elapsed: number; graceMs: number } {
        const graceMs = Number(TIMING?.GRID_BLOAT_RESYNC_GRACE_MS) || TIMING.GRID_BLOAT_RESYNC_GRACE_MS;
        if (!manager._gridBloatDetectedAt) {
            return { active: false, elapsed: 0, graceMs };
        }
        const elapsed = Date.now() - manager._gridBloatDetectedAt;
        return { active: elapsed < graceMs, elapsed, graceMs };
    }

    /**
     * Clear the grid-bloat detection timestamp once the grid size has
     * returned to normal. Shared so both call sites use the same key.
     * @param {Object} manager - OrderManager instance.
     */
export function clearGridBloatFlag(manager: OrderManagerLike): void {
        delete manager._gridBloatDetectedAt;
    }

    /**
     * Unifies budget calculation and fee deduction for all grid sizing scenarios.
     * Ensures consistent fund context (Allocated vs Total) across the bot.
     *
     * @param {import('./types').OrderManager} manager - OrderManager instance
     * @param {string} side - 'buy' or 'sell'
     * @returns {Promise<any|null>}
     * @private
     */
function _computeSizingContextSync(manager: OrderManagerLike, side: string): { budget: number; precision: number; config: GridConfig } | null {
        if (!manager || !manager.assets) return null;

        const snap = manager.getChainFundsSnapshot ? manager.getChainFundsSnapshot() : ({} as unknown as ChainFundsSnapshot);
        const isBuy = side === 'buy';
        const type = isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;

        // 2. Determine base budget: Always use ALLOCATED funds (respects botFunds %)
        // This ensures the bot only "thinks" about the capital it is allowed to use.
        let budget = isBuy ? (snap.allocatedBuy || 0) : (snap.allocatedSell || 0);

        // 3. Standardize BTS Fee Deduction (Issue #15 consistency)
        // BTS fees are paid for ALL order operations regardless of side, so the
        // BTS-holding side reserves fees for both buy and sell target counts.
        if (budget > 0) {
            const targetBuy = Math.max(0, manager.config.coreOrders?.buy ?? 1) + resolveEdgeCount(manager.config, 'buy');
            const targetSell = Math.max(0, manager.config.coreOrders?.sell ?? 1) + resolveEdgeCount(manager.config, 'sell');
            const totalTarget = targetBuy + targetSell;
            const btsOrderType = getBtsSide(manager.config?.assetA, manager.config?.assetB);
            const isBtsSide = isBuy ? (btsOrderType === ORDER_TYPES.BUY) : (btsOrderType === ORDER_TYPES.SELL);

            // Non-BTS side without btsBalance data (BTS pairs): no fee adjustment
            // to make. Mirrors the getSideBudget guard — for BTS pairs the snapshot
            // nulls btsBalance, and reading manager.funds.btsBalance (zeroed for
            // BTS pairs) as btsFree=0 would carve the full fee deficit out of this
            // side's budget.
            if (isBtsSide || snap.btsBalance) {
                const formulaBudget = calculateOrderCreationFees(
                    manager.config.assetA,
                    manager.config.assetB,
                    totalTarget,
                    manager.config?.feeParams?.BTS_RESERVATION_MULTIPLIER
                );

                budget = adjustBudgetForBtsFees(
                    budget,
                    isBtsSide,
                    formulaBudget,
                    manager.config.min_BTS_value || 0,
                    Format.toFiniteNumber(snap.btsBalance?.free, 0),
                    Format.toFiniteNumber(isBuy ? (snap.allocatedBuy || 0) : (snap.allocatedSell || 0)),
                    Format.toFiniteNumber(snap.allocatedBuy || 0)
                        + Format.toFiniteNumber(snap.allocatedSell || 0),
                );
            }
        }

        return {
            budget,
            precision: getPrecisionByOrderType(manager.assets, type),
            config: manager.config
        };
    }

    /**
     * Async sizing-context accessor. Refreshes funds unless `skipRecalc`, then
     * delegates to the sync core. Both divergence legs (ratio and committed
     * drift) size through the sync core so they read one fund snapshot.
     */
export async function _getSizingContext(manager: OrderManagerLike, side: string, { skipRecalc = false }: { skipRecalc?: boolean } = {}): Promise<{ budget: number; precision: number; config: GridConfig } | null> {
        if (!manager || !manager.assets) return null;
        if (!skipRecalc) {
            await manager.recalculateFunds();
        }
        return _computeSizingContextSync(manager, side);
    }

    /**
     * Create the initial order grid structure based on configuration.
     *
     * ALGORITHM: Geometric Grid Creation with Fixed Spread Gap
     * =========================================================
     * This method generates a unified "Master Rail" of price levels with geometric spacing.
     * The grid is centered around startPrice with a fixed-size spread gap.
     *
     * KEY CONCEPTS:
     * - Geometric Spacing: Each price level is incrementPercent% away from neighbors
     * - Master Rail: Single unified array (not separate buy/sell rails)
     * - Spread Gap: Fixed-size buffer between best buy and best sell
     * - Role Assignment: BUY / SPREAD / SELL based on position relative to startPrice
     *
     * SPREAD GAP FORMULA:
     * ===================
     * The spread gap size is calculated to match the target spread percentage:
     *
     * 1. Step Factor (s): s = 1 + (incrementPercent / 100)
     *    Example: If incrementPercent = 0.5%, then s = 1.005
     *
     * 2. Minimum Spread: minSpread = incrementPercent × MIN_SPREAD_FACTOR
     *    This ensures spread is at least 2× the increment (prevents too-narrow spread)
     *
     * 3. Target Steps (n): Number of price levels needed to achieve target spread
     *    Formula: n = ceil(ln(1 + targetSpread/100) / ln(s))
     *
     *    Derivation: If we want price to grow by targetSpread% over n steps:
     *    - Final price = startPrice × s^n
     *    - Growth factor = (1 + targetSpread/100)
     *    - Therefore: s^n = (1 + targetSpread/100)
     *    - Taking ln: n × ln(s) = ln(1 + targetSpread/100)
     *    - Solving: n = ln(1 + targetSpread/100) / ln(s)
     *
     * 4. Gap Slots (G): G = max(MIN_SPREAD_ORDERS, n)
     *    Ensures at least MIN_SPREAD_ORDERS slots even if target spread is small
     *
     * EXAMPLE:
     * --------
     * incrementPercent = 0.5%, targetSpread = 2%
     * - s = 1.005
     * - minSpread = 0.5% × 2 = 1%
     * - targetSpread = max(2%, 1%) = 2%
     * - n = ceil(ln(1.02) / ln(1.005)) = ceil(3.98) = 4 steps
     * - G = max(2, 4) = 4 slots
     *
     * @param {unknown} config - Grid configuration
     * @returns {unknown}
     */
export function createOrderGrid(config: GridConfig) {
        const startPrice = Number(config.startPrice);
        const minPrice = Number(config.minPrice);
        const maxPrice = Number(config.maxPrice);
        const incrementPercent = Number(config.incrementPercent);

        // FIX: Add comprehensive input validation to prevent silent grid creation failures
        if (!Number.isFinite(startPrice)) {
            throw new Error(`Invalid startPrice: ${startPrice}. Must be a finite number.`);
        }
        if (!Number.isFinite(minPrice)) {
            throw new Error(`Invalid minPrice: ${minPrice}. Must be a finite number.`);
        }
        if (minPrice <= 0) {
            throw new Error(`Invalid minPrice: ${minPrice}. Must be positive.`);
        }
        if (!Number.isFinite(maxPrice)) {
            throw new Error(`Invalid maxPrice: ${maxPrice}. Must be a finite number.`);
        }
        if (minPrice >= maxPrice) {
            throw new Error(`Invalid price bounds: minPrice (${minPrice}) must be < maxPrice (${maxPrice}).`);
        }
        if (!(minPrice <= startPrice && startPrice <= maxPrice)) {
            throw new Error(`startPrice (${startPrice}) must be within bounds [${minPrice}, ${maxPrice}].`);
        }
        if (maxPrice <= 0) {
            throw new Error(`maxPrice (${maxPrice}) must be positive.`);
        }

        if (!Number.isFinite(incrementPercent)) {
            throw new Error(`Invalid incrementPercent: ${incrementPercent}. Must be a finite number.`);
        }
        // Fall back to the canonical INCREMENT_BOUNDS when the config omits
        // incrementBounds. derivePriceLevels also refuses a step that cannot
        // advance, but this enforces the configured increment range.
        const incrementBounds = config.incrementBounds || INCREMENT_BOUNDS;
        const minPercent = incrementBounds.MIN_PERCENT;
        const maxPercent = incrementBounds.MAX_PERCENT;
        if (incrementPercent <= 0 || incrementPercent < minPercent || incrementPercent > maxPercent) {
            throw new Error(
                `Invalid incrementPercent: ${incrementPercent}. Must be between ` +
                `${minPercent} and ${maxPercent} (inclusive).`
            );
        }

        // ================================================================================
        // STEP 1: GENERATE PRICE LEVELS (Geometric progression)
        // ================================================================================
        // Rail geometry lives in ONE place (modules/order/utils/math.ts,
        // derivePriceLevels) so a fresh build and a legacy-snapshot migration
        // cannot drift into two different ladders for the same config.
        const priceLevels = derivePriceLevels(startPrice, minPrice, maxPrice, incrementPercent);

        // ================================================================================
        // STEP 2: CALCULATE SPREAD GAP SIZE
        // ================================================================================
        // Determine how many slots should be in the spread zone.
        // See formula documentation in JSDoc above.

        const gapSlots = calculateGapSlots(incrementPercent, config.targetSpreadPercent, config.gridLimits);

        // ================================================================================
        // STEP 3: FIND SPLIT INDEX & ROLE ASSIGNMENT
        // ================================================================================
        // Determine the boundary and assign roles (BUY/SPREAD/SELL) to each slot.
        //
        // STRATEGY: Center the spread gap around startPrice
        
        const boundaryIdx = calculateIdealBoundary(priceLevels.map((p) => ({ price: p })), startPrice, gapSlots);

        // ================================================================================
        // STEP 4: CREATE ORDER OBJECTS
        // ================================================================================
        // Convert price levels to order objects with assigned roles.

        type GridSlotDraft = { id: string; price: number; type: OrderType | null; state: OrderState; size: number };
        const orders: GridSlotDraft[] = priceLevels.map((price, i) => ({
            id: `slot-${i}`,
            price,
            type: null, // assigned below
            state: ORDER_STATES.VIRTUAL,
            size: 0
        }));

        const updatedOrders = assignGridRoles(orders, boundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES);

        const buyCount = updatedOrders.filter((o) => o.type === ORDER_TYPES.BUY).length;
        const sellCount = updatedOrders.filter((o) => o.type === ORDER_TYPES.SELL).length;
        if (buyCount === 0 || sellCount === 0) {
            throw new Error(
                `Grid generation produced an imbalanced rail (buy=${buyCount}, sell=${sellCount}) for ` +
                `startPrice=${startPrice}, bounds=[${minPrice}, ${maxPrice}], incrementPercent=${incrementPercent}, ` +
                `targetSpreadPercent=${config.targetSpreadPercent}. Widen bounds or reduce target spread.`
            );
        }

        const initialSpreadCount = {
            buy: Math.floor(gapSlots / 2),
            sell: gapSlots - Math.floor(gapSlots / 2)
        };

        const genesis = buildGenesisFromPriceLevels(startPrice, incrementPercent, gapSlots, priceLevels);

        return { orders: updatedOrders, boundaryIdx, initialSpreadCount, gapSlots, priceLevels, genesis };
    }

    /**
     * Internal utility to clear all order-related manager caches.
     * Prevents stale references during grid reinitialization.
     * RC-2: Synchronized to prevent concurrent modifications during clear
     * 
     * Note: Uses explicit assignment instead of .clear() to enforce COW semantics:
     * - Replace the master grid atomically with a fresh Map instance
     * - Avoid mutating any previously referenced Map object
     * @param {import('./types').OrderManager} manager - OrderManager instance
     * @private
     */
function _clearOrderCachesLogic(manager: OrderManagerLike): void {
        // Bump the grid version: the master map is replaced atomically here, and
        // an in-flight COW plan whose baseVersion matches the pre-swap version
        // must be refused at commit (version check) instead of committing over
        // the regenerated grid. _applyOrderUpdate bumps per slot afterwards, but
        // a zero-slot grid would otherwise leave the version unchanged.
        if (Number.isFinite(Number(manager._gridVersion))) {
            manager._gridVersion++;
        }
        // Replace frozen master grid with fresh empty frozen Map (COW pattern)
        manager.orders = Object.freeze(new Map());
    }


    /**
     * Restore a persisted grid snapshot onto a manager instance.
     *
     * Side effects on manager:
     * - Reassigns all slot types to match current boundary + gapSlots
     *   (fixes stale persisted types that cause ILLEGAL_SPREAD_STATE)
     * - Sets `manager._gapSlots` to the computed gapSlots so strategy reads
     *   the creation-time value instead of recomputing from live config
     * - Sanitizes phantom orders (ACTIVE/PARTIAL without orderId → VIRTUAL)
     *
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {Array<any>} grid - The persisted grid array.
     * @param {number|null} [boundaryIdx=null] - The master boundary index.
     * @returns {Promise<void>}
     */
export async function loadGrid(manager: OrderManagerLike, grid: ManagedOrder[], boundaryIdx: number | null = null, genesisInput: GridGenesis | null = null, options: { tolerateTransientStranding?: boolean } = {}): Promise<void> {
        if (!Array.isArray(grid)) return;
        return await manager._gridLock.acquire(async () => {
            // Genesis determinism: if snapshot provided genesis, validate slots
            // against it; if legacy snapshot has no genesis, migrate by building
            // genesis from live config and re-sorting to canonical price order.
            //
            // GENESIS INVARIANT (docs/GRID_PRICE_INVARIANT.md, E1): a snapshot that
            // carries orders MUST carry a ladder. The decision lives in
            // genesis_policy.resolvePersistedGenesis, so the startup gate can ask
            // the same question before committing to a resume. A refused snapshot
            // throws BEFORE any mutation (no asset init, no fund reset, no
            // boundary restore), so the caller rebuilds from a clean manager.
            // Assigned from the single resolver below; the raw inputs are only
            // inspected by that resolver (so a malformed `genesisInput` cannot
            // shadow the manager's own ladder or the migration path).
            let genesis: GridGenesis | null = null;
            const validationMode = (() => {
                try {
                    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
                    const raw = proc?.env?.GRID_PRICE_SLOT_VALIDATION ?? 'log';
                    return String(raw).toLowerCase() === 'enforce' ? 'enforce' : 'log';
                } catch { return 'log'; }
            })();

            const resolution = resolvePersistedGenesis({
                config: manager.config,
                grid,
                genesisInput,
                managerGenesis: manager._genesis,
                validationMode,
                log: (msg: string, level?: string) => manager.logger?.log?.(msg, level)
            });
            if (!resolution.ok) {
                throw recordMissingGenesisFault(manager, resolution);
            }
            genesis = resolution.genesis;
            // A ladder is (re)established: clear any fault recorded by an earlier
            // attempt in this process, so the observability record reflects the
            // CURRENT state rather than a resolved one.
            if (manager._missingGenesis) manager._missingGenesis = null;

            // Validate genesis hash if present (wired for stale-pair detection #3)
            // On mismatch we only warn — genesis is still used for validation (log mode) / virtualization (enforce mode);
            // a stale persisted snapshot vs fresh manager._genesis scenario is covered by the log/enforce gate above
            if (hasGenesisLadder(genesis) && typeof genesis.priceLevelsHash === 'string') {
                try {
                    const recomputed = hashPriceLevels(genesis.priceLevels);
                    if (recomputed !== genesis.priceLevelsHash) {
                        manager.logger?.log?.(`[GENESIS] hash mismatch persisted=${genesis.priceLevelsHash} recomputed=${recomputed} — persisted genesis hash does not match recomputed hash; continuing with persisted genesis`, 'warn');
                    }
                } catch {}
            }
            if (hasGenesisLadder(genesis)) {
                // Validate each slot's price against genesis; virtualize only in enforce mode (plan §13)
                //
                // REPAIR (both modes): a slot id determines its price from the
                // genesis ladder, so a slot whose price disagrees is not a value
                // to preserve -- it is corruption. Carrying it forward is what
                // let an off-grid price become grid evidence and then be
                // re-emitted. Left unrepaired the slot is also permanently
                // stuck: it re-activates, the emission guard rejects it on
                // every cycle, and nothing heals it without a full reset.
                // Repairing here is safe because the id is authoritative; no
                // legitimate slot can disagree with its own ladder level.
                const repairedSlots: string[] = [];
                const newGrid: ManagedOrder[] = [];
                for (const slot of grid) {
                    try {
                        assertSlotPriceInvariant(slot, genesis);
                        newGrid.push(slot);
                    } catch (e) {
                        const idx = parseSlotIndex(slot?.id);
                        let repaired = slot;
                        if (idx !== null) {
                            try {
                                const level = priceForSlot(idx, genesis);
                                if (Number.isFinite(level) && level > 0) {
                                    repaired = { ...slot, price: level };
                                    repairedSlots.push(`${slot?.id} ${Number(slot?.price)}->${level}`);
                                }
                            } catch { /* keep original if the ladder cannot be read */ }
                        }
                        const msg = `[GENESIS] Slot ${slot?.id} price mismatch vs genesis → `
                            + `${repaired === slot
                                ? (validationMode === 'enforce' ? 'virtualize' : 'log-only')
                                : 'price repaired from genesis'}`
                            + `${validationMode === 'enforce' ? ' + virtualize' : ''}: ${getErrorMessage(e)}`;
                        manager.logger?.log?.(msg, 'warn');
                        if (validationMode === 'enforce') {
                            newGrid.push({ ...repaired, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' });
                        } else {
                            newGrid.push(repaired);
                        }
                    }
                }
                if (repairedSlots.length > 0) {
                    manager.logger?.log?.(
                        `[GENESIS] Repaired ${repairedSlots.length} slot price(s) from the genesis ladder `
                        + `(an off-grid slot price cannot be emitted and would otherwise stall the slot): `
                        + `${repairedSlots.join(', ')}`,
                        'warn'
                    );
                }
                grid = newGrid;
                // Ensure canonical price-sorted order matches slot-N order
                // Quirk fix: previously `isPriceSorted && parsed!==i` gated re-sort, so a shuffled
                // array with misaligned ids but unsorted prices incorrectly skipped re-sort.
                // Now: re-sort if any parseable id != index (price order is authoritative via slot-N).
                const idxOrderMatchesPriceOrder = (() => {
                    for (let i = 0; i < grid.length; i++) {
                        const parsed = parseSlotIndex(grid[i]?.id);
                        if (parsed === null) return false;
                        if (parsed !== i) return false;
                    }
                    return true;
                })();
                if (!idxOrderMatchesPriceOrder) {
                    const sorted = [...grid].sort((a, b) => {
                        const pa = parseSlotIndex(a?.id);
                        const pb = parseSlotIndex(b?.id);
                        if (pa !== null && pb !== null) return pa - pb;
                        return Number(a.price) - Number(b.price);
                    });
                    // Detect if re-sort actually changes order
                    let changed = false;
                    for (let i = 0; i < grid.length; i++) if (grid[i].id !== sorted[i].id) { changed = true; break; }
                    if (changed) {
                        manager.logger?.log?.(`[GENESIS] Re-sorted persisted grid to canonical slot-N order`, 'warn');
                        grid = sorted;
                    }
                }
                // Guard: explicit persistedGenesis should not blindly overwrite a fresher in-memory _genesis
                // from an in-process rebuild (currently unreachable but latent hazard if flows change)
                if (manager._genesis && manager._genesis.priceLevelsHash && genesis.priceLevelsHash && manager._genesis.priceLevelsHash !== genesis.priceLevelsHash) {
                    manager.logger?.log?.(`[GENESIS] persisted genesis hash ${genesis.priceLevelsHash} differs from in-memory ${manager._genesis.priceLevelsHash} — keeping in-memory genesis`, 'warn');
                } else {
                    manager._genesis = genesis;
                }
                // Legacy snapshot with no persisted ladder: the resolver built one
                // from the live geometric rail and cross-checked it against the
                // persisted slots (mismatch ratio at or below
                // MISSING_GENESIS_MISMATCH_RATIO), so it describes THIS generation.
                // A refused ladder throws above (E1), so there is no genesis-less
                // state left to load into. This is the only place a migration
                // ladder is installed, so its adoption log lives here too (the
                // former `else if` branch was unreachable, since this branch
                // already handles every ladder-bearing resolution).
                if (resolution.source === 'migration') {
                    manager.logger?.log?.(`[GENESIS] Migrated legacy grid: built genesis with ${genesis.priceLevels.length} levels (hash ${genesis.priceLevelsHash})`, 'info');
                }
            }
            try {
                await withBlockchainRetry(
                    () => manager._initializeAssets(),
                    'initializeAssets',
                    { logger: manager.logger }
                );
            } catch (e) {
                manager.logger?.log?.(`Asset initialization failed during grid load: ${getErrorMessage(e)}`, 'warn');
            }

            // RC-2: Use logic helper
            _clearOrderCachesLogic(manager);

            // resetFunds under _fundLock only — no persistGrid needed (grid already
            // on disk). For the resync variant see recalculateGrid (grid.ts:~1037)
            // which snapshots fund values under lock and persists outside.
            // Read btsFeesOwed inside the lock (before resetFunds) to avoid a TOCTOU
            // with concurrent deductBtsFees (which also holds _fundLock).
            await manager._fundLock.acquire(async () => {
                const savedBtsFeesOwed = manager.funds.btsFeesOwed;
                await manager.resetFunds();
                manager.funds.btsFeesOwed = savedBtsFeesOwed;
            });

            // RESTORE-TIME BOUNDARY GATE: a persisted boundary is untrusted
            // disk state.  Any writer bug that committed AND persisted an
            // overrun boundary (e.g. the pre-5eb3ca7 promotion path) would
            // otherwise legalize itself on every restart: resolveGapBand
            // re-derives sellStartIdx from whatever value is restored, and
            // none of the runtime gates (commit gate, detectors) run before
            // this point.  Validate against the snapshot BEFORE restoring;
            // on failure attempt to repair by re-deriving the structural
            // center boundary from slot prices, falling back to "no boundary"
            // (callers sync against chain right after load either way).
            const loadGapSlots = calculateGapSlots(
                manager.config?.incrementPercent,
                manager.config?.targetSpreadPercent,
                manager.config?.gridLimits
            );
            let restoredBoundary = typeof boundaryIdx === 'number' ? boundaryIdx : null;
            if (restoredBoundary !== null) {
                const check = validatePersistedBoundary(restoredBoundary, grid, loadGapSlots);
                if (!check.ok && options?.tolerateTransientStranding && isTransientInBandRejection(check)) {
                    // Transient SPREAD-GUARD strand (live order crawled into the
                    // band, GAP-EVAC already tracking it): keep the boundary so
                    // the heal path (rotation/teeth/sweeps) can run.  Nuking it
                    // here would discard the evacuation state for exactly the
                    // condition evacuation exists to fix (<bot> 2026-09-13).
                    manager.logger?.log?.(
                        `[GRID-LOAD] Persisted snapshot has transient in-band placement (${check.reason}): ${check.detail}. ` +
                        `Keeping boundary ${restoredBoundary}; GAP-EVAC/sync sweeps own cleanup.`,
                        'warn'
                    );
                } else if (!check.ok) {
                    manager.logger?.log?.(
                        `[GRID-LOAD] Persisted boundary rejected (${check.reason}): ${check.detail}. ` +
                        `Attempting re-derivation from slot prices.`,
                        'error'
                    );
                    restoredBoundary = null;
                    const startPrice = Number(manager.config?.startPrice);
                    if (Number.isFinite(startPrice) && Array.isArray(grid) && grid.length > 0) {
                        const priceSorted = [...grid].sort((a, b) => Number(a.price) - Number(b.price));
                        const derived = calculateIdealBoundary(
                            priceSorted.map((s) => ({ price: s.price })),
                            startPrice,
                            loadGapSlots
                        );
                        if (Number.isInteger(derived) && derived >= 0
                            && validatePersistedBoundary(derived, priceSorted, loadGapSlots).ok) {
                            // boundaryIdx indexes the STORED array ordering, not
                            // the price-sorted copy — map the anchor slot back
                            // so the repair stays correct even if a snapshot is
                            // not price-sorted (the honest-load path assumes it;
                            // the repair path must not inherit that silently).
                            const anchorSlot = priceSorted[derived];
                            let mappedIdx = grid.indexOf(anchorSlot);
                            if (mappedIdx === -1 && anchorSlot?.id != null) {
                                mappedIdx = grid.findIndex((s) => s && s.id === anchorSlot.id);
                            }
                            if (mappedIdx >= 0) {
                                restoredBoundary = mappedIdx;
                                manager.logger?.log?.(
                                    `[GRID-LOAD] Persisted boundary repaired: ${boundaryIdx} -> ${mappedIdx} ` +
                                    `(re-derived from slot prices, sorted idx ${derived}).`,
                                    'warn'
                                );
                            }
                        }
                    }
                    if (restoredBoundary === null) {
                        manager.logger?.log?.(
                            `[GRID-LOAD] Could not re-derive a safe boundary; continuing without one. ` +
                            `The next sync cycle will reconcile grid geometry against the chain.`,
                            'error'
                        );
                    }
                    // The rejected value must not survive: storeMasterGrid
                    // never persists a null boundary, so without an explicit
                    // erase the poison re-arms this rejection on every boot
                    // (Sep-9: boundary=96 rejected identically 3 restarts in
                    // a row). Best-effort — load continues boundary-less
                    // either way and the next fill batch re-anchors live.
                    try {
                        const acct = manager.accountOrders;
                        if (acct && typeof acct.clearPersistedBoundary === 'function') {
                            await acct.clearPersistedBoundary();
                            manager.logger?.log?.(
                                `[GRID-LOAD] Erased poisoned persisted boundary (${boundaryIdx}); ` +
                                `restart will load boundary-less instead of re-rejecting.`,
                                'warn'
                            );
                        }
                    } catch { /* load continues boundary-less either way */ }
                }
            }

            // Restore boundary index for StrategyEngine
            if (restoredBoundary !== null) {
                manager._restoreBoundary(restoredBoundary);
                manager.logger?.log?.(`Restored boundary index: ${restoredBoundary}`, 'info');
            }

            // Restart resilience: restore the persisted LAST-FILL-GUARD pivot
            // WITH the boundary — after the persisted genesis is applied and
            // the grid re-typed, before the first reconcile/broadcast — so a
            // restart cannot re-open the cold window where the guard is
            // disabled and evacuation stamps get applied against a boundary
            // that is still being rebuilt. restoreLastFillPivot validates the
            // row against the manager's live genesis (refuses on mismatch —
            // a regenerated grid drops it) and onto the price ladder with the
            // same one-increment drift rule the runtime guard applies.
            if (restoredBoundary !== null) {
                try {
                    restoreLastFillPivot(manager, manager.accountOrders?.loadLastFillPivot?.() ?? null);
                } catch (pivotErr) {
                    manager.logger?.log?.(`[LAST-FILL-GUARD] Persisted pivot restore failed (${getErrorMessage(pivotErr)}); book seed takes over`, 'warn');
                }
            }

            // Reassign slot types based on current boundary.
            // Every slot's type must match its price-slot index (parseSlotIndex)
            // relative to the boundary + gapSlots, not array position.  After
            // genesis freeze the persisted array may have been re-sorted, but
            // slot-N is the canonical identity.
            if (restoredBoundary !== null) {
                const gapSlots = loadGapSlots;
                manager._gapSlots = gapSlots;
                const buyEndIdx = restoredBoundary;
                const sellStartIdx = getSellStartIdx(restoredBoundary, gapSlots);
                let reassignCount = 0;
                grid = grid.map((slot, i) => {
                    const parsedIdx = parseSlotIndex(slot?.id);
                    // Plan §4.3: unparseable ids are invalid per decision #3 — enforce virtualizes,
                    // log mode keeps index fallback (legacy grids with ids like 'b1'/'planned' need type via position)
                    if (parsedIdx === null) {
                        if (validationMode === 'enforce') {
                            manager.logger?.log?.(`[GENESIS] unparseable slot id ${slot?.id} at index ${i} → virtualize (SPREAD)`, 'warn');
                            reassignCount++;
                            return { ...slot, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '', type: ORDER_TYPES.SPREAD };
                        }
                        manager.logger?.log?.(`[GENESIS] unparseable slot id ${slot?.id} at index ${i} → log-only, using index fallback ${i} for type; rail filters admit it fail-open (legacy stored type applies)`, 'warn');
                        // fall through with idx = i so legacy sized VIRTUAL rail slots (e.g. 'planned') keep their size/type
                    }
                    const idx = parsedIdx !== null ? parsedIdx : i;
                    const correctType = (idx <= buyEndIdx)
                        ? ORDER_TYPES.BUY
                        : (idx >= sellStartIdx)
                            ? ORDER_TYPES.SELL
                            : ORDER_TYPES.SPREAD;

                    // RAIL-TYPED HOLES (Phase 2): a VIRTUAL slot with no orderId and
                    // zero size keeps its RAIL type by geometry — an in-rail
                    // hole stays BUY/SELL VIRTUAL so candidate-selection and
                    // gap-evacuation geometry keep working across fill/rotation
                    // cycles; only true gap-band slots are side-neutral SPREAD.
                    // The stored type cannot pre-bias reuse: every consumer
                    // filters by boundary geometry (getSlotCorrectType /
                    // isSlotInRail), and spread-correction accepts both rail
                    // and SPREAD stored types on its orphaned-virtual path.
                    // NOTE: first load of legacy persisted grids reassigns
                    // every normalized empty slot once — expect a one-time
                    // [GRID-TYPE-CORRECT] spike; it is the backfill, not a
                    // regression. On-chain slots still never become SPREAD
                    // (handled below — SPREAD+ACTIVE/PARTIAL is illegal).
                    if (isEmptyGridSlot(slot, slot, { allowNullType: true })) {
                        // Unparseable ids have no geometry (idx fell back to
                        // array position, which is not canonical): keep
                        // side-neutral SPREAD, never fabricate rail membership
                        // from a position that carries no price meaning.
                        const wantType = parsedIdx === null ? ORDER_TYPES.SPREAD : correctType;
                        if (slot.type !== wantType) reassignCount++;
                        return { ...slot, type: wantType };
                    }

                    if (slot.type !== correctType) {
                        let newType = correctType;
                        // On-chain slots must never be reassigned to SPREAD:
                        // SPREAD+ACTIVE/PARTIAL is an illegal state (validateOrder
                        // rejects it), so the slot would be dropped from the loaded
                        // grid and its chain order orphaned. Keep the stored
                        // BUY/SELL rail type (the subsequent sync's pass-1
                        // type-mismatch handling cancels/recreates a genuinely
                        // wrong side), or resolve a stale SPREAD type by the slot
                        // index vs the boundary (the same convention the whole
                        // correction block uses). The price-vs-startPrice
                        // convention is NOT usable here: startPrice may still be
                        // the string "pool"/"book" (price modes are only coerced
                        // to a number by initializeGrid), which makes every
                        // comparison false and wrongly resolves below-center
                        // slots to SELL.
                        if (newType === ORDER_TYPES.SPREAD && isOrderOnChain(slot)) {
                            newType = resolveOnChainRetypeType(slot, idx, buyEndIdx, ORDER_TYPES);
                        }
                        reassignCount++;
                        return { ...slot, type: newType };
                    }
                    return slot;
                });
                if (reassignCount > 0) {
                    manager.logger?.log?.(
                        `[GRID-TYPE-CORRECT] Reassigned ${reassignCount} stale slot type(s) based on boundary ${restoredBoundary}`,
                        'warn'
                    );
                }
            }

            // Gap 6: Grid size cap — validate grid slot count against expected maximum.
            // Formula: placedOrders (active+partial with orderId) + gapSlots + 1 tolerance slot.
            const bloatResult = isGridBloated(manager, grid);
            if (bloatResult.bloated && bloatResult.details) {
                const d = bloatResult.details;
                const grace = isGridBloatGraceActive(manager);
                if (grace.active) {
                    manager.logger?.log?.(
                        `[GRID-BLOAT] Grid size ${d.gridSize} exceeds expected maximum ${d.maxAllowed} ` +
                        `(grace period active ${grace.elapsed}ms/${grace.graceMs}ms). Skipping re-request.`,
                        'debug'
                    );
                } else {
                    manager.logger?.log?.(
                        `[GRID-BLOAT] Grid size ${d.gridSize} exceeds expected maximum ${d.maxAllowed} ` +
                        `(placed=${d.placedCount} buy=${d.numBuyActive} sell=${d.numSellActive} ` +
                        `gapSlots=${d.gapSlots}). Triggering protective structural resync.`,
                        'warn'
                    );
                    manager._gridBloatDetectedAt = Date.now();
                    if (typeof manager.requestStructuralGridResync === 'function') {
                        manager.requestStructuralGridResync(
                            'grid-bloat-detected',
                            { reason: `Grid size ${d.gridSize} exceeds maximum ${d.maxAllowed}` }
                        ).catch((err: unknown) => {
                            manager.logger?.log?.(
                                `[GRID-BLOAT] Structural resync request failed: ${getErrorMessage(err)}`,
                                'error'
                            );
                        });
                    }
                }
            }

            manager.pauseRecalcLogging();
            manager.pauseFundRecalc();
            let sanitizedSizedVirtual: string[] = [];
            try {
                // RC-2: Use applyOrderUpdate (PRIVATE/UNLOCKED)
                for (const order of grid) {
                    let currentOrder = order;
                    if (isPhantomOrder(order)) {
                        manager.logger?.log?.(`Sanitizing corrupted order ${order.id}: ACTIVE/PARTIAL without orderId -> VIRTUAL`, 'warn');
                        currentOrder = { ...order, state: ORDER_STATES.VIRTUAL };
                    }
                    // Sized VIRTUAL slot with no on-chain id AND durable orphan
                    // evidence (createUncertain: set only where a CREATE
                    // broadcast result was lost — COW uncertain-restore and
                    // startup uncertain-create handlers). Unflagged sized
                    // VIRTUAL slots are the NORMAL planned-but-unplaced grid
                    // state (budgeted sizes cover the whole rail and persist
                    // by design), so their sizes must survive reload; only
                    // flagged orphans get zeroed so re-derivation or spread
                    // correction re-places them next cycle. One aggregate
                    // warn instead of per-slot spam.
                    if (
                        currentOrder.state === ORDER_STATES.VIRTUAL
                        && !hasOnChainId(currentOrder)
                        && Number(currentOrder.size || 0) > 0
                        && currentOrder.createUncertain === true
                    ) {
                        sanitizedSizedVirtual.push(currentOrder.id);
                        currentOrder = { ...currentOrder, size: 0, createUncertain: false };
                    }
                    await manager._applyOrderUpdate(currentOrder, 'grid-load', { skipAccounting: true });
                }
                if (sanitizedSizedVirtual.length > 0) {
                    const preview = sanitizedSizedVirtual.slice(0, 10).join(', ');
                    manager.logger?.log?.(
                        `Sanitized ${sanitizedSizedVirtual.length} creation-uncertain sized slot(s) on load ` +
                        `(VIRTUAL with size but no orderId -> size dropped): ${preview}` +
                        (sanitizedSizedVirtual.length > 10 ? ' …' : ''),
                        'warn'
                    );
                }
                 // Gap-band occupancy for the spread metric.  Empty slots are
                 // normalized to SPREAD (side-neutral) above, so a raw
                 // `type === SPREAD` count would include every empty slot on both
                 // rails.  countGapBandSpread requires both SPREAD type and band
                 // geometry (target = gapSlots).
                 // Index resolution: prefer the parsed slot id (price-monotonic
                 // at creation) so the count is order-independent, matching the
                 // accountant (accounting.ts).  Fall back to array position only
                 // for ids that are not grid slot ids.
                 const spreadCount = countGapBandSpread(manager, grid, (o: ManagedOrder, i: number) => {
                     const idx = parseSlotIndex(o?.id);
                     return idx === null ? i : idx;
                 });
                 manager.initialSpreadCount = spreadCount;
                 manager.currentSpreadCount = spreadCount;

             } finally {
                 await manager.resumeFundRecalc();
                 manager.resumeRecalcLogging();
             }
             manager.logger?.log?.(`Loaded ${manager.orders.size} orders from persisted grid.`, 'info');
        });
    }

function resolveMinScaleSlots(primary: unknown, secondary: unknown): number {
    const p = Number(primary);
    if (Number.isFinite(p)) return Math.max(0, Math.floor(p));
    const s = Number(secondary);
    if (Number.isFinite(s)) return Math.max(0, Math.floor(s));
    return MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MIN_SCALE_SLOTS;
}

/**
     * Initialize and orchestrate the order grid.
     *
     * @return {Promise<void>}
     * @throws {Error} If initialization fails or account totals are missing.
     */
export async function initializeGrid(manager: OrderManagerLike): Promise<void> {
        if (!manager) throw new Error('initializeGrid requires a manager instance');

        try {
            await withBlockchainRetry(
                () => manager._initializeAssets(),
                'initializeAssets',
                { logger: manager.logger }
            );
        } catch (e) {
            manager.logger?.log?.(`Asset initialization failed during grid init: ${getErrorMessage(e)}`, 'warn');
        }

        // FIX: Add explicit state validation to prevent cryptic errors later
        if (!manager.assets || !manager.assets.assetA || !manager.assets.assetB) {
            throw new Error('Asset initialization did not complete properly - assetA or assetB undefined');
        }
        if (!manager.config) {
            throw new Error('Manager config not initialized before grid initialization');
        }

        const mpRaw = manager.config.startPrice;
        manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: mpRaw type=${typeof mpRaw}, value=${mpRaw}`, 'debug');

        // Auto-derive price if not a fixed numeric value (e.g. "pool", "book", or undefined)
        if (typeof mpRaw !== 'number' || isNaN(mpRaw)) {
            try {
                const { BitShares } = require('../bitshares_client');
                // startPrice is the master price source: pass its own mode so a
                // pinned poolRef only refines pool discovery. Without this,
                // the old `priceMode || 'auto'` read (priceMode is never set in
                // the runtime path) let a poolRef override startPrice:"book".
                const startPriceMode = resolveStartPriceMode(mpRaw, manager.config.priceMode || 'auto');
                const derived = await derivePriceWithPoolRef(BitShares, manager.config.assetA ?? '', manager.config.assetB ?? '', startPriceMode, manager.config.poolRef);
                if (derived) {
                    manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: Derived new startPrice=${derived.toFixed(8)} (mode=${startPriceMode})`, 'info');
                    manager.config.startPrice = Number(derived);
                } else {
                    throw new Error(`Price derivation returned no result for ${manager.config.assetA}/${manager.config.assetB}`);
                }
            } catch (err) {
                manager.logger?.log?.(`Failed to derive market price: ${getErrorMessage(err)}`, 'warn');
                throw err; // Re-throw to prevent "pool" string reaching numeric math
            }
        }

        const configuredMinPrice = manager.config.minPrice;
        const configuredMaxPrice = manager.config.maxPrice;
        const mp = Number(manager.config.startPrice);

        // Derive gridPrice — separate reference for x-factor bounds (may differ from startPrice).
        // Supported modes:
        //   - numeric: fixed value
        //   - "pool" / "book": live blockchain price for the pair
        //   - "ama"/"ama1".."ama4": center from profiles/orders/<botKey>.dynamicgrid.json
        //   - null/anything else: fallback to startPrice (backward-compatible)
        let gp = mp;
        let gpSource = 'startPrice';
        let amaSnapshot: AmaSnapshot | null = null;
        const whitelistFlags = getWhitelistFlags(manager.config.botKey ?? '');
        const isGridRangeScalingWhitelisted = whitelistFlags.asymmetricBounds === true;
        let gridPriceOffsetPct = 0;
        const gpRaw = manager.config.gridPrice;
        const gpMode = (typeof gpRaw === 'string') ? gpRaw.trim().toLowerCase() : null;
        if (typeof gpRaw === 'number' && Number.isFinite(gpRaw) && gpRaw > 0) {
            gp = gpRaw;
            gpSource = 'numeric';
            manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: gridPrice=numeric ${gp.toFixed(8)}`, 'info');
        } else if (gpMode === 'pool' || gpMode === 'book') {
            try {
                const { BitShares } = require('../bitshares_client');
                const derived = await derivePriceWithPoolRef(BitShares, manager.config.assetA ?? '', manager.config.assetB ?? '', gpMode, manager.config.poolRef);
                if (derived) {
                    gp = Number(derived);
                    gpSource = gpMode;
                    manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: gridPrice=${gpMode} ${gp.toFixed(8)}`, 'info');
                } else {
                    manager.logger?.log?.(`initializeGrid: ${gpMode} gridPrice unavailable, falling back to startPrice`, 'warn');
                }
            } catch (err) {
                manager.logger?.log?.(`initializeGrid: ${gpMode} gridPrice derivation failed: ${getErrorMessage(err)}`, 'warn');
            }
        } else if (/^ama(?:[1-4])?$/.test(gpMode || '')) {
            amaSnapshot = loadAmaCenterSnapshot(manager.config.botKey ?? '') as AmaSnapshot | null;
            const amaCenter = Number(amaSnapshot?.gridCenterPrice ?? loadAmaCenterPrice(manager.config.botKey ?? ''));
            if (Number.isFinite(amaCenter) && amaCenter > 0) {
                gp = amaCenter;
                gpSource = 'ama';
                const snapshotGridPriceOffsetPct = Number(amaSnapshot?.gridPriceOffsetPct);
                const hasGridPriceOffset = isGridRangeScalingWhitelisted
                    && Number.isFinite(snapshotGridPriceOffsetPct)
                    && snapshotGridPriceOffsetPct !== 0;
                gridPriceOffsetPct = hasGridPriceOffset ? snapshotGridPriceOffsetPct : 0;
                manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: gridPrice=AMA center ${gp.toFixed(8)}`, 'info');
            } else {
                manager.logger?.log?.(`initializeGrid: AMA center unavailable for gridPrice, falling back to startPrice`, 'warn');
            }
        }

        const minP = resolveConfiguredPriceBound(manager.config.minPrice, DEFAULT_CONFIG.minPrice, gp, 'min');
        const maxP = resolveConfiguredPriceBound(manager.config.maxPrice, DEFAULT_CONFIG.maxPrice, gp, 'max');

        // Asymmetric bound adjustment: widen the bound in the AMA trend direction
        // and tighten the opposite side, giving the grid more room when the center
        // trails price. Uses slope data from the dynamicgrid.json snapshot.
        let resolvedMinP = minP;
        let resolvedMaxP = maxP;
        let rangeScalingFactor: number | null = null;
        let appliedTrend: 'UP' | 'DOWN' | null = null;
        let minScaleSlots: number | null = null;
        if (gpSource === 'ama' && Number.isFinite(minP) && Number.isFinite(maxP)
            && isGridRangeScalingWhitelisted) {
            const dw = amaSnapshot?.dynamicWeights;
            // Fallback to root-level asymmetricBounds when dynamicWeights is
            // absent (asymmetricBounds: true without dynamicWeight: true).
            const rootBounds = !dw && amaSnapshot?.asymmetricBounds
                && typeof amaSnapshot.asymmetricBounds === 'object'
                ? amaSnapshot.asymmetricBounds
                : null;
            if (dw) {
                const maxAsymmetryFactor = resolveMaxAsymmetryFactor(
                    manager.config.asymmetricBounds?.maxAsymmetryFactor,
                    dw?.maxAsymmetryFactor,
                    MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR
                );
                const adjustment = applyAsymmetricBounds({
                    centerPrice: gp,
                    minPrice: minP,
                    maxPrice: maxP,
                    trend: dw?.trend,
                    // Prefer the unrounded offset so the rebuild recomputation
                    // matches computeAppliedAsymmetryMetrics in the adapter.
                    slopeOffset: Number.isFinite(dw?.rawSlopeOffset) ? dw.rawSlopeOffset : dw?.slopeOffset,
                    maxSlopeOffset: dw?.maxSlopeOffset,
                    maxAsymmetryFactor,
                });
                if (Number.isFinite(adjustment.appliedAsymmetryFactor)) {
                    resolvedMinP = adjustment.resolvedMinPrice;
                    resolvedMaxP = adjustment.resolvedMaxPrice;
                    rangeScalingFactor = Number(adjustment.appliedAsymmetryFactor);
                    appliedTrend = (dw?.trend === 'UP' || dw?.trend === 'DOWN') ? dw.trend : null;
                    minScaleSlots = resolveMinScaleSlots(manager.config.asymmetricBounds?.minScaleSlots, dw?.minScaleSlots);
                    manager.logger?.log?.(
                        `[BOUND-ASYMMETRY] trend=${dw.trend} slopeOffset=${dw.slopeOffset.toFixed(4)} `
                        + `raw=${((adjustment.rawAsymmetryFactor ?? 0) * 100).toFixed(1)}% `
                        + `cap=${((maxAsymmetryFactor ?? 0) * 100).toFixed(0)}% `
                        + `asymmetry=${((adjustment.appliedAsymmetryFactor ?? 0) * 100).toFixed(1)}% `
                        + `min ${(minP ?? 0).toFixed(8)}→${(resolvedMinP ?? 0).toFixed(8)} `
                        + `max ${(maxP ?? 0).toFixed(8)}→${(resolvedMaxP ?? 0).toFixed(8)}`,
                        'info'
                    );
                }
            } else if (rootBounds && Number.isFinite(rootBounds.appliedAsymmetryFactor)
                && (rootBounds.trend === 'UP' || rootBounds.trend === 'DOWN')) {
                // Persisted appliedAsymmetryFactor is already the clamped live
                // value, so feed it back through the canonical function with
                // neutral caps — same path the UI display uses. This keeps the
                // geometric safe-clamp active against the rebuild geometry
                // (the persisted factor was clamped at adapter time, possibly
                // against a different center).
                const adjustment = applyAsymmetricBounds({
                    centerPrice: gp,
                    minPrice: minP!,
                    maxPrice: maxP!,
                    trend: rootBounds.trend,
                    slopeOffset: Number(rootBounds.appliedAsymmetryFactor),
                    maxSlopeOffset: 1,
                    maxAsymmetryFactor: 1,
                });
                const asymmetry = Number(adjustment.appliedAsymmetryFactor);
                const rootTrend = rootBounds.trend;
                resolvedMinP = Number(adjustment.resolvedMinPrice);
                resolvedMaxP = Number(adjustment.resolvedMaxPrice);
                rangeScalingFactor = asymmetry;
                appliedTrend = rootTrend;
                minScaleSlots = resolveMinScaleSlots(manager.config.asymmetricBounds?.minScaleSlots, rootBounds.minScaleSlots);
                manager.logger?.log?.(
                    `[BOUND-ASYMMETRY] trend=${rootTrend} `
                    + `asymmetry=${(asymmetry * 100).toFixed(1)}% `
                    + `(root-level) min ${(minP ?? 0).toFixed(8)}→${(resolvedMinP ?? 0).toFixed(8)} `
                    + `max ${(maxP ?? 0).toFixed(8)}→${(resolvedMaxP ?? 0).toFixed(8)}`,
                    'info'
                );
            }
        }

        // Guard against geometrically broken bounds (issue #15): the resolved
        // min/max must strictly bracket the grid center. With divisor-based
        // min semantics a multiplier < 1 (e.g. "0.7x") resolves ABOVE the
        // center and would place the entire buy rail above market. Refuse to
        // start rather than silently clamping into a catastrophic grid.
        MathUtils.validateGridPriceBounds(resolvedMinP, resolvedMaxP, gp);

        let gridStartPrice = mp;
        let offsetAdjustedStartPrice = gridStartPrice;
        if (gpSource === 'ama' && gridPriceOffsetPct !== 0 && Number.isFinite(gridStartPrice) && gridStartPrice > 0) {
            const adjustedMarketPrice = gridStartPrice * (1 + (gridPriceOffsetPct / 100));
            manager.logger?.log?.(
                `[DIAGNOSTIC] initializeGrid: applying AMA market-price offset ${gridPriceOffsetPct.toFixed(3)}% `
                + `to startPrice ${gridStartPrice.toFixed(8)} -> ${adjustedMarketPrice.toFixed(8)}`,
                'info'
            );
            gridStartPrice = adjustedMarketPrice;
            offsetAdjustedStartPrice = adjustedMarketPrice;
        }
        const rMinP = resolvedMinP ?? 0;
        const rMaxP = resolvedMaxP ?? 0;
        if (!(gridStartPrice >= rMinP && gridStartPrice <= rMaxP)) {
            if (Number.isFinite(gp) && gp > 0 && gp >= rMinP && gp <= rMaxP) {
                gridStartPrice = gp;
                manager.logger?.log?.(
                    `initializeGrid: startPrice (${mp}) outside bounds [${rMinP}, ${rMaxP}]; using gridPrice center ${gp}`,
                    'warn'
                );
            } else {
                const clamped = clamp(gridStartPrice, rMinP, rMaxP);
                manager.logger?.log?.(
                    `initializeGrid: startPrice (${mp}) outside bounds [${rMinP}, ${rMaxP}]; clamping to ${clamped}`,
                    'warn'
                );
                gridStartPrice = clamped;
            }
        }

        // Narrowing-side slot guard (canonical: applyNarrowingSideGuard).
        const guard = applyNarrowingSideGuard({
            centerPrice: gridStartPrice,
            minPrice: resolvedMinP,
            maxPrice: resolvedMaxP,
            trend: appliedTrend,
            incrementPercent: manager.config.incrementPercent,
            minScaleSlots,
        });
        if (guard.held === 'max' && guard.maxPrice != null && resolvedMaxP != null) {
            manager.logger?.log?.(
                `[BOUND-ASYMMETRY] narrowing-side guard: max ${resolvedMaxP.toFixed(8)} collapses ` +
                `${Math.floor(Number(minScaleSlots))} levels; holding at ${guard.maxPrice.toFixed(8)}`,
                'info'
            );
            resolvedMaxP = guard.maxPrice;
        } else if (guard.held === 'min' && guard.minPrice != null && resolvedMinP != null) {
            manager.logger?.log?.(
                `[BOUND-ASYMMETRY] narrowing-side guard would pull min ${resolvedMinP.toFixed(8)} ` +
                `short of ${Math.floor(Number(minScaleSlots))} levels; holding at ${guard.minPrice.toFixed(8)}`,
                'info'
            );
            resolvedMinP = guard.minPrice;
        }

        // P4 / unanchored rebuild anchor: when the new generation is centered
        // on a static config value (not a live market source), owed fill
        // crawls carry the only fresh market direction — fold their net
        // direction into the rebuild center before the ladder is generated.
        // A live center already contains the movement, so its owed crawls are
        // dropped as a stale generation (see the clear below).
        const owedCrawls = Array.isArray(manager._pendingFillCrawls)
            ? manager._pendingFillCrawls
            : [];
        // Whether the ladder CENTER already reflects current market movement.
        // gpSource describes the gridPrice/bounds reference, NOT the center:
        // the center is gridStartPrice, built from mp (config.startPrice).
        // Only a derived startPrice (a non-numeric mode like "pool"/"book"
        // resolved to a fresh number above) or an AMA-driven center is live:
        // with gpSource === "ama" the center itself is still mp * (1 +
        // offset), but the offset comes from the live AMA snapshot, so the
        // center moves with the market. A numeric startPrice with a live
        // gridPrice still has a static center — a live gridPrice (bounds
        // reference only) does not make that static center fresh.
        const startPriceWasDerived = typeof mpRaw !== 'number' || Number.isNaN(Number(mpRaw));
        const centerIsLive = startPriceWasDerived || gpSource === 'ama';
        if (owedCrawls.length > 0 && !centerIsLive) {
            // Edge fills never crawl (static insurance). Classify them
            // against the OLD generation (manager.orders is replaced below)
            // with the same live anchors the runtime derivation uses, so the
            // fold can never be driven by an edge fill.
            const oldSlots: ManagedOrder[] = Array.from(manager.orders.values());
            const edgeAnchors = {
                buy: resolveLiveEdgeAnchorPrice(manager, 'buy'),
                sell: resolveLiveEdgeAnchorPrice(manager, 'sell')
            };
            const edgeBuyIds = edgeOrderIdSet(oldSlots, manager.config, ORDER_TYPES.BUY, edgeAnchors.buy, liveWindowIdSet(manager, ORDER_TYPES.BUY));
            const edgeSellIds = edgeOrderIdSet(oldSlots, manager.config, ORDER_TYPES.SELL, edgeAnchors.sell, liveWindowIdSet(manager, ORDER_TYPES.SELL));
            let netShift = 0;
            for (const e of owedCrawls) {
                if (e?.side === ORDER_TYPES.BUY && edgeBuyIds?.has(e.slotId)) continue;
                if (e?.side === ORDER_TYPES.SELL && edgeSellIds?.has(e.slotId)) continue;
                if (e?.side === ORDER_TYPES.SELL) netShift++;
                else if (e?.side === ORDER_TYPES.BUY) netShift--;
            }
            const stepPct = Number(manager.config?.incrementPercent);
            if (netShift !== 0 && Number.isFinite(stepPct) && stepPct > 0) {
                // One crawl moves the boundary one slot; the geometric ladder
                // step is incrementPercent, so shift the center by netShift steps.
                const folded = gridStartPrice * Math.pow(1 + stepPct / 100, netShift);
                // Re-clamp to the post-guard resolved bounds so a fold cannot
                // push the center outside the rail it is about to generate.
                const clampMin = Number.isFinite(Number(resolvedMinP)) ? Number(resolvedMinP) : rMinP;
                const clampMax = Number.isFinite(Number(resolvedMaxP)) ? Number(resolvedMaxP) : rMaxP;
                gridStartPrice = Math.max(clampMin, Math.min(clampMax, folded));
                manager.config.startPrice = gridStartPrice;
                manager.logger?.log?.(
                    `[BOUNDARY] Folded ${owedCrawls.length} owed fill crawl(s) (net ${netShift}) into ` +
                    `static grid center -> ${gridStartPrice.toFixed(8)}`,
                    'info'
                );
            }
        }

        manager.config.minPrice = resolvedMinP;
        manager.config.maxPrice = resolvedMaxP;
        manager._lastGridPricingContext = {
            gridPrice: gp,
            gridPriceOffsetPct,
            offsetAdjustedStartPrice,
            startPrice: gridStartPrice,
            configuredMinPrice,
            configuredMaxPrice,
            rangeScalingFactor
        };

        // Ensure percentage-based funds are resolved before sizing
        try {
            if (manager.accountId && !manager.accountTotals) {
                await manager.waitForAccountTotals(TIMING.ACCOUNT_TOTALS_TIMEOUT_MS);
            }
        } catch (e) {
            manager.logger?.log?.(`Failed to load account totals: ${getErrorMessage(e)}`, 'warn');
            // FIX: Add error handling - cannot proceed with grid initialization without account totals
            // Continuing would create grid with 0 fund allocation, rendering it non-functional
            throw new Error(`Cannot initialize grid without account totals: ${getErrorMessage(e)}`);
        }

        const { orders, boundaryIdx, initialSpreadCount, gapSlots, genesis } = createOrderGrid({
            ...manager.config,
            startPrice: gridStartPrice,
            minPrice: resolvedMinP,
            maxPrice: resolvedMaxP,
        });
        manager._gapSlots = gapSlots;
        if (genesis) {
            manager._genesis = genesis;
            // New generation: clear the missing-genesis fault/counter records so
            // the E2 sync-entry assert stops re-reporting a resolved condition
            // and an operator reading the logs sees only live faults.
            manager._missingGenesis = null;
            manager._genesisInvariantViolations = 0;
            manager._genesisInvariantLoggedAt = 0;
        }

        // A rebuilt grid is a NEW generation: the boundary below is re-derived
        // absolutely from the fresh price ladder, so owed fill crawls recorded
        // against the previous generation must not survive — their relative
        // deltas would shift the new anchor again for movement it already
        // contains (and their slot ids now name different prices).
        manager._clearPendingFillCrawls?.('grid rebuild');

        // Same generation contract for the LAST-FILL-GUARD pivot: it was
        // armed against the previous ladder, and restoreLastFillPivot would
        // refuse it against the new genesis anyway. Drop it now, then RE-ARM it
        // from the bot-scoped last real fill (rearmLastFillPivotFromMarketFill)
        // — the guard must not stay cold after a rebuild, and the re-arm is an
        // explicit, logged, persistable write instead of the read-time fallback
        // in resolveLastFillGuardReference doing the same job silently for the
        // rest of the run. Provenance stays 'fill', so a book seed never
        // qualifies.
        try {
            if (typeof manager._resetLastFillPivot === 'function') {
                manager._resetLastFillPivot('grid rebuild');
            } else {
                resetLastFillPivot(manager, 'grid rebuild');
            }
            rearmLastFillPivotFromMarketFill(manager);
        } catch {}

        // RC-8: Update boundary with notification to dependent systems
        // Persist master boundary for StrategyEngine
        if (manager.boundaryIdx !== boundaryIdx) {
            manager._restoreBoundary(boundaryIdx);
            // RC-8: Notify StrategyEngine of boundary change (if method exists)
            if (typeof manager.notifyBoundaryUpdate === 'function') {
                try {
                    manager.notifyBoundaryUpdate(boundaryIdx);
                } catch (err) {
                    manager.logger?.log?.(`Error notifying boundary update: ${getErrorMessage(err)}`, 'warn');
                }
            }
        }

        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, manager.assets);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, manager.assets);

        const { A: precA, B: precB } = getPrecisionsForManager(manager.assets);

        // Use centralized sizing context for both sides.
        // Resolve funds once upfront so both contexts share the same snapshot,
        // avoiding a redundant recalculateFunds inside the second _getSizingContext call.
        await manager.recalculateFunds();
        const sellCtx = await _getSizingContext(manager, 'sell', { skipRecalc: true });
        const buyCtx = await _getSizingContext(manager, 'buy', { skipRecalc: true });

        if (!sellCtx || !buyCtx) throw new Error('Failed to retrieve sizing context for grid initialization');

        let sizedOrders = calculateOrderSizes(
            orders as unknown as ManagedOrder[],
            manager.config,
            sellCtx.budget,
            buyCtx.budget,
            minSellSize,
            minBuySize,
            precA,
            precB
        );

        // Verification of sizes
        const sells = filterOrdersByType(sizedOrders, ORDER_TYPES.SELL).map((o) => Number(o.size || 0));
        const buys = filterOrdersByType(sizedOrders, ORDER_TYPES.BUY).map((o) => Number(o.size || 0));
        if (checkSizesBeforeMinimum(sells, minSellSize, precA) || checkSizesBeforeMinimum(buys, minBuySize, precB)) {
            throw new Error('Calculated orders fall below minimum allowable size.');
        }

        // Check for warning if orders are near minimal size (regression fix)
        const warningSellSize = minSellSize > 0 ? getMinOrderSize(ORDER_TYPES.SELL, manager.assets, 100) : 0;
        const warningBuySize = minBuySize > 0 ? getMinOrderSize(ORDER_TYPES.BUY, manager.assets, 100) : 0;
        if (checkSizeThreshold(sells, warningSellSize, precA, false) || checkSizeThreshold(buys, warningBuySize, precB, false)) {
            manager.logger?.log?.("WARNING: Order grid contains orders near minimum size. To ensure the bot runs properly, consider increasing the funds of your bot.", "warn");
        }

        // RC-2: Wrap atomic changes in grid lock
        await manager._gridLock.acquire(async () => {
            _clearOrderCachesLogic(manager);
            await manager._fundLock.acquire(async () => {
                await manager.resetFunds();
            });

            manager.pauseRecalcLogging();
            manager.pauseFundRecalc();
            try {
                // RC-2: Use _applyOrderUpdate (PRIVATE/UNLOCKED)
                for (const order of sizedOrders) {
                    await manager._applyOrderUpdate(order, 'grid-init', { skipAccounting: true });
                }
            } finally {
                await manager.resumeFundRecalc();
                manager.resumeRecalcLogging();
            }

            // RC-6: Spread count updates protected by grid lock.
            // initializeGrid always sets initialSpreadCount = gapSlots (theoretical
            // value for a fresh grid).  loadGrid uses the actual SPREAD-typed slot
            // count in the gap band, which may be lower after promotions absorbed
            // gap slots into a rail.  Both are correct for their context; callers
            // should not assume the two paths agree.
            manager.initialSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell;
            manager.currentSpreadCount = manager.initialSpreadCount;
        });
        // FIX: Use consistent optional chaining pattern for all logger calls
        manager.logger?.log?.(`Initialized grid with ${orders.length} orders.`, 'info');
        manager.logger?.logFundsStatus?.(manager);
        manager.logger?.logOrderGrid?.(Array.from(manager.orders.values()), gridStartPrice);
    }

    /**
     * Full grid resynchronization from blockchain state.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {Object} opts - Options for resynchronization.
     * @param {Function} opts.readOpenOrdersFn - Function to read open orders.
     * @param {Object} opts.chainOrders - Chain orders module.
     * @param {string} opts.account - Account name.
     * @param {string} opts.privateKey - Private key.
     * @returns {Promise<void>}
     */
export async function recalculateGrid(manager: OrderManagerLike, opts: { readOpenOrdersFn: () => Promise<unknown>; chainOrders: unknown; account: string; privateKey: string; [key: string]: unknown }): Promise<void> {
        const { readOpenOrdersFn, chainOrders, account, privateKey } = opts;

        // Suppress invariant warnings during full resync
        manager.startBootstrap();

        // Total timeout across all steps — prevents indefinite hang even if
        // an individual withBlockchainRetry step pins the event loop.
        const totalTimeoutMs = PIPELINE_TIMING.TIMEOUT_MS * 2; // 10 min
        let _resyncAborted = false;

        const work = (async () => {
            try {
                manager.logger?.log?.('Starting full resync...', 'info');
                if (_resyncAborted) return;

                // #1: Initialize assets with timeout + retry + node failover
                try {
                    await withBlockchainRetry(
                        () => manager._initializeAssets(),
                        'initializeAssets',
                        { logger: manager.logger }
                    );
                } catch (e) {
                    manager.logger?.log?.(`Asset initialization failed during resync: ${getErrorMessage(e)}`, 'warn');
                }
                if (_resyncAborted) return;

                // #2: Fetch account totals with timeout + retry + node failover
                await withBlockchainRetry(
                    () => manager.fetchAccountTotals(),
                    'fetchAccountTotals',
                    { logger: manager.logger }
                );
                if (_resyncAborted) return;

                // #3: Read open orders with timeout + retry + node failover
                const chainOpenOrders = await withBlockchainRetry(
                    () => readOpenOrdersFn(),
                    'readOpenOrders',
                    { logger: manager.logger }
                );
                if (_resyncAborted) return;
                if (!Array.isArray(chainOpenOrders)) return;

                await withBlockchainRetry(
                    () => manager.syncFromOpenOrders(chainOpenOrders, { skipAccounting: true }),
                    'syncFromOpenOrders',
                    { logger: manager.logger }
                );
                if (_resyncAborted) return;

                // resetFunds under _fundLock + snapshot; persistGrid outside lock to
                // avoid blocking concurrent fund operations (tryDeductFromChainFree,
                // updateOptimisticFreeBalance, etc.) behind file I/O.  Same pattern as
                // loadGrid (grid.ts:~557) except that path skips persistGrid.
                let fundSnapshot!: { btsFeesOwed: number; accountTotals: AccountTotals };
                await manager._fundLock.acquire(async () => {
                    await manager.resetFunds();
                    fundSnapshot = {
                        btsFeesOwed: manager.funds.btsFeesOwed,
                        accountTotals: manager.accountTotals
                    };
                });

                if (_resyncAborted) return;
                await manager.persistGrid(undefined, undefined, fundSnapshot);

                if (_resyncAborted) return;
                await initializeGrid(manager);

                if (_resyncAborted) return;
                const { reconcileGridOrders } = require('./grid_reconcile');

                // #5: Reconcile grid orders.
                // No per-attempt wall-clock race around the whole reconcile.
                // Phase 2 performs many sequential broadcasts (creates ~3s each)
                // plus per-op retry with on-chain verification
                // (grid_reconcile_internal._createOrderFromGrid: uncertain creates
                // are re-read, adopted if landed, and re-broadcast only on
                // authoritative absence). An outer timeout would fire mid-batch,
                // orphan in-flight broadcasts, and let the next attempt virtualize
                // and re-create them — the duplicate-accumulation death spiral.
                // Reads inside reconcile already follow the 30s/3-retry/node-
                // failover standard via withBlockchainRetry, and the 10-min
                // totalTimeoutMs safety net below bounds the whole resync.
                try {
                    await reconcileGridOrders({ manager, config: manager.config, account, privateKey, chainOrders, chainOpenOrders });
                } catch (err) {
                    manager.logger?.log?.(`Error during startup order reconciliation: ${getErrorMessage(err)}`, 'error');
                    throw new Error(`Grid recalculation failed during order reconciliation: ${getErrorMessage(err)}`);
                }
                // Fix #5 (Mode D): the P3 boundary-evidence gate above may have
                // re-derived the boundary via manager._restoreBoundary. recalculateGrid's
                // earlier persistGrid (before initializeGrid) captured the stale value, so
                // without this flush the corrected boundary never reaches disk and the
                // [BOUNDARY-EVIDENCE] contradiction re-fires on every resync. Persist the
                // reconciled grid (corrected boundary included) now.
                try {
                    await manager.persistGrid(undefined);
                } catch (persistErr) {
                    manager.logger?.log?.(`Error persisting boundary-corrected grid after reconcile: ${getErrorMessage(persistErr)}`, 'warn');
                }
                if (_resyncAborted) return;

                manager.logger?.log?.('Full resync complete.', 'info');
            } finally {
                manager.finishBootstrap();
            }
        })();

        // Swallow late rejection if timeout wins the race
        Promise.resolve(work).catch(() => {});
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            work,
            new Promise<void>((_, reject) => {
                timeoutId = setTimeout(
                    () => {
                        _resyncAborted = true;
                        reject(new Error(`recalculateGrid timed out after ${totalTimeoutMs}ms`));
                    },
                    totalTimeoutMs
                );
            })
        ]);
        clearTimeout(timeoutId);
        return result;
    }

    /**
     * Check for grid divergence and trigger update if threshold is met.
     *
     * @param {import('./types').OrderManager} manager - Manager instance with order state
     * @returns {unknown}
     */
export function checkAndUpdateGridIfNeeded(manager: OrderManagerLike): { buyUpdated: boolean; sellUpdated: boolean; buyShrink: boolean; sellShrink: boolean } {
        const rawThreshold = manager.config?.gridLimits?.GRID_REGENERATION_PERCENTAGE;
        // NOTE: a configured 0 (or non-numeric) falls back to the global default
        // instead of disabling. 0 never worked as "disable" (ratio >= 0 is always
        // true, i.e. constant regen), so no working configuration is broken by this.
        const threshold = (Number.isFinite(Number(rawThreshold)) && Number(rawThreshold) > 0)
            ? Number(rawThreshold)
            : GRID_LIMITS.GRID_REGENERATION_PERCENTAGE;
        const chainSnap = manager.getChainFundsSnapshot();
        const gridBuy = Number(manager.funds?.total?.grid?.buy || 0);
        const gridSell = Number(manager.funds?.total?.grid?.sell || 0);
        const result = { buyUpdated: false, sellUpdated: false, buyShrink: false, sellShrink: false };

        const sides = [
            { name: 'buy', grid: gridBuy, orderType: ORDER_TYPES.BUY },
            { name: 'sell', grid: gridSell, orderType: ORDER_TYPES.SELL }
        ];

        for (const s of sides) {
            if (s.grid <= 0) continue;

            const feeCoreOrders = manager.config.coreOrders && typeof manager.config.coreOrders === 'object'
                ? {
                    ...manager.config.coreOrders,
                    buy: Math.max(0, Number(manager.config.coreOrders.buy) || 0) + resolveEdgeCount(manager.config, 'buy'),
                    sell: Math.max(0, Number(manager.config.coreOrders.sell) || 0) + resolveEdgeCount(manager.config, 'sell'),
                }
                : manager.config.coreOrders;
            const availableFunds = calculateAvailableFundsValue(
                s.name,
                manager.accountTotals,
                manager.funds,
                manager.config.assetA,
                manager.config.assetB,
                feeCoreOrders,
                manager.config.min_BTS_value,
                manager.config.feeParams ?? null
            );

            // Denominator: side's allocated capital (or chain total fallback).
            const allocated = s.name === 'buy' ? chainSnap.allocatedBuy : chainSnap.allocatedSell;
            const denominator = (allocated > 0) ? allocated : (s.grid + availableFunds);
            const ratio = (denominator > 0) ? (availableFunds / denominator) * 100 : 0;

            // DOWNSIDE: grid-tracked size exceeds the (botFunds-capped) allocation,
            // so the side must shrink toward the new budget via the same resize path.
            // s.grid is funds.total.grid (ACTIVE + PARTIAL + VIRTUAL — planned size,
            // not just on-chain committed). Deliberately NOT based on per-side
            // chain-total drops: a normal fill moves value across sides (pays one
            // asset, receives the other), so one side's total routinely drops >=3%
            // on ordinary fills — and the fill pipeline already re-sizes from the
            // post-fill budget. External removal is caught here only while the plan
            // still carries the old budget; once the fill pipeline re-derives
            // VIRTUAL downward the overAlloc gap closes (grid == allocated), and the
            // committed-drift leg folded in below is what catches it. The two
            // together cover the pre- and post-pipeline phases.
            // NOTE: with an explicit 0 allocation the shared fallback denominator
            // yields overAlloc ≈ +100%, i.e. a 0%-funded side holding size always
            // triggers — which is the desired unwind (zero budget sizes everything
            // to 0 and the correction pass cancels the surplus; self-clearing).
            const overAlloc = (denominator > 0) ? ((s.grid - allocated) / denominator) * 100 : 0;

            const growTrigger = ratio >= threshold;
            const shrinkTrigger = overAlloc >= threshold;

            manager.logger?.log?.(
                `[DIVERGENCE] ${s.name.toUpperCase()} ratio check: availableFunds=${availableFunds.toFixed(5)}, allocated=${allocated.toFixed(5)}, ratio=${ratio.toFixed(4)}% (threshold=${threshold}%) → ${growTrigger ? 'TRIGGER-GROW' : 'no trigger'} | overAlloc=${overAlloc.toFixed(4)}% → ${shrinkTrigger ? 'TRIGGER-SHRINK' : 'no trigger'}`,
                'debug'
            );

            if (growTrigger || shrinkTrigger) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(s.orderType);
                if (s.name === 'buy') {
                    result.buyUpdated = true;
                    if (shrinkTrigger) result.buyShrink = true;
                } else {
                    result.sellUpdated = true;
                    if (shrinkTrigger) result.sellShrink = true;
                }
            }
        }

        // Fold the committed-drift legs into this single entry so the trigger is
        // complete on its own. Both numerators above track `virtual` (the grow
        // denominator via `availableFunds`, the shrink base via `total.grid`), so
        // an external deposit/withdrawal already folded into the plan by the
        // fill pipeline is invisible to them. The on-chain committed delta closes
        // that gap in both directions. Callers must refresh funds first
        // (monitorDivergence does; direct callers own that responsibility).
        const driftResult = _computeCommittedSizeDriftSync(manager);
        result.buyUpdated = result.buyUpdated || driftResult.buyUpdated;
        result.sellUpdated = result.sellUpdated || driftResult.sellUpdated;
        result.buyShrink = result.buyShrink || driftResult.buyShrink;
        result.sellShrink = result.sellShrink || driftResult.sellShrink;
        return result;
    }

    /**
     * Committed-size drift check (fund trigger blind-spot closure).
     *
     * checkAndUpdateGridIfNeeded measures available funds as
     * `chainFree - virtualReservation`. The fill/rotation sizing pipeline
     * re-derives VIRTUAL slot sizes from the live budget, so a deposit (or an
     * external withdrawal) is folded into the virtual reservation on the first
     * rotation after it lands. chainFree and virtual then move together, the
     * ratio stays pinned at the unallocated remainder, and a side whose
     * on-chain (ACTIVE/PARTIAL) orders still carry the pre-deposit sizes is
     * never flagged — the full-side resize waits for an unrelated full resync
     * (RMS or AMA recenter).
     *
     * This leg closes that blind spot: it computes the geometric ideal for
     * every side slot from the current budget and measures the gap against the
     * sizes actually committed on chain, applying the resize path's own
     * free-balance growth cap so the metric equals the on-chain delta a resize
     * would really produce. A side whose committed orders would change by
     * >= GRID_REGENERATION_PERCENTAGE of the committed size is flagged for the
     * same COW resize path (applyGridDivergenceCorrections), which updates
     * every changed on-chain order — i.e. the full side.
     *
     * Only on-chain slots contribute: VIRTUAL slots are the plan (already sized
     * by the fill pipeline) and SPREAD placeholders carry no commitment.
     * Non-slot-N shelf/manual orders are excluded (never resized by the
     * geometric pass; same gate as _recalculateGridOrderSizesFromBlockchain).
     *
     * @param {import('./types').OrderManager} manager - Manager instance with order state
     * @returns {{ buyUpdated: boolean; sellUpdated: boolean; buyShrink: boolean; sellShrink: boolean }}
     */
function _computeCommittedSizeDriftSync(manager: OrderManagerLike): { buyUpdated: boolean; sellUpdated: boolean; buyShrink: boolean; sellShrink: boolean } {
        const result = { buyUpdated: false, sellUpdated: false, buyShrink: false, sellShrink: false };
        if (!manager || !manager.assets || !manager.orders) return result;

        const rawThreshold = manager.config?.gridLimits?.GRID_REGENERATION_PERCENTAGE;
        // Same fallback contract as checkAndUpdateGridIfNeeded: a configured 0 or
        // non-numeric value falls back to the global default rather than disabling.
        const threshold = (Number.isFinite(Number(rawThreshold)) && Number(rawThreshold) > 0)
            ? Number(rawThreshold)
            : GRID_LIMITS.GRID_REGENERATION_PERCENTAGE;

        const sides = [
            { name: 'buy', orderType: ORDER_TYPES.BUY },
            { name: 'sell', orderType: ORDER_TYPES.SELL }
        ];

        for (const s of sides) {
            // Sync core: checkAndUpdateGridIfNeeded is sync and expects funds to
            // already be fresh (monitorDivergence / checkCommittedSizeDrift recalc).
            const ctx = _computeSizingContextSync(manager, s.name);
            if (!ctx || !(ctx.budget > 0)) continue;

            // Must match _recalculateGridOrderSizesFromBlockchain exactly: same
            // source (manager.orders), same ASC price sort, same denominator set.
            const allSideSlots = Array.from(manager.orders.values())
                .filter((o) => o.type === s.orderType)
                .sort((a, b) => a.price - b.price);
            if (allSideSlots.length === 0) continue;

            let newSizes: number[];
            try {
                newSizes = calculateRotationOrderSizes(
                    ctx.budget,
                    0,
                    allSideSlots.length,
                    s.orderType,
                    manager.config,
                    0,
                    ctx.precision
                );
            } catch (_err) {
                continue;
            }

            // Replay the resize path's free-balance cap so `growth` is exactly the
            // committed growth the resize could apply (VIRTUAL slots do not consume
            // free balance; shrink releases it back for later slots). The cap uses
            // the float delta (matching the resize), but the reported drift is gated
            // on the same blockchain-integer change test the resize uses to decide
            // whether an on-chain UPDATE is emitted.
            const freeKey = s.name === 'buy' ? 'buyFree' : 'sellFree';
            let sideFreeAvailable = Number(manager.accountTotals?.[freeKey] || 0);
            let growth = 0;
            let shrink = 0;
            let committedTotal = 0;
            for (let i = 0; i < allSideSlots.length; i++) {
                const slot = allSideSlots[i];
                if (!isOrderOnChain(slot) || !hasOnChainId(slot)) continue;
                if (parseSlotIndex(slot.id) === null) continue;

                const ideal = Number(newSizes?.[i] || 0);
                const current = Number(slot.size || 0);
                committedTotal += current;

                let newSize = ideal;
                const delta = ideal - current;
                if (delta > 0) {
                    const affordableDelta = Math.min(delta, Math.max(0, sideFreeAvailable));
                    if (affordableDelta < delta) newSize = current + affordableDelta;
                    sideFreeAvailable = Math.max(0, sideFreeAvailable - affordableDelta);
                } else if (delta < 0) {
                    sideFreeAvailable += Math.abs(delta);
                }

                // Match the resize's integer-space change gate: a slot whose size
                // rounds to the same blockchain integer emits no UPDATE and must not
                // count toward the drift metric (otherwise the leg would re-trigger
                // against a no-op resize every tick).
                const currentInt = floatToBlockchainInt(current, ctx.precision);
                const newInt = floatToBlockchainInt(newSize, ctx.precision);
                if (currentInt === newInt) continue;

                const applied = newSize - current;
                if (applied > 0) growth += applied;
                else if (applied < 0) shrink += Math.abs(applied);
            }

            // Baseline is the on-chain committed size, NOT the whole allocation:
            // a deposit's active-window share is a small slice of the allocation
            // (the far rail holds most of the plan), so an `allocated` denominator
            // would never reach 3% while the committed side is genuinely ~12%
            // under-sized. Relative to the committed side, a normal fill moves the
            // budget by well under the threshold, so this stays quiet in steady
            // state. No on-chain orders -> nothing to resize.
            if (!(committedTotal > 0)) continue;
            const growthPct = (growth / committedTotal) * 100;
            const shrinkPct = (shrink / committedTotal) * 100;
            const growTrigger = growthPct >= threshold;
            const shrinkTrigger = shrinkPct >= threshold;

            manager.logger?.log?.(
                `[DIVERGENCE] ${s.name.toUpperCase()} committed-drift check: committedTotal=${committedTotal.toFixed(5)}, committedGrowth=${growth.toFixed(5)}, committedShrink=${shrink.toFixed(5)}, growth=${growthPct.toFixed(4)}% (threshold=${threshold}%) → ${growTrigger ? 'TRIGGER-GROW' : 'no trigger'} | shrink=${shrinkPct.toFixed(4)}% → ${shrinkTrigger ? 'TRIGGER-SHRINK' : 'no trigger'}`,
                'debug'
            );

            if (growTrigger || shrinkTrigger) {
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(s.orderType);
                if (s.name === 'buy') {
                    result.buyUpdated = true;
                    if (shrinkTrigger) result.buyShrink = true;
                } else {
                    result.sellUpdated = true;
                    if (shrinkTrigger) result.sellShrink = true;
                }
            }
        }
        return result;
    }

    /**
     * Async committed-drift accessor: refresh funds, then run the sync core.
     * Public for callers/tests that want the drift-only result; the complete
     * trigger is checkAndUpdateGridIfNeeded, which folds this core in.
     * Naming mirrors the sizing pair: _computeCommittedSizeDriftSync is the
     * private computation, checkCommittedSizeDrift the public accessor.
     */
export async function checkCommittedSizeDrift(manager: OrderManagerLike): Promise<{ buyUpdated: boolean; sellUpdated: boolean; buyShrink: boolean; sellShrink: boolean }> {
        if (manager && typeof manager.recalculateFunds === 'function') {
            await manager.recalculateFunds();
        }
        return _computeCommittedSizeDriftSync(manager);
    }

    /**
     * Standardize grid sizes using blockchain total context.
     *
     * FUND CAPPING STRATEGY:
     * =====================
     * During grid regeneration (e.g., after fills increase available funds),
     * this method recalculates all order sizes using geometric weighting.
     * However, ACTIVE/PARTIAL orders must not grow larger than currently available funds.
     *
     * Rationale for capping:
     * 1. POST-FILL EXPANSION PREVENTION: After a large fill, funds become available.
     *    A naive size recalculation might expand orders, consuming all new capital.
     *    Capping prevents this "resize explosion" by limiting growth to available free balance.
     * 2. VIRTUAL ORDER PROTECTION: Virtual orders (not yet placed) are uncapped,
     *    allowing natural expansion when their slot comes up for placement.
     * 3. BLOCKCHAIN-BACKED CONSTRAINT: sideFreeAvailable tracks exactly what we can spend,
     *    decreasing as commitments grow (proportional to realized delta).
     *
     * Fund Capping Algorithm:
     * ========================
     * For each ACTIVE/PARTIAL order slot:
     *   1. Calculate new size from geometric series
     *   2. If delta > 0 (growth):
     *      - affordableDelta = min(delta, sideFreeAvailable)
     *      - Cap growth to what we actually have: newSize = currentSize + affordableDelta
     *      - Deduct from sideFreeAvailable (this spending is now committed)
     *   3. If delta < 0 (shrinkage):
     *      - Release the freed capital back to sideFreeAvailable
     *      - Allows later slots to grow into this freed capacity
     *   4. For VIRTUAL orders (not on-chain):
     *      - Apply new size directly (no capping)
     *      - They will be constrained when actually placed
     *
     * Example (2 slots, buy side, budget=1000, simplify to linear):
     * ========================================================
     * Initial: slot[0]=400 (ACTIVE), slot[1]=0 (VIRTUAL), sideFree=600
     * Recalc:  newSizes=[500, 500]
     *
     *   Process slot[0]:
     *     - Type: ACTIVE, current=400, new=500, delta=+100
     *     - affordableDelta = min(100, 600) = 100
     *     - Apply: size=500 (full growth), sideFree=500
     *
     *   Process slot[1]:
     *     - Type: VIRTUAL (not capped), current=0, new=500, delta=+500
     *     - Apply: size=500 (no cap check)
     *     - Result: slot[1] ready for placement, will consume from sideFree when placed
     *
     * @param {import('./types').OrderManager} manager - OrderManager instance
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Object} [options] - Options object
     * @param {import('./working_grid.js')} [options.workingGrid] - Working grid for COW pattern
     * @returns {Promise<{actions: Array, changed: boolean}|undefined>} - COW result or undefined
     * @private
     */
export async function _recalculateGridOrderSizesFromBlockchain(manager: OrderManagerLike, orderType: OrderType, options: { workingGrid?: WorkingGrid } = {}): Promise<{ actions: CowAction[]; changed: boolean } | undefined> {
        if (!manager.assets) return options?.workingGrid ? { actions: [], changed: false } : undefined;

        const workingGrid = options?.workingGrid || null;
        const collectActions = !!workingGrid;

        const isBuy = orderType === ORDER_TYPES.BUY;
        const sideName = isBuy ? 'buy' : 'sell';

        // Use centralized sizing context (respects botFunds % allocation)
        const ctx = await _getSizingContext(manager, sideName);
        if (!ctx) return collectActions ? { actions: [], changed: false } : undefined;

        // Get ALL slots for this side, sorted for calculateRotationOrderSizes.
        // SELL: sorted ASC (Market to Edge)
        // BUY: sorted ASC (Edge to Market)
        //
        // When a working grid is available (COW mode), read types from it
        // instead of manager.orders.  This ensures slots whose type changed
        // due to a boundary shift (e.g. SPREAD→BUY) are included in the
        // correct side's size calculation — using manager.orders here would
        // filter by stale pre-shift types and miss the crossers, producing a
        // budget allocation that doesn't match the post-shift grid structure.
        //
        // Empty (size-0 VIRTUAL) slots are stored SPREAD (side-neutral) after
        // normalization and are deliberately NOT included in the side's
        // ideal-size denominator here: a SPREAD slot cannot carry a size
        // (validateOrder forces SPREAD size back to 0), so including it would
        // only dilute the budget without giving the slot a usable size.
        // Activation sizing for empties is handled where re-typing happens:
        // spread-correction (prepareSpreadCorrectionOrders) and startup
        // reconcile (_deriveBudgetedSideSizes) both compute the full in-rail
        // geometric progression including empties, then re-type the picked slot
        // to BUY/SELL before placement.  The COW boundary-shift path re-types
        // the working grid by geometry first, so crossers stay in the correct
        // side's denominator.  Edge order slots are included here like any
        // other slot-N side slot: this geometric curve sizes them too, and the
        // activation picker (_pickEdgeSlots) only ever places an edge order
        // with the stored size the target-grid sizing pipeline already wrote
        // (exact values, one sizing rule). Skipping edge orders in this pass
        // would make the divergence resize disagree with that pipeline. Only
        // non-slot-N shelf/manual ids are skipped below.
        const orderSource = collectActions ? workingGrid : manager.orders;
        const allSideSlots = Array.from(orderSource.values())
            .filter((o) => o.type === orderType)
            .sort((a, b) => a.price - b.price);

        if (allSideSlots.length === 0) return collectActions ? { actions: [], changed: false } : undefined;

        // Calculate geometric sizes for the ENTIRE rail
        const newSizes = calculateRotationOrderSizes(
            ctx.budget,
            0,
            allSideSlots.length,
            orderType,
            manager.config,
            0,
            ctx.precision
        );

        const actions: CowAction[] = [];
        let changed = false;

        const freeKey = isBuy ? 'buyFree' : 'sellFree';
        let sideFreeAvailable = Number(manager.accountTotals?.[freeKey] || 0);

        if (!collectActions) manager.pauseRecalcLogging();
        try {
            // Apply new sizes to all slots on the side
            for (let i = 0; i < allSideSlots.length; i++) {
                const slot = allSideSlots[i];
                // Shelf/manual orders (non-slot-N ids, e.g. fork-kept deep-*
                // below the rail) sit outside window accounting: geometric
                // ideals must never resize them on-chain. Same gate as edge
                // classification and startup cancel candidates (issue #27
                // follow-up). No-op upstream (grids only mint slot-N).
                // NB: they stay in the denominator above (budget math
                // unchanged); only the per-slot mutation below is skipped.
                if (parseSlotIndex(slot?.id) === null) continue;
                let newSize = newSizes[i] || 0;

                // FUND CAPPING FOR COMMITTED (ON-CHAIN) ORDERS:
                // Only ACTIVE/PARTIAL orders are constrained by available funds.
                // Virtual orders (not yet placed) will be constrained when they are actually placed.
                //
                // NOTE: BTS update fees are paid from BTS balance (separate from asset balance),
                // so they don't affect this asset-side size cap. Fee budgets are tracked in
                // funds.btsFeesOwed and reserved separately via btsFeesReservation.
                const isCommitted = isOrderOnChain(slot);
                if (isCommitted) {
                    const currentSize = Number(slot.size || 0);
                    const delta = newSize - currentSize;
                    if (delta > 0) {
                        // GROWTH: Cap to available free balance
                        // This prevents aggressive expansion after fills
                        const affordableDelta = Math.min(delta, Math.max(0, sideFreeAvailable));
                        if (affordableDelta < delta) {
                            // Cannot afford full growth; cap to what's available
                            newSize = currentSize + affordableDelta;
                        }
                        sideFreeAvailable = Math.max(0, sideFreeAvailable - affordableDelta);
                    } else if (delta < 0) {
                        // SHRINKAGE: Release freed capital back for other slots
                        sideFreeAvailable += Math.abs(delta);
                    }
                }

                // Use integer comparison to avoid redundant updates from float noise
                const currentSizeInt = floatToBlockchainInt(slot.size || 0, ctx.precision);
                const newSizeInt = floatToBlockchainInt(newSize, ctx.precision);

                if (slot.size === undefined || currentSizeInt !== newSizeInt) {
                    changed = true;

                    if (collectActions) {
                        workingGrid.set(slot.id, {
                            ...slot,
                            size: newSize
                        });

                        if (isCommitted && hasOnChainId(slot)) {
                            actions.push({
                                type: COW_ACTIONS.UPDATE,
                                id: slot.id,
                                orderId: slot.orderId,
                                newGridId: slot.id,
                                newSize,
                                newPrice: slot.price,
                                order: {
                                    ...slot,
                                    size: newSize
                                }
                            });
                        }
                    } else {
                        // CRITICAL: Set skipAccounting=false to ensure delta is consumed/released from ChainFree
                        const resizeOk = await manager._updateOrder(
                            { ...slot, size: newSize },
                            'grid-resize',
                            { skipAccounting: false, fee: 0 }
                        );
                        if (resizeOk === false) {
                            manager.logger?.log?.(`Failed to resize order ${slot.id}`, 'warn');
                        }
                    }
                }

            }

            if (!collectActions) {
                await manager.recalculateFunds();
            }
        } finally {
            if (!collectActions) manager.resumeRecalcLogging();
        }

        if (collectActions) {
            return { actions, changed };
        }

        return undefined;
    }

    /**
     * High-level entry for resizing grid from snapshot using COW pattern.
     * Creates working grid, calculates new sizes, generates UPDATE actions.
     * Master grid is only updated after successful blockchain confirmation.
     *
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {string} orderType - 'buy', 'sell', or 'both' - which sides to update
     * @param {boolean} [fromBlockchainTimer=false] - If true, skip refetch of account totals (already current)
     * @param {number|null} [overrideBoundaryIdx=null] - Optional override for boundary index
     * @returns {Promise<{actions: Array, workingGrid: import('./working_grid.js'), workingIndexes: Object, workingBoundary: number, hasWorkingChanges: boolean, aborted: boolean}|null>}
     */
export async function updateGridFromBlockchainSnapshot(manager: OrderManagerLike, orderType: OrderType | 'both' = 'both', fromBlockchainTimer: boolean = false, overrideBoundaryIdx: number | null = null): Promise<{ actions: CowAction[]; workingGrid: WorkingGrid; workingIndexes: unknown; workingBoundary: number | null; hasWorkingChanges: boolean; aborted: boolean } | null> {
        if (!fromBlockchainTimer && manager.config?.accountId) {
            await manager.fetchAccountTotals(manager.config.accountId);
        }

        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        const allActions: CowAction[] = [];
        let hasWorkingChanges = false;

        const newBoundary = (overrideBoundaryIdx !== null) ? overrideBoundaryIdx : manager.boundaryIdx;

        // REASSIGN SLOT TYPES FIRST when the boundary is shifting.
        // _recalculateGridOrderSizesFromBlockchain needs to see the corrected
        // types so that slots which cross the boundary (e.g. SPREAD→BUY) are
        // included in the correct side's budget allocation.  Running assignGridRoles
        // after the size calc means crossers keep their pre-shift sizes, producing
        // an allocation that doesn't match the post-shift grid structure.
        //
        // NOTE: overrideBoundaryIdx carries the caller's intended boundary.
        // Divergence pins it to the committed value (fund changes never shift
        // rails — only fills move the boundary, and spread promotion derives
        // its own shift atomically in prepareSpreadCorrectionOrders).  The
        // boundary itself is only written atomically inside _commitWorkingGrid
        // via _setBoundary.
        if (overrideBoundaryIdx !== null && overrideBoundaryIdx !== manager.boundaryIdx) {
            const gapSlots = manager._gapSlots ?? calculateGapSlots(manager.config.incrementPercent, manager.config.targetSpreadPercent, manager.config.gridLimits);
            const allSlots = Array.from(workingGrid.values())
                .filter((s) => s.price != null)
                .sort((a, b) => a.price - b.price);
            const updatedSlots = assignGridRoles(allSlots, overrideBoundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });
            for (const slot of updatedSlots) {
                workingGrid.set(slot.id, slot);
            }
            hasWorkingChanges = true;
        }

        // Calculate size updates for each side (via existing sizing function in COW mode).
        // _recalculateGridOrderSizesFromBlockchain reads types from the working grid when
        // one is passed, so boundary-crossing slots are now correctly classified.
        if (orderType === ORDER_TYPES.BUY || orderType === 'both') {
            const buyResult = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid });
            allActions.push(...(buyResult?.actions ?? []));
            hasWorkingChanges = hasWorkingChanges || (buyResult?.changed ?? false);
        }
        if (orderType === ORDER_TYPES.SELL || orderType === 'both') {
            const sellResult = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.SELL, { workingGrid });
            allActions.push(...(sellResult?.actions ?? []));
            hasWorkingChanges = hasWorkingChanges || (sellResult?.changed ?? false);
        }

        // Return COW result only if there are changes
        if (allActions.length === 0 && !hasWorkingChanges) {
            return null;
        }

        return {
            actions: allActions,
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: newBoundary,
            hasWorkingChanges,
            aborted: false
        };
    }

    /**
     * Compare ideal grid vs persisted grid to detect divergence.
     * INDEPENDENT SIDE CHECKING: Buy and sell sides are evaluated independently.
     * Each side's RMS divergence is compared against its own threshold.
     * Only sides exceeding the threshold are marked for update.
     *
     * SCOPE: ACTIVE + VIRTUAL orders per side. VIRTUAL slots carry the planned
     * reservation for unplaced rail slots (see funds.virtual); a persisted-vs-ideal
     * drift there inflates the reservation and thereby pins Available
     * (Available = ChainFree - Virtual - fees), so it is structural, not transient.
     * PARTIAL orders are excluded (expected to deviate mid-fill); SPREAD placeholders
     * are excluded (size-0, no committed structure).
     *
     * PURPOSE: Detect if the calculated in-memory grid has diverged significantly from the
     * persisted grid state. High divergence indicates that order fills/rotations have caused
     * size distributions to deviate, potentially requiring grid size recalculation.
     *
     * METRIC: RMS (Root Mean Square) percentage of relative size differences
     * Formula: RMS% = sqrt(mean((calculated - persisted) / persisted)²) × 100
     * This measures the typical relative error across all orders on each side.
     *
     * SIDE INDEPENDENCE:
     * - Buy side RMS is checked against GRID_COMPARISON.RMS_PERCENTAGE independently
     * - Sell side RMS is checked against GRID_COMPARISON.RMS_PERCENTAGE independently
     * - One side can diverge while the other remains stable (no update for stable side)
     *
     * RC-4: Atomic snapshot taking prevents stale data from concurrent fill operations
     *   - Grids are snapshotted atomically before comparison
     *   - Prevents mixing old and new grid state
     *   - Ensures consistent RMS metrics across both sides
     *
     * @param {Array<any>} calculatedGrid - Ideal calculated grid
     * @param {Array<any>} persistedGrid - Persisted grid state
     * @param {import('./types').OrderManager|null} [manager=null] - Manager instance (for grid lock access)
     * @returns {Promise<any>}
     */
export async function compareGrids(calculatedGrid: unknown[], persistedGrid: unknown[], manager: OrderManagerLike | null = null): Promise<{ buy: { metric: number; updated: boolean }; sell: { metric: number; updated: boolean }; totalMetric?: number; thresholdPct?: number }> {
        if (!Array.isArray(calculatedGrid) || !Array.isArray(persistedGrid)) {
            return { buy: { metric: 0, updated: false }, sell: { metric: 0, updated: false } };
        }

        // RC-4: Take snapshots atomically to prevent concurrent modification races
        // If manager has grid lock, use it to get consistent snapshots
        let calculatedSnap: ManagedOrder[] = calculatedGrid as ManagedOrder[];
        let persistedSnap: ManagedOrder[] = persistedGrid as ManagedOrder[];

        if (manager?._gridLock?.acquire) {
            const snapshotResult = await manager._gridLock.acquire(() => {
                return {
                    calculated: Array.from(calculatedGrid) as ManagedOrder[],
                    persisted: Array.from(persistedGrid) as ManagedOrder[]
                };
            });
            calculatedSnap = snapshotResult.calculated;
            persistedSnap = snapshotResult.persisted;
        }

        // Filter to ACTIVE + VIRTUAL orders (excludes PARTIAL/SPREAD).
        // VIRTUAL slots hold the planned reservation (funds.virtual) for unplaced
        // rail slots, so a persisted-vs-ideal drift there is structural: it moves
        // Available = ChainFree - Virtual - fees. Partial orders are excluded from
        // divergence calculation as they are expected to deviate; they are instead
        // handled by the available-funds ratio check or follow-up correction.
        // Must be sorted ASC for calculateRotationOrderSizes to match geometric weight distribution
        const filterForRms = (orders: ManagedOrder[], type: OrderType): ManagedOrder[] => {
            const result = Array.isArray(orders) ? orders.filter((o) => o && o.type === type && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.VIRTUAL)) : [];
            return result
                .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
        };

        const calculatedBuys = filterForRms(calculatedSnap, ORDER_TYPES.BUY);
        const calculatedSells = filterForRms(calculatedSnap, ORDER_TYPES.SELL);
        const persistedBuys = filterForRms(persistedSnap, ORDER_TYPES.BUY);
        const persistedSells = filterForRms(persistedSnap, ORDER_TYPES.SELL);

        // Calculate ideal sizes for each order based on current available budget.
        // The sizing context (which includes recalculateFunds) is resolved once per side up front
        // so both buy and sell metrics share a single fund snapshot. This avoids the previous
        // double-recalculateFunds between the two sides and keeps the metric consistent even if
        // a fill event arrives between per-side calculations.
        const computeSideIdeals = (comparedOrders: ManagedOrder[], type: OrderType, ctx: { budget: number; precision: number } | null): ManagedOrder[] => {
            if (!manager || !ctx || ctx.budget <= 0 || comparedOrders.length === 0) return comparedOrders;

            // Identify ALL slots currently assigned to this side from the calculated
            // grid snapshot (not a fresh read from manager.orders).  Using the snapshot
            // avoids TOCTOU races and ensures the slot classification is consistent with
            // the grid state used for the RMS computation.  If a boundary shift is pending
            // (set via _gridSidesUpdated but not yet committed through the COW pipeline),
            // the types in manager.orders are stale — reading from the snapshot matches
            // what the rest of the comparison sees.
            const sideSlots = calculatedSnap
                .filter((o) => o.type === type)
                .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

            if (sideSlots.length === 0) return comparedOrders;

            // Calculate geometric ideals for the ENTIRE side (all slots)
            try {
                const allIdealSizes = calculateRotationOrderSizes(
                    ctx.budget,
                    0,
                    sideSlots.length,
                    type,
                    manager.config,
                    0,
                    ctx.precision
                );

                // Map Ideal sizes to IDs for quick lookup
                const idealMap = new Map<string, number>();
                sideSlots.forEach((slot, i) => idealMap.set(slot.id, allIdealSizes[i]));

                // Return the compared subset with their true geometric ideal sizes
                return comparedOrders.map((o) => ({ ...o, size: idealMap.get(o.id) ?? 0 }));
            } catch (e) {
                return comparedOrders;
            }
        };

        const needsBuy = calculatedBuys.length > 0 && manager?.assets;
        const needsSell = calculatedSells.length > 0 && manager?.assets;
        if (needsBuy || needsSell) {
            await manager.recalculateFunds();
        }
        const buyCtx = needsBuy
            ? await _getSizingContext(manager, 'buy', { skipRecalc: true })
            : null;
        const sellCtx = needsSell
            ? await _getSizingContext(manager, 'sell', { skipRecalc: true })
            : null;

        const buyIdeals = computeSideIdeals(calculatedBuys, ORDER_TYPES.BUY, buyCtx);
        const sellIdeals = computeSideIdeals(calculatedSells, ORDER_TYPES.SELL, sellCtx);

        // Calculate RMS divergence metric for each side
        const buyMetric = calculateGridSideDivergenceMetric(buyIdeals, persistedBuys, 'buy');
        const sellMetric = calculateGridSideDivergenceMetric(sellIdeals, persistedSells, 'sell');

        // Check if metrics exceed threshold and flag sides for regeneration
        // Set RMS_PERCENTAGE to 0 to disable RMS divergence checks
        let buyUpdated = false, sellUpdated = false;
        const rmsThresholdPct = resolveRmsThresholdPct(manager);
        if (manager && rmsThresholdPct > 0) {
            const limit = rmsThresholdPct / GRID_CONSTANTS.RMS_PERCENTAGE_SCALE;

            if (buyMetric > limit) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(ORDER_TYPES.BUY);
                buyUpdated = true;
            }
            if (sellMetric > limit) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(ORDER_TYPES.SELL);
                sellUpdated = true;
            }
            manager.logger?.log?.(
                `[RMS] BUY check: metric=${Format.formatPercent(buyMetric * 100, 2)}% (threshold=${rmsThresholdPct}%) → ${buyUpdated ? 'TRIGGER-RESYNC' : 'no trigger'} | SELL check: metric=${Format.formatPercent(sellMetric * 100, 2)}% (threshold=${rmsThresholdPct}%) → ${sellUpdated ? 'TRIGGER-RESYNC' : 'no trigger'}`,
                'debug'
            );
        } else if (manager) {
            manager.logger?.log?.(`[RMS] checks disabled (threshold=${rmsThresholdPct}%) — buy=${Format.formatPercent(buyMetric * 100, 2)}%, sell=${Format.formatPercent(sellMetric * 100, 2)}%`, 'debug');
        }

        return {
            buy: { metric: buyMetric, updated: buyUpdated },
            sell: { metric: sellMetric, updated: sellUpdated },
            totalMetric: (buyMetric + sellMetric) / 2,
            thresholdPct: rmsThresholdPct
        };
    }

    /**
     * Unified divergence monitoring.
     * Performs both Ratio-based and RMS-based divergence checks.
     * 
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {Array<any>} calculatedGrid - Ideal/calculated grid
     * @param {Array<any>} persistedGrid - Current/persisted grid
     * @returns {Promise<any>}
     */
export async function monitorDivergence(manager: OrderManagerLike, calculatedGrid: unknown[], persistedGrid: unknown[]): Promise<{ needsUpdate: boolean; buy: { updated: boolean; ratio: boolean; rms: boolean; metric: number; shrink: boolean }; sell: { updated: boolean; ratio: boolean; rms: boolean; metric: number; shrink: boolean }; orderType?: string | null; thresholdPct?: number }> {
        // Refresh once so every leg sizes from one snapshot. The trigger itself
        // is sync and already folds the committed-drift legs in (see
        // checkAndUpdateGridIfNeeded), so there is no separate drift call here.
        if (manager && typeof manager.recalculateFunds === 'function') {
            await manager.recalculateFunds();
        }
        // 1. Ratio + committed-drift divergence (available funds /
        //    over-allocation / on-chain committed delta).
        const ratioResult = checkAndUpdateGridIfNeeded(manager);

        const ratioBuy = ratioResult.buyUpdated;
        const ratioSell = ratioResult.sellUpdated;
        const buyShrink = ratioResult.buyShrink === true;
        const sellShrink = ratioResult.sellShrink === true;

        if (ratioBuy || ratioSell) {
            return {
                needsUpdate: true,
                buy: { updated: ratioBuy, ratio: ratioBuy, rms: false, metric: 0, shrink: buyShrink },
                sell: { updated: ratioSell, ratio: ratioSell, rms: false, metric: 0, shrink: sellShrink },
                orderType: getOrderTypeFromUpdatedFlags(ratioBuy, ratioSell)
            };
        }
        
        // 2. Check RMS-based divergence (structural deviation)
        const rmsResult = await compareGrids(calculatedGrid, persistedGrid, manager);
        
        const buyUpdated = rmsResult.buy.updated;
        const sellUpdated = rmsResult.sell.updated;
        
        return {
            needsUpdate: buyUpdated || sellUpdated,
            buy: { updated: buyUpdated, ratio: false, rms: rmsResult.buy.updated, metric: rmsResult.buy.metric, shrink: false },
            sell: { updated: sellUpdated, ratio: false, rms: rmsResult.sell.updated, metric: rmsResult.sell.metric, shrink: false },
            orderType: getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated),
            thresholdPct: rmsResult.thresholdPct
        };
    }

    /**
     * Collect on-chain buy and sell orders from the manager.
     * Filters to orders with valid orderId and positive size.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @returns {{onChainBuys: Array<import('./types').Order>, onChainSells: Array<import('./types').Order>}}
     */
function _getOnChainOrders(manager: OrderManagerLike): { onChainBuys: ManagedOrder[]; onChainSells: ManagedOrder[] } {
        // Slot-N gated: fork-kept shelf/manual orders (non-slot-N ids, e.g.
        // deep-*) sit outside window accounting — same gate as edge
        // classification and startup cancel candidates (issue #27 follow-up).
        // Without this, a live shelf masks an empty window side (oneSideEmpty
        // stays false) and skews the spread inputs. No-op on grids that only
        // mint slot-N ids.
        const isGridSlot = (o: ManagedOrder) => !!(o?.orderId && Number(o?.size || 0) > 0 && parseSlotIndex(o?.id) !== null);
        const onChainBuys = [
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE),
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL)
        ].filter(isGridSlot);

        const onChainSells = [
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE),
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.PARTIAL)
        ].filter(isGridSlot);

        return { onChainBuys, onChainSells };
    }

    /**
     * Calculate current market spread using on-chain orders.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @returns {number} The calculated spread percentage.
     */
export function calculateCurrentSpread(manager: OrderManagerLike): number {
        const { onChainBuys, onChainSells } = _getOnChainOrders(manager);
        return calculateSpreadFromOrders(onChainBuys, onChainSells);
    }

    /**
     * Proactive spread correction check.
     *
     * CRITICAL: Uses AsyncLock to prevent race conditions with fill processing.
     * Without the lock, a TOCTOU (Time-Of-Check-To-Use) vulnerability exists where:
     * - Fund snapshot is taken (check phase)
     * - Fill processor modifies funds in another thread
     * - Order is placed based on stale funds (use phase)
     * Result: Orders placed beyond available liquidity, fund accounting errors
     *
     * DESIGN DECISION: Lock is released before blockchain operations for performance
     * - Lock held: Fund verification and correction decision (synchronized)
     * - Lock released: Blockchain submission (async, potentially slow)
     * - RACE CONDITION WINDOW: Between lock release and blockchain submission
     * - MITIGATION: Pre-flight fund verification before submission; comprehensive error handling
     *
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {Object} BitShares - BitShares API client
     * @param {Function|null} [updateOrdersOnChainBatch=null] - Optional batch update function
     * @returns {Promise<any>}
     */
export async function checkSpreadCondition(manager: OrderManagerLike, _BitShares: unknown, updateOrdersOnChainBatch: ((correction: SpreadCorrection) => Promise<{ executed?: boolean; reason?: unknown; commitRefused?: boolean; skippedStalePlan?: boolean; [key: string]: unknown } | null | undefined>) | null = null): Promise<{ ordersPlaced: number; partialsMoved: number; stall?: SpreadCorrectionStall; transient?: boolean }> {
        // CRITICAL: Acquire corrections lock to serialize spread correction operations
        // This prevents concurrent fill processing from modifying funds while we're making decisions
        let correction: SpreadCorrection | null = null;
        let shouldApplyCorrection = false;
        // Why no effective order landed, when that happens. The caller uses the
        // exact cause (not a boolean) to decide whether a funds/open-orders
        // refresh can help and to log the truth: 'no-candidates' is structural
        // and owned by the out-of-spread staleness watchdog, while the fund and
        // batch causes are what a refresh actually repairs.
        let stall: SpreadCorrectionStall | undefined;

        if (!manager._gridLock) {
            manager.logger?.log?.('Spread check skipped: no grid lock available', 'warn');
            return { ordersPlaced: 0, partialsMoved: 0 };
        }

        // Derive current market price from the bot's own grid (no blockchain call needed).
        // Grid prices are in B/A format (e.g. BTS/XRP) so no inversion is required.
        // Mid between best bid and best ask is the most current price the bot has.
        // Falls back to config.startPrice when either side is empty (e.g. at startup).
        const { onChainBuys, onChainSells } = _getOnChainOrders(manager);
        const { bestBuy, bestSell } = getGridBestPrices(onChainBuys, onChainSells);
        const lastPrice = (bestBuy !== null && bestSell !== null)
            ? (bestBuy + bestSell) / 2
            : Number(manager.config.startPrice) || 0;

        // Keep the crossing floor current: refresh the cached live market price
        // when it is stale, paced to one read per freshness window. The planner
        // then uses current market truth instead of a possibly days-old fill,
        // which is what removes the need for a distance heuristic. Best-effort;
        // on failure the fill anchor remains the fallback.
        await maybeRefreshLiveMarketPrice(manager, _BitShares);

        // Lock guard is handled at function entry — if _gridLock is absent we return early.
        let fundSnapshot: FundStateSnapshot | null = null;

        // Detect empty-side condition: when one side has zero on-chain orders,
        // the spread is technically infinite and shouldFlagOutOfSpread's old
        // guard (return 0) prevented any correction from firing.  Now we
        // propagate the out-of-spread flag, but an empty side at a rail edge
        // (boundary clamped to 0 or allSlots.length-1) also needs a structural
        // resync to re-center the grid — spread correction alone would keep
        // activating SPREAD slots at suboptimal prices.
        const oneSideEmpty = onChainBuys.length === 0 || onChainSells.length === 0;

        const executeSpreadCheck = async () => {
            const currentSpread = calculateCurrentSpread(manager);

            // Nominal spread is the configured target spread percentage.
            // Keep this fixed: doubled-side flags are fill/replacement mechanics only.
            const nominalSpread = manager.config.targetSpreadPercent ?? DEFAULT_CONFIG.targetSpreadPercent;

            // Fixed tolerance: 0.5 steps = half increment (tighter spread check).
            const toleranceSteps = 0.5;

            const buyCount = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE)
                .concat(manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL))
                .filter((o) => o?.orderId && Number(o?.size || 0) > 0 && parseSlotIndex(o?.id) !== null)
                .length;
            const sellCount = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE)
                .concat(manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.PARTIAL))
                .filter((o) => o?.orderId && Number(o?.size || 0) > 0 && parseSlotIndex(o?.id) !== null)
                .length;

            manager.outOfSpread = shouldFlagOutOfSpread(currentSpread, nominalSpread, toleranceSteps, buyCount, sellCount, manager.config.incrementPercent);
            if (manager.outOfSpread === 0) return false;

            // P-A cold book: the orchestration short-circuit, evaluated in the
            // shared readiness gate so the planner, the crossing filter and the
            // COW bypass all reason from one verdict. This early return keeps
            // the cold classification ahead of the one-sided boundary branch.
            // The planner re-evaluates the gate per call (including the re-plan
            // path, which deliberately re-reads fresh state), so this is not a
            // duplicated verdict but the same rule at two points in the cycle.
            //
            // A cold book has no realized spread to repair — the "spread" is
            // synthetic (an empty side plus the startPrice fallback) and a
            // correction here can only guess a side and place through an unseen
            // market (issue #31). The reconcile path owns the first window;
            // 'cold-book' is a structural stall that arms the targeted sync.
            // Degraded causes (stale/unmatched) keep ok=true. A null reason is
            // a gate failure (correct-by-refusal) and stalls as 'readiness-gate'.
            const readiness = evaluateSpreadCorrectionReadiness(manager, {
                onChainOrders: { buys: onChainBuys, sells: onChainSells }
            });
            if (!readiness.ok) {
                const cold = readiness.reason === 'cold-book';
                manager.logger?.log?.(
                    (cold
                        ? `[SPREAD] Book is cold (no live BUY or SELL on chain); skipping spread correction — ` +
                          `the reconcile path owns the first window.`
                        : `[SPREAD] Spread-correction readiness gate failed; skipping this cycle.`) +
                    ` Requesting a targeted chain sync.`,
                    'warn'
                );
                stall = cold ? 'cold-book' : 'readiness-gate';
                return false;
            }

            // Check whether the empty side is caused by boundary-at-rail-edge.
            // When the boundary crawl has clamped to 0 or allSlots.length-1,
            // fill pressure can wipe out one entire side.  Spread correction
            // can activate SPREAD slots, but the underlying grid structure
            // remains skewed — without a structural resync the gap will keep
            // returning as fills re-push the boundary to the rail edge.
            if (oneSideEmpty && manager.boundaryIdx !== null && typeof manager.boundaryIdx === 'number') {
                const allSlots = Array.from(manager.orders.values())
                    .filter((o) => o.price != null)
                    .sort((a, b) => a.price - b.price);
                const gapSlots = manager._gapSlots ?? calculateGapSlots(manager.config.incrementPercent, manager.config.targetSpreadPercent, manager.config.gridLimits);
                const railLen = allSlots.length;
                const buyEndIdx = manager.boundaryIdx;
                const sellStartIdx = getSellStartIdx(manager.boundaryIdx, gapSlots);
                const buySideCount = Math.max(0, Math.min(railLen, buyEndIdx + 1));
                const sellSideCount = Math.max(0, railLen - sellStartIdx);

                // Structural resync: both sides have room but one is empty.
                // Fire a structural resync to re-center the grid around the
                // current price, giving both sides a balanced foundation.
                // The spread correction below provides immediate relief
                // while the resync runs in the background.
                if (buySideCount < 2 || sellSideCount < 2) {
                    manager.logger?.log?.(
                        `[SPREAD] Boundary at rail edge (boundaryIdx=${manager.boundaryIdx}, ` +
                        `buySlots=${buySideCount}, sellSlots=${sellSideCount}). ` +
                        `Requesting structural grid resync to re-center.`,
                        'warn'
                    );
                    if (typeof manager.requestStructuralGridResync === 'function') {
                        manager.requestStructuralGridResync(
                            'boundary-at-rail-edge',
                            { reason: `Boundary ${manager.boundaryIdx} leaves ${buySideCount} buy / ${sellSideCount} sell slots` }
                        ).catch((err: unknown) => {
                            manager.logger?.log?.(
                                `[SPREAD] Structural resync request failed: ${getErrorMessage(err)}`,
                                'error'
                            );
                        });
                    }
                }
            }

            // Limit spread = nominal + half increment tolerance (0.5 steps).
            const limitSpread = nominalSpread + ((manager.config.incrementPercent ?? 0) * toleranceSteps);
            // One-sided book: currentSpread is Infinity (no opposing quote), so
            // log the empty side instead of a bogus "0% > limit" comparison.
            const spreadDesc = oneSideEmpty
                ? `one-sided (${onChainBuys.length === 0 ? 'no buys' : 'no sells'})`
                : `${Format.formatPercent(currentSpread)} > ${Format.formatPercent(limitSpread)}`;
            manager.logger?.log?.(`Spread too wide (${spreadDesc}), correcting with ${manager.outOfSpread} extra slot(s)...`, 'warn');

            // Refresh funds before the side decision below: the top-of-tick recalc may
            // predate fills processed since, and determineOrderSideByFunds reads
            // manager.funds/accountTotals directly (not via _getSizingContext). No-op
            // while a fill cycle holds the recalc pause; funds that move after this
            // point are covered by the TOCTOU re-plan before broadcast.
            try { await manager.recalculateFunds(); } catch { /* best-effort */ }
            const decision = determineOrderSideByFunds(manager, lastPrice);
            let chosenSide = decision.side;
            if (!chosenSide) {
                // Exact-zero free funds still allow a no-new-commitment repair:
                // rotate a resting order into the promoted gap slot.
                if (decision.code === 'no-free-funds') {
                    const fallback = await prepareZeroFreeRotationFallback(manager);
                    if (fallback) {
                        correction = fallback.correction;
                        chosenSide = fallback.side;
                        manager.logger?.log?.(
                            `[SPREAD] No fundable side, but a rotation-only repair is available on ${fallback.side}; ` +
                            `using resting inventory (no new commitment).`,
                            'info'
                        );
                    }
                }
                if (!chosenSide) { stall = 'no-free-funds'; return false; }
            }

            // Perform spread correction by placing orders on the chosen side.
            if (!correction) {
                correction = await prepareSpreadCorrectionOrders(manager, chosenSide, manager.outOfSpread);
            }
            if (!correction) { stall = 'no-candidates'; return false; }
            let placeCount = getSpreadCorrectionActionCount(correction);
            // Fold each side into the stall cause; merge (never overwrite) across
            // the starvation fallback so an UNFUNDED plan on the chosen side is
            // not masked by an empty plan on the opposite side. The old code
            // overwrote plannedCount with the opposite side's 0, so a
            // planned-1/placed-0 side followed by a planned-0 opposite reported
            // 'no-candidates' and the maintenance refresh never armed — exactly
            // the stale-balance case the refresh exists for.
            let sideStall = classifySpreadStall(correction);

            // STARVATION FALLBACK: If the selected side has no correctable slots (e.g.
            // all SPREAD slots already filled or misaligned), try the opposite side.
            if (placeCount === 0) {
                const oppositeSide = decision.side === ORDER_TYPES.BUY ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
                manager.logger?.log?.(
                    `[SPREAD] Side ${decision.side} produced zero candidates; ` +
                    `trying opposite side ${oppositeSide}.`,
                    'debug'
                );
                const oppositeCorrection = await prepareSpreadCorrectionOrders(manager, oppositeSide, manager.outOfSpread);
                if (oppositeCorrection) {
                    correction = oppositeCorrection;
                    placeCount = getSpreadCorrectionActionCount(oppositeCorrection);
                    const oppositeStall = classifySpreadStall(oppositeCorrection);
                    // Precedence merge (never overwrite): 'unfunded' > sync-repairable
                    // > geometry bind > readiness > 'no-candidates'. The old collapse
                    // to 'unfunded'/'no-candidates' dropped every named cause.
                    sideStall = mergeSpreadStalls(sideStall, oppositeStall);
                }
            }

            // Capture fund snapshot under lock for pre-flight verification before broadcast
            fundSnapshot = _snapshotFundState(manager);
            // No executable correction on EITHER side. Carry the exact cause so the
            // caller refreshes only when a refresh can actually repair something:
            //   * 'no-candidates' — no spread-tightening slot exists at all. This is
            //     structural; the out-of-spread staleness watchdog escalates it to a
            //     re-center, so it must NOT re-arm the per-cooldown fund/open-orders
            //     refresh (previously every zero-placement did, churning a full
            //     account + open-orders reload on a structurally stalled grid).
            //   * 'unfunded' — a plan existed but free funds could not fund any of it;
            //     the balances/holds may be a stale snapshot, so a refresh is warranted.
            if (placeCount === 0) stall = sideStall;
            return placeCount > 0;
        };

        try {
            shouldApplyCorrection = await manager._gridLock.acquire(executeSpreadCheck);
        } catch (err) {
            manager.logger?.log?.(`Error checking spread condition: ${getErrorMessage(err)}`, 'error');
            // Track failure in recovery state for external monitoring.
            // Do NOT throw — the startup runtime path lacks a try/catch and
            // a throw would crash startup. The error is symptom of a deeper
            // issue (lock contention, grid inconsistency) that should be
            // diagnosed separately.
            if (manager._recoveryState) {
                manager._recoveryState = { ...manager._recoveryState, lastFailureAt: Date.now() };
            }
            return { ordersPlaced: 0, partialsMoved: 0 };
        }

        // Blockchain operations are intentionally OUTSIDE the lock to reduce lock contention.
        // The lock is only needed for fund verification; order placement doesn't need it.
        // Pre-flight fund verification mitigates TOCTOU between lock release and broadcast.
        if (shouldApplyCorrection && updateOrdersOnChainBatch && correction && fundSnapshot) {
            let activeCorrection: SpreadCorrection = correction;
            // Explicit non-null alias: fundSnapshot is assigned inside the
            // executeSpreadCheck closure, so TS control-flow cannot prove it
            // non-null here even though the guard above checked it.
            const baseFundSnapshot: FundStateSnapshot = fundSnapshot;
            const currentFunds = _snapshotFundState(manager);
            const fundChanged = baseFundSnapshot.buyFree !== currentFunds.buyFree
                || baseFundSnapshot.sellFree !== currentFunds.sellFree
                || baseFundSnapshot.buyLocked !== currentFunds.buyLocked
                || baseFundSnapshot.sellLocked !== currentFunds.sellLocked;
            if (fundChanged) {
                // TOCTOU: fund state changed between lock release and broadcast.
                // Lock-free re-plan — no _gridLock needed because the fund read
                // (recalculateFunds) is serialized by _fundLock internally, and
                // the remaining logic is read-only against COW-frozen state.
                // All grid-lock-needing work (fund verification, grid reads) is
                // done under the single outer acquire above; this re-plan runs
                // after that lock was released.
                // Refresh lastPrice from current grid state — the grid may
                // have changed since function entry (TOCTOU).
                const freshOnChain = _getOnChainOrders(manager);
                const freshBest = getGridBestPrices(freshOnChain.onChainBuys, freshOnChain.onChainSells);
                const freshPrice = (freshBest.bestBuy !== null && freshBest.bestSell !== null)
                    ? (freshBest.bestBuy + freshBest.bestSell) / 2
                    : Number(manager.config.startPrice) || 0;
                const rePlanDecision = determineOrderSideByFunds(manager, freshPrice);
                let rePlanCorrection: SpreadCorrection | null = null;
                if (rePlanDecision.side) {
                    rePlanCorrection = await prepareSpreadCorrectionOrders(manager, rePlanDecision.side, manager.outOfSpread);
                } else if (rePlanDecision.code === 'no-free-funds') {
                    // Fund state changed to zero free between lock release and
                    // broadcast. Do not discard a rotation-only repair: it
                    // needs no new funds.
                    const fallback = await prepareZeroFreeRotationFallback(manager);
                    rePlanCorrection = fallback?.correction ?? null;
                }
                if (rePlanCorrection && getSpreadCorrectionActionCount(rePlanCorrection) > 0) {
                    activeCorrection = rePlanCorrection;
                    manager.logger?.log?.(
                        `[SPREAD] Fund state changed between lock release and broadcast — ` +
                        `re-planned with updated funds: ${activeCorrection.ordersToPlace?.length || 0} creates, ` +
                        `${activeCorrection.ordersToRotate?.length || 0} rotation(s)`,
                        'info'
                    );
                } else {
                    manager.logger?.log?.(
                        `[SPREAD] Fund state changed; re-plan produced no viable orders. Skipping cycle.`,
                        'warn'
                    );
                    // A plan existed before the fund change but the re-plan found
                    // nothing executable. Carry the cause here too (F2): this is the
                    // most fund-relevant outcome of all, so it must not silently skip
                    // the refresh request while every sibling branch signals it.
                    stall = classifySpreadStall(rePlanCorrection);
                    return { ordersPlaced: 0, partialsMoved: 0, stall };
                }
            }
            // P1: hold the broadcast/placement region across the whole attempt
            // loop (re-plan + broadcast). A defer-if-broadcasting fill rebalance
            // yields while this region is held, and a waiting one parks on
            // _awaitBroadcastIdle, so a concurrent commit is far less likely to
            // bump master between this correction's plan and its broadcast — the
            // race that made the commit guard refuse the batch. This narrows the
            // window rather than closing it absolutely (the idle wait is bounded
            // and proceeds on timeout), so the commit guard stays the backstop
            // and the retry below re-plans from fresh master. The COW batch
            // refcounts the region internally; this is the outer holder.
            const MAX_SPREAD_ATTEMPTS = Number(TIMING?.SPREAD_CORRECTION_MAX_ATTEMPTS) > 0
                ? Number(TIMING.SPREAD_CORRECTION_MAX_ATTEMPTS)
                : 2;
            let attempts = 0;
            // Whether the most recent refusal is retryable — reported to the P4
            // watchdog so a non-transient cause (commit-refused /
            // update-target-missing) counts toward staleness instead of being
            // waved through as a retry. Defaults to transient for the P2
            // collision-blocked path, which has no batch result.
            let lastTransient = true;
            let lastResult: { executed?: boolean; reason?: unknown; commitRefused?: boolean; skippedStalePlan?: boolean; [key: string]: unknown } | null = null;
            const canHoldRegion = typeof (manager as unknown as { startBroadcasting?: unknown }).startBroadcasting === 'function'
                && typeof (manager as unknown as { stopBroadcasting?: unknown }).stopBroadcasting === 'function';
            if (canHoldRegion) (manager as unknown as { startBroadcasting: () => void }).startBroadcasting();
            try {
                while (attempts < MAX_SPREAD_ATTEMPTS) {
                    attempts++;
                    // P2: before broadcasting, detect a planned CREATE whose
                    // destination was taken by a competing batch after planning,
                    // and re-derive instead of shipping a known collision.
                    const resolution = await resolveOccupiedCorrection(manager, activeCorrection, attempts, MAX_SPREAD_ATTEMPTS);
                    if (resolution.action !== 'broadcast') {
                        manager.logger?.log?.(
                            `[SPREAD-CORRECTION] Plan-time dedupe: ${resolution.occupied.length} planned slot(s) occupied since planning ` +
                            `(${resolution.occupied.slice(0, 8).join(', ')}${resolution.occupied.length > 8 ? ', …' : ''}); ` +
                            (resolution.action === 'replanned' ? 're-planning from fresh master' : 'no re-plan candidate — refusing this cycle'),
                            'warn'
                        );
                        recordSpreadCorrectionRefusal(manager, SPREAD_CORRECTION_REFUSAL.CREATE_COLLISION);
                        if (resolution.action === 'replanned') {
                            recordSpreadCorrectionRetry(manager);
                            activeCorrection = resolution.correction;
                            continue;
                        }
                        break;
                    }
                    const batchResult = await updateOrdersOnChainBatch(activeCorrection);
                    lastResult = batchResult ?? null;
                    if (batchResult && batchResult.executed === true) {
                        await manager.recalculateFunds();
                        const placed = getSpreadCorrectionActionCount(activeCorrection);
                        return { ordersPlaced: placed, partialsMoved: 0 };
                    }
                    const cause = classifySpreadRefusalCause(batchResult);
                    recordSpreadCorrectionRefusal(manager, cause);
                    const transient = isTransientSpreadRefusal(cause);
                    lastTransient = transient;
                    if (!transient || attempts >= MAX_SPREAD_ATTEMPTS) break;
                    manager.logger?.log?.(
                        `[SPREAD-CORRECTION] Batch refused (${cause}); re-planning from fresh master ` +
                        `(attempt ${attempts + 1}/${MAX_SPREAD_ATTEMPTS})`,
                        'warn'
                    );
                    const replanned = await replanSpreadCorrectionFromFreshMaster(manager);
                    if (!replanned || getSpreadCorrectionActionCount(replanned) === 0) break;
                    recordSpreadCorrectionRetry(manager);
                    activeCorrection = replanned;
                }
            } catch (err) {
                manager.logger?.log?.(`Error applying spread correction on-chain: ${getErrorMessage(err)}`, 'warn');
                return { ordersPlaced: 0, partialsMoved: 0, stall: 'apply-error' };
            } finally {
                if (canHoldRegion) (manager as unknown as { stopBroadcasting: () => void }).stopBroadcasting();
            }
            manager.logger?.log?.(
                `Spread correction batch was prepared but not executed. Keeping local state unchanged.` +
                (lastResult ? ` (cause=${classifySpreadRefusalCause(lastResult)})` : ''),
                'warn'
            );
            // Retryable only when the last refusal cause was transient; a
            // commit-refused / update-target-missing / unmatched / shutdown
            // refusal counts toward the persistent-stale watchdog.
            return { ordersPlaced: 0, partialsMoved: 0, stall: 'batch-not-executed', transient: lastTransient };
        }
        return { ordersPlaced: 0, partialsMoved: 0, stall };
    }

    /**
     * Grid health check for structural violations.
     * Monitors for "Dust Partials" that are too small to be traded on-chain,
     * scoped to the active buy/sell window.
     *
     * NOTE: Internal gaps (virtual slots between active ones) are no longer
     * flagged as violations. The "Edge-First" placement strategy intentionally
     * creates these gaps to maximize grid coverage during fund expansion.
     *
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {Function|null} [updateOrdersOnChainBatch=null] - Optional batch update function.
     * @returns {Promise<any>}
     */
export async function checkGridHealth(manager: OrderManagerLike, _updateOrdersOnChainBatch: ((correction: SpreadCorrection) => Promise<{ executed?: boolean }>) | null = null): Promise<{ buyDust: boolean; sellDust: boolean; buyDustOrders: unknown[]; sellDustOrders: unknown[] }> {
        if (!manager) return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };

        // Skip health checks during bootstrap to prevent spamming warnings
        if (manager.isBootstrapping()) return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };

        // Health checks are scoped to the active on-chain window only.
        // This keeps detection aligned with maintenance actions that operate on
        // active window partials.
        const { buyDust, sellDust, buyDustOrders, sellDustOrders } = await checkWindowDust(manager);

        // Partial split/merge maintenance is intentionally disabled.
        // Health checks remain detection-only.

        return { buyDust, sellDust, buyDustOrders, sellDustOrders };
    }

    /**
     * Dust check covering all partial orders, with interior-only guard.
     *
     * The top-of-window partial (closest to market) is always eligible for dust
     * detection since cancelling it is just the grid edge moving inward.
     *
     * Interior partials (further from market) are eligible when they have a
     * duplicate price level — another active order at essentially the same price —
     * or when their size is already below the per-slot dust threshold. In the
     * duplicate-price case cancelling won't leave a gap because the sibling
     * active order already covers that price level; in the below-threshold case
     * the residual is economically negligible and otherwise strands forever (the
     * residual path only cancels zero-value residuals, and interior dust rarely
     * has a duplicate price level) — cancelling lets rotation re-derive the slot.
     *
     * Returns boolean flags plus the actual dust order objects so callers can act
     * on individual orders (dust is cancelled immediately on detection).
     *
     * @param {import('./types').OrderManager} manager
     * @returns {Promise<any>}
     */
export async function checkWindowDust(manager: OrderManagerLike): Promise<{ buyDust: boolean; sellDust: boolean; buyDustOrders: ManagedOrder[]; sellDustOrders: ManagedOrder[] }> {
        if (!manager) return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };

        const allOrders = Array.from(manager.orders.values());

        const isLiveOrder = (order: ManagedOrder): boolean =>
            !!(order &&
            order.orderId &&
            order.price != null &&
            (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL));

        // Identify top-of-window orders (closest to market per side).
        const topBuyOrder = allOrders
            .filter((o) => o.type === ORDER_TYPES.BUY && isLiveOrder(o))
            .sort((a, b) => b.price - a.price)[0];
        const topSellOrder = allOrders
            .filter((o) => o.type === ORDER_TYPES.SELL && isLiveOrder(o))
            .sort((a, b) => a.price - b.price)[0];

        // Check if an order has a duplicate price level — an active sibling at
        // the same ladder level. If so, cancelling won't create a grid gap.
        // Only checks ACTIVE siblings. If two PARTIALs share a price with no active
        // sibling, neither qualifies and the gap is left to the rebalancer.
        // Grid-vs-grid: resolve both prices to their frozen ladder level
        // (genesis-aware), NOT priceSlotEqual at the asset precision (collapses
        // adjacent levels for a low-precision asset).
        const hasDuplicatePriceLevel = (order: ManagedOrder): boolean => {
            for (const o of allOrders) {
                if (o.id === order.id) continue;
                if (o.type !== order.type || o.state !== ORDER_STATES.ACTIVE || !o.orderId || o.price == null) continue;
                if (sameGridLevel(o.price, order.price, manager._genesis)) return true;
            }
            return false;
        };

        const allPartials = allOrders.filter((o) => isLiveOrder(o) && o.state === ORDER_STATES.PARTIAL);

        const isTopBuy = (o: ManagedOrder) => !!(topBuyOrder && o.id === topBuyOrder.id);
        const isTopSell = (o: ManagedOrder) => !!(topSellOrder && o.id === topSellOrder.id);

        // Compute per-slot dust thresholds once per side so the eligibility
        // filter below and _getDustOrders share the same sizing context
        // (avoids a duplicate recalculateFunds round per side). Each side's map
        // is only computed when that side actually has a partial candidate —
        // _computeDustThresholdMap runs a fund recalculation, so an empty side
        // must not pay for it.
        if (allPartials.length === 0) {
            return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };
        }
        const buyPartials = allPartials.filter((o) => o.type === ORDER_TYPES.BUY);
        const sellPartials = allPartials.filter((o) => o.type === ORDER_TYPES.SELL);
        const [buyThresholds, sellThresholds] = await Promise.all([
            buyPartials.length > 0 ? _computeDustThresholdMap(manager, ORDER_TYPES.BUY) : Promise.resolve(new Map<string, number>()),
            sellPartials.length > 0 ? _computeDustThresholdMap(manager, ORDER_TYPES.SELL) : Promise.resolve(new Map<string, number>()),
        ]);

        // A partial is below its per-slot dust threshold (economically negligible).
        const isDustSized = (o: ManagedOrder, thresholds: Map<string, number>): boolean => {
            const threshold = thresholds.get(o.id);
            return !!threshold && threshold > 0 && o.size < threshold;
        };

        // Safety filter: top-of-window partials always qualify; interior partials
        // qualify if they have a duplicate price level (no gap risk) OR their
        // size is already below the dust threshold. A sub-threshold interior
        // partial would otherwise strand on the book forever: the residual path
        // only cancels zero-value residuals, and an interior dust rarely has a
        // duplicate price level. Cancelling it frees the slot for rotation to
        // re-derive, so the tiny gap is closed by normal grid rebalancing.
        const eligibleBuyPartials = allPartials.filter((o) =>
            o.type === ORDER_TYPES.BUY && (isTopBuy(o) || hasDuplicatePriceLevel(o) || isDustSized(o, buyThresholds))
        );
        const eligibleSellPartials = allPartials.filter((o) =>
            o.type === ORDER_TYPES.SELL && (isTopSell(o) || hasDuplicatePriceLevel(o) || isDustSized(o, sellThresholds))
        );

        const buyDustOrders = await _getDustOrders(manager, eligibleBuyPartials, ORDER_TYPES.BUY, buyThresholds);
        const sellDustOrders = await _getDustOrders(manager, eligibleSellPartials, ORDER_TYPES.SELL, sellThresholds);

        return {
            buyDust: buyDustOrders.length > 0,
            sellDust: sellDustOrders.length > 0,
            buyDustOrders,
            sellDustOrders,
        };
    }

    /**
     * Compute the per-slot dust threshold for every order of a given type.
     * Returns a Map<orderId, threshold> using the same sizing context as
     * _getDustOrders so eligibility and dust classification stay consistent.
     * @private
     * @param {import('./types').OrderManager} manager
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {Promise<Map<string, number>>}
     */
async function _computeDustThresholdMap(manager: OrderManagerLike, type: OrderType): Promise<Map<string, number>> {
        const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const ctx = await _getSizingContext(manager, side);
        const dustThresholdPercent = manager.config?.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE;

        const sideSlots = Array.from(manager.orders.values())
            .filter((o) => o.type === type)
            .sort((a, b) => a.price - b.price);

        const idealSizes = ctx && ctx.budget > 0
            ? allocateFundsByWeights(
                ctx.budget,
                sideSlots.length,
                (manager.config.weightDistribution ?? {})[side],
                (manager.config.incrementPercent ?? 0) / 100,
                type === ORDER_TYPES.BUY,
                0,
                ctx.precision
            )
            : [];

        const map = new Map<string, number>();
        sideSlots.forEach((s, idx) => {
            const threshold = idealSizes.length > idx && idealSizes[idx] > 0
                ? getSingleDustThreshold(idealSizes[idx], dustThresholdPercent)
                : 0;
            map.set(s.id, threshold);
        });
        return map;
    }

    /**
     * Return the subset of partial orders that qualify as dust on a given side.
     * Shares the same sizing context as _hasAnyDust but returns the actual order
     * objects so callers can act on them (e.g. auto-cancel).
     * @private
     * @param {import('./types').OrderManager} manager
     * @param {Array<any>} partials - Candidate partial orders to test.
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Map<string, number>} [thresholdMap=null] - Optional precomputed per-slot dust thresholds.
     * @returns {Promise<Array<any>>} Orders whose size is below the dust threshold.
     */
async function _getDustOrders(manager: OrderManagerLike, partials: ManagedOrder[], type: OrderType, thresholdMap: Map<string, number> | null = null): Promise<ManagedOrder[]> {
        if (!partials || partials.length === 0) return [];

        const thresholds = thresholdMap || await _computeDustThresholdMap(manager, type);
        if (thresholds.size === 0) return [];

        return partials.filter((p) => {
            const threshold = thresholds.get(p.id);
            if (!threshold || threshold <= 0) return false;
            return p.size < threshold;
        });
    }

    /**
     * Check if any partial orders on a side represent "dust" that should be cleaned.
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {Array<any>} partials - Partial orders to check
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {Promise<boolean>} true if dust partials exist
     * @private
     */
async function _hasAnyDust(manager: OrderManagerLike, partials: ManagedOrder[], type: OrderType): Promise<boolean> {
        return (await _getDustOrders(manager, partials, type)).length > 0;
    }

    /**
     * Public dust helper shared by StrategyEngine and Grid health checks.
     * @param {import('./types').OrderManager} manager
     * @param {Array<any>} partials
     * @param {'buy'|'sell'} side
     * @returns {Promise<boolean>}
     */
export async function hasAnyDust(manager: OrderManagerLike, partials: ManagedOrder[], side: string): Promise<boolean> {
        const type = side === 'buy' ? ORDER_TYPES.BUY : side === 'sell' ? ORDER_TYPES.SELL : null;
        if (!type) return false;
        return await _hasAnyDust(manager, partials, type);
    }

    /**
     * Public dust helper that returns the subset of candidate partials currently below
     * the configured dust threshold for the requested side.
     * @param {import('./types').OrderManager} manager
     * @param {Array<any>} partials
     * @param {'buy'|'sell'} side
     * @returns {Promise<Array<any>>}
     */
export async function getDustOrders(manager: OrderManagerLike, partials: ManagedOrder[], side: string): Promise<ManagedOrder[]> {
        const type = side === 'buy' ? ORDER_TYPES.BUY : side === 'sell' ? ORDER_TYPES.SELL : null;
        if (!type) return [];
        return await _getDustOrders(manager, partials, type);
    }

    /**
     * Determine which side has more available funds for spread correction.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {number} currentMarketPrice - Last traded price in B/A format (e.g. BTS/XRP), used to
     *   normalize sell-side funds into buy-side units for a fair cross-asset comparison.
     * @returns {{ side: import('./types').OrderType|null, reason: string, code?: 'market-price-unavailable'|'no-free-funds' }} The side to correct on, or null with a structured cause.
     */
export function determineOrderSideByFunds(manager: OrderManagerLike, currentMarketPrice: number): { side: OrderType | null; reason: string; code?: 'market-price-unavailable' | 'no-free-funds' } {
        const buyAvailable = Math.min(
            Number(manager.funds?.available?.buy || 0),
            Number(manager.accountTotals?.buyFree || 0)
        );
        const sellAvailable = Math.min(
            Number(manager.funds?.available?.sell || 0),
            Number(manager.accountTotals?.sellFree || 0)
        );

        // Need at least some funds on a side to justify correction
        const buyPrecision = manager.assets?.assetB?.precision;
        const sellPrecision = manager.assets?.assetA?.precision;
        if (buyPrecision === undefined || sellPrecision === undefined) {
            throw new Error(`CRITICAL: Asset precision unavailable for grid correction check`);
        }
        const buyMinUnit = 1 / Math.pow(10, buyPrecision);
        const sellMinUnit = 1 / Math.pow(10, sellPrecision);

        const buyViable = buyAvailable > buyMinUnit;
        const sellViable = sellAvailable > sellMinUnit;

        let side: OrderType | null = null;
        let skipReason: string | null = null;
        if (buyViable && sellViable) {
            // Normalize sell (assetA) to assetB units using market price so both sides
            // are comparable. Without this, a raw number comparison (e.g. 2192 BTS vs
            // 0.12 XRP) always picks BUY even when the sell side is larger in value.
            // When the market price is unavailable (non-finite, e.g. empty book after
            // a crash wiped one side), raw-unit comparison across assets is meaningless
            // and can arm the wrong side in exactly the scenario where price may be
            // missing. Skip the correction and let the next cycle decide with a real
            // price rather than guess.
            const marketPrice = Number(currentMarketPrice);
            if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
                skipReason =
                    `market price unavailable (${String(currentMarketPrice)}) with funds on both sides ` +
                    `(buy=${Format.formatAmount8(buyAvailable)}, sell=${Format.formatAmount8(sellAvailable)})`;
            } else {
                const sellInBuyUnits = sellAvailable * marketPrice;
                side = buyAvailable >= sellInBuyUnits ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
            }
        } else if (buyViable) {
            side = ORDER_TYPES.BUY;
        } else if (sellViable) {
            side = ORDER_TYPES.SELL;
        }

        if (skipReason) {
            manager.logger?.log?.(
                `Spread correction skipped: ${skipReason}; refusing to compare raw cross-asset units`,
                'warn'
            );
            return { side: null, reason: skipReason, code: 'market-price-unavailable' };
        }

        if (!side) {
            // PURE FUND-DRIVEN: a zero/insufficient free balance skips the
            // correction outright. Committed inventory resting in orders is
            // never recycled to fund it — shrinking a resting order was the
            // source of stale-size inventory moves. The caller refreshes
            // account totals + open orders instead, because the balances may
            // simply be a stale snapshot (the grid does not lose funds).
            manager.logger?.log?.(
                skipReason
                    ? `Spread correction skipped: ${skipReason}`
                    : `Spread correction skipped: insufficient free funds ` +
                      `(buy=${Format.formatAmount8(buyAvailable)}, sell=${Format.formatAmount8(sellAvailable)})`,
                'warn'
            );
        }

        return {
            side,
            reason: side ? `Choosing ${side}` : (skipReason || 'Insufficient free funds'),
            ...(side ? {} : { code: 'no-free-funds' as const })
        };
    }

    /**
     * Resolve the MIN_SPREAD_ORDERS gap reserve used by boundary promotion.
     * Promotion may never consume the last `reserve` empty slots of the gap
     * band — this is the floor that keeps the spread from being zeroed.
     */
    function resolveMinSpreadOrdersReserve(manager: OrderManagerLike): number {
        const raw = Number(manager?.config?.gridLimits?.MIN_SPREAD_ORDERS ?? GRID_LIMITS.MIN_SPREAD_ORDERS);
        return (Number.isFinite(raw) && raw >= 0) ? Math.floor(raw) : GRID_LIMITS.MIN_SPREAD_ORDERS;
    }

    // Collect contiguous empty gap-band slots adjacent to a rail edge for boundary
    // promotion.  BUY walks upward from the boundary into the gap, SELL walks
    // downward from the sell start; both stop at the first unavailable slot.
    // Mirrors are collapsed into one directional walk (step +/- 1).
    //
    // PROMOTION CAP (gap-band geometry): promotion may consume at most
    // bandSize − MIN_SPREAD_ORDERS slots, where bandSize = sellStartIdx −
    // buyEndIdx − 1.  The previous cap (the OPPOSITE RAIL's span) constrained
    // nothing: for BUY it was the sell rail's length and for SELL the buy
    // rail's length, so a single correction could promote every gap slot and
    // zero the spread.  Reserving MIN_SPREAD_ORDERS empty slots guarantees the
    // gap never closes within this path regardless of quota.
    //
    // DEFENSE-IN-DEPTH WALK BOUNDS: the loop itself also stops
    // MIN_SPREAD_ORDERS short of the opposite rail edge (idx <= sellStartIdx−1−
    // reserve for BUY / idx >= buyEndIdx+1+reserve for SELL), so even if the
    // cap above is ever miscomputed the walk cannot consume the edged gap.
    // When bandSize <= reserve the bound disables promotion entirely.
    function _collectPromotableBoundarySlots(
        allSlotsByPrice: ManagedOrder[],
        railType: string,
        buyEndIdx: number,
        sellStartIdx: number,
        quota: number,
        spreadReserve: number,
        maxDepth: number
    ): ManagedOrder[] {
        const isBuy = railType === ORDER_TYPES.BUY;
        const bandSize = Math.max(0, sellStartIdx - buyEndIdx - 1);
        // Depth is bounded by three independent caps (defense-in-depth):
        //   reserve cap  — keep MIN_SPREAD_ORDERS empties in the band
        //   stranding cap— the boundary slide must never move a placed
        //                  opposite-rail order into the implied spread band;
        //                  constraining DEPTH here (not clamping the derived
        //                  boundary afterwards) keeps the promoted slots'
        //                  classification consistent with the new geometry
        //   walk bounds  — hard stop short of the opposite rail edge, even if
        //                  both caps above were ever miscomputed
        const maxPromotable = Math.max(0, bandSize - spreadReserve);
        const promotionQuota = Math.min(quota, maxPromotable, Math.max(0, maxDepth));
        const promoted: ManagedOrder[] = [];
        const step = isBuy ? 1 : -1;
        for (let idx = isBuy ? buyEndIdx + 1 : sellStartIdx - 1;
            promoted.length < promotionQuota
                && (isBuy
                    ? idx <= sellStartIdx - 1 - spreadReserve
                    : idx >= buyEndIdx + 1 + spreadReserve);
            idx += step) {
            const slot = allSlotsByPrice[idx];
            if (!slot || !isSlotAvailable(slot)) break;
            promoted.push(slot);
        }
        return promoted;
    }

    /**
     * Prepares one or more orders to correct a wide spread.
     * @param {import('./types').OrderManager} manager - The OrderManager instance.
     * @param {string} preferredSide - The side to place the correction on (ORDER_TYPES.BUY/SELL).
     * @returns {Promise<any>}
     * @throws {Error} If preferredSide is invalid.
     */
    export async function prepareSpreadCorrectionOrders(manager: OrderManagerLike, preferredSide: OrderType, outOfSpread: number = 0): Promise<SpreadCorrection | null> {
        // FIX: Validate preferredSide parameter to prevent silent logic errors
        if (preferredSide !== ORDER_TYPES.BUY && preferredSide !== ORDER_TYPES.SELL) {
            throw new Error(`Invalid preferredSide: ${preferredSide}. Must be '${ORDER_TYPES.BUY}' or '${ORDER_TYPES.SELL}'.`);
        }

        const ordersToPlace: ManagedOrder[] = [];
        // SHARED READINESS GATE (P-A/P-B/P-C): one verdict for the planner, the
        // crossing filter and the COW bypass. Hard refusal (cold book) returns
        // before any planning; degraded causes (stale/unmatched) keep planning
        // but withhold the bypass and drive the collision filter below.
        const onChainView = _getOnChainOrders(manager);
        const readiness = evaluateSpreadCorrectionReadiness(manager, {
            onChainOrders: { buys: onChainView.onChainBuys, sells: onChainView.onChainSells }
        });
        if (!readiness.ok) {
            // Only 'cold-book' is a named hard-refusal premise; a null reason is
            // a gate failure and gets its own stall so triage logs are precise.
            // Either way the targeted sync arms via the stall.
            const hardRefusalStall: SpreadCorrectionStall = readiness.reason === 'cold-book'
                ? 'cold-book'
                : 'readiness-gate';
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Refusing cycle: ${readiness.reason ?? 'readiness-gate-error'} — a targeted sync will re-evaluate`,
                'warn'
            );
            return { ordersToPlace: [], ordersToUpdate: [], plannedCount: 0, stallHint: hardRefusalStall, origin: COW_ORIGINS.SPREAD_CORRECTION };
        }
        // Empty-candidate stall cause: name the collision case when unmatched
        // orders are present, so the targeted-sync reason states the truth.
        // Keyed off the DATA, not `reason`: reason is priority-ranked (cold >
        // stale > unmatched), so a stale+unmatched cycle reports 'stale-snapshot'
        // and would otherwise mask the collision cause.
        const refusalStallHint: SpreadCorrectionStall = readiness.unmatched.length > 0
            ? 'unmatched-orders'
            : 'no-candidates';
        const railType = preferredSide;
        const sideName = railType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        // LAST-FILL FILTER (planner-side, same predicate as the broadcast guard).
        //
        // The guard drops any create at/through the last fill price, so a plan
        // built from such candidates can only end as "batch prepared but not
        // executed" (observed live: the only funded candidate was a SELL below
        // the 0.447640 fill, both attempts were dropped, and the correction
        // burned its cycle on a refusal). Filter here instead: the quota is then
        // filled from candidates the guard can accept, and an empty pool is an
        // honest "nothing to place" rather than a vetoed batch.
        //
        // Uses resolveLastFillGuardReference (the SAME effective pivot the guard
        // probes, including the persisted fallback that survives a rebuild) so
        // planner and guard cannot drift apart.
        const lastFillRef = resolveLastFillGuardReference(manager);
        const lastFillPivot = lastFillRef.price != null && Number.isFinite(Number(lastFillRef.price))
            ? Number(lastFillRef.price)
            : null;
        const lastFillSide = lastFillRef.type;
        const lastFillBlocks = (c: ManagedOrder): boolean => {
            if (lastFillPivot == null || lastFillSide == null) return false;
            if (c?.price == null || !Number.isFinite(Number(c.price))) return false;
            return isLastFillGuardBlocked(
                Number(c.price),
                railType,
                lastFillPivot,
                lastFillSide
            ).blocked === true;
        };
        let lastFillExcluded = 0;
        const passesLastFill = (c: ManagedOrder): boolean => {
            if (!lastFillBlocks(c)) return true;
            lastFillExcluded++;
            return false;
        };
        const lastFillRuleText = lastFillPivot == null
            ? ''
            : `${railType === ORDER_TYPES.BUY ? 'BUY must be below' : 'SELL must be above'} the last fill ${Format.formatPrice6(lastFillPivot)}`;
        const configuredMissingSlots = Number(outOfSpread || 0);
        const missingSlots = configuredMissingSlots > 0
            ? Math.floor(configuredMissingSlots)
            : 1;

        // STRATEGY: Window-Contiguous Correction (Safe Bridging)
        // Instead of calculating a "mid-price" (which can be dangerous in wide gaps),
        // we extend the live window contiguously so a fund-constrained correction
        // never leaves an interior hole.
        // 1. Priority: Update existing PARTIAL orders at the edge (Highest Buy / Lowest Sell).
        // 2. Fallback: Activate empty slots window-contiguous-first (Lowest Buy-rail /
        //    Highest Sell-rail, adjacent to the live window top).  A rail with no
        //    live orders has no window to extend, so it falls back to
        //    spread-edge-first (Highest Buy / Lowest Sell) to close the spread
        //    near market first.

        const allOrders = Array.from(manager.orders.values());

        // Boundary-correct type computation — hoisted before edge-partial and
        // candidate filters so all call sites (including the edge-partial filter
        // which now uses getSlotCorrectType) can access it.
        //
        // The natural type of a slot is derived from its position in the price-sorted
        // rail relative to boundaryIdx + gapSlots: indices in [0, boundaryIdx] are
        // BUY, indices in [boundaryIdx + gapSlots + 1, N-1] are SELL, the middle
        // band is SPREAD.
        const allSlotsByPrice = allOrders
            .filter((o) => o.price != null && Number.isFinite(o.price))
            .sort((a, b) => a.price - b.price);
        const slotIndexMap = new Map(allSlotsByPrice.map((o, i) => [o.id, i]));

        // Use the committed boundary for slot classification — never a speculative
        // value that hasn't been persisted through the COW pipeline.  If the
        // boundary shifts later via _commitWorkingGrid, the next spread
        // correction cycle will re-classify with the updated committed value.
        // This prevents TOCTOU-style inconsistency where slot types are chosen
        // against a boundary that was never atomically committed to manager.orders.
        const resolved = resolveGapBand(manager);
        const gapSlots = resolved.gapSlots;
        const boundaryKnown = resolved.boundaryIdx !== null && resolved.sellStartIdx !== null;
        // NOTE: `?? 0` keeps the legacy classification fallback (boundary not
        // restored yet → treat as bottom of the rail) so the correction can still
        // act on concrete BUY/SELL candidates.  Boundary PROMOTION is gated on
        // `boundaryKnown` below: deriving a new boundary from a fabricated 0 would
        // silently commit a boundary that was never real.
        const buyEndIdx = resolved.boundaryIdx ?? 0;
        const sellStartIdx = resolved.sellStartIdx ?? getSellStartIdx(buyEndIdx, gapSlots);
        const getSlotCorrectType = (slot: ManagedOrder): string => {
            const idx = slotIndexMap.get(slot.id);
            if (idx === undefined) return slot.type;
            if (idx <= buyEndIdx) return ORDER_TYPES.BUY;
            if (idx >= sellStartIdx) return ORDER_TYPES.SELL;
            return ORDER_TYPES.SPREAD;
        };

        // NOTE: rail partials are deliberately NOT correction targets. A
        // top-up cannot change bestBuy/bestSell (spread is price-based) and is
        // forbidden in place by clampPostFillUpdateSize, so the old
        // edge-partial update was always a no-op that starved the creates.
        // Spread repair is create-only; the sizing/rotation paths own partials.

        // Primary candidates: SPREAD-type slots adjacent to the gap.  Filter by
        // boundary-correct type so a SPREAD slot that, after a boundary shift, now sits
        // in the BUY or SELL zone is excluded — it would otherwise be placed on the
        // correction side at a price the grid already considers the opposite side.
        //
        // Candidate ordering: WINDOW-CONTIGUOUS FIRST. The SPREAD-TIGHTENING
        // GUARD below keeps only candidates on the market side of the live
        // window; among those the correction must EXTEND the window, i.e. pick
        // the slot closest to the live edge (highest SELL / lowest BUY). Picking
        // the far end instead leaves an interior hole between the new order and
        // the live window and over-tightens past the target spread. With no live
        // order (fully-empty rail) there is no anchor, so fall back to
        // market-nearest (lowest SELL / highest BUY) — the best available level.
        //
        // The previous two-branch comparator (windowFirst vs edgeFirst, exact
        // OPPOSITES) sorted a windowed SELL rail DESCENDING and picked the grid
        // ceiling: an order ~50% above bestSell that cannot tighten the spread
        // and is cancelled as surplus on the next resync. The single
        // market-nearest comparator that replaced it fixed that case but sorts
        // the FAR end first when the empties sit BELOW the window (the normal
        // post-fill state), which is the same class of bug mirrored.
        // Reuse the gate's view: one slot-gated scan per planner call feeds both
        // the readiness verdict and the live window edges below.
        const { onChainBuys, onChainSells } = onChainView;
        const railBestIsMax = railType === ORDER_TYPES.BUY;
        const bestLiveOnRail = railBestIsMax
            ? (onChainBuys.length ? Math.max(...onChainBuys.map((o) => o.price)) : null)
            : (onChainSells.length ? Math.min(...onChainSells.map((o) => o.price)) : null);
        const sortCandidates = (a: ManagedOrder, b: ManagedOrder): number => {
            if (bestLiveOnRail != null && a?.price != null && b?.price != null) {
                // Callers have already applied tightensSpread, so both prices
                // are on the same side of the anchor and distance is monotone.
                return Math.abs(a.price - bestLiveOnRail) - Math.abs(b.price - bestLiveOnRail);
            }
            return railBestIsMax ? b.price - a.price : a.price - b.price;
        };

        // SPREAD-TIGHTENING GUARD: on a rail that already has a live order, only
        // a candidate that IMPROVES that rail's best price is a spread repair at
        // all.  A SELL must land below the lowest live sell, a BUY above the
        // highest live buy.  Anything else merely parks funds in a slot that sits
        // beyond the live window and leaves bestBuy/bestSell — and therefore the
        // measured spread — bit-for-bit unchanged.
        //
        // Sorting alone cannot enforce this: the orphan pool is rail-wide (every
        // empty slot on the side), so market-nearest still resolves to the first
        // empty slot PAST the window, which is on the wrong side of the live
        // best.  Observed on a live market-pair bot whose live sells sat at
        // 1071-1134 with 116 empty sell slots above them: correction kept
        // creating orders at 1136, 1140, ... and eventually 1600/1605, none of
        // which could narrow the spread, until the next resync cancelled them
        // all as surplus.  This guard makes the grid edge structurally
        // unreachable for a correction rather than merely sorted last.
        //
        // The reference is taken from `_getOnChainOrders` — the SAME input set
        // `calculateCurrentSpread` measures the spread from — so "does this
        // placement narrow the spread" is answered against literally the same
        // book the flag was raised from, and there is no second definition of
        // "counts as an on-chain order" to drift out of sync.
        //
        // Note the deliberate classifier asymmetry: the ANCHOR is matched by
        // stored `o.type` (inherited from _getOnChainOrders), while CANDIDATES
        // below are matched by `getSlotCorrectType` geometry.  That is right
        // for both: an anchor is a live on-chain order whose side is what the
        // spread is actually computed from, whereas an empty candidate slot has
        // a normalized (often SPREAD) stored type and its intended side is the
        // geometric one.
        //
        // With no live order on the side there is no reference to improve, so
        // the market-nearest slot is by definition the best available and the
        // guard stays open.
        // F3: a null/non-finite price must never enter a candidate pool. The
        // pools are sorted by distance and sliced to missingSlots BEFORE the
        // duplicate-price filter drops null prices, so a null-price orphan would
        // otherwise consume a quota seat (JS coerces null to 0, sorting it first
        // on a SELL rail) and evict the window-nearest valid slot. Rejecting it
        // here is the single chokepoint both pools already pass through.
        const tightensSpread = (c: ManagedOrder): boolean => {
            if (c?.price == null || !Number.isFinite(c.price)) return false;
            if (bestLiveOnRail == null) return true;
            return railBestIsMax ? c.price > bestLiveOnRail : c.price < bestLiveOnRail;
        };
        // MARKET-CROSSING GUARD: never place a SELL at/below (or a BUY at/above)
        // the last price the account actually traded at. On a one-sided or
        // freshly-regenerated book the local anchor is absent, so without this
        // the correction happily sells under a market it cannot see (issue
        // #31). Fail-open when no real fill is known — never guess from grid
        // geometry. This complements tightensSpread (which is anchor-relative)
        // with an absolute, market-relative floor.
        // Crossing floor from the shared readiness verdict: a fresh live market
        // read when available, else the fill-derived reference. No distance
        // heuristic — the floor is kept current rather than judged stale.
        const marketRef = readiness.marketRef;
        const doesNotCrossMarket = (c: ManagedOrder): boolean => {
            if (marketRef == null || c?.price == null || !Number.isFinite(c.price)) return true;
            return railBestIsMax ? c.price < marketRef : c.price > marketRef;
        };
        // P-C COLLISION FILTER: when the gate saw fresh unmatched chain orders,
        // drop candidates whose price level they already occupy — placing
        // another order at the same level would duplicate a live order the
        // grid has not adopted yet. Price-level only: the unmatched row carries
        // no side, and a duplicate at a level is a duplicate regardless.
        //
        // Keyed off the DATA, not `reason`: reason is priority-ranked (cold >
        // stale > unmatched), so a stale+unmatched cycle reports
        // 'stale-snapshot' while the unmatched list is fully populated. The
        // P4 protection must not expire with snapshot staleness — those chain
        // orders only clear on the next sync.
        const unmatchedPrices = readiness.unmatched.length > 0
            ? readiness.unmatched.map((u) => Number(u?.price)).filter((p) => Number.isFinite(p) && p > 0)
            : [];
        const doesNotCollideUnmatched = (c: ManagedOrder): boolean => {
            if (unmatchedPrices.length === 0 || c?.price == null || !Number.isFinite(c.price)) return true;
            // The unmatched row carries only a price; use the candidate's own
            // side/size for the tolerance. Tolerance-based, NOT priceSlotEqual at
            // the asset precision (low-precision assets collapse adjacent levels).
            return !unmatchedPrices.some((p) => pricesOnSameLevel(
                p, c.size, railType, c.price, c.size, railType, manager.assets, manager.config?.incrementPercent
            ));
        };
        if (unmatchedPrices.length > 0) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] ${unmatchedPrices.length} known-unmatched chain price level(s) excluded from ${sideName} candidates — sync will adopt them first`,
                'warn'
            );
        }
        const typedSpreadCandidates = allOrders
            .filter((o) =>
                o.type === ORDER_TYPES.SPREAD
                && isSlotAvailable(o)
                && getSlotCorrectType(o) === railType
            )
            .filter(passesLastFill)
            .filter(tightensSpread)
            .filter(doesNotCrossMarket)
            .filter(doesNotCollideUnmatched)
            .sort(sortCandidates)
            .slice(0, missingSlots);

        // Secondary candidates: orphaned virtual slots that have lost their
        // order (e.g. stale-cleaned after a race condition during a crash, or a
        // lowest-sell slot dust-cancelled and then left unplaced after a
        // boundary shift). They are invisible to the gap-band SPREAD filter
        // above because they are stored as railType (not SPREAD).
        //
        // SCOPE (F4): this path repairs only orphans at the window's market
        // edge — the tightensSpread guard below keeps a SELL below the lowest
        // live sell and a BUY above the highest live buy. An orphan that sits
        // in the rail INTERIOR (between two live orders) leaves bestBuy/bestSell
        // bit-for-bit unchanged, so it is deliberately excluded here; interior
        // holes are a divergence/reconcile concern, not a spread repair. Do not
        // "fix" the guard to admit them — filling them would not tighten a
        // spread and would fight the window-contiguous placement strategy.
        //
        // Empty slots are stored SPREAD (side-neutral) after normalization, so
        // the stored type can be railType OR SPREAD — what matters is that the
        // boundary-correct type (geometry) matches the rail being corrected.
        // Filter by boundary-correct type so that filled-then-virtualized slots
        // whose boundary position has moved into the spread or opposite zone are
        // NOT re-activated on the stale side — doing so would compound inventory
        // at prices where the bot already traded.
        //
        // NOTE: we deliberately accept BOTH zero-size and sized virtual slots
        // here. A sized sell/buy slot that lost its orderId (the classic
        // boundary-oscillation orphan) has size > 0 but no on-chain order — the
        // old `size === 0` guard excluded it, so spread correction silently
        // planned 0 orders and the gap never closed. Dropping the guard is safe:
        // create targets are rebuilt from `current: 0` + the fresh ideal from
        // allocateFundsByWeights (grid.ts:2790-2800, 2861-2870), so a sized
        // orphan's stale stored size never leaks into a placement; getMinOrderSize
        // is only a collision-tolerance fallback (grid.ts:2712), not the primary
        // sizer. Orphans are excluded from the sideSlots sizing denominator too,
        // so this also removes the prior dilution of every other order.
        const orphanedVirtualCandidates = allOrders
            .filter((o) =>
                (o.type === railType || o.type === ORDER_TYPES.SPREAD)
                && o.state === ORDER_STATES.VIRTUAL
                && !o.orderId
                && getSlotCorrectType(o) === railType
            )
            .filter(passesLastFill)
            .filter(tightensSpread)
            .filter(doesNotCrossMarket)
            .filter(doesNotCollideUnmatched)
            .sort(sortCandidates)
            .slice(0, missingSlots);

        // If the funded rail is full, the spread itself may be stale: the
        // nearest empty slots are still in the gap band. Promote contiguous
        // empty gap slots from that rail edge so correction can repair the
        // boundary and place orders in one atomic COW commit.
        //
        // Requires a KNOWN committed boundary: with a null/unknown boundary the
        // rail edges are fabricated (buyEndIdx=0), so promotion would place
        // orders at arbitrary prices and return a boundary derived from that
        // fiction.  Without promotion there is nothing to commit, so falling
        // back to the pre-existing candidate paths is safe.
        const promotedCandidates: ManagedOrder[] = [];
        const spreadReserve = resolveMinSpreadOrdersReserve(manager);
        // STRANDING DEPTH CAP: the post-commit geometry re-derives the band
        // from the new boundary, sliding it over opposite-rail slots.  A
        // slide may never swallow an already-PLACED order into that band, so
        // promotion depth is capped up-front — constraining depth keeps the
        // derived boundary consistent with every promoted slot's placement;
        // clamping the boundary afterwards would not.
        let maxPromotionDepth = Infinity;
        if (railType === ORDER_TYPES.BUY) {
            for (let idx = Math.max(sellStartIdx, 0); idx < allSlotsByPrice.length; idx++) {
                if (allSlotsByPrice[idx]?.orderId) {
                    // Implied sell zone must start at/below the lowest placed
                    // sell: B' + gapSlots + 1 <= idx  =>  depth <= idx − G − 1 − B.
                    maxPromotionDepth = idx - gapSlots - 1 - buyEndIdx;
                    break;
                }
            }
        } else {
            for (let idx = Math.min(buyEndIdx, allSlotsByPrice.length - 1); idx >= 0; idx--) {
                if (allSlotsByPrice[idx]?.orderId) {
                    // Boundary may not drop below the highest placed buy:
                    // B' = B − depth >= idx  =>  depth <= B − idx.
                    maxPromotionDepth = buyEndIdx - idx;
                    break;
                }
            }
        }
        if (boundaryKnown && orphanedVirtualCandidates.length + typedSpreadCandidates.length < missingSlots) {
            const rawQuota = missingSlots - orphanedVirtualCandidates.length - typedSpreadCandidates.length;
            promotedCandidates.push(..._collectPromotableBoundarySlots(
                allSlotsByPrice,
                railType,
                buyEndIdx,
                sellStartIdx,
                rawQuota,
                spreadReserve,
                maxPromotionDepth
            ));
            // A boundary promotion moves the window into the spread band. If
            // any of the contiguous run would land through the last real fill,
            // the whole promotion is refused (dropping only the first slot
            // would break the run's contiguity and the boundary derivation).
            const crossingPromoted = marketRef == null
                ? []
                : promotedCandidates.filter((c) => !doesNotCrossMarket(c));
            const collidingPromoted = promotedCandidates.filter((c) => !doesNotCollideUnmatched(c));
            if (marketRef != null && crossingPromoted.length > 0) {
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] Refusing boundary promotion on ${sideName}: ` +
                    `${crossingPromoted.length} slot(s) would cross the last market fill ` +
                    `${Format.formatPrice6(marketRef)}`,
                    'warn'
                );
                promotedCandidates.length = 0;
            } else if (collidingPromoted.length > 0) {
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] Refusing boundary promotion on ${sideName}: ` +
                    `${collidingPromoted.length} slot(s) collide with known-unmatched chain orders`,
                    'warn'
                );
                promotedCandidates.length = 0;
            }
            if (promotedCandidates.length > 0) {
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] ${promotedCandidates.length} gap slot(s) available for boundary promotion on ${sideName}`,
                    'info'
                );
            } else {
                // Promotion produced nothing. Name the BINDING constraint —
                // the three are operationally different (a config change fixes
                // one, a geometry change fixes the others) and a bare "skipped"
                // makes all three look identical.
                const bandSize = Math.max(0, sellStartIdx - buyEndIdx - 1);
                const oppositeSide = railType === ORDER_TYPES.BUY ? 'sell' : 'buy';
                const reason = maxPromotionDepth <= 0
                    ? `stranding cap is 0 — a boundary slide would swallow a placed ${oppositeSide} order into the implied spread band`
                    : (bandSize <= spreadReserve
                        ? `gap band (${bandSize} slot(s)) is at or below the MIN_SPREAD_ORDERS reserve (${spreadReserve})`
                        : 'no contiguous empty run from the rail edge into the band');
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] no gap slot available on ${sideName} — ${reason}; the spread is not correctable on this side this cycle`,
                    'info'
                );
            }
        }

        // Merge, GAP BAND FIRST.  A boundary promotion is the only candidate
        // kind that places INSIDE the empty spread band, so it is listed ahead
        // of the rail pools.  In practice the promotion GATE above (only promote
        // when the rail pools under-fill the quota) already keeps the two from
        // competing: once the spread-tightening guard empties the rail pool of
        // useless far-rail slots, the gate opens and the band is asked.  The
        // ordering below is the belt to that braces — if the gate is ever
        // relaxed, the band still wins by default rather than losing to a
        // rail-wide pool that is capped at missingSlots on its own and so can
        // consume the whole quota without ever entering the gap.
        const remainingQuota = Math.max(0, missingSlots - orphanedVirtualCandidates.length);
        let spreadCandidates: ManagedOrder[] = [
            ...promotedCandidates.filter(passesLastFill),
            ...typedSpreadCandidates.slice(0, remainingQuota),
            ...orphanedVirtualCandidates
        ];
        if (lastFillExcluded > 0) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Excluded ${lastFillExcluded} candidate(s) from ${sideName} planning: ` +
                `${lastFillRuleText} (the broadcast guard would drop them)`,
                'debug'
            );
        }

        // Dedupe by slot id: an empty in-rail slot typed SPREAD (normalized) now
        // qualifies for BOTH orphanedVirtualCandidates and typedSpreadCandidates
        // (both accept SPREAD type + rail geometry), so a single slot can be
        // planned twice.  Duplicate CREATEs would inflate the sizing denominator
        // (diluting every order), mislead the plan counts, and get dropped by the
        // COW same-batch collision filter anyway.  Keep the first occurrence —
        // which under the gap-first merge is the band slot where one exists.
        {
            const seenSlotIds = new Set<string>();
            spreadCandidates = spreadCandidates.filter((c) => {
                if (!c?.id || seenSlotIds.has(c.id)) return false;
                seenSlotIds.add(c.id);
                return true;
            });
        }

        // P2: Filter out candidates whose price already has a placed order from any slot.
        // This prevents creating a duplicate order at the same price when a prior cycle's
        // order was not properly cleaned up (e.g. uncertain broadcast).
        if (spreadCandidates.length > 0) {
            const preFilter = spreadCandidates.length;
            spreadCandidates = spreadCandidates.filter((c) => {
                if (c.price == null) return false;
                // Grid-vs-grid: resolve both prices to their frozen ladder
                // level (genesis-aware), NOT priceSlotEqual at the asset
                // precision and NOT the chain tolerance (both can
                // collapse/merge adjacent grid levels).
                for (const o of allOrders) {
                    if (!isOrderPlaced(o) || o.price == null) continue;
                    if (o.id === c.id) continue;
                    if (sameGridLevel(o.price, c.price, manager._genesis)) return false;
                }
                return true;
            });
            const filteredCount = preFilter - spreadCandidates.length;
            if (filteredCount > 0) {
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] Filtered ${filteredCount}/${preFilter} candidate(s) with duplicate price levels`,
                    'warn'
                );
            }
        }

        if (spreadCandidates.length > 0) {
            manager.logger?.log?.(`[SPREAD-CORRECTION] Identified ${spreadCandidates.length}/${missingSlots} slot(s) for activation on ${sideName} (orphaned=${orphanedVirtualCandidates.length}, spread=${spreadCandidates.length - orphanedVirtualCandidates.length})`, 'debug');
        }

        if (spreadCandidates.length === 0) {
            manager.logger?.log?.(
                lastFillExcluded > 0 && lastFillPivot != null
                    ? `[SPREAD-CORRECTION] No placeable ${sideName} slot: every tightening slot is at/through the last fill ` +
                      `${Format.formatPrice6(lastFillPivot)} (${lastFillRuleText}). The spread cannot be tightened on this ` +
                      `side; a boundary move or a fill must restore headroom.`
                    : bestLiveOnRail == null
                        ? `[SPREAD-CORRECTION] No orphaned virtual slots or spread slots found. Skipping.`
                        : `[SPREAD-CORRECTION] No spread-tightening slot on ${sideName} (best live ${bestLiveOnRail}); every remaining empty slot sits beyond the live window and cannot narrow the spread. Skipping.`,
                'warn'
            );
            // Name the geometry bind: the window itself is wrong (a sell slot
            // below the last sale means the boundary/crawl is behind the fill),
            // so placement cannot repair the side and a re-center can.
            const emptyStall: SpreadCorrectionStall = (lastFillExcluded > 0 && lastFillPivot != null)
                ? 'last-fill-blocked'
                : refusalStallHint;
            return { ordersToPlace: [], ordersToUpdate: [], plannedCount: 0, stallHint: emptyStall, origin: COW_ORIGINS.SPREAD_CORRECTION };
        }

        // RAIL-OVERSUBSCRIBED: availableFund is chainFree − virtualReservation, so
        // it reads 0 whenever the empty rail already reserves more than the free
        // balance (observed live: free 454560.80 vs virtual 456046.21, a 1485 base
        // short, "planned 3, placing 0" every cycle for 84 minutes). That is not
        // "wait for a fill": the rail must be re-sized from chain truth, which a
        // re-center does. Detect it BEFORE the sizing-context gate (a zero budget
        // is the very symptom) and flag it so the persistence watchdog escalates
        // on its short fund window instead of the 30-minute structural one.
        {
            const sideChainFree = Math.max(0, Number(sideName === 'buy'
                ? manager.accountTotals?.buyFree
                : manager.accountTotals?.sellFree) || 0);
            const sideVirtual = Math.max(0, Number(sideName === 'buy'
                ? manager.funds?.virtual?.buy
                : manager.funds?.virtual?.sell) || 0);
            const sideAvailable = Math.max(0, Math.min(
                Number(manager.funds?.available?.[sideName] || 0),
                sideChainFree
            ));
            const epsilon = 1e-8;
            if (sideAvailable <= epsilon && (sideVirtual - sideChainFree) > epsilon) {
                try {
                    manager._spreadRailOversubscribed = {
                        side: sideName, virtual: sideVirtual, free: sideChainFree, at: Date.now()
                    };
                } catch { /* best-effort */ }
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] ${sideName} rail is OVERSUBSCRIBED: virtual reservation ` +
                    `${Format.formatAmount8(sideVirtual)} exceeds chain free ${Format.formatAmount8(sideChainFree)} ` +
                    `by ${Format.formatAmount8(sideVirtual - sideChainFree)} — the projection is stale, so the ` +
                    `correction funds what the chain actually holds free; a rail re-size (structural re-center) ` +
                    `is still the durable repair`,
                    'warn'
                );
            } else if (sideAvailable > epsilon) {
                try { manager._spreadRailOversubscribed = null; } catch { /* best-effort */ }
            }
        }

        const orphanedIds = new Set(orphanedVirtualCandidates.map((o) => o.id));
        const sideSlots = allOrders
            .filter((o) => o.type === railType && !orphanedIds.has(o.id))
            .sort((a, b) => a.price - b.price);
        const syntheticSideSlots = [
            ...sideSlots,
            ...spreadCandidates.map((slot) => ({ ...slot, type: railType }))
        ].sort((a, b) => a.price - b.price);

        const ctx = await _getSizingContext(manager, sideName);
        if (!ctx || syntheticSideSlots.length === 0) {
            // A missing context or an empty rail is genuinely structural.
            return { ordersToPlace: [], ordersToUpdate: [], ordersToRotate: [], plannedCount: 0, stallHint: 'no-candidates', origin: COW_ORIGINS.SPREAD_CORRECTION };
        }
        const precisionEpsilon = getPrecisionSlack(ctx.precision, 1);

        // Zero free funds must NOT return early: the fund-constrained rotation
        // below is the only repair a fully allocated rail has. With no budget
        // every create is skipped below, then a resting order is rotated into
        // the promoted slot (same booked size, no new commitment).
        const idealSizes = ctx.budget > 0
            ? allocateFundsByWeights(
                ctx.budget,
                syntheticSideSlots.length,
                (manager.config.weightDistribution ?? {})[sideName],
                (manager.config.incrementPercent ?? 0) / 100,
                railType === ORDER_TYPES.BUY,
                0,
                ctx.precision
            )
            : [];

        const idealById = new Map<string, number>();
        syntheticSideSlots.forEach((slot, idx) => {
            idealById.set(slot.id, Number(idealSizes[idx] || 0));
        });

        const availableFund = Math.max(0, Math.min(
            Number(manager.funds?.available?.[sideName] || 0),
            Number(sideName === 'buy' ? manager.accountTotals?.buyFree : manager.accountTotals?.sellFree) || 0
        ));
        // PURE FUND-DRIVEN: corrections are funded exclusively by
        // funds.available[side] and the cached accountTotals[side]Free read.
        // No resting order is ever shrunk to manufacture
        // budget (the previous self-funded/redistribution paths moved
        // inventory within a rail and were gamed by stale-size snapshots).
        // When free funds cannot cover every candidate, the loop below places
        // what they allow and stops; the caller refreshes account totals + open
        // orders to find out whether the shortfall was a stale accounting read
        // (the grid does not lose funds, it holds them in resting orders).

        const prioritizedTargets: PrioritizedTarget[] = [];

        // Spread repair works by adding PRICE LEVELS, never by deepening an
        // existing one: a top-up grows an order at its current price and so
        // cannot move bestBuy/bestSell, and it is un-executable in place
        // (a PARTIAL slot may not be grown by a COW update —
        // clampPostFillUpdateSize). The old edge-partial top-up always clamped
        // to a no-op yet ran FIRST and consumed the whole budget, leaving the
        // creates unfunded ("planned N, placing 0") and the batch empty
        // ("prepared but not executed"). Fund creates only, still from
        // available free funds alone.
        for (const slot of spreadCandidates) {
            const ideal = Number(idealById.get(slot.id) || 0);
            if (ideal > precisionEpsilon) {
                prioritizedTargets.push({
                    kind: 'create',
                    order: slot,
                    ideal
                });
            }
        }

        // Chain-truth budget (see deriveChainTruthFundBudget): `availableFund`
        // already had the virtual reservation subtracted, and that reservation
        // is the projection of THESE candidates — subtracting it from the
        // budget that funds them is circular. When the projection exceeds what
        // the chain holds free it reads 0 forever, so the holes can never be
        // filled and the projection can never shrink (live: `planned 3,
        // placing 0` for 84 minutes). Re-derive from chain truth, capped by
        // what the candidates need and by the real free balance.
        const candidateIdeals = prioritizedTargets.reduce((sum, t) => sum + Math.max(0, Number(t.ideal) || 0), 0);
        const chainFreeForSide = Math.max(0, Number(sideName === 'buy'
            ? manager.accountTotals?.buyFree
            : manager.accountTotals?.sellFree) || 0);
        const virtualIntentForSide = Math.max(0, Number(sideName === 'buy'
            ? manager.funds?.virtual?.buy
            : manager.funds?.virtual?.sell) || 0);
        const fundBudget = MathUtils.deriveChainTruthFundBudget({
            availableFund,
            virtualIntent: virtualIntentForSide,
            chainFree: chainFreeForSide,
            candidateIdeals,
        });
        if (fundBudget.eroded) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] ${sideName} projection exceeds chain free by ` +
                `${Format.formatAmount8(fundBudget.oversubscribed)}; funding the candidates from chain truth ` +
                `(${Format.formatAmount8(fundBudget.budget)} for ${Format.formatAmount8(candidateIdeals)} of ideal ` +
                `size) instead of placing nothing`,
                'warn'
            );
        }

        let remainingBudget = fundBudget.budget;

        // FUNDING PROBE (diagnostic): one line per correction cycle showing the
        // quantities that decide whether candidates can be funded. availableFund
        // is min(funds.available[side], accountTotals[side]Free); when the
        // virtual rail has already reserved the free balance this reads ~0 even
        // though the side still holds inventory. `spendable` is what the loop
        // actually spends (chain truth when the projection is oversubscribed),
        // so the two never have to be inferred from each other.
        manager.logger?.log?.(
            `[SPREAD-CORRECTION] Funding probe side=${sideName}: ` +
            `availableFund=${Format.formatAmount8(availableFund)} ` +
            `spendable=${Format.formatAmount8(fundBudget.budget)} ` +
            `budget=${Format.formatAmount8(Number(ctx.budget || 0))} ` +
            `virtual=${Format.formatAmount8(Number(sideName === 'buy' ? manager.funds?.virtual?.buy : manager.funds?.virtual?.sell) || 0)} ` +
            `free=${Format.formatAmount8(Number(sideName === 'buy' ? manager.accountTotals?.buyFree : manager.accountTotals?.sellFree) || 0)} ` +
            `virtualSell=${Format.formatAmount8(Number(manager.funds?.virtual?.sell || 0))} ` +
            `sellFree=${Format.formatAmount8(Number(manager.accountTotals?.sellFree || 0))} ` +
            `candidates=${prioritizedTargets.length} ` +
            `ideals=[${prioritizedTargets.map((t) => `${t.order.id}:${Format.formatAmount8(Number(t.ideal || 0))}`).join(', ')}]`,
            'debug'
        );

        // A truncated create (ideal >> residual) may fail isOrderHealthy's
        // dust/minimum check against its OWN ideal; that candidate is skipped
        // (continue) and the next one is tried with the SAME residual, so a
        // small budget can still fund a smaller candidate. When every candidate
        // is too truncated the residual is intentionally left UNSPENT rather
        // than force-placed as dust — the refresh above is what distinguishes
        // "genuinely no room" from "stale accounting read".
        for (const target of prioritizedTargets) {
            // FUNDING PROBE (per candidate): remainingBudget is read BEFORE this
            // target is applied, so a "placing 0" cycle can be attributed to the
            // residual gate rather than to isOrderHealthy/dust rejection.
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Funding probe ${target.kind} ${target.order.id}: ` +
                `ideal=${Format.formatAmount8(Number(target.ideal || 0))} ` +
                `remainingBudget=${Format.formatAmount8(remainingBudget)} ` +
                `availableFund=${Format.formatAmount8(availableFund)} ` +
                `budget=${Format.formatAmount8(Number(ctx.budget || 0))} ` +
                `virtualSell=${Format.formatAmount8(Number(manager.funds?.virtual?.sell || 0))} ` +
                `sellFree=${Format.formatAmount8(Number(manager.accountTotals?.sellFree || 0))}`,
                'debug'
            );
            if (remainingBudget <= precisionEpsilon) break;

            const createSize = Math.min(target.ideal, remainingBudget);
            if (createSize <= precisionEpsilon) continue;
            if (!isOrderHealthy(createSize, railType, manager.assets, target.ideal)) continue;

            ordersToPlace.push({
                ...target.order,
                type: railType,
                size: createSize,
                state: ORDER_STATES.VIRTUAL
            });
            remainingBudget -= createSize;
        }

        // FUND-CONSTRAINED PROMOTION: free funds could not fund every
        // tightening slot. A fully allocated rail (botFunds 100%, every slot
        // resting) has ~0 free forever, so create-only repair can never close
        // the spread (live 2026-10-30: "planned 4, placing 1"). Rotate a
        // resting same-side order into each unfunded promoted slot instead.
        // The move commits NO new funds (size is the source's booked size) and
        // is bounded by the same promotion/geometry guards as a create.
        const ordersToRotate: SpreadCorrectionRotation[] = [];
        {
            const fundedCreateIds = new Set<string>(ordersToPlace.map((o) => String(o.id)));
            // Use the POST-FILTER candidate list, not raw promotedCandidates:
            // spreadCandidates has already passed slot dedupe and the
            // placed-price collision filter (a promoted slot whose price is
            // already occupied from another slot must not become a rotation
            // destination). Re-derive the subset instead of bypassing those
            // guards.
            const promotedIds = new Set(promotedCandidates.map((c) => String(c.id)));
            const unfundedPromotions = spreadCandidates
                .filter((c) => promotedIds.has(String(c.id)))
                .filter((c) => !fundedCreateIds.has(String(c.id)))
                .filter((c) => isSlotAvailable(c));
            if (unfundedPromotions.length > 0) {
                const windowIds = liveWindowIdSet(manager, railType);
                const edgeIds = edgeOrderIdSet(
                    allSlotsByPrice,
                    manager.config,
                    railType,
                    resolveLiveEdgeAnchorPrice(manager, sideName),
                    windowIds
                );
                const sourcePool = allOrders
                    .filter((o) => o.type === railType
                        && o.state === ORDER_STATES.ACTIVE
                        && !!o.orderId
                        && Number(o.size) > 0
                        && o.price != null
                        && Number.isFinite(Number(o.price)))
                    .filter((o) => {
                        const idx = slotIndexMap.get(o.id);
                        if (idx === undefined) return false;
                        return railType === ORDER_TYPES.BUY ? idx <= buyEndIdx : idx >= sellStartIdx;
                    })
                    .filter((o) => !edgeIds || !edgeIds.has(String(o.id)))
                    .sort((a, b) => railType === ORDER_TYPES.BUY
                        ? Number(a.price) - Number(b.price)
                        : Number(b.price) - Number(a.price));
                const usedSourceIds = new Set<string>();
                for (const dest of unfundedPromotions) {
                    const source = sourcePool.find((s) => !usedSourceIds.has(String(s.id)));
                    if (!source) break;
                    const sourceSize = Number(source.size);
                    if (!Number.isFinite(sourceSize) || sourceSize <= 0) continue;
                    // Same booked size: a rotation is not a re-size and must
                    // never need new funds. If the source size is unhealthy at
                    // the destination (it is the same asset/side, so this is
                    // only a corrupt-size guard), skip rather than shrink.
                    if (!isOrderHealthy(sourceSize, railType, manager.assets, sourceSize)) continue;
                    const destPrice = Number(dest.price);
                    if (!Number.isFinite(destPrice) || destPrice <= 0) continue;
                    ordersToRotate.push({
                        id: String(source.id),
                        orderId: String(source.orderId),
                        oldOrder: source,
                        newGridId: String(dest.id),
                        newPrice: destPrice,
                        newSize: sourceSize,
                        type: railType
                    });
                    usedSourceIds.add(String(source.id));
                }
                if (ordersToRotate.length > 0) {
                    manager.logger?.log?.(
                        `[SPREAD-CORRECTION] Fund-constrained promotion on ${sideName}: rotating ` +
                        `${ordersToRotate.length} resting order(s) into the gap ` +
                        `(${ordersToRotate.map((r) => `${r.id}->${r.newGridId}`).join(', ')}) — ` +
                        `no new funds required`,
                        'warn'
                    );
                }
            }
        }

        if (ordersToPlace.length === 0 && ordersToRotate.length === 0) {
            // Candidates existed but neither free funds nor a rotation source
            // could act: a FUND/rail-structure stall, not a structural absence.
            return {
                ordersToPlace: [],
                ordersToUpdate: [],
                ordersToRotate: [],
                plannedCount: spreadCandidates.length,
                stallHint: 'unfunded',
                origin: COW_ORIGINS.SPREAD_CORRECTION
            };
        }

        let boundaryIdx: number | undefined;
        const placedPromotedIds = new Set([
            ...ordersToPlace
                .filter((order) => promotedCandidates.some((slot) => slot.id === order.id))
                .map((order) => order.id),
            ...ordersToRotate
                .map((rotation) => rotation.newGridId)
        ]);
        if (placedPromotedIds.size > 0) {
            // Derive boundary from the placed promoted set's extremes (via
            // slotIndexMap), not the contiguous prefix.  Any promoted-but-
            // unplaced slots sit in-rail or in-band as normal empty slots.
            let maxDist = 0;
            for (const id of placedPromotedIds) {
                const idx = slotIndexMap.get(id);
                if (idx === undefined) continue;
                const dist = railType === ORDER_TYPES.BUY
                    ? idx - buyEndIdx
                    : sellStartIdx - idx;
                if (dist > maxDist) maxDist = dist;
            }
            if (maxDist > 0) {
                boundaryIdx = railType === ORDER_TYPES.BUY
                    ? buyEndIdx + maxDist
                    : buyEndIdx - maxDist;
                // PROMOTION BOUNDARY BACKSTOP (refusal-only): the boundary is
                // DERIVED from the placed promoted set (buyEndIdx ± maxDist),
                // so shifting it here would silently strand those fresh orders
                // inside the implied band.  All real constraints — the
                // MIN_SPREAD_ORDERS reserve and opposite-rail stranding — are
                // enforced UPSTREAM as walk-depth caps.  This backstop only
                // verifies array limits plus the edge ceiling; any
                // violation signals an internal inconsistency, so promotion is
                // refused loudly instead of silently re-geometried.
                const maxIdx = allSlotsByPrice.length - 1;
                const lo = 0;
                const hi = railType === ORDER_TYPES.BUY
                    ? Math.min(maxIdx, sellStartIdx - 1 - spreadReserve)
                    : maxIdx;
                if (lo > hi || boundaryIdx < lo || boundaryIdx > hi) {
                    manager.logger?.log?.(
                        `[SPREAD-CORRECTION] Boundary promotion refused on ${sideName}: ` +
                        `derived boundary ${boundaryIdx} violates safe range [${lo}, ${hi}] ` +
                        `(band ${buyEndIdx + 1}..${sellStartIdx - 1})`,
                        'warn'
                    );
                    boundaryIdx = undefined;
                } else {
                    manager.logger?.log?.(
                        `[SPREAD-CORRECTION] Boundary promotion on ${sideName}: ` +
                        `${buyEndIdx} -> ${boundaryIdx} (${placedPromotedIds.size} placed, maxDist ${maxDist})`,
                        'info'
                    );
                }
            } else {
                boundaryIdx = undefined;
            }
        }

        if (spreadCandidates.length < missingSlots) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Requested ${missingSlots} extra slot(s), found ${spreadCandidates.length} available slot(s) on ${sideName}`,
                'warn'
            );
        }

        if (ordersToPlace.length + ordersToRotate.length < spreadCandidates.length) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Fund-constrained placement on ${sideName}: planned ${spreadCandidates.length}, ` +
                `placing ${ordersToPlace.length} create(s) + ${ordersToRotate.length} rotation(s)`,
                'info'
            );
        }

        if (ordersToPlace.length > 0 || ordersToRotate.length > 0) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Prepared creates=${ordersToPlace.length}, rotations=${ordersToRotate.length}, ` +
                `remainingBudget=${Format.formatSizeByOrderType(Math.max(0, remainingBudget), railType, manager.assets)}`,
                'debug'
            );
        }

        return {
            ordersToPlace,
            ordersToUpdate: [],
            ordersToRotate,
            // Number of tightening candidates found before funding/rotation.
            // Include rotation targets: a rotation-only plan has a non-zero
            // planned count and must not look like an empty plan to callers
            // that distinguish 'unfunded' from 'no-candidates'.
            plannedCount: spreadCandidates.length,
            ...(boundaryIdx === undefined ? {} : { boundaryIdx }),
            origin: COW_ORIGINS.SPREAD_CORRECTION
        };
    }

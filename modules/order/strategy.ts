/**
 * modules/order/strategy.ts - StrategyEngine
 *
 * Grid rebalancing and order placement strategy.
 * Exports a single StrategyEngine class implementing boundary-crawl pivot strategy.
 *
 * Strategy Approach:
 * - Simple & Robust Pivot Strategy (Boundary-Crawl Version)
 * - Maintains contiguous physical rails using a master boundary anchor
 * - Boundary fixed at market start price determines BUY/SELL/SPREAD zones
 * - Dynamically rebalances orders as grid prices change
 * - Handles partial fills and order consolidation
 *
 * ===============================================================================
 * TABLE OF CONTENTS - StrategyEngine Class
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor(manager) - Create new StrategyEngine with manager reference
 *
 * REBALANCING (1 method)
 *   2. calculateTargetGrid(params) - UNIFIED PURE TARGET CALCULATION
 *      Calculates the "Ideal State" based on current fills and market conditions.
 *      Returns: { targetGrid: Map, boundaryIdx: number }
 *      No side effects.
 *
 * ORDER PROCESSING (1 method)
 *   3. processFillsOnly(filledOrders, excludeOrderIds) - Process filled orders (async)
 *      Handles order fill events, fee accounting, and grid updates
 *      Consolidates partial fills, updates fund state. Does NOT trigger rebalancing.
 *      Fill deduplication (replay safety, fee-event) is handled upstream by
 *      the manager's processedFillTracker — this class is stateless w.r.t. dedup.
 *
 * ===============================================================================
 *
 * BOUNDARY-CRAWL ALGORITHM:
 * 1. Find reference price (from fills or market)
 * 2. Calculate gap slots for spread zone
 * 3. Determine split index (boundary location in sorted price array)
 * 4. Assign roles:
 *    - BUY slots: below boundary (price < reference)
 *    - SPREAD slots: within gap
 *    - SELL slots: above boundary (price >= reference)
 * 5. Calculate order sizes based on budgeting
 * 6. Handle fills and consolidate partials
 *
 * ===============================================================================
 */


import { ORDER_TYPES, ORDER_STATES } from '../constants.js';
import { calculateGapSlots } from './grid.js';
import { isSlotInRail } from './utils/math.js';
import { deriveTargetBoundary, getSideBudget, calculateBudgetedSizes, getCoreOrdersTotal, resolveEdgeCount, resolveLiveEdgeAnchorPrice, selectEdgeSlots, isShiftEligibleFill } from './utils/order.js';
import { reanchorBoundaryFromLastFill } from './utils/system.js';
import { assignGridRoles } from './utils/order.js';
import {
    convertToSpreadPlaceholder,
    toRailHolePlaceholder,
    geometryTypeForSlotIndex,
    hasOnChainId,
    isOrderPlaced
} from "./utils/order.js";
import { parseSlotIndex } from "./utils/slot.js";
import type { OrderManagerLike, ManagedOrder, GridConfig, AssetPair, ProjectedFunds } from "../types.js";

interface FillInput {
    id?: string;
    type?: string;
    price?: number;
    size?: number;
    isPartial?: boolean;
    isDelayedRotationTrigger?: boolean;
    orderId?: string | null;
    [key: string]: unknown;
}

class StrategyEngine {
    manager: OrderManagerLike;

    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager: OrderManagerLike) {
        this.manager = manager;
    }



    /**
     * Process filled orders: handle fills and consolidate partials.
     * Does NOT trigger rebalancing (now decoupled from rebalance logic).
     * 
     * This method handles the accounting side of fills without modifying
     * the grid structure. OrderManager invokes it before running COW rebalance.
     *
     * OPERATIONS PERFORMED:
     * 1. Validates and filters filled orders
     * 2. Virtualizes fully-filled slots (converts ACTIVE/PARTIAL to VIRTUAL)
     * 3. Calculates and deducts BTS fees (if BTS pair)
     * 4. Triggers fund recalculation
     *
     * FEE CALCULATION:
     * - For BTS trading pairs, calculates fees based on maker/taker status
     * - Maker fills: Lower fee rate
     * - Taker fills: Higher fee rate
     * - Fees are accumulated and deducted from available funds
     *
     * @param {Array<Object>} filledOrders - Array of filled order objects from blockchain
     *   - id {string}: Order slot ID
     *   - orderId {string}: Blockchain order ID
     *   - type {string}: 'BUY' or 'SELL'
     *   - price {number}: Order price
     *   - size {number}: Filled size
     *   - isPartial {boolean}: Whether this is a partial fill
     *   - isMaker {boolean}: Whether fill was maker (true) or taker (false)
     *   - isDelayedRotationTrigger {boolean}: Whether this triggers delayed rotation
     * @param {Set<string>} [excludeOrderIds=new Set()] - Order IDs to skip
     * @returns {Promise<boolean>} True if processing completed successfully
     * @async
     */
    async processFillsOnly(filledOrders: FillInput[], excludeOrderIds: Set<string> = new Set()) {
        const mgr = this.manager;
        if (!Array.isArray(filledOrders) || filledOrders.length === 0) return true;

        mgr.logger.log(`[STRATEGY] Processing batch of ${filledOrders.length} filled orders...`, 'info');

        for (const filledOrder of filledOrders) {
            if (filledOrder.id != null && excludeOrderIds?.has?.(filledOrder.id)) {
                mgr.logger.log(`[STRATEGY] Skipping excluded fill for order ${filledOrder.id}`, 'debug');
                continue;
            }

            const isPartial = filledOrder.isPartial === true;
            mgr.logger.log(`[STRATEGY] Processing fill: id=${filledOrder.id}, type=${filledOrder.type}, price=${filledOrder.price}, size=${filledOrder.size}, partial=${isPartial}`, 'debug');
            // Pending-crawl record: this fill's crawl is owed to the boundary
            // only once a derivation commits it. If the batch aborts, the
            // broadcast is refused, or the process restarts first, the entry
            // survives (persisted with the snapshot) so the crawl is applied
            // by a later derivation or at startup — instead of being lost and
            // letting reconcile refill the hole same-side (Sep-10: 4 consumed
            // buys re-bought after restart). Cleared on any accepted
            // non-null boundary commit. Same eligibility as the crawl itself.
            if (isShiftEligibleFill(filledOrder)
                && typeof filledOrder.id === 'string' && filledOrder.id.length > 0
                && (filledOrder.type === ORDER_TYPES.BUY || filledOrder.type === ORDER_TYPES.SELL)
                // dryRun never commits a boundary, so a recorded crawl could
                // never be consumed — it would only accumulate and persist
                // forever. Fills are not processed under dryRun today, but
                // guard the ledger at its single writer so a future dryRun
                // simulation cannot grow it unbounded.
                && mgr.config?.dryRun !== true) {
                const pending = mgr._pendingFillCrawls;
                if (Array.isArray(pending)) {
                    // Slot-level dedupe: a slot with no live order cannot
                    // refill (and therefore re-fill) while its hole persists,
                    // so a second entry for the same slotId can only be a
                    // reprocessed duplicate, never a second owed crawl.
                    // Replace (keep newest) instead of stacking.
                    const at = pending.findIndex((e) => e && e.slotId === filledOrder.id);
                    if (at >= 0) pending.splice(at, 1);
                    pending.push({ slotId: filledOrder.id, side: filledOrder.type, ts: Date.now() });
                    // Hard cap AFTER push so the in-memory length matches the
                    // persisted cap (account_orders stores slice(-500)).
                    while (pending.length > 500) pending.shift();
                    if (typeof mgr._markGridDirty === 'function') mgr._markGridDirty();
                }
            }

            if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                const currentSlot = filledOrder.id != null ? mgr.orders.get(filledOrder.id) : undefined;
                const slotReused = currentSlot && hasOnChainId(currentSlot) && filledOrder.orderId && currentSlot.orderId !== filledOrder.orderId;

                if (currentSlot && !slotReused && isOrderPlaced(currentSlot) && currentSlot.size > 0) {
                    mgr.logger.log(`[STRATEGY] Virtualizing filled slot ${filledOrder.id}`, 'debug');
                    // Rail-aware hole (Phase 2): a consumed RAIL slot (e.g. a
                    // filled sell) stays SELL/BUY VIRTUAL so evacuation
                    // geometry survives the fill cycle; only true gap-band
                    // slots become side-neutral SPREAD. Geometry by slot id,
                    // never the stored type.
                    let filledHole: ManagedOrder | null = null;
                    try {
                        const filledGeoType = geometryTypeForSlotIndex(
                            parseSlotIndex(currentSlot?.id),
                            mgr.boundaryIdx,
                            mgr._gapSlots
                        );
                        filledHole = (filledGeoType === ORDER_TYPES.BUY || filledGeoType === ORDER_TYPES.SELL)
                            ? toRailHolePlaceholder(currentSlot, filledGeoType, 0)
                            : convertToSpreadPlaceholder(currentSlot);
                    } catch {
                        filledHole = convertToSpreadPlaceholder(currentSlot);
                    }
                    const ok = await mgr._updateOrder(
                        filledHole,
                        'fill',
                        { skipAccounting: false, fee: 0 }
                    );
                    if (ok === false) {
                        mgr.logger.log(`[STRATEGY] Failed to virtualize filled slot ${filledOrder.id}; marking totals stale for next sync cycle`, 'warn');
                        mgr.accountTotalsStale = true;
                    }
                }
            }
        }

        // BTS operation fees are settled at operation time (create/update/cancel).
        // Fill proceeds already include maker refund projection via accounting, so
        // do not accrue/deduct additional fill-time BTS fees here.

        await mgr.recalculateFunds();
        return true;
    }

    /**
     * UNIFIED TARGET CALCULATION
     * Calculates the "Ideal State" grid based on current fills and market conditions.
     * 
     * This is NOT a pure function. Besides computing what the grid SHOULD look
     * like after rebalancing, it reads and mutates manager boundary budget
     * state: it consumes manager._gapSlots / manager._boundaryShiftBudget and
     * writes the remaining cross-chunk shift budget back to
     * manager._boundaryShiftBudget (boundary-crawl bookkeeping).
     *
     * ALGORITHM:
     * 1. Derive new boundary index based on fills (boundary crawl)
     * 2. Assign grid roles (BUY/SELL/SPREAD) based on boundary position
     * 3. Calculate budget allocation for each side
     * 4. Apply window discipline (coreOrders count limits)
     * 5. Calculate ideal order sizes based on budgets and weights
     * 6. Build target grid map representing desired state
     *
     * BOUNDARY CRAWL:
     * - BUY fills shift boundary LEFT (market moved down)
     * - SELL fills shift boundary RIGHT (market moved up)
     * - Spread gap is maintained between buy and sell zones
     *
     * WINDOW DISCIPLINE:
     * - Only targetCountBuy buy orders kept (closest to boundary)
     * - Only targetCountSell sell orders kept (closest to boundary)
     * - Excess orders are virtualized (size = 0)
     *
     * @param {Object} params - Calculation parameters
     * @param {Map} params.frozenMasterGrid - Immutable copy of current grid orders
     * @param {Object} params.config - Bot configuration
     *   - targetSpreadPercent {number}: Width of spread zone
     *   - incrementPercent {number}: Price step between orders
     *   - coreOrders {Object}: Target active order counts
     *   - weightDistribution {Object}: Size weighting for each side
     * @param {Object} params.accountAssets - Asset metadata (precision, IDs)
     * @param {Object} params.funds - Current fund state
     *   - available {Object}: Available funds per side
     *   - committed {Object}: Committed funds per side
     * @param {Array<Object>} params.fills - Recent fills that triggered calculation
     * @param {number} params.currentBoundaryIdx - Current boundary index
     * @returns {Object} Target grid state:
     *   - targetGrid {Map}: Map of slotId -> target order state
     *     - id {string}: Slot ID
     *     - price {number}: Order price
     *     - type {string}: 'BUY', 'SELL', or 'SPREAD'
     *     - size {number}: Target size (0 for virtualized orders)
     *     - state {string}: 'ACTIVE' or 'VIRTUAL'
     *   - boundaryIdx {number}: New boundary index
     */
    calculateTargetGrid(params: {
        frozenMasterGrid: Map<string, ManagedOrder>;
        config: GridConfig;
        accountAssets: AssetPair | null;
        funds: ProjectedFunds | null;
        fills: FillInput[];
        currentBoundaryIdx: number | null;
    }) {
        // Core params needed for calculation
        const { 
            frozenMasterGrid, 
            config, 
            accountAssets, 
            funds, 
            fills,
            currentBoundaryIdx 
        } = params;


        // Clone grid for local simulation (Target Grid)
        // We work with "slots" which are the potential order locations
        const allSlots = Array.from(frozenMasterGrid.values())
            .filter((o) => o.price != null)
            .sort((a, b) => a.price - b.price)
            .map((o) => ({ ...o })); // Shallow clone for simulation

        if (allSlots.length === 0) return { targetGrid: new Map(), boundaryIdx: currentBoundaryIdx };

        // 1. Determine new boundary based on fills (Boundary Crawl)
        // Use the stored gapSlots from grid creation (always consistent with
        // the grid geometry) instead of recomputing from live config which may
        // have drifted if targetSpreadPercent or gridLimits changed.
        const gapSlots = this.manager._genesis?.gapSlots ?? this.manager._gapSlots ?? calculateGapSlots(config.incrementPercent, config.targetSpreadPercent, config.gridLimits);
        const crossChunkBudget = this.manager._boundaryShiftBudget as number | null | undefined;
        // Anchor recovery on the frozen genesis center when config.startPrice
        // is an unresolved "pool"/"book" mode string: a fill carries direction
        // but not position, and an unanchored recovery fabricates a rail-edge
        // boundary (the slot-77→slot-192 teleport). The numeric config center
        // still wins when present.
        const genesisStart = Number(this.manager._genesis?.startPrice);
        const boundaryConfig = (!Number.isFinite(Number(config?.startPrice)) && Number.isFinite(genesisStart))
            ? { ...config, genesisStartPrice: genesisStart }
            : config;
        // Live edge order anchors (single source): the ladder extremes of the
        // grid actually being traded. Resolved once and shared by the edge
        // selection below and the no-crawl classification inside
        // deriveTargetBoundary, so placement and fill classification can never
        // disagree about which slots are edge orders.
        const edgeAnchors = {
            buy: resolveLiveEdgeAnchorPrice(this.manager, 'buy'),
            sell: resolveLiveEdgeAnchorPrice(this.manager, 'sell'),
        };
        let { boundaryIdx: newBoundaryIdx, remainingBudget, consumedCrawlIds } = deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, boundaryConfig, gapSlots, crossChunkBudget, this.manager._pendingFillCrawls, edgeAnchors);
        if (crossChunkBudget != null) {
            this.manager._boundaryShiftBudget = remainingBudget;
        }
        // GEOMETRY RE-ANCHOR: the crawl is +-1 slot per committed fill, so a
        // window that ended up BEHIND the newest real fill can never catch up —
        // every tightening slot on that side is then at/through the fill and the
        // last-fill guard refuses all of them while the funds sit in the resting
        // inventory. The fill is the anchor: place it outside its own window.
        // Validated like a boundary commit (strands no live in-band order), and
        // only for an on-ladder fill price.
        const reanchor = reanchorBoundaryFromLastFill(this.manager, newBoundaryIdx, allSlots, gapSlots, fills);
        if (reanchor.reanchored) {
            newBoundaryIdx = reanchor.boundaryIdx;
            // An absolute fill anchor already reflects every older owed crawl.
            // The derivation may have left records owed (cap exhausted, mixed
            // remainder), so consuming only its subset would let a later
            // derivation apply those deltas ON TOP of the re-anchored boundary
            // and overshoot. Snapshot at PLAN time (not commit time): a fill
            // recorded after this plan must stay owed and crawl next cycle.
            const pendingAtPlan = Array.isArray(this.manager._pendingFillCrawls)
                ? this.manager._pendingFillCrawls
                : [];
            consumedCrawlIds = pendingAtPlan
                .filter((e) => e && typeof e.slotId === 'string' && e.slotId.length > 0)
                .map((e) => {
                    const ts = Number(e.ts);
                    return {
                        slotId: e.slotId,
                        side: String(e.side ?? ''),
                        ...(Number.isFinite(ts) ? { ts } : {})
                    };
                });
            try { this.manager._markGridDirty?.(); } catch { /* best-effort */ }
        }
        // Unanchorable (null boundary, no numeric center anywhere): refuse to
        // plan rotations on fabricated geometry. The COW engine routes this
        // to a structural resync instead.
        if (newBoundaryIdx === null || newBoundaryIdx === undefined) {
            this.manager.logger.log('[COW] calculateTargetGrid: boundary unrecoverable (no numeric center); skipping rotation plan', 'warn');
            return { targetGrid: new Map(), boundaryIdx: null };
        }

        // P2 observability: a market/fill-derived boundary that jumps more than
        // the active window in ONE plan is the "boundary detached from the
        // market anchor" signal (the ANCHOR-DIVERGENCE condition, which lost its
        // telemetry when the price projection was removed). A normal crawl is
        // budget-bounded to at most half the active window, so this can only fire
        // on an absolute recovery anchor or a geometry fault. Counted and
        // rate-limited; never gates the plan.
        try {
            const activeWindow = Math.max(
                1,
                Number(config?.coreOrders?.buy) || 1,
                Number(config?.coreOrders?.sell) || 1
            );
            // Null boundary is DELIBERATELY compared against numeric 0 here:
            // the derived boundary is an absolute recovery anchor, and its
            // distance from 0 is exactly the ANCHOR-DIVERGENCE signal this
            // observability counter exists to surface (see P2 test).
            const driftSlots = Math.abs(Number(newBoundaryIdx) - Number(currentBoundaryIdx));
            if (Number.isFinite(driftSlots) && driftSlots > activeWindow) {
                const metrics = this.manager._metrics;
                if (metrics) {
                    metrics.boundaryDriftExceedsWindowCount = (metrics.boundaryDriftExceedsWindowCount || 0) + 1;
                }
                const now = Date.now();
                const lastWarn = Number(this.manager._lastBoundaryDriftWarnAt) || 0;
                if (now - lastWarn >= 5 * 60 * 1000) {
                    this.manager._lastBoundaryDriftWarnAt = now;
                    this.manager.logger.log(
                        `[BOUNDARY-DRIFT] committed boundary ${currentBoundaryIdx} -> planned ${newBoundaryIdx} ` +
                        `(drift ${driftSlots} slots) exceeds active window ${activeWindow}; ` +
                        `boundary is detached from the market anchor (observability only)`,
                        'warn'
                    );
                }
            }
        } catch { /* observability only */ }

        // 2. Assign Roles (Buy/Sell/Spread)
        const updatedSlots = assignGridRoles(allSlots, newBoundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });

        this.manager.logger.log(`[DEBUG] calculateTargetGrid: boundary=${newBoundaryIdx}, gap=${gapSlots}, allSlots=${updatedSlots.length}`, 'debug');
        updatedSlots.forEach((s) => this.manager.logger.log(`  Slot ${s.id}: price=${s.price}, size=${s.size ?? 'n/a'}, type=${s.type}`, 'debug'));

        // 3. Calculate Ideal Sizes (Budgeting)
        const totalTarget = getCoreOrdersTotal(config);
        const budgetBuy = getSideBudget('buy', funds, config, totalTarget);
        const budgetSell = getSideBudget('sell', funds, config, totalTarget);
        
        // Filter slots into BUY/SELL
        const allBuySlots = updatedSlots.filter((o) => o.type === ORDER_TYPES.BUY);
        const allSellSlots = updatedSlots.filter((o) => o.type === ORDER_TYPES.SELL);

        // Apply Window Discipline (coreOrders count)
        const targetCountBuy = Math.max(1, (config.coreOrders?.buy ?? 1));
        const targetCountSell = Math.max(1, (config.coreOrders?.sell ?? 1));

        // The SPREAD GUARD (assignGridRoles) keeps a live on-chain order typed
        // BUY/SELL even when a boundary crawl moves its slot into the spread
        // band (to avoid the illegal SPREAD+ACTIVE state). Such a stray slot
        // must NOT be counted in the active window: otherwise the window keeps
        // the rail parked in its old position and an on-chain sell gets left
        // inside the gap (spread removed). Exclude stray slots by geometry
        // (shared MathUtils.isSlotInRail helper) so reconcile treats them as
        // surplus and relocates them back onto the rail.
        const inBuyRail = (o: ManagedOrder) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.BUY, o);
        const inSellRail = (o: ManagedOrder) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.SELL, o);

        // Sort Closest-First for windowing, then collapse duplicate price levels
        // before slicing so the active window keeps as many unique-priced
        // slots as the target count allows. Self-contained robustness guard
        // (no anchor/band dependency) — restores production incident fix for
        // duplicate levels after rotation re-typing (e.g. 902.08089 x2).
        const buyCandidates = allBuySlots
            .filter(inBuyRail)
            .sort((a, b) => b.price - a.price);
        const sellCandidates = allSellSlots
            .filter(inSellRail)
            .sort((a, b) => a.price - b.price);

        const snapRail = (slots: ManagedOrder[], dir: number) => {
            const kept: ManagedOrder[] = [];
            for (const s of slots) {
                if (!kept.some((k) => k.id === s.id)) kept.push(s);
                else if (!isOrderPlaced(kept.find((k) => k.id === s.id)) && isOrderPlaced(s)) {
                    const idx = kept.findIndex((k) => k.id === s.id);
                    kept[idx] = s;
                }
            }
            kept.sort((a, b) => dir > 0 ? Number(a.price) - Number(b.price) : Number(b.price) - Number(a.price));
            return kept;
        };

        const buySlots = snapRail(buyCandidates, -1).slice(0, targetCountBuy);
        const sellSlots = snapRail(sellCandidates, +1).slice(0, targetCountSell);
        
        // IMPORTANT:
        // Size distribution must be computed on the FULL side topology, not only
        // the active window. Otherwise budgets get concentrated into targetCount
        // slots (e.g., 3), producing absurd per-order sizes.
        const allBuySortedForSizing = [...allBuySlots].sort((a, b) => a.price - b.price);
        const allSellSortedForSizing = [...allSellSlots].sort((a, b) => a.price - b.price);

        const fullBuySizes = calculateBudgetedSizes(
            allBuySortedForSizing,
            'buy',
            budgetBuy,
            config.weightDistribution?.buy,
            config.incrementPercent,
            accountAssets
        );
        const fullSellSizes = calculateBudgetedSizes(
            allSellSortedForSizing,
            'sell',
            budgetSell,
            config.weightDistribution?.sell,
            config.incrementPercent,
            accountAssets
        );

        const buySizeById = new Map(allBuySortedForSizing.map((slot, i) => [slot.id, fullBuySizes[i] || 0]));
        const sellSizeById = new Map(allSellSortedForSizing.map((slot, i) => [slot.id, fullSellSizes[i] || 0]));

        // Edge ladder: edge-pinned insurance orders stay live alongside the
        // window. Buys pin at the floor (lowest prices), sells at the ceiling
        // (highest prices). Discontiguous by design — the middle stays VIRTUAL.
        // Sizes come from the same full-rail curves; edge fills never crawl
        // (filtered in deriveTargetBoundary).
        // Both edges anchor at the live grid's own edge (edgeAnchors),
        // which is the same pair deriveTargetBoundary classified against.
        const edgeBuySlots = selectEdgeSlots(
            allBuySortedForSizing.filter((s) => inBuyRail(s)),
            resolveEdgeCount(config, 'buy'),
            new Set(buySlots.map((s) => s.id)),
            'floor',
            edgeAnchors.buy
        );
        const edgeSellSlots = selectEdgeSlots(
            allSellSortedForSizing.filter((s) => inSellRail(s)),
            resolveEdgeCount(config, 'sell'),
            new Set(sellSlots.map((s) => s.id)),
            'ceiling',
            edgeAnchors.sell
        );
        const buySlotsAll = [...buySlots, ...edgeBuySlots];
        const sellSlotsAll = [...sellSlots, ...edgeSellSlots];

        const buySizes = buySlotsAll.map((slot) => buySizeById.get(slot.id) || 0);
        const sellSizes = sellSlotsAll.map((slot) => sellSizeById.get(slot.id) || 0);

        // Apply sizes to target grid map
        const targetGrid = new Map<string, ManagedOrder>();
        
        const applySizes = (slots: ManagedOrder[], sizes: number[]) => {
            slots.forEach((slot, i) => {
                const size = sizes[i] || 0;
                targetGrid.set(slot.id, {
                    id: slot.id,
                    price: slot.price,
                    type: slot.type,
                    size: size,
                    idealSize: size,
                    state: size > 0 ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    committedSide: (slot.type === ORDER_TYPES.BUY || slot.type === ORDER_TYPES.SELL)
                        ? slot.type
                        : slot.committedSide
                } as ManagedOrder);
            });
        };

        applySizes(buySlotsAll, buySizes);
        applySizes(sellSlotsAll, sellSizes);
        
        // Handle slots outside the window: preserve their calculated sizes
        // Window Discipline only controls WHICH orders are placed on-chain,
        // not the grid's fund allocation. Virtual orders must retain their
        // sizes so that funds.virtual reflects the full grid commitment.
        const windowIds = new Set([...buySlotsAll, ...sellSlotsAll].map((s) => s.id));
        updatedSlots.forEach((slot) => {
            if (!windowIds.has(slot.id)) {
                // Use calculated size from full-rail sizing (preserves fund allocation)
                const calculatedSize = buySizeById.get(slot.id) ?? sellSizeById.get(slot.id) ?? slot.size ?? 0;
                targetGrid.set(slot.id, {
                    id: slot.id,
                    price: slot.price,
                    type: slot.type,
                    size: calculatedSize,
                    idealSize: calculatedSize,
                    state: ORDER_STATES.VIRTUAL,
                    committedSide: (slot.type === ORDER_TYPES.BUY || slot.type === ORDER_TYPES.SELL)
                        ? slot.type
                        : slot.committedSide
                } as ManagedOrder);
            }
        });

        return { 
            targetGrid: targetGrid,
            boundaryIdx: newBoundaryIdx,
            // Records whose shift this derivation actually folded. The commit
            // clears ONLY these, so a record it could not apply (truncated
            // shift, edge classification, a newer record for the same slot)
            // stays owed instead of vanishing with the commit.
            consumedCrawlIds
        }; 
    }

}

export default StrategyEngine

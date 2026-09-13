/**
 * modules/order/manager.ts - OrderManager Engine
 *
 * Core grid-based order management system for DEXBot2.
 * Uses utils/validate.ts, strategy.ts, and utils/order.ts for validation and rebalance logic.
 *
 * ===============================================================================
 * TABLE OF CONTENTS
 * ===============================================================================
 *
 * SECTION 1: EXTERNAL DEPENDENCIES
 * SECTION 2: COW REBALANCE ENGINE
 * SECTION 3: ORDER MANAGER CLASS
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: EXTERNAL DEPENDENCIES
// ===============================================================================


import { persistGridSnapshot, deepFreeze, cloneMap, withBlockchainRetry } from './utils/system.js';
import { withTimeout } from './utils/timeout.js';
import { WorkingGrid } from './working_grid.js';
import Logger from './logger.js';
import AsyncLock from './async_lock.js';
import Accountant from './accounting.js';
import StrategyEngine from './strategy.js';
import SyncEngine from './sync_engine.js';
import { calculateCurrentSpread, checkSpreadCondition, checkGridHealth } from './grid.js';
import * as Format from './format.js';
import {
    ORDER_TYPES,
    ORDER_STATES,
    REBALANCE_STATES,
    DEFAULT_CONFIG,
    TIMING,
    LOG_LEVEL,
    PIPELINE_TIMING,
    COW_PERFORMANCE,
    COW_ACTIONS,
    GRID_LIMITS
} from '../constants.js';
import {
    getMinOrderSize,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValueWithRegistry,
    isExplicitZeroAllocation,
    floatToBlockchainInt,
    validateBoundaryCommit,
    resolveGapSlots,
    resolveGapBand,
    isSlotInRail
} from './utils/math.js';
import {
    validateOrder,
    validateGridForPersistence,
    validateWorkingGridFunds,
    checkFundDrift,
    reconcileGrid,
    optimizeRebalanceActions,
    projectTargetToWorkingGrid,
    buildStateUpdates,
    buildAbortedResult,
    buildSuccessResult,
    evaluateCommit
} from './utils/validate.js';
import { resolveSpreadOrderSide, parseSlotIndex, parseChainOrder, geometryTypeForSlotIndex, isOrderOnChain, resolveReserveCount, resolveLiveReserveEdgeAnchorPrice, compareReserveEdge, collectRefillSlotIds } from './utils/order.js';
import { getErrorMessage } from '../utils/errors.js';
const { toFiniteNumber } = Format;

// ===============================================================================
// SECTION 2: COW REBALANCE ENGINE
// ===============================================================================

/**
 * Stale-placement veto: whether a placement action crosses the plan's own
 * boundary and would fill immediately on stale market data.
 * - BUY create/update targeting a slot ABOVE the boundary is dropped; SELL
 *   create/update targeting a slot BELOW the boundary is dropped. Strict
 *   comparison: a placement AT the boundary is kept (the boundary slot is
 *   the spread, which reconcile never targets).
 * - The reference is the PLAN'S OWN targetBoundary — and ONLY that: the
 *   plan's slots derive from the same target grid, so a stale plan's
 *   placements cross its own boundary while legitimate re-placements never
 *   do (the boundary is capped, the fills are not). Fill-based veto lines
 *   are deliberately NOT used — after a burst the fills sit beyond the
 *   plan's legitimate re-place levels (e.g. SELL fills 5,6,7 with cap=1
 *   moves the boundary only to slot 6), so ANY fill comparison can veto
 *   valid placements, including the strategy's own rotations (a partial
 *   SELL rotated into a slot below the last BUY fill after the boundary
 *   crawled left). The guard is therefore "inert" for boundary-consistent
 *   engine output by construction.
 * - Slot ids are compared within the plan's own grid generation
 *   (targetBoundary and target slots are both from the current plan), so a
 *   recenter between the fill capture and the plan cannot skew the
 *   comparison. Both CREATE and UPDATE actions are guarded: the
 *   cancel/create optimization can convert the same logical placement into
 *   an UPDATE op (target slot = newGridId), which the CREATE-only check
 *   would have missed.
 * - When no plan boundary is available (hand-built plans), nothing is
 *   vetoed — fill evidence is not a reliable veto line. Non-placement
 *   actions and non-grid-slot targets are never vetoed.
 * @param {Object} action - COW action
 * @param {number} planBoundary - The plan's target boundary slot index
 * @returns {string|null} Drop reason for the log, or null to keep the action
 */
function stalePlacementDropReason(action: any, planBoundary: number): string | null {
    const isPlacement = action?.type === COW_ACTIONS.CREATE || action?.type === COW_ACTIONS.UPDATE;
    if (!isPlacement) return null;
    const targetSlot = parseSlotIndex(action?.newGridId ?? action?.id);
    if (targetSlot === null) return null;
    const kindWord = action.type === COW_ACTIONS.UPDATE ? 'update' : 'create';
    if (action?.order?.type === ORDER_TYPES.BUY && targetSlot > planBoundary) {
        return `BUY ${kindWord} for slot ${action.id}: slot ${targetSlot} > plan boundary ${planBoundary}`;
    }
    if (action?.order?.type === ORDER_TYPES.SELL && targetSlot < planBoundary) {
        return `SELL ${kindWord} for slot ${action.id}: slot ${targetSlot} < plan boundary ${planBoundary}`;
    }
    return null;
}
//
// COPY-ON-WRITE (COW) PATTERN FOR SAFE REBALANCING
//
// Problem Solved:
// Traditional approach: Modify orders in-place while calculating new grid
// Issue: If fills arrive DURING rebalance, they corrupt the working state
//
// Solution: Copy-on-Write pattern isolates rebalancing from incoming fills
//
// WORKFLOW:
// 1. Clone master grid → WorkingGrid (immutable during rebalance)
// 2. Calculate target state from strategy engine
// 3. Reconcile master vs target → generate COW_ACTIONS (CREATE/UPDATE/CANCEL/ROTATE)
// 4. Project target to working grid (working becomes target)
// 5. Validate funds and check for staleness (abort if fills arrived)
// 6. Build blockchain operations from delta
// 7. Atomic commit to master on broadcast success (or discard on failure)
//
// KEY INVARIANTS:
// 1. Master grid NEVER modified during planning (immutable during rebalance)
// 2. Fills that arrive during rebalance are QUEUED, not lost
// 3. Working grid is DISPOSABLE - if rebalance fails, discard it
// 4. Only ONE rebalance plan active at a time (_rebalanceState)
// 5. Staleness detection aborts if master changes (fills, manual commands)
//
// FILL HANDLING DURING REBALANCE:
// - SyncEngine.syncFromFillHistory() is called immediately on fill arrival
// - Updates to master grid only (not working grid)
// - Sets workingGrid.markStale() to signal version mismatch
// - Rebalance detects staleness → aborts → retries on next cycle
// - Fills are NEVER lost, just deferred until next rebalance cycle
//
// PERFORMANCE OPTIMIZATION:
// - COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER estimated memory per order
// - Modified Set only tracks changed order IDs (delta compression)
// - Lazy index calculation (prices, types, states) only on demand
// - Delta building is O(n) where n = modified orders count
//
// ===============================================================================

class COWRebalanceEngine {
    strategy: any;
    logger: any;
    assets: any;
    config: any;

    constructor(deps: any) {
        this.strategy = deps.strategy;
        this.logger = deps.logger;
        this.assets = deps.assets;
        this.config = deps.config;
    }

    async execute({
        masterGrid,
        gridVersion,
        boundaryIdx,
        funds,
        fills = [],
        excludeIds = new Set(),
        gapSlots = null,
        evacStreaks = null,
        reserveEdgeAnchors = null
    }: any) {
        const startTime = Date.now();

        const workingGrid = new WorkingGrid(masterGrid, { baseVersion: gridVersion });

        const strategyParams = {
            frozenMasterGrid: masterGrid,
            config: this.config,
            accountAssets: this.assets,
            funds,
            excludeIds,
            fills,
            currentBoundaryIdx: boundaryIdx
        };

        const { targetGrid, boundaryIdx: targetBoundary } = this.strategy.calculateTargetGrid(strategyParams);

        // P4 / unanchored plan: the strategy returns a null boundary paired
        // with an EMPTY target grid only when no numeric center exists to
        // recover from (e.g. GRID-LOAD rejected the persisted boundary AND
        // startPrice is an unresolved mode string). Planning rotations here
        // would fabricate rail-edge geometry — dust-cancel fills included,
        // even though they deliberately carry isDelayedRotationTrigger when
        // the boundary is known. Route to a structural resync instead of
        // broadcasting. (A null boundary with a non-empty target is a
        // hand-built/boundary-less plan — e.g. unit mocks — and proceeds.)
        if ((targetBoundary === null || targetBoundary === undefined) && targetGrid.size === 0) {
            // A genuinely empty grid (no master orders, no fills) has nothing
            // to heal — plain abort. Anything else is stranded without an
            // anchor and needs a rebuild.
            const needsHeal = (masterGrid?.size ?? 0) > 0 || (fills?.length ?? 0) > 0;
            this.logger?.log('[COW] Plan skipped: boundary unrecoverable (no numeric center)' + (needsHeal ? '; requesting structural resync' : ''), 'warn');
            return {
                ...buildAbortedResult('boundary-unrecoverable'),
                evacReady: [],
                ...(needsHeal ? { needsResync: true, resyncReason: 'boundary-unrecoverable' } : {}),
            };
        }

        let dustThresholdPercent = this.config?.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE;
        const reconcileResult = reconcileGrid(
            masterGrid,
            targetGrid,
            targetBoundary,
            {
                logger: (msg: any, level: any) => this.logger?.log(msg, level),
                dustThresholdPercent,
                gapSlots,
                evacStreaks,
                assets: this.assets
            }
        );

        // Gap-evacuation telemetry: evacReady is the streak-tick output of
        // reconcileGrid (stuck in-band candidates). It must survive both
        // abort and success so the manager can act on it even when the
        // rebalance plan itself aborts for an unrelated reason.
        const evacReady = Array.isArray((reconcileResult as any)?.evacReady)
            ? (reconcileResult as any).evacReady
            : [];

        if (reconcileResult.aborted) {
            const aborted = buildAbortedResult((reconcileResult as any).reason);
            (aborted as any).evacReady = evacReady;
            return aborted;
        }

        const optimizedActions = optimizeRebalanceActions(reconcileResult.actions, masterGrid, {
            logger: (msg: any, level: any) => this.logger?.log(msg, level),
            boundaryIdx: targetBoundary,
            gapSlots,
            assets: this.assets
        });

        // Stale-placement guard: drop placements crossing the plan's own
        // boundary (see stalePlacementDropReason) — defer them to the next
        // cycle instead of filling immediately.
        const planBoundary = (targetBoundary !== null && targetBoundary !== undefined && Number.isFinite(Number(targetBoundary)))
            ? Number(targetBoundary)
            : null;
        if (planBoundary !== null) {
            const before = optimizedActions.length;
            const guarded = optimizedActions.filter((a: any) => {
                const dropReason = stalePlacementDropReason(a, planBoundary);
                if (dropReason) {
                    this.logger?.log(`[COW] Dropping stale-slot ${dropReason}`, 'warn');
                    return false;
                }
                return true;
            });
            if (guarded.length < before) {
                this.logger?.log(
                    `[COW] Stale-placement guard removed ${before - guarded.length} placement(s); ${guarded.length} action(s) remain`,
                    'warn'
                );
            }
            optimizedActions.length = 0;
            optimizedActions.push(...guarded);
        }
        // Rail-edge truncation telemetry: when the planned window runs off
        // the rail (sellStart past the last slot), one side can never place
        // — the Sep-10 signature (boundary 209 on a 216-slot rail left 2
        // sell slots, and the ordinal pairing then teleported the buy rail
        // 113 slots). Warn only: the cross-guard, fund validation and
        // boundary-hold still judge the plan; no geometry is refused here.
        {
            const railSize = targetGrid?.size ?? 0;
            const gap = Number(gapSlots) || 0;
            const sellStart = Number(targetBoundary) + gap + 1;
            if (Number.isFinite(sellStart) && railSize > 0 && sellStart >= railSize) {
                this.logger?.log(`[COW] Rail-edge plan: boundary=${targetBoundary} gap=${gap} rail=${railSize} (sellStart=${sellStart}); window truncated, guards still apply`, 'warn');
            }
        }
        // Refill-slot wire (boundary-hold): surviving hole-CREATEs justify this
        // plan's boundary shift (folded CANCEL+CREATE pairs already became
        // stamped UPDATEs above; stale-dropped placements are excluded — a
        // deferred placement justifies nothing). The executor holds the
        // committed boundary when a listed refill is guard-skipped.
        // Reserve-ladder CREATEs are excluded (collectRefillSlotIds): reserves
        // are static edge insurance and their fills never crawl, so a skipped
        // reserve must not pin geometry either.
        const refillSlotIds = collectRefillSlotIds(optimizedActions, {
            config: this.config,
            slots: masterGrid,
            edgeAnchors: reserveEdgeAnchors
        });

        projectTargetToWorkingGrid(workingGrid, targetGrid, { actions: optimizedActions });

        const precisions = {
            buyPrecision: this.assets?.assetB?.precision,
            sellPrecision: this.assets?.assetA?.precision
        };

        const fundCheck = validateWorkingGridFunds(workingGrid, funds, precisions, this.assets);
        if (!fundCheck.isValid) {
            this.logger?.log(`[COW] Fund validation failed: ${fundCheck.reason}`, 'warn');
            return buildAbortedResult(fundCheck.reason);
        }

        if (workingGrid.isStale()) {
            const reason = workingGrid.getStaleReason() || 'Master grid changed during planning';
            this.logger?.log(`[COW] Rebalance plan invalidated: ${reason}`, 'warn');
            return buildAbortedResult(reason);
        }

        const stateUpdates = buildStateUpdates(optimizedActions, masterGrid);

        const duration = Date.now() - startTime;
        if (duration > COW_PERFORMANCE.MAX_REBALANCE_PLANNING_MS) {
            this.logger?.log(`[COW] Rebalance planning took ${duration}ms`, 'warn');
        }

        this.logger?.log(
            `[COW] Plan: Actions=${optimizedActions.length}, StateUpdates=${stateUpdates.length}`,
            'info'
        );

        // Per-action plan detail. UPDATE/ROTATE ops are the dangerous ones —
        // their target size/price must be visible in production logs without
        // on-chain archaeology (a mis-sized update op is only diagnosable from
        // the chain afterwards otherwise).
        for (const a of optimizedActions) {
            if (!a || !a.type || !a.id) continue;
            const size = Number.isFinite(Number(a.newSize))
                ? Number(a.newSize)
                : Number(a.order?.size);
            const price = Number.isFinite(Number(a.newPrice))
                ? Number(a.newPrice)
                : Number(a.order?.price);
            const rotationSuffix = (a.newGridId && a.newGridId !== a.id) ? ` -> ${a.newGridId}` : '';
            const line = `[COW] Plan action: ${a.type} ${a.id}${rotationSuffix} ` +
                `(orderId=${a.orderId || 'none'}, size=${Number.isFinite(size) ? Format.formatAmount(size) : 'n/a'}, ` +
                `price=${Number.isFinite(price) ? Format.formatPrice6(price) : 'n/a'})`;
            this.logger?.log(line, a.type === COW_ACTIONS.UPDATE ? 'info' : 'debug');
        }

        return {
            ...buildSuccessResult({
                actions: optimizedActions,
                stateUpdates,
                workingGrid,
                workingBoundary: targetBoundary,
                planningDuration: duration,
                refillSlotIds
            }),
            evacReady
        };
    }
}

// ===============================================================================
// SECTION 3: ORDER MANAGER CLASS
// ===============================================================================

class OrderManager {
    config: any;
    marketName: any;
    logger: any;
    orders: any;
    boundaryIdx: any;
    targetGrid: any;
    accountant: any;
    strategy: any;
    sync: any;
    _rebalanceState: string;
    _bootstrapping: number;
    _endOfBootstrapValidationDone: boolean;
    _broadcastingFlag: number;
    _broadcastingStartedAt: number;
    _shuttingDown: boolean;
    _illegalStateSignal: any;
    _accountingFailureSignal: any;
    _recoveryStateValue: { phase: string; attemptCount: number; lastAttemptAt: number; inFlight: boolean; lastFailureAt: number; structuralResyncRequested?: boolean };
    _gridRegenStateValue: { buy: { armed: boolean; lastTriggeredAt: number }; sell: { armed: boolean; lastTriggeredAt: number } };
    private _ordersByTypeCache: Record<string, Set<string>> | null = null;
    private _ordersByStateCache: Record<string, Set<string>> | null = null;
    private _ordersByTypeCacheVersion: number = -1;
    private _ordersByStateCacheVersion: number = -1;

    /**
     * Lazy-compute order-IDs grouped by type.
     *
     * Cache is invalidated when _gridVersion changes (bumped on each COW
     * commit).  The rebuild iterates this.orders (O(n) where n = total
     * slot count) but is amortized O(1) across accesses within the same
     * grid version — the cache is a derived snapshot, not a maintained
     * index, so explicit mutation paths no longer update it.
     *
     * THE SETTER stores into cache only; it does NOT populate this.orders.
     * Test mocks that assign _ordersByType directly are honored until the
     * next grid-version bump triggers a full rebuild from the real orders.
     */
    get _ordersByType(): Record<string, Set<string>> {
        if (this._ordersByTypeCache !== null && this._ordersByTypeCacheVersion === this._gridVersion) {
            return this._ordersByTypeCache;
        }
        const byType: Record<string, Set<string>> = {};
        for (const key of [ORDER_TYPES.BUY, ORDER_TYPES.SELL, ORDER_TYPES.SPREAD]) {
            byType[key] = new Set();
        }
        for (const [id, o] of this.orders) {
            if (byType[o.type]) byType[o.type].add(id);
        }
        this._ordersByTypeCache = byType;
        this._ordersByTypeCacheVersion = this._gridVersion;
        return byType;
    }
    set _ordersByType(val: Record<string, Set<string>>) {
        this._ordersByTypeCache = val;
        this._ordersByTypeCacheVersion = this._gridVersion;
    }

    /**
     * Lazy-compute order-IDs grouped by state.  Same semantics as
     * _ordersByType — see getter doc for details.
     */
    get _ordersByState(): Record<string, Set<string>> {
        if (this._ordersByStateCache !== null && this._ordersByStateCacheVersion === this._gridVersion) {
            return this._ordersByStateCache;
        }
        const byState: Record<string, Set<string>> = {};
        for (const key of [ORDER_STATES.VIRTUAL, ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL]) {
            byState[key] = new Set();
        }
        for (const [id, o] of this.orders) {
            if (byState[o.state]) byState[o.state].add(id);
        }
        this._ordersByStateCache = byState;
        this._ordersByStateCacheVersion = this._gridVersion;
        return byState;
    }
    set _ordersByState(val: Record<string, Set<string>>) {
        this._ordersByStateCache = val;
        this._ordersByStateCacheVersion = this._gridVersion;
    }
    initialSpreadCount: number;
    currentSpreadCount: number;
    outOfSpread: number;
    assets: any;
    accountId: any;
    accountTotals: any;
    funds: any;
    _accountTotalsPromise: any;
    _accountTotalsResolve: any;
    _isFetchingTotals: boolean;
    accountTotalsStale: boolean;
    ordersNeedingPriceCorrection: any[];
    shadowOrderIds: Map<any, any>;
    processedFillTracker: Map<any, any>;
    processedFillStore: any;
    _syncLock: any;
    _fillProcessingLock: any;
    _divergenceLock: any;
    _gridLock: any;
    _fundLock: any;
    _recentlyRotatedOrderIds: Set<any>;
    _gridSidesUpdated: Set<any>;
    _pauseFundRecalc: number;
    _pauseFundRecalcWatchdog: ReturnType<typeof setTimeout> | null;
    _fillBatchInFlight: number;
    _pauseRecalcLogging: boolean;
    _pauseRecalcLoggingWatchdog: ReturnType<typeof setTimeout> | null;
    _throwOnIllegalState: boolean;
    _pipelineBlockedSince: any;
    _recoveryAttempted: boolean;
    _syncGeneration: number;
    _gridVersion: number;
    _gridPersistenceSuspendedReason: any;
    _pendingBroadcasts: Map<any, any>;
    _committedOrderIds: Set<string>;
    _committedOrderIdsBuiltAt: number;
    _orderIdAssignedAt: Map<string, number>;
    _gapSlots: number;
    _gridDirtyAt: number | null;
    _lastStaleTotalsWarnAt: Record<string, number>;
    _orphanFillsCreditedAt: number | null;
    _fundDriftLedger: { side: string; direction: string; count: number; firstAt: number; lastAt: number } | null;
    _pendingRecovery: Promise<void> | null;
    _pendingFillCrawls: { slotId: string; side: string; ts: number }[];
    _recentFillKeysSnapshot: Record<string, number> | null;
    _lastFilledBuyPrice: number | null;
    _lastFilledSellPrice: number | null;
    _lastFilledPrice: number | null;
    _lastFilledType: string | null;
    _lastFilledAt: number;
    _deferredRebalanceAt: number;
    _lastHeldPlanSignature: any;
    _heldPlanSuppressionCount: number;
    _onBroadcastRegionEndListeners: Array<() => void>;
    _lastBoundaryHoldResyncAt: number;
    _gapEvacStreaks: Map<string, number>;
    _gapEvacCancelQueued: Set<string>;
    // anchor fields removed
    // Note: dedupe lives inside the anchor object (`_seenKeys`), not here.
    // Kept for backwards compat if external code checks existence; not used.

    _metrics: any;
    private _currentWorkingGridStack: any[];
    _cowEngine: any;
    accountOrders: any;
    btsBalance: { free: number; total: number; locked: number };

    /**
     * @param {Object} [config] - Configuration overrides
     */
    constructor(config: Record<string, any> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        const logFile = config.logFile || undefined;
        const loggingConfig = this.config.logging;
        this.logger = new Logger('DEXBot', {
            level: loggingConfig?.level ?? LOG_LEVEL,
            logFile,
            configOverride: loggingConfig?.config ?? undefined
        });
        this.logger.marketName = this.marketName;
        this.orders = Object.freeze(new Map());
        this.boundaryIdx = null;
        this.targetGrid = null;

        this.accountant = new Accountant(this);
        this.strategy = new StrategyEngine(this);
        this.sync = new SyncEngine(this);

        this._rebalanceState = REBALANCE_STATES.NORMAL;
        this._bootstrapping = 0;
        this._endOfBootstrapValidationDone = false;
        this._broadcastingFlag = 0;
        this._broadcastingStartedAt = 0;
        this._shuttingDown = false;
        this._illegalStateSignal = null;
        this._accountingFailureSignal = null;
        this._recoveryStateValue = {
            phase: 'idle',
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0
        };
        this._gridRegenStateValue = {
            buy: { armed: true, lastTriggeredAt: 0 },
            sell: { armed: true, lastTriggeredAt: 0 }
        };



        // Sync reset — _fundLock is not created until later in the constructor,
        // and no concurrent access exists during construction.
        this.accountant.resetFunds();
        this.btsBalance = { free: 0, total: 0, locked: 0 };
        this.initialSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = 0;
        this.assets = null;
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        this._isFetchingTotals = false;
        this.accountTotalsStale = false;
        this.ordersNeedingPriceCorrection = [];
        this.shadowOrderIds = new Map();
        this.processedFillTracker = new Map();
        this.processedFillStore = null;

        // LOCK HIERARCHY (convention — not enforced at runtime to avoid false
        // positives from async contention and multi-bot sharing a process).
        // Acquire in ascending level order only:
        //   Level 0: _fillProcessingLock  (fill processing — outermost)
        //   Level 1: _divergenceLock   (divergence checks)
        //   Level 2: _syncLock         (sync operations — timeout-protected)
        //   Level 3: _gridLock         (grid mutations)
        //   Level 4: _fundLock         (fund operations — innermost)
        // Note: AsyncLock IS re-entrant (acquire detects nested calls via context).
        this._fillProcessingLock = new AsyncLock({ timeout: TIMING.SYNC_LOCK_TIMEOUT_MS });
        this._divergenceLock = new AsyncLock();
        this._syncLock = new AsyncLock();
        this._gridLock = new AsyncLock({
            onContention: () => { this._metrics.gridLockContention++; }
        });
        this._fundLock = new AsyncLock({ timeout: 30000 });

        this._recentlyRotatedOrderIds = new Set();
        this._gridSidesUpdated = new Set();
        this._pauseFundRecalc = 0;
        this._pauseFundRecalcWatchdog = null;
        // Depth counter for fill batches currently mid-accounting. While non-zero,
        // _verifyFundInvariants must not run: the batch's balance refresh already
        // reflects the just-filled orders on-chain, but the grid still holds them
        // as committed until the batch's grid mutation lands, so a check in that
        // window would report a spurious Total != Free + Committed by exactly the
        // fills' size. The check runs once the batch settles instead.
        this._fillBatchInFlight = 0;
        this._pauseRecalcLogging = false;
        this._pauseRecalcLoggingWatchdog = null;
        this._throwOnIllegalState = false;
        this._pipelineBlockedSince = null;
        this._recoveryAttempted = false;
        this._syncGeneration = 0;
        this._gridVersion = 0;
        this._gridPersistenceSuspendedReason = null;
        this._pendingBroadcasts = new Map();
        this._committedOrderIds = new Set();
        this._committedOrderIdsBuiltAt = 0;
        this._orderIdAssignedAt = new Map();
        this._gapSlots = 0;
        this._gridDirtyAt = null;
        this._orphanFillsCreditedAt = null;
        this._fundDriftLedger = null;
        this._pendingRecovery = null;
        this._pendingFillCrawls = [];
        this._recentFillKeysSnapshot = null;
        this._lastStaleTotalsWarnAt = {};
        this._lastFilledBuyPrice = null;
        this._lastFilledSellPrice = null;
        this._lastFilledPrice = null;
        this._lastFilledType = null;
        this._lastFilledAt = 0;
        this._deferredRebalanceAt = 0;
        this._lastHeldPlanSignature = null;
        this._heldPlanSuppressionCount = 0;
        this._onBroadcastRegionEndListeners = [];
        this._lastBoundaryHoldResyncAt = 0;
        this._gapEvacStreaks = new Map();
        this._gapEvacCancelQueued = new Set();

        this._metrics = {
            fundRecalcCount: 0,
            lockAcquisitions: 0,
            lockContentionSkips: 0,
            gridLockContention: 0,
            spreadRoleConversionBlocked: 0,
            lastSyncDurationMs: 0,
            metricsStartTime: Date.now()
        };

        this._bootstrapping = 1;
        this.logger?.log('[BOOTSTRAP] Started', 'debug');
        this._currentWorkingGridStack = [];
        this._cowEngine = null;

        this._cleanExpiredLocks();
    }

    _getCOWEngine() {
        if (!this._cowEngine && this.assets) {
            this._cowEngine = new COWRebalanceEngine({
                strategy: this.strategy,
                logger: this.logger,
                assets: this.assets,
                config: this.config
            });
        }
        return this._cowEngine;
    }

    _clearWorkingGridRef() {
        this._currentWorkingGridStack.pop();
        this._rebalanceState = this._currentWorkingGridStack.length > 0
            ? REBALANCE_STATES.REBALANCING
            : REBALANCE_STATES.NORMAL;
    }

    /**
     * Push a working grid onto the rebalance stack (LIFO), set the state to
     * REBALANCING, and — when a result object is provided — mark it as pushed
     * so pop sites can release exactly the entry this push created. This is
     * the only place a grid may be pushed; all releases go through
     * _popWorkingGridRef (marker-guarded, early-return sites) or
     * _releaseWorkingGridRef (identity-checked, commit sites).
     * @param {Object} workingGrid - The working grid to push
     * @param {Object} [result] - Result object to carry the push marker on
     */
    _pushWorkingGridRef(workingGrid: any, result: any = null) {
        this._currentWorkingGridStack.push(workingGrid);
        this._rebalanceState = REBALANCE_STATES.REBALANCING;
        if (result) {
            result._workingGridPushed = true;
        }
        return result;
    }

    /**
     * Pop the stack entry owned by a result, exactly once (marker-guarded).
     * Results that were never pushed (aborted plans, no-trigger
     * processFilledOrders outputs, updateOrdersOnChainPlan cowResults,
     * reconcileGridOrders null results) leave the stack untouched — an
     * unmatched pop could steal a nested grid's entry. Clears the marker so
     * a later throw in the same frame cannot pop a second time.
     * @param {Object} [result] - Result object carrying the push marker
     */
    _popWorkingGridRef(result: any = null) {
        if (result && result._workingGridPushed === true) {
            this._clearWorkingGridRef();
            result._workingGridPushed = false;
        }
    }

    /**
     * Release the stack entry for a grid after its commit settles, exactly
     * once per commit invocation. Identity-checked: plan-path grids
     * (updateOrdersOnChainPlan, local-only divergence commits) were never
     * pushed, so popping unconditionally would steal a NESTED grid's stack
     * entry. Pushed grids are always at the top at commit time (LIFO), so
     * the check is a no-op for them.
     * @param {Object} workingGrid - The committed working grid
     */
    _releaseWorkingGridRef(workingGrid: any) {
        const stack = this._currentWorkingGridStack;
        if (stack.length > 0 && stack[stack.length - 1] === workingGrid) {
            this._clearWorkingGridRef();
        }
    }

    _setRebalanceState(state: any) {
        this._rebalanceState = state;
        this.logger?.log(`[COW] Rebalance state: ${state}`, 'debug');
    }

    _resetRebalanceStateToDepth() {
        this._rebalanceState = this._currentWorkingGridStack.length > 0
            ? REBALANCE_STATES.REBALANCING
            : REBALANCE_STATES.NORMAL;
    }

    /**
     * @returns {boolean}
     */
    isRebalancing() {
        return this._rebalanceState === REBALANCE_STATES.REBALANCING;
    }

    /**
     * @returns {boolean}
     */
    isBootstrapping() {
        return this._bootstrapping > 0;
    }

    /**
     * Whether a broadcast is currently active (no side-effects).
     * @returns {boolean}
     */
    isBroadcastingActive() {
        return this._broadcastingFlag > 0;
    }

    /**
     * Whether the owning bot has begun shutting down. Mirrors the
     * bot-level `_shuttingDown` flag (set via setShuttingDown() from
     * DEXBot._shutdownImpl) so manager-level wait loops can bail out
     * instead of proceeding with broadcasts after shutdown completed.
     * @returns {boolean}
     */
    isShuttingDown() {
        return this._shuttingDown === true;
    }

    /**
     * @param {boolean} value
     * @returns {void}
     */
    setShuttingDown(value: any) {
        this._shuttingDown = value === true;
    }

    /**
     * Auto-clears a stale broadcast flag after 120s so a hung
     * broadcast cannot permanently block rebalancing.
     * Separated from isBroadcastingActive() so the side-effect only
     * runs from one well-defined location (maintenance logic) instead
     * of from every read call-site.
     * @returns {void}
     */
    _clearStaleBroadcastFlag() {
        if (this._broadcastingFlag > 0 && this._broadcastingStartedAt > 0) {
            const elapsed = Date.now() - this._broadcastingStartedAt;
            if (elapsed > 120000) {
                this.logger?.log?.('[BROADCAST] Auto-clearing stale broadcast flag after 120s', 'warn');
                // Hard-reset to 0 (not decrement) — this is a safety valve for
                // a hung broadcast where stopBroadcasting() was never called.
                // The caller is released from the refcount contract.
                this._broadcastingFlag = 0;
                this._broadcastingStartedAt = 0;
                // A leaked flag never reaches stopBroadcasting, so wake the same
                // region-end listeners it would have: without this, fills
                // enqueued during the hung region are stranded until the next
                // fill event even though the flag is now clear.
                this._fireBroadcastRegionEnd();
            }
        }
    }

    /**
     * Whether the manager is in the middle of a rebalance plan or broadcast.
     * @returns {boolean}
     */
    isPlanningActive() {
        return this.isRebalancing() || this.isBroadcastingActive();
    }

    /**
     * @returns {void}
     */
    startBootstrap() {
        if (this._bootstrapping === 0) {
            this.logger?.log('[BOOTSTRAP] Started', 'debug');
            this._endOfBootstrapValidationDone = false;
        }
        this._bootstrapping++;
    }

    /**
     * @returns {any}
     */
    finishBootstrap() {
        const result = { hadDrift: false, driftInfo: null };

        if (this._bootstrapping > 0) {
            this._bootstrapping--;
        }

        if (this._bootstrapping === 0 && !this._endOfBootstrapValidationDone) {
            this._endOfBootstrapValidationDone = true;
            this.logger?.log('[BOOTSTRAP] Finished', 'debug');

            // Validate fund state at bootstrap completion - if drift exists here,
            // it's not transient (grid is now stable) and indicates a potential bug
            const driftCheck = this.checkFundDriftAfterFills();
            if (!driftCheck.isValid) {
                result.hadDrift = true;
                result.driftInfo = driftCheck as any;
                this.logger.log(
                    `[BOOTSTRAP-END] Fund drift detected after bootstrap: ${driftCheck.reason}. ` +
                    `This may indicate a bug in grid initialization.`,
                    'warn'
                );
            }

            this.logger.log("Bootstrap phase complete. Grid health monitoring and fund invariants active.", "info");
        }

        return result;
    }

    /**
     * @returns {void}
     */
    startBroadcasting() {
        // Refresh the stale-watchdog timestamp on EVERY increment, not just
        // the 0→1 transition: with refcounted holders (e.g. structural
        // Phase-2 reconcile + an inner COW batch) measuring only from the
        // first holder's start lets the 120s watchdog hard-reset while a
        // later holder is still legitimately active. Each new holder
        // restarts the window; the commit-refusal backstop bounds any
        // pathological stream of short holders.
        this._broadcastingStartedAt = Date.now();
        this._broadcastingFlag++;
        this.logger?.log?.('[BROADCAST] Flag incremented — fill processing will be deferred until stopBroadcasting()', 'debug');
    }

    /**
     * @returns {void}
     */
    stopBroadcasting() {
        if (this._broadcastingFlag > 0) {
            this._broadcastingFlag--;
        }
        if (this._broadcastingFlag === 0) {
            this._broadcastingStartedAt = 0;
            // Runtime hook (wired by the bot): the fill consumer defers while
            // this flag is held and its defer branch returns without
            // rescheduling, so fills enqueued during a long region would
            // starve indefinitely. Fire once when the last region ends.
            this._fireBroadcastRegionEnd();
        }
    }

    /**
     * Notify runtime listeners that the last broadcast/placement region ended.
     * Called from stopBroadcasting (refcount -> 0) and the stale-flag watchdog
     * (a leaked flag hard-reset to 0). The fill consumer's defer branch returns
     * without rescheduling, so this is the only wake-up for fills enqueued
     * during a region; the watchdog path must fire it too or a hung broadcast's
     * queued fills wait for the next fill event.
     * Fans out to the legacy single listener plus every registered listener
     * (see addBroadcastRegionEndListener): a second wirer must never silently
     * displace the fill-queue drain. Guarded so a listener error never escapes
     * into a finally/watchdog frame.
     * @returns {void}
     */
    _fireBroadcastRegionEnd() {
        try {
            (this as any)._onBroadcastRegionEnd?.();
        } catch (err: any) {
            this.logger?.log?.(`[BROADCAST] Region-end hook failed: ${err?.message || err}`, 'warn');
        }
        const listeners = (this as any)._onBroadcastRegionEndListeners;
        if (Array.isArray(listeners)) {
            for (const listener of listeners) {
                try {
                    (listener as any)?.();
                } catch (err: any) {
                    this.logger?.log?.(`[BROADCAST] Region-end listener failed: ${err?.message || err}`, 'warn');
                }
            }
        }
    }

    /**
     * Register an additional broadcast-region-end listener without displacing
     * the legacy single listener or previously registered ones. Duplicate
     * registrations of the same function reference are ignored.
     * @param {() => void} listener
     * @returns {void}
     */
    addBroadcastRegionEndListener(listener: () => void) {
        if (typeof listener !== 'function') return;
        if (!Array.isArray((this as any)._onBroadcastRegionEndListeners)) {
            (this as any)._onBroadcastRegionEndListeners = [];
        }
        const listeners = (this as any)._onBroadcastRegionEndListeners;
        if (!listeners.includes(listener)) listeners.push(listener);
    }

    /**
     * Reset funds structure to zeroed values. Acquires _fundLock so the
     * wholesale funds replacement cannot race with concurrent fund mutations
     * (deductBtsFees, tryDeductFromChainFree, updateOptimisticFreeBalance).
     * @returns {Promise<void>}
     */
    async resetFunds() {
        return await this._fundLock.acquire(async () => {
            return this.accountant.resetFunds();
        });
    }

    /**
     * Computes committed amounts directly from the orders map to ensure the
     * snapshot is internally consistent even when called inside a
     * pauseFundRecalc region.  Normally recalculateFunds() keeps
     * funds.committed.chain in sync, but when pauses are nested the cached
     * value can lag behind the actual orders state (virtualized orders
     * release committed capital via updateOptimisticFreeBalance without
     * triggering a recalc).  Reading from the orders map avoids that race.
     * @returns {any}
     */
    getChainFundsSnapshot() {
        let committedBuy = 0, committedSell = 0;
        for (const order of this.orders.values()) {
            const isActive = (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) && !!order.orderId;
            if (!isActive) continue;
            const size = toFiniteNumber(order.size);
            if (size <= 0) continue;
            const isBuy = order.type === ORDER_TYPES.BUY || (order.type === ORDER_TYPES.SPREAD && resolveSpreadOrderSide(order.price, this.config.startPrice) === ORDER_TYPES.BUY);
            if (isBuy) committedBuy += size;
            else committedSell += size;
        }
        const totals = computeChainFundTotals(this.accountTotals, { buy: committedBuy, sell: committedSell });
        const allocatedBuy = toFiniteNumber(this.funds?.allocated?.buy, totals.chainTotalBuy);
        const allocatedSell = toFiniteNumber(this.funds?.allocated?.sell, totals.chainTotalSell);
        const btsBalance = (this.config.assetA !== 'BTS' && this.config.assetB !== 'BTS')
            ? (this.btsBalance || { free: 0, total: 0, locked: 0 })
            : null;
        return { ...totals, allocatedBuy, allocatedSell, btsBalance };
    }

    /**
     * @param {number} [timeoutMs]
     * @returns {Promise<void>}
     */
    async waitForAccountTotals(timeoutMs: any = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, true)) return;

        let waitPromise = null;

        await this._fundLock.acquire(async () => {
            if (hasValidAccountTotals(this.accountTotals, true)) return;
            if (!this._accountTotalsPromise) {
                this._accountTotalsPromise = new Promise((resolve: any) => {
                    this._accountTotalsResolve = resolve;
                });
            }
            waitPromise = this._accountTotalsPromise;
        });

        if (!waitPromise) return;

        await withTimeout(waitPromise, timeoutMs, {
            onTimeout: 'resolve',
            defaultValue: undefined as any,
            onTimeoutCallback: () => this.logger.log('[FUND] Timeout waiting for account totals', 'warn'),
        });
    }

    /**
     * @param {string} [accountId] - Blockchain account ID
     * @returns {Promise<void>}
     */
    async fetchAccountTotals(accountId: any) {
        if (accountId) this.accountId = accountId;
        await this._fetchAccountBalancesAndSetTotals();
    }

    /**
     * Refresh accountTotals from chain when the cached snapshot is stale.
     *
     * Optimistic deductions (tryDeductFromChainFree) refuse to operate on
     * snapshots older than MAX_ACCOUNT_TOTALS_AGE_MS and schedule a recovery
     * instead, leaving the order placed but unaccounted. By refreshing once
     * up front, the caller's accounting batch runs against a fresh snapshot
     * so deductions apply normally and no skip/recovery cycle is triggered.
     *
     * @returns {Promise<{ok: boolean, reason?: string}>} {ok: true} when the
     * snapshot is (now) fresh; {ok: false, reason} when the refresh failed and
     * the snapshot is still stale — the caller must not proceed with accounting.
     */
    async refreshAccountTotalsIfStale(options: { force?: boolean } = {}) {
        const force = options?.force === true;
        const lastFetched = this.accountTotals?._lastFetchedAt || 0;
        if (!force && Date.now() - lastFetched <= TIMING.MAX_ACCOUNT_TOTALS_AGE_MS) {
            return { ok: true };
        }
        const fetchedBefore = lastFetched;
        // Apply the standard blockchain-op policy (30s timeout, 3 attempts, then
        // node failover) so a transiently bad node does not force the caller to
        // defer the whole fill batch to the next cycle. Only a genuinely
        // unreachable chain leaves the snapshot stale.
        try {
            await withBlockchainRetry(
                () => this.fetchAccountTotals(this.accountId),
                'refreshAccountTotalsIfStale',
                { logger: this.logger }
            );
        } catch (err: any) {
            this.logger?.log?.(`[SYNC] refreshAccountTotalsIfStale fetch failed: ${getErrorMessage(err)}`, 'warn');
        }
        const fetchedAfter = this.accountTotals?._lastFetchedAt || 0;
        if (fetchedAfter <= fetchedBefore) {
            if (this._rateLimitStaleTotalsWarn('stale-refresh')) {
                this.logger?.log?.(
                    `[SYNC] refreshAccountTotalsIfStale: accountTotals still stale after refresh (age=${Math.max(0, Date.now() - fetchedAfter)}ms).`,
                    'warn'
                );
            }
            return { ok: false, reason: 'refresh-failed' };
        }
        return { ok: true };
    }

    /**
     * Rate-limit identical accountTotals-staleness warnings to once per
     * STALE_TOTALS_WARN_RATE_LIMIT_MS per warning kind per manager, so a
     * persistently unreachable chain reports each failure mode once without
     * flooding the log on every fill batch.
     * @param {string} kind - Warning kind key (e.g. 'stale-refresh', 're-anchor')
     * @returns {boolean} true when the warning should be emitted now
     */
    _rateLimitStaleTotalsWarn(kind: string): boolean {
        const now = Date.now();
        if (now - (this._lastStaleTotalsWarnAt[kind] || 0) < TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS) return false;
        this._lastStaleTotalsWarnAt[kind] = now;
        return true;
    }

    /**
     * Re-anchor accountTotals to authoritative on-chain values after a fill
     * batch has applied its optimistic accounting and grid mutation.
     *
     * A fill batch's up-front stale-totals refresh returns POST-fill balances
     * (the fills already settled on-chain), then processFillAccounting applies
     * the same pays/receives again — a double-count on the totals. Force-fetching
     * here overwrites the optimistic values with the authoritative post-fill
     * state so the batch ends exactly consistent with chain and the invariant
     * holds at the final consolidated recalculation.
     *
     * @param {string} [label] - Context label for log messages
     * @returns {Promise<boolean>} true when the re-anchor refreshed successfully
     */
    async reanchorAccountTotals(label = 'fill-batch') {
        const result = await this.refreshAccountTotalsIfStale({ force: true });
        if (!result.ok) {
            if (this._rateLimitStaleTotalsWarn('re-anchor')) {
                this.logger?.log?.(
                    `[ACCOUNTING] ${label}: accountTotals re-anchor failed (${result.reason}); marking totals stale.`,
                    'warn'
                );
            }
            this.accountTotalsStale = true;
            return false;
        }
        return true;
    }

    async _fetchAccountBalancesAndSetTotals() {
        return await this.sync.fetchAccountBalancesAndSetTotals();
    }

    /**
     * @param {any} totals - Account balance totals
     * @returns {Promise<void>}
     */
    async setAccountTotals(totals: any = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        return await this._fundLock.acquire(async () => {
            return await this._setAccountTotals(totals);
        });
    }

    async _setAccountTotals(totals: any) {
        this.accountTotals = { ...(this.accountTotals || {}), ...totals, _lastFetchedAt: Date.now() };
        if (!this.funds) await this.resetFunds();

        await this._recalculateFunds();

        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try {
                this._accountTotalsResolve();
            } catch (e: any) {
                this.logger?.log?.(`Error resolving account totals promise: ${getErrorMessage(e)}`, 'warn');
            }
            this._accountTotalsPromise = null;
            this._accountTotalsResolve = null;
        }
    }

    _triggerAccountTotalsFetchIfNeeded() {
        if (!this._isFetchingTotals) {
            this._isFetchingTotals = true;
            this._fetchAccountBalancesAndSetTotals().finally(() => {
                this._isFetchingTotals = false;
            });
        }
    }

    /**
     * @returns {void}
     */
    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;
        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);

        const account = this.config.preferredAccount;
        const botName = this.config.botKey;
        const allocatedBuy = resolveConfigValueWithRegistry(this.config.botFunds.buy, chainTotalBuy, account, botName, 'buy');
        const allocatedSell = resolveConfigValueWithRegistry(this.config.botFunds.sell, chainTotalSell, account, botName, 'sell');

        if (allocatedBuy === 0 && typeof this.config.botFunds.buy === 'string' && this.config.botFunds.buy.trim().endsWith('%')) {
            if (chainTotalBuy === 0) this._triggerAccountTotalsFetchIfNeeded();
        }
        if (allocatedSell === 0 && typeof this.config.botFunds.sell === 'string' && this.config.botFunds.sell.trim().endsWith('%')) {
            if (chainTotalSell === 0) this._triggerAccountTotalsFetchIfNeeded();
        }

        this.funds.allocated = { buy: allocatedBuy, sell: allocatedSell };

        const shouldCapBuy = allocatedBuy > 0 || isExplicitZeroAllocation(this.config.botFunds.buy);
        const shouldCapSell = allocatedSell > 0 || isExplicitZeroAllocation(this.config.botFunds.sell);

        if (shouldCapBuy) this.funds.available.buy = Math.min(this.funds.available.buy, Math.max(0, allocatedBuy));
        if (shouldCapSell) this.funds.available.sell = Math.min(this.funds.available.sell, Math.max(0, allocatedSell));
    }

    /**
     * @returns {Promise<void>}
     */
    async recalculateFunds() {
        return await this._fundLock.acquire(async () => {
            return await this._recalculateFunds();
        });
    }

    async _recalculateFunds() {
        if (!this.accountant) return;
        this._metrics.fundRecalcCount++;
        await this.accountant.recalculateFunds();
    }

    /**
     * Suppress fund recalculation during batch mutations.
     *
     * Use when multiple _applyOrderUpdate calls would each trigger redundant
     * recalculateFunds (e.g. grid load, grid init, fill batch). Must be paired
     * with resumeFundRecalc() in a try/finally block.
     *
     * Supports nesting via depth counter — only the outermost resume triggers
     * the single consolidated recalculation.
     *
     * For bulk mutation sites that also need to suppress debug RECALC logging
     * during the loop, pair this with pauseRecalcLogging()/resumeRecalcLogging().
     *
     * Use independently of pauseRecalcLogging when you need recalc to still run
     * per-operation but want to batch the trigger (e.g. _updateOrdersForSide
     * needs per-call chain-free tracking but suppresses log spam).
     *
     * @returns {void}
     */
    pauseFundRecalc() {
        this._pauseFundRecalc++;
        // Safety watchdog: if pauseFundRecalc is not resumed within the timeout,
        // force-reset the counter to prevent permanent suppression from a missed
        // finally block. Only set when depth goes from 0 → 1 so only the outermost
        // pause has a watchdog.
        if (this._pauseFundRecalc === 1) {
            if (this._pauseFundRecalcWatchdog) {
                clearTimeout(this._pauseFundRecalcWatchdog);
            }
            this._pauseFundRecalcWatchdog = setTimeout(() => {
                if (this._pauseFundRecalc > 0) {
                    this.logger?.log?.(
                        `[MANAGER] pauseFundRecalc safety watchdog: resetting depth from ${this._pauseFundRecalc} to 0`,
                        'warn'
                    );
                    this._pauseFundRecalc = 0;
                    this._pauseFundRecalcWatchdog = null;
                    this.recalculateFunds().catch((err: any) => {
                        this.logger?.log?.(`[MANAGER] Watchdog recalc failed: ${getErrorMessage(err)}`, 'error');
                    });
                }
            }, TIMING.SAFETY_PAUSE_TIMEOUT_MS);
        }
    }

    /**
     * Resume fund recalculation and trigger one consolidated recalculateFunds()
     * when the outermost resume completes.
     * @returns {Promise<void>}
     */
    async resumeFundRecalc() {
        this._pauseFundRecalc = Math.max(0, this._pauseFundRecalc - 1);
        if (this._pauseFundRecalc === 0) {
            if (this._pauseFundRecalcWatchdog) {
                clearTimeout(this._pauseFundRecalcWatchdog);
                this._pauseFundRecalcWatchdog = null;
            }
            await this.recalculateFunds();
        }
    }

    /**
     * Suppress only the debug-level [RECALC] log lines inside recalculateFunds().
     *
     * Lighter than pauseFundRecalc — recalculation still runs, only log output
     * is suppressed. Use when individual _updateOrder calls must update chain-free
     * balances but the iterative debug logging would flood output
     * (e.g. _updateOrdersForSide grid resize loop).
     *
     * When paired with pauseFundRecalc/resumeFundRecalc (grid load/init),
     * both calcs and logging are suppressed during the batch. When used alone
     * (_updateOrdersForSide), recalc runs per-call but logs are suppressed.
     *
     * @returns {void}
     */
    pauseRecalcLogging() {
        this._pauseRecalcLogging = true;
        if (this._pauseRecalcLoggingWatchdog) {
            clearTimeout(this._pauseRecalcLoggingWatchdog);
        }
        this._pauseRecalcLoggingWatchdog = setTimeout(() => {
            this.logger?.log?.(
                `[MANAGER] pauseRecalcLogging safety watchdog: forcing resume after ${TIMING.SAFETY_PAUSE_TIMEOUT_MS}ms`,
                'warn'
            );
            this._pauseRecalcLogging = false;
            this._pauseRecalcLoggingWatchdog = null;
        }, TIMING.SAFETY_PAUSE_TIMEOUT_MS);
    }

    /**
     * Resume recalc debug logging.
     * @returns {void}
     */
    resumeRecalcLogging() {
        this._pauseRecalcLogging = false;
        if (this._pauseRecalcLoggingWatchdog) {
            clearTimeout(this._pauseRecalcLoggingWatchdog);
            this._pauseRecalcLoggingWatchdog = null;
        }
    }

    /**
     * @param {Array<import('./types').Order>} orders
     * @param {Object} info
     * @returns {Promise<any>}
     */
    syncFromOpenOrders(orders: any, info: any) {
        return this.sync.syncFromOpenOrders(orders, info);
    }

    /**
     * @param {Object} fill - Fill event data
     * @param {Object} [options]
     * @returns {Promise<any>}
     */
    syncFromFillHistory(fill: any, options: any) {
        return this.sync.syncFromFillHistory(fill, options);
    }

    /**
     * @param {Array} fills - Array of fill event objects (same block group)
     * @param {Object} [options]
     * @returns {Promise<any>}
     */
    syncFromFillHistoryBatch(fills: any, options: any) {
        return this.sync.syncFromFillHistoryBatch(fills, options);
    }

    /**
     * @param {Object} data - Chain data to synchronize
     * @param {string} src - Source identifier
     * @returns {Promise<any>}
     */
    async synchronizeWithChain(data: any, src: any) {
        // Lock delegation: createOrder/cancelOrder acquire _gridLock internally;
        // readOpenOrders/periodicBlockchainFetch acquire _syncLock → _gridLock.
        return await this._applySync(data, src);
    }

    async _applySync(data: any, src: any) {
        return await this.sync.synchronizeWithChain(data, src);
    }

    async _initializeAssets() {
        return await this.sync.initializeAssets();
    }

    /**
     * @param {string[]|Set<string>} orderIds - Order IDs to lock
     * @returns {void}
     */
    lockOrders(orderIds: any) {
        if (!orderIds) return;
        const expiration = Date.now() + TIMING.LOCK_TIMEOUT_MS;
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, expiration);
        this._cleanExpiredLocks();
    }

    /**
     * @param {string[]|Set<string>} orderIds - Order IDs to unlock
     * @returns {void}
     */
    unlockOrders(orderIds: any) {
        if (!orderIds) return;
        for (const id of orderIds) if (id) this.shadowOrderIds.delete(id);
        this._cleanExpiredLocks();
    }

    /**
     * @param {string} id - Order ID
     * @returns {boolean}
     */
    isOrderLocked(id: any) {
        const expiresAt = this.shadowOrderIds.get(id);
        if (!expiresAt) return false;
        if (Date.now() > expiresAt) {
            this.shadowOrderIds.delete(id);
            return false;
        }
        return true;
    }

    _cleanExpiredLocks() {
        const now = Date.now();
        for (const [id, expiresAt] of this.shadowOrderIds) {
            if (now > expiresAt) {
                this.shadowOrderIds.delete(id);
            }
        }
    }

    _normalizeOrderUpdateOptions(options: Record<string, any> = {}) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('Order update options must be an object');
        }

        return {
            skipAccounting: options.skipAccounting === true,
            fee: Number.isFinite(Number(options.fee)) ? Number(options.fee) : 0
        };
    }

    _normalizeCommitOptions(options: Record<string, any> = {}) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('Commit options must be an object');
        }
        return {
            skipRecalc: options.skipRecalc === true,
            // Set by the COW refill hold: the boundary passed to this commit is
            // the COMMITTED value, not the plan's target, so nothing was
            // derived into it and owed fill crawls must survive (see the
            // pending-crawl bookkeeping in _commitWorkingGrid).
            boundaryHeld: options.boundaryHeld === true
        };
    }

    async _updateOrder(order: any, context: any = 'updateOrder', options: any = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        return await this._gridLock.acquire(async () => {
            return await this._applyOrderUpdate(order, context, updateOptions);
        });
    }

    async _applyOrderUpdate(order: any, context: any = 'updateOrder', options: any = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        const { skipAccounting, fee: normalizedFee } = updateOptions;
        const oldOrder = this.orders.get(order.id);
        const validation = validateOrder(order, oldOrder, context);

        for (const warning of validation.warnings) {
            this.logger.log(warning.message, 'warn');
        }

        if (!validation.isValid && validation.errors.length > 0) {
            const fatalError = validation.errors.find((e: any) => (e as any).isFatal || e.code === 'ILLEGAL_SPREAD_STATE');
            if (fatalError) {
                this.logger.log(fatalError.message, 'error');
                this._lastIllegalState = {
                    id: order.id,
                    context,
                    message: fatalError.message,
                };
                if (this._throwOnIllegalState) {
                    const err: any = new Error(fatalError.message);
                    err.code = fatalError.code;
                    throw err;
                }
                return false;
            }
        }

        // Ensure a mutable copy before passing to updateOptimisticFreeBalance.
        // validation.normalizedOrder may reference a frozen master-grid order,
        // and _resolveBtsFeeLifecycle mutates btsFeeState on the order object.
        let nextOrder = { ...validation.normalizedOrder };

        // Apply phantom order auto-correction to the normalized order
        const phantomError = validation.errors.find((e: any) => e.code === 'PHANTOM_ORDER');
        let accountingSkip = skipAccounting;
        if (phantomError && (phantomError as any).autoCorrect) {
            nextOrder = { ...nextOrder, ...(phantomError as any).autoCorrect };
            // Phantom orders never had funds committed on-chain (no orderId).
            // The auto-correction transitions ACTIVE/PARTIAL → VIRTUAL which
            // updateOptimisticFreeBalance would treat as capital release,
            // inflating accountTotals.  Skip capital commitment accounting.
            accountingSkip = true;
        }

        if (this.accountant) {
            await this.accountant.updateOptimisticFreeBalance(oldOrder, nextOrder, context, normalizedFee, accountingSkip);
        }

        const updatedOrder = deepFreeze({ ...nextOrder });
        const id = order.id;

        // Track when an orderId is first assigned to a slot. A freshly assigned
        // orderId (create/adopt broadcast still in flight, or not yet visible to
        // a lagging/truncated chain read) must not be treated as "absent from
        // chain" by phantom cleanup — that would virtualize a real live order
        // and re-create a duplicate. Absence decisions defer while the stamp is
        // younger than SYNC_LOCK_TIMEOUT_MS.
        if (updatedOrder.orderId && (!oldOrder?.orderId || oldOrder.orderId !== updatedOrder.orderId)) {
            // Prune stamps older than the guard window — they can never be
            // consulted again (the consumer defers only while the stamp is
            // younger than SYNC_LOCK_TIMEOUT_MS), so keeping them would leak one
            // entry per orderId on a perpetual-turnover bot.
            for (const [orderId, assignedAt] of this._orderIdAssignedAt) {
                if (Date.now() - assignedAt >= TIMING.SYNC_LOCK_TIMEOUT_MS) {
                    this._orderIdAssignedAt.delete(orderId);
                }
            }
            this._orderIdAssignedAt.set(updatedOrder.orderId, Date.now());
        }

        const newMap = cloneMap(this.orders);
        newMap.set(id, updatedOrder);
        this.orders = Object.freeze(newMap);
        this._gridVersion++;

        this._syncWorkingGridFromMasterMutation(id, context);

        if (this._pauseFundRecalc === 0) {
            await this.recalculateFunds();
        }

        this._markGridDirty();

        return true;
    }

    /**
     * Backward-compatible accessor for _currentWorkingGrid.
     * Returns the top of the working grid stack (null if empty).
     */
    get _currentWorkingGrid(): any {
        return this._peekWorkingGrid();
    }

    set _currentWorkingGrid(val: any) {
        if (val !== null) {
            this._currentWorkingGridStack.push(val);
        }
    }

    _peekWorkingGrid(): any {
        const stack = this._currentWorkingGridStack;
        return stack.length > 0 ? stack[stack.length - 1] : null;
    }

    _syncWorkingGridFromMasterMutation(orderId: any, context: any) {
        const wg = this._peekWorkingGrid();
        if (!wg || !this.isPlanningActive()) {
            return;
        }

        try {
            wg.markStale(
                `master mutation during ${(this._rebalanceState || '').toLowerCase()} (${context})`
            );
            wg.syncFromMaster(this.orders, orderId, this._gridVersion);
        } catch (syncErr: any) {
            wg.markStale(`working-grid sync failure: ${getErrorMessage(syncErr)}`);
            this.logger.log(`[COW] Failed to sync working grid for order ${orderId}: ${getErrorMessage(syncErr)}`, 'warn');
        }
    }

    /**
     * @param {Array<import('./types').Order>} updates - Order updates to apply
     * @param {string} [context] - Update context label
     * @param {any} [options]
     * @returns {Promise<boolean>}
     */
    async applyGridUpdateBatch(updates: any, context: any = 'batch-update', options: any = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        return await this._gridLock.acquire(async () => {
            let allOk = true;
            for (const update of updates) {
                const ok = await this._applyOrderUpdate(update, context, updateOptions);
                if (ok === false) {
                    allOk = false;
                    // Stop on first fatal error (ILLEGAL_SPREAD_STATE).
                    // Remaining valid updates will be reconciled on the
                    // next sync cycle — safer than applying mutations on
                    // top of an inconsistent grid state.
                    break;
                }
            }
            return allOk;
        });
    }

    /**
     * Flag the in-memory master grid as dirty so the next flushGridDirty()
     * call persists it. Internal helper — every successful _applyOrderUpdate
     * call ends with this. External callers that mutate the grid through
     * other paths (e.g. raw `this.orders.set(...)` from a refactor) should
     * invoke this explicitly so the dirty-flag invariant still holds.
     *
     * @returns {void}
     */
    _markGridDirty() {
        if (this._gridDirtyAt == null) {
            this._gridDirtyAt = Date.now();
        }
    }

    /**
     * Clear the dirty flag after a successful flush. Internal helper.
     * @returns {void}
     */
    _clearGridDirty() {
        this._gridDirtyAt = null;
    }

    /**
     * Public read-only access to the dirty flag. Used by tick-end safety
     * nets and by tests/CI to verify the persistence invariant.
     * @returns {boolean}
     */
    isGridDirty() {
        return this._gridDirtyAt !== null;
    }

    /**
     * If the master grid has been mutated since the last successful
     * persistGrid() call, persist it now. This is the end-of-tick safety
     * net that catches direct _updateOrder() calls (e.g. partial-fill size
     * updates) that never reach a COW rebalance and therefore never reach
     * a known persistGrid() site.
     *
     * Idempotent: a no-op when the grid is not dirty. Honours
     * suspendGridPersistence(). Returns the underlying persistGrid()
     * result, or {skipped:true, reason:'not-dirty'} when the grid is clean.
     *
     * @param {string} [contextLabel='flush-grid-dirty'] - Label for logs
     * @returns {Promise<{skipped?: boolean, suspended?: boolean, isValid?: boolean, reason?: string}>}
     */
    async flushGridDirty(contextLabel: any = 'flush-grid-dirty') {
        if (this._gridDirtyAt == null) {
            return { skipped: true, reason: 'not-dirty' };
        }
        if (this._gridPersistenceSuspendedReason) {
            this.logger?.log?.(
                `[PERSISTENCE-FLUSH] Skipping dirty-flush while suspended: ${this._gridPersistenceSuspendedReason}`,
                'warn'
            );
            return { skipped: true, suspended: true, reason: this._gridPersistenceSuspendedReason };
        }
        const result = await this.persistGrid(undefined);
        if (result && (result as any).skipped === true) {
            // Persistence was deferred (suspension, validation, etc.) — keep
            // the dirty flag so a later tick can retry.
            return result;
        }
        if (result && result.isValid === false) {
            this.logger?.log?.(
                `[PERSISTENCE-FLUSH] Dirty flush validation failed (${contextLabel}): ${result.reason || 'unknown'}`,
                'warn'
            );
            return result;
        }
        this._clearGridDirty();
        this.logger?.log?.(
            `[PERSISTENCE-FLUSH] Flushed dirty grid via ${contextLabel}`,
            'info'
        );
        return result || { isValid: true };
    }

    /**
     * @param {Array<import('./types').Order>} orders - Filled orders
     * @param {Set<string>} [excl] - Order IDs to exclude
     * @param {Object} [options]
     * @returns {Promise<any>}
     */
    async processFilledOrders(orders: any, excl: any, options: any = {}) {
        // Step 1: Handle Fills (Accounting & State Updates)
        await this.strategy.processFillsOnly(orders, excl);

        // Step 2: Trigger Safe Rebalance only for actual fills.
        const triggerFills = orders.filter((f: any) => !f.isPartial || f.isDelayedRotationTrigger);
        const shouldRebalance = triggerFills.length > 0;

        if (shouldRebalance) {
            // deferIfBroadcasting: fill processing runs under
            // _fillProcessingLock, and _awaitBroadcastIdle can sleep 30s —
            // beyond the lock's 20s acquisition timeout. Defer the rebalance
            // instead of waiting in-lock; processFillsOnly already recorded
            // the boundary crawls, so a later derivation applies them. The
            // region-end hook schedules the deferred rebalance.
            const rebalanceResult = await this.performSafeRebalance(orders, excl, {
                ...(options || {}),
                deferIfBroadcasting: true
            });
            // Carry the fill set + exclusions on the result so the COW batch
            // executor can re-plan once from fresh master if the plan goes
            // stale between planning and broadcast.
            rebalanceResult.fills = orders;
            rebalanceResult.excludeIds = excl || new Set();
            return rebalanceResult;
        }

        const workingGrid = new WorkingGrid(this.orders, { baseVersion: this._gridVersion });
        return { 
            actions: [], 
            stateUpdates: [], 
            hadRotation: false,
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: this.boundaryIdx,
            aborted: false
        };
    }

    /**
     * @returns {Array<import('./types').Order>}
     */
    getInitialOrdersToActivate() {
        // Apply activeOrders limit from config
        const sellCount = Math.max(0, toFiniteNumber(this.config.activeOrders?.sell, 1));
        const buyCount = Math.max(0, toFiniteNumber(this.config.activeOrders?.buy, 1));

        // Get minimum sizes for validation
        const minOrderSizeFactor = this.config?.gridLimits?.MIN_ORDER_SIZE_FACTOR;
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, this.assets, minOrderSizeFactor);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, this.assets, minOrderSizeFactor);

        // Use integer arithmetic for size comparisons to match blockchain behavior
        const sellPrecision = this.assets?.assetA?.precision;
        const buyPrecision = this.assets?.assetB?.precision;
        const minSellSizeInt = floatToBlockchainInt(minSellSize, sellPrecision);
        const minBuySizeInt = floatToBlockchainInt(minBuySize, buyPrecision);

        // Rail membership by geometry (shared isSlotInRail), mirroring the
        // reconcile pickers (_pickVirtualSlotsToActivate / _pickEdgeReserveSlots).
        // A freshly generated grid's roles never need this, but the gate keeps
        // the startup placement path and the runtime activation path from
        // diverging: a slot whose stored type is stale relative to the current
        // boundary must not be placed on the wrong rail.
        const resolved = resolveGapBand(this);
        const inRailFor = (type: any, o: any): boolean =>
            isSlotInRail(resolved.boundaryIdx, resolved.gapSlots, type, o);

        // Get closest virtual sells (lowest prices first = closest to market),
        // selecting up to sellCount orders that pass the minimum-size filter.
        // Scan the full sorted rail instead of slicing first so sub-min slots
        // don't consume activation budget (mirrors _pickVirtualSlotsToActivate).
        const sellsClosestFirst = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL)
            .filter((o: any) => inRailFor(ORDER_TYPES.SELL, o))
            .filter((o: any) => parseSlotIndex(o?.id) !== null)
            .sort((a: any, b: any) => a.price - b.price);
        const validSells: any[] = [];
        for (const o of sellsClosestFirst) {
            if (validSells.length >= sellCount) break;
            if (floatToBlockchainInt(o.size, sellPrecision) >= minSellSizeInt) {
                validSells.push(o);
            }
        }
        // Reverse for placement order (highest first)
        validSells.sort((a: any, b: any) => b.price - a.price);

        // Get closest virtual buys (highest prices first = closest to market),
        // selecting up to buyCount orders that pass the minimum-size filter.
        const buysClosestFirst = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL)
            .filter((o: any) => inRailFor(ORDER_TYPES.BUY, o))
            .filter((o: any) => parseSlotIndex(o?.id) !== null)
            .sort((a: any, b: any) => b.price - a.price);
        const validBuys: any[] = [];
        for (const o of buysClosestFirst) {
            if (validBuys.length >= buyCount) break;
            if (floatToBlockchainInt(o.size, buyPrecision) >= minBuySizeInt) {
                validBuys.push(o);
            }
        }
        // Reverse for placement order (lowest first)
        validBuys.sort((a: any, b: any) => a.price - b.price);

        // Reserve ladder: edge-pinned orders activate alongside the window
        // without consuming its budget. Buys pin at the floor (lowest first),
        // sells at the ceiling (highest first). Same min-size gate as the window.
        const pickEdgeReserves = (orderType: any, count: any, windowed: any[], precision: any, minSizeInt: any, ascending: any): any[] => {
            const picked: any[] = [];
            if (count <= 0) return picked;
            const windowedIds = new Set(windowed.map((o: any) => o.id));
            // Both edges anchor at the live grid's own edge (ladder/rail extreme).
            const edgeAnchor = resolveLiveReserveEdgeAnchorPrice(this, ascending ? 'buy' : 'sell');
            const edge = ascending ? 'floor' : 'ceiling';
            const edgeFirst = this.getOrdersByTypeAndState(orderType, ORDER_STATES.VIRTUAL)
                .filter((o: any) => inRailFor(orderType, o))
                .filter((o: any) => parseSlotIndex(o.id) !== null)
                .sort((a: any, b: any) => compareReserveEdge(a, b, edge, edgeAnchor));
            for (const o of edgeFirst) {
                if (picked.length >= count) break;
                if (windowedIds.has(o.id)) continue;
                if (floatToBlockchainInt(o.size, precision) >= minSizeInt) {
                    picked.push(o);
                    windowedIds.add(o.id);
                }
            }
            picked.sort((a: any, b: any) => ascending ? a.price - b.price : b.price - a.price);
            return picked;
        };
        const reserveBuys = pickEdgeReserves(ORDER_TYPES.BUY, resolveReserveCount(this.config, 'buy'), validBuys, buyPrecision, minBuySizeInt, true);
        const reserveSells = pickEdgeReserves(ORDER_TYPES.SELL, resolveReserveCount(this.config, 'sell'), validSells, sellPrecision, minSellSizeInt, false);

        return [...validSells, ...reserveSells, ...validBuys, ...reserveBuys];
    }

    /**
     * Get orders matching the specified type and state.
     * 
     * @param {string|null} type - Order type (ORDER_TYPES.BUY/SELL/SPREAD) or null for all types
     * @param {string} state - Order state (ORDER_STATES.ACTIVE/PARTIAL/VIRTUAL)
     * @returns {Array} Array of matching orders
     */
    getOrdersByTypeAndState(type: any, state: any) {
        const result: any[] = [];
        const ids = this._ordersByState[state];
        if (!ids) return result;
        for (const id of ids) {
            const order = this.orders.get(id);
            // If type is null/undefined, return all orders with matching state
            // Otherwise, filter by both type and state
            if (order && order.state === state && (type == null || order.type === type)) {
                result.push(order);
            }
        }
        return result;
    }

    /**
     * Write boundaryIdx under COW-commit-only discipline.
     *
     * Must only be called from within _commitWorkingGrid (which holds _gridLock).
     * If called outside the commit path, logs a warning — the write still proceeds
     * so a misbehaving caller doesn't silently lose the update, but the warning
     * flags a violation of the COW boundary-write invariant.
     */
    _setBoundary(newIdx: number): void {
        if (!this._gridLock?.isReentrant()) {
            this.logger?.log?.(
                `[COW] _setBoundary called outside _gridLock (boundary ${this.boundaryIdx} → ${newIdx}). ` +
                `Boundary writes should only happen inside _commitWorkingGrid.`,
                'warn'
            );
        }
        this.boundaryIdx = newIdx;
        this._logBoundaryDebug('set', newIdx);
    }

    /**
     * Restore boundaryIdx outside the COW commit path (startup, recovery,
     * disk-load).  This is the same write as _setBoundary but without the
     * lock-hold warning — loadGrid / initializeGrid are single-threaded at
     * startup and the boundary is being restored from a known-good snapshot,
     * not committed alongside order mutations. Accepts null to clear the
     * boundary after a rejected persisted snapshot (P4) so re-derivation
     * (P3) starts from a clean state.
     */
    _restoreBoundary(newIdx: number | null): void {
        this.boundaryIdx = newIdx;
        this._logBoundaryDebug('restore', newIdx);
    }

    /**
     * Drop owed fill-crawl records (boundary bookkeeping).
     *
     * Records are pushed per shift-eligible fill at intake and consumed when a
     * derivation commits them. They must be dropped only when the crawl they
     * encode has been applied — an accepted commit that used the PLAN's target
     * boundary (or an absolute fill anchor that subsumes every owed delta).
     * A held boundary (refill guard skip), a gate-rejected boundary, and a
     * null boundary all leave the records owed, so they are not dropped there.
     *
     * Also used when the boundary is (re)anchored outside the fill path (grid
     * reset / recenter / rejected-snapshot rebuild): those records belong to
     * the previous generation, and applying their relative deltas onto a fresh
     * anchor would double-count movement the anchor already contains.
     *
     * Marks the grid dirty so the cleared array reaches disk even on paths
     * that do not otherwise persist.
     *
     * @param {string} reason - Log/debug label for the drop
     */
    _clearPendingFillCrawls(reason: any = 'unspecified'): void {
        if (!Array.isArray(this._pendingFillCrawls) || this._pendingFillCrawls.length === 0) return;
        const count = this._pendingFillCrawls.length;
        this._pendingFillCrawls = [];
        this._markGridDirty();
        this.logger?.log?.(`[BOUNDARY] Dropped ${count} owed fill crawl(s) (${reason})`, 'debug');
    }

    /**
     * Observability (fix #4, docs/CONSOLIDATED_ORPHAN_FIX_SUMMARY.md §2): emit the live
     * boundary whenever roles are (re)assigned, so a silent boundary crawl that
     * re-rolls slots into the wrong rail is diagnosable in real time. Debug-level
     * only; no behavioral effect.
     */
    _logBoundaryDebug(source: string, newIdx: number | null): void {
        try {
            const self: any = this;
            const boundary = newIdx == null ? self.boundaryIdx : newIdx;
            if (boundary == null) return;
            const gapSlots = typeof self._gapSlots === 'number' ? self._gapSlots : 0;
            const sellStart = boundary + 1 + gapSlots;
            const countActive = (type: any) => {
                let n = 0;
                for (const o of (self.orders?.values?.() || [])) {
                    if (o && o.type === type && o.orderId) n++;
                }
                return n;
            };
            this.logger?.log?.(
                `[BOUNDARY] ${source} boundary=${boundary} sellStart=${sellStart} gapSlots=${gapSlots} ` +
                `spreadCount=${self.currentSpreadCount ?? self.initialSpreadCount ?? '?'} ` +
                `activeBuy=${countActive(ORDER_TYPES.BUY)} activeSell=${countActive(ORDER_TYPES.SELL)}`,
                'debug'
            );
        } catch {
            /* observability only — never throw from logging */
        }
    }

    /**
     * Record last filled price for the single-pivot guard: when armed, BOTH
     * sides are gated against the most recent fill price (BUY blocked above
     * pivot*(1-halfInc), SELL blocked below pivot*(1+halfInc); see
     * isLastFillGuardBlocked). Spread-correction bypasses. _lastFilledType is
     * purely the cold/armed discriminator (null => disabled). The per-side
     * fields are not read by the guard itself; they feed the book-seed
     * cold-check and per-side seeding in seedLastFilledPricesFromBook.
     * @param {Array} fills
     */
    recordLastFilledPrices(fills: any): void {
        if (!Array.isArray(fills) || fills.length === 0) return;
        let recorded = 0;
        let lastKind = 'unknown';
        let lastPriceSrc = 'direct';
        for (const f of fills) {
            if (!f || (f.type !== ORDER_TYPES.BUY && f.type !== ORDER_TYPES.SELL)) continue;
            let price: number | null = Number(f.price ?? f.order?.price);
            let priceSrc = 'direct';
            if (!Number.isFinite(price) || (price as number) <= 0) {
                try {
                    const slot = f.id ? (this.orders as any)?.get?.(f.id) : null;
                    price = slot ? Number((slot as any).price) : null;
                    if (Number.isFinite(price as number) && (price as number) > 0) priceSrc = 'slot-fallback';
                } catch { price = null; }
            }
            if (!Number.isFinite(price as number) || (price as number) <= 0) continue;
            this._lastFilledPrice = price as number;
            this._lastFilledType = f.type;
            if (f.type === ORDER_TYPES.BUY) this._lastFilledBuyPrice = price as number;
            else if (f.type === ORDER_TYPES.SELL) this._lastFilledSellPrice = price as number;
            this._lastFilledAt = Date.now();
            recorded++;
            lastKind = (f as any)?.isPartial === true ? 'partial' : ((f as any)?.isPartial === false ? 'full' : 'unknown');
            lastPriceSrc = priceSrc;
        }
        // One line per fill batch (chunk): the pivot mutations above are otherwise
        // silent. src records the kind of the pivot-setting fill (full vs
        // partial — partial pivots behave differently downstream) and whether
        // its price came from the fill itself or the invisible slot fallback.
        if (recorded > 0) {
            try {
                const fmt = (v: any) => (v == null || !Number.isFinite(Number(v)) ? 'none' : Format.formatPrice6(Number(v)));
                this.logger?.log?.(
                    `[FILL-PIVOT] pivot=${fmt(this._lastFilledPrice)}(${this._lastFilledType}) ` +
                    `buy=${fmt((this as any)._lastFilledBuyPrice)} sell=${fmt((this as any)._lastFilledSellPrice)} ` +
                    `n=${recorded} src=${lastKind}/${lastPriceSrc}`,
                    'info'
                );
            } catch { /* logging is best-effort */ }
        }
    }

    /**
     * Seed last-filled guard from the live book at startup. Book-derived
     * (survives restart), analogous to the deleted MarketAnchor book-seed.
     * A single-sided book arms the guard immediately; a two-sided book
     * deliberately stays cold (type null) until the first real fill, because
     * book quotes are not fills and the latest-fill side is unknowable from
     * the book alone.
     * @param {Array} chainOpenOrders - raw chain open orders (from readOpenOrdersGuarded)
     */
    seedLastFilledPricesFromBook(chainOpenOrders: any): void {
        // Already armed — silent (the guard has a live pivot).
        if (this._lastFilledPrice != null) return;
        if (this._lastFilledType != null) return;
        // Only seed when cold (no fills yet) — don't overwrite a live value.
        if (this._lastFilledBuyPrice != null && this._lastFilledSellPrice != null) return;
        if (!Array.isArray(chainOpenOrders) || chainOpenOrders.length === 0) {
            try { this.logger?.log?.(`[LAST-FILL-GUARD] Book seed skipped: no chain orders; guard remains DISABLED (cold) until the first fill`, 'warn'); } catch {}
            return;
        }
        try {
            let maxBuy: number | null = null;
            let minSell: number | null = null;
            for (const o of chainOpenOrders) {
                const parsed = parseChainOrder(o, this.assets);
                if (!parsed) continue;
                const price = Number(parsed.price);
                if (!Number.isFinite(price) || price <= 0) continue;
                if (parsed.type === ORDER_TYPES.BUY) {
                    if (maxBuy == null || price > maxBuy) maxBuy = price;
                } else if (parsed.type === ORDER_TYPES.SELL) {
                    if (minSell == null || price < minSell) minSell = price;
                }
            }
            if (maxBuy != null && this._lastFilledBuyPrice == null) this._lastFilledBuyPrice = maxBuy;
            if (minSell != null && this._lastFilledSellPrice == null) this._lastFilledSellPrice = minSell;
            if (this._lastFilledPrice == null) {
                if (maxBuy != null && minSell != null) this._lastFilledPrice = (maxBuy + minSell) / 2;
                else if (maxBuy != null) this._lastFilledPrice = maxBuy;
                else if (minSell != null) this._lastFilledPrice = minSell;
            }
            if (this._lastFilledType == null) {
                if (maxBuy != null && minSell != null) {
                    // Seed is ambiguous (no real fill yet) — leave type null so guard stays disabled until first fill
                    this._lastFilledType = null;
                } else if (maxBuy != null) this._lastFilledType = ORDER_TYPES.BUY;
                else if (minSell != null) this._lastFilledType = ORDER_TYPES.SELL;
            }
            if (maxBuy != null || minSell != null) {
                try { this.logger?.log?.(`[LAST-FILL-GUARD] Seeded from book: lastBuy=${maxBuy} lastSell=${minSell} lastPrice=${this._lastFilledPrice} lastType=${this._lastFilledType}`, 'info'); } catch {}
            }
            // A startup that ends with the guard disabled must say so: the
            // ambiguous seed (both sides present, no real fill yet) leaves
            // _lastFilledType null by design, and that hole is otherwise only
            // inferable by the absence of any log line.
            if (this._lastFilledPrice == null || this._lastFilledType == null) {
                try { this.logger?.log?.(`[LAST-FILL-GUARD] Book seed left guard DISABLED (cold): lastBuy=${maxBuy} lastSell=${minSell} lastPrice=${this._lastFilledPrice} lastType=${this._lastFilledType}; guard arms on the first fill`, 'info'); } catch {}
            }
        } catch {}
    }

    /**
     * @returns {Object|null} The consumed signal or null
     */
    consumeIllegalStateSignal() {
        const signal = this._illegalStateSignal;
        this._illegalStateSignal = null;
        return signal;
    }

    /**
     * @returns {Object|null} The consumed signal or null
     */
    consumeAccountingFailureSignal() {
        const signal = this._accountingFailureSignal;
        this._accountingFailureSignal = null;
        return signal;
    }

    /**
     * @param {Object} BitShares - BitShares API instance
     * @param {Function} batchCb - Batch callback
     * @returns {Promise<Object>}
     */
    async checkSpreadCondition(BitShares: any, batchCb: any) {
        return await checkSpreadCondition(this, BitShares, batchCb);
    }

    /**
     * @param {Function} batchCb - Batch callback
     * @returns {Promise<Object>}
     */
    async checkGridHealth(batchCb: any) {
        return await checkGridHealth(this, batchCb);
    }

    /**
     * @returns {Object} Current spread calculation
     */
    calculateCurrentSpread() {
        return calculateCurrentSpread(this);
    }

    /**
     * @returns {any}
     */
    checkFundDriftAfterFills() {
        if (!this.assets || !hasValidAccountTotals(this.accountTotals)) {
            return { isValid: true, reason: 'Skipped: missing assets or totals' };
        }
        return checkFundDrift(this.orders, this.accountTotals, this.assets, this.config?.gridLimits ?? null);
    }

    /**
     * @param {Object|number} [pipelineSignals] - Pipeline state signals or queue length
     * @returns {any}
     */
    isPipelineEmpty(pipelineSignals: number | Record<string, any> = 0) {
        const normalizedSignals: Record<string, any> = (typeof pipelineSignals === 'number')
            ? { incomingFillQueueLength: pipelineSignals }
            : (pipelineSignals || {});

        const incomingFillQueueLength = toFiniteNumber(normalizedSignals.incomingFillQueueLength);
        const shadowLocks = toFiniteNumber(normalizedSignals.shadowLocks);
        const batchInFlight = !!normalizedSignals.batchInFlight;
        const recoveryInFlight = !!normalizedSignals.recoveryInFlight;
        const broadcasting = !!normalizedSignals.broadcasting;

        this._cleanExpiredLocks();
        const reasons: string[] = [];

        // _gridSidesUpdated is cleared at the top of every maintenance tick before
        // divergence detection, so it cannot cause stale-side processing here.
        if (incomingFillQueueLength > 0) {
            reasons.push(`${incomingFillQueueLength} fills queued`);
        }
        if (this.ordersNeedingPriceCorrection.length > 0) {
            reasons.push(`${this.ordersNeedingPriceCorrection.length} corrections pending`);
        }
        if (shadowLocks > 0) {
            reasons.push(`${shadowLocks} shadow lock(s) active`);
        }
        if (batchInFlight) {
            reasons.push('batch broadcast in-flight');
        }
        if (recoveryInFlight) {
            reasons.push('recovery sync in-flight');
        }
        if (broadcasting || this.isBroadcastingActive()) {
            reasons.push('broadcasting active orders');
        }

        if (reasons.length > 0 && !this._pipelineBlockedSince) {
            this._pipelineBlockedSince = Date.now();
        } else if (reasons.length === 0) {
            this._pipelineBlockedSince = null;
        }

        return {
            isEmpty: reasons.length === 0,
            reasons
        };
    }

    /**
     * @returns {boolean} Whether stale operations were cleared
     */
    clearStalePipelineOperations() {
        if (!this._pipelineBlockedSince) return false;
        const age = Date.now() - this._pipelineBlockedSince;
        const timeoutMs = this.config?.pipelineTiming?.TIMEOUT_MS ?? PIPELINE_TIMING.TIMEOUT_MS;
        if (age < timeoutMs) return false;

        this.ordersNeedingPriceCorrection = [];
        this._pipelineBlockedSince = null;
        return true;
    }

    /**
     * @param {Map<string, import('./types').Order>} targetGrid
     * @param {number} targetBoundary
     * @returns {Object}
     */
    reconcileGrid(targetGrid: any, targetBoundary: any) {
        if (!(this._gapEvacStreaks instanceof Map)) this._gapEvacStreaks = new Map();
        return reconcileGrid(this.orders, targetGrid, targetBoundary, {
            logger: (msg: any, level: any) => this.logger.log(msg, level),
            dustThresholdPercent: this.config?.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE,
            gapSlots: this._gapSlots,
            evacStreaks: this._gapEvacStreaks,
            assets: this.assets
        });
    }

    /**
     * Phase 3 safety net — turn stuck gap-evacuation candidates (evacReady
     * from the COW reconcile streak tick) into cancel-only corrections.
     *
     * Gate chain per candidate, in order:
     *  1. Slot idx is STILL genuinely in-band under the CURRENT committed
     *     boundary/gap geometry (the plan's frozen geometry may be stale).
     *  2. Streak >= GRID_LIMITS.GAP_EVACUATION_CANCEL_THRESHOLD (warn fires
     *     one cycle earlier at GAP_EVACUATION_STREAK_THRESHOLD).
     *  3. Queued-once marker (_gapEvacCancelQueued) not set — a queued entry
     *     never re-queues until the slot resolves (leaves the band and its
     *     streak entry is dropped).
     *  4. No correction entry already exists for the same chain order.
     *  5. The live slot still exists, is on-chain, and still owns that
     *     chain order id.
     *
     * The entry uses isSurplus semantics (not bare cancelOnly): the runner
     * cancels the chain order AND settles the slot back to a spread
     * placeholder via convertToSpreadPlaceholder, keeping fund tracking
     * honest and matching Phase 2 band semantics (genuinely in-band slots
     * are SPREAD VIRTUAL). No re-placement, fee-light.
     *
     * @param {Array} candidates - evacReady candidates [{id, idx, type, price, size, orderId}]
     * @returns {number} Number of corrections queued
     */
    _processGapEvacuationTeeth(candidates: any) {
        if (!Array.isArray(candidates) || candidates.length === 0) return 0;
        if (!Array.isArray(this.ordersNeedingPriceCorrection)) return 0;
        if (!(this._gapEvacStreaks instanceof Map)) this._gapEvacStreaks = new Map();
        if (!(this._gapEvacCancelQueued instanceof Set)) this._gapEvacCancelQueued = new Set();

        // Release queued-once markers for slots that resolved (dropped from
        // the streak map) so a future return to the band can be acted on again.
        for (const id of Array.from(this._gapEvacCancelQueued)) {
            if (!this._gapEvacStreaks.has(id)) this._gapEvacCancelQueued.delete(id);
        }

        const rawThreshold = Number(GRID_LIMITS?.GAP_EVACUATION_CANCEL_THRESHOLD);
        const cancelThreshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? Math.floor(rawThreshold) : 3;
        const boundary = this.boundaryIdx;
        const gapSlots = this._gapSlots;
        let queued = 0;

        for (const candidate of candidates) {
            const slotId = candidate?.id;
            const chainOrderId = candidate?.orderId;
            if (!slotId || !chainOrderId) continue;

            // 1. Re-verify geometry against the CURRENT committed boundary.
            const idx = parseSlotIndex(slotId);
            if (idx === null || geometryTypeForSlotIndex(idx, boundary, gapSlots) !== ORDER_TYPES.SPREAD) continue;

            // 2. Act threshold (stricter than the warn threshold).
            if (Number(this._gapEvacStreaks.get(slotId) || 0) < cancelThreshold) continue;

            // 3./4. Queued-once + no duplicate chain-order entry.
            if (this._gapEvacCancelQueued.has(slotId)) continue;
            if (this.ordersNeedingPriceCorrection.some((entry: any) => entry?.chainOrderId === chainOrderId)) continue;

            // 5. Live slot check.
            const slot = this.orders.get(slotId);
            if (!slot || !isOrderOnChain(slot) || slot.orderId !== chainOrderId) continue;

            this.ordersNeedingPriceCorrection.push({
                gridOrder: { ...slot },
                chainOrderId,
                expectedPrice: slot.price,
                actualPrice: slot.price,
                size: slot.size,
                type: slot.type,
                isSurplus: true,
                gapEvacuation: true,
                boundaryIdx: boundary
            });
            this._gapEvacCancelQueued.add(slotId);
            queued++;
            this.logger?.log?.(
                `[GAP-EVAC] Queued cancel-only evacuation for ${slotId} ` +
                `(${slot.type} @${Format.formatPrice6(slot.price)}, ` +
                `x${this._gapEvacStreaks.get(slotId)} in band, boundary ${boundary}, gap ${gapSlots})`,
                'warn'
            );
        }
        return queued;
    }

    /**
     * Wait (bounded) until any non-COW broadcast/placement activity — the
     * refcounted _broadcastingFlag — has released. Startup/structural
     * reconcile Phase-2 placement now holds this flag across its create/update
     * groups; launching a fill-driven COW rebalance on top of it mutates the
     * master mid-broadcast, forcing a commit refusal and leaving a
     * previous-generation order set on chain as duplicate-price orphans
     * that block placements until drained.
     *
     * The wait is capped: after the timeout the rebalance proceeds anyway —
     * the existing commit-refusal + chain-adoption machinery remains the
     * backstop, so the worst case equals the pre-guard behavior.
     *
     * @param {number} [timeoutMs]
     * @returns {Promise<{waitedMs: number, timedOut: boolean}>}
     */
    async _awaitBroadcastIdle(timeoutMs: number = 30000): Promise<{ waitedMs: number; timedOut: boolean; shutdown: boolean }> {
        if (this._shuttingDown) {
            return { waitedMs: 0, timedOut: false, shutdown: true };
        }
        if (!this.isBroadcastingActive()) return { waitedMs: 0, timedOut: false, shutdown: false };
        const startedAt = Date.now();
        let logged = false;
        while (this.isBroadcastingActive()) {
            if (this._shuttingDown) {
                this.logger?.log?.(
                    `[SAFE-REBALANCE] Broadcast wait aborted: shutdown in progress after ${Date.now() - startedAt}ms`,
                    'warn'
                );
                return { waitedMs: Date.now() - startedAt, timedOut: false, shutdown: true };
            }
            const waited = Date.now() - startedAt;
            if (waited >= timeoutMs) {
                this.logger?.log?.(
                    `[SAFE-REBALANCE] Broadcast still active after ${waited}ms; proceeding (commit-refusal + chain adoption remains the backstop)`,
                    'warn'
                );
                return { waitedMs: waited, timedOut: true, shutdown: false };
            }
            if (!logged) {
                this.logger?.log?.(
                    '[SAFE-REBALANCE] Deferring: broadcast/placement activity active (startup/structural reconcile or another batch)',
                    'info'
                );
                logged = true;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return { waitedMs: Date.now() - startedAt, timedOut: false, shutdown: false };
    }

    /**
     * @param {Array} [fills] - Fill events triggering rebalance
     * @param {Set<string>} [excludeIds] - Order IDs to exclude
     * @param {Object} [options]
     * @param {boolean} [options.skipBroadcastWait] - Set by the COW re-plan path,
     *   which runs INSIDE its own startBroadcasting() region and must not wait
     *   on the flag it holds itself.
     * @returns {Promise<any>}
     */
    async performSafeRebalance(fills: any = [], excludeIds: any = new Set(), options: any = {}) {
        this.logger.log("[SAFE-REBALANCE] Starting with COW...", "info");
        // A fresh fill set re-enables planning and ends any held-plan
        // suppression run counted below; the next fill-less streak counts
        // from zero. Reset on entry (even for broadcast-deferred calls):
        // the fills arrived, so the identical-plan assumption is void.
        if (fills.length > 0 && (this._heldPlanSuppressionCount || 0) > 0) {
            this._heldPlanSuppressionCount = 0;
        }
        if (!options?.skipBroadcastWait) {
            // Shutdown guard applies to every path here (including the
            // deferIfBroadcasting defer path, which never reaches
            // _awaitBroadcastIdle): a rebalance must not plan/broadcast while
            // the bot is shutting down. _awaitBroadcastIdle returns
            // shutdown:true for this, so keep it explicit when skipping it.
            if (this._shuttingDown) {
                this.logger.log('[SAFE-REBALANCE] Aborting rebalance: shutdown in progress', 'warn');
                return buildAbortedResult('Shutdown in progress — safe rebalance aborted');
            }
            // Never sleep on the broadcast flag while holding
            // _fillProcessingLock (the lock's acquisition timeout is 20s; the
            // wait is 30s). A fill-driven rebalance defers instead, leaving
            // the crawls recorded by processFillsOnly for a later derivation.
            if (options?.deferIfBroadcasting && this.isBroadcastingActive()) {
                this.logger.log(
                    '[SAFE-REBALANCE] Deferred: broadcast/placement activity active; rebalance retries after the region ends',
                    'info'
                );
                this._deferredRebalanceAt = Date.now();
                return { ...buildAbortedResult('broadcast-active-deferred'), deferred: true };
            }
            // Identical-held-plan suppression: a fill-less replan whose
            // boundary, guard pivot and fill timestamp are unchanged since the
            // last hold can only reproduce the same vetoed plan (INV-COW-007).
            // Defer instead of spending another broadcast region re-deriving
            // it; a fresh fill changes _lastFilledAt and re-enables planning.
            const heldSig = this._lastHeldPlanSignature;
            if (fills.length === 0 && heldSig
                && Number(this.boundaryIdx) === Number(heldSig.boundaryIdx)
                && Number(this._lastFilledPrice) === Number(heldSig.pivot)
                && Number(this._lastFilledAt) === Number(heldSig.fillsAt)) {
                // Counted visibility: a fill-less replan is suppressed until a
                // fresh fill arrives, so a stale grid that produces no fills
                // can sit in this branch forever. The spread-correction path
                // (independent of this suppression) and the out-of-spread
                // persistence watchdog are the heal paths — surface the run
                // instead of hiding it at debug.
                this._heldPlanSuppressionCount = (Number(this._heldPlanSuppressionCount) || 0) + 1;
                const n = this._heldPlanSuppressionCount;
                this.logger.log(
                    `[SAFE-REBALANCE] Deferred: identical held plan (no new fills since last hold; suppression #${n}); a fill-driven plan will re-derive`,
                    (n === 1 || n % 10 === 0) ? 'warn' : 'debug'
                );
                return { ...buildAbortedResult('held-plan-unchanged-deferred'), deferred: true };
            }
            if (!options?.deferIfBroadcasting) {
                const idle = await this._awaitBroadcastIdle();
                if (idle.shutdown || this._shuttingDown) {
                    this.logger.log('[SAFE-REBALANCE] Aborting rebalance: shutdown in progress', 'warn');
                    return buildAbortedResult('Shutdown in progress — safe rebalance aborted');
                }
            }
        }
        return await this._gridLock.acquire(async () => {
            return await this._applySafeRebalanceCOW(fills, excludeIds);
        });
    }

    async _applySafeRebalanceCOW(fills: any = [], excludeIds: any = new Set()) {
        const cowEngine = this._getCOWEngine();
        if (!cowEngine) {
            return buildAbortedResult('COW Engine not initialized (assets not available)');
        }

        this._setRebalanceState(REBALANCE_STATES.REBALANCING);
        if (!(this._gapEvacStreaks instanceof Map)) this._gapEvacStreaks = new Map();
        if (!(this._gapEvacCancelQueued instanceof Set)) this._gapEvacCancelQueued = new Set();
        // Live reserve edge anchors, resolved once and shared with the engine's
        // refill wire so a reserve-ladder CREATE can never be classified as a
        // hole refill (which would let a skipped reserve pin the boundary).
        const reserveEdgeAnchors = {
            buy: resolveLiveReserveEdgeAnchorPrice(this, 'buy'),
            sell: resolveLiveReserveEdgeAnchorPrice(this, 'sell')
        };
        const result = await cowEngine.execute({
            masterGrid: this.orders,
            gridVersion: this._gridVersion,
            boundaryIdx: this.boundaryIdx,
            funds: this.getChainFundsSnapshot(),
            fills,
            excludeIds,
            gapSlots: this._gapSlots,
            evacStreaks: this._gapEvacStreaks,
            reserveEdgeAnchors
        });

        // Phase 3 safety net: act on stuck in-band orders regardless of the
        // plan outcome — a plan that aborted for unrelated reasons must not
        // delay the cancel-only evacuation queue. Queued-once per slot; the
        // corrections runner (correctAllPriceMismatches) executes the cancel
        // and settles the slot back to a spread placeholder.
        try {
            this._processGapEvacuationTeeth(result?.evacReady);
        } catch (gapEvacError: any) {
            this.logger?.log?.(
                `[GAP-EVAC] Teeth processing failed (non-fatal): ${getErrorMessage(gapEvacError)}`,
                'warn'
            );
        }

        if (result.aborted) {
            // Nothing was pushed for an aborted result — the push below is
            // skipped — so there is no working-grid ref to clear here. Popping
            // would steal an unrelated stack entry (double-pop) when combined
            // with the caller-side no-action handling in _executeBatchIfNeeded.
            return result;
        }

        this._pushWorkingGridRef(result.workingGrid, result);
        return result;
    }

    _getCowComparePrecisions() {
        const buyPrecisionRaw = this.assets?.assetB?.precision;
        const sellPrecisionRaw = this.assets?.assetA?.precision;
        const incrementPercentRaw = this.config?.incrementPercent;
        const buyPrecision = Number(buyPrecisionRaw);
        const sellPrecision = Number(sellPrecisionRaw);
        const incrementPercent = Number(incrementPercentRaw);

        if (!Number.isFinite(buyPrecision) || !Number.isFinite(sellPrecision)) {
            throw new Error(
                `CRITICAL: Missing asset precision for COW compare (buy=${buyPrecisionRaw}, sell=${sellPrecisionRaw}). ` +
                `Refusing commit-time delta comparison.`
            );
        }

        if (!Number.isFinite(incrementPercent) || incrementPercent <= 0) {
            throw new Error(
                `CRITICAL: Missing/invalid incrementPercent for COW compare (${incrementPercentRaw}). ` +
                `Refusing commit-time delta comparison.`
            );
        }

        // Relative price threshold = 1/10 of one configured increment step.
        // Example: incrementPercent=0.5 -> relative tolerance ratio=0.0005 (0.05%).
        const priceRelativeTolerance = incrementPercent / 1000;

        return {
            buyPrecision,
            sellPrecision,
            priceRelativeTolerance
        };
    }

    async _commitWorkingGrid(workingGrid: any, _workingIndexes: any, workingBoundary: any, options: any = {}) {
        const startTime = Date.now();
        let committed = false;
        let comparePrecisions: any;
        let skipRecalc = false;
        // Exactly-once stack-release contract: every settle path (return or
        // throw) releases the working-grid stack entry exactly one time via
        // _releaseWorkingGridRef (identity-checked, so plan-path grids that
        // were never pushed leave the stack untouched). When the caller passes
        // its result object (options.result), the push marker is cleared too —
        // the batch executor's catch block then cannot pop a second time for
        // the same grid.
        let popped = false;
        const releaseStackEntry = () => {
            if (popped) return;
            popped = true;
            this._releaseWorkingGridRef(workingGrid);
            if (options?.result) {
                options.result._workingGridPushed = false;
            }
        };

        try {
            const { skipRecalc: skipRecalcOpt, boundaryHeld } = this._normalizeCommitOptions(options);
            skipRecalc = skipRecalcOpt;
            const stats = workingGrid.getMemoryStats();

            try {
                comparePrecisions = this._getCowComparePrecisions();
            } catch (precisionErr: any) {
                this.logger.log(`[COW] ${getErrorMessage(precisionErr)}`, 'error');
                releaseStackEntry();
                return false;
            }

            const preCommitGuard = evaluateCommit(workingGrid, {
                hasLock: false,
                currentVersion: this._gridVersion,
                masterGrid: this.orders,
                comparePrecisions
            });
            if (!preCommitGuard.canCommit) {
                this.logger.log(`[COW] ${preCommitGuard.reason}`, preCommitGuard.level || 'warn');
                releaseStackEntry();
                return false;
            }

            await this._gridLock.acquire(async () => {
                const lockCommitGuard = evaluateCommit(workingGrid, {
                    hasLock: true,
                    currentVersion: this._gridVersion,
                    masterGrid: this.orders,
                    comparePrecisions
                });
                if (!lockCommitGuard.canCommit) {
                    this.logger.log(`[COW] ${lockCommitGuard.reason}`, lockCommitGuard.level || 'warn');
                    // Working grid ref is cleared exactly once below via the
                    // !committed path (the callback returns without committing).
                    return;
                }

                this.logger.log(
                    `[COW] Committing working grid: ${stats.size} orders, ${stats.modified} modified`,
                    'debug'
                );

                const finalMap = workingGrid.toMap();

                // BOUNDARY COMMIT GATE (fix: self-referential gap geometry).
                // resolveGapBand() re-derives sellStartIdx from whatever value
                // lands in boundaryIdx, so an overrun boundary legalizes itself
                // on the next cycle.  Validate the proposed boundary against
                // the NEW grid state (price-sorted, placed-order aware) before
                // it becomes permanent.  On rejection the grid still commits —
                // the orders may already be live on-chain and must stay
                // tracked — but the previous (last-known-valid) boundary is
                // kept so classification never inherits the overrun.
                const commitGapSlots = resolveGapSlots(this);
                const boundaryCheck = validateBoundaryCommit(workingBoundary, finalMap.values(), commitGapSlots);
                let commitBoundary = workingBoundary;
                if (!boundaryCheck.ok) {
                    this.logger.log(
                        `[COW] Boundary commit rejected (${boundaryCheck.reason}): ${boundaryCheck.detail}. ` +
                        `Keeping previous boundary ${this.boundaryIdx}.`,
                        'error'
                    );
                    commitBoundary = this.boundaryIdx;
                }

                // RC-4: Deep-freeze all modified orders before committing to master state
                // Ensures COW immutability invariants are maintained for all grid entries.
                for (const [, order] of finalMap.entries()) {
                    if (order && !Object.isFrozen(order)) {
                        deepFreeze(order);
                    }
                }

                this.orders = Object.freeze(finalMap);
                this._setBoundary(commitBoundary);
                // Pending-crawl bookkeeping: an accepted non-null commit
                // incorporates (incremental derivation) or subsumes (absolute
                // recovery anchor) every fill recorded so far, so all pending
                // crawl entries are consumed here. A gate-rejected commit keeps
                // the previous boundary — nothing was derived into it — so
                // pending entries survive for the next derivation. A null
                // commit likewise consumes nothing, and neither does a HELD
                // boundary (boundaryHeld): the refill hold deliberately keeps
                // the committed boundary over the plan's target, so the shift
                // those records encode was never applied and must stay owed —
                // clearing here lost the crawl permanently (no fill evidence
                // left for the next derivation, holes refilled same-side).
                if (boundaryCheck.ok && commitBoundary !== null && commitBoundary !== undefined
                    && boundaryHeld !== true) {
                    this._clearPendingFillCrawls('boundary commit');
                }
                this._gridVersion++;
                committed = true;

                // Track orderIds from successful COW commits for recovery sync protection.
                // Build a new set from the committed finalMap and atomically swap to
                // avoid the intermediate empty state that clear() creates — a crash
                // during clear()+repopulate would lose all committed IDs.
                const newCommittedIds = new Set<string>();
                for (const [, order] of finalMap.entries()) {
                    if (order.orderId) newCommittedIds.add(order.orderId);
                }
                this._committedOrderIds = newCommittedIds;
                this._committedOrderIdsBuiltAt = Date.now();

                // Index caches invalidated by _gridVersion bump above — lazy getters recompute from this.orders
            });

            if (!committed) {
                releaseStackEntry();
                return false;
            }

            try {
                if (!skipRecalc) {
                    // If the last accounting failure was due to stale accountTotals,
                    // the commit proceeded without locking funds. Refresh accountTotals
                    // before recalculateFunds() to avoid a false-positive drift recovery.
                    if (this._lastAccountingFailure?.reason === 'stale') {
                        this.logger.log(
                            '[COW] Stale accountTotals during commit; refreshing before recalculateFunds to avoid false recovery',
                            'warn'
                        );
                        await this.fetchAccountTotals(this.accountId);
                    }
                    await this.recalculateFunds();
                }
                const duration = Date.now() - startTime;
                this.logger.log(`[COW] Grid committed in ${duration}ms`, 'debug');

                if (stats.size > COW_PERFORMANCE.GRID_MEMORY_WARNING) {
                    this.logger.log(
                        `[COW] Warning: Large grid size (${stats.size} orders). Peak memory: ~${Math.round(stats.estimatedBytes / 1024)}KB`,
                        'warn'
                    );
                }
            } catch (recalcErr: any) {
                this.logger.log(`[COW] Fund recalculation failed post-commit: ${getErrorMessage(recalcErr)}`, 'error');
                this._recoveryState = { ...this._recoveryState, lastFailureAt: Date.now() };
                // Re-throw to signal callers that the commit is incomplete
                // (grid state committed, but fund state is stale).
                releaseStackEntry();
                throw recalcErr;
            }

            releaseStackEntry();
            return true;
        } catch (err: any) {
            // Unhandled commit failure (e.g. _gridLock acquisition timeout or
            // an in-lock commit error): nothing was committed, but the stack
            // entry must still be released exactly once.
            releaseStackEntry();
            throw err;
        }
    }

    /**
     * @param {Object} [options]
     * @param {boolean} [options.allowBootstrapTransient]
     * @returns {any}
     */
    validateGridStateForPersistence(options: Record<string, any> = {}) {
        const result = validateGridForPersistence(this.orders, this.accountTotals);
        const allowBootstrapTransient = options.allowBootstrapTransient !== false;

        if (!result.isValid && allowBootstrapTransient && this._bootstrapping) {
            this.logger.log(`[BOOTSTRAP] Transient state (expected): ${result.reason}`, 'debug');
            return { isValid: true, reason: null };
        }

        return result;
    }

    /**
     * @param {string} [reason]
     * @returns {void}
     */
    suspendGridPersistence(reason: any = 'suspended') {
        this._gridPersistenceSuspendedReason = reason;
    }

    /**
     * @param {string} [reason]
     * @returns {void}
     */
    resumeGridPersistence(reason: any = null) {
        if (!this._gridPersistenceSuspendedReason) return;
        this.logger.log(
            `[PERSISTENCE-GATE] Resuming grid persistence${reason ? ` (${reason})` : ''}`,
            'info'
        );
        this._gridPersistenceSuspendedReason = null;
    }

    /**
     * @param {Array<Object>} [snapshotOrders] - Optional explicit orders to persist.
     *   When provided, this list is persisted as-is and the live `manager.orders`
     *   map is not touched. This is the only race-free way to persist a freshly
     *   built grid (e.g. from the startup `storeGrid` callback) without briefly
     *   swapping the live map and exposing it to concurrent readers.
     * @returns {Promise<any>}
     */
    async persistGrid(snapshotOrders: any, recentFillKeys?: any, fundSnapshot?: { btsFeesOwed: number; accountTotals: any }) {
        if (this._gridPersistenceSuspendedReason) {
            this.logger.log(
                `[PERSISTENCE-GATE] Skipping grid persistence while suspended: ${this._gridPersistenceSuspendedReason}`,
                'warn'
            );
            return { isValid: true, skipped: true, suspended: true, reason: this._gridPersistenceSuspendedReason };
        }

        const validation = this.validateGridStateForPersistence();
        if (!validation.isValid) {
            this.logger.log(
                `[PERSISTENCE-GATE] Skipping persistence of corrupted state: ${validation.reason}`,
                'warn'
            );
            return validation;
        }

        // Capture fund state under _fundLock so the persisted snapshot is
        // internally consistent even when fills/fee settlement mutate
        // accountTotals concurrently (same TOCTOU fixed for recalculateGrid
        // at grid.ts:~1047). An explicit fundSnapshot (recalculateGrid) is
        // kept as an override — the caller captured it under the same lock
        // right after resetFunds.
        let effectiveFundSnapshot = fundSnapshot;
        if (!effectiveFundSnapshot) {
            effectiveFundSnapshot = await this._fundLock.acquire(async () => ({
                btsFeesOwed: this.funds.btsFeesOwed,
                accountTotals: this.accountTotals,
            }));
        }

        const persisted = await persistGridSnapshot(this, this.accountOrders, snapshotOrders, recentFillKeys, effectiveFundSnapshot);

        if (persisted === false) {
            this.logger.log(
                `[PERSIST] Grid persistence FAILED (disk full / permissions / write error)`,
                'error'
            );
            // Keep the dirty flag set so the next flush retries.
            return { isValid: false, reason: 'persistence write failed', skipped: false, suspended: false };
        }

        // On a successful live-grid persist (the default — no explicit
        // snapshotOrders was passed in), clear the dirty flag so that
        // a subsequent end-of-tick flushGridDirty() call sees the grid
        // as clean and skips the second snapshot write. When the caller
        // passes an explicit snapshotOrders (e.g. from the startup
        // storeGrid callback), the dirty flag is for the LIVE grid, not
        // the supplied snapshot, so we leave it alone.
        if (snapshotOrders === undefined && this._gridDirtyAt != null) {
            this._clearGridDirty();
        }

        return validation;
    }

    get _lastIllegalState() {
        return this._illegalStateSignal || null;
    }

    set _lastIllegalState(value) {
        if (value) {
            this._illegalStateSignal = {
                ...value,
                at: Date.now()
            };
        }
    }

    get _lastAccountingFailure() {
        return this._accountingFailureSignal || null;
    }

    set _lastAccountingFailure(value) {
        if (value) {
            this._accountingFailureSignal = {
                ...value,
                at: Date.now()
            };
        }
    }

    get _recoveryState() {
        return this._recoveryStateValue;
    }

    set _recoveryState(value) {
        const fallback = {
            phase: 'idle',
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0,
            structuralResyncRequested: false
        };
        this._recoveryStateValue = {
            ...fallback,
            ...(value && typeof value === 'object' ? value : {})
        };
    }

    get _gridRegenState() {
        return this._gridRegenStateValue;
    }

    set _gridRegenState(value) {
        if (!value || typeof value !== 'object') return;

        const defaultSide = { armed: true, lastTriggeredAt: 0 };
        this._gridRegenStateValue = {
            buy: { ...defaultSide, ...(value.buy || {}) },
            sell: { ...defaultSide, ...(value.sell || {}) }
        };
    }

}

export { OrderManager, COWRebalanceEngine }


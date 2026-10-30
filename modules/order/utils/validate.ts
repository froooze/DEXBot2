/**
 * modules/order/utils/validate.ts
 *
 * Pure functions for order validation, grid reconciliation, and immutable mutations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS
 * ===============================================================================
 *
 * SECTION 1: EXTERNAL DEPENDENCIES
 *
 * SECTION 2: VALIDATION
 *   - validateOrder()
 *   - validateGridForPersistence()
 *   - calculateRequiredFunds() (internal)
 *   - validateWorkingGridFunds()
 *   - checkFundDrift()
 *
 * SECTION 3: GRID RECONCILIATION (COW Pipeline)
 *   - reconcileGrid()
 *   - optimizeRebalanceActions()
 *   - summarizeActions() (internal)
 *   - hasExecutableActions()
 *   - validateCreateTargetSlots()
 *   - stampGapEvacuationRotation()
 *   - hasActionForOrder()
 *   - removeActionsForOrder()
 *   - projectTargetToWorkingGrid()
 *   - buildStateUpdates()
 *   - buildAbortedResult()
 *   - buildSuccessResult()
 *   - evaluateCommit()
 *
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: EXTERNAL DEPENDENCIES
// ===============================================================================


import * as Format from '../format.js';
import {
    ORDER_STATES,
    ORDER_TYPES,
    COW_ACTIONS,
    COW_ORIGINS,
    GRID_LIMITS
} from '../../constants.js';
import {
    floatToBlockchainInt,
    blockchainToFloat,
    getPrecisionSlack,
    getPrecisionByOrderType,
    getDoubleDustThreshold,
    getSellStartIdx,
    isSlotIndexInGapBand,
    isEvacuationRotationAllowed,
    clamp,
    pricesOnSameLevel,
    sameGridPrice
} from './math.js';
import { parseSlotIndex } from './slot.js';
import {
    isOrderOnChain,
    isPhantomOrder,
    convertToSpreadPlaceholder,
    detectGapEvacuationCandidates,
    updateGapEvacuationStreaks,
    isNonBlockingUnmatchedOrder
} from './order.js';
const { isValidNumber, toFiniteNumber } = Format;
import type { ManagedOrder, AccountTotals, AssetPair, GridLimitsLike, LogFn, ValidationIssue, FundShortfall, CowAction, CreateTargetViolation, FundPrecisions, ProjectedFunds, UnmatchedChainOrder } from '../../types.js';
import type { WorkingGrid } from '../working_grid.js';

interface ReconcileGridOptions {
    logger?: LogFn | null;
    dustThresholdPercent?: number;
    gapSlots?: number;
    assets?: AssetPair | null;
    genesis?: unknown;
    evacStreaks?: Map<string, number>;
    [key: string]: unknown;
}

interface OptimizeActionsOptions {
    logger?: LogFn | null;
    boundaryIdx?: number;
    gapSlots?: number;
    assets?: AssetPair | null;
    [key: string]: unknown;
}

interface ProjectTargetOptions {
    actions?: CowAction[];
    [key: string]: unknown;
}

interface EvaluateCommitOptions {
    hasLock?: boolean;
    currentVersion?: number;
    masterGrid?: Map<string, ManagedOrder> | null;
    comparePrecisions?: Record<string, number> | null;
    [key: string]: unknown;
}

interface SurplusEntry { id: string; master: ManagedOrder; target: ManagedOrder; }
interface HoleEntry { id: string; order: ManagedOrder; }
interface UpdateSelectors { slotIds: Set<string>; orderIds: Set<string>; }

// Pre-computed valid sets
const VALID_ORDER_STATES = new Set(Object.values(ORDER_STATES));
const VALID_ORDER_TYPES = new Set(Object.values(ORDER_TYPES));

// ===============================================================================
// SECTION 2: VALIDATION
// ===============================================================================

/**
 * Validate a complete order object
 * @param {Object} order - Order to validate
 * @param {Object} oldOrder - Previous order state (for context)
 * @param {string} context - Operation context for error messages
 * @returns {Object} Validation result
 */
function validateOrder(order: Partial<ManagedOrder> | null | undefined, oldOrder: Partial<ManagedOrder> | null = null, context: string = 'validate') {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    const normalizedOrder: Partial<ManagedOrder> = { ...(oldOrder || {}), ...order };

    if (!order || !order.id) {
        errors.push({ code: 'MISSING_ID', message: 'Refusing to update order: missing ID' });
        return { isValid: false, errors, warnings, normalizedOrder: null };
    }

    if (!normalizedOrder.type && normalizedOrder.state === ORDER_STATES.VIRTUAL) {
        const placeholderSize = toFiniteNumber(normalizedOrder.size);
        if (placeholderSize === 0) {
            normalizedOrder.type = ORDER_TYPES.SPREAD;
        }
    }

    if (normalizedOrder.state === undefined || !VALID_ORDER_STATES.has(normalizedOrder.state)) {
        errors.push({
            code: 'INVALID_STATE',
            message: `Refusing to update order ${order.id}: invalid state '${normalizedOrder.state}' (context: ${context})`
        });
    }

    if (normalizedOrder.type === undefined || !VALID_ORDER_TYPES.has(normalizedOrder.type)) {
        errors.push({
            code: 'INVALID_TYPE',
            message: `Refusing to update order ${order.id}: invalid type '${normalizedOrder.type}' (context: ${context})`
        });
    }

    if (normalizedOrder.type === ORDER_TYPES.SPREAD && toFiniteNumber(normalizedOrder.size) !== 0) {
        warnings.push({
            code: 'SPREAD_SIZE_NORMALIZED',
            message: `[INVARIANT] Normalizing SPREAD order ${order.id} size ${normalizedOrder.size} -> 0 (context: ${context})`
        });
        normalizedOrder.size = 0;
    }

    // RAIL-HOLE PRESERVATION (Phase 2): a sized BUY/SELL VIRTUAL slot with no
    // orderId is a rail-typed hole (rotation source, fill-consumed rail slot),
    // NOT a spread placeholder — it must pass through untouched. Only SPREAD
    // is size-normalized above; the phantom and ILLEGAL_SPREAD_STATE checks
    // below fire solely for on-chain states, so rail holes are never
    // zeroed, retyped, or rejected here. Locked by test_gap_evacuation.

    const isOnChainState = (
        normalizedOrder.state === ORDER_STATES.ACTIVE ||
        normalizedOrder.state === ORDER_STATES.PARTIAL
    );

    if (normalizedOrder.type === ORDER_TYPES.SPREAD && isOnChainState) {
        errors.push({
            code: 'ILLEGAL_SPREAD_STATE',
            message: `ILLEGAL STATE: Refusing to move SPREAD order ${order.id} to ${normalizedOrder.state}. SPREAD orders must remain VIRTUAL.`,
            isFatal: true
        });
    }

    if (isPhantomOrder(normalizedOrder)) {
        errors.push({
            code: 'PHANTOM_ORDER',
            message: `ILLEGAL STATE: Refusing to set order ${order.id} to ${normalizedOrder.state} without orderId. Context: ${context}. This would create a phantom order that doubles fund tracking.`,
            autoCorrect: {
                state: ORDER_STATES.VIRTUAL,
                orderId: null,
                rawOnChain: null,
                size: 0
            }
        });
    }

    if (normalizedOrder.type === ORDER_TYPES.BUY || normalizedOrder.type === ORDER_TYPES.SELL) {
        normalizedOrder.committedSide = normalizedOrder.type;
    } else if (!normalizedOrder.committedSide && oldOrder) {
        if (oldOrder.committedSide) {
            normalizedOrder.committedSide = oldOrder.committedSide;
        } else if (oldOrder.type === ORDER_TYPES.BUY || oldOrder.type === ORDER_TYPES.SELL) {
            normalizedOrder.committedSide = oldOrder.type;
        }
    }

    return {
        isValid: errors.length === 0 || !errors.some((e) => e.isFatal),
        errors,
        warnings,
        normalizedOrder
    };
}

/**
 * Validate grid state for persistence
 * @param {Map} orders - Master grid orders
 * @param {Object} accountTotals - Current account totals
 * @returns {Object} Validation result
 */
function validateGridForPersistence(orders: Map<string, ManagedOrder>, accountTotals: AccountTotals | null) {
    for (const order of orders.values()) {
        if (isPhantomOrder(order)) {
            return {
                isValid: false,
                reason: `Phantom order detected: order ${order.id} is ${order.state} but has no orderId`
            };
        }
    }

    if (!accountTotals || !isValidNumber(accountTotals.buy) || !isValidNumber(accountTotals.sell)) {
        return {
            isValid: false,
            reason: 'Account totals not initialized'
        };
    }

    return { isValid: true, reason: null };
}

/**
 * Calculate required funds from a grid
 * @param {Map|WorkingGrid} grid - Grid to analyze
 * @param {Object} precisions - Precision config
 * @returns {Object} Required funds { buyInt, sellInt, buy, sell }
 */
function calculateRequiredFunds(grid: Map<string, ManagedOrder> | WorkingGrid, precisions: FundPrecisions = {}) {
    const buyPrecision = precisions.buyPrecision;
    const sellPrecision = precisions.sellPrecision;

    let buyRequiredInt = 0;
    let sellRequiredInt = 0;

    for (const order of grid.values()) {
        const size = toFiniteNumber(order.size ?? order.amount);

        const state = order.state;
        const isActive = state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL;

        if (isActive && isOrderOnChain(order)) {
            if (order.type === ORDER_TYPES.BUY) {
                buyRequiredInt += floatToBlockchainInt(size, buyPrecision);
            } else if (order.type === ORDER_TYPES.SELL) {
                sellRequiredInt += floatToBlockchainInt(size, sellPrecision);
            }
        }
    }

    return {
        buyInt: buyRequiredInt,
        sellInt: sellRequiredInt,
        buy: blockchainToFloat(buyRequiredInt, buyPrecision),
        sell: blockchainToFloat(sellRequiredInt, sellPrecision)
    };
}

/**
 * Validate working grid against available funds
 * @param {WorkingGrid} workingGrid - Grid to validate
 * @param {Object} projectedFunds - Available funds
 * @param {Object} precisions - Asset precisions
 * @param {Object} assets - Asset metadata
 * @returns {Object} Validation result
 */
function validateWorkingGridFunds(workingGrid: Map<string, ManagedOrder> | WorkingGrid, projectedFunds: ProjectedFunds | null | undefined, precisions: FundPrecisions = {}, assets: AssetPair | null = null) {
    const buyPrecision = precisions.buyPrecision ?? assets?.assetB?.precision;
    const sellPrecision = precisions.sellPrecision ?? assets?.assetA?.precision;
    
    const required = calculateRequiredFunds(workingGrid, { buyPrecision, sellPrecision });

    const funds = projectedFunds ?? {};
    const availableBuy = isValidNumber(funds.allocatedBuy)
        ? Number(funds.allocatedBuy)
        : isValidNumber(funds.chainTotalBuy)
            ? Number(funds.chainTotalBuy)
            : toFiniteNumber(funds.freeBuy ?? funds.chainFreeBuy);
    
    const availableSell = isValidNumber(funds.allocatedSell)
        ? Number(funds.allocatedSell)
        : isValidNumber(funds.chainTotalSell)
            ? Number(funds.chainTotalSell)
            : toFiniteNumber(funds.freeSell ?? funds.chainFreeSell);

    const shortfalls: FundShortfall[] = [];

    const availableBuyInt = floatToBlockchainInt(availableBuy, buyPrecision);
    const availableSellInt = floatToBlockchainInt(availableSell, sellPrecision);

    if (required.buyInt > availableBuyInt) {
        const requiredBuyFloat = blockchainToFloat(required.buyInt, buyPrecision);
        const availableBuyFloat = blockchainToFloat(availableBuyInt, buyPrecision);
        shortfalls.push({
            asset: assets?.assetB?.symbol || 'buyAsset',
            required: requiredBuyFloat,
            available: availableBuyFloat,
            deficit: blockchainToFloat(required.buyInt - availableBuyInt, buyPrecision)
        });
    }

    if (required.sellInt > availableSellInt) {
        const requiredSellFloat = blockchainToFloat(required.sellInt, sellPrecision);
        const availableSellFloat = blockchainToFloat(availableSellInt, sellPrecision);
        shortfalls.push({
            asset: assets?.assetA?.symbol || 'sellAsset',
            required: requiredSellFloat,
            available: availableSellFloat,
            deficit: blockchainToFloat(required.sellInt - availableSellInt, sellPrecision)
        });
    }

    return {
        isValid: shortfalls.length === 0,
        reason: shortfalls.length > 0 ? `Fund shortfall: ${JSON.stringify(shortfalls)}` : null,
        shortfalls,
        required,
        available: { buy: availableBuy, sell: availableSell }
    };
}

/**
 * Check fund drift against blockchain totals
 * @param {Map} orders - Current orders
 * @param {Object} accountTotals - Blockchain account totals
 * @param {Object} assets - Asset metadata
 * @returns {Object} Drift check result
 */
function checkFundDrift(orders: Map<string, ManagedOrder>, accountTotals: AccountTotals | null, assets: AssetPair | null = null, gridLimits: GridLimitsLike | null = null) {
    let gridBuy = 0, gridSell = 0;
    for (const order of Array.from(orders.values())) {
        const size = toFiniteNumber(order.size);
        if (size <= 0 || !isOrderOnChain(order)) continue;

        if (order.type === ORDER_TYPES.BUY) gridBuy += size;
        else if (order.type === ORDER_TYPES.SELL) gridSell += size;
    }

    const chainFreeBuy = accountTotals?.buyFree || 0;
    const chainFreeSell = accountTotals?.sellFree || 0;
    const actualBuy = accountTotals?.buy || 0;
    const actualSell = accountTotals?.sell || 0;

    const expectedBuy = chainFreeBuy + gridBuy;
    const expectedSell = chainFreeSell + gridSell;

    const driftBuy = Math.abs(actualBuy - expectedBuy);
    const driftSell = Math.abs(actualSell - expectedSell);

    const buyPrecision = assets?.assetB?.precision;
    const sellPrecision = assets?.assetA?.precision;
    
    if (!isValidNumber(buyPrecision) || !isValidNumber(sellPrecision)) {
        return { isValid: true, reason: 'Skipped: precision not available', driftBuy, driftSell };
    }

    const precisionSlackBuy = getPrecisionSlack(buyPrecision);
    const precisionSlackSell = getPrecisionSlack(sellPrecision);
    const fundInvariantTolerance = toFiniteNumber(gridLimits?.FUND_INVARIANT_PERCENT_TOLERANCE ?? GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE);
    const percentTolerance = fundInvariantTolerance / 100;

    const allowedDriftBuy = Math.max(precisionSlackBuy, actualBuy * percentTolerance);
    const allowedDriftSell = Math.max(precisionSlackSell, actualSell * percentTolerance);

    const buyOk = driftBuy <= allowedDriftBuy;
    const sellOk = driftSell <= allowedDriftSell;

    return {
        isValid: buyOk && sellOk,
        driftBuy,
        driftSell,
        allowedDriftBuy,
        allowedDriftSell,
        reason: !buyOk 
            ? `BUY drift ${Format.formatAmountByPrecision(driftBuy, buyPrecision)} > ${Format.formatAmountByPrecision(allowedDriftBuy, buyPrecision)}`
            : !sellOk 
                ? `SELL drift ${Format.formatAmountByPrecision(driftSell, sellPrecision)} > ${Format.formatAmountByPrecision(allowedDriftSell, sellPrecision)}`
                : null
    };
}

// ===============================================================================
// SECTION 3: GRID RECONCILIATION (COW Pipeline)
// ===============================================================================

/**
 * Clamp a rotation UPDATE's target size to a partially-filled surplus order's
 * booked remaining size.
 *
 * A rotation must never GROW a PARTIAL order in place: the fill is already
 * booked into slot.size, and growing it restores the pre-fill size on chain
 * while the books keep the post-fill remainder (fill accounting divergence —
 * the COW executor skips such UPDATEs, which strands the hole and leaves a
 * gap in the grid). Clamping keeps the plan's price intent and fills the hole
 * at the remainder size, so the grid stays contiguous. A deliberate full-size
 * top-up must go through a cancel+create cycle, not a silent in-place grow.
 *
 * Mirrors the clampPostFillUpdateSize policy used for plain size UPDATEs in
 * the COW executor (modules/dexbot_cow_runtime.ts).
 *
 * @param {Object} surplusMaster - Live master-grid order for the rotation source
 * @param {number} holeSize - Planned target (hole) size
 * @param {Function|null} [logger=null] - Optional (msg, level) logger
 * @param {string} [holeId=''] - Hole slot id for the log line
 * @returns {number} The (possibly clamped) rotation size
 */
function clampRotationSizeForPartial(surplusMaster: ManagedOrder | null, holeSize: number, logger: LogFn | null = null, holeId: string = '') {
    const target = toFiniteNumber(holeSize);
    if (!surplusMaster || surplusMaster.state !== ORDER_STATES.PARTIAL) return target;
    const booked = toFiniteNumber(surplusMaster.size);
    if (!Number.isFinite(target) || !Number.isFinite(booked) || booked <= 0) return target;
    if (target > booked) {
        if (logger) {
            logger(
                `[RECONCILE] Clamping rotation ${surplusMaster.id} -> ${holeId || '?'}: ` +
                `surplus is PARTIAL with booked remaining ${Format.formatAmount8(booked)} ` +
                `but hole targets ${Format.formatAmount8(target)} — rotating at remainder size ` +
                `so the hole fills without growing the partial in place.`,
                'warn'
            );
        }
        return booked;
    }
    return target;
}

/**
 * Stamp a rotation UPDATE as a gap-evacuation when plan-build geometry says
 * it moves a live order OUT of the gap band onto its rail. The stamp freezes
 * the boundary + gap width AT PLAN-BUILD TIME (B-stamp) so the COW executor's
 * LAST-FILL guard validates against the geometry the plan was built for —
 * plans can otherwise validate against a later-committed boundary and the
 * evacuation gets misjudged. Stamping requires BOTH:
 * - geometry: source slot index strictly inside the gap band, destination on
 *   the same side's rail (pure parseSlotIndex vs frozen boundary/gapSlots —
 *   never the stored slot type),
 * - allowance: isEvacuationRotationAllowed(oldPrice, oldSize, newPrice,
 *   newSize, type) — outward repricing with bit-exact non-growing size.
 * Anything else stays unstamped and obeys the guard normally (safe default).
 *
 * @param {Object} action - Rotation UPDATE action being built
 * @param {Object} sourceMaster - Live master-grid order for the source slot
 * @param {number|string} destPrice - Destination (hole) price
 * @param {number} destSize - Destination (clamped) size
 * @param {string} type - ORDER_TYPES.BUY or SELL
 * @param {number} frozenBoundary - Plan-build boundary index
 * @param {number} frozenGapSlots - Plan-build gap slot count
 * @returns {Object} The action, stamped when it qualifies
 */
function stampGapEvacuationRotation(action: CowAction, sourceMaster: ManagedOrder | null, destPrice: number | string, destSize: number, type: string, frozenBoundary: number | string | null, frozenGapSlots: number | string, assets: AssetPair | null = null): CowAction {
    // Explicit null/undefined/'' guard BEFORE Number(): Number(null) === 0 is
    // finite and would stamp a bogus gap-evacuation bypass at boundary 0 when
    // the plan geometry is unknown (absent geometry means no stamp, never
    // fail-open — same trap guarded across the COW/gap-evacuation stack).
    if (frozenBoundary === null || frozenBoundary === undefined || frozenBoundary === '') return action;
    const rawFrozenGapSlots: unknown = frozenGapSlots;
    if (rawFrozenGapSlots === null || rawFrozenGapSlots === undefined || rawFrozenGapSlots === '') return action;
    const b = Number(frozenBoundary);
    const g = Number(frozenGapSlots);
    if (!Number.isFinite(b) || !Number.isFinite(g) || g < 0) return action;
    const srcIdx = parseSlotIndex(sourceMaster?.id ?? action?.id);
    const dstIdx = parseSlotIndex(action?.newGridId);
    if (srcIdx === null || srcIdx === undefined || dstIdx === null || dstIdx === undefined) return action;
    if (!isSlotIndexInGapBand(srcIdx, b, g)) return action;
    if (isSlotIndexInGapBand(dstIdx, b, g)) return action;
    const sellStartIdx = getSellStartIdx(b, g);
    const dstInRail = type === ORDER_TYPES.SELL ? Number(dstIdx) >= sellStartIdx : Number(dstIdx) <= b;
    if (!dstInRail) return action;
    // Bit-exact size check with the side's on-chain precision (mirrors the
    // live unstamped probe in dexbot_cow_runtime) — a 1-satoshi size growth
    // must be refused at stamp time, not just at execution.
    let stampPrecision: number | null = null;
    try { stampPrecision = assets ? getPrecisionByOrderType(assets, type) : null; } catch { stampPrecision = null; }
    const check = isEvacuationRotationAllowed(sourceMaster?.price, sourceMaster?.size, destPrice, destSize, type, stampPrecision);
    if (!check.allowed) return action;
    return { ...action, origin: COW_ORIGINS.GAP_EVACUATION, evacBoundary: b, evacGapSlots: Math.floor(g) };
}


/**
 * Reconcile target grid against master state
 * @param {Map} masterGrid - Current master grid
 * @param {Map} targetGrid - Target state from strategy
 * @param {number} targetBoundary - Target boundary index
 * @param {Object} options - Options
 * @returns {Object} Reconciliation result with actions
 */
function reconcileGrid(masterGrid: Map<string, ManagedOrder>, targetGrid: Map<string, ManagedOrder>, targetBoundary: number | null, options: ReconcileGridOptions = {}) {
    const { logger = null, dustThresholdPercent = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE } = options;
    // B-stamp inputs for gap-evacuation rotation stamping (frozen at
    // plan-build): callers pass the geometry this plan was built for. Absent
    // (null/undefined/'') or non-finite => no stamping (guarded default, never
    // fail-open). Absent-aware coercion: Number(null) === 0 would otherwise
    // feed 0 into stampGapEvacuationRotation/detectGapEvacuationCandidates and
    // defeat their own null guards.
    const planGapSlots = Format.toKnownNumber(options?.gapSlots);
    const hasPlanGeometry = Number.isFinite(planGapSlots) && planGapSlots >= 0;
    const evacAssets = options?.assets ?? null;
    const actions: CowAction[] = [];
    
    const surplusesBuy: SurplusEntry[] = [];
    const surplusesSell: SurplusEntry[] = [];
    const holesBuy: HoleEntry[] = [];
    const holesSell: HoleEntry[] = [];

    const isCreateHealthy = (order: ManagedOrder) => {
        if (!order || order.size <= 0) return false;
        const idealSize = toFiniteNumber(order.idealSize || order.size);
        if (idealSize <= 0) return true;
        const minHealthy = getDoubleDustThreshold(idealSize, dustThresholdPercent);
        if (order.size < minHealthy) {
            if (logger) {
                logger(
                    `[RECONCILE] Skipping dust target order: ${order.id} ` +
                    `size=${Format.formatAmount8(order.size)} < minHealthy=${Format.formatAmount8(minHealthy)} ` +
                    `(ideal=${Format.formatAmount8(idealSize)}, threshold=${dustThresholdPercent * 2}%)`,
                    'warn'
                );
            }
            return false;
        }
        return true;
    };

    let validatedBoundary = targetBoundary;
    if (targetBoundary !== null) {
        const maxIdx = Math.max(0, masterGrid.size - 1);
        if (targetBoundary < 0 || targetBoundary > maxIdx) {
            const clamped = clamp(targetBoundary, 0, maxIdx);
            if (logger) {
                logger(`[RECONCILE] Clamping target boundary ${targetBoundary} -> ${clamped} (max ${maxIdx}).`, 'warn');
            }
            validatedBoundary = clamped;
        }
    }

    for (const [id, targetOrder] of targetGrid) {
        const masterOrder = masterGrid.get(id);

        if (!masterOrder || masterOrder.state === ORDER_STATES.VIRTUAL) {
            // Slot is empty or virtual - check if we need to fill it
            if (targetOrder.size > 0 && targetOrder.state === ORDER_STATES.ACTIVE) {
                // This is a hole that needs filling
                if (targetOrder.type === ORDER_TYPES.BUY) {
                    holesBuy.push({ id, order: targetOrder });
                } else if (targetOrder.type === ORDER_TYPES.SELL) {
                    holesSell.push({ id, order: targetOrder });
                }
            }
            continue;
        }

        if (masterOrder.type !== targetOrder.type) {
            actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId, reason: 'type-mismatch' });
            if (targetOrder.size > 0 && targetOrder.state === ORDER_STATES.ACTIVE && isCreateHealthy(targetOrder)) {
                actions.push({ type: COW_ACTIONS.CREATE, id, order: targetOrder });
            }
            continue;
        }

        // If master is on-chain but target should be VIRTUAL (outside window),
        // this is a surplus candidate for rotation.
        if (isOrderOnChain(masterOrder) && targetOrder.state === ORDER_STATES.VIRTUAL) {
            if (masterOrder.type === ORDER_TYPES.BUY) {
                surplusesBuy.push({ id, master: masterOrder, target: targetOrder });
            } else if (masterOrder.type === ORDER_TYPES.SELL) {
                surplusesSell.push({ id, master: masterOrder, target: targetOrder });
            }
            continue;
        }

        if (masterOrder.size !== targetOrder.size) {
            if (targetOrder.size === 0) {
                actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId, reason: 'target-size-zero' });
            }
            // Intentionally no in-place size UPDATE here.
            // Fill-driven COW rebalance keeps updates rotation-only (newGridId path).
            // Non-rotation size corrections are handled by dedicated maintenance flows
            // (divergence/surplus cache-funds correction plans).
        }
    }

    const cancelSurpluses = (surpluses: SurplusEntry[]) => {
        for (const surplus of surpluses) {
            if (surplus.master.orderId) {
                actions.push({ type: COW_ACTIONS.CANCEL, id: surplus.id, orderId: surplus.master.orderId, reason: 'surplus-no-rotation-target' });
            }
        }
    };

    const pairRotations = (surpluses: SurplusEntry[], holes: HoleEntry[]) => {
        const healthyHoles = holes.filter((hole) => isCreateHealthy(hole.order));

        if (healthyHoles.length === 0) {
            // No viable rotation targets — cancel all unmatched surpluses
            cancelSurpluses(surpluses);
            return;
        }

        if (surpluses.length === 0) {
            for (const hole of healthyHoles) {
                actions.push({ type: COW_ACTIONS.CREATE, id: hole.id, order: hole.order });
            }
            return;
        }

        const isBuy = surpluses[0]?.master?.type === ORDER_TYPES.BUY;
        const slotIdx = (id: string) => { const p = parseSlotIndex(id); return p == null ? Number.MAX_SAFE_INTEGER : p; };
        healthyHoles.sort((a, b) => {
            const da = slotIdx(a.id);
            const db = slotIdx(b.id);
            if (da !== db) return da - db;
            return isBuy ? b.order.price - a.order.price : a.order.price - b.order.price;
        });
        surpluses.sort((a, b) => {
            const da = slotIdx(a.id);
            const db = slotIdx(b.id);
            if (da !== db) return da - db;
            return isBuy ? a.master.price - b.master.price : b.master.price - a.master.price;
        });

        const rotationCount = Math.min(surpluses.length, healthyHoles.length);
        for (let i = 0; i < rotationCount; i++) {
            const surplus = surpluses[i];
            const hole = healthyHoles[i];
            const clampedSize = clampRotationSizeForPartial(surplus.master, hole.order.size, logger, hole.id);

            let rotation: CowAction = {
                type: COW_ACTIONS.UPDATE,
                id: surplus.id,
                orderId: surplus.master.orderId,
                newGridId: hole.id,
                newSize: clampedSize,
                newPrice: hole.order.price,
                order: hole.order,
                isRotation: true
            };
            // Gap-evacuation B-stamp (plan-build frozen boundary): a surplus
            // stranded in the gap band rotating onto its rail bypasses the
            // LAST-FILL guard at execution — the rotation reduces the
            // violation surface instead of adding exposure.
            if (hasPlanGeometry) {
                rotation = stampGapEvacuationRotation(
                    rotation, surplus.master, hole.order.price, clampedSize,
                    surplus.master?.type, validatedBoundary, planGapSlots, evacAssets
                );
            }
            actions.push(rotation);
        }

        for (let i = rotationCount; i < healthyHoles.length; i++) {
            actions.push({ type: COW_ACTIONS.CREATE, id: healthyHoles[i].id, order: healthyHoles[i].order });
        }

        // Cancel any surpluses that couldn't be paired with a hole
        cancelSurpluses(surpluses.slice(rotationCount));
    };
    
    pairRotations(surplusesBuy, holesBuy);
    pairRotations(surplusesSell, holesSell);

    for (const [id, masterOrder] of masterGrid) {
        if (!targetGrid.has(id) && isOrderOnChain(masterOrder)) {
            actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId, reason: 'orphan-slot' });
        }
    }

    // Phase 3: tick the per-slot gap-evacuation streak counter when the
    // caller supplies a Map (in-memory on the manager; resets on restart).
    // Detection is geometry-only (parse slot idx vs frozen boundary/gapSlots).
    let evacReady: Array<{ id: string }> = [];
    try {
        if (options?.evacStreaks instanceof Map && hasPlanGeometry) {
            const candidates = detectGapEvacuationCandidates(masterGrid, validatedBoundary, planGapSlots, {
                assets: evacAssets,
                genesis: options?.genesis ?? null
            });
            const tick = updateGapEvacuationStreaks(options.evacStreaks, candidates);
            evacReady = tick.ready;
            if (evacReady.length > 0 && logger) {
                logger(
                    `[GAP-EVAC] ${evacReady.length} stuck in-band order(s) ` +
                    `(boundary ${validatedBoundary}, gap ${planGapSlots}): ` +
                    evacReady.map((c) => `${c.id}(x${tick.streaks[c.id] ?? '?'})`).join(', '),
                    'warn'
                );
            }
        }
    } catch { /* streak tracking is best-effort */ }

    return {
        actions,
        aborted: false,
        boundaryIdx: validatedBoundary,
        evacReady,
        summary: summarizeActions(actions)
    };
}

/**
 * Pair same-side CREATE+CANCEL actions into rotation-style UPDATE actions.
 * This reduces churn and matches boundary-crawl behavior where an on-chain
 * order is moved to a new slot instead of cancel+recreate.
 *
 * @param {Array<Object>} actions - Reconcile action list
 * @param {Map} masterGrid - Current master grid
 * @returns {Array<Object>} Optimized action list
 */
function optimizeRebalanceActions(actions: CowAction[], masterGrid: Map<string, ManagedOrder>, options: OptimizeActionsOptions = {}) {
    if (!Array.isArray(actions) || actions.length === 0) return [];
    const { logger = null } = options;
    // B-stamp inputs (same contract as reconcileGrid): frozen plan-build
    // boundary + gap width for gap-evacuation rotation stamping. Absent =>
    // no stamping, guarded default.
    // Explicit null/undefined guard BEFORE Number(): Number(null) === 0 is
    // finite and would turn an absent boundary into a valid slot-0 geometry,
    // stamping a bogus gap-evacuation bypass (undefined already fails open via
    // NaN, so only null was hazardous). '' is equally hazardous (Number('')
    // === 0) and is guarded here the same way as in
    // stampGapEvacuationRotation.
    const rawOptBoundary = options?.boundaryIdx;
    const rawOptGapSlots = options?.gapSlots;
    const optBoundary = (rawOptBoundary === null || rawOptBoundary === undefined || (rawOptBoundary as unknown) === '')
        ? NaN
        : Number(rawOptBoundary);
    const optGapSlots = (rawOptGapSlots === null || rawOptGapSlots === undefined || (rawOptGapSlots as unknown) === '')
        ? NaN
        : Number(rawOptGapSlots);
    const hasOptGeometry = Number.isFinite(optBoundary) && Number.isFinite(optGapSlots) && optGapSlots >= 0;
    const optAssets = options?.assets ?? null;

    const creates: CowAction[] = [];
    const cancels: CowAction[] = [];
    const passthrough: CowAction[] = [];

    for (const action of actions) {
        if (action?.type === COW_ACTIONS.CREATE) {
            creates.push(action);
        } else if (action?.type === COW_ACTIONS.CANCEL) {
            cancels.push(action);
        } else {
            passthrough.push(action);
        }
    }

    if (creates.length === 0 || cancels.length === 0) {
        return actions;
    }

    const remainingCreates = [...creates];
    const optimized = [...passthrough];

    for (const cancelAction of cancels) {
        const masterOrder = masterGrid.get(cancelAction.id);
        const cancelType = masterOrder?.type;

        if (!masterOrder || !cancelAction.orderId || !cancelType) {
            optimized.push(cancelAction);
            continue;
        }

        let bestIdx = -1;
        let bestDistance = Infinity;

        for (let i = 0; i < remainingCreates.length; i++) {
            const createAction = remainingCreates[i];
            const createType = createAction?.order?.type;
            if (createType !== cancelType) continue;

            const fromIdx = parseSlotIndex(cancelAction.id);
            const toIdx = parseSlotIndex(createAction.id);
            const fromPrice = toFiniteNumber(masterOrder.price);
            const toPrice = toFiniteNumber(createAction?.order?.price);
            const distance = (fromIdx != null && toIdx != null) ? Math.abs(toIdx - fromIdx) : Math.abs(toPrice - fromPrice);

            if (distance < bestDistance) {
                bestDistance = distance;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) {
            optimized.push(cancelAction);
            continue;
        }

        const createAction = remainingCreates.splice(bestIdx, 1)[0];
        const clampedSize = clampRotationSizeForPartial(masterOrder, toFiniteNumber(createAction?.order?.size), logger, createAction.id);
        let rotation: CowAction = {
            type: COW_ACTIONS.UPDATE,
            id: cancelAction.id,
            orderId: cancelAction.orderId,
            newGridId: createAction.id,
            newSize: clampedSize,
            newPrice: toFiniteNumber(createAction?.order?.price),
            order: createAction.order,
            isRotation: true
        };
        if (hasOptGeometry) {
            rotation = stampGapEvacuationRotation(
                rotation, masterOrder, toFiniteNumber(createAction?.order?.price), clampedSize,
                cancelType, optBoundary, optGapSlots, optAssets
            );
        }
        optimized.push(rotation);
    }

    for (const createAction of remainingCreates) {
        optimized.push(createAction);
    }

    return optimized;
}

/**
 * Summarize actions for logging/debugging
 * @param {Array} actions - Action list
 * @returns {Object} Summary counts
 */
function summarizeActions(actions: CowAction[]) {
    return {
        total: actions.length,
        creates: actions.filter((a) => a.type === COW_ACTIONS.CREATE).length,
        cancels: actions.filter((a) => a.type === COW_ACTIONS.CANCEL).length,
        updates: actions.filter((a) => a.type === COW_ACTIONS.UPDATE).length
    };
}

/**
 * Check if a rebalance result has executable actions.
 *
 * @param {unknown} rebalanceResult - Rebalance result to check
 * @returns {boolean} True if actions array is non-empty
 */
function hasExecutableActions(rebalanceResult: unknown) {
    const actions = (rebalanceResult as { actions?: unknown } | null | undefined)?.actions;
    return Array.isArray(actions) && actions.length > 0;
}

/**
 * Validate that CREATE actions target slots that are not already occupied on-chain
 * and that no CREATE price collides with an existing placed order or unmatched
 * on-chain order.  Checks five layers:
 *   1. Slot occupancy — target grid slot already has a placed order
 *   2. Master grid slot collision — same slotId already placed (priceSlotEqual)
 *   3. Chain orphan slot collision — chain order's nearest slotId equals target slotId
 *   4. Same-batch duplicate slotId — two CREATEs target same slotId
 *   5. Same-batch bit-identical duplicate price — two CREATEs on different
 *      target slots at the exact same price (same side)
 *
 * Cancel and rotation-released slots are considered free.
 *
 * Returns violating target IDs alongside violations so the caller can skip
 * individual violating CREATEs instead of aborting the entire batch.
 *
 * @param {Array<CowAction>} actions - List of COW actions
 * @param {Map} orders - Current order grid
 * @param {Object|null} [assets=null] - Asset metadata for tolerance calculation
 * @param {Array<Object>} [chainOrderCandidates=[]] - Unmatched on-chain orders
 *   with {chainOrderId, price, size, type} to check beyond the grid
 * @returns {{isValid: boolean, violations: Array<Object>, violatingTargetIds: Set<string>}} Validation result
 */
function validateCreateTargetSlots(actions: CowAction[], orders: Map<string, ManagedOrder>, _assets: AssetPair | null = null, chainOrderCandidates: UnmatchedChainOrder[] = [], incrementPercent: number | null = null) {
    const safeActions = Array.isArray(actions) ? actions : [];
    const orderMap: Map<string, ManagedOrder> = orders instanceof Map ? orders : new Map();
    const releasedSlotIds = new Set<string>();

    for (const action of safeActions) {
        if (action?.type === COW_ACTIONS.CANCEL && action.id) {
            releasedSlotIds.add(action.id);
            continue;
        }

        if (
            action?.type === COW_ACTIONS.UPDATE &&
            action.id &&
            action.newGridId &&
            action.newGridId !== action.id
        ) {
            releasedSlotIds.add(action.id);
        }
    }

    const violations: CreateTargetViolation[] = [];
    const createEntries: Array<{ targetId: string; action: CowAction; price: number; size: number; type: string }> = [];

    for (const action of safeActions) {
        if (action?.type !== COW_ACTIONS.CREATE) continue;

        const targetId = action.id || action.order?.id;
        if (!targetId || releasedSlotIds.has(targetId)) continue;

        const current = orderMap.get(targetId);

        // isOrderOnChain already checks orderId is truthy
        if (current && isOrderOnChain(current)) {
            violations.push({
                targetId,
                currentOrderId: current.orderId,
                currentType: current.type,
                currentState: current.state,
                reason: 'slot_occupied'
            });
        }

        if (action.order?.price != null && action.order?.type != null) {
            // Key on the BROADCAST price (action.order.price — the price
            // actually placed on chain), never the live slot price: layer-5
            // guards the batch being broadcast, and the chain-orphan price
            // fallback below compares the same broadcast price against the
            // orphan's chain price (correct collision semantics there too).
            createEntries.push({
                targetId,
                action,
                price: Number(action.order.price),
                size: Number(action.order.size || 0),
                type: action.order.type,
            });
        }
    }

    if (createEntries.length > 0) {
        // Out-of-grid holds occupy no slot: their candidateSlotId is the
        // clamped edge (slot-0/N-1), not a real match. Counting it here
        // would permanently block refilling that rail slot while the hold
        // lives below/above the grid — the hold must not collide.
        // Chain orphan: if chain order's nearest slot equals target slot
        const validChainCandidates = chainOrderCandidates.length > 0 ? chainOrderCandidates.filter((u) => u.chainOrderId && !isNonBlockingUnmatchedOrder(u)) : [];
        if (validChainCandidates.length > 0) {
            const chainSlotIds = new Set(validChainCandidates.map((u) => u.chainSlotId || u.candidateSlotId).filter(Boolean));
            for (const entry of createEntries) {
                if (chainSlotIds.has(entry.targetId)) {
                    violations.push({ targetId: entry.targetId, currentOrderId: entry.targetId, currentType: entry.type, currentState: 'CHAIN_ORPHAN', reason: 'chain_orphan_collision' });
                }
            }
            // Price-based fallback, PER CANDIDATE: candidates WITH a slot id
            // already matched by slot above; candidates WITHOUT one (e.g.
            // slot-unknown-* cancelOnly orphans from sync_engine) can never
            // match by slot, so price-check ONLY those — regardless of
            // whether other candidates carry slot ids. Gating the fallback
            // on chainSlotIds.size === 0 skipped the price check for a mixed
            // set entirely, letting a CREATE collide with a slot-unknown
            // chain order sitting at the same price level (duplicate order).
            if (_assets) {
                // Tolerance-based level check (pricesOnSameLevel); NOT
                // priceSlotEqual at the asset precision, which collapses
                // adjacent grid levels for a low-precision asset.
                const slotlessCandidates = validChainCandidates.filter((u) => !(u.chainSlotId || u.candidateSlotId));
                for (const entry of createEntries) {
                    if (violations.some(v => v.targetId === entry.targetId)) continue;
                    for (const u of slotlessCandidates) {
                        if (u.price == null || entry.price == null) continue;
                        if (u.type && entry.type && u.type !== entry.type) continue;
                        if (pricesOnSameLevel(
                            Number(u.price), Number(u.size) || 0, u.type as string | undefined,
                            Number(entry.price), Number(entry.size) || 0, entry.type as string | undefined,
                            _assets, incrementPercent
                        )) {
                            violations.push({ targetId: entry.targetId, currentOrderId: u.chainOrderId, currentType: entry.type, currentState: 'CHAIN_ORPHAN', reason: 'chain_orphan_collision' });
                            break;
                        }
                    }
                }
            }
        }
        // Same-batch duplicate slot
        const seen = new Set<string>();
        for (const entry of createEntries) {
            if (seen.has(entry.targetId)) {
                violations.push({ targetId: entry.targetId, currentOrderId: null, currentType: entry.type, currentState: 'CREATE', reason: 'same_batch_price_collision' });
            } else seen.add(entry.targetId);
        }
        // Same-batch duplicate price across DIFFERENT target slots.
        // The genesis-frozen slot mapping gives every slot a distinct price
        // level, so two CREATEs at the same price on different slots indicate a
        // degenerate plan (production incident 2026-08-29: several slots
        // planned at one price; every batch was filtered down to a single op
        // and the grid rebuild crawled at one placement per cycle).
        //
        // Identity is the ladder level, NOT the on-chain integer at the asset
        // precision: a price is not an amount, so a low-precision asset
        // (e.g. precision 4) collapses an entire adjacent band (0.000318 and
        // 0.000343 both -> 3) and would flag every CREATE but the first as a
        // duplicate. sameGridPrice carries 1e-9 relative slack so float noise
        // in a repeated level still matches without merging distinct levels.
        // First target per (type, level) wins; later duplicates are skipped by
        // the caller via violatingTargetIds.
        const invalidPriceTargets = new Set<string>();
        for (const entry of createEntries) {
            if (!Number.isFinite(Number(entry.price))) {
                // Fail closed: an unpriceable CREATE cannot be proven
                // collision-free, so it is rejected, not skipped.
                violations.push({
                    targetId: entry.targetId,
                    currentOrderId: null,
                    currentType: entry.type,
                    currentState: 'CREATE',
                    reason: 'create_price_invalid',
                });
                invalidPriceTargets.add(entry.targetId);
            }
        }
        const duplicateTargets = new Set<string>();
        for (let i = 0; i < createEntries.length; i++) {
            const a = createEntries[i];
            if (invalidPriceTargets.has(a.targetId)) continue;
            for (let j = i + 1; j < createEntries.length; j++) {
                const b = createEntries[j];
                if (invalidPriceTargets.has(b.targetId)) continue;
                if (a.targetId === b.targetId || a.type !== b.type) continue;
                if (!sameGridPrice(a.price, b.price)) continue;
                if (duplicateTargets.has(b.targetId)) continue;
                duplicateTargets.add(b.targetId);
                violations.push({ targetId: b.targetId, currentOrderId: null, currentType: b.type, currentState: 'CREATE', reason: 'same_batch_price_duplicate', duplicateOf: a.targetId });
            }
        }
    }

    const violatingTargetIds = new Set(violations.map(v => v.targetId));

    return {
        isValid: violations.length === 0,
        violations,
        violatingTargetIds
    };
}

/**
 * Check whether an action targets a given order reference.
 * Matches by orderId first (when present on both), otherwise by slot id.
 *
 * @param {Object} action - Action object
 * @param {Object} orderRef - Reference with id/orderId
 * @returns {boolean}
 */
function actionMatchesOrder(action: CowAction, orderRef: { id?: string | null; orderId?: string | null } | null | undefined) {
    if (!action || !orderRef) return false;
    if (orderRef.orderId && action.orderId && String(orderRef.orderId) === String(action.orderId)) {
        return true;
    }
    return !!orderRef.id && String(orderRef.id) === String(action.id);
}

/**
 * Check if an action list already contains a matching action for an order.
 *
 * @param {Array<Object>} actions - Action list
 * @param {string|null} actionType - Optional action type filter
 * @param {Object} orderRef - Reference with id/orderId
 * @returns {boolean}
 */
function hasActionForOrder(actions: CowAction[], actionType: string | null, orderRef: { id?: string | null; orderId?: string | null }) {
    if (!Array.isArray(actions)) return false;
    return actions.some((action) => {
        if (actionType && action?.type !== actionType) return false;
        return actionMatchesOrder(action, orderRef);
    });
}

/**
 * Remove matching actions for an order from action list in-place.
 *
 * @param {Array<Object>} actions - Action list (mutated)
 * @param {string|null} actionType - Optional action type filter
 * @param {Object} orderRef - Reference with id/orderId
 * @returns {number} Number of removed actions
 */
function removeActionsForOrder(actions: CowAction[], actionType: string | null, orderRef: { id?: string | null; orderId?: string | null }) {
    if (!Array.isArray(actions)) return 0;
    let removed = 0;
    for (let i = actions.length - 1; i >= 0; i--) {
        const action = actions[i];
        if (actionType && action?.type !== actionType) continue;
        if (!actionMatchesOrder(action, orderRef)) continue;
        actions.splice(i, 1);
        removed++;
    }
    return removed;
}

/**
 * @param {Array} [actions]
 * @returns {{slotIds: Set<string>, orderIds: Set<string>}}
 */
function _buildUpdateSelectors(actions: CowAction[] | unknown): UpdateSelectors {
    const selectors: UpdateSelectors = {
        slotIds: new Set(),
        orderIds: new Set()
    };

    if (!Array.isArray(actions)) return selectors;

    for (const action of actions) {
        if (action?.type !== COW_ACTIONS.UPDATE) continue;
        if (action.id) selectors.slotIds.add(String(action.id));
        if (action.newGridId) selectors.slotIds.add(String(action.newGridId));
        if (action.orderId) selectors.orderIds.add(String(action.orderId));
    }

    return selectors;
}

/**
 * @param {{slotIds: Set<string>, orderIds: Set<string>}|null} selectors
 * @param {Object} [current]
 * @param {string} [id]
 * @returns {boolean}
 */
function _hasExplicitUpdateForOrder(selectors: UpdateSelectors | null, current: ManagedOrder | undefined, id: string) {
    if (!selectors) return false;

    if (id && selectors.slotIds.has(String(id))) {
        return true;
    }

    const orderId = current?.orderId;
    return !!orderId && selectors.orderIds.has(String(orderId));
}

/**
 * @param {Object} current
 * @param {Object} targetOrder
 * @param {number} resultSize
 * @param {string} resultState
 * @param {string|null} resultOrderId
 * @returns {boolean}
 */
function _isProjectionUnchanged(current: ManagedOrder, targetOrder: ManagedOrder, resultSize: number, resultState: string, resultOrderId: string | null) {
    if (current.price === targetOrder.price &&
        current.type === targetOrder.type &&
        current.state === resultState &&
        current.size === resultSize &&
        current.orderId === resultOrderId) {
        return true;
    }
    return false;
}

/**
 * Project target grid into working grid
 * @param {unknown} workingGrid - Working grid to modify
 * @param {Map} targetGrid - Target state
 * @param {Object} [options] - Optional parameters
 * @param {Array} [options.actions] - Pre-existing COW actions to consider
 * @returns {void}
 */
function projectTargetToWorkingGrid(workingGrid: WorkingGrid, targetGrid: Map<string, ManagedOrder>, options: ProjectTargetOptions = {}) {
    const updateSelectors = _buildUpdateSelectors(options.actions);
    const targetIds = new Set<string>();

    for (const [id, targetOrder] of targetGrid.entries()) {
        targetIds.add(id);

        const current = workingGrid.get(id);
        const targetSize = toFiniteNumber(targetOrder?.size);

        if (!current) {
            // New orders start as VIRTUAL - transition to ACTIVE happens in synchronizeWithChain
            // after blockchain confirms placement. This ensures accounting deduction occurs.
            workingGrid.set(id, {
                ...targetOrder,
                size: Math.max(0, targetSize),
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            });
            continue;
        }

        if (targetSize > 0) {
            const keepOrderId = isOrderOnChain(current) && current.type === targetOrder.type;
            const hasExplicitUpdate = _hasExplicitUpdateForOrder(updateSelectors, current, id);
            // Orders without on-chain ID remain VIRTUAL until synchronizeWithChain
            // confirms blockchain placement and triggers accounting deduction.
            //
            // Preserve actual on-chain size for any unchanged on-chain order (ACTIVE/PARTIAL)
            // unless there is an explicit UPDATE action for this slot/order.
            // This prevents synthetic target sizes from being committed when no
            // blockchain update operation will be broadcast.
            const shouldPreserveSize = keepOrderId && !hasExplicitUpdate;
            const preservedSize = shouldPreserveSize
                ? Math.max(0, toFiniteNumber(current.size))
                : targetSize;
            const resultState = keepOrderId ? current.state : ORDER_STATES.VIRTUAL;
            const resultOrderId = keepOrderId ? current.orderId : null;
            if (!_isProjectionUnchanged(current, targetOrder, preservedSize, resultState, resultOrderId)) {
                workingGrid.set(id, {
                    ...current,
                    ...targetOrder,
                    size: preservedSize,
                    state: resultState,
                    orderId: resultOrderId
                });
            }
        } else {
            if (!_isProjectionUnchanged(current, targetOrder, 0, ORDER_STATES.VIRTUAL, null)) {
                workingGrid.set(id, {
                    ...current,
                    ...targetOrder,
                    size: 0,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null
                });
            }
        }
    }

    for (const [id, current] of workingGrid.entries()) {
        if (targetIds.has(id)) continue;
        if (isOrderOnChain(current)) {
            workingGrid.set(id, convertToSpreadPlaceholder(current));
        }
    }
}

/**
 * Build optimistic state updates from rebalance actions
 * @param {Array<Object>} actions - Array of rebalance action objects
 * @param {Map} masterGrid - Master grid Map containing current order states
 * @returns {Array<Object>} State update objects for optimistic rendering
 */
function buildStateUpdates(actions: CowAction[], masterGrid: Map<string, ManagedOrder>) {
    const stateUpdates: ManagedOrder[] = [];

    for (const action of actions) {
        if (action.type === COW_ACTIONS.CREATE && action.order) {
            stateUpdates.push({ 
                ...action.order, 
                state: ORDER_STATES.VIRTUAL, 
                orderId: null 
            });
        } else if (action.type === COW_ACTIONS.CANCEL) {
            const masterOrder = masterGrid.get(action.id);
            if (masterOrder) {
                stateUpdates.push(convertToSpreadPlaceholder(masterOrder));
            }
        } else if (action.type === COW_ACTIONS.UPDATE) {
            const masterOrder = masterGrid.get(action.id);
            if (masterOrder) {
                const newSize = toFiniteNumber(action.newSize ?? action.order?.size);
                stateUpdates.push({ ...masterOrder, size: newSize });
            }
        }
    }

    return stateUpdates;
}

/**
 * Build an aborted COW result
 * @param {string} reason - Abort reason
 * @returns {Object} Aborted result object
 */
function buildAbortedResult(reason: string | null | undefined) {
    return {
        actions: [],
        stateUpdates: [],
        hadRotation: false,
        workingGrid: null,
        workingIndexes: null,
        workingBoundary: null,
        planningDuration: 0,
        aborted: true,
        reason
    };
}

/**
 * Build successful COW result
 * @param {Object} params - Result parameters
 * @returns {Object} Success result object
 */
function buildSuccessResult({
    actions,
    stateUpdates,
    workingGrid,
    workingBoundary,
    planningDuration,
    refillSlotIds,
    consumedCrawlIds
}: {
    actions: CowAction[];
    stateUpdates: ManagedOrder[];
    workingGrid: WorkingGrid;
    workingBoundary: number | null;
    planningDuration: number;
    refillSlotIds?: unknown;
    consumedCrawlIds?: unknown;
}) {
    return {
        actions,
        stateUpdates,
        hadRotation: actions.some((a) => a.type === COW_ACTIONS.CREATE || a.type === COW_ACTIONS.UPDATE),
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary,
        planningDuration,
        // Refill-slot wire (boundary-hold): hole-CREATE ids justifying the
        // planned boundary shift. May be absent/empty => executor treats as
        // empty (guarded default, never fail-open).
        ...(refillSlotIds !== undefined ? { refillSlotIds } : {}),
        // Crawl-ledger wire: the owed fill-crawl records this plan's derivation
        // actually folded. The commit clears only these; anything it could not
        // apply stays owed for the next derivation.
        ...(consumedCrawlIds !== undefined ? { consumedCrawlIds } : {}),
        aborted: false
    };
}

/**
 * Evaluate if a working grid can be committed
 * @param {WorkingGrid} workingGrid - Grid to evaluate
 * @param {Object} options - Evaluation options
 * @returns {Object} Evaluation result
 */
function evaluateCommit(workingGrid: WorkingGrid | null | undefined, options: EvaluateCommitOptions | boolean = {}) {
    const opts: EvaluateCommitOptions = options && typeof options === 'object' ? options : {};
    const hasLock = typeof options === 'boolean' ? options : !!opts.hasLock;
    const currentVersion = toFiniteNumber(opts.currentVersion, null);
    const masterGrid = opts.masterGrid ?? null;

    if (!workingGrid) {
        return {
            canCommit: false,
            reason: 'No working grid to commit',
            level: 'error'
        };
    }

    if (workingGrid.isStale()) {
        return {
            canCommit: false,
            reason: `Refusing stale working grid commit${hasLock ? ' (under lock)' : ''}: ${workingGrid.getStaleReason() || 'Master grid changed during planning'}`,
            level: 'warn'
        };
    }

    const baseVersion = workingGrid.baseVersion;

    if (baseVersion === null || baseVersion === undefined) {
        return {
            canCommit: false,
            reason: 'Working grid has no base version',
            level: 'error'
        };
    }

    if (currentVersion !== null && isValidNumber(baseVersion) && Number(baseVersion) !== currentVersion) {
        return {
            canCommit: false,
            reason: `Refusing working grid commit: base version ${Number(baseVersion)} != current ${currentVersion}`,
            level: 'warn'
        };
    }

    if (masterGrid && typeof workingGrid.buildDelta === 'function') {
        const delta = workingGrid.buildDelta(masterGrid, {
            precisions: opts.comparePrecisions || null
        });
        if (Array.isArray(delta) && delta.length === 0) {
            return {
                canCommit: false,
                reason: 'Delta empty at commit - nothing to commit',
                level: 'debug'
            };
        }
    }

    if (hasLock) {
        const stats = workingGrid.getMemoryStats();
        if (stats.size === 0) {
            return {
                canCommit: false,
                reason: 'Working grid is empty',
                level: 'warn'
            };
        }
    }

    return { canCommit: true };
}

// ===============================================================================
// EXPORTS
// ===============================================================================

export { validateOrder, validateGridForPersistence, validateWorkingGridFunds, checkFundDrift, reconcileGrid, optimizeRebalanceActions, hasExecutableActions, validateCreateTargetSlots, hasActionForOrder, removeActionsForOrder, projectTargetToWorkingGrid, buildStateUpdates, buildAbortedResult, buildSuccessResult, evaluateCommit, stampGapEvacuationRotation }


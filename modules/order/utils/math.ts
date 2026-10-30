/**
 * modules/order/utils/math.ts - Mathematical and Numeric Utilities
 * 
 * Pure numeric calculations, blockchain conversions, fee math, and fund allocation.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (78 exports)
 * ===============================================================================
 *
 * SECTION 1: GENESIS LADDER & RAIL GEOMETRY (28 items)
 *   - GridGenesis - Genesis ladder type: start price, increment, gap slots,
 *     price levels and their hash
 *   - priceLevelsForGenesis(genesis) - Extract the frozen price ladder from a genesis
 *   - buildGenesisFromPriceLevels(levels, config) - Build a genesis from precomputed levels
 *   - derivePriceLevels(startPrice, increment, minPrice, maxPrice) - Derive the
 *     geometric price ladder (the "rail") from a live config
 *   - hashPriceLevels(levels) - Deterministic hash of a price ladder
 *   - priceForSlot(idx, genesis) - Authoritative price for a slot index
 *   - slotIndexForPrice(price, genesis) - Resolve a price to its slot index
 *   - slotIdForPrice(price, genesis) - Resolve a price to its "slot-N" id
 *   - assertSlotPriceInvariant(...) - Reject a slot whose price disagrees with its index
 *   - priceSlotEqual(...) - Compare slot/price pairs under the genesis invariant
 *   - sameGridLevel(a, b) - Same ladder level, resolving each price against its genesis
 *   - sameGridPrice(a, b) - Same genesis-derived ladder level by precision
 *   - pricesOnSameLevel(a, b, ...) - Same order-book price LEVEL under precision
 *   - isChainPriceOutOfGrid(price, genesis, ...) - Whether a chain price is off the rail
 *   - getBtsSide(assets) - Which side of the pair holds BTS
 *   - getSellStartIdx(boundaryIdx, gapSlots) - Sell start index from boundary + gap
 *   - calculateGapSlots(incrementPercent, targetSpreadPercent) - Gap-slot count
 *   - resolveGapSlots(manager) - Configured gap-slot count for a manager
 *   - resolveGapBand(manager) - Gap-band geometry { start, end, gapSlots }
 *   - countGapBandSpread(manager) - Count SPREAD slots strictly inside the gap band
 *   - isSlotInRail(...) - Geometric rail-membership test for a slot
 *   - isSlotIndexInGapBand(idx, ...) - Whether a slot index sits inside the gap band
 *   - isEvacuationRotationAllowed(...) - Whether a gap-evacuation rotation is geometrically valid
 *   - isEvacuationSizeStillValid(...) - Re-proof a stamped evacuation size against live geometry
 *   - validateBoundaryCommit(...) - Validate a proposed boundary commit against geometry
 *   - validatePersistedBoundary(...) - Validate a boundary restored from disk
 *   - isTransientInBandRejection(reason) - Whether a persisted-boundary rejection is transient
 *   - BOUNDARY_REJECT_PLACED_IN_BAND - Rejection reason: target slot holds an in-band order
 *
 * SECTION 2: PARSING & VALIDATION (10 functions)
 *   - isExplicitZeroAllocation(value) - Check if value is explicitly zero
 *   - isPercentageString(v) - Check if value is percentage string
 *   - isPositiveNumber(value) - Check if value is a positive number
 *   - isPositiveNumberOrPercent(value) - Positive number or positive percentage string
 *   - isPositiveInt(value) - Check if value is a positive integer
 *   - parsePercentageString(v) - Parse percentage string to decimal
 *   - toDecimal(value) - Convert number/percentage/numeric string to a decimal
 *   - parseRelativeMultiplier(value) - Parse "3x" multiplier syntax to number
 *   - resolveRelativePrice(value, startPrice, mode) - Resolve relative price values
 *   - validateGridPriceBounds(min, max, center) - Reject bounds not bracketing center
 *
 * SECTION 3: FUND CALCULATIONS (8 functions)
 *   - computeChainFundTotals(accountTotals, committedChain) - Compute total funds
 *   - calculateAvailableFundsValue(side, accountTotals, funds, ...) - Calculate available funds
 *   - adjustBudgetForBtsFees(budget, btsFeeData, ...) - Reserve BTS fees from a side budget
 *   - getGridBestPrices(manager) - Best (highest) buy and best (lowest) sell price
 *   - calculateSpreadFromOrders(activeBuys, activeSells) - Calculate spread percentage
 *   - resolveConfigValue(value, total) - Resolve percentage or absolute config value
 *   - resolveConfigValueWithRegistry(value, total, registry) - Config value incl. shared-account funds
 *   - hasValidAccountTotals(accountTotals, checkFree) - Validate account totals structure
 *
 * SECTION 4: BLOCKCHAIN CONVERSIONS (6 functions)
 *   - blockchainToFloat(intValue, precision) - Convert blockchain int to float
 *   - floatToBlockchainInt(floatValue, precision) - Convert float to blockchain int
 *   - floorToBlockchainInt(floatValue, precision) - Convert float to int by flooring
 *   - quantizeFloat(value, precision) - Round float to blockchain precision
 *   - normalizeInt(value, precision) - Normalize int within precision bounds
 *   - quantumForPrecision(precision) - Smallest representable unit for a precision
 *
 * SECTION 5: PRECISION UTILITIES (4 functions)
 *   - getPrecision(assets, orderType) - Get precision for order type
 *   - getPrecisionByOrderType(assets, orderType) - Alias for getPrecision
 *   - getPrecisionsForManager(manager) - Get both asset precisions
 *   - getPrecisionSlack(precision) - Calculate tolerance for precision
 *
 * SECTION 6: ORDER SIZE VALIDATION (8 functions)
 *   - calculatePriceTolerance(price, size, type, assets) - Calculate price match tolerance
 *   - findCrossedOrder(...) - Find an opposite-side order a placement would CROSS
 *   - validateOrderAmountsWithinLimits(amountToSell, minToReceive) - Validate order limits
 *   - getMinOrderSize(orderType, assets, factor) - Get minimum order size
 *   - getDustThresholdFactor() - Get dust threshold multiplier
 *   - getSingleDustThreshold(idealSize, dustThresholdPercent) - Get single dust threshold
 *   - getDoubleDustThreshold(idealSize, dustThresholdPercent) - Get double dust threshold
 *   - validateOrderSize(manager, size, type, context) - Validate order size against minimums
 *
 * SECTION 7: FEE CALCULATIONS (3 functions)
 *   - getAssetFees(assetSymbol, assetAmount, isMaker) - Get fee info for asset
 *   - getAssetFeesSafe(assetSymbol, assetAmount, isMaker) - Fee info without throwing
 *   - _setFeeCache(cache) - Set internal fee cache (internal)
 *
 * SECTION 8: FUND ALLOCATION (6 functions)
 *   - allocateFundsByWeights(available, targetCount) - Allocate funds by weight
 *   - cloneWeightDistribution(weightDistribution, base) - Clone weight distribution safely
 *   - calculateOrderSizes(manager, orderType) - Calculate order sizes for placement
 *   - calculateRotationOrderSizes(manager, orderType, fillAmount) - Calculate rotation sizes
 *   - calculateGridSideDivergenceMetric(manager, orderType, threshold) - Calculate divergence
 *   - clamp(value, min, max) - Clamp a value between min and max bounds
 *
 * SECTION 9: FEE DEDUCTION (2 functions)
 *   - calculateOrderCreationFees(count, btsFeeData) - Calculate total creation fees
 *   - calculateSwapInAmount(targetReceive, poolReserveOut, poolReserveIn) - AMM swap math
 *
 * SECTION 10: FORMATTING (3 functions)
 *   - roundTo(value, factor) - Round to a factor
 *   - fixedTo(value, decimals) - Format to fixed decimal string
 *   - roundToDecimals(value, decimals) - Round to N decimal places
 *
 * ===============================================================================
 */


import { ORDER_TYPES, FEE_PARAMETERS, DEFAULT_CONFIG, GRID_LIMITS } from '../../constants.js';
import * as Format from '../format.js';
import Logger from '../../order/logger.js';
import * as fundRegistry from '../../fund_registry.js';
import { getErrorMessage } from '../../utils/errors.js';
import { parseSlotIndex } from './slot.js';
import type { OrderManagerLike, AccountTotals, ManagerFunds, CoreOrdersConfig, GridFeeParams, ManagedOrder, AssetPair, GridConfig, GridLimitsLike, WeightDistributionConfig } from '../../types.js';
const { isValidNumber, toFiniteNumber } = Format;
const mathLogger = new Logger('Math');

interface FeeCacheEntry {
    limitOrderCreate: { bts: number };
    limitOrderUpdate: { bts: number };
    limitOrderCancel?: { bts?: number };
    makerFeeDiscountPercent?: number;
    chargesMarketFees?: boolean;
    marketFee?: { percent?: number };
    takerFee?: { percent?: number };
    maxMarketFee?: { float?: number };
    [key: string]: unknown;
}

type PricedOrder = { price: number };

interface CollisionItem {
    id?: string;
    price?: number;
    size?: number;
    type?: string;
    order?: { price?: number; size?: number; type?: string } | null;
    [key: string]: unknown;
}

const MAX_INT64 = 9223372036854775807;
const MIN_INT64 = -9223372036854775808;

// ================================================================================
// SECTION 1: PARSING & VALIDATION
// ================================================================================

/**
 * Check if a value is explicitly set to zero (number 0, string "0", or "0%").
 * Used to distinguish between "not set" and "explicitly disabled".
 * 
 * @param {*} value - Value to check
 * @returns {boolean} True if value is explicitly zero
 */
function isExplicitZeroAllocation(value: unknown) {
    if (typeof value === 'number') return value === 0;
    if (typeof value !== 'string') return false;

    const trimmed = value.trim();
    if (trimmed === '') return false;

    if (trimmed.endsWith('%')) {
        const percent = parseFloat(trimmed.slice(0, -1));
        return Number.isFinite(percent) && percent === 0;
    }

    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) && numeric === 0;
}

/**
 * Check if a value is a percentage string (ends with '%').
 * 
 * @param {*} v - Value to test
 * @returns {boolean} True if v is a string ending with '%'
 */
function isPercentageString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().endsWith('%');
}

/**
 * Check if a value is a positive number.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is a finite number greater than 0
 */
function isPositiveNumber(value: unknown) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0;
}

/**
 * Check if a value is a positive number or a positive percentage string.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is a positive number or a percentage string like "25%"
 */
function isPositiveNumberOrPercent(value: unknown) {
    if (isPositiveNumber(value)) return true;
    if (!isPercentageString(value)) return false;
    const percent = parseFloat(value.trim().slice(0, -1));
    return Number.isFinite(percent) && percent > 0;
}

/**
 * Check if a value is a positive integer.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is an integer greater than 0
 */
function isPositiveInt(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Parse a percentage string to decimal form.
 * Extracts numeric value before '%' and divides by 100.
 * 
 * @param {string} v - Percentage string (e.g., "50%")
 * @returns {number|null} Decimal form (e.g., 0.5) or null if invalid
 */
function parsePercentageString(v: unknown) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    return Number.isNaN(num) ? null : num / 100.0;
}

/**
 * Convert a value (number, percentage string, or numeric string) to its
 * decimal form. Unlike parsePercentageString which only handles '%' strings,
 * this also accepts bare numbers and numeric strings.
 * @param {*} value - Number (100 = 100), "100%" (= 1.0), or "100" (= 100)
 * @returns {number} Decimal value, 0 if unparseable
 */
function toDecimal(value: unknown) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.endsWith('%')) {
            const n = parseFloat(trimmed);
            return Number.isNaN(n) ? 0 : n / 100;
        }
        const n = parseFloat(trimmed);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

/**
 * Parse a relative multiplier expression (e.g. "3x", " 1.5X ").
 * Single source of truth for the x-multiplier syntax, shared by price-bound
 * resolution and the bot editor UI.
 *
 * @param {*} value - Candidate value
 * @returns {number|null} Multiplier number, or null if not a valid expression
 */
function parseRelativeMultiplier(value: unknown) {
    if (typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value)) {
        const m = parseFloat(value.trim().toLowerCase().slice(0, -1));
        return Number.isNaN(m) ? null : m;
    }
    return null;
}

/**
 * Resolve a relative price expression (multiplier format) to absolute price.
 * Supports expressions like "3x" to mean 3 times the reference price.
 *
 * @param {*} value - Value to resolve (e.g., "3x" or "0.5x")
 * @param {number} startPrice - Reference price for multiplier calculation
 * @param {string} [mode='min'] - "min" divides (price/multiplier), "max" multiplies (price*multiplier)
 * @returns {number|null} Resolved price or null if value is not a relative expression
 */
function resolveRelativePrice(value: unknown, startPrice: unknown, mode: string = 'min') {
    const multiplier = parseRelativeMultiplier(value);
    const sp = Number(startPrice);
    if (multiplier !== null && Number.isFinite(sp) && multiplier !== 0) {
        return mode === 'min' ? sp / multiplier : sp * multiplier;
    }
    return null;
}

/**
 * Validate that resolved price bounds strictly bracket the grid center.
 *
 * x-multiplier min semantics are divisor-based ("Nx" => center/N), so a
 * multiplier < 1 yields a lower bound ABOVE the center — a geometrically
 * broken grid whose entire buy rail sits above market. The bot previously
 * silently clamped startPrice into this broken window and traded anyway
 * (see issue #15). We fail closed here instead.
 *
 * @param {number} minPrice - Resolved lower bound
 * @param {number} maxPrice - Resolved upper bound
 * @param {number} centerPrice - Grid center used as the multiplier reference
 * @throws {Error} If bounds do not strictly bracket the center
 */
function validateGridPriceBounds(minPrice: unknown, maxPrice: unknown, centerPrice: unknown) {
    const minP = Number(minPrice);
    const maxP = Number(maxPrice);
    const center = Number(centerPrice);
    if (!Number.isFinite(minP) || !Number.isFinite(maxP)
        || !Number.isFinite(center) || center <= 0) {
        return; // Non-finite/invalid prices are handled by other validators.
    }
    if (minP > center) {
        throw new Error(
            `Geometrically broken grid: resolved minPrice ${minP} is above the grid center ${center}. ` +
            `With min x-multiplier semantics "Nx" means center/N, so a multiplier < 1 (e.g. "0.7x" => ${center / 0.7}) ` +
            `places the lower bound ABOVE the center. Use a numeric price below the center, or a multiplier > 1 ` +
            `(e.g. "1.43x" for 70% of center).`
        );
    }
    if (maxP < center) {
        throw new Error(
            `Geometrically broken grid: resolved maxPrice ${maxP} is below the grid center ${center}. ` +
            `With max x-multiplier semantics "Nx" means center*N, so a multiplier < 1 (e.g. "0.7x" => ${center * 0.7}) ` +
            `places the upper bound below the center. Use a numeric price above the center, or a multiplier > 1 for maxPrice.`
        );
    }
}

// ================================================================================
// SECTION 2: FUND CALCULATIONS
// ================================================================================

/**
 * Calculate chain fund totals from account balances and committed orders.
 * Reconciles free/locked balances with committed capital to produce fund summary.
 * 
 * @param {Object} accountTotals - Account balance snapshot with buyFree, sellFree, buy, sell properties
 * @param {Object} committedChain - Committed capital with buy and sell properties
 * @returns {Object} Summary object with chainFreeBuy, chainFreeSell, committedChainBuy, 
 *                   committedChainSell, freePlusLockedBuy, freePlusLockedSell, chainTotalBuy, chainTotalSell
 */
function computeChainFundTotals(accountTotals: AccountTotals | null | undefined, committedChain: { buy?: number; sell?: number } | null | undefined) {
    const chainFreeBuy = toFiniteNumber(accountTotals?.buyFree);
    const chainFreeSell = toFiniteNumber(accountTotals?.sellFree);
    const committedChainBuy = toFiniteNumber(committedChain?.buy);
    const committedChainSell = toFiniteNumber(committedChain?.sell);

    const freePlusLockedBuy = chainFreeBuy + committedChainBuy;
    const freePlusLockedSell = chainFreeSell + committedChainSell;

    const chainTotalBuy = isValidNumber(accountTotals?.buy)
        ? Math.max(Number(accountTotals?.buy), freePlusLockedBuy)
        : freePlusLockedBuy;
    const chainTotalSell = isValidNumber(accountTotals?.sell)
        ? Math.max(Number(accountTotals?.sell), freePlusLockedSell)
        : freePlusLockedSell;

    return {
        chainFreeBuy,
        chainFreeSell,
        committedChainBuy,
        committedChainSell,
        freePlusLockedBuy,
        freePlusLockedSell,
        chainTotalBuy,
        chainTotalSell
    };
}

// ================================================================================
// SECTION 2A: PRECISION QUANTIZATION
// ================================================================================

/**
 * Quantize a float value by round-tripping through blockchain integer representation.
 * Converts float → blockchain int (satoshi-level precision) → float.
 * Eliminates floating-point accumulation errors.
 *
 * @param {number} value - Float value to quantize
 * @param {number} precision - Asset precision (satoshis)
 * @returns {number} Quantized float value
 */
function quantizeFloat(value: number, precision: number) {
    return blockchainToFloat(floatToBlockchainInt(value, precision), precision);
}

/**
 * Normalize an integer value by round-tripping through float representation.
 * Converts int → float (readable format) → blockchain int.
 * Ensures the integer aligns with precision boundaries.
 * Used for precision-aware comparisons.
 *
 * @param {number} value - Integer value to normalize
 * @param {number} precision - Asset precision (satoshis)
 * @returns {number} Normalized integer value
 */
function normalizeInt(value: number, precision: number) {
    return floatToBlockchainInt(blockchainToFloat(value, precision), precision);
}

/**
 * Fee cache local to math.js for getAssetFees.
 * Will be populated by system.js::initializeFeeCache.
 */
let feeCache: Record<string, FeeCacheEntry> = {};

// Track markets already warned about a missing fee cache so the "Using fallback
// fee" notice is logged once per pair instead of once per sizing calculation.
const warnedMissingFeeCachePairs = new Set<string>();

/**
 * @private Set the fee cache (called by system.js::initializeFeeCache).
 *
 * @param {Object} cache - Fee cache object keyed by asset symbol
 * @returns {void}
 */
function _setFeeCache(cache: Record<string, FeeCacheEntry>) { feeCache = cache; }

/**
 * Get fee information for an asset.

 * Returns fee structure or net proceeds calculation if asset amount provided.
 * 
 * @param {string} assetSymbol - Asset symbol (e.g., "BTS", "USD")
 * @param {number} [assetAmount=null] - Asset amount to calculate net proceeds
 * @param {boolean} [isMaker=true] - Whether this is a maker or taker (affects BTS fees)
 * @returns {Object} Fee structure with create/update/net fees or net proceeds if amount provided
 * @throws {Error} If fees not cached (call initializeFeeCache first)
 */
function getAssetFees(assetSymbol: string, assetAmount: number | null = null, isMaker: boolean = true) {
    const cachedFees = feeCache[assetSymbol];
    if (!cachedFees) {
        throw new Error(`Fees not cached for ${assetSymbol}. Call initializeFeeCache first.`);
    }

    if (assetSymbol === 'BTS') {
        const orderCreationFee = cachedFees.limitOrderCreate.bts;
        const orderUpdateFee = cachedFees.limitOrderUpdate.bts;
        const orderCancelFee = cachedFees.limitOrderCancel?.bts || 0;
        const makerFeeDiscountPercent = Number.isFinite(Number(cachedFees.makerFeeDiscountPercent))
            ? Math.max(0, Number(cachedFees.makerFeeDiscountPercent))
            : FEE_PARAMETERS.MAKER_REFUND_PERCENT;
        const makerNetFee = orderCreationFee * FEE_PARAMETERS.MAKER_FEE_PERCENT;
        const takerNetFee = orderCreationFee * FEE_PARAMETERS.TAKER_FEE_PERCENT;
        const netFee = isMaker ? makerNetFee : takerNetFee;

        if (assetAmount !== null && assetAmount !== undefined) {
            const amount = Number(assetAmount);
            const refund = isMaker ? (orderCreationFee * makerFeeDiscountPercent) : 0;
            const netProceeds = amount + refund;
            return {
                netProceeds: netProceeds,
                total: netProceeds,
                refund: refund,
                isMaker: isMaker
            };
        }

        return {
            total: netFee + orderUpdateFee,
            createFee: orderCreationFee,
            updateFee: orderUpdateFee,
            cancelFee: orderCancelFee,
            makerFeeDiscountPercent,
            makerNetFee: makerNetFee,
            takerNetFee: takerNetFee,
            netFee: netFee,
            isMaker: isMaker
        };
    }

    const chargesMarketFees = cachedFees.chargesMarketFees === true;
    const feePercent = chargesMarketFees && isMaker
        ? (cachedFees.marketFee?.percent || 0)
        : chargesMarketFees
            ? (cachedFees.takerFee?.percent || cachedFees.marketFee?.percent || 0)
            : 0;

    if (assetAmount !== null && assetAmount !== undefined) {
        const amount = Number(assetAmount);
        const maxMarketFee = Number.isFinite(Number(cachedFees.maxMarketFee?.float))
            ? Math.max(0, Number(cachedFees.maxMarketFee?.float))
            : Infinity;
        const feeAmount = Math.min((amount * feePercent) / 100, maxMarketFee);
        const netProceeds = amount - feeAmount;
        return {
            netProceeds: netProceeds,
            total: netProceeds,
            feeAmount: feeAmount,
            feePercent: feePercent,
            isMaker: isMaker
        };
    }

    return {
        marketFee: cachedFees.marketFee?.percent || 0,
        takerFee: cachedFees.takerFee?.percent || 0,
        percent: feePercent
    };
}

/**
 * Get fee data for an asset without throwing when the fee cache has not been
 * initialized (e.g. startup reconcile paths that must not hard-fail). Returns
 * null when fees are unavailable; callers fall back to zero-fee accounting.
 * @param {string} assetSymbol - Asset symbol (e.g., "BTS", "USD")
 * @param {number} [assetAmount=null] - Asset amount to calculate net proceeds
 * @param {boolean} [isMaker=true] - Whether this is a maker or taker
 * @returns {Object|null} Fee structure or null when fees are not cached
 */
function getAssetFeesSafe(assetSymbol: string, assetAmount: number | null = null, isMaker: boolean = true) {
    try {
        return getAssetFees(assetSymbol, assetAmount, isMaker);
    } catch {
        return null;
    }
}

/**
 * Fund budget for placing a KNOWN set of pending slots (spread correction).
 *
 * `calculateAvailableFundsValue` computes `chainFree - virtual - fees`, where
 * `virtual` is the projection of the side's not-yet-placed (VIRTUAL) slots.
 * That is the right number for "how much room is left beyond the projected
 * rail", but it is CIRCULAR when the caller is funding exactly those projected
 * slots: if the projection is larger than the account holds free (a rail sized
 * from a bigger balance, from inventory locked in resting orders, or from
 * optimistic proceeds), `available` reads 0 while the chain clearly holds free
 * funds, and the projection can never shrink because nothing gets placed.
 * Live symptom: `planned 3, placing 0` every cycle for 84 minutes
 * (`free 454560.80` vs `virtual 456046.21`).
 *
 * So for a known candidate set, re-derive the budget from chain truth: add the
 * projection back, but never more than the candidates themselves need and never
 * more than the chain actually holds free. The chain remains the final arbiter
 * (an over-commit is rejected at broadcast), and the fee reservation stays
 * inside `availableFund` for every healthy cycle.
 *
 * Only an OVERSUBSCRIPTION (projection > chain free) triggers the fallback. A
 * zero caused by the fee reservation or by a genuinely empty balance is a real
 * constraint: the projection fits, so honour it (and its fees) and place
 * nothing.
 *
 * @param {{availableFund?: number, virtualIntent?: number, chainFree?: number, candidateIdeals?: number}} args
 * @returns {{budget: number, oversubscribed: number, eroded: boolean}} budget to
 *   place with; projection excess over chain free (0 = healthy); whether the
 *   chain-truth re-derivation was needed
 */
function deriveChainTruthFundBudget(args: { availableFund?: number; virtualIntent?: number; chainFree?: number; candidateIdeals?: number } | null | undefined) {
    const available = Math.max(0, toFiniteNumber(args?.availableFund, 0));
    const virtual = Math.max(0, toFiniteNumber(args?.virtualIntent, 0));
    const chainFree = Math.max(0, toFiniteNumber(args?.chainFree, 0));
    const ideals = Math.max(0, toFiniteNumber(args?.candidateIdeals, 0));
    const oversubscribed = Math.max(0, virtual - chainFree);
    // `oversubscribed <= 0` means the projection FITS in the free balance, so a
    // zero `available` is a real constraint (fees/reservation), not the circular
    // case — never re-derive past it.
    if (available > 0 || oversubscribed <= 0 || ideals <= 0 || chainFree <= 0) {
        return { budget: available, oversubscribed, eroded: false };
    }
    // Oversubscribed: fund the candidates from what the chain really holds.
    const budget = Math.min(chainFree, Math.min(virtual, ideals));
    return { budget, oversubscribed, eroded: budget > 0 };
}

/**
 * Calculate available funds for a specific side (buy or sell).
 * Deducts virtual reservations, BTS fees owed, and BTS fee reservation from chain-free balance.
 * 
 * @param {string} side - Trading side: "buy" or "sell"
 * @param {Object} accountTotals - Account balance snapshot
 * @param {Object} funds - Fund allocation object with virtual, btsFeesOwed properties
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol
 * @param {Object} [coreOrders=null] - Active order counts {buy, sell} for BTS reservation calculation
 * @returns {number} Available funds for the side (0 if side invalid or insufficient funds)
 */
function calculateAvailableFundsValue(side: string, accountTotals: AccountTotals | null | undefined, funds: ManagerFunds, assetA: string | undefined, assetB: string | undefined, coreOrders: CoreOrdersConfig | null = null, configMinBtsValue: number | null = null, feeParams: GridFeeParams | null = null) {
    if (side !== 'buy' && side !== 'sell') return 0;

    const chainFree = toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree);
    const virtualReservation = toFiniteNumber(side === 'buy' ? funds.virtual?.buy : funds.virtual?.sell);
    const btsFeesOwed = toFiniteNumber(funds.btsFeesOwed);
    const btsSide = getBtsSide(assetA, assetB);

    const btsReservationMultiplier = feeParams?.BTS_RESERVATION_MULTIPLIER ?? FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;

    let btsFeesReservation = 0;
    if (btsSide === side && coreOrders) {
        const targetBuy = Math.max(0, toFiniteNumber(coreOrders?.buy, 1));
        const targetSell = Math.max(0, toFiniteNumber(coreOrders?.sell, 1));
        const totalTargetOrders = targetBuy + targetSell;
        btsFeesReservation = calculateOrderCreationFees(assetA, assetB, totalTargetOrders, btsReservationMultiplier);
    }

    const currentFeesOwed = (btsSide === side) ? btsFeesOwed : 0;

    // Non-BTS pair: reserve proportional share for BTS fee budget
    if (!btsSide && coreOrders && funds?.btsBalance != null) {
        const targetBuy = Math.max(0, toFiniteNumber(coreOrders?.buy, 1));
        const targetSell = Math.max(0, toFiniteNumber(coreOrders?.sell, 1));
        const totalTargetOrders = targetBuy + targetSell;
        const formulaBudget = calculateOrderCreationFees(assetA, assetB, totalTargetOrders, btsReservationMultiplier);
        const btsFree = toFiniteNumber(funds?.btsBalance?.free, 0);
        const allocatedBuy = toFiniteNumber(funds?.allocated?.buy, 0);
        const allocatedSell = toFiniteNumber(funds?.allocated?.sell, 0);
        const totalFree = allocatedBuy + allocatedSell > 0
            ? allocatedBuy + allocatedSell
            : toFiniteNumber(accountTotals?.buyFree, 0) + toFiniteNumber(accountTotals?.sellFree, 0);
        const sideFree = allocatedBuy + allocatedSell > 0
            ? (side === 'buy' ? allocatedBuy : allocatedSell)
            : toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree, 0);
        const impact = computeBtsFeeImpact(false, formulaBudget, configMinBtsValue ?? 0, btsFree, sideFree, totalFree);
        return Math.max(0, chainFree - virtualReservation - impact);
    }

    return Math.max(0, chainFree - virtualReservation - currentFeesOwed - btsFeesReservation);
}

/**
 * Pure BTS fee impact calculation. Returns the amount to deduct from a side's
 * budget due to BTS fee reservation — for BTS-holding sides the full formula
 * budget, for non-BTS sides a proportional share of any BTS deficit.
 *
 * Used by both calculateAvailableFundsValue (accounting path) and
 * adjustBudgetForBtsFees (sizing path) to eliminate logic drift.
 */
function computeBtsFeeImpact(
    isBtsSide: boolean,
    formulaBudget: number,
    minBtsValue: number,
    btsFree: number,
    sideFree: number,
    totalFree: number
): number {
    if (formulaBudget <= 0) return 0;
    if (isBtsSide) return formulaBudget;
    // totalFree <= 0: no funds to proportionally deduct from — return 0 so
    // callers fall through to their own non-BTS-fee fallback (legacy path 2
    // behavior).  The 0.5 equal-split fallback lives in adjustBudgetForBtsFees
    // for path 1 compatibility only.
    if (totalFree <= 0) return 0;

    const effectiveMin = (minBtsValue > 0) ? minBtsValue : formulaBudget;
    const btsDeficit = Math.max(0, effectiveMin - btsFree);
    if (btsDeficit <= 0) return 0;

    return btsDeficit * (sideFree / totalFree);
}

/**
 * Adjust an allocated budget for BTS fee reservation.
 * Uses computeBtsFeeImpact for proportional deduction; falls back to 0.5
 * split when totalFree is exhausted (legacy sizing-path behavior).
 */
function adjustBudgetForBtsFees(allocated: number, isBtsSide: boolean, formulaBudget: number, minBtsValue: number, btsFree: number, sideFree: number, totalFree: number) {
    if (allocated <= 0) return 0;
    const impact = computeBtsFeeImpact(isBtsSide, formulaBudget, minBtsValue, btsFree, sideFree, totalFree);
    if (impact > 0) return Math.max(0, allocated - impact);
    if (isBtsSide) return Math.max(0, allocated - formulaBudget);
    // Legacy fallback: 0.5 equal split when totalFree is exhausted
    const effectiveMin = (minBtsValue > 0) ? minBtsValue : formulaBudget;
    const btsDeficit = Math.max(0, effectiveMin - btsFree);
    if (btsDeficit > 0) return Math.max(0, Math.min(allocated, allocated - btsDeficit * 0.5));
    return allocated;
}

/**
 * Find the best (highest) buy price and best (lowest) sell price from active orders.
 *
 * @param {Array<Object>} activeBuys - Active buy orders with price property
 * @param {Array<Object>} activeSells - Active sell orders with price property
 * @returns {{bestBuy: number|null, bestSell: number|null}} Best prices or null if no orders
 */
function getGridBestPrices(activeBuys: PricedOrder[], activeSells: PricedOrder[]) {
    const bestBuy  = activeBuys.length  > 0 ? Math.max(...activeBuys.map((o) => o.price))  : null;
    const bestSell = activeSells.length > 0 ? Math.min(...activeSells.map((o) => o.price)) : null;
    return { bestBuy, bestSell };
}

/**
 * Calculate bid-ask spread percentage from active buy and sell orders.
 * Spread = (bestSell / bestBuy - 1) * 100 (percentage).
 *
 * @param {Array<Object>} activeBuys - Active buy orders with price property
 * @param {Array<Object>} activeSells - Active sell orders with price property
 * @returns {number} Spread percentage, or Infinity when one side is empty
 * (the spread is undefined with no opposing quote — never 0, which would
 * read as a perfectly tight book). Callers that flag on counts
 * (shouldFlagOutOfSpread) take the empty-side branch before touching this
 * value; display callers must handle non-finite (see logger status line).
 */
function calculateSpreadFromOrders(activeBuys: PricedOrder[], activeSells: PricedOrder[]) {
    const { bestBuy, bestSell } = getGridBestPrices(activeBuys, activeSells);
    if (bestBuy === null || bestSell === null || bestBuy === 0) return Infinity;
    return ((bestSell / bestBuy) - 1) * 100;
}

/**
 * Resolve a config value to a numeric amount.
 * Interprets percentage strings, numeric strings, or direct numbers.
 * 
 * @param {*} value - Value to resolve (string, number, or percentage)
 * @param {number} total - Total amount for percentage calculations
 * @returns {number} Resolved numeric value or 0 if uninterpretable
 */
function resolveConfigValue(value: unknown, total: unknown) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const p = parsePercentageString(value);
        if (p !== null) {
            if (total === null || total === undefined) return 0;
            return Number(total) * p;
        }
        const n = parseFloat(value);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

/**
 * Resolve a config value to a numeric amount, accounting for shared-account
 * fund registry. If the bot has a registry entry, returns the proportional
 * share of chainTotal. Falls back to standard resolveConfigValue if the
 * registry has no entry for this bot (single-bot accounts or unregistered).
 *
 * @param {*} value - Value to resolve (string, number, or percentage)
 * @param {number} chainTotal - Total chain balance for this side
 * @param {string} account - Blockchain account name
 * @param {string} botName - Bot identifier
 * @param {'buy'|'sell'} side - Trade side
 * @returns {number} Resolved numeric value or 0 if uninterpretable
 */
function resolveConfigValueWithRegistry(value: unknown, chainTotal: number, account: string | undefined, botName: string | undefined, side: string) {
    if (account === undefined || botName === undefined) return resolveConfigValue(value, chainTotal);
    const effective = fundRegistry.getEffectiveAllocationSync(account, botName, side as 'buy' | 'sell', chainTotal);
    if (effective !== null) return effective;
    return resolveConfigValue(value, chainTotal);
}

/**
 * Check if account totals contain valid buy/sell balance data.
 * 
 * @param {Object} accountTotals - Account total balances object
 * @param {boolean} [checkFree=true] - Check free balances if true, else check total balances
 * @returns {boolean} True if both buy and sell values are valid finite numbers
 */
function hasValidAccountTotals(accountTotals: AccountTotals | null | undefined, checkFree: boolean = true) {
    if (!accountTotals) return false;
    const buyKey = checkFree ? 'buyFree' : 'buy';
    const sellKey = checkFree ? 'sellFree' : 'sell';
    return isValidNumber(accountTotals[buyKey]) && isValidNumber(accountTotals[sellKey]);
}

// ================================================================================
// SECTION 3: BLOCKCHAIN CONVERSIONS & PRECISION
// ================================================================================

/**
 * Convert blockchain integer to float using asset precision.
 * Divides by 10^precision to convert satoshi-level units to human-readable float.
 * Formula: float = blockchain_int / (10^precision)
 *
 * @param {number} intValue - Integer value from blockchain (satoshi units)
 * @param {number} precision - Asset precision level (exponent: 5, 8, 4, etc)
 * @returns {number} Float representation in human-readable units
 * @throws {Error} If precision is invalid
 */
function blockchainToFloat(intValue: unknown, precision: number | null | undefined) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for blockchainToFloat: ${precision}`);
    }
    return toFiniteNumber(intValue) / Math.pow(10, Number(precision));
}

/**
 * Convert float to blockchain integer using asset precision.
 * Multiplies by 10^precision and rounds to satoshi-level units.
 * Clamps to MAX_INT64/MIN_INT64 to prevent overflow.
 * Formula: blockchain_int = round(float * (10^precision))
 *
 * Round-trip (float → int → float) eliminates floating-point accumulation errors.
 * Overflow protection: Blockchain integers must fit in signed 64-bit range.
 *
 * @param {number} floatValue - Float value to convert (human-readable units)
 * @param {number} precision - Asset precision level (exponent: 5, 8, 4, etc)
 * @returns {number} Blockchain integer representation (satoshi units)
 * @throws {Error} If precision is invalid
 */
function floatToBlockchainInt(floatValue: unknown, precision: number | null | undefined) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for floatToBlockchainInt: ${precision}`);
    }
    const p = Number(precision);
    const v = toFiniteNumber(floatValue);
    const scaled = Math.round(v * Math.pow(10, p));

    if (scaled > MAX_INT64 || scaled < MIN_INT64) {
        mathLogger.warn(`Overflow detected: ${floatValue} with precision ${p} resulted in ${scaled}. Clamping to safe limits.`);
        return scaled > 0 ? MAX_INT64 : MIN_INT64;
    }

    return scaled;
}

/**
 * Convert float to a blockchain integer by flooring (never rounding up) at the
 * asset precision. Use whenever a value is a ceiling that must not over-state
 * an available budget (for example a released-collateral allowance).
 *
 * A tiny epsilon counteracts binary-float underflow, e.g. 206 / 1.03 evaluates
 * to 199.99999999999997 at precision 0 but is meant to be 200.
 * Formula: blockchain_int = floor(float * 10^precision + 1e-9)
 *
 * @param {number} floatValue - Float value in human-readable units
 * @param {number} precision - Asset precision exponent (5, 8, 4, ...)
 * @returns {number} Floored blockchain integer representation
 */
function floorToBlockchainInt(floatValue: unknown, precision: number | null | undefined): number {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for floorToBlockchainInt: ${precision}`);
    }
    const p = Number(precision);
    const v = toFiniteNumber(floatValue);
    return Math.floor(v * Math.pow(10, p) + 1e-9);
}

/**
 * Get asset precision for a specific order type (BUY or SELL).
 * BUY orders size in assetB, SELL orders size in assetA.
 * 
 * @param {Object} assets - Asset metadata with assetA and assetB
 * @param {string} orderType - Order type (ORDER_TYPES.BUY or ORDER_TYPES.SELL)
 * @returns {number} Asset precision
 * @throws {Error} If precision missing for the required asset
 */
function getPrecisionByOrderType(assets: AssetPair | null | undefined, orderType: string) {
    return getPrecision(assets, { type: orderType });
}

/**
 * Get asset precisions for both assetA and assetB.
 * 
 * @param {Object} assets - Asset metadata with assetA and assetB
 * @returns {Object} Object with A and B precision properties
 * @throws {Error} If precision missing for either asset
 */
function getPrecisionsForManager(assets: AssetPair | null | undefined) {
    return {
        A: getPrecision(assets, { type: ORDER_TYPES.SELL }),
        B: getPrecision(assets, { type: ORDER_TYPES.BUY })
    };
}

/**
 * Compute the quantum (smallest representable unit) for a given asset precision.
 * quantum = 10^-precision (e.g., 8 decimals → 1e-8).
 */
function quantumForPrecision(precision: number | undefined): number {
    return Math.pow(10, -Number(precision));
}

/**
 * Calculate precision slack (rounding tolerance) for a given precision level.
 * Used for safe comparison of blockchain values that may differ by rounding.
 * 
 * @param {number} precision - Asset precision level
 * @param {number} [factor=2] - Multiplier for slack (default 2)
 * @returns {number} Tolerance value (e.g., 2 * 10^-8 for 8-decimal precision)
 */
function getPrecisionSlack(precision: number | undefined, factor: number = 2) {
    return factor * quantumForPrecision(precision);
}

/**
 * Unified precision lookup for assets.
 * 
 * @param {Object} assets - Assets object with assetA and assetB
 * @param {Object} [options={}] - Lookup options { type, side, proceeds }
 * @returns {number} Asset precision
 */
function getPrecision(assets: AssetPair | null | undefined, { type, side, proceeds = false }: { type?: string; side?: string; proceeds?: boolean } = {}) {
    if (!assets) throw new Error("Assets object required for precision lookup");
    
    // Determine target side: side param priority, then type param
    let isSellSide;
    if (side) isSellSide = (side === 'sell');
    else if (type) isSellSide = (type === ORDER_TYPES.SELL);
    else throw new Error("Either 'type' or 'side' must be provided for getPrecision");

    // Proceeds logic: SELL (assetA) results in assetB proceeds; BUY (assetB) results in assetA
    const targetIsAssetA = proceeds ? !isSellSide : isSellSide;
    const asset = targetIsAssetA ? assets.assetA : assets.assetB;
    
    if (typeof asset?.precision !== 'number') {
        const label = targetIsAssetA ? 'assetA' : 'assetB';
        throw new Error(`CRITICAL: Precision missing for ${label} (${asset?.symbol || 'unknown'}).`);
    }
    return asset.precision;
}

/**
 * Determine which side holds BTS for a trading pair.
 * Returns ORDER_TYPES.SELL if assetA is BTS, ORDER_TYPES.BUY if assetB is BTS, null otherwise.
 */
function getBtsSide(assetA: string | undefined, assetB: string | undefined): string | null {
    if (assetA === 'BTS') return ORDER_TYPES.SELL;
    if (assetB === 'BTS') return ORDER_TYPES.BUY;
    return null;
}

// ================================================================================
// SECTION 4: PRICE OPERATIONS (PART 1 - Tolerance)
// ================================================================================

/**
 * Calculate price tolerance for order matching on-chain.
 * Accounts for precision limits of both assets to determine acceptable price deviation.
 * Used when matching grid orders to blockchain orders.
 *
 * NOTE on the orderSize parameter: larger sizes produce tighter (more precise)
 * tolerance values. When using this function for duplicate-price-level
 * detection, always pass Math.max(sizeA, sizeB) as orderSize — a tiny dust
 * order would inflate the tolerance window and falsely match distant prices.
 * 
 * @param {number} gridPrice - Grid order price
 * @param {number} orderSize - Order size on primary side (larger = tighter tolerance)
 * @param {string} orderType - Order type ("buy" or "sell")
 * @param {Object} [assets=null] - Asset metadata with precision (required)
 * @returns {number|null} Price tolerance value or null if invalid inputs
 * @throws {Error} If assets missing or precisions invalid
 */
function calculatePriceTolerance(gridPrice: unknown, orderSize: unknown, orderType: string, assets: AssetPair | null = null): number | null {
    if (!isValidNumber(gridPrice) || !isValidNumber(orderSize)) return null;
    if (!assets) throw new Error("CRITICAL: Assets object required for calculatePriceTolerance");

    const gp = Number(gridPrice);
    const size = Number(orderSize);
    const precisionA = assets.assetA?.precision;
    const precisionB = assets.assetB?.precision;

    if (typeof precisionA !== 'number' || typeof precisionB !== 'number') {
        throw new Error(`CRITICAL: Missing precision for price tolerance (A=${precisionA}, B=${precisionB})`);
    }

    if (!size || size <= 0) return null;

    // Minimum amount in blockchain satoshis that the chain will accept for an order.
    // Uses GRID_LIMITS.MIN_ORDER_SIZE_FACTOR (same constant as getMinOrderSize).

    let orderSizeA: number, orderSizeB: number;
    if (orderType === 'sell' || orderType === 'SELL' || orderType === 'Sell') {
        orderSizeA = size;
        orderSizeB = size * gp;
    } else {
        orderSizeB = size;
        orderSizeA = size / gp;
    }

    const minOrderSats = GRID_LIMITS.MIN_ORDER_SIZE_FACTOR;
    const satsA = Math.max(orderSizeA * Math.pow(10, precisionA), minOrderSats);
    const satsB = Math.max(orderSizeB * Math.pow(10, precisionB), minOrderSats);

    const termA = 1 / satsA;
    const termB = 1 / satsB;
    const tolerance = (termA + termB) * gp;
    const maxTolerance = Math.max(gp * GRID_LIMITS.PRICE_TOLERANCE_MAX_PERCENT, GRID_LIMITS.PRICE_TOLERANCE_MIN_ABSOLUTE);
    return Math.min(tolerance, maxTolerance);
}

/**
 * Whether two prices denote the same order-book price LEVEL, using the
 * chain-representable price tolerance derived from both assets' precisions and
 * the order size(s).
 *
 * WHY NOT priceSlotEqual(priceA, priceB, assetPrecision): a price is not an
 * asset AMOUNT. Rounding it through one asset's precision
 * (floatToBlockchainInt) collapses an entire adjacent grid band whenever the
 * OTHER asset has low precision -- e.g. with a precision-4 quote asset both
 * 0.000318 and 0.000319 round to 3, so every BUY after the first looked like a
 * duplicate. The real on-chain price resolution is roughly
 * 10^-precision / orderSize, which is exactly what calculatePriceTolerance
 * derives. Use this for every production "same price level" check.
 *
 * Both types are evaluated and the tighter tolerance is kept (most
 * conservative): a buy-vs-sell comparison where either side uses a
 * precision-0 asset can otherwise produce a tolerance wider than the grid
 * increment and falsely collide adjacent levels.
 *
 * @param {number} priceA - First price
 * @param {number} sizeA - First order size (same side as typeA)
 * @param {string|null|undefined} typeA - First order type (ORDER_TYPES)
 * @param {number} priceB - Second price
 * @param {number} sizeB - Second order size (same side as typeB)
 * @param {string|null|undefined} typeB - Second order type (ORDER_TYPES)
 * @param {object|null} assets - Manager assets (assetA/assetB with precision)
 * @param {number|null} [incrementPercent] - Grid increment; when supplied the
 *   tolerance is clamped to half a grid step so a dust-inflated
 *   (MIN_ORDER_SIZE_FACTOR floor) tolerance cannot merge adjacent levels.
 * @returns {boolean} True when the two prices sit on the same level
 */
function pricesOnSameLevel(
    priceA: number,
    sizeA: number,
    typeA: string | null | undefined,
    priceB: number,
    sizeB: number,
    typeB: string | null | undefined,
    assets: AssetPair | null = null,
    incrementPercent: number | null | undefined = null
): boolean {
    const pa = Number(priceA);
    const pb = Number(priceB);
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) return pa === pb;

    const size = Math.max(Number(sizeA) || 0, Number(sizeB) || 0);
    const gridPrice = Math.min(pa, pb);
    let tolerance: number | null = null;
    for (const type of [typeA, typeB]) {
        if (type == null) continue;
        let t: number | null = null;
        try {
            t = calculatePriceTolerance(gridPrice, size, type, assets);
        } catch {
            t = null;
        }
        if (t != null && Number.isFinite(t)) {
            tolerance = tolerance == null ? t : Math.min(tolerance, t);
        }
    }
    if (tolerance == null) return pa === pb;
    // Hard cap: never let the tolerance span more than half a grid step. The
    // precision/floor maths above can otherwise exceed the increment for
    // dust-sized or low-precision orders, merging two legitimately adjacent
    // levels (the caller passes the increment when it has one).
    const inc = Number(incrementPercent);
    if (Number.isFinite(inc) && inc > 0) {
        tolerance = Math.min(tolerance, Math.abs(gridPrice) * (inc / 100) * 0.5);
    }
    return Math.abs(pa - pb) <= tolerance;
}

/**
 * Relative slack for grid price identity. Large enough to absorb float noise
 * (re-serialization, a stored value recomputed through a different but
 * algebraically equivalent path) yet far below any real grid increment, so it
 * cannot merge two genuinely distinct ladder levels.
 */
const GRID_PRICE_REL_EPSILON = 1e-9;

/**
 * Whether two GENESIS-derived grid prices denote the same ladder level by
 * EXACT identity (with float-noise slack).
 *
 * Grid slot prices are frozen ladder values (bit-identical per level), so
 * exact equality is the correct identity for a grid-vs-grid comparison.
 * Deliberately NOT priceSlotEqual at the asset precision (collapses an
 * adjacent band for a low-precision asset) and NOT the chain tolerance (which
 * can exceed the grid increment and merge two legitimately adjacent levels).
 * Prefer sameGridLevel(genesis) where a ladder is available: it maps a drifted
 * price back to its nearest ladder level. Use pricesOnSameLevel instead when
 * one side is a chain-derived price that may sit a few chain quanta off its
 * level.
 *
 * @param {number} priceA - First grid price
 * @param {number} priceB - Second grid price
 * @returns {boolean} True when both are the same ladder level
 */
function sameGridPrice(priceA: number, priceB: number): boolean {
    const a = Number(priceA);
    const b = Number(priceB);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    if (a === b) return true;
    return Math.abs(a - b) <= GRID_PRICE_REL_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Whether two grid prices denote the same ladder level, resolving each price
 * to its nearest level through the frozen genesis ladder when one is supplied.
 * This is robust to a price that was chain-corrected / rounded a quantum off
 * its level: slotIndexForPrice maps it back to the level it came from, while a
 * price that genuinely moved to another level resolves to a different index.
 *
 * PRECONDITION / HARDENING: slotIndexForPrice CLAMPS an out-of-rail price onto
 * the edge levels, so two distinct out-of-rail prices would otherwise resolve
 * "equal". This helper therefore only uses slot identity when BOTH prices sit
 * inside [levels[0], levels[N-1]]; otherwise it falls back to exact-level
 * identity (sameGridPrice, with float-noise slack). Callers pass in-rail grid
 * prices today, but the guard makes out-of-rail misuse safe.
 *
 * @param {number} priceA - First grid price
 * @param {number} priceB - Second grid price
 * @param {unknown} genesis - Frozen genesis ladder (`manager._genesis`)
 * @returns {boolean} True when both prices resolve to the same ladder level
 */
function sameGridLevel(priceA: number, priceB: number, genesis: unknown): boolean {
    const a = Number(priceA);
    const b = Number(priceB);
    const levels = (genesis as GridGenesis | null | undefined)?.priceLevels;
    if (Array.isArray(levels) && levels.length > 0) {
        const lo = Number(levels[0]);
        const hi = Number(levels[levels.length - 1]);
        const inRail = (p: number): boolean => Number.isFinite(p) && p >= lo && p <= hi;
        if (!inRail(a) || !inRail(b)) return sameGridPrice(a, b);
        try {
            const g = genesis as Parameters<typeof slotIndexForPrice>[1];
            return slotIndexForPrice(a, g) === slotIndexForPrice(b, g);
        } catch { /* unjudgeable ladder — fall through to exact-level identity */ }
    }
    return sameGridPrice(a, b);
}

/**
 * Find an opposite-side order that a candidate placement would CROSS.
 *
 * A BUY at `price` crosses every SELL priced at or below it (within price
 * tolerance); a SELL at `price` crosses every BUY priced at or above it.
 * A crossing placement that broadcasts while the crossed order is still
 * live self-trades against our own book: BitShares has no self-trade
 * prevention, and the COW rebalance broadcasts in 4-op chunks over ~30s,
 * so a re-priced buy lands several chunks before the crossed sell's
 * cancel confirms (production incident: multiple self-fills where the
 * sell ladder was re-priced into marketable buys, triggering a fatal
 * fund assertion).
 *
 * Unlike a same-price check, this catches crossings at ANY price overlap and
 * is intended for the re-pricing UPDATE / CREATE paths. The caller decides the
 * exemption policy (e.g. crossed orders cancelled earlier in the same plan).
 *
 * @param {Iterable<any>} items - Candidate orders (e.g. manager.orders.values())
 * @param {number} price - Candidate placement price
 * @param {string} type - Candidate placement type (ORDER_TYPES.BUY / SELL)
 * @param {unknown} assets - Asset metadata (precisions) for tolerance
 * @param {((item: any) => boolean)|null} [isValid] - Optional filter
 * @returns {any|null} The first crossed order, or null when the placement crosses nothing
 */
function findCrossedOrder(
    items: Iterable<CollisionItem>,
    price: number,
    type: string,
    assets: AssetPair | null,
    isValid?: ((item: CollisionItem) => boolean) | null
): CollisionItem | null {
    if (price == null || !Number.isFinite(Number(price)) || type == null) return null;
    for (const item of items) {
        if (!item || (isValid && !isValid(item))) continue;
        const itemType = item.type ?? item.order?.type;
        if (itemType == null || itemType === type) continue;
        const itemPrice = item.price ?? item.order?.price;
        if (itemPrice == null || !Number.isFinite(Number(itemPrice))) continue;

        // Tolerance-widened crossing test. The forbidden band extends from
        // the candidate price INTO the crossing direction by the price
        // tolerance, so an opposite-side order within tolerance of the
        // candidate price is flagged (re-pricing onto it would self-trade
        // at precision dust). The comparison alone decides the outcome —
        // do not pre-gate on the raw inequality, or near-equality cases
        // (sell priced a dust-width above the candidate buy) escape.
        const combinedSize = Math.max(item.size ?? item.order?.size ?? 0, 0);
        const toleranceTarget = calculatePriceTolerance(
            Math.min(itemPrice, price),
            combinedSize,
            type,
            assets
        );
        let tolerance = toleranceTarget;
        if (toleranceTarget != null && itemType != null) {
            const toleranceItem = calculatePriceTolerance(
                Math.min(itemPrice, price),
                combinedSize,
                itemType,
                assets
            );
            if (toleranceItem != null) {
                tolerance = Math.min(toleranceTarget, toleranceItem);
            }
        }
        if (tolerance == null) continue;
        if (type === ORDER_TYPES.BUY) {
            if (Number(itemPrice) <= Number(price) + tolerance) return item;
        } else {
            if (Number(itemPrice) >= Number(price) - tolerance) return item;
        }
    }
    return null;
}

/**
 * Validate order amounts are within blockchain limits (0 < INT64_MAX).
 * Converts floats to blockchain integers and checks they fit in signed 64-bit integers.
 * 
 * @param {number} amountToSell - Amount to sell (float)
 * @param {number} minToReceive - Minimum amount to receive (float)
 * @param {number} sellPrecision - Precision of sell asset
 * @param {number} receivePrecision - Precision of receive asset
 * @returns {boolean} True if both amounts are valid and within limits
 */
function validateOrderAmountsWithinLimits(amountToSell: number, minToReceive: number, sellPrecision: number, receivePrecision: number) {
    const sellPrecFloat = Math.pow(10, toFiniteNumber(sellPrecision));
    const receivePrecFloat = Math.pow(10, toFiniteNumber(receivePrecision));

    const sellInt = Math.round(toFiniteNumber(amountToSell) * sellPrecFloat);
    const receiveInt = Math.round(toFiniteNumber(minToReceive) * receivePrecFloat);

    const withinLimits = sellInt <= MAX_INT64 && receiveInt <= MAX_INT64 && sellInt > 0 && receiveInt > 0;

    if (!withinLimits) {
        mathLogger.warn(`Order amounts exceed safe limits or are invalid. Sell: ${amountToSell} = ${sellInt}, Receive: ${minToReceive} = ${receiveInt}. Max allowed: ${MAX_INT64}`);
    }

    return withinLimits;
}

// ================================================================================
// SECTION 5: DUST THRESHOLD & SIZE VALIDATION
// ================================================================================

/**
 * Calculate minimum absolute order size for an order type.
 * Returns factor * 10^-precision (e.g., 50 * 10^-8 for 8-decimal asset).
 * 
 * @param {string} orderType - Order type (BUY or SELL)
 * @param {Object} assets - Asset metadata with assetA and assetB precisions
 * @param {number} [factor=50] - Minimum size factor (default 50)
 * @returns {number} Minimum order size in asset units
 * @throws {Error} If precision cannot be determined
 */
function getMinOrderSize(orderType: string, assets: AssetPair | null | undefined, factor: number = GRID_LIMITS.MIN_ORDER_SIZE_FACTOR) {
    const f = Number(factor);
    if (!f || !Number.isFinite(f) || f <= 0) return 0;

    let precision = null;
    if (assets) {
        if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
        else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
    }

    if (typeof precision !== 'number') {
        throw new Error(`CRITICAL: Cannot determine minimum order size for ${orderType} - missing precision`);
    }

    return Number(f) * Math.pow(10, -precision);
}

/**
 * Calculate dust threshold factor as decimal fraction.
 * 
 * @param {number} [dustThresholdPercent=5] - Dust threshold percentage (default 5%)
 * @returns {number} Dust factor (e.g., 0.05 for 5%)
 */
function getDustThresholdFactor(dustThresholdPercent: number = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE) {
    return dustThresholdPercent / 100;
}

/**
 * Calculate single dust threshold for an ideal order size.
 * Returns idealSize * (dustThresholdPercent / 100).
 * 
 * @param {number} idealSize - Ideal/reference order size
 * @param {number} [dustThresholdPercent=5] - Threshold percentage (default 5%)
 * @returns {number} Single dust threshold (0 if idealSize invalid)
 */
function getSingleDustThreshold(idealSize: number, dustThresholdPercent: number = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE) {
    if (!idealSize || idealSize <= 0) return 0;
    return idealSize * getDustThresholdFactor(dustThresholdPercent);
}

/**
 * Calculate double dust threshold for an ideal order size.
 * Returns idealSize * (dustThresholdPercent / 100) * 2.
 * Used to filter very small orders that would be uneconomical.
 * 
 * @param {number} idealSize - Ideal/reference order size
 * @param {number} [dustThresholdPercent=5] - Threshold percentage (default 5%)
 * @returns {number} Double dust threshold (0 if idealSize invalid)
 */
function getDoubleDustThreshold(idealSize: number, dustThresholdPercent: number = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE) {
    if (!idealSize || idealSize <= 0) return 0;
    return idealSize * getDustThresholdFactor(dustThresholdPercent) * 2;
}

/**
 * Validate an order size against minimum absolute and dust thresholds.
 * Returns detailed validation result with reasons if invalid.
 * 
 * @param {number} orderSize - Order size to validate
 * @param {string} orderType - Order type (BUY or SELL)
 * @param {Object} assets - Asset metadata with precisions
 * @param {number} [minFactor=50] - Minimum size factor (default 50)
 * @param {number} [idealSize=null] - Ideal size for dust calculations
 * @param {number} [dustThresholdPercent=5] - Dust threshold percentage (default 5%)
 * @returns {Object} Validation result {isValid, reason, minAbsoluteSize, minDustSize}
 */
function validateOrderSize(orderSize: number, orderType: string, assets: AssetPair | null | undefined, minFactor: number = GRID_LIMITS.MIN_ORDER_SIZE_FACTOR, idealSize: number | null = null, dustThresholdPercent: number = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE): { isValid: boolean; reason: string | null; minAbsoluteSize: number; minDustSize: number | null } {
     const orderSizeFloat = toFiniteNumber(orderSize);
     const minAbsoluteSize = getMinOrderSize(orderType, assets, minFactor);
     
     let precision: number | null = null;
     if (assets) {
         if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
         else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
     }
      const displayPrecision = precision ?? undefined;
     
     if (orderSizeFloat < minAbsoluteSize) {
         return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below absolute minimum (${Format.formatAmountByPrecision(minAbsoluteSize, displayPrecision)})`, minAbsoluteSize, minDustSize: null };
     }

     if (idealSize !== null && idealSize !== undefined && idealSize > 0) {
         const minDustSize = getDoubleDustThreshold(idealSize, dustThresholdPercent);
         if (orderSizeFloat < minDustSize) {
             return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below double-dust threshold (${Format.formatAmountByPrecision(minDustSize, displayPrecision)})`, minAbsoluteSize, minDustSize };
         }
     }

     if (typeof precision === 'number') {
         if (floatToBlockchainInt(orderSizeFloat, precision) <= 0) {
             return { isValid: false, reason: `Order size (${orderSizeFloat}) rounds to 0 on blockchain`, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null };
         }
     }

     return { isValid: true, reason: null, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null };
}

// ================================================================================
// SECTION 9: ORDER SIZING & ALLOCATION
// ================================================================================

/**
 * Allocate total funds across n orders using exponential weight distribution.
 * Optionally enforces precision quantization to match blockchain constraints.
 * If precision provided, adjusts the largest order to compensate for rounding errors.
 * 
 * @param {number} totalFunds - Total funds to allocate
 * @param {number} n - Number of orders to create allocations for
 * @param {number} weight - Weight factor (0-1) controlling distribution steepness
 * @param {number} incrementFactor - Increment factor (typically 0.01 for 1% grid spacing)
 * @param {boolean} [reverse=false] - If true, allocate larger sizes to higher indices
 * @param {number} [minSize=0] - Minimum size for each allocation (currently unused, for future validation)
 * @param {number} [precision=null] - Asset precision; if provided, quantize to blockchain integers
 * @returns {Array<number>} Array of n allocation sizes
 */
function allocateFundsByWeights(totalFunds: number, n: number, weight: unknown, incrementFactor: number, reverse: boolean = false, _minSize: number = 0, precision: number | null = null): number[] {
    if (n <= 0) return [];
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

    const weightNum = Number(weight);
    const base = 1 - incrementFactor;
    const rawWeights = new Array(n);
    for (let i = 0; i < n; i++) {
        const idx = reverse ? (n - 1 - i) : i;
        rawWeights[i] = Math.pow(base, idx * weightNum);
    }

    const sizes = new Array(n).fill(0);
    const totalWeight = rawWeights.reduce((s: number, w: number) => s + w, 0) || 1;

    if (precision !== null && precision !== undefined) {
        const totalUnits = floatToBlockchainInt(totalFunds, precision);
        let unitsSummary = 0;
        const units = new Array(n);

        for (let i = 0; i < n; i++) {
            units[i] = Math.round((rawWeights[i] / totalWeight) * totalUnits);
            unitsSummary += units[i];
        }

        const diff = totalUnits - unitsSummary;
        if (diff !== 0 && n > 0) {
            let largestIdx = 0;
            for (let j = 1; j < n; j++) if (units[j] > units[largestIdx]) largestIdx = j;
            const adjusted = units[largestIdx] + diff;
            if (adjusted < 0) {
                mathLogger.warn(`allocateFundsByWeights: rounding diff ${diff} exceeds largest slot ${units[largestIdx]}; total allocation will be less than target ${totalUnits}`);
            }
            units[largestIdx] = Math.max(0, adjusted);
        }
        for (let i = 0; i < n; i++) sizes[i] = blockchainToFloat(units[i], precision);
    } else {
        for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
    }

    return sizes;
}

/**
 * Calculate order sizes for a list of orders using weighted fund allocation.
 * Allocates buy and sell funds separately using weight distribution from config.
 * Preserves order sequence while adding size property to each order.
 * 
 * @param {Array<Object>} orders - Array of order objects with type property
 * @param {Object} config - Configuration with incrementPercent and weightDistribution
 * @param {number} sellFunds - Total funds available for SELL orders
 * @param {number} buyFunds - Total funds available for BUY orders
 * @param {number} [minSellSize=0] - Minimum size for sell allocations
 * @param {number} [minBuySize=0] - Minimum size for buy allocations
 * @param {number} [precisionA=null] - Precision for assetA (SELL asset)
 * @param {number} [precisionB=null] - Precision for assetB (BUY asset)
 * @returns {Array<Object>} Orders array with size property added to each
 */
function calculateOrderSizes(orders: ManagedOrder[], config: GridConfig, sellFunds: number, buyFunds: number, minSellSize: number = 0, minBuySize: number = 0, precisionA: number | null = null, precisionB: number | null = null): ManagedOrder[] {
    const incrementPercent = config.incrementPercent ?? 0;
    const sellWeight = config.weightDistribution?.sell ?? 0;
    const buyWeight = config.weightDistribution?.buy ?? 0;
    const incrementFactor = incrementPercent / 100;

    const sellOrders = orders.filter((o) => o.type === ORDER_TYPES.SELL);
    const buyOrders = orders.filter((o) => o.type === ORDER_TYPES.BUY);

    const sellSizes = allocateFundsByWeights(sellFunds, sellOrders.length, sellWeight, incrementFactor, false, minSellSize, precisionA);
    const buySizes = allocateFundsByWeights(buyFunds, buyOrders.length, buyWeight, incrementFactor, true, minBuySize, precisionB);

    const sellState = { sizes: sellSizes, index: 0 };
    const buyState = { sizes: buySizes, index: 0 };

    return orders.map((order) => {
        let size = 0;
        if (order.type === ORDER_TYPES.SELL) {
            if (sellState.index >= sellState.sizes.length) throw new Error(`calculateOrderSizes: sell index ${sellState.index} out of bounds (len=${sellState.sizes.length})`);
            size = sellState.sizes[sellState.index++];
        } else if (order.type === ORDER_TYPES.BUY) {
            if (buyState.index >= buyState.sizes.length) throw new Error(`calculateOrderSizes: buy index ${buyState.index} out of bounds (len=${buyState.sizes.length})`);
            size = buyState.sizes[buyState.index++];
        }
        return { ...order, size };
    });
}

/**
 * Calculate order sizes for rotation operations.
 * Combines available funds with existing grid allocation for sizing.
 * Used during order refreshes when rotating orders to new positions.
 * 
 * @param {number} availableFunds - Free funds not yet allocated
 * @param {number} totalGridAllocation - Sum of all existing grid order sizes
 * @param {number} orderCount - Number of orders to size
 * @param {string} orderType - Order type (BUY or SELL)
 * @param {Object} config - Configuration with incrementPercent and weightDistribution
 * @param {number} [minSize=0] - Minimum size for each allocation
 * @param {number} [precision=null] - Asset precision for quantization
 * @returns {Array<number>} Array of order sizes
 */
function calculateRotationOrderSizes(availableFunds: number, totalGridAllocation: number, orderCount: number, orderType: string, config: GridConfig, minSize: number = 0, precision: number | null = null): number[] {
    if (orderCount <= 0) return [];
    const totalFunds = availableFunds + totalGridAllocation;
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(orderCount).fill(0);

    const incrementPercent = config.incrementPercent ?? 0;
    const weightDistribution = config.weightDistribution ?? {};
    const incrementFactor = incrementPercent / 100;
    const weight = (orderType === ORDER_TYPES.SELL) ? (weightDistribution.sell ?? 0) : (weightDistribution.buy ?? 0);
    const reverse = (orderType === ORDER_TYPES.BUY);

    return allocateFundsByWeights(totalFunds, orderCount, weight, incrementFactor, reverse, minSize, precision);
}

/**
 * Calculate RMS (Root Mean Square) divergence between calculated and persisted grids.
 * Measures how much the current grid differs from the calculated ideal.
 * Used to determine if grid recalculation is needed.
 *
 * RMS quadratically penalizes large errors and unmatched orders (treated as 100% error).
 * Default 14.3% RMS threshold allows ~3.2% average error concentrated in few orders.
 * See README GRID RECALCULATION section for threshold interpretation table.
 *
 * @param {Array<Object>} calculatedOrders - Ideal/calculated order grid
 * @param {Array<Object>} persistedOrders - Current/persisted order grid
 * @param {string} [sideName='unknown'] - Side name for logging (buy/sell)
 * @returns {number} RMS divergence metric (0 = perfect match, higher = more divergence)
 */
function calculateGridSideDivergenceMetric(calculatedOrders: ManagedOrder[], persistedOrders: ManagedOrder[], _sideName: string = 'unknown'): number {
    if (!Array.isArray(calculatedOrders) || !Array.isArray(persistedOrders)) return 0;
    if (calculatedOrders.length === 0 && persistedOrders.length === 0) return 0;

    const persistedMap = new Map(persistedOrders.filter((o) => o.id).map((o) => [o.id, o]));
    let sumSquaredDiff = 0;
    let matchCount = 0;
    let unmatchedCount = 0;

    for (const calcOrder of calculatedOrders) {
        const persOrder = persistedMap.get(calcOrder.id);
        if (persOrder) {
            const currentSize = toFiniteNumber(persOrder.size);
            const idealSize = toFiniteNumber(calcOrder.size);
            if (idealSize > 0) {
                const relativeDiff = (currentSize - idealSize) / idealSize;
                sumSquaredDiff += relativeDiff * relativeDiff;
                matchCount++;
            } else if (currentSize > 0) {
                sumSquaredDiff += 1.0;
                matchCount++;
            } else {
                matchCount++;
            }
        } else {
            sumSquaredDiff += 1.0;
            unmatchedCount++;
        }
    }

    for (const persOrder of persistedOrders) {
        if (!calculatedOrders.some((c) => c.id === persOrder.id)) {
            sumSquaredDiff += 1.0;
            unmatchedCount++;
        }
    }

    const totalOrders = matchCount + unmatchedCount;
    return totalOrders > 0 ? Math.sqrt(sumSquaredDiff / totalOrders) : 0;
}

// ================================================================================
// SECTION 10: VALIDATION HELPERS
// ================================================================================

/**
 * Calculate estimated BTS order creation fees for a number of orders.
 * Works for all pairs — returns the BTS fee budget needed for order operations.
 * 
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol (unused in calculation, kept for signature compat)
 * @param {number} totalOrders - Number of orders to create
 * @param {number} [feeMultiplier=BTS_RESERVATION_MULTIPLIER] - Multiplier for reservation (typically 5x)
 * @returns {number} Total fee amount (fallback BTS_FALLBACK_FEE if fee lookup fails; warning logged)
 */
function calculateOrderCreationFees(assetA: string | undefined, assetB: string | undefined, totalOrders: number, feeMultiplier: number = FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER) {
    try {
        if (totalOrders > 0) {
            const btsFeeData = getAssetFees('BTS') as { createFee?: number };
            return (btsFeeData.createFee ?? 0) * totalOrders * feeMultiplier;
        }
    } catch (err) {
        const key = `${assetA}/${assetB}`;
        if (!warnedMissingFeeCachePairs.has(key)) {
            warnedMissingFeeCachePairs.add(key);
            mathLogger.warn(`calculateOrderCreationFees: fee cache unavailable for ${key}: ${getErrorMessage(err)}. Using fallback fee.`);
        }
        return FEE_PARAMETERS.BTS_FALLBACK_FEE;
    }
    return 0;
}

/**
 * Calculate how much input asset to swap into a constant-product AMM pool
 * to receive a target amount of output asset.
 *
 * Formula: k = reserveIn * reserveOut
 *          newReserveOut = reserveOut - targetReceive
 *          newReserveIn = k / newReserveOut
 *          sellAmount = newReserveIn - reserveIn
 *
 * Caps swap at 50% of pool reserves to prevent extreme slippage.
 *
 * @param {number} targetReceive - Desired amount of output asset
 * @param {number} poolReserveOut - Pool reserve of output asset
 * @param {number} poolReserveIn - Pool reserve of input asset
 * @returns {number} Amount of input asset to sell
 */
function calculateSwapInAmount(targetReceive: number, poolReserveOut: number, poolReserveIn: number): number {
    if (targetReceive <= 0 || poolReserveOut <= 0 || poolReserveIn <= 0) return 0;
    let effectiveTarget = targetReceive;
    if (effectiveTarget >= poolReserveOut * 0.5) {
        effectiveTarget = poolReserveOut * 0.5;
    }
    const k = poolReserveIn * poolReserveOut;
    const newReserveOut = poolReserveOut - effectiveTarget;
    if (newReserveOut <= 0) return 0;
    const newReserveIn = k / newReserveOut;
    return newReserveIn - poolReserveIn;
}

/**
 * Calculate the spread gap size (number of empty slots between BUY and SELL rails).
 * Used by both grid creation and strategy rebalancing to keep spread math consistent.
 *
 * @param {number} incrementPercent - Grid increment percentage
 * @param {number} targetSpreadPercent - Target spread percentage
 * @param {Object} [gridLimits] - Grid limits constants (optional, uses defaults)
 * @returns {number} Number of gap slots
 */
function calculateGapSlots(incrementPercent: number | undefined, targetSpreadPercent: number | undefined, gridLimits: GridLimitsLike = {}): number {
    const DEFAULT_INCREMENT = Number(DEFAULT_CONFIG.incrementPercent);
    const MIN_SPREAD_FACTOR = gridLimits.MIN_SPREAD_FACTOR ?? GRID_LIMITS.MIN_SPREAD_FACTOR;
    const MIN_SPREAD_ORDERS = gridLimits.MIN_SPREAD_ORDERS ?? GRID_LIMITS.MIN_SPREAD_ORDERS;

    const safeIncrement = (Number.isFinite(Number(incrementPercent)) && Number(incrementPercent) > 0) ? Number(incrementPercent) : DEFAULT_INCREMENT;
    const step = 1 + (safeIncrement / 100);
    const minSpreadPercent = safeIncrement * MIN_SPREAD_FACTOR;
    const effectiveTargetSpread = Math.max(targetSpreadPercent || 0, minSpreadPercent);
    const requiredSteps = Math.ceil(Math.log(1 + (effectiveTargetSpread / 100)) / Math.log(step));
    return Math.max(MIN_SPREAD_ORDERS, requiredSteps - 1);
}

/**
 * Calculate sell start index from boundary index and gap slots.
 * sellStartIdx = boundaryIdx + gapSlots + 1
 *
 * Absent-aware: Number(null) === 0 and Number('') === 0 would read "no
 * boundary" as boundary 0 and manufacture a SELL-rail start at gapSlots+1.
 * Unknown geometry (null/undefined/'') returns NaN so any unguarded caller
 * fails closed via Number.isFinite instead of silently rail-biasing slot 0.
 * Every current caller guards first (resolveGapBand, isSlotInRail,
 * isSlotIndexInGapBand, geometryTypeForSlotIndex, the COW stamp paths);
 * this carries the same contract in the helper itself so a future caller
 * cannot bypass it. A genuine 0 boundary still yields gapSlots + 1.
 */
function getSellStartIdx(boundaryIdx: number | string | null | undefined, gapSlots: number | string | null | undefined): number {
    const b = Format.toKnownNumber(boundaryIdx);
    const g = Format.toKnownNumber(gapSlots);
    if (!Number.isFinite(b) || !Number.isFinite(g)) return NaN;
    return b + g + 1;
}

/**
 * Resolve the configured gap-slot count for a manager-like object.
 * Single source of truth for the `_gapSlots ?? calculateGapSlots(config)`
 * pattern — used by resolveGapBand and the COW boundary-commit gate so the
 * two can never disagree on band width.
 */
function resolveGapSlots(manager: { _gapSlots?: number | null; config?: GridConfig | null }): number {
    // Absent-aware: Number('') === 0 is finite, so a '' _gapSlots would pass
    // the finite test as a valid 0 and collapse the band. '' is unknown →
    // fall back to the config-derived gap (same contract as
    // consumePendingFillCrawls' dc87ce01 fallback).
    const raw = Format.toKnownNumber(manager._gapSlots);
    if (Number.isFinite(raw)) {
        return Math.max(0, Math.floor(raw));
    }
    return calculateGapSlots(
        manager.config?.incrementPercent,
        manager.config?.targetSpreadPercent,
        manager.config?.gridLimits
    );
}

/**
 * Resolve gap-band geometry from a manager-like object.
 * Centralises the gap-slots + sellStartIdx computation duplicated across
 * grid.ts, accounting.ts, and grid_reconcile_internal.ts.
 *
 * @param manager - must expose `_gapSlots`, `boundaryIdx`, and `config`
 *   (`incrementPercent`, `targetSpreadPercent`, `gridLimits`).
 * @returns `{ gapSlots, boundaryIdx, sellStartIdx }`.  When `boundaryIdx` is
 *   not a usable number (null, undefined, NaN), both `boundaryIdx` and
 *   `sellStartIdx` are set to `null` — callers should treat this as "no
 *   boundary restored yet" and skip geometry-based filtering.
 */
function resolveGapBand(manager: { _gapSlots?: number | null; boundaryIdx?: number | null; config?: GridConfig | null }): { gapSlots: number; boundaryIdx: number | null; sellStartIdx: number | null } {
    const gapSlots = resolveGapSlots(manager);
    // Absent-aware coercion: Number(null)/Number('') === 0 would silently treat
    // "no boundary" as boundary 0 — a valid index that biases all slots to the
    // SELL rail. toKnownNumber keeps null/undefined/'' as NaN so the unknown
    // state is detectable, while a genuine boundary 0 still returns 0.
    const raw = Format.toKnownNumber(manager.boundaryIdx);
    if (!Number.isFinite(raw)) {
        return { gapSlots, boundaryIdx: null, sellStartIdx: null };
    }
    const sellStartIdx = getSellStartIdx(raw, gapSlots);
    return { gapSlots, boundaryIdx: raw, sellStartIdx };
}

/**
 * Stable reason code for the in-band-placement rejection.  Shared by the
 * validator and isTransientInBandRejection() so a rename cannot silently
 * break the classifier.
 */
const BOUNDARY_REJECT_PLACED_IN_BAND = 'placed_order_in_band';

/**
 * Validate a proposed boundary commit against geometry INDEPENDENT of the
 * mutable committed boundary.
 *
 * resolveGapBand() re-derives sellStartIdx from whatever boundary is committed
 * — a one-time overrun therefore becomes permanent geometry on the next cycle.
 * This gate runs at COW-commit time and rejects boundary values that no honest
 * writer should produce:
 *
 *   1. numeric sanity — finite, integer, non-negative
 *   2. array range   — boundary index exists in the price-sorted slot space
 *      (the same sort used by promotion/`getSlotCorrectType`)
 *   3. sell-rail ceiling — boundary may not exceed the writer ceiling
 *      `[0, N−gapSlots−1]`. The fill-driven deriveTargetBoundary clamps to that
 *      window; a proposal past it could only come from a legacy persisted
 *      snapshot or a buggy future writer, and would self-legalize zero-SELL
 *      geometry via resolveGapBand() on the next cycle.
 *   4. crossed book  — among PLACED orders, the highest boundary-classified
 *      BUY must price strictly below the lowest implied-SELL.  Placed prices
 *      do not depend on the boundary, so this detects an overrun regardless
 *      of which writer produced it.
 *
 * Deliberately NOT checked here: distance from config.startPrice-derived
 * geometry.  Fill-skewed boundaries legitimately sit far from the structural
 * center, so a startPrice-distance rule would false-positive on valid shifts.
 *
 * @param options.rejectInBandPlacements - When true, additionally report a
 *   boundary under which PLACED order(s) sit strictly inside the implied gap
 *   band (stranding).  Note: honest writers CAN produce transient stranding —
 *   SPREAD GUARD (assignGridRoles) deliberately keeps live ACTIVE/PARTIAL
 *   orders rail-typed when a fill-driven boundary crawl moves their slots
 *   into the band (a fill chunk can strand several at once), and GAP-EVAC
 *   heals them per-slot over 2-3 cycles (rotation or cancel-only teeth;
 *   LAST-FILL-GUARD / uncertain-broadcast backpressure may delay it
 *   further).  So it is OFF at commit time (a refusal could not repair it
 *   anyway) but ON for
 *   persisted-state validation — with the caveat that callers must treat a
 *   pure `placed_order_in_band` result (any count, no accompanying
 *   structural signal) as transient (warn + load, GAP-EVAC owns cleanup)
 *   and only treat other reasons as rebuild-worthy.
 *   See isTransientInBandRejection().
 *
 * @returns `{ ok: true }`, or `{ ok: false, reason, detail }` where `reason`
 *   is a stable short code and `detail` carries indices/prices for logs.
 */
function validateBoundaryCommit(
    proposedBoundary: number | null | undefined,
    orders: Iterable<unknown>,
    gapSlots: number,
    options: { rejectInBandPlacements?: boolean; allowInBandSlotIds?: Iterable<string> } = {}
): { ok: boolean; reason?: string; detail?: string } {
    // Absent-aware: null/undefined/'' means "no proposal" (ok), NOT boundary 0,
    // otherwise Number('') === 0 would self-legalize a fake boundary 0 commit.
    // Everything else non-numeric stays FAIL-CLOSED (corrupt/garbage, never
    // ok): this gate also backs validatePersistedBoundary — the disk-trust
    // boundary where a poison value must surface as a rejection (rebuild),
    // not silently pass as "no proposal". Callers pass number | null; the
    // '' branch only exists because '' would otherwise coerce to 0 via
    // Number() and read as a valid boundary index.
    if ((proposedBoundary as unknown) === '' || proposedBoundary == null) return { ok: true };
    const raw = Number(proposedBoundary);
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
        return { ok: false, reason: 'non_integer_boundary', detail: `proposed=${proposedBoundary}` };
    }
    if (raw < 0) {
        return { ok: false, reason: 'negative_boundary', detail: `proposed=${raw}` };
    }

    const sorted = Array.from(orders ?? [])
        .filter((raw): raw is { price: number; orderId?: string | null } => {
            if (!raw || typeof raw !== 'object') return false;
            const p = (raw as { price?: unknown }).price;
            return p != null && Number.isFinite(Number(p));
        })
        .sort((a, b) => Number(a.price) - Number(b.price));
    const maxIdx = sorted.length - 1;
    if (raw > maxIdx) {
        return { ok: false, reason: 'boundary_out_of_range', detail: `proposed=${raw} maxIdx=${maxIdx}` };
    }

    // Sell-rail ceiling: align the gate with the shared writer window
    // [0, N−gapSlots−1]. Skipped for degenerate geometries (fewer slots than
    // the gap band needs), where no boundary satisfies it and legacy behavior
    // applies.
    const sellRailCeiling = maxIdx - gapSlots;
    if (sellRailCeiling >= 0 && raw > sellRailCeiling) {
        return {
            ok: false,
            reason: 'sell_rail_ceiling_exceeded',
            detail: `proposed=${raw} maxAllowed=${sellRailCeiling} slots=${sorted.length} gapSlots=${gapSlots}`
        };
    }

    const sellStart = raw + gapSlots + 1;
    let maxBuyPrice = -Infinity;
    let minSellPrice = Infinity;
    // Strands are RECORDED, not returned immediately: crossed-book is the
    // stronger structural signal and is computed from rail slots only, so it
    // takes precedence over a co-occurring strand — otherwise a snapshot that
    // is both stranded AND crossed would be misclassified as transient and
    // loaded.  (Recording also fixes a latent miss: the old early-return
    // skipped rail slots after the first strand, under-computing the cross.)
    // Every strand is counted for the detail line; any pure-stranding result
    // (no cross) is transient regardless of count — fill chunks can strand
    // several slots at once and GAP-EVAC tracks/heals per-slot.
    let inBandCount = 0;
    let firstInBandIdx: number | null = null;
    let firstInBandPrice: number | null = null;
    // Explicit allow-list for the fill's OWN residual order (partial fill at
    // the anchor slot). A re-anchor to `fillSlot - gapSlots` necessarily puts
    // that residual inside the implied band; refusing it deadlocks the
    // geometry (the residual cannot be cancelled by the re-anchor itself).
    // Callers must pass only the last-fill residual id — ACTIVE/foreign
    // in-band placements stay rejected.
    const allowedInBand = options.allowInBandSlotIds
        ? new Set(Array.from(options.allowInBandSlotIds).filter((id): id is string => typeof id === 'string' && id.length > 0))
        : null;
    for (let idx = 0; idx < sorted.length; idx++) {
        const o = sorted[idx];
        if (!o.orderId) continue;
        const price = Number(o.price);
        if (idx <= raw) {
            if (price > maxBuyPrice) maxBuyPrice = price;
        } else if (idx >= sellStart) {
            if (price < minSellPrice) minSellPrice = price;
        } else if (options.rejectInBandPlacements) {
            const slotId = (o as { id?: unknown }).id;
            if (allowedInBand && typeof slotId === 'string' && allowedInBand.has(slotId)) continue;
            inBandCount++;
            if (firstInBandIdx === null) {
                firstInBandIdx = idx;
                firstInBandPrice = price;
            }
        }
    }
    if (Number.isFinite(maxBuyPrice) && Number.isFinite(minSellPrice) && minSellPrice <= maxBuyPrice) {
        return {
            ok: false,
            reason: 'crossed_book_geometry',
            detail: `boundary=${raw} gapSlots=${gapSlots} bestPlacedBuy=${maxBuyPrice} >= bestImpliedSell=${minSellPrice}`
        };
    }
    if (inBandCount > 0) {
        return {
            ok: false,
            reason: BOUNDARY_REJECT_PLACED_IN_BAND,
            detail: `boundary=${raw} gapSlots=${gapSlots} placed count=${inBandCount} first idx=${firstInBandIdx} price=${firstInBandPrice} ` +
                `sits strictly inside implied band (${raw}, ${sellStart})`
        };
    }
    return { ok: true };
}

/**
 * Validate a boundary restored from PERSISTED state (disk snapshot) before it
 * is trusted for grid geometry.
 *
 * Disk state crosses a trust boundary the in-memory commit gate does not: any
 * writer bug (e.g. the pre-5eb3ca7 promotion overrun) may have committed AND
 * persisted an invalid boundary that would otherwise legalize itself on every
 * restart.  This is strictly stricter than validateBoundaryCommit — it also
 * reports stranding (a placed order inside the implied band).
 *
 * Stranding alone is NOT proof of poison: SPREAD GUARD + GAP-EVAC produce it
 * transiently on every boundary crawl (see validateBoundaryCommit docs).
 * Callers must use isTransientInBandRejection() to separate the transient
 * case (warn + keep boundary, GAP-EVAC/sync sweeps own cleanup) from true
 * poison (ceiling/range/crossed-book, or recurring stranding) which falls
 * back to rebuild/re-derivation.
 *
 * Callers:
 * - loadGrid (grid.ts) before _restoreBoundary — strict by default; pass
 *   { tolerateTransientStranding: true } when the caller owns the heal path
 *   (runtime recovery: in-memory state is newer than the snapshot and
 *   GAP-EVAC is already tracking the strand).
 * - recoverFromPersistedGrid (dexbot_state_recovery.ts) BEFORE loading —
 *   tolerates transient stranding (warn + load) so a stale snapshot carrying
 *   a pre-evacuation strand cannot force a structural resync that wipes the
 *   in-progress evacuation; true poison still refuses and structural resync
 *   falls through to the clean full-grid reset instead of re-ingesting damage.
 */
function validatePersistedBoundary(
    proposedBoundary: number | null | undefined,
    orders: Iterable<unknown>,
    gapSlots: number,
    options: { allowInBandSlotIds?: Iterable<string> } = {}
): { ok: boolean; reason?: string; detail?: string } {
    return validateBoundaryCommit(proposedBoundary, orders, gapSlots, {
        rejectInBandPlacements: true,
        ...(options.allowInBandSlotIds ? { allowInBandSlotIds: options.allowInBandSlotIds } : {})
    });
}

/**
 * Whether a persisted-boundary rejection is the TRANSIENT kind that must not
 * trigger a rebuild: stranding (`placed_order_in_band`) with no accompanying
 * structural signal.
 *
 * SPREAD GUARD strands live orders in-band on every fill-driven crawl (any
 * count — a fill chunk can strand several) and GAP-EVAC heals them per-slot
 * over 2-3 cycles, so a snapshot taken mid-evacuation (or stale by one
 * crawl, as in recovery-before-CREATE) legitimately reports this.  Nuking
 * the snapshot for it discards the boundary progression, pending crawls,
 * streaks and the queued evacuation — the exact sabotage loop seen in <bot>
 * 2026-09-13 (GAP-EVAC flags slot-96, COW plans 96→116, stale snapshot with
 * slot-94 still stranded fails validation, structural resync wipes the
 * plan).  All other reasons (ceiling/range/crossed-book/...) are structural
 * and stay rebuild-worthy; crossed-book is evaluated first by the validator
 * so a simultaneously-stranded-and-crossed snapshot is never misclassified
 * as transient here.
 *
 * @param check - validatePersistedBoundary / validateBoundaryCommit result
 * @returns True when the check is pure in-band placement (transient).
 */
function isTransientInBandRejection(check: { ok?: boolean; reason?: string; [key: string]: unknown } | null | undefined): boolean {
    return !!check && check.ok !== true && check.reason === BOUNDARY_REJECT_PLACED_IN_BAND;
}

/**
 * Count SPREAD-typed slots strictly inside the gap band
 * (`boundaryIdx < idx < sellStartIdx`).  Empty slots are normalized to SPREAD
 * (side-neutral), so a raw `type === SPREAD` count would include every empty
 * slot on both rails.  The metric means "how many SPREAD slots occupy the
 * spread gap" (target = gapSlots), so require both SPREAD type and band
 * geometry — matching grid creation, which sets initialSpreadCount = gapSlots.
 *
 * @param manager - Manager holding `_gapSlots`, `boundaryIdx`, `config`.
 * @param orders - Iterable of order slots.
 * @param resolveIndex - Per-call slot-index resolver (array position or parsed
 *   slot id); receives `(order, arrayIndex)` and returns `null` when unknown.
 * @returns Count of SPREAD slots inside the gap band, or — when no usable
 *   boundary is restored — the total count of SPREAD-typed slots (fallback).
 */
function countGapBandSpread(manager: OrderManagerLike, orders: Iterable<ManagedOrder>, resolveIndex: (order: ManagedOrder, arrayIndex: number) => number | null): number {
    const resolved = resolveGapBand(manager);
    if (resolved.boundaryIdx === null || resolved.sellStartIdx === null) {
        return Array.from(orders).filter((o) => o?.type === ORDER_TYPES.SPREAD).length;
    }
    let count = 0;
    let arrayIndex = 0;
    for (const o of orders) {
        const idx = resolveIndex(o, arrayIndex);
        if (o?.type === ORDER_TYPES.SPREAD && idx !== null && idx > resolved.boundaryIdx && idx < resolved.sellStartIdx) {
            count++;
        }
        arrayIndex++;
    }
    return count;
}

/**
 * Pure geometric rail-membership test for a grid slot.
 *
 * Classifies a slot by index for a given boundary/gap geometry: BUY slots live
 * at or below the boundary, SELL slots at or above sellStartIdx
 * (boundary + gapSlots + 1), and the band between them holds the spread.
 *
 * Centralises the in-rail exclusion previously duplicated inline across the
 * strategy window (strategy.ts), virtual-slot activation
 * (grid_reconcile_internal.ts), and the COW divergence correction (system.ts).
 * Drift between those copies is what let a fund-driven boundary shift leave a
 * SPREAD GUARD-typed stray inside the gap as "closest to market" — collapsing
 * the spread (<bot>: boundary 107→110 left the sell rail parked at 111-130
 * with the bottom three, 111-113, inside the new spread gap; real spread 0.5%
 * vs the 2.0% target).
 *
 * @param {number|null} boundaryIdx - Working boundary index.  null/undefined
 *   (or non-finite) means "boundary unknown" and the slot is NOT excluded
 *   (returns true), mirroring grid_reconcile_internal's boundaryKnown guard.
 * @param {number} gapSlots - Spread gap slot count.  A non-finite value means
 *   the SELL start cannot be derived, so the slot is not excluded.
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL.
 * @param {unknown} slot - Grid slot (or any object exposing an id like `slot-3`);
 *   slots with an unparseable id are admitted (returns true): geometry cannot
 *   identify the gap for legacy ids, so windowing falls back to the stored
 *   slot type exactly as pre-1.4.25 did (fail-open; consumers still reject
 *   SPREAD-typed/empty slots via their type filters).
 * @returns {boolean} true when the slot sits inside the requested rail or its
 *   geometry cannot be determined (fail-open), false only when a parseable id
 *   sits provably outside the rail.
 */
function isSlotInRail(boundaryIdx: number | null, gapSlots: number | null, orderType: string, slot: { id?: string } | null | undefined): boolean {
    // Absent-aware: ''/null/undefined is unknown geometry → fail open, never a
    // boundary of 0 (Number('') === 0 would otherwise exclude valid slots).
    const boundary = Format.toKnownNumber(boundaryIdx);
    if (!Number.isFinite(boundary)) return true;
    const parsed = parseSlotIndex(slot?.id);
    if (parsed === null) return true;
    const idx = parsed;
    if (orderType === ORDER_TYPES.BUY) return idx <= boundary;
    if (orderType !== ORDER_TYPES.SELL) return true;
    // The SELL rail needs the gap width; unknown gap → cannot derive sellStart
    // → fail open (same contract as the unknown-boundary branch above).
    const gap = Format.toKnownNumber(gapSlots);
    if (!Number.isFinite(gap)) return true;
    const sellStartIdx = getSellStartIdx(boundary, gap);
    if (!Number.isFinite(sellStartIdx)) return true;
    return idx >= sellStartIdx;
}

/**
 * Whether a slot index sits inside the gap (spread) band: strictly between
 * the last BUY index (boundary) and the first SELL index. Geometry-only —
 * never consults the stored slot type, so it keeps working after rail-typed
 * holes (Phase 2) retype in-band actives to BUY/SELL.
 *
 * @param {number|null} idx - Parsed slot index (parseSlotIndex output)
 * @param {number} boundaryIdx - Last BUY slot index
 * @param {number} gapSlots - Spread gap slot count
 * @returns {boolean} True when the index is inside the gap band
 */
function isSlotIndexInGapBand(idx: number | string | null | undefined, boundaryIdx: number | string | null | undefined, gapSlots: number): boolean {
    // Absent-aware: Number(null)/Number('') === 0 must never read as slot 0,
    // and an unknown gap width must not collapse the band (null → 0).
    const n = Format.toKnownNumber(idx);
    const b = Format.toKnownNumber(boundaryIdx);
    const g = Format.toKnownNumber(gapSlots);
    if (!Number.isFinite(n) || !Number.isFinite(b) || !Number.isFinite(g)) return false;
    const sellStartIdx = getSellStartIdx(b, g);
    if (!Number.isFinite(sellStartIdx)) return false;
    return n > b && n < sellStartIdx;
}

/**
 * Pure stamped-evacuation size re-proof: a B-stamped (plan-build-proven)
 * evacuation bypasses the live probe, but the plan was built against the
 * booked size at plan time. An unprocessed fill landing between plan-build
 * and execution shrinks the booked remaining below the planned size — the
 * PARTIAL-only growth guard at the execution site misses it when the slot
 * is not (yet) PARTIAL. Re-prove the size against the LIVE booked
 * remaining (masterOrder.size) before honoring the stamp: fail closed
 * (false → live probe) when the booked remaining is non-finite or <= 0.
 *
 * Int-compare via floatToBlockchainInt when a finite precision is supplied
 * (bit-exact on-chain semantics, consistent with
 * isEvacuationRotationAllowed), else a strict numeric <= (never a float
 * epsilon).
 *
 * @param {number} newSize - Rotation destination size (planned)
 * @param {number} bookedRemaining - Live booked remaining (master grid)
 * @param {number} [precision] - Asset precision for bit-exact int compare
 * @returns {boolean} True when the planned size is still covered by the booking
 */
function isEvacuationSizeStillValid(newSize: number, bookedRemaining: number, precision: number | null = null): boolean {
    const nS = Number(newSize);
    const bR = Number(bookedRemaining);
    if (!Number.isFinite(nS) || nS <= 0) return false;
    if (!Number.isFinite(bR) || bR <= 0) return false;
    if (precision != null && Number.isFinite(Number(precision))) {
        try {
            return floatToBlockchainInt(nS, Number(precision)) <= floatToBlockchainInt(bR, Number(precision));
        } catch {
            return nS <= bR;
        }
    }
    return nS <= bR;
}

/**
 * Pure gap-evacuation rotation allowance: decides whether a slot-to-slot
 * rotation (UPDATE with newGridId) reduces the violation surface enough to
 * bypass the LAST-FILL guard. Unit-testable in isolation — the guard block
 * stays thin and only wires origin/geometry/fail-closed around this.
 *
 * Allowance requires ALL of:
 * - type is BUY or SELL (gap-evacuation moves a committed rail order;
 *   CREATEs carry no source slot and never qualify),
 * - old/new price and old/new size are finite, newSize > 0,
 * - size is bit-exact non-growing: floatToBlockchainInt(newSize) <=
 *   floatToBlockchainInt(oldSize) when a finite precision is supplied,
 *   otherwise a strict numeric <= (never a float epsilon),
 * - price moves outward onto the rail, away from the gap: SELL
 *   newPrice >= oldPrice, BUY newPrice <= oldPrice. An evacuation that
 *   reprices toward (or across) the gap is not violation-reducing.
 *
 * @param {number} oldPrice - Source slot price (master, pre-rotation)
 * @param {number} oldSize - Source slot booked size (master, pre-rotation)
 * @param {number} newPrice - Rotation destination price
 * @param {number} newSize - Rotation destination size (clamped)
 * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} [precision] - Asset precision for bit-exact int compare
 * @returns {{allowed: boolean, reason: string}}
 */
function isEvacuationRotationAllowed(oldPrice: unknown, oldSize: unknown, newPrice: unknown, newSize: unknown, type: string, precision: number | null = null): { allowed: boolean; reason: string } {
    if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) {
        return { allowed: false, reason: `type ${String(type)} is not a rail type` };
    }
    const oP = Number(oldPrice);
    const oS = Number(oldSize);
    const nP = Number(newPrice);
    const nS = Number(newSize);
    if (!Number.isFinite(oP) || oP <= 0) return { allowed: false, reason: 'oldPrice unresolvable' };
    if (!Number.isFinite(oS) || oS <= 0) return { allowed: false, reason: 'oldSize unresolvable' };
    if (!Number.isFinite(nP) || nP <= 0) return { allowed: false, reason: 'newPrice invalid' };
    if (!Number.isFinite(nS) || nS <= 0) return { allowed: false, reason: 'newSize invalid' };
    let grew: boolean;
    if (precision != null && Number.isFinite(Number(precision))) {
        try {
            grew = floatToBlockchainInt(nS, Number(precision)) > floatToBlockchainInt(oS, Number(precision));
        } catch {
            grew = nS > oS;
        }
    } else {
        grew = nS > oS;
    }
    if (grew) return { allowed: false, reason: 'rotation grows booked size' };
    if (type === ORDER_TYPES.SELL && nP < oP) {
        return { allowed: false, reason: 'SELL evacuation must not reprice toward the gap' };
    }
    if (type === ORDER_TYPES.BUY && nP > oP) {
        return { allowed: false, reason: 'BUY evacuation must not reprice toward the gap' };
    }
    return { allowed: true, reason: 'evacuation reduces violation surface (outward repricing, non-growing size)' };
}

// ================================================================================
// SECTION 10: GENESIS PRICE-SLOT DETERMINISM
// ================================================================================

export type GridGenesis = {
    startPrice: number;
    incrementPercent: number;
    gapSlots: number;
    priceLevels: number[];
    priceLevelsHash: string;
    createdAt: number;
};

function hashPriceLevels(priceLevels: number[]): string {
    // Simple deterministic hash: join with high precision and hash via tiny FNV.
    const str = priceLevels.map(p => p.toFixed(12)).join('|');
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function priceLevelsForGenesis(genesis: GridGenesis): number[] {
    return [...genesis.priceLevels];
}

function priceForSlot(idx: number, genesis: GridGenesis): number {
    if (!genesis || !Array.isArray(genesis.priceLevels)) throw new Error('Invalid genesis for priceForSlot');
    if (idx < 0 || idx >= genesis.priceLevels.length) throw new Error(`Slot index ${idx} out of bounds (0..${genesis.priceLevels.length - 1})`);
    return genesis.priceLevels[idx];
}

function slotIndexForPrice(price: number, genesis: GridGenesis): number {
    const levels = genesis?.priceLevels;
    if (!Array.isArray(levels) || levels.length === 0) throw new Error('Invalid genesis priceLevels for slotIndexForPrice');
    if (!Number.isFinite(price)) throw new Error(`slotIndexForPrice: non-finite price ${price}`);
    if (price <= levels[0]) return 0;
    if (price >= levels[levels.length - 1]) return levels.length - 1;
    // Binary search for nearest index (levels are sorted ascending).
    let lo = 0;
    let hi = levels.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const midPrice = levels[mid];
        if (midPrice === price) return mid;
        if (midPrice < price) lo = mid + 1;
        else hi = mid - 1;
    }
    // lo is insertion point, hi = lo - 1
    const lower = hi;
    const upper = lo;
    if (lower < 0) return upper;
    if (upper >= levels.length) return lower;
    const diffLower = Math.abs(price - levels[lower]);
    const diffUpper = Math.abs(levels[upper] - price);
    // Tie → lower wins (deterministic)
    return diffLower <= diffUpper ? lower : upper;
}

function slotIdForPrice(price: number, genesis: GridGenesis): string {
    return `slot-${slotIndexForPrice(price, genesis)}`;
}
/**
 * Whether a chain price sits outside the frozen genesis rail.
 * slotIndexForPrice clamps out-of-range prices onto the edge slots (0/N-1),
 * so callers MUST check this before adopting or duplicate-matching: a
 * below-grid buy is not slot-0 and an above-grid sell is not slot-(N-1).
 * Only genuine float dust at the edge is excused; anything further out is
 * out-of-grid -> hold/defer, never adopt or cancel as a duplicate.
 *
 * The edge excuse is the chain-representable tolerance (pricesOnSameLevel),
 * clamped to half a ladder step. Deliberately NOT priceSlotEqual at the asset
 * precision: a price is not an amount, so a precision-4 asset rounds a whole
 * adjacent band below the rail onto the edge and wrongly classifies a
 * dip-protection level as in-grid (fail-open). When assets/type are missing,
 * only float noise at the edge is excused (exact-level identity), so an
 * unjudgeable outside price stays out-of-grid (fail-closed).
 */
function isChainPriceOutOfGrid(
    price: number,
    genesis: GridGenesis,
    size: number = 0,
    type: string | null = null,
    assets: AssetPair | null = null
): boolean {
    const levels = genesis?.priceLevels;
    if (!Array.isArray(levels) || levels.length === 0) return false;
    if (!Number.isFinite(price)) return false;
    const min = levels[0];
    const max = levels[levels.length - 1];
    const incrementPercent = levels.length > 1 && Number(levels[0]) > 0
        ? ((Number(levels[1]) - Number(levels[0])) / Number(levels[0])) * 100
        : null;
    const onEdge = (edge: number): boolean =>
        (assets != null && type != null)
            ? pricesOnSameLevel(price, size, type, edge, size, type, assets, incrementPercent)
            : sameGridPrice(price, edge);
    if (price < min && !onEdge(min)) return true;
    if (price > max && !onEdge(max)) return true;
    return false;
}

function assertSlotPriceInvariant(slot: unknown, genesis: GridGenesis): void {
    const s = slot as { id?: string; price?: number } | null | undefined;
    const idx = parseSlotIndex(s?.id);
    if (idx === null) throw new Error(`assertSlotPriceInvariant: unparseable slot id ${s?.id}`);
    const expected = priceForSlot(idx, genesis);
    // Use blockchain integer equality for single-epsilon check.
    // Need asset precision: fall back to generic epsilon if unknown.
    // For invariant we use absolute relative tolerance 1e-9 or integer check when precision known.
    const price = Number(s?.price);
    if (!Number.isFinite(price)) throw new Error(`assertSlotPriceInvariant: slot ${s?.id} has non-finite price`);
    // If slot has no asset context, use tight epsilon.
    const diff = Math.abs(price - expected);
    const rel = diff / Math.max(1e-12, Math.abs(expected));
    if (rel > 1e-9 && diff > 1e-12) {
        throw new Error(`Slot price invariant violated for ${s?.id}: price ${price} != expected ${expected} (idx ${idx})`);
    }
}

function priceSlotEqual(a: number, b: number, precision: number): boolean {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (!Number.isFinite(precision)) return a === b;
    try {
        return floatToBlockchainInt(a, precision) === floatToBlockchainInt(b, precision);
    } catch {
        return a === b;
    }
}

/**
 * Derive the geometric price ladder (the "rail") from a live config.
 *
 * SINGLE SOURCE OF TRUTH for rail geometry: `createOrderGrid` (fresh build)
 * and `buildGenesisFromLiveRail` (legacy-snapshot migration) MUST agree
 * exactly, or a migrated genesis would describe a different ladder than a
 * freshly built grid of the same config -- making the migration cross-check
 * reject a snapshot it should adopt, or adopt one that no longer matches a
 * rebuild. Both callers go through here; neither re-implements the loop.
 *
 * Returns the ascending, deduped levels (dedupe uses `toFixed(12)` equality so
 * `floatToBlockchainInt` collisions collapse and slot-N <-> index stays
 * stable); throws if the loops cannot advance or produce nothing.
 *
 * Config validation (finiteness, price bounds, increment bounds) is deliberately
 * left to the callers: `createOrderGrid` validates strictly, while the migration
 * path builds a candidate ladder for a finite-but-out-of-bounds config so the
 * slot cross-check — not an input error — rejects it. The only guard here is the
 * one that prevents non-termination, which no caller could recover from.
 */
function derivePriceLevels(
    startPrice: number,
    minPrice: number,
    maxPrice: number,
    incrementPercent: number
): number[] {
    const stepUp = 1 + (incrementPercent / 100);
    const stepDown = 1 - (incrementPercent / 100);
    // Non-termination guard. For `stepUp === 1` (incrementPercent <= 0, or so
    // small it underflows `1 + inc/100`) the ascending loop multiplies by
    // exactly 1 and never ends; likewise `stepDown === 1` on the descending
    // loop. Everything else (finiteness, bounds, increment bounds) is the
    // CALLER's validation — kept there so the migration path can build a
    // candidate ladder for an out-of-bounds-but-finite config and let the
    // slot cross-check reject it, instead of failing as a config error.
    if (!(stepUp > 1) || !(stepDown < 1)) {
        throw new Error(
            `Invalid incrementPercent: ${incrementPercent}. Must be large enough to advance the geometric rail.`
        );
    }
    const priceLevels: number[] = [];

    // Expand outward from startPrice so the grid is centered on the market price.
    let upPrice = startPrice * Math.sqrt(stepUp);
    while (upPrice <= maxPrice) {
        priceLevels.push(upPrice);
        upPrice *= stepUp;
    }
    let downPrice = startPrice * Math.sqrt(stepDown);
    while (downPrice >= minPrice) {
        priceLevels.push(downPrice);
        downPrice *= stepDown;
    }
    priceLevels.sort((a, b) => a - b);

    // Dedupe levels that collide at float precision.
    const seen = new Set<string>();
    const deduped: number[] = [];
    for (const p of priceLevels) {
        const key = Number(p).toFixed(12);
        if (!seen.has(key)) { seen.add(key); deduped.push(p); }
    }

    if (deduped.length === 0) {
        throw new Error(
            `Grid generation produced no price levels for startPrice=${startPrice}, ` +
            `bounds=[${minPrice}, ${maxPrice}], incrementPercent=${incrementPercent}. ` +
            `Widen bounds or reduce incrementPercent.`
        );
    }
    return deduped;
}

function buildGenesisFromPriceLevels(startPrice: number, incrementPercent: number, gapSlots: number, priceLevels: number[]): GridGenesis {
    const hash = hashPriceLevels(priceLevels);
    return {
        startPrice,
        incrementPercent,
        gapSlots,
        priceLevels: [...priceLevels],
        priceLevelsHash: hash,
        createdAt: Date.now()
    };
}

export type { FeeCacheEntry };

export { getBtsSide, getSellStartIdx, resolveGapBand, countGapBandSpread, calculateGapSlots, isSlotInRail, isSlotIndexInGapBand, isEvacuationRotationAllowed, isEvacuationSizeStillValid, validateBoundaryCommit, validatePersistedBoundary, isTransientInBandRejection, BOUNDARY_REJECT_PLACED_IN_BAND, resolveGapSlots, isPercentageString, isPositiveNumber, isPositiveNumberOrPercent, isPositiveInt, parsePercentageString, toDecimal, resolveRelativePrice, parseRelativeMultiplier, validateGridPriceBounds, isExplicitZeroAllocation, getPrecision, computeChainFundTotals, calculateAvailableFundsValue, deriveChainTruthFundBudget, adjustBudgetForBtsFees, getGridBestPrices, calculateSpreadFromOrders, resolveConfigValue, resolveConfigValueWithRegistry, hasValidAccountTotals, blockchainToFloat, floatToBlockchainInt, floorToBlockchainInt, quantizeFloat, normalizeInt, getPrecisionByOrderType, getPrecisionsForManager, getPrecisionSlack, quantumForPrecision, calculatePriceTolerance, findCrossedOrder, pricesOnSameLevel, sameGridPrice, validateOrderAmountsWithinLimits, getMinOrderSize, getDustThresholdFactor, getSingleDustThreshold, getDoubleDustThreshold, validateOrderSize, getAssetFees, getAssetFeesSafe, allocateFundsByWeights, calculateOrderSizes, calculateRotationOrderSizes, calculateGridSideDivergenceMetric, calculateOrderCreationFees, calculateSwapInAmount, _setFeeCache, cloneWeightDistribution, clamp, roundTo, fixedTo, roundToDecimals, priceLevelsForGenesis, priceForSlot, slotIndexForPrice, slotIdForPrice, assertSlotPriceInvariant, priceSlotEqual, derivePriceLevels, sameGridLevel, buildGenesisFromPriceLevels, hashPriceLevels, isChainPriceOutOfGrid }

/**
 * Round a value to a given factor.
 * @param {number} value - Value to round
 * @param {number} factor - Rounding factor (e.g. 100 for 2 decimals)
 * @returns {number}
 */
function roundTo(value: number, factor: number): number {
    if (!Number.isFinite(value)) return NaN;
    return Math.round(value * factor) / factor;
}

/**
 * Format a number to a fixed number of decimal places.
 * @param {number|string} value - Value to format
 * @param {number} decimals - Number of decimal places
 * @returns {string}
 */
function fixedTo(value: number | string, decimals: number): string {
    return Number(value).toFixed(decimals);
}

/**
 * Round a value to a given number of decimal places.
 * @param {number} value - Value to round
 * @param {number} decimals - Number of decimal places
 * @returns {number}
 */
function roundToDecimals(value: number, decimals: number): number {
    if (!Number.isFinite(value)) return NaN;
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

/**
 * Clamp a value between min and max bounds.
 * @param {number} value - The value to clamp
 * @param {number} min - Lower bound
 * @param {number} max - Upper bound
 * @returns {number}
 */
function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Safely clone a weight distribution object.
 * Validates numeric sell/buy values and falls back to a base object if provided.
 * Returns null if neither primary nor base yields valid numbers.
 *
 * @param {Object|null} weightDistribution - Primary weights (e.g. { sell, buy })
 * @param {Object|null} base - Fallback weights if primary is missing/invalid
 * @returns {{sell:number,buy:number}|null}
 */
function cloneWeightDistribution(weightDistribution: WeightDistributionConfig | null | undefined, base: WeightDistributionConfig | null = null): { sell: number; buy: number } | null {
    const source = (weightDistribution && typeof weightDistribution === 'object')
        ? weightDistribution
        : (base && typeof base === 'object' ? base : null);
    if (!source) return null;

    const sell = Number(source.sell);
    const buy = Number(source.buy);
    if (!Number.isFinite(sell) || !Number.isFinite(buy)) return null;

    return { sell, buy };
}


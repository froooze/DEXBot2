/**
 * modules/order/utils/math.ts - Mathematical and Numeric Utilities
 * 
 * Pure numeric calculations, blockchain conversions, fee math, and fund allocation.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (44 exported functions)
 * ===============================================================================
 *
 * SECTION 1: PARSING & VALIDATION (6 functions)
 *   - isExplicitZeroAllocation(value) - Check if value is explicitly zero
 *   - isPercentageString(v) - Check if value is percentage string
 *   - parsePercentageString(v) - Parse percentage string to decimal
 *   - parseRelativeMultiplier(value) - Parse "3x" multiplier syntax to number
 *   - resolveRelativePrice(value, startPrice, mode) - Resolve relative price values
 *   - validateGridPriceBounds(min, max, center) - Reject bounds not bracketing center
 *
 * SECTION 2: FUND CALCULATIONS (4 functions)
 *   - computeChainFundTotals(accountTotals, committedChain) - Compute total funds
 *   - calculateAvailableFundsValue(side, accountTotals, funds, ...) - Calculate available funds
 *   - calculateSpreadFromOrders(activeBuys, activeSells) - Calculate spread percentage
 *   - resolveConfigValue(value, total) - Resolve percentage or absolute config value
 *
 * SECTION 3: BLOCKCHAIN CONVERSIONS (5 functions)
 *   - blockchainToFloat(intValue, precision) - Convert blockchain int to float
 *   - floatToBlockchainInt(floatValue, precision) - Convert float to blockchain int
 *   - quantizeFloat(value, precision) - Round float to blockchain precision
 *   - normalizeInt(value, precision) - Normalize int within precision bounds
 *   - hasValidAccountTotals(accountTotals, checkFree) - Validate account totals structure
 *
 * SECTION 4: PRECISION & FORMATTING UTILITIES (8 functions)
 *   - roundTo(value, factor) - Round to a factor
 *   - fixedTo(value, decimals) - Format to fixed decimal string
 *   - roundToDecimals(value, decimals) - Round to N decimal places
 *   - getPrecision(assets, orderType) - Get precision for order type
 *   - getPrecisionByOrderType(assets, orderType) - Alias for getPrecision
 *   - getPrecisionForSide(assets, side) - Get precision by side (buy/sell)
 *   - getPrecisionsForManager(manager) - Get both asset precisions
 *   - getPrecisionSlack(precision) - Calculate tolerance for precision
 *
 * SECTION 5: ORDER SIZE VALIDATION (7 functions)
 *   - calculatePriceTolerance(price, size, type, assets) - Calculate price match tolerance
 *   - validateOrderAmountsWithinLimits(amountToSell, minToReceive) - Validate order limits
 *   - getMinOrderSize(assets, type) - Get minimum order size for type
 *   - getDustThresholdFactor() - Get dust threshold multiplier
 *   - getSingleDustThreshold(idealSize, dustThresholdPercent) - Get single dust threshold
 *   - getDoubleDustThreshold(idealSize, dustThresholdPercent) - Get double dust threshold
 *   - getMinOrderSize(orderType, assets, factor) - Get minimum order size
 *   - validateOrderSize(manager, size, type, context) - Validate order size against minimums
 *
 * SECTION 6: FEE CALCULATIONS (2 functions + 2 internal)
 *   - getAssetFees(assetSymbol, assetAmount, isMaker) - Get fee info for asset
 *   - _setFeeCache(cache) - Set internal fee cache (internal)
 *   - _getFeeCache() - Get internal fee cache (internal)
 *
 * SECTION 7: FUND ALLOCATION (6 functions)
 *   - allocateFundsByWeights(available, targetCount) - Allocate funds by weight
 *   - cloneWeightDistribution(weightDistribution, base) - Clone weight distribution safely
 *   - calculateOrderSizes(manager, orderType) - Calculate order sizes for placement
 *   - calculateRotationOrderSizes(manager, orderType, fillAmount) - Calculate rotation sizes
 *   - calculateGridSideDivergenceMetric(manager, orderType, threshold) - Calculate divergence
 *   - clamp(value, min, max) - Clamp a value between min and max bounds
 *
 * SECTION 8: FEE DEDUCTION (3 functions)
 *   - calculateOrderCreationFees(count, btsFeeData) - Calculate total creation fees
 *   - deductOrderFeesFromFunds(available, count, btsFeeData, btsSide) - Deduct fees from funds
 *   - calculateSwapInAmount(targetReceive, poolReserveOut, poolReserveIn) - AMM swap math
 *
 * SECTION 9: GRID UTILITIES (1 function)
 *   - calculateGapSlots(incrementPercent, targetSpreadPercent) - Calculate gap slots count
 *
 * ===============================================================================
 */


import { ORDER_TYPES, FEE_PARAMETERS, DEFAULT_CONFIG, GRID_LIMITS } from '../../constants.js';
import * as Format from '../format.js';
import Logger from '../../order/logger.js';
import * as fundRegistry from '../../fund_registry.js';
import { getErrorMessage } from '../../utils/errors.js';
import { parseSlotIndex } from './slot.js';
const { isValidNumber, toFiniteNumber } = Format;
const mathLogger = new Logger('Math');

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
function isExplicitZeroAllocation(value: any) {
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
function isPercentageString(v: any): v is string {
    return typeof v === 'string' && v.trim().endsWith('%');
}

/**
 * Check if a value is a positive number.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is a finite number greater than 0
 */
function isPositiveNumber(value: any) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0;
}

/**
 * Check if a value is a positive number or a positive percentage string.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is a positive number or a percentage string like "25%"
 */
function isPositiveNumberOrPercent(value: any) {
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
function isPositiveInt(value: any) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Parse a percentage string to decimal form.
 * Extracts numeric value before '%' and divides by 100.
 * 
 * @param {string} v - Percentage string (e.g., "50%")
 * @returns {number|null} Decimal form (e.g., 0.5) or null if invalid
 */
function parsePercentageString(v: any) {
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
function toDecimal(value: any) {
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
function parseRelativeMultiplier(value: any) {
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
function resolveRelativePrice(value: any, startPrice: any, mode: any = 'min') {
    const multiplier = parseRelativeMultiplier(value);
    if (multiplier !== null && Number.isFinite(startPrice) && multiplier !== 0) {
        return mode === 'min' ? startPrice / multiplier : startPrice * multiplier;
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
function validateGridPriceBounds(minPrice: any, maxPrice: any, centerPrice: any) {
    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)
        || !Number.isFinite(centerPrice) || centerPrice <= 0) {
        return; // Non-finite/invalid prices are handled by other validators.
    }
    if (minPrice > centerPrice) {
        throw new Error(
            `Geometrically broken grid: resolved minPrice ${minPrice} is above the grid center ${centerPrice}. ` +
            `With min x-multiplier semantics "Nx" means center/N, so a multiplier < 1 (e.g. "0.7x" => ${centerPrice / 0.7}) ` +
            `places the lower bound ABOVE the center. Use a numeric price below the center, or a multiplier > 1 ` +
            `(e.g. "1.43x" for 70% of center).`
        );
    }
    if (maxPrice < centerPrice) {
        throw new Error(
            `Geometrically broken grid: resolved maxPrice ${maxPrice} is below the grid center ${centerPrice}. ` +
            `With max x-multiplier semantics "Nx" means center*N, so a multiplier < 1 (e.g. "0.7x" => ${centerPrice * 0.7}) ` +
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
function computeChainFundTotals(accountTotals: any, committedChain: any) {
    const chainFreeBuy = toFiniteNumber(accountTotals?.buyFree);
    const chainFreeSell = toFiniteNumber(accountTotals?.sellFree);
    const committedChainBuy = toFiniteNumber(committedChain?.buy);
    const committedChainSell = toFiniteNumber(committedChain?.sell);

    const freePlusLockedBuy = chainFreeBuy + committedChainBuy;
    const freePlusLockedSell = chainFreeSell + committedChainSell;

    const chainTotalBuy = isValidNumber(accountTotals?.buy)
        ? Math.max(Number(accountTotals.buy), freePlusLockedBuy)
        : freePlusLockedBuy;
    const chainTotalSell = isValidNumber(accountTotals?.sell)
        ? Math.max(Number(accountTotals.sell), freePlusLockedSell)
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
function quantizeFloat(value: any, precision: any) {
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
function normalizeInt(value: any, precision: any) {
    return floatToBlockchainInt(blockchainToFloat(value, precision), precision);
}

/**
 * Fee cache local to math.js for getAssetFees.
 * Will be populated by system.js::initializeFeeCache.
 */
let feeCache: Record<string, any> = {};

// Track markets already warned about a missing fee cache so the "Using fallback
// fee" notice is logged once per pair instead of once per sizing calculation.
const warnedMissingFeeCachePairs = new Set<string>();

/**
 * @private Set the fee cache (called by system.js::initializeFeeCache).
 *
 * @param {Object} cache - Fee cache object keyed by asset symbol
 * @returns {void}
 */
function _setFeeCache(cache: any) { feeCache = cache; }

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
function getAssetFees(assetSymbol: any, assetAmount: any = null, isMaker: any = true) {
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
            ? Math.max(0, Number(cachedFees.maxMarketFee.float))
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
function getAssetFeesSafe(assetSymbol: any, assetAmount: any = null, isMaker: any = true) {
    try {
        return getAssetFees(assetSymbol, assetAmount, isMaker);
    } catch {
        return null;
    }
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
 * @param {Object} [activeOrders=null] - Active order counts {buy, sell} for BTS reservation calculation
 * @returns {number} Available funds for the side (0 if side invalid or insufficient funds)
 */
function calculateAvailableFundsValue(side: any, accountTotals: any, funds: any, assetA: any, assetB: any, activeOrders: any = null, configMinBtsValue: number | null = null, feeParams: any = null) {
    if (side !== 'buy' && side !== 'sell') return 0;

    const chainFree = toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree);
    const virtualReservation = toFiniteNumber(side === 'buy' ? funds.virtual?.buy : funds.virtual?.sell);
    const btsFeesOwed = toFiniteNumber(funds.btsFeesOwed);
    const btsSide = getBtsSide(assetA, assetB);

    const btsReservationMultiplier = feeParams?.BTS_RESERVATION_MULTIPLIER ?? FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;

    let btsFeesReservation = 0;
    if (btsSide === side && activeOrders) {
        const targetBuy = Math.max(0, toFiniteNumber(activeOrders?.buy, 1));
        const targetSell = Math.max(0, toFiniteNumber(activeOrders?.sell, 1));
        const totalTargetOrders = targetBuy + targetSell;
        btsFeesReservation = calculateOrderCreationFees(assetA, assetB, totalTargetOrders, btsReservationMultiplier);
    }

    const currentFeesOwed = (btsSide === side) ? btsFeesOwed : 0;

    // Non-BTS pair: reserve proportional share for BTS fee budget
    if (!btsSide && activeOrders && funds?.btsBalance != null) {
        const targetBuy = Math.max(0, toFiniteNumber(activeOrders?.buy, 1));
        const targetSell = Math.max(0, toFiniteNumber(activeOrders?.sell, 1));
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
function adjustBudgetForBtsFees(allocated: any, isBtsSide: any, formulaBudget: any, minBtsValue: any, btsFree: any, sideFree: any, totalFree: any) {
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
function getGridBestPrices(activeBuys: any, activeSells: any) {
    const bestBuy  = activeBuys.length  > 0 ? Math.max(...activeBuys.map((o: any) => o.price))  : null;
    const bestSell = activeSells.length > 0 ? Math.min(...activeSells.map((o: any) => o.price)) : null;
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
function calculateSpreadFromOrders(activeBuys: any, activeSells: any) {
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
function resolveConfigValue(value: any, total: any) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const p = parsePercentageString(value);
        if (p !== null) {
            if (total === null || total === undefined) return 0;
            return total * p;
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
function resolveConfigValueWithRegistry(value: any, chainTotal: any, account: any, botName: any, side: any) {
    const effective = fundRegistry.getEffectiveAllocationSync(account, botName, side, chainTotal);
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
function hasValidAccountTotals(accountTotals: any, checkFree: any = true) {
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
function blockchainToFloat(intValue: any, precision: any) {
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
function floatToBlockchainInt(floatValue: any, precision: any) {
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
 * Get asset precision for a specific order type (BUY or SELL).
 * BUY orders size in assetB, SELL orders size in assetA.
 * 
 * @param {Object} assets - Asset metadata with assetA and assetB
 * @param {string} orderType - Order type (ORDER_TYPES.BUY or ORDER_TYPES.SELL)
 * @returns {number} Asset precision
 * @throws {Error} If precision missing for the required asset
 */
function getPrecisionByOrderType(assets: any, orderType: any) {
    return getPrecision(assets, { type: orderType });
}

/**
 * Get asset precisions for both assetA and assetB.
 * 
 * @param {Object} assets - Asset metadata with assetA and assetB
 * @returns {Object} Object with A and B precision properties
 * @throws {Error} If precision missing for either asset
 */
function getPrecisionsForManager(assets: any) {
    return {
        A: getPrecision(assets, { type: ORDER_TYPES.SELL }),
        B: getPrecision(assets, { type: ORDER_TYPES.BUY })
    };
}

/**
 * Compute the quantum (smallest representable unit) for a given asset precision.
 * quantum = 10^-precision (e.g., 8 decimals → 1e-8).
 */
function quantumForPrecision(precision: any): number {
    return Math.pow(10, -precision);
}

/**
 * Calculate precision slack (rounding tolerance) for a given precision level.
 * Used for safe comparison of blockchain values that may differ by rounding.
 * 
 * @param {number} precision - Asset precision level
 * @param {number} [factor=2] - Multiplier for slack (default 2)
 * @returns {number} Tolerance value (e.g., 2 * 10^-8 for 8-decimal precision)
 */
function getPrecisionSlack(precision: any, factor: any = 2) {
    return factor * quantumForPrecision(precision);
}

/**
 * Unified precision lookup for assets.
 * 
 * @param {Object} assets - Assets object with assetA and assetB
 * @param {Object} [options={}] - Lookup options { type, side, proceeds }
 * @returns {number} Asset precision
 */
function getPrecision(assets: any, { type, side, proceeds = false }: { type?: string; side?: string; proceeds?: boolean } = {}) {
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
function getBtsSide(assetA: string, assetB: string): string | null {
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
function calculatePriceTolerance(gridPrice: any, orderSize: any, orderType: any, assets: any = null) {
    if (!isValidNumber(gridPrice) || !isValidNumber(orderSize)) return null;
    if (!assets) throw new Error("CRITICAL: Assets object required for calculatePriceTolerance");

    const precisionA = assets.assetA?.precision;
    const precisionB = assets.assetB?.precision;

    if (typeof precisionA !== 'number' || typeof precisionB !== 'number') {
        throw new Error(`CRITICAL: Missing precision for price tolerance (A=${precisionA}, B=${precisionB})`);
    }

    if (!orderSize || orderSize <= 0) return null;

    // Minimum amount in blockchain satoshis that the chain will accept for an order.
    // Uses GRID_LIMITS.MIN_ORDER_SIZE_FACTOR (same constant as getMinOrderSize).

    let orderSizeA, orderSizeB;
    if (orderType === 'sell' || orderType === 'SELL' || orderType === 'Sell') {
        orderSizeA = orderSize;
        orderSizeB = orderSize * gridPrice;
    } else {
        orderSizeB = orderSize;
        orderSizeA = orderSize / gridPrice;
    }

    const minOrderSats = GRID_LIMITS.MIN_ORDER_SIZE_FACTOR;
    const satsA = Math.max(orderSizeA * Math.pow(10, precisionA), minOrderSats);
    const satsB = Math.max(orderSizeB * Math.pow(10, precisionB), minOrderSats);

    const termA = 1 / satsA;
    const termB = 1 / satsB;
    const tolerance = (termA + termB) * gridPrice;
    const maxTolerance = Math.max(gridPrice * GRID_LIMITS.PRICE_TOLERANCE_MAX_PERCENT, GRID_LIMITS.PRICE_TOLERANCE_MIN_ABSOLUTE);
    return Math.min(tolerance, maxTolerance);
}

/**
 * Scan an iterable of candidate items for a price collision with the target order.
 * Each candidate must have `id` and a price accessible via `item.price ?? item.order?.price`.
 *
 * @param {Iterable} items - Candidates to scan (manager.orders values or opContexts)
 * @param {string} excludeId - Slot id to skip (the item being created)
 * @param {number} targetPrice
 * @param {number} targetSize
 * @param {string} targetType - ORDER_TYPES.BUY or SELL
 * @param {object} assets - Manager assets (assetA/assetB with precision)
 * @param {Function} [isValid] - Optional predicate; candidate must return true to be considered
 * @returns {object|null} The colliding item, or null
 */
function findPriceCollision(
    items: Iterable<any>,
    excludeId: string,
    targetPrice: number,
    targetSize: number,
    targetType: string,
    assets: any,
    isValid?: ((item: any) => boolean) | null
): any {
    for (const item of items) {
        if (item.id === excludeId) continue;
        if (isValid && !isValid(item)) continue;
        const price = item.price ?? item.order?.price;
        const size = item.size ?? item.order?.size ?? 0;
        if (price == null || targetPrice == null) continue;

        // Compute tolerance for both the target order's type and the
        // candidate item's type, then take the minimum (most conservative).
        // Without this, a buy-vs-sell comparison where one side uses a
        // precision-0 asset can produce tolerance > grid increment from
        // the MIN_ORDER_SIZE_FACTOR=50 floor alone, causing adjacent grid
        // levels to falsely collide (see validateCreateTargetSlots layer 2
        // comment for the full analysis).
        const toleranceTarget = calculatePriceTolerance(
            Math.min(price, targetPrice),
            Math.max(size, targetSize),
            targetType,
            assets
        );
        let tolerance = toleranceTarget;
        const itemType = item.type ?? item.order?.type;
        if (toleranceTarget != null && itemType != null) {
            const toleranceItem = calculatePriceTolerance(
                Math.min(price, targetPrice),
                Math.max(size, targetSize),
                itemType,
                assets
            );
            if (toleranceItem != null) {
                tolerance = Math.min(toleranceTarget, toleranceItem);
            }
        }
        if (tolerance != null && Math.abs(price - targetPrice) <= tolerance) {
            return item;
        }
    }
    return null;
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
 * Unlike findPriceCollision (same-price check), this catches crossings at
 * ANY price overlap and is intended for the re-pricing UPDATE / CREATE
 * paths. The caller decides the exemption policy (e.g. crossed orders
 * cancelled earlier in the same plan).
 *
 * @param {Iterable<any>} items - Candidate orders (e.g. manager.orders.values())
 * @param {number} price - Candidate placement price
 * @param {string} type - Candidate placement type (ORDER_TYPES.BUY / SELL)
 * @param {any} assets - Asset metadata (precisions) for tolerance
 * @param {((item: any) => boolean)|null} [isValid] - Optional filter
 * @returns {any|null} The first crossed order, or null when the placement crosses nothing
 */
function findCrossedOrder(
    items: Iterable<any>,
    price: number,
    type: string,
    assets: any,
    isValid?: ((item: any) => boolean) | null
): any {
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
function validateOrderAmountsWithinLimits(amountToSell: any, minToReceive: any, sellPrecision: any, receivePrecision: any) {
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
function getMinOrderSize(orderType: any, assets: any, factor: any = GRID_LIMITS.MIN_ORDER_SIZE_FACTOR) {
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
function getDustThresholdFactor(dustThresholdPercent: any = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE) {
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
function getSingleDustThreshold(idealSize: any, dustThresholdPercent: any = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE) {
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
function getDoubleDustThreshold(idealSize: any, dustThresholdPercent: any = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE) {
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
function validateOrderSize(orderSize: any, orderType: any, assets: any, minFactor: any = GRID_LIMITS.MIN_ORDER_SIZE_FACTOR, idealSize: any = null, dustThresholdPercent: any = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE) {
     const orderSizeFloat = toFiniteNumber(orderSize);
     const minAbsoluteSize = getMinOrderSize(orderType, assets, minFactor);
     
     let precision: any = null;
     if (assets) {
         if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
         else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
     }
      const displayPrecision = precision;
     
     if (orderSizeFloat < minAbsoluteSize) {
         return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below absolute minimum (${Format.formatAmountByPrecision(minAbsoluteSize, displayPrecision)})`, minAbsoluteSize, minDustSize: null as any };
     }

     if (idealSize !== null && idealSize !== undefined && idealSize > 0) {
         const minDustSize = getDoubleDustThreshold(idealSize, dustThresholdPercent);
         if (orderSizeFloat < minDustSize) {
             return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below double-dust threshold (${Format.formatAmountByPrecision(minDustSize, displayPrecision)})`, minAbsoluteSize, minDustSize };
         }
     }

     if (typeof precision === 'number') {
         if (floatToBlockchainInt(orderSizeFloat, precision) <= 0) {
             return { isValid: false, reason: `Order size (${orderSizeFloat}) rounds to 0 on blockchain`, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null as any };
         }
     }

     return { isValid: true, reason: null, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null as any };
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
function allocateFundsByWeights(totalFunds: any, n: any, weight: any, incrementFactor: any, reverse: any = false, _minSize: any = 0, precision: any = null) {
    if (n <= 0) return [];
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

    const base = 1 - incrementFactor;
    const rawWeights = new Array(n);
    for (let i = 0; i < n; i++) {
        const idx = reverse ? (n - 1 - i) : i;
        rawWeights[i] = Math.pow(base, idx * weight);
    }

    const sizes = new Array(n).fill(0);
    const totalWeight = rawWeights.reduce((s: any, w: any) => s + w, 0) || 1;

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
function calculateOrderSizes(orders: any, config: any, sellFunds: any, buyFunds: any, minSellSize: any = 0, minBuySize: any = 0, precisionA: any = null, precisionB: any = null) {
    const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
    const incrementFactor = incrementPercent / 100;

    const sellOrders = orders.filter((o: any) => o.type === ORDER_TYPES.SELL);
    const buyOrders = orders.filter((o: any) => o.type === ORDER_TYPES.BUY);

    const sellSizes = allocateFundsByWeights(sellFunds, sellOrders.length, sellWeight, incrementFactor, false, minSellSize, precisionA);
    const buySizes = allocateFundsByWeights(buyFunds, buyOrders.length, buyWeight, incrementFactor, true, minBuySize, precisionB);

    const sellState = { sizes: sellSizes, index: 0 };
    const buyState = { sizes: buySizes, index: 0 };

    return orders.map((order: any) => {
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
function calculateRotationOrderSizes(availableFunds: any, totalGridAllocation: any, orderCount: any, orderType: any, config: any, minSize: any = 0, precision: any = null) {
    if (orderCount <= 0) return [];
    const totalFunds = availableFunds + totalGridAllocation;
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(orderCount).fill(0);

    const { incrementPercent, weightDistribution } = config;
    const incrementFactor = incrementPercent / 100;
    const weight = (orderType === ORDER_TYPES.SELL) ? weightDistribution.sell : weightDistribution.buy;
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
function calculateGridSideDivergenceMetric(calculatedOrders: any, persistedOrders: any, _sideName: any = 'unknown') {
    if (!Array.isArray(calculatedOrders) || !Array.isArray(persistedOrders)) return 0;
    if (calculatedOrders.length === 0 && persistedOrders.length === 0) return 0;

    const persistedMap = new Map(persistedOrders.filter((o: any) => o.id).map((o: any) => [o.id, o]));
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
        if (!calculatedOrders.some((c: any) => c.id === persOrder.id)) {
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
function calculateOrderCreationFees(assetA: any, assetB: any, totalOrders: any, feeMultiplier: any = FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER) {
    try {
        if (totalOrders > 0) {
            const btsFeeData = getAssetFees('BTS');
            return btsFeeData.createFee * totalOrders * feeMultiplier;
        }
    } catch (err: any) {
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
function calculateSwapInAmount(targetReceive: any, poolReserveOut: any, poolReserveIn: any) {
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
 * @param {Object} GRID_LIMITS - Grid limits constants (optional, uses defaults)
 * @returns {number} Number of gap slots
 */
function calculateGapSlots(incrementPercent: any, targetSpreadPercent: any, gridLimits: { MIN_SPREAD_FACTOR?: number; MIN_SPREAD_ORDERS?: number } = {}) {
    const DEFAULT_INCREMENT = Number(DEFAULT_CONFIG.incrementPercent);
    const MIN_SPREAD_FACTOR = gridLimits.MIN_SPREAD_FACTOR ?? GRID_LIMITS.MIN_SPREAD_FACTOR;
    const MIN_SPREAD_ORDERS = gridLimits.MIN_SPREAD_ORDERS ?? GRID_LIMITS.MIN_SPREAD_ORDERS;

    const safeIncrement = (Number.isFinite(incrementPercent) && incrementPercent > 0) ? incrementPercent : DEFAULT_INCREMENT;
    const step = 1 + (safeIncrement / 100);
    const minSpreadPercent = safeIncrement * MIN_SPREAD_FACTOR;
    const effectiveTargetSpread = Math.max(targetSpreadPercent || 0, minSpreadPercent);
    const requiredSteps = Math.ceil(Math.log(1 + (effectiveTargetSpread / 100)) / Math.log(step));
    return Math.max(MIN_SPREAD_ORDERS, requiredSteps - 1);
}

/**
 * Calculate sell start index from boundary index and gap slots.
 * sellStartIdx = boundaryIdx + gapSlots + 1
 */
function getSellStartIdx(boundaryIdx: any, gapSlots: any): number {
    return Number(boundaryIdx ?? 0) + Number(gapSlots) + 1;
}

/**
 * Resolve the configured gap-slot count for a manager-like object.
 * Single source of truth for the `_gapSlots ?? calculateGapSlots(config)`
 * pattern — used by resolveGapBand and the COW boundary-commit gate so the
 * two can never disagree on band width.
 */
function resolveGapSlots(manager: { _gapSlots?: any; config?: any }): number {
    const configured = manager._gapSlots;
    if (configured != null && Number.isFinite(Number(configured))) {
        return Math.max(0, Math.floor(Number(configured)));
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
function resolveGapBand(manager: { _gapSlots?: any; boundaryIdx?: any; config?: any }): { gapSlots: number; boundaryIdx: number | null; sellStartIdx: number | null } {
    const gapSlots = resolveGapSlots(manager);
    // Explicit null/undefined guard: Number(null) === 0, which would silently
    // treat "no boundary" as boundary 0 — a valid index that biases all slots
    // to the SELL rail.  Return null so callers can detect the unknown state.
    if (manager.boundaryIdx == null) {
        return { gapSlots, boundaryIdx: null, sellStartIdx: null };
    }
    const raw = Number(manager.boundaryIdx);
    if (!Number.isFinite(raw)) {
        return { gapSlots, boundaryIdx: null, sellStartIdx: null };
    }
    const sellStartIdx = getSellStartIdx(raw, gapSlots);
    return { gapSlots, boundaryIdx: raw, sellStartIdx };
}

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
 * @param options.rejectInBandPlacements - When true, additionally reject a
 *   boundary under which a PLACED order sits strictly inside the implied gap
 *   band (stranding).  Honest writers never produce this — the promotion walk
 *   caps depth upstream and the fill path carries its rotations in the same
 *   batch — so it is OFF at commit time (a refusal could not repair the
 *   anyway) but ON for
 *   persisted-state validation, where stranding is exactly the poison
 *   signature and the safe fallback is a rebuild.
 *
 * @returns `{ ok: true }`, or `{ ok: false, reason, detail }` where `reason`
 *   is a stable short code and `detail` carries indices/prices for logs.
 */
function validateBoundaryCommit(
    proposedBoundary: any,
    orders: Iterable<any>,
    gapSlots: number,
    options: { rejectInBandPlacements?: boolean } = {}
): { ok: boolean; reason?: string; detail?: string } {
    if (proposedBoundary == null) return { ok: true };
    const raw = Number(proposedBoundary);
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
        return { ok: false, reason: 'non_integer_boundary', detail: `proposed=${proposedBoundary}` };
    }
    if (raw < 0) {
        return { ok: false, reason: 'negative_boundary', detail: `proposed=${raw}` };
    }

    const sorted = Array.from(orders ?? [])
        .filter((o: any) => o && o.price != null && Number.isFinite(Number(o.price)))
        .sort((a: any, b: any) => Number(a.price) - Number(b.price));
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
    for (let idx = 0; idx < sorted.length; idx++) {
        const o = sorted[idx];
        if (!o.orderId) continue;
        const price = Number(o.price);
        if (idx <= raw) {
            if (price > maxBuyPrice) maxBuyPrice = price;
        } else if (idx >= sellStart) {
            if (price < minSellPrice) minSellPrice = price;
        } else if (options.rejectInBandPlacements) {
            return {
                ok: false,
                reason: 'placed_order_in_band',
                detail: `boundary=${raw} gapSlots=${gapSlots} placed idx=${idx} price=${price} ` +
                    `sits strictly inside implied band (${raw}, ${sellStart})`
            };
        }
    }
    if (Number.isFinite(maxBuyPrice) && Number.isFinite(minSellPrice) && minSellPrice <= maxBuyPrice) {
        return {
            ok: false,
            reason: 'crossed_book_geometry',
            detail: `boundary=${raw} gapSlots=${gapSlots} bestPlacedBuy=${maxBuyPrice} >= bestImpliedSell=${minSellPrice}`
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
 * rejects stranding (a placed order inside the implied band) because at
 * restore time the safe fallback is a rebuild/re-derivation, not a refusal.
 *
 * Callers:
 * - loadGrid (grid.ts) before _restoreBoundary — repairs via re-derivation.
 * - recoverFromPersistedGrid (dexbot_state_recovery.ts) BEFORE loading, so a
 *   poisoned snapshot is refused and structural resync falls through to the
 *   clean full-grid reset instead of re-ingesting the damage.
 */
function validatePersistedBoundary(
    proposedBoundary: any,
    orders: Iterable<any>,
    gapSlots: number
): { ok: boolean; reason?: string; detail?: string } {
    return validateBoundaryCommit(proposedBoundary, orders, gapSlots, { rejectInBandPlacements: true });
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
function countGapBandSpread(manager: any, orders: Iterable<any>, resolveIndex: (order: any, arrayIndex: number) => number | null): number {
    const resolved = resolveGapBand(manager);
    if (resolved.boundaryIdx === null || resolved.sellStartIdx === null) {
        return Array.from(orders).filter((o: any) => o?.type === ORDER_TYPES.SPREAD).length;
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
 * the spread (h-bts: boundary 107→110 left the sell rail parked at 111-130
 * with the bottom three, 111-113, inside the new spread gap; real spread 0.5%
 * vs the 2.0% target).
 *
 * @param {number|null} boundaryIdx - Working boundary index.  null/undefined
 *   (or non-finite) means "boundary unknown" and the slot is NOT excluded
 *   (returns true), mirroring grid_reconcile_internal's boundaryKnown guard.
 * @param {number} gapSlots - Spread gap slot count.  A non-finite value means
 *   the SELL start cannot be derived, so the slot is not excluded.
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL.
 * @param {any} slot - Grid slot (or any object exposing an id like `slot-3`);
 *   slots with an unparseable id are admitted (returns true): geometry cannot
 *   identify the gap for legacy ids, so windowing falls back to the stored
 *   slot type exactly as pre-1.4.25 did (fail-open; consumers still reject
 *   SPREAD-typed/empty slots via their type filters).
 * @returns {boolean} true when the slot sits inside the requested rail or its
 *   geometry cannot be determined (fail-open), false only when a parseable id
 *   sits provably outside the rail.
 */
function isSlotInRail(boundaryIdx: any, gapSlots: any, orderType: any, slot: any): boolean {
    if (boundaryIdx == null || !Number.isFinite(Number(boundaryIdx))) return true;
    const parsed = parseSlotIndex(slot?.id);
    if (parsed === null) return true;
    const idx = parsed;
    if (orderType === ORDER_TYPES.BUY) return idx <= Number(boundaryIdx);
    if (orderType !== ORDER_TYPES.SELL) return true;
    const sellStartIdx = getSellStartIdx(boundaryIdx, gapSlots);
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
function isSlotIndexInGapBand(idx: any, boundaryIdx: any, gapSlots: any): boolean {
    // Explicit null guard: Number(null) === 0 must never read as slot 0.
    if (idx === null || idx === undefined || idx === '') return false;
    if (boundaryIdx === null || boundaryIdx === undefined || boundaryIdx === '') return false;
    const n = Number(idx);
    const b = Number(boundaryIdx);
    const g = Number(gapSlots);
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
function isEvacuationSizeStillValid(newSize: any, bookedRemaining: any, precision: any = null): boolean {
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
function isEvacuationRotationAllowed(oldPrice: any, oldSize: any, newPrice: any, newSize: any, type: any, precision: any = null): { allowed: boolean; reason: string } {
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
 * Integer equality (priceSlotEqual) excuses sub-satoshi float dust at the
 * edge; anything further out is out-of-grid → hold/defer, never adopt or
 * cancel as a duplicate.
 */
function isChainPriceOutOfGrid(price: number, genesis: GridGenesis, precision: number): boolean {
    const levels = genesis?.priceLevels;
    if (!Array.isArray(levels) || levels.length === 0) return false;
    if (!Number.isFinite(price)) return false;
    const min = levels[0];
    const max = levels[levels.length - 1];
    if (price < min && !priceSlotEqual(price, min, precision)) return true;
    if (price > max && !priceSlotEqual(price, max, precision)) return true;
    return false;
}

function assertSlotPriceInvariant(slot: any, genesis: GridGenesis): void {
    const idx = parseSlotIndex(slot?.id);
    if (idx === null) throw new Error(`assertSlotPriceInvariant: unparseable slot id ${slot?.id}`);
    const expected = priceForSlot(idx, genesis);
    // Use blockchain integer equality for single-epsilon check.
    // Need asset precision: fall back to generic epsilon if unknown.
    // For invariant we use absolute relative tolerance 1e-9 or integer check when precision known.
    const price = Number(slot.price);
    if (!Number.isFinite(price)) throw new Error(`assertSlotPriceInvariant: slot ${slot.id} has non-finite price`);
    // If slot has no asset context, use tight epsilon.
    const diff = Math.abs(price - expected);
    const rel = diff / Math.max(1e-12, Math.abs(expected));
    if (rel > 1e-9 && diff > 1e-12) {
        throw new Error(`Slot price invariant violated for ${slot.id}: price ${price} != expected ${expected} (idx ${idx})`);
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

export { getBtsSide, getSellStartIdx, resolveGapBand, countGapBandSpread, calculateGapSlots, isSlotInRail, isSlotIndexInGapBand, isEvacuationRotationAllowed, isEvacuationSizeStillValid, validateBoundaryCommit, validatePersistedBoundary, resolveGapSlots, isPercentageString, isPositiveNumber, isPositiveNumberOrPercent, isPositiveInt, parsePercentageString, toDecimal, resolveRelativePrice, parseRelativeMultiplier, validateGridPriceBounds, isExplicitZeroAllocation, getPrecision, computeChainFundTotals, calculateAvailableFundsValue, computeBtsFeeImpact, adjustBudgetForBtsFees, getGridBestPrices, calculateSpreadFromOrders, resolveConfigValue, resolveConfigValueWithRegistry, hasValidAccountTotals, blockchainToFloat, floatToBlockchainInt, quantizeFloat, normalizeInt, getPrecisionByOrderType, getPrecisionsForManager, getPrecisionSlack, quantumForPrecision, calculatePriceTolerance, findPriceCollision, findCrossedOrder, validateOrderAmountsWithinLimits, getMinOrderSize, getDustThresholdFactor, getSingleDustThreshold, getDoubleDustThreshold, validateOrderSize, getAssetFees, getAssetFeesSafe, allocateFundsByWeights, calculateOrderSizes, calculateRotationOrderSizes, calculateGridSideDivergenceMetric, calculateOrderCreationFees, calculateSwapInAmount, _setFeeCache, cloneWeightDistribution, clamp, roundTo, fixedTo, roundToDecimals, priceLevelsForGenesis, priceForSlot, slotIndexForPrice, slotIdForPrice, assertSlotPriceInvariant, priceSlotEqual, buildGenesisFromPriceLevels, hashPriceLevels, isChainPriceOutOfGrid }

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
function clamp(value: any, min: any, max: any) {
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
function cloneWeightDistribution(weightDistribution: any, base: any = null) {
    const source = (weightDistribution && typeof weightDistribution === 'object')
        ? weightDistribution
        : (base && typeof base === 'object' ? base : null);
    if (!source) return null;

    const sell = Number(source.sell);
    const buy = Number(source.buy);
    if (!Number.isFinite(sell) || !Number.isFinite(buy)) return null;

    return { sell, buy };
}


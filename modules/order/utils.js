/**
 * modules/order/utils.js
 *
 * Centralized utility helpers used by the order subsystem.
 * Grouped for readability and maintenance: parsing, conversions, tolerance,
 * matching, reconciliation, and price derivation.
 * 
 * Key functions that interact with fund tracking:
 * - applyChainSizeToGridOrder: Updates order size from chain data, adjusts funds
 * - correctOrderPriceOnChain: Corrects price mismatches, may affect committed funds
 * - getMinOrderSize: Calculates minimum order size based on asset precision
 * 
 * Fund-aware functions call manager._adjustFunds() or manager.recalculateFunds()
 * to keep the funds structure consistent with order state changes.
 */

const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../constants');

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------
function isPercentageString(v) {
    return typeof v === 'string' && v.trim().endsWith('%');
}

/**
 * Correct all orders that have been flagged for price mismatches on-chain.
 * Accepts a manager instance and iterates its ordersNeedingPriceCorrection.
 */
async function correctAllPriceMismatches(manager, accountName, privateKey, accountOrders) {
    if (!manager) throw new Error('manager required');
    const results = [];
    let corrected = 0;
    let failed = 0;

    // Copy the list because it may be mutated during processing
    // Deduplicate by chainOrderId to avoid double-correction attempts
    const allOrders = Array.isArray(manager.ordersNeedingPriceCorrection) ? [...manager.ordersNeedingPriceCorrection] : [];
    const seen = new Set();
    const ordersToCorrect = allOrders.filter(c => {
        if (!c.chainOrderId || seen.has(c.chainOrderId)) return false;
        seen.add(c.chainOrderId);
        return true;
    });

    for (const correctionInfo of ordersToCorrect) {
        const result = await correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders);
        results.push({ ...correctionInfo, result });

        if (result && result.success) corrected++; else failed++;

        // Small delay between corrections to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, TIMING.SYNC_DELAY_MS));
    }

    manager.logger?.log?.(`Price correction complete: ${corrected} corrected, ${failed} failed`, 'info');
    return { corrected, failed, results };
}

function parsePercentageString(v) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    if (Number.isNaN(num)) return null;
    return num / 100.0;
}

function isRelativeMultiplierString(value) {
    return typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value);
}

function parseRelativeMultiplierString(value) {
    if (!isRelativeMultiplierString(value)) return null;
    const cleaned = value.trim().toLowerCase();
    const numeric = parseFloat(cleaned.slice(0, -1));
    return Number.isNaN(numeric) ? null : numeric;
}

function resolveRelativePrice(value, marketPrice, mode = 'min') {
    const multiplier = parseRelativeMultiplierString(value);
    if (multiplier === null || !Number.isFinite(marketPrice) || multiplier === 0) return null;
    if (mode === 'min') return marketPrice / multiplier;
    if (mode === 'max') return marketPrice * multiplier;
    return null;
}

// ---------------------------------------------------------------------------
// Fund calculation helpers
// ---------------------------------------------------------------------------
/**
 * Computes chain fund totals by combining free balances with committed amounts.
 *
 * @param {Object} accountTotals - Account totals object with buyFree, sellFree, buy, sell
 * @param {Object} committedChain - Committed chain funds with buy and sell properties
 * @returns {Object} Object containing:
 *   - chainFreeBuy/chainFreeSell: Free balances from account
 *   - committedChainBuy/committedChainSell: Committed amounts
 *   - freePlusLockedBuy/freePlusLockedSell: Sum of free + committed
 *   - chainTotalBuy/chainTotalSell: Account totals or free+locked, whichever is greater
 */
function computeChainFundTotals(accountTotals, committedChain) {
    const chainFreeBuy = Number.isFinite(Number(accountTotals?.buyFree)) ? Number(accountTotals.buyFree) : 0;
    const chainFreeSell = Number.isFinite(Number(accountTotals?.sellFree)) ? Number(accountTotals.sellFree) : 0;
    const committedChainBuy = Number(committedChain?.buy) || 0;
    const committedChainSell = Number(committedChain?.sell) || 0;

    const freePlusLockedBuy = chainFreeBuy + committedChainBuy;
    const freePlusLockedSell = chainFreeSell + committedChainSell;

    // Prefer accountTotals.buy/sell (free + locked in open orders) when available, but ensure
    // we don't regress to free-only by treating totals as at least (free + locked).
    const chainTotalBuy = Number.isFinite(Number(accountTotals?.buy))
        ? Math.max(Number(accountTotals.buy), freePlusLockedBuy)
        : freePlusLockedBuy;
    const chainTotalSell = Number.isFinite(Number(accountTotals?.sell))
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

/**
 * Calculates available funds for a specific side (buy/sell).
 * Accounts for: chain free balance, virtual orders, cache, pending proceeds, and BTS fees.
 *
 * @param {string} side - 'buy' or 'sell'
 * @param {Object} accountTotals - Account totals with buyFree/sellFree
 * @param {Object} funds - Fund tracking object
 * @param {string} assetA - Asset A symbol (to determine BTS side)
 * @param {string} assetB - Asset B symbol (to determine BTS side)
 * @returns {number} Available funds for the side, always >= 0
 */
function calculateAvailableFundsValue(side, accountTotals, funds, assetA, assetB, activeOrders = null) {
    if (!side || (side !== 'buy' && side !== 'sell')) return 0;

    const chainFree = side === 'buy' ? (accountTotals?.buyFree || 0) : (accountTotals?.sellFree || 0);
    const virtuel = side === 'buy' ? (funds.virtuel?.buy || 0) : (funds.virtuel?.sell || 0);
    const cacheFunds = side === 'buy' ? (funds.cacheFunds?.buy || 0) : (funds.cacheFunds?.sell || 0);

    // Determine which side actually has BTS as the asset
    const btsSide = (assetA === 'BTS') ? 'sell' :
        (assetB === 'BTS') ? 'buy' : null;
    let applicableBtsFeesOwed = 0;
    if (btsSide === side && funds.btsFeesOwed > 0) {
        // BTS fees are deducted from the side where they are owed (usually from cache funds/proceeds)
        applicableBtsFeesOwed = Math.min(funds.btsFeesOwed, cacheFunds);
    }

    // Reserve BTS fees for updating target open orders (needed when regenerating grid)
    // This ensures fees are available when applyGridDivergenceCorrections updates orders on-chain
    // Use 4x multiplier for buffer to ensure sufficient funds for multiple rotation cycles
    let btsFeesReservation = 0;
    if (btsSide === side && activeOrders) {
        try {
            const targetBuy = Math.max(0, Number.isFinite(Number(activeOrders?.buy)) ? Number(activeOrders.buy) : 1);
            const targetSell = Math.max(0, Number.isFinite(Number(activeOrders?.sell)) ? Number(activeOrders.sell) : 1);
            const totalTargetOrders = targetBuy + targetSell;
            const FEE_MULTIPLIER = 5; // 5x multiplier: 1x for creation + 4x for rotation buffer

            if (totalTargetOrders > 0) {
                const btsFeeData = getAssetFees('BTS', 1);
                btsFeesReservation = btsFeeData.createFee * totalTargetOrders * FEE_MULTIPLIER;
            }
        } catch (err) {
            // Fall back to simple 100 BTS if fee calculation fails
            btsFeesReservation = 100;
        }
    }

    return Math.max(0, chainFree - virtuel - cacheFunds - applicableBtsFeesOwed - btsFeesReservation);
}

/**
 * Calculates the current spread percentage between best buy and sell orders.
 * Checks active orders first, falls back to virtual orders if needed.
 *
 * @param {Array} activeBuys - Active buy orders
 * @param {Array} activeSells - Active sell orders
 * @param {Array} virtualBuys - Virtual buy orders
 * @param {Array} virtualSells - Virtual sell orders
 * @returns {number} Spread percentage (e.g., 2.5 for 2.5%), or 0 if no valid spread
 */
function calculateSpreadFromOrders(activeBuys, activeSells, virtualBuys, virtualSells) {
    const pickBestBuy = () => {
        if (activeBuys.length) return Math.max(...activeBuys.map(o => o.price));
        if (virtualBuys.length) return Math.max(...virtualBuys.map(o => o.price));
        return null;
    };
    const pickBestSell = () => {
        if (activeSells.length) return Math.min(...activeSells.map(o => o.price));
        if (virtualSells.length) return Math.min(...virtualSells.map(o => o.price));
        return null;
    };

    const bestBuy = pickBestBuy();
    const bestSell = pickBestSell();
    if (bestBuy === null || bestSell === null || bestBuy === 0) return 0;
    return ((bestSell / bestBuy) - 1) * 100;
}

/**
 * Resolves a config value to a numeric amount.
 * Supports: direct numbers, percentage strings (e.g., "50%"), or numeric strings.
 * Returns 0 if value cannot be parsed or if total is needed but not provided.
 *
 * @param {*} value - The config value to resolve
 * @param {number} total - The total amount (required for percentage calculations)
 * @returns {number} Resolved numeric value
 */
function resolveConfigValue(value, total) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const p = parsePercentageString(value);
        if (p !== null) {
            if (total === null || total === undefined) {
                return 0; // Cannot resolve without total
            }
            return total * p;
        }
        const n = parseFloat(value);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Blockchain conversions
// ---------------------------------------------------------------------------
function blockchainToFloat(intValue, precision) {
    if (intValue === null || intValue === undefined) return 0;
    const p = Number(precision || 0);
    return Number(intValue) / Math.pow(10, p);
}

function floatToBlockchainInt(floatValue, precision) {
    const p = Number(precision || 0);
    const scaled = Math.round(Number(floatValue) * Math.pow(10, p));

    // 64-bit signed integer limits: -(2^63) to (2^63 - 1)
    const MAX_INT64 = 9223372036854775807;
    const MIN_INT64 = -9223372036854775808;

    if (scaled > MAX_INT64 || scaled < MIN_INT64) {
        console.warn(`[floatToBlockchainInt] Overflow detected: ${floatValue} with precision ${p} resulted in ${scaled}. Clamping to safe limits.`);
        return scaled > 0 ? MAX_INT64 : MIN_INT64;
    }

    return scaled;
}

// ---------------------------------------------------------------------------
// Price tolerance and checks
// ---------------------------------------------------------------------------
function calculatePriceTolerance(gridPrice, orderSize, orderType, assets = null) {
    if (!assets || !gridPrice || !orderSize) {
        return gridPrice ? gridPrice * 0.001 : 0;
    }

    const precisionA = assets.assetA?.precision ?? 8;
    const precisionB = assets.assetB?.precision ?? 8;

    let orderSizeA, orderSizeB;
    if (orderType === 'sell' || orderType === 'SELL' || orderType === 'Sell') {
        orderSizeA = orderSize;
        orderSizeB = orderSize * gridPrice;
    } else {
        orderSizeB = orderSize;
        orderSizeA = orderSize / gridPrice;
    }

    const termA = 1 / (orderSizeA * Math.pow(10, precisionA));
    const termB = 1 / (orderSizeB * Math.pow(10, precisionB));
    const tolerance = (termA + termB) * gridPrice;
    return tolerance;
}

function checkPriceWithinTolerance(gridOrder, chainOrder, assets = null) {
    const gridPrice = Number(gridOrder && gridOrder.price);
    const chainPrice = Number(chainOrder && chainOrder.price);
    const orderSize = Number((chainOrder && chainOrder.size) || (gridOrder && gridOrder.size) || 0);

    const priceDiff = Math.abs(gridPrice - chainPrice);
    const tolerance = calculatePriceTolerance(gridPrice, orderSize, gridOrder && gridOrder.type, assets);

    return {
        isWithinTolerance: priceDiff <= tolerance,
        priceDiff,
        tolerance,
        gridPrice,
        chainPrice,
        orderSize
    };
}

/**
 * Validate that calculated order amounts won't exceed 64-bit integer limits.
 * Returns true if amounts are safe, false if they would overflow.
 * @param {number} amountToSell - Amount to sell (in float)
 * @param {number} minToReceive - Minimum to receive (in float)
 * @param {number} sellPrecision - Precision of sell asset
 * @param {number} receivePrecision - Precision of receive asset
 * @returns {boolean} true if amounts are within safe limits
 */
function validateOrderAmountsWithinLimits(amountToSell, minToReceive, sellPrecision, receivePrecision) {
    const MAX_INT64 = 9223372036854775807;

    const sellPrecFloat = Math.pow(10, sellPrecision || 0);
    const receivePrecFloat = Math.pow(10, receivePrecision || 0);

    const sellInt = Math.round(Number(amountToSell) * sellPrecFloat);
    const receiveInt = Math.round(Number(minToReceive) * receivePrecFloat);

    const withinLimits = sellInt <= MAX_INT64 && receiveInt <= MAX_INT64 && sellInt > 0 && receiveInt > 0;

    if (!withinLimits) {
        console.warn(
            `[validateOrderAmountsWithinLimits] Order amounts exceed safe limits or are invalid. ` +
            `Sell: ${amountToSell} (precision ${sellPrecision}) = ${sellInt}, ` +
            `Receive: ${minToReceive} (precision ${receivePrecision}) = ${receiveInt}. ` +
            `Max allowed: ${MAX_INT64}`
        );
    }

    return withinLimits;
}

// ---------------------------------------------------------------------------
// Chain order parsing + matching helpers
// ---------------------------------------------------------------------------
function parseChainOrder(chainOrder, assets) {
    if (!chainOrder || !chainOrder.sell_price || !assets) return null;
    const { base, quote } = chainOrder.sell_price;
    if (!base || !quote || !base.asset_id || !quote.asset_id || base.amount == 0) return null;
    let price; let type;
    if (base.asset_id === assets.assetA.id && quote.asset_id === assets.assetB.id) {
        price = (quote.amount / base.amount) * Math.pow(10, assets.assetA.precision - assets.assetB.precision);
        type = ORDER_TYPES.SELL;
    } else if (base.asset_id === assets.assetB.id && quote.asset_id === assets.assetA.id) {
        price = (base.amount / quote.amount) * Math.pow(10, assets.assetA.precision - assets.assetB.precision);
        type = ORDER_TYPES.BUY;
    } else return null;

    let size = null;
    try {
        if (chainOrder.for_sale !== undefined && chainOrder.for_sale !== null) {
            if (type === ORDER_TYPES.SELL) {
                // For SELL: for_sale is in assetA (base asset)
                const prec = assets.assetA && assets.assetA.precision !== undefined ? assets.assetA.precision : 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), prec);
            } else {
                // For BUY: for_sale is in assetB (quote asset we're selling)
                // IMPORTANT: grid BUY sizes are tracked in assetB units (see ORDER_STATES docs).
                // So we keep size in assetB units here.
                const bPrec = assets.assetB && assets.assetB.precision !== undefined ? assets.assetB.precision : 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), bPrec);
            }
        }
    } catch (e) { size = null; }

    return { orderId: chainOrder.id, price, type, size };
}

function findBestMatchByPrice(chainOrder, candidateIds, ordersMap, calcToleranceFn) {
    let bestMatch = null; let smallestDiff = Infinity;
    for (const gridOrderId of candidateIds) {
        const gridOrder = ordersMap.get(gridOrderId);
        if (!gridOrder || gridOrder.type !== chainOrder.type) continue;
        const priceDiff = Math.abs(gridOrder.price - chainOrder.price);
        const orderSize = gridOrder.size || chainOrder.size || 0;
        const tolerance = calcToleranceFn(gridOrder.price, orderSize, gridOrder.type);
        if (priceDiff <= tolerance && priceDiff < smallestDiff) {
            smallestDiff = priceDiff; bestMatch = gridOrder;
        }
    }
    return { match: bestMatch, priceDiff: smallestDiff };
}

/**
 * Match chain order to grid order by price + size tolerance.
 * - Matches with ACTIVE or VIRTUAL grid orders
 * - Both price AND size must be within tolerance
 * - When matched: grid order becomes ACTIVE with chain orderID
 * - Returns best match (closest price) or null
 */
function findMatchingGridOrderByOpenOrder(parsedChainOrder, opts) {
    const { orders, ordersByState, assets, calcToleranceFn, logger } = opts || {};
    if (!parsedChainOrder || !orders) return null;

    // Fast path: exact orderId match (needed for cancel/sync flows)
    if (parsedChainOrder.orderId) {
        for (const gridOrder of orders.values()) {
            if (gridOrder && gridOrder.orderId === parsedChainOrder.orderId) return gridOrder;
        }
    }

    const chainSize = parsedChainOrder.size || 0;
    const chainPrice = parsedChainOrder.price || 0;
    let bestMatch = null;
    let bestPriceDiff = Infinity;

    // Match with ACTIVE/PARTIAL/VIRTUAL grid orders
    for (const gridOrder of orders.values()) {
        if (!gridOrder || gridOrder.type !== parsedChainOrder.type) continue;
        if (gridOrder.state !== ORDER_STATES.ACTIVE && gridOrder.state !== ORDER_STATES.PARTIAL && gridOrder.state !== ORDER_STATES.VIRTUAL) continue;

        // Price tolerance check
        const priceDiff = Math.abs(gridOrder.price - chainPrice);
        const priceTolerance = calcToleranceFn ? calcToleranceFn(gridOrder.price, gridOrder.size, gridOrder.type) : 0;

        if (priceDiff > priceTolerance) continue;

        // Size check: compare in blockchain integer units for the relevant asset.
        // - SELL sizes are in assetA units
        // - BUY sizes are in assetB units
        const gridSize = Number(gridOrder.size) || 0;
        const precision = (parsedChainOrder.type === ORDER_TYPES.SELL)
            ? (assets?.assetA?.precision ?? 0)
            : (assets?.assetB?.precision ?? 0);

        const gridInt = floatToBlockchainInt(gridSize, precision);
        const chainInt = floatToBlockchainInt(chainSize, precision);
        if (Math.abs(gridInt - chainInt) > 1) {
            logger?.log?.(
                `Chain order size mismatch with grid ${gridOrder.id}: chain=${chainSize.toFixed(8)}, grid=${gridSize.toFixed(8)}, ` +
                `chainInt=${chainInt}, gridInt=${gridInt}, precision=${precision}`,
                'debug'
            );
            continue;
        }

        // Track best match by price difference
        if (priceDiff < bestPriceDiff) {
            bestPriceDiff = priceDiff;
            bestMatch = gridOrder;
        }
    }

    if (bestMatch) {
        logger?.log?.(`Matched chain ${parsedChainOrder.orderId} (price=${chainPrice.toFixed(6)}, size=${chainSize.toFixed(8)}) to grid ${bestMatch.id} (price=${bestMatch.price.toFixed(6)}, size=${bestMatch.size.toFixed(8)}, state=${bestMatch.state})`, 'info');
        return bestMatch;
    }

    logger?.log?.(`No grid match for chain ${parsedChainOrder.orderId} (type=${parsedChainOrder.type}, price=${chainPrice.toFixed(6)}, size=${chainSize.toFixed(8)})`, 'warn');
    return null;
}

function findMatchingGridOrderByHistory(fillOp, opts) {
    const { orders, assets, calcToleranceFn, logger } = opts || {};
    if (!fillOp) return null;

    if (fillOp.order_id) {
        for (const gridOrder of orders.values()) {
            if (gridOrder.orderId === fillOp.order_id && gridOrder.state === ORDER_STATES.ACTIVE) return gridOrder;
        }
    }

    if (!fillOp.pays || !fillOp.receives || !assets) return null;

    const paysAssetId = String(fillOp.pays.asset_id);
    const receivesAssetId = String(fillOp.receives.asset_id);
    const assetAId = String(assets.assetA?.id || '');
    const assetBId = String(assets.assetB?.id || '');
    let fillType = null; let fillPrice = null;

    if (paysAssetId === assetAId && receivesAssetId === assetBId) {
        fillType = ORDER_TYPES.SELL;
        const paysAmount = blockchainToFloat(Number(fillOp.pays.amount), assets.assetA?.precision || 0);
        const receivesAmount = blockchainToFloat(Number(fillOp.receives.amount), assets.assetB?.precision || 0);
        if (paysAmount > 0) fillPrice = receivesAmount / paysAmount;
    } else if (paysAssetId === assetBId && receivesAssetId === assetAId) {
        fillType = ORDER_TYPES.BUY;
        const paysAmount = blockchainToFloat(Number(fillOp.pays.amount), assets.assetB?.precision || 0);
        const receivesAmount = blockchainToFloat(Number(fillOp.receives.amount), assets.assetA?.precision || 0);
        if (receivesAmount > 0) fillPrice = paysAmount / receivesAmount;
    } else return null;

    if (!fillType || !Number.isFinite(fillPrice)) return null;

    logger?.log?.(`Fill analysis: type=${fillType}, price=${fillPrice.toFixed(4)}`, 'debug');

    const activeIds = [];
    for (const [id, order] of orders.entries()) if (order.state === ORDER_STATES.ACTIVE) activeIds.push(id);
    const result = findBestMatchByPrice({ type: fillType, price: fillPrice }, activeIds, orders, calcToleranceFn);
    return result.match;
}

// ---------------------------------------------------------------------------
// Chain reconciliation helpers
// ---------------------------------------------------------------------------
function applyChainSizeToGridOrder(manager, gridOrder, chainSize) {
    if (!manager || !gridOrder) return;
    // Allow updates for ACTIVE and PARTIAL orders
    if (gridOrder.state !== ORDER_STATES.ACTIVE && gridOrder.state !== ORDER_STATES.PARTIAL) {
        manager.logger?.log?.(`Skipping chain size apply for non-ACTIVE/PARTIAL order ${gridOrder.id} (state=${gridOrder.state})`, 'debug');
        return;
    }
    const oldSize = Number(gridOrder.size || 0);
    const newSize = Number.isFinite(Number(chainSize)) ? Number(chainSize) : oldSize;
    const delta = newSize - oldSize;
    const precision = (gridOrder.type === ORDER_TYPES.SELL) ? manager.assets?.assetA?.precision : manager.assets?.assetB?.precision;
    const oldInt = floatToBlockchainInt(oldSize, precision);
    const newInt = floatToBlockchainInt(newSize, precision);
    if (oldInt === newInt) { gridOrder.size = newSize; return; }
    manager.logger?.log?.(`Order ${gridOrder.id} size adjustment: ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (delta: ${delta.toFixed(8)})`, 'debug');
    try { manager._adjustFunds(gridOrder, delta); } catch (e) { /* best-effort */ }
    gridOrder.size = newSize;
    try { manager._updateOrder(gridOrder); } catch (e) { /* best-effort */ }

    if (delta < 0 && manager.logger) {
        // After partial fill adjustment, log funds snapshot for visibility
        if (typeof manager.logger.logFundsStatus === 'function') {
            manager.logger.logFundsStatus(manager);
        } else {
            const f = manager.funds || {};
            const a = f.available || {};
            manager.logger.log(
                `Funds after partial fill: available buy=${(a.buy || 0).toFixed(8)} sell=${(a.sell || 0).toFixed(8)}`,
                'info'
            );
        }
    }
}

async function correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders) {
    const { gridOrder, chainOrderId, expectedPrice, size, type } = correctionInfo;

    // Skip if already removed from correction list (processed in another call)
    const stillNeeded = manager.ordersNeedingPriceCorrection?.some(c => c.chainOrderId === chainOrderId);
    if (!stillNeeded) {
        manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) correction already processed, skipping`, 'info');
        return { success: true, error: null, skipped: true };
    }

    manager.logger?.log?.(`Correcting order ${gridOrder.id} (${chainOrderId}): updating to price ${expectedPrice.toFixed(8)}`, 'info');
    try {
        let amountToSell, minToReceive;
        if (type === ORDER_TYPES.SELL) {
            amountToSell = size;
            minToReceive = size * expectedPrice;
        } else {
            amountToSell = size;
            minToReceive = size / expectedPrice;
        }
        manager.logger?.log?.(`Updating order: amountToSell=${amountToSell.toFixed(8)}, minToReceive=${minToReceive.toFixed(8)}`, 'info');
        const updateResult = await accountOrders.updateOrder(accountName, privateKey, chainOrderId, { amountToSell, minToReceive });
        if (updateResult === null) {
            manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) price correction skipped (no change to amount_to_sell)`, 'info');
            return { success: false, error: 'No change to amount_to_sell (delta=0) - update skipped' };
        }
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);
        manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) price corrected to ${expectedPrice.toFixed(8)}`, 'info');
        return { success: true, error: null };
    } catch (error) {
        // Remove from list regardless of outcome to prevent retry loops
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);

        // Handle "not found" gracefully - order was filled between detection and correction
        if (error.message && error.message.includes('not found')) {
            manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) no longer exists on chain - was it filled?`, 'warn');
            return { success: false, error: error.message, orderGone: true };
        }

        manager.logger?.log?.(`Failed to correct order ${gridOrder.id}: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

function getMinOrderSize(orderType, assets, factor = 50) {
    const f = Number(factor);
    if (!f || !Number.isFinite(f) || f <= 0) return 0;
    let precision = null;
    if (assets) {
        if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
        else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
    }
    if (precision === null || precision === undefined || !Number.isFinite(precision)) return 0;
    const smallestUnit = Math.pow(10, -precision);
    return Number(f) * smallestUnit;
}

// ---------------------------------------------------------------------------
// Price derivation helpers (moved from modules/order/price.js)
// ---------------------------------------------------------------------------
const lookupAsset = async (BitShares, s) => {
    let cached = null;
    try {
        cached = BitShares && BitShares.assets ? BitShares.assets[s.toLowerCase()] : null;
    } catch (e) { }

    // Only trust cached assets when they include precision; otherwise enrich via db.
    if (cached && cached.id && typeof cached.precision === 'number') return cached;

    try {
        const r = await BitShares.db.lookup_asset_symbols([s]);
        if (r && r[0] && r[0].id) return { ...(cached || {}), ...r[0] };
    } catch (e) { }
    try {
        const g = await BitShares.db.get_assets([s]);
        if (g && g[0] && g[0].id) return { ...(cached || {}), ...g[0] };
    } catch (e) { }

    if (cached && cached.id) return cached;
    return null;
};

const deriveMarketPrice = async (BitShares, symA, symB) => {
    try {
        const aMeta = await lookupAsset(BitShares, symA);
        const bMeta = await lookupAsset(BitShares, symB);
        if (!aMeta || !bMeta) throw new Error('Could not discover assets for market lookup');

        const baseId = aMeta.id; const quoteId = bMeta.id;
        let mid = null;
        try {
            if (BitShares.db && typeof BitShares.db.get_order_book === 'function') {
                const ob = await BitShares.db.get_order_book(baseId, quoteId, 5);
                const bestBid = ob.bids && ob.bids.length ? Number(ob.bids[0].price) : null;
                const bestAsk = ob.asks && ob.asks.length ? Number(ob.asks[0].price) : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            }
        } catch (e) { }

        if (mid === null) {
            try {
                if (BitShares.db && typeof BitShares.db.get_ticker === 'function') {
                    const t = await BitShares.db.get_ticker(baseId, quoteId);
                    if (t && (t.latest || t.latest === 0)) mid = Number(t.latest);
                    if (!mid && t && t.latest_price) mid = Number(t.latest_price);
                }
            } catch (err) { }
        }

        if (mid !== null && Number.isFinite(mid) && mid !== 0) return 1 / mid;
        return null;
    } catch (err) {
        return null;
    }
};

const derivePoolPrice = async (BitShares, symA, symB) => {
    try {
        const aMeta = await lookupAsset(BitShares, symA);
        const bMeta = await lookupAsset(BitShares, symB);
        if (!aMeta || !bMeta) throw new Error('Could not discover assets for pool lookup');

        let chosen = null;

        // Prefer direct lookup if available
        try {
            if (BitShares.db && typeof BitShares.db.get_liquidity_pool_by_asset_ids === 'function') {
                chosen = await BitShares.db.get_liquidity_pool_by_asset_ids(aMeta.id, bMeta.id);
            }
        } catch (e) { }

        try {
            // Attempt to find pool by scanning list_liquidity_pools
            // Method signature: list_liquidity_pools(lower_bound, limit)
            let startId = '1.19.0';
            const limit = 100; // API max is 101
            let batchCount = 0;
            const maxBatches = 100; // Scan up to 10000 pools to find the pair

            let allMatches = [];

            while (batchCount < maxBatches) {
                if (!BitShares.db || typeof BitShares.db.list_liquidity_pools !== 'function') break;

                // JS Wrapper seems to use (limit, start_id) based on "bad cast to array" for string first arg
                // and successful call with (100).
                const pools = await BitShares.db.list_liquidity_pools(limit, startId);
                if (!pools || pools.length === 0) break;

                const matches = pools.filter(p => {
                    const ids = (p.asset_ids || []).map(String);
                    // Also check direct fields if present
                    if (p.asset_a && p.asset_b) {
                        return (p.asset_a === aMeta.id && p.asset_b === bMeta.id) ||
                            (p.asset_a === bMeta.id && p.asset_b === aMeta.id);
                    }
                    return ids.includes(aMeta.id) && ids.includes(bMeta.id);
                });

                if (matches.length > 0) {
                    allMatches = allMatches.concat(matches);
                }

                // Prepare for next batch
                const last = pools[pools.length - 1];
                if (last && last.id) {
                    if (startId === last.id) break; // End of list
                    startId = last.id;

                    // Optimization: if we retrieved less than limit, we are done
                    if (pools.length < limit) break;
                } else {
                    break;
                }
                batchCount++;
            }

            if (allMatches.length > 0) {
                // Select the pool with the highest liquidity (compare balance_a)
                // Note: balance_a is a string, so we must parse it.
                // We assume all pools for the same pair have compariable balance_a (same asset or swapped).
                // If assets are swapped, we need to normalize, but usually duplicate pools have same A/B.
                // Just in case, we check asset_a.

                chosen = allMatches.sort((a, b) => {
                    let balA_a = 0;
                    if (a.asset_a === aMeta.id) balA_a = Number(a.balance_a);
                    else if (a.asset_b === aMeta.id) balA_a = Number(a.balance_b);

                    let balA_b = 0;
                    if (b.asset_a === aMeta.id) balA_b = Number(b.balance_a);
                    else if (b.asset_b === aMeta.id) balA_b = Number(b.balance_b);

                    return balA_b - balA_a; // Descending
                })[0];
            }
        } catch (e) {
            // console.log('[DEBUG] derivePoolPrice scan error:', e.message);
        }

        // Fallback to get_liquidity_pools (older/wrapper API), used by unit tests
        if (!chosen) {
            try {
                if (BitShares.db && typeof BitShares.db.get_liquidity_pools === 'function') {
                    const pools = await BitShares.db.get_liquidity_pools();
                    if (Array.isArray(pools) && pools.length > 0) {
                        const matches = pools.filter(p => {
                            const ids = (p.asset_ids || []).map(String);
                            return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                        });
                        if (matches.length > 0) {
                            chosen = matches.sort((a, b) => Number(b.total_reserve || 0) - Number(a.total_reserve || 0))[0];
                        }
                    }
                }
            } catch (e) { }
        }

        if (!chosen) {
            // Fallback to orderbook middle if no pool found
            // ... existing orderbook fallback logic if desired, or return null to let market ticker handle it
            // The existing code had orderbook logic here. Let's keep it but condensed.
            return null;
        }

        try {
            let foundAmountA = null; let foundAmountB = null;

            // If we only have a summary object, fetch the full pool object for reserves when possible
            if ((!chosen.reserves || !Array.isArray(chosen.reserves)) && chosen.id && BitShares.db && typeof BitShares.db.get_objects === 'function') {
                try {
                    const objs = await BitShares.db.get_objects([chosen.id]);
                    if (Array.isArray(objs) && objs[0]) {
                        chosen = { ...chosen, ...objs[0] };
                    }
                } catch (e) { }
            }

            // Prefer balance_a / balance_b from live object 1.19.x logic
            // Note: list_liquidity_pools returns summary objects which HAVE balance_a/b
            // We can check if we need to fetch the full object, but summary might be enough if up to date.
            // Let's assume summary from list is fresh enough.

            if (chosen.balance_a !== undefined && chosen.balance_b !== undefined) {
                // Determine which balance is which
                // chosen.asset_a might store the ID of asset A
                const isA = (chosen.asset_a === aMeta.id);
                foundAmountA = Number(isA ? chosen.balance_a : chosen.balance_b);
                foundAmountB = Number(isA ? chosen.balance_b : chosen.balance_a);
            }
            // Fallback to reserves logic if balances missing (older format?)
            else {
                if (Array.isArray(chosen.reserves) && chosen.reserves.length > 0) {
                    const rA = chosen.reserves.find(r => String(r.asset_id) === String(aMeta.id));
                    const rB = chosen.reserves.find(r => String(r.asset_id) === String(bMeta.id));
                    if (rA && rB) {
                        foundAmountA = Number(rA.amount);
                        foundAmountB = Number(rB.amount);
                    }
                }

                if (foundAmountA === null || foundAmountB === null) {
                    const reserveA = Number(chosen.reserve_a || chosen.reserve_base || 0);
                    const reserveB = Number(chosen.reserve_b || chosen.reserve_quote || 0);
                    if (chosen.asset_ids) {
                        const id0 = chosen.asset_ids[0];
                        if (String(id0) === String(aMeta.id)) {
                            foundAmountA = reserveA; foundAmountB = reserveB;
                        } else {
                            foundAmountA = reserveB; foundAmountB = reserveA;
                        }
                    }
                }
            }

            if (foundAmountA === null || foundAmountB === null) return null;

            const precisionA = aMeta.precision;
            const precisionB = bMeta.precision;

            const floatA = foundAmountA / Math.pow(10, precisionA);
            const floatB = foundAmountB / Math.pow(10, precisionB);

            if (Number.isFinite(floatA) && Number.isFinite(floatB) && floatA !== 0) {
                return (floatB !== 0 && Number.isFinite(floatB)) ? floatB / floatA : null;
            }
        } catch (e) {
            // console.log('[DEBUG] derivePoolPrice calculation error:', e.message);
        }

        return null;
    } catch (err) {
        return null;
    }
};

// derivePrice: pooled -> market -> aggregated limit orders
const derivePrice = async (BitShares, symA, symB, mode) => {
    mode = (mode === undefined || mode === null) ? 'auto' : String(mode).toLowerCase();

    if (mode === 'pool' || mode === 'auto') {
        try {
            const p = await derivePoolPrice(BitShares, symA, symB);
            if (p && Number.isFinite(p) && p > 0) {
                return p;
            }
        } catch (e) { }
    }

    // Historically, even explicit 'pool' mode falls back to market/orderbook if pool isn't available.
    if (mode === 'market' || mode === 'auto' || mode === 'pool') {
        try {
            const m = await deriveMarketPrice(BitShares, symA, symB);
            if (m && Number.isFinite(m) && m > 0) {
                return m;
            }
        } catch (e) { }
    }

    try {
        const aMeta = await lookupAsset(BitShares, symA);
        const bMeta = await lookupAsset(BitShares, symB);
        if (!aMeta || !bMeta) return null;
        const aId = aMeta.id; const bId = bMeta.id;

        let orders = await (BitShares.db && typeof BitShares.db.get_limit_orders === 'function' ? BitShares.db.get_limit_orders(aId, bId, 100) : null).catch(() => null);
        if (!orders || !orders.length) {
            const rev = await (BitShares.db && typeof BitShares.db.get_limit_orders === 'function' ? BitShares.db.get_limit_orders(bId, aId, 100) : null).catch(() => null);
            orders = rev || [];
        }
        if (!orders || !orders.length) return null;

        const parseOrder = async (order) => {
            if (!order || !order.sell_price) return null;
            const { base, quote } = order.sell_price;
            const basePrec = await (BitShares.assets && BitShares.assets[base.asset_id] ? (BitShares.assets[base.asset_id].precision || 0) : (async () => { try { const a = await BitShares.db.get_assets([base.asset_id]); return (a && a[0] && typeof a[0].precision === 'number') ? a[0].precision : 0; } catch (e) { return 0; } })());
            const basePrecision = typeof basePrec === 'number' ? basePrec : await basePrec;
            const quotePrec = await (BitShares.assets && BitShares.assets[quote.asset_id] ? (BitShares.assets[quote.asset_id].precision || 0) : (async () => { try { const a = await BitShares.db.get_assets([quote.asset_id]); return (a && a[0] && typeof a[0].precision === 'number') ? a[0].precision : 0; } catch (e) { return 0; } })());
            const quotePrecision = typeof quotePrec === 'number' ? quotePrec : await quotePrec;

            const baseAmt = Number(base.amount || 0);
            const quoteAmt = Number(quote.amount || 0);
            if (!baseAmt || !quoteAmt) return null;
            const price = (quoteAmt / baseAmt) * Math.pow(10, basePrecision - quotePrecision);
            const size = Number(order.for_sale || 0) / Math.pow(10, basePrecision || 0);
            return { price, size, baseId: String(base.asset_id), quoteId: String(quote.asset_id) };
        };

        let sumNum = 0, sumDen = 0;
        for (const o of orders) {
            const p = await parseOrder(o);
            if (!p) continue;
            let priceInDesired = null;
            if (p.baseId === String(aId) && p.quoteId === String(bId)) priceInDesired = p.price;
            else if (p.baseId === String(bId) && p.quoteId === String(aId)) { if (p.price !== 0) priceInDesired = 1 / p.price; }
            else continue;
            if (!Number.isFinite(priceInDesired) || priceInDesired <= 0) continue;
            const weight = Math.max(1e-12, p.size);
            sumNum += priceInDesired * weight;
            sumDen += weight;
        }
        if (!sumDen) return null;
        return sumNum / sumDen;
    } catch (e) { }

    return null;

};

// ---------------------------------------------------------------------------
// Fee caching and retrieval
// ---------------------------------------------------------------------------

/**
 * Cache for storing fee information for all assets
 * Structure: {
 *   assetSymbol: {
 *     assetId: string,
 *     precision: number,
 *     marketFee: { basisPoints: number, percent: number },
 *     takerFee: { percent: number } | null,
 *     maxMarketFee: { raw: number, float: number }
 *   },
 *   BTS: { blockchain fees - see below }
 * }
 */
let feeCache = {};

/**
 * Initialize and cache fees for all assets from bots.json configuration
 * Also includes BTS for blockchain fees (maker/taker order creation/cancel)
 *
 * @param {Array} botsConfig - Array of bot configurations from bots.json
 * @param {object} BitShares - BitShares library instance for fetching asset data
 * @returns {Promise<object>} The populated fee cache
 */
async function initializeFeeCache(botsConfig, BitShares) {
    if (!botsConfig || !Array.isArray(botsConfig)) {
        throw new Error('botsConfig must be an array of bot configurations');
    }
    if (!BitShares || !BitShares.db) {
        throw new Error('BitShares library instance with db methods required');
    }

    // Extract unique asset symbols from bot configurations
    const uniqueAssets = new Set(['BTS']); // Always include BTS for blockchain fees

    for (const bot of botsConfig) {
        if (bot.assetA) uniqueAssets.add(bot.assetA);
        if (bot.assetB) uniqueAssets.add(bot.assetB);
    }

    // Fetch and cache fees for each asset
    for (const assetSymbol of uniqueAssets) {
        try {
            if (assetSymbol === 'BTS') {
                // Special handling for BTS - fetch blockchain operation fees
                feeCache.BTS = await _fetchBlockchainFees(BitShares);
            } else {
                // Fetch market fees for other assets
                feeCache[assetSymbol] = await _fetchAssetMarketFees(assetSymbol, BitShares);
            }
        } catch (error) {
            console.error(`Error caching fees for ${assetSymbol}:`, error.message);
            // Continue with other assets even if one fails
        }
    }

    return feeCache;
}

/**
 * Get cached fees for a specific asset
 * Useful for checking if cache has been initialized
 *
 * @param {string} assetSymbol - Asset symbol (e.g., 'IOB.XRP', 'TWENTIX', 'BTS')
 * @returns {object|null} Fee data if cached, null otherwise
 */
function getCachedFees(assetSymbol) {
    return feeCache[assetSymbol] || null;
}

/**
 * Clear the fee cache (useful for testing or refreshing)
 */
function clearFeeCache() {
    feeCache = {};
}

/**
 * Get total fees (blockchain + market) for a filled order amount
 *
 * @param {string} assetSymbol - Asset symbol (e.g., 'IOB.XRP', 'TWENTIX', 'BTS')
 * @param {number} assetAmount - Amount of asset to calculate fees for
 * @returns {number|object} Fee amount in the asset's native units
 *   For BTS: object with { total: number, createFee: number }
 *     - total: blockchain fees (creation 10% + update)
 *     - createFee: the full limit order creation fee
 *   For market assets: total fee amount (number)
 */
function getAssetFees(assetSymbol, assetAmount) {
    const cachedFees = feeCache[assetSymbol];

    if (!cachedFees) {
        throw new Error(`Fees not cached for ${assetSymbol}. Call initializeFeeCache first.`);
    }

    assetAmount = Number(assetAmount);
    if (!Number.isFinite(assetAmount) || assetAmount < 0) {
        throw new Error(`Invalid assetAmount: ${assetAmount}`);
    }

    // Special handling for BTS (blockchain fees only)
    if (assetSymbol === 'BTS') {
        const orderCreationFee = cachedFees.limitOrderCreate.bts;
        const orderUpdateFee = cachedFees.limitOrderUpdate.bts;
        const makerNetFee = orderCreationFee * 0.1; // 10% of creation fee after 90% refund
        return {
            total: makerNetFee + orderUpdateFee,
            createFee: orderCreationFee,
            updateFee: orderUpdateFee,
            makerNetFee: makerNetFee
        };
    }

    // Handle regular assets - deduct market fee from the amount received
    const marketFeePercent = cachedFees.marketFee?.percent || 0;
    const marketFeeAmount = (assetAmount * marketFeePercent) / 100;

    // Return amount after market fees are deducted
    return assetAmount - marketFeeAmount;
}

/**
 * Internal function to fetch blockchain operation fees
 */
async function _fetchBlockchainFees(BitShares) {
    try {
        const globalProps = await BitShares.db.getGlobalProperties();
        const currentFees = globalProps.parameters.current_fees;

        const fees = {
            limitOrderCreate: { raw: 0, satoshis: 0, bts: 0 },
            limitOrderCancel: { raw: 0, satoshis: 0, bts: 0 },
            limitOrderUpdate: { raw: 0, satoshis: 0, bts: 0 }
        };

        // Extract fees from the parameters array
        for (let i = 0; i < currentFees.parameters.length; i++) {
            const param = currentFees.parameters[i];
            if (!param || param.length < 2) continue;

            const opCode = param[0];
            const feeData = param[1];

            if (opCode === 1 && feeData.fee !== undefined) {
                // Operation 1: limit_order_create
                fees.limitOrderCreate = {
                    raw: feeData.fee,
                    satoshis: Number(feeData.fee),
                    bts: blockchainToFloat(feeData.fee, 5)
                };
            } else if (opCode === 2 && feeData.fee !== undefined) {
                // Operation 2: limit_order_cancel
                fees.limitOrderCancel = {
                    raw: feeData.fee,
                    satoshis: Number(feeData.fee),
                    bts: blockchainToFloat(feeData.fee, 5)
                };
            } else if (opCode === 77 && feeData.fee !== undefined) {
                // Operation 77: limit_order_update
                fees.limitOrderUpdate = {
                    raw: feeData.fee,
                    satoshis: Number(feeData.fee),
                    bts: blockchainToFloat(feeData.fee, 5)
                };
            }
        }

        return fees;
    } catch (error) {
        throw new Error(`Failed to fetch blockchain fees: ${error.message}`);
    }
}

/**
 * Internal function to fetch market fees for a specific asset
 */
async function _fetchAssetMarketFees(assetSymbol, BitShares) {
    try {
        const assetData = await BitShares.db.lookupAssetSymbols([assetSymbol]);
        if (!assetData || !assetData[0]) {
            throw new Error(`Asset ${assetSymbol} not found`);
        }

        const assetId = assetData[0].id;
        const fullAssets = await BitShares.db.getAssets([assetId]);
        if (!fullAssets || !fullAssets[0]) {
            throw new Error(`Could not fetch full data for ${assetSymbol}`);
        }

        const fullAsset = fullAssets[0];
        const options = fullAsset.options || {};

        const marketFeeBasisPoints = options.market_fee_percent || 0;
        const marketFeePercent = marketFeeBasisPoints / 100;

        // Extract taker fee from extensions
        let takerFeePercent = null;
        if (options.extensions && typeof options.extensions === 'object') {
            if (options.extensions.taker_fee_percent !== undefined) {
                const value = Number(options.extensions.taker_fee_percent || 0);
                takerFeePercent = value / 100;
            }
        }

        // Check if taker_fee_percent exists directly in options
        if (takerFeePercent === null && options.taker_fee_percent !== undefined) {
            const value = Number(options.taker_fee_percent || 0);
            takerFeePercent = value / 100;
        }

        return {
            assetId: assetId,
            symbol: assetSymbol,
            precision: fullAsset.precision,
            marketFee: {
                basisPoints: marketFeeBasisPoints,
                percent: marketFeePercent
            },
            takerFee: takerFeePercent !== null ? { percent: takerFeePercent } : null,
            maxMarketFee: {
                raw: options.max_market_fee || 0,
                float: blockchainToFloat(options.max_market_fee || 0, fullAsset.precision)
            },
            issuer: fullAsset.issuer
        };
    } catch (error) {
        throw new Error(`Failed to fetch market fees for ${assetSymbol}: ${error.message}`);
    }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Centralized grid persistence helper.
 * Handles all persistence operations (grid snapshot + fund data) in one call.
 * Automatically manages error handling without throwing exceptions.
 *
 * Usage: Instead of:
 *   accountOrders.storeMasterGrid(botKey, Array.from(manager.orders.values()),
 *                                  manager.funds.cacheFunds,
 *                                  manager.funds.btsFeesOwed);
 *   const feesOk = manager._persistBtsFeesOwed();
 *
 * Just use:
 *   persistGridSnapshot(manager, accountOrders, botKey);
 *
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders instance for storage
 * @param {string} botKey - Bot identifier key
 * @returns {boolean} true if all persistence succeeded, false if any failed
 */
function persistGridSnapshot(manager, accountOrders, botKey) {
    if (!manager || !accountOrders || !botKey) {
        return false;
    }

    try {
        // Persist the complete grid with all fund data
        accountOrders.storeMasterGrid(
            botKey,
            Array.from(manager.orders.values()),
            manager.funds.cacheFunds,
            manager.funds.btsFeesOwed
        );

        // Also try to persist fees component for redundancy
        const feesOk = manager._persistBtsFeesOwed?.();

        return (feesOk !== false);
    } catch (e) {
        if (manager.logger) {
            manager.logger.log(`Error during grid persistence: ${e.message}`, 'error');
        }
        return false;
    }
}

/**
 * Retry persistence of previously failed fund data.
 * Called periodically when bot is in a stable state to retry saving funds that couldn't be persisted.
 * Useful when disk I/O errors occur but later become transient.
 *
 * @param {Object} manager - The OrderManager instance containing persistence state
 * @returns {boolean} true if all retried data persisted successfully, false if some still failing
 *
 * Example:
 *   retryPersistenceIfNeeded(manager);
 */
function retryPersistenceIfNeeded(manager) {
    if (!manager) {
        return true;
    }

    if (!manager._persistenceWarning) {
        return true;  // No pending persistence issues
    }

    const warning = manager._persistenceWarning;
    if (manager.logger) {
        manager.logger.log(`Retrying persistence for ${warning.type} (failed at ${new Date(warning.timestamp).toISOString()})...`, 'info');
    }

    try {
        if (warning.type === 'pendingProceeds' || warning.type === 'cacheFunds') {
            const success = typeof manager._persistCacheFunds === 'function' ? manager._persistCacheFunds() : true;
            if (success && manager.logger) {
                manager.logger.log(`✓ Successfully retried cacheFunds persistence (was: ${warning.type})`, 'info');
            }
            return success;
        } else if (warning.type === 'btsFeesOwed') {
            const success = manager._persistBtsFeesOwed();
            if (success && manager.logger) {
                manager.logger.log(`✓ Successfully retried btsFeesOwed persistence`, 'info');
            }
            return success;
        }
    } catch (e) {
        if (manager.logger) {
            manager.logger.log(`Error during persistence retry: ${e.message}`, 'error');
        }
        return false;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Grid comparisons
// ---------------------------------------------------------------------------
/**
 * Run grid comparisons after rotation to detect divergence.
 * Executes both simple cache ratio check and quadratic comparison.
 *
 * @param {Object} manager - The OrderManager instance
 * @param {Object} accountOrders - AccountOrders instance for loading persisted grid
 * @param {string} botKey - Bot key for grid retrieval
 */
async function runGridComparisons(manager, accountOrders, botKey) {
    if (!manager || !accountOrders) return;

    try {
        const Grid = require('./grid');
        const persistedGrid = accountOrders.loadBotGrid(botKey) || [];
        const calculatedGrid = Array.from(manager.orders.values());

        manager.logger?.log?.(
            `Starting grid comparisons: persistedGrid=${persistedGrid.length} orders, calculatedGrid=${calculatedGrid.length} orders, cacheFunds=buy:${manager.funds.cacheFunds.buy.toFixed(8)}/sell:${manager.funds.cacheFunds.sell.toFixed(8)}`,
            'debug'
        );

        // Step 1: Simple percentage-based check
        // Populates _gridSidesUpdated if cache ratio exceeds threshold
        const simpleCheckResult = Grid.checkAndUpdateGridIfNeeded(manager, manager.funds.cacheFunds);

        manager.logger?.log?.(
            `Simple check result: buyUpdated=${simpleCheckResult.buyUpdated}, sellUpdated=${simpleCheckResult.sellUpdated}`,
            'debug'
        );

        // Step 2: Quadratic comparison (if simple check didn't trigger)
        // Detects deeper structural divergence and also populates _gridSidesUpdated
        if (!simpleCheckResult.buyUpdated && !simpleCheckResult.sellUpdated) {
            const comparisonResult = Grid.compareGrids(calculatedGrid, persistedGrid, manager, manager.funds.cacheFunds);

            manager.logger?.log?.(
                `Quadratic comparison complete: buy=${comparisonResult.buy.metric.toFixed(6)}, sell=${comparisonResult.sell.metric.toFixed(6)}, buyUpdated=${comparisonResult.buy.updated}, sellUpdated=${comparisonResult.sell.updated}`,
                'debug'
            );

            if (comparisonResult.buy.metric > 0 || comparisonResult.sell.metric > 0) {
                manager.logger?.log?.(
                    `Grid divergence detected after rotation: buy=${comparisonResult.buy.metric.toFixed(6)}, sell=${comparisonResult.sell.metric.toFixed(6)}`,
                    'info'
                );
            }
        } else {
            manager.logger?.log?.(
                `Simple check triggered grid updates, skipping quadratic comparison`,
                'debug'
            );
        }
    } catch (err) {
        manager?.logger?.log?.(`Warning: Could not run grid comparisons after rotation: ${err.message}`, 'warn');
    }
}

// Grid divergence corrections
// ---------------------------------------------------------------------------
/**
 * Apply order corrections for sides marked by grid comparisons.
 * Marks orders on divergence-detected sides for size correction and executes batch update.
 *
 * @param {Object} manager - The OrderManager instance
 * @param {Object} accountOrders - AccountOrders instance for persistence
 * @param {string} botKey - Bot key for grid persistence
 * @param {Function} updateOrdersOnChainBatchFn - Callback function to execute batch updates (from bot/dexbot context)
 */
async function applyGridDivergenceCorrections(manager, accountOrders, botKey, updateOrdersOnChainBatchFn) {
    if (!manager?._gridSidesUpdated || manager._gridSidesUpdated.length === 0) {
        return;
    }

    const { ORDER_STATES } = require('../constants');
    const Grid = require('./grid');

    // NOTE: Grid recalculation is already done by the caller (Grid.updateGridFromBlockchainSnapshot)
    // This function only applies the corrections on-chain, no need to recalculate again

    // Build array of orders needing correction from sides marked by grid comparisons
    for (const orderType of manager._gridSidesUpdated) {
        const ordersOnSide = Array.from(manager.orders.values())
            .filter(o => o.type === orderType && o.orderId && o.state === ORDER_STATES.ACTIVE);

        for (const order of ordersOnSide) {
            // Mark for size correction (sizeChanged=true means we won't price-correct, just size)
            manager.ordersNeedingPriceCorrection.push({
                gridOrder: { ...order },
                chainOrderId: order.orderId,
                rawChainOrder: null,
                expectedPrice: order.price,
                actualPrice: order.price,
                expectedSize: order.size,
                size: order.size,
                type: order.type,
                sizeChanged: true
            });
        }
    }

    if (manager.ordersNeedingPriceCorrection.length > 0) {
        manager.logger?.log?.(
            `DEBUG: Marked ${manager.ordersNeedingPriceCorrection.length} orders for size correction after grid divergence detection (sides: ${manager._gridSidesUpdated.join(', ')})`,
            'info'
        );

        // Log specific orders being corrected
        manager.ordersNeedingPriceCorrection.slice(0, 3).forEach(corr => {
            manager.logger?.log?.(
                `  Correcting: ${corr.chainOrderId} | current size: ${corr.size.toFixed(8)} | price: ${corr.expectedPrice.toFixed(4)}`,
                'debug'
            );
        });

        // Clear the tracking flag
        manager._gridSidesUpdated = [];

        // Build rotation objects for size corrections
        const ordersToRotate = manager.ordersNeedingPriceCorrection.map(correction => ({
            oldOrder: { orderId: correction.chainOrderId },
            newPrice: correction.expectedPrice,
            newSize: correction.size,
            type: correction.type
        }));

        // Execute a batch correction for these marked orders
        try {
            await updateOrdersOnChainBatchFn({
                ordersToPlace: [],
                ordersToRotate: ordersToRotate,
                partialMoves: []
            });

            // Clear corrections after applying
            manager.ordersNeedingPriceCorrection = [];

            // Re-persist grid after corrections are applied to keep persisted state in sync
            persistGridSnapshot(manager, accountOrders, botKey);
        } catch (err) {
            manager?.logger?.log?.(`Warning: Could not execute grid divergence corrections: ${err.message}`, 'warn');
        }
    }
}

// ---------------------------------------------------------------------------
// Order building helpers
// ---------------------------------------------------------------------------

/**
 * Build create order arguments from an order object and asset information.
 * Handles both SELL and BUY orders, calculating appropriate amounts based on order type.
 *
 * @param {Object} order - Order object with type, size, and price
 * @param {Object} assetA - Base asset object with id property
 * @param {Object} assetB - Quote asset object with id property
 * @returns {Object} - { amountToSell, sellAssetId, minToReceive, receiveAssetId }
 */
function buildCreateOrderArgs(order, assetA, assetB) {
    let amountToSell, sellAssetId, minToReceive, receiveAssetId;
    if (order.type === 'sell') {
        amountToSell = order.size;
        sellAssetId = assetA.id;
        minToReceive = order.size * order.price;
        receiveAssetId = assetB.id;
    } else {
        amountToSell = order.size;
        sellAssetId = assetB.id;
        minToReceive = order.size / order.price;
        receiveAssetId = assetA.id;
    }
    return { amountToSell, sellAssetId, minToReceive, receiveAssetId };
}

// ---------------------------------------------------------------------------
// Numeric Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Safely convert a value to a finite number with fallback.
 * @param {*} value - Value to convert
 * @param {number} defaultValue - Fallback if not finite (default: 0)
 * @returns {number} Finite number or default
 */
function toFiniteNumber(value, defaultValue = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : defaultValue;
}

/**
 * Check if a value is defined and represents a finite number.
 * @param {*} value - Value to check
 * @returns {boolean} True if value is defined and finite
 */
function isValidNumber(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
}

/**
 * Compare two sizes at blockchain integer precision.
 * @param {number} size1 - First size
 * @param {number} size2 - Second size
 * @param {number} precision - Blockchain precision
 * @returns {number} -1 if size1 < size2, 0 if equal, 1 if size1 > size2
 */
function compareBlockchainSizes(size1, size2, precision) {
    const int1 = floatToBlockchainInt(size1, precision);
    const int2 = floatToBlockchainInt(size2, precision);
    if (int1 === int2) return 0;
    return int1 > int2 ? 1 : -1;
}

/**
 * Compute remaining size after a fill at blockchain precision.
 * @param {number} currentSize - Current order size
 * @param {number} filledAmount - Amount filled
 * @param {number} precision - Blockchain precision
 * @returns {number} Remaining size after fill
 */
function computeSizeAfterFill(currentSize, filledAmount, precision) {
    const currentInt = floatToBlockchainInt(currentSize, precision);
    const filledInt = floatToBlockchainInt(filledAmount, precision);
    const remainingInt = Math.max(0, currentInt - filledInt);
    return blockchainToFloat(remainingInt, precision);
}

/**
 * Filter orders by type.
 * @param {Array<Object>} orders - Orders to filter
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @returns {Array<Object>} Filtered orders
 */
function filterOrdersByType(orders, orderType) {
    return Array.isArray(orders) ? orders.filter(o => o && o.type === orderType) : [];
}

/**
 * Filter orders by type and exclude a specific state.
 * @param {Array<Object>} orders - Orders to filter
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {string|null} excludeState - State to exclude (optional)
 * @returns {Array<Object>} Filtered orders
 */
function filterOrdersByTypeAndState(orders, orderType, excludeState = null) {
    return Array.isArray(orders) ? orders.filter(o => o && o.type === orderType && (!excludeState || o.state !== excludeState)) : [];
}

/**
 * Sum all sizes in an array of orders.
 * @param {Array<Object>} orders - Orders with size property
 * @returns {number} Total of all sizes
 */
function sumOrderSizes(orders) {
    return Array.isArray(orders) ? orders.reduce((sum, o) => sum + (Number(o.size) || 0), 0) : 0;
}

/**
 * Extract sizes from orders as an array of numbers.
 * @param {Array<Object>} orders - Orders with size property
 * @returns {Array<number>} Sizes as numbers
 */
function mapOrderSizes(orders) {
    return Array.isArray(orders) ? orders.map(o => Number(o.size || 0)) : [];
}

/**
 * Count active and partial orders by type (used for target comparison).
 * Includes both ACTIVE and PARTIAL orders since both take up grid positions.
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {Map} ordersMap - The orders map from OrderManager
 * @returns {number} Count of ACTIVE + PARTIAL orders of the given type
 */
function countOrdersByType(orderType, ordersMap) {
    const { ORDER_STATES } = require('../constants');
    if (!ordersMap || ordersMap.size === 0) return 0;

    let count = 0;
    for (const order of ordersMap.values()) {
        if (order.type === orderType &&
            (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL)) {
            count++;
        }
    }
    return count;
}

// ---------------------------------------------------------------------------
// Precision Helpers
// ---------------------------------------------------------------------------

/**
 * Get blockchain precision for an order type.
 * SELL orders use assetA precision, BUY orders use assetB precision.
 * @param {Object} assets - Assets object with assetA and assetB precision
 * @param {string} orderType - ORDER_TYPES.SELL or ORDER_TYPES.BUY
 * @returns {number} Precision (defaults to 8)
 */
function getPrecisionByOrderType(assets, orderType) {
    const { ORDER_TYPES } = require('../constants');
    return orderType === ORDER_TYPES.SELL
        ? (assets?.assetA?.precision ?? 8)
        : (assets?.assetB?.precision ?? 8);
}

/**
 * Get blockchain precision for a side string.
 * @param {Object} assets - Assets object with assetA and assetB precision
 * @param {string} side - 'buy' or 'sell'
 * @returns {number} Precision (defaults to 8)
 */
function getPrecisionForSide(assets, side) {
    return side === 'buy'
        ? (assets?.assetB?.precision ?? 8)
        : (assets?.assetA?.precision ?? 8);
}

/**
 * Get both asset precisions at once.
 * @param {Object} assets - Assets object with assetA and assetB precision
 * @returns {Object} { A: precisionA, B: precisionB }
 */
function getPrecisionsForManager(assets) {
    return {
        A: assets?.assetA?.precision ?? 8,
        B: assets?.assetB?.precision ?? 8
    };
}

/**
 * Check if trading pair includes BTS as one of the assets.
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol
 * @returns {boolean} True if either asset is BTS
 */
function hasBtsPair(assetA, assetB) {
    return assetA === 'BTS' || assetB === 'BTS';
}

/**
 * Check if any order sizes fall below a minimum threshold.
 * Uses precision-aware integer comparison when available.
 * @param {Array<number>} sizes - Order sizes to check
 * @param {number} minSize - Minimum allowed size
 * @param {number|null} precision - Blockchain precision for integer comparison
 * @returns {boolean} True if any size is below minimum
 */
function checkSizesBeforeMinimum(sizes, minSize, precision) {
    if (minSize <= 0 || !Array.isArray(sizes) || sizes.length === 0) return false;

    if (precision !== undefined && precision !== null && Number.isFinite(precision)) {
        const minInt = floatToBlockchainInt(minSize, precision);
        return sizes.some(sz =>
            (!Number.isFinite(sz)) ||
            (Number.isFinite(sz) && sz > 0 && floatToBlockchainInt(sz, precision) < minInt)
        );
    } else {
        return sizes.some(sz =>
            (!Number.isFinite(sz)) ||
            (Number.isFinite(sz) && sz > 0 && sz < (minSize - 1e-8))
        );
    }
}

/**
 * Check if any order sizes fall near a warning threshold.
 * Uses precision-aware integer comparison when available.
 * @param {Array<number>} sizes - Order sizes to check
 * @param {number} warningSize - Warning threshold size
 * @param {number|null} precision - Blockchain precision for integer comparison
 * @returns {boolean} True if any size is near/below warning threshold
 */
function checkSizesNearMinimum(sizes, warningSize, precision) {
    if (warningSize <= 0 || !Array.isArray(sizes) || sizes.length === 0) return false;

    if (precision !== undefined && precision !== null && Number.isFinite(precision)) {
        const warnInt = floatToBlockchainInt(warningSize, precision);
        return sizes.some(sz => Number.isFinite(sz) && sz > 0 && floatToBlockchainInt(sz, precision) < warnInt);
    } else {
        return sizes.some(sz => Number.isFinite(sz) && sz > 0 && sz < (warningSize - 1e-8));
    }
}

/**
 * Calculate BTS fees needed for creating target orders (with 5x buffer for rotations).
 * Returns 0 if pair doesn't include BTS, or 100 as fallback if calculation fails.
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol
 * @param {number} totalOrders - Total number of orders to create
 * @param {number} feeMultiplier - Multiplier for fees (default: 5 for creation + rotation buffer)
 * @returns {number} Total BTS fees to reserve
 */
function calculateOrderCreationFees(assetA, assetB, totalOrders, feeMultiplier = 5) {
    if (assetA !== 'BTS' && assetB !== 'BTS') return 0;

    try {
        if (totalOrders > 0) {
            const btsFeeData = getAssetFees('BTS', 1);
            return btsFeeData.createFee * totalOrders * feeMultiplier;
        }
    } catch (err) {
        // Return fallback
        return 100;
    }

    return 0;
}

/**
 * Apply order creation fee deduction to input funds for the appropriate side.
 * Returns adjusted funds after fee reservation with logging.
 * @param {number} buyFunds - Original buy-side funds
 * @param {number} sellFunds - Original sell-side funds
 * @param {number} fees - Total fees to deduct
 * @param {Object} config - Config object with assetA, assetB
 * @param {Object} logger - Logger instance (optional)
 * @returns {Object} { buyFunds, sellFunds } - Adjusted funds after fees
 */
function deductOrderFeesFromFunds(buyFunds, sellFunds, fees, config, logger = null) {
    let finalBuy = buyFunds;
    let finalSell = sellFunds;

    if (fees > 0) {
        if (config?.assetB === 'BTS') {
            finalBuy = Math.max(0, buyFunds - fees);
            if (logger?.log) {
                logger.log(
                    `Reduced available BTS (buy) funds by ${fees.toFixed(8)} for order creation fees: ${buyFunds.toFixed(8)} -> ${finalBuy.toFixed(8)}`,
                    'info'
                );
            }
        } else if (config?.assetA === 'BTS') {
            finalSell = Math.max(0, sellFunds - fees);
            if (logger?.log) {
                logger.log(
                    `Reduced available BTS (sell) funds by ${fees.toFixed(8)} for order creation fees: ${sellFunds.toFixed(8)} -> ${finalSell.toFixed(8)}`,
                    'info'
                );
            }
        }
    }

    return { buyFunds: finalBuy, sellFunds: finalSell };
}

// ---------------------------------------------------------------------------
// Grid Sizing & Allocation (moved from grid.js)
// ---------------------------------------------------------------------------

/**
 * Allocate funds across n orders using geometric weighting.
 * Creates exponentially-scaled order sizes based on position and weight distribution.
 *
 * @param {number} totalFunds - Total funds to distribute
 * @param {number} n - Number of orders
 * @param {number} weight - Weight distribution (-1 to 2): controls exponential scaling
 * @param {number} incrementFactor - Increment percentage / 100 (e.g., 0.01 for 1%)
 * @param {boolean} reverse - If true, reverse position indexing (for sell orders high→low)
 * @param {number} minSize - Minimum order size
 * @param {number|null} precision - Blockchain precision for quantization
 * @returns {Array<number>} Array of order sizes
 */
function allocateFundsByWeights(totalFunds, n, weight, incrementFactor, reverse = false, minSize = 0, precision = null) {
    if (n <= 0) return [];
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    if (!Number.isFinite(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
        throw new Error(`Invalid weight distribution: ${weight}. Must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
    }

    // CRITICAL: Validate increment factor (0.01 to 0.10 for 1% to 10%)
    // If incrementFactor is 0, base = 1, and all orders get equal weight (loses position weighting)
    // If incrementFactor >= 1, base <= 0, causing invalid exponential calculation
    if (incrementFactor <= 0 || incrementFactor >= 1) {
        throw new Error(`Invalid incrementFactor: ${incrementFactor}. Must be between 0.0001 (0.01%) and 0.10 (10%).`);
    }

    // Step 1: Calculate base factor from increment
    // base = (1 - increment) creates exponential decay/growth
    // e.g., 1% increment → base = 0.99
    const base = 1 - incrementFactor;

    // Step 2: Calculate raw weights for each order position
    // The formula: weight[i] = base^(idx * weight)
    // - base^0 = 1.0 (first position always gets base weight)
    // - base^(idx*weight) scales exponentially based on position and weight coefficient
    // - reverse parameter inverts the position index so sell orders decrease geometrically
    const rawWeights = new Array(n);
    for (let i = 0; i < n; i++) {
        const idx = reverse ? (n - 1 - i) : i;
        rawWeights[i] = Math.pow(base, idx * weight);
    }

    // Step 3: Normalize weights to sum to 1, then scale by totalFunds
    // This ensures all funds are distributed and ratios are preserved
    const sizes = new Array(n).fill(0);
    const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;

    if (precision !== null && precision !== undefined) {
        // Quantitative allocation: use units to avoid floating point noise from the start
        // This ensures every order in the grid is perfectly aligned with blockchain increments.
        const totalUnits = floatToBlockchainInt(totalFunds, precision);
        let unitsSummary = 0;
        const units = new Array(n);

        for (let i = 0; i < n; i++) {
            units[i] = Math.round((rawWeights[i] / totalWeight) * totalUnits);
            unitsSummary += units[i];
        }

        // Adjust for rounding discrepancy in units calculation (usually +/- 1 unit)
        const diff = totalUnits - unitsSummary;
        if (diff !== 0 && n > 0) {
            // Adjust first order for simplicity (closest to market in mountain style)
            units[0] = Math.max(0, units[0] + diff);
        }

        for (let i = 0; i < n; i++) {
            sizes[i] = blockchainToFloat(units[i], precision);
        }
    } else {
        // Fallback for cases without precision (not recommended for grid orders)
        for (let i = 0; i < n; i++) {
            sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
        }
    }

    return sizes;
}

/**
 * Size orders based on config weight distribution and available funds.
 * Applies sizes proportionally to sell and buy order lists.
 *
 * @param {Array<Object>} orders - Order array with type property
 * @param {Object} config - Config with incrementPercent and weightDistribution
 * @param {number} sellFunds - Available sell-side funds
 * @param {number} buyFunds - Available buy-side funds
 * @param {number} minSellSize - Minimum sell order size
 * @param {number} minBuySize - Minimum buy order size
 * @param {number|null} precisionA - Asset A precision for quantization
 * @param {number|null} precisionB - Asset B precision for quantization
 * @returns {Array<Object>} Orders with assigned sizes
 */
function calculateOrderSizes(orders, config, sellFunds, buyFunds, minSellSize = 0, minBuySize = 0, precisionA = null, precisionB = null) {
    const { ORDER_TYPES } = require('../constants');
    const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
    const incrementFactor = incrementPercent / 100;

    const sellOrders = filterOrdersByType(orders, ORDER_TYPES.SELL);
    const buyOrders = filterOrdersByType(orders, ORDER_TYPES.BUY);

    const sellSizes = allocateFundsByWeights(sellFunds, sellOrders.length, sellWeight, incrementFactor, true, minSellSize, precisionA);
    const buySizes = allocateFundsByWeights(buyFunds, buyOrders.length, buyWeight, incrementFactor, false, minBuySize, precisionB);

    const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
    return orders.map(order => ({
        ...order,
        size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
    }));
}

/**
 * Calculate order sizes for rotation cycles based on available and grid funds.
 *
 * @param {number} availableFunds - Available funds for new orders
 * @param {number} totalGridAllocation - Total currently allocated to grid
 * @param {number} orderCount - Number of orders to size
 * @param {string} orderType - ORDER_TYPES.SELL or ORDER_TYPES.BUY
 * @param {Object} config - Config with incrementPercent and weightDistribution
 * @param {number} minSize - Minimum order size
 * @param {number|null} precision - Blockchain precision for quantization
 * @returns {Array<number>} Order sizes for rotation
 */
function calculateRotationOrderSizes(availableFunds, totalGridAllocation, orderCount, orderType, config, minSize = 0, precision = null) {
    const { ORDER_TYPES } = require('../constants');

    if (orderCount <= 0) {
        return [];
    }

    // Combine available + grid allocation to calculate total sizing context
    // This represents the "full reset" amount if we were regenerating the entire grid
    const totalFunds = availableFunds + totalGridAllocation;

    if (!Number.isFinite(totalFunds) || totalFunds <= 0) {
        return new Array(orderCount).fill(0);
    }

    const { incrementPercent, weightDistribution } = config;
    const incrementFactor = incrementPercent / 100;

    // Select weight distribution based on side (buy or sell)
    const weight = (orderType === ORDER_TYPES.SELL) ? weightDistribution.sell : weightDistribution.buy;

    // Reverse the allocation for sell orders so they're ordered from high to low price
    const reverse = (orderType === ORDER_TYPES.SELL);

    // Allocate total funds using geometric weighting
    return allocateFundsByWeights(totalFunds, orderCount, weight, incrementFactor, reverse, minSize, precision);
}

/**
 * Calculate RMS divergence metric between calculated and persisted grid sides.
 * Matches orders by ID and compares sizes; unmatched orders treated as max divergence.
 *
 * @param {Array<Object>} calculatedOrders - Orders generated by grid algorithm
 * @param {Array<Object>} persistedOrders - Orders persisted in storage
 * @param {string} sideName - Side name for logging ('buy', 'sell')
 * @returns {number} RMS metric (0 = perfect match, higher = more divergence)
 */
function calculateGridSideDivergenceMetric(calculatedOrders, persistedOrders, sideName = 'unknown') {
    if (!Array.isArray(calculatedOrders) || !Array.isArray(persistedOrders)) {
        return 0;
    }

    if (calculatedOrders.length === 0 && persistedOrders.length === 0) {
        return 0;
    }

    // Build lookup map by grid ID for stable matching
    const persistedMap = new Map();
    for (const order of persistedOrders) {
        if (order.id) {
            persistedMap.set(order.id, order);
        }
    }

    let sumSquaredDiff = 0;
    let matchCount = 0;
    let unmatchedCount = 0;
    let maxRelativeDiff = 0;

    // Compare each calculated order with its persisted counterpart by ID
    const largeDeviations = [];

    for (const calcOrder of calculatedOrders) {
        const persOrder = persistedMap.get(calcOrder.id);

        if (persOrder) {
            // Matched by ID: compare sizes
            const calcSize = Number(calcOrder.size) || 0;
            const persSize = Number(persOrder.size) || 0;

            if (persSize > 0) {
                // Normal relative difference when both sizes are positive
                const relativeDiff = (calcSize - persSize) / persSize;
                const relativePercent = Math.abs(relativeDiff) * 100;

                // Track large deviations for debugging
                if (relativePercent > 10) {  // More than 10% different
                    largeDeviations.push({
                        id: calcOrder.id,
                        persSize: persSize.toFixed(8),
                        calcSize: calcSize.toFixed(8),
                        percentDiff: relativePercent.toFixed(2)
                    });
                }

                sumSquaredDiff += relativeDiff * relativeDiff;
                maxRelativeDiff = Math.max(maxRelativeDiff, Math.abs(relativeDiff));
                matchCount++;
            } else if (calcSize > 0) {
                // If persisted size is 0 but calculated size is > 0, treat as maximum divergence
                largeDeviations.push({
                    id: calcOrder.id,
                    persSize: '0.00000000',
                    calcSize: calcSize.toFixed(8),
                    percentDiff: 'Infinity'
                });
                sumSquaredDiff += 1.0;
                maxRelativeDiff = Math.max(maxRelativeDiff, 1.0);
                matchCount++;
            } else {
                // Both are zero: perfect match
                matchCount++;
            }
        } else {
            // Unmatched by ID: grid structure mismatch
            largeDeviations.push({
                id: calcOrder.id,
                persSize: 'NOT_FOUND',
                calcSize: (Number(calcOrder.size) || 0).toFixed(8),
                percentDiff: 'Unmatched'
            });
            sumSquaredDiff += 1.0;
            maxRelativeDiff = Math.max(maxRelativeDiff, 1.0);
            unmatchedCount++;
        }
    }

    // Check for persisted orders that don't exist in calculated
    for (const persOrder of persistedOrders) {
        if (!calculatedOrders.some(c => c.id === persOrder.id)) {
            largeDeviations.push({
                id: persOrder.id,
                persSize: (Number(persOrder.size) || 0).toFixed(8),
                calcSize: 'NOT_FOUND',
                percentDiff: 'Unmatched'
            });
            sumSquaredDiff += 1.0;
            maxRelativeDiff = Math.max(maxRelativeDiff, 1.0);
            unmatchedCount++;
        }
    }

    // Return RMS (Root Mean Square) metric
    const totalOrders = matchCount + unmatchedCount;
    const meanSquaredDiff = totalOrders > 0 ? sumSquaredDiff / totalOrders : 0;
    const metric = Math.sqrt(meanSquaredDiff);

    // Log divergence breakdown if significant
    if (metric > 0.1) {
        console.log(`\nDEBUG [${sideName}] Divergence Calculation Breakdown:`);
        console.log(`  Matched orders: ${matchCount}`);
        console.log(`  Unmatched orders: ${unmatchedCount}`);
        console.log(`  RMS (Root Mean Square): ${metric.toFixed(4)} (${(metric * 100).toFixed(2)}%)`);
        if (largeDeviations.length > 0) {
            console.log(`  Large deviations (>10%): ${largeDeviations.length}`);
        }
    }

    return metric;
}

/**
 * Map blockchain update flags to order type string.
 *
 * @param {boolean} buyUpdated - Buy side was updated
 * @param {boolean} sellUpdated - Sell side was updated
 * @returns {string} 'buy', 'sell', or 'both'
 */
function getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated) {
    return (buyUpdated && sellUpdated) ? 'both' : (buyUpdated ? 'buy' : 'sell');
}

/**
 * Resolve a configured price bound (absolute or relative).
 * Used during grid initialization to parse min/max price bounds.
 *
 * @param {*} value - Raw config value (string, number, or expression)
 * @param {number} fallback - Fallback value if resolution fails
 * @param {number} marketPrice - Market price for relative calculations
 * @param {string} mode - Relative resolution mode ('absolute', 'percentage', 'multiplier')
 * @returns {number} Resolved price bound
 */
function resolveConfiguredPriceBound(value, fallback, marketPrice, mode) {
    const relative = resolveRelativePrice(value, marketPrice, mode);
    if (Number.isFinite(relative)) return relative;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    // Parsing
    isPercentageString,
    parsePercentageString,
    isRelativeMultiplierString,
    parseRelativeMultiplierString,
    resolveRelativePrice,

    // Fund calculations
    computeChainFundTotals,
    calculateAvailableFundsValue,
    calculateSpreadFromOrders,
    resolveConfigValue,

    // Conversions
    blockchainToFloat,
    floatToBlockchainInt,

    // Tolerance & checks
    calculatePriceTolerance,
    checkPriceWithinTolerance,
    validateOrderAmountsWithinLimits,

    // Parsing + matching
    parseChainOrder,
    findBestMatchByPrice,
    findMatchingGridOrderByOpenOrder,
    findMatchingGridOrderByHistory,

    // Reconciliation
    applyChainSizeToGridOrder,
    correctOrderPriceOnChain,
    correctAllPriceMismatches,
    getMinOrderSize,

    // Price derivation
    lookupAsset,
    deriveMarketPrice,
    derivePoolPrice,
    derivePrice,

    // Fee caching and retrieval
    initializeFeeCache,
    getCachedFees,
    clearFeeCache,
    getAssetFees,

    // Persistence
    persistGridSnapshot,
    retryPersistenceIfNeeded,

    // Grid comparisons
    runGridComparisons,
    applyGridDivergenceCorrections,

    // Order building
    buildCreateOrderArgs,

    // Numeric validation helpers
    toFiniteNumber,
    isValidNumber,
    compareBlockchainSizes,
    computeSizeAfterFill,

    // Order filtering helpers
    filterOrdersByType,
    filterOrdersByTypeAndState,
    sumOrderSizes,
    mapOrderSizes,
    countOrdersByType,

    // Precision helpers
    getPrecisionByOrderType,
    getPrecisionForSide,
    getPrecisionsForManager,

    // Pair detection
    hasBtsPair,

    // Size validation helpers
    checkSizesBeforeMinimum,
    checkSizesNearMinimum,

    // Fee helpers
    calculateOrderCreationFees,
    deductOrderFeesFromFunds,

    // Grid sizing & allocation (moved from grid.js)
    allocateFundsByWeights,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateGridSideDivergenceMetric,
    getOrderTypeFromUpdatedFlags,
    resolveConfiguredPriceBound
};

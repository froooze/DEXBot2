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

const { ORDER_TYPES, ORDER_STATES, TIMING } = require('./constants');

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
            `[validateOrderAmountsWithinLimits] Order amounts exceed safe limits. ` +
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
    manager.logger?.log?.(`Order ${gridOrder.id} size adjustment: ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (delta: ${delta.toFixed(8)})`, 'info');
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
 * @returns {number} Total fee amount in the asset's native units
 *   For BTS: blockchain fees only (creation 10% + update)
 *   For market assets: market fee on the amount
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
        return makerNetFee + orderUpdateFee;
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
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    // Parsing
    isPercentageString,
    parsePercentageString,
    isRelativeMultiplierString,
    parseRelativeMultiplierString,
    resolveRelativePrice,

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
    getAssetFees
};

/**
 * modules/order/utils.js
 *
 * Centralized utility helpers used by the order subsystem.
 * Grouped for readability and maintenance: parsing, conversions, tolerance,
 * matching, reconciliation, and price derivation.
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
    const ordersToCorrect = Array.isArray(manager.ordersNeedingPriceCorrection) ? [...manager.ordersNeedingPriceCorrection] : [];

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
    return Math.round(Number(floatValue) * Math.pow(10, p));
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
                const prec = assets.assetA && assets.assetA.precision !== undefined ? assets.assetA.precision : 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), prec);
            } else {
                const prec = assets.assetB && assets.assetB.precision !== undefined ? assets.assetB.precision : 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), prec);
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

function findMatchingGridOrderByOpenOrder(parsedChainOrder, opts) {
    const { orders, ordersByState, assets, calcToleranceFn, logger } = opts || {};
    if (!parsedChainOrder || !orders) return null;

    if (parsedChainOrder.orderId) {
        for (const gridOrder of orders.values()) {
            if (gridOrder.orderId === parsedChainOrder.orderId) return gridOrder;
        }
        logger?.log?.(`_findMatchingGridOrderByOpenOrder: orderId ${parsedChainOrder.orderId} NOT found in grid, falling back to price matching (chain price=${parsedChainOrder.price?.toFixed(6)}, type=${parsedChainOrder.type})`, 'info');
    }

    for (const gridOrder of orders.values()) {
        if (!gridOrder) continue;
        const priceDiff = Math.abs(gridOrder.price - parsedChainOrder.price);
        const orderSize = (gridOrder.size && Number.isFinite(Number(gridOrder.size))) ? Number(gridOrder.size) : null;
        const tolerance = calcToleranceFn ? calcToleranceFn(gridOrder.price, orderSize, gridOrder.type) : 0;
        if (gridOrder.type === parsedChainOrder.type && priceDiff <= tolerance) return gridOrder;
    }

    if (parsedChainOrder.price !== undefined && parsedChainOrder.type) {
        const activeIds = (ordersByState && ordersByState[ORDER_STATES.ACTIVE]) || new Set();
        return findBestMatchByPrice(parsedChainOrder, activeIds, orders, calcToleranceFn).match;
    }
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
    if (gridOrder.state !== ORDER_STATES.ACTIVE) {
        manager.logger?.log?.(`Skipping chain size apply for non-ACTIVE order ${gridOrder.id} (state=${gridOrder.state})`, 'debug');
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
    try { manager._adjustFunds(gridOrder.type, delta); } catch (e) { /* best-effort */ }
    gridOrder.size = newSize;
    try { manager._updateOrder(gridOrder); } catch (e) { /* best-effort */ }
}

async function correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders) {
    const { gridOrder, chainOrderId, expectedPrice, size, type } = correctionInfo;
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
    try { const a = await BitShares.assets[s.toLowerCase()]; if (a && a.id) return a; } catch (e) {}
    try { const r = await BitShares.db.lookup_asset_symbols([s]); if (r && r[0] && r[0].id) return r[0]; } catch (e) {}
    try { const g = await BitShares.db.get_assets([s]); if (g && g[0] && g[0].id) return g[0]; } catch (e) {}
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
        } catch (e) {}

        if (mid === null) {
            try {
                if (BitShares.db && typeof BitShares.db.get_ticker === 'function') {
                    const t = await BitShares.db.get_ticker(baseId, quoteId);
                    if (t && (t.latest || t.latest === 0)) mid = Number(t.latest);
                    if (!mid && t && t.latest_price) mid = Number(t.latest_price);
                }
            } catch (err) {}
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
        try {
            if (BitShares.db && typeof BitShares.db.get_liquidity_pool_by_asset_ids === 'function') {
                const pool = await BitShares.db.get_liquidity_pool_by_asset_ids(aMeta.id, bMeta.id);
                if (pool && pool.id) chosen = pool;
            }
        } catch (e) {}

        try {
            if (!chosen && BitShares.db && typeof BitShares.db.get_liquidity_pools === 'function') {
                const pools = await BitShares.db.get_liquidity_pools();
                if (Array.isArray(pools)) {
                    const matches = pools.filter(p => {
                        const ids = (p.asset_ids || []).map(x => String(x));
                        return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                    });
                    if (matches.length > 0) {
                        chosen = matches.sort((x, y) => (Number(y.total_reserve || 0) - Number(x.total_reserve || 0)))[0];
                        try {
                            if (chosen && !Array.isArray(chosen.reserves) && chosen.id && BitShares.db && typeof BitShares.db.get_objects === 'function') {
                                const objs = await BitShares.db.get_objects([chosen.id]);
                                if (Array.isArray(objs) && objs[0]) chosen = objs[0];
                            }
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}

        if (!chosen) {
            try {
                if (BitShares.db && typeof BitShares.db.get_order_book === 'function') {
                    const ob = await BitShares.db.get_order_book(aMeta.id, bMeta.id, 100);
                    const bids = (ob.bids || []).slice(0, 50);
                    const asks = (ob.asks || []).slice(0, 50);
                    const weightAvg = (arr) => {
                        if (!arr || arr.length === 0) return null;
                        let num = 0, den = 0;
                        arr.forEach(p => {
                            const price = Number(p.price || 0);
                            const amount = Number(p.size || p.base_amount || p.quantity || 1);
                            num += price * amount; den += amount;
                        });
                        return den ? num / den : null;
                    };
                    const bidAvg = weightAvg(bids);
                    const askAvg = weightAvg(asks);
                    if (bidAvg !== null && askAvg !== null) {
                        const mid = (bidAvg + askAvg) / 2;
                        return (mid !== 0 && Number.isFinite(mid)) ? 1 / mid : null;
                    }
                    if (bidAvg !== null) return (bidAvg !== 0 && Number.isFinite(bidAvg)) ? 1 / bidAvg : null;
                    if (askAvg !== null) return (askAvg !== 0 && Number.isFinite(askAvg)) ? 1 / askAvg : null;
                }
            } catch (e) {}
            return null;
        }

        try {
            let foundAmountA = null; let foundAmountB = null; let precisionA = null; let precisionB = null;
            if (Array.isArray(chosen.reserves) && chosen.reserves.length >= 2) {
                const rA = chosen.reserves.find(r => r && String(r.asset_id) === String(aMeta.id));
                const rB = chosen.reserves.find(r => r && String(r.asset_id) === String(bMeta.id));
                if (rA && rB) {
                    foundAmountA = Number(rA.amount || 0);
                    foundAmountB = Number(rB.amount || 0);
                    try { if (rA.asset_id && rB.asset_id && BitShares.db && typeof BitShares.db.get_assets === 'function') {
                        const assetsMeta = await BitShares.db.get_assets([rA.asset_id, rB.asset_id]);
                        if (assetsMeta && assetsMeta[0] && typeof assetsMeta[0].precision === 'number') precisionA = assetsMeta[0].precision;
                        if (assetsMeta && assetsMeta[1] && typeof assetsMeta[1].precision === 'number') precisionB = assetsMeta[1].precision;
                    } } catch (e) {}
                }
            }
            if (foundAmountA === null || foundAmountB === null) {
                const reserveA = Number(chosen.reserve_a || chosen.reserve_base || 0);
                const reserveB = Number(chosen.reserve_b || chosen.reserve_quote || 0);
                if (Number.isFinite(reserveA) && Number.isFinite(reserveB) && reserveA !== 0) {
                    foundAmountA = reserveA; foundAmountB = reserveB; precisionA = precisionA; precisionB = precisionB;
                }
            }
            if (foundAmountA === null || foundAmountB === null) return null;
            const floatA = Number.isFinite(precisionA) ? (foundAmountA / Math.pow(10, precisionA)) : foundAmountA;
            const floatB = Number.isFinite(precisionB) ? (foundAmountB / Math.pow(10, precisionB)) : foundAmountB;
            if (Number.isFinite(floatA) && Number.isFinite(floatB) && floatA !== 0) return (floatB !== 0 && Number.isFinite(floatB)) ? floatB / floatA : null;
        } catch (e) {}

        return null;
    } catch (err) {
        return null;
    }
};

// derivePrice: pooled -> market -> aggregated limit orders
const derivePrice = async (BitShares, symA, symB, mode) => {
    mode = (mode === undefined || mode === null) ? 'auto' : String(mode).toLowerCase();
    if (mode === 'pool') {
        try { const p = await derivePoolPrice(BitShares, symA, symB); if (p && Number.isFinite(p) && p > 0) return p; } catch (e) { return null; }
        return null;
    }
    if (mode === 'market') {
        try { const m = await deriveMarketPrice(BitShares, symA, symB); if (m && Number.isFinite(m) && m > 0) return m; } catch (e) { return null; }
        return null;
    }
    try {
        try {
            const p = await derivePoolPrice(BitShares, symA, symB);
            if (p && Number.isFinite(p) && p > 0) return p;
        } catch (e) {}

        try {
            const m = await deriveMarketPrice(BitShares, symA, symB);
            if (m && Number.isFinite(m) && m > 0) return m;
        } catch (e) {}

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
        } catch (e) {}

        return null;
    } catch (err) {
        return null;
    }
};

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
    derivePrice
};

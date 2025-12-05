/**
 * OrderGridGenerator - Generates the virtual order grid structure
 * 
 * This module creates the foundational grid of virtual orders based on:
 * - Market price (center of the grid)
 * - Min/max price bounds
 * - Increment percentage (spacing between orders)
 * - Target spread percentage (zone around market price)
 * 
 * The grid consists of:
 * - SELL orders above market price
 * - BUY orders below market price  
 * - SPREAD orders in the zone closest to market price
 * 
 * Orders are sized based on available funds and weight distribution.
 */
const { ORDER_TYPES, DEFAULT_CONFIG, GRID_LIMITS } = require('./constants');
const { floatToBlockchainInt, resolveRelativePrice } = require('./utils');

// Grid sizing limits are centralized in modules/order/constants.js -> GRID_LIMITS

/**
 * OrderGridGenerator - Static class for grid creation and sizing
 * 
 * Grid creation algorithm:
 * 1. Calculate price levels from marketPrice to maxPrice (sells) and minPrice (buys)
 * 2. Use incrementPercent for geometric spacing (1% -> 1.01x per level)
 * 3. Assign SPREAD type to orders closest to market price
 * 4. Calculate order sizes based on funds and weight distribution
 * 
 * @class
 */
class OrderGridGenerator {
    /**
     * Create the order grid structure.
     * Generates sell orders from market to max, buy orders from market to min.
     * Orders within targetSpreadPercent of market are marked as SPREAD.
     * 
     * @param {Object} config - Grid configuration
     * @param {number} config.marketPrice - Center price for the grid
     * @param {number} config.minPrice - Lower price bound
     * @param {number} config.maxPrice - Upper price bound
     * @param {number} config.incrementPercent - Price step (e.g., 1 for 1%)
     * @param {number} config.targetSpreadPercent - Spread zone width
     * @returns {Object} { orders: Array, initialSpreadCount: { buy, sell } }
     */
    static createOrderGrid(config) {
        // Compute helper arrays of buy/sell price levels relative to the market price.
        const { marketPrice, minPrice, maxPrice, incrementPercent } = config;
        // Use explicit step multipliers for clarity:
        const stepUp = 1 + (incrementPercent / 100);    // e.g. 1.02 for +2%
        const stepDown = 1 - (incrementPercent / 100);  // e.g. 0.98 for -2%
        
        // Ensure targetSpreadPercent is at least `minSpreadFactor * incrementPercent` to guarantee spread orders.
        // This implementation uses the constant GRID_LIMITS.MIN_SPREAD_FACTOR.
        const spreadFactor = Number(GRID_LIMITS.MIN_SPREAD_FACTOR);
        const minSpreadPercent = incrementPercent * spreadFactor;
        const targetSpreadPercent = Math.max(config.targetSpreadPercent, minSpreadPercent);
        if (config.targetSpreadPercent < minSpreadPercent) {
            console.log(`[WARN] targetSpreadPercent (${config.targetSpreadPercent}%) is less than ${spreadFactor}*incrementPercent (${minSpreadPercent.toFixed(2)}%). ` +
                        `Auto-adjusting to ${minSpreadPercent.toFixed(2)}% to ensure spread orders are created.`);
        }
        
        // Calculate number of spread orders based on target spread vs increment
        // Ensure at least 2 spread orders (1 buy, 1 sell) to maintain a proper spread zone
        // Number of increments needed to cover the target spread using stepUp^n >= (1 + targetSpread)
        const calculatedNOrders = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(stepUp));
        const nOrders = Math.max(2, calculatedNOrders); // Minimum 2 spread orders

        const calculateLevels = (start, min) => {
            const levels = [];
            for (let current = start; current >= min; current *= stepDown) {
                levels.push(current);
            }
            return levels;
        };

        const sellLevels = calculateLevels(maxPrice, marketPrice);
        // Start the buy side one step below the last sell level (or marketPrice) using stepDown
        const buyStart = (sellLevels[sellLevels.length - 1] || marketPrice) * stepDown;
        const buyLevels = calculateLevels(buyStart, minPrice);

        const buySpread = Math.floor(nOrders / 2);
        const sellSpread = nOrders - buySpread;
        const initialSpreadCount = { buy: 0, sell: 0 };

        const sellOrders = sellLevels.map((price, i) => ({
            price,
            type: i >= sellLevels.length - sellSpread ? (initialSpreadCount.sell++, ORDER_TYPES.SPREAD) : ORDER_TYPES.SELL,
            id: `sell-${i}`,
            state: 'virtual'
        }));

        const buyOrders = buyLevels.map((price, i) => ({
            price,
            type: i < buySpread ? (initialSpreadCount.buy++, ORDER_TYPES.SPREAD) : ORDER_TYPES.BUY,
            id: `buy-${i}`,
            state: 'virtual'
        }));

        return { orders: [...sellOrders, ...buyOrders], initialSpreadCount };
    }

    /**
     * Distribute funds across grid orders using weighted allocation.
     * 
     * Weight distribution algorithm:
     * - Uses geometric weighting based on incrementPercent
     * - Can favor orders closer to or further from market price
     * - Respects minimum size constraints
     * 
     * @param {Array} orders - Array of order objects from createOrderGrid
     * @param {Object} config - Grid configuration with weightDistribution
     * @param {number} sellFunds - Available funds for sell orders (in base asset)
     * @param {number} buyFunds - Available funds for buy orders (in quote asset)
     * @param {number} minSellSize - Minimum size for sell orders (0 to disable)
     * @param {number} minBuySize - Minimum size for buy orders (0 to disable)
     * @returns {Array} Orders with size property added
     */
    // Accept optional precision parameters for both sides so size-vs-min
    // comparisons can be performed exactly at blockchain integer granularity.
    static calculateOrderSizes(orders, config, sellFunds, buyFunds, minSellSize = 0, minBuySize = 0, precisionA = null, precisionB = null) {
        const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
        const incrementFactor = incrementPercent / 100;

        // side: 'sell' or 'buy' - explicit instead of comparing weights
        // minSize: enforce a minimum human-unit size per order; allocations below
        // minSize are removed and their funds redistributed among remaining orders.
        const calculateSizes = (ordersForSide, weight, totalFunds, side, minSize) => {
            if (!Array.isArray(ordersForSide) || ordersForSide.length === 0) return [];
            const n = ordersForSide.length;
            // Validate totalFunds to avoid NaN propagation
            if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

            const reverse = (side === 'sell');
            const base = 1 - incrementFactor;
            // Precompute per-index raw weights
            const rawWeights = new Array(n);
            for (let i = 0; i < n; i++) {
                const idx = reverse ? (n - 1 - i) : i;
                rawWeights[i] = Math.pow(base, idx * weight);
            }

            // Compute sizes (single-pass). `remaining`/`fundsLeft` not needed
            // since we abort the whole allocation when a per-order minimum
            // cannot be satisfied.
            let sizes = new Array(n).fill(0);

            // Single-pass allocation. If no minSize is enforced, allocate once.
            // If minSize is enforced, perform the allocation and abort (return zeros)
            // when any allocated order would be below the minimum. This keeps
            // grid-generation simple and allows the caller to abort creating
            // the grid when the per-order minimum cannot be satisfied.
            if (!Number.isFinite(minSize) || minSize <= 0) {
                const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
            } else {
                const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
                // If any allocated size is below the minimum, try a fallback:
                // - If there are totalFunds available, retry the allocation without
                //   enforcing the per-order minimum (i.e. minSize=0).
                // - If totalFunds is zero or not finite, signal failure with
                //   a zero-filled array so the caller can decide how to proceed.
                    // If precision provided for this side, compare integer representations
                    const precision = (side === 'sell') ? precisionA : precisionB;
                    let anyBelow = false;
                    if (precision !== null && precision !== undefined && Number.isFinite(precision)) {
                        const minInt = floatToBlockchainInt(minSize, precision);
                        anyBelow = sizes.some(sz => floatToBlockchainInt(sz, precision) < minInt);
                    } else {
                        anyBelow = sizes.some(sz => sz < minSize - 1e-8);
                    }
                if (anyBelow) {
                    if (Number.isFinite(totalFunds) && totalFunds > 0) {
                        // Retry allocation without min-size (single-pass)
                        const fallbackTotalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                        for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / fallbackTotalWeight) * totalFunds;
                    } else {
                        return new Array(n).fill(0);
                    }
                }
            }

            // Note: intentionally not applying a residual correction here.
            // Small floating-point rounding differences are accepted and will
            // be handled at higher-level logic (e.g. when converting to
            // integer chain units) rather than by altering individual
            // allocation amounts here.

            return sizes;
        };

        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

        const sellSizes = calculateSizes(sellOrders, sellWeight, sellFunds, 'sell', minSellSize);
        const buySizes = calculateSizes(buyOrders, buyWeight, buyFunds, 'buy', minBuySize);

        const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
        return orders.map(order => ({
            ...order,
            size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
        }));
    }
}

/**
 * Resolve a configured price bound value (copied from manager.js)
 */
function resolveConfiguredPriceBound(value, fallback, marketPrice, mode) {
    const relative = resolveRelativePrice(value, marketPrice, mode);
    if (Number.isFinite(relative)) return relative;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Initialize the virtual order grid and assign sizes on the provided manager.
 * This function was moved from OrderManager.initializeOrderGrid so the grid
 * generation and sizing logic can be reused and tested independently.
 *
 * @param {Object} manager - OrderManager instance (will be mutated)
 */
OrderGridGenerator.initializeGrid = async function(manager) {
    if (!manager) throw new Error('initializeGrid requires a manager instance');
    await manager._initializeAssets();
    const mpRaw = manager.config.marketPrice;
    const mpIsPool = typeof mpRaw === 'string' && mpRaw.trim().toLowerCase() === 'pool';
    const mpIsMarket = typeof mpRaw === 'string' && mpRaw.trim().toLowerCase() === 'market';

    if (!Number.isFinite(Number(mpRaw)) || mpIsPool || mpIsMarket) {
        try {
            const { derivePoolPrice, deriveMarketPrice, derivePrice } = require('./utils');
            const { BitShares } = require('../bitshares_client');
            const symA = manager.config.assetA;
            const symB = manager.config.assetB;

            if ((mpIsPool || manager.config.pool) && symA && symB) {
                try {
                    const p = await derivePrice(BitShares, symA, symB, 'pool');
                    if (p !== null) manager.config.marketPrice = p;
                } catch (e) { manager.logger && manager.logger.log && manager.logger.log(`Pool price lookup failed: ${e && e.message ? e.message : e}`, 'warn'); }
            } else if ((mpIsMarket || manager.config.market) && symA && symB) {
                try {
                    const m = await derivePrice(BitShares, symA, symB, 'market');
                    if (m !== null) manager.config.marketPrice = m;
                } catch (e) { manager.logger && manager.logger.log && manager.logger.log(`Market price lookup failed: ${e && e.message ? e.message : e}`, 'warn'); }
            }

            try {
                if (!Number.isFinite(Number(manager.config.marketPrice))) {
                    const modePref = (manager.config && manager.config.priceMode) ? String(manager.config.priceMode).toLowerCase() : (process && process.env && process.env.PRICE_MODE ? String(process.env.PRICE_MODE).toLowerCase() : 'auto');
                    const tryP = await derivePrice(BitShares, symA, symB, modePref);
                    if (tryP !== null) {
                        manager.config.marketPrice = tryP;
                        console.log('Derived marketPrice from on-chain (derivePrice)', manager.config.assetA + '/' + manager.config.assetB, tryP);
                    }
                }
            } catch (e) { manager.logger && manager.logger.log && manager.logger.log(`auto-derive marketPrice failed: ${e && e.message ? e.message : e}`, 'warn'); }
        } catch (err) {
            manager.logger && manager.logger.log && manager.logger.log(`auto-derive marketPrice failed: ${err && err.message ? err.message : err}`, 'warn');
        }
    }

    const mp = Number(manager.config.marketPrice);
    const fallbackMin = Number(DEFAULT_CONFIG.minPrice);
    const fallbackMax = Number(DEFAULT_CONFIG.maxPrice);
    const rawMin = manager.config.minPrice !== undefined ? manager.config.minPrice : DEFAULT_CONFIG.minPrice;
    const rawMax = manager.config.maxPrice !== undefined ? manager.config.maxPrice : DEFAULT_CONFIG.maxPrice;
    const minP = resolveConfiguredPriceBound(rawMin, fallbackMin, mp, 'min');
    const maxP = resolveConfiguredPriceBound(rawMax, fallbackMax, mp, 'max');
    manager.config.minPrice = minP;
    manager.config.maxPrice = maxP;
    if (!Number.isFinite(mp)) { throw new Error('Cannot initialize order grid: marketPrice is not a valid number'); }
    if (mp < minP || mp > maxP) { throw new Error(`Refusing to initialize order grid because marketPrice ${mp} is outside configured bounds [${minP}, ${maxP}]`); }

    try {
        const botFunds = manager.config && manager.config.botFunds ? manager.config.botFunds : {};
        const needsPercent = (v) => typeof v === 'string' && v.includes('%');
        if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (manager.accountId || manager.account)) {
            const haveBuy = manager.accountTotals && manager.accountTotals.buy !== null && manager.accountTotals.buy !== undefined && Number.isFinite(Number(manager.accountTotals.buy));
            const haveSell = manager.accountTotals && manager.accountTotals.sell !== null && manager.accountTotals.sell !== undefined && Number.isFinite(Number(manager.accountTotals.sell));
            if (haveBuy && haveSell) {
                manager.logger && manager.logger.log && manager.logger.log('Account totals already available; skipping blocking fetch.', 'debug');
            } else {
                const timeoutMs = Number.isFinite(Number(manager.config.waitForAccountTotalsMs)) ? Number(manager.config.waitForAccountTotalsMs) : 10000;
                manager.logger && manager.logger.log && manager.logger.log(`Waiting up to ${timeoutMs}ms for on-chain account totals to resolve percentage-based botFunds...`, 'info');
                try {
                    if (!manager._isFetchingTotals) { manager._isFetchingTotals = true; manager._fetchAccountBalancesAndSetTotals().finally(() => { manager._isFetchingTotals = false; }); }
                    await manager.waitForAccountTotals(timeoutMs);
                    manager.logger && manager.logger.log && manager.logger.log('Account totals fetch completed (or timed out).', 'info');
                } catch (err) {
                    manager.logger && manager.logger.log && manager.logger.log(`Account totals fetch failed: ${err && err.message ? err.message : err}`, 'warn');
                }
            }
        }
    } catch (err) { /* don't let failures block grid creation */ }

    const { getMinOrderSize } = require('./utils');
    const { orders, initialSpreadCount } = OrderGridGenerator.createOrderGrid(manager.config);
    const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
    const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

    const diagMsg = `Allocating sizes: sellFunds=${String(manager.funds.available.sell)}, buyFunds=${String(manager.funds.available.buy)}, ` +
        `minSellSize=${String(minSellSize)}, minBuySize=${String(minBuySize)}`;
    manager.logger && manager.logger.log && manager.logger.log(diagMsg, 'debug');

    const precA = manager.assets?.assetA?.precision;
    const precB = manager.assets?.assetB?.precision;
    let sizedOrders = OrderGridGenerator.calculateOrderSizes(
        orders, manager.config, manager.funds.available.sell, manager.funds.available.buy, minSellSize, minBuySize, precA, precB
    );

    try {
        const sellsAfter = sizedOrders.filter(o => o.type === ORDER_TYPES.SELL).map(o => Number(o.size || 0));
        const buysAfter = sizedOrders.filter(o => o.type === ORDER_TYPES.BUY).map(o => Number(o.size || 0));
        let anySellBelow = false;
        let anyBuyBelow = false;
        if (minSellSize > 0) {
            if (precA !== undefined && precA !== null && Number.isFinite(precA)) {
                const minSellInt = floatToBlockchainInt(minSellSize, precA);
                anySellBelow = sellsAfter.some(sz => !Number.isFinite(sz) || floatToBlockchainInt(sz, precA) < minSellInt);
            } else {
                anySellBelow = sellsAfter.some(sz => !Number.isFinite(sz) || sz < (minSellSize - 1e-8));
            }
        }
        if (minBuySize > 0) {
            if (precB !== undefined && precB !== null && Number.isFinite(precB)) {
                const minBuyInt = floatToBlockchainInt(minBuySize, precB);
                anyBuyBelow = buysAfter.some(sz => !Number.isFinite(sz) || floatToBlockchainInt(sz, precB) < minBuyInt);
            } else {
                anyBuyBelow = buysAfter.some(sz => !Number.isFinite(sz) || sz < (minBuySize - 1e-8));
            }
        }
        if (anySellBelow || anyBuyBelow) {
            const parts = [];
            if (anySellBelow) parts.push(`sell.min=${String(minSellSize)}`);
            if (anyBuyBelow) parts.push(`buy.min=${String(minBuySize)}`);
            const msg = `Order grid contains orders below minimum size (${parts.join(', ')}). Aborting startup to avoid placing undersized orders.`;
            manager.logger && manager.logger.log && manager.logger.log(msg, 'error');
            throw new Error(msg);
        }
    } catch (e) {
        throw e;
    }

    manager.orders.clear();
    Object.values(manager._ordersByState).forEach(set => set.clear());
    Object.values(manager._ordersByType).forEach(set => set.clear());
    manager.resetFunds();
    sizedOrders.forEach(order => { 
        manager._updateOrder(order);
        if (order.type === ORDER_TYPES.BUY) { 
            manager.funds.committed.buy += order.size; 
            manager.funds.available.buy -= order.size; 
        } else if (order.type === ORDER_TYPES.SELL) { 
            manager.funds.committed.sell += order.size; 
            manager.funds.available.sell -= order.size; 
        } 
    });

    manager.targetSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell; manager.currentSpreadCount = manager.targetSpreadCount;
    manager.config.activeOrders = manager.config.activeOrders || { buy: 1, sell: 1 };
    manager.config.activeOrders.buy = Number.isFinite(Number(manager.config.activeOrders.buy)) ? Number(manager.config.activeOrders.buy) : 1;
    manager.config.activeOrders.sell = Number.isFinite(Number(manager.config.activeOrders.sell)) ? Number(manager.config.activeOrders.sell) : 1;

    manager.logger.log(`Initialized order grid with ${orders.length} orders`, 'info'); manager.logger.log(`Configured activeOrders: buy=${manager.config.activeOrders.buy}, sell=${manager.config.activeOrders.sell}`, 'info');
    manager.logger && manager.logger.logFundsStatus && manager.logger.logFundsStatus(manager);
    manager.logger && manager.logger.logOrderGrid && manager.logger.logOrderGrid(Array.from(manager.orders.values()), manager.config.marketPrice);
};

/**
 * Perform a full grid resynchronization from blockchain state (moved from manager)
 * @param {Object} manager - OrderManager instance
 * @param {Function} readOpenOrdersFn - async function to fetch open orders
 * @param {Function} cancelOrderFn - async function to cancel an order
 */
OrderGridGenerator.recalculateGrid = async function(manager, readOpenOrdersFn, cancelOrderFn) {
    if (!manager) throw new Error('recalculateGrid requires a manager instance');
    manager.logger.log('Starting full grid resynchronization from blockchain...', 'info');
    await OrderGridGenerator.initializeGrid(manager);
    manager.logger.log('Virtual grid has been regenerated.', 'debug');
    const chainOrders = await readOpenOrdersFn();
    if (!Array.isArray(chainOrders)) {
        manager.logger.log('Could not fetch open orders for resync.', 'error');
        return;
    }
    manager.logger.log(`Found ${chainOrders.length} open orders on-chain.`, 'info');
    const assetAPrecision = manager.assets?.assetA?.precision;
    const assetBPrecision = manager.assets?.assetB?.precision;
    const calcTol = (p, s, t) => {
        const { calculatePriceTolerance } = require('./utils');
        return calculatePriceTolerance(p, s, t, manager.assets);
    };
    const matchedChainOrderIds = new Set();
    for (const gridOrder of manager.orders.values()) {
        let bestMatch = null;
        let smallestDiff = Infinity;
        for (const chainOrder of chainOrders) {
            if (matchedChainOrderIds.has(chainOrder.id)) continue;
            const parsedChainOrder = require('./utils').parseChainOrder(chainOrder, manager.assets);
            if (!parsedChainOrder || parsedChainOrder.type !== gridOrder.type) continue;
            const priceDiff = Math.abs(parsedChainOrder.price - gridOrder.price);
            if (priceDiff < smallestDiff) {
                smallestDiff = priceDiff;
                bestMatch = chainOrder;
            }
        }
        if (bestMatch) {
            const orderSize = (gridOrder.size && Number.isFinite(Number(gridOrder.size))) ? Number(gridOrder.size) : null;
            const tolerance = calcTol(gridOrder.price, orderSize, gridOrder.type);
            if (smallestDiff <= tolerance) {
                gridOrder.state = 'active';
                gridOrder.orderId = bestMatch.id;
                try {
                    const parsed = require('./utils').parseChainOrder(bestMatch, manager.assets);
                    if (parsed && parsed.size !== null && parsed.size !== undefined && Number.isFinite(Number(parsed.size))) {
                        require('./utils').applyChainSizeToGridOrder(manager, gridOrder, parsed.size);
                    }
                } catch (e) { /* best-effort */ }
                manager._updateOrder(gridOrder);
                matchedChainOrderIds.add(bestMatch.id);
                manager.logger.log(`Matched grid order ${gridOrder.id} to on-chain order ${bestMatch.id}.`, 'debug');
            }
        }
    }
    for (const chainOrder of chainOrders) {
        if (!matchedChainOrderIds.has(chainOrder.id)) {
            manager.logger.log(`Cancelling unmatched on-chain order ${chainOrder.id}.`, 'info');
            try {
                await cancelOrderFn(chainOrder.id);
            } catch (err) {
                manager.logger.log(`Failed to cancel order ${chainOrder.id}: ${err.message}`, 'error');
            }
        }
    }
    manager.logger.log('Full grid resynchronization complete.', 'info');
    manager.logger && manager.logger.logFundsStatus && manager.logger.logFundsStatus(manager);
    manager.logger.logOrderGrid(Array.from(manager.orders.values()), manager.config.marketPrice);
};

// Expose the generator as module export

module.exports = OrderGridGenerator;

/**
 * Grid - Generates the virtual order grid structure
 * 
 * This module creates the foundational grid of virtual orders based on:
 * - Market price (center of the grid)
 * - Min/max price bounds
 * - Increment percentage (spacing between orders)
 * - Target spread percentage (zone around market price)
 * 
 * The grid consists of:
 * - SELL orders above market price (size in base asset / assetA)
 * - BUY orders below market price (size in quote asset / assetB)
 * - SPREAD orders in the zone closest to market price (placeholders)
 * 
 * Orders are sized based on available funds and weight distribution.
 * Initial grid orders are created in VIRTUAL state - their sizes contribute
 * to the manager's funds.virtuel (reserved) until placed on-chain.
 * 
 * Fund interaction:
 * - Grid creation: All orders start as VIRTUAL, sizes added to funds.virtuel
 * - Grid loading (loadGrid): ACTIVE orders increment funds.committed
 * - Order activation: funds.virtuel decreases, funds.committed increases
 */
const { ORDER_TYPES, DEFAULT_CONFIG, GRID_LIMITS } = require('./constants');
const { GRID_COMPARISON } = GRID_LIMITS;
const { floatToBlockchainInt, resolveRelativePrice } = require('./utils');

// Grid sizing limits are centralized in modules/order/constants.js -> GRID_LIMITS

/**
 * Grid - Static class for grid creation and sizing
 * 
 * Grid creation algorithm:
 * 1. Calculate price levels from marketPrice to maxPrice (sells) and minPrice (buys)
 * 2. Use incrementPercent for geometric spacing (1% -> 1.01x per level)
 * 3. Assign SPREAD type to orders closest to market price
 * 4. Calculate order sizes based on funds and weight distribution
 * 
 * @class
 */
class Grid {
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

        // Generate Sells detected OUTWARDS from market (Price increasing)
        // Start at a half-step up to center the market price in the first gap
        const sellLevels = [];
        let currentSell = marketPrice * Math.sqrt(stepUp);
        while (currentSell <= maxPrice) {
            sellLevels.push(currentSell);
            currentSell *= stepUp;
        }
        // Reverse so sellLevels are Max -> Min (closest to market is at end)
        sellLevels.reverse();

        // Generate Buys detected OUTWARDS from market (Price decreasing)
        // Start at a half-step down to center the market price
        const buyLevels = [];
        let currentBuy = marketPrice * Math.sqrt(stepDown);
        while (currentBuy >= minPrice) {
            buyLevels.push(currentBuy);
            currentBuy *= stepDown;
        }
        // buyLevels are already High -> Low (closest to market is at start)

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
     * Restore a persisted grid snapshot onto a manager instance.
     * Usage: Grid.loadGrid(manager, gridArray)
     */
    static async loadGrid(manager, grid) {
        if (!Array.isArray(grid)) return;

        // Ensure assets are initialized so that subsequent sync operations (which rely on precision) work correctly
        try {
            await manager._initializeAssets();
        } catch (e) {
            manager.logger?.log?.(`Warning: Failed to initialize assets during loadGrid: ${e.message}`, 'warn');
        }

        // Clear manager state and indices then load the grid entries
        manager.orders.clear();
        Object.values(manager._ordersByState).forEach(set => set.clear());
        Object.values(manager._ordersByType).forEach(set => set.clear());
        manager.resetFunds();
        grid.forEach(order => {
            manager._updateOrder(order);
            // Note: recalculateFunds() is called by _updateOrder, so funds are auto-updated
        });
        manager.logger.log(`Loaded ${manager.orders.size} orders from persisted grid state.`, 'info');
        manager.logger?.logFundsStatus?.(manager);
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

        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

        const sellSizes = Grid._allocateByWeights(sellFunds, sellOrders.length, sellWeight, incrementFactor, true, minSellSize, precisionA);
        const buySizes = Grid._allocateByWeights(buyFunds, buyOrders.length, buyWeight, incrementFactor, false, minBuySize, precisionB);

        const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
        return orders.map(order => ({
            ...order,
            size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
        }));
    }

    /**
     * Initialize the virtual order grid and assign sizes on the provided manager.
     * This function was moved from OrderManager.initializeOrderGrid so the grid
     * generation and sizing logic can be reused and tested independently.
     *
     * @param {Object} manager - OrderManager instance (will be mutated)
     */
    static async initializeGrid(manager) {
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
                    } catch (e) { manager.logger?.log?.(`Pool price lookup failed: ${e?.message || e}`, 'warn'); }
                } else if ((mpIsMarket || manager.config.market) && symA && symB) {
                    try {
                        const m = await derivePrice(BitShares, symA, symB, 'market');
                        if (m !== null) manager.config.marketPrice = m;
                    } catch (e) { manager.logger?.log?.(`Market price lookup failed: ${e?.message || e}`, 'warn'); }
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
                } catch (e) { manager.logger?.log?.(`auto-derive marketPrice failed: ${e?.message || e}`, 'warn'); }
            } catch (err) {
                manager.logger?.log?.(`auto-derive marketPrice failed: ${err?.message || err}`, 'warn');
            }
        }

        // =====================================================================
        // PRICE BOUNDS RESOLUTION - Supports Mixed Absolute & Relative Formats
        // =====================================================================
        //
        // minPrice and maxPrice can be configured in two formats:
        //
        // 1. ABSOLUTE prices (numeric): "0.55" or 0.55
        //    - Fixed price bound regardless of market price
        //    - Example: minPrice = 0.55 always means 0.55
        //
        // 2. RELATIVE multipliers (with 'x' suffix): "15x" or "4x"
        //    - Dynamic bound based on current market price
        //    - For minPrice: resolves as marketPrice / multiplier
        //    - For maxPrice: resolves as marketPrice * multiplier
        //    - Example: maxPrice = "15x" at market price 0.64 = 0.64 * 15 = 9.6
        //
        // MIXED FORMAT EXAMPLE:
        //   minPrice: "0.55" (absolute - keeps minimum bound fixed)
        //   maxPrice: "15x" (relative - scales with market price)
        //
        // IMPORTANT: When mixing formats, ensure bounds don't create
        // unrealistic price ranges that could cause extreme order sizes
        // and overflow the 64-bit blockchain limits.
        //
        // Resolution order (for each bound):
        // 1. Try to parse as relative multiplier (e.g., "5x")
        // 2. If that fails, try to parse as numeric absolute price
        // 3. If that fails, use fallback from DEFAULT_CONFIG
        //
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
                    manager.logger?.log?.('Account totals already available; skipping blocking fetch.', 'debug');
                } else {
                    const timeoutMs = Number.isFinite(Number(manager.config.waitForAccountTotalsMs)) ? Number(manager.config.waitForAccountTotalsMs) : 10000;
                    manager.logger?.log?.(`Waiting up to ${timeoutMs}ms for on-chain account totals to resolve percentage-based botFunds...`, 'info');
                    try {
                        if (!manager._isFetchingTotals) { manager._isFetchingTotals = true; manager._fetchAccountBalancesAndSetTotals().finally(() => { manager._isFetchingTotals = false; }); }
                        await manager.waitForAccountTotals(timeoutMs);
                        manager.logger?.log?.('Account totals fetch completed (or timed out).', 'info');
                    } catch (err) {
                        manager.logger?.log?.(`Account totals fetch failed: ${err?.message || err}`, 'warn');
                    }
                }
            }
        } catch (err) { /* don't let failures block grid creation */ }

        const { getMinOrderSize } = require('./utils');
        const { orders, initialSpreadCount } = Grid.createOrderGrid(manager.config);
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        // Apply botFunds percentage allocation constraints for multi-bot account sharing
        // This ensures each bot respects its allocated percentage of chainFree (what's actually free on-chain)
        if (manager.applyBotFundsAllocation && typeof manager.applyBotFundsAllocation === 'function') {
            manager.applyBotFundsAllocation();
        }

        const diagMsg = `Allocating sizes: sellFunds=${String(manager.funds.available.sell)}, buyFunds=${String(manager.funds.available.buy)}, ` +
            `minSellSize=${String(minSellSize)}, minBuySize=${String(minBuySize)}`;
        manager.logger?.log?.(diagMsg, 'debug');

        const precA = manager.assets?.assetA?.precision;
        const precB = manager.assets?.assetB?.precision;

        // Determine total funds on-chain for sizing.
        // Centralized in OrderManager to avoid duplicating chainFree/free+locked/chainTotal logic.
        if (!manager.getChainFundsSnapshot || typeof manager.getChainFundsSnapshot !== 'function') {
            throw new Error('Grid.initializeGrid requires manager.getChainFundsSnapshot()');
        }
        const snapshot = manager.getChainFundsSnapshot();

        const chainFreeBuy = snapshot.chainFreeBuy;
        const chainFreeSell = snapshot.chainFreeSell;
        const chainTotalBuy = snapshot.chainTotalBuy;
        const chainTotalSell = snapshot.chainTotalSell;
        const allocatedBuy = snapshot.allocatedBuy;
        const allocatedSell = snapshot.allocatedSell;

        const inputFundsBuy = allocatedBuy;
        const inputFundsSell = allocatedSell;

        const sizingSnap = Grid._getFundSnapshot(manager);
        Grid._logSizingInput(manager, sizingSnap);

        // Deduct BTS createFee for orders that will be created during grid initialization
        // Only if BTS is in the trading pair
        let btsFeesForCreation = 0;
        const assetA = manager.config.assetA;
        const assetB = manager.config.assetB;
        const hasBtsPair = (assetA === 'BTS' || assetB === 'BTS');

        if (hasBtsPair) {
            try {
                const { getAssetFees } = require('./utils');
                const targetBuy = Math.max(0, Number.isFinite(Number(manager.config.activeOrders?.buy)) ? Number(manager.config.activeOrders.buy) : 1);
                const targetSell = Math.max(0, Number.isFinite(Number(manager.config.activeOrders?.sell)) ? Number(manager.config.activeOrders.sell) : 1);

                // Ignore open orders at startup - calculate fees for all target orders as if we're creating them from scratch
                // This ensures we reserve enough BTS for order creation regardless of current state
                const totalOrdersToCreate = targetBuy + targetSell;

                if (totalOrdersToCreate > 0) {
                    const btsFeeData = getAssetFees('BTS', 1); // Amount doesn't matter for create fee
                    btsFeesForCreation = btsFeeData.createFee * totalOrdersToCreate;
                    manager.logger.log(
                        `BTS fee reservation: ${totalOrdersToCreate} orders to create (buy=${targetBuy}, sell=${targetSell}) = ${btsFeesForCreation.toFixed(8)} BTS`,
                        'info'
                    );
                }
            } catch (err) {
                manager.logger?.log?.(
                    `Warning: Could not calculate BTS creation fees: ${err.message}`,
                    'warn'
                );
            }
        }

        // Reduce available BTS funds by the fees we need to reserve
        let finalInputFundsBuy = inputFundsBuy;
        let finalInputFundsSell = inputFundsSell;

        if (btsFeesForCreation > 0) {
            if (assetB === 'BTS') {
                finalInputFundsBuy = Math.max(0, inputFundsBuy - btsFeesForCreation);
                manager.logger.log(
                    `Reduced available BTS (buy) funds by ${btsFeesForCreation.toFixed(8)} for order creation fees: ${inputFundsBuy.toFixed(8)} -> ${finalInputFundsBuy.toFixed(8)}`,
                    'info'
                );
            } else if (assetA === 'BTS') {
                finalInputFundsSell = Math.max(0, inputFundsSell - btsFeesForCreation);
                manager.logger.log(
                    `Reduced available BTS (sell) funds by ${btsFeesForCreation.toFixed(8)} for order creation fees: ${inputFundsSell.toFixed(8)} -> ${finalInputFundsSell.toFixed(8)}`,
                    'info'
                );
            }
        }

        let sizedOrders = Grid.calculateOrderSizes(
            orders, manager.config, finalInputFundsSell, finalInputFundsBuy, minSellSize, minBuySize, precA, precB
        );

        // Calculate total allocated by the sizing algorithm
        const sizedAllocatedBuy = sizedOrders.filter(o => o.type === ORDER_TYPES.BUY).reduce((sum, o) => sum + (Number(o.size) || 0), 0);
        const sizedAllocatedSell = sizedOrders.filter(o => o.type === ORDER_TYPES.SELL).reduce((sum, o) => sum + (Number(o.size) || 0), 0);
        manager.logger.log(`DEBUG Grid Sizing Output: allocatedBuy=${sizedAllocatedBuy.toFixed(8)}, allocatedSell=${sizedAllocatedSell.toFixed(8)}`, 'info');
        manager.logger.log(`DEBUG Grid Sizing Discrepancy: buy=${(inputFundsBuy - sizedAllocatedBuy).toFixed(8)}, sell=${(inputFundsSell - sizedAllocatedSell).toFixed(8)}`, 'info');

        try {
            const sellsAfter = sizedOrders.filter(o => o.type === ORDER_TYPES.SELL).map(o => Number(o.size || 0));
            const buysAfter = sizedOrders.filter(o => o.type === ORDER_TYPES.BUY).map(o => Number(o.size || 0));
            let anySellBelow = false;
            let anyBuyBelow = false;
            if (minSellSize > 0) {
                if (precA !== undefined && precA !== null && Number.isFinite(precA)) {
                    const minSellInt = floatToBlockchainInt(minSellSize, precA);
                    anySellBelow = sellsAfter.some(sz =>
                        (!Number.isFinite(sz)) ||
                        (Number.isFinite(sz) && sz > 0 && floatToBlockchainInt(sz, precA) < minSellInt)
                    );
                } else {
                    anySellBelow = sellsAfter.some(sz =>
                        (!Number.isFinite(sz)) ||
                        (Number.isFinite(sz) && sz > 0 && sz < (minSellSize - 1e-8))
                    );
                }
            }
            if (minBuySize > 0) {
                if (precB !== undefined && precB !== null && Number.isFinite(precB)) {
                    const minBuyInt = floatToBlockchainInt(minBuySize, precB);
                    anyBuyBelow = buysAfter.some(sz =>
                        (!Number.isFinite(sz)) ||
                        (Number.isFinite(sz) && sz > 0 && floatToBlockchainInt(sz, precB) < minBuyInt)
                    );
                } else {
                    anyBuyBelow = buysAfter.some(sz =>
                        (!Number.isFinite(sz)) ||
                        (Number.isFinite(sz) && sz > 0 && sz < (minBuySize - 1e-8))
                    );
                }
            }
            if (anySellBelow || anyBuyBelow) {
                const parts = [];
                if (anySellBelow) parts.push(`sell.min=${String(minSellSize)}`);
                if (anyBuyBelow) parts.push(`buy.min=${String(minBuySize)}`);
                const msg = `Order grid contains orders below minimum size (${parts.join(', ')}). Aborting startup to avoid placing undersized orders.`;
                manager.logger?.log?.(msg, 'error');
                throw new Error(msg);
            }

            // check for warning if orders are near minimal size
            let anySellNearMin = false;
            let anyBuyNearMin = false;
            if (minSellSize > 0) {
                const warningSellSize = getMinOrderSize(ORDER_TYPES.SELL, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR * 2);
                if (precA !== undefined && precA !== null && Number.isFinite(precA)) {
                    const warnSellInt = floatToBlockchainInt(warningSellSize, precA);
                    anySellNearMin = sellsAfter.some(sz => Number.isFinite(sz) && sz > 0 && floatToBlockchainInt(sz, precA) < warnSellInt);
                } else {
                    anySellNearMin = sellsAfter.some(sz => Number.isFinite(sz) && sz > 0 && sz < (warningSellSize - 1e-8));
                }
            }

            if (minBuySize > 0) {
                const warningBuySize = getMinOrderSize(ORDER_TYPES.BUY, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR * 2);
                if (precB !== undefined && precB !== null && Number.isFinite(precB)) {
                    const warnBuyInt = floatToBlockchainInt(warningBuySize, precB);
                    anyBuyNearMin = buysAfter.some(sz => Number.isFinite(sz) && sz > 0 && floatToBlockchainInt(sz, precB) < warnBuyInt);
                } else {
                    anyBuyNearMin = buysAfter.some(sz => Number.isFinite(sz) && sz > 0 && sz < (warningBuySize - 1e-8));
                }
            }

            if (anySellNearMin || anyBuyNearMin) {
                const parts = [];
                if (anySellNearMin) parts.push('sells near min');
                if (anyBuyNearMin) parts.push('buys near min');
                manager.logger.log(`WARNING: Order grid contains orders near minimum size (${parts.join(', ')}). To ensure the bot runs properly, consider increasing the funds of your bot.`, 'warn');
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
            // Note: recalculateFunds() is called by _updateOrder, so funds are auto-updated
        });

        manager.targetSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell; manager.currentSpreadCount = manager.targetSpreadCount;
        manager.config.activeOrders = manager.config.activeOrders || { buy: 1, sell: 1 };
        manager.config.activeOrders.buy = Number.isFinite(Number(manager.config.activeOrders.buy)) ? Number(manager.config.activeOrders.buy) : 1;
        manager.config.activeOrders.sell = Number.isFinite(Number(manager.config.activeOrders.sell)) ? Number(manager.config.activeOrders.sell) : 1;

        // Debug: Compare chainFree with allocated grid funds
        const virtuelBuy = manager.funds?.virtuel?.buy || 0;
        const virtuelSell = manager.funds?.virtuel?.sell || 0;
        const discrepancyBuy = chainFreeBuy - virtuelBuy;
        const discrepancySell = chainFreeSell - virtuelSell;
        manager.logger.log(`DEBUG Grid Init: chainFree.buy=${chainFreeBuy.toFixed(8)}, virtuel.buy=${virtuelBuy.toFixed(8)}, discrepancy=${discrepancyBuy.toFixed(8)}`, 'info');
        manager.logger.log(`DEBUG Grid Init: chainFree.sell=${chainFreeSell.toFixed(8)}, virtuel.sell=${virtuelSell.toFixed(8)}, discrepancy=${discrepancySell.toFixed(8)}`, 'info');

        manager.logger.log(`Initialized order grid with ${orders.length} orders`, 'info'); manager.logger.log(`Configured activeOrders: buy=${manager.config.activeOrders.buy}, sell=${manager.config.activeOrders.sell}`, 'info');
        manager.logger?.logFundsStatus?.(manager);
        manager.logger?.logOrderGrid?.(Array.from(manager.orders.values()), manager.config.marketPrice);
    }

    /**
     * Perform a full grid resynchronization from blockchain state (moved from manager)
     * @param {Object} manager - OrderManager instance
     * @param {Object} opts
     * @param {Function} opts.readOpenOrdersFn - async function to fetch open orders
     * @param {Object} opts.chainOrders - chain orders API (must support updateOrder/createOrder/cancelOrder)
     * @param {string} opts.account - account name
     * @param {string} opts.privateKey - WIF private key
     * @param {Object} [opts.config] - bot config (defaults to manager.config)
     */
    static async recalculateGrid(manager, opts) {
        if (!manager) throw new Error('recalculateGrid requires a manager instance');

        const readOpenOrdersFn = opts && typeof opts.readOpenOrdersFn === 'function' ? opts.readOpenOrdersFn : null;
        const chainOrders = opts ? opts.chainOrders : null;
        const account = opts ? opts.account : null;
        const privateKey = opts ? opts.privateKey : null;
        const config = (opts && opts.config) ? opts.config : (manager.config || {});

        if (!readOpenOrdersFn) throw new Error('recalculateGrid requires opts.readOpenOrdersFn');
        if (!chainOrders || typeof chainOrders.updateOrder !== 'function' || typeof chainOrders.createOrder !== 'function' || typeof chainOrders.cancelOrder !== 'function') {
            throw new Error('recalculateGrid requires opts.chainOrders with updateOrder/createOrder/cancelOrder');
        }
        if (!account || !privateKey) throw new Error('recalculateGrid requires opts.account and opts.privateKey');

        manager.logger.log('Starting full grid resynchronization from blockchain...', 'info');
        if (typeof manager._initializeAssets === 'function') {
            await manager._initializeAssets();
        }
        await Grid.initializeGrid(manager);
        manager.logger.log('Virtual grid has been regenerated.', 'debug');
        // Clear persisted cacheFunds for both sides after a full grid regeneration
        // so persisted leftovers do not remain after the grid was rebuilt.
        try {
            Grid._clearAndPersistCacheFunds(manager, 'buy');
            Grid._clearAndPersistCacheFunds(manager, 'sell');
        } catch (e) {
            manager.logger?.log?.(`Warning: failed to clear persisted cacheFunds during recalc: ${e.message}`, 'warn');
        }

        const chainOpenOrders = await readOpenOrdersFn();
        if (!Array.isArray(chainOpenOrders)) {
            manager.logger.log('Could not fetch open orders for resync.', 'error');
            return;
        }
        manager.logger.log(`Found ${chainOpenOrders.length} open orders on-chain.`, 'info');

        // Reuse the same reconciliation policy as startup:
        // 1) match chain orders onto grid (price+size)
        // 2) update/create/cancel to reach configured target activeOrders
        const { reconcileStartupOrders } = require('./startup_reconcile');
        const syncResult = await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
        await reconcileStartupOrders({
            manager,
            config,
            account,
            privateKey,
            chainOrders,
            chainOpenOrders,
            syncResult,
        });

        manager.logger.log('Full grid resynchronization complete.', 'info');
        manager.logger?.logFundsStatus?.(manager);
        manager.logger.logOrderGrid(Array.from(manager.orders.values()), manager.config.marketPrice);
    }

    /**
     * Check if cache funds exceed regeneration threshold and update grid sizes if needed.
     * Independently checks buy and sell sides - can update just one side.
     * Threshold: if (cacheFunds / total.grid) * 100 >= GRID_REGENERATION_PERCENTAGE, update that side.
     *
     * @param {Object} manager - OrderManager instance with existing grid
     * @param {Object} cacheFunds - Cached funds { buy, sell } from previous rotations
     * @returns {Object} { buyUpdated: boolean, sellUpdated: boolean }
     * @example
     * const result = Grid.checkAndUpdateGridIfNeeded(manager, cacheFunds);
     * if (result.buyUpdated) console.log('Buy side was regenerated');
     * if (result.sellUpdated) console.log('Sell side was regenerated');
     */
    static checkAndUpdateGridIfNeeded(manager, cacheFunds = { buy: 0, sell: 0 }) {
        if (!manager) throw new Error('checkAndUpdateGridIfNeeded requires a manager instance');

        const { GRID_LIMITS } = require('./constants');
        const threshold = GRID_LIMITS.GRID_REGENERATION_PERCENTAGE || 1;

        const snap = Grid._getFundSnapshot(manager);
        const gridBuy = snap.gridBuy;
        const gridSell = snap.gridSell;
        const cacheBuy = Number(cacheFunds?.buy || snap.cacheBuy || 0);
        const cacheSell = Number(cacheFunds?.sell || snap.cacheSell || 0);

        const result = { buyUpdated: false, sellUpdated: false };

        const sides = [
            { name: 'buy', grid: gridBuy, cache: cacheBuy, orderType: ORDER_TYPES.BUY },
            { name: 'sell', grid: gridSell, cache: cacheSell, orderType: ORDER_TYPES.SELL }
        ];

        for (const s of sides) {
            if (s.grid <= 0) continue;
            const ratio = (s.cache / s.grid) * 100;
            if (ratio >= threshold) {
                manager.logger?.log(
                    `Cache funds ratio for ${s.name} side: ${ratio.toFixed(2)}% >= ${threshold}% threshold. Updating ${s.name} order sizes.`,
                    'info'
                );
                Grid.updateGridOrderSizesForSide(manager, s.orderType, cacheFunds);
                // Clear persisted cacheFunds for this side since we regenerated sizes
                Grid._clearAndPersistCacheFunds(manager, s.name);
                if (s.name === 'buy') result.buyUpdated = true; else result.sellUpdated = true;
            } else {
                manager.logger?.log(
                    `Cache funds ratio for ${s.name} side: ${ratio.toFixed(2)}% < ${threshold}% threshold. No update needed.`,
                    'debug'
                );
            }
        }

        return result;
    }

    /**
     * Update order sizes for a specific side (buy or sell) based on cache and grid allocation.
     * Helper for checkAndUpdateGridIfNeeded to update only one side at a time.
     *
     * @param {Object} manager - OrderManager instance
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Object} cacheFunds - Cached funds { buy, sell }
     * @returns {void} Updates orders in-place
     */
    static updateGridOrderSizesForSide(manager, orderType, cacheFunds = { buy: 0, sell: 0 }) {
        if (!manager) throw new Error('updateGridOrderSizesForSide requires a manager instance');

        const config = manager.config || {};
        const isBuy = orderType === ORDER_TYPES.BUY;
        const cacheFundsValue = isBuy ? Number(cacheFunds?.buy || 0) : Number(cacheFunds?.sell || 0);
        const gridValue = isBuy
            ? manager.funds?.total?.grid?.buy || 0
            : manager.funds?.total?.grid?.sell || 0;

        const sideName = isBuy ? 'buy' : 'sell';
        manager.logger?.log(
            `Updating ${sideName} side order sizes: cache=${cacheFundsValue.toFixed(8)} + grid=${gridValue.toFixed(8)} = ${(cacheFundsValue + gridValue).toFixed(8)}`,
            'info'
        );

        // Get orders for this side
        const orders = Array.from(manager.orders.values()).filter(o => o.type === orderType);

        if (orders.length === 0) {
            manager.logger?.log(`No ${sideName} orders found to update`, 'warn');
            return;
        }

        // Calculate new sizes for this side only
        const newSizes = Grid.calculateRotationOrderSizes(
            cacheFundsValue,
            gridValue,
            orders.length,
            orderType,
            config,
            0,
            isBuy ? manager.assets?.assetB?.precision : manager.assets?.assetA?.precision
        );

        // Update orders with new sizes
        Grid._updateOrdersForSide(manager, orderType, newSizes, orders);

        // Recalculate funds after updating this side
        manager.recalculateFunds();

        manager.logger?.log(`${sideName} side order sizes updated`, 'info');
    }

    /**
     * Update order sizes in existing grid based on cache funds and total grid allocation.
     * Keeps grid structure intact (prices, spread, active/virtual states) but recalculates all order sizes.
     * Uses only cacheFunds + total.grid for sizing (does NOT include available.funds).
     * Used when reloading grid to maintain consistent sizing across restarts.
     *
     * @param {Object} manager - OrderManager instance with existing grid
     * @param {Object} cacheFunds - Cached funds { buy, sell } from previous rotations
     * @returns {void} Updates orders in-place via manager._updateOrder()
     * @example
     * // After loading grid, update all order sizes based on cache and grid allocation
     * const cacheFunds = accountOrders.loadCacheFunds(botKey) || { buy: 0, sell: 0 };
     * Grid.updateGridOrderSizes(manager, cacheFunds);
     */
    static updateGridOrderSizes(manager, cacheFunds = { buy: 0, sell: 0 }) {
        if (!manager) throw new Error('updateGridOrderSizes requires a manager instance');

        const config = manager.config || {};
        const cacheBuy = Number(cacheFunds?.buy || 0);
        const cacheSell = Number(cacheFunds?.sell || 0);

        // Get grid allocation (NOT available funds)
        const gridBuy = manager.funds?.total?.grid?.buy || 0;
        const gridSell = manager.funds?.total?.grid?.sell || 0;

        // Total to distribute: cache + grid only
        const totalBuy = cacheBuy + gridBuy;
        const totalSell = cacheSell + gridSell;

        manager.logger?.log(
            `Updating grid order sizes - Buy: cache=${cacheBuy.toFixed(8)} + grid=${gridBuy.toFixed(8)} = ${totalBuy.toFixed(8)}`,
            'info'
        );
        manager.logger?.log(
            `Updating grid order sizes - Sell: cache=${cacheSell.toFixed(8)} + grid=${gridSell.toFixed(8)} = ${totalSell.toFixed(8)}`,
            'info'
        );

        // Get all buy and sell orders by their current position in grid
        const buyOrders = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);
        const sellOrders = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.SELL);

        // Calculate new sizes using same weighting algorithm
        // Pass 0 as availableFunds since we only want cache + grid
        const buyNewSizes = Grid.calculateRotationOrderSizes(
            cacheBuy,
            gridBuy,
            buyOrders.length,
            ORDER_TYPES.BUY,
            config,
            0,
            manager.assets?.assetB?.precision
        );

        const sellNewSizes = Grid.calculateRotationOrderSizes(
            cacheSell,
            gridSell,
            sellOrders.length,
            ORDER_TYPES.SELL,
            config,
            0,
            manager.assets?.assetA?.precision
        );

        // Update buy orders with new sizes
        Grid._updateOrdersForSide(manager, ORDER_TYPES.BUY, buyNewSizes, buyOrders);

        // Update sell orders with new sizes
        Grid._updateOrdersForSide(manager, ORDER_TYPES.SELL, sellNewSizes, sellOrders);

        // Recalculate funds after updating sizes
        manager.recalculateFunds();

        manager.logger?.log('Grid order sizes updated', 'info');
        manager.logger?.logFundsStatus && manager.logger.logFundsStatus(manager);
        manager.logger?.logOrderGrid && manager.logger.logOrderGrid(Array.from(manager.orders.values()), config.marketPrice);
    }

    /**
     * Compare calculated grid with persisted grid (separately by side) and return metrics.
     * Independently compares buy and sell orders, calculates relative squared differences,
     * then triggers updateGridOrderSizesForSide for each side exceeding threshold.
     * 
     * Metric formula: sum of ((calculatedSize - persistedSize) / persistedSize)^2 / count per side
     * 
     * This metric helps detect significant divergence between the current in-memory grid
     * (after updateGridOrderSizes) and what was previously persisted to disk.
     * 
     * When a side's metric exceeds GRID_COMPARISON.DIVERGENCE_THRESHOLD, automatically triggers
     * updateGridOrderSizesForSide to regenerate sizes for that side only.
     * 
     * @param {Array} calculatedGrid - Current grid orders from manager (result of updateGridOrderSizes)
     * @param {Array} persistedGrid - Grid orders loaded from orders.json
     * @param {Object} [manager] - OrderManager instance (optional, required to trigger auto-update)
     * @param {Object} [cacheFunds] - Cached funds { buy, sell } (optional, used for auto-update)
     * @returns {Object} Comparison results:
     *   {
     *     buy: { metric: number, updated: boolean },
     *     sell: { metric: number, updated: boolean },
     *     totalMetric: number (average of buy and sell)
     *   }
     *   Each metric: 0 = perfect match, higher = more divergence
     *   updated: true if auto-update was triggered for that side
     * 
     * @example
     * // Compare with auto-update by side
     * const result = Grid.compareGrids(
     *   Array.from(manager.orders.values()),
     *   accountOrders.loadBotGrid(botKey),
     *   manager,
     *   accountOrders.loadCacheFunds(botKey)
     * );
     * console.log(`Buy divergence: ${result.buy.metric.toFixed(6)}, updated: ${result.buy.updated}`);
     * console.log(`Sell divergence: ${result.sell.metric.toFixed(6)}, updated: ${result.sell.updated}`);
     */
    static compareGrids(calculatedGrid, persistedGrid, manager = null, cacheFunds = null) {
        if (!Array.isArray(calculatedGrid) || !Array.isArray(persistedGrid)) {
            return { buy: { metric: 0, updated: false }, sell: { metric: 0, updated: false }, totalMetric: 0 };
        }

        // Separate orders by type for independent comparison
        const calculatedBuys = calculatedGrid.filter(o => o && o.type === ORDER_TYPES.BUY);
        const calculatedSells = calculatedGrid.filter(o => o && o.type === ORDER_TYPES.SELL);
        const persistedBuys = persistedGrid.filter(o => o && o.type === ORDER_TYPES.BUY);
        const persistedSells = persistedGrid.filter(o => o && o.type === ORDER_TYPES.SELL);

        // Compare each side independently
        const buyMetric = Grid._compareGridSide(calculatedBuys, persistedBuys);
        const sellMetric = Grid._compareGridSide(calculatedSells, persistedSells);

        // Calculate average metric
        let totalMetric = 0;
        if (buyMetric >= 0 && sellMetric >= 0) {
            totalMetric = (buyMetric + sellMetric) / 2;
        } else if (buyMetric >= 0) {
            totalMetric = buyMetric;
        } else if (sellMetric >= 0) {
            totalMetric = sellMetric;
        }

        // Track which sides were updated
        let buyUpdated = false;
        let sellUpdated = false;

        // Trigger auto-update for BUY side if metric exceeds threshold
        if (manager && buyMetric > GRID_COMPARISON.DIVERGENCE_THRESHOLD) {
            const threshold = GRID_COMPARISON.DIVERGENCE_THRESHOLD;
            manager.logger?.log?.(
                `Buy side divergence metric ${buyMetric.toFixed(6)} exceeds threshold ${threshold.toFixed(6)}. Triggering updateGridOrderSizesForSide...`,
                'info'
            );
            
            const funds = cacheFunds || { buy: 0, sell: 0 };
            Grid.updateGridOrderSizesForSide(manager, ORDER_TYPES.BUY, funds);
            buyUpdated = true;
            
            manager.logger?.log?.(
                `Buy side order sizes updated due to high divergence metric (${buyMetric.toFixed(6)})`,
                'info'
            );
        }

        // Trigger auto-update for SELL side if metric exceeds threshold
        if (manager && sellMetric > GRID_COMPARISON.DIVERGENCE_THRESHOLD) {
            const threshold = GRID_COMPARISON.DIVERGENCE_THRESHOLD;
            manager.logger?.log?.(
                `Sell side divergence metric ${sellMetric.toFixed(6)} exceeds threshold ${threshold.toFixed(6)}. Triggering updateGridOrderSizesForSide...`,
                'info'
            );
            
            const funds = cacheFunds || { buy: 0, sell: 0 };
            Grid.updateGridOrderSizesForSide(manager, ORDER_TYPES.SELL, funds);
            sellUpdated = true;
            
            manager.logger?.log?.(
                `Sell side order sizes updated due to high divergence metric (${sellMetric.toFixed(6)})`,
                'info'
            );
        }

        return {
            buy: { metric: buyMetric, updated: buyUpdated },
            sell: { metric: sellMetric, updated: sellUpdated },
            totalMetric: totalMetric
        };
    }

    /**
     * Helper method to compare orders for a single side (buy or sell).
     * Calculates normalized sum of squared relative differences.
     * 
     * Matches orders by grid ID (buy-0, buy-1, sell-0, etc.) rather than price.
     * This ensures comparison is stable across price changes and config drift.
     * Unmatched orders (length mismatch) are treated as maximum divergence.
     * 
     * @param {Array} calculatedOrders - Calculated orders for one side (BUY or SELL only)
     * @param {Array} persistedOrders - Persisted orders for same side
     * @returns {number} Metric (0 = match, higher = divergence), or 0 if no orders
     * @private
     */
    static _compareGridSide(calculatedOrders, persistedOrders) {
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

        // Compare each calculated order with its persisted counterpart by ID
        for (const calcOrder of calculatedOrders) {
            const persOrder = persistedMap.get(calcOrder.id);

            if (persOrder) {
                // Matched by ID: compare sizes
                const calcSize = Number(calcOrder.size) || 0;
                const persSize = Number(persOrder.size) || 0;

                if (persSize > 0) {
                    // Normal relative difference when both sizes are positive
                    const relativeDiff = (calcSize - persSize) / persSize;
                    sumSquaredDiff += relativeDiff * relativeDiff;
                    matchCount++;
                } else if (calcSize > 0) {
                    // If persisted size is 0 but calculated size is > 0, treat as maximum divergence
                    sumSquaredDiff += 1.0;
                    matchCount++;
                } else {
                    // Both are zero: perfect match
                    matchCount++;
                }
            } else {
                // Unmatched by ID: grid structure mismatch (e.g., different number of orders)
                // Treat as significant divergence
                sumSquaredDiff += 1.0;
                unmatchedCount++;
            }
        }

        // Also check for persisted orders that don't exist in calculated (opposite direction)
        for (const persOrder of persistedOrders) {
            if (!calculatedOrders.some(c => c.id === persOrder.id)) {
                // Persisted order has no calculated counterpart: divergence
                sumSquaredDiff += 1.0;
                unmatchedCount++;
            }
        }

        // Return normalized metric: average squared difference
        const totalOrders = matchCount + unmatchedCount;
        return totalOrders > 0 ? sumSquaredDiff / totalOrders : 0;
    }

    /**
     * Clear and persist cacheFunds for a given side ('buy' or 'sell').
     * Centralizes duplicated logic used after grid regeneration.
     */
    static _clearAndPersistCacheFunds(manager, side) {
        try {
            manager.funds.cacheFunds = manager.funds.cacheFunds || { buy: 0, sell: 0 };
            manager.funds.cacheFunds[side] = 0;
            const { AccountOrders } = require('../account_orders');
            if (manager.config && manager.config.botKey) {
                const accountDb = manager.accountOrders || new AccountOrders({ profilesPath: manager.config.profilesPath });
                accountDb.updateCacheFunds(manager.config.botKey, manager.funds.cacheFunds);
                manager.logger?.log?.(`Cleared persisted cacheFunds.${side} after regeneration`, 'info');
            } else {
                manager.logger?.log?.(`Cleared in-memory cacheFunds.${side} after regeneration (no botKey)`, 'info');
            }
        } catch (e) {
            manager.logger?.log?.(`Failed to clear/persist cacheFunds after ${side} regeneration: ${e.message}`, 'warn');
        }
    }

    /**
     * Update a collection of orders for a specific side using provided sizes.
     * Centralizes duplicated buy/sell update loops.
     * @param {Object} manager
     * @param {string} orderType
     * @param {Array<number>} newSizes
     * @param {Array<Object>} [orders] - optional pre-fetched orders
     */
    static _updateOrdersForSide(manager, orderType, newSizes, orders = null) {
        const isBuy = orderType === ORDER_TYPES.BUY;
        const sideName = isBuy ? 'buy' : 'sell';
        const ords = Array.isArray(orders) ? orders : Array.from(manager.orders.values()).filter(o => o.type === orderType);
        if (ords.length === 0) {
            manager.logger?.log(`No ${sideName} orders found to update`, 'warn');
            return;
        }

        ords.forEach((order, i) => {
            const newSize = newSizes[i] || 0;
            if (Math.abs(order.size - newSize) > 1e-8) {
                manager.logger?.log(
                    `${sideName.charAt(0).toUpperCase() + sideName.slice(1)} ${order.id} @ ${order.price.toFixed(6)}: ${order.size.toFixed(8)} → ${newSize.toFixed(8)}`,
                    'debug'
                );
                const updatedOrder = { ...order, size: newSize };
                manager._updateOrder(updatedOrder);
            }
        });
    }

    /**
     * Allocate `totalFunds` across `n` slots using geometric weights.
     * Handles reverse ordering, min-size checks with precision-aware integer
     * comparison, and a fallback retry without min-size enforcement.
     *
     * @returns {Array<number>} sizes
     */
    static _allocateByWeights(totalFunds, n, weight, incrementFactor, reverse = false, minSize = 0, precision = null) {
        if (n <= 0) return [];
        if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

        const MIN_WEIGHT = -1;
        const MAX_WEIGHT = 2;
        if (!Number.isFinite(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
            throw new Error(`Invalid weight distribution: ${weight}. Must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        }

        const base = 1 - incrementFactor;
        const rawWeights = new Array(n);
        for (let i = 0; i < n; i++) {
            const idx = reverse ? (n - 1 - i) : i;
            rawWeights[i] = Math.pow(base, idx * weight);
        }

        const sizes = new Array(n).fill(0);
        const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
        for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;

        return sizes;
    }

    /**
     * Return a normalized funds snapshot for the manager.
     * Includes chain/allocated/grid/cache/virtuel totals used across sizing.
     */
    static _getFundSnapshot(manager) {
        const mgrSnap = (manager.getChainFundsSnapshot && typeof manager.getChainFundsSnapshot === 'function') ? manager.getChainFundsSnapshot() : {};
        return {
            chainFreeBuy: Number(mgrSnap.chainFreeBuy || 0),
            chainFreeSell: Number(mgrSnap.chainFreeSell || 0),
            chainTotalBuy: Number(mgrSnap.chainTotalBuy || 0),
            chainTotalSell: Number(mgrSnap.chainTotalSell || 0),
            allocatedBuy: Number(mgrSnap.allocatedBuy || 0),
            allocatedSell: Number(mgrSnap.allocatedSell || 0),
            gridBuy: Number(manager.funds?.total?.grid?.buy || 0),
            gridSell: Number(manager.funds?.total?.grid?.sell || 0),
            cacheBuy: Number(manager.funds?.cacheFunds?.buy || 0),
            cacheSell: Number(manager.funds?.cacheFunds?.sell || 0),
            virtuelBuy: Number(manager.funds?.virtuel?.buy || 0),
            virtuelSell: Number(manager.funds?.virtuel?.sell || 0),
        };
    }

    static _logSizingInput(manager, snap) {
        manager.logger.log(
            `DEBUG Grid Sizing Input: buyFunds=${Number(snap.allocatedBuy).toFixed(8)} (allocated=${Number(snap.allocatedBuy).toFixed(8)}, total=${Number(snap.chainTotalBuy).toFixed(8)}, free=${Number(snap.chainFreeBuy).toFixed(8)}), ` +
            `sellFunds=${Number(snap.allocatedSell).toFixed(8)} (allocated=${Number(snap.allocatedSell).toFixed(8)}, total=${Number(snap.chainTotalSell).toFixed(8)}, free=${Number(snap.chainFreeSell).toFixed(8)})`,
            'info'
        );
    }

    /**
     * Calculate individual order sizes based on available funds and total grid allocation.
     * Uses the same geometric weighting algorithm as grid initialization.
     * Distributes the combined allocation (available + grid) across orders during rotation.
     * This ensures new rotation orders cover the same total allocation space as the full grid.
     *
     * @param {number} availableFunds - Currently available funds for new orders
     * @param {number} totalGridAllocation - Total currently allocated in grid (committed + virtuel)
     * @param {number} orderCount - Number of new orders to size
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Object} config - Configuration object with incrementPercent and weightDistribution
     * @param {number} [minSize=0] - Minimum order size (optional)
     * @param {number} [precision=null] - Asset precision for integer-based size validation (optional)
     * @returns {Array} Array of order sizes (length = orderCount)
     * @example
     * // Distribute 100 available + 400 already allocated = 500 total across 5 new orders
     * const sizes = Grid.calculateRotationOrderSizes(
     *     100,                               // available funds from fill
     *     400,                               // existing grid allocation (buy or sell side)
     *     5,                                 // 5 new orders to create
     *     ORDER_TYPES.BUY,
     *     { incrementPercent: 1, weightDistribution: { buy: 0.5, sell: 0.5 } }
     * );
     * // Returns: [size0, size1, size2, size3, size4] where sizes sum to ~500
     */
    static calculateRotationOrderSizes(availableFunds, totalGridAllocation, orderCount, orderType, config, minSize = 0, precision = null) {
        if (orderCount <= 0) {
            return [];
        }

        // Combine available funds + total grid allocation for full distribution
        const totalFunds = availableFunds + totalGridAllocation;

        if (!Number.isFinite(totalFunds) || totalFunds <= 0) {
            return new Array(orderCount).fill(0);
        }

        const { incrementPercent, weightDistribution } = config;
        const incrementFactor = incrementPercent / 100;

        const weight = (orderType === ORDER_TYPES.SELL) ? weightDistribution.sell : weightDistribution.buy;
        const reverse = (orderType === ORDER_TYPES.SELL);
        return Grid._allocateByWeights(totalFunds, orderCount, weight, incrementFactor, reverse, minSize, precision);
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
// (moved into class body below)

// (moved into static Grid.initializeGrid above)

/**
 * Perform a full grid resynchronization from blockchain state (moved from manager)
 * @param {Object} manager - OrderManager instance
 * @param {Function} readOpenOrdersFn - async function to fetch open orders
 * @param {Function} cancelOrderFn - async function to cancel an order
 */
// (moved into static Grid.recalculateGrid above)

// Expose the grid generator as module export
module.exports = Grid;

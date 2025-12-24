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
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, GRID_LIMITS } = require('../constants');
const { GRID_COMPARISON } = GRID_LIMITS;
const { floatToBlockchainInt, blockchainToFloat, resolveRelativePrice } = require('./utils');

// Grid sizing limits are centralized in modules/constants.js -> GRID_LIMITS

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

        // CRITICAL: Validate increment bounds before using in calculations
        // Prevents division by zero (line 75: Math.log(stepUp)) and invalid prices
        if (incrementPercent <= 0 || incrementPercent >= 100) {
            throw new Error(`Invalid incrementPercent: ${incrementPercent}. Must be between 0.01 and 10 (exclusive of 0 and 100).`);
        }

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

        // CRITICAL: Preserve persistent funds before reset
        // cacheFunds: accumulated surplus from rotation sizing (persists across sessions)
        // btsFeesOwed: accumulated blockchain fees
        // Note: legacy `pendingProceeds` is deprecated. If present in-memory,
        // merge it into `cacheFunds` so proceeds are not lost during reset.
        const savedCacheFunds = { ...manager.funds.cacheFunds };
        const savedPendingProceeds = manager.funds.pendingProceeds ? { ...manager.funds.pendingProceeds } : { buy: 0, sell: 0 };
        const savedBtsFeesOwed = manager.funds.btsFeesOwed;

        manager.resetFunds();

        // Merge any legacy pendingProceeds into cacheFunds and restore fees
        manager.funds.cacheFunds = {
            buy: (savedCacheFunds.buy || 0) + (savedPendingProceeds.buy || 0),
            sell: (savedCacheFunds.sell || 0) + (savedPendingProceeds.sell || 0)
        };
        manager.funds.btsFeesOwed = savedBtsFeesOwed;

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

        const diagMsg = `Allocating sizes: sellFunds=${String(manager.calculateAvailableFunds('sell'))}, buyFunds=${String(manager.calculateAvailableFunds('buy'))}, ` +
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

        // Deduct BTS fees for orders: 4x multiplier accounts for creation and rotation buffer
        // This keeps grid initialization in sync with calculateAvailableFundsValue fee reservation
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

                // Calculate fees for all target orders with 4x multiplier:
                // 1x for initial order creation
                // 3x as buffer for potential future rotations/updates
                // This ensures grid initialization reserves sufficient BTS for multiple rotation cycles
                const totalOrdersToCreate = targetBuy + targetSell;
                const FEE_MULTIPLIER = 4; // Creation (1x) + Rotation buffer (3x)

                if (totalOrdersToCreate > 0) {
                    const btsFeeData = getAssetFees('BTS', 1); // Amount doesn't matter for create fee
                    btsFeesForCreation = btsFeeData.createFee * totalOrdersToCreate * FEE_MULTIPLIER;
                    manager.logger.log(
                        `BTS fee reservation: ${totalOrdersToCreate} orders × ${FEE_MULTIPLIER}x (creation + rotation buffer) (buy=${targetBuy}, sell=${targetSell}) = ${btsFeesForCreation.toFixed(8)} BTS`,
                        'info'
                    );
                }
            } catch (err) {
                manager.logger?.log?.(
                    `Warning: Could not calculate BTS fees: ${err.message}`,
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
        manager.logger.log(`DEBUG Grid Sizing Discrepancy: buy=${(finalInputFundsBuy - sizedAllocatedBuy).toFixed(8)}, sell=${(finalInputFundsSell - sizedAllocatedSell).toFixed(8)}`, 'info');

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

        // NOTE: pendingProceeds are RESET during grid initialization (full regeneration)
        // They will be restored from persistence if needed during bot startup
        manager.resetFunds();
        // Do NOT preserve pendingProceeds here - grid regeneration clears all state

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

        // NOTE: `pendingProceeds` storage removed. Any legacy proceeds are handled via migration.

        // Also clear BTS fees when grid is regenerated
        if (manager.funds && typeof manager.funds.btsFeesOwed === 'number' && manager.funds.btsFeesOwed > 0) {
            manager.funds.btsFeesOwed = 0;
            try {
                if (manager.accountOrders && typeof manager.accountOrders.updateBtsFeesOwed === 'function') {
                    manager.accountOrders.updateBtsFeesOwed(manager.config.botKey, 0);
                    manager.logger?.log?.('✓ Cleared BTS fees owed after grid regeneration', 'info');
                }
            } catch (e) {
                manager.logger?.log?.(`Warning: failed to clear persisted BTS fees during regeneration: ${e.message}`, 'warn');
            }
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
     * Check if cache or available funds exceed regeneration threshold and update grid sizes if needed.
     * Independently checks buy and sell sides - can update just one side.
     * Threshold: if ((cacheFunds + availableFunds) / total.grid) * 100 >= GRID_REGENERATION_PERCENTAGE, update that side.
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

        const { GRID_LIMITS } = require('../constants');
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

            // Include available funds in the regeneration check so newly added funds
            // trigger a grid resize during the next fill/comparison cycle.
            const avail = manager.calculateAvailableFunds(s.name);
            const totalPending = s.cache + avail;
            const ratio = (totalPending / s.grid) * 100;

            if (ratio >= threshold) {
                manager.logger?.log(
                    `Unallocated funds ratio for ${s.name} side (cache=${s.cache.toFixed(8)}, available=${avail.toFixed(8)}): ${ratio.toFixed(2)}% >= ${threshold}% threshold. Marking for grid update.`,
                    'info'
                );
                // Mark which sides need grid update - caller will handle actual update via updateGridFromBlockchainSnapshot()
                if (!manager._gridSidesUpdated) manager._gridSidesUpdated = [];
                manager._gridSidesUpdated.push(s.orderType);
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
     * Recalculate grid order sizes for a side using fresh blockchain totals.
     * Used during divergence/threshold recalculation - NOT for initial grid creation.
     *
     * Applies botFunds allocation constraints (same as initial grid creation).
     * This respects percentage-based botFunds config when multiple bots share an account.
     * Uses allocated funds (respecting botFunds percentage) - not cache+grid+available approach.
     *
     * @param {Object} manager - OrderManager instance
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {void} Updates orders in-place
     * @private
     */
    static _recalculateGridOrderSizesFromBlockchain(manager, orderType) {
        if (!manager) throw new Error('_recalculateGridOrderSizesFromBlockchain requires manager');

        const config = manager.config || {};
        const isBuy = orderType === ORDER_TYPES.BUY;
        const sideName = isBuy ? 'buy' : 'sell';

        // Apply botFunds allocation constraints (same as initial grid creation)
        // This respects percentage-based botFunds config when multiple bots share an account
        if (manager.applyBotFundsAllocation && typeof manager.applyBotFundsAllocation === 'function') {
            manager.applyBotFundsAllocation();
        }

        // Get allocated funds for this side (respects botFunds percentage if configured)
        // Falls back to blockchain total if no botFunds allocation is set
        const allocatedFunds = isBuy
            ? manager.funds?.allocated?.buy || manager.accountTotals?.buy || 0
            : manager.funds?.allocated?.sell || manager.accountTotals?.sell || 0;

        manager.logger?.log(
            `Recalculating ${sideName} side order sizes from allocated funds: ${allocatedFunds.toFixed(8)}`,
            'info'
        );

        // Required utils for precision handling
        const { floatToBlockchainInt, blockchainToFloat } = require('./utils');

        // Get orders for this side
        const orders = Array.from(manager.orders.values()).filter(o => o.type === orderType);

        if (orders.length === 0) {
            manager.logger?.log(`No ${sideName} orders found to recalculate`, 'warn');
            return;
        }

        // Calculate new sizes using blockchain total only
        const precision = isBuy ? manager.assets?.assetB?.precision : manager.assets?.assetA?.precision;

        // Use allocated funds directly for sizing (respects botFunds percentage if configured)
        const newSizes = Grid.calculateRotationOrderSizes(
            allocatedFunds,   // Use allocated funds as sole fund source
            0,                // availableFunds = 0 (already in allocatedFunds)
            orders.length,
            orderType,
            config,
            0,
            precision
        );

        // DEBUG: Log calculated sizes summary
        try {
            const minSize = Math.min(...newSizes);
            const maxSize = Math.max(...newSizes);
            const avgSize = newSizes.reduce((a, b) => a + b, 0) / newSizes.length;
            manager.logger?.log?.(`DEBUG Blockchain Recalc Sizes (${sideName}): count=${newSizes.length}, total=${allocatedFunds.toFixed(8)}, min=${minSize.toFixed(8)}, max=${maxSize.toFixed(8)}, avg=${avgSize.toFixed(8)}`, 'debug');
        } catch (e) { manager.logger?.log?.(`Warning: failed to log calculated sizes: ${e.message}`, 'warn'); }

        // Update orders with new sizes
        Grid._updateOrdersForSide(manager, orderType, newSizes, orders);

        // Recalculate funds after updating this side
        manager.recalculateFunds();

        manager.logger?.log(`${sideName} side order sizes recalculated from allocated funds`, 'info');

        // Calculate surplus and recycle to cacheFunds
        if (precision !== undefined && precision !== null) {
            const totalInputInt = floatToBlockchainInt(allocatedFunds, precision);
            let totalAllocatedInt = 0;

            newSizes.forEach(size => {
                totalAllocatedInt += floatToBlockchainInt(size, precision);
            });

            const surplusInt = totalInputInt - totalAllocatedInt;
            const surplus = blockchainToFloat(surplusInt, precision);

            try {
                manager.logger?.log?.(
                    `DEBUG Blockchain Recalc Surplus (${sideName}): total=${allocatedFunds.toFixed(8)}, allocated=${blockchainToFloat(totalAllocatedInt, precision).toFixed(8)}, surplus=${surplus.toFixed(8)}`,
                    'debug'
                );
            } catch (e) { manager.logger?.log?.(`Warning: failed to log surplus: ${e.message}`, 'warn'); }

            // Add surplus back to cacheFunds
            if (!manager.funds.cacheFunds) manager.funds.cacheFunds = { buy: 0, sell: 0 };
            manager.funds.cacheFunds[sideName] = surplus;

            manager.logger?.log(
                `DEBUG Blockchain Recalc: surplus=${surplus.toFixed(8)} added to cache`,
                'debug'
            );
        }
    }

    /**
     * Recalculate grid order sizes when threshold or divergence is detected.
     * Main entry point for grid updates triggered by market conditions.
     *
     * Keeps CURRENT price and spread structure, only recalculates order SIZES
     * using allocated funds (respecting botFunds percentage configuration).
     * This maintains bot configuration consistency while adapting to fund changes.
     *
     * Data sources for sizing:
     * - Fresh blockchain totals (from manager.accountTotals after fetchAccountTotals)
     * - Allocated funds with botFunds percentage applied (same as initial grid creation)
     * - NOT cache+grid+available (that's only for initial grid creation)
     *
     * @param {Object} manager - OrderManager instance
     * @param {string} orderType - ORDER_TYPES.BUY, ORDER_TYPES.SELL, or 'both'
     * @param {boolean} fromBlockchainTimer - If true, blockchain data already fresh from 4-hour timer.
     *                                        If false, called from external trigger (needs refetch).
     * @returns {Promise<void>}
     */
    static async updateGridFromBlockchainSnapshot(manager, orderType = 'both', fromBlockchainTimer = false) {
        if (!manager) throw new Error('updateGridFromBlockchainSnapshot requires manager');

        try {
            // If NOT from blockchain timer, fetch fresh blockchain data first
            if (!fromBlockchainTimer) {
                // Fetch fresh blockchain account values
                // This updates manager.accountTotals with current on-chain balances
                const accountId = manager.config?.accountId;
                if (accountId) {
                    await manager.fetchAccountTotals(accountId);
                }
            }
            // Otherwise blockchain data is already fresh from 4-hour timer

            // Recalculate order sizes using BLOCKCHAIN TOTALS ONLY (not cache+grid+available)
            // (keeps existing market price and bounds, only adjusts sizes for fund changes)
            if (orderType === ORDER_TYPES.BUY || orderType === 'both') {
                Grid._recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY);
            }
            if (orderType === ORDER_TYPES.SELL || orderType === 'both') {
                Grid._recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.SELL);
            }
        } catch (err) {
            manager.logger?.log?.(
                `Error recalculating grid from blockchain snapshot: ${err.message}`,
                'error'
            );
            throw err;
        }
    }

    /**
     * Convert buy/sell update flags to orderType string.
     * Helper to reduce code repetition when determining which sides need updates.
     *
     * @param {boolean} buyUpdated - Whether buy side was updated
     * @param {boolean} sellUpdated - Whether sell side was updated
     * @returns {string} 'both', 'buy', or 'sell'
     * @private
     */
    static _getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated) {
        return (buyUpdated && sellUpdated) ? 'both' : (buyUpdated ? 'buy' : 'sell');
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

        // Get grid allocation
        const gridBuy = manager.funds?.total?.grid?.buy || 0;
        const gridSell = manager.funds?.total?.grid?.sell || 0;

        // Get available funds
        const availableBuy = manager.funds?.available?.buy || 0;
        const availableSell = manager.funds?.available?.sell || 0;

        // Total to distribute: cache + grid + available
        const totalBuy = cacheBuy + gridBuy + availableBuy;
        const totalSell = cacheSell + gridSell + availableSell;

        manager.logger?.log(
            `Updating grid order sizes - Buy: cache=${cacheBuy.toFixed(8)} + grid=${gridBuy.toFixed(8)} + available=${availableBuy.toFixed(8)} = ${totalBuy.toFixed(8)}`,
            'info'
        );
        manager.logger?.log(
            `Updating grid order sizes - Sell: cache=${cacheSell.toFixed(8)} + grid=${gridSell.toFixed(8)} + available=${availableSell.toFixed(8)} = ${totalSell.toFixed(8)}`,
            'info'
        );

        // Get all buy and sell orders by their current position in grid
        const buyOrders = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);
        const sellOrders = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.SELL);

        // Required utils for precision handling
        const { floatToBlockchainInt, blockchainToFloat } = require('./utils');
        const precA = manager.assets?.assetA?.precision;
        const precB = manager.assets?.assetB?.precision;

        // Calculate new sizes using same weighting algorithm
        // Pass 0 as availableFunds since we use totalBuy/totalSell as input context
        const buyNewSizes = Grid.calculateRotationOrderSizes(
            totalBuy,
            0,
            buyOrders.length,
            ORDER_TYPES.BUY,
            config,
            0,
            precB
        );

        const sellNewSizes = Grid.calculateRotationOrderSizes(
            totalSell,
            0,
            sellOrders.length,
            ORDER_TYPES.SELL,
            config,
            0,
            precA
        );

        // Update buy orders with new sizes
        Grid._updateOrdersForSide(manager, ORDER_TYPES.BUY, buyNewSizes, buyOrders);

        // Update sell orders with new sizes
        Grid._updateOrdersForSide(manager, ORDER_TYPES.SELL, sellNewSizes, sellOrders);

        // NOTE: `pendingProceeds` handling removed; no persistence needed.

        // Recalculate funds after updating sizes
        manager.recalculateFunds();

        // Calculate and cache surplus for Buy side
        if (precB !== undefined && precB !== null) {
            const totalInput = floatToBlockchainInt(totalBuy, precB);
            let totalAllocated = 0;
            buyNewSizes.forEach(s => totalAllocated += floatToBlockchainInt(s, precB));
            const surplus = blockchainToFloat(totalInput - totalAllocated, precB);

            if (!manager.funds.cacheFunds) manager.funds.cacheFunds = { buy: 0, sell: 0 };
            manager.funds.cacheFunds.buy = surplus;
        }

        // Calculate and cache surplus for Sell side
        if (precA !== undefined && precA !== null) {
            const totalInput = floatToBlockchainInt(totalSell, precA);
            let totalAllocated = 0;
            sellNewSizes.forEach(s => totalAllocated += floatToBlockchainInt(s, precA));
            const surplus = blockchainToFloat(totalInput - totalAllocated, precA);

            if (!manager.funds.cacheFunds) manager.funds.cacheFunds = { buy: 0, sell: 0 };
            manager.funds.cacheFunds.sell = surplus;
        }

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
     * When a side's RMS metric exceeds GRID_COMPARISON.RMS_PERCENTAGE, automatically triggers
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

        const { ORDER_STATES } = require('../constants'); // Moved up for use in filtering
        // Separate orders by type and filter out PARTIAL and SPREAD orders from the comparison calculation
        // PARTIAL: temporary states (remainder being filled) - excluded because they're transient
        // SPREAD: placeholders with size 0 (filled orders) - excluded because they don't represent active grid
        // This ensures divergence metric reflects the true active grid structure (ACTIVE orders only)
        const calculatedBuys = calculatedGrid.filter(o => o && o.type === ORDER_TYPES.BUY && o.state !== ORDER_STATES.PARTIAL);
        const calculatedSells = calculatedGrid.filter(o => o && o.type === ORDER_TYPES.SELL && o.state !== ORDER_STATES.PARTIAL);
        const persistedBuys = persistedGrid.filter(o => o && o.type === ORDER_TYPES.BUY && o.state !== ORDER_STATES.PARTIAL);
        const persistedSells = persistedGrid.filter(o => o && o.type === ORDER_TYPES.SELL && o.state !== ORDER_STATES.PARTIAL);

        // Helper: Calculate ideal orders if manager is present
        // This ensures the comparison reflects what the grid SHOULD be (with available funds included)
        // rather than what it IS (potentially stale sizes).
        const getIdealOrders = (orders, type) => {
            if (!manager || orders.length === 0) return orders;

            const isBuy = type === ORDER_TYPES.BUY;
            const cache = isBuy ? Number(cacheFunds?.buy || 0) : Number(cacheFunds?.sell || 0);
            const grid = isBuy
                ? manager.funds?.total?.grid?.buy || 0
                : manager.funds?.total?.grid?.sell || 0;
            const available = isBuy
                ? manager.funds?.available?.buy || 0
                : manager.funds?.available?.sell || 0;

            // CRITICAL FIX: Since the 'orders' passed to this helper now exclude partial orders,
            // we must also subtract the capital held in those partial orders from the total budget.
            // Otherwise, we'd be trying to distribute 100% of funds across only a partial set of slots,
            // leading to artificial divergence.
            const partialsValue = calculatedGrid
                .filter(o => o && o.type === type && o.state === ORDER_STATES.PARTIAL)
                .reduce((sum, o) => sum + (Number(o.size) || 0), 0);

            const totalInput = Math.max(0, cache + grid + available - partialsValue);
            const precision = isBuy ? manager.assets?.assetB?.precision : manager.assets?.assetA?.precision;
            const config = manager.config || {};

            try {
                const idealSizes = Grid.calculateRotationOrderSizes(
                    totalInput,
                    0, // gridValue is covered by totalInput
                    orders.length, // Use the length of the filtered orders
                    type,
                    config,
                    0,
                    precision
                );

                // Return clones with ideal sizes
                return orders.map((o, i) => ({ ...o, size: idealSizes[i] }));
            } catch (e) {
                manager.logger?.log?.(`Warning: failed to calc ideal sizes for comparison: ${e.message}`, 'warn');
                return orders; // Fallback to original
            }
        };

        // If manager is provided, compare "Ideal" vs "Persisted"
        // If not, compare "Calculated" (current) vs "Persisted"
        const idealBuys = manager ? getIdealOrders(calculatedBuys, ORDER_TYPES.BUY) : calculatedBuys;
        const idealSells = manager ? getIdealOrders(calculatedSells, ORDER_TYPES.SELL) : calculatedSells;

        // Compare each side independently
        const buyMetric = Grid._compareGridSide(idealBuys, persistedBuys, 'buy');
        const sellMetric = Grid._compareGridSide(idealSells, persistedSells, 'sell');

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

        // Mark BUY side for update if RMS metric exceeds threshold
        if (manager && buyMetric > (GRID_COMPARISON.RMS_PERCENTAGE / 100)) {
            const metricPercent = buyMetric * 100;  // RMS is 0-1 scale, convert to percentage (0-100)
            const threshold = GRID_COMPARISON.RMS_PERCENTAGE;
            manager.logger?.log?.(
                `Buy side RMS divergence ${metricPercent.toFixed(2)}% exceeds threshold ${threshold}%. Marking for grid update.`,
                'info'
            );

            // Track which sides were updated so caller can apply grid updates
            if (!manager._gridSidesUpdated) manager._gridSidesUpdated = [];
            if (!manager._gridSidesUpdated.includes(ORDER_TYPES.BUY)) {
                manager._gridSidesUpdated.push(ORDER_TYPES.BUY);
            }

            buyUpdated = true;

            manager.logger?.log?.(
                `Buy side marked for grid update due to high divergence metric (${buyMetric.toFixed(6)})`,
                'info'
            );
        }

        // Mark SELL side for update if RMS metric exceeds threshold
        if (manager && sellMetric > (GRID_COMPARISON.RMS_PERCENTAGE / 100)) {
            const metricPercent = sellMetric * 100;  // RMS is 0-1 scale, convert to percentage (0-100)
            const threshold = GRID_COMPARISON.RMS_PERCENTAGE;
            manager.logger?.log?.(
                `Sell side RMS divergence ${metricPercent.toFixed(2)}% exceeds threshold ${threshold}%. Marking for grid update.`,
                'info'
            );

            // Track which sides were updated so caller can apply grid updates
            if (!manager._gridSidesUpdated) manager._gridSidesUpdated = [];
            if (!manager._gridSidesUpdated.includes(ORDER_TYPES.SELL)) {
                manager._gridSidesUpdated.push(ORDER_TYPES.SELL);
            }

            sellUpdated = true;

            manager.logger?.log?.(
                `Sell side marked for grid update due to high divergence metric (${sellMetric.toFixed(6)})`,
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
    static _compareGridSide(calculatedOrders, persistedOrders, sideName = 'unknown') {
        if (!Array.isArray(calculatedOrders) || !Array.isArray(persistedOrders)) {
            return 0;
        }

        if (calculatedOrders.length === 0 && persistedOrders.length === 0) {
            return 0;
        }

        // Filtered lists already provided by caller (compareGrids)
        const filteredCalculated = calculatedOrders;
        const filteredPersisted = persistedOrders;

        if (filteredCalculated.length === 0 && filteredPersisted.length === 0) {
            return 0;
        }

        // Build lookup map by grid ID for stable matching
        const persistedMap = new Map();
        for (const order of filteredPersisted) {
            if (order.id) {
                persistedMap.set(order.id, order);
            }
        }

        let sumSquaredDiff = 0;
        let matchCount = 0;
        let unmatchedCount = 0;
        let maxRelativeDiff = 0;  // Track the largest relative difference for debugging

        // Compare each calculated order with its persisted counterpart by ID
        const largeDeviations = [];  // Track orders with large deviations for debugging

        for (const calcOrder of filteredCalculated) {
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
                // Unmatched by ID: grid structure mismatch (e.g., different number of orders)
                // Treat as significant divergence
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

        // Also check for persisted orders that don't exist in calculated (opposite direction)
        for (const persOrder of filteredPersisted) {
            if (!filteredCalculated.some(c => c.id === persOrder.id)) {
                // Persisted order has no calculated counterpart: divergence
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

        // Return RMS (Root Mean Square) metric: sqrt of average squared difference
        // RMS is the quadratic mean, representing standard deviation of relative errors
        const totalOrders = matchCount + unmatchedCount;
        const meanSquaredDiff = totalOrders > 0 ? sumSquaredDiff / totalOrders : 0;
        const metric = Math.sqrt(meanSquaredDiff);  // RMS calculation

        // Log divergence calculation breakdown
        if (metric > 0.1) {  // More than 10% RMS divergence
            const partialExcludedCount = persistedOrders.length - filteredPersisted.length;
            console.log(`\nDEBUG [${sideName}] Divergence Calculation Breakdown:`);
            console.log(`  Matched orders: ${matchCount}`);
            console.log(`  Unmatched orders: ${unmatchedCount}`);
            console.log(`  Total orders (denominator): ${totalOrders}`);
            if (partialExcludedCount > 0) {
                console.log(`  Partial orders excluded: ${partialExcludedCount}`);
            }
            console.log(`  Sum of squared differences: ${sumSquaredDiff.toFixed(8)}`);
            console.log(`  Mean squared difference: ${meanSquaredDiff.toFixed(8)}`);
            console.log(`  RMS (Root Mean Square): ${metric.toFixed(4)} (${(metric * 100).toFixed(2)}%)`);
            console.log(`  Max relative difference: ${(maxRelativeDiff * 100).toFixed(2)}%`);
            console.log(`  Large deviations (>10%): ${largeDeviations.length}`);

            if (largeDeviations.length > 0) {
                console.log(`  Top deviations:`);
                largeDeviations.slice(0, 10).forEach((d, idx) => {
                    console.log(`    ${idx + 1}. ${d.id}: pers=${d.persSize}, calc=${d.calcSize}, diff=${d.percentDiff}%`);
                });
                if (largeDeviations.length > 10) {
                    console.log(`    ... and ${largeDeviations.length - 10} more`);
                }
            }
            console.log('');
        }

        return metric;
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
                const accountDb = manager.accountOrders || new AccountOrders({ botKey: manager.config.botKey });
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
     * Persist current cacheFunds for a given side without clearing it.
     */
    static _persistCacheFunds(manager, side) {
        try {
            manager.funds.cacheFunds = manager.funds.cacheFunds || { buy: 0, sell: 0 };
            // Ensure side exists
            if (manager.funds.cacheFunds[side] === undefined) manager.funds.cacheFunds[side] = 0;

            const { AccountOrders } = require('../account_orders');
            if (manager.config && manager.config.botKey) {
                const accountDb = manager.accountOrders || new AccountOrders({ botKey: manager.config.botKey });
                accountDb.updateCacheFunds(manager.config.botKey, manager.funds.cacheFunds);
                manager.logger?.log?.(`Persisted cacheFunds.${side} (${Number(manager.funds.cacheFunds[side]).toFixed(8)}) after regeneration`, 'debug');
            }
        } catch (e) {
            manager.logger?.log?.(`Failed to persist cacheFunds after ${side} regeneration: ${e.message}`, 'warn');
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
    /**
     * Allocate funds across orders using geometric weight distribution.
     *
     * Weight Distribution Algorithm:
     * ================================
     * This function creates a proportional allocation across n orders based on weight distribution.
     * The key formula is: weight[i] = (1 - increment)^(i * n)
     *
     * Where:
     * - base = (1 - incrementFactor) ranges from 0.98 (1% increment) to 0.99 (0.5% increment)
     * - idx = order index (0 = closest to market, n-1 = furthest from market)
     * - weight = distribution coefficient (-1 to 2) controlling shape:
     *   - weight = -1: Super Valley (aggressive concentration at edges)
     *   - weight = 0:  Valley (linear increase toward edges)
     *   - weight = 0.5: Neutral (balanced distribution)
     *   - weight = 1:  Mountain (linear increase toward center/market)
     *   - weight = 2:  Super Mountain (aggressive concentration at center)
     *
     * Examples (5 orders, 1% increment, 100 units total):
     * - weight=-1: [55.3, 39.2, 3.2, 1.8, 0.5] (edges get most)
     * - weight=0:  [20.0, 20.0, 20.0, 20.0, 20.0] (equal split)
     * - weight=1:  [0.5, 1.8, 3.2, 39.2, 55.3] (center gets most)
     *
     * @param {number} totalFunds - Total amount to distribute
     * @param {number} n - Number of orders to allocate across
     * @param {number} weight - Distribution shape (-1 to 2)
     * @param {number} incrementFactor - Price increment as decimal (0.01 for 1%)
     * @param {boolean} reverse - If true, reverse the allocation (for sell orders)
     * @param {number} minSize - Minimum order size threshold (0 to disable)
     * @param {number} precision - Blockchain precision for size quantization
     * @returns {Array} Array of order sizes
     */
    static _allocateByWeights(totalFunds, n, weight, incrementFactor, reverse = false, minSize = 0, precision = null) {
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
     *
     * Rotation Sizing Strategy:
     * ========================
     * After fills occur, we need to size new orders. This function ensures the new orders
     * maintain the same proportional distribution as the full grid would have.
     *
     * The key insight: When filling n orders out of N total grid positions:
     * - We have: available funds (from fills) + grid allocation (remaining orders)
     * - We size n new orders to match what a full reset would allocate
     *
     * This maintains grid coherence without requiring a full grid regeneration.
     *
     * Example Scenario (5 total grid orders, 2 filled):
     * -----------------------------------------------
     * Initial grid allocation: 100 BTS per order = 500 total
     * - 2 orders fill and are converted to SPREAD placeholders
     * - We have: 200 BTS in available funds (from fills) + 300 BTS remaining in grid
     * - We size 2 new orders to sum to 200 (reflecting the original allocation for 2 positions)
     *
     * The formula ensures: newOrdersSizes = (availableFunds + gridAllocation) * (geometric_weights)
     *
     * @param {number} availableFunds - Currently available funds (includes fill proceeds + cache + free balance)
     * @param {number} totalGridAllocation - Total funds currently locked in grid (committed.grid + virtuel)
     * @param {number} orderCount - Number of new orders to size (e.g., 2 if 2 orders were filled)
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Object} config - Configuration with incrementPercent and weightDistribution
     * @param {number} [minSize=0] - Minimum order size constraint (optional)
     * @param {number} [precision=null] - Blockchain precision for integer-based quantization (optional)
     * @returns {Array} Array of order sizes (length = orderCount)
     *
     * @example
     * // Grid has 5 orders (100 BTS each = 500 total)
     * // 2 orders get filled, leaving 300 BTS in grid + 200 BTS available
     * const sizes = Grid.calculateRotationOrderSizes(
     *     200,                               // available funds (from 2 fills @ 100 each)
     *     300,                               // remaining grid allocation (3 unfilled orders @ 100 each)
     *     2,                                 // size 2 new orders
     *     ORDER_TYPES.BUY,
     *     { incrementPercent: 1, weightDistribution: { buy: 1, sell: 1 } }
     * );
     * // Returns: [size0, size1] where sizes sum to ~200, distributed per weight (Mountain style)
     * // The geometric shape mirrors what a full 5-order reset would look like
     */
    static calculateRotationOrderSizes(availableFunds, totalGridAllocation, orderCount, orderType, config, minSize = 0, precision = null) {
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

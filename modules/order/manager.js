/**
 * OrderManager - Core grid-based order management system for DEXBot2
 * 
 * This module is responsible for:
 * - Creating and maintaining a virtual order grid across a price range
 * - Tracking order states (VIRTUAL -> ACTIVE -> FILLED)
 * - Synchronizing grid state with on-chain orders
 * - Managing funds allocation and commitment tracking
 * - Processing fills and rebalancing the grid
 * 
 * The order grid spans from minPrice to maxPrice with orders placed at
 * regular incrementPercent intervals. Orders near the market price form
 * the "spread" zone. When orders are filled, new orders are created on
 * the opposite side to maintain grid coverage.
 */
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS } = require('./constants');
const { parsePercentageString, blockchainToFloat, floatToBlockchainInt, resolveRelativePrice, calculatePriceTolerance, checkPriceWithinTolerance, parseChainOrder, findMatchingGridOrderByOpenOrder, findMatchingGridOrderByHistory, applyChainSizeToGridOrder, correctOrderPriceOnChain, getMinOrderSize } = require('./utils');
const Logger = require('./logger');
// Grid functions (initialize/recalculate) are intended to be
// called directly via require('./grid').initializeGrid(manager) by callers.

// Constants for manager operations are provided by modules/order/constants.js
// Size comparisons are performed by converting human-readable floats
// to blockchain integer amounts using floatToBlockchainInt(...) and
// comparing integers. This provides exact, deterministic behavior that
// matches on-chain granularity and avoids arbitrary tolerances.
// MIN_ORDER_SIZE_FACTOR and MIN_SPREAD_FACTOR moved to modules/order/constants.js
// and exposed via GRID_LIMITS (e.g. GRID_LIMITS.MIN_ORDER_SIZE_FACTOR)

/**
 * OrderManager class - manages grid-based trading strategy
 * 
 * Key concepts:
 * - Virtual orders: Grid positions not yet placed on-chain
 * - Active orders: Orders that exist on the blockchain
 * - Filled orders: Orders that have been fully executed
 * - Spread orders: Orders in the zone around market price
 * 
 * Funds tracking:
 * - available: Funds not yet committed to orders
 * - committed: Funds locked in active orders
 * - total: Starting balance for percentage calculations
 * 
 * Price tolerance:
 * - Chain orders may have slightly different prices due to integer rounding
 * - Tolerance is calculated based on asset precisions and order sizes
 * - Orders within tolerance are considered matching
 * 
 * @class
 */
class OrderManager {
    /**
     * Create a new OrderManager instance
     * @param {Object} config - Bot configuration
     * @param {string|number} config.marketPrice - Center price or 'pool'/'market' for auto-derive
     * @param {string|number} config.minPrice - Lower bound (number or '5x' relative)
     * @param {string|number} config.maxPrice - Upper bound (number or '5x' relative)
     * @param {number} config.incrementPercent - Price step between orders (e.g., 1 for 1%)
     * @param {number} config.targetSpreadPercent - Target spread width percentage
     * @param {Object} config.botFunds - Funds allocation { buy: amount/'%', sell: amount/'%' }
     * @param {Object} config.activeOrders - Max active orders { buy: n, sell: n }
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        this.logger = new Logger('info');
        this.logger.marketName = this.marketName;
        this.orders = new Map();
        // Indices for fast lookup by state and type (optimization)
        this._ordersByState = {
            [ORDER_STATES.VIRTUAL]: new Set(),
            [ORDER_STATES.ACTIVE]: new Set(),
            [ORDER_STATES.FILLED]: new Set()
        };
        this._ordersByType = {
            [ORDER_TYPES.BUY]: new Set(),
            [ORDER_TYPES.SELL]: new Set(),
            [ORDER_TYPES.SPREAD]: new Set()
        };
        this.resetFunds();
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = false;
        this.assets = null; // To be populated in initializeGrid
        // Promise that resolves when accountTotals (both buy & sell) are populated.
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        // Orders that need price correction on blockchain (orderId matched but price outside tolerance)
        this.ordersNeedingPriceCorrection = [];
        // Track recently rotated orderIds to prevent double-rotation (cleared after successful rotation)
        this._recentlyRotatedOrderIds = new Set();
    }

    // Helper: Resolve config value (percentage, number, or string)
    _resolveConfigValue(value, total) {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const p = parsePercentageString(value);
            if (p !== null) {
                if (total === null || total === undefined) {
                    this.logger?.log(`Cannot resolve percentage-based botFunds '${value}' because account total is not set. Attempting on-chain lookup (will default to 0 while fetching).`, 'warn');
                    // Kick off an async fetch of account balances if possible; do not block here.
                    if (!this._isFetchingTotals) {
                        this._isFetchingTotals = true;
                        this._fetchAccountBalancesAndSetTotals().finally(() => { this._isFetchingTotals = false; });
                    }
                    return 0;
                }
                return total * p;
            }
            const n = parseFloat(value);
            return Number.isNaN(n) ? 0 : n;
        }
        return 0;
    }

    // Helper: Adjust funds for order size changes
    _adjustFunds(type, delta) {
        if (!this.funds) this.resetFunds();
        const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';
        this.funds.committed[side] = Math.max(0, (this.funds.committed[side] || 0) + delta);
        this.funds.available[side] = Math.max(0, (this.funds.available[side] || 0) - delta);
    }

    // Helper: Update order in map and indices
    _updateOrder(order) {
        const existing = this.orders.get(order.id);
        if (existing) {
            // Remove from old indices
            this._ordersByState[existing.state]?.delete(order.id);
            this._ordersByType[existing.type]?.delete(order.id);
        }
        // Add to new indices
        this._ordersByState[order.state]?.add(order.id);
        this._ordersByType[order.type]?.add(order.id);
        this.orders.set(order.id, order);
    }

    // Note: findBestMatchByPrice is available from utils; callers should pass
    // a tolerance function that includes the manager's assets, for example:
    // utils.findBestMatchByPrice(chainOrder, candidates, this.orders, (p,s,t) => calculatePriceTolerance(p,s,t,this.assets))

    // NOTE: _calcTolerance shim removed — callers should call
    // calculatePriceTolerance(gridPrice, orderSize, orderType, this.assets)
    // or pass a small bound closure when a function is required by utils.

    // Reconcile funds totals based on config, input percentages, and prior committed balances.
    resetFunds() {
        this.accountTotals = this.accountTotals || (this.config.accountTotals ? { ...this.config.accountTotals } : { buy: null, sell: null });

        const buyTotal = (this.accountTotals && typeof this.accountTotals.buy === 'number') ? this.accountTotals.buy : (typeof this.config.botFunds.buy === 'number' ? this.config.botFunds.buy : null);
        const sellTotal = (this.accountTotals && typeof this.accountTotals.sell === 'number') ? this.accountTotals.sell : (typeof this.config.botFunds.sell === 'number' ? this.config.botFunds.sell : null);

        const availableBuy = this._resolveConfigValue(this.config.botFunds.buy, buyTotal);
        const availableSell = this._resolveConfigValue(this.config.botFunds.sell, sellTotal);

        this.funds = {
            available: { buy: availableBuy, sell: availableSell },
            committed: { buy: 0, sell: 0 },
            total: { buy: buyTotal || availableBuy, sell: sellTotal || availableSell }
        };
    }

    // Accept new on-chain totals and recalculate available funds.
    // Only updates available funds based on new totals while preserving committed tracking.
    setAccountTotals(totals = { buy: null, sell: null }) {
        this.accountTotals = { ...this.accountTotals, ...totals };
        
        const buyTotal = (this.accountTotals && typeof this.accountTotals.buy === 'number') ? this.accountTotals.buy : null;
        const sellTotal = (this.accountTotals && typeof this.accountTotals.sell === 'number') ? this.accountTotals.sell : null;

        const newAvailableBuy = this._resolveConfigValue(this.config.botFunds.buy, buyTotal);
        const newAvailableSell = this._resolveConfigValue(this.config.botFunds.sell, sellTotal);

        // Update available funds, accounting for already committed amounts
        if (this.funds) {
            this.funds.available.buy = Math.max(0, newAvailableBuy - this.funds.committed.buy);
            this.funds.available.sell = Math.max(0, newAvailableSell - this.funds.committed.sell);
            this.funds.total.buy = buyTotal || newAvailableBuy;
            this.funds.total.sell = sellTotal || newAvailableSell;
        } else {
            // First time initialization
            this.funds = {
                available: { buy: newAvailableBuy, sell: newAvailableSell },
                committed: { buy: 0, sell: 0 },
                total: { buy: buyTotal || newAvailableBuy, sell: sellTotal || newAvailableSell }
            };
        }

        // If someone is waiting for account totals, resolve the waiter once both values are available.
        const haveBuy = this.accountTotals && this.accountTotals.buy !== null && this.accountTotals.buy !== undefined && Number.isFinite(Number(this.accountTotals.buy));
        const haveSell = this.accountTotals && this.accountTotals.sell !== null && this.accountTotals.sell !== undefined && Number.isFinite(Number(this.accountTotals.sell));
        if (haveBuy && haveSell && typeof this._accountTotalsResolve === 'function') {
            try { this._accountTotalsResolve(); } catch (e) { /* ignore */ }
            this._accountTotalsPromise = null; this._accountTotalsResolve = null;
        }
    }

    // Wait until accountTotals have both buy and sell present, or until timeout elapses.
    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        const haveBuy = this.accountTotals && this.accountTotals.buy !== null && this.accountTotals.buy !== undefined && Number.isFinite(Number(this.accountTotals.buy));
        const haveSell = this.accountTotals && this.accountTotals.sell !== null && this.accountTotals.sell !== undefined && Number.isFinite(Number(this.accountTotals.sell));
        if (haveBuy && haveSell) return; // already satisfied

        if (!this._accountTotalsPromise) {
            this._accountTotalsPromise = new Promise((resolve) => { this._accountTotalsResolve = resolve; });
        }

        await Promise.race([
            this._accountTotalsPromise,
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
    }

    async _fetchAccountBalancesAndSetTotals() {
        // Attempt to read balances from the chain for configured account.
        try {
            const { BitShares } = require('../bitshares_client');
            if (!BitShares || !BitShares.db) return;

            // We need an account id or name to query
            const accountIdOrName = this.accountId || this.account || null;
            if (!accountIdOrName) return;

            // Ensure assets are initialized so we have ids/precisions
            try { await this._initializeAssets(); } catch (err) { /* best-effort */ }
            const assetAId = this.assets && this.assets.assetA && this.assets.assetA.id;
            const assetBId = this.assets && this.assets.assetB && this.assets.assetB.id;
            const precisionA = this.assets && this.assets.assetA && this.assets.assetA.precision;
            const precisionB = this.assets && this.assets.assetB && this.assets.assetB.precision;

            if (!assetAId || !assetBId) return;

            // Use centralized helper to fetch on-chain balances (free amounts only) for the two configured assets
            try {
                const { getOnChainAssetBalances } = require('../chain_orders');
                const lookup = await getOnChainAssetBalances(accountIdOrName, [assetAId, assetBId]);
                const aInfo = lookup && (lookup[assetAId] || lookup[this.config.assetA]);
                const bInfo = lookup && (lookup[assetBId] || lookup[this.config.assetB]);
                const sellTotal = aInfo && typeof aInfo.free === 'number' ? aInfo.free : null;
                const buyTotal = bInfo && typeof bInfo.free === 'number' ? bInfo.free : null;
                this.logger && this.logger.log && this.logger.log('Fetched on-chain balances for accountTotals (via helper)', 'info');
                this.setAccountTotals({ buy: buyTotal, sell: sellTotal });
            } catch (err) {
                // fall back to raw chain query in the unlikely event helper fails
                const full = await BitShares.db.get_full_accounts([accountIdOrName], false);
                if (!full || !Array.isArray(full) || !full[0]) return;
                const accountData = full[0][1];
                const balances = accountData && accountData.balances ? accountData.balances : [];

                const findBalanceInt = (assetId) => {
                    const b = balances.find(x => x.asset_type === assetId || x.asset_type === assetId.toString());
                    return b ? Number(b.balance || b.amount || 0) : 0;
                };

                const rawSell = findBalanceInt(assetAId);
                const rawBuy = findBalanceInt(assetBId);

                const buyTotal = Number.isFinite(Number(rawBuy)) ? blockchainToFloat(rawBuy, precisionB !== undefined ? precisionB : 8) : null;
                const sellTotal = Number.isFinite(Number(rawSell)) ? blockchainToFloat(rawSell, precisionA !== undefined ? precisionA : 8) : null;

                this.logger && this.logger.log && this.logger.log('Fetched on-chain balances for accountTotals (fallback raw)', 'info');
                this.setAccountTotals({ buy: buyTotal, sell: sellTotal });
            }
        } catch (err) {
            this.logger && this.logger.log && this.logger.log(`Failed to fetch on-chain balances: ${err && err.message ? err.message : err}`, 'warn');
        }
    }

    async _initializeAssets() {
        if (this.assets) return; // Already initialized
        try {
            const { lookupAsset } = require('./utils');
            const { BitShares } = require('../bitshares_client');
            this.assets = {
                assetA: await lookupAsset(BitShares, this.config.assetA),
                assetB: await lookupAsset(BitShares, this.config.assetB)
            };
            if (!this.assets.assetA || !this.assets.assetB) {
                throw new Error(`Could not resolve assets ${this.config.assetA}/${this.config.assetB}`);
            }
        } catch (err) {
            this.logger.log(`Asset metadata lookup failed: ${err.message}`, 'error');
            throw err;
        }
    }

    /**
     * Sync grid orders from fresh blockchain open orders after a fill event.
     * This is the preferred way to handle fills:
     * 1. Fetch current open orders from blockchain
     * 2. Match grid orders to chain orders by orderId
     * 3. Check if price difference is within tolerance (based on asset precision)
     * 4. If orderId matches but price outside tolerance, flag for correction
     * 5. If orderId not found but price matches, update orderId (never update price)
     * 6. Update sizes from blockchain for_sale values
     * 7. Mark orders as FILLED if they no longer exist on chain
     * 
     * @param {Array} chainOrders - Array of open orders from blockchain
     * @param {Object} fillInfo - Optional fill event info for logging (pays/receives amounts)
     * @returns {Object} - { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] }
     */
    syncFromOpenOrders(chainOrders, fillInfo = null) {
        if (!Array.isArray(chainOrders) || chainOrders.length === 0) {
            this.logger.log('syncFromOpenOrders: No valid chain orders provided', 'debug');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }
        
        this.logger.log(`syncFromOpenOrders: Processing ${chainOrders.length} open orders from blockchain`, 'info');
        // Cache asset precisions for hot paths
        const assetAPrecision = this.assets?.assetA?.precision;
        const assetBPrecision = this.assets?.assetB?.precision;
        
        // Parse all chain orders
        const parsedChainOrders = new Map();
        const rawChainOrders = new Map(); // Keep raw orders for correction
        for (const chainOrder of chainOrders) {
            const parsed = parseChainOrder(chainOrder, this.assets);
            if (parsed) {
                parsedChainOrders.set(parsed.orderId, parsed);
                rawChainOrders.set(parsed.orderId, chainOrder);
            }
        }
        
        const filledOrders = [];
        const updatedOrders = [];
        const ordersNeedingCorrection = [];
        const chainOrderIdsOnGrid = new Set();
        
        // Clear previous correction list
        this.ordersNeedingPriceCorrection = [];
        
        // First pass: Match by orderId and check price tolerance
        for (const gridOrder of this.orders.values()) {
            if (gridOrder.state !== ORDER_STATES.ACTIVE) continue;
            if (!gridOrder.orderId) continue;
            
            const chainOrder = parsedChainOrders.get(gridOrder.orderId);
            
            if (chainOrder) {
                // Order still exists on chain - check price tolerance
                const toleranceCheck = checkPriceWithinTolerance(gridOrder, chainOrder, this.assets);
                
                if (!toleranceCheck.isWithinTolerance) {
                    // Price difference exceeds tolerance - need to correct order on blockchain
                    this.logger.log(
                        `Order ${gridOrder.id} (${gridOrder.orderId}): PRICE MISMATCH - ` +
                        `grid=${toleranceCheck.gridPrice.toFixed(8)}, chain=${toleranceCheck.chainPrice.toFixed(8)}, ` +
                        `diff=${toleranceCheck.priceDiff.toFixed(8)}, tolerance=${toleranceCheck.tolerance.toFixed(8)}. ` +
                        `Flagging for correction.`, 
                        'warn'
                    );
                    
                    const correctionInfo = {
                        gridOrder: { ...gridOrder },
                        chainOrderId: gridOrder.orderId,
                        rawChainOrder: rawChainOrders.get(gridOrder.orderId),
                        expectedPrice: gridOrder.price,
                        actualPrice: chainOrder.price,
                        size: chainOrder.size || gridOrder.size,
                        type: gridOrder.type
                    };
                    ordersNeedingCorrection.push(correctionInfo);
                    this.ordersNeedingPriceCorrection.push(correctionInfo);
                    chainOrderIdsOnGrid.add(gridOrder.orderId);
                    // Don't update size yet - will be updated after correction
                    continue;
                }
                
                // Price within tolerance - update size if different
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                const oldSize = Number(gridOrder.size || 0);
                const newSize = Number(chainOrder.size || 0);
                
                // Compare using asset precision so we only treat on-chain-significant
                // size changes as different. Use the order-type to pick precision.
                const precision = (gridOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                // Use integer equality to detect chain-significant size changes
                const oldInt = floatToBlockchainInt(oldSize, precision);
                const newInt = floatToBlockchainInt(newSize, precision);
                if (oldInt !== newInt) {
                    const fillAmount = oldSize - newSize;
                    this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}): size changed ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (filled: ${fillAmount.toFixed(8)})`, 'info');
                    applyChainSizeToGridOrder(this, gridOrder, newSize);
                    updatedOrders.push(gridOrder);
                }
                this._updateOrder(gridOrder);
            } else {
                // Order no longer exists on chain - it was fully filled
                this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}) no longer on chain - marking as FILLED`, 'info');
                const filledOrder = { ...gridOrder };
                // Create new object to avoid mutation bug
                const updatedOrder = { ...gridOrder, state: ORDER_STATES.FILLED, size: 0 };
                this._updateOrder(updatedOrder);
                filledOrders.push(filledOrder);
            }
        }
        
        // Second pass: Check for chain orders that don't match any grid orderId but match by price
        // This handles cases where orders were recreated with new IDs
        for (const [chainOrderId, chainOrder] of parsedChainOrders) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue; // Already matched
            
            // Find a grid order that matches by type and price but has a stale/missing orderId
            // Use calculatePriceTolerance(...) which computes tolerance based on asset precisions and order sizes
            let bestMatch = null;
            let bestPriceDiff = Infinity;

            for (const gridOrder of this.orders.values()) {
                if (gridOrder.state !== ORDER_STATES.ACTIVE) continue;
                if (gridOrder.type !== chainOrder.type) continue;
                // Skip if this grid order's orderId is still valid on chain
                if (gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) continue;

                const priceDiff = Math.abs(gridOrder.price - chainOrder.price);

                // Prefer using the chain-reported size when available for a more accurate tolerance
                const orderSize = (chainOrder.size && Number.isFinite(Number(chainOrder.size))) ? Number(chainOrder.size) : (gridOrder.size && Number.isFinite(Number(gridOrder.size)) ? Number(gridOrder.size) : null);

                // Compute tolerance using the same formula used elsewhere in the manager
                let tolerance = null;
                            try {
                        if (orderSize !== null && orderSize > 0) {
                            tolerance = calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type, this.assets);
                        }
                } catch (e) {
                    tolerance = null;
                }

                // Ensure we have a usable tolerance from calculatePriceTolerance (it provides a fallback)
                    if (!tolerance || !Number.isFinite(tolerance)) {
                        tolerance = calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type, this.assets);
                    }

                if (priceDiff <= tolerance && priceDiff < bestPriceDiff) {
                    bestMatch = gridOrder;
                    bestPriceDiff = priceDiff;
                }
            }
            
            if (bestMatch) {
                this.logger.log(`Order ${bestMatch.id}: Updating orderId ${bestMatch.orderId} -> ${chainOrderId} (matched by price, diff=${bestPriceDiff.toFixed(8)})`, 'info');
                bestMatch.orderId = chainOrderId;
                // Update size from chain but NEVER update price
                const oldSize = Number(bestMatch.size || 0);
                const newSize = Number(chainOrder.size || 0);
                // Determine precision from the matching grid order (if available)
                const precision = (bestMatch && bestMatch.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const oldInt = floatToBlockchainInt(oldSize, precision);
                const newInt = floatToBlockchainInt(newSize, precision);
                if (oldInt !== newInt) {
                    applyChainSizeToGridOrder(this, bestMatch, newSize);
                }
                this._updateOrder(bestMatch);
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            } else {
                this.logger.log(`Chain order ${chainOrderId} (type=${chainOrder.type}, price=${chainOrder.price.toFixed(4)}) has no matching grid order`, 'warn');
            }
        }
        
        // Log fill info if provided
        if (fillInfo && fillInfo.pays && fillInfo.receives) {
            this.logger.log(`Fill event: pays ${fillInfo.pays.amount} (${fillInfo.pays.asset_id}), receives ${fillInfo.receives.amount} (${fillInfo.receives.asset_id})`, 'info');
        }
        
        // Log summary of orders needing correction
        if (ordersNeedingCorrection.length > 0) {
            this.logger.log(`${ordersNeedingCorrection.length} order(s) need price correction on blockchain`, 'warn');
        }
        
        return { filledOrders, updatedOrders, ordersNeedingCorrection };
    }

    /**
     * Process a fill event directly from history/subscription data.
     * Uses order_id from the fill event to match with orders in the grid.
     * This is the preferred method (faster, no extra API calls).
     * 
     * The fill event contains:
     * - order_id: The chain order ID that was filled (e.g., '1.7.12345')
     * - pays: { amount, asset_id } - What the maker paid out
     * - receives: { amount, asset_id } - What the maker received
     * - is_maker: boolean - Whether this account was the maker
     * 
     * @param {Object} fillOp - Fill operation data (fillEvent.op[1])
     * @returns {Object} - { filledOrders: [], updatedOrders: [], partialFill: boolean }
     */
    syncFromFillHistory(fillOp) {
        if (!fillOp || !fillOp.order_id) {
            this.logger.log('syncFromFillHistory: No valid fill operation provided', 'debug');
            return { filledOrders: [], updatedOrders: [], partialFill: false };
        }
        
        const orderId = fillOp.order_id;
        const paysAmount = fillOp.pays ? Number(fillOp.pays.amount) : 0;
        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
        const receivesAmount = fillOp.receives ? Number(fillOp.receives.amount) : 0;
        const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;
        
        this.logger.log(`syncFromFillHistory: Processing fill for order_id=${orderId}`, 'info');
        this.logger.log(`  Pays: ${paysAmount} (${paysAssetId}), Receives: ${receivesAmount} (${receivesAssetId})`, 'info');
        
        const filledOrders = [];
        const updatedOrders = [];
        let partialFill = false;
        
        // Find the grid order by orderId
        let matchedGridOrder = null;
        for (const gridOrder of this.orders.values()) {
            if (gridOrder.orderId === orderId && gridOrder.state === ORDER_STATES.ACTIVE) {
                matchedGridOrder = gridOrder;
                break;
            }
        }
        
        if (!matchedGridOrder) {
            this.logger.log(`syncFromFillHistory: No matching grid order found for order_id=${orderId}`, 'warn');
            return { filledOrders, updatedOrders, partialFill };
        }
        
        this.logger.log(`syncFromFillHistory: Matched order_id=${orderId} to grid order ${matchedGridOrder.id} (type=${matchedGridOrder.type})`, 'info');
        
        // Determine the fill amount based on order type and which asset was paid
        // For SELL orders: pays is assetA (what we're selling)
        // For BUY orders: pays is assetB (what we're selling to buy assetA)
        const orderType = matchedGridOrder.type;
        const currentSize = Number(matchedGridOrder.size || 0);
        
        // Get asset precisions for conversion
        const assetAPrecision = this.assets?.assetA?.precision || 5;
        const assetBPrecision = this.assets?.assetB?.precision || 5;
        const assetAId = this.assets?.assetA?.id;
        const assetBId = this.assets?.assetB?.id;
        
        // Calculate the filled amount in human-readable units
        let filledAmount = 0;
        if (orderType === ORDER_TYPES.SELL) {
            // SELL order: size is in assetA, pays is assetA
            if (paysAssetId === assetAId) {
                filledAmount = blockchainToFloat(paysAmount, assetAPrecision);
            }
        } else {
            // BUY order: size is in assetB, pays is assetB
            if (paysAssetId === assetBId) {
                filledAmount = blockchainToFloat(paysAmount, assetBPrecision);
            }
        }
        
        const newSize = Math.max(0, currentSize - filledAmount);
        
        this.logger.log(`syncFromFillHistory: Order ${matchedGridOrder.id} filled ${filledAmount.toFixed(8)}, size ${currentSize.toFixed(8)} -> ${newSize.toFixed(8)}`, 'info');
        
        // Check if fully filled or partially filled
        // Use blockchain integer comparison for precision
        const precision = (orderType === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
        const newSizeInt = floatToBlockchainInt(newSize, precision);
        
        if (newSizeInt <= 0) {
            // Fully filled
            this.logger.log(`syncFromFillHistory: Order ${matchedGridOrder.id} (${orderId}) FULLY FILLED`, 'info');
            const filledOrder = { ...matchedGridOrder };
            // Create new object to avoid mutation bug
            const updatedOrder = { ...matchedGridOrder, state: ORDER_STATES.FILLED, size: 0 };
            this._updateOrder(updatedOrder);
            filledOrders.push(filledOrder);
        } else {
            // Partially filled
            this.logger.log(`syncFromFillHistory: Order ${matchedGridOrder.id} (${orderId}) PARTIALLY FILLED, remaining=${newSize.toFixed(8)}`, 'info');
            applyChainSizeToGridOrder(this, matchedGridOrder, newSize);
            this._updateOrder(matchedGridOrder);
            updatedOrders.push(matchedGridOrder);
            partialFill = true;
        }
        
        return { filledOrders, updatedOrders, partialFill };
    }

    async synchronizeWithChain(chainData, source) {
        if (!this.assets) {
            this.logger.log('Asset metadata not available, cannot synchronize.', 'warn');
            return { newOrders: [], ordersNeedingCorrection: [] };
        }
        this.logger.log(`Syncing from ${source}`, 'info');
        // Cache asset precisions for hot paths
        const assetAPrecision = this.assets?.assetA?.precision;
        const assetBPrecision = this.assets?.assetB?.precision;
        let newOrders = [];
        // Reset the instance-level correction list for readOpenOrders case
        if (source === 'readOpenOrders') {
            this.ordersNeedingPriceCorrection = [];
        }
        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId } = chainData;
                const gridOrder = this.orders.get(gridOrderId);
                if (gridOrder) {
                    // Create a new object with updated state to avoid mutation bugs in _updateOrder
                    // (if we mutate in place, _updateOrder can't find the old state index to remove from)
                    const updatedOrder = { ...gridOrder, state: ORDER_STATES.ACTIVE, orderId: chainOrderId };
                    this._updateOrder(updatedOrder);
                    this.logger.log(`Order ${updatedOrder.id} activated with on-chain ID ${updatedOrder.orderId}`, 'info');
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: this.orders, ordersByState: this._ordersByState, assets: this.assets, calcToleranceFn: (p,s,t) => calculatePriceTolerance(p,s,t,this.assets), logger: this.logger });
                if (gridOrder) {
                    // Create a new object to avoid mutation bug
                    const updatedOrder = { ...gridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
                    this._updateOrder(updatedOrder);
                    this.logger.log(`Order ${updatedOrder.id} (${orderId}) cancelled and reverted to VIRTUAL`, 'info');
                }
                break;
            }
            case 'readOpenOrders': {
                const seenOnChain = new Set();
                for (const chainOrder of chainData) {
                    const parsedOrder = parseChainOrder(chainOrder, this.assets);
                    if (!parsedOrder) {
                        this.logger.log(`Could not parse chain order ${chainOrder.id}`, 'debug');
                        continue;
                    }
                    seenOnChain.add(parsedOrder.orderId);
                    const gridOrder = findMatchingGridOrderByOpenOrder(parsedOrder, { orders: this.orders, ordersByState: this._ordersByState, assets: this.assets, calcToleranceFn: (p,s,t) => calculatePriceTolerance(p,s,t,this.assets), logger: this.logger });
                    if (gridOrder) {
                        const wasActive = gridOrder.state === ORDER_STATES.ACTIVE;
                        const oldOrderId = gridOrder.orderId;
                        
                        // Build updated order object to avoid mutation bug
                        let updatedGridOrder = { ...gridOrder };
                        
                        // Always update the orderId from chain - it may have changed
                        if (gridOrder.orderId !== parsedOrder.orderId) {
                            this.logger.log(`Updating orderId for ${gridOrder.id}: ${oldOrderId} -> ${parsedOrder.orderId}`, 'info');
                            updatedGridOrder.orderId = parsedOrder.orderId;
                        }
                        
                        if (!wasActive) {
                            updatedGridOrder.state = ORDER_STATES.ACTIVE;
                            this.logger.log(`Order ${gridOrder.id} transitioned to ACTIVE with orderId ${updatedGridOrder.orderId}`, 'info');
                        }
                        
                        // Check price tolerance - if chain price differs too much, flag for correction
                        const toleranceCheck = checkPriceWithinTolerance(gridOrder, parsedOrder, this.assets);
                        
                        if (!toleranceCheck.isWithinTolerance) {
                            this.logger.log(
                                `Price mismatch ${gridOrder.id}: gridPrice=${toleranceCheck.gridPrice.toFixed(8)}, ` +
                                `chainPrice=${toleranceCheck.chainPrice.toFixed(8)}, diff=${toleranceCheck.priceDiff.toFixed(6)}, ` +
                                `maxTolerance=${toleranceCheck.tolerance.toFixed(6)} - flagging for correction`,
                                'warn'
                            );
                            this.ordersNeedingPriceCorrection.push({
                                gridOrder: updatedGridOrder,
                                chainOrderId: parsedOrder.orderId,
                                expectedPrice: gridOrder.price,
                                actualPrice: parsedOrder.price,
                                size: Number(gridOrder.size || parsedOrder.size || 0),
                                type: gridOrder.type
                            });
                        }
                        
                        // Reconcile sizes to avoid funds drift when on-chain size differs
                        if (parsedOrder.size !== null && parsedOrder.size !== undefined && Number.isFinite(Number(parsedOrder.size))) {
                            const gridSize = Number(gridOrder.size || 0);
                            const chainSize = Number(parsedOrder.size);
                            // Compare integers so we only log significant (on-chain) differences
                            const precision = (gridOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                            const gridInt = floatToBlockchainInt(gridSize, precision);
                            const chainInt = floatToBlockchainInt(chainSize, precision);
                            if (gridInt !== chainInt) {
                                this.logger.log(`Size sync ${gridOrder.id}: chain orderId=${parsedOrder.orderId}, chainPrice=${parsedOrder.price.toFixed(6)}, gridPrice=${gridOrder.price.toFixed(6)}, gridSize=${gridSize} -> chainSize=${chainSize}`, 'info');
                            }
                            try { applyChainSizeToGridOrder(this, updatedGridOrder, parsedOrder.size); } catch (e) { 
                                this.logger.log(`Error applying chain size to grid order: ${e.message}`, 'warn');
                            }
                        } else {
                            this.logger.log(`Chain order ${parsedOrder.orderId} has no valid size (for_sale)`, 'debug');
                        }
                        this._updateOrder(updatedGridOrder);
                    } else {
                        this.logger.log(`No matching grid order found for chain order ${parsedOrder.orderId} (type=${parsedOrder.type}, price=${parsedOrder.price.toFixed(4)})`, 'warn');
                    }
                }
                for (const gridOrder of this.orders.values()) {
                    if (gridOrder.state === ORDER_STATES.ACTIVE && !seenOnChain.has(gridOrder.orderId)) {
                        // Create new object to avoid mutation bug
                        const updatedOrder = { ...gridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
                        this.logger.log(`Active order ${gridOrder.id} (${gridOrder.orderId}) not on-chain, reverting to VIRTUAL`, 'warn');
                        this._updateOrder(updatedOrder);
                    }
                }
                
                // Log summary of orders needing correction
                if (this.ordersNeedingPriceCorrection.length > 0) {
                    this.logger.log(`${this.ordersNeedingPriceCorrection.length} order(s) need price correction on blockchain`, 'warn');
                }
                break;
            }
        }
        return { newOrders, ordersNeedingCorrection: this.ordersNeedingPriceCorrection };
    }

    /**
     * Get the initial set of orders to place on-chain.
     * Selects the closest virtual orders to market price,
     * respecting the configured activeOrders limits and
     * filtering out orders below minimum size.
     * 
     * Orders are sorted from outside-in for optimal placement:
     * - Sells: highest price first
     * - Buys: lowest price first
     * 
     * @returns {Array} Array of order objects to activate
     */
    getInitialOrdersToActivate() {
        const sellCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.sell ? this.config.activeOrders.sell : 1));
        const buyCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.buy ? this.config.activeOrders.buy : 1));
        
        // Get minimum order sizes for each type
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        // --- Sells ---
        const allVirtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualSells.sort((a, b) => a.price - b.price);
        // Take the block of orders that will become active
        const futureActiveSells = allVirtualSells.slice(0, sellCount);
        // Filter out orders below minimum size and log warnings
        const validSells = futureActiveSells.filter(order => {
            if (order.size < minSellSize) {
                this.logger.log(`Skipping sell order ${order.id}: size ${order.size.toFixed(8)} < minOrderSize ${minSellSize.toFixed(8)}`, 'warn');
                return false;
            }
            return true;
        });
        // Sort that block from the outside-in
        validSells.sort((a, b) => b.price - a.price);

        // --- Buys ---
        const allVirtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualBuys.sort((a, b) => b.price - a.price);
        // Take the block of orders that will become active
        const futureActiveBuys = allVirtualBuys.slice(0, buyCount);
        // Filter out orders below minimum size and log warnings
        const validBuys = futureActiveBuys.filter(order => {
            if (order.size < minBuySize) {
                this.logger.log(`Skipping buy order ${order.id}: size ${order.size.toFixed(8)} < minOrderSize ${minBuySize.toFixed(8)}`, 'warn');
                return false;
            }
            return true;
        });
        // Sort that block from the outside-in
        validBuys.sort((a, b) => a.price - b.price);
        
        if (validSells.length < futureActiveSells.length || validBuys.length < futureActiveBuys.length) {
            this.logger.log(`Filtered ${futureActiveSells.length - validSells.length} sell and ${futureActiveBuys.length - validBuys.length} buy orders below minimum size threshold`, 'info');
        }
        
        return [...validSells, ...validBuys];
    }

    /**
     * Filter tracked orders by type and/or state using optimized indices.
     * @param {string|null} type - ORDER_TYPES.BUY, SELL, or SPREAD (null for all)
     * @param {string|null} state - ORDER_STATES.VIRTUAL, ACTIVE, or FILLED (null for all)
     * @returns {Array} Filtered array of order objects
     */
    getOrdersByTypeAndState(type, state) { 
        let candidateIds;
        
        // Use indices for faster lookup when possible
        if (state !== null && type !== null) {
            // Intersection of both state and type indices
            const stateIds = this._ordersByState[state] || new Set();
            const typeIds = this._ordersByType[type] || new Set();
            candidateIds = [...stateIds].filter(id => typeIds.has(id));
            return candidateIds.map(id => this.orders.get(id)).filter(Boolean);
        } else if (state !== null) {
            // Use state index only
            candidateIds = this._ordersByState[state] || new Set();
            return [...candidateIds].map(id => this.orders.get(id)).filter(Boolean);
        } else if (type !== null) {
            // Use type index only
            candidateIds = this._ordersByType[type] || new Set();
            return [...candidateIds].map(id => this.orders.get(id)).filter(Boolean);
        } else {
            // No filtering, return all orders
            return Array.from(this.orders.values());
        }
    }

    // Periodically poll for fills and recalculate orders on demand.
    async fetchOrderUpdates(options = { calculate: false }) {
        try { const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE); if (activeOrders.length === 0 || (options && options.calculate)) { const { remaining, filled } = await this.calculateOrderUpdates(); remaining.forEach(order => this.orders.set(order.id, order)); if (filled.length > 0) await this.processFilledOrders(filled); this.checkSpreadCondition(); return { remaining, filled }; } return { remaining: activeOrders, filled: [] }; } catch (error) { this.logger.log(`Error fetching order updates: ${error.message}`, 'error'); return { remaining: [], filled: [] }; }
    }

    // Simulate fills by moving the closest active order to the FILLED state.
    async calculateOrderUpdates() { const marketPrice = this.config.marketPrice; const spreadRange = marketPrice * (this.config.targetSpreadPercent / 100); const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE); const activeSells = activeOrders.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => Math.abs(a.price - this.config.marketPrice) - Math.abs(b.price - this.config.marketPrice)); const activeBuys = activeOrders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => Math.abs(a.price - this.config.marketPrice) - Math.abs(b.price - this.config.marketPrice)); const filledOrders = []; if (activeSells.length > 0) filledOrders.push({ ...activeSells[0], state: ORDER_STATES.FILLED }); else if (activeBuys.length > 0) filledOrders.push({ ...activeBuys[0], state: ORDER_STATES.FILLED }); const remaining = activeOrders.filter(o => !filledOrders.some(f => f.id === o.id)); return { remaining, filled: filledOrders }; }

    // Flag whether the spread has widened beyond configured limits so we can rebalance.
    checkSpreadCondition() { const currentSpread = this.calculateCurrentSpread(); const targetSpread = this.config.targetSpreadPercent + this.config.incrementPercent; if (currentSpread > targetSpread) { this.outOfSpread = true; this.logger.log(`Spread too wide (${currentSpread.toFixed(2)}% > ${targetSpread}%), will add extra orders on next fill`, 'warn'); } else this.outOfSpread = false; }

    /**
     * Process filled orders and trigger rebalancing.
     * For each filled order:
     * 1. Updates funds (transfers proceeds to available pool)
     * 2. Converts the filled order to a spread placeholder
     * 3. Triggers creation of new orders on the opposite side
     * 
     * @param {Array} filledOrders - Array of orders that were filled
     * @param {Set} excludeOrderIds - Set of chain orderIds to exclude from rotation (e.g., just corrected)
     * @returns {Array} Newly activated orders that need on-chain placement
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) { 
        const filledCounts = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 }; 
        for (const filledOrder of filledOrders) { 
            filledCounts[filledOrder.type]++; 
            const updatedOrder = { ...filledOrder, state: ORDER_STATES.FILLED, size: 0 }; 
            this._updateOrder(updatedOrder); 
            if (filledOrder.type === ORDER_TYPES.SELL) { 
                const proceeds = filledOrder.size * filledOrder.price; 
                this.funds.available.buy += proceeds; 
                // Prevent negative committed by capping at 0
                const previousCommitted = this.funds.committed.sell;
                this.funds.committed.sell = Math.max(0, this.funds.committed.sell - filledOrder.size);
                if (previousCommitted < filledOrder.size) {
                    this.logger.log(`Warning: committed.sell (${previousCommitted.toFixed(8)}) was less than filled size (${filledOrder.size.toFixed(8)}). This may indicate a funds tracking issue.`, 'warn');
                }
                const quoteName = this.config.assetB || 'quote'; 
                const baseName = this.config.assetA || 'base'; 
                this.logger.log(`Sell filled: +${proceeds.toFixed(8)} ${quoteName}, -${filledOrder.size.toFixed(8)} ${baseName} committed`, 'info'); 
            } else { 
                const proceeds = filledOrder.size / filledOrder.price; 
                this.funds.available.sell += proceeds; 
                // Prevent negative committed by capping at 0
                const previousCommitted = this.funds.committed.buy;
                this.funds.committed.buy = Math.max(0, this.funds.committed.buy - filledOrder.size);
                if (previousCommitted < filledOrder.size) {
                    this.logger.log(`Warning: committed.buy (${previousCommitted.toFixed(8)}) was less than filled size (${filledOrder.size.toFixed(8)}). This may indicate a funds tracking issue.`, 'warn');
                }
                const quoteName = this.config.assetB || 'quote'; 
                const baseName = this.config.assetA || 'base'; 
                this.logger.log(`Buy filled: +${proceeds.toFixed(8)} ${baseName}, -${filledOrder.size.toFixed(8)} ${quoteName} committed`, 'info'); 
            } 
            await this.maybeConvertToSpread(filledOrder.id); 
        } 
        const extraOrderCount = this.outOfSpread ? 1 : 0; 
        if (this.outOfSpread) { 
            this.logger.log(`Adding extra order due to previous wide spread condition`, 'info'); 
            this.outOfSpread = false; 
        } 
        const newOrders = await this.rebalanceOrders(filledCounts, extraOrderCount, excludeOrderIds); 
        this.logger && this.logger.logFundsStatus && this.logger.logFundsStatus(this);
        return newOrders;
    }

    // Convert filled orders into spread placeholders so new ones can re-enter later.
    async maybeConvertToSpread(orderId) { 
        const order = this.orders.get(orderId); 
        if (!order || order.type === ORDER_TYPES.SPREAD) return; 
        const updatedOrder = { ...order, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL }; 
        this._updateOrder(updatedOrder); 
        this.currentSpreadCount++; 
        this.logger.log(`Converted order ${orderId} to SPREAD`, 'debug'); 
    }

    /**
     * Rebalance orders after fills using the "rotate furthest" strategy:
     * 
     * When a SELL fills:
     * 1. Activate closest VIRTUAL SELL to spread -> needs on-chain order placement
     * 2. Find furthest active BUY from spread -> cancel and recreate at new price (uses available funds)
     * 
     * When a BUY fills:
     * 1. Activate closest VIRTUAL BUY to spread -> needs on-chain order placement  
     * 2. Find furthest active SELL from spread -> cancel and recreate at new price (uses available funds)
     * 
     * Returns { ordersToPlace, ordersToRotate } for blockchain operations.
     * @param {Object} filledCounts - Count of filled orders by type { buy: n, sell: n }
     * @param {number} extraOrderCount - Extra orders to create (for spread widening)
     * @param {Set} excludeOrderIds - Set of chain orderIds to exclude from rotation
     * @returns {Object} { ordersToPlace: [], ordersToRotate: [] }
     */
    async rebalanceOrders(filledCounts, extraOrderCount = 0, excludeOrderIds = new Set()) { 
        const ordersToPlace = [];    // New orders to place on-chain (activated virtuals)
        const ordersToRotate = [];   // Orders to cancel and recreate at new price
        
        // When SELL orders fill: activate virtual sells (need on-chain) and rotate furthest buys
        if (filledCounts[ORDER_TYPES.SELL] > 0) { 
            const count = filledCounts[ORDER_TYPES.SELL] + extraOrderCount;
            
            // Step 1: Activate closest virtual SELL orders - these need on-chain placement
            const activatedSells = await this.activateClosestVirtualOrdersForPlacement(ORDER_TYPES.SELL, count);
            ordersToPlace.push(...activatedSells);
            this.logger.log(`Prepared ${activatedSells.length} virtual SELL orders for on-chain placement`, 'info');
            
            // Step 2: Find furthest active BUY orders and prepare them for rotation (cancel + recreate)
            if (this.funds.available.buy > 0) {
                const rotatedBuys = await this.prepareFurthestOrdersForRotation(ORDER_TYPES.BUY, count, excludeOrderIds);
                ordersToRotate.push(...rotatedBuys);
                
                if (rotatedBuys.length < count) {
                    this.logger.log(`Only prepared ${rotatedBuys.length}/${count} BUY orders for rotation`, 'warn');
                }
            } else {
                this.logger.log(`No available buy funds to rotate orders`, 'warn');
            }
        }
        
        // When BUY orders fill: activate virtual buys (need on-chain) and rotate furthest sells
        if (filledCounts[ORDER_TYPES.BUY] > 0) { 
            const count = filledCounts[ORDER_TYPES.BUY] + extraOrderCount;
            
            // Step 1: Activate closest virtual BUY orders - these need on-chain placement
            const activatedBuys = await this.activateClosestVirtualOrdersForPlacement(ORDER_TYPES.BUY, count);
            ordersToPlace.push(...activatedBuys);
            this.logger.log(`Prepared ${activatedBuys.length} virtual BUY orders for on-chain placement`, 'info');
            
            // Step 2: Find furthest active SELL orders and prepare them for rotation
            if (this.funds.available.sell > 0) {
                const rotatedSells = await this.prepareFurthestOrdersForRotation(ORDER_TYPES.SELL, count, excludeOrderIds);
                ordersToRotate.push(...rotatedSells);
                
                if (rotatedSells.length < count) {
                    this.logger.log(`Only prepared ${rotatedSells.length}/${count} SELL orders for rotation`, 'warn');
                }
            } else {
                this.logger.log(`No available sell funds to rotate orders`, 'warn');
            }
        }
        
        return { ordersToPlace, ordersToRotate };
    }

    /**
     * Activate the closest VIRTUAL orders for on-chain placement.
     * These orders will be placed as new limit orders on the blockchain.
     * Funds ARE committed here since these become real on-chain orders.
     * 
     * IMPORTANT: Only selects orders that are currently in VIRTUAL state.
     * Orders that are already ACTIVE (on-chain) are excluded.
     * 
     * @param {string} targetType - ORDER_TYPES.BUY or SELL
     * @param {number} count - Number of orders to activate
     * @returns {Array} Array of order objects ready for on-chain placement
     */
    async activateClosestVirtualOrdersForPlacement(targetType, count) {
        if (count <= 0) return [];
        
        // Only get orders that are truly VIRTUAL (not yet on-chain)
        const virtualOrders = this.getOrdersByTypeAndState(targetType, ORDER_STATES.VIRTUAL);
        
        // Debug: log what we found
        this.logger.log(`Found ${virtualOrders.length} VIRTUAL ${targetType} orders for activation`, 'debug');
        
        // Sort by distance to market price (closest first)
        // For BUY: highest price is closest to market (below market)
        // For SELL: lowest price is closest to market (above market)
        virtualOrders.sort((a, b) => 
            targetType === ORDER_TYPES.BUY 
                ? b.price - a.price  // Highest price first for buys
                : a.price - b.price  // Lowest price first for sells
        );
        
        const toActivate = virtualOrders.slice(0, count);
        const activated = [];
        
        // These orders inherit their grid position's size (already calculated)
        for (const order of toActivate) {
            // Double-check the order is still VIRTUAL (not already being processed)
            const currentOrder = this.orders.get(order.id);
            if (!currentOrder || currentOrder.state !== ORDER_STATES.VIRTUAL) {
                this.logger.log(`Order ${order.id} is no longer VIRTUAL (state=${currentOrder?.state}), skipping`, 'warn');
                continue;
            }
            
            const orderSize = order.size || 0;
            
            if (orderSize <= 0) {
                this.logger.log(`Skipping virtual ${targetType} at ${order.price.toFixed(4)} - no size defined`, 'warn');
                continue;
            }
            
            // Mark as ACTIVE and commit funds
            const activatedOrder = { ...order, state: ORDER_STATES.ACTIVE };
            this._updateOrder(activatedOrder);
            
            activated.push(activatedOrder);
            this.logger.log(`Prepared virtual ${targetType} ${order.id} at price ${order.price.toFixed(4)}, size ${orderSize.toFixed(8)} for on-chain placement`, 'info');
        }
        
        return activated;
    }

    /**
     * Find the furthest ACTIVE orders and prepare them for rotation.
     * Rotation means: cancel the old order, then update it to a new price from a SPREAD slot.
     * 
     * For BUY rotation (when SELL fills):
     *   - Furthest active BUY (lowest price) → becomes VIRTUAL
     *   - LOWEST SPREAD price → becomes the new BUY order
     * 
     * For SELL rotation (when BUY fills):
     *   - Furthest active SELL (highest price) → becomes VIRTUAL  
     *   - HIGHEST SPREAD price → becomes the new SELL order
     * 
     * @param {string} targetType - ORDER_TYPES.BUY or SELL (type of orders to rotate)
     * @param {number} count - Number of orders to rotate
     * @param {Set} excludeOrderIds - Set of chain orderIds to exclude (e.g., just corrected)
     * @returns {Array} Array of rotation objects { oldOrder, newPrice, newSize, newGridId }
     */
    async prepareFurthestOrdersForRotation(targetType, count, excludeOrderIds = new Set()) {
        if (count <= 0) return [];
        
        // Get orderIds that are pending price correction - exclude these from rotation
        const correctionOrderIds = new Set(
            (this.ordersNeedingPriceCorrection || []).map(c => c.chainOrderId).filter(Boolean)
        );
        
        // Also exclude recently rotated orders (prevents double-rotation from rapid fill events)
        const recentlyRotated = this._recentlyRotatedOrderIds || new Set();
        
        // Combine all exclusion sets
        const allExcluded = new Set([...correctionOrderIds, ...excludeOrderIds, ...recentlyRotated]);
        
        if (allExcluded.size > 0) {
            this.logger.log(`Excluding ${allExcluded.size} order(s) from rotation (corrected, pending, or recently rotated)`, 'debug');
        }
        
        const activeOrders = this.getOrdersByTypeAndState(targetType, ORDER_STATES.ACTIVE)
            .filter(o => !allExcluded.has(o.orderId)); // Exclude orders that were corrected, pending, or recently rotated
        
        // Sort by distance from market price (furthest first)
        // For BUY: lowest price is furthest from market
        // For SELL: highest price is furthest from market
        activeOrders.sort((a, b) => 
            targetType === ORDER_TYPES.BUY 
                ? a.price - b.price  // Lowest price first for buys (furthest from market)
                : b.price - a.price  // Highest price first for sells (furthest from market)
        );
        
        const ordersToProcess = activeOrders.slice(0, count);
        const rotations = [];
        
        const availableFunds = targetType === ORDER_TYPES.BUY 
            ? this.funds.available.buy 
            : this.funds.available.sell;
        
        if (availableFunds <= 0 || ordersToProcess.length === 0) {
            return [];
        }
        
        const minSize = getMinOrderSize(targetType, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const fundsPerOrder = availableFunds / Math.min(count, ordersToProcess.length);
        
        if (fundsPerOrder < minSize) {
            this.logger.log(`Insufficient funds per order for rotation: ${fundsPerOrder.toFixed(8)} < minSize ${minSize.toFixed(8)}`, 'warn');
            return [];
        }
        
        // Find new prices from SPREAD orders
        // For BUY rotation (when SELL fills): use LOWEST spread (closest to buy side)
        // For SELL rotation (when BUY fills): use HIGHEST spread (closest to sell side)
        // No market price filtering - spread orders are always in the middle zone
        const spreadOrders = this.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);
        const eligibleSpreadOrders = spreadOrders
            // Sort to get the right edge of spread zone:
            // For BUY: lowest price first (edge closest to buy orders)
            // For SELL: highest price first (edge closest to sell orders)
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);
        
        for (let i = 0; i < ordersToProcess.length && i < eligibleSpreadOrders.length; i++) {
            const oldOrder = ordersToProcess[i];
            const newPriceSource = eligibleSpreadOrders[i];
            
            // Create the rotation info
            const rotation = {
                oldOrder: {
                    id: oldOrder.id,
                    orderId: oldOrder.orderId,
                    type: oldOrder.type,
                    price: oldOrder.price,
                    size: oldOrder.size
                },
                newPrice: newPriceSource.price,
                newSize: fundsPerOrder,
                newGridId: newPriceSource.id,
                type: targetType
            };
            
            // Move funds from available to committed for the new order
            this._adjustFunds(targetType, fundsPerOrder);
            
            // Convert the spread to the target type (will become ACTIVE after chain confirm)
            const updatedOrder = { ...newPriceSource, type: targetType, size: fundsPerOrder, state: ORDER_STATES.VIRTUAL };
            this._updateOrder(updatedOrder);
            this.currentSpreadCount--;
            
            // Track this orderId as being rotated to prevent double-rotation
            if (oldOrder.orderId) {
                this._recentlyRotatedOrderIds.add(oldOrder.orderId);
            }
            
            rotations.push(rotation);
            this.logger.log(`Prepared ${targetType} rotation: old ${oldOrder.orderId} @ ${oldOrder.price.toFixed(4)} -> new spread @ ${newPriceSource.price.toFixed(4)}, size ${fundsPerOrder.toFixed(8)}`, 'info');
        }
        
        return rotations;
    }

    /**
     * Complete the order rotation after blockchain confirmation.
     * Marks the old order position as VIRTUAL (returns it to the grid).
     * The type (BUY/SELL) is preserved - only the state changes to VIRTUAL.
     * 
     * @param {Object} oldOrderInfo - Info about the old order { id, orderId, type, price, size }
     */
    completeOrderRotation(oldOrderInfo) {
        const order = this.orders.get(oldOrderInfo.id);
        if (order) {
            // Return the old order position to VIRTUAL state, keeping the same type and size.
            // The order keeps its original grid size so it can be re-activated later when price moves back.
            // No funds adjustment here - the old order's committed funds were already released when it was cancelled,
            // and the new order's funds were committed in prepareFurthestOrdersForRotation.
            const virtualOrder = { ...order, state: ORDER_STATES.VIRTUAL, orderId: null };
            this._updateOrder(virtualOrder);
            this.logger.log(`Rotated order ${oldOrderInfo.id} (${oldOrderInfo.type}) at price ${oldOrderInfo.price.toFixed(4)} -> VIRTUAL (size preserved: ${order.size?.toFixed(8) || 0})`, 'info');
            
            // Clear this orderId from recently rotated tracking (rotation complete)
            if (oldOrderInfo.orderId) {
                this._recentlyRotatedOrderIds.delete(oldOrderInfo.orderId);
            }
        }
    }

    /**
     * Activate spread placeholder orders as buy/sell orders.
     * Selects eligible spread orders closest to market price,
     * allocates funds evenly, and transitions them to ACTIVE state.
     * 
     * @param {string} targetType - ORDER_TYPES.BUY or SELL
     * @param {number} count - Number of orders to activate
     * @returns {Array} Array of newly activated order objects for on-chain placement
     */
    async activateSpreadOrders(targetType, count) {
        if (count <= 0) return 0;
        const allSpreadOrders = this.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);
        const spreadOrders = allSpreadOrders
            .filter(o => (targetType === ORDER_TYPES.BUY && o.price < this.config.marketPrice) || (targetType === ORDER_TYPES.SELL && o.price > this.config.marketPrice))
            // Selection rule:
            // - For BUY activation: choose the SPREAD entries with the lowest prices first (furthest from market below price)
            // - For SELL activation: choose the SPREAD entries with the highest prices first (furthest from market above price)
            // This ensures newly created buy orders use the lowest available spread price and sells use the highest.
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);
        const availableFunds = targetType === ORDER_TYPES.BUY ? this.funds.available.buy : this.funds.available.sell;
        if (availableFunds <= 0) { this.logger.log(`No available funds to create ${targetType} orders`, 'warn'); return []; }
        let desiredCount = Math.min(count, spreadOrders.length);
        if (desiredCount <= 0) {
            this.logger.log(`No SPREAD orders available for ${targetType} (total spreads: ${allSpreadOrders.length}, eligible at ${targetType === ORDER_TYPES.BUY ? 'below' : 'above'} market price ${this.config.marketPrice}: ${spreadOrders.length})`, 'warn');
            return [];
        }
        const minSize = getMinOrderSize(targetType, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const maxByFunds = minSize > 0 ? Math.floor(availableFunds / minSize) : desiredCount;
        const ordersToCreate = Math.max(0, Math.min(desiredCount, maxByFunds || desiredCount));
        if (ordersToCreate === 0) { this.logger.log(`Insufficient funds to create any ${targetType} orders (available=${availableFunds}, minOrderSize=${minSize})`, 'warn'); return []; }
        const actualOrders = spreadOrders.slice(0, ordersToCreate);
        const fundsPerOrder = availableFunds / actualOrders.length;
        if (fundsPerOrder < minSize) { this.logger.log(`Available funds insufficient for requested orders after adjustment: fundsPerOrder=${fundsPerOrder} < minOrderSize=${minSize}`, 'warn'); return []; }
        const activatedOrders = [];
        actualOrders.forEach(order => {
            if (fundsPerOrder <= 0) return;
            const activatedOrder = { ...order, type: targetType, size: fundsPerOrder, state: ORDER_STATES.ACTIVE };
            this._updateOrder(activatedOrder);
            activatedOrders.push(activatedOrder);
            this.currentSpreadCount--;
            this._adjustFunds(targetType, fundsPerOrder);
            this.logger.log(`Prepared ${targetType} order at ${order.price.toFixed(2)} (Amount: ${fundsPerOrder.toFixed(8)})`, 'info');
        });
        return activatedOrders;
    }

    /**
     * Calculate the current percentage spread between best bid and ask.
     * Uses active orders if available, falls back to virtual orders.
     * @returns {number} Spread percentage (e.g., 5.0 for 5%)
     */
    calculateCurrentSpread() {
        const activeBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        const virtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        const virtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        const pickBestBuy = () => { if (activeBuys.length) return Math.max(...activeBuys.map(o => o.price)); if (virtualBuys.length) return Math.max(...virtualBuys.map(o => o.price)); return null; };
        const pickBestSell = () => { if (activeSells.length) return Math.min(...activeSells.map(o => o.price)); if (virtualSells.length) return Math.min(...virtualSells.map(o => o.price)); return null; };
        const bestBuy = pickBestBuy(); const bestSell = pickBestSell(); if (bestBuy === null || bestSell === null || bestBuy === 0) return 0; return ((bestSell / bestBuy) - 1) * 100;
    }

    /**
     * Log a comprehensive status summary to the console.
     * Displays: market, funds, order counts, spread info.
     */
    // Full status display moved to Logger; use this.logger.displayStatus(this)
}

module.exports = { OrderManager };

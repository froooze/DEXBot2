const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('./constants');
const { parsePercentageString, blockchainToFloat, floatToBlockchainInt, resolveRelativePrice } = require('./utils');
const Logger = require('./logger');
const OrderGridGenerator = require('./order_grid');

// Constants for manager operations
const SYNC_DELAY_MS = 500;
const ACCOUNT_TOTALS_TIMEOUT_MS = 10000;
const EPSILON = 1e-10; // Tolerance for price and size comparisons
// Factor to multiply the smallest representable unit (based on asset precision)
// to determine the minimum order size. E.g., factor=50 with precision=4 => minSize=0.005
const MIN_ORDER_SIZE_FACTOR = 50;
// Minimum spread factor to multiply the configured incrementPercent when
// automatically adjusting targetSpreadPercent. E.g., a factor of 2 means
// targetSpreadPercent will be at least 2 * incrementPercent.
const MIN_SPREAD_FACTOR = 2;

// Core manager responsible for preparing, tracking, and updating the order grid in memory.
class OrderManager {
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
        this.assets = null; // To be populated in initializeOrderGrid
        // Promise that resolves when accountTotals (both buy & sell) are populated.
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        // Orders that need price correction on blockchain (orderId matched but price outside tolerance)
        this.ordersNeedingPriceCorrection = [];
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

    // Helper: Find best matching grid order by price tolerance
    _findBestMatchByPrice(chainOrder, candidates) {
        let bestMatch = null;
        let smallestDiff = Infinity;

        for (const gridOrderId of candidates) {
            const gridOrder = this.orders.get(gridOrderId);
            if (!gridOrder || gridOrder.type !== chainOrder.type) continue;
            
            const priceDiff = Math.abs(gridOrder.price - chainOrder.price);
            const orderSize = gridOrder.size || chainOrder.size || 0;
            const tolerance = this.calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type);
            
            if (priceDiff <= tolerance && priceDiff < smallestDiff) {
                smallestDiff = priceDiff;
                bestMatch = gridOrder;
            }
        }
        
        return { match: bestMatch, priceDiff: smallestDiff };
    }

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
    async waitForAccountTotals(timeoutMs = ACCOUNT_TOTALS_TIMEOUT_MS) {
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

            this.logger && this.logger.log && this.logger.log('Fetched on-chain balances for accountTotals', 'info');
            this.setAccountTotals({ buy: buyTotal, sell: sellTotal });
        } catch (err) {
            this.logger && this.logger.log && this.logger.log(`Failed to fetch on-chain balances: ${err && err.message ? err.message : err}`, 'warn');
        }
    }

    async _initializeAssets() {
        if (this.assets) return; // Already initialized
        try {
            const { lookupAsset } = require('./price');
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
     * Calculate the minimum order size for a given order type.
     * Uses minOrderSizeFactor * (smallest unit based on asset precision).
     * If the factor is disabled or the asset precision cannot be determined,
     * this function now returns 0 (no implicit fallback).
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {number} - Minimum order size in human-readable units (or 0 if unavailable)
     */
    getMinOrderSize(orderType) {
        const factor = Number(MIN_ORDER_SIZE_FACTOR);

        // If configured default factor is not set, zero, or invalid, return 0
        if (!factor || !Number.isFinite(factor) || factor <= 0) {
            return 0;
        }

        // Determine which asset's precision to use based on order type
        // SELL orders: size is in assetA (base)
        // BUY orders: size is in assetB (quote)
        let precision = null;
        if (this.assets) {
            if (orderType === ORDER_TYPES.SELL && this.assets.assetA) {
                precision = this.assets.assetA.precision;
            } else if (orderType === ORDER_TYPES.BUY && this.assets.assetB) {
                precision = this.assets.assetB.precision;
            }
        }

        // If we can't determine precision, return 0 (no implicit fallback)
        if (precision === null || precision === undefined || !Number.isFinite(precision)) {
            return 0;
        }

        // Calculate: factor * (10 ^ -precision)
        // E.g., factor=50, precision=4 => 50 * 0.0001 = 0.005
        const smallestUnit = Math.pow(10, -precision);
        const dynamicMin = Number(factor) * smallestUnit;

        return dynamicMin;
    }

    /**
     * Calculate the maximum allowable price difference between grid and blockchain
     * based on asset precisions and order size.
     * 
     * The tolerance is calculated as: (1/precisionA + 1/precisionB) / orderSize
     * This represents the minimum price change that could occur due to integer rounding
     * on the blockchain when converting float amounts to integer satoshis.
     * 
     * @param {number} gridPrice - The price in the grid (indexDB)
     * @param {number} orderSize - The order size
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {number} - Maximum allowable absolute price difference
     */
    calculatePriceTolerance(gridPrice, orderSize, orderType) {
        if (!this.assets || !gridPrice || !orderSize) {
            // Fallback to a reasonable default if assets not available
            return gridPrice * 0.001; // 0.1% tolerance as fallback
        }
        
        const precisionA = this.assets.assetA?.precision ?? 8;
        const precisionB = this.assets.assetB?.precision ?? 8;
        
        // Determine orderSizeA and orderSizeB based on order type
        // For BUY orders: size is in assetB (BTS) - we're selling BTS to buy XRP
        // For SELL orders: size is in assetA (XRP) - we're selling XRP to buy BTS
        let orderSizeA, orderSizeB;
        if (orderType === ORDER_TYPES.SELL) {
            // SELL: orderSize is in assetA (XRP)
            orderSizeA = orderSize;
            orderSizeB = orderSize * gridPrice;
        } else {
            // BUY: orderSize is in assetB (BTS)
            orderSizeB = orderSize;
            orderSizeA = orderSize / gridPrice;
        }
        
        // Tolerance formula: (1/(orderSizeA * 10^precisionA) + 1/(orderSizeB * 10^precisionB)) * price
        // Example for BUY: 73.88 BTS with price 1820 -> orderSizeA = 0.0406 XRP
        // termA = 1/(0.0406 * 10^4) = 1/406 = 0.00246
        // termB = 1/(73.88 * 10^5) = 1/7388000 = 0.000000135
        // tolerance = (0.00246 + 0.000000135) * 1820 ≈ 4.48
        const termA = 1 / (orderSizeA * Math.pow(10, precisionA));
        const termB = 1 / (orderSizeB * Math.pow(10, precisionB));
        const tolerance = (termA + termB) * gridPrice;
        
        return tolerance;
    }

    /**
     * Check if a chain order price is within acceptable tolerance of the grid order price.
     * @param {Object} gridOrder - The grid order from indexDB
     * @param {Object} chainOrder - The parsed chain order (with price, type, size)
     * @returns {Object} - { isWithinTolerance: boolean, priceDiff: number, tolerance: number }
     */
    checkPriceWithinTolerance(gridOrder, chainOrder) {
        const gridPrice = Number(gridOrder.price);
        const chainPrice = Number(chainOrder.price);
        const orderSize = Number(chainOrder.size || gridOrder.size || 0);
        
        const priceDiff = Math.abs(gridPrice - chainPrice);
        const tolerance = this.calculatePriceTolerance(gridPrice, orderSize, gridOrder.type);
        
        return {
            isWithinTolerance: priceDiff <= tolerance,
            priceDiff,
            tolerance,
            gridPrice,
            chainPrice,
            orderSize
        };
    }

    async initialize() {
        await this.initializeOrderGrid();
    }

    // Derive marketPrice when requested then build the virtual order grid.
    async initializeOrderGrid() {
        await this._initializeAssets();
        const mpRaw = this.config.marketPrice;
        const mpIsPool = typeof mpRaw === 'string' && mpRaw.trim().toLowerCase() === 'pool';
        const mpIsMarket = typeof mpRaw === 'string' && mpRaw.trim().toLowerCase() === 'market';

        if (!Number.isFinite(Number(mpRaw)) || mpIsPool || mpIsMarket) {
            try {
                const { derivePoolPrice, deriveMarketPrice } = require('./price');
                const { BitShares } = require('../bitshares_client');
                const symA = this.config.assetA;
                const symB = this.config.assetB;

                if ((mpIsPool || this.config.pool) && symA && symB) {
                    try {
                        const p = await derivePoolPrice(BitShares, symA, symB);
                        if (p !== null) this.config.marketPrice = p;
                    } catch (e) { this.logger && this.logger.log && this.logger.log(`Pool price lookup failed: ${e.message}`, 'warn'); }
                } else if ((mpIsMarket || this.config.market) && symA && symB) {
                    try {
                        const m = await deriveMarketPrice(BitShares, symA, symB);
                        if (m !== null) this.config.marketPrice = m;
                    } catch (e) { this.logger && this.logger.log && this.logger.log(`Market price lookup failed: ${e.message}`, 'warn'); }
                }

                try {
                    // final attempt to derive market price from on-chain orderbook/ticker
                    const m = await deriveMarketPrice(BitShares, symA, symB);
                    if (m !== null) { this.config.marketPrice = m; console.log('Derived marketPrice from on-chain', this.config.assetA + '/' + this.config.assetB, m); }
                } catch (e) { this.logger && this.logger.log && this.logger.log(`auto-derive marketPrice failed: ${e.message}`, 'warn'); }
            } catch (err) {
                this.logger && this.logger.log && this.logger.log(`auto-derive marketPrice failed: ${err.message}`, 'warn');
            }
        }

        const mp = Number(this.config.marketPrice);
        const fallbackMin = Number(DEFAULT_CONFIG.minPrice);
        const fallbackMax = Number(DEFAULT_CONFIG.maxPrice);
        const rawMin = this.config.minPrice !== undefined ? this.config.minPrice : DEFAULT_CONFIG.minPrice;
        const rawMax = this.config.maxPrice !== undefined ? this.config.maxPrice : DEFAULT_CONFIG.maxPrice;
        const minP = resolveConfiguredPriceBound(rawMin, fallbackMin, mp, 'min');
        const maxP = resolveConfiguredPriceBound(rawMax, fallbackMax, mp, 'max');
        this.config.minPrice = minP;
        this.config.maxPrice = maxP;
        if (!Number.isFinite(mp)) { throw new Error('Cannot initialize order grid: marketPrice is not a valid number'); }
        if (mp < minP || mp > maxP) { throw new Error(`Refusing to initialize order grid because marketPrice ${mp} is outside configured bounds [${minP}, ${maxP}]`); }

        // If botFunds are expressed as percentages and we have an account id/name
        // attempt a blocking on-chain fetch so percentages can be resolved before
        // building the order grid. This will wait up to 10s by default.
        try {
            const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                // If account totals are already present (possibly from a prior
                // non-blocking fetch), skip the blocking wait to avoid duplicate
                // fetches and logs.
                const haveBuy = this.accountTotals && this.accountTotals.buy !== null && this.accountTotals.buy !== undefined && Number.isFinite(Number(this.accountTotals.buy));
                const haveSell = this.accountTotals && this.accountTotals.sell !== null && this.accountTotals.sell !== undefined && Number.isFinite(Number(this.accountTotals.sell));
                if (haveBuy && haveSell) {
                    this.logger && this.logger.log && this.logger.log('Account totals already available; skipping blocking fetch.', 'debug');
                } else {
                    const timeoutMs = Number.isFinite(Number(this.config.waitForAccountTotalsMs)) ? Number(this.config.waitForAccountTotalsMs) : 10000;
                    this.logger && this.logger.log && this.logger.log(`Waiting up to ${timeoutMs}ms for on-chain account totals to resolve percentage-based botFunds...`, 'info');
                    try {
                        // Ensure a background fetch has been initiated (resetFunds() may have kicked one off earlier).
                        if (!this._isFetchingTotals) { this._isFetchingTotals = true; this._fetchAccountBalancesAndSetTotals().finally(() => { this._isFetchingTotals = false; }); }
                        await this.waitForAccountTotals(timeoutMs);
                        this.logger && this.logger.log && this.logger.log('Account totals fetch completed (or timed out).', 'info');
                    } catch (err) {
                        this.logger && this.logger.log && this.logger.log(`Account totals fetch failed: ${err && err.message ? err.message : err}`, 'warn');
                    }
                }
            }
        } catch (err) { /* don't let failures block grid creation */ }

        const { orders, initialSpreadCount } = OrderGridGenerator.createOrderGrid(this.config);
        // Determine per-side minimum order sizes (human units) when possible so
        // the grid generator can avoid allocating orders smaller than the minimum.
        const minSellSize = this.getMinOrderSize(ORDER_TYPES.SELL);
        const minBuySize = this.getMinOrderSize(ORDER_TYPES.BUY);

        // Diagnostic: log the min sizes and available funds before allocation
        const diagMsg = `Allocating sizes: sellFunds=${String(this.funds.available.sell)}, buyFunds=${String(this.funds.available.buy)}, ` +
            `minSellSize=${String(minSellSize)}, minBuySize=${String(minBuySize)}`;
        this.logger && this.logger.log && this.logger.log(diagMsg, 'debug');

        let sizedOrders = OrderGridGenerator.calculateOrderSizes(
            orders, this.config, this.funds.available.sell, this.funds.available.buy, minSellSize, minBuySize
        );

        // Safety check: if any allocated order is non-zero but below the
        // configured per-order minimum, abort startup to avoid placing
        // undersized on-chain orders. This is a deliberate fail-fast
        // behavior so callers are aware of insufficient funds/config.
        try {
            const sellsAfter = sizedOrders.filter(o => o.type === ORDER_TYPES.SELL).map(o => Number(o.size || 0));
            const buysAfter = sizedOrders.filter(o => o.type === ORDER_TYPES.BUY).map(o => Number(o.size || 0));
            // Treat zero-sized allocations as a failure condition as well.
            // Any non-finite size or any size strictly less than the per-order
            // minimum (including zero) will trigger abort.
            const anySellBelow = minSellSize > 0 && sellsAfter.some(sz => !Number.isFinite(sz) || sz < (minSellSize - 1e-12));
            const anyBuyBelow = minBuySize > 0 && buysAfter.some(sz => !Number.isFinite(sz) || sz < (minBuySize - 1e-12));
            if (anySellBelow || anyBuyBelow) {
                const parts = [];
                if (anySellBelow) parts.push(`sell.min=${String(minSellSize)}`);
                if (anyBuyBelow) parts.push(`buy.min=${String(minBuySize)}`);
                const msg = `Order grid contains orders below minimum size (${parts.join(', ')}). Aborting startup to avoid placing undersized orders.`;
                this.logger && this.logger.log && this.logger.log(msg, 'error');
                throw new Error(msg);
            }
        } catch (e) {
            // Ensure the error bubbles up to stop initialization/startup.
            throw e;
        }

        this.orders.clear();
        Object.values(this._ordersByState).forEach(set => set.clear());
        Object.values(this._ordersByType).forEach(set => set.clear());
        this.resetFunds();
        sizedOrders.forEach(order => { 
            this._updateOrder(order);
            if (order.type === ORDER_TYPES.BUY) { 
                this.funds.committed.buy += order.size; 
                this.funds.available.buy -= order.size; 
            } else if (order.type === ORDER_TYPES.SELL) { 
                this.funds.committed.sell += order.size; 
                this.funds.available.sell -= order.size; 
            } 
        });

        this.targetSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell; this.currentSpreadCount = this.targetSpreadCount;
        this.config.activeOrders = this.config.activeOrders || { buy: 1, sell: 1 };
        this.config.activeOrders.buy = Number.isFinite(Number(this.config.activeOrders.buy)) ? Number(this.config.activeOrders.buy) : 1;
        this.config.activeOrders.sell = Number.isFinite(Number(this.config.activeOrders.sell)) ? Number(this.config.activeOrders.sell) : 1;

        this.logger.log(`Initialized order grid with ${orders.length} orders`, 'info'); this.logger.log(`Configured activeOrders: buy=${this.config.activeOrders.buy}, sell=${this.config.activeOrders.sell}`, 'info');
        this.logFundsStatus(); this.logger.logOrderGrid(Array.from(this.orders.values()), this.config.marketPrice);
    }

    loadGrid(grid) {
        if (!grid || !Array.isArray(grid)) return;
        this.orders.clear();
        // Clear indices
        Object.values(this._ordersByState).forEach(set => set.clear());
        Object.values(this._ordersByType).forEach(set => set.clear());
        this.resetFunds();
        grid.forEach(order => {
            this._updateOrder(order);
            if (order.state === 'active') {
                if (order.type === ORDER_TYPES.BUY) {
                    this.funds.committed.buy += order.size;
                    this.funds.available.buy -= order.size;
                } else if (order.type === ORDER_TYPES.SELL) {
                    this.funds.committed.sell += order.size;
                    this.funds.available.sell -= order.size;
                }
            }
        });
        this.logger.log(`Loaded ${this.orders.size} orders from persisted grid state.`, 'info');
        this.logFundsStatus();
    }



    _parseChainOrder(chainOrder) {
        if (!chainOrder || !chainOrder.sell_price || !this.assets) return null;
        const { base, quote } = chainOrder.sell_price;
        if (!base || !quote || !base.asset_id || !quote.asset_id || base.amount == 0) return null;
        let price;
        let type;
        if (base.asset_id === this.assets.assetA.id && quote.asset_id === this.assets.assetB.id) {
            // SELL order: selling assetA (base) to receive assetB (quote)
            // Price = quote/base in human units = (quote_satoshis/quote_precision) / (base_satoshis/base_precision)
            //       = (quote/base) * 10^(base_precision - quote_precision)
            price = (quote.amount / base.amount) * Math.pow(10, this.assets.assetA.precision - this.assets.assetB.precision);
            type = ORDER_TYPES.SELL;
        } else if (base.asset_id === this.assets.assetB.id && quote.asset_id === this.assets.assetA.id) {
            // BUY order: selling assetB (base) to receive assetA (quote)
            // Price in BTS/XRP = base_human / quote_human = (base_satoshis/base_precision) / (quote_satoshis/quote_precision)
            //       = (base/quote) * 10^(quote_precision - base_precision)
            price = (base.amount / quote.amount) * Math.pow(10, this.assets.assetA.precision - this.assets.assetB.precision);
            type = ORDER_TYPES.BUY;
        } else {
            return null;
        }
        // Attempt to capture the remaining on-chain size (for_sale) and
        // convert it back to human units using asset precision. The meaning
        // of `for_sale` depends on which asset is the base in sell_price.
        let size = null;
        try {
            if (chainOrder.for_sale !== undefined && chainOrder.for_sale !== null) {
                if (type === ORDER_TYPES.SELL) {
                    // SELL: base is assetA and `for_sale` is amount of assetA remaining
                    const prec = this.assets.assetA && this.assets.assetA.precision !== undefined ? this.assets.assetA.precision : 0;
                    size = blockchainToFloat(Number(chainOrder.for_sale), prec);
                } else if (type === ORDER_TYPES.BUY) {
                    // BUY: base is assetB and `for_sale` is amount of assetB remaining
                    const prec = this.assets.assetB && this.assets.assetB.precision !== undefined ? this.assets.assetB.precision : 0;
                    size = blockchainToFloat(Number(chainOrder.for_sale), prec);
                }
            }
        } catch (e) {
            size = null; // best-effort: if conversion fails, ignore size
        }

        return { orderId: chainOrder.id, price: price, type: type, size };
    }

    // Apply an on-chain reported size to a tracked grid order and reconcile
    // funds (committed / available) to avoid drift. `chainSize` is a human
    // float representing remaining amount to sell for that order.
    _applyChainSizeToGridOrder(gridOrder, chainSize) {
        if (!gridOrder) return;
        // Only apply chain-reported sizes to orders that are ACTIVE.
        // Virtual/spread placeholders should keep their configured sizes
        // until they are explicitly activated; callers that activate an
        // order set `state = ORDER_STATES.ACTIVE` before calling this.
        if (gridOrder.state !== ORDER_STATES.ACTIVE) {
            this.logger && this.logger.log && this.logger.log(`Skipping chain size apply for non-ACTIVE order ${gridOrder.id} (state=${gridOrder.state})`, 'debug');
            return;
        }
        const oldSize = Number(gridOrder.size || 0);
        const newSize = Number.isFinite(Number(chainSize)) ? Number(chainSize) : oldSize;
        const delta = newSize - oldSize;
        if (Math.abs(delta) < EPSILON) {
            gridOrder.size = newSize; // still ensure normalized numeric
            return;
        }

        // Log size adjustment for debugging
        this.logger.log(`Order ${gridOrder.id} size adjustment: ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (delta: ${delta.toFixed(8)})`, 'info');

        this._adjustFunds(gridOrder.type, delta);
        gridOrder.size = newSize;
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
        
        // Parse all chain orders
        const parsedChainOrders = new Map();
        const rawChainOrders = new Map(); // Keep raw orders for correction
        for (const chainOrder of chainOrders) {
            const parsed = this._parseChainOrder(chainOrder);
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
                const toleranceCheck = this.checkPriceWithinTolerance(gridOrder, chainOrder);
                
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
                
                if (Math.abs(oldSize - newSize) > EPSILON) {
                    const fillAmount = oldSize - newSize;
                    this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}): size changed ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (filled: ${fillAmount.toFixed(8)})`, 'info');
                    this._applyChainSizeToGridOrder(gridOrder, newSize);
                    updatedOrders.push(gridOrder);
                }
                this._updateOrder(gridOrder);
            } else {
                // Order no longer exists on chain - it was fully filled
                this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}) no longer on chain - marking as FILLED`, 'info');
                const filledOrder = { ...gridOrder };
                gridOrder.state = ORDER_STATES.FILLED;
                gridOrder.size = 0;
                this._updateOrder(gridOrder);
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
                        tolerance = this.calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type);
                    }
                } catch (e) {
                    tolerance = null;
                }

                // Ensure we have a usable tolerance from calculatePriceTolerance (it provides a fallback)
                if (!tolerance || !Number.isFinite(tolerance)) {
                    tolerance = this.calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type);
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
                if (Math.abs(oldSize - newSize) > EPSILON) {
                    this._applyChainSizeToGridOrder(bestMatch, newSize);
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
     * Correct an order on the blockchain to match the grid price.
     * This uses limit_order_update to change the price without canceling.
     * The orderId remains the same after the update.
     * 
     * Since BitShares stores orders as amount_to_sell and min_to_receive,
     * we calculate the new min_to_receive based on the grid price and current size.
     * 
     * @param {Object} correctionInfo - Info about the order to correct
     * @param {string} accountName - Account name for signing
     * @param {string} privateKey - Private key for signing
     * @param {Object} accountOrders - Module with updateOrder function
     * @returns {Object} - { success: boolean, error: string|null }
     */
    async correctOrderPriceOnChain(correctionInfo, accountName, privateKey, accountOrders) {
        const { gridOrder, chainOrderId, expectedPrice, size, type } = correctionInfo;
        
        this.logger.log(`Correcting order ${gridOrder.id} (${chainOrderId}): updating to price ${expectedPrice.toFixed(8)}`, 'info');
        
        try {
            // Calculate new amounts based on the grid price
            // For SELL orders: we sell assetA to receive assetB, so minToReceive = size * price
            // For BUY orders: we sell assetB to receive assetA, so minToReceive = size / price (size is in assetB)
            let amountToSell, minToReceive;
            
            if (type === ORDER_TYPES.SELL) {
                // Selling assetA for assetB at price (assetB per assetA)
                amountToSell = size;
                minToReceive = size * expectedPrice;
            } else {
                // Buying assetA with assetB at price (assetB per assetA)
                // size is the amount of assetB we're selling
                amountToSell = size;
                minToReceive = size / expectedPrice;
            }
            
            this.logger.log(`Updating order: amountToSell=${amountToSell.toFixed(8)}, minToReceive=${minToReceive.toFixed(8)}`, 'info');
            
            // Use limit_order_update to change the amounts (which changes the effective price)
            const updateResult = await accountOrders.updateOrder(accountName, privateKey, chainOrderId, {
                amountToSell,
                minToReceive
            });

            // accountOrders.updateOrder returns `null` when there is no change (delta === 0)
            // In that case we should treat the correction as skipped rather than successful.
            if (updateResult === null) {
                this.logger.log(`Order ${gridOrder.id} (${chainOrderId}) price correction skipped (no change to amount_to_sell)`, 'info');
                return { success: false, error: 'No change to amount_to_sell (delta=0) - update skipped' };
            }

            this.logger.log(`Order ${gridOrder.id} (${chainOrderId}) price corrected to ${expectedPrice.toFixed(8)}`, 'info');
            
            // Remove from correction list
            this.ordersNeedingPriceCorrection = this.ordersNeedingPriceCorrection.filter(
                c => c.chainOrderId !== chainOrderId
            );
            
            return { success: true, error: null };
            
        } catch (error) {
            this.logger.log(`Failed to correct order ${gridOrder.id}: ${error.message}`, 'error');
            return { success: false, error: error.message };
        }
    }

    /**
     * Correct all orders that have price mismatches.
     * @param {string} accountName - Account name for signing
     * @param {string} privateKey - Private key for signing  
     * @param {Object} accountOrders - Module with createOrder/cancelOrder functions
     * @returns {Object} - { corrected: number, failed: number, results: Array }
     */
    async correctAllPriceMismatches(accountName, privateKey, accountOrders) {
        const results = [];
        let corrected = 0;
        let failed = 0;
        
        // Make a copy since we modify the list during iteration
        const ordersToCorrect = [...this.ordersNeedingPriceCorrection];
        
        for (const correctionInfo of ordersToCorrect) {
            const result = await this.correctOrderPriceOnChain(
                correctionInfo, accountName, privateKey, accountOrders
            );
            results.push({ ...correctionInfo, result });
            
            if (result.success) {
                corrected++;
            } else {
                failed++;
            }
            
            // Small delay between corrections to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, SYNC_DELAY_MS));
        }
        
        this.logger.log(`Price correction complete: ${corrected} corrected, ${failed} failed`, 'info');
        return { corrected, failed, results };
    }

    _findMatchingGridOrder(parsedChainOrder) {
        // First try exact orderId match - this is the most reliable
        if (parsedChainOrder.orderId) {
            for (const gridOrder of this.orders.values()) {
                if (gridOrder.orderId === parsedChainOrder.orderId) {
                    this.logger.log(`_findMatchingGridOrder: MATCHED ${parsedChainOrder.orderId} -> ${gridOrder.id} by orderId`, 'info');
                    return gridOrder;
                }
            }
            // Log that orderId was not found in any grid order
            this.logger.log(`_findMatchingGridOrder: orderId ${parsedChainOrder.orderId} NOT found in grid, falling back to price matching (chain price=${parsedChainOrder.price?.toFixed(6)}, type=${parsedChainOrder.type})`, 'info');
        }
        
        // If no orderId match, try matching VIRTUAL orders by price (use indices for optimization)
        const virtualOrderIds = this._ordersByState[ORDER_STATES.VIRTUAL];
        for (const gridOrderId of virtualOrderIds) {
            const gridOrder = this.orders.get(gridOrderId);
            if (gridOrder && !gridOrder.orderId) {
                const priceDiff = Math.abs(gridOrder.price - parsedChainOrder.price);
                const orderSize = (gridOrder.size && Number.isFinite(Number(gridOrder.size))) ? Number(gridOrder.size) : null;
                const tolerance = this.calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type);
                if (gridOrder.type === parsedChainOrder.type && priceDiff <= tolerance) {
                    this.logger.log(`_findMatchingGridOrder: matched ${parsedChainOrder.orderId} to VIRTUAL grid order ${gridOrder.id} by price`, 'debug');
                    return gridOrder;
                }
            }
        }

        // For ACTIVE orders, find the CLOSEST price match that is within tolerance (use indices)
        if (parsedChainOrder.price !== undefined && parsedChainOrder.type) {
            const activeOrderIds = this._ordersByState[ORDER_STATES.ACTIVE];
            const result = this._findBestMatchByPrice(parsedChainOrder, activeOrderIds);

            if (result.match) {
                this.logger.log(`_findMatchingGridOrder: matched ${parsedChainOrder.orderId} to ACTIVE grid order ${result.match.id} by closest price (diff=${result.priceDiff.toExponential(4)}, old orderId: ${result.match.orderId})`, 'debug');
                return result.match;
            }
        }
        
        return null;
    }

    // Match a fill operation to a grid order - prefer order_id matching, fallback to price/assets
    _findMatchingGridOrderByFill(fillOp) {
        // First try to match by order_id if available (most reliable)
        if (fillOp.order_id) {
            for (const gridOrder of this.orders.values()) {
                if (gridOrder.orderId === fillOp.order_id) {
                    this.logger.log(`_findMatchingGridOrderByFill: MATCHED fill to ${gridOrder.id} by order_id ${fillOp.order_id}`, 'info');
                    return gridOrder;
                }
            }
            this.logger.log(`_findMatchingGridOrderByFill: order_id ${fillOp.order_id} not found in grid, trying price match`, 'info');
        }
        
        // Fallback to price/asset matching
        if (!fillOp.pays || !fillOp.receives || !this.assets) {
            return null;
        }
        
        const paysAssetId = String(fillOp.pays.asset_id);
        const receivesAssetId = String(fillOp.receives.asset_id);
        const assetAId = String(this.assets.assetA?.id || '');
        const assetBId = String(this.assets.assetB?.id || '');
        
        // Determine order type from assets:
        // SELL order: pays assetA (base), receives assetB (quote)
        // BUY order: pays assetB (quote), receives assetA (base)
        let fillType = null;
        let fillPrice = null;
        
        if (paysAssetId === assetAId && receivesAssetId === assetBId) {
            // This is a SELL fill (paying base, receiving quote)
            fillType = ORDER_TYPES.SELL;
            const paysAmount = blockchainToFloat(Number(fillOp.pays.amount), this.assets.assetA?.precision || 0);
            const receivesAmount = blockchainToFloat(Number(fillOp.receives.amount), this.assets.assetB?.precision || 0);
            if (paysAmount > 0) {
                fillPrice = receivesAmount / paysAmount;  // price = quote/base
            }
        } else if (paysAssetId === assetBId && receivesAssetId === assetAId) {
            // This is a BUY fill (paying quote, receiving base)
            fillType = ORDER_TYPES.BUY;
            const paysAmount = blockchainToFloat(Number(fillOp.pays.amount), this.assets.assetB?.precision || 0);
            const receivesAmount = blockchainToFloat(Number(fillOp.receives.amount), this.assets.assetA?.precision || 0);
            if (receivesAmount > 0) {
                fillPrice = paysAmount / receivesAmount;  // price = quote/base
            }
        } else {
            // Assets don't match our market
            this.logger.log(`Fill assets (${paysAssetId}/${receivesAssetId}) don't match market (${assetAId}/${assetBId})`, 'debug');
            return null;
        }
        
        if (!fillType || !Number.isFinite(fillPrice)) {
            this.logger.log(`Could not determine fill type or price`, 'debug');
            return null;
        }
        
        this.logger.log(`Fill analysis: type=${fillType}, price=${fillPrice.toFixed(4)}`, 'debug');
        
        // Find matching ACTIVE order by type and price using indices
        const activeOrderIds = this._ordersByState[ORDER_STATES.ACTIVE];
        const result = this._findBestMatchByPrice({ type: fillType, price: fillPrice }, activeOrderIds);
        const bestMatch = result.match;
        const bestPriceDiff = result.priceDiff;
        
        if (bestMatch) {
            this.logger.log(`_findMatchingGridOrderByFill: MATCHED fill to ${bestMatch.id} by PRICE (fillPrice=${fillPrice.toFixed(4)}, gridPrice=${bestMatch.price.toFixed(4)}, diff=${bestPriceDiff.toFixed(8)})`, 'info');
        } else {
            this.logger.log(`_findMatchingGridOrderByFill: NO MATCH found for fill (type=${fillType}, price=${fillPrice?.toFixed(4)})`, 'warn');
        }
        
        return bestMatch;
    }

    async synchronizeWithChain(chainData, source) {
        if (!this.assets) {
            this.logger.log('Asset metadata not available, cannot synchronize.', 'warn');
            return { newOrders: [], ordersNeedingCorrection: [] };
        }
        this.logger.log(`Syncing from ${source}`, 'info');
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
                    gridOrder.state = ORDER_STATES.ACTIVE;
                    gridOrder.orderId = chainOrderId;
                    this._updateOrder(gridOrder);
                    this.logger.log(`Order ${gridOrder.id} activated with on-chain ID ${gridOrder.orderId}`, 'info');
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                const gridOrder = this._findMatchingGridOrder({ orderId });
                if (gridOrder) {
                    gridOrder.state = ORDER_STATES.VIRTUAL;
                    gridOrder.orderId = null;
                    this._updateOrder(gridOrder);
                    this.logger.log(`Order ${gridOrder.id} (${orderId}) cancelled and reverted to VIRTUAL`, 'info');
                }
                break;
            }
            case 'readOpenOrders': {
                const seenOnChain = new Set();
                for (const chainOrder of chainData) {
                    const parsedOrder = this._parseChainOrder(chainOrder);
                    if (!parsedOrder) {
                        this.logger.log(`Could not parse chain order ${chainOrder.id}`, 'debug');
                        continue;
                    }
                    seenOnChain.add(parsedOrder.orderId);
                    const gridOrder = this._findMatchingGridOrder(parsedOrder);
                    if (gridOrder) {
                        const wasActive = gridOrder.state === ORDER_STATES.ACTIVE;
                        const oldOrderId = gridOrder.orderId;
                        
                        // Always update the orderId from chain - it may have changed
                        if (gridOrder.orderId !== parsedOrder.orderId) {
                            this.logger.log(`Updating orderId for ${gridOrder.id}: ${oldOrderId} -> ${parsedOrder.orderId}`, 'info');
                            gridOrder.orderId = parsedOrder.orderId;
                        }
                        
                        if (!wasActive) {
                            gridOrder.state = ORDER_STATES.ACTIVE;
                            this.logger.log(`Order ${gridOrder.id} transitioned to ACTIVE with orderId ${gridOrder.orderId}`, 'info');
                        }
                        
                        // Check price tolerance - if chain price differs too much, flag for correction
                        const toleranceCheck = this.checkPriceWithinTolerance(gridOrder, parsedOrder);
                        
                        if (!toleranceCheck.isWithinTolerance) {
                            this.logger.log(
                                `Price mismatch ${gridOrder.id}: gridPrice=${toleranceCheck.gridPrice.toFixed(8)}, ` +
                                `chainPrice=${toleranceCheck.chainPrice.toFixed(8)}, diff=${toleranceCheck.priceDiff.toFixed(6)}, ` +
                                `maxTolerance=${toleranceCheck.tolerance.toFixed(6)} - flagging for correction`,
                                'warn'
                            );
                            this.ordersNeedingPriceCorrection.push({
                                gridOrder,
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
                            if (Math.abs(gridSize - chainSize) > 1e-10) {
                                this.logger.log(`Size sync ${gridOrder.id}: chain orderId=${parsedOrder.orderId}, chainPrice=${parsedOrder.price.toFixed(6)}, gridPrice=${gridOrder.price.toFixed(6)}, gridSize=${gridSize} -> chainSize=${chainSize}`, 'info');
                            }
                            try { this._applyChainSizeToGridOrder(gridOrder, parsedOrder.size); } catch (e) { 
                                this.logger.log(`Error applying chain size to grid order: ${e.message}`, 'warn');
                            }
                        } else {
                            this.logger.log(`Chain order ${parsedOrder.orderId} has no valid size (for_sale)`, 'debug');
                        }
                        this._updateOrder(gridOrder);
                    } else {
                        this.logger.log(`No matching grid order found for chain order ${parsedOrder.orderId} (type=${parsedOrder.type}, price=${parsedOrder.price.toFixed(4)})`, 'warn');
                    }
                }
                for (const gridOrder of this.orders.values()) {
                    if (gridOrder.state === ORDER_STATES.ACTIVE && !seenOnChain.has(gridOrder.orderId)) {
                        gridOrder.state = ORDER_STATES.VIRTUAL;
                        this.logger.log(`Active order ${gridOrder.id} (${gridOrder.orderId}) not on-chain, reverting to VIRTUAL`, 'warn');
                        gridOrder.orderId = null;
                        this._updateOrder(gridOrder);
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

    async resyncGridFromChain(readOpenOrdersFn, cancelOrderFn) {
        this.logger.log('Starting full grid resynchronization from blockchain...', 'info');
        await this.initializeOrderGrid();
        this.logger.log('Virtual grid has been regenerated.', 'debug');
        const chainOrders = await readOpenOrdersFn();
        if (!Array.isArray(chainOrders)) {
            this.logger.log('Could not fetch open orders for resync.', 'error');
            return;
        }
        this.logger.log(`Found ${chainOrders.length} open orders on-chain.`, 'info');
        const matchedChainOrderIds = new Set();
        for (const gridOrder of this.orders.values()) {
            let bestMatch = null;
            let smallestDiff = Infinity;
            for (const chainOrder of chainOrders) {
                if (matchedChainOrderIds.has(chainOrder.id)) continue;
                const parsedChainOrder = this._parseChainOrder(chainOrder);
                if (!parsedChainOrder || parsedChainOrder.type !== gridOrder.type) continue;
                const priceDiff = Math.abs(parsedChainOrder.price - gridOrder.price);
                if (priceDiff < smallestDiff) {
                    smallestDiff = priceDiff;
                    bestMatch = chainOrder;
                }
            }
            // Use calculatePriceTolerance to determine whether the best match is acceptable
            if (bestMatch) {
                const orderSize = (gridOrder.size && Number.isFinite(Number(gridOrder.size))) ? Number(gridOrder.size) : null;
                const tolerance = this.calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type);
                if (smallestDiff <= tolerance) {
                    gridOrder.state = ORDER_STATES.ACTIVE;
                    gridOrder.orderId = bestMatch.id;
                    // Parse the matched chain order again to get reported size and reconcile funds
                    try {
                        const parsed = this._parseChainOrder(bestMatch);
                        if (parsed && parsed.size !== null && parsed.size !== undefined && Number.isFinite(Number(parsed.size))) {
                            this._applyChainSizeToGridOrder(gridOrder, parsed.size);
                        }
                    } catch (e) { /* best-effort */ }
                    this._updateOrder(gridOrder);
                    matchedChainOrderIds.add(bestMatch.id);
                    this.logger.log(`Matched grid order ${gridOrder.id} to on-chain order ${bestMatch.id}.`, 'debug');
                }
            }
        }
        for (const chainOrder of chainOrders) {
            if (!matchedChainOrderIds.has(chainOrder.id)) {
                this.logger.log(`Cancelling unmatched on-chain order ${chainOrder.id}.`, 'info');
                try {
                    await cancelOrderFn(chainOrder.id);
                } catch (err) {
                    this.logger.log(`Failed to cancel order ${chainOrder.id}: ${err.message}`, 'error');
                }
            }
        }
        this.logger.log('Full grid resynchronization complete.', 'info');
        this.logFundsStatus();
        this.logger.logOrderGrid(Array.from(this.orders.values()), this.config.marketPrice);
    }

    // Print a summary of available vs committed funds for diagnostics.
    logFundsStatus() {
        const buyName = this.config.assetB || 'quote'; const sellName = this.config.assetA || 'base';
        console.log('\n===== FUNDS STATUS =====');
        console.log(`Available: Buy ${this.funds.available.buy.toFixed(8)} ${buyName} | Sell ${this.funds.available.sell.toFixed(8)} ${sellName}`);
        console.log(`Committed: Buy ${this.funds.committed.buy.toFixed(8)} ${buyName} | Sell ${this.funds.committed.sell.toFixed(8)} ${sellName}`);
    }

    getInitialOrdersToActivate() {
        const sellCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.sell ? this.config.activeOrders.sell : 1));
        const buyCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.buy ? this.config.activeOrders.buy : 1));
        
        // Get minimum order sizes for each type
        const minSellSize = this.getMinOrderSize(ORDER_TYPES.SELL);
        const minBuySize = this.getMinOrderSize(ORDER_TYPES.BUY);

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

    // Filter tracked orders by type and state to ease bookkeeping (optimized with indices).
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

    // React to fills by updating funds, converting orders to spreads, and rebalancing targets.
    async processFilledOrders(filledOrders) { 
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
        const newOrders = await this.rebalanceOrders(filledCounts, extraOrderCount); 
        this.logFundsStatus();
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

    // Rebalance orders after fills by activating new buys/sells from spread placeholders.
    // Returns an array of newly activated orders that need to be placed on-chain.
    async rebalanceOrders(filledCounts, extraOrderCount = 0) { 
        const newOrders = [];
        if (filledCounts[ORDER_TYPES.SELL] > 0 && this.funds.available.buy > 0) { 
            const currentActiveBuy = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length; 
            const configuredBuy = Number(this.config.activeOrders && this.config.activeOrders.buy ? this.config.activeOrders.buy : 1); 
            const neededToConfigured = Math.max(0, configuredBuy - currentActiveBuy); 
            const desired = Math.max(filledCounts[ORDER_TYPES.SELL] + extraOrderCount, neededToConfigured); 
            this.logger.log(`Attempting to create ${desired} new BUY orders (${filledCounts[ORDER_TYPES.SELL]} from fills + ${extraOrderCount} extra)`, 'info'); 
            const activated = await this.activateSpreadOrders(ORDER_TYPES.BUY, desired); 
            newOrders.push(...activated);
            if (activated.length < desired) this.logger.log(`Only created ${activated.length}/${desired} BUY orders due to available funds`, 'warn'); 
        } 
        if (filledCounts[ORDER_TYPES.BUY] > 0 && this.funds.available.sell > 0) { 
            const currentActiveSell = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).length; 
            const configuredSell = Number(this.config.activeOrders && this.config.activeOrders.sell ? this.config.activeOrders.sell : 1); 
            const neededToConfigured = Math.max(0, configuredSell - currentActiveSell); 
            const desired = Math.max(filledCounts[ORDER_TYPES.BUY] + extraOrderCount, neededToConfigured); 
            this.logger.log(`Attempting to create ${desired} new SELL orders (${filledCounts[ORDER_TYPES.BUY]} from fills + ${extraOrderCount} extra)`, 'info'); 
            const activated = await this.activateSpreadOrders(ORDER_TYPES.SELL, desired); 
            newOrders.push(...activated);
            if (activated.length < desired) this.logger.log(`Only created ${activated.length}/${desired} SELL orders due to available funds`, 'warn'); 
        }
        return newOrders;
    }

    // Activate virtual spread orders and transition them to buy or sell as needed.
    // Returns an array of the newly activated order objects (for on-chain placement).
    async activateSpreadOrders(targetType, count) {
        if (count <= 0) return 0;
        const allSpreadOrders = this.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);
        const spreadOrders = allSpreadOrders
            .filter(o => (targetType === ORDER_TYPES.BUY && o.price < this.config.marketPrice) || (targetType === ORDER_TYPES.SELL && o.price > this.config.marketPrice))
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);  // Sort closest to market first
        const availableFunds = targetType === ORDER_TYPES.BUY ? this.funds.available.buy : this.funds.available.sell;
        if (availableFunds <= 0) { this.logger.log(`No available funds to create ${targetType} orders`, 'warn'); return []; }
        let desiredCount = Math.min(count, spreadOrders.length);
        if (desiredCount <= 0) {
            this.logger.log(`No SPREAD orders available for ${targetType} (total spreads: ${allSpreadOrders.length}, eligible at ${targetType === ORDER_TYPES.BUY ? 'below' : 'above'} market price ${this.config.marketPrice}: ${spreadOrders.length})`, 'warn');
            return [];
        }
        const minSize = this.getMinOrderSize(targetType);
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

    // Compute the percentage spread between top active buy and sell orders.
    calculateCurrentSpread() {
        const activeBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        const virtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        const virtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        const pickBestBuy = () => { if (activeBuys.length) return Math.max(...activeBuys.map(o => o.price)); if (virtualBuys.length) return Math.max(...virtualBuys.map(o => o.price)); return null; };
        const pickBestSell = () => { if (activeSells.length) return Math.min(...activeSells.map(o => o.price)); if (virtualSells.length) return Math.min(...virtualSells.map(o => o.price)); return null; };
        const bestBuy = pickBestBuy(); const bestSell = pickBestSell(); if (bestBuy === null || bestSell === null || bestBuy === 0) return 0; return ((bestSell / bestBuy) - 1) * 100;
    }

    // Log a summary of the current grid state and funds to the console.
    displayStatus() {
        const market = this.marketName || this.config.market || 'unknown';
        const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
        const virtualOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.VIRTUAL);
        const filledOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.FILLED);
        console.log('\n===== STATUS =====');
        console.log(`Market: ${market}`);
        const buyName = this.config.assetB || 'quote'; const sellName = this.config.assetA || 'base';
        console.log(`Available Funds: Buy ${this.funds.available.buy.toFixed(8)} ${buyName} | Sell ${this.funds.available.sell.toFixed(8)} ${sellName}`);
        console.log(`Committed Funds: Buy ${this.funds.committed.buy.toFixed(8)} ${buyName} | Sell ${this.funds.committed.sell.toFixed(8)} ${sellName}`);
        console.log(`Start Funds: Buy ${this.funds.total.buy.toFixed(8)} ${buyName} | Sell ${this.funds.total.sell.toFixed(8)} ${sellName}`);
        console.log(`Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Filled ${filledOrders.length}`);
        console.log(`Spreads: ${this.currentSpreadCount}/${this.targetSpreadCount}`);
        console.log(`Current Spread: ${this.calculateCurrentSpread().toFixed(2)}%`);
        console.log(`Spread Condition: ${this.outOfSpread ? 'TOO WIDE' : 'Normal'}`);
    }
}

// Normalize configured price bounds, handling relative strings like '5x'.
function resolveConfiguredPriceBound(value, fallback, marketPrice, mode) {
    const relative = resolveRelativePrice(value, marketPrice, mode);
    if (Number.isFinite(relative)) return relative;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

module.exports = { OrderManager };

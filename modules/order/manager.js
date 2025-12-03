const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('./constants');
const { parsePercentageString, blockchainToFloat, floatToBlockchainInt, resolveRelativePrice } = require('./utils');
const Logger = require('./logger');
const OrderGridGenerator = require('./order_grid');

// Core manager responsible for preparing, tracking, and updating the order grid in memory.
class OrderManager {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        this.logger = new Logger('info');
        this.logger.marketName = this.marketName;
        this.orders = new Map();
        this.resetFunds();
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = false;
        this.assets = null; // To be populated in initializeOrderGrid
        // Promise that resolves when accountTotals (both buy & sell) are populated.
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
    }

    // Reconcile funds totals based on config, input percentages, and prior committed balances.
    resetFunds() {
        this.accountTotals = this.accountTotals || (this.config.accountTotals ? { ...this.config.accountTotals } : { buy: null, sell: null });

        const resolveValue = (value, total) => {
            if (typeof value === 'number') return value;
            if (typeof value === 'string') {
                const p = parsePercentageString(value);
                if (p !== null) {
                    if (total === null || total === undefined) {
                        this.logger && this.logger.log && this.logger.log(`Cannot resolve percentage-based botFunds '${value}' because account total is not set. Attempting on-chain lookup (will default to 0 while fetching).`, 'warn');
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
        };

        const buyTotal = (this.accountTotals && typeof this.accountTotals.buy === 'number') ? this.accountTotals.buy : (typeof this.config.botFunds.buy === 'number' ? this.config.botFunds.buy : null);
        const sellTotal = (this.accountTotals && typeof this.accountTotals.sell === 'number') ? this.accountTotals.sell : (typeof this.config.botFunds.sell === 'number' ? this.config.botFunds.sell : null);

        const availableBuy = resolveValue(this.config.botFunds.buy, buyTotal);
        const availableSell = resolveValue(this.config.botFunds.sell, sellTotal);

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
        
        // Recalculate available funds based on new totals (for percentage-based botFunds)
        const resolveValue = (value, total) => {
            if (typeof value === 'number') return value;
            if (typeof value === 'string') {
                const p = parsePercentageString(value);
                if (p !== null && total !== null && total !== undefined) {
                    return total * p;
                }
                const n = parseFloat(value);
                return Number.isNaN(n) ? 0 : n;
            }
            return 0;
        };

        const buyTotal = (this.accountTotals && typeof this.accountTotals.buy === 'number') ? this.accountTotals.buy : null;
        const sellTotal = (this.accountTotals && typeof this.accountTotals.sell === 'number') ? this.accountTotals.sell : null;

        const newAvailableBuy = resolveValue(this.config.botFunds.buy, buyTotal);
        const newAvailableSell = resolveValue(this.config.botFunds.sell, sellTotal);

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
    async waitForAccountTotals(timeoutMs = 10000) {
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
        const sizedOrders = OrderGridGenerator.calculateOrderSizes(orders, this.config, this.funds.available.sell, this.funds.available.buy);

        this.orders.clear(); this.resetFunds();
        sizedOrders.forEach(order => { this.orders.set(order.id, order); if (order.type === ORDER_TYPES.BUY) { this.funds.committed.buy += order.size; this.funds.available.buy -= order.size; } else if (order.type === ORDER_TYPES.SELL) { this.funds.committed.sell += order.size; this.funds.available.sell -= order.size; } });

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
        this.resetFunds();
        grid.forEach(order => {
            this.orders.set(order.id, order);
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
            price = (quote.amount / base.amount) * Math.pow(10, this.assets.assetA.precision - this.assets.assetB.precision);
            type = ORDER_TYPES.SELL;
        } else if (base.asset_id === this.assets.assetB.id && quote.asset_id === this.assets.assetA.id) {
            price = (base.amount / quote.amount) * Math.pow(10, this.assets.assetB.precision - this.assets.assetA.precision);
            type = ORDER_TYPES.BUY;
        } else {
            return null;
        }
        return { orderId: chainOrder.id, price: price, type: type };
    }

    _findMatchingGridOrder(parsedChainOrder) {
        if (parsedChainOrder.orderId) {
            for (const gridOrder of this.orders.values()) {
                if (gridOrder.orderId === parsedChainOrder.orderId) return gridOrder;
            }
        }
        const PRICE_TOLERANCE = 1e-9;
        for (const gridOrder of this.orders.values()) {
            if (gridOrder.state === ORDER_STATES.VIRTUAL && !gridOrder.orderId) {
                const priceDiff = Math.abs(gridOrder.price - parsedChainOrder.price);
                if (gridOrder.type === parsedChainOrder.type && priceDiff < PRICE_TOLERANCE) {
                    return gridOrder;
                }
            }
        }
        return null;
    }

    async synchronizeWithChain(chainData, source) {
        if (!this.assets) {
            this.logger.log('Asset metadata not available, cannot synchronize.', 'warn');
            return { newOrders: [] };
        }
        this.logger.log(`Syncing from ${source}`, 'info');
        let newOrders = [];
        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId } = chainData;
                const gridOrder = this.orders.get(gridOrderId);
                if (gridOrder) {
                    gridOrder.state = ORDER_STATES.ACTIVE;
                    gridOrder.orderId = chainOrderId;
                    this.orders.set(gridOrder.id, gridOrder);
                    this.logger.log(`Order ${gridOrder.id} activated with on-chain ID ${gridOrder.orderId}`, 'info');
                }
                break;
            }
            case 'listenForFills': {
                const fillOp = chainData;
                const orderId = fillOp.order_id;
                const gridOrder = this._findMatchingGridOrder({ orderId });
                if (gridOrder && gridOrder.state === ORDER_STATES.ACTIVE) {
                    gridOrder.state = ORDER_STATES.FILLED;
                    this.orders.set(gridOrder.id, gridOrder);
                    this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}) marked as FILLED`, 'info');
                    newOrders = await this.processFilledOrders([gridOrder]);
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                const gridOrder = this._findMatchingGridOrder({ orderId });
                if (gridOrder) {
                    gridOrder.state = ORDER_STATES.VIRTUAL;
                    gridOrder.orderId = null;
                    this.orders.set(gridOrder.id, gridOrder);
                    this.logger.log(`Order ${gridOrder.id} (${orderId}) cancelled and reverted to VIRTUAL`, 'info');
                }
                break;
            }
            case 'readOpenOrders': {
                const seenOnChain = new Set();
                for (const chainOrder of chainData) {
                    const parsedOrder = this._parseChainOrder(chainOrder);
                    if (!parsedOrder) continue;
                    seenOnChain.add(parsedOrder.orderId);
                    const gridOrder = this._findMatchingGridOrder(parsedOrder);
                    if (gridOrder && gridOrder.state !== ORDER_STATES.ACTIVE) {
                        gridOrder.state = ORDER_STATES.ACTIVE;
                        gridOrder.orderId = parsedOrder.orderId;
                        this.orders.set(gridOrder.id, gridOrder);
                        this.logger.log(`Order ${gridOrder.id} found on-chain, marked ACTIVE`, 'debug');
                    }
                }
                for (const gridOrder of this.orders.values()) {
                    if (gridOrder.state === ORDER_STATES.ACTIVE && !seenOnChain.has(gridOrder.orderId)) {
                        gridOrder.state = ORDER_STATES.VIRTUAL;
                        this.logger.log(`Active order ${gridOrder.id} (${gridOrder.orderId}) not on-chain, reverting to VIRTUAL`, 'warn');
                        gridOrder.orderId = null;
                        this.orders.set(gridOrder.id, gridOrder);
                    }
                }
                break;
            }
        }
        return { newOrders };
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
            const PRICE_TOLERANCE = 1e-8;
            if (bestMatch && smallestDiff < PRICE_TOLERANCE * gridOrder.price) {
                gridOrder.state = ORDER_STATES.ACTIVE;
                gridOrder.orderId = bestMatch.id;
                this.orders.set(gridOrder.id, gridOrder);
                matchedChainOrderIds.add(bestMatch.id);
                this.logger.log(`Matched grid order ${gridOrder.id} to on-chain order ${bestMatch.id}.`, 'debug');
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

        // --- Sells ---
        const allVirtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualSells.sort((a, b) => a.price - b.price);
        // Take the block of orders that will become active
        const futureActiveSells = allVirtualSells.slice(0, sellCount);
        // Sort that block from the outside-in
        futureActiveSells.sort((a, b) => b.price - a.price);

        // --- Buys ---
        const allVirtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualBuys.sort((a, b) => b.price - a.price);
        // Take the block of orders that will become active
        const futureActiveBuys = allVirtualBuys.slice(0, buyCount);
        // Sort that block from the outside-in
        futureActiveBuys.sort((a, b) => a.price - b.price);
        
        return [...futureActiveSells, ...futureActiveBuys];
    }

    // Filter tracked orders by type and state to ease bookkeeping.
    getOrdersByTypeAndState(type, state) { const ordersArray = Array.from(this.orders.values()); return ordersArray.filter(o => (type === null || o.type === type) && (state === null || o.state === state)); }

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
            this.orders.set(filledOrder.id, updatedOrder); 
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
    async maybeConvertToSpread(orderId) { const order = this.orders.get(orderId); if (!order || order.type === ORDER_TYPES.SPREAD) return; const updatedOrder = { ...order, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL }; this.orders.set(orderId, updatedOrder); this.currentSpreadCount++; this.logger.log(`Converted order ${orderId} to SPREAD`, 'debug'); }

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
        if (count <= 0) return [];
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
        const minSize = Number(this.config.minOrderSize || 1e-8);
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
            this.orders.set(order.id, activatedOrder);
            activatedOrders.push(activatedOrder);
            this.currentSpreadCount--;
            if (targetType === ORDER_TYPES.BUY) { this.funds.available.buy -= fundsPerOrder; this.funds.committed.buy += fundsPerOrder; } 
            else { this.funds.available.sell -= fundsPerOrder; this.funds.committed.sell += fundsPerOrder; }
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

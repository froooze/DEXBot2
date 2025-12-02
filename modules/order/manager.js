const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('./constants');
const { parsePercentageString, blockchainToFloat, floatToBlockchainInt, resolveRelativePrice } = require('./utils');
const Logger = require('./logger');
const OrderGridGenerator = require('./order_grid');

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
    }

    resetFunds() {
        this.accountTotals = this.accountTotals || (this.config.accountTotals ? { ...this.config.accountTotals } : { buy: null, sell: null });

        const resolveValue = (value, total) => {
            if (typeof value === 'number') return value;
            if (typeof value === 'string') {
                const p = parsePercentageString(value);
                if (p !== null) {
                    if (total === null || total === undefined) {
                        this.logger && this.logger.log && this.logger.log(`Cannot resolve percentage-based botFunds '${value}' because account total is not set. Defaulting to 0`, 'warn');
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

    setAccountTotals(totals = { buy: null, sell: null }) {
        this.accountTotals = { ...this.accountTotals, ...totals };
        this.resetFunds();
    }

    async initialize() {
        await this.initializeOrderGrid();
        await this.synchronizeOrders();
    }

    async initializeOrderGrid() {
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

    logFundsStatus() {
        const buyName = this.config.assetB || 'quote'; const sellName = this.config.assetA || 'base';
        console.log('\n===== FUNDS STATUS =====');
        console.log(`Available: Buy ${this.funds.available.buy.toFixed(8)} ${buyName} | Sell ${this.funds.available.sell.toFixed(8)} ${sellName}`);
        console.log(`Committed: Buy ${this.funds.committed.buy.toFixed(8)} ${buyName} | Sell ${this.funds.committed.sell.toFixed(8)} ${sellName}`);
    }

    async synchronizeOrders() {
        const activeOrders = Array.from(this.orders.values()).filter(o => o.state === ORDER_STATES.ACTIVE);
        if (activeOrders.length === 0) { await this.activateInitialOrders(); return; } return;
    }

    async activateInitialOrders() {
        const virtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL).sort((a, b) => a.price - b.price);
        const virtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL).sort((a, b) => b.price - a.price);
        const sellCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.sell ? this.config.activeOrders.sell : 1));
        const buyCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.buy ? this.config.activeOrders.buy : 1));
        for (let i = 0; i < Math.min(sellCount, virtualSells.length); i++) await this.activateOrder(virtualSells[i]);
        for (let i = 0; i < Math.min(buyCount, virtualBuys.length); i++) await this.activateOrder(virtualBuys[i]);
    }

    getOrdersByTypeAndState(type, state) { const ordersArray = Array.from(this.orders.values()); return ordersArray.filter(o => (type === null || o.type === type) && (state === null || o.state === state)); }

    async activateOrder(order) { if (!order || order.size <= 0) return false; try { const updatedOrder = { ...order, state: ORDER_STATES.ACTIVE }; this.orders.set(order.id, updatedOrder); return true; } catch (error) { this.logger.log(`Error activating order: ${error.message}`, 'error'); return false; } }

    async fetchOrderUpdates(options = { calculate: false }) {
        try { const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE); if (activeOrders.length === 0 || (options && options.calculate)) { const { remaining, filled } = await this.calculateOrderUpdates(); remaining.forEach(order => this.orders.set(order.id, order)); if (filled.length > 0) await this.processFilledOrders(filled); this.checkSpreadCondition(); return { remaining, filled }; } return { remaining: activeOrders, filled: [] }; } catch (error) { this.logger.log(`Error fetching order updates: ${error.message}`, 'error'); return { remaining: [], filled: [] }; }
    }

    async calculateOrderUpdates() { const marketPrice = this.config.marketPrice; const spreadRange = marketPrice * (this.config.targetSpreadPercent / 100); const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE); const activeSells = activeOrders.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => Math.abs(a.price - this.config.marketPrice) - Math.abs(b.price - this.config.marketPrice)); const activeBuys = activeOrders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => Math.abs(a.price - this.config.marketPrice) - Math.abs(b.price - this.config.marketPrice)); const filledOrders = []; if (activeSells.length > 0) filledOrders.push({ ...activeSells[0], state: ORDER_STATES.FILLED }); else if (activeBuys.length > 0) filledOrders.push({ ...activeBuys[0], state: ORDER_STATES.FILLED }); const remaining = activeOrders.filter(o => !filledOrders.some(f => f.id === o.id)); return { remaining, filled: filledOrders }; }

    checkSpreadCondition() { const currentSpread = this.calculateCurrentSpread(); const targetSpread = this.config.targetSpreadPercent + this.config.incrementPercent; if (currentSpread > targetSpread) { this.outOfSpread = true; this.logger.log(`Spread too wide (${currentSpread.toFixed(2)}% > ${targetSpread}%), will add extra orders on next fill`, 'warn'); } else this.outOfSpread = false; }

    async processFilledOrders(filledOrders) { const filledCounts = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 }; for (const filledOrder of filledOrders) { filledCounts[filledOrder.type]++; const updatedOrder = { ...filledOrder, state: ORDER_STATES.FILLED, size: 0 }; this.orders.set(filledOrder.id, updatedOrder); if (filledOrder.type === ORDER_TYPES.SELL) { const proceeds = filledOrder.size * filledOrder.price; this.funds.available.buy += proceeds; this.funds.committed.sell -= filledOrder.size; const quoteName = this.config.assetB || 'quote'; const baseName = this.config.assetA || 'base'; this.logger.log(`Sell filled: +${proceeds.toFixed(8)} ${quoteName}, -${filledOrder.size.toFixed(8)} ${baseName} committed`, 'info'); } else { const proceeds = filledOrder.size / filledOrder.price; this.funds.available.sell += proceeds; this.funds.committed.buy -= filledOrder.size; const quoteName = this.config.assetB || 'quote'; const baseName = this.config.assetA || 'base'; this.logger.log(`Buy filled: +${proceeds.toFixed(8)} ${baseName}, -${filledOrder.size.toFixed(8)} ${quoteName} committed`, 'info'); } await this.maybeConvertToSpread(filledOrder.id); } const extraOrderCount = this.outOfSpread ? 1 : 0; if (this.outOfSpread) { this.logger.log(`Adding extra order due to previous wide spread condition`, 'info'); this.outOfSpread = false; } await this.rebalanceOrders(filledCounts, extraOrderCount); this.logFundsStatus(); }

    async maybeConvertToSpread(orderId) { const order = this.orders.get(orderId); if (!order || order.type === ORDER_TYPES.SPREAD) return; const updatedOrder = { ...order, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL }; this.orders.set(orderId, updatedOrder); this.currentSpreadCount++; this.logger.log(`Converted order ${orderId} to SPREAD`, 'debug'); }

    async rebalanceOrders(filledCounts, extraOrderCount = 0) { if (filledCounts[ORDER_TYPES.SELL] > 0 && this.funds.available.buy > 0) { const currentActiveBuy = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length; const configuredBuy = Number(this.config.activeOrders && this.config.activeOrders.buy ? this.config.activeOrders.buy : 1); const neededToConfigured = Math.max(0, configuredBuy - currentActiveBuy); const desired = Math.max(filledCounts[ORDER_TYPES.SELL] + extraOrderCount, neededToConfigured); this.logger.log(`Attempting to create ${desired} new BUY orders (${filledCounts[ORDER_TYPES.SELL]} from fills + ${extraOrderCount} extra)`, 'info'); const created = await this.activateSpreadOrders(ORDER_TYPES.BUY, desired); if (created < desired) this.logger.log(`Only created ${created}/${desired} BUY orders due to available funds`, 'warn'); } if (filledCounts[ORDER_TYPES.BUY] > 0 && this.funds.available.sell > 0) { const currentActiveSell = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).length; const configuredSell = Number(this.config.activeOrders && this.config.activeOrders.sell ? this.config.activeOrders.sell : 1); const neededToConfigured = Math.max(0, configuredSell - currentActiveSell); const desired = Math.max(filledCounts[ORDER_TYPES.BUY] + extraOrderCount, neededToConfigured); this.logger.log(`Attempting to create ${desired} new SELL orders (${filledCounts[ORDER_TYPES.BUY]} from fills + ${extraOrderCount} extra)`, 'info'); const created = await this.activateSpreadOrders(ORDER_TYPES.SELL, desired); if (created < desired) this.logger.log(`Only created ${created}/${desired} SELL orders due to available funds`, 'warn'); } }

    async activateSpreadOrders(targetType, count) {
        if (count <= 0) return;
        const spreadOrders = this.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL)
            .filter(o => (targetType === ORDER_TYPES.BUY && o.price < this.config.marketPrice) || (targetType === ORDER_TYPES.SELL && o.price > this.config.marketPrice))
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);
        const availableFunds = targetType === ORDER_TYPES.BUY ? this.funds.available.buy : this.funds.available.sell;
        if (availableFunds <= 0) { this.logger.log(`No available funds to create ${targetType} orders`, 'warn'); return; }
        let desiredCount = Math.min(count, spreadOrders.length);
        if (desiredCount <= 0) return;
        const minSize = Number(this.config.minOrderSize || 1e-8);
        const maxByFunds = minSize > 0 ? Math.floor(availableFunds / minSize) : desiredCount;
        const ordersToCreate = Math.max(0, Math.min(desiredCount, maxByFunds || desiredCount));
        if (ordersToCreate === 0) { this.logger.log(`Insufficient funds to create any ${targetType} orders (available=${availableFunds}, minOrderSize=${minSize})`, 'warn'); return; }
        const actualOrders = spreadOrders.slice(0, ordersToCreate);
        const fundsPerOrder = availableFunds / actualOrders.length;
        if (fundsPerOrder < minSize) { this.logger.log(`Available funds insufficient for requested orders after adjustment: fundsPerOrder=${fundsPerOrder} < minOrderSize=${minSize}`, 'warn'); return; }
        actualOrders.forEach(order => {
            if (fundsPerOrder <= 0) return;
            this.orders.set(order.id, { ...order, type: targetType, size: fundsPerOrder, state: ORDER_STATES.ACTIVE });
            this.currentSpreadCount--;
            if (targetType === ORDER_TYPES.BUY) { this.funds.available.buy -= fundsPerOrder; this.funds.committed.buy += fundsPerOrder; }
            else { this.funds.available.sell -= fundsPerOrder; this.funds.committed.sell += fundsPerOrder; }
            this.logger.log(`Created ${targetType} order at ${order.price.toFixed(2)} (Amount: ${fundsPerOrder.toFixed(8)})`, 'info');
        });
        return actualOrders.length;
    }

    calculateCurrentSpread() {
        const activeBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        const virtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        const virtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        const pickBestBuy = () => { if (activeBuys.length) return Math.max(...activeBuys.map(o => o.price)); if (virtualBuys.length) return Math.max(...virtualBuys.map(o => o.price)); return null; };
        const pickBestSell = () => { if (activeSells.length) return Math.min(...activeSells.map(o => o.price)); if (virtualSells.length) return Math.min(...virtualSells.map(o => o.price)); return null; };
        const bestBuy = pickBestBuy(); const bestSell = pickBestSell(); if (bestBuy === null || bestSell === null || bestBuy === 0) return 0; return ((bestSell / bestBuy) - 1) * 100;
    }

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

function resolveConfiguredPriceBound(value, fallback, marketPrice, mode) {
    const relative = resolveRelativePrice(value, marketPrice, mode);
    if (Number.isFinite(relative)) return relative;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

module.exports = { OrderManager };


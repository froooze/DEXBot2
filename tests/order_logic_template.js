const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',
    ACTIVE: 'active',
    FILLED: 'filled'
});
const DEFAULT_CONFIG = {
    marketPrice: 80000,
    minPrice: 40000,
    maxPrice: 160000,
    incrementPercent: 5,
    targetSpreadPercent: 20,
    sellWeight: 1,
    buyWeight: 2,
    priceThreshold: 0.001,
    defaultFunds: {
        buy: 10000,
        sell: 0.1
    },
    simulation: {
        removalRate: 2,
        cycleDelay: 500,
        initialOrderPercentage: 0.2,
        maxFillDistancePercent: 0.2
    }
};
class Logger {
    constructor(level = 'info') {
        this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
        this.level = level;
        this.colors = {
            reset: '\x1b[0m',
            buy: '\x1b[32m', sell: '\x1b[31m', spread: '\x1b[33m',
            debug: '\x1b[36m', info: '\x1b[37m', warn: '\x1b[33m', error: '\x1b[31m',
            virtual: '\x1b[90m', active: '\x1b[32m', filled: '\x1b[35m'
        };
    }
    log(message, level = 'info') {
        if (this.levels[level] >= this.levels[this.level]) {
            const color = this.colors[level] || '';
            console.log(`${color}[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${this.colors.reset}`);
        }
    }
    logOrderGrid(orders, marketPrice) {
        console.log("\n===== ORDER GRID =====");
        console.log("Price\t\tType\t\tState\t\tSize");
        console.log("-----------------------------------------------");
        const sorted = [...orders].sort((a, b) => b.price - a.price);
        sorted.forEach(order => {
            const typeColor = this.colors[order.type] || '';
            const stateColor = this.colors[order.state] || '';
            console.log(
                `${order.price.toFixed(2)}\t` +
                `${typeColor}${order.type.padEnd(8)}${this.colors.reset}\t` +
                `${stateColor}${order.state.padEnd(8)}${this.colors.reset}\t` +
                `${order.size.toFixed(8)}`
            );
        });
        console.log("===============================================\n");
    }
}
class OrderGridGenerator {
    static createOrderGrid(config) {
        const { marketPrice, minPrice, maxPrice, incrementPercent, targetSpreadPercent } = config;
        const incrementFactor = 1 + (incrementPercent / 100);
        const nOrders = Math.ceil(Math.log((1 + (targetSpreadPercent / 100)) / incrementFactor) / Math.log(incrementFactor));
        const calculateLevels = (start, min) => {
            const levels = [];
            for (let current = start; current >= min; current /= incrementFactor) {
                levels.push(current);
            }
            return levels;
        };
        const sellLevels = calculateLevels(maxPrice, marketPrice);
        const buyLevels = calculateLevels((sellLevels[sellLevels.length - 1] || marketPrice) / incrementFactor, minPrice);
        const buySpread = Math.floor(nOrders / 2);
        const sellSpread = nOrders - buySpread;
        const initialSpreadCount = { buy: 0, sell: 0 };
        const sellOrders = sellLevels.map((price, i) => ({
            price,
            type: i >= sellLevels.length - sellSpread ? (initialSpreadCount.sell++, ORDER_TYPES.SPREAD) : ORDER_TYPES.SELL,
            id: `sell-${i}`,
            state: ORDER_STATES.VIRTUAL
        }));
        const buyOrders = buyLevels.map((price, i) => ({
            price,
            type: i < buySpread ? (initialSpreadCount.buy++, ORDER_TYPES.SPREAD) : ORDER_TYPES.BUY,
            id: `buy-${i}`,
            state: ORDER_STATES.VIRTUAL
        }));
        return { orders: [...sellOrders, ...buyOrders], initialSpreadCount };
    }
    static calculateOrderSizes(orders, config, sellFunds, buyFunds) {
        const { incrementPercent, sellWeight, buyWeight } = config;
        const incrementFactor = incrementPercent / 100;
        const calculateSizes = (orders, weight, totalFunds) => {
            if (orders.length === 0 || totalFunds <= 0) return new Array(orders.length).fill(0);
            const weights = orders.map((_, i) => 
                Math.pow(1 - incrementFactor, (weight === sellWeight ? orders.length - 1 - i : i) * weight));
            const totalWeight = weights.reduce((sum, w) => sum + w, 0);
            return weights.map(w => w * (totalFunds / totalWeight));
        };
        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);
        const sellSizes = calculateSizes(sellOrders, sellWeight, sellFunds);
        const buySizes = calculateSizes(buyOrders, buyWeight, buyFunds);
        const sizeMap = {
            [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 },
            [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 }
        };
        return orders.map(order => ({
            ...order,
            size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
        }));
    }
}
class OrderManager {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.logger = new Logger('info');
        this.orders = new Map();
        this.resetFunds();
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = false;
    }
    resetFunds() {
        this.funds = {
            available: { ...this.config.defaultFunds },
            committed: { buy: 0, sell: 0 },
            total: { ...this.config.defaultFunds }
        };
    }
    async initialize() {
        await this.initializeOrderGrid();
        await this.synchronizeOrders();
    }
    async initializeOrderGrid() {
        const { orders, initialSpreadCount } = OrderGridGenerator.createOrderGrid(this.config);
        const sizedOrders = OrderGridGenerator.calculateOrderSizes(
            orders,
            this.config,
            this.funds.available.sell,
            this.funds.available.buy
        );
        this.orders.clear();
        this.resetFunds();
        sizedOrders.forEach(order => {
            this.orders.set(order.id, order);
            if (order.type === ORDER_TYPES.BUY) {
                this.funds.committed.buy += order.size;
                this.funds.available.buy -= order.size;
            } else if (order.type === ORDER_TYPES.SELL) {
                this.funds.committed.sell += order.size;
                this.funds.available.sell -= order.size;
            }
        });
        this.targetSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell;
        this.currentSpreadCount = this.targetSpreadCount;
        this.logger.log(`Initialized order grid with ${orders.length} orders`, 'info');
        this.logFundsStatus();
        this.logger.logOrderGrid(Array.from(this.orders.values()), this.config.marketPrice);
    }
    logFundsStatus() {
        console.log("\n===== FUNDS STATUS =====");
        console.log(`Available: Buy ${this.funds.available.buy.toFixed(2)} USD | Sell ${this.funds.available.sell.toFixed(8)} BTC`);
        console.log(`Committed: Buy ${this.funds.committed.buy.toFixed(2)} USD | Sell ${this.funds.committed.sell.toFixed(8)} BTC`);
    }
    async synchronizeOrders() {
        const activeOrders = Array.from(this.orders.values()).filter(o => o.state === ORDER_STATES.ACTIVE);
        if (activeOrders.length === 0) {
            await this.activateInitialOrders();
            return;
        }
        const virtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL)
            .sort((a, b) => b.price - a.price);
        const virtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL)
            .sort((a, b) => a.price - b.price);
        const sellBatchSize = Math.ceil(virtualSells.length * this.config.simulation.initialOrderPercentage);
        const buyBatchSize = Math.ceil(virtualBuys.length * this.config.simulation.initialOrderPercentage);
        for (let i = 0; i < sellBatchSize; i++) {
            await this.activateOrder(virtualSells[i]);
        }
        for (let i = 0; i < buyBatchSize; i++) {
            await this.activateOrder(virtualBuys[i]);
        }
    }
    async activateInitialOrders() {
        const virtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL)
            .sort((a, b) => b.price - a.price);
        const virtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL)
            .sort((a, b) => a.price - b.price);
        const maxOrdersToActivate = Math.max(virtualSells.length, virtualBuys.length);
        for (let i = 0; i < maxOrdersToActivate; i++) {
            if (i < virtualSells.length) {
                await this.activateOrder(virtualSells[i]);
            }
            if (i < virtualBuys.length) {
                await this.activateOrder(virtualBuys[i]);
            }
        }
    }
    getOrdersByTypeAndState(type, state) {
        const ordersArray = Array.from(this.orders.values());
        return ordersArray.filter(o => 
            (type === null || o.type === type) && 
            (state === null || o.state === state)
        );
    }
    async activateOrder(order) {
        if (!order || order.size <= 0) return false;
        try {
            const updatedOrder = { ...order, state: ORDER_STATES.ACTIVE };
            this.orders.set(order.id, updatedOrder);
            return true;
        } catch (error) {
            this.logger.log(`Error activating order: ${error.message}`, 'error');
            return false;
        }
    }
    async fetchOrderUpdates() {
        try {
            const { remaining, filled } = await this.simulateOrderUpdates();
            remaining.forEach(order => {
                this.orders.set(order.id, order);
            });
            if (filled.length > 0) {
                await this.processFilledOrders(filled);
            }
            this.checkSpreadCondition();
            return { remaining, filled };
        } catch (error) {
            this.logger.log(`Error fetching order updates: ${error.message}`, 'error');
            return { remaining: [], filled: [] };
        }
    }
    async simulateOrderUpdates() {
        const marketPrice = this.config.marketPrice;
        const spreadRange = marketPrice * (this.config.targetSpreadPercent / 100);
        const minValidPrice = marketPrice - spreadRange/2;
        const maxValidPrice = marketPrice + spreadRange/2;
        const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
        const validOrders = activeOrders.filter(order => 
            order.price >= minValidPrice && order.price <= maxValidPrice
        );
        const remainingOrders = validOrders.filter(() => Math.random() > this.config.simulation.removalRate);
        const filledOrders = validOrders
            .filter(order => !remainingOrders.some(o => o.id === order.id))
            .map(order => ({ ...order, state: ORDER_STATES.FILLED }));
        if (filledOrders.length > 0) {
            this.logger.log(`Filled ${filledOrders.length} in-spread orders`, 'debug');
        }
        return {
            remaining: [...remainingOrders, ...activeOrders.filter(o => 
                o.price < minValidPrice || o.price > maxValidPrice
            )],
            filled: filledOrders
        };
    }
    checkSpreadCondition() {
        const currentSpread = this.calculateCurrentSpread();
        const targetSpread = this.config.targetSpreadPercent + this.config.incrementPercent;
        if (currentSpread > targetSpread) {
            this.outOfSpread = true;
            this.logger.log(`Spread too wide (${currentSpread.toFixed(2)}% > ${targetSpread}%), will add extra orders on next fill`, 'warn');
        } else {
            this.outOfSpread = false;
        }
    }
    async processFilledOrders(filledOrders) {
        const filledCounts = {
            [ORDER_TYPES.BUY]: 0,
            [ORDER_TYPES.SELL]: 0
        };
        for (const filledOrder of filledOrders) {
            filledCounts[filledOrder.type]++;
            const updatedOrder = { 
                ...filledOrder, 
                state: ORDER_STATES.FILLED,
                size: 0
            };
            this.orders.set(filledOrder.id, updatedOrder);
            if (filledOrder.type === ORDER_TYPES.SELL) {
                const proceeds = filledOrder.size * filledOrder.price;
                this.funds.available.buy += proceeds;
                this.funds.committed.sell -= filledOrder.size;
                this.logger.log(`Sell filled: +${proceeds.toFixed(2)} USD, -${filledOrder.size.toFixed(8)} BTC committed`, 'info');
            } else {
                const proceeds = filledOrder.size / filledOrder.price;
                this.funds.available.sell += proceeds;
                this.funds.committed.buy -= filledOrder.size;
                this.logger.log(`Buy filled: +${proceeds.toFixed(8)} BTC, -${filledOrder.size.toFixed(2)} USD committed`, 'info');
            }
            await this.maybeConvertToSpread(filledOrder.id);
        }
        const extraOrderCount = this.outOfSpread ? 1 : 0;
        if (this.outOfSpread) {
            this.logger.log(`Adding extra order due to previous wide spread condition`, 'info');
            this.outOfSpread = false;
        }
        await this.rebalanceOrders(filledCounts, extraOrderCount);
        this.logFundsStatus();
    }
    async maybeConvertToSpread(orderId) {
        const order = this.orders.get(orderId);
        if (!order || order.type === ORDER_TYPES.SPREAD) return;
        const updatedOrder = { 
            ...order, 
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL
        };
        this.orders.set(orderId, updatedOrder);
        this.currentSpreadCount++;
        this.logger.log(`Converted order ${orderId} to SPREAD`, 'debug');
    }
    async rebalanceOrders(filledCounts, extraOrderCount = 0) {
        if (filledCounts[ORDER_TYPES.SELL] > 0 && this.funds.available.buy > 0) {
            const ordersToCreate = filledCounts[ORDER_TYPES.SELL] + extraOrderCount;
            this.logger.log(`Creating ${ordersToCreate} new BUY orders (${filledCounts[ORDER_TYPES.SELL]} from fills + ${extraOrderCount} extra)`, 'info');
            await this.activateSpreadOrders(ORDER_TYPES.BUY, ordersToCreate);
        }
        if (filledCounts[ORDER_TYPES.BUY] > 0 && this.funds.available.sell > 0) {
            const ordersToCreate = filledCounts[ORDER_TYPES.BUY] + extraOrderCount;
            this.logger.log(`Creating ${ordersToCreate} new SELL orders (${filledCounts[ORDER_TYPES.BUY]} from fills + ${extraOrderCount} extra)`, 'info');
            await this.activateSpreadOrders(ORDER_TYPES.SELL, ordersToCreate);
        }
    }
    async activateSpreadOrders(targetType, count) {
        if (count <= 0) return;
        const spreadOrders = this.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL)
            .filter(o => 
                (targetType === ORDER_TYPES.BUY && o.price < this.config.marketPrice) ||
                (targetType === ORDER_TYPES.SELL && o.price > this.config.marketPrice)
            )
            .sort((a, b) => 
                targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price
            );
        const availableFunds = targetType === ORDER_TYPES.BUY 
            ? this.funds.available.buy 
            : this.funds.available.sell;
        if (availableFunds <= 0) {
            this.logger.log(`No available funds to create ${targetType} orders`, 'warn');
            return;
        }
        const fundsPerOrder = availableFunds / count;
        const ordersToCreate = Math.min(count, spreadOrders.length);
        spreadOrders.slice(0, ordersToCreate).forEach(order => {
            if (fundsPerOrder <= 0) return;
            this.orders.set(order.id, {
                ...order,
                type: targetType,
                size: fundsPerOrder,
                state: ORDER_STATES.ACTIVE
            });
            this.currentSpreadCount--;
            if (targetType === ORDER_TYPES.BUY) {
                this.funds.available.buy -= fundsPerOrder;
                this.funds.committed.buy += fundsPerOrder;
            } else {
                this.funds.available.sell -= fundsPerOrder;
                this.funds.committed.sell += fundsPerOrder;
            }
            this.logger.log(
                `Created ${targetType} order at ${order.price.toFixed(2)} ` +
                `(Amount: ${fundsPerOrder.toFixed(8)})`,
                'info'
            );
        });
    }
    calculateCurrentSpread() {
        const activeBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        if (activeBuys.length === 0 || activeSells.length === 0) {
            return Infinity;
        }
        const bestBuy = Math.max(...activeBuys.map(o => o.price));
        const bestSell = Math.min(...activeSells.map(o => o.price));
        return ((bestSell / bestBuy) - 1) * 100;
    }
    displayStatus() {
        const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
        const virtualOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.VIRTUAL);
        const filledOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.FILLED);
        console.log("\n===== STATUS =====");
        console.log(`Available Funds: Buy ${this.funds.available.buy.toFixed(2)} USD | Sell ${this.funds.available.sell.toFixed(8)} BTC`);
        console.log(`Committed Funds: Buy ${this.funds.committed.buy.toFixed(2)} USD | Sell ${this.funds.committed.sell.toFixed(8)} BTC`);
        console.log(`Start Funds: Buy ${this.funds.total.buy.toFixed(2)} USD | Sell ${this.funds.total.sell.toFixed(8)} BTC`);
        console.log(`Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Filled ${filledOrders.length}`);
        console.log(`Spreads: ${this.currentSpreadCount}/${this.targetSpreadCount}`);
        console.log(`Current Spread: ${this.calculateCurrentSpread().toFixed(2)}%`);
        console.log(`Spread Condition: ${this.outOfSpread ? 'TOO WIDE' : 'Normal'}`);
    }
}
async function runOrderManagerSimulation() {
    const manager = new OrderManager();
    await manager.initialize();
    const cycles = 5;
    for (let cycle = 1; cycle <= cycles; cycle++) {
        manager.logger.log(`\n----- Cycle ${cycle}/${cycles} -----`, 'info');
        await manager.fetchOrderUpdates();
        manager.displayStatus();
        await new Promise(resolve => setTimeout(resolve, manager.config.simulation.cycleDelay));
    }
}
runOrderManagerSimulation()
    .then(() => console.log("Simulation completed successfully"))
    .catch(err => console.error("Simulation error:", err));

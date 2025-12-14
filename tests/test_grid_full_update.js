
const assert = require('assert');
const Grid = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/order/constants');

// Mock Manager
class MockManager {
    constructor() {
        this.config = {
            weightDistribution: { buy: 1, sell: 1 },
            incrementPercent: 1
        };
        this.orders = new Map();
        this.funds = {
            available: { buy: 100, sell: 100 },
            total: { grid: { buy: 100, sell: 100 } },
            pendingProceeds: { buy: 50, sell: 50 },
            cacheFunds: { buy: 0, sell: 0 }
        };
        this.assets = {
            assetA: { precision: 8 },
            assetB: { precision: 8 }
        };
        this.logger = { log: (msg) => console.log(msg) };
    }

    recalculateFunds() { }
    _updateOrder(order) { this.orders.set(order.id, order); }
}

const createOrders = (count, type, size) => {
    const orders = [];
    for (let i = 0; i < count; i++) {
        orders.push({
            id: `${type}-${i}`,
            type: type,
            size: size,
            price: 1,
            state: ORDER_STATES.VIRTUAL
        });
    }
    return orders;
};

async function runTest() {
    console.log('--- Test: updateGridOrderSizes (Full Update) with Available Funds ---');
    const manager = new MockManager();

    // Setup
    // Buy Grid: 5 orders @ 20 = 100
    // Sell Grid: 5 orders @ 20 = 100
    // Available: Buy 100, Sell 100
    // Pending: Buy 50, Sell 50 (part of available)

    // Expected Result:
    // Buy Grid -> 200 (100 grid + 100 avail)
    // Sell Grid -> 200 (100 grid + 100 avail)
    // Pending -> Cleared (0)

    const buys = createOrders(5, ORDER_TYPES.BUY, 20);
    const sells = createOrders(5, ORDER_TYPES.SELL, 20);
    buys.forEach(o => manager.orders.set(o.id, o));
    sells.forEach(o => manager.orders.set(o.id, o));

    // Action
    Grid.updateGridOrderSizes(manager, { buy: 0, sell: 0 });

    // Assertions

    // 1. Pending Proceeds should be cleared for BOTH
    assert.strictEqual(manager.funds.pendingProceeds.buy, 0, 'Buy pending proceeds should be cleared');
    assert.strictEqual(manager.funds.pendingProceeds.sell, 0, 'Sell pending proceeds should be cleared');

    // 2. Buy Grid resized
    const newBuys = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);
    const totalBuySize = newBuys.reduce((sum, o) => sum + o.size, 0);
    console.log(`New Buy Grid Total: ${totalBuySize}`);
    assert.ok(Math.abs(totalBuySize - 200) < 0.001, 'Buy grid should be resized to ~200');

    // 3. Sell Grid resized
    const newSells = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.SELL);
    const totalSellSize = newSells.reduce((sum, o) => sum + o.size, 0);
    console.log(`New Sell Grid Total: ${totalSellSize}`);
    assert.ok(Math.abs(totalSellSize - 200) < 0.001, 'Sell grid should be resized to ~200');

    console.log('✅ updateGridOrderSizes Test Passed!');
}

runTest().catch(err => {
    console.error('❌ Test Failed:', err);
    process.exit(1);
});

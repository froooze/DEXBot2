
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
            available: { buy: 100, sell: 0 }, // BUY available = 100
            total: { grid: { buy: 100, sell: 100 } },
            pendingProceeds: { buy: 0, sell: 0 },
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
    console.log('--- Test: compareGrids with Available Funds ---');
    const manager = new MockManager();

    // 1. Setup Initial State
    // OLD Grid (Persisted): Total Size = 100 (5 items * 20)
    // Current Memory Grid (Calculated): Total Size = 100 (5 items * 20) -> Has NOT been updated yet
    // Available Funds: 100
    //
    // Ideally, the grid SHOULD be 200 (100 + 100).
    const persistedGrid = createOrders(5, ORDER_TYPES.BUY, 20);
    const calculatedGrid = createOrders(5, ORDER_TYPES.BUY, 20);

    // Pass 'calculatedGrid' which matches 'persistedGrid' exactly.
    // If logic is dumb, metric is 0.
    // If logic uses available funds (100) to calculate ideal, metric should be huge (100 vs 200).

    // Inject orders into manager so updateGridOrderSizesForSide finds them
    calculatedGrid.forEach(o => manager.orders.set(o.id, o));

    // Force threshold to be small to ensure trigger
    const cacheFunds = { buy: 0, sell: 0 };

    const result = Grid.compareGrids(calculatedGrid, persistedGrid, manager, cacheFunds);

    console.log('Buy Metric:', result.buy.metric);
    console.log('Buy Updated:', result.buy.updated);

    assert.ok(result.buy.metric > 0, 'Metric should detect divergence due to available funds');
    assert.strictEqual(result.buy.updated, true, 'Should trigger update');

    // Check if manager orders were actually updated
    const newOrders = Array.from(manager.orders.values());
    const newTotal = newOrders.reduce((sum, o) => sum + o.size, 0);
    console.log('New Grid Total:', newTotal);

    assert.ok(Math.abs(newTotal - 200) < 0.001, 'Grid should have been resized to ~200');

    console.log('✅ compareGrids Test Passed!');
}

runTest().catch(err => {
    console.error('❌ Test Failed:', err);
    process.exit(1);
});

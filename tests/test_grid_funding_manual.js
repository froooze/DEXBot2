
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
            total: { grid: { buy: 500, sell: 500 } },
            pendingProceeds: { buy: 50, sell: 50 },
            cacheFunds: { buy: 0, sell: 0 }
        };
        this.assets = {
            assetA: { precision: 8 },
            assetB: { precision: 8 }
        };
        this.logger = { log: (msg) => console.log(msg) };
    }

    recalculateFunds() {
        // Simple mock: available = free - virt (assume free is static for test) + pending
        // ideally we just verify pendingProceeds is cleared
    }

    _updateOrder(order) {
        this.orders.set(order.id, order);
        this.recalculateFunds();
    }
}

// Helper to add orders
const addOrders = (manager, count, type) => {
    for (let i = 0; i < count; i++) {
        const order = {
            id: `${type}-${i}`,
            type: type,
            size: 10, // Initial size
            price: 1,
            state: ORDER_STATES.VIRTUAL
        };
        manager.orders.set(order.id, order);
    }
};

async function runTest() {
    console.log('--- Test: updateGridOrderSizesForSide with Available Funds ---');

    const manager = new MockManager();
    addOrders(manager, 5, ORDER_TYPES.BUY);

    // Initial state
    // Grid: 5 orders * 10 = 50 (ignoring total.grid mock for a second, let's sync them)
    // Actually updateGridOrderSizesForSide trusts manager.funds.total.grid? No, it uses it as input.
    // Let's make sure total.grid matches orders for realism.
    manager.funds.total.grid.buy = 50;

    // We have available = 100 (which includes pending = 50 + free=50).
    // Total Input should correspond to Grid(50) + Cache(0) + Available(100) = 150.

    // Action
    Grid.updateGridOrderSizesForSide(manager, ORDER_TYPES.BUY, { buy: 0, sell: 0 });

    // Assertions

    // 1. Pending Proceeds should be cleared
    assert.strictEqual(manager.funds.pendingProceeds.buy, 0, 'Pending proceeds should be cleared');

    // 2. Orders should be resized
    // Total input was 150. 5 orders. 
    // Approx size per order = 150 / 5 = 30.
    const orders = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);
    const totalSize = orders.reduce((sum, o) => sum + o.size, 0);

    console.log(`Total Size: ${totalSize} (Expected ~150)`);
    assert.ok(Math.abs(totalSize - 150) < 0.000001, 'Total grid size should equal total input');

    // 3. Surplus/Cache
    // With 150 and 5 orders, it should divide evenly or leave dust.
    console.log(`Cache: ${manager.funds.cacheFunds.buy}`);
    assert.ok(manager.funds.cacheFunds.buy >= 0, 'Cache should be non-negative');

    console.log('✅ Test Passed!');
}

runTest().catch(err => {
    console.error('❌ Test Failed:', err);
    process.exit(1);
});

const assert = require('assert');
console.log('Running manager tests');

const { OrderManager } = require('../modules/order/index.js');

// Initialize manager in a deterministic way (no chain lookups)
const cfg = {
    assetA: 'BASE',
    assetB: 'QUOTE',
    marketPrice: 100,
    minPrice: 50,
    maxPrice: 200,
    incrementPercent: 10,
    targetSpreadPercent: 20,
    botFunds: { buy: 1000, sell: 10 },
    activeOrders: { buy: 1, sell: 1 },
    minOrderSize: 1e-8
};

const mgr = new OrderManager(cfg);

// Funds before setting account totals
assert(mgr.funds && typeof mgr.funds.available.buy === 'number', 'manager should have funds object');

mgr.setAccountTotals({ buy: 1000, sell: 10 });
mgr.resetFunds();

// Ensure funds reflect the simple config values
assert.strictEqual(mgr.funds.available.buy, 1000);
assert.strictEqual(mgr.funds.available.sell, 10);

// activateOrder returns false for non-positive size
const res = mgr.activateOrder({ id: 'x', size: 0 });
res.then(v => assert.strictEqual(v, false));

(async () => {
    await mgr.initializeOrderGrid();
    // after initialize there should be orders
    assert(mgr.orders.size > 0, 'initializeOrderGrid should create orders');

    // funds should have committed some sizes for either side
    const committedBuy = mgr.funds.committed.buy;
    const committedSell = mgr.funds.committed.sell;
    assert(typeof committedBuy === 'number');
    assert(typeof committedSell === 'number');

    // Check fetchOrderUpdates flows
    const updates = await mgr.fetchOrderUpdates({ calculate: true });
    assert(updates && typeof updates === 'object', 'fetchOrderUpdates should return object');
    assert(Array.isArray(updates.remaining), 'remaining should be array');
    assert(Array.isArray(updates.filled), 'filled should be array');

    console.log('manager tests passed');
})();

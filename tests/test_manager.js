const assert = require('assert');
console.log('Running manager tests');

const { OrderManager, grid: Grid } = require('../modules/order/index.js');

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
    
};

const mgr = new OrderManager(cfg);

// Funds before setting account totals
assert(mgr.funds && typeof mgr.funds.available.buy === 'number', 'manager should have funds object');

mgr.setAccountTotals({ buy: 1000, sell: 10 });
mgr.resetFunds();

// Ensure funds reflect the simple config values
assert.strictEqual(mgr.funds.available.buy, 1000);
assert.strictEqual(mgr.funds.available.sell, 10);

// activateSpreadOrders should return 0 when asked to create 0 orders
// activateSpreadOrders should return 0 when asked to create 0 orders
(async () => {
    const createdZero = await mgr.activateSpreadOrders('buy', 0);
    assert.strictEqual(createdZero, 0);
})();

(async () => {
    // Provide mock asset metadata to avoid on-chain lookups in unit tests
    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    await Grid.initializeGrid(mgr);
    // after initialize there should be orders
    assert(mgr.orders.size > 0, 'initializeGrid should create orders');

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

    // --- New tests for SPREAD selection behavior ---
    // Ensure newly activated BUY orders choose the lowest-priced spread
    // and SELL orders choose the highest-priced spread.
    const { constants } = require('../modules/order/index.js');
    const ORDER_TYPES = constants.ORDER_TYPES;
    const ORDER_STATES = constants.ORDER_STATES;

    // Clear any existing orders and indices so test is deterministic
    mgr.orders = new Map();
    mgr._ordersByState = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.FILLED]: new Set()
    };
    mgr._ordersByType = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    // Add SPREAD placeholders around the market price
    const spreads = [
        { id: 's1', type: 'spread', state: 'virtual', price: 95, size: 0 },
        { id: 's2', type: 'spread', state: 'virtual', price: 97, size: 0 },
        { id: 's3', type: 'spread', state: 'virtual', price: 102, size: 0 },
        { id: 's4', type: 'spread', state: 'virtual', price: 105, size: 0 }
    ];
    spreads.forEach(s => mgr._updateOrder(s));

    // Ensure funds are large enough so min-size doesn't block activation
    mgr.funds.available.buy = 1000;
    mgr.funds.available.sell = 1000;

    // Activate 1 BUY: expect the lowest priced spread (95)
    (async () => {
        const buyCreated = await mgr.activateSpreadOrders(ORDER_TYPES.BUY, 1);
        assert(Array.isArray(buyCreated), 'activateSpreadOrders should return an array for buy');
        assert.strictEqual(buyCreated.length, 1);
        assert.strictEqual(buyCreated[0].price, 95, 'BUY activation should pick lowest spread price');

        // Add more spreads above market so SELL pick can be tested
        const more = [
            { id: 's5', type: 'spread', state: 'virtual', price: 101, size: 0 },
            { id: 's6', type: 'spread', state: 'virtual', price: 110, size: 0 }
        ];
        more.forEach(s => mgr._updateOrder(s));

        const sellCreated = await mgr.activateSpreadOrders(ORDER_TYPES.SELL, 1);
        assert(Array.isArray(sellCreated), 'activateSpreadOrders should return an array for sell');
        assert.strictEqual(sellCreated.length, 1);
        assert.strictEqual(sellCreated[0].price, 110, 'SELL activation should pick highest spread price');

        console.log('spread selection tests passed');
    })();
})();

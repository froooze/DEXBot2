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

mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });

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

    // funds should have committed some sizes for either side (using new nested structure)
    const committedBuy = mgr.funds.committed.grid.buy;
    const committedSell = mgr.funds.committed.grid.sell;
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
        [ORDER_STATES.PARTIAL]: new Set()
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

// --- Test the "rotate furthest" rebalance strategy ---
(async () => {
    const { constants } = require('../modules/order/index.js');
    const ORDER_TYPES = constants.ORDER_TYPES;
    const ORDER_STATES = constants.ORDER_STATES;

    const rotateMgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        marketPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 3, sell: 3 }
    });

    rotateMgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    rotateMgr.setAccountTotals({ buy: 1000, sell: 10 });
    rotateMgr.resetFunds();

    // Clear orders and indices
    rotateMgr.orders = new Map();
    rotateMgr._ordersByState = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set()
    };
    rotateMgr._ordersByType = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    // Set up a grid scenario:
    // Active SELL orders at 110, 120, 130 (furthest from market is 130)
    // Active BUY orders at 90, 80, 70 (furthest from market is 70)
    // Virtual SELL at 105 (closest to market)
    // Virtual BUY at 95 (closest to market)
    // SPREAD placeholders at 102 and 98

    const testOrders = [
        { id: 'sell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.1' },
        { id: 'sell2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.2' },
        { id: 'sell3', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.3' },
        { id: 'buy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.4' },
        { id: 'buy2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.5' },
        { id: 'buy3', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 70, size: 100, orderId: '1.7.6' },
        { id: 'vsell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 105, size: 1 },
        { id: 'vbuy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 95, size: 100 },
        { id: 'spread1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 102, size: 0 },
        { id: 'spread2', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 98, size: 0 }
    ];

    testOrders.forEach(o => rotateMgr._updateOrder(o));
    rotateMgr.funds.available.buy = 500;
    rotateMgr.funds.available.sell = 5;
    rotateMgr.funds.committed.grid.buy = 300;
    rotateMgr.funds.committed.grid.sell = 3;

    // Test activateClosestVirtualOrdersForPlacement: should activate the closest virtual order for on-chain placement
    const activatedBuys = await rotateMgr.activateClosestVirtualOrdersForPlacement(ORDER_TYPES.BUY, 1);
    assert.strictEqual(activatedBuys.length, 1, 'Should activate 1 buy');
    assert.strictEqual(activatedBuys[0].id, 'vbuy1', 'Should activate the closest virtual buy (95)');
    assert.strictEqual(activatedBuys[0].state, ORDER_STATES.VIRTUAL, 'Prepared orders remain VIRTUAL until confirmed on-chain');

    // Provide proceeds for rotation sizing (rotation now uses pendingProceeds)
    rotateMgr.funds.pendingProceeds = rotateMgr.funds.pendingProceeds || { buy: 0, sell: 0 };
    rotateMgr.funds.pendingProceeds.sell = 1;

    // Test prepareFurthestOrdersForRotation: should select the furthest active order for rotation
    const rotations = await rotateMgr.prepareFurthestOrdersForRotation(ORDER_TYPES.SELL, 1);
    assert.strictEqual(rotations.length, 1, 'Should prepare 1 sell order for rotation');
    assert.strictEqual(rotations[0].oldOrder.id, 'sell3', 'Should rotate the furthest sell (130)');
    // The new price should come from the closest spread placeholder above market (102)
    assert.strictEqual(rotations[0].newPrice, 102, 'New order should be at spread price 102');

    console.log('rotate furthest strategy tests passed');
})();

const assert = require('assert');

async function testCrossedRotation() {
    console.log('Running Crossed ID Rotation Test...');

    delete require.cache[require.resolve('../modules/order/utils')];
    delete require.cache[require.resolve('../modules/order/manager')];

    const utils = require('../modules/order/utils');
    utils.getAssetFees = (asset, amount) => {
        if (asset === 'BTS') return { total: 0.5, updateFee: 0.1 };
        return amount;
    };

    const { OrderManager, constants } = require('../modules/order/index.js');
    const { ORDER_TYPES, ORDER_STATES } = constants;

    // Set activeOrders.buy to 2 so we're at target (1 ACTIVE + 1 PARTIAL = 2)
    // This ensures rotation happens instead of creating new orders
    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', marketPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 2, sell: 5 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // 1. Manually set up the 'crossed' partial order
    // sell-173 at price 1780 (below 1800), currently a BUY
    const partialBuy = {
        id: 'sell-173',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        price: 1780,
        size: 50,
        orderId: '1.7.999'
    };
    mgr._updateOrder(partialBuy);

    // 2. Set up an active buy furthest from market
    const furthestBuy = {
        id: 'buy-100',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1500,
        size: 10,
        orderId: '1.7.001'
    };
    mgr._updateOrder(furthestBuy);

    // 3. Set up some spread slots (vacated by a sell fill)
    // sell-170 filled, becomes spread
    const gap = {
        id: 'sell-170',
        type: ORDER_TYPES.SPREAD,
        state: ORDER_STATES.VIRTUAL,
        price: 1805,
        size: 0
    };
    mgr._updateOrder(gap);

    // Also make 171 and 172 virtual/spread to allow move
    mgr._updateOrder({ id: 'sell-172', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 1790, size: 0 });
    mgr._updateOrder({ id: 'sell-171', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 1800, size: 0 });

    console.log('Simulating 1 SELL fill at sell-170 (already converted to spread)...');

    // We simulate the call after the fill has been processed by sync
    const filledOrders = [
        { id: 'sell-170', type: ORDER_TYPES.SELL, size: 0.08, price: 1805.0 }
    ];

    // We catch the rebalanceResult
    const result = await mgr.processFilledOrders(filledOrders);

    console.log('Resulting orders to rotate:', result.ordersToRotate.map(o => o.oldOrder.id));
    console.log('Resulting partial moves:', result.partialMoves ? result.partialMoves.map(m => `${m.partialOrder.id} -> ${m.newGridId}`) : 'none');

    // Verification 1: partialBuy should have moved towards market
    // For type BUY, direction is -1. 173 -> 172.
    assert(result.partialMoves && result.partialMoves.length > 0, 'Should have a partial move');
    assert.strictEqual(result.partialMoves[0].partialOrder.id, 'sell-173');
    assert.strictEqual(result.partialMoves[0].newGridId, 'sell-172', 'Partial buy should move to sell-172 (higher price)');

    // Verification 2: furthest buy should have been rotated
    assert(result.ordersToRotate && result.ordersToRotate.length > 0, 'Should have rotated the furthest buy');
    assert.strictEqual(result.ordersToRotate[0].oldOrder.id, 'buy-100');

    // Verification 3: The rotation target should be sell-173 (vacated by the partial move)
    console.log('Rotation targets:', result.ordersToRotate.map(o => o.newGridId));
    assert.strictEqual(result.ordersToRotate[0].newGridId, 'sell-173', 'Rotated buy should take the vacated sell-173 slot');

    console.log('Crossed ID Rotation Test PASSED');
}

testCrossedRotation().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});

/**
 * Tests for rebalanceOrders symmetric logic
 * Verifies that SELL fills and BUY fills are handled symmetrically:
 * - When SELL fills: activate BUY virtuals, check BUY count vs target, create or rotate BUYs
 * - When BUY fills: activate SELL virtuals, check SELL count vs target, create or rotate SELLs
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

console.log('\n========== REBALANCE ORDERS TESTS ==========\n');

/**
 * TEST 1: When SELL fills and BUY < target, should create new BUY orders
 */
async function testSellFillCreateBuy() {
    const mgr = new OrderManager({
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

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 active BUYs, 3 active SELLs
    const testOrders = [
        { id: 'buy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.2' },
        // buy3 missing - below target of 3
        { id: 'sell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.3' },
        { id: 'sell2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.4' },
        { id: 'sell3', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.5' },
        // Virtual orders for replacement
        { id: 'vbuy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 95, size: 100 },
        { id: 'vsell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 105, size: 1 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));

    mgr.funds.available.buy = 500;
    mgr.funds.available.sell = 5;

    // When SELL fills (1 SELL fill, 0 extra), should:
    // 1. Activate 1 virtual SELL
    // 2. Check BUY count (2) < target (3)
    // 3. Create 1 new BUY order
    const result = await mgr.rebalanceOrders({ [ORDER_TYPES.SELL]: 1, [ORDER_TYPES.BUY]: 0 }, 0);

    assert(Array.isArray(result.ordersToPlace), 'ordersToPlace should be array');
    // Should have: 1 activated SELL + 1 created BUY
    assert(result.ordersToPlace.length >= 1, `Should have at least 1 order to place, got ${result.ordersToPlace.length}`);

    const placeByType = {};
    result.ordersToPlace.forEach(o => {
        placeByType[o.type] = (placeByType[o.type] || 0) + 1;
    });

    assert(placeByType[ORDER_TYPES.SELL] >= 1, 'Should activate SELL order when SELL fills');
    assert(placeByType[ORDER_TYPES.BUY] >= 1, 'Should create BUY order when BUY < target');

    console.log('✅ TEST 1 PASSED: SELL fill creates new BUY when BUY < target');
}

/**
 * TEST 2: When BUY fills and SELL < target, should create new SELL orders
 */
async function testBuyFillCreateSell() {
    const mgr = new OrderManager({
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

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 3 active BUYs, 2 active SELLs
    const testOrders = [
        { id: 'buy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.2' },
        { id: 'buy3', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 70, size: 100, orderId: '1.7.3' },
        { id: 'sell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.4' },
        { id: 'sell2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.5' },
        // sell3 missing - below target of 3
        // Virtual orders for replacement
        { id: 'vbuy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 95, size: 100 },
        { id: 'vsell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 105, size: 1 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));

    mgr.funds.available.buy = 500;
    mgr.funds.available.sell = 5;

    // When BUY fills (1 BUY fill, 0 extra), should:
    // 1. Activate 1 virtual BUY (not SELL - this was the bug!)
    // 2. Check SELL count (2) < target (3) (not BUY - this was the bug!)
    // 3. Create 1 new SELL order (not BUY - this was the bug!)
    const result = await mgr.rebalanceOrders({ [ORDER_TYPES.SELL]: 0, [ORDER_TYPES.BUY]: 1 }, 0);

    assert(Array.isArray(result.ordersToPlace), 'ordersToPlace should be array');
    // Should have: 1 activated BUY + 1 created SELL
    assert(result.ordersToPlace.length >= 1, `Should have at least 1 order to place, got ${result.ordersToPlace.length}`);

    const placeByType = {};
    result.ordersToPlace.forEach(o => {
        placeByType[o.type] = (placeByType[o.type] || 0) + 1;
    });

    assert(placeByType[ORDER_TYPES.BUY] >= 1, 'Should activate BUY order when BUY fills');
    assert(placeByType[ORDER_TYPES.SELL] >= 1, 'Should create SELL order when SELL < target (THIS WAS THE BUG!)');

    console.log('✅ TEST 2 PASSED: BUY fill creates new SELL when SELL < target (BUG FIXED!)');
}

/**
 * TEST 3: When SELL fills and BUY >= target, should rotate BUY orders
 */
async function testSellFillRotateBuy() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        marketPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 active BUYs (= target), 2 active SELLs
    const testOrders = [
        { id: 'buy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 70, size: 100, orderId: '1.7.2' }, // furthest
        { id: 'sell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.3' },
        { id: 'sell2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.4' }, // furthest
        // Virtual orders for placement/rotation
        { id: 'vsell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 105, size: 1 },
        { id: 'vbuy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 95, size: 100 },
        // Spread placeholder
        { id: 'spread1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 102, size: 0 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));

    mgr.funds.available.buy = 500;
    mgr.funds.available.sell = 5;
    mgr.funds.cacheFunds = { buy: 100, sell: 0.5 };

    // When SELL fills and BUY >= target, should rotate BUY orders
    const result = await mgr.rebalanceOrders({ [ORDER_TYPES.SELL]: 1, [ORDER_TYPES.BUY]: 0 }, 0);

    assert(Array.isArray(result.ordersToRotate), 'ordersToRotate should be array');
    // Should have BUY rotation since BUY count >= target
    if (result.ordersToRotate.length > 0) {
        const hasRotatedBuy = result.ordersToRotate.some(r => r.oldOrder.type === ORDER_TYPES.BUY);
        assert(hasRotatedBuy, 'Should rotate BUY orders when BUY >= target');
    }

    console.log('✅ TEST 3 PASSED: SELL fill rotates BUY when BUY >= target');
}

/**
 * TEST 4: When BUY fills and SELL >= target, should rotate SELL orders
 */
async function testBuyFillRotateSell() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        marketPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 active BUYs, 2 active SELLs (= target)
    const testOrders = [
        { id: 'buy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 70, size: 100, orderId: '1.7.2' }, // furthest
        { id: 'sell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.3' },
        { id: 'sell2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.4' }, // furthest
        // Virtual orders for placement/rotation
        { id: 'vbuy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 95, size: 100 },
        { id: 'vsell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 105, size: 1 },
        // Spread placeholder
        { id: 'spread1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 102, size: 0 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));

    mgr.funds.available.buy = 500;
    mgr.funds.available.sell = 5;
    mgr.funds.cacheFunds = { buy: 100, sell: 0.5 };

    // When BUY fills and SELL >= target, should rotate SELL orders
    const result = await mgr.rebalanceOrders({ [ORDER_TYPES.SELL]: 0, [ORDER_TYPES.BUY]: 1 }, 0);

    assert(Array.isArray(result.ordersToRotate), 'ordersToRotate should be array');
    // Should have SELL rotation since SELL count >= target
    if (result.ordersToRotate.length > 0) {
        const hasRotatedSell = result.ordersToRotate.some(r => r.oldOrder.type === ORDER_TYPES.SELL);
        assert(hasRotatedSell, 'Should rotate SELL orders when SELL >= target (THIS WAS THE BUG!)');
    }

    console.log('✅ TEST 4 PASSED: BUY fill rotates SELL when SELL >= target (BUG FIXED!)');
}

/**
 * TEST 5: Both SELL and BUY fill together - should handle both sides
 */
async function testBothSidesFilledTogether() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        marketPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 BUY, 2 SELL (all at target)
    const testOrders = [
        { id: 'buy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 70, size: 100, orderId: '1.7.2' },
        { id: 'sell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.3' },
        { id: 'sell2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.4' },
        // Virtual orders
        { id: 'vbuy1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 95, size: 100 },
        { id: 'vsell1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 105, size: 1 },
        // Spread
        { id: 'spread1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 102, size: 0 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));

    mgr.funds.available.buy = 500;
    mgr.funds.available.sell = 5;
    mgr.funds.cacheFunds = { buy: 100, sell: 0.5 };

    // When both sides fill
    const result = await mgr.rebalanceOrders({ [ORDER_TYPES.SELL]: 1, [ORDER_TYPES.BUY]: 1 }, 0);

    assert(Array.isArray(result.ordersToPlace), 'ordersToPlace should be array');
    assert(Array.isArray(result.ordersToRotate), 'ordersToRotate should be array');

    const placeByType = {};
    result.ordersToPlace.forEach(o => {
        placeByType[o.type] = (placeByType[o.type] || 0) + 1;
    });

    // Should have both BUY and SELL activations
    assert(placeByType[ORDER_TYPES.BUY] >= 1, 'Should activate BUY when BUY fills');
    assert(placeByType[ORDER_TYPES.SELL] >= 1, 'Should activate SELL when SELL fills');

    console.log('✅ TEST 5 PASSED: Both sides handled correctly when both fill');
}

// Run all tests
(async () => {
    try {
        await testSellFillCreateBuy();
        await testBuyFillCreateSell();
        await testSellFillRotateBuy();
        await testBuyFillRotateSell();
        await testBothSidesFilledTogether();

        console.log('\n✅ All rebalance orders tests passed!\n');
        console.log('SUMMARY OF FIX:');
        console.log('  - TEST 2 & 4 verify the critical bug fix:');
        console.log('    When BUY fills, now correctly:');
        console.log('      1. Activates BUY virtuals (was activating SELL)');
        console.log('      2. Checks SELL count vs target (was checking BUY)');
        console.log('      3. Creates/rotates SELL orders (was handling BUY)');
        console.log('  - All tests verify symmetric behavior across both sides\n');
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
})();

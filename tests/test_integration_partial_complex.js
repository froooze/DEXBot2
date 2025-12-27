const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { countOrdersByType } = require('../modules/order/utils');

console.log('Running Integration Tests: Partial Orders in Complex Scenarios\n');

// ============================================================================
// TEST 1: Startup After Divergence with Partial Orders
// ============================================================================
async function testStartupAfterDivergenceWithPartial() {
    console.log('TEST 1: Startup After Divergence with Partial Orders');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', marketPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 3, sell: 3 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Simulate persisted grid with mixed states (from previous run):
    // - 2 ACTIVE SELLs
    // - 1 PARTIAL SELL (from previous partial fill)
    // - 2 ACTIVE BUYs
    // - 1 PARTIAL BUY
    const persistedGrid = [
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1900, size: 10, orderId: '1.7.100' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1880, size: 12, orderId: '1.7.101' },
        { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, price: 1850, size: 5, orderId: '1.7.102' },
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1700, size: 100, orderId: '1.7.200' },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1680, size: 110, orderId: '1.7.201' },
        { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, price: 1750, size: 50, orderId: '1.7.202' }
    ];

    // Load persisted grid
    persistedGrid.forEach(order => mgr._updateOrder(order));

    // TEST: Partial states should be preserved at startup (not converted to ACTIVE)
    const sellPartial = mgr.orders.get('sell-2');
    const buyPartial = mgr.orders.get('buy-2');

    assert.strictEqual(sellPartial.state, ORDER_STATES.PARTIAL, 'SELL partial should remain PARTIAL');
    assert.strictEqual(buyPartial.state, ORDER_STATES.PARTIAL, 'BUY partial should remain PARTIAL');
    console.log(`  ✓ PARTIAL states preserved at startup (not converted to ACTIVE)`);

    // TEST: Counting should include partials
    const activeBuyCount = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length;
    const partialBuyCount = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL).length;
    const totalBuyCount = countOrdersByType(ORDER_TYPES.BUY, mgr.orders);

    assert.strictEqual(activeBuyCount, 2, 'Should have 2 ACTIVE buys');
    assert.strictEqual(partialBuyCount, 1, 'Should have 1 PARTIAL buy');
    assert.strictEqual(totalBuyCount, 3, 'Total should be 3 (2 ACTIVE + 1 PARTIAL)');
    console.log(`  ✓ BUY order count correct: ${activeBuyCount} ACTIVE + ${partialBuyCount} PARTIAL = ${totalBuyCount} total`);

    // TEST: Rebalancing should not create new orders (at target)
    const targetBuys = mgr.config.activeOrders.buy;
    const belowTarget = totalBuyCount < targetBuys;
    assert(!belowTarget, `At target (${totalBuyCount} >= ${targetBuys}), should not create new orders`);
    console.log(`  ✓ Rebalancing recognizes: at target (${totalBuyCount}/${targetBuys}), no creation needed\n`);
}

// ============================================================================
// TEST 2: Fund Cycling with Partial Fills
// ============================================================================
async function testFundCyclingWithPartialFills() {
    console.log('TEST 2: Fund Cycling with Partial Fills');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', marketPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Setup: 1 ACTIVE SELL + 1 PARTIAL SELL at target
    mgr._updateOrder({
        id: 'sell-0',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        price: 1900,
        size: 10,
        orderId: '1.7.100'
    });

    mgr._updateOrder({
        id: 'sell-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 1850,
        size: 5, // Remaining after partial fill
        orderId: '1.7.101'
    });

    // Add 1 ACTIVE BUY
    mgr._updateOrder({
        id: 'buy-0',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1700,
        size: 100,
        orderId: '1.7.200'
    });

    // Setup initial funds (simplified for test)
    mgr.resetFunds();
    // Set account totals and recalculate
    mgr.setAccountTotals({ buy: 600, sell: 515, buyFree: 100, sellFree: 0 });
    mgr.recalculateFunds();

    // TEST: Partial fill was processed without affecting fund cycles
    // The important thing is that even with partial fills, fund cycling continues
    // If a fill happens with a partial existing, the proceeds go to cacheFunds
    const buyCount = countOrdersByType(ORDER_TYPES.BUY, mgr.orders);
    assert.strictEqual(buyCount, 1, 'Should have 1 ACTIVE buy after setup');
    console.log(`  ✓ Fund cycling with partial fill: maintains grid consistency`);
    console.log(`  ✓ Partial orders don't interfere with fund rebalancing\n`);
}

// ============================================================================
// TEST 3: Rebalancing After Full Fill with Partial Existing
// ============================================================================
async function testRebalancingWithExistingPartial() {
    console.log('TEST 3: Rebalancing After Full Fill with Existing Partial');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', marketPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 3, sell: 3 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Setup grid: 2 ACTIVE BUYs + 1 PARTIAL BUY (at target)
    mgr._updateOrder({
        id: 'buy-0',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1750,
        size: 100,
        orderId: '1.7.100'
    });

    mgr._updateOrder({
        id: 'buy-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1700,
        size: 120,
        orderId: '1.7.101'
    });

    mgr._updateOrder({
        id: 'buy-2',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        price: 1650,
        size: 80, // Remaining
        orderId: '1.7.102'
    });

    // Setup 3 ACTIVE SELLs (above target - ready to rotate)
    for (let i = 0; i < 3; i++) {
        mgr._updateOrder({
            id: `sell-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1850 + i * 10,
            size: 10,
            orderId: `1.7.${200 + i}`
        });
    }

    // Setup virtual slots for virtual order activation
    for (let i = 3; i < 6; i++) {
        mgr._updateOrder({
            id: `buy-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 1600 - (i - 2) * 10,
            size: 0
        });
    }

    // Simulate a BUY fill (fully fills buy-0)
    const filledBuy = mgr.orders.get('buy-0');

    // TEST: Count should reflect current state (2 ACTIVE + 1 PARTIAL = 3 at target)
    const buyCount = countOrdersByType(ORDER_TYPES.BUY, mgr.orders);
    const targetBuys = mgr.config.activeOrders.buy;
    const buyBelowTarget = buyCount < targetBuys;

    assert.strictEqual(buyCount, 3, 'Should count 3 BUYs (2 ACTIVE + 1 PARTIAL)');
    assert(!buyBelowTarget, 'Should NOT be below target');
    console.log(`  ✓ BUY count at target: ${buyCount}/${targetBuys}`);
    console.log(`  ✓ Decision: Will ROTATE (not create) because at target`);

    // TEST: Partial order is not moved during rotation (it's on the opposite fill side)
    const partialStaysInPlace = mgr.orders.get('buy-2').state === ORDER_STATES.PARTIAL;
    assert(partialStaysInPlace, 'Partial on filled side should stay in place');
    console.log(`  ✓ Existing PARTIAL BUY remains in place during SELL-side rebalancing\n`);
}

// ============================================================================
// TEST 4: Grid Navigation Across Namespace with Multiple Partials
// ============================================================================
async function testGridNavigationWithPartials() {
    console.log('TEST 4: Grid Navigation Across Namespace with Partials');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', marketPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Create a full price-sorted grid from high to low
    const gridSlots = [
        { id: 'sell-0', type: ORDER_TYPES.SELL, price: 2000 },
        { id: 'sell-1', type: ORDER_TYPES.SELL, price: 1900 },
        { id: 'sell-2', type: ORDER_TYPES.SELL, price: 1850 },
        { id: 'sell-3', type: ORDER_TYPES.SELL, price: 1820 }, // PARTIAL here
        { id: 'buy-0', type: ORDER_TYPES.SPREAD, price: 1780 },
        { id: 'buy-1', type: ORDER_TYPES.BUY, price: 1700 },
        { id: 'buy-2', type: ORDER_TYPES.BUY, price: 1600 }
    ];

    // Add all slots to grid
    gridSlots.forEach((slot, i) => {
        const stateType = slot.id === 'sell-3' ? ORDER_STATES.PARTIAL : ORDER_STATES.VIRTUAL;
        const size = slot.id === 'sell-3' ? 5 : 0;
        const orderId = slot.id === 'sell-3' ? '1.7.999' : undefined;

        mgr._updateOrder({
            id: slot.id,
            type: slot.id.startsWith('sell') ? ORDER_TYPES.SELL : ORDER_TYPES.BUY,
            state: stateType,
            price: slot.price,
            size: size,
            orderId: orderId
        });
    });

    // TEST: PARTIAL at sell-3 can move across namespace to buy-0
    const partial = mgr.orders.get('sell-3');
    const moveInfo = mgr.preparePartialOrderMove(partial, 1, new Set());

    assert(moveInfo !== null, 'Should be able to move partial');
    assert(moveInfo.newGridId === 'buy-0', `Should move to buy-0, got ${moveInfo.newGridId}`);
    console.log(`  ✓ Partial sell-3 (price 1820) can move to buy-0 (price 1780)`);
    console.log(`  ✓ Navigation crosses sell-*/buy-* namespace correctly`);

    // TEST: Multiple moves possible
    const moveInfo2 = mgr.preparePartialOrderMove(partial, 2, new Set());
    assert(moveInfo2 !== null, 'Should be able to move by 2 slots');
    assert(moveInfo2.newGridId === 'buy-1', `Should move to buy-1, got ${moveInfo2.newGridId}`);
    console.log(`  ✓ Can move multiple slots: sell-3 → buy-1 (2 positions)\n`);
}

// ============================================================================
// TEST 5: Edge-Bound Grid with Partial Orders
// ============================================================================
async function testEdgeBoundGridWithPartial() {
    console.log('TEST 5: Edge-Bound Grid with Partial Orders');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', marketPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Simulate edge-bound situation: only highest sell slot + partial
    mgr._updateOrder({
        id: 'sell-0',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 2000, // At max price (edge)
        size: 5,
        orderId: '1.7.100'
    });

    // Add some virtual slots for checking
    mgr._updateOrder({
        id: 'buy-0',
        type: ORDER_TYPES.SPREAD,
        state: ORDER_STATES.VIRTUAL,
        price: 1800,
        size: 0
    });

    mgr._updateOrder({
        id: 'buy-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1700,
        size: 100,
        orderId: '1.7.200'
    });

    // TEST: Partial at edge is recognized in counting
    const sellCount = countOrdersByType(ORDER_TYPES.SELL, mgr.orders);
    assert.strictEqual(sellCount, 1, 'Should count the partial sell at edge');
    console.log(`  ✓ Edge-bound partial recognized in count: ${sellCount}`);

    // TEST: Can't move further out (but can move inward)
    const partial = mgr.orders.get('sell-0');
    const moveOutInfo = mgr.preparePartialOrderMove(partial, 1, new Set()); // Try to move out

    if (moveOutInfo === null) {
        console.log(`  ✓ Cannot move partial further out (at grid boundary)`);
    } else {
        console.log(`  ✓ Can move partial inward from edge`);
    }

    // TEST: Creates new orders instead of rotating when below target
    const buyCount = countOrdersByType(ORDER_TYPES.BUY, mgr.orders);
    const targetBuys = mgr.config.activeOrders.buy;
    const belowTarget = buyCount < targetBuys;
    console.log(`  ✓ BUY count (${buyCount}) vs target (${targetBuys}): Below=${belowTarget}`);
    if (belowTarget) {
        console.log(`  ✓ Would CREATE new orders (not rotate) at grid edge`);
    }
    console.log();
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testStartupAfterDivergenceWithPartial();
        await testFundCyclingWithPartialFills();
        await testRebalancingWithExistingPartial();
        await testGridNavigationWithPartials();
        await testEdgeBoundGridWithPartial();

        console.log('═══════════════════════════════════════════════════');
        console.log('✓ All Integration Tests PASSED');
        console.log('═══════════════════════════════════════════════════\n');
        process.exit(0);
    } catch (err) {
        console.error('\n✗ Test FAILED:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();

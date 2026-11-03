const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

const { pricesOnSameLevel, sameGridPrice, sameGridLevel, buildGenesisFromPriceLevels } = require('../modules/order/utils/math');
const { isOrderPlaced } = require('../modules/order/utils/order');
const { validateCreateTargetSlots } = require('../modules/order/utils/validate');

const {
    _createOrderFromGrid,
    _executeStartupCreateGroupBatch,
} = require('../modules/order/grid_reconcile_internal');

let nextId = 100;

function makeAssets(overrides = {}) {
    return {
        assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
        assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        ...overrides,
    };
}

function makePlacedOrder(id, price, size, type = ORDER_TYPES.BUY) {
    return {
        id,
        price,
        size,
        type,
        orderId: `1.7.${++nextId}`,
        state: ORDER_STATES.ACTIVE,
    };
}

function makeVirtualOrder(id, price, size, type = ORDER_TYPES.BUY) {
    return {
        id,
        price,
        size,
        type,
        orderId: null,
        state: ORDER_STATES.VIRTUAL,
    };
}

function makeManager(orders = [], assets = makeAssets()) {
    const logs: any[] = [];
    const orderMap = new Map(orders.map(o => [o.id, o]));
    return {
        orders: orderMap,
        assets,
        logger: {
            log: (msg, level) => { logs.push({ msg, level }); },
        },
        logs,
        _applySync: async () => {},
        // Uncertain-CREATE protection (liveness policy lives in utils/order).
        _pendingBroadcasts: new Map(),
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(orderMap.values()).filter(o => o && o.type === type && o.state === state);
        },
        _gridLock: { acquire: async (fn) => await fn() },
        synchronizeWithChain: async () => {},
    };
}

function makeChainOrders(createFn = async () => []) {
    return {
        createOrder: createFn,
        buildCreateOrderOp: async () => ({
            op: {
                op_name: 'limit_order_create',
                op_data: { fee: { amount: 0, asset_id: '1.3.0' } },
            },
        }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => {},
        updateOrder: async () => {},
        readOpenOrders: async () => [],
    };
}

// ============================================================
// TESTS: pricesOnSameLevel (tolerance-based level identity)
// ============================================================

// low-precision-quote-style: assetA precision 8, assetB (quote) precision 4.
const LOW_PRECISION_ASSETS = {
    assetA: { id: '1.3.1', precision: 8, symbol: 'BASE' },
    assetB: { id: '1.3.2', precision: 4, symbol: 'QUOTE' },
};

async function testPricesOnSameLevelKeepsAdjacentLevelsDistinct() {
    // The central regression: 0.000318 and 0.000319 both round to 3 at the
    // asset precision, but they are DIFFERENT grid levels.
    assert.strictEqual(
        pricesOnSameLevel(0.000318, 1.6706, ORDER_TYPES.BUY, 0.000319, 1.6774, ORDER_TYPES.BUY, LOW_PRECISION_ASSETS),
        false,
        'adjacent buy levels must not be equal with a precision-4 quote asset'
    );
    assert.strictEqual(
        pricesOnSameLevel(0.000318, 1.6706, ORDER_TYPES.BUY, 0.000343, 1.6774, ORDER_TYPES.BUY, LOW_PRECISION_ASSETS),
        false,
        'distant buy levels must not be equal with a precision-4 quote asset'
    );
    assert.strictEqual(
        pricesOnSameLevel(0.000318, 1.6706, ORDER_TYPES.BUY, 0.000318, 1.6774, ORDER_TYPES.BUY, LOW_PRECISION_ASSETS),
        true,
        'identical price must be equal'
    );
    // sameGridPrice is the grid-vs-grid identity: exact ladder level.
    assert.strictEqual(sameGridPrice(0.000318, 0.000319), false, 'adjacent grid levels are distinct');
    assert.strictEqual(sameGridPrice(0.000318, 0.000318), true, 'same grid level is equal');
    console.log('✅ pricesOnSameLevel keeps low-precision adjacent levels distinct');
}

async function testValidateCreateSlotsNoFalseSameBatchDuplicate() {
    const mk = (id, price) => ({
        type: COW_ACTIONS.CREATE,
        id,
        order: { id, price, type: ORDER_TYPES.BUY, size: 1.67 },
    });

    const distinct = validateCreateTargetSlots(
        [mk('slot-77', 0.000318), mk('slot-78', 0.000319)],
        new Map(), LOW_PRECISION_ASSETS, []
    );
    assert.ok(
        !distinct.violations.some(v => v.reason === 'same_batch_price_duplicate'),
        'adjacent low-precision CREATE prices must not be a same-batch duplicate'
    );

    const identical = validateCreateTargetSlots(
        [mk('slot-77', 0.000318), mk('slot-78', 0.000318)],
        new Map(), LOW_PRECISION_ASSETS, []
    );
    assert.ok(
        identical.violations.some(v => v.reason === 'same_batch_price_duplicate'),
        'two CREATEs at the exact same price must still be flagged'
    );
    console.log('✅ validateCreateTargetSlots keeps adjacent low-precision prices distinct');
}

// ============================================================
// TESTS: _createOrderFromGrid price collision guard
// ============================================================

async function testCreateOrderFromGridSkipsOnCollision() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const existing = makePlacedOrder('existing-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, false, 'Should NOT call createOrder when price collision exists');
    assert.ok(manager.logs.length > 0 && manager.logs[manager.logs.length - 1].msg.includes('SKIP'),
        'Should log skip message');
    console.log('✅ _createOrderFromGrid skips create on price collision');
}

async function testCreateOrderFromGridSkipsOnPendingBroadcastPriceLevel() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);
    const manager = makeManager([target]);
    // An uncertain CREATE for a DIFFERENT slot at the SAME price level: a
    // rebuilt grid re-maps a price onto another slot id, so the slot-id check
    // alone (the previous behaviour) misses exactly the duplicate the COW
    // guard is written to block.
    manager._pendingBroadcasts = new Map([['fp-1', {
        slotId: 'other-slot',
        orderType: ORDER_TYPES.BUY,
        recordedAt: Date.now(),
        order: { id: 'other-slot', price: 100, size: 50, type: ORDER_TYPES.BUY },
    }]]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, false, 'must not duplicate a pending CREATE at the same price level from another slot');
    assert.ok(
        manager.logs.some((l) => String(l.msg).includes('PENDING-BROADCAST')),
        'the refusal must be logged as a pending-broadcast skip'
    );
    console.log('✅ _createOrderFromGrid skips a pending CREATE at the same price level (different slot)');
}

async function testCreateOrderFromGridIgnoresPendingBroadcastAtOtherPrice() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);
    const manager = makeManager([target]);
    manager._pendingBroadcasts = new Map([['fp-2', {
        slotId: 'other-slot',
        orderType: ORDER_TYPES.BUY,
        recordedAt: Date.now(),
        order: { id: 'other-slot', price: 150, size: 50, type: ORDER_TYPES.BUY },
    }]]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, true, 'a pending CREATE at another level must not block this one');
    console.log('✅ _createOrderFromGrid does not over-block on an unrelated pending CREATE');
}

async function testCreateOrderFromGridProceedsWithoutCollision() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const existing = makePlacedOrder('existing-slot', 200, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, true, 'Should call createOrder when no price collision');
    console.log('✅ _createOrderFromGrid proceeds to create without collision');
}

async function testCreateOrderFromGridSkipsOnOwnOrderId() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);
    const manager = makeManager([target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, false, 'Should skip when slot already has orderId');
    console.log('✅ _createOrderFromGrid skips when slot already has orderId');
}

async function testCreateOrderFromGridOrderIdCheckFiresBeforePriceCheck() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    // Target has orderId AND there's another order at the same price.
    // The orderId check must fire first, before the price collision check runs.
    const existing = makePlacedOrder('other-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, false, 'Should skip before reaching chain');
    // The log should mention orderId (from the first guard), not collision (from the second).
    const lastLog = manager.logs[manager.logs.length - 1];
    assert.ok(lastLog && lastLog.msg.includes('already has orderId'),
        'Log should mention orderId (first guard), not price collision');
    console.log('✅ _createOrderFromGrid orderId check fires before price collision check');
}

// ============================================================
// TESTS: _executeStartupCreateGroupBatch price collision guard
// ============================================================

async function testStartupBatchSkipsOnCollision() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    const existing = makePlacedOrder('existing-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, false, 'Should NOT call executeBatch when price collision exists');
    console.log('✅ _executeStartupCreateGroupBatch skips batch on price collision');
}

async function testStartupBatchProceedsWithoutCollision() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [['1.7.100', '1.7.100']] }; };

    const existing = makePlacedOrder('existing-slot', 200, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, true, 'Should call executeBatch when no price collision');
    console.log('✅ _executeStartupCreateGroupBatch proceeds to batch without collision');
}

async function testStartupBatchSkipsOnOwnOrderId() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);
    const manager = makeManager([target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, false, 'Should skip when slot already has orderId');
    console.log('✅ _executeStartupCreateGroupBatch skips when slot already has orderId');
}

async function testStartupBatchFiltersOnlyCollidingItems() {
    let batchOpCount = 0;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => {
        batchOpCount++;
        return { success: true, operation_results: [] };
    };

    const existing1 = makePlacedOrder('existing-buy', 100, 50, ORDER_TYPES.BUY);
    const target1 = makeVirtualOrder('target-buy', 100, 50, ORDER_TYPES.BUY);
    const target2 = makeVirtualOrder('target-sell', 150, 50, ORDER_TYPES.SELL);

    const manager = makeManager([existing1, target1, target2]);

    const group = [
        { gridOrder: target1, orderLabel: 'BUY:target-buy' },
        { gridOrder: target2, orderLabel: 'SELL:target-sell' },
    ];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchOpCount, 1, 'Should execute batch once with filtered ops');
    console.log('✅ _executeStartupCreateGroupBatch filters only colliding items in multi-order batch');
}

async function testStartupBatchNoFalseCollisionWithLowPrecisionQuote() {
    // Regression: low-precision-quote-style pair. assetB (quote) precision 4 makes an entire
    // adjacent grid band round to the same integer if a price is compared at the
    // ASSET precision (0.000318 and 0.000319 both -> 3). The tolerance-based
    // checker must keep them distinct so the whole buy ladder is placed.
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    const assets = {
        assetA: { id: '1.3.1', precision: 8, symbol: 'BASE' },
        assetB: { id: '1.3.2', precision: 4, symbol: 'QUOTE' },
    };

    const existing = makePlacedOrder('slot-77', 0.000318, 1.6706, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('slot-78', 0.000319, 1.6774, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target], assets);

    await _executeStartupCreateGroupBatch({
        group: [{ gridOrder: target, orderLabel: 'BUY:slot-78' }],
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, true,
        'Adjacent buy at 0.000319 must NOT collide with a placed buy at 0.000318 (precision-4 quote)');
    console.log('✅ Startup batch places adjacent buy with low-precision quote asset');
}

async function testStartupBatchStillCollidesAtSamePriceLowPrecision() {
    // The genuine same-price collision must still be detected with a
    // low-precision quote asset (the fix must not disable the guard).
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    const assets = {
        assetA: { id: '1.3.1', precision: 8, symbol: 'BASE' },
        assetB: { id: '1.3.2', precision: 4, symbol: 'QUOTE' },
    };

    const existing = makePlacedOrder('slot-77', 0.000318, 1.6706, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('slot-78', 0.000318, 1.6774, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target], assets);

    await _executeStartupCreateGroupBatch({
        group: [{ gridOrder: target, orderLabel: 'BUY:slot-78' }],
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, false,
        'Same-price buy must still collide with a placed buy (precision-4 quote)');
    console.log('✅ Startup batch still detects genuine same-price collision at low precision');
}

async function testCreateOrderFromGridNoFalseCollisionLowPrecision() {
    // Same regression through the single-order create path.
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const assets = {
        assetA: { id: '1.3.1', precision: 8, symbol: 'BASE' },
        assetB: { id: '1.3.2', precision: 4, symbol: 'QUOTE' },
    };

    const existing = makePlacedOrder('slot-77', 0.000318, 1.6706, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('slot-78', 0.000319, 1.6774, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target], assets);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, true,
        'Adjacent buy must not be skipped as a collision (precision-4 quote)');
    console.log('✅ _createOrderFromGrid places adjacent buy with low-precision quote asset');
}

async function testStartupBatchOrderIdCheckFiresBeforePriceCheck() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    // Target has orderId AND another order at same price. The orderId check must fire first.
    const existing = makePlacedOrder('other-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, false, 'Should skip before reaching chain');
    console.log('✅ _executeStartupCreateGroupBatch orderId check fires before price collision check');
}

async function testGridPriceIdentityPrimitives() {
    // Float noise within the relative epsilon matches; genuinely distinct
    // ladder levels (3e-3 apart) never do.
    assert.strictEqual(sameGridPrice(100.000000001, 100.000000004), true, 'float noise matches');
    assert.strictEqual(sameGridPrice(0.000318, 0.000319), false, 'distinct levels stay distinct');

    // Tolerance cap: a dust-sized order inflates calculatePriceTolerance above
    // the grid increment; the increment cap must still keep adjacent levels
    // apart.
    assert.strictEqual(
        pricesOnSameLevel(0.000318, 1e-6, ORDER_TYPES.BUY, 0.000319, 1e-6, ORDER_TYPES.BUY, LOW_PRECISION_ASSETS, 0.4),
        false,
        'increment-capped tolerance must not merge adjacent levels'
    );

    // Genesis-aware grid level identity maps a price rounded a quantum off its
    // level back to that level, while a genuinely different level resolves
    // differently.
    const levels = [0.0002333, 0.00023423, 0.00023517];
    const genesis = buildGenesisFromPriceLevels(levels[0], 0.4, 4, levels);
    assert.strictEqual(sameGridLevel(levels[0], levels[0] * (1 - 1e-6), genesis), true,
        'price rounded just off its level resolves back to it');
    assert.strictEqual(sameGridLevel(levels[0], levels[1], genesis), false,
        'adjacent levels resolve differently');
    // Out-of-rail clamping guard: two distinct below-rail prices must NOT
    // resolve "equal" via the edge clamp; float dust at the edge still matches.
    assert.strictEqual(sameGridLevel(levels[0], levels[0] * 0.8, genesis), false,
        'distinct out-of-rail prices do not match');
    assert.strictEqual(sameGridLevel(levels[0], levels[0] * (1 - 1e-12), genesis), true,
        'float dust at the edge still matches');
}

// ============================================================
// RUN ALL TESTS
// ============================================================

(async () => {
    console.log('\n========== PRICE COLLISION GUARD TESTS ==========\n');

    // pricesOnSameLevel + validateCreateTargetSlots low-precision regression
    await testPricesOnSameLevelKeepsAdjacentLevelsDistinct();
    await testValidateCreateSlotsNoFalseSameBatchDuplicate();
    await testGridPriceIdentityPrimitives();

    // _createOrderFromGrid
    await testCreateOrderFromGridSkipsOnCollision();
    await testCreateOrderFromGridSkipsOnPendingBroadcastPriceLevel();
    await testCreateOrderFromGridIgnoresPendingBroadcastAtOtherPrice();
    await testCreateOrderFromGridProceedsWithoutCollision();
    await testCreateOrderFromGridSkipsOnOwnOrderId();
    await testCreateOrderFromGridOrderIdCheckFiresBeforePriceCheck();

    // _executeStartupCreateGroupBatch
    await testStartupBatchSkipsOnCollision();
    await testStartupBatchProceedsWithoutCollision();
    await testStartupBatchSkipsOnOwnOrderId();
    await testStartupBatchFiltersOnlyCollidingItems();
    await testStartupBatchOrderIdCheckFiresBeforePriceCheck();

    // Low-precision quote asset regression (precision-4 quote asset)
    await testStartupBatchNoFalseCollisionWithLowPrecisionQuote();
    await testStartupBatchStillCollidesAtSamePriceLowPrecision();
    await testCreateOrderFromGridNoFalseCollisionLowPrecision();

    console.log('\n✅ All price collision guard tests passed!\n');
})().catch((err) => {
    console.error('\n❌ PRICE COLLISION GUARD TEST FAILED:');
    console.error(err);
    process.exit(1);
});

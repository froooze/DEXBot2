const assert = require('assert');

const {
    reconcileGridOrders,
    attemptResumePersistedGridByPriceMatch,
} = require('../modules/order/grid_reconcile');
const { clearDuplicateOrphanDetection } = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const AsyncLock = require('../modules/order/async_lock').default;

function createManager(overrides = {}) {
    const orders = new Map();
    const manager = {
        orders,
        logger: { log: () => {} },
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        },
        accountTotals: { sellFree: 0, buyFree: 0 },
        strategy: {
            hasAnyDust: () => false,
            rebalance: async () => null,
        },
        accountant: {
            addToChainFree: (orderType, size) => {
                const key = orderType === ORDER_TYPES.SELL ? 'sellFree' : 'buyFree';
                manager.accountTotals[key] = (manager.accountTotals[key] || 0) + (Number(size) || 0);
            },
        },
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(orders.values()).filter(o => o && o.type === type && o.state === state);
        },
        _gridLock: { acquire: async (fn) => await fn() },
        _fundLock: { acquire: async (fn) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async () => {},
        _updateOrder: (order) => { orders.set(order.id, order); },
        _applyOrderUpdate: async (order) => { orders.set(order.id, order); return true; },
        _orderIdAssignedAt: new Map(),
        ...overrides,
    };
    return manager;
}

async function testUnmatchedCancelReleasesFundsAndHandlesNullEntries() {
    const manager = createManager({ accountTotals: { sellFree: 1, buyFree: 0 } });

    const chainOpenOrders = [
        null,
        {
            id: '1.7.10',
            sell_price: {
                base: { amount: 1000000, asset_id: '1.3.1' },
                quote: { amount: 500000, asset_id: '1.3.0' },
            },
            for_sale: 1000000,
        },
    ];

    let cancelCalls = 0;
    let currentChainOrders = [...chainOpenOrders];
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({
            op: {
                op_name: 'limit_order_update',
                op_data: {
                    fee: { amount: 0, asset_id: '1.3.0' }
                }
            }
        }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async (_account, _privateKey, orderId) => {
            cancelCalls++;
            currentChainOrders = currentChainOrders.filter((order) => order?.id !== orderId);
        },
        createOrder: async () => [],
        readOpenOrders: async () => currentChainOrders,
    };

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 0, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelCalls, 1, 'Should cancel unmatched excess chain order');
    assert.strictEqual(manager.accountTotals.sellFree, 11, 'Should release cancelled unmatched SELL size to sellFree');
    console.log('✅ Regression 1 passed: unmatched cancel releases funds and null chain entries are tolerated');
}

async function testVerifiedAfterFailureWithEmptyRefetchDefersSync() {
    const manager = createManager({ accountTotals: { sellFree: 1, buyFree: 0 } });

    let syncCalls = 0;
    (manager as any).syncFromOpenOrders = async () => {
        syncCalls++;
        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
    };

    let cancelCalls = 0;
    let preCancelRead = true;
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => {
            cancelCalls++;
            preCancelRead = false;
            return { success: true, orderId: '1.7.11', verified: true, verifiedAfterFailure: true };
        },
        createOrder: async () => [],
        readOpenOrders: async (accountRef) => {
            assert.strictEqual(accountRef, 'acct', 'Fallback refetch should resolve the account reference');
            return preCancelRead ? chainOpenOrders : [];
        },
    };

    const chainOpenOrders = [
        {
            id: '1.7.11',
            sell_price: {
                base: { amount: 1000000, asset_id: '1.3.1' },
                quote: { amount: 500000, asset_id: '1.3.0' },
            },
            for_sale: 1000000,
        },
    ];

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 0, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelCalls, 1, 'Should attempt one cancel');
    assert.strictEqual(syncCalls, 0,
        'Empty refetch after a verified cancel is ambiguous (node may be lagging) — the full sync must defer ' +
        'so pass-1 phantom cleanup cannot virtualize live ACTIVE/PARTIAL slots');
    assert.strictEqual(manager.accountTotals.sellFree, 11, 'Fallback cancel should still release unmatched funds');
    console.log('✅ Regression 1b passed: verifiedAfterFailure cancel defers the full sync on an empty refetch');
}

async function testSkipUpdateWhenSlotAlreadyMapped() {
    const manager = createManager({ accountTotals: { sellFree: 100, buyFree: 100 } });

    manager.orders.set('sell-1', {
        id: 'sell-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        price: 0.5,
        size: 10,
        orderId: null,
    });

    let addToChainFreeCalls = 0;
    manager.accountant = {
        addToChainFree: () => { addToChainFreeCalls++; },
    };

    // Simulate race: by the time update executes, slot was already mapped by recovery sync.
    const mapGet = manager.orders.get.bind(manager.orders);
    manager.orders.get = (id) => {
        const slot = mapGet(id);
        if (!slot) return slot;
        return { ...slot, state: ORDER_STATES.ACTIVE, orderId: '1.7.20' };
    };

    let updateCalls = 0;
    const chainOrders = {
        updateOrder: async () => { updateCalls++; },
        buildUpdateOrderOp: async () => ({
            op: {
                op_name: 'limit_order_update',
                op_data: {
                    fee: { amount: 0, asset_id: '1.3.0' }
                }
            }
        }),
        executeBatch: async () => { updateCalls++; return { success: true, operation_results: [] }; },
        cancelOrder: async () => {},
        createOrder: async () => [],
        readOpenOrders: async () => [],
    };

    const chainOpenOrders = [
        {
            id: '1.7.20',
            sell_price: {
                base: { amount: 1000000, asset_id: '1.3.1' },
                quote: { amount: 500000, asset_id: '1.3.0' },
            },
            for_sale: 1000000,
        },
    ];

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 1, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(updateCalls, 0, 'Should skip update batch when slot already mapped to same chain order');
    assert.strictEqual(addToChainFreeCalls, 0, 'Should not addToChainFree when update is skipped');
    console.log('✅ Regression 2 passed: stale-slot update is skipped without double credit');
}

async function testAttemptResumeAwaitsStoreGrid() {
    const gridPath = require.resolve('../modules/order/grid');
    const realGrid = require(gridPath);
    const gridStub = Object.assign({}, realGrid);
    const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
    setCachedModule(gridPath, gridStub);

    try {
        gridStub.loadGrid = async () => {};

        const manager = {
            orders: new Map([
                ['slot-1', { id: 'slot-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, orderId: '1.7.77' }],
            ]),
            synchronizeWithChain: async () => {},
        };

        let storeResolved = false;
        const storeGrid = async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            storeResolved = true;
        };

        const result = await attemptResumePersistedGridByPriceMatch({
            manager,
            persistedGrid: [{ id: 'slot-1', state: ORDER_STATES.ACTIVE, orderId: '1.7.77' }],
            chainOpenOrders: [{ id: '1.7.77' }],
            logger: { log: () => {} },
            storeGrid,
        });

        assert.strictEqual(result.resumed, true, 'Price match resume should succeed');
        assert.strictEqual(storeResolved, true, 'Resume should await async storeGrid completion');
        console.log('✅ Regression 3 passed: attemptResume waits for async storeGrid');
    } finally {
        restoreCachedModule(gridPath, null);
    }
}

async function testPhase3CancelsStaleSurplusUntrackedByGrid() {
    // Regression: after Phase 2 updates+creates settle, any stale chain order
    // that exceeds the target per side AND is not tracked by the grid must be
    // cancelled in Phase 3 — even when matchedOnGrid was 0 on a fresh grid.

    const orders = new Map();
    const chainOpenOrders: any[] = [];
    let orderCounter = 100;
    const sellPrices = [1010, 1020, 1030, 1040, 1050, 1060, 1070];

    // 7 sell orders on chain, target is 5 → 2 surplus
    for (const price of sellPrices) {
        const id = `1.7.${orderCounter++}`;
        chainOpenOrders.push({
            id,
            sell_price: { base: { amount: 100000, asset_id: '1.3.1' }, quote: { amount: Math.round(price * 100), asset_id: '1.3.0' } },
            for_sale: 100000,
        });
    }

    // Grid has 5 virtual sell slots (no orderIds) — simulates a fresh grid
    // where the first 5 chain orders will be updated to these slots.
    // The 6th and 7th chain orders are untracked surplus.
    for (let i = 0; i < 5; i++) {
        const price = 1000 + i * 10;
        orders.set(`sell-${i}`, { id: `sell-${i}`, price, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, orderId: '', size: 100 });
    }

    // Track which chain order IDs are returned by readOpenOrders at Phase 3.
    // We return ALL original chain orders (the surplus ones haven't been
    // cancelled yet from the perspective of the re-fetch).
    let cancelCalls: string[] = [];
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async (account: any, privateKey: any, orderId: string) => { cancelCalls.push(orderId); },
        createOrder: async () => [],
        readOpenOrders: async () => chainOpenOrders,
    };

    const manager = {
        orders,
        logger: { log: () => {} },
        assets: { assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' }, assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' } },
        accountTotals: { sellFree: 10000, buyFree: 10000 },
        getOrdersByTypeAndState: (type: any, state: any) => Array.from(orders.values()).filter((o: any) => o && o.type === type && o.state === state),
        _gridLock: { acquire: async (fn: any) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async (data: any) => {
            // Simulate Phase 2 finalization: register the orderId on the grid slot
            // so Phase 3 can distinguish tracked vs untracked orders.
            if (data && data.gridOrderId && data.chainOrderId) {
                const slot = orders.get(data.gridOrderId);
                if (slot) {
                    orders.set(data.gridOrderId, { ...slot, orderId: data.chainOrderId, state: ORDER_STATES.ACTIVE });
                }
            }
        },
        _applyOrderUpdate: async (order: any) => { orders.set(order.id, order); return true; },
        accountant: { addToChainFree: async () => {} },
    };

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 5, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    // After Phase 2, 5 chain orders get updated to grid slots via _applySync
    // (the mock now registers chainOrderId on the grid slot). Phase 3 re-fetches
    // chain orders and must cancel exactly the 2 untracked surplus (7 > 5).
    // The guard at matchedOnGrid=0 prevents Phase 1 from cancelling these;
    // testNoExcessCancelWhenMatchedOnGridIsZero covers that separately.
    assert.strictEqual(cancelCalls.length, 2,
        `Phase 3 should cancel exactly 2 untracked surplus sells (got ${cancelCalls.length})`);

    // Collect orderIds that Phase 2 registered on grid slots (tracked orders).
    const gridTrackedIds = new Set<string>();
    for (const order of manager.orders.values()) {
        if (order.orderId) gridTrackedIds.add(order.orderId);
    }

    // The grid should track at most 5 orderIds (the target for sells).
    // It may track fewer if some Phase 2 updates were skipped, but must
    // not exceed the target.
    assert.ok(gridTrackedIds.size <= 5,
        `Grid should track at most 5 orderIds (got ${gridTrackedIds.size})`);

    // Every cancelled order must be UNTRACKED by the grid — Phase 3 must
    // NOT cancel orders that were successfully updated in Phase 2.
    for (const cid of cancelCalls) {
        assert.ok(!gridTrackedIds.has(cid),
            `Phase 3 must NOT cancel tracked order ${cid}`);
    }

    // Every cancelled order must be a real chain order.
    const chainOrderIdSet = new Set(chainOpenOrders.map((o: any) => o.id));
    for (const cid of cancelCalls) {
        assert.ok(chainOrderIdSet.has(cid),
            `Cancelled order ${cid} must be one of the chain open orders`);
    }

    console.log('✅ Regression 6 passed: Phase 3 cancels stale surplus orders untracked by grid');
}

async function testNoExcessCancelWhenMatchedOnGridIsZero() {
    // Regression: When matchedOnGrid === 0 (fresh grid, all VIRTUAL),
    // _reconcileStartupSide must NOT cancel chain orders as "excess".
    // Previously cancelCount = chainCount - targetCount would cancel
    // legitimate orders that simply hadn't been matched yet.

    const orders = new Map();
    const chainOpenOrders = [];
    const buyPrices = [1000, 990, 980, 970, 960];
    const sellPrices = [1010, 1020, 1030, 1040, 1050];
    let orderCounter = 1;

    for (const price of sellPrices) {
        const id = `1.7.${orderCounter++}`;
        chainOpenOrders.push({
            id,
            sell_price: { base: { amount: 100000, asset_id: '1.3.1' }, quote: { amount: Math.round(price * 100), asset_id: '1.3.0' } },
            for_sale: 100000,
        });
    }
    for (const price of buyPrices) {
        const id = `1.7.${orderCounter++}`;
        chainOpenOrders.push({
            id,
            sell_price: { base: { amount: Math.round(price * 100), asset_id: '1.3.0' }, quote: { amount: 100000, asset_id: '1.3.1' } },
            for_sale: 100000,
        });
    }

    // Populate grid with VIRTUAL orders (no orderIds) — simulates fresh grid.
    for (let i = 0; i < 10; i++) {
        const price = 950 + i * 10;
        orders.set(`slot-${i}`, { id: `slot-${i}`, price, type: i < 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, orderId: '', size: 100 });
    }

    let cancelCalls = 0;
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => { cancelCalls++; },
        createOrder: async () => [],
        readOpenOrders: async () => [],
    };

    const manager = {
        orders,
        logger: { log: () => {} },
        assets: { assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' }, assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' } },
        accountTotals: { sellFree: 10000, buyFree: 10000 },
        getOrdersByTypeAndState: (type, state) => Array.from(orders.values()).filter(o => o && o.type === type && o.state === state),
        _gridLock: { acquire: async (fn) => await fn() },
        _fundLock: { acquire: async (fn) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async () => {},
        _applyOrderUpdate: async (order) => { orders.set(order.id, order); return true; },
        accountant: { addToChainFree: async () => {} },
    };

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 5, buy: 5 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    // matchedOnGrid was 0 (all VIRTUAL), so cancelCount should be 0.
    // Any cancel call means the guard failed.
    assert.strictEqual(cancelCalls, 0,
        `matchedOnGrid=0 must not issue excess cancels (got ${cancelCalls})`);
    console.log('✅ Regression 5 passed: no excess cancel when matchedOnGrid is zero (fresh grid)');
}

// Regression 8: phantom cleanup must defer freshly assigned orderIds.
// An orderId stamped in _orderIdAssignedAt within SYNC_LOCK_TIMEOUT_MS may be
// an in-flight create/adopt broadcast not yet visible to a lagging/truncated
// read. Virtualizing it and re-creating would duplicate a real live order
// (the reconcile-timeout death-spiral root cause on 2026-07-28).
async function testPhantomCleanupDefersFreshlyAssignedOrderIds() {
    const logs: string[] = [];
    const manager = createManager({
        logger: { log: (msg: string) => logs.push(msg) },
    });

    // Freshly assigned orderId (create broadcast moments ago).
    manager._orderIdAssignedAt.set('1.7.500', Date.now());
    manager.orders.set('buy-1', {
        id: 'buy-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1.0,
        size: 10,
        orderId: '1.7.500',
    });

    let virtualizeCalls = 0;
    manager._applyOrderUpdate = async (order: any) => {
        if (order.orderId === '') virtualizeCalls++;
        manager.orders.set(order.id, order);
        return true;
    };

    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => {},
        createOrder: async () => [],
        readOpenOrders: async () => [],
    };

    // Snapshot does NOT include 1.7.500 — absent from the (lagging/truncated) read.
    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 0, buy: 1 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders: [],
    });

    const slot = manager.orders.get('buy-1');
    assert.strictEqual(slot.state, ORDER_STATES.ACTIVE,
        'freshly assigned order must NOT be virtualized');
    assert.strictEqual(slot.orderId, '1.7.500',
        'freshly assigned orderId must be preserved');
    assert.strictEqual(virtualizeCalls, 0,
        'phantom cleanup must not virtualize a freshly assigned slot');
    assert(logs.some((l: string) => l.includes('deferring phantom cleanup')),
        'should log the phantom-cleanup deferral');
    console.log('✅ Regression 8 passed: phantom cleanup defers freshly assigned orderIds');
}

// Regression 7: _fundLock serialization in the recalculateGrid wrap.
// Uses a real AsyncLock (not a passthrough mock) to verify that concurrent
// fund operations observe the post-resetFunds state only after the lock releases.
async function testRecalculateGridFundLockSerialization() {
    console.log(' - Regression 7: recalculateGrid _fundLock serializes concurrent fund operations...');

    const settleQueue: Array<() => void> = [];
    const waitForSettle = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    // Manager with a real _fundLock so serialization is observable.
    let accountTotals: any = { sellFree: 100, buyFree: 100 };
    const manager = {
        _fundLock: new AsyncLock(),
        funds: { btsFeesOwed: 50 },
        accountTotals,
        resetFunds: () => {
            accountTotals.sellFree = 0;
            accountTotals.buyFree = 0;
            manager.funds.btsFeesOwed = 0;
        },
        persistGrid: async (_a?: any, _b?: any, _c?: any) => {},
        logger: { log: () => {} },
        accountOrders: { storeMasterGrid: async () => {} },
        orders: new Map(),
        config: { assetA: 'BTS', assetB: 'USD' },
        assets: {},
        boundaryIdx: null,
        _lastGridPricingContext: null,
        validateGridStateForPersistence: () => ({ isValid: true }),
        _gridPersistenceSuspendedReason: null,
        _gridDirtyAt: null,
        _clearGridDirty: () => {},
    };

    // Context A: holds _fundLock for 80ms (simulating the recalculateGrid wrap).
    let wrapReleased = false;
    const contextA = manager._fundLock.acquire(async () => {
        await manager.resetFunds();
        await new Promise(r => setTimeout(r, 80));
        wrapReleased = true;
    });

    // Yield so A acquires _fundLock first.
    await waitForSettle(10);

    // Context B: tries to mutate accountTotals via _fundLock (simulating
    // tryDeductFromChainFree or setAccountTotals). Should block until A releases.
    let contextBElapsed = -1;
    let observedBtsFeesOwed: any = null;
    let observedSellFree: any = null;
    const contextB = (async () => {
        const start = Date.now();
        await manager._fundLock.acquire(async () => {
            observedBtsFeesOwed = manager.funds.btsFeesOwed;
            observedSellFree = manager.accountTotals.sellFree;
        });
        contextBElapsed = Date.now() - start;
    })();

    // Both must complete within 2s (no deadlock).
    let deadlockTimer: any = null;
    const deadlockGuard = new Promise((_, reject) => {
        deadlockTimer = setTimeout(() => reject(new Error('DEADLOCK: contexts did not complete within 2s')), 2000);
    });
    try {
        await Promise.race([
            Promise.all([contextA, contextB]),
            deadlockGuard,
        ]);
    } finally {
        clearTimeout(deadlockTimer);
    }

    assert.strictEqual(wrapReleased, true, 'Context A (wrap) must complete');
    assert.strictEqual(contextBElapsed >= 30, true,
        `Context B must wait for A to release _fundLock (took ${contextBElapsed}ms)`);

    // Context B must observe the post-resetFunds state (zeroed), not the initial state.
    assert.strictEqual(observedBtsFeesOwed, 0, 'Context B must see btsFeesOwed=0 (post-resetFunds)');
    assert.strictEqual(observedSellFree, 0, 'Context B must see accountTotals.sellFree=0 (post-resetFunds)');

    console.log('  PASS: _fundLock serialization verified');
}

function makeDuplicateOrphanScenario(overrides: any = {}) {
    const manager = createManager({
        orders: new Map([
            ['sell-1', { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1.0, size: 10, orderId: '1.7.G' }],
        ]),
        accountTotals: { sellFree: 100, buyFree: 0 },
        _fundLock: { acquire: async (fn: any) => await fn() },
        ...overrides,
    });

    const chainOpenOrders = [
        { id: '1.7.G', sell_price: { base: { amount: 10000000, asset_id: '1.3.1' }, quote: { amount: 10000000, asset_id: '1.3.0' } }, for_sale: 1000000 },
        { id: '1.7.U', sell_price: { base: { amount: 10000000, asset_id: '1.3.1' }, quote: { amount: 10000000, asset_id: '1.3.0' } }, for_sale: 10000 },
    ];

    let cancelCalls = 0;
    let currentChainOrders = [...chainOpenOrders];
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async (_account, _privateKey, orderId) => {
            cancelCalls++;
            currentChainOrders = currentChainOrders.filter((order) => order?.id !== orderId);
        },
        createOrder: async () => [],
        readOpenOrders: async () => currentChainOrders,
        wasRecentlyOwnCancelled: () => false,
        ...overrides.chainOrders,
    };

    return { manager, chainOpenOrders, chainOrders, cancelCalls: () => cancelCalls };
}

// Regression 9a: an orphan already queued for cancel-only correction by the sync
// layer must not be re-detected (no second cancel), but its untracked funds must
// still be released — the correction path does not perform the release.
async function testQueuedDuplicateDefersCancelButReleasesFunds() {
    const { manager, chainOpenOrders, chainOrders, cancelCalls } = makeDuplicateOrphanScenario({
        ordersNeedingPriceCorrection: [{ chainOrderId: '1.7.U', isSurplus: true, cancelOnly: true }],
    });

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 1, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelCalls(), 0, 'Already-queued duplicate must NOT be re-cancelled by reconcile');
    assert.strictEqual(manager.accountTotals.sellFree, 100.1,
        'Already-queued duplicate must still release untracked funds to sellFree');
    console.log('✅ Regression 9a passed: queued duplicate defers cancel but releases funds');
}

// Regression 9b: an orphan already cancelled moments ago by the sync-layer
// correction (own-cancel marker set, stale startup snapshot) must not be
// re-cancelled, and its untracked funds must still be released.
async function testOwnCancelledDuplicateDefersCancelButReleasesFunds() {
    const { manager, chainOpenOrders, chainOrders, cancelCalls } = makeDuplicateOrphanScenario({
        chainOrders: { wasRecentlyOwnCancelled: (id: string) => id === '1.7.U' },
    });

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 1, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelCalls(), 0, 'Own-cancelled duplicate must NOT be re-cancelled by reconcile');
    assert.strictEqual(manager.accountTotals.sellFree, 100.1,
        'Own-cancelled duplicate must still release untracked funds to sellFree');
    console.log('✅ Regression 9b passed: own-cancelled duplicate defers cancel but releases funds');
}

// Regression 9c: a genuine duplicate not owned by the sync layer is still
// detected, cancelled, and its untracked funds released (pre-change behavior).
async function testUntrackedDuplicateStillCancelledAndReleasesFunds() {
    const { manager, chainOpenOrders, chainOrders, cancelCalls } = makeDuplicateOrphanScenario();

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 1, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelCalls(), 1, 'Untracked duplicate must still be cancelled by reconcile');
    assert.strictEqual(manager.accountTotals.sellFree, 100.1,
        'Cancelled untracked duplicate must release funds to sellFree');
    console.log('✅ Regression 9c passed: untracked duplicate still cancelled with fund release');
}

// Regression 9d: when the cancel hits "order does not exist" (stale snapshot —
// the sync-layer correction beat reconcile to it and the 5s own-cancel TTL
// lapsed), the untracked funds must STILL be released. Before the fix the
// throw skipped the addToChainFree block and the funds were stranded.
async function testOrderGoneCancelStillReleasesFunds() {
    const cancelAttempts = [];
    const { manager, chainOpenOrders, chainOrders } = makeDuplicateOrphanScenario({
        chainOrders: {
            cancelOrder: async () => {
                cancelAttempts.push('1.7.U');
                throw new Error('assert_exception: Assert Exception: unable to find object 1.7.U');
            },
        },
    });

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 1, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelAttempts.length, 1, 'cancelOrder must be attempted once');
    assert.strictEqual(manager.accountTotals.sellFree, 100.1,
        'ORDER_GONE cancel must still release untracked funds to sellFree');
    console.log('✅ Regression 9d passed: order-gone cancel still releases untracked funds');
}

async function testStartupRejectsChangedCancellationSnapshot() {
    const manager = createManager({ accountTotals: { sellFree: 0, buyFree: 0 } });
    const initial = {
        id: '1.7.700',
        sell_price: {
            base: { amount: 1000000, asset_id: '1.3.1' },
            quote: { amount: 500000, asset_id: '1.3.0' },
        },
        for_sale: 1000000,
    };
    const changed = {
        ...initial,
        sell_price: {
            ...initial.sell_price,
            quote: { amount: 600000, asset_id: '1.3.0' },
        },
    };
    let cancelCalls = 0;
    // The reconcile refreshes the chain snapshot AFTER acquiring placement
    // (planning must not run on a pre-wait view), then re-reads again right
    // before executing a cancel. Model that: the first (planning) read is the
    // caller's snapshot, and the pre-cancel read observes the change.
    let readCalls = 0;
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => { cancelCalls++; },
        createOrder: async () => [],
        readOpenOrders: async () => {
            readCalls++;
            return readCalls === 1 ? [initial] : [changed];
        },
    };

    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 0, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders: [initial],
    });

    assert.strictEqual(cancelCalls, 0, 'a changed pre-cancel chain snapshot must invalidate the startup plan');
    console.log('✅ Regression 9f passed: startup cancellation revalidates the chain snapshot');
}

async function testStartupAllowsUntouchedPlanAfterEarlierCorrectionCancel() {
    const manager = createManager({ accountTotals: { sellFree: 0, buyFree: 0 } });
    const makeOrder = (id: string) => ({
        id,
        sell_price: {
            base: { amount: 1000000, asset_id: '1.3.1' },
            quote: { amount: 500000, asset_id: '1.3.0' },
        },
        for_sale: 1000000,
    });
    const alreadyCancelledByCorrection = makeOrder('1.7.701');
    const untouchedPlan = makeOrder('1.7.702');
    let cancelCalls = [];
    let currentChainOrders = [untouchedPlan];
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async (_account, _privateKey, orderId) => {
            cancelCalls.push(orderId);
            currentChainOrders = currentChainOrders.filter((order) => order?.id !== orderId);
        },
        createOrder: async () => [],
        readOpenOrders: async () => currentChainOrders,
    };

    // This is the startup shape: the correction drain already removed one
    // order, while reconcile still receives the pre-drain Phase-1 snapshot.
    await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 0, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders: [alreadyCancelledByCorrection, untouchedPlan],
    });

    assert.deepStrictEqual(cancelCalls, [untouchedPlan.id],
        'the unchanged plan should still execute after an unrelated earlier cancel');
    console.log('✅ Regression 9g passed: startup cancellation validates plans independently');
}

async function testStartupAmbiguousReadSkipsCancellations() {
    const initial = {
        id: '1.7.703',
        sell_price: {
            base: { amount: 1000000, asset_id: '1.3.1' },
            quote: { amount: 500000, asset_id: '1.3.0' },
        },
        for_sale: 1000000,
    };
    const readCases: Array<{ name: string; read: () => Promise<any> }> = [
        {
            name: 'truncated',
            read: async () => ({ orders: [initial], truncated: true }),
        },
        {
            name: 'failed',
            read: async () => { throw new Error('simulated pre-cancel read failure'); },
        },
    ];

    for (const readCase of readCases) {
        const manager = createManager({ accountTotals: { sellFree: 0, buyFree: 0 } });
        let cancelCalls = 0;
        let readCalls = 0;
        const chainOrders = {
            updateOrder: async () => {},
            buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
            executeBatch: async () => ({ success: true, operation_results: [] }),
            cancelOrder: async () => { cancelCalls++; },
            createOrder: async () => [],
            readOpenOrders: async () => [initial],
            readOpenOrdersWithMeta: async () => {
                readCalls++;
                return readCase.read();
            },
        };

        await reconcileGridOrders({
            manager,
            config: { coreOrders: { sell: 0, buy: 0 } },
            account: 'acct',
            privateKey: 'pk',
            chainOrders,
            chainOpenOrders: [initial],
        });

        assert.ok(readCalls > 0, `${readCase.name} read path should be exercised`);
        assert.strictEqual(cancelCalls, 0,
            `${readCase.name} pre-cancel read must skip the stale plan`);
    }
    console.log('✅ Regression 9h passed: truncated and failed pre-cancel reads skip Phase 2');
}

// Regression 9e: a duplicate orphan whose cancel keeps failing must NOT loop
// silently at info — the same orderId re-detected on a later reconcile
// escalates to warn (rate-limited).
async function testPersistentDuplicateEscalatesToWarn() {
    const cancelAttempts = [];
    const { manager, chainOpenOrders, chainOrders } = makeDuplicateOrphanScenario({
        chainOrders: {
            cancelOrder: async () => {
                cancelAttempts.push('1.7.U');
                throw new Error('transient rpc failure');
            },
        },
    });
    const logs = [];
    manager.logger = { log: (msg: any, level: any) => { logs.push({ msg: String(msg), level }); } } as any;
    const cfg = { coreOrders: { sell: 1, buy: 0 } };

    try {
        await reconcileGridOrders({ manager, config: cfg, account: 'acct', privateKey: 'pk', chainOrders, chainOpenOrders });
        await reconcileGridOrders({ manager, config: cfg, account: 'acct', privateKey: 'pk', chainOrders, chainOpenOrders });

        const dupLogs = logs.filter(l => l.msg.includes('SUSPECTED DUPLICATE'));
        assert.ok(dupLogs.length >= 2, `duplicate must be re-detected across reconciles, got ${dupLogs.length}`);
        assert.strictEqual(dupLogs[0].level, 'info', `first sighting must log at info, got ${dupLogs[0].level}`);
        assert.strictEqual(dupLogs[1].level, 'warn', `persistent duplicate must escalate to warn, got ${dupLogs[1].level}`);
        assert.ok(dupLogs[1].msg.includes('re-detected'), 'escalated log should note the re-detection');
        assert.ok(cancelAttempts.length >= 2, 'cancel must keep being attempted');
    } finally {
        // Reset the module-level escalation counter so other regressions stay clean.
        clearDuplicateOrphanDetection('1.7.U');
    }
    console.log('✅ Regression 9e passed: persistent duplicate escalates info -> warn');
}

// Regression 9i: the reconcile is a token-level placement holder (Phase 1 plan
// + Phase 2 broadcast). If the stale-region watchdog force-released its lease
// after planning, Phase 2 must be discarded — broadcasting the plan without the
// region is the duplicate window the teardown exists to avoid.
async function testPlanDiscardedWhenPlacementLeaseWasTornDown() {
    let leaseReleases = 0;
    let regionStarts = 0;
    let regionStops = 0;
    const { manager, chainOpenOrders, chainOrders, cancelCalls } = makeDuplicateOrphanScenario({
        acquirePlacement: async () => ({ kind: 'startup-reconcile', release: () => { leaseReleases++; } }),
        isPlacementLeaseCurrent: () => false,
        startBroadcasting: () => { regionStarts++; },
        stopBroadcasting: () => { regionStops++; },
    });
    const logs = [];
    manager.logger = { log: (msg: any, level: any) => { logs.push({ msg: String(msg), level }); } } as any;

    const result = await reconcileGridOrders({
        manager,
        config: { coreOrders: { sell: 1, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(result, null, 'a reconcile without its region must discard the plan');
    assert.strictEqual(cancelCalls(), 0, 'no Phase-2 mutation may run without the region');
    assert.strictEqual(regionStarts, 1, 'Phase 1 still starts its broadcast region');
    assert.strictEqual(regionStops, 1, 'the refused reconcile must release the broadcast region');
    assert.strictEqual(leaseReleases, 1, 'the stale lease must still be released (no leak)');
    assert.ok(
        logs.some((l) => l.msg.includes('placement lease was force-released after planning')),
        'the refusal must be logged'
    );
    console.log('✅ Regression 9i passed: reconcile discards its plan when the placement lease was torn down');
}

(async () => {
    console.log('\n========== STARTUP RECONCILE REGRESSION TESTS ==========\n');
    await testUnmatchedCancelReleasesFundsAndHandlesNullEntries();
    await testVerifiedAfterFailureWithEmptyRefetchDefersSync();
    await testSkipUpdateWhenSlotAlreadyMapped();
    await testAttemptResumeAwaitsStoreGrid();
    await testNoExcessCancelWhenMatchedOnGridIsZero();
    await testPhase3CancelsStaleSurplusUntrackedByGrid();
    await testPhantomCleanupDefersFreshlyAssignedOrderIds();
    await testRecalculateGridFundLockSerialization();
    await testQueuedDuplicateDefersCancelButReleasesFunds();
    await testOwnCancelledDuplicateDefersCancelButReleasesFunds();
    await testUntrackedDuplicateStillCancelledAndReleasesFunds();
    await testOrderGoneCancelStillReleasesFunds();
    await testPersistentDuplicateEscalatesToWarn();
    await testStartupRejectsChangedCancellationSnapshot();
    await testStartupAllowsUntouchedPlanAfterEarlierCorrectionCancel();
    await testStartupAmbiguousReadSkipsCancellations();
    await testPlanDiscardedWhenPlacementLeaseWasTornDown();
    console.log('\n✅ Startup reconcile regression tests passed!\n');
})().catch((err) => {
    console.error('\n❌ STARTUP RECONCILE REGRESSION TEST FAILED:');
    console.error(err);
    process.exit(1);
});

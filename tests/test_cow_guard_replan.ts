const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM namespaces are frozen and require.cache injection cannot
// intercept static ESM imports, so chain_orders is replaced via loader hooks
// (same technique as test_cow_ops_per_broadcast). Swappable functions resolve
// per-test overrides at CALL time: assignments mutate the override map through
// the Proxy while consumers' captured named-export bindings stay valid.
esmMockEntry();

function makeSwappableModule(defaults: Record<string, any>) {
    const overrides = new Map<string, any>();
    const resolved = (key: string) => (overrides.has(key) ? overrides.get(key) : defaults[key]);
    const target: Record<string, any> = {};
    for (const key of Object.keys(defaults)) {
        target[key] = typeof defaults[key] === 'function'
            ? (...args: any[]) => resolved(key)(...args)
            : defaults[key];
    }
    return new Proxy(target, {
        set(_t: any, prop: string | symbol, value: any) {
            const key = String(prop);
            if (target[key] === value) {
                overrides.delete(key);
            } else {
                overrides.set(key, value);
            }
            return true;
        },
    });
}

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');

const chainOrders = makeSwappableModule({
    BroadcastUncertainError,
    selectAccount: async () => {},
    setPreferredAccount: async () => {},
    resolveAccountId: async () => null,
    resolveAccountName: async () => null,
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    readSingleOrder: async () => null,
    batchReadOrders: async () => [],
    listenForFills: async () => () => {},
    updateOrder: async () => { throw new Error('updateOrder not configured for this test'); },
    createOrder: async () => { throw new Error('createOrder not configured for this test'); },
    cancelOrder: async () => { throw new Error('cancelOrder not configured for this test'); },
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    buildUpdateOrderOp: async () => { throw new Error('buildUpdateOrderOp not configured for this test'); },
    buildCreateOrderOp: async () => { throw new Error('buildCreateOrderOp not configured for this test'); },
    buildCancelOrderOp: async () => { throw new Error('buildCancelOrderOp not configured for this test'); },
    buildLiquidityPoolExchangeOp: async () => { throw new Error('buildLiquidityPoolExchangeOp not configured for this test'); },
    executeBatch: async () => { throw new Error('executeBatch not configured for this test'); },
    findOverReducingUpdateOpError: async () => null,
    wasRecentlyOwnCancelled: () => false,
    recordOwnCancel: () => {},
    broadcastTxWithClassification: async () => ({})
});
defineEsmMockAbs(require.resolve('../modules/chain_orders'), [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], chainOrders);

const DEXBot = require('../modules/dexbot_class').default;
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

let testsComplete = false;

process.on('unhandledRejection', (reason) => {
    const isPostTestWsErrorEvent = testsComplete &&
        reason &&
        (reason as any).type === 'error' &&
        (reason as any).error &&
        typeof (reason as any).error === 'object';

    if (isPostTestWsErrorEvent) {
        return;
    }

    console.error('Test failed:', reason);
    process.exit(1);
});

function createOrder(id, overrides = {}) {
    return {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1,
        size: 100,
        orderId: '1.7.100',
        ...overrides
    };
}

function createVirtualCreateAction(id, price) {
    const order = {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price,
        size: 10,
        orderId: null
    };
    return { type: COW_ACTIONS.CREATE, id, order };
}

/**
 * Fixture for the pre-broadcast stale-plan guard (bounded re-plan).
 *
 * Mirrors the real manager's stack contract: performSafeRebalance pushes a
 * fresh working grid onto _currentWorkingGridStack (via _pushWorkingGridRef,
 * which also sets the result's push marker), _commitWorkingGrid releases the
 * top once on every terminal path and clears the marker via options.result,
 * and _pushWorkingGridRef pushes a previously popped grid back (bounded
 * re-plan fall-through). Tests must push the stale plan's grid before
 * invoking the batch executor, exactly as the real flow does. The pop spy
 * THROWS on a pop from an empty stack so an unmatched pop (the pre-fix
 * double-pop imbalance) fails the test instead of being absorbed as a benign
 * underflow.
 */
function createGuardFixture(masterOrders = new Map()) {
    const bot = new DEXBot({
        botKey: 'test_cow_guard_replan',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });

    const logs: string[] = [];
    const counters = {
        commitCalls: 0,
        replanCalls: 0,
        resyncCalls: 0,
        executeBatchCalls: 0,
        clearCalls: 0,
        restoreCalls: 0
    };

    const manager: any = {
        _gridVersion: 0,
        _recoveryState: {},
        _currentWorkingGridStack: [] as any[],
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: Object.freeze(masterOrders),
        logger: {
            log: (msg: string) => { logs.push(String(msg)); },
            logFundsStatus: () => {}
        },
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async (_wg: any, _idx: any, _boundary: any, options: any) => {
            counters.commitCalls += 1;
            manager._clearWorkingGridRef();
            // Mirrors the real contract: the commit releases the stack entry
            // and clears the push marker (options.result) on every settle path.
            if (options?.result) options.result._workingGridPushed = false;
            return true;
        },
        persistGrid: async () => {},
        _clearWorkingGridRef: () => {
            counters.clearCalls += 1;
            if (manager._currentWorkingGridStack.length === 0) {
                throw new Error('UNMATCHED WORKING-GRID POP (stack underflow)');
            }
            manager._currentWorkingGridStack.pop();
        },
        _pushWorkingGridRef: (workingGrid: any, result: any) => {
            counters.restoreCalls += 1;
            manager._currentWorkingGridStack.push(workingGrid);
            if (result) result._workingGridPushed = true;
        },
        _popWorkingGridRef: (result: any) => {
            if (result && result._workingGridPushed === true) {
                manager._clearWorkingGridRef();
                result._workingGridPushed = false;
            }
        },
        requestStructuralGridResync: async () => {
            counters.resyncCalls += 1;
        },
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
        synchronizeWithChain: async () => {}
    };

    bot.manager = manager;
    bot.account = 'test-account';

    return { bot, manager, counters, logs };
}

function installChainStubs(manager: any, counters: any) {
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    chainOrders.buildCreateOrderOp = async (_account: any, _amountToSell: any, sellAssetId: string) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: { amount_to_sell: { amount: 100000, asset_id: sellAssetId } }
        },
        finalInts: { sell: 100000, receive: 10000000, sellAssetId, receiveAssetId: manager.assets.assetA.id }
    });
    chainOrders.executeBatch = async (_account: any, _key: any, ops: any[]) => {
        counters.executeBatchCalls += 1;
        const chainOrderIdBase = 3000 + Math.floor(Math.random() * 1000);
        return {
            success: true,
            operation_results: ops.map((_: any, i: number) => [null, `1.7.${chainOrderIdBase + i}`])
        };
    };

    return () => {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    };
}

function makeStaleWorkingGrid(manager: any) {
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion - 1 });
    workingGrid.set('slot-2', createVirtualCreateAction('slot-2', 1.1).order);
    return workingGrid;
}

async function testStalePlanReplansOnceAndExecutes() {
    console.log('\n[COW-GUARD-REPLAN-001] stale plan + fill context re-plans ONCE and executes the fresh plan...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    // A fill landed during planning: master version advanced past the plan.
    manager._gridVersion = 1;

    const staleWG = makeStaleWorkingGrid(manager);
    const fills = [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }];
    let replanFills: any = null;
    let replanExcludeIds: any = null;

    manager.performSafeRebalance = async (fillsArg: any, excludeIdsArg: any) => {
        counters.replanCalls += 1;
        replanFills = fillsArg;
        replanExcludeIds = excludeIdsArg;
        const freshWG = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        freshWG.set('slot-2', createVirtualCreateAction('slot-2', 1.1).order);
        manager._currentWorkingGridStack.push(freshWG);
        return {
            workingGrid: freshWG,
            workingIndexes: freshWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            _workingGridPushed: true
        };
    };

    try {
        // Mirrors the real push contract: performSafeRebalance pushes the
        // plan's grid and marks the result before the batch executor runs.
        manager._currentWorkingGridStack.push(staleWG);
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills,
            excludeIds: new Set(['slot-1']),
            _workingGridPushed: true
        });

        assert.strictEqual(result.executed, true, 'fresh plan must execute');
        assert.strictEqual(counters.replanCalls, 1, 'must re-plan exactly once');
        assert.strictEqual(replanFills, fills, 're-plan must receive the same fill context');
        assert(replanExcludeIds instanceof Set, 're-plan must receive excludeIds');
        assert.strictEqual(counters.commitCalls, 1, 'exactly one commit of the fresh plan');
        assert.strictEqual(counters.executeBatchCalls, 1, 'exactly one broadcast');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        assert.strictEqual(counters.clearCalls, 2, 'original pop + commit pop');
        assert.strictEqual(counters.restoreCalls, 0, 'no restore needed when re-plan succeeds');
        assert.strictEqual(counters.resyncCalls, 0, 'no structural resync needed when re-plan succeeds');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-001 passed');
}

async function testReplanRestoresReanchorBudget() {
    console.log('\n[COW-GUARD-REPLAN-005] a stale re-plan hands back the abandoned plan\'s absolute anchor...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 1;
    const staleWG = makeStaleWorkingGrid(manager);
    const fills = [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }];
    // The abandoned plan consumed the batch's single absolute anchor (1 -> 0).
    (manager as any)._boundaryReanchorBudget = 0;

    let budgetSeenDuringReplan: number | undefined;
    manager.performSafeRebalance = async () => {
        counters.replanCalls += 1;
        budgetSeenDuringReplan = (manager as any)._boundaryReanchorBudget;
        const freshWG = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        freshWG.set('slot-2', createVirtualCreateAction('slot-2', 1.1).order);
        manager._currentWorkingGridStack.push(freshWG);
        return {
            workingGrid: freshWG,
            workingIndexes: freshWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            _workingGridPushed: true
        };
    };

    try {
        manager._currentWorkingGridStack.push(staleWG);
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills,
            excludeIds: new Set(['slot-1']),
            _workingGridPushed: true,
            // Snapshot taken by processFilledOrders BEFORE planning.
            _reanchorBudgetBeforePlan: 1
        });
        assert.strictEqual(counters.replanCalls, 1, 'must re-plan once');
        assert.strictEqual(
            budgetSeenDuringReplan, 1,
            'the fresh plan must see the pre-plan anchor budget: the abandoned anchor was never committed'
        );
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-005 passed');
}

async function testReplanWithNoActionsSkipsStalePlan() {
    console.log('\n[COW-GUARD-REPLAN-002] re-plan with no executable actions skips the stale plan...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 1;
    const staleWG = makeStaleWorkingGrid(manager);

    manager.performSafeRebalance = async () => {
        counters.replanCalls += 1;
        const freshWG = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        manager._currentWorkingGridStack.push(freshWG);
        return {
            workingGrid: freshWG,
            workingIndexes: freshWG.getIndexes(),
            workingBoundary: 0,
            actions: [],
            _workingGridPushed: true
        };
    };

    try {
        // Mirrors the real push contract: the stale plan's grid was pushed
        // by performSafeRebalance before this batch executor call.
        manager._currentWorkingGridStack.push(staleWG);
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills: [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }],
            _workingGridPushed: true
        });

        assert.strictEqual(result.executed, false, 'stale plan must not ship');
        assert.strictEqual(result.skippedStalePlan, true, 'must report skipped stale plan');
        assert.strictEqual(counters.replanCalls, 1, 're-plan attempted once');
        assert.strictEqual(counters.executeBatchCalls, 0, 'no broadcast for a skipped plan');
        assert.strictEqual(counters.commitCalls, 0, 'no commit for a skipped plan');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        assert.strictEqual(counters.clearCalls, 2, 'original pop + fresh-plan pop');
        assert.strictEqual(counters.restoreCalls, 0, 'no restore needed when re-plan succeeds');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-002 passed');
}

async function testStaleAtReplanLimitProceedsWithResync() {
    console.log('\n[COW-GUARD-REPLAN-003] still stale at re-plan limit proceeds with plan and requests structural resync...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters, logs } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 1;
    const staleWG = makeStaleWorkingGrid(manager);

    try {
        // Mirrors the real push contract: the stale plan's grid was pushed
        // by performSafeRebalance before this batch executor call.
        manager._currentWorkingGridStack.push(staleWG);
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            _workingGridPushed: true
        }, { replanDepth: 1 });

        assert.strictEqual(result.executed, true, 'bounded policy proceeds with the plan');
        assert.strictEqual(counters.replanCalls, 0, 'no re-plan at the depth limit');
        assert.strictEqual(counters.resyncCalls, 1, 'structural resync requested exactly once');
        assert.strictEqual(manager._recoveryState.structuralResyncRequested, true, 'resync flag recorded on recovery state');
        assert.strictEqual(counters.commitCalls, 1, 'proceeded plan commits');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        assert.strictEqual(counters.restoreCalls, 0, 'no restore when the depth limit blocks re-planning');
        assert(logs.some((m: string) => m.includes('still stale after re-plan')), 'should log the depth-limit proceed decision');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-003 passed');
}

async function testReplanThrowProceedsWithResync() {
    console.log('\n[COW-GUARD-REPLAN-004] re-plan throw proceeds with original plan and requests structural resync...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters, logs } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 1;
    const staleWG = makeStaleWorkingGrid(manager);

    manager.performSafeRebalance = async () => {
        counters.replanCalls += 1;
        throw new Error('replan exploded');
    };

    try {
        // Mirrors the real push contract: the stale plan's grid was pushed
        // by performSafeRebalance before this batch executor call.
        manager._currentWorkingGridStack.push(staleWG);
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills: [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }],
            _workingGridPushed: true
        });

        assert.strictEqual(result.executed, true, 'bounded policy proceeds with the original plan');
        assert.strictEqual(counters.replanCalls, 1, 're-plan attempted once');
        assert.strictEqual(counters.resyncCalls, 1, 'structural resync requested for the re-plan failure path');
        assert.strictEqual(manager._recoveryState.structuralResyncRequested, true, 'resync flag recorded on recovery state');
        assert.strictEqual(counters.commitCalls, 1, 'proceeded plan commits');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        // The original grid is popped before the re-plan attempt, then
        // restored when the re-plan throws — the commit pops the RESTORED
        // entry, so both pops are matched (no underflow). The fixture's
        // pop spy throws on underflow, so this assertion is genuine.
        assert.strictEqual(counters.restoreCalls, 1, 'original plan grid restored after re-plan failure');
        assert.strictEqual(counters.clearCalls, 2, 'original pop + commit pop of the restored grid');
        assert(logs.some((m: string) => m.includes('Re-plan failed')), 'should log the re-plan failure');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-004 passed');
}

async function testBatchAbortsWhenPlacementLeaseWasTornDown() {
    console.log('\n[COW-GUARD-REPLAN-006] a batch whose lease the watchdog force-released must not broadcast...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters, logs } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 0;
    // Placement IS used here, but the lease is no longer the owner: the
    // stale-region watchdog force-released it after the batch parked on a slow
    // read, so another path may hold the region now.
    manager.acquirePlacement = async () => ({ kind: 'cow-broadcast', release: () => {} });
    manager.isPlacementLeaseCurrent = () => false;

    const freshWG = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    freshWG.set('slot-2', createVirtualCreateAction('slot-2', 1.1).order);

    try {
        manager._currentWorkingGridStack.push(freshWG);
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: freshWG,
            workingIndexes: freshWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills: [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }],
            excludeIds: new Set(['slot-1']),
            _workingGridPushed: true
        });
        assert.strictEqual(result.aborted, true, 'a batch without its region must abort');
        assert.strictEqual(result.reason, 'PLACEMENT_LEASE_LOST', 'abort reason must name the lost lease');
        assert.strictEqual(counters.executeBatchCalls, 0, 'nothing may be broadcast without the region');
        assert.strictEqual(counters.commitCalls, 0, 'nothing may be committed without the region');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'the abandoned grid must be popped (LIFO balance)');
        assert(
            logs.some((m: string) => m.includes('Placement lease was force-released')),
            'the abort must be logged'
        );
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-006 passed');
}

async function run() {
    console.log('Running COW guard bounded re-plan regression tests...');
    await testStalePlanReplansOnceAndExecutes();
    await testReplanRestoresReanchorBudget();
    await testReplanWithNoActionsSkipsStalePlan();
    await testStaleAtReplanLimitProceedsWithResync();
    await testReplanThrowProceedsWithResync();
    await testBatchAbortsWhenPlacementLeaseWasTornDown();
    console.log('\n✓ All COW guard re-plan regression tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
});

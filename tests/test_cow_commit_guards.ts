const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM namespaces are frozen and require.cache injection cannot
// intercept static ESM imports, so chain_orders / chain_keys are replaced via
// loader hooks (same technique as test_uncertain_broadcast). Swappable
// functions resolve per-test overrides at CALL time: assignments mutate the
// override map through the Proxy while consumers' captured named-export
// bindings stay valid.
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
    executeBatch: async () => ({ success: true, operation_results: [] }),
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

class MasterPasswordErrorStub extends Error {}

const chainKeys = makeSwappableModule({
    MasterPasswordError: MasterPasswordErrorStub,
    createDaemonSigningToken: (accountName: string, options: Record<string, any> = {}) => ({
        kind: 'dexbot-daemon-signing-token',
        accountName,
        socketPath: options.socketPath || null,
        sessionId: options.sessionId || null,
        botHmacSecret: options.botHmacSecret || null,
    }),
    isDaemonSigningToken: (value: any) => !!(value && typeof value === 'object' && value.kind === 'dexbot-daemon-signing-token' && typeof value.accountName === 'string'),
    isDaemonResponsive: async () => true,
    isDaemonReady: async () => true,
    waitForDaemon: async () => true,
    pingDaemon: async () => true,
    probeAccountInDaemon: async () => { throw new Error('probeAccountInDaemon not configured for this test'); },
});
defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
    'validatePrivateKey', 'loadAccounts', 'saveAccounts', 'checkKeysFileSecurity',
    'encrypt', 'decrypt', 'deriveVaultKey', 'createDaemonSigningToken',
    'createSessionSecret', 'createVaultSecret', 'isVaultSecret', 'isDaemonSigningToken',
    'unlockWithPassword', 'main', 'authenticate', 'getPrivateKey', 'resolvePrivateKey',
    'isMasterPasswordFailure', 'MasterPasswordError', 'isDaemonReady', 'isDaemonResponsive',
    'waitForDaemon', 'probeAccountInDaemon', 'pingDaemon'
], chainKeys);

const DEXBot = require('../modules/dexbot_class').default;
const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

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

function buildIndexes(orders) {
    const byState = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set()
    };
    const byType = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    for (const [id, order] of orders.entries()) {
        if (byState[order.state]) byState[order.state].add(id);
        if (byType[order.type]) byType[order.type].add(id);
    }

    return { byState, byType };
}

function createManagerFixture() {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
    const logs = [];
    let recalcCount = 0;

    manager.logger = {
        log: (msg, level) => logs.push({ msg, level })
    };

    manager.recalculateFunds = async () => {
        recalcCount += 1;
    };

    manager._gridVersion = 5;
    manager.boundaryIdx = 0;
    manager.config = {
        ...(manager.config || {}),
        incrementPercent: 0.5
    };
    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 8 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    const master = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    manager.orders = Object.freeze(master);

    const { byState, byType } = buildIndexes(master);
    manager._ordersByState = byState;
    manager._ordersByType = byType;

    return {
        manager,
        logs,
        getRecalcCount: () => recalcCount
    };
}

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

/** Wait until `predicate` is true, yielding between checks (bounded). */
function waitFor(predicate: () => boolean, message: string, maxMs = 2000) {
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
        const tick = () => {
            let done = false;
            try { done = !!predicate(); } catch (err) { reject(err); return; }
            if (done) return resolve();
            if (Date.now() - start >= maxMs) return reject(new Error(`Timed out waiting for ${message}`));
            setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
    });
}

function createCowExecutionFixture(masterOrders = new Map()) {
    const bot = new DEXBot({
        botKey: 'test_cow_cache_deduction',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });

    const postBatchAdjustments = [];
    const manager = {
        _gridVersion: 0,
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: Object.freeze(masterOrders),
        logger: {
            log: (msg?: any) => {},
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
        _committedWorkingGrid: null as any,
        _commitWorkingGrid: async (wg: any): Promise<boolean> => {
            // Capture the working grid presented for commit so tests can assert
            // on its in-place (normalized) state at the commit boundary. The real
            // implementation writes it to manager.orders; this mock just records it.
            (manager as any)._committedWorkingGrid = wg;
            return true;
        },
        persistGrid: async () => {},
        _clearWorkingGridRef: () => {},
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
        synchronizeWithChain: async () => {},
    };

    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';

    return { bot, manager, postBatchAdjustments };
}

async function testRejectsVersionMismatchWithoutCommit() {
    console.log('\n[COW-COMMIT-001] rejects version mismatch without commit...');

    const { manager, logs, getRecalcCount } = createManagerFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 4 });
    workingGrid.set('slot-1', createOrder('slot-1', { price: 2 }));

    (manager as any)._currentWorkingGridStack.push(workingGrid);
    manager._rebalanceState = 'BROADCASTING';

    await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0);

    assert.strictEqual(manager.orders.get('slot-1').price, 1, 'master order must remain unchanged');
    assert.strictEqual(manager._gridVersion, 5, 'grid version must not advance');
    assert.strictEqual(getRecalcCount(), 0, 'fund recalculation must be skipped for rejected commit');
    assert.strictEqual(manager._peekWorkingGrid(), null, 'working grid reference should be cleared');
    assert.strictEqual(manager._rebalanceState, 'NORMAL', 'rebalance state should be reset');
    assert(logs.some(l => String(l.msg).includes('base version')), 'should log base version mismatch');
    assert(!logs.some(l => String(l.msg).includes('Grid committed in')), 'must not log successful commit');

    console.log('✓ COW-COMMIT-001 passed');
}

async function testNoPostCommitSideEffectsWhenDeltaEmpty() {
    console.log('\n[COW-COMMIT-002] skips post-commit side effects on empty delta...');

    const { manager, logs, getRecalcCount } = createManagerFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 5 });

    (manager as any)._currentWorkingGridStack.push(workingGrid);
    manager._rebalanceState = 'BROADCASTING';

    await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0);

    assert.strictEqual(manager.orders.get('slot-1').price, 1, 'master order must remain unchanged');
    assert.strictEqual(manager._gridVersion, 5, 'grid version must not advance');
    assert.strictEqual(getRecalcCount(), 0, 'fund recalculation must be skipped for empty delta');
    assert.strictEqual(manager._peekWorkingGrid(), null, 'working grid reference should be cleared');
    assert.strictEqual(manager._rebalanceState, 'NORMAL', 'rebalance state should be reset');
    assert(logs.some(l => String(l.msg).includes('Delta empty at commit')), 'should log empty delta refusal');
    assert(!logs.some(l => String(l.msg).includes('Grid committed in')), 'must not log successful commit');

    console.log('✓ COW-COMMIT-002 passed');
}

async function testExecuteBatchIfNeededSkipsEmptyActions() {
    console.log('\n[COW-COMMIT-003] central empty-action guard skips broadcast...');

    const bot = new DEXBot({
        botKey: 'test_cow_commit_guard_empty_actions',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    const logs = [];
    let clearWorkingGridCalls = 0;
    bot.manager = {
        logger: {
            log: (msg, level) => logs.push({ msg: String(msg), level })
        },
        _clearWorkingGridRef: () => { clearWorkingGridCalls++; },
        _popWorkingGridRef: (result: any) => {
            if (result && result._workingGridPushed === true) {
                bot.manager._clearWorkingGridRef();
                result._workingGridPushed = false;
            }
        }
    };

    let batchCalls = 0;
    bot.updateOrdersOnChainBatch = async () => {
        batchCalls += 1;
        return { executed: true, hadRotation: false };
    };

    const emptyResult = await bot._executeBatchIfNeeded({ actions: [] }, 'unit-empty');
    assert.strictEqual(batchCalls, 0, 'Empty action set must not call updateOrdersOnChainBatch');
    assert.strictEqual(emptyResult.skippedNoActions, true, 'Empty action set should return skipped marker');
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('No actions needed for unit-empty')),
        'Empty action guard should emit debug log');
    // A result that was never pushed (no _workingGridPushed marker) must NOT pop
    // the working-grid stack — an unmatched pop could steal a nested grid entry.
    assert.strictEqual(clearWorkingGridCalls, 0,
        'Empty action guard must not pop the stack for a result that was never pushed');

    await bot._executeBatchIfNeeded({ actions: [], _workingGridPushed: true }, 'unit-empty-pushed');
    assert.strictEqual(clearWorkingGridCalls, 1,
        'Empty action guard must pop exactly once for a result whose grid was pushed');

    await bot._executeBatchIfNeeded({
        actions: [{ type: COW_ACTIONS.CREATE, id: 'slot-new', order: { id: 'slot-new' } }],
        workingGrid: {}
    }, 'unit-non-empty');
    assert.strictEqual(batchCalls, 1, 'Non-empty action set must execute batch once');
    // _clearWorkingGridRef for non-empty path is handled inside _updateOrdersOnChainBatchCOW
    assert.strictEqual(clearWorkingGridCalls, 1, 'Non-empty path must not double-call _clearWorkingGridRef');

    console.log('✓ COW-COMMIT-003 passed');
}

async function testRejectsCreateOnOccupiedSlotBeforeBroadcast() {
    console.log('\n[COW-COMMIT-004] rejects create on occupied slot pre-broadcast...');

    const { manager } = createManagerFixture();
    manager.assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
    };

    const bot = new DEXBot({
        botKey: 'test_cow_commit_guard_occupied_slot',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = manager;
    bot.account = { id: '1.2.999' };
    bot.privateKey = 'TEST_PRIVATE_KEY';

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    const cowResult = {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: (manager as any).boundaryIdx,
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: 'slot-1',
            order: {
                id: 'slot-1',
                type: ORDER_TYPES.SELL,
                price: 1.1,
                size: 10,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        }]
    };

    const originalExecuteBatch = chainOrders.executeBatch;
    let executeBatchCalls = 0;
    chainOrders.executeBatch = async () => {
        executeBatchCalls += 1;
        return { success: true, operation_results: [] };
    };

    try {
        const result = await bot.updateOrdersOnChainBatch(cowResult);
        assert.strictEqual(result.executed, false, 'Occupied-slot create batch must not execute');
        assert.strictEqual(result.aborted, true, 'Occupied-slot create batch should abort early');
        assert.strictEqual(result.reason, 'CREATE_SLOT_OCCUPIED', 'Abort reason should indicate occupied slot');
        assert.strictEqual(executeBatchCalls, 0, 'Pre-broadcast guard must block blockchain executeBatch call');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-004 passed');
}

async function testRejectsCreatesWhenUnmatchedChainOrdersExist() {
    console.log('\n[COW-COMMIT-005] rejects creates while unmatched chain orders exist...');

    const masterOrders = new Map([
        ['slot-new', createOrder('slot-new', {
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 1.1,
            size: 10,
            orderId: ''
        })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    let structuralResyncRequests = 0;
    let executeCalls = 0;

    (manager as any)._lastUnmatchedChainOrders = [{
        chainOrderId: '1.7.572303058',
        type: ORDER_TYPES.SELL,
        price: 1.101,
        size: 10
    }];
    (manager as any).requestStructuralGridResync = async () => {
        structuralResyncRequests += 1;
        return { scheduled: true };
    };

    const result = await bot._updateOrdersOnChainBatchCOW({
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: 0,
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: 'slot-new',
            order: {
                id: 'slot-new',
                type: ORDER_TYPES.SELL,
                price: 1.1,
                size: 10,
                state: ORDER_STATES.VIRTUAL,
                orderId: ''
            }
        }]
    });

    assert.strictEqual(result.executed, false, 'Create batch should not execute with unmatched chain orders');
    assert.strictEqual(result.aborted, true, 'Create batch should abort before broadcast');
    assert.strictEqual(result.reason, 'UNMATCHED_CHAIN_ORDERS', 'Abort reason should identify structural drift');
    assert.strictEqual(executeCalls, 0, 'No blockchain broadcast should be attempted');
    assert.strictEqual(structuralResyncRequests, 1, 'Structural resync should be requested');

    console.log('✓ COW-COMMIT-005 passed');
}

async function testMissingCreateBlockerMergesWithExistingUnmatchedOrders() {
    console.log('\n[COW-COMMIT-006] missing create blocker merges with existing unmatched orders...');

    const { bot, manager } = createCowExecutionFixture();
    (manager as any)._lastUnmatchedChainOrders = [{
        chainOrderId: '1.7.572303058',
        type: ORDER_TYPES.SELL,
        price: 1.101,
        size: 10,
        reason: 'unmatched-chain-order'
    }];

    bot._markMissingCreateResultsAsStructuralBlocker([{
        index: 2,
        ctx: {
            id: 'slot-missing-create',
            order: {
                id: 'slot-missing-create',
                type: ORDER_TYPES.BUY,
                price: 1.25,
                size: 3.5
            }
        }
    }]);
    bot._markMissingCreateResultsAsStructuralBlocker([{
        index: 2,
        ctx: {
            id: 'slot-missing-create',
            order: {
                id: 'slot-missing-create',
                type: ORDER_TYPES.BUY,
                price: 1.25,
                size: 3.5
            }
        }
    }]);

    assert.strictEqual((manager as any)._lastUnmatchedChainOrders.length, 2, 'Existing unmatched order should be preserved and duplicate blocker deduped');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders[0].chainOrderId, '1.7.572303058', 'Existing unmatched order should remain first');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders[1].reason, 'missing-create-result', 'Missing create blocker should be appended');
    assert((manager as any)._lastUnmatchedChainOrders[1].fingerprint.includes('type='), 'Missing create blocker should include local type fingerprint');
    assert((manager as any)._lastUnmatchedChainOrders[1].fingerprint.includes('price='), 'Missing create blocker should include local price fingerprint');
    assert((manager as any)._lastUnmatchedChainOrders[1].fingerprint.includes('size='), 'Missing create blocker should include local size fingerprint');

    console.log('✓ COW-COMMIT-006 passed');
}

async function testNoPostBatchCacheDeductionForCreates() {
    console.log('\n[COW-COMMIT-007] no post-batch cache deduction (handled in real-time by updateOptimisticFreeBalance)...');

    const { bot, manager, postBatchAdjustments } = createCowExecutionFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    // The COW planner would have materialized the CREATE slot into the working
    // grid before broadcast; mirror that here so Layer 2 can normalize it.
    workingGrid.set('slot-create-buy', {
        id: 'slot-create-buy',
        type: ORDER_TYPES.BUY,
        price: 1,
        size: 1.23456789,
        state: ORDER_STATES.VIRTUAL,
        orderId: null
    });

    const actions = [{
        type: COW_ACTIONS.CREATE,
        id: 'slot-create-buy',
        order: {
            id: 'slot-create-buy',
            type: ORDER_TYPES.BUY,
            price: 1,
            size: 1.23456789,
            state: ORDER_STATES.VIRTUAL,
            orderId: null
        }
    }];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildUpdateOrderOp = async () => ({ op: { op_name: 'limit_order_update', op_data: {} }, finalInts: null });
    chainOrders.buildCreateOrderOp = async () => ({
        op: {
            op_name: 'limit_order_create',
            op_data: {
                amount_to_sell: { amount: 123456, asset_id: manager.assets.assetB.id }
            }
        },
        finalInts: {
            sell: 123456,
            receive: 12345678,
            sellAssetId: manager.assets.assetB.id,
            receiveAssetId: manager.assets.assetA.id
        }
    });

    let recoverySyncCalls = 0;
    (manager as any).syncFromOpenOrders = async () => {
        recoverySyncCalls += 1;
        (manager as any)._lastUnmatchedChainOrders = [];
        (manager as any)._lastUnmatchedChainOrdersAt = 0;
        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
    };
    const originalReadOpenOrders = chainOrders.readOpenOrders;
    const originalReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    chainOrders.readOpenOrders = async () => [];
    chainOrders.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [] });

    let result;
    try {
        result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        }, { pollIntervalMs: 0 });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
        chainOrders.readOpenOrders = originalReadOpenOrders;
        chainOrders.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    // Layer 2 (normalize, don't reject): a CREATE that returned no chainOrderId
    // while the batch otherwise succeeded must be normalized IN PLACE (size 0,
    // no orderId) at the commit boundary — NOT abort the whole commit (which
    // would drop every other action and leave a permanent structural blocker
    // that blocks all future CREATEs). The committed working grid must show the
    // slot as a clean empty, never as a phantom (VIRTUAL + size>0 + no orderId).
    assert.strictEqual(result.executed, true, 'Batch with one missing create id must still commit (normalize, don\'t reject)');
    const cg007 = (manager as any)._committedWorkingGrid;
    const normalized007 = cg007?.get('slot-create-buy');
    assert(normalized007, 'Missing-create slot must be present in the committed working grid');
    assert.strictEqual(Number(normalized007.size || 0), 0, 'Missing-create slot must be normalized to a clean empty (size 0)');
    assert.strictEqual(normalized007.orderId, null, 'Normalized slot must not carry a phantom orderId');
    assert.strictEqual(recoverySyncCalls, 0, 'Missing create resolved via chain poll, not the full recovery sync');
    const blockers007 = ((manager as any)._lastUnmatchedChainOrders || []).filter((o: any) => o.reason === 'missing-create-result');
    assert.strictEqual(blockers007.length, 0, 'No permanent missing-create structural blocker (would block future CREATEs)');
    assert.strictEqual(postBatchAdjustments.length, 0, 'No post-batch cache deduction expected');

    console.log('✓ COW-COMMIT-007 passed');
}

async function testNoPostBatchCacheDeductionForMixedCreates() {
    console.log('\n[COW-COMMIT-008] no post-batch cache deduction for mixed creates...');

    const { bot, manager, postBatchAdjustments } = createCowExecutionFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    // The COW planner would have materialized the CREATE slots into the working
    // grid before broadcast; mirror that here so Layer 2 can normalize/adopt.
    workingGrid.set('slot-create-buy', {
        id: 'slot-create-buy', type: ORDER_TYPES.BUY, price: 1, size: 1,
        state: ORDER_STATES.VIRTUAL, orderId: null
    });
    workingGrid.set('slot-create-sell', {
        id: 'slot-create-sell', type: ORDER_TYPES.SELL, price: 2, size: 2,
        state: ORDER_STATES.VIRTUAL, orderId: null
    });

    const actions = [
        {
            type: COW_ACTIONS.CREATE,
            id: 'slot-create-buy',
            order: {
                id: 'slot-create-buy',
                type: ORDER_TYPES.BUY,
                price: 1,
                size: 1,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        },
        {
            type: COW_ACTIONS.CREATE,
            id: 'slot-create-sell',
            order: {
                id: 'slot-create-sell',
                type: ORDER_TYPES.SELL,
                price: 2,
                size: 2,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        }
    ];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildUpdateOrderOp = async () => ({ op: { op_name: 'limit_order_update', op_data: {} }, finalInts: null });
    chainOrders.buildCreateOrderOp = async (_account, _amountToSell, sellAssetId) => {
        if (sellAssetId === manager.assets.assetB.id) {
            return {
                op: {
                    op_name: 'limit_order_create',
                    op_data: {
                        amount_to_sell: { amount: 100000, asset_id: sellAssetId }
                    }
                },
                finalInts: {
                    sell: 100000,
                    receive: 10000000,
                    sellAssetId,
                    receiveAssetId: manager.assets.assetA.id
                }
            };
        }

        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: 200000000, asset_id: sellAssetId }
                }
            },
            finalInts: {
                sell: 200000000,
                receive: 200000,
                sellAssetId,
                receiveAssetId: manager.assets.assetB.id
            }
        };
    };

    let recoverySyncCalls = 0;
    (manager as any).syncFromOpenOrders = async () => {
        recoverySyncCalls += 1;
        (manager as any)._lastUnmatchedChainOrders = [];
        (manager as any)._lastUnmatchedChainOrdersAt = 0;
        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
    };
    const originalReadOpenOrders = chainOrders.readOpenOrders;
    chainOrders.readOpenOrders = async () => [];
    const originalReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    chainOrders.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [[1, '1.7.999']] });
    let result;
    try {
        result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        }, { pollIntervalMs: 0 });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
        chainOrders.readOpenOrders = originalReadOpenOrders;
        chainOrders.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    // Layer 2 (normalize, don't reject): exactly one CREATE (the one that
    // returned no chainOrderId) is normalized in place (size 0, no orderId) at
    // the commit boundary; the other (confirmed) keeps its size and is adopted
    // with its chain id by processBatchResults post-commit. The batch still
    // commits and no permanent structural blocker is left.
    assert.strictEqual(result.executed, true, 'Mixed batch with one missing create id must still commit');
    const cg008 = (manager as any)._committedWorkingGrid;
    const buy008 = cg008?.get('slot-create-buy');
    const sell008 = cg008?.get('slot-create-sell');
    assert(buy008 && sell008, 'Both CREATE slots must be present in the committed working grid');
    const phantom008 = [buy008, sell008].find((o: any) => Number(o.size || 0) > 0 && !o.orderId);
    // At the commit boundary the CONFIRMED slot legitimately has no orderId yet
    // (adoption happens in processBatchResults post-commit), so a size>0 slot
    // without an id here is acceptable. The dangerous shape is a size>0 slot
    // that was the MISSING one — that must have been normalized to size 0.
    const normalized008 = [buy008, sell008].find((o: any) => Number(o.size || 0) === 0 && !o.orderId);
    assert(normalized008, 'The missing-create slot must be normalized to a clean empty (size 0) at the commit boundary');
    assert.strictEqual([buy008, sell008].filter((o: any) => Number(o.size || 0) === 0).length, 1,
        'Exactly one (the missing) slot is normalized; the confirmed slot keeps its size');
    assert.strictEqual(recoverySyncCalls, 0, 'Missing create resolved via chain poll, not the full recovery sync');
    const blockers008 = ((manager as any)._lastUnmatchedChainOrders || []).filter((o: any) => o.reason === 'missing-create-result');
    assert.strictEqual(blockers008.length, 0, 'No permanent missing-create structural blocker (would block future CREATEs)');
    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    assert.strictEqual(postBatchAdjustments.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-008 passed');
}

async function testNoPostBatchCacheDeductionForSizeUpdates() {
    console.log('\n[COW-COMMIT-009] no post-batch cache deduction for size updates...');

    const master = new Map([
        ['slot-update-buy', createOrder('slot-update-buy', {
            type: ORDER_TYPES.BUY,
            size: 1,
            state: ORDER_STATES.ACTIVE,
            orderId: '1.7.700',
            rawOnChain: { for_sale: '100000' }
        })]
    ]);
    const { bot, manager, postBatchAdjustments } = createCowExecutionFixture(master);
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });

    const actions = [{
        type: COW_ACTIONS.UPDATE,
        id: 'slot-update-buy',
        orderId: '1.7.700',
        newGridId: 'slot-update-buy',
        newSize: 1.000009,
        order: {
            id: 'slot-update-buy',
            type: ORDER_TYPES.BUY,
            price: 1,
            size: 1.000009
        }
    }];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildCreateOrderOp = async () => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: null
    });
    chainOrders.buildUpdateOrderOp = async () => ({
        op: {
            op_name: 'limit_order_update',
            op_data: {
                new_price: {
                    base: { amount: 100001, asset_id: manager.assets.assetB.id },
                    quote: { amount: 10000100, asset_id: manager.assets.assetA.id }
                },
                delta_amount_to_sell: { amount: 1, asset_id: manager.assets.assetB.id }
            }
        },
        finalInts: {
            sell: 100001,
            receive: 10000100,
            sellAssetId: manager.assets.assetB.id,
            receiveAssetId: manager.assets.assetA.id
        }
    });

    let commitCalls = 0;
    manager._commitWorkingGrid = async () => {
        commitCalls += 1;
        return true;
    };
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [] });
    let result;
    try {
        result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        }, { pollIntervalMs: 0 });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    assert.strictEqual(result.executed, true, 'Update-only batch with empty operation_results should still commit');
    assert.strictEqual(commitCalls, 1, 'Update-only batch should not be rejected by create result guard');
    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    assert.strictEqual(postBatchAdjustments.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-009 passed');
}

async function testCredentialDaemonPreflightBlocksBroadcast() {
    console.log('\n[COW-COMMIT-010] credential daemon preflight blocks write broadcast...');

    const masterOrders = new Map([
        ['slot-new', {
            id: 'slot-new',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 1,
            size: 10,
            orderId: null
        }]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    bot.privateKey = chainKeys.createDaemonSigningToken('1.2.x', {
        socketPath: '/tmp/missing-dexbot-cred.sock'
    });

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    const order = {
        id: 'slot-new',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: 1,
        size: 10
    };
    workingGrid.set('slot-new', order);

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    // The pre-write probe (_ensureCredentialDaemonWritable) pings the daemon
    // when the signing key is a daemon token — simulate the outage there.
    const originalPing = chainKeys.pingDaemon;
    let executeCalls = 0;

    chainOrders.buildCreateOrderOp = async () => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: null
    });
    chainKeys.pingDaemon = async () => {
        throw new Error('Daemon connection failed: ENOENT');
    };

    try {
        await assert.rejects(
            () => bot._updateOrdersOnChainBatchCOW({
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: 0,
                actions: [{ type: COW_ACTIONS.CREATE, id: 'slot-new', order }]
            }),
            /Credential daemon unavailable/
        );
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainKeys.pingDaemon = originalPing;
    }

    assert.strictEqual(executeCalls, 0, 'Credential outage must abort before broadcast execution');
    console.log('✓ COW-COMMIT-010 passed');
}

async function testToleranceViolationFiltersCreatesOnly() {
    console.log('\n[COW-COMMIT-011] tolerance violations filter only violating CREATEs, rest of batch proceeds...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { type: ORDER_TYPES.BUY, price: 1.0 })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);

    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    let executeBatchOps: any[] = [];
    let executeBatchCalls = 0;

    manager._commitWorkingGrid = async () => true;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildCreateOrderOp = async (_account: any, _amountToSell: any, sellAssetId: string) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: { amount_to_sell: { amount: 100000, asset_id: sellAssetId } }
        },
        finalInts: { sell: 100000, receive: 10000000, sellAssetId, receiveAssetId: manager.assets.assetA.id }
    });
    chainOrders.executeBatch = async (_account: any, _key: any, ops: any[]) => {
        executeBatchCalls += 1;
        executeBatchOps = ops;
        // Return operation_results with chain order IDs for each op so
        // processBatchResults doesn't trip on missing IDs.
        const chainOrderIdBase = 1000 + Math.floor(Math.random() * 1000);
        return {
            success: true,
            operation_results: ops.map((_: any, i: number) => [null, `1.7.${chainOrderIdBase + i}`])
        };
    };

    const logMessages: string[] = [];
    manager.logger = {
        log: (msg: string) => { logMessages.push(msg); },
        logFundsStatus: () => {}
    };

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });

    try {
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [
                { type: COW_ACTIONS.CREATE, id: 'slot-2', order: { id: 'slot-2', type: ORDER_TYPES.BUY, price: 1.1, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null } },
                { type: COW_ACTIONS.CREATE, id: 'slot-2', order: { id: 'slot-2', type: ORDER_TYPES.BUY, price: 1.1, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null } },
                { type: COW_ACTIONS.CREATE, id: 'slot-4', order: { id: 'slot-4', type: ORDER_TYPES.BUY, price: 1.2, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null } },
                { type: COW_ACTIONS.CANCEL, id: 'slot-1', orderId: '1.7.100' }
            ]
        });

        assert.strictEqual(result.executed, true, 'batch with filtered tolerance violations must still execute');
        assert.strictEqual(executeBatchCalls, 1, 'executeBatch must be called exactly once');

        // 2 ops: 1 CREATE (slot-4) + 1 CANCEL (slot-1). Duplicate slot-2 CREATEs both filtered as same_batch.
        assert.strictEqual(executeBatchOps.length, 2,
            `expected 2 broadcast ops (1 CREATE + 1 CANCEL), got ${executeBatchOps.length}`);

        const loggedFilter = logMessages.some((m: string) =>
            /tolerance-violating CREATE\(s\)/.test(m)
        );
        assert.strictEqual(loggedFilter, true, 'should log tolerance-violating filter message');
    } finally {
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-011 passed');
}

async function testSeamPollIntervalDoesNotLeakOnGuardRefusal() {
    console.log('\n[COW-COMMIT-012] pollIntervalMs seam is restored on the pre-broadcast guard-refusal path...');

    const { manager } = createManagerFixture();
    manager.assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
    };

    const bot = new DEXBot({
        botKey: 'test_cow_commit_guard_seam_leak',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = manager;
    bot.account = { id: '1.2.999' };
    bot.privateKey = 'TEST_PRIVATE_KEY';

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    // Occupied slot -> runPreBroadcastGuards refuses pre-broadcast (the exit
    // path that used to skip restoreTestPollIntervalSeam).
    const cowResult = {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: (manager as any).boundaryIdx,
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: 'slot-1',
            order: {
                id: 'slot-1',
                type: ORDER_TYPES.SELL,
                price: 1.1,
                size: 10,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        }]
    };

    const originalExecuteBatch = chainOrders.executeBatch;
    let executeBatchCalls = 0;
    chainOrders.executeBatch = async () => {
        executeBatchCalls += 1;
        return { success: true, operation_results: [] };
    };

    try {
        assert.strictEqual(bot._testPollIntervalMs, undefined, 'precondition: no seam set before the call');

        const result = await bot._updateOrdersOnChainBatchCOW(cowResult, { pollIntervalMs: 0 });
        assert.strictEqual(result.aborted, true, 'guard refusal must abort');
        assert.strictEqual(
            bot._testPollIntervalMs,
            undefined,
            'guard-refusal return must not leak the pollIntervalMs seam onto the bot'
        );

        // Pre-existing seam values must be restored, not just deleted.
        bot._testPollIntervalMs = 777;
        const result2 = await bot._updateOrdersOnChainBatchCOW(cowResult, { pollIntervalMs: 0 });
        assert.strictEqual(result2.aborted, true, 'second guard refusal must also abort');
        assert.strictEqual(bot._testPollIntervalMs, 777, 'unrelated pre-existing seam value must survive the call');

        assert.strictEqual(executeBatchCalls, 0, 'guard refusals must never reach blockchain executeBatch');

        // Pin the seam *precedence* resolution: explicit option beats the bot
        // seam beats the production 1.5s default, and an explicit 0 must not
        // be treated as absent. Asserting the resolved value keeps this
        // independent of whether the missing-create poll path is walked.
        await bot._updateOrdersOnChainBatchCOW(cowResult, { pollIntervalMs: 0 });
        assert.strictEqual(
            bot._lastResolvedPollIntervalMs,
            0,
            'explicit pollIntervalMs: 0 must resolve to 0, not the 1500ms default'
        );

        delete bot._testPollIntervalMs;
        await bot._updateOrdersOnChainBatchCOW(cowResult, {});
        assert.strictEqual(
            bot._lastResolvedPollIntervalMs,
            1500,
            'no seam at all must resolve to the production 1500ms default'
        );

        bot._testPollIntervalMs = 0;
        await bot._updateOrdersOnChainBatchCOW(cowResult, {});
        assert.strictEqual(
            bot._lastResolvedPollIntervalMs,
            0,
            'bot seam 0 must resolve to 0, not the 1500ms default'
        );
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
        delete bot._testPollIntervalMs;
        delete bot._lastResolvedPollIntervalMs;
    }

    console.log('✓ COW-COMMIT-012 passed');
}

async function testRejectsMissingUpdateTargetBeforeBroadcast() {
    console.log('\n[COW-COMMIT-013] missing UPDATE target aborts pre-broadcast + requests resync...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { type: ORDER_TYPES.BUY, price: 1.0 })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    (manager as any)._gapSlots = 2;
    let resyncRequests = 0;
    (manager as any).requestStructuralGridResync = async () => { resyncRequests += 1; return { scheduled: true }; };

    const originalBatchRead = chainOrders.batchReadOrders;
    const originalExecuteBatch = chainOrders.executeBatch;
    // Authoritative Map with NO entry -> every UPDATE target is gone on chain.
    chainOrders.batchReadOrders = async (_ids: string[]) => new Map();
    let executeCalls = 0;
    chainOrders.executeBatch = async () => { executeCalls += 1; return { success: true, operation_results: [] }; };
    // Repair unavailable/failed -> the structural resync stays the fallback.
    (bot as any)._targetedOrderRepair = async () => false;

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    try {
        const result: any = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: (manager as any).boundaryIdx,
            actions: [{
                type: COW_ACTIONS.UPDATE,
                id: 'slot-1',
                orderId: '1.7.gone',
                order: { id: 'slot-1', type: ORDER_TYPES.BUY, price: 1.0, size: 100, state: ORDER_STATES.ACTIVE, orderId: '1.7.gone' }
            }]
        });
        assert.strictEqual(result.aborted, true, 'missing UPDATE target must abort the batch');
        assert.strictEqual(result.reason, 'UPDATE_TARGET_MISSING', 'abort reason must identify the missing target');
        assert.deepStrictEqual(result.missingUpdateOrderIds, ['1.7.gone'], 'missing id must be reported');
        assert.strictEqual(executeCalls, 0, 'no blockchain broadcast may be attempted');
        assert.strictEqual(resyncRequests, 1, 'structural resync must be requested when the targeted repair cannot run');
        assert.notStrictEqual(result.repairedMissingTargets, true, 'a failed repair must not be reported as repaired');
    } finally {
        chainOrders.batchReadOrders = originalBatchRead;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-013 passed');
}

async function testRepairsMissingUpdateTargetInPlace() {
    console.log('\n[COW-COMMIT-013b] missing UPDATE target is repaired in place (no snapshot reload)...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { type: ORDER_TYPES.BUY, price: 1.0, orderId: '1.7.gone' })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    (manager as any)._gapSlots = 2;
    let resyncRequests = 0;
    (manager as any).requestStructuralGridResync = async () => { resyncRequests += 1; return { scheduled: true }; };
    // Give the fixture the re-plan precondition so the scheduled rebalance is
    // observable (the real bot always has both).
    (manager as any).performSafeRebalance = async () => ({ aborted: false });

    const originalBatchRead = chainOrders.batchReadOrders;
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.batchReadOrders = async (_ids: string[]) => new Map();
    let executeCalls = 0;
    chainOrders.executeBatch = async () => { executeCalls += 1; return { success: true, operation_results: [] }; };

    let repairCalls = 0;
    (bot as any)._targetedOrderRepair = async (ids: string[]) => {
        repairCalls += 1;
        const repaired = new Map<string, any>();
        for (const [key, order] of masterOrders) {
            repaired.set(key, ids.includes(String(order.orderId))
                ? { ...order, state: ORDER_STATES.VIRTUAL, size: 0, type: ORDER_TYPES.SPREAD, orderId: '' }
                : order);
        }
        (manager as any).orders = repaired;
        return true;
    };

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    try {
        const result: any = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: (manager as any).boundaryIdx,
            actions: [{
                type: COW_ACTIONS.UPDATE,
                id: 'slot-1',
                orderId: '1.7.gone',
                order: { id: 'slot-1', type: ORDER_TYPES.BUY, price: 1.0, size: 100, state: ORDER_STATES.ACTIVE, orderId: '1.7.gone' }
            }]
        });
        assert.strictEqual(repairCalls, 1, 'the missing target must be repaired exactly once');
        assert.strictEqual(result.aborted, true, 'the refused batch is still dropped');
        assert.strictEqual(result.reason, 'UPDATE_TARGET_MISSING', 'reason keeps the shared refusal vocabulary');
        assert.strictEqual(result.repairedMissingTargets, true, 'the repair must be reported');
        assert.strictEqual(executeCalls, 0, 'no blockchain broadcast may be attempted');
        assert.strictEqual(
            resyncRequests,
            0,
            'a repaired target must NOT escalate to a structural resync (that reloads the stale snapshot and re-arms the same refusal)'
        );
        assert.strictEqual(Boolean(bot._postRecoveryRebalanceTimer), true, 'a fresh plan must be scheduled after the repair');

        // Let the deferred re-plan run so no timer leaks into the next test.
        await waitFor(() => !bot._postRecoveryRebalanceTimer, 'deferred post-repair re-plan to settle', 2000);
    } finally {
        chainOrders.batchReadOrders = originalBatchRead;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-013b passed');
}

async function testUnrepairableMissingTargetStillEscalates() {
    console.log('\n[COW-COMMIT-013c] a repair that leaves the id tracked still escalates...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { type: ORDER_TYPES.BUY, price: 1.0, orderId: '1.7.gone' })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    (manager as any)._gapSlots = 2;
    let resyncRequests = 0;
    (manager as any).requestStructuralGridResync = async () => { resyncRequests += 1; return { scheduled: true }; };

    const originalBatchRead = chainOrders.batchReadOrders;
    chainOrders.batchReadOrders = async (_ids: string[]) => new Map();
    // Claims success but leaves the dead id on the slot: dropping the batch
    // silently would loop one refusal per cycle forever.
    (bot as any)._targetedOrderRepair = async () => true;

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    try {
        const result: any = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: (manager as any).boundaryIdx,
            actions: [{
                type: COW_ACTIONS.UPDATE,
                id: 'slot-1',
                orderId: '1.7.gone',
                order: { id: 'slot-1', type: ORDER_TYPES.BUY, price: 1.0, size: 100, state: ORDER_STATES.ACTIVE, orderId: '1.7.gone' }
            }]
        });
        assert.notStrictEqual(result.repairedMissingTargets, true, 'an ineffective repair must not be reported as repaired');
        assert.strictEqual(resyncRequests, 1, 'an ineffective repair must escalate to the structural resync');
    } finally {
        chainOrders.batchReadOrders = originalBatchRead;
    }

    console.log('✓ COW-COMMIT-013c passed');
}

async function testAllowsPresentUpdateTargetThroughGuard() {
    console.log('\n[COW-COMMIT-014] present UPDATE target passes the existence guard (fail-open on non-Map)...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { type: ORDER_TYPES.BUY, price: 1.0 })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    (manager as any)._gapSlots = 2;
    let resyncRequests = 0;
    (manager as any).requestStructuralGridResync = async () => { resyncRequests += 1; return { scheduled: true }; };

    const originalBatchRead = chainOrders.batchReadOrders;
    let batchReadCalls = 0;
    chainOrders.batchReadOrders = async (ids: string[]) => {
        batchReadCalls += 1;
        return new Map([['1.7.present', { for_sale: 100 }]]);
    };

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    try {
        const result: any = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: (manager as any).boundaryIdx,
            actions: [{
                type: COW_ACTIONS.UPDATE,
                id: 'slot-1',
                orderId: '1.7.present',
                order: { id: 'slot-1', type: ORDER_TYPES.BUY, price: 1.0, size: 100, state: ORDER_STATES.ACTIVE, orderId: '1.7.present' }
            }]
        });
        assert.strictEqual(batchReadCalls, 1, 'existence read must run for UPDATE batches');
        assert.notStrictEqual(result.reason, 'UPDATE_TARGET_MISSING', 'a present target must not be rejected');
        assert.strictEqual(resyncRequests, 0, 'no resync for a present target');
    } finally {
        chainOrders.batchReadOrders = originalBatchRead;
    }

    console.log('✓ COW-COMMIT-014 passed');
}

async function testGapBandPlacementShadowIsObservabilityOnly() {
    console.log('\n[COW-COMMIT-015] gap-band placement is counted (shadow) and never blocks...');

    const { bot, manager } = createCowExecutionFixture(new Map());
    // boundary 5, gap 2 -> gap band slots 6-7.
    (manager as any).boundaryIdx = 5;
    (manager as any)._gapSlots = 2;

    const originalBatchRead = chainOrders.batchReadOrders;
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.batchReadOrders = async () => [];
    // Force the CREATE build to bail without a real op; the assertion is on the
    // pre-broadcast shadow counter, not on the broadcast. Counting the call
    // proves the shadow did NOT refuse the batch before op-building.
    let buildCreateCalls = 0;
    chainOrders.buildCreateOrderOp = async () => { buildCreateCalls += 1; throw new Error('not configured'); };

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    try {
        const before = Number(bot._metrics.gapBandPlacementShadowCount) || 0;
        const result: any = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 5,
            actions: [{
                type: COW_ACTIONS.CREATE,
                id: 'slot-6',
                order: { id: 'slot-6', type: ORDER_TYPES.BUY, price: 1.05, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null }
            }]
        });
        assert.notStrictEqual(result.reason, 'GAP_BAND_PLACEMENT', 'shadow check must never abort the batch');
        assert.strictEqual(buildCreateCalls, 1, 'shadow is observability-only: the batch must still reach op-building');
        assert.strictEqual(
            Number(bot._metrics.gapBandPlacementShadowCount) || 0,
            before + 1,
            'in-band non-spread-correction CREATE must increment the shadow counter'
        );
    } finally {
        chainOrders.batchReadOrders = originalBatchRead;
        chainOrders.buildCreateOrderOp = originalBuildCreate;
    }

    console.log('✓ COW-COMMIT-015 passed');
}

async function testLaggingBatchReadIsRescuedBySingleRead() {
    console.log('\n[COW-COMMIT-016] a lagging batch read is rescued by a single read before refusing...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { type: ORDER_TYPES.BUY, price: 1.0 })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    (manager as any)._gapSlots = 2;
    let resyncRequests = 0;
    (manager as any).requestStructuralGridResync = async () => { resyncRequests += 1; return { scheduled: true }; };

    const originalBatchRead = chainOrders.batchReadOrders;
    const originalSingleRead = chainOrders.readSingleOrder;
    let singleReadCalls = 0;
    // The batch read lags (returns nothing) but the single re-read finds the
    // order, so it must NOT be declared missing.
    chainOrders.batchReadOrders = async () => new Map();
    chainOrders.readSingleOrder = async (id: string) => { singleReadCalls += 1; return { id }; };

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    try {
        const result: any = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: (manager as any).boundaryIdx,
            actions: [{
                type: COW_ACTIONS.UPDATE,
                id: 'slot-1',
                orderId: '1.7.lagging',
                order: { id: 'slot-1', type: ORDER_TYPES.BUY, price: 1.0, size: 100, state: ORDER_STATES.ACTIVE, orderId: '1.7.lagging' }
            }]
        });
        assert.strictEqual(singleReadCalls, 1, 'candidate missing id must be re-verified with a single read');
        assert.notStrictEqual(result.reason, 'UPDATE_TARGET_MISSING', 'a found target must rescue the batch');
        assert.strictEqual(resyncRequests, 0, 'no resync when the re-read finds the order');
    } finally {
        chainOrders.batchReadOrders = originalBatchRead;
        chainOrders.readSingleOrder = originalSingleRead;
    }

    console.log('✓ COW-COMMIT-016 passed');
}

async function testPartialGrowthSizeUpdateIsSkippedBeforeTheChainRead() {
    console.log('\n[COW-COMMIT-017] a clamped PARTIAL-growth size update is skipped before buildUpdateOrderOp...');

    // Master slot is PARTIAL at its booked remainder (50). The plan targets
    // 100 (a full-side resize computed from the geometric ideal). Growing a
    // PARTIAL order in place would resurrect the filled size, so the clamp
    // keeps 50 — which is already on chain, i.e. the op is a provable no-op.
    // Pre-fix the batch built the op anyway, paying a readSingleOrder to
    // discover "no blockchain delta".
    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', {
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            price: 1.0,
            size: 50,
            orderId: '1.7.100'
        })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    const logs: string[] = [];
    manager.logger.log = (msg?: any) => { logs.push(String(msg)); };
    (manager as any)._gapSlots = 2;

    const originalBuild = chainOrders.buildUpdateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;
    let buildCalls = 0;
    let executeCalls = 0;
    chainOrders.buildUpdateOrderOp = async () => { buildCalls += 1; return null; };
    chainOrders.executeBatch = async () => { executeCalls += 1; return { success: true, operation_results: [] }; };

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    try {
        const result: any = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: (manager as any).boundaryIdx,
            actions: [{
                type: COW_ACTIONS.UPDATE,
                id: 'slot-1',
                orderId: '1.7.100',
                newSize: 100,
                // ACTIVE on the action's snapshot: the plan-time booked-remainder
                // guard cannot see the PARTIAL master, so only the clamp fires.
                order: { id: 'slot-1', type: ORDER_TYPES.BUY, price: 1.0, size: 100, state: ORDER_STATES.ACTIVE, orderId: '1.7.100' }
            }]
        });

        assert.strictEqual(result.executed, false, 'a no-op update batch must not execute');
        assert.strictEqual(buildCalls, 0, 'the size-update op must not be built (no chain read for a provable no-op)');
        assert.strictEqual(executeCalls, 0, 'nothing may be broadcast');
        assert.strictEqual(bot._metrics.clampedNoopUpdateCount, 1, 'the skip must be counted');
        assert(
            logs.some((m) => m.includes('growth in place refused')),
            'the skip must be logged as a refused growth'
        );
    } finally {
        chainOrders.buildUpdateOrderOp = originalBuild;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-017 passed');
}

async function run() {
    console.log('Running COW commit guard regression tests...');
    await testRejectsVersionMismatchWithoutCommit();
    await testNoPostCommitSideEffectsWhenDeltaEmpty();
    await testExecuteBatchIfNeededSkipsEmptyActions();
    await testRejectsCreateOnOccupiedSlotBeforeBroadcast();
    await testRejectsCreatesWhenUnmatchedChainOrdersExist();
    await testMissingCreateBlockerMergesWithExistingUnmatchedOrders();
    await testNoPostBatchCacheDeductionForCreates();
    await testNoPostBatchCacheDeductionForMixedCreates();
    await testNoPostBatchCacheDeductionForSizeUpdates();
    await testCredentialDaemonPreflightBlocksBroadcast();
    await testToleranceViolationFiltersCreatesOnly();
    await testSeamPollIntervalDoesNotLeakOnGuardRefusal();
    await testRejectsMissingUpdateTargetBeforeBroadcast();
    await testRepairsMissingUpdateTargetInPlace();
    await testUnrepairableMissingTargetStillEscalates();
    await testAllowsPresentUpdateTargetThroughGuard();
    await testLaggingBatchReadIsRescuedBySingleRead();
    await testGapBandPlacementShadowIsObservabilityOnly();
    await testPartialGrowthSizeUpdateIsSkippedBeforeTheChainRead();
    console.log('\n✓ All COW commit guard regression tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
}).finally(() => {
    testsComplete = true;
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});

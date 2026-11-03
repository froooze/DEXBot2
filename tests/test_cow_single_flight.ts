/**
 * tests/test_cow_single_flight.ts
 *
 * Verifies the COW single-flight broadcast guard added to
 * updateOrdersOnChainBatchCOW (dexbot_cow_runtime.ts):
 *
 *  - While one COW batch is broadcasting (bot._cowBroadcastInFlight = true),
 *    a second batch defers instead of broadcasting concurrently.
 *  - The deferred batch proceeds only after the in-flight batch settles, so
 *    two broadcasts never overlap (overlap causes the later working-grid
 *    commit to be refused on a base-version mismatch, followed by a snapshot
 *    reload that can drop a placed order and produce an orphan fill).
 *  - The flag is cleared in the outer finally so a stuck broadcast cannot
 *    permanently block the pipeline (the SINGLE_FLIGHT_MAX_WAIT_MS cap is a
 *    further safety valve, not exercised here).
 */

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

let testsComplete = false;

/**
 * Yield until `predicate` is true, returning as soon as it holds. Tests assert
 * on state transitions instead of padding fixed wall-clock delays, so they
 * finish as soon as the event loop has drained the relevant work.
 */
function waitFor(predicate, message, maxMs = 2000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            let done = false;
            try { done = !!predicate(); } catch (err) { reject(err); return; }
            if (done) return resolve(undefined);
            if (Date.now() - start >= maxMs) return reject(new Error(`Timed out waiting for ${message}`));
            setImmediate(tick);
        };
        setImmediate(tick);
    });
}

process.on('unhandledRejection', (reason) => {
    if (testsComplete) return;
    console.error('Test failed:', reason);
    process.exit(1);
});

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

function makeBot() {
    const bot = new DEXBot({
        botKey: 'test_cow_single_flight',
        dryRun: false,
        startPrice: 100,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    const logEntries = [];
    const orders = new Map();
    const manager = {
        _gridVersion: 0,
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders,
        logger: {
            log: (msg, level) => { logEntries.push({ msg: String(msg), level }); },
            logFundsStatus: () => {}
        },
        _logEntries: logEntries,
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => true,
        _clearWorkingGridRef: () => {},
        _clearPendingBroadcasts: () => {},
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _pendingBroadcasts: new Map(),
        persistGrid: async () => ({ isValid: true, skipped: false }),
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        synchronizeWithChain: async () => {},
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
    };
    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    // The single-flight wait polls this cadence; 1 ms lets a test release the
    // in-flight batch and resume the deferred one without a 250 ms stall.
    (bot as any)._cowSingleFlightPollMs = 1;
    return { bot, manager, logEntries };
}

function makeCreateAction(bot, slotId) {
    const plannedOrder = {
        id: slotId,
        type: ORDER_TYPES.SELL,
        price: 100,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    };
    const workingGrid = new WorkingGrid(bot.manager.orders, { baseVersion: bot.manager._gridVersion ?? 0 });
    workingGrid.set(slotId, { ...plannedOrder });
    return {
        cowResult: {
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: slotId, order: plannedOrder }]
        },
        plannedOrder
    };
}

async function testSingleFlightDefersSecondBroadcast() {
    console.log('\n[COW-SINGLE-FLIGHT-001] second batch defers while a broadcast is in flight...');
    const { bot, logEntries } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    let broadcastCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve as any; });

    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: {
                amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
            }
        },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });

    chainOrders.executeBatch = async (_account, _key, ops) => {
        broadcastCalls++;
        if (broadcastCalls === 1) {
            await firstBlocked;
        }
        return {
            success: true,
            operation_results: ops.map(() => [1, `1.7.57353000${broadcastCalls}`])
        };
    };

    try {
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag starts clear');

        const first = makeCreateAction(bot, 'slot-sf-1');
        const second = makeCreateAction(bot, 'slot-sf-2');

        const p1 = bot._updateOrdersOnChainBatchCOW(first.cowResult);
        // Wait until the first broadcast is actually on the wire (flag set).
        await waitFor(() => broadcastCalls >= 1, 'first batch to broadcast');
        assert.strictEqual(broadcastCalls, 1, 'first batch must broadcast');
        assert.strictEqual(bot._cowBroadcastInFlight, true, 'flag must be set while first broadcast is in flight');

        // Start the second batch while the first is still broadcasting.
        const p2 = bot._updateOrdersOnChainBatchCOW(second.cowResult);

        // Wait for the second batch to reach (and log) the single-flight wait.
        await waitFor(
            () => logEntries.some((l) => l.msg.includes('already in flight') || l.msg.includes('deferring this batch')),
            'second batch to defer'
        );
        const deferLog = logEntries.find((l) => l.msg.includes('already in flight') || l.msg.includes('deferring this batch'));
        assert.strictEqual(broadcastCalls, 1, 'second batch must NOT broadcast while first is in flight');
        assert.ok(deferLog, 'single-flight defer log must be emitted');

        // Release the first broadcast; the second must then proceed.
        releaseFirst!();
        const results = await Promise.all([p1, p2]);

        assert.strictEqual(broadcastCalls, 2, 'both batches must eventually broadcast exactly once each');
        assert.strictEqual(results[0].executed, true, 'first batch executes');
        assert.strictEqual(results[1].executed, true, 'second batch executes after the first settles');
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag must be cleared after both batches settle');
    } finally {
        releaseFirst?.();
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('✓ COW-SINGLE-FLIGHT-001 passed');
}

async function testFlagClearedOnFailedBroadcast() {
    console.log('\n[COW-SINGLE-FLIGHT-002] flag is cleared when a broadcast fails...');
    const { bot } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: {
                amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
            }
        },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });
    chainOrders.executeBatch = async () => {
        throw new Error('network down');
    };

    try {
        bot._handleBatchHardAbort = async (err: any) => { throw err; };
        const { cowResult } = makeCreateAction(bot, 'slot-sf-fail');
        await assert.rejects(
            () => bot._updateOrdersOnChainBatchCOW(cowResult),
            /network down/
        );
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag must be cleared after a failed broadcast');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('✓ COW-SINGLE-FLIGHT-002 passed');
}

async function testPreBroadcastRaceRecheck() {
    console.log('\n[COW-SINGLE-FLIGHT-003] pre-broadcast recheck catches planning-phase race...');
    const { bot, logEntries } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    let broadcastCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve as any; });

    // First buildCreateOrderOp call (the slower-started batch) is parked here so
    // the other batch can pass the entry single-flight check (flag still clear),
    // plan, and claim the broadcast slot before the first batch reaches its own
    // pre-broadcast check. Parking (rather than a fixed delay) makes the ordering
    // deterministic instead of racing wall-clock time.
    let buildCalls = 0;
    let releaseSlowBuild: (() => void) | null = null;
    const slowBuildGate = new Promise<void>((resolve) => { releaseSlowBuild = resolve; });
    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        buildCalls++;
        if (buildCalls === 1) {
            await slowBuildGate;
        }
        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                    min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
                }
            },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };

    chainOrders.executeBatch = async (_account, _key, ops) => {
        broadcastCalls++;
        if (broadcastCalls === 1) {
            await firstBlocked;
        }
        return {
            success: true,
            operation_results: ops.map(() => [1, `1.7.57353001${broadcastCalls}`])
        };
    };

    try {
        const slow = makeCreateAction(bot, 'slot-sf-slow');
        const fast = makeCreateAction(bot, 'slot-sf-fast');

        // Start the slow batch first: it passes the entry check (flag clear)
        // and then blocks inside buildCreateOrderOp.
        const pSlow = bot._updateOrdersOnChainBatchCOW(slow.cowResult);
        // The slow batch is parked in build as soon as it enters it.
        await waitFor(() => buildCalls >= 1, 'slow batch to enter build');
        // Start the fast batch: it also passes the entry check (flag still
        // clear), finishes planning, and claims the broadcast slot first.
        const pFast = bot._updateOrdersOnChainBatchCOW(fast.cowResult);

        // Wait for the fast batch to claim the slot and start broadcasting.
        await waitFor(() => broadcastCalls >= 1, 'fast batch to broadcast');
        assert.strictEqual(broadcastCalls, 1, 'only one broadcast may be in flight during the planning race');
        assert.strictEqual(bot._cowBroadcastInFlight, true, 'slot must be claimed by the fast batch');

        // Let the slow batch out of build; it must now defer at pre-broadcast.
        releaseSlowBuild!();
        await waitFor(
            () => logEntries.some((l) => l.msg.includes('pre-broadcast') && l.msg.includes('already in flight')),
            'slow batch to defer at pre-broadcast'
        );
        const preBroadcastLog = logEntries.find((l) => l.msg.includes('pre-broadcast') && l.msg.includes('already in flight'));
        assert.strictEqual(broadcastCalls, 1, 'slow batch must NOT broadcast while fast batch is in flight');
        assert.ok(preBroadcastLog, 'pre-broadcast defer log must be emitted for the racing batch');

        // Release the fast batch; the slow batch then proceeds.
        releaseFirst!();
        const results = await Promise.all([pFast, pSlow]);

        assert.strictEqual(broadcastCalls, 2, 'both batches must eventually broadcast exactly once each');
        assert.strictEqual(results[0].executed, true, 'fast batch executes');
        assert.strictEqual(results[1].executed, true, 'slow batch executes after the fast batch settles');
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag must be cleared after both settle');
    } finally {
        releaseFirst?.();
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('✓ COW-SINGLE-FLIGHT-003 passed');
}

async function testEarlyReturnDoesNotClearAnotherBatchSlot() {
    console.log('\n[COW-SINGLE-FLIGHT-004] a batch that early-returns after planning must not clear another batch\'s in-flight slot...');
    const { bot } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;
    const originalGetSnapshot = bot.manager.getChainFundsSnapshot;

    let broadcastCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve as any; });

    // The first (slower) batch parks inside build so the second batch can
    // pass the entry single-flight check while the flag is still clear.
    let buildCalls = 0;
    let releaseSlowBuild: (() => void) | null = null;
    const slowBuildGate = new Promise<void>((resolve) => { releaseSlowBuild = resolve; });
    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        buildCalls++;
        if (buildCalls === 1) {
            await slowBuildGate;
        }
        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                    min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
                }
            },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };

    chainOrders.executeBatch = async (_account, _key, ops) => {
        broadcastCalls++;
        if (broadcastCalls === 1) {
            await firstBlocked;
        }
        return {
            success: true,
            operation_results: ops.map(() => [1, '1.7.57353004'])
        };
    };

    try {
        const slow = makeCreateAction(bot, 'slot-sf-004-slow');
        const fast = makeCreateAction(bot, 'slot-sf-004-fast');

        // Batch B (slow) passes the entry check (flag clear) and parks in build.
        const pSlow = bot._updateOrdersOnChainBatchCOW(slow.cowResult);
        await waitFor(() => buildCalls >= 1, 'slow batch to enter build');

        // Batch A (fast) also passes the entry check (flag still clear), claims
        // the broadcast slot, and starts broadcasting (blocked on the wire).
        const pFast = bot._updateOrdersOnChainBatchCOW(fast.cowResult);
        await waitFor(() => broadcastCalls >= 1, 'fast batch to broadcast');
        assert.strictEqual(broadcastCalls, 1, 'only A may be broadcasting');
        assert.strictEqual(bot._cowBroadcastInFlight, true, 'A must hold the broadcast slot');

        // Force B's fund validation to fail so B early-returns at the
        // pre-broadcast validation instead of claiming the slot.
        bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 0, chainFreeBuy: 0 });

        // B resumes, validates funds (fails), and returns without claiming.
        releaseSlowBuild!();
        const bResult = await pSlow;
        assert.strictEqual(bResult.executed, false, 'B must early-return on fund validation failure');
        assert.strictEqual(broadcastCalls, 1, 'B must never broadcast');
        assert.strictEqual(
            bot._cowBroadcastInFlight,
            true,
            'B must NOT clear A\'s in-flight slot on its early return (ownership guard)'
        );

        // Restore A's snapshot, then let A settle normally and clear its own slot.
        bot.manager.getChainFundsSnapshot = originalGetSnapshot;
        releaseFirst!();
        const aResult = await pFast;
        assert.strictEqual(aResult.executed, true, 'A must complete its broadcast');
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'A clears the slot it owns');
    } finally {
        releaseFirst?.();
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
        bot.manager.getChainFundsSnapshot = originalGetSnapshot;
    }
    console.log('✓ COW-SINGLE-FLIGHT-004 passed');
}

async function testPostWaitStalenessTriggersReplan() {
    console.log('\n[COW-SINGLE-FLIGHT-005] a plan that goes stale during the pre-broadcast wait is re-planned, not re-broadcast...');
    const { bot, manager, logEntries } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    let broadcastCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve as any; });
    let replanCalls = 0;

    // The winning batch advances the master version on commit. The deferred
    // batch passed its pre-broadcast guard BEFORE this commit, so only the
    // post-wait recheck can see that its plan is now stale.
    manager._commitWorkingGrid = async () => { manager._gridVersion++; return true; };
    // Re-planning from the fresh master finds the rails already placed: no
    // executable actions, so the stale plan must be skipped, not shipped.
    (manager as any).performSafeRebalance = async () => {
        replanCalls++;
        const wg = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion ?? 0 });
        return { actions: [], workingGrid: wg, workingBoundary: 0, aborted: false };
    };

    // The slow (deferred) batch parks in build so the fast batch can pass the
    // entry check and claim the broadcast slot first.
    let buildCalls = 0;
    let releaseSlowBuild: (() => void) | null = null;
    const slowBuildGate = new Promise<void>((resolve) => { releaseSlowBuild = resolve; });
    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        buildCalls++;
        if (buildCalls === 1) {
            await slowBuildGate;
        }
        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                    min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
                }
            },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };

    chainOrders.executeBatch = async (_account, _key, ops) => {
        broadcastCalls++;
        if (broadcastCalls === 1) {
            await firstBlocked;
        }
        return {
            success: true,
            operation_results: ops.map(() => [1, `1.7.57353010${broadcastCalls}`])
        };
    };

    try {
        const slow = makeCreateAction(bot, 'slot-sf-005-slow');
        const fast = makeCreateAction(bot, 'slot-sf-005-fast');
        // The deferred batch is fill-driven, so a stale plan can be re-planned.
        (slow.cowResult as any).fills = [{ orderId: '1.7.1' }];

        // Slow passes the ENTRY check (flag still clear) then parks in build.
        const pSlow = bot._updateOrdersOnChainBatchCOW(slow.cowResult);
        await waitFor(() => buildCalls >= 1, 'slow batch to enter build');
        // Fast also passes the entry check, plans, and claims the slot.
        const pFast = bot._updateOrdersOnChainBatchCOW(fast.cowResult);

        await waitFor(() => broadcastCalls >= 1, 'fast batch to broadcast');
        assert.strictEqual(broadcastCalls, 1, 'only the fast batch may be broadcasting');
        assert.strictEqual(bot._cowBroadcastInFlight, true, 'the fast batch must hold the broadcast slot');

        // Let slow finish building and reach the pre-broadcast single-flight wait.
        releaseSlowBuild!();
        await waitFor(
            () => logEntries.some((l) => l.msg.includes('pre-broadcast') && l.msg.includes('already in flight')),
            'slow batch to defer at pre-broadcast'
        );
        assert.strictEqual(broadcastCalls, 1, 'the slow batch must defer at pre-broadcast while the fast batch is in flight');

        // Release fast: it commits (advancing the master version) and clears the slot.
        releaseFirst!();
        const [, slowResult] = await Promise.all([pFast, pSlow]);

        assert.strictEqual(broadcastCalls, 1,
            'the stale deferred plan must NOT be broadcast a second time (would duplicate on-chain orders)');
        assert.strictEqual(slowResult.executed, false, 'the stale deferred batch must not execute');
        assert.strictEqual(slowResult.skippedStalePlan, true, 'the stale deferred batch must skip after a fresh re-plan');
        assert.strictEqual(replanCalls, 1, 'the stale deferred batch must re-plan exactly once from the fresh master');
        const staleLog = logEntries.find((l) => l.msg.includes('went stale while waiting for an in-flight broadcast'));
        assert.ok(staleLog, 'post-wait staleness log must be emitted');
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'the broadcast slot must be released');
    } finally {
        releaseFirst?.();
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('✓ COW-SINGLE-FLIGHT-005 passed');
}


async function testPlacementReleasedOnPreBroadcastThrow() {
    console.log('\n[COW-PLACEMENT-006] pre-broadcast throw releases the placement lease...');
    const { bot, manager } = makeBot();
    const PlacementLock = require('../modules/order/placement_lock').default;
    const placement = new PlacementLock();
    const m = manager as any;
    m.acquirePlacement = (kind: string, opts: any) => placement.acquire(kind, opts);
    m.isPlacementActive = () => placement.isHeld();
    m.placementKind = () => placement.kind();
    m.placementHeldForMs = () => placement.heldForMs();
    // lockOrders runs after the placement claim and (pre-fix) outside the
    // release finally — a throw here leaked the lease forever.
    manager.lockOrders = () => { throw new Error('lockOrders boom'); };
    const { cowResult } = makeCreateAction(bot, 'slot-leak-1');

    await assert.rejects(
        () => bot._updateOrdersOnChainBatchCOW(cowResult),
        /lockOrders boom/,
        'the pre-broadcast throw must propagate'
    );
    assert.strictEqual(placement.isHeld(), false, 'placement lease must be released on a pre-broadcast throw');
    assert.strictEqual(bot._batchInFlight, 0, 'an aborted frame must not leave _batchInFlight raised');
    assert.strictEqual(bot._cowBroadcastInFlight, false, 'an aborted frame must not hold the COW broadcast slot');
    console.log('✓ COW-PLACEMENT-006 passed');
}

async function main() {
    await testSingleFlightDefersSecondBroadcast();
    await testFlagClearedOnFailedBroadcast();
    await testPreBroadcastRaceRecheck();
    await testEarlyReturnDoesNotClearAnotherBatchSlot();
    await testPostWaitStalenessTriggersReplan();
    await testPlacementReleasedOnPreBroadcastThrow();
    testsComplete = true;
    console.log('\n✓ All COW single-flight tests passed!');
}

main().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});

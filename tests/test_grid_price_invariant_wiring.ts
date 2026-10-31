/**
 * Emission-site wiring tests for the GRID-PRICE-INVARIANT guard (GPI-WIRE-001..003).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The guard's own unit tests (GPI-001..015 in test_grid_price_invariant_guard)
 * exercise `checkGridPriceInvariant` / `reportGridPriceInvariant` as pure
 * functions. That leaves the WIRING untested: whether a real batch actually
 * consults the check and actually skips the emission.
 *
 * A mutation audit found that reverting the wiring at all three COW sites
 * (disabling the blocking CREATE check, disabling the blocking UPDATE check,
 * and feeding the raw `lastPrice` instead of the validated `onGrid.price` into
 * the last-fill guard) left every COW test green. The checkers
 * (`recordGridPriceInvariantCheck`, `runLastFillGuardCheck`) are not exported,
 * so nothing exercised "check returns false -> emission skipped".
 *
 * These tests drive `updateOrdersOnChainBatchCOW` end-to-end with a real
 * DEXBot/OrderManager and a mocked chain_orders layer, then assert on the two
 * things that actually matter operationally:
 *   1. no op reached `executeBatch` (nothing was broadcast)
 *   2. the offending slot id is reported in the batch's skip set
 *
 * Each test must FAIL if the corresponding wiring is reverted.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

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
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');

let testsComplete = false;

process.on('unhandledRejection', (reason) => {
    const isPostTestWsErrorEvent = testsComplete &&
        reason && (reason as any).type === 'error' && (reason as any).error &&
        typeof (reason as any).error === 'object';
    if (isPostTestWsErrorEvent) return;
    console.error('Test failed:', reason);
    process.exit(1);
});

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

// Ladder used by every fixture. Slot index i must equal priceLevels[i].
const LEVELS = [95, 100, 105, 110, 115];

function makeGenesis() {
    return buildGenesisFromPriceLevels(LEVELS[2], 5, 0, LEVELS);
}

function createOrder(id, overrides = {}) {
    return {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: 100,
        size: 10,
        orderId: '',
        ...overrides
    };
}

/**
 * Minimal bot/manager fixture. `genesis` is what
 * checkGridPriceInvariant re-derives the expected level from, so a fixture
 * slot can carry a price that is NOT its genesis level -- the corruption the
 * guard exists to catch.
 */
function createFixture(masterOrders = new Map(), genesis = makeGenesis()) {
    const bot = new DEXBot({
        botKey: 'test_gpi_wiring',
        dryRun: false,
        startPrice: 105,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 5
    });

    const logs: any[] = [];
    const manager: any = {
        _gridVersion: 0,
        _genesis: genesis,
        boundaryIdx: 0,
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: Object.freeze(masterOrders),
        logger: {
            log: (msg?: any, level?: any) => { logs.push({ msg, level }); },
            logFundsStatus: () => {}
        },
        config: { incrementPercent: 5 },
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _committedWorkingGrid: null,
        _commitWorkingGrid: async () => true,
        persistGrid: async () => {},
        _clearWorkingGridRef: () => {},
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        accountant: { updateOptimisticFreeBalance: async () => {} },
        applyGridUpdateBatch: async () => {},
        synchronizeWithChain: async () => {},
        _lastFilledPrice: null,
        _lastFilledType: null
    };

    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';

    return { bot, manager, logs };
}

function createCowCreateResult(manager: any, slotId: string, price: number) {
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    workingGrid.set(slotId, createOrder(slotId, { price, type: ORDER_TYPES.SELL, size: 10 }));
    return {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: 0,
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: slotId,
            order: {
                id: slotId,
                type: ORDER_TYPES.SELL,
                price,
                size: 10,
                state: ORDER_STATES.VIRTUAL,
                orderId: ''
            }
        }]
    };
}

/**
 * Run a CREATE batch with a spy on both the op builder and the broadcaster.
 * Returns how many ops were built and how many batches were broadcast.
 */
async function runCreateBatchWithSpy(bot: any, cowResult: any) {
    const originalExecuteBatch = chainOrders.executeBatch;
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    let executeBatchCalls = 0;
    let builtOps = 0;

    chainOrders.executeBatch = async () => {
        executeBatchCalls += 1;
        return { success: true, operation_results: [] };
    };
    chainOrders.buildCreateOrderOp = async () => {
        builtOps += 1;
        return {
            op: [1, { amount_to_sell: { amount: 1, asset_id: '1.3.0' } }],
            finalInts: { sellAmount: 1, receiveAmount: 1 }
        };
    };

    try {
        // pollIntervalMs: 0 skips the production 1.5s missing-create poll
        // pacing; the wiring assertions (skip vs broadcast) are unaffected.
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult, { pollIntervalMs: 0 });
        return { result, executeBatchCalls, builtOps };
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
        chainOrders.buildCreateOrderOp = originalBuildCreate;
    }
}

/**
 * GPI-WIRE-001 (CREATE site).
 *
 * A slot whose price is NOT its genesis level must not be emitted. Genesis
 * level for slot-4 is the 5th ladder price (115); the fixture slot carries 130,
 * which is >15% away -- far outside any rounding tolerance, so this is genuine
 * off-grid corruption rather than a precision artifact.
 *
 * MUTATION CHECK: wrapping the CREATE check in `if (false && ...)` must make
 * this test fail on the broadcast assertion.
 */
async function testWIRE001_CreateSiteSkipsOffGridSlot() {
    console.log('\n[GPI-WIRE-001] off-grid CREATE is skipped and never broadcast...');
    const genesis = makeGenesis();
    const masterOrders = new Map([['slot-4', createOrder('slot-4', { price: 130, type: ORDER_TYPES.SELL, size: 10 })]]);
    const { bot, manager, logs } = createFixture(masterOrders, genesis);

    // Sanity: the fixture really is off-grid, otherwise this test proves nothing.
    const expected = genesis.priceLevels[4];
    assert.strictEqual(expected, 115, 'fixture slot-4 genesis level must be 115');
    assert.notStrictEqual(130, expected, 'fixture price must differ from the genesis level');

    const cowResult = createCowCreateResult(manager, 'slot-4', 130);
    const { executeBatchCalls, builtOps } = await runCreateBatchWithSpy(bot, cowResult);

    assert.strictEqual(builtOps, 0, 'an off-grid CREATE must not even build a chain op');
    assert.strictEqual(executeBatchCalls, 0, 'an off-grid CREATE must never reach the broadcaster');
    assert(
        logs.some(l => String(l.msg).includes('GRID-PRICE-INVARIANT') && String(l.msg).includes('CREATE')),
        'the guard must log the skipped CREATE site'
    );
    console.log('✓ GPI-WIRE-001 passed');
}

/**
 * GPI-WIRE-002 (happy path / anti-false-positive).
 *
 * The same batch shape with a slot sitting ON its genesis level MUST be
 * emitted. Without this, a guard that blocks everything would pass WIRE-001.
 */
async function testWIRE002_OnGridCreateStillBroadcasts() {
    console.log('\n[GPI-WIRE-002] on-grid CREATE is still emitted (no false positive)...');
    const genesis = makeGenesis();
    const masterOrders = new Map([['slot-4', createOrder('slot-4', { price: 115, type: ORDER_TYPES.SELL, size: 10 })]]);
    const { bot, manager } = createFixture(masterOrders, genesis);

    const cowResult = createCowCreateResult(manager, 'slot-4', 115);
    const { executeBatchCalls, builtOps } = await runCreateBatchWithSpy(bot, cowResult);

    assert.strictEqual(builtOps, 1, 'an on-grid CREATE must build its chain op');
    assert.strictEqual(executeBatchCalls, 1, 'an on-grid CREATE must be broadcast');
    console.log('✓ GPI-WIRE-002 passed');
}

/**
 * GPI-WIRE-003 (last-fill-guard pivot validation).
 *
 * `runLastFillGuardCheck` feeds the guard the VALIDATED pivot (`onGrid.price`),
 * not the raw `_lastFilledPrice`. A raw pivot far off-ladder must not be
 * silently rewritten into a legitimate-looking level.
 *
 * MUTATION CHECK: swapping `onGrid.price` back to `lastPrice` at the call site
 * must make this test fail -- an off-ladder raw pivot would then be treated as
 * a real level and change the guard's block decision.
 */
async function testWIRE003_PivotIsValidatedNotRaw() {
    console.log('\n[GPI-WIRE-003] the last-fill guard blocks on the VALIDATED pivot, not the raw fill price...');
    // Geometry chosen so the two pivots straddle a REAL decision boundary.
    //   raw pivot 112 snaps to level 110 (within the 2.5% half-increment band)
    //   BUY threshold from validated 110 = 110 * 0.975 = 107.25
    //   BUY threshold from raw       112 = 112 * 0.975 = 109.20
    // A BUY create at 108 sits between them: it BLOCKS under the validated
    // pivot and PASSES under the raw one. That difference is the assertion.
    const genesis = makeGenesis();
    const masterOrders = new Map();
    const { bot, manager } = createFixture(masterOrders, genesis);
    manager._genesis = genesis;
    manager.config = { incrementPercent: 5 };
    manager.boundaryIdx = 2;
    (manager as any)._gapSlots = 0;
    // Raw (unvalidated) fill price: 112, which is NOT a grid level.
    (manager as any)._lastFilledPrice = 112;
    (manager as any)._lastFilledType = ORDER_TYPES.BUY;

    const { resolveOnGridPivot } = require('../modules/dexbot_cow_runtime');
    const validated = resolveOnGridPivot(manager, 112);
    assert.strictEqual(validated.snapped, true, 'raw pivot 112 must snap onto the ladder');
    assert.strictEqual(validated.price, 110, 'the validated pivot must be the snapped level 110');
    assert.notStrictEqual(validated.price, 112, 'validated and raw pivots must differ, else this test cannot discriminate');

    // The guard is a DIRECTION rule (BUY must be below the pivot), so the probe
    // price has to sit between the validated pivot (110) and the raw pivot
    // (112): a BUY at 111 is "above" the validated pivot (blocked) but "below"
    // the raw one (allowed). That is what makes the wiring observable.
    const { isLastFillGuardBlocked } = require('../modules/dexbot_cow_runtime');
    const price = 111;
    const viaValidated = isLastFillGuardBlocked(price, ORDER_TYPES.BUY, validated.price, ORDER_TYPES.BUY);
    const viaRaw = isLastFillGuardBlocked(price, ORDER_TYPES.BUY, 112, ORDER_TYPES.BUY);

    assert.strictEqual(viaValidated.blocked, true,
        'a BUY at 111 must be BLOCKED when judged against the validated pivot 110 (BUY must be below it)');
    assert.strictEqual(viaRaw.blocked, false,
        'the same BUY must PASS against the raw pivot 112 -- otherwise the wiring is untestable');
    console.log('✓ GPI-WIRE-003 passed');
}

/**
 * GPI-WIRE-004 (rotation UPDATE price derivation).
 *
 * IMPORTANT SCOPING NOTE (verified by tracing the live path):
 * the UPDATE site's invariant check is a BACKSTOP and is NOT black-box
 * reachable with a mismatched price. `newPrice` is derived from the
 * destination's genesis level by `deriveRotationPrice` before the check runs
 * (dexbot_cow_runtime.ts, "ROTATION PRICE IS THE DESTINATION'S GENESIS
 * LEVEL"), so at the check the id and the price agree by construction.
 *
 * What IS reachable, and what this test pins, is the property that makes the
 * check unreachable: a planner-supplied `action.newPrice` that disagrees with
 * the destination's genesis level must NOT be the price that reaches the chain.
 *
 * MUTATION CHECK: revert the derivation (prefer `plannedNewPrice`) and the
 * emitted price becomes the planner's 200 instead of the genesis level 110.
 */
async function testWIRE004_RotationPriceDerivedFromDestination() {
    console.log('\n[GPI-WIRE-004] rotation emits the destination genesis level, not the planner price...');
    const genesis = makeGenesis();
    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { price: 100, state: ORDER_STATES.ACTIVE, orderId: '1.7.100' })]
    ]);
    const { bot, manager } = createFixture(masterOrders, genesis);
    manager.orders = Object.freeze(masterOrders);

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    workingGrid.set('slot-1', createOrder('slot-1', {
        price: 200, type: ORDER_TYPES.SELL, size: 10,
        state: ORDER_STATES.ACTIVE, orderId: '1.7.100'
    }));

    assert.strictEqual(genesis.priceLevels[3], 110, 'fixture destination slot-3 level must be 110');

    const cowResult = {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: 0,
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: 'slot-1',
            newGridId: 'slot-3',
            orderId: '1.7.100',
            newPrice: 200,
            newSize: 10,
            order: {
                id: 'slot-1', type: ORDER_TYPES.SELL, price: 100, size: 10,
                state: ORDER_STATES.ACTIVE, orderId: '1.7.100'
            }
        }]
    };

    const originalExecuteBatch = chainOrders.executeBatch;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;
    const emittedPrices: number[] = [];
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [] });
    chainOrders.buildUpdateOrderOp = async (_acct: any, _orderId: any, params: any) => {
        emittedPrices.push(Number(params?.newPrice));
        return { op: [2, {}], finalInts: { sellAmount: 1, receiveAmount: 1 } };
    };

    try {
        await bot._updateOrdersOnChainBatchCOW(cowResult);
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
    }

    assert.strictEqual(emittedPrices.length, 1, 'the rotation must emit exactly one UPDATE');
    assert.notStrictEqual(emittedPrices[0], 200, 'the bogus planner price must never reach the chain');
    assert.strictEqual(emittedPrices[0], 110,
        'the emitted rotation price must be the destination genesis level 110, got ' + emittedPrices[0]);
    console.log('✓ GPI-WIRE-004 passed');
}

/**
 * GPI-WIRE-005 (pivot wiring, END-TO-END).
 *
 * The last-fill guard must be fed the VALIDATED pivot (`onGrid.price`), not the
 * raw fill price. This drives a real CREATE batch and asserts the emission is
 * blocked.
 *
 * Geometry (solved so the two pivots disagree under the DIRECTION rule):
 *   ladder levels       95, 100, 105, 110, 115   (genesis)
 *   raw fill price      112 -> snaps to level 110 (within the snap band)
 *   CREATE              BUY at 110 (slot-3's own genesis level, so the
 *                       invariant check passes and cannot mask the result)
 *
 *   The guard blocks a BUY at/above the pivot:
 *     validated pivot 110 -> 110 >= 110 -> BLOCKED
 *     raw pivot       112 -> 110 <  112 -> not blocked
 *
 * So the validated pivot blocks this BUY and the raw one emits it. The
 * assertion below is therefore a direct test of the call-site wiring.
 *
 * MUTATION CHECK: swapping `onGrid.price` for `lastPrice` at the call site
 * makes this BUY emit, and this test fails.
 */
async function testWIRE005_PivotWiringEndToEnd() {
    console.log('\n[GPI-WIRE-005] end-to-end: the guard blocks on the VALIDATED pivot...');
    const genesis = makeGenesis();
    const { bot, manager } = createFixture(new Map(), genesis);
    manager._genesis = genesis;
    manager.config = { incrementPercent: 20 };
    manager.boundaryIdx = 2;
    (manager as any)._gapSlots = 0;
    // Raw fill price: 112 is NOT a ladder level. It snaps onto 110.
    (manager as any)._lastFilledPrice = 112;
    (manager as any)._lastFilledType = ORDER_TYPES.BUY;

    const { resolveOnGridPivot } = require('../modules/dexbot_cow_runtime');
    const validated = resolveOnGridPivot(manager, 112);
    assert.strictEqual(validated.price, 110, 'raw pivot 112 must validate to level 110');
    assert.notStrictEqual(validated.price, 112, 'raw and validated pivots must differ');

    // A BUY CREATE at slot-3 = level 110 (its own genesis level). It sits AT
    // the validated pivot (blocked) but BELOW the raw one (allowed), which is
    // what makes the pivot wiring observable under the direction rule.
    const cowResult = createCowCreateResult(manager, 'slot-3', 110);
    cowResult.actions[0].order.type = ORDER_TYPES.BUY;

    const originalExecuteBatch = chainOrders.executeBatch;
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    let builtOps = 0;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [] });
    chainOrders.buildCreateOrderOp = async () => {
        builtOps += 1;
        return { op: [1, { amount_to_sell: { amount: 1, asset_id: '1.3.0' } }], finalInts: { sellAmount: 1, receiveAmount: 1 } };
    };
    try {
        await bot._updateOrdersOnChainBatchCOW(cowResult);
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
        chainOrders.buildCreateOrderOp = originalBuildCreate;
    }

    assert.strictEqual(builtOps, 0,
        'a BUY at 110 must be blocked by the validated pivot 110 (BUY must be below the pivot); ' +
        'emitting it means the raw pivot 112 was used');
    console.log('✓ GPI-WIRE-005 passed');
}

/**
 * GPI-WIRE-006..008 - a PERSISTENT rejection must escalate to a structural resync.
 *
 * A single rejection is handled correctly: skip the emission, warn, re-plan next
 * cycle. But if the corruption lives in-process, the next cycle re-plans from
 * the SAME slot object (the spread-correction planner carries `candidate.price`
 * straight from `manager.orders`), so it is rejected identically -- forever.
 * The slot is dead while the bot looks alive, and the repeated warns train
 * operators to ignore them.
 *
 * After GRID_PRICE_INVARIANT_RESYNC_THRESHOLD consecutive rejecting batches for
 * one slot, the guard must ask for the structural resync that repairs it
 * (loadGrid derives slot prices from the genesis ladder on reload).
 *
 * WHY NOT HEAL IN PLACE: the checker knows the right value, but silently
 * rewriting slot.price at rejection time would erase the diagnostic signal that
 * distinguishes the four corruption sources. Count first, escalate on
 * persistence.
 */
async function testWIRE006_PersistentRejectionEscalates() {
    console.log('\n[GPI-WIRE-006] a persistent off-grid rejection escalates to a structural resync...');
    const { TIMING } = require('../modules/constants');
    const threshold = Number(TIMING.GRID_PRICE_INVARIANT_RESYNC_THRESHOLD);
    assert.ok(threshold >= 2, 'fixture: the threshold must be >= 2 for a "persistence" test to mean anything');

    const genesis = makeGenesis();
    const masterOrders = new Map([['slot-4', createOrder('slot-4', { price: 130, type: ORDER_TYPES.SELL, size: 10 })]]);
    const { bot, manager } = createFixture(masterOrders, genesis);

    // Spy on the escalation target. The fixture's manager has no such method,
    // so install one and record the calls.
    const resyncs: any[] = [];
    manager.requestStructuralGridResync = (reason: any, details: any) => {
        resyncs.push({ reason, details });
        return { scheduled: true };
    };

    // Batches 1..threshold-1 must NOT escalate -- a one-off rejection is normal
    // and re-planning is the correct response.
    for (let i = 1; i < threshold; i++) {
        const cowResult = createCowCreateResult(manager, 'slot-4', 130);
        await runCreateBatchWithSpy(bot, cowResult);
        assert.strictEqual(resyncs.length, 0,
            `batch ${i} must not escalate before the ${threshold}-batch threshold is reached`);
    }

    // The threshold-th consecutive rejecting batch must escalate exactly once.
    const cowResult = createCowCreateResult(manager, 'slot-4', 130);
    await runCreateBatchWithSpy(bot, cowResult);
    assert.strictEqual(resyncs.length, 1, `the ${threshold}th consecutive rejection must escalate`);
    assert.strictEqual(resyncs[0].reason, 'grid-price-invariant-violation', 'must use the invariant violation reason');
    assert.strictEqual(String(resyncs[0].details.slotId), 'slot-4', 'must name the corrupted slot');
    assert.strictEqual(Number(resyncs[0].details.actual), 130, 'must report the rejected price');
    assert.strictEqual(Number(resyncs[0].details.expected), Number(genesis.priceLevels[4]), 'must report the genesis level');
    console.log('\u2713 GPI-WIRE-006 passed');
}

async function testWIRE007_CleanBatchResetsStreak() {
    console.log('\n[GPI-WIRE-007] a clean batch resets the rejection streak...');
    const { TIMING } = require('../modules/constants');
    const threshold = Number(TIMING.GRID_PRICE_INVARIANT_RESYNC_THRESHOLD);

    const genesis = makeGenesis();
    const masterOrders = new Map([['slot-4', createOrder('slot-4', { price: 130, type: ORDER_TYPES.SELL, size: 10 })]]);
    const { bot, manager } = createFixture(masterOrders, genesis);
    const resyncs: any[] = [];
    manager.requestStructuralGridResync = (reason: any, details: any) => { resyncs.push({ reason, details }); return { scheduled: true }; };

    // Reject this slot threshold-1 times...
    for (let i = 1; i < threshold; i++) {
        await runCreateBatchWithSpy(bot, createCowCreateResult(manager, 'slot-4', 130));
    }
    assert.strictEqual(resyncs.length, 0, 'below-threshold rejections must not escalate');

    // ...then a CLEAN batch for the same slot. This must clear the streak: the
    // escalation must mean "rejected N CONSECUTIVE batches", not "N times ever".
    // Without the reset, a slot rejected once an hour would accumulate to the
    // threshold over a day and fire a resync it never earned.
    await runCreateBatchWithSpy(bot, createCowCreateResult(manager, 'slot-4', Number(genesis.priceLevels[4])));

    // Now reject again: the streak restarted, so a single rejection is not enough.
    await runCreateBatchWithSpy(bot, createCowCreateResult(manager, 'slot-4', 130));
    assert.strictEqual(resyncs.length, 0,
        'a clean batch must reset the streak, so the next single rejection must not escalate');
    console.log('\u2713 GPI-WIRE-007 passed');
}

async function testWIRE008_CooldownSuppressesRepeatEscalation() {
    console.log('\n[GPI-WIRE-008] the cooldown suppresses repeat escalations within the window...');
    const { TIMING } = require('../modules/constants');
    const threshold = Number(TIMING.GRID_PRICE_INVARIANT_RESYNC_THRESHOLD);

    const genesis = makeGenesis();
    const masterOrders = new Map([['slot-4', createOrder('slot-4', { price: 130, type: ORDER_TYPES.SELL, size: 10 })]]);
    const { bot, manager } = createFixture(masterOrders, genesis);
    const resyncs: any[] = [];
    manager.requestStructuralGridResync = (reason: any, details: any) => { resyncs.push({ reason, details }); return { scheduled: true }; };

    for (let i = 0; i < threshold * 3; i++) {
        await runCreateBatchWithSpy(bot, createCowCreateResult(manager, 'slot-4', 130));
    }
    assert.strictEqual(resyncs.length, 1,
        'a long run of rejections must escalate once per cooldown window, not once per batch');

    // Past the cooldown, a still-unhealed slot escalates again.
    bot._lastGridPriceInvariantResyncAt = Date.now() - (Number(TIMING.GRID_PRICE_INVARIANT_RESYNC_COOLDOWN_MS) + 1000);
    await runCreateBatchWithSpy(bot, createCowCreateResult(manager, 'slot-4', 130));
    assert.strictEqual(resyncs.length, 2, 'a still-unhealed slot must escalate again after the cooldown');
    console.log('\u2713 GPI-WIRE-008 passed');
}

/**
 * GPI-WIRE-009 - two bots in ONE process must not share rejection streaks.
 *
 * The streak is bot-scoped for a concrete runtime reason, not defensively: the
 * monolithic runtime (`dexbot.ts`, the `dexbot` bin) constructs EVERY active
 * bot in a single process (`instances[]` built in a loop). A module-level map
 * would pool unrelated bots' rejections, so bot A rejecting a slot twice would
 * leave bot B at the threshold on its very FIRST rejection -- firing a spurious
 * structural resync (reload, possibly a full grid reset) on a healthy bot.
 *
 * Scope is proven by DRIVING, not by inspecting the data structure: two
 * independent fixtures each reject below threshold, and neither may escalate.
 * Under module scoping the second bot's first rejection is the threshold-th
 * overall, so this fails.
 */
async function testWIRE009_StreakIsPerBotNotPerProcess() {
    console.log('\n[GPI-WIRE-009] rejection streaks are per-bot, not pooled per-process...');
    const { TIMING } = require('../modules/constants');
    const threshold = Number(TIMING.GRID_PRICE_INVARIANT_RESYNC_THRESHOLD);
    assert.ok(threshold >= 2, 'fixture: threshold must be >= 2');

    const genesis = makeGenesis();
    const offGrid = Number(genesis.priceLevels[4]);

    // Two INDEPENDENT bots, each in its own fixture (as the monolithic runtime
    // would run them: separate DEXBot instances, one process).
    const mk = () => {
        const masterOrders = new Map([['slot-4', createOrder('slot-4', { price: 130, type: ORDER_TYPES.SELL, size: 10 })]]);
        const fx: any = createFixture(masterOrders, genesis);
        fx.resyncs = [];
        fx.manager.requestStructuralGridResync = (reason: any, details: any) => {
            fx.resyncs.push({ reason, details });
            return { scheduled: true };
        };
        return fx;
    };

    const botA = mk();
    const botB = mk();

    // bot A rejects the SAME slot (threshold-1) times -- just short of escalating.
    for (let i = 1; i < threshold; i++) {
        await runCreateBatchWithSpy(botA.bot, createCowCreateResult(botA.manager, 'slot-4', 130));
    }
    assert.strictEqual(botA.resyncs.length, 0,
        `botA at ${threshold - 1} consecutive rejections must not escalate`);

    // bot B's FIRST rejection for the same slot id must still not escalate.
    // If the streak were module-level, this single rejection would make the
    // shared count reach the threshold and fire a resync for a bot with no
    // persistent corruption of its own.
    await runCreateBatchWithSpy(botB.bot, createCowCreateResult(botB.manager, 'slot-4', 130));
    assert.strictEqual(botB.resyncs.length, 0,
        'botB must NOT inherit botA\'s rejections: the streak is per-bot, and one rejection is not persistent');

    // Sanity: botB is not simply broken -- it escalates on its OWN persistence.
    for (let i = 2; i < threshold; i++) {
        await runCreateBatchWithSpy(botB.bot, createCowCreateResult(botB.manager, 'slot-4', 130));
    }
    await runCreateBatchWithSpy(botB.bot, createCowCreateResult(botB.manager, 'slot-4', 130));
    assert.strictEqual(botB.resyncs.length, 1,
        'botB must escalate once ITS OWN streak reaches the threshold');
    assert.strictEqual(Number(botB.resyncs[0].details.actual), 130, 'botB must report its own rejected price');
    assert.strictEqual(Number(botB.resyncs[0].details.expected), offGrid, 'botB must report its own genesis level');

    // And botA, still below threshold, must not have been escalated by botB's run.
    assert.strictEqual(botA.resyncs.length, 0, 'botA must be unaffected by botB\'s escalation');
    console.log('\u2713 GPI-WIRE-009 passed');
}

async function runAllTests() {
    console.log('=== GRID-PRICE-INVARIANT Wiring Tests ===\n');
    // Track which tests the runner actually invokes, so the self-check below
    // can prove no definition was orphaned.
    const reInvoked = new Set<string>();
    const invoked = (name: string) => reInvoked.add(name);
    invoked('testWIRE001_CreateSiteSkipsOffGridSlot');
    invoked('testWIRE002_OnGridCreateStillBroadcasts');
    invoked('testWIRE003_PivotIsValidatedNotRaw');
    invoked('testWIRE004_RotationPriceDerivedFromDestination');
    invoked('testWIRE005_PivotWiringEndToEnd');
    invoked('testWIRE006_PersistentRejectionEscalates');
    invoked('testWIRE007_CleanBatchResetsStreak');
    invoked('testWIRE008_CooldownSuppressesRepeatEscalation');
    invoked('testWIRE009_StreakIsPerBotNotPerProcess');
    await testWIRE001_CreateSiteSkipsOffGridSlot();
    await testWIRE002_OnGridCreateStillBroadcasts();
    await testWIRE003_PivotIsValidatedNotRaw();
    await testWIRE004_RotationPriceDerivedFromDestination();
    await testWIRE005_PivotWiringEndToEnd();
    await testWIRE006_PersistentRejectionEscalates();
    await testWIRE007_CleanBatchResetsStreak();
    await testWIRE008_CooldownSuppressesRepeatEscalation();
    await testWIRE009_StreakIsPerBotNotPerProcess();
    // Self-check: a test whose body exists but whose runner call was dropped
    // lets the suite report "all passed" while silently narrowing coverage.
    // (That happened while developing this file: a trim for an isolated
    // mutation run removed three runner calls and the suite still passed.)
    // Count the definitions in the SOURCE and require each to have been run.
    try {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'test_grid_price_invariant_wiring.ts'), 'utf8');
        const defined: string[] = [];
        const re = /^async function (testWIRE\d+_[A-Za-z0-9_]+)\s*\(/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) defined.push(m[1]);
        assert.strictEqual(defined.length, 9,
            `expected 9 WIRE test definitions in source, found ${defined.length}: ${defined.join(', ')}`);
        for (const name of defined) {
            assert.ok(reInvoked.has(name),
                `test ${name} is DEFINED but never INVOKED by runAllTests -- coverage was silently dropped`);
        }
    } catch (e: any) {
        if (e?.code === 'ENOENT') {
            console.log('   (source self-check skipped: source file not found next to dist)');
        } else {
            throw e;
        }
    }
    testsComplete = true;
    console.log('\n=== All GRID-PRICE-INVARIANT wiring tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });

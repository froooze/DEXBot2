/**
 * Build-loop regression: a stale gap-evacuation stamp must SKIP the UPDATE.
 *
 * The final-gate test covers the pre-broadcast check. This drives the real
 * `_updateOrdersOnChainBatchCOW` build loop so the stale-stamp branch is
 * exercised end-to-end: no update op may be built, and no batch may execute.
 */
const assert = require('assert');
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
            if (target[key] === value) overrides.delete(key);
            else overrides.set(key, value);
            return true;
        },
    });
}

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');
const chainOrders = makeSwappableModule({
    BroadcastUncertainError,
    selectAccount: async () => {}, setPreferredAccount: async () => {},
    resolveAccountId: async () => null, resolveAccountName: async () => null,
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    readSingleOrder: async () => null, batchReadOrders: async () => [],
    listenForFills: async () => () => {},
    updateOrder: async () => { throw new Error('updateOrder not configured'); },
    createOrder: async () => { throw new Error('createOrder not configured'); },
    cancelOrder: async () => { throw new Error('cancelOrder not configured'); },
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    buildUpdateOrderOp: async () => { throw new Error('buildUpdateOrderOp not configured'); },
    buildCreateOrderOp: async () => { throw new Error('buildCreateOrderOp not configured'); },
    buildCancelOrderOp: async () => { throw new Error('buildCancelOrderOp not configured'); },
    buildLiquidityPoolExchangeOp: async () => { throw new Error('buildLiquidityPoolExchangeOp not configured'); },
    executeBatch: async () => { throw new Error('executeBatch not configured'); },
    findOverReducingUpdateOpError: async () => null,
    wasRecentlyOwnCancelled: () => false, recordOwnCancel: () => {},
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
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, COW_ORIGINS } = require('../modules/constants');

async function testStaleEvacBuildSkip() {
    console.log('\n[EVAC-SKIP-BUILD] stale stamp is skipped before op-building...');
    const genesis = buildGenesisFromPriceLevels(100, 1, 4, Array.from({ length: 220 }, (_, i) => 100 + i));

    const logs: string[] = [];
    const manager: any = {
        _genesis: genesis,
        _gridVersion: 0,
        // Live geometry moved far above the plan stamp: source slot-100 is
        // no longer in the band and is already a valid SELL rail order.
        boundaryIdx: 80,
        _gapSlots: 4,
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: new Map([
            ['slot-100', { id: 'slot-100', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 100, size: 10, orderId: '1.7.100' }],
            ['slot-104', { id: 'slot-104', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 104, size: 10, orderId: '' }]
        ]),
        config: { incrementPercent: 1 },
        _lastFilledPrice: 104,
        _lastFilledType: ORDER_TYPES.SELL,
        lastFillPivotSource: 'fill',
        _lastMarketFillPrice: null,
        _lastMarketFillType: null,
        _pendingBroadcasts: new Map(),
        logger: {
            log: (msg: any) => logs.push(String(msg)),
            logFundsStatus: () => {}
        },
        lockOrders: () => {}, unlockOrders: () => {},
        _setRebalanceState: () => {}, _resetRebalanceStateToDepth: () => {},
        startBroadcasting: () => {}, stopBroadcasting: () => {},
        pauseFundRecalc: () => {}, resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => true,
        persistGrid: async () => {}, _clearWorkingGridRef: () => {},
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        accountant: { updateOptimisticFreeBalance: async () => {} },
        applyGridUpdateBatch: async () => {},
        synchronizeWithChain: async () => {}
    };

    const bot: any = {
        _currentCycleId: 42,
        dryRun: false,
        account: 'acct',
        privateKey: 'pk',
        config: { incrementPercent: 1 },
        _markGridActivity: () => {},
        _incomingFillQueue: [],
        _scheduleFillConsumerRestart: () => {},
        manager
    };
    bot._updateOrdersOnChainBatchCOW = DEXBot.prototype._updateOrdersOnChainBatchCOW;

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    const action = {
        type: COW_ACTIONS.UPDATE,
        id: 'slot-100',
        orderId: '1.7.100',
        newGridId: 'slot-104',
        newPrice: 104,
        newSize: 10,
        order: { id: 'slot-104', type: ORDER_TYPES.SELL, price: 104, size: 10 },
        origin: COW_ORIGINS.GAP_EVACUATION,
        evacBoundary: 99,
        evacGapSlots: 4
    };

    let built = 0;
    let executed = 0;
    const origBuild = chainOrders.buildUpdateOrderOp;
    const origExecute = chainOrders.executeBatch;
    chainOrders.buildUpdateOrderOp = async () => {
        built += 1;
        return {
            op: [2, { amount_to_sell: { amount: 1, asset_id: '1.3.0' } }],
            finalInts: { sellAmount: 1, receiveAmount: 1 }
        };
    };
    chainOrders.executeBatch = async () => {
        executed += 1;
        return { success: true, operation_results: [] };
    };

    try {
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 80,
            actions: [action]
        });
    } finally {
        chainOrders.buildUpdateOrderOp = origBuild;
        chainOrders.executeBatch = origExecute;
    }

    assert.strictEqual(built, 0, 'a stale evacuation must not build an update op');
    assert.strictEqual(executed, 0, 'a stale evacuation must not execute a batch');
    assert.ok(logs.some((l) => l.includes('stale gap-evacuation')),
        `the build loop must log the fail-closed skip; logs:\n${logs.join('\n')}`);
    console.log('✓ EVAC-SKIP-BUILD passed');
}

testStaleEvacBuildSkip().catch((err) => {
    console.error(err);
    process.exit(1);
});

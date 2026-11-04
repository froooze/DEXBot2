/**
 * tests/test_sync_fill_history_batch.ts
 *
 * Tests syncFromFillHistoryBatch — batch processing of multiple fill-history
 * events that acquires _gridLock once and batches drift refetch into one RPC.
 *
 * Coverage:
 *   1. Two partial fills in one batch (drift refetch batched)
 *   2. Full + partial mix in batch
 *   3. Ghost order detection preserves orderId in batch.
 *   4. Replay fill filtered during accounting (skip in batch)
 *   5. Missing grid order skipped gracefully
 *   6. Fallback to individual on batch drift refetch error
 *   7. (removed — ghost order batch aggregation retired)
 *   8. Empty fills array returns early
 *   9. Sequential processValidFills branch: single fill still uses individual path
 *  10. SPREAD-slot full/partial fills resolve the real side (BUY/SELL) on the
 *      fill object so the boundary crawl is not lost (regression for the
 *      filledOrderResult.type gap).
 *  11. Same-order multi-fill in one batch aggregates to a single cumulative
 *      transition (no phantom residual / fund-invariant CRITICAL).
 *  12. Same-order 3-fill partial batch keeps the exact cumulative remainder.
 *  13. A batch fill on a retyped rail slot books the traded (paid-asset) side,
 *      not the stale slot label, and stores the residual on that side.
 */

const assert = require('assert');

const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
// Compiled ESM namespaces are frozen: chain_orders is mocked via loader hooks
// so sync_engine's static import resolves to this plain object and per-test
// batchReadOrders/readSingleOrder behavior can be swapped through the
// delegating bindings.
esmMockEntry();

let readSingleOrderImpl: any = async () => null;
let batchReadOrdersImpl: any = async () => [];
defineEsmMockAbs(require.resolve('../modules/chain_orders'), [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], {
    BroadcastUncertainError: require('../modules/dexbot_credential_client').BroadcastUncertainError,
    readSingleOrder: (...args: any[]) => readSingleOrderImpl(...args),
    batchReadOrders: (...args: any[]) => batchReadOrdersImpl(...args),
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    wasRecentlyOwnCancelled: () => false,
    recordOwnCancel: () => {},
});

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const mathUtils = require('../modules/order/utils/math');
mathUtils._setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderCancel: { bts: 0.05 },
        limitOrderUpdate: { bts: 0.05 },
        makerFeeDiscountPercent: 0.25,
    },
    XRP: {
        chargesMarketFees: false,
        marketFee: { percent: 0 },
    },
});

function suppressNoise() {
    const bsModule = require('../modules/bitshares_client');
    if (bsModule.setSuppressConnectionLog) bsModule.setSuppressConnectionLog(true);
}

function createManager() {
    const mgr = new OrderManager({
        market: 'XRP/BTS', assetA: 'XRP', assetB: 'BTS'
    });
    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'XRP', precision: 4 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return;
            console.log(`  ${msg}`);
        }
    };
    // Fresh accountTotals snapshot so the stale-totals fill gate short-circuits
    // (real fetch is unavailable in this test environment).
    mgr.accountTotals = { buy: 100000, sell: 100000, buyFree: 50000, sellFree: 50000, _lastFetchedAt: Date.now() };
    return mgr;
}

function makeSellFillEvent(orderId, amountXrp, blockNum = 12345, historyId = '1.11.999001') {
    const price = 1041.273399444015;
    return {
        block_num: blockNum,
        id: historyId,
        op: [1, {
            order_id: orderId,
            pays: { amount: Math.round(amountXrp * 10000), asset_id: '1.3.5537' },
            receives: { amount: Math.round(amountXrp * price * 100000), asset_id: '1.3.0' },
            is_maker: true
        }]
    };
}

function _makeBuyFillEvent(orderId, amountBts, blockNum = 12346, historyId = '1.11.999002') {
    return {
        block_num: blockNum,
        id: historyId,
        op: [1, {
            order_id: orderId,
            pays: { amount: Math.round(amountBts * 100000), asset_id: '1.3.0' },
            receives: { amount: Math.round(amountBts / 1041.27 * 10000), asset_id: '1.3.5537' },
            is_maker: true
        }]
    };
}

function installBatchReadOrdersMock(_mgr, mockImpl) {
    const original = batchReadOrdersImpl;
    batchReadOrdersImpl = mockImpl;
    return () => { batchReadOrdersImpl = original; };
}

function installReadSingleOrderMock(_mgr, mockImpl) {
    const original = readSingleOrderImpl;
    readSingleOrderImpl = mockImpl;
    return () => { readSingleOrderImpl = original; };
}

// The sub-dust fill path now verifies the chain for a real residual before
// treating the fill as a full fill (see sync_engine _computeFillTransitionResult).
// Default: the order is already gone from chain (residual culled), so no
// residual-cancel is requested and the slot clears as before.
function installDefaultReadSingleOrderGone() {
    return installReadSingleOrderMock(null, async () => null);
}

async function testTwoPartialFillsBatch() {
    console.log('\n - Two partial fills in one batch (batched drift refetch)...');
    const mgr = createManager();
    const orderId1 = '1.7.100001';
    const orderId2 = '1.7.100002';

    // Place two active orders
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId1,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 3.0, price: 1041.273399444015, orderId: orderId2,
        rawOnChain: { for_sale: String(Math.round(3.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill1 = makeSellFillEvent(orderId1, 0.5, 100, '1.11.1001');
    const fill2 = makeSellFillEvent(orderId2, 0.3, 100, '1.11.1002');

    const result = await mgr.syncFromFillHistoryBatch([fill1, fill2], {
        persistenceMode: 'batched'
    });

    assert.ok(result.filledOrders.length >= 1, 'Should produce at least one filled order');
    assert.ok(result.partialFill, 'Should be partial fills');
    const slot0 = mgr.orders.get('slot-0');
    const slot1 = mgr.orders.get('slot-1');
    assert.ok(slot0.size < 5.0, 'slot-0 size should have decreased');
    assert.ok(slot1.size < 3.0, 'slot-1 size should have decreased');
    console.log('  PASS');
}

async function testFullAndPartialMix() {
    console.log('\n - Full fill + partial fill in same batch...');
    const mgr = createManager();
    const orderId1 = '1.7.200001';
    const orderId2 = '1.7.200002';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 1041.273399444015, orderId: orderId1,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId2,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    // Full fill on slot-0 (1.0 XRP: other side rounds to 0 -> real full fill -> SPREAD placeholder)
    // Partial on slot-1 (0.5 XRP)
    const fill1 = makeSellFillEvent(orderId1, 1.0, 200, '1.11.2001');
    const fill2 = makeSellFillEvent(orderId2, 0.5, 200, '1.11.2002');

    await mgr.syncFromFillHistoryBatch([fill1, fill2], {
        persistenceMode: 'batched'
    });

    const slot0 = mgr.orders.get('slot-0');
    const slot1 = mgr.orders.get('slot-1');
    // Full fill -> other-side rounds to 0 -> real full fill (VIRTUAL/SPREAD placeholder, orderId cleared)
    assert.ok(slot0.state === ORDER_STATES.VIRTUAL, `Full-filled slot should be VIRTUAL placeholder, got ${slot0.state}`);
    assert.ok(slot0.type === ORDER_TYPES.SPREAD, `Full-filled slot should be SPREAD placeholder, got ${slot0.type}`);
    assert.ok(slot0.size === 0, 'Full-filled slot size should be 0');
    assert.ok(slot0.orderId === null, 'Full-filled slot must clear the orderId (no ghost preservation)');
    assert.ok(slot1.state === ORDER_STATES.PARTIAL, 'Partial-filled slot should be PARTIAL');
    assert.ok(slot1.size < 5.0, 'Partial-filled slot size should have decreased');
    console.log('  PASS');
}

async function testGhostOrderInBatch() {
    console.log('\n - Sub-dust full fill in batch becomes a REAL full fill (SPREAD placeholder)...');
    const mgr = createManager();
    // Use a high-precision asset B where the "other side" rounds to 0
    const orderId = '1.7.300001';

    // Sell 1 XRP at 0.0001 -> receives ~0.0001 BTS (other side rounds to 0).
    // A fill is authoritative: treated as a real full fill (SPREAD placeholder).
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 1.0, 300, '1.11.3001');
    const result = await mgr.syncFromFillHistoryBatch([fill], {
        persistenceMode: 'batched'
    });

    const slot0 = mgr.orders.get('slot-0');
    // Real full fill: VIRTUAL SPREAD placeholder, orderId cleared.
    assert.ok(slot0.state === ORDER_STATES.VIRTUAL, `Slot should be VIRTUAL (real full fill), got ${slot0.state}`);
    assert.ok(slot0.type === ORDER_TYPES.SPREAD, `Slot should be SPREAD placeholder, got ${slot0.type}`);
    assert.ok(slot0.orderId === null, 'Full fill must clear the orderId (no ghost preservation)');
    assert.ok(result.filledOrders.length === 1, 'Fill should be reported');
    console.log('  PASS');
}

async function testReplayFillSkippedInBatch() {
    console.log('\n - Replay fill is skipped in batch...');
    const mgr = createManager();
    const orderId = '1.7.400001';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 0.5, 400, '1.11.4001');

    // Process twice: first applies, second should be replay
    const result1 = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });
    const result2 = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.ok(result1.filledOrders.length > 0, 'First call should produce filled orders');
    assert.ok(result2.filledOrders.length === 0, 'Replay call should produce no filled orders');
    const slot0 = mgr.orders.get('slot-0');
    assert.ok(slot0.size < 5.0, 'Slot size should reflect only the first fill');
    console.log('  PASS');
}

async function testMissingGridOrderSkipped() {
    console.log('\n - Missing grid order is skipped gracefully in batch...');
    const mgr = createManager();
    const orderIdKnown = '1.7.500001';
    const orderIdUnknown = '1.7.599999';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderIdKnown,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fillKnown = makeSellFillEvent(orderIdKnown, 0.5, 500, '1.11.5001');
    const fillUnknown = makeSellFillEvent(orderIdUnknown, 0.3, 500, '1.11.5999');

    // Should not throw despite unknown order
    const result = await mgr.syncFromFillHistoryBatch([fillKnown, fillUnknown], {
        persistenceMode: 'batched'
    });

    assert.ok(result.filledOrders.length >= 1, 'Known order fill should still produce filled orders');
    assert.strictEqual(result.requiresOpenOrdersSync, true, 'Unknown order fill should request open-orders sync');
    console.log('  PASS');
}

async function testBatchDriftRefetchFallback() {
    console.log('\n - Batch drift refetch error falls back to cache...');
    const mgr = createManager();
    const orderId = '1.7.600001';

    // Drift signal: cached < grid
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    // Mock batchReadOrders to throw
    const restore = installBatchReadOrdersMock(mgr, async () => {
        throw new Error('connection refused (simulated)');
    });
    try {
        const fill = makeSellFillEvent(orderId, 0.5, 600, '1.11.6001');
        const result = await mgr.syncFromFillHistoryBatch([fill], {
            persistenceMode: 'batched'
        });
        // Should still produce a result, using cached value as fallback.
        // The fallback must use the cached rawOnChain.for_sale (1.0), not the
        // grid size (5.0): effectiveRawForSale = refetchInfo ?? rawForSaleInt
        // (sync_engine.ts). Pinning the exact arithmetic distinguishes the
        // cache-derived remaining size (1.0 - 0.5 = 0.5) from a regression
        // that silently fell back to the grid (5.0 - 0.5 = 4.5) or zeroed the
        // baseline (full-fill virtualization, size 0).
        assert.strictEqual(result.filledOrders.length, 1, 'refetch failure should still produce the filled order');
        assert.strictEqual(result.partialFill, true,
            'refetch failure must stay a partial fill — the cache cannot confirm chain emptiness');
        const slot0 = mgr.orders.get('slot-0');
        assert.strictEqual(slot0.size, 0.5,
            'fallback must use cached for_sale (1.0) - 0.5 fill = 0.5 remaining, not the grid-based 4.5');
        assert.strictEqual(slot0.state, ORDER_STATES.PARTIAL,
            'slot must remain PARTIAL (chain-confirm gate closed on refetch error)');
        assert.strictEqual(slot0.rawOnChain.for_sale, '5000',
            'cached for_sale must be decremented by the fill (10000 - 5000)');
    } finally {
        restore();
    }
    console.log('  PASS');
}

async function testEmptyFillsArray() {
    console.log('\n - Empty fills array returns early...');
    const mgr = createManager();
    const result = await mgr.syncFromFillHistoryBatch([], { persistenceMode: 'batched' });
    assert.ok(result.filledOrders.length === 0, 'Should have no filled orders');
    assert.strictEqual(result.partialFill, false, 'Should not be partial');
    console.log('  PASS');
}

async function testAggregatedGhostOrderIds() {
    console.log('\n - Batch returns aggregated ghostOrderIds from multiple fills... (retired)');
    const mgr = createManager();
    const orderId1 = '1.7.700001';
    const orderId2 = '1.7.700002';

    // Two orders that will both produce ghost fills
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId1,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId2,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill1 = makeSellFillEvent(orderId1, 1.0, 700, '1.11.7001');
    const fill2 = makeSellFillEvent(orderId2, 1.0, 700, '1.11.7002');

    await mgr.syncFromFillHistoryBatch([fill1, fill2], {
        persistenceMode: 'batched'
    });

    console.log('  PASS');
}

/**
 * Regression: two fills for the SAME order in one batch (e.g. a partial fill
 * followed by the dust fill consuming the rest) must be aggregated into a
 * single cumulative transition. Before the fix each fill recomputed newSize
 * against the same stale pre-batch baseline and the last update won,
 * leaving a phantom PARTIAL residual equal to the earlier fills' sum —
 * exactly the "diff == earlier fills' size" fund-invariant CRITICAL in the
 * AAA-BBB log (08-07 10:21, 08-08 14:26, 08-08 14:37, 08-09 07:53).
 */
async function testSameOrderMultiFillBatchAggregates() {
    console.log('\n - Same-order 2-fill batch aggregates and fully consumes the order...');
    const mgr = createManager();
    const orderId = '1.7.850001';

    // 0.4177 XRP offer, consumed by 0.4176 (partial) + 0.0001 (dust) in one batch.
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 0.4177, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(0.4177 * 10000)), fetchedAt: Date.now() }
    });

    const fill1 = makeSellFillEvent(orderId, 0.4176, 160, '1.11.8501');
    const fill2 = makeSellFillEvent(orderId, 0.0001, 160, '1.11.8502');

    const result = await mgr.syncFromFillHistoryBatch([fill1, fill2], {
        persistenceMode: 'batched'
    });

    // Both fills collapse into ONE aggregated transition.
    assert.strictEqual(result.filledOrders.length, 1,
        `Same-order fills must aggregate to one filled order, got ${result.filledOrders.length}`);
    assert.strictEqual(result.filledOrders[0].isPartial, undefined,
        'aggregated consumption must resolve to a full fill, not a partial');

    // Cumulative 0.4176 + 0.0001 = 0.4177 consumes the order entirely → the slot
    // must become a VIRTUAL SPREAD placeholder with the orderId cleared (no ghost
    // preserving a phantom PARTIAL like the log's slot-137).
    const slot0 = mgr.orders.get('slot-0');
    assert.strictEqual(slot0.state, ORDER_STATES.VIRTUAL,
        `fully-consumed slot must be VIRTUAL, got ${slot0.state}`);
    assert.strictEqual(slot0.size, 0, 'fully-consumed slot must be zero-sized');
    assert.strictEqual(slot0.orderId, null, 'fully-consumed slot must clear the orderId');
    console.log('  PASS');
}

async function testSameOrderThreeFillBatchPartialRemainder() {
    console.log('\n - Same order 3-fill partial batch keeps the exact cumulative remainder...');
    const mgr = createManager();
    const orderId = '1.7.850011';

    // Three partial sells for the same 5.0 order: 0.5 + 0.3 + 0.2 = 1.0 consumed.
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fills = [
        makeSellFillEvent(orderId, 0.5, 161, '1.11.8511'),
        makeSellFillEvent(orderId, 0.3, 161, '1.11.8512'),
        makeSellFillEvent(orderId, 0.2, 161, '1.11.8513')
    ];
    const result = await mgr.syncFromFillHistoryBatch(fills, {
        persistenceMode: 'batched'
    });

    assert.strictEqual(result.filledOrders.length, 1,
        `Three same-order fills must aggregate to one filled order, got ${result.filledOrders.length}`);
    assert.strictEqual(result.partialFill, true, 'aggregated fill must remain partial');
    assert.strictEqual(result.filledOrders[0].size, 1.0,
        `aggregated filled order must report the total 1.0 consumed, got ${result.filledOrders[0].size}`);

    const slot0 = mgr.orders.get('slot-0');
    assert.strictEqual(slot0.state, ORDER_STATES.PARTIAL,
        `slot must stay PARTIAL, got ${slot0.state}`);
    assert.strictEqual(slot0.size, 4.0,
        `slot must keep the exact cumulative remainder 4.0, got ${slot0.size}`);
    assert.strictEqual(slot0.rawOnChain.for_sale, '40000',
        `rawOnChain.for_sale must reflect the cumulative 1.0 consumption, got ${slot0.rawOnChain.for_sale}`);
    console.log('  PASS');
}

async function testSingleFillViaBatch() {
    console.log('\n - syncFromFillHistoryBatch handles a single fill correctly...');
    const mgr = createManager();
    const orderId = '1.7.800001';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 0.5, 800, '1.11.8001');
    // syncFromFillHistoryBatch with a single fill should work like syncFromFillHistory
    const result = await mgr.syncFromFillHistoryBatch([fill], {
        persistenceMode: 'batched'
    });

    assert.ok(result.filledOrders.length > 0, 'Single fill should produce filled orders');
    const slot0 = mgr.orders.get('slot-0');
    assert.ok(slot0.size < 5.0, 'Slot size should reflect fill');
    console.log('  PASS');
}

/**
 * Regression: a SPREAD slot carrying an on-chain order (spread-correction
 * activation) must report the resolved BUY/SELL side on the fill object.
 * Before the fix filledOrderResult kept the SPREAD grid type, so
 * deriveTargetBoundary (which only shifts on BUY/SELL) never crawled the
 * boundary — the grid shift was silently lost on full/ghost fills.
 */
function boundaryShiftOf(filledOrder, allSlots) {
    const { deriveTargetBoundary } = require('../modules/order/utils/order');
    const { boundaryIdx } = deriveTargetBoundary(
        [filledOrder],
        1,
        allSlots,
        { startPrice: 1000, coreOrders: { sell: 5, buy: 5 } },
        3
    );
    return boundaryIdx;
}

async function testSpreadSlotFullFillResolvesBuySide() {
    console.log('\n - Full (ghost) fill on SPREAD slot resolves BUY side and shifts boundary...');
    const mgr = createManager();
    const orderId = '1.7.900001';
    const price = 1041.273399444015;

    // Dirty-state setup: a SPREAD slot carrying an on-chain order (legacy grid /
    // spread-correction activation). Validated update paths refuse SPREAD+ACTIVE,
    // so inject directly into the orders map to simulate the state the defensive
    // fill handling is designed for.
    // BUY side: size is in BTS (assetB, precision 5).
    const ordersMap = new Map([
        ['slot-spread', {
            id: 'slot-spread', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SPREAD,
            size: 10.0, price, orderId,
            rawOnChain: { for_sale: String(Math.round(10.0 * 100000)), fetchedAt: Date.now() }
        }],
        // Neighbor slot so the boundary has room to crawl.
        ['slot-1', {
            id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
            size: 5.0, price: price + 1, orderId: '1.7.900002',
            rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
        }]
    ]);
    mgr.orders = Object.freeze(ordersMap);

    // Full fill paying assetB (BTS) → resolved side must be BUY.
    const fill = _makeBuyFillEvent(orderId, 10.0, 900, '1.11.9001');
    const result = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.ok(result.filledOrders.length === 1, 'Full fill should produce exactly one filled order');
    const filledOrder = result.filledOrders[0];
    assert.strictEqual(filledOrder.type, ORDER_TYPES.BUY,
        `fill on SPREAD slot must resolve to BUY, got ${filledOrder.type}`);

    // Slot virtualized to a SPREAD placeholder (VIRTUAL state, orderId cleared):
    // the real full fill no longer preserves the orderId as a ghost. Rotation can
    // immediately plan the opposite side.
    const slot = mgr.orders.get('slot-spread');
    assert.ok(slot.state !== ORDER_STATES.ACTIVE, `filled slot must leave ACTIVE (state=${slot.state})`);
    assert.strictEqual(slot.size, 0, 'filled slot must be zero-sized');
    assert.strictEqual(slot.type, ORDER_TYPES.SPREAD,
        `filled slot must become SPREAD placeholder, got ${slot.type}`);

    // Boundary crawl: BUY fill shifts boundary left; the pre-fix SPREAD type must NOT.
    const allSlots = Array.from<any>(mgr.orders.values()).filter((o) => o.price != null).sort((a, b) => a.price - b.price);
    assert.strictEqual(boundaryShiftOf(filledOrder, allSlots), 0, 'BUY-typed fill must shift boundary left');
    assert.strictEqual(boundaryShiftOf({ ...filledOrder, type: ORDER_TYPES.SPREAD }, allSlots), 1,
        'SPREAD-typed fill (pre-fix) must not shift the boundary');
    console.log('  PASS');
}

async function testSpreadSlotPartialFillResolvesBuySide() {
    console.log('\n - Partial fill on SPREAD slot resolves BUY side (consistency)...');
    const mgr = createManager();
    const orderId = '1.7.900011';
    const price = 1041.273399444015;

    const ordersMap = new Map([
        ['slot-spread', {
            id: 'slot-spread', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SPREAD,
            size: 10.0, price, orderId,
            rawOnChain: { for_sale: String(Math.round(10.0 * 100000)), fetchedAt: Date.now() }
        }]
    ]);
    mgr.orders = Object.freeze(ordersMap);

    // Half fill paying assetB (BTS): received XRP does not round to 0 → partial branch.
    const fill = _makeBuyFillEvent(orderId, 5.0, 901, '1.11.9002');
    const result = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.ok(result.filledOrders.length === 1, 'Partial fill should produce a filled order');
    const filledOrder = result.filledOrders[0];
    assert.strictEqual(filledOrder.type, ORDER_TYPES.BUY,
        `partial fill on SPREAD slot must resolve to BUY, got ${filledOrder.type}`);
    assert.strictEqual(filledOrder.isPartial, true, 'fill must be marked partial');
    assert.strictEqual(filledOrder.size, 5.0, 'fill size must reflect the filled amount');

    const slot = mgr.orders.get('slot-spread');
    assert.strictEqual(slot.state, ORDER_STATES.PARTIAL, 'partially filled slot must be PARTIAL');
    assert.ok(slot.size < 10.0, 'slot size must have decreased');
    console.log('  PASS');
}

async function testWrongSideRailSlotBatchResolvesTradedSide() {
    console.log('\n - Batch fill on a retyped rail slot books the traded (SELL) side...');
    const mgr = createManager();
    const orderId = '1.7.900013';
    const price = 1041.273399444015;
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE,
        // Stale rail label: the resting chain order is a SELL of 5 XRP.
        type: ORDER_TYPES.BUY,
        size: 5.0, price, orderId,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 1.0, 902, '1.11.9003');
    const result = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.strictEqual(result.filledOrders.length, 1, 'the fill must be attributed');
    const filledOrder = result.filledOrders[0];
    assert.strictEqual(filledOrder.type, ORDER_TYPES.SELL,
        `the fill side comes from the paid asset, got ${filledOrder.type}`);
    assert.strictEqual(filledOrder.isPartial, true, 'fill must be marked partial');
    assert.ok(Math.abs(Number(filledOrder.size) - 1.0) < 1e-9,
        `filled size 1.0, got ${filledOrder.size}`);

    const slot = mgr.orders.get('slot-0');
    assert.strictEqual(slot.state, ORDER_STATES.PARTIAL, 'the slot keeps the residual as PARTIAL');
    assert.ok(Math.abs(Number(slot.size) - 4.0) < 1e-9,
        `residual 4.0 XRP, got ${slot.size}`);
    assert.strictEqual(slot.type, ORDER_TYPES.SELL,
        'the stored slot adopts the traded side so size/accounting dimensions agree');
    console.log('  PASS');
}

async function testPostBatchReanchorAndInvariantGuard() {
    console.log('\n - Post-batch accountTotals re-anchor + in-flight invariant guard...');
    const mgr = createManager();

    // Capture CRITICAL-level output so a spurious invariant violation is detectable.
    const errorLogs = [];
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'error' || level === 'warn') errorLogs.push(String(msg));
            if (level !== 'debug') console.log(`  ${msg}`);
        }
    };

    // STALE (pre-fill) snapshot: the fills already settled on-chain but the last
    // fetch predates them. Two buy orders are committed (slot-0 will fully fill,
    // slot-1 remains active); pre-fill total = free(50000) + locked(200) = 50200.
    mgr.accountTotals = {
        buy: 50200, buyFree: 50000,
        sell: 100000, sellFree: 99900,
        _lastFetchedAt: Date.now() - 600000
    };

    // Authoritative POST-fill chain state the mock fetch returns: the 100 BTS
    // locked in slot-0 was paid out, free BTS unchanged, XRP proceeds credited.
    const postFill = {
        buy: 50100, buyFree: 50000,
        sell: 100000.9604, sellFree: 99900.9604
    };
    mgr.fetchAccountTotals = async () => {
        mgr.accountTotals = { ...mgr.accountTotals, ...postFill, _lastFetchedAt: Date.now() };
    };

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
        size: 100.0, price: 1041.273399444015, orderId: '1.7.200001',
        rawOnChain: { for_sale: String(Math.round(100.0 * 100000)), fetchedAt: Date.now() }
    });
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
        size: 100.0, price: 1041.273399444015, orderId: '1.7.200002',
        rawOnChain: { for_sale: String(Math.round(100.0 * 100000)), fetchedAt: Date.now() }
    });

    const fill = _makeBuyFillEvent('1.7.200001', 100.0, 200, '1.11.2001');
    const result = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.strictEqual(result.filledOrders.length, 1, 'Buy fill should produce a filled order');
    const slot0 = mgr.orders.get('slot-0');
    assert.strictEqual(slot0.state, ORDER_STATES.VIRTUAL, 'Filled buy slot must be virtualized');

    // The post-batch re-anchor must have overwritten the optimistic fill
    // accounting (which double-counted the 100 BTS payout against the post-fill
    // refresh) with the authoritative post-fill totals.
    assert.strictEqual(mgr.accountTotals.buy, postFill.buy,
        `accountTotals.buy must be re-anchored to authoritative post-fill total (got ${mgr.accountTotals.buy})`);
    assert.strictEqual(mgr.accountTotals.sell, postFill.sell,
        `accountTotals.sell must be re-anchored to authoritative post-fill total (got ${mgr.accountTotals.sell})`);

    // No spurious CRITICAL (diff == the fills' size) may fire while the batch is
    // half-accounted or after it settles.
    assert.ok(
        !errorLogs.some(m => m.includes('Fund invariant violation')),
        'No fund-invariant violation may fire while/after the fill batch settles'
    );

    // Final invariant must hold: Total = Free + Committed per side.
    const chainBuy = Array.from<any>(mgr.orders.values())
        .filter(o => (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) && o.orderId && o.type === ORDER_TYPES.BUY)
        .reduce((s, o) => s + Number(o.size || 0), 0);
    assert.ok(Math.abs(mgr.accountTotals.buyFree + chainBuy - mgr.accountTotals.buy) < 0.0001,
        `Total must equal Free + Committed after the batch (buy=${mgr.accountTotals.buy}, buyFree=${mgr.accountTotals.buyFree}, chainBuy=${chainBuy})`);

    // The in-flight guard must be fully released so subsequent cycles verify.
    assert.strictEqual(mgr._fillBatchInFlight, 0, 'In-flight guard must be cleared after the batch');
    console.log('  PASS');
}

async function testResidualCancelRequestedWhenChainStillHoldsOrder() {
    console.log('\n - Sub-dust full fill with chain STILL holding residual requests explicit cancel...');
    const mgr = createManager();
    const orderId = '1.7.900001';

    // Sell 1.0 XRP at 0.0001 (other side rounds to 0), but the chain still has
    // the order (for_sale=1 unit) because the fill consumed less than for_sale.
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    // Chain still holds the order with for_sale > 0 → the bot must request an
    // explicit cancel (previously it relied on "chain culls sub-dust residual").
    const restore = installReadSingleOrderMock(mgr, async () => ({
        id: orderId,
        for_sale: String(Math.round(1.0 * 10000) - 9999) // residual 1 unit
    }));
    try {
        const fill = makeSellFillEvent(orderId, 0.9999, 900, '1.11.9001');
        const result = await mgr.syncFromFillHistoryBatch([fill], {
            persistenceMode: 'batched'
        });

        // Fill is authoritative → full fill → SPREAD placeholder (rotation).
        const slot0 = mgr.orders.get('slot-0');
        assert.strictEqual(slot0.state, ORDER_STATES.VIRTUAL,
            `slot should still be virtualized (fill authoritative), got ${slot0.state}`);
        assert.strictEqual(slot0.type, ORDER_TYPES.SPREAD,
            `slot should be SPREAD placeholder, got ${slot0.type}`);

        // But a residual-cancel must be requested so the dust is cancelled
        // explicitly instead of relying on the chain culling it.
        assert.ok(
            Array.isArray(result.residualCancels) && result.residualCancels.length === 1,
            `residualCancels should contain the residual order, got ${JSON.stringify(result.residualCancels)}`
        );
        assert.strictEqual(result.residualCancels[0].orderId, orderId,
            'residual cancel must reference the orderId still held on chain');
    } finally {
        restore();
    }
    console.log('  PASS');
}

async function testFillGuardSingleDecrementOnDeferral() {
    console.log('\n - Deferred fill decrements _fillBatchInFlight exactly once (concurrent holder preserved)...');
    const mgr = createManager();

    // Force the stale-totals gate so the individual path returns early,
    // before the inner finally that lowers the guard for real.
    mgr.refreshAccountTotalsIfStale = async () => ({ ok: false });

    // Simulate a concurrent batch already holding the guard at 2.
    mgr._fillBatchInFlight = 2;

    const orderId = '1.7.700001';
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 1.0, 700, '1.11.7001');
    const result = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.strictEqual(result.deferred, true, 'Fill must be deferred by the stale-totals gate');
    assert.strictEqual(mgr._fillBatchInFlight, 2,
        'Deferral must restore the exact pre-call guard count: no leak on early return, and a concurrent batch holding the guard must not be zeroed');

    // Cleanup so later tests start from a clean guard state.
    mgr._fillBatchInFlight = 0;
    console.log('  PASS');
}

async function runTests() {
    suppressNoise();

    // Sub-dust full fills now verify the residual against the chain. Default to
    // "order gone" so existing sub-dust assertions keep passing.
    const restoreReadGone = installDefaultReadSingleOrderGone();
    try {
        await testTwoPartialFillsBatch();
        await testFullAndPartialMix();
        await testGhostOrderInBatch();
        await testReplayFillSkippedInBatch();
        await testMissingGridOrderSkipped();
        await testBatchDriftRefetchFallback();
        await testEmptyFillsArray();
        await testAggregatedGhostOrderIds();
        await testSingleFillViaBatch();
        await testSameOrderMultiFillBatchAggregates();
        await testSameOrderThreeFillBatchPartialRemainder();
        await testSpreadSlotFullFillResolvesBuySide();
        await testSpreadSlotPartialFillResolvesBuySide();
        await testWrongSideRailSlotBatchResolvesTradedSide();
        await testPostBatchReanchorAndInvariantGuard();
        await testResidualCancelRequestedWhenChainStillHoldsOrder();
        await testFillGuardSingleDecrementOnDeferral();
    } finally {
        restoreReadGone();
    }

    console.log('\n✓ All syncFromFillHistoryBatch tests passed!\n');
}

runTests().then(() => process.exit(0)).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});

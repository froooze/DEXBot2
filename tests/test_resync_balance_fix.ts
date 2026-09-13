/**
 * tests/test_resync_balance_fix.ts
 * 
 * Verifies that reconcileGridOrders correctly uses delta-based balance checks
 * during its update phase (Phase 2), allowing updates when funds are reused.
 */

const assert = require('assert');
// Load real modules
const { reconcileGridOrders } = require('../modules/order/grid_reconcile');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testDeltaBalanceCheck() {
    console.log("\n========== STARTING RESYNC BALANCE FIX TEST ==========\n");

    const manager = {
        orders: new Map(),
        logger: { log: (m, l) => { } }, // Suppress noise
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' }
        },
        accountTotals: {
            sellFree: 5, // Low balance (XRP)
            buyFree: 5   // Low balance (BTS)
        },
        getOrdersByTypeAndState: (type, state) => [],
        synchronizeWithChain: async () => { },
        _updateOrder: (o) => { manager.orders.set(o.id, o); },
        _applyOrderUpdate: async (o) => { manager.orders.set(o.id, o); return true; },
        _applySync: async (syncPayload, source) => {
            if (source !== 'createOrder' || !syncPayload?.gridOrderId) return;
            const current = manager.orders.get(syncPayload.gridOrderId);
            if (!current) return;
            manager.orders.set(syncPayload.gridOrderId, {
                ...current,
                orderId: syncPayload.chainOrderId,
                state: ORDER_STATES.ACTIVE,
            });
        },
        _gridLock: { acquire: async (cb) => await cb() },
        startPrice: 0.5
    };

    // Add a virtual grid order that we want to activate/update to.
    // NOTE: slot-N id required (production invariant — grids only mint
    // slot-N; non-slot-N shelf/manual ids are excluded from window
    // activation by design, issue #27 follow-up).
    manager.orders.set('slot-5', {
        id: 'slot-5',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        price: 0.6,
        size: 100, // Grid target size is 100 XRP
        orderId: null
    });

    // Unmatched chain order with 90 XRP
    const chainOpenOrders = [
        {
            id: '1.7.101',
            sell_price: {
                base: { amount: 9000000, asset_id: '1.3.1' }, // 90 XRP
                quote: { amount: 5400000, asset_id: '1.3.0' } // price 0.6
            },
            for_sale: 9000000 // 90 XRP
        }
    ];

    let updateCalled = false;
    const chainOrdersMock = {
        updateOrder: async () => {
            updateCalled = true;
            return { success: true };
        },
        buildUpdateOrderOp: async () => ({
            op: {
                op_name: 'limit_order_update',
                op_data: {
                    fee: { amount: 0, asset_id: '1.3.0' }
                }
            }
        }),
        executeBatch: async () => {
            updateCalled = true;
            return { success: true, operation_results: [[1, 'ok']] };
        },
        cancelOrder: async () => ({ success: true }),
        createOrder: async () => ({ success: true }),
        readOpenOrders: async () => []
    };

    console.log("SUB-TEST 1: Delta increase (10) > balance (5) -> Should SKIP");
    await reconcileGridOrders({
        manager,
        account: 'test-account',
        privateKey: 'test-key',
        chainOpenOrders,
        chainOrders: chainOrdersMock,
        config: { activeOrders: { sell: 1 } }
    });

    // DELTA is 10 (100 - 90). Balance is 5.
    // 10 > 5, so it should STILL skip (this is correct behavior for increase).
    assert.strictEqual(updateCalled, false, "Should skip update when delta increase exceeds balance");
    console.log("✅ Sub-test 1 passed");

    console.log("\nSUB-TEST 2: Delta increase (10) < balance (15) -> Should SUCCEED");
    updateCalled = false;
    manager.accountTotals.sellFree = 15; // Balance covers delta 10
    await reconcileGridOrders({
        manager,
        account: 'test-account',
        privateKey: 'test-key',
        chainOpenOrders: JSON.parse(JSON.stringify(chainOpenOrders)), // Fresh copy
        chainOrders: chainOrdersMock,
        config: { activeOrders: { sell: 1 } }
    });
    assert.strictEqual(updateCalled, true, "Should allow update when delta increase is within balance");
    console.log("✅ Sub-test 2 passed");

    console.log("\nSUB-TEST 3: Reduction (80 < 90) with low balance (2) -> Should SUCCEED");
    updateCalled = false;
    manager.accountTotals.sellFree = 2; // Very low balance
    manager.orders.get('slot-5').size = 80; // Grid size reduced to 80 (Reduction from 90)
    await reconcileGridOrders({
        manager,
        account: 'test-account',
        privateKey: 'test-key',
        chainOpenOrders: JSON.parse(JSON.stringify(chainOpenOrders)), // Fresh copy
        chainOrders: chainOrdersMock,
        config: { activeOrders: { sell: 1 } }
    });
    // Delta is -10. Balance is 2. Increase is 0. 0 <= 2 so it should succeed.
    assert.strictEqual(updateCalled, true, "Should allow update when size is reduced even with low balance");
    console.log("✅ Sub-test 3 passed");

    console.log("\n✅ ALL DELTA BALANCE FIX TESTS PASSED!\n");
}

testDeltaBalanceCheck().catch(err => {
    console.error("\n❌ TEST FAILED:");
    console.error(err);
    process.exit(1);
});

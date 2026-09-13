const assert = require('assert');
const { reconcileGridOrders } = require('../modules/order/grid_reconcile');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testDuplicateRacePrevention() {
    console.log("\n========== STARTING DUPLICATE RACE PREVENTION TEST ==========\n");

    const orders = new Map();
    const manager = {
        orders: orders,
        logger: { log: (m, l) => console.log(`[LOG ${l}] ${m}`) },
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' }
        },
        accountTotals: { sellFree: 100, buyFree: 100 },
        _gridLock: { acquire: async (cb) => await cb() },
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(orders.values()).filter(o => o.type === type && o.state === state);
        },
        synchronizeWithChain: async () => { },
        syncFromOpenOrders: async (chainOrders) => {
            console.log("[MOCK] syncFromOpenOrders matching slot-6 to 1.7.2");
            const s2 = orders.get('slot-6');
            if (s2) {
                s2.orderId = '1.7.2';
                s2.state = ORDER_STATES.ACTIVE;
            }
        },
        _updateOrder: (o) => { orders.set(o.id, o); },
        _applyOrderUpdate: async (o) => { orders.set(o.id, o); return true; },
        _applySync: async (syncPayload, source) => {
            if (source !== 'createOrder' || !syncPayload?.gridOrderId) return;
            const current = orders.get(syncPayload.gridOrderId);
            if (!current) return;
            orders.set(syncPayload.gridOrderId, {
                ...current,
                orderId: syncPayload.chainOrderId,
                state: ORDER_STATES.ACTIVE,
            });
        },
        startPrice: 0.5
    };

    // SETUP:
    // slot-5 and slot-6 are both VIRTUAL (slot-N ids required: production
    // invariant — grids only mint slot-N; non-slot-N shelf/manual ids are
    // excluded from window activation by design, issue #27 follow-up).
    // One chain order exists (1.7.1) which is unmatched on grid
    orders.set('slot-5', { id: 'slot-5', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 0.55, size: 100 });
    orders.set('slot-6', { id: 'slot-6', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 0.6, size: 100 });

    const chainOpenOrders = [
        {
            id: '1.7.1',
            sell_price: { base: { amount: 10000000, asset_id: '1.3.1' }, quote: { amount: 5500000, asset_id: '1.3.0' } },
            for_sale: 10000000
        }
    ];

    let createCalled = false;
    let batchAttempts = 0;
    let sequentialAttempts = 0;
    const chainOrdersMock = {
        updateOrder: async () => {
            sequentialAttempts++;
            console.log("[MOCK] updateOrder failing, triggering recovery sync...");
            throw new Error("Simulated failure to trigger recovery sync");
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
            batchAttempts++;
            throw new Error('Simulated batch failure to trigger recovery sync');
        },
        createOrder: async () => {
            createCalled = true;
            return [{ trx: { operation_results: [[0, '1.7.100']] } }];
        },
        cancelOrder: async () => { },
        readOpenOrders: async () => {
            return chainOpenOrders;
        }
    };

    // targetSell = 2. 
    // unmatchedSell = 1. 
    // updates = 1 (slot-5 will be targeted for update by 1.7.1).
    // creations = 1 (slot-6 will be targeted for creation).
    console.log("RUNNING RECONCILE: Expecting Phase 2 update for slot-5 to fail, trigger sync, and match slot-6");
    await reconcileGridOrders({
        manager,
        config: { activeOrders: { sell: 2 } },
        account: 'test',
        privateKey: 'test',
        chainOrders: chainOrdersMock,
        chainOpenOrders: chainOpenOrders
    });

    assert.strictEqual(createCalled, false, "Should NOT call createOrder for slot-6 because it was matched during recovery sync");
    assert.strictEqual(batchAttempts, 3, 'Should attempt startup update batch 3 times (initial + 2 retries)');
    assert.ok(sequentialAttempts > 0, 'Should fall back to sequential update attempts after batch retries are exhausted');
    console.log("✅ Race prevention test passed");
}

testDuplicateRacePrevention().catch(err => {
    console.error("\n❌ TEST FAILED:");
    console.error(err);
    process.exit(1);
});

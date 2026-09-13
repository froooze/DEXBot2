const assert = require('assert');

console.log('Running startup_decision tests');

const { decideStartupGridAction, reconcileGridOrders } = require('../modules/order/grid_reconcile');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { _setFeeCache } = require('../modules/order/utils/math');

(async () => {
    // 1) No persisted grid => regenerate
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [],
            chainOpenOrders: [],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: false };
            }
        });
        assert.strictEqual(result.shouldRegenerate, true);
        assert.strictEqual(result.hasActiveMatch, false);
        assert.strictEqual(called.resume, false, 'resume should not be attempted when no persisted grid');
    }

    // 2) Persisted ACTIVE orderId exists on-chain => resume without attempting price-match
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [{ state: 'active', orderId: '1.7.1' }],
            chainOpenOrders: [{ id: '1.7.1' }],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: true, matchedCount: 99 };
            }
        });
        assert.strictEqual(result.shouldRegenerate, false);
        assert.strictEqual(result.hasActiveMatch, true);
        assert.strictEqual(result.resumedByPrice, false);
        assert.strictEqual(called.resume, false, 'resume should not be attempted when an ACTIVE orderId matches');
    }

    // 3) No ACTIVE orderId match + chain has orders => attempt price-match and accept success
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [{ state: 'active', orderId: '1.7.x' }],
            chainOpenOrders: [{ id: '1.7.y' }],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: true, matchedCount: 2 };
            }
        });
        assert.strictEqual(called.resume, true);
        assert.strictEqual(result.shouldRegenerate, false);
        assert.strictEqual(result.hasActiveMatch, false);
        assert.strictEqual(result.resumedByPrice, true);
        assert.strictEqual(result.matchedCount, 2);
    }

    // 4) No ACTIVE orderId match + chain has orders => attempt price-match and regenerate on failure
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [{ state: 'active', orderId: '1.7.x' }],
            chainOpenOrders: [{ id: '1.7.y' }],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: false, matchedCount: 0 };
            }
        });
        assert.strictEqual(called.resume, true);
        assert.strictEqual(result.shouldRegenerate, true);
        assert.strictEqual(result.hasActiveMatch, false);
        assert.strictEqual(result.resumedByPrice, false);
        assert.strictEqual(result.matchedCount, 0);
    }

    // 5) Startup reconcile create path should execute outside->center sell/buy pairing
    {
        const createSequence = [];
        let nextOrderNum = 1;

        _setFeeCache({
            BTS: {
                limitOrderCreate: { bts: 0.01 },
                limitOrderUpdate: { bts: 0.005 },
                limitOrderCancel: { bts: 0.003 }
            }
        });

        // NOTE: grid slots must use slot-N ids (production invariant — grids
        // only mint slot-N). Shelf/manual fork-kept ids (non-slot-N) are
        // excluded from window activation by design (issue #27 follow-up).
        const orders = new Map([
            ['slot-11', { id: 'slot-11', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, orderId: null, price: 101, size: 1.01 }],
            ['slot-13', { id: 'slot-13', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, orderId: null, price: 103, size: 1.03 }],
            ['slot-9', { id: 'slot-9', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: null, price: 99, size: 0.99 }],
            ['slot-7', { id: 'slot-7', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: null, price: 97, size: 0.97 }],
        ]);

        const manager = {
            orders,
            assets: {
                assetA: { id: '1.3.1', symbol: 'ASSETA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'ASSETB', precision: 5 },
            },
            config: { activeOrders: { sell: 2, buy: 2 } },
            accountTotals: { sellFree: 1000, buyFree: 1000 },
            logger: { log: () => {} },
            strategy: { hasAnyDust: () => false },
            _gridLock: { acquire: async (fn) => await fn() },
            _applyOrderUpdate: async (updated) => {
                if (!updated || !updated.id) return;
                const current = orders.get(updated.id) || {};
                orders.set(updated.id, { ...current, ...updated });
            },
            _applySync: async (syncPayload, source) => {
                if (source === 'createOrder' && syncPayload && syncPayload.gridOrderId) {
                    createSequence.push(syncPayload.gridOrderId);
                    const current = orders.get(syncPayload.gridOrderId);
                    if (current) {
                        orders.set(syncPayload.gridOrderId, {
                            ...current,
                            orderId: syncPayload.chainOrderId,
                            state: ORDER_STATES.ACTIVE,
                        });
                    }
                }
            },
            synchronizeWithChain: async () => ({ matched: 0 }),
            getOrdersByTypeAndState: (type, state) => {
                return Array.from(orders.values()).filter(o => (type == null || o.type === type) && o.state === state);
            },
        };

        const chainOrders = {
            updateOrder: async () => ({ success: true }),
            buildUpdateOrderOp: async () => ({
                op: {
                    op_name: 'limit_order_update',
                    op_data: {
                        fee: { amount: 0, asset_id: '1.3.0' }
                    }
                }
            }),
            executeBatch: async () => ({ success: true, operation_results: [] }),
            cancelOrder: async () => ({ success: true }),
            createOrder: async () => {
                const chainOrderId = `1.7.${nextOrderNum++}`;
                return {
                    success: true,
                    raw: { trx: { operation_results: [[1, chainOrderId]] } },
                    operation_results: [[1, chainOrderId]],
                };
            },
            readOpenOrders: async () => [],
        };

        await reconcileGridOrders({
            manager,
            config: manager.config,
            account: 'test-account',
            privateKey: 'test-key',
            chainOrders,
            chainOpenOrders: [],
        });

        assert.deepStrictEqual(
            createSequence,
            ['slot-13', 'slot-7', 'slot-11', 'slot-9'],
            'startup creates should pair outside->center across sell and buy sides'
        );

        const expectedChainIdsByOrderId = {
            'slot-13': '1.7.1',
            'slot-7': '1.7.2',
            'slot-11': '1.7.3',
            'slot-9': '1.7.4',
        };

        for (const [orderId, expectedChainId] of Object.entries(expectedChainIdsByOrderId)) {
            const updated = orders.get(orderId);
            assert(updated, `expected order ${orderId} to exist after startup reconcile`);
            assert.strictEqual(
                updated.state,
                ORDER_STATES.ACTIVE,
                `expected ${orderId} to transition to ACTIVE`
            );
            assert.strictEqual(
                updated.orderId,
                expectedChainId,
                `expected ${orderId} to map to chain id ${expectedChainId}`
            );
        }
    }

    console.log('startup_decision tests passed');
})().catch((err) => {
    console.error('startup_decision tests failed');
    console.error(err);
    process.exit(1);
});

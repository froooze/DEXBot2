/*
 * tests/test_prebroadcast_size_drift_guard.ts
 * Verifies the pre-broadcast size-drift guard in chain_orders.executeBatch:
 * a negative limit_order_update delta that would over-reduce the order's
 * current on-chain for_sale is rejected PRE-broadcast with the chain's
 * "Cannot deduct all or more from order than order contains" error, so the
 * caller routes to the size-drift repair path instead of letting the chain
 * reject the whole batch and cascade into uncertain-broadcast recovery.
 */

const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
// Compiled ESM namespaces are frozen and chain_orders binds BitShares at
// module load, so the transport is mocked via loader hooks (require.cache
// injection cannot reach its static import).
esmMockEntry();

function makeGetObjectsMock() {
    const orders = new Map([
        ['1.7.1000', { id: '1.7.1000', sell_price: { base: { asset_id: '1.3.1', amount: 1000 }, quote: { asset_id: '1.3.2', amount: 1 } }, for_sale: '1000' }],
        ['1.7.1001', { id: '1.7.1001', sell_price: { base: { asset_id: '1.3.1', amount: 1000 }, quote: { asset_id: '1.3.2', amount: 1 } }, for_sale: '500' }],
        // A size-reducing update already landed: both for_sale and
        // sell_price.base dropped to 700. A builder holding the stale 1000
        // baseline must be refused before broadcast.
        ['1.7.1002', { id: '1.7.1002', sell_price: { base: { asset_id: '1.3.1', amount: 700 }, quote: { asset_id: '1.3.2', amount: 1 } }, for_sale: '700' }],
    ]);
    return {
        calls: 0,
        fn: async (ids: string[]) => {
            return ids.map((id) => orders.get(id) || null);
        },
    };
}

function makeUpdateOp(orderId: string, deltaAmount: number, sellAssetId = '1.3.1', newBase?: number) {
    // A builder reading a for_sale of 1000 emits new_price.base = 1000 + delta.
    // `newBase` overrides it to simulate a stale read (an update landed after
    // the builder read but before broadcast).
    return {
        op_name: 'limit_order_update',
        op_data: {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: '1.2.1',
            order: orderId,
            new_price: {
                base: { amount: newBase ?? 1000 + deltaAmount, asset_id: sellAssetId },
                quote: { amount: 1, asset_id: '1.3.2' },
            },
            delta_amount_to_sell: { amount: deltaAmount, asset_id: sellAssetId },
        },
    };
}

async function main() {
    console.log('\n[DRIFT-GUARD-01] findOverReducingUpdateOpError: over-reducing negative delta detected...');

    const getObjects = makeGetObjectsMock();
    const bitsharesClientPath = require.resolve('../modules/bitshares_client');
    defineEsmMockAbs(bitsharesClientPath, [
        'BitShares', 'createAccountClient', 'waitForConnected', 'getConnectionStatus',
        'disconnectClient', 'reconnectForCycle', 'setSuppressConnectionLog', 'onReconnect',
        'withTimeout', '_assessFailover', 'getNodeManager', 'getNodeStats', 'getNodeSummary',
        'getConnectionError', '_internal'
    ], {
        BitShares: {
            assets: {},
            db: { get_objects: async (ids) => { getObjects.calls++; return getObjects.fn(ids); } },
        },
        createAccountClient: () => ({ sign: () => {}, broadcast: async () => ({}) }),
        waitForConnected: async () => true,
        getConnectionStatus: () => ({ connected: true }),
        disconnectClient: async () => {},
        reconnectForCycle: async () => {},
        setSuppressConnectionLog: () => {},
        onReconnect: () => () => {},
        withTimeout: (p) => p,
        _assessFailover: () => null,
        getNodeManager: () => ({ getHealthyNodes: () => [] }),
        getNodeStats: () => null,
        getNodeSummary: () => null,
        getConnectionError: () => null,
        _internal: { get connected() { return false; } },
    });

    const chainOrders = require('../modules/chain_orders');

        // ── over-reducing delta → error matching the chain message ────────────
        // Order 1.7.1001 has for_sale=500; a delta of -600 would drive the new
        // size to -100 → chain rejection. The guard must surface it pre-broadcast.
        const driftError = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1001', -600),
        ]);
        assert.ok(driftError instanceof Error, 'over-reducing delta must yield an Error');
        assert.ok(
            /Cannot deduct all or more from order than order contains/.test(driftError.message),
            `error must match the chain rejection message for size-drift routing, got: ${driftError.message}`
        );
        console.log('  ✓ Over-reducing delta detected pre-broadcast');

        // ── sufficient for_sale → no error ────────────────────────────────────
        // Order 1.7.1000 has for_sale=1000; delta -600 leaves 400 → valid.
        const okResult = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1000', -600),
        ]);
        assert.strictEqual(okResult, null, 'a delta that leaves a positive residual must pass');
        console.log('  ✓ Valid reduction passes the guard');

        // ── cumulative over-reduction across two ops on the same order ────────
        // The chain applies a batch's ops sequentially, so two -600 deltas on
        // an order with for_sale=1000 drive it to -200 even though each op
        // individually leaves a positive residual. The guard must aggregate
        // deltas per order to catch the cumulative rejection.
        const cumulativeResult = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1000', -600),
            makeUpdateOp('1.7.1000', -600),
        ]);
        assert.ok(cumulativeResult instanceof Error, 'cumulative over-reduction across same-order ops must yield an Error');
        assert.ok(
            /Cannot deduct all or more from order than order contains/.test(cumulativeResult.message),
            'cumulative drift must route to the size-drift repair path'
        );
        console.log('  ✓ Cumulative same-order deltas detected as drift');

        // ── order gone from chain → detected as stale, not size drift ────────
        // An order missing on chain has no for_sale to re-size, so it must
        // route to stale-order cleanup (matching the chain's stale-order
        // message) rather than the size-drift repair path.
        const goneResult = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.9999', -100),
        ]);
        assert.ok(goneResult instanceof Error, 'an order missing on chain must be treated as drift');
        assert.ok(
            /object 1\.7\.9999 does not exist/.test(goneResult.message),
            'missing-order error must route to stale-order cleanup, got: ' + goneResult.message
        );
        console.log('  ✓ Missing on-chain order detected as stale (not size drift)');

        // ── stale base size → rejected pre-broadcast (live max_amount assert) ─
        // Chain order shrank to 700, but the op was built from the stale 1000
        // baseline: new_price.base=1050 > max(700,700)+50=750. The chain would
        // reject the chunk with o.new_price->base.amount <= max_amount_for_sale.
        const staleBaseResult = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1002', 50, '1.3.1', 1050),
        ]);
        assert.ok(staleBaseResult instanceof Error,
            'a stale for_sale baseline must yield a size-drift error pre-broadcast');
        assert.ok(
            /new_price\.base above max_amount_for_sale[\s\S]*detected pre-broadcast size-drift/.test(staleBaseResult.message),
            'error must route to the size-drift repair path, got: ' + staleBaseResult.message
        );
        console.log('  ✓ Stale new_price.base detected before broadcast');

        // ── a legitimate growth on a fresh read passes, with the new pre-read ─
        const beforeGrowth = getObjects.calls;
        const freshGrowth = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1000', 50), // chain for_sale=1000, sell_price.base=1000
        ]);
        assert.strictEqual(freshGrowth, null, 'growth derived from a fresh read must pass');
        assert.strictEqual(getObjects.calls, beforeGrowth + 1,
            'the new_price.base check must pre-read even for non-reducing updates');
        console.log('  ✓ Fresh-read growth passes the new_price.base check (and is pre-read)');

        // ── no update ops → no pre-read RPC ───────────────────────────────────
        const before = getObjects.calls;
        const noUpdate = await chainOrders.findOverReducingUpdateOpError([
            { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: 100, asset_id: '1.3.1' } } },
            { op_name: 'limit_order_cancel', op_data: { order: '1.7.1000' } },
        ]);
        assert.strictEqual(noUpdate, null, 'batches without update ops must pass');
        assert.strictEqual(getObjects.calls, before, 'no pre-read RPC without update ops');
        console.log('  ✓ No pre-read RPC for batches without update ops');

        // ── executeBatch surfaces the drift error BEFORE any broadcast ────────
        // The guard throws before createAccountClient/broadcast, so the raw
        // executeBatch call rejects with the drift error even with a stub that
        // cannot broadcast.
        await assert.rejects(
            () => chainOrders.executeBatch('test-account', 'dummy-key', [
                makeUpdateOp('1.7.1001', -600),
            ]),
            /Cannot deduct all or more from order than order contains/,
            'executeBatch must reject pre-broadcast on over-reducing deltas'
        );
        console.log('  ✓ executeBatch rejects over-reducing deltas before broadcast');

    console.log('All pre-broadcast size-drift guard tests passed.');
}

Promise.resolve()
    .then(() => main())
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('Test failed!');
        console.error(err);
        process.exit(1);
    });

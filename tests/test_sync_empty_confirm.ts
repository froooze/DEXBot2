/**
 * tests/test_sync_empty_confirm.ts
 *
 * Batch 2 (P2 — sync_engine): after SYNC_SUSPECT_EMPTY_READ_LIMIT
 * consecutive empty reads with placed grid orders still present, one
 * confirming re-read (after SYNC_EMPTY_READ_CONFIRM_DELAY_MS) is required
 * before reconciling to empty. Contradiction resets the counter; an
 * ambiguous re-read (truncated/read-error) defers; no chain identity
 * (unit tests, dry-run) keeps the legacy count-based acceptance.
 */

const assert = require('assert');
const path = require('path');
const { setCachedModule } = require('./helpers/module_cache_stub');
setCachedModule(
    path.resolve(__dirname, '../modules/bitshares_client.ts'),
    {
        BitShares: {},
        waitForConnected: async () => {},
        setSuppressConnectionLog() {},
    }
);
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../modules/constants');
const { createSilentLogger } = require('./helpers/silent_logger');
const { makeLadderFromPrices, ageChainIdAssignment } = require('./helpers/order_test_helpers');

const { _setFeeCache } = require('../modules/order/utils/math');
_setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 }
    }
});

const LIMIT = Math.max(1, Number(TIMING.SYNC_SUSPECT_EMPTY_READ_LIMIT) || 3);

const createManager = async () => {
    const mgr = new OrderManager({
        market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS'
    });
    // Skip the production SYNC_EMPTY_READ_CONFIRM_DELAY_MS pacing: this file
    // covers the confirm state machine, not the delay duration.
    mgr._skipEmptyReadConfirmDelay = true;
    mgr.logger = createSilentLogger();
    mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
    // Genesis-frozen engine: the sync gate refuses a populated grid with no
    // price ladder (INV-GRID-004), so the fixture carries one. `slot-1` is
    // ladder index 1, so the ladder must have at least two levels with 100 at
    // that index — a single-level ladder would leave the slot unaddressable.
    mgr._genesis = makeLadderFromPrices([1, 100]);
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 10, price: 100, orderId: '1.7.100'
    });
    // The fixture is a SETTLED placement (old enough that a read must be able
    // to show it); a fresh chain id would legitimately defer the absence
    // decision for SYNC_LOCK_TIMEOUT_MS (LifecycleView.isInFlight).
    ageChainIdAssignment(mgr, '1.7.100');
    return mgr;
};

async function runTests() {
    console.log('Running sync empty-confirm tests...');

    console.log(' - no chain identity keeps legacy count-based acceptance...');
    {
        const manager = await createManager();
        assert.strictEqual(manager.accountId, undefined, 'precondition: no accountId in unit manager');
        manager._suspectEmptyReads = { count: LIMIT - 1, firstAt: 1 };
        const result = await manager.sync.syncFromOpenOrders([]);
        assert.strictEqual(result.filledOrders.length, 1, 'legacy accept: missing ACTIVE reported filled');
        assert.deepStrictEqual(manager._suspectEmptyReads, { count: 0, firstAt: 0 }, 'counter reset after accept');
    }

    console.log(' - ambiguous confirm (read error) refuses and re-confirms next round...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.999';
        // Seam hook (the compiled chain_orders namespace is frozen, so the
        // confirm path offers manager._confirmEmptyReadFn as a test seam).
        // Throwing seam -> 'ambiguous' -> refuse, counter clamped at limit.
        manager._confirmEmptyReadFn = async () => { throw new Error('node down'); };
        manager._suspectEmptyReads = { count: LIMIT - 1, firstAt: 1 };
        const first = await manager.sync.syncFromOpenOrders([]);
        assert.strictEqual(first.filledOrders.length, 0, 'ambiguous confirm refuses reconciliation');
        assert.strictEqual(manager._suspectEmptyReads.count, LIMIT, 'counter clamped at limit for re-confirm');
        const slot = manager.orders.get('slot-1');
        assert.strictEqual(slot.state, ORDER_STATES.ACTIVE, 'live slot untouched');
        const second = await manager.sync.syncFromOpenOrders([]);
        assert.strictEqual(second.filledOrders.length, 0, 'still refusing while ambiguous');
        delete manager._confirmEmptyReadFn;
    }

    console.log(' - contradicted confirm resets the counter and refuses...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.999';
        // Contradicting re-read via the seam: non-empty snapshot.
        manager._confirmEmptyReadFn = async () => [{ id: '1.7.100' }];
        manager._suspectEmptyReads = { count: LIMIT - 1, firstAt: 1 };
        const result = await manager.sync.syncFromOpenOrders([]);
        assert.strictEqual(result.filledOrders.length, 0, 'contradicted round refuses reconciliation');
        assert.deepStrictEqual(manager._suspectEmptyReads, { count: 0, firstAt: 0 }, 'contradiction resets counter');
        assert.strictEqual(manager.orders.get('slot-1').state, ORDER_STATES.ACTIVE, 'live slot untouched');
        delete manager._confirmEmptyReadFn;
    }

    console.log(' - confirmed empty reconciles to empty after the limit...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.999';
        manager._confirmEmptyReadFn = async () => [];
        manager._suspectEmptyReads = { count: LIMIT - 1, firstAt: 1 };
        const result = await manager.sync.syncFromOpenOrders([]);
        assert.strictEqual(result.filledOrders.length, 1, 'confirmed empty reconciles (fill detected)');
        assert.deepStrictEqual(manager._suspectEmptyReads, { count: 0, firstAt: 0 }, 'counter reset after accept');
        delete manager._confirmEmptyReadFn;
    }

    console.log(' - pre-limit empties still refuse without any re-read...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.999';
        let reads = 0;
        manager._confirmEmptyReadFn = async () => { reads++; throw new Error('must not be called pre-limit'); };
        manager._suspectEmptyReads = { count: 0, firstAt: 0 };
        const result = await manager.sync.syncFromOpenOrders([]);
        assert.strictEqual(result.filledOrders.length, 0, 'pre-limit refuse');
        assert.strictEqual(reads, 0, 'no confirm re-read before the limit');
        delete manager._confirmEmptyReadFn;
    }

    console.log('\n✓ sync empty-confirm tests PASSED!');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});

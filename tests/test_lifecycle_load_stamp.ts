/**
 * tests/test_lifecycle_load_stamp.ts
 *
 * Contract: loading a grid snapshot must not re-stamp `assignedAt` for an
 * orderId this process already knows.
 *
 * The stamp is the "absence is not trustworthy yet" window (SYNC_LOCK_TIMEOUT_MS)
 * that protects a freshly broadcast/re-adopted chain id from a lagging chain
 * read. A snapshot load re-adopts OLD ids, so re-stamping them hands the same
 * (possibly dead) order a brand-new window on every reload. The reload that
 * follows a refused UPDATE then re-armed it indefinitely, so a genuinely absent
 * orderId could never be cleaned up — it stayed parked in the gap band, blocked
 * the boundary crawl and kept the sell rail from being promoted into the band.
 *
 * First sight of an id (fresh process) must still get the grace: that is the
 * startup path this window exists for.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { createSilentLogger } = require('./helpers/silent_logger');
const { makeLadderFromPrices } = require('./helpers/order_test_helpers');

require('../modules/order/utils/math')._setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 },
        makerFeeDiscountPercent: 0.9,
    },
    TEST: { chargesMarketFees: false },
});

let failures = 0;
function check(name: string, actual: any, expected: any) {
    try {
        assert.deepStrictEqual(actual, expected);
        console.log(`   ✓ ${name}`);
    } catch (err: any) {
        failures += 1;
        console.error(`   ✗ ${name}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`);
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testLoadDoesNotRestampKnownOrderId() {
    console.log('\n[1] A reload does not re-stamp a known orderId');
    const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
    manager.logger = createSilentLogger();
    manager.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    manager._genesis = makeLadderFromPrices([50]);
    await manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });

    const slot = (orderId: string, size: number) => ({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
        size, price: 50, orderId,
    });
    const ORDER_ID = '1.7.900';

    // A snapshot reload is: drop the master map, then re-apply every persisted
    // slot. `_clearOrderCachesLogic` (grid.ts) replaces the map exactly like
    // this, which is what makes the reload's `_applyOrderUpdate` see NO previous
    // order and take the id-changed branch below.
    const dropMasterGrid = () => { manager.orders = Object.freeze(new Map()); };

    // Startup-style load of a persisted, long-lived order: nothing is known
    // about this id yet, so it still gets the fresh-assignment grace.
    dropMasterGrid();
    await manager._applyOrderUpdate(slot(ORDER_ID, 500), 'grid-load', { skipAccounting: true });
    const firstStamp = manager._orderIdAssignedAt.get(ORDER_ID);
    check('first sight of an id is stamped', Number.isFinite(firstStamp), true);
    check('first sight reads recently-assigned', manager.getLifecycle(ORDER_ID).isRecentlyAssigned(), true);

    // A recovery reload of the SAME snapshot must not move the clock: the id is
    // old by definition, and re-stamping it renews the absence grace that keeps
    // a dead orderId (and its in-band slot) alive forever.
    await sleep(20);
    dropMasterGrid();
    await manager._applyOrderUpdate(slot(ORDER_ID, 390), 'grid-load', { skipAccounting: true });
    check('reload keeps the original assignment stamp', manager._orderIdAssignedAt.get(ORDER_ID), firstStamp);

    // Virtualising the slot (a phantom fill booked in memory) must not erase
    // the fact that the id is known, or the next stale reload would re-stamp it.
    await manager._applyOrderUpdate(
        { id: 'slot-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SPREAD, size: 0, price: 50, orderId: '' },
        'sync-cleanup-phantom',
        { skipAccounting: true }
    );
    check('virtualising does not forget the known id', manager._orderIdAssignedAt.get(ORDER_ID), firstStamp);

    // The pathological case: a stale snapshot resurrects the id the engine just
    // virtualised. Even then the clock must not move, or every reload would
    // re-arm the grace that protects the ghost.
    dropMasterGrid();
    await manager._applyOrderUpdate(slot(ORDER_ID, 500), 'grid-load', { skipAccounting: true });
    check('resurrected id keeps the original stamp', manager._orderIdAssignedAt.get(ORDER_ID), firstStamp);

    // A genuine new assignment (rotation / re-place) still stamps: this is the
    // window the grace exists for.
    await manager._applyOrderUpdate(slot('1.7.901', 390), 'order-update', { skipAccounting: true });
    check('a new chain id is stamped', Number.isFinite(manager._orderIdAssignedAt.get('1.7.901')), true);
    check('a new chain id reads recently-assigned', manager.getLifecycle('1.7.901').isRecentlyAssigned(), true);
}

async function testFreshProcessStillGetsGrace() {
    console.log('\n[2] A fresh process still gets the grace for a first-seen id');
    const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
    manager.logger = createSilentLogger();
    manager.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    manager._genesis = makeLadderFromPrices([50]);
    await manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });

    // Two different slots, two ids never seen before this load.
    for (const [id, orderId] of [['slot-1', '1.7.910'], ['slot-2', '1.7.911']]) {
        await manager._applyOrderUpdate(
            { id, state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 100, price: 50, orderId },
            'grid-load',
            { skipAccounting: true }
        );
        check(`${orderId} first sight is stamped`, Number.isFinite(manager._orderIdAssignedAt.get(orderId)), true);
        check(`${orderId} first sight defers absence`, manager.getLifecycle(orderId).isInFlight(), true);
    }
}

async function run() {
    console.log('Running lifecycle load-stamp tests...');
    await testLoadDoesNotRestampKnownOrderId();
    await testFreshProcessStillGetsGrace();

    if (failures > 0) {
        console.error(`\n❌ ${failures} lifecycle load-stamp assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All lifecycle load-stamp assertions passed');
}

run().catch((err) => {
    console.error('Lifecycle load-stamp test failed:', err);
    process.exit(1);
});

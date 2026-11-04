/**
 * tests/test_fill_ledger.ts
 *
 * P2 gates for the fill pipeline: fill identity, traded side, booked membership.
 *
 * The bug class: "which fill is this?", "which side did it trade?" and "is it
 * already booked?" were each answered in more than one module. `cb1041b6` had
 * to patch the same undefined-pays-asset collision in `_computeFillContext`,
 * the unmatched-fill attribution and the queued-pivot refresh; the paid asset
 * is chain truth and the slot type is only a fallback (a partial fill retags
 * it to the traded side, see INV-SYNC-008).
 *
 * `modules/order/fill_ledger.ts` owns the three pure questions. This test pins
 * their answers, and `test_fill_pipeline_contract.ts` pins that no second
 * implementation appears.
 */

const assert = require('assert');
const { ORDER_TYPES } = require('../modules/constants');
const { fillKeyOf, resolveTradedSide, isFillBooked } = require('../modules/order/fill_ledger');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
    try {
        assert.deepStrictEqual(actual, expected);
        console.log(`   ✓ ${name}`);
    } catch {
        failures += 1;
        console.error(`   ✗ ${name}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`);
    }
}

const ASSETS = { assetA: { id: '1.3.0' }, assetB: { id: '1.3.121' } };

function testFillKey() {
    console.log('\n[1] Fill identity is (orderId, blockNum, historyId)');
    check('chain op shape', fillKeyOf({ op: [null, { order_id: '1.7.1' }], block_num: 42, id: '1.11.9' }), '1.7.1:42:1.11.9');
    check('flat shape', fillKeyOf({ orderId: '1.7.2', blockNum: 43, historyId: '1.11.10' }), '1.7.2:43:1.11.10');
    check('op orderId wins over the flat fallback', fillKeyOf({ op: [null, { order_id: '1.7.3' }], orderId: '1.7.99', block_num: 1, id: 'x' }), '1.7.3:1:x');
    check('no order id -> null', fillKeyOf({ block_num: 1, id: 'x' }), null);
    check('no block -> null', fillKeyOf({ orderId: '1.7.1', id: 'x' }), null);
    check('no history id -> null', fillKeyOf({ orderId: '1.7.1', block_num: 1 }), null);
    check('empty input -> null', fillKeyOf(null), null);
}

function testTradedSide() {
    console.log('\n[2] The paid asset decides the side; the slot label is only a fallback');
    check('pays quote -> BUY', resolveTradedSide('1.3.121', ASSETS), ORDER_TYPES.BUY);
    check('pays base -> SELL', resolveTradedSide('1.3.0', ASSETS), ORDER_TYPES.SELL);
    check('paid asset beats a contradicting slot label (BUY slot, pays base)', resolveTradedSide('1.3.0', ASSETS, ORDER_TYPES.BUY), ORDER_TYPES.SELL);
    check('paid asset beats a contradicting slot label (SELL slot, pays quote)', resolveTradedSide('1.3.121', ASSETS, ORDER_TYPES.SELL), ORDER_TYPES.BUY);

    check('no pays asset falls back to the slot side', resolveTradedSide(null, ASSETS, ORDER_TYPES.BUY), ORDER_TYPES.BUY);
    check('undefined pays asset falls back too', resolveTradedSide(undefined, ASSETS, ORDER_TYPES.SELL), ORDER_TYPES.SELL);
    check('unrelated paid asset falls back', resolveTradedSide('1.3.999', ASSETS, ORDER_TYPES.BUY), ORDER_TYPES.BUY);
    check('SPREAD is never returned', resolveTradedSide(null, ASSETS, ORDER_TYPES.SPREAD), null);
    check('no pays asset and no fallback -> null (never guessed)', resolveTradedSide(null, ASSETS), null);
    check('missing assets cannot invent a side', resolveTradedSide('1.3.121', null), null);
}

function testBookedMembership() {
    console.log('\n[3] Booked membership reads the persisted dedupe authority');
    const tracker = new Map<string, number>([['1.7.1:42:1.11.9', 1_000]]);
    check('booked key is found', isFillBooked({ tracker }, '1.7.1:42:1.11.9'), true);
    check('unknown key is not booked', isFillBooked({ tracker }, '1.7.1:42:1.11.10'), false);
    check('missing key is not booked', isFillBooked({ tracker }, null), false);
    check('missing store is not booked', isFillBooked(null, '1.7.1:42:1.11.9'), false);
    check('non-Map tracker is not booked (no throw)', isFillBooked({ tracker: {} as unknown as Map<string, number> }, '1.7.1:42:1.11.9'), false);
    check('membership does not mutate', tracker.size, 1);
}

function run() {
    console.log('Fill ledger tests');
    testFillKey();
    testTradedSide();
    testBookedMembership();
    if (failures > 0) {
        console.error(`\n❌ ${failures} fill-ledger assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All fill-ledger assertions passed');
}

run();

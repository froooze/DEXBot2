/**
 * tests/test_shared_readers.ts
 *
 * Contract for the single-source readers added by the post-v1.7.3 audit:
 * gone-order wording, UPDATE-target classification, in-flight flags and the
 * absent-aware gap. Each one replaced a hand-rolled copy that answered the
 * same question with a different rule (R3.5 "one rule, several
 * implementations"); these pins stop the copy from coming back.
 */

const assert = require('assert');
const {
    extractGoneOrderIds,
    extractUpdateTargetOrderIds,
    readBotInFlightFlags,
} = require('../modules/order/utils/system');
const { resolveGapSlots } = require('../modules/order/utils/math');

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

console.log('=== Shared single-source readers ===');

// 1. One parser for every chain wording of "order id gone". The old COW
// classifier and the size-drift repair carried different regex sets.
console.log('\n[1] extractGoneOrderIds covers every node wording');
for (const msg of [
    'Limit order 1.7.1001 does not exist',
    'Unable to find Object 1.7.1002',
    'object 1.7.1003 does not exist',
    'object 1.7.1004 not found',
    'order 1.7.1005 does not exist',
]) {
    check(msg, [...extractGoneOrderIds(new Error(msg))].length, 1);
}
check('duplicates collapse', [...extractGoneOrderIds(new Error('object 1.7.1 does not exist; order 1.7.1 does not exist'))], ['1.7.1']);
check('unrelated error has no ids', [...extractGoneOrderIds(new Error('Cannot deduct all or more from order'))], []);
check('order wording is word-bounded',
    [...extractGoneOrderIds(new Error('someorder 1.7.99 does not exist'))], []);

// 2. A vanished CANCEL target is harmless; only UPDATE targets may reach the
// in-place repair. The batch context must name the operation kind.
console.log('\n[2] extractUpdateTargetOrderIds classifies by planned operation');
check('size-update target', [...extractUpdateTargetOrderIds([
    { kind: 'size-update', updateInfo: { partialOrder: { orderId: '1.7.10' } } },
])], ['1.7.10']);
check('rotation target', [...extractUpdateTargetOrderIds([
    { kind: 'rotation', rotation: { oldOrder: { orderId: '1.7.11' } } },
])], ['1.7.11']);
check('cancel target is not an update target', [...extractUpdateTargetOrderIds([
    { kind: 'cancel', order: { orderId: '1.7.12' } },
])], []);

// 3. Both destructive-reload gates read the same flags. The deferred-rebalance
// stamp is manager-scoped; counters are bot-scoped. Unreadable is an answer.
console.log('\n[3] readBotInFlightFlags reads each field from its real owner');
check('manager-scoped deferred rebalance is visible', readBotInFlightFlags({
    manager: { _deferredRebalanceAt: 123 },
}), { ok: true, batchInFlight: false, recoveryInFlight: false, deferredRebalance: true });
check('bot-scoped counters are visible', readBotInFlightFlags({
    _batchInFlight: 2,
    manager: {},
}), { ok: true, batchInFlight: true, recoveryInFlight: false, deferredRebalance: false });
check('unreadable counter is not "settled"', readBotInFlightFlags({
    _batchInFlight: 'exploded',
    manager: {},
}), { ok: false, batchInFlight: false, recoveryInFlight: false, deferredRebalance: false });

// 4. Unknown gap geometry must never be coerced to 0. The preferred value lets
// the strategy keep genesis priority without re-implementing the absent-aware
// read (which used to let '' become a genuine gap 0).
console.log('\n[4] resolveGapSlots is absent-aware with genesis priority');
const cfg = { incrementPercent: 1, targetSpreadPercent: 10, gridLimits: {} };
const derived = resolveGapSlots({ _gapSlots: '', config: cfg });
check('blank live gap falls back to config', derived > 0, true);
check('explicit live gap wins', resolveGapSlots({ _gapSlots: 3, config: cfg }), 3);
check('preferred genesis gap wins over live', resolveGapSlots({ _gapSlots: 3, config: cfg }, 5), 5);
check('blank preferred falls through to live', resolveGapSlots({ _gapSlots: 3, config: cfg }, ''), 3);

if (failures > 0) {
    console.error(`\n❌ ${failures} shared-reader assertion(s) failed`);
    process.exit(1);
}
console.log('\n✅ All shared-reader assertions passed');

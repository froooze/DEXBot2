/**
 * tests/test_order_lifecycle.ts
 *
 * Pins the contract of modules/order/lifecycle.ts — the single owner of
 * "does this order exist on chain, and how sure are we".
 *
 * The bug class these tests exist to prevent: the engine answered that
 * question from seven independent structures, each with its own clock, and
 * four read sites consulted four different subsets. The same order could be
 * "committed" to one site and "gone" to another.
 */

const assert = require('assert');
const { LifecycleRegistry, readLifecycle } = require('../modules/order/lifecycle');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../modules/constants');
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

const T0 = 1_700_000_000_000;

function registry(now = { at: T0 }) {
    return { reg: new LifecycleRegistry({ now: () => now.at }), now };
}

// ---------------------------------------------------------------------------
// 1. One record per slot across its order incarnations
// ---------------------------------------------------------------------------
function testSingleRecordPerSlot() {
    console.log('\n[1] One record per slot across incarnations');
    const { reg, now } = registry();

    // A CREATE is broadcast with no chain id yet (fingerprint only).
    reg.setPending('fp-a', { slotId: 'slot-1', order: { id: 'slot-1' }, fingerprint: 'fp-a' });
    check('pending create is broadcasting', reg.view('slot-1').phase, 'broadcasting');
    check('broadcasting may exist on chain', reg.view('slot-1').mayExistOnChain, true);
    check('broadcasting is unresolved but not unknown', [reg.view('slot-1').isUnresolved, reg.view('slot-1').isUnknown], [true, false]);

    // The receipt arrives: an id is assigned and the chain confirms it.
    reg.markAssigned('slot-1', '1.7.100', now.at);
    reg.markPlaced('1.7.100', now.at, 'slot-1');
    reg.markLanded('1.7.100', { slotId: 'slot-1' });
    reg.deletePending('fp-a');
    check('resolved pending does not downgrade a landed order', reg.view('slot-1').phase, 'landed');
    check('the same record owns the chain id', reg.view('1.7.100').slotId, 'slot-1');
    check('one record for the whole incarnation', reg.size(), 1);

    // A rotation replaces the chain id: SAME record, not a parallel one.
    now.at += 1000;
    reg.markAssigned('slot-1', '1.7.200', now.at);
    reg.markLanded('1.7.200', { slotId: 'slot-1' });
    check('rotation keeps one record', reg.size(), 1);
    check('record follows the new chain id', reg.view('slot-1').orderId, '1.7.200');
    check('fresh placement stamped', reg.view('slot-1').isFreshlyPlaced(undefined, now.at), true);
}

// ---------------------------------------------------------------------------
// 2. `unknown` never reads as "gone"
// ---------------------------------------------------------------------------
function testUnknownNeverGone() {
    console.log('\n[2] unknown ≠ gone');
    const { reg, now } = registry();
    reg.markUnknown(null, { slotId: 'slot-2', evidence: 'broadcast-receipt' });
    const view = reg.view('slot-2');
    check('phase is unknown', view.phase, 'unknown');
    check('isUnknown', view.isUnknown, true);
    check('isUnresolved', view.isUnresolved, true);
    check('is NOT confirmed gone', view.isConfirmedGone, false);
    check('may exist on chain', view.mayExistOnChain, true);
    check('suppresses absence decisions while fresh', view.isInFlight(undefined, now.at), true);

    // ...but the suppression is bounded so a lagging node cannot park the grid.
    const ttl = Number(TIMING.PENDING_BROADCAST_TTL_MS) || 30 * 60 * 1000;
    check('still suppressed just inside the bound', view.isInFlight(undefined, now.at + ttl * 2 - 1), true);
    check('released past 2× the pending TTL', view.isInFlight(undefined, now.at + ttl * 2 + 1), false);
}

// ---------------------------------------------------------------------------
// 3. Resolved vs abandoned pending CREATE
// ---------------------------------------------------------------------------
function testPendingResolutionVsAbandon() {
    console.log('\n[3] pending CREATE: resolved ≠ abandoned');
    const { reg } = registry();

    // Resolved (adoption / receipt): the slot is a clean intent again.
    reg.setPending('fp-ok', { slotId: 'slot-3', order: { id: 'slot-3' }, fingerprint: 'fp-ok' });
    reg.deletePending('fp-ok');
    check('resolved pending → intent', reg.view('slot-3').phase, 'intent');
    check('resolved pending is not in flight', reg.view('slot-3').isInFlight(), false);

    // Abandoned (TTL sweep): the order may still be live — must NOT be a hole.
    reg.setPending('fp-lost', { slotId: 'slot-4', order: { id: 'slot-4' }, fingerprint: 'fp-lost' });
    reg.deletePending('fp-lost');
    reg.markUnknown(null, { slotId: 'slot-4', evidence: 'local' });
    check('abandoned pending → unknown', reg.view('slot-4').phase, 'unknown');
    check('abandoned pending is still in flight', reg.view('slot-4').isInFlight(), true);
}

// ---------------------------------------------------------------------------
// 4. Committed snapshot stamp (per-snapshot, not per-id)
// ---------------------------------------------------------------------------
function testCommittedSnapshot() {
    console.log('\n[4] Committed snapshot stamp');
    const { reg, now } = registry();
    reg.markCommittedSnapshot(['1.7.300', '1.7.301'], now.at);
    check('committed id is recently committed', reg.view('1.7.300').isRecentlyCommitted(undefined, now.at), true);
    check('stamp exposed', reg.committedBuiltAt, now.at);

    // Moving the snapshot stamp makes the whole Set stale at once.
    reg.committedBuiltAt = 1;
    check('stale stamp makes committed ids stale', reg.view('1.7.300').isRecentlyCommitted(undefined, now.at), false);

    // Leaving the published set must remove protection, not fall back to a
    // per-id stamp. An order dropped from the commit's finalMap (filled or
    // virtualized) is no longer protected.
    now.at = T0 + 10;
    reg.markCommittedSnapshot(['1.7.300'], now.at);
    check('re-published set protects again', reg.view('1.7.300').isRecentlyCommitted(undefined, now.at), true);
    check('id dropped from the set is unprotected', reg.view('1.7.301').isRecentlyCommitted(undefined, now.at), false);

    // A per-id delete must win over an earlier snapshot publish.
    reg.markCommittedSnapshot(['1.7.300', '1.7.301'], now.at);
    reg.committedIds.delete('1.7.300');
    check('per-id delete clears protection despite a fresh snapshot',
        reg.view('1.7.300').isRecentlyCommitted(undefined, now.at), false);
    check('the other id stays protected', reg.view('1.7.301').isRecentlyCommitted(undefined, now.at), true);
}

// ---------------------------------------------------------------------------
// 5. Legacy structures are views, not copies
// ---------------------------------------------------------------------------
function testFacadeIsNotACopy() {
    console.log('\n[5] Legacy maps are views onto the record');
    const { reg, now } = registry();

    reg.placedAt.set('1.7.400', now.at);
    check('write through _placedAt lands in the record', reg.view('1.7.400').placedAt, now.at);
    check('_placedAt.get reads the record', reg.placedAt.get('1.7.400'), now.at);

    reg.placedAt.delete('1.7.400');
    check('delete through _placedAt clears the record', reg.view('1.7.400').placedAt, 0);

    reg.assignedAt.set('1.7.401', now.at);
    check('assignedAt round-trips', reg.view('1.7.401').assignedAt, now.at);

    reg.committedIds.add('1.7.402');
    check('committedIds round-trips', reg.view('1.7.402').isRecentlyCommitted(undefined, now.at), true);
    check('committedIds.size counts records', reg.committedIds.size >= 1, true);

    reg.appliedFills.set('1.7.403', { filledInt: 42, at: now.at });
    check('appliedFills round-trips', reg.appliedFills.get('1.7.403')?.filledInt, 42);
    check('appliedFillMatches', reg.view('1.7.403').appliedFillMatches(42), true);
    check('appliedFillMatches rejects a different amount', reg.view('1.7.403').appliedFillMatches(41), false);

    // Iteration must yield the same tuples a real Map would.
    reg.placedAt.set('1.7.404', now.at);
    const tuples = [...reg.placedAt.entries()];
    check('entries() yields the live placed tuples', tuples.length, 1);
    check('tuple carries the chain id', tuples[0][0], '1.7.404');
    check('tuple carries the stamp', tuples[0][1], now.at);
    check('spread of a facade Map yields the same tuples', [...reg.placedAt].length, 1);
}

// ---------------------------------------------------------------------------
// 6. Eviction never forgets an unresolved order
// ---------------------------------------------------------------------------
function testEvictionKeepsUnresolved() {
    console.log('\n[6] Eviction keeps unresolved records');
    const reg = new LifecycleRegistry({ now: () => T0, maxRecords: 3 });
    for (let i = 0; i < 6; i += 1) reg.markIntent({ slotId: `settled-${i}` });
    for (let i = 0; i < 3; i += 1) reg.markUnknown(null, { slotId: `unknown-${i}` });
    check('size stays at the cap', reg.size() <= 3 + 3, true);
    check('unknown-0 survives eviction', reg.view('unknown-0').isUnknown, true);
    check('unknown-2 survives eviction', reg.view('unknown-2').isUnknown, true);

    // The record just created must survive its own insertion even when every
    // record shares one millisecond (deterministic clocks do exactly that).
    const tiny = new LifecycleRegistry({ now: () => T0, maxRecords: 1 });
    tiny.markIntent({ slotId: 'a' });
    tiny.markIntent({ slotId: 'b' });
    check('the newest record survives prune', tiny.view('b').phase, 'intent');
}

// ---------------------------------------------------------------------------
// 6b. A pending CREATE with no slot id still gets a record
// ---------------------------------------------------------------------------
function testPendingWithoutSlotId() {
    console.log('\n[6b] Pending CREATE without a slot id');
    const { reg, now } = registry();
    reg.setPending('fp-noslot', { fingerprint: 'fp-noslot', order: { price: 50 } });
    check('broadcasting without a slot', reg.view('fp-noslot').phase, 'broadcasting');
    check('may exist on chain', reg.view('fp-noslot').mayExistOnChain, true);
    check('pending size', reg.pendingSize(), 1);
    reg.markAssigned(null, '1.7.900', now.at);
    reg.markLanded('1.7.900', { evidence: 'adoption' });
    reg.deletePending('fp-noslot');
    check('resolved pending leaves the adopted order alone', reg.view('1.7.900').phase, 'landed');
    check('pending cleared', reg.pendingSize(), 0);
}

// ---------------------------------------------------------------------------
// 7. readLifecycle works on partial doubles (no registry)
// ---------------------------------------------------------------------------
function testReadLifecycleFallback() {
    console.log('\n[7] readLifecycle() works without a registry');
    const legacy = {
        _placedAt: new Map([['1.7.500', T0]]),
        _orderIdAssignedAt: new Map([['1.7.500', T0]]),
        _committedOrderIds: new Set(['1.7.500']),
        _committedOrderIdsBuiltAt: T0,
    };
    const view = readLifecycle(legacy, '1.7.500');
    check('fallback reads placedAt', view.placedAt, T0);
    check('fallback reads assignedAt', view.assignedAt, T0);
    check('fallback reads committed', view.committedAt, T0);
    check('fallback never reports gone', view.isConfirmedGone, false);

    const stranger = readLifecycle(legacy, '1.7.999');
    check('unknown identity is not gone', stranger.isConfirmedGone, false);
    check('unknown identity may not exist', stranger.mayExistOnChain, false);

    // A committed id with NO published stamp is not freshly committed: the
    // registry measures the window from the stamp, and the fallback must not
    // invent one.
    const unstamped = { _committedOrderIds: new Set(['1.7.501']) };
    check('unstamped commit is not protected',
        readLifecycle(unstamped, '1.7.501').isRecentlyCommitted(undefined, T0), false);
}

// ---------------------------------------------------------------------------
// 8. The real OrderManager: one answer across all read sites
// ---------------------------------------------------------------------------
async function testManagerAgreement() {
    console.log('\n[8] OrderManager: all read sites agree');
    const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
    manager.logger = createSilentLogger();
    manager.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    manager._genesis = makeLadderFromPrices([50]);
    await manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });

    // A create that landed and committed: every structure must describe the
    // same record.
    await manager._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
        size: 100, price: 50, orderId: '1.7.600',
    });
    manager._committedOrderIds.add('1.7.600');
    manager._committedOrderIdsBuiltAt = Date.now();
    manager._placedAt.set('1.7.600', Date.now());
    manager._orderIdAssignedAt.set('1.7.600', Date.now());

    const view = manager.getLifecycle('1.7.600');
    check('phase landed after ACTIVE update', view.phase, 'landed');
    check('committed visible', view.isRecentlyCommitted(), true);
    check('assigned visible', view.isRecentlyAssigned(), true);
    check('placed visible', view.isFreshlyPlaced(), true);
    check('in flight', view.isInFlight(), true);
    check('one record for slot+order', manager._lifecycle.size(), 1);
    check('slot lookup resolves to the same view', manager.getLifecycle('slot-1').orderId, '1.7.600');

    // A create-uncertain slot must read as unknown through the slot helper even
    // when nothing was ever written to the registry.
    await manager._updateOrder({
        id: 'slot-2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SELL,
        size: 5, price: 51, orderId: '',
    });
    const slot = manager.orders.get('slot-2');
    check('clean virtual slot is intent', manager.getSlotLifecycle(slot).phase, 'intent');
    const applied = await manager.applyGridUpdateBatch([{ ...slot, createUncertain: true }], 'test-create-uncertain');
    check('createUncertain write accepted', applied, true);
    check('createUncertain slot reads as unknown', manager.getSlotLifecycle(manager.orders.get('slot-2')).phase, 'unknown');
    check('createUncertain slot may exist on chain', manager.getSlotLifecycle(manager.orders.get('slot-2')).mayExistOnChain, true);
    check('createUncertain is in flight', manager.getSlotLifecycle(manager.orders.get('slot-2')).isInFlight(), true);

    // Clearing the marker must release the phase, not leave it stuck at unknown.
    await manager.applyGridUpdateBatch([{ ...manager.orders.get('slot-2'), createUncertain: false }], 'test-clear-uncertain');
    check('cleared marker returns to intent', manager.getSlotLifecycle(manager.orders.get('slot-2')).phase, 'intent');
}

// ---------------------------------------------------------------------------
// 9. Reads must not write; unresolved evidence survives unrelated mutations
// ---------------------------------------------------------------------------
async function testReadPurityAndEvidenceRetention() {
    console.log('\n[9] Reads are pure; unresolved evidence survives unrelated mutations');
    const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
    manager.logger = createSilentLogger();
    manager.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    manager._genesis = makeLadderFromPrices([50]);
    await manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });

    // A lost CREATE receipt: the slot carries the persisted marker.
    await manager._updateOrder({
        id: 'slot-u', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY,
        size: 5, price: 50, orderId: '', createUncertain: true,
    });
    const before = manager._lifecycle.snapshot('slot-u');
    check('unresolved slot reads unknown', manager.getSlotLifecycle(manager.orders.get('slot-u')).phase, 'unknown');
    const after = manager._lifecycle.snapshot('slot-u');
    check('reading did not bump the record revision', after?.revision, before?.revision);
    check('reading did not move the recorded clock', after?.recordedAt, before?.recordedAt);

    // An unrelated mutation (a size tweak from a re-plan) must NOT erase the
    // unknown phase — "nothing is out there" is a claim needing evidence.
    await manager._updateOrder({
        id: 'slot-u', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY,
        size: 6, price: 50, orderId: '', createUncertain: true,
    });
    check('unrelated mutation keeps the unknown phase', manager.getSlotLifecycle(manager.orders.get('slot-u')).phase, 'unknown');

    // An explicit clear of the marker IS evidence, so the slot becomes a clean
    // intent again.
    await manager._updateOrder({
        id: 'slot-u', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY,
        size: 0, price: 50, orderId: '', createUncertain: false,
    });
    check('explicit marker clear resolves to intent', manager.getSlotLifecycle(manager.orders.get('slot-u')).phase, 'intent');

    // Same rule for a record marked unknown directly (abandoned pending create).
    manager._lifecycle.markUnknown(null, { slotId: 'slot-v' });
    check('directly marked unknown', manager.getSlotLifecycle({ id: 'slot-v' }).phase, 'unknown');
    manager._lifecycle.markIntentIfResolved('slot-v');
    check('markIntentIfResolved preserves unknown', manager.getSlotLifecycle({ id: 'slot-v' }).phase, 'unknown');
    manager._lifecycle.markIntent({ slotId: 'slot-v' });
    check('explicit markIntent resolves it', manager.getSlotLifecycle({ id: 'slot-v' }).phase, 'intent');
}

// ---------------------------------------------------------------------------
// 10. Rotation must not leak records or strand the placement stamp
// ---------------------------------------------------------------------------
async function testRotationDoesNotLeak() {
    console.log('\n[10] Rotation keeps one record per slot and keeps stamps on it');
    const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
    manager.logger = createSilentLogger();
    manager.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    manager._genesis = makeLadderFromPrices([48, 49, 50]);
    await manager.setAccountTotals({ buy: 1e6, sell: 1e6, buyFree: 1e6, sellFree: 1e6 });

    for (let i = 0; i < 3; i += 1) {
        await manager._updateOrder({
            id: `slot-${i}`, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL,
            price: 48 + i, size: 10, orderId: '',
        });
    }

    for (let i = 0; i < 60; i += 1) {
        const slot = `slot-${i % 3}`;
        await manager._updateOrder({
            id: slot, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE,
            price: 48 + (i % 3), size: 10, orderId: `1.7.${5000 + i}`,
        });
    }

    check('one record per slot after 60 rotations', manager._lifecycle.size(), 3);
    check('placedAt holds one entry per slot', manager._placedAt.size, 3);
    check('assignedAt holds one entry per slot', manager._orderIdAssignedAt.size, 3);

    const lastOrderId = `1.7.${5000 + 59}`;
    const view = manager.getLifecycle(lastOrderId);
    check('the last chain id resolves to its slot', view.slotId, 'slot-2');
    check('the placement stamp survived the rotation', view.isFreshlyPlaced(), true);
    check('the slot resolves to the same record', manager.getLifecycle('slot-2').placedAt, view.placedAt);
    check('a retired chain id is unknown, not a stale record', manager.getLifecycle('1.7.5000').orderId, null);
}

// ---------------------------------------------------------------------------
// 10b. The unresolved bound is measured from when the uncertainty was RECORDED
// ---------------------------------------------------------------------------
async function testUnresolvedBoundIsNotRefreshedByReAssertion() {
    console.log('\n[10b] Re-asserting an unresolved phase does not extend its bound');
    const { reg, now } = registry();
    const ttl = Number(TIMING.PENDING_BROADCAST_TTL_MS) || 30 * 60 * 1000;
    const bound = ttl * 2;

    reg.markUnknown(null, { slotId: 'slot-bound', evidence: 'local' });
    // A later, unrelated mutation re-asserts the same unresolved phase without
    // new evidence (the write funnel does this on every size tweak).
    now.at += Math.floor(bound / 2);
    reg.markUnknown(null, { slotId: 'slot-bound', evidence: 'local' });

    check('still in flight before the bound', reg.view('slot-bound').isInFlight(undefined, T0 + bound - 1), true);
    check('released after the bound even though it was re-asserted',
        reg.view('slot-bound').isInFlight(undefined, T0 + bound + 1), false);

    // Chain-backed evidence IS new information and may move the clock.
    const { reg: reg2, now: now2 } = registry();
    reg2.markUnknown(null, { slotId: 'slot-bound-2', evidence: 'local' });
    now2.at += Math.floor(bound * 0.75);
    reg2.markUnknown('9.9.9', { slotId: 'slot-bound-2', evidence: 'chain-snapshot' });
    check('a fresh chain reading restarts the bound',
        reg2.view('slot-bound-2').isInFlight(undefined, T0 + bound + 1), true);
}

// ---------------------------------------------------------------------------
// 10c. An expired unknown resolves instead of sticking forever
// ---------------------------------------------------------------------------
async function testExpiredUnknownResolves() {
    console.log('\n[10c] Expired unknown resolves on an explicit intent write');
    const { reg, now } = registry();
    const ttl = Number(TIMING.PENDING_BROADCAST_TTL_MS) || 30 * 60 * 1000;

    reg.markUnknown(null, { slotId: 'slot-exp', evidence: 'local' });
    const fresh = reg.markIntentIfResolved('slot-exp');
    check('inside the bound the unknown still speaks', fresh.phase, 'unknown');
    check('inside the bound it may still exist', fresh.mayExistOnChain, true);

    now.at += ttl * 2 + 1;
    check('past the bound the absence decision was already released',
        reg.view('slot-exp').isInFlight(undefined, now.at), false);
    const resolved = reg.markIntentIfResolved('slot-exp');
    check('past the bound an explicit intent write resolves the phase', resolved.phase, 'intent');
    check('a resolved slot may not exist on chain', resolved.mayExistOnChain, false);
}

// ---------------------------------------------------------------------------
// 10d. Evidence is monotonic within a phase
// ---------------------------------------------------------------------------
async function testEvidenceMonotonicity() {
    console.log('\n[10d] Evidence never downgrades within a phase');
    const { reg, now } = registry();

    reg.markLanded('1.7.700', { slotId: 'slot-ev', evidence: 'chain-snapshot' });
    const afterChain = reg.view('1.7.700');
    check('chain snapshot recorded', afterChain.evidence, 'chain-snapshot');
    check('observedAt advanced by the chain read', afterChain.observedAt, now.at);

    now.at += 1000;
    // The write funnel only knows the LOCAL slot state; it must not overwrite
    // what the chain just told us.
    reg.observe('1.7.700', { slotId: 'slot-ev', phase: 'landed', evidence: 'local' });
    const afterLocal = reg.view('1.7.700');
    check('local bookkeeping does not downgrade the evidence', afterLocal.evidence, 'chain-snapshot');
    check('local bookkeeping does not move observedAt', afterLocal.observedAt, afterChain.observedAt);
    check('isChainBacked reports the strongest basis', afterLocal.isChainBacked(), true);

    // A PHASE CHANGE is new information, so the new record's evidence wins.
    reg.observe('1.7.700', { slotId: 'slot-ev', phase: 'filling', evidence: 'local' });
    check('phase change adopts its own evidence', reg.view('1.7.700').evidence, 'local');
}

// ---------------------------------------------------------------------------
// 10e. Pending resolution keeps the index and the facade in step
// ---------------------------------------------------------------------------
async function testPendingIndexConsistency() {
    console.log('\n[10e] Resolving a pending CREATE clears its index');
    const { reg } = registry();
    reg.setPending('fp-c', { slotId: 'slot-p', order: { id: 'slot-p' }, fingerprint: 'fp-c' });
    check('pending visible through the facade', reg.pendingBroadcasts.size, 1);
    check('pending counted', reg.pendingSize(), 1);

    // An observation of the landed order resolves the pending entry.
    reg.markLanded('1.7.701', { slotId: 'slot-p', evidence: 'adoption' });
    check('resolved pending leaves the facade', reg.pendingBroadcasts.size, 0);
    check('resolved pending leaves the index', reg.pendingSize(), 0);
    check('resolved pending is null on the view', reg.view('slot-p').pending, null);
}

// ---------------------------------------------------------------------------
// 10f. Retention: expired unknowns become evictable, live ones never
// ---------------------------------------------------------------------------
async function testPruneEvictsOnlyExpiredUnresolved() {
    console.log('\n[10f] Prune evicts expired unresolved records only');
    const ttl = Number(TIMING.PENDING_BROADCAST_TTL_MS) || 30 * 60 * 1000;
    const now = { at: T0 };
    const reg = new LifecycleRegistry({ now: () => now.at, maxRecords: 2 });

    reg.markUnknown(null, { slotId: 'unknown-live' });
    now.at += ttl * 2 + 1;
    reg.markIntent({ slotId: 'settled-a' });
    reg.markIntent({ slotId: 'settled-b' });
    check('expired unknown does not pin the registry', reg.size() <= 2, true);

    const live = new LifecycleRegistry({ now: () => now.at, maxRecords: 1 });
    live.markUnknown(null, { slotId: 'unknown-fresh' });
    live.markIntent({ slotId: 'settled-c' });
    check('a fresh unknown is never evicted', live.view('unknown-fresh').isUnknown, true);
}

// ---------------------------------------------------------------------------
// 10g. A synthesized view has no clock, so its bound cannot be eternal
// ---------------------------------------------------------------------------
async function testSynthesizedViewHasNoClock() {
    console.log('\n[10g] An unrecorded unknown is not eternally "in flight"');
    const { reg } = registry();
    const view = reg.withPhase('slot-never-recorded', 'unknown', 'broadcast-receipt');
    check('phase still reads unknown', view.phase, 'unknown');
    check('it still may exist on chain', view.mayExistOnChain, true);
    check('but it has no clock, so it does not suppress forever', view.isInFlight(undefined, T0), false);
}

// ---------------------------------------------------------------------------
// 11. The COW whole-map commit goes through the same write funnel
// ---------------------------------------------------------------------------
async function testCowCommitProjectsThroughFunnel() {
    console.log('\n[11] COW commit projects placements through the funnel');
    const { WorkingGrid } = require('../modules/order/working_grid');
    const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
    manager.logger = createSilentLogger();
    manager.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    manager._genesis = makeLadderFromPrices([50]);
    manager.accountant = {
        updateOptimisticFreeBalance: async () => { },
        recalculateFunds: async () => { },
        tryDeductFromChainFree: async () => ({ ok: true }),
        addToChainFree: async () => true,
    };
    const master = new Map<string, any>([
        ['slot-0', {
            id: 'slot-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL,
            price: 50, size: 10, orderId: null, rawOnChain: null,
        }],
    ]);
    manager.orders = Object.freeze(master);
    manager._gridVersion = 1;
    manager.boundaryIdx = 0;

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    workingGrid.set('slot-0', {
        ...master.get('slot-0'),
        state: ORDER_STATES.ACTIVE,
        orderId: '1.7.900',
        rawOnChain: { id: '1.7.900' },
    });
    const pushed = manager._pushWorkingGridRef(workingGrid, {});
    check('working grid pushed', pushed !== undefined, true);

    const committed = await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0, { skipRecalc: true });
    check('commit accepted', committed, true);
    check('master carries the new chain id', manager.orders.get('slot-0')?.orderId, '1.7.900');

    // The whole-map swap is the PRIMARY placement path: before the funnel
    // projection it stamped nothing, so the fresh-placement grace was inert for
    // every COW-created order.
    const view = manager.getLifecycle('1.7.900');
    check('placement stamped by the commit', view.placedAt > 0, true);
    check('within the surplus-cancel grace', view.isFreshlyPlaced(), true);
    check('assignment stamped by the commit', view.assignedAt > 0, true);
    check('commit published for recovery protection', manager._committedOrderIds.has('1.7.900'), true);
    check('commit window active', view.isRecentlyCommitted(), true);
    check('one record for the slot', manager.getLifecycle('slot-0').orderId, '1.7.900');
}

// ---------------------------------------------------------------------------
// 12. Sync pass 1 asks the unified guard (not a subset of it)
// ---------------------------------------------------------------------------
async function testSyncPassOneHonoursUnresolvedEvidence() {
    console.log('\n[12] Sync pass 1 defers absence while the phase is unresolved');

    const build = async () => {
        const manager: any = new OrderManager({ market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS' });
        manager._readSingleOrderFn = async () => null;
        manager._batchReadOrdersFn = async () => new Map();
        manager.logger = createSilentLogger();
        manager.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        manager._genesis = makeLadderFromPrices([50]);
        await manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        manager._suspectEmptyReads = {
            count: Math.max(1, Number(TIMING.SYNC_SUSPECT_EMPTY_READ_LIMIT) || 3) - 1,
            firstAt: 1,
        };
        await manager._updateOrder({
            id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.950',
        });
        // Settle the assignment clock so ONLY the unresolved phase can defer.
        manager._orderIdAssignedAt.set('1.7.950', Date.now() - TIMING.SYNC_LOCK_TIMEOUT_MS * 3);
        return manager;
    };

    // (a) An abandoned pending CREATE (lost receipt) leaves the slot `unknown`.
    {
        const manager = await build();
        manager._lifecycle.markUnknown('1.7.950', { slotId: 'slot-1', evidence: 'broadcast-receipt' });
        const result = await manager.sync.syncFromOpenOrders([]);
        check('unknown phase keeps the order', manager.orders.get('slot-1').state, ORDER_STATES.ACTIVE);
        check('no fill is booked for an unknown phase', result.filledOrders.length, 0);
    }

    // (b) A persisted create-uncertain marker is visible through the SLOT read.
    {
        const manager = await build();
        await manager.applyGridUpdateBatch([
            { ...manager.orders.get('slot-1'), createUncertain: true },
        ], 'test-create-uncertain-active');
        const result = await manager.sync.syncFromOpenOrders([]);
        check('createUncertain marker keeps the order', manager.orders.get('slot-1').state, ORDER_STATES.ACTIVE);
        check('no fill is booked for createUncertain', result.filledOrders.length, 0);
    }

    // (c) A settled record with no unresolved evidence still cleans up.
    {
        const manager = await build();
        const settled = await manager.sync.syncFromOpenOrders([]);
        check('settled absent order is virtualized', manager.orders.get('slot-1').state, ORDER_STATES.VIRTUAL);
        check('settled absent order books a fill', settled.filledOrders.length, 1);
    }
}

async function run() {
    console.log('Order lifecycle registry tests');
    testSingleRecordPerSlot();
    testUnknownNeverGone();
    testPendingResolutionVsAbandon();
    testCommittedSnapshot();
    testFacadeIsNotACopy();
    testEvictionKeepsUnresolved();
    testPendingWithoutSlotId();
    testReadLifecycleFallback();
    await testManagerAgreement();
    await testReadPurityAndEvidenceRetention();
    await testRotationDoesNotLeak();
    await testUnresolvedBoundIsNotRefreshedByReAssertion();
    await testExpiredUnknownResolves();
    await testEvidenceMonotonicity();
    await testPendingIndexConsistency();
    await testPruneEvictsOnlyExpiredUnresolved();
    await testSynthesizedViewHasNoClock();
    await testCowCommitProjectsThroughFunnel();
    await testSyncPassOneHonoursUnresolvedEvidence();

    if (failures > 0) {
        console.error(`\n❌ ${failures} lifecycle assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All lifecycle assertions passed');
}

run().catch((err) => {
    console.error('Lifecycle test failed:', err);
    process.exit(1);
});

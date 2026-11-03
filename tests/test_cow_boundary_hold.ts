/**
 * Boundary-hold + refill-stamp contract tests (HOLD-001..HOLD-009).
 *
 * Joint wire: producers attach the slot ids of hole-CREATEs that justify a
 * planned boundary shift (refillSlotIds, reserve-ladder CREATEs excluded);
 * the executor holds the committed boundary when a listed refill is
 * guard-skipped instead of committing a shift whose rail holes were restored
 * empty (91->94 empty-strand class). UPDATE refills folded from CANCEL+CREATE
 * pairs stamp via the frozen geometry (fund-fold case); CREATE refills never
 * stamp.
 */

const assert = require('assert');
const {
    resolveRefillBoundaryHold,
    toRefillSlotIdSet,
    buildCowResultFromPlan,
} = require('../modules/dexbot_cow_runtime');
const { optimizeRebalanceActions } = require('../modules/order/utils/validate');
const { collectRefillSlotIds } = require('../modules/order/utils/order');
const { getSellStartIdx } = require('../modules/order/utils/math');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

// Synthetic geometry: boundary 141, gap 2 => sellStart 144, band {142, 143}.
const BOUNDARY = 141;
const GAP = 2;
const ASSETS = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };

function slot(id, type, state, price, size, orderId = null) {
    return { id, type, state, price, size, orderId, rawOnChain: orderId ? {} : null };
}

async function testHOLD001_RefillIntersectHolds() {
    console.log('\n[HOLD-001] Skipped refill holds the committed boundary...');
    const r = resolveRefillBoundaryHold(
        94, 91,
        new Set(['slot-92', 'slot-93']),
        new Set(),
        ['slot-92', 'slot-93', 'slot-94']
    );
    assert.strictEqual(r.effectiveBoundary, 91, 'planned 94 must not commit when refills skipped');
    assert.deepStrictEqual(r.heldRefillSlotIds, ['slot-92', 'slot-93']);
    console.log('✓ HOLD-001 passed');
}

async function testHOLD002_UnrelatedSkipAdvances() {
    console.log('\n[HOLD-002] Unrelated veto never pins geometry...');
    const r = resolveRefillBoundaryHold(
        94, 91,
        new Set(['slot-50']),
        new Set(),
        ['slot-92', 'slot-93', 'slot-94']
    );
    assert.strictEqual(r.effectiveBoundary, 94, 'non-refill skip must let the boundary advance');
    assert.deepStrictEqual(r.heldRefillSlotIds, []);
    console.log('✓ HOLD-002 passed');
}

async function testHOLD003_ClampedRefillHolds() {
    console.log('\n[HOLD-003] Post-fill-clamped refill holds (rolled-back-but-advanced shape)...');
    const r = resolveRefillBoundaryHold(94, 91, new Set(), new Set(['slot-94']), ['slot-94']);
    assert.strictEqual(r.effectiveBoundary, 91, 'clamped refill must hold the boundary');
    assert.deepStrictEqual(r.heldRefillSlotIds, ['slot-94']);
    console.log('✓ HOLD-003 passed');
}

async function testHOLD004_GuardedDefaults() {
    console.log('\n[HOLD-004] Absent/empty refill wire never fail-opens...');
    for (const wire of [undefined, null, [], 'slot-92', 42]) {
        const r = resolveRefillBoundaryHold(94, 91, new Set(['slot-92']), new Set(), wire);
        assert.strictEqual(r.effectiveBoundary, 94, `wire ${JSON.stringify(wire)} must advance`);
    }
    // No skips at all: intersect empty even with a populated refill set.
    const idle = resolveRefillBoundaryHold(94, 91, new Set(), new Set(), ['slot-92']);
    assert.strictEqual(idle.effectiveBoundary, 94, 'no skips must advance');
    // Non-iterable skip collections are ignored, not thrown.
    const odd = resolveRefillBoundaryHold(94, 91, null, undefined, ['slot-92']);
    assert.strictEqual(odd.effectiveBoundary, 94, 'null skip sets must advance');
    console.log('✓ HOLD-004 passed');
}

async function testHOLD005_WireNormalization() {
    console.log('\n[HOLD-005] Wire normalizes to string-id set...');
    const s = toRefillSlotIdSet(['slot-92', 'slot-92', null, 42, '', 'slot-93']);
    assert.deepStrictEqual([...s], ['slot-92', 'slot-93'], 'dupes/non-strings/empties collapse');
    assert.strictEqual(toRefillSlotIdSet(undefined).size, 0, 'absent wire is empty');
    console.log('✓ HOLD-005 passed');
}

async function testHOLD006_FundFoldStampsWithFrozenGeometry() {
    console.log('\n[HOLD-006] Fund-driven CANCEL+CREATE fold stamps the rotation...');
    assert.strictEqual(getSellStartIdx(BOUNDARY, GAP), 144);
    // Stuck in-band SELL (kept typed SELL by the spread guard) + rail hole.
    const master = new Map();
    master.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 943, 10, '1.7.9001'));
    master.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 947, 10));
    const actions = [
        { type: COW_ACTIONS.CANCEL, id: 'slot-143', orderId: '1.7.9001', reason: 'surplus-no-rotation-target' },
        { type: COW_ACTIONS.CREATE, id: 'slot-147', order: { id: 'slot-147', type: ORDER_TYPES.SELL, price: 947, size: 10 } },
    ];
    const folded = optimizeRebalanceActions(actions, master, {
        logger: () => {},
        boundaryIdx: BOUNDARY,
        gapSlots: GAP,
        assets: ASSETS,
    });
    assert.strictEqual(folded.length, 1, 'pair must fold into one rotation UPDATE');
    const rot = folded[0];
    assert.strictEqual(rot.type, COW_ACTIONS.UPDATE, 'folded action is an UPDATE');
    assert.strictEqual(rot.newGridId, 'slot-147', 'rotation targets the hole');
    assert.strictEqual(rot.origin, 'gap-evacuation', 'fund fold stamps with frozen geometry');
    assert.strictEqual(rot.evacBoundary, BOUNDARY, 'stamp freezes the plan-build boundary');
    assert.strictEqual(rot.evacGapSlots, GAP, 'stamp freezes the plan-build gap width');
    // Guarded default: no geometry => fold still happens, stamp does not.
    const unfolded = optimizeRebalanceActions(actions, master, { logger: () => {} });
    assert.strictEqual(unfolded.length, 1, 'fold is geometry-independent');
    assert.ok(!unfolded[0].origin, 'absent geometry must stay unstamped');
    assert.strictEqual(unfolded[0].evacBoundary, undefined, 'no B-stamp without geometry');
    console.log('✓ HOLD-006 passed');
}

async function testHOLD007_PlanCarrierPassthrough() {
    console.log('\n[HOLD-007] Plan carrier threads refillSlotIds to the cowResult...');
    const master = new Map();
    master.set('slot-92', slot('slot-92', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 900, 10));
    const bot = {
        manager: {
            orders: master,
            _gridVersion: 7,
            boundaryIdx: 91,
            _gapSlots: 2,
            assets: ASSETS,
            logger: { log: () => {} },
        },
    };
    const cow = buildCowResultFromPlan(bot, {
        ordersToPlace: [{ id: 'slot-92', type: ORDER_TYPES.SELL, price: 900, size: 10 }],
        boundaryIdx: 94,
        refillSlotIds: ['slot-92', 'slot-93', 42, null],
    });
    assert.deepStrictEqual(cow.refillSlotIds, ['slot-92', 'slot-93'], 'string ids thread through');
    const bare = buildCowResultFromPlan(bot, { ordersToPlace: [], boundaryIdx: 91 });
    assert.strictEqual(bare.refillSlotIds, undefined, 'absent wire stays absent (guarded default)');
    console.log('✓ HOLD-007 passed');
}
async function testHOLD008_SkippedCreateRefillHolds() {
    console.log('\n[HOLD-008] Guard-skipped CREATE refill holds (never-placed strand)...');
    // Primary incident shape: hole-CREATE refills blocked by LAST-FILL/CROSS
    // guard — UPDATE sets empty, CREATE skips carry the intersect.
    const r = resolveRefillBoundaryHold(
        94, 91,
        new Set(), new Set(),
        ['slot-92', 'slot-93', 'slot-94'],
        new Set(['slot-92', 'slot-93', 'slot-94'])
    );
    assert.strictEqual(r.effectiveBoundary, 91, 'skipped CREATE refills must hold 91');
    assert.deepStrictEqual(r.heldRefillSlotIds, ['slot-92', 'slot-93', 'slot-94']);
    // Unrelated CREATE skip still advances.
    const unrelated = resolveRefillBoundaryHold(
        94, 91,
        new Set(), new Set(),
        ['slot-92'],
        new Set(['slot-50'])
    );
    assert.strictEqual(unrelated.effectiveBoundary, 94, 'non-refill CREATE skip must advance');
    console.log('✓ HOLD-008 passed');
}

async function testHOLD009_ReserveSkipNeverPins() {
    console.log('\n[HOLD-009] Skipped RESERVE create never pins the boundary...');
    // Plan actions: floor reserve CREATEs (slot-0/slot-1), ceiling reserve
    // (slot-13) and a genuine hole refill (slot-8). The producer
    // (collectRefillSlotIds) must drop the reserve ids, so a guard-skipped
    // reserve CREATE — the shape a dump below the grid floor produces, when the
    // last-fill guard blocks the floor BUYs — leaves the boundary free to
    // advance, while a skipped hole refill still holds it.
    const slots = [];
    for (let i = 0; i < 14; i++) {
        slots.push({ id: `slot-${i}`, type: i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, price: 80 + i });
    }
    const actions = [
        { type: COW_ACTIONS.CREATE, id: 'slot-0' },
        { type: COW_ACTIONS.CREATE, id: 'slot-1' },
        { type: COW_ACTIONS.CREATE, id: 'slot-8' },
        { type: COW_ACTIONS.CREATE, id: 'slot-13' },
    ];
    const wire = collectRefillSlotIds(actions, {
        config: { edgeOrders: { buy: 2, sell: 1 } },
        slots,
        edgeAnchors: { buy: 80, sell: 93 },
    });
    assert.deepStrictEqual(wire, ['slot-8'], 'wire carries the hole refill only');

    const edgeSkip = resolveRefillBoundaryHold(
        94, 91, new Set(), new Set(), wire, new Set(['slot-0', 'slot-1'])
    );
    assert.strictEqual(edgeSkip.effectiveBoundary, 94, 'skipped reserve must not pin geometry');
    assert.deepStrictEqual(edgeSkip.heldRefillSlotIds, []);

    const refillSkip = resolveRefillBoundaryHold(
        94, 91, new Set(), new Set(), wire, new Set(['slot-8'])
    );
    assert.strictEqual(refillSkip.effectiveBoundary, 91, 'skipped hole refill still holds');
    assert.deepStrictEqual(refillSkip.heldRefillSlotIds, ['slot-8']);
    console.log('✓ HOLD-009 passed');
}

async function testHOLD010_HoldIsScopedToPromotionDirection() {
    console.log('\n[HOLD-010] A fill-driven retreat never pins the boundary...');
    const refills = ['slot-92', 'slot-93'];
    const skipped = new Set(['slot-92']);

    // BUY promotion (94 > 91): the move advances toward the band holes -> hold.
    const buyPromotion = resolveRefillBoundaryHold(94, 91, skipped, new Set(), refills, undefined, ORDER_TYPES.BUY);
    assert.strictEqual(buyPromotion.effectiveBoundary, 91, 'BUY promotion holds on a skipped refill');
    assert.deepStrictEqual(buyPromotion.heldRefillSlotIds, ['slot-92']);

    // BUY retreat (88 < 91): a fill moved the boundary AWAY from the holes -> no hold.
    const buyRetreat = resolveRefillBoundaryHold(88, 91, skipped, new Set(), refills, undefined, ORDER_TYPES.BUY);
    assert.strictEqual(buyRetreat.effectiveBoundary, 88, 'BUY retreat must not be pinned by the hold');
    assert.deepStrictEqual(buyRetreat.heldRefillSlotIds, []);

    // SELL promotion (91 < 94): the mirror of the BUY promotion -> hold.
    const sellPromotion = resolveRefillBoundaryHold(91, 94, skipped, new Set(), refills, undefined, ORDER_TYPES.SELL);
    assert.strictEqual(sellPromotion.effectiveBoundary, 94, 'SELL promotion holds on a skipped refill');

    // SELL retreat (94 > 91): fill-driven up-move -> no hold.
    const sellRetreat = resolveRefillBoundaryHold(94, 91, skipped, new Set(), refills, undefined, ORDER_TYPES.SELL);
    assert.strictEqual(sellRetreat.effectiveBoundary, 94, 'SELL retreat must not be pinned by the hold');

    // No side evidence keeps the legacy hold (guarded default, never fail-open).
    const unknown = resolveRefillBoundaryHold(88, 91, skipped, new Set(), refills);
    assert.strictEqual(unknown.effectiveBoundary, 91, 'unknown side keeps the legacy hold');

    // Unchanged boundary: hold or not, the effective value is the same.
    const steady = resolveRefillBoundaryHold(91, 91, skipped, new Set(), refills, undefined, ORDER_TYPES.BUY);
    assert.strictEqual(steady.effectiveBoundary, 91, 'steady boundary is a no-op either way');
    console.log('✓ HOLD-010 passed');
}

async function runAllTests() {
    console.log('=== Boundary-Hold Test Suite ===\n');
    await testHOLD001_RefillIntersectHolds();
    await testHOLD002_UnrelatedSkipAdvances();
    await testHOLD003_ClampedRefillHolds();
    await testHOLD004_GuardedDefaults();
    await testHOLD005_WireNormalization();
    await testHOLD006_FundFoldStampsWithFrozenGeometry();
    await testHOLD007_PlanCarrierPassthrough();
    await testHOLD008_SkippedCreateRefillHolds();
    await testHOLD009_ReserveSkipNeverPins();
    await testHOLD010_HoldIsScopedToPromotionDirection();
    console.log('\n=== All boundary-hold tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });

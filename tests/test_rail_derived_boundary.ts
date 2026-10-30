/**
 * RAIL-BOUNDARY: the committed boundary is derived from the rails, not held
 * away from them.
 *
 * Regression: a sell sweep's counter orders were placed on the promoted rail
 * (SELL fill at s => counter BUY at s - gap) while `resolveRefillBoundaryHold`
 * kept the old committed boundary because the sell refills were guard-skipped.
 * The next plan saw the old geometry, classified the counters as in-band, and
 * rotated sells onto their price (spread 1.5% -> 0.3%). The rail clamp makes
 * that state unrepresentable:
 *
 *     maxBuyIdx <= boundary <= minSellIdx - gapSlots - 1
 */

const assert = require('assert');
const { deriveRailBoundary } = require('../modules/dexbot_cow_runtime');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    ${msg}`);
    }
}

const BUY = ORDER_TYPES.BUY;
const SELL = ORDER_TYPES.SELL;

function live(idx: number, type: string) {
    return {
        id: `slot-${idx}`,
        type,
        state: ORDER_STATES.ACTIVE,
        orderId: `1.7.${idx}`,
        price: 100 + idx,
        size: 10
    };
}

function makeManager(liveSlots: Array<{ idx: number; type: string }>, boundaryIdx: number, gapSlots: number | null = 4) {
    const orders = new Map();
    for (const { idx, type } of liveSlots) orders.set(`slot-${idx}`, live(idx, type));
    // Full ladder length (grid slots are 0..292 in production).
    orders.set('slot-292', { id: 'slot-292', type: SELL, state: ORDER_STATES.VIRTUAL, orderId: null, price: 392, size: 0 });
    return { orders, boundaryIdx, _gapSlots: gapSlots };
}

function buyRotation(from: number, to: number) {
    return {
        kind: 'rotation',
        rotation: { oldOrder: { id: `slot-${from}` }, newGridId: `slot-${to}`, type: BUY, newPrice: 100 + to }
    };
}

function sellRotation(from: number, to: number) {
    return {
        kind: 'rotation',
        rotation: { oldOrder: { id: `slot-${from}` }, newGridId: `slot-${to}`, type: SELL, newPrice: 100 + to }
    };
}

console.log('=== RAIL-BOUNDARY: boundary follows the placed rails ===');

run('RAIL-1 incident replay: held 133 + counter buys 134-138 => boundary advances to 138', () => {
    const mgr = makeManager([{ idx: 131, type: BUY }, { idx: 132, type: BUY }, { idx: 133, type: BUY },
        { idx: 153, type: SELL }, { idx: 154, type: SELL }, { idx: 155, type: SELL }], 133);
    const ops = [buyRotation(114, 134), buyRotation(115, 135), buyRotation(116, 136),
        buyRotation(117, 137), buyRotation(118, 138)];
    const r = deriveRailBoundary(mgr, ops, 133, 4);
    assert.strictEqual(r.boundary, 138, `counter buys must carry the boundary: ${JSON.stringify(r)}`);
    assert.strictEqual(r.maxBuyIdx, 138);
    assert.strictEqual(r.minSellIdx, 153);
    assert.strictEqual(r.clamped, true);
});

run('RAIL-2 mirror (buy fill): counter sell at 138 must pull a held 138 down to 133', () => {
    const mgr = makeManager([{ idx: 131, type: BUY }, { idx: 132, type: BUY }, { idx: 133, type: BUY },
        { idx: 143, type: SELL }], 138);
    const ops = [sellRotation(158, 138), buyRotation(114, 133)];
    const r = deriveRailBoundary(mgr, ops, 138, 4);
    assert.strictEqual(r.boundary, 133, `counter sell pins boundary <= 138-4-1: ${JSON.stringify(r)}`);
    assert.strictEqual(r.maxBuyIdx, 133);
    assert.strictEqual(r.minSellIdx, 138);
});

run('RAIL-3 pure refill hold is preserved: no order above the committed boundary', () => {
    // Plan wanted 138 but the refill at 143 was skipped (not in opContexts).
    // The executor passes the HELD value (133) as the desired boundary.
    const mgr = makeManager([{ idx: 133, type: BUY }, { idx: 153, type: SELL }], 133);
    const r = deriveRailBoundary(mgr, [], 133, 4);
    assert.strictEqual(r.boundary, 133, `hold must survive when nothing was placed above it: ${JSON.stringify(r)}`);
    assert.strictEqual(r.clamped, false);
});

run('RAIL-4 already-crossed rails fail closed (no self-legalizing)', () => {
    const mgr = makeManager([{ idx: 138, type: BUY }, { idx: 140, type: SELL }], 133);
    const r = deriveRailBoundary(mgr, [], 138, 4);
    assert.strictEqual(r.boundary, null, 'a crossed book must not be legalized');
    assert.ok(/rail-crossed/.test(String(r.reason)), `reason must name the cross: ${JSON.stringify(r)}`);
});

run('RAIL-5 cancels remove a rail order before the clamp', () => {
    const mgr = makeManager([{ idx: 133, type: BUY }, { idx: 138, type: BUY }], 133);
    const ops = [{ kind: 'cancel', order: { id: 'slot-138', type: BUY } }];
    // Desired 135 would be raised to 138 by the cancelled buy if it were kept.
    const r = deriveRailBoundary(mgr, ops, 135, 4);
    assert.strictEqual(r.boundary, 135, `cancelled buy must not pin the boundary: ${JSON.stringify(r)}`);
    assert.strictEqual(r.maxBuyIdx, 133);
});

run('RAIL-6 rotation source is removed, destination is added', () => {
    const mgr = makeManager([{ idx: 133, type: BUY }, { idx: 137, type: BUY }], 133);
    const ops = [buyRotation(137, 132)];
    // Desired 135 would be raised to 137 by the source if it were kept.
    const r = deriveRailBoundary(mgr, ops, 135, 4);
    assert.strictEqual(r.boundary, 135, `moved order must not stay at its old rail slot: ${JSON.stringify(r)}`);
    assert.strictEqual(r.maxBuyIdx, 133);
});

run('RAIL-7 unknown gap fails closed (never boundary 0)', () => {
    const mgr = makeManager([{ idx: 133, type: BUY }], 133);
    for (const gap of [null, undefined, '', -1, NaN]) {
        const r = deriveRailBoundary(mgr, [], 138, gap);
        assert.strictEqual(r.boundary, null, `gap ${JSON.stringify(gap)} must not derive a boundary`);
    }
});

run('RAIL-8 a rail that cannot fit the gap band fails closed (rail-exceeds-grid)', () => {
    // Truncated grid: max slot 10, gap 4 => ceiling 5, but a live buy at 10.
    const orders = new Map([['slot-10', live(10, BUY)]]);
    const mgr = { orders, boundaryIdx: 10, _gapSlots: 4 };
    const r = deriveRailBoundary(mgr, [], 10, 4);
    assert.strictEqual(r.boundary, null, 'an unfittable rail must not derive a boundary');
    assert.ok(/rail-exceeds-grid/.test(String(r.reason)), `reason must name the ceiling: ${JSON.stringify(r)}`);
});

run('RAIL-9 genesis gap is used when _gapSlots is temporarily null', () => {
    const mgr = makeManager([{ idx: 133, type: BUY }, { idx: 153, type: SELL }], 133, null);
    (mgr as { _genesis?: { gapSlots: number } })._genesis = { gapSlots: 4 };
    const r = deriveRailBoundary(mgr, [], 133, null);
    assert.strictEqual(r.boundary, 133, `genesis gap must keep the hold: ${JSON.stringify(r)}`);
});

console.log(`\nRAIL-BOUNDARY summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

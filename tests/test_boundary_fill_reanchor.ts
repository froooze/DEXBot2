/**
 * REANCHOR: the boundary re-anchors from the newest real fill.
 *
 * A crawl is ±1 slot per committed fill, so a window that ended up BEHIND the
 * fill cannot catch up by crawling: every tightening slot on that side is then
 * at/through the fill, the last-fill guard refuses all of them, and the funds
 * sit in the resting (stranded) inventory. Live incident (2026-10-25 19:22):
 * seven sells swept slots 147-153, two commits dropped the owed crawls, the
 * boundary ended at 146 and stayed there (`last-fill-blocked` every cycle).
 *
 * The fill is the anchor: SELL fill at slot f => boundary >= f - gapSlots
 * (sellStart = f + 1), BUY fill at slot f => boundary <= f - 1. Only an
 * on-ladder fill price qualifies, and the candidate must pass the same
 * placed-order-aware validation a boundary commit uses.
 */

const assert = require('assert');
const { reanchorBoundaryFromLastFill } = require('../modules/order/utils/system');
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

const LEVELS = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];

function makeSlots(placedIdxs: number[] = [], partialIdxs: number[] = []) {
    const placed = new Set(placedIdxs);
    const partial = new Set(partialIdxs);
    return LEVELS.map((price, idx) => ({
        id: `slot-${idx}`,
        type: idx < 6 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
        price,
        orderId: placed.has(idx) || partial.has(idx) ? `1.7.${idx}` : null,
        state: partial.has(idx) ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE,
        size: 10,
    }));
}

function makeManager(fillPrice: number | null, fillType: string | null, over: Record<string, any> = {}) {
    return {
        _genesis: { priceLevels: LEVELS },
        config: { incrementPercent: 1 },
        _lastFilledPrice: fillPrice,
        _lastFilledType: fillType,
        lastFillPivotSource: fillPrice != null && fillType != null ? 'fill' : null,
        _lastMarketFillPrice: null,
        _lastMarketFillType: null,
        logger: { log: () => {} },
        ...over,
    };
}

console.log('=== REANCHOR: boundary re-anchor from the last fill ===');

run('REANCHOR-1 a SELL fill behind the window raises the boundary so the fill sits outside it', () => {
    // Fill at idx 5 (price 105), gap 1 => boundary must be >= 4 (sellStart 6).
    const mgr = makeManager(105, ORDER_TYPES.SELL);
    const r = reanchorBoundaryFromLastFill(mgr, 2, makeSlots(), 1);
    assert.strictEqual(r.reanchored, true, `expected a re-anchor, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundaryIdx, 4, 'sellStart must land one level above the filled slot');
    assert.strictEqual(r.fillSlot, 5);
    assert.strictEqual(r.from, 2);
});

run('REANCHOR-2 an idempotent call is a no-op (already outside)', () => {
    const mgr = makeManager(105, ORDER_TYPES.SELL);
    const r = reanchorBoundaryFromLastFill(mgr, 4, makeSlots(), 1);
    assert.strictEqual(r.reanchored, false);
    assert.strictEqual(r.reason, 'already-outside');
    assert.strictEqual(r.boundaryIdx, 4);
});

run('REANCHOR-3 a BUY fill above the window lowers the boundary below the fill', () => {
    // Fill at idx 8 (price 108) => buy window must end at 7 or lower.
    const mgr = makeManager(108, ORDER_TYPES.BUY);
    const r = reanchorBoundaryFromLastFill(mgr, 10, makeSlots(), 1);
    assert.strictEqual(r.reanchored, true, `expected a re-anchor, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundaryIdx, 7, 'the buy window must end below the filled slot');
});

run('REANCHOR-4 a cold pivot never re-anchors', () => {
    const cold = reanchorBoundaryFromLastFill(makeManager(null, null), 2, makeSlots(), 1);
    assert.strictEqual(cold.reanchored, false);
    assert.strictEqual(cold.reason, 'cold-pivot');

    // A price without a recorded fill side (book-seeded pivot) is not a fill
    // fact: the guard reference resolves to cold, so there is nothing to anchor
    // to and the derivation boundary is kept.
    const bookSeed = reanchorBoundaryFromLastFill(makeManager(105, null), 2, makeSlots(), 1);
    assert.strictEqual(bookSeed.reanchored, false);
    assert.strictEqual(bookSeed.reason, 'cold-pivot');
});

run('REANCHOR-5 an off-ladder fill price is never snapped into geometry', () => {
    const mgr = makeManager(95, ORDER_TYPES.SELL); // clamped to slot 0 but 5.3% off its level
    const r = reanchorBoundaryFromLastFill(mgr, 2, makeSlots(), 1);
    assert.strictEqual(r.reanchored, false);
    assert.strictEqual(r.reason, 'off-ladder-fill');
    assert.strictEqual(r.boundaryIdx, 2);
});

run('REANCHOR-6 a target that would strand a live order in the band is refused', () => {
    // Fill at idx 7 (107), boundary 3 => target 6, band (6, 8) => idx 7 in band.
    const mgr = makeManager(107, ORDER_TYPES.SELL);
    const r = reanchorBoundaryFromLastFill(mgr, 3, makeSlots([7]), 1);
    assert.strictEqual(r.reanchored, false, 'a strand must never be accepted');
    assert.ok(String(r.reason).startsWith('unsafe:'), `expected an unsafe reason, got ${r.reason}`);
    assert.strictEqual(r.boundaryIdx, 3, 'the derivation boundary is kept');
});

run('REANCHOR-7 the sell-rail ceiling still bounds the re-anchor', () => {
    // Fill at the last level: required = 10, ceiling = 12 - 1 - 1 = 10.
    const mgr = makeManager(111, ORDER_TYPES.SELL);
    const r = reanchorBoundaryFromLastFill(mgr, 4, makeSlots(), 1);
    assert.strictEqual(r.reanchored, true, `expected a re-anchor, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundaryIdx, 10);
});

run('REANCHOR-8 a missing boundary is left to the derivation', () => {
    const mgr = makeManager(105, ORDER_TYPES.SELL);
    assert.strictEqual(reanchorBoundaryFromLastFill(mgr, null, makeSlots(), 1).reason, 'no-boundary');
    assert.strictEqual(reanchorBoundaryFromLastFill(mgr, undefined, makeSlots(), 1).reason, 'no-boundary');
});

run('REANCHOR-9 the fill\'s own PARTIAL residual does not block the re-anchor', () => {
    // Fill at idx 7 (107), gap 1 => boundary target 6, band (6, 8): the
    // partial remainder at idx 7 is inside the new band but it IS the fill
    // anchor, not a stranded foreign order.
    const mgr = makeManager(107, ORDER_TYPES.SELL);
    const r = reanchorBoundaryFromLastFill(mgr, 3, makeSlots([], [7]), 1);
    assert.strictEqual(r.reanchored, true, `expected a re-anchor, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundaryIdx, 6);
    assert.strictEqual(r.fillSlot, 7);
});

run('REANCHOR-10 an ACTIVE in-band order at the fill slot is still refused (not the residual)', () => {
    // Same geometry as REANCHOR-9 but the slot is ACTIVE, not PARTIAL: that
    // is a genuinely stranded placement and must keep blocking the re-anchor.
    const mgr = makeManager(107, ORDER_TYPES.SELL);
    const r = reanchorBoundaryFromLastFill(mgr, 3, makeSlots([7]), 1);
    assert.strictEqual(r.reanchored, false, 'an ACTIVE in-band order must never be allowed');
    assert.ok(String(r.reason).startsWith('unsafe:'), `expected unsafe, got ${r.reason}`);
});

run('REANCHOR-12 a book-seeded pivot never supplies the absolute anchor', () => {
    // One-sided book seed: price/type are set, but provenance is 'book'.
    // Without a real market-fill row there is nothing to anchor to.
    const mgr = makeManager(105, ORDER_TYPES.SELL, { lastFillPivotSource: 'book' });
    const r = reanchorBoundaryFromLastFill(mgr, 2, makeSlots(), 1);
    assert.strictEqual(r.reanchored, false, 'a book seed must not move the boundary');
    assert.strictEqual(r.reason, 'cold-pivot');
});

run('REANCHOR-13 a real market fill rescues a book-seeded live pivot', () => {
    const mgr = makeManager(105, ORDER_TYPES.SELL, {
        lastFillPivotSource: 'book',
        _lastMarketFillPrice: 108,
        _lastMarketFillType: ORDER_TYPES.SELL,
    });
    const r = reanchorBoundaryFromLastFill(mgr, 2, makeSlots(), 1);
    assert.strictEqual(r.reanchored, true, `expected the market-fill fallback to anchor, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundaryIdx, 7, 'fill at idx 8 with gap 1 => boundary 7');
    assert.strictEqual(r.fillSlot, 8);
});

run('REANCHOR-11 a ceiling-clamped target fails closed', () => {
    // Genesis has 12 levels but the live slot list is shorter (legacy grid).
    // Fill at idx 11 needs boundary 10, ceiling is 10-1-1=8 => the clamp can
    // no longer put the fill outside its window; the re-anchor must refuse.
    const mgr = makeManager(111, ORDER_TYPES.SELL);
    const r = reanchorBoundaryFromLastFill(mgr, 4, makeSlots().slice(0, 10), 1);
    assert.strictEqual(r.reanchored, false, `expected refusal, got ${JSON.stringify(r)}`);
    assert.strictEqual(r.reason, 'ceiling-clamped');
});

console.log(`\nREANCHOR summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

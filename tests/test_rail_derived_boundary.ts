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

const ASSETS = {
    assetA: { id: '1.3.0', precision: 5, symbol: 'BASE' },
    assetB: { id: '1.3.1', precision: 5, symbol: 'QUOTE' }
};
// Genesis ladder: slot idx === price - 100 (long enough for slot-292).
const LEVELS = Array.from({ length: 400 }, (_, i) => 100 + i);

/** Raw chain order shape parseChainOrder understands (price = level). */
function rawChainOrder(id: string, type: string, price: number) {
    const baseAmount = 100000;
    const quoteAmount = Math.round(price * baseAmount);
    const base = type === SELL
        ? { asset_id: ASSETS.assetA.id, amount: baseAmount }
        : { asset_id: ASSETS.assetB.id, amount: quoteAmount };
    const quote = type === SELL
        ? { asset_id: ASSETS.assetB.id, amount: quoteAmount }
        : { asset_id: ASSETS.assetA.id, amount: baseAmount };
    return {
        id,
        sell_price: { base, quote },
        for_sale: 1000000,
        expiration: '2099-01-01T00:00:00'
    };
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

run('RAIL-4 a batch that places across its own rails fails closed (no self-legalizing)', () => {
    const mgr = makeManager([{ idx: 138, type: BUY }, { idx: 140, type: SELL }], 133);
    // The batch's OWN op destination is always counted, so a sell rotated into
    // 140 with a live buy at 138 is a genuine cross this batch created.
    const ops = [sellRotation(160, 140)];
    const r = deriveRailBoundary(mgr, ops, 138, 4);
    assert.strictEqual(r.boundary, null, 'a crossed book must not be legalized');
    assert.ok(/rail-crossed/.test(String(r.reason)), `reason must name the cross: ${JSON.stringify(r)}`);
});

run('RAIL-4b a MASTER order parked in the band is a stray, not a cross', () => {
    // The same layout without the batch placing anything: the in-band sell is a
    // stray (GAP-EVAC / reconcile owns it), so the boundary simply stays put
    // instead of being clamped onto it OR declaring a cross the batch created.
    const mgr = makeManager([{ idx: 138, type: BUY }, { idx: 140, type: SELL }], 138);
    const r = deriveRailBoundary(mgr, [], 138, 4);
    assert.strictEqual(r.boundary, 138, `the boundary must not move onto a stray: ${JSON.stringify(r)}`);
    assert.strictEqual(r.minSellIdx, null, 'the in-band master sell must be classified as a stray');
    assert.ok(/stray/.test(String(r.reason)), `the reason must name the stray: ${JSON.stringify(r)}`);
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

run('RAIL-10 a STRAY live order on the wrong side cannot move the boundary', () => {
    // One live SELL resting 18 slots below the committed boundary (a stranded
    // hold / refused-commit adoption). Deriving minSell from it would clamp the
    // committed boundary down to 115 and instantly re-type the whole window —
    // the clamp would self-legalize the corrupt state instead of leaving it to
    // GAP-EVAC / reconcile.
    const mgr = makeManager([
        { idx: 133, type: BUY }, { idx: 135, type: BUY }, { idx: 137, type: BUY },
        { idx: 120, type: SELL }
    ], 138);
    const r = deriveRailBoundary(mgr, [], 138, 4);
    assert.strictEqual(r.boundary, 138, `a stray rail order must be ignored: ${JSON.stringify(r)}`);
    assert.strictEqual(r.clamped, false);
    assert.ok(/stray/.test(String(r.reason)), `the reason must name the ignored strays: ${JSON.stringify(r)}`);
});

run('RAIL-11 the rail index comes from the LIVE chain price, not a stale slot id', () => {
    // slot-100 is typed BUY but its chain order actually rests at level 145 (the
    // refused-commit adoption shape). The rail index must follow the live price.
    const mgr = makeManager([{ idx: 140, type: BUY }], 150);
    (mgr.orders as Map<string, unknown>).set('slot-100', {
        ...live(100, BUY),
        rawOnChain: rawChainOrder('1.7.100', BUY, 100 + 145)
    });
    (mgr as any).assets = ASSETS;
    (mgr as any)._genesis = { priceLevels: LEVELS };
    const r = deriveRailBoundary(mgr, [], 150, 4);
    assert.strictEqual(r.maxBuyIdx, 145, `maxBuy must come from the live price: ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundary, 150, 'a legit live buy below the boundary does not move it');
});

run('RAIL-11b a live price on the WRONG side makes the order a stray (not an anchor)', () => {
    // Same shape, but the chain order really rests above the planned boundary.
    // Judged by its (stale) slot id it would look like a legit in-rail buy; the
    // live price proves it is parked in the sell zone, so it must not clamp.
    const mgr = makeManager([], 150);
    (mgr.orders as Map<string, unknown>).set('slot-100', {
        ...live(100, BUY),
        rawOnChain: rawChainOrder('1.7.100', BUY, 100 + 165)
    });
    (mgr as any).assets = ASSETS;
    (mgr as any)._genesis = { priceLevels: LEVELS };
    const r = deriveRailBoundary(mgr, [], 150, 4);
    assert.strictEqual(r.maxBuyIdx, null, `a live in-band buy must not anchor: ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundary, null, 'no usable rails => keep the committed boundary');
    assert.strictEqual(r.reason, 'no-rails');
});

run('RAIL-12 the proximity window follows the DESIRED boundary (counter orders always count)', () => {
    // Master rails sit around the desired value; a batch op destination further
    // away is still counted because an op is the batch's own placement.
    const mgr = makeManager([{ idx: 133, type: BUY }], 133);
    const ops = [buyRotation(114, 133), sellRotation(158, 140)];
    const r = deriveRailBoundary(mgr, ops, 134, 4);
    assert.strictEqual(r.maxBuyIdx, 133, 'master buy inside the window counts');
    assert.strictEqual(r.minSellIdx, 140, 'an op destination always counts');
    assert.strictEqual(r.boundary, 134, `sell at 140 => upper 135, desired 134 holds: ${JSON.stringify(r)}`);
});

run('RAIL-13 the shared commit gate refuses a clamp that strands a placed order', () => {
    // Dense ladder 0..11 (production shape: every slot present). A live
    // SPREAD-typed order is not a rail participant, so the clamp inequalities
    // cannot see it — the shared validatePersistedBoundary gate does: under
    // boundary 8 / gap 1 the band is slot 9, and a placed order there would be
    // stranded by the commit.
    const makeDense = (withSpread: boolean) => {
        const orders = new Map<string, unknown>();
        for (let i = 0; i < 12; i++) {
            orders.set(`slot-${i}`, {
                id: `slot-${i}`,
                type: i <= 5 ? BUY : SELL,
                state: ORDER_STATES.ACTIVE,
                orderId: `1.7.${i}`,
                price: 100 + i,
                size: 10
            });
        }
        // Only the rail participants stay placed; everything else is virtual.
        for (const [id, o] of orders) {
            const idx = Number(String(id).slice(5));
            if (idx !== 6 && idx !== 10 && !(withSpread && idx === 9)) {
                (o as any).orderId = null;
                (o as any).state = ORDER_STATES.VIRTUAL;
                (o as any).size = 0;
            }
        }
        if (withSpread) {
            // The transient SPREAD+ACTIVE state the SPREAD guard normally heals.
            (orders.get('slot-9') as any).type = 'SPREAD';
        }
        // Rail participants: a BUY at 6 and a SELL at 10.
        (orders.get('slot-6') as any).type = BUY;
        (orders.get('slot-10') as any).type = SELL;
        return { orders, boundaryIdx: 8, _gapSlots: 1 };
    };
    const control = deriveRailBoundary(makeDense(false), [], 8, 1);
    assert.strictEqual(control.boundary, 8, `clean dense rails clamp normally: ${JSON.stringify(control)}`);
    const refused = deriveRailBoundary(makeDense(true), [], 8, 1);
    assert.strictEqual(refused.boundary, null, `a stranded placed order must fail closed: ${JSON.stringify(refused)}`);
    assert.ok(/^unsafe: /.test(String(refused.reason)), `reason must come from the shared gate: ${JSON.stringify(refused)}`);
});

run('RAIL-14 the gate is skipped on a sparse ladder (array-length ceiling does not apply)', () => {
    // A partial/sparse master map (tests, or a slot-list that lost entries)
    // makes validateBoundaryCommit's length-derived ceiling meaningless; the
    // clamp inequalities stay the authority instead of refusing everything.
    const mgr = makeManager([{ idx: 133, type: BUY }], 133);
    const r = deriveRailBoundary(mgr, [], 133, 4);
    assert.strictEqual(r.boundary, 133, `a sparse ladder must not be refused by the gate: ${JSON.stringify(r)}`);
});

console.log(`\nRAIL-BOUNDARY summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

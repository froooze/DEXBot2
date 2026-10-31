/**
 * Incident-replay integration test (Phase 1 acceptance) — REP-001..004.
 *
 * Replays the spread-gap corruption incident with synthetic geometry only
 * (no real pair/account names): boundary 141, gap 4 -> sellStart 146;
 * three sell actives stranded inside the band (143/144/145), three rail
 * holes (147/149/151), pivot = latest fill at the highest hole price.
 *
 * Pipeline under test (all real exported code):
 *   reconcileGrid (stamping) -> guard contract (isLastFillGuardBlocked +
 *   isEvacuationRotationAllowed + B-stamp fields) -> buildActionsFromPlan
 *   (plan-build stamping) -> buildCowResultFromPlan (pre-apply) ->
 *   simulated broadcast commit -> post-commit invariants.
 *
 * Acceptance: all 3 evacuations pass the guard, the plan commits, the band
 * ends empty, active sells reach 20/20, and the visible spread is ~1.5%.
 */

const assert = require('assert');
const { reconcileGrid } = require('../modules/order/utils/validate');
const {
    buildActionsFromPlan,
    buildCowResultFromPlan,
    applyRotationTransitionsToWorkingGrid,
    isLastFillGuardBlocked,
} = require('../modules/dexbot_cow_runtime');
const { isEvacuationRotationAllowed, getSellStartIdx } = require('../modules/order/utils/math');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

const BOUNDARY = 141;
const GAP = 4;
const INC = 0.3;
const GRID_SIZE = 291;
const BASE_PRICE = 962.07; // top-of-book buy at the boundary

function priceFor(idx: number): number {
    return BASE_PRICE * Math.pow(1 + INC / 100, idx - BOUNDARY);
}

function slot(id: string, type: string, state: string, price: number, size: number, orderId: string | null = null) {
    return { id, type, state, price, size, orderId, rawOnChain: orderId ? {} : null };
}

function buildGrid(): Map<string, any> {
    const grid = new Map<string, any>();
    for (let i = 0; i < GRID_SIZE; i++) {
        const id = `slot-${i}`;
        const type = i <= BOUNDARY ? ORDER_TYPES.BUY : (i >= getSellStartIdx(BOUNDARY, GAP) ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        grid.set(id, slot(id, type, ORDER_STATES.VIRTUAL, priceFor(i), 0));
    }
    // 20 active buys: slots 122..141.
    for (let i = 122; i <= 141; i++) {
        grid.set(`slot-${i}`, slot(`slot-${i}`, ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, priceFor(i), 10, `1.7.${1000 + i}`));
    }
    // 3 stranded in-band sell actives (the violation).
    for (const i of [143, 144, 145]) {
        grid.set(`slot-${i}`, slot(`slot-${i}`, ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, priceFor(i), 10, `1.7.${2000 + i}`));
    }
    // 3 rail holes with Phase 2 booked size.
    for (const i of [147, 149, 151]) {
        grid.set(`slot-${i}`, slot(`slot-${i}`, ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, priceFor(i), 10));
    }
    // 17 active rail sells: 146, 148, 150, 152..165.
    for (const i of [146, 148, 150, ...Array.from({ length: 14 }, (_, k) => 152 + k)]) {
        grid.set(`slot-${i}`, slot(`slot-${i}`, ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, priceFor(i), 10, `1.7.${3000 + i}`));
    }
    return grid;
}

function buildTarget(master: Map<string, any>): Map<string, any> {
    const target = new Map();
    for (const [id, order] of master) target.set(id, { ...order });
    // Band clears to empty; holes fill active.
    for (const i of [143, 144, 145]) {
        target.set(`slot-${i}`, slot(`slot-${i}`, ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, priceFor(i), 0));
    }
    for (const i of [147, 149, 151]) {
        target.set(`slot-${i}`, slot(`slot-${i}`, ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, priceFor(i), 10));
    }
    return target;
}

const botLite = (master: Map<string, any>) => ({
    manager: {
        orders: master,
        _gridVersion: 7,
        boundaryIdx: BOUNDARY,
        _gapSlots: GAP,
        logger: { log: () => {} },
    },
});

function activeSellIds(grid: Map<string, any>): string[] {
    return [...grid.values()].filter((o: any) => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.ACTIVE).map((o: any) => o.id);
}

async function testREP001_GeometrySanity() {
    console.log('\n[REP-001] Incident geometry: band, rails, ~1.5% visible spread...');
    assert.strictEqual(getSellStartIdx(BOUNDARY, GAP), 146);
    const master = buildGrid();
    assert.strictEqual(activeSellIds(master).length, 20, '20 sells on the book: 17 rail + 3 stranded in band');
    const buys = [...master.values()].filter((o: any) => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE);
    assert.strictEqual(buys.length, 20);
    const spread = priceFor(146) / priceFor(BOUNDARY) - 1;
    assert.ok(spread > 0.014 && spread < 0.016, `visible spread should be ~1.5%, got ${(spread * 100).toFixed(3)}%`);
    console.log(`✓ REP-001 passed (spread ${(spread * 100).toFixed(3)}%)`);
}

async function testREP002_ReconcileStampsThreeEvacuations() {
    console.log('\n[REP-002] reconcileGrid plans exactly 3 stamped evacuation rotations...');
    const master = buildGrid();
    const streaks = new Map();
    const res = reconcileGrid(master, buildTarget(master), BOUNDARY, {
        logger: () => {},
        gapSlots: GAP,
        evacStreaks: streaks,
    });
    const rotations = res.actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId && a.newGridId !== a.id);
    assert.strictEqual(rotations.length, 3, `expected 3 rotations, got ${JSON.stringify(res.actions)}`);
    const sources = rotations.map((r: any) => r.id).sort();
    const dests = rotations.map((r: any) => r.newGridId).sort();
    assert.deepStrictEqual(sources, ['slot-143', 'slot-144', 'slot-145'], 'all three band actives evacuate');
    assert.deepStrictEqual(dests, ['slot-147', 'slot-149', 'slot-151'], 'onto the three rail holes');
    for (const r of rotations) {
        assert.strictEqual(r.origin, 'gap-evacuation', 'rotation carries the B-stamp origin');
        assert.strictEqual(r.evacBoundary, BOUNDARY);
        assert.strictEqual(r.evacGapSlots, GAP);
        const oldPrice = master.get(r.id).price;
        assert.ok(r.newPrice > oldPrice, `SELL evacuation must move outward: ${oldPrice} -> ${r.newPrice}`);
        // Deterministic pairing: surpluses and holes both sort by slot index
        // ascending (143->147, 144->149, 145->151).
        if (r.id === 'slot-143') assert.strictEqual(r.newGridId, 'slot-147');
        if (r.id === 'slot-144') assert.strictEqual(r.newGridId, 'slot-149');
        if (r.id === 'slot-145') assert.strictEqual(r.newGridId, 'slot-151');
    }
    console.log('✓ REP-002 passed');
}

async function testREP003_GuardWouldVetoButBypassAllows() {
    console.log('\n[REP-003] Guard contract: pivot would veto all 3; stamp + live probe allow...');
    const master = buildGrid();
    const streaks = new Map();
    const res = reconcileGrid(master, buildTarget(master), BOUNDARY, {
        logger: () => {},
        gapSlots: GAP,
        evacStreaks: streaks,
    });
    const rotations = res.actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId && a.newGridId !== a.id);
    assert.strictEqual(rotations.length, 3);
    const pivot = priceFor(151);
    for (const r of rotations) {
        // The plain guard (no bypass) vetoes every evacuation — the exact
        // 19:14 failure that stranded the band.
        const veto = isLastFillGuardBlocked(r.newPrice, ORDER_TYPES.SELL, pivot, ORDER_TYPES.SELL);
        assert.strictEqual(veto.blocked, true, `guard without bypass must veto ${r.id} -> ${r.newGridId}`);
        // Bypass route 1: the runtime gate keys on the frozen B-stamp fields.
        assert.strictEqual(r.origin, 'gap-evacuation');
        assert.strictEqual(Number(r.evacBoundary), BOUNDARY);
        assert.strictEqual(Number(r.evacGapSlots), GAP);
        // Bypass route 2: the live probe (unstamped path) also allows.
        const oldOrder = master.get(r.id);
        const probe = isEvacuationRotationAllowed(oldOrder.price, oldOrder.size, r.newPrice, r.newSize, ORDER_TYPES.SELL, 5);
        assert.strictEqual(probe.allowed, true, `live probe must allow ${r.id}: ${probe.reason}`);
    }
    console.log('✓ REP-003 passed');
}

async function testREP004_PreApplyCommitAndInvariants() {
    console.log('\n[REP-004] Pre-apply + simulated broadcast commit: band empty, 20/20, ~1.5% spread...');
    const master = buildGrid();
    const streaks = new Map();
    const res = reconcileGrid(master, buildTarget(master), BOUNDARY, {
        logger: () => {},
        gapSlots: GAP,
        evacStreaks: streaks,
    });
    const rotations = res.actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId && a.newGridId !== a.id);
    assert.strictEqual(rotations.length, 3);

    const bot = botLite(master);
    const plan = {
        ordersToRotate: rotations.map((r: any) => ({
            id: r.id,
            orderId: r.orderId,
            newGridId: r.newGridId,
            newPrice: r.newPrice,
            newSize: r.newSize,
            type: ORDER_TYPES.SELL,
            oldOrder: master.get(r.id),
        })),
        boundaryIdx: BOUNDARY,
        gapSlots: GAP,
        origin: 'gap-evacuation',
    };
    const actions = buildActionsFromPlan(bot, plan);
    assert.strictEqual(actions.length, 3, 'plan actions: 3 rotations');
    for (const a of actions) {
        assert.strictEqual(a.type, COW_ACTIONS.UPDATE);
        assert.strictEqual(a.origin, 'gap-evacuation');
        assert.strictEqual(Number(a.evacBoundary), BOUNDARY);
        assert.strictEqual(Number(a.evacGapSlots), GAP);
    }

    const cow = buildCowResultFromPlan(bot, plan);
    const working = cow.workingGrid;
    // Pre-apply: dests carry the rotated price/size as VIRTUAL placeholders
    // (the source slots optimistically keep their orderId until the executed
    // rotation transition clears them — same commit semantics as production).
    for (const i of [147, 149, 151]) {
        const d = working.get(`slot-${i}`);
        assert.strictEqual(d.state, ORDER_STATES.VIRTUAL, `dest slot-${i} pre-broadcast placeholder`);
        assert.ok(Math.abs(d.price - priceFor(i)) < 1e-6, `dest slot-${i} carries its rail price`);
        assert.strictEqual(d.size, 10, 'rotated size preserved (bit-exact, no growth)');
    }

    // Broadcast commit: the real post-execution transition — sources cleared
    // to holes (in-band -> SPREAD), dests activated with the inherited orderId.
    applyRotationTransitionsToWorkingGrid(bot, working, rotations.map((r: any) => ({
        kind: 'rotation',
        rotation: {
            oldOrder: master.get(r.id),
            newGridId: r.newGridId,
            newPrice: r.newPrice,
            newSize: r.newSize,
            type: ORDER_TYPES.SELL,
        },
    })));

    for (const i of [143, 144, 145]) {
        const s = working.get(`slot-${i}`);
        assert.strictEqual(s.state, ORDER_STATES.VIRTUAL, `band source slot-${i} must be empty after commit`);
        assert.strictEqual(s.orderId, null, `band source slot-${i} must not retain the moved orderId`);
    }
    for (const i of [147, 149, 151]) {
        const d = working.get(`slot-${i}`);
        assert.strictEqual(d.state, ORDER_STATES.ACTIVE, `dest slot-${i} active after commit`);
        assert.ok(d.orderId, `dest slot-${i} inherits the rotated orderId`);
        assert.strictEqual(d.type, ORDER_TYPES.SELL);
    }

    const sells = activeSellIds(working);
    assert.strictEqual(sells.length, 20, `active sells must reach 20/20, got ${sells.length}`);
    const buys = [...working.values()].filter((o: any) => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE);
    assert.strictEqual(buys.length, 20, 'buys untouched at 20/20');
    // Band must be empty of actives.
    for (let i = 142; i <= 145; i++) {
        const s = working.get(`slot-${i}`);
        assert.notStrictEqual(s.state, ORDER_STATES.ACTIVE, `band slot-${i} must not be active after evacuation`);
    }
    // Visible spread restored to ~1.5%: min sell rail / max buy rail - 1.
    const minSell = Math.min(...sells.map((id: string) => working.get(id).price));
    const maxBuy = Math.max(...buys.map((o: any) => o.price));
    const spread = minSell / maxBuy - 1;
    assert.ok(spread > 0.014 && spread < 0.016, `spread must be ~1.5%, got ${(spread * 100).toFixed(3)}%`);
    console.log(`✓ REP-004 passed (active sells 20/20, spread ${(spread * 100).toFixed(3)}%)`);
}

async function runAllTests() {
    console.log('=== Incident Replay Test Suite ===\n');
    await testREP001_GeometrySanity();
    await testREP002_ReconcileStampsThreeEvacuations();
    await testREP003_GuardWouldVetoButBypassAllows();
    await testREP004_PreApplyCommitAndInvariants();
    console.log('\n=== All incident-replay tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });

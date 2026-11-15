/**
 * ROTATION PLAN: the vacated source slot keeps ITS OWN ladder level.
 *
 * `buildCowResultFromPlan` pre-applies a plan to a working grid. For a rotation
 * UPDATE (one op that names a destination) that means TWO effects: the source
 * becomes a hole at its OWN genesis level and the destination takes the order at
 * the destination level.
 *
 * The pre-apply used to fall through to the generic in-place UPDATE branch,
 * which copies `action.order` — the DESTINATION's price and size — onto the
 * source slot. Live (2026-11-15) that produced six duplicated price levels in a
 * persisted grid, a non-monotonic ladder, a shifted boundary index and ~32k of
 * double-reserved virtual intent, and the on-chain book was fine only because
 * the executor derives a rotation's price from the destination's genesis level.
 *
 * Pinned here:
 *   1. A rotation keeps the source level bit-exact (and its booked size).
 *   2. The destination gets the planned level and size.
 *   3. The post-commit transition (applyRotationTransitionsToWorkingGrid) agrees.
 *   4. A non-rotation partial UPDATE still applies its size in place.
 */

const assert = require('assert');
const {
    buildCowResultFromPlan,
    applyRotationTransitionsToWorkingGrid,
} = require('../modules/dexbot_cow_runtime');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const { getSellStartIdx } = require('../modules/order/utils/math');

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

const BOUNDARY = 20;
const GAP = 4;
const INC = 0.3;
const SIZE = 40;
const BASE = 1000;
const SELL_START = getSellStartIdx(BOUNDARY, GAP); // 25
const levels: number[] = Array.from({ length: SIZE }, (_, i) => BASE * Math.pow(1 + INC / 100, i));

function slotFor(idx: number, state: string, size: number, orderId: string | null = null) {
    const type = idx <= BOUNDARY ? ORDER_TYPES.BUY
        : (idx >= SELL_START ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
    return { id: `slot-${idx}`, type, state, price: levels[idx], size, orderId, rawOnChain: orderId ? {} : null };
}

function buildGrid(): Map<string, any> {
    const grid = new Map<string, any>();
    for (let i = 0; i < SIZE; i++) grid.set(`slot-${i}`, slotFor(i, ORDER_STATES.VIRTUAL, 0));
    for (let i = BOUNDARY - 19; i <= BOUNDARY; i++) {
        grid.set(`slot-${i}`, slotFor(i, ORDER_STATES.ACTIVE, 10, `1.7.${1000 + i}`));
    }
    for (let i = SELL_START; i < SIZE; i++) {
        grid.set(`slot-${i}`, slotFor(i, ORDER_STATES.ACTIVE, 10, `1.7.${2000 + i}`));
    }
    // One stranded in-band sell (the rotation source) and one rail hole (dest).
    grid.set('slot-22', slotFor(22, ORDER_STATES.PARTIAL, 7, '1.7.4242'));
    grid.set('slot-30', slotFor(30, ORDER_STATES.VIRTUAL, 0));
    return grid;
}

function botLite(master: Map<string, any>) {
    return {
        manager: {
            orders: master,
            _gridVersion: 3,
            boundaryIdx: BOUNDARY,
            _gapSlots: GAP,
            logger: { log: () => {} },
        },
    };
}

function rotationPlan(master: Map<string, any>) {
    return {
        boundaryIdx: BOUNDARY,
        gapSlots: GAP,
        ordersToRotate: [{
            id: 'slot-22',
            orderId: '1.7.4242',
            newGridId: 'slot-30',
            newPrice: levels[30],
            newSize: 5,
            type: ORDER_TYPES.SELL,
            oldOrder: master.get('slot-22'),
        }],
    };
}

run('ROT-1 a rotation plan keeps the vacated source at ITS OWN level and size', () => {
    const master = buildGrid();
    const cow = buildCowResultFromPlan(botLite(master), rotationPlan(master));
    const working = cow.workingGrid;
    const source = working.get('slot-22');
    assert(source, 'source slot must remain in the grid');
    assert.strictEqual(source.price, levels[22],
        `source hole must keep its genesis level ${levels[22]}, got ${source.price} (destination was ${levels[30]})`);
    // An IN-BAND source becomes a side-neutral SPREAD placeholder, which is
    // size-less by design (the band is empty); the ROT-1b rail case below is the
    // one that must preserve a booked size.
    assert.strictEqual(source.size, 0, 'an in-band source hole is a size-less spread placeholder');
    assert.strictEqual(source.state, ORDER_STATES.VIRTUAL, 'source becomes a hole');
    assert.strictEqual(source.orderId, null, 'source must not keep the moved order id');
});

run('ROT-1b a RAIL source keeps both its level and its booked size', () => {
    // The live corruption shape: an interior rail slot rotated out. Its size is
    // the remainder the guard/plan must still see, and its price is its own.
    const master = buildGrid();
    master.set('slot-27', { ...slotFor(27, ORDER_STATES.PARTIAL, 6.5, '1.7.4243') });
    const cow = buildCowResultFromPlan(botLite(master), {
        boundaryIdx: BOUNDARY,
        gapSlots: GAP,
        ordersToRotate: [{
            id: 'slot-27',
            orderId: '1.7.4243',
            newGridId: 'slot-35',
            newPrice: levels[35],
            newSize: 6.5,
            type: ORDER_TYPES.SELL,
            oldOrder: master.get('slot-27'),
        }],
    });
    const source = cow.workingGrid.get('slot-27');
    assert.strictEqual(source.price, levels[27], 'rail hole keeps its own level');
    assert.strictEqual(source.size, 6.5, 'rail hole keeps the booked remainder size');
    assert.strictEqual(source.type, ORDER_TYPES.SELL, 'rail hole stays rail-typed');
});

run('ROT-2 the destination takes the planned level and size', () => {
    const master = buildGrid();
    const cow = buildCowResultFromPlan(botLite(master), rotationPlan(master));
    const dest = cow.workingGrid.get('slot-30');
    assert(dest, 'destination slot exists');
    assert.strictEqual(dest.price, levels[30], 'destination carries its own rail level');
    assert.strictEqual(dest.size, 5, 'destination carries the rotated size');
    assert.strictEqual(dest.state, ORDER_STATES.VIRTUAL, 'destination is a pre-broadcast placeholder');
    assert.strictEqual(dest.orderId, null, 'destination does not own the id until commit');
});

run('ROT-3 no two slots may share a price level after a rotation plan', () => {
    const master = buildGrid();
    const cow = buildCowResultFromPlan(botLite(master), rotationPlan(master));
    const byPrice = new Map<number, string[]>();
    for (const o of cow.workingGrid.values()) {
        const key = Number(o.price);
        byPrice.set(key, [...(byPrice.get(key) || []), String(o.id)]);
    }
    const dupes = [...byPrice.values()].filter((ids) => ids.length > 1);
    assert.deepStrictEqual(dupes, [], `no level may be occupied twice (dupes: ${JSON.stringify(dupes)})`);
});

run('ROT-4 the post-commit transition agrees with the plan', () => {
    const master = buildGrid();
    const plan = rotationPlan(master);
    const cow = buildCowResultFromPlan(botLite(master), plan);
    const working = cow.workingGrid;
    const bot = botLite(master);
    applyRotationTransitionsToWorkingGrid(bot, working, [{
        kind: 'rotation',
        rotation: {
            oldOrder: master.get('slot-22'),
            newGridId: 'slot-30',
            newPrice: levels[30],
            newSize: 5,
            type: ORDER_TYPES.SELL,
        },
    }]);
    const source = working.get('slot-22');
    const dest = working.get('slot-30');
    assert.strictEqual(source.price, levels[22], 'committed source hole keeps its own level');
    assert.strictEqual(source.state, ORDER_STATES.VIRTUAL);
    assert.strictEqual(source.orderId, null);
    assert.strictEqual(dest.price, levels[30]);
    assert.strictEqual(dest.size, 5);
    assert.strictEqual(dest.orderId, '1.7.4242', 'destination inherits the rotated order id');
});

run('ROT-5 a non-rotation partial UPDATE still applies its new size in place', () => {
    const master = buildGrid();
    const cow = buildCowResultFromPlan(botLite(master), {
        boundaryIdx: BOUNDARY,
        gapSlots: GAP,
        ordersToUpdate: [{
            id: 'slot-31',
            orderId: '1.7.9001',
            newSize: 4.25,
            type: ORDER_TYPES.SELL,
            partialOrder: { ...master.get('slot-31'), size: 10, orderId: '1.7.9001' },
        }],
    });
    const updated = cow.workingGrid.get('slot-31');
    assert.strictEqual(updated.size, 4.25, 'in-place size update must still land');
    assert.strictEqual(updated.price, levels[31], 'in-place update never touches the level');
    assert.strictEqual(updated.orderId, '1.7.9001', 'in-place update keeps the order id');
});

run('ROT-6 a rotation into the SOURCE\'s own slot id is not a rotation (no-op safety)', () => {
    const master = buildGrid();
    const cow = buildCowResultFromPlan(botLite(master), {
        boundaryIdx: BOUNDARY,
        gapSlots: GAP,
        ordersToRotate: [{
            id: 'slot-33',
            orderId: '1.7.9002',
            newGridId: 'slot-33',
            newPrice: levels[33],
            newSize: 10,
            type: ORDER_TYPES.SELL,
            oldOrder: master.get('slot-33'),
        }],
    });
    const same = cow.workingGrid.get('slot-33');
    assert.strictEqual(same.price, levels[33], 'self-rotation keeps the level');
    assert(same.orderId, 'self-rotation keeps the order id (it is an in-place update)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

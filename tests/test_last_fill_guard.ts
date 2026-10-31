/**
 * LAST-FILL-GUARD unit tests — DIRECTION ONLY relative to the last fill price.
 *
 *   BUY  blocked at/above the pivot   (never place a higher BUY)
 *   SELL blocked at/below the pivot   (never place a lower SELL)
 *
 * The increment takes no part: the old pivot ± increment/2 band blocked
 * profitable placements within half a step of the pivot (which is exactly where
 * spread correction places — the spread edge on a grid slot), and it blocked
 * buy-backs below a SELL fill. The band parameters were REMOVED from the
 * signature (LFG-5 pins the arity), so re-adding an increment term cannot
 * happen without touching this test. Cold (null pivot/type) => disabled.
 */
const assert = require('assert');
const { isLastFillGuardBlocked, resolveOnGridPivot } = require('../modules/dexbot_cow_runtime');
const { ORDER_TYPES } = require('../modules/constants');

const blocked = (price: number, type: string, pivot: number | null, lastType: string | null) =>
    isLastFillGuardBlocked(price, type, pivot, lastType).blocked;

async function testColdStartDisabled() {
    console.log('\n[LFG-1] cold start (null) => disabled');
    assert.strictEqual(blocked(1000, ORDER_TYPES.BUY, null, ORDER_TYPES.BUY), false);
    assert.strictEqual(blocked(1000, ORDER_TYPES.SELL, null, ORDER_TYPES.SELL), false);
    assert.strictEqual(blocked(1000, ORDER_TYPES.BUY, 1000, null), false, 'null fill side => disabled (book-seeded pivot)');
    assert.strictEqual(blocked(1000, ORDER_TYPES.BUY, undefined, ORDER_TYPES.BUY), false);
    assert.strictEqual(blocked(1000, ORDER_TYPES.SELL, NaN, ORDER_TYPES.SELL), false);
    assert.strictEqual(blocked(NaN, ORDER_TYPES.SELL, 1000, ORDER_TYPES.BUY), false, 'non-finite price => not blocked');
    console.log('✓ LFG-1 passed');
}

async function testBuyAndSellDirection() {
    console.log('\n[LFG-2] BUY must be below the pivot, SELL above it (any distance)');
    const pivot = 1000;
    // BUY: below passes, at/above blocks — with NO increment margin.
    assert.strictEqual(blocked(999.99, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY), false, 'BUY 999.99 is below => allowed');
    assert.strictEqual(blocked(1000, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY), true, 'BUY at the pivot => blocked (re-place at the filled level)');
    assert.strictEqual(blocked(1000.01, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY), true, 'BUY above the pivot => blocked');
    assert.strictEqual(blocked(990, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY), false);
    // SELL: above passes, at/below blocks.
    assert.strictEqual(blocked(1000.01, ORDER_TYPES.SELL, pivot, ORDER_TYPES.BUY), false, 'SELL just above the pivot => allowed');
    assert.strictEqual(blocked(1000, ORDER_TYPES.SELL, pivot, ORDER_TYPES.BUY), true, 'SELL at the pivot => blocked');
    assert.strictEqual(blocked(999.99, ORDER_TYPES.SELL, pivot, ORDER_TYPES.BUY), true, 'SELL below the pivot => blocked');
    assert.strictEqual(blocked(1100, ORDER_TYPES.SELL, pivot, ORDER_TYPES.BUY), false);
    console.log('✓ LFG-2 passed');
}

async function testLowerBuyUnderHigherSellIsAllowed() {
    console.log('\n[LFG-3] a BUY under a SELL fill is never blocked (the old band blocked it)');
    const sellFill = 100;
    // The band used to block these (BUY > pivot*(1-inc/2/100) = 99.75 for inc 0.5%).
    assert.strictEqual(blocked(99.8, ORDER_TYPES.BUY, sellFill, ORDER_TYPES.SELL), false,
        'buying back 0.2% below our sale must be allowed');
    assert.strictEqual(blocked(99.6, ORDER_TYPES.BUY, sellFill, ORDER_TYPES.SELL), false,
        'buying back 0.4% below our sale must be allowed');
    assert.strictEqual(blocked(100.2, ORDER_TYPES.BUY, sellFill, ORDER_TYPES.SELL), true,
        'buying ABOVE our sale is still blocked (adverse)');
    console.log('✓ LFG-3 passed');
}

async function testSpreadEdgeAfterFillIsAllowed() {
    console.log('\n[LFG-4] the spread edge next to a fill is placeable (spread correction)');
    // Dump sweep: our BUYs filled down, the last fill is a BUY at 100 and the
    // correction wants to place the tightening SELL at the edge, 0.2% above.
    assert.strictEqual(blocked(100.2, ORDER_TYPES.SELL, 100, ORDER_TYPES.BUY), false,
        'SELL 0.2% above our cost must be placeable — this is the spread edge');
    assert.strictEqual(blocked(100.01, ORDER_TYPES.SELL, 100, ORDER_TYPES.BUY), false,
        'even a 0.01% profit is a profit: direction only');
    assert.strictEqual(blocked(99.8, ORDER_TYPES.SELL, 100, ORDER_TYPES.BUY), true,
        'selling below our cost stays blocked (issue #31)');
    // Mirror: after a SELL fill at 100 the tightening BUY edge is just below.
    assert.strictEqual(blocked(99.8, ORDER_TYPES.BUY, 100, ORDER_TYPES.SELL), false,
        'BUY 0.2% below our sale must be placeable');
    console.log('✓ LFG-4 passed');
}

async function testIncrementHasNoEffect() {
    console.log('\n[LFG-5] the band parameters are gone (direction rule only)');
    const pivot = 1000;
    const price = 999.9; // below the pivot: allowed under the direction rule
    assert.strictEqual(blocked(price, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY), false,
        'BUY 999.9 must be allowed');
    assert.strictEqual(blocked(1000.1, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY), true,
        'BUY 1000.1 must be blocked');
    // ARITY PIN: isLastFillGuardBlocked(price, type, lastPrice, lastType).
    // The old signature carried (price, size, type, lastPrice, lastType,
    // increment) — no increment term is reachable through this function, which
    // is what makes a silent band-rule reintroduction a compile error at every
    // call site instead of a runtime surprise.
    assert.strictEqual(isLastFillGuardBlocked.length, 4,
        'the guard must take exactly (price, type, lastPrice, lastType)');
    // Trailing arguments must not resurrect a band.
    const withExtras: any = (isLastFillGuardBlocked as any)(price, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY, 0.5, { irrelevant: true });
    assert.strictEqual(withExtras.blocked, false, 'trailing arguments must not change the verdict');
    console.log('✓ LFG-5 passed');
}

async function testMostRecentFillWins() {
    console.log('\n[LFG-6] the pivot is always the most recent fill');
    // After the sweep the last fill is a BUY at 980: sells above it are fine,
    // buys at/above it are not.
    assert.strictEqual(blocked(990, ORDER_TYPES.SELL, 980, ORDER_TYPES.BUY), false);
    assert.strictEqual(blocked(975, ORDER_TYPES.SELL, 980, ORDER_TYPES.BUY), true);
    assert.strictEqual(blocked(979, ORDER_TYPES.BUY, 980, ORDER_TYPES.BUY), false);
    assert.strictEqual(blocked(980, ORDER_TYPES.BUY, 980, ORDER_TYPES.BUY), true);
    // Then a SELL fills at 1010 and takes over the pivot.
    assert.strictEqual(blocked(1005, ORDER_TYPES.BUY, 1010, ORDER_TYPES.SELL), false);
    assert.strictEqual(blocked(1010, ORDER_TYPES.BUY, 1010, ORDER_TYPES.SELL), true);
    assert.strictEqual(blocked(1005, ORDER_TYPES.SELL, 1010, ORDER_TYPES.SELL), true);
    assert.strictEqual(blocked(1015, ORDER_TYPES.SELL, 1010, ORDER_TYPES.SELL), false);
    console.log('✓ LFG-6 passed');
}

async function testSpreadCorrectionBypassNote() {
    console.log('\n[LFG-7] spread-correction origin propagation (bypass still a separate decision)');
    // The helper is origin-agnostic: a correction CREATE judged by the guard
    // obeys the same direction rule. Whether a correction may bypass is decided
    // at the broadcast site (isSpreadCorrectionBypassAllowed), not here.
    assert.strictEqual(blocked(1009, ORDER_TYPES.SELL, 1010, ORDER_TYPES.SELL), true,
        'a SELL below the pivot is blocked for the helper regardless of origin');
    assert.strictEqual(blocked(1011, ORDER_TYPES.SELL, 1010, ORDER_TYPES.SELL), false,
        'a SELL above the pivot passes for the helper regardless of origin');
    const { buildCowResultFromPlan } = require('../modules/dexbot_cow_runtime');
    const mockBot = { manager: { orders: new Map(), _gridVersion: 0, boundaryIdx: 0 }, config: {} };
    const plan = { ordersToPlace: [{ id: 'slot-135', type: ORDER_TYPES.SELL, price: 1009, size: 10 }], origin: 'spread-correction' };
    const cow = buildCowResultFromPlan(mockBot as any, plan as any);
    assert.strictEqual((cow as any).origin, 'spread-correction', 'origin must propagate for the bypass decision');
    console.log('✓ LFG-7 passed');
}

/**
 * PIVOT-001..003 - the LAST-FILL pivot must be a real grid level.
 *
 * The pivot was an unvalidated raw price, so a bad one silently shifted every
 * threshold and made off-market placements read as legitimate (the ratchet
 * precondition). resolveOnGridPivot validates it against the ladder. The
 * distinction that matters: an in-grid-but-slightly-off price is SNAPPED to its
 * slot (fills execute near their slot price), while a wildly off-ladder price
 * is NOT rewritten onto an edge slot - that would dress up a corrupt pivot as a
 * legitimate edge fill.
 */
async function testPivotSnapsToGridLevel() {
    console.log('\n[PIVOT-001] a near-ladder pivot snaps to its slot level...');
    const levels = [100, 101, 102, 103, 104, 105];
    const genesis = { priceLevels: levels };
    const manager = { _genesis: genesis, config: { incrementPercent: 1 } };

    // 101.2 is within half an increment (0.5%) of slot 1 (101).
    const r = resolveOnGridPivot(manager, 101.2);
    assert.strictEqual(r.idx, 1, `expected slot 1, got ${r.idx}`);
    assert.strictEqual(r.price, 101, `expected the slot level 101, got ${r.price}`);
    assert.strictEqual(r.snapped, true, 'a moved pivot must be reported as snapped');

    // An exact level is a no-op snap.
    const exact = resolveOnGridPivot(manager, 103);
    assert.strictEqual(exact.idx, 3, 'an exact level must resolve to its own slot');
    assert.strictEqual(exact.price, 103, 'an exact level must be unchanged');
    assert.strictEqual(exact.snapped, false, 'an exact level is not a snap');
    console.log('  \u2713 PIVOT-001 passed');
}

async function testOffGridPivotIsNotRewritten() {
    console.log('\n[PIVOT-002] a far off-ladder pivot is NOT rewritten onto an edge slot...');
    const genesis = { priceLevels: [100, 101, 102, 103, 104, 105] };
    const manager = { _genesis: genesis, config: { incrementPercent: 1 } };

    // 40 is nowhere near the ladder. slotIndexForPrice clamps it to slot 0, but
    // adopting that would fabricate a legitimate-looking pivot at 100.
    const r = resolveOnGridPivot(manager, 40);
    assert.strictEqual(r.idx, null, 'an off-ladder pivot must not claim a slot');
    assert.strictEqual(r.price, 40, 'an off-ladder pivot must keep its raw value');
    assert.strictEqual(r.snapped, false, 'an off-ladder pivot is not a snap');
    // nearestDrift must be reported even though the snap was refused, so a
    // caller can tell a near-miss from a price nowhere near the ladder. Without
    // it the refusal path carries no distance and both cases look identical.
    assert.ok(r.nearestDrift != null && r.nearestDrift > 1,
        `a refused snap must still report how far off it was, got ${r.nearestDrift}`);

    // A near-ladder price within the snap tolerance is SNAPPED onto the
    // nearest level, and still reports its pre-snap drift. (101.9 is 0.098%
    // from level 102, well inside the 1% increment tolerance, so this is the
    // snap path -- not the refusal path exercised above with 40.)
    const nearMiss = resolveOnGridPivot(manager, 101.9);
    assert.strictEqual(nearMiss.snapped, true,
        'a near-ladder price inside tolerance must snap');
    assert.strictEqual(nearMiss.price, 102,
        'a snapped pivot must resolve to the nearest level');
    assert.strictEqual(nearMiss.idx, 2,
        'a snapped pivot must report the slot index it landed on');
    assert.ok(nearMiss.nearestDrift != null && nearMiss.nearestDrift < 0.02,
        `a near-miss must report its small pre-snap drift, got ${nearMiss.nearestDrift}`);
    console.log('  \u2713 PIVOT-002 passed');
}

async function testPivotWithoutGenesisFallsBack() {
    console.log('\n[PIVOT-003] no genesis falls back to the raw pivot; bad input is null...');
    const manager = { config: { incrementPercent: 1 } };

    const noGenesis = resolveOnGridPivot(manager, 101.2);
    assert.strictEqual(noGenesis.price, 101.2, 'without genesis the raw pivot is used (guard degrades, not disabled)');
    assert.strictEqual(noGenesis.idx, null, 'without genesis no slot can be claimed');

    // Pre-genesis startup must not crash or invent a pivot.
    const empty = resolveOnGridPivot({ _genesis: { priceLevels: [] }, config: {} }, 101.2);
    assert.strictEqual(empty.idx, null, 'an empty ladder claims no slot');

    // Assert the shape by field, not deep-equality: the result carries
    // diagnostics (nearestDrift) that are not part of the contract under test.
    for (const [label, input] of [['null', null], ['NaN', NaN], ['a non-positive value', -5]] as const) {
        const r = resolveOnGridPivot(manager, input);
        assert.strictEqual(r.price, null, `${label} pivot resolves to a null price`);
        assert.strictEqual(r.idx, null, `${label} pivot claims no slot`);
    }
    console.log('  \u2713 PIVOT-003 passed');
}

async function main() {
    await testColdStartDisabled();
    await testBuyAndSellDirection();
    await testLowerBuyUnderHigherSellIsAllowed();
    await testSpreadEdgeAfterFillIsAllowed();
    await testIncrementHasNoEffect();
    await testMostRecentFillWins();
    await testSpreadCorrectionBypassNote();
    await testPivotSnapsToGridLevel();
    await testOffGridPivotIsNotRewritten();
    await testPivotWithoutGenesisFallsBack();
    console.log('\nAll LAST-FILL-GUARD tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('LAST-FILL-GUARD test failed:', err);
        process.exit(1);
    });
}

module.exports = { main };

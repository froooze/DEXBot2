/**
 * Gap-evacuation spread collapse — regression tests.
 *
 * Live incident (2026-11-03, 4-slot band, target 2.0%): a buy fill landing
 * INSIDE the gap band crawled the boundary down by one slot per owed crawl. The
 * retreat stranded the two live buys sitting above it, the plan built the
 * evacuation rotations, and the LAST-FILL-GUARD refused them as "stale under
 * live boundary" because it re-proves an evacuation against the PRE-COMMIT
 * geometry — where those slots are still valid rail members. The batch then
 * committed the retreat, nothing evacuated the stranded orders, and because
 * plans are fill-driven the state never healed on a quiet market: the real
 * top-of-book spread stayed at 1.21% (3 increments) against a 2.02% target, and
 * the analysis tool hid it by slicing rails by array index (reporting 2.02%).
 *
 * Covered here:
 *  1. liveRailsConflictWithGap — the forced-retreat discriminator that lets the
 *     evacuation proceed when the live rails cannot host the band at ANY
 *     boundary (and stays false for the 2026-10-30 bid-edge class, where the
 *     live geometry was consistent and skipping the move was correct).
 *  2. forcedRetreatJustifiesEvacuation — the single decision point for the
 *     allowance: it must never override a stamp whose source/dest ids are
 *     unparseable (an unprovable stamp is not a geometry disagreement).
 *  3. scheduleGapEvacRepair — post-commit / maintenance sweep that re-plans the
 *     evacuation against the COMMITTED geometry (the guard's stale-stamp check
 *     passes once the commit landed), drops resolved streak entries, prefers the
 *     re-plan over the cancel-only teeth, and treats UNKNOWN geometry as
 *     unknown (never as "clean").
 *  4. _logBoundaryDebug — the restore line must not print `gapSlots=0
 *     sellStart=boundary+1` (the "bot lost its fixed spread / only one slot is
 *     used" field report) when the loader has not published _gapSlots yet, and
 *     must print `spreadCount=?` until the metric has actually been measured.
 */

const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { liveRailsConflictWithGap, forcedRetreatJustifiesEvacuation, splitEvacuationCancelsSupersededByRotations } = require('../modules/dexbot_cow_runtime');
const { scheduleGapEvacRepair } = require('../modules/dexbot_state_recovery');
const { OrderManager } = require('../modules/order/manager');
const { calculateGapSlots } = require('../modules/order/utils/math');

// ── helpers ─────────────────────────────────────────────────────────────

/** Slot builder: an in-band or rail order with a live chain id. */
function slot(idx, type, { orderId = `1.7.${1000 + idx}`, size = 1, state = ORDER_STATES.ACTIVE } = {}) {
    return {
        id: `slot-${idx}`,
        price: 1 + idx * 0.004,
        type,
        state: orderId ? state : ORDER_STATES.VIRTUAL,
        size: orderId ? size : 0,
        orderId: orderId || '',
    };
}

function masterGrid(slots) {
    const map = new Map();
    for (const s of slots) map.set(s.id, s);
    return map;
}

/** Minimal manager shape the two helpers read. */
function fakeManager(slots, { boundaryIdx = 71, gapSlots = 4, config = null } = {}) {
    return {
        // Assigned by the scheduling tests (scheduleGapEvacRepair delegates the
        // actual re-plan to _schedulePostRecoveryRebalance).
        performSafeRebalance: async () => ({ aborted: true, actions: [] }),
        orders: masterGrid(slots),
        boundaryIdx,
        _gapSlots: gapSlots,
        _genesis: null,
        assets: null,
        config,
        _gapEvacStreaks: new Map(),
        _gapEvacCancelQueued: new Set(),
        ordersNeedingPriceCorrection: [],
        logger: { log: () => {} },
        // Optional in the helpers: assigned by tests that assert the teeth path.
        _processGapEvacuationTeeth: null as null | ((ready: unknown) => void),
    };
}

// ── 1. liveRailsConflictWithGap ─────────────────────────────────────────

function testRailConflictDetectsTheStrandedRetreat() {
    // The live incident: boundary 71, band 72..75, live buys at 72/73 (the
    // stranded ones) and sells from 76. No boundary can host both rails with a
    // 4-slot band (73 > 76-4-1 = 71), so the retreat is FORCED.
    const manager = fakeManager([
        ...Array.from({ length: 19 }, (_, i) => slot(54 + i, ORDER_TYPES.BUY)),
        slot(72, ORDER_TYPES.BUY),
        slot(73, ORDER_TYPES.BUY, { state: ORDER_STATES.PARTIAL }),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ]);
    const conflict = liveRailsConflictWithGap(manager, 4);
    assert.strictEqual(conflict.crossed, true, 'crossed rails must report a forced retreat');
    assert.strictEqual(conflict.maxBuyIdx, 73);
    assert.strictEqual(conflict.minSellIdx, 76);
    assert.strictEqual(conflict.upper, 71);
}

function testRailConflictStaysQuietForTheBidEdgeClass() {
    // 2026-10-30 incident: plan boundary 124 wanted buys 125-128 evacuated, but
    // the live boundary was 128 and those orders were valid rail members; the
    // live rails were consistent, so the guard must keep refusing the move
    // (evacuating them lost the bid edge).
    const manager = fakeManager([
        ...Array.from({ length: 20 }, (_, i) => slot(109 + i, ORDER_TYPES.BUY)),
        ...Array.from({ length: 20 }, (_, i) => slot(133 + i, ORDER_TYPES.SELL)),
    ], { boundaryIdx: 128 });
    const conflict = liveRailsConflictWithGap(manager, 4);
    assert.strictEqual(conflict.crossed, false, 'a consistent live book must not be treated as forced');
    assert.strictEqual(conflict.maxBuyIdx, 128);
    assert.strictEqual(conflict.minSellIdx, 133);
}

function testRailConflictFailsClosedOnUnknownOrOneSidedGeometry() {
    // One-sided book: nothing proves a crossing.
    const oneSided = fakeManager(Array.from({ length: 5 }, (_, i) => slot(i, ORDER_TYPES.BUY)));
    assert.strictEqual(liveRailsConflictWithGap(oneSided, 4).crossed, false);

    // Unknown gap (null/''/NaN) must not read as a 0-wide band.
    for (const gap of [null, undefined, '', NaN, -1]) {
        const manager = fakeManager([
            slot(72, ORDER_TYPES.BUY),
            slot(76, ORDER_TYPES.SELL),
        ]);
        assert.strictEqual(
            liveRailsConflictWithGap(manager, gap).crossed,
            false,
            `gap ${String(gap)} must fail closed`
        );
    }

    // No manager / no grid.
    assert.strictEqual(liveRailsConflictWithGap(null, 4).crossed, false);
    assert.strictEqual(liveRailsConflictWithGap({ orders: new Map() }, 4).crossed, false);
}

// ── 2. scheduleGapEvacRepair ────────────────────────────────────────────

function testSweepSchedulesRepairForStrandedOrders() {
    const manager = fakeManager([
        ...Array.from({ length: 19 }, (_, i) => slot(54 + i, ORDER_TYPES.BUY)),
        slot(72, ORDER_TYPES.BUY),
        slot(73, ORDER_TYPES.BUY),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ]);
    const bot = {
        manager,
        _postRecoveryRebalanceTimer: null,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _shuttingDown: false,
        managerPerformSafeRebalance: true,
        performSafeRebalance: async () => ({ aborted: true, actions: [] }),
        updateOrdersOnChainBatch: async () => ({ executed: false }),
    };

    const result = scheduleGapEvacRepair(bot, 'test');
    assert.deepStrictEqual(
        result.stranded,
        ['slot-72(buy)', 'slot-73(buy)'],
        'both stranded buys must be named'
    );
    assert.strictEqual(result.scheduled, true, 'a fill-less re-plan must be scheduled');
    assert.ok(bot._postRecoveryRebalanceTimer, 'the deferred rebalance timer must be armed');
    // The sweep re-derives the ledger WITHOUT counting an observation: the
    // plan's reconcileGrid tick is the cycle's single increment. Counting both
    // (observed live) took a restored streak of 1 to the cancel threshold in one
    // cycle and armed the teeth against the plan's own rotation sources.
    assert.strictEqual(manager._gapEvacStreaks.get('slot-72'), 0, 'the sweep must not increment the streak');
    assert.strictEqual(manager._gapEvacStreaks.get('slot-73'), 0, 'the sweep must not increment the streak');
    clearTimeout(bot._postRecoveryRebalanceTimer);
    bot._postRecoveryRebalanceTimer = null;
    clearTimeout(bot._postRecoveryRebalanceTimer);
    bot._postRecoveryRebalanceTimer = null;
}

function testSweepIsSilentAndClearsStreaksOnAHealthyBand() {
    const manager = fakeManager([
        ...Array.from({ length: 20 }, (_, i) => slot(52 + i, ORDER_TYPES.BUY)),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ]);
    // Stale ledger entry from an earlier stranding that has since resolved.
    manager._gapEvacStreaks.set('slot-72', 3);
    const bot = {
        manager,
        _postRecoveryRebalanceTimer: null,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _shuttingDown: false,
        performSafeRebalance: async () => ({ aborted: true, actions: [] }),
        updateOrdersOnChainBatch: async () => ({ executed: false }),
    };

    const result = scheduleGapEvacRepair(bot, 'test');
    assert.deepStrictEqual(result.stranded, []);
    assert.strictEqual(result.scheduled, false, 'a clean band must not re-plan');
    assert.strictEqual(bot._postRecoveryRebalanceTimer, null);
    assert.strictEqual(manager._gapEvacStreaks.size, 0, 'resolved streak entries must be dropped');
}

function testSweepHonoursTheRepairCooldown() {
    const slots = [
        ...Array.from({ length: 19 }, (_, i) => slot(54 + i, ORDER_TYPES.BUY)),
        slot(72, ORDER_TYPES.BUY),
        slot(73, ORDER_TYPES.BUY),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ];
    const manager = fakeManager(slots);
    const bot = {
        manager,
        _postRecoveryRebalanceTimer: null,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _shuttingDown: false,
        performSafeRebalance: async () => ({ aborted: true, actions: [] }),
        updateOrdersOnChainBatch: async () => ({ executed: false }),
    };

    assert.strictEqual(scheduleGapEvacRepair(bot, 'first').scheduled, true);
    clearTimeout(bot._postRecoveryRebalanceTimer);
    bot._postRecoveryRebalanceTimer = null;

    const second = scheduleGapEvacRepair(bot, 'second');
    assert.strictEqual(second.scheduled, false, 'the second sweep inside the window must not re-plan');
    assert.deepStrictEqual(second.stranded, ['slot-72(buy)', 'slot-73(buy)'], 'stranding is still reported');
    assert.strictEqual(bot._postRecoveryRebalanceTimer, null);
}

function testSweepPrefersTheReplanAndFallsBackToTheTeeth() {
    // The re-plan evacuates by price update; the teeth cancel+recreate. Both in
    // one tick would cancel the order the re-plan is about to rotate, so the
    // teeth are only queued when the re-plan cannot run (here: cooldown).
    const manager = fakeManager([
        ...Array.from({ length: 19 }, (_, i) => slot(54 + i, ORDER_TYPES.BUY)),
        slot(72, ORDER_TYPES.BUY),
        slot(73, ORDER_TYPES.BUY),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ]);
    const teethCalls: unknown[] = [];
    manager._processGapEvacuationTeeth = (ready: unknown) => {
        teethCalls.push(ready);
        return Array.isArray(ready) ? ready.length : 0;
    };
    const bot = {
        manager,
        _postRecoveryRebalanceTimer: null,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _shuttingDown: false,
        performSafeRebalance: async () => ({ aborted: true, actions: [] }),
        updateOrdersOnChainBatch: async () => ({ executed: false }),
    };
    manager.performSafeRebalance = bot.performSafeRebalance;
    // Pre-seeded streaks at the warn threshold, as a restart restores them.
    manager._gapEvacStreaks.set('slot-72', 2);
    manager._gapEvacStreaks.set('slot-73', 2);

    const first = scheduleGapEvacRepair(bot, 'test');
    assert.strictEqual(first.scheduled, true, 'the preferred repair is the re-plan');
    assert.strictEqual(teethCalls.length, 0, 'the teeth must not race the re-plan in the same tick');
    clearTimeout(bot._postRecoveryRebalanceTimer);
    bot._postRecoveryRebalanceTimer = null;

    const before = manager._gapEvacStreaks.get('slot-72');
    const second = scheduleGapEvacRepair(bot, 'test');
    assert.strictEqual(second.scheduled, false, 'cooldown blocks the second re-plan');
    assert.strictEqual(teethCalls.length, 1, 'the cooldown path falls back to the cancel-only teeth');
    assert.strictEqual(manager._gapEvacStreaks.get('slot-72'), before,
        'the cooldown path must not count a second observation (scheduled re-plans keep ticking the ledger)');
}

function testDrainHoldsCancelsTheBatchRotates() {
    // The failure the live log showed: the teeth queued a cancel-only
    // evacuation for the same chain orders the plan rotated, the pre-batch
    // drain cancelled them, and the UPDATE batch was rejected with "target(s)
    // missing on chain" → structural resync + full grid reload.
    const actions = [
        { type: 'update', id: 'slot-72', orderId: '1.7.111', newGridId: 'slot-52' },
        { type: 'update', id: 'slot-73', orderId: '1.7.222', newGridId: 'slot-53' },
        { type: 'create', id: 'slot-60', order: {} },
    ];
    const entries = [
        { gridOrder: { id: 'slot-72' }, chainOrderId: '1.7.111', gapEvacuation: true, isSurplus: true },
        { gridOrder: { id: 'slot-73' }, chainOrderId: '1.7.222', gapEvacuation: true, isSurplus: true },
        { gridOrder: { id: 'slot-90' }, chainOrderId: '1.7.999', cancelOnly: true }, // duplicate-orphan cancel: unaffected
    ];
    const { kept, held } = splitEvacuationCancelsSupersededByRotations(entries, actions);
    assert.deepStrictEqual(held.map((e) => e.chainOrderId), ['1.7.111', '1.7.222'],
        'cancels for chain orders the batch rotates must be held out of the drain');
    assert.deepStrictEqual(kept.map((e) => e.chainOrderId), ['1.7.999'],
        'unrelated corrections still drain');

    // Nothing is rotated => nothing is held (the drain keeps full authority).
    const noRotations = splitEvacuationCancelsSupersededByRotations(entries, [{ type: 'create', id: 'slot-60' }]);
    assert.strictEqual(noRotations.held.length, 0, 'no rotation => no hold');
    assert.strictEqual(noRotations.kept.length, entries.length, 'all entries still drain');
}

function testForcedRetreatRequiresAnEvaluableStamp() {
    // The allowance may only override a refusal it can actually reason about:
    // an unparseable source/dest id means the stamp was never evaluable, and
    // overriding that would ship a rotation whose geometry nobody proved.
    const manager = fakeManager([
        ...Array.from({ length: 20 }, (_, i) => slot(52 + i, ORDER_TYPES.BUY)),
        slot(72, ORDER_TYPES.BUY),
        slot(73, ORDER_TYPES.BUY),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ]);
    const allowed = forcedRetreatJustifiesEvacuation(manager, 4, 'slot-72', 'slot-52');
    assert.ok(allowed && allowed.crossed, 'parseable ids + crossed rails => allowance applies');
    assert.strictEqual(forcedRetreatJustifiesEvacuation(manager, 4, 'buy-72', 'slot-52'), null,
        'unparseable source id => no allowance (the stamp was never evaluable)');
    assert.strictEqual(forcedRetreatJustifiesEvacuation(manager, 4, 'slot-72', 'rail-52'), null,
        'unparseable dest id => no allowance');
}

function testSweepTreatsUnknownGeometryAsUnknown() {
    // Unknown geometry is NOT health: no boundary (or no known band width)
    // means there is no band to judge, so the sweep must neither schedule a
    // re-plan nor clear the streak ledger. Reading absent geometry as "clean"
    // (or as boundary 0 / gap 0) is the exact trap that hid the stranding.
    const manager = fakeManager([
        ...Array.from({ length: 20 }, (_, i) => slot(52 + i, ORDER_TYPES.BUY)),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ]);
    const bot = {
        manager,
        _postRecoveryRebalanceTimer: null,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _shuttingDown: false,
        performSafeRebalance: async () => ({ aborted: true, actions: [] }),
        updateOrdersOnChainBatch: async () => ({ executed: false }),
    };
    manager.performSafeRebalance = bot.performSafeRebalance;
    manager._gapEvacStreaks.set('slot-72', 2);

    manager.boundaryIdx = null;
    const noBoundary = scheduleGapEvacRepair(bot, 'test');
    assert.strictEqual(noBoundary.scheduled, false, 'no boundary => no repair');
    assert.strictEqual(bot._postRecoveryRebalanceTimer, null, 'no re-plan timer with unknown geometry');
    assert.strictEqual(manager._gapEvacStreaks.get('slot-72'), 2, 'unknown boundary must not clear the ledger');

    manager.boundaryIdx = 71;
    manager._gapSlots = null;
    manager._genesis = null;
    const noGap = scheduleGapEvacRepair(bot, 'test');
    assert.strictEqual(noGap.scheduled, false, 'no known band width => no repair');
    assert.strictEqual(manager._gapEvacStreaks.get('slot-72'), 2, 'unknown gap must not clear the ledger');
}

// ── 3. _logBoundaryDebug honesty ────────────────────────────────────────

function testBoundaryDebugUsesConfigGapBeforeTheLoaderPublishesIt() {
    // Fresh manager: _gapSlots not yet assigned, spread count not yet measured.
    // This is exactly the state loadGrid's restore call runs in.
    const config = {
        incrementPercent: 0.4,
        targetSpreadPercent: 2,
        startPrice: 0.43,
        coreOrders: { buy: 20, sell: 20 },
    };
    const manager = new OrderManager(config, null);
    manager.orders = masterGrid([
        ...Array.from({ length: 20 }, (_, i) => slot(54 + i, ORDER_TYPES.BUY)),
        ...Array.from({ length: 20 }, (_, i) => slot(76 + i, ORDER_TYPES.SELL)),
    ]);
    manager._gapSlots = null;
    const lines = [];
    manager.logger = { log: (msg) => lines.push(msg) };

    manager._restoreBoundary(71);

    const line = lines.find((l) => l.includes('[BOUNDARY] restore'));
    assert.ok(line, 'the restore debug line must be emitted');
    const expectedGap = calculateGapSlots(0.4, 2);
    assert.strictEqual(expectedGap, 4, 'the test geometry expects a 4-slot band');
    assert.ok(
        line.includes(`gapSlots=${expectedGap}`),
        `restore must report the config-derived gap (got: ${line})`
    );
    assert.ok(
        line.includes(`sellStart=${71 + 1 + expectedGap}`),
        `restore must report the real sell start (got: ${line})`
    );
    assert.ok(
        line.includes('spreadCount=?'),
        `an unmeasured spread count must print '?', not 0 (got: ${line})`
    );

    // Once the grid is loaded the measured value takes over. A genuinely EMPTY
    // band (spreadCount 0) is still a measurement, not an unknown.
    manager._gapSlots = expectedGap;
    manager.initialSpreadCount = 0;
    manager.currentSpreadCount = 0;
    manager._spreadCountKnown = true;
    lines.length = 0;
    manager._restoreBoundary(71);
    const emptyBand = lines.find((l) => l.includes('[BOUNDARY] restore'));
    assert.ok(emptyBand.includes('spreadCount=0'), `a measured empty band must print 0 (got: ${emptyBand})`);

    manager.initialSpreadCount = expectedGap;
    manager.currentSpreadCount = 2;
    lines.length = 0;
    manager._restoreBoundary(71);
    const measured = lines.find((l) => l.includes('[BOUNDARY] restore'));
    assert.ok(measured.includes('spreadCount=2'), `measured spread count must be reported (got: ${measured})`);
}

// ── runner ──────────────────────────────────────────────────────────────

const tests = [
    ['liveRailsConflictWithGap detects the stranded retreat', testRailConflictDetectsTheStrandedRetreat],
    ['liveRailsConflictWithGap stays quiet for the bid-edge class', testRailConflictStaysQuietForTheBidEdgeClass],
    ['liveRailsConflictWithGap fails closed on unknown geometry', testRailConflictFailsClosedOnUnknownOrOneSidedGeometry],
    ['scheduleGapEvacRepair schedules a repair for stranded orders', testSweepSchedulesRepairForStrandedOrders],
    ['scheduleGapEvacRepair is silent on a healthy band', testSweepIsSilentAndClearsStreaksOnAHealthyBand],
    ['scheduleGapEvacRepair honours the repair cooldown', testSweepHonoursTheRepairCooldown],
    ['scheduleGapEvacRepair prefers the re-plan and falls back to the teeth', testSweepPrefersTheReplanAndFallsBackToTheTeeth],
    ['scheduleGapEvacRepair treats unknown geometry as unknown', testSweepTreatsUnknownGeometryAsUnknown],
    ['forcedRetreatJustifiesEvacuation requires an evaluable stamp', testForcedRetreatRequiresAnEvaluableStamp],
    ['pre-batch drain holds cancels the batch rotates', testDrainHoldsCancelsTheBatchRotates],
    ['_logBoundaryDebug reports config gap and unmeasured spread count', testBoundaryDebugUsesConfigGapBeforeTheLoaderPublishesIt],
];

let failed = 0;
for (const [name, fn] of tests as Array<[string, () => void]>) {
    try {
        fn();
        console.log(`✓ ${name}`);
    } catch (err) {
        failed++;
        const detail = err instanceof Error ? (err.stack || err.message) : String(err);
        console.error(`✗ ${name}`);
        console.error(detail);
    }
}

if (failed > 0) {
    console.error(`\n${failed}/${tests.length} gap-evac spread-collapse test(s) failed`);
    process.exit(1);
}
console.log(`\nAll ${tests.length} gap-evac spread-collapse tests passed`);

/**
 * tests/test_grid_update_blockers.ts
 *
 * P1 gates for the fill pipeline: one fail-closed blocking decision.
 *
 * Before this, "may the grid update now?" was answered by `hasUnsettledFills`,
 * which peeked four raw fields and returned `{unsettled: false}` on ANY throw —
 * a fail-OPEN answer in a fail-closed system. Three sites then composed it with
 * their own extra conditions.
 *
 * Pinned here:
 *   - the reason set is a closed list of codes (no prose),
 *   - an unreadable pipeline state is `unknown-blocker`, never "settled",
 *   - `hasUnsettledFills` is only a projection (same answer, no second rule),
 *   - escalation is a cycle counter that fires ONLY for unreadable state.
 */

const assert = require('assert');
const { TIMING, FILL_PROCESSING } = require('../modules/constants');
const {
    resolveGridUpdateBlockers,
    noteGridUpdateBlockers,
    readFillPipelineState,
    hasUnsettledFills,
} = require('../modules/order/utils/system');

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

function codesOf(source: unknown, now = 1_000_000) {
    return resolveGridUpdateBlockers(source, { now }).map((b: { code: string }) => b.code);
}

function testSettledIsSilent() {
    console.log('\n[1] A settled pipeline reports nothing');
    const bot = { _incomingFillQueue: [], manager: { _pendingFillCrawls: [], _fillBatchInFlight: 0 } };
    check('no blockers', codesOf(bot), []);
    check('hasUnsettledFills agrees', hasUnsettledFills(bot), { unsettled: false, reason: null });
}

function testEachFillCode() {
    console.log('\n[2] Each fill counter maps to its own code');
    check('queued', codesOf({ _incomingFillQueue: [1, 2], manager: {} }), ['fill-queued']);
    check('deferred', codesOf({ _deferredFillsPending: true, manager: {} }), ['fill-deferred']);
    check('in flight', codesOf({ manager: { _fillBatchInFlight: 2 } }), ['fill-in-flight']);
    check('owed crawl', codesOf({ manager: { _pendingFillCrawls: [{ slotId: 'slot-1' }] } }), ['crawl-owed']);
}

function testUnreadableIsBlocked() {
    console.log('\n[3] An unreadable pipeline state is unknown, never settled');
    // Wrong shape: a queue that is no longer a list.
    const wrongShape = { _incomingFillQueue: { length: 5 }, manager: {} };
    check('wrong shape reports unknown-blocker', codesOf(wrongShape), ['unknown-blocker']);
    check('state says unreadable', readFillPipelineState(wrongShape).ok, false);
    check('hasUnsettledFills fails closed', hasUnsettledFills(wrongShape).unsettled, true);

    // A throwing getter is the live shape of "the read itself blew up".
    const throwing = {
        get _incomingFillQueue(): never { throw new Error('field exploded'); },
        manager: {},
    };
    check('throwing read reports unknown-blocker', codesOf(throwing), ['unknown-blocker']);
    check('unsettled reason names the failure', /field exploded/.test(String(hasUnsettledFills(throwing).reason)), true);

    // Wrong-typed in-flight counter cannot be read as 0.
    const badInFlight = { manager: { _fillBatchInFlight: 'not-a-number' } };
    check('unparseable in-flight is unknown', codesOf(badInFlight), ['unknown-blocker']);
}

function testHostBlockers() {
    console.log('\n[4] Host-state blockers keep their own codes');
    const placement = { manager: { isPlacementActive: () => true, placementKind: () => 'cow-broadcast' } };
    check('placement held', codesOf(placement), ['placement-held']);
    const rebuild = { manager: { isStructuralRebuildInProgress: () => true } };
    check('rebuild active', codesOf(rebuild), ['rebuild-active']);
    const pending = {
        manager: {
            _pendingBroadcasts: new Map([['fp-1', { recordedAt: 1_000_000, slotId: 'slot-1' }]]),
            _lastSyncAt: 0,
        },
    };
    check('unresolved broadcast', codesOf(pending), ['broadcast-pending']);
    const throwingProbe = {
        manager: { get isPlacementActive(): never { throw new Error('probe exploded'); } },
    };
    check('a throwing host probe is unknown, not silent', codesOf(throwingProbe), ['unknown-blocker']);
}

function testProjectionHasNoSecondRule() {
    console.log('\n[5] hasUnsettledFills is a projection, not a second rule');
    // Every code that hasUnsettledFills reports must be one the resolver produced.
    const cases = [
        { _incomingFillQueue: [1], manager: {} },
        { manager: { _pendingFillCrawls: [{}] } },
        { _incomingFillQueue: 42, manager: {} },
    ];
    for (const source of cases) {
        const projection = hasUnsettledFills(source);
        const hasFillCode = resolveGridUpdateBlockers(source, { now: 1_000_000 })
            .some((b: { code: string }) => b.code.startsWith('fill-') || b.code === 'crawl-owed' || b.code === 'unknown-blocker');
        check(`projection agrees with the codes (${JSON.stringify(source)})`, projection.unsettled, hasFillCode);
    }
    check('reason is the code detail (no separate sentence)', hasUnsettledFills({ manager: { _fillBatchInFlight: 1 } }).reason, 'fill batch in flight');
}

function testEscalation() {
    console.log('\n[6] Escalation counts cycles and fires only for unreadable state');
    const bot: Record<string, unknown> = { manager: {} };
    const unreadable = [{ code: 'unknown-blocker', detail: 'boom' }];
    const busy = [{ code: 'fill-in-flight', detail: 'fill batch in flight' }];

    check('first unreadable cycle does not escalate', noteGridUpdateBlockers(bot, unreadable, { limit: 2 }), { cycles: 1, escalate: false });
    check('second consecutive cycle escalates', noteGridUpdateBlockers(bot, unreadable, { limit: 2 }), { cycles: 2, escalate: true });
    check('a busy cycle resets the counter', noteGridUpdateBlockers(bot, busy, { limit: 2 }), { cycles: 0, escalate: false });
    check('two consecutive busy cycles never escalate', (() => {
        noteGridUpdateBlockers(bot, busy, { limit: 2 });
        return noteGridUpdateBlockers(bot, busy, { limit: 2 });
    })(), { cycles: 0, escalate: false });
    check('clearing resets', noteGridUpdateBlockers(bot, [], { limit: 2 }), { cycles: 0, escalate: false });

    // Counter-based, not a TIMING window: it must not appear in either place.
    check('not a TIMING knob', (TIMING as unknown as Record<string, unknown>).GRID_BLOCKED_ESCALATE_CYCLES, undefined);
    check('limit is declared under FILL_PROCESSING', Number.isFinite(Number((FILL_PROCESSING as unknown as Record<string, unknown>).GRID_BLOCKED_ESCALATE_CYCLES)), true);
}

function run() {
    console.log('Grid update blocker tests');
    testSettledIsSilent();
    testEachFillCode();
    testUnreadableIsBlocked();
    testHostBlockers();
    testProjectionHasNoSecondRule();
    testEscalation();
    if (failures > 0) {
        console.error(`\n❌ ${failures} grid-blocker assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All grid-blocker assertions passed');
}

run();

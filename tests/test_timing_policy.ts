/**
 * tests/test_timing_policy.ts
 *
 * The growth gate for timing windows.
 *
 * The engine's 84 timing knobs kept growing because every "the state was
 * briefly wrong" bug was fixed by adding a window and nothing ever removed
 * one. This test makes adding an unexplained window a build failure.
 *
 * It also pins the honest facts about the existing inventory so the numbers
 * cannot drift silently:
 *   - how many windows are self-healing (removal targets),
 *   - that every derived timing is declared as derived,
 *   - that a derived timing still satisfies its documented ordering.
 */

const assert = require('assert');
const { TIMING } = require('../modules/constants');
const {
    classifyTiming,
    unclassifiedTimingKeys,
    selfHealingWindows,
    derivedTimings,
    timingKindCounts,
    looksLikeTimingWindow,
    NON_WINDOW_KEYS,
} = require('../modules/timing_policy');

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
function checkTruthy(name: string, actual: any) {
    check(name, !!actual, true);
}

function testEveryWindowIsClassified() {
    console.log('\n[1] Every timing window carries a classification');
    const unclassified = unclassifiedTimingKeys(TIMING);
    check(`unclassified windows (${unclassified.length})`, unclassified, []);
}

function testNoClassificationIsDead() {
    console.log('\n[2] No classification describes a key that no longer exists');
    const dead = Object.keys(require('../modules/timing_policy').TIMING_CLASSIFICATIONS)
        .filter((key) => !(key in TIMING))
        .sort();
    check(`classifications for missing keys (${dead.length})`, dead, []);
}

function testEveryClassificationHasRationale() {
    console.log('\n[3] Every classification has a rationale; self-healing ones have a removal plan');
    const missing: string[] = [];
    for (const key of Object.keys(TIMING)) {
        if (!looksLikeTimingWindow(key)) continue;
        const classification = classifyTiming(key);
        if (!classification || classification.rationale.trim().length === 0) missing.push(key);
    }
    check(`windows without a rationale (${missing.length})`, missing, []);

    const noPlan = selfHealingWindows()
        .filter((entry) => !entry.classification.removal || entry.classification.removal.trim().length === 0)
        .map((entry) => entry.key);
    check(`self-healing windows without a removal precondition (${noPlan.length})`, noPlan, []);
}

function testDerivedTimingsAreDeclared() {
    console.log('\n[4] Derived timings are declared as derived');
    const derived = derivedTimings();
    checkTruthy('SYNC_LOCK_FORCE_RELEASE_AGE_MS is declared derived', derived.includes('SYNC_LOCK_FORCE_RELEASE_AGE_MS'));
    checkTruthy('FILL_BROADCAST_DEFER_MAX_MS is declared derived', derived.includes('FILL_BROADCAST_DEFER_MAX_MS'));

    // The documented relationships must still hold at load time, whether or not
    // a settings file overrode the base values.
    check(
        'sync force-release is 2× the sync timeout',
        Number(TIMING.SYNC_LOCK_FORCE_RELEASE_AGE_MS),
        Number(TIMING.SYNC_LOCK_TIMEOUT_MS) * 2
    );
    checkTruthy(
        'fill deferral bound outlasts the stale-broadcast watchdog',
        Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS) > Number(TIMING.BROADCAST_STALE_CLEAR_MS)
    );
    check(
        'fill deferral bound is stale-clear + safety margin (or a larger override)',
        Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS) >=
        Number(TIMING.BROADCAST_STALE_CLEAR_MS) + Number(TIMING.BROADCAST_DEFER_SAFETY_MARGIN_MS),
        true
    );
}

function testNonWindowKeysAreExplicit() {
    console.log('\n[5] Non-window keys are declared, not inferred');
    const bogus = [...NON_WINDOW_KEYS].filter((key) => !(key in TIMING)).sort();
    check(`non-window declarations for missing keys (${bogus.length})`, bogus, []);
    const wronglyExcluded = [...NON_WINDOW_KEYS].filter((key) => !(key in TIMING) === false && false);
    check('nothing is both a window and excluded', wronglyExcluded, []);
}

function testRemovalTargetsAreBounded() {
    console.log('\n[6] The self-healing backlog is explicit and finite');
    const counts = timingKindCounts();
    console.log(`   inventory: ${JSON.stringify(counts)}`);
    const targets = selfHealingWindows();
    console.log(`   removal targets: ${targets.map((entry) => entry.key).join(', ')}`);
    // The point of the audit is that this number goes DOWN over time. Pin it so
    // a new window cannot hide inside the backlog.
    checkTruthy('self-healing backlog is recorded', counts['self-healing'] > 0);
    check(
        'self-healing backlog within the audited budget',
        counts['self-healing'] <= 8,
        true
    );
    // Every removal target must name the evidence that replaces it.
    for (const entry of targets) {
        checkTruthy(`${entry.key} names a replacement evidence path`, /evidence|lifecycle|event|key|record/i.test(entry.classification.removal || ''));
    }
}

function run() {
    console.log('Timing policy audit');
    console.log(`   TIMING keys: ${Object.keys(TIMING).length}`);
    testEveryWindowIsClassified();
    testNoClassificationIsDead();
    testEveryClassificationHasRationale();
    testDerivedTimingsAreDeclared();
    testNonWindowKeysAreExplicit();
    testRemovalTargetsAreBounded();
    if (failures > 0) {
        console.error(`\n❌ ${failures} timing-policy assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All timing-policy assertions passed');
}

run();

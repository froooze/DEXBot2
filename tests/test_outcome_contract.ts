/**
 * tests/test_outcome_contract.ts
 *
 * Pins the three-valued outcome vocabulary (modules/outcome.ts).
 *
 * The bug class: `uncertain` and `ambiguousRead` were two independent ad-hoc
 * flags describing the same fact, set by hand at four sites. They could
 * disagree, and no consumer was forced to handle "we do not know" at all.
 * Now one factory derives both from a single `cause`.
 */

const assert = require('assert');
const { unknownOutcome, unknownCowOutcome } = require('../modules/outcome');

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

function testUnknownOutcomeShape() {
    console.log('\n[1] Outcome<T> gives the third case a name');
    const outcome = unknownOutcome('ambiguous-read');
    check('kind discriminates', outcome.kind, 'unknown');
    check('cause is required', outcome.cause, 'ambiguous-read');
    check('no detail when none given', 'detail' in outcome, false);
    check('detail carried when given', (unknownOutcome('unavailable', 'no rpc') as any).detail, 'no rpc');
    // Every cause must be expressible; a bare `uncertain: true` could not say why.
    for (const cause of ['timeout', 'ambiguous-read', 'lost-receipt', 'unavailable']) {
        check(`cause ${cause} round-trips`, unknownOutcome(cause as any).cause, cause);
    }
}

function testCowFlagsCannotDisagree() {
    console.log('\n[2] COW legacy flags are derived, never set');
    for (const cause of ['timeout', 'ambiguous-read', 'lost-receipt', 'unavailable']) {
        const result = unknownCowOutcome(cause as any);
        check(`${cause}: uncertain is true`, result.uncertain, true);
        check(`${cause}: ambiguousRead matches cause`, result.ambiguousRead, cause === 'ambiguous-read');
        check(`${cause}: kind`, result.kind, 'unknown');
        check(`${cause}: cause preserved`, result.cause, cause);
        check(`${cause}: not executed`, result.executed, false);
        check(`${cause}: no rotation`, result.hadRotation, false);
    }
}

function testExtraFieldsCannotOverrideCanonicalFlags() {
    console.log('\n[3] Extra fields cannot corrupt the canonical flags');
    const result = unknownCowOutcome('ambiguous-read', {
        adoptedCount: 3,
        // A caller trying to disagree with `cause` must lose.
        uncertain: false,
        ambiguousRead: false,
        kind: 'applied',
        cause: 'timeout',
    });
    check('adoptedCount merged', (result as any).adoptedCount, 3);
    check('uncertain stays true', result.uncertain, true);
    check('ambiguousRead stays derived from the argument', result.ambiguousRead, true);
    check('kind stays unknown', result.kind, 'unknown');
    check('cause stays the argument', result.cause, 'ambiguous-read');
}

function testLegacyReadersStillWork() {
    console.log('\n[4] Legacy readers keep working');
    const result = unknownCowOutcome('timeout');
    // These are the exact predicates the maintenance runtime uses.
    check('`if (result.uncertain)` still fires', !!result.uncertain, true);
    check('`if (result.ambiguousRead)` is false for a timeout', !!result.ambiguousRead, false);
    check('`if (result.executed)` is false', !!result.executed, false);
}

function run() {
    console.log('Outcome contract tests');
    testUnknownOutcomeShape();
    testCowFlagsCannotDisagree();
    testExtraFieldsCannotOverrideCanonicalFlags();
    testLegacyReadersStillWork();
    if (failures > 0) {
        console.error(`\n❌ ${failures} outcome assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All outcome assertions passed');
}

run();

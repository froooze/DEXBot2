/**
 * SAME-LEVEL RE-FILL DETECTION in the offline checker (§9.12/P2 + §0 ground
 * truth "equal is a violation — a re-place at the just-filled level").
 *
 * The checker now judges same-level re-fills with the runtime's OWN
 * pricesWithinHalfStep predicate (exactly what isLastFillPlacementBlocked
 * applies) instead of a float-exact compare. Realized fill prices of one
 * re-placed level differ by sub-sat rounding dust, so the old float compare
 * passed a loop that re-placed at the IDENTICAL level 5 times in 2.5 minutes
 * (live 2026-11-16, one premium spread slot ~1557 on a market-pair bot).
 *
 * Pinned here:
 *   SL-1  A dust "rise" between two different orders is flagged (sameLevel).
 *   SL-2  A genuine ladder-level rise is NOT flagged.
 *   SL-3  An exact-equal re-place stays a violation (direction rule), now
 *         tagged sameLevel for reporting.
 *   SL-4  Consecutive fills of the SAME order are skipped (one working order).
 *   SL-5  The BUY side: a same-level dust "rise" is a direction violation
 *         (BUY >= pivot) and is tagged sameLevel.
 *   SL-6  Cross-side transitions are never same-level candidates.
 *   SL-7  The live cluster shape: 5 distinct orders at one level => 4
 *         same-level violations.
 *   SL-8  Policy-aware mirror: a same-level candidate with a fresh refusal
 *         marker in the runtime log is a VIOLATION (the amended gate would
 *         have blocked it); without the marker it is a policy divergence.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    detectViolations,
    applyRuntimeMirror,
    exportJson,
    exportCsv,
} = require('../analysis/grid_correction_check');

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

const INC = 0.3; // live market-pair increment

function fill(seq: number, time: string, direction: 'buy' | 'sell', price: number, orderId: string) {
    return {
        time, orderId, direction,
        baseAsset: '1.3.9999', quoteAsset: '1.3.0',
        baseAmount: 1, quoteAmount: price, price,
        isMaker: true, sequence: seq
    };
}

// ── 1. Detection ──────────────────────────────────────────────────────────────

run('SL-1 a sub-sat dust "rise" between two orders is a same-level violation', () => {
    const items = [
        fill(1, '2026-11-16T14:15:54Z', 'sell', 1557.1050840, '1.7.576470799'),
        fill(2, '2026-11-16T14:16:18Z', 'sell', 1557.1050856, '1.7.576470829'),
    ];
    const { violations, checkedTransitions } = detectViolations(items as any, false, INC);
    assert.strictEqual(checkedTransitions, 1);
    assert.strictEqual(violations.length, 1, 'the dust rise must not escape as a "pass"');
    assert.strictEqual(violations[0].sameLevel, true);
});

run('SL-2 a genuine ladder-level rise is not flagged', () => {
    const items = [
        fill(1, '2026-11-16T14:15:54Z', 'sell', 1557.105084, '1.7.576470799'),
        fill(2, '2026-11-16T14:18:18Z', 'sell', 1575.87, '1.7.576470798'),
    ];
    const { violations } = detectViolations(items as any, false, INC);
    assert.strictEqual(violations.length, 0, 'a real next-level sell is legitimate');
});

run('SL-3 an exact-equal re-place stays a violation, now tagged sameLevel', () => {
    const items = [
        fill(1, '2026-11-16T14:15:54Z', 'sell', 1557.105084, '1.7.576470799'),
        fill(2, '2026-11-16T14:16:18Z', 'sell', 1557.105084, '1.7.576470829'),
    ];
    const { violations } = detectViolations(items as any, false, INC);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].sameLevel, true);
    assert.ok(violations[0].expected.includes('last fill'), 'the direction rule catches the exact-equal case');
});

run('SL-4 consecutive fills of the SAME order are skipped', () => {
    const items = [
        fill(1, '2026-11-16T14:15:54Z', 'sell', 1557.1050840, '1.7.576470799'),
        fill(2, '2026-11-16T14:15:54Z', 'sell', 1557.1050841, '1.7.576470799'),
    ];
    const { violations, checkedTransitions } = detectViolations(items as any, false, INC);
    assert.strictEqual(checkedTransitions, 0, 'one order splitting across fills is not a transition');
    assert.strictEqual(violations.length, 0);
});

run('SL-5 the BUY side: a same-level dust rise is a direction violation tagged sameLevel', () => {
    const items = [
        fill(1, '2026-11-16T14:07:12Z', 'buy', 1502.142776, '1.7.576435368'),
        fill(2, '2026-11-16T14:07:15Z', 'buy', 1502.142778, '1.7.576435369'),
    ];
    const { violations } = detectViolations(items as any, false, INC);
    assert.strictEqual(violations.length, 1, 'BUY >= pivot is blocked by the direction rule');
    assert.strictEqual(violations[0].sameLevel, true);
});

run('SL-6 cross-side transitions are never same-level candidates', () => {
    const items = [
        fill(1, '2026-11-16T14:07:12Z', 'buy', 1502.142776, '1.7.576435368'),
        fill(2, '2026-11-16T14:07:18Z', 'sell', 1502.142776, '1.7.576455168'),
    ];
    const { violations } = detectViolations(items as any, false, INC);
    assert.strictEqual(violations.length, 1, 'a sell AT the just-bought price is blocked by the direction rule (<=)');
    assert.strictEqual(violations[0].sameLevel, undefined, 'but it is not a same-level candidate (cross-side)');
});

run('SL-7 the live cluster shape: 5 distinct orders at one level => 4 same-level violations', () => {
    const items = [
        fill(1, '2026-11-16T14:15:54Z', 'sell', 1557.1050840, '1.7.576470799'),
        fill(2, '2026-11-16T14:16:18Z', 'sell', 1557.1050856, '1.7.576470829'),
        fill(3, '2026-11-16T14:17:45Z', 'sell', 1557.1050858, '1.7.576470879'),
        fill(4, '2026-11-16T14:17:57Z', 'sell', 1557.1050875, '1.7.576470887'),
        fill(5, '2026-11-16T14:18:18Z', 'sell', 1557.1050888, '1.7.576470895'),
    ];
    const { violations } = detectViolations(items as any, false, INC);
    assert.strictEqual(violations.length, 4, 'every same-order transition must be flagged');
    assert.ok(violations.every(v => v.sameLevel === true));
});

// ── 2. Policy-aware mirror classification ─────────────────────────────────────

function writeLog(lines: string[]): string {
    const p = path.join('/tmp/opencode', `sl-refusal-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
}

function dustClusterViolation(): any {
    return detectViolations([
        fill(1, '2026-11-16T14:15:54Z', 'sell', 1557.1050840, '1.7.576470799'),
        fill(2, '2026-11-16T14:16:18Z', 'sell', 1557.1050856, '1.7.576470829'),
    ] as any, false, INC).violations[0];
}

run('SL-8 a same-level re-fill under a fresh refusal marker is a VIOLATION (amended gate)', () => {
    const log = writeLog([
        '[2026-11-16T14:15:54.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1502.1427(buy) buy=1502.1427 sell=1557.105088 n=1 src=full/direct',
        '[2026-11-16T14:15:54.000Z] [WARN] [DEXBot] [LAST-FILL-GUARD] Refusing to arm pivot 1557.105084(sell): it priced 10 grid step(s) away from the live market 1513.412157925161 — a premium sweep of our own rail, not a window trade; the guard stays as-is and spread correction keeps trading around the live market; the just-filled level stays blocked as a same-level re-fill for 30m',
    ]);
    const mirror = applyRuntimeMirror([dustClusterViolation()], log, INC);
    assert.strictEqual(mirror.logError, null);
    assert.strictEqual(mirror.kept.length, 1, 'the amended runtime would have blocked this re-placement — it filled anyway');
    assert.strictEqual(mirror.divergences.length, 0);
    assert.strictEqual(mirror.kept[0].sameLevel, true);
    fs.unlinkSync(log);
});

run('SL-9 a same-level re-fill WITHOUT refusal evidence is a policy divergence', () => {
    const log = writeLog([
        '[2026-11-16T14:15:54.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1502.1427(buy) buy=1502.1427 sell=1557.105088 n=1 src=full/direct',
        '[2026-11-16T14:16:09.000Z] [DEBUG] [DEXBot] [LAST-FILL-GUARD] mode=per-order pivot=1502.1427(buy) checked=16 passed=16',
        '[2026-11-16T14:16:10.000Z] [INFO] [DEXBot] Placed sell order slot-166 @1557.105084 x1.31590000 -> 1.7.576470829',
        '[2026-11-16T14:16:12.000Z] [DEBUG] [DEXBot] [LAST-FILL-GUARD] mode=per-order pivot=1502.1427(buy) checked=16 passed=16',
    ]);
    const mirror = applyRuntimeMirror([dustClusterViolation()], log, INC);
    assert.strictEqual(mirror.logError, null);
    assert.strictEqual(mirror.divergences.length, 1, 'the runtime pivot (older, lower) legally passed it');
    assert.strictEqual(mirror.kept.length, 0);
    assert.strictEqual(mirror.divergences[0].sameLevel, true, 'the divergence must be tagged sameLevel');
    assert.ok(mirror.divergences[0].anchor, 'divergence carries its placement anchor');
    assert.strictEqual(mirror.divergences[0].anchor.kind, 'placed');
    assert.strictEqual(mirror.divergences[0].pivotSelection, 'backward');
    fs.unlinkSync(log);
});

run('SL-10 a missing log falls back to strict (same-level stays a violation)', () => {
    const mirror = applyRuntimeMirror([dustClusterViolation()], '/tmp/opencode/no-such-log-file-should-exist.log', INC);
    assert.ok(mirror.logError);
    assert.strictEqual(mirror.kept.length, 1);
    assert.strictEqual(mirror.divergences.length, 0);
});

run('SL-11 a legacy forward-pivot verdict is reported as a pivot-anchor artifact (§9.14)', () => {
    const log = writeLog([
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1020.000000(sell) buy=1000.000000 sell=1020.000000 n=1 src=full/direct',
        '[2026-11-16T10:00:01.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-110 -> slot-100 (orderId=1.7.900020, size=1.00000000, price=1010.000000)',
        '[2026-11-16T10:00:02.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1020.000000(sell) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
        '[2026-11-16T10:00:03.000Z] [INFO] [DEXBot] Placed buy order slot-100 @1010.000000 x1.00000000 -> 1.7.900020',
        '[2026-11-16T10:00:04.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1005.000000(buy) buy=1005.000000 sell=1020.000000 n=1 src=full/direct',
    ]);
    const violation = detectViolations([
        fill(1, '2026-11-16T10:00:00Z', 'buy', 1000.0, '1.7.900019'),
        fill(2, '2026-11-16T10:00:10Z', 'buy', 1010.0, '1.7.900020'),
    ] as any, false, INC).violations[0];
    assert.ok(violation, 'strict candidate detected');
    const mirror = applyRuntimeMirror([violation], log, INC);
    assert.strictEqual(mirror.logError, null);
    assert.strictEqual(mirror.kept.length, 0, 'not a gate failure');
    assert.strictEqual(mirror.divergences.length, 0, 'not an ordinary divergence');
    assert.strictEqual(mirror.artifacts.length, 1, 'reclassified into its own section');
    assert.strictEqual(mirror.artifacts[0].legacyPivot.price, 1005.0);
    assert.strictEqual(mirror.artifacts[0].correctedPivot.price, 1020.0);
    assert.strictEqual(mirror.artifacts[0].anchor.kind, 'placed');
    fs.unlinkSync(log);
});

run('SL-12 an old-unverifiable FAIL entry is also reported as an artifact', () => {
    const log = writeLog([
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1020.000000(sell) buy=1000.000000 sell=1020.000000 n=1 src=full/direct',
        '[2026-11-16T10:00:01.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1020.000000(sell) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
        // No observation after the placed line: the old forward lookup found nothing.
        '[2026-11-16T10:00:03.000Z] [INFO] [DEXBot] Placed buy order slot-100 @1010.000000 x1.00000000 -> 1.7.900022',
    ]);
    const violation = detectViolations([
        fill(1, '2026-11-16T10:00:00Z', 'buy', 1000.0, '1.7.900021'),
        fill(2, '2026-11-16T10:00:10Z', 'buy', 1010.0, '1.7.900022'),
    ] as any, false, INC).violations[0];
    assert.ok(violation, 'strict candidate detected');
    const mirror = applyRuntimeMirror([violation], log, INC);
    assert.strictEqual(mirror.kept.length, 0);
    assert.strictEqual(mirror.divergences.length, 0);
    assert.strictEqual(mirror.artifacts.length, 1, 'reclassified from the old FAIL list');
    assert.strictEqual(mirror.artifacts[0].legacyPivot, null, 'old rule could not verify it');
    assert.strictEqual(mirror.artifacts[0].correctedPivot.price, 1020.0);
    fs.unlinkSync(log);
});

run('SL-13 both kept paths carry re-checkable mirror provenance', () => {
    // Marker path: the refusal event that decided the FAIL is recorded verbatim.
    const markerLog = writeLog([
        '[2026-11-16T14:15:54.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1502.1427(buy) buy=1502.1427 sell=1557.105088 n=1 src=full/direct',
        '[2026-11-16T14:15:54.000Z] [WARN] [DEXBot] [LAST-FILL-GUARD] Refusing to arm pivot 1557.105084(sell): it priced 10 grid step(s) away from the live market 1513.412157925161 — a premium sweep of our own rail, not a window trade',
    ]);
    const marked = applyRuntimeMirror([dustClusterViolation()], markerLog, INC);
    assert.strictEqual(marked.kept.length, 1);
    const mk = marked.kept[0];
    assert.strictEqual(mk.mirrorVerdict, 'violation', 'marker path is an explicit gate failure');
    assert.ok(mk.mirrorReason.includes('refusal marker'), 'reason names the marker');
    assert.ok(mk.mirrorReason.includes('1557.105084'), 'reason carries the matched refusal price');
    assert.ok(mk.mirrorReason.includes('2026-11-16T14:15:54.000Z'), 'reason carries the refusal timestamp');
    assert.strictEqual(mk.mirrorPivot, null);
    assert.strictEqual(mk.anchor, null);
    assert.strictEqual(mk.pivotSelection, null);
    fs.unlinkSync(markerLog);

    // Unverifiable path: no placement event, fail toward reporting.
    const bareLog = writeLog([
        '[2026-11-16T14:15:54.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1502.1427(buy) buy=1502.1427 sell=1557.105088 n=1 src=full/direct',
    ]);
    const v = dustClusterViolation();
    v.curr.orderId = '1.7.999999';
    const bare = applyRuntimeMirror([v], bareLog, INC);
    assert.strictEqual(bare.kept.length, 1);
    assert.strictEqual(bare.kept[0].mirrorVerdict, 'unverifiable');
    assert.ok(bare.kept[0].mirrorReason.includes('no placement event'));
    assert.strictEqual(bare.kept[0].anchor, null);
    fs.unlinkSync(bareLog);
});

run('SL-14 JSON and CSV exports carry the mirror provenance columns', () => {
    const t = Date.parse('2026-11-16T14:16:09.000Z');
    const v = {
        ...dustClusterViolation(),
        mirrorVerdict: 'violation',
        mirrorReason: 'same-level refusal marker',
        mirrorPivot: null,
        anchor: { kind: 'placed', t, price: 1557.105084, orderId: '1.7.900099' },
        pivotSelection: 'backward',
    };
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const jp = path.join('/tmp/opencode', `sl-export-${stamp}.json`);
    const cp = path.join('/tmp/opencode', `sl-export-${stamp}.csv`);
    exportJson(jp, [v], [], 'test-range', 'test-bot', 'test-account', INC);
    exportCsv(cp, [v]);
    const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    assert.deepStrictEqual(Object.keys(j.violations[0].mirror).sort(),
        ['anchor', 'pivotSelection', 'reason', 'runtimePivot', 'verdict']);
    assert.strictEqual(j.violations[0].mirror.anchor.kind, 'placed');
    assert.strictEqual(j.violations[0].mirror.pivotSelection, 'backward');
    const csv = fs.readFileSync(cp, 'utf8').split('\n');
    for (const col of ['mirror_verdict', 'mirror_reason', 'mirror_pivot', 'anchor_kind', 'anchor_time', 'pivot_selection']) {
        assert.ok(csv[0].includes(col), `CSV header has ${col}`);
    }
    assert.ok(csv[1].includes('2026-11-16T14:16:09.000Z'), 'anchor_time is ISO, not epoch ms');
    fs.unlinkSync(jp);
    fs.unlinkSync(cp);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Regression tests for the policy-aware runtime pivot mirror
 * (`analysis/pivot_timeline.ts`, retrospective §9.12 addendum).
 *
 * Background: since the pivot-arming refusals (§9.12/P1) a premium sweep of
 * the bot's own rail leaves the pivot behind the true last fill, and the
 * strict all-fills checker flagged re-quotes the runtime's own final gate had
 * legitimately passed. The mirror reconstructs the pivot the runtime ACTUALLY
 * held when a filled order was last priced and re-judges the strict candidate
 * against it.
 *
 * Contract under test (all synthetic values, no real pair/account names):
 *   - Direction rule via the runtime's own predicate: SELL <= pivot blocked,
 *     BUY >= pivot blocked (equal price blocked), permitted side free.
 *   - verdict 'policy-divergence': the runtime pivot would have passed the
 *     placement (pivot-arm refusals / allowance bypass).
 *   - verdict 'violation': the runtime's OWN pivot would have blocked it.
 *   - verdict 'unverifiable': no anchor evidence — callers keep the strict
 *     violation (fail toward reporting).
 *   - Log-format hardening (each of these was a real misclassification on a
 *     live market-pair bot before the fix):
 *       PT-K  Kibana order-id suffixes (`1.7.x:se`, `1.7.x:sell:...`) join to
 *             the log's plain `1.7.x` placement lines.
 *       PT-T  naive Kibana timestamps (no offset) are read as UTC, not host
 *             local time.
 *       PT-Q  "Pivot refreshed from N pending queued fill(s)" is NOT a pivot
 *             observation — the queue may hold exactly the fill the arming
 *             policy refused.
 *       PT-A  the placement anchor is the order event whose price matches the
 *             fill, so a fill is never judged against the pivot it armed
 *             itself via a post-fill rotation event.
 *   - Sweep replay shape: refused sweep fill between fills + re-quote below
 *     the strict last fill but above the runtime pivot => policy-divergence
 *     with refusalsInRange > 0.
 *   - §9.14 audit correction (all synthetic values):
 *       PT-11 a `placed` anchor uses the pivot at/before the commit line; the
 *             legacy forward rule (and its next-batch pivot) is reproducible.
 *       PT-12 a `plan-action` anchor still uses the forward gate lookup.
 *       PT-13 a too-distant backward pivot yields `unverifiable`, not a verdict.
 *       PT-14 a fill-pivot between the gate line and the commit does not
 *             become the anchor's pivot (gate lines are preferred).
 *       PT-15 a fill-pivot is never a fallback when no gate line exists.
 */

const assert = require('assert');
const {
    parseRuntimeLog,
    pivotAtOrBefore,
    pivotAtOrAfter,
    classifyTransition,
    PIVOT_LOOKAHEAD_MS,
} = require('../analysis/pivot_timeline');

// ─── Synthetic log fixture (values are arbitrary, on a 1000-ish ladder) ──────
const BASE_LOG = [
    '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1000.000000(buy) buy=1000.000000 sell=1003.000000 n=2 src=partial/direct',
    '[2026-11-16T10:00:01.000Z] [DEBUG] [DEXBot] [LAST-FILL-GUARD] Final gate: queue 0->0 pivot 1000.000000(buy)->1000.000000(buy) changed=false refreshed=false',
    '[2026-11-16T10:00:02.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1000.000000(buy) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=4 passed=4 skipped=0 bypassed=0',
    '[2026-11-16T10:00:03.000Z] [WARN] [DEXBot] [LAST-FILL-GUARD] Refusing to arm pivot 1030.000000(sell): it priced 10 grid step(s) away from the live market 1000.000000 — a premium sweep of our own rail, not a window trade; the guard stays as-is',
    '[2026-11-16T10:00:04.000Z] [DEBUG] [DEXBot] [LAST-FILL-GUARD] Pivot refreshed from 2 pending queued fill(s): sell @1030.000000',
    '[2026-11-16T10:00:05.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1001.000000(sell) buy=1000.000000 sell=1001.000000 n=1 src=unknown/direct',
    '[2026-11-16T10:00:06.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] Re-armed on the new generation: 1002.000000(sell)',
    '[2026-11-16T10:00:07.000Z] [INFO] [DEXBot] Placed sell order slot-101 @1003.010000 x1.00000000 -> 1.7.900001',
    '[2026-11-16T10:00:08.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-101 -> slot-99 (orderId=1.7.900001, size=1.00000000, price=999.000000)',
    '[2026-11-16T10:00:09.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] Allowing SELL 999.000000 against pivot 998.500000: within the band-exempt territory',
    '[2026-11-16T10:00:10.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] Allowing buy evacuation UPDATE for slot-80 -> slot-60 at 970.000000: stamped gap evacuation',
    '[2026-11-16T10:00:11.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1002.000000(sell) pivotSlot=101(snapped) inc=0.3% pivotRefreshed=false checked=2 passed=2 skipped=0 bypassed=0',
].join('\n');

function cand(orderId, currTime, currPrice, direction, prevTime = '2026-11-16T10:00:00.000Z', prevPrice = 1030.0) {
    return {
        prevTime,
        currTime,
        prevPrice,
        currPrice,
        direction,
        currOrderId: orderId,
    };
}

async function testParseRuntimeLog() {
    console.log('\n[PT-1] parseRuntimeLog indexes observations/refusals/placements/allowances');
    const idx = parseRuntimeLog(BASE_LOG);
    // Observations: fill-pivot(1000b), final-gate(1000b), mode(1000b),
    // fill-pivot(1001s), re-arm(1002s), mode(1002s). The queue-refresh line at
    // 10:00:04 is deliberately NOT an observation (see PT-7).
    assert.strictEqual(idx.observations.length, 6, 'observation count');
    assert.strictEqual(idx.observations[0].src, 'fill-pivot');
    assert.strictEqual(idx.observations[0].price, 1000.0);
    assert.strictEqual(idx.observations[0].type, 'buy');
    assert.strictEqual(idx.observations[4].src, 'rearm');
    assert.strictEqual(idx.observations[4].price, 1002.0);
    assert.strictEqual(idx.observations[5].src, 'mode');
    assert.strictEqual(idx.observations[5].price, 1002.0);
    assert.strictEqual(idx.refusals.length, 1, 'refusal count');
    assert.strictEqual(idx.refusals[0].price, 1030.0);
    assert.strictEqual(idx.refusals[0].type, 'sell');
    const placements = idx.placements.get('1.7.900001');
    assert.ok(placements, 'placement indexed by plain order id');
    assert.strictEqual(placements.length, 2, 'placed + plan-action events');
    assert.strictEqual(placements[0].kind, 'placed');
    assert.strictEqual(placements[0].price, 1003.01);
    assert.strictEqual(placements[1].kind, 'plan-action');
    assert.strictEqual(placements[1].price, 999.0);
    assert.strictEqual(idx.allowances.length, 2, 'against-pivot + at-price allowances');
    assert.strictEqual(idx.allowances[0].direction, 'sell');
    assert.strictEqual(idx.allowances[0].price, 999.0);
    assert.strictEqual(idx.allowances[1].direction, 'buy');
    assert.strictEqual(idx.allowances[1].price, 970.0);
    // Sorted chronologically.
    for (let i = 1; i < idx.observations.length; i++) {
        assert.ok(idx.observations[i].t >= idx.observations[i - 1].t, 'observations sorted');
    }
    console.log('✓ PT-1 passed');
}

async function testPivotLookups() {
    console.log('\n[PT-2] pivotAtOrBefore / pivotAtOrAfter binary-search windows');
    const idx = parseRuntimeLog(BASE_LOG);
    const t1002 = Date.parse('2026-11-16T10:00:06.000Z');
    const before = pivotAtOrBefore(idx.observations, t1002);
    assert.ok(before, 'latest observation at/before exists');
    assert.strictEqual(before.price, 1002.0, 'latest at-or-before wins');
    assert.strictEqual(before.src, 'rearm');

    const after = pivotAtOrAfter(idx.observations, Date.parse('2026-11-16T10:00:02.500Z'));
    assert.ok(after, 'first observation at/after exists');
    assert.strictEqual(after.price, 1001.0, 'first at-or-after wins');

    const none = pivotAtOrAfter(idx.observations, Date.parse('2026-11-16T10:00:02.500Z'), 500);
    assert.strictEqual(none, null, 'no observation within a narrow window => null');
    assert.strictEqual(pivotAtOrAfter(idx.observations, Date.parse('2026-11-16T10:00:12.000Z')), null,
        'no observation at/after a post-log timestamp => null');
    console.log('✓ PT-2 passed');
}

async function testDirectionRuleVerdicts() {
    console.log('\n[PT-3] direction rule via the runtime predicate (SELL <= pivot / BUY >= pivot blocked)');
    const idx = parseRuntimeLog(BASE_LOG);
    // Gate context: placement at 10:00:08, its batch mode= line at 10:00:09+…
    // No mode= line after 10:00:08 in BASE_LOG within the window other than
    // none — so add a dedicated fixture per case for exactness.
    const mkLog = (pivotPrice, pivotType) => [
        `[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-110 -> slot-100 (orderId=1.7.900100, size=1.00000000, price=${pivotType === 'sell' ? '1000.000000' : '1010.000000'})`,
        `[2026-11-16T10:00:01.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=${pivotPrice.toFixed(6)}(${pivotType}) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0`,
    ].join('\n');

    // SELL strictly below a SELL pivot => the runtime's own pivot blocks it.
    const v1 = classifyTransition(cand('1.7.900100', '2026-11-16T10:00:05.000Z', 995.0, 'sell'),
        parseRuntimeLog(mkLog(1000.0, 'sell')));
    assert.strictEqual(v1.verdict, 'violation', 'SELL below SELL pivot is a real gate failure');
    assert.ok(v1.pivot && v1.pivot.price === 1000.0 && v1.pivot.type === 'sell', 'pivot reported');

    // SELL equal to the pivot => same-level re-place, blocked.
    const v2 = classifyTransition(cand('1.7.900100', '2026-11-16T10:00:05.000Z', 1000.0, 'sell'),
        parseRuntimeLog(mkLog(1000.0, 'sell')));
    assert.strictEqual(v2.verdict, 'violation', 'SELL at the pivot (equal price) is blocked');

    // BUY at/above a BUY pivot => blocked (BUY must be strictly below).
    const v3 = classifyTransition(cand('1.7.900100', '2026-11-16T10:00:05.000Z', 1015.0, 'buy'),
        parseRuntimeLog(mkLog(1010.0, 'buy')));
    assert.strictEqual(v3.verdict, 'violation', 'BUY above BUY pivot is blocked');

    // BUY equal to the pivot => blocked.
    const v4 = classifyTransition(cand('1.7.900100', '2026-11-16T10:00:05.000Z', 1010.0, 'buy'),
        parseRuntimeLog(mkLog(1010.0, 'buy')));
    assert.strictEqual(v4.verdict, 'violation', 'BUY at the pivot (equal price) is blocked');

    // Permitted sides are free: SELL above the pivot, BUY below it.
    const p1 = classifyTransition(cand('1.7.900100', '2026-11-16T10:00:05.000Z', 1005.0, 'sell'),
        parseRuntimeLog(mkLog(1000.0, 'sell')));
    assert.strictEqual(p1.verdict, 'policy-divergence', 'SELL above the runtime pivot passes the gate');
    const p2 = classifyTransition(cand('1.7.900100', '2026-11-16T10:00:05.000Z', 1005.0, 'buy'),
        parseRuntimeLog(mkLog(1010.0, 'buy')));
    assert.strictEqual(p2.verdict, 'policy-divergence', 'BUY below the runtime pivot passes the gate');
    console.log('✓ PT-3 passed');
}

async function testOrderIdSuffixJoin() {
    console.log('\n[PT-4] Kibana order-id suffixes join to the log\'s plain ids');
    const idx = parseRuntimeLog(BASE_LOG);
    // Placement events exist at 10:00:07/08; the fill at 10:00:12 follows.
    const short = classifyTransition(
        cand('1.7.900001:se', '2026-11-16T10:00:12.000Z', 999.0, 'sell'),
        idx);
    const long = classifyTransition(
        cand('1.7.900001:sell:1.3.5537:1.3.0:116168365031148', '2026-11-16T10:00:12.000Z', 999.0, 'sell'),
        idx);
    assert.notStrictEqual(short.verdict, 'unverifiable', 'short suffix joins to the placement');
    assert.notStrictEqual(long.verdict, 'unverifiable', 'full Kibana suffix joins to the placement');
    assert.strictEqual(short.verdict, long.verdict, 'suffix length does not change the verdict');
    assert.ok(short.pivot, 'both resolve to the same runtime pivot');
    assert.deepStrictEqual(long.pivot, short.pivot);
    console.log('✓ PT-4 passed');
}

async function testNaiveTimestampIsUtc() {
    console.log('\n[PT-5] naive Kibana timestamps (no offset) are read as UTC');
    const idx = parseRuntimeLog(BASE_LOG);
    const withZ = classifyTransition(
        cand('1.7.900001', '2026-11-16T10:00:12.000Z', 999.0, 'sell'), idx);
    const naive = classifyTransition(
        cand('1.7.900001', '2026-11-16T10:00:12', 999.0, 'sell'), idx);
    assert.strictEqual(naive.verdict, withZ.verdict,
        'a naive timestamp must classify identically to its Z-suffixed form ' +
        '(host-local parsing would push the fill before its own placement)');
    assert.deepStrictEqual(naive.pivot, withZ.pivot);
    console.log('✓ PT-5 passed');
}

async function testPlacementAnchorPriceMatch() {
    console.log('\n[PT-6] placement anchor is price-matched (no self-armed-pivot judgement)');
    // Order re-quoted at 1005.000000, fills at 1005, and is then rotated to
    // 1002 AFTER the fill. The post-fill rotation must not become the anchor:
    // judging the fill against the pivot its own fill armed would be a
    // self-reference artifact (seen live on a market-pair bot).
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] Placed sell order slot-103 @990.000000 x1.00000000 -> 1.7.900003',
        '[2026-11-16T10:00:02.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-103 -> slot-101 (orderId=1.7.900003, size=1.00000000, price=1005.000000)',
        '[2026-11-16T10:00:10.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1000.000000(buy) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
        '[2026-11-16T10:00:20.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1005.000000(buy) buy=1005.000000 sell=1008.000000 n=1 src=partial/direct',
        '[2026-11-16T10:00:25.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-101 -> slot-99 (orderId=1.7.900003, size=1.00000000, price=1002.000000)',
        '[2026-11-16T10:00:26.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1006.000000(sell) pivotSlot=102(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
    ].join('\n');
    const idx = parseRuntimeLog(log);
    const v = classifyTransition(
        cand('1.7.900003', '2026-11-16T10:00:20.000Z', 1005.0, 'sell'), idx);
    // Anchor = the 1005.000000 re-quote (price-matched), gate pivot = 1000(buy)
    // from the batch that placed it. SELL 1005 > 1000(buy) => passed.
    assert.strictEqual(v.verdict, 'policy-divergence',
        'the fill is judged against the pivot at ITS gate, not the pivot it armed afterwards');
    assert.ok(v.pivot && v.pivot.price === 1000.0 && v.pivot.type === 'buy',
        'the pre-fill gate pivot is used');
    // Contrast: the post-fill rotation to 1002 has its own gate (1006 sell)
    // that WOULD block a 1002 sell — proving the price-matched anchor, not
    // the predicate, decided the verdict above.
    const rotated = classifyTransition(
        cand('1.7.900003', '2026-11-16T10:00:30.000Z', 1002.0, 'sell'), idx);
    assert.strictEqual(rotated.verdict, 'violation',
        'a fill of the post-fill rotation is judged against its own blocking gate');
    assert.ok(rotated.pivot && rotated.pivot.price === 1006.0 && rotated.pivot.type === 'sell');
    console.log('✓ PT-6 passed');
}

async function testQueueRefreshIsNotObservation() {
    console.log('\n[PT-7] queue-refresh line does not poison the pivot timeline');
    // The queue holds the sweep fill (1030) that the arming policy REFUSED;
    // the effective pivot stays 1000(buy). If the queue line were treated as
    // an observation, the re-quote below it would be misjudged.
    const log = [
        '[2026-11-16T10:00:00.000Z] [WARN] [DEXBot] [LAST-FILL-GUARD] Refusing to arm pivot 1030.000000(sell): it priced 10 grid step(s) away from the live market 1000.000000 — a premium sweep of our own rail, not a window trade',
        '[2026-11-16T10:00:01.000Z] [DEBUG] [DEXBot] [LAST-FILL-GUARD] Pivot refreshed from 2 pending queued fill(s): sell @1030.000000',
        '[2026-11-16T10:00:02.000Z] [DEBUG] [DEXBot] [LAST-FILL-GUARD] Final gate: queue 2->2 pivot 1000.000000(buy)->1000.000000(buy) changed=false refreshed=true',
        '[2026-11-16T10:00:02.100Z] [INFO] [DEXBot] [COW] Plan action: update slot-104 -> slot-102 (orderId=1.7.900004, size=1.00000000, price=1010.000000)',
        '[2026-11-16T10:00:03.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1000.000000(buy) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=true checked=2 passed=2 skipped=0 bypassed=0 gateChecked=2 gatePassed=2 gateSkipped=0 gateBypassed=0',
    ].join('\n');
    const idx = parseRuntimeLog(log);
    assert.strictEqual(idx.observations.length, 2, 'queue-refresh line is not an observation');
    const v = classifyTransition(
        cand('1.7.900004', '2026-11-16T10:00:10.000Z', 1010.0, 'sell'), idx);
    assert.strictEqual(v.verdict, 'policy-divergence', 'SELL above the held pivot passes');
    assert.ok(v.pivot && v.pivot.price === 1000.0 && v.pivot.type === 'buy',
        'the held pivot (not the refused queue value 1030) is used');
    console.log('✓ PT-7 passed');
}

async function testSweepReplayShape() {
    console.log('\n[PT-8] sweep replay: refused sweep fill => re-quote below it is a policy-divergence');
    // Shape of the 2026-11-16 incident: the strict last fill (1030, the bot's
    // own swept rail) is refused from arming; the pivot stays 1000(buy); a
    // re-quote at 1010 is BELOW the strict last fill but ABOVE the runtime
    // pivot, so the runtime's own gate passes it.
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1000.000000(buy) buy=1000.000000 sell=1003.000000 n=2 src=partial/direct',
        '[2026-11-16T10:00:05.000Z] [WARN] [DEXBot] [LAST-FILL-GUARD] Refusing to arm pivot 1030.000000(sell): it priced 10 grid step(s) away from the live market 1000.000000 — a premium sweep of our own rail, not a window trade',
        '[2026-11-16T10:00:06.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-105 -> slot-103 (orderId=1.7.900005, size=1.00000000, price=1010.000000)',
        '[2026-11-16T10:00:07.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1000.000000(buy) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=3 passed=3 skipped=0 bypassed=0 gateChecked=3 gatePassed=3 gateSkipped=0 gateBypassed=0',
    ].join('\n');
    const idx = parseRuntimeLog(log);
    const v = classifyTransition(
        cand('1.7.900005:se', '2026-11-16T10:00:20.000Z', 1010.0, 'sell',
            '2026-11-16T10:00:04.000Z', 1030.0), idx);
    assert.strictEqual(v.verdict, 'policy-divergence',
        'below the strict last fill but above the runtime pivot => expected under policy');
    assert.strictEqual(v.refusalsInRange, 1, 'the refusal between the fills is counted');
    assert.ok(v.pivot && v.pivot.price === 1000.0 && v.pivot.type === 'buy');
    assert.ok(v.reason.includes('refusal'), 'the reason names the refusal policy');
    console.log('✓ PT-8 passed');
}

async function testAllowanceBypass() {
    console.log('\n[PT-9] guard allowance (band-exempt / stamped evacuation) => policy-divergence');
    const idx = parseRuntimeLog(BASE_LOG);
    // SELL 999 is below a SELL pivot only if the gate pivot is a SELL above
    // 999 — BASE_LOG's observations around 10:00:08 are buy-pivots, so build
    // a dedicated fixture where the pivot would block and only the allowance
    // explains the placement.
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1005.000000(sell) buy=1000.000000 sell=1005.000000 n=1 src=partial/direct',
        '[2026-11-16T10:00:01.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-106 -> slot-104 (orderId=1.7.900006, size=1.00000000, price=999.000000)',
        '[2026-11-16T10:00:02.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1005.000000(sell) pivotSlot=103(snapped) inc=0.3% pivotRefreshed=false checked=2 passed=1 skipped=0 bypassed=1 gateChecked=1 gatePassed=0 gateSkipped=0 gateBypassed=1',
    ].join('\n');
    const bare = classifyTransition(
        cand('1.7.900006', '2026-11-16T10:00:10.000Z', 999.0, 'sell'),
        parseRuntimeLog(log));
    assert.strictEqual(bare.verdict, 'violation',
        'without the allowance line the below-pivot SELL is a real gate failure');
    const withAllowance = parseRuntimeLog(log +
        '\n[2026-11-16T10:00:02.000Z] [DEBUG] [DEXBot] [LAST-FILL-GUARD] Allowing SELL 999.000000 against pivot 1005.000000: band-exempt');
    const excused = classifyTransition(
        cand('1.7.900006', '2026-11-16T10:00:10.000Z', 999.0, 'sell'), withAllowance);
    assert.strictEqual(excused.verdict, 'policy-divergence',
        'a logged guard allowance at the gate excuses the below-pivot placement');
    assert.ok(excused.reason.includes('allowance'), 'the reason names the allowance');
    console.log('✓ PT-9 passed');
}

async function testUnverifiableFailsTowardReporting() {
    console.log('\n[PT-10] unverifiable candidates stay violation-class (fail toward reporting)');
    const idx = parseRuntimeLog(BASE_LOG);
    const v1 = classifyTransition(
        cand('1.7.999999', '2026-11-16T10:00:12.000Z', 999.0, 'sell'), idx);
    assert.strictEqual(v1.verdict, 'unverifiable', 'unknown order id => no placement anchor');
    assert.ok(v1.reason.includes('no placement event'));
    assert.strictEqual(v1.pivot, null);

    const v2 = classifyTransition(
        cand('1.7.900001', '2026-11-16T09:00:00.000Z', 999.0, 'sell'), idx);
    assert.strictEqual(v2.verdict, 'unverifiable', 'fill before any placement => unverifiable');

    const v3 = classifyTransition(
        cand('1.7.900001', 'not-a-timestamp', 999.0, 'sell'), idx);
    assert.strictEqual(v3.verdict, 'unverifiable', 'unparseable timestamp => unverifiable');
    console.log('✓ PT-10 passed');
}

async function testSourceAwarePivotAnchoring() {
    console.log('\n[PT-11] placed anchors use the pre-commit pivot (§9.14 audit correction)');
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1020.000000(sell) buy=1000.000000 sell=1020.000000 n=1 src=full/direct',
        '[2026-11-16T10:00:01.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-110 -> slot-100 (orderId=1.7.900010, size=1.00000000, price=1010.000000)',
        '[2026-11-16T10:00:02.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1020.000000(sell) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
        '[2026-11-16T10:00:03.000Z] [INFO] [DEXBot] Placed buy order slot-100 @1010.000000 x1.00000000 -> 1.7.900010',
        '[2026-11-16T10:00:04.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1005.000000(buy) buy=1005.000000 sell=1020.000000 n=1 src=full/direct',
    ].join('\n');
    const idx = parseRuntimeLog(log);
    const c = cand('1.7.900010', '2026-11-16T10:00:10.000Z', 1010.0, 'buy',
        '2026-11-16T10:00:00.000Z', 1000.0);
    const fixed = classifyTransition(c, idx);
    const legacy = classifyTransition(c, idx, { pivotRule: 'forward' });
    assert.ok(fixed.anchor, 'anchor reported');
    assert.strictEqual(fixed.anchor.kind, 'placed', 'latest price-matched event is the commit line');
    assert.strictEqual(fixed.pivotSelection, 'backward');
    assert.strictEqual(fixed.verdict, 'policy-divergence', 'the held SELL pivot passes this BUY');
    assert.ok(fixed.pivot && fixed.pivot.price === 1020.0 && fixed.pivot.type === 'sell');
    assert.strictEqual(fixed.pivot.src, 'mode', 'pivot provenance reported');
    assert.strictEqual(legacy.verdict, 'violation', 'the old rule judged it against the next batch');
    assert.ok(legacy.pivot && legacy.pivot.price === 1005.0, 'legacy pivot is the later BUY pivot');
    assert.strictEqual(legacy.pivot.src, 'fill-pivot');
    assert.strictEqual(legacy.pivotSelection, 'forward');
    console.log('✓ PT-11 passed');
}

async function testPlanActionStillUsesForwardLookup() {
    console.log('\n[PT-12] plan-action anchors keep the forward gate lookup');
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1020.000000(sell) buy=1000.000000 sell=1020.000000 n=1 src=full/direct',
        '[2026-11-16T10:00:01.000Z] [INFO] [DEXBot] [COW] Plan action: update slot-110 -> slot-100 (orderId=1.7.900012, size=1.00000000, price=1010.000000)',
        '[2026-11-16T10:00:02.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1020.000000(sell) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
    ].join('\n');
    const idx = parseRuntimeLog(log);
    const c = cand('1.7.900012', '2026-11-16T10:00:10.000Z', 1010.0, 'buy',
        '2026-11-16T10:00:00.000Z', 1000.0);
    const fixed = classifyTransition(c, idx);
    const legacy = classifyTransition(c, idx, { pivotRule: 'forward' });
    assert.strictEqual(fixed.anchor.kind, 'plan-action');
    assert.strictEqual(fixed.pivotSelection, 'forward');
    assert.strictEqual(fixed.verdict, legacy.verdict, 'the rule does not change plan-action verdicts');
    assert.deepStrictEqual(fixed.pivot, legacy.pivot);
    console.log('✓ PT-12 passed');
}

async function testStaleBackwardPivotIsUnverifiable() {
    console.log('\n[PT-13] a too-distant pre-commit pivot is unverifiable, not a verdict');
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1000.000000(buy) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
        '[2026-11-16T10:03:00.000Z] [INFO] [DEXBot] Placed sell order slot-101 @1010.000000 x1.00000000 -> 1.7.900014',
    ].join('\n');
    const idx = parseRuntimeLog(log);
    const v = classifyTransition(
        cand('1.7.900014', '2026-11-16T10:03:10.000Z', 1010.0, 'sell'), idx);
    assert.strictEqual(v.verdict, 'unverifiable');
    assert.ok(v.reason.includes('older than'), 'reason names the lookback bound');
    assert.ok(v.anchor && v.anchor.kind === 'placed', 'anchor still reported');
    assert.strictEqual(v.pivotSelection, 'backward');
    assert.strictEqual(v.pivot, null);
    console.log('✓ PT-13 passed');
}

async function testGateSourcePreferredOverFillPivot() {
    console.log('\n[PT-14] a fill between gate and commit does not re-judge the placed order');
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1020.000000(sell) buy=1000.000000 sell=1020.000000 n=1 src=full/direct',
        '[2026-11-16T10:00:01.000Z] [INFO] [DEXBot] [LAST-FILL-GUARD] mode=active pivot=1020.000000(sell) pivotSlot=100(snapped) inc=0.3% pivotRefreshed=false checked=1 passed=1 skipped=0 bypassed=0',
        '[2026-11-16T10:00:02.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1005.000000(buy) buy=1005.000000 sell=1020.000000 n=1 src=full/direct',
        '[2026-11-16T10:00:03.000Z] [INFO] [DEXBot] Placed buy order slot-100 @1010.000000 x1.00000000 -> 1.7.900016',
    ].join('\n');
    const v = classifyTransition(
        cand('1.7.900016', '2026-11-16T10:00:10.000Z', 1010.0, 'buy',
            '2026-11-16T10:00:00.000Z', 1000.0),
        parseRuntimeLog(log));
    assert.strictEqual(v.verdict, 'policy-divergence',
        'the gate pivot passes the BUY; the intervening fill pivot must not be used');
    assert.ok(v.pivot && v.pivot.price === 1020.0 && v.pivot.type === 'sell');
    assert.strictEqual(v.pivot.src, 'mode', 'the gate line is the anchor pivot');
    console.log('✓ PT-14 passed');
}

async function testFillPivotIsNeverAFallback() {
    console.log('\n[PT-15] a fill-pivot cannot substitute for a missing gate line');
    const log = [
        '[2026-11-16T10:00:00.000Z] [INFO] [DEXBot] [FILL-PIVOT] pivot=1020.000000(sell) buy=1000.000000 sell=1020.000000 n=1 src=full/direct',
        '[2026-11-16T10:00:03.000Z] [INFO] [DEXBot] Placed buy order slot-100 @1010.000000 x1.00000000 -> 1.7.900018',
    ].join('\n');
    const v = classifyTransition(
        cand('1.7.900018', '2026-11-16T10:00:10.000Z', 1010.0, 'buy',
            '2026-11-16T10:00:00.000Z', 1000.0),
        parseRuntimeLog(log));
    assert.strictEqual(v.verdict, 'unverifiable', 'no gate line => no verdict, not a fill-pivot verdict');
    assert.ok(v.reason.includes('no gate pivot observation'), 'reason names the missing gate line');
    assert.strictEqual(v.pivot, null);
    assert.strictEqual(v.pivotSelection, 'backward');
    console.log('✓ PT-15 passed');
}

async function main() {
    await testParseRuntimeLog();
    await testPivotLookups();
    await testDirectionRuleVerdicts();
    await testOrderIdSuffixJoin();
    await testNaiveTimestampIsUtc();
    await testPlacementAnchorPriceMatch();
    await testQueueRefreshIsNotObservation();
    await testSweepReplayShape();
    await testAllowanceBypass();
    await testUnverifiableFailsTowardReporting();
    await testSourceAwarePivotAnchoring();
    await testPlanActionStillUsesForwardLookup();
    await testStaleBackwardPivotIsUnverifiable();
    await testGateSourcePreferredOverFillPivot();
    await testFillPivotIsNeverAFallback();
    console.log('\nAll pivot-timeline mirror regression tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Pivot-timeline mirror test failed:', err);
        process.exit(1);
    });
}

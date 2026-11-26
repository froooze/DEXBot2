/**
 * LAST-FILL-PIVOT MARKET EVIDENCE (both legs) + MARKET-CROSSING OBSERVATION.
 *
 * A fill may arm the LAST-FILL-GUARD pivot only when it is evidence of the
 * CURRENT window:
 *   - wrong-side: BUY above mid / SELL below mid (crossed-book artifact);
 *   - too-far:    either side, more than
 *                 GRID_LIMITS.LAST_FILL_PIVOT_MAX_MID_DISTANCE_STEPS increments
 *                 from the mid (a premium/discount SWEEP of our own rail).
 * Both are cases where arming the pivot vetoes the band the geometry derives,
 * for the full 24h TTL.
 *
 * Pinned here:
 *   1. Wrong-side fill provenance is refused; book provenance is never bound
 *      (the seed heuristic is not market truth).
 *   2. A fill a full spread away from the mid is refused on EITHER side
 *      (live: a sell 14.5 steps / 4.4% above the mid armed the pivot at the
 *      band's own top and froze the sell side for 86 minutes).
 *   3. Refusal skips BOTH the pivot family AND the bot-scoped market-fill
 *      row (an off-market row as a crossing floor freezes correction the same
 *      way).
 *   4. Fail-open: no cached mid, or a mid older than
 *      GRID_LIMITS.LAST_FILL_PIVOT_MARKET_FRESH_MS, never vetoes.
 *   5. Rebuild re-arm through the same writer is bound too.
 *   6. expireLastFillGuardReferences clears the pivot family AND the
 *      market-fill reference (live + persisted).
 *   7. describeMarketCrossingActions reports CREATE/UPDATE priced across the
 *      SHARED market floor (recency: a fill newer than the book read wins) and
 *      never mutates or vetoes — retrospective §9.10/P4 made it an observation
 *      because a hard veto re-opens the counter-order deadlock.
 */

const assert = require('assert');
const {
    setLastFillPivot,
    rearmLastFillPivotFromMarketFill,
    expireLastFillGuardReferences
} = require('../modules/order/utils/system');
const { describeMarketCrossingActions } = require('../modules/order/utils/order');
const { ORDER_TYPES, GRID_LIMITS } = require('../modules/constants');

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

const NOW = Date.now();
const FRESH_MID_AT = NOW - 5_000;
const STALE_MID_AT = NOW - (Number(GRID_LIMITS.LAST_FILL_PIVOT_MARKET_FRESH_MS) + 60_000);

function makeManager(over: Record<string, unknown> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    const cleared: string[] = [];
    return {
        _lastFilledPrice: null as number | null,
        _lastFilledType: null as string | null,
        _lastFilledAt: 0,
        lastFillPivotSource: null as string | null,
        _lastFilledBuyPrice: null as number | null,
        _lastFilledSellPrice: null as number | null,
        _lastMarketFillPrice: null as number | null,
        _lastMarketFillType: null as string | null,
        _lastMarketFillAt: 0,
        _liveMarketPrice: null as number | null,
        _liveMarketPriceAt: null as number | null,
        config: { incrementPercent: 0.5 },
        accountOrders: {
            clearPersistedLastMarketFill: () => cleared.push('market-fill'),
            clearPersistedLastFillPivot: () => cleared.push('pivot')
        },
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        cleared,
        ...over
    };
}

// ── 1. Wrong-side refusal ─────────────────────────────────────────

run('BOUND-1 a BUY above mid beyond tolerance is refused (fill provenance)', () => {
    // increment 0.5% → tolerance 1 step → buy limit = mid * 1.005
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1010, 'fill'), false,
        'a BUY ~1% above mid is a crossed-book artifact and must not arm the guard');
    assert.strictEqual(mgr._lastFilledPrice, null, 'the pivot family must stay untouched');
    assert.strictEqual(mgr._lastMarketFillPrice, null, 'the market-fill row must be skipped with the refusal');
    assert.ok(mgr.logs.some((l: any) => /Refusing to arm pivot/.test(l.msg) && l.level === 'warn'),
        `the refusal must be logged as a warning (got: ${mgr.logs.map((l: any) => l.msg).join(' | ')})`);
});

run('BOUND-2 a SELL below mid beyond tolerance is refused', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, 990, 'fill'), false,
        'a SELL ~1% below mid must not arm the guard');
    assert.strictEqual(mgr._lastMarketFillPrice, null);
});

run('BOUND-3 a fill within tolerance of mid is allowed (BUY at/below, SELL at/above)', () => {
    const step = 1 + 0.5 / 100;
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    // BUY at mid + exactly the 1-step tolerance boundary is allowed.
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1000 * step, 'fill'), true, 'BUY at the tolerance edge is allowed');
    assert.strictEqual(mgr._lastFilledPrice, 1000 * step);
    assert.strictEqual(mgr._lastMarketFillPrice, 1000 * step, 'an accepted fill still writes the market-fill row');
    const mgr2: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr2, ORDER_TYPES.SELL, 1000 / step, 'fill'), true, 'SELL at the tolerance edge is allowed');
    assert.strictEqual(mgr2._lastFilledPrice, 1000 / step);
});

run('BOUND-4 a fill on the market\'s own side, within a spread of the mid, is allowed', () => {
    const step = 1 + 0.5 / 100;
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1000 / Math.pow(step, 3), 'fill'), true,
        'BUY three steps below mid is a normal window fill');
    const mgr2: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr2, ORDER_TYPES.SELL, 1000 * Math.pow(step, 3), 'fill'), true,
        'SELL three steps above mid is a normal window fill');
});

run('BOUND-11 a DEEP sweep on the market\'s own side is refused too (symmetric distance leg)', () => {
    // Mirror of the live incident: a BUY 10 steps below the mid would arm the
    // pivot under every buy on the rail (buys must stay below it), freezing the
    // whole buy side for the 24h TTL — exactly the sell-side freeze this leg
    // already prevents.
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 950, 'fill'), false,
        'a BUY 10 steps below mid is a discounted sweep, not a window trade');
    assert.strictEqual(mgr._lastFilledPrice, null);
    assert.strictEqual(mgr._lastMarketFillPrice, null);
    assert.ok(mgr.logs.some((l: any) => /premium sweep of our own rail/.test(l.msg)),
        `the distance refusal must name the sweep (got: ${mgr.logs.map((l: any) => l.msg).join(' | ')})`);
});

run('BOUND-12 the live incident shape: SELL 8.6 steps (4.4%) above mid is refused', () => {
    // Exact numbers from the 2026-11-15 log: mid 1406.6336, swept ask
    // 1469.0989 → +4.44% = 8.6 increments of 0.5%. Directionally "honest"
    // (a sell above mid), which is why the wrong-side leg alone let it arm.
    const mgr: any = makeManager({ _liveMarketPrice: 1406.6336, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, 1469.0989, 'fill'), false,
        'the top of a premium sweep must not become the geometry anchor');
    assert.strictEqual(mgr._lastFilledPrice, null, 'the previous (window) pivot survives');
});

run('BOUND-13 the distance leg honours its configured bound and fails open on stale mid', () => {
    const step = 1 + 0.5 / 100;
    const maxSteps = Number(GRID_LIMITS.LAST_FILL_PIVOT_MAX_MID_DISTANCE_STEPS);
    assert.ok(maxSteps >= 1, 'a distance bound must be configured');
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, 1000 * Math.pow(step, maxSteps), 'fill'), true,
        'exactly at the bound is still window evidence');
    const mgr2: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr2, ORDER_TYPES.SELL, 1000 * Math.pow(step, maxSteps + 1), 'fill'), false,
        'one step past the bound is refused');
    const mgrStale: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: STALE_MID_AT });
    assert.strictEqual(setLastFillPivot(mgrStale, ORDER_TYPES.SELL, 1200, 'fill'), true,
        'a stale mid must never veto a fresh fill (fail-open)');
});

// ── 2. Provenance scoping ─────────────────────────────────────────

run('BOUND-5 book provenance is never market-bound', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'book'), true,
        'the book-seed heuristic is not market truth and must not be bound');
    assert.strictEqual(mgr.lastFillPivotSource, 'book');
});

// ── 3. Fail-open paths ────────────────────────────────────────────

run('BOUND-6 no cached mid fails open', () => {
    const mgr: any = makeManager(); // _liveMarketPrice null
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'fill'), true,
        'without live evidence the guard must not guess');
});

run('BOUND-7 a stale mid fails open (never veto a fresh fill with an ancient mid)', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: STALE_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'fill'), true);
});

run('BOUND-8 a fresh mid with a broken clock fails open', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: 0 });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'fill'), true);
});

// ── 4. Rebuild re-arm bound ───────────────────────────────────────

run('BOUND-9 the rebuild re-arm goes through the same bound', () => {
    const mgr: any = makeManager({
        _lastMarketFillPrice: 1100,
        _lastMarketFillType: ORDER_TYPES.BUY,
        _lastMarketFillAt: NOW - 60_000,
        _liveMarketPrice: 1000,
        _liveMarketPriceAt: FRESH_MID_AT
    });
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), false,
        'an off-market row must not re-arm across a rebuild');
    assert.strictEqual(mgr._lastFilledPrice, null, 'no pivot may be armed from the refused row');
    assert.ok(mgr.logs.some((l: any) => /Refusing to arm pivot/.test(l.msg)),
        'the refusal must be logged');
});

run('BOUND-10 the rebuild re-arm succeeds for an on-market row', () => {
    const mgr: any = makeManager({
        _lastMarketFillPrice: 990,
        _lastMarketFillType: ORDER_TYPES.BUY,
        _lastMarketFillAt: NOW - 60_000,
        _liveMarketPrice: 1000,
        _liveMarketPriceAt: FRESH_MID_AT
    });
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), true);
    assert.strictEqual(mgr._lastFilledPrice, 990);
});

// ── 5. Watchdog expiry helper ─────────────────────────────────────

run('EXPIRE-1 expireLastFillGuardReferences clears pivot + market-fill live and persisted', () => {
    const mgr: any = makeManager({
        _lastFilledPrice: 1100, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW,
        _lastMarketFillPrice: 1100, _lastMarketFillType: ORDER_TYPES.BUY, _lastMarketFillAt: NOW
    });
    expireLastFillGuardReferences(mgr, 'test expiry');
    assert.strictEqual(mgr._lastFilledPrice, null, 'the pivot must be cleared');
    assert.strictEqual(mgr._lastMarketFillPrice, null, 'the market-fill reference must be cleared');
    assert.strictEqual(mgr._lastMarketFillAt, 0);
    assert.deepStrictEqual(mgr.cleared.sort(), ['market-fill', 'pivot'],
        'both persisted rows must be erased so a restart cannot re-arm');
    assert.ok(mgr.logs.some((l: any) => /Expired guard references/.test(l.msg) && l.level === 'warn'),
        'the expiry must be logged loudly');
});

run('EXPIRE-2 a cold manager expires silently (no log, no error)', () => {
    const mgr: any = makeManager();
    expireLastFillGuardReferences(mgr, 'test expiry cold');
    assert.strictEqual(mgr._lastFilledPrice, null);
    assert.strictEqual(mgr.logs.filter((l: any) => /Expired guard references/.test(l.msg)).length, 0);
});

run('EXPIRE-3 missing persistence hooks must not throw', () => {
    const mgr: any = makeManager({ accountOrders: {}, _lastMarketFillPrice: 5 });
    expireLastFillGuardReferences(mgr, 'test expiry no-hooks');
    assert.strictEqual(mgr._lastMarketFillPrice, null);
});

run('EXPIRE-4 skipPersistedClear leaves the disk rows for the caller to erase', () => {
    const mgr: any = makeManager({
        _lastFilledPrice: 1100, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW,
        _lastMarketFillPrice: 1100, _lastMarketFillType: ORDER_TYPES.BUY, _lastMarketFillAt: NOW
    });
    expireLastFillGuardReferences(mgr, 'manual full reset', { skipPersistedClear: true });
    assert.strictEqual(mgr._lastFilledPrice, null, 'live pivot must still be cleared');
    assert.strictEqual(mgr._lastMarketFillPrice, null, 'live market row must still be cleared');
    assert.deepStrictEqual(mgr.cleared, [], 'disk deletes belong to the awaiting caller on this path');
});

// ── 6. Market-crossing observation ────────────────────────────────

function createAction(over: Record<string, unknown>) {
    return { type: 'create', id: 'slot-1', order: { type: ORDER_TYPES.BUY, price: 1000 }, ...over };
}

run('DESCRIBE-1 reports a CREATE BUY above the floor, leaves the batch untouched', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        createAction({ id: 'slot-1', order: { type: ORDER_TYPES.BUY, price: 1010 } }),
        createAction({ id: 'slot-2', order: { type: ORDER_TYPES.BUY, price: 990 } }),
        createAction({ id: 'slot-3', order: { type: ORDER_TYPES.SELL, price: 1010 } })
    ];
    const { floor, dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(floor, 1000, 'the floor is the shared recency-aware reference');
    assert.strictEqual(dropped.length, 1, 'one action is reported');
    assert.strictEqual(dropped[0].action.id, 'slot-1');
    assert.match(dropped[0].reason, /BUY 1010 above the market floor 1000/);
    assert.strictEqual(actions.length, 3, 'the input array must not be mutated (no veto)');
});

run('DESCRIBE-2 reports a CREATE SELL below the floor', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [createAction({ id: 'slot-9', order: { type: ORDER_TYPES.SELL, price: 900 } })];
    const { dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(dropped.length, 1);
    assert.strictEqual(dropped[0].reason.includes('SELL 900 below the market floor 1000'), true);
});

run('DESCRIBE-3 CANCELs are never reported (a cancel cannot cross anything)', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'cancel', id: 'slot-1' },
        { type: 'cancel', id: 'slot-2', order: { type: ORDER_TYPES.BUY, price: 9999 } }
    ];
    const { dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(dropped.length, 0);
});

run('DESCRIBE-4 UPDATE actions are judged at their NEW price and side', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'update', id: 'slot-1', newPrice: 1010, order: { type: ORDER_TYPES.BUY, price: 1010 } },
        { type: 'update', id: 'slot-2', newPrice: 990, order: { type: ORDER_TYPES.SELL, price: 990 } }
    ];
    const { dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(dropped.length, 2, 'both updates sit across the floor');
});

run('DESCRIBE-5 no live read and no fill => no floor (fail-open)', () => {
    const mgr: any = makeManager();
    const actions = [createAction({ order: { type: ORDER_TYPES.BUY, price: 9999 } })];
    const { floor, dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(floor, null);
    assert.strictEqual(dropped.length, 0);
});

run('DESCRIBE-6 a FILL newer than the book read supplies the floor (the live incident shape)', () => {
    // Live 14:39: the book read was 8 minutes old (and was itself the midpoint
    // of the bot's own quotes); five fills at 1434.3..1469.1 were newer. The
    // rejected filter used the stale book read and reported the repair batch as
    // crossing; the shared floor prefers the fresher fill, so the batch is not.
    const fillAt = NOW - 60_000;
    const mgr: any = makeManager({
        _liveMarketPrice: 1000,
        _liveMarketPriceAt: NOW - 8 * 60_000,
        _lastFilledPrice: 1044,
        _lastFilledType: ORDER_TYPES.SELL,
        _lastFilledAt: fillAt,
        lastFillPivotSource: 'fill',
        _lastMarketFillPrice: 1044,
        _lastMarketFillType: ORDER_TYPES.SELL,
        _lastMarketFillAt: fillAt
    });
    const actions = [
        createAction({ id: 'slot-a', order: { type: ORDER_TYPES.BUY, price: 1010 - 0 } }), // below the fill, above the old mid
        createAction({ id: 'slot-b', order: { type: ORDER_TYPES.SELL, price: 1030 } })     // below the fill => reported
    ];
    const { floor, dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(floor, 1044, 'the fresher fill wins over the older book read');
    assert.deepStrictEqual(dropped.map((d: any) => d.action.id), ['slot-b'],
        'only the action actually across the fill is reported');
});

run('DESCRIBE-7 a book read newer than the fill keeps the floor (recency, not preference)', () => {
    const mgr: any = makeManager({
        _liveMarketPrice: 1000,
        _liveMarketPriceAt: NOW - 1_000,
        _lastFilledPrice: 1044,
        _lastFilledType: ORDER_TYPES.SELL,
        _lastFilledAt: NOW - 60_000,
        lastFillPivotSource: 'fill',
        _lastMarketFillPrice: 1044,
        _lastMarketFillType: ORDER_TYPES.SELL,
        _lastMarketFillAt: NOW - 60_000
    });
    const { floor } = describeMarketCrossingActions(mgr, [createAction({})] as any);
    assert.strictEqual(floor, 1000, 'a fresher market read wins');
});

run('DESCRIBE-8 malformed actions fail open individually', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'create', id: 'slot-x', order: {} }, // no price/type
        { type: 'create', id: 'slot-y', order: { type: 'weird', price: 1000 } } // unknown type
    ];
    const { dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(dropped.length, 0, 'unknowable actions must never be reported');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

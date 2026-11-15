/**
 * LAST-FILL-PIVOT MARKET BOUND (wrong-side refusal) + MARKET-CROSSING FILTER.
 *
 * A fill may arm the LAST-FILL-GUARD pivot only when it priced on the
 * market's own side of the live reference: BUY at/below mid, SELL at/above
 * mid. A fill on the WRONG side is a crossed-book artifact — usually the
 * bot's own misplaced order swept by an external taker — and arming it
 * vetoes every near-market counter-side placement for the full 24h TTL
 * (live incident: pivot buy far above mid froze the sell rail for a day).
 *
 * Pinned here:
 *   1. Wrong-side fill provenance is refused; book provenance is never bound
 *      (the seed heuristic is not market truth).
 *   2. Refusal skips BOTH the pivot family AND the bot-scoped market-fill
 *      row (an off-mid row as a crossing floor freezes correction the same
 *      way).
 *   3. Fail-open: no cached mid, or a mid older than
 *      GRID_LIMITS.LAST_FILL_PIVOT_MARKET_FRESH_MS, never vetoes.
 *   4. Rebuild re-arm through the same writer is bound too.
 *   5. expireLastFillGuardReferences clears the pivot family AND the
 *      market-fill reference (live + persisted).
 *   6. filterMarketCrossingActions drops CREATE/UPDATE priced across the
 *      live mid (fresh mid only; CANCELs always kept; fail-open without).
 */

const assert = require('assert');
const {
    setLastFillPivot,
    rearmLastFillPivotFromMarketFill,
    expireLastFillGuardReferences
} = require('../modules/order/utils/system');
const { filterMarketCrossingActions } = require('../modules/order/utils/order');
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

run('BOUND-4 a fill on the market\'s own side is always allowed', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 950, 'fill'), true, 'BUY below mid is honest');
    const mgr2: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr2, ORDER_TYPES.SELL, 1050, 'fill'), true, 'SELL above mid is honest');
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

// ── 6. Market-crossing action filter ──────────────────────────────

function createAction(over: Record<string, unknown>) {
    return { type: 'create', id: 'slot-1', order: { type: ORDER_TYPES.BUY, price: 1000 }, ...over };
}

run('FILTER-1 a CREATE BUY above mid is dropped, the rest of the batch survives', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        createAction({ id: 'slot-1', order: { type: ORDER_TYPES.BUY, price: 1010 } }),
        createAction({ id: 'slot-2', order: { type: ORDER_TYPES.BUY, price: 990 } }),
        createAction({ id: 'slot-3', order: { type: ORDER_TYPES.SELL, price: 1010 } })
    ];
    const { filtered, dropped } = filterMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(filtered.length, 2, 'the honest actions must survive');
    assert.strictEqual(dropped.length, 1);
    assert.strictEqual(dropped[0].action.id, 'slot-1');
    assert.match(dropped[0].reason, /BUY 1010 above live mid 1000/);
    assert.strictEqual(actions.length, 3, 'the input array must not be mutated');
});

run('FILTER-2 a CREATE SELL below mid is dropped', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [createAction({ id: 'slot-9', order: { type: ORDER_TYPES.SELL, price: 900 } })];
    const { filtered, dropped } = filterMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(filtered.length, 0);
    assert.strictEqual(dropped[0].reason.includes('SELL 900 below live mid 1000'), true);
});

run('FILTER-3 CANCELs are always kept (cancels can never cross anything)', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'cancel', id: 'slot-1' },
        { type: 'cancel', id: 'slot-2', order: { type: ORDER_TYPES.BUY, price: 9999 } }
    ];
    const { filtered, dropped } = filterMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(filtered.length, 2, 'cancels must never be filtered');
    assert.strictEqual(dropped.length, 0);
});

run('FILTER-4 UPDATE actions are checked at their NEW price and new side', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'update', id: 'slot-1', newPrice: 1010, order: { type: ORDER_TYPES.BUY, price: 1010 } },
        { type: 'update', id: 'slot-2', newPrice: 990, order: { type: ORDER_TYPES.SELL, price: 990 } }
    ];
    const { filtered, dropped } = filterMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(filtered.length, 0, 'both updates cross the live mid');
    assert.strictEqual(dropped.length, 2);
});

run('FILTER-5 no/stale live mid fails open (batch passes unfiltered)', () => {
    const mgrNoMid: any = makeManager();
    const actions = [createAction({ order: { type: ORDER_TYPES.BUY, price: 9999 } })];
    assert.strictEqual(filterMarketCrossingActions(mgrNoMid, actions as any).filtered.length, 1);
    const mgrStale: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: STALE_MID_AT });
    assert.strictEqual(filterMarketCrossingActions(mgrStale, actions as any).filtered.length, 1);
});

run('FILTER-6 malformed actions fail open individually', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'create', id: 'slot-x', order: {} }, // no price/type
        { type: 'create', id: 'slot-y', order: { type: 'weird', price: 1000 } } // unknown type
    ];
    const { filtered, dropped } = filterMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(filtered.length, 2, 'unknowable actions must never be dropped');
    assert.strictEqual(dropped.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * LAST-FILL-PIVOT MARKET EVIDENCE — FLIPPED TO FILL-AUTHORITATIVE.
 *
 * The old suite pinned a market-bound veto: a fill far from (or on the wrong
 * side of) a cached mid could not arm the LAST-FILL-GUARD pivot. The incident
 * showed that veto is the bug: a stale mid, not the trade, decided which fills
 * were real. Under the new policy every fill arms the guard at any distance
 * and on either side of the cached mid; same-level re-placement stays blocked
 * by the direction rule alone.
 *
 * The market-crossing observation half (DESCRIBE-*) is unchanged: it reports
 * CREATE/UPDATE actions across the shared recency-aware floor and never vetoes.
 */

const assert = require('assert');
const {
    setLastFillPivot,
    rearmLastFillPivotFromMarketFill,
    expireLastFillGuardReferences,
    liveRefusedFillLevels,
    hasLiveRefusedFillLevels,
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
        _lastRefusedFillPrice: null as number | null,
        _lastRefusedFillType: null as string | null,
        _lastRefusedFillAt: 0,
        _lastRefusedFillLevels: [] as Array<{ price: number; type: string; at: number }>,
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

// ── 1. Distance and wrong side no longer refuse ──────────────────────────

run('BOUND-1 a BUY above mid arms the pivot (crossed-book veto removed)', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1010, 'fill'), true);
    assert.strictEqual(mgr._lastFilledPrice, 1010, 'the pivot family must follow the fill');
    assert.strictEqual(mgr._lastMarketFillPrice, 1010, 'the market-fill row follows too');
    assert.strictEqual(mgr._lastRefusedFillPrice, null, 'no refused marker is written');
    assert.ok(!mgr.logs.some((l: any) => /Refusing to arm pivot/.test(l.msg)),
        `no refusal may be logged (got: ${mgr.logs.map((l: any) => l.msg).join(' | ')})`);
});

run('BOUND-2 a SELL below mid arms the pivot', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, 990, 'fill'), true);
    assert.strictEqual(mgr._lastMarketFillPrice, 990);
    assert.strictEqual(hasLiveRefusedFillLevels(mgr), false);
});

run('BOUND-3 a fill within tolerance of mid is allowed (unchanged)', () => {
    const step = 1 + 0.5 / 100;
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1000 * step, 'fill'), true);
    assert.strictEqual(mgr._lastFilledPrice, 1000 * step);
    assert.strictEqual(mgr._lastMarketFillPrice, 1000 * step);
    const mgr2: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr2, ORDER_TYPES.SELL, 1000 / step, 'fill'), true);
    assert.strictEqual(mgr2._lastFilledPrice, 1000 / step);
});

run('BOUND-4 an on-side fill within a spread arms the pivot (unchanged)', () => {
    const step = 1 + 0.5 / 100;
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1000 / Math.pow(step, 3), 'fill'), true);
    const mgr2: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr2, ORDER_TYPES.SELL, 1000 * Math.pow(step, 3), 'fill'), true);
});

run('BOUND-11 a DEEP sweep on the market\'s own side still arms the pivot', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 950, 'fill'), true,
        'a deep BUY sweep is market truth and must arm the guard');
    assert.strictEqual(mgr._lastFilledPrice, 950);
    assert.strictEqual(mgr._lastMarketFillPrice, 950);
    assert.ok(!mgr.logs.some((l: any) => /premium sweep of our own rail/.test(l.msg)),
        'the sweep refusal log is gone');
});

run('BOUND-12 the live incident shape: SELL 8.6 steps (4.4%) above mid arms', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1406.6336, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, 1469.0989, 'fill'), true,
        'the top of the sweep now becomes the guard reference deliberately');
    assert.strictEqual(mgr._lastFilledPrice, 1469.0989);
});

run('BOUND-13 distance config is inert: past the old bound still arms, stale mid irrelevant', () => {
    const step = 1 + 0.5 / 100;
    const maxSteps = Number(GRID_LIMITS.LAST_FILL_PIVOT_MAX_MID_DISTANCE_STEPS);
    assert.ok(maxSteps >= 1, 'the legacy bound may remain in constants but no longer gates fills');
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, 1000 * Math.pow(step, maxSteps + 1), 'fill'), true,
        'one step past the old bound must now arm');
    const mgrStale: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: STALE_MID_AT });
    assert.strictEqual(setLastFillPivot(mgrStale, ORDER_TYPES.SELL, 1200, 'fill'), true);
});

// ── 2. Provenance scoping ───────────────────────────────────────────────

run('BOUND-5 book provenance still arms but does not write a market-fill row', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'book'), true);
    assert.strictEqual(mgr.lastFillPivotSource, 'book');
    assert.strictEqual(mgr._lastMarketFillPrice, null, 'a book seed is not a trade');
});

// ── 3. No cached mid is needed any more ─────────────────────────────────

run('BOUND-6 no cached mid arms normally', () => {
    const mgr: any = makeManager();
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'fill'), true);
    assert.strictEqual(mgr._lastFilledPrice, 1100);
});

run('BOUND-7 a stale mid no longer changes the verdict', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: STALE_MID_AT });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'fill'), true);
});

run('BOUND-8 a broken mid clock no longer changes the verdict', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: 0 });
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.BUY, 1100, 'fill'), true);
});

// ── 4. Rebuild re-arm uses the same writer ──────────────────────────────

run('BOUND-9 the rebuild re-arm accepts a formerly off-market row', () => {
    const mgr: any = makeManager({
        _lastMarketFillPrice: 1100,
        _lastMarketFillType: ORDER_TYPES.BUY,
        _lastMarketFillAt: NOW - 60_000,
        _liveMarketPrice: 1000,
        _liveMarketPriceAt: FRESH_MID_AT
    });
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), true,
        'a real persisted fill row always re-arms across a rebuild');
    assert.strictEqual(mgr._lastFilledPrice, 1100);
    assert.deepStrictEqual(liveRefusedFillLevels(mgr), []);
});

run('BOUND-10 the rebuild re-arm succeeds for an on-market row (unchanged)', () => {
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

// ── 5. Watchdog expiry helper (unchanged) ───────────────────────────────

run('EXPIRE-1 expireLastFillGuardReferences clears pivot + market-fill live and persisted', () => {
    const mgr: any = makeManager({
        _lastFilledPrice: 1100, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW,
        _lastMarketFillPrice: 1100, _lastMarketFillType: ORDER_TYPES.BUY, _lastMarketFillAt: NOW
    });
    expireLastFillGuardReferences(mgr, 'test expiry');
    assert.strictEqual(mgr._lastFilledPrice, null);
    assert.strictEqual(mgr._lastMarketFillPrice, null);
    assert.strictEqual(mgr._lastMarketFillAt, 0);
    assert.deepStrictEqual(mgr.cleared.sort(), ['market-fill', 'pivot']);
    assert.ok(mgr.logs.some((l: any) => /Expired guard references/.test(l.msg) && l.level === 'warn'));
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
    assert.strictEqual(mgr._lastFilledPrice, null);
    assert.strictEqual(mgr._lastMarketFillPrice, null);
    assert.deepStrictEqual(mgr.cleared, []);
});

// ── 6. Market-crossing observation (unchanged) ──────────────────────────

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
    assert.strictEqual(floor, 1000);
    assert.strictEqual(dropped.length, 1);
    assert.strictEqual(dropped[0].action.id, 'slot-1');
    assert.match(dropped[0].reason, /BUY 1010 above the market floor 1000/);
    assert.strictEqual(actions.length, 3, 'no veto: input must not be mutated');
});

run('DESCRIBE-2 reports a CREATE SELL below the floor', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [createAction({ id: 'slot-9', order: { type: ORDER_TYPES.SELL, price: 900 } })];
    const { dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(dropped.length, 1);
    assert.strictEqual(dropped[0].reason.includes('SELL 900 below the market floor 1000'), true);
});

run('DESCRIBE-3 CANCELs are never reported', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'cancel', id: 'slot-1' },
        { type: 'cancel', id: 'slot-2', order: { type: ORDER_TYPES.BUY, price: 9999 } }
    ];
    assert.strictEqual(describeMarketCrossingActions(mgr, actions as any).dropped.length, 0);
});

run('DESCRIBE-4 UPDATE actions are judged at their NEW price and side', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'update', id: 'slot-1', newPrice: 1010, order: { type: ORDER_TYPES.BUY, price: 1010 } },
        { type: 'update', id: 'slot-2', newPrice: 990, order: { type: ORDER_TYPES.SELL, price: 990 } }
    ];
    assert.strictEqual(describeMarketCrossingActions(mgr, actions as any).dropped.length, 2);
});

run('DESCRIBE-5 no live read and no fill => no floor (fail-open)', () => {
    const mgr: any = makeManager();
    const { floor, dropped } = describeMarketCrossingActions(mgr, [createAction({})] as any);
    assert.strictEqual(floor, null);
    assert.strictEqual(dropped.length, 0);
});

run('DESCRIBE-6 a FILL newer than the book read supplies the floor', () => {
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
        createAction({ id: 'slot-a', order: { type: ORDER_TYPES.BUY, price: 1010 } }),
        createAction({ id: 'slot-b', order: { type: ORDER_TYPES.SELL, price: 1030 } })
    ];
    const { floor, dropped } = describeMarketCrossingActions(mgr, actions as any);
    assert.strictEqual(floor, 1044);
    assert.deepStrictEqual(dropped.map((d: any) => d.action.id), ['slot-b']);
});

run('DESCRIBE-7 a book read newer than the fill keeps the floor', () => {
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
    assert.strictEqual(describeMarketCrossingActions(mgr, [createAction({})] as any).floor, 1000);
});

run('DESCRIBE-8 malformed actions fail open individually', () => {
    const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
    const actions = [
        { type: 'create', id: 'slot-x', order: {} },
        { type: 'create', id: 'slot-y', order: { type: 'weird', price: 1000 } }
    ];
    assert.strictEqual(describeMarketCrossingActions(mgr, actions as any).dropped.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

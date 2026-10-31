/**
 * PIVOT RE-ARM ON A NEW GENERATION.
 *
 * A grid rebuild is a new generation: the armed pivot is cleared (it was bound
 * to the previous ladder) and then explicitly RE-ARMED from the bot-scoped last
 * real fill. Two properties matter:
 *
 *   1. The guard never silently goes cold after a rebuild while the account's
 *      last trade price is known — that was the pre-1.6.14 behaviour and it let
 *      a freshly rebuilt grid place a sell below the last sale.
 *   2. The re-arm is an explicit, logged write through the single pivot writer
 *      (provenance 'fill'), NOT an accidental side effect of the read-time
 *      fallback in resolveLastFillGuardReference. The rebuild comment used to
 *      claim "the guard re-arms on the first fill of the new generation", which
 *      is not what the fallback did — the two must now agree.
 *
 * The decision is pinned deliberately: the pivot SURVIVES a rebuild (bounded by
 * the same 24h restore TTL as the row). If the market has moved away from that
 * price, the same-side rail reads `last-fill-blocked` and only a fill (or the
 * TTL) restores it — the geometry-bind watchdog is capped to one re-center per
 * pivot for exactly that reason (test_spread_last_fill_planning SLF-11).
 */

const assert = require('assert');
const {
    resetLastFillPivot,
    setLastFillPivot,
    rearmLastFillPivotFromMarketFill,
    resolveLastFillGuardReference,
    isLastFillGuardBlocked
} = require('../modules/order/utils/system');
const { ORDER_TYPES } = require('../modules/constants');

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

const FILLS_AT = Date.parse('2026-10-31T10:00:00.000Z');

function makeManager(over: Record<string, unknown> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
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
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        ...over
    };
}

run('REARM-1 a fill-provenanced market row re-arms the pivot on the new generation', () => {
    const mgr: any = makeManager({
        _lastMarketFillPrice: 0.44764,
        _lastMarketFillType: ORDER_TYPES.SELL,
        _lastMarketFillAt: FILLS_AT
    });
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), true, 'a known last fill must re-arm on a rebuild');
    assert.strictEqual(mgr._lastFilledPrice, 0.44764);
    assert.strictEqual(mgr._lastFilledType, ORDER_TYPES.SELL);
    assert.strictEqual(mgr.lastFillPivotSource, 'fill', 'provenance must stay fill (never book)');
    assert.strictEqual(mgr._lastFilledAt, FILLS_AT, 'the original fill timestamp must be preserved');
    assert.ok(mgr.logs.some((l: any) => /Re-armed on the new generation/.test(l.msg)),
        `the re-arm must be logged (got: ${mgr.logs.map((l: any) => l.msg).join(' | ')})`);
});

run('REARM-2 a book-seeded pivot is never a re-arm source', () => {
    const mgr: any = makeManager({
        _lastFilledPrice: 1.23,
        _lastFilledType: ORDER_TYPES.BUY,
        lastFillPivotSource: 'book'
    });
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), false, 'a book seed must not become a fill pivot');
    assert.strictEqual(mgr._lastFilledPrice, 1.23, 'the (book) live pivot is untouched by the refused re-arm');
    assert.strictEqual(mgr.lastFillPivotSource, 'book');
});

run('REARM-3 a cold manager stays cold (nothing to re-arm)', () => {
    const mgr: any = makeManager();
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), false);
    assert.strictEqual(mgr._lastFilledPrice, null);
});

run('REARM-4 a rebuild gap is covered: reset clears the pivot, the row still arms the guard', () => {
    const mgr: any = makeManager();
    setLastFillPivot(mgr, ORDER_TYPES.SELL, 0.44764, 'fill', FILLS_AT);
    // Rebuild: the generation-bound pivot is dropped...
    assert.strictEqual(resetLastFillPivot(mgr, 'grid rebuild'), true);
    assert.strictEqual(mgr._lastFilledPrice, null, 'reset must clear the armed pivot');
    // ...and the guard is NOT cold, because the bot-scoped row survives.
    const before = resolveLastFillGuardReference(mgr);
    assert.deepStrictEqual(before, { price: 0.44764, type: ORDER_TYPES.SELL });
    assert.strictEqual(isLastFillGuardBlocked(0.44, ORDER_TYPES.SELL, before.price, before.type).blocked, true,
        'a sell below the last sale must still be refused right after a rebuild');
    // The explicit re-arm then makes that state a real, persisted pivot again.
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), true);
    assert.strictEqual(mgr.lastFillPivotSource, 'fill');
    assert.deepStrictEqual(resolveLastFillGuardReference(mgr), before, 'reference unchanged by the re-arm');
});

run('REARM-5 re-arm is idempotent (repeat rebuilds keep one value)', () => {
    const mgr: any = makeManager({
        _lastMarketFillPrice: 0.44764,
        _lastMarketFillType: ORDER_TYPES.SELL,
        _lastMarketFillAt: FILLS_AT
    });
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), true);
    const first = { price: mgr._lastFilledPrice, type: mgr._lastFilledType, at: mgr._lastFilledAt };
    assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), true);
    assert.deepStrictEqual({ price: mgr._lastFilledPrice, type: mgr._lastFilledType, at: mgr._lastFilledAt }, first);
});

console.log(`\nPIVOT-REARM summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * SAME-LEVEL RE-FILL BLOCK — DIRECTION RULE ONLY (fill-authoritative policy).
 *
 * The refused-level marker family is retired: a fill can no longer be refused
 * from arming the pivot, so there is no "refused level" to remember. The sole
 * same-level protection is the armed pivot's direction rule, where EQUAL is
 * blocked (a SELL at/below the last SELL, a BUY at/above the last BUY). The
 * counter side stays placeable, and a cold pivot blocks nothing.
 *
 * This suite flips the old marker assertions and pins that the whole helper
 * family is gone (the filename is kept for historical continuity).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    setLastFillPivot,
    evaluateLastFillGuard,
    isLastFillPlacementBlocked,
    isLastFillGuardBlocked,
    resetLastFillPivot,
    expireLastFillGuardReferences,
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
        _liveMarketPrice: null as number | null,
        _liveMarketPriceAt: null as number | null,
        config: { incrementPercent: 0.5 },
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        ...over
    };
}

const MID = 1000;
const SWEEP_SELL = 1050;   // ~9.8 steps above mid: formerly refused, now armed
const NOW_MS = Date.now();
const FRESH_MID_AT = NOW_MS - 5_000;

function armSweepSell(mgr: any): void {
    mgr._liveMarketPrice = MID;
    mgr._liveMarketPriceAt = FRESH_MID_AT;
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, SWEEP_SELL, 'fill'), true,
        'a premium sweep now arms the guard');
}

// ── 1. Arming replaces the old refusal ────────────────────────────────────

run('REFUSED-1 the sweep arms the pivot and writes no marker', () => {
    const mgr: any = makeManager();
    armSweepSell(mgr);
    assert.strictEqual(mgr._lastFilledPrice, SWEEP_SELL, 'the pivot family follows the fill');
    assert.strictEqual(mgr._lastFilledType, ORDER_TYPES.SELL);
    assert.strictEqual(mgr._lastMarketFillPrice, SWEEP_SELL, 'the market-fill row follows too');
    assert.ok(!mgr.logs.some((l: any) => /same-level re-fill|Refusing to arm pivot/.test(l.msg)));
    const src = fs.readFileSync(path.join(__dirname, '../../modules/order/utils/system.ts'), 'utf8');
    for (const name of ['liveRefusedFillLevels', 'hasLiveRefusedFillLevels', 'releaseRefutedRefusedLevels']) {
        assert.ok(!new RegExp(`export function ${name}\\(`).test(src), `${name} is no longer exported`);
    }
});

run('REFUSED-2 the new fill displaces an already-armed pivot', () => {
    const mgr: any = makeManager({ _lastFilledPrice: 900, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW_MS - 60_000, _lastFilledBuyPrice: 900, lastFillPivotSource: 'fill' });
    armSweepSell(mgr);
    assert.strictEqual(mgr._lastFilledPrice, SWEEP_SELL, 'the latest fill wins');
    assert.strictEqual(mgr._lastFilledType, ORDER_TYPES.SELL);
});

run('REFUSED-3 all fills arm, including an ordinary window fill', () => {
    const mgr: any = makeManager();
    mgr._liveMarketPrice = MID;
    mgr._liveMarketPriceAt = FRESH_MID_AT;
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, MID * 1.005, 'fill'), true);
});

// ── 2. Direction rule: equal counts as blocked ───────────────────────────

run('REFUSED-4 evaluateLastFillGuard blocks the same-side same-level re-place', () => {
    const mgr: any = makeManager();
    armSweepSell(mgr);
    // The pivot is the swept level itself. Equality is blocked; a hair above
    // is the only legal same-side re-place.
    const equal = evaluateLastFillGuard(mgr, SWEEP_SELL, ORDER_TYPES.SELL, SWEEP_SELL, ORDER_TYPES.SELL);
    assert.strictEqual(equal.blocked, true, 'equal to the pivot must be blocked');
    assert.strictEqual(equal.pivot, SWEEP_SELL);
    assert.strictEqual((equal as any).refusedLevel, undefined, 'no marker flag survives');
    const below = evaluateLastFillGuard(mgr, SWEEP_SELL - 0.0001, ORDER_TYPES.SELL, SWEEP_SELL, ORDER_TYPES.SELL);
    assert.strictEqual(below.blocked, true, 'below the pivot is blocked too');
    const above = evaluateLastFillGuard(mgr, SWEEP_SELL + 1, ORDER_TYPES.SELL, SWEEP_SELL, ORDER_TYPES.SELL);
    assert.strictEqual(above.blocked, false, 'above the pivot is placeable');
});

run('REFUSED-5 the counter side is governed by direction, not a level marker', () => {
    const mgr: any = makeManager();
    armSweepSell(mgr);
    assert.strictEqual(isLastFillGuardBlocked(SWEEP_SELL - 5, ORDER_TYPES.BUY, SWEEP_SELL, ORDER_TYPES.SELL).blocked, false,
        'a BUY below the filled SELL price is the counter order');
    const counter = evaluateLastFillGuard(mgr, SWEEP_SELL - 5, ORDER_TYPES.BUY, SWEEP_SELL, ORDER_TYPES.SELL);
    assert.strictEqual(counter.blocked, false, 'the shared verdict keeps the counter side open');
    assert.strictEqual(isLastFillGuardBlocked(SWEEP_SELL, ORDER_TYPES.BUY, SWEEP_SELL, ORDER_TYPES.SELL).blocked, true,
        'a BUY at/above ANY last fill is blocked by the direction rule itself');
});

run('REFUSED-6 same-level reason is "same-level" (never "refused-level")', () => {
    const mgr: any = makeManager();
    armSweepSell(mgr);
    const guard = isLastFillPlacementBlocked(mgr, SWEEP_SELL, ORDER_TYPES.SELL);
    assert.strictEqual(guard.blocked, true);
    assert.strictEqual(guard.reason, 'same-level', 'the sole same-level rule owns the verdict');
    assert.strictEqual(guard.pivot, SWEEP_SELL);
    const direction = isLastFillPlacementBlocked(mgr, SWEEP_SELL - 5, ORDER_TYPES.SELL);
    assert.strictEqual(direction.blocked, true);
    assert.strictEqual(direction.reason, 'direction');
});

// ── 3. Cold pivot and neutral marker stubs ───────────────────────────────

run('REFUSED-7 a cold pivot blocks nothing; no marker helper can supply a guard', () => {
    const mgr: any = makeManager();
    assert.strictEqual(isLastFillPlacementBlocked(mgr, SWEEP_SELL, ORDER_TYPES.SELL).blocked, false,
        'a cold reference disables the guard');
    const runtime = require('../modules/order/utils/system');
    for (const name of ['liveRefusedFillLevels', 'hasLiveRefusedFillLevels', 'releaseRefutedRefusedLevels']) {
        assert.strictEqual(runtime[name], undefined, `${name} is absent at runtime`);
    }
});

run('REFUSED-8 reset clears the pivot scalars; the market row still arms the guard', () => {
    const mgr: any = makeManager();
    armSweepSell(mgr);
    assert.strictEqual(isLastFillPlacementBlocked(mgr, SWEEP_SELL, ORDER_TYPES.SELL).blocked, true);
    assert.strictEqual(resetLastFillPivot(mgr, 'grid rebuild'), true);
    assert.strictEqual(mgr._lastFilledPrice, null);
    // The bot-scoped market-fill row is deliberately NOT cleared by a grid
    // rebuild: it survives regeneration and keeps the guard armed.
    assert.strictEqual(isLastFillPlacementBlocked(mgr, SWEEP_SELL, ORDER_TYPES.SELL).blocked, true);
    // Only the full watchdog expiry drops BOTH references.
    expireLastFillGuardReferences(mgr, 'test full clear');
    assert.strictEqual(mgr._lastMarketFillPrice, null);
    assert.strictEqual(isLastFillPlacementBlocked(mgr, SWEEP_SELL, ORDER_TYPES.SELL).blocked, false);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

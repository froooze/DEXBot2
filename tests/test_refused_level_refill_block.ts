/**
 * REFUSED-LEVEL SAME-LEVEL RE-FILL BLOCK (§9.12/P2 amended, 2026-11-16).
 *
 * A fill the pivot-arming policy refuses (§9.12/P1: wrong-side / too-far
 * premium sweep) must NOT arm the direction pivot — that policy is settled and
 * pinned by test_last_fill_pivot_market_bound. But the §9.12/P2 same-level
 * refusal keys off the ARMED pivot, so the P1 refusal silently suspended it:
 * the just-filled level could be re-placed (sub-sat dust "rises") and refill
 * in a loop for as long as a taker kept lifting it. Live: one premium
 * spread-correction slot refilled 5 times in 2.5 minutes at the same level.
 *
 * Pinned here:
 *   1. The refusal writes an in-memory refused-level marker (price/type/at)
 *      WITHOUT arming the pivot family or the market-fill row.
 *   2. evaluateLastFillGuard — the shared COW-path verdict — blocks a
 *      same-side placement within half a grid step of the refused level,
 *      flagged refusedLevel, even though the (older) direction pivot passes it.
 *   3. A placement beyond half a step passes; the counter-side passes.
 *   4. The marker expires after GRID_LIMITS.LAST_FILL_REFUSED_LEVEL_TTL_MS.
 *   5. isLastFillPlacementBlocked reports it as reason 'refused-level' —
 *      including on a COLD direction pivot.
 *   6. resetLastFillPivot clears the marker (grid rebuild invalidates it).
 *   7. A NORMAL (window) fill never writes the marker.
 */

const assert = require('assert');
const {
    setLastFillPivot,
    evaluateLastFillGuard,
    isLastFillPlacementBlocked,
    resetLastFillPivot
} = require('../modules/order/utils/system');
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
        _lastRefusedFillPrice: null as number | null,
        _lastRefusedFillType: null as string | null,
        _lastRefusedFillAt: 0,
        _liveMarketPrice: null as number | null,
        _liveMarketPriceAt: null as number | null,
        config: { incrementPercent: 0.5 },
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        ...over
    };
}

// Sweep geometry (increment 0.5%): mid 1000, SELL 7 steps above mid exceeds
// LAST_FILL_PIVOT_MAX_MID_DISTANCE_STEPS (6) and is refused as a premium sweep.
const MID = 1000;
const SWEEP_SELL = 1050;   // ~9.8 steps above mid
const NOW_MS = Date.now();
const FRESH_MID_AT = NOW_MS - 5_000;

function refuseSweepSell(mgr: any): void {
    mgr._liveMarketPrice = MID;
    mgr._liveMarketPriceAt = FRESH_MID_AT;
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, SWEEP_SELL, 'fill'), false,
        'a premium sweep sell ~10 steps above mid must be refused from arming');
}

// ── 1. The refusal writes the marker without arming anything ─────────────────

run('REFUSED-1 the refusal writes the marker and leaves the pivot family cold', () => {
    const mgr: any = makeManager();
    refuseSweepSell(mgr);
    assert.strictEqual(mgr._lastRefusedFillPrice, SWEEP_SELL, 'the refused level must be marked');
    assert.strictEqual(mgr._lastRefusedFillType, ORDER_TYPES.SELL);
    assert.ok(mgr._lastRefusedFillAt > 0, 'the marker must carry a timestamp for its TTL');
    assert.strictEqual(mgr._lastFilledPrice, null, 'the direction pivot must stay untouched');
    assert.strictEqual(mgr._lastMarketFillPrice, null, 'the market-fill row must stay skipped');
    assert.ok(mgr.logs.some((l: any) => /same-level re-fill/.test(l.msg)),
        'the refusal log must state the same-level block');
});

run('REFUSED-2 the refusal does not displace an already-armed pivot', () => {
    const mgr: any = makeManager({ _lastFilledPrice: 900, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW_MS - 60_000, _lastFilledBuyPrice: 900, lastFillPivotSource: 'fill' });
    refuseSweepSell(mgr);
    assert.strictEqual(mgr._lastFilledPrice, 900, 'the older window pivot must stay');
    assert.strictEqual(mgr._lastFilledType, ORDER_TYPES.BUY);
    assert.strictEqual(mgr._lastRefusedFillPrice, SWEEP_SELL);
});

run('REFUSED-3 a normal window fill never writes the marker', () => {
    const mgr: any = makeManager();
    mgr._liveMarketPrice = MID;
    mgr._liveMarketPriceAt = FRESH_MID_AT;
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, MID * 1.005, 'fill'), true, 'sell one step above mid is a window trade');
    assert.strictEqual(mgr._lastRefusedFillPrice, null, 'an accepted fill must not write the marker');
});

// ── 2. The shared verdict blocks the same-level re-fill ──────────────────────

run('REFUSED-4 evaluateLastFillGuard blocks the same-side same-level re-place (refusedLevel)', () => {
    const mgr: any = makeManager({ _lastFilledPrice: 900, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW_MS - 60_000, _lastFilledBuyPrice: 900, lastFillPivotSource: 'fill' });
    refuseSweepSell(mgr);
    // SELL at the refused level (direction pivot 900 passes it — this is the
    // exact loop shape the amendment closes).
    const check = evaluateLastFillGuard(mgr, SWEEP_SELL + 0.0001, ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
    assert.strictEqual(check.blocked, true, 'the same-level re-fill must be blocked');
    assert.strictEqual((check as any).refusedLevel, true, 'the verdict must be flagged refusedLevel');
    assert.strictEqual(check.pivot, SWEEP_SELL, 'the reported pivot is the refused level');
});

run('REFUSED-5 half a step bounds the block: beyond it, or the counter-side, passes', () => {
    const mgr: any = makeManager({ _lastFilledPrice: 900, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW_MS - 60_000, _lastFilledBuyPrice: 900, lastFillPivotSource: 'fill' });
    refuseSweepSell(mgr);
    // Half a step at 1050 with 0.5% increment is 1050 * 0.0025 = 2.625.
    const ok = evaluateLastFillGuard(mgr, SWEEP_SELL - 5, ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
    assert.strictEqual(ok.blocked, false, 'a placement more than half a step below the refused level passes');
    const counter = evaluateLastFillGuard(mgr, 850, ORDER_TYPES.BUY, 900, ORDER_TYPES.SELL);
    assert.strictEqual(counter.blocked, false, 'the counter-side is governed by the direction pivot alone');
});

run('REFUSED-6 the marker expires after LAST_FILL_REFUSED_LEVEL_TTL_MS', () => {
    const ttl = Number(GRID_LIMITS.LAST_FILL_REFUSED_LEVEL_TTL_MS);
    assert.ok(ttl > 0 && ttl < Number(GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS), 'the marker TTL must be positive and shorter than the pivot TTL');
    const mgr: any = makeManager({ _lastFilledPrice: 900, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW_MS - 60_000, _lastFilledBuyPrice: 900, lastFillPivotSource: 'fill' });
    refuseSweepSell(mgr);
    mgr._lastRefusedFillAt = Date.now() - ttl - 1000;
    const check = evaluateLastFillGuard(mgr, SWEEP_SELL, ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
    assert.strictEqual(check.blocked, false, 'an expired marker must not veto');
});

// ── 3. The reconcile/startup path reports the right reason ───────────────────

run('REFUSED-7 isLastFillPlacementBlocked reports reason refused-level (armed pivot)', () => {
    const mgr: any = makeManager({ _lastFilledPrice: 900, _lastFilledType: ORDER_TYPES.BUY, _lastFilledAt: NOW_MS - 60_000, _lastFilledBuyPrice: 900, lastFillPivotSource: 'fill' });
    refuseSweepSell(mgr);
    const guard = isLastFillPlacementBlocked(mgr, SWEEP_SELL, ORDER_TYPES.SELL);
    assert.strictEqual(guard.blocked, true);
    assert.strictEqual(guard.reason, 'refused-level');
    assert.strictEqual(guard.pivot, SWEEP_SELL);
});

run('REFUSED-8 isLastFillPlacementBlocked still blocks on a COLD direction pivot', () => {
    const mgr: any = makeManager();
    refuseSweepSell(mgr);
    const guard = isLastFillPlacementBlocked(mgr, SWEEP_SELL, ORDER_TYPES.SELL);
    assert.strictEqual(guard.blocked, true, 'the marker must hold on a cold pivot too');
    assert.strictEqual(guard.reason, 'refused-level');
});

// ── 4. Lifecycle ──────────────────────────────────────────────────────────────

run('REFUSED-9 resetLastFillPivot clears the marker', () => {
    const mgr: any = makeManager();
    refuseSweepSell(mgr);
    assert.strictEqual(mgr._lastRefusedFillPrice, SWEEP_SELL);
    resetLastFillPivot(mgr, 'grid rebuild');
    assert.strictEqual(mgr._lastRefusedFillPrice, null);
    assert.strictEqual(mgr._lastRefusedFillType, null);
    assert.strictEqual(mgr._lastRefusedFillAt, 0);
    const check = evaluateLastFillGuard(mgr, SWEEP_SELL, ORDER_TYPES.SELL, null, null);
    assert.strictEqual(check.blocked, false, 'after the reset the placement must pass again');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

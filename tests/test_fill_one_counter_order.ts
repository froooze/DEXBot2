/**
 * ONE FILL → ONE COUNTER ORDER — multi-rung sweep refused-level marker.
 *
 * A premium sweep lifts several adjacent rungs in one batch. Every one of
 * those fills is refused from arming the direction pivot (§9.12/P1), and the
 * same-level block (§9.12/P2) used to key off the single armed pivot — so all
 * of them could be re-placed at the identical level and lifted again. Live
 * 2026-11-18: five adjacent premium rungs refilled repeatedly in ~7 minutes.
 *
 * The single owner is the refused-level marker in modules/order/utils/system.ts.
 * It now holds the WHOLE refused batch (TTL-bounded, same as before), so every
 * placement path — COW probe/final gate, startup reconcile, spread correction —
 * blocks every rung that actually traded, while the counter side and prices the
 * market never touched stay placeable. No cooldown, no band, no new guard.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    setLastFillPivot,
    evaluateLastFillGuard,
    isLastFillPlacementBlocked,
    hasLiveRefusedFillLevels,
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

const MID = 1000;
const INC = 0.5;
const NOW = Date.now();
// Five adjacent rungs 7..11 steps above a fresh mid — all premium sweeps.
const SWEEP = [1035, 1040, 1045, 1050, 1055];

function makeManager(over: Record<string, unknown> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    return {
        _lastFilledPrice: null as number | null,
        _lastFilledType: null as string | null,
        _lastFilledAt: 0,
        _lastFilledBuyPrice: null as number | null,
        _lastFilledSellPrice: null as number | null,
        _lastMarketFillPrice: null as number | null,
        _lastMarketFillType: null as string | null,
        _lastMarketFillAt: 0,
        _lastRefusedFillPrice: null as number | null,
        _lastRefusedFillType: null as string | null,
        _lastRefusedFillAt: 0,
        _lastRefusedFillLevels: [] as Array<{ price: number; type: string; at: number }>,
        _liveMarketPrice: MID,
        _liveMarketPriceAt: NOW - 5_000,
        config: { incrementPercent: INC },
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        ...over
    };
}

function refuseAll(mgr: any, prices: number[] = SWEEP) {
    for (const p of prices) {
        assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, p, 'fill'), false,
            `${p} is a premium sweep and must be refused from arming`);
    }
}

// An older legitimate BUY pivot: a SELL at any sweep level passes the direction
// rule, so only the refused-level marker can block it (the live loop shape).
function withOldBuyPivot(mgr: any) {
    mgr._lastFilledPrice = 900;
    mgr._lastFilledType = ORDER_TYPES.BUY;
    mgr._lastFilledAt = NOW - 60_000;
    mgr._lastFilledBuyPrice = 900;
    mgr.lastFillPivotSource = 'fill';
}

// ---------------------------------------------------------------------------

run('MULTI-1 every rung of the sweep is recorded, not just the last one', () => {
    const mgr: any = makeManager();
    refuseAll(mgr);
    assert.deepStrictEqual(mgr._lastRefusedFillLevels.map((e: any) => e.price), SWEEP);
    assert.strictEqual(mgr._lastRefusedFillType, ORDER_TYPES.SELL);
});

run('MULTI-2 the shared COW verdict blocks a same-level re-place at EVERY rung', () => {
    const mgr: any = makeManager();
    withOldBuyPivot(mgr);
    refuseAll(mgr);
    for (const p of SWEEP) {
        const check = evaluateLastFillGuard(mgr, p + 0.0001, ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
        assert.strictEqual(check.blocked, true, `SELL at refused level ${p} must be blocked`);
        assert.strictEqual((check as any).refusedLevel, true);
        assert.strictEqual(check.pivot, p);
    }
});

run('MULTI-3 the reconcile/startup placement guard blocks every rung with reason refused-level', () => {
    const mgr: any = makeManager();
    withOldBuyPivot(mgr);
    refuseAll(mgr);
    for (const p of SWEEP) {
        const guard = isLastFillPlacementBlocked(mgr, p, ORDER_TYPES.SELL);
        assert.strictEqual(guard.blocked, true, `SELL ${p} must be blocked on the placement path too`);
        assert.strictEqual(guard.reason, 'refused-level');
        assert.strictEqual(guard.pivot, p);
    }
});

run('MULTI-4 only levels that actually traded are vetoed; the next rung stays placeable', () => {
    const mgr: any = makeManager();
    withOldBuyPivot(mgr);
    refuseAll(mgr);
    // Half step at 1055 with 0.5% increment is ~2.6; 1060 is the next rung.
    const next = evaluateLastFillGuard(mgr, 1060, ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
    assert.strictEqual(next.blocked, false, 'the next rung up must stay placeable');
    const below = evaluateLastFillGuard(mgr, 1010, ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
    assert.strictEqual(below.blocked, false, 'a price the market never touched stays placeable');
});

run('MULTI-5 the counter side is not vetoed by the SELL marker', () => {
    const mgr: any = makeManager();
    refuseAll(mgr);
    // Cold direction pivot: only the marker can judge this BUY, and it is
    // same-side-only, so a BUY at a refused SELL level is the counter order.
    const counter = evaluateLastFillGuard(mgr, 1050, ORDER_TYPES.BUY, null, null);
    assert.strictEqual(counter.blocked, false, 'a BUY at a refused SELL level is the counter order');
});

run('MULTI-6 re-refusing a level dedupes it and refreshes its TTL', () => {
    const mgr: any = makeManager();
    refuseAll(mgr, [SWEEP[0], SWEEP[1]]);
    const before = mgr._lastRefusedFillLevels.map((e: any) => e.at);
    setLastFillPivot(mgr, ORDER_TYPES.SELL, SWEEP[1] + 0.0001, 'fill');
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 2, 'same level must not create a second entry');
    assert.ok(mgr._lastRefusedFillLevels[1].at >= before[1], 'the re-refused level TTL is refreshed');
});

run('MULTI-7 per-level expiry: a stale rung passes while fresh ones still block', () => {
    const mgr: any = makeManager();
    withOldBuyPivot(mgr);
    refuseAll(mgr);
    const ttl = Number(GRID_LIMITS.LAST_FILL_REFUSED_LEVEL_TTL_MS);
    mgr._lastRefusedFillLevels[0].at = Date.now() - ttl - 1000;
    const stale = evaluateLastFillGuard(mgr, SWEEP[0], ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
    assert.strictEqual(stale.blocked, false, 'an expired rung must not veto');
    const fresh = evaluateLastFillGuard(mgr, SWEEP[4], ORDER_TYPES.SELL, 900, ORDER_TYPES.BUY);
    assert.strictEqual(fresh.blocked, true, 'the other rungs stay blocked');
});

run('MULTI-8 an accepted window fill does not write the marker', () => {
    const mgr: any = makeManager();
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, MID * 1.005, 'fill'), true);
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 0);
});

run('MULTI-9 reset clears the whole set', () => {
    const mgr: any = makeManager();
    withOldBuyPivot(mgr);
    refuseAll(mgr);
    resetLastFillPivot(mgr, 'grid rebuild');
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 0);
    assert.strictEqual(mgr._lastRefusedFillPrice, null);
    const check = evaluateLastFillGuard(mgr, SWEEP[0], ORDER_TYPES.SELL, null, null);
    assert.strictEqual(check.blocked, false);
});

run('MULTI-10 multi-chunk fill batches accumulate on the manager, survive accepted fills', () => {
    const mgr: any = makeManager();
    withOldBuyPivot(mgr);
    // Simulate _processFillsWithBatching: chunk 1 lifts two rungs, chunk 2 the
    // remaining three. The marker lives on the manager, not on one plan/chunk.
    for (const p of SWEEP.slice(0, 2)) setLastFillPivot(mgr, ORDER_TYPES.SELL, p, 'fill');
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 2, 'chunk 1 recorded its two rungs');
    for (const p of SWEEP.slice(2)) setLastFillPivot(mgr, ORDER_TYPES.SELL, p, 'fill');
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 5, 'chunk 2 added its three rungs');

    // A legitimate window fill between chunks must not wipe earlier refusals.
    assert.strictEqual(setLastFillPivot(mgr, ORDER_TYPES.SELL, MID * 1.005, 'fill'), true);
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 5, 'an accepted fill leaves the marker set intact');

    // After both chunks every rung still blocks; the marker lives on the
    // manager, so a stale-plan re-plan (no `fills` carry) sees the same set.
    for (const p of SWEEP) {
        const guard = isLastFillPlacementBlocked(mgr, p, ORDER_TYPES.SELL);
        assert.strictEqual(guard.blocked, true, `rung ${p} from an earlier chunk must stay blocked`);
        assert.strictEqual(guard.reason, 'refused-level');
    }
});

run('MULTI-11 cap is TTL-aware: expired entries pruned, oldest clock evicted', () => {
    const mgr: any = makeManager();
    const many = Array.from({ length: 64 }, (_, i) => 1100 + i * 10);
    refuseAll(mgr, many);
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 64, 'cap reached');
    const ttl = Number(GRID_LIMITS.LAST_FILL_REFUSED_LEVEL_TTL_MS);
    // entry 0 is old-but-live, entry 1 was just refreshed — a just-refreshed
    // level must never be evicted ahead of a staler one by insertion order.
    mgr._lastRefusedFillLevels[0].at = Date.now() - ttl + 1000;
    mgr._lastRefusedFillLevels[1].at = Date.now();
    const refreshedPrice = mgr._lastRefusedFillLevels[1].price;
    setLastFillPivot(mgr, ORDER_TYPES.SELL, 1100 + 64 * 10, 'fill');
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 64);
    assert.ok(!mgr._lastRefusedFillLevels.some((e: any) => e.price === many[0]), 'oldest clock evicted');
    assert.ok(mgr._lastRefusedFillLevels.some((e: any) => e.price === refreshedPrice), 'refreshed level survives');

    // an EXPIRED entry is pruned before the cap, not shifted ahead of fresh ones
    mgr._lastRefusedFillLevels[0].at = Date.now() - ttl - 1000;
    const expiredPrice = mgr._lastRefusedFillLevels[0].price;
    setLastFillPivot(mgr, ORDER_TYPES.SELL, 1100 + 65 * 10, 'fill');
    assert.strictEqual(mgr._lastRefusedFillLevels.length, 64);
    assert.ok(!mgr._lastRefusedFillLevels.some((e: any) => e.price === expiredPrice), 'expired entry pruned');
});

run('MULTI-12 a refused fill is fill evidence for the spread-correction bypass', () => {
    const mgr: any = makeManager();
    assert.strictEqual(hasLiveRefusedFillLevels(mgr), false, 'cold manager has no evidence');
    refuseAll(mgr, [SWEEP[0]]);
    assert.strictEqual(hasLiveRefusedFillLevels(mgr), true);
    const ttl = Number(GRID_LIMITS.LAST_FILL_REFUSED_LEVEL_TTL_MS);
    mgr._lastRefusedFillLevels[0].at = Date.now() - ttl - 1000;
    assert.strictEqual(hasLiveRefusedFillLevels(mgr), false, 'an expired marker is not evidence');
    refuseAll(mgr, [SWEEP[0]]);
    resetLastFillPivot(mgr, 'grid rebuild');
    assert.strictEqual(hasLiveRefusedFillLevels(mgr), false, 'grid reset clears evidence');
});

run('MULTI-13 (shape check) planner has no cold-pivot short-circuit', () => {
    // The COW bypass gate is covered BEHAVIORALLY in test_spread_market_reference
    // (SMR-6). prepareSpreadCorrectionOrders has no light unit seam, so this one
    // half stays a labelled shape check against the source, __dirname-relative
    // so it does not depend on the runner's working directory.
    const grid = fs.readFileSync(path.join(__dirname, '../../modules/order/grid.ts'), 'utf8');
    assert.ok(!/lastFillPivot == null \|\| lastFillSide == null/.test(grid),
        'spread-correction planner must not short-circuit the guard on a cold pivot');
});

run('MULTI-14 single-field legacy managers still work (scalar fallback)', () => {
    const mgr: any = makeManager();
    delete mgr._lastRefusedFillLevels;
    mgr._lastRefusedFillPrice = SWEEP[2];
    mgr._lastRefusedFillType = ORDER_TYPES.SELL;
    mgr._lastRefusedFillAt = Date.now();
    const guard = isLastFillPlacementBlocked(mgr, SWEEP[2], ORDER_TYPES.SELL);
    assert.strictEqual(guard.blocked, true);
    assert.strictEqual(guard.reason, 'refused-level');
});

console.log(`\nONE-FILL-ONE-COUNTER: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/**
 * PIVOT GEOMETRY ELIGIBILITY + VETO TERRITORY (retrospective §9.6 / §9.7 / §9.12).
 *
 * Two halves of the same rule — "which fill may become the pivot, and where may
 * that pivot veto a placement?":
 *
 *   ELIGIBILITY (recordLastFilledPrices): every real fill arms the pivot —
 *   including a gap-band residual and a fill far from a cached mid. Only
 *   edge-pinned insurance stays excluded. The former geometry/market filters
 *   were the incident's root cause, not a safeguard.
 *
 *   TERRITORY (isLastFillBandSellExempt): the direction rule is meant for a
 *   geometry fault ("a sell slot below the last sale means the crawl is behind
 *   the fill", §9.7). When the boundary already satisfies the fill re-anchor
 *   (`boundary >= pivotIdx - gapSlots`) the band IS the counter-order zone, so
 *   the pivot must not veto it. SELL only: the BUY mirror sits above the fill
 *   and is the chase class the guard exists for.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../modules/constants');
const { isLastFillBandSellExempt, isLastFillPlacementBlocked, evaluateLastFillGuard, reanchorBoundaryFromLastFill } = require('../modules/order/utils/system');
const { getSellStartIdx, resolveGapSlots } = require('../modules/order/utils/math');

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

const BOUNDARY = 20;
const GAP = 4;
const INC = 0.5;
const SIZE = 40;
const BASE = 1000;
const SELL_START = getSellStartIdx(BOUNDARY, GAP); // 25

const levels: number[] = Array.from({ length: SIZE }, (_, i) => BASE * Math.pow(1 + INC / 100, i));

function slotFor(idx: number, state: string, size: number, orderId: string | null = null) {
    const type = idx <= BOUNDARY ? ORDER_TYPES.BUY
        : (idx >= SELL_START ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
    return { id: `slot-${idx}`, type, state, price: levels[idx], size, orderId, rawOnChain: orderId ? {} : null };
}

function buildOrders() {
    const orders = new Map<string, any>();
    for (let i = 0; i < SIZE; i++) {
        orders.set(`slot-${i}`, slotFor(i, ORDER_STATES.VIRTUAL, 0));
    }
    // 20 live buys at/below the boundary.
    for (let i = BOUNDARY - 19; i <= BOUNDARY; i++) {
        orders.set(`slot-${i}`, slotFor(i, ORDER_STATES.ACTIVE, 10, `1.7.${1000 + i}`));
    }
    // 15 live sells on the rail (sellStart..SIZE-1).
    for (let i = SELL_START; i < SIZE; i++) {
        orders.set(`slot-${i}`, slotFor(i, ORDER_STATES.ACTIVE, 10, `1.7.${2000 + i}`));
    }
    return orders;
}

const NOW = Date.now();

function makeManager(over: Record<string, unknown> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    const orders = buildOrders();
    return {
        orders,
        boundaryIdx: BOUNDARY,
        _gapSlots: GAP,
        _genesis: { priceLevels: levels },
        config: { incrementPercent: INC, targetSpreadPercent: 1.5 },
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        // pivot family (fill-provenanced SELL at the band top: slot 24)
        _lastFilledPrice: levels[BOUNDARY + GAP] as number | null,
        _lastFilledType: ORDER_TYPES.SELL as string | null,
        _lastFilledAt: NOW,
        lastFillPivotSource: 'fill' as string | null,
        _lastFilledBuyPrice: null as number | null,
        _lastFilledSellPrice: levels[BOUNDARY + GAP] as number | null,
        _lastMarketFillPrice: levels[BOUNDARY + GAP] as number | null,
        _lastMarketFillType: ORDER_TYPES.SELL as string | null,
        _lastMarketFillAt: NOW,
        _liveMarketPrice: null as number | null,
        _liveMarketPriceAt: null as number | null,
        ...over
    };
}

// ── 1. Veto territory: the band the fill anchor derives ───────────

run('GEO-1 a SELL inside the band the fill anchor derives is exempt', () => {
    const mgr: any = makeManager();
    // Band is (20, 24]; the pivot sits at 24 (the band top) by construction.
    // The pivot level itself is deliberately NOT exempt: same-level re-fills
    // remain blocked; only the lower counter-order rungs are exempt.
    for (const idx of [21, 22, 23]) {
        assert.strictEqual(isLastFillBandSellExempt(mgr, levels[idx]), true,
            `band slot-${idx} must be exempt (boundary ${BOUNDARY}, pivotIdx 24, gap ${GAP})`);
    }
});

run('GEO-2 the placement guard allows band sells but still refuses a re-place at the pivot level', () => {
    const mgr: any = makeManager();
    assert.strictEqual(isLastFillBandSellExempt(mgr, levels[24]), false,
        'the filled level itself must never be exempt');
    const sharedBand = evaluateLastFillGuard(mgr, levels[22], ORDER_TYPES.SELL, levels[24], ORDER_TYPES.SELL);
    assert.strictEqual(sharedBand.blocked, false, 'the shared COW/final-gate verdict allows the band counter-order');
    const sharedSame = evaluateLastFillGuard(mgr, levels[24], ORDER_TYPES.SELL, levels[24], ORDER_TYPES.SELL);
    assert.strictEqual(sharedSame.blocked, true, 'the shared verdict still blocks same-level re-fills');
    const band = isLastFillPlacementBlocked(mgr, levels[22], ORDER_TYPES.SELL);
    assert.strictEqual(band.blocked, false, 'a band counter-order must be placeable');
    const sameLevel = isLastFillPlacementBlocked(mgr, levels[24], ORDER_TYPES.SELL);
    assert.strictEqual(sameLevel.blocked, true, 'a re-place AT the filled level stays blocked');
    assert.strictEqual(sameLevel.reason, 'same-level');
    const railAbove = isLastFillPlacementBlocked(mgr, levels[26], ORDER_TYPES.SELL);
    assert.strictEqual(railAbove.blocked, false, 'a sell above the pivot is allowed by direction anyway');
});

run('GEO-3 no exemption when the geometry is BEHIND the fill (the §9.7 fault)', () => {
    // boundary 19 < pivotIdx - gap (20): the crawl is one level behind the fill,
    // exactly the case the direction rule exists to refuse. No exemption.
    const mgr: any = makeManager({ boundaryIdx: BOUNDARY - 1 });
    assert.strictEqual(isLastFillBandSellExempt(mgr, levels[22]), false);
    assert.strictEqual(isLastFillPlacementBlocked(mgr, levels[22], ORDER_TYPES.SELL).blocked, true,
        'a lower sell with the window behind the fill must stay refused');
});

run('GEO-4 BUY placements are never exempt (the chase mirror stays closed)', () => {
    // Mirror pivot: a BUY fill at the band top. The exemption must not exist for
    // buys — after a BUY fill the band sits ABOVE the fill, and a buy above the
    // last buy is the "buying later at higher prices" class (§9.7).
    const buyPivot: any = makeManager({
        _lastFilledPrice: levels[BOUNDARY + GAP],
        _lastFilledType: ORDER_TYPES.BUY,
        _lastFilledBuyPrice: levels[BOUNDARY + GAP],
        _lastFilledSellPrice: null,
        _lastMarketFillPrice: levels[BOUNDARY + GAP],
        _lastMarketFillType: ORDER_TYPES.BUY
    });
    assert.strictEqual(isLastFillBandSellExempt(buyPivot, levels[22]), false,
        'a BUY pivot never grants a geometry exemption');
    const higherBuy = isLastFillPlacementBlocked(buyPivot, levels[SELL_START], ORDER_TYPES.BUY);
    assert.strictEqual(higherBuy.blocked, true, 'a BUY above the last buy stays refused');
    assert.strictEqual(higherBuy.reason, 'direction');
});

run('GEO-5 out-of-band prices fail closed; an unknown gap resolves to the config band', () => {
    const mgr: any = makeManager();
    assert.strictEqual(isLastFillBandSellExempt(mgr, levels[SELL_START + 3]), false,
        'a rail sell above the band is not exempt (direction already allows it)');
    assert.strictEqual(isLastFillBandSellExempt(mgr, levels[22] * 1.5), false,
        'a price far above the band cannot invent an exemption');
    assert.strictEqual(isLastFillBandSellExempt(mgr, levels[22] * 0.5), false,
        'a price far below the rail cannot invent an exemption');
    const noGenesis: any = makeManager({ _genesis: null });
    assert.strictEqual(isLastFillBandSellExempt(noGenesis, levels[22]), false, 'no genesis => no exemption');
    // A blank gap is UNKNOWN, not gap 0 (§9.6): resolveGapSlots substitutes
    // the config-derived band. The old assertion ("no exemption") passed only
    // by arithmetic luck — the fixture's config gap (2) kept
    // boundary(20) < pivotIdx(24) - 2 = 22. Pin the CONTRACT instead: with a
    // config that derives the real gap 4, the same blank gap grants the
    // exemption. A gap-0 coercion would make both cases diverge.
    const blankGap: any = makeManager({ _gapSlots: null });
    const wideConfig: any = makeManager({
        _gapSlots: null,
        config: { incrementPercent: INC, targetSpreadPercent: 2.5 },
    });
    assert.strictEqual(resolveGapSlots(blankGap), 2, 'blank gap falls back to the fixture config band');
    assert.strictEqual(resolveGapSlots(wideConfig), 4, 'a 2.5% target derives the real 4-slot band');
    assert.strictEqual(isLastFillBandSellExempt(blankGap, levels[22]), false,
        'config-derived gap 2 still leaves the pivot ahead of this rung');
    assert.strictEqual(isLastFillBandSellExempt(wideConfig, levels[22]), true,
        'config-derived gap 4 grants the exemption — blank is not gap 0');
    const noBoundary: any = makeManager({ boundaryIdx: null });
    assert.strictEqual(isLastFillBandSellExempt(noBoundary, levels[22]), false, 'unknown boundary => no exemption');
});

run('GEO-6 a book-seeded / cold pivot gets no geometry exemption', () => {
    const bookSeed: any = makeManager({ lastFillPivotSource: 'book', _lastMarketFillPrice: null, _lastMarketFillAt: 0 });
    assert.strictEqual(isLastFillBandSellExempt(bookSeed, levels[22]), false,
        'the exemption is anchored to a FILL fact, not a book heuristic');
    const cold: any = makeManager({ _lastFilledPrice: null, _lastFilledType: null, _lastMarketFillPrice: null, _lastFilledAt: 0, _lastMarketFillAt: 0 });
    assert.strictEqual(isLastFillBandSellExempt(cold, levels[22]), false);
});

// ── 2. Arming eligibility: in-band fills ──────────────────────────

run('ELIG-1 a gap-band fill now arms the pivot (single writer)', () => {
    const mgr: any = Object.create(OrderManager.prototype);
    Object.assign(mgr, makeManager());
    mgr._lastFilledPrice = null;
    mgr._lastFilledType = null;
    mgr._lastFilledAt = 0;
    mgr.lastFillPivotSource = null;
    mgr._lastFilledSellPrice = null;
    mgr._lastMarketFillPrice = null;
    mgr._lastMarketFillType = null;
    mgr._lastMarketFillAt = 0;

    // slot-22 is inside the band (21..24); a residual that traded is still a fill.
    OrderManager.prototype.recordLastFilledPrices.call(mgr, [
        { id: 'slot-22', type: ORDER_TYPES.SELL, price: levels[22], isPartial: true }
    ]);
    assert.strictEqual(mgr._lastFilledPrice, levels[22], 'a band residual arms the guard');
    assert.strictEqual(mgr._lastMarketFillPrice, levels[22], 'and writes the market-fill reference');
    assert.ok(!mgr.logs.some((l: any) => /gap-band \(stranded residual\)|band-skipped/.test(l.msg)),
        `no geometry skip may be logged (got: ${mgr.logs.map((l: any) => l.msg).join(' | ')})`);
});

run('ELIG-2 a rail fill still arms the pivot', () => {
    const mgr: any = Object.create(OrderManager.prototype);
    Object.assign(mgr, makeManager());
    mgr._lastFilledPrice = null;
    mgr._lastFilledType = null;
    mgr._lastFilledAt = 0;
    mgr.lastFillPivotSource = null;
    mgr._lastFilledSellPrice = null;
    mgr._lastMarketFillPrice = null;
    mgr._lastMarketFillType = null;
    mgr._lastMarketFillAt = 0;

    OrderManager.prototype.recordLastFilledPrices.call(mgr, [
        { id: `slot-${SELL_START}`, type: ORDER_TYPES.SELL, price: levels[SELL_START], isPartial: false }
    ]);
    assert.strictEqual(mgr._lastFilledPrice, levels[SELL_START], 'a rail sell fill arms the pivot');
    assert.strictEqual(mgr._lastFilledType, ORDER_TYPES.SELL);
});

run('ELIG-3 both fills are armed; the last processed fill wins the pivot', () => {
    const mgr: any = Object.create(OrderManager.prototype);
    Object.assign(mgr, makeManager());
    mgr._lastFilledPrice = null;
    mgr._lastFilledType = null;
    mgr._lastFilledAt = 0;
    mgr.lastFillPivotSource = null;
    mgr._lastFilledSellPrice = null;
    mgr._lastMarketFillPrice = null;
    mgr._lastMarketFillType = null;
    mgr._lastMarketFillAt = 0;

    OrderManager.prototype.recordLastFilledPrices.call(mgr, [
        { id: 'slot-22', type: ORDER_TYPES.SELL, price: levels[22], isPartial: true },
        { id: `slot-${SELL_START + 5}`, type: ORDER_TYPES.SELL, price: levels[SELL_START + 5], isPartial: false }
    ]);
    assert.strictEqual(mgr._lastFilledPrice, levels[SELL_START + 5],
        'the batch pivot is the last fill (recordLastFilledPrices walks in order)');
    assert.strictEqual(mgr._lastMarketFillPrice, levels[SELL_START + 5]);
    assert.ok(!mgr.logs.some((l: any) => /band-skipped/.test(l.msg)),
        'the band residual is no longer skipped');
});

run('ELIG-4 unreadable geometry fails open (a cold grid still arms on its first fill)', () => {
    const mgr: any = Object.create(OrderManager.prototype);
    Object.assign(mgr, makeManager({ boundaryIdx: null, _gapSlots: null }));
    mgr._lastFilledPrice = null;
    mgr._lastFilledType = null;
    mgr._lastFilledAt = 0;
    mgr.lastFillPivotSource = null;
    mgr._lastFilledSellPrice = null;
    mgr._lastMarketFillPrice = null;
    mgr._lastMarketFillType = null;
    mgr._lastMarketFillAt = 0;

    OrderManager.prototype.recordLastFilledPrices.call(mgr, [
        { id: 'slot-22', type: ORDER_TYPES.SELL, price: levels[22], isPartial: false }
    ]);
    assert.strictEqual(mgr._lastFilledPrice, levels[22],
        'without geometry the classifier must not guess (fail-open like collectEdgePinnedFillIds)');
});

run('ELIG-5 the legacy distance bound is inert on the fill path', () => {
    assert.ok(Number(GRID_LIMITS.LAST_FILL_PIVOT_MAX_MID_DISTANCE_STEPS) >= 1,
        'the legacy knob may remain for compatibility');
    const { offMarketFill } = require('../modules/order/utils/system');
    assert.strictEqual(offMarketFill({ _liveMarketPrice: 1000, _liveMarketPriceAt: Date.now(), config: {} }, ORDER_TYPES.SELL, 2000), null,
        'the distance predicate can no longer close the sweep class');
});

run('ELIG-6 every fill arms the pivot AND may be the geometry extremum', () => {
    // The same batch goes through both consumers. A fill far from the cached
    // mid is now authoritative: it arms the guard (last processed fill) and
    // the furthest fill of that side drags the boundary to its own level.
    const mgr: any = Object.create(OrderManager.prototype);
    Object.assign(mgr, makeManager({
        _liveMarketPrice: levels[26],
        _liveMarketPriceAt: NOW
    }));
    const batch = [
        { id: 'slot-25', type: ORDER_TYPES.SELL, price: levels[25] },
        { id: 'slot-34', type: ORDER_TYPES.SELL, price: levels[34] }
    ];
    mgr._lastFilledPrice = null;
    mgr._lastFilledType = null;
    OrderManager.prototype.recordLastFilledPrices.call(mgr, batch);
    assert.strictEqual(mgr._lastFilledPrice, levels[34],
        'the far sweep fill arms the pivot: ' + JSON.stringify(mgr.logs.map((l: any) => l.msg)));
    assert.strictEqual(mgr._lastMarketFillPrice, levels[34]);

    // Virtual copies isolate the eligibility decision from stranding checks.
    const virtualSlots = Array.from(mgr.orders.values()).map((s: any) => ({
        ...s,
        orderId: null,
        state: ORDER_STATES.VIRTUAL,
        size: 0
    }));
    const r = reanchorBoundaryFromLastFill(mgr, 18, virtualSlots, GAP, batch);
    assert.strictEqual(r.fillSlot, 34, `the furthest sweep fill anchors: ${JSON.stringify(r)}`);
    assert.strictEqual(r.boundaryIdx, 30, 'a SELL fill at slot 34 => boundary 30 with gap 4');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

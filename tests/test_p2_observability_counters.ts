/**
 * tests/test_p2_observability_counters.ts
 *
 * P2 observability counters + the Mode C(a) gap-band shadow helper.
 *
 * Why this exists: the order-engine retrospective listed refused-commit /
 * orphan-fill / re-stamp-above-anchor / drift-beyond-active-window as
 * unmeasured open items, and Mode C(a) needed a non-blocking way to see an
 * in-gap placement before any enforcement policy is chosen. These are
 * counter-only signals: none of them may change placement behavior.
 *
 * Covers:
 *  - recordRestampBuyAboveAnchor (P2): BUY at/above a BUY pivot counts;
 *    lower BUY / SELL / other-side pivot / cold pivot do not; warn once/batch.
 *  - collectGapBandPlacementShadowSlots (Mode C(a)): non-spread-correction
 *    CREATE/rotation destinations inside the plan gap band; origins and
 *    out-of-band / unparseable / non-rail actions excluded; pure + never throws.
 *  - boundaryDriftExceedsWindowCount (P2) via StrategyEngine.calculateTargetGrid.
 *  - BotMetrics initialization exposes the new counters through getMetrics().
 *
 * Synthetic geometry only — no real pair names or account identifiers.
 */

const assert = require('assert');
const { recordRestampBuyAboveAnchor, collectGapBandPlacementShadowSlots } = require('../modules/dexbot_cow_runtime');
const { getSellStartIdx } = require('../modules/order/utils/math');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, COW_ORIGINS } = require('../modules/constants');

function makeBot(opts: any = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    return {
        _metrics: { restampBuyAboveAnchorCount: 0 },
        _currentCycleId: opts.cycleId ?? 1,
        manager: {
            _lastFilledType: opts.lastType === undefined ? ORDER_TYPES.BUY : opts.lastType,
            _lastFilledPrice: opts.lastPrice === undefined ? 1000 : opts.lastPrice,
            logger: { log: (msg: any, level?: string) => logs.push({ msg: String(msg), level }) },
        },
        logs,
    };
}

function testRestampBuyAboveAnchorCountsOnlyTheLeakShape() {
    console.log('\n - recordRestampBuyAboveAnchor counts the re-stamp shape only...');

    // BUY at the pivot -> counted.
    {
        const bot = makeBot();
        assert.strictEqual(recordRestampBuyAboveAnchor(bot, 1000, ORDER_TYPES.BUY), true, 'BUY at pivot counts');
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 1);
        // BUY above the pivot -> counted.
        assert.strictEqual(recordRestampBuyAboveAnchor(bot, 1005, ORDER_TYPES.BUY), true, 'BUY above pivot counts');
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 2);
    }
    // BUY below the pivot -> legitimate rotation target, not counted.
    {
        const bot = makeBot();
        assert.strictEqual(recordRestampBuyAboveAnchor(bot, 990, ORDER_TYPES.BUY), false, 'lower BUY not counted');
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 0);
    }
    // SELL above the pivot -> never counted (the guard permits sells above).
    {
        const bot = makeBot();
        assert.strictEqual(recordRestampBuyAboveAnchor(bot, 1010, ORDER_TYPES.SELL), false, 'SELL not counted');
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 0);
    }
    // BUY above pivot but last fill was a SELL -> not the re-stamp shape.
    {
        const bot = makeBot({ lastType: ORDER_TYPES.SELL });
        assert.strictEqual(recordRestampBuyAboveAnchor(bot, 1010, ORDER_TYPES.BUY), false, 'BUY after SELL fill not counted');
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 0);
    }
    // Cold pivot -> guard disabled, nothing counted.
    {
        const bot = makeBot({ lastPrice: null });
        assert.strictEqual(recordRestampBuyAboveAnchor(bot, 1000, ORDER_TYPES.BUY), false, 'cold pivot not counted');
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 0);
    }
    // Non-finite price -> not counted, never throws.
    {
        const bot = makeBot();
        assert.strictEqual(recordRestampBuyAboveAnchor(bot, NaN, ORDER_TYPES.BUY), false, 'NaN price not counted');
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 0);
    }

    // SAME GRID LEVEL counts too. Live: slot 1310.046339 filled at
    // 1310.060435, so the slot price is a rounding hair BELOW the pivot — the
    // re-stamp shape the guard blocks (via its ladder-snapped pivot), which a
    // bare `p < pivot` reads as a legitimate lower BUY and drops from the count.
    {
        const bot = makeBot({ lastPrice: 1310.060435 });
        (bot.manager as any).config = { incrementPercent: 0.3 };
        assert.strictEqual(
            recordRestampBuyAboveAnchor(bot, 1310.046339, ORDER_TYPES.BUY), true,
            'SAME-LEVEL BUY counted (rounding hair below the pivot)'
        );
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 1);
        // A genuine full step below is the legitimate rotation target.
        assert.strictEqual(
            recordRestampBuyAboveAnchor(bot, 1310.046339 / 1.003, ORDER_TYPES.BUY), false,
            'a full step below the pivot is not the re-stamp shape'
        );
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 1, 'still one');
    }

    // Warn is once per batch (cycle), but every leak is still counted.
    {
        const bot = makeBot({ cycleId: 7 });
        recordRestampBuyAboveAnchor(bot, 1001, ORDER_TYPES.BUY);
        recordRestampBuyAboveAnchor(bot, 1002, ORDER_TYPES.BUY);
        assert.strictEqual(bot._metrics.restampBuyAboveAnchorCount, 2, 'both leaks counted');
        assert.strictEqual(bot.logs.filter((l) => l.level === 'warn' && l.msg.includes('[RESTAMP-BUY]')).length, 1,
            'warn must be emitted at most once per batch');
    }

    console.log('  PASS');
}

function testGapBandShadowCollectsOnlySuspiciousRailPlacements() {
    console.log('\n - collectGapBandPlacementShadowSlots collects suspicious in-gap placements...');

    const boundary = 5;
    const gapSlots = 2; // sellStart = 8 -> gap band slots 6,7
    const sellStart = getSellStartIdx(boundary, gapSlots);
    assert.strictEqual(sellStart, 8, 'sanity: sellStart for boundary 5 / gap 2');

    const create = (id: string, extra: any = {}) => ({
        type: COW_ACTIONS.CREATE,
        id,
        order: { id, type: ORDER_TYPES.BUY, price: 1, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null },
        ...extra,
    });
    const rotation = (id: string, newGridId: string, extra: any = {}) => ({
        type: COW_ACTIONS.UPDATE,
        id,
        newGridId,
        orderId: '1.7.1',
        order: { id, type: ORDER_TYPES.BUY, price: 1, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.1' },
        ...extra,
    });

    // In-band CREATE counted; out-of-band CREATE not.
    assert.deepStrictEqual(
        collectGapBandPlacementShadowSlots([create('slot-6'), create('slot-0')], boundary, gapSlots),
        ['slot-6'],
        'only the in-band CREATE is collected'
    );
    // In-band rotation destination counted.
    assert.deepStrictEqual(
        collectGapBandPlacementShadowSlots([rotation('slot-6', 'slot-7')], boundary, gapSlots),
        ['slot-7'],
        'rotation destination is the geometry tested'
    );
    // Spread correction legitimately places into the band -> exempt.
    assert.deepStrictEqual(
        collectGapBandPlacementShadowSlots([create('slot-6', { origin: COW_ORIGINS.SPREAD_CORRECTION })], boundary, gapSlots),
        [],
        'spread-correction in-band placement is expected and exempt'
    );
    // Gap evacuation's destination is out-of-band; exempt regardless.
    assert.deepStrictEqual(
        collectGapBandPlacementShadowSlots([rotation('slot-6', 'slot-7', { origin: COW_ORIGINS.GAP_EVACUATION })], boundary, gapSlots),
        [],
        'gap-evacuation is exempt'
    );
    // Cancels and non-rail actions are not placements.
    assert.deepStrictEqual(
        collectGapBandPlacementShadowSlots([{ type: COW_ACTIONS.CANCEL, id: 'slot-6' }], boundary, gapSlots),
        [],
        'cancels are not placements'
    );
    // Non-finite geometry -> empty set, never throws.
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots([create('slot-6')], null, gapSlots), [], 'null boundary -> empty');
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots([create('slot-6')], boundary, undefined), [], 'undefined gap -> empty');
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots(null, boundary, gapSlots), [], 'null actions -> empty');
    // Explicit null/'' must NOT be read as boundary 0: a low index would
    // otherwise land in a real band around slot 0 (Number(null) === 0 trap).
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots([create('slot-1')], null, gapSlots), [], 'null boundary is not slot 0');
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots([create('slot-1')], '', gapSlots), [], 'empty-string boundary is not slot 0');
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots([create('slot-1')], 0, null), [], 'null gap -> empty');
    // A genuine boundary 0 is still valid and yields its band.
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots([create('slot-1')], 0, gapSlots), ['slot-1'], 'boundary 0 remains a usable boundary');
    // Unparseable slot id -> excluded.
    assert.deepStrictEqual(collectGapBandPlacementShadowSlots([create('deep-1')], boundary, gapSlots), [], 'unparseable id -> empty');

    console.log('  PASS');
}

function buildDriftHarness() {
    const StrategyModule = require('../modules/order/strategy').default;
    const StrategyEngine = StrategyModule.default || StrategyModule.StrategyEngine || StrategyModule;

    const slots: any[] = [];
    for (let i = 0; i <= 15; i++) {
        slots.push({
            id: `slot-${i}`,
            price: 100 * Math.pow(1.01, i),
            type: null,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null,
            committedSide: null,
        });
    }
    for (let i = 0; i <= 5; i++) slots[i].type = ORDER_TYPES.BUY;
    for (let i = 8; i <= 13; i++) slots[i].type = ORDER_TYPES.SELL;

    const manager: any = {
        _gapSlots: 2,
        _boundaryShiftBudget: null,
        _metrics: { boundaryDriftExceedsWindowCount: 0 },
        orders: new Map(slots.map((s) => [s.id, { ...s }])),
        config: {
            startPrice: 100,
            incrementPercent: 1,
            targetSpreadPercent: 2,
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5 },
            coreOrders: { buy: 1, sell: 1 },
            weightDistribution: { buy: 0.5, sell: 0.5 },
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0,
            assetA: 'TEST',
            assetB: 'BTS',
        },
        assets: {
            assetA: { id: '1.3.0', precision: 6, symbol: 'TEST' },
            assetB: { id: '1.3.1', precision: 6, symbol: 'BTS' },
        },
        logger: { log: () => {} },
    };

    const strategy = new StrategyEngine(manager);
    const funds = {
        allocatedBuy: 5000,
        allocatedSell: 500,
        chainFreeBuy: 5000,
        chainFreeSell: 500,
        btsBalance: { free: 100 },
    };
    return { strategy, manager, funds, slots };
}

function testBoundaryDriftExceedsWindowCounter() {
    console.log('\n - boundary drift beyond the active window is counted (recovery anchor)...');

    const { strategy, manager, funds, slots } = buildDriftHarness();
    const fillPrice = slots[8].price;
    const fills = [{ id: 'slot-8', type: ORDER_TYPES.SELL, orderId: 'o-1', price: fillPrice, size: 0.5, isPartial: false }];

    strategy.calculateTargetGrid({
        frozenMasterGrid: manager.orders,
        config: manager.config,
        accountAssets: manager.assets,
        funds,
        fills,
        // Null boundary -> absolute fill anchor; the derived boundary can land
        // far from the numeric 0 the drift comparison uses.
        currentBoundaryIdx: null,
    });

    assert.strictEqual(manager._metrics.boundaryDriftExceedsWindowCount, 1,
        `expected exactly one drift count per plan, got ${manager._metrics.boundaryDriftExceedsWindowCount}`);

    console.log('  PASS');
}

function testGetMetricsExposesNewCounters() {
    console.log('\n - BotMetrics initialization exposes the new counters via getMetrics()...');

    const DEXBot = require('../modules/dexbot_class').default;
    const bot: any = new DEXBot({
        botKey: 'test_p2_metrics_surface',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5,
    });

    const metrics = bot.getMetrics();
    for (const key of [
        'refusedCommitCount',
        'orphanFillCreditedCount',
        'restampBuyAboveAnchorCount',
        'boundaryDriftExceedsWindowCount',
        'gapBandPlacementShadowCount',
    ]) {
        assert.strictEqual(metrics[key], 0, `${key} must be initialized to 0 and surfaced by getMetrics()`);
    }

    // The boundary-drift counter is written on the MANAGER metrics object; it
    // must still be surfaced (overlaid) by getMetrics().
    bot.manager = { _metrics: { boundaryDriftExceedsWindowCount: 7 } };
    assert.strictEqual(bot.getMetrics().boundaryDriftExceedsWindowCount, 7,
        'manager-side boundary-drift counter must be overlaid into getMetrics()');

    console.log('  PASS');
}

(async () => {
    console.log('\n========== P2 OBSERVABILITY COUNTER TESTS ==========');
    testRestampBuyAboveAnchorCountsOnlyTheLeakShape();
    testGapBandShadowCollectsOnlySuspiciousRailPlacements();
    testBoundaryDriftExceedsWindowCounter();
    testGetMetricsExposesNewCounters();
    console.log('\n✅ P2 observability counter tests passed!\n');
})().catch((err) => {
    console.error('Test failed:', err);
    process.exitCode = 1;
});

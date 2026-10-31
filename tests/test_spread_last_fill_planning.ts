/**
 * Spread correction: planner-side last-fill filter, rail oversubscription, and
 * the out-of-spread persistence clock.
 *
 * All three come from one live episode (2026-10-24, a live market-pair bot):
 *
 *   - the planner selected a SELL at/below the last fill, the broadcast guard
 *     dropped it, and the batch was reported "prepared but not executed"
 *     (19:22: "planned 2, placing 1" -> skipped -> "Transient refusal 1/3");
 *   - the sell rail reserved more than the chain free balance
 *     (virtual 456046 vs free 454560), so availableFund read 0 for 84 minutes
 *     ("planned 3, placing 0");
 *   - the persistence clock kept clearing on single in-tolerance readings, so
 *     the structural re-center fired only after 84 minutes.
 *
 * The invariant under test: the planner must never build a batch out of a
 * candidate the guard WILL drop, must name an oversubscribed rail for what it
 * is, and the watchdog must not forget a persistent stall because one cycle
 * happened to measure a narrow spread.
 */
const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { trackOutOfSpreadStaleness } = require('../modules/dexbot_maintenance_runtime');
const { warnCrossingCreate } = require('../modules/dexbot_cow_runtime');

/**
 * Mid-grid voided rail: BUY slots 0-1 ACTIVE, gap 2-4 empty (SPREAD), SELL 5-6
 * empty. boundary=1, gap=3 => slot-2 is the single promotable gap slot at 1.02.
 *
 * Live market price is pinned BELOW the candidates so `doesNotCrossMarket` never
 * masks the last-fill filter: the crossing floor (live) is lower than both the
 * pivot and the candidate, which is exactly the live situation the fix targets
 * (market above our stale quote).
 */
async function buildVoidedMidGrid() {
    const logs: Array<{ msg: string; level?: string }> = [];
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    manager.btsBalance = { free: 1000, total: 1000, locked: 0 };
    manager.logger = { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) };

    const prices = [1.00, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06];
    for (let i = 0; i < prices.length; i++) {
        const isBuy = i <= 1;
        await manager._updateOrder({
            id: `slot-${i}`,
            price: prices[i],
            type: isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SPREAD,
            state: isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: isBuy ? 10 : 0,
            orderId: isBuy ? `1.7.${900 + i}` : ''
        });
    }
    manager.boundaryIdx = 1;
    manager._gapSlots = 3;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();
    manager.requestStructuralGridResync = async () => ({ scheduled: true });

    manager._lastSyncAt = Date.now();
    return { manager, logs };
}

function setPivot(manager: any, price: number, type: string) {
    manager._lastFilledPrice = price;
    manager._lastFilledType = type;
    manager.lastFillPivotSource = 'fill';
    manager._lastFilledAt = Date.now();
}

/**
 * Pin the live market read so the crossing floor cannot mask the last-fill rule.
 * `doesNotCrossMarket` requires BUY < marketRef and SELL > marketRef, so a BUY
 * test wants the market ABOVE the candidates and a SELL test wants it BELOW.
 * Timestamped after the pivot so resolveSpreadCrossingFloor prefers it.
 */
function setLiveMarket(manager: any, price: number) {
    manager._liveMarketPrice = price;
    manager._liveMarketPriceAt = Date.now() + 1;
}

function logsMatching(logs: Array<{ msg: string; level?: string }>, needle: string) {
    return logs.filter((l) => l.msg.includes(needle));
}

/** The planner must refuse from the start when every tightening slot is at/through the pivot. */
async function testPlannerExcludesPivotViolatingCandidate() {
    console.log('\n[SLF-1] planner drops a candidate the guard would drop (BUY at the fill price)...');
    const { manager, logs } = await buildVoidedMidGrid();
    // A BUY fill at 1.02 = the promotable slot price => BUY must be BELOW 1.02.
    setPivot(manager, 1.02, ORDER_TYPES.BUY);
    setLiveMarket(manager, 1.10); // market above: crossing passes, only the pivot can filter

    const result = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 1);
    assert.strictEqual(result.ordersToPlace.length, 0,
        'no create may be planned from a candidate the guard would veto');
    assert.strictEqual(result.stallHint, 'last-fill-blocked',
        `the empty side must report the geometry bind, got ${result.stallHint}`);
    assert.ok(logsMatching(logs, 'at/through the last fill').length > 0,
        `the refusal must name the last fill (got: ${logs.map((l) => l.msg).join(' | ')})`);
    console.log('  ✓ SLF-1 passed');
}

/** The same candidate must pass when the pivot leaves headroom (no over-blocking). */
async function testPlannerKeepsCandidateWithHeadroom() {
    console.log('\n[SLF-2] the same candidate is planned when it sits on the permitted side...');
    const { manager } = await buildVoidedMidGrid();
    // SELL fill at 1.04 => a BUY at 1.02 is below the pivot (allowed).
    setPivot(manager, 1.04, ORDER_TYPES.SELL);
    setLiveMarket(manager, 1.10);

    const result = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 1);
    assert.ok(result.ordersToPlace.length > 0,
        'a BUY below the last fill must still be planned (the filter must not over-block)');
    for (const o of result.ordersToPlace) {
        assert.ok(Number(o.price) < 1.04, `planned BUY ${o.price} must be below the pivot 1.04`);
    }
    console.log('  ✓ SLF-2 passed');
}

/** A sell candidate below a SELL fill is the same veto, mirrored. */
async function testPlannerExcludesLowerSellAfterSellFill() {
    console.log('\n[SLF-3] planner drops a SELL below the last fill (mirror)...');
    const { manager, logs } = await buildVoidedMidGrid();
    // Make the sell side the corrected side: pivot = a SELL fill at 1.05, and the
    // tightening sell slot would be 1.06 (above) -> allowed; then pivot 1.07 ->
    // 1.06 is below the pivot -> excluded.
    setPivot(manager, 1.07, ORDER_TYPES.SELL);
    setLiveMarket(manager, 0.90); // market below: a SELL above it passes the crossing floor
    const blocked = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    assert.strictEqual(blocked.ordersToPlace.length, 0,
        'a SELL below the last fill must not be planned');
    assert.ok(logsMatching(logs, 'at/through the last fill').length > 0,
        'the refusal must name the last fill');

    const { manager: m2 } = await buildVoidedMidGrid();
    setPivot(m2, 1.05, ORDER_TYPES.SELL);
    setLiveMarket(m2, 0.90);
    const allowed = await Grid.prepareSpreadCorrectionOrders(m2, ORDER_TYPES.SELL, 1);
    assert.ok(allowed.ordersToPlace.length > 0, 'a SELL above the last fill must be planned');
    console.log('  ✓ SLF-3 passed');
}

/** Oversubscribed rail: availableFund 0 with virtual > free must be named and flagged. */
async function testOversubscribedRailIsNamed() {
    console.log('\n[SLF-4] an oversubscribed rail is reported as such and flagged...');
    const { manager, logs } = await buildVoidedMidGrid();
    setPivot(manager, 1.04, ORDER_TYPES.SELL);
    setLiveMarket(manager, 1.10);
    await manager.recalculateFunds();
    // Reproduce the live state exactly: the rail reserves base the account does
    // not hold (virtual 456046 > free 454560), so available = max(0, free - virtual)
    // reads 0 while the side still holds inventory.
    (manager as any).funds.virtual.buy = 1000;
    (manager as any).accountTotals.buyFree = 0;
    (manager as any).funds.available.buy = 0;

    const result = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 1);
    assert.strictEqual(result.ordersToPlace.length, 0, 'nothing can be funded on an oversubscribed rail');
    assert.ok(Number(result.plannedCount) > 0, 'the plan must still find candidates (funding is the blocker)');
    const flag = (manager as any)._spreadRailOversubscribed;
    assert.ok(flag, 'an oversubscribed rail must be flagged for the watchdog');
    assert.strictEqual(flag.side, 'buy');
    assert.ok(flag.virtual > flag.free, 'flag must record virtual > free');
    assert.ok(logsMatching(logs, 'OVERSUBSCRIBED').length > 0,
        `an oversubscribed rail must be logged as OVERSUBSCRIBED (got: ${logs.map((l) => l.msg).join(' | ')})`);
    console.log('  ✓ SLF-4 passed');
}

/** One in-tolerance reading must not clear the persistence clock. */
function testSingleInToleranceReadingDoesNotReset() {
    console.log('\n[SLF-5] a single in-tolerance cycle does not clear the stale clock...');
    const bot: any = makeBot();
    bot._outOfSpreadSince = Date.now() - (20 * 60 * 1000); // 20 min stale
    bot.manager.outOfSpread = 0; // this cycle reads within tolerance
    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.staleMs, 0, 'in-tolerance cycles do not escalate');
    assert.ok(bot._outOfSpreadSince > 0, 'the out-of-spread clock must survive one good reading');
    assert.ok(bot._outOfSpreadToleranceSince > 0, 'tolerance must start accumulating');

    // Still inside the reset window: keep the clock.
    bot.manager.outOfSpread = 1;
    const again = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.ok(again.staleMs >= 20 * 60 * 1000, 'the original clock must still be running');
    assert.strictEqual(bot._outOfSpreadToleranceSince, 0, 'an out-of-tolerance cycle clears tolerance');
    console.log('  ✓ SLF-5 passed');
}

/** Sustained tolerance (past the reset window) does clear the clock. */
function testSustainedToleranceResets() {
    console.log('\n[SLF-6] sustained in-tolerance clears the clock...');
    const bot: any = makeBot();
    bot.manager.outOfSpread = 0;
    bot._outOfSpreadSince = Date.now() - (20 * 60 * 1000);
    bot._outOfSpreadToleranceSince = Date.now() - (11 * 60 * 1000); // past the 10 min window
    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.staleMs, 0);
    assert.strictEqual(bot._outOfSpreadSince, 0, 'sustained tolerance heals the clock');
    assert.strictEqual(bot._outOfSpreadToleranceSince, 0);
    console.log('  ✓ SLF-6 passed');
}

/** An oversubscribed rail escalates on the short fund window, not the 30-minute one. */
function testOversubscribedEscalatesEarly() {
    console.log('\n[SLF-7] rail oversubscription escalates on the short fund window...');
    const bot: any = makeBot();
    let resyncs = 0;
    bot.manager.requestStructuralGridResync = () => { resyncs += 1; };
    bot.manager.outOfSpread = 3;
    bot.manager._spreadRailOversubscribed = { side: 'sell', virtual: 456046, free: 454560, at: Date.now() };
    bot._outOfSpreadSince = Date.now() - (6 * 60 * 1000); // 6 min: past the 5 min fund window
    bot._spreadCorrectionStall = 'unfunded';

    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.escalated, true,
        'oversubscribed must escalate after the short fund window, not wait 30 minutes');
    assert.strictEqual(resyncs, 1, 'a structural re-center must be requested');
    assert.ok(bot.logs.some((l: any) => String(l.msg).includes('rail oversubscribed')),
        'the escalation must name the oversubscription');
    console.log('  ✓ SLF-7 passed');
}

async function testSellMirrorReportsGeometryBind() {
    console.log('\n[SLF-8] the mirrored lower-sell refusal also reports the geometry bind...');
    const { manager } = await buildVoidedMidGrid();
    setPivot(manager, 1.07, ORDER_TYPES.SELL);
    setLiveMarket(manager, 0.90);
    const blocked = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    assert.strictEqual(blocked.ordersToPlace.length, 0);
    assert.strictEqual(blocked.stallHint, 'last-fill-blocked',
        `a preferenced sell side with no legal slot must name the bind, got ${blocked.stallHint}`);
    console.log('  ✓ SLF-8 passed');
}

/** The starvation fallback must not collapse a named geometry bind into 'no-candidates'. */
function testStallMergePrecedence() {
    console.log('\n[SLF-9] stall merge keeps the strongest named cause...');
    const { mergeSpreadStalls } = require('../modules/order/grid');
    assert.strictEqual(mergeSpreadStalls('last-fill-blocked', 'no-candidates'), 'last-fill-blocked');
    assert.strictEqual(mergeSpreadStalls('no-candidates', 'last-fill-blocked'), 'last-fill-blocked');
    assert.strictEqual(mergeSpreadStalls('last-fill-blocked', 'unfunded'), 'unfunded',
        'funds stay top: a refresh may repair them');
    assert.strictEqual(mergeSpreadStalls('last-fill-blocked', 'unmatched-orders'), 'unmatched-orders',
        'a sync-repairable cause outranks the geometry bind');
    assert.strictEqual(mergeSpreadStalls(undefined, 'last-fill-blocked'), 'last-fill-blocked');
    console.log('  ✓ SLF-9 passed');
}

/** The geometry bind escalates on its own window: after 10 min, not after 30. */
function testGeometryBindEscalatesEarly() {
    console.log('\n[SLF-10] last-fill-blocked escalates on the geometry window...');
    const bot: any = makeBot();
    let resyncs = 0;
    bot.manager.requestStructuralGridResync = () => { resyncs += 1; };
    bot.manager.outOfSpread = 2;
    bot._spreadCorrectionStall = 'last-fill-blocked';
    bot._outOfSpreadSince = Date.now() - (12 * 60 * 1000); // 12 min: past the 10 min geometry window
    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.escalated, true,
        'the geometry bind must not wait for the 30-minute structural window');
    assert.strictEqual(resyncs, 1);
    assert.ok(bot.logs.some((l: any) => String(l.msg).includes('sell window behind the last fill')),
        'the escalation must name the geometry bind');
    // A plain 'no-candidates' stall at the same age must NOT escalate yet.
    const bot2: any = makeBot();
    bot2.manager.outOfSpread = 2;
    bot2._spreadCorrectionStall = 'no-candidates';
    bot2._outOfSpreadSince = Date.now() - (12 * 60 * 1000);
    assert.strictEqual(trackOutOfSpreadStaleness(bot2, true, 0, false).escalated, false,
        'a plain no-candidates stall keeps the structural window');
    console.log('  ✓ SLF-10 passed');
}

function makeBot(pivot: { price: number; type: string } | null = null) {
    const logs: Array<{ msg: string; level?: string }> = [];
    return {
        _outOfSpreadSince: 0,
        _outOfSpreadStaleWarned: false,
        _outOfSpreadTransientCount: 0,
        _outOfSpreadToleranceSince: 0,
        _lastSpreadStaleResyncAt: 0,
        _lastGeometryResyncPivotKey: '',
        _geometryResyncWarnedPivotKey: '',
        _spreadCorrectionStall: null,
        manager: {
            outOfSpread: 1,
            requestStructuralGridResync: () => { throw new Error('unexpected resync'); },
            logger: { log: () => {} },
            _lastMarketFillPrice: pivot ? pivot.price : null,
            _lastMarketFillType: pivot ? pivot.type : null,
            _lastMarketFillAt: pivot ? Date.now() - (30 * 60 * 1000) : 0
        },
        _log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }),
        logs
    };
}

function testGeometryBindRecenterIsCappedPerPivot() {
    console.log('\n[SLF-11] one geometry re-center per fill pivot (churn cap)...');
    const pivot = { price: 1.07, type: ORDER_TYPES.SELL };
    const bot: any = makeBot(pivot);
    let resyncs = 0;
    bot.manager.requestStructuralGridResync = () => { resyncs += 1; };
    bot.manager.outOfSpread = 2;
    bot._spreadCorrectionStall = 'last-fill-blocked';
    bot._outOfSpreadSince = Date.now() - (12 * 60 * 1000); // past the 10 min geometry window

    // 1st: the re-center can help (it re-derives the center around the pivot).
    const first = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(first.escalated, true, 'the first geometry bind must re-center');
    assert.strictEqual(resyncs, 1);
    assert.strictEqual(bot._lastGeometryResyncPivotKey, `${pivot.price}|${pivot.type}`,
        'the pivot the re-center ran for must be recorded');

    // 2nd with the SAME pivot (cooldown elapsed): refuse and say why once.
    bot._lastSpreadStaleResyncAt = 0; // pretend the cooldown has elapsed
    const second = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(second.escalated, false,
        'a re-center cannot move the pivot, so the same fill must not trigger another one');
    assert.strictEqual(resyncs, 1, 'no second structural re-center');
    assert.ok(bot.logs.some((l: any) => /cannot clear it/.test(String(l.msg))),
        `the refusal must be explained (got: ${bot.logs.map((l: any) => l.msg).join(' | ')})`);
    const warns = bot.logs.filter((l: any) => /cannot clear it/.test(String(l.msg))).length;
    trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(bot.logs.filter((l: any) => /cannot clear it/.test(String(l.msg))).length, warns,
        'the explanation must not repeat every tick');

    // A NEW fill pivot re-arms the escalation budget (that re-center can help).
    bot.manager._lastMarketFillPrice = 1.065;
    bot._lastSpreadStaleResyncAt = 0;
    const third = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(third.escalated, true, 'a fresh pivot gets a fresh re-center budget');
    assert.strictEqual(resyncs, 2);

    // A placement (spread healed) clears the memory.
    trackOutOfSpreadStaleness(bot, true, 1, false);
    assert.strictEqual(bot._lastGeometryResyncPivotKey, '', 'a placement clears the churn memory');
    assert.strictEqual(bot._geometryResyncWarnedPivotKey, '');
    console.log('  ✓ SLF-11 passed');
}

function testCrossingCreateIsObserved() {
    console.log('\n[SLF-12] a generic CREATE on the crossing side is observed, never blocked...');
    const logs: Array<{ msg: string; level?: string }> = [];
    const bot: any = {
        manager: {
            logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
            // No live market read: the floor falls back to the fill reference.
            _lastFilledPrice: 1.05,
            _lastFilledType: ORDER_TYPES.SELL,
            lastFillPivotSource: 'fill',
            _lastFilledAt: Date.now()
        }
    };
    // A SELL at/below the floor crosses (the planner's `doesNotCrossMarket`).
    assert.strictEqual(warnCrossingCreate(bot, 1.05, ORDER_TYPES.SELL, 'slot-9'), true,
        'a SELL at the floor must be observed');
    assert.strictEqual(warnCrossingCreate(bot, 1.04, ORDER_TYPES.SELL, 'slot-9'), true,
        'a SELL below the floor must be observed');
    assert.ok(logs.some((l) => /crossing side of the floor/.test(l.msg)), 'the observation must be logged');
    const warned = logs.length;
    // The safe side is silent, and the helper never blocks (returns false).
    assert.strictEqual(warnCrossingCreate(bot, 1.06, ORDER_TYPES.SELL, 'slot-9'), false,
        'a SELL above the floor is not a crossing');
    assert.strictEqual(warnCrossingCreate(bot, 1.0, ORDER_TYPES.BUY, 'slot-2'), false,
        'a BUY below the floor is not a crossing');
    assert.strictEqual(logs.length, warned, 'non-crossing placements must not log');
    // Fail-open when no reference exists (cold) or the price/type is unusable.
    const cold: any = { manager: { logger: { log: () => {} } } };
    assert.strictEqual(warnCrossingCreate(cold, 1.05, ORDER_TYPES.SELL, 'slot-9'), false, 'a cold floor is a no-op');
    assert.strictEqual(warnCrossingCreate(bot, NaN, ORDER_TYPES.SELL, 'slot-9'), false, 'a bad price is a no-op');
    assert.strictEqual(warnCrossingCreate(bot, 1.05, 'SPREAD', 'slot-9'), false, 'a side-neutral type is a no-op');
    console.log('  ✓ SLF-12 passed');
}

async function main() {
    await testPlannerExcludesPivotViolatingCandidate();
    await testPlannerKeepsCandidateWithHeadroom();
    await testPlannerExcludesLowerSellAfterSellFill();
    await testOversubscribedRailIsNamed();
    testSingleInToleranceReadingDoesNotReset();
    testSustainedToleranceResets();
    testOversubscribedEscalatesEarly();
    await testSellMirrorReportsGeometryBind();
    testStallMergePrecedence();
    testGeometryBindEscalatesEarly();
    testGeometryBindRecenterIsCappedPerPivot();
    testCrossingCreateIsObserved();
    console.log('\nAll spread last-fill planning tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('spread last-fill planning test failed:', err);
        process.exit(1);
    });
}

module.exports = { main };

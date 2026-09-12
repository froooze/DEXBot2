/**
 * tests/test_stale_grid_hardening.ts
 *
 * Never-run-stale hardening for the 2026-09-12 incident family (deferred work
 * whose retry depends on a future event that may never come):
 *
 * TOTALS-001..003 — parkFillsForTotalsRetry (modules/dexbot_fill_runtime):
 *   fills deferred on a stale accountTotals refresh were dropped (already
 *   spliced from the queue) while their dedupe keys stayed marked processed:
 *   silent fund loss. They must be parked outside the live queue with keys
 *   released and re-queued on a backoff timer — never dropped, never hot-spun.
 *
 * SPREAD-001..004 — trackOutOfSpreadStaleness (maintenance runtime): a spread
 *   correction that keeps placing nothing while the spread stays wide is a
 *   stale grid, not patience. Time-based warn + structural re-center
 *   escalation with cooldown.
 *
 * HOOK-001..002 — region-end fan-out (modules/order/manager): legacy single
 *   listener plus registered listeners all fire; throwing listeners contained;
 *   duplicate registration ignored.
 *
 * SUPP-001 — held-plan suppression visibility: identical fill-less replans
 *   count up (warn on 1st/every 10th) and the run resets on fresh fills.
 *
 * SPREAD-INF-001..002 — one-sided spread honesty (modules/order/utils/math,
 *   modules/order/utils/order): a book with no buys or no sells has an
 *   undefined (infinite) spread, never 0 — 0 reads as a perfectly tight book.
 *   The flag path must stay bounded (nominal gap count, never Infinity as an
 *   "extra slots" count).
 */

const assert = require('assert');
const { consumeFillQueue, parkFillsForTotalsRetry } = require('../modules/dexbot_fill_runtime');
const { trackOutOfSpreadStaleness } = require('../modules/dexbot_maintenance_runtime');
const { calculateSpreadFromOrders } = require('../modules/order/utils/math');
const { shouldFlagOutOfSpread } = require('../modules/order/utils/order');
const { OrderManager } = require('../modules/order/manager');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function makeFill(orderId: string, blockNum: number, historyId: string) {
    return {
        op: [4, {
            order_id: orderId,
            pays: { asset_id: '1.3.0', amount: 100 },
            receives: { asset_id: '1.3.1', amount: 200 },
            is_maker: true,
        }],
        block_num: blockNum,
        id: historyId,
    };
}

function stubLock() {
    return {
        isLocked: () => false,
        getQueueLength: () => 0,
        acquire: async (fn: any) => fn(),
    };
}

function stubTotalsDeferBot() {
    const logs: any[] = [];
    const bot: any = {
        logs,
        _incomingFillQueue: [makeFill('1.7.100', 1000, '4.1'), makeFill('1.7.101', 1000, '4.2')],
        _shuttingDown: false,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _deferredFillsPending: false,
        _consecutiveConsumeFailures: 0,
        _consumeFailureFirstAt: 0,
        _recentlyQueuedFills: new Map(),
        _fillDedupeWindowMs: 60000,
        _staleCleanedOrderIds: new Map(),
        _fillCleanupCounter: 0,
        _metrics: { fillsProcessed: 0, fillProcessingTimeMs: 0, maxQueueDepth: 0 },
        _fillTotalsRetryAttempt: 0,
        _isCredentialDaemonError: () => false,
        _warn: () => {},
        _log: () => {},
        _markGridActivity: () => {},
        _refreshDynamicWeightDistribution: () => {},
        _getRecentFillKeysSnapshot: () => ({}),
        _flushProcessedFillPersistenceForKeys: async () => {},
        manager: {
            orders: new Map([
                ['1.7.100', { id: 'slot-1', orderId: '1.7.100' }],
                ['1.7.101', { id: 'slot-2', orderId: '1.7.101' }],
            ]),
            isBootstrapping: () => false,
            isBroadcastingActive: () => false,
            _fillProcessingLock: stubLock(),
            _orphanFillsCreditedAt: null,
            logger: { log: (msg: string, lvl: string) => { logs.push({ msg, lvl }); } },
            pauseFundRecalc() {},
            resumeFundRecalc: async () => {},
            syncFromFillHistoryBatch: async () => ({ deferred: true }),
        },
        accountOrders: {},
    };
    // Faithful copy of DEXBot._isNewFillKey replay-safety semantics: records
    // the key on first sight (so the release-on-deferral under test matters).
    bot._isNewFillKey = function (fillKey: any, processedFillKeys: any) {
        const now = Date.now();
        if (bot._recentlyQueuedFills.has(fillKey)) {
            if (now - bot._recentlyQueuedFills.get(fillKey) < bot._fillDedupeWindowMs) return false;
        }
        if (processedFillKeys.has(fillKey)) return false;
        processedFillKeys.add(fillKey);
        bot._recentlyQueuedFills.set(fillKey, now);
        return true;
    };
    return bot;
}

async function testTOTALS001_DeferredFillsParkedNotDropped() {
    console.log('\n[TOTALS-001] Totals-deferred fills are parked (not dropped) with keys released...');
    const bot: any = stubTotalsDeferBot();
    await consumeFillQueue(bot, {});
    assert.strictEqual(bot._incomingFillQueue.length, 0, 'queue spliced by the cycle');
    assert.strictEqual(bot._fillTotalsParkedFills.length, 2, 'both deferred fills must be parked, not dropped');
    assert.strictEqual(bot._recentlyQueuedFills.size, 0, 'dedupe keys must be released so the retry is not skipped as duplicate');
    assert.ok(bot._fillTotalsRetryTimer, 'a retry timer must be scheduled');
    assert.strictEqual(bot._metrics.fillsProcessed, 2, 'cycle still accounts the fills as seen');
    clearTimeout(bot._fillTotalsRetryTimer);
    bot._fillTotalsRetryTimer = null;
    console.log('✓ TOTALS-001 passed');
}

async function testTOTALS002_ParkedFillsRetryOnTimer() {
    console.log('\n[TOTALS-002] Parked fills re-queue and re-run on the retry timer...');
    let consumed = 0;
    const bot: any = {
        _incomingFillQueue: [],
        _shuttingDown: false,
        _fillTotalsRetryAttempt: 0,
        _warn: () => {},
        manager: { logger: { log: () => {} } },
        _consumeFillQueue: async () => { consumed++; },
    };
    parkFillsForTotalsRetry(bot, {}, [makeFill('1.7.200', 2000, '4.9')], { retryDelayMs: 15 });
    assert.strictEqual(bot._fillTotalsParkedFills.length, 1, 'fill parked');
    const timer = bot._fillTotalsRetryTimer;
    assert.ok(timer, 'timer scheduled');
    await sleep(80);
    assert.strictEqual(bot._fillTotalsRetryTimer, null, 'timer cleared after firing');
    assert.strictEqual(bot._fillTotalsParkedFills.length, 0, 'parked array drained');
    assert.strictEqual(bot._incomingFillQueue.length, 1, 'fill re-queued at the front');
    assert.strictEqual(consumed, 1, 'consumer re-invoked');
    assert.strictEqual(bot._fillTotalsRetryAttempt, 1, 'attempt counter advances the backoff chain');
    console.log('✓ TOTALS-002 passed');
}

async function testTOTALS003_SecondParkJoinsPendingTimer() {
    console.log('\n[TOTALS-003] A second park while a retry is pending joins it (single timer)...');
    const bot: any = {
        _incomingFillQueue: [],
        _shuttingDown: false,
        _fillTotalsRetryAttempt: 0,
        _warn: () => {},
        manager: { logger: { log: () => {} } },
        _consumeFillQueue: async () => {},
    };
    parkFillsForTotalsRetry(bot, {}, [makeFill('1.7.300', 3000, '4.7')], { retryDelayMs: 5000 });
    const timer = bot._fillTotalsRetryTimer;
    assert.ok(timer, 'timer scheduled');
    parkFillsForTotalsRetry(bot, {}, [makeFill('1.7.301', 3000, '4.8')], { retryDelayMs: 5000 });
    assert.strictEqual(bot._fillTotalsRetryTimer, timer, 'no second timer — one retry at a time');
    assert.strictEqual(bot._fillTotalsParkedFills.length, 2, 'both fills ride the pending retry');
    clearTimeout(bot._fillTotalsRetryTimer);
    bot._fillTotalsRetryTimer = null;
    console.log('✓ TOTALS-003 passed');
}

function stubSpreadBot(outOfSpread: number) {
    const logs: any[] = [];
    return {
        logs,
        _outOfSpreadSince: 0,
        _outOfSpreadStaleWarned: false,
        _lastSpreadStaleResyncAt: 0,
        _log: (msg: string, lvl: string) => { logs.push({ msg, lvl }); },
        manager: {
            outOfSpread,
            resyncRequests: [] as any[],
            logger: { log: (msg: string, lvl: string) => { logs.push({ msg, lvl }); } },
            requestStructuralGridResync: async function (reason: string, details: any) {
                (this as any).resyncRequests.push({ reason, details });
                return { scheduled: true };
            },
        },
    };
}

async function testSPREAD001_HealthyOrPlacedResets() {
    console.log('\n[SPREAD-001] Healthy spread or placed correction resets staleness...');
    const bot: any = stubSpreadBot(0);
    bot._outOfSpreadSince = Date.now() - 60 * 60 * 1000;
    bot._outOfSpreadStaleWarned = true;
    trackOutOfSpreadStaleness(bot, true, 0);
    assert.strictEqual(bot._outOfSpreadSince, 0, 'healthy spread resets the clock');
    assert.strictEqual(bot._outOfSpreadStaleWarned, false, 'warn latch resets');

    const bot2: any = stubSpreadBot(2);
    bot2._outOfSpreadSince = Date.now() - 60 * 60 * 1000;
    trackOutOfSpreadStaleness(bot2, true, 3);
    assert.strictEqual(bot2._outOfSpreadSince, 0, 'placed correction resets the clock');
    assert.strictEqual(bot2.manager.resyncRequests.length, 0, 'no resync when healing');
    console.log('✓ SPREAD-001 passed');
}

async function testSPREAD002_WarnOnceThenEscalateWithCooldown() {
    console.log('\n[SPREAD-002] Persistent wide spread warns once, then re-centers with cooldown...');
    const bot: any = stubSpreadBot(2);
    bot._outOfSpreadSince = Date.now() - 11 * 60 * 1000;
    let r = trackOutOfSpreadStaleness(bot, true, 0);
    assert.strictEqual(r.escalated, false, 'no escalation before the threshold');
    assert.ok(bot.logs.some((l: any) => String(l.msg).includes('SPREAD-STALE')), 'staleness warned');
    const warns = bot.logs.length;
    trackOutOfSpreadStaleness(bot, true, 0);
    assert.strictEqual(bot.logs.length, warns, 'warn fires once, not every tick');

    bot._outOfSpreadSince = Date.now() - 31 * 60 * 1000;
    r = trackOutOfSpreadStaleness(bot, true, 0);
    assert.strictEqual(r.escalated, true, 'escalates past the threshold');
    assert.strictEqual(bot.manager.resyncRequests.length, 1, 'one structural re-center requested');
    assert.strictEqual(bot.manager.resyncRequests[0].reason, 'spread-stale-persistent');
    r = trackOutOfSpreadStaleness(bot, true, 0);
    assert.strictEqual(bot.manager.resyncRequests.length, 1, 'cooldown dedupes repeat escalation');
    console.log('✓ SPREAD-002 passed');
}

async function testSPREAD003_UncheckedTickDoesNotAccumulate() {
    console.log('\n[SPREAD-003] A tick that skipped the spread check does not start the clock...');
    const bot: any = stubSpreadBot(2);
    const r = trackOutOfSpreadStaleness(bot, false, 0);
    assert.strictEqual(bot._outOfSpreadSince, 0, 'clock only starts on an actual check');
    assert.strictEqual(r.escalated, false, 'no escalation without a check');
    console.log('✓ SPREAD-003 passed');
}

function newTestManager() {
    const m: any = new OrderManager({
        startPrice: 100,
        incrementPercent: 0.3,
        targetSpreadPercent: 1.5,
        assetA: 'USD',
        assetB: 'TESTCOIN',
        minPrice: 50,
        maxPrice: 200,
    });
    m.logger.log = () => {};
    return m;
}

async function testHOOK001_FanOutToAllListeners() {
    console.log('\n[HOOK-001] Region-end fires the legacy listener plus all registered ones...');
    const m = newTestManager();
    const calls: string[] = [];
    m._onBroadcastRegionEnd = () => { calls.push('legacy'); };
    m.addBroadcastRegionEndListener(() => { calls.push('a'); });
    m.addBroadcastRegionEndListener(() => { calls.push('b'); });
    m._fireBroadcastRegionEnd();
    assert.deepStrictEqual(calls.sort(), ['a', 'b', 'legacy'], 'every listener fires exactly once');
    console.log('✓ HOOK-001 passed');
}

async function testHOOK002_ThrowingListenerContainedAndDedupe() {
    console.log('\n[HOOK-002] Throwing listeners are contained; duplicate registration ignored...');
    const m = newTestManager();
    let ok = 0;
    const fn = () => { ok++; };
    m.addBroadcastRegionEndListener(fn);
    m.addBroadcastRegionEndListener(fn);
    m.addBroadcastRegionEndListener(() => { throw new Error('boom'); });
    m.addBroadcastRegionEndListener(() => { ok++; });
    assert.doesNotThrow(() => m._fireBroadcastRegionEnd(), 'throwing listener must not escape');
    assert.strictEqual(ok, 2, 'deduped fn fires once plus the healthy listener');
    console.log('✓ HOOK-002 passed');
}

async function testSUPP001_SuppressionCountsAndResets() {
    console.log('\n[SUPP-001] Held-plan suppression counts up and resets on fresh fills...');
    const m = newTestManager();
    m.boundaryIdx = 99;
    m._lastFilledPrice = 920.7;
    m._lastFilledAt = 12345;
    m._lastHeldPlanSignature = { boundaryIdx: 99, pivot: 920.7, fillsAt: 12345, wire: ['slot-110'] };
    assert.strictEqual(m._heldPlanSuppressionCount, 0, 'counter starts at zero');
    await m.performSafeRebalance([], new Set(), { deferIfBroadcasting: true });
    await m.performSafeRebalance([], new Set(), { deferIfBroadcasting: true });
    assert.strictEqual(m._heldPlanSuppressionCount, 2, 'each suppressed fill-less replan counts');
    // A fill-driven call ends the run even if it defers on broadcast.
    m.startBroadcasting();
    await m.performSafeRebalance([{ id: 'slot-1' }], new Set(), { deferIfBroadcasting: true });
    m.stopBroadcasting();
    assert.strictEqual(m._heldPlanSuppressionCount, 0, 'fresh fills reset the run');
    console.log('✓ SUPP-001 passed');
}

async function testSPREADINF001_OneSidedBookReadsInfinite() {
    console.log('\n[SPREAD-INF-001] One-sided book reads Infinity, two-sided stays finite...');
    const buys = [{ price: 900 }, { price: 904 }];
    const sells = [{ price: 935 }, { price: 940 }];
    assert.strictEqual(calculateSpreadFromOrders([], sells), Infinity, 'no buys -> Infinity, not 0');
    assert.strictEqual(calculateSpreadFromOrders(buys, []), Infinity, 'no sells -> Infinity, not 0');
    assert.strictEqual(calculateSpreadFromOrders([], []), Infinity, 'empty book -> Infinity, not 0');
    const twoSided = calculateSpreadFromOrders(buys, sells);
    assert.ok(Number.isFinite(twoSided) && twoSided > 0, `two-sided spread stays finite (got ${twoSided})`);
    console.log('✓ SPREAD-INF-001 passed');
}

async function testSPREADINF002_FlagStaysBoundedOnNonFiniteSpread() {
    console.log('\n[SPREAD-INF-002] Flag path never leaks Infinity as an extra-slot count...');
    const nominal = 1.5, tol = 0.5, inc = 0.5;
    for (const [b, s] of [[0, 5], [5, 0], [3, 4]] as any) {
        const flag = shouldFlagOutOfSpread(Infinity, nominal, tol, b, s, inc);
        assert.ok(Number.isFinite(flag) && flag >= 1, `Infinity spread with counts ${b}/${s} -> bounded gap (got ${flag})`);
    }
    assert.strictEqual(shouldFlagOutOfSpread(0, nominal, tol, 0, 5, inc), shouldFlagOutOfSpread(Infinity, nominal, tol, 0, 5, inc),
        'empty-side flag ignores the spread value entirely');
    console.log('✓ SPREAD-INF-002 passed');
}

async function runAllTests() {
    console.log('=== Stale-Grid Hardening Test Suite ===\n');
    await testTOTALS001_DeferredFillsParkedNotDropped();
    await testTOTALS002_ParkedFillsRetryOnTimer();
    await testTOTALS003_SecondParkJoinsPendingTimer();
    await testSPREAD001_HealthyOrPlacedResets();
    await testSPREAD002_WarnOnceThenEscalateWithCooldown();
    await testSPREAD003_UncheckedTickDoesNotAccumulate();
    await testSPREADINF001_OneSidedBookReadsInfinite();
    await testSPREADINF002_FlagStaysBoundedOnNonFiniteSpread();
    await testHOOK001_FanOutToAllListeners();
    await testHOOK002_ThrowingListenerContainedAndDedupe();
    await testSUPP001_SuppressionCountsAndResets();
    console.log('\nAll stale-grid hardening tests passed.');
}

if (require.main === module) {
    runAllTests().catch((err) => {
        console.error('STALE-HARDENING TEST FAILURE:', err);
        process.exit(1);
    });
}

export { runAllTests };

/**
 * Fill-pipeline robustness tests (lock-timeout cascade + boundary-hold runs).
 *
 * Covers the two hardening helpers behind a live lock-timeout-cascade
 * incident (Sep 2026: 22x "Lock acquisition timeout", boundary frozen at 99
 * while the plan wanted 109 during a vertical rally):
 *
 * DEFER-001..005 — shouldDeferFillForBroadcast (modules/dexbot_fill_runtime):
 *   the fill consumer must defer BEFORE acquiring _fillProcessingLock while a
 *   broadcast region is active, instead of sleeping up to 30s inside a lock
 *   whose acquisition timeout is 20s (every concurrent consumer then queues
 *   as a waiter and times out). Bounded so a leaked flag delays but never
 *   starves fills.
 *
 * HOLD-010..012 — trackBoundaryHold (modules/dexbot_cow_runtime): consecutive
 *   boundary-hold batches are counted with a last-hold snapshot so a grid
 *   trailing the market escalates visibly instead of hiding in per-batch
 *   warns. Cleared on the first clean batch.
 *
 * WDG-001..002 — stale-broadcast watchdog (modules/order/manager): a leaked
 *   broadcast flag hard-cleared by _clearStaleBroadcastFlag must fire the same
 *   region-end hook stopBroadcasting would, so fills deferred by the consumer
 *   are not stranded; a throwing listener must not escape the watchdog.
 */

const assert = require('assert');
const { shouldDeferFillForBroadcast, consumeDeferredDrainMarker, consumeFillQueue } = require('../modules/dexbot_fill_runtime');
const { trackBoundaryHold } = require('../modules/dexbot_cow_runtime');
const { OrderManager } = require('../modules/order/manager');
const { TIMING } = require('../modules/constants');

function stubBot(broadcasting: boolean) {
    return {
        manager: { isBroadcastingActive: () => broadcasting },
        _fillBroadcastDeferSince: 0,
    };
}

async function testDEFER001_IdleProceedsAndClearsMarker() {
    console.log('\n[DEFER-001] Idle manager proceeds and clears a stale defer marker...');
    const bot: any = stubBot(false);
    bot._fillBroadcastDeferSince = 12345;
    const r = shouldDeferFillForBroadcast(bot, 1_000_000);
    assert.deepStrictEqual(r, { defer: false, stuckFallback: false });
    assert.strictEqual(bot._fillBroadcastDeferSince, 0, 'stale marker must clear when idle');
    console.log('✓ DEFER-001 passed');
}

async function testDEFER002_ActiveBroadcastDefers() {
    console.log('\n[DEFER-002] Active broadcast defers and stamps the marker...');
    const bot: any = stubBot(true);
    const r = shouldDeferFillForBroadcast(bot, 1_000_000);
    assert.deepStrictEqual(r, { defer: true, stuckFallback: false });
    assert.strictEqual(bot._fillBroadcastDeferSince, 1_000_000, 'first deferral must stamp nowMs');
    console.log('✓ DEFER-002 passed');
}

async function testDEFER003_WithinBoundKeepsDeferring() {
    console.log('\n[DEFER-003] Continuous broadcast keeps deferring inside the bound...');
    const bot: any = stubBot(true);
    shouldDeferFillForBroadcast(bot, 1_000_000);
    const r = shouldDeferFillForBroadcast(bot, 1_000_000 + 30_000);
    assert.deepStrictEqual(r, { defer: true, stuckFallback: false });
    assert.strictEqual(bot._fillBroadcastDeferSince, 1_000_000, 'marker must not move while deferring');
    console.log('✓ DEFER-003 passed');
}

async function testDEFER004_BoundExpiryFallsThrough() {
    console.log('\n[DEFER-004] Deferral past the bound falls through (stuck-flag fallback)...');
    assert.ok(
        Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS) > 0,
        'FILL_BROADCAST_DEFER_MAX_MS must be configured'
    );
    const bound = Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS);
    const bot: any = stubBot(true);
    shouldDeferFillForBroadcast(bot, 1_000_000);
    const r = shouldDeferFillForBroadcast(bot, 1_000_000 + bound);
    assert.deepStrictEqual(r, { defer: false, stuckFallback: true });
    assert.strictEqual(bot._fillBroadcastDeferSince, 0, 'marker must clear on fallback');
    console.log('✓ DEFER-004 passed');
}

async function testDEFER005_MissingManagerFailsOpen() {
    console.log('\n[DEFER-005] Missing manager/bot fails open (never blocks fills)...');
    assert.deepStrictEqual(shouldDeferFillForBroadcast({}, 0), { defer: false, stuckFallback: false });
    assert.deepStrictEqual(shouldDeferFillForBroadcast(null, 0), { defer: false, stuckFallback: false });
    assert.deepStrictEqual(
        shouldDeferFillForBroadcast({ manager: {} }, 0),
        { defer: false, stuckFallback: false }
    );
    console.log('✓ DEFER-005 passed');
}

async function testHOLD010_ConsecutiveTrackingAndSnapshot() {
    console.log('\n[HOLD-010] Consecutive holds count up and snapshot the latest...');
    const mgr: any = {};
    assert.strictEqual(trackBoundaryHold(mgr, true, 99, 105, ['slot-110', 'slot-111']), 1);
    assert.strictEqual(mgr._consecutiveBoundaryHolds, 1);
    assert.strictEqual(trackBoundaryHold(mgr, true, 99, 106, ['slot-110', 'slot-111', 'slot-112']), 2);
    assert.strictEqual(mgr._consecutiveBoundaryHolds, 2);
    assert.strictEqual(mgr._lastBoundaryHoldInfo.kept, 99);
    assert.strictEqual(mgr._lastBoundaryHoldInfo.planned, 106);
    assert.deepStrictEqual(mgr._lastBoundaryHoldInfo.slots, ['slot-110', 'slot-111', 'slot-112']);
    assert.ok(Number.isFinite(mgr._lastBoundaryHoldInfo.at), 'snapshot must carry a timestamp');
    console.log('✓ HOLD-010 passed');
}

async function testHOLD011_ClearResetsAndNullManagerSafe() {
    console.log('\n[HOLD-011] Clean batch resets the run; null manager is safe...');
    const mgr: any = { _consecutiveBoundaryHolds: 4 };
    assert.strictEqual(trackBoundaryHold(mgr, false, 99, 99, []), 0);
    assert.strictEqual(mgr._consecutiveBoundaryHolds, 0);
    assert.strictEqual(trackBoundaryHold(null, true, 99, 105, ['slot-110']), 0);
    assert.strictEqual(trackBoundaryHold(undefined, false, 0, 0, []), 0);
    console.log('✓ HOLD-011 passed');
}

async function testHOLD012_PlanSignatureSetAndCleared() {
    console.log('\n[HOLD-012] Hold records a plan signature; a clean batch clears it...');
    const mgr: any = { _lastFilledPrice: 100, _lastFilledAt: 555 };
    assert.strictEqual(trackBoundaryHold(mgr, true, 99, 105, ['slot-110']), 1);
    assert.ok(mgr._lastHeldPlanSignature, 'held batch must record a signature');
    assert.strictEqual(mgr._lastHeldPlanSignature.boundaryIdx, 99);
    assert.strictEqual(mgr._lastHeldPlanSignature.pivot, 100);
    assert.strictEqual(mgr._lastHeldPlanSignature.fillsAt, 555);
    assert.deepStrictEqual(mgr._lastHeldPlanSignature.wire, ['slot-110']);
    trackBoundaryHold(mgr, false, 99, 99, []);
    assert.strictEqual(mgr._lastHeldPlanSignature, null, 'clean batch must clear the signature');
    console.log('✓ HOLD-012 passed');
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

async function testDFER006_ActiveBroadcastDefersRebalance() {
    console.log('\n[DFER-006] Active broadcast defers the rebalance without sleeping in-lock...');
    const m = newTestManager();
    m.startBroadcasting();
    const r = await m.performSafeRebalance(
        [{ id: 'slot-1', type: 'sell', price: 100 }],
        new Set(),
        { deferIfBroadcasting: true }
    );
    assert.strictEqual(r.deferred, true, 'rebalance must defer');
    assert.strictEqual(r.aborted, true, 'deferred result is an aborted (no-op) plan');
    assert.strictEqual(r.reason, 'broadcast-active-deferred');
    assert.ok(Number(m._deferredRebalanceAt) > 0, 'deferral must be stamped for the region-end hook');
    m.stopBroadcasting();
    console.log('✓ DFER-006 passed');
}

async function testDFER007_IdenticalHeldPlanDefers() {
    console.log('\n[DFER-007] No new fills since a hold => identical plan defers...');
    const m = newTestManager();
    m.boundaryIdx = 99;
    m._lastFilledPrice = 920.7;
    m._lastFilledAt = 12345;
    m._lastHeldPlanSignature = { boundaryIdx: 99, pivot: 920.7, fillsAt: 12345, wire: ['slot-110'] };
    const r = await m.performSafeRebalance([], new Set(), { deferIfBroadcasting: true });
    assert.strictEqual(r.deferred, true, 'identical held plan must defer');
    assert.strictEqual(r.reason, 'held-plan-unchanged-deferred');
    console.log('✓ DFER-007 passed');
}

async function testCFG001_HoldResyncTuningPresent() {
    console.log('\n[CFG-001] Boundary-hold re-center tuning is configured...');
    assert.ok(Number(TIMING.BOUNDARY_HOLD_RESYNC_THRESHOLD) >= 1, 'threshold must be >= 1');
    assert.ok(Number(TIMING.BOUNDARY_HOLD_RESYNC_COOLDOWN_MS) > 0, 'cooldown must be positive');
    console.log('✓ CFG-001 passed');
}

async function testWDG001_StaleWatchdogFiresRegionEnd() {
    console.log('\n[WDG-001] Stale broadcast watchdog fires the region-end hook...');
    const m = newTestManager();
    let fired = 0;
    m.addBroadcastRegionEndListener(() => { fired++; });

    // Fresh flag: not stale, no hook.
    m.startBroadcasting();
    m._clearStaleBroadcastFlag();
    assert.strictEqual(fired, 0, 'fresh flag must not fire the hook');
    assert.strictEqual(m.isBroadcastingActive(), true, 'fresh flag retained');

    // Age the flag past the 120s watchdog threshold.
    m._broadcastingStartedAt = Date.now() - 121000;
    m._clearStaleBroadcastFlag();
    assert.strictEqual(m.isBroadcastingActive(), false, 'stale flag hard-reset to 0');
    assert.strictEqual(fired, 1, 'stale-flag clear must wake the region-end listeners (deferred fills)');
    console.log('✓ WDG-001 passed');
}

async function testWDG002_RegionEndHookErrorsAreContained() {
    console.log('\n[WDG-002] Region-end hook errors never escape the watchdog...');
    const m = newTestManager();
    m.addBroadcastRegionEndListener(() => { throw new Error('listener boom'); });
    m.startBroadcasting();
    m._broadcastingStartedAt = Date.now() - 121000;
    assert.doesNotThrow(() => m._clearStaleBroadcastFlag(), 'throwing listener must not propagate');
    assert.strictEqual(m.isBroadcastingActive(), false);
    console.log('✓ WDG-002 passed');
}

async function testWDG003_ShutdownAbortsDeferredRebalance() {
    console.log('\n[WDG-003] Shutdown aborts a deferIfBroadcasting rebalance even when idle...');
    const m = newTestManager();
    m.setShuttingDown(true);
    const r = await m.performSafeRebalance([], new Set(), { deferIfBroadcasting: true });
    assert.strictEqual(r.aborted, true, 'must abort during shutdown');
    assert.match(String(r.reason), /[Ss]hutdown/, 'reason names the shutdown');
    m.setShuttingDown(false);
    console.log('✓ WDG-003 passed');
}

async function testDRAIN001_DeferralMarksDrainResidue() {
    console.log('\n[DRAIN-001] Consumer deferral marks the queue as drain residue...');
    const bot: any = {
        _incomingFillQueue: [{ order_id: '1.7.x' }],
        _shuttingDown: false,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _deferredFillsPending: false,
        _consecutiveConsumeFailures: 0,
        _consumeFailureFirstAt: 0,
        _warn: () => {},
        manager: {
            isBroadcastingActive: () => true,
            // Any lock acquire during a deferral is a regression of the
            // lock-timeout cascade — the lock is fake-throwing to prove the
            // consumer returned BEFORE acquiring.
            _fillProcessingLock: { acquire: async () => { throw new Error('lock acquired during broadcast deferral'); } },
            _orphanFillsCreditedAt: null,
            logger: { log: () => {} },
        },
    };
    await consumeFillQueue(bot, {});
    assert.strictEqual(bot._deferredFillsPending, true, 'broadcast deferral must mark the drain-residue flag');
    assert.strictEqual(bot.manager._orphanFillsCreditedAt, null, 'tolerance stamp only applies once the drain cycle runs');
    console.log('✓ DRAIN-001 passed');
}

async function testDRAIN002_PipelineDeferralAlsoMarks() {
    console.log('\n[DRAIN-002] Order-pipeline deferral marks the drain-residue flag too...');
    const bot: any = {
        _incomingFillQueue: [{ order_id: '1.7.x' }],
        _shuttingDown: false,
        _batchInFlight: 1,
        _recoverySyncInFlight: 0,
        _deferredFillsPending: false,
        _consecutiveConsumeFailures: 0,
        _consumeFailureFirstAt: 0,
        _warn: () => {},
        manager: {
            isBroadcastingActive: () => false,
            _fillProcessingLock: { acquire: async () => { throw new Error('lock acquired during pipeline deferral'); } },
            _orphanFillsCreditedAt: null,
            logger: { log: () => {} },
        },
    };
    await consumeFillQueue(bot, {});
    assert.strictEqual(bot._deferredFillsPending, true, 'pipeline deferral must mark the drain-residue flag');
    console.log('✓ DRAIN-002 passed');
}

async function testDRAIN003_MarkerConsumedAtCycleStart() {
    console.log('\n[DRAIN-003] The drain cycle consumes the marker and widens tolerance once...');
    const bot: any = {
        _deferredFillsPending: false,
        manager: { _orphanFillsCreditedAt: 0 },
    };
    assert.strictEqual(consumeDeferredDrainMarker(bot), false, 'no marker → no-op');
    assert.strictEqual(bot.manager._orphanFillsCreditedAt, 0, 'no marker → no tolerance stamp');

    bot._deferredFillsPending = true;
    assert.strictEqual(consumeDeferredDrainMarker(bot), true, 'marker consumed');
    assert.strictEqual(bot._deferredFillsPending, false, 'marker cleared after consumption');
    assert.ok(Number.isFinite(bot.manager._orphanFillsCreditedAt) && bot.manager._orphanFillsCreditedAt > 0,
        'orphan-equivalent tolerance stamp applied (x5 tolerance for the drain cycle)');

    assert.strictEqual(consumeDeferredDrainMarker(bot), false, 'second call is a no-op (idempotent)');
    console.log('✓ DRAIN-003 passed');
}

async function testDEFER006_RegionAdvanceRearmsBound() {
    console.log('\n[DEFER-006] Advancing broadcast region re-arms the deferral bound...');
    const bound = Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS);
    const bot: any = {
        manager: {
            isBroadcastingActive: () => true,
            _broadcastingStartedAt: 500_000,
        },
        _fillBroadcastDeferSince: 0,
    };
    shouldDeferFillForBroadcast(bot, 1_000_000);
    assert.strictEqual(bot._fillBroadcastDeferSince, 1_000_000, 'first deferral stamps now');
    // Region advances (a fresh holder / progress). Even past the accumulated
    // bound, the deferral re-arms from the new region instead of falling into
    // the in-lock wait.
    bot.manager._broadcastingStartedAt = 1_000_000 + bound - 1;
    const r = shouldDeferFillForBroadcast(bot, 1_000_000 + bound + 1);
    assert.deepStrictEqual(r, { defer: true, stuckFallback: false }, 'new region must re-arm deferral');
    assert.strictEqual(bot._fillBroadcastDeferSince, 1_000_000 + bound + 1, 'marker reset to now on region change');
    console.log('✓ DEFER-006 passed');
}

async function testDEFER007_FrozenRegionStillFallsThrough() {
    console.log('\n[DEFER-007] A frozen region timestamp still trips the bound...');
    const bound = Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS);
    const bot: any = {
        manager: {
            isBroadcastingActive: () => true,
            _broadcastingStartedAt: 500_000,
        },
        _fillBroadcastDeferSince: 0,
    };
    shouldDeferFillForBroadcast(bot, 1_000_000);
    const r = shouldDeferFillForBroadcast(bot, 1_000_000 + bound);
    assert.deepStrictEqual(r, { defer: false, stuckFallback: true }, 'frozen flag must fall through at bound');
    console.log('✓ DEFER-007 passed');
}


async function testDEFER008_PlacementHoldUsesWatchdogBound() {
    console.log('\n[DEFER-008] A placement hold defers past the broadcast bound (watchdog owns the release)...');
    let now = 1_000_000;
    const regionStart = now - 5_000;
    const bot: any = {
        manager: {
            isBroadcastingActive: () => false,
            isPlacementActive: () => true,
            placementHeldForMs: () => now - regionStart,
        },
        _fillBroadcastDeferSince: 0,
    };
    assert.deepStrictEqual(
        shouldDeferFillForBroadcast(bot, now),
        { defer: true, stuckFallback: false },
        'a live placement region must defer fills'
    );
    // Past the broadcast-flag bound: a legitimate reconcile (observed ~8 min)
    // still owns placement and must keep fills deferred.
    now = regionStart + Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS) + 60_000;
    assert.deepStrictEqual(
        shouldDeferFillForBroadcast(bot, now),
        { defer: true, stuckFallback: false },
        'placement holds must not fall through at the broadcast bound'
    );
    // Last-resort valve: only past the placement watchdog + margin does the
    // consumer fall through (the watchdog should have released it already).
    now = 1_000_000 + Number(TIMING.PLACEMENT_STALE_CLEAR_MS) + Number(TIMING.BROADCAST_DEFER_SAFETY_MARGIN_MS) + 1;
    assert.deepStrictEqual(
        shouldDeferFillForBroadcast(bot, now),
        { defer: false, stuckFallback: true },
        'stuck placement past its watchdog must not starve fills'
    );

    // COW/reconcile hold BOTH the broadcast refcount and placement. The
    // placement lease owns the region's lifetime, so the broadcast bound must
    // not force a fall-through mid-reconcile.
    let bothNow = 2_000_000;
    const bothStart = bothNow - 6_000;
    const bothBot: any = {
        manager: {
            isBroadcastingActive: () => true,
            _broadcastingStartedAt: bothStart,
            isPlacementActive: () => true,
            placementHeldForMs: () => bothNow - bothStart,
        },
        _fillBroadcastDeferSince: 0,
    };
    shouldDeferFillForBroadcast(bothBot, bothNow);
    bothNow += Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS) + 60_000;
    assert.deepStrictEqual(
        shouldDeferFillForBroadcast(bothBot, bothNow),
        { defer: true, stuckFallback: false },
        'a placement-backed broadcast region must use the placement watchdog bound'
    );
    console.log('✓ DEFER-008 passed');
}

async function testCFG002_DeferBoundExceedsStaleClear() {
    console.log('\n[CFG-002] Fill deferral bound outlasts the stale-broadcast watchdog...');
    assert.ok(Number(TIMING.BROADCAST_STALE_CLEAR_MS) > 0, 'watchdog threshold must be configured');
    assert.ok(
        Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS) > Number(TIMING.BROADCAST_STALE_CLEAR_MS),
        'deferral bound must exceed the stale-clear threshold or a long region drops into the in-lock wait'
    );
    console.log('✓ CFG-002 passed');
}

async function runAllTests() {
    console.log('=== Fill-Pipeline Robustness Test Suite ===\n');
    await testDEFER001_IdleProceedsAndClearsMarker();
    await testDEFER002_ActiveBroadcastDefers();
    await testDEFER003_WithinBoundKeepsDeferring();
    await testDEFER004_BoundExpiryFallsThrough();
    await testDEFER005_MissingManagerFailsOpen();
    await testDEFER006_RegionAdvanceRearmsBound();
    await testDEFER007_FrozenRegionStillFallsThrough();
    await testDEFER008_PlacementHoldUsesWatchdogBound();
    await testCFG002_DeferBoundExceedsStaleClear();
    await testHOLD010_ConsecutiveTrackingAndSnapshot();
    await testHOLD011_ClearResetsAndNullManagerSafe();
    await testHOLD012_PlanSignatureSetAndCleared();
    await testDFER006_ActiveBroadcastDefersRebalance();
    await testDFER007_IdenticalHeldPlanDefers();
    await testCFG001_HoldResyncTuningPresent();
    await testWDG001_StaleWatchdogFiresRegionEnd();
    await testWDG002_RegionEndHookErrorsAreContained();
    await testWDG003_ShutdownAbortsDeferredRebalance();
    await testDRAIN001_DeferralMarksDrainResidue();
    await testDRAIN002_PipelineDeferralAlsoMarks();
    await testDRAIN003_MarkerConsumedAtCycleStart();
    console.log('\n=== All fill-pipeline robustness tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });

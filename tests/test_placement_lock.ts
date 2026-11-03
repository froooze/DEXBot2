/**
 * tests/test_placement_lock.ts
 *
 * Unit tests for modules/order/placement_lock.ts — the exclusive placement
 * region shared by every chain-mutating path.
 *
 * Covered:
 *  1. acquire/release basics (kind, heldForMs, double-release is a no-op);
 *  2. FIFO handoff: a waiter gets the lease when the holder releases;
 *  3. tryAcquire returns null while held;
 *  4. bounded wait returns null on timeout;
 *  5. forceRelease wakes waiters with null and a stale lease release cannot
 *     steal a lock re-acquired afterwards (ABA guard).
 */

const assert = require('assert');
const PlacementLock = require('../modules/order/placement_lock').default;

async function testAcquireRelease() {
    console.log('\n - acquire/release basics...');
    const lock = new PlacementLock();
    assert.strictEqual(lock.isHeld(), false);
    const lease = await lock.acquire('test');
    assert.ok(lease, 'lease must be returned when free');
    assert.strictEqual(lock.isHeld(), true);
    assert.strictEqual(lock.kind(), 'test');
    assert.ok(lock.heldForMs() >= 0);
    lease.release();
    assert.strictEqual(lock.isHeld(), false);
    lease.release(); // double release is a no-op
    assert.strictEqual(lock.isHeld(), false);
    console.log('  PASS');
}

async function testFifoHandoff() {
    console.log('\n - FIFO handoff to a waiter...');
    const lock = new PlacementLock();
    const first = await lock.acquire('first');
    assert.ok(first);
    const order = [];
    const secondP = lock.acquire('second').then((lease) => {
        order.push('second');
        return lease;
    });
    const thirdP = lock.acquire('third').then((lease) => {
        order.push('third');
        return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(lock.queueLength(), 2);
    assert.strictEqual(lock.tryAcquire('intruder'), null, 'tryAcquire must not barge the queue');
    first.release();
    const second = await secondP;
    assert.ok(second, 'second waiter must get the lease');
    assert.deepStrictEqual(order, ['second']);
    second.release();
    const third = await thirdP;
    assert.ok(third, 'third waiter must get the lease');
    assert.deepStrictEqual(order, ['second', 'third']);
    third.release();
    assert.strictEqual(lock.isHeld(), false);
    console.log('  PASS');
}

async function testTimeout() {
    console.log('\n - bounded wait returns null on timeout...');
    const lock = new PlacementLock();
    const holder = await lock.acquire('holder');
    const started = Date.now();
    const timedOut = await lock.acquire('waiter', { timeoutMs: 30 });
    const elapsed = Date.now() - started;
    assert.strictEqual(timedOut, null, 'waiter must time out');
    assert.ok(elapsed >= 25, `wait should last at least ~30ms, got ${elapsed}ms`);
    assert.strictEqual(lock.queueLength(), 0, 'timed-out waiter must be removed from the queue');
    holder.release();
    console.log('  PASS');
}

async function testForceReleaseAba() {
    console.log('\n - forceRelease + stale lease cannot steal a new holder (ABA)...');
    const lock = new PlacementLock();
    const stale = await lock.acquire('stale');
    assert.ok(stale);

    const waiter = lock.acquire('waiter');
    await new Promise((resolve) => setTimeout(resolve, 5));

    lock.forceRelease();
    assert.strictEqual(await waiter, null, 'queued waiter must resolve null on forceRelease');
    assert.strictEqual(lock.isHeld(), false);

    const fresh = await lock.acquire('fresh');
    assert.ok(fresh, 'new acquire after forceRelease must succeed');
    assert.strictEqual(lock.kind(), 'fresh');

    // The stale lease from before forceRelease must NOT release the new holder.
    stale.release();
    assert.strictEqual(lock.isHeld(), true, 'stale lease release must not clear the new holder');
    assert.strictEqual(lock.kind(), 'fresh');
    fresh.release();
    assert.strictEqual(lock.isHeld(), false);
    console.log('  PASS');
}

async function testRegionEndCallback() {
    console.log('\n - region-end callback fires on full release, not handoff...');
    let ended = 0;
    const lock = new PlacementLock(() => { ended++; });
    const first = await lock.acquire('first');
    assert.ok(first);
    const waiterP = lock.acquire('waiter');
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.release(); // handoff to waiter: region stays contiguous, no wake
    const waiter = await waiterP;
    assert.ok(waiter);
    assert.strictEqual(ended, 0, 'a handoff must not fire the region-end callback');
    waiter.release();
    assert.strictEqual(ended, 1, 'the final release must fire the region-end callback exactly once');
    console.log('  PASS');
}


async function testPlacementWatchdog() {
    console.log('\n - stale placement region watchdog force-releases; fresh lease is kept...');
    const { OrderManager } = require('../modules/order/index').default;
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100, minPrice: 50, maxPrice: 200,
        incrementPercent: 10, targetSpreadPercent: 10,
        botFunds: { buy: 1000, sell: 10 }, coreOrders: { buy: 2, sell: 2 },
    });
    const stale = await mgr.acquirePlacement('test-holder');
    assert.ok(stale);
    (mgr as any)._placementLock._since = Date.now() - 16 * 60 * 1000;
    assert.strictEqual(mgr._clearStalePlacementRegion(), true, 'a 16-minute hold must be force-released');
    assert.strictEqual(mgr.isPlacementActive(), false, 'the region must be free after the watchdog');
    stale.release();
    assert.strictEqual(mgr.isPlacementActive(), false, 'a stale lease release must not affect a successor');

    const fresh = await mgr.acquirePlacement('test-holder');
    assert.ok(fresh);
    assert.strictEqual(mgr._clearStalePlacementRegion(), false, 'a fresh region must not be force-released');
    assert.strictEqual(mgr.isPlacementActive(), true);
    fresh.release();
    console.log('  PASS');
}

async function testWatchdogRespectsLivePipeline() {
    console.log('\n - the watchdog keeps a region a live (young) batch still owns...');
    const { OrderManager } = require('../modules/order/index').default;
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100, minPrice: 50, maxPrice: 200,
        incrementPercent: 10, targetSpreadPercent: 10,
        botFunds: { buy: 1000, sell: 10 }, coreOrders: { buy: 2, sell: 2 },
    });
    const lease = await mgr.acquirePlacement('long-create-group');
    assert.ok(lease);
    (mgr as any)._placementLock._since = Date.now() - 16 * 60 * 1000;
    assert.strictEqual(
        mgr._clearStalePlacementRegion(undefined, { batchInFlightMs: 60_000 }),
        false,
        'a batch younger than the bound proves progress: no teardown'
    );
    assert.strictEqual(mgr.isPlacementActive(), true, 'the region must still be held');
    assert.strictEqual(
        mgr._clearStalePlacementRegion(undefined, { batchInFlightMs: 20 * 60 * 1000 }),
        true,
        'a batch past the same bound is part of the hung region'
    );
    assert.strictEqual(mgr.isPlacementActive(), false);
    console.log('  PASS');
}

async function testOneAuthorityTearsDownAHungRegion() {
    console.log('\n - one authority tears down a hung placement + broadcast region...');
    const { OrderManager } = require('../modules/order/index').default;
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100, minPrice: 50, maxPrice: 200,
        incrementPercent: 10, targetSpreadPercent: 10,
        botFunds: { buy: 1000, sell: 10 }, coreOrders: { buy: 2, sell: 2 },
    });
    let regionEnds = 0;
    mgr.addBroadcastRegionEndListener(() => { regionEnds += 1; });
    mgr.startBroadcasting();
    const lease = await mgr.acquirePlacement('hung-holder');
    assert.ok(lease);
    (mgr as any)._placementLock._since = Date.now() - 16 * 60 * 1000;
    (mgr as any)._broadcastingStartedAt = Date.now() - 16 * 60 * 1000;

    // The broadcast watchdog alone must not act while placement is held.
    mgr._clearStaleBroadcastFlag();
    assert.strictEqual(mgr.isBroadcastingActive(), true, 'the refcount watchdog must defer to a held placement lease');

    assert.strictEqual(mgr._clearStalePlacementRegion(), true, 'the placement watchdog owns the teardown');
    assert.strictEqual(mgr.isPlacementActive(), false);
    assert.strictEqual(
        mgr.isBroadcastingActive(), false,
        'the broadcast refcount of the SAME hung region must be cleared in one step (not on a later tick)'
    );
    assert.strictEqual(regionEnds, 1, 'exactly one region-end notification');
    console.log('  PASS');
}

async function testLeaseLiveness() {
    console.log('\n - lease liveness is the token, not isPlacementActive()...');
    const { OrderManager } = require('../modules/order/index').default;
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100, minPrice: 50, maxPrice: 200,
        incrementPercent: 10, targetSpreadPercent: 10,
        botFunds: { buy: 1000, sell: 10 }, coreOrders: { buy: 2, sell: 2 },
    });
    const lease = await mgr.acquirePlacement('a');
    assert.ok(lease);
    assert.strictEqual(mgr.isPlacementLeaseCurrent(lease), true, 'the holder lease is current');
    assert.strictEqual(mgr.isPlacementLeaseCurrent(null), false, 'a missing lease is never current');

    const waitP = mgr.acquirePlacement('b');
    lease.release();
    const handed = await waitP;
    assert.ok(handed);
    assert.strictEqual(mgr.isPlacementLeaseCurrent(lease), false, 'a released lease must not read as current after a handoff');
    assert.strictEqual(mgr.isPlacementLeaseCurrent(handed), true, 'the handed-off lease is current');

    (mgr as any)._placementLock._since = Date.now() - 16 * 60 * 1000;
    assert.strictEqual(mgr._clearStalePlacementRegion(), true);
    assert.strictEqual(
        mgr.isPlacementLeaseCurrent(handed), false,
        'a force-released lease must not read as current (isPlacementActive() alone would lie)'
    );
    console.log('  PASS');
}

async function testShutdownProbe() {
    console.log('\n - shutdown probe rejects acquisition...');
    const lock = new PlacementLock();
    const lease = await lock.acquire('test', { isShuttingDown: () => true });
    assert.strictEqual(lease, null);
    assert.strictEqual(lock.isHeld(), false);
    console.log('  PASS');
}

(async () => {
    console.log('Running placement lock tests...');
    await testAcquireRelease();
    await testFifoHandoff();
    await testTimeout();
    await testForceReleaseAba();
    await testRegionEndCallback();
    await testPlacementWatchdog();
    await testWatchdogRespectsLivePipeline();
    await testOneAuthorityTearsDownAHungRegion();
    await testLeaseLiveness();
    await testShutdownProbe();
    console.log('\n✓ All placement lock tests passed');
})().catch((err) => {
    console.error('❌ Placement lock test failed:', err);
    process.exit(1);
});

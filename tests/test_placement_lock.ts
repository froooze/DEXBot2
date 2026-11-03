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
    await testShutdownProbe();
    console.log('\n✓ All placement lock tests passed');
})().catch((err) => {
    console.error('❌ Placement lock test failed:', err);
    process.exit(1);
});

/**
 * tests/test_structural_resync_fill_gate.ts
 *
 * Contract: the structural resync — which reloads the grid from the persisted
 * on-disk snapshot — must not run while the fill pipeline is still unsettled.
 *
 * A fill batch mutates the grid in memory long before its persistence flush
 * reaches disk, so at that moment the snapshot on disk still describes the
 * PRE-fill slot sizes. Reloading it rolls an applied fill back, and the next
 * fill for the same order is then subtracted from the rolled-back baseline,
 * leaving a phantom residual plus an orderId the chain no longer has. Observed
 * live: two partial fills of ONE order in consecutive blocks; the reload
 * between them turned a completed order into a phantom parked in the gap band,
 * which froze the boundary crawl so the spread could not be closed.
 *
 * The deferral reuses the existing batch-in-flight retry timer, but an
 * unsettled pipeline gets its own longer max-defer cap: forcing a reload at
 * the ordinary 30 s cap reintroduces the rollback this gate exists to prevent.
 * A permanently unsettled pipeline still forces the resync eventually (5 min),
 * and a global ceiling bounds the whole episode even if the defer cause keeps
 * alternating between short-cap and long-cap classes, so recovery cannot park
 * forever.
 */

const assert = require('assert');
const DEXBot = require('../modules/dexbot_class').default;

let failures = 0;
function check(name: string, actual: any, expected: any) {
    try {
        assert.deepStrictEqual(actual, expected);
        console.log(`   ✓ ${name}`);
    } catch (err: any) {
        failures += 1;
        console.error(`   ✗ ${name}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`);
    }
}

/**
 * Virtual clock for the defer mechanism.
 *
 * The production gate re-arms a `TIMING.LOCK_REFRESH_MIN_MS` (250 ms)
 * `setTimeout` on every defer and does its cap math with `Date.now()`. Driving
 * that with real wall-clock sleeps cost ~6 s per run of this file — the slowest
 * test in the suite by an order of magnitude — while asserting nothing about
 * real elapsed time. A virtual clock runs the exact same timer callbacks and
 * cap checks in a few milliseconds. This file runs in its own Node process
 * (the runner spawns one per test), so patching the globals here cannot affect
 * production or any other test.
 */
function installFakeClock() {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const realDateNow = Date.now;
    let now = realDateNow();
    let seq = 0;
    const timers = new Map<number, { id: number; at: number; fn: () => void; every: number | null }>();

    (globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms = 0, ...args: any[]) => {
        const id = ++seq;
        timers.set(id, { id, at: now + ms, fn: () => fn(...args), every: null });
        return id as any;
    };
    (globalThis as any).clearTimeout = (id: any) => { timers.delete(Number(id)); };
    (globalThis as any).setInterval = (fn: (...a: any[]) => void, ms = 0, ...args: any[]) => {
        const id = ++seq;
        timers.set(id, { id, at: now + ms, fn: () => fn(...args), every: ms });
        return id as any;
    };
    (globalThis as any).clearInterval = (id: any) => { timers.delete(Number(id)); };
    Date.now = () => now;

    /** Move virtual time forward, firing every due timer in order. */
    async function advance(ms: number) {
        const target = now + ms;
        while (true) {
            let next: { id: number; at: number; fn: () => void; every: number | null } | undefined;
            for (const t of timers.values()) {
                if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
            }
            if (!next) break;
            now = Math.max(now, next.at);
            if (next.every !== null) next.at = now + next.every;
            else timers.delete(next.id);
            next.fn();
            // Let promise continuations spawned by the callback settle before
            // evaluating the next timer or a predicate.
            await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
        }
        now = target;
    }

    function restore() {
        (globalThis as any).setTimeout = realSetTimeout;
        (globalThis as any).clearTimeout = realClearTimeout;
        (globalThis as any).setInterval = realSetInterval;
        (globalThis as any).clearInterval = realClearInterval;
        Date.now = realDateNow;
    }
    return { advance, restore };
}

const clock = installFakeClock();

function sleep(ms: number) {
    return clock.advance(ms);
}

/** Advance virtual time until `predicate` is true. */
async function waitFor(predicate: () => boolean, message: string, maxMs = 3000) {
    let waited = 0;
    while (!predicate()) {
        if (waited >= maxMs) throw new Error(`Timed out waiting for ${message}`);
        await clock.advance(10);
        waited += 10;
    }
}

function makeBot(botKey: string) {
    const bot: any = new DEXBot({
        botKey,
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5,
    });
    // Minimal manager shape: the resync wiring only reaches for logging, the
    // recovery state and the reload hook. Every fill-pipeline field stays
    // undefined (= settled) except the incoming queue owned by the bot.
    bot.manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' },
        },
        orders: new Map(),
        logger: { log: () => {}, logFundsStatus: () => {} },
        _recoveryState: { attemptCount: 2, lastAttemptAt: 1, lastFailureAt: 2, structuralResyncRequested: false },
        isPlacementActive: () => false,
        isStructuralRebuildInProgress: () => false,
        isBroadcastingActive: () => false,
    };
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    const calls: string[] = [];
    bot._recoverFromPersistedGrid = async () => {
        calls.push('reload');
        return { success: true };
    };
    bot.requestGridReset = async (reason: string) => {
        calls.push(`reset:${reason}`);
        return { success: true };
    };
    return { bot, calls };
}

// ---------------------------------------------------------------------------
// 1. A queued fill defers the reload
// ---------------------------------------------------------------------------
async function testQueuedFillDefersReload() {
    console.log('\n[1] A queued fill defers the snapshot reload');
    const { bot, calls } = makeBot('test_structural_resync_fill_gate');
    bot._wireStructuralGridResyncRequest();

    bot._incomingFillQueue.push({ op: { order_id: '1.7.900' }, block_num: 1, id: '1.1.1' });

    await bot.manager.requestStructuralGridResync('pre-broadcast update target missing on chain', {});
    // Let several defer ticks elapse (the defer re-arms every 250ms).
    await sleep(600);
    check('no reload while a fill is queued', calls, []);
    check('resync still scheduled (deferred, not dropped)', Boolean(bot._structuralGridResyncTimer), true);
    check('defer is counted', bot._structuralGridResyncDeferCount > 1, true);

    // The pipeline drains: the deferred resync must now run.
    bot._incomingFillQueue.length = 0;
    await waitFor(() => calls.length >= 1, 'deferred resync to run after the fill pipeline settles');
    check('reload ran exactly once after settle', calls, ['reload']);
    check('defer bookkeeping cleared', [bot._structuralGridResyncDeferStartedAt, bot._structuralGridResyncDeferCount], [null, 0]);
}

// ---------------------------------------------------------------------------
// 1b. An active placement region defers the reload too
// ---------------------------------------------------------------------------
async function testPlacementRegionDefersReload() {
    console.log('\n[1b] an active placement region defers the snapshot reload');
    const { bot, calls } = makeBot('test_structural_resync_placement_gate');
    let held = true;
    (bot.manager as any).isPlacementActive = () => held;
    (bot.manager as any).placementKind = () => 'spread-correction';
    bot._wireStructuralGridResyncRequest();

    await bot.manager.requestStructuralGridResync('fund invariant drift', {});
    await sleep(600);
    check('no reload while a placement region is held', calls, []);
    check('placement defer is counted', bot._structuralGridResyncDeferCount > 1, true);

    held = false;
    await waitFor(() => calls.length >= 1, 'deferred resync to run after the region ends');
    check('reload ran once after region end', calls, ['reload']);
}

// ---------------------------------------------------------------------------
// 1c. The reload gate honours the same four deferrals as the snapshot gate
// ---------------------------------------------------------------------------
async function testOtherInFlightFlagsDeferReload() {
    console.log('\n[1c] recovery-sync and deferred-rebalance flags defer the reload too');
    for (const flag of ['recovery', 'rebalance'] as const) {
        const { bot, calls } = makeBot(`test_structural_resync_${flag}_gate`);
        if (flag === 'recovery') bot._recoverySyncInFlight = 1;
        else (bot.manager as any)._deferredRebalanceAt = Date.now();
        bot._wireStructuralGridResyncRequest();
        await bot.manager.requestStructuralGridResync('fund invariant drift', {});
        await sleep(450);
        check(`no reload while ${flag} is pending`, calls, []);
        if (bot._structuralGridResyncTimer) clearTimeout(bot._structuralGridResyncTimer);
    }
}

// ---------------------------------------------------------------------------
// 2. A deferred fill drain (the reload-between-two-fills case) defers as well
// ---------------------------------------------------------------------------
async function testDeferredDrainDefersReload() {
    console.log('\n[2] A pending deferred-fill drain defers the snapshot reload');
    const { bot, calls } = makeBot('test_structural_resync_fill_gate_deferred');
    bot._wireStructuralGridResyncRequest();

    // No queued fill, but the consumer still owes a drain: the grid has moved
    // and the snapshot has not caught up yet.
    bot._deferredFillsPending = true;

    await bot.manager.requestStructuralGridResync('pre-broadcast update target missing on chain', {});
    await sleep(400);
    check('no reload while a deferred drain is pending', calls, []);

    bot._deferredFillsPending = false;
    await waitFor(() => calls.length >= 1, 'deferred resync to run after the drain clears');
    check('reload ran once after the drain cleared', calls, ['reload']);
}

// ---------------------------------------------------------------------------
// 3. An unsettled fill pipeline gets a dedicated max-defer cap
// ---------------------------------------------------------------------------
async function testUnsettledFillHasLongerCap() {
    console.log('\n[3] an unsettled fill pipeline is not forced at the 30s cap');
    const { bot, calls } = makeBot('test_structural_resync_long_cap');
    bot._wireStructuralGridResyncRequest();
    bot._incomingFillQueue.push({ op: { order_id: '1.7.900' }, block_num: 1, id: '1.1.1' });

    await bot.manager.requestStructuralGridResync('fund invariant drift', {});
    await sleep(300);
    // Pretend the ordinary 30s cap has elapsed: the fill cause must still defer.
    bot._structuralGridResyncDeferStartedAt = Date.now() - 31_000;
    await sleep(450);
    check('no forced reload at 30s with an unsettled pipeline', calls, []);
    check('resync still scheduled under the longer cap', Boolean(bot._structuralGridResyncTimer), true);

    // The dedicated 5-minute cap still bounds the deferral.
    bot._structuralGridResyncDeferStartedAt = Date.now() - (5 * 60 * 1000 + 1000);
    await waitFor(() => calls.length >= 1, 'forced reload after the dedicated fill cap');
    check('reload eventually forced', calls, ['reload']);
    bot._incomingFillQueue.length = 0;
    if (bot._structuralGridResyncTimer) clearTimeout(bot._structuralGridResyncTimer);

    // Other causes keep the ordinary 30s cap.
    const { bot: placementBot, calls: placementCalls } = makeBot('test_structural_resync_short_cap');
    placementBot._wireStructuralGridResyncRequest();
    let held = true;
    (placementBot.manager as any).isPlacementActive = () => held;
    (placementBot.manager as any).placementKind = () => 'spread-correction';
    await placementBot.manager.requestStructuralGridResync('fund invariant drift', {});
    await sleep(300);
    placementBot._structuralGridResyncDeferStartedAt = Date.now() - 31_000;
    await waitFor(() => placementCalls.length >= 1, 'forced reload at 30s for a placement region');
    check('ordinary causes still force at 30s', placementCalls, ['reload']);
    held = false;
    if (placementBot._structuralGridResyncTimer) clearTimeout(placementBot._structuralGridResyncTimer);
}

// ---------------------------------------------------------------------------
// 4. A cause-class change restarts the defer clock
// ---------------------------------------------------------------------------
async function testDeferClassChangeRestoresClock() {
    console.log('\n[4] switching cause classes saves and restores each clock');
    const { bot, calls } = makeBot('test_structural_resync_class_switch');
    bot._wireStructuralGridResyncRequest();
    let held = true;
    (bot.manager as any).isPlacementActive = () => held;
    (bot.manager as any).placementKind = () => 'spread-correction';

    await bot.manager.requestStructuralGridResync('fund invariant drift', {});
    await sleep(300);
    const shortStart = bot._structuralGridResyncDeferStartedAt;

    // Short -> long: placement ends, a fill queues.
    held = false;
    bot._incomingFillQueue.push({ op: { order_id: '1.7.901' }, block_num: 1, id: '1.1.2' });
    await sleep(450);
    check('no reload after the first switch', calls, []);
    check('defer class switched to long', bot._structuralGridResyncDeferClass, 'long');
    check('long clock started fresh', bot._structuralGridResyncDeferStartedAt > shortStart, true);
    const longStart = bot._structuralGridResyncDeferStartedAt;

    // Long -> short: returning to a used class must restore its OWN window,
    // not restart from now (a mutation of `saved.startedAt || now` breaks this).
    held = true;
    bot._incomingFillQueue.length = 0;
    await sleep(450);
    check('no reload after the second switch', calls, []);
    check('defer class switched back to short', bot._structuralGridResyncDeferClass, 'short');
    check('short clock restored to its original start', bot._structuralGridResyncDeferStartedAt, shortStart);
    check('long clock saved for a future switch',
        bot._structuralGridResyncDeferClocks.long.startedAt, longStart);

    if (bot._structuralGridResyncTimer) clearTimeout(bot._structuralGridResyncTimer);
}

// ---------------------------------------------------------------------------
// 5. Alternating causes cannot park the resync forever
// ---------------------------------------------------------------------------
async function testAlternatingCauseStillForces() {
    console.log('\n[5] an alternating defer cause still reaches the global ceiling');
    const { bot, calls } = makeBot('test_structural_resync_alternating');
    bot._wireStructuralGridResyncRequest();
    let placementHeld = true;
    (bot.manager as any).isPlacementActive = () => placementHeld;
    (bot.manager as any).placementKind = () => 'spread-correction';

    await bot.manager.requestStructuralGridResync('fund invariant drift', {});
    await sleep(300);
    // Simulate a long episode, then flip between the short-cap and long-cap
    // causes faster than the defer tick. With one resettable clock this would
    // never force; the global ceiling must still end the episode.
    bot._structuralGridResyncDeferGlobalStartedAt = Date.now() - (5 * 60 * 1000 + 1000);
    const flip = setInterval(() => {
        placementHeld = !placementHeld;
        if (placementHeld) bot._incomingFillQueue.length = 0;
        else bot._incomingFillQueue.push({ op: { order_id: '1.7.902' }, block_num: 1, id: '1.1.3' });
    }, 40);
    try {
        await waitFor(() => calls.length >= 1, 'forced reload despite alternating causes');
        check('global ceiling forces reload under alternating causes', calls, ['reload']);
    } finally {
        clearInterval(flip);
        bot._incomingFillQueue.length = 0;
        if (bot._structuralGridResyncTimer) clearTimeout(bot._structuralGridResyncTimer);
    }
}

async function run() {
    console.log('Running structural-resync fill-gate tests...');
    await testQueuedFillDefersReload();
    await testPlacementRegionDefersReload();
    await testOtherInFlightFlagsDeferReload();
    await testDeferredDrainDefersReload();
    await testUnsettledFillHasLongerCap();
    await testDeferClassChangeRestoresClock();
    await testAlternatingCauseStillForces();

    clock.restore();
    if (failures > 0) {
        console.error(`\n❌ ${failures} structural-resync fill-gate assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All structural-resync fill-gate assertions passed');
}

run().catch((err) => {
    clock.restore();
    console.error('Structural-resync fill-gate test failed:', err);
    process.exit(1);
});

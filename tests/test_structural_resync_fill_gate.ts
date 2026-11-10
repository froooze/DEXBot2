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
 * The deferral reuses the existing batch-in-flight defer (same retry timer,
 * same max-defer escape hatch), so a permanently unsettled pipeline still
 * forces the resync instead of parking it forever.
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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` is true, yielding between checks. */
function waitFor(predicate: () => boolean, message: string, maxMs = 3000) {
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
        const tick = () => {
            let done = false;
            try { done = !!predicate(); } catch (err) { reject(err); return; }
            if (done) return resolve();
            if (Date.now() - start >= maxMs) return reject(new Error(`Timed out waiting for ${message}`));
            setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
    });
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

async function run() {
    console.log('Running structural-resync fill-gate tests...');
    await testQueuedFillDefersReload();
    await testDeferredDrainDefersReload();

    if (failures > 0) {
        console.error(`\n❌ ${failures} structural-resync fill-gate assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All structural-resync fill-gate assertions passed');
}

run().catch((err) => {
    console.error('Structural-resync fill-gate test failed:', err);
    process.exit(1);
});

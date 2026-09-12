/**
 * tests/test_deferred_fill_retry.ts
 *
 * Regression test for the 2026-09-12 stale-grid incident on a live
 * market-pair bot: fills deferred by an active broadcast region lost their
 * retry when the region had ALREADY ended before the fills were processed
 * (no future stopBroadcasting transition, so the edge-triggered region-end
 * hook never fired and the grid froze).
 *
 * _processFillsWithBatching must schedule the no-fill rebalance directly
 * (level-triggered) whenever any chunk defers — not rely solely on the hook.
 */

const assert = require('assert');
const DEXBot = require('../modules/dexbot_class').default;

function makeFill(id: string) {
    return { id, orderId: `1.7.${id.replace(/\D/g, '')}`, type: 'SELL', price: 920, size: 2, isPartial: false, blockNum: 114302238 };
}

function makeBot(processFilledOrdersImpl: any) {
    const bot = new DEXBot({
        name: 'test-deferred-fill-retry',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 0.02,
        minPrice: 0.01,
        maxPrice: 0.04,
        botFunds: { buy: 100, sell: 100 },
        activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 },
    });

    const safeRebalanceCalls: any[] = [];
    bot._safeRebalanceCalls = safeRebalanceCalls;

    bot.manager = {
        logger: {
            log: (msg: string, lvl: string) => { /* silent */ },
            logFundsStatus: () => {},
        },
        pauseFundRecalc() {},
        resumeFundRecalc() {},
        flushGridDirty: async () => {},
        processFilledOrders: processFilledOrdersImpl,
        // Satisfies _schedulePostRecoveryRebalance's guards so the REAL
        // scheduler runs; records the no-fill rebalance it triggers.
        performSafeRebalance: async (fills: any[], excl: any) => {
            safeRebalanceCalls.push({ fills, excl });
            return { aborted: false, actions: [], stateUpdates: [] };
        },
    };
    bot.updateOrdersOnChainBatch = async () => ({ executed: true });

    bot._executeBatchIfNeeded = async () => ({ executed: true, hadRotation: false, skippedNoActions: false });

    return bot;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
    console.log('Running test_deferred_fill_retry.js...\n');

    // --- Test 1: deferred chunk schedules the no-fill rebalance directly ---
    // (no region-end hook involved at all — the incident ordering)
    {
        const bot = makeBot(async () => ({
            actions: [],
            stateUpdates: [],
            hadRotation: false,
            aborted: false,
            deferred: true,
        }));

        let executedBatchCalls = 0;
        bot._executeBatchIfNeeded = async () => {
            executedBatchCalls++;
            return { executed: true };
        };

        const result = await bot._processFillsWithBatching([makeFill('slot-126'), makeFill('slot-127')], null, 'fill set');
        assert.strictEqual(result.aborted, false, 'deferred cycle should not abort');
        assert.strictEqual((result as any).deferred, true, 'deferred cycle should report deferred=true');
        assert.strictEqual(executedBatchCalls, 0, 'deferred chunk must not broadcast');

        await sleep(50);
        assert.strictEqual(bot._safeRebalanceCalls.length, 1, 'exactly one no-fill retry must be scheduled (hook may never fire)');
        assert.deepStrictEqual(bot._safeRebalanceCalls[0].fills, [], 'retry is a no-fill rebalance');
        assert.ok(bot._postRecoveryRebalanceTimer == null, 'scheduler timer settled');
        console.log('  ✓ deferred chunk schedules the no-fill rebalance without waiting for a region end');
    }

    // --- Test 2: non-deferred path schedules nothing (behavior unchanged) ---
    {
        const bot = makeBot(async () => ({
            actions: [{ type: 'create', id: 'slot-142' }],
            stateUpdates: [],
            hadRotation: false,
            aborted: false,
        }));

        const result = await bot._processFillsWithBatching([makeFill('slot-126')], null, 'fill set');
        assert.strictEqual(result.aborted, false, 'normal cycle should not abort');
        assert.strictEqual((result as any).deferred || false, false, 'normal cycle should not report deferred');

        await sleep(50);
        assert.strictEqual(bot._safeRebalanceCalls.length, 0, 'normal path must not schedule a retry');
        console.log('  ✓ non-deferred path schedules nothing');
    }

    console.log('\nAll deferred fill retry tests passed.\n');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});

/**
 * tests/test_fill_batch_chunking.ts
 *
 * Tests for _processFillsWithBatching — verifies gap-slot-derived batch
 * sizing enforcement across the unified fill-chunking + rebalance +
 * broadcast pipeline (batch size = gap slots + 1, DEXBot._getGapSlotBatchSize).
 */

const assert = require('assert');
const DEXBot = require('../modules/dexbot_class').default;
require('../modules/order/grid'); // ensure loaded
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

// Grid gap-slot count used by these tests. The production batch cap is
// gapSlots + 1 (DEXBot._getGapSlotBatchSize), so a 4-slot gap yields the
// 5-fill MAX_BATCH the assertions below expect.
const GAP_SLOTS = 4;
const MAX_BATCH = GAP_SLOTS + 1;

function makeFill(id: string, orderId: string | null = null, type: string = 'SELL') {
    return { id, orderId: orderId || `1.7.${id.replace(/\D/g, '')}`, type, price: 0.02, size: 100, isPartial: false, blockNum: 1000 + parseInt(id.replace(/\D/g, ''), 10) || 1 };
}

function makeBot(configOverrides: Record<string, unknown> = {}) {
    const bot = new DEXBot({
        name: 'test-fill-batch-chunking',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 0.02,
        minPrice: 0.01,
        maxPrice: 0.04,
        botFunds: { buy: 100, sell: 100 },
        coreOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 },
        ...configOverrides,
    });

    bot.manager = {
        _gapSlots: GAP_SLOTS,
        logger: {
            log: (msg: string, lvl: string) => { /* silent */ },
            logFundsStatus: () => {},
        },
        _pauseFundRecalc: 0,
        pauseFundRecalc() { this._pauseFundRecalc++; },
        resumeFundRecalc() { this._pauseFundRecalc = Math.max(0, this._pauseFundRecalc - 1); },
        _clearWorkingGridRef() {},
        _setRebalanceState() {},
        _resetRebalanceStateToDepth() {},
        startBroadcasting() {},
        stopBroadcasting() {},
        lockOrders() {},
        unlockOrders() {},
    };

    const callLog: any[] = [];
    bot._callLog = callLog;

    bot.manager.processFilledOrders = async (fills: any[], excl: any, options: any) => {
        callLog.push({ method: 'processFilledOrders', fillCount: fills.length, exclSize: excl?.size || 0, options });
        return {
            actions: [{ type: 'create', id: fills[0]?.id || 'x' }],
            stateUpdates: [],
            hadRotation: false,
            workingGrid: { getIndexes: () => ({}), getBoundary: () => 0 },
            workingIndexes: {},
            workingBoundary: 0,
            aborted: false,
        };
    };

    // Pivot-stamp spy: _processFillsWithBatching records the guard pivot once
    // per planned chunk. Coalescing the backlog must stamp the WHOLE cycle in
    // one call (so the pivot is the last fill, not the first chunk's).
    bot.manager.recordLastFilledPrices = (fills: any[]) => {
        callLog.push({
            method: 'recordLastFilledPrices',
            fillCount: fills.length,
            lastId: fills[fills.length - 1]?.id,
            lastPrice: fills[fills.length - 1]?.price,
        });
    };

    bot._executeBatchIfNeeded = async (rebalanceResult: any, contextLabel: string) => {
        callLog.push({ method: '_executeBatchIfNeeded', contextLabel });
        return { executed: true, hadRotation: false, skippedNoActions: false };
    };

    bot._refreshDynamicWeightDistribution = (context: string) => {
        callLog.push({ method: '_refreshDynamicWeightDistribution', context });
    };

    return bot;
}

function makeBootstrapFill(n: number) {
    return {
        id: `1.11.${9000 + n}`,
        block_num: 9000 + n,
        op: [4, {
            order_id: `1.7.${n}`,
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 },
            is_maker: true,
        }],
    };
}

function makeBootstrapBot() {
    const bot = new DEXBot({
        name: 'test-bootstrap-fill-batch-chunking',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 0.02,
        minPrice: 0.01,
        maxPrice: 0.04,
        botFunds: { buy: 100, sell: 100 },
        coreOrders: { buy: 6, sell: 6 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 },
    });

    const orders = new Map();
    // Seed enough live orders that every bootstrap fill (MAX_BATCH + 2 of
    // them) matches an order instead of being dropped as unmatched.
    for (let i = 1; i <= MAX_BATCH + 2; i++) {
        orders.set(`buy-${i}`, {
            id: `buy-${i}`,
            orderId: `1.7.${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 0.02 - i * 0.0001,
            size: 10,
        });
        orders.set(`sell-active-${i}`, {
            id: `sell-active-${i}`,
            orderId: `1.7.${100 + i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 0.021 + i * 0.0001,
            size: 10,
        });
        orders.set(`sell-empty-${i}`, {
            id: `sell-empty-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 0.022 + i * 0.0001,
            size: 10,
        });
    }

    bot.manager = {
        orders,
        config: bot.config,
        _gapSlots: GAP_SLOTS,
        logger: {
            log: () => {},
        },
        _updateOrder: async (order) => {
            orders.set(order.id, order);
        },
        lockOrders() {},
        unlockOrders() {},
    };

    bot._refreshDynamicWeightDistribution = () => {};
    bot._flushProcessedFillPersistence = async () => {};
    bot._applyReplaySafeTrackedFillAccounting = async (fill) => ({
        status: 'applied',
        fillKey: `${fill.op[1].order_id}:${fill.block_num}:${fill.id}`,
    });
    bot.updateOrdersOnChainPlan = async (plan) => {
        bot._broadcastPlans.push(plan);
    };
    bot._broadcastPlans = [];

    return bot;
}

async function runTests() {
    console.log('Running test_fill_batch_chunking.js...\n');

    // --- Test 1: empty fills ---
    {
        const bot = makeBot();
        const result = await bot._processFillsWithBatching([], null, 'test-empty');
        assert.strictEqual(result.aborted, false, 'empty fills should not abort');
        assert.strictEqual(bot._callLog.length, 0, 'empty fills should make no calls');
        console.log('  ✓ empty fills returns immediately');
    }

    // --- Test 2: single fill (unified) ---
    {
        const bot = makeBot();
        const fill = makeFill('sell1');
        const result = await bot._processFillsWithBatching([fill], null, 'test-single');
        assert.strictEqual(result.aborted, false, 'single fill should not abort');
        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 1, 'single fill: 1 processFilledOrders call');
        assert.strictEqual(processCalls[0].fillCount, 1, 'single fill: 1 fill in batch');

        const execCalls = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded');
        assert.strictEqual(execCalls.length, 1, 'single fill: 1 executeBatchIfNeeded call');
        console.log('  ✓ single fill processed in one batch');
    }

    // --- Test 3: exactly MAX_BATCH fills (unified) ---
    {
        const bot = makeBot();
        const fills = Array.from({ length: MAX_BATCH }, (_, n) => makeFill(`sell${n + 1}`));
        const result = await bot._processFillsWithBatching(fills, null, 'test-unified');
        assert.strictEqual(result.aborted, false, 'MAX_BATCH fills should not abort');

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 1, `MAX_BATCH=${MAX_BATCH} fills: 1 processFilledOrders call`);
        assert.strictEqual(processCalls[0].fillCount, MAX_BATCH, `MAX_BATCH=${MAX_BATCH} fills in batch`);

        const execCalls = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded');
        assert.strictEqual(execCalls.length, 1, `MAX_BATCH=${MAX_BATCH} fills: 1 executeBatchIfNeeded call`);
        console.log(`  ✓ ${MAX_BATCH} fills (unified) processed in one batch`);
    }

    // --- Test 4: MAX_BATCH + 1 fills (chunked into 2 batches) ---
    {
        const bot = makeBot();
        const totalFills = MAX_BATCH + 2; // one full batch plus a partial tail
        const fills = Array.from({ length: totalFills }, (_, n) => makeFill(`sell${n + 1}`));
        const result = await bot._processFillsWithBatching(fills, null, 'test-chunked');
        assert.strictEqual(result.aborted, false, 'chunked fills should not abort');

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 2, `${totalFills} fills: 2 processFilledOrders calls`);
        assert.strictEqual(processCalls[0].fillCount, MAX_BATCH, `first chunk: ${MAX_BATCH} fills`);
        assert.strictEqual(processCalls[1].fillCount, 2, 'second chunk: 2 fills');

        // In chunked mode, the second chunk should exclude fills from the first chunk
        // But also the first chunk should exclude fills from the second chunk
        assert.ok(processCalls[0].exclSize > 0, 'first chunk should have exclude set for future chunks');

        const execCalls = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded');
        assert.strictEqual(execCalls.length, 2, `${totalFills} fills: 2 executeBatchIfNeeded calls`);
        console.log(`  ✓ ${totalFills} fills chunked into ${MAX_BATCH} + ${totalFills - MAX_BATCH}`);
    }

    // --- Test 5: two full batches ---
    {
        const bot = makeBot();
        const totalFills = MAX_BATCH * 2;
        const fills = Array.from({ length: totalFills }, (_, n) => makeFill(`sell${n + 1}`));
        const result = await bot._processFillsWithBatching(fills, null, 'test-double-batch');
        assert.strictEqual(result.aborted, false);

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 2, `${totalFills} fills: 2 processFilledOrders calls`);
        assert.strictEqual(processCalls[0].fillCount, MAX_BATCH);
        assert.strictEqual(processCalls[1].fillCount, MAX_BATCH);

        const execCalls = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded');
        assert.strictEqual(execCalls.length, 2);
        console.log(`  ✓ ${totalFills} fills chunked into 2 equal batches of ${MAX_BATCH}`);
    }

    // --- Test 6: abort on first chunk stops processing ---
    {
        const bot = makeBot();
        const totalFills = MAX_BATCH + 2;
        const fills = Array.from({ length: totalFills }, (_, n) => makeFill(`sell${n + 1}`));

        bot._executeBatchIfNeeded = async (rebalanceResult, contextLabel) => {
            bot._callLog.push({ method: '_executeBatchIfNeeded', contextLabel });
            return { executed: false, hadRotation: false, skippedNoActions: false, abortedForIllegalState: true };
        };

        const result = await bot._processFillsWithBatching(fills, null, 'test-abort');
        assert.strictEqual(result.aborted, true, 'aborted batch should return aborted=true');

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 1, 'abort: only first chunk processed');
        assert.strictEqual(processCalls[0].fillCount, MAX_BATCH, 'abort: first chunk had MAX_BATCH fills');

        const execCalls = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded');
        assert.strictEqual(execCalls.length, 1, 'abort: only one executeBatchIfNeeded call');
        console.log('  ✓ abort on first chunk stops processing remaining chunks');
    }

    // --- Test 7: abort via abortedForAccountingFailure ---
    {
        const bot = makeBot();
        const fills = Array.from({ length: MAX_BATCH + 2 }, (_, n) => makeFill(`sell${n + 1}`));

        bot._executeBatchIfNeeded = async (rebalanceResult, contextLabel) => {
            bot._callLog.push({ method: '_executeBatchIfNeeded', contextLabel });
            return { executed: false, hadRotation: false, skippedNoActions: false, abortedForAccountingFailure: true };
        };

        const result = await bot._processFillsWithBatching(fills, null, 'test-abort-acct');
        assert.strictEqual(result.aborted, true, 'aborted batch (acct failure) should return aborted=true');

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 1, 'abort acct: only first chunk');
        console.log('  ✓ abort via abortedForAccountingFailure stops remaining chunks');
    }

    // --- Test 8: options passed through to processFilledOrders ---
    {
        const bot = makeBot();
        const fill = makeFill('sell1');
        const options = { skipAccountTotalsUpdate: true };
        await bot._processFillsWithBatching([fill], null, 'test-opts', options);

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 1);
        assert.deepStrictEqual(processCalls[0].options, options, 'options passed through to processFilledOrders');
        console.log('  ✓ options passed through to processFilledOrders');
    }

    // --- Test 9: exclusion set passed through in unified mode ---
    {
        const bot = makeBot();
        const fill = makeFill('sell1');
        const excl = new Set(['1.7.999']);
        await bot._processFillsWithBatching([fill], excl, 'test-excl');

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 1);
        assert.strictEqual(processCalls[0].exclSize, 1, 'exclusion set passed to processFilledOrders');
        console.log('  ✓ exclusion set passed in unified mode');
    }

    // --- Test 10: fund recalc pause/resume wraps the entire operation ---
    {
        const bot = makeBot();
        let wasPaused = false;
        let wasResumed = false;
        bot.manager.pauseFundRecalc = () => { wasPaused = true; };
        bot.manager.resumeFundRecalc = () => { wasResumed = true; };

        const fills = Array.from({ length: MAX_BATCH + 2 }, (_, n) => makeFill(`sell${n + 1}`));
        await bot._processFillsWithBatching(fills, null, 'test-fund-recalc');

        assert.ok(wasPaused, 'fund recalc should be paused');
        assert.ok(wasResumed, 'fund recalc should be resumed');
        console.log('  ✓ fund recalc pause/resume wraps fill processing');
    }

    // --- Test 11: large burst (20 fills) ---
    {
        const bot = makeBot();
        const totalFills = 20;
        const fills = Array.from({ length: totalFills }, (_, n) => makeFill(`sell${n + 1}`));
        const result = await bot._processFillsWithBatching(fills, null, 'test-large-burst');
        assert.strictEqual(result.aborted, false);

        const expectedChunks = Math.ceil(totalFills / MAX_BATCH);
        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, expectedChunks, `20 fills: ${expectedChunks} processFilledOrders calls`);

        const execCalls = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded');
        assert.strictEqual(execCalls.length, expectedChunks, `20 fills: ${expectedChunks} executeBatchIfNeeded calls`);

        let totalProcessed = 0;
        for (const call of processCalls) {
            totalProcessed += call.fillCount;
        }
        assert.strictEqual(totalProcessed, totalFills, 'all fills processed across chunks');
        console.log(`  ✓ 20 fills chunked into ${expectedChunks} batches of max ${MAX_BATCH}`);
    }

    // --- Test 12: multi-chunk batch execution ---
    {
        const bot = makeBot();
        const fills = Array.from({ length: MAX_BATCH + 1 }, (_, n) => makeFill(`sell${n + 1}`));

        bot._executeBatchIfNeeded = async (rebalanceResult, contextLabel) => {
            bot._callLog.push({ method: '_executeBatchIfNeeded', contextLabel });
            // second chunk reports rotation
            const isSecond = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded').length === 2;
            return { executed: true, hadRotation: isSecond, skippedNoActions: false };
        };

        const result = await bot._processFillsWithBatching(fills, null, 'test-rotation');
        assert.strictEqual(result.aborted, false);
        console.log('  ✓ multi-chunk batch processed without error');
    }

    // --- Test 13: bootstrap fills go through standard pipeline with MAX_BATCH chunking ---
    {
        const bot = makeBootstrapBot();
        const totalFills = MAX_BATCH + 2;
        bot._incomingFillQueue.push(...Array.from({ length: totalFills }, (_, n) => makeBootstrapFill(n + 1)));

        bot.manager.pauseFundRecalc = () => {};
        bot.manager.resumeFundRecalc = async () => {};
        bot.manager.flushGridDirty = async () => {};
        bot._executeBatchIfNeeded = async () => ({ executed: true, hadRotation: false, skippedNoActions: false });

        const pipelineCalls: any[] = [];
        bot.manager.processFilledOrders = async (fills, excl, options) => {
            pipelineCalls.push({ fillCount: fills.length, contextLabel: options?.context });
            return {
                actions: [{ type: 'create', id: fills[0]?.id || 'x' }],
                stateUpdates: [],
                hadRotation: false,
                workingGrid: { getIndexes: () => ({}), getBoundary: () => 0 },
                workingIndexes: {},
                workingBoundary: 0,
                aborted: false,
            };
        };

        await bot._processFillsWithBootstrapMode({
            readOpenOrders: async () => [],
            getFillProcessingMode: () => 'history',
        });

        assert.strictEqual(pipelineCalls.length, 2, 'bootstrap fills should be processed in two chunks');
        assert.strictEqual(pipelineCalls[0].fillCount, MAX_BATCH, 'first chunk should have MAX_BATCH fills');
        assert.strictEqual(pipelineCalls[1].fillCount, totalFills - MAX_BATCH, 'second chunk should contain remaining fills');
    }

    // --- Test 14: coalesced backlog replay (2a) ---
    // A backlog larger than the gap-slot batch is planned as ONE reconcile
    // instead of a chunked replay that mutates the boundary between
    // broadcasts (2026-11-04 incident: a deferred backlog replayed chunk by
    // chunk placed new sells below levels that had already sold on chain).
    {
        const bot = makeBot({ fillProcessing: { COALESCE_BACKLOG_REPLAY: true } });
        const totalFills = 16;
        const fills = Array.from({ length: totalFills }, (_, n) => ({
            ...makeFill(`sell${n + 1}`),
            price: 1 + n * 0.01,
        }));
        const result = await bot._processFillsWithBatching(fills, null, 'test-coalesced');
        assert.strictEqual(result.aborted, false, 'coalesced backlog should not abort');

        const processCalls = bot._callLog.filter(c => c.method === 'processFilledOrders');
        assert.strictEqual(processCalls.length, 1, 'coalesced backlog: 1 processFilledOrders call');
        assert.strictEqual(processCalls[0].fillCount, totalFills, 'all fills must be in the single plan');
        assert.strictEqual(processCalls[0].exclSize, 0, 'unified plan must not pre-exclude sibling fills');

        const execCalls = bot._callLog.filter(c => c.method === '_executeBatchIfNeeded');
        assert.strictEqual(execCalls.length, 1, 'coalesced backlog: 1 executeBatchIfNeeded call');

        const recordCalls = bot._callLog.filter(c => c.method === 'recordLastFilledPrices');
        assert.strictEqual(recordCalls.length, 1, 'the whole backlog must stamp the pivot once');
        assert.strictEqual(recordCalls[0].fillCount, totalFills, 'the stamp must see every fill');
        assert.strictEqual(recordCalls[0].lastId, `sell${totalFills}`, 'the pivot must be the LAST fill of the backlog');
        assert.strictEqual(recordCalls[0].lastPrice, 1 + (totalFills - 1) * 0.01, 'pivot price must be the last fill price');
        console.log(`  ✓ ${totalFills} fills coalesced into one plan (pivot from the last fill)`);
    }

    console.log('\nAll fill batch chunking tests passed.\n');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});

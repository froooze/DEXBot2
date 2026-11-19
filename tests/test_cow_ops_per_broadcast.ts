/**
 * tests/test_cow_ops_per_broadcast.ts
 *
 * Verifies the gap-slot-derived per-broadcast operation cap enforced by
 * executeChunkedWithRetryOnUncertain (batch size = manager._gapSlots + 1):
 *   1. Batches at or below the cap broadcast as a single transaction.
 *   2. Batches above the cap are split into sequential broadcast chunks of at
 *      most `maxOps` operations each; the merged result preserves the
 *      operation_results <-> opContexts alignment.
 *   3. A failed chunk does NOT swallow the remaining chunks' orders: later
 *      chunks are still broadcast, and the first failure is re-thrown with
 *      partialOnChainState set so recovery re-plans the failed chunk's orders.
 */

const assert = require('assert');

const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
// Compiled ESM namespaces are frozen: chain_orders is mocked via loader hooks
// so dexbot_cow_runtime's static import binds to this plain object and the
// per-test executeBatch/readOpenOrdersWithMeta assignments take effect.
esmMockEntry();

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');

const chainOrdersPath = require.resolve('../modules/chain_orders');
// Consumers capture named-export bindings at link time, so executeBatch is a
// fixed wrapper dispatching to the current per-test implementation.
let executeBatchImpl: any = async () => { throw new Error('executeBatch not configured for this test'); };
const chainOrders = defineEsmMockAbs(chainOrdersPath, [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], {
    BroadcastUncertainError,
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    executeBatch: (...args: any[]) => executeBatchImpl(...args),
});

const DEFAULT_MAX_OPS = 4; // effective per-broadcast cap; makeBot derives _gapSlots = cap - 1

function makeOps(n: number) {
    const operations = [];
    const opContexts = [];
    for (let i = 0; i < n; i++) {
        operations.push({ op_name: 'limit_order_create', op_data: { testMarker: i } });
        opContexts.push({
            kind: 'create',
            id: `slot-${i}`,
            order: { id: `slot-${i}`, type: 'buy', price: 0.02, size: 100 },
            finalInts: { sell: 1000000, receive: 50000000, sellAssetId: '1.3.0', receiveAssetId: '1.3.121' }
        });
    }
    return { operations, opContexts };
}

function makeResult(ops: any[]) {
    return {
        success: true,
        operation_results: ops.map((op: any) => (op.op_name === 'limit_order_create' ? [1, '1.7.100'] : [1])),
    };
}

function makeBot(opts: { maxOps?: number } = {}) {
    const DEXBot = require('../modules/dexbot_class').default;
    const bot = new DEXBot({
        botKey: 'test_cow_ops_per_broadcast',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = {
        // Effective cap = _gapSlots + 1 (the +1 offset under test); invert it
        // so `maxOps` still names the byte-for-byte broadcast chunk size.
        _gapSlots: (opts.maxOps ?? DEFAULT_MAX_OPS) - 1,
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders: new Map(),
        _gridVersion: 0,
        _fundLock: { acquire: async (fn: any) => fn(), isLocked: () => false, isReentrant: () => false },
        logger: {
            log: (msg: any, level: any) => { /* noop */ },
            logFundsStatus: () => {}
        },
        requestStructuralGridResync: async () => {},
        _lastUnmatchedChainOrders: [],
        _pendingBroadcasts: new Map(),
        lockOrders: () => {},
        unlockOrders: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _clearWorkingGridRef: () => {},
        _throwOnIllegalState: false
    };
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    bot._currentCycleId = 1;
    return bot;
}

async function testSingleBroadcastAtOrBelowCap() {
    console.log('[OPSCAP-001] Batch at/below cap → single broadcast (no chunking)...');
    const bot = makeBot({ maxOps: 4 });
    let callCount = 0;

    executeBatchImpl = async (account: any, key: any, ops: any) => {
        callCount++;
        assert.strictEqual(ops.length, 4, 'must be a single broadcast of 4 ops');
        return makeResult(ops);
    };

    {
        const { operations, opContexts } = makeOps(4);
        const result = await bot._executeChunkedWithRetryOnUncertain(operations, opContexts);
        assert.strictEqual(callCount, 1, 'single broadcast expected at/below cap');
        assert.strictEqual(result.opContexts.length, 4, 'all contexts returned');
        assert.ok(Array.isArray(result.result.operation_results), 'operation_results must be an array');
        assert.strictEqual(result.result.operation_results.length, 4, 'operation_results aligned with contexts');
    }
    console.log('✓ OPSCAP-001 passed');
}

async function testChunkedSplitAndAlignment() {
    console.log('[OPSCAP-002] 10 ops with cap 4 → 3 broadcasts (4+4+2), merged results aligned...');
    const bot = makeBot({ maxOps: 4 });
    const broadcastSizes: number[] = [];

    executeBatchImpl = async (account: any, key: any, ops: any) => {
        broadcastSizes.push(ops.length);
        return makeResult(ops);
    };

    {
        const { operations, opContexts } = makeOps(10);
        const result = await bot._executeChunkedWithRetryOnUncertain(operations, opContexts);
        assert.deepStrictEqual(broadcastSizes, [4, 4, 2], 'must broadcast 4+4+2');
        assert.strictEqual(result.opContexts.length, 10, 'all contexts merged');
        assert.strictEqual(result.result.operation_results.length, 10, 'operation_results merged 1:1 with contexts');
        assert.strictEqual(result.result.raw.grouped, true, 'merged result marked grouped');
        assert.strictEqual(result.result.raw.groupsExecuted, 3, '3 chunks executed');
        assert.strictEqual(result.result.raw.groupResults.length, 3, '3 raw group results');
    }
    console.log('✓ OPSCAP-002 passed');
}

async function testFailedChunkDoesNotSwallowRemaining() {
    console.log('[OPSCAP-003] Middle chunk fails (both retry attempts) → later chunks still broadcast, first failure re-thrown with partialOnChainState...');
    const bot = makeBot({ maxOps: 4 });
    const broadcastSizes: number[] = [];

    // Chunk 2 carries testMarker 4..7; fail it. No retry fires because the
    // empty chain read cannot verify absence (deferred), so it fails once.
    executeBatchImpl = async (account: any, key: any, ops: any) => {
        broadcastSizes.push(ops.length);
        if (ops[0]?.op_data?.testMarker === 4) {
            throw new BroadcastUncertainError('opscap-003-uncertain', { batchId: 'opscap-003', timeoutMs: 30000 });
        }
        return makeResult(ops);
    };

    {
        const { operations, opContexts } = makeOps(10);
        await assert.rejects(
            () => bot._executeChunkedWithRetryOnUncertain(operations, opContexts),
            (err: any) => {
                assert.ok(err instanceof BroadcastUncertainError, 'must re-throw the chunk failure');
                assert.strictEqual(err.chunkedBroadcast, true, 'must be marked as chunked broadcast');
                assert.strictEqual(err.partialOnChainState, true, 'earlier chunk landed → partial on-chain state');
                assert.strictEqual(err.chunksTotal, 3, '3 chunks total');
                assert.strictEqual(err.chunksFailed, 1, 'exactly 1 chunk failed');
                assert.strictEqual(err.broadcastedOperationCount, 6, 'chunk 1 (4) + chunk 3 (2) landed; only chunk 2 failed');
                return true;
            }
        );
        // Chunk 1 lands (4), chunk 2 fails once (no verified absence → no blind retry), chunk 3 lands (2).
        assert.deepStrictEqual(broadcastSizes, [4, 4, 2], 'failed chunk does not swallow the remaining chunk (no orders dropped)');
    }
    console.log('✓ OPSCAP-003 passed');
}

async function testAccessorDefault() {
    console.log('[OPSCAP-004] _getMaxOpsPerBroadcast resolves from gap slots...');
    const bot = makeBot();
    assert.strictEqual(bot._getMaxOpsPerBroadcast(), Math.max(1, DEFAULT_MAX_OPS));
    assert.strictEqual(bot._getMaxOpsPerBroadcast(), bot._getGapSlotBatchSize(), 'ops cap must equal gap-slot batch size');
    assert.ok(bot._getMaxOpsPerBroadcast() >= 1, 'cap must be at least 1');
    console.log('✓ OPSCAP-004 passed');
}

async function testConfigOverride() {
    console.log('[OPSCAP-005] _getMaxOpsPerBroadcast follows manager._gapSlots...');
    const DEXBot = require('../modules/dexbot_class').default;
    const bot = new DEXBot({
        botKey: 'test_cow_ops_per_broadcast_override',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5,
    });
    bot.manager = {
        _gapSlots: 2,
        assets: {},
        orders: new Map(),
        logger: { log: () => {}, logFundsStatus: () => {} },
        _pendingBroadcasts: new Map(),
    };
    assert.strictEqual(bot._getMaxOpsPerBroadcast(), 3, 'must follow manager gap slots (+1 offset)');
    console.log('✓ OPSCAP-005 passed');
}

async function testNonNumericCapFallsBackToMin() {
    console.log('[OPSCAP-006] Invalid gap slots → accessor derives from config (min 1), chunked execution survives non-numeric accessor (no infinite loop)...');
    const DEXBot = require('../modules/dexbot_class').default;
    const bot = new DEXBot({
        botKey: 'test_cow_ops_per_broadcast_nan',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5,
    });
    bot.manager = {
        _gapSlots: 'abc' as any,
        assets: {},
        orders: new Map(),
        logger: { log: () => {}, logFundsStatus: () => {} },
        _pendingBroadcasts: new Map(),
    };
    assert.ok(bot._getMaxOpsPerBroadcast() >= 1, 'invalid gap slots must fall back to a positive derived size');
    // Strict check against the config-derived expectation (same inputs the
    // accessor feeds calculateGapSlots: bot config, since manager.config is unset).
    const { calculateGapSlots } = require('../modules/order/utils/math');
    const derived = Math.floor(Number(calculateGapSlots(
        bot.config.incrementPercent, bot.config.targetSpreadPercent, bot.config.gridLimits)));
    const expectedDerived = Number.isFinite(derived) && derived >= 1 ? derived + 1 : 1;
    assert.strictEqual(bot._getMaxOpsPerBroadcast(), expectedDerived,
        'invalid gap slots must derive exactly from config');

    // Runtime guard in executeChunkedWithRetryOnUncertain must also survive a
    // NaN/string maxOps even if the accessor is bypassed (e.g. fake bot).
    const botStr = makeBot();
    botStr._getMaxOpsPerBroadcast = () => ('abc' as any);
    const broadcastSizes: number[] = [];

    executeBatchImpl = async (account: any, key: any, ops: any) => {
        broadcastSizes.push(ops.length);
        return makeResult(ops);
    };

    {
        const { operations, opContexts } = makeOps(6);
        const result = await botStr._executeChunkedWithRetryOnUncertain(operations, opContexts);
        assert.deepStrictEqual(broadcastSizes, [1, 1, 1, 1, 1, 1], 'each op broadcast in its own chunk, no hang');
        assert.strictEqual(result.opContexts.length, 6, 'all contexts returned');
    }
    console.log('✓ OPSCAP-006 passed');
}

async function testDefinitiveFailureAbortsRemaining() {
    console.log('[OPSCAP-008] Definitive (non-uncertain) chunk failure → remaining chunks aborted (no burned broadcasts), partial state preserved...');
    const bot = makeBot({ maxOps: 4 });
    const broadcastSizes: number[] = [];

    // Chunk 2 (marker 4..7) fails definitively; chunk 3 must NOT be broadcast.
    executeBatchImpl = async (account: any, key: any, ops: any) => {
        broadcastSizes.push(ops.length);
        if (ops[0]?.op_data?.testMarker === 4) {
            throw new Error('opscap-008-insufficient-funds');
        }
        return makeResult(ops);
    };

    {
        const { operations, opContexts } = makeOps(10);
        await assert.rejects(
            () => bot._executeChunkedWithRetryOnUncertain(operations, opContexts),
            (err: any) => {
                assert.ok(!(err instanceof BroadcastUncertainError), 'definitive failure must pass through as-is');
                assert.match(err.message, /insufficient-funds/, 'original definitive error preserved');
                assert.strictEqual(err.partialOnChainState, true, 'chunk 1 landed → partial on-chain state kept');
                assert.strictEqual(err.chunkedBroadcast, true, 'marked as chunked broadcast');
                assert.strictEqual(err.chunksTotal, 3, '3 chunks total');
                assert.strictEqual(err.chunksFailed, 1, 'only chunk 2 failed');
                assert.strictEqual(err.chunksAborted, 1, 'chunk 3 was aborted (never attempted)');
                assert.strictEqual(err.broadcastedOperationCount, 4, 'chunk 1 (4) landed');
                return true;
            }
        );
        assert.deepStrictEqual(broadcastSizes, [4, 4], 'chunk 3 NOT broadcast after definitive failure');
        const { formatPartialBroadcastSummary } = require('../modules/dexbot_cow_runtime');
        const summaryErr = new BroadcastUncertainError('opscap-008', { batchId: 'opscap-008', timeoutMs: 30000 });
        summaryErr.partialOnChainState = true;
        summaryErr.chunkedBroadcast = true;
        summaryErr.chunksTotal = 3;
        summaryErr.chunksFailed = 1;
        summaryErr.chunksAborted = 1;
        assert.strictEqual(
            formatPartialBroadcastSummary(summaryErr),
            '1/3 chunks broadcast',
            'aborted chunk must NOT count as broadcast (only chunk 1 fully executed)'
        );
    }
    console.log('✓ OPSCAP-008 passed');
}

async function testPairModePartialNotDowngraded() {
    console.log('[OPSCAP-009] Failing chunk already carrying partialOnChainState (pair-mode landed groups) is NOT downgraded...');
    const bot = makeBot({ maxOps: 4 });

    // 10 ops -> 3 chunks. Chunk 1 (marker 0..3) fails mid-pair-groups after
    // landing 1 group; chunk 2 (marker 4..7) fails definitively (-> abort).
    // No chunk fully succeeds, so mergedContexts stays 0. Without the fix,
    // `mergedContexts.length > 0` (0) would downgrade partialOnChainState
    // true->false, skipping the forensic log and resetting the op count.
    executeBatchImpl = async (account: any, key: any, ops: any) => {
        if (ops[0]?.op_data?.testMarker === 0) {
            const err: any = new BroadcastUncertainError('opscap-009-group-fail', { batchId: 'opscap-009', timeoutMs: 30000 });
            err.partialOnChainState = true;
            err.groupsBroadcast = 1;
            err.groupsTotal = 2;
            err.broadcastedOperationCount = 2;
            throw err;
        }
        if (ops[0]?.op_data?.testMarker === 4) {
            throw new Error('opscap-009-definitive');
        }
        return makeResult(ops);
    };

    {
        const { operations, opContexts } = makeOps(10);
        await assert.rejects(
            () => bot._executeChunkedWithRetryOnUncertain(operations, opContexts),
            (err: any) => {
                assert.ok(err instanceof BroadcastUncertainError, 'uncertain error propagated');
                assert.strictEqual(err.partialOnChainState, true, 'must preserve pair-mode partial state (no downgrade)');
                assert.strictEqual(err.chunksTotal, 3, '3 chunks total');
                assert.strictEqual(err.chunksFailed, 2, 'chunk 1 (uncertain) + chunk 2 (definitive) failed');
                assert.strictEqual(err.chunksAborted, 1, 'chunk 3 was aborted');
                assert.strictEqual(err.broadcastedOperationCount, 2, 'the 2 landed group ops are counted (not reset to 0)');
                return true;
            }
        );
    }
    console.log('✓ OPSCAP-009 passed');
}

async function testLaterChunkPartialMarkersAccumulate() {
    console.log('[OPSCAP-010] Non-first failing chunk internal partial markers accumulate into the re-thrown error...');
    const bot = makeBot({ maxOps: 4 });

    // 10 ops -> 3 chunks. Chunk 1 (marker 0..3) succeeds. Chunk 2 (marker
    // 4..7) fails uncertain mid-pair-groups after landing 2 ops (carries its
    // own partialOnChainState=true / broadcastedOperationCount=2). Chunk 3
    // (marker 8..9) succeeds. The re-thrown error must count chunk 1 (4) +
    // chunk 3 (2) fully-executed + chunk 2's 2 landed ops = 8.
    executeBatchImpl = async (account: any, key: any, ops: any) => {
        if (ops[0]?.op_data?.testMarker === 4) {
            const err: any = new BroadcastUncertainError('opscap-010-group-fail', { batchId: 'opscap-010', timeoutMs: 30000 });
            err.partialOnChainState = true;
            err.groupsBroadcast = 1;
            err.groupsTotal = 2;
            err.broadcastedOperationCount = 2;
            throw err;
        }
        return makeResult(ops);
    };

    {
        const { operations, opContexts } = makeOps(10);
        await assert.rejects(
            () => bot._executeChunkedWithRetryOnUncertain(operations, opContexts),
            (err: any) => {
                assert.ok(err instanceof BroadcastUncertainError, 'uncertain error propagated');
                assert.strictEqual(err.partialOnChainState, true, 'partial state preserved');
                assert.strictEqual(err.chunksTotal, 3, '3 chunks total');
                assert.strictEqual(err.chunksFailed, 1, 'only chunk 2 failed');
                assert.strictEqual(err.chunksAborted, 0, 'no chunks aborted (uncertain failure continues)');
                assert.strictEqual(err.broadcastedOperationCount, 8, 'chunk 1 (4) + chunk 3 (2) + chunk 2 landed (2) = 8');
                return true;
            }
        );
    }
    console.log('✓ OPSCAP-010 passed');
}

/**
 * OPSCAP-011 reproduces the 2026-11-17 `2/8` live incident with the existing
 * in-test executeBatch seam — no production change. Two chunks land, the third
 * fails definitively, and the remaining five are aborted. This pins the
 * fact pattern §9.14 Stage 3 wanted reproduced; it deliberately does NOT
 * change broadcast/replay behaviour.
 */
async function testTwoOfEightPartialChunkIncident() {
    console.log('[OPSCAP-011] reproduce the 2-of-8 partial-chunk incident (test-only seam)...');
    const bot = makeBot({ maxOps: 2 }); // 2 ops per chunk => 16 ops = 8 chunks
    const broadcastSizes: number[] = [];
    executeBatchImpl = async (account: any, key: any, ops: any) => {
        broadcastSizes.push(ops.length);
        if (ops[0]?.op_data?.testMarker === 4) {
            // First op of chunk 3: a definitive chain rejection after two
            // chunks already landed (the vanished-update-target signature).
            throw new Error('opscap-011-object-does-not-exist');
        }
        return makeResult(ops);
    };

    const { operations, opContexts } = makeOps(16);
    await assert.rejects(
        () => bot._executeChunkedWithRetryOnUncertain(operations, opContexts),
        (err: any) => {
            assert.ok(!(err instanceof BroadcastUncertainError), 'definitive failure passes through as-is');
            assert.match(err.message, /object-does-not-exist/, 'original definitive error preserved');
            assert.strictEqual(err.partialOnChainState, true, 'two chunks already landed');
            assert.strictEqual(err.chunkedBroadcast, true, 'marked as chunked broadcast');
            assert.strictEqual(err.chunksTotal, 8, 'eight chunks total');
            assert.strictEqual(err.chunksFailed, 1, 'the third chunk failed');
            assert.strictEqual(err.chunksAborted, 5, 'chunks 4..8 were aborted');
            assert.strictEqual(err.broadcastedOperationCount, 4, 'two chunks (2 ops each) landed');
            return true;
        }
    );
    // The failing chunk IS attempted (and rejected); only the five after it
    // are aborted. Two chunks (4 ops) actually landed on chain.
    assert.deepStrictEqual(broadcastSizes, [2, 2, 2], 'chunks 1-3 attempted, chunks 4-8 aborted');
    console.log('✓ OPSCAP-011 passed');
}

async function testHardAbortLogUsesChunkedFields() {
    console.log('[OPSCAP-007] Partial-state log summary uses chunk fields (not stale groups fields)...');
    const { formatPartialBroadcastSummary } = require('../modules/dexbot_cow_runtime');

    const chunkedErr = new BroadcastUncertainError('opscap-007-uncertain', { batchId: 'opscap-007', timeoutMs: 30000 });
    chunkedErr.partialOnChainState = true;
    chunkedErr.chunkedBroadcast = true;
    chunkedErr.chunksTotal = 3;
    chunkedErr.chunksFailed = 1;
    assert.strictEqual(
        formatPartialBroadcastSummary(chunkedErr),
        '2/3 chunks broadcast',
        'must report chunk counts (total - failed), not stale groups fields'
    );

    const groupedErr = new BroadcastUncertainError('opscap-007-grouped', { batchId: 'opscap-007', timeoutMs: 30000 });
    groupedErr.partialOnChainState = true;
    groupedErr.groupsBroadcast = 1;
    groupedErr.groupsTotal = 2;
    assert.strictEqual(
        formatPartialBroadcastSummary(groupedErr),
        '1/2 groups broadcast',
        'must preserve the pair-mode groups format'
    );

    assert.strictEqual(formatPartialBroadcastSummary(null), '?/?', 'non-object err must not throw');
    console.log('✓ OPSCAP-007 passed');
}

async function main() {
    console.log('Running COW ops-per-broadcast cap tests...');
    await testSingleBroadcastAtOrBelowCap();
    await testChunkedSplitAndAlignment();
    await testFailedChunkDoesNotSwallowRemaining();
    await testAccessorDefault();
    await testConfigOverride();
    await testNonNumericCapFallsBackToMin();
    await testHardAbortLogUsesChunkedFields();
    await testDefinitiveFailureAbortsRemaining();
    await testPairModePartialNotDowngraded();
    await testLaterChunkPartialMarkersAccumulate();
    await testTwoOfEightPartialChunkIncident();
    console.log('All COW ops-per-broadcast tests passed');
}

main().catch((err) => {
    console.error('COW ops-per-broadcast test FAILED:', err);
    process.exit(1);
});
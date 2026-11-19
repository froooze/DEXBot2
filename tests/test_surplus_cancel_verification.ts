/**
 * tests/test_surplus_cancel_verification.ts
 *
 * M1 regression: surplus/type-mismatch cancels must use the SAME verified-
 * after-broadcast contract as cancelOnly duplicate orphans. A successful
 * broadcast is not proof the wrong-side order is gone — virtualizing its slot
 * and filtering the unmatched id on that assumption strands a live order until
 * the next full sync, and its next fill is booked against the wrong side.
 *
 * Covers the serial path plus all three batch probes (pre-read, successful
 * chunk, failed-chunk re-read).
 *
 * Mutation checks:
 *  - gate post-broadcast verification on cancelOnly again → S-02/S-03 fail;
 *  - restore the single-read pre-read/failed-chunk rules → S-06/S-05 fail;
 *  - finalize before verification → S-02/S-03/S-05 fail.
 */
const assert = require('assert');
const { correctAllPriceMismatches } = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const SURPLUS_ID = '1.7.888001';
const SURPLUS_ID_2 = '1.7.888002';

type HarnessOptions = {
    count?: 1 | 2;
    batch?: boolean;
    executeBatchThrows?: boolean;
    batchRead?: (ids: string[], callIndex: number) => Map<string, unknown>;
    readSingle?: (id: string, callIndex: number) => unknown;
    noSingleRead?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
    const ids = options.count === 2 ? [SURPLUS_ID, SURPLUS_ID_2] : [SURPLUS_ID];
    const logs: string[] = [];
    const applied: unknown[] = [];
    const queue = ids.map((chainOrderId, idx) => ({
        gridOrder: { id: `slot-${idx + 1}` },
        chainOrderId,
        expectedPrice: 105.5 + idx,
        actualPrice: 105.4 + idx,
        size: 10,
        type: ORDER_TYPES.SELL,
        isSurplus: true,
        cancelOnly: false,
        queuedAt: Date.now() - 60000,
        queuedBy: 'sync-surplus'
    }));
    const manager: any = {
        orders: new Map(ids.map((chainOrderId, idx) => [
            `slot-${idx + 1}`,
            { id: `slot-${idx + 1}`, orderId: chainOrderId, state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL, price: 105 + idx }
        ])),
        ordersNeedingPriceCorrection: queue,
        _lastUnmatchedChainOrders: ids.map((chainOrderId) => ({ chainOrderId })),
        _placedAt: new Map(),
        boundaryIdx: 0,
        config: {
            fillProcessing: { CORRECTION_INTER_OP_DELAY_MS: 0 },
            pipelineTiming: {
                CANCEL_VERIFY_BACKOFF_MS: 0,
                CANCEL_VERIFY_MAX_ATTEMPTS: 2,
                CANCEL_VERIFY_DRAIN_BUDGET_MS: 100000
            }
        },
        _metrics: { duplicateOrphanCancelUnverifiedCount: 0 },
        logger: { log: (msg: string, level: string) => logs.push(`[${level}] ${msg}`) },
        _gridLock: { acquire: async (fn: () => Promise<unknown>) => fn() },
        _applyOrderUpdate: async (order: unknown) => { applied.push(order); }
    };
    let cancelCalls = 0;
    let batchCalls = 0;
    let batchReadIndex = 0;
    let singleReadIndex = 0;
    const accountOrders: any = {
        cancelOrder: async () => { cancelCalls++; return {}; },
        updateOrder: async () => ({}),
        batchReadOrders: async (readIds: string[]) => {
            batchReadIndex++;
            return options.batchRead
                ? options.batchRead(readIds, batchReadIndex)
                : absent();
        }
    };
    if (!options.noSingleRead) {
        accountOrders.readSingleOrder = async (id: string) => {
            singleReadIndex++;
            return options.readSingle ? options.readSingle(id, singleReadIndex) : null;
        };
    }
    if (options.batch) {
        accountOrders.buildCancelOrderOp = async (_acct: string, id: string) => ({ id });
        accountOrders.executeBatch = async () => {
            batchCalls++;
            if (options.executeBatchThrows) throw new Error('batch broadcast uncertain');
            return {};
        };
    }
    return {
        manager,
        accountOrders,
        logs,
        applied,
        cancelCalls: () => cancelCalls,
        batchCalls: () => batchCalls
    };
}

const present = (ids: string[]) => new Map(ids.map((id) => [id, { id }]));
const absent = () => new Map<string, unknown>();

async function run() {
    console.log('Running surplus cancel verification tests...');

    // S-01 — serial path, double-read confirms absence → slot virtualized/dequeued.
    {
        const h = createHarness();
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.cancelCalls(), 1, 'S-01: cancel broadcast');
        assert.strictEqual(h.applied.length, 1, 'S-01: verified cancel virtualizes the slot');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 0, 'S-01: entry dequeued');
        assert.strictEqual(result.corrected, 1, 'S-01: counted as corrected');
        assert.strictEqual(result.failed, 0, 'S-01: no failure');
    }

    // S-02 — serial path, verified STILL LIVE: no slot mutation, entry stays.
    {
        const h = createHarness({ batchRead: (ids) => present(ids) });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.cancelCalls(), 1, 'S-02: cancel was broadcast');
        assert.strictEqual(h.applied.length, 0, 'S-02: must NOT virtualize a still-live slot');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 1, 'S-02: entry stays queued');
        assert.strictEqual(result.failed, 1, 'S-02: counted as failed');
        assert.strictEqual(result.results[0].result.error, 'cancel-verification-failed', 'S-02: confirmed failure reason');
    }

    // S-03 — successful batch chunk, verified still live → serial retry, no virtualization.
    {
        const h = createHarness({ count: 2, batch: true, batchRead: (ids) => present(ids) });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.batchCalls(), 1, 'S-03: batch broadcast happened');
        assert.strictEqual(h.applied.length, 0, 'S-03: batch must NOT virtualize still-live surplus slots');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 2, 'S-03: entries stay queued');
        assert.strictEqual(result.corrected, 0, 'S-03: nothing corrected');
        assert.strictEqual(result.failed, 2, 'S-03: serial retry reports each failure once');
    }

    // S-04 — successful batch chunk, double-read confirms absence → virtualized.
    {
        const h = createHarness({
            count: 2,
            batch: true,
            batchRead: (ids, call) => call === 1 ? present(ids) : absent(),
            readSingle: () => null
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.batchCalls(), 1, 'S-04: batch broadcast happened');
        assert.strictEqual(h.applied.length, 2, 'S-04: both verified slots virtualized');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 0, 'S-04: queue drained');
        assert.strictEqual(result.corrected, 2, 'S-04: both counted as corrected');
    }

    // S-05 — failed chunk: one batch absence + live single read must NOT finalize.
    {
        const h = createHarness({
            count: 2,
            batch: true,
            executeBatchThrows: true,
            batchRead: (_ids, call) => call === 1 ? present([SURPLUS_ID, SURPLUS_ID_2]) : call === 2 ? absent() : present([SURPLUS_ID, SURPLUS_ID_2]),
            readSingle: () => ({ id: 'still-live' })
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.applied.length, 0, 'S-05: lagging batch absence must not virtualize a live surplus slot');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 2, 'S-05: entries stay queued');
        assert.strictEqual(result.corrected, 0, 'S-05: nothing finalized from the failed chunk');
        assert.strictEqual(result.failed, 2, 'S-05: failures reported by the serial retry');
    }

    // S-06 — lagging PRE-read absence + live confirm read must not finalize.
    {
        const h = createHarness({
            count: 2,
            batch: true,
            batchRead: () => absent(),
            readSingle: (_id, call) => call <= 2 ? { id: 'still-live' } : null
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.batchCalls(), 1, 'S-06: lagging pre-read must not suppress the broadcast');
        assert.strictEqual(h.applied.length, 2, 'S-06: post-broadcast double read confirms both gone');
        assert.strictEqual(result.corrected, 2, 'S-06: both corrected after verification');
    }

    console.log('  ✓ surplus cancel verification');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

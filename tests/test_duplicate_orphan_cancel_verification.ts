/**
 * tests/test_duplicate_orphan_cancel_verification.ts
 *
 * Stage 1 of the LAST-FILL-GUARD plan
 * (docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md §9.14): a queued duplicate-orphan
 * cancel is only considered done once a bounded by-id re-read confirms the chain order is
 * gone. A lagging read defers (entry stays queued); a confirmed still-live order
 * raises a hard error and a metrics counter. No new cancel sweep is introduced —
 * only entries already queued as a cancel class are verified (cancelOnly here;
 * surplus/type-mismatch in test_surplus_cancel_verification.ts).
 *
 * Mutation checks:
 *  - remove the `verifyCancelGone()` call in correctOrderPriceOnChain's
 *    cancelOnly branch → VERIFY-01..04, 06 fail (entry wrongly dropped/failed).
 *  - make a failed second read return "gone" → VERIFY-03 fails.
 *  - make a lone batch absence count as proof → VERIFY-05 fails.
 *  - make a still-live read count as a heal → VERIFY-02/08 fail.
 *  - drop the batch `outcomes` wiring → VERIFY-07 fails.
 *  - finalize a lagging pre-read absence → VERIFY-09 fails.
 *  - report the batch still-live case before the serial retry → VERIFY-08/10 fail.
 */
const assert = require('assert');
const { correctAllPriceMismatches } = require('../modules/order/utils/order');
const { ORDER_TYPES } = require('../modules/constants');
const { makeLadderFromPrices } = require('./helpers/order_test_helpers');

const CANCEL_ID = '1.7.777001';
const CANCEL_ID_2 = '1.7.777002';

type HarnessOptions = {
    count?: number;
    batch?: boolean;
    batchRead?: (ids: string[], callIndex: number) => Map<string, unknown>;
    readSingle?: (id: string, callIndex: number) => unknown | Promise<unknown>;
    noSingleRead?: boolean;
    pipelineTiming?: Record<string, number>;
    onCancel?: () => void;
};

function createHarness(options: HarnessOptions = {}) {
    const logs: string[] = [];
    const ids = options.count === 2 ? [CANCEL_ID, CANCEL_ID_2] : [CANCEL_ID];
    const queue = ids.map((id, idx) => ({
        gridOrder: { id: `slot-7${idx}` },
        chainOrderId: id,
        expectedPrice: 105.5 + idx,
        actualPrice: 105.4 + idx,
        size: 10,
        type: ORDER_TYPES.SELL,
        isSurplus: true,
        cancelOnly: true,
        queuedAt: Date.now() - 60000,
        queuedBy: 'sync-duplicate-orphan'
    }));
    const manager = {
        orders: new Map(),
        assets: {
            assetA: { id: '1.3.0', precision: 5, symbol: 'TEST' },
            assetB: { id: '1.3.861', precision: 5, symbol: 'BTS' }
        },
        ordersNeedingPriceCorrection: queue,
        _lastUnmatchedChainOrders: ids.map((chainOrderId) => ({ chainOrderId })),
        _placedAt: new Map(),
        _genesis: makeLadderFromPrices([105.5, 105.6]),
        boundaryIdx: 0,
        _gapSlots: 0,
        config: {
            fillProcessing: { CORRECTION_INTER_OP_DELAY_MS: 0 },
            pipelineTiming: {
                CANCEL_VERIFY_BACKOFF_MS: 0,
                CANCEL_VERIFY_MAX_ATTEMPTS: 2,
                CANCEL_VERIFY_DRAIN_BUDGET_MS: 100000,
                ...(options.pipelineTiming || {})
            }
        },
        _metrics: { duplicateOrphanCancelUnverifiedCount: 0 },
        logger: { log: (msg: string, level: string) => logs.push(`[${level}] ${msg}`) },
        _gridLock: { acquire: async (fn: () => Promise<unknown>) => fn() }
    };
    let cancelCalls = 0;
    let batchCalls = 0;
    const opsBuilt: string[] = [];
    let readIndex = 0;
    let singleIndex = 0;
    const accountOrders: Record<string, unknown> = {
        cancelOrder: async () => { cancelCalls++; options.onCancel?.(); return {}; },
        updateOrder: async () => ({}),
        batchReadOrders: async (readIds: string[]) => {
            readIndex++;
            return options.batchRead
                ? options.batchRead(readIds, readIndex)
                : new Map();
        }
    };
    if (!options.noSingleRead) {
        accountOrders.readSingleOrder = async (id: string) => {
            singleIndex++;
            return options.readSingle ? options.readSingle(id, singleIndex) : null;
        };
    }
    if (options.batch) {
        accountOrders.buildCancelOrderOp = async (_acct: string, id: string) => { opsBuilt.push(id); return { id }; };
        accountOrders.executeBatch = async () => { batchCalls++; return {}; };
    }
    return {
        manager,
        accountOrders,
        logs,
        cancelCalls: () => cancelCalls,
        batchCalls: () => batchCalls,
        opsBuilt: () => [...opsBuilt]
    };
}

async function run() {
    console.log('Running duplicate-orphan cancel verification tests...');

    // VERIFY-01 — double read confirms absence → cancel resolves and dequeues.
    {
        const h = createHarness();
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.cancelCalls(), 1, 'VERIFY-01: cancel must be broadcast');
        assert.strictEqual(result.corrected, 1, 'VERIFY-01: verified cancel counts as corrected');
        assert.strictEqual(result.failed, 0, 'VERIFY-01: no failure');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 0, 'VERIFY-01: entry dequeued');
        assert.strictEqual(h.logs.some((l) => l.startsWith('[error]')), false, 'VERIFY-01: no hard error');
    }

    // VERIFY-02 — batch read sees the order still live: confirmed failure.
    {
        const live = new Map([[CANCEL_ID, { id: CANCEL_ID }]]);
        const h = createHarness({ batchRead: () => live });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(result.failed, 1, 'VERIFY-02: still-live cancel must fail');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 1, 'VERIFY-02: entry stays queued');
        assert.strictEqual(result.results[0].result.error, 'cancel-verification-failed', 'VERIFY-02: confirmed failure');
        assert.strictEqual(h.manager._metrics.duplicateOrphanCancelUnverifiedCount, 1, 'VERIFY-02: counter incremented');
    }

    // VERIFY-03 — failed second read is inconclusive: defer, keep the entry, hard error.
    {
        const h = createHarness({ readSingle: async () => { throw new Error('lagging node'); } });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(result.failed, 1, 'VERIFY-03: inconclusive verification must not count as corrected');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 1, 'VERIFY-03: entry stays queued');
        assert.strictEqual(result.results[0].result.error, 'cancel-verification-lagging', 'VERIFY-03: lagging reason surfaced');
        assert.ok(h.logs.some((l) => l.includes('Duplicate-orphan cancel NOT verified')), 'VERIFY-03: hard error logged');
        assert.strictEqual(h.manager._metrics.duplicateOrphanCancelUnverifiedCount, 1, 'VERIFY-03: counter incremented once');
    }

    // VERIFY-04 — batch says gone but the independent read sees it live.
    {
        const h = createHarness({ readSingle: async () => ({ id: CANCEL_ID }) });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(result.failed, 1, 'VERIFY-04: second-read veto must refuse confirmation');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 1, 'VERIFY-04: entry stays queued');
        assert.strictEqual(result.results[0].result.error, 'cancel-verification-failed', 'VERIFY-04: confirmed failure');
    }

    // VERIFY-05 — no second-read seam: a lone batch absence is NOT proof (nit fix).
    {
        const h = createHarness({ noSingleRead: true });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(result.failed, 1, 'VERIFY-05: missing independent read must not confirm a cancel');
        assert.strictEqual(result.results[0].result.error, 'cancel-verification-lagging', 'VERIFY-05: lagging, not verified');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 1, 'VERIFY-05: entry stays queued');
    }

    // VERIFY-06 — exhausted drain budget defers silently (no hard error/counter).
    {
        const h = createHarness({ pipelineTiming: { CANCEL_VERIFY_DRAIN_BUDGET_MS: 0 } });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(result.corrected, 0, 'VERIFY-06: deferred cancel is not corrected');
        assert.strictEqual(result.failed, 0, 'VERIFY-06: budget deferral is not a failure');
        assert.strictEqual(result.results[0].result.deferred, true, 'VERIFY-06: deferral surfaced in results');
        assert.strictEqual(h.manager._metrics.duplicateOrphanCancelUnverifiedCount, 0, 'VERIFY-06: no error counter');
        assert.strictEqual(h.logs.some((l) => l.startsWith('[error]')), false, 'VERIFY-06: no hard error');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 1, 'VERIFY-06: entry stays queued');
    }

    // VERIFY-07 — batch path, lagging verification: failed + result, no serial re-broadcast.
    {
        const h = createHarness({
            count: 2,
            batch: true,
            batchRead: (_ids, call) => call === 1
                ? new Map([[CANCEL_ID, {}], [CANCEL_ID_2, {}]])
                : new Map(),
            readSingle: async () => { throw new Error('lagging node'); }
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.batchCalls(), 1, 'VERIFY-07: batch broadcast happened');
        assert.strictEqual(h.cancelCalls(), 0, 'VERIFY-07: lagging batch entries are not re-broadcast serially');
        assert.strictEqual(result.failed, 2, 'VERIFY-07: batch verification failures counted');
        assert.strictEqual(result.results.length, 2, 'VERIFY-07: batch outcomes surfaced in results');
        assert.ok(result.results.every((r: any) => r.result.error === 'cancel-verification-lagging'),
            'VERIFY-07: lagging reason on every outcome');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 2, 'VERIFY-07: entries stay queued');
    }

    // VERIFY-08 — batch path, confirmed still-live: re-broadcast through serial retry.
    {
        const h = createHarness({
            count: 2,
            batch: true,
            batchRead: (_ids, call) => call === 1
                ? new Map([[CANCEL_ID, {}], [CANCEL_ID_2, {}]])
                : new Map([[CANCEL_ID, {}], [CANCEL_ID_2, {}]]),
            readSingle: async () => ({ id: 'still-live' })
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.cancelCalls(), 2, 'VERIFY-08: still-live entries reach the serial retry');
        // Residual fix: the serial retry is the SINGLE report. No double-counted
        // failed/results/counter from the batch verification step.
        assert.strictEqual(result.failed, 2, 'VERIFY-08: failed counted once per entry');
        assert.strictEqual(result.results.length, 2, 'VERIFY-08: one results row per entry');
        assert.strictEqual(h.manager._metrics.duplicateOrphanCancelUnverifiedCount, 2,
            'VERIFY-08: hard-error counter incremented once per entry');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 2, 'VERIFY-08: entries stay queued');
    }

    // VERIFY-09 — lagging PRE-read absence is not proof for EITHER id.
    {
        const confirmedPreRead = new Set<string>();
        const h = createHarness({
            batch: true,
            count: 2,
            batchRead: (ids, call) => call === 1
                ? new Map(ids.map((id) => [id, null])) // both "absent" on the pre-read
                : new Map(),
            readSingle: async (id) => {
                if (!confirmedPreRead.has(id)) {
                    confirmedPreRead.add(id);
                    return { id }; // first read per id: actually live (lagging pre-read)
                }
                return null; // post-broadcast verification confirms gone
            }
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.batchCalls(), 1, 'VERIFY-09: lagging pre-read must not suppress the cancel broadcast');
        assert.strictEqual(h.opsBuilt().length, 2, 'VERIFY-09: both ids are in the broadcast batch');
        assert.strictEqual(result.corrected, 2, 'VERIFY-09: both verified after broadcast');
    }

    // VERIFY-10 — batch still-live, serial resolves: no phantom failures.
    {
        let serialStarted = false;
        const h = createHarness({
            count: 2,
            batch: true,
            // Drive behaviour from the serial broadcast, not a hard-coded read
            // count, so a change to the attempt knob cannot break this test.
            onCancel: () => { serialStarted = true; },
            batchRead: () => serialStarted
                ? new Map()
                : new Map([[CANCEL_ID, {}], [CANCEL_ID_2, {}]]),
            readSingle: async () => null
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(result.corrected, 2, 'VERIFY-10: serial retry resolves both entries');
        assert.strictEqual(result.failed, 0, 'VERIFY-10: no phantom failures after resolution');
        assert.strictEqual(result.results.length, 2, 'VERIFY-10: one results row per entry');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 0, 'VERIFY-10: queue drained');
        assert.strictEqual(h.manager._metrics.duplicateOrphanCancelUnverifiedCount, 0,
            'VERIFY-10: batch still-live must not inflate the hard-error counter');
    }

    // VERIFY-11 — batch path budget deferral is visible in results too.
    {
        const h = createHarness({
            count: 2,
            batch: true,
            pipelineTiming: { CANCEL_VERIFY_DRAIN_BUDGET_MS: 0 }
        });
        const result = await correctAllPriceMismatches(h.manager, 'account', 'key', h.accountOrders);
        assert.strictEqual(h.batchCalls(), 0, 'VERIFY-11: no broadcast when budget is already spent');
        assert.strictEqual(result.corrected, 0, 'VERIFY-11: nothing corrected');
        assert.strictEqual(result.failed, 0, 'VERIFY-11: deferral is not a failure');
        assert.strictEqual(result.results.length, 2, 'VERIFY-11: every deferred id has a result row');
        assert.ok(result.results.every((r: any) => r.result.deferred === true), 'VERIFY-11: rows marked deferred');
        assert.strictEqual(h.manager._metrics.duplicateOrphanCancelUnverifiedCount, 0, 'VERIFY-11: no hard-error counter');
        assert.strictEqual(h.manager.ordersNeedingPriceCorrection.length, 2, 'VERIFY-11: entries stay queued');
    }

    console.log('  ✓ duplicate-orphan cancel verification');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

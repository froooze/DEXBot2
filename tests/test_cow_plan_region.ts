/**
 * tests/test_cow_plan_region.ts
 *
 * Contract: the exclusive placement region covers the whole
 * plan → broadcast → commit window, not just the executor.
 *
 * The old split acquired placement only when the batch executor ran, so a
 * second planner passed every pre-check (`isPlacementActive()` was still
 * false) and built from the same master; both batches then broadcast — the
 * duplicate-order window (two plans 595 ms apart, observed 2026-11-13).
 *
 * `performSafeRebalance` now claims the region BEFORE planning and rides the
 * lease on the result (PLAN_LEASE_RESULT_KEY). Every consumer either adopts it
 * (the COW body releases it on every exit) or releases it (no-action /
 * discarded results). This suite pins:
 *   - acquire-before-plan, and a second planner deferring while it is held;
 *   - the result carries the lease, and an aborted plan does not leak it;
 *   - DEXBot.updateOrdersOnChainBatch hands it to the COW body and releases it
 *     on throw / non-COW payload;
 *   - _executeBatchIfNeeded releases it when there is nothing to execute;
 *   - the helper contract (attach/take/release) is idempotent.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const {
    attachPlanLease,
    takePlanLease,
    releasePlanLease,
    PLAN_LEASE_RESULT_KEY
} = require('../modules/order/placement_lock');
const DEXBot = require('../modules/dexbot_class').default;

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

function createManager() {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
    manager.logger = { log: () => {} };
    return manager;
}

function planResult(overrides = {}) {
    return {
        actions: [{ type: 'update', id: 'slot-1', orderId: '1.7.100' }],
        stateUpdates: [],
        workingGrid: {},
        workingIndexes: {},
        workingBoundary: 0,
        aborted: false,
        ...overrides
    };
}

async function testPlanClaimsPlacementBeforePlanning() {
    console.log('\n[COW-PLAN-REGION-001] performSafeRebalance claims the region BEFORE planning and rides it on the result...');

    const manager = createManager();
    let activeDuringPlan = false;
    let kindDuringPlan: string | null = null;
    manager._applySafeRebalanceCOW = async () => {
        activeDuringPlan = manager.isPlacementActive();
        kindDuringPlan = manager.placementKind();
        return planResult();
    };

    try {
        const result = await manager.performSafeRebalance([], new Set(), { holdPlanRegion: true });

        assert.strictEqual(activeDuringPlan, true, 'placement must be held while the plan is built');
        assert.strictEqual(kindDuringPlan, 'cow-plan', 'the plan region must be labelled for diagnostics');
        assert.strictEqual(manager.isPlacementActive(), true, 'the lease must survive the return so the executor can adopt it');
        assert(result[PLAN_LEASE_RESULT_KEY], 'the result must carry the plan lease');
        assert.strictEqual(result.aborted, false, 'the fixture plan is successful');

        releasePlanLease(result);
        assert.strictEqual(manager.isPlacementActive(), false, 'releasing the result lease must free the region');
        assert.strictEqual(result[PLAN_LEASE_RESULT_KEY], undefined, 'the lease must be removed from the result');
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-001 passed');
}

async function testPlannerOnlyCallerStaysLeaseFree() {
    console.log('\n[COW-PLAN-REGION-008] a planner-only caller (no executor) does not hold the region...');

    const manager = createManager();
    manager._applySafeRebalanceCOW = async () => planResult();

    try {
        // Unit fixtures and any read-only planner apply actions themselves and
        // never call an executor. Opting them into the region would strand it,
        // so the lease is opt-in via holdPlanRegion.
        const result = await manager.performSafeRebalance([], new Set());
        assert.strictEqual(manager.isPlacementActive(), false, 'a planner-only caller must not hold the region');
        assert.strictEqual(result[PLAN_LEASE_RESULT_KEY], undefined, 'no lease may ride a lease-free plan');
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-008 passed');
}

async function testSecondPlannerDefersWhilePlanHeld() {
    console.log('\n[COW-PLAN-REGION-002] a second planner defers while the first plan→execute region is held...');

    const manager = createManager();
    manager._applySafeRebalanceCOW = async () => planResult();

    try {
        const first = await manager.performSafeRebalance([], new Set(), { holdPlanRegion: true });
        assert.strictEqual(manager.isPlacementActive(), true, 'first plan holds the region');

        // The pre-fix gap: the lease existed only after the executor claimed,
        // so this second call saw a free region and planned from the same
        // master. Now it must defer without planning at all.
        let secondPlanned = false;
        manager._applySafeRebalanceCOW = async () => {
            secondPlanned = true;
            return planResult();
        };
        const second = await manager.performSafeRebalance([], new Set(), { holdPlanRegion: true });

        assert.strictEqual(secondPlanned, false, 'the second planner must not run while the region is held');
        assert.strictEqual(second.aborted, true, 'the second planner must defer');
        assert.strictEqual(second.reason, 'placement-active-deferred', 'the deferral reason must be explicit');
        assert.strictEqual(second.deferred, true, 'the deferral must be level-triggered');

        releasePlanLease(first);
        assert.strictEqual(manager.isPlacementActive(), false, 'releasing the first plan frees the region');
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-002 passed');
}

async function testAbortedPlanDoesNotLeakTheLease() {
    console.log('\n[COW-PLAN-REGION-003] an aborted plan releases the region immediately...');

    const manager = createManager();
    manager._applySafeRebalanceCOW = async () => ({
        actions: [],
        stateUpdates: [],
        workingGrid: null,
        workingIndexes: null,
        workingBoundary: null,
        aborted: true,
        reason: 'fixture-abort'
    });

    try {
        const result = await manager.performSafeRebalance([], new Set(), { holdPlanRegion: true });
        assert.strictEqual(result.aborted, true, 'the fixture abort must be returned');
        assert.strictEqual(result[PLAN_LEASE_RESULT_KEY], undefined, 'an aborted result must not carry a lease');
        assert.strictEqual(manager.isPlacementActive(), false, 'an aborted plan must not park the region');
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-003 passed');
}

async function testThrowingPlanReleasesTheLease() {
    console.log('\n[COW-PLAN-REGION-004] a plan that throws releases the region...');

    const manager = createManager();
    manager._applySafeRebalanceCOW = async () => { throw new Error('plan exploded'); };

    try {
        await assert.rejects(
            () => manager.performSafeRebalance([], new Set(), { holdPlanRegion: true }),
            /plan exploded/,
            'the plan error must propagate'
        );
        assert.strictEqual(manager.isPlacementActive(), false, 'a throwing plan must not park the region');
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-004 passed');
}

async function testExecutorHandsOverAndReleasesOnThrow() {
    console.log('\n[COW-PLAN-REGION-005] updateOrdersOnChainBatch hands the lease to the COW body and releases it on throw...');

    const manager = createManager();
    const bot: any = new DEXBot({
        botKey: 'test_cow_plan_region_executor',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = manager;

    try {
        const lease = await manager.acquirePlacement('cow-plan', { timeoutMs: 1000 });
        assert(lease, 'fixture lease must be acquired');
        const result = Object.assign(planResult(), { workingGrid: { id: 'wg' } });
        attachPlanLease(result, lease);

        let handedOver: any = null;
        bot._updateOrdersOnChainBatchCOW = async (_rb: any, options: any) => {
            handedOver = options?.placementLease ?? null;
            return { executed: true };
        };
        const out = await bot.updateOrdersOnChainBatch(result);
        assert.strictEqual(out.executed, true, 'the fixture executor succeeds');
        assert.strictEqual(handedOver, lease, 'the COW body must receive the plan lease');
        assert.strictEqual(result[PLAN_LEASE_RESULT_KEY], undefined, 'ownership must move off the result exactly once');
        // The stub plays the COW body, which releases the adopted lease in its
        // own finally; do the same here so the next case starts region-free.
        lease!.release();
        assert.strictEqual(manager.isPlacementActive(), false, 'the adopted lease is the executor\'s to release');

        // A throwing body must not leak the region.
        const throwingLease = await manager.acquirePlacement('cow-plan', { timeoutMs: 1000 });
        assert(throwingLease, 'second fixture lease must be acquired');
        const throwingResult = Object.assign(planResult(), { workingGrid: { id: 'wg-2' } });
        attachPlanLease(throwingResult, throwingLease);
        bot._updateOrdersOnChainBatchCOW = async () => { throw new Error('body exploded'); };
        await assert.rejects(
            () => bot.updateOrdersOnChainBatch(throwingResult),
            /body exploded/,
            'the body error must propagate'
        );
        assert.strictEqual(manager.isPlacementActive(), false, 'a throwing executor must release the plan lease');

        // A non-COW payload must release too.
        const payloadLease = await manager.acquirePlacement('cow-plan', { timeoutMs: 1000 });
        const payloadResult: any = planResult({ workingGrid: null });
        attachPlanLease(payloadResult, payloadLease);
        const rejected = await bot.updateOrdersOnChainBatch(payloadResult) as any;
        assert.strictEqual(rejected.reason, 'NON_COW_PAYLOAD', 'a payload without a working grid is rejected');
        assert.strictEqual(manager.isPlacementActive(), false, 'the rejected payload must not strand the region');
        void payloadResult;
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-005 passed');
}

async function testExecuteBatchIfNeededReleasesOnNoActions() {
    console.log('\n[COW-PLAN-REGION-006] _executeBatchIfNeeded releases a plan lease when there is nothing to execute...');

    const manager = createManager();
    manager.persistGrid = async () => ({ isValid: true } as any);
    manager.requestStructuralGridResync = async () => ({ scheduled: false } as any);
    const bot: any = new DEXBot({
        botKey: 'test_cow_plan_region_no_actions',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = manager;

    try {
        const lease = await manager.acquirePlacement('cow-plan', { timeoutMs: 1000 });
        assert(lease, 'fixture lease must be acquired');
        const result = planResult({ actions: [], workingGrid: null });
        attachPlanLease(result, lease);

        let executed = false;
        bot._updateOrdersOnChainBatchCOW = async () => { executed = true; return { executed: true }; };

        const out: any = await bot._executeBatchIfNeeded(result, 'fixture');
        assert.strictEqual(executed, false, 'no-action results must not reach the executor');
        assert.strictEqual(out.skippedNoActions, true, 'the no-action path must be taken');
        assert.strictEqual(manager.isPlacementActive(), false, 'the unused plan lease must be released');
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-006 passed');
}

async function testHelperContractIsIdempotent() {
    console.log('\n[COW-PLAN-REGION-007] attach/take/release is single-owner and idempotent...');

    const manager = createManager();
    try {
        const lease = await manager.acquirePlacement('cow-plan', { timeoutMs: 1000 });
        assert(lease, 'fixture lease must be acquired');
        const result: any = {};

        attachPlanLease(result, lease);
        assert.strictEqual(result[PLAN_LEASE_RESULT_KEY], lease, 'attach must store the lease');

        const taken = takePlanLease(result);
        assert.strictEqual(taken, lease, 'take must return the lease');
        assert.strictEqual(takePlanLease(result), null, 'a second take must return null');
        assert.strictEqual(manager.isPlacementActive(), true, 'take must not release ownership');

        taken!.release();
        assert.strictEqual(manager.isPlacementActive(), false, 'the owner releases the region');

        // releasePlanLease is a safe no-op on a result without a lease, and a
        // second release of the same lease must not throw.
        releasePlanLease(result);
        releasePlanLease(result);
        assert.strictEqual(manager.isPlacementActive(), false, 'no-op releases must not acquire anything');
    } finally {
        manager.setShuttingDown(true);
    }

    console.log('✓ COW-PLAN-REGION-007 passed');
}

async function run() {
    console.log('Running COW plan-region (plan → broadcast → commit) tests...');
    await testPlanClaimsPlacementBeforePlanning();
    await testSecondPlannerDefersWhilePlanHeld();
    await testAbortedPlanDoesNotLeakTheLease();
    await testThrowingPlanReleasesTheLease();
    await testExecutorHandsOverAndReleasesOnThrow();
    await testExecuteBatchIfNeededReleasesOnNoActions();
    await testHelperContractIsIdempotent();
    await testPlannerOnlyCallerStaysLeaseFree();
    console.log('\n✓ All COW plan-region tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
});

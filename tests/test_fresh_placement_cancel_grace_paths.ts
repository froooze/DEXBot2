/**
 * tests/test_fresh_placement_cancel_grace_paths.ts
 *
 * Regression tests for the fresh-placement grace applied to the COW/reconcile
 * cancellation paths (companion to tests/test_surplus_cancel_grace.ts, which
 * covers the correction-queue paths).
 *
 * The reconcile/COW planner runs on a target snapshot that can be a beat
 * behind a just-placed order; a surplus sweep on that snapshot would cancel
 * the fresh order (fee bleed, empty level, no net change). These tests drive
 * the planner (COWRebalanceEngine.execute) and the divergence correction path
 * (applyGridDivergenceCorrections) and assert that:
 *   - a freshly placed on-chain order is NOT cancelled and stays active;
 *   - an aged on-chain order with the same shape IS cancelled as before.
 */
const assert = require('assert');
const { COWRebalanceEngine, OrderManager } = require('../modules/order/manager');
const { applyGridDivergenceCorrections } = require('../modules/order/utils/system');
const { updateGridFromBlockchainSnapshot } = require('../modules/order/grid');
const { ORDER_STATES, ORDER_TYPES, COW_ACTIONS } = require('../modules/constants');

let assertions = 0;
function check(name: string, actual: unknown, expected: unknown) {
    assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
    assertions++;
    console.log(`  ✓ ${name}`);
}

const ASSETS = {
    assetA: { id: '1.3.0', symbol: 'BASE', precision: 5 },
    assetB: { id: '1.3.1', symbol: 'QUOTE', precision: 5 }
};

function makeEngine(targetGrid: Map<string, any>, boundaryIdx: number) {
    return new COWRebalanceEngine({
        strategy: { calculateTargetGrid: () => ({ targetGrid, boundaryIdx }) } as any,
        logger: { log: () => {} } as any,
        assets: ASSETS as any,
        config: {
            incrementPercent: 1,
            gridLimits: {},
            coreOrders: { buy: 0, sell: 0 }
        } as any
    });
}

/** A manager-shaped holder for the grace data only. */
function makeGraceHolder(freshOrderId: string | null, corrections: any[] = []) {
    const placedAt = new Map<string, number>();
    if (freshOrderId) placedAt.set(freshOrderId, Date.now());
    return { _placedAt: placedAt, ordersNeedingPriceCorrection: corrections };
}

// Grant generous funds so the working-grid fund check never aborts the plan.
const FUNDS = { allocatedBuy: 1_000_000, allocatedSell: 1_000_000 };

async function runReconcilePlan(fresh: boolean, mode: 'orphan' | 'type-mismatch' = 'orphan', corrections: any[] = []) {
    const masterGrid = new Map<string, any>();
    masterGrid.set('slot-0', {
        id: 'slot-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE,
        price: 100, size: 10, orderId: '1.7.100'
    });
    masterGrid.set('slot-1', {
        id: 'slot-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE,
        price: 110, size: 10, orderId: '1.7.101'
    });
    const targetGrid = new Map<string, any>();
    if (mode === 'type-mismatch') {
        // Target retypes slot-0 without moving it: raw reconcile emits a
        // paired type-mismatch CANCEL + CREATE on the SAME id (slot-0). The
        // id-group pre-filter must drop both — dropping only the CANCEL would
        // let optimizeRebalanceActions fold the CREATE back into an UPDATE
        // and re-materialize the placement.
        targetGrid.set('slot-0', {
            id: 'slot-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE,
            price: 100, size: 10.5
        });
    }
    // Orphan mode: the target omits slot-0 entirely, so reconcile plans an
    // orphan-slot CANCEL.
    targetGrid.set('slot-1', {
        id: 'slot-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE,
        price: 110, size: 10, orderId: '1.7.101'
    });

    const engine = makeEngine(targetGrid, 0);
    return await engine.execute({
        masterGrid,
        gridVersion: 1,
        boundaryIdx: 0,
        funds: FUNDS as any,
        manager: makeGraceHolder(fresh ? '1.7.100' : null, corrections) as any,
        gapSlots: 0
    });
}

async function testReconcilePath() {
    console.log(' - Reconcile/COW engine fresh-cancel grace...');

    {
        const result = await runReconcilePlan(true);
        const cancels = (result.actions || []).filter(
            (a: any) => a.type === COW_ACTIONS.CANCEL && String(a.id) === 'slot-0'
        );
        check('fresh orphan is not cancelled', cancels.length, 0);
        const working = (result.workingGrid as any)?.get('slot-0');
        check('fresh orphan stays active in working grid', working?.state, ORDER_STATES.ACTIVE);
        check('fresh orphan keeps its chain binding', working?.orderId, '1.7.100');
    }

    {
        const result = await runReconcilePlan(false);
        const cancels = (result.actions || []).filter(
            (a: any) => a.type === COW_ACTIONS.CANCEL && String(a.id) === 'slot-0'
        );
        check('aged orphan is still cancelled', cancels.length >= 1, true);
        const update = (result.stateUpdates || []).find((o: any) => String(o.id) === 'slot-0');
        check('aged orphan is virtualized by its cancel', update?.state, ORDER_STATES.VIRTUAL);
    }
}

async function testPairedCreateNotRematerialized() {
    console.log(' - Id-group drop guard (type-mismatch CANCEL+CREATE pair)...');

    // Guard: the deferred slot keeps its master state AND the paired CREATE
    // on the same id is not re-materialized (as an action or via the fold).
    const fresh = await runReconcilePlan(true, 'type-mismatch');
    const slotActions = (fresh.actions || []).filter((a: any) => String(a.id) === 'slot-0');
    check('fresh pair: no CANCEL survives for slot', slotActions.filter((a: any) => a.type === COW_ACTIONS.CANCEL).length, 0);
    check('fresh pair: no CREATE survives for slot', slotActions.filter((a: any) => a.type === COW_ACTIONS.CREATE).length, 0);
    check('fresh pair: no folded UPDATE survives for slot', slotActions.filter((a: any) => a.type === COW_ACTIONS.UPDATE).length, 0);
    const freshWorking = (fresh.workingGrid as any)?.get('slot-0');
    check('fresh pair: deferred slot carries its master state',
        freshWorking && freshWorking.type === ORDER_TYPES.BUY && freshWorking.price === 100 && freshWorking.size === 10, true);
    check('fresh pair: deferred slot keeps its chain binding', freshWorking?.orderId, '1.7.100');
    check('fresh pair: deferred slot stays active', freshWorking?.state, ORDER_STATES.ACTIVE);

    // Aged control: same shape, no manager stamps — the pair materializes
    // (CANCEL+CREATE, possibly folded to an UPDATE by optimizeRebalanceActions).
    const aged = await runReconcilePlan(false, 'type-mismatch');
    const agedSlotActions = (aged.actions || []).filter((a: any) => String(a.id) === 'slot-0');
    const hasCancel = agedSlotActions.some((a: any) => a.type === COW_ACTIONS.CANCEL);
    const hasCreate = agedSlotActions.some((a: any) => a.type === COW_ACTIONS.CREATE);
    // Folded form: optimizeRebalanceActions rewrites the pair into an UPDATE
    // on the same id (in-place rotation).
    const hasFoldedUpdate = agedSlotActions.some(
        (a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId !== undefined
    );
    check('aged pair: cancel emitted', hasCancel || hasFoldedUpdate, true);
    check('aged pair: create emitted', hasCreate || hasFoldedUpdate, true);
}

async function testQueuedTypeMismatchBypassesGrace() {
    console.log(' - Queued typeMismatch entries bypass the COW grace...');

    // A queued typeMismatch entry is the proof that the CHAIN side is wrong;
    // the drain having deferred/failed must not park the order for 15 more
    // minutes. The plan shape is identical to the deferred control below.
    const queuedMismatch = [{
        chainOrderId: '1.7.100',
        type: ORDER_TYPES.SELL,
        typeMismatch: true,
        isSurplus: true,
    }];
    const exempted = await runReconcilePlan(true, 'type-mismatch', queuedMismatch);
    const exemptedSlotActions = (exempted.actions || []).filter((a: any) => String(a.id) === 'slot-0');
    const exemptedCancel = exemptedSlotActions.some((a: any) => a.type === COW_ACTIONS.CANCEL);
    const exemptedFolded = exemptedSlotActions.some(
        (a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId !== undefined
    );
    check('queued mismatch: the fresh cancel is not parked', exemptedCancel || exemptedFolded, true);
    check('queued mismatch: the paired create is kept',
        exemptedSlotActions.some((a: any) => a.type === COW_ACTIONS.CREATE) || exemptedFolded, true);

    // Control: same plan shape, no chain-side proof — the stale-target lag
    // protection must still defer it.
    const surplusOnly = [{ chainOrderId: '1.7.100', type: ORDER_TYPES.BUY, isSurplus: true }];
    const deferred = await runReconcilePlan(true, 'type-mismatch', surplusOnly);
    const deferredSlotActions = (deferred.actions || []).filter((a: any) => String(a.id) === 'slot-0');
    check('plain fresh surplus: still deferred', deferredSlotActions.length, 0);
}

async function testDivergencePath() {
    console.log(' - Divergence-COW fresh-cancel grace...');

    async function run(fresh: boolean) {
        const manager = new OrderManager({
            assetA: 'TESTA',
            assetB: 'TESTB',
            startPrice: 100,
            incrementPercent: 1,
            targetSpreadPercent: 2,
            coreOrders: { buy: 3, sell: 3 },
            botFunds: { buy: 1000, sell: 1000 }
        });
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
        } as any;
        manager.boundaryIdx = 5;
        manager.outOfSpread = 0;
        manager._gridVersion = 1;

        for (let i = 0; i < 10; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: i <= 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            });
        }
        await manager.setAccountTotals({ buy: 1000, sell: 100, buyFree: 1000, sellFree: 100 });
        await manager.recalculateFunds();

        // 5 active BUYs where the target window wants 3: the two lowest-priority
        // slots become divergence surpluses to cancel.
        for (let i = 0; i < 5; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                size: 100,
                orderId: `chain-${i}`
            });
        }
        // _updateOrder auto-stamps every newly-bound chain id as freshly
        // placed, so explicitly age all of them and then re-stamp only the one
        // under test. This mirrors a real sweep where the target has since
        // aged past the grace window.
        manager._placedAt.clear();
        if (fresh) manager._placedAt.set('chain-0', Date.now());

        manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY]);
        manager.outOfSpread = 1;

        let captured: any = null;
        const mockUpdateFn = async (cowResult: any) => { captured = cowResult; return { executed: true }; };

        await applyGridDivergenceCorrections(
            manager,
            { storeMasterGrid: async () => {} } as any,
            'bot-key',
            mockUpdateFn,
            updateGridFromBlockchainSnapshot as any
        );
        return captured;
    }

    {
        const captured = await run(false);
        assert(captured && Array.isArray(captured.actions), 'divergence plan should produce a COW result');
        const cancels = captured.actions.filter(
            (a: any) => a.type === COW_ACTIONS.CANCEL
        );
        check('aged divergence surplus is cancelled', cancels.length >= 2, true);
    }

    {
        const captured = await run(true);
        assert(captured && Array.isArray(captured.actions), 'divergence plan should produce a COW result');
        const cancels = captured.actions.filter(
            (a: any) => a.type === COW_ACTIONS.CANCEL
        );
        const freshCancel = cancels.find((a: any) => a.orderId === 'chain-0');
        check('fresh divergence surplus is not cancelled', Boolean(freshCancel), false);
        const working = captured.workingGrid?.get('slot-0');
        check('fresh divergence surplus stays active', working?.state, ORDER_STATES.ACTIVE);
        check('fresh divergence surplus keeps its chain binding', working?.orderId, 'chain-0');
    }
}

async function main() {
    console.log('Running fresh-placement cancel grace path tests...');
    await testReconcilePath();
    await testPairedCreateNotRematerialized();
    await testQueuedTypeMismatchBypassesGrace();
    await testDivergencePath();
    console.log(`\n✓ Fresh-placement cancel grace path tests passed! (${assertions} assertions)`);
}

main().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});

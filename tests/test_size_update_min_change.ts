/**
 * Regression test for SIZE_UPDATE_MIN_CHANGE_PERCENT.
 *
 * The funds/divergence resize used to emit a limit_order_update for any
 * one-satoshi size difference. On shared accounts the funds-ratio trigger
 * fires every tick, so a sub-0.1% drift produced a full batch of updates that
 * the 0.1% commit equality gate then refused after the ops had landed.
 *
 * These tests pin both the helper semantics and the resize emission gate:
 * a 0.04% drift emits nothing; a 4% drift emits exactly one UPDATE. The
 * emission gate is clamped to the commit-time tolerance so a config override
 * can never re-create the refused-commit fee bleed.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { _recalculateGridOrderSizesFromBlockchain, checkAndUpdateGridIfNeeded } = require('../modules/order/grid');
const { WorkingGrid } = require('../modules/order/working_grid');
const {
    isSignificantSizeChange,
    resolveSizeUpdateMinChangePercent
} = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testHelperSemantics() {
    console.log('\n[SIZE-UPDATE-001] helper semantics...');

    assert.strictEqual(isSignificantSizeChange(1000, 1000.4, 3), false, '0.04% change is below the 3% gate');
    assert.strictEqual(isSignificantSizeChange(1000, 1029.99, 3), false, '2.99% change is below the 3% gate');
    assert.strictEqual(isSignificantSizeChange(1000, 1031, 3), true, '3.1% growth is significant');
    assert.strictEqual(isSignificantSizeChange(1000, 960, 3), true, '4% shrink is significant');
    assert.strictEqual(isSignificantSizeChange(0, 5, 3), true, 'zero-size slot with positive target is significant');
    assert.strictEqual(isSignificantSizeChange(0, 0, 3), false, 'zero to zero is never significant');
    assert.strictEqual(isSignificantSizeChange(1000, 1000.00001, 0), true, 'threshold 0 keeps every integer change');
    // Knife-edge: the commit gate uses max(current, proposed) as its scale, so
    // a 0.1% growth relative to `current` is only 0.0999% relative to `proposed`
    // and is treated as equal at commit. Emission must skip the same change.
    assert.strictEqual(isSignificantSizeChange(1000, 1001, 0.1), false, 'commit-equal 0.1% growth is not emitted');
    assert.strictEqual(isSignificantSizeChange(1000, 1001.1, 0.1), true, 'just above the commit-equal boundary is emitted');
    // Precision floor: commit's nearlyEqualRelative uses max(scale*relative,
    // quantum). Emission must skip a change of one quantum or less, including
    // from a zero-size slot.
    assert.strictEqual(isSignificantSizeChange(0.00001, 0.00002, 3, 5), false, 'one quantum at precision 5 is commit-equal');
    assert.strictEqual(isSignificantSizeChange(0.0001, 0.00011, 3, 5), false, 'one quantum on a larger tiny order is commit-equal');
    assert.strictEqual(isSignificantSizeChange(0, 0.00001, 3, 5), false, 'zero-size slot with a one-quantum target is commit-equal');
    assert.strictEqual(isSignificantSizeChange(0, 0.00002, 3, 5), true, 'zero-size slot above the quantum floor is emitted');

    assert.strictEqual(resolveSizeUpdateMinChangePercent({}), 3, 'default is 3%');
    assert.strictEqual(
        resolveSizeUpdateMinChangePercent({ gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 0 } }),
        0.1,
        'configured 0 is clamped to the commit-time tolerance, never one-satoshi'
    );
    assert.strictEqual(
        resolveSizeUpdateMinChangePercent({ gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 0.05 } }),
        0.1,
        'emission gate can never be weaker than the commit gate'
    );
    assert.strictEqual(
        resolveSizeUpdateMinChangePercent({ gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 0, RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT: 0.01 } }),
        0.01,
        'a lower configured commit tolerance lowers the safe emission floor'
    );
    assert.strictEqual(resolveSizeUpdateMinChangePercent({ gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 1.5 } }), 1.5, 'configured value wins');
    assert.strictEqual(resolveSizeUpdateMinChangePercent({ gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 'nope' } }), 3, 'invalid config falls back to default');

    console.log('✓ SIZE-UPDATE-001 passed');
}

async function testResizeEmissionGate() {
    console.log('\n[SIZE-UPDATE-002] resize emits only >= 3% size changes...');

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        coreOrders: { buy: 3, sell: 3 },
        botFunds: { buy: 1000, sell: 1000 },
        gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 3 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };
    manager.boundaryIdx = 2; // slots 0-2 are BUY
    manager.outOfSpread = 0;
    manager._gridVersion = 1;

    for (let i = 0; i < 3; i++) {
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 100 + i,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            size: 100,
            orderId: `chain-${i}`
        });
    }

    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const setSize = async (id: string, size: number) => {
        const current = manager.orders.get(id);
        await manager._updateOrder({ ...current, size });
        // _updateOrder books the size delta against the optimistic free balance.
        // Reset the chain view so the resize derives the same budget on every
        // pass (this fixture is about size gating only).
        await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
        await manager.recalculateFunds();
    };

    // Capture the exact ideal sizes the resize derives, with the gate disabled.
    manager.config.gridLimits = { ...manager.config.gridLimits, SIZE_UPDATE_MIN_CHANGE_PERCENT: 0 };
    let baselineGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    const baseline = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid: baselineGrid });
    assert(baseline && baseline.actions.length === 3, 'baseline emits one UPDATE per slot');
    const ideal = new Map<string, number>();
    for (const action of baseline!.actions) ideal.set(String(action.id), Number(action.newSize));
    assert.strictEqual(ideal.size, 3, 'baseline covers all three slots');
    assert([...ideal.values()].every((s: number) => s > 0), 'all ideal sizes are positive');

    // 1) Every slot is 0.04% away from its ideal -> no UPDATE at all.
    manager.config.gridLimits = { ...manager.config.gridLimits, SIZE_UPDATE_MIN_CHANGE_PERCENT: 3 };
    for (let i = 0; i < 3; i++) await setSize(`slot-${i}`, ideal.get(`slot-${i}`)! * 1.0004);

    let workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    let result = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid });
    assert(result, 'resize result exists');
    assert.strictEqual(result!.actions.length, 0, 'sub-threshold drift emits no UPDATE');
    assert.strictEqual(result!.changed, false, 'sub-threshold drift is not a working-grid change');

    // 2) One slot is 4% below its ideal -> exactly that slot gets an UPDATE.
    await setSize('slot-1', ideal.get('slot-1')! * 0.96);

    workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    result = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid });
    assert(result, 'resize result exists');
    assert.strictEqual(result!.actions.length, 1, 'only the significant slot is updated');
    assert.strictEqual(result!.actions[0].id, 'slot-1', 'the significant slot is slot-1');
    assert.strictEqual(result!.actions[0].orderId, 'chain-1', 'the chain order id is preserved');

    // 3) Lowering BOTH the emission gate and the commit tolerance emits the
    //    same 0.04% drift. Lowering only the emission gate is refused by the
    //    clamp, so the test must move the commit knob too.
    await setSize('slot-1', ideal.get('slot-1')! * 1.0004);
    manager.config.gridLimits = {
        ...manager.config.gridLimits,
        SIZE_UPDATE_MIN_CHANGE_PERCENT: 0,
        RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT: 0.01,
    };

    workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    result = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid });
    assert(result, 'resize result exists');
    assert.strictEqual(result!.actions.length, 3, 'a lowered commit floor allows the sub-0.1% drift to emit');

    console.log('✓ SIZE-UPDATE-002 passed');
}

async function testPostCapEmissionGate() {
    console.log('\n[SIZE-UPDATE-003] funding cap cannot create a sub-threshold UPDATE...');

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        coreOrders: { buy: 3, sell: 3 },
        botFunds: { buy: 1000, sell: 1000 },
        gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 3 }
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };
    manager.boundaryIdx = 2;
    manager.outOfSpread = 0;
    manager._gridVersion = 1;

    for (let i = 0; i < 3; i++) {
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 100 + i,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            size: 100,
            orderId: `chain-${i}`
        });
    }

    // Ideal sizes are well above the current 100, but only 0.05 units of free
    // funds are available: the growth cap clips every slot to a ~0.05% change.
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 0.05, sellFree: 1000 });
    await manager.recalculateFunds();

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    const result = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid });
    assert(result, 'resize result exists');
    assert.strictEqual(result!.actions.length, 0, 'a capped sub-threshold change must not emit an UPDATE');
    assert.strictEqual(result!.changed, false, 'the working grid must stay unchanged');

    const drift = checkAndUpdateGridIfNeeded(manager);
    assert.strictEqual(drift.buyUpdated, false, 'the mirrored drift gate must not flag a capped no-op');

    console.log('✓ SIZE-UPDATE-003 passed');
}

async function testSkippedSlotKeepsBudgetForLaterSlots() {
    console.log('\n[SIZE-UPDATE-004] skipped capped slot leaves its budget for later slots...');

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        coreOrders: { buy: 2, sell: 2 },
        botFunds: { buy: 20620, sell: 1000 },
        gridLimits: { SIZE_UPDATE_MIN_CHANGE_PERCENT: 3 }
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };
    manager.boundaryIdx = 2;
    manager.outOfSpread = 0;
    manager._gridVersion = 1;

    // slot-0 is large: its ideal growth is clipped by the 200-unit budget to a
    // sub-threshold change, so it must be skipped WITHOUT consuming the budget.
    await manager._updateOrder({ id: 'slot-0', price: 100, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 10000, orderId: 'chain-0' });
    // slot-1 is small: the same budget produces a significant growth and must
    // still be funded after slot-0 was skipped.
    await manager._updateOrder({ id: 'slot-1', price: 101, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 100, orderId: 'chain-1' });

    await manager.setAccountTotals({ buy: 20620, sell: 1000, buyFree: 200, sellFree: 1000 });
    await manager.recalculateFunds();

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    const result = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid });
    assert(result, 'resize result exists');
    const actions = result!.actions.filter((a) => a.type === 'update');
    assert.strictEqual(actions.length, 1, 'only the later, significant slot is updated');
    assert.strictEqual(actions[0].id, 'slot-1', 'slot-0 must not emit a capped no-op UPDATE');
    assert.ok(actions[0].newSize > 100, 'the skipped slot must leave its free budget for slot-1');

    // The mirrored drift metric must use the same post-cap values: the counted
    // growth is slot-1's applied 200 units, not slot-0's clipped 200.
    const drift = checkAndUpdateGridIfNeeded(manager);
    assert.strictEqual(drift.buyUpdated, false, 'capped sub-threshold drift must not re-trigger');

    console.log('✓ SIZE-UPDATE-004 passed');
}

async function main() {
    await testHelperSemantics();
    await testResizeEmissionGate();
    await testPostCapEmissionGate();
    await testSkippedSlotKeepsBudgetForLaterSlots();
    console.log('\nAll size-update min-change tests passed.');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
});

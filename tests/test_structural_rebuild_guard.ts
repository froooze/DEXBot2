/**
 * tests/test_structural_rebuild_guard.ts
 *
 * Regression guards for the 2026-11-03 live duplicate-order incident:
 *
 *  1. isStructuralRebuildStaleReason() classifies a grid rebuild differently
 *     from a plain fill mutation (only the rebuild must abort a create-only
 *     re-plan).
 *  2. OrderManager.beginStructuralRebuild/endStructuralRebuild bracket the
 *     rebuild and a fill-driven performSafeRebalance DEFERS while it is active.
 *  3. An active placement region also defers a fill-driven rebalance (the
 *     reconcile/correction drain owns placement).
 */

const assert = require('assert');
const { isStructuralRebuildStaleReason } = require('../modules/order/utils/order');
const { OrderManager, grid: Grid } = require('../modules/order/index').default;

const cfg = {
    assetA: 'BASE',
    assetB: 'QUOTE',
    startPrice: 100,
    minPrice: 50,
    maxPrice: 200,
    incrementPercent: 10,
    targetSpreadPercent: 10,
    botFunds: { buy: 1000, sell: 10 },
    coreOrders: { buy: 2, sell: 2 },
};

function testStaleReasonClassifier() {
    console.log('\n - structural staleness classifier...');
    assert.strictEqual(
        isStructuralRebuildStaleReason('Refusing stale working grid commit: master mutation during broadcasting (grid-init)'),
        true,
        'grid-init must classify as structural'
    );
    assert.strictEqual(
        isStructuralRebuildStaleReason('Refusing stale working grid commit: master mutation during broadcasting (fill-place)'),
        false,
        'fill-place must NOT classify as structural'
    );
    assert.strictEqual(
        isStructuralRebuildStaleReason('Refusing stale working grid commit: master mutation during broadcasting (handle-fill-batch)'),
        false,
        'handle-fill-batch must NOT classify as structural'
    );
    assert.strictEqual(
        isStructuralRebuildStaleReason('trigger-file resync rebuild'),
        true,
        'resync/rebuild labels must classify as structural'
    );
    assert.strictEqual(isStructuralRebuildStaleReason(null), false);
    assert.strictEqual(isStructuralRebuildStaleReason(undefined), false);
    console.log('  PASS');
}

async function testRebalanceDefersDuringRebuild() {
    console.log('\n - fill-driven rebalance defers during a structural rebuild...');
    const mgr = new OrderManager(cfg);
    await mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });
    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    await Grid.initializeGrid(mgr);

    assert.strictEqual(mgr.isStructuralRebuildInProgress(), false);
    mgr.beginStructuralRebuild('test rebuild');
    assert.strictEqual(mgr.isStructuralRebuildInProgress(), true);

    const deferred = await mgr.performSafeRebalance([], new Set(), { deferIfBroadcasting: true });
    assert.strictEqual(deferred.deferred, true, 'rebalance must defer during a rebuild');
    assert.strictEqual(deferred.aborted, true);
    assert.strictEqual(deferred.reason, 'structural-rebuild-deferred');

    mgr.endStructuralRebuild();
    assert.strictEqual(mgr.isStructuralRebuildInProgress(), false);
    console.log('  PASS');
}

async function testRebalanceDefersWhilePlacementHeld() {
    console.log('\n - rebalance defers while another placement path holds the region...');
    const mgr = new OrderManager(cfg);
    await mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });
    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    await Grid.initializeGrid(mgr);

    const lease = await mgr.acquirePlacement('startup-reconcile');
    assert.ok(lease, 'placement lease must be acquired');
    assert.strictEqual(mgr.isPlacementActive(), true);
    assert.strictEqual(mgr.placementKind(), 'startup-reconcile');

    const deferred = await mgr.performSafeRebalance([], new Set(), { deferIfBroadcasting: true });
    assert.strictEqual(deferred.deferred, true, 'rebalance must defer while placement is held');
    assert.strictEqual(deferred.reason, 'placement-active-deferred');

    lease.release();
    assert.strictEqual(mgr.isPlacementActive(), false);
    console.log('  PASS');
}

(async () => {
    console.log('Running structural rebuild guard tests...');
    testStaleReasonClassifier();
    await testRebalanceDefersDuringRebuild();
    await testRebalanceDefersWhilePlacementHeld();
    console.log('\n✓ All structural rebuild guard tests passed');
})().catch((err) => {
    console.error('❌ Structural rebuild guard test failed:', err);
    process.exit(1);
});

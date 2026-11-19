/**
 * tests/test_dry_run_placement_lease_release.ts
 *
 * R1 regression: updateOrdersOnChainBatchCOWBody's dry-run exit must release
 * an inherited placement lease. The body owns the region from entry — the
 * wrapper's `resultPlanLease?.release()` only covers a lease still carried by
 * the result, while dexbot_class.updateOrdersOnChainBatch takes that lease off
 * the result and hands it back as options.placementLease (inherited here).
 *
 * Mutation checks:
 *  - drop releasePlacement() from the dry-run branch → R1-01/R1-03 fail and
 *    R1-02 drops to a single (wrapper-only) release;
 *  - keep the release after popPushedWorkingGrid (or only in the wrapper's
 *    finally) → the options-placementLease case still fails.
 */
const assert = require('assert');
const { WorkingGrid } = require('../modules/order/working_grid');
const { COW_ACTIONS } = require('../modules/constants');

function makeBot() {
    const DEXBot = require('../modules/dexbot_class').default;
    const bot = new DEXBot({
        botKey: 'test_dry_run_placement_lease',
        dryRun: true,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.config.dryRun = true;
    bot.manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders: new Map(),
        _gridVersion: 0,
        logger: { log: () => {}, logFundsStatus: () => {} },
        _pendingBroadcasts: new Map(),
        lockOrders: () => {},
        unlockOrders: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _clearWorkingGridRef: () => {},
        _throwOnIllegalState: false
    };
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    return bot;
}

function makeCowResult(bot: any) {
    return {
        workingGrid: new WorkingGrid(bot.manager.orders, { baseVersion: 0 }),
        workingIndexes: {},
        workingBoundary: 0,
        actions: [{ type: COW_ACTIONS.CANCEL, id: 'sell-1', orderId: '1.7.1' }]
    };
}

/** Real leases are token-guarded/idempotent: count both raw release calls and
 *  the effective (first) release, so R1-02 can assert that the body AND the
 *  wrapper both released while the token was only handed back once. */
function makeLease() {
    const state = { released: 0, calls: 0 };
    return {
        state,
        lease: {
            release() {
                state.calls++;
                if (state.released === 0) state.released++;
            }
        }
    };
}

async function run() {
    console.log('Running dry-run placement lease release tests...');

    // R1-01 — options.placementLease (the dexbot_class.updateOrdersOnChainBatch
    // route) is released by the dry-run body, not just carried through.
    {
        const bot = makeBot();
        const cowResult = makeCowResult(bot);
        const { state, lease } = makeLease();
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult, { placementLease: lease });
        assert.strictEqual(result.executed, true, 'R1-01: dry run still reports executed');
        assert.strictEqual(state.released, 1, 'R1-01: inherited lease must be released on the dry-run exit');
        assert.strictEqual(state.calls, 1, 'R1-01: only the body owns the lease on this route');
    }

    // R1-02 — a result-attached lease reaches the wrapper's own resultPlanLease
    // (takePlanLease happens INSIDE the wrapper on this route), so both the body
    // exit and the wrapper finally call release on the same token. Real leases
    // are idempotent; the fake models that and must still show a single release.
    {
        const bot = makeBot();
        const cowResult = makeCowResult(bot);
        const { state, lease } = makeLease();
        const { attachPlanLease } = require('../modules/order/placement_lock');
        const { updateOrdersOnChainBatchCOW } = require('../modules/dexbot_cow_runtime');
        attachPlanLease(cowResult, lease);
        const result = await updateOrdersOnChainBatchCOW(bot, cowResult);
        assert.strictEqual(result.executed, true, 'R1-02: dry run still reports executed');
        assert.strictEqual(state.released, 1, 'R1-02: result-carried lease must be released once');
        assert.strictEqual(state.calls, 2, 'R1-02: both the body exit and the wrapper finally release the token');
    }

    // R1-03 — the public DEXBot route takes the lease off the result BEFORE the
    // wrapper, so it arrives as options.placementLease (same as R1-01) and the
    // wrapper's resultPlanLease release cannot cover it.
    {
        const bot = makeBot();
        const cowResult = makeCowResult(bot);
        const { state, lease } = makeLease();
        const { attachPlanLease } = require('../modules/order/placement_lock');
        attachPlanLease(cowResult, lease);
        const result = await bot.updateOrdersOnChainBatch(cowResult);
        assert.strictEqual(result.executed, true, 'R1-03: dry run still reports executed');
        assert.strictEqual(state.released, 1, 'R1-03: public route must still release the adopted lease');
        assert.strictEqual(state.calls, 1, 'R1-03: the wrapper has no result-carried lease to release');
    }

    console.log('  ✓ dry-run placement lease release');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

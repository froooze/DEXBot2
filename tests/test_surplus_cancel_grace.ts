/**
 * tests/test_surplus_cancel_grace.ts
 *
 * Regression tests for the surplus-cancel grace window
 * (TIMING.SURPLUS_CANCEL_GRACE_MS):
 *
 * Spread correction and surplus sweeps run on different count snapshots
 * within one cycle, so a fill landing between them could make the second
 * controller cancel what the first just placed (fee bleed + empty levels,
 * no net change). Freshly placed orders are therefore skipped by surplus
 * cancellation until the grace window expires.
 *
 * Covered:
 *  - isFreshlyPlacedOrder semantics (unknown, null, empty id, fresh, custom
 *    grace, aged-out, missing manager);
 *  - the correction drain holds fresh cancels back from BOTH the batched
 *    (correctAllPriceMismatches -> _batchCancelCorrections) and the serial
 *    (correctOrderPriceOnChain) paths, and older placements cancel normally.
 */
const assert = require('assert');
const {
    isFreshlyPlacedOrder,
    correctAllPriceMismatches,
} = require('../modules/order/utils/order');
const { TIMING, ORDER_TYPES } = require('../modules/constants');
const { makeLadderFromPrices } = require('./helpers/order_test_helpers');

let assertions = 0;
function check(name, actual, expected) {
    assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
    assertions++;
    console.log(`  ✓ ${name}`);
}

const fakeManager = (extra = {}) => ({ _placedAt: new Map(), ...extra });

console.log(' - Surplus-cancel grace...');
{
    const mgr = fakeManager();
    check('unknown id not fresh', isFreshlyPlacedOrder(mgr, '1.7.1'), false);
    check('null id not fresh', isFreshlyPlacedOrder(mgr, null), false);

    // The stamp writer is the lifecycle funnel; this manager-shaped double keeps
    // the fallback map the production facade also exposes.
    mgr._placedAt.set('1.7.1', Date.now());
    check('just placed is fresh', isFreshlyPlacedOrder(mgr, '1.7.1'), true);
    check('custom grace honored (5s)', isFreshlyPlacedOrder(mgr, '1.7.1', 5000), true);

    mgr._placedAt.set('1.7.1', Date.now() - 20 * 60 * 1000);
    check('aged out not fresh', isFreshlyPlacedOrder(mgr, '1.7.1'), false);

    check('empty id not fresh', isFreshlyPlacedOrder(mgr, ''), false);
    check('fresh test on missing manager safe', isFreshlyPlacedOrder(null, '1.7.1'), false);

    // Default grace is 15 minutes: a 10-minute-old stamp is still fresh.
    const live = fakeManager();
    live._placedAt.set('1.7.9', Date.now() - 10 * 60 * 1000);
    check('within default grace', isFreshlyPlacedOrder(live, '1.7.9'), true);
    check('default grace constant', TIMING.SURPLUS_CANCEL_GRACE_MS, 15 * 60 * 1000);
}

// --- correction drain: fresh cancels are held back from BOTH paths ---
// The per-entry check inside correctOrderPriceOnChain cannot protect the
// batched cancel path (_batchCancelCorrections), so the drain must filter
// fresh placements before batching too. Two cancel entries force canBatch.
async function runDrainGraceTests() {
    console.log(' - Correction drain grace (batch path)...');
    const ASSETS = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.861', precision: 5 } };
    const cancelEntry = (chainOrderId) => ({
        gridOrder: { id: 'slot-89' },
        chainOrderId,
        expectedPrice: 0.31,
        size: 1,
        type: ORDER_TYPES.SELL,
        isSurplus: true,
        cancelOnly: true,
        queuedAt: Date.now(),
        queuedBy: 'sync-duplicate-orphan',
    });
    const createManager = (queue, placedAt) => ({
        orders: new Map(),
        assets: ASSETS,
        ordersNeedingPriceCorrection: queue.map((e) => ({ ...e })),
        _lastUnmatchedChainOrders: [],
        _genesis: makeLadderFromPrices([0.3, 0.31, 0.32, 0.4]),
        boundaryIdx: 0,
        _gapSlots: 0,
        config: undefined,
        isBroadcastingActive: () => false,
        _gapEvacCancelQueued: new Set(),
        logger: { log: () => {} },
        _gridLock: { acquire: async (fn) => fn() },
        _placedAt: placedAt,
    });

    {
        const mgr = createManager([cancelEntry('1.7.111'), cancelEntry('1.7.112')], new Map());
        mgr._placedAt.set('1.7.111', Date.now());
        mgr._placedAt.set('1.7.112', Date.now());
        let opBuilds = 0;
        let serialCancels = 0;
        const accountOrders = {
            buildCancelOrderOp: async (_acct, id) => { opBuilds++; return { id }; },
            executeBatch: async () => ({}),
            cancelOrder: async () => { serialCancels++; return {}; },
        };
        const out = await correctAllPriceMismatches(mgr, 'acct', 'k', accountOrders);
        check('fresh cancels never reach the batch builder', opBuilds, 0);
        check('fresh cancels never reach the serial path', serialCancels, 0);
        check('fresh cancels stay queued', mgr.ordersNeedingPriceCorrection.length, 2);
        check('fresh skips are not counted corrected', out.corrected, 0);
    }

    // Control: aged placements are cancelled normally (batch path fires).
    {
        const placedAt = new Map();
        placedAt.set('1.7.121', Date.now() - 20 * 60 * 1000);
        placedAt.set('1.7.122', Date.now() - 20 * 60 * 1000);
        const mgr = createManager([cancelEntry('1.7.121'), cancelEntry('1.7.122')], placedAt);
        let opBuilds = 0;
        let batches = 0;
        const accountOrders = {
            buildCancelOrderOp: async (_acct, id) => { opBuilds++; return { id }; },
            executeBatch: async () => { batches++; return {}; },
            cancelOrder: async () => ({}),
        };
        const out = await correctAllPriceMismatches(mgr, 'acct', 'k', accountOrders);
        check('aged cancels reach the batch builder', opBuilds, 2);
        check('aged cancels broadcast', batches >= 1, true);
        check('aged cancels resolved', out.corrected, 2);
        check('aged cancels leave the queue', mgr.ordersNeedingPriceCorrection.length, 0);
    }
}

runDrainGraceTests()
    .then(() => {
        console.log(`\n✓ Surplus-cancel grace tests passed! (${assertions} assertions)`);
    })
    .catch((err) => {
        console.error('Test failed');
        console.error(err);
        process.exit(1);
    });

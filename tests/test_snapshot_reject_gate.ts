/**
 * tests/test_snapshot_reject_gate.ts
 *
 * Regression guard for the 2026-11-03 class: a valid grid snapshot was deleted
 * as "corrupted" while fills were still queued (drift == the queued fills), and
 * the following recovery did nothing. The destructive rejection must be gated
 * on a settled pipeline.
 *
 * Covered:
 *  1. queued fills → no snapshot deletion;
 *  2. batch in flight → no snapshot deletion;
 *  3. deferred rebalance / owed crawls → no snapshot deletion;
 *  4. settled pipeline + real drift → deletion still happens.
 */

const assert = require('assert');
const { rejectCorruptedGridSnapshot } = require('../modules/dexbot_state_recovery');

function makeBot({ queued = 0, batchInFlight = 0, deferredRebalance = 0, owedCrawls = 0, deferredFills = false } = {}) {
    const state = { cleared: 0, backedUp: 0, warnings: [] };
    const bot = {
        _incomingFillQueue: Array.from({ length: queued }, (_, i) => ({ key: `f${i}` })),
        _batchInFlight: batchInFlight,
        _deferredFillsPending: deferredFills,
        _warn: (message) => state.warnings.push(String(message)),
        _restoreBoundary: () => {},
        manager: {
            _deferredRebalanceAt: deferredRebalance,
            _pendingFillCrawls: Array.from({ length: owedCrawls }, () => ({ slotId: 'slot-1', side: 'buy', ts: Date.now() })),
            _clearPendingFillCrawls: () => {},
            _resetLastFillPivot: () => {},
            checkFundDriftAfterFills: () => ({ isValid: false, driftSell: 11.71, driftBuy: 8068.19 }),
            logger: { log: () => {} },
        },
        accountOrders: {
            backupSnapshot: async () => { state.backedUp++; return 'backup.json'; },
            clearGrid: async () => { state.cleared++; },
        },
    };
    return { bot, state };
}

async function expectSkipped(label, options) {
    const { bot, state } = makeBot(options);
    const rejected = await rejectCorruptedGridSnapshot(bot, 'recovery');
    assert.strictEqual(rejected, false, `${label}: snapshot must not be rejected`);
    assert.strictEqual(state.cleared, 0, `${label}: snapshot must not be deleted`);
    assert.strictEqual(state.backedUp, 0, `${label}: no backup/forensics work on a skipped check`);
    assert.ok(
        state.warnings.some((w) => w.includes('pipeline not settled')),
        `${label}: skip must be logged`
    );
}

async function runTests() {
    console.log('Running snapshot-reject pipeline gate tests...');

    console.log(' - 1. queued fills gate the destructive check...');
    await expectSkipped('queued fills', { queued: 2 });

    console.log(' - 2. batch in flight gates the destructive check...');
    await expectSkipped('batch in flight', { batchInFlight: 1 });

    console.log(' - 3. deferred rebalance / owed crawls gate the check...');
    await expectSkipped('deferred rebalance', { deferredRebalance: Date.now() });
    await expectSkipped('owed crawls', { owedCrawls: 1 });
    await expectSkipped('deferred fill drain', { deferredFills: true });

    console.log(' - 4. settled pipeline still rejects genuine drift...');
    {
        const { bot, state } = makeBot();
        const rejected = await rejectCorruptedGridSnapshot(bot, 'recovery');
        assert.strictEqual(rejected, true, 'settled pipeline must still reject genuine corruption');
        assert.strictEqual(state.cleared, 1, 'corrupted snapshot must be deleted');
        assert.strictEqual(state.backedUp, 1, 'pre-reject backup must still be kept');
    }

    console.log('\n✓ snapshot-reject gate tests PASSED!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('✗ snapshot-reject gate tests failed!');
    console.error(err);
    process.exit(1);
});

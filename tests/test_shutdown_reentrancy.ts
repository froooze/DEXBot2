/**
 * tests/test_shutdown_reentrancy.ts — Verifies DEXBot.shutdown() idempotency.
 *
 * Background: in production we observed a "double graceful shutdown" log pattern
 * where cleanup-loop + internal _runStartupSequence shutdown both called the
 * method within milliseconds. The fix adds a `_shuttingDown` guard at the
 * top of shutdown() so the second call waits for the in-flight shutdown.
 *
 * This test calls DEXBot.prototype.shutdown() on a minimal stub twice and
 * asserts the stub's "Initiating" log fires exactly once.
 */

'use strict';

const assert = require('assert');

console.log('=== Shutdown Reentrancy Tests ===\n');

(async () => {
    console.log(' - Testing shutdown() is idempotent: second call waits without running cleanup body...');
    {
        const DEXBot = require('../modules/dexbot_class').default;
        const logCalls = [];
        const warnCalls = [];
        const stopCalls = [];
        const lockAcquired = [];

        const stub = {
            _log: (msg) => logCalls.push(msg),
            _warn: (msg) => warnCalls.push(msg),
            _shuttingDown: false,
            _processedFillStore: {
                setShuttingDown: (v) => { stopCalls.push(['setShuttingDown', v]); },
            },
            // Methods called after the guard. They should be invoked exactly once
            // across both shutdown() calls; we use simple sentinels.
            _stopBlockchainFetchInterval: () => { stopCalls.push(['stopBlock', true]); },
            _clearDustMaintenanceTimer: () => { stopCalls.push(['clearDust', true]); },
            _stopCreditWatchdogInterval: () => { stopCalls.push(['stopCredit', true]); },
            _stopCredentialDaemonWatchdogInterval: () => { stopCalls.push(['stopCred', true]); },
            _flushProcessedFillPersistence: async (tag) => { stopCalls.push(['flush', tag]); },
            _stopOpenOrdersSyncLoop: async () => { stopCalls.push(['stopOpenOrders']); },
            _releaseMarketAdapterRuntime: async (tag) => { stopCalls.push(['release', tag]); },
            manager: {
                _fillProcessingLock: {
                    acquire: async (fn) => {
                        lockAcquired.push(true);
                        await fn();
                    },
                },
                persistGrid: async () => { stopCalls.push(['persistGrid']); },
            },
            accountOrders: {},
            config: { botKey: 'test-bot' },
            _incomingFillQueue: [],
            _creditRuntime: null,
            _fillsUnsubscribe: null,
            _reconnectUnregister: null,
            _triggerDebounceTimer: null,
            _deferredGridResyncTimer: null,
            _maintenanceIdleTimer: null,
            _credentialRecoveryDeferredTimer: null,
            _structuralGridResyncTimer: null,
            _triggerWatcher: null,
            getMetrics: () => ({
                fillsProcessed: 0,
                batchesExecuted: 0,
                fillProcessingTimeMs: 0,
                lockContentionEvents: 0,
                maxQueueDepth: 0,
                pipelineLivenessOk: false,
            }),
        };

        // Call shutdown twice — the second call must await the first shutdown via the guard.
        const p1 = DEXBot.prototype.shutdown.call(stub);
        const p2 = DEXBot.prototype.shutdown.call(stub);
        await Promise.all([p1, p2]);

        const initiateLogs = logCalls.filter((m) => m === 'Initiating graceful shutdown...');
        const skippedLogs = logCalls.filter((m) => m === 'Shutdown already in progress; ignoring re-entrant call');
        const blockStops = stopCalls.filter(([k]) => k === 'stopBlock');

        assert.strictEqual(initiateLogs.length, 1, 'shutdown body should run exactly once');
        assert.strictEqual(skippedLogs.length, 1, 'second call should log the re-entrant skip');
        assert.strictEqual(blockStops.length, 1, '_stopBlockchainFetchInterval should run exactly once');
        assert.strictEqual(lockAcquired.length, 1, 'fill-processing lock should be acquired exactly once');
        assert.ok(logCalls.some((m) => m.includes('pipelineLivenessOk=false')),
            'the operator-facing shutdown line must print pipeline liveness, not just the metrics object');
        assert.strictEqual(stub._shuttingDown, true, '_shuttingDown should be set after the first call');
        assert.strictEqual(stopCalls.filter(([k]) => k === 'setShuttingDown').length, 1,
            '_processedFillStore.setShuttingDown should be called exactly once');
    }

    console.log(' - Testing concurrent shutdown() calls wait for the first shutdown promise...');
    {
        const DEXBot = require('../modules/dexbot_class').default;
        const logCalls = [];

        // Slow down final persistence so the first call is still in-flight when
        // subsequent calls arrive. Re-entrant calls must not resolve until this
        // blocked shutdown work completes.
        let flushResolve = null;
        const stub = {
            _log: (msg) => logCalls.push(msg),
            _warn: () => {},
            _shuttingDown: false,
            _processedFillStore: { setShuttingDown: () => {} },
            _stopBlockchainFetchInterval: () => {},
            _clearDustMaintenanceTimer: () => {},
            _stopCreditWatchdogInterval: () => {},
            _stopCredentialDaemonWatchdogInterval: () => {},
            _flushProcessedFillPersistence: async () => new Promise((resolve) => {
                flushResolve = resolve;
            }),
            _stopOpenOrdersSyncLoop: async () => {},
            _releaseMarketAdapterRuntime: async () => {},
            manager: {
                _fillProcessingLock: { acquire: async (fn) => { await fn(); } },
                persistGrid: async () => {},
            },
            accountOrders: {},
            config: { botKey: 'concurrent-bot' },
            _incomingFillQueue: [],
            _creditRuntime: null,
            _fillsUnsubscribe: null,
            _reconnectUnregister: null,
            _triggerDebounceTimer: null,
            _deferredGridResyncTimer: null,
            _maintenanceIdleTimer: null,
            _credentialRecoveryDeferredTimer: null,
            _structuralGridResyncTimer: null,
            _triggerWatcher: null,
            getMetrics: () => ({
                fillsProcessed: 0, batchesExecuted: 0, fillProcessingTimeMs: 0,
                lockContentionEvents: 0, maxQueueDepth: 0,
            }),
        };

        // Fire 3 concurrent shutdown() calls. The first one should reach final
        // persistence and stall there. Calls 2 and 3 should hit the guard and
        // wait for the same in-flight shutdown work instead of resolving early.
        const p1 = DEXBot.prototype.shutdown.call(stub);
        const p2 = DEXBot.prototype.shutdown.call(stub);
        const p3 = DEXBot.prototype.shutdown.call(stub);
        let p2Settled = false;
        let p3Settled = false;
        p2.then(() => { p2Settled = true; });
        p3.then(() => { p3Settled = true; });

        // Yield a microtask to let the synchronous guard checks in p2/p3 run.
        await new Promise((resolve) => setImmediate(resolve));

        const initiate = logCalls.filter((m) => m === 'Initiating graceful shutdown...').length;
        const skipped = logCalls.filter((m) => m === 'Shutdown already in progress; ignoring re-entrant call').length;
        assert.strictEqual(initiate, 1, 'only the first call should run the body');
        assert.strictEqual(skipped, 2, 'calls 2 and 3 should be skipped via the guard');
        assert.strictEqual(p2Settled, false, 'second shutdown promise should wait for the in-flight shutdown');
        assert.strictEqual(p3Settled, false, 'third shutdown promise should wait for the in-flight shutdown');

        // Now let the first call finish and verify all three promises resolve.
        flushResolve();
        await Promise.all([p1, p2, p3]);
        assert.strictEqual(p2Settled, true, 'second shutdown promise should resolve after shutdown completes');
        assert.strictEqual(p3Settled, true, 'third shutdown promise should resolve after shutdown completes');
    }

    console.log('\n=== All shutdown reentrancy tests passed ===');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

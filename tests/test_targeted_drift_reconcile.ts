const assert = require('assert');

const MaintenanceRuntime = require('../modules/dexbot_maintenance_runtime');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

async function runTests() {
    console.log('Running Targeted Drift Reconcile Tests...');

    // Compiled ESM namespaces are frozen and require.cache injection cannot
    // intercept static ESM imports, so chainOrders/grid overrides are gone.
    // The readOpenOrders mock lives on a local plain object — the production
    // flow reaches it via ctx._syncOpenOrdersAndProcessFills (test-owned), and
    // monitorDivergence runs REAL against a persisted grid seeded to match the
    // live grid (loadGrid returns the same slots) so it computes no divergence.
    const chainOrders = {
        readOpenOrders: async (accountId) => {
            readOpenOrdersCalls++;
            assert.strictEqual(accountId, '1.2.345', 'targeted sync should read orders for the bot account');
            return [{ id: '1.7.9001' }];
        },
    };

    console.log(' - Testing active-order shortfall triggers open-order sync...');

    let readOpenOrdersCalls = 0;
    let synchronized = false;
    const orders = new Map();

        const ctx = {
            accountId: '1.2.345',
            account: { id: '1.2.345' },
            privateKey: 'test-key',
            config: {
                botKey: 'targeted-drift-test',
                dryRun: false,
                coreOrders: { buy: 1, sell: 0 },
                assetA: 'TEST',
                assetB: 'BTS',
            },
            manager: {
                orders,
                fetchAccountTotals: async () => {},
                recalculateFunds: async () => {},
                _clearStaleBroadcastFlag: () => {},
                clearStalePipelineOperations: () => {},
                isPipelineEmpty: () => ({ isEmpty: true, reasons: [] }),
                checkFundDriftAfterFills: () => ({ isValid: true, reason: 'ok' }),
                getOrdersByTypeAndState: (type, state) => {
                    return Array.from(orders.values()).filter(o => o && o.type === type && o.state === state);
                },
                synchronizeWithChain: async () => {
                    synchronized = true;
                    orders.set('slot-1', {
                        id: 'slot-1',
                        type: ORDER_TYPES.BUY,
                        state: ORDER_STATES.ACTIVE,
                        orderId: '1.7.9001',
                        price: 1,
                        size: 10,
                    });
                    return { filledOrders: [], unmatchedChainOrders: [] };
                },
                persistGrid: async () => ({ isValid: true }),
                checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
                checkSpreadCondition: async () => ({ ordersPlaced: 0 }),
            },
            accountOrders: {
                // Persisted grid mirrors the live grid so the REAL
                // monitorDivergence/compareGrids computes zero divergence.
                loadGrid: () => Array.from(orders.values()),
            },
            _targetedDriftSyncCooldownMs: 60_000,
            _lastTargetedDriftSyncAt: 0,
            _incomingFillQueue: [],
            _batchInFlight: 1,
            _lightweightSyncCheckAt: Date.now(),
            _recoverySyncInFlight: 0,
            _dustSinceMap: new Map(),
            _getPipelineSignals: () => ({
                incomingFillQueueLength: 0,
                shadowLocks: 0,
                batchInFlight: false,
                recoveryInFlight: false,
                broadcasting: false,
            }),
            _processFillsWithBatching: async () => ({ aborted: false }),
            _syncOpenOrdersAndProcessFills: async function (_tag) {
                const openOrders = await chainOrders.readOpenOrders(this.accountId);
                const syncResult = await (this.manager.synchronizeWithChain as any)(openOrders, 'readOpenOrders');
                return { syncResult, aborted: false, hasUnmatched: 0 };
            },
            _executeBatchIfNeeded: async () => ({ executed: false }),
            updateOrdersOnChainPlan: async () => ({ executed: false }),
            updateOrdersOnChainBatch: async () => ({ executed: false }),
            _cancelDustOrders: async () => ({ cancelledCount: 0, batchResult: null }),
            _abortFlowIfIllegalState: async () => false,
            _persistAndRecoverIfNeeded: async () => {},
            _log: () => {},
            _warn: () => {},
        };

        await MaintenanceRuntime.executeMaintenanceLogic(ctx, 'targeted-test');

        assert.strictEqual(readOpenOrdersCalls, 1, 'shortfall should trigger one open-order fetch');
        assert.strictEqual(synchronized, true, 'shortfall should synchronize from chain truth');
        assert.strictEqual(orders.get('slot-1').orderId, '1.7.9001', 'sync should restore the live order into the grid');

    // Pure fund-driven spread correction: when it finds no free funds it sets
    // _spreadStallArmed; the next tick's targeted-sync gate must refresh
    // account totals + open orders from that flag (the only fallback). The gate
    // reports the exact stall cause now, and EVERY cause — including a
    // structural 'no-candidates' stall — must arm the refresh so a stale local
    // snapshot is synced rather than left to the 30min staleness watchdog.
    console.log(' - Testing funds-exhausted spread fallback trigger...');
    {
        const makeBot = (exhausted: boolean, stall: string | null = null) => ({
            config: { dryRun: false, coreOrders: { buy: 0, sell: 0 } },
            manager: { checkFundDriftAfterFills: () => ({ isValid: true, reason: 'ok' }) },
            _spreadStallArmed: exhausted,
            _spreadCorrectionStall: stall,
        });
        const reason = MaintenanceRuntime.getTargetedSyncReason(makeBot(true, 'funds-exhausted'));
        assert(reason, 'funds-exhausted flag must produce a targeted sync reason');
        assert(/spread correction stalled \(funds-exhausted\)/.test(reason.reason),
            `reason must name the stall cause, got: ${reason.reason}`);
        const unfunded = MaintenanceRuntime.getTargetedSyncReason(makeBot(true, 'unfunded'));
        assert(/spread correction stalled \(unfunded\)/.test(unfunded.reason),
            `reason must name the unfunded cause, got: ${unfunded.reason}`);
        // A structural stall still arms the refresh: the local snapshot may be
        // stale (a missed fill hides the tightening slot), and only a chain sync
        // can distinguish that from real geometry. The gate must not stay shut.
        const noCandidates = MaintenanceRuntime.getTargetedSyncReason(makeBot(true, 'no-candidates'));
        assert(noCandidates, 'a no-candidates stall must arm the targeted sync');
        assert(/spread correction stalled \(no-candidates\)/.test(noCandidates.reason),
            `reason must name the no-candidates cause, got: ${noCandidates.reason}`);
        assert.strictEqual(MaintenanceRuntime.getTargetedSyncReason(makeBot(false)), null,
            'cleared flag must not trigger a refresh');

        // The maintenance mirror must arm the flag for EVERY stall cause. This
        // is the regression guard for the stale-order-state case: a
        // 'no-candidates' result (phantom ACTIVE slot hiding the tightening
        // slot) previously left the refresh disarmed and waited for the watchdog.
        const mirrorBot: any = { _spreadStallArmed: false, _spreadCorrectionStall: null };
        for (const cause of ['no-free-funds', 'unfunded', 'no-candidates', 'batch-not-executed', 'apply-error']) {
            MaintenanceRuntime.mirrorSpreadStall(mirrorBot, cause);
            assert.strictEqual(mirrorBot._spreadStallArmed, true,
                `mirrorSpreadStall must arm the refresh for '${cause}'`);
            assert.strictEqual(mirrorBot._spreadCorrectionStall, cause,
                `mirrorSpreadStall must keep the companion cause '${cause}'`);
        }
        MaintenanceRuntime.mirrorSpreadStall(mirrorBot, null);
        assert.strictEqual(mirrorBot._spreadStallArmed, false,
            'a cleared stall must disarm the refresh');
        assert.strictEqual(mirrorBot._spreadCorrectionStall, null,
            'a cleared stall must clear the companion cause');
    }

    // Option (a): the funds-exhausted trigger is a REFRESH, not a standing
    // reconcile. After a successful sync the flag must clear (a stale-read
    // shortfall the refresh resolves must not force a reconcile); if the sync
    // ABORTS the flag must stay set so the next tick retries. Both halves are
    // asserted here because "aborted retains the flag" is otherwise guaranteed
    // only by statement order (the early return precedes the clear), which a
    // later refactor can silently break.
    console.log(' - Testing funds-exhausted refresh clears on success, retains on abort...');
    {
        const makeRefreshBot = (aborted: boolean) => {
            const state = { syncCalls: 0 };
            const bot = {
                accountId: '1.2.345',
                config: { dryRun: false, coreOrders: { buy: 0, sell: 0 } },
                manager: {
                    fetchAccountTotals: async () => {},
                    checkFundDriftAfterFills: () => ({ isValid: true, reason: 'ok' }),
                    persistGrid: async () => {},
                },
                _spreadStallArmed: true,
                _spreadCorrectionStall: 'unfunded',
                _targetedDriftSyncCooldownMs: 0,
                _lastTargetedDriftSyncAt: 0,
                _log: () => {},
                _warn: () => {},
                _syncOpenOrdersAndProcessFills: async () => {
                    state.syncCalls++;
                    return { syncResult: { unmatchedChainOrders: [] }, openOrders: [], aborted };
                },
            };
            return { bot, state };
        };

        const { bot: ok, state: okState } = makeRefreshBot(false);
        const ran = await MaintenanceRuntime.maybeRunTargetedDriftReconciliation(ok, 'test');
        assert.strictEqual(ran, true, 'refresh must run for the funds-exhausted trigger');
        assert.strictEqual(okState.syncCalls, 1, 'refresh must fetch open orders exactly once');
        assert.strictEqual(ok._spreadStallArmed, false,
            'a successful refresh must clear the funds-exhausted flag so the reconcile is conditional');
        assert.strictEqual(ok._spreadCorrectionStall, null,
            'a successful refresh must also clear the companion stall cause');
        assert(ok._lastTargetedDriftSyncAt > 0, 'a successful refresh must stamp the cooldown');

        const { bot: abort, state: abortState } = makeRefreshBot(true);
        const ranAbort = await MaintenanceRuntime.maybeRunTargetedDriftReconciliation(abort, 'test');
        assert.strictEqual(ranAbort, false, 'aborted sync must not report a completed refresh');
        assert.strictEqual(abortState.syncCalls, 1, 'aborted refresh must still have attempted the sync');
        assert.strictEqual(abort._spreadStallArmed, true,
            'an aborted refresh must retain the funds-exhausted flag so the next tick retries');
        assert.strictEqual(abort._spreadCorrectionStall, 'unfunded',
            'an aborted refresh must retain the stall cause with the flag');
        assert.strictEqual(abort._lastTargetedDriftSyncAt, 0,
            'an aborted refresh must not stamp the cooldown (retry must not be locked out)');
    }

    // The grid-blocked escalation counter is a CONSECUTIVE-cycle counter. A tick
    // with no targeted trigger never evaluates the gate, so it must clear the
    // counter — otherwise a counter parked at the escalation limit makes the
    // first unreadable cycle later fire a structural resync immediately instead
    // of waiting the full window (docs/FILL_PIPELINE.md B1).
    console.log(' - Testing a trigger-less tick resets the blocked-cycle counter...');
    {
        const bot: any = {
            config: { dryRun: false, coreOrders: { buy: 0, sell: 0 } },
            manager: {
                checkFundDriftAfterFills: () => ({ isValid: true, reason: 'ok' }),
                _gridUpdateBlockedCycles: 12,
            },
            _spreadStallArmed: false,
            _spreadCorrectionStall: null,
            _log: () => {},
            _warn: () => {},
        };
        const ran = await MaintenanceRuntime.maybeRunTargetedDriftReconciliation(bot, 'test');
        assert.strictEqual(ran, false, 'a healthy bot must not run a reconcile');
        assert.strictEqual(bot.manager._gridUpdateBlockedCycles, 0,
            'a trigger-less tick must reset the consecutive blocked-cycle counter');
    }

    console.log('✓ Targeted drift reconcile tests passed!');
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});

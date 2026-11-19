/**
 * tests/test_accounting_logic.ts
 *
 * Comprehensive unit tests for accounting.ts - Fund tracking and calculations
 * Uses native assert to avoid Jest dependency.
 *
 * Runs as two esm-mock stages: 'core' exercises in-memory accounting, while
 * 'recovery-reads' mocks the bitshares_client transport via loader hooks so
 * _performStateRecovery runs against the real chain_orders guarded read
 * (the compiled chain_orders namespace itself cannot be patched).
 */

const assert = require('assert');
const { runEsmMockStages } = require('./helpers/esm_mocks');

function seedFeeCache() {
    // Fee cache seam: getAssetFees computes deterministic fees from these
    // fixtures (createFee 0.1 → netFee 0.01, updateFee 0.001) instead of the
    // old frozen-namespace OrderUtils.getAssetFees patch.
    const { _setFeeCache } = require('../modules/order/utils/math');
    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderUpdate: { bts: 0.001 },
            limitOrderCancel: { bts: 0 }
        }
    });
}

async function runCoreTests() {
    seedFeeCache();
    const { OrderManager } = require('../modules/order/index').default;
    const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../modules/constants');
    const { createSilentLogger } = require('./helpers/silent_logger');
    const { getErrorMessage } = require('../modules/utils/errors');

     console.log('Running Accountant Logic Tests...');

     const createManager = async () => {
         const mgr = new OrderManager({
             market: 'TEST/BTS',
             assetA: 'TEST',
             assetB: 'BTS',
             weightDistribution: { sell: 0.5, buy: 0.5 },
             coreOrders: { buy: 5, sell: 5 }
         });
         mgr.logger = createSilentLogger();
         await mgr.setAccountTotals({
             buy: 10000,
             sell: 100,
             buyFree: 10000,
             sellFree: 100
         });
         return mgr;
     };

     // Test: resetFunds()
     console.log(' - Testing resetFunds()...');
     {
         const manager = await createManager();
         await manager.resetFunds();
         assert(manager.funds !== undefined, 'funds should be defined');
         assert.strictEqual(manager.funds.available.buy, 0);
         assert.strictEqual(manager.funds.available.sell, 0);
         assert.strictEqual(manager.funds.committed.chain.buy, 0);
         assert.strictEqual(manager.funds.virtual.buy, 0);
     }

     // Test: recalculateFunds()
     console.log(' - Testing recalculateFunds()...');
     {
         const manager = await createManager();
        await manager._updateOrder({
            id: 'virtual-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            size: 500,
            price: 100
        });
        assert.strictEqual(manager.funds.virtual.buy, 500);

        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 25,
            price: 100,
            orderId: 'chain-001'
        });
        assert.strictEqual(manager.funds.committed.chain.sell, 25);
    }

    // Test: Multiple orders summing
     console.log(' - Testing multiple orders summing...');
     {
         const manager = await createManager();
         manager.pauseFundRecalc();
          await manager._updateOrder({ id: 'b1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
          await manager._updateOrder({ id: 'b2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 200 });
          await manager._updateOrder({ id: 'b3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 150, orderId: 'c1' });
          await manager.resumeFundRecalc();

         assert.strictEqual(manager.funds.virtual.buy, 300);
         assert.strictEqual(manager.funds.committed.grid.buy, 150);
         assert.strictEqual(manager.funds.total.grid.buy, 450);
     }

    // Test: Invariant chainTotal = chainFree + chainCommitted
    console.log(' - Testing chainTotal invariant...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'o1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 1000,
            orderId: 'c1'
        });

        const { buy: chainTotal } = manager.funds.total.chain;
        const { buy: chainFree } = manager.accountTotals;
        const { buy: chainCommitted } = manager.funds.committed.chain;

        assert(Math.abs(chainTotal - (chainFree + chainCommitted)) < 0.01, 'Invariant failed: chainTotal != chainFree + chainCommitted');
    }

    // Test: Precision
    console.log(' - Testing precision...');
    {
        const manager = await createManager();
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'p1', type: ORDER_TYPES.BUY, size: 123.456789, price: 100, state: ORDER_STATES.VIRTUAL });
        await manager._updateOrder({ id: 'p2', type: ORDER_TYPES.BUY, size: 987.654321, price: 99, state: ORDER_STATES.VIRTUAL });
        await manager.resumeFundRecalc();

        const expected = 123.456789 + 987.654321;
        assert(Math.abs(manager.funds.virtual.buy - expected) < 0.00000001);
    }

    // Test: PARTIAL -> ACTIVE Transition Bug Fix
    console.log(' - Testing PARTIAL -> ACTIVE transition bug fix...');
    {
        const manager = await createManager();
        const oldOrder = {
            id: 'p-fix',
            state: ORDER_STATES.PARTIAL,
            type: ORDER_TYPES.BUY,
            size: 100,
            price: 100
        };
        const newOrder = {
            id: 'p-fix',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            price: 100,
            orderId: 'c-new'
        };

        const buyFreeBefore = manager.accountTotals.buyFree;
        await manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test');
        const buyFreeAfter = manager.accountTotals.buyFree;

        assert.strictEqual(buyFreeBefore - buyFreeAfter, 0, 'Should not deduct again if already PARTIAL');
    }

    // Test: Manual Fund Override Protection (pauseFundRecalcDepth flag)
    console.log(' - Testing manual fund override protection via pauseFundRecalc...');
    {
        const manager = await createManager();
        await manager.resetFunds();

        // Manually override fund values
        const manualAvailable = 5000;
        manager.funds.available.buy = manualAvailable;

        // While paused, add orders that would normally trigger recalculateFunds
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'override-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
        await manager._updateOrder({ id: 'override-2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 200 });
        await manager._updateOrder({ id: 'override-3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 150, orderId: 'c-override' });

        // Verify manual value is NOT overwritten while paused
        assert.strictEqual(
            manager.funds.available.buy,
            manualAvailable,
            `Manual fund override should be preserved while paused (expected ${manualAvailable}, got ${manager.funds.available.buy})`
        );

        // Resume and verify recalculateFunds NOW applies
        await manager.resumeFundRecalc();
        const expectedVirtual = 300; // 100 + 200
        assert.strictEqual(
            manager.funds.virtual.buy,
            expectedVirtual,
            `After resume, virtual funds should be recalculated (expected ${expectedVirtual}, got ${manager.funds.virtual.buy})`
        );
    }

    // Test: Missing fee cache must not crash fill accounting (fallback to raw proceeds)
    console.log(' - Testing fill accounting fee-cache fallback...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const rawReceives = 2.5;

        try {
            await manager.accountant.processFillAccounting({
                pays: { asset_id: '1.3.1', amount: 100000 },
                receives: { asset_id: '1.3.0', amount: 250000 }
            });
        } catch (err) {
            assert.fail('processFillAccounting should tolerate missing fee cache and continue: ' + getErrorMessage(err));
        }

        assert.strictEqual(manager.accountTotals.sell, sellTotalBefore + rawReceives, 'Sell total should credit raw proceeds when fee lookup fails');
    }

    console.log(' - Testing manager owns processed fill tracker before bot wiring...');
    {
        const manager = await createManager();
        assert.strictEqual(manager.processedFillTracker instanceof Map, true, 'OrderManager should own a shared processed fill tracker by default');
        assert.strictEqual(manager.accountant.manager.processedFillTracker, manager.processedFillTracker, 'Accountant should use the manager-owned processed fill tracker');
    }

    console.log(' - Testing keyed fill accounting deduplicates duplicate credits...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const fillOp = {
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        };
        const fillKey = '1.7.123:999:1.11.555';

        await manager.accountant.processFillAccounting(fillOp, fillKey);
        await manager.accountant.processFillAccounting(fillOp, fillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'Duplicate keyed fill should only credit proceeds once'
        );
    }

    console.log(' - Testing keyed fill replay stays blocked beyond burst dedupe window...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const fillOp = {
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        };
        const fillKey = '1.7.123:999:1.11.556';

        await manager.accountant.processFillAccounting(fillOp, fillKey);
        manager.accountant.manager.processedFillTracker.set(fillKey, Date.now() - (TIMING.FILL_DEDUPE_WINDOW_MS + 1000));
        await manager.accountant.processFillAccounting(fillOp, fillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'Replay should stay blocked after the short burst dedupe window expires'
        );
    }

    console.log(' - Testing invalid keyed fill does not block later valid retry...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const retryFillKey = '1.7.124:1000:1.11.556';

        await manager.accountant.processFillAccounting({
            pays: { asset_id: '1.3.1', amount: 100000 }
        }, retryFillKey);

        await manager.accountant.processFillAccounting({
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        }, retryFillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'A no-op keyed fill attempt must not poison a later valid retry'
        );
    }

    console.log(' - Testing keyed fill retry survives post-validation failure before tracker write...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const originalAdjustTotalBalance = manager.accountant.adjustTotalBalance.bind(manager.accountant);
        const sellTotalBefore = manager.accountTotals.sell;
        const retryFillKey = '1.7.125:1001:1.11.557';
        const fillOp = {
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        };

        manager.accountant.adjustTotalBalance = () => {
            throw new Error('forced post-validation failure');
        };

        await assert.rejects(
            manager.accountant.processFillAccounting(fillOp, retryFillKey),
            /forced post-validation failure/,
            'Expected injected failure after fill validation'
        );
        assert.strictEqual(
            manager.accountant.manager.processedFillTracker.has(retryFillKey),
            false,
            'Failed accounting attempt must not poison the fill key'
        );

        manager.accountant.adjustTotalBalance = originalAdjustTotalBalance;
        await manager.accountant.processFillAccounting(fillOp, retryFillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'Retry after post-validation failure should still credit the fill once'
        );
    }

    // Test: Recovery retry cooldown and reset behavior
    console.log(' - Testing recovery retry cooldown and reset...');
    {
        const manager = await createManager();
        const originalRecovery = manager.accountant._performStateRecovery;
        let attempts = 0;

        manager.accountant._performStateRecovery = async () => {
            attempts += 1;
            return { isValid: false, reason: 'forced failure' };
        };

        const first = await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(first, false, 'First forced recovery should fail');
        assert.strictEqual(manager._recoveryState.attemptCount, 1, 'Attempt count should increment after first try');

        const second = await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(second, false, 'Second immediate attempt should be blocked by cooldown');
        assert.strictEqual(manager._recoveryState.attemptCount, 1, 'Cooldown-blocked attempt must not increment attempt count');

        manager._recoveryState = { ...manager._recoveryState, lastAttemptAt: Date.now() - 61000 };
        await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(manager._recoveryState.attemptCount, 2, 'Attempt count should increment after cooldown expires');
        assert.strictEqual(attempts >= 2, true, 'Recovery should have executed at least twice after cooldown expiry');

        manager.accountant._performStateRecovery = async () => ({ isValid: true, reason: null });
        manager._recoveryState = { ...manager._recoveryState, lastAttemptAt: Date.now() - 61000 };
        const success = await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(success, true, 'Successful recovery should return true');
        // NOTE: Successful recovery does NOT reset attempt count immediately.
        // This prevents infinite "attempt 1/5" loops when fund invariants are violated
        // but sync "succeeds" (no errors) without actually fixing the invariant.
        // The counter is reset by:
        // 1. resetRecoveryState() called at start of each periodic fetch cycle
        // 2. Decay logic if enough time passes without violations
        assert.strictEqual(manager._recoveryState.attemptCount, 3, 'Successful recovery should NOT reset attempt count (counter is 3 from previous attempts)');

        manager.accountant._performStateRecovery = originalRecovery;
    }

    // Test: recovery exhaustion is re-armed by a genuinely new fill, not by replays
    // Mutation: remove `this.rearmRecoveryAfterNewFill(fillKey)` in
    // processFillAccounting's `return true` path → the first assertion below fails.
    console.log(' - Testing recovery exhaustion re-arm on new fill credit...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };
        (manager.config as any).pipelineTiming = {
            RECOVERY_RETRY_INTERVAL_MS: 0,
            MAX_RECOVERY_ATTEMPTS: 5
        };
        manager.accountant._performStateRecovery = async () => ({ isValid: false, reason: 'forced failure' });
        // The max-attempt branch is evaluated on entry, so the 6th check sees
        // a budget already consumed by 5 failed attempts.
        for (let i = 0; i < 6; i++) {
            await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        }
        assert.ok(manager._recoveryExhaustedAt, 'Consumed attempt budget must set the exhausted gate');
        assert.strictEqual(manager.accountant.isRecoveryExhausted(), true, 'Gate owner must report exhausted');

        const fillKey = '1.7.999:1234:1.11.888';
        const fillOp = {
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        };
        const credited = await manager.accountant.processFillAccounting(fillOp, fillKey);
        assert.strictEqual(credited, true, 'Fresh fill must be credited');
        assert.strictEqual(manager._recoveryExhaustedAt, null, 'New fill credit must clear the exhausted gate');
        assert.strictEqual(manager.accountant.isRecoveryExhausted(), false, 'Gate owner must report re-armed');
        assert.strictEqual(manager._recoveryState.attemptCount, 0, 'A new episode must reset the attempt budget (no flapping)');

        // Replay of the SAME key must not re-arm: dedupe returns false before the hook.
        manager._recoveryExhaustedAt = Date.now();
        const replayed = await manager.accountant.processFillAccounting(fillOp, fillKey);
        assert.strictEqual(replayed, false, 'Same fill key must be rejected as a duplicate');
        assert.ok(manager._recoveryExhaustedAt, 'Replay must NOT clear the exhausted gate');
    }

    // Test: recalibration runs on an empty read (all-filled account)
    console.log(' - Testing fund recalibration on empty chain read...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'stuck-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 25,
            price: 100,
            orderId: '1.7.9'
        });
        // Stuck (not fresh): backdate the assign stamp past the lag-guard
        // window — _updateOrder stamps _orderIdAssignedAt with now(), which
        // would (correctly) protect a just-placed order.
        manager._orderIdAssignedAt.set('1.7.9', Date.now() - TIMING.SYNC_LOCK_TIMEOUT_MS - 1000);
        const result = await (manager.accountant as any)._recalibrateTrackedFundsFromChain(manager, []);
        assert.strictEqual(result.virtualized, 1, 'Stale ACTIVE slot must be virtualized on an empty (all-filled) read');
        const slot = manager.orders.get('stuck-1');
        assert.strictEqual(slot.state, ORDER_STATES.VIRTUAL, 'Stale slot must become VIRTUAL');
        assert.ok(!slot.orderId, 'Virtualized slot must clear its orderId');
    }

    // Test: recalibration never virtualizes an unparseable live order
    console.log(' - Testing fund recalibration skips malformed live orders...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'live-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 25,
            price: 100,
            orderId: '1.7.5'
        });
        // sell_price missing → parseChainOrder yields null: the order is live
        // but unreadable (unknown ≠ absent). Backdate the assign stamp so the
        // slot is NOT guard-protected — without the malformed-order skip it
        // would be virtualized here.
        manager._orderIdAssignedAt.set('1.7.5', Date.now() - TIMING.SYNC_LOCK_TIMEOUT_MS - 1000);
        const malformed = [{ id: '1.7.5', for_sale: 100 }];
        const result = await (manager.accountant as any)._recalibrateTrackedFundsFromChain(manager, malformed);
        assert.strictEqual(result.virtualized, 0, 'Unparseable live order must never be virtualized');
        const slot = manager.orders.get('live-1');
        assert.strictEqual(slot.state, ORDER_STATES.ACTIVE, 'Slot with unparseable live order must stay ACTIVE');
        assert.strictEqual(slot.orderId, '1.7.5', 'Slot must keep its orderId');
    }

    // Test: deferred-but-live chain orphans count as committed (no phantom drift)
    console.log(' - Testing unmatched-orphan committed accounting...');
    {
        const manager = await createManager();
        manager.pauseFundRecalc();
        await manager._updateOrder({
            id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 90, orderId: '1.7.10'
        });
        await manager._updateOrder({
            id: 'slot-9', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
            size: 25, price: 110, orderId: '1.7.11'
        });
        // Two deferred orphans the last sync saw live without grid slots:
        // an out-of-grid buy (quote size) and an out-of-grid sell (base size).
        (manager as any)._lastUnmatchedChainOrders = [
            { chainOrderId: '1.7.800', type: ORDER_TYPES.BUY, price: 70, size: 50 },
            { chainOrderId: '1.7.801', type: ORDER_TYPES.SELL, price: 200, size: 7 },
        ];
        // Totals consistent with the orphan-inclusive expectation so the
        // invariant check stays quiet: buy 9850 + (100 + 50), sell 68 + (25 + 7).
        await manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 9850, sellFree: 68 });
        await manager.resumeFundRecalc();
        assert.strictEqual(manager.funds.committed.chain.buy, 150, 'chain committed buy = grid active (100) + orphan (50)');
        assert.strictEqual(manager.funds.committed.chain.sell, 32, 'chain committed sell = grid active (25) + orphan (7)');
        assert.strictEqual(manager.funds.committed.grid.buy, 100, 'grid committed excludes orphans');
        assert.strictEqual(manager.funds.committed.grid.sell, 25, 'grid committed excludes orphans');
        // Stale/garbage entries never corrupt the sums.
        manager.pauseFundRecalc();
        (manager as any)._lastUnmatchedChainOrders = [
            { chainOrderId: '1.7.802', type: ORDER_TYPES.BUY, price: 70, size: 0 },
            { chainOrderId: '1.7.803', type: 'nonsense', price: 1, size: 9 },
            null,
        ];
        await manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 9900, sellFree: 75 });
        await manager.resumeFundRecalc();
        assert.strictEqual(manager.funds.committed.chain.buy, 100, 'zero-size and untyped orphans ignored (buy)');
        assert.strictEqual(manager.funds.committed.chain.sell, 25, 'zero-size and untyped orphans ignored (sell)');
    }

    console.log('✓ Accountant logic tests passed!');
}

async function runRecoveryReadTests() {
    // The recovery read goes through chain_orders' frozen ESM namespace, so
    // the bitshares_client transport is mocked at the loader level and the
    // real readOpenOrdersGuarded logic drives _performStateRecovery.
    const { defineEsmMockAbs } = require('./helpers/esm_mocks');

    let fullAccountsResponse: any = null;
    const bitsharesClientPath = require.resolve('../modules/bitshares_client');
    const bitsharesClientMock: Record<string, unknown> = {
        BitShares: {
            db: {
                get_full_accounts: async () => fullAccountsResponse,
            },
        },
        createAccountClient: () => ({ sign: () => {}, broadcast: async () => ({}) }),
        waitForConnected: async () => {},
        getConnectionStatus: () => ({ connected: true }),
        disconnectClient: async () => {},
        reconnectForCycle: async () => {},
        setSuppressConnectionLog: () => {},
        onReconnect: () => () => {},
        withTimeout: (p: any) => p,
        _assessFailover: () => null,
        getNodeManager: () => ({ getHealthyNodes: () => [] }),
        getNodeStats: () => null,
        getNodeSummary: () => null,
        getConnectionError: () => null,
        _internal: { get connected() { return false; } },
    };
    defineEsmMockAbs(bitsharesClientPath, Object.keys(bitsharesClientMock), bitsharesClientMock);

    seedFeeCache();
    const { OrderManager } = require('../modules/order/index').default;
    const { createSilentLogger } = require('./helpers/silent_logger');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            weightDistribution: { sell: 0.5, buy: 0.5 },
            coreOrders: { buy: 5, sell: 5 }
        });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 10000,
            sellFree: 100
        });
        return mgr;
    };

    console.log(' - [recovery-reads] Testing recovery sync uses skipAccounting=true...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.345';

        const stubOrders = [{ id: '1.7.1', sell_price: { base: { amount: 100, asset_id: '1.3.0' }, quote: { amount: 100, asset_id: '1.3.121' } }, for_sale: 100, expiration: '2099-01-01T00:00:00' }];
        fullAccountsResponse = [['1.2.345', { limit_orders: stubOrders, more_data_available: { limit_orders: false } }]];

        let capturedSyncOptions = null;
        // Recovery verifies the fetch actually refreshed accountTotals
        // (_lastFetchedAt advanced) before trusting the balances — a no-op
        // fetch stub must simulate the refresh stamp.
        manager.fetchAccountTotals = async () => {
            manager.accountTotals = { ...(manager.accountTotals || {}), _lastFetchedAt: Date.now() };
        };
        manager.syncFromOpenOrders = async (_orders, options) => {
            capturedSyncOptions = options;
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        };

        const result = await manager.accountant._performStateRecovery(manager);
        assert.strictEqual(typeof result.isValid, 'boolean', 'Recovery should return validation result');
        assert.strictEqual(capturedSyncOptions?.skipAccounting, true,
            'Recovery sync must use skipAccounting=true to avoid double-counting');
    }

    console.log(' - [recovery-reads] Testing recovery skips sync on empty/truncated read...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.345';

        fullAccountsResponse = [['1.2.345', { limit_orders: [], more_data_available: { limit_orders: false } }]];

        let syncCalled = false;
        manager.fetchAccountTotals = async () => {
            manager.accountTotals = { ...(manager.accountTotals || {}), _lastFetchedAt: Date.now() };
        };
        manager.syncFromOpenOrders = async () => { syncCalled = true; };

        const result = await manager.accountant._performStateRecovery(manager);
        assert.strictEqual(syncCalled, false,
            'Empty read is ambiguous — recovery sync must be skipped (node may be lagging; pass-1 phantom cleanup would virtualize live slots)');
        assert.strictEqual(result.isValid, false, 'Skipped recovery must report an invalid/deferred validation result');
    }

    console.log('✓ Recovery read tests passed!');
}

runEsmMockStages(['core', 'recovery-reads'], async (stage) => {
    if (stage === 'core') {
        await runCoreTests();
    } else {
        await runRecoveryReadTests();
    }
});

/**
 * tests/test_fill_transition_idempotency.ts
 *
 * Regression guard for the 2026-11-03 double-applied partial fill:
 * sync pass 1 reduced slot-137 3.6604 -> 3.3046 from a post-fill open-orders
 * snapshot, then the fill-history batch subtracted the same 0.3558 fill again
 * (3.3046 -> 2.9488), double-shrinking the order and over-crediting free funds.
 *
 * The transition must use the observed chain size directly when the pass-1
 * marker says the snapshot already includes the fill, and must not rewrite
 * rawOnChain.for_sale with a second subtraction.
 */

const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const assets = {
    assetA: { id: '1.3.0', symbol: 'BASE', precision: 4 },
    assetB: { id: '1.3.1', symbol: 'QUOTE', precision: 4 },
};

function makeManager() {
    return {
        assets,
        config: { assetA: 'BASE', assetB: 'QUOTE' },
        logger: { log: () => {} },
        _pendingFillCrawls: [],
        orders: new Map(),
    };
}

function makeParams(overrides = {}) {
    return {
        matchedGridOrder: {
            id: 'slot-137',
            orderId: '1.7.137',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            price: 100,
            size: 3.3046,
            rawOnChain: { for_sale: '33046' },
        },
        orderType: ORDER_TYPES.SELL,
        precision: 4,
        filledAmount: 0.3558,
        filledAmountInt: 3558,
        currentSizeIntFromGrid: 33046,
        rawForSaleInt: 33046,
        chainRefetched: false,
        chainConfirmsEmpty: false,
        effectiveRawForSale: 33046,
        isMaker: true,
        ...overrides,
    };
}

async function runTests() {
    console.log('Running fill-transition idempotency tests...');
    const engine = new SyncEngine();

    console.log(' - 1. pass-1 already applied: size and rawOnChain are not reduced twice...');
    {
        const result = await engine._computeFillTransitionResult(makeManager(), makeParams({ alreadyAppliedChainSize: true }));
        assert.strictEqual(result.isFull, false, 'a residual fill is not a full fill');
        assert.ok(
            Math.abs(Number(result.partialUpdate.size) - 3.3046) < 1e-9,
            `remaining size must stay 3.3046, got ${result.partialUpdate.size}`
        );
        assert.strictEqual(
            String(result.partialUpdate.rawOnChain.for_sale), '33046',
            'rawOnChain.for_sale must not be decremented twice'
        );
    }

    console.log(' - 2. no pass-1 marker: normal fill still subtracts once...');
    {
        const result = await engine._computeFillTransitionResult(makeManager(), makeParams({ alreadyAppliedChainSize: false }));
        assert.ok(
            Math.abs(Number(result.partialUpdate.size) - 2.9488) < 1e-9,
            `normal path must subtract the fill once, got ${result.partialUpdate.size}`
        );
        assert.strictEqual(
            String(result.partialUpdate.rawOnChain.for_sale), '29488',
            'normal path decrements rawOnChain once'
        );
    }

    console.log(' - 3. manager marker accumulates and consumes partially (split/aggregated fills)...');
    {
        const { OrderManager } = require('../modules/order/index').default;
        const mgr = new OrderManager({
            assetA: 'BASE', assetB: 'QUOTE', startPrice: 100, minPrice: 50, maxPrice: 200,
            incrementPercent: 10, targetSpreadPercent: 10,
            botFunds: { buy: 1000, sell: 10 }, coreOrders: { buy: 2, sell: 2 },
        });
        mgr.noteChainSizeAppliedFill('1.7.137', 3558);
        mgr.noteChainSizeAppliedFill('1.7.137', 3558);
        assert.strictEqual(mgr.consumeChainSizeAppliedFillAmount('1.7.137', 3558), 3558, 'first split fill consumes its share');
        assert.strictEqual(mgr.consumeChainSizeAppliedFillAmount('1.7.137', 3558), 3558, 'second split fill consumes the remainder');
        assert.strictEqual(mgr.consumeChainSizeAppliedFillAmount('1.7.137', 3558), 0, 'marker is exhausted');

        mgr.noteChainSizeAppliedFill('1.7.139', 1000);
        assert.strictEqual(mgr.consumeChainSizeAppliedFillAmount('1.7.139', 3558), 1000, 'a smaller marker covers only itself');
        assert.strictEqual(mgr.consumeChainSizeAppliedFillAmount('1.7.139', 2558), 0, 'remaining portion is normal accounting');

        mgr.noteChainSizeAppliedFill('1.7.140', 3558);
        assert.strictEqual(mgr.consumeChainSizeAppliedFill('1.7.140', 3558, -1), false, 'an expired marker is dropped');

        mgr.noteChainSizeAppliedFill('1.7.142', 7116);
        const snapshot = mgr.snapshotChainSizeAppliedFills();
        const restored = new OrderManager({
            assetA: 'BASE', assetB: 'QUOTE', startPrice: 100, minPrice: 50, maxPrice: 200,
            incrementPercent: 10, targetSpreadPercent: 10,
            botFunds: { buy: 1000, sell: 10 }, coreOrders: { buy: 2, sell: 2 },
        });
        restored.restoreChainSizeAppliedFills(snapshot);
        assert.strictEqual(restored.consumeChainSizeAppliedFillAmount('1.7.142', 7116), 7116, 'persisted marker survives restore');
    }

    console.log(' - 4. partial pass-1 coverage subtracts only the remainder...');
    {
        const result = await engine._computeFillTransitionResult(makeManager(), makeParams({ alreadyAppliedInt: 1000 }));
        assert.ok(
            Math.abs(Number(result.partialUpdate.size) - 3.0488) < 1e-9,
            `remainder-only shrink expected 3.0488, got ${result.partialUpdate.size}`
        );
        assert.strictEqual(String(result.partialUpdate.rawOnChain.for_sale), '30488', 'rawOnChain carries the remainder-only size');
    }

    console.log(' - 5. pass-1 marker does not drop the trade (pays/receives) from accounting...');
    {
        const Accountant = require('../modules/order/accounting').default;
        const makeMgr = () => ({
            assets: { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } },
            config: { assetA: 'BASE', assetB: 'QUOTE' },
            logger: { log: () => {} },
            orders: new Map(),
            accountTotals: { buy: 100000, sell: 1000, buyFree: 100000, sellFree: 1000 },
            _fundLock: { acquire: async (fn: any) => await fn() },
            processedFillTracker: new Map(),
            processedFillStore: null,
        });
        const fillOp = {
            order_id: '1.7.141',
            pays: { asset_id: '1.3.0', amount: 35580 },
            receives: { asset_id: '1.3.1', amount: 4850000 },
            is_maker: true,
        };
        const baseline = makeMgr();
        await new Accountant(baseline).processFillAccounting({ ...fillOp }, null, {});
        const marked: any = makeMgr();
        marked.consumeChainSizeAppliedFillAmount = () => 35580;
        await new Accountant(marked).processFillAccounting({ ...fillOp }, null, {});
        assert.deepStrictEqual(
            marked.accountTotals,
            baseline.accountTotals,
            'the fill trade (totals and free) must be applied exactly once even when pass 1 resized the slot'
        );
    }
    console.log(' - 6. an explicit partial applied amount is NOT masked by the legacy boolean...');
    {
        // The aggregated batch path reads `__chainSizeAlreadyApplied` off the
        // LAST entry of a group while summing the explicit applied amounts. If
        // the boolean counted as a floor it would collapse the remainder to 0
        // and skip the unapplied part of the earlier fills (phantom residual).
        const result = await engine._computeFillTransitionResult(
            makeManager(),
            makeParams({ alreadyAppliedInt: 1000, alreadyAppliedChainSize: true })
        );
        assert.strictEqual(result.isFull, false, 'a partially applied fill is not a full fill');
        assert.ok(
            Math.abs(Number(result.partialUpdate.size) - 3.0488) < 1e-9,
            `the unapplied remainder must still be subtracted (expected 3.0488, got ${result.partialUpdate.size})`
        );
        assert.strictEqual(
            String(result.partialUpdate.rawOnChain.for_sale), '30488',
            'rawOnChain must carry the remainder-only size even when the boolean flag is set'
        );
    }

    console.log(' - 7. a zero-remainder fill still verifies and cancels a chain residual...');
    {
        // Fill amount >= observed baseline clamps the remainder to 0. The slot
        // must virtualize (never a 0-size PARTIAL), but the chain residual check
        // must still run — skipping it strands a >= 1 base-unit order.
        const mgr = makeManager();
        let residualReads = 0;
        (mgr as any)._readSingleOrderFn = async () => { residualReads += 1; return { for_sale: 42 }; };
        const result = await engine._computeFillTransitionResult(mgr, makeParams({
            filledAmount: 9.9,
            filledAmountInt: 99000,
            effectiveRawForSale: 33046,
            rawForSaleInt: 33046,
        }));
        assert.strictEqual(result.isFull, true, 'no tradeable remainder => full fill');
        assert.ok(result.residualCancel, 'the chain residual must still be scheduled for cancel');
        assert.strictEqual(result.residualCancel.orderId, '1.7.137');
        assert.ok(residualReads >= 1, 'the residual verification read must run');
    }

    console.log(' - 8. a corrupt slot price cannot produce a 0-size PARTIAL...');
    {
        // price 0 makes the quote-side rounding test undecidable (NaN), so the
        // zero-remainder brake is the only thing preventing an invalid state.
        const result = await engine._computeFillTransitionResult(makeManager(), makeParams({
            matchedGridOrder: {
                id: 'slot-9',
                orderId: '1.7.9',
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                price: 0,
                size: 1,
                rawOnChain: { for_sale: '1' },
            },
            orderType: ORDER_TYPES.BUY,
            filledAmount: 5,
            filledAmountInt: 50000,
            currentSizeIntFromGrid: 1,
            rawForSaleInt: 1,
            effectiveRawForSale: 1,
        }));
        assert.strictEqual(result.isFull, true, 'a clamped remainder must never yield a 0-size PARTIAL slot');
    }

    console.log(' - 9. a partial fill on a foreign-side slot stores the traded side...');
    {
        const result = await engine._computeFillTransitionResult(makeManager(), makeParams({
            matchedGridOrder: {
                id: 'slot-118',
                orderId: '1.7.119',
                // Stale rail label; the resting chain order is a SELL.
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                price: 100,
                size: 1,
                rawOnChain: { for_sale: '10000' },
            },
            orderType: ORDER_TYPES.SELL,
            precision: 4,
            filledAmount: 0.3,
            filledAmountInt: 3000,
            currentSizeIntFromGrid: 10000,
            rawForSaleInt: 10000,
            effectiveRawForSale: 10000,
        }));
        assert.strictEqual(result.isFull, false, 'the residual keeps the order partial');
        assert.strictEqual(result.filledOrder.type, ORDER_TYPES.SELL, 'the fill event carries the traded side');
        // The stored slot must carry the traded side: `size` is in that side's
        // units, and accounting resolves dimensions from order.type. The
        // typeMismatch cancel is protected by rail geometry at drain time
        // (test_correction_queue_staleness 5c), not by the stored label.
        assert.strictEqual(result.partialUpdate.type, ORDER_TYPES.SELL,
            'the stored slot adopts the traded side (dimension consistency)');
        assert.strictEqual(result.partialUpdate.orderId, '1.7.119', 'the slot keeps the residual id for the cancel');
        assert.ok(Math.abs(Number(result.partialUpdate.size) - 0.7) < 1e-9,
            `residual size 0.7, got ${result.partialUpdate.size}`);
    }

    console.log(' - 10. a SPREAD slot adopts the filled side (no illegal SPREAD+PARTIAL)...');
    {
        const result = await engine._computeFillTransitionResult(makeManager(), makeParams({
            matchedGridOrder: {
                id: 'slot-118',
                orderId: '1.7.119',
                type: ORDER_TYPES.SPREAD,
                state: ORDER_STATES.ACTIVE,
                price: 100,
                size: 1,
                rawOnChain: { for_sale: '10000' },
            },
            orderType: ORDER_TYPES.BUY,
            precision: 4,
            filledAmount: 0.3,
            filledAmountInt: 3000,
            currentSizeIntFromGrid: 10000,
            rawForSaleInt: 10000,
            effectiveRawForSale: 10000,
        }));
        assert.strictEqual(result.isFull, false, 'a residual BUY remains');
        assert.strictEqual(result.partialUpdate.type, ORDER_TYPES.BUY,
            'SPREAD must not survive into a PARTIAL on-chain slot');
    }

    console.log('\n✓ fill-transition idempotency tests PASSED!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('✗ fill-transition idempotency tests failed!');
    console.error(err);
    process.exit(1);
});

/**
 * tests/test_spread_pure_fund_driven.ts
 *
 * Pure fund-driven spread correction.
 *
 * Corrections are funded exclusively by free available/chainFree. No resting
 * order is ever shrunk to manufacture budget — the self-funded tail-recycling
 * and the generic redistribution donor loops were removed because they moved
 * inventory within a rail and were gamed by stale-size snapshots. When free
 * funds are zero, side selection returns null, but a no-new-commitment
 * rotation into a promoted gap slot is still allowed (PF-025/026/027).
 *
 * PF-010: zero free funds (committed inventory present) -> side null.
 * PF-020: zero free funds -> no create AND no resting-order shrink.
 * PF-025: zero free funds -> BUY rotation into the promoted gap.
 * PF-026: zero free funds -> SELL rotation into the promoted gap.
 * PF-027: zero free funds -> replan still reaches rotation with no side.
 * PF-028: duplicate-price promoted slot is excluded from rotation.
 * PF-029: checkSpreadCondition reaches rotation with zero free funds.
 * PF-030: partial free funds -> placement stays within the free budget and
 *         every update is a top-up, never a shrink.
 * PF-040: free funds on one side still selects that side.
 */
const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');

function makeMgr() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 910, sell: 100 },
        coreOrders: { buy: 2, sell: 1 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    // Non-BTS pair: a zero BTS balance would make the fee reservation swallow
    // the free balance, hiding what this test asserts. Fund BTS so the
    // available-buy calculation reflects the pair's free funds.
    mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
    return mgr;
}

// Over-allocated buy donor + edge partial + a missing spread slot. The donor is
// exactly what the old redistribution path would have shrunk to fund the gap.
async function seedBuyRail(mgr, donorSize = 900) {
    await mgr._updateOrder({
        id: 'buy-donor', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE,
        price: 0.80, size: donorSize, orderId: '1.7.101'
    });
    await mgr._updateOrder({
        id: 'buy-edge', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL,
        price: 0.90, size: 10, orderId: '1.7.102'
    });
    await mgr._updateOrder({
        id: 'spread-1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL,
        price: 0.95, size: 0
    });
    // Two buy slots below the spread slot -> boundary sits at index 2 so
    // spread-1 (price-sorted idx=2) computes as BUY under the type filter.
    mgr.boundaryIdx = 2;
}

function beforeSize(mgr, id) {
    return Number(mgr.orders.get(id)?.size || 0);
}

async function run() {
    console.log('Running pure fund-driven spread correction tests...');

    // ---- PF-010 + PF-020: zero free funds -> no side, no create, no shrink ----
    {
        const mgr = makeMgr();
        await seedBuyRail(mgr);
        await mgr.setAccountTotals({ buy: 910, sell: 0, buyFree: 0, sellFree: 0 });
        await mgr.recalculateFunds();
        assert.strictEqual(mgr.funds.available.buy, 0, 'precondition: buy free funds must be zero');

        const decision = Grid.determineOrderSideByFunds(mgr, 1);
        assert.strictEqual(decision.side, null,
            'PF-010: zero free funds must select no side (committed inventory is not recycled)');

        const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY, 1);
        assert.strictEqual(correction.ordersToPlace.length, 0, 'PF-020: no free funds -> no create');
        const donorShrinks = correction.ordersToUpdate.filter((u) =>
            Number(u.newSize) < beforeSize(mgr, u.partialOrder.id));
        assert.strictEqual(donorShrinks.length, 0, 'PF-020: no resting order may be shrunk');
        console.log('  - PF-010/PF-020 zero free funds: no side, no create, no shrink');
    }

    // ---- PF-025: zero free funds -> rotate a resting order into the gap ----
    {
        const mgr = new OrderManager({
            assetA: 'BASE',
            assetB: 'QUOTE',
            startPrice: 1,
            botFunds: { buy: 1000, sell: 100 },
            coreOrders: { buy: 4, sell: 1 },
            incrementPercent: 1,
            targetSpreadPercent: 2
        });
        mgr.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
        // 12 levels: BUY 0-3 ACTIVE, gap 4-7 (gapSlots=4), first placed SELL
        // at 10, so promotion depth = 10 - 4 - 1 - 3 = 2 (slots 4,5).
        for (let i = 0; i < 12; i++) {
            const isBuy = i <= 3;
            const isSell = i === 10;
            await mgr._updateOrder({
                id: `slot-${i}`,
                price: 1 + i * 0.01,
                type: isBuy ? ORDER_TYPES.BUY : (isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
                state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: (isBuy || isSell) ? 10 : 0,
                orderId: (isBuy || isSell) ? `1.7.${300 + i}` : ''
            });
        }
        mgr.boundaryIdx = 3;
        mgr._gapSlots = 4;
        // Fully invested: zero free buy funds. The correction must still act.
        await mgr.setAccountTotals({ buy: 1000, sell: 0, buyFree: 0, sellFree: 0 });
        await mgr.recalculateFunds();
        assert.strictEqual(mgr.funds.available.buy, 0, 'precondition: zero free buy funds');

        const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY, 2);
        assert.strictEqual(correction.ordersToPlace.length, 0, 'PF-025: no create without free funds');
        assert.strictEqual((correction.ordersToRotate || []).length, 2,
            'PF-025: two resting buys must rotate into the promoted gap slots');
        assert.deepStrictEqual(
            (correction.ordersToRotate || []).map((r: any) => `${r.id}->${r.newGridId}`),
            ['slot-0->slot-4', 'slot-1->slot-5'],
            'PF-025: farthest resting buys move to the two promoted slots'
        );
        for (const r of correction.ordersToRotate || []) {
            assert.strictEqual(Number(r.newSize), Number(r.oldOrder.size),
                'PF-025: a rotation must never change the booked size');
        }
        assert.strictEqual(correction.boundaryIdx, 5,
            'PF-025: the rotated destinations promote the boundary');
        console.log('  - PF-025 zero free funds: rotation reuses resting inventory (no new commitment)');
    }

    // ---- PF-026: zero free funds -> SELL-side rotation mirrors BUY ----
    {
        const mgr = new OrderManager({
            assetA: 'BASE',
            assetB: 'QUOTE',
            startPrice: 1,
            botFunds: { buy: 100, sell: 1000 },
            coreOrders: { buy: 2, sell: 4 },
            incrementPercent: 1,
            targetSpreadPercent: 2
        });
        mgr.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
        // 12 levels: BUY 0-1 ACTIVE, gap 2-7 (gapSlots=4), SELL 8-11.
        // boundary 3 -> sellStart 8; highest placed buy idx 1 caps the SELL
        // boundary at 1, so two gap slots (7,6) are promotable.
        for (let i = 0; i < 12; i++) {
            const isBuy = i <= 1;
            const isSell = i >= 8;
            await mgr._updateOrder({
                id: `slot-${i}`,
                price: 1 + i * 0.01,
                type: isBuy ? ORDER_TYPES.BUY : (isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
                state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: (isBuy || isSell) ? 10 : 0,
                orderId: (isBuy || isSell) ? `1.7.${500 + i}` : ''
            });
        }
        mgr.boundaryIdx = 3;
        mgr._gapSlots = 4;
        await mgr.setAccountTotals({ buy: 100, sell: 1000, buyFree: 0, sellFree: 0 });
        await mgr.recalculateFunds();

        const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.SELL, 2);
        assert.strictEqual(correction.ordersToPlace.length, 0, 'PF-026: no create without free funds');
        assert.deepStrictEqual(
            (correction.ordersToRotate || []).map((r: any) => `${r.id}->${r.newGridId}`),
            ['slot-11->slot-7', 'slot-10->slot-6'],
            'PF-026: farthest resting sells move to the two promoted slots'
        );
        assert.strictEqual(correction.boundaryIdx, 1,
            'PF-026: SELL rotation promotes the boundary down to the highest placed buy');
        assert.strictEqual(correction.plannedCount, 2,
            'PF-026: rotation-only plan reports its tightening candidates');
        console.log('  - PF-026 zero free funds: SELL rotation mirrors BUY (no new commitment)');
    }

    // ---- PF-027: zero free funds still reaches rotation through replan ----
    {
        const mgr = new OrderManager({
            assetA: 'BASE',
            assetB: 'QUOTE',
            startPrice: 1,
            botFunds: { buy: 1000, sell: 100 },
            coreOrders: { buy: 4, sell: 1 },
            incrementPercent: 1,
            targetSpreadPercent: 2
        });
        mgr.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
        for (let i = 0; i < 12; i++) {
            const isBuy = i <= 3;
            const isSell = i === 10;
            await mgr._updateOrder({
                id: `slot-${i}`,
                price: 1 + i * 0.01,
                type: isBuy ? ORDER_TYPES.BUY : (isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
                state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: (isBuy || isSell) ? 10 : 0,
                orderId: (isBuy || isSell) ? `1.7.${300 + i}` : ''
            });
        }
        mgr.boundaryIdx = 3;
        mgr._gapSlots = 4;
        mgr.outOfSpread = 2;
        await mgr.setAccountTotals({ buy: 1000, sell: 0, buyFree: 0, sellFree: 0 });
        await mgr.recalculateFunds();

        assert.strictEqual(Grid.determineOrderSideByFunds(mgr, 1).side, null,
            'PF-027: zero free funds -> no fund-selected side');
        const rePlan = await Grid.replanSpreadCorrectionFromFreshMaster(mgr);
        assert(rePlan, 'PF-027: the no-side path must still try a rotation-only replan');
        assert.strictEqual(rePlan.ordersToPlace.length, 0, 'PF-027: replan creates nothing');
        assert.strictEqual((rePlan.ordersToRotate || []).length, 2,
            'PF-027: replan rotates resting buys into both promoted slots');
        assert.strictEqual(rePlan.plannedCount, 2,
            'PF-027: replan reports the rotation candidates');
        console.log('  - PF-027 zero free funds: replan reaches rotation without a fund-selected side');
    }

    // ---- PF-029: checkSpreadCondition reaches rotation with zero free funds ----
    {
        const mgr = new OrderManager({
            assetA: 'BASE',
            assetB: 'QUOTE',
            startPrice: 1,
            botFunds: { buy: 1000, sell: 100 },
            coreOrders: { buy: 4, sell: 1 },
            incrementPercent: 1,
            targetSpreadPercent: 2
        });
        mgr.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
        for (let i = 0; i < 12; i++) {
            const isBuy = i <= 3;
            const isSell = i === 10;
            await mgr._updateOrder({
                id: `slot-${i}`,
                price: 1 + i * 0.01,
                type: isBuy ? ORDER_TYPES.BUY : (isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
                state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: (isBuy || isSell) ? 10 : 0,
                orderId: (isBuy || isSell) ? `1.7.${300 + i}` : ''
            });
        }
        mgr.boundaryIdx = 3;
        mgr._gapSlots = 4;
        mgr.outOfSpread = 2;
        await mgr.setAccountTotals({ buy: 1000, sell: 0, buyFree: 0, sellFree: 0 });
        await mgr.recalculateFunds();

        let seen: any = null;
        const result = await Grid.checkSpreadCondition(mgr, {}, async (correction: any) => {
            seen = correction;
            return { executed: true };
        });
        assert.strictEqual(result.ordersPlaced, 2,
            'PF-029: zero-free checkSpreadCondition reports the planned rotations as placed');
        assert.deepStrictEqual(
            (seen?.ordersToRotate || []).map((r: any) => `${r.id}->${r.newGridId}`),
            ['slot-0->slot-4', 'slot-1->slot-5'],
            'PF-029: the zero-free fallback reaches the broadcast callback with rotations'
        );
        console.log('  - PF-029 zero free funds: checkSpreadCondition broadcasts rotation-only repair');
    }

    // ---- PF-028: a promoted slot colliding with a placed price is not a rotation destination ----
    {
        const levels = Array.from({ length: 12 }, (_, i) => 1 + i * 0.01);
        const mgr = new OrderManager({
            assetA: 'BASE',
            assetB: 'QUOTE',
            startPrice: 1,
            botFunds: { buy: 1000, sell: 100 },
            coreOrders: { buy: 4, sell: 1 },
            incrementPercent: 1,
            targetSpreadPercent: 2
        });
        mgr.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
        // Genesis is required for sameGridLevel to resolve 1.040001 to the
        // 1.04 ladder level. Without it the collision filter falls back to
        // exact-price identity and this test would not exercise the guard.
        mgr._genesis = buildGenesisFromPriceLevels(1.05, 1, 4, levels);
        for (let i = 0; i < 12; i++) {
            const isBuy = i <= 3;
            const isSell = i === 10;
            await mgr._updateOrder({
                id: `slot-${i}`,
                price: levels[i],
                type: isBuy ? ORDER_TYPES.BUY : (isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
                state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: (isBuy || isSell) ? 10 : 0,
                orderId: (isBuy || isSell) ? `1.7.${300 + i}` : ''
            });
        }
        // A placed order at another id but the SAME ladder level as slot-4.
        await mgr._updateOrder({
            id: 'slot-dup', price: 1.040001, type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE, size: 10, orderId: '1.7.999'
        });
        mgr.boundaryIdx = 3;
        mgr._gapSlots = 4;
        await mgr.setAccountTotals({ buy: 1000, sell: 0, buyFree: 0, sellFree: 0 });
        await mgr.recalculateFunds();

        const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY, 2);
        assert.strictEqual(correction.ordersToPlace.length, 0, 'PF-028: no create without free funds');
        assert.strictEqual((correction.ordersToRotate || []).length, 0,
            'PF-028: a promoted slot whose price is already occupied must not receive a rotation');
        assert.strictEqual(correction.stallHint, 'no-candidates',
            'PF-028: the duplicate-price filter must empty the candidate pool before rotation planning');
        console.log('  - PF-028 duplicate-price promoted slot is not rotated into');
    }

    // ---- PF-030: partial free funds -> funded placement, top-up only ----
    {
        const mgr = makeMgr();
        await seedBuyRail(mgr);
        // total 1410 - committed 910 = 500 free (consistent), so a funded
        // placement is actually possible and the budget bound is exercised.
        await mgr.setAccountTotals({ buy: 1410, sell: 0, buyFree: 500, sellFree: 0 });
        await mgr.recalculateFunds();
        const free = Number(mgr.funds.available.buy);
        assert(free > 0, 'precondition: some free buy funds');

        const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY, 1);
        const donorShrinks = correction.ordersToUpdate.filter((u) =>
            Number(u.newSize) < beforeSize(mgr, u.partialOrder.id));
        assert.strictEqual(donorShrinks.length, 0, 'PF-030: no resting order may be shrunk');

        const spent = correction.ordersToPlace.reduce((s, o) => s + Number(o.size || 0), 0)
            + correction.ordersToUpdate.reduce((s, u) =>
                s + Math.max(0, Number(u.newSize) - beforeSize(mgr, u.partialOrder.id)), 0);
        assert(spent <= free + 1e-6, `PF-030: spend ${spent} must not exceed free ${free}`);
        console.log(`  - PF-030 funded within free budget (spent ${spent.toFixed(5)} <= free ${free.toFixed(5)}), no shrink`);
    }

    // ---- PF-040: funded side selection unchanged ----
    {
        const mgr = makeMgr();
        await seedBuyRail(mgr);
        await mgr.setAccountTotals({ buy: 960, sell: 0, buyFree: 50, sellFree: 0 });
        await mgr.recalculateFunds();
        assert.strictEqual(Grid.determineOrderSideByFunds(mgr, 1).side, ORDER_TYPES.BUY,
            'PF-040: funded buy side must still be selected');
        console.log('  - PF-040 funded side selection unchanged');
    }

    console.log('PASS test_spread_pure_fund_driven');
}

run().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});

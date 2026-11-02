/**
 * tests/test_grid_fill_discipline.ts
 *
 * Grid-correctness discipline around a fill: buy lower / sell higher, and never
 * refill a rail from unsettled geometry.
 *
 * Pinned here (all from the 2026-11-02 buy-higher incident on a live
 * market-pair bot — 9 buy-lower violations, 23.5% of the window's BTS):
 *
 *  GD-1  the placement predicate itself (direction + same grid level)
 *  GD-2  the picker must not spend activation budget on a level the placement
 *        guard will refuse — it falls through to the next level down/up
 *        (fix 4: the filled level is never re-stamped same-side)
 *  GD-3  the reconcile create guard refuses the create outright
 *  GD-4  the window top-up is deferred while fills are unsettled (fix 1)
 */
const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const {
    _reconcileStartupSide,
    _pickVirtualSlotsToActivate,
    _createOrderFromGrid,
} = require('../modules/order/grid_reconcile_internal');
const { isLastFillPlacementBlocked } = require('../modules/order/utils/system');

// The incident ladder (slot-N prices), 0.3% per step.
const SLOT_PRICE = (idx: number): number => 1310.046339 * Math.pow(1.003, idx - 145);

function makePickerManager({ boundaryIdx = 145, gapSlots = 4, pivot = null, pivotType = null, slots = [] } = {}) {
    const orders = new Map();
    for (const s of slots) orders.set(s.id, { ...s });
    return {
        _gapSlots: gapSlots,
        boundaryIdx,
        orders,
        config: {
            incrementPercent: 0.3,
            targetSpreadPercent: 1.2,
            startPrice: 1300,
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5 },
            coreOrders: { buy: 10, sell: 10 },
            weightDistribution: { buy: 0.5, sell: 0.5 },
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0,
            assetA: 'TEST',
            assetB: 'BTS',
            market: 'TEST/BTS',
        },
        assets: {
            assetA: { id: '1.3.100', symbol: 'TEST', precision: 4 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        },
        logger: { log: () => {} },
        _lastFilledPrice: pivot,
        _lastFilledType: pivotType,
        lastFillPivotSource: pivot != null ? 'fill' : null,
        getChainFundsSnapshot: () => ({
            allocatedBuy: 50000,
            allocatedSell: 100,
            chainFreeBuy: 50000,
            chainFreeSell: 100,
        }),
    };
}

function buySlot(idx: number, state = ORDER_STATES.VIRTUAL) {
    return {
        id: `slot-${idx}`,
        type: ORDER_TYPES.BUY,
        state,
        price: SLOT_PRICE(idx),
        size: state === ORDER_STATES.VIRTUAL ? 4000 : 4000,
        orderId: state === ORDER_STATES.ACTIVE ? `1.7.${900 + idx}` : null,
    };
}

function sellSlot(idx: number, state = ORDER_STATES.ACTIVE) {
    return {
        id: `slot-${idx}`,
        type: ORDER_TYPES.SELL,
        state,
        price: SLOT_PRICE(idx),
        size: state === ORDER_STATES.VIRTUAL ? 4 : 4,
        orderId: state === ORDER_STATES.ACTIVE ? `1.7.${800 + idx}` : null,
    };
}

async function testPlacementPredicate() {
    console.log('\n[GD-1] placement predicate: direction + same grid level');
    const mgr = makePickerManager({ pivot: 1282.770882, pivotType: ORDER_TYPES.BUY });

    // Cold pivot => inert (a fresh grid must still build).
    assert.strictEqual(isLastFillPlacementBlocked(makePickerManager({}), 1310, ORDER_TYPES.BUY).blocked, false,
        'no fill yet => nothing to block');

    // Direction rule.
    assert.strictEqual(isLastFillPlacementBlocked(mgr, 1290.5, ORDER_TYPES.BUY).blocked, true, 'BUY above the fill');
    assert.strictEqual(isLastFillPlacementBlocked(mgr, 1282.770882, ORDER_TYPES.BUY).blocked, true, 'BUY at the fill');
    assert.strictEqual(isLastFillPlacementBlocked(mgr, 1282.770882 / 1.003, ORDER_TYPES.BUY).blocked, false, 'BUY one step lower');

    // Same-level rounding: slot level vs execution price of the SAME level.
    const rounding = makePickerManager({ pivot: 1310.060435, pivotType: ORDER_TYPES.BUY });
    const sameLevel = isLastFillPlacementBlocked(rounding, 1310.046339, ORDER_TYPES.BUY);
    assert.strictEqual(sameLevel.blocked, true, 'slot level 1310.046339 == execution 1310.060435 on the grid step');
    assert.strictEqual(sameLevel.reason, 'same-level');

    // SELL mirror.
    const sellFill = makePickerManager({ pivot: 1280, pivotType: ORDER_TYPES.SELL });
    assert.strictEqual(isLastFillPlacementBlocked(sellFill, 1280, ORDER_TYPES.SELL).blocked, true, 'SELL at the fill');
    assert.strictEqual(isLastFillPlacementBlocked(sellFill, 1275, ORDER_TYPES.SELL).blocked, true, 'SELL below the fill');
    assert.strictEqual(isLastFillPlacementBlocked(sellFill, 1284, ORDER_TYPES.SELL).blocked, false, 'SELL above the fill');
    assert.strictEqual(isLastFillPlacementBlocked(sellFill, 1280 * 1.003, ORDER_TYPES.SELL).blocked, false, 'SELL one step above');

    // Junk never blocks.
    assert.strictEqual(isLastFillPlacementBlocked(mgr, NaN, ORDER_TYPES.BUY).blocked, false);
    assert.strictEqual(isLastFillPlacementBlocked(mgr, 0, ORDER_TYPES.BUY).blocked, false);
    console.log('  ✓ direction + same-level + cold-start behaviour');
}

async function testPickerFallsThroughOnBuy() {
    console.log('\n[GD-2a] BUY picker skips the filled level and takes the next one down');
    const slots = [];
    for (let i = 140; i <= 145; i++) slots.push(buySlot(i));
    for (let i = 146; i <= 149; i++) slots.push({ id: `slot-${i}`, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: SLOT_PRICE(i), size: 0, orderId: null });
    for (let i = 150; i <= 155; i++) slots.push(sellSlot(i));

    // Cold: the picker takes the closest-to-market level (slot-145).
    const cold = makePickerManager({ slots });
    const coldPicks = _pickVirtualSlotsToActivate(cold, ORDER_TYPES.BUY, 3).map((s: any) => s.id);
    assert.deepStrictEqual(coldPicks, ['slot-145', 'slot-144', 'slot-143'], 'closest-first is the normal ordering');

    // After a BUY fill at slot-145, that level must not be picked again.
    const filled = makePickerManager({ slots, pivot: SLOT_PRICE(145), pivotType: ORDER_TYPES.BUY });
    const picks = _pickVirtualSlotsToActivate(filled, ORDER_TYPES.BUY, 3).map((s: any) => s.id);
    assert(!picks.includes('slot-145'), `the filled level must never be re-picked, got ${picks.join(',')}`);
    assert.deepStrictEqual(picks, ['slot-144', 'slot-143', 'slot-142'],
        'the pick budget rolls one level down instead of re-stamping the fill (fix 4)');
    console.log('  ✓ picker falls through to the next BUY level down');
}

async function testPickerFallsThroughOnSell() {
    console.log('\n[GD-2b] SELL picker skips the filled level and takes the next one up');
    const slots = [];
    for (let i = 140; i <= 145; i++) slots.push(buySlot(i, ORDER_STATES.ACTIVE));
    for (let i = 146; i <= 149; i++) slots.push({ id: `slot-${i}`, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: SLOT_PRICE(i), size: 0, orderId: null });
    for (let i = 150; i <= 155; i++) slots.push(sellSlot(i, ORDER_STATES.VIRTUAL));

    const cold = makePickerManager({ slots });
    const coldPicks = _pickVirtualSlotsToActivate(cold, ORDER_TYPES.SELL, 2).map((s: any) => s.id);
    assert.deepStrictEqual(coldPicks, ['slot-150', 'slot-151'], 'closest-first from sellStart');

    const filled = makePickerManager({ slots, pivot: SLOT_PRICE(150), pivotType: ORDER_TYPES.SELL });
    const picks = _pickVirtualSlotsToActivate(filled, ORDER_TYPES.SELL, 2).map((s: any) => s.id);
    assert(!picks.includes('slot-150'), `a SELL at the fill price is selling at cost, got ${picks.join(',')}`);
    assert.deepStrictEqual(picks, ['slot-151', 'slot-152'], 'the SELL rail rolls one level up');
    console.log('  ✓ picker falls through to the next SELL level up');
}

async function testCreateGuardRefusesBlockedLevel() {
    console.log('\n[GD-3] the reconcile create guard refuses a blocked level outright');
    const logs: Array<{ msg: string; level?: string }> = [];
    const manager: any = {
        orders: new Map([
            ['slot-145', { id: 'slot-145', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: SLOT_PRICE(145), size: 4000, orderId: null }],
        ]),
        assets: {
            assetA: { id: '1.3.100', symbol: 'TEST', precision: 4 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        },
        config: { incrementPercent: 0.3, startPrice: 1300 },
        logger: { log: (msg: string, level?: string) => logs.push({ msg, level }) },
        _pendingBroadcasts: new Map(),
        _lastUnmatchedChainOrders: [],
        _lastFilledPrice: SLOT_PRICE(145),
        _lastFilledType: ORDER_TYPES.BUY,
        lastFillPivotSource: 'fill',
    };

    const created = await _createOrderFromGrid({
        chainOrders: {} as any,
        account: 'acct',
        privateKey: 'pk',
        manager,
        gridOrder: { id: 'slot-145', type: ORDER_TYPES.BUY, price: SLOT_PRICE(145), size: 4000 } as any,
        dryRun: false,
    });

    assert.strictEqual(created, null, 'no chain order may be created at/above the last fill');
    const guard = logs.find((l) => l.msg.includes('LAST-FILL-GUARD'));
    assert(guard, 'the refusal is logged with the guard name');
    assert.strictEqual(guard!.level, 'warn');
    assert(/rail must crawl/.test(guard!.msg), 'the log explains the wait');
    console.log('  ✓ create refused before any broadcast');
}

function makeReconcileManager({ virtualCount = 3 } = {}) {
    const mgr = new OrderManager({
        market: 'TEST/BTS',
        assetA: 'TEST',
        assetB: 'BTS',
        startPrice: 1300,
        incrementPercent: 0.3,
        targetSpreadPercent: 1.2,
        coreOrders: { buy: 5, sell: 2 },
        weightDistribution: { sell: 0.5, buy: 0.5 },
    } as any);
    (mgr as any).logger.level = 'silent';
    return (async () => {
        mgr.assets = {
            assetA: { id: '1.3.100', precision: 4, symbol: 'TEST' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        } as any;
        await mgr.setAccountTotals({ buy: 50000, sell: 500, buyFree: 50000, sellFree: 500 } as any);
        await mgr.resetFunds();
        (mgr as any)._gapSlots = 0;
        mgr.boundaryIdx = 9;
        (mgr as any).pauseFundRecalc();
        for (let i = 0; i < 14; i++) {
            await mgr._updateOrder({
                id: `slot-${i}`,
                type: ORDER_TYPES.BUY,
                price: 90 + i,
                size: 4000,
                state: ORDER_STATES.VIRTUAL,
                orderId: null,
            } as any);
        }
        // A couple of live window orders so matchedOnGrid > 0 (no mass-cancel path).
        await mgr._updateOrder({
            id: 'slot-8', type: ORDER_TYPES.BUY, price: 98, size: 4000,
            state: ORDER_STATES.ACTIVE, orderId: '1.7.1',
        } as any);
        await mgr._updateOrder({
            id: 'slot-0', type: ORDER_TYPES.BUY, price: 90, size: 4000,
            state: ORDER_STATES.ACTIVE, orderId: '1.7.2',
        } as any);
        await mgr.resumeFundRecalc();
        return mgr;
    })();
}

async function planBuyCreates(mgr: any): Promise<string[]> {
    const plannedCreates: any[] = [];
    await _reconcileStartupSide({
        orderType: ORDER_TYPES.BUY,
        targetCount: 5,
        chainSideOrders: [],
        unmatchedSideOrders: [],
        manager: mgr,
        chainOrders: {},
        account: 'acct',
        privateKey: 'pk',
        dryRun: true,
        plannedCreates,
        plannedUpdates: [],
        plannedCancels: [],
        planOnly: true,
    });
    return plannedCreates.map((c: any) => c.gridOrder?.id);
}

async function testTopUpDeferredWhileFillsUnsettled() {
    console.log('\n[GD-4] the window top-up is deferred while fills are unsettled');
    const settled = await makeReconcileManager();
    const baseline = await planBuyCreates(settled);
    assert(baseline.length > 0, `a settled grid tops up normally, got ${baseline.join(',')}`);

    // 1) owed boundary crawl
    const owed = await makeReconcileManager();
    (owed as any)._pendingFillCrawls = [{ slotId: 'slot-9', side: ORDER_TYPES.BUY, ts: 1 }];
    assert.deepStrictEqual(await planBuyCreates(owed), [],
        'an owed crawl means the rail has not absorbed the fills yet: no top-up');

    // 2) fill batch in flight
    const inFlight = await makeReconcileManager();
    (inFlight as any)._fillBatchInFlight = 1;
    assert.deepStrictEqual(await planBuyCreates(inFlight), [],
        'a fill batch in flight defers the top-up');

    // 3) the ledger clears -> the top-up resumes
    (owed as any)._pendingFillCrawls = [];
    const resumed = await planBuyCreates(owed);
    assert.deepStrictEqual(resumed, baseline, 'once settled the same shortfall is planned normally');
    console.log('  ✓ deferral is state-driven and reversible');
}

async function main() {
    console.log('=== Grid fill discipline (buy lower / sell higher, no stale top-up) ===');
    await testPlacementPredicate();
    await testPickerFallsThroughOnBuy();
    await testPickerFallsThroughOnSell();
    await testCreateGuardRefusesBlockedLevel();
    await testTopUpDeferredWhileFillsUnsettled();
    console.log('\nAll grid fill-discipline tests passed ✔');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

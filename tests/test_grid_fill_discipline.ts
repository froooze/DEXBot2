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
 *  GD-5  a virtualised slot whose chain order is live is revived in place (F-2)
 *  GD-6  the revive refuses aliases / placed slots / id mismatches / rejections
 *  GD-7  a level that still owns a chain id is occupied (no duplicate CREATE) (F-3)
 *  GD-8  the planner does not treat a dark level as a hole (F-3)
 *  GD-9  the spread planner refuses the level that just filled (F-5)
 *  GD-10 an orphan fill credits proceeds AND arms the pivot (F-4)
 */
const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const {
    _reconcileStartupSide,
    _pickVirtualSlotsToActivate,
    _createOrderFromGrid,
} = require('../modules/order/grid_reconcile_internal');
const { isLastFillPlacementBlocked, isLastFillGuardBlocked } = require('../modules/order/utils/system');
const { reviveVirtualSlotFromChain } = require('../modules/order/utils/order');
const { validateCreateTargetSlots, reconcileGrid } = require('../modules/order/utils/validate');
const { grid: Grid } = require('../modules/order').default;
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');


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

// ---------------------------------------------------------------- F-2 revive
const REVIVE_LADDER = Array.from({ length: 9 }, (_, i) => 1000 * Math.pow(1.003, i - 4));
function reviveGenesis() {
    return buildGenesisFromPriceLevels(REVIVE_LADDER[4], 0.3, 2, REVIVE_LADDER);
}

function makeReviveManager({ slot, applyResult = true }: { slot: any; applyResult?: boolean }) {
    const applied: Array<{ order: any; context?: string }> = [];
    const logs: Array<{ msg: string; level?: string }> = [];
    const mgr: any = {
        orders: new Map([[slot.id, slot]]),
        assets: {
            assetA: { id: '1.3.100', symbol: 'TEST', precision: 4 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        },
        config: { incrementPercent: 0.3, startPrice: 1000 },
        _genesis: reviveGenesis(),
        logger: { log: (msg: string, level?: string) => logs.push({ msg, level }) },
        _applied: applied,
        _logs: logs,
        _applyOrderUpdate: async (order: any, context?: string) => {
            if (applyResult === false) return false;
            applied.push({ order, context });
            mgr.orders.set(order.id, order);
            return true;
        },
    };
    return mgr;
}

function virtualSlotAt(idx: number, orderId: string | null, size = 0) {
    return {
        id: `slot-${idx}`,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: REVIVE_LADDER[idx],
        size,
        orderId,
    };
}

function chainOrderAt(idx: number, { size = 4, orderId = '1.7.900', type = ORDER_TYPES.BUY } = {}) {
    return { orderId, price: REVIVE_LADDER[idx], size, type };
}

async function testReviveRevirtualisedSlot() {
    console.log('\n[GD-5] a virtualised slot whose chain order is live is revived in place');
    const slot = virtualSlotAt(4, '1.7.900');
    const mgr = makeReviveManager({ slot });

    const revived = await reviveVirtualSlotFromChain(mgr, slot, chainOrderAt(4), { id: '1.7.900' }, 'sync-pass1-revive', { skipAccounting: true });

    assert(revived, 'the dark level must be revived');
    assert.strictEqual(revived!.state, ORDER_STATES.ACTIVE, 'booked size 0 < chain size => ACTIVE');
    assert.strictEqual(revived!.type, ORDER_TYPES.BUY, 'rail type comes from the chain order');
    assert.strictEqual(revived!.size, 4, 'chain size is authoritative');
    assert.strictEqual(revived!.orderId, '1.7.900');
    assert.strictEqual(mgr._applied.length, 1, 'applied exactly once');
    assert.strictEqual(mgr._applied[0].context, 'sync-pass1-revive');
    assert(mgr._logs.some((l: any) => l.msg.includes('Revived virtualised slot')), 'the revive is logged');

    // PARTIAL when the booked size exceeds the chain size (partial fill).
    const partialSlot = virtualSlotAt(4, '1.7.901', 10);
    const mgr2 = makeReviveManager({ slot: partialSlot });
    const partial = await reviveVirtualSlotFromChain(mgr2, partialSlot, chainOrderAt(4, { orderId: '1.7.901', size: 6 }), null, 'sync-pass1-revive');
    assert.strictEqual(partial!.state, ORDER_STATES.PARTIAL, 'chain smaller than booked => PARTIAL');
    assert.strictEqual(partial!.size, 6);
    console.log('  ✓ ACTIVE/PARTIAL materialisation, one apply, logged');
}

async function testReviveRefusals() {
    console.log('\n[GD-6] revive refuses anything that is not this slot\'s own live order');
    // A rotation source whose cancel has not landed: the chain order sits at a
    // DIFFERENT level, so the slot only aliases the id.
    const alias = virtualSlotAt(4, '1.7.900');
    const aliasMgr = makeReviveManager({ slot: alias });
    assert.strictEqual(
        await reviveVirtualSlotFromChain(aliasMgr, alias, chainOrderAt(2, { orderId: '1.7.900' }), null, 'x'),
        null,
        'off-level alias must not be resurrected'
    );
    assert.strictEqual(aliasMgr._applied.length, 0);

    // Already placed: nothing to revive.
    const placed = { ...virtualSlotAt(4, '1.7.900'), state: ORDER_STATES.ACTIVE, size: 4 };
    const placedMgr = makeReviveManager({ slot: placed });
    assert.strictEqual(await reviveVirtualSlotFromChain(placedMgr, placed, chainOrderAt(4), null, 'x'), null);

    // A different order id: the slot and the chain order disagree.
    const otherMgr = makeReviveManager({ slot: virtualSlotAt(4, '1.7.111') });
    assert.strictEqual(
        await reviveVirtualSlotFromChain(otherMgr, otherMgr.orders.get('slot-4'), chainOrderAt(4, { orderId: '1.7.900' }), null, 'x'),
        null,
        'id mismatch must not revive'
    );

    // A rejected apply leaves the slot virtual (no silent state change).
    const rejectMgr = makeReviveManager({ slot: virtualSlotAt(4, '1.7.900'), applyResult: false });
    assert.strictEqual(
        await reviveVirtualSlotFromChain(rejectMgr, rejectMgr.orders.get('slot-4'), chainOrderAt(4), null, 'x'),
        null,
        'rejected apply => null'
    );
    assert(rejectMgr._logs.some((l: any) => l.msg.includes('rejected')));
    console.log('  ✓ alias / placed / id-mismatch / rejected all refuse');
}

// ------------------------------------------------------- F-3 duplicate CREATE
function createTarget(id: string, price: number) {
    return { type: 'create', id, order: { id, price, size: 4, type: ORDER_TYPES.BUY } };
}

async function testCreateTargetOccupancy() {
    console.log('\n[GD-7] a level that still owns a chain id is occupied (no duplicate CREATE)');
    const target = createTarget('slot-4', 1000);

    // VIRTUAL + orderId = the dark-level state: the chain still holds an order
    // here, so a CREATE would duplicate the price level.
    const dark = new Map([['slot-4', { ...virtualSlotAt(4, '1.7.900') }]]);
    const darkResult = validateCreateTargetSlots([target], dark, null, [], 0.3);
    assert.strictEqual(darkResult.isValid, false, 'occupied level must refuse the CREATE');
    assert.strictEqual(darkResult.violations[0].reason, 'slot_occupied');

    // Same slot with NO chain id is a real hole: the CREATE is allowed.
    const hole = new Map([['slot-4', { ...virtualSlotAt(4, null) }]]);
    const holeResult = validateCreateTargetSlots([target], hole, null, [], 0.3);
    assert.strictEqual(holeResult.isValid, true, `a clean hole must stay creatable, got ${JSON.stringify(holeResult.violations)}`);

    // A possibly-landed CREATE (createUncertain) is occupied too.
    const uncertain = new Map([['slot-4', { ...virtualSlotAt(4, null), createUncertain: true }]]);
    const uncertainResult = validateCreateTargetSlots([target], uncertain, null, [], 0.3);
    assert.strictEqual(uncertainResult.isValid, false, 'an uncertain CREATE must not be re-created');
    console.log('  ✓ occupied / uncertain refuse, clean hole allowed');
}

async function testReconcileGridTreatsDarkLevelAsFilled() {
    console.log('\n[GD-8] the planner does not treat a dark level as a hole');
    const master = new Map([
        ['slot-4', { ...virtualSlotAt(4, '1.7.900') }],   // dark: virtual + chain id
        ['slot-5', { ...virtualSlotAt(5, null) }],        // true hole
    ]);
    const target = new Map([
        ['slot-4', { ...virtualSlotAt(4, null), state: ORDER_STATES.ACTIVE, size: 4 }],
        ['slot-5', { ...virtualSlotAt(5, null), state: ORDER_STATES.ACTIVE, size: 4 }],
    ]);

    const result = reconcileGrid(master, target, 5, {});
    const createIds = result.actions.filter((a: any) => a.type === 'create').map((a: any) => a.id);
    assert.deepStrictEqual(createIds, ['slot-5'],
        `only the true hole may be CREATE'd, got ${JSON.stringify(createIds)}`);
    console.log('  ✓ dark level skipped, hole created');
}

// ------------------------------------------------- F-5 planner/guard parity
const SPREAD_INC = 0.3;
const spreadPrice = (idx: number): number => 670.368 * Math.pow(1 + SPREAD_INC / 100, idx);

async function buildSpreadGeometry(mgr: any) {
    mgr.assets = {
        assetA: { id: '1.3.100', symbol: 'TEST', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
    };
    mgr.config.weightDistribution = { buy: 0.5, sell: 0.5 };
    mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
    for (let i = 0; i <= 291; i++) {
        const type = i <= 150 ? ORDER_TYPES.BUY : (i >= 156 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        const live = (i >= 131 && i <= 145) || (i >= 156 && i <= 175);
        await mgr._updateOrder({
            id: `slot-${i}`,
            price: spreadPrice(i),
            type,
            state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: live ? 2 : 1.5,
            orderId: live ? `1.7.${500000 + i}` : '',
        });
    }
    mgr.boundaryIdx = 150;
    mgr._gapSlots = 5;
    await mgr.setAccountTotals({ buy: 20000, sell: 0, buyFree: 20000, sellFree: 0 });
    await mgr.recalculateFunds();
}

async function spreadManager() {
    const mgr = new OrderManager({
        assetA: 'TEST',
        assetB: 'BTS',
        startPrice: 1052.06,
        botFunds: { buy: 20000, sell: 0 },
        coreOrders: { buy: 20, sell: 20 },
        incrementPercent: SPREAD_INC,
        targetSpreadPercent: 1.5,
    } as any);
    await buildSpreadGeometry(mgr);
    return mgr;
}

async function testSpreadPlannerExcludesSameLevel() {
    console.log('\n[GD-9] the spread planner refuses the level that just filled (fix 5)');
    const cold = await spreadManager();
    const baseline = await Grid.prepareSpreadCorrectionOrders(cold, ORDER_TYPES.BUY, 1);
    const baselineIds = baseline.ordersToPlace.map((o: any) => o.id);
    assert.strictEqual(baselineIds.length, 1, `expected one BUY candidate, got ${JSON.stringify(baselineIds)}`);
    const candidate = baselineIds[0];
    const candidateIdx = Number(String(candidate).replace('slot-', ''));

    // The fill EXECUTED a hair above the slot level (a maker fill always can:
    // slot 1310.046339 traded at 1310.060435). That is the shape the raw
    // direction rule cannot see — the slot reads as "below the pivot".
    const slotPrice = spreadPrice(candidateIdx);
    const fillPrice = slotPrice * (1 + (SPREAD_INC / 100) * 0.1);
    assert.strictEqual(
        isLastFillGuardBlocked(slotPrice, ORDER_TYPES.BUY, fillPrice, ORDER_TYPES.BUY).blocked,
        false,
        'the raw direction rule alone lets this same-level re-place through (the bug this pins)'
    );

    const filled = await spreadManager();
    filled._lastFilledPrice = fillPrice;
    filled._lastFilledType = ORDER_TYPES.BUY;
    filled.lastFillPivotSource = 'fill';

    const after = await Grid.prepareSpreadCorrectionOrders(filled, ORDER_TYPES.BUY, 1);
    const afterIds = after.ordersToPlace.map((o: any) => o.id);
    assert(!afterIds.includes(candidate),
        `the filled level ${candidate} must not be planned again, got ${JSON.stringify(afterIds)}`);
    for (const id of afterIds) {
        const idxOfPicked = Number(String(id).replace('slot-', ''));
        assert(spreadPrice(idxOfPicked) < fillPrice * (1 - (SPREAD_INC / 100) * 0.5),
            `${id} @ ${spreadPrice(idxOfPicked)} is not strictly below the fill ${fillPrice}`);
    }
    console.log(`  ✓ ${candidate} (same level as the fill) excluded, planner picked ${JSON.stringify(afterIds)}`);
}

// --------------------------------------------- F-4 sweep-orphan attribution
function makeSweepBot({ genesis }: { genesis: any }) {
    const logs: Array<{ msg: string; level?: string }> = [];
    const manager: any = {
        orders: new Map(),
        assets: {
            assetA: { id: '1.3.100', symbol: 'TEST', precision: 4 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        },
        config: { dryRun: false, incrementPercent: 0.3 },
        _genesis: genesis,
        _lastFilledPrice: null,
        _lastFilledType: null,
        _lastFilledBuyPrice: null,
        _lastFilledSellPrice: null,
        lastFillPivotSource: null,
        _pendingFillCrawls: [],
        _gridDirty: false,
        logger: { log: (msg: string, level?: string) => logs.push({ msg, level }) },
        _markGridDirty() { this._gridDirty = true; },
        recordLastFilledPrices(fills: any[]) {
            for (const f of fills) {
                if (!f || (f.type !== ORDER_TYPES.BUY && f.type !== ORDER_TYPES.SELL)) continue;
                const price = Number(f.price);
                if (!Number.isFinite(price) || price <= 0) continue;
                this._lastFilledPrice = price;
                this._lastFilledType = f.type;
                this.lastFillPivotSource = 'fill';
            }
        },
    };
    const credited: string[] = [];
    const bot: any = {
        manager,
        _logs: logs,
        _credited: credited,
        // A degraded orphan key keeps the sweep off the network path
        // (isUnknownFillOrderAdoptable() returns early when the op carries no
        // order_id, which is precisely the degraded-key case).
        _buildOrphanFillFallbackKey: () => 'orphan:degraded:test',
        _isNewFillKey: () => true,
        _recentlyQueuedFills: new Map(),
        _applyReplaySafeOrphanFillAccounting: async () => { credited.push('credited'); return { status: 'applied' }; },
    };
    return bot;
}

async function testSweepOrphanFillAttributesBeforeCrediting() {
    console.log('\n[GD-10] an orphan fill credits proceeds AND arms the pivot (fix 4)');
    const { processSweepOrphanFill } = require('../modules/dexbot_fill_runtime');
    const genesis = buildGenesisFromPriceLevels(REVIVE_LADDER[4], 0.3, 2, REVIVE_LADDER);

    const inGridPrice = REVIVE_LADDER[3];
    const bot = makeSweepBot({ genesis });
    const fill = {
        id: '1.11.1401134019',
        block_num: 115762932,
        op: [77, {
            // No order id: the degraded-orphan-key case. Never touches the
            // chain (adoption is impossible without an id), so this stays a
            // pure unit test.
            order_id: null,
            pays: { amount: Math.round(inGridPrice * 2 * 1e5), asset_id: '1.3.0' },
            receives: { amount: Math.round(2 * 1e4), asset_id: '1.3.100' },
        }],
    };
    await processSweepOrphanFill(bot, fill, fill.op[1], new Set(), { context: 'TEST', label: 'TEST' });

    assert(Math.abs(Number(bot.manager._lastFilledPrice) - inGridPrice) < 0.01,
        `the pivot must track the credited fill's price, got ${bot.manager._lastFilledPrice}`);
    assert.strictEqual(bot.manager._lastFilledType, ORDER_TYPES.BUY);
    assert.strictEqual(bot._credited.length, 1, 'the credit still happens (attribution is additive)');

    // Out-of-grid (shelf/manual) price: credited, but the pivot must NOT move —
    // arming it below the rail would veto the whole BUY side.
    const shelfBot = makeSweepBot({ genesis });
    const shelfPrice = REVIVE_LADDER[0] * 0.5;
    const shelfFill = {
        id: '1.11.1401134020',
        block_num: 115762933,
        op: [77, {
            order_id: null,
            pays: { amount: Math.round(shelfPrice * 2 * 1e5), asset_id: '1.3.0' },
            receives: { amount: Math.round(2 * 1e4), asset_id: '1.3.100' },
        }],
    };
    await processSweepOrphanFill(shelfBot, shelfFill, shelfFill.op[1], new Set(), { context: 'TEST', label: 'TEST' });
    assert.strictEqual(shelfBot.manager._lastFilledPrice, null, 'out-of-grid fill must not arm the pivot');
    assert.strictEqual(shelfBot._credited.length, 1);
    console.log('  ✓ in-grid arms the pivot, out-of-grid does not, credit unchanged');
}

async function main() {
    console.log('=== Grid fill discipline (buy lower / sell higher, no stale top-up) ===');
    await testPlacementPredicate();
    await testPickerFallsThroughOnBuy();
    await testPickerFallsThroughOnSell();
    await testCreateGuardRefusesBlockedLevel();
    await testTopUpDeferredWhileFillsUnsettled();
    await testReviveRevirtualisedSlot();
    await testReviveRefusals();
    await testCreateTargetOccupancy();
    await testReconcileGridTreatsDarkLevelAsFilled();
    await testSpreadPlannerExcludesSameLevel();
    await testSweepOrphanFillAttributesBeforeCrediting();
    console.log('\nAll grid fill-discipline tests passed ✔');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

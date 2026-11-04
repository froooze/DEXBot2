/**
 * tests/test_rebuild_fill_anchor.ts
 *
 * The boundary of a REBUILT or RELOADED grid must be anchored to the last
 * real fill, not only to the fresh market center.
 *
 * Live incident this pins (2026-11-04, two live market-pair bots):
 *   - a BUY filled at 1447.854386 one minute before a trigger-file resync;
 *   - the rebuild centered the band on the pool price and derived boundary 159;
 *   - the startup picker correctly skipped slots 158/159 (at/through the pivot),
 *     filled the 20 buys from slot 157 down, and left the first sell at slot 164;
 *   - realized spread = 2.123% vs the 1.5% target (limit 1.65%), with no
 *     order-fill reason for the extra two steps.
 *
 * The fill algebra the runtime already uses is:
 *   BUY  fill at f -> boundary <= f - 1        (counter SELL at f + gapSlots)
 *   SELL fill at f -> boundary >= f - gapSlots (counter BUY  at f - gapSlots)
 * With boundary == f - 1 for the incident, sellStart becomes f + gapSlots and
 * the counter SELL is exactly the missing level; gapSlots (the spread) stays
 * constant.
 *
 * Also pins why the free-fund spread correction did not heal it: the BUY side
 * is genuinely last-fill-blocked (no same-side re-placement), and the SELL
 * fallback does have free inventory and would place the two counter asks and
 * promote the boundary — it simply had no maintenance tick before the bots
 * were stopped. The planner assertion below is that fallback.
 */
const assert = require('assert');
const { createOrderGrid, anchorRebuildBoundaryToLastFill, applyRebuildFillAnchor, loadGrid } = require('../modules/order/grid');
const { grid: Grid } = require('../modules/order').default;
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const MathUtils = require('../modules/order/utils/math');

// The incident generation (0.3% step / 1.5% target spread).
const REBUILD_CONFIG = {
    assetA: 'BASE',
    assetB: 'BTS',
    startPrice: 1462.2355343545373,
    minPrice: 897.442402130163,
    maxPrice: 2156.1053711177165,
    incrementPercent: 0.3,
    targetSpreadPercent: 1.5,
    gridLimits: {},
    coreOrders: { buy: 20, sell: 20 },
    botFunds: { buy: 1000000, sell: 1000 },
};

const FILL_AT = Date.now() - 60_000;

let passed = 0;
let failed = 0;

async function run(name: string, fn: () => void | Promise<void>) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
}

function makeRebuildManager(generation: ReturnType<typeof createOrderGrid>, over: Record<string, unknown> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    return {
        _genesis: generation.genesis,
        _gapSlots: generation.gapSlots,
        config: { ...REBUILD_CONFIG },
        _lastFilledPrice: null as number | null,
        _lastFilledType: null as string | null,
        _lastFilledAt: 0,
        lastFillPivotSource: null as string | null,
        _lastMarketFillPrice: null as number | null,
        _lastMarketFillType: null as string | null,
        _lastMarketFillAt: 0,
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        ...over,
    };
}

function setFillPivot(manager: any, price: number, type: string) {
    manager._lastFilledPrice = price;
    manager._lastFilledType = type;
    manager._lastFilledAt = FILL_AT;
    manager.lastFillPivotSource = 'fill';
}

function slotPrice(generation: ReturnType<typeof createOrderGrid>, idx: number): number {
    return Number(generation.orders[idx].price);
}

function spreadPct(generation: ReturnType<typeof createOrderGrid>, boundary: number, gap: number): number {
    const sellStart = MathUtils.getSellStartIdx(boundary, gap);
    return (slotPrice(generation, sellStart) / slotPrice(generation, boundary) - 1) * 100;
}

function testIncidentBuyAnchor() {
    const g = createOrderGrid(REBUILD_CONFIG);
    assert.strictEqual(g.boundaryIdx, 159, 'fixture must reproduce the rebuilt boundary');
    assert.strictEqual(g.gapSlots, 4, 'fixture must reproduce the 4-slot band');
    const fillPrice = 1447.8543857890913;
    const fillIdx = Number(MathUtils.slotIndexForPrice(fillPrice, g.genesis));
    assert.strictEqual(fillIdx, 158, `the incident fill must resolve to slot 158, got ${fillIdx}`);

    const manager: any = makeRebuildManager(g);
    setFillPivot(manager, fillPrice, ORDER_TYPES.BUY);
    const anchored = anchorRebuildBoundaryToLastFill(manager, g.boundaryIdx, g.orders, g.gapSlots);

    assert.strictEqual(anchored, 157, 'BUY fill at slot 158 => boundary 157');
    const sellStart = MathUtils.getSellStartIdx(Number(anchored), g.gapSlots);
    assert.strictEqual(sellStart, 162, 'counter SELL must land at fillSlot + gapSlots');
    assert.ok(Math.abs(spreadPct(g, Number(anchored), g.gapSlots) - 1.5) < 0.02,
        `anchored geometry must keep the configured 1.5% spread, got ${spreadPct(g, Number(anchored), g.gapSlots).toFixed(3)}%`);
    assert.ok(manager.logs.some((l: any) => /Re-anchored from the last fill/.test(l.msg)),
        'the rebuild anchor must be logged, not silent');
}

function testAlreadyAnchoredIsNoOp() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const manager: any = makeRebuildManager(g);
    setFillPivot(manager, 1447.8543857890913, ORDER_TYPES.BUY);
    const anchored = anchorRebuildBoundaryToLastFill(manager, 157, g.orders, g.gapSlots);
    assert.strictEqual(anchored, 157, 'a fill already outside the window must not move the boundary');
}

function testHigherBuyFillAnchorsOneLevelLower() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const manager: any = makeRebuildManager(g);
    const fillPrice = slotPrice(g, 159);
    setFillPivot(manager, fillPrice, ORDER_TYPES.BUY);
    const anchored = anchorRebuildBoundaryToLastFill(manager, 159, g.orders, g.gapSlots);
    assert.strictEqual(anchored, 158, 'BUY fill at slot 159 => boundary 158');
}

function testSellMirror() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const manager: any = makeRebuildManager(g);
    const fillPrice = slotPrice(g, 162);
    setFillPivot(manager, fillPrice, ORDER_TYPES.SELL);
    const anchored = anchorRebuildBoundaryToLastFill(manager, 155, g.orders, g.gapSlots);
    assert.strictEqual(anchored, 158, 'SELL fill at slot 162 with gap 4 => boundary 158');
    const sellStart = MathUtils.getSellStartIdx(Number(anchored), g.gapSlots);
    assert.strictEqual(sellStart, 163, 'the filled sell level becomes the first band slot');
    assert.ok(Math.abs(spreadPct(g, Number(anchored), g.gapSlots) - 1.5) < 0.02,
        'the SELL mirror must keep the same 1.5% spread');
}

function testColdAndOffLadderStayPut() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const cold: any = makeRebuildManager(g);
    assert.strictEqual(anchorRebuildBoundaryToLastFill(cold, 159, g.orders, g.gapSlots), 159,
        'a cold pivot must not move the boundary');

    const offLadder: any = makeRebuildManager(g);
    // A trade far outside the generated lattice cannot be snapped onto it.
    setFillPivot(offLadder, 10, ORDER_TYPES.BUY);
    assert.strictEqual(anchorRebuildBoundaryToLastFill(offLadder, 159, g.orders, g.gapSlots), 159,
        'an off-ladder fill must not be snapped into geometry');
}

function testUnsortedSlotsUseTheLadder() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const manager: any = makeRebuildManager(g);
    setFillPivot(manager, 1447.8543857890913, ORDER_TYPES.BUY);
    const reversed = [...g.orders].reverse();
    const anchored = anchorRebuildBoundaryToLastFill(manager, 159, reversed, g.gapSlots);
    assert.strictEqual(anchored, 157, 'the anchor must index a price-sorted ladder, not caller array order');
}

function testApplyAnchorRetypesTheRails() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const manager: any = makeRebuildManager(g);
    setFillPivot(manager, 1447.8543857890913, ORDER_TYPES.BUY);
    // Deliberately unsorted: the combined helper must index the price ladder,
    // not the caller's array order (assignGridRoles classifies by position).
    const applied = applyRebuildFillAnchor(manager, g.boundaryIdx, [...g.orders].reverse(), g.gapSlots);

    assert.strictEqual(applied.boundaryIdx, 157, 'the combined helper must return the anchored boundary');
    assert.strictEqual(applied.slots.length, g.orders.length, 'retyping must not add/drop slots');
    assert.strictEqual(applied.slots[0].id, 'slot-0', 'the returned ladder must be price-sorted');
    assert.strictEqual(applied.slots[applied.slots.length - 1].id, `slot-${g.orders.length - 1}`,
        'the returned ladder must be price-sorted at the top');
    assert.strictEqual(applied.slots[157].type, ORDER_TYPES.BUY, 'slot-157 is the top buy');
    assert.deepStrictEqual(
        [158, 159, 160, 161].map((i) => applied.slots[i].type),
        [ORDER_TYPES.SPREAD, ORDER_TYPES.SPREAD, ORDER_TYPES.SPREAD, ORDER_TYPES.SPREAD],
        'the band must move with the anchored boundary'
    );
    assert.deepStrictEqual(
        [162, 163, 164].map((i) => applied.slots[i].type),
        [ORDER_TYPES.SELL, ORDER_TYPES.SELL, ORDER_TYPES.SELL],
        'the counter SELL levels must be typed SELL, not left SPREAD'
    );
}

function buildLoadManager(generation: ReturnType<typeof createOrderGrid>) {
    const logs: Array<{ msg: string; level?: string }> = [];
    const manager: any = {
        config: { ...REBUILD_CONFIG, startPrice: REBUILD_CONFIG.startPrice },
        logs,
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        funds: { btsFeesOwed: 0 },
        orders: new Map(),
        _gridVersion: 0,
        boundaryIdx: null,
        _gapSlots: null,
        _genesis: null,
        _missingGenesis: null,
        assets: {
            assetA: { id: '1.3.100', symbol: 'BASE', precision: 4 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        },
        initialSpreadCount: 0,
        currentSpreadCount: 0,
        _gridLock: { acquire: async (fn: any) => await fn() },
        _fundLock: { acquire: async (fn: any) => await fn() },
        _initializeAssets: async () => {},
        resetFunds: async () => {},
        pauseRecalcLogging: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        resumeRecalcLogging: async () => {},
        _applyOrderUpdate: async (order: any) => { manager.orders.set(order.id, Object.freeze({ ...order })); },
        _restoreBoundary: (newIdx: number) => { manager.boundaryIdx = newIdx; },
        accountOrders: {
            loadLastFillPivot: () => ({
                price: 1447.8543857890913,
                type: ORDER_TYPES.BUY,
                fillsAt: FILL_AT,
                genesisHash: generation.genesis.priceLevelsHash,
            }),
            loadChainSizeAppliedFills: () => ({}),
            clearPersistedBoundary: async () => {},
            clearPersistedLastFillPivot: async () => {},
        },
    };
    return manager;
}

async function testLoadGridAnchorsPersistedBoundary() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const manager = buildLoadManager(g);
    const persisted = g.orders.map((slot: any, idx: number) => {
        const isBuy = idx >= 138 && idx <= 157;
        const isSell = idx >= 164 && idx <= 183;
        return {
            ...slot,
            state: isBuy || isSell ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: isBuy ? 5040 : isSell ? 1.45 : 0,
            orderId: isBuy ? `1.7.${700000 + idx}` : isSell ? `1.7.${800000 + idx}` : '',
        };
    });

    await loadGrid(manager, persisted, 159, g.genesis);

    assert.strictEqual(manager.boundaryIdx, 157,
        'loadGrid must publish the anchored boundary, not keep the persisted 159');
    assert.strictEqual(manager.orders.get('slot-157')?.type, ORDER_TYPES.BUY,
        'slot-157 must remain the top buy');
    assert.deepStrictEqual(
        ['slot-158', 'slot-159', 'slot-160', 'slot-161'].map((id) => manager.orders.get(id)?.type),
        [ORDER_TYPES.SPREAD, ORDER_TYPES.SPREAD, ORDER_TYPES.SPREAD, ORDER_TYPES.SPREAD],
        'the four slots below the anchored boundary must be the empty band'
    );
    assert.deepStrictEqual(
        ['slot-162', 'slot-163', 'slot-164'].map((id) => manager.orders.get(id)?.type),
        [ORDER_TYPES.SELL, ORDER_TYPES.SELL, ORDER_TYPES.SELL],
        'sellStart must move to the fill counter (162)'
    );
    assert.ok(manager.logs.some((l: any) => /Re-anchored from the last fill/.test(l.msg)),
        'the load-time anchor must be logged');
    assert.ok(manager.logs.some((l: any) => /Restored boundary index: 157/.test(l.msg)),
        'the restored-boundary log must report the anchored value');
}

async function buildIncidentBook() {
    const g = createOrderGrid(REBUILD_CONFIG);
    const manager = new OrderManager(REBUILD_CONFIG as any);
    manager.assets = {
        assetA: { id: '1.3.100', symbol: 'BASE', precision: 4 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
    } as any;
    manager._genesis = g.genesis as any;
    manager._gapSlots = g.gapSlots;
    manager.boundaryIdx = 159;
    const logs: Array<{ msg: string; level?: string }> = [];
    manager.logger = { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) } as any;

    const activeBuys = new Set<number>();
    for (let i = 138; i <= 157; i++) activeBuys.add(i);
    const activeSells = new Set<number>();
    for (let i = 164; i <= 183; i++) activeSells.add(i);
    for (let i = 0; i < g.orders.length; i++) {
        const slot = g.orders[i];
        const isBuy = activeBuys.has(i);
        const isSell = activeSells.has(i);
        await (manager as any)._updateOrder({
            id: slot.id,
            price: slot.price,
            type: slot.type,
            state: isBuy || isSell ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: isBuy ? 5040 : isSell ? 1.45 : 0,
            orderId: isBuy ? `1.7.${700000 + i}` : isSell ? `1.7.${800000 + i}` : '',
        });
    }
    await manager.setAccountTotals({
        buy: 731928.6526,
        sell: 380.3824,
        buyFree: 286318.86,
        sellFree: 20,
    } as any);
    await manager.recalculateFunds();
    manager._lastFilledPrice = 1447.8543857890913;
    manager._lastFilledType = ORDER_TYPES.BUY;
    manager._lastFilledAt = FILL_AT;
    manager.lastFillPivotSource = 'fill';
    manager._lastSyncAt = Date.now();
    manager._liveMarketPrice = REBUILD_CONFIG.startPrice;
    manager._liveMarketPriceAt = Date.now() + 1;
    manager.requestStructuralGridResync = async () => ({ scheduled: true });
    return { manager, logs, generation: g };
}

async function testSpreadFallbackUsesFreeSellInventory() {
    MathUtils._setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.5 },
            limitOrderUpdate: { bts: 0.5 },
            limitOrderCancel: { bts: 0 },
            makerFeeDiscountPercent: 100,
        },
        BASE: {
            limitOrderCreate: { bts: 0.5 },
            limitOrderUpdate: { bts: 0.5 },
            limitOrderCancel: { bts: 0 },
        },
    } as any);

    const { manager, generation } = await buildIncidentBook();

    // The fund-preferred side really is BUY (free BTS vastly exceeds free BASE
    // in quote units), which is exactly why the planner has to fall back to
    // the opposite rail instead of treating "buy side empty" as "no repair".
    const preferred = Grid.determineOrderSideByFunds(manager, REBUILD_CONFIG.startPrice);
    assert.strictEqual(preferred.side, ORDER_TYPES.BUY,
        `fixture must select BUY from funds, got ${preferred.side} (${preferred.reason})`);

    // The fund-preferred BUY side is structurally blocked: the only
    // tightening levels are the fill level and above it.
    const blockedBuy = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 2);
    assert.strictEqual(blockedBuy.ordersToPlace.length, 0,
        'the BUY side must not re-place at/above the last buy fill');
    assert.strictEqual(blockedBuy.stallHint, 'last-fill-blocked',
        `the BUY bind must be named, got ${blockedBuy.stallHint}`);

    // The SELL fallback has free inventory and mints the two counter asks
    // (slot-163 nearest the live window, slot-162 the exact fill counter),
    // promoting the boundary 159 -> 157 so both land on the sell rail.
    const sell = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 2);
    const placedIds = sell.ordersToPlace.map((o: any) => o.id).sort();
    assert.deepStrictEqual(placedIds, ['slot-162', 'slot-163'],
        `the counter asks must be placed in the gap, got ${placedIds.join(',')}`);
    for (const order of sell.ordersToPlace) {
        assert.ok(Number(order.price) > 1447.8543857890913,
            `a counter SELL must sit above the last buy fill, got ${order.price}`);
    }
    assert.strictEqual(sell.boundaryIdx, 157,
        'placing the counter asks must promote the boundary so they are rail orders');
    const sellStart = MathUtils.getSellStartIdx(157, 4);
    assert.strictEqual(sellStart, 162, 'the promoted boundary must put sellStart at the fill counter');
    assert.ok(Math.abs(spreadPct(generation, 157, 4) - 1.5) < 0.02,
        `the promoted book must keep the 1.5% target spread, got ${spreadPct(generation, 157, 4).toFixed(3)}%`);
}

(async () => {
    console.log('\nREBUILD FILL ANCHOR');
    await run('RFA-1 incident BUY fill anchors boundary 159 -> 157, spread stays 1.5%', testIncidentBuyAnchor);
    await run('RFA-2 a fill already outside the window is a no-op', testAlreadyAnchoredIsNoOp);
    await run('RFA-3 BUY fill at the boundary anchors one level lower', testHigherBuyFillAnchorsOneLevelLower);
    await run('RFA-4 SELL fill mirror anchors the boundary and keeps the spread', testSellMirror);
    await run('RFA-5 cold / off-ladder fills never move geometry', testColdAndOffLadderStayPut);
    await run('RFA-6 unsorted caller slots are indexed on the price ladder', testUnsortedSlotsUseTheLadder);
    await run('RFA-7 free-fund SELL fallback places the counter asks + promotes the boundary', testSpreadFallbackUsesFreeSellInventory);
    await run('RFA-8 loadGrid publishes the anchored boundary and retypes the rails', testLoadGridAnchorsPersistedBoundary);
    await run('RFA-9 rebuild anchor retypes the rails atomically', testApplyAnchorRetypesTheRails);

    console.log(`\nREBUILD-FILL-ANCHOR summary: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();

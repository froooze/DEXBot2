/**
 * Pending fill crawls — consumed-fill rotation survival across refused
 * broadcasts, aborted plans, and restarts.
 *
 * Production incident (live bot 2026-09-10 02:52 restart): 4 buy fills
 * (slots 93-96) were processed under a null boundary, both fill batches
 * were refused at broadcast, and the restart restored the stale boundary
 * 96 with the fills deduped. Startup reconcile saw 4 in-window buy holes
 * and re-created BUYs at the exact filled prices — instead of the
 * rotation the grid logic demands (crawl down, refill lower, let the sell
 * rail take profit). Root cause: a processed fill whose derivation never
 * commits loses its crawl permanently; nothing records what is owed.
 *
 * Fix: strategy records every shift-eligible fill as a pending crawl
 * ({slotId, side, ts}); derivations incorporate owed entries (deduped
 * against the current batch, reserves excluded); any accepted non-null
 * commit clears the record; startup applies owed crawls onto the restored
 * boundary (validated placed-order-aware) before reconcile. An absolute
 * fill anchor (Tier 1) subsumes all history, so it ignores owed entries
 * rather than double-counting them.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../modules/paths');
const { AccountOrders, createBotKey } = require('../modules/account_orders');
const StrategyEngine = require('../modules/order/strategy').default;
const {
    deriveTargetBoundary,
    consumePendingFillCrawls,
    edgeOrderIdSet,
    resolveLiveEdgeAnchorPrice,
} = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { applyPersistedPendingCrawls, offMarketFill } = require('../modules/order/utils/system');
const { loadGrid } = require('../modules/order/grid');
const { buildGenesisFromPriceLevels, calculateGapSlots } = require('../modules/order/utils/math');

const GAP = 4;
const N_SLOTS = 216;
const CFG = { startPrice: 'pool', coreOrders: { buy: 20, sell: 20 } };

// AccountOrders persists next to the resolved profiles dir, which may be the
// repo or the home config. Never hardcode `profiles/orders` — resolve it.
const ordersPath = (botKey) => path.join(PATHS.ORDERS_DIR, `${botKey}.json`);

function buildSlots(count) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        slots.push({ id: `slot-${i}`, price: 0.001 + i * 0.000004, type: ORDER_TYPES.BUY });
    }
    return slots;
}

function buyFill(i, partial = false) {
    return {
        id: `slot-${i}`,
        type: ORDER_TYPES.BUY,
        price: 0.001 + i * 0.000004,
        isPartial: partial,
    };
}

// Full 216-slot master shaped around boundary 96: live buys <=92, holes at
// 93-96, gap 97-100, live sells 101+. Extra placed sells can be injected
// into the band to prove the startup validator refuses unsafe applies.
function buildMaster(extraPlaced = []) {
    const orders = new Map();
    for (let i = 0; i < N_SLOTS; i++) {
        let type = ORDER_TYPES.BUY;
        let state = ORDER_STATES.ACTIVE;
        let orderId = `1.7.${1000 + i}`;
        if (i >= 93 && i <= 96) {
            state = ORDER_STATES.VIRTUAL;
            orderId = '';
        } else if (i >= 97 && i <= 100) {
            type = ORDER_TYPES.SPREAD;
            state = ORDER_STATES.VIRTUAL;
            orderId = '';
        } else if (i >= 101) {
            type = ORDER_TYPES.SELL;
        }
        orders.set(`slot-${i}`, {
            id: `slot-${i}`,
            price: 0.001 + i * 0.000004,
            type,
            state,
            orderId,
            size: state === ORDER_STATES.VIRTUAL ? 0 : 100,
        });
    }
    for (const [id, type, orderId] of extraPlaced) {
        const slot = orders.get(id);
        slot.type = type;
        slot.state = ORDER_STATES.ACTIVE;
        slot.orderId = orderId;
        slot.size = 100;
    }
    return orders;
}

function mockManager(boundary, orders, pending, config: any = CFG): any {
    return {
        boundaryIdx: boundary,
        orders,
        // The live reserve anchor comes from the frozen ladder (the ladder
        // extremes ARE the live rail bounds); slot-0's level is the buy floor.
        _genesis: buildGenesisFromPriceLevels(0.001, 1, GAP, buildSlots(N_SLOTS).map((s) => s.price)),
        config,
        _gapSlots: GAP,
        _pendingFillCrawls: pending,
        _restoreBoundary(v) { this.boundaryIdx = v; },
        _markGridDirty() { this.dirtied = true; },
    };
}

async function testPending_IncorporatedIncrementally() {
    console.log('\n[PEND-001] owed entries shift alongside current fills...');
    const { boundaryIdx } = deriveTargetBoundary(
        [buyFill(95)],
        96,
        buildSlots(N_SLOTS),
        CFG,
        GAP,
        null,
        [{ slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 }, { slotId: 'slot-94', side: ORDER_TYPES.BUY, ts: 2 }]
    );
    assert.strictEqual(boundaryIdx, 93, `1 current + 2 owed buys must crawl 96 -> 93 (got ${boundaryIdx})`);
    console.log('✓ PEND-001 passed');
}

async function testPending_CurrentBatchDeduped() {
    console.log('\n[PEND-002] current-batch slots are not double-counted...');
    const { boundaryIdx } = deriveTargetBoundary(
        [buyFill(95)],
        96,
        buildSlots(N_SLOTS),
        CFG,
        GAP,
        null,
        [{ slotId: 'slot-95', side: ORDER_TYPES.BUY, ts: 1 }]
    );
    assert.strictEqual(boundaryIdx, 95, `same slot in batch and pending must crawl once (got ${boundaryIdx})`);
    console.log('✓ PEND-002 passed');
}

async function testPending_AbsoluteAnchorSubsumes() {
    console.log('\n[PEND-003] Tier-1 anchor ignores owed entries (no double count)...');
    const { boundaryIdx } = deriveTargetBoundary(
        [96, 95, 94, 93].map((i) => buyFill(i)),
        null,
        buildSlots(N_SLOTS),
        CFG,
        GAP,
        null,
        [92, 91, 90].map((i) => ({ slotId: `slot-${i}`, side: ORDER_TYPES.BUY, ts: 1 }))
    );
    assert.strictEqual(boundaryIdx, 93, `absolute anchor must land at the fill edge, not 93-3 (got ${boundaryIdx})`);
    console.log('✓ PEND-003 passed');
}

async function testPending_GenesisAnchorKeepsOwed() {
    console.log('\n[PEND-004] non-fill anchor (genesis) still shifts owed entries...');
    const slots = buildSlots(N_SLOTS);
    const genesisStart = 0.0015;
    const split = slots.findIndex((s) => s.price >= genesisStart);
    const { boundaryIdx } = deriveTargetBoundary(
        [{ id: 'slot-100', type: ORDER_TYPES.SELL, isPartial: true, isDelayedRotationTrigger: true }],
        null,
        slots,
        { ...CFG, genesisStartPrice: genesisStart },
        GAP,
        null,
        [{ slotId: 'slot-101', side: ORDER_TYPES.SELL, ts: 1 }]
    );
    // Genesis anchor (split-3) + current dust crawl (+1) + owed sell (+1).
    const want = split - Math.floor(GAP / 2) - 1 + 2;
    assert.strictEqual(boundaryIdx, want, `genesis anchor plus two owed crawls (got ${boundaryIdx}, want ${want})`);
    console.log('✓ PEND-004 passed');
}

async function testPending_ReserveEntriesSkipped() {
    console.log('\n[PEND-005] reserve-slot entries never crawl...');
    const cfg = { ...CFG, edgeOrders: { buy: 2, sell: 0 } };
    const { boundaryIdx } = deriveTargetBoundary(
        [buyFill(95)],
        96,
        buildSlots(N_SLOTS),
        cfg,
        GAP,
        null,
        [{ slotId: 'slot-0', side: ORDER_TYPES.BUY, ts: 1 }]
    );
    assert.strictEqual(boundaryIdx, 95, `floor-reserve entry must not shift (got ${boundaryIdx})`);
    console.log('✓ PEND-005 passed');
}

async function testConsume_AppliesOntoRestored() {
    console.log('\n[PEND-006] startup applies owed crawls onto the restored boundary...');
    const mgr = mockManager(96, buildMaster(), [
        { slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 },
        { slotId: 'slot-94', side: ORDER_TYPES.BUY, ts: 2 },
        { slotId: 'slot-95', side: ORDER_TYPES.BUY, ts: 3 },
        { slotId: 'slot-96', side: ORDER_TYPES.BUY, ts: 4 },
    ]);
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, true, `must apply (${result.reason ?? 'no reason'})`);
    assert.strictEqual(result.from, 96, 'must start from the restored boundary');
    assert.strictEqual(result.to, 92, `4 owed buys must crawl 96 -> 92 (got ${result.to})`);
    assert.strictEqual(result.count, 4, 'all four entries owed');
    assert.deepStrictEqual(mgr._pendingFillCrawls, [], 'consumed entries must clear');
    assert.strictEqual(mgr.dirtied, true, 'grid must be marked dirty for persist');
    console.log('✓ PEND-006 passed');
}

async function testConsume_DropsOnNull() {
    console.log('\n[PEND-007] null restored boundary drops entries (Tier 1 owns)...');
    const mgr = mockManager(null, buildMaster(), [{ slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 }]);
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, false, 'must not apply without an anchor');
    assert.strictEqual(result.reason, 'null-boundary', `reason must name the cause (got ${result.reason})`);
    assert.deepStrictEqual(mgr._pendingFillCrawls, [], 'stale entries must clear');
    console.log('✓ PEND-007 passed');
}

async function testConsume_DropsOnEmptyStringBoundary() {
    console.log('\n[PEND-007b] empty-string boundary drops entries (Number("") === 0 trap)...');
    const mgr = mockManager('' as any, buildMaster(), [{ slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 }]);
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, false, 'must not apply an empty-string boundary');
    assert.strictEqual(result.reason, 'null-boundary', `reason must name the cause (got ${result.reason})`);
    assert.deepStrictEqual(mgr._pendingFillCrawls, [], 'stale entries must clear');
    console.log('✓ PEND-007b passed');
}

async function testConsume_DropsUnsafe() {
    console.log('\n[PEND-008] apply refuses to strand a placed order...');
    // A live SELL sits at slot-95: crawling 96 -> 92 would strand it in-band.
    const mgr = mockManager(96, buildMaster([['slot-95', ORDER_TYPES.SELL, '1.7.999']]), [
        { slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 },
        { slotId: 'slot-94', side: ORDER_TYPES.BUY, ts: 2 },
        { slotId: 'slot-95', side: ORDER_TYPES.BUY, ts: 3 },
        { slotId: 'slot-96', side: ORDER_TYPES.BUY, ts: 4 },
    ]);
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, false, 'must not strand the placed sell');
    assert.ok(String(result.reason).startsWith('unsafe'), `reason must flag safety (got ${result.reason})`);
    assert.strictEqual(mgr.boundaryIdx, 96, 'boundary must stay put');
    console.log('✓ PEND-008 passed');
}

async function testConsume_LiveAnchorClassifies() {
    console.log('\n[PEND-011] startup classifies reserves with the ladder anchor, not the config fallback...');
    // Stale leftover: a BUY-typed VIRTUAL slot left above the buy rail by an
    // older bound, priced below the live floor. The ladder anchor (the buy
    // rail's lowest level) ranks it out of the reserve set, so its crawl is
    // owed; the config-bound fallback is null for mode-string bounds, and
    // plain rank would make it a reserve and drop the crawl.
    const orders = buildMaster();
    Object.assign(orders.get('slot-210'), {
        type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', price: 0.0005, size: 0,
    });
    const mgr = mockManager(96, orders, [{ slotId: 'slot-210', side: ORDER_TYPES.BUY, ts: 1 }],
        { ...CFG, edgeOrders: { buy: 2, sell: 0 } });
    const allSlots = Array.from(orders.values());
    const liveAnchor = resolveLiveEdgeAnchorPrice(mgr, 'buy');
    const liveReserveIds = edgeOrderIdSet(allSlots, mgr.config, ORDER_TYPES.BUY, liveAnchor);
    const configAnchorIds = edgeOrderIdSet(allSlots, mgr.config, ORDER_TYPES.BUY);
    assert.strictEqual(liveAnchor, 0.001, 'live anchor is the ladder bottom (buy rail floor)');
    assert.ok(!liveReserveIds.has('slot-210'), 'ladder anchor must not rank the stale leftover as a reserve');
    assert.ok(configAnchorIds.has('slot-210'), 'config fallback would (the drift this pins down)');
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, true, `live-anchored classification must apply the crawl (${result.reason ?? 'no reason'})`);
    assert.strictEqual(result.to, 95, `one owed buy must crawl 96 -> 95 (got ${result.to})`);
    console.log('✓ PEND-011 passed');
}

async function testPersist_RoundTripAndClear() {
    console.log('\n[PEND-009] storeMasterGrid sanitizes, round-trips, and clears pending crawls...');
    const botKey = createBotKey({ name: 'pending-crawl-test' }, 0);
    const accountOrders = new AccountOrders({ botKey });
    try {
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, [
            { slotId: 'slot-93', side: 'buy', ts: 1 },
            { slotId: '', side: 'buy', ts: 2 },
            { slotId: 'slot-94', side: 'sideways', ts: 3 },
            { slotId: 'slot-95', side: 'sell', ts: NaN },
            { slotId: 'slot-96', side: 'sell', ts: 4 },
        ]);
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(), [
            { slotId: 'slot-93', side: 'buy', ts: 1 },
            { slotId: 'slot-96', side: 'sell', ts: 4 },
        ], 'only well-formed entries survive');
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, []);
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(), [],
            'empty array must clear, not resurrect consumed entries');
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined,
            [{ slotId: 'slot-97', side: 'buy', ts: 5 }]);
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null);
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(), [{ slotId: 'slot-97', side: 'buy', ts: 5 }],
            'undefined param is a no-op (backward compatible callers)');
    } finally {
        try { fs.unlinkSync(ordersPath(botKey)); } catch { /* absent */ }
    }
    console.log('✓ PEND-009 passed');
}

async function testRecord_PushDedupesSlot() {
    console.log('\n[PEND-010] reprocessed fills replace, never stack, ineligible fills skip...');
    const mgr = {
        orders: new Map([
            ['slot-93', { id: 'slot-93', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', size: 0, price: 0.001372 }],
            ['slot-94', { id: 'slot-94', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', size: 0, price: 0.001376 }],
        ]),
        logger: { log() {} },
        config: {},
        _pendingFillCrawls: [],
        _markGridDirty() {},
        recalculateFunds() {},
    };
    const strategy = new StrategyEngine(mgr);
    const fill = { id: 'slot-93', type: ORDER_TYPES.BUY, price: 0.001372, size: 1.8, isPartial: false };
    await strategy.processFillsOnly([fill]);
    await strategy.processFillsOnly([fill]);
    assert.strictEqual(mgr._pendingFillCrawls.length, 1, 'same slot must not stack');
    assert.strictEqual(mgr._pendingFillCrawls[0].slotId, 'slot-93', 'newest entry wins');
    await strategy.processFillsOnly([{ id: 'slot-94', type: ORDER_TYPES.BUY, price: 0.001376, size: 0.5, isPartial: true }]);
    assert.strictEqual(mgr._pendingFillCrawls.length, 1, 'ineligible partial must not record');
    console.log('✓ PEND-010 passed');
}

// Fake bot for applyPersistedPendingCrawls: the store is a canned array and the
// manager is the same shape the consume tests use, plus a persistGrid spy.
function makeApplyBot(boundary, orders, persisted, config = CFG) {
    const manager = mockManager(boundary, orders, [], config);
    let persistCalls = 0;
    manager.persistGrid = async () => { persistCalls += 1; };
    const loadCalls = [];
    const bot = {
        accountOrders: {
            loadPendingFillCrawls(forceReload) { loadCalls.push(forceReload); return persisted; },
        },
        manager,
    };
    return { bot, manager, loadCalls, getPersistCalls: () => persistCalls };
}

async function testApplyPersisted_AppliesAndPersists() {
    console.log('\n[PEND-012] applyPersistedPendingCrawls applies owed crawls and persists before reconcile...');
    const { bot, manager, loadCalls, getPersistCalls } = makeApplyBot(96, buildMaster(), [
        { slotId: 'slot-93', side: 'buy', ts: 1 },
        { slotId: 'slot-94', side: 'buy', ts: 2 },
    ]);
    const lines = [];
    const result = await applyPersistedPendingCrawls(bot, { log: (msg, level) => lines.push({ msg, level }) });
    assert.strictEqual(result.applied, true, `must apply (${result.reason ?? 'no reason'})`);
    assert.strictEqual(result.from, 96, 'must start from the restored boundary');
    assert.strictEqual(result.to, 94, `2 owed buys must crawl 96 -> 94 (got ${result.to})`);
    assert.strictEqual(result.count, 2, 'both persisted entries owed');
    assert.strictEqual(manager.boundaryIdx, 94, 'boundary must move by the expected delta');
    assert.deepStrictEqual(manager._pendingFillCrawls, [], 'applied entries must clear');
    assert.strictEqual(getPersistCalls(), 1, 'persistGrid awaited exactly once');
    assert.deepStrictEqual(loadCalls, [false], 'store read with forceReload=false');
    const applied = lines.find((l) => String(l.msg).includes(
        '[BOUNDARY] Applied 2 pending fill crawl(s): boundary 96 -> 94; persisting before reconcile'));
    assert.ok(applied, `log sink must receive the applied line (got ${JSON.stringify(lines)})`);
    assert.strictEqual(applied.level, 'warn', 'applied line is a warn');
    console.log('✓ PEND-012 passed');
}

async function testApplyPersisted_NoOpOnEmptyStore() {
    console.log('\n[PEND-013] applyPersistedPendingCrawls is a no-op on an empty store...');
    const { bot, manager, loadCalls, getPersistCalls } = makeApplyBot(96, buildMaster(), []);
    const lines = [];
    const result = await applyPersistedPendingCrawls(bot, { log: (msg, level) => lines.push({ msg, level }) });
    assert.strictEqual(result.applied, false, 'nothing persisted means nothing to apply');
    assert.strictEqual(getPersistCalls(), 0, 'no persistGrid call without an apply');
    assert.strictEqual(manager.boundaryIdx, 96, 'boundary must stay put');
    assert.deepStrictEqual(manager._pendingFillCrawls, [], 'no entries seeded');
    assert.deepStrictEqual(loadCalls, [false], 'store still read');
    assert.strictEqual(lines.length, 0, `empty store must not log (got ${JSON.stringify(lines)})`);
    console.log('✓ PEND-013 passed');
}

// Minimal real-manager fixture for _commitWorkingGrid: six virtual slots, a
// finite boundary (2) with a one-slot gap, and one owed crawl. All slots are
// VIRTUAL (no orderId), so the boundary gate only checks geometry — the point
// here is the pending-crawl bookkeeping, not placed-order validation.
function createCommitFixture() {
    const manager = new OrderManager({
        assetA: 'BTS', assetB: 'USD', startPrice: 1, incrementPercent: 0.5,
        logging: { level: 'error' },
    });
    const logs = [];
    manager.logger = { log: (msg, level) => logs.push({ msg: String(msg), level }) };
    manager.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 },
    };
    manager.recalculateFunds = async () => { /* commit fixture: no accounting */ };
    manager._gapSlots = 1;
    manager.boundaryIdx = 2;
    manager._gridVersion = 3;

    const master = new Map();
    for (let i = 0; i < 6; i++) {
        master.set(`slot-${i}`, {
            id: `slot-${i}`,
            type: i <= 2 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 1 + i * 0.01,
            size: 0,
            orderId: '',
        });
    }
    manager.orders = Object.freeze(master);
    for (const [id, order] of master) {
        manager._ordersByState[order.state].add(id);
        manager._ordersByType[order.type].add(id);
    }
    manager._pendingFillCrawls = [{ slotId: 'slot-2', side: ORDER_TYPES.BUY, ts: 1 }];
    return { manager, logs };
}

function buildCommitWorkingGrid(manager) {
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    workingGrid.set('slot-0', { ...manager.orders.get('slot-0'), price: 1.5 });
    return workingGrid;
}

async function testCommit_BoundaryHeldKeepsOwedCrawls() {
    console.log('\n[PEND-014] a held-boundary commit keeps owed crawls...');
    const { manager, logs } = createCommitFixture();
    const workingGrid = buildCommitWorkingGrid(manager);
    const accepted = await manager._commitWorkingGrid(
        workingGrid, workingGrid.getIndexes(), manager.boundaryIdx, { boundaryHeld: true });
    assert.strictEqual(accepted, true, 'commit must be accepted');
    assert.strictEqual(manager.boundaryIdx, 2, 'held commit keeps the committed boundary');
    assert.strictEqual(manager._pendingFillCrawls.length, 1, 'held boundary derived nothing — crawls stay owed');
    assert.strictEqual(manager._pendingFillCrawls[0].slotId, 'slot-2', 'the owed entry survives intact');
    assert.ok(!logs.some((l) => l.msg.includes('Dropped')), 'no drop line for a held boundary');
    console.log('✓ PEND-014 passed');
}

async function testCommit_AppliedBoundaryClearsOwedCrawls() {
    console.log('\n[PEND-015] a control commit that advances the boundary clears owed crawls...');
    const { manager, logs } = createCommitFixture();
    const workingGrid = buildCommitWorkingGrid(manager);
    const advanced = manager.boundaryIdx + 1;
    // The commit consumes exactly what the plan's derivation folded
    // (`consumedCrawlIds`, produced by deriveTargetBoundary); a commit without
    // that wire consumes NOTHING by design, so the fixture must supply it the
    // way the COW executor does.
    const accepted = await manager._commitWorkingGrid(
        workingGrid, workingGrid.getIndexes(), advanced,
        { consumedCrawlIds: (manager._pendingFillCrawls as Array<{ slotId: string; side: string; ts?: number }>).slice() });
    assert.strictEqual(accepted, true, 'commit must be accepted');
    assert.strictEqual(manager.boundaryIdx, advanced, 'boundary must actually advance');
    assert.deepStrictEqual(manager._pendingFillCrawls, [], 'an applied boundary consumes the owed crawls');
    assert.ok(logs.some((l) => l.msg.includes('Dropped 1 owed fill crawl(s) (boundary commit)')),
        'drop is logged at commit');
    console.log('✓ PEND-015 passed');
}

async function testClearGrid_WipesPersistedCrawls() {
    console.log('\n[PEND-016] clearGrid wipes persisted crawls (rebuild re-anchors absolutely)...');
    const botKey = createBotKey({ name: 'pending-crawl-clear-test' }, 0);
    const accountOrders = new AccountOrders({ botKey });
    try {
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, [
            { slotId: 'slot-93', side: 'buy', ts: 1 },
            { slotId: 'slot-94', side: 'sell', ts: 2 },
        ]);
        assert.strictEqual(accountOrders.loadPendingFillCrawls().length, 2, 'entries stored');
        await accountOrders.clearGrid();
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(), [],
            'clearGrid must drop persisted crawls so the next generation cannot inherit them');
        const onDisk = fs.readFileSync(ordersPath(botKey), 'utf8');
        assert.ok(!onDisk.includes('pendingFillCrawls'),
            'the persisted pendingFillCrawls key must be gone from disk, not merely shadowed in memory');
    } finally {
        try { fs.unlinkSync(ordersPath(botKey)); } catch { /* absent */ }
    }
    console.log('✓ PEND-016 passed');
}

async function testClearPending_DirtyOnlyWhenClearing() {
    console.log('\n[PEND-017] _clearPendingFillCrawls clears and marks dirty; empty is a no-op...');
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1, logging: { level: 'error' } });
    manager.logger = { log() {} };
    manager._pendingFillCrawls = [{ slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 }];
    manager._gridDirtyAt = null;
    manager._clearPendingFillCrawls('unit');
    assert.deepStrictEqual(manager._pendingFillCrawls, [], 'non-empty array must clear');
    assert.notStrictEqual(manager._gridDirtyAt, null, 'clearing must mark the grid dirty');

    manager._gridDirtyAt = null;
    manager._clearPendingFillCrawls('unit-empty');
    assert.deepStrictEqual(manager._pendingFillCrawls, [], 'still empty');
    assert.strictEqual(manager._gridDirtyAt, null, 'empty array must not mark the grid dirty');
    console.log('✓ PEND-017 passed');
}

// [PEND-018] The relative-delta ledger is only safe because (orders, boundary,
// pendingFillCrawls) are ONE persisted generation: storeMasterGrid writes all
// three under a single lock, and every reload path re-reads them from that same
// generation. This pins the consequence the pairing buys — a commit whose
// persist is skipped (persist-guard retry path) does not double-count on
// restart: the restart replays the commit exactly once, because disk still
// holds the PRE-commit grid + boundary + crawls together. Uses the real
// AccountOrders store, real loadGrid, real _commitWorkingGrid and the real
// applyPersistedPendingCrawls helper.
const GEOM_CFG = {
    startPrice: 1,
    incrementPercent: 0.5,
    targetSpreadPercent: 2.5,   // calculateGapSlots(0.5, 2.5) === GAP
    coreOrders: { buy: 20, sell: 20 },
};

function buildPersistableMaster(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
        let type = ORDER_TYPES.BUY;
        let state = ORDER_STATES.ACTIVE;
        let orderId = `1.7.${1000 + i}`;
        let size = 100;
        if (i >= 93 && i <= 96) { state = ORDER_STATES.VIRTUAL; orderId = ''; size = 0; }
        else if (i >= 97 && i <= 100) { type = ORDER_TYPES.SPREAD; state = ORDER_STATES.VIRTUAL; orderId = ''; size = 0; }
        else if (i >= 101) { type = ORDER_TYPES.SELL; }
        arr.push({ id: `slot-${i}`, price: 0.001 + i * 0.000004, type, state, orderId, size });
    }
    return arr;
}

/**
 * The ladder for the linear-price fixture grid (0.001 + i*0.000004).
 * loadGrid requires a ladder for a non-empty snapshot (genesis invariant), and
 * a linear fixture rail can never match the geometric migration rail — so the
 * snapshot carries its own genesis, exactly as a real one does.
 */
function fixtureGenesis(count = N_SLOTS) {
    const levels = [];
    for (let i = 0; i < count; i++) levels.push(0.001 + i * 0.000004);
    return buildGenesisFromPriceLevels(0.001 + (count / 2) * 0.000004, 0.5, GAP, levels);
}

function createGeomManager() {
    const manager = new OrderManager({
        assetA: 'BTS', assetB: 'USD', ...GEOM_CFG, logging: { level: 'error' },
    });
    manager.logger = { log() {} };
    manager.recalculateFunds = async () => { /* commit fixture: no accounting */ };
    // Commit-time delta comparison needs both precisions; loadGrid() would
    // otherwise run a real blockchain asset-metadata lookup. This fixture
    // asserts store/memory generation pairing, not asset discovery.
    manager.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 },
    };
    manager._initializeAssets = async () => manager.assets;
    return manager;
}

async function testPersistSkip_RestartReplaysCommitOnce() {
    console.log('\n[PEND-018] skipped persist after a commit replays exactly once on restart...');
    const botKey = createBotKey({ name: 'pending-crawl-generation-test' }, 0);
    const accountOrders = new AccountOrders({ botKey });
    const persistedPath = ordersPath(botKey);
    const B0 = 96;
    const B1 = 94;
    try {
        // Generation on disk: boundary 96 with two owed buy crawls (93, 94).
        await accountOrders.storeMasterGrid(buildPersistableMaster(N_SLOTS), 0, B0,
            null, null, null, fixtureGenesis(), undefined, [
                { slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 },
                { slotId: 'slot-94', side: ORDER_TYPES.BUY, ts: 2 },
            ]);
        assert.strictEqual(accountOrders.loadBoundaryIdx(true), B0, 'fixture boundary persisted');
        assert.strictEqual(accountOrders.loadPendingFillCrawls(true).length, 2, 'fixture crawls persisted');

        // Live run: the generation is loaded and the crawls are owed in memory.
        const live = createGeomManager();
        live.accountOrders = accountOrders;
        await loadGrid(live, accountOrders.loadGrid(true), accountOrders.loadBoundaryIdx(true),
            accountOrders.loadGenesis?.(true) ?? null);
        assert.strictEqual(live.boundaryIdx, B0, 'persisted boundary must load as-is');
        assert.strictEqual(live._gapSlots, GAP, 'config must yield the fixture geometry');
        live._pendingFillCrawls = accountOrders.loadPendingFillCrawls(true).map((e) => ({ ...e }));

        // Accepted commit consumes the owed movement (96 -> 94).
        const workingGrid = new WorkingGrid(live.orders, { baseVersion: live._gridVersion });
        workingGrid.set('slot-0', { ...live.orders.get('slot-0'), size: 101 });
        // The COW executor always supplies the derivation's consumed set; the
        // commit consumes exactly those records (a wire-less commit consumes
        // nothing by design).
        const accepted = await live._commitWorkingGrid(
            workingGrid, workingGrid.getIndexes(), B1, {
                skipRecalc: true,
                consumedCrawlIds: live._pendingFillCrawls.map((e) => ({ ...e }))
            });
        assert.strictEqual(accepted, true, 'commit must be accepted');
        assert.strictEqual(live.boundaryIdx, B1, 'commit applies the owed crawl');
        assert.deepStrictEqual(live._pendingFillCrawls, [], 'commit consumes the owed crawls in memory');

        // Persist SKIPPED (persist-guard retry path): disk keeps the OLD
        // generation, which is exactly why the restart cannot double-count.
        assert.strictEqual(accountOrders.loadBoundaryIdx(true), B0, 'skipped persist leaves the old boundary');
        assert.strictEqual(accountOrders.loadPendingFillCrawls(true).length, 2, 'skipped persist leaves the old crawls');

        // Restart from disk: the crawls apply onto the boundary they were
        // recorded against, reproducing the committed boundary exactly once.
        const restarted = createGeomManager();
        restarted.accountOrders = accountOrders;
        await loadGrid(restarted, accountOrders.loadGrid(true), accountOrders.loadBoundaryIdx(true),
            accountOrders.loadGenesis?.(true) ?? null);
        const res = await applyPersistedPendingCrawls(
            { accountOrders, manager: restarted },
            { forceReload: true, log: () => { /* silence */ } });
        assert.strictEqual(res.applied, true, `restart must apply the persisted crawls (${res.reason ?? 'ok'})`);
        assert.strictEqual(res.from, B0, 'replay starts from the persisted boundary');
        assert.strictEqual(res.to, B1, 'replay lands on the committed boundary');
        assert.strictEqual(restarted.boundaryIdx, B1,
            'restart replays the commit once (94 = replay, 92 = double count, 96 = lost)');
        assert.strictEqual(accountOrders.loadBoundaryIdx(true), B1, 'replayed boundary reaches disk');
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(true), [], 'consumed crawls leave disk too');
    } finally {
        try { fs.unlinkSync(persistedPath); } catch { /* absent */ }
    }
    console.log('✓ PEND-018 passed');
}

async function testPending_AllEligibleFillsCrawl() {
    console.log('\n[PEND-019] every eligible fill contributes a crawl; no market filter...');
    // slot 95 is one step from the mid; slot 80 is ~16 steps away — a sweep
    // the old offMarketFill predicate discarded. Fill-authoritative: both
    // fills are window evidence, so both crawl the boundary.
    const { boundaryIdx } = deriveTargetBoundary(
        [buyFill(80), buyFill(95)],
        96,
        buildSlots(N_SLOTS),
        CFG,
        GAP,
        null,
        null,
        null
    );
    assert.strictEqual(boundaryIdx, 94, `both fills must crawl 96 -> 94 (got ${boundaryIdx})`);
    // offMarketFill is now neutral even for a caller that still consults it.
    const mid = 0.001 + 95 * 0.000004;
    const mgr = { config: CFG, _liveMarketPrice: mid, _liveMarketPriceAt: Date.now() };
    assert.strictEqual(offMarketFill(mgr, ORDER_TYPES.BUY, 0.001 + 80 * 0.000004), null,
        'the cached mid can no longer veto a sweep fill');
    // The live strategy call site must not inject a market predicate at all.
    const strategySrc = fs.readFileSync(path.join(__dirname, '../../modules/order/strategy.ts'), 'utf8');
    const deriveAt = strategySrc.indexOf('deriveTargetBoundary(fills');
    assert.ok(deriveAt > 0, 'the strategy derivation call must exist');
    const call = strategySrc.slice(deriveAt, strategySrc.indexOf(';', deriveAt));
    assert.ok(!/offMarketFill|isCrawlEligible/.test(call),
        `no crawl predicate may be injected at the live call site (got ${call})`);
    console.log('✓ PEND-019 passed');
}

async function main() {
    await testPending_IncorporatedIncrementally();
    await testPending_CurrentBatchDeduped();
    await testPending_AbsoluteAnchorSubsumes();
    await testPending_GenesisAnchorKeepsOwed();
    await testPending_ReserveEntriesSkipped();
    await testPending_AllEligibleFillsCrawl();
    await testConsume_AppliesOntoRestored();
    await testConsume_DropsOnNull();
    await testConsume_DropsOnEmptyStringBoundary();
    await testConsume_DropsUnsafe();
    await testConsume_LiveAnchorClassifies();
    await testPersist_RoundTripAndClear();
    await testRecord_PushDedupesSlot();
    await testApplyPersisted_AppliesAndPersists();
    await testApplyPersisted_NoOpOnEmptyStore();
    await testCommit_BoundaryHeldKeepsOwedCrawls();
    await testCommit_AppliedBoundaryClearsOwedCrawls();
    await testClearGrid_WipesPersistedCrawls();
    await testClearPending_DirtyOnlyWhenClearing();
    await testPersistSkip_RestartReplaysCommitOnce();
    console.log('\nAll pending-crawl tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

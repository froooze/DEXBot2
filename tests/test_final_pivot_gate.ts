/**
 * Regression tests for the final pre-broadcast pivot gate (Step 1):
 *  1. runFinalPivotGate — re-checks BUILT ops against a re-refreshed pivot
 *     right before broadcast (2026-09-13 incident on a live market-pair
 *     bot: freeze at .745, fill queued at .765, broadcast at .910 — every
 *     per-action check passed on the stale pivot, summary printed
 *     pivotRefreshed=false).
 *  2. Fail-open: unresolvable price/type, cold pivot, refresh throw => KEEP.
 *  3. Bypass parity with the build loop: spread-correction CREATEs and
 *     stamped gap-evacuation UPDATEs bypass; unstamped evacuations are
 *     guarded normally.
 *  4. Lockstep compaction: kept ops/contexts stay aligned; dropped CREATE
 *     pending entries are removed by slot; kept entries' stored opIndex/
 *     ctxIndex are remapped to the compacted positions (FG-7/FG-11), so the
 *     uncertain-broadcast reconcile still resolves each kept entry to the
 *     very context it was recorded with; sibling batches' entries untouched.
 *  5. Cancel + size-update ops are never gated or dropped.
 *  6. Incident replay: both violating rotations (879.30 + 881.95 @ 0.3%
 *     against the 884.60 sell pivot) are dropped, healthy ops kept.
 */
const assert = require('assert');
const {
    isLastFillGuardBlocked,
    refreshLastFillPivotFromQueue,
    runFinalPivotGate,
} = require('../modules/dexbot_cow_runtime');
const { ORDER_TYPES, COW_ACTIONS } = require('../modules/constants');

const INC = 0.3;
const SELL_PIVOT = 884.60423;
const SELL_THR = SELL_PIVOT * (1 + (INC / 2) / 100); // 885.931136...

function makeAssets() {
    return {
        assetA: { id: '1.3.5537', precision: 4, symbol: 'XRP' },
        assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
    };
}

function makeMgr(over: any = {}) {
    const orders = new Map();
    for (const s of (over.slots || [])) orders.set(s.id, s);
    return {
        orders,
        assets: makeAssets(),
        config: { incrementPercent: INC },
        _lastFilledPrice: 866.193898,
        _lastFilledType: ORDER_TYPES.BUY,
        _lastFilledBuyPrice: 866.193898,
        _lastFilledSellPrice: null,
        logger: { log: () => {} },
        _pendingBroadcasts: new Map(),
        ...(over.mgr || {}),
    };
}

function makeBot(over: any = {}) {
    return {
        _incomingFillQueue: over.queue !== undefined ? over.queue : [],
        manager: makeMgr(over),
        ...(over.bot || {}),
    };
}

function rotCtx(slotId, orderId, price, size, type, srcId = 'slot-src') {
    return {
        kind: 'rotation',
        rotation: {
            oldOrder: { id: srcId },
            newGridId: slotId,
            newPrice: price,
            newSize: size,
            type,
        },
    };
}

function createCtx(slotId, price, size, type) {
    return {
        kind: 'create',
        id: slotId,
        order: { id: slotId, type, price, size },
        args: {},
        finalInts: { sell: 1, receive: 2 },
    };
}

function rotAction(srcId, orderId, destId, price, size, type, extra = {}) {
    return {
        type: COW_ACTIONS.UPDATE,
        id: srcId,
        orderId,
        newGridId: destId,
        newPrice: price,
        newSize: size,
        order: { id: destId, type, price, size },
        ...extra,
    };
}

function gateOpts(bot, actions, extra = {}) {
    return {
        actions,
        cowResult: {},
        frozenPivot: 866.193898,
        frozenType: ORDER_TYPES.BUY,
        lastFillGuardStats: { checked: 0, passed: 0, skipped: 0, bypassed: 0, pivotOffGrid: 0 },
        skippedUpdateSlotIds: new Set(),
        skippedCreateSlotIds: new Set(),
        skippedUpdateCountRef: { count: 0 },
        batchPendingFps: new Set(),
        ...extra,
    };
}

function sellFillOp(orderId, slotPrice) {
    // Queued fill resolving via slot lookup (same shape as SGP-1).
    return { op: [4, { order_id: orderId }], block_num: 1, __slotPrice: slotPrice };
}

async function testNoOpWhenPivotUnchanged() {
    console.log('\n[FG-1] pivot unchanged => pure no-op (arrays untouched, no drops)');
    const slots = [{ id: 'slot-104', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: 879.304566 }];
    const bot = makeBot({ queue: [], slots });
    const ops = [{ fake: 'op-rotation' }];
    const ctxs = [rotCtx('slot-104', '1.7.1', 879.304566, 4.68, ORDER_TYPES.SELL)];
    const actions = [rotAction('slot-124', '1.7.1', 'slot-104', 879.304566, 4.68, ORDER_TYPES.SELL)];
    const opts = gateOpts(bot, actions);
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.pivotChanged, false, 'no queued fills => pivot unchanged');
    assert.strictEqual(res.dropped.length, 0);
    assert.strictEqual(ops.length, 1, 'ops untouched');
    assert.strictEqual(ctxs.length, 1, 'contexts untouched');
    assert.strictEqual(opts.lastFillGuardStats.checked, 0, 'no probes on the no-op path');
    console.log('✓ FG-1 passed');
}

async function testIncidentReplayDropsBothRotations() {
    console.log('\n[FG-2] incident replay: both violating rotations dropped, healthy ops kept');
    // Pivot arrives AFTER the freeze via the queue (freeze saw 866.19 buy;
    // queued sell at 884.60423 moves it — the .745/.765 ordering).
    const slots = [
        { id: 'slot-106', orderId: '1.7.574230706', type: ORDER_TYPES.SELL, price: SELL_PIVOT },
    ];
    const bot = makeBot({
        queue: [sellFillOp('1.7.574230706', SELL_PIVOT)],
        slots,
    });
    const ops = [{ fake: 'op-rot-104' }, { fake: 'op-rot-105' }, { fake: 'op-cancel' }];
    const ctxs = [
        rotCtx('slot-104', '1.7.574232470', 879.304566, 4.6839, ORDER_TYPES.SELL), // incident violator
        rotCtx('slot-105', '1.7.574205617', 881.950417, 4.6676, ORDER_TYPES.SELL), // sibling violator
        { kind: 'cancel', order: { id: 'slot-9', orderId: '1.7.9' } },
    ];
    const actions = [
        rotAction('slot-124', '1.7.574232470', 'slot-104', 879.304566, 4.6839, ORDER_TYPES.SELL),
        rotAction('slot-125', '1.7.574205617', 'slot-105', 881.950417, 4.6676, ORDER_TYPES.SELL),
        { type: COW_ACTIONS.CANCEL, id: 'slot-9', orderId: '1.7.9' },
    ];
    const opts = gateOpts(bot, actions);
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.pivotChanged, true, 'queued sell must move the pivot');
    assert.strictEqual(bot.manager._lastFilledPrice, SELL_PIVOT);
    assert.strictEqual(res.dropped.length, 2, `both rotations must drop, got ${JSON.stringify(res.dropped)}`);
    assert.strictEqual(ops.length, 1, 'only the cancel op survives');
    assert.strictEqual(ctxs.length, 1, 'only the cancel context survives');
    assert.strictEqual(ctxs[0].kind, 'cancel', 'survivor must be the cancel');
    // Slot restore: source + dest of each dropped rotation feed the restore set.
    assert.ok(opts.skippedUpdateSlotIds.has('slot-124'), 'rotation source restored');
    assert.ok(opts.skippedUpdateSlotIds.has('slot-104'), 'rotation dest restored');
    assert.ok(opts.skippedUpdateSlotIds.has('slot-125'), 'sibling source restored');
    assert.ok(opts.skippedUpdateSlotIds.has('slot-105'), 'sibling dest restored');
    assert.strictEqual(opts.skippedUpdateCountRef.count, 2);
    assert.strictEqual(opts.lastFillGuardStats.skipped, 2);
    // Sanity: both prices really are below the threshold (test would be vacuous otherwise).
    assert.ok(879.304566 < SELL_THR && 881.950417 < SELL_THR, 'test prices must violate');
    console.log('✓ FG-2 passed');
}

async function testPassingOpsKept() {
    console.log('\n[FG-3] ops passing under the new pivot are kept (no over-drop)');
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const bot = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    const ops = [{ fake: 'op-ok' }, { fake: 'op-buy' }];
    const ctxs = [
        rotCtx('slot-110', '1.7.2', SELL_THR + 5, 4.6, ORDER_TYPES.SELL), // above thr => passes
        createCtx('slot-81', 820.59, 4186.5, ORDER_TYPES.BUY), // deep buy => passes
    ];
    const actions = [
        rotAction('slot-130', '1.7.2', 'slot-110', SELL_THR + 5, 4.6, ORDER_TYPES.SELL),
        { type: COW_ACTIONS.CREATE, id: 'slot-81', order: { id: 'slot-81', type: ORDER_TYPES.BUY, price: 820.59, size: 4186.5 } },
    ];
    const opts = gateOpts(bot, actions);
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.pivotChanged, true);
    assert.strictEqual(res.dropped.length, 0, 'nothing violates => nothing drops');
    assert.strictEqual(ops.length, 2, 'ops kept');
    assert.strictEqual(ctxs.length, 2, 'contexts kept');
    assert.strictEqual(opts.lastFillGuardStats.passed, 2);
    console.log('✓ FG-3 passed');
}

async function testFailOpen() {
    console.log('\n[FG-4] fail-open: unresolvable price/type, cold pivot, refresh throw => KEEP');
    // (a) unresolvable price/type are kept even under a moved pivot.
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const botA = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    const opsA = [{ fake: 1 }, { fake: 2 }];
    const ctxsA = [
        { kind: 'create', id: 'slot-x', order: { id: 'slot-x', type: ORDER_TYPES.SELL, price: NaN, size: 5 } },
        { kind: 'rotation', rotation: { oldOrder: { id: 's' }, newGridId: 'slot-y', newPrice: 100, newSize: 5, type: 'nonsense' } },
    ];
    const resA = runFinalPivotGate(botA, opsA, ctxsA, gateOpts(botA, []));
    assert.strictEqual(resA.pivotChanged, true);
    assert.strictEqual(resA.dropped.length, 0, 'unjudgeable ops must be kept');
    assert.strictEqual(opsA.length, 2, 'arrays untouched');
    // (b) cold pivot (no queued fills, frozen cold) => no-op, never drops.
    const botB = makeBot({ queue: [], slots: [] });
    botB.manager._lastFilledPrice = null;
    botB.manager._lastFilledType = null;
    const opsB = [{ fake: 1 }];
    const ctxsB = [rotCtx('slot-104', '1.7.1', 1, 5, ORDER_TYPES.SELL)];
    const resB = runFinalPivotGate(botB, opsB, ctxsB, gateOpts(botB, [], { frozenPivot: null, frozenType: null }));
    assert.strictEqual(resB.pivotChanged, false, 'cold->cold is the no-op path');
    assert.strictEqual(opsB.length, 1);
    // (c) refresh throw => fail-open, built ops kept.
    const botC = makeBot({ queue: 'not-an-array', slots: [] });
    botC.manager._lastFilledPrice = 866.19;
    botC.manager._lastFilledType = ORDER_TYPES.BUY;
    const opsC = [{ fake: 1 }];
    const ctxsC = [rotCtx('slot-104', '1.7.1', 879.3, 5, ORDER_TYPES.SELL)];
    const resC = runFinalPivotGate(botC, opsC, ctxsC, gateOpts(botC, []));
    assert.strictEqual(opsC.length, 1, 'throw path must keep ops');
    assert.strictEqual(resC.dropped.length, 0);
    console.log('✓ FG-4 passed');
}

async function testColdFreezeArmsMidBatch() {
    console.log('\n[FG-5] frozen-cold + fill arrives mid-batch => newly guarded (not skipped)');
    // The freeze ran cold (guard disabled at build time: ops were NEVER
    // checked). A fill arriving before broadcast must arm the gate — the
    // opposite of the cold->cold no-op in FG-4b.
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const bot = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    bot.manager._lastFilledPrice = null;
    bot.manager._lastFilledType = null;
    const ops = [{ fake: 'op-rot' }];
    const ctxs = [rotCtx('slot-104', '1.7.2', 879.304566, 4.68, ORDER_TYPES.SELL)];
    const actions = [rotAction('slot-124', '1.7.2', 'slot-104', 879.304566, 4.68, ORDER_TYPES.SELL)];
    const opts = gateOpts(bot, actions, { frozenPivot: null, frozenType: null });
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.pivotChanged, true, 'cold->armed must count as changed');
    assert.strictEqual(res.dropped.length, 1, 'unguarded violating op must drop once armed');
    assert.strictEqual(ops.length, 0, 'all ops dropped => empty batch (caller aborts)');
    console.log('✓ FG-5 passed');
}

async function testBypassParity() {
    console.log('\n[FG-6] bypass parity: spread-correction CREATEs + stamped evacuations bypass; unstamped do not');
    // Hybrid/book pivot (NOT a real fill) with a fresh snapshot: the
    // spread-correction bypass is licensed. A real-fill pivot denies it
    // (covered by SMR-6 in test_spread_market_reference.ts); the parity of
    // the two spread origins and the stamped/unstamped evacuation asymmetry
    // is what this case pins.
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const bot = makeBot({ queue: [], slots });
    bot.manager._lastFilledPrice = SELL_PIVOT;
    bot.manager._lastFilledType = ORDER_TYPES.SELL;
    bot.manager.lastFillPivotSource = 'book';
    bot.manager._lastSyncAt = Date.now();
    bot.manager._lastUnmatchedChainOrders = [];
    const ops = [{ fake: 1 }, { fake: 2 }, { fake: 3 }, { fake: 4 }];
    const ctxs = [
        createCtx('slot-c1', 879.0, 5, ORDER_TYPES.SELL), // violating price...
        createCtx('slot-c2', 879.0, 5, ORDER_TYPES.SELL), // ...same here, batch origin bypass
        rotCtx('slot-e1', '1.7.e1', 879.0, 5, ORDER_TYPES.SELL), // stamped evacuation => bypass
        rotCtx('slot-e2', '1.7.e2', 879.0, 5, ORDER_TYPES.SELL), // unstamped evacuation => guarded => drop
    ];
    const actions = [
        { type: COW_ACTIONS.CREATE, id: 'slot-c1', origin: 'spread-correction', order: { id: 'slot-c1', type: ORDER_TYPES.SELL, price: 879.0, size: 5 } },
        { type: COW_ACTIONS.CREATE, id: 'slot-c2', order: { id: 'slot-c2', type: ORDER_TYPES.SELL, price: 879.0, size: 5 } },
        rotAction('slot-s1', '1.7.e1', 'slot-e1', 879.0, 5, ORDER_TYPES.SELL, { origin: 'gap-evacuation', evacBoundary: 99, evacGapSlots: 4 }),
        rotAction('slot-s2', '1.7.e2', 'slot-e2', 879.0, 5, ORDER_TYPES.SELL, { origin: 'gap-evacuation' }), // no stamp
    ];
    const opts = gateOpts(bot, actions, { cowResult: { origin: 'spread-correction' } });
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.dropped.length, 1, 'only the unstamped rotation drops');
    assert.strictEqual(res.dropped[0].slotId, 'slot-e2');
    assert.strictEqual(ops.length, 3, 'ops kept');
    assert.strictEqual(ctxs.length, 3, 'contexts kept');
    assert.strictEqual(opts.lastFillGuardStats.bypassed, 3, 'per-action + batch-origin + stamped bypasses');
    console.log('✓ FG-6 passed');
}

async function testLockstepAndPendingHygiene() {
    console.log('\n[FG-7] lockstep compaction + pending-entry hygiene by slot');
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const bot = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    // Pending entries for the dropped CREATE slot, a kept CREATE slot, and an
    // unrelated earlier batch slot. The first two were recorded by THIS batch
    // (fingerprints in batchPendingFps); the third is a sibling batch's.
    bot.manager._pendingBroadcasts.set('fp-drop', { fingerprint: 'fp-drop', slotId: 'slot-c1', opIndex: 0, ctxIndex: 1 });
    bot.manager._pendingBroadcasts.set('fp-keep', { fingerprint: 'fp-keep', slotId: 'slot-c2', opIndex: 2, ctxIndex: 3 });
    bot.manager._pendingBroadcasts.set('fp-other', { fingerprint: 'fp-other', slotId: 'slot-zzz', opIndex: 9, ctxIndex: 9 });
    const ops = [{ fake: 'cancel' }, { fake: 'drop-create' }, { fake: 'keep-create' }, { fake: 'rot' }];
    const ctxs = [
        { kind: 'cancel', order: { id: 'slot-9', orderId: '1.7.9' } },
        createCtx('slot-c1', 879.0, 5, ORDER_TYPES.SELL), // violates => drops (index 1)
        createCtx('slot-c2', SELL_THR + 5, 5, ORDER_TYPES.SELL), // passes (index 2)
        rotCtx('slot-110', '1.7.3', SELL_THR + 5, 5, ORDER_TYPES.SELL), // passes (index 3)
    ];
    const actions = [
        { type: COW_ACTIONS.CANCEL, id: 'slot-9', orderId: '1.7.9' },
        { type: COW_ACTIONS.CREATE, id: 'slot-c1', order: { id: 'slot-c1', type: ORDER_TYPES.SELL, price: 879.0, size: 5 } },
        { type: COW_ACTIONS.CREATE, id: 'slot-c2', order: { id: 'slot-c2', type: ORDER_TYPES.SELL, price: SELL_THR + 5, size: 5 } },
        rotAction('slot-130', '1.7.3', 'slot-110', SELL_THR + 5, 5, ORDER_TYPES.SELL),
    ];
    const opts = gateOpts(bot, actions, { batchPendingFps: new Set(['fp-drop', 'fp-keep']) });
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.dropped.length, 1);
    assert.strictEqual(res.dropped[0].slotId, 'slot-c1');
    // Lockstep: ops[i] still matches ctxs[i] for every survivor.
    assert.strictEqual(ops.length, 3);
    assert.strictEqual(ctxs.length, 3);
    assert.strictEqual(ctxs[0].kind, 'cancel');
    assert.strictEqual((ctxs[1] as any).id, 'slot-c2');
    assert.strictEqual(ctxs[2].kind, 'rotation');
    assert.strictEqual(ops[0].fake, 'cancel');
    assert.strictEqual(ops[1].fake, 'keep-create');
    assert.strictEqual(ops[2].fake, 'rot');
    // Pending: dropped slot cleared, kept + unrelated survive.
    assert.ok(!bot.manager._pendingBroadcasts.has('fp-drop'), 'dropped CREATE entry removed');
    assert.ok(bot.manager._pendingBroadcasts.has('fp-keep'), 'kept CREATE entry survives');
    assert.ok(bot.manager._pendingBroadcasts.has('fp-other'), 'unrelated entry survives');
    // Index remap: the kept entry's stored indexes were re-pointed at the
    // compacted positions (old ctxIndex 3 -> 2, opIndex 2 -> 1); the sibling
    // batch's entry is never touched.
    assert.strictEqual(bot.manager._pendingBroadcasts.get('fp-keep').ctxIndex, 2, 'kept entry ctxIndex remapped');
    assert.strictEqual(bot.manager._pendingBroadcasts.get('fp-keep').opIndex, 1, 'kept entry opIndex remapped');
    assert.strictEqual(bot.manager._pendingBroadcasts.get('fp-other').ctxIndex, 9, 'sibling entry untouched');
    // Dropped CREATE feeds the refill-hold intersect.
    assert.ok(opts.skippedCreateSlotIds.has('slot-c1'));
    console.log('✓ FG-7 passed');
}

async function testCancelsAndSizeUpdatesNeverGated() {
    console.log('\n[FG-8] cancel + size-update ops are never gated or dropped');
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const bot = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    const ops = [{ fake: 'c' }, { fake: 's' }];
    const ctxs = [
        { kind: 'cancel', order: { id: 'slot-9', orderId: '1.7.9' } },
        { kind: 'size-update', updateInfo: { partialOrder: { id: 'slot-5' }, newSize: 3 } },
    ];
    const opts = gateOpts(bot, []);
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.pivotChanged, true, 'pivot moved but...');
    assert.strictEqual(res.dropped.length, 0, '...non-repricing ops never drop');
    assert.strictEqual(ops.length, 2, 'ops kept');
    assert.strictEqual(ctxs.length, 2, 'contexts kept');
    assert.strictEqual(opts.lastFillGuardStats.checked, 0, 'not even probed');
    console.log('✓ FG-8 passed');
}

async function testHelperParityWithGuard() {
    console.log('\n[FG-9] gate verdicts match isLastFillGuardBlocked 1:1 on the incident prices');
    // The gate must not implement its own threshold math — spot-check parity.
    const inc = INC;
    for (const [price, type, pivot, ptype, expectBlocked] of [
        [879.304566, ORDER_TYPES.SELL, SELL_PIVOT, ORDER_TYPES.SELL, true],
        [881.950417, ORDER_TYPES.SELL, SELL_PIVOT, ORDER_TYPES.SELL, true],
        [SELL_THR + 0.01, ORDER_TYPES.SELL, SELL_PIVOT, ORDER_TYPES.SELL, false],
        [820.593305, ORDER_TYPES.BUY, SELL_PIVOT, ORDER_TYPES.SELL, false],
        [879.304566, ORDER_TYPES.SELL, 866.193898, ORDER_TYPES.BUY, false], // stale pivot passes (the bug)
    ]) {
        const check = isLastFillGuardBlocked(price, 1, type, pivot, ptype, inc);
        assert.strictEqual(check.blocked, expectBlocked, `price ${price} vs pivot ${pivot}`);
    }
    // And the refresh helper the gate relies on resolves the queued sell.
    const bot = makeBot({
        queue: [sellFillOp('1.7.1', SELL_PIVOT)],
        slots: [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }],
    });
    assert.strictEqual(refreshLastFillPivotFromQueue(bot), true);
    assert.strictEqual(bot.manager._lastFilledPrice, SELL_PIVOT);
    console.log('✓ FG-9 passed');
}

async function testSameSlotUpdateResolvesSourceAction() {
    console.log('\n[FG-10] same-slot size-only UPDATE resolves the source action (no dest-key miss)');
    // buildActionsFromPlan emits same-slot UPDATEs (no newGridId, or
    // newGridId === id) for ordersToUpdate. The gate keys rotations by
    // DESTINATION slot; for a same-slot op the dest key IS the source id,
    // and the source-id fallback must find the action so its origin stamp
    // (here: spread-correction... no — spread bypass is CREATE-only; use a
    // stamped gap-evacuation UPDATE) is honored instead of missed.
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const bot = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    const ops = [{ fake: 'op-sameslot' }];
    const ctxs = [{
        kind: 'rotation',
        rotation: {
            oldOrder: { id: 'slot-104' },
            newGridId: 'slot-104', // same-slot: dest === source
            newPrice: 879.0, // violating price — bypass must save it, not the guard
            newSize: 5,
            type: ORDER_TYPES.SELL,
        },
    }];
    const actions = [{
        type: COW_ACTIONS.UPDATE,
        id: 'slot-104',
        orderId: '1.7.9',
        newGridId: 'slot-104',
        newPrice: 879.0,
        newSize: 5,
        order: { id: 'slot-104', type: ORDER_TYPES.SELL, price: 879.0, size: 5 },
        origin: 'gap-evacuation',
        evacBoundary: 99,
        evacGapSlots: 4,
    }];
    const opts = gateOpts(bot, actions);
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.pivotChanged, true);
    assert.strictEqual(res.dropped.length, 0, 'stamped same-slot op must bypass via source-id fallback');
    assert.strictEqual(ops.length, 1, 'op kept');
    assert.strictEqual(opts.lastFillGuardStats.bypassed, 1);
    // Negative control: same op WITHOUT the stamp drops (lookup finds the
    // action but it carries no bypass — proves the bypass came from the
    // resolved action, not from skipping the op).
    const bot2 = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    const ops2 = [{ fake: 'op-sameslot' }];
    const ctxs2 = [{
        kind: 'rotation',
        rotation: {
            oldOrder: { id: 'slot-104' },
            newGridId: 'slot-104',
            newPrice: 879.0,
            newSize: 5,
            type: ORDER_TYPES.SELL,
        },
    }];
    const actions2 = [{
        type: COW_ACTIONS.UPDATE,
        id: 'slot-104',
        orderId: '1.7.9',
        newGridId: 'slot-104',
        newPrice: 879.0,
        newSize: 5,
        order: { id: 'slot-104', type: ORDER_TYPES.SELL, price: 879.0, size: 5 },
    }];
    const opts2 = gateOpts(bot2, actions2);
    const res2 = runFinalPivotGate(bot2, ops2, ctxs2, opts2);
    assert.strictEqual(res2.dropped.length, 1, 'unstamped same-slot violator must drop');
    console.log('✓ FG-10 passed');
}

async function testIndexRemapResolvesSameContext() {
    console.log('\n[FG-11] compaction remaps kept pending indexes to the SAME context objects');
    // The sharp case: two kept CREATEs AFTER a dropped op. Entry-B's stored
    // ctxIndex (2) would resolve to create-C's context after compaction
    // (cross-slot adoption via adoptMatchedEntries) without the remap; with
    // it, every kept entry's ctxIndex must resolve to the very context
    // object it was recorded with.
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    const bot = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    const ctxDrop = createCtx('slot-drop', 879.0, 5, ORDER_TYPES.SELL); // violating => drops (index 0)
    const ctxB = createCtx('slot-B', SELL_THR + 5, 5, ORDER_TYPES.SELL); // passes (index 1)
    const ctxC = createCtx('slot-C', SELL_THR + 5, 5, ORDER_TYPES.SELL); // passes (index 2)
    const ops = [{ fake: 'drop' }, { fake: 'B' }, { fake: 'C' }];
    const ctxs = [ctxDrop, ctxB, ctxC];
    const actions = [
        { type: COW_ACTIONS.CREATE, id: 'slot-drop', order: { id: 'slot-drop', type: ORDER_TYPES.SELL, price: 879.0, size: 5 } },
        { type: COW_ACTIONS.CREATE, id: 'slot-B', order: { id: 'slot-B', type: ORDER_TYPES.SELL, price: SELL_THR + 5, size: 5 } },
        { type: COW_ACTIONS.CREATE, id: 'slot-C', order: { id: 'slot-C', type: ORDER_TYPES.SELL, price: SELL_THR + 5, size: 5 } },
    ];
    // All three entries were recorded by this batch (as the build loop does);
    // one extra sibling entry must remain untouched.
    bot.manager._pendingBroadcasts.set('fp-drop', { fingerprint: 'fp-drop', slotId: 'slot-drop', opIndex: 0, ctxIndex: 0 });
    bot.manager._pendingBroadcasts.set('fp-B', { fingerprint: 'fp-B', slotId: 'slot-B', opIndex: 1, ctxIndex: 1 });
    bot.manager._pendingBroadcasts.set('fp-C', { fingerprint: 'fp-C', slotId: 'slot-C', opIndex: 2, ctxIndex: 2 });
    bot.manager._pendingBroadcasts.set('fp-sib', { fingerprint: 'fp-sib', slotId: 'slot-sib', opIndex: 7, ctxIndex: 7 });
    const opts = gateOpts(bot, actions, { batchPendingFps: new Set(['fp-drop', 'fp-B', 'fp-C']) });
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.dropped.length, 1);
    assert.strictEqual(res.dropped[0].slotId, 'slot-drop');
    assert.strictEqual(ops.length, 2);
    assert.strictEqual(ctxs.length, 2);
    // Dropped create's pending entry removed.
    assert.ok(!bot.manager._pendingBroadcasts.has('fp-drop'), 'dropped CREATE entry removed');
    // Kept entries resolve to THEIR OWN context objects (identity check —
    // the exact property adoptMatchedEntries/restoreDiscardedCreates rely on).
    const eB = bot.manager._pendingBroadcasts.get('fp-B');
    const eC = bot.manager._pendingBroadcasts.get('fp-C');
    assert.ok(eB, 'entry B survives');
    assert.ok(eC, 'entry C survives');
    assert.strictEqual(ctxs[eB.ctxIndex], ctxB, 'entry B ctxIndex resolves to B context');
    assert.strictEqual(ctxs[eC.ctxIndex], ctxC, 'entry C ctxIndex resolves to C context');
    assert.strictEqual(ctxs[eC.opIndex], ctxC, 'opIndex stays aligned with ctxIndex');
    // Sibling batch's entry untouched.
    assert.strictEqual(bot.manager._pendingBroadcasts.get('fp-sib').ctxIndex, 7, 'sibling entry untouched');
    // Negative control: WITHOUT the fingerprint set, no remap happens —
    // documenting that callers must thread batchPendingFps for the remap.
    const bot2 = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    bot2.manager._pendingBroadcasts.set('fp-B2', { fingerprint: 'fp-B2', slotId: 'slot-B', opIndex: 1, ctxIndex: 1 });
    const ops2 = [{ fake: 'drop' }, { fake: 'B' }, { fake: 'C' }];
    const ctxs2 = [
        createCtx('slot-drop', 879.0, 5, ORDER_TYPES.SELL),
        createCtx('slot-B', SELL_THR + 5, 5, ORDER_TYPES.SELL),
        createCtx('slot-C', SELL_THR + 5, 5, ORDER_TYPES.SELL),
    ];
    const opts2 = gateOpts(bot2, actions);
    runFinalPivotGate(bot2, ops2, ctxs2, opts2);
    assert.strictEqual(bot2.manager._pendingBroadcasts.get('fp-B2').ctxIndex, 1, 'no fingerprint set => no remap (caller contract)');
    console.log('✓ FG-11 passed');
}

async function testStaleEvacuationStampNeverBypasses() {
    console.log('\n[FG-12] stale gap-evacuation stamp must not bypass at the final gate');
    const slots = [{ id: 'slot-106', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: SELL_PIVOT }];
    // Live geometry: boundary 200 / gap 4. Source slot-100 is NOT in band
    // anymore, so the plan-build stamp (boundary 99) is stale.
    const bot = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    bot.manager.boundaryIdx = 200;
    bot.manager._gapSlots = 4;
    // Direction-legal price: only the stale geometry can justify a drop.
    const ops = [{ fake: 'stale-evac' }];
    const ctxs = [rotCtx('slot-104', '1.7.e1', SELL_THR + 5, 5, ORDER_TYPES.SELL, 'slot-100')];
    const actions = [rotAction('slot-100', '1.7.e1', 'slot-104', SELL_THR + 5, 5, ORDER_TYPES.SELL, {
        origin: 'gap-evacuation', evacBoundary: 99, evacGapSlots: 4
    })];
    const opts = gateOpts(bot, actions);
    const res = runFinalPivotGate(bot, ops, ctxs, opts);
    assert.strictEqual(res.dropped.length, 1, 'stale stamp drops even when the price itself is direction-legal');
    assert.strictEqual(opts.lastFillGuardStats.bypassed, 0, 'a stale stamp must not count as a bypass');

    // Positive control: with live geometry still matching the stamp, the
    // bypass remains (source slot-100 in band 99..103, dest slot-104 rail).
    const bot2 = makeBot({ queue: [sellFillOp('1.7.1', SELL_PIVOT)], slots });
    bot2.manager.boundaryIdx = 99;
    bot2.manager._gapSlots = 4;
    const ops2 = [{ fake: 'live-evac' }];
    const ctxs2 = [rotCtx('slot-104', '1.7.e2', SELL_THR + 5, 5, ORDER_TYPES.SELL, 'slot-100')];
    const actions2 = [rotAction('slot-100', '1.7.e2', 'slot-104', SELL_THR + 5, 5, ORDER_TYPES.SELL, {
        origin: 'gap-evacuation', evacBoundary: 99, evacGapSlots: 4
    })];
    const opts2 = gateOpts(bot2, actions2);
    const res2 = runFinalPivotGate(bot2, ops2, ctxs2, opts2);
    assert.strictEqual(res2.dropped.length, 0, 'live stamp geometry still bypasses');
    assert.strictEqual(opts2.lastFillGuardStats.bypassed, 1);
    console.log('✓ FG-12 passed');

    // FG-13: boundary moved while the pivot stayed unchanged. The gate must
    // not take the no-op fast path just because pivotChanged is false.
    const bot3 = makeBot({ queue: [], slots });
    bot3.manager.boundaryIdx = 200;
    bot3.manager._gapSlots = 4;
    const ops3 = [{ fake: 'pivot-neutral-stale-evac' }];
    const ctxs3 = [rotCtx('slot-104', '1.7.e3', SELL_THR + 5, 5, ORDER_TYPES.SELL, 'slot-100')];
    const actions3 = [rotAction('slot-100', '1.7.e3', 'slot-104', SELL_THR + 5, 5, ORDER_TYPES.SELL, {
        origin: 'gap-evacuation', evacBoundary: 99, evacGapSlots: 4
    })];
    const opts3 = gateOpts(bot3, actions3);
    const res3 = runFinalPivotGate(bot3, ops3, ctxs3, opts3);
    assert.strictEqual(res3.pivotChanged, false, 'precondition: pivot did not change');
    assert.strictEqual(res3.dropped.length, 1,
        'pivot-neutral boundary change must still drop a stale gap-evacuation stamp');
    console.log('✓ FG-13 passed');
}

async function main() {
    await testNoOpWhenPivotUnchanged();
    await testIncidentReplayDropsBothRotations();
    await testPassingOpsKept();
    await testFailOpen();
    await testColdFreezeArmsMidBatch();
    await testBypassParity();
    await testLockstepAndPendingHygiene();
    await testCancelsAndSizeUpdatesNeverGated();
    await testHelperParityWithGuard();
    await testSameSlotUpdateResolvesSourceAction();
    await testIndexRemapResolvesSameContext();
    await testStaleEvacuationStampNeverBypasses();
    console.log('\nAll final-pivot-gate regression tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Final-pivot-gate test failed:', err);
        process.exit(1);
    });
}

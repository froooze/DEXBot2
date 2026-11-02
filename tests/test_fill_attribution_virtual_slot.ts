/**
 * tests/test_fill_attribution_virtual_slot.ts
 *
 * FILL ATTRIBUTION — a fill whose order id no longer sits on an ACTIVE/PARTIAL
 * slot must still teach the grid the price that traded.
 *
 * Incident this pins (2026-11-02, a live market-pair bot): a 120s stale
 * broadcast region deferred the fill queue; the fills were then re-delivered
 * while their slots had already been virtualised by a phantom cleanup, so every
 * one of them logged "Fill for order X ignored: order not found in active
 * grid" — AFTER its accounting was booked. Neither the LAST-FILL-GUARD pivot
 * nor the owed boundary crawl learned the execution price, so the pivot stayed
 * on a stale, HIGHER fill (1306.10 while the market had already traded 1282.77).
 * The direction rule then let a startup-style top-up place 8 BUYs at
 * 1282.78..1310.04 above the market, all of which filled within seconds
 * (9 buy-lower violations, 23.5% of the window's BTS).
 *
 * The fix records what the fill proves (pivot + owed crawl from the REAL
 * execution price) against the slot that still owns the chain order id, without
 * mutating the slot or the already-booked accounting.
 */
const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { isLastFillPlacementBlocked, hasUnsettledFills } = require('../modules/order/utils/system');

const BASE = '1.3.100'; // assetA (base), precision 4
const BTS = '1.3.0';    // assetB (quote), precision 5

/**
 * BUY fill amounts for a given price/size, at this pair's precisions.
 * A BUY pays the quote (BTS) and receives the base asset.
 */
function buyFill(price: number, baseSize: number) {
    return {
        paysAssetId: BTS,
        paysAmountRaw: Math.round(price * baseSize * 1e5),
        receivesAssetId: BASE,
        receivesAmountRaw: Math.round(baseSize * 1e4),
    };
}

function makeMgr({ slots = [], pivot = null, pivotType = null, dryRun = false, genesis = null } = {}) {
    const orders = new Map();
    for (const s of slots) orders.set(s.id, { ...s });
    const logs = [];
    const mgr = {
        orders,
        assets: {
            assetA: { id: BASE, precision: 4, symbol: 'TEST' },
            assetB: { id: BTS, precision: 5, symbol: 'BTS' },
        },
        config: {
            dryRun,
            incrementPercent: 0.3,
            startPrice: 1300,
            assetA: 'TEST',
            assetB: 'BTS',
            market: 'TEST/BTS',
        },
        logger: { log: (msg, level) => logs.push({ msg, level }) },
        _logs: logs,
        _genesis: genesis,
        _pendingFillCrawls: [],
        _gridDirty: false,
        _markGridDirty() { this._gridDirty = true; },
        _lastFilledPrice: pivot,
        _lastFilledType: pivotType,
        _lastFilledBuyPrice: pivotType === ORDER_TYPES.BUY ? pivot : null,
        _lastFilledSellPrice: pivotType === ORDER_TYPES.SELL ? pivot : null,
        lastFillPivotSource: pivot != null ? 'fill' : null,
        // Mirrors the production writer's observable contract (single pivot +
        // side discriminator + provenance) without the persistence fan-out.
        recordLastFilledPrices(fills) {
            for (const f of fills) {
                if (!f || (f.type !== ORDER_TYPES.BUY && f.type !== ORDER_TYPES.SELL)) continue;
                const p = Number(f.price);
                if (!Number.isFinite(p) || p <= 0) continue;
                this._lastFilledPrice = p;
                this._lastFilledType = f.type;
                this.lastFillPivotSource = 'fill';
                if (f.type === ORDER_TYPES.BUY) this._lastFilledBuyPrice = p;
                else this._lastFilledSellPrice = p;
            }
        },
    };
    return mgr;
}

const ENGINE = new SyncEngine({});

/** A filled BUY slot that a cleanup already virtualised (no orderId left). */
function virtualisedBuySlot({ id = 'slot-138', price = 1282.781731, orderId = '1.7.576143017' } = {}) {
    return {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price,
        size: 0,
        orderId,
    };
}

async function testAttributionRecordsPivotAndCrawl() {
    console.log('\n[FA-1] an unattributable fill still arms the pivot + owes a crawl');
    const slot = virtualisedBuySlot();
    // Stale pivot = the last fill the bot managed to process (1306.10), i.e.
    // HIGHER than the trade being re-delivered (1282.77) — the incident state.
    const mgr = makeMgr({ slots: [slot], pivot: 1306.101938, pivotType: ORDER_TYPES.BUY });
    const before = { ...mgr.orders.get(slot.id) };

    const absorbed = ENGINE._absorbUnmatchedFill(mgr, { orderId: slot.orderId, ...buyFill(1282.770882, 3.4913) });

    assert.strictEqual(absorbed, true, 'the fill must be attributed to the slot that owns the chain id');
    assert.strictEqual(mgr._pendingFillCrawls.length, 1, 'exactly one owed crawl is recorded');
    assert.strictEqual(mgr._pendingFillCrawls[0].slotId, slot.id, 'crawl is recorded against the owning slot');
    assert.strictEqual(mgr._pendingFillCrawls[0].side, ORDER_TYPES.BUY, 'crawl carries the fill side');
    assert.strictEqual(mgr._gridDirty, true, 'the pending-crawl ledger marks the grid dirty for persistence');

    // Pivot is armed from the REAL execution price, not the stale value and not
    // the (slightly different) slot level.
    assert.strictEqual(mgr._lastFilledType, ORDER_TYPES.BUY);
    assert(Math.abs(mgr._lastFilledPrice - 1282.770882) < 1e-5, `pivot from execution price, got ${mgr._lastFilledPrice}`);

    // The slot itself is NOT resurrected and the accounting is NOT touched.
    const after = mgr.orders.get(slot.id);
    assert.deepStrictEqual(after, before, 'the virtualised slot is left untouched');
    assert.strictEqual(after.state, ORDER_STATES.VIRTUAL);
    assert.strictEqual(after.size, 0);

    const log = mgr._logs.filter((l) => l.msg.includes('attributed to slot-138 via chain-id'));
    assert.strictEqual(log.length, 1, 'the attribution is logged so it is visible in production');
    assert.strictEqual(log[0].level, 'warn');
    console.log('  ✓ pivot + owed crawl recorded, slot untouched');
}

async function testUnknownOrderIsStillIgnored() {
    console.log('\n[FA-2] a fill for an order the grid never owned is not absorbed');
    const mgr = makeMgr({ slots: [virtualisedBuySlot()], pivot: 1000, pivotType: ORDER_TYPES.BUY });
    const absorbed = ENGINE._absorbUnmatchedFill(mgr, { orderId: '1.7.999999999', ...buyFill(1282.77, 3.5) });
    assert.strictEqual(absorbed, false, 'unknown order id must not move the pivot');
    assert.strictEqual(mgr._pendingFillCrawls.length, 0, 'no crawl for an unknown order');
    assert.strictEqual(mgr._lastFilledPrice, 1000, 'pivot unchanged');
    console.log('  ✓ unknown order leaves the ledger alone');
}

async function testRedeliveryDoesNotStackCrawls() {
    console.log('\n[FA-3] re-delivery of the same slot replaces its crawl (no stacking)');
    const slot = virtualisedBuySlot();
    const mgr = makeMgr({ slots: [slot] });
    const fill = { orderId: slot.orderId, ...buyFill(1282.77, 3.5) };
    ENGINE._absorbUnmatchedFill(mgr, fill);
    ENGINE._absorbUnmatchedFill(mgr, fill);
    ENGINE._absorbUnmatchedFill(mgr, fill);
    assert.strictEqual(mgr._pendingFillCrawls.length, 1, 'a slot without a live order can only owe one crawl');
    assert.strictEqual(mgr._pendingFillCrawls[0].slotId, slot.id);
    console.log('  ✓ slot-level dedupe holds');
}

async function testDryRunRecordsNoCrawl() {
    console.log('\n[FA-4] dryRun never grows the crawl ledger (it can never commit one)');
    const slot = virtualisedBuySlot();
    const mgr = makeMgr({ slots: [slot], dryRun: true });
    const absorbed = ENGINE._absorbUnmatchedFill(mgr, { orderId: slot.orderId, ...buyFill(1282.77, 3.5) });
    assert.strictEqual(absorbed, true);
    assert.strictEqual(mgr._pendingFillCrawls.length, 0, 'no owed crawl under dryRun');
    assert(Math.abs(mgr._lastFilledPrice - 1282.77) < 0.01, 'pivot still tracks the trade');
    console.log('  ✓ dryRun: pivot yes, ledger no');
}

async function testAbsorbedFillClosesTheBuyHigherLadder() {
    console.log('\n[FA-5] the absorbed pivot refuses the incident\'s buy-higher ladder');
    // Replay: after the 1282.77 trade the reconciler re-created
    // 1282.78 / 1286.63 / 1290.50 / 1294.38 / 1298.28 / 1302.19 / 1306.11 / 1310.04.
    // With the stale pivot (1306.10) the direction rule allowed all but the top.
    const slot = virtualisedBuySlot();
    const mgr = makeMgr({ slots: [slot], pivot: 1306.101938, pivotType: ORDER_TYPES.BUY });
    const ladder = [1282.781731, 1286.641656, 1290.513195, 1294.396384, 1298.291258, 1302.197852, 1306.1162, 1310.046339];

    const allowedBefore = ladder.filter((p) => !isLastFillPlacementBlocked(mgr, p, ORDER_TYPES.BUY).blocked);
    // The direction rule alone already refuses the top two levels (same level
    // as the stale pivot, and above it) — the other six are "below the pivot"
    // and therefore placeable, which is exactly what filled on-chain.
    assert.strictEqual(allowedBefore.length, 6,
        `stale (higher) pivot leaves 6 of the 8 levels placeable — the incident; got ${allowedBefore.length}`);
    assert(!allowedBefore.includes(1310.046339) && !allowedBefore.includes(1306.1162),
        'the levels at/above the stale pivot are the only ones refused');

    ENGINE._absorbUnmatchedFill(mgr, { orderId: slot.orderId, ...buyFill(1282.770882, 3.4913) });

    const allowedAfter = ladder.filter((p) => !isLastFillPlacementBlocked(mgr, p, ORDER_TYPES.BUY).blocked);
    assert.deepStrictEqual(allowedAfter, [], 'every level of the ladder is now refused (at/above or same-level)');

    // The rail still crawls: one increment lower is placeable.
    const nextLevel = 1282.781731 / 1.003;
    assert.strictEqual(isLastFillPlacementBlocked(mgr, nextLevel, ORDER_TYPES.BUY).blocked, false,
        'one increment lower is a legitimate placement (the crawl is not frozen)');
    console.log('  ✓ absorbed fill converts the whole re-buy ladder into refusals');
}

async function testSameLevelRoundingIsCaught() {
    console.log('\n[FA-6] a slot level and its execution price are the same level');
    // Slot 1310.046339 filled at 1310.060435: a raw `>=` comparison sees the
    // slot as "below the pivot" and re-places it. Same-level must catch it.
    const slot = virtualisedBuySlot({ id: 'slot-145', price: 1310.046339, orderId: '1.7.576142589' });
    const mgr = makeMgr({ slots: [slot] });
    ENGINE._absorbUnmatchedFill(mgr, { orderId: slot.orderId, ...buyFill(1310.060435, 3.5986) });

    const guard = isLastFillPlacementBlocked(mgr, slot.price, ORDER_TYPES.BUY);
    assert.strictEqual(guard.blocked, true, 'raw price is "below" the pivot but it is the same grid level');
    assert.strictEqual(guard.reason, 'same-level');
    // The mirror side is allowed: selling above our own cost is the counter order.
    assert.strictEqual(isLastFillPlacementBlocked(mgr, 1310.046339 * 1.004, ORDER_TYPES.SELL).blocked, false,
        'a SELL above the buy fill is placeable (counter order / spread edge)');
    // Selling at the fill price itself is selling at cost — refused.
    assert.strictEqual(isLastFillPlacementBlocked(mgr, 1310.060435, ORDER_TYPES.SELL).blocked, true);
    console.log('  ✓ same-level re-place refused, counter-side placement allowed');
}

/**
 * The incident ladder: slot-130..140 spanned by a 0.3% step, indexed so that
 * slot-138 carries the price the fill actually traded at.
 */
const LADDER = Array.from({ length: 14 }, (_, i) => 1282.781731 * Math.pow(1.003, i - 5));

function ladderGenesis() {
    return buildGenesisFromPriceLevels(LADDER[6], 0.3, 4, LADDER);
}

function slotAt(idx: number, { orderId = null, state = ORDER_STATES.VIRTUAL, size = 0 } = {}) {
    return { id: `slot-${idx}`, type: ORDER_TYPES.BUY, state, price: LADDER[idx], size, orderId };
}

async function testLadderIdentityWhenOrderIdIsCleared() {
    console.log('\n[FA-8] the PRODUCTION case: virtualisation cleared the orderId (ladder identity)');
    // Every virtualisation path (virtualizeOrder -> convertToSpreadPlaceholder /
    // toRailHolePlaceholder) NULLS orderId, so after a phantom cleanup the master
    // holds no slot keyed by the filled order. The fill price is then the only
    // identity left — this is the case the incident actually hit (15 dropped
    // fills, all of them after sync-cleanup-phantom).
    const hole = slotAt(5); // a clean hole: no orderId at all
    const mgr = makeMgr({
        slots: [slotAt(3), slotAt(4), hole, slotAt(6), slotAt(7)],
        pivot: 1310.060435,
        pivotType: ORDER_TYPES.BUY,
        genesis: ladderGenesis(),
    });

    const absorbed = ENGINE._absorbUnmatchedFill(mgr, {
        orderId: '1.7.576142590', // an order the grid no longer knows by id
        ...buyFill(LADDER[5], 3.6),
    });

    assert.strictEqual(absorbed, true, 'a fill priced on the ladder must be attributed even without a chain-id match');
    assert(Math.abs(mgr._lastFilledPrice - LADDER[5]) < 0.01,
        `pivot must move to the execution price ${LADDER[5]}, got ${mgr._lastFilledPrice}`);
    assert.strictEqual(mgr._pendingFillCrawls.length, 1, 'the level is a hole, so a crawl is owed');
    assert.strictEqual(mgr._pendingFillCrawls[0].slotId, 'slot-5');

    const log = mgr._logs.filter((l) => l.msg.includes('via ladder'));
    assert.strictEqual(log.length, 1, 'the ladder identity is logged so it is visible in production');
    console.log('  ✓ ladder identity attributes the fill and arms the pivot');
}

async function testLadderIdentityRefusesAnOccupiedLevel() {
    console.log('\n[FA-9] a level that still holds a live order arms the pivot but owes no crawl');
    const live = slotAt(5, { orderId: '1.7.700000001', state: ORDER_STATES.ACTIVE, size: 4 });
    const mgr = makeMgr({ slots: [live], genesis: ladderGenesis() });

    const absorbed = ENGINE._absorbUnmatchedFill(mgr, { orderId: '1.7.111', ...buyFill(LADDER[5], 1) });

    assert.strictEqual(absorbed, true, 'the price is still evidence of a trade');
    assert.strictEqual(mgr._pendingFillCrawls.length, 0, 'an occupied level cannot be re-placed, so nothing is owed');
    assert(Math.abs(mgr._lastFilledPrice - LADDER[5]) < 0.01);
    console.log('  ✓ pivot yes, crawl no');
}

async function testLadderIdentityRefusesOutOfGridPrices() {
    console.log('\n[FA-10] a shelf/manual order far outside the rail never arms the pivot');
    // Arming the pivot at a 0.5x-floor price would veto the entire BUY rail
    // (every buy sits above it), so an out-of-grid fill must be ignored.
    const mgr = makeMgr({ slots: [slotAt(5)], pivot: 1300, pivotType: ORDER_TYPES.BUY, genesis: ladderGenesis() });

    const shelfPrice = LADDER[0] * 0.5;
    const absorbed = ENGINE._absorbUnmatchedFill(mgr, { orderId: '1.7.999', ...buyFill(shelfPrice, 1) });

    assert.strictEqual(absorbed, false, 'out-of-grid price is not this grid\'s trade');
    assert.strictEqual(mgr._lastFilledPrice, 1300, 'pivot unchanged');
    assert.strictEqual(mgr._pendingFillCrawls.length, 0, 'no crawl');
    console.log('  ✓ out-of-grid refused');
}

async function testUnsettledFillsSignal() {
    console.log('\n[FA-7] hasUnsettledFills covers every deferral state');
    const base = () => ({ manager: { _pendingFillCrawls: [], _fillBatchInFlight: 0 }, _incomingFillQueue: [], _deferredFillsPending: false });
    assert.deepStrictEqual(hasUnsettledFills(base()), { unsettled: false, reason: null }, 'settled grid');
    assert.deepStrictEqual(hasUnsettledFills(null), { unsettled: false, reason: null }, 'missing source is not a deferral');

    const queued = { ...base(), _incomingFillQueue: [{}, {}] };
    assert.strictEqual(hasUnsettledFills(queued).unsettled, true, 'queued fills defer');
    assert(/queued/.test(hasUnsettledFills(queued).reason), 'reason names the queue');

    const draining = { ...base(), _deferredFillsPending: true };
    assert.strictEqual(hasUnsettledFills(draining).unsettled, true, 'a deferred drain defers');

    const inFlight = { manager: { _pendingFillCrawls: [], _fillBatchInFlight: 1 } };
    assert.strictEqual(hasUnsettledFills(inFlight).unsettled, true, 'an in-flight fill batch defers');

    const owed = { manager: { _pendingFillCrawls: [{ slotId: 'slot-1', side: ORDER_TYPES.BUY, ts: 1 }], _fillBatchInFlight: 0 } };
    assert.strictEqual(hasUnsettledFills(owed).unsettled, true, 'an owed crawl defers');
    assert(/owed/.test(hasUnsettledFills(owed).reason), 'reason names the crawl debt');

    // A bare manager (no bot wrapper) is accepted too — the reconcile path has
    // no bot object.
    assert.strictEqual(hasUnsettledFills({ _pendingFillCrawls: [{ slotId: 'slot-2', side: ORDER_TYPES.SELL, ts: 1 }] }).unsettled, true);
    console.log('  ✓ every deferral state is recognised');
}

async function main() {
    console.log('=== Fill attribution to a virtualised slot ===');
    await testAttributionRecordsPivotAndCrawl();
    await testUnknownOrderIsStillIgnored();
    await testRedeliveryDoesNotStackCrawls();
    await testDryRunRecordsNoCrawl();
    await testAbsorbedFillClosesTheBuyHigherLadder();
    await testSameLevelRoundingIsCaught();
    await testLadderIdentityWhenOrderIdIsCleared();
    await testLadderIdentityRefusesAnOccupiedLevel();
    await testLadderIdentityRefusesOutOfGridPrices();
    await testUnsettledFillsSignal();
    console.log('\nAll fill-attribution tests passed ✔');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

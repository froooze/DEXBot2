/**
 * LIVE-GEOMETRY PROVENANCE:
 *   FILL-PRICE  - fill records carry the chain execution price, not the slot's
 *                 stale generation price (last-fill pivot / re-anchor input);
 *   GAP-PRICE   - gap-evacuation detection maps the order's LIVE chain price
 *                 onto the ladder (a stale slot id can hide an in-band order);
 *   CROSS-PRICE - the crossing guard compares against the live chain price, so
 *                 a sell cannot be emitted onto a buy that was adopted at a
 *                 stale slot price.
 *
 * Incident: a refused-commit adoption kept order 1.7.…119 at slot-118 @1267
 * while the chain order traded at 1345.73. The pivot became 1267, GAP-EVAC saw
 * an in-rail slot, the crossing guard saw an in-rail price, and the next plan
 * emitted a sell at the same 1345.728664.
 */

const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const {
    detectGapEvacuationCandidates,
    _validatePriceCorrectionEntry,
    buildCrossingCheckCandidates,
    resolveLiveOrderLadderPosition
} = require('../modules/order/utils/order');
const { findCrossedOrder } = require('../modules/order/utils/math');
const { refreshLastFillPivotFromQueue } = require('../modules/dexbot_cow_runtime');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    ${msg}`);
    }
}

const ASSETS = {
    assetA: { id: '1.3.0', precision: 5, symbol: 'BASE' },
    assetB: { id: '1.3.1', precision: 5, symbol: 'QUOTE' }
};
// Genesis ladder: slot idx === price - 100.
const LEVELS = Array.from({ length: 251 }, (_, i) => 100 + i);
const GENESIS = { priceLevels: LEVELS };

/** Raw chain order shape parseChainOrder understands. */
function rawChainOrder(id: string, type: string, price: number, sizeBase = 10) {
    // 1 base unit = 1e-5; use 1.00000 base for a clean ratio.
    const baseAmount = 100000;
    const quoteAmount = Math.round(price * baseAmount);
    const base = type === ORDER_TYPES.SELL
        ? { asset_id: ASSETS.assetA.id, amount: baseAmount }
        : { asset_id: ASSETS.assetB.id, amount: quoteAmount };
    const quote = type === ORDER_TYPES.SELL
        ? { asset_id: ASSETS.assetB.id, amount: quoteAmount }
        : { asset_id: ASSETS.assetA.id, amount: baseAmount };
    return {
        id,
        sell_price: { base, quote },
        for_sale: Math.round(sizeBase * 100000),
        expiration: '2099-01-01T00:00:00'
    };
}

function slot(id: string, type: string, price: number, orderId: string | null, raw: unknown = null, state = ORDER_STATES.ACTIVE) {
    return { id, type, price, orderId, rawOnChain: raw, state, size: 10 };
}

console.log('=== LIVE-GEOMETRY: fill / gap / crossing provenance ===');

// ---------------------------------------------------------------------------
// FILL-PRICE
// ---------------------------------------------------------------------------
run('FILL-PRICE-1 SELL fill price comes from the paid/received amounts (1345.73)', () => {
    const engine = new SyncEngine({ assets: ASSETS });
    const ctx = engine._computeFillContext(
        { assets: ASSETS },
        slot('slot-118', ORDER_TYPES.BUY, 1267.307972, '1.7.119'),
        ASSETS.assetA.id, 100000,          // pays 1.00000 base
        ASSETS.assetB.id, 134573000        // receives 1345.73000 quote
    );
    assert.ok(Math.abs(ctx.fillPrice - 1345.73) < 1e-6, `expected 1345.73, got ${ctx.fillPrice}`);
});

run('FILL-PRICE-2 BUY fill price comes from the paid/received amounts (1345.73)', () => {
    const engine = new SyncEngine({ assets: ASSETS });
    const ctx = engine._computeFillContext(
        { assets: ASSETS },
        slot('slot-118', ORDER_TYPES.BUY, 1267.307972, '1.7.119'),
        ASSETS.assetB.id, 134573000,       // pays 1345.73000 quote
        ASSETS.assetA.id, 100000           // receives 1.00000 base
    );
    assert.ok(Math.abs(ctx.fillPrice - 1345.73) < 1e-6, `expected 1345.73, got ${ctx.fillPrice}`);
});

run('FILL-PRICE-4 queued-fill pivot refresh prefers fill economics over the stale slot price', () => {
    const stale = slot('slot-118', ORDER_TYPES.BUY, 1267.307972, '1.7.119');
    const manager = {
        assets: ASSETS,
        orders: new Map([['slot-118', stale]]),
        logger: { log: () => {} },
        _lastFilledPrice: null as number | null,
        _lastFilledType: null as string | null,
        _lastMarketFillPrice: null as number | null,
        _lastMarketFillType: null as string | null
    };
    const bot = {
        manager,
        _incomingFillQueue: [{
            op: [null, {
                order_id: '1.7.119',
                pays: { asset_id: ASSETS.assetB.id, amount: 134573000 },
                receives: { asset_id: ASSETS.assetA.id, amount: 100000 }
            }]
        }]
    };
    const refreshed = refreshLastFillPivotFromQueue(bot);
    assert.strictEqual(refreshed, true, 'the queued fill must refresh the pivot');
    assert.ok(Math.abs(manager._lastFilledPrice - 1345.73) < 1e-6,
        `pivot must be the real trade price, got ${manager._lastFilledPrice}`);
    assert.strictEqual(manager._lastFilledType, ORDER_TYPES.BUY);
});

run('FILL-PRICE-3 unmatched assets yield null (slot price is used as fallback only then)', () => {
    const engine = new SyncEngine({ assets: ASSETS });
    const ctx = engine._computeFillContext(
        { assets: ASSETS },
        slot('slot-118', ORDER_TYPES.BUY, 1267.307972, '1.7.119'),
        '1.3.999', 100000,
        '1.3.998', 134573000
    );
    assert.strictEqual(ctx.fillPrice, null);
});

// ---------------------------------------------------------------------------
// GAP-PRICE
// ---------------------------------------------------------------------------
run('GAP-PRICE-1 live chain price (135) makes a stale slot-117 a gap-evacuation candidate', () => {
    const stale = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119',
        rawChainOrder('1.7.119', ORDER_TYPES.BUY, 135));
    const grid = new Map([['slot-117', stale]]);
    // boundary 33, gap 4 => band 34..37; live price 135 => idx 35.
    const candidates = detectGapEvacuationCandidates(grid, 33, 4, { assets: ASSETS, genesis: GENESIS });
    assert.strictEqual(candidates.length, 1, `expected one candidate: ${JSON.stringify(candidates)}`);
    assert.strictEqual(candidates[0].idx, 35);
    assert.ok(Math.abs(candidates[0].price - 135) < 1e-9, 'candidate must carry the live price');
});

run('GAP-PRICE-2 a genuinely in-rail live price is NOT a candidate', () => {
    const safe = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119',
        rawChainOrder('1.7.119', ORDER_TYPES.BUY, 120));
    const grid = new Map([['slot-117', safe]]);
    const candidates = detectGapEvacuationCandidates(grid, 33, 4, { assets: ASSETS, genesis: GENESIS });
    assert.strictEqual(candidates.length, 0, 'in-rail live price must not be evacuated');
});

run('GAP-PRICE-3 queued evacuation stays valid while the LIVE price is in-band', () => {
    const stale = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119',
        rawChainOrder('1.7.119', ORDER_TYPES.BUY, 135));
    const manager = {
        assets: ASSETS,
        _genesis: GENESIS,
        boundaryIdx: 33,
        _gapSlots: 4,
        orders: new Map([['slot-117', stale]])
    };
    const entry = { chainOrderId: '1.7.119', gridOrder: { id: 'slot-117' }, type: ORDER_TYPES.BUY, gapEvacuation: true };
    const check = _validatePriceCorrectionEntry(manager, entry);
    assert.strictEqual(check.valid, true, `live in-band price must keep the eviction live: ${JSON.stringify(check)}`);
});

run('GAP-PRICE-4 the same queued evacuation drops once the live price is back in the rail', () => {
    const safe = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119',
        rawChainOrder('1.7.119', ORDER_TYPES.BUY, 120));
    const manager = {
        assets: ASSETS,
        _genesis: GENESIS,
        boundaryIdx: 33,
        _gapSlots: 4,
        orders: new Map([['slot-117', safe]])
    };
    const entry = { chainOrderId: '1.7.119', gridOrder: { id: 'slot-117' }, type: ORDER_TYPES.BUY, gapEvacuation: true };
    const check = _validatePriceCorrectionEntry(manager, entry);
    assert.strictEqual(check.valid, false);
    assert.ok(/gap band/.test(check.reason), `reason must name the band: ${check.reason}`);
});

run('GAP-PRICE-5 resolveLiveOrderLadderPosition prefers the chain price over the slot id', () => {
    const stale = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119',
        rawChainOrder('1.7.119', ORDER_TYPES.BUY, 135));
    const live = resolveLiveOrderLadderPosition(stale, ASSETS, GENESIS);
    assert.strictEqual(live.idx, 35);
    assert.ok(Math.abs(live.price - 135) < 1e-9);
});

// ---------------------------------------------------------------------------
// CROSS-PRICE
// ---------------------------------------------------------------------------
run('CROSS-PRICE-1 the crossing guard sees the LIVE price of a stale-slot buy', () => {
    const stale = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119',
        rawChainOrder('1.7.119', ORDER_TYPES.BUY, 1345.73));
    const manager = { orders: new Map([['slot-117', stale]]), assets: ASSETS, _genesis: GENESIS };
    const candidates = buildCrossingCheckCandidates(manager);
    const crossed = findCrossedOrder(candidates, 1345.728664, ORDER_TYPES.SELL, ASSETS);
    assert.ok(crossed, 'a sell at 1345.728664 must cross the live buy at 1345.73');
    assert.strictEqual(crossed.id, 'slot-117');
});

run('CROSS-PRICE-2 without the chain snapshot the stored slot price misses the cross (control)', () => {
    const stale = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119', null);
    const manager = { orders: new Map([['slot-117', stale]]), assets: ASSETS, _genesis: GENESIS };
    const candidates = buildCrossingCheckCandidates(manager);
    const crossed = findCrossedOrder(candidates, 1345.728664, ORDER_TYPES.SELL, ASSETS);
    assert.strictEqual(crossed, null, 'control: the stale 1267 price cannot cross 1345.73');
});

run('CROSS-PRICE-3 a sell safely above the live buy is not blocked', () => {
    const stale = slot('slot-117', ORDER_TYPES.BUY, 1267.307972, '1.7.119',
        rawChainOrder('1.7.119', ORDER_TYPES.BUY, 1345.73));
    const manager = { orders: new Map([['slot-117', stale]]), assets: ASSETS, _genesis: GENESIS };
    const candidates = buildCrossingCheckCandidates(manager);
    const crossed = findCrossedOrder(candidates, 1346.0, ORDER_TYPES.SELL, ASSETS);
    assert.strictEqual(crossed, null);
});

console.log(`\nLIVE-GEOMETRY summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

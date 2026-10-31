/**
 * LAST-FILL-GUARD pivot persistence test suite (LFP-1..7).
 *
 * Covers:
 * - storeMasterGrid lastFillPivot sanitization + round-trip (shape gate,
 *   explicit null clears, undefined is a legacy no-op)
 * - persistGridSnapshot provenance gate: fill pivots ride the snapshot,
 *   book-seeded / cold / legacy-stub managers clear the row
 * - restoreLastFillPivot validation chain: shape, TTL expiry, genesis
 *   binding (dead generation dropped + disk row erased), on-grid
 *   one-increment drift rule (snap accepted / far-off refused)
 * - resetLastFillPivot cold-state clear
 *
 * Synthetic geometry only (start 100, 0.5% increments) — no real
 * accounts, pairs, or live identifiers.
 */

const assert = require('assert');
const { AccountOrders } = require('../modules/account_orders');
const {
    persistGridSnapshot,
    restoreLastFillPivot,
    resetLastFillPivot,
    resolveLastFillGuardReference,
} = require('../modules/order/utils/system');
const { isLastFillGuardBlocked } = require('../modules/dexbot_cow_runtime');
const { ORDER_TYPES, DEFAULT_CONFIG } = require('../modules/constants');

// Synthetic genesis helper: deterministic ladder like the runtime builds.
function buildGenesis(startPrice = 100, incrementPercent = 0.5, count = 40) {
    const levels: number[] = [];
    let price = startPrice;
    for (let i = 0; i < count; i++) {
        levels.push(Number(price.toFixed(10)));
        price = price * (1 + incrementPercent / 100);
    }
    // Mirror hashPriceLevels' algorithm (tiny FNV over pipe-joined 12-decimals)
    const str = levels.map((p: number) => p.toFixed(12)).join('|');
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return { priceLevels: levels, priceLevelsHash: (h >>> 0).toString(16).padStart(8, '0'), incrementPercent };
}

const LEVEL0 = 100; // genesis.priceLevels[0]
const FILLS_AT = 1_700_000_000_000;

function fillRow(overrides: Record<string, any> = {}) {
    return {
        price: LEVEL0,
        type: 'sell',
        fillsAt: FILLS_AT,
        genesisHash: 'abc12345',
        ...overrides,
    };
}

async function testLFP1_StoreLoadRoundTrip() {
    console.log('\n[LFP-1] storeMasterGrid round-trips a well-formed pivot row...');
    const accountOrders = new AccountOrders({ botKey: 'last-fill-pivot-roundtrip' });
    await accountOrders.storeMasterGrid(
        [{ id: 'slot-0', type: 'buy', state: 'virtual', price: LEVEL0, size: 0, orderId: null }],
        0, 0, null, null, null, null,
        undefined, undefined,
        { price: LEVEL0, type: 'buy', fillsAt: FILLS_AT, genesisHash: 'abc12345' }
    );
    const loaded = accountOrders.loadLastFillPivot();
    assert.deepStrictEqual(loaded, {
        price: LEVEL0, type: 'buy', fillsAt: FILLS_AT, genesisHash: 'abc12345',
    }, 'row survives the persist/load round-trip normalized');
    // Garbage rows never surface: all rejected as null.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, { price: 0, type: 'buy', fillsAt: 1, genesisHash: 'x' });
    assert.strictEqual(accountOrders.loadLastFillPivot(), null, 'non-positive price rejected');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined,
        { price: LEVEL0, type: 'sideways', fillsAt: 1, genesisHash: 'x' });
    assert.strictEqual(accountOrders.loadLastFillPivot(), null, 'invalid side rejected');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined,
        { price: LEVEL0, type: 'buy', fillsAt: Number.NaN, genesisHash: 'x' });
    assert.strictEqual(accountOrders.loadLastFillPivot(), null, 'non-finite fillsAt rejected');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined,
        { price: LEVEL0, type: 'buy', fillsAt: 1 });
    assert.strictEqual(accountOrders.loadLastFillPivot(), null, 'missing genesisHash rejected');
    console.log('✓ LFP-1 passed');
}

async function testLFP2_NullClears_UndefinedNoOp() {
    console.log('\n[LFP-2] explicit null clears the row; undefined stays a legacy no-op...');
    const accountOrders = new AccountOrders({ botKey: 'last-fill-pivot-nullclear' });
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined,
        { price: LEVEL0, type: 'sell', fillsAt: FILLS_AT, genesisHash: 'abc12345' });
    assert.ok(accountOrders.loadLastFillPivot(), 'row persisted');
    // Explicit null (live cold manager) must clear, not leave a stale row.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, null);
    assert.strictEqual(accountOrders.loadLastFillPivot(), null, 'null clears the stored row');
    // Re-store, then a legacy caller (undefined) must leave it untouched.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined,
        { price: LEVEL0, type: 'buy', fillsAt: FILLS_AT, genesisHash: 'abc12345' });
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined);
    assert.deepStrictEqual(accountOrders.loadLastFillPivot(), {
        price: LEVEL0, type: 'buy', fillsAt: FILLS_AT, genesisHash: 'abc12345',
    }, 'undefined param is a no-op (backward-compatible callers)');
    // clearGrid() wipes the row with the snapshot generation.
    await accountOrders.clearGrid();
    assert.strictEqual(accountOrders.loadLastFillPivot(), null, 'clearGrid wipes the pivot generation');
    await accountOrders.clearPersistedLastFillPivot();
    assert.strictEqual(accountOrders.loadLastFillPivot(), null, 'explicit erase stays a no-op when absent');
    console.log('✓ LFP-2 passed');
}

async function testLFP3_SnapshotProvenanceGate() {
    console.log('\n[LFP-3] persistGridSnapshot persists only fill-provenanced pivots...');
    let captured: any = null;
    const accountOrders = {
        storeMasterGrid: async (...args: any[]) => { captured = args; },
    };
    const base = {
        orders: new Map(),
        funds: { btsFeesOwed: 0 },
        accountTotals: null,
        boundaryIdx: 5,
        assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
        config: null,
        _recentFillKeysSnapshot: null,
        _lastGridPricingContext: null,
        _gapEvacStreaks: undefined,
        _pendingFillCrawls: undefined,
    };
    // Fill-provenanced pivot with a live genesis → persisted with live hash.
    await persistGridSnapshot({
        ...base,
        _lastFilledPrice: LEVEL0,
        _lastFilledType: 'buy',
        _lastFilledAt: FILLS_AT,
        lastFillPivotSource: 'fill',
        _genesis: { priceLevelsHash: 'livehash01' },
    } as any, accountOrders as any);
    assert.deepStrictEqual(captured[9], {
        price: LEVEL0, type: 'buy', fillsAt: FILLS_AT, genesisHash: 'livehash01',
    }, 'fill pivot rides the 10th storeMasterGrid param');
    // Book-provenanced pivot → cleared, never fossilized as market truth.
    await persistGridSnapshot({
        ...base,
        _lastFilledPrice: LEVEL0,
        _lastFilledType: 'buy',
        _lastFilledAt: FILLS_AT,
        lastFillPivotSource: 'book',
        _genesis: null,
    } as any, accountOrders as any);
    assert.strictEqual(captured[9], null, 'book seed never persists');
    // Legacy stub (no pivot fields at all) → clear, not undefined tombstone.
    await persistGridSnapshot({ ...base, _genesis: null } as any, accountOrders as any);
    assert.strictEqual(captured[9], null, 'cold manager always passes an explicit clear');
    console.log('✓ LFP-3 passed');
}

async function testLFP4_RestoreValidatesShapeAndArms() {
    console.log('\n[LFP-4] restoreLastFillPivot arms a validated on-grid pivot...');
    const manager: any = {
        orders: new Map(),
        config: { incrementPercent: 0.5 },
        _genesis: { priceLevels: [LEVEL0, 100.5, 101], priceLevelsHash: 'abc12345' },
        _lastFilledPrice: null,
        _lastFilledType: null,
        _lastFilledAt: 0,
        lastFillPivotSource: null,
        logger: { log: () => {} },
    };
    const ok = restoreLastFillPivot(manager, fillRow({ type: 'buy' }), { now: FILLS_AT + 1000 });
    assert.strictEqual(ok, true, 'pivot restores');
    assert.strictEqual(manager._lastFilledPrice, LEVEL0, 'armed at the ladder level');
    assert.strictEqual(manager._lastFilledType, 'buy');
    assert.strictEqual(manager._lastFilledAt, FILLS_AT, 'original fillsAt preserved (TTL means age-of-fill, not age-of-restart)');
    assert.strictEqual(manager.lastFillPivotSource, 'fill', 'restored pivot keeps fill provenance');
    assert.strictEqual(manager._lastFilledBuyPrice, LEVEL0, 'per-side mirror follows the pivot side');

    // Bad shapes never arm.
    assert.strictEqual(restoreLastFillPivot(manager, null), false);
    assert.strictEqual(restoreLastFillPivot(null, fillRow()), false);
    assert.strictEqual(restoreLastFillPivot(manager, fillRow({ price: -1 })), false);
    assert.strictEqual(restoreLastFillPivot(manager, fillRow({ type: 'spread' })), false);
    assert.strictEqual(restoreLastFillPivot(manager, fillRow({ fillsAt: 0 })), false);
    console.log('✓ LFP-4 passed');
}

async function testLFP5_TTLExpiry() {
    console.log('\n[LFP-5] a pivot older than LAST_FILL_PIVOT_TTL_MS expires...');
    const manager: any = {
        orders: new Map(),
        config: { incrementPercent: 0.5 },
        _genesis: { priceLevels: [LEVEL0], priceLevelsHash: 'abc12345' },
        _lastFilledPrice: null,
        _lastFilledType: null,
        lastFillPivotSource: null,
        logger: { log: () => {} },
    };
    const { GRID_LIMITS } = require('../modules/constants');
    const ttl = Number(GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS);
    const justInside = restoreLastFillPivot(manager, fillRow(), { now: FILLS_AT + ttl - 1 });
    assert.strictEqual(justInside, true, 'pivot inside the TTL restores');
    resetLastFillPivot(manager, 'reset');
    const expired = restoreLastFillPivot(manager, fillRow(), { now: FILLS_AT + ttl + 1 });
    assert.strictEqual(expired, false, 'pivot past the TTL is refused');
    assert.strictEqual(manager._lastFilledPrice, null, 'expired pivot leaves the guard cold');
    console.log('✓ LFP-5 passed');
}

async function testLFP6_GenesisMismatchDropsAndErases() {
    console.log('\n[LFP-6] a pivot from a dead genesis is refused and erased from disk...');
    const accountOrders = new AccountOrders({ botKey: 'last-fill-pivot-genesis' });
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined,
        { price: LEVEL0, type: 'buy', fillsAt: FILLS_AT, genesisHash: 'deadgen000' });
    const manager: any = {
        orders: new Map(),
        config: { incrementPercent: 0.5 },
        _genesis: { priceLevels: [LEVEL0], priceLevelsHash: 'freshgen99' },
        _lastFilledPrice: null,
        _lastFilledType: null,
        lastFillPivotSource: null,
        accountOrders,
        logger: { log: () => {} },
    };
    const ok = restoreLastFillPivot(manager, accountOrders.loadLastFillPivot(), { now: FILLS_AT + 1000 });
    assert.strictEqual(ok, false, 'mismatched genesis is refused');
    assert.strictEqual(manager._lastFilledPrice, null, 'no poisoned arm');
    const erased = accountOrders.loadLastFillPivot(true);
    assert.strictEqual(erased, null, 'disk row erased so it cannot re-arm next restart');
    console.log('✓ LFP-6 passed');
}

async function testLFP7_OffLadderPivotRefused() {
    console.log('\n[LFP-7] a wildly off-ladder pivot falls back to the book seed...');
    const manager: any = {
        orders: new Map(),
        config: { incrementPercent: 0.5 },
        // 100 / 100.5 / 101 ladder: a price 10% away must not snap onto an edge.
        _genesis: { priceLevels: [LEVEL0, 100.5, 101], priceLevelsHash: 'abc12345' },
        _lastFilledPrice: null,
        _lastFilledType: null,
        lastFillPivotSource: null,
        logger: { log: () => {} },
    };
    const ok = restoreLastFillPivot(manager, fillRow({ price: 150 }), { now: FILLS_AT + 1000 });
    assert.strictEqual(ok, false, 'off-ladder pivot refused');
    assert.strictEqual(manager._lastFilledPrice, null, 'guard not armed on grid-unrelated truth');
    // A pivot on the ladder within one increment drift snaps cleanly.
    const snapped = restoreLastFillPivot(manager, fillRow({ price: LEVEL0 * 1.002, type: 'buy' }), { now: FILLS_AT + 1000 });
    assert.strictEqual(snapped, true, 'near-ladder pivot snaps to its slot level');
    assert.strictEqual(manager._lastFilledPrice, LEVEL0, 'snapped to the genesis level');
    assert.strictEqual(manager._lastFilledAt, FILLS_AT, 'snap preserves the original fill timestamp');
    resetLastFillPivot(manager, 'reset');
    assert.strictEqual(manager._lastFilledPrice, null, 'resetLastFillPivot returns the guard to cold');
    assert.strictEqual(manager.lastFillPivotSource, null);
    console.log('✓ LFP-7 passed');
}

async function testLFP8_ResetClearsWholeFamily() {
    console.log('\n[LFP-8] reset clears the per-side mirrors too (book re-seed not suppressed)...');
    const { setLastFillPivot } = require('../modules/order/utils/system');
    const manager: any = {
        orders: new Map(),
        logger: { log: () => {} },
    };
    // Arm both sides through the shared writer, then reset.
    assert.strictEqual(setLastFillPivot(manager, 'buy', 99, 'fill'), true);
    assert.strictEqual(setLastFillPivot(manager, 'sell', 101, 'fill'), true);
    assert.strictEqual(manager._lastFilledBuyPrice, 99, 'per-side mirror set by the shared writer');
    assert.strictEqual(manager._lastFilledSellPrice, 101, 'per-side mirror set by the shared writer');
    resetLastFillPivot(manager, 'grid rebuild');
    const mirrors = { buy: manager._lastFilledBuyPrice, sell: manager._lastFilledSellPrice };
    assert.deepStrictEqual(mirrors, { buy: null, sell: null }, 'per-side mirrors cleared — seed cold-check must not early-return');
    assert.strictEqual(manager._lastFilledPrice, null);
    assert.strictEqual(manager._lastFilledType, null);
    assert.strictEqual(manager._lastFilledAt, 0);
    assert.strictEqual(manager.lastFillPivotSource, null);
    // Mirror of seedLastFilledPricesFromBook's cold gate: both mirrors null
    // means the gate lets the book seed through.
    assert.strictEqual(
        manager._lastFilledBuyPrice != null && manager._lastFilledSellPrice != null,
        false,
        'cold-check would early-return: false'
    );
    // Also verify a fresh manager via the delegating method keeps the
    // atMs contract (restore path preserves the persisted timestamp).
    const { OrderManager } = require('../modules/order/manager');
    const real = new OrderManager({ assetA: 'A', assetB: 'B', startPrice: 100, incrementPercent: 0.5 });
    (real as any)._setLastFillPivot(ORDER_TYPES.BUY, 100, 'fill', FILLS_AT);
    assert.strictEqual((real as any)._lastFilledAt, FILLS_AT, 'atMs passed through the method wrapper');
    (real as any)._resetLastFillPivot('unit');
    assert.strictEqual((real as any)._lastFilledBuyPrice, null, 'manager method reset clears the whole family');
    console.log('✓ LFP-8 passed');
}

async function testLFP9_GuardFallsBackToMarketFillWhenPivotCold() {
    console.log('\n[LFP-9] generic LAST-FILL-GUARD keeps the market anchor across a rebuild...');
    // Cold pivot (post-rebuild) + a surviving bot-scoped market fill: the
    // guard must still see the last real fill, not report cold and let a
    // CREATE cross it.
    const cold: any = {
        _lastFilledPrice: null,
        _lastFilledType: null,
        lastFillPivotSource: null,
        _lastMarketFillPrice: 100,
        _lastMarketFillType: ORDER_TYPES.BUY,
        _lastMarketFillAt: FILLS_AT,
    };
    assert.deepStrictEqual(
        resolveLastFillGuardReference(cold),
        { price: 100, type: ORDER_TYPES.BUY },
        'cold pivot falls back to the bot-scoped market fill'
    );
    const { price, type } = resolveLastFillGuardReference(cold);
    assert.strictEqual(
        isLastFillGuardBlocked(100, ORDER_TYPES.BUY, price, type).blocked,
        true,
        'a BUY at/above the last fill is blocked via the fallback (guard not cold)'
    );
    assert.strictEqual(
        isLastFillGuardBlocked(99.5, ORDER_TYPES.BUY, price, type).blocked,
        false,
        'a BUY below the fallback floor is still allowed'
    );

    // An armed live pivot wins over the (older) market row.
    const armed: any = {
        _lastFilledPrice: 101,
        _lastFilledType: ORDER_TYPES.SELL,
        lastFillPivotSource: 'fill',
        _lastMarketFillPrice: 100,
        _lastMarketFillType: ORDER_TYPES.BUY,
        _lastMarketFillAt: FILLS_AT,
    };
    assert.deepStrictEqual(resolveLastFillGuardReference(armed), { price: 101, type: ORDER_TYPES.SELL });

    // Both cold => cold (fail-open), unchanged.
    assert.deepStrictEqual(
        resolveLastFillGuardReference({ _lastFilledPrice: null, _lastFilledType: null, lastFillPivotSource: null }),
        { price: null, type: null }
    );
    console.log('✓ LFP-9 passed');
}

async function runAllTests() {
    console.log('=== LAST-FILL-GUARD Pivot Persistence Test Suite ===\n');
    try {
        await testLFP1_StoreLoadRoundTrip();
        await testLFP2_NullClears_UndefinedNoOp();
        await testLFP3_SnapshotProvenanceGate();
        await testLFP4_RestoreValidatesShapeAndArms();
        await testLFP5_TTLExpiry();
        await testLFP6_GenesisMismatchDropsAndErases();
        await testLFP7_OffLadderPivotRefused();
        await testLFP8_ResetClearsWholeFamily();
        await testLFP9_GuardFallsBackToMarketFillWhenPivotCold();
        console.log('\nAll LAST-FILL-GUARD pivot persistence tests passed.');
    } catch (e: any) {
        console.error('Test failed:', e?.message ?? e);
        process.exit(1);
    }
}

runAllTests();

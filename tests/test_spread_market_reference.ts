/**
 * Spread-correction market-reference & readiness suite (SMR-1..10).
 *
 * Covers the robustness fixes for the "spread correction sells at/below the
 * market on a cold grid" incident (issue #31):
 *
 *  - SMR-1: cold book (no live order either side) => no correction at all,
 *           structural stall so the targeted chain sync arms.
 *  - SMR-2: planner never places a SELL at/below / BUY at/above the last real
 *           fill (bot-scoped reference restored across regeneration).
 *  - SMR-3: persistGridSnapshot round-trips the bot-scoped lastMarketFill row;
 *           clearGrid() PRESERVES it (must survive regeneration).
 *  - SMR-4: restoreLastMarketFill shape + TTL gates.
 *  - SMR-5: rejectCorruptedGridSnapshot keeps a pre-reject snapshot copy.
 *  - SMR-6: the LAST-FILL-GUARD bypass gate shares the market-reference
 *           predicate (live fill pivot OR restored market row both deny it),
 *           and a live refused-level marker denies it too.
 *  - SMR-7: the pure readiness gate: cold=refuse, stale/unmatched=degraded-ok,
 *           never-synced/fresh=trusted.
 *  - SMR-8: unmatched collision filter skips the covered price level but keeps
 *           planning the rest (P-C as a filter, never a deadlock).
 *  - SMR-9: the crossing floor is the fresh live market read when available and
 *           falls back to the fill anchor otherwise (no distance heuristic).
 *  - SMR-10: a stale + unmatched cycle still runs the collision filter (data-,
 *           not reason-keyed) and names the collision stall.
 *
 * Synthetic geometry only (start ~670, 0.3% increments) — no real accounts,
 * pairs, or live identifiers.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../modules/constants');
const { AccountOrders } = require('../modules/account_orders');
const { persistGridSnapshot, restoreLastMarketFill, evaluateSpreadCorrectionReadiness } = require('../modules/order/utils/system');
const { rejectCorruptedGridSnapshot } = require('../modules/dexbot_state_recovery');
const { isSpreadCorrectionBypassAllowed } = require('../modules/dexbot_cow_runtime');

const INCREMENT = 0.3;
const price = (idx: number): number => 670.368 * Math.pow(1 + INCREMENT / 100, idx);
const NOW = Date.now();

function makeManager() {
    return new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1052.06,
        botFunds: { buy: 20000, sell: 20000 },
        coreOrders: { buy: 20, sell: 20 },
        incrementPercent: INCREMENT,
        targetSpreadPercent: 1.5,
    });
}

async function buildGeometry(manager: any, liveBuy: [number, number], liveSell: [number, number]) {
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 },
    };
    manager.config.weightDistribution = { buy: 0.5, sell: 0.5 };
    manager.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
    const inRange = (i: number, r: [number, number]) => i >= r[0] && i <= r[1];
    for (let i = 0; i <= 291; i++) {
        const type = i <= 150 ? ORDER_TYPES.BUY : (i >= 156 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        const live = inRange(i, liveBuy) || inRange(i, liveSell);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: price(i),
            type,
            state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: live ? 2 : 0,
            orderId: live ? `1.7.${500000 + i}` : '',
        });
    }
    manager.boundaryIdx = 150;
    manager._gapSlots = 5;
    await manager.setAccountTotals({ buy: 20000, sell: 20000, buyFree: 20000, sellFree: 20000 });
    await manager.recalculateFunds();
}

// --- SMR-1: cold book places nothing and reports a structural stall --------
async function testSmr1ColdBookSkipsCorrection() {
    console.log('Running test: cold book skips spread correction');
    const manager = makeManager();
    // No live order on EITHER side.
    await buildGeometry(manager, [0, -1], [0, -1]);

    let batchCalls = 0;
    const result = await manager.checkSpreadCondition({}, async () => { batchCalls++; return { executed: true }; });

    assert.strictEqual(result.ordersPlaced, 0, 'cold book must place nothing');
    assert.strictEqual(result.stall, 'cold-book',
        `cold book must report the named structural stall (arms the targeted sync), got ${JSON.stringify(result.stall)}`);
    assert.strictEqual(batchCalls, 0, 'no correction batch may be planned on a cold book');
    console.log('  ✓ cold book places nothing and reports cold-book');
}

// --- SMR-2: planner must not place through the last real fill --------------
async function testSmr2NoPlacementThroughMarketRef() {
    console.log('Running test: correction never places through the last market fill');
    const manager = makeManager();
    // No live sells: the empty sell rail is the issue-#31 shape.
    await buildGeometry(manager, [131, 150], [0, -1]);

    // Last real fill was a SELL at price(159). Without the guard the sort
    // would pick the lowest sell slot (156) which is BELOW the market; the
    // strict at/below rule keeps 156-159 out and admits 160.
    manager._lastMarketFillPrice = price(159);
    manager._lastMarketFillType = ORDER_TYPES.SELL;
    manager._lastMarketFillAt = NOW;

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 5);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    assert(placed.length > 0, `expected a market-safe sell, got ${JSON.stringify(placed)}`);
    const ref = price(159);
    for (const id of placed) {
        const idx = Number(String(id).replace('slot-', ''));
        assert(
            price(idx) > ref,
            `${id} @ ${price(idx).toFixed(2)} must sit ABOVE the last fill ${ref.toFixed(2)}; ` +
            'a sell at/below the last traded price is the adverse fill this guard prevents'
        );
    }
    assert.strictEqual(placed[0], 'slot-160', `expected the lowest market-safe sell (slot-160), got ${placed[0]}`);
    console.log(`  ✓ filtered to market-safe sells above ${ref.toFixed(2)} (${JSON.stringify(placed)})`);

    // Fail-open: with no reference the historical behavior is unchanged.
    const cold = makeManager();
    await buildGeometry(cold, [131, 150], [0, -1]);
    const coldCorrection = await Grid.prepareSpreadCorrectionOrders(cold, ORDER_TYPES.SELL, 1);
    assert.deepStrictEqual(
        coldCorrection.ordersToPlace.map((o: any) => o.id), ['slot-156'],
        'no reference => fail-open, lowest sell slot still chosen'
    );
    console.log('  ✓ fail-open when no real fill is known');
}

// --- SMR-3: persistence round-trip; clearGrid preserves the row ------------
async function testSmr3MarketFillPersistence() {
    console.log('Running test: lastMarketFill persists and survives clearGrid');
    const accountOrders = new AccountOrders({ botKey: 'smr-market-fill-roundtrip' });

    // persistGridSnapshot reads manager._lastMarketFill* and passes it as the
    // 11th storeMasterGrid arg.
    const mgr: any = {
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
        _lastMarketFillPrice: 123.45,
        _lastMarketFillType: 'sell',
        _lastMarketFillAt: NOW,
    };
    await persistGridSnapshot(mgr, accountOrders);
    assert.deepStrictEqual(
        accountOrders.loadLastMarketFill(),
        { price: 123.45, type: 'sell', fillsAt: NOW },
        'market fill rides the snapshot persist'
    );

    // Absent-value contract matches lastFillPivot: null clears, malformed
    // clears, undefined is a legacy no-op.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined, null);
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'explicit null clears the stored row');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 0, type: 'sell', fillsAt: NOW });
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'non-positive price clears');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 100, type: 'sideways', fillsAt: NOW });
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'invalid side clears');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 100, type: 'sell', fillsAt: Number.NaN });
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'non-finite fillsAt clears');
    // Re-store a valid row, then confirm undefined is a no-op.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 123.45, type: 'sell', fillsAt: NOW });
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined);
    assert.deepStrictEqual(
        accountOrders.loadLastMarketFill(),
        { price: 123.45, type: 'sell', fillsAt: NOW },
        'undefined market-fill param is a no-op'
    );

    // clearGrid() destroys the grid generation but MUST keep the market row.
    await accountOrders.clearGrid();
    assert.deepStrictEqual(
        accountOrders.loadLastMarketFill(),
        { price: 123.45, type: 'sell', fillsAt: NOW },
        'clearGrid preserves the bot-scoped market-fill reference across regeneration'
    );
    console.log('  ✓ market-fill row round-trips, validates, and survives clearGrid');
}

// --- SMR-4: restoreLastMarketFill shape + TTL -------------------------------
async function testSmr4RestoreGates() {
    console.log('Running test: restoreLastMarketFill shape and TTL gates');
    const mk = (row: any) => {
        const m = makeManager();
        const restored = restoreLastMarketFill(m, row);
        return { m, restored };
    };

    assert.strictEqual(mk(null).restored, false, 'null row is a no-op');
    assert.strictEqual(mk({ price: 0, type: 'buy', fillsAt: NOW }).restored, false, 'invalid price refused');
    assert.strictEqual(mk({ price: 10, type: 'spread', fillsAt: NOW }).restored, false, 'invalid side refused');

    const fresh = mk({ price: 42.5, type: 'buy', fillsAt: NOW });
    assert.strictEqual(fresh.restored, true, 'fresh row restored');
    assert.strictEqual(fresh.m._lastMarketFillPrice, 42.5, 'price written');
    assert.strictEqual(fresh.m._lastMarketFillType, 'buy', 'type written');

    const expired = mk({ price: 42.5, type: 'buy', fillsAt: NOW - 48 * 60 * 60 * 1000 });
    assert.strictEqual(expired.restored, false, 'row past the 24h TTL refused');
    assert.strictEqual(expired.m._lastMarketFillPrice, null, 'expired row does not arm');
    console.log('  ✓ shape + TTL gates enforced');
}

// --- SMR-6: the LAST-FILL-GUARD bypass gate --------------------------------
// The gate resolves through resolveSpreadMarketReference, the SAME predicate
// the planner's crossing filter uses. So: any real market reference (live
// fill pivot OR persisted market row) denies the bypass; only a cold/book
// reference with a fresh snapshot keeps the historical fail-open bypass.
async function testSmr6BypassGate() {
    console.log('Running test: spread-correction bypass gate');
    const gate = (manager: any) => isSpreadCorrectionBypassAllowed({ manager });

    assert.strictEqual(
        gate({
            lastFillPivotSource: 'fill',
            _lastFilledPrice: 100, _lastFilledType: ORDER_TYPES.BUY,
            _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now(),
        }),
        false,
        'a live real-fill pivot must never bypass the guard'
    );
    assert.strictEqual(
        gate({
            lastFillPivotSource: null,
            _lastMarketFillPrice: 100, _lastMarketFillType: ORDER_TYPES.SELL,
            _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now(),
        }),
        false,
        'a restored (bot-scoped) market reference must deny the bypass too — same predicate as the planner'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: null, _lastUnmatchedChainOrders: [], _lastSyncAt: 0 }),
        true,
        'cold reference with unknown sync time fails open (historical behavior)'
    );
    // Book-seed proxy case (b14a1fc8): before the first real fill a single-sided
    // book arms the guard on our own resting quote. That proxy is deliberately
    // non-persistent and may go wrong when the book is not adjacent to the last
    // fill, so the correction keeps the historical bypass. This assertion locks
    // the remaining purpose of the gate: do not delete it as dead code.
    assert.strictEqual(
        gate({
            lastFillPivotSource: 'book',
            _lastFilledPrice: 100, _lastFilledType: ORDER_TYPES.SELL,
            _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now(),
        }),
        true,
        'a book-seeded pivot (no real fill reference) keeps the proxy-case bypass'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: null, _lastUnmatchedChainOrders: [{}], _lastSyncAt: Date.now() }),
        false,
        'known-unmatched chain orders make the snapshot untrustworthy -> no bypass'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: 'book', _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now() - 60 * 60 * 1000 }),
        false,
        'stale sync age withholds the bypass'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: 'book', _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now() }),
        true,
        'fresh snapshot with a book pivot keeps the bypass'
    );
    // A premium sweep refused from arming leaves a cold pivot and no market
    // row, so the refused-level marker is the only fill evidence. The bypass
    // must not skip the only guard that reads it (SMR-6 extension).
    const refusedMarker = (at: number) => ({
        lastFillPivotSource: null as string | null,
        _lastUnmatchedChainOrders: [] as unknown[],
        _lastSyncAt: Date.now(),
        _lastRefusedFillLevels: [{ price: 1050, type: ORDER_TYPES.SELL, at }]
    });
    assert.strictEqual(
        gate(refusedMarker(NOW)),
        false,
        'a live refused-level marker is fill evidence and denies the bypass'
    );
    assert.strictEqual(
        gate(refusedMarker(NOW - Number(GRID_LIMITS.LAST_FILL_REFUSED_LEVEL_TTL_MS) - 1000)),
        true,
        'an expired refused-level marker no longer denies the bypass'
    );
    console.log('  \u2713 bypass withheld for real fill evidence (incl. refused markers) / stale snapshots, kept for fresh heuristics');
}

// --- SMR-7: pure readiness gate ---------------------------------------------
async function testSmr7ReadinessGate() {
    console.log('Running test: evaluateSpreadCorrectionReadiness verdicts');
    const noChain = { buys: [], sells: [] };
    const someChain = { buys: [{}], sells: [{}] };

    // Cold: hard refusal.
    const coldR = evaluateSpreadCorrectionReadiness(makeManager(), { onChainOrders: noChain });
    assert.strictEqual(coldR.ok, false, 'cold book is a hard refusal');
    assert.strictEqual(coldR.reason, 'cold-book', 'cold reason named');

    // Never synced: degraded but trusted (historical fail-open).
    const neverR = evaluateSpreadCorrectionReadiness(makeManager(), { onChainOrders: someChain });
    assert.strictEqual(neverR.ok, true, 'never-synced still plans');
    assert.strictEqual(neverR.snapshotTrusted, true, 'never-synced is treated as fresh (fail-open)');
    assert.strictEqual(neverR.reason, null, 'no degraded reason when fresh');

    // Stale sync: degraded-ok, untrusted.
    const stale = makeManager();
    stale._lastSyncAt = NOW - 60 * 60 * 1000;
    const staleR = evaluateSpreadCorrectionReadiness(stale, { onChainOrders: someChain, now: NOW });
    assert.strictEqual(staleR.ok, true, 'stale snapshot still plans (degraded-ok)');
    assert.strictEqual(staleR.snapshotTrusted, false, 'stale snapshot withholds the bypass');
    assert.strictEqual(staleR.reason, 'stale-snapshot', 'stale reason named');

    // Unmatched: degraded-ok, untrusted.
    const unmatched = makeManager();
    unmatched._lastSyncAt = NOW;
    unmatched._lastUnmatchedChainOrders = [{ price: 1, orderId: '1.7.9' }];
    const unR = evaluateSpreadCorrectionReadiness(unmatched, { onChainOrders: someChain, now: NOW });
    assert.strictEqual(unR.ok, true, 'unmatched snapshot still plans (degraded-ok)');
    assert.strictEqual(unR.snapshotTrusted, false, 'unmatched snapshot withholds the bypass');
    assert.strictEqual(unR.reason, 'unmatched-orders', 'unmatched reason named');

    // Fresh: fully ready.
    const fresh = makeManager();
    fresh._lastSyncAt = NOW;
    const freshR = evaluateSpreadCorrectionReadiness(fresh, { onChainOrders: someChain, now: NOW });
    assert.strictEqual(freshR.ok, true, 'fresh book plans');
    assert.strictEqual(freshR.snapshotTrusted, true, 'fresh book trusted');
    assert.strictEqual(freshR.reason, null, 'fresh book has no reason');

    // A gate failure refuses the cycle (correct-by-refusal); it must not plan
    // with no floor. Force a throw via a poisoned config getter.
    const broken: any = makeManager();
    Object.defineProperty(broken, 'config', { get() { throw new Error('boom'); }, configurable: true });
    const brokenR = evaluateSpreadCorrectionReadiness(broken, { onChainOrders: someChain });
    assert.strictEqual(brokenR.ok, false, 'gate failure refuses the cycle (correct-by-refusal)');
    assert.strictEqual(brokenR.reason, null, 'gate failure has no premise reason');

    // The planner maps a gate failure to its own stall (not 'no-candidates'),
    // so the targeted-sync reason names the fault. Poison only config.timing so
    // the gate throws while the rest of the planner can still run.
    const brokenPlanner: any = makeManager();
    await buildGeometry(brokenPlanner, [0, -1], [160, 175]);
    Object.defineProperty(brokenPlanner.config, 'timing', { get() { throw new Error('boom'); }, configurable: true });
    const brokenCorrection = await Grid.prepareSpreadCorrectionOrders(brokenPlanner, ORDER_TYPES.SELL, 1);
    assert.strictEqual(brokenCorrection.stallHint, 'readiness-gate',
        `gate failure must map to 'readiness-gate', got ${brokenCorrection.stallHint}`);
    console.log('  ✓ cold=refuse; stale/unmatched=degraded-ok; never-synced/fresh=trusted; gate-error=refuse+readiness-gate');
}

// --- SMR-8: unmatched collision filter (P-C) --------------------------------
async function testSmr8UnmatchedCollisionFilter() {
    console.log('Running test: unmatched collision filter skips covered price levels');
    const manager = makeManager();
    await buildGeometry(manager, [0, -1], [160, 175]);
    manager._lastSyncAt = NOW;
    manager._lastUnmatchedChainOrders = [{ price: price(156), orderId: '1.7.u1' }];

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 5);
    const placed = correction.ordersToPlace.map((o: any) => o.id);
    assert(!placed.includes('slot-156'), `colliding slot-156 must be skipped, got ${JSON.stringify(placed)}`);
    assert(placed.length > 0, `other sells must still be planned, got ${JSON.stringify(placed)}`);
    console.log(`  ✓ skipped colliding slot-156, planned ${JSON.stringify(placed)}`);
}

// --- SMR-9: live market price is the crossing floor -------------------------
async function testSmr9LiveMarketPricePreferred() {
    console.log('Running test: live market price is the crossing floor');
    const manager = makeManager();
    await buildGeometry(manager, [0, -1], [160, 175]);

    // PART A — the live read IS the crossing floor when no fill anchor exists.
    // A fresh live read sits just above the empty sell band (price 157), so the
    // market-safe sells above it must be planned. (A fill anchor would be a
    // separate floor — see PART B — so it is deliberately absent here.)
    manager._lastMarketFillPrice = null;
    manager._lastMarketFillType = null;
    manager._lastMarketFillAt = 0;
    manager._liveMarketPrice = price(157);
    manager._liveMarketPriceAt = NOW;

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 5);
    const placed = correction.ordersToPlace.map((o: any) => o.id);
    assert(placed.length > 0, `fresh live floor must admit market-safe sells, got ${JSON.stringify(placed)}`);
    for (const id of placed) {
        const idx = Number(String(id).replace('slot-', ''));
        assert(price(idx) > price(157),
            `${id} must sit above the live market read ${price(157).toFixed(2)}, got ${price(idx).toFixed(2)}`);
    }

    // PART B — without a live read the fill anchor is the fallback floor. It is
    // ALSO the last-fill reference the planner now shares with the broadcast
    // guard, so a stale anchor above the window legitimately walls the side off
    // (the planner no longer plans creates the guard would drop).
    manager._liveMarketPrice = null;
    manager._liveMarketPriceAt = 0;
    manager._lastMarketFillPrice = price(200);
    manager._lastMarketFillType = ORDER_TYPES.SELL;
    manager._lastMarketFillAt = NOW;
    const fallbackCorrection = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 5);
    assert.strictEqual(fallbackCorrection.ordersToPlace.length, 0,
        'without a live read the fill anchor is the floor (fallback) and no sell may be placed below it');
    console.log(`  ✓ fresh live market price preferred (${JSON.stringify(placed)}); fill anchor is the fallback`);
}

// --- SMR-10: stale + unmatched co-occurrence --------------------------------
// `reason` is priority-ranked (cold > stale > unmatched), so a stale+unmatched
// cycle reports 'stale-snapshot' while `unmatched` is fully populated. The
// collision filter must key off the DATA, or P4 protection silently expires at
// the freshness boundary while the chain orders are still resting.
async function testSmr10StaleUnmatchedCombined() {
    console.log('Running test: stale + unmatched still filters collisions');

    // Part A: one colliding level among several candidates is still skipped.
    const manager = makeManager();
    await buildGeometry(manager, [0, -1], [160, 175]);
    manager._lastSyncAt = NOW - 60 * 60 * 1000; // stale
    manager._lastUnmatchedChainOrders = [{ price: price(159), orderId: '1.7.u2' }];

    const readiness = evaluateSpreadCorrectionReadiness(manager, {
        onChainOrders: { buys: [], sells: [{}] }, now: NOW
    });
    assert.strictEqual(readiness.reason, 'stale-snapshot', 'stale ranks above unmatched');
    assert.strictEqual(readiness.unmatched.length, 1, 'unmatched data is still present');

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 5);
    const placed = correction.ordersToPlace.map((o: any) => o.id);
    assert(!placed.includes('slot-159'), `colliding slot-159 must be skipped even when stale, got ${JSON.stringify(placed)}`);
    assert(placed.length > 0, `other sells must still be planned, got ${JSON.stringify(placed)}`);

    // Part B: when every candidate level collides, the stall names the collision.
    const all = makeManager();
    await buildGeometry(all, [0, -1], [160, 175]);
    all._lastSyncAt = NOW - 60 * 60 * 1000; // stale mask
    all._lastUnmatchedChainOrders = [];
    for (let i = 150; i <= 159; i++) all._lastUnmatchedChainOrders.push({ price: price(i), orderId: `1.7.u${i}` });
    const allCorrection = await Grid.prepareSpreadCorrectionOrders(all, ORDER_TYPES.SELL, 5);
    assert.strictEqual(allCorrection.ordersToPlace.length, 0, 'every candidate collides => place nothing');
    assert.strictEqual(allCorrection.stallHint, 'unmatched-orders',
        `stall must name the collision cause, got ${allCorrection.stallHint}`);
    console.log(`  ✓ stale+unmatched: slot-159 skipped (${JSON.stringify(placed)}); all-collide => unmatched-orders`);
}

// --- SMR-5: reject backstop keeps a pre-reject snapshot copy ----------------
async function testSmr5RejectBackupCopy() {
    console.log('Running test: rejectCorruptedGridSnapshot backs up before clear');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smr-reject-'));
    const botKey = 'smr-reject-backup';
    try {
        const accountOrders = new AccountOrders({ botKey, ordersDir: tmpDir });
        await accountOrders.storeMasterGrid(
            [{ id: 'slot-0', type: 'buy', state: 'virtual', price: 100, size: 1, orderId: null }],
            0, 0, null, null, null, null
        );

        const warnings: string[] = [];
        const bot: any = {
            accountOrders,
            _warn: (msg: string) => { warnings.push(String(msg)); },
            manager: {
                checkFundDriftAfterFills: () => ({ isValid: false, driftSell: 1, driftBuy: 0 }),
                _restoreBoundary: () => {},
                boundaryIdx: 0,
                _clearPendingFillCrawls: () => {},
                _resetLastFillPivot: () => {},
            },
        };

        const rejected = await rejectCorruptedGridSnapshot(bot, 'startup');
        assert.strictEqual(rejected, true, 'drift must trigger rejection');

        const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.rejected-drift-'));
        assert.strictEqual(backups.length, 1, `expected exactly one backup copy, got ${JSON.stringify(backups)}`);
        const backupData = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'));
        assert.strictEqual(backupData.grid?.[0]?.id, 'slot-0', 'backup holds the pre-reject grid');
        assert(
            warnings.some((w) => w.includes('Kept pre-reject snapshot copy')),
            `expected a backup log line, got ${JSON.stringify(warnings)}`
        );
        console.log('  ✓ pre-reject snapshot copy written');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

(async () => {
    await testSmr1ColdBookSkipsCorrection();
    await testSmr2NoPlacementThroughMarketRef();
    await testSmr3MarketFillPersistence();
    await testSmr4RestoreGates();
    await testSmr6BypassGate();
    await testSmr5RejectBackupCopy();
    await testSmr7ReadinessGate();
    await testSmr8UnmatchedCollisionFilter();
    await testSmr9LiveMarketPricePreferred();
    await testSmr10StaleUnmatchedCombined();
    console.log('PASS test_spread_market_reference');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

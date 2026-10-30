const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// Regression test: spread correction must target the MARKET, not the rail.
//
// Production incident (a live market-pair bot, 292-slot rail, ~0.3%/slot):
// the live SELL window occupied slots 156-175 (best sell 1071.2) while 116
// empty sell slots lay above it, out to the grid ceiling at ~1605. Spread
// correction fired twice in one evening and created
//   1.7.574990982  sell slot-291 @ 1605.17
//   1.7.574991281  sell slot-290 @ 1600.36
// Neither order could narrow the spread by a single tick — both sat ~50%
// ABOVE bestSell — and the next full resync cancelled both as surplus
// ("Startup: Cancelled stale surplus SELL order"), so the resync existed only
// to clean up after the correction path.
//
// Two independent defects combined to produce this:
//
//   1. `sortCandidates` had two branches (windowFirst when the rail had live
//      orders, edgeFirst otherwise) that were written as exact OPPOSITES. The
//      SELL/windowed branch sorted DESCENDING and so resolved to the grid
//      ceiling. The two rails are not symmetric here: empty slots always sit
//      on the FAR side of the live window, so market-nearest and
//      window-adjacent are the SAME slot and one comparator serves both.
//
//   2. The merge order led with the rail-wide orphan pool, which was capped at
//      missingSlots on its own. With missingSlots=1 it consumed the entire
//      quota, so the gap-band promotion path — the only candidate kind that
//      can actually tighten the measured spread — was never even asked.
//
// The third guard (tightensSpread) is what makes the ceiling structurally
// unreachable rather than merely sorted last: sorting alone still resolves to
// the first empty slot PAST the window, which is on the wrong side of the
// live best price.
const INCREMENT = 0.3;
const price = (idx: number): number => 670.368 * Math.pow(1 + INCREMENT / 100, idx);

/**
 * Builds the manager with the production geometry:
 * BUY 0-150, gap band 151-155, SELL 156-291; live BUY 131-150 and live SELL
 * 156-175 (20 each), every other slot empty/virtual.
 */
async function buildProductionGeometry(
    manager: any,
    liveBuy: [number, number],
    liveSell: [number, number],
    totals: { buy: number; sell: number } = { buy: 0, sell: 500 },
    options: { liveState?: string } = {}
) {
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    manager.config.weightDistribution = { buy: 0.5, sell: 0.5 };
    manager.btsBalance = { free: 1e9, total: 1e9, locked: 0 };

    const inRange = (i: number, r: [number, number]) => i >= r[0] && i <= r[1];
    for (let i = 0; i <= 291; i++) {
        const type = i <= 150
            ? ORDER_TYPES.BUY
            : (i >= 156 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        const live = inRange(i, liveBuy) || inRange(i, liveSell);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: price(i),
            type,
            state: live ? (options.liveState || ORDER_STATES.ACTIVE) : ORDER_STATES.VIRTUAL,
            size: live ? 2 : 1.5,
            orderId: live ? `1.7.${500000 + i}` : ''
        });
    }
    manager.boundaryIdx = 150;
    manager._gapSlots = 5;
    await manager.setAccountTotals({
        buy: totals.buy, sell: totals.sell,
        buyFree: totals.buy, sellFree: totals.sell
    });
    await manager.recalculateFunds();
}

function newManager(funds: { buy: number; sell: number } = { buy: 0, sell: 500 }) {
    return new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1052.06,
        botFunds: { buy: funds.buy, sell: funds.sell },
        coreOrders: { buy: 20, sell: 20 },
        incrementPercent: INCREMENT,
        targetSpreadPercent: 1.5
    });
}

const idxOf = (id: string): number => Number(String(id).replace('slot-', ''));

// --- 1. SELL: the grid ceiling must be unreachable -------------------------
// Live sells stop at 165, so slots 156-164 are empty sell slots that sit BELOW
// bestSell and genuinely tighten the spread. 9 of them are candidates: the
// correction must take one of those, and must never reach up to the ceiling
// (slot-291) even though ~125 empty sell slots lie above the live window.
async function testSellNeverTargetsTheCeiling() {
    console.log('Running test: SELL correction never targets the grid ceiling');

    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [165, 175]);

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    const bestSell = price(165);
    assert.strictEqual(placed.length, 1, `Expected one correction slot, got ${JSON.stringify(placed)}`);
    for (const id of placed) {
        assert(
            price(idxOf(id)) < bestSell,
            `${id} @ ${price(idxOf(id)).toFixed(1)} must sit BELOW the best live sell ${bestSell.toFixed(1)} ` +
            'to narrow the spread; anything at or above it leaves the spread unchanged'
        );
    }
    assert(
        !placed.includes('slot-291') && !placed.includes('slot-290'),
        `Correction must never create at the grid ceiling; got ${JSON.stringify(placed)}`
    );
    // Window-contiguous: with the empty sells BELOW the live window, correction
    // must bridge from the window downward (the HIGHEST empty price), not start
    // at the far bottom of the gap — the latter leaves an interior hole between
    // the new order and the live window and over-tightens past the target.
    assert.strictEqual(
        placed[0], 'slot-164',
        `SELL correction must pick the empty closest to the live window (slot-165); got ${placed[0]}`
    );
    console.log(`  ✓ SELL targets a spread-tightening slot, not the ceiling (${JSON.stringify(placed)})`);
}

// --- 2. BUY: mirror of the same rule ---------------------------------------
// Live buys stop at 145, so slots 146-150 are empty buy slots ABOVE bestBuy.
async function testBuyNeverTargetsTheRailFloor() {
    console.log('Running test: BUY correction never targets the rail floor');

    const manager = newManager({ buy: 20000, sell: 0 });
    // Funded well above the per-slot dust floor: the buy rail carries 151
    // slots, so a thin budget would size every candidate below the minimum
    // order size and the assertion below would pass for the wrong reason.
    await buildProductionGeometry(manager, [131, 145], [156, 175], { buy: 20000, sell: 0 });

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    const bestBuy = price(145);
    assert.strictEqual(placed.length, 1, `Expected one correction slot, got ${JSON.stringify(placed)}`);
    for (const id of placed) {
        assert(
            price(idxOf(id)) > bestBuy,
            `${id} @ ${price(idxOf(id)).toFixed(1)} must sit ABOVE the best live buy ${bestBuy.toFixed(1)} ` +
            'to narrow the spread; anything at or below it leaves the spread unchanged'
        );
    }
    assert(
        !placed.includes('slot-0') && !placed.includes('slot-1'),
        `Correction must never create at the rail floor; got ${JSON.stringify(placed)}`
    );
    console.log(`  ✓ BUY targets a spread-tightening slot, not the floor (${JSON.stringify(placed)})`);
}

// --- 3. Gap band leads the merge -------------------------------------------
// With room in the band, the gap (the only kind of candidate that can tighten
// the spread) must be asked FIRST, before the rail-wide orphan pool.
async function testGapBandOutranksRailPool() {
    console.log('Running test: gap-band promotion outranks the rail pool');

    const manager = newManager();
    // Live buys stop at 148 (not 150), leaving stranding headroom (depth 2) so the band
    // can actually be entered; live sells start at 156 as before.
    await buildProductionGeometry(manager, [131, 148], [156, 175]);

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    assert(
        placed.length === 1,
        `Expected exactly one correction slot, got ${JSON.stringify(placed)}`
    );
    // Walk floor for SELL promotion = buyEndIdx + 1 + MIN_SPREAD_ORDERS(2) = 153.
    assert.strictEqual(
        placed[0], 'slot-155',
        'Gap-band slot (the band slot nearest the sell window) must win over any rail slot; the band is the only place a correction tightens the spread'
    );
    assert.strictEqual(
        correction.boundaryIdx, 149,
        'Boundary must slide one step to admit the promoted band slot'
    );
    console.log('  ✓ gap slot chosen over the rail pool, boundary slid 150 -> 149');
}

// --- 4. Locked gap: no-op with an explicit reason ---------------------------
// Both live windows flush against the band => promotion depth 0 => the spread
// is not correctable. The path must place NOTHING rather than a useless order,
// and must say why (silence is indistinguishable from "nothing was wrong").
async function testLockedGapPlacesNothing() {
    console.log('Running test: locked gap places nothing and explains why');

    const logs: string[] = [];
    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [156, 175]);
    manager.logger = {
        log: (msg: string) => { logs.push(String(msg)); },
        logInfo: (msg: string) => { logs.push(String(msg)); }
    } as any;

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);

    assert.deepStrictEqual(
        correction.ordersToPlace, [],
        'With promotion depth 0 and no spread-tightening rail slot, the correction must place nothing'
    );
    const joined = logs.join('\n');
    assert(
        /no gap slot available on sell/.test(joined),
        `Expected an explicit "no gap slot" reason, got:\n${joined}`
    );
    assert(
        /stranding cap is 0/.test(joined),
        `The diagnostic must name the binding constraint (stranding cap); got:\n${joined}`
    );
    assert(
        /not correctable on this side this cycle/.test(joined),
        'The locked-gap log must state that the spread is not correctable'
    );
    console.log('  ✓ no placement, and the binding constraint is named');
}

// --- 5. Empty rail: guard must stay open ------------------------------------
// With no live order on the side there is no reference price to improve, so
// the market-nearest empty slot is by definition the best available and MUST
// still be creatable (a hard "must be below best" rule would strand the rail).
async function testEmptyRailStillPlaces() {
    console.log('Running test: empty rail still places market-nearest');

    const manager = newManager();
    // No live SELL anywhere on the rail: the whole sell side is empty.
    await buildProductionGeometry(manager, [131, 150], [292, 293]);
    await manager.setAccountTotals({ buy: 0, sell: 500, buyFree: 0, sellFree: 500 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    assert.strictEqual(
        placed.length, 1,
        `An empty rail must remain correctable; got ${JSON.stringify(placed)}`
    );
    assert.strictEqual(
        placed[0], 'slot-156',
        'With no live sell, the lowest empty sell slot is the best possible first order'
    );
    console.log('  ✓ empty rail places the market-nearest sell slot');
}

// --- 5. Every blocked-promotion reason is distinguishable -------------------
// Promotion can yield nothing for three operationally different reasons, and a
// config change fixes only one of them.  All three must be named, not collapsed
// into a bare "skipped".
async function testAllBlockedReasonsAreDistinguishable() {
    console.log('Running test: blocked-promotion reasons are distinguishable');

    const run = async (cfg: any) => {
        const logs: string[] = [];
        const manager = newManager({ buy: 0, sell: 20000 });
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        manager.config.weightDistribution = { buy: 0.5, sell: 0.5 };
        manager.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
        manager.logger = { log: (msg: string) => { logs.push(String(msg)); } } as any;
        for (let i = 0; i <= 60; i++) {
            const type = i <= 40
                ? ORDER_TYPES.BUY
                : (i >= 40 + cfg.gapSlots + 1 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
            const live = (i >= cfg.liveBuy[0] && i <= cfg.liveBuy[1])
                || (i >= cfg.liveSell[0] && i <= cfg.liveSell[1]);
            await manager._updateOrder({
                id: `slot-${i}`, price: price(i), type,
                state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: live ? 2 : 1.5,
                orderId: live ? `1.7.${500000 + i}` : ''
            });
        }
        // liveBuy stops at 38 (buyEndIdx is 40) so the stranding cap leaves
        // headroom; the intended constraint is the only thing that blocks.
        manager.boundaryIdx = 40;
        manager._gapSlots = cfg.gapSlots;
        await manager.setAccountTotals({ buy: 0, sell: 20000, buyFree: 0, sellFree: 20000 });
        await manager.recalculateFunds();
        const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
        return { placed: correction.ordersToPlace.map((o: any) => o.id), logs };
    };

    // bandSize (2) == MIN_SPREAD_ORDERS (2) -> reserve-blocked
    const reserved = await run({ gapSlots: 2, liveBuy: [36, 38], liveSell: [43, 50] });
    assert.deepStrictEqual(reserved.placed, [], 'Reserve-blocked band must place nothing');
    assert(
        /MIN_SPREAD_ORDERS reserve/.test(reserved.logs.join('\n')),
        'Reserve-blocked must be named as such (a config change is the fix)'
    );

    // bandSize (6) but the slot adjacent to the sell edge is placed -> walk breaks
    const noRun = await run({ gapSlots: 6, liveBuy: [36, 38], liveSell: [46, 50] });
    assert.deepStrictEqual(noRun.placed, [], 'Non-contiguous band must place nothing');
    assert(
        /no contiguous empty run/.test(noRun.logs.join('\n')),
        'Non-contiguous band must be named as such (a geometry change is the fix)'
    );
    console.log('  ✓ reserve-blocked and no-contiguous-run are both named');
}

// --- 6. Null-price orphan must not evict a valid candidate (F3) ------------
// A virtual, order-less rail slot with no price classifies as a rail orphan.
// JS coerces null to 0 in the fallback comparator, so it sorted FIRST on the
// SELL rail, consumed the slice(0, missingSlots) seat, and was then dropped by
// the duplicate-price filter — leaving the cycle with nothing to place while a
// valid window-nearest slot existed one position away.
async function testNullPriceOrphanDoesNotEvictCandidate() {
    console.log('Running test: null-price orphan cannot evict a valid candidate');

    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [165, 175]);
    (manager.orders as Map<string, any>).set('slot-null', {
        id: 'slot-null',
        price: null,
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        size: 0,
        orderId: ''
    });

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    assert.deepStrictEqual(
        placed, ['slot-164'],
        `A price-less orphan must be ignored so the window-nearest valid sell wins; got ${JSON.stringify(placed)}`
    );
    console.log('  ✓ null-price orphan ignored; window-nearest candidate preserved');
}

// --- 7. Structural stall is reported as 'no-candidates' (F1) ----------------
// The locked gap cannot be repaired by placing an order. checkSpreadCondition
// must say so with the structural cause, NOT a fund cause, so the maintenance
// loop does not reload account totals/open orders every cooldown for a grid the
// refresh cannot change (the staleness watchdog owns re-centering instead).
async function testLockedGapReportsNoCandidatesStall() {
    console.log('Running test: locked gap reports a structural no-candidates stall');

    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [156, 175]);

    const result = await manager.checkSpreadCondition({}, async () => ({ executed: true }));

    assert.strictEqual(result.ordersPlaced, 0, 'locked gap must place nothing');
    assert.strictEqual(
        result.stall, 'no-candidates',
        `A structural stall must be reported as 'no-candidates', got ${JSON.stringify(result.stall)}`
    );
    console.log('  ✓ structural stall carries the no-candidates cause');
}

// --- 8. Mixed-case stall must be classified as funds, not structural (regression) ---
// The reported regression: the chosen side (BUY) has a spread-tightening hole but
// only dust free (planned > 0, placed 0), while the opposite side (SELL) has a
// non-zero budget but is locked (planned 0). The starvation fallback overwrote
// plannedCount with the opposite side's 0, so checkSpreadCondition reported
// 'no-candidates' and the maintenance refresh never armed — dropping exactly the
// stale-balance case the refresh exists for.
async function testMixedCaseStallIsUnfunded() {
    console.log('Running test: mixed-case stall is reported as unfunded');

    // Derive the buy-side committed (virtual) rail size from a probe so the dust
    // budget is self-documenting rather than a magic constant: free = a tiny
    // fraction of committed — enough for the BUY side to be selected, too little
    // to fund any create.
    const probe = newManager({ buy: 100000, sell: 0 });
    await buildProductionGeometry(probe, [131, 145], [156, 175], { buy: 100000, sell: 0 });
    const virtualBuy = Number(probe.funds?.virtual?.buy || 0);
    const dustBuy = virtualBuy + virtualBuy * 0.0002;

    // SELL gets a non-zero allocation (>0 sizing budget) so its empty result is a
    // structural 'no-candidates', not a zero-budget fund hint — otherwise the two
    // fixes would overlap and the test would not pin the overwrite bug.
    const sellAlloc = 0.001;

    const manager = newManager({ buy: dustBuy, sell: sellAlloc });
    // PARTIAL live orders keep the sell rail on-chain but are deliberately not
    // rotation sources (a partial must never be moved by a spread correction),
    // so this scenario still exercises the mixed fund/structural stall.
    await buildProductionGeometry(manager, [131, 145], [156, 175],
        { buy: dustBuy, sell: sellAlloc }, { liveState: ORDER_STATES.PARTIAL });

    assert.strictEqual(manager.orders.get('slot-175').state, ORDER_STATES.PARTIAL,
        'precondition: live sells are PARTIAL and cannot be rotation sources');
    // Precondition: side selection picks BUY, which plans a hole but funds none;
    // the locked SELL side plans nothing.
    assert.strictEqual(
        Grid.determineOrderSideByFunds(manager, price(150)).side, ORDER_TYPES.BUY,
        'precondition: the dust-free BUY side must be selected'
    );
    const buyCorrection = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 6);
    assert(
        Number(buyCorrection.plannedCount || 0) > 0 && buyCorrection.ordersToPlace.length === 0,
        `precondition: BUY must plan (${buyCorrection.plannedCount}) yet place 0`
    );
    const sellCorrection = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 6);
    // A zero-budget side with tightening candidates now reports plannedCount>0
    // (an UNFUNDED plan) instead of the old early-return plannedCount=0. What
    // matters for this regression is that it cannot execute anything: no create
    // and no rotation source (live sells are PARTIAL).
    assert.strictEqual(sellCorrection.ordersToPlace.length, 0,
        'precondition: the locked SELL side places nothing');
    assert.strictEqual((sellCorrection.ordersToRotate || []).length, 0,
        'precondition: PARTIAL sells are not rotation sources');

    const result = await manager.checkSpreadCondition({}, async () => ({ executed: true }));
    assert.strictEqual(result.ordersPlaced, 0, 'no order can be placed');
    assert.strictEqual(
        result.stall, 'unfunded',
        `A planned-but-unfunded side must not be masked by an empty opposite side; got ${JSON.stringify(result.stall)}`
    );
    console.log('  ✓ unfunded plan survives an empty opposite side (reports unfunded, not no-candidates)');
}

// --- 9. Each stall cause is reachable (coverage) ---------------------------
// The classification is only useful if each branch is exercised end to end.

async function testNoFreeFundsStall() {
    console.log('Running test: zero free funds reports no-free-funds');
    const manager = newManager({ buy: 0, sell: 0 });
    await buildProductionGeometry(manager, [131, 150], [156, 175], { buy: 0, sell: 0 });
    const result = await manager.checkSpreadCondition({}, async () => ({ executed: true }));
    assert.strictEqual(result.ordersPlaced, 0, 'no funds -> nothing placed');
    assert.strictEqual(result.stall, 'no-free-funds',
        `zero funds must report no-free-funds, got ${JSON.stringify(result.stall)}`);
    console.log('  ✓ no-free-funds reported when neither side has funds');
}

async function testBatchNotExecutedStall() {
    console.log('Running test: unexecuted batch reports batch-not-executed');
    // Live sells 165-175 leave a funded hole (156-164) the correction can fill.
    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [165, 175]);
    const result = await manager.checkSpreadCondition({}, async () => ({ executed: false }));
    assert.strictEqual(result.ordersPlaced, 0, 'an unexecuted batch places nothing');
    assert.strictEqual(result.stall, 'batch-not-executed',
        `a prepared-but-unexecuted batch must report batch-not-executed, got ${JSON.stringify(result.stall)}`);
    console.log('  ✓ batch-not-executed reported when the COW batch did not run');
}

async function testApplyErrorStall() {
    console.log('Running test: broadcast throw reports apply-error');
    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [165, 175]);
    const result = await manager.checkSpreadCondition({}, async () => { throw new Error('boom'); });
    assert.strictEqual(result.ordersPlaced, 0, 'a broadcast throw places nothing');
    assert.strictEqual(result.stall, 'apply-error',
        `a throwing batch must report apply-error, got ${JSON.stringify(result.stall)}`);
    console.log('  ✓ apply-error reported when the broadcast throws');
}

// --- 10. Stale ACTIVE order hides the tightening slot, then a sync heals it --
// A missed fill leaves the window-floor slot locally ACTIVE although its chain
// order is gone. `_getOnChainOrders` reads LOCAL state, so the phantom becomes
// bestLiveOnRail and every real empty sell sits on the non-tightening side;
// prepareSpreadCorrectionOrders reports 'no-candidates' even though geometry
// exists. This is the regression the targeted refresh must cover: the stall is
// stale local state, not structure, and only a chain sync can tell them apart.
// The test pins both halves: the phantom produces the stall, and virtualizing
// it (exactly what synchronizeWithChain does for an order absent from the
// open-orders window) restores the correction.
async function testStaleActiveOrderYieldsNoCandidatesThenRecovers() {
    console.log('Running test: stale ACTIVE order reports no-candidates, then a sync heals it');

    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [165, 175]);
    // Phantom: locally ACTIVE at the sell-window floor with no matching chain
    // order. `price(156)` is below every live sell (165-175), so it pins
    // bestLiveOnRail below every remaining empty sell slot.
    await manager._updateOrder({
        id: 'slot-156',
        price: price(156),
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 2,
        orderId: '1.7.phantom'
    });

    const staleResult = await manager.checkSpreadCondition({}, async () => ({ executed: true }));
    assert.strictEqual(staleResult.ordersPlaced, 0, 'a phantom anchor leaves nothing placeable');
    assert.strictEqual(
        staleResult.stall, 'no-candidates',
        `a stale ACTIVE slot must surface as a no-candidates stall, got ${JSON.stringify(staleResult.stall)}`
    );

    // Apply what the armed targeted chain sync does: the phantom is absent from
    // the open-orders window, so synchronizeWithChain virtualizes the slot.
    await manager._updateOrder({
        id: 'slot-156',
        price: price(156),
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        size: 1.5,
        orderId: ''
    });

    const healedResult = await manager.checkSpreadCondition({}, async () => ({ executed: true }));
    assert(
        healedResult.ordersPlaced >= 1,
        `after the stale order is virtualized the correction must place, got ${JSON.stringify(healedResult)}`
    );
    console.log('  ✓ stale ACTIVE order stalls as no-candidates and the chain sync heals it');
}

(async () => {
    await testSellNeverTargetsTheCeiling();
    await testBuyNeverTargetsTheRailFloor();
    await testGapBandOutranksRailPool();
    await testLockedGapPlacesNothing();
    await testAllBlockedReasonsAreDistinguishable();
    await testEmptyRailStillPlaces();
    await testNullPriceOrphanDoesNotEvictCandidate();
    await testLockedGapReportsNoCandidatesStall();
    await testMixedCaseStallIsUnfunded();
    await testNoFreeFundsStall();
    await testBatchNotExecutedStall();
    await testApplyErrorStall();
    await testStaleActiveOrderYieldsNoCandidatesThenRecovers();
    console.log('PASS test_spread_correction_market_nearest');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

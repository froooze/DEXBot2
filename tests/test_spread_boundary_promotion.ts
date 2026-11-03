const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const cowRuntime = require('../modules/dexbot_cow_runtime');

async function testSpreadBoundaryPromotion() {
    console.log('Running test: Spread Boundary Promotion');

    // Layout: BUY 0-3, gap 4-7 (gapSlots=4), SELL zone empty.
    // MIN_SPREAD_ORDERS=2 reserves 2 of the 4 band slots, so a quota of 2
    // promotes exactly slot-4 and slot-5. After promotion boundary 3→5,
    // After promotion boundary 3→5, sellStartIdx 8→10 (empty SELL zone).
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isBuy = i <= 3;
        const type = isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SPREAD;
        const state = isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isBuy ? 10 : 0;
        const orderId = isBuy ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 3;
    manager._gapSlots = 4;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 2);

    assert.strictEqual(correction.ordersToPlace.length, 2, 'Should place both promoted buy slots');
    assert.deepStrictEqual(
        correction.ordersToPlace.map(order => order.id).sort(),
        ['slot-4', 'slot-5'],
        'Should promote the contiguous gap slots above the buy edge'
    );
    assert.strictEqual(correction.boundaryIdx, 5, 'Boundary should move across the placed gap slots');

    const cowResult = cowRuntime.buildCowResultFromPlan(
        { manager: { orders: manager.orders, _gridVersion: 0, boundaryIdx: 3 } },
        correction
    );
    assert.strictEqual(cowResult.workingBoundary, 5, 'COW plan should carry the promoted boundary');
    assert.strictEqual(cowResult.workingGrid.get('slot-4').type, ORDER_TYPES.BUY, 'Promoted slot should be typed BUY in the working grid');

    console.log('  PASS: funded BUY correction promotes the boundary and fills the gap edge');
}

async function testPromotionReservesMinSpread() {
    console.log('Running test: Promotion never consumes the MIN_SPREAD_ORDERS floor');

    // Layout: BUY 0-3, gap 4-5 (gapSlots=2 == MIN_SPREAD_ORDERS). The whole
    // band is reserved — promoting either slot would zero the spread, so
    // promotion must be disabled entirely and no boundary returned.
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isBuy = i <= 3;
        const type = isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SPREAD;
        const state = isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isBuy ? 10 : 0;
        const orderId = isBuy ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 3;
    manager._gapSlots = 2;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 2);

    assert.strictEqual(correction.ordersToPlace.length, 0,
        'Must not promote when band size == MIN_SPREAD_ORDERS (spread would zero)');
    assert.strictEqual(correction.boundaryIdx, undefined,
        'No boundary move may be returned when promotion is refused');

    console.log('  PASS: minimum-width gap blocks boundary promotion entirely');
}

async function testStrandingDepthCaps() {
    console.log('Running test: stranding depth caps keep promoted slots consistent');

    // --- BUY: a placed SELL close above the band caps promotion depth ---
    // Layout (10 slots): BUY 0-1 ACTIVE, gap 2-5 (gapSlots=4), slot-6 empty,
    // slot-7 ACTIVE SELL.  Promoting both slot-2 AND slot-3 would move the
    // implied sell zone start to 3+4+1=8 — past the placed sell at 7,
    // stranding it inside the new band.  Depth cap = 7-4-1-1 = 1 → only
    // slot-2 may promote; boundary 1→2 keeps the sell zone at 2+4+1=7.
    {
        const manager = new OrderManager({
            assetA: 'BASE',
            assetB: 'QUOTE',
            startPrice: 1,
            botFunds: { buy: 1000, sell: 1000 },
            coreOrders: { buy: 4, sell: 0 },
            incrementPercent: 1,
            targetSpreadPercent: 1
        });
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        for (let i = 0; i < 10; i++) {
            const isBuy = i <= 1;
            const isPlacedSell = i === 7;
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 1 + i * 0.01,
                type: isBuy ? ORDER_TYPES.BUY : isPlacedSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD,
                state: (isBuy || isPlacedSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: (isBuy || isPlacedSell) ? 10 : 0,
                orderId: (isBuy || isPlacedSell) ? `1.7.${200 + i}` : ''
            });
        }
        manager.boundaryIdx = 1;
        manager._gapSlots = 4;
        await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
        await manager.recalculateFunds();

        const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 2);
        assert.deepStrictEqual(
            correction.ordersToPlace.map((o: any) => o.id),
            ['slot-2'],
            'Stranding cap must limit BUY promotion depth to 1 slot'
        );
        assert.strictEqual(correction.boundaryIdx, 2,
            'Boundary must move exactly to the capped promotion edge (implied sell zone stays at/below the placed sell)');
    }

    // --- SELL: a placed BUY near the rail edge caps promotion depth ---
    // Layout (8 slots): BUY 0-2 ACTIVE (highest placed at idx 2), slot-3
    // empty in-rail, gap 4-6 (gapSlots=3, boundary=3, sellStartIdx=7),
    // slot-7 ACTIVE SELL.  Walk floor for SELL = buyEnd+1+reserve = 6;
    // depth cap = 3−2 = 1 → exactly slot-6 promotes; boundary 3→2 puts the
    // new sell zone at 2+3+1=6, so slot-6 lands at its edge and no placed
    // buy is stranded.
    {
        const manager = new OrderManager({
            assetA: 'BASE',
            assetB: 'QUOTE',
            startPrice: 1,
            botFunds: { buy: 1000, sell: 1000 },
            coreOrders: { buy: 4, sell: 4 },
            incrementPercent: 1,
            targetSpreadPercent: 1
        });
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        for (let i = 0; i < 8; i++) {
            const isBuy = i <= 2;
            const isSell = i >= 7;
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 1 + i * 0.01,
                type: isBuy ? ORDER_TYPES.BUY : isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD,
                state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: (isBuy || isSell) ? 10 : 0,
                orderId: (isBuy || isSell) ? `1.7.${300 + i}` : ''
            });
        }
        manager.boundaryIdx = 3;
        manager._gapSlots = 3;
        await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
        await manager.recalculateFunds();

        const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
        assert.deepStrictEqual(
            correction.ordersToPlace.map((o: any) => o.id),
            ['slot-6'],
            'Stranding cap must limit SELL promotion to the single slot at the walk floor'
        );
        assert.strictEqual(correction.boundaryIdx, 2,
            'Boundary must drop exactly one step (to the highest placed buy), keeping slot-6 at the sell zone edge');
    }

    console.log('  PASS: stranding depth caps prevent boundary slides over live orders');
}

async function testSellSideBoundaryPromotion() {
    console.log('Running test: SELL-side Spread Boundary Promotion');

    // Layout: BUY 0-1 (VIRTUAL), gap 2-4 (gapSlots=3), SELL 5-7.
    // MIN_SPREAD_ORDERS=2 reserves 2 of the 3 band slots, and the boundary
    // can drop at most buyEndIdx=1 step below its rail edge, so exactly one
    // gap slot (slot-4, closest to the SELL edge) is promoted.
    // Boundary 1→0, sellStartIdx 5→4. slot-4 lands at sellStartIdx, in-rail.
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 0, sell: 3 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isSell = i >= 5;
        const type = isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD;
        const state = isSell ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isSell ? 10 : 0;
        const orderId = isSell ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 1;
    manager._gapSlots = 3;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 2);

    assert.strictEqual(correction.ordersToPlace.length, 1, 'Reserve cap allows only 1 promoted slot');
    assert.deepStrictEqual(
        correction.ordersToPlace.map(order => order.id).sort(),
        ['slot-4'],
        'Only the gap slot closest to the SELL edge is promoted'
    );
    assert.strictEqual(correction.boundaryIdx, 0, 'Boundary moves left by 1 (from 1 to 0)');

    const cowResult = cowRuntime.buildCowResultFromPlan(
        { manager: { orders: manager.orders, _gridVersion: 0, boundaryIdx: 1 } },
        correction
    );
    assert.strictEqual(cowResult.workingBoundary, 0, 'COW plan should carry the boundary');
    assert.strictEqual(cowResult.workingGrid.get('slot-4').type, ORDER_TYPES.SELL, 'Promoted slot should be typed SELL in the working grid');

    console.log('  PASS: funded SELL correction respects reserve cap and places 1 slot');
}

async function testPartialPlacementBoundaryPromotion() {
    console.log('Running test: Partial Placement Boundary Promotion');

    // Layout: BUY slots 0-1, gap 2-5, SELL slots 6-7 (VIRTUAL).
    // After BUY promotion by 2 (budget-limited), boundary 1→3, sellStartIdx 6→8.
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 100, sell: 1000 },
        coreOrders: { buy: 2, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    // 8 slots: BUY 0-1, gap 2-5, SELL 6-7 (VIRTUAL — empty opposite edge)
    for (let i = 0; i < 8; i++) {
        const isBuy = i <= 1;
        const isGap = i >= 2 && i <= 5;
        const type = isBuy ? ORDER_TYPES.BUY : isGap ? ORDER_TYPES.SPREAD : ORDER_TYPES.SPREAD;
        const state = isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isBuy ? 10 : 0;
        const orderId = isBuy ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 1;
    manager._gapSlots = 4;

    // botFunds=100 → allocatedBuy=100.  buyFree=40 → available ≈ 20 after
    // committed chain deduction (2 BUY orders × 10 = 20 committed).
    // Each promoted slot at ~10 → fits ~2 but not all 4 gap slots.
    await manager.setAccountTotals({ buy: 100, sell: 1000, buyFree: 40, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 4);

    const placedCount = correction.ordersToPlace.length;
    assert.ok(placedCount >= 1 && placedCount < 4,
        `Should place 1-3 promoted slots (budget-limited), got ${placedCount}`);

    // Boundary must equal original (1) + number of contiguous placed promoted
    // slots — not the full promotion count of 4.
    if (correction.boundaryIdx !== undefined) {
        const moved = correction.boundaryIdx - 1;
        assert.strictEqual(moved, placedCount,
            `Boundary moved ${moved} should equal placed count ${placedCount}`);
        assert.ok(moved < 4,
            `Boundary should not advance past the full 4-slot gap (moved ${moved})`);
    } else {
        assert.fail('boundaryIdx should be set when promoted slots were placed');
    }

    console.log(`  PASS: partial placement boundary moves by placed count (${placedCount} of 4)`);
}

async function testNullBoundaryBlocksPromotion() {
    console.log('Running test: NULL-boundary blocks boundary promotion');

    // Fresh grid: all slots empty SPREAD VIRTUAL, no boundary restored yet
    // (manager.boundaryIdx = null).  The spread-correction fallback fabricates
    // boundary 0 for classification, but boundary PROMOTION must not run off
    // that fiction: pre-fix this layout promoted gap slots 1-2 and returned
    // boundaryIdx=2 (committed via COW from a boundary that was never real).
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 4, sell: 4 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: ''
        });
    }
    manager.boundaryIdx = null;
    manager._gapSlots = 2;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 5);

    assert.strictEqual(correction.boundaryIdx, undefined,
        'Must not return a boundary derived from the null fallback');
    const placedIds = correction.ordersToPlace?.map((o: any) => o.id) || [];
    assert.ok(placedIds.every((id: string) => id === 'slot-0'),
        `Must not promote gap slots off a fabricated boundary (placed=${placedIds.join(',')})`);

    console.log('  PASS: unknown boundary disables boundary promotion entirely');
}

async function testNoDuplicateInRailSlot() {
    console.log('Running test: empty in-rail slot not planned twice');

    // Layout: BUY 0-1 ACTIVE, slot-2 = empty in-rail SPREAD (correctType BUY
    // under boundary 2), gap 3-4, SELL 5-7 VIRTUAL.  slot-2 qualifies for BOTH
    // orphanedVirtualCandidates and typedSpreadCandidates (both accept SPREAD
    // type + rail geometry), so pre-fix it was planned twice — inflating the
    // sizing denominator and misreporting the plan count.
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isBuy = i <= 1;
        const type = isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SPREAD;
        const state = isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isBuy ? 10 : 0;
        const orderId = isBuy ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 2;
    manager._gapSlots = 2;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 2);

    const placedIds = correction.ordersToPlace?.map((o: any) => o.id) || [];
    assert.strictEqual(new Set(placedIds).size, placedIds.length,
        `Each slot id must be planned at most once (placed=${placedIds.join(',')})`);
    assert.strictEqual(
        placedIds.filter((id: string) => id === 'slot-2').length, 1,
        'slot-2 should be planned exactly once'
    );

    console.log('  PASS: overlapping candidate filters no longer duplicate a slot');
}

async function testPromotionAbsorbsPlacedInBandEdge() {
    console.log('Running test: Promotion absorbs a placed same-side in-band edge');

    // Post-crawl shape: boundary 3, gap 4 => sellStart 8, band 4-7. A SELL at
    // 7 is already inside the band (it becomes a legal rail member once the
    // boundary slides past it) and 6 is empty. Absorbing 7 must NOT plan a
    // CREATE over the live order: the walk steps over it, promotes 6, and the
    // boundary derives from the placed slot (3 - (8-6) = 1).
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    for (let i = 0; i < 12; i++) {
        const isBuy = i === 0;
        const isSell = i >= 7;
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: isBuy ? ORDER_TYPES.BUY : isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD,
            state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: (isBuy || isSell) ? 10 : 0,
            orderId: (isBuy || isSell) ? `1.7.${400 + i}` : ''
        });
    }
    manager.boundaryIdx = 3;
    manager._gapSlots = 4;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    assert.deepStrictEqual(
        correction.ordersToPlace.map((o: any) => o.id),
        ['slot-6'],
        'the placed in-band edge is absorbed, only the empty slot is promoted'
    );
    assert.strictEqual(
        correction.ordersToPlace.some((o: any) => o.id === 'slot-7'),
        false,
        'the absorbed live order must never be re-planned as a CREATE'
    );
    assert.strictEqual(correction.boundaryIdx, 1, 'boundary derives from the placed slot (3 -> 1)');

    const cowResult = cowRuntime.buildCowResultFromPlan(
        { manager: { orders: manager.orders, _gridVersion: 0, boundaryIdx: 3 } },
        correction
    );
    assert.strictEqual(cowResult.workingBoundary, 1, 'COW plan carries the absorbed-slide boundary');
    assert.strictEqual(cowResult.workingGrid.get('slot-7').type, ORDER_TYPES.SELL,
        'the absorbed slot stays on the rail, not re-typed');

    console.log('  PASS: in-band same-side edge absorbed without a duplicate CREATE');
}

async function testBuyPromotionAbsorbsPlacedInBandEdge() {
    console.log('Running test: BUY promotion absorbs a placed same-side in-band edge');

    // Mirror of the SELL case: boundary 3, gap 4 => band 4-7. A BUY at 4 is
    // already inside the band; the slide absorbs it, promotes the next empty
    // slot (5), and the boundary moves up to 5 (sellStart 10, ahead of the
    // placed sells at 10-11).
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    for (let i = 0; i < 12; i++) {
        const isBuy = i <= 3 || i === 4;
        const isSell = i >= 10;
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: isBuy ? ORDER_TYPES.BUY : isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD,
            state: (isBuy || isSell) ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: (isBuy || isSell) ? 10 : 0,
            orderId: (isBuy || isSell) ? `1.7.${500 + i}` : ''
        });
    }
    manager.boundaryIdx = 3;
    manager._gapSlots = 4;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 1);
    assert.deepStrictEqual(
        correction.ordersToPlace.map((o: any) => o.id),
        ['slot-5'],
        'the placed in-band BUY is absorbed, only the empty slot is promoted'
    );
    assert.strictEqual(correction.boundaryIdx, 5, 'boundary moves up past the absorbed and promoted slots');
    console.log('  PASS: BUY in-band same-side edge absorbed without a duplicate CREATE');
}

async function runAll() {
    await testSpreadBoundaryPromotion();
    await testPromotionReservesMinSpread();
    await testStrandingDepthCaps();
    await testSellSideBoundaryPromotion();
    await testPartialPlacementBoundaryPromotion();
    await testNullBoundaryBlocksPromotion();
    await testNoDuplicateInRailSlot();
    await testPromotionAbsorbsPlacedInBandEdge();
    await testBuyPromotionAbsorbsPlacedInBandEdge();
    console.log('✓ All spread boundary promotion tests passed');
}

runAll().catch(error => {
    console.error('Test FAILED:', error);
    process.exit(1);
});

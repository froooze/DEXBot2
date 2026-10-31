/**
 * EDGE-FILL PIVOT: edge-pinned insurance fills never arm the LAST-FILL-GUARD
 * pivot (and therefore never drive reanchorBoundaryFromLastFill).
 *
 * Incident class (review finding): the boundary crawl deliberately excludes
 * edge fills ("static insurance, not market movement", deriveTargetBoundary),
 * but the pivot was armed on EVERY fill and the re-anchor is an ABSOLUTE
 * geometry move off that pivot. One wick that triggered a floor insurance BUY
 * therefore teleported the window to the grid floor (observed: boundary 29 -> 0
 * on a 60-slot ladder), and the mirror edge SELL moved it to the ceiling. The
 * eligibility rule now lives at the single pivot writer:
 *
 *   EDGE fill  => not market movement: no pivot, no anchor, no crawl.
 *   PARTIAL    => anchors (a real trade; residual allow-listed by the re-anchor).
 *
 * Classification is the SAME one the placement pickers use
 * (collectEdgePinnedFillIds -> liveWindowIdSet + edgeOrderIdSet), so "edge"
 * cannot mean two different things.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { collectEdgePinnedFillIds } = require('../modules/order/utils/order');
const { reanchorBoundaryFromLastFill, resolveLastFillGuardReference } = require('../modules/order/utils/system');
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

/**
 * 12-slot grid: boundary 3, gap 1 (slot 4 is the band), coreOrders {2,2},
 * edgeOrders {1,1}. Window buys = 2,3; floor edge buy = 0; window sells = 5,6;
 * ceiling edge sell = 11.
 */
async function buildManager(opts: { edgeOrders?: Record<string, number> | null } = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    const config: Record<string, unknown> = {
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    };
    if (opts.edgeOrders !== null) config.edgeOrders = opts.edgeOrders ?? { buy: 1, sell: 1 };
    const manager = new OrderManager(config as never);
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    } as never;
    manager.btsBalance = { free: 1000, total: 1000, locked: 0 } as never;
    manager.logger = { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) } as never;

    for (let i = 0; i < 12; i++) {
        const type = i <= 3 ? ORDER_TYPES.BUY : (i === 4 ? ORDER_TYPES.SPREAD : ORDER_TYPES.SELL);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i / 100,
            type,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            orderId: `1.7.${900 + i}`
        } as never);
    }
    manager.boundaryIdx = 3;
    manager._gapSlots = 1;
    manager._lastSyncAt = Date.now();
    return { manager, logs };
}

function arm(manager: any, price: number, type: string) {
    manager._lastFilledPrice = price;
    manager._lastFilledType = type;
    manager.lastFillPivotSource = type ? 'fill' : null;
    manager._lastFilledAt = Date.now();
    manager._lastMarketFillPrice = price;
    manager._lastMarketFillType = type;
    manager._lastMarketFillAt = Date.now();
}

async function main() {
    const { manager, logs } = await buildManager();
    const { manager: plain } = await buildManager({ edgeOrders: null });

    run('EDGE-1 an edge fill alone does not arm the pivot', () => {
        manager._lastFilledPrice = null;
        manager._lastFilledType = null;
        logs.length = 0;
        manager.recordLastFilledPrices([{ id: 'slot-11', type: ORDER_TYPES.SELL, price: 1.11 }]);
        assert.strictEqual(manager._lastFilledPrice, null, 'a ceiling insurance sell must not become the pivot');
        assert.strictEqual(manager._lastFilledType, null);
        assert.ok(logs.some((l) => /edge-pinned fill/.test(l.msg)),
            `the skip must be logged (got: ${logs.map((l) => l.msg).join(' | ')})`);
    });

    run('EDGE-2 an edge fill after a window fill does not overwrite the pivot', () => {
        manager._lastFilledPrice = null;
        manager._lastFilledType = null;
        manager.recordLastFilledPrices([
            { id: 'slot-5', type: ORDER_TYPES.SELL, price: 1.05 },
            { id: 'slot-11', type: ORDER_TYPES.SELL, price: 1.11 }
        ]);
        assert.strictEqual(manager._lastFilledPrice, 1.05, 'the window trade must stay the pivot');
        assert.strictEqual(manager._lastFilledType, ORDER_TYPES.SELL);
        assert.strictEqual(manager._lastMarketFillPrice, 1.05, 'the persisted market reference must follow the pivot');
    });

    run('EDGE-3 a window fill after an edge fill arms the pivot normally', () => {
        manager._lastFilledPrice = null;
        manager._lastFilledType = null;
        manager.recordLastFilledPrices([
            { id: 'slot-11', type: ORDER_TYPES.SELL, price: 1.11 },
            { id: 'slot-6', type: ORDER_TYPES.SELL, price: 1.06 }
        ]);
        assert.strictEqual(manager._lastFilledPrice, 1.06);
    });

    run('EDGE-4 the floor edge BUY is classified too (mirror side)', () => {
        manager._lastFilledPrice = null;
        manager._lastFilledType = null;
        manager.recordLastFilledPrices([{ id: 'slot-0', type: ORDER_TYPES.BUY, price: 1.0 }]);
        assert.strictEqual(manager._lastFilledPrice, null, 'a floor insurance buy must not become the pivot');
        // And a window buy does arm it.
        manager.recordLastFilledPrices([{ id: 'slot-3', type: ORDER_TYPES.BUY, price: 1.03 }]);
        assert.strictEqual(manager._lastFilledPrice, 1.03);
    });

    run('EDGE-5 collectEdgePinnedFillIds is the single classifier (window/opposite side excluded)', () => {
        const ids = collectEdgePinnedFillIds(manager as never, [
            { id: 'slot-11', type: ORDER_TYPES.SELL },
            { id: 'slot-0', type: ORDER_TYPES.BUY },
            { id: 'slot-5', type: ORDER_TYPES.SELL },
            { id: 'slot-3', type: ORDER_TYPES.BUY }
        ] as never);
        assert.deepStrictEqual([...ids].sort(), ['slot-0', 'slot-11'],
            `only edge-pinned fills may be classified (got ${[...ids].join(',')})`);
    });

    run('EDGE-6 the re-anchor stays put after an edge-only batch (no teleport)', () => {
        // The incident replay: boundary 3, an edge SELL at slot 11 fills. Before
        // the fix the pivot became 1.11 and the re-anchor moved the boundary to
        // the grid ceiling. Now the pivot stays on the window trade.
        arm(manager, 1.05, ORDER_TYPES.SELL);
        manager.recordLastFilledPrices([{ id: 'slot-11', type: ORDER_TYPES.SELL, price: 1.11 }]);
        const ref = resolveLastFillGuardReference(manager as never);
        assert.strictEqual(ref.price, 1.05, 'the reference must stay on the last window trade');
        const slots = Array.from((manager.orders as Map<string, unknown>).values());
        const r = reanchorBoundaryFromLastFill(manager as never, 3, slots as never, 1, [
            { id: 'slot-11', type: ORDER_TYPES.SELL, price: 1.11 }
        ]);
        assert.strictEqual(r.reanchored, false, `the window must not move on an edge fill: ${JSON.stringify(r)}`);
        assert.strictEqual(r.boundaryIdx, 3);
    });

    run('EDGE-7 with edgeOrders disabled the same fill DOES arm the pivot', () => {
        // Classification is config-driven: an operator without insurance orders
        // has no edge slots, so nothing is skipped.
        plain._lastFilledPrice = null;
        plain._lastFilledType = null;
        plain.recordLastFilledPrices([{ id: 'slot-11', type: ORDER_TYPES.SELL, price: 1.11 }]);
        assert.strictEqual(plain._lastFilledPrice, 1.11, 'no edge config => no skip');
    });

    console.log(`\nEDGE-FILL summary: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('edge-fill pivot test failed:', err);
    process.exit(1);
});

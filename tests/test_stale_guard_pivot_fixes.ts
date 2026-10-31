/**
 * Regression tests for the stale-guard-pivot incident fixes:
 *  1. refreshLastFillPivotFromQueue — broadcast-time pivot re-validation from
 *     still-queued fills (peek-only, never drains).
 *  2. Per-action spread-correction bypass scoping — rotations never bypass,
 *     even inside a correction plan.
 *  3. determineOrderSideByFunds — non-finite market price returns null (skip)
 *     instead of comparing raw cross-asset units.
 */
const assert = require('assert');
const {
    isLastFillGuardBlocked,
    refreshLastFillPivotFromQueue,
    buildActionsFromPlan,
} = require('../modules/dexbot_cow_runtime');
const { determineOrderSideByFunds } = require('../modules/order/grid');
const { ORDER_TYPES } = require('../modules/constants');

const INC = 0.5;

function makeBot(queue: any[], slots: any[] = []) {
    const orders = new Map();
    for (const s of slots) orders.set(s.id, s);
    return {
        _incomingFillQueue: queue,
        manager: {
            orders,
            assets: {
                assetA: { id: '1.3.0', precision: 5, symbol: 'XRP' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' },
            },
            config: { incrementPercent: INC },
            _lastFilledPrice: 954.11,
            _lastFilledType: ORDER_TYPES.BUY,
            _lastFilledBuyPrice: 954.11,
            _lastFilledSellPrice: null,
            logger: { log: () => {} },
        },
    } as any;
}

async function testRefreshFromQueuedSlotFill() {
    console.log('\n[SGP-1] queued fill via slot lookup refreshes the pivot without draining');
    const bot = makeBot(
        [{ op: [4, { order_id: '1.7.100' }], block_num: 123 }],
        [{ id: 'slot-1', orderId: '1.7.100', type: ORDER_TYPES.BUY, price: 971.47 }]
    );
    assert.strictEqual(refreshLastFillPivotFromQueue(bot), true);
    assert.strictEqual(bot.manager._lastFilledPrice, 971.47);
    assert.strictEqual(bot.manager._lastFilledType, ORDER_TYPES.BUY);
    assert.strictEqual(bot.manager._lastFilledBuyPrice, 971.47);
    assert.strictEqual(bot._incomingFillQueue.length, 1, 'queue must NOT be drained');
    // With the stale pivot (954.11) a 965.65 sell passed; with the refreshed
    // pivot (971.47) it is blocked — the reported incident shape.
    const stale = isLastFillGuardBlocked(965.65, ORDER_TYPES.SELL, 954.11, ORDER_TYPES.BUY);
    const fresh = isLastFillGuardBlocked(965.65, ORDER_TYPES.SELL, bot.manager._lastFilledPrice, bot.manager._lastFilledType);
    assert.strictEqual(stale.blocked, false, 'stale pivot lets the violating sell through');
    assert.strictEqual(fresh.blocked, true, 'refreshed pivot blocks it');
    console.log('✓ SGP-1 passed');
}

async function testRefreshFromFillEconomics() {
    console.log('\n[SGP-2] queued fill via pays/receives economics refreshes the pivot');
    // SELL: pays 1.0 assetA (100000 raw @ precision 5), receives 971.47 assetB.
    const bot = makeBot([
        { op: [4, { order_id: '1.7.999', pays: { asset_id: '1.3.0', amount: 100000 }, receives: { asset_id: '1.3.1', amount: 97147000 } }], block_num: 124 },
    ]);
    assert.strictEqual(refreshLastFillPivotFromQueue(bot), true);
    assert.ok(Math.abs(bot.manager._lastFilledPrice - 971.47) < 1e-6, `expected ~971.47, got ${bot.manager._lastFilledPrice}`);
    assert.strictEqual(bot.manager._lastFilledType, ORDER_TYPES.SELL);
    console.log('✓ SGP-2 passed');
}

async function testRefreshLatestWinsAndEmpty() {
    console.log('\n[SGP-3] latest queued fill wins; empty/unresolvable queue returns false');
    const bot = makeBot(
        [
            { op: [4, { order_id: '1.7.100' }], block_num: 123 },
            { op: [4, { order_id: '1.7.101' }], block_num: 124 },
        ],
        [
            { id: 'slot-1', orderId: '1.7.100', type: ORDER_TYPES.BUY, price: 960 },
            { id: 'slot-2', orderId: '1.7.101', type: ORDER_TYPES.BUY, price: 971.47 },
        ]
    );
    assert.strictEqual(refreshLastFillPivotFromQueue(bot), true);
    assert.strictEqual(bot.manager._lastFilledPrice, 971.47);

    const emptyBot = makeBot([]);
    assert.strictEqual(refreshLastFillPivotFromQueue(emptyBot), false);
    assert.strictEqual(emptyBot.manager._lastFilledPrice, 954.11, 'pivot untouched');

    const junkBot = makeBot([{ op: [4, { order_id: '1.7.unknown' }], block_num: 125 }]);
    assert.strictEqual(refreshLastFillPivotFromQueue(junkBot), false);
    assert.strictEqual(junkBot.manager._lastFilledPrice, 954.11, 'pivot untouched');
    console.log('✓ SGP-3 passed');
}

async function testPerActionOriginStamping() {
    console.log('\n[SGP-4] buildActionsFromPlan stamps plan origin per action');
    const plan = {
        origin: 'spread-correction',
        ordersToPlace: [{ id: 'slot-c', type: ORDER_TYPES.SELL, price: 1000, size: 5 }],
        ordersToRotate: [{
            oldOrder: { id: 'slot-r', orderId: '1.7.1', type: ORDER_TYPES.SELL, price: 900, size: 5 },
            newGridId: 'slot-r2', newPrice: 965, newSize: 5, type: ORDER_TYPES.SELL,
        }],
        ordersToUpdate: [{ partialOrder: { id: 'slot-u', orderId: '1.7.2', type: ORDER_TYPES.BUY, size: 5 }, newSize: 6 }],
    };
    const actions = buildActionsFromPlan(null, plan);
    const creates = actions.filter((a: any) => a.type === 'create');
    const rotations = actions.filter((a: any) => a.type === 'update' && a.newGridId && a.newGridId !== a.id);
    const plainUpdates = actions.filter((a: any) => a.type === 'update' && !(a.newGridId && a.newGridId !== a.id));
    assert.strictEqual(creates.length, 1);
    assert.strictEqual(rotations.length, 1);
    assert.strictEqual(plainUpdates.length, 1);
    for (const a of [...creates, ...rotations, ...plainUpdates]) {
        assert.strictEqual(a.origin, 'spread-correction', 'every action carries its own origin stamp');
    }
    // The broadcast rule: correction CREATES bypass, rotations never do — so a
    // rotation merged into a correction plan is still guardable at helper level.
    const rotationBlocked = isLastFillGuardBlocked(
        rotations[0].newPrice, ORDER_TYPES.SELL, 971.47, ORDER_TYPES.BUY
    );
    assert.strictEqual(rotationBlocked.blocked, true, 'rotation repricing below sell threshold is guardable regardless of origin');
    // A plan without origin stamps nothing (safe default: guarded).
    const plain = buildActionsFromPlan(null, { ordersToPlace: [{ id: 'x', type: ORDER_TYPES.BUY, price: 1, size: 1 }] });
    assert.strictEqual(plain[0].origin, undefined);
    console.log('✓ SGP-4 passed');
}

function makeFundsManager(buyFree: number, sellFree: number) {
    return {
        funds: {
            available: { buy: buyFree, sell: sellFree },
            committed: { chain: { buy: 0, sell: 0 } },
        },
        accountTotals: { buyFree, sellFree },
        assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
        logger: { log: () => {} },
    } as any;
}

async function testSideDecisionSkipsOnBadPrice() {
    console.log('\n[SGP-5] determineOrderSideByFunds returns null on unavailable price');
    // Both sides viable (raw units incomparable: 2192 BTS vs 0.12 XRP) + no price => skip.
    for (const badPrice of [NaN, undefined, null, 0, -5, 'nonsense']) {
        const mgr = makeFundsManager(2192, 0.12);
        const decision = determineOrderSideByFunds(mgr, badPrice);
        assert.strictEqual(decision.side, null, `price=${String(badPrice)} must skip, got ${decision.side}`);
    }
    // Single-side holdings still resolve without a price.
    assert.strictEqual(determineOrderSideByFunds(makeFundsManager(100, 0), NaN).side, ORDER_TYPES.BUY);
    assert.strictEqual(determineOrderSideByFunds(makeFundsManager(0, 100), NaN).side, ORDER_TYPES.SELL);
    // Valid price comparison unchanged: sell side larger in value => SELL.
    assert.strictEqual(determineOrderSideByFunds(makeFundsManager(2192, 50), 100).side, ORDER_TYPES.SELL);
    assert.strictEqual(determineOrderSideByFunds(makeFundsManager(6000, 50), 100).side, ORDER_TYPES.BUY);
    console.log('✓ SGP-5 passed');
}

async function testCommittedFallbackSkipsOnBadPrice() {
    console.log('\n[SGP-6] zero free funds skips — committed inventory is not recycled');
    const mgr = {
        funds: {
            available: { buy: 0, sell: 0 },
            committed: { chain: { buy: 100, sell: 50 } },
        },
        accountTotals: { buyFree: 0, sellFree: 0 },
        assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
        logger: { log: () => {} },
    } as any;
    const lines: string[] = [];
    const logMgr = { ...mgr, logger: { log: (m: string) => lines.push(m) } };
    const both = determineOrderSideByFunds(logMgr, 1);
    // PURE FUND-DRIVEN: committed inventory resting in orders is never recycled
    // to fund a correction; a zero free balance skips and the caller refreshes
    // account totals + open orders instead.
    assert.strictEqual(both.side, null, `zero free funds must skip even with committed inventory, got ${both.side}`);
    assert.ok(/insufficient free funds/i.test(both.reason), `reason must name insufficient free funds, got: ${both.reason}`);
    assert.ok(lines.some((l) => /insufficient free funds/i.test(l)), 'skip log must carry the cause');
    const onlyBuy = determineOrderSideByFunds({
        ...mgr, funds: { available: { buy: 0, sell: 0 }, committed: { chain: { buy: 100, sell: 0 } } },
    } as any, 1);
    assert.strictEqual(onlyBuy.side, null, 'single-side committed inventory must not be recycled either');
    console.log('✓ SGP-6 passed');
}

async function testFillPivotLogLine() {
    console.log('\n[SGP-7] recordLastFilledPrices emits one FILL-PIVOT line with src');
    const { OrderManager } = require('../modules/order/manager');
    const lines: string[] = [];
    const mockThis = {
        orders: new Map([['slot-1', { id: 'slot-1', price: 971.47 }]]),
        logger: { log: (m: string) => lines.push(m) },
        _lastFilledPrice: null,
        _lastFilledType: null,
        _lastFilledBuyPrice: null,
        _lastFilledSellPrice: null,
        _lastFilledAt: 0,
        lastFillPivotSource: null,
        _setLastFillPivot: function (type: any, price: number, provenance: any) {
            this._lastFilledPrice = price;
            this._lastFilledType = type;
            this._lastFilledAt = Date.now();
            this.lastFillPivotSource = provenance;
            if (type === ORDER_TYPES.BUY) this._lastFilledBuyPrice = price;
            else this._lastFilledSellPrice = price;
        },
    };
    const record = OrderManager.prototype.recordLastFilledPrices;
    // Partial fill with direct price.
    record.call(mockThis, [{ id: 'slot-9', type: ORDER_TYPES.SELL, price: 971.47, isPartial: true }]);
    assert.strictEqual(mockThis._lastFilledPrice, 971.47);
    assert.strictEqual(mockThis._lastFilledType, ORDER_TYPES.SELL);
    const pivotLines = lines.filter((l) => l.includes('[FILL-PIVOT]'));
    assert.strictEqual(pivotLines.length, 1, `expected one FILL-PIVOT line, got: ${JSON.stringify(lines)}`);
    assert.ok(/src=partial\/direct/.test(pivotLines[0]), `src must be partial/direct, got: ${pivotLines[0]}`);
    assert.ok(/n=1/.test(pivotLines[0]), `must report count, got: ${pivotLines[0]}`);
    // Fill without price resolves via the (previously invisible) slot fallback.
    lines.length = 0;
    record.call(mockThis, [{ id: 'slot-1', type: ORDER_TYPES.BUY, isPartial: false }]);
    assert.strictEqual(mockThis._lastFilledPrice, 971.47);
    const fbLines = lines.filter((l) => l.includes('[FILL-PIVOT]'));
    assert.strictEqual(fbLines.length, 1);
    assert.ok(/src=full\/slot-fallback/.test(fbLines[0]), `src must be full/slot-fallback, got: ${fbLines[0]}`);
    console.log('✓ SGP-7 passed');
}

async function main() {
    await testRefreshFromQueuedSlotFill();
    await testRefreshFromFillEconomics();
    await testRefreshLatestWinsAndEmpty();
    await testPerActionOriginStamping();
    await testSideDecisionSkipsOnBadPrice();
    await testCommittedFallbackSkipsOnBadPrice();
    await testFillPivotLogLine();
    console.log('\nAll stale-guard-pivot regression tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Stale-guard-pivot test failed:', err);
        process.exit(1);
    });
}

module.exports = { main };

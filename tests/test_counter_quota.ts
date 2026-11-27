/**
 * COUNTER QUOTA — focused batch-cap and exemption tests.
 *
 * Complements test_fill_one_counter_order with the two-rail shape of the cap:
 * at most `gapSlots + 1` counter slots per side are forced into one plan,
 * oldest debt first; the rest stay owed with `batch-cap`. Partial residuals
 * and dust-cancel synthetic fills never mint a debt.
 */

const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const StrategyEngine = require('../modules/order/strategy').default;
const { adoptPlacedBatchFromChain, filterPhantomCounterContexts } = require('../modules/dexbot_cow_runtime');

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void | Promise<void>) {
    return Promise.resolve().then(fn).then(() => {
        passed++;
        console.log(`  ✓ ${name}`);
    }, (err) => {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    });
}

const GAP = 2;
const SLOTS = 40;
const price = (i: number) => 100 * Math.pow(1.01, i);

function makeManager() {
    const logs: Array<{ msg: string; level?: string }> = [];
    const slots = Array.from({ length: SLOTS }, (_, i) => ({
        id: `slot-${i}`,
        price: price(i),
        type: i <= 20 ? ORDER_TYPES.BUY : (i >= 25 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
        state: ORDER_STATES.VIRTUAL,
        size: 0,
        orderId: null,
    }));
    return {
        orders: new Map(slots.map((s) => [s.id, { ...s }])),
        boundaryIdx: 20,
        _gapSlots: GAP,
        _genesis: { priceLevels: slots.map((s) => s.price), gapSlots: GAP, startPrice: 100 },
        config: {
            startPrice: 100, incrementPercent: 1, targetSpreadPercent: 3,
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5 },
            coreOrders: { buy: 20, sell: 20 },
            weightDistribution: { buy: 0.5, sell: 0.5 },
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0, assetA: 'TEST', assetB: 'BTS',
        },
        assets: {
            assetA: { id: '1.3.0', precision: 6, symbol: 'TEST' },
            assetB: { id: '1.3.1', precision: 6, symbol: 'BTS' },
        },
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        _metrics: {
            counterOrdersOwedCount: 0,
            counterOrdersPlacedCount: 0,
            counterDebtSlotsCount: 0,
        },
        _counterDebt: new Map(),
        _pendingFillCrawls: [] as Array<{ slotId: string; side: string; ts: number }>,
        _boundaryShiftBudget: null,
        _markGridDirty() {},
        recalculateFunds: async () => {},
        logs,
    };
}

function seedDebts(mgr: any, side: string, fillIdxs: number[], atBase = 1_000, keyBase = 0) {
    fillIdxs.forEach((idx, i) => {
        const fillSide = side === ORDER_TYPES.BUY ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
        const counterIdx = fillSide === ORDER_TYPES.SELL ? idx - GAP : idx + GAP;
        const key = `${side}-key-${keyBase + i}`;
        mgr._counterDebt.set(key, {
            fillKey: key,
            fillSide,
            fillSlotId: `slot-${idx}`,
            counterSide: side,
            counterSlotId: `slot-${counterIdx}`,
            at: atBase + i,
            attempts: 0,
        });
    });
}

function plan(mgr: any) {
    return new StrategyEngine(mgr).calculateTargetGrid({
        frozenMasterGrid: mgr.orders,
        config: mgr.config,
        accountAssets: mgr.assets,
        funds: {
            allocatedBuy: 10_000, allocatedSell: 10_000,
            chainFreeBuy: 10_000, chainFreeSell: 10_000,
            btsBalance: { free: 100 },
        },
        fills: [],
        currentBoundaryIdx: mgr.boundaryIdx,
    });
}

async function main() {
    console.log('\n=== COUNTER QUOTA (focused) ===\n');

    await run('CQ-1 the cap is global across rails, oldest first; the remainder stays owed', () => {
        const mgr: any = makeManager();
        // Interleave the debts in time so the oldest-first rule spans both
        // rails: BUY counter (from a SELL fill), SELL counter (from a BUY fill),
        // BUY counter, ... Only gap+1 of all eight may be emitted this cycle.
        seedDebts(mgr, ORDER_TYPES.BUY, [10], 1_000, 0);
        seedDebts(mgr, ORDER_TYPES.SELL, [30], 1_001, 0);
        seedDebts(mgr, ORDER_TYPES.BUY, [11], 1_002, 1);
        seedDebts(mgr, ORDER_TYPES.SELL, [31], 1_003, 1);
        seedDebts(mgr, ORDER_TYPES.BUY, [12], 1_004, 2);
        seedDebts(mgr, ORDER_TYPES.SELL, [32], 1_005, 2);
        seedDebts(mgr, ORDER_TYPES.BUY, [13], 1_006, 3);
        seedDebts(mgr, ORDER_TYPES.SELL, [33], 1_007, 3);
        const result = plan(mgr);
        const entries = [...mgr._counterDebt.values()] as any[];
        const selected = entries.filter((e) => !e.lastDeferReason);
        assert.strictEqual(selected.length, GAP + 1, 'only gap+1 debts are emitted in one cycle');
        assert.deepStrictEqual(selected.map((e) => e.fillKey).sort(),
            ['buy-key-0', 'buy-key-1', 'sell-key-0'],
            'the three oldest debts win, regardless of their rail');
        const capped = entries.filter((e) => e.lastDeferReason === 'batch-cap');
        assert.strictEqual(capped.length, 8 - (GAP + 1), 'the rest stay owed with a batch-cap reason');
        assert.strictEqual(capped[0].attempts, 1, 'a capped debt records the attempt');
        assert.strictEqual(mgr._metrics.counterDebtSlotsCount, 8, 'all eight debts remain owed until placement');
        const stamped = [...result.targetGrid.entries()]
            .filter(([, o]: any) => o.metadata && o.metadata.counterForFillKey)
            .map(([, o]: any) => o.metadata.counterForFillKey as string);
        assert.deepStrictEqual(stamped.sort(), ['buy-key-0', 'buy-key-1', 'sell-key-0'],
            'the selected counters carry their fill keys into the target grid');
        assert.ok(mgr.logs.some((l: any) => l.level === 'debug'
            && /^\[COUNTER-QUOTA\] batch buy=2 sell=1 owed=8(?:\s|$)/.test(l.msg)),
            'the batch log uses the documented buy/sell/owed shape');
    });

    await run('CQ-2 partial residuals do not mint debts', async () => {
        const mgr: any = makeManager();
        const strategy = new StrategyEngine(mgr);
        await strategy.processFillsOnly([
            { id: 'slot-25', orderId: '1.7.25', block_num: 300, historyId: 'h-25',
                type: ORDER_TYPES.SELL, price: price(25), size: 1, isPartial: true },
            { id: 'slot-26', orderId: '1.7.26', block_num: 301, historyId: 'h-26',
                type: ORDER_TYPES.SELL, price: price(26), size: 1, isPartial: true, isDelayedRotationTrigger: true },
        ]);
        assert.strictEqual(mgr._counterDebt.size, 0, 'a residual leaves its slot live and owes nothing');
        assert.strictEqual(mgr._metrics.counterOrdersOwedCount, 0);
    });

    await run('CQ-3 dust-cancel synthetic fills do not mint debts', async () => {
        const mgr: any = makeManager();
        const strategy = new StrategyEngine(mgr);
        await strategy.processFillsOnly([
            { id: 'slot-27', orderId: '1.7.27', block_num: 400, historyId: 'h-27',
                type: ORDER_TYPES.SELL, price: price(27), size: 0.001, isPartial: false,
                isDelayedRotationTrigger: true, skipAnchorUpdate: true },
        ]);
        assert.strictEqual(mgr._counterDebt.size, 0, 'maintenance cancels are not trades');
        assert.strictEqual(mgr._metrics.counterOrdersOwedCount, 0);
    });

    await run('CQ-4 a confirmed stamped op promotes an older capped debt next cycle', async () => {
        const mgr: any = makeManager();
        seedDebts(mgr, ORDER_TYPES.BUY, [10, 11, 12, 13]);
        const result = plan(mgr);
        const capped = [...mgr._counterDebt.values()].find((e: any) => e.lastDeferReason === 'batch-cap') as any;
        assert.ok(capped, 'one BUY debt was capped');
        const confirmed = [...mgr._counterDebt.values()].find((e: any) => !e.lastDeferReason) as any;
        const stamped = [...result.targetGrid.values()].find((o: any) =>
            o.metadata?.counterForFillKey === confirmed.fillKey) as any;
        assert.ok(stamped, 'the selected counter carries its fill key in the plan');
        // A sitting order alone never clears a debt; only the stamped op's
        // on-chain confirmation does.
        plan(mgr);
        assert.strictEqual(mgr._counterDebt.has(confirmed.fillKey), true, 'a re-plan keeps the unconfirmed debt');
        const bot: any = {
            accountId: '1.2.345',
            manager: {
                orders: mgr.orders,
                _counterDebt: mgr._counterDebt,
                _metrics: mgr._metrics,
                logger: mgr.logger,
                syncFromOpenOrders: async () => {},
            },
        };
        const chainOrders: any = {
            batchReadOrders: async (ids: string[]) => new Map(ids.map((id) => [id, { id }])),
        };
        const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, '[COUNTER-QUOTA] test', {
            polledCreateIds: ['1.7.999'],
            placedContexts: [{
                kind: 'create', orderId: '1.7.999',
                order: { metadata: stamped.metadata, orderId: '1.7.999' },
            }],
        });
        assert.strictEqual(adopted, true);
        assert.strictEqual(mgr._counterDebt.has(confirmed.fillKey), false, 'the stamped op clears its debt');
        assert.strictEqual(mgr._metrics.counterOrdersPlacedCount, 1);
        plan(mgr);
        assert.ok(!capped.lastDeferReason,
            `the former batch-cap debt is promoted on the next cycle (got ${capped.lastDeferReason})`);
        assert.strictEqual(mgr._counterDebt.has(capped.fillKey), true, 'it kept its identity across cycles');
    });

    await run('CQ-5 normalized missing CREATEs cannot settle a stamped counter debt', () => {
        const real = { kind: 'create', order: { id: 'slot-2' } };
        const phantom = { kind: 'create', order: { id: 'slot-3' } };
        const phantoms = new Set([phantom]);
        const kept = filterPhantomCounterContexts([real, phantom], phantoms);
        assert.deepStrictEqual(kept, [real], 'the phantom context is excluded from confirmation');
        assert.deepStrictEqual(filterPhantomCounterContexts(null, phantoms), [], 'null context set stays empty');
    });

    console.log(`\nCOUNTER-QUOTA: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});

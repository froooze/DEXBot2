/**
 * ONE FILL → ONE COUNTER ORDER — IN-MEMORY QUOTA LEDGER.
 *
 * Rewritten from the refused-level-marker suite for the fill-authoritative
 * policy. Every FULL fill owes exactly one counter order on the opposite
 * rail; the obligation is an in-memory Map keyed by the chain fill key, never
 * reserved proceeds and never persisted. At most `gapSlots + 1` owed counters
 * are forced into a cycle's target grid (oldest first); the remainder stays
 * owed with reason `batch-cap`. Re-delivery replaces, not stacks. A debt is
 * cleared only when its counter slot holds a placed order on the right rail
 * at plan time. Partial residuals and dust-cancel synthetic fills owe nothing.
 */

const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const StrategyEngine = require('../modules/order/strategy').default;
const { fillKeyOf } = require('../modules/order/fill_ledger');
const { adoptPlacedBatchFromChain } = require('../modules/dexbot_cow_runtime');
const { recordCounterDebt } = require('../modules/order/utils/counter_debt');
const { attributeUnmatchedFillToGrid } = require('../modules/order/utils/order');

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void | Promise<void>) {
    try {
        const result = fn();
        if (result && typeof (result as Promise<void>).then === 'function') {
            return (result as Promise<void>).then(() => {
                passed++;
                console.log(`  ✓ ${name}`);
            }, (err) => {
                failed++;
                console.error(`  ✗ ${name}`);
                console.error(`    ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
}

const SLOTS = 40;
const GAP = 4;
const BASE = 100;

function price(idx: number): number { return BASE * Math.pow(1.01, idx); }

function makeManager(over: Record<string, any> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    const slots = Array.from({ length: SLOTS }, (_, i) => ({
        id: `slot-${i}`,
        price: price(i),
        type: i <= 20 ? ORDER_TYPES.BUY : (i >= 25 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
        state: ORDER_STATES.VIRTUAL,
        size: 0,
        orderId: null,
        metadata: undefined as Record<string, unknown> | undefined,
    }));
    const manager: any = {
        orders: new Map(slots.map((s) => [s.id, { ...s }])),
        boundaryIdx: 20,
        _gapSlots: GAP,
        _genesis: { priceLevels: slots.map((s) => s.price), gapSlots: GAP, startPrice: BASE },
        config: {
            startPrice: BASE, incrementPercent: 1, targetSpreadPercent: 5,
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
        ...over,
    };
    return manager;
}

function fullFill(idx: number, over: Record<string, unknown> = {}) {
    return {
        id: `slot-${idx}`,
        orderId: `1.7.${1000 + idx}`,
        block_num: 2000 + idx,
        historyId: `h-${idx}`,
        type: ORDER_TYPES.SELL,
        price: price(idx),
        size: 10,
        isPartial: false,
        ...over,
    };
}

function plan(manager: any, strategy: any) {
    return strategy.calculateTargetGrid({
        frozenMasterGrid: manager.orders,
        config: manager.config,
        accountAssets: manager.assets,
        funds: {
            allocatedBuy: 10_000, allocatedSell: 10_000,
            chainFreeBuy: 10_000, chainFreeSell: 10_000,
            btsBalance: { free: 100 },
        },
        fills: [],
        currentBoundaryIdx: manager.boundaryIdx,
    });
}

async function main() {
    console.log('\n=== ONE FILL / ONE COUNTER QUOTA ===\n');

    await run('Q-1 N distinct full fills create N debts with distinct counter slots', async () => {
        const mgr = makeManager();
        const strategy = new StrategyEngine(mgr);
        const fills = [10, 11, 12, 13, 14, 15].map((i) => fullFill(i));
        await strategy.processFillsOnly(fills);
        assert.strictEqual(mgr._counterDebt.size, 6, 'one debt per distinct full fill');
        assert.strictEqual(mgr._metrics.counterOrdersOwedCount, 6, 'the owed counter increments per new fill');
        const slots = [...mgr._counterDebt.values()].map((e: any) => e.counterSlotId);
        assert.deepStrictEqual(slots, ['slot-6', 'slot-7', 'slot-8', 'slot-9', 'slot-10', 'slot-11'],
            'counter slot is s - gap for a SELL fill');
        assert.strictEqual(new Set(slots).size, slots.length, 'each fill owns a distinct counter slot');
        for (const [key, entry] of mgr._counterDebt) {
            assert.strictEqual(key, fillKeyOf({ orderId: entry.fillKey.split(':')[0], block_num: Number(entry.fillKey.split(':')[1]), id: entry.fillKey.split(':')[2] }),
                'the ledger key comes from the shared fill-key owner');
            assert.strictEqual((entry as any).fillSide, ORDER_TYPES.SELL);
            assert.strictEqual((entry as any).counterSide, ORDER_TYPES.BUY, 'a SELL fill owes a BUY counter');
        }
    });

    await run('Q-2 a BUY fill owes a SELL counter at s + gap', async () => {
        const mgr = makeManager();
        const strategy = new StrategyEngine(mgr);
        await strategy.processFillsOnly([fullFill(8, { type: ORDER_TYPES.BUY })]);
        const entry: any = [...mgr._counterDebt.values()][0];
        assert.strictEqual(entry.counterSide, ORDER_TYPES.SELL);
        assert.strictEqual(entry.counterSlotId, 'slot-12');
    });

    await run('Q-3 re-delivery of the same fill replaces, never stacks', async () => {
        const mgr = makeManager();
        const strategy = new StrategyEngine(mgr);
        const fill = fullFill(10);
        await strategy.processFillsOnly([fill]);
        const before: any = [...mgr._counterDebt.values()][0];
        before.attempts = 2;
        before.lastDeferReason = 'batch-cap';
        await strategy.processFillsOnly([fill]);
        assert.strictEqual(mgr._counterDebt.size, 1, 'the ledger holds one entry per fill key');
        const after: any = [...mgr._counterDebt.values()][0];
        assert.notStrictEqual(after, before, 're-delivery replaces the old entry with a fresh one');
        assert.strictEqual(after.fillKey, before.fillKey, 'the key is unchanged');
        assert.strictEqual(after.counterSlotId, before.counterSlotId, 'the counter slot is unchanged');
        assert.strictEqual(after.at, before.at, 'the original clock survives replacement');
        assert.strictEqual(after.attempts, 2, 'retry history survives re-delivery');
        assert.strictEqual(after.lastDeferReason, 'batch-cap');
        assert.strictEqual(mgr._metrics.counterOrdersOwedCount, 1, 're-delivery does not double count');
    });

    await run('Q-4 partial residuals and dust-cancel synthetic fills owe nothing', async () => {
        const mgr = makeManager();
        const strategy = new StrategyEngine(mgr);
        await strategy.processFillsOnly([
            fullFill(10, { isPartial: true }),
            fullFill(11, { isPartial: false, isDelayedRotationTrigger: true, skipAnchorUpdate: true }),
            fullFill(12, { isPartial: true, isDelayedRotationTrigger: true }),
        ]);
        assert.strictEqual(mgr._counterDebt.size, 0, 'no synthetic/partial fill mints a counter debt');
        assert.strictEqual(mgr._metrics.counterOrdersOwedCount, 0);
    });

    await run('Q-5 at most gap+1 counters are stacked per cycle; the rest stay owed', () => {
        const mgr = makeManager();
        const strategy = new StrategyEngine(mgr);
        // Seed six debts directly: the ingestion path is covered above, this
        // case isolates the batch cap in calculateTargetGrid.
        for (let i = 0; i < 6; i++) {
            mgr._counterDebt.set(`key-${i}`, {
                fillKey: `key-${i}`, fillSide: ORDER_TYPES.SELL, fillSlotId: `slot-${10 + i}`,
                counterSide: ORDER_TYPES.BUY, counterSlotId: `slot-${6 + i}`,
                at: 1_000 + i, attempts: 0,
            });
        }
        const result = plan(mgr, strategy);
        const entries = [...mgr._counterDebt.values()] as any[];
        assert.strictEqual(entries.filter((e) => !e.lastDeferReason).length, GAP + 1,
            'exactly gapSlots+1 oldest debts are selected (6..10)');
        assert.strictEqual(mgr._metrics.counterDebtSlotsCount, 6, 'the whole ledger stays owed for later cycles');
        const capped = entries.filter((e) => e.lastDeferReason === 'batch-cap');
        assert.deepStrictEqual(capped.map((e) => e.fillKey), ['key-5'], 'the remainder keeps a batch-cap reason');
        assert.strictEqual(capped[0].attempts, 1, 'a capped debt records the attempt');
        const stamped = [...result.targetGrid.entries()]
            .filter(([, o]: any) => o.metadata && o.metadata.counterForFillKey)
            .map(([id, o]: any) => [id, o.metadata.counterForFillKey]) as Array<[string, string]>;
        const byIdx = (a: string, b: string) => Number(a.replace('slot-', '')) - Number(b.replace('slot-', ''));
        assert.deepStrictEqual(stamped.map(([id]) => id).sort(byIdx),
            ['slot-6', 'slot-7', 'slot-8', 'slot-9', 'slot-10'],
            'the selected counter slots are forced into the active target grid');
        assert.deepStrictEqual(stamped.map(([, key]) => key).sort(),
            ['key-0', 'key-1', 'key-2', 'key-3', 'key-4'],
            'each stamped op carries the fill key it settles');
        for (const [id] of stamped) {
            assert.strictEqual((result.targetGrid.get(id) as any).state, ORDER_STATES.ACTIVE,
                `counter slot ${id} must be active at plan time`);
        }
        assert.ok(mgr.logs.some((l: any) => l.level === 'debug'
            && new RegExp(`^\\[COUNTER-QUOTA\\] batch buy=${GAP + 1} sell=0 owed=6(?:\\s|$)`).test(l.msg)),
            'the batch-summary debug line uses the documented buy/sell/owed shape');
    });

    await run('Q-6 a debt clears only when its stamped counter op is confirmed', async () => {
        const mgr = makeManager();
        const strategy = new StrategyEngine(mgr);
        mgr._counterDebt.set('key-confirmed', {
            fillKey: 'key-confirmed', fillSide: ORDER_TYPES.SELL, fillSlotId: 'slot-10',
            counterSide: ORDER_TYPES.BUY, counterSlotId: 'slot-6',
            at: 1, attempts: 0,
        });
        mgr._counterDebt.set('key-wrong-side', {
            fillKey: 'key-wrong-side', fillSide: ORDER_TYPES.SELL, fillSlotId: 'slot-11',
            counterSide: ORDER_TYPES.BUY, counterSlotId: 'slot-30',
            at: 2, attempts: 0,
        });
        // slot-6 carries a placed BUY (the counter). slot-30 is a SELL-rail
        // slot carrying a placed SELL — not the BUY counter this debt owes.
        (mgr.orders.get('slot-6') as any).state = ORDER_STATES.ACTIVE;
        (mgr.orders.get('slot-6') as any).type = ORDER_TYPES.BUY;
        (mgr.orders.get('slot-6') as any).orderId = '1.7.999';
        (mgr.orders.get('slot-30') as any).state = ORDER_STATES.ACTIVE;
        (mgr.orders.get('slot-30') as any).type = ORDER_TYPES.SELL;
        (mgr.orders.get('slot-30') as any).orderId = '1.7.wrong-side';
        const result = plan(mgr, strategy);
        // An order merely SITTING in the counter slot is not proof that THIS
        // fill's stamped counter op landed: neither debt clears at plan time.
        assert.strictEqual(mgr._counterDebt.has('key-confirmed'), true);
        assert.strictEqual(mgr._counterDebt.has('key-wrong-side'), true);
        assert.strictEqual(mgr._metrics.counterOrdersPlacedCount, 0);
        // Only a stamped op context confirmed through adoption settles its own
        // debt. Use the metadata the plan stamped on the target slot.
        const stamped = [...result.targetGrid.values()].find((o: any) =>
            o.metadata?.counterForFillKey === 'key-confirmed') as any;
        assert.ok(stamped, 'the confirmed counter target carries the fill key');
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
                kind: 'create',
                orderId: '1.7.999',
                order: { metadata: stamped.metadata, orderId: '1.7.999' },
            }],
        });
        assert.strictEqual(adopted, true, 'the stamped counter op was confirmed on chain');
        assert.strictEqual(mgr._counterDebt.has('key-confirmed'), false, 'its own debt clears');
        assert.strictEqual(mgr._counterDebt.has('key-wrong-side'), true, 'the other debt stays owed');
        assert.strictEqual(mgr._metrics.counterOrdersPlacedCount, 1, 'only confirmed counters count as placed');
        assert.strictEqual(mgr._metrics.counterDebtSlotsCount, 1);
    });

    await run('Q-7 a debt survives a plan with no free counter rail slot', () => {
        const mgr = makeManager();
        const strategy = new StrategyEngine(mgr);
        mgr._counterDebt.set('key-stranded', {
            fillKey: 'key-stranded', fillSide: ORDER_TYPES.BUY, fillSlotId: 'slot-5',
            counterSide: ORDER_TYPES.SELL, counterSlotId: 'slot-9',
            at: 1, attempts: 0,
        });
        // Every SELL-rail slot is occupied, so the BUY fill's counter has no
        // free destination. The debt must remain owed, never vanish.
        for (const slot of mgr.orders.values()) {
            if ((slot as any).type === ORDER_TYPES.SELL) {
                (slot as any).state = ORDER_STATES.ACTIVE;
                (slot as any).orderId = '1.7.occupied';
            }
        }
        plan(mgr, strategy);
        const entry: any = mgr._counterDebt.get('key-stranded');
        assert.ok(entry, 'an unplaceable counter stays owed');
        assert.strictEqual(entry.lastDeferReason, 'no-slot',
            `the deferral must name the missing slot (got ${entry.lastDeferReason})`);
        assert.strictEqual(entry.attempts, 1);
        assert.strictEqual(mgr._metrics.counterOrdersPlacedCount, 0);
    });

    await run('Q-8 the debt ledger is capped oldest-first so it cannot grow without bound', () => {
        const mgr = makeManager();
        for (let i = 0; i < 502; i++) {
            recordCounterDebt(mgr, fullFill(i, { id: `slot-${i % SLOTS}` }));
        }
        assert.strictEqual(mgr._counterDebt.size, 500, 'the ledger holds at most the crawl-ledger cap');
        assert.strictEqual(mgr._counterDebt.has('1.7.1000:2000:h-0'), false, 'the oldest debt is evicted');
        assert.strictEqual(mgr._counterDebt.has('1.7.1501:2501:h-501'), true, 'the freshest fill stays owed');
        assert.strictEqual(mgr._metrics.counterDebtSlotsCount, 500);
        assert.ok(mgr.logs.some((l: any) => l.level === 'warn' && /ledger cap/.test(String(l.msg))),
            'an eviction is diagnosable');
    });

    await run('Q-9 recovery settles only debts whose stamped op was confirmed by the poll', async () => {
        const mgr = makeManager();
        mgr._counterDebt.set('key-a', {
            fillKey: 'key-a', fillSide: ORDER_TYPES.SELL, fillSlotId: 'slot-30',
            counterSide: ORDER_TYPES.BUY, counterSlotId: 'slot-6', at: 1, attempts: 0,
        });
        mgr._counterDebt.set('key-b', {
            fillKey: 'key-b', fillSide: ORDER_TYPES.SELL, fillSlotId: 'slot-31',
            counterSide: ORDER_TYPES.BUY, counterSlotId: 'slot-7', at: 2, attempts: 0,
        });
        const ctxA = { kind: 'create', orderId: '1.7.901', order: { id: 'slot-6', orderId: '1.7.901', metadata: { counterForFillKey: 'key-a' } } };
        const ctxB = { kind: 'create', orderId: '1.7.902', order: { id: 'slot-7', orderId: '1.7.902', metadata: { counterForFillKey: 'key-b' } } };
        const bot: any = {
            accountId: '1.2.345',
            manager: {
                orders: mgr.orders, _counterDebt: mgr._counterDebt, _metrics: mgr._metrics,
                logger: mgr.logger, syncFromOpenOrders: async () => {},
            },
        };
        const chainOrders: any = {
            batchReadOrders: async (ids: string[]) => new Map(ids.map((id) => [id, { id }])),
        };
        const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, '[COUNTER-QUOTA] test', {
            placedContexts: [ctxA, ctxB],
            polledCreateIds: ['1.7.901', '1.7.902'],
            // Only ctxA was poll-confirmed: ctxB's CREATE must NOT settle its debt.
            polledConfirmedContexts: [ctxA],
        });
        assert.strictEqual(adopted, true);
        assert.strictEqual(mgr._counterDebt.has('key-a'), false, 'the confirmed op clears its own debt');
        assert.strictEqual(mgr._counterDebt.has('key-b'), true, 'the unconfirmed op stays owed');
        assert.strictEqual(mgr._metrics.counterOrdersPlacedCount, 1);
    });

    await run('Q-10 both fill writers dedupe on full chain fill identity', () => {
        const mgr = makeManager();
        const slot: any = mgr.orders.get('slot-30');
        slot.orderId = '1.7.777';
        const fill = fullFill(30, { orderId: '1.7.777', block_num: 2000, historyId: 'h-shared' });
        recordCounterDebt(mgr, fill);
        // The second writer resolves a different slot but the SAME chain fill;
        // without block/history threading it would mint a slot-keyed second debt.
        const attributed = attributeUnmatchedFillToGrid(mgr, {
            orderId: '1.7.777', blockNum: 2000, historyId: 'h-shared'
        });
        assert.strictEqual(attributed, true, 'the unmatched fill was attributed');
        assert.strictEqual(mgr._counterDebt.size, 1, 'the two writers mint one debt, not two');
        assert.strictEqual(mgr._metrics.counterOrdersOwedCount, 1);
    });

    await run('Q-11 a missing poll id keeps its context slot so later ids do not shift', async () => {
        const mgr = makeManager();
        mgr._counterDebt.set('key-a', {
            fillKey: 'key-a', fillSide: ORDER_TYPES.SELL, fillSlotId: 'slot-30',
            counterSide: ORDER_TYPES.BUY, counterSlotId: 'slot-6', at: 1, attempts: 0,
        });
        mgr._counterDebt.set('key-b', {
            fillKey: 'key-b', fillSide: ORDER_TYPES.SELL, fillSlotId: 'slot-31',
            counterSide: ORDER_TYPES.BUY, counterSlotId: 'slot-7', at: 2, attempts: 0,
        });
        const ctxA = { kind: 'create', orderId: '1.7.900', order: { id: 'slot-6', orderId: '1.7.900', metadata: { counterForFillKey: 'key-a' } } };
        const ctxB = { kind: 'create', orderId: '1.7.902', order: { id: 'slot-7', orderId: '1.7.902', metadata: { counterForFillKey: 'key-b' } } };
        const bot: any = {
            accountId: '1.2.345',
            manager: {
                orders: mgr.orders, _counterDebt: mgr._counterDebt, _metrics: mgr._metrics,
                logger: mgr.logger, syncFromOpenOrders: async () => {},
            },
        };
        const chainOrders: any = {
            batchReadOrders: async (ids: string[]) => new Map(ids.map((id) => [id, { id }])),
        };
        const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, '[COUNTER-QUOTA] test', {
            placedContexts: [ctxA, ctxB],
            // ctxA matched no usable chain id; its empty slot must not let
            // ctxB's id shift left and wrongly settle ctxA's debt.
            polledCreateIds: ['', '1.7.902'],
            polledConfirmedContexts: [ctxA, ctxB],
        });
        assert.strictEqual(adopted, true);
        assert.strictEqual(mgr._counterDebt.has('key-a'), true, 'the id-less context stays owed');
        assert.strictEqual(mgr._counterDebt.has('key-b'), false, 'the aligned id settles its own debt');
        assert.strictEqual(mgr._metrics.counterOrdersPlacedCount, 1);
    });

    console.log(`\nONE-FILL-ONE-COUNTER: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});

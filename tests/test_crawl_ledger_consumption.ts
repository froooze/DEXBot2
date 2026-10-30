/**
 * CRAWL-CONSUME: the commit clears only the owed fill crawls a derivation
 * actually consumed.
 *
 * The ledger records an unapplied boundary move per shift-eligible fill. The
 * derivation folds a SUBSET (current-batch dedupe, edge classification,
 * cross-chunk cap) while the commit used to clear ALL of it — so a record the
 * derivation could not apply vanished with the ones it could. Live signature
 * (2026-10-25): 7 fills at slots 147-153, two commits each dropped owed crawls,
 * the boundary ended at 146 and the sell window sat behind the fill.
 *
 * CRAWL-1..5 pin the derivation's consumed set; CRAWL-6..9 pin the commit-side
 * filtering (only consumed are dropped, the rest stay owed and are logged).
 */

const assert = require('assert');
const { deriveTargetBoundary } = require('../modules/order/utils/order');
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
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${name}`);
        console.error(`    ${msg}`);
    }
}

const LEVELS = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
const slots = (n = LEVELS.length) => LEVELS.slice(0, n).map((price, idx) => ({
    id: `slot-${idx}`, price, type: idx <= 6 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
    orderId: `1.7.${idx}`, size: 10,
}));
const config = { startPrice: 100, incrementPercent: 1, coreOrders: { buy: 6, sell: 6 } };
const GAP = 2;
const crawl = (id: string, side: string, ts: number) => ({ slotId: id, side, ts });

console.log('=== CRAWL-CONSUME: owed crawls are cleared only when consumed ===');

run('CRAWL-1 an owed crawl that is folded is consumed', () => {
    const r = deriveTargetBoundary([], 6, slots(), config, GAP, null,
        [crawl('slot-3', ORDER_TYPES.SELL, 1000)], { buy: 95, sell: 110 });
    assert.strictEqual(r.boundaryIdx, 7, 'a SELL crawl moves the boundary up one slot');
    assert.deepStrictEqual(r.consumedCrawlIds, [{ slotId: 'slot-3', side: ORDER_TYPES.SELL, ts: 1000 }],
        'the folded record must be reported as consumed');
});

run('CRAWL-2 a truncated shift keeps the owed crawls (cap exhausted)', () => {
    // crossChunkBudget 0 => cap 0 => nothing may move, so nothing was applied.
    const r = deriveTargetBoundary([], 6, slots(), config, GAP, 0,
        [crawl('slot-3', ORDER_TYPES.SELL, 1000), crawl('slot-4', ORDER_TYPES.SELL, 1001)], { buy: 95, sell: 110 });
    assert.strictEqual(r.boundaryIdx, 6, 'an exhausted budget must not move the boundary');
    assert.deepStrictEqual(r.consumedCrawlIds, [], 'nothing applied => nothing consumed (still owed)');
});

run('CRAWL-3 a shift wider than the cap consumes only what it applied', () => {
    // coreOrders 6/6 => fallbackCap 3; five SELL crawls = +5 > 3 => truncated.
    const crawls = [0, 1, 2, 3, 4].map((i) => crawl(`slot-${i}`, ORDER_TYPES.SELL, 2000 + i));
    const r = deriveTargetBoundary([], 6, slots(), config, GAP, null, crawls, { buy: 95, sell: 110 });
    assert.strictEqual(r.boundaryIdx, 9, 'the cap admits exactly three slots');
    assert.deepStrictEqual(r.consumedCrawlIds.map((e: { ts?: number }) => e.ts), [2000, 2001, 2002],
        'exactly the three applied crawls are consumed; the remaining +2 stays owed');
});

run('CRAWL-4 a current-batch record is consumed (never double-counted, never left owed)', () => {
    // The batch's own fill crawls from `fills`; its ledger record is therefore
    // excluded from the pending fold — but it MUST still be consumed, or every
    // committed batch would leave one record per filled slot owed forever.
    const r = deriveTargetBoundary(
        [{ id: 'slot-9', price: 109, type: ORDER_TYPES.SELL }], 6, slots(), config, GAP, null,
        [crawl('slot-9', ORDER_TYPES.SELL, 3001)],
        { buy: 100, sell: 110 }
    );
    assert.strictEqual(r.boundaryIdx, 7, 'exactly one slot of crawl (from the fill, not twice)');
    assert.deepStrictEqual(r.consumedCrawlIds, [{ slotId: 'slot-9', side: ORDER_TYPES.SELL, ts: 3001 }],
        'the deduped record must be reported consumed');
});

run('CRAWL-5 a malformed record is consumed (junk must not accumulate)', () => {
    const r = deriveTargetBoundary([], 6, slots(), config, GAP, null,
        [{ slotId: 'slot-3', side: 'SPREAD', ts: 4000 }, { slotId: '', side: ORDER_TYPES.SELL, ts: 4001 }],
        { buy: 95, sell: 110 });
    assert.strictEqual(r.boundaryIdx, 6, 'a SPREAD record carries no crawl');
    assert.deepStrictEqual(r.consumedCrawlIds, [{ slotId: 'slot-3', side: 'SPREAD', ts: 4000 }],
        'a non-crawl side is dropped as consumed; the empty-slot record is not ledger material');
});

run('CRAWL-6b an absolute fill anchor subsumes every owed record (even when capped)', () => {
    // Boundary null forces the recovery path; a fill anchors it absolutely. The
    // owed deltas are NOT added on top (double-count guard), so all are consumed
    // no matter what a cap would have admitted.
    const r = deriveTargetBoundary(
        [{ id: 'slot-9', price: 109, type: ORDER_TYPES.SELL }], null, slots(), config, GAP, 0,
        [crawl('slot-3', ORDER_TYPES.BUY, 6000), crawl('slot-4', ORDER_TYPES.SELL, 6001)],
        { buy: 100, sell: 110 }
    );
    assert.ok(Number.isFinite(r.boundaryIdx), 'the fill anchor must recover a boundary');
    assert.strictEqual(r.consumedCrawlIds.length, 2, 'the absolute anchor subsumes both records');
});

run('CRAWL-6 a null boundary consumes nothing (no commit follows)', () => {
    const r = deriveTargetBoundary([], null, [], config, GAP, null,
        [crawl('slot-3', ORDER_TYPES.SELL, 5000)], { buy: 95, sell: 110 });
    assert.strictEqual(r.boundaryIdx, null);
    assert.deepStrictEqual(r.consumedCrawlIds, [], 'an unrecoverable boundary applies nothing');
});

run('CRAWL-7 the commit drops only the consumed records and keeps the rest owed', () => {
    const { OrderManager } = require('../modules/order/manager');
    const logs: string[] = [];
    const manager: any = new OrderManager({
        config: { ...config },
        logger: { log: (m: string) => logs.push(m) },
        marketName: 'TEST/OTHER',
    } as any);
    manager.logger = { log: (m: string) => logs.push(m) };
    manager._pendingFillCrawls = [
        crawl('slot-3', ORDER_TYPES.SELL, 6000),
        crawl('slot-4', ORDER_TYPES.BUY, 6001),
        crawl('slot-5', ORDER_TYPES.SELL, 6002),
    ];
    manager._consumePendingFillCrawls([crawl('slot-3', ORDER_TYPES.SELL, 6000)], 'boundary commit', 'boundary 6 -> 7');
    assert.deepStrictEqual(manager._pendingFillCrawls.map((e: { slotId: string }) => e.slotId),
        ['slot-4', 'slot-5'], 'the unconsumed records must stay owed');
    const line = logs.find((l) => l.includes('Dropped')) || '';
    assert.ok(line.includes('kept=2'), `the drop line must report what was kept: ${line}`);
});

run('CRAWL-8 a newer record for the same slot is not cleared by an older consumption', () => {
    const { OrderManager } = require('../modules/order/manager');
    const manager: any = new OrderManager({
        config: { ...config }, logger: { log: () => {} }, marketName: 'TEST/OTHER',
    } as any);
    manager._pendingFillCrawls = [crawl('slot-3', ORDER_TYPES.SELL, 7002)]; // re-recorded later
    manager._consumePendingFillCrawls([crawl('slot-3', ORDER_TYPES.SELL, 7001)], 'boundary commit');
    assert.strictEqual(manager._pendingFillCrawls.length, 1, 'a re-recorded slot must survive the stale clear');
});

run('CRAWL-9 no consumed wire keeps the whole ledger and says so', () => {
    const { OrderManager } = require('../modules/order/manager');
    const logs: string[] = [];
    const manager: any = new OrderManager({
        config: { ...config }, logger: { log: (m: string) => logs.push(m) }, marketName: 'TEST/OTHER',
    } as any);
    manager.logger = { log: (m: string) => logs.push(m) };
    manager._pendingFillCrawls = [crawl('slot-3', ORDER_TYPES.SELL, 8000)];
    // A plan that never derived a boundary (e.g. a create-only correction) must
    // not consume anything: absent wire => clear nothing.
    manager._consumePendingFillCrawls(undefined, 'boundary commit', 'boundary 6 -> 6');
    assert.strictEqual(manager._pendingFillCrawls.length, 1);
    assert.ok(logs.some((l) => l.includes('Kept 1 owed fill crawl(s) unconsumed')),
        `expected a kept-line, got: ${JSON.stringify(logs)}`);
});

run('CRAWL-10 the explicit drop path (rebuild/reject) still clears everything', () => {
    const { OrderManager } = require('../modules/order/manager');
    const manager: any = new OrderManager({
        config: { ...config }, logger: { log: () => {} }, marketName: 'TEST/OTHER',
    } as any);
    manager._pendingFillCrawls = [crawl('slot-3', ORDER_TYPES.SELL, 9000), crawl('slot-4', ORDER_TYPES.BUY, 9001)];
    manager._clearPendingFillCrawls('grid rebuild');
    assert.strictEqual(manager._pendingFillCrawls.length, 0,
        'a discarded generation has no geometry for the deltas to apply onto');
});

run('CRAWL-11 a fill re-anchor consumes the whole owed ledger at plan time', () => {
    // A capped derivation (crossChunkBudget 0) leaves every owed record
    // unconsumed, then the absolute fill anchor moves the boundary. If those
    // records stay owed, the next derivation applies them ON TOP of the
    // re-anchored boundary. The strategy must snapshot and consume them.
    const StrategyModule = require('../modules/order/strategy').default;
    const StrategyEngine = StrategyModule.default || StrategyModule.StrategyEngine || StrategyModule;
    const localSlots = LEVELS.map((price, idx) => ({
        id: `slot-${idx}`, price,
        type: idx <= 6 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL, size: 10, orderId: null,
    }));
    const manager: any = {
        _genesis: { priceLevels: LEVELS, startPrice: 100, incrementPercent: 1, gapSlots: 1 },
        _gapSlots: 1,
        _boundaryShiftBudget: 0,
        _pendingFillCrawls: [crawl('slot-3', ORDER_TYPES.SELL, 11000)],
        _lastFilledPrice: 105,
        _lastFilledType: ORDER_TYPES.SELL,
        lastFillPivotSource: 'fill',
        _lastMarketFillPrice: null,
        _lastMarketFillType: null,
        orders: new Map(localSlots.map((s) => [s.id, { ...s }])),
        config: {
            ...config,
            assetA: 'TEST', assetB: 'BTS',
            targetSpreadPercent: 2,
            weightDistribution: { buy: 1, sell: 1 },
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5, MIN_ORDER_SIZE_FACTOR: 50 },
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0,
        },
        assets: {
            assetA: { id: '1.3.0', precision: 6, symbol: 'TEST' },
            assetB: { id: '1.3.1', precision: 6, symbol: 'BTS' },
        },
        logger: { log: () => {} },
        _markGridDirty: () => {},
    };
    const strategy = new StrategyEngine(manager);
    const result = strategy.calculateTargetGrid({
        frozenMasterGrid: manager.orders,
        config: manager.config,
        accountAssets: manager.assets,
        funds: {
            allocatedBuy: 5000, allocatedSell: 500,
            chainFreeBuy: 5000, chainFreeSell: 500,
            btsBalance: { free: 100 },
        },
        fills: [],
        currentBoundaryIdx: 2,
    });
    assert.strictEqual(result.boundaryIdx, 4, `re-anchor must move 2 -> 4, got ${result.boundaryIdx}`);
    assert.deepStrictEqual(result.consumedCrawlIds,
        [{ slotId: 'slot-3', side: ORDER_TYPES.SELL, ts: 11000 }],
        'the absolute re-anchor must subsume the owed record at plan time');
});

console.log(`\nCRAWL-CONSUME summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * FILL-PATH MID VERIFICATION — REPLACED BY THE FILL-AUTHORITATIVE POLICY.
 *
 * The former suite pinned a forced book re-read before a cached mid could
 * veto a fill, refused-level markers and marker release. That policy is gone:
 * every fill is market truth. This suite now pins the replacement contract:
 *
 *   1. offMarketFill is neutral (always null) — no cached-mid comparison;
 *   2. verifyFillMarketReference is a no-op that never touches the client;
 *   3. fills arm the pivot regardless of how far/side they sit from a cached
 *      mid, and no marker writer runs on the fill path;
 *   4. the marker helpers are neutral stubs that never mutate a manager;
 *   5. the surviving book reader (maybeRefreshLiveMarketPrice) still belongs
 *      to the spread/market-price path, not fill intake.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    ORDER_TYPES,
} = require('../modules/constants');
const {
    verifyFillMarketReference,
    offMarketFill,
    fillOutsideMarket,
    setLastFillPivot,
    maybeRefreshLiveMarketPrice,
    releaseRefutedRefusedLevels,
    liveRefusedFillLevels,
    hasLiveRefusedFillLevels,
    fillEvidenceFromEconomics,
} = require('../modules/order/utils/system');
const { OrderManager } = require('../modules/order/manager');

let passed = 0;
let failed = 0;

async function run(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
}

const NOW = Date.now();
const FRESH_MID_AT = NOW - 5_000;

function makeManager(over: Record<string, unknown> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    return {
        _lastFilledPrice: null as number | null,
        _lastFilledType: null as string | null,
        _lastFilledAt: 0,
        lastFillPivotSource: null as string | null,
        _lastFilledBuyPrice: null as number | null,
        _lastFilledSellPrice: null as number | null,
        _lastMarketFillPrice: null as number | null,
        _lastMarketFillType: null as string | null,
        _lastMarketFillAt: 0,
        // Seeded legacy marker fields: the neutralized stubs must ignore them
        // and no fill-path writer may touch them.
        _lastRefusedFillPrice: null as number | null,
        _lastRefusedFillType: null as string | null,
        _lastRefusedFillAt: 0,
        _lastRefusedFillLevels: [] as Array<{ price: number; type: string; at: number }>,
        _liveMarketPrice: null as number | null,
        _liveMarketPriceAt: null as number | null,
        _liveMarketPriceAttemptedAt: null as number | null,
        orders: new Map<string, { price: number }>(),
        config: { incrementPercent: 0.3 },
        assets: {
            assetA: { symbol: 'BASE', precision: 5 },
            assetB: { symbol: 'QUOTE', precision: 5 }
        },
        accountOrders: {
            clearPersistedLastMarketFill: () => {},
            clearPersistedLastFillPivot: () => {}
        },
        // Borrow the real writer chain: recordLastFilledPrices -> _setLastFillPivot
        // -> setLastFillPivot, with no verification step in between.
        _setLastFillPivot(type: string, price: number, provenance: 'fill' | 'book', atMs?: number) {
            return setLastFillPivot(this, type, price, provenance, atMs);
        },
        recordLastFilledPrices: OrderManager.prototype.recordLastFilledPrices,
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        ...over
    };
}

/** A client whose every book surface explodes: any fill-path RPC is a failure. */
function poisonClient(calls: { n: number }) {
    return {
        db: {
            lookup_asset_symbols: async () => { calls.n++; throw new Error('fill path must not read the book'); },
            get_order_book: async () => { calls.n++; throw new Error('fill path must not read the book'); },
            get_ticker: async () => { calls.n++; throw new Error('fill path must not read the book'); }
        }
    };
}

async function main() {
    console.log('\n=== FILL-PATH MID VERIFICATION (fill-authoritative) ===\n');

    await run('MID-1 offMarketFill is neutral for stale, wrong-side and far fills', () => {
        const mgr: any = makeManager({
            _liveMarketPrice: 1739.237923,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        assert.strictEqual(offMarketFill(mgr, ORDER_TYPES.BUY, 1650), null, 'far BUY must not be vetoed');
        assert.strictEqual(offMarketFill(mgr, ORDER_TYPES.SELL, 1900), null, 'far SELL must not be vetoed');
        assert.strictEqual(offMarketFill(mgr, ORDER_TYPES.BUY, 1700), null, 'in-window BUY stays null');
        // The legacy explicit-mid classifier still exists for compatibility,
        // but no fill-path caller may use it. The neutral wrapper is the only
        // predicate left on the fill path.
        assert.ok(typeof fillOutsideMarket === 'function');
        const system = fs.readFileSync(path.join(__dirname, '../../modules/order/utils/system.ts'), 'utf8');
        assert.ok(!/offMarketFill\([^)]*fillOutsideMarket|fillOutsideMarket\([^)]*\)/.test(
            system.slice(system.indexOf('export function offMarketFill('), system.indexOf('export function offMarketFill(') + 400)),
            'offMarketFill must no longer delegate to the market-bound classifier');
    });

    await run('MID-2 verifyFillMarketReference is a no-op: no RPC, no cache mutation', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: 1739.237923,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        const fills = [
            { id: 'slot-1', type: ORDER_TYPES.BUY, price: 1650, isPartial: false },
            { id: 'slot-2', type: ORDER_TYPES.SELL, price: 1900, isPartial: false },
        ];
        const result = await verifyFillMarketReference(mgr, poisonClient(calls), fills, { now: NOW });
        assert.strictEqual(result, null, 'the no-op verifier reports no replacement mid');
        assert.strictEqual(calls.n, 0, 'the fill path must never touch the order-book client');
        assert.strictEqual(mgr._liveMarketPrice, 1739.237923, 'the cached mid is untouched');
        assert.strictEqual(mgr._fillMidVerifyAttemptedAt, undefined, 'no pacing clock is stamped');
    });

    await run('MID-3 a missing/throwable client is equally harmless on the fill path', async () => {
        const mgr: any = makeManager({ _liveMarketPrice: 1000, _liveMarketPriceAt: FRESH_MID_AT });
        assert.strictEqual(await verifyFillMarketReference(mgr, null, [{ type: ORDER_TYPES.SELL, price: 1200 }]), null);
        assert.strictEqual(await verifyFillMarketReference(mgr, { db: null }, []), null);
        assert.strictEqual(mgr.logs.length, 0, 'no warn/debug verification line belongs to a fill path');
    });

    await run('MID-4 the real fill writer arms the pivot far from a fresh cached mid', () => {
        const mgr: any = makeManager({
            _liveMarketPrice: 1000,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        // ~35 steps below mid and ~9 steps above mid: every one used to be
        // refused; every one now arms the guard and writes the market row.
        const fills = [
            { id: 'slot-1', type: ORDER_TYPES.BUY, price: 850, isPartial: false },
            { id: 'slot-2', type: ORDER_TYPES.SELL, price: 1500, isPartial: false }
        ];
        mgr.recordLastFilledPrices(fills);
        assert.strictEqual(mgr._lastFilledPrice, 1500, 'the last fill wins and arms the pivot');
        assert.strictEqual(mgr._lastFilledType, ORDER_TYPES.SELL);
        assert.strictEqual(mgr._lastMarketFillPrice, 1500, 'the market-fill reference follows the fill');
        assert.strictEqual(mgr._lastRefusedFillPrice, null, 'no refusal marker may be written');
        assert.deepStrictEqual(mgr._lastRefusedFillLevels, [], 'no per-level marker may be written');
        assert.ok(mgr.logs.some((l: any) => /\[FILL-PIVOT\]/.test(l.msg) && l.level === 'info'));
        assert.ok(!mgr.logs.some((l: any) => /Refusing to arm pivot/.test(l.msg)),
            'a fill can no longer be refused by a cached market price');
    });

    await run('MID-5 a gap-band fill arms the pivot (geometry skip removed)', () => {
        const mgr: any = makeManager({ boundaryIdx: 100, _gapSlots: 3 });
        mgr.recordLastFilledPrices([{ id: 'slot-101', type: ORDER_TYPES.BUY, price: 1650, isPartial: true }]);
        assert.strictEqual(mgr._lastFilledPrice, 1650, 'an in-band residual is still a real fill');
        assert.ok(!mgr.logs.some((l: any) => /band-skipped|gap-band \(stranded residual\)/.test(l.msg)),
            'the geometry filter must not log a skip');
    });

    await run('MID-6 marker helpers are neutral stubs that never write', () => {
        const marker = { price: 1650, type: ORDER_TYPES.BUY, at: NOW };
        const mgr: any = makeManager({
            _lastRefusedFillLevels: [marker],
            _lastRefusedFillPrice: marker.price,
            _lastRefusedFillType: marker.type,
            _lastRefusedFillAt: marker.at
        });
        assert.deepStrictEqual(liveRefusedFillLevels(mgr), [], 'no live refused levels exist');
        assert.strictEqual(hasLiveRefusedFillLevels(mgr), false, 'a marker is no longer fill evidence');
        assert.strictEqual(hasLiveRefusedFillLevels(mgr, ORDER_TYPES.BUY), false, 'side filter is neutral too');
        assert.strictEqual(releaseRefutedRefusedLevels(mgr, 1000, 1650), 0, 'there is nothing to release');
        assert.deepStrictEqual(mgr._lastRefusedFillLevels, [marker], 'the stub must not mutate a manager');
        assert.strictEqual(mgr._lastRefusedFillPrice, marker.price, 'the scalar mirror is untouched');
        assert.strictEqual(mgr.logs.length, 0, 'the stub must not log a release line');
    });

    await run('MID-7 fill intake has no verification call in the writer or the fill-batch path', () => {
        const system = fs.readFileSync(path.join(__dirname, '../../modules/order/utils/system.ts'), 'utf8');
        const writerStart = system.indexOf('export function setLastFillPivot(');
        assert.ok(writerStart > 0, 'the synchronous writer must exist');
        const writer = system.slice(writerStart, system.indexOf('\n}', writerStart) + 2);
        assert.ok(!/await\s/.test(writer), 'setLastFillPivot stays synchronous: no async verification inside it');
        assert.ok(!/verifyFillMarketReference|offMarketFill|RefusedFill/.test(writer),
            'the writer must not vet a fill through a market read or a marker');
        const cls = fs.readFileSync(path.join(__dirname, '../../modules/dexbot_class.ts'), 'utf8');
        assert.strictEqual(cls.split('verifyFillMarketReference(').length - 1, 0,
            'the fill-batch loop must not call the verifier');
        const mgrSrc = fs.readFileSync(path.join(__dirname, '../../modules/order/manager.ts'), 'utf8');
        assert.strictEqual(mgrSrc.split('verifyFillMarketReference(').length - 1, 0,
            'recordLastFilledPrices must not call the verifier');
    });

    await run('MID-8 rebuild re-arm accepts a row far from the cached mid', () => {
        const { rearmLastFillPivotFromMarketFill } = require('../modules/order/utils/system');
        const mgr: any = makeManager({
            _lastMarketFillPrice: 1500,
            _lastMarketFillType: ORDER_TYPES.SELL,
            _lastMarketFillAt: NOW - 60_000,
            _liveMarketPrice: 1000,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        assert.strictEqual(rearmLastFillPivotFromMarketFill(mgr), true,
            'rebuild re-arm uses the same fill-authoritative writer');
        assert.strictEqual(mgr._lastFilledPrice, 1500);
        assert.ok(!mgr.logs.some((l: any) => /Refusing to arm pivot/.test(l.msg)));
    });

    await run('MID-9 raw fill economics still share one evidence derivation', () => {
        const mgr: any = makeManager({
            assets: {
                assetA: { id: '1.3.101', symbol: 'BASE', precision: 5 },
                assetB: { id: '1.3.102', symbol: 'QUOTE', precision: 5 }
            }
        });
        const evidence = fillEvidenceFromEconomics(mgr, {
            paysAssetId: '1.3.102', paysAmountRaw: 169260256,
            receivesAssetId: '1.3.101', receivesAmountRaw: 100000
        });
        assert.ok(evidence, 'the evidence helper survives the removal of the veto');
        assert.strictEqual(evidence?.type, ORDER_TYPES.BUY);
        assert.ok(evidence && Math.abs(evidence.price - 1692.60256) < 1e-4, `unexpected price ${evidence?.price}`);
        assert.strictEqual(fillEvidenceFromEconomics(mgr, {
            paysAssetId: '1.3.102', paysAmountRaw: 169260256,
            receivesAssetId: '1.3.999', receivesAmountRaw: 100000
        }), null, 'a foreign asset still fails soft');
    });

    await run('MID-10 the shared price owner keeps its own pacing (not a fill gate)', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: 1000,
            _liveMarketPriceAt: 0,
            assets: {
                assetA: { id: '1.3.101', symbol: 'BASE', precision: 5 },
                assetB: { id: '1.3.102', symbol: 'QUOTE', precision: 5 }
            }
        });
        const client = {
            db: {
                lookup_asset_symbols: async (refs: string[]) => refs.map((r) => ({
                    id: r === 'BASE' ? '1.3.101' : '1.3.102',
                    precision: 5,
                })),
                get_order_book: async () => ({ bids: [], asks: [] }),
                get_ticker: async () => { calls.n++; return { latest: 1 / 1010 }; }
            }
        };
        const read = await maybeRefreshLiveMarketPrice(mgr, client, { now: NOW });
        assert.strictEqual(calls.n, 1, 'the market-price path may still read the book');
        assert.ok(read !== null && Math.abs(Number(read) - 1010) < 1e-4);
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});

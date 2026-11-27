/**
 * FILL-PATH MID VERIFICATION — SURFACE REMOVED UNDER THE FILL-AUTHORITATIVE POLICY.
 *
 * The former suite pinned a forced book re-read, a cached-mid veto and refused
 * level markers. That whole compatibility surface is now gone: a fill is
 * market truth, so no fill-path classifier or verifier is exported at all.
 * This suite pins the replacement contract:
 *
 *   1. the verification helpers, refused-level stubs and fill-mid timing knobs
 *      are absent from the code (not merely neutral);
 *   2. the fill writer arms the pivot regardless of how far/side it sits from a
 *      cached mid, with no market RPC and no marker branch;
 *   3. rebuild re-arm and raw-fill evidence share the same single owners;
 *   4. the surviving book reader belongs to the spread/market-price path only.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    ORDER_TYPES,
    TIMING,
} = require('../modules/constants');
const {
    setLastFillPivot,
    maybeRefreshLiveMarketPrice,
    refreshLiveMarketPrice,
    fillEvidenceFromEconomics,
    rearmLastFillPivotFromMarketFill,
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

const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
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

async function main() {
    console.log('\n=== FILL-PATH MID VERIFICATION (removed surface) ===\n');

    await run('MID-1 no fill classifier, verifier or marker helper is exported', () => {
        const system = read('modules/order/utils/system.ts');
        for (const name of [
            'offMarketFill', 'fillOutsideMarket', 'verifyFillMarketReference',
            'resolveFillMidVerifyMs', 'releaseRefutedRefusedLevels',
            'liveRefusedFillLevels', 'hasLiveRefusedFillLevels',
        ]) {
            assert.ok(!new RegExp(`export (?:async )?function ${name}\\(`).test(system),
                `${name} must no longer be exported`);
        }
        assert.ok(!/export interface RefusedFillLevel\b/.test(system), 'the marker type is gone too');
        assert.ok(!/_fillMidVerifyAttemptedAt|LAST_FILL_MID_VERIFY_/.test(system),
            'no fill-mid pacing clock or knob remains in the price owner');
        const exported = require('../modules/order/utils/system');
        for (const name of [
            'offMarketFill', 'fillOutsideMarket', 'verifyFillMarketReference',
            'resolveFillMidVerifyMs', 'releaseRefutedRefusedLevels',
            'liveRefusedFillLevels', 'hasLiveRefusedFillLevels',
        ]) {
            assert.strictEqual(exported[name], undefined, `${name} is absent at runtime`);
        }
    });

    await run('MID-2 fill-mid timing knobs are gone from TIMING and its policy', () => {
        assert.ok(!('LAST_FILL_MID_VERIFY_MS' in TIMING), 'pacing knob removed');
        assert.ok(!('LAST_FILL_MID_VERIFY_TIMEOUT_MS' in TIMING), 'per-read cap knob removed');
        const policy = read('modules/timing_policy.ts');
        assert.ok(!/LAST_FILL_MID_VERIFY_/.test(policy), 'no classification for removed knobs');
        const manager = read('modules/order/manager.ts');
        const types = read('modules/types.ts');
        assert.ok(!/_fillMidVerifyAttemptedAt/.test(manager + types), 'no pacing clock field survives');
    });

    await run('MID-3 deriveTargetBoundary has no fill-eligibility parameter', () => {
        const src = read('modules/order/utils/order.ts');
        const start = src.indexOf('function deriveTargetBoundary(');
        assert.ok(start > 0, 'the boundary derivation must exist');
        const signature = src.slice(start, src.indexOf('\n', start));
        assert.ok(!/isFillEligibleForCrawl/.test(signature), 'no optional predicate parameter');
        assert.ok(!/isFillEligibleForCrawl/.test(src), 'no predicate check remains anywhere');
        const strategy = read('modules/order/strategy.ts');
        const call = strategy.slice(strategy.indexOf('deriveTargetBoundary(fills'));
        assert.ok(!/isFillEligibleForCrawl|offMarketFill/.test(call.slice(0, call.indexOf(';'))),
            'the live call site injects no market predicate');
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

    await run('MID-6 fill intake has no verification call in the writer or the fill-batch path', () => {
        const system = read('modules/order/utils/system.ts');
        const writerStart = system.indexOf('export function setLastFillPivot(');
        assert.ok(writerStart > 0, 'the synchronous writer must exist');
        const writer = system.slice(writerStart, system.indexOf('\n}', writerStart) + 2);
        assert.ok(!/await\s/.test(writer), 'setLastFillPivot stays synchronous: no async verification inside it');
        assert.ok(!/verifyFillMarketReference|offMarketFill|RefusedFill/.test(writer),
            'the writer must not vet a fill through a market read or a marker');
        for (const rel of ['modules/dexbot_class.ts', 'modules/order/manager.ts',
            'modules/dexbot_cow_runtime.ts', 'modules/dexbot_fill_runtime.ts',
            'modules/order/sync_engine.ts']) {
            assert.ok(!/verifyFillMarketReference|offMarketFill|fillOutsideMarket/.test(read(rel)),
                `${rel} must not reference a removed fill classifier`);
        }
    });

    await run('MID-7 rebuild re-arm accepts a row far from the cached mid', () => {
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

    await run('MID-8 raw fill economics still share one evidence derivation', () => {
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

    await run('MID-9 the shared price owner keeps its own pacing (not a fill gate)', async () => {
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
        const readPrice = await maybeRefreshLiveMarketPrice(mgr, client, { now: NOW });
        assert.strictEqual(calls.n, 1, 'the market-price path may still read the book');
        assert.ok(readPrice !== null && Math.abs(Number(readPrice) - 1010) < 1e-4);
        // No force/didRead surface is left on the shared reader.
        const src = read('modules/order/utils/system.ts');
        const sig = src.slice(src.indexOf('export async function maybeRefreshLiveMarketPrice('));
        assert.ok(!/force|didRead/.test(sig.slice(0, sig.indexOf('): Promise'))),
            'the price owner has no forced-read branch');
    });

    await run('MID-10 a late book result cannot overwrite the cache after its read was released', async () => {
        const mgr: any = makeManager({
            _liveMarketPrice: 1000,
            _liveMarketPriceAt: 123,
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
                get_ticker: async () => ({ latest: 1 / 1010 })
            }
        };
        // A released read still runs to completion, but it neither reports a
        // fresh price nor mutates the cache a newer attempt may have written.
        const price = await refreshLiveMarketPrice(mgr, client, () => false);
        assert.strictEqual(price, null, 'a released read reports no new price');
        assert.strictEqual(mgr._liveMarketPrice, 1000, 'the cache was not overwritten');
        assert.strictEqual(mgr._liveMarketPriceAt, 123, 'the cache timestamp was not overwritten');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});

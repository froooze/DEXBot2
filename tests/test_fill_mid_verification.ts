/**
 * FILL-PATH MID VERIFICATION (verify-before-veto).
 *
 * A cached live market price can be seconds old yet wrong in value after a
 * fast move. offMarketFill would then classify an entire market sweep as
 * premium fills, mark their levels for the refused-level TTL and suppress
 * every re-place — the 2026-11-26 live market-pair incident. The fix moves
 * the independent book read to just before the veto:
 *
 *   1. in-window fill batches cost no RPC;
 *   2. an off-market candidate forces ONE book re-read (paced, no storm);
 *   3. after the fresh read the existing setLastFillPivot policy decides —
 *      a fill inside the new bound arms the guard, one still outside is
 *      refused and marked exactly as before;
 *   4. markers a stale mid wrote are released only where the fresh mid
 *      refutes them; markers still off-market stay;
 *   5. a failing book read leaves the cached-mid veto policy unchanged;
 *   6. the wiring runs once per fill chunk BEFORE recordLastFilledPrices.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    ORDER_TYPES,
    GRID_LIMITS,
    TIMING,
} = require('../modules/constants');
const {
    verifyFillMarketReference,
    resolveFillMidVerifyMs,
    fillEvidenceFromEconomics,
    releaseRefutedRefusedLevels,
    setLastFillPivot,
    maybeRefreshLiveMarketPrice,
    offMarketFill,
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
const NEW_MID = 1702.757506;
const OLD_MID = 1739.2379234351336;

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
        // Borrow the real writer chain so tests exercise recordLastFilledPrices
        // -> _setLastFillPivot -> setLastFillPivot instead of calling the low-
        // level writer by hand.
        _setLastFillPivot(type: string, price: number, provenance: 'fill' | 'book', atMs?: number) {
            return setLastFillPivot(this, type, price, provenance, atMs);
        },
        recordLastFilledPrices: OrderManager.prototype.recordLastFilledPrices,
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        logs,
        ...over
    };
}

/** Minimal order-book client: deriveMarketPrice returns 1 / ticker.latest. */
function makeClient(latest: number | (() => number), calls: { n: number }) {
    return {
        db: {
            lookup_asset_symbols: async (refs: string[]) => refs.map((r) => ({
                id: String(r) === 'BASE' ? '1.3.101' : '1.3.102',
                precision: 5
            })),
            get_order_book: async () => ({ bids: [], asks: [] }),
            get_ticker: async () => {
                calls.n++;
                return { latest: 1 / (typeof latest === 'function' ? latest() : latest) };
            }
        }
    };
}

async function main() {
    console.log('\n=== FILL-PATH MID VERIFICATION ===\n');

    await run('MID-1 in-window batch makes no RPC', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: NEW_MID,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        const fills = [{ id: 'slot-142', type: ORDER_TYPES.BUY, price: 1700, isPartial: false }];
        assert.strictEqual(offMarketFill(mgr, ORDER_TYPES.BUY, 1700), null, 'fixture fill must be in-window');
        const result = await verifyFillMarketReference(mgr, makeClient(NEW_MID, calls), fills);
        assert.strictEqual(result, null, 'no re-read was needed');
        assert.strictEqual(calls.n, 0, 'the book must not be read for an in-window batch');
    });

    await run('MID-2 off-market candidate forces one re-read; fresh mid arms the pivot', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        // The fill was a genuine window trade at the NEW mid but ~10 steps
        // away from the stale cached mid.
        const fills = [{ id: 'slot-140', type: ORDER_TYPES.BUY, price: 1692.602556, isPartial: true }];
        assert.ok(offMarketFill(mgr, ORDER_TYPES.BUY, 1692.602556), 'fixture must be vetoed by the stale mid');
        const result = await verifyFillMarketReference(mgr, makeClient(NEW_MID, calls), fills, { now: NOW });
        assert.strictEqual(calls.n, 1, 'exactly one book read expected');
        assert.ok(result !== null && Math.abs(Number(result) - NEW_MID) < 1e-4, `fresh mid expected, got ${result}`);
        assert.strictEqual(offMarketFill(mgr, ORDER_TYPES.BUY, 1692.602556), null, 'fresh mid must accept the fill');
        // Go through the REAL pivot writer chain, not a hand-written call:
        // the freshness gate must influence recordLastFilledPrices' decision.
        mgr.recordLastFilledPrices(fills);
        assert.strictEqual(mgr._lastFilledPrice, 1692.602556,
            'the real fill-batch writer must arm the pivot against the fresh mid');
        assert.strictEqual(mgr._lastRefusedFillLevels.length, 0, 'no refused level should be written');
        assert.ok(mgr.logs.some((l: any) => /Live mid re-verified:/.test(l.msg) && l.level === 'info'));
    });

    await run('MID-3 a fill still off-market after the re-read stays refused and marked', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        // 1650 is ~35 steps below the fresh mid too — a true premium sweep.
        const fills = [{ id: 'slot-130', type: ORDER_TYPES.BUY, price: 1650, isPartial: true }];
        await verifyFillMarketReference(mgr, makeClient(NEW_MID, calls), fills, { now: NOW });
        assert.ok(offMarketFill(mgr, ORDER_TYPES.BUY, 1650), 'the fresh mid must still refuse this fill');
        mgr.recordLastFilledPrices(fills);
        assert.strictEqual(mgr._lastFilledPrice, null, 'the real writer must refuse to arm on a genuine premium sweep');
        assert.strictEqual(mgr._lastRefusedFillLevels.length, 1, 'the premium-sweep marker must still be written');
        assert.strictEqual(mgr._lastRefusedFillPrice, 1650, 'legacy mirror stays in sync');
    });

    await run('MID-4 fresh mid releases only the markers it refutes', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT,
            _lastRefusedFillLevels: [
                { price: 1703.361252, type: ORDER_TYPES.BUY, at: NOW - 1_000 }, // inside bound at NEW_MID
                { price: 1698.243080, type: ORDER_TYPES.BUY, at: NOW - 2_000 }, // inside bound at NEW_MID
                { price: 1640, type: ORDER_TYPES.BUY, at: NOW - 3_000 },        // still off-market
            ],
            _lastRefusedFillPrice: 1703.361252,
            _lastRefusedFillType: ORDER_TYPES.BUY,
            _lastRefusedFillAt: NOW - 1_000
        });
        // A fill still off-market forces the read; the marker release is a side effect.
        await verifyFillMarketReference(mgr, makeClient(NEW_MID, calls), [{ type: ORDER_TYPES.BUY, price: 1640 }], { now: NOW });
        assert.strictEqual(calls.n, 1);
        const remaining = mgr._lastRefusedFillLevels.map((e: any) => e.price);
        assert.deepStrictEqual(remaining, [1640], `only the still-off-market level must survive (got ${remaining})`);
        assert.strictEqual(mgr._lastRefusedFillPrice, null, 'the released scalar mirror must not resurrect a marker');
        assert.ok(mgr.logs.some((l: any) => /Released 2 refused level\(s\) refuted by fresh market mid/.test(l.msg)));
    });

    await run('MID-5 a failing book read leaves the cached-mid veto unchanged', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        const broken = {
            db: {
                lookup_asset_symbols: async () => { calls.n++; return []; },
                get_order_book: async () => ({ bids: [], asks: [] }),
                get_ticker: async () => { calls.n++; return {}; }
            }
        };
        const result = await verifyFillMarketReference(mgr, broken, [{ type: ORDER_TYPES.BUY, price: 1692 }], { now: NOW });
        assert.strictEqual(result, null, 'a failed read must report no usable price');
        assert.strictEqual(mgr._liveMarketPrice, OLD_MID, 'the cached price is retained');
        assert.ok(offMarketFill(mgr, ORDER_TYPES.BUY, 1692), 'cached-mid veto policy stays intact');
        assert.ok(mgr.logs.some((l: any) => /could not re-verify the live mid/.test(l.msg) && l.level === 'warn'));
    });

    await run('MID-6 forced reads are paced; normal mode keeps its fresh-cache shortcut', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        const client = makeClient(NEW_MID, calls);
        await verifyFillMarketReference(mgr, client, [{ type: ORDER_TYPES.BUY, price: 1692 }], { now: NOW });
        assert.strictEqual(calls.n, 1);
        // Same fill again, inside the short verification pacing window.
        const paced = await maybeRefreshLiveMarketPrice(mgr, client, { force: true, now: NOW + 1_000 });
        assert.strictEqual(calls.n, 1, 'a second forced read inside the pacing window must not hit the chain');
        assert.strictEqual(Number(paced), NEW_MID, 'paced-out force returns the cached (already refreshed) price');
        // Normal (non-force) path: fresh cache short-circuits regardless of pace.
        const normal = await maybeRefreshLiveMarketPrice(mgr, client, { now: NOW + 1_000 });
        assert.strictEqual(calls.n, 1);
        assert.strictEqual(Number(normal), NEW_MID);
    });

    await run('MID-7 wiring: verified once per chunk before the pivot is stamped', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'modules', 'dexbot_class.ts'), 'utf8');
        const verifyAt = src.indexOf('await verifyFillMarketReference(');
        const stampAt = src.indexOf('recordLastFilledPrices?.(fillBatch)');
        assert.ok(verifyAt > 0, 'the fill path must call verifyFillMarketReference');
        assert.ok(stampAt > verifyAt, 'verification must run BEFORE recordLastFilledPrices');
        const chunk = src.slice(verifyAt - 800, verifyAt);
        assert.ok(/fillBatch/.test(chunk), 'verification must be inside the per-chunk loop');
    });

    await run('MID-8 release helper fails open on an unusable mid', () => {
        const mgr: any = makeManager({
            _lastRefusedFillLevels: [{ price: 1703, type: ORDER_TYPES.BUY, at: NOW }]
        });
        assert.strictEqual(releaseRefutedRefusedLevels(mgr, OLD_MID, NaN), 0);
        assert.strictEqual(releaseRefutedRefusedLevels(mgr, OLD_MID, 0), 0);
        assert.strictEqual(releaseRefutedRefusedLevels(mgr, 0, NEW_MID), 0);
        assert.strictEqual(mgr._lastRefusedFillLevels.length, 1, 'nothing may be released without two real mids');
    });

    await run('MID-9 sub-step mid noise does not release a sweep marker', async () => {
        const calls = { n: 0 };
        const marker = OLD_MID * 1.0002;
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT,
            _lastRefusedFillLevels: [{ price: marker, type: ORDER_TYPES.BUY, at: NOW - 1_000 }],
            _lastRefusedFillPrice: marker,
            _lastRefusedFillType: ORDER_TYPES.BUY,
            _lastRefusedFillAt: NOW - 1_000
        });
        // 0.01% is far below one 0.3% grid step: the marker's classification
        // must survive even though the fresh mid technically moved.
        await verifyFillMarketReference(mgr, makeClient(OLD_MID * 1.0001, calls), [{ type: ORDER_TYPES.BUY, price: OLD_MID * 1.01 }], { now: NOW });
        assert.strictEqual(calls.n, 1, 'the off-market candidate must still force a read');
        assert.strictEqual(mgr._lastRefusedFillLevels.length, 1, 'sub-step noise must not release the marker');
        assert.strictEqual(mgr._lastRefusedFillPrice, marker);
        assert.ok(mgr.logs.some((l: any) => /released 0 refused level/.test(l.msg)));
    });

    await run('MID-10 raw fill economics use the shared evidence derivation', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT,
            assets: {
                assetA: { id: '1.3.101', symbol: 'BASE', precision: 5 },
                assetB: { id: '1.3.102', symbol: 'QUOTE', precision: 5 }
            }
        });
        const raw = {
            paysAssetId: '1.3.102', paysAmountRaw: 169260256,
            receivesAssetId: '1.3.101', receivesAmountRaw: 100000
        };
        const evidence = fillEvidenceFromEconomics(mgr, raw);
        assert.ok(evidence, 'the shared helper must derive evidence from raw economics');
        assert.strictEqual(evidence?.type, ORDER_TYPES.BUY);
        assert.ok(evidence && Math.abs(evidence.price - 1692.60256) < 1e-4, `unexpected price ${evidence?.price}`);
        // The verifier judges the SAME derived evidence, not a caller-local copy.
        await verifyFillMarketReference(mgr, makeClient(NEW_MID, calls), [raw], { now: NOW });
        assert.strictEqual(calls.n, 1, 'the raw fill is off-market against the stale mid');
        assert.strictEqual(Number(mgr._liveMarketPrice), NEW_MID);
    });

    await run('MID-11 forced verification has its own pacing clock', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: NOW - 11 * 60_000 // stale for the 10min spread path, fresh for the 15min veto bound
        });
        // A failed NON-forced attempt (spread path) stamps the shared clock.
        const failing = { db: { lookup_asset_symbols: async () => { calls.n++; return []; }, get_order_book: async () => ({ bids: [], asks: [] }), get_ticker: async () => ({}) } };
        await maybeRefreshLiveMarketPrice(mgr, failing, { now: NOW });
        assert.ok(calls.n > 0, 'the failed spread attempt must actually hit the client');
        const beforeCount = calls.n;
        // The forced fill verification must still be allowed to re-read.
        await verifyFillMarketReference(mgr, makeClient(NEW_MID, calls), [{ type: ORDER_TYPES.BUY, price: 1692 }], { now: NOW + 1_000 });
        assert.ok(calls.n > beforeCount, 'a failed spread read must not pace out the fill gate');
        assert.strictEqual(Number(mgr._liveMarketPrice), NEW_MID);
    });

    await run('MID-12 pacing fallback is never unbounded', () => {
        const mgr: any = makeManager({
            config: { incrementPercent: 0.3, timing: { SPREAD_CORRECTION_SYNC_FRESH_MS: 0, LAST_FILL_MID_VERIFY_MS: 0 } }
        });
        assert.ok(resolveFillMidVerifyMs(mgr) > 0, 'zeroed knobs must still yield a bounded pace');
        const overridden: any = makeManager({ config: { incrementPercent: 0.3, timing: { LAST_FILL_MID_VERIFY_MS: 1234 } } });
        assert.strictEqual(resolveFillMidVerifyMs(overridden), 1234, 'per-bot override wins');
    });

    await run('MID-13 marker release classifies against the passed mid, not the cache', () => {
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _lastRefusedFillLevels: [
                { price: 1703, type: ORDER_TYPES.BUY, at: NOW - 1_000 },
                { price: 1650, type: ORDER_TYPES.BUY, at: NOW - 2_000 }
            ]
        });
        const released = releaseRefutedRefusedLevels(mgr, OLD_MID, NEW_MID);
        assert.strictEqual(released, 1, 'only the level inside the passed mid is released');
        assert.deepStrictEqual(mgr._lastRefusedFillLevels.map((e: any) => e.price), [1650]);
        assert.strictEqual(mgr._liveMarketPrice, OLD_MID, 'release must not mutate the price cache');
    });

    await run('MID-14 economics helper tolerates a missing receives id and bad precision', () => {
        const mgr: any = makeManager({
            assets: {
                assetA: { id: '1.3.101', symbol: 'BASE', precision: 5 },
                assetB: { id: '1.3.102', symbol: 'QUOTE', precision: 5 }
            }
        });
        const inferred = fillEvidenceFromEconomics(mgr, {
            paysAssetId: '1.3.102', paysAmountRaw: 169260256, receivesAmountRaw: 100000
        });
        assert.ok(inferred && Math.abs(inferred.price - 1692.60256) < 1e-4,
            `missing receives id must use the opposite asset (${inferred?.price})`);
        const broken: any = makeManager({
            assets: { assetA: { id: '1.3.101', precision: 'bad' }, assetB: { id: '1.3.102', precision: 5 } }
        });
        assert.strictEqual(fillEvidenceFromEconomics(broken, {
            paysAssetId: '1.3.102', paysAmountRaw: 169260256, receivesAssetId: '1.3.101', receivesAmountRaw: 100000
        }), null, 'malformed precision must return null, never throw');
    });

    await run('MID-15 a present but foreign receives id fails soft', () => {
        const mgr: any = makeManager({
            assets: {
                assetA: { id: '1.3.101', precision: 5 },
                assetB: { id: '1.3.102', precision: 5 }
            }
        });
        assert.strictEqual(fillEvidenceFromEconomics(mgr, {
            paysAssetId: '1.3.102', paysAmountRaw: 169260256,
            receivesAssetId: '1.3.999', receivesAmountRaw: 100000
        }), null, 'a third-asset receives id must not be reinterpreted as the pair asset');
        // Same-pays/receives is malformed too: resolveExecutionPrice fails closed.
        assert.strictEqual(fillEvidenceFromEconomics(mgr, {
            paysAssetId: '1.3.102', paysAmountRaw: 169260256,
            receivesAssetId: '1.3.102', receivesAmountRaw: 100000
        }), null, 'pays === receives must fail soft, not fabricate a price');
    });

    await run('MID-16 marker release also runs on the time-based spread read', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: NOW - 11 * 60_000, // stale for the 10min spread window
            _lastRefusedFillLevels: [
                { price: 1703, type: ORDER_TYPES.BUY, at: NOW - 1_000 }, // refuted by NEW_MID
                { price: 1640, type: ORDER_TYPES.BUY, at: NOW - 2_000 }  // still off-market
            ],
            _lastRefusedFillPrice: 1703,
            _lastRefusedFillType: ORDER_TYPES.BUY,
            _lastRefusedFillAt: NOW - 1_000
        });
        // No fill candidate, no forced read: this is the ordinary spread path.
        const refreshed = await maybeRefreshLiveMarketPrice(mgr, makeClient(NEW_MID, calls), { now: NOW });
        assert.strictEqual(calls.n, 1, 'the stale spread cache must be refreshed');
        assert.ok(refreshed !== null && Math.abs(Number(refreshed) - NEW_MID) < 1e-4);
        assert.deepStrictEqual(mgr._lastRefusedFillLevels.map((e: any) => e.price), [1640],
            'the recovered level must be released even though no fill re-entered the veto gate');
        assert.strictEqual(mgr._lastRefusedFillPrice, null, 'scalar mirror must not resurrect it');
    });

    await run('MID-17 a missing client does not pace out the next forced read', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT
        });
        const fill = [{ type: ORDER_TYPES.BUY, price: 1692 }];
        const noClient = await verifyFillMarketReference(mgr, { db: null }, fill, { now: NOW });
        assert.strictEqual(noClient, null, 'no client => no verification');
        assert.strictEqual(mgr._fillMidVerifyAttemptedAt, undefined,
            'a client-less attempt must not stamp the forced pacing clock');
        const ok = await verifyFillMarketReference(mgr, makeClient(NEW_MID, calls), fill, { now: NOW + 1 });
        assert.strictEqual(calls.n, 1, 'the next real read must not be paced out');
        assert.ok(ok !== null && Math.abs(Number(ok) - NEW_MID) < 1e-4);
    });

    await run('MID-18 a slow book read is capped and a late result cannot write', async () => {
        const calls = { n: 0 };
        const mgr: any = makeManager({
            _liveMarketPrice: OLD_MID,
            _liveMarketPriceAt: FRESH_MID_AT,
            config: { incrementPercent: 0.3, timing: { LAST_FILL_MID_VERIFY_TIMEOUT_MS: 25 } }
        });
        let unblock: ((value: unknown) => void) | null = null;
        const stalled = new Promise((resolve) => { unblock = resolve; });
        const hanging = {
            db: {
                lookup_asset_symbols: () => { calls.n++; return stalled; },
                get_order_book: async () => ({ bids: [], asks: [] }),
                get_ticker: async () => ({ latest: 1 / NEW_MID })
            }
        };
        const result = await verifyFillMarketReference(mgr, hanging, [{ type: ORDER_TYPES.BUY, price: 1692 }], { now: NOW });
        assert.ok(calls.n >= 1, 'the stalled asset lookup must be attempted');
        assert.strictEqual(result, null, 'a timed-out read reports no usable price');
        assert.strictEqual(mgr._liveMarketPrice, OLD_MID, 'the cached-mid veto policy is retained');
        // Complete the abandoned read with a valid price: it must NOT mutate
        // the cache after the caller already decided on the cached mid.
        (unblock as unknown as (v: unknown) => void)([
            { id: '1.3.101', precision: 5 }, { id: '1.3.102', precision: 5 }
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(mgr._liveMarketPrice, OLD_MID, 'a late read must not bypass the price owner');
    });

    await run('MID-19 the one-step release guard lives in the helper itself', () => {
        const mgr: any = makeManager({
            _lastRefusedFillLevels: [{ price: 1703, type: ORDER_TYPES.BUY, at: NOW }]
        });
        assert.strictEqual(releaseRefutedRefusedLevels(mgr, OLD_MID, OLD_MID * 1.0001), 0,
            'sub-step noise must not free a marker even for a direct caller');
        assert.strictEqual(releaseRefutedRefusedLevels(mgr, OLD_MID, NEW_MID), 1,
            'a full-grid-step move must free it');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});

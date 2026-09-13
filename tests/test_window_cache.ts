const assert = require('assert');

console.log('Running window_cache pruning tests');

const {
    findMissingBucketRanges,
    planWindowReuse,
    pruneImmutableGaps,
    persistCacheChunk,
    readCacheChunk,
    loadBucketCache,
    unionQueriedRanges,
    rangesCoveredBy,
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    shardPathFor,
    buildFetchWindowsFromRange,
    runCachedWindows,
} = require('../market_adapter/inputs/window_cache');

const H = 3600 * 1000;
// Fixed "now" so the 7-day immutability horizon is deterministic.
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
// Old window: 2026-07-10 -> 2026-07-17 (fully past the lag horizon).
const WGTE = Date.UTC(2026, 6, 10, 0, 0, 0);
const WLTE = Date.UTC(2026, 6, 17, 0, 0, 0);

function candle(ts: number) {
    return [ts, 1, 1, 1, 1, 0];
}

function hourly(fromMs: number, toMs: number) {
    const out: number[] = [];
    for (let ts = fromMs; ts <= toMs; ts += H) out.push(ts);
    return out;
}

function gridCandles(fromMs: number, toMs: number) {
    return hourly(fromMs, toMs).map(candle);
}

// Local buckets on both sides of an interior old gap (Jul-12..Jul-13).
function interiorGapCache(queried: { gte: number; lte: number }[]) {
    const have = [
        ...hourly(WGTE, WGTE + H),
        ...hourly(WGTE + 4 * 24 * H, WLTE),
    ];
    const byTs = new Map();
    for (const h of have) byTs.set(h, candle(h));
    return {
        localCache: {
            byTs,
            files: 1,
            fileCover: [{ gte: WGTE, lte: WLTE, count: have.length, queried }],
        },
        have,
    };
}

{
    // Interior old gap never actually queried: the file's overall range
    // covers it, but queriedRanges do not -> must be KEPT (re-queried).
    // Before the queriedRanges fix this was wrongly pruned.
    const { localCache, have } = interiorGapCache([
        { gte: WGTE, lte: WGTE + H },
        { gte: WGTE + 4 * 24 * H, lte: WLTE },
    ]);
    const raw = findMissingBucketRanges(WGTE, WLTE, H, new Set(have));
    const pruned = pruneImmutableGaps(raw, WLTE, localCache.fileCover, NOW);
    assert.strictEqual(pruned.length, 1, `interior never-queried gap must survive pruning, got ${JSON.stringify(pruned)}`);
    assert.strictEqual(pruned[0].gte, WGTE + 2 * H, 'gap starts at first missing bucket');
    assert.strictEqual(pruned[0].lte, WGTE + 4 * 24 * H - H, 'gap ends at last missing bucket');

    // Same expectation through the planner entry point.
    const plan = planWindowReuse(localCache, {
        gteMs: WGTE, lteMs: WLTE, bucketMs: H,
        isTail: false, allowSubFetch: true, nowMs: NOW,
    });
    assert.strictEqual(plan.missing.length, 1, `planner must keep the never-queried gap, got ${JSON.stringify(plan.missing)}`);
    assert.strictEqual(plan.missing[0].gte, WGTE + 2 * H);
}

{
    // Same gap, but actually queried before -> still pruned (no regression).
    const { localCache, have } = interiorGapCache([{ gte: WGTE, lte: WLTE }]);
    const raw = findMissingBucketRanges(WGTE, WLTE, H, new Set(have));
    const pruned = pruneImmutableGaps(raw, WLTE, localCache.fileCover, NOW);
    assert.strictEqual(pruned.length, 0, `actually-queried interior gap must be pruned, got ${JSON.stringify(pruned)}`);

    const plan = planWindowReuse(localCache, {
        gteMs: WGTE, lteMs: WLTE, bucketMs: H,
        isTail: false, allowSubFetch: true, nowMs: NOW,
    });
    assert.strictEqual(plan.missing.length, 0, 'planner must prune the actually-queried gap');
}


{
    // Round trip through real cache files in a temp dir: a sub-fetch-style
    // meta yields exactly its narrow queriedRanges in fileCover, while a
    // legacy meta without the field falls back to the full timeRange
    // (pre-fix files were full-fetch only, so the claim is exact).
    // Run-relative *.chunk_* files classify as legacy; month shards classify
    // as shards.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-'));
    try {
        const out = path.join(dir, 'feed_x_1h.json');
        const qgte = Date.parse('2026-07-20T00:00:00.000Z');
        const qlte = Date.parse('2026-07-22T00:00:00.000Z');
        persistCacheChunk(
            path.join(dir, 'feed_x_1h.chunk_01_2026-07-10_2026-08-10.json'),
            { feed: 'x', timeRange: { gte: '2026-07-10T00:00:00.000Z', lte: '2026-08-10T00:00:00.000Z' }, queriedRanges: [{ gte: qgte, lte: qlte }] },
            [[qgte, 1, 1, 1, 1, 0]],
        );
        persistCacheChunk(
            path.join(dir, 'feed_x_1h.chunk_02_2026-06-10_2026-07-10.json'),
            { feed: 'x', timeRange: { gte: '2026-06-10T00:00:00.000Z', lte: '2026-07-10T00:00:00.000Z' } },
            [],
        );
        persistCacheChunk(
            shardPathFor(out, '2026-07'),
            { feed: 'x', shard: '2026-07', timeRange: { gte: '2026-07-01T00:00:00.000Z', lte: '2026-08-01T00:00:00.000Z' }, queriedRanges: [{ gte: qgte, lte: qlte }] },
            [[qgte, 1, 1, 1, 1, 7]],
        );
        const isMatch = () => true;
        const cache = loadBucketCache(out, {}, isMatch);
        assert.strictEqual(cache.files, 3, 'all three cache files load');
        assert.strictEqual(cache.legacy.length, 2, 'run-relative files classify as legacy');
        assert.strictEqual(cache.shards.length, 1, 'month file classifies as a shard');
        assert.strictEqual(cache.shards[0].shardKey, '2026-07', 'shard key survives the round trip');
        const narrow = cache.fileCover.find((f: any) => f.count === 1);
        assert.deepStrictEqual(narrow.queried, [{ gte: qgte, lte: qlte }], 'narrow queriedRanges survive the round trip');
        const legacy = cache.fileCover.find((f: any) => f.count === 0);
        assert.deepStrictEqual(
            legacy.queried,
            [{ gte: Date.parse('2026-06-10T00:00:00.000Z'), lte: Date.parse('2026-07-10T00:00:00.000Z') }],
            'legacy meta without the field falls back to its timeRange',
        );

        // Scoped load: a narrow request opens only overlapping files —
        // disjoint history is never even read.
        const scoped = loadBucketCache(out, {}, isMatch, {
            gte: Date.parse('2026-07-19T00:00:00.000Z'),
            lte: Date.parse('2026-07-21T00:00:00.000Z'),
        });
        assert.strictEqual(scoped.files, 2, `scoped load opens only overlapping files, got ${scoped.files}`);
        assert.ok(!scoped.legacy.some((l: any) => l.file.includes('2026-06-10_2026-07-10')),
            'disjoint legacy file is not loaded');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

{
    // Regression: 5 stray boundary buckets from the NEXT window's file sat
    // at the end of this old window (real incident: a whole month certified
    // "nothing missing" from 5 stray buckets while hundreds of live hours
    // went unfetched). Buckets before the first local one
    // are not proven empty by anything -> the whole leading range must be
    // kept for querying.
    const strays = hourly(WLTE - 4 * H, WLTE);
    const byTs = new Map();
    for (const h of strays) byTs.set(h, candle(h));
    const localCache = {
        byTs,
        files: 1,
        fileCover: [{ gte: WGTE, lte: WLTE, count: strays.length, queried: [] }],
    };
    const raw = findMissingBucketRanges(WGTE, WLTE, H, new Set(strays));
    const pruned = pruneImmutableGaps(raw, WLTE, localCache.fileCover, NOW);
    assert.strictEqual(pruned.length, 1, `stray-anchored leading range must survive pruning, got ${JSON.stringify(pruned)}`);
    assert.strictEqual(pruned[0].gte, WGTE, 'gap starts at the window start');
    assert.strictEqual(pruned[0].lte, WLTE - 5 * H, 'gap ends before the first stray bucket');

    const plan = planWindowReuse(localCache, {
        gteMs: WGTE, lteMs: WLTE, bucketMs: H,
        isTail: false, allowSubFetch: true, nowMs: NOW,
    });
    assert.ok(plan.missing.length > 0, `planner must re-query the uncovered range, got ${JSON.stringify(plan.missing)}`);
    assert.strictEqual(plan.missing[0].gte, WGTE);
}

{
    // Shard grid mapping: stable calendar-month keys, half-open bounds, and
    // exact-boundary buckets belonging to the new month.
    assert.strictEqual(shardKeyForTimestamp(Date.parse('2026-06-14T04:00:00.000Z')), '2026-06');
    assert.strictEqual(shardKeyForTimestamp(Date.parse('2026-07-01T00:00:00.000Z')), '2026-07',
        'a bucket exactly at a month boundary belongs to the new month');
    assert.deepStrictEqual(shardBoundsForKey('2026-06'), {
        start: Date.parse('2026-06-01T00:00:00.000Z'),
        end: Date.parse('2026-07-01T00:00:00.000Z'),
    });
    assert.deepStrictEqual(shardBoundsForKey('2026-12'), {
        start: Date.parse('2026-12-01T00:00:00.000Z'),
        end: Date.parse('2027-01-01T00:00:00.000Z'),
    }, 'december rolls into january');
    assert.deepStrictEqual(
        shardKeysForRange(Date.parse('2026-06-14T04:00:00.000Z'), Date.parse('2026-09-13T10:00:00.000Z')),
        ['2026-06', '2026-07', '2026-08', '2026-09'],
    );
}

{
    // Coverage set ops: overlapping spans merge, bucket-adjacent spans merge
    // (contiguous hourly grids are one span), disjoint spans stay separate.
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 30, lte: 50 }, { gte: 10, lte: 20 }, { gte: 15, lte: 35 }], H),
        [{ gte: 10, lte: 50 }],
        'overlapping spans merge regardless of input order',
    );
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 0, lte: 10 * H }, { gte: 11 * H, lte: 20 * H }], H),
        [{ gte: 0, lte: 20 * H }],
        'bucket-adjacent spans merge into continuous coverage',
    );
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 0, lte: 10 * H }, { gte: 12 * H, lte: 20 * H }], H),
        [{ gte: 0, lte: 10 * H }, { gte: 12 * H, lte: 20 * H }],
        'spans with a real gap stay separate',
    );
    assert.ok(rangesCoveredBy([{ gte: 0, lte: 100 }], [{ gte: 10, lte: 50 }, { gte: 50, lte: 100 }]),
        'contained spans are covered');
    assert.ok(!rangesCoveredBy([{ gte: 0, lte: 50 }], [{ gte: 40, lte: 60 }]),
        'partially overlapping span is not covered');
    assert.ok(rangesCoveredBy([], []), 'empty want is trivially covered');
    assert.ok(!rangesCoveredBy([], [{ gte: 0, lte: 10 }]), 'empty have covers nothing');
}

async function shardIntegration() {
    // End-to-end through runCachedWindows with a throwing mock fetch:
    // legacy run-relative chunks are absorbed into month shards without any
    // Kibana query; fully-absorbed files retire; a straddling legacy file
    // with out-of-range buckets is KEPT (no loss); a later wider run
    // retires it; steady-state reruns perform zero writes.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-shard-test-'));
    try {
        const out = path.join(dir, 'feed_x_1h.json');
        const isMatch = () => true;
        const T = (s: string) => Date.parse(s);
        // Legacy 6-month-style run: monthly chunks Jun->Sep plus a straddler
        // reaching back into May (its May buckets lie outside the narrow run).
        const legacyDefs = [
            ['feed_x_1h.chunk_03_2026-05-14_2026-06-14.json', '2026-05-14T04:00:00.000Z', '2026-06-14T04:00:00.000Z'],
            ['feed_x_1h.chunk_04_2026-06-14_2026-07-14.json', '2026-06-14T04:00:00.000Z', '2026-07-14T04:00:00.000Z'],
            ['feed_x_1h.chunk_05_2026-07-14_2026-08-14.json', '2026-07-14T04:00:00.000Z', '2026-08-14T04:00:00.000Z'],
            ['feed_x_1h.chunk_06_2026-08-14_2026-09-13.json', '2026-08-14T04:00:00.000Z', '2026-09-13T04:00:00.000Z'],
        ];
        for (const [name, gte, lte] of legacyDefs) {
            persistCacheChunk(path.join(dir, name),
                { feed: 'x', timeRange: { gte, lte }, queriedRanges: [{ gte: T(gte), lte: T(lte) }] },
                gridCandles(T(gte), T(lte) - H));
        }

        let fetchCalls = 0;
        const throwingFetch = async () => {
            fetchCalls += 1;
            throw new Error('must not fetch: everything is cached');
        };
        const runWindows = (gte: string, lte: string) => {
            const plain = buildFetchWindowsFromRange({ gte, lte }, 1);
            return plain.map((w: any, idx: number) => ({ index: idx + 1, gte: w.gte, lte: w.lte }));
        };
        const runOpts = (gte: string, lte: string, fetch: any) => ({
            windows: runWindows(gte, lte),
            outPath: out,
            requestKey: {},
            isMatch,
            metaForWindow: (w: any) => ({
                source: 'test', feed: 'x', intervalSeconds: 3600,
                chunkIndex: w.index, timeRange: { gte: w.gte, lte: w.lte },
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            }),
            fetchRange: fetch,
            bucketMs: H,
            allowSubFetch: true,
            // Pushed past the 7-day immutability horizon so every window is
            // old: anything still missing after the reuse plan must be
            // covered by recorded queries (a fetch would throw).
            nowMs: T('2026-09-20T10:00:00.000Z'),
        });

        // Narrow run over the legacy span: pure reuse, no queries.
        const narrow = await runCachedWindows(runOpts(
            '2026-06-14T04:00:00.000Z', '2026-09-13T04:00:00.000Z', throwingFetch));
        assert.strictEqual(fetchCalls, 0, 'narrow run over cached span must not query');
        assert.ok(narrow.length > 2000, `narrow run must return absorbed buckets, got ${narrow.length}`);
        for (const [name] of legacyDefs.slice(1)) {
            assert.ok(!fs.existsSync(path.join(dir, name)), `${name} is fully absorbed and retires`);
        }
        const straddler = path.join(dir, legacyDefs[0][0]);
        assert.ok(fs.existsSync(straddler), 'straddling legacy file with out-of-range buckets is KEPT');
        const shardFiles = fs.readdirSync(dir).filter((n: string) => n.includes('.shard_')).sort();
        assert.deepStrictEqual(shardFiles, [
            'feed_x_1h.shard_2026-06.json',
            'feed_x_1h.shard_2026-07.json',
            'feed_x_1h.shard_2026-08.json',
            'feed_x_1h.shard_2026-09.json',
        ], `one stable file per month, got ${JSON.stringify(shardFiles)}`);
        // Shard metas carry month bounds (not run-relative windows) and keep
        // the query-coverage provenance.
        const june = JSON.parse(fs.readFileSync(path.join(dir, shardFiles[0]), 'utf8'));
        assert.strictEqual(june.meta.shard, '2026-06', 'shard key in meta');
        assert.ok(!('chunkIndex' in june.meta), 'run-relative chunkIndex is gone from shard meta');
        assert.deepStrictEqual(june.meta.timeRange, {
            gte: '2026-06-01T00:00:00.000Z', lte: '2026-07-01T00:00:00.000Z',
        }, 'shard meta timeRange is the month bounds');
        assert.ok(june.meta.queriedRanges.length > 0, 'coverage provenance survives absorption');

        // Steady state: identical rerun performs zero writes (mtimes frozen)
        // and zero queries.
        const mtimes = new Map(shardFiles.map((n: string) =>
            [n, fs.statSync(path.join(dir, n)).mtimeMs]));
        const again = await runCachedWindows(runOpts(
            '2026-06-14T04:00:00.000Z', '2026-09-13T04:00:00.000Z', throwingFetch));
        assert.strictEqual(fetchCalls, 0, 'steady-state rerun must not query');
        assert.deepStrictEqual(again, narrow, 'steady-state rerun returns identical candles');
        for (const n of shardFiles) {
            assert.strictEqual(fs.statSync(path.join(dir, n)).mtimeMs, mtimes.get(n),
                `${n} must not be rewritten on pure reuse`);
        }

        // Wider run reaching the straddler's May buckets: still no queries,
        // and the straddler finally retires with nothing lost.
        const wide = await runCachedWindows(runOpts(
            '2026-05-14T04:00:00.000Z', '2026-09-13T04:00:00.000Z', throwingFetch));
        assert.strictEqual(fetchCalls, 0, 'wider run over absorbed history must not query');
        assert.ok(!fs.existsSync(straddler), 'straddler retires once a run covers its full span');
        assert.ok(wide.length > narrow.length, 'wider run returns strictly more history');
        assert.ok(fs.existsSync(path.join(dir, 'feed_x_1h.shard_2026-05.json')),
            'May shard materializes from the absorbed straddler');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function shardFreshFetch() {
    // Fresh range with a recording mock fetch: queries run per window,
    // shards persist once, and the immediate rerun is read-only.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-shard-fresh-test-'));
    try {
        const out = path.join(dir, 'feed_x_1h.json');
        const isMatch = () => true;
        const T = (s: string) => Date.parse(s);
        let fetchCalls = 0;
        const gridFetch = async (gte: string, lte: string) => {
            fetchCalls += 1;
            // Gap-filled hourly grid over the queried span (inclusive ends).
            const from = Math.ceil(T(gte) / H) * H;
            const to = Math.floor(T(lte) / H) * H;
            return gridCandles(from, to);
        };
        const plain = buildFetchWindowsFromRange(
            { gte: '2026-01-10T00:00:00.000Z', lte: '2026-03-12T00:00:00.000Z' }, 1);
        const windows = plain.map((w: any, idx: number) => ({ index: idx + 1, gte: w.gte, lte: w.lte }));
        const opts = (fetch: any) => ({
            windows,
            outPath: out,
            requestKey: {},
            isMatch,
            metaForWindow: (w: any) => ({
                source: 'test', feed: 'x', intervalSeconds: 3600,
                chunkIndex: w.index, timeRange: { gte: w.gte, lte: w.lte },
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            }),
            fetchRange: fetch,
            bucketMs: H,
            allowSubFetch: true,
            nowMs: T('2026-09-13T10:00:00.000Z'),
        });
        const first = await runCachedWindows(opts(gridFetch));
        assert.ok(fetchCalls > 0, 'fresh range must query');
        assert.ok(first.length > 1000, `fresh run must return the full grid, got ${first.length}`);
        const mtimes = new Map(fs.readdirSync(dir)
            .filter((n: string) => n.includes('.shard_'))
            .map((n: string) => [n, fs.statSync(path.join(dir, n)).mtimeMs]));
        assert.ok(mtimes.size >= 3, `Jan/Feb/Mar shards persist, got ${[...mtimes.keys()]}`);

        const throwingFetch = async () => {
            fetchCalls += 1;
            throw new Error('must not fetch on rerun');
        };
        const callsBefore = fetchCalls;
        const second = await runCachedWindows(opts(throwingFetch));
        assert.strictEqual(fetchCalls, callsBefore, 'rerun over fetched history must not query');
        assert.deepStrictEqual(second, first, 'rerun returns identical candles');
        for (const [n, mtime] of mtimes) {
            assert.strictEqual(fs.statSync(path.join(dir, n)).mtimeMs, mtime,
                `${n} must not be rewritten on pure reuse`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

(async () => {
    await shardIntegration();
    await shardFreshFetch();
})()
    .then(() => {
        console.log('window_cache pruning tests passed');
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

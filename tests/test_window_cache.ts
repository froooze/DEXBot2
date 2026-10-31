const assert = require('assert');

console.log('Running window_cache pruning tests');

const {
    unionQueriedRanges,
    rangesCoveredBy,
    coverageSatisfied,
    compactCoverage,
    allQueriedRanges,
    verifiedAt,
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    shardPathFor,
    buildFetchWindowsFromRange,
    runCachedWindows,
    TAIL_SETTLE_LAG_MS,
    MAX_COVERAGE_SPANS,
    __test: {
        findMissingBucketRanges,
        mergeGapRanges,
        planWindowReuse,
        pruneImmutableGaps,
        persistCacheChunk,
        readCacheChunk,
        loadBucketCache,
        settleCoverage,
        GAP_SETTLE_HORIZON_MS,
        TAIL_REFRESH_HOURS,
    },
} = require('../market_adapter/inputs/window_cache');

const H = 3600 * 1000;
// Fixed "now" so the settle horizon is deterministic.
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
    const pruned = pruneImmutableGaps(raw, localCache.fileCover, NOW);
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
    const pruned = pruneImmutableGaps(raw, localCache.fileCover, NOW);
    assert.strictEqual(pruned.length, 0, `actually-queried interior gap must be pruned, got ${JSON.stringify(pruned)}`);

    const plan = planWindowReuse(localCache, {
        gteMs: WGTE, lteMs: WLTE, bucketMs: H,
        isTail: false, allowSubFetch: true, nowMs: NOW,
    });
    assert.strictEqual(plan.missing.length, 0, 'planner must prune the actually-queried gap');
}


{
    // Round trip through a real month shard. Only stable shard files are
    // recognized; unrelated or obsolete filenames are ignored.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-'));
    try {
        const out = path.join(dir, 'feed_x_1h.json');
        const qgte = Date.parse('2026-07-20T00:00:00.000Z');
        const qlte = Date.parse('2026-07-22T00:00:00.000Z');
        persistCacheChunk(
            shardPathFor(out, '2026-07'),
            { feed: 'x', shard: '2026-07', timeRange: { gte: '2026-07-01T00:00:00.000Z', lte: '2026-08-01T00:00:00.000Z' }, queriedRanges: [{ gte: qgte, lte: qlte, at: qgte }] },
            [[qgte, 1, 1, 1, 1, 7]],
        );
        persistCacheChunk(
            path.join(dir, 'feed_x_1h.chunk_01_2026-06-10_2026-07-10.json'),
            { feed: 'x', timeRange: { gte: '2026-06-10T00:00:00.000Z', lte: '2026-07-10T00:00:00.000Z' } },
            [],
        );
        const isMatch = () => true;
        const cache = loadBucketCache(out, {}, isMatch);
        assert.strictEqual(cache.files, 1, 'only stable shard files load');
        assert.strictEqual(cache.shards.length, 1, 'month file classifies as a shard');
        assert.strictEqual(cache.shards[0].shardKey, '2026-07', 'shard key survives the round trip');
        const narrow = cache.fileCover.find((f: any) => f.count === 1);
        assert.deepStrictEqual(narrow.queried, [{ gte: qgte, lte: qlte, at: qgte }],
            'narrow queriedRanges and their verification time survive the round trip');
        // A shard written without `at` is dated from its own write time
        // (`fetchedAt`), never left undated: an undated span would make every
        // bucket it covers unverifiable and, because old shards are never
        // re-queried, would disable the tail refresh on the whole cache for
        // good. The stand-in is at most one run-duration optimistic.
        const legacyFile = path.join(dir, 'feed_x_1h.shard_2026-08.json');
        persistCacheChunk(legacyFile, {
            feed: 'x', shard: '2026-08',
            timeRange: { gte: '2026-08-01T00:00:00.000Z', lte: '2026-09-01T00:00:00.000Z' },
            queriedRanges: [{ gte: qgte, lte: qlte }],
            fetchedAt: '2026-09-13T10:00:00.000Z',
        }, []);
        assert.deepStrictEqual(
            readCacheChunk(legacyFile, {}, isMatch).queried,
            [{ gte: qgte, lte: qlte, at: Date.parse('2026-09-13T10:00:00.000Z') }],
            'a pre-`at` shard is dated from its write time');
        // With neither `at` nor `fetchedAt` there is nothing to date it with,
        // and the span stays explicitly unknown (which arms the 48h fallback).
        const undatableFile = path.join(dir, 'feed_x_1h.shard_2026-05.json');
        persistCacheChunk(undatableFile, {
            feed: 'x', shard: '2026-05',
            timeRange: { gte: '2026-05-01T00:00:00.000Z', lte: '2026-06-01T00:00:00.000Z' },
            queriedRanges: [{ gte: qgte, lte: qlte }],
        }, []);
        assert.deepStrictEqual(
            readCacheChunk(undatableFile, {}, isMatch).queried,
            [{ gte: qgte, lte: qlte, at: null }],
            'a shard with no write time keeps an explicitly unknown verification time');

        // Scoped load: a narrow request opens only overlapping files.
        const scoped = loadBucketCache(out, {}, isMatch, {
            gte: Date.parse('2026-07-19T00:00:00.000Z'),
            lte: Date.parse('2026-07-21T00:00:00.000Z'),
        });
        assert.strictEqual(scoped.files, 1, `scoped load opens only overlapping files, got ${scoped.files}`);
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
    const pruned = pruneImmutableGaps(raw, localCache.fileCover, NOW);
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
    // Spans only merge when they agree on the verification time — see
    // unionQueriedRanges for why a mixed merge would lose freshness.
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 30, lte: 50 }, { gte: 10, lte: 20 }, { gte: 15, lte: 35 }], H),
        [{ gte: 10, lte: 50, at: null }],
        'overlapping spans merge regardless of input order',
    );
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 0, lte: 10 * H }, { gte: 11 * H, lte: 20 * H }], H),
        [{ gte: 0, lte: 20 * H, at: null }],
        'bucket-adjacent spans merge into continuous coverage',
    );
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 0, lte: 10 * H }, { gte: 12 * H, lte: 20 * H }], H),
        [{ gte: 0, lte: 10 * H, at: null }, { gte: 12 * H, lte: 20 * H, at: null }],
        'spans with a real gap stay separate',
    );
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 0, lte: 10 * H, at: 111 }, { gte: 11 * H, lte: 20 * H, at: 222 }], H),
        [{ gte: 0, lte: 10 * H, at: 111 }, { gte: 11 * H, lte: 20 * H, at: 222 }],
        'bucket-adjacent spans verified at different times stay separate',
    );
    assert.deepStrictEqual(
        unionQueriedRanges([{ gte: 0, lte: 10 * H, at: 111 }, { gte: 10 * H, lte: 20 * H, at: 111 }], H),
        [{ gte: 0, lte: 20 * H, at: 111 }],
        'spans verified at the same time still merge',
    );
    assert.ok(rangesCoveredBy([{ gte: 0, lte: 100 }], [{ gte: 10, lte: 50 }, { gte: 50, lte: 100 }]),
        'contained spans are covered');
    assert.ok(!rangesCoveredBy([{ gte: 0, lte: 50 }], [{ gte: 40, lte: 60 }]),
        'partially overlapping span is not covered');
    assert.ok(rangesCoveredBy([], []), 'empty want is trivially covered');
    assert.ok(!rangesCoveredBy([], [{ gte: 0, lte: 10 }]), 'empty have covers nothing');

    // Change detection must see the verification time too, otherwise a
    // re-query that changed nothing but its `at` is never persisted and the
    // next run falls back to the wide fixed refresh window.
    assert.ok(coverageSatisfied([{ gte: 0, lte: 100, at: 500 }], [{ gte: 10, lte: 50, at: 500 }]),
        'identical extent and verification time is not a change');
    assert.ok(coverageSatisfied([{ gte: 0, lte: 100, at: 900 }], [{ gte: 10, lte: 50, at: 500 }]),
        'a newer recorded verification covers an older claim');
    assert.ok(!coverageSatisfied([{ gte: 0, lte: 100, at: 400 }], [{ gte: 10, lte: 50, at: 500 }]),
        'a stale recorded verification does not cover a newer claim');
    assert.ok(!coverageSatisfied([{ gte: 0, lte: 100, at: null }], [{ gte: 10, lte: 50, at: 500 }]),
        'an unknown verification time never counts as fresh');
    assert.ok(!coverageSatisfied([{ gte: 20, lte: 30, at: 900 }], [{ gte: 0, lte: 100, at: 500 }]),
        'a narrower span never covers a wider claim');
}

{
    // A gap is immutable by its OWN age, not by the age of the window that
    // happens to contain it. Real incident shape: a 30-day-old window whose
    // leading edge lost two buckets to the gap-filler, queried in an earlier
    // run. Judged per window it was re-queried on EVERY rerun forever, because
    // the window ends "now" and a now-window is never old.
    const recentNow = Date.UTC(2026, 8, 27, 23, 0, 0);
    const w2Gte = recentNow - 30 * 24 * H;
    const w2Lte = recentNow;
    const leadingGap = { gte: w2Gte, lte: w2Gte + H, hours: 2 };
    const recentGap = { gte: w2Lte - 2 * H, lte: w2Lte - H, hours: 2 };
    const coverWholeWindow = [{ gte: w2Gte, lte: w2Lte, at: recentNow - H }];
    const recentCache = { byTs: new Map(), files: 1, fileCover: [{ gte: w2Gte, lte: w2Lte, count: 0, queried: coverWholeWindow }] };
    const keptRecent = pruneImmutableGaps([leadingGap, recentGap], recentCache.fileCover, recentNow);
    assert.deepStrictEqual(keptRecent.map((m: any) => m.gte), [recentGap.gte],
        'only the gap inside the settle horizon survives; a queried 30-day-old gap is pruned');

    // Unqueried is still unproven, however old: a month-old gap with no
    // coverage claim must be re-queried.
    const unproven = pruneImmutableGaps(
        [{ gte: w2Gte, lte: w2Gte + H, hours: 2 }],
        [{ gte: w2Gte, lte: w2Lte, count: 0, queried: [{ gte: w2Gte + 10 * H, lte: w2Lte, at: recentNow - H }] }],
        recentNow,
    );
    assert.strictEqual(unproven.length, 1, 'an old but never-queried gap must survive pruning');

    // The horizon keeps the margin the old window-level rule used (7 days).
    // Per-gap judgement is what buys the win; trusting the cache SOONER is
    // not part of it, and nothing here measures Kibana's indexing lag.
    assert.strictEqual(GAP_SETTLE_HORIZON_MS, 7 * 24 * 3600 * 1000,
        'the settle horizon must not be tightened below the previously proven 7 days');
    // Coverage spanning the whole timeline under test, so only the horizon
    // decides each case.
    const horizonCover = [{ gte: 0, lte: w2Lte, count: 0, queried: [{ gte: 0, lte: w2Lte, at: recentNow - H }] }];
    for (const ageH of [1, 24, 72, 24 * 6]) {
        const gap = { gte: w2Lte - (ageH + 1) * H, lte: w2Lte - ageH * H, hours: 2 };
        assert.strictEqual(pruneImmutableGaps([gap], horizonCover, recentNow).length, 1,
            `a ${ageH}h-old queried gap is still inside the horizon and must be re-queried`);
    }
    for (const ageH of [24 * 8, 24 * 30]) {
        const gap = { gte: w2Lte - (ageH + 1) * H, lte: w2Lte - ageH * H, hours: 2 };
        assert.strictEqual(pruneImmutableGaps([gap], horizonCover, recentNow).length, 0,
            `a ${ageH / 24}d-old queried gap is past the horizon and stays pruned`);
    }
}

{
    // Spans merge only when they agree on `at`, so a shard re-verified on
    // every run gains one span per run. The persisted list is bounded, keeping
    // the newest spans. Dropping the oldest never invents emptiness, but it
    // does make their buckets look unsettled — which is exactly why the tail
    // refresh is capped at 48h (see the mid-window-hole regression below).
    const many = [];
    for (let i = 0; i < 500; i += 1) many.push({ gte: i * H, lte: i * H + H, at: 1000 + i });
    const compacted = compactCoverage(many, MAX_COVERAGE_SPANS);
    assert.strictEqual(compacted.length, MAX_COVERAGE_SPANS, `span growth must be bounded, got ${compacted.length}`);
    assert.strictEqual(compacted[0].gte, (500 - MAX_COVERAGE_SPANS) * H, 'the newest spans are the ones kept');
    assert.deepStrictEqual(compactCoverage(many.slice(0, 5), MAX_COVERAGE_SPANS), many.slice(0, 5),
        'a list under the cap is persisted untouched');
    assert.deepStrictEqual(compactCoverage([], MAX_COVERAGE_SPANS), [], 'no coverage, nothing to compact');
}

{
    // Regression: an UNDATED span anywhere in the window used to drag the
    // refresh boundary back to the window start, where `refreshFromMs > gteMs`
    // turned the late-indexing refresh OFF completely — the rerun queried
    // nothing at all, so zero-volume tail candles could never gain their
    // late-indexed trades again. The refresh must fall back to the bounded 48h
    // window, not vanish.
    const now = Date.UTC(2026, 8, 27, 23, 0, 0);
    const gte = now - 30 * 24 * H;
    const lte = now;
    const byTs = new Map();
    for (const t of hourly(gte, lte)) byTs.set(t, candle(t));
    const planWithUndatedSpan = (queried: any[]) => planWindowReuse(
        { byTs, files: 1, fileCover: [{ gte, lte, count: byTs.size, queried }] },
        { gteMs: gte, lteMs: lte, bucketMs: H, isTail: true, allowSubFetch: true, nowMs: now },
    );
    const undated = planWithUndatedSpan([{ gte, lte }]);
    assert.ok(undated.missingHours > 0, 'an undated span must never switch the tail refresh off');
    assert.strictEqual(undated.missingHours, TAIL_REFRESH_HOURS + 1,
        'an undated span falls back to the bounded 48h refresh');
    // Partially dated coverage (an old shard next to a freshly re-verified
    // one) must still get the narrow, incremental refresh.
    const mixed = planWithUndatedSpan([
        { gte, lte: lte - 10 * H, at: now - 2 * H },
        { gte: lte - 10 * H, lte },
    ]);
    assert.ok(mixed.missingHours < TAIL_REFRESH_HOURS,
        `dated coverage next to an undated one still refreshes narrowly, got ${mixed.missingHours}h`);

    // Regression: the incremental refresh must stay CAPPED at the legacy 48h.
    // Coverage is consulted for freshness too, so a mid-window hole — e.g. an
    // old span dropped by compactCoverage, or a present bucket no span dates —
    // used to drag the boundary back to the earliest uncovered bucket and
    // re-query weeks of settled history on every run.
    const holed = planWithUndatedSpan([
        { gte, lte: now - 20 * 24 * H, at: now - 2 * H },
        { gte: now - 10 * 24 * H, lte, at: now - 2 * H },
    ]);
    assert.strictEqual(holed.missingHours, TAIL_REFRESH_HOURS + 1,
        `a mid-window coverage hole must not widen the refresh past 48h, got ${holed.missingHours}h`);
    assert.ok(holed.missing[0].gte >= lte - (TAIL_REFRESH_HOURS + 1) * H,
        `the refresh must not reach back into the hole, got ${new Date(holed.missing[0].gte).toISOString()}`);
}

{
    // settleCoverage: a bucket is settled once a query covering it ran
    // TAIL_SETTLE_LAG_MS after the bucket closed. Without recorded query
    // times (pre-`at` shards) the caller must fall back to the fixed window.
    const now = Date.UTC(2026, 8, 27, 23, 0, 0);
    const lte = now;
    const gte = now - 10 * 24 * H;
    const at = now - H;
    const settle = settleCoverage({
        gteMs: gte, lteMs: lte, bucketMs: H, lagMs: TAIL_SETTLE_LAG_MS,
        queried: [{ gte, lte, at }],
    });
    assert.strictEqual(settle.hasTimestamps, true, 'recorded query times must be detected');
    assert.strictEqual(settle.firstUnsettled, at - TAIL_SETTLE_LAG_MS,
        `first unsettled bucket is the last one verified less than a lag ago, got ${new Date(settle.firstUnsettled).toISOString()}`);
    assert.strictEqual(
        settleCoverage({ gteMs: gte, lteMs: lte, bucketMs: H, lagMs: TAIL_SETTLE_LAG_MS, queried: [{ gte, lte }] }).hasTimestamps,
        false,
        'coverage without verification time must request the fixed fallback');
    // Everything verified long after closing -> nothing left to refresh.
    assert.strictEqual(
        settleCoverage({ gteMs: gte, lteMs: lte, bucketMs: H, lagMs: TAIL_SETTLE_LAG_MS, queried: [{ gte, lte, at: lte + 10 * H }] }).firstUnsettled,
        null,
        'a fully settled window needs no refresh at all');
    // Extent-only coverage never counts as settled, even for old buckets.
    assert.strictEqual(
        settleCoverage({ gteMs: gte, lteMs: lte, bucketMs: H, lagMs: TAIL_SETTLE_LAG_MS, queried: [{ gte, lte }, { gte: lte, lte: lte + H, at }] }).firstUnsettled,
        gte,
        'an unverified span never settles the buckets it covers');
}

{
    // B through the planner: the tail refresh tracks what is unsettled instead
    // of always re-reading TAIL_REFRESH_HOURS of history. Reusable tail
    // buckets verified one hour ago must not be re-queried.
    const now = Date.UTC(2026, 8, 27, 23, 0, 0);
    const gte = now - 30 * 24 * H;
    const lte = now;
    const byTs = new Map();
    for (const t of hourly(gte, lte)) byTs.set(t, candle(t));
    const at = now - H;
    const localCache = {
        byTs, files: 1,
        fileCover: [{ gte, lte, count: byTs.size, queried: [{ gte, lte, at }] }],
    };
    const plan = planWindowReuse(localCache, { gteMs: gte, lteMs: lte, bucketMs: H, isTail: true, allowSubFetch: true, nowMs: now });
    assert.strictEqual(plan.missing.length, 1, `the unsettled tail must be one range, got ${JSON.stringify(plan.missing)}`);
    assert.strictEqual(plan.missingHours, 8, `refresh covers lag+elapsed hours, not ${TAIL_REFRESH_HOURS}h — got ${plan.missingHours}`);
    assert.ok(plan.missingHours < TAIL_REFRESH_HOURS, 'the refresh must be strictly smaller than the fixed 48h window');

    // Legacy cache (no `at` on disk) keeps the old, conservative 48h refresh.
    const legacyCache = {
        byTs, files: 1,
        fileCover: [{ gte, lte, count: byTs.size, queried: [{ gte, lte }] }],
    };
    const legacyPlan = planWindowReuse(legacyCache, { gteMs: gte, lteMs: lte, bucketMs: H, isTail: true, allowSubFetch: true, nowMs: now });
    assert.strictEqual(legacyPlan.missingHours, TAIL_REFRESH_HOURS + 1,
        'coverage without verification times must fall back to the fixed trailing window');
}

{
    // An absent verification time must read as "unknown", never as the epoch:
    // Number(null) === 0 is finite, so a naive parse turns "not recorded"
    // into "verified in 1970" — maximally stale — and silently switches off
    // the tail refresh for every shard written before `at` existed.
    assert.strictEqual(verifiedAt({ at: null }), null, 'explicit null is not a verification time');
    assert.strictEqual(verifiedAt({}), null, 'missing key is not a verification time');
    assert.strictEqual(verifiedAt({ at: '' }), null, 'empty string is not a verification time');
    assert.strictEqual(verifiedAt({ at: 'nonsense' }), null, 'unparseable string is not a verification time');
    assert.strictEqual(verifiedAt({ at: 0 }), 0, 'a real epoch timestamp is still honored');
    assert.strictEqual(verifiedAt({ at: '2026-09-13T10:00:00.000Z' }), Date.parse('2026-09-13T10:00:00.000Z'),
        'ISO verification times are accepted');
    assert.strictEqual(
        settleCoverage({ gteMs: 1000, lteMs: 5000, bucketMs: H, lagMs: H, queried: [{ gte: 1000, lte: 5000, at: null }] }).hasTimestamps,
        false,
        'a span whose verification time is unknown must request the fixed fallback');

    // C: gap clusters collapse into one query, and the sub-range budget is
    // spent on span hours rather than on a raw gap count.
    const merged = mergeGapRanges([
        { gte: 0, lte: 0, hours: 1 },
        { gte: 2 * H, lte: 2 * H, hours: 1 },
        { gte: 20 * H, lte: 20 * H, hours: 1 },
        { gte: 40 * H, lte: 41 * H, hours: 2 },
    ], H, 2);
    assert.strictEqual(merged.length, 3, `two-bucket-adjacent gaps merge, distant ones do not — got ${JSON.stringify(merged)}`);
    assert.deepStrictEqual(merged[0], { gte: 0, lte: 2 * H, hours: 3 }, 'a merged span spans its whole extent');
    assert.deepStrictEqual(merged[1], { gte: 20 * H, lte: 20 * H, hours: 1 }, 'an isolated gap is untouched');
    assert.deepStrictEqual(mergeGapRanges([{ gte: 0, lte: H, hours: 2 }], H, 2).length, 1, 'a single gap survives merging');
    assert.deepStrictEqual(mergeGapRanges([], H, 2), [], 'no gaps, no spans');
}

async function tailRefreshConverges() {
    // End-to-end rerun shape from a real `dexbot tv` run: 30 days of shards on
    // disk, everything cached and verified an hour ago, two leading buckets
    // lost to the gap-filler and already covered by queriedRanges. A rerun
    // must query ONE small range at the unsettled tail — not the 2h leading
    // gap plus a fixed 48h refresh.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-tail-test-'));
    try {
        const out = path.join(dir, 'pool_x_1h.json');
        const isMatch = () => true;
        const now = Date.now();
        const hour = Math.floor(now / H) * H;
        const gte = hour - 30 * 24 * H;
        const lte = hour;
        const verifiedAtMs = now - H;
        // Seed one shard file per month with a full hourly grid, minus the two
        // leading buckets the gap-filler never produced, and coverage that
        // claims the whole window was queried an hour ago.
        for (const key of shardKeysForRange(gte, lte)) {
            const { start, end } = shardBoundsForKey(key);
            const from = Math.max(gte, start);
            const to = Math.min(lte, end - H);
            const candles = [];
            for (let t = Math.ceil(from / H) * H; t <= to; t += H) {
                if (t < gte + 2 * H) continue;
                candles.push([t, 1, 1, 1, 1, 3]);
            }
            persistCacheChunk(shardPathFor(out, key), {
                pool: '1.19.44', intervalSeconds: 3600, shard: key,
                timeRange: { gte: new Date(start).toISOString(), lte: new Date(end).toISOString() },
                queriedRanges: [{ gte, lte, at: verifiedAtMs }],
                fetchedAt: new Date(verifiedAtMs).toISOString(),
            }, candles);
        }
        const requested = [];
        const recordingFetch = async (from: string, to: string) => {
            requested.push({ gte: Date.parse(from), lte: Date.parse(to) });
            return gridCandles(Math.ceil(Date.parse(from) / H) * H, Date.parse(to) - H);
        };
        const opts = {
            windows: [{ index: 1, gte: new Date(gte).toISOString(), lte: new Date(lte).toISOString() }],
            outPath: out,
            requestKey: {},
            isMatch,
            metaForWindow: (w: any) => ({
                source: 'test', pool: '1.19.44', intervalSeconds: 3600,
                timeRange: { gte: w.gte, lte: w.lte },
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            }),
            fetchRange: recordingFetch,
            bucketMs: H,
            allowSubFetch: true,
            nowMs: now,
        };
        const first = await runCachedWindows(opts);
        assert.strictEqual(requested.length, 1, `a settled rerun must issue exactly one tail query, got ${JSON.stringify(requested)}`);
        const requestedHours = Math.round((requested[0].lte - requested[0].gte) / H) + 1;
        assert.ok(requestedHours <= 10, `the tail query must stay within lag+elapsed, got ${requestedHours}h`);
        assert.ok(requested[0].gte >= now - 12 * H, 'the rerun must not reach back into settled history');
        assert.ok(first.length > 600, `the rerun must still return the whole grid, got ${first.length}`);

        // The refreshed coverage is persisted with its verification time, so
        // an immediate second rerun asks for no more than the lag window —
        // and the shard is REWRITTEN even though the candles are identical,
        // because the moved verification time is the only news.
        const shardFile = shardPathFor(out, shardKeysForRange(gte, lte)[shardKeysForRange(gte, lte).length - 1]);
        const readQueried = () => JSON.parse(fs.readFileSync(shardFile, 'utf8')).meta.queriedRanges;
        const verifiedBefore = Math.max(...readQueried().map((q: any) => Number(q.at) || 0));
        const again = await runCachedWindows(opts);
        const verifiedAfter = Math.max(...readQueried().map((q: any) => Number(q.at) || 0));
        assert.ok(verifiedAfter >= verifiedBefore,
            'a re-verifying run must persist the moved verification time even when no candle changed');
        const last = requested[requested.length - 1];
        const againHours = Math.round((last.lte - last.gte) / H) + 1;
        assert.ok(againHours <= 10, `a back-to-back rerun must not widen the refresh, got ${againHours}h`);
        assert.deepStrictEqual(again, first, 'a rerun over settled data returns identical candles');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function manyGapsStaySubFetch() {
    // C end-to-end: four one-bucket holes in a fully cached window must stay
    // on the sub-range path. The old `missing.length <= 3` guard turned the
    // fourth hole into a full-window fetch — ~480x the query for one more hour.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gaps-test-'));
    try {
        const out = path.join(dir, 'pool_y_1h.json');
        const isMatch = () => true;
        const T = (s: string) => Date.parse(s);
        const w1Gte = T('2026-06-01T00:00:00.000Z');
        const w1Lte = T('2026-06-21T00:00:00.000Z');
        const julyGte = T('2026-07-01T00:00:00.000Z');
        const w2Lte = T('2026-07-11T00:00:00.000Z');
        const verifiedAt = T('2026-09-13T10:00:00.000Z');
        // Four one-bucket holes, three hours apart so the merge tolerance
        // cannot collapse them, and NOT covered by queriedRanges — an
        // unproven old gap is exactly what per-gap pruning must keep.
        const holes = [w1Lte - 10 * H, w1Lte - 7 * H, w1Lte - 4 * H, w1Lte - H];
        const coverageWithoutHoles = (from: number, to: number) => {
            const spans = [];
            let cursor = from;
            for (const hole of holes.filter((h: number) => h >= from && h < to)) {
                if (hole > cursor) spans.push({ gte: cursor, lte: hole - H, at: verifiedAt });
                cursor = hole + H;
            }
            if (to > cursor) spans.push({ gte: cursor, lte: to, at: verifiedAt });
            return spans;
        };
        for (const [key, from, to] of [
            ['2026-06', w1Gte, julyGte],
            ['2026-07', julyGte, w2Lte],
        ] as [string, number, number][]) {
            const candles = [];
            for (let t = from; t < to; t += H) {
                if (holes.includes(t)) continue;
                candles.push([t, 1, 1, 1, 1, 3]);
            }
            persistCacheChunk(shardPathFor(out, key), {
                pool: '1.19.44', intervalSeconds: 3600, shard: key,
                timeRange: { gte: new Date(from).toISOString(), lte: new Date(to).toISOString() },
                queriedRanges: coverageWithoutHoles(from, to),
                fetchedAt: '2026-09-13T10:00:00.000Z',
            }, candles);
        }
        const requested = [];
        const opts = {
            windows: [
                { index: 1, gte: new Date(w1Gte).toISOString(), lte: new Date(w1Lte).toISOString() },
                { index: 2, gte: new Date(w1Lte).toISOString(), lte: new Date(w2Lte).toISOString() },
            ],
            outPath: out,
            requestKey: {},
            isMatch,
            metaForWindow: (w: any) => ({
                source: 'test', pool: '1.19.44', intervalSeconds: 3600,
                timeRange: { gte: w.gte, lte: w.lte },
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            }),
            fetchRange: async (from: string, to: string) => {
                requested.push({ gte: Date.parse(from), lte: Date.parse(to) });
                return gridCandles(Math.ceil(Date.parse(from) / H) * H, Date.parse(to) - H);
            },
            bucketMs: H,
            allowSubFetch: true,
            nowMs: T('2026-09-13T10:00:00.000Z'),
        };
        await runCachedWindows(opts);
        assert.strictEqual(requested.length, 4, `four isolated holes cost four queries, got ${requested.length}`);
        for (const r of requested) {
            assert.ok(r.lte - r.gte <= 2 * H, `each query must stay hole-sized, got ${(r.lte - r.gte) / H}h`);
        }
        const fullWindow = requested.filter((r: any) => r.gte <= w1Gte + H && r.lte >= w1Lte - H);
        assert.strictEqual(fullWindow.length, 0, 'a fourth hole must not escalate to a full-window fetch');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function shardIntegration() {
    // End-to-end through runCachedWindows with stable month shards only.
    // Obsolete run-relative cache files are ignored rather than migrated.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-shard-test-'));
    try {
        const out = path.join(dir, 'feed_x_1h.json');
        const isMatch = () => true;
        const T = (s: string) => Date.parse(s);
        const obsolete = path.join(dir, 'feed_x_1h.chunk_01_2026-06-14_2026-07-14.json');
        persistCacheChunk(obsolete,
            { feed: 'x', timeRange: { gte: '2026-06-14T00:00:00.000Z', lte: '2026-07-14T00:00:00.000Z' } },
            gridCandles(T('2026-06-14T04:00:00.000Z'), T('2026-07-14T04:00:00.000Z') - H));

        let fetchCalls = 0;
        const gridFetch = async (gte: string, lte: string) => {
            fetchCalls += 1;
            return gridCandles(Date.parse(gte), Date.parse(lte) - H);
        };
        const runWindows = (gte: string, lte: string) => {
            const plain = buildFetchWindowsFromRange({ gte, lte }, 1);
            return plain.map((w: any, idx: number) => ({ index: idx + 1, gte: w.gte, lte: w.lte }));
        };
        const runOpts = (fetch: any) => ({
            windows: runWindows('2026-06-14T04:00:00.000Z', '2026-09-13T04:00:00.000Z'),
            outPath: out,
            requestKey: {},
            isMatch,
            metaForWindow: (w: any) => ({
                source: 'test', feed: 'x', intervalSeconds: 3600,
                timeRange: { gte: w.gte, lte: w.lte },
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            }),
            fetchRange: fetch,
            bucketMs: H,
            allowSubFetch: true,
            nowMs: T('2026-09-20T10:00:00.000Z'),
        });

        const first = await runCachedWindows(runOpts(gridFetch));
        assert.ok(fetchCalls > 0, 'the obsolete chunk file must not be used as cache');
        assert.ok(first.length > 2000, `the fresh run must return the full grid, got ${first.length}`);
        assert.ok(fs.existsSync(obsolete), 'obsolete cache files are left untouched');
        const shardFiles = fs.readdirSync(dir).filter((n: string) => n.includes('.shard_')).sort();
        assert.deepStrictEqual(shardFiles, [
            'feed_x_1h.shard_2026-06.json',
            'feed_x_1h.shard_2026-07.json',
            'feed_x_1h.shard_2026-08.json',
            'feed_x_1h.shard_2026-09.json',
        ], `one stable file per month, got ${JSON.stringify(shardFiles)}`);

        const mtimes = new Map(shardFiles.map((n: string) =>
            [n, fs.statSync(path.join(dir, n)).mtimeMs]));
        const callsBefore = fetchCalls;
        const second = await runCachedWindows(runOpts(async () => {
            throw new Error('must not fetch: stable shards are cached');
        }));
        assert.strictEqual(fetchCalls, callsBefore, 'stable-shard rerun must not query');
        assert.deepStrictEqual(second, first, 'stable-shard rerun returns identical candles');
        for (const n of shardFiles) {
            assert.strictEqual(fs.statSync(path.join(dir, n)).mtimeMs, mtimes.get(n),
                `${n} must not be rewritten on pure reuse`);
        }
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
    await tailRefreshConverges();
    await manyGapsStaySubFetch();
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

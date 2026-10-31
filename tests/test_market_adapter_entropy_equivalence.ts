'use strict';

const assert = require('assert');
const { PermutationEntropyAnalyzer } = require('../market_adapter/core/signals/permutation_entropy_analyzer');
const { HurstAnalyzer } = require('../market_adapter/core/signals/hurst_analyzer');
const { computeRegimeMultiplier, __test: { _resetRegimeCache, _locateResume } } = require('../market_adapter/core/strategies/regime_gate');
const { MARKET_ADAPTER } = require('../modules/constants');
const { roundTo } = require('../modules/order/utils/math');

/**
 * Equivalence tests for the 2026-09 market-adapter CPU work.
 *
 * The optimized permutation-entropy / Hurst / regime-gate implementations are
 * required to be observationally identical to the previous ones, so the previous
 * algorithms are reproduced here verbatim as reference implementations and the
 * new ones are compared against them bar by bar. A failure here means a trading
 * signal changed, not just a number in a log line.
 */

// ─── Reference (pre-optimization) implementations ───────────────────────────

function refOrdinalPattern(prices, start, m, delay) {
    const vals = new Array(m);
    for (let j = 0; j < m; j++) vals[j] = { v: prices[start + j * delay], j };
    vals.sort((a, b) => a.v !== b.v ? a.v - b.v : a.j - b.j);
    let key = '';
    for (let j = 0; j < m; j++) key += vals[j].j;
    return key;
}

function refPermutationEntropy(config, prices) {
    const m = Math.round(config.m ?? 5);
    const delay = Math.round(config.delay ?? 1);
    const window = Math.round(config.window ?? 100);
    const bufSize = window + (m - 1) * delay;
    let f = 1;
    for (let i = 2; i <= m; i++) f *= i;
    const maxEntropy = Math.log(f);

    const buf = [];
    const series = [];
    let ready = false;
    for (const price of prices) {
        buf.push(price);
        if (buf.length > bufSize) buf.shift();
        if (buf.length < bufSize) { series.push(null); continue; }
        const counts = new Map();
        const numPatterns = buf.length - (m - 1) * delay;
        for (let i = 0; i < numPatterns; i++) {
            const key = refOrdinalPattern(buf, i, m, delay);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let entropy = 0;
        for (const count of counts.values()) {
            const p = count / numPatterns;
            entropy -= p * Math.log(p);
        }
        ready = true;
        series.push(maxEntropy > 0 ? entropy / maxEntropy : 0);
    }
    return { series, ready, maxEntropy };
}

function refComputeRS(returns) {
    const n = returns.length;
    if (n < 2) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += returns[i];
    const mean = sum / n;
    let cumDev = 0, maxCum = -Infinity, minCum = Infinity, sumSq = 0;
    for (let i = 0; i < n; i++) {
        const d = returns[i] - mean;
        cumDev += d;
        if (cumDev > maxCum) maxCum = cumDev;
        if (cumDev < minCum) minCum = cumDev;
        sumSq += d * d;
    }
    const R = maxCum - minCum;
    const S = Math.sqrt(sumSq / n);
    return S > 0 ? R / S : 0;
}

function refOlsSlope(xs, ys) {
    const n = xs.length;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
    for (let i = 0; i < n; i++) {
        sumX += xs[i]; sumY += ys[i]; sumXX += xs[i] * xs[i]; sumXY += xs[i] * ys[i];
    }
    const denom = n * sumXX - sumX * sumX;
    return denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0.5;
}

function refHurst(config, prices) {
    const window = Math.ceil(config.window ?? 128);
    const scales = config.scales ?? [8, 16, 32, 64];
    const buf = [];
    const series = [];
    let hurst = 0.5;
    for (const price of prices) {
        buf.push(price);
        if (buf.length > window + 1) buf.shift();
        if (buf.length < window + 1) { series.push({ ready: false, hurst }); continue; }
        const returns = new Array(window);
        for (let i = 0; i < window; i++) returns[i] = Math.log(buf[i + 1] / buf[i]);
        const logRS = [], logTau = [];
        for (const tau of scales) {
            if (tau >= returns.length) continue;
            const nChunks = Math.floor(returns.length / tau);
            if (nChunks < 1) continue;
            let sumRS = 0, count = 0;
            for (let c = 0; c < nChunks; c++) {
                const rs = refComputeRS(returns.slice(c * tau, (c + 1) * tau));
                if (rs > 0) { sumRS += rs; count++; }
            }
            if (count > 0) { logRS.push(Math.log(sumRS / count)); logTau.push(Math.log(tau)); }
        }
        if (logTau.length >= 2) {
            hurst = Math.min(1, Math.max(0, refOlsSlope(logTau, logRS)));
        }
        series.push({ ready: true, hurst });
    }
    return { series };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeSeries(kind, length, seed) {
    const rand = mulberry32(seed);
    const out = [];
    if (kind === 'flat') {
        for (let i = 0; i < length; i++) out.push(100);
        return out;
    }
    if (kind === 'trend') {
        for (let i = 0; i < length; i++) out.push(100 * (1 + i * 0.002));
        return out;
    }
    if (kind === 'sawtooth') {
        // Lots of ties: exercises the tie-break-by-source-index path in the key.
        for (let i = 0; i < length; i++) out.push(100 + (i % 5));
        return out;
    }
    let price = 100;
    for (let i = 0; i < length; i++) {
        price = price * (1 + (rand() - 0.5) * 0.04);
        out.push(Math.max(0.01, price));
    }
    return out;
}

const SERIES = [];
for (const kind of ['random', 'trend', 'flat', 'sawtooth']) {
    // Two seeds keep the kind coverage while cutting the differential sweep
    // cost; the reference and production analyzers are deterministic, so extra
    // random samples add runtime, not signal.
    for (const seed of [1, 99]) SERIES.push({ kind, seed, prices: makeSeries(kind, 300, seed) });
}

const PE_CONFIGS = [
    { m: 5, delay: 1, window: 54 },   // MARKET_ADAPTER.PE_CONFIG (production)
    { m: 3, delay: 1, window: 10 },
    { m: 4, delay: 2, window: 37 },
    { m: 7, delay: 1, window: 120 },
];

const HURST_CONFIGS = [
    { window: 256, scales: [8, 16, 32, 64] },   // MARKET_ADAPTER.HURST_CONFIG (production)
    { window: 32, scales: [4, 8, 16] },
    { window: 129, scales: [8, 16, 32, 64, 128] },
];

// Entropy/hurst are float sums over the same multiset of counts, so the only
// permitted difference is summation order. Everything downstream is rounded to
// 1e-3 / 1e-4, but keep the bar tight enough to catch a real logic change.
const TOL = 1e-12;

// ─── Tests ─────────────────────────────────────────────────────────────────

function testPermutationEntropyMatchesReference() {
    for (const config of PE_CONFIGS) {
        for (const { kind, seed, prices } of SERIES) {
            const ref = refPermutationEntropy(config, prices);
            const analyzer = new PermutationEntropyAnalyzer(config);
            for (let i = 0; i < prices.length; i++) {
                const result = analyzer.update(prices[i]);
                const expected = ref.series[i];
                if (expected === null) {
                    assert.strictEqual(result.isReady, false,
                        `PE must stay unready during warmup (${kind}/${seed}/m=${config.m} bar ${i})`);
                    continue;
                }
                assert.strictEqual(result.isReady, true,
                    `PE must be ready after warmup (${kind}/${seed}/m=${config.m} bar ${i})`);
                assert.ok(Math.abs(analyzer.normalizedEntropy - expected) <= TOL,
                    `PE mismatch (${kind}/${seed}/m=${config.m} d=${config.delay} w=${config.window} bar ${i}): `
                    + `${analyzer.normalizedEntropy} vs ${expected}`);
                assert.strictEqual(result.normalizedEntropy, roundTo(expected, 10000),
                    `rounded PE mismatch (${kind}/${seed} bar ${i})`);
            }
            const finalRef = ref.series[ref.series.length - 1];
            assert.ok(Math.abs(analyzer.normalizedEntropy - finalRef) <= TOL,
                'final PE must match the reference');
        }
    }
}

function testHurstMatchesReference() {
    for (const config of HURST_CONFIGS) {
        for (const { kind, seed, prices } of SERIES) {
            const ref = refHurst(config, prices);
            const analyzer = new HurstAnalyzer(config);
            for (let i = 0; i < prices.length; i++) {
                const result = analyzer.update(prices[i]);
                const expected = ref.series[i];
                assert.strictEqual(result.isReady, expected.ready,
                    `Hurst readiness mismatch (${kind}/${seed}/w=${config.window} bar ${i})`);
                if (!expected.ready) continue;
                assert.ok(Math.abs(analyzer.hurst - expected.hurst) <= 1e-9,
                    `Hurst mismatch (${kind}/${seed}/w=${config.window} bar ${i}): ${analyzer.hurst} vs ${expected.hurst}`);
                assert.strictEqual(result.hurst, roundTo(expected.hurst, 1000),
                    `rounded Hurst mismatch (${kind}/${seed} bar ${i})`);
            }
        }
    }
}

function testAnalyzerRejectsInvalidPrices() {
    for (const Analyzer of [PermutationEntropyAnalyzer, HurstAnalyzer]) {
        const analyzer = new Analyzer({});
        assert.throws(() => analyzer.update(0), /positive finite/, `${Analyzer.name} must reject 0`);
        assert.throws(() => analyzer.update(-1), /positive finite/, `${Analyzer.name} must reject negatives`);
        assert.throws(() => analyzer.update(Number.NaN), /positive finite/, `${Analyzer.name} must reject NaN`);
    }
}

function testRegimeMultiplierIsUnchangedByTheCycleCache() {
    const prices = makeSeries('random', 800, 4242);
    for (const opts of [
        { regimeSensitivity: 1 },
        { regimeSensitivity: 1, hurstZoneBand: 0.08 },
        { regimeSensitivity: 0.5, peNodes: [0.55, 0.7, 0.9] },
    ]) {
        // Baseline: no cache key -> always a cold computation.
        const cold = computeRegimeMultiplier(prices, opts);
        // Same input, now through the cross-cycle cache.
        const warm1 = computeRegimeMultiplier(prices, { ...opts, cacheKey: 'unit:1' });
        const warm2 = computeRegimeMultiplier(prices, { ...opts, cacheKey: 'unit:1' });
        for (const [label, other] of [['cold-vs-warm', warm1], ['warm-vs-warm', warm2]]) {
            assert.strictEqual(other.multiplier, cold.multiplier, `${label}: multiplier drifted`);
            assert.strictEqual(other.hurst, cold.hurst, `${label}: hurst drifted`);
            assert.strictEqual(other.pe, cold.pe, `${label}: pe drifted`);
            assert.strictEqual(other.series.length, cold.series.length, `${label}: series length drifted`);
            for (let i = 0; i < cold.series.length; i++) {
                assert.strictEqual(other.series[i], cold.series[i], `${label}: series[${i}] drifted`);
            }
        }
    }
}

function testRegimeCacheMatchesColdRunOnAnExtendedSeries() {
    // The hourly case: the cached run sees a 781-bar window, then the same
    // window one bar longer. Both must equal a from-scratch computation.
    const prices = makeSeries('random', 800, 31337);
    const opts = { regimeSensitivity: 1, cacheKey: 'unit:extend' };
    // Sample lengths rather than every one: each iteration runs a full cold +
    // cached analysis, and the cache is deterministic, so a stride still
    // catches a resume/prefix regression (and always checks the final length).
    const lengths: number[] = [];
    for (let length = 700; length < prices.length; length += 20) lengths.push(length);
    lengths.push(prices.length);
    for (const length of lengths) {
        const window = prices.slice(0, length);
        const cached = computeRegimeMultiplier(window, opts);
        const cold = computeRegimeMultiplier(window, { regimeSensitivity: opts.regimeSensitivity });
        assert.strictEqual(cached.series.length, cold.series.length, `series length at ${length}`);
        for (let i = 0; i < cold.series.length; i++) {
            assert.strictEqual(cached.series[i], cold.series[i], `series[${i}] drifted at length ${length}`);
        }
        assert.strictEqual(cached.multiplier, cold.multiplier, `multiplier drifted at length ${length}`);
    }
}

/**
 * The production shape: the adapter caps the analysis window, so once history
 * saturates every hourly cycle SLIDES the window by one bar (drop the oldest,
 * append the new one). A strict "cached is a prefix of incoming" test misses
 * every one of those cycles, so the resume has to tolerate a leading drop.
 *
 * What a slide can and cannot preserve, checked here for the production config
 * and two analyzer configurations:
 *
 *   1. The headline multiplier must match a from-scratch run exactly.
 *   2. Every bar the analyzers actually produced (from the cold run's first
 *      ready index onwards) must match exactly. This is every bar the service
 *      can act on: regimeMultipliers is applied to a per-bar offset that is
 *      itself zero before the AMA/Kalman channels are ready.
 *   3. In the warmup prefix the only permitted difference is a ONE-BAR warmup
 *      offset — the warm analyzer pair has been fed one more bar in total than
 *      a freshly created one, so it becomes ready one bar earlier. A different
 *      non-neutral VALUE in the prefix would mean cached state leaked into a bar
 *      it does not belong to, and fails this test.
 */
function testRegimeCacheMatchesColdRunOnASlidingWindow() {
    const prices = makeSeries('random', 3000, 8675309);
    const CAP = 782;
    const variants = [
        { label: 'production config', opts: {} },
        { label: 'small analyzer windows', opts: { hurstCfg: { window: 16, scales: [4, 8, 16] }, peCfg: { m: 3, delay: 1, window: 10 } } },
        { label: 'delay 2 / wide PE window', opts: { hurstCfg: { window: 64, scales: [8, 16, 32] }, peCfg: { m: 5, delay: 2, window: 24 } } },
    ];
    for (const { label, opts: variant } of variants) {
        _resetRegimeCache();
        // Sample the slide at a coarse stride: each end runs a full cold + cached
        // analysis, and the cached result is deterministic, so a handful of
        // offsets across the range still catches a resume/prefix regression
        // (the alignment rules themselves are pinned by testResumeAlignmentRules).
        for (let end = 1200; end < 1260; end += 12) {
            const window = prices.slice(Math.max(0, end - CAP + 1), end + 1);
            const warm = computeRegimeMultiplier(window, { regimeSensitivity: 1, cacheKey: `unit:slide:${label}`, ...variant });
            const cold = computeRegimeMultiplier(window, { regimeSensitivity: 1, ...variant });
            const where = `${label} at end=${end}`;
            assert.strictEqual(warm.multiplier, cold.multiplier, `${where}: multiplier drifted`);
            assert.strictEqual(warm.series.length, cold.series.length, `${where}: series length`);
            let readyFrom = cold.series.length;
            for (let i = 0; i < cold.series.length; i++) {
                if (cold.series[i] === 1.0) continue;
                readyFrom = i;
                break;
            }
            for (let i = 0; i < readyFrom; i++) {
                if (warm.series[i] === cold.series[i]) continue;
                assert.strictEqual(cold.series[i], 1.0,
                    `${where}: series[${i}] differs inside the warmup prefix with a non-neutral cold value — `
                    + `cached state leaked (warm=${warm.series[i]}, cold=${cold.series[i]})`);
                assert.notStrictEqual(warm.series[i], 1.0,
                    `${where}: series[${i}] differs inside the warmup prefix with a non-neutral warm value`);
            }
            for (let i = readyFrom; i < cold.series.length; i++) {
                assert.strictEqual(warm.series[i], cold.series[i], `${where}: series[${i}] drifted`);
            }
        }
    }
    _resetRegimeCache();
}

/**
 * The sliding tolerance must not let an UNRELATED window reuse cached state:
 * a rewritten bar, a different market, and a window that shrank below the
 * analyzers' rolling buffer all have to fall back to a full recomputation.
 */
function testRegimeCacheRefusesUnrelatedWindows() {
    const prices = makeSeries('random', 3000, 424242);
    const CAP = 782;
    const at = (end: number) => prices.slice(Math.max(0, end - CAP + 1), end + 1);
    const agrees = (warm: any, cold: any, label: string) => {
        assert.strictEqual(warm.multiplier, cold.multiplier, `${label}: multiplier must match a cold run`);
        assert.strictEqual(warm.series.length, cold.series.length, `${label}: series length`);
        for (let i = 0; i < cold.series.length; i++) {
            assert.strictEqual(warm.series[i], cold.series[i], `${label}: series[${i}] must match a cold run`);
        }
    };

    // A corrected bar inside the shared region is not "the same window advanced".
    _resetRegimeCache();
    computeRegimeMultiplier(at(1200), { regimeSensitivity: 1, cacheKey: 'unit:unrelated:rewrite' });
    const corrected = at(1201);
    corrected[400] *= 1.0001;
    agrees(computeRegimeMultiplier(corrected, { regimeSensitivity: 1, cacheKey: 'unit:unrelated:rewrite' }),
        computeRegimeMultiplier(corrected, { regimeSensitivity: 1 }), 'rewritten bar');

    // A different market reusing the key must not inherit the cached state.
    _resetRegimeCache();
    const other = prices.map((p) => p * 3.7);
    computeRegimeMultiplier(at(1200), { regimeSensitivity: 1, cacheKey: 'unit:unrelated:market' });
    const foreign = other.slice(0, CAP);
    agrees(computeRegimeMultiplier(foreign, { regimeSensitivity: 1, cacheKey: 'unit:unrelated:market' }),
        computeRegimeMultiplier(foreign, { regimeSensitivity: 1 }), 'different market');

    // Shrinking below the analyzers' buffer leaves too little shared history.
    _resetRegimeCache();
    const short = prices.slice(0, 25);
    computeRegimeMultiplier(short, { regimeSensitivity: 1, cacheKey: 'unit:unrelated:shrink' });
    agrees(computeRegimeMultiplier(short.slice(0, 20), { regimeSensitivity: 1, cacheKey: 'unit:unrelated:shrink' }),
        computeRegimeMultiplier(short.slice(0, 20), { regimeSensitivity: 1 }), 'sub-buffer shrink');
    _resetRegimeCache();
}

/**
 * A bar the analyzers reject (non-positive) must leave the neutral 1.0 in place
 * rather than a hole: the service copies the per-bar series only when its length
 * matches the closes array.
 */
function testRegimeSeriesHasNoHolesWhenABarIsRejected() {
    const prices = makeSeries('random', 800, 9090);
    const holed = prices.slice();
    holed[700] = -1;
    _resetRegimeCache();
    computeRegimeMultiplier(holed, { regimeSensitivity: 1, cacheKey: 'unit:hole' });
    const warm = computeRegimeMultiplier(holed, { regimeSensitivity: 1, cacheKey: 'unit:hole' });
    const cold = computeRegimeMultiplier(holed, { regimeSensitivity: 1 });
    assert.strictEqual(warm.series.length, cold.series.length, 'series length must cover every close');
    for (let i = 0; i < warm.series.length; i++) {
        assert.notStrictEqual(warm.series[i], undefined, `series[${i}] must not be a hole`);
    }
    for (let i = 0; i < cold.series.length; i++) {
        assert.strictEqual(warm.series[i], cold.series[i], `series[${i}] must match a cold run`);
    }
    _resetRegimeCache();
}

/**
 * The resume's shared-history requirement comes from the analyzer INSTANCES
 * (bufferBars), never from a mirrored copy of their constructor defaults. A
 * caller that leaves part of an analyzer config out must still get the correct
 * requirement: with peConfig: {} the PE analyzer falls back to its own defaults
 * (window 100, m 5, delay 1 -> 104 bars), which a naive mirror reads as 0.
 */
function testResumeUsesTheAnalyzersOwnBufferSize() {
    const { HurstAnalyzer } = require('../market_adapter/core/signals/hurst_analyzer');
    const { PermutationEntropyAnalyzer } = require('../market_adapter/core/signals/permutation_entropy_analyzer');
    const { _analyzerBufferSize } = require('../market_adapter/core/strategies/regime_gate').__test;

    const hurst = new HurstAnalyzer({});
    const pe = new PermutationEntropyAnalyzer({});
    assert.strictEqual(pe.bufferBars, pe._bufSize, 'PE bufferBars must be the real rolling buffer length');
    assert.strictEqual(hurst.bufferBars, hurst.window + 1,
        'the Hurst buffer holds window+1 prices (returns span [0..window])');

    // The requirement is read off the analyzers, so a config left partly out can
    // never shrink it: an empty PE config still reserves its own defaults
    // (window 100, m 5, delay 1 -> 104 bars), where a mirror of
    // "peCfg.window + (m-1)*delay" would have read 0.
    assert.strictEqual(_analyzerBufferSize(hurst, pe), Math.max(hurst.bufferBars, pe.bufferBars),
        'the shared-history requirement must come from the analyzer instances');
    assert.ok(new PermutationEntropyAnalyzer({}).bufferBars > 100,
        'an empty PE config must still reserve its default buffer');

    // Fail closed: anything that cannot report a usable size disables resuming
    // for that entry rather than guessing a too-small requirement.
    assert.strictEqual(_analyzerBufferSize(hurst, {}), Number.MAX_SAFE_INTEGER,
        'an analyzer without bufferBars must fail closed');
    assert.strictEqual(_analyzerBufferSize(null, null), Number.MAX_SAFE_INTEGER,
        'missing analyzers must fail closed');
    assert.strictEqual(_analyzerBufferSize(hurst, { bufferBars: 0 }), Number.MAX_SAFE_INTEGER,
        'a non-positive bufferBars must fail closed');
}

/**
 * Alignment rules of the resume, tested directly so the paths are pinned rather
 * than inferred through timings:
 *   - a growing window resumes with k = 0;
 *   - the production slide resumes with k = 1;
 *   - a scan that first meets a NEWER match than the cached window allows must
 *     keep scanning (it used to stop there and miss the valid alignment);
 *   - repeated closes make the alignment ambiguous, and the resume declines
 *     instead of guessing — a wrong pick would pin the memoized state to the
 *     wrong bar and leave it permanently one bar stale.
 */
function testResumeAlignmentRules() {
    const cases: Array<[string, number[], number[], any]> = [
        ['growing window resumes with k=0', [1, 2, 3], [1, 2, 3, 4], { k: 0, shared: 3 }],
        ['production slide resumes with k=1', [1, 2, 3], [2, 3, 4], { k: 1, shared: 2 }],
        ['multi-bar jump resumes', [1, 2, 3, 4, 5], [3, 4, 5, 6, 7, 8], { k: 2, shared: 3 }],
        // closes[3] duplicates the cached newest bar, so the scan meets a NEWER
        // match (k = -1) before the valid one. Stopping there used to miss it.
        ['a newer duplicate must not stop the scan', [1, 2, 3], [1, 2, 3, 3, 4], { k: 0, shared: 3 }],
    ];
    for (const [label, cached, closes, expected] of cases) {
        assert.deepStrictEqual(_locateResume(cached, closes, 1), expected, label);
    }

    // Ambiguous: every shift of a flat window verifies, so no alignment can be
    // trusted.
    assert.strictEqual(_locateResume([5, 5, 5, 5], [5, 5, 5, 5, 5], 1), null,
        'repeated closes must decline rather than pick an alignment');
    assert.deepStrictEqual(_locateResume([5, 5, 5, 5], [5, 5, 5, 5], 1), { k: 0, shared: 4 },
        'an UNCHANGED flat window is unambiguous and resumes');

    // Unrelated windows never resume.
    assert.strictEqual(_locateResume([1, 2, 3], [9, 9, 9], 1), null, 'a different market must not resume');
    assert.strictEqual(_locateResume([1, 2, 3, 4], [2, 3], 1), null, 'a shorter window must not resume');
    assert.strictEqual(_locateResume([1, 2, 3], [2, 3, 4], 4), null,
        'a shared region shorter than minShared must not resume');
}

/**
 * Repeated closes must never yield a stale memoized state: whatever the resume
 * decides, the result equals a from-scratch run.
 */
function testAmbiguousRepeatedClosesDoNotResume() {
    for (const [kind, seed] of [['sawtooth', 99], ['flat', 5]] as Array<[string, number]>) {
        const prices = makeSeries(kind, 400, seed);
        const CAP = 120;
        const at = (end: number) => prices.slice(Math.max(0, end - CAP + 1), end + 1);
        _resetRegimeCache();
        for (let end = 200; end < 206; end++) {
            const window = at(end);
            const warm = computeRegimeMultiplier(window, { regimeSensitivity: 1, cacheKey: `unit:ambiguous:${kind}` });
            const cold = computeRegimeMultiplier(window, { regimeSensitivity: 1 });
            assert.strictEqual(warm.multiplier, cold.multiplier, `${kind}: multiplier must match a cold run at end=${end}`);
            assert.strictEqual(warm.series.length, cold.series.length, `${kind}: series length at end=${end}`);
            for (let i = 0; i < cold.series.length; i++) {
                assert.strictEqual(warm.series[i], cold.series[i], `${kind}: series[${i}] must match a cold run at end=${end}`);
            }
        }
        _resetRegimeCache();
    }
}

function testRegimeCacheRebuildsWhenHistoryChanges() {
    const prices = makeSeries('random', 800, 5150);
    const opts = { regimeSensitivity: 1, cacheKey: 'unit:rewrite' };
    computeRegimeMultiplier(prices, opts);
    // A gap repair / correction rewrites history in the middle: the cached
    // analyzers must be discarded, not continued from a stale prefix.
    const rewritten = prices.slice();
    rewritten[400] = rewritten[400] * 1.5;
    const afterRewrite = computeRegimeMultiplier(rewritten, opts);
    const cold = computeRegimeMultiplier(rewritten, { regimeSensitivity: 1 });
    assert.strictEqual(afterRewrite.multiplier, cold.multiplier, 'multiplier must match after a history rewrite');
    for (let i = 0; i < cold.series.length; i++) {
        assert.strictEqual(afterRewrite.series[i], cold.series[i], `series[${i}] must match after a history rewrite`);
    }
}

function testRegimeCacheSeparatesKeysAndParameters() {
    const prices = makeSeries('random', 800, 2718);
    const base = computeRegimeMultiplier(prices, { regimeSensitivity: 1, cacheKey: 'unit:a' });
    const other = computeRegimeMultiplier(prices, { regimeSensitivity: 1, cacheKey: 'unit:b' });
    const stiffer = computeRegimeMultiplier(prices, { regimeSensitivity: 1, hurstZoneBand: 0.2, cacheKey: 'unit:a' });
    const noKey = computeRegimeMultiplier(prices, { regimeSensitivity: 1 });
    const stifferCold = computeRegimeMultiplier(prices, { regimeSensitivity: 1, hurstZoneBand: 0.2 });
    assert.strictEqual(base.multiplier, other.multiplier, 'two keys over the same series must agree');
    assert.strictEqual(base.multiplier, noKey.multiplier, 'cached and uncached must agree');
    // A parameter change under a reused key must not reuse the old series.
    assert.strictEqual(stiffer.series.length, stifferCold.series.length, 'series length must follow the new parameters');
    for (let i = 0; i < stifferCold.series.length; i++) {
        assert.strictEqual(stiffer.series[i], stifferCold.series[i], `series[${i}] must follow the new parameters`);
    }
    assert.strictEqual(stiffer.multiplier, stifferCold.multiplier, 'multiplier must follow the new parameters');
}

function testRegimeMultiplierHandlesShortAndInvalidInput() {
    assert.strictEqual(computeRegimeMultiplier([], { regimeSensitivity: 1 }).isReady, false);
    assert.strictEqual(computeRegimeMultiplier([1, 2, 3], { regimeSensitivity: 1 }).isReady, false);
    const short = computeRegimeMultiplier([100, 101, 102, 103], { regimeSensitivity: 1, cacheKey: 'unit:short' });
    assert.strictEqual(short.isReady, false, 'a series shorter than the Hurst warmup is not ready');
    assert.deepStrictEqual(short.series, [], 'unready regime gate exposes no series');

    const withInvalid = computeRegimeMultiplier(
        [100, 0, 102, Number.NaN, 104, 105],
        { regimeSensitivity: 1, cacheKey: 'unit:invalid' }
    );
    assert.strictEqual(withInvalid.isReady, false, 'invalid prices are skipped, not fed');
}

function testProductionConfigIsTheOneBenchmarked() {
    // Guards the perf claims in the analyzer headers: the equivalence sweep
    // above must cover the configs the adapter actually runs with.
    assert.strictEqual(MARKET_ADAPTER.PE_CONFIG.m, 5);
    assert.strictEqual(MARKET_ADAPTER.PE_CONFIG.delay, 1);
    assert.strictEqual(MARKET_ADAPTER.PE_CONFIG.window, 54);
    assert.strictEqual(MARKET_ADAPTER.HURST_CONFIG.window, 256);
    assert.deepStrictEqual(MARKET_ADAPTER.HURST_CONFIG.scales, [8, 16, 32, 64]);
}

testPermutationEntropyMatchesReference();
testHurstMatchesReference();
testAnalyzerRejectsInvalidPrices();
testRegimeMultiplierIsUnchangedByTheCycleCache();
testRegimeCacheMatchesColdRunOnAnExtendedSeries();
testRegimeCacheMatchesColdRunOnASlidingWindow();
testRegimeCacheRefusesUnrelatedWindows();
testResumeUsesTheAnalyzersOwnBufferSize();
testResumeAlignmentRules();
testAmbiguousRepeatedClosesDoNotResume();
testRegimeSeriesHasNoHolesWhenABarIsRejected();
testRegimeCacheRebuildsWhenHistoryChanges();
testRegimeCacheSeparatesKeysAndParameters();
testRegimeMultiplierHandlesShortAndInvalidInput();
testProductionConfigIsTheOneBenchmarked();

console.log('All market adapter entropy equivalence tests passed');

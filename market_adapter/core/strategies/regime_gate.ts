'use strict';

import { HurstAnalyzer, classifyHurst } from '../signals/hurst_analyzer.js';
import { PermutationEntropyAnalyzer } from '../signals/permutation_entropy_analyzer.js';
import { MARKET_ADAPTER } from '../../../modules/constants.js';
import { roundTo } from '../../../modules/order/utils/math.js';
import { bilinearInterpolate } from './regime_interp.js';

const HURST_CONFIG = MARKET_ADAPTER.HURST_CONFIG;
const PE_CONFIG = MARKET_ADAPTER.PE_CONFIG;

/**
 * Cross-cycle memoization for the regime gate.
 *
 * The adapter runs one cycle per hour per bot, but only ONE new candle closes in
 * that window, and the Hurst/PE state at bar i depends solely on the previous
 * `window` prices. Re-creating both analyzers and re-feeding all ~780 closes
 * every hour therefore recomputed ~99.8% of the same numbers — the single
 * largest CPU item in a cycle.
 *
 * When the caller supplies a stable `cacheKey` (the adapter passes
 * `<botKey>:<intervalSeconds>`), the analyzers and the already-computed
 * per-bar series are kept per key. The next cycle resumes the memoized state
 * when the regime parameters are unchanged and the incoming window is the
 * cached one advanced: same bars, with k leading bars dropped and m new bars
 * appended. A gap repair, a corrected bar, a rewritten value, a different
 * market or a config change all fail that check and fall back to a full
 * recomputation. The resumed result is bit-identical to a from-scratch run in
 * the headline multiplier and in every bar from that run's first ready bar
 * onwards; the pre-warmup prefix can differ by the one-bar readiness offset
 * described below. See tests/test_market_adapter_entropy_equivalence.ts.
 *
 * The leading-drop tolerance is what makes this worthwhile in production: the
 * adapter caps the analysis window (rawKeepCount + analysisKeepCount), so once
 * history saturates every hourly cycle SLIDES the window by one bar. A
 * strict "cached is a prefix of incoming" test misses every one of those
 * cycles. It is safe because both analyzers are rolling: their state depends
 * only on the last `bufferSize` bars, so as long as the shared region still
 * covers that much history, feeding only the new bars lands on exactly the
 * state a cold replay of the whole window would produce.
 *
 * What a resume does NOT reproduce: the warmup boundary in the historical
 * prefix. A warm analyzer pair has been fed one more bar in total than a freshly
 * created one, so it reports its first value one bar earlier. Only the prefix
 * is affected — the headline multiplier and every bar from the cold run's first
 * ready index onwards are identical, which is every bar the service can act on
 * (regimeMultipliers scales a per-bar offset that is itself zero before the
 * AMA/Kalman channels are ready). See
 * tests/test_market_adapter_entropy_equivalence.ts.
 *
 * Without a `cacheKey` the function is stateless, exactly as before.
 */
const REGIME_CACHE_LIMIT = 32;
const _regimeCache = new Map<string, RegimeCacheEntry>();

interface RegimeCacheEntry {
    paramsKey: string;
    closes: number[];
    series: number[];
    hurst: HurstAnalyzer;
    pe: PermutationEntropyAnalyzer;
}

/**
 * How many bars of history the analyzers' rolling state can depend on.
 *
 * Taken from the analyzer INSTANCES (each exposes `bufferBars`), never from a
 * second copy of their constructor defaults: a mirrored formula silently
 * under-estimates whenever a default or a buffer formula changes. Being too
 * large only costs a missed resume; being too small would let the resume carry
 * `cached.series` entries that were computed from bars the incoming window no
 * longer contains (the analyzers' final state is unaffected either way — see
 * _locateResume). An analyzer that does not report a usable size fails closed
 * (MAX_SAFE_INTEGER), which disables resuming for that cache entry.
 */
function _analyzerBufferSize(hurst: { bufferBars?: unknown } | null | undefined, pe: { bufferBars?: unknown } | null | undefined): number {
    const sizes = [Number(hurst?.bufferBars), Number(pe?.bufferBars)]
        .filter((value) => Number.isFinite(value) && value > 0);
    if (sizes.length !== 2) return Number.MAX_SAFE_INTEGER;
    return Math.max(sizes[0], sizes[1]);
}

/**
 * Locate how `closes` advances the cached window, or null when they are not
 * related that way.
 *
 * Returns `{ k, shared }` where `closes[0..shared)` is exactly
 * `cached[k..cached.length)` — i.e. the incoming window dropped k leading bars
 * and appended `closes.length - shared` new ones. `k = 0, shared =
 * cached.length` is the plain "one or more bars were added" case.
 *
 * The shift is pinned by matching the cached window's newest bar inside the
 * incoming window, then the ENTIRE shared region is verified, so a coincidental
 * price match cannot pass. NaN-aware, like the pre-cache implementation.
 *
 * When the cached newest bar occurs at more than one position and more than one
 * candidate alignment verifies, the window is ambiguous and the function
 * declines to resume. This is hygiene, not a safety requirement: any verified
 * alignment with `shared >= minShared` is exact by construction, because that
 * requirement guarantees the resumed stream's last `bufferBars` values are the
 * same values the incoming stream ends with — the analyzers are rolling, so
 * their final state (and every series entry from that point on) is identical
 * whichever alignment is chosen. Declining only avoids anchoring the
 * `cached.series` carry-over — whose early entries rest on bars the window may
 * no longer contain — to a pattern match we did not intend. It can only arise
 * on degenerate periodic windows, and a cold recompute there is cheap and
 * honest.
 */
function _locateResume(cached: number[], closes: number[], minShared: number): { k: number; shared: number } | null {
    if (cached.length === 0 || closes.length === 0) return null;
    if (cached.length > closes.length) return null;

    // Unchanged window: no scan needed, and no ambiguity to resolve.
    if (cached.length === closes.length) {
        let identical = true;
        for (let i = 0; i < cached.length; i++) {
            if (cached[i] === closes[i] || (Number.isNaN(cached[i]) && Number.isNaN(closes[i]))) continue;
            identical = false;
            break;
        }
        if (identical) return minShared <= cached.length ? { k: 0, shared: cached.length } : null;
    }

    const newest = cached[cached.length - 1];
    let found: { k: number; shared: number } | null = null;
    // Newest match first, so the alignment that drops the fewest bars wins.
    for (let p = closes.length - 1; p >= 0; p--) {
        if (!(closes[p] === newest || (Number.isNaN(closes[p]) && Number.isNaN(newest)))) continue;
        const k = cached.length - 1 - p;
        // k < 0 means the match sits beyond the cached window: not this
        // alignment, but a smaller p may still hold the right one.
        if (k < 0) continue;
        const shared = cached.length - k;
        if (shared < minShared) return null;    // too little history survives the slide
        let ok = true;
        for (let j = k; j < cached.length; j++) {
            const a = cached[j];
            const b = closes[j - k];
            if (a === b || (Number.isNaN(a) && Number.isNaN(b))) continue;
            ok = false;
            break;
        }
        if (!ok) continue;
        if (found) return null;                 // ambiguous: repeated closes
        found = { k, shared };
    }
    return found;
}

function regimeParamsKey(sensitivity: number, regimeTable: unknown, hurstZoneBand: number, peNodes: unknown, hurstCfg: unknown, peCfg: unknown): string {
    return JSON.stringify([sensitivity, regimeTable, hurstZoneBand, peNodes, hurstCfg, peCfg]);
}

/**
 * Drop all memoized analyzer state.
 *
 * A test seam today, not a runtime path: the cycle resolves its parameters once
 * per run, so there is no in-process config reload to invalidate state for, and
 * a parameter change is already detected by `regimeParamsKey` (it forces a full
 * recompute). Production never calls this — it exists so a test can assert a
 * cold run against a warm cache without leaking entries between cases.
 */
function _resetRegimeCache(): void {
    _regimeCache.clear();
}

function resolvePeNodes(peNodes: unknown = null): number[] {
    if (Array.isArray(peNodes) && peNodes.length === 3 && peNodes.every(Number.isFinite)) {
        return peNodes as number[];
    }
    return MARKET_ADAPTER.PE_NODES;
}

/**
 * A regime table must be a 3x3 matrix of finite numbers — bilinear
 * interpolation indexes it blindly, and a malformed custom table would
 * otherwise produce NaN multipliers that propagate silently into weights.
 */
function isValidRegimeTable(table: unknown): boolean {
    return Array.isArray(table)
        && table.length === 3
        && table.every((row: unknown) => Array.isArray(row)
            && row.length === 3
            && row.every((v: unknown) => Number.isFinite(v)));
}

function classifyPeRegime(pe: number, peNodes: unknown = null): string {
    const [low, , high] = resolvePeNodes(peNodes);
    if (pe < low) return 'STRUCTURED';
    if (pe > high) return 'NOISE';
    return 'MIXED';
}

/**
 * Compute the Hurst+PE regime multiplier from a price series.
 *
 * Bilinear interpolation over the 3×3 regime table is delegated to the
 * canonical pure implementation in strategies/regime_interp.ts (shared with the
 * browser-embedded chart scripts).
 *
 * Feeds prices through HurstAnalyzer and PermutationEntropyAnalyzer,
 * then bilinear-interpolates the regime table to produce a multiplier that
 * gates the AMA slope offset in production weight computation. When
 * `opts.cacheKey` is set, a window that ADVANCES the memoized one (k leading
 * bars dropped, m appended) resumes from the cached analyzer state and feeds
 * only the appended bars; anything else recomputes from scratch. See the cache
 * notes above.
 *
 * @param {number[]} closes          - Full close price series (same array used for AMA)
 * @param {Object}   [opts]
 * @param {number}   [opts.regimeSensitivity=1.0] - Exponent on the base multiplier (0=off, 1=default)
 * @param {Array}    [opts.regimeTable]           - Custom 3x3 regime multiplier table
 * @param {number}   [opts.hurstZoneBand]         - Override Hurst neutral-zone width
 * @param {Array}    [opts.peNodes]               - Override entropy thresholds
 * @param {string}   [opts.cacheKey]              - Stable per-market key enabling cross-cycle reuse
 * @param {Object}   [opts.hurstConfig]           - Override for HurstAnalyzer config
 * @param {Object}   [opts.peConfig]              - Override for PermutationEntropyAnalyzer config
 * @returns {{ multiplier: number, hurst: number|null, pe: number|null,
 *             hurstRegime: string|null, peRegime: string|null, isReady: boolean,
 *             series: number[] }}
 */
interface RegimeOpts {
    regimeSensitivity?: number;
    regimeTable?: unknown;
    hurstZoneBand?: number;
    peNodes?: unknown;
    cacheKey?: string;
    hurstConfig?: { window?: number; scales?: number[] };
    peConfig?: Record<string, number>;
}

export interface RegimeMultiplierResult {
    multiplier: number;
    hurst: number | null;
    pe: number | null;
    hurstRegime: string | null;
    peRegime: string | null;
    isReady: boolean;
    series: number[];
}

function computeRegimeMultiplier(closes: unknown, opts: RegimeOpts = {}): RegimeMultiplierResult {
    const sensitivity = Number.isFinite(opts.regimeSensitivity) ? (opts.regimeSensitivity as number) : 1.0;
    const regimeTable = opts.regimeTable ?? MARKET_ADAPTER.REGIME_TABLE;
    // Fail loudly on a malformed custom table instead of silently producing
    // NaN multipliers downstream.
    if (!isValidRegimeTable(regimeTable)) {
        throw new Error('regimeTable must be a 3x3 matrix of finite numbers');
    }
    const hurstZoneBand = Number.isFinite(opts.hurstZoneBand) ? (opts.hurstZoneBand as number) : MARKET_ADAPTER.HURST_ZONE_BAND;
    const peNodes = Array.isArray(opts.peNodes) ? opts.peNodes : MARKET_ADAPTER.PE_NODES;
    const hurstCfg = opts.hurstConfig ?? HURST_CONFIG;
    const peCfg    = opts.peConfig    ?? PE_CONFIG;
    const cacheKey = typeof opts.cacheKey === 'string' && opts.cacheKey !== '' ? opts.cacheKey : null;

    // Clamp to 1.0 max: regime only dampens, never amplifies. The
    // sensitivity exponent is applied in one place for both the per-bar
    // series and the final value.
    const applySensitivityAndClamp = (baseMult: number) =>
        Math.min(sensitivity === 1.0 ? baseMult : Math.pow(baseMult, sensitivity), 1.0);

    const notReady: RegimeMultiplierResult = {
        multiplier: 1.0,
        hurst: null,
        pe: null,
        hurstRegime: null,
        peRegime: null,
        isReady: false,
        series: [],
    };

    if (!Array.isArray(closes) || closes.length === 0) return notReady;

    const paramsKey = regimeParamsKey(sensitivity, regimeTable, hurstZoneBand, peNodes, hurstCfg, peCfg);
    const cached = cacheKey ? _regimeCache.get(cacheKey) : null;
    const resume = (cached && cached.paramsKey === paramsKey)
        ? _locateResume(cached.closes, closes, _analyzerBufferSize(cached.hurst, cached.pe))
        : null;
    const resumable = !!resume;
    const cachedEntry = cached as RegimeCacheEntry;

    const hurst = resumable ? cachedEntry.hurst : new HurstAnalyzer(hurstCfg);
    const pe    = resumable ? cachedEntry.pe    : new PermutationEntropyAnalyzer(peCfg);
    // Index-aligned with `closes`, exactly like the pre-cache implementation.
    // The neutral 1.0 fill also covers bars the loop below does not produce a
    // value for (warmup, or a non-finite price it skips): a resumed run must
    // never come back with a hole the cold path would have filled.
    const series: number[] = new Array(closes.length).fill(1.0);
    // cached.series[i] was computed for cached.closes[i] === closes[i - k].
    const startIndex = resumable ? resume!.shared : 0;
    if (resumable) {
        for (let i = 0; i < startIndex; i++) {
            const carried = cachedEntry.series[i + resume!.k];
            if (carried !== undefined) series[i] = carried;
        }
    }

    let hurstResult: ReturnType<HurstAnalyzer['update']> | null = null;
    let peResult: ReturnType<PermutationEntropyAnalyzer['update']> | null = null;

    for (let i = startIndex; i < closes.length; i++) {
        const price = closes[i];
        if (!Number.isFinite(price) || price <= 0) continue;
        try {
            hurstResult = hurst.update(price);
            peResult    = pe.update(price);
            if (hurstResult?.isReady && peResult?.isReady) {
                const h  = hurstResult.hurst;
                const ne = peResult.normalizedEntropy;
                const baseMult = bilinearInterpolate(h, ne, regimeTable, { hurstZoneBand, peNodes });
                series[i] = applySensitivityAndClamp(baseMult);
            }
        } catch (_) {
            // skip invalid prices (analyzers throw only on non-positive prices)
        }
    }

    if (cacheKey) {
        const entry: RegimeCacheEntry = {
            paramsKey,
            closes: closes.slice(),
            series: series.slice(),
            hurst,
            pe,
        };
        // Re-insert so the Map's insertion order stays a usable LRU order.
        _regimeCache.delete(cacheKey);
        _regimeCache.set(cacheKey, entry);
        while (_regimeCache.size > REGIME_CACHE_LIMIT) {
            const oldest = _regimeCache.keys().next();
            if (oldest.done) break;
            _regimeCache.delete(oldest.value);
        }
    }

    // A resumed cycle can legitimately have no new bar to feed (the window is
    // unchanged since the last call); the analyzers already hold that state.
    if (!hurstResult) hurstResult = hurst.getAnalysis();
    if (!peResult) peResult = pe.getAnalysis();

    if (!hurstResult?.isReady || !peResult?.isReady) return notReady;

    const h  = hurstResult.hurst;
    const ne = peResult.normalizedEntropy;

    const baseMult  = bilinearInterpolate(h, ne, regimeTable, { hurstZoneBand, peNodes });
    const finalMult = applySensitivityAndClamp(baseMult);

    return {
        multiplier:  roundTo(finalMult, 1000),
        hurst:       h,
        pe:          roundTo(ne, 10000),
        hurstRegime: classifyHurst(h, hurstZoneBand).regime,
        peRegime:    classifyPeRegime(ne, peNodes),
        isReady:     true,
        series:      series.map((value) => roundTo(value, 1000)),
    };
}

export { computeRegimeMultiplier }

/** Internal seams exercised directly by tests. */
export const __test = { _resetRegimeCache, _locateResume, _analyzerBufferSize };

'use strict';

import { calculateATR } from './strategies/atr/calculator.js';
import { normalizeMarketSource, hasNumericStartPrice, resolveMarketSourceForBot } from '../utils/chain.js';
import type { RegimeMultiplierResult } from './strategies/regime_gate.js';
import { computeRegimeMultiplier } from './strategies/regime_gate.js';
import { noteJsonWritten, readCachedJson } from '../utils/file_json_cache.js';
import type { AmaParams } from './strategies/ama.js';
import { calculateAMA, getAmaWarmupBars } from './strategies/ama.js';
import { computeDynamicWeightSeries, computeAmaSlopeEmaSeries } from './strategies/dynamic_weight_series.js';
import { KalmanTrendAnalyzer } from './signals/kalman_trend_analyzer.js';
import { adjustCollateralRatio } from './strategies/collateral_manager.js';
import { DEFAULT_CONFIG, MARKET_ADAPTER } from '../../modules/constants.js';
import { resolveConfiguredPriceBound } from '../../modules/order/utils/order.js';
import { usesAmaGridPrice } from '../../modules/grid_price_source.js';
import Logger from '../../modules/order/logger.js';
import { roundTo } from '../../modules/order/utils/math.js';

import {
    computeAmaSlopeWeights,
    computeAmaSlopeClipThreshold,
} from './strategies/ama_slope_model.js';
import {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
    normalizeAmaSlopeEmaAlpha,
} from './config_normalizers.js';
import {
    buildKalmanVelocitySeries,
    computeAbsolutePercentileThreshold,
} from './signals/kalman_velocity_smoothing.js';
import {
    resolveMaxAsymmetryFactor,
    computeAsymmetricBoundsMetrics,
} from './asymmetric_bounds.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { bucketStartMs, latestClosedBucketStartMs as latestClosedBucket } from '../interval_utils.js';
const marketAdapterServiceLogger = new Logger('MarketAdapterService');

/** Loose JSON-object view used across the adapter service. */
type JsonObj = Record<string, unknown>;

/** Bot-config fields the service reads by name. */
/** Per-bot cached resolveBotContext entry. */
export interface ContextCacheEntry {
    signature?: unknown;
    ctx?: JsonObj | null;
    [key: string]: unknown;
}

/** Dynamic-weight config subset with structured sub-objects and numeric knobs. */
interface DynamicWeightsCfg extends JsonObj {
    amaSlope?: { neutralZonePct?: number; maxSlopePct?: number; emaAlpha?: number; persistBars?: number; persistEnabled?: boolean; deltaThresholdPct?: number; lookbackBars?: number; [key: string]: unknown };
    kalmanSlope?: { maxSlopePct?: number; [key: string]: unknown };
    kalman?: { rNoise?: number; qTactical?: number; qModal?: number; warmupBars?: number; [key: string]: unknown };
    asymmetricBounds?: JsonObj;
    absoluteThreshold?: number;
    alpha?: number;
    dw?: number;
    gain?: number;
    clipPercentile?: number;
    dispScaleMinPct?: number;
    kalmanDispScaleMult?: number;
    kalmanDispThresholdMult?: number;
    kalmanSmoothPct?: number;
    kalmanSmoothSpanPct?: number;
    maxSlopeOffset?: number;
    maxVolatilityOffset?: unknown;
    minOutputThreshold?: number;
    regimeSensitivity?: number;
    signalConfirmBars?: number;
    atrPeriod?: number;
    intervalSeconds?: number;
}

/** Arguments to `_computeDynamicWeights`. */
interface ComputeDynamicWeightsParams {
    closes: number[];
    amaValues: number[];
    lookbackBars: number;
    botAma: AmaParams;
    weightVariance: number;
    nowIso: string;
    cfg: DynamicWeightsCfg;
    bot: AdapterBotCfg;
    atrPeriod: number;
    [key: string]: unknown;
}

interface BotCycleResult extends JsonObj {
    ok: boolean;
    reason?: string;
    source?: string | null;
    marketSource?: string | null;
    amaPrice?: number | null;
    previousCenterPrice?: number | null;
    deltaPercent?: number | null;
    thresholdPercent?: number | null;
    weights?: { meta?: { finalOffset?: number | null; [key: string]: unknown } | null; [key: string]: unknown } | null;
    amaSlope?: { amaSlopeGated?: number | null; regimeMultiplier?: number | null; [key: string]: unknown } | null;
    dryRunMessages?: unknown[];
    staleData?: boolean;
}

interface AdapterState extends JsonObj {
    bots?: Record<string, JsonObj>;
}

interface AdapterBotCfg {
    name?: unknown;
    botKey?: unknown;
    minPrice?: unknown;
    maxPrice?: unknown;
    asymmetricBounds?: JsonObj;
    weightDistribution?: { sell?: number; buy?: number; [key: string]: unknown };
    [key: string]: unknown;
}

const AMA_SLOPE_PERCENT_MODE_PER_BAR = 'perBar';
const AMA_SLOPE_PERCENT_MODE_WINDOW = 'window';

function normalizeAmaSlopePercentMode(value: unknown){
    const text = String(value || '').trim().toLowerCase();
    if (['perbar', 'per_bar', 'per-bar', 'averageperbar', 'average_per_bar'].includes(text)) {
        return AMA_SLOPE_PERCENT_MODE_PER_BAR;
    }
    if (['window', 'lookback', 'cumulative', 'legacy'].includes(text)) {
        return AMA_SLOPE_PERCENT_MODE_WINDOW;
    }
    return null;
}

function normalizeAmaSlopeLookbackBars(value: unknown, fallback: number = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS){
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
    return fallback;
}

function convertSlopePercentToPerBar(value: unknown, lookbackBars: unknown, mode: unknown){
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return mode === AMA_SLOPE_PERCENT_MODE_PER_BAR
        ? n
        : n / normalizeAmaSlopeLookbackBars(lookbackBars);
}

function normalizePersistedAmaSlopeSnapshot(snapshot: unknown, lookbackBars: unknown, mode: unknown): JsonObj | null {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const s = snapshot as JsonObj;
    const normalized: JsonObj = { ...s };
    const slopePct = convertSlopePercentToPerBar(s.slopePct, lookbackBars, mode);
    if (Number.isFinite(slopePct)) {
        normalized.slopePct = slopePct;
    }
    return normalized;
}

function normalizePersistedAmaSlopeDiagnostics(data: unknown, lookbackBars: unknown): unknown {
    if (!data || typeof data !== 'object') return data;
    const d = data as JsonObj;
    const mode = normalizeAmaSlopePercentMode(d.amaSlopePercentMode) || AMA_SLOPE_PERCENT_MODE_WINDOW;
    const normalized: JsonObj = { ...d };
    normalized.amaSlopePercentMode = AMA_SLOPE_PERCENT_MODE_PER_BAR;
    normalized.amaSlope = normalizePersistedAmaSlopeSnapshot(d.amaSlope, lookbackBars, mode);
    normalized.gridRangeScalingAmaSlope = normalizePersistedAmaSlopeSnapshot(
        d.gridRangeScalingAmaSlope,
        lookbackBars,
        mode
    );
    const deltaPercent = convertSlopePercentToPerBar(d.amaSlopeDeltaPercent, lookbackBars, mode);
    const thresholdPercent = convertSlopePercentToPerBar(d.amaSlopeThresholdPercent, lookbackBars, mode);
    normalized.amaSlopeDeltaPercent = Number.isFinite(deltaPercent) ? deltaPercent : null;
    normalized.amaSlopeThresholdPercent = Number.isFinite(thresholdPercent) ? thresholdPercent : null;
    // Persistence-gate state carried across restarts (see advanceAmaSlopePersistence).
    const persistCount = Number(d.amaSlopePersistCount);
    normalized.amaSlopePersistCount = Number.isFinite(persistCount) && persistCount > 0 ? Math.floor(persistCount) : 0;
    const persistDir = Number(d.amaSlopePersistDir);
    normalized.amaSlopePersistDir = persistDir === 1 ? 1 : (persistDir === -1 ? -1 : 0);
    return normalized;
}

function computeGridPriceOffsetPlan(bot: unknown, amaSlope: unknown): JsonObj {
    const b = bot as JsonObj;
    const a = amaSlope as JsonObj;
    const targetSpreadPercentRaw = Number(b?.targetSpreadPercent);
    const targetSpreadPercent = Number.isFinite(targetSpreadPercentRaw) && targetSpreadPercentRaw > 0
        ? targetSpreadPercentRaw
        : Number(DEFAULT_CONFIG.targetSpreadPercent);
    const maxGridPriceOffsetPct = targetSpreadPercent / 2;
    const trend = a?.trend;
    const rawSlopeOffset = Number(a?.rawSlopeOffset);
    const maxSlopeOffset = Number(a?.maxSlopeOffset);
    const directionalSlope = Number.isFinite(rawSlopeOffset)
        ? Math.abs(rawSlopeOffset)
        : Math.abs(Number(a?.slopeOffset));
    const slopeRatio = Number.isFinite(directionalSlope) && Number.isFinite(maxSlopeOffset) && maxSlopeOffset > 0
        ? Math.min(directionalSlope / maxSlopeOffset, 1)
        : 0;
    const direction = trend === 'UP' ? 1 : trend === 'DOWN' ? -1 : 0;
    const gridPriceOffsetPct = roundTo(direction * slopeRatio * maxGridPriceOffsetPct, 1e6) || 0;

    return {
        trend: trend || 'NEUTRAL',
        rawSlopeOffset: Number.isFinite(rawSlopeOffset) ? rawSlopeOffset : null,
        maxSlopeOffset: Number.isFinite(maxSlopeOffset) ? maxSlopeOffset : null,
        slopeRatio: roundTo(slopeRatio, 1e6) || 0,
        targetSpreadPercent: roundTo(targetSpreadPercent, 1e6),
        maxGridPriceOffsetPct: roundTo(maxGridPriceOffsetPct, 1e6),
        gridPriceOffsetPct,
    };
}


/**
 * Standing repair verdict for a PERSISTED STATE entry — the summary the
 * previous cycle wrote. Returns a reason string when repair is still owed,
 * null when the cache is clean.
 *
 * State-side mirror of candleFileCoversClosedBucket: that gate judges the
 * on-disk candle file, this one judges the state summary, and the two must
 * describe the same standing conditions so the startup sleep and the in-cycle
 * skip cannot silently disagree. When a new standing signal is added to one,
 * add it to the other (source/newest-candle checks are file-only and cannot
 * appear here; unresolvedGapCount and the warmup shortfall exist in both).
 */
function evaluateStateRepairVeto(entry: Record<string, unknown> | null | undefined) {
    if (Number(entry?.unresolvedGapCount) > 0) return 'unresolved_gaps';
    const keepTarget = Number(entry?.rawKeepCount);
    if (!Number.isFinite(keepTarget) || keepTarget <= 0) return null;
    const candleCount = Number(entry?.candleCount);
    // Target known but current count unknown is NOT "nothing owed": an
    // older or half-written row would otherwise read as healthy. Veto, and
    // let the next full cycle rewrite the row with both fields.
    if (!Number.isFinite(candleCount)) return 'cache_count_unknown';
    if (candleCount < keepTarget) return 'cache_below_warmup_target';
    return null;
}

/** Injected dependencies for MarketAdapterService (built in market_adapter.ts). */
export interface ServiceDeps {
    resolveBotContext: (bot: JsonObj) => Promise<JsonObj | null>;
    resolveAmaForBot: (bot: JsonObj, ctx: JsonObj, cfg: JsonObj) => JsonObj;
    candleFileForBot: (botKey: unknown, intervalSeconds: unknown) => string;
    loadJson: (path: string, fallback: unknown) => unknown;
    saveJson: (path: string, payload: unknown) => void;
    calculateBotThreshold: (cfg: JsonObj) => number;
    computeCandleStaleness: (lastTs: unknown, maxStaleHours: unknown) => { staleData: boolean; staleAgeHours: unknown };
    withRetries: <T>(fn: () => Promise<T>, ...args: unknown[]) => Promise<T>;
    kibanaSource?: { getLpCandlesForPool: (...args: unknown[]) => Promise<unknown> };
    kibanaMarketSource?: { getMarketCandles: (...args: unknown[]) => Promise<unknown> };
    fetchNativeMarketHistorySince: (...args: unknown[]) => Promise<number[][]>;
    fetchNativeTradesSince: (...args: unknown[]) => Promise<{ trades: JsonObj[]; pages: number; truncated: boolean }>;
    fetchNativeTradesUntilOverlap: (...args: unknown[]) => Promise<{ trades: JsonObj[]; pages: number; overlapCount: number; reachedOverlap: boolean }>;
    tradesToCandles: (...args: unknown[]) => number[][];
    detectMissingCandleTimestamps: (candles: unknown, intervalSeconds: unknown) => { gapCount: number; missingTimestamps: number[]; [key: string]: unknown };
    fillCandleGaps: (...args: unknown[]) => number[][];
    detectStaleTail: (...args: unknown[]) => { sorted: number[][]; runLength: number; [key: string]: unknown };
    pruneStaleTail: (...args: unknown[]) => number[][];
    mergeCandles: (...args: unknown[]) => number[][];
    pruneCandles: (...args: unknown[]) => number[][];
    buildAmaRecord: (...args: unknown[]) => JsonObj;
    writeGridResetTrigger: (...args: unknown[]) => unknown;
    writeBotDynamicGrid: (...args: unknown[]) => unknown;
    isBotWhitelisted: (botKey: unknown) => boolean;
    isBotDynamicWeightWhitelisted: (botKey: unknown) => boolean;
    isBotAsymmetricBoundsWhitelisted: (botKey: unknown) => boolean;
    getNowMs?: () => number;
    logger?: { log?: (message: string, level?: string) => void; warn?: (message: string) => void; info?: (message: string) => void };
    root: string;
    ordersDir: string;
    path: { join: (...parts: string[]) => string; relative: (from: string, to: string) => string };
}

class MarketAdapterService {
    deps: ServiceDeps;
    constructor(deps: Partial<ServiceDeps> = {}) {
        // ordersDir is resolver-derived when injected by market_adapter.ts;
        // fall back to the legacy root/profiles/orders layout for direct
        // construction (tests, embedders) so it never stays undefined.
        if (!deps.ordersDir && deps.root) {
            deps.ordersDir = deps.path!.join(deps.root, 'profiles', 'orders');
        }
        this.deps = deps as ServiceDeps;
    }

    static isRetryableClosedCandleFailure(reason: unknown) {
        return reason === 'ama_center_persist_failed'
            || reason === 'dynamic_weight_persist_failed'
            || reason === 'ama_slope_persist_failed'
            || reason === 'unresolved_candle_gaps';
    }

    getNowMs() {
        return typeof this.deps.getNowMs === 'function' ? this.deps.getNowMs() : Date.now();
    }

    /**
     * Kibana bootstrap lookback in hours — exact conversion of the required
     * candle count at the bot's interval, mirroring getGapRepairMaxHours().
     * The caller passes rawKeepCount (getAmaWarmupBars() + 1 closed bar + 1
     * in-progress raw bar); if Kibana returns fewer bars than amaWarmupBars
     * (thin/gappy data), the existing native-backfill fallback handles it.
     * cfg.bootstrapLookbackHours stays as a floor so operators can seed
     * deeper history than the analytical minimum.
     */
    bootstrapKibanaLookbackHours(cfg: JsonObj, keepCount: unknown): number {
        const intervalSeconds = Number(cfg?.intervalSeconds);
        const intervalHours = Number.isFinite(intervalSeconds) && intervalSeconds > 0
            ? intervalSeconds / 3600
            : 1;
        return Math.max(Number(cfg?.bootstrapLookbackHours) || 0, Number(keepCount) * intervalHours);
    }

    /**
     * Closed-bucket arithmetic shared by the off-hour skip logic.
     *
     * Thin instance wrapper around the shared bucket helper so the `getNowMs`
     * injection used by tests and embedders keeps working. `intervalSeconds`
     * is validated by the helper: a missing/invalid interval can never
     * masquerade as "nothing new" — it returns null and the caller must fall
     * through to the network path instead of skipping a cycle it cannot
     * evaluate.
     */
    latestClosedBucketStartMs(intervalSeconds: unknown, nowMs: number = this.getNowMs()) {
        return latestClosedBucket(nowMs, intervalSeconds as number);
    }

    /**
     * Off-hour skip check: is there any closed candle this bot has not
     * consumed yet? Runs on persisted state + the wall clock only — no
     * chain RPC, no candle parse. Returns null when the answer cannot be
     * determined (invalid interval, unknown state shape, one-shot mode), in
     * which case the caller must run the full cycle instead of skipping.
     *
     * `once` (the `--once` CLI and the embedded runOnceForAma) always runs the
     * full cycle: those entry points exist to *produce* a result on demand —
     * the signal runner prints the AMA, an operator asks for a fresh cycle —
     * and returning a state-only "skipped" record with null prices would
     * quietly degrade their output. Only the long-running daemon, which has a
     * schedule of its own, may answer "nothing new, skipping".
     *
     * The verdict requires the consumed marker to equal the newest closed
     * bucket exactly. A marker AHEAD of that bucket means the two clocks
     * disagree (clock skew, a state file carried across hosts, a synthetic
     * fixture); skipping there would discard a candle the adapter may not
     * actually have processed, so the conservative answer is always "run".
     *
     * Skipped bots still refresh `lastCycleAt`/`lastCycleSource` in state so
     * monitoring can tell "idle by design" apart from "dead process".
     */
    shouldSkipBotForClosedCandle(_bot: unknown, botState: JsonObj, intervalSeconds: number, nowMs: number = this.getNowMs(), cfg: JsonObj | null = null) {
        if (cfg?.once) return null;
        if (!botState || typeof botState !== 'object' || Array.isArray(botState)) return null;
        const latestClosed = this.latestClosedBucketStartMs(intervalSeconds, nowMs);
        if (latestClosed === null) return null;
        const previousClosedCandleTs = Number(botState.lastClosedCandleTs || 0);
        // No consumed marker yet (fresh state / cleared state): the full
        // cycle must run — bootstrap and warmup checks live there.
        if (!Number.isFinite(previousClosedCandleTs) || previousClosedCandleTs <= 0) return null;
        if (latestClosed === previousClosedCandleTs) {
            return { latestClosedBucketStartMs: latestClosed, previousClosedCandleTs };
        }
        return null;
    }

    /**
     * Does the cached candle file belong to a different market source than the
     * bot is configured for?
     *
     * Single source of truth for the reset rule: the off-hour gate
     * (candleFileCoversClosedBucket) and the full path must agree, otherwise a
     * source switch could be skipped off-hour and the cache would keep serving
     * candles from the old source until the next close forced a full run.
     * The pool/book cross-checks matter for legacy caches that predate
     * `meta.marketSource`: a stored pool id alongside a book-configured bot (or
     * a book cache under a pool bot) is just as much a mismatch.
     */
    isCandleSourceMismatch(meta: JsonObj, marketSource: unknown) {
        const storedSource = normalizeMarketSource(meta?.marketSource);
        const hasStoredPoolContext = meta?.pool != null && String(meta.pool).trim() !== '';
        return (!!storedSource && storedSource !== marketSource)
            || (marketSource === 'book' && hasStoredPoolContext)
            || (marketSource === 'pool' && storedSource === 'book');
    }

    /**
     * Does the local candle cache already hold the data for a closed bucket?
     *
     * Second half of the off-hour skip verdict (see
     * shouldSkipBotForClosedCandle): the full cycle repairs history even
     * without a new close (Kibana backfill, gap fill), so skipping is only
     * safe when the cache is healthy for that bucket. False whenever
     * anything needs repair: a source switch, unresolved gaps, an empty or
     * short file (fewer candles than the AMA warmup target — the exact case
     * the backfill path exists for), or a newest candle that predates the
     * bucket.
     *
     * The state-side mirror of the standing conditions (unresolved gaps, warmup
     * shortfall) is evaluateStateRepairVeto above; keep the two in step.
     */
    candleFileCoversClosedBucket(candles: unknown, meta: JsonObj, marketSource: unknown, closedBucketStartMs: unknown, requiredCount: number = 0) {
        const closedBucketMs = Number(closedBucketStartMs);
        if (!Number.isFinite(closedBucketMs) || closedBucketMs <= 0) return false;
        if (this.isCandleSourceMismatch(meta, marketSource)) return false;
        if (Number(meta?.unresolvedGapCount) > 0) return false;
        if (!Array.isArray(candles) || candles.length === 0) return false;
        // Short history means the warmup/backfill path still has work to do.
        const required = Number(requiredCount);
        if (Number.isFinite(required) && required > 0 && candles.length < required) return false;
        const newestTs = Number(candles[candles.length - 1]?.[0]);
        if (!Number.isFinite(newestTs)) return false;
        return newestTs >= closedBucketMs;
    }

    selectClosedCandles(candles: unknown[], intervalSeconds: number, nowMs: number = this.getNowMs()): { closedCandles: number[][]; currentBucketStartMs: number | null } {
        const currentBucketStart = bucketStartMs(nowMs, intervalSeconds);
        if (currentBucketStart === null) {
            return {
                closedCandles: Array.isArray(candles) ? candles.slice() as number[][] : [],
                currentBucketStartMs: null,
            };
        }

        const closedCandles = ((Array.isArray(candles) ? candles : []) as number[][])
            .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && c[0] < currentBucketStart);

        return { closedCandles, currentBucketStartMs: currentBucketStart };
    }

    buildBotContextSignature(bot: JsonObj){
        return [
            bot?.assetA,
            bot?.assetB,
            bot?.assetAId,
            bot?.assetBId,
            bot?.assetAPrecision,
            bot?.assetBPrecision,
            bot?.poolId,
            bot?.startPrice,
        ].map((v) => String(v ?? '')).join('|');
    }

    buildGapRepairTimeRange(missingTimestamps: unknown, intervalSeconds: number, maxGapHours: number = 24){
        const bucketMs = Number(intervalSeconds) * 1000;
        if (!Array.isArray(missingTimestamps) || missingTimestamps.length === 0) return null;
        if (!Number.isFinite(bucketMs) || bucketMs <= 0) return null;

        const maxGapMs = Number.isFinite(maxGapHours) && maxGapHours > 0 ? maxGapHours * 3600 * 1000 : 24 * 3600 * 1000;
        const requestedStart = missingTimestamps[0] - bucketMs;
        const requestedEnd = missingTimestamps[missingTimestamps.length - 1] + (bucketMs * 2) - 1;
        const cappedStart = Math.max(requestedStart, requestedEnd - maxGapMs);

        return {
            gte: new Date(cappedStart).toISOString(),
            lte: new Date(requestedEnd).toISOString(),
        };
    }

    getMissingTimestampsWithinTimeRange(missingTimestamps: unknown, timeRange: JsonObj){
        if (!Array.isArray(missingTimestamps) || missingTimestamps.length === 0 || !timeRange) return [];
        const gteMs = Date.parse(String(timeRange.gte));
        const lteMs = Date.parse(String(timeRange.lte));
        if (!Number.isFinite(gteMs) || !Number.isFinite(lteMs) || lteMs < gteMs) return [];
        return missingTimestamps.filter((ts) => Number.isFinite(ts) && ts >= gteMs && ts <= lteMs);
    }

    getGapRepairMaxHours(cfg: JsonObj): number {
        const intervalSeconds = Number(cfg?.intervalSeconds);
        const intervalHours = Number.isFinite(intervalSeconds) && intervalSeconds > 0
            ? intervalSeconds / 3600
            : 1;
        const maxCandles = Number.isFinite(cfg?.maxNativeGapFillCandles)
            ? Number(Number(cfg.maxNativeGapFillCandles))
            : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;

        // Include the candle before and after the missing run so Kibana repair
        // does not truncate a valid threshold-sized gap while still respecting
        // the configured "trust native no-trade up to N candles" threshold.
        return Math.max(1, (maxCandles + 2) * intervalHours);
    }

    getTrustedNoTradeGapThresholdCandles(cfg: JsonObj): number {
        return Number.isFinite(cfg?.maxNativeGapFillCandles)
            ? Number(Number(cfg.maxNativeGapFillCandles))
            : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
    }

    fillNativeIncrementalClosedGaps(candles: unknown, previousLastTs: unknown, intervalSeconds: number, nowMs: number = this.getNowMs()): unknown[] {
        const deps = this.deps;
        if (typeof deps.fillCandleGaps !== 'function') return candles as unknown[];
        if (!Array.isArray(candles) || candles.length === 0) return candles as unknown[];

        const bucketMs = Number(intervalSeconds) * 1000;
        const startTs = Number(previousLastTs);
        if (!Number.isFinite(bucketMs) || bucketMs <= 0 || !Number.isFinite(startTs) || startTs <= 0) {
            return candles as unknown[];
        }

        const currentBucketStartMs = Math.floor(Number(nowMs) / bucketMs) * bucketMs;
        const latestClosedBucketTs = currentBucketStartMs - bucketMs;
        if (!Number.isFinite(latestClosedBucketTs) || latestClosedBucketTs < startTs) {
            return candles as unknown[];
        }

        const tailCandles = candles.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && c[0] >= startTs);
        if (tailCandles.length === 0) return candles as unknown[];

        const filledTail = deps.fillCandleGaps(tailCandles, intervalSeconds, startTs, latestClosedBucketTs);
        return deps.mergeCandles(candles, filledTail);
    }

    buildIncrementalCandleCollision(existing: number[], incoming: number[]){
        const existingVol = Number(existing?.[5] || 0);
        const incomingVol = Number(incoming?.[5] || 0);
        if (existingVol <= 0 && incomingVol > 0) return incoming;
        if (incomingVol <= 0) return existing;
        return [
            existing[0],
            existing[1],
            Math.max(existing[2], incoming[2]),
            Math.min(existing[3], incoming[3]),
            incoming[4],
            existingVol + incomingVol,
        ];
    }

    // Historical internal holes are different from the live trailing silence path:
    // native incremental fetches cannot directly tell us "no trades happened here"
    // because the hole is already detached from the current native fetch window.
    // When Kibana also returns no candles for a bounded internal run, we accept
    // that as verified no-trade and synthesize flat candles up to the same
    // trusted no-trade threshold used by live native silence handling.
    fillVerifiedInternalNoTradeGaps(candles: unknown, missingTimestamps: unknown, intervalSeconds: number, maxGapCandles: number): { candles: unknown[]; filledTimestamps: number[] } {
        const deps = this.deps;
        const bucketMs = Number(intervalSeconds) * 1000;
        if (!Array.isArray(candles) || candles.length === 0 || !Array.isArray(missingTimestamps) || missingTimestamps.length === 0) {
            return { candles: candles as unknown[], filledTimestamps: [] };
        }
        if (!Number.isFinite(bucketMs) || bucketMs <= 0) return { candles: candles as unknown[], filledTimestamps: [] };
        if (!Number.isFinite(maxGapCandles) || maxGapCandles <= 0) return { candles: candles as unknown[], filledTimestamps: [] };

        const sortedCandles = candles
            .filter((c) => Array.isArray(c) && Number.isFinite(c[0]))
            .slice()
            .sort((a, b) => a[0] - b[0]);
        const sortedMissing = missingTimestamps
            .filter((ts) => Number.isFinite(ts))
            .slice()
            .sort((a, b) => a - b);

        if (sortedCandles.length === 0 || sortedMissing.length === 0) {
            return { candles: sortedCandles, filledTimestamps: [] };
        }

        const candleByTs = new Map(sortedCandles.map((c) => [c[0], c]));
        const synthesized: number[][] = [];
        const filledTimestamps: number[] = [];

        let runStart = sortedMissing[0];
        let previousMissingTs = sortedMissing[0];
        const flushRun = (startTs: number, endTs: number) => {
            const runLength = Math.round((endTs - startTs) / bucketMs) + 1;
            if (runLength <= 0 || runLength > maxGapCandles) return;
            const previousCandle = candleByTs.get(startTs - bucketMs);
            const nextCandle = candleByTs.get(endTs + bucketMs);
            if (!previousCandle || !nextCandle) return;
            const baselineClose = Number(previousCandle[4]);
            if (!Number.isFinite(baselineClose) || baselineClose <= 0) return;
            for (let ts = startTs; ts <= endTs; ts += bucketMs) {
                const c = [ts, baselineClose, baselineClose, baselineClose, baselineClose, 0];
                synthesized.push(c);
                filledTimestamps.push(ts);
            }
        };

        for (let i = 1; i < sortedMissing.length; i++) {
            const currentTs = sortedMissing[i];
            if (currentTs !== previousMissingTs + bucketMs) {
                flushRun(runStart, previousMissingTs);
                runStart = currentTs;
            }
            previousMissingTs = currentTs;
        }
        flushRun(runStart, previousMissingTs);

        if (synthesized.length === 0) return { candles: sortedCandles, filledTimestamps: [] };
        return {
            candles: deps.mergeCandles(sortedCandles, synthesized),
            filledTimestamps,
        };
    }

    getNativeRecentTradeSequences(trades: unknown, limit: number = 8){
        const seen = new Set();
        return (Array.isArray(trades) ? trades : [])
            .filter((t) => Number.isFinite(Number(t?.sequence)))
            .sort((a, b) => {
                const at = Number(a.tsMs || 0);
                const bt = Number(b.tsMs || 0);
                if (bt !== at) return bt - at;
                return Number(b.sequence) - Number(a.sequence);
            })
            .map((t) => Number(t.sequence))
            .filter((seq) => {
                const key = String(seq);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(0, limit);
    }

    filterTimeBasedNativeNewTrades(trades: unknown, knownSequences: unknown, nativeLastTradeTs: unknown, lastCandleTs: unknown, intervalSeconds: number){
        const seqSet = knownSequences instanceof Set
            ? knownSequences
            : new Set((Array.isArray(knownSequences) ? knownSequences : []).map((seq) => String(seq)));
        const seqNumbers = [...seqSet]
            .map((seq) => Number(seq))
            .filter(Number.isFinite);
        const maxKnownSeq = seqNumbers.length > 0 ? Math.max(...seqNumbers) : null;
        const lastTradeTs = Number(nativeLastTradeTs);
        const lastTs = Number(lastCandleTs);
        const bucketMs = Number(intervalSeconds) * 1000;

        return (Array.isArray(trades) ? trades : []).filter((trade) => {
            const seq = Number(trade?.sequence);
            const seqKey = Number.isFinite(seq) ? String(seq) : null;
            if (seqKey && seqSet.has(seqKey)) return false;
            if (Number.isFinite(seq) && Number.isFinite(maxKnownSeq)) return seq > (maxKnownSeq as number);

            const tsMs = Number(trade?.tsMs);
            if (!Number.isFinite(tsMs)) return true;
            if (Number.isFinite(lastTradeTs) && lastTradeTs > 0) return tsMs > lastTradeTs;

            if (Number.isFinite(bucketMs) && bucketMs > 0 && Number.isFinite(lastTs) && lastTs > 0) {
                const tradeBucketTs = Math.floor(tsMs / bucketMs) * bucketMs;
                return tradeBucketTs > lastTs;
            }

            return true;
        });
    }

    clampGridPriceToBounds(centerPrice: unknown, referencePrice: unknown, bot: JsonObj): number {
        const base = Number(centerPrice);
        const ref = Number(referencePrice);
        if (!Number.isFinite(base) || base <= 0) return base;
        try {
            const startPrice = Number.isFinite(ref) && ref > 0 ? ref : base;
            const minP = resolveConfiguredPriceBound(bot?.minPrice as string | number | undefined, DEFAULT_CONFIG.minPrice, startPrice, 'min') ?? 0;
            const maxP = resolveConfiguredPriceBound(bot?.maxPrice as string | number | undefined, DEFAULT_CONFIG.maxPrice, startPrice, 'max') ?? 0;
            if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return base;
            return Math.min(maxP, Math.max(minP, base));
        } catch (err) {
            throw new Error(`clampGridPriceToBounds: failed to resolve bounds: ${getErrorMessage(err)}`);
        }
    }

    computeAppliedAsymmetryMetrics(bot: AdapterBotCfg, centerPrice: number, dynamicWeights: JsonObj){
        const maxAsymmetryFactor = resolveMaxAsymmetryFactor(
            bot?.asymmetricBounds?.maxAsymmetryFactor,
            dynamicWeights?.maxAsymmetryFactor,
            MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR
        );
        let minP: number | null = null;
        let maxP: number | null = null;
        try {
            minP = resolveConfiguredPriceBound(bot?.minPrice, DEFAULT_CONFIG.minPrice, centerPrice, 'min');
            maxP = resolveConfiguredPriceBound(bot?.maxPrice, DEFAULT_CONFIG.maxPrice, centerPrice, 'max');
        } catch (_) {
            // Intentional: if bound resolution fails, minP/maxP stay null.
            // computeAsymmetricBoundsMetrics handles null bounds with safe defaults.
        }
        return computeAsymmetricBoundsMetrics({
            centerPrice,
            minPrice: minP,
            maxPrice: maxP,
            trend: dynamicWeights?.trend,
            slopeOffset: Number.isFinite(dynamicWeights?.rawSlopeOffset)
                ? dynamicWeights.rawSlopeOffset
                : dynamicWeights?.slopeOffset,
            maxSlopeOffset: dynamicWeights?.maxSlopeOffset,
            maxAsymmetryFactor,
        });
    }

    buildDefaultBotState(bot: AdapterBotCfg, overrides: JsonObj = {}): JsonObj {
        return {
            botName: bot.name,
            botKey: bot.botKey,
            marketSource: null,
            priceMode: null,
            lastCycleSource: null,
            lastCycleAt: null,
            pendingClosedCandle: false,
            lastTriggerSuppressedReason: null,
            poolId: null,
            candleFile: null,
            candleCount: 0,
            analysisCandleCount: 0,
            kibanaGapRepairCount: 0,
            kibanaBackfillCount: 0,
            unresolvedGapCount: 0,
            nativeRecentTradeSequences: [],
            nativeLastTradeTs: null,
            nativeOverlapCount: null,
            nativePagesFetched: null,
            lastCandleTs: null,
            rawLastCandleTs: null,
            lastClosedCandleTs: null,
            gridCenterPrice: null,
            centerPrice: null,
            amaCenterPrice: null,
            amaConfig: null,
            atr: null,
            weightVariance: null,
            weights: null,
            effectiveWeights: null,
            collateralRecommendation: null,
            amaSlope: null,
            amaSlopeDeltaPercent: null,
            amaSlopeThresholdPercent: null,
            rawKeepCount: 0,
            analysisKeepCount: 0,
            amaWarmupBars: 0,
            staleData: false,
            staleAgeHours: null,
            ...overrides,
        };
    }

    buildDefaultResult(_bot: unknown, overrides: JsonObj = {}): BotCycleResult {
        return {
            ok: true,
            dryRunMessages: [],
            source: null,
            marketSource: null,
            candleCount: 0,
            analysisCandleCount: 0,
            kibanaGapRepairCount: 0,
            kibanaBackfillCount: 0,
            unresolvedGapCount: 0,
            nativeRecentTradeSequences: [],
            nativeLastTradeTs: null,
            nativeOverlapCount: null,
            nativePagesFetched: null,
            amaPrice: null,
            deltaPercent: null,
            thresholdPercent: null,
            referencePrice: null,
            amaComparison: [],
            triggered: false,
            triggerPath: null,
            staleData: false,
            staleAgeHours: null,
            triggerCallbackError: null,
            triggerSuppressedReason: null,
            weights: null,
            collateralRecommendation: null,
            amaSlope: null,
            amaSlopeDeltaPercent: null,
            amaSlopeThresholdPercent: null,
            rawKeepCount: 0,
            analysisKeepCount: 0,
            amaWarmupBars: 0,
            poolId: null,
            candleFile: null,
            lastCandleTs: null,
            rawLastCandleTs: null,
            lastClosedCandleTs: null,
            centerPrice: null,
            amaConfig: null,
            atr: null,
            weightVariance: null,
            pendingClosedCandle: false,
            ...overrides,
        };
    }

    resolveAmaSlopeDeltaThresholdPercent(cfg: JsonObj): number {
        const explicit = Number(cfg?.amaSlopeDeltaThresholdPercent);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const factor = Number((cfg?.amaSlope as JsonObj | undefined)?.deltaThresholdPct);
        if (!Number.isFinite(factor) || factor <= 0) return 0;
        const maxSlopePct = Number((cfg?.amaSlope as JsonObj | undefined)?.maxSlopePct);
        if (!Number.isFinite(maxSlopePct) || maxSlopePct <= 0) return 0;
        return (factor / 100) * maxSlopePct;
    }

    buildAmaSlopeResetDetails(currentAmaSlope: JsonObj, previousAmaSlope: JsonObj, cfg: JsonObj){
        const thresholdPercent = this.resolveAmaSlopeDeltaThresholdPercent(cfg);
        const currentSlopePct = Number(currentAmaSlope?.slopePct);
        const previousSlopePct = Number(previousAmaSlope?.slopePct);
        const currentReady = !!currentAmaSlope?.isReady && Number.isFinite(currentSlopePct);
        // A not-ready snapshot (`isReady:false`, slopePct 0) is a truthy object
        // that can be persisted as the reset baseline before AMA warmup. Treat
        // it as "no baseline" so its phantom 0 %/bar cannot later trip the
        // slope trigger on the first real slope. Legacy snapshots without an
        // `isReady` field still count as ready.
        const previousReady = !!previousAmaSlope
            && previousAmaSlope.isReady !== false
            && Number.isFinite(previousSlopePct);

        const deltaPercent = currentReady && previousReady
            ? Math.abs(currentSlopePct - previousSlopePct)
            : null;
        // A non-positive threshold means the slope trigger is DISABLED, not
        // "fire on any delta": `deltaPercent >= 0` would otherwise reset the
        // grid every cycle whenever the factor/maxSlopePct config is missing.
        const thresholdCrossed = Number.isFinite(deltaPercent)
            && thresholdPercent > 0
            && (deltaPercent as number) >= thresholdPercent;

        return {
            thresholdPercent,
            currentSlopePct: Number.isFinite(currentSlopePct) ? currentSlopePct : null,
            previousSlopePct: Number.isFinite(previousSlopePct) ? previousSlopePct : null,
            deltaPercent,
            thresholdCrossed,
            shouldTrigger: thresholdCrossed,
        };
    }

    /**
     * Number of consecutive confirming bars the slope-delta trigger requires.
     * Resolves per-bot/market override, else the global enable + value, else 1
     * (legacy fire-on-first-crossing).
     */
    resolveAmaSlopePersistBars(cfg: JsonObj): number {
        // Per-bot/market `persistBars`: >= 1 sets the gate length, exactly 0
        // disables it (legacy 1). Negative/NaN fall through to the enable flags.
        const rawBars = (cfg?.amaSlope as JsonObj | undefined)?.persistBars ?? cfg?.amaSlopePersistBars;
        const explicit = (rawBars === null || rawBars === undefined) ? NaN : Number(rawBars);
        if (Number.isFinite(explicit)) {
            if (explicit >= 1) return Math.round(explicit);
            if (explicit === 0) return 1;
        }
        // `persistEnabled` is a tri-state override: an explicit false disables
        // the gate even when the global default is on; undefined falls back to
        // the global flag; explicit true enables it. Must be an explicit
        // tri-state check — a `||` chain lets the global `true` mask a per-bot
        // `false`, silently killing the documented per-bot rollback.
        const override = (cfg?.amaSlope as JsonObj | undefined)?.persistEnabled ?? cfg?.amaSlopePersistEnabled;
        const enabled = override === false ? false
            : override === true ? true
            : MARKET_ADAPTER.AMA_SLOPE_PERSIST_ENABLED === true;
        if (!enabled) return 1;
        const bars = Number(MARKET_ADAPTER.AMA_SLOPE_PERSIST_BARS);
        return Number.isFinite(bars) && bars >= 1 ? Math.round(bars) : 1;
    }

    /**
     * Advance the slope-delta persistence counter on one actionable cycle and
     * report whether the gate is satisfied. Mutates botState counters (persisted
     * across restarts). Caller clears them on any successful reset.
     */
    advanceAmaSlopePersistence(details: JsonObj, cfg: JsonObj, botState: JsonObj){
        const persistBars = this.resolveAmaSlopePersistBars(cfg);
        const crossed = !!details?.thresholdCrossed;
        if (persistBars <= 1) {
            botState.amaSlopePersistCount = 0;
            botState.amaSlopePersistDir = 0;
            return { shouldTrigger: crossed, persistBars };
        }
        if (!crossed) {
            botState.amaSlopePersistCount = 0;
            botState.amaSlopePersistDir = 0;
            return { shouldTrigger: false, persistBars };
        }
        const current = Number(details?.currentSlopePct);
        const previous = Number(details?.previousSlopePct);
        const dir = Number.isFinite(current) && Number.isFinite(previous) ? Math.sign(current - previous) : 0;
        const storedDirRaw = Number(botState.amaSlopePersistDir);
        const storedDir = storedDirRaw === 1 ? 1 : (storedDirRaw === -1 ? -1 : 0);
        const storedCountRaw = Number(botState.amaSlopePersistCount);
        const storedCount = Number.isFinite(storedCountRaw) && storedCountRaw > 0 ? Math.floor(storedCountRaw) : 0;
        const count = (dir !== 0 && dir === storedDir) ? storedCount + 1 : 1;
        botState.amaSlopePersistDir = dir;
        botState.amaSlopePersistCount = count;
        return { shouldTrigger: count >= persistBars, persistBars };
    }

    normalizePersistedBotState(botState: unknown, lookbackBars: number): JsonObj {
        if (!botState || typeof botState !== 'object') return {};
        return (normalizePersistedAmaSlopeDiagnostics(botState, lookbackBars) ?? {}) as JsonObj;
    }

    extractPersistedDynamicGridState(snapshot: JsonObj, lookbackBars: number){
        if (!snapshot || typeof snapshot !== 'object') return null;

        const gridCenterPrice = Number(snapshot.gridCenterPrice ?? snapshot.centerPrice);
        const amaCenterPrice = Number(snapshot.amaCenterPrice);
        const gridPriceOffsetPct = Number(snapshot.gridPriceOffsetPct);
        const normalized = normalizePersistedAmaSlopeDiagnostics({
            amaSlopePercentMode: snapshot.amaSlopePercentMode,
            amaSlope: snapshot.amaSlope,
            gridRangeScalingAmaSlope: snapshot.gridRangeScalingAmaSlope,
            amaSlopeDeltaPercent: snapshot.amaSlopeDeltaPercent,
            amaSlopeThresholdPercent: snapshot.amaSlopeThresholdPercent,
        }, lookbackBars) as JsonObj | null;
        const amaSlope = normalized?.amaSlope ?? null;
        const gridRangeScalingAmaSlope = normalized?.gridRangeScalingAmaSlope ?? amaSlope;

        return {
            gridCenterPrice: Number.isFinite(gridCenterPrice) && gridCenterPrice > 0 ? gridCenterPrice : null,
            centerPrice: Number.isFinite(gridCenterPrice) && gridCenterPrice > 0 ? gridCenterPrice : null,
            amaCenterPrice: Number.isFinite(amaCenterPrice) && amaCenterPrice > 0 ? amaCenterPrice : null,
            amaSlope,
            gridRangeScalingAmaSlope,
            amaSlopeDeltaPercent: normalized?.amaSlopeDeltaPercent ?? null,
            amaSlopeThresholdPercent: normalized?.amaSlopeThresholdPercent ?? null,
            amaSlopePercentMode: AMA_SLOPE_PERCENT_MODE_PER_BAR,
            gridPriceOffsetPct: Number.isFinite(gridPriceOffsetPct) ? gridPriceOffsetPct : null,
            lastGridResetAt: snapshot.lastGridResetAt,
            lastGridResetSource: snapshot.lastGridResetSource,
        };
    }

    _computeDynamicWeights(params: ComputeDynamicWeightsParams){
        const {
            closes, amaValues, lookbackBars,
            botAma, weightVariance, nowIso, cfg, bot, atrPeriod
        } = params;

        // clipPercentile must stay inside (0, 100] — values above 100 would
        // otherwise produce negative percentile indices (NaN thresholds)
        // downstream, and <= 0 disables clipping.
        const rawClipPercentile = cfg.clipPercentile ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
        const clipPercentile = Number.isFinite(rawClipPercentile)
            ? Math.max(0, Math.min(100, Number(rawClipPercentile)))
            : MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
        const nz = cfg.amaSlope?.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
        const amaMaxS = cfg.amaSlope?.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
        // EMA on the Huber slope: one normalized read point shared by the slope
        // result, both dynamic-weight series and the reported diagnostics.
        const emaAlpha = normalizeAmaSlopeEmaAlpha(cfg.amaSlope?.emaAlpha ?? cfg.amaSlopeEmaAlpha);
        const kalMaxS = cfg.kalmanSlope?.maxSlopePct
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT;
        const mo = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
        const volatilityClamp = normalizeMaxVolatilityOffset(cfg.maxVolatilityOffset);
        const volatilityThreshold = normalizeVolatilityThreshold(cfg.volatilityThreshold);
        // Normalize volatility knobs into their effective ranges at the single
        // read point so config, applied value and reported payload always
        // agree (computeVolatilityShift hard-clamps to the same bounds).
        const rawVolatilityExponent = cfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
        const volatilityExponent = Number.isFinite(rawVolatilityExponent)
            ? Math.max(
                MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT_MIN,
                Math.min(MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT_MAX, Number(rawVolatilityExponent))
            )
            : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
        const rawVolatilityScaleX = cfg.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;
        const volatilityScaleX = Number.isFinite(rawVolatilityScaleX)
            ? Math.max(
                MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_MIN,
                Math.min(MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_MAX, Number(rawVolatilityScaleX))
            )
            : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;

        // Compute separate clip thresholds for AMA (slopes) and Kalman (velocities)
        let amaClipThreshold = computeAmaSlopeClipThreshold(amaValues, botAma.erPeriod, lookbackBars, clipPercentile);
        let kalClipThreshold = Infinity;

        // Stateless replay of the canonical Huber -> EMA slope series (the same
        // helper the DW research chart embeds). alpha=1 keeps raw Huber behavior.
        // The clip threshold intentionally stays based on the raw slope history,
        // matching the research chart and avoiding a feedback loop.
        const amaSlopePctSeries = computeAmaSlopeEmaSeries(amaValues, botAma.erPeriod, lookbackBars, emaAlpha);

        const slopeCfg = {
            ...(cfg.amaSlope || {}),
            erPeriod:              botAma.erPeriod,
            maxSlopeOffset:        cfg.maxSlopeOffset,
            maxVolatilityOffset:   volatilityClamp,
            volatilityExponent,
            volatilityScaleX,
            volatilityThreshold,
            neutralZonePct:        nz,
            clipThreshold:         amaClipThreshold,
            slopePctSeries:        amaSlopePctSeries,
        };

        const slopeResult = computeAmaSlopeWeights(amaValues, weightVariance, slopeCfg);

        // Kalman filter computation - collect per-bar results in single pass
        const kalman = new KalmanTrendAnalyzer({
            rNoise: cfg.kalman?.rNoise ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_R_NOISE_DEFAULT,
            qTactical: cfg.kalman?.qTactical ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_TACTICAL_DEFAULT,
            qModal: cfg.kalman?.qModal ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_MODAL_DEFAULT,
            warmupBars: cfg.kalman?.warmupBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_WARMUP_BARS_DEFAULT,
        });

        const kalmanHistory: ReturnType<KalmanTrendAnalyzer['update']>[] = [];
        for (const price of closes) {
            const kr = kalman.update(price);
            kalmanHistory.push(kr);
        }

        const kalmanResult = kalmanHistory[kalmanHistory.length - 1];

        // Regime gate (Hurst + PE bilinear multiplier)
        const regimeSensitivity = cfg.regimeSensitivity ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY;
        const absoluteThreshold = cfg.absoluteThreshold ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT;
        let regimeResult: RegimeMultiplierResult | null = null;
        let regimeMultiplier = 1.0;
        const regimeMultipliers = new Array(closes.length).fill(1.0);

        if (regimeSensitivity > 0) {
            regimeResult = computeRegimeMultiplier(closes, {
                regimeSensitivity,
                regimeTable: cfg.regimeTable,
                hurstZoneBand: cfg.hurstZoneBand as number | undefined,
                peNodes: cfg.peNodes as number[] | undefined,
                // Stable per-market key: lets the gate resume from the previous
                // cycle's analyzer state instead of replaying the whole history.
                // The gate still recomputes from scratch whenever the cached
                // closes are not a prefix of the incoming window (gap repair,
                // rewritten bar, shortened window) or a parameter changed.
                cacheKey: `${bot?.botKey ?? 'bot'}:${Number(cfg.intervalSeconds)}`,
            });
            regimeMultiplier = regimeResult.isReady && Math.abs(regimeResult.multiplier - 1.0) >= absoluteThreshold
                ? regimeResult.multiplier
                : 1.0;
            if (Array.isArray(regimeResult.series) && regimeResult.series.length === closes.length) {
                for (let i = 0; i < closes.length; i++) {
                    const rawMult = regimeResult.series[i];
                    regimeMultipliers[i] = Math.abs(rawMult - 1.0) >= absoluteThreshold ? rawMult : 1.0;
                }
            }
        }

        const alpha = cfg.alpha ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA;
        const dw = cfg.dw ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DW;
        const gain = cfg.gain ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN;
        const kalmanSmoothPct = cfg.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT;
        const kalmanDispScaleMult = cfg.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT;
        const kalmanDispThresholdMult = cfg.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT;
        const kalmanSmoothSpanPct = cfg.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT;
        const signalConfirmBars = cfg.signalConfirmBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT;
        const minOutputThreshold = cfg.minOutputThreshold
            ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD;
        const dispScaleMinPct  = cfg.dispScaleMinPct  ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT;
        const hasDirectionalOffset = mo > 0;
        const useAmaBlend = hasDirectionalOffset && alpha !== 0;
        const useKalmanBlend = hasDirectionalOffset && alpha !== 1;
        const useClipThreshold = clipPercentile > 0;

        let kalmanSmoothedVelocityPct: (number | null)[] = new Array(kalmanHistory.length).fill(null);
        if (useKalmanBlend) {
            // Feed the smoothing pipeline unrounded velocity/displacement (matches
            // the research chart payload, which prefers velocityRawPct).
            const kalmanRawPoints = kalmanHistory.map((kr) => ({
                velocityPct: kr.velocityRawPct ?? kr.velocityPct,
                displacementPct: kr.displacementRawPct ?? kr.displacementPct,
            }));
            kalmanSmoothedVelocityPct = buildKalmanVelocitySeries(kalmanRawPoints, {
                kalmanSmoothPct,
                kalmanDispScaleMult,
                kalmanDispThresholdMult,
                kalmanSmoothSpanPct,
            });

            kalClipThreshold = useClipThreshold
                ? computeAbsolutePercentileThreshold(kalmanSmoothedVelocityPct, clipPercentile, Infinity)
                : Infinity;
        }

        const offsetClamp = cfg.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
        const outputThreshold = minOutputThreshold;

        // Per-bar directional offset series — canonical implementation shared
        // with the research chart and test harness (see dynamic_weight_series.ts).
        // The base inputs are identical for the real series and the AMA-only
        // diagnostic; only the Kalman inputs and clip threshold differ.
        const seriesBaseInputs = {
            amaValues,
            // Shaped slope series: offsets use the same EMA-smoothed signal that
            // is published as amaSlope.slopePct and compared for grid resets.
            amaSlopePctSeries,
            regimeMultipliers,
            lookbackBars,
            amaErPeriod: botAma.erPeriod,
            amaClipThreshold,
            neutralZonePct: nz,
            amaMaxSlopePct: amaMaxS,
            kalmanMaxSlopePct: kalMaxS,
            offsetClamp,
            dispScaleMinPct,
            alpha,
            dw,
            gain,
            minOutputThreshold,
            signalConfirmBars,
            clampFinalOutput: true,
        };
        const seriesResult = computeDynamicWeightSeries({
            ...seriesBaseInputs,
            kalmanVelocityPct: kalmanSmoothedVelocityPct,
            kalmanDisplacementPct: kalmanHistory.map((kr) => kr.displacementRawPct),
            kalmanIsReady: kalmanHistory.map((kr) => kr.isReady),
            kalClipThreshold,
        });
        const {
            combinedOffSeries,
            gatedOffSeries,
            echoedOffSeries,
            echoedGatedOffSeries,
        } = seriesResult;

        const rawFinalOff = combinedOffSeries[combinedOffSeries.length - 1] ?? 0;
        const rawFinalPreGainOff = gatedOffSeries[gatedOffSeries.length - 1] ?? 0;
        const finalPreGainOff = echoedGatedOffSeries[echoedGatedOffSeries.length - 1] ?? rawFinalPreGainOff;
        const finalOff = echoedOffSeries[echoedOffSeries.length - 1] ?? rawFinalOff;

        // Diagnostic: AMA channel contribution derived from the canonical
        // pipeline with the Kalman channel disabled, so the dead-band gate,
        // per-bar regime multipliers, gain/clamp and echo latch all match the
        // path that produces finalOffset. (The previous closed-form
        // alpha*(offset/norm)*gain*regime recomputation diverged from
        // finalOffset whenever gating or signal confirmation was active.)
        const amaOnlySeriesResult = computeDynamicWeightSeries({
            ...seriesBaseInputs,
            kalmanVelocityPct: kalmanSmoothedVelocityPct.map(() => null),
            kalmanDisplacementPct: kalmanHistory.map(() => null),
            kalmanIsReady: kalmanHistory.map(() => false),
            kalClipThreshold: Infinity,
        });
        const amaSlopeGated = slopeResult.isReady
            ? (useAmaBlend
                ? (amaOnlySeriesResult.echoedOffSeries[amaOnlySeriesResult.echoedOffSeries.length - 1] ?? 0)
                : 0)
            : 0;

        // Shared report fragments so the diagnostic `amaSlope` snapshot, the
        // persisted `weights.meta` and `dynamicWeightsPayload` cannot drift
        // apart. Kept as separate pieces so each object keeps its original
        // key order.
        const blendReport = {
            alpha,
            dw,
            gain,
            atrPeriod,
            maxSlopeOffset: mo,
        };
        const slopeConfigReport = {
            amaSlope: {
                maxSlopePct: amaMaxS,
                emaAlpha,
            },
            kalmanSlope: {
                maxSlopePct: kalMaxS,
            },
        };
        const volatilityReport = {
            clipPercentile,
            neutralZonePct: nz,
            volatilityThreshold,
            volatilityExponent,
            volatilityScaleX,
        };
        const kalmanReport = {
            maxVolatilityOffset: volatilityClamp,
            kalmanSmoothPct,
            kalmanDispScaleMult,
            kalmanDispThresholdMult,
            kalmanSmoothSpanPct,
            signalConfirmBars,
        };

        const amaSlope = {
            trend:          slopeResult.trend,
            confidence:     slopeResult.confidence,
            slopePct:       slopeResult.slopePct,
            slopeOffset:    slopeResult.slopeOffset,
            rawSlopeOffset: slopeResult.rawSlopeOffset,
            amaSlopeGated,
            regimeMultiplier,
            symmetricDelta: slopeResult.symmetricDelta,
            weightVariance,
            isReady:        slopeResult.isReady,
            kalmanReady:    kalmanResult?.isReady ?? false,
            ...blendReport,
            ...slopeConfigReport,
            ...kalmanReport,
        };

        const staticSell = bot.weightDistribution?.sell ?? 0;
        const staticBuy = bot.weightDistribution?.buy ?? 0;
        const MIN_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
        const MAX_W = MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

        const belowMinOutputThreshold = Math.abs(finalPreGainOff) < outputThreshold;
        const volPenalty = slopeResult.isReady ? (slopeResult.symmetricDelta ?? 0) : 0;
        const trendOff   = belowMinOutputThreshold ? 0 : finalOff;

        const effectiveSell = roundTo(clamp(staticSell - trendOff + volPenalty, MIN_W, MAX_W), 100);
        const effectiveBuy  = roundTo(clamp(staticBuy  + trendOff + volPenalty, MIN_W, MAX_W), 100);

        const weights = {
            sell: effectiveSell,
            buy:  effectiveBuy,
            profile: !slopeResult.isReady ? 'static'
                : trendOff !== 0 ? 'slope'
                : volPenalty !== 0 ? 'volatility'
                : 'flat',
            meta: {
                source:                  'dynamic_weight',
                staticSell,
                staticBuy,
                trend:                   slopeResult.trend,
                confidence:              slopeResult.confidence,
                slopePct:                slopeResult.slopePct,
                slopeOffset:             slopeResult.slopeOffset,
                rawSlopeOffset:          slopeResult.rawSlopeOffset,
                amaSlopeGated,
                regimeMultiplier,
                regimeSensitivity,
                absoluteThreshold,
                volatilityPenalty:       volPenalty,
                ...blendReport,
                maxAsymmetryFactor:  (cfg.asymmetricBounds?.maxAsymmetryFactor != null)
                    ? cfg.asymmetricBounds.maxAsymmetryFactor
                    : null,
                minScaleSlots: (cfg.asymmetricBounds?.minScaleSlots != null)
                    ? cfg.asymmetricBounds.minScaleSlots
                    : null,
                ...volatilityReport,
                ...slopeConfigReport,
                ...kalmanReport,
                amaChannelContribution: amaSlopeGated,
                rawFinalOffset:          rawFinalOff,
                trendOffset:             trendOff,
                finalOffset:             finalOff,
                minOutputThreshold,
                outputThreshold,
                belowMinOutputThreshold,
                kalmanReady:             kalmanResult?.isReady ?? false,
                isReady:                 slopeResult.isReady,
            },
        };

        const dynamicWeightsPayload = {
            effectiveWeights: { sell: effectiveSell, buy: effectiveBuy },
            baseWeights:      { sell: staticSell,    buy: staticBuy },
            slopeOffset:      slopeResult.slopeOffset,
            rawSlopeOffset:   slopeResult.rawSlopeOffset,
            amaSlopeGated,
            volatilityPenalty: volPenalty,
            finalOffset:      finalOff,
            ...blendReport,
            ...slopeConfigReport,
            ...volatilityReport,
            ...kalmanReport,
            rawFinalOffset:      rawFinalOff,
            maxAsymmetryFactor:  (cfg.asymmetricBounds?.maxAsymmetryFactor != null)
                ? cfg.asymmetricBounds.maxAsymmetryFactor
                : null,
            minScaleSlots: (cfg.asymmetricBounds?.minScaleSlots != null)
                ? cfg.asymmetricBounds.minScaleSlots
                : null,
            amaChannelContribution: amaSlopeGated,
            trend:                   slopeResult.trend,
            confidence:              slopeResult.confidence,
            slopePct:                slopeResult.slopePct,
            regimeMultiplier,
            regimeSensitivity,
            absoluteThreshold,
            minOutputThreshold,
            outputThreshold,
            belowMinOutputThreshold,
            kalmanReady:             kalmanResult?.isReady ?? false,
            ...(regimeResult ? {
                hurst:       regimeResult.hurst,
                pe:          regimeResult.pe,
                hurstRegime: regimeResult.hurstRegime,
                peRegime:    regimeResult.peRegime,
                regimeReady: regimeResult.isReady,
            } : {}),
            isReady:          slopeResult.isReady && (!belowMinOutputThreshold || volPenalty !== 0),
            updatedAt:        nowIso,
        };

        return { weights, dynamicWeightsPayload, slopeResult, regimeResult, kalmanResult, amaSlope };
    }

    async processBot(bot: JsonObj, state: AdapterState, cfg: JsonObj, contextCache: Map<string, ContextCacheEntry>, hooks: JsonObj = {}): Promise<BotCycleResult> {

        const deps = this.deps;
        const isDryRun = !!hooks.isDryRun;
        const forceWhitelistAll = !!hooks.forceWhitelistAll;
        let dryRunMessages: unknown[] = [];
        
        if ((!bot.assetA && !bot.assetAId) || (!bot.assetB && !bot.assetBId)) {
            return { ok: false, reason: 'missing asset pair' };
        }

        // Persisted state files may predate the `bots` map (or hold a partial
        // JSON) — normalize once here so every later state.bots access is safe.
        if (!state || typeof state !== 'object') {
            return { ok: false, reason: 'invalid adapter state' };
        }
        if (!state.bots || typeof state.bots !== 'object') {
            state.bots = {};
        }

        if (hasNumericStartPrice(bot?.startPrice)) {
            const nowIso = new Date().toISOString();
            const thresholdPercent = typeof deps.calculateBotThreshold === 'function'
                ? deps.calculateBotThreshold(cfg)
                : null;
            state.bots[String(bot.botKey)] = this.buildDefaultBotState(bot, {
                startPrice: bot.startPrice,
                priceMode: 'fixed',
                lastCycleSource: 'fixed-start-price',
                lastCycleAt: nowIso,
                lastTriggerSuppressedReason: 'fixed_start_price',
            });

            return this.buildDefaultResult(bot, {
                dryRunMessages,
                source: 'fixed-start-price',
                thresholdPercent,
                triggerSuppressedReason: 'fixed_start_price',
            });
        }

        const contextSignature = this.buildBotContextSignature(bot);
        const cached = contextCache.get(String(bot.botKey));
        const cachedCtx = (cached && typeof cached === 'object' && cached.ctx ? cached.ctx : cached) as JsonObj | null;
        const cachedSignature = cached && typeof cached === 'object' && cached.signature ? cached.signature : null;
        let ctx: JsonObj = cachedCtx ?? {};
        if (!cachedCtx || cachedSignature !== contextSignature) {
            ctx = (await deps.resolveBotContext(bot)) ?? {};
            contextCache.set(String(bot.botKey), {
                signature: contextSignature,
                ctx,
            });
        }

        const botAma = deps.resolveAmaForBot(bot, ctx, cfg);
        // `botAma.enabled` is a derived invariant (always true): `gridPrice` is
        // the single switch that makes a bot AMA-driven, and
        // usesAmaGridPrice(bot) below is what actually gates AMA work for this
        // bot. This guard stays only so a future resolver that can fail to
        // resolve an AMA config cannot silently trade on a missing one.
        if (!botAma.enabled) {
            return { ok: false, reason: 'ama disabled' };
        }
        const lookbackBars = normalizeAmaSlopeLookbackBars((cfg.amaSlope as JsonObj | undefined)?.lookbackBars);
        const filePath = deps.candleFileForBot(bot.botKey, Number(cfg.intervalSeconds));
        // mtime-validated read cache: the previous cycle serialized this very
        // file, so re-parsing ~250 KiB of JSON per bot per hour is pure waste.
        // The cache decides on the file's stat alone — an unstattable file (or a
        // storage adapter that reports no mtime) is never served from the cache
        // and always goes through the loader, so it can never serve stale data.
        // Injecting deps.loadJson does not change that decision; it only changes
        // what a cache miss parses.
        const existing = readCachedJson(filePath, () => deps.loadJson(filePath, null)) as JsonObj | null;
        const existingMeta: JsonObj = existing?.meta && typeof existing.meta === 'object' ? existing.meta as JsonObj : {};
        let existingCandles = Array.isArray(existing?.candles) ? existing.candles : [];
        const marketSource = resolveMarketSourceForBot(bot) || 'pool';
        const isBookSource = marketSource === 'book';
        // Retention targets, derived from the bot's own AMA parameters. Pure and
        // local, so they are computed before the off-hour gate below (which
        // needs the warmup target) and reused by the full path unchanged.
        const amaWarmupBars = getAmaWarmupBars(
            Number(botAma.erPeriod),
            Number(botAma.slowPeriod),
            lookbackBars,
            Number(botAma.fastPeriod)
        );
        const analysisKeepCount = amaWarmupBars + 1;
        // Retain one extra raw candle so the closed-candle analysis window still keeps a
        // full warmup/history set when the newest bucket is the current in-progress bar.
        const rawKeepCount = analysisKeepCount + 1;
        // Off-hour skip: the newest closed 1h bucket is already consumed, so
        // this bot cannot produce a new AMA, trigger, or snapshot this cycle.
        // Skip BEFORE the stale-tail Kibana verification and the native
        // overlap fetch below — on a mid-hour restart those are pure waste
        // (a per-bot RPC fetch, a Kibana round trip, and a ~250 KiB candle
        // re-serialize) for zero new information. Every input is already
        // local: persisted state, the candle file we just read, and the wall
        // clock. Note the chain connection itself is NOT saved here — the
        // daemon already opened it before runOnce; that socket is closed right
        // after the cycle, and the startup sleep is what avoids opening one.
        //
        // The local candle file is part of the verdict on purpose. The full
        // cycle also repairs history (Kibana backfill, gap fill) even when no
        // new candle closed, so a bot whose cache does not yet COVER the
        // newest closed bucket — short history, unresolved gaps, a source
        // change — must still run. Only a bot that has demonstrably consumed
        // that bucket and holds the data for it is skipped.
        const persistedBotState = (state?.bots && typeof state.bots === 'object')
            ? state.bots[String(bot.botKey)]
            : null;
        const offHourSkip = this.shouldSkipBotForClosedCandle(bot, persistedBotState as JsonObj, Number(cfg.intervalSeconds), undefined, cfg);
        const offHourSkipCovered = !!offHourSkip && this.candleFileCoversClosedBucket(
            existingCandles,
            existingMeta,
            marketSource,
            offHourSkip.latestClosedBucketStartMs,
            rawKeepCount
        );
        if (offHourSkip && offHourSkipCovered) {
            const skipNowIso = new Date().toISOString();
            const skipThreshold = typeof deps.calculateBotThreshold === 'function'
                ? deps.calculateBotThreshold(cfg)
                : null;
            const skippedState = {
                ...(persistedBotState && typeof persistedBotState === 'object' ? persistedBotState : {}),
                botName: bot.name,
                botKey: bot.botKey,
                lastCycleSource: 'off-hour-skip',
                lastCycleAt: skipNowIso,
                pendingClosedCandle: true,
                lastTriggerSuppressedReason: 'waiting_for_new_closed_candle',
            };
            state.bots[String(bot.botKey)] = skippedState;
            return this.buildDefaultResult(bot, {
                dryRunMessages,
                source: 'off-hour-skip',
                thresholdPercent: skipThreshold,
                triggerSuppressedReason: 'waiting_for_new_closed_candle',
                lastCandleTs: persistedBotState?.lastCandleTs ?? null,
                rawLastCandleTs: persistedBotState?.rawLastCandleTs ?? null,
                lastClosedCandleTs: offHourSkip.previousClosedCandleTs || null,
                pendingClosedCandle: true,
            });
        }
        const kibanaRequestTimeoutMs = Number.isFinite(Number(cfg.kibanaRequestTimeoutMs)) && Number(cfg.kibanaRequestTimeoutMs) > 0
            ? Number(cfg.kibanaRequestTimeoutMs)
            : MARKET_ADAPTER.KIBANA_REQUEST_TIMEOUT_MS;

        const fetchKibanaCandles = async (options: JsonObj = {}) => {
            const kibanaOptions = {
                timeout: kibanaRequestTimeoutMs,
                ...options,
            };
            if (isBookSource) {
                if (!deps.kibanaMarketSource || typeof deps.kibanaMarketSource.getMarketCandles !== 'function') {
                    throw new Error('order book candle source unavailable');
                }
                return deps.kibanaMarketSource.getMarketCandles(ctx.assetA, ctx.assetB, kibanaOptions);
            }

            if (!deps.kibanaSource || typeof deps.kibanaSource.getLpCandlesForPool !== 'function') {
                throw new Error('liquidity pool candle source unavailable');
            }
            return deps.kibanaSource.getLpCandlesForPool(ctx.poolId, ctx.assetA, ctx.assetB, kibanaOptions);
        };

        const staleTailVerifiedRangeFromMeta = () => {
            // Meta fields are persisted as explicit null when absent — guard
            // before Number() since Number(null) === 0 would masquerade as a
            // valid epoch timestamp.
            if (existingMeta.staleTailVerifiedStartTs == null || existingMeta.staleTailVerifiedEndTs == null) {
                return {};
            }
            const startTs = Number(existingMeta.staleTailVerifiedStartTs);
            const endTs = Number(existingMeta.staleTailVerifiedEndTs);
            if (Number.isFinite(startTs) && Number.isFinite(endTs)) {
                return { startTs, endTs };
            }
            return {};
        };

        const verifyAndPruneStaleTail = async (candles: unknown[], threshold: unknown, verifiedRange: JsonObj = {}) => {
            if (typeof deps.pruneStaleTail !== 'function') return { candles };
            const pruned = deps.pruneStaleTail(candles, threshold);
            if (pruned.length === candles.length || candles.length === 0) {
                return { candles: pruned };
            }

            // Use the shared detector to find the tail range without re-sorting
            const detected = typeof deps.detectStaleTail === 'function'
                ? deps.detectStaleTail(candles, threshold)
                : null;
            if (!detected) return { candles: pruned };
            const tailStartTs = detected.sorted[detected.sorted.length - detected.runLength][0];
            const tailEndTs = detected.sorted[detected.sorted.length - 1][0];

            // Skip Kibana verification if this tail range was already confirmed flat
            // on a previous cycle (the current tail is contained within a verified range).
            const vStart = Number(verifiedRange.startTs);
            const vEnd = Number(verifiedRange.endTs);
            if (Number.isFinite(vStart) && Number.isFinite(vEnd)
                    && tailStartTs >= vStart && tailEndTs <= vEnd) {
                return { candles, keptStaleTailStartTs: tailStartTs, keptStaleTailEndTs: tailEndTs };
            }

            // Verify with Kibana: did the market actually trade during this period?
            try {
                const kibanaCandles = await deps.withRetries(() => fetchKibanaCandles({
                    intervalSeconds: Number(cfg.intervalSeconds),
                    fillGapsToRequestedRange: false,
                    apiKey: null,
                    timeRange: {
                        gte: new Date(tailStartTs).toISOString(),
                        lte: new Date(tailEndTs).toISOString(),
                    },
                }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana stale-tail verification failed');

                if (Array.isArray(kibanaCandles) && kibanaCandles.length > 0) {
                    const hasKibanaActivity = kibanaCandles.some(
                        (c) => Array.isArray(c) && Number(c[5] || 0) > 0
                    );
                    if (!hasKibanaActivity) {
                        // Kibana confirms flat/inactive: our data is genuine → keep it
                        return { candles, keptStaleTailStartTs: tailStartTs, keptStaleTailEndTs: tailEndTs };
                    }
                    // Kibana shows real trades: our gap-fill is stale → prune it
                }
                // Kibana has no data for this period (or query failed) → prune
                return { candles: pruned };
            } catch (_) {
                // Kibana query failed: prune (existing behavior)
                return { candles: pruned };
            }
        };

        const applyStaleTailVerificationMeta = (verified: JsonObj) => {
            if (Number.isFinite(verified?.keptStaleTailStartTs) && Number.isFinite(verified?.keptStaleTailEndTs)) {
                existingMeta.staleTailVerifiedStartTs = verified.keptStaleTailStartTs;
                existingMeta.staleTailVerifiedEndTs = verified.keptStaleTailEndTs;
                return;
            }
            existingMeta.staleTailVerifiedStartTs = null;
            existingMeta.staleTailVerifiedEndTs = null;
        };

        // Prune stale trailing candles from a previous run before any processing.
        // Verifies with Kibana first to avoid removing genuinely flat market periods.
        if (existingCandles.length > 0) {
            const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                ? cfg.staleTailThreshold
                : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
            const verified = await verifyAndPruneStaleTail(
                existingCandles, staleThreshold, staleTailVerifiedRangeFromMeta()
            );
            existingCandles = verified.candles;
            applyStaleTailVerificationMeta(verified);
        }

        const sourceMismatch = this.isCandleSourceMismatch(existingMeta, marketSource);
        if (sourceMismatch) {
            existingCandles = [];
            existingMeta.nativeRecentTradeSequences = [];
            existingMeta.nativeLastTradeTs = null;
            existingMeta.staleTailVerifiedStartTs = null;
            existingMeta.staleTailVerifiedEndTs = null;
        }

        const needBootstrap = existingCandles.length === 0;
        const nowIso = new Date().toISOString();
        const botThreshold = deps.calculateBotThreshold(cfg);
        if (!Number.isFinite(botThreshold) || botThreshold <= 0) {
            throw new Error(`deltaThresholdPercent missing/invalid for bot ${bot.name}`);
        }

        const loadCandles = async () => {
            let nextCandles = existingCandles;
            let sourceLabel = 'native-incremental';
            let kibanaBootstrapEmpty = false;
            let nativeRecentTradeSequences = Array.isArray(existingMeta.nativeRecentTradeSequences)
                ? existingMeta.nativeRecentTradeSequences.slice()
                : [];
            let nativeLastTradeTs = Number.isFinite(existingMeta.nativeLastTradeTs)
                ? existingMeta.nativeLastTradeTs
                : null;
            let nativeOverlapCount: number | null = null;
            let nativePagesFetched: number | null = null;
            // Policy:
            // - Trust native "no trades" directly for bounded runs up to this threshold.
            // - Only escalate to Kibana verification once a no-trade run exceeds it.
            // - Reuse the same threshold when deciding whether an old internal hole is
            //   small enough to synthesize after Kibana also returns no candles.
            const trustedNoTradeGapThresholdCandles = this.getTrustedNoTradeGapThresholdCandles(cfg);
            const logGapRepairEvent = (message: string, level: string = 'info') => {
                if (typeof deps.logger?.log === 'function') {
                    deps.logger.log(message, level);
                } else if (level === 'warn' && typeof deps.logger?.warn === 'function') {
                    deps.logger.warn(message);
                } else if (level === 'info' && typeof deps.logger?.info === 'function') {
                    deps.logger.info(message);
                } else if (typeof deps.logger?.warn === 'function') {
                    deps.logger.warn(message);
                }
            };
            const hasKibanaSource = isBookSource
                ? deps.kibanaMarketSource && typeof deps.kibanaMarketSource.getMarketCandles === 'function'
                : deps.kibanaSource && typeof deps.kibanaSource.getLpCandlesForPool === 'function';
            const verifyAndFillLongSilence = async (candles: number[][], lastTs: number, latestClosedBucketTs: number, sourceLabel: string, incomingCandles: unknown = []) => {
                const bucketMs = Number(Number(cfg.intervalSeconds)) * 1000;
                const silenceStartTs = Number(lastTs) + bucketMs;
                const earliestIncomingTs = (Array.isArray(incomingCandles) ? incomingCandles : [])
                    .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && c[0] > lastTs)
                    .sort((a, b) => a[0] - b[0])[0]?.[0];
                const silenceEndTs = Number.isFinite(earliestIncomingTs) && earliestIncomingTs > silenceStartTs
                    ? earliestIncomingTs - bucketMs
                    : Number(latestClosedBucketTs);
                if (!hasKibanaSource || typeof deps.fillCandleGaps !== 'function') {
                    return { candles, sourceLabel };
                }
                if (!Number.isFinite(bucketMs) || bucketMs <= 0 || !Number.isFinite(silenceStartTs) || !Number.isFinite(silenceEndTs) || silenceEndTs < silenceStartTs) {
                    return { candles, sourceLabel };
                }

                try {
                    const kibanaSilenceCandles = await deps.withRetries(() => fetchKibanaCandles({
                        intervalSeconds: Number(cfg.intervalSeconds),
                        fillGapsToRequestedRange: false,
                        apiKey: null,
                        timeRange: {
                            gte: new Date(silenceStartTs).toISOString(),
                            lte: new Date(silenceEndTs).toISOString(),
                        },
                    }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana long-silence verification failed');

                    const hasKibanaActivity = Array.isArray(kibanaSilenceCandles) && kibanaSilenceCandles.some(
                        (c) => Array.isArray(c) && Number(c[5] || 0) > 0
                    );
                    if (hasKibanaActivity) {
                        return {
                            candles: deps.mergeCandles(candles, kibanaSilenceCandles, {
                                onCollision: (existingCandle: number[], incomingCandle: number[]) => this.buildIncrementalCandleCollision(existingCandle, incomingCandle),
                            }),
                            sourceLabel: `${sourceLabel}+kibana-silence-activity`,
                        };
                    }

                    const previousCandle = candles
                        .filter((c: unknown) => Array.isArray(c) && c[0] === lastTs)
                        .slice(-1)[0];
                    const filledSilence = previousCandle
                        ? deps.fillCandleGaps([previousCandle, ...(Array.isArray(incomingCandles) ? incomingCandles : [])], Number(cfg.intervalSeconds), lastTs, silenceEndTs)
                            .filter((c: unknown) => Array.isArray(c) && c[0] > lastTs)
                        : [];
                    if (filledSilence.length === 0) return { candles, sourceLabel };

                    existingMeta.staleTailVerifiedStartTs = silenceStartTs;
                    existingMeta.staleTailVerifiedEndTs = silenceEndTs;
                    const lastClose = previousCandle?.[4];
                    const message = `[market_adapter] ${bot.botKey}: verified no trades from ${new Date(silenceStartTs).toISOString()} to ${new Date(silenceEndTs).toISOString()}; carrying flat close ${Number.isFinite(Number(lastClose)) ? Number(lastClose) : 'n/a'}`;
                    if (typeof deps.logger?.log === 'function') {
                        deps.logger.log(message, 'info');
                    } else if (typeof deps.logger?.info === 'function') {
                        deps.logger.info(message);
                    } else if (typeof deps.logger?.warn === 'function') {
                        deps.logger.warn(message);
                    }

                    return {
                        candles: deps.mergeCandles(candles, filledSilence),
                        sourceLabel: `${sourceLabel}+verified-silence`,
                    };
                } catch (_) {
                    // Verification failed: preserve stale-data protection.
                    return { candles, sourceLabel };
                }
            };
            const fillBoundedTrailingClosedGap = (candles: number[][], latestClosedBucketTs: number, nowMs: number, maxNativeGapFill: number) => {
                const bucketMs = Number(Number(cfg.intervalSeconds)) * 1000;
                const latestKnownTs = Array.isArray(candles) && candles.length > 0
                    ? candles[candles.length - 1]?.[0]
                    : null;
                const trailingGapBuckets = Number.isFinite(bucketMs) && bucketMs > 0
                    && Number.isFinite(latestClosedBucketTs) && latestKnownTs != null && Number.isFinite(latestKnownTs)
                    && latestClosedBucketTs > latestKnownTs
                    ? Math.round((latestClosedBucketTs - latestKnownTs) / bucketMs)
                    : 0;
                if (trailingGapBuckets <= 0 || trailingGapBuckets > maxNativeGapFill) {
                    return candles;
                }
                return this.fillNativeIncrementalClosedGaps(candles, latestKnownTs, Number(cfg.intervalSeconds), nowMs);
            };

            if (isBookSource) {
                nativeRecentTradeSequences = [];
                nativeLastTradeTs = null;
                nativeOverlapCount = null;
                nativePagesFetched = null;
                const bucketMs = Number(Number(cfg.intervalSeconds)) * 1000;
                const nowMs = this.getNowMs();

                // Native order-book history fetch shared by the bootstrap
                // fallback and the incremental path. Returns [] on failure
                // (after the same warn the inline blocks used to emit).
                const fetchNativeHistory = async (startMs: number, failureLabel: string): Promise<number[][]> => {
                    try {
                        if (typeof deps.fetchNativeMarketHistorySince === 'function') {
                            return await deps.withRetries(() => deps.fetchNativeMarketHistorySince(
                                ctx.assetA,
                                ctx.assetB,
                                startMs,
                                nowMs,
                                Number(cfg.intervalSeconds),
                                { fillCandleGaps: deps.fillCandleGaps }
                            ), cfg.sourceRetries, cfg.retryDelayMs, failureLabel);
                        }
                    } catch (_) {
                        if (typeof deps.logger?.warn === 'function') deps.logger.warn(`[market_adapter] ${ctx.botKey}: ${failureLabel}`);
                    }
                    return [];
                };

                if (needBootstrap) {
                    // Bootstrap: Kibana first (deep history), native as fallback
                    const kibanaLookbackHours = this.bootstrapKibanaLookbackHours(cfg, rawKeepCount);
                    let kibanaCandles: unknown = null;
                    try {
                        kibanaCandles = await deps.withRetries(() => fetchKibanaCandles({
                            intervalSeconds: Number(cfg.intervalSeconds),
                            lookbackHours: kibanaLookbackHours,
                            fillGapsToRequestedRange: false,
                            apiKey: null,
                        }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana order book bootstrap failed');
                    } catch (_) {
                        if (typeof deps.logger?.warn === 'function') deps.logger.warn(`[market_adapter] ${ctx.botKey}: kibana order book bootstrap failed`);
                    }

                    if (Array.isArray(kibanaCandles) && kibanaCandles.length > 0) {
                        nextCandles = kibanaCandles;
                        sourceLabel = 'kibana-book-bootstrap';
                    } else {
                        // Fall back to native
                        const nativeLookbackHours = Math.max(
                            Number(cfg.bootstrapLookbackHours) || 0,
                            Number(Number(cfg.nativeBackfillHours)) || 0,
                            (analysisKeepCount * Math.max(Number(Number(cfg.intervalSeconds)) || 3600, 3600)) / 3600
                        );
                        const nativeStartMs = Math.max(0, nowMs - (nativeLookbackHours * 3600 * 1000));
                        const nativeCandles = await fetchNativeHistory(nativeStartMs, 'native market history bootstrap failed');

                        if (Array.isArray(nativeCandles) && nativeCandles.length > 0) {
                            nextCandles = nativeCandles;
                            sourceLabel = 'native-book-bootstrap';
                        } else {
                            throw new Error('both kibana and native order book bootstrap failed');
                        }
                    }
                } else {
                    // Incremental: native fetch
                    const lastTs = nextCandles[nextCandles.length - 1]?.[0] || 0;
                    const nativeStartMs = Math.max(0, lastTs - bucketMs);
                    const nativeCandles = await fetchNativeHistory(nativeStartMs, 'native market history fetch failed');

                    if (Array.isArray(nativeCandles) && nativeCandles.length > 0) {
                        nextCandles = deps.mergeCandles(nextCandles, nativeCandles);
                        sourceLabel = 'native-book-history';
                    } else {
                        sourceLabel = 'cached-book';
                    }

                    const currentBucketStartMs = Math.floor(Number(nowMs) / bucketMs) * bucketMs;
                    const latestClosedBucketTs = currentBucketStartMs - bucketMs;
                    const earliestIncomingTs = nativeCandles.length > 0 ? nativeCandles[0][0] : null;
                    const gapEndTs: number | null = earliestIncomingTs != null && Number.isFinite(earliestIncomingTs) && earliestIncomingTs > lastTs
                        ? earliestIncomingTs
                        : latestClosedBucketTs + bucketMs;
                    const gapBuckets = gapEndTs !== null && gapEndTs > lastTs
                        ? Math.round((gapEndTs - lastTs) / bucketMs) - 1
                        : 0;
                    const maxNativeGapFill = Number.isFinite(Number(cfg.maxNativeGapFillCandles))
                        ? Number(cfg.maxNativeGapFillCandles)
                        : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
                    if (gapBuckets > maxNativeGapFill) {
                        const verifiedSilence = await verifyAndFillLongSilence(
                            nextCandles, lastTs, latestClosedBucketTs, sourceLabel, nativeCandles
                        );
                        nextCandles = verifiedSilence.candles;
                        sourceLabel = verifiedSilence.sourceLabel;
                        nextCandles = fillBoundedTrailingClosedGap(nextCandles, latestClosedBucketTs, nowMs, maxNativeGapFill);
                    } else {
                        nextCandles = fillBoundedTrailingClosedGap(nextCandles, latestClosedBucketTs, nowMs, maxNativeGapFill);
                    }
                }

                if (nextCandles.length > 0) {
                    const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                        ? cfg.staleTailThreshold
                        : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
                    const verified = await verifyAndPruneStaleTail(
                        nextCandles, staleThreshold, staleTailVerifiedRangeFromMeta()
                    );
                    nextCandles = verified.candles;
                    applyStaleTailVerificationMeta(verified);

                }
            } else if (needBootstrap) {
                const lookbackHours = this.bootstrapKibanaLookbackHours(cfg, rawKeepCount);

                // ── Step 1: Kibana first (deep history, handles large candle requirements) ──
                let kibanaCandles: unknown = null;
                try {
                    kibanaCandles = await deps.withRetries(() => fetchKibanaCandles({
                        intervalSeconds: Number(cfg.intervalSeconds),
                        lookbackHours,
                        fillGapsToRequestedRange: false,
                        apiKey: null,
                    }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana bootstrap failed');
                } catch (_) {
                    kibanaCandles = null;
                }

                if (Array.isArray(kibanaCandles) && kibanaCandles.length >= amaWarmupBars) {
                    nextCandles = kibanaCandles;
                    sourceLabel = 'kibana-bootstrap';
                } else {
                    // ── Step 2: Kibana insufficient → fall back to native ──
                    let nativeCandles: number[][] = [];
                        try {
                            const sinceMs = Date.now() - (lookbackHours * 3600 * 1000);
                            const fetchResult = await deps.withRetries(
                                () => deps.fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                                cfg.sourceRetries,
                                cfg.retryDelayMs,
                                'native bootstrap failed'
                            );
                            const trades = Array.isArray(fetchResult?.trades) ? fetchResult.trades : [];
                            if (fetchResult?.truncated && typeof deps.logger?.warn === 'function') {
                                deps.logger.warn(`[market_adapter] ${bot.botKey}: native bootstrap history truncated (exhausted ${cfg.maxPages} pages)`);
                            }
                            if (trades.length > 0) {
                                nativeRecentTradeSequences = this.getNativeRecentTradeSequences(trades);
                                const latestTradeTs = Math.max(...(trades as Array<{ tsMs?: unknown }>).map((t) => Number(t?.tsMs)).filter(Number.isFinite));
                                if (Number.isFinite(latestTradeTs)) nativeLastTradeTs = latestTradeTs;
                            }
                            nativeCandles = deps.tradesToCandles(trades, ctx.assetA, ctx.assetB, Number(cfg.intervalSeconds));
                        if (nativeCandles.length > 0 && typeof deps.fillCandleGaps === 'function') {
                            const eTs = nativeCandles[0][0];
                            const lTs = nativeCandles[nativeCandles.length - 1][0];
                            nativeCandles = deps.fillCandleGaps(nativeCandles, Number(cfg.intervalSeconds), eTs, lTs);
                        }
                    } catch (_) {
                        nativeCandles = [];
                    }

                    if (Array.isArray(kibanaCandles) && kibanaCandles.length > 0) {
                        if (nativeCandles.length > 0) {
                            // Stitch: Kibana older + Native recent (no overlap; native wins)
                            const nativeOldestTs = nativeCandles[0][0];
                            const kbnOlder = kibanaCandles.filter(
                                (c) => Array.isArray(c) && c[0] < nativeOldestTs
                            );
                            const stitched = [...kbnOlder, ...nativeCandles]
                                .sort((a, b) => a[0] - b[0]);
                            if (stitched.length > 1 && typeof deps.fillCandleGaps === 'function') {
                                const sTs = stitched[0][0];
                                const eTs = stitched[stitched.length - 1][0];
                                nextCandles = deps.fillCandleGaps(stitched, Number(cfg.intervalSeconds), sTs, eTs);
                            } else {
                                nextCandles = stitched;
                            }
                            sourceLabel = 'kibana+native-bootstrap';
                        } else {
                            nextCandles = kibanaCandles;
                            sourceLabel = 'kibana-bootstrap';
                        }
                    } else if (nativeCandles.length > 0) {
                        kibanaBootstrapEmpty = true;
                        nextCandles = nativeCandles;
                        sourceLabel = 'native-bootstrap';
                    } else {
                        kibanaBootstrapEmpty = true;
                    }
                }
            } else {
                const lastTs = existingCandles[existingCandles.length - 1]?.[0] || 0;

                try {
                    const knownSequences = new Set(nativeRecentTradeSequences.map((seq: unknown) => String(seq)));
                    let fetchedTrades: JsonObj[] = [];
                    let newTrades: JsonObj[] = [];
                    let overlapUsed = false;

                    if (knownSequences.size >= 2 && typeof deps.fetchNativeTradesUntilOverlap === 'function') {
                        try {
                            const overlapResult = await deps.withRetries(
                                () => deps.fetchNativeTradesUntilOverlap(ctx.poolId, nativeRecentTradeSequences, 2, cfg.pageLimit, cfg.maxPages),
                                cfg.sourceRetries,
                                cfg.retryDelayMs,
                                'native incremental overlap fetch failed'
                            );
                            if (overlapResult?.reachedOverlap === false) {
                                if (typeof deps.logger?.warn === 'function') {
                                    deps.logger.warn(`[market_adapter] ${bot.botKey}: native overlap fetch exhausted (${cfg.maxPages} pages) without finding an overlap; falling back to time-based`);
                                }
                            } else {
                                fetchedTrades = Array.isArray(overlapResult?.trades) ? overlapResult.trades : [];
                                nativeOverlapCount = Number(overlapResult?.overlapCount || 0);
                                nativePagesFetched = Number(overlapResult?.pages || 0);
                                sourceLabel = 'native-incremental-overlap';
                                newTrades = fetchedTrades.filter((trade) => {
                                    if (!Number.isFinite(Number(trade?.sequence))) return true;
                                    return !knownSequences.has(String(trade.sequence));
                                });
                                overlapUsed = true;
                            }
                        } catch (overlapErr) {
                            if (typeof deps.logger?.log === 'function') {
                                deps.logger.log(`[market_adapter] ${bot.botKey}: overlap fetch exhausted (${getErrorMessage(overlapErr)}), falling back to time-based`, 'warn');
                            }
                            // Fall through to time-based path below
                        }
                    }

                    if (!overlapUsed) {
                        const sinceMs = lastTs - (Number(cfg.nativeBackfillHours) * 3600 * 1000);
                        const fetchResult = await deps.withRetries(
                            () => deps.fetchNativeTradesSince(ctx.poolId, sinceMs, cfg.pageLimit, cfg.maxPages),
                            cfg.sourceRetries,
                            cfg.retryDelayMs,
                            'native incremental fetch failed'
                        );
                        fetchedTrades = Array.isArray(fetchResult?.trades) ? fetchResult.trades : [];
                        if (fetchResult?.truncated && typeof deps.logger?.warn === 'function') {
                            deps.logger.warn(`[market_adapter] ${bot.botKey}: native incremental history truncated (exhausted ${cfg.maxPages} pages)`);
                        }
                        newTrades = this.filterTimeBasedNativeNewTrades(
                            fetchedTrades,
                            knownSequences,
                            nativeLastTradeTs,
                            lastTs,
                            Number(cfg.intervalSeconds)
                        );
                        sourceLabel = 'native-incremental-time';
                        nativeOverlapCount = null;
                        nativePagesFetched = fetchResult?.pages || null;
                    }

                    if (fetchedTrades.length > 0) {
                        nativeRecentTradeSequences = this.getNativeRecentTradeSequences(fetchedTrades);
                        const latestTradeTs = Math.max(...fetchedTrades.map((t) => Number(t?.tsMs)).filter(Number.isFinite));
                        if (Number.isFinite(latestTradeTs)) nativeLastTradeTs = latestTradeTs;
                    }

                    const incomingCandles = deps.tradesToCandles(newTrades, ctx.assetA, ctx.assetB, Number(cfg.intervalSeconds));
                    nextCandles = deps.mergeCandles(existingCandles, incomingCandles, {
                        onCollision: (existingCandle: number[], incomingCandle: number[]) => this.buildIncrementalCandleCollision(existingCandle, incomingCandle),
                    });

                    // Fill bounded no-trade gaps from native incremental fetch. Ordinary LP
                    // inactivity should remain a continuous flat 1h series; very large gaps stay
                    // visible for Kibana repair/stale-tail handling instead of carrying stale prices.
                    const bucketMs = Number(Number(cfg.intervalSeconds)) * 1000;
                    const nowMs = this.getNowMs();
                    const currentBucketStartMs = Math.floor(Number(nowMs) / bucketMs) * bucketMs;
                    const latestClosedBucketTs = currentBucketStartMs - bucketMs;
                    const earliestIncomingTs = incomingCandles.length > 0 ? Number((incomingCandles[0] as unknown[])[0]) : null;
                    const gapEndTs = (earliestIncomingTs != null && Number.isFinite(earliestIncomingTs) && earliestIncomingTs > lastTs)
                        ? earliestIncomingTs
                        : latestClosedBucketTs + bucketMs;
                    const gapBuckets = Number.isFinite(gapEndTs) && gapEndTs > lastTs
                        ? Math.round((gapEndTs - lastTs) / bucketMs) - 1
                        : 0;
                    if (gapBuckets <= trustedNoTradeGapThresholdCandles) {
                        nextCandles = this.fillNativeIncrementalClosedGaps(nextCandles, lastTs, Number(cfg.intervalSeconds));
                    } else {
                        const verifiedSilence = await verifyAndFillLongSilence(
                            nextCandles, lastTs, latestClosedBucketTs, sourceLabel, incomingCandles
                        );
                        nextCandles = verifiedSilence.candles;
                        sourceLabel = verifiedSilence.sourceLabel;
                        nextCandles = fillBoundedTrailingClosedGap(nextCandles, latestClosedBucketTs, nowMs, trustedNoTradeGapThresholdCandles);
                    }
                } catch (err) {
                    if (typeof deps.logger?.warn === 'function') {
                        deps.logger.warn(`[market_adapter] Native fetch failed for ${bot.botKey}; continuing with cached candles (${getErrorMessage(err)})`);
                    }
                    nativePagesFetched = 0;
                    nativeOverlapCount = null;
                    sourceLabel = 'cached-native-fetch-err';
                    nextCandles = existingCandles;
                }

                // After incremental merge (or native fetch failure), prune any stale tail
                // that may have been carried forward when the pool had no activity.
                // Verifies with Kibana first to avoid removing genuinely flat market periods.
                const staleThreshold = Number.isFinite(cfg.staleTailThreshold)
                    ? cfg.staleTailThreshold
                    : MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES;
                const verified = await verifyAndPruneStaleTail(
                    nextCandles, staleThreshold, staleTailVerifiedRangeFromMeta()
                );
                nextCandles = verified.candles;
                applyStaleTailVerificationMeta(verified);

            }

            let kibanaGapRepairTimestamps: number[] = [];
            let kibanaGapRepairAttempted = false;
            let gapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                ? deps.detectMissingCandleTimestamps(nextCandles, Number(cfg.intervalSeconds))
                : { gapCount: 0, missingTimestamps: [] };

            // Step 1: Fill gaps within the trusted no-trade threshold directly (no Kibana needed).
            // The native incremental fetch already confirmed no trades for these timestamps.
            if (gapAnalysis.gapCount > 0) {
                const filledNoTrade = this.fillVerifiedInternalNoTradeGaps(
                    nextCandles,
                    gapAnalysis.missingTimestamps,
                    Number(Number(cfg.intervalSeconds)),
                    trustedNoTradeGapThresholdCandles
                );
                if (filledNoTrade.filledTimestamps.length > 0) {
                    nextCandles = filledNoTrade.candles;
                    kibanaGapRepairTimestamps = filledNoTrade.filledTimestamps.slice();
                    logGapRepairEvent(
                        `[market_adapter] ${bot.botKey}: synthesized ${filledNoTrade.filledTimestamps.length} no-trade candle(s) within trusted threshold `
                        + `[${filledNoTrade.filledTimestamps.map((ts: unknown) => new Date(Number(ts)).toISOString()).join(', ')}]`
                    );
                }
                // Re-detect gaps — only beyond-threshold gaps remain
                gapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                    ? deps.detectMissingCandleTimestamps(nextCandles, Number(cfg.intervalSeconds))
                    : { gapCount: 0, missingTimestamps: [] };
            }

            // Step 2: Only query Kibana for gaps beyond the trusted threshold
            if (gapAnalysis.gapCount > 0 && hasKibanaSource) {
                const timeRange = this.buildGapRepairTimeRange(
                    gapAnalysis.missingTimestamps,
                    Number(cfg.intervalSeconds),
                    this.getGapRepairMaxHours(cfg)
                );
                if (timeRange) {
                    kibanaGapRepairAttempted = true;
                    logGapRepairEvent(
                        `[market_adapter] ${bot.botKey}: ${gapAnalysis.gapCount} candle gap(s) beyond trusted threshold; `
                        + `requesting Kibana repair for ${timeRange.gte} -> ${timeRange.lte} `
                        + `missing=[${gapAnalysis.missingTimestamps.map((ts: unknown) => new Date(Number(ts)).toISOString()).join(', ')}]`
                    );
                    try {
                        const kibanaGapCandles = await deps.withRetries(() => fetchKibanaCandles({
                            intervalSeconds: Number(cfg.intervalSeconds),
                            fillGapsToRequestedRange: false,
                            apiKey: null,
                            timeRange,
                        }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana gap repair failed');

                        logGapRepairEvent(
                            `[market_adapter] ${bot.botKey}: Kibana gap repair returned `
                            + `${Array.isArray(kibanaGapCandles) ? kibanaGapCandles.length : 0} candle(s) `
                            + `for ${timeRange.gte} -> ${timeRange.lte}`
                        );

                        if (Array.isArray(kibanaGapCandles) && kibanaGapCandles.length > 0) {
                            const beforeTimestamps = new Set(nextCandles.map((c: unknown) => (c as unknown[])[0]));
                            nextCandles = deps.mergeCandles(nextCandles, kibanaGapCandles);
                            const afterTimestamps = new Set(nextCandles.map((c: unknown) => (c as unknown[])[0]));
                            const kibanaPatchedTs = gapAnalysis.missingTimestamps.filter((ts: unknown) => !beforeTimestamps.has(ts) && afterTimestamps.has(ts));
                            kibanaGapRepairTimestamps = [...kibanaGapRepairTimestamps, ...kibanaPatchedTs];
                            logGapRepairEvent(
                                `[market_adapter] ${bot.botKey}: Kibana gap repair patched ${kibanaPatchedTs.length}/${gapAnalysis.gapCount} gap(s)`
                                + (kibanaPatchedTs.length > 0
                                    ? ` [${kibanaPatchedTs.map((ts: unknown) => new Date(Number(ts)).toISOString()).join(', ')}]`
                                    : '')
                            );
                        } else {
                            // Kibana returned no data — that IS verification: no trades happened.
                            // Synthesize no-trade candles for all gaps within the queried window.
                            const verifiedGapTimestamps = this.getMissingTimestampsWithinTimeRange(
                                gapAnalysis.missingTimestamps,
                                timeRange
                            );
                            const verifiedNoTrade = this.fillVerifiedInternalNoTradeGaps(
                                nextCandles,
                                verifiedGapTimestamps,
                                Number(cfg.intervalSeconds),
                                verifiedGapTimestamps.length
                            );
                            if (verifiedNoTrade.filledTimestamps.length > 0) {
                                nextCandles = verifiedNoTrade.candles;
                                kibanaGapRepairTimestamps = [...kibanaGapRepairTimestamps, ...verifiedNoTrade.filledTimestamps];
                                logGapRepairEvent(
                                    `[market_adapter] ${bot.botKey}: synthesized ${verifiedNoTrade.filledTimestamps.length} no-trade candle(s) after empty Kibana repair `
                                    + `[${verifiedNoTrade.filledTimestamps.map((ts: unknown) => new Date(Number(ts)).toISOString()).join(', ')}]`
                                );
                            } else {
                                logGapRepairEvent(
                                    `[market_adapter] ${bot.botKey}: Kibana empty but could not synthesize gaps (missing neighbors)`,
                                    'warn'
                                );
                            }
                        }
                    } catch (err) {
                        logGapRepairEvent(
                            `[market_adapter] ${bot.botKey}: Kibana gap repair failed (${getErrorMessage(err) || String(err)})`,
                            'warn'
                        );
                    }
                }
                gapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                    ? deps.detectMissingCandleTimestamps(nextCandles, Number(cfg.intervalSeconds))
                    : { gapCount: 0, missingTimestamps: [] };
                if (gapAnalysis.gapCount > 0) {
                    logGapRepairEvent(
                        `[market_adapter] ${bot.botKey}: ${gapAnalysis.gapCount} candle gap(s) still unresolved after Kibana repair `
                        + `[${gapAnalysis.missingTimestamps.map((ts: unknown) => new Date(Number(ts)).toISOString()).join(', ')}]`,
                        'warn'
                    );
                }
            }

            // ── Historical backfill: if candle count is still insufficient for AMA warmup,
            //    fetch older history from Kibana using a targeted timeRange. This handles
            //    cases where native bootstrap fell short or the file was truncated.
            const candleShortfall = rawKeepCount - nextCandles.length;
            let kibanaBackfillCount = 0;
            const needsHistoricalBackfill = !kibanaGapRepairAttempted || gapAnalysis.gapCount > 0;
            if (!kibanaBootstrapEmpty && needsHistoricalBackfill && candleShortfall > 0 && nextCandles.length > 0 && hasKibanaSource) {
                const oldestTs = nextCandles[0][0];
                const shortfallMs = candleShortfall * Number(cfg.intervalSeconds) * 1000;
                const bufferMs = 24 * 3600 * 1000; // 24h buffer
                const backfillStartMs = Math.max(0, oldestTs - shortfallMs - bufferMs);
                const backfillEndMs = oldestTs + Number(cfg.intervalSeconds) * 1000;
                try {
                    const historicalCandles = await deps.withRetries(() => fetchKibanaCandles({
                        intervalSeconds: Number(cfg.intervalSeconds),
                        fillGapsToRequestedRange: false,
                        apiKey: null,
                        timeRange: {
                            gte: new Date(backfillStartMs).toISOString(),
                            lte: new Date(backfillEndMs).toISOString(),
                        },
                    }), cfg.sourceRetries, cfg.retryDelayMs, 'kibana historical backfill failed');
                    if (Array.isArray(historicalCandles) && historicalCandles.length > 0) {
                        nextCandles = deps.mergeCandles(nextCandles, historicalCandles);
                        kibanaBackfillCount = historicalCandles.length;
                        sourceLabel = `${sourceLabel}+kibana-backfill`;
                    }
                } catch (_) {
                    if (typeof deps.logger?.warn === 'function') deps.logger.warn(`[market_adapter] ${ctx.botKey}: kibana historical backfill failed`);
                }
            }

            nextCandles = deps.pruneCandles(nextCandles, rawKeepCount);
            const retainedTimestamps = new Set(nextCandles.map((c: unknown) => (c as unknown[])[0]));
            const kibanaGapRepairCount = kibanaGapRepairTimestamps.filter((ts) => retainedTimestamps.has(ts)).length;
            const retainedGapAnalysis = typeof deps.detectMissingCandleTimestamps === 'function'
                ? deps.detectMissingCandleTimestamps(nextCandles, Number(cfg.intervalSeconds))
                : { gapCount: 0, missingTimestamps: [] };
            return {
                nextCandles,
                sourceLabel,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount: retainedGapAnalysis.gapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
            };
        };

        let closedCandles: number[][] = [];
        let currentBucketStartMs: number | null = null;
        let rawLastCandle: number[] = [0, 0, 0, 0, 0];
        let rawLastCandleTs: number | null = null;
        let latestClosedCandle: number[] | null = null;
        let lastClosedCandleTs: number | null = null;
        let botState: JsonObj = {};
        let previousClosedCandleTs = 0;
        let hasNewClosedCandle = false;
        let consumedClosedCandleTs: number | null = null;
        let nextCandles = existingCandles;
        let sourceLabel = 'native-incremental';
        let kibanaGapRepairCount = 0;
        let kibanaBackfillCount = 0;
        let unresolvedGapCount = 0;
        let nativeRecentTradeSequences: number[] = [];
        let nativeLastTradeTs: number | null = null;
        let nativeOverlapCount: number | null = null;
        let nativePagesFetched: number | null = null;

        const loadResult = await loadCandles();
        nextCandles = loadResult.nextCandles;
        sourceLabel = loadResult.sourceLabel;
        kibanaGapRepairCount = loadResult.kibanaGapRepairCount;
        kibanaBackfillCount = loadResult.kibanaBackfillCount || 0;
        unresolvedGapCount = loadResult.unresolvedGapCount;
        nativeRecentTradeSequences = Array.isArray(loadResult.nativeRecentTradeSequences) ? loadResult.nativeRecentTradeSequences : [];
        nativeLastTradeTs = Number.isFinite(loadResult.nativeLastTradeTs) ? Number(loadResult.nativeLastTradeTs) : null;
        nativeOverlapCount = Number.isFinite(loadResult.nativeOverlapCount) ? Number(loadResult.nativeOverlapCount) : null;
        nativePagesFetched = Number.isFinite(loadResult.nativePagesFetched) ? Number(loadResult.nativePagesFetched) : null;

        const nowMs = this.getNowMs();
        ({ closedCandles, currentBucketStartMs } = this.selectClosedCandles(nextCandles, Number(cfg.intervalSeconds), nowMs));
        rawLastCandle = nextCandles[nextCandles.length - 1] || [0, 0, 0, 0, 0];
        rawLastCandleTs = rawLastCandle[0] || null;
        latestClosedCandle = closedCandles[closedCandles.length - 1] || null;
        lastClosedCandleTs = latestClosedCandle ? latestClosedCandle[0] : null;
        botState = this.normalizePersistedBotState(state.bots[String(bot.botKey)], lookbackBars);
        if (sourceMismatch) {
            botState = {};
        }
        const stateGridCenterPrice = Number(botState.gridCenterPrice ?? botState.centerPrice);
        if (Number.isFinite(stateGridCenterPrice) && stateGridCenterPrice > 0) {
            botState.gridCenterPrice = stateGridCenterPrice;
            botState.centerPrice = stateGridCenterPrice;
        }
        const dynGridPath = deps.path.join(
            deps.ordersDir, `${bot.botKey}.dynamicgrid.json`,
        );
        const persistedDynamicGridState = typeof deps.loadJson === 'function'
            ? this.extractPersistedDynamicGridState(deps.loadJson(dynGridPath, null) as JsonObj, lookbackBars)
            : null;
        if (persistedDynamicGridState) {
            const persistedResetMs = Date.parse(String(persistedDynamicGridState.lastGridResetAt || ''));
            const stateResetMs = Date.parse(String(botState.lastGridResetAt || ''));
            const persistedResetIsNewer = Number.isFinite(persistedResetMs)
                && (!Number.isFinite(stateResetMs) || persistedResetMs >= stateResetMs);
            if ((persistedResetIsNewer || !(Number(botState.gridCenterPrice ?? botState.centerPrice) > 0))
                    && persistedDynamicGridState.gridCenterPrice) {
                botState.gridCenterPrice = persistedDynamicGridState.gridCenterPrice;
                botState.centerPrice = persistedDynamicGridState.gridCenterPrice;
            }
            if (persistedResetIsNewer) {
                botState.lastGridResetAt = persistedDynamicGridState.lastGridResetAt;
                if (persistedDynamicGridState.lastGridResetSource) {
                    botState.lastGridResetSource = persistedDynamicGridState.lastGridResetSource;
                }
            }
            if (!(Number(botState.amaCenterPrice) > 0) && persistedDynamicGridState.amaCenterPrice) {
                botState.amaCenterPrice = persistedDynamicGridState.amaCenterPrice;
            }
            if (!botState.amaSlope && persistedDynamicGridState.amaSlope) {
                botState.amaSlope = persistedDynamicGridState.amaSlope;
            }
            if (!botState.gridRangeScalingAmaSlope && persistedDynamicGridState.gridRangeScalingAmaSlope) {
                botState.gridRangeScalingAmaSlope = persistedDynamicGridState.gridRangeScalingAmaSlope;
            }
            if (botState.amaSlopeDeltaPercent == null && persistedDynamicGridState.amaSlopeDeltaPercent != null) {
                botState.amaSlopeDeltaPercent = persistedDynamicGridState.amaSlopeDeltaPercent;
            }
            if (botState.amaSlopeThresholdPercent == null && persistedDynamicGridState.amaSlopeThresholdPercent != null) {
                botState.amaSlopeThresholdPercent = persistedDynamicGridState.amaSlopeThresholdPercent;
            }
        }
        const previousAmaSlope = botState.amaSlope || null;
        const previousGridResetAmaSlope = botState.gridRangeScalingAmaSlope || previousAmaSlope;
        delete botState.gridPriceOffsetPct;
        delete botState.gridPriceOffsetClampToBounds;
        previousClosedCandleTs = Number(botState.lastClosedCandleTs || 0);
        consumedClosedCandleTs = Number.isFinite(previousClosedCandleTs) && previousClosedCandleTs > 0
            ? previousClosedCandleTs
            : null;
        hasNewClosedCandle = lastClosedCandleTs !== null && lastClosedCandleTs > previousClosedCandleTs;

        // Fields shared by the persisted bot state and the cycle result.
        // Built on demand so `consumedClosedCandleTs` is read after the
        // retry-baseline adjustment below, rather than frozen early.
        const buildCandleCycleFields = () => ({
            candleCount: nextCandles.length,
            analysisCandleCount: closedCandles.length,
            rawKeepCount,
            analysisKeepCount,
            amaWarmupBars,
            kibanaGapRepairCount,
            kibanaBackfillCount,
            unresolvedGapCount,
            nativeRecentTradeSequences,
            nativeLastTradeTs,
            nativeOverlapCount,
            nativePagesFetched,
            lastCandleTs: rawLastCandleTs,
            rawLastCandleTs,
            lastClosedCandleTs: consumedClosedCandleTs,
        });

        const candlePayload = {
            meta: {
                updatedAt: nowIso,
                source: sourceLabel,
                pool: ctx.poolId,
                marketSource,
                assetA: ctx.assetA,
                assetB: ctx.assetB,
                intervalSeconds: Number(cfg.intervalSeconds),
                candleCount: nextCandles.length,
                analysisCandleCount: closedCandles.length,
                rawKeepCount,
                analysisKeepCount,
                amaWarmupBars,
                currentBucketStartMs,
                lastClosedCandleTs,
                rawLastCandleTs,
                kibanaGapRepairCount,
                kibanaBackfillCount,
                unresolvedGapCount,
                nativeRecentTradeSequences,
                nativeLastTradeTs,
                nativeOverlapCount,
                nativePagesFetched,
                staleTailVerifiedStartTs: Number.isFinite(existingMeta.staleTailVerifiedStartTs)
                    ? existingMeta.staleTailVerifiedStartTs : null,
                staleTailVerifiedEndTs: Number.isFinite(existingMeta.staleTailVerifiedEndTs)
                    ? existingMeta.staleTailVerifiedEndTs : null,
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            },
            candles: nextCandles,
        };
        deps.saveJson(filePath, candlePayload);
        // The object just serialized IS the file's content now, so the next
        // cycle's read can skip the parse.
        noteJsonWritten(filePath, candlePayload);

        if (!hasNewClosedCandle) {
            const { staleData, staleAgeHours } = deps.computeCandleStaleness(lastClosedCandleTs, cfg.maxStaleHours);
            const pendingClosedCandle = !staleData;
            const triggerSuppressedReason = staleData
                ? 'stale_candle_data'
                : 'waiting_for_new_closed_candle';
            state.bots[String(bot.botKey)] = {
                ...botState,
                botName: bot.name,
                botKey: bot.botKey,
                poolId: ctx.poolId,
                marketSource,
                candleFile: deps.path.relative(deps.root, filePath),
                ...buildCandleCycleFields(),
                lastCycleSource: sourceLabel,
                lastCycleAt: nowIso,
                staleData,
                staleAgeHours,
                pendingClosedCandle,
                lastTriggerSuppressedReason: triggerSuppressedReason,
            };
            return this.buildDefaultResult(bot, {
                dryRunMessages,
                source: sourceLabel,
                marketSource,
                ...buildCandleCycleFields(),
                thresholdPercent: botThreshold,
                staleData,
                staleAgeHours,
                triggerSuppressedReason,
                poolId: ctx.poolId,
                candleFile: deps.path.relative(deps.root, filePath),
                amaConfig: {
                    erPeriod: botAma.erPeriod,
                    fastPeriod: botAma.fastPeriod,
                    slowPeriod: botAma.slowPeriod,
                },
                pendingClosedCandle,
            });
        }

        // ------------------ MARKET ADAPTER STRATEGIES ------------------

        // 1. AMA series and closes — used for price reference and signal computation
        const analysisCandles = closedCandles;
        const closes = analysisCandles.map((c) => Number(c[4])).filter((v) => Number.isFinite(v) && v > 0);

        const amaValues = calculateAMA(closes, botAma as unknown as AmaParams);

        // amaPrice is the last value of the full AMA series
        const amaPrice = amaValues[amaValues.length - 1];
        const lastCandle = latestClosedCandle || [0, 0, 0, 0, 0];

        // 2. ATR — used only for the symmetric volatility shift. The asymmetrical
        //    trend/Kalman branch stays ATR-free to match the research HTML.
        const atrPeriod = normalizeAtrPeriod(cfg.atrPeriod);
        const atr = calculateATR(analysisCandles, atrPeriod);
        const warn = (message: string) => {
            if (typeof deps.logger?.log === 'function') {
                deps.logger.log(message, 'warn');
            } else if (typeof deps.logger?.warn === 'function') {
                deps.logger.warn(message);
            } else {
                marketAdapterServiceLogger.warn(message);
            }
        };
        if (!Number.isFinite(atr)) {
            warn(`ATR calculation failed for ${bot.botKey}; disabling volatility penalty for this cycle.`);
        }
        const weightVariance = Number.isFinite(atr) && amaPrice > 0 ? (atr / amaPrice) : 0;

        // 3. Signal computation — dynamic weights use AMA + Kalman + regime gate,
        //    with ATR applied only as a separate symmetric penalty. Range scaling
        //    reuses the AMA slope signal, but buy/sell dynamic weights are only
        //    exposed, persisted, or applied when dynamicWeight is whitelisted.
        const isAmaWhitelisted = forceWhitelistAll || (typeof deps.isBotWhitelisted === 'function'
            ? deps.isBotWhitelisted(bot.botKey)
            : true);
        const isDynamicWeightFlagWhitelisted = forceWhitelistAll || (typeof deps.isBotDynamicWeightWhitelisted === 'function'
            && deps.isBotDynamicWeightWhitelisted(bot.botKey));
        const isDynamicWeightWhitelisted = isAmaWhitelisted && isDynamicWeightFlagWhitelisted;
        const isGridRangeScalingWhitelisted = forceWhitelistAll
            || (typeof deps.isBotAsymmetricBoundsWhitelisted === 'function'
                && deps.isBotAsymmetricBoundsWhitelisted(bot.botKey));
        const isAsymmetricBoundsWhitelisted = isGridRangeScalingWhitelisted;
        const hasExplicitBaseWeights = Number.isFinite((bot.weightDistribution as JsonObj | undefined)?.sell)
            && Number.isFinite((bot.weightDistribution as JsonObj | undefined)?.buy);
        const isAmaGridBot = usesAmaGridPrice(bot);
        const shouldComputeDynamicWeightSignal = isAmaGridBot && hasExplicitBaseWeights
            && (isDynamicWeightWhitelisted || isGridRangeScalingWhitelisted);
        const canExposeDynamicWeights = isDynamicWeightWhitelisted && shouldComputeDynamicWeightSignal;
        const canApplyDynamicWeights = canExposeDynamicWeights;
        if (!hasExplicitBaseWeights && isAmaGridBot && (isDynamicWeightWhitelisted || isGridRangeScalingWhitelisted)) {
            warn(`${bot.botKey} is missing explicit weightDistribution; skipping dynamic volatility weights for this cycle.`);
        }

        let slopeResult: JsonObj | null = null;
        let amaSlope: JsonObj | null = null;
        let weights: JsonObj | null = null;
        let dynamicWeightsPayload: JsonObj | null = null;

        if (shouldComputeDynamicWeightSignal) {
            const dwResult = this._computeDynamicWeights({
                closes,
                amaValues,
                lookbackBars,
                botAma: botAma as unknown as AmaParams,
                weightVariance,
                nowIso,
                cfg: cfg as DynamicWeightsCfg,
                bot,
                atrPeriod,
            });
            slopeResult = dwResult.slopeResult;
            amaSlope = dwResult.amaSlope;
            weights = dwResult.weights;
            dynamicWeightsPayload = dwResult.dynamicWeightsPayload;
        }
        const amaSlopeResetDetails = this.buildAmaSlopeResetDetails(amaSlope ?? {}, previousGridResetAmaSlope as JsonObj, cfg);
        const amaSlopeDeltaPercent = amaSlopeResetDetails.deltaPercent;
        const amaSlopeThresholdPercent = amaSlopeResetDetails.thresholdPercent;

        // 4. Advisory collateral-ratio hint only; execution is owned by the debt runtime.
        const collateralRecommendation = canExposeDynamicWeights ? adjustCollateralRatio(slopeResult, 1.5, 2.0) : null;

        // Reports the single AMA this bot trades on (its own resolved
        // parameters, value already computed above as `amaPrice`). No extra
        // calculateAMA pass: the AMA1..AMA4 preset sweep this replaced fed
        // nothing but a log line.
        const amaComparison = deps.buildAmaRecord(botAma, amaPrice);
        const closedCandleTs = lastCandle[0] || null;
        const { staleData, staleAgeHours } = deps.computeCandleStaleness(closedCandleTs, cfg.maxStaleHours);

        const referencePrice = amaPrice;
        const clampedCenterPrice = this.clampGridPriceToBounds(referencePrice, referencePrice, bot);
        const centerPrice = Number.isFinite(clampedCenterPrice) && clampedCenterPrice > 0
            ? clampedCenterPrice
            : referencePrice;
        const gridPriceOffsetPlan = computeGridPriceOffsetPlan(bot, amaSlope);
        // Compute asymmetry metrics for grid range scaling independently of
        // dynamicWeight flag. Uses dynamicWeightsPayload when available, falls
        // back to amaSlope so that asymmetricBounds: true works regardless of
        // whether dynamicWeight: true is set.
        const asymmetrySource = dynamicWeightsPayload || amaSlope;
        const asymmetryMetrics = isAsymmetricBoundsWhitelisted && asymmetrySource
            ? this.computeAppliedAsymmetryMetrics(bot, centerPrice, asymmetrySource)
            : {
                rawAsymmetryFactor: null,
                appliedAsymmetryFactor: null,
                maxAsymmetryFactor: null,
            };
        if (dynamicWeightsPayload) {
            Object.assign(dynamicWeightsPayload, asymmetryMetrics);
            if (weights?.meta) {
                Object.assign(weights.meta, asymmetryMetrics);
            }
        }
        const dynamicSnapshotPayload = canExposeDynamicWeights
            ? dynamicWeightsPayload
            : null;

        let triggered = false;
        let triggerPath: string | null = null;
        let deltaPercent: number | null = null;
        let triggerCallbackError: string | null = null;
        let triggerSuppressedReason: string | null = null;
        let snapshotPersistedThisCycle = false;
        let previousCenterPrice = Number(botState.centerPrice || 0);
        const hasUnresolvedCandleGaps = Number.isFinite(unresolvedGapCount) && unresolvedGapCount > 0;
        if (hasUnresolvedCandleGaps) {
            triggerSuppressedReason = 'unresolved_candle_gaps';
        } else if (staleData) {
            // Mirror the !hasNewClosedCandle path so state records why no
            // trigger/snapshot write happened on a stale-but-new cycle.
            triggerSuppressedReason = 'stale_candle_data';
        }

        const buildDynamicGridOptions = (options: JsonObj = {}) => {
            const payload: JsonObj = {
                gridCenterPrice: options.gridCenterPrice ?? null, // explicit baseline if provided
                amaCenterPrice: amaPrice,
                amaSlope: options.amaSlope ?? amaSlope,
                gridRangeScalingAmaSlope: options.gridRangeScalingAmaSlope ?? (amaSlope || previousGridResetAmaSlope || null),
                amaSlopeDeltaPercent,
                amaSlopeThresholdPercent,
                observedLastGridResetAt: botState.lastGridResetAt,
                ...(options.previousCenterPrice !== undefined
                    ? { previousCenterPrice: options.previousCenterPrice }
                    : {}),
                ...(dynamicSnapshotPayload
                    ? { dynamicWeights: dynamicSnapshotPayload }
                    : {}),
            };
            if (isGridRangeScalingWhitelisted) {
                payload.gridPriceOffsetPct = options.gridPriceOffsetPct ?? gridPriceOffsetPlan.gridPriceOffsetPct;
                // Persist computed asymmetry metrics at root level so display
                // tools can render the grid range scaling percentage even when
                // dynamicWeight is not enabled for this bot.
                if (Number.isFinite(asymmetryMetrics.appliedAsymmetryFactor)) {
                    const asymTrend = (dynamicWeightsPayload || amaSlope)?.trend;
                    if (asymTrend === 'UP' || asymTrend === 'DOWN') {
                        payload.asymmetricBounds = {
                            rawAsymmetryFactor: asymmetryMetrics.rawAsymmetryFactor,
                            appliedAsymmetryFactor: asymmetryMetrics.appliedAsymmetryFactor,
                            trend: asymTrend,
                            minScaleSlots: ((cfg.asymmetricBounds as JsonObj | undefined)?.minScaleSlots != null)
                                ? (cfg.asymmetricBounds as JsonObj).minScaleSlots
                                : MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MIN_SCALE_SLOTS,
                        };
                    }
                }
            }
            return payload;
        };

        const persistDynamicGridSnapshot = (snapshotCenterPrice: number, options: JsonObj = {}) => {
            if (!isDryRun && typeof deps.writeBotDynamicGrid === 'function') {
                return deps.writeBotDynamicGrid(
                    bot.botKey,
                    snapshotCenterPrice,
                    buildDynamicGridOptions(options),
                ) !== false;
            }
            if (isDryRun) {
                dryRunMessages.push(`[DRY RUN] Would write dynamic grid for ${bot.botKey}: ${snapshotCenterPrice}`);
            }
            return true;
        };

        const advanceTriggeredBotState = (newCenterPrice: number, options: JsonObj = {}) => {
            snapshotPersistedThisCycle = true;
            botState.gridCenterPrice = newCenterPrice;
            botState.centerPrice = newCenterPrice;
            botState.amaCenterPrice = amaPrice;
            botState.amaSlope = options.amaSlope ?? (amaSlope || previousAmaSlope || null);
            botState.gridRangeScalingAmaSlope = options.gridRangeScalingAmaSlope ?? (amaSlope || previousGridResetAmaSlope || null);
            botState.amaSlopeDeltaPercent = Number.isFinite(amaSlopeDeltaPercent)
                ? amaSlopeDeltaPercent
                : botState.amaSlopeDeltaPercent ?? null;
            botState.amaSlopeThresholdPercent = amaSlopeThresholdPercent;
            botState.amaSlopePercentMode = AMA_SLOPE_PERCENT_MODE_PER_BAR;
            botState.amaSlopePersistCount = 0;
            botState.amaSlopePersistDir = 0;
            botState.triggerCount = Number(botState.triggerCount || 0) + 1;
            if (canApplyDynamicWeights && dynamicWeightsPayload) {
                botState.effectiveWeights = dynamicWeightsPayload.effectiveWeights || null;
            }
            triggered = true;
        };

        const writeTriggerAndNotify = async ({ triggerPayload, hookPayload, dryRunMessage }: { triggerPayload: JsonObj; hookPayload: JsonObj; dryRunMessage: string }) => {
            if (!isDryRun) {
                triggerPath = deps.writeGridResetTrigger(bot, triggerPayload) as string;
            } else {
                dryRunMessages.push(dryRunMessage);
            }

            if (typeof hooks.onTrigger === 'function') {
                try {
                    await hooks.onTrigger({
                        bot,
                        botKey: bot.botKey,
                        botName: bot.name,
                        poolId: ctx.poolId,
                        ...hookPayload,
                        triggerPath,
                        marketSource,
                    });
                } catch (err) {
                    triggerCallbackError = getErrorMessage(err);
                }
            }
        };

        if (!staleData && !hasUnresolvedCandleGaps && Number.isFinite(referencePrice) && referencePrice > 0) {
            // Bootstrap when market-adapter state is missing (e.g. after clearing)
            // or when a bot runs for the first time.
            if (!Number.isFinite(previousCenterPrice) || previousCenterPrice <= 0) {
                const bootstrapCenterPrice = Number.isFinite(centerPrice) && centerPrice > 0
                    ? centerPrice
                    : referencePrice;

                const amaCenterPersisted = persistDynamicGridSnapshot(bootstrapCenterPrice, {
                    amaSlope: amaSlope || previousAmaSlope || null,
                    gridPriceOffsetPct: gridPriceOffsetPlan.gridPriceOffsetPct,
                });

                if (amaCenterPersisted) {
                    advanceTriggeredBotState(bootstrapCenterPrice, {
                        amaSlope: amaSlope || previousAmaSlope || null,
                        gridPriceOffsetPct: gridPriceOffsetPlan.gridPriceOffsetPct,
                    });
                    // First-ever bootstrap — no previous center anywhere.
                    // Create a trigger so the bot recalibrates to the new center.
                    await writeTriggerAndNotify({
                        triggerPayload: {
                            reason: 'market_adapter_bootstrap',
                            newCenterPrice: bootstrapCenterPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                            amaSlope: amaSlope || previousAmaSlope || null,
                            amaSlopeDeltaPercent,
                            amaSlopeThresholdPercent,
                            poolId: ctx.poolId,
                            marketSource,
                        },
                        hookPayload: {
                            thresholdPercent: botThreshold,
                            deltaPercent: null,
                            previousCenterPrice: undefined,
                            newCenterPrice: bootstrapCenterPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                        },
                        dryRunMessage: `[DRY RUN] Would write grid reset trigger for ${bot.botKey} (bootstrap)`,
                    });
                } else {
                    triggerSuppressedReason = 'ama_center_persist_failed';
                }
            }

            // Unified delta check — runs when previousCenterPrice is known
            // (either from state or recovered from .dynamicgrid.json).
            if (!triggered && Number.isFinite(previousCenterPrice) && previousCenterPrice > 0) {
                deltaPercent = Math.abs((centerPrice - previousCenterPrice) / previousCenterPrice) * 100;
                if (deltaPercent >= botThreshold) {
                    const amaCenterPersisted = persistDynamicGridSnapshot(centerPrice, {
                        previousCenterPrice,
                        gridPriceOffsetPct: gridPriceOffsetPlan.gridPriceOffsetPct,
                    });

                    if (!amaCenterPersisted) {
                        triggerSuppressedReason = 'ama_center_persist_failed';
                    } else {
                        advanceTriggeredBotState(centerPrice);
                        await writeTriggerAndNotify({
                            triggerPayload: {
                                reason: 'market_adapter_delta_threshold',
                                thresholdPercent: botThreshold,
                                deltaPercent,
                                previousCenterPrice,
                                newCenterPrice: centerPrice,
                                referencePrice,
                                amaCenterPrice: amaPrice,
                                amaSlope,
                                amaSlopeDeltaPercent,
                                amaSlopeThresholdPercent,
                                poolId: ctx.poolId,
                                marketSource,
                            },
                            hookPayload: {
                                thresholdPercent: botThreshold,
                                deltaPercent,
                                previousCenterPrice,
                                newCenterPrice: centerPrice,
                                referencePrice,
                                amaCenterPrice: amaPrice,
                            },
                            dryRunMessage: `[DRY RUN] Would write grid reset trigger for ${bot.botKey}`,
                        });
                    }
                }
            }

            // Slope-delta persistence gate (trigger B). Advance only when this
            // cycle can actually act on it — after trigger A (price/Drift) and
            // bootstrap have had their chance, and only for whitelisted bots.
            // Mirrors grid_reset_sim, where the slope candidate is evaluated
            // only in the price trigger's `else` branch, and stops the counter
            // accumulating for bots that never use the slope trigger.
            const amaSlopeGateActive = !triggered && !triggerSuppressedReason && isGridRangeScalingWhitelisted;
            const amaSlopePersistence = amaSlopeGateActive
                ? this.advanceAmaSlopePersistence(amaSlopeResetDetails, cfg, botState)
                : { shouldTrigger: false, persistBars: this.resolveAmaSlopePersistBars(cfg) };
            const amaSlopeShouldTrigger = amaSlopePersistence.shouldTrigger;
            const amaSlopePersistBars = amaSlopePersistence.persistBars;

            if (amaSlopeGateActive && amaSlopeShouldTrigger) {
                const amaSlopePersisted = persistDynamicGridSnapshot(centerPrice);

                if (!amaSlopePersisted) {
                    triggerSuppressedReason = 'ama_slope_persist_failed';
                } else {
                    advanceTriggeredBotState(centerPrice);
                    await writeTriggerAndNotify({
                        triggerPayload: {
                            reason: 'market_adapter_ama_slope_delta_threshold',
                            thresholdPercent: amaSlopeThresholdPercent,
                            deltaPercent: amaSlopeDeltaPercent,
                            amaSlopePersistBars,
                            previousAmaSlope,
                            previousGridResetAmaSlope,
                            amaSlope,
                            amaSlopeDeltaPercent,
                            amaSlopeThresholdPercent,
                            previousCenterPrice,
                            newCenterPrice: centerPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                            poolId: ctx.poolId,
                            marketSource,
                        },
                        hookPayload: {
                            thresholdPercent: amaSlopeThresholdPercent,
                            deltaPercent: amaSlopeDeltaPercent,
                            previousAmaSlope,
                            previousGridResetAmaSlope,
                            amaSlope,
                            amaSlopeDeltaPercent,
                            amaSlopeThresholdPercent,
                            previousCenterPrice,
                            newCenterPrice: centerPrice,
                            referencePrice,
                            amaCenterPrice: amaPrice,
                        },
                        dryRunMessage: `[DRY RUN] Would write grid reset trigger for ${bot.botKey} (AMA slope)`,
                    });
                }
            }
        }

        const acceptedGridCenterPrice = Number(botState.gridCenterPrice ?? botState.centerPrice);
        const persistedCenterPrice = acceptedGridCenterPrice > 0
            ? acceptedGridCenterPrice
            : undefined;

        // Successful AMA cycles refresh dynamicgrid.json even when no grid reset
        // is needed. Dynamic-weight payloads still honor the existing whitelist:
        // buildDynamicGridOptions includes them only for live dynamic weights or
        // range-scaling diagnostics, and effectiveWeights only advance when live
        // dynamic weights are explicitly whitelisted.
        if (!snapshotPersistedThisCycle && !triggered && !triggerSuppressedReason && !isDryRun && !staleData
                && (persistedCenterPrice as number) > 0
                && typeof deps.writeBotDynamicGrid === 'function') {
            const dynamicGridPersisted = persistDynamicGridSnapshot(persistedCenterPrice as number, {
                amaSlope: amaSlope || previousAmaSlope || null,
                gridRangeScalingAmaSlope: botState.gridRangeScalingAmaSlope || previousGridResetAmaSlope || null,
                gridPriceOffsetPct: gridPriceOffsetPlan.gridPriceOffsetPct,
            });
            if (dynamicGridPersisted) {
                botState.amaCenterPrice = amaPrice;
                botState.amaSlope = amaSlope || previousAmaSlope || null;
                botState.amaSlopeDeltaPercent = Number.isFinite(amaSlopeDeltaPercent)
                    ? amaSlopeDeltaPercent
                    : botState.amaSlopeDeltaPercent ?? null;
                botState.amaSlopeThresholdPercent = amaSlopeThresholdPercent;
                botState.amaSlopePercentMode = AMA_SLOPE_PERCENT_MODE_PER_BAR;
                if (canApplyDynamicWeights && dynamicWeightsPayload) {
                    botState.effectiveWeights = dynamicWeightsPayload.effectiveWeights || null;
                }
                snapshotPersistedThisCycle = true;
            } else if (!triggerSuppressedReason) {
                triggerSuppressedReason = canApplyDynamicWeights
                    ? 'dynamic_weight_persist_failed'
                    : 'ama_center_persist_failed';
            }
        }

        if (lastClosedCandleTs !== null && lastClosedCandleTs > 0
                && (!hasNewClosedCandle || !MarketAdapterService.isRetryableClosedCandleFailure(triggerSuppressedReason))) {
            consumedClosedCandleTs = lastClosedCandleTs;
        }

        const preserveRetryBaseline = hasNewClosedCandle
            && MarketAdapterService.isRetryableClosedCandleFailure(triggerSuppressedReason);
        const stateAmaSlope = preserveRetryBaseline
            ? (botState.amaSlope || previousAmaSlope || null)
            : (amaSlope || botState.amaSlope || null);
        const stateAmaSlopeDeltaPercent = preserveRetryBaseline
            ? (botState.amaSlopeDeltaPercent ?? null)
            : (Number.isFinite(amaSlopeDeltaPercent)
                ? amaSlopeDeltaPercent
                : botState.amaSlopeDeltaPercent ?? null);
        const stateAmaSlopeThresholdPercent = preserveRetryBaseline
            ? (botState.amaSlopeThresholdPercent ?? amaSlopeThresholdPercent ?? null)
            : (amaSlopeThresholdPercent ?? botState.amaSlopeThresholdPercent ?? null);
        const stateGridRangeScalingAmaSlope = botState.gridRangeScalingAmaSlope || previousGridResetAmaSlope || null;

        state.bots[String(bot.botKey)] = {
            ...botState,
            botName: bot.name,
            botKey: bot.botKey,
            poolId: ctx.poolId,
            marketSource,
            candleFile: deps.path.relative(deps.root, filePath),
            ...buildCandleCycleFields(),
            lastAmaPrice: amaPrice,
            amaCenterPrice: Number(botState.amaCenterPrice || 0) > 0
                ? Number(botState.amaCenterPrice)
                : undefined,
            gridCenterPrice: acceptedGridCenterPrice > 0
                ? acceptedGridCenterPrice
                : persistedCenterPrice,
            centerPrice: acceptedGridCenterPrice > 0
                ? acceptedGridCenterPrice
                : persistedCenterPrice,
            amaConfig: {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            amaComparison,
            lastDeltaPercent: deltaPercent,
            thresholdPercent: botThreshold,
            referencePrice,
            lastCycleSource: sourceLabel,
            lastCycleAt: nowIso,
            staleData,
            staleAgeHours,
            lastTriggerFile: triggerPath || botState.lastTriggerFile || null,
            lastTriggerSuppressedReason: triggerSuppressedReason || null,
            weights: canExposeDynamicWeights ? weights : null,
            collateralRecommendation,
            atr,
            weightVariance,
            amaSlope: stateAmaSlope,
            gridRangeScalingAmaSlope: stateGridRangeScalingAmaSlope,
            amaSlopeDeltaPercent: stateAmaSlopeDeltaPercent,
            amaSlopeThresholdPercent: stateAmaSlopeThresholdPercent,
            amaSlopePercentMode: AMA_SLOPE_PERCENT_MODE_PER_BAR,
            effectiveWeights:         (canApplyDynamicWeights && (snapshotPersistedThisCycle || isDryRun) && dynamicWeightsPayload?.effectiveWeights)
                ? dynamicWeightsPayload.effectiveWeights
                : (botState.effectiveWeights || null),
            dynamicWeightWhitelisted: isDynamicWeightWhitelisted,
            gridRangeScalingWhitelisted: isGridRangeScalingWhitelisted,
            dynamicWeightReady:       canExposeDynamicWeights ? (dynamicWeightsPayload?.isReady ?? false) : false,
            dynamicWeightProfile:     canExposeDynamicWeights ? (weights?.profile || null) : null,
            dynamicWeightApplied:     snapshotPersistedThisCycle && canApplyDynamicWeights,
            hasExplicitBaseWeights,
            pendingClosedCandle: false,
            rawAsymmetryFactor: asymmetryMetrics.rawAsymmetryFactor,
            appliedAsymmetryFactor: asymmetryMetrics.appliedAsymmetryFactor,
            maxAsymmetryFactor: asymmetryMetrics.maxAsymmetryFactor,
        };

        return {
            ok: true,
            dryRunMessages,
            source: sourceLabel,
            marketSource,
            intervalSeconds: Number(cfg.intervalSeconds),
            ...buildCandleCycleFields(),
            amaPrice,
            previousCenterPrice,
            deltaPercent,
            thresholdPercent: botThreshold,
            referencePrice,
            amaComparison,
            triggered,
            triggerPath,
            staleData,
            staleAgeHours,
            triggerCallbackError,
            triggerSuppressedReason,
            weights: canExposeDynamicWeights ? weights : null,
            collateralRecommendation,
            amaSlope: (amaSlope || botState.amaSlope || null) as BotCycleResult['amaSlope'],
            amaSlopeDeltaPercent: Number.isFinite(amaSlopeDeltaPercent)
                ? amaSlopeDeltaPercent
                : botState.amaSlopeDeltaPercent ?? null,
            amaSlopeThresholdPercent: amaSlopeThresholdPercent ?? botState.amaSlopeThresholdPercent ?? null,
            dynamicWeightWhitelisted: isDynamicWeightWhitelisted,
            gridRangeScalingWhitelisted: isGridRangeScalingWhitelisted,
            dynamicWeightReady: canExposeDynamicWeights ? (dynamicWeightsPayload?.isReady ?? false) : false,
            dynamicWeightProfile: canExposeDynamicWeights ? (weights?.profile || null) : null,
            dynamicWeightApplied: snapshotPersistedThisCycle && canApplyDynamicWeights,
            hasExplicitBaseWeights,
            poolId: ctx.poolId,
            candleFile: deps.path.relative(deps.root, filePath),
            lastClosedCandleClose: Number(latestClosedCandle?.[4]),
            centerPrice,
            amaConfig: {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            },
            atr,
            weightVariance,
            pendingClosedCandle: false,
            rawAsymmetryFactor: asymmetryMetrics.rawAsymmetryFactor,
            appliedAsymmetryFactor: asymmetryMetrics.appliedAsymmetryFactor,
            maxAsymmetryFactor: asymmetryMetrics.maxAsymmetryFactor,
        };
    }
}

export { MarketAdapterService, AMA_SLOPE_PERCENT_MODE_PER_BAR, normalizeAmaSlopePercentMode, convertSlopePercentToPerBar, evaluateStateRepairVeto }


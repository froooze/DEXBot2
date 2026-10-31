#!/usr/bin/env node
'use strict';

import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
import { path } from '../modules/path_api.js';
import { getStorage } from '../modules/storage/index.js';
import { parseJsonWithComments, sleep, ensureDir } from '../modules/order/utils/system.js';
import { readGeneralSettings } from '../modules/general_settings.js';
import { DEFAULT_CONFIG, MARKET_ADAPTER, NATIVE_CLIENT, API_LIMITS, TIMING } from '../modules/constants.js';
import { normalizeBotEntry } from '../modules/bot_settings.js';
import * as kibanaSource from './inputs/kibana_source.js';
import * as kibanaMarketSource from './core/kibana_market_candles.js';
import { tradesToCandles, detectMissingCandleTimestamps, fillCandleGaps, detectStaleTail, pruneStaleTail, mergeCandles } from './candle_utils.js';
import { toIntervalLabel, bucketStartMs, latestClosedBucketStartMs, parseChainTimeToMs } from './interval_utils.js';
import { loadMarketProfiles } from '../analysis/tradingview/tradingview_uplot_chart_generator.js';
import { candleFileForBot as candleFilePathForLabel } from '../analysis/bot_key_utils.js';
import { writeJsonAtomic } from './utils/atomic_write.js';
import { acquireFileLockSync, releaseFileLockSync } from './utils/file_lock.js';
import { updateDynamicGridSnapshotSync } from './utils/dynamic_grid_snapshot.js';
import { PATHS, getRecalculateTriggerFile } from '../modules/paths.js';
import Logger from '../modules/order/logger.js';
import { roundTo } from '../modules/order/utils/math.js';
import { usesAmaGridPrice } from '../modules/dexbot_maintenance_runtime.js';
import {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} from './core/config_normalizers.js';
import {
    resetMarketAdapterWhitelistCache,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotAsymmetricBoundsWhitelisted,
} from '../modules/market_adapter_whitelist.js';
import {
    normalizeAssetSymbol,
    normalizeMarketSource,
    resolveBotContext,
    isExactPair,
    isSamePair,
    isExactPairIds,
    isSamePairIds,
    getBitsharesClient,
    setBitsharesClientForTests,
} from './utils/chain.js';
import {
    normalizeNativeMarketHistoryCandles,
} from './utils/native_history.js';
import {
    formatLogPercent,
    buildWeightSummary,
    buildDynamicWeightInputsLog,
    buildDynamicWeightTuningLog,
    buildAsymmetricBoundsLog,
    buildStartupDefaultsLog,
} from './log_format.js';
import { walkCliArgs } from './cli_args.js';

/**
 * PRICE ADAPTER — standalone or auto-launched by dexbot runtime.
 *
 * Loads active bots with AMA grid pricing, bootstraps candles from Kibana,
 * updates incrementally from native BitShares API, and creates recalc triggers
 * when the AMA center price moves past threshold.
 *
 * See market_adapter/README.md for full docs on triggers, profiles, and tuning.
 *
 * No wallet keys/password/auth required (read-only chain + Kibana bootstrap).
 */

const storage = getStorage();
const { readJSON } = storage;

const ROOT = PATHS.PROJECT_ROOT;
const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const DATA_DIR = PATHS.MARKET_ADAPTER.DATA_DIR;
const STATE_DIR = PATHS.MARKET_ADAPTER.STATE_DIR;
const STATE_FILE = PATHS.MARKET_ADAPTER.STATE_FILE;
const CENTER_FILE = PATHS.MARKET_ADAPTER.CENTERS_FILE;
const LOCK_FILE = PATHS.MARKET_ADAPTER.LOCK_FILE;
const MARKET_ADAPTER_SOURCE = path.relative(PATHS.PROJECT_ROOT, __filename).replace(/^dist[\\\/]/, '');
const MARKET_ADAPTER_SETTINGS_FILE = PATHS.PROFILES.MARKET_ADAPTER_SETTINGS_JSON;

const LP_OP_TYPE = NATIVE_CLIENT.OPERATIONS.LIQUIDITY_POOL_EXCHANGE;
const API_MAX_PAGE = API_LIMITS.LP_API_MAX_PAGE;
const RUNTIME_DEFAULTS = MARKET_ADAPTER.RUNTIME_DEFAULTS;

const DEFAULTS = {
    pollSeconds: RUNTIME_DEFAULTS.pollSeconds,
    deltaThresholdPercent: MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
    amaSlopeDeltaThresholdPercent: undefined,
    absoluteThreshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT,
    intervalSeconds: RUNTIME_DEFAULTS.intervalSeconds,
    bootstrapLookbackHours: RUNTIME_DEFAULTS.bootstrapLookbackHours,
    nativeBackfillHours: RUNTIME_DEFAULTS.nativeBackfillHours,
    maxStaleHours: RUNTIME_DEFAULTS.maxStaleHours,
    sourceRetries: RUNTIME_DEFAULTS.sourceRetries,
    retryDelayMs: RUNTIME_DEFAULTS.retryDelayMs,
    kibanaRequestTimeoutMs: MARKET_ADAPTER.KIBANA_REQUEST_TIMEOUT_MS,
    metricsJson: false,
    quiet: false,
    dryRun: false,
    whitelistAll: false,
    maxPages: RUNTIME_DEFAULTS.maxPages,
    pageLimit: RUNTIME_DEFAULTS.pageLimit,
    once: false,
    maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    staleTailThreshold: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    amaSlope: {
        lookbackBars:     MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        maxSlopePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        neutralZonePct:   MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
        deltaThresholdPct: MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT,
    },
    kalmanSlope: {
        maxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
    },
    atrPeriod: MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT,
};

// Cycle-scoped caches — reset once per runOnce() so each cycle reads files fresh
// but all bots within that cycle share the same loaded data (N bots → 1 file read).
let _marketAdapterSettingsCache: Record<string, unknown> | null = null;

function _resetCycleCache() {
    _marketAdapterSettingsCache = null;
    resetMarketAdapterWhitelistCache();
}

function loadMarketAdapterSettings() {
    if (_marketAdapterSettingsCache !== null) return _marketAdapterSettingsCache;
    if (!storage.exists(MARKET_ADAPTER_SETTINGS_FILE)) return null;
    try {
        _marketAdapterSettingsCache = readJSON(MARKET_ADAPTER_SETTINGS_FILE);
        return _marketAdapterSettingsCache;
    } catch (_) {
        console.warn(`[WARN] Failed to parse ${MARKET_ADAPTER_SETTINGS_FILE}: ${getErrorMessage(_)}. Using defaults.`);
        _marketAdapterSettingsCache = null;
        return null;
    }
}

function findPairForBot(bot: Record<string, unknown>, pairs: unknown[]) {
    if (!Array.isArray(pairs)) return null;
    const botAId = String(bot.assetAId || '');
    const botBId = String(bot.assetBId || '');
    const botA = normalizeAssetSymbol(bot.assetA);
    const botB = normalizeAssetSymbol(bot.assetB);
    let fallbackMatch = null;
    for (const rawPair of pairs) {
        const p = rawPair as Record<string, unknown>;
        const parts = String(p.key || '').split('|');
        const pAId = parts[0];
        const pBId = parts[1];
        const pA = normalizeAssetSymbol(p.assetASymbol);
        const pB = normalizeAssetSymbol(p.assetBSymbol);

        if (botAId && botBId && pAId && pBId) {
            if (isExactPairIds(botAId, botBId, pAId, pBId)) return p;
            if (!fallbackMatch && isSamePairIds(botAId, botBId, pAId, pBId)) {
                fallbackMatch = p;
                continue;
            }
        }

        if (botA && botB && pA && pB) {
            if (isExactPair(botA, botB, pA, pB)) return p;
            if (!fallbackMatch && isSamePair(botA, botB, pA, pB)) {
                fallbackMatch = p;
            }
        }
    }
    return fallbackMatch;
}

type CfgObj = Record<string, unknown>;

interface AmaSlopeCfg {
    maxSlopePct?: unknown;
    neutralZonePct?: unknown;
    lookbackBars?: unknown;
    [key: string]: unknown;
}

interface AdapterTargetCfg {
    quiet?: unknown;
    dryRun?: unknown;
    whitelistAll?: unknown;
    onTrigger?: unknown;
    pollSeconds?: unknown;
    intervalSeconds?: unknown;
    amaSlope?: AmaSlopeCfg;
    amaSlopePercentMode?: unknown;
    amaSlopeDeltaThresholdPercent?: unknown;
    kalmanSlope?: CfgObj;
    defaultAmaKey?: unknown;
    [key: string]: unknown;
}

type NativeTradeRecord = { tsMs: number; sequence: number | null; sell: unknown; received: unknown };

type AmaResolved = { enabled: boolean; name: string; erPeriod: number; fastPeriod: number; slowPeriod: number };

interface BotRunResult {
    botName?: unknown;
    botKey?: unknown;
    ok: boolean;
    reason?: unknown;
    triggered?: boolean;
    staleData?: boolean;
    kibanaGapRepairCount?: number;
    kibanaBackfillCount?: number;
    unresolvedGapCount?: number;
    [key: string]: unknown;
}

interface AdapterOverrideCfg {
    amaSlope?: AmaSlopeCfg;
    amaSlopePercentMode?: unknown;
    amaSlopeUnits?: unknown;
    amaSlopeDeltaThresholdPercent?: unknown;
    kalmanSlope?: CfgObj;
    defaultAmaKey?: unknown;
    [key: string]: unknown;
}

function assignPresent(target: Record<string, unknown>, source: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        if (source?.[key] != null) target[key] = source[key];
    }
    return target;
}

function applyAmaSlopeOverrides(target: AdapterTargetCfg, overrides: AdapterOverrideCfg): AdapterTargetCfg {
    if (!overrides || typeof overrides !== 'object') return target;
    target.amaSlope = { ...(target.amaSlope || {}) };
    const previousLookbackBars = target.amaSlope.lookbackBars;
    const explicitMode = normalizeAmaSlopePercentMode(
        overrides.amaSlopePercentMode
        ?? overrides.amaSlopeUnits
        ?? overrides.amaSlope?.percentMode
        ?? overrides.amaSlope?.units
    );
    if (explicitMode) target.amaSlopePercentMode = explicitMode;
    const mode = explicitMode || target.amaSlopePercentMode || AMA_SLOPE_PERCENT_MODE_PER_BAR;

    if (overrides.amaSlopeDeltaThresholdPercent != null) {
        target.amaSlopeDeltaThresholdPercent = convertSlopePercentToPerBar(
            overrides.amaSlopeDeltaThresholdPercent,
            overrides.amaSlope?.lookbackBars ?? previousLookbackBars,
            mode
        );
    }

    if (overrides.amaSlope && typeof overrides.amaSlope === 'object') {
        const {
            percentMode: _percentMode,
            units: _units,
            maxSlopePct,
            neutralZonePct,
            ...amaSlopeRest
        } = overrides.amaSlope;
        target.amaSlope = { ...target.amaSlope, ...amaSlopeRest };
        const lookbackBars = target.amaSlope.lookbackBars ?? previousLookbackBars;
        if (maxSlopePct != null) {
            target.amaSlope.maxSlopePct = convertSlopePercentToPerBar(maxSlopePct, lookbackBars, mode);
        }
        if (neutralZonePct != null) {
            target.amaSlope.neutralZonePct = convertSlopePercentToPerBar(neutralZonePct, lookbackBars, mode);
        }
    }
    return target;
}

function applyKalmanSlopeOverrides(target: AdapterTargetCfg, overrides: AdapterOverrideCfg): AdapterTargetCfg {
    if (!overrides || typeof overrides !== 'object') return target;
    target.kalmanSlope = { ...(target.kalmanSlope || {}) };
    if (overrides.kalmanSlope && typeof overrides.kalmanSlope === 'object') {
        target.kalmanSlope = { ...target.kalmanSlope, ...overrides.kalmanSlope };
    }
    return target;
}

function applyMarketAdapterOverrides(target: AdapterTargetCfg, overrides: AdapterOverrideCfg, opts: { includeDefaultAmaKey?: boolean } = {}) {
    if (!overrides || typeof overrides !== 'object') return target;
    if (opts.includeDefaultAmaKey && overrides.defaultAmaKey) target.defaultAmaKey = overrides.defaultAmaKey;
    assignPresent(target, overrides, [
        'deltaThresholdPercent',
        'pollSeconds',
        'bootstrapLookbackHours',
        'nativeBackfillHours',
        'maxStaleHours',
        'sourceRetries',
        'retryDelayMs',
        'kibanaRequestTimeoutMs',
        'maxSlopeOffset',
        'staleTailThreshold',
        'absoluteThreshold',
        'minOutputThreshold',
        'volatilityExponent',
        'volatilityScaleX',
        'clipPercentile',
        'regimeSensitivity',
        'hurstZoneBand',
        'alpha',
        'dw',
        'gain',
        'kalmanSmoothPct',
        'kalmanDispScaleMult',
        'kalmanDispThresholdMult',
        'kalmanSmoothSpanPct',
        'signalConfirmBars',
        'dispScaleMinPct',
    ]);
    if (overrides.maxVolatilityOffset != null) {
        target.maxVolatilityOffset = normalizeMaxVolatilityOffset(overrides.maxVolatilityOffset);
    }
    // Per-field merge for asymmetricBounds so a bot-level override (e.g. only
    // minScaleSlots) does not wipe a market-level maxAsymmetryFactor. Mirrors how
    // amaSlope/kalmanSlope are merged across the globals/pair/bot layers.
    if (overrides.asymmetricBounds && typeof overrides.asymmetricBounds === 'object') {
        target.asymmetricBounds = { ...(target.asymmetricBounds || {}), ...overrides.asymmetricBounds };
    }
    if (overrides.atrPeriod != null) target.atrPeriod = normalizeAtrPeriod(overrides.atrPeriod);
    if (overrides.volatilityThreshold != null) {
        target.volatilityThreshold = normalizeVolatilityThreshold(overrides.volatilityThreshold);
    }
    if (overrides.peNodes) target.peNodes = overrides.peNodes;
    if (overrides.regimeTable) target.regimeTable = overrides.regimeTable;
    // Per-field merge for kalman so a partial layer override (e.g. only rNoise)
    // does not wipe the other kalman sub-keys (qTactical/qModal/warmupBars) that
    // were set at a higher layer (globals/pair). Mirrors asymmetricBounds/amaSlope/kalmanSlope.
    if (overrides.kalman && typeof overrides.kalman === 'object') {
        target.kalman = { ...(target.kalman || {}), ...overrides.kalman };
    }
    applyKalmanSlopeOverrides(target, overrides);
    applyAmaSlopeOverrides(target, overrides);
    return target;
}

function resolveBotCfg(bot: Record<string, unknown>, globalCfg: AdapterTargetCfg): AdapterTargetCfg {
    const settings = loadMarketAdapterSettings();
    if (!settings) return globalCfg;

    let merged = {
        ...globalCfg,
        amaSlope: { ...(globalCfg.amaSlope || {}) },
        kalmanSlope: { ...(globalCfg.kalmanSlope || {}) },
        kalman: globalCfg.kalman && typeof globalCfg.kalman === 'object'
            ? { ...globalCfg.kalman }
            : globalCfg.kalman,
    };

    applyMarketAdapterOverrides(merged, (settings.globals || {}) as AdapterOverrideCfg);

    // Pair-level overrides
    const pair = findPairForBot(bot, Array.isArray(settings.pairs) ? settings.pairs : []);
    if (pair && (pair as Record<string, unknown>).marketAdapterSettings) {
        applyMarketAdapterOverrides(merged, (pair as Record<string, unknown>).marketAdapterSettings as Record<string, unknown>);
    }

    // Bot-level overrides
    const pairObj = pair as Record<string, unknown> | null;
    const botOverride = pairObj?.botOverrides
        ? (pairObj.botOverrides as Record<string, unknown>)[String(bot.name)]
        : undefined;
    if (botOverride) {
        applyMarketAdapterOverrides(merged, botOverride as AdapterOverrideCfg, { includeDefaultAmaKey: true });
    }

    return merged;
}

const DEFAULT_AMA_KEY = String(MARKET_ADAPTER.DEFAULT_AMA_KEY).toUpperCase();
const BUILTIN_AMAS = MARKET_ADAPTER.AMAS;
const DEFAULT_AMA = MARKET_ADAPTER.AMAS.AMA3;
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);

function normalizeAmaPreset(raw: unknown) {
    const r = raw as { erPeriod?: unknown; fastPeriod?: unknown; slowPeriod?: unknown } | null | undefined;
    const erPeriod = Number(r?.erPeriod);
    const fastPeriod = Number(r?.fastPeriod);
    const slowPeriod = Number(r?.slowPeriod);
    if (!Number.isFinite(erPeriod) || !Number.isFinite(fastPeriod) || !Number.isFinite(slowPeriod)) return null;
    return { erPeriod, fastPeriod, slowPeriod };
}

function normalizeAmaKey(raw: unknown) {
    const s = String(raw || '').trim().toLowerCase();
    if (!AMA_KEYWORDS.has(s)) return DEFAULT_AMA_KEY;
    if (s === 'ama') return DEFAULT_AMA_KEY;
    return s.toUpperCase();
}

function isAmaKeyword(raw: unknown) {
    const s = String(raw || '').trim().toLowerCase();
    return AMA_KEYWORDS.has(s);
}

function findAmaProfileForBot(bot: Record<string, unknown>, ctx: Record<string, unknown> | null | undefined) {
    const profiles = loadMarketProfiles()?.profiles || [];
    if (profiles.length === 0) return null;

    const botAssetA = normalizeAssetSymbol(bot?.assetA);
    const botAssetB = normalizeAssetSymbol(bot?.assetB);
    const ctxAssetA = ctx?.assetA as { id?: unknown } | undefined;
    const ctxAssetB = ctx?.assetB as { id?: unknown } | undefined;
    const ctxAssetAId = normalizeAssetSymbol(ctxAssetA?.id);
    const ctxAssetBId = normalizeAssetSymbol(ctxAssetB?.id);
    if (!botAssetA && !ctxAssetAId) return null;
    if (!botAssetB && !ctxAssetBId) return null;

    const matches = profiles.map((p) => {
        const pA = p?.assetA;
        const pB = p?.assetB;
        const pAId = p?.assetAId;
        const pBId = p?.assetBId;

        const exactBySymbol = botAssetA && botAssetB && pA && pB && isExactPair(botAssetA, botAssetB, pA, pB);
        const exactById = ctxAssetAId && ctxAssetBId && pAId && pBId
            && isExactPairIds(ctxAssetAId, ctxAssetBId, pAId, pBId);
        const symmetricBySymbol = botAssetA && botAssetB && pA && pB && isSamePair(botAssetA, botAssetB, pA, pB);
        const symmetricById = ctxAssetAId && ctxAssetBId && pAId && pBId
            && isSamePairIds(ctxAssetAId, ctxAssetBId, pAId, pBId);

        const matchRank = (exactById || exactBySymbol)
            ? 2
            : ((symmetricById || symmetricBySymbol) ? 1 : 0);
        return { profile: p, matchRank };
    }).filter((entry) => entry.matchRank > 0);
    if (matches.length === 0) return null;

    const exactMatches = matches.filter((entry) => entry.matchRank === 2);
    const matchedProfiles = (exactMatches.length > 0 ? exactMatches : matches)
        .map((entry) => entry.profile);

    const oneHour = matchedProfiles.filter((p) => Number(p?.intervalSeconds) === RUNTIME_DEFAULTS.intervalSeconds);
    const candidates = oneHour.length > 0 ? oneHour : matchedProfiles;
    return [...candidates].sort((a, b) => {
        const aTs = Date.parse(String(a?.updatedAt || 0)) || 0;
        const bTs = Date.parse(String(b?.updatedAt || 0)) || 0;
        return bTs - aTs;
    })[0] || null;
}

function getAmaPresetForKey(key: string, profile: Record<string, unknown> | null) {
    const amas = profile?.amas as Record<string, unknown> | undefined;
    return normalizeAmaPreset(amas?.[key]) || normalizeAmaPreset((BUILTIN_AMAS as Record<string, unknown>)[key]) || null;
}

function getAmaFromProfilesForBot(bot: Record<string, unknown>, ctx: Record<string, unknown> | null, cfg: Record<string, unknown> | null) {
    const selected = resolveAmaPresetForBot(bot, ctx, cfg);
    if (!selected) return null;
    return {
        enabled: true,
        name: selected.name,
        erPeriod: selected.erPeriod,
        fastPeriod: selected.fastPeriod,
        slowPeriod: selected.slowPeriod,
    };
}

/**
 * Resolve which AMA preset key a bot actually trades on, and with what
 * parameters. Returns null when no preset/profile entry applies.
 *
 * The chosen key rides along as `name` on the returned config so the cycle log
 * and the state snapshot can say "this bot runs AMA2" without re-deriving it.
 */
function resolveAmaPresetForBot(bot: Record<string, unknown>, ctx: Record<string, unknown> | null, cfg: Record<string, unknown> | null) {
    const profile = findAmaProfileForBot(bot, ctx) as { defaultAma?: string; amas?: Record<string, unknown> } | null;
    if (!profile) return null;

    const rawGridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    const overrideDefaultAmaKey = cfg?.defaultAmaKey ? normalizeAmaKey(cfg.defaultAmaKey) : null;
    const requestedKey = rawGridPrice === 'ama'
        ? (overrideDefaultAmaKey || normalizeAmaKey(profile?.defaultAma))
        : (isAmaKeyword(rawGridPrice)
            ? normalizeAmaKey(rawGridPrice)
            : (overrideDefaultAmaKey || normalizeAmaKey(profile?.defaultAma)));
    // Keep the (key, preset) pair so the effective preset name is the one that
    // actually won the fallback chain, not merely the one that was requested.
    const selected =
        pairAmaKey(requestedKey, normalizeAmaPreset(profile?.amas?.[requestedKey]))
        || pairAmaKey(overrideDefaultAmaKey || DEFAULT_AMA_KEY, normalizeAmaPreset(profile?.amas?.[overrideDefaultAmaKey || DEFAULT_AMA_KEY]))
        || pairAmaKey(requestedKey, getAmaPresetForKey(requestedKey, profile))
        || pairAmaKey(overrideDefaultAmaKey || DEFAULT_AMA_KEY, getAmaPresetForKey(overrideDefaultAmaKey || DEFAULT_AMA_KEY, profile));
    if (!selected) return null;

    return {
        enabled: true,
        name: selected.key,
        erPeriod: selected.preset.erPeriod,
        fastPeriod: selected.preset.fastPeriod,
        slowPeriod: selected.preset.slowPeriod,
    };
}

function pairAmaKey(key: unknown, preset: { erPeriod: number; fastPeriod: number; slowPeriod: number } | null | undefined) {
    if (!preset) return null;
    return { key: String(key), preset };
}

function sleepUntilAlignedBoundary(pollSeconds: number, referenceNowMs: number = Date.now(), nowMs: number = Date.now()) {
    const normalizedPollSeconds = Math.max(1, Math.floor(Number(pollSeconds) || 0));
    const intervalMs = normalizedPollSeconds * 1000;
    const bufferMs = 1000;
    // The bucket containing the reference instant; its immediate successor is
    // the boundary to align to. Shared bucket helper keeps this on the same
    // grid as the closed-candle gate and the startup sleep.
    const referenceBucketMs = bucketStartMs(referenceNowMs, normalizedPollSeconds);
    // null (unusable reference clock/interval) means "do not wait": treat the
    // reference as the first boundary, so the delay collapses to the buffer
    // floor below. Never interpret it as an extra period, which would postpone
    // a cycle instead of running it.
    const targetBoundaryMs = (referenceBucketMs === null ? 0 : referenceBucketMs) + intervalMs;
    const delayMs = targetBoundaryMs - Number(nowMs) + bufferMs;
    return Math.max(bufferMs, delayMs);
}

/**
 * Sleep-first startup decision for the daemon.
 *
 * Returns `{ delayMs, veto }`: `delayMs` is how long to wait before the first
 * cycle (0 = run a catch-up cycle now); `veto` is null when the adapter may
 * sleep, otherwise `{ reason, botKeys }` saying why not. The wait uses the
 * SAME poll boundary the loop aligns to (sleepUntilAlignedBoundary with
 * cfg.pollSeconds, default 3600s), so the timing setting is honoured, not
 * hardcoded.
 *
 * `veto` is non-null — and `delayMs` 0 — when:
 * - state is fresh/empty (first run, cleared state — bootstrap lives in the
 *   cycle),
 * - no in-scope bot has a consumed closed-candle marker yet,
 * - ANY in-scope bot's consumed marker is not exactly the newest closed bucket
 *   (older = that bot still owes a cycle; newer = the clocks disagree, so do
 *   not trust the marker). Evaluated per bot, never aggregated: one lagging
 *   bot is invisible behind a max() over the others, and that bot is exactly
 *   what a catch-up cycle is for.
 * - the candle interval is not the poll cadence, or the clock cannot be
 *   evaluated,
 * - an active bot's last cycle left repair work still outstanding
 *   (unresolved gaps, or a cache shorter than its own warmup target),
 * - an active bot has never been processed (no state row, or no consumed
 *   marker) — its bootstrap is still owed,
 * - the active bot list cannot be read (then every state entry counts).
 *
 * The interval guard matters: the newest closed bucket is computed on the
 * poll grid, while the markers in state are candle-bucket starts. With a
 * mismatch (e.g. 2h candles polled hourly) the two grids only coincide by
 * accident, and "coincide" here would delay a real cycle by up to one poll
 * period. Refuse to sleep unless the grids are identical, i.e. unless one
 * cycle per poll actually is one cycle per candle.
 *
 * One grid for every bot is correct because `intervalSeconds` is not in the
 * per-pair/per-bot override whitelist, so all bots in a cycle share a bucket
 * size. If that ever changes, the comparison has to become per bot.
 *
 * Otherwise it returns the wait until the next poll boundary. Mid-hour
 * respawns (the common case: wrapper restart, crash recovery) therefore sleep
 * instead of running a full cycle that the closed-candle gate would discard
 * anyway. That wait is always shorter than one poll period, so at most one
 * boundary is ever passed over: a candle that closes during the sleep is
 * picked up by the very next cycle, never skipped.
 *
 * Only entries for bots the adapter would actually process are considered
 * (activeBotKeys). A removed bot's leftover row, or a fixed-price bot, must
 * not be able to defeat the sleep for everyone else — such an entry either
 * has no marker at all or a marker that is months old. An active bot with NO
 * row is treated exactly like an active bot with a row but no marker: both owe
 * a bootstrap, so both veto the sleep and that bot goes live on the next cycle
 * rather than up to a poll period later.
 *
 * Repair work is judged from the state entry, which records how the previous
 * cycle ended. Two of its fields are deliberately distinguished:
 *
 * - `unresolvedGapCount` is a STANDING condition — it is measured on the final
 *   candle set, so a non-zero value means gaps are still missing right now.
 * - `candleCount < rawKeepCount` is standing too: the cache has not reached
 *   the bot's own warmup target.
 *
 * `kibanaBackfillCount` is deliberately NOT consulted. It is an action count —
 * how many candles the last completed cycle happened to fetch — and that cycle
 * already applied them. A non-zero value means "repair was needed and was
 * done", not "repair is owed". Because a skip carries the persisted entry
 * forward, treating it as outstanding would keep vetoing the sleep after every
 * backfill until some full cycle happened to rewrite the field with a zero.
 * Cache shortness is the real signal, and it is checked directly above. The
 * standing verdict is computed by evaluateStateRepairVeto in
 * market_adapter_service.ts, immediately before the candle-file mirror
 * (candleFileCoversClosedBucket), so a new standing signal is added once.
 *
 * None of this can see a config change made after that cycle (a grown AMA
 * window, for instance): the backfill for that is then deferred to the next
 * boundary, bounded by one poll period. Reading the state entry costs no extra
 * I/O — no candle file is re-read and no connection is opened (the startup
 * decision reads bots.json to build the active list, and each cycle reads it
 * again).
 *
 * Known consequence of the "active bot with no row vetoes" rule: an active bot
 * that can never reach a state write (unresolvable market, persistent
 * pre-persist failure) keeps the sleep disabled for the whole daemon. That is
 * intentional and fail-safe — healthy bots still take the in-cycle off-hour
 * skip, so only the startup sleep is lost — and the veto is reported with its
 * reason and bot keys so the situation is visible instead of silent.
 */
function evaluateStartupSleep(cfg: AdapterTargetCfg, state: { bots?: Record<string, unknown> }, nowMs: number = Date.now(), activeBotKeys: string[] | null = null) {
    const vetoes: { [reason: string]: string[] } = {};
    const veto = (reason: string, key?: string) => {
        if (key == null) return;
        if (!vetoes[reason]) vetoes[reason] = [];
        vetoes[reason].push(key);
    };
    // Whole-fleet refusals: the condition is about the configuration or the
    // inputs, not about a particular bot, so there is nothing to attribute and
    // botKeys stays empty. Per-bot refusals are collected in `vetoes` by the
    // loop below and returned with their bot list. Deliberately NOT reading
    // `vetoes[reason]` here — that would silently return another bot's keys if
    // a denied() call were ever made after the loop has populated it.
    const denied = (reason: string) => ({ delayMs: 0, veto: { reason, botKeys: [] as string[] } });

    // Deliberate normalization asymmetry: pollSeconds is clamped to >=1 because
    // it is the grid the sleep aligns to, while intervalSeconds is left as a
    // bare floor so an invalid interval (0, negative, NaN) can NEVER equal the
    // clamped poll value and therefore always takes interval_mismatch below —
    // i.e. runs a catch-up cycle. Do not "simplify" by clamping both: that
    // would let an unconfigured interval match and authorize a sleep on a grid
    // the persisted markers were not written on.
    const pollSeconds = Math.max(1, Math.floor(Number(cfg?.pollSeconds) || 0));
    const intervalSeconds = Math.floor(Number(cfg?.intervalSeconds) || 0);
    if (intervalSeconds !== pollSeconds) return denied('interval_mismatch');
    const now = Number(nowMs);
    if (!Number.isFinite(now) || now <= 0) return denied('clock_unusable');
    const bots = state?.bots;
    if (!bots || typeof bots !== 'object') return denied('state_unusable');
    // An empty active-bot list means the adapter has nothing to do; do not
    // interpret it as "unknown scope" and fall back to scanning every row.
    if (Array.isArray(activeBotKeys) && activeBotKeys.length === 0) return denied('no_active_bots');
    // Newest fully closed bucket: its start. A cycle that consumed it has
    // done all the work available until the next bucket closes. Shared helper
    // so the startup sleep and the in-cycle gate agree by construction.
    const latestClosed = latestClosedBucketStartMs(now, pollSeconds);
    if (latestClosed === null) return denied('clock_unusable');
    // With a known active set, every one of those bots is judged on its own.
    // Unknown set (bot list unreadable) falls back to the state rows present.
    const scope = Array.isArray(activeBotKeys) ? activeBotKeys : Object.keys(bots);
    if (scope.length === 0) return denied('no_state_rows');

    for (const key of scope) {
        const entry = bots[key] as Record<string, unknown> | undefined;
        // An active bot with no state row at all still owes its first cycle.
        if (!entry || typeof entry !== 'object') {
            veto('no_state_row', key);
            continue;
        }
        const consumed = Number(entry.lastClosedCandleTs || 0);
        // No consumed marker yet: this bot still owes a bootstrap/warmup cycle.
        if (!Number.isFinite(consumed) || consumed <= 0) {
            veto('no_consumed_marker', key);
            continue;
        }
        // Per bot, never aggregated across bots: one lagging bot is exactly the
        // reason a catch-up cycle is needed, and a max() would hide it.
        if (consumed !== latestClosed) {
            veto(consumed < latestClosed ? 'behind_latest_closed_candle' : 'marker_ahead_of_clock', key);
            continue;
        }
        // Standing repair conditions, as measured by the previous cycle. Shared
        // with candleFileCoversClosedBucket's state-side mirror so the two gates
        // cannot drift apart.
        const repairReason = evaluateStateRepairVeto(entry);
        if (repairReason) {
            veto(repairReason, key);
            continue;
        }
    }

    if (Object.keys(vetoes).length > 0) {
        // Every distinct reason is reported, so a permanent veto (an active bot
        // that can never be persisted) is diagnosable from the log alone.
        const reason = Object.keys(vetoes).sort().join('+');
        return { delayMs: 0, veto: { reason, botKeys: [...new Set(Object.values(vetoes).flat())] } };
    }
    return { delayMs: sleepUntilAlignedBoundary(pollSeconds, now, now), veto: null };
}

/**
 * Numeric form of evaluateStartupSleep: the wait before the daemon's first
 * cycle, or 0 to run a catch-up cycle now. The decision rules — and the reasons
 * it can refuse — are documented there; this wrapper exists so callers that
 * only need the wait do not have to unpack a verdict object.
 */
function computeStartupDelayMs(cfg: AdapterTargetCfg, state: { bots?: Record<string, unknown> }, nowMs: number = Date.now(), activeBotKeys: string[] | null = null) {
    return evaluateStartupSleep(cfg, state, nowMs, activeBotKeys).delayMs;
}

function withRetries(fn: () => Promise<unknown>, attempts: number, baseDelayMs: number, label: string) {
    return (async () => {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                if (i + 1 >= attempts) break;
                const waitMs = Math.max(0, baseDelayMs) * (i + 1);
                if (waitMs > 0) await sleep(waitMs);
            }
        }
        const msg = label ? `${label}: ${getErrorMessage(lastErr) || 'unknown error'}` : (getErrorMessage(lastErr) || 'unknown error');
        throw new Error(msg);
    })();
}

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = { ...DEFAULTS };
    const provided = {
        deltaThresholdPercent: false,
    };

    walkCliArgs(args, {
        onHelp: () => {
            printHelp();
            process.exit(0);
        },
        flag: {
            '--once': () => { cfg.once = true; },
            '--metricsJson': () => { cfg.metricsJson = true; },
            '--quiet': () => { cfg.quiet = true; },
            '--dryRun': () => { cfg.dryRun = true; },
            '--whitelist-all': () => { cfg.whitelistAll = true; },
        },
        value: {
            '--pollSeconds': (v) => { cfg.pollSeconds = Number(v); },
            '--deltaPercent': (v) => {
                cfg.deltaThresholdPercent = Number(v);
                provided.deltaThresholdPercent = true;
            },
            '--bootstrapHours': (v) => { cfg.bootstrapLookbackHours = Number(v); },
            '--nativeBackfillHours': (v) => { cfg.nativeBackfillHours = Number(v); },
            '--maxStaleHours': (v) => { cfg.maxStaleHours = Number(v); },
            '--sourceRetries': (v) => { cfg.sourceRetries = Number(v); },
            '--retryDelayMs': (v) => { cfg.retryDelayMs = Number(v); },
            '--maxPages': (v) => { cfg.maxPages = Number(v); },
            '--pageLimit': (v) => { cfg.pageLimit = Number(v); },
        },
    });

    const merged = applyRuntimeDefaultsFromGeneralSettings(cfg, provided);
    return validateConfig(merged);
}

function validateConfig(input: Record<string, unknown>) {
    const cfg = { ...DEFAULTS, ...input };

    if (!Number.isFinite(cfg.pollSeconds) || cfg.pollSeconds <= 0) throw new Error('--pollSeconds must be > 0');
    if (!Number.isFinite(cfg.deltaThresholdPercent) || cfg.deltaThresholdPercent <= 0) {
        throw new Error('--deltaPercent must be > 0');
    }
    if (!Number.isFinite(cfg.bootstrapLookbackHours) || cfg.bootstrapLookbackHours <= 0) throw new Error('--bootstrapHours must be > 0');
    if (!Number.isFinite(cfg.nativeBackfillHours) || cfg.nativeBackfillHours <= 0) throw new Error('--nativeBackfillHours must be > 0');
    if (!Number.isFinite(cfg.maxStaleHours) || cfg.maxStaleHours <= 0) throw new Error('--maxStaleHours must be > 0');
    if (!Number.isFinite(cfg.sourceRetries) || cfg.sourceRetries < 1) throw new Error('--sourceRetries must be >= 1');
    if (!Number.isFinite(cfg.retryDelayMs) || cfg.retryDelayMs < 0) throw new Error('--retryDelayMs must be >= 0');
    if (!Number.isFinite(cfg.maxPages) || cfg.maxPages <= 0) throw new Error('--maxPages must be > 0');
    if (!Number.isFinite(cfg.pageLimit) || cfg.pageLimit <= 0) throw new Error('--pageLimit must be > 0');

    cfg.pageLimit = Math.min(API_MAX_PAGE, Math.floor(cfg.pageLimit));
    cfg.maxPages = Math.floor(cfg.maxPages);
    cfg.sourceRetries = Math.floor(cfg.sourceRetries);
    cfg.deltaThresholdPercent = Number(cfg.deltaThresholdPercent);
    cfg.metricsJson = !!cfg.metricsJson;
    cfg.quiet = !!cfg.quiet;
    cfg.dryRun = !!cfg.dryRun;
    return cfg;
}

function resolveDeltaThresholdPercentFromGeneralSettings(settings: Record<string, unknown> | null) {
    const explicit = Number((settings?.MARKET_ADAPTER as Record<string, unknown> | undefined)?.AMA_DELTA_THRESHOLD_PERCENT);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return null;
}

/**
 * Slope-trigger factor from general settings (`(value/100) × maxSlopePct`).
 * Mirrors the price resolver above; the bot editor writes this knob under
 * `MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT`, so the runtime must read
 * it back or the user-facing `AMA-Slope Δ` setting would be inert.
 */
function resolveAmaSlopeDeltaThresholdPercentFromGeneralSettings(settings: Record<string, unknown> | null) {
    const explicit = Number((settings?.MARKET_ADAPTER as Record<string, unknown> | undefined)?.AMA_SLOPE_DELTA_THRESHOLD_PERCENT);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return null;
}

function applyRuntimeDefaultsFromGeneralSettings(cfg: AdapterTargetCfg, provided: { deltaThresholdPercent?: boolean } = {}, settingsOverride?: Record<string, unknown>) {
    const out = { ...cfg };
    const settings = settingsOverride === undefined
        ? readGeneralSettings({ fallback: null })
        : settingsOverride;
    if (!provided?.deltaThresholdPercent) {
        const fromSettings = resolveDeltaThresholdPercentFromGeneralSettings(settings);
        if (fromSettings != null) {
            out.deltaThresholdPercent = fromSettings;
        }
    }
    const slopeFromSettings = resolveAmaSlopeDeltaThresholdPercentFromGeneralSettings(settings);
    if (slopeFromSettings != null) {
        // Rebuild amaSlope instead of mutating it: `cfg` may be the shared
        // DEFAULTS object and must not be poisoned for later calls.
        out.amaSlope = { ...(out.amaSlope || {}), deltaThresholdPct: slopeFromSettings };
    }
    return out;
}

const marketAdapterLogFile = path.join(PATHS.LOGS_DIR, 'market_adapter.log');
const logger = new Logger('MarketAdapter', { quiet: DEFAULTS.quiet, logFile: marketAdapterLogFile });

function log(cfg: { quiet?: unknown } | null | undefined, ...args: unknown[]) {
    logger.quiet = !!cfg?.quiet;
    (logger.info as (...a: unknown[]) => void)(...args);
}

function write(cfg: { quiet?: unknown } | null | undefined, text: string) {
    logger.quiet = !!cfg?.quiet;
    logger.raw(text);
}

function printHelp() {
    logger.raw('Market adapter (standalone): Kibana bootstrap + native incremental updates\n');
    logger.raw('\n');
    logger.raw('Usage:\n');
    logger.raw(`  node ${MARKET_ADAPTER_SOURCE} [--once] [--pollSeconds ${RUNTIME_DEFAULTS.pollSeconds}]\n`);
    logger.raw('\n');
    logger.raw('Options:\n');
    logger.raw('  --once                 Run one cycle and exit\n');
    logger.raw(`  --pollSeconds <n>      Loop interval seconds (default ${RUNTIME_DEFAULTS.pollSeconds}, wall-clock aligned)\n`);
    logger.raw('  --deltaPercent <n>     Trigger threshold percent (default: general.settings MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT or 1.0)\n');
    logger.raw(`  --bootstrapHours <n>   Kibana bootstrap lookback hours (default ${RUNTIME_DEFAULTS.bootstrapLookbackHours})\n`);
    logger.raw(`  --nativeBackfillHours <n>  Native incremental lookback hours (default ${RUNTIME_DEFAULTS.nativeBackfillHours})\n`);
    logger.raw(`  --maxStaleHours <n>    Max accepted candle staleness before trigger suppression (default ${RUNTIME_DEFAULTS.maxStaleHours})\n`);
    logger.raw(`  --sourceRetries <n>    Retries for source fetch calls (default ${RUNTIME_DEFAULTS.sourceRetries})\n`);
    logger.raw(`  --retryDelayMs <n>     Base retry delay in milliseconds (default ${RUNTIME_DEFAULTS.retryDelayMs})\n`);
    logger.raw('  --metricsJson          Emit per-cycle metrics as one JSON line\n');
    logger.raw('  --quiet                Suppress per-bot logs (state still written)\n');
    logger.raw('  --dryRun               Enable dry run mode for non-whitelisted bots\n');
    logger.raw('  --whitelist-all        Disable dry run mode for all bots\n');
    logger.raw(`  --maxPages <n>         Max native history pages per cycle (default ${RUNTIME_DEFAULTS.maxPages})\n`);
    logger.raw(`  --pageLimit <n>        Native page size (max ${API_MAX_PAGE}, default ${RUNTIME_DEFAULTS.pageLimit})\n`);
}

function loadActiveBots() {
    if (!storage.exists(BOTS_FILE)) {
        throw new Error(`Bots file not found at ${BOTS_FILE}`);
    }
    const raw = parseJsonWithComments(storage.readFile(BOTS_FILE));
    const bots = Array.isArray(raw?.bots) ? raw.bots : (Array.isArray(raw) ? raw : []);
    return bots
        .map((b, i: number) => normalizeBotEntry(b, i))
        .filter((b) => b.active);
}

function loadJson<T extends Record<string, unknown>>(filePath: string, defaultValue: T): T {
    try {
        if (!storage.exists(filePath)) return defaultValue;
        return readJSON<T>(filePath);
    } catch (_) {
        return defaultValue;
    }
}

function saveJson(filePath: string, data: Record<string, unknown>) {
    writeJsonAtomic(filePath, data);
}

function candleFileForBot(botKey: string, intervalSeconds: number = RUNTIME_DEFAULTS.intervalSeconds) {
    const label = intervalSeconds === RUNTIME_DEFAULTS.intervalSeconds
        ? RUNTIME_DEFAULTS.intervalLabel
        : toIntervalLabel(intervalSeconds);
    return candleFilePathForLabel(botKey, label, DATA_DIR);
}

function calculateBotThreshold(cfg: Record<string, unknown>) {
    const value = Number(cfg?.deltaThresholdPercent);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function computeCandleStaleness(lastCandleTs: unknown, maxStaleHours: unknown) {
    const lastTs = Number(lastCandleTs);
    const maxHours = Number(maxStaleHours);
    const staleAgeMs = Number.isFinite(lastCandleTs) ? (Date.now() - lastTs) : Number.POSITIVE_INFINITY;
    const staleData = staleAgeMs > (maxHours * 3600 * 1000);
    const staleAgeHours = Number.isFinite(staleAgeMs) ? (staleAgeMs / 3600000) : null;
    return { staleData, staleAgeHours };
}

/**
 * Resolve the AMA configuration a bot trades on.
 *
 * Precedence, as implemented: when a market profile applies for the pair, the
 * preset is chosen from the profile by the bot's `gridPrice` keyword, else the
 * profile/`AMA3` default (a profile entry always wins over the bot's numeric
 * `ama` block). Without a profile, the bot's own `ama` numbers are used, with
 * the `gridPrice` keyword preset filling any missing period and AMA3 as the last
 * resort.
 *
 * The winning preset key — or 'custom' when the numbers came from the bot's own
 * `ama` block — rides along as `name`, so the cycle log and the state snapshot
 * can state which AMA this bot runs without re-deriving it.
 *
 * `enabled` is a derived invariant, always true here. `gridPrice` is the single
 * switch that decides whether a bot is AMA-driven — `usesAmaGridPrice()` reads
 * it in the bot runtime, the maintenance runtime and the launcher — so an
 * `ama.enabled` flag could only ever disagree with them. It used to: this
 * function honoured it on the profile-less path and hardcoded `true` on the
 * profile path, and because the bot side ignores the flag, honouring it froze
 * the published center while the bot kept trading on it. Callers must gate AMA
 * work on `usesAmaGridPrice(bot)`.
 */
function resolveAmaForBot(bot: Record<string, unknown>, ctx: Record<string, unknown> | null = null, cfg: Record<string, unknown> | null = null) {
    const raw = (bot && typeof bot.ama === 'object' && bot.ama !== null)
        ? bot.ama as { erPeriod?: unknown; fastPeriod?: unknown; slowPeriod?: unknown; [key: string]: unknown }
        : {};

    const fromProfiles: AmaResolved | null = getAmaFromProfilesForBot(bot, ctx, cfg);
    if (fromProfiles) return fromProfiles;

    const amaCfg: AmaResolved = {
        erPeriod: Number(raw.erPeriod),
        fastPeriod: Number(raw.fastPeriod),
        slowPeriod: Number(raw.slowPeriod),
        enabled: true,
        name: 'custom',
    };
    // Which preset the periods came from — tracked so the reported name
    // describes the SOURCE, not merely the values (a bot that hand-writes the
    // AMA3 numbers is still its own configuration, not "AMA3").
    const botSuppliedPeriod = Number.isFinite(Number(raw.erPeriod))
        || Number.isFinite(Number(raw.fastPeriod))
        || Number.isFinite(Number(raw.slowPeriod));
    let presetKey: string | null = null;

    if (isAmaKeyword(bot?.gridPrice)) {
        const key = normalizeAmaKey(bot.gridPrice);
        const preset = getAmaPresetForKey(key, null);
        if (preset) {
            if (!Number.isFinite(amaCfg.erPeriod)) amaCfg.erPeriod = preset.erPeriod;
            if (!Number.isFinite(amaCfg.fastPeriod)) amaCfg.fastPeriod = preset.fastPeriod;
            if (!Number.isFinite(amaCfg.slowPeriod)) amaCfg.slowPeriod = preset.slowPeriod;
            presetKey = key;
        }
    }

    if (!Number.isFinite(amaCfg.erPeriod) || amaCfg.erPeriod < 1) amaCfg.erPeriod = DEFAULT_AMA.erPeriod;
    if (!Number.isFinite(amaCfg.fastPeriod) || amaCfg.fastPeriod < 1) amaCfg.fastPeriod = DEFAULT_AMA.fastPeriod;
    if (!Number.isFinite(amaCfg.slowPeriod) || amaCfg.slowPeriod < 1) amaCfg.slowPeriod = DEFAULT_AMA.slowPeriod;
    // Periods the bot supplied itself win, so the config is 'custom'; otherwise
    // the name is the preset the periods came from (keyword, else the default).
    amaCfg.name = botSuppliedPeriod ? 'custom' : (presetKey || DEFAULT_AMA_KEY);
    if (amaCfg.fastPeriod > amaCfg.slowPeriod) {
        const t = amaCfg.fastPeriod;
        amaCfg.fastPeriod = amaCfg.slowPeriod;
        amaCfg.slowPeriod = t;
    }
    return amaCfg;
}

function pruneCandles(candles: unknown[], keepCount: number) {
    if (!Array.isArray(candles)) return [];
    if (candles.length <= keepCount) return candles;
    return candles.slice(candles.length - keepCount);
}

/**
 * Build the per-bot AMA record that is logged and persisted in the state file.
 *
 * It reports the ONE AMA the bot actually trades on — the value the cycle has
 * already computed as `amaValues` — instead of re-running `calculateAMA` for the
 * AMA1..AMA4 preset sweep. Those four extra passes cost ~0.3 ms each per bot per
 * hour and fed nothing but the old "AMA compare:" log line: the presets are
 * research knobs, not a signal, and the bot's price always came from its own
 * configured parameters. So the comparison was 4 duplications of work whose
 * result no decision, log consumer or dashboard ever read.
 *
 * The array shape (one entry, same fields) is kept so the state schema and the
 * cycle log stay stable; the field is still called `amaComparison` in the
 * persisted state for backwards compatibility with existing snapshots.
 */
function buildAmaRecord(botAma: unknown, amaPrice: number) {
    const a = botAma as { erPeriod?: unknown; fastPeriod?: unknown; slowPeriod?: unknown; name?: unknown } | null | undefined;
    const erPeriod = Number(a?.erPeriod);
    const fastPeriod = Number(a?.fastPeriod);
    const slowPeriod = Number(a?.slowPeriod);
    if (!Number.isFinite(erPeriod) || !Number.isFinite(fastPeriod) || !Number.isFinite(slowPeriod)) {
        return [];
    }
    const value = Number(amaPrice);
    return [{
        name: String(a?.name || 'active'),
        erPeriod,
        fastPeriod,
        slowPeriod,
        value: Number.isFinite(value) ? value : null,
        ok: Number.isFinite(value),
    }];
}

async function fetchNativeTradesSince(poolId: string, sinceMs: number, pageLimit: number, maxPages: number) {
    const { BitShares } = getBitsharesClient();
    const trades: NativeTradeRecord[] = [];
    const seenSequences = new Set();
    let pages = 0;
    let startSeq: number | null = null;
    let hitOld = false;

    while (pages < maxPages) {
        let page;
        if (startSeq == null) {
            page = await BitShares.history.get_liquidity_pool_history(poolId, null, null, pageLimit, LP_OP_TYPE);
        } else {
            page = await BitShares.history.get_liquidity_pool_history_by_sequence(poolId, startSeq, null, pageLimit, LP_OP_TYPE);
        }

        if (!Array.isArray(page) || page.length === 0) break;

        pages++;

        for (const row of page) {
            const seq = Number(row?.sequence);
            if (Number.isFinite(seq)) {
                if (seenSequences.has(seq)) continue;
                seenSequences.add(seq);
            }

            const tsMs = parseChainTimeToMs(row?.time || row?.op?.block_time);
            if (!Number.isFinite(tsMs)) continue;
            if (tsMs < sinceMs) {
                hitOld = true;
                break;
            }

            const trade = nativeHistoryRowToTrade(row);
            if (!trade) continue;
            trades.push(trade);
        }

        const last = page[page.length - 1];
        const lastSeq: number = Number(last?.sequence);
        if (!Number.isFinite(lastSeq) || lastSeq <= 1) break;
        if (hitOld) break;
        startSeq = lastSeq - 1;
    }

    return {
        trades,
        pages,
        truncated: pages >= maxPages && !hitOld,
    };
}

function nativeHistoryRowToTrade(row: unknown) {
    interface RowShape {
        time?: unknown;
        sequence?: unknown;
        op?: { op?: unknown; result?: unknown; block_time?: unknown };
    }
    const r = row as RowShape | null | undefined;
    const tsMs = parseChainTimeToMs(r?.time || r?.op?.block_time);
    if (!Number.isFinite(tsMs)) return null;
    const opPayload = (Array.isArray(r?.op?.op) ? (r.op.op as unknown[])[1] : null) as { amount_to_sell?: unknown } | null;
    const resultPayload = (Array.isArray(r?.op?.result) ? (r.op.result as unknown[])[1] : null) as { received?: unknown } | null;
    const received = Array.isArray(resultPayload?.received)
        ? (resultPayload!.received as unknown[])[0]
        : (resultPayload?.received || null);

    if (!opPayload?.amount_to_sell || !received) return null;

    const sequence = Number(r?.sequence);
    return {
        tsMs,
        sequence: Number.isFinite(sequence) ? sequence : null,
        sell: opPayload.amount_to_sell,
        received,
    };
}

async function fetchNativeTradesUntilOverlap(poolId: string, overlapSequences: unknown, minOverlap: number, pageLimit: number, maxPages: number) {
    const { BitShares } = getBitsharesClient();
    const overlapSet = new Set((Array.isArray(overlapSequences) ? overlapSequences : [])
        .map((v) => String(v))
        .filter((v) => v !== ''));
    const trades: NativeTradeRecord[] = [];
    const seenSequences = new Set();
    let pages = 0;
    let startSeq: number | null = null;
    let overlapCount = 0;

    if (overlapSet.size === 0) {
        throw new Error('fetchNativeTradesUntilOverlap requires at least one overlap sequence');
    }

    while (pages < maxPages) {
        const page = startSeq == null
            ? await BitShares.history.get_liquidity_pool_history(poolId, null, null, pageLimit, LP_OP_TYPE)
            : await BitShares.history.get_liquidity_pool_history_by_sequence(poolId, startSeq, null, pageLimit, LP_OP_TYPE);

        if (!Array.isArray(page) || page.length === 0) break;
        pages++;

        for (const row of page) {
            const seq = Number(row?.sequence);
            const seqKey = Number.isFinite(seq) ? String(seq) : null;
            if (seqKey) {
                if (seenSequences.has(seqKey)) continue;
                seenSequences.add(seqKey);
            }

            const trade = nativeHistoryRowToTrade(row);
            if (!trade) continue;
            trades.push(trade);

            if (seqKey && overlapSet.has(seqKey)) {
                overlapCount++;
                if (overlapCount >= minOverlap) {
                    return {
                        trades,
                        pages,
                        overlapCount,
                        reachedOverlap: true,
                    };
                }
            }
        }

        const last = page[page.length - 1];
        const lastSeq: number = Number(last?.sequence);
        if (!Number.isFinite(lastSeq) || lastSeq <= 1) break;
        startSeq = lastSeq - 1;
    }

    return {
        trades,
        pages,
        overlapCount,
        reachedOverlap: false,
    };
}

async function fetchNativeMarketHistorySince(assetA: unknown, assetB: unknown, sinceMs: number, untilMs: number, intervalSeconds: number, options: { fillCandleGaps?: (...args: unknown[]) => unknown } = {}) {
    const a = assetA as { id?: unknown; symbol?: unknown };
    const b = assetB as { id?: unknown; symbol?: unknown };
    const { BitShares } = getBitsharesClient();
    if (!BitShares) {
        throw new Error('BitShares client unavailable');
    }

    const startDate = new Date(Number.isFinite(sinceMs) ? sinceMs : Date.now());
    const stopDate = new Date(Number.isFinite(untilMs) ? untilMs : Date.now());
    const history = await BitShares.history.getMarketHistory(
        b.id,
        a.id,
        intervalSeconds,
        startDate.toISOString().slice(0, -5),
        stopDate.toISOString().slice(0, -5)
    );

    let candles = normalizeNativeMarketHistoryCandles(history, a as Parameters<typeof normalizeNativeMarketHistoryCandles>[1], b as Parameters<typeof normalizeNativeMarketHistoryCandles>[2]);
    if (candles.length > 0 && typeof options.fillCandleGaps === 'function') {
        candles = options.fillCandleGaps(candles, intervalSeconds) as typeof candles;
    }
    return candles;
}

function writeGridResetTrigger(bot: Record<string, unknown>, payload: Record<string, unknown>): string {
    const triggerPath = getRecalculateTriggerFile(String(bot.botKey));
    const content = {
        createdAt: new Date().toISOString(),
        source: MARKET_ADAPTER_SOURCE,
        botName: bot.name,
        botKey: bot.botKey,
        ...payload,
    };
    writeJsonAtomic(triggerPath, content);
    return triggerPath;
}

const ORDERS_DIR = PATHS.ORDERS_DIR;

/**
 * Atomically write the dynamic grid snapshot for a bot to profiles/orders/<botKey>.dynamicgrid.json.
 * Contains AMA-derived center price and any computed effective weight offsets.
 * The bot reads this snapshot before every rebalance so fresh weights are applied to new orders.
 * Uses write-then-rename to prevent partial reads by the dexbot process.
 */
function writeBotDynamicGrid(botKey: string, gridCenterPrice: number, options: {
    amaCenterPrice?: number;
    amaSlope?: Record<string, unknown>;
    gridRangeScalingAmaSlope?: Record<string, unknown>;
    amaSlopeDeltaPercent?: number;
    amaSlopeThresholdPercent?: number;
    gridPriceOffsetPct?: number;
    dynamicWeights?: Record<string, unknown>;
    observedLastGridResetAt?: string;
    asymmetricBounds?: { rawAsymmetryFactor: number | null; appliedAsymmetryFactor: number; trend: string };
} = {}) {
    try {
        const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
        const preserveGridResetMetadata = (target: Record<string, unknown>, snapshot: Record<string, unknown>) => {
            if (!snapshot?.lastGridResetAt) return target;
            const incomingResetMs = Date.parse(String(snapshot.lastGridResetAt));
            const currentResetMs = Date.parse(String(target.lastGridResetAt || ''));
            const observedResetMs = Date.parse(String(options.observedLastGridResetAt || ''));
            if (Number.isFinite(currentResetMs) && Number.isFinite(incomingResetMs) && currentResetMs > incomingResetMs) {
                return target;
            }
            target.lastGridResetAt = snapshot.lastGridResetAt;
            if (snapshot.lastGridResetSource) {
                target.lastGridResetSource = snapshot.lastGridResetSource;
            }
            const hasObservedResetMarker = Object.prototype.hasOwnProperty.call(options, 'observedLastGridResetAt');
            const snapshotResetIsNewerThanObserved = Number.isFinite(incomingResetMs)
                && hasObservedResetMarker
                && (!Number.isFinite(observedResetMs) || incomingResetMs > observedResetMs);
            if (snapshotResetIsNewerThanObserved) {
                const resetGridCenterPrice = Number(snapshot.gridCenterPrice ?? snapshot.centerPrice);
                if (Number.isFinite(resetGridCenterPrice) && resetGridCenterPrice > 0) {
                    target.gridCenterPrice = resetGridCenterPrice;
                    target.centerPrice = resetGridCenterPrice;
                }
            }
            return target;
        };
        const result = updateDynamicGridSnapshotSync(filePath, (previousSnapshot: unknown) => {
            const previous = previousSnapshot as Record<string, unknown>;
            const amaCenterPrice = Number(options.amaCenterPrice);
            const resolvedGridCenterPrice = Number.isFinite(Number(gridCenterPrice))
                ? roundTo(Number(gridCenterPrice), 1e8)
                : null;
            const payload: Record<string, unknown> = {
                gridCenterPrice: resolvedGridCenterPrice,
                centerPrice: resolvedGridCenterPrice,
                amaCenterPrice: Number.isFinite(amaCenterPrice) && amaCenterPrice > 0 ? amaCenterPrice : resolvedGridCenterPrice,
                amaSlopePercentMode: AMA_SLOPE_PERCENT_MODE_PER_BAR,
                updatedAt: new Date().toISOString(),
                source: MARKET_ADAPTER_SOURCE,
            };
            if (options.amaSlope && typeof options.amaSlope === 'object') {
                payload.amaSlope = options.amaSlope;
            }
            if (options.gridRangeScalingAmaSlope && typeof options.gridRangeScalingAmaSlope === 'object') {
                payload.gridRangeScalingAmaSlope = options.gridRangeScalingAmaSlope;
            }
            if (Number.isFinite(Number(options.gridPriceOffsetPct))) {
                payload.gridPriceOffsetPct = Number(options.gridPriceOffsetPct);
            }
            if (Number.isFinite(Number(options.amaSlopeDeltaPercent))) {
                payload.amaSlopeDeltaPercent = Number(options.amaSlopeDeltaPercent);
            }
            if (Number.isFinite(Number(options.amaSlopeThresholdPercent))) {
                payload.amaSlopeThresholdPercent = Number(options.amaSlopeThresholdPercent);
            }
            preserveGridResetMetadata(payload, previous);
            if (options.dynamicWeights && typeof options.dynamicWeights === 'object') {
                payload.dynamicWeights = options.dynamicWeights;
            }
            // Persist root-level asymmetric bounds independently of
            // dynamicWeights so display tools can render the grid range
            // scaling percentage even when dynamicWeight is not enabled.
            if (options.asymmetricBounds && typeof options.asymmetricBounds === 'object') {
                payload.asymmetricBounds = options.asymmetricBounds;
            }
            return payload;
        });
        return result.ok && result.written;
    } catch (err) {
        logger.warn(`[writeBotDynamicGrid] Failed to write dynamic grid for ${botKey}: ${getErrorMessage(err)}`);
        return false;
    }
}

import type { ServiceDeps, ContextCacheEntry } from './core/market_adapter_service.js';
import {
    MarketAdapterService,
    AMA_SLOPE_PERCENT_MODE_PER_BAR,
    normalizeAmaSlopePercentMode,
    convertSlopePercentToPerBar,
    evaluateStateRepairVeto,
} from './core/market_adapter_service.js';
import { getErrorMessage } from '../modules/utils/errors.js';
const adapterService = new MarketAdapterService({
    resolveBotContext,
    resolveAmaForBot,
    candleFileForBot,
    loadJson,
    saveJson,
    calculateBotThreshold,
    computeCandleStaleness,
    withRetries,
    kibanaSource,
    kibanaMarketSource,
    fetchNativeMarketHistorySince,
    fetchNativeTradesSince,
    fetchNativeTradesUntilOverlap,
    tradesToCandles,
    detectMissingCandleTimestamps,
    fillCandleGaps,
    detectStaleTail,
    pruneStaleTail,
    mergeCandles,
    pruneCandles,
    buildAmaRecord,
    writeGridResetTrigger,
    writeBotDynamicGrid,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotAsymmetricBoundsWhitelisted,
    logger,
    root: ROOT,
    ordersDir: ORDERS_DIR,
    path,
} as unknown as ServiceDeps);

async function processBot(bot: Record<string, unknown>, state: Record<string, unknown>, cfg: AdapterTargetCfg, contextCache: Map<string, ContextCacheEntry>, hooks: Record<string, unknown> = {}) {
    return adapterService.processBot(bot, state, cfg, contextCache, hooks);
}

function writeCenterSnapshot(state: { bots?: Record<string, Record<string, unknown>> }) {
    const centers: { updatedAt: string; bots: Record<string, Record<string, unknown>> } = {
        updatedAt: new Date().toISOString(),
        bots: {},
    };
    const bots: Record<string, Record<string, unknown>> = state?.bots || {};
    for (const [botKey, v] of Object.entries(bots)) {
        const gridCenterPrice = v.gridCenterPrice ?? v.centerPrice;
        centers.bots[botKey] = {
            botName: v.botName,
            gridCenterPrice,
            centerPrice: gridCenterPrice,
            amaCenterPrice: v.amaCenterPrice,
            lastGridResetAt: v.lastGridResetAt,
            lastGridResetSource: v.lastGridResetSource,
            lastAmaPrice: v.lastAmaPrice,
            lastDeltaPercent: v.lastDeltaPercent,
            amaSlopeDeltaPercent: v.amaSlopeDeltaPercent,
            amaSlopeThresholdPercent: v.amaSlopeThresholdPercent,
            amaSlopePercentMode: v.amaSlopePercentMode || AMA_SLOPE_PERCENT_MODE_PER_BAR,
            gridRangeScalingAmaSlope: v.gridRangeScalingAmaSlope,
            weights: v.weights,
            effectiveWeights: v.effectiveWeights,
            collateralRecommendation: v.collateralRecommendation ?? null,
            amaSlope: v.amaSlope,
            atr: v.atr
        };
    }
    saveJson(CENTER_FILE, centers);
}

function mergeGridResetMetadataFromDynamicGrid(state: Record<string, unknown>) {
    if (!state || typeof state !== 'object' || !state.bots || typeof state.bots !== 'object') {
        return state;
    }

    const bots = state.bots as Record<string, unknown>;
    for (const [botKey, rawBotState] of Object.entries(bots)) {
        if (!rawBotState || typeof rawBotState !== 'object') continue;
        const botState = rawBotState as Record<string, unknown>;
        const snapshotPath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
        let snapshot;
        try {
            snapshot = readJSON(snapshotPath);
        } catch (_) {
            continue;
        }

        if (!snapshot?.lastGridResetAt) continue;
        const snapshotResetMs = Date.parse(String(snapshot.lastGridResetAt));
        const stateResetMs = Date.parse(String(botState.lastGridResetAt || ''));
        if (Number.isFinite(stateResetMs) && Number.isFinite(snapshotResetMs) && stateResetMs > snapshotResetMs) {
            continue;
        }

        botState.lastGridResetAt = snapshot.lastGridResetAt;
        if (snapshot.lastGridResetSource) {
            botState.lastGridResetSource = snapshot.lastGridResetSource;
        }

        const gridCenterPrice = Number(snapshot.gridCenterPrice ?? snapshot.centerPrice);
        if (Number.isFinite(gridCenterPrice) && gridCenterPrice > 0) {
            botState.gridCenterPrice = gridCenterPrice;
            botState.centerPrice = gridCenterPrice;
        }
    }

    return state;
}

async function runOnce(cfg: AdapterTargetCfg, state: Record<string, unknown>, contextCache: Map<string, ContextCacheEntry>) {
    _resetCycleCache(); // reload settings and cached file-backed config once per cycle
    const startedAtMs = Date.now();
    const allBots = loadActiveBots();
    const bots = allBots.filter((bot) => usesAmaGridPrice(bot));
    log(cfg, `Active bots: ${allBots.length} | AMA-grid bots: ${bots.length}`);

    const results: BotRunResult[] = [];

    for (const bot of bots) {
        const isDryRun = cfg.dryRun || (!cfg.whitelistAll && !isBotWhitelisted(bot.botKey as string));
        write(cfg, `- ${bot.name} (${bot.botKey})${isDryRun ? ' [DRY RUN]' : ''}: `);
        try {
            const botCfg = resolveBotCfg(bot, cfg);
            const r = await processBot(bot, state, botCfg, contextCache, {
                onTrigger: cfg.onTrigger,
                isDryRun,
                forceWhitelistAll: cfg.whitelistAll,
            });
            if (!r.ok) {
                log(cfg, `skip (${r.reason})`);
                results.push({
                    botName: bot.name,
                    botKey: bot.botKey,
                    ok: false,
                    reason: r.reason,
                });
                continue;
            }

            // Off-hour skip: nothing to compute, so log one compact line
            // instead of the full signal block (which would print n/a for
            // every field and bury the hourly cycle in noise).
            if (r.source === 'off-hour-skip') {
                log(cfg, `skip (no new closed candle, last processed ${Number.isFinite(r.lastClosedCandleTs) ? new Date(Number(r.lastClosedCandleTs)).toISOString() : 'n/a'})`);
                results.push({
                    botName: bot.name,
                    botKey: bot.botKey,
                    ...r,
                });
                continue;
            }

            const amaText = Number.isFinite(r.amaPrice) ? Number(r.amaPrice).toFixed(8) : 'n/a';
            const prevCenterText = Number.isFinite(r.previousCenterPrice) ? Number(r.previousCenterPrice).toFixed(8) : 'n/a';
            const deltaText = Number.isFinite(r.deltaPercent) ? `${Number(r.deltaPercent).toFixed(3)}%` : 'n/a';
            const thresholdText = Number.isFinite(r.thresholdPercent) ? `${Number(r.thresholdPercent).toFixed(3)}%` : 'n/a';
            const offText = r.weights?.meta?.finalOffset != null ? ` off=${r.weights.meta.finalOffset.toFixed(3)}` : '';
            const amaOffText = r.amaSlope?.amaSlopeGated != null ? ` (amaOff=${r.amaSlope.amaSlopeGated.toFixed(3)})` : '';
            const regimeText = r.amaSlope?.regimeMultiplier != null ? ` regime=${r.amaSlope.regimeMultiplier.toFixed(2)}` : '';

            const staleText = r.staleData ? ` STALE` : '';
            const patchText = Number(r.kibanaGapRepairCount) > 0 ? ` KIBANA_PATCH(${r.kibanaGapRepairCount})` : '';
            const backfillText = Number(r.kibanaBackfillCount) > 0 ? ` BACKFILL(${r.kibanaBackfillCount})` : '';
            const gapText = Number(r.unresolvedGapCount) > 0 ? ` GAPS(${r.unresolvedGapCount})` : '';
            const trigText = r.triggered ? ` TRIGGERED -> ${r.triggerPath ? path.relative(ROOT, String(r.triggerPath)) : '[suppressed, dry-run]'}` : '';
            const pendingText = r.pendingClosedCandle ? ' WAITING_FOR_CLOSED_CANDLE' : '';
            const weightText = buildWeightSummary(r.weights);
            const trendText = r.amaSlope?.trend ? ` trend=${r.amaSlope.trend}` : '';
            const warmupText = r.triggerSuppressedReason === 'ama_warmup_insufficient'
                ? ` WARMUP_INSUFFICIENT(used=${r.analysisCandleCount}${Number.isFinite(r.analysisKeepCount) ? `/${r.analysisKeepCount}` : ''})`
                : '';
            const isOneHourResult = Number(r.intervalSeconds) === RUNTIME_DEFAULTS.intervalSeconds;
            const closedTsText = isOneHourResult && Number.isFinite(r.lastClosedCandleTs) ? ` closed=${new Date(Number(r.lastClosedCandleTs)).toISOString()}` : '';
            const rawTsText = isOneHourResult && Number.isFinite(r.rawLastCandleTs) ? ` rawLast=${new Date(Number(r.rawLastCandleTs)).toISOString()}` : '';
            const closeText = isOneHourResult && Number.isFinite(r.lastClosedCandleClose) ? ` close=${Number(r.lastClosedCandleClose).toFixed(8)}` : '';
            const rawCountText = Number.isFinite(r.candleCount)
                ? ` raw=${r.candleCount}${Number.isFinite(r.rawKeepCount) ? `/${r.rawKeepCount}` : ''}`
                : '';
            const usedCountText = Number.isFinite(r.analysisCandleCount)
                ? ` used=${r.analysisCandleCount}${Number.isFinite(r.analysisKeepCount) ? `/${r.analysisKeepCount}` : ''}`
                : '';
            const nativeText = isOneHourResult && Number.isFinite(r.nativePagesFetched) ? ` nativePages=${r.nativePagesFetched}` : '';
            const dynText = isOneHourResult ? ` flags[whitelist=${r.dynamicWeightWhitelisted ? 'yes' : 'no'},base=${r.hasExplicitBaseWeights ? 'yes' : 'no'},ready=${r.dynamicWeightReady ? 'yes' : 'no'},applied=${r.dynamicWeightApplied ? 'yes' : 'no'}${r.dynamicWeightProfile ? `,profile=${r.dynamicWeightProfile}` : ''}${r.gridRangeScalingWhitelisted ? ',range=yes' : ''}]` : '';

            log(cfg, `${r.source},${rawCountText}${usedCountText}${closedTsText}${rawTsText}${closeText}, ama=${amaText} (prevCenter=${prevCenterText}, delta=${deltaText}), threshold=${thresholdText}${offText}${amaOffText}${regimeText}${staleText}${patchText}${backfillText}${gapText}${trigText}${pendingText}${warmupText}${trendText}${weightText}${dynText}${nativeText}`);
            if (r.triggerSuppressedReason === 'waiting_for_new_closed_candle') {
                log(cfg, '  No write pass: the latest 1h candle has not closed yet, so the adapter kept the snapshot unchanged.');
            }
            if (r.triggerSuppressedReason === 'ama_warmup_insufficient') {
                log(cfg, '  No write pass: AMA warmup history is still insufficient for a valid grid-centering write.');
            }
            if (r.triggerSuppressedReason === 'unresolved_candle_gaps') {
                log(cfg, '  No write pass: unresolved candle gaps remain, so the adapter kept the snapshot unchanged.');
            }
            if (r.triggerSuppressedReason === 'fixed_start_price') {
                log(cfg, '  No write pass: numeric startPrice disables market adapter fetch.');
            }
            if (Array.isArray(r.dryRunMessages)) {
                r.dryRunMessages.forEach((msg: unknown) => log(cfg, `  ${msg}`));
            }
            if (isOneHourResult && r.weights?.meta) {
                const m = r.weights.meta;
                log(cfg, `  Inputs: ${buildDynamicWeightInputsLog(m, r.amaConfig)}`);
                log(cfg, `  Tuning: ${buildDynamicWeightTuningLog(m)}`);
            }
            if (isOneHourResult && r.gridRangeScalingWhitelisted) {
                const asymSource = r.weights?.meta && Number.isFinite(r.weights.meta.rawAsymmetryFactor)
                    ? r.weights.meta
                    : r;
                log(cfg, `  Asymmetric bounds: ${buildAsymmetricBoundsLog(asymSource)}`);
            }
            if (Array.isArray(r.amaComparison) && r.amaComparison.length > 0) {
                const parts = r.amaComparison.map((a: { value: number; name: string; erPeriod: number; fastPeriod: number; slowPeriod: number }) => {
                    const val = Number.isFinite(a.value) ? a.value.toFixed(8) : 'n/a';
                    return `${a.name}[${a.erPeriod}/${a.fastPeriod}/${a.slowPeriod}]=${val}`;
                });
                log(cfg, `  AMA active: ${parts.join(' | ')}`);
            }
            results.push({
                botName: bot.name,
                botKey: bot.botKey,
                ...r,
            });
        } catch (err) {
            log(cfg, `error (${getErrorMessage(err)})`);
            results.push({
                botName: bot.name,
                botKey: bot.botKey,
                ok: false,
                reason: getErrorMessage(err),
            });
        }
    }

    state.meta = {
        updatedAt: new Date().toISOString(),
        source: MARKET_ADAPTER_SOURCE,
        defaults: {
            ama: DEFAULT_AMA,
            intervalSeconds: cfg.intervalSeconds,
            deltaThresholdPercent: cfg.deltaThresholdPercent,
            deltaThresholdMode: 'fixed_percent',
        },
    };

    const metrics = {
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        totalActiveBots: allBots.length,
        processedBots: bots.length,
        successBots: results.filter((r) => r.ok).length,
        failedBots: results.filter((r) => !r.ok).length,
        triggeredBots: results.filter((r) => r.ok && r.triggered).length,
        staleBots: results.filter((r) => r.ok && r.staleData).length,
        kibanaPatchedBots: results.filter((r) => r.ok && Number(r.kibanaGapRepairCount) > 0).length,
        kibanaPatchedCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.kibanaGapRepairCount) ? Number(r.kibanaGapRepairCount) : 0), 0),
        kibanaBackfilledBots: results.filter((r) => r.ok && Number(r.kibanaBackfillCount) > 0).length,
        kibanaBackfilledCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.kibanaBackfillCount) ? Number(r.kibanaBackfillCount) : 0), 0),
        unresolvedGapBots: results.filter((r) => r.ok && Number(r.unresolvedGapCount) > 0).length,
        unresolvedGapCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.unresolvedGapCount) ? Number(r.unresolvedGapCount) : 0), 0),
    };
    (state.meta as Record<string, unknown>).metrics = metrics;

    mergeGridResetMetadataFromDynamicGrid(state);
    saveJson(STATE_FILE, state);
    writeCenterSnapshot(state);
    if (cfg.metricsJson) {
        log(cfg, `METRICS ${JSON.stringify(metrics)}`);
    }
    return { results, metrics };
}

async function runOnceForAma(overrides: object = {}) {
    const provided = {
        deltaThresholdPercent: Object.prototype.hasOwnProperty.call(overrides, 'deltaThresholdPercent'),
    };
    const cfg = validateConfig({
        ...applyRuntimeDefaultsFromGeneralSettings({
            ...DEFAULTS,
            quiet: true,
        }, provided),
        ...overrides,
        once: true,
    });

    ensureDir(DATA_DIR);
    ensureDir(STATE_DIR);

    const lock = acquireFileLockSync(LOCK_FILE, {
        staleMs: Math.max(2, cfg.pollSeconds) * 1000 * 2,
    });
    try {
        const { connectClient } = getBitsharesClient();
        await connectClient();
        const state = loadJson(STATE_FILE, { meta: {}, bots: {} });
        const contextCache = new Map<string, ContextCacheEntry>();
        const run = await runOnce(cfg, state, contextCache);

        return {
            updatedAt: (state?.meta as { updatedAt?: string } | undefined)?.updatedAt || new Date().toISOString(),
            ...run,
            state,
        };
    } finally {
        const { disconnectClient } = getBitsharesClient();
        disconnectClient();
        releaseFileLockSync(lock);
    }
}

async function main() {
    const cfg = parseArgs();
    logger.quiet = cfg.quiet;

    ensureDir(DATA_DIR);
    ensureDir(STATE_DIR);

    const lock = acquireFileLockSync(LOCK_FILE, {
        staleMs: Math.max(2, cfg.pollSeconds) * 1000 * 2,
    });

    try {
        log(cfg, '═══════════════════════════════════════');
        log(cfg, ' Market Adapter Hub Settings:');
        log(cfg, `  runtime : poll=${cfg.pollSeconds}s | bootstrap=${cfg.bootstrapLookbackHours}h | native=${cfg.nativeBackfillHours}h | stale=${cfg.maxStaleHours}h`);
        log(cfg, `  fetch   : retries=${cfg.sourceRetries}x${cfg.retryDelayMs}ms | pages=${cfg.maxPages}x${cfg.pageLimit} | delta=${formatLogPercent(cfg.deltaThresholdPercent, 3)} | dryRun=${cfg.dryRun ? 'yes' : 'no'} | quiet=${cfg.quiet ? 'yes' : 'no'} | metrics=${cfg.metricsJson ? 'yes' : 'no'}`);
        log(cfg, buildStartupDefaultsLog(DEFAULT_AMA, DEFAULT_CONFIG, MARKET_ADAPTER));
        log(cfg, '═══════════════════════════════════════');

        if (cfg.once && cfg.dryRun) {
            log(cfg, 'Dry run: config validation + lock acquisition OK (no network, no writes).');
            return 0;
        }

        // Read state before the sleep: the lock guarantees no other adapter can
        // rewrite it in the meantime, and the same object is then used by the
        // first cycle, so the file is parsed exactly once per start.
        const state = loadJson(STATE_FILE, { meta: {}, bots: {} });
        const contextCache = new Map<string, ContextCacheEntry>();

        // Sleep-first startup, decided BEFORE the first connection: a respawned
        // daemon (wrapper restart, crash recovery, manual start) must not run a
        // full cycle immediately — mid-hour that cycle can only hit the
        // closed-candle gate after paying the chain handshake + per-bot native
        // fetch. Instead, align to the SAME boundary the loop uses
        // (pollSeconds, default 3600s) and only run early when some active bot
        // still owes a cycle.
        //
        // Ordering matters: connecting first and sleeping afterwards would hold
        // an idle socket for the whole hour, which is exactly what the
        // per-cycle connect/disconnect below exists to avoid. The lock is
        // already held (and its heartbeat is unref'd but armed), so a sleeping
        // adapter still looks alive to the watchdog, which decides staleness by
        // holder liveness rather than by lock age.
        if (!cfg.once) {
            // Only bots the adapter would actually process may veto the sleep:
            // a removed bot's leftover state row (or a fixed-price bot) must
            // not force a full cycle on every restart. If the bot list cannot be
            // read, every state row is judged instead (conservative).
            let activeAmaBotKeys = null;
            try {
                activeAmaBotKeys = loadActiveBots()
                    .filter((bot) => usesAmaGridPrice(bot))
                    .map((bot) => bot.botKey)
                    .filter((k): k is string => typeof k === 'string');
            } catch (_) {
                activeAmaBotKeys = null;
            }
            const verdict = evaluateStartupSleep(cfg, state, Date.now(), activeAmaBotKeys);
            if (verdict.delayMs > 0) {
                log(cfg, `Startup: every active bot consumed the newest closed candle and no repair is outstanding — sleeping ${(verdict.delayMs / 1000).toFixed(0)}s until the next ${cfg.pollSeconds}s boundary (no connection held).`);
                await sleep(verdict.delayMs);
            } else {
                // Name the reason and the bots: a veto caused by one
                // unprocessable bot would otherwise look like "the adapter just
                // never sleeps" with nothing in the log to explain it.
                const v = verdict.veto || { reason: 'unknown', botKeys: [] };
                const who = v.botKeys.length > 0 ? ` [${v.botKeys.join(', ')}]` : '';
                log(cfg, `Startup: running a catch-up cycle now — ${v.reason}${who}.`);
            }
        }

        {
            const maxRetries = 5;
            let lastErr = null;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const { connectClient } = getBitsharesClient();
                    await connectClient();
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = err;
                    if (attempt < maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt - 1), TIMING.RETRY_BACKOFF_CAP_MS);
                        logger.warn(`Connection attempt ${attempt}/${maxRetries} failed: ${getErrorMessage(err)}; retrying in ${delay}ms`);
                        await sleep(delay);
                    }
                }
            }
            if (lastErr) {
                logger.error(`Fatal: BitShares connection failed after ${maxRetries} attempts: ${getErrorMessage(lastErr)}`);
                return 1;
            }
        }
        log(cfg, 'Connected to BitShares');

        if (cfg.once) {
            const run = await runOnce(cfg, state, contextCache);
            const allProcessedFailed = run.metrics.processedBots > 0 && run.metrics.successBots === 0;
            return allProcessedFailed ? 1 : 0;
        }

        while (true) {
            const started = Date.now();
            log(cfg, `\n[cycle ${new Date(started).toISOString()}]`);

            // Connect for this cycle using the lightweight native read-only
            // client, and tear it down after runOnce so the connection never
            // sits idle. A socket that outlives its cycle can be half-open when
            // the next one starts (the peer drops it with no close frame, so
            // readyState stays 1 and nothing notices); the per-cycle handshake
            // re-validates chain id and api id before any RPC goes out on it.
            try {
                const { connectClient } = getBitsharesClient();
                await connectClient();
            } catch (err) {
                logger.error(`Connection failed before cycle: ${getErrorMessage(err)}`);
                // Fall through and let runOnce attempt to handle its own retries/failures
            }

            await runOnce(cfg, state, contextCache);

            try {
                const { disconnectClient } = getBitsharesClient();
                disconnectClient();
            } catch (_) {}

            const cycleMs = Date.now() - started;
            const pollMs = Math.max(1, Number(cfg.pollSeconds) || 0) * 1000;
            if (cycleMs >= pollMs) {
                // The cadence is slipping: this cycle alone consumed a full
                // period, so the next one starts immediately (1000ms floor) and
                // the backlog drains one cycle at a time. Surfaced explicitly,
                // because a silent backlog is indistinguishable from an adapter
                // that "runs every hour" in the log.
                logger.warn(`Cycle took ${(cycleMs / 1000).toFixed(0)}s, at or beyond the ${cfg.pollSeconds}s poll period — running the next cycle immediately to catch up.`);
            }

            const sleepMs = sleepUntilAlignedBoundary(cfg.pollSeconds, started, Date.now());
            await sleep(sleepMs);
        }
    } finally {
        releaseFileLockSync(lock);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main()
        .then((exitCode) => process.exit(Number.isInteger(exitCode) ? exitCode : 0))
        .catch((err) => {
            logger.error(`Fatal: ${getErrorMessage(err)}`);
            process.exit(1);
        });
}

export { main, runOnceForAma, DEFAULT_AMA, DEFAULTS, calculateBotThreshold, buildAmaRecord, computeCandleStaleness, normalizeMarketSource, sleepUntilAlignedBoundary, computeStartupDelayMs, evaluateStartupSleep, resolveAmaForBot, applyRuntimeDefaultsFromGeneralSettings, resolveBotCfg, usesAmaGridPrice, isBotWhitelisted, isBotDynamicWeightWhitelisted, isBotAsymmetricBoundsWhitelisted, writeCenterSnapshot, writeBotDynamicGrid, writeGridResetTrigger, normalizeNativeMarketHistoryCandles, fetchNativeMarketHistorySince, loadMarketAdapterSettings, findPairForBot }

/** Internal seams exercised directly by tests. */
export const __test = {
    resolveDeltaThresholdPercentFromGeneralSettings,
    resolveAmaSlopeDeltaThresholdPercentFromGeneralSettings,
    _resetCycleCache,
    mergeGridResetMetadataFromDynamicGrid,
    _setBitsharesClientForTests: setBitsharesClientForTests,
};


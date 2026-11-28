'use strict';

/**
 * Resolves the grid-reset simulation config for the TradingView exporter.
 *
 * The chart must answer one question: "with the thresholds the live adapter
 * would actually use for this bot, when would the grid have recentered?" So
 * every number here comes from the same resolution chain the running adapter
 * uses (docs/GRID_RECALCULATION.md, "Configuration Priority"):
 *
 *   1. constants            — market_adapter DEFAULTS (MARKET_ADAPTER.*)
 *   2. general settings     — profiles/general.settings.json
 *                             → MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT
 *   3. market adapter cfg   — profiles/market_adapter_settings.json
 *                             → globals → pairs[].marketAdapterSettings
 *                             → pairs[].botOverrides[<botName>]
 *
 * Steps 2 and 3 are applied through the production functions
 * (`applyRuntimeDefaultsFromGeneralSettings`, `resolveBotCfg`,
 * `calculateBotThreshold`, `MarketAdapterService.resolveAmaSlopeDeltaThresholdPercent`)
 * instead of a re-implementation, so the chart cannot drift from the runtime.
 * `describeThresholdSource` then walks the same layers in precedence order
 * purely to LABEL where the effective value came from (shown in the chart's
 * grid-reset panel).
 *
 * Node-only: pulls the market-adapter runner, which is marked node-only in the
 * package.json "browser" field. The browser only ever sees the resulting
 * plain object (payload.gridSim) and the pure replay in grid_reset_sim.ts.
 */

import { MARKET_ADAPTER, DEFAULT_CONFIG } from '../../modules/constants.js';
import { readGeneralSettings } from '../../modules/general_settings.js';
import { resolveConfiguredPriceBound } from '../../modules/order/utils/order.js';
import { parseRelativeMultiplier } from '../../modules/order/utils/math.js';
import { getAmaWarmupBars } from '../../market_adapter/core/strategies/ama.js';
import { MarketAdapterService } from '../../market_adapter/core/market_adapter_service.js';
import { normalizeAmaSlopeEmaAlpha } from '../../market_adapter/core/config_normalizers.js';
import {
    DEFAULTS,
    applyRuntimeDefaultsFromGeneralSettings,
    resolveBotCfg,
    calculateBotThreshold,
    loadMarketAdapterSettings,
    findPairForBot,
    usesAmaGridPrice,
    isBotAsymmetricBoundsWhitelisted,
    isBotDynamicWeightWhitelisted,
} from '../../market_adapter/market_adapter.js';

const SOURCE_CONSTANTS = 'constants';
const SOURCE_GENERAL = 'general.settings';
const SOURCE_ADAPTER_GLOBALS = 'market_adapter_settings:globals';
const SOURCE_ADAPTER_PAIR = 'market_adapter_settings:pair';
const SOURCE_ADAPTER_BOT = 'market_adapter_settings:bot';
const SOURCE_CLI = 'cli';

const SIM_SERVICE = new MarketAdapterService({});

function firstPositive(values: unknown[], fallback: number): number {
    for (const v of values) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return fallback;
}

/**
 * Walk the config layers in precedence order and report which one defined the
 * value that ended up in the resolved cfg. Each layer carries its own key
 * path(s) because the layers name the same knob differently (the adapter cfg
 * uses `deltaThresholdPercent`, general settings use
 * `MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT`). Display only — the effective
 * numbers always come from the real resolution functions.
 */
function describeThresholdSource(layers: Array<{ name: string; value?: unknown; keys?: string[][] }>, cliOverride: unknown): string {
    if (cliOverride != null) return SOURCE_CLI;
    const hasValue = (obj: unknown, path: string[]) => {
        let node: unknown = obj;
        for (const key of path) {
            node = (node as Record<string, unknown> | null | undefined)?.[key];
            if (node == null) return false;
        }
        return Number.isFinite(Number(node)) && Number(node) > 0;
    };
    for (const layer of layers) {
        if (!layer || !layer.value) continue;
        const paths = Array.isArray(layer.keys) ? layer.keys : [];
        if (paths.some((path: string[]) => hasValue(layer.value, path))) return layer.name;
    }
    return SOURCE_CONSTANTS;
}

/**
 * @param {Object} input
 * @param {string|null} input.botKey       Bot key from profiles/bots.json.
 * @param {Object|null}  input.bot         Raw bots.json entry (for cfg layering).
 * @param {Object|null}  input.ama         Resolved AMA config (er/fast/slow) the chart runs with.
 * @param {Object}      [input.overrides]  CLI overrides {priceDeltaThresholdPercent, slopeDeltaThresholdPercent, enabled}.
 */
function resolveGridResetSimConfig({ botKey, bot, ama, overrides }: {
    botKey?: string | null;
    bot?: Record<string, unknown> | null;
    ama?: { erPeriod?: number; fastPeriod?: number; slowPeriod?: number } | null;
    overrides?: Record<string, unknown>;
} = {}) {
    const opts = overrides && typeof overrides === 'object' ? overrides : {};
    const notes: string[] = [];

    // ── 1. constants + general settings (the DEFAULTS the runner boots with)
    const generalSettings = readGeneralSettings({ fallback: null });
    const baseCfg = applyRuntimeDefaultsFromGeneralSettings({ ...DEFAULTS, quiet: true }, {});

    // ── 2. market_adapter_settings.json (globals → pair → bot)
    const botCfg = bot ? resolveBotCfg(bot, baseCfg) : baseCfg;

    const settings = loadMarketAdapterSettings();
    const pair = bot ? findPairForBot(bot, Array.isArray(settings?.pairs) ? settings.pairs : []) : null;
    const pairObj = pair as Record<string, unknown> | null;
    const botOverride = pairObj?.botOverrides
        ? ((pairObj.botOverrides as Record<string, unknown>)[String(bot?.name)] || null)
        : null;
    const layers = [
        { name: SOURCE_ADAPTER_BOT, value: botOverride, keys: [['deltaThresholdPercent']] },
        { name: SOURCE_ADAPTER_PAIR, value: pair?.marketAdapterSettings, keys: [['deltaThresholdPercent']] },
        { name: SOURCE_ADAPTER_GLOBALS, value: settings?.globals, keys: [['deltaThresholdPercent']] },
        { name: SOURCE_GENERAL, value: generalSettings, keys: [['MARKET_ADAPTER', 'AMA_DELTA_THRESHOLD_PERCENT']] },
    ];

    // ── 3. effective thresholds through the production resolvers
    const resolvedPrice = calculateBotThreshold(botCfg);
    const priceDeltaThresholdPercent = firstPositive(
        [opts.priceDeltaThresholdPercent, resolvedPrice],
        MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
    );
    if (resolvedPrice == null) {
        notes.push('Adapter cfg had no deltaThresholdPercent; fell back to MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT.');
    }
    const priceSource = describeThresholdSource(layers, opts.priceDeltaThresholdPercent);

    // Slope threshold: explicit per-bar % wins, else (factor/100) × maxSlopePct
    // (MarketAdapterService.resolveAmaSlopeDeltaThresholdPercent). Core
    // semantics: a non-positive threshold DISABLES the trigger, so never
    // substitute a synthetic fallback for it.
    const resolvedSlope = SIM_SERVICE.resolveAmaSlopeDeltaThresholdPercent(botCfg);
    const slopeDeltaThresholdPercent = firstPositive(
        [opts.slopeDeltaThresholdPercent, resolvedSlope],
        0,
    );
    const slopeSource = describeThresholdSource(
        [
            { name: SOURCE_ADAPTER_BOT, value: botOverride, keys: [['amaSlopeDeltaThresholdPercent'], ['amaSlope', 'deltaThresholdPct']] },
            { name: SOURCE_ADAPTER_PAIR, value: pair?.marketAdapterSettings, keys: [['amaSlopeDeltaThresholdPercent'], ['amaSlope', 'deltaThresholdPct']] },
            { name: SOURCE_ADAPTER_GLOBALS, value: settings?.globals, keys: [['amaSlopeDeltaThresholdPercent'], ['amaSlope', 'deltaThresholdPct']] },
            { name: SOURCE_GENERAL, value: generalSettings, keys: [['MARKET_ADAPTER', 'AMA_SLOPE_DELTA_THRESHOLD_PERCENT']] },
        ],
        opts.slopeDeltaThresholdPercent,
    );
    if (!(Number.isFinite(slopeDeltaThresholdPercent) && slopeDeltaThresholdPercent > 0)) {
        notes.push('No positive AMA-Slope Δ threshold resolved (factor/maxSlopePct missing); slope resets are disabled.');
    }

    // ── 4. gates and tuning the replay mirrors
    const isAmaBot = bot ? usesAmaGridPrice(bot) : false;
    // The adapter only computes the slope signal for AMA-grid bots that have an
    // explicit weightDistribution (shouldComputeDynamicWeightSignal), so a
    // whitelisted bot without weights never reaches the slope trigger.
    const hasExplicitBaseWeights = !!bot
        && Number.isFinite((bot as { weightDistribution?: { sell?: unknown; buy?: unknown } }).weightDistribution?.sell as number)
        && Number.isFinite((bot as { weightDistribution?: { sell?: unknown; buy?: unknown } }).weightDistribution?.buy as number);
    const asymWhitelisted = botKey ? isBotAsymmetricBoundsWhitelisted(botKey) : false;
    const dynamicWeightEnabled = botKey ? isBotDynamicWeightWhitelisted(botKey) : false;
    const slopeEnabled = isAmaBot && hasExplicitBaseWeights && asymWhitelisted
        && Number.isFinite(slopeDeltaThresholdPercent) && slopeDeltaThresholdPercent > 0;
    if (botKey && !asymWhitelisted) {
        notes.push('asymmetricBounds whitelist is off for this bot: AMA-Slope Δ resets are not simulated.');
    } else if (botKey && asymWhitelisted && !hasExplicitBaseWeights && isAmaBot) {
        notes.push('Bot has no explicit weightDistribution; the adapter skips the slope signal, so AMA-Slope Δ resets are not simulated.');
    }

    const erPeriod = firstPositive([ama?.erPeriod, botCfg?.erPeriod], MARKET_ADAPTER.AMAS.AMA3.erPeriod);
    const lookbackBars = firstPositive([botCfg?.amaSlope?.lookbackBars], MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS);
    // EMA on the slope must match the live service's normalized read so the
    // replayed delta-s resets and band tilt use the same signal the bot runs.
    const emaAlpha = normalizeAmaSlopeEmaAlpha(botCfg?.amaSlope?.emaAlpha ?? botCfg?.amaSlopeEmaAlpha);
    // Slope-delta persistence gate: mirror resolveAmaSlopePersistBars in the
    // adapter service so the chart replay fires the same Δs resets production
    // does. Per-bot override wins; else the global enable + value; else legacy 1.
    const resolveSlopePersistBars = () => {
        // Mirror resolveAmaSlopePersistBars (market_adapter_service): explicit
        // `persistBars >= 1` wins, `0` disables, and `persistEnabled: false` is a
        // real tri-state override that must beat the global `true`.
        const rawBars = botCfg?.amaSlope?.persistBars ?? botCfg?.amaSlopePersistBars;
        const explicit = (rawBars === null || rawBars === undefined) ? NaN : Number(rawBars);
        if (Number.isFinite(explicit)) {
            if (explicit >= 1) return Math.round(explicit);
            if (explicit === 0) return 1;
        }
        const override = botCfg?.amaSlope?.persistEnabled ?? botCfg?.amaSlopePersistEnabled;
        const enabled = override === false ? false
            : override === true ? true
            : MARKET_ADAPTER.AMA_SLOPE_PERSIST_ENABLED === true;
        if (!enabled) return 1;
        const bars = Number(MARKET_ADAPTER.AMA_SLOPE_PERSIST_BARS);
        return Number.isFinite(bars) && bars >= 1 ? Math.round(bars) : 1;
    };
    let warmupBars = 0;
    try {
        warmupBars = getAmaWarmupBars(
            erPeriod,
            firstPositive([ama?.slowPeriod], MARKET_ADAPTER.AMAS.AMA3.slowPeriod),
            lookbackBars,
            firstPositive([ama?.fastPeriod], MARKET_ADAPTER.AMAS.AMA3.fastPeriod),
        );
    } catch (_err) {
        // getAmaWarmupBars validates strictly; a research-only AMA tweak must
        // never break chart generation — fall back to the ER warmup floor.
        warmupBars = Math.ceil(erPeriod) + lookbackBars;
    }

    // Absolute bot bounds pin the accepted center (clampGridPriceToBounds);
    // "Nx" bounds resolve around the center and therefore never bind it. A
    // mixed config (one absolute, one "Nx") still clamps on the absolute side,
    // so resolve each side independently.
    const resolveClampBound = (raw: unknown, fallback: unknown, mode: 'min' | 'max'): number | null => {
        const relative = parseRelativeMultiplier(raw);
        if (relative != null && relative > 1) return null;
        try {
            const bound = resolveConfiguredPriceBound(raw as string | number | null | undefined, fallback as string | number | null | undefined, 1, mode) as number | null | undefined;
            return bound != null && Number.isFinite(bound) && bound > 0 ? Number(bound) : null;
        } catch (_err) {
            return null;
        }
    };
    const clampMin = bot ? resolveClampBound(bot.minPrice, DEFAULT_CONFIG.minPrice, 'min') : null;
    const clampMax = bot ? resolveClampBound(bot.maxPrice, DEFAULT_CONFIG.maxPrice, 'max') : null;

    return {
        enabled: isAmaBot,
        botKey: botKey || null,
        priceDeltaThresholdPercent,
        priceSource,
        slopeDeltaThresholdPercent,
        slopeSource,
        slopeEnabled,
        dynamicWeightEnabled,
        lookbackBars,
        emaAlpha,
        slopePersistBars: resolveSlopePersistBars(),
        maxSlopePct: firstPositive([botCfg?.amaSlope?.maxSlopePct], MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT),
        neutralZonePct: Number.isFinite(Number(botCfg?.amaSlope?.neutralZonePct))
            ? Number(botCfg?.amaSlope?.neutralZonePct)
            : MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
        maxSlopeOffset: firstPositive(
            [botCfg?.maxSlopeOffset],
            MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
        ),
        clipPercentile: Number.isFinite(Number(botCfg?.clipPercentile))
            ? Number(botCfg.clipPercentile)
            : MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE,
        maxAsymmetryFactor: firstPositive(
            [(bot?.asymmetricBounds as { maxAsymmetryFactor?: unknown } | undefined)?.maxAsymmetryFactor, (botCfg?.asymmetricBounds as { maxAsymmetryFactor?: unknown } | undefined)?.maxAsymmetryFactor],
            MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR,
        ),
        minScaleSlots: firstPositive(
            [(botCfg?.asymmetricBounds as { minScaleSlots?: unknown } | undefined)?.minScaleSlots],
            MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MIN_SCALE_SLOTS,
        ),
        incrementPercent: Number.isFinite(Number(bot?.incrementPercent)) ? Number(bot?.incrementPercent) : null,
        erPeriod: Math.ceil(erPeriod),
        warmupBars,
        warmupBarsOverride: Number.isFinite(Number(opts.warmupBars)) && Number(opts.warmupBars) >= 0 ? Math.ceil(Number(opts.warmupBars)) : null,
        clampMin,
        clampMax,
        notes,
    };
}

/**
 * Flatten the resolved config for the chart payload, dropping anything the page
 * must not see (e.g. Infinity from a disabled threshold).
 */
function toGridSimPayload(cfg: Record<string, unknown> | null) {
    if (!cfg) return null;
    return {
        enabled: cfg.enabled === true,
        botKey: cfg.botKey ?? null,
        priceDeltaThresholdPercent: Number.isFinite(cfg.priceDeltaThresholdPercent) ? cfg.priceDeltaThresholdPercent : null,
        priceSource: cfg.priceSource ?? SOURCE_CONSTANTS,
        slopeDeltaThresholdPercent: Number.isFinite(cfg.slopeDeltaThresholdPercent) ? cfg.slopeDeltaThresholdPercent : null,
        slopeSource: cfg.slopeSource ?? SOURCE_CONSTANTS,
        slopeEnabled: cfg.slopeEnabled === true,
        dynamicWeightEnabled: cfg.dynamicWeightEnabled === true,
        lookbackBars: cfg.lookbackBars,
        emaAlpha: cfg.emaAlpha,
        slopePersistBars: cfg.slopePersistBars,
        maxSlopePct: cfg.maxSlopePct,
        neutralZonePct: cfg.neutralZonePct,
        maxSlopeOffset: cfg.maxSlopeOffset,
        clipPercentile: cfg.clipPercentile,
        maxAsymmetryFactor: cfg.maxAsymmetryFactor,
        minScaleSlots: cfg.minScaleSlots,
        incrementPercent: cfg.incrementPercent,
        erPeriod: cfg.erPeriod,
        warmupBars: cfg.warmupBars,
        warmupBarsOverride: Number.isFinite(cfg.warmupBarsOverride) ? cfg.warmupBarsOverride : null,
        clampMin: Number.isFinite(cfg.clampMin) ? cfg.clampMin : null,
        clampMax: Number.isFinite(cfg.clampMax) ? cfg.clampMax : null,
        notes: Array.isArray(cfg.notes) ? cfg.notes.slice(0, 4) : [],
    };
}

export { resolveGridResetSimConfig, toGridSimPayload }

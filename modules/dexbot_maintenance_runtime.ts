/** Maintenance runtime - periodic sync loops, grid health checks, rebalance */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);
const require = createRequire(import.meta.url);
import { lazyShim } from './lazy_shim.js';

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { nowIso, fireStructuralResync, resolveLastFillGuardReference } from './order/utils/system.js';
import { path } from './path_api.js';
import * as chainOrders from './chain_orders.js';
import * as grid from './order/grid.js';
import { ORDER_STATES, ORDER_TYPES, TIMING, BTS_PRECISION, NATIVE_CLIENT } from './constants.js';
import { BOT_LIVE_CONFIG_KEYS } from './runtime_settings.js';
import { migrateLegacyOrderKeys } from './bot_defaults.js';
import { acquireIfNotHeld } from './order/async_lock.js';
const { readOpenOrdersGuarded } = chainOrders;
import { PATHS } from './paths.js';
import * as Format from './order/format.js';
import { getStorage } from './storage/index.js';
const storage = getStorage();
const { ensureDir, unlink: safeUnlink } = storage;
import * as fundRegistry from './fund_registry.js';

import * as bitsharesModule from './bitshares_client.js';
const { BitShares } = bitsharesModule;
import { BroadcastUncertainError } from './dexbot_credential_client.js';
import * as configModule from './config.js';
const { Config } = configModule;
import { getErrorMessage } from './utils/errors.js';
import type { BotLike, OrderManagerLike, ManagedOrder, OrderType, SpreadCorrectionStall, BotMetrics } from './types.js';

/** Loose JSON-object view used across the maintenance runtime. */
type JsonObj = Record<string, unknown>;

/** A ranked BTS-acquisition pool candidate. */
interface PoolCandidate {
    asset: { id?: unknown; precision?: number; symbol?: unknown; free?: number; [key: string]: unknown };
    poolId?: unknown;
    sellAmount: number;
    expectedReceive: number;
    priceImpact: number;
    [key: string]: unknown;
}

/** Minimal bot-context surface used by the idle/defer schedulers. */
interface MaintenanceCtx {
    _shuttingDown?: unknown;
    _maintenanceIdleTimer?: unknown;
    _deferredGridResyncTimer?: unknown;
    _incomingFillQueue?: unknown[];
    _lastGridActivityAt?: unknown;
    _runGridMaintenance?: (context: string, options: JsonObj) => Promise<unknown>;
    _warn?: (message: string) => void;
    _performGridResync?: (options: JsonObj) => Promise<unknown>;
    triggerFile?: string;
    manager?: {
        _fillProcessingLock?: { acquire: (fn: () => Promise<void>) => Promise<unknown> };
        _recoveryState?: JsonObj;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/** A stranded/held chain order as seen by the deferred-hold helpers. */
interface HeldChainOrder {
    type?: unknown;
    price?: unknown;
    size?: unknown;
    reason?: unknown;
    chainOrderId?: unknown;
    [key: string]: unknown;
}
import { isSameBotName } from './utils/sanitize_key.js';
import { usesAmaGridPrice } from './grid_price_source.js';
const hasOpenOrdersSyncLoopMsSet = lazyShim('./config', 'hasOpenOrdersSyncLoopMsSet');
const getOpenOrdersSyncLoopMs = lazyShim('./config', 'getOpenOrdersSyncLoopMs');
function isGridBloated(...args: unknown[]) { return (grid.isGridBloated as (...a: unknown[]) => { bloated?: boolean; details?: { gridSize?: number; maxAllowed?: number } })(...args); }
function isGridBloatGraceActive(...args: unknown[]) { return (grid.isGridBloatGraceActive as (...a: unknown[]) => { active?: boolean; graceMs?: number })(...args); }
function clearGridBloatFlag(...args: unknown[]) { return (grid.clearGridBloatFlag as (...a: unknown[]) => unknown)(...args); }
function recalculateGrid(...args: unknown[]) { return (grid.recalculateGrid as (...a: unknown[]) => unknown)(...args); }
const buildRuntimeScriptPath = lazyShim('./launcher/runtime_entry', 'buildRuntimeScriptPath');
const applyGridDivergenceCorrections = lazyShim('./order/utils/system', 'applyGridDivergenceCorrections');
const updateGridFromBlockchainSnapshot = lazyShim('./order/grid', 'updateGridFromBlockchainSnapshot');
const loadAmaCenterSnapshot = lazyShim('./order/utils/system', 'loadAmaCenterSnapshot');
const sleep = lazyShim('./order/utils/system', 'sleep');
const parseJsonWithComments = lazyShim('./order/utils/system', 'parseJsonWithComments');
const isPm2Runtime = lazyShim('./order/logger', 'isPm2Runtime');
const isWrapperAdapterOwner = lazyShim('./launcher/adapter_requirement', 'isWrapperAdapterOwner');
const readAdapterRequirement = lazyShim('./launcher/adapter_requirement', 'readAdapterRequirement');
const getSharedMarketAdapterRuntime = lazyShim('./launcher/market_adapter_runtime', 'getSharedMarketAdapterRuntime');
const resetMarketAdapterWhitelistCache = lazyShim('./market_adapter_whitelist', 'resetMarketAdapterWhitelistCache');
const isBotDynamicWeightWhitelisted = lazyShim('./market_adapter_whitelist', 'isBotDynamicWeightWhitelisted');
function getRuntimeSettingsKeys() { return require('./runtime_settings').RUNTIME_SETTINGS_KEYS; }
const cloneWeightDistribution = lazyShim('./order/utils/math', 'cloneWeightDistribution');
const calculateOrderCreationFees = lazyShim('./order/utils/math', 'calculateOrderCreationFees');
const calculateSwapInAmount = lazyShim('./order/utils/math', 'calculateSwapInAmount');
const floatToBlockchainInt = lazyShim('./order/utils/math', 'floatToBlockchainInt');
const blockchainToFloat = lazyShim('./order/utils/math', 'blockchainToFloat');
const updateDynamicGridSnapshotSync = lazyShim('../market_adapter/utils/dynamic_grid_snapshot', 'updateDynamicGridSnapshotSync');
// Lazy require: dexbot_fill_runtime imports this module, so a static import
// would be circular; at call time both modules are fully loaded.
const scheduleFillConsumerRestartFn = lazyShim('./dexbot_fill_runtime', 'scheduleFillConsumerRestart');
const reconcileGridOrders = lazyShim('./order/grid_reconcile', 'reconcileGridOrders');
const resolveEdgeCount = lazyShim('./order/utils/order', 'resolveEdgeCount');
const edgeOrderIdSet = lazyShim('./order/utils/order', 'edgeOrderIdSet');
const liveWindowIdSet = lazyShim('./order/utils/order', 'liveWindowIdSet');
const resolveLiveEdgeAnchorPrice = lazyShim('./order/utils/order', 'resolveLiveEdgeAnchorPrice');
const formatUnmatchedChainOrder = lazyShim('./order/utils/order', 'formatUnmatchedChainOrder');
const isNonBlockingUnmatchedOrder = lazyShim('./order/utils/order', 'isNonBlockingUnmatchedOrder');
const isStrandedHoldOrder = lazyShim('./order/utils/order', 'isStrandedHoldOrder');
const getSideBudget = lazyShim('./order/utils/order', 'getSideBudget');
function getCoreOrdersTotal(config: unknown) { return require('./order/utils/order').getCoreOrdersTotal(config); }
const correctAllPriceMismatches = lazyShim('./order/utils/order', 'correctAllPriceMismatches');
const isOrderOnChain = lazyShim('./order/utils/order', 'isOrderOnChain');
const parseChainOrder = lazyShim('./order/utils/order', 'parseChainOrder');
const parseSlotIndex = lazyShim('./order/utils/order', 'parseSlotIndex');

const CODE_ROOT = path.join(__dirname, '..');
const PROFILES_DIR = PATHS.PROFILES_DIR;
const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const LOGS_DIR = PATHS.LOGS_DIR;
const MARKET_ADAPTER_APP_NAME = 'dexbot-adapter';
const MARKET_ADAPTER_SCRIPT = buildRuntimeScriptPath(CODE_ROOT, ['market_adapter', 'market_adapter']);
const MARKET_ADAPTER_ERROR_FILE = path.join(LOGS_DIR, 'dexbot-adapter-error.log');
const MARKET_ADAPTER_OUT_FILE = path.join(LOGS_DIR, 'dexbot-adapter.log');
const MARKET_ADAPTER_TRIGGER_SOURCE = 'market_adapter/market_adapter.js';
const MANUAL_TRIGGER_METADATA = {
    shouldRefreshCenterPrice: true,
    centerRefreshContext: 'manual grid resync',
    centerRefreshLabel: 'manual grid reset',
    resetSource: 'manual_grid_resync',
};
const MARKET_ADAPTER_TRIGGER_RESETS = Object.freeze({
    market_adapter_bootstrap: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA bootstrap grid resync',
        centerRefreshLabel: 'AMA bootstrap grid reset',
    },
    market_adapter_ama_slope_delta_threshold: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA slope grid resync',
        centerRefreshLabel: 'AMA slope grid reset',
    },
    market_adapter_delta_threshold: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA center grid resync',
        centerRefreshLabel: 'AMA center grid reset',
    },
});
const GRID_RESYNC_REASONS = Object.freeze({
    ...MARKET_ADAPTER_TRIGGER_RESETS,
    manual_grid_resync: MANUAL_TRIGGER_METADATA,
    rms_structural_grid_resync: {
        shouldRefreshCenterPrice: false,
        centerRefreshContext: 'RMS structural grid resync',
        centerRefreshLabel: 'RMS structural grid resync',
    },
});

/**
 * Check if a bot configuration uses an AMA grid price source.
 *
 * Canonical implementation lives in ./grid_price_source.js (browser-safe,
 * shared with the market adapter service) — re-exported here so existing
 * Node-side consumers keep their import path.
 */

/**
 * Find a bot entry in the bots config snapshot that matches a runtime config.
 * Matches by botKey or name.
 * @param {unknown} snapshot - Bots configuration snapshot
 * @param {Object} config - Runtime bot configuration
 * @returns {Object|null} Matched bot entry or null
 */
function findSnapshotBotForRuntimeConfig(snapshot: { activeBots?: BotLike[] }, config: JsonObj) {
    if (!snapshot || !Array.isArray(snapshot.activeBots) || !config) {
        return null;
    }

    const botKey = config.botKey ? String(config.botKey) : null;
    const name = config.name ? String(config.name) : null;
    return snapshot.activeBots.find((bot: BotLike) => {
        if (!bot) return false;
        if (botKey && String(bot.botKey || '') === botKey) return true;
        if (name && String(bot.name || '') === name) return true;
        return false;
    }) || null;
}

/**
 * Check if a runtime bot configuration requires the market adapter.
 * @param {unknown} snapshot - Bots configuration snapshot
 * @param {Object} config - Runtime bot configuration
 * @returns {boolean} True if the bot uses AMA grid pricing
 */
function runtimeConfigNeedsMarketAdapter(snapshot: { activeBots?: BotLike[] }, config: JsonObj) {
    const snapshotBot = findSnapshotBotForRuntimeConfig(snapshot, config);
    if (snapshotBot) {
        return usesAmaGridPrice(snapshotBot as unknown as Record<string, unknown>);
    }
    return usesAmaGridPrice(config);
}

/**
 * Live bot-config allowlist (BOT_LIVE_CONFIG_KEYS) is defined once in
 * runtime_settings.ts (shared with the `dexbot bot` editor hint) and
 * statically imported above. Everything outside it is hint-only:
 * geometry needs `dexbot reset <bot>`, identity needs a restart.
 */

/**
 * Top-level entry keys excluded from the live bot-config fingerprint.
 * botKey/botIndex are runtime-assigned, accountId is auto-saved next to
 * preferredAccount after the first chain resolution (not a user edit).
 */
const BOT_CONFIG_FINGERPRINT_IGNORED_KEYS = Object.freeze([
    'botKey',
    'botIndex',
    'accountId',
]);

/**
 * Deterministic JSON stringify with recursively sorted object keys.
 * Key order in bots.json must not count as a config change.
 * @param {unknown} value - Value to stringify
 * @returns {string} Stable string representation
 */
function stableStringifyForBotConfig(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
        return `[${value.map((v) => stableStringifyForBotConfig(v)).join(',')}]`;
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).filter((k: string) => obj[k] !== undefined).sort();
        return `{${keys.map((k: string) => `${JSON.stringify(k)}:${stableStringifyForBotConfig(obj[k])}`).join(',')}}`;
    }
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 'null' : serialized;
}

/**
 * Normalize a raw bots.json entry for fingerprinting: drop volatile keys.
 * @param {unknown} entry - Raw bot entry from bots.json
 * @returns {unknown} Normalized plain object ({} when entry is missing)
 */
function normalizeBotEntryForFingerprint(entry: unknown): Record<string, unknown> {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
    const out: Record<string, unknown> = {};
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
        if ((BOT_CONFIG_FINGERPRINT_IGNORED_KEYS as readonly string[]).includes(key)) continue;
        out[key] = e[key];
    }
    // Canonicalize legacy order-count keys so the fingerprint and the merged
    // entry agree with the allowlist (`coreOrders`/`edgeOrders`) even when the
    // on-disk bots.json still carries `activeOrders`/`reserveOrders`.
    return migrateLegacyOrderKeys(out);
}

/**
 * Build the full-entry fingerprint for one bot (stable across key order and
 * comment/whitespace edits, since those never reach the parsed entry).
 * @param {unknown} entry - Raw bot entry from bots.json
 * @returns {string} Fingerprint ('' when entry is missing)
 */
function buildBotConfigFingerprint(entry: unknown): string {
    if (!entry || typeof entry !== 'object') return '';
    return stableStringifyForBotConfig(normalizeBotEntryForFingerprint(entry));
}

/**
 * Plain-data deep clone (bots.json entries are JSON-parsed, always
 * serializable; the fallback only guards exotic test doubles).
 * Single helper replacing the previously triplicated inline clones.
 * @param {unknown} value - Value to clone
 * @returns {unknown} Deep clone (or the original when unserializable)
 */
function cloneJsonValue<T>(value: T): T {
    if (value === undefined) return undefined as T;
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}

/**
 * Merge the given entry keys into the live runtime (bot.config +
 * manager.config) and refresh the derived weight base when included.
 * Shared by the live bot-config check (allowlisted keys) — the full
 * grid-resync path uses replaceBotConfigFromEntryPreservingRuntime below.
 * Synchronous in-memory merge only: no chain I/O, no fill-lock (assignments
 * are atomic; maintenance / targeted-reconcile ticks heal shortfalls/excess).
 * @param {unknown} bot - DEXBot instance
 * @param {unknown} entry - Raw bot entry from bots.json
 * @param {string[]} keys - Entry keys to merge
 * @returns {string[]} Merged key names
 */
function mergeBotConfigKeysIntoRuntime(bot: BotLike, entry: unknown, keys: string[]): string[] {
    const applied: string[] = [];
    if (!bot?.config || !entry || typeof entry !== 'object') return applied;
    const e = migrateLegacyOrderKeys({ ...(entry as Record<string, unknown>) });
    for (const key of keys) {
        // A deleted key applies as null (mirrors the former ?? null diff
        // semantics) so the running config can never keep a stale value.
        // Cloned twice: bot.config and manager.config must never alias the
        // same nested object, or a future in-place mutation of one would
        // silently corrupt the other.
        const cloned = cloneJsonValue(e[key] ?? null);
        bot.config[key] = cloned;
        if (bot.manager?.config) {
            bot.manager.config[key] = cloneJsonValue(e[key] ?? null);
        }
        if (key === 'weightDistribution') {
            bot._baseWeightDistribution = (cloned && typeof cloned === 'object' ? { ...(cloned as JsonObj) } : cloned) as BotLike['_baseWeightDistribution'];
        }
        applied.push(key);
    }
    return applied;
}

/**
 * Full config replace preserving runtime identity (botKey/botIndex) and the
 * constructor-resolved runtime settings (timing, gridLimits, feeParams,
 * etc.). Shared single implementation for performGridResync (previously an
 * inline block duplicating the merge/weights/refresh steps).
 * @param {unknown} bot - DEXBot instance
 * @param {unknown} updatedBot - Raw bot entry from bots.json
 * @param {string} contextLabel - Label for the weights-refresh log context
 */
function replaceBotConfigFromEntryPreservingRuntime(bot: BotLike, updatedBot: unknown, contextLabel: string) {
    const oldKey = bot.config.botKey;
    const oldIndex = bot.config.botIndex;
    const u = migrateLegacyOrderKeys({ ...(updatedBot as Record<string, unknown>) });
    // Preserve runtime-only properties set by the constructor
    // (timing, gridLimits, feeParams, etc.) that are not present
    // in the raw profile from bots.json.
    const runtimeProps: Record<string, unknown> = {};
    for (const key of getRuntimeSettingsKeys()) {
        if (bot.config[key] !== undefined) {
            runtimeProps[key] = bot.config[key];
        }
    }
    bot._log(`Reloaded configuration for bot '${bot.config.name}'`);
    bot.config = { ...u, botKey: oldKey, botIndex: oldIndex, ...runtimeProps } as BotLike['config'];
    if (bot.manager?.config) {
        bot.manager.config = { ...bot.manager.config, ...bot.config };
    }
    // bot.config is a new object now: re-point the credit runtime (its getter
    // reads this.config) so the resync path can't leave it on the stale copy.
    // The live-merge path mutates in place and never needs this.
    if (bot._creditRuntime) {
        bot._creditRuntime.config = bot.config;
    }
    bot._baseWeightDistribution = cloneWeightDistribution(
        u.weightDistribution,
        bot._baseWeightDistribution
    );
    refreshDynamicWeightDistribution(bot, contextLabel);
}

/**
 * Structural gate for live debtPolicy merges (mirrors the credit runtime's
 * isEnabled gate plus the startup validator's required string fields in
 * bot_settings.ts). Full numeric validation stays where it belongs:
 * the `dexbot bot` editor at save time and per-offer at runtime.
 * null/undefined (policy removal) is safe — it takes the disable path.
 * @param {unknown} value - New debtPolicy value from bots.json
 * @returns {boolean} True when safe to merge live
 */
function isDebtPolicyLiveApplySafe(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const lending = (value as { lending?: unknown }).lending;
    if (!Array.isArray(lending) || lending.length === 0) return false;
    return lending.every((item: unknown) => {
        if (!item || typeof item !== 'object') return false;
        const it = item as { type?: unknown; asset?: unknown; collateralAsset?: unknown };
        return typeof it.type === 'string' && it.type.length > 0
            && typeof it.asset === 'string' && it.asset.length > 0
            && typeof it.collateralAsset === 'string' && it.collateralAsset.length > 0;
    });
}

/**
 * Reconcile the credit runtime after a live debtPolicy merge: (re)create +
 * load state when newly enabled, rebind the watchdog interval to the
 * current runtime, stop the interval when disabled. loadState is a no-op on
 * an already-loaded runtime and both maintenance entry points bail while
 * disabled or in-flight, so this is safe on any tick (bot-level seams
 * guarded for stripped test doubles).
 * @param {unknown} bot - DEXBot instance
 */
async function reconcileCreditRuntimeAfterPolicyChange(bot: BotLike) {
    try {
        if (typeof bot._setupCreditRuntime === 'function') {
            await bot._setupCreditRuntime();
        }
    } catch (err) {
        bot._warn?.(`Credit runtime setup failed after debtPolicy change: ${getErrorMessage(err)}`);
        return;
    }
    try {
        if (bot._creditRuntime) {
            if (typeof bot._setupCreditWatchdogInterval === 'function') {
                bot._setupCreditWatchdogInterval();
            }
        } else if (typeof bot._stopCreditWatchdogInterval === 'function') {
            bot._stopCreditWatchdogInterval();
        }
    } catch (err) {
        bot._warn?.(`Credit watchdog reconcile failed after debtPolicy change: ${getErrorMessage(err)}`);
    }
}

/**
 * Diff two normalized entries in a single pass over the key union.
 * Replaces the former twin-loop diffLiveBotConfig +
 * detectNonLiveBotConfigChanges pair.
 * @param {unknown} oldNormalized - Previously seen normalized entry
 * @param {unknown} newNormalized - New normalized entry
 * @returns {{liveChanges: Array<{key: string, oldValue: any, newValue: any}>, otherKeys: string[]}} Split changes
 */
function diffBotConfigEntries(oldNormalized: unknown, newNormalized: unknown): {
    liveChanges: Array<{ key: string; oldValue: unknown; newValue: unknown }>;
    otherKeys: string[];
} {
    const prev = (oldNormalized && typeof oldNormalized === 'object' ? oldNormalized : {}) as Record<string, unknown>;
    const next = (newNormalized && typeof newNormalized === 'object' ? newNormalized : {}) as Record<string, unknown>;
    const liveChanges: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
    const otherKeys: string[] = [];
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        const before = stableStringifyForBotConfig(prev[key] ?? null);
        const after = stableStringifyForBotConfig(next[key] ?? null);
        if (before === after) continue;
        if ((BOT_LIVE_CONFIG_KEYS as readonly string[]).includes(key)) {
            liveChanges.push({ key, oldValue: prev[key] ?? null, newValue: next[key] ?? null });
        } else {
            otherKeys.push(key);
        }
    }
    return { liveChanges, otherKeys };
}

/**
 * Check bots.json for this bot's entry and live-apply allowlisted keys
 * (BOT_LIVE_CONFIG_KEYS; debtPolicy additionally reconciles the credit
 * runtime, malformed debtPolicy is hinted instead of merged).
 * Best-effort and idempotent: synchronous in-memory merge only, no chain
 * I/O, no fill-lock (assignments are atomic; the existing maintenance /
 * targeted-reconcile ticks heal shortfalls/excess on the next cycle).
 * Geometry changes are NOT applied (need `dexbot reset <bot>`), identity
 * changes are NOT applied (need restart) — on the steady-state path both
 * produce a one-time hint per fingerprint (the fingerprint advances past
 * hinted keys, malformed debtPolicy included, so a persistently-broken file
 * warns once until the file changes again). The first-check baseline only
 * converges the race-safe keys and stays silent on the rest: a geometry
 * edit landing in the process-load → first-tick window is absorbed into
 * the baseline with no hint. Corrupt/unreadable files and missing entries
 * never touch the stored fingerprint (except the missing-entry hint
 * throttle) so the next tick re-evaluates.
 * @param {unknown} bot - DEXBot instance
 * @param {string} [context='bots-config poll'] - Context label for logging
 * @param {unknown} [preloadedSnapshot=null] - Reuse an already-loaded snapshot
 * @returns {Promise<any>} Result with applied/liveChanges/otherKeys or skipped
 */
async function checkAndApplyBotConfigChanges(bot: BotLike, context: string = 'bots-config poll', preloadedSnapshot: JsonObj | null = null): Promise<unknown> {
    try {
        if (!bot || !bot.config) {
            return { skipped: true, reason: 'missing-config' };
        }
        const snapshot = preloadedSnapshot
            ?? (typeof bot._loadBotsConfigSnapshot === 'function'
                ? await bot._loadBotsConfigSnapshot()
                : loadBotsConfigSnapshot());
        if (!snapshot || snapshot.corrupt || snapshot.readError) {
            return {
                skipped: true,
                reason: snapshot?.corrupt ? 'corrupt-config' : snapshot?.readError ? 'unreadable-config' : 'missing-snapshot',
            };
        }
        const entry = findSnapshotBotForRuntimeConfig(snapshot, bot.config);
        const botName = String(bot.config?.name || bot.config?.botKey || 'bot');
        if (!entry) {
            const missingMarker = `missing:${String(bot.config?.botKey || bot.config?.name || '')}`;
            if (bot._lastBotConfigHintFingerprint !== missingMarker) {
                bot._lastBotConfigHintFingerprint = missingMarker;
                bot._warn?.(
                    `bots.json no longer contains an active entry for '${botName}' during ${context}; ` +
                    `roster changes need a stop/start.`
                );
            }
            return { skipped: true, reason: 'bot-not-found' };
        }
        const normalized = normalizeBotEntryForFingerprint(entry);
        const fingerprint = stableStringifyForBotConfig(normalized);
        if (bot._appliedBotConfigFingerprint === null || bot._appliedBotConfigFingerprint === undefined) {
            bot._appliedBotConfigFingerprint = fingerprint;
            bot._appliedBotConfigEntry = normalized;
            // Startup race: the file may have changed between process config
            // load and this first check. Converge the race-safe keys so the
            // running bot can never sit on a value the file no longer
            // contains. weightDistribution is excluded —
            // refreshDynamicWeightDistribution owns the live value at runtime.
            const racePrev: Record<string, unknown> = {};
            for (const key of (BOT_LIVE_CONFIG_KEYS as readonly string[])) {
                if (key === 'weightDistribution') continue;
                racePrev[key] = bot.config?.[key];
            }
            const raceDiff = diffBotConfigEntries(racePrev, normalized);
            // Same invariant as the steady-state path: a malformed debtPolicy
            // never reaches the runtime (warn once; the next save re-evaluates).
            const raceLive = raceDiff.liveChanges.filter((c) =>
                c.key !== 'debtPolicy' || isDebtPolicyLiveApplySafe(c.newValue));
            if (raceLive.length !== raceDiff.liveChanges.length) {
                bot._warn?.(
                    `bots.json debtPolicy for '${botName}' failed validation at startup check; ` +
                    `keeping startup policy — fix the shape or run 'dexbot reset ${botName}'.`
                );
            }
            const raceApplied = mergeBotConfigKeysIntoRuntime(bot, entry, raceLive.map((c) => c.key));
            if (raceApplied.includes('debtPolicy')) {
                await reconcileCreditRuntimeAfterPolicyChange(bot);
            }
            if (raceApplied.length > 0) {
                bot._log?.(
                    `Picked up bots.json changes for '${botName}' at startup check (no restart needed): ${raceApplied.join(', ')}.`,
                    'info'
                );
            }
            return { applied: raceApplied.length > 0, reason: 'baseline', fingerprint, liveChanges: raceApplied };
        }
        if (fingerprint === bot._appliedBotConfigFingerprint) {
            return { applied: false, reason: 'unchanged', fingerprint };
        }
        const { liveChanges: rawLiveChanges, otherKeys: rawOtherKeys } = diffBotConfigEntries(bot._appliedBotConfigEntry, normalized);
        // Malformed debtPolicy never reaches the runtime: hint reset/restart
        // instead of merging garbage the credit cycle would choke on.
        const liveChanges = rawLiveChanges.filter((c) =>
            c.key !== 'debtPolicy' || isDebtPolicyLiveApplySafe(c.newValue));
        const otherKeys = [...rawOtherKeys];
        for (const c of rawLiveChanges) {
            if (c.key === 'debtPolicy' && !isDebtPolicyLiveApplySafe(c.newValue) && !otherKeys.includes('debtPolicy')) {
                otherKeys.push('debtPolicy');
            }
        }
        const appliedKeys = mergeBotConfigKeysIntoRuntime(bot, entry, liveChanges.map((c) => c.key));
        if (appliedKeys.includes('debtPolicy')) {
            await reconcileCreditRuntimeAfterPolicyChange(bot);
        }
        if (appliedKeys.includes('weightDistribution')) {
            // Same as the resync path: the file value is the base, the live
            // effective weights (when whitelisted/ready) take precedence in
            // bot/manager config immediately instead of next tick.
            refreshDynamicWeightDistribution(bot, context);
        }
        bot._appliedBotConfigFingerprint = fingerprint;
        bot._appliedBotConfigEntry = normalized;
        if (liveChanges.length > 0) {
            const summary = liveChanges
                .map((c) => `${c.key} ${stableStringifyForBotConfig(c.oldValue)}->${stableStringifyForBotConfig(c.newValue)}`)
                .join('; ');
            bot._log?.(
                `Applied bots.json changes for '${botName}' live during ${context} (no restart needed): ${summary}. ` +
                `Targeted maintenance will place missing / cancel excess orders.`,
                'info'
            );
            // Deliver the promise above instead of waiting for the next fill
            // or the 240-min fetch: run the targeted drift reconciliation
            // right away (same fire-and-forget shape as the poll tick). The
            // callee owns the cooldown; the periodic call site additionally
            // gates on an empty pipeline, which this config-pickup path does
            // not — it retries on the next maintenance tick either way.
            try {
                const driftRun = maybeRunTargetedDriftReconciliation(bot, `${context} config pickup`);
                driftRun?.catch?.((err: unknown) => {
                    bot._log?.(`[TARGETED-SYNC] Config-pickup reconciliation failed: ${getErrorMessage(err)}`, 'debug');
                });
            } catch { /* never break the poll tick */ }
        }
        if (otherKeys.length > 0) {
            const shown = otherKeys.slice(0, 8).join(', ');
            const suffix = otherKeys.length > 8 ? ` (+${otherKeys.length - 8} more)` : '';
            bot._warn?.(
                `bots.json changed ${shown}${suffix} for '${botName}' during ${context}; ` +
                `these were NOT applied live — run 'dexbot reset ${botName}' for grid geometry ` +
                `or restart for market/account identity.`
            );
        }
        if (liveChanges.length === 0 && otherKeys.length === 0) {
            bot._log?.(
                `Detected bots.json bookkeeping change for '${botName}' during ${context}; no tradable setting changed.`,
                'debug'
            );
        }
        return { applied: liveChanges.length > 0, liveChanges: liveChanges.map((c) => c.key), otherKeys, fingerprint };
    } catch (err) {
        try {
            bot?._warn?.(`Bot-config live check failed during ${context}: ${getErrorMessage(err)}`);
        } catch { /* logging must never break the tick */ }
        return { skipped: true, reason: 'error', error: getErrorMessage(err) };
    }
}

function countLiveGridOrders(manager: OrderManagerLike, type: unknown) {
    if (!manager) return 0;
    const active = manager.getOrdersByTypeAndState?.(type as OrderType | null | undefined, ORDER_STATES.ACTIVE) || [];
    const partial = manager.getOrdersByTypeAndState?.(type as OrderType | null | undefined, ORDER_STATES.PARTIAL) || [];
    // Slot-N gated: fork-kept shelf/manual orders (non-slot-N ids, e.g.
    // deep-*) sit outside window accounting — same gate as edge
    // classification and startup cancel candidates (issue #27 follow-up).
    // Without this, a live shelf inflates the live window+edges count and
    // masks a real window/edge shortfall, so targeted sync never fires.
    // No-op on grids that only mint slot-N ids.
    return active.concat(partial).filter((o) => o?.orderId && parseSlotIndex(o?.id) !== null).length;
}

function getTargetCoreOrders(config: JsonObj, side: unknown) {
    const configured = Number((config?.coreOrders as JsonObj | undefined)?.[side as string]);
    // Edge ladder rests live on-chain: countLiveGridOrders sees window +
    // edge orders, so the shortfall target must include edge orders too —
    // otherwise live edge orders mask window shortfalls and a filled/cancelled
    // edge order never triggers targeted reconciliation.
    const edgeCount = resolveEdgeCount(config, side);
    return Math.max(0, Number.isFinite(configured) ? configured : 1) + edgeCount;
}

/**
 * Count live on-chain edge orders for one side (issue #27 follow-up).
 *
 * The window shortfall check above compares live window+edges against
 * window+edges, so a pre-existing window surplus masks an edge deficit
 * (e.g. target 6+2=8 vs 12 live after edgeOrders 0→2: no shortfall, no
 * sync, zero edge placements). Edge orders get their own independent reason
 * below — the mirror of the masking case getTargetCoreOrders handles.
 *
 * Classification reuses the single source of truth (edgeOrderIdSet +
 * resolveLiveEdgeAnchorPrice, same anchor the placement pickers use)
 * over the full master grid, intersected with live ACTIVE/PARTIAL orderIds
 * (same live definition as countLiveGridOrders). The edge pick excludes the
 * window (liveWindowIdSet — the same exclusion every placement picker
 * applies): window + edge are additive in targets/fees/hold-back, but
 * without the exclusion a window that reaches the grid edge (keep-low
 * window = bottom slots = floor edge) makes the edge pick land on window
 * members and the count reads N/N with zero dedicated edge orders, so the
 * deficit never fires (issue #27 follow-up).
 * @param {unknown} manager - OrderManager
 * @param {unknown} config - Bot configuration (edge count source)
 * @param {unknown} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @returns {number|null} Live edge count, or null when unclassifiable
 */
function countLiveEdgeOrders(manager: OrderManagerLike, config: JsonObj, type: unknown): number | null {
    try {
        const side = type === ORDER_TYPES.SELL ? 'sell' : 'buy';
        const required = resolveEdgeCount(config, side);
        if (!(required > 0)) return 0;
        if (!manager) return null;
        // Full master grid only: classifying from live-only indexed lookups
        // would pick the "edge" of the live subset, not the grid edge, and
        // mis-fire on stripped test doubles. Fail closed (null) without it.
        if (!manager.orders || typeof manager.orders.values !== 'function') return null;
        const allSlots: ManagedOrder[] = Array.from(manager.orders.values());
        if (allSlots.length === 0) return null;
        const anchor = resolveLiveEdgeAnchorPrice(manager, side);
        // Fail open on unknown window geometry (null): without a boundary the
        // pickers cannot place edge orders either, so keep the previous
        // (exclusion-free) classification instead of guessing.
        const windowIds = liveWindowIdSet(manager, type);
        const edgeIds = edgeOrderIdSet(allSlots, config, type, anchor, windowIds);
        if (!edgeIds || edgeIds.size === 0) return 0;
        const liveIds = new Set<string>();
        if (typeof manager.getOrdersByTypeAndState === 'function') {
            for (const state of [ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL]) {
                for (const o of manager.getOrdersByTypeAndState(type as OrderType | null | undefined, state) || []) {
                    if (o?.id != null && o?.orderId) liveIds.add(String(o.id));
                }
            }
        } else {
            for (const s of allSlots) {
                if (s?.id != null && s?.orderId) liveIds.add(String(s.id));
            }
        }
        let live = 0;
        for (const id of edgeIds) {
            if (liveIds.has(String(id))) live++;
        }
        return live;
    } catch { return null; }
}

function _hasBudgetForSide(manager: OrderManagerLike, config: JsonObj, side: unknown) {
    try {
        const funds = manager?.getChainFundsSnapshot?.();
        if (!funds) return true;
        const allocated = side === 'buy' ? (funds.allocatedBuy || 0) : (funds.allocatedSell || 0);
        if (allocated <= 0) return false;
        const totalTarget = getCoreOrdersTotal(config);
        const budget = getSideBudget(side, funds, config, totalTarget);
        return budget > 0;
    } catch { return true; }
}

/**
 * Mirror a spread-check stall into the flags the targeted-sync gate reads.
 *
 * ANY stall — fund, batch, or structural — arms the refresh. When the
 * correction cannot act on the local snapshot, that snapshot may simply be
 * stale relative to the chain: a missed fill leaves an ACTIVE slot occupying
 * the window edge, so `isSlotAvailable` hides every tightening slot and the
 * check reports 'no-candidates' even though real geometry exists. A refresh is
 * the only way to tell a genuinely structural stall from a stale one, so we
 * sync rather than wait for the out-of-spread staleness watchdog to re-center.
 * The stall cause is kept alongside the flag so the log states the truth.
 * Exported for tests.
 * @param {BotLike} bot
 * @param {SpreadCorrectionStall|null|undefined} stall
 */
export function mirrorSpreadStall(bot: BotLike, stall: SpreadCorrectionStall | null | undefined) {
    bot._spreadCorrectionStall = stall ?? null;
    bot._spreadStallArmed = stall != null;
}

function getTargetedSyncReason(bot: BotLike) {
    if (!bot.manager || bot.config?.dryRun) return null;

    const targetBuy = getTargetCoreOrders(bot.config, 'buy');
    const targetSell = getTargetCoreOrders(bot.config, 'sell');
    const liveBuy = countLiveGridOrders(bot.manager, ORDER_TYPES.BUY);
    const liveSell = countLiveGridOrders(bot.manager, ORDER_TYPES.SELL);
    const shortfalls: string[] = [];

    if (liveBuy < targetBuy) {
        if (_hasBudgetForSide(bot.manager, bot.config, 'buy')) {
            shortfalls.push(`buy ${liveBuy}/${targetBuy}`);
        }
    }
    if (liveSell < targetSell) {
        if (_hasBudgetForSide(bot.manager, bot.config, 'sell')) {
            shortfalls.push(`sell ${liveSell}/${targetSell}`);
        }
    }

    // Edge deficit is independent of window surplus: a bot carrying extra
    // rail/stranded orders can sit above target while its edge order is
    // empty (live-applied edgeOrders 0→N, filled/cancelled edge order).
    // Without this, placement waits for fills or the 4h fetch (issue #27).
    for (const [type, side] of [[ORDER_TYPES.BUY, 'buy'], [ORDER_TYPES.SELL, 'sell']] as const) {
        const required = resolveEdgeCount(bot.config, side);
        if (!(required > 0)) continue;
        const liveEdges = countLiveEdgeOrders(bot.manager, bot.config, type);
        if (liveEdges !== null && liveEdges < required) {
            if (_hasBudgetForSide(bot.manager, bot.config, side)) {
                shortfalls.push(`${side} edges ${liveEdges}/${required}`);
            }
        }
    }

    const drift = bot.manager.checkFundDriftAfterFills?.();
    if (drift && drift.isValid === false) {
        return { reason: `fund drift: ${drift.reason}`, targetBuy, targetSell, liveBuy, liveSell, drift };
    }

    // Spread correction placed no effective order for ANY cause. The local
    // snapshot the check reasoned over may be stale relative to the chain —
    // balances/holds can be a stale read (the grid does not lose funds, it
    // holds them in resting/virtual slots), and a missed fill can leave an
    // ACTIVE slot occupying the window edge so no tightening slot appears to
    // exist ('no-candidates'). Only a chain sync can tell a genuinely
    // structural stall from a stale one, so arm the refresh for every cause
    // instead of waiting up to SPREAD_STALE_ESCALATE_MS for the watchdog.
    // Never recycle resting inventory.
    if (bot._spreadStallArmed === true) {
        const cause = bot._spreadCorrectionStall || 'funds-exhausted';
        return { reason: `spread correction stalled (${cause})`, targetBuy, targetSell, liveBuy, liveSell, drift };
    }

    if (shortfalls.length > 0) {
        return { reason: `active order shortfall: ${shortfalls.join(', ')}`, targetBuy, targetSell, liveBuy, liveSell, drift };
    }

    return null;
}

async function maybeRunTargetedDriftReconciliation(bot: BotLike, context: string) {
    const trigger = getTargetedSyncReason(bot);
    if (!trigger) return false;

    const now = Date.now();
    const cooldownMs = Number.isFinite(Number(bot._targetedDriftSyncCooldownMs))
        ? Number(bot._targetedDriftSyncCooldownMs)
        : TIMING.TARGETED_DRIFT_SYNC_COOLDOWN_MS;
    const lastSyncAt = Number(bot._lastTargetedDriftSyncAt || 0);
    if (lastSyncAt > 0 && now - lastSyncAt < cooldownMs) {
        bot._log(
            `[TARGETED-SYNC] Deferring ${context} reconciliation for ${Math.ceil((cooldownMs - (now - lastSyncAt)) / TIMING.MILLISECONDS_PER_SECOND)}s: ${trigger.reason}`,
            'debug'
        );
        return false;
    }

    if (!bot.accountId || typeof chainOrders.readOpenOrders !== 'function') {
        bot._warn(`[TARGETED-SYNC] Cannot reconcile ${context}: missing account id or readOpenOrders`);
        return false;
    }

    bot._log(`[TARGETED-SYNC] Fetching open orders during ${context}: ${trigger.reason}`, 'warn');

    try {
        await bot.manager.fetchAccountTotals?.(bot.accountId);
        const { syncResult, openOrders, aborted } = await bot._syncOpenOrdersAndProcessFills(`targeted ${context} reconciliation`);
        if (aborted) {
            bot._warn(`[TARGETED-SYNC] Chain sync failed during ${context}, skipping reconciliation`);
            return false;
        }

        // The point of a funds-exhausted trigger is the REFRESH itself: it
        // exists to correct a stale balance/reservation read, not to force a
        // reconcile. Clear the flag now so the re-check below (and the next
        // tick's gate) treats "funds appeared after the refresh" as resolved and
        // only reconciles on a still-concrete signal — fund drift or a counted
        // order shortfall. The spread check later this tick re-derives the flag
        // from fresh state, so a genuinely empty balance re-arms it for the next
        // tick (subject to the cooldown below).
        if (bot._spreadStallArmed === true) bot._spreadStallArmed = false;
        // Clear the companion cause with the flag so the two never drift apart
        // (a leftover cause would mislabel the next tick's reason).
        bot._spreadCorrectionStall = null;

        const remaining = getTargetedSyncReason(bot);
        const unmatchedCount = Number(syncResult?.unmatchedChainOrders?.length || 0);
        if (remaining || unmatchedCount > 0) {
            bot._log(
                `[TARGETED-SYNC] Running startup-style reconcile during ${context}: ` +
                `${remaining ? remaining.reason : `${unmatchedCount} unmatched chain order(s)`}`,
                'warn'
            );
            const reconcileResult = await reconcileGridOrders({
                manager: bot.manager,
                config: bot.config,
                account: bot.account,
                privateKey: bot.privateKey,
                chainOrders,
                chainOpenOrders: openOrders,
            });
            await bot._executeBatchIfNeeded(reconcileResult, `targeted ${context} reconcile`);
        }

        // Advance cooldown only after the sync (and optional reconcile) succeeds.
        // Previously this was set before the work, which meant a network blip
        // would lock out the next drift for the full cooldown even though no
        // useful work happened. With post-sync stamping, transient failures
        // retry on the next maintenance tick.
        bot._lastTargetedDriftSyncAt = Date.now();
        await bot.manager.persistGrid?.();
        return true;
    } catch (err) {
        bot._warn(`[TARGETED-SYNC] Failed during ${context}: ${getErrorMessage(err)}`);
        return false;
    }
}

/**
 * Load and fingerprint the bots.json configuration file.
 * Delegates to the canonical launcher/adapter_requirement helper so the
 * fingerprint is semantic (AMA-relevant changes only) and identical to the
 * unlock wrapper watchdog's view of the same file.
 * @returns {unknown} Snapshot with exists flag, fingerprint, active bots list, and adapter requirement
 */
function loadBotsConfigSnapshot() {
    return readAdapterRequirement(PROFILES_BOTS_FILE);
}

/**
 * Parse PM2 jlist command output to extract process names.
 * @param {string} stdout - Raw stdout from pm2 jlist
 * @returns {string[]} Array of process names
 * @throws {Error} If output cannot be parsed
 */
function parsePm2JlistOutput(stdout: string) {
    const output = String(stdout || '').trim();
    if (!output) return [];

    const jsonStart = output.indexOf('[');
    if (jsonStart === -1) {
        throw new Error('pm2 jlist output did not contain JSON');
    }

    const parsed = JSON.parse(output.slice(jsonStart));
    if (!Array.isArray(parsed)) {
        throw new Error('pm2 jlist output was not an array');
    }

    return parsed.map((proc) => String(proc?.name || '')).filter(Boolean);
}

/**
 * Run a PM2 CLI command and return stdout/stderr.
 * @param {string[]} args - PM2 command arguments
 * @returns {Promise<{stdout: string, stderr: string}>} Command output
 * @throws {Error} If the command exits with non-zero code
 */
function runPm2Command(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('pm2', args, {
            stdio: 'pipe',
            shell: Config.PLATFORM === 'win32',
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        child.on('close', (code: number) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new Error(stderr || stdout || `pm2 exited with code ${code}`));
        });

        child.on('error', reject);
    });
}

/**
 * Get list of running PM2 process names.
 * @returns {Promise<string[]>} Array of process names
 */
async function getPm2ProcessNames() {
    const { stdout } = await runPm2Command(['jlist']);
    return parsePm2JlistOutput(stdout);
}

/**
 * Start the market adapter process under PM2.
 * @returns {Promise<void>}
 */
async function startMarketAdapterPm2() {
    if (!storage.exists(LOGS_DIR)) {
        ensureDir(LOGS_DIR);
    }

    const pm2Args = [
        'start',
        MARKET_ADAPTER_SCRIPT,
    ];
    pm2Args.push(
        '--name',
        MARKET_ADAPTER_APP_NAME,
        '--cwd',
        PATHS.PROJECT_ROOT,
        '--output',
        MARKET_ADAPTER_OUT_FILE,
        '--error',
        MARKET_ADAPTER_ERROR_FILE,
        '--max-memory-restart',
        '150M',
        '--log-date-format',
        'YY-MM-DD HH:mm:ss.SSS',
    );
    await runPm2Command(pm2Args);
}

/**
 * Stop and delete the market adapter process from PM2.
 * @returns {Promise<void>}
 */
async function stopMarketAdapterPm2() {
    await runPm2Command(['delete', MARKET_ADAPTER_APP_NAME]);
}

/**
 * Synchronize market adapter state based on periodic config checks.
 * Starts or stops the market adapter based on whether any active bot uses AMA grid pricing.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} [context='periodic'] - Context label for logging
 * @returns {Promise<any>}
 */
async function syncMarketAdapterOnPeriodicConfigCheck(bot: BotLike, context: string = 'periodic') {
    // Test seam: compiled ESM exports cannot be monkey-patched.
    if (typeof bot._syncMarketAdapterHook === 'function') {
        return await bot._syncMarketAdapterHook(context);
    }
    // Single bots.json read shared by the live bot-config check and the
    // adapter drive below (one read per tick, not two). Throwing reads
    // (transient I/O) behave like corrupt: skip everything, keep stored
    // fingerprints, retry next tick.
    let snapshot: JsonObj | null = null;
    try {
        snapshot = (typeof bot._loadBotsConfigSnapshot === 'function'
            ? await bot._loadBotsConfigSnapshot()
            : loadBotsConfigSnapshot()) as JsonObj;
    } catch (err) {
        bot._warn(`Ignoring unreadable bots.json during ${context}; keeping previous market adapter state.`);
        return { skipped: true, reason: 'unreadable-config' };
    }
    // Live bot-config check runs on EVERY path (including wrapper-owned):
    // no adapter driving, best-effort. It live-applies allowlisted keys
    // (BOT_LIVE_CONFIG_KEYS) and hints
    // reset/restart for everything else (Issue #27 follow-up).
    try {
        await checkAndApplyBotConfigChanges(bot, context, snapshot);
    } catch { /* checkAndApply never throws; belt-and-suspenders */ }
    // Centralized ownership: in monolithic mode the unlock wrapper watchdog
    // (shared 1min tick) is the sole market-adapter spawner. A per-bot drive here would
    // re-drive the adapter N times (once per bot) and fight the wrapper over
    // the adapter child, so bots skip the adapter drive entirely and act as
    // pure adapter-output consumers. The live bot-config check above still
    // ran. Wrapper-less modes (the one-shot runner, isolated supervisor,
    // PM2) keep the in-bot fallback below.
    if (!isPm2Runtime() && isWrapperAdapterOwner()) {
        return { skipped: true, reason: 'wrapper-owned' };
    }
    if (bot._marketAdapterWatchdogInFlight) {
        return { skipped: true, reason: 'in-flight' };
    }

    bot._marketAdapterWatchdogInFlight = true;

    try {
        // Corrupt/unreadable bots.json must not move the adapter: previously
        // the parse/read throw aborted the check and left the adapter alone.
        // Keep that behavior by skipping the sync without touching the stored
        // fingerprint, so the next tick re-evaluates once the file is valid.
        if (snapshot.corrupt || snapshot.readError) {
            const reason = snapshot.corrupt ? 'corrupt-config' : 'unreadable-config';
            const detail = snapshot.corrupt ? 'corrupt' : 'unreadable';
            bot._warn(`Ignoring ${detail} bots.json during ${context}; keeping previous market adapter state.`);
            return { skipped: true, reason };
        }
        // ?? (not ||): the semantic fingerprint is legitimately '' when no
        // active AMA bot exists, and '' must compare equal to a stored ''.
        const previousFingerprint = bot._marketAdapterWatchdogFingerprint ?? null;
        const fingerprint = snapshot.fingerprint as string | null;
        const changed = fingerprint !== previousFingerprint;
        bot._marketAdapterWatchdogFingerprint = fingerprint;

        if (changed) {
            bot._log(`Detected bots.json changes during ${context}; re-evaluating market adapter requirements.`);
        }

        if (!isPm2Runtime()) {
            const runtime = getSharedMarketAdapterRuntime({ root: PATHS.PROJECT_ROOT });
            const botId = String(bot.config?.botKey || bot.config?.name || bot.config?.preferredAccount || bot.config?.assetA || 'dexbot');
            const botNeedsMarketAdapter = !!snapshot.exists && runtimeConfigNeedsMarketAdapter(snapshot, bot.config);
            const required = !!snapshot.needsMarketAdapter || botNeedsMarketAdapter;
            const result = await runtime.syncBot(botId, botNeedsMarketAdapter);

            if (!snapshot.exists || !required) {
                if (result?.stopped) {
                    bot._log(`Stopped ${MARKET_ADAPTER_APP_NAME} because no AMA grid bots are active.`, 'info');
                }
                return {
                    changed,
                    required: false,
                    running: !!result?.running,
                    started: false,
                    stopped: !!result?.stopped,
                    mode: 'direct',
                };
            }

            if (result?.started) {
                bot._log(`Started ${MARKET_ADAPTER_APP_NAME} because AMA grid pricing is active.`, 'info');
            }

            return {
                changed,
                required,
                running: !!result?.running,
                started: !!result?.started,
                stopped: false,
                mode: 'direct',
            };
        }

        const getPm2ProcessNamesFn = typeof bot._getPm2ProcessNames === 'function'
            ? bot._getPm2ProcessNames.bind(bot)
            : getPm2ProcessNames;
        const startMarketAdapterFn = typeof bot._startMarketAdapterPm2 === 'function'
            ? bot._startMarketAdapterPm2.bind(bot)
            : startMarketAdapterPm2;
        const stopMarketAdapterFn = typeof bot._stopMarketAdapterPm2 === 'function'
            ? bot._stopMarketAdapterPm2.bind(bot)
            : stopMarketAdapterPm2;

        let processNames: string[] = [];
        let pm2QueryFailed = false;
        try {
            processNames = await getPm2ProcessNamesFn();
        } catch (err) {
            pm2QueryFailed = true;
            bot._warn(`Could not query PM2 for ${MARKET_ADAPTER_APP_NAME}: ${getErrorMessage(err)}. Using a direct PM2 action.`);
        }

        // Cross-reference config-active bots against actually running PM2 processes
        // so we don't start the adapter for configured AMA bots that aren't running.
        const activeBots = (snapshot.activeBots ?? []) as Array<{ name?: unknown }>;
        const runningActiveBots = pm2QueryFailed
            ? activeBots
            : activeBots.filter((b) => processNames.includes(String(b.name)));
        const needsAdapterForRunningBots = runningActiveBots.some(usesAmaGridPrice);

        if (!snapshot.exists || !needsAdapterForRunningBots) {
            const shouldStop = pm2QueryFailed || processNames.includes(MARKET_ADAPTER_APP_NAME);
            if (!shouldStop) {
                return {
                    changed,
                    required: false,
                    running: false,
                    started: false,
                    stopped: false,
                    mode: 'pm2',
                };
            }

            await stopMarketAdapterFn();
            bot._log(`Stopped ${MARKET_ADAPTER_APP_NAME} because no AMA grid bots are running.`, 'info');
            return {
                changed,
                required: false,
                running: false,
                started: false,
                stopped: true,
                mode: 'pm2',
            };
        }

        if (processNames.includes(MARKET_ADAPTER_APP_NAME)) {
            return {
                changed,
                required: true,
                running: true,
                started: false,
                stopped: false,
                mode: 'pm2',
            };
        }

        await startMarketAdapterFn();
        bot._log(`Started ${MARKET_ADAPTER_APP_NAME} because AMA grid pricing is active.`, 'info');

        return {
            changed,
            required: true,
            running: false,
            started: true,
            stopped: false,
            mode: 'pm2',
        };
    } catch (err) {
        bot._warn(`Market adapter watchdog failed during ${context}: ${getErrorMessage(err)}`);
        return {
            changed: false,
            required: false,
            running: false,
            started: false,
            stopped: false,
            error: getErrorMessage(err),
        };
    } finally {
        bot._marketAdapterWatchdogInFlight = false;
    }
}

/**
 * Refresh the dynamic weight distribution from the AMA center snapshot.
 * Applies live dynamic weights if the bot is whitelisted and weights are ready.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} [context='runtime'] - Context label for logging
 * @returns {unknown}
 */
function refreshDynamicWeightDistribution(bot: BotLike, context: string = 'runtime') {
    const baseWeights = cloneWeightDistribution(
        bot._baseWeightDistribution,
        bot.config?.weightDistribution || bot.manager?.config?.weightDistribution
    );

    if (!bot.config || !bot.manager || !bot.config.botKey || !baseWeights) {
        return {
            applied: false,
            source: 'static',
            weightDistribution: baseWeights,
        };
    }

    const botKey = bot.config.botKey;
    let nextWeights = baseWeights;
    let source = 'static';
    let snapshot: JsonObj | null = null;

    // Re-read the shared whitelist on every refresh so live flag changes apply
    // without requiring a bot restart.
    resetMarketAdapterWhitelistCache();
    if (isBotDynamicWeightWhitelisted(botKey)) {
        snapshot = loadAmaCenterSnapshot(botKey) as JsonObj | null;
        const dw = snapshot?.dynamicWeights as JsonObj | undefined;
        const liveWeights = cloneWeightDistribution(dw?.effectiveWeights);
        if (dw?.isReady && liveWeights) {
            const snapshotBase = cloneWeightDistribution(dw?.baseWeights);
            const baseChanged = !snapshotBase
                || snapshotBase.sell !== baseWeights.sell
                || snapshotBase.buy !== baseWeights.buy;
            if (baseChanged) {
                bot._log(
                    `Skipping stale dynamic weights (${context}): ` +
                    `snapshot base (sell=${snapshotBase?.sell}, buy=${snapshotBase?.buy}) ` +
                    `!= config (sell=${baseWeights.sell}, buy=${baseWeights.buy})`,
                    'warn'
                );
            } else {
                nextWeights = liveWeights;
                source = 'dynamic';
            }
        }
    }

    bot.config.weightDistribution = { ...nextWeights };
    if (bot.manager?.config) {
        bot.manager.config.weightDistribution = { ...nextWeights };
    }

    if (source === 'dynamic') {
        bot._log(
            `Applied live dynamic weights (${context}): sell=${nextWeights.sell} buy=${nextWeights.buy}`,
            'info'
        );
    }

    return {
        applied: source === 'dynamic',
        source,
        weightDistribution: nextWeights,
        snapshotUpdatedAt: snapshot?.updatedAt || null,
    };
}

/**
 * Read and parse a trigger file's metadata payload.
 * Determines whether the trigger originated from the market adapter or was manual.
 * @param {string} triggerFile - Path to the trigger file
 * @returns {unknown} Parsed trigger metadata
 */
function readTriggerMetadata(triggerFile: string) {
    const manualTriggerMetadata = (payload: JsonObj | null = null) => ({
        ...buildGridResyncMetadata('manual_grid_resync'),
        payload,
    });

    const marketAdapterTriggerMetadata = (payload: JsonObj) => {
        const reason = String(payload?.reason || '').trim();
        return {
            ...buildGridResyncMetadata(reason || 'market_adapter_grid_resync'),
            payload,
        };
    };

    try {
        const raw = storage.readFile(triggerFile).trim();
        if (!raw) {
            // An empty trigger is the legacy/manual CLI reset signal.
            return manualTriggerMetadata();
        }

        const payload = JSON.parse(raw);
        const source = String(payload?.source || '').trim();
        return source === MARKET_ADAPTER_TRIGGER_SOURCE
            ? marketAdapterTriggerMetadata(payload)
            : manualTriggerMetadata(payload);
    } catch (_) {
        return manualTriggerMetadata();
    }
}

/**
 * Build grid resync metadata from a reason string.
 * Maps known reason strings to structured metadata with refresh flags.
 * @param {string} reason - Resync reason identifier (e.g. 'manual_grid_resync', 'rms_structural_grid_resync')
 * @returns {unknown}
 */
function buildGridResyncMetadata(reason: string) {
    const resetSource = String(reason || '').trim() || 'dexbot_grid_resync';
    const defaults = {
        shouldRefreshCenterPrice: false,
        centerRefreshContext: 'grid resync',
        centerRefreshLabel: 'grid resync',
    };
    const marketAdapterUnknown = resetSource === 'market_adapter_grid_resync'
        ? {
            centerRefreshContext: 'market adapter grid resync',
            centerRefreshLabel: 'market adapter grid reset',
        }
        : null;
    return {
        ...defaults,
        ...marketAdapterUnknown,
        ...((GRID_RESYNC_REASONS as Record<string, unknown>)[resetSource] || {}),
        resetSource,
    };
}

/**
 * Build grid resync options from a reason string or metadata object.
 * @param {string|any} reasonOrMetadata - Reason string or metadata object
 * @returns {unknown}
 */
function buildGridResyncOptions(reasonOrMetadata: unknown): {
    refreshCenterPrice?: boolean;
    centerRefreshContext?: string;
    centerRefreshLabel?: string;
    resetSource?: string;
} {
    const metadata = (typeof reasonOrMetadata === 'string'
        ? buildGridResyncMetadata(reasonOrMetadata)
        : reasonOrMetadata) as JsonObj | null | undefined;
    return {
        refreshCenterPrice: !!metadata?.shouldRefreshCenterPrice,
        centerRefreshContext: metadata?.centerRefreshContext as string | undefined,
        centerRefreshLabel: metadata?.centerRefreshLabel as string | undefined,
        resetSource: metadata?.resetSource as string | undefined,
    };
}

/**
 * Promote the AMA center price to the grid center price in the dynamic grid snapshot.
 * Used during grid resets to align the grid center with the latest AMA calculation.
 * @param {string} botKey - Bot identifier key
 * @returns {boolean} True if promotion succeeded
 */
function promoteAmaCenterSnapshotForGridReset(botKey: string | undefined) {
    if (!botKey) return false;

    // Full grid resets rebuild from the latest AMA center. The active grid
    // baseline is promoted to that value before recalculation, while the raw
    // AMA output remains intact in amaCenterPrice for diagnostics.
    const snapshotPath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    try {
        const result = updateDynamicGridSnapshotSync(snapshotPath, (snapshot: unknown) => {
            const snap = snapshot as JsonObj | null | undefined;
            const amaCenterPrice = Number(snap?.amaCenterPrice);
            if (!Number.isFinite(amaCenterPrice) || amaCenterPrice <= 0) {
                return { ok: false, write: false };
            }

            const currentCenterPrice = Number(snap?.gridCenterPrice ?? snap?.centerPrice);
            if (Number.isFinite(currentCenterPrice) && currentCenterPrice === amaCenterPrice) {
                return { write: false };
            }

            return {
                ...snap,
                gridCenterPrice: amaCenterPrice,
                centerPrice: amaCenterPrice,
                updatedAt: nowIso(),
            };
        });
        return result.ok;
    } catch (_) {
        return false;
    }
}

/**
 * Update the grid reset metadata (last reset timestamp and source) in the dynamic grid snapshot.
 * @param {string} botKey - Bot identifier key
 * @param {Object} [options] - Reset metadata options
 * @param {string} [options.resetAt] - ISO timestamp for the reset (defaults to now)
 * @param {string} [options.resetSource] - Source label for the reset (defaults to 'dexbot_grid_resync')
 * @returns {boolean} True if metadata was written
 */
function updateBotGridResetMetadata(botKey: string | undefined, options: { resetAt?: string; resetSource?: string } = {}) {
    if (!botKey) return false;

    const resetAt = options.resetAt || nowIso();
    const resetSource = options.resetSource || 'dexbot_grid_resync';
    const snapshotPath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

    try {
        const result = updateDynamicGridSnapshotSync(snapshotPath, (snapshot: unknown) => {
            const snap = snapshot as JsonObj;
            const gridCenterPrice = Number(snap?.gridCenterPrice ?? snap?.centerPrice);
            if (!Number.isFinite(gridCenterPrice) || gridCenterPrice <= 0) {
                return { ok: false, write: false };
            }
            return {
                ...snap,
                gridCenterPrice,
                centerPrice: gridCenterPrice,
                lastGridResetAt: resetAt,
                lastGridResetSource: resetSource,
                updatedAt: resetAt,
            };
        });
        return result.ok && result.written;
    } catch (_) {
        return false;
    }
}

/**
 * Perform a full grid resync: reload config, optionally refresh center price,
 * recalculate the grid, persist, and record reset metadata.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {unknown} [options] - Grid resync options
 * @param {boolean} [options.skipIdle=false] - Skip the idle-cooldown deferral
 * @returns {Promise<boolean>} True if resync succeeded
 */
function performGridResync(bot: BotLike, options: {
    refreshCenterPrice?: boolean;
    centerRefreshContext?: string;
    centerRefreshLabel?: string;
    resetSource?: string;
    skipIdle?: boolean;
} = {}) {
    const self = bot;
    let success = false;
    const refreshCenterPrice = !!options.refreshCenterPrice;
    const centerRefreshContext = options.centerRefreshContext || (refreshCenterPrice ? 'grid reset recenter' : 'grid resync');
    const centerRefreshLabel = options.centerRefreshLabel || (refreshCenterPrice ? 'grid reset' : 'grid resync');
    const resetSource = options.resetSource || (refreshCenterPrice ? 'manual_grid_resync' : 'dexbot_grid_resync');
    const skipIdle = options.skipIdle === true;
    const idleDelayMs = getMaintenanceIdleDelayMs(self as unknown as MaintenanceCtx);
    if (!skipIdle && idleDelayMs > 0) {
        self._log(
            `[MAINT-IDLE] Deferring grid resync until bot is idle` +
            ` (next check in ${Math.ceil(idleDelayMs / TIMING.MILLISECONDS_PER_SECOND)}s)`,
            'info'
        );
        scheduleDeferredGridResync(self as unknown as MaintenanceCtx, options);
        return Promise.resolve(false);
    }

    self.manager.startBootstrap();
    self._log('Grid regeneration triggered. Performing full grid resync...');
    return (async () => {
        try {
            try {
                const content = storage.readFile(PROFILES_BOTS_FILE);
                const allBotsConfig = parseJsonWithComments(content).bots || [];
                const myName = self.config.name;
                const updatedBot = allBotsConfig.find((b: { name?: unknown }) => isSameBotName(b.name, myName));

                if (updatedBot) {
                    replaceBotConfigFromEntryPreservingRuntime(self, updatedBot, 'grid resync');
                }
            } catch (e) {
                self._warn(`Failed to reload config during resync (using current settings): ${getErrorMessage(e)}`);
            }

            if (refreshCenterPrice) {
                if (promoteAmaCenterSnapshotForGridReset(self.config?.botKey)) {
                    self._log(`Refreshed AMA center snapshot for ${centerRefreshLabel}.`, 'info');
                    refreshDynamicWeightDistribution(self, centerRefreshContext);
                } else {
                    self._warn(`${centerRefreshLabel} requested but AMA center snapshot could not be refreshed.`);
                }
            } else {
                // Config was reloaded above but center price didn't change — still need
                // fresh weights so cancelDustOrders uses live distribution (Issue M).
                refreshDynamicWeightDistribution(self, 'grid resync');
            }

            // Truncated-read guard: recalculateGrid's readOpenOrdersFn drives
            // syncFromOpenOrders absence decisions (pass-1 phantom cleanup).
            // A partial get_full_accounts window must abort the resync instead
            // of virtualizing live ACTIVE slots; the trigger file is retained
            // so the resync retries on a clean read.
            let resyncReadAmbiguous = false;
            const readOpenOrdersForResync = (label: string) => readOpenOrdersGuarded(chainOrders, self.accountId, {
                log: (message: string, level?: string) => self._log(message, level),
                label,
                detail: 'trigger-file resync',
            });
            // Empty-read confirm guard: an EMPTY read during a trigger reset is
            // only accepted after one confirming re-read. A single 0-order
            // snapshot from a lagging/partial node must never wipe a live grid
            // and rebuild over existing orders (phantom reset — duplicated
            // price levels and mis-tracked orders). A contradicted re-read
            // (non-empty) feeds the fresh snapshot to the resync so the rebuild
            // reconciles against the real chain state instead of overwriting it.
            const readFn = async () => {
                const orders = await readOpenOrdersForResync('GRID-RESYNC');
                if (orders === null) {
                    resyncReadAmbiguous = true;
                    return orders;
                }
                if (orders.length > 0) return orders;
                await sleep(TIMING.SYNC_EMPTY_READ_CONFIRM_DELAY_MS);
                const confirmed = await readOpenOrdersForResync('GRID-RESYNC-CONFIRM');
                if (confirmed === null) {
                    resyncReadAmbiguous = true;
                    return orders;
                }
                if (confirmed.length > 0) {
                    self._log(
                        `[GRID-RESYNC] Empty open-order read contradicted by confirm re-read ` +
                        `(${confirmed.length} order(s) present) — using fresh non-empty snapshot`,
                        'warn'
                    );
                    return confirmed;
                }
                self._log('[GRID-RESYNC] Empty open-order read confirmed by re-read — accepting empty account', 'info');
                return orders;
            };
            await recalculateGrid(self.manager, {
                readOpenOrdersFn: readFn,
                chainOrders,
                account: self.account,
                privateKey: self.privateKey,
                config: self.config,
            });

            if (resyncReadAmbiguous) {
                self._warn('[GRID-RESYNC] Aborted trigger-file resync: open-order read ambiguous (truncated); retaining trigger file for retry.');
                return false;
            }

            await self.manager._fundLock.acquire(async () => {
                self.manager.funds.btsFeesOwed = 0;
            });
            await self.manager.persistGrid();
            success = true;
            if (updateBotGridResetMetadata(self.config?.botKey, {
                resetAt: nowIso(),
                resetSource,
            })) {
                self._log('Recorded grid reset metadata for dynamic grid state.', 'info');
            }

            safeUnlink(self.triggerFile);
            self._log('Removed trigger file.');

            // Re-detect and cancel dust immediately after full resync.
            if (!self._shuttingDown) {
                try {
                    const resyncHealth = await self.manager.checkGridHealth(
                        self.updateOrdersOnChainPlan?.bind(self)
                    );
                    await cancelDustOrders(self, {
                        buy: resyncHealth.buyDustOrders as ManagedOrder[] | undefined,
                        sell: resyncHealth.sellDustOrders as ManagedOrder[] | undefined,
                    });
                } catch (_dustErr) {
                    self._warn(`[DUST] Post-resync dust cancel failed: ${getErrorMessage(_dustErr)}`);
                }
            }

            // Clear unmatched chain orders after a successful rebuild.
            // The recalculateGrid call above runs syncFromOpenOrders which
            // sets _lastUnmatchedChainOrders from the chain perspective.
            // Forcing a clean slate here ensures the COW guard does not
            // hold stale unmatched entries from before the resync.
            if (self.manager) {
                self.manager._lastUnmatchedChainOrders = [];
                self.manager._lastUnmatchedChainOrdersAt = 0;
            }
        } catch (err) {
            self._log(`Error during triggered resync: ${getErrorMessage(err)}`, 'error');
        } finally {
            self.manager.finishBootstrap();
        }

        return success;
    })();
}

/**
 * Handle a pending trigger file detected at startup or during runtime.
 * Processes the trigger and performs a grid resync if the trigger file exists.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Promise<boolean>} True if reset was handled successfully
 */
async function handlePendingTriggerReset(bot: BotLike) {
    if (!storage.exists(bot.triggerFile)) {
        return false;
    }

    bot._log('Pending trigger file detected. Processing reset before startup...');
    const triggerInfo = readTriggerMetadata(bot.triggerFile);

    let resetSucceeded = false;
    // skipIdle: a pending trigger is an explicit reset command that must run
    // before the startup sequence. The idle gate can block it indefinitely
    // when the fill queue never drains, which would silently drop the reset.
    await bot.manager._fillProcessingLock.acquire(async () => {
        resetSucceeded = await performGridResync(bot, { ...buildGridResyncOptions(triggerInfo), skipIdle: true });
    });

    if (!resetSucceeded) {
        bot._warn('Pending trigger reset failed. Continuing with normal startup path.');
    }

    return resetSucceeded;
}

/**
 * Set up a file watcher on the profiles directory to detect trigger file creation.
 * When a trigger file appears, debounces and processes the grid resync.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Promise<void>}
 */
async function setupTriggerFileDetection(bot: BotLike) {
    if (bot._triggerWatcher && typeof bot._triggerWatcher.close === 'function') {
        bot._triggerWatcher.close();
        bot._triggerWatcher = null;
    }

    if (bot._triggerDebounceTimer) {
        clearTimeout(bot._triggerDebounceTimer);
        bot._triggerDebounceTimer = null;
    }

    try {
        bot._triggerWatcher = fs.watch(PROFILES_DIR, (eventType: string, filename: string | null) => {
            try {
                if (bot._shuttingDown) return;

                if (filename === path.basename(bot.triggerFile)) {
                    if ((eventType === 'rename' || eventType === 'change') && storage.exists(bot.triggerFile)) {
                        if (bot._triggerDebounceTimer) clearTimeout(bot._triggerDebounceTimer);
                        bot._triggerDebounceTimer = setTimeout(() => {
                            bot._triggerDebounceTimer = null;
                            // Re-check shutdown: the fs.watch callback checked
                            // _shuttingDown at debounce-schedule time, but the
                            // 200ms delay can outlive the start of shutdown.
                            // Acquiring the fill lock with a torn-down manager
                            // would be a no-op-or-error at best and a use-after-
                            // free at worst.
                            if (bot._shuttingDown || !bot.manager?._fillProcessingLock) return;
                            const triggerInfo = readTriggerMetadata(bot.triggerFile);
                            bot.manager._fillProcessingLock.acquire(async () => {
                                if (bot._shuttingDown) return;
                                // skipIdle: a trigger file is an explicit reset command.
                                // Deferring it behind the idle cooldown can loop forever
                                // when grid activity is continuous (fills arriving during
                                // placement batches refresh the settle window); the fill
                                // lock below already serializes the reset with in-flight
                                // batches.
                                const ok = await performGridResync(bot, { ...buildGridResyncOptions(triggerInfo), skipIdle: true });
                                if (!ok) {
                                    bot._warn('Runtime trigger reset failed; retaining existing grid state.');
                                }
                            }).catch((err: unknown) => {
                                bot._warn(`Trigger reset lock error: ${getErrorMessage(err)}`);
                                bot.manager._recoveryState = { ...bot.manager._recoveryState, lastFailureAt: Date.now() };
                            });
                        }, 200);
                    }
                }
            } catch (err) {
                bot._warn(`fs.watch handler error: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`);
            }
        });
    } catch (err) {
        bot._warn(`Failed to setup file watcher: ${getErrorMessage(err)}`);
    }
}

/**
 * Perform periodic grid health checks (divergence, spread condition, dust detection).
 * Called as part of the periodic blockchain fetch interval.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Promise<void>}
 */
async function performPeriodicGridChecks(bot: BotLike) {
    if (typeof bot._runGridMaintenance === 'function') {
        await bot._runGridMaintenance('periodic');
    } else {
        await runGridMaintenance(bot, 'periodic');
    }
    logDeferredHoldSummary(bot);
}

/**
 * Summarize deliberate deferred holds once per count change. The per-order
 * sync logs report each hold when it first appears; this surfaces the running
 * total (funds stay locked until an operator clears them) without re-logging
 * the same count every tick.
 *
 * The detail line names WHY each hold is held and how far it sits from the
 * grid, because "held" alone is ambiguous between deliberate deferral and a
 * stuck bot. A slow re-warn (rate-limited) additionally distinguishes a hold
 * that is still being actioned from one that has been static for a long time.
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function logDeferredHoldSummary(bot: BotLike) {
    const unmatched = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    const heldOrders = unmatched.filter((u) => isNonBlockingUnmatchedOrder(u));
    const held = heldOrders.length;
    if (held === 0) {
        bot._lastHeldChainOrderSignature = '';
        bot._lastHeldChainOrderWarnAt = 0;
        bot._lastHeldChainOrderSignatureSince = 0;
        bot._strandedHoldSince = new Map();
        return;
    }

    // Per-order age tracking for the stranded subset.
    //
    // The whole-set signature below includes every entry's reason, so an
    // UNRELATED hold flapping in and out (e.g. a per-sync
    // `broadcast-active-deferred`) changes the signature and restarts the age
    // clock every cycle. A genuinely stranded order then never reaches the
    // escalation age -- it is starved forever by churn it has nothing to do
    // with. Verified by simulation: with the whole-set clock, a stranded
    // order plus a 6-hourly flap reported `CLOCK RESET` on every single tick
    // and never accumulated age.
    //
    // So age is tracked per stranded order identity (id@price/size), keyed off
    // when THAT order was first seen stranded. Unrelated churn cannot touch it.
    if (!(bot._strandedHoldSince instanceof Map)) bot._strandedHoldSince = new Map();
    const strandedHoldSince: Map<string, number> = bot._strandedHoldSince;
    const stranded = heldOrders.filter((u) => isStrandedHoldOrder(u));
    const seenKeys = new Set<string>();
    const now = Date.now();
    let oldestStrandedMs = 0;
    for (const u of stranded) {
        const key = `${u?.chainOrderId ?? '?'}@${u?.price ?? '?'}/${u?.size ?? '?'}:${u?.reason ?? '?'}`;
        seenKeys.add(key);
        if (!strandedHoldSince.has(key)) strandedHoldSince.set(key, now);
        oldestStrandedMs = Math.max(oldestStrandedMs, now - Number(strandedHoldSince.get(key)));
    }
    // Drop entries that are no longer stranded, so a slot that clears and is
    // later re-held starts a fresh age rather than inheriting the old one.
    for (const key of Array.from(strandedHoldSince.keys())) {
        if (!seenKeys.has(key)) strandedHoldSince.delete(key);
    }

    const signature = heldOrders
        .map((u) => `${u?.chainOrderId ?? '?'}@${u?.price ?? '?'}/${u?.size ?? '?'}:${u?.reason ?? '?'}`)
        .sort()
        .join(',');

    // A count-only change gate hid same-count churn (one hold clearing while
    // another appeared looked like "no change" and was never logged). The
    // signature covers membership and terms, so any real change re-logs once.
    if (signature !== bot._lastHeldChainOrderSignature) {
        bot._lastHeldChainOrderSignature = signature;
        bot._lastHeldChainOrderWarnAt = Date.now();
        // Restart the whole-set logging clock: the signature changed, so this
        // is a new hold situation and the running total is worth re-logging.
        // NOTE: this clock drives LOGGING ONLY. Escalation below uses the
        // per-order stranded ages, because a signature change caused by
        // unrelated churn must not suppress escalation -- returning early here
        // (as an earlier revision did) meant any flapping hold skipped the
        // escalation call entirely, so a genuinely stranded order never
        // escalated at all.
        bot._lastHeldChainOrderSignatureSince = Date.now();
        bot._log?.(
            `[HOLD] ${held} deferred chain order(s) held outside the active pipeline ` +
            `(funds stay locked until cleared): ${describeDeferredHolds(bot, heldOrders)}`,
            'warn'
        );
        // Escalation is NOT gated on an unchanged signature: a stranded order
        // whose age has crossed the threshold must escalate even if an
        // unrelated transient hold is flapping in and out alongside it.
        considerDeferredHoldEscalation(bot, stranded, oldestStrandedMs);
        return;
    }

    // The signature is unchanged.
    if (!(Number(bot._lastHeldChainOrderSignatureSince) > 0)) {
        bot._lastHeldChainOrderSignatureSince = Date.now();
    }
    // Escalate on the STRANDED subset's own age, not the whole held set's.
    considerDeferredHoldEscalation(bot, stranded, oldestStrandedMs);

    // Unchanged set: re-warn slowly so an indefinitely-held order is visibly
    // still held rather than silently indistinguishable from a stalled loop.
    const warnEvery = Number(TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS) || 60000;
    const sinceWarn = Date.now() - (Number(bot._lastHeldChainOrderWarnAt) || 0);
    if (sinceWarn >= warnEvery) {
        bot._lastHeldChainOrderWarnAt = Date.now();
        // Age from the SIGNATURE-STABLE clock, not `_lastUnmatchedChainOrdersAt`
        // (which refresh on every observing sync and would report "~0m" for a
        // hold that has really been stuck for hours).
        const heldSince = Number(bot._lastHeldChainOrderSignatureSince) || 0;
        const ageMin = heldSince > 0 ? Math.round((Date.now() - heldSince) / 60000) : 0;
        bot._log?.(
            `[HOLD] still holding ${held} deferred chain order(s) for ~${ageMin}m ` +
            `with no change (funds stay locked until cleared): ${describeDeferredHolds(bot, heldOrders)}`,
            'warn'
        );
    }
}

/**
 * Escalate an INDEFINITELY-HELD deferred hold to a structural resync.
 *
 * Out-of-rail orphans hold locked funds and are never auto-cancelled per cycle.
 * That default is correct -- cancelling on ambiguous evidence is irreversible --
 * but it left "held indefinitely" with no exit. A hold that survives unchanged
 * for `DEFERRED_HOLD_ESCALATE_MS` is no longer ambiguous evidence: the grid has
 * had ample opportunity to resolve it and has not.
 *
 * The structural resync is the appropriate exit because the full reset's
 * reconcile is update-first: unmatched chain orders are price-updated onto rail
 * slots (emitting the rail's genesis level, so the reconcile-update guard does
 * not block it) and only true surplus is cancelled. Funds are released without
 * introducing any new cancellation policy.
 *
 * Fire-and-forget; the resync is itself debounced and batch-in-flight aware.
 */
function considerDeferredHoldEscalation(bot: BotLike, strandedOrders: HeldChainOrder[], strandedMs: number) {
    const escalateMs = Number(TIMING?.DEFERRED_HOLD_ESCALATE_MS) > 0
        ? Number(TIMING.DEFERRED_HOLD_ESCALATE_MS)
        : 24 * 60 * 60 * 1000;
    const held = strandedOrders.length;
    if (held === 0) return;
    // Age is supplied by the caller: the oldest STRANDED order's age, measured
    // from when that order was first seen stranded (per-order clock). It is
    // deliberately NOT the whole held-set signature age, which unrelated
    // flapping holds reset every cycle and which would starve escalation.
    const heldMs = Number(strandedMs) || 0;
    if (heldMs < escalateMs) return;

    if (typeof bot?.manager?.requestStructuralGridResync !== 'function') {
        bot?._log?.(
            `[HOLD] ${held} deferred chain order(s) held unchanged for ${Math.round(heldMs / 3600000)}h ` +
            `but requestStructuralGridResync is unavailable; funds stay locked`,
            'error'
        );
        return;
    }

    const cooldownMs = Number(TIMING?.DEFERRED_HOLD_RESYNC_COOLDOWN_MS) > 0
        ? Number(TIMING.DEFERRED_HOLD_RESYNC_COOLDOWN_MS)
        : 6 * 60 * 60 * 1000;
    const now = Date.now();
    const lastAt = Number(bot._lastDeferredHoldResyncAt) || 0;
    if (now - lastAt < cooldownMs) return;
    bot._lastDeferredHoldResyncAt = now;

    const heldHours = Math.round(heldMs / 3600000);
    bot?._log?.(
        `[HOLD] ${held} deferred chain order(s) held unchanged for ~${heldHours}h; ` +
        `requesting structural resync to resolve the hold (reconcile is update-first, ` +
        `so funds are released by price-updating onto rail slots) — ` +
        `${describeDeferredHolds(bot, strandedOrders)}`,
        'error'
    );
    fireStructuralResync(bot, 'deferred-hold-stale', {
        reason: `${held} deferred chain order(s) held unchanged for ~${heldHours}h`,
        heldCount: held,
        heldMs,
    }, '[HOLD] Structural resync for stale hold failed');
}

/**
 * Render the per-order detail for a deferred-hold summary: side, price, size,
 * why it is held, and distance from the nearest grid bound when known.
 *
 * Distance is expressed as a percentage of the bound so the operator can tell
 * a near-miss (a few bps outside, likely a rounding/drift artifact) from a
 * deliberately-placed far order (dip protection after a grid reset).
 */
function describeDeferredHolds(bot: BotLike, heldOrders: HeldChainOrder[]): string {
    const genesis = bot.manager?._genesis;
    const levels: number[] = Array.isArray(genesis?.priceLevels) ? genesis.priceLevels as number[] : [];
    const lower = levels.length > 0 ? Number(levels[0]) : NaN;
    const upper = levels.length > 0 ? Number(levels[levels.length - 1]) : NaN;

    return heldOrders
        .map((u) => {
            const side = u?.type === ORDER_TYPES.SELL ? 'sell' : u?.type === ORDER_TYPES.BUY ? 'buy' : 'unknown';
            const price = Number(u?.price);
            const size = u?.size != null ? u.size : '?';
            const reason = u?.reason || 'unspecified';
            const parts = [`${u?.chainOrderId ?? '?'} ${side} price=${Number.isFinite(price) ? price : '?'} size=${size} reason=${reason}`];
            if (Number.isFinite(price)) {
                if (Number.isFinite(lower) && price < lower) {
                    parts.push(`below-grid by ${(((lower - price) / lower) * 100).toFixed(4)}% (bound ${lower})`);
                } else if (Number.isFinite(upper) && price > upper) {
                    parts.push(`above-grid by ${(((price - upper) / upper) * 100).toFixed(4)}% (bound ${upper})`);
                }
            }
            return parts.join(' ');
        })
        .join(' | ');
}

/**
 * Check if the continuous open-orders sync loop is enabled.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {boolean} True if the sync loop is enabled in TIMING config
 */
function isOpenOrdersSyncLoopEnabled(bot: BotLike) {
    if (bot.config?.timing?.openOrdersSyncLoopEnabled !== undefined) {
        return !!bot.config.timing.openOrdersSyncLoopEnabled;
    }
    return !!TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED;
}

/**
 * Start the continuous open-orders sync loop.
 * Periodically reads on-chain orders and synchronizes with the grid manager.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function startOpenOrdersSyncLoop(bot: BotLike) {
    if (bot._mainLoopPromise) return;

    const hasEnvLoopDelay = hasOpenOrdersSyncLoopMsSet();
    const loopDelayRaw = getOpenOrdersSyncLoopMs();
    const configuredLoopDelayMs = hasEnvLoopDelay && loopDelayRaw !== undefined ? loopDelayRaw : Number(TIMING.RUN_LOOP_DEFAULT_MS);
    const loopDelayMs = Number.isFinite(configuredLoopDelayMs) && configuredLoopDelayMs > 0
        ? configuredLoopDelayMs
        : Number(TIMING.RUN_LOOP_DEFAULT_MS);

    if (hasEnvLoopDelay && loopDelayMs !== configuredLoopDelayMs) {
        bot._warn(`Invalid OPEN_ORDERS_SYNC_LOOP_MS='${Config._OPEN_ORDERS_SYNC_LOOP_MS_RAW}'. Falling back to default ${TIMING.RUN_LOOP_DEFAULT_MS}ms.`);
    }

    bot._mainLoopActive = true;
    bot._log(`Open-orders sync loop started (every ${loopDelayMs}ms, dryRun=${!!bot.config.dryRun})`);

    bot._mainLoopPromise = (async () => {
        while (bot._mainLoopActive && !bot._shuttingDown) {
            try {
                if (bot.manager && bot.accountId && !bot.config.dryRun) {
                    // Skip while a structural recovery reload is in flight:
                    // _recoverFromPersistedGrid runs WITHOUT the fill lock, so
                    // the lock gate alone would let this loop synchronizeWithChain
                    // (and even fire a rebalance broadcast) into a half-rebuilt
                    // grid. Same isolation the fill consumer gets via
                    // _recoverySyncInFlight.
                    if (!bot._recoverySyncInFlight &&
                        !shouldDeferMaintenanceForBroadcast(bot) &&
                        !bot.manager._fillProcessingLock.isLocked() &&
                        bot.manager._fillProcessingLock.getQueueLength() === 0) {
                        await bot.manager._fillProcessingLock.acquire(async () => {
                            // Truncated-read guard: syncing on a partial
                            // get_full_accounts window would virtualize live
                            // ACTIVE slots (pass-1 phantom cleanup) and
                            // re-create them as duplicates. Defer to a clean
                            // read — fill subscription events keep the bot
                            // responsive in the meantime.
                            const chainOpenOrders = (typeof bot._readOpenOrdersHook === 'function')
                                ? await bot._readOpenOrdersHook()
                                : await readOpenOrdersGuarded(chainOrders, bot.accountId, {
                                    log: (message: string, level?: string) => bot._log(message, level),
                                    label: 'OPEN-ORDERS-SYNC',
                                });
                            if (chainOpenOrders !== null) {
                                const syncResult = await bot.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

                                if (syncResult?.filledOrders && syncResult.filledOrders.length > 0) {
                                    bot._log(`Open-orders sync loop: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                    bot._markGridActivity?.('open-orders sync fill');
                                    const batchResult = await bot._processFillsWithBatching(
                                        syncResult.filledOrders, new Set(), 'open-orders sync fill rebalance', { isReplay: true }
                                    );
                                    if (!batchResult?.aborted) {
                                        await bot.manager.persistGrid();
                                    }
                                }
                            }
                            // Run grid health / dust detection after every sync tick so
                            // partial-only fills that reduced an order below the dust
                            // threshold (but did not trigger the full-fill gate in the
                            // main processFills path) are caught promptly instead of
                            // waiting up to BLOCKCHAIN_FETCH_INTERVAL_MIN.
                            await performPeriodicGridChecks(bot);
                        });
                    }
                }
            } catch (err) {
                bot._warn(`Order manager loop error: ${getErrorMessage(err)}`);
            }

            await sleep(loopDelayMs);
        }
    })().catch((err: unknown) => {
        bot._warn(`Open-orders sync loop failed: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`);
    }).finally(() => {
        bot._mainLoopPromise = null;
    });
}

/**
 * Stop the continuous open-orders sync loop.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Promise<void>}
 */
async function stopOpenOrdersSyncLoop(bot: BotLike) {
    bot._mainLoopActive = false;
    if (bot._mainLoopPromise) {
        await bot._mainLoopPromise;
    }
}

/**
 * Set up the periodic blockchain fetch interval.
 * Periodically fetches account totals and syncs open orders from the blockchain.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function setupBlockchainFetchInterval(bot: BotLike) {
    let intervalMin = bot.config?.timing?.BLOCKCHAIN_FETCH_INTERVAL_MIN as number;

    // Use the per-instance override if set (e.g., from fund registry shared-account detection)
    if (typeof bot._blockchainFetchIntervalMin === 'number' && Number.isFinite(bot._blockchainFetchIntervalMin) && bot._blockchainFetchIntervalMin > 0) {
        intervalMin = bot._blockchainFetchIntervalMin;
    } else if (bot.config?.preferredAccount) {
        // Fallback: check fund registry for shared accounts
        try {
            if (fundRegistry.isSharedAccount(bot.config.preferredAccount)) {
                intervalMin = TIMING.SHARED_ACCOUNT_FETCH_INTERVAL_MIN;
                bot._blockchainFetchIntervalMin = intervalMin;
            }
        } catch (_err) {
            bot?._warn?.(`Registry unavailable for shared-account interval check: ${getErrorMessage(_err)}`);
        }
    }

    syncMarketAdapterOnPeriodicConfigCheck(bot, 'startup blockchain fetch setup')
        .catch((err: unknown) => {
            bot._warn(`Market adapter watchdog failed during startup blockchain fetch setup: ${getErrorMessage(err)}`);
        });

    if (bot._blockchainFetchInterval !== null && bot._blockchainFetchInterval !== undefined) {
        stopBlockchainFetchInterval(bot);
    }

    if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
        bot._log(`Blockchain fetch interval disabled (value: ${intervalMin}). Periodic blockchain updates will not run.`);
        return;
    }

    if (!bot.manager || typeof bot.manager.fetchAccountTotals !== 'function') {
        bot._warn('Cannot start blockchain fetch interval: manager or fetchAccountTotals method missing');
        return;
    }

    if (!bot.accountId) {
        bot._warn('Cannot start blockchain fetch interval: account ID not available');
        return;
    }

    const intervalMs = intervalMin * 60 * TIMING.MILLISECONDS_PER_SECOND;
    bot._blockchainFetchInterval = setInterval(async () => {
        // Skip if shutdown has begun between the previous tick and now:
        // there is no point acquiring _fillProcessingLock or making
        // chain / daemon calls once we are tearing down. The lock would
        // serialize correctly, but we would still do wasted work
        // (syncMarketAdapter, fetchAccountTotals, readOpenOrders)
        // during shutdown.
        if (bot._shuttingDown) return;
        // 7a: never queue on _fillProcessingLock while a broadcast/placement
        // region is active. The fill consumer pre-defers on the same signal;
        // the timer retries next interval once the region ends.
        if (shouldDeferMaintenanceForBroadcast(bot)) return;
        // Guard against overlapping ticks: if the previous tick is still in
        // flight (slow chain / stall), skip rather than queue a second
        // periodic fetch. The fill lock below would still serialize the
        // work, but the second tick would waste a syncMarketAdapter call
        // and a fetchAccountTotals call while waiting.
        if (bot._blockchainFetchInFlight) return;
        bot._blockchainFetchInFlight++;
        try {
            try {
                await syncMarketAdapterOnPeriodicConfigCheck(bot, 'periodic blockchain fetch');

                await bot.manager._fillProcessingLock.acquire(async () => {
                    if (bot.manager.accountant && typeof bot.manager.accountant.resetRecoveryState === 'function') {
                        bot.manager.accountant.resetRecoveryState();
                    } else {
                        bot.manager._recoveryAttempted = false;
                    }
                    refreshDynamicWeightDistribution(bot, 'periodic blockchain fetch');
                    bot._log(`Fetching blockchain account values (interval: every ${intervalMin}min)`);
                    await bot.manager.fetchAccountTotals(bot.accountId);

                    let chainOpenOrders: unknown[] | null = [];
                    if (!bot.config.dryRun) {
                        try {
                            // Truncated-read guard: a partial get_full_accounts
                            // window would make synchronizeWithChain's pass-1
                            // virtualize live ACTIVE slots that are simply missing
                            // from the window (then re-create them as duplicates).
                            // Defer the sync to a clean read; fills are still
                            // caught by subscription events and the next cycle.
                            chainOpenOrders = ((typeof bot._readOpenOrdersHook === 'function')
                                ? await bot._readOpenOrdersHook()
                                : await readOpenOrdersGuarded(chainOrders, bot.accountId, {
                                    log: (message: string, level?: string) => bot._log(message, level),
                                    label: 'PERIODIC-SYNC',
                                })) as unknown[];
                            if (chainOpenOrders !== null) {
                                const syncResult = await bot.manager.synchronizeWithChain(chainOpenOrders, 'periodicBlockchainFetch');

                                if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                                    bot._log(`Periodic sync: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                    bot._markGridActivity?.('periodic sync fill rebalance');
                                    const batchResult = await bot._processFillsWithBatching(
                                        syncResult.filledOrders, new Set(), 'periodic sync fill rebalance', { isReplay: true }
                                    );
                                    if (!batchResult?.aborted) {
                                        await bot.manager.persistGrid();
                                    }
                                }

                                if (syncResult.unmatchedChainOrders && syncResult.unmatchedChainOrders.length > 0) {
                                    const sample = syncResult.unmatchedChainOrders
                                        .slice(0, 3)
                                        .map(formatUnmatchedChainOrder)
                                        .join(' | ');
                                    bot._log(
                                        `Periodic sync: ${syncResult.unmatchedChainOrders.length} chain order(s) not in grid ` +
                                        `(surplus/divergence)${sample ? `: ${sample}` : ''}`,
                                        'warn'
                                    );
                                }
                            }
                        } catch (err) {
                            bot._warn(`Error reading open orders during periodic fetch: ${getErrorMessage(err)}`);
                        }
                    }

                    await performPeriodicGridChecks(bot);
                });
            } catch (err) {
                bot._warn(`Error during periodic blockchain fetch: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`);
            }
        } finally {
            bot._blockchainFetchInFlight--;
        }
    }, intervalMs);
    if (typeof bot._blockchainFetchInterval.unref === 'function') {
        bot._blockchainFetchInterval.unref();
    }

    bot._log(`Started periodic blockchain fetch interval: every ${intervalMin} minute(s)`);
}

/**
 * Stop the periodic blockchain fetch interval.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function stopBlockchainFetchInterval(bot: BotLike) {
    if (bot._blockchainFetchInterval !== null && bot._blockchainFetchInterval !== undefined) {
        clearInterval(bot._blockchainFetchInterval);
        bot._blockchainFetchInterval = null;
        bot._log('Stopped periodic blockchain fetch interval');
    }
}

/**
 * Set up the periodic bots.json poll interval.
 * Runs in ALL modes (including wrapper-owned monolithic): the tick drives
 * syncMarketAdapterOnPeriodicConfigCheck, which always runs the live
 * bot-config check (allowlisted keys applied without restart, Issue #27
 * follow-up) and additionally drives the market adapter only in
 * wrapper-less modes (the one-shot runner, isolated supervisor, PM2).
 * Decoupled from the heavy blockchain fetch interval (default 240min) so
 * config changes are visible within BOTS_CONFIG_POLL_INTERVAL_MS
 * (default 1min, shared with the wrapper watchdog interval).
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function setupBotsConfigPollInterval(bot: BotLike) {
    // Allow per-bot timing override (e.g. tests or per-bot tuning)
    let intervalMs = bot.config?.timing?.BOTS_CONFIG_POLL_INTERVAL_MS as number;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        intervalMs = Number(TIMING.BOTS_CONFIG_POLL_INTERVAL_MS);
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        bot._log(`Bots-config poll interval disabled (value: ${intervalMs}). Adapter and live bot-config changes will only be seen on blockchain fetch ticks.`);
        return;
    }

    // NOTE: no wrapper-owned early return here on purpose. The adapter drive
    // inside syncMarketAdapterOnPeriodicConfigCheck still skips when the
    // wrapper owns it, but the live bot-config check at the top of that
    // function must run for every bot (otherwise monolithic bots would never
    // pick up bots.json edits until the 240min blockchain fetch tick).

    // Ensure the fingerprint exists before the first interval fires.
    // setupBlockchainFetchInterval already fires syncMarketAdapterOnPeriodicConfigCheck
    // at startup, so this is a fallback for bots that never run the blockchain interval
    // (e.g. dryRun or accountId missing). Gate on === null (never checked):
    // '' is a valid checked steady-state and must not re-trigger the pre-seed.
    if (bot._marketAdapterWatchdogFingerprint === null || bot._marketAdapterWatchdogFingerprint === undefined) {
        syncMarketAdapterOnPeriodicConfigCheck(bot, 'startup bots-config poll setup').catch((err: unknown) => {
            bot._warn(`Bots-config poll setup failed: ${getErrorMessage(err)}`);
        });
    }

    if (bot._botsConfigPollInterval !== null && bot._botsConfigPollInterval !== undefined) {
        stopBotsConfigPollInterval(bot);
    }

    bot._botsConfigPollInterval = setInterval(async () => {
        if (bot._shuttingDown) return;
        // Coalesce with the blockchain-fetch tick: if its tick is already
        // driving the watchdog, skip to avoid double PM2 queries.
        if (bot._marketAdapterWatchdogInFlight) return;
        if (bot._botsConfigPollInFlight) return;
        bot._botsConfigPollInFlight = true;
        try {
            await syncMarketAdapterOnPeriodicConfigCheck(bot, 'bots-config poll');
        } catch (err) {
            bot._warn(`Bots-config poll failed: ${getErrorMessage(err)}`);
        } finally {
            bot._botsConfigPollInFlight = false;
        }
    }, intervalMs);
    if (typeof bot._botsConfigPollInterval.unref === 'function') {
        bot._botsConfigPollInterval.unref();
    }

    bot._log(`Started bots-config poll interval: every ${Math.round(intervalMs / 1000)}s (adapter fingerprint + live bot-config check)`);
}

/**
 * Stop the periodic bots.json fingerprint poll interval.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function stopBotsConfigPollInterval(bot: BotLike) {
    if (bot._botsConfigPollInterval !== null && bot._botsConfigPollInterval !== undefined) {
        clearInterval(bot._botsConfigPollInterval);
        bot._botsConfigPollInterval = null;
        bot._log('Stopped bots-config poll interval');
    }
}

/**
 * Release the market adapter runtime for a bot.
 * In PM2 mode this is a no-op; in direct mode it calls the shared runtime's releaseBot.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} botId - Bot identifier
 * @param {string} [context='shutdown'] - Context label for logging
 * @returns {Promise<any>}
 */
async function releaseMarketAdapterRuntime(_bot: unknown, botId: string, context: string = 'shutdown') {
    if (isPm2Runtime()) {
        return { released: false, mode: 'pm2' };
    }

    if (!botId) {
        return { released: false, mode: 'direct', reason: 'missing-bot-id' };
    }

    const runtime = getSharedMarketAdapterRuntime({ root: PATHS.PROJECT_ROOT });
    const result = await runtime.releaseBot(botId);
    return {
        released: true,
        context,
        mode: 'direct',
        ...result,
    };
}

// Dust is detected immediately on fills, and a periodic dust health check
// (setupDustHealthCheckInterval / runDustHealthCheck) catches partials below
// the threshold that were missed after crashes/restarts.

/**
 * Check if an error message indicates that an order does not exist on the blockchain.
 * Delegates to the canonical implementation in order/utils/order.ts (single source
 * of truth shared with the correction/reconcile-cancel paths).
 * @param {string} message - Error message to check
 * @param {string} [orderId] - Optional order ID for context-aware matching
 * @returns {boolean} True if the message indicates a nonexistent order
 */
function isOrderDoesNotExistError(message: unknown, orderId: string) {
    return require('./order/utils/order').isOrderGoneErrorMessage(message, orderId);
}

/**
 * 7a: pre-acquire broadcast deferral for timer-driven lock waiters.
 *
 * The fill consumer already defers before acquiring _fillProcessingLock (see
 * shouldDeferFillForBroadcast in dexbot_fill_runtime); the maintenance timer
 * loops do not. While a long broadcast/placement region holds work on the
 * lock (or holds the broadcasting flag between per-op acquisitions), they
 * queue behind it and can die at the 20s acquisition timeout. These loops
 * are timer-driven, so skipping a tick is safe: the next tick retries once
 * the region ends.
 *
 * Deadlock guard: these loops also run the periodic maintenance that calls
 * _clearStaleBroadcastFlag, so deferring on a genuinely STALE (leaked) flag
 * would prevent the only watchdog that clears it — the flag would never
 * clear and every tick would defer forever. A live region refreshes
 * manager._broadcastingStartedAt on every holder, so its age stays small;
 * a frozen timestamp ages past BROADCAST_STALE_CLEAR_MS and we let the tick
 * through so maintenance can hard-reset the flag.
 * @param {unknown} bot
 * @returns {boolean} true when the caller should skip this tick
 */
function shouldDeferMaintenanceForBroadcast(bot: BotLike): boolean {
    try {
        if (bot?.manager?.isBroadcastingActive?.() !== true) return false;
        const startedAt = Number(bot?.manager?._broadcastingStartedAt) || 0;
        if (!startedAt) return false;
        const staleMs = Number(TIMING?.BROADCAST_STALE_CLEAR_MS) > 0
            ? Number(TIMING.BROADCAST_STALE_CLEAR_MS)
            : 120000;
        return (Date.now() - startedAt) < staleMs;
    } catch {
        return false;
    }
}

/**
 * Observability watchdog for _gridLock hold duration. _gridLock has no
 * acquisition timeout and its callers cannot safely recover from a rejected
 * acquire (grid mutations are not idempotent, and forceRelease would let a new
 * acquirer run alongside the orphaned callback), so an over-long critical
 * section cannot be timed out — it must be bounded at the source. This makes
 * any such section visible: when the live hold crosses
 * TIMING.GRID_LOCK_HOLD_WARN_MS it emits a rate-limited warn. Called from the
 * maintenance tick so holds outside a broadcast region are observed too.
 * @param {unknown} bot
 * @returns {number} Observed hold duration in ms (0 when not held)
 */
function checkGridLockHoldDuration(bot: BotLike): number {
    try {
        const lock = bot?.manager?._gridLock;
        if (!lock || typeof lock.heldForMs !== 'function') return 0;
        const heldMs = Number(lock.heldForMs()) || 0;
        if (heldMs <= 0) return 0;
        const warnMs = Number(TIMING?.GRID_LOCK_HOLD_WARN_MS) > 0
            ? Number(TIMING.GRID_LOCK_HOLD_WARN_MS)
            : 15000;
        if (heldMs >= warnMs) {
            const now = Date.now();
            const rateLimitMs = Number(TIMING?.STALE_TOTALS_WARN_RATE_LIMIT_MS) > 0
                ? Number(TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS)
                : 60000;
            const lastWarnAt = Number(bot?._gridLockHoldWarnAt) || 0;
            if (now - lastWarnAt >= rateLimitMs) {
                bot._gridLockHoldWarnAt = now;
                bot?._warn?.(
                    `[GRID-LOCK] _gridLock held for ${Math.round(heldMs)}ms (threshold ${warnMs}ms). ` +
                    `A critical section is running long and may starve lock waiters; bound the holder ` +
                    `at the source rather than force-releasing a mutating lock.`
                );
            }
        }
        return heldMs;
    } catch {
        return 0;
    }
}

/**
 * Calculate the remaining idle delay (ms) before grid maintenance can proceed.
 * Waits for fill queue to drain and for recent grid activity to settle.
 * @param {Object} ctx - Bot context with _lastGridActivityAt and _incomingFillQueue
 * @returns {number} Remaining idle delay in ms (0 if bot is idle)
 */
function getMaintenanceIdleDelayMs(ctx: MaintenanceCtx | null | undefined) {
    const settleDelayMs = Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        : TIMING.BLOCKCHAIN_SETTLE_DELAY_MS;
    if (settleDelayMs <= 0) return 0;

    if ((ctx?._incomingFillQueue?.length ?? 0) > 0) return settleDelayMs;

    const lastActivityAt = Number(ctx?._lastGridActivityAt || 0);
    if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return 0;

    return Math.max(0, settleDelayMs - (Date.now() - lastActivityAt));
}

/**
 * Schedule grid maintenance to run after the bot becomes idle.
 * @param {Object} ctx - Bot context
 * @param {string} context - Context label for logging
 * @param {Object} [options] - Maintenance options forwarded to runGridMaintenance
 */
function scheduleMaintenanceAfterIdle(ctx: MaintenanceCtx, context: string, options: JsonObj = {}) {
    if (!ctx || ctx._shuttingDown || ctx._maintenanceIdleTimer || !ctx.manager?._fillProcessingLock) return;

    const delayMs = getMaintenanceIdleDelayMs(ctx);
    if (!(delayMs > 0)) return;

    const timerOptions = {
        ...(options || {}),
    };

    ctx._maintenanceIdleTimer = setTimeout(() => {
        ctx._maintenanceIdleTimer = null;
        if (ctx._shuttingDown) return;
        ctx._runGridMaintenance?.(context, timerOptions)
            ?.catch((err: unknown) => {
                ctx._warn?.(`Deferred ${context} grid maintenance failed: ${getErrorMessage(err)}`);
                if (ctx.manager) {
                    ctx.manager._recoveryState = { ...ctx.manager._recoveryState, lastFailureAt: Date.now() };
                }
            });
    }, delayMs);
}

/**
 * Schedule a deferred grid resync after idle delay elapses.
 * @param {Object} ctx - Bot context
 * @param {unknown} [options] - Grid resync options
 */
function scheduleDeferredGridResync(ctx: MaintenanceCtx, options: JsonObj = {}) {
    if (
        !ctx ||
        ctx._shuttingDown ||
        ctx._deferredGridResyncTimer ||
        !ctx.manager?._fillProcessingLock
    ) {
        return;
    }

    const idleDelayMs = getMaintenanceIdleDelayMs(ctx);
    const triggerFileWasPresent = !!(ctx.triggerFile && storage.exists(ctx.triggerFile));
    const settleDelayMs = Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        : TIMING.BLOCKCHAIN_SETTLE_DELAY_MS;
    const delayMs = idleDelayMs + settleDelayMs;
    if (!(delayMs > 0)) return;

    ctx._deferredGridResyncTimer = setTimeout(() => {
        ctx._deferredGridResyncTimer = null;
        if (ctx._shuttingDown) return;
        if (triggerFileWasPresent && !storage.exists(ctx.triggerFile as string)) return;

        ctx.manager?._fillProcessingLock?.acquire?.(async () => {
            const ok = await ctx._performGridResync?.(options);
            if (!ok && !ctx._shuttingDown) {
                const curIdleMs = getMaintenanceIdleDelayMs(ctx);
                const reason = curIdleMs > 0
                    ? `idle cooldown (${Math.ceil(curIdleMs / TIMING.MILLISECONDS_PER_SECOND)}s)`
                    : 'grid resync rejected or failed';
                ctx._warn?.(`Deferred trigger reset blocked: ${reason}; retaining existing grid state.`);
            }
        })?.catch((err: unknown) => {
            ctx._warn?.(`Deferred trigger reset lock error: ${getErrorMessage(err)}`);
            if (ctx.manager) {
                ctx.manager._recoveryState = { ...ctx.manager._recoveryState, lastFailureAt: Date.now() };
            }
        });
    }, delayMs);
}

/**
 * Execute the core maintenance logic: recalculate funds, check pipeline,
 * refresh dynamic weights, check grid health, cancel dust orders,
 * apply divergence corrections, and fix spread conditions.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} context - Context label for logging (e.g. 'periodic', 'dust-timer')
 * @returns {Promise<void>}
 */
async function executeMaintenanceLogic(bot: BotLike, context: string) {
    // Surface any over-long _gridLock hold first — observational only, and it
    // must run even when the rest of the tick defers on a broadcast region.
    checkGridLockHoldDuration(bot);
    // Clear stale broadcast flag first so any downstream gating on
    // isBroadcastingActive() (e.g. recalculateFunds, BTS balance check)
    // sees the freshest state rather than a hung flag.
    bot.manager._clearStaleBroadcastFlag();

    await bot.manager.recalculateFunds();
    await checkBtsBalanceAndAcquire(bot);
    bot.manager.clearStalePipelineOperations();

    // Clear divergence flags at the top of every tick so _gridSidesUpdated only
    // carries flags set within the current tick's divergence detection. This replaces
    // the old conditional stale-clear with an unconditional reset — clearing an empty
    // Set is a no-op, and stale flags from aborted ticks never cross boundaries.
    bot.manager._gridSidesUpdated?.clear();

    if (bot._maintenanceCooldownCycles > 0) {
        bot._maintenanceCooldownCycles--;
        bot._log(
            `[MAINT-COOLDOWN] Skipping ${context} maintenance after hard-abort recovery sync (remaining=${bot._maintenanceCooldownCycles})`,
            'warn'
        );
        return;
    }

    // Grid bloat re-check: if a previous loadGrid detected bloat and set
    // _gridBloatDetectedAt, verify the grid is still oversized after a grace
    // period. If it hasn't resolved and no structural resync is in flight,
    // trigger one. This catches bloat that occurred during startup (before
    // requestStructuralGridResync was wired) or bloat that survived a prior
    // resync attempt.
    if (bot.manager._gridBloatDetectedAt && typeof bot.manager.requestStructuralGridResync === 'function') {
        const grace = isGridBloatGraceActive(bot.manager);
        if (!grace.active) {
            const bloatResult = isGridBloated(bot.manager, bot.manager.orders);
            if (bloatResult.bloated) {
                const d = bloatResult.details as { gridSize: number; maxAllowed: number };
                bot._log(
                    `[GRID-BLOAT] Grid size ${d.gridSize} still exceeds expected maximum ${d.maxAllowed} ` +
                    `after grace period (${grace.graceMs}ms). Triggering structural resync.`,
                    'warn'
                );
                bot.manager.requestStructuralGridResync(
                    'grid-bloat-persistent',
                    { reason: `Grid size ${d.gridSize} still exceeds max ${d.maxAllowed} after grace` }
                ).catch((err: unknown) => {
                    bot.manager?.logger?.log?.(
                        `[GRID-BLOAT] Structural resync request failed: ${getErrorMessage(err)}`,
                        'error'
                    );
                });
            } else {
                clearGridBloatFlag(bot.manager);
                bot._log('[GRID-BLOAT] Grid size returned to normal. Clearing bloat flag.', 'info');
            }
        }
    }

    // Gap 4: Periodic lightweight consistency check. Fetches open order count
    // from chain and compares to grid active order count. Triggers a targeted
    // sync when significant divergence is detected. Runs at most once per
    // LIGHTWEIGHT_SYNC_CHECK_INTERVAL_MS to limit blockchain query load.
    // Skip if the COW pipeline has active CREATEs in flight to avoid racing
    // with batch broadcasts — transient mismatches are expected during a COW cycle.
    // Also skip while a structural recovery reload is in flight (it runs without
    // the fill lock, so this check must gate on the recovery flag explicitly).
    if (
        !bot._recoverySyncInFlight &&
        !bot._batchInFlight &&
        !(bot.manager?._pendingBroadcasts?.size > 0) &&
        (bot._lightweightSyncCheckAt == null || Date.now() - bot._lightweightSyncCheckAt >= TIMING.LIGHTWEIGHT_SYNC_CHECK_INTERVAL_MS)
    ) {
        bot._lightweightSyncCheckAt = Date.now();
        try {
            // Truncated-read guard: a partial window undercounts the chain
            // order count, which would fabricate a divergence and trigger a
            // full synchronizeWithChain on a partial snapshot (pass-1 phantom
            // virtualization). Defer to a clean read.
            const chainOpenOrdersResult = await readOpenOrdersGuarded(chainOrders, bot.accountId, {
                log: (message: string, level?: string) => bot._log(message, level),
                label: 'LIGHTWEIGHT-SYNC',
                skipMessage: (kind: string) =>
                    `[LIGHTWEIGHT-SYNC] Open-order read ${kind}; skipping consistency check (partial snapshot cannot drive count comparisons)`,
            });
            if (chainOpenOrdersResult !== null) {
                const assets = bot.manager?.assets;
                if (!assets) {
                    bot._log('[LIGHTWEIGHT-SYNC] Skipped: manager assets not available', 'debug');
                } else {
                    const chainOrdersCount = chainOpenOrdersResult.filter((o) => parseChainOrder(o, assets) !== null).length;
                    const gridActive = Array.from(bot.manager.orders.values()).filter(
                        (o) => isOrderOnChain(o)
                    ).length;
                    const diff = Math.abs(chainOrdersCount - gridActive);
                    if (diff > 2) {
                        bot._log(
                            `[LIGHTWEIGHT-SYNC] Order count mismatch: chain=${chainOrdersCount}, grid=${gridActive} ` +
                            `(diff=${diff}). Triggering targeted sync to reconcile.`,
                            'warn'
                        );
                        if (bot.manager?.synchronizeWithChain) {
                            await bot.manager.synchronizeWithChain(chainOpenOrdersResult, 'readOpenOrders');
                        }
                    } else if (diff > 0) {
                        bot._log(
                            `[LIGHTWEIGHT-SYNC] Order count mismatch: chain=${chainOrdersCount}, grid=${gridActive} ` +
                            `(diff=${diff}). Minor divergence — expected during normal operation.`,
                            'debug'
                        );
                    }
                }
            }
        } catch (e) {
            bot._log(`[LIGHTWEIGHT-SYNC] Check failed: ${getErrorMessage(e)}`, 'debug');
        }
    }

    // Process any price corrections queued by prior sync operations before
    // the pipeline gate. Pending corrections block isPipelineEmpty, and no
    // other code path clears them outside of _consumeFillQueue (which only
    // runs when new fills arrive). Without this, a single correction queued
    // during startup or periodic sync can stall the pipeline indefinitely.
    const pendingCorrections = bot.manager.ordersNeedingPriceCorrection?.length || 0;
    if (pendingCorrections > 0) {
        const correctionResult = await correctAllPriceMismatches(
            bot.manager, bot.account, bot.privateKey, chainOrders
        );
        if (correctionResult.failed > 0) {
            const failedDetails = (correctionResult.results || [])
                .filter((r: { result?: { success?: unknown } }) => !(r.result && r.result.success))
                .slice(0, 3)
                .map((r: { chainOrderId?: unknown; result?: { error?: unknown } }) => `${r.chainOrderId ?? '?'}: ${r.result?.error ?? 'unknown'}`)
                .join(' | ');
            bot._warn(
                `[MAINT] ${correctionResult.failed}/${pendingCorrections} price correction(s) failed` +
                (failedDetails ? ` — ${failedDetails}` : '') +
                (correctionResult.staleDropped > 0 ? ` (${correctionResult.staleDropped} stale dropped)` : '')
            );
        } else if (correctionResult.staleDropped > 0) {
            bot._log(
                `[MAINT] ${correctionResult.corrected}/${pendingCorrections} price correction(s) resolved, ` +
                `${correctionResult.staleDropped} stale dropped (resync moved the slot; re-queued by next sync if still off-target)`,
                'info'
            );
        }
    }

    // Dust detection runs before the pipeline gate. Cancellation is immediate
    // (no 30s delay) and stays inside the empty-pipeline branch to avoid racing.
    let healthResult = await bot.manager.checkGridHealth(bot.updateOrdersOnChainPlan.bind(bot));
    if (await bot._abortFlowIfIllegalState(`${context} health check`)) return;

    const pipelineStatus = bot.manager.isPipelineEmpty(bot._getPipelineSignals());
    if (pipelineStatus.isEmpty) {
        const repairedFromTarget = await maybeRunTargetedDriftReconciliation(bot, context);
        if (repairedFromTarget) {
            const freshHealth = await bot.manager.checkGridHealth(bot.updateOrdersOnChainPlan.bind(bot));
            if (await bot._abortFlowIfIllegalState(`${context} post-reconcile health check`)) return;
            healthResult = freshHealth;
        }

        // NOTE: no unmatched-orphan auto-cancel here any more. The
        // price-drift-orphan tag came from the legacy tolerance band, which no
        // longer exists: an off-grid chain order is HELD (out-of-grid-deferred)
        // and resolved structurally, never cancelled off a fuzzy price diff.

        refreshDynamicWeightDistribution(bot, context);

        const dustCancelResult = await cancelDustOrders(bot, {
            buy: healthResult.buyDustOrders as ManagedOrder[] | undefined,
            sell: healthResult.sellDustOrders as ManagedOrder[] | undefined,
        });
        if (dustCancelResult?.batchResult?.aborted) {
            return;
        }

        try {
            const persistedGridData = bot.accountOrders.loadGrid(true) || [];
            const calculatedGrid = Array.from(bot.manager.orders.values());

            // Clear divergence flags immediately before detection so _gridSidesUpdated
            // only reflects sides flagged by monitorDivergence in this tick. The top-of-tick
            // clear already handles stale flags from prior ticks; this second clear is a
            // belt-and-suspenders guard against anything accidentally setting the flag
            // between the top clear and here (nothing currently does).
            bot.manager._gridSidesUpdated?.clear();

            const divergence = await grid.monitorDivergence(bot.manager, calculatedGrid, persistedGridData);

            if (divergence.needsUpdate) {
                const hasRmsDivergence = !!(divergence.buy.rms || divergence.sell.rms);
                if (divergence.buy.ratio || divergence.sell.ratio) {
                    const buyDir = divergence.buy.shrink ? '/shrink' : '';
                    const sellDir = divergence.sell.shrink ? '/shrink' : '';
                    bot._log(`Grid update triggered by funds during ${context} (buy: ${divergence.buy.ratio}${buyDir}, sell: ${divergence.sell.ratio}${sellDir})`);
                }
                if (hasRmsDivergence) {
                    const rmsThresholdPct = divergence?.thresholdPct ?? grid.resolveRmsThresholdPct(bot.manager);
                    const rmsTriggeredSides = [
                        divergence.buy.rms ? 'buy' : null,
                        divergence.sell.rms ? 'sell' : null,
                    ].filter(Boolean).join('+') || 'none';
                    bot._log(`[RMS] Grid update triggered by structural divergence during ${context}: buy=${Format.formatPercent(Number(divergence.buy.metric) * 100, 2)}% sell=${Format.formatPercent(Number(divergence.sell.metric) * 100, 2)}% (threshold=${rmsThresholdPct}%) sides=${rmsTriggeredSides} → TRIGGER-RESYNC (rms_structural_grid_resync)`);
                    let ok;
                    if (typeof bot._performGridResync === 'function') {
                        ok = await bot._performGridResync(buildGridResyncOptions('rms_structural_grid_resync'));
                    } else {
                        ok = await performGridResync(bot, buildGridResyncOptions('rms_structural_grid_resync'));
                    }
                    if (!ok) {
                        bot._warn(`[RMS] Structural divergence full grid resync failed during ${context}; retaining existing grid state.`);
                    }
                    return;
                }

                let dcResult;
                try {
                    dcResult = await applyGridDivergenceCorrections(
                        bot.manager,
                        bot.accountOrders,
                        bot.config.botKey,
                        bot.updateOrdersOnChainBatch.bind(bot),
                        updateGridFromBlockchainSnapshot
                    );
                    if (await bot._abortFlowIfIllegalState(`${context} divergence correction`)) return;
                    bot._log(`Grid divergence corrections applied during ${context}`);
                } catch (err) {
                    bot._warn(`Error applying divergence corrections during ${context}: ${getErrorMessage(err)}`);
                }

                // Divergence never shifts the boundary (fills move it via
                // deriveTargetBoundary; spread promotion shifts only onto
                // same-batch placements), so a failed commit has no pending
                // geometry to retry — the next fill/sync cycle re-plans from
                // the unchanged committed state.
                if (dcResult && !dcResult.committed) {
                    bot._log(
                        `[DIVERGENCE-COW] Divergence corrections not executed (reason=${dcResult.reason ?? 'unknown'}); ` +
                        `deferring to next fill/sync cycle`,
                        'warn'
                    );
                }
            }

            // Independent spread check — intentionally NOT gated behind divergence
            // detection. Divergence measures internal grid-vs-ideal structure (fund
            // ratio / RMS drift); a wide realized spread can exist even when the
            // grid looks internally consistent — e.g. after a stale-order cleanup
            // zeroed boundary-adjacent sell slots and a reconcile backfilled far-end
            // slots instead (order count restored 20/20, so divergence never flags).
            // Running the spread check here every pipeline-empty tick catches that
            // case via prepareSpreadCorrectionOrders' orphaned-virtual candidates.
            //
            // checkSpreadCondition holds _gridLock, uses the committed boundary,
            // and re-plans on fund change, so this tick is race-safe whenever
            // it runs.
            // Re-check the fill queue: fills may have arrived during this
            // tick's earlier phases (health check, dust cancels, divergence
            // corrections), after the pipeline gate above passed. Sizing a
            // correction from pre-fill budgets would under/over-fund the
            // repair — defer to the next tick so the fill cycle runs first
            // and side choice + sizing read fresh funds.
            const queuedFills = Array.isArray(bot?._incomingFillQueue)
                ? bot._incomingFillQueue.length
                : 0;
            if (queuedFills > 0) {
                bot._log(
                    `[SPREAD] Deferring spread check: ${queuedFills} fill(s) queued since pipeline gate; ` +
                    `processing fills first for fresh funds`,
                    'debug'
                );
            } else {
                const spreadResult = await bot.manager.checkSpreadCondition(BitShares, bot.updateOrdersOnChainPlan.bind(bot));
                if (await bot._abortFlowIfIllegalState(`${context} spread check`)) return;
                // Mirror the stall cause and arm the targeted-sync refresh for
                // every cause. The check can report 'no-candidates' on a stale
                // local snapshot (a missed fill leaves an ACTIVE slot hiding the
                // tightening slot), so the refresh must fire here too rather than
                // wait for trackOutOfSpreadStaleness to re-center. The stall cause
                // is kept so the next tick's reason names the truth.
                mirrorSpreadStall(bot, spreadResult?.stall ?? null);
                const spreadPlaced = Number(spreadResult?.ordersPlaced) || 0;
                if (spreadPlaced > 0) {
                    bot._log(`✓ Spread correction during ${context}: ${spreadResult.ordersPlaced} order(s) placed`);
                    await bot._persistAndRecoverIfNeeded();
                }
                // Persistence watchdog: a correction that keeps placing nothing
                // while the spread stays wide is a stale grid, not patience.
                trackOutOfSpreadStaleness(bot, true, spreadPlaced, spreadResult?.transient === true);
            }
        } catch (err) {
            bot._warn(`Error running divergence check during ${context}: ${getErrorMessage(err)}`);
        }
    } else {
        const totalDust = (healthResult.buyDustOrders?.length || 0) + (healthResult.sellDustOrders?.length || 0);
        if (totalDust > 0 && bot._lastDeferredDustCount !== totalDust) {
            bot._log(`[MAINT] ${totalDust} dust order(s) deferred — pipeline non-empty (${pipelineStatus.reasons?.join(', ') ?? '(unknown)'})`);
            bot._lastDeferredDustCount = totalDust;
        }
    }
}

/**
 * Clear the geometry-bind re-center memory (one re-center per fill pivot).
 * Called whenever the spread actually heals — a placement or a sustained
 * in-tolerance run — so a later geometry bind on a *different* pivot starts
 * with a fresh budget.
 * @param {Object} bot - DEXBot instance
 */
function clearGeometryResyncMemory(bot: BotLike) {
    if (!bot) return;
    bot._lastGeometryResyncPivotKey = '';
    bot._geometryResyncWarnedPivotKey = '';
}

/**
 * Out-of-spread persistence watchdog: the never-run-stale backstop.
 *
 * The spread check retries every pipeline-empty tick (level-triggered), but a
 * correction can keep producing zero candidates indefinitely (no funded side,
 * no correctable slots) while the grid sits stale — and the identical-held-
 * plan suppression blocks fill-less replans until a fresh fill that a stale
 * grid cannot produce. Time-based (not tick-counted) so it holds for any
 * maintenance cadence: warn once past SPREAD_STALE_WARN_MS, then request a
 * structural re-center past SPREAD_STALE_ESCALATE_MS (existing resync guards
 * dedupe concurrent requests; the re-center moves the boundary, which clears
 * any held-plan signature). Resets whenever the spread heals or a correction
 * places orders.
 * @param {unknown} bot
 * @param {boolean} spreadChecked - Whether the spread check ran this tick
 * @param {number} ordersPlaced - Correction orders placed this tick
 * @param {boolean} [transient=false] - True when the correction was refused for
 *   a retryable reason (stale plan / duplicate CREATE / unclassified non-execution)
 * @returns {{staleMs: number, escalated: boolean}}
 */
export function trackOutOfSpreadStaleness(bot: BotLike, spreadChecked: boolean, ordersPlaced: number, transient = false) {
    const outOfSpread = Number(bot?.manager?.outOfSpread) || 0;
    const nowMs = Date.now();
    const inToleranceResetMs = Number(TIMING?.SPREAD_STALE_IN_TOLERANCE_RESET_MS) > 0
        ? Number(TIMING.SPREAD_STALE_IN_TOLERANCE_RESET_MS)
        : 10 * 60 * 1000;
    if (ordersPlaced > 0) {
        bot._outOfSpreadSince = 0;
        bot._outOfSpreadStaleWarned = false;
        bot._outOfSpreadTransientCount = 0;
        bot._outOfSpreadToleranceSince = 0;
        clearGeometryResyncMemory(bot);
        try { bot.manager._spreadRailOversubscribed = null; } catch { /* best-effort */ }
        return { staleMs: 0, escalated: false };
    }
    if (outOfSpread === 0) {
        // ONE good reading must not clear the clock. The measured spread
        // oscillates around the tolerance edge, so resetting on each
        // in-tolerance cycle let a live bot stay out of tolerance for 84
        // minutes while every individual glance looked recoverable (the
        // correction placed nothing in that whole window). Clear only after
        // tolerance has held for the reset window; a placement clears it
        // immediately (handled above).
        const toleranceSince = Number(bot._outOfSpreadToleranceSince) || 0;
        if (toleranceSince === 0) {
            bot._outOfSpreadToleranceSince = nowMs;
            return { staleMs: 0, escalated: false };
        }
        if (nowMs - toleranceSince < inToleranceResetMs) return { staleMs: 0, escalated: false };
        bot._outOfSpreadSince = 0;
        bot._outOfSpreadStaleWarned = false;
        bot._outOfSpreadTransientCount = 0;
        bot._outOfSpreadToleranceSince = 0;
        clearGeometryResyncMemory(bot);
        try { bot.manager._spreadRailOversubscribed = null; } catch { /* best-effort */ }
        return { staleMs: 0, escalated: false };
    }
    bot._outOfSpreadToleranceSince = 0;
    if (!spreadChecked) {
        const since = Number(bot._outOfSpreadSince) || 0;
        return { staleMs: since > 0 ? Date.now() - since : 0, escalated: false };
    }
    const now = Date.now();
    // Transient refusals (stale plan / duplicate CREATE / unclassified
    // non-execution) are retried by checkSpreadCondition's bounded re-plan, so
    // they must not immediately count toward the persistent-stale clock — a
    // single concurrent commit would otherwise force a structural re-center.
    // Count them and restart the clock while under the grace budget; past it,
    // fall through so a genuinely deadlocked transient still heals.
    if (transient) {
        const transientCount = (Number(bot._outOfSpreadTransientCount) || 0) + 1;
        bot._outOfSpreadTransientCount = transientCount;
        const grace = Number(TIMING?.SPREAD_STALE_TRANSIENT_GRACE) > 0
            ? Number(TIMING.SPREAD_STALE_TRANSIENT_GRACE)
            : 3;
        if (transientCount <= grace) {
            bot._outOfSpreadSince = now;
            bot._outOfSpreadStaleWarned = false;
            bot._log(
                `[SPREAD-STALE] Transient spread-correction refusal ${transientCount}/${grace} ` +
                `(outOfSpread=${outOfSpread}); retrying before any structural re-center`,
                'warn'
            );
            return { staleMs: 0, escalated: false };
        }
    } else {
        bot._outOfSpreadTransientCount = 0;
    }
    if (!Number(bot._outOfSpreadSince)) bot._outOfSpreadSince = now;
    const staleMs = now - Number(bot._outOfSpreadSince);
    const staleMin = Math.round(staleMs / 60000);
    const warnMs = Number(TIMING?.SPREAD_STALE_WARN_MS) > 0
        ? Number(TIMING.SPREAD_STALE_WARN_MS)
        : 10 * 60 * 1000;
    // An oversubscribed rail is a fund-structure stall, not "wait for a fill":
    // escalate on the short fund window so the side is not dead for half an hour.
    const railOversubscribed = bot.manager?._spreadRailOversubscribed;
    const oversubscribedFresh = !!railOversubscribed && typeof railOversubscribed === 'object'
        && (now - Number(railOversubscribed.at || 0)) < 5 * 60 * 1000;
    const fundEscalateMs = Number(TIMING?.SPREAD_STALE_FUND_ESCALATE_MS) > 0
        ? Number(TIMING.SPREAD_STALE_FUND_ESCALATE_MS)
        : 5 * 60 * 1000;
    // The geometry bind has its own (longer than funds, shorter than structural)
    // window: the window is behind the last fill, which a re-center repairs by
    // re-deriving the center AROUND that same fill. Capped at ONE re-center per
    // pivot value: the re-center does not move the pivot, so a second attempt on
    // the same fill re-derives the same veto (the pivot can sit outside the new
    // grid's placeable side when the market has moved far away) and would only
    // cancel/re-place the new generation every cooldown. Until a fill refreshes
    // the pivot (or it expires), the honest repair is a fill — so report once
    // and stop.
    const geometryBlocked = bot._spreadCorrectionStall === 'last-fill-blocked';
    let geometryPivotKey = '';
    if (geometryBlocked) {
        try {
            const ref = resolveLastFillGuardReference(bot.manager);
            if (ref?.price != null && Number.isFinite(Number(ref.price))) geometryPivotKey = `${Number(ref.price)}|${String(ref.type ?? '')}`;
        } catch { geometryPivotKey = ''; }
    }
    const geometryAlreadyRecentered = geometryBlocked && !!geometryPivotKey
        && bot._lastGeometryResyncPivotKey === geometryPivotKey;
    const geometryEscalateMs = Number(TIMING?.SPREAD_STALE_GEOMETRY_ESCALATE_MS) > 0
        ? Number(TIMING.SPREAD_STALE_GEOMETRY_ESCALATE_MS)
        : 10 * 60 * 1000;
    const escalateMs = oversubscribedFresh
        ? fundEscalateMs
        : geometryAlreadyRecentered
            // Do not re-center again for the same fill. Out of the escalation
            // ladder entirely: a fill (or the pivot TTL) is the only heal.
            ? Number.POSITIVE_INFINITY
            : geometryBlocked
                ? geometryEscalateMs
                : (Number(TIMING?.SPREAD_STALE_ESCALATE_MS) > 0
                    ? Number(TIMING.SPREAD_STALE_ESCALATE_MS)
                    : 30 * 60 * 1000);
    if (geometryAlreadyRecentered && staleMs >= warnMs && bot._geometryResyncWarnedPivotKey !== geometryPivotKey) {
        bot._geometryResyncWarnedPivotKey = geometryPivotKey;
        bot._log(
            `[SPREAD-STALE] Still out of tolerance ${staleMin}min after re-centering on fill pivot ` +
            `${geometryPivotKey.split('|')[0]}: the pivot is outside this generation's placeable side, so a re-center ` +
            `cannot clear it. A fill (buy back below / sell above the pivot) or pivot expiry restores the side; ` +
            `no further re-center will be requested for this pivot.`,
            'warn'
        );
    }
    if (staleMs >= warnMs && !bot._outOfSpreadStaleWarned) {
        bot._outOfSpreadStaleWarned = true;
        const stall = bot._spreadCorrectionStall ? `, stall=${bot._spreadCorrectionStall}` : '';
        bot._log(
            `[SPREAD-STALE] Spread out of tolerance for ${staleMin}min with no correction placed ` +
            `(outOfSpread=${outOfSpread}${stall}); structural re-center follows if unhealed`,
            'warn'
        );
    }
    if (staleMs >= escalateMs && typeof bot.manager?.requestStructuralGridResync === 'function') {
        // Dedicated spread-stale cooldown (NOT BOUNDARY_HOLD_RESYNC_COOLDOWN_MS:
        // the two watchdogs must tune independently). Falls back to the legacy
        // boundary-hold key only for operators who overrode it before the split,
        // then to the 5min default.
        const cooldownMs = Number(TIMING?.SPREAD_STALE_RESYNC_COOLDOWN_MS) > 0
            ? Number(TIMING.SPREAD_STALE_RESYNC_COOLDOWN_MS)
            : Number(TIMING?.BOUNDARY_HOLD_RESYNC_COOLDOWN_MS) > 0
                ? Number(TIMING.BOUNDARY_HOLD_RESYNC_COOLDOWN_MS)
                : 5 * 60 * 1000;
        const lastAt = Number(bot._lastSpreadStaleResyncAt) || 0;
        if (now - lastAt >= cooldownMs) {
            bot._lastSpreadStaleResyncAt = now;
            if (geometryBlocked && geometryPivotKey) bot._lastGeometryResyncPivotKey = geometryPivotKey;
            bot._log(
                `[SPREAD-STALE] Spread out of tolerance for ${staleMin}min despite corrections` +
                `${oversubscribedFresh ? ' (rail oversubscribed — re-sizing from chain truth)' : ''}` +
                `${geometryBlocked ? ' (sell window behind the last fill — re-centering)' : ''}` +
                `${bot._spreadCorrectionStall ? ` (stall=${bot._spreadCorrectionStall})` : ''}; ` +
                `requesting structural re-center`,
                'warn'
            );
            fireStructuralResync(bot, 'spread-stale-persistent', {
                reason: `Spread out of tolerance for ${staleMin}min with no effective correction (outOfSpread=${outOfSpread})`
            }, '[SPREAD-STALE] Structural re-center request failed');
            return { staleMs, escalated: true };
        }
    }
    return { staleMs, escalated: false };
}

/**
 * Cancel a single order, deferring on an uncertain daemon broadcast.
 * The credential daemon retries internally only failures that provably never
 * reached the chain (pre-transmit connect/send errors); on BROADCAST_DEADLINE
 * (or any uncertain outcome) it never re-signs, and the credential client
 * propagates a BroadcastUncertainError — the outcome is unknown and re-sending
 * could duplicate a landed cancel. No node is blacklisted here: without an
 * explicit nodeUrl the daemon chose the node, so there is no single node to
 * blame. The next dust-detection cycle re-attempts.
 *
 * The daemon's session is validated early in processRequest (before the
 * broadcast), so a BROADCAST_DEADLINE reply cannot be caused by an expired
 * session — re-using the original signing token is correct.
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {import('./types.js').Order} order
 * @returns {Promise<*>} Result from chainOrders.cancelOrder
 */
async function cancelOrderDeferredOnUncertain(bot: BotLike, order: { orderId?: string | null; id?: unknown }) {
    try {
        // Test seam: compiled ESM exports cannot be monkey-patched, so tests
        // may override cancellation through this bot-level hook.
        if (typeof bot._submitCancelOrder === 'function') {
            return await bot._submitCancelOrder(String(order.orderId));
        }
        return await chainOrders.cancelOrder(bot.account, bot.privateKey, String(order.orderId));
    } catch (err) {
        if (err instanceof BroadcastUncertainError) {
            bot._warn(`[DUST] Broadcast uncertain for ${order.id} (${order.orderId}); outcome deferred to chain verification`);
        }
        throw err;
    }
}

/**
 * Cancel dust orders immediately — no delay, no timer, no maps.
 * Each dust order is cancelled on chain and its slot is rotated through
 * the normal synthetic-fill pipeline. Failures are logged and retried on
 * the next detection cycle (next fill batch or 5-min health check).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} [options] - Dust cancellation options
 * @param {import('./types.js').Order[]} [options.buy=[]] - Buy-side dust orders
 * @param {import('./types.js').Order[]} [options.sell=[]] - Sell-side dust orders
 * @returns {Promise<{cancelledCount: number, batchResult: {aborted: boolean}|null}>}
 */
async function cancelDustOrders(bot: BotLike, { buy: buyDust = [], sell: sellDust = [] }: { buy?: ManagedOrder[]; sell?: ManagedOrder[] } = {}) {
    const allDust = [...buyDust, ...sellDust];
    if (allDust.length === 0) return { cancelledCount: 0, batchResult: null };

    const syntheticFills: unknown[] = [];
    for (const order of allDust) {
        if (!order.orderId) continue;
        try {
            const cancelResult = await cancelOrderDeferredOnUncertain(bot, order);
            try {
                if ((cancelResult as { verifiedAfterFailure?: boolean } | null)?.verifiedAfterFailure) {
                    const accountRef = bot.accountId || bot.account;
                    // The cancel was verified absent on an authoritative
                    // (non-empty, non-truncated) read inside cancelOrder, so an
                    // ambiguous refetch must not run the full sync: the snapshot
                    // omits the freshest orders and pass-1 phantom cleanup could
                    // virtualize live slots. Fall back to the local cancel sync.
                    const freshOrders = await readOpenOrdersGuarded(chainOrders, accountRef, {
                        log: (message: string) => bot._warn(message),
                        label: 'DUST',
                        deferEmpty: true,
                        skipMessage: (kind: string) =>
                            `[DUST] Chain refetch after verified cancel is ${kind}; applying local cancel sync for ${order.id}`,
                    });
                    if (freshOrders === null) {
                        await bot.manager.synchronizeWithChain({ orderId: order.orderId, clearSize: true }, 'cancelOrder');
                    } else {
                        await bot.manager.synchronizeWithChain(freshOrders, 'readOpenOrders');
                    }
                } else {
                    await bot.manager.synchronizeWithChain({ orderId: order.orderId, clearSize: true }, 'cancelOrder');
                }
            } catch (refetchErr) {
                bot._warn(`[DUST] Cancel succeeded but refetch failed for ${order.id} (${order.orderId}): ${getErrorMessage(refetchErr)}`);
            }
            syntheticFills.push({ ...order, isPartial: true, isDelayedRotationTrigger: true });
            bot._log(`[DUST] Cancelled ${order.id} (${order.orderId}) size=${order.size}`, 'debug');
        } catch (err) {
            const errMsg = getErrorMessage(err) || '';
            if (isOrderDoesNotExistError(errMsg, order.orderId)) {
                syntheticFills.push({ ...order, isPartial: true, isDelayedRotationTrigger: true });
                bot._log(`[DUST] Order ${order.id} (${order.orderId}) already gone from chain`, 'debug');
            } else {
                bot._warn(`[DUST] Failed to cancel ${order.id} (${order.orderId}): ${errMsg}`);
            }
        }
    }

    if (syntheticFills.length === 0) return { cancelledCount: 0, batchResult: null };
    const result = await bot._processFillsWithBatching(
        syntheticFills, new Set(), `dust cancel [${syntheticFills.map((o) => (o as { id?: unknown }).id).join(', ')}]`, { skipAnchorUpdate: true }
    );
    if (!result.aborted) {
        await bot.manager.persistGrid();
    }
    return { cancelledCount: syntheticFills.length, batchResult: { aborted: result.aborted } };
}

/**
 * Run grid maintenance with idle detection and lock acquisition.
 * Checks if the bot is idle before proceeding, and acquires the fill processing lock.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} [context='periodic'] - Context label for logging
 * @param {Object} [options] - Maintenance options
 * @param {boolean} [options.skipIdle=false] - Skip idle delay check
 * @returns {Promise<void>}
 */
async function runGridMaintenance(
    bot: BotLike,
    context: string = 'periodic',
    options: { skipIdle?: boolean } = {}
) {
    const skipIdle = options.skipIdle === true;
    if (!skipIdle) {
        const idleDelayMs = getMaintenanceIdleDelayMs(bot as unknown as MaintenanceCtx);
        if (idleDelayMs > 0) {
            bot._log(
                `[MAINT-IDLE] Deferring ${context} grid maintenance until ` +
                `${Math.ceil(idleDelayMs / TIMING.MILLISECONDS_PER_SECOND)}s of inactivity has passed`,
                'debug'
            );
            scheduleMaintenanceAfterIdle(bot as unknown as MaintenanceCtx, context, options);
            return;
        }
    }

    try {
        if (!bot.manager) return;

        const runWithDivergenceLock = async () => {
            // Re-check orders size under the divergence lock to avoid a TOCTOU
            // race with concurrent order mutations. The previous placement
            // (before any lock acquisition) could observe a stale empty
            // grid and silently skip maintenance while fills were in flight.
            if (!bot.manager.orders || bot.manager.orders.size === 0) return;
            await executeMaintenanceLogic(bot, context);
        };

        await bot.manager._fillProcessingLock.acquire(async () => {
            await bot.manager._divergenceLock.acquire(runWithDivergenceLock);
        });
    } catch (err) {
        bot._warn(`Error during ${context} grid maintenance: ${getErrorMessage(err)}`);
        throw err;
    }
}

const _lastBtsAcquisitionTimestamps = new Map();

/**
 * Check if the bot's BTS balance is below the minimum threshold and trigger acquisition.
 * Only applies to non-BTS pairs. Uses hysteresis: triggers at 1× min_BTS_value,
 * fills to BTS_ACQUIRE_TARGET_MULTIPLIER × min_BTS_value.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Promise<void>}
 */
async function checkBtsBalanceAndAcquire(bot: BotLike) {
    if (bot.config.dryRun) return;
    if (bot.config.assetA === 'BTS' || bot.config.assetB === 'BTS') return;

    const cooldownMin = bot.config?.timing?.BTS_ACQUIRE_COOLDOWN_MIN as number;
    const cooldownMs = cooldownMin * 60 * 1000;
    const now = Date.now();

    // Prune every expired entry in the map, not just the current bot's.
    // Otherwise entries for bots that acquired BTS and then stopped calling
    // (removed from bots.json, supervisor restart with a different roster)
    // would persist forever. The map is bounded by the number of unique bot
    // keys that ever acquired BTS, so this O(n) sweep is cheap.
    for (const [key, ts] of _lastBtsAcquisitionTimestamps) {
        if ((now - ts) >= cooldownMs) {
            _lastBtsAcquisitionTimestamps.delete(key);
        }
    }

    const botKey = bot.config.botKey || bot.config.name;
    const lastAcq = _lastBtsAcquisitionTimestamps.get(botKey);
    if (lastAcq && (now - lastAcq) < cooldownMs) return;

    if (!bot.manager || !bot.manager.btsBalance) return;

    const totalTarget = getCoreOrdersTotal(bot.config);

    const btsReservationMultiplier = bot.config?.feeParams?.BTS_RESERVATION_MULTIPLIER;
    const minBtsVal = calculateOrderCreationFees(
        bot.config.assetA, bot.config.assetB, totalTarget,
        btsReservationMultiplier
    );
    if (minBtsVal <= 0) return;

    const effectiveMin = ((bot.config.min_BTS_value ?? 0) > 0) ? (bot.config.min_BTS_value as number) : minBtsVal;
    const btsFree = bot.manager.btsBalance.free || 0;
    const btsAcquireThreshold = bot.config?.feeParams?.BTS_ACQUIRE_THRESHOLD as number;
    const triggerAt = effectiveMin * btsAcquireThreshold;
    if (btsFree >= triggerAt) return;

    const btsAcquireTargetMultiplier = bot.config?.feeParams?.BTS_ACQUIRE_TARGET_MULTIPLIER as number;
    const target = effectiveMin * btsAcquireTargetMultiplier;
    const deficit = Math.max(0, target - btsFree);
    bot._log(
        `[BTS-ACQ] BTS balance ${Format.formatAmount8(btsFree)} below threshold ${Format.formatAmount8(triggerAt)}. ` +
        `Acquiring ${Format.formatAmount8(deficit)} BTS (target: ${Format.formatAmount8(target)})`,
        'info'
    );
    _lastBtsAcquisitionTimestamps.set(botKey, Date.now());
    await acquireBts(bot, deficit);
}

/**
 * Acquire BTS by swapping one of the trading pair assets through an AMM pool.
 * Tries both assets for a BTS pool, picks the best (lowest price impact).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {number} deficit - Amount of BTS needed (float)
 * @returns {Promise<void>}
 */
async function acquireBts(bot: BotLike, deficit: number) {
    if (deficit <= 0) return;
    const { BitShares } = require('./bitshares_client');
    if (!BitShares || !BitShares.db) return;

    const coreAssetId = NATIVE_CLIENT.CHAIN.CORE_ASSET_ID;
    const assets = [
        { id: bot.assets?.assetA?.id, free: bot.manager.accountTotals?.sellFree || 0, precision: bot.assets?.assetA?.precision, symbol: bot.config.assetA },
        { id: bot.assets?.assetB?.id, free: bot.manager.accountTotals?.buyFree || 0, precision: bot.assets?.assetB?.precision, symbol: bot.config.assetB }
    ];

    const candidates: PoolCandidate[] = [];
    for (const asset of assets) {
        if (!asset.id || asset.free <= 0) continue;
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_both_assets(asset.id, coreAssetId);
            const validPools = Array.isArray(pools) ? pools.filter((p) => p?.id) : [];
            const poolData = validPools.length
                ? validPools.sort((a, b) => {
                    const getBtsBal = (p: JsonObj) => {
                        const isBts = String(p.asset_a ?? (p.asset_ids as unknown[] | undefined)?.[0] ?? '') === String(coreAssetId);
                        return Number(isBts ? (p.balance_a ?? 0) : (p.balance_b ?? 0));
                    };
                    return getBtsBal(b) - getBtsBal(a);
                })[0]
                : null;
            if (!poolData) continue;

            const isAssetA = String(poolData.asset_a) === String(asset.id) || String(poolData.asset_ids?.[0]) === String(asset.id);
            const assetReserveRaw = isAssetA ? (poolData.balance_a || poolData.reserves?.[0]?.amount) : (poolData.balance_b || poolData.reserves?.[1]?.amount);
            const btsReserveRaw = isAssetA ? (poolData.balance_b || poolData.reserves?.[1]?.amount) : (poolData.balance_a || poolData.reserves?.[0]?.amount);
            if (!assetReserveRaw || !btsReserveRaw) continue;

            const assetReserve = blockchainToFloat(assetReserveRaw, asset.precision);
            const btsReserve = blockchainToFloat(btsReserveRaw, BTS_PRECISION);
            const expectedReceive = Math.min(deficit, btsReserve * 0.5);
            const sellAmount = calculateSwapInAmount(deficit, btsReserve, assetReserve);
            if (sellAmount <= 0 || sellAmount > asset.free) continue;

            candidates.push({ asset, poolId: poolData.id, sellAmount, expectedReceive, priceImpact: sellAmount / assetReserve });
        } catch (e) {
            bot._log(`[BTS-ACQ] Pool lookup failed for ${asset?.symbol}: ${getErrorMessage(e)}`, 'debug');
        }
    }

    if (candidates.length === 0) {
        bot._log(`[BTS-ACQ] CRITICAL: No BTS pool with sufficient liquidity for ${bot.config.assetA} or ${bot.config.assetB}`, 'error');
        return;
    }

    candidates.sort((a, b) => a.priceImpact - b.priceImpact);
    const best = candidates[0];

    const poolSlippageTolerance = bot.config?.feeParams?.POOL_SLIPPAGE_TOLERANCE as number;
    const minReceive = best.expectedReceive * (1 - poolSlippageTolerance);
    const sellInt = floatToBlockchainInt(best.sellAmount, best.asset.precision);
    const minReceiveInt = floatToBlockchainInt(minReceive, BTS_PRECISION);
    const op = chainOrders.buildLiquidityPoolExchangeOp(bot.accountId, best.poolId as string, sellInt, best.asset.id as string, minReceiveInt, coreAssetId);

    try {
        if (bot.privateKey) {
            await chainOrders.executeBatch(bot.account, bot.privateKey, [op]);
        } else {
            bot._log('[BTS-ACQ] CRITICAL: No signing method available', 'error');
            return;
        }
    } catch (err) {
        bot._log(`[BTS-ACQ] Swap broadcast failed: ${getErrorMessage(err)}`, 'error');
        return;
    }

    const orderType = (best.asset.id === bot.assets?.assetA?.id) ? 'sell' : 'buy';
    if (bot.manager.accountant) {
        await bot.manager.accountant.adjustTotalBalance(orderType, -best.sellAmount, 'bts-acquisition-swap-sell');
    }
    // Do NOT optimistically bump btsBalance.free/total here. expectedReceive is
    // a pre-swap estimate and may diverge from the actual fill (slippage, fees,
    // partial fills, broadcast/confirm failures). The next periodic
    // fetchAccountTotals() reconciles from chain truth. The bts-acquisition
    // cooldown in checkBtsBalanceAndAcquire prevents immediate re-trigger even
    // if the chain balance is still below the trigger threshold.

    bot._log(`[BTS-ACQ] Acquired ~${Format.formatAmount8(best.expectedReceive)} BTS: sold ${Format.formatAmount8(best.sellAmount)} ${best.asset.symbol} via pool ${best.poolId}`, 'info');
}

/**
 * Run a single dust health check cycle.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
async function runDustHealthCheck(bot: BotLike) {
    if (bot._shuttingDown || !bot.manager) return;
    try {
        const health = await bot.manager.checkGridHealth(
            bot.updateOrdersOnChainPlan?.bind(bot)
        );
        const buyDust = health.buyDustOrders || [];
        const sellDust = health.sellDustOrders || [];
        const totalDust = buyDust.length + sellDust.length;
        if (totalDust > 0) {
            bot._log(`[DUST] Health check: ${totalDust} dust order(s) (buy=${buyDust.length}, sell=${sellDust.length})`);
            const lock = bot.manager._fillProcessingLock;
            if (lock && typeof lock.acquire === 'function') {
                await lock.acquire(async () => {
                    await bot._cancelDustOrders({
                        buy: health.buyDustOrders,
                        sell: health.sellDustOrders,
                    });
                }, { timeout: TIMING.DUST_CANCEL_TIMEOUT_MS });
            } else {
                // Lock-bypass guard: never cancel dust without the fill lock.
                // _cancelDustOrders rotates slots through the synthetic-fill
                // pipeline (mutating grid + broadcasting), which races the fill
                // consumer if run concurrently. When the lock is unavailable
                // (shutdown/teardown or a partial manager), defer instead — the
                // dust orders stay on the book and are picked up by the next
                // periodic maintenance tick or fill batch, both of which run
                // under the lock.
                bot._warn('[DUST] Fill lock unavailable — deferring dust cancel to the next locked maintenance cycle (skipped this tick to avoid racing fill processing)');
            }
        }
    } catch (err) {
        if (getErrorMessage(err).includes('Lock acquisition timeout')) {
            bot._warn('[DUST] Lock busy, skipping dust cancel this cycle (retry in 5 min)');
        } else {
            bot._warn(`[DUST] Health check error (retry in 5 min): ${getErrorMessage(err)}`);
        }
    }
}

/**
 * Set up the periodic dust health check interval.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function setupDustHealthCheckInterval(bot: BotLike) {
    bot._dustHealthCheckTimer = setInterval(() => {
        runDustHealthCheck(bot);
    }, TIMING.DUST_HEALTH_CHECK_INTERVAL_MS);
    if (typeof bot._dustHealthCheckTimer?.unref === 'function') {
        bot._dustHealthCheckTimer.unref();
    }
}

/**
 * Retrigger the fill consumer once the recovery/pipeline window has fully
 * cleared. The consumer's defer branch (batchInFlight / recoverySyncInFlight /
 * broadcasting) returns WITHOUT rescheduling, so fills enqueued during a long
 * window would otherwise sit in the queue forever — which also keeps the
 * maintenance idle gate shut (queue-length check returns the full settle
 * delay) and blocks deferred grid resyncs and periodic maintenance.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function drainFillQueueAfterPipelineClear(bot: BotLike) {
    try {
        if (!bot || bot._shuttingDown) return;
        if ((bot._recoverySyncInFlight || 0) > 0) return;
        if ((bot._batchInFlight || 0) > 0) return;
        if (bot.manager?.isBroadcastingActive?.()) return;
        if (!bot._incomingFillQueue || bot._incomingFillQueue.length === 0) return;
        bot._log(`[FILL-QUEUE] Pipeline cleared; draining ${bot._incomingFillQueue.length} deferred fill(s).`, 'info');
        bot._deferredFillsPending = true;
        scheduleFillConsumerRestartFn(bot, chainOrders);
    } catch {}
}

/**
 * Request a full grid reset from fresh on-chain state.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} [reason='structural change']
 * @param {{refreshCenterPrice?: boolean, skipIdle?: boolean, skipFillLock?: boolean}} [options={}]
 * @returns {Promise<Object>}
 */
async function requestGridReset(bot: BotLike, reason: string = 'structural change', options: { refreshCenterPrice?: boolean; skipIdle?: boolean; skipFillLock?: boolean } = {}) {
    if (!bot.manager || typeof bot._performGridResync !== 'function') {
        return { skipped: true, reason: 'grid resync unavailable' };
    }

    const message = reason ? `[CR-RESET] ${reason}` : '[CR-RESET] grid reset requested';
    bot._log(`${message}; rebuilding grid from fresh on-chain state`, 'info');
    const resetOptions = {
        ...options,
        refreshCenterPrice: options.refreshCenterPrice !== false,
    };

    // Structural recovery resyncs are chain-read/rebuild operations that do not
    // mutate order state in place; running them behind the fill-processing lock
    // lets a fill storm starve recovery indefinitely. Skip the lock when the
    // caller explicitly requests it (structural resync wiring), when there is
    // no lock, or when re-entrant (already under the fill lock — acquire()
    // would just re-run the callback and we want the in-flight guard active
    // so the fill consumer defers fills entirely). While the rebuild runs
    // unlocked, raise _recoverySyncInFlight so the fill consumer defers fills
    // entirely (no concurrent mutation race) instead of racing them behind a
    // lock.
    if (options.skipFillLock === true || !bot.manager._fillProcessingLock || bot.manager._fillProcessingLock.isReentrant()) {
        bot._recoverySyncInFlight = (bot._recoverySyncInFlight || 0) + 1;
        try {
            return await performGridResync(bot, resetOptions);
        } finally {
            bot._recoverySyncInFlight = Math.max(0, (bot._recoverySyncInFlight || 0) - 1);
            if ((bot._recoverySyncInFlight || 0) === 0) drainFillQueueAfterPipelineClear(bot);
        }
    }

    return bot.manager._fillProcessingLock.acquire(async () => performGridResync(bot, resetOptions));
}

/**
 * Wire the structural grid resync request handler on the manager.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
function wireStructuralGridResyncRequest(bot: BotLike) {
    if (!bot.manager || bot.manager.requestStructuralGridResync) return;

    bot.manager.requestStructuralGridResync = async (reason: string = 'structural recovery', details: { unmatchedChainOrders?: unknown[]; [key: string]: unknown } = {}) => {
        if (bot._shuttingDown) {
            bot._warn(`[RECOVERY] Structural resync skip (shutting down): ${reason}`);
            return { skipped: true, reason: 'shutting down' };
        }

        if (bot._structuralGridResyncRunning || bot._structuralGridResyncTimer) {
            const why = bot._structuralGridResyncRunning ? 'already running' : 'already scheduled';
            bot._warn(`[RECOVERY] Structural resync skip (${why}): ${reason}`);
            return { skipped: true, reason: `structural grid resync ${why}` };
        }

        const unmatchedCount = Array.isArray(details?.unmatchedChainOrders)
            ? details.unmatchedChainOrders.length
            : 0;
        // P5 max-defer: cap batchInFlight re-arm so a fill storm cannot starve
        // the resync forever (a fill-storm defer loop once kept the flag armed
        // indefinitely). After the cap, the resync forces instead of re-arming.
        const STRUCTURAL_RESYNC_MAX_DEFER_MS = 30000;
        const runStructuralResync = async () => {
            bot._structuralGridResyncTimer = null;
            if (bot._shuttingDown) return;

            // A COW batch can be mid-broadcast (its broadcast phase holds no
            // grid lock, only the commit does). Reloading the persisted grid
            // underneath it would race the commit and force an avoidable
            // commit refusal + re-adoption cycle. Defer until the batch
            // completes; the fill consumer is already gated on _batchInFlight,
            // so this only blocks the recovery itself, never new fills.
            if (bot._batchInFlight > 0) {
                const now = Date.now();
                if (!bot._structuralGridResyncDeferStartedAt) {
                    bot._structuralGridResyncDeferStartedAt = now;
                    bot._structuralGridResyncDeferCount = 0;
                }
                bot._structuralGridResyncDeferCount = (bot._structuralGridResyncDeferCount || 0) + 1;
                const deferredMs = now - bot._structuralGridResyncDeferStartedAt;
                if (deferredMs >= STRUCTURAL_RESYNC_MAX_DEFER_MS) {
                    bot._warn(
                        `[RECOVERY] Structural resync max-defer reached (${deferredMs}ms, cap ${STRUCTURAL_RESYNC_MAX_DEFER_MS}ms, deferred ${bot._structuralGridResyncDeferCount}x) — forcing despite _batchInFlight=${bot._batchInFlight}: ${reason}`
                    );
                    bot._structuralGridResyncDeferStartedAt = null;
                    bot._structuralGridResyncDeferCount = 0;
                } else {
                    // Fix #7 (docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md §2): throttle the defer log to the
                    // first occurrence per cap window (a fill storm can emit hundreds of
                    // defer lines in seconds); count the rest and surface them only in
                    // the final forced message.
                    if (bot._structuralGridResyncDeferCount === 1) {
                        bot._warn(
                            `[RECOVERY] Structural resync defer (batchInFlight=${bot._batchInFlight}, deferred ${deferredMs}ms/${STRUCTURAL_RESYNC_MAX_DEFER_MS}ms): ${reason}`
                        );
                    } else {
                        bot.manager?.logger?.log?.(
                            `[RECOVERY] Structural resync defer (suppressed; count=${bot._structuralGridResyncDeferCount}, deferred ${deferredMs}ms/${STRUCTURAL_RESYNC_MAX_DEFER_MS}ms): ${reason}`,
                            'debug'
                        );
                    }
                    bot._structuralGridResyncTimer = setTimeout(runStructuralResync, TIMING.LOCK_REFRESH_MIN_MS);
                    return;
                }
            } else {
                bot._structuralGridResyncDeferStartedAt = null;
                bot._structuralGridResyncDeferCount = 0;
            }

            bot._structuralGridResyncRunning++;
            try {
                // The reload runs without the fill lock, so raise the
                // recovery-in-flight flag for its whole duration: the fill
                // consumer defers (dexbot_fill_runtime gates on it), which
                // prevents a fill arriving mid-reload from starting a new COW
                // batch whose broadcast would overlap the reload and force an
                // avoidable commit refusal + re-adoption cycle.
                bot._recoverySyncInFlight = (bot._recoverySyncInFlight || 0) + 1;
                let persistedResult: JsonObj;
                try {
                    persistedResult = await bot._recoverFromPersistedGrid() as JsonObj;
                } finally {
                    bot._recoverySyncInFlight = Math.max(0, (bot._recoverySyncInFlight || 0) - 1);
                }
                if (persistedResult.success) {
                    if (bot.manager?._recoveryState) {
                        bot.manager._recoveryState = { ...bot.manager._recoveryState, attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0 };
                    }
                    return;
                }
                if (persistedResult.halt) {
                    // Missing-genesis policy 'halt': the operator must reset the
                    // grid manually. Do not fall through to the automatic
                    // structural resync below (docs/GRID_PRICE_INVARIANT.md).
                    bot._warn(
                        `[RECOVERY] Missing-genesis policy='halt' — suppressing the automatic structural ` +
                        `resync for ${reason}. Run a manual grid reset for this bot.`
                    );
                    return;
                }

                const suffix = unmatchedCount > 0 ? ` (${unmatchedCount} unmatched chain order(s))` : '';
                    bot._warn(`[RECOVERY] Running structural full grid resync for ${reason}${suffix}`);
                    // Same protection as the persisted-grid reload above: the
                    // reset's reconcile Phase-2 placement runs for minutes; a
                    // fill arriving mid-reset must not start a COW batch whose
                    // broadcast overlaps it (commit refusal + duplicate
                    // generation orphans). _recoverFromPersistedGrid already
                    // incremented and released the counter; increment again
                    // for the full-resync branch.
                    bot._recoverySyncInFlight = (bot._recoverySyncInFlight || 0) + 1;
                    let resetResult: JsonObj;
                    try {
                        resetResult = await (bot.requestGridReset('rms_structural_grid_resync', {
                            refreshCenterPrice: false,
                            // Structural resync is a chain-read/rebuild; do not let a
                            // fill storm starve it behind the idle cooldown or the
                            // fill-processing lock.
                            skipIdle: true,
                            skipFillLock: true,
                        })) as JsonObj;
                    } finally {
                        bot._recoverySyncInFlight = Math.max(0, (bot._recoverySyncInFlight || 0) - 1);
                        if ((bot._recoverySyncInFlight || 0) === 0) drainFillQueueAfterPipelineClear(bot);
                    }
                if (resetResult && bot.manager?._recoveryState) {
                    bot.manager._recoveryState = { ...bot.manager._recoveryState, attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0 };
                }
            } catch (err) {
                bot._warn(`[RECOVERY] Structural full grid resync failed: ${getErrorMessage(err)}`);
            } finally {
                bot._structuralGridResyncRunning--;
                if (bot.manager?._recoveryState) {
                    bot.manager._recoveryState = { ...bot.manager._recoveryState, structuralResyncRequested: false };
                }
            }
        };
        bot._structuralGridResyncTimer = setTimeout(runStructuralResync, 0);

        return { scheduled: true };
    };
}

/**
 * Get current pipeline signal state for congestion checks.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Object}
 */
function getPipelineSignals(bot: BotLike) {
    bot.manager?._cleanExpiredLocks?.();
    return {
        incomingFillQueueLength: bot._incomingFillQueue.length,
        shadowLocks: bot.manager?.getActiveShadowLockCount?.() || 0,
        batchInFlight: bot._batchInFlight > 0,
        recoveryInFlight: bot._recoverySyncInFlight > 0,
        broadcasting: bot.manager?.isBroadcastingActive?.() || false
    };
}

/**
 * Mark that grid activity occurred (updates idle timer).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} [reason='activity']
 */
function markGridActivity(bot: BotLike, reason: string = 'activity') {
    bot._lastGridActivityAt = Date.now();
    bot.manager?.logger?.log?.(`[MAINT-IDLE] Activity observed: ${reason}`, 'debug');
}

/**
 * Manager-owned counters overlaid onto the bot's metrics snapshot. The
 * grid/strategy engines write these on the MANAGER because they have no bot
 * reference. Kept in one function so wiring a new engine-owned counter does not
 * mean copying the `manager ?? bot` fallback again.
 * @param {Object} bot - DEXBot instance
 * @returns {Object} The manager-owned counters, or {} when the manager has none
 */
function managerOwnedCounters(bot: BotLike): Partial<BotMetrics> {
    const mgr = bot.manager?._metrics;
    if (!mgr) return {};
    return {
        boundaryDriftExceedsWindowCount: mgr.boundaryDriftExceedsWindowCount ?? bot._metrics.boundaryDriftExceedsWindowCount,
        spreadCorrectionRefusedCount: mgr.spreadCorrectionRefusedCount ?? bot._metrics.spreadCorrectionRefusedCount,
        spreadCorrectionRefusalCauses: mgr.spreadCorrectionRefusalCauses ?? bot._metrics.spreadCorrectionRefusalCauses,
        spreadCorrectionRetryCount: mgr.spreadCorrectionRetryCount ?? bot._metrics.spreadCorrectionRetryCount
    };
}

/**
 * Get current metrics for monitoring and debugging.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Object}
 */
function getMetrics(bot: BotLike) {
    bot.manager?._cleanExpiredLocks?.();
    const unmatched = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    // Deliberate holds (reason suffixed `-deferred`) never block the pipeline,
    // but they DO lock funds until an operator clears them. Surface the split
    // so the permanent holds are visible in status/metrics instead of only in
    // per-order sync logs.
    const heldUnmatched = unmatched.filter((u) => isNonBlockingUnmatchedOrder(u));
    return {
        ...bot._metrics,
        // Counters written by the grid/strategy engines on the MANAGER's metrics
        // object (those engines have no bot reference). Overlay them here so
        // they are actually surfaced by getMetrics(). Single wiring point: add
        // a new engine-owned counter here, not as another inline fallback.
        ...managerOwnedCounters(bot),
        queueDepth: bot._incomingFillQueue.length,
        fillProcessingLockActive: bot.manager?._fillProcessingLock?.isLocked() || false,
        divergenceLockActive: bot.manager?._divergenceLock?.isLocked() || false,
        shadowLocksActive: bot.manager?.getActiveShadowLockCount?.() || 0,
        recoveryExhaustedAt: bot.manager?._recoveryExhaustedAt || null,
        recentFillsTracked: bot._recentlyProcessedFills.size,
        unmatchedChainOrders: unmatched.length,
        heldChainOrders: heldUnmatched.length,
        blockingChainOrders: unmatched.length - heldUnmatched.length
    };
}

/**
 * Read open orders from chain, sync with local state, and process any fills found.
 * Self-guarding wrapper: every path here mutates grid state and can broadcast a
 * rebalance (via _processFillsWithBatching), so it must never run concurrently
 * with the fill consumer. acquireIfNotHeld serializes an unlocked caller through
 * _fillProcessingLock while letting a caller that already holds the lock (e.g.
 * the fill pipeline or grid maintenance) run the impl directly — a future caller
 * that forgets to take the lock is serialized instead of silently bypassing it.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} tag - Context label for logging
 * @returns {Promise<Object>}
 */
async function syncOpenOrdersAndProcessFills(bot: BotLike, tag: string) {
    return acquireIfNotHeld(bot.manager?._fillProcessingLock, () =>
        syncOpenOrdersAndProcessFillsImpl(bot, tag)
    );
}

/**
 * Read open orders from chain, sync with local state, and process any fills found.
 * Implementation — callers MUST already hold _fillProcessingLock (see wrapper).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} tag - Context label for logging
 * @returns {Promise<Object>}
 */
async function syncOpenOrdersAndProcessFillsImpl(bot: BotLike, tag: string) {
    if (!bot.accountId || bot.config?.dryRun) {
        return { syncResult: null, aborted: false, hasUnmatched: 0, openOrders: null };
    }
    try {
        // Truncated-read guard: syncing on a partial get_full_accounts window
        // would virtualize live ACTIVE slots (pass-1 phantom cleanup) and
        // re-create them as duplicates. Defer to a clean read — fill
        // subscription events keep the bot responsive in the meantime.
        const firstRead = await readOpenOrdersGuarded(chainOrders, bot.accountId, {
            log: (message: string, level?: string) => bot._log(message, level),
            label: 'SYNC-CHAIN',
            detail: `during ${tag}`,
        });
        if (firstRead === null) {
            return { syncResult: null, aborted: false, hasUnmatched: 0, openOrders: null };
        }
        let openOrders = firstRead;
        const syncResult = await bot.manager.synchronizeWithChain(
            openOrders,
            'readOpenOrders'
        );
        let aborted = false;
        if (syncResult?.filledOrders?.length > 0) {
            bot._refreshDynamicWeightDistribution(`${tag} sync-fill`);
            bot._log(`[SYNC-CHAIN] ${syncResult.filledOrders.length} filled order(s) found during ${tag}`, 'info');
            const batchResult = await bot._processFillsWithBatching(
                syncResult.filledOrders,
                new Set(),
                `${tag} sync-fill`,
                { isReplay: true }
            );
            if (!batchResult?.aborted) {
                // Reassign the returned snapshot to the post-fill re-read: the
                // caller feeds openOrders into reconcileGridOrders, which must
                // see the freshest chain state, not the pre-fill first read.
                const reReadOrders = await readOpenOrdersGuarded(chainOrders, bot.accountId, {
                    log: (message: string, level?: string) => bot._log(message, level),
                    label: 'SYNC-CHAIN',
                    detail: `post-fill re-read during ${tag}`,
                });
                if (reReadOrders !== null) {
                    openOrders = reReadOrders;
                    await bot.manager.synchronizeWithChain(openOrders, 'readOpenOrders');
                }
            } else {
                aborted = true;
            }
        }
        const hasUnmatched = syncResult?.unmatchedChainOrders?.length || 0;
        return { syncResult, aborted, hasUnmatched, openOrders };
    } catch (err) {
        bot._warn(`[SYNC-CHAIN] Open-orders sync failed during ${tag}: ${getErrorMessage(err)}`);
        return { syncResult: null, aborted: true, hasUnmatched: -1, openOrders: null };
    }
}
export { loadBotsConfigSnapshot, isWrapperAdapterOwner, checkAndApplyBotConfigChanges, buildBotConfigFingerprint, refreshDynamicWeightDistribution, performGridResync, updateBotGridResetMetadata, handlePendingTriggerReset, setupTriggerFileDetection, performPeriodicGridChecks, isOpenOrdersSyncLoopEnabled, startOpenOrdersSyncLoop, stopOpenOrdersSyncLoop, setupBlockchainFetchInterval, stopBlockchainFetchInterval, setupBotsConfigPollInterval, stopBotsConfigPollInterval, executeMaintenanceLogic, getTargetedSyncReason, maybeRunTargetedDriftReconciliation, countLiveEdgeOrders, cancelDustOrders, isOrderDoesNotExistError, runGridMaintenance, releaseMarketAdapterRuntime, syncMarketAdapterOnPeriodicConfigCheck, usesAmaGridPrice, runDustHealthCheck, setupDustHealthCheckInterval, requestGridReset, wireStructuralGridResyncRequest, getPipelineSignals, markGridActivity, getMetrics, syncOpenOrdersAndProcessFills, shouldDeferMaintenanceForBroadcast, checkGridLockHoldDuration };


export default {
    refreshDynamicWeightDistribution,
    performGridResync,
    handlePendingTriggerReset,
    setupTriggerFileDetection,
    performPeriodicGridChecks,
    isOpenOrdersSyncLoopEnabled,
    startOpenOrdersSyncLoop,
    stopOpenOrdersSyncLoop,
    setupBlockchainFetchInterval,
    stopBlockchainFetchInterval,
    setupBotsConfigPollInterval,
    stopBotsConfigPollInterval,
    executeMaintenanceLogic,
    cancelDustOrders,
    runGridMaintenance,
    releaseMarketAdapterRuntime,
    runDustHealthCheck,
    setupDustHealthCheckInterval,
    requestGridReset,
    wireStructuralGridResyncRequest,
    getPipelineSignals,
    markGridActivity,
    getMetrics,
    syncOpenOrdersAndProcessFills,
    _internalDeferredHold: { logDeferredHoldSummary, describeDeferredHolds, considerDeferredHoldEscalation },
};

/**
 * modules/settings_merge.ts - Shared Settings Merge
 *
 * Single source of truth for merging user settings (from general.settings.json)
 * with code defaults. Consolidates merge strategies previously duplicated
 * between constants.ts and account_bots.ts.
 *
 * ===============================================================================
 * PER-SECTION MERGE STRATEGIES
 * ===============================================================================
 *
 * replace  — direct assignment                  LOG_LEVEL
 * shallow  — one-level spread merge             TIMING, GRID_LIMITS, FILL_PROCESSING,
 *                                                PIPELINE_TIMING, DEFAULT_CONFIG, UPDATER,
 *                                                CREDENTIAL_PROMPTS, MAINTENANCE,
 *                                                COW_PERFORMANCE, INCREMENT_BOUNDS,
 *                                                FEE_PARAMETERS, API_LIMITS
 * deep     — recursive merge                    LOGGING_CONFIG, NATIVE_CLIENT, LAUNCHER,
 *                                                NODE_MANAGEMENT, MARKET_ADAPTER
 *
 * SPECIAL POST-PROCESSING:
 *   - GRID_LIMITS.GRID_COMPARISON → sub-object deep merge
 *   - raw.NODES                   → maps into NODE_MANAGEMENT constants
 */

type MergeStrategy = 'replace' | 'shallow' | 'deep';

import type { UnknownRecord } from './types.js';
import { isUnknownRecord } from './types.js';

const MERGE_STRATEGIES: Record<string, MergeStrategy> = {
    LOG_LEVEL: 'replace',
    TIMING: 'shallow',
    GRID_LIMITS: 'shallow',
    FILL_PROCESSING: 'shallow',
    PIPELINE_TIMING: 'shallow',
    DEFAULT_CONFIG: 'shallow',
    UPDATER: 'shallow',
    CREDENTIAL_PROMPTS: 'shallow',
    MAINTENANCE: 'shallow',
    COW_PERFORMANCE: 'shallow',
    INCREMENT_BOUNDS: 'shallow',
    FEE_PARAMETERS: 'shallow',
    API_LIMITS: 'shallow',
    LOGGING_CONFIG: 'deep',
    NATIVE_CLIENT: 'deep',
    LAUNCHER: 'deep',
    NODE_MANAGEMENT: 'deep',
    MARKET_ADAPTER: 'deep',
};

/**
 * Filter out comment/metadata keys (prefixed with _) from user settings.
 * These are used for JSON documentation but should not override code defaults.
 */
function filterCommentKeys(obj: UnknownRecord): UnknownRecord {
    return Object.fromEntries(
        Object.entries(obj).filter(([key]) => !key.startsWith('_'))
    );
}

const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep recursive merge: source values override target values at any depth.
 * Plain objects are merged recursively; arrays and primitives are replaced.
 * Comment/metadata keys (prefixed with _) and `undefined` source values are skipped.
 * Prototype-dangerous own keys from JSON-parsed sources ('__proto__' et al) are
 * skipped so crafted config files cannot pollute Object.prototype.
 */
function deepMerge(target: UnknownRecord, source: UnknownRecord): UnknownRecord {
    const result: UnknownRecord = { ...target };
    for (const key of Object.keys(source)) {
        if (key.startsWith('_') || UNSAFE_MERGE_KEYS.has(key)) continue;
        const sv = source[key];
        if (sv === undefined) continue;
        if (isUnknownRecord(sv)) {
            const targetValue = result[key];
            result[key] = isUnknownRecord(targetValue) ? deepMerge(targetValue, sv) : { ...sv };
        } else {
            result[key] = sv;
        }
    }
    return result;
}

/**
 * Mapping from settings.NODES sub-keys to NODE_MANAGEMENT flat constant names.
 * Ensures both raw.NODES and raw.NODE_MANAGEMENT can update the same constants.
 */
const NODES_SUBKEY_MAP: Record<string, Record<string, string>> = {
    healthCheck: {
        intervalMs: 'HEALTH_CHECK_INTERVAL_MS',
        timeoutMs: 'HEALTH_CHECK_TIMEOUT_MS',
        maxPingMs: 'MAX_PING_MS',
        blacklistThreshold: 'BLACKLIST_THRESHOLD',
        // Strike lifetime and flapping penalty (see modules/node_flap_score.ts).
        strikeDecayMs: 'FAILURE_STRIKE_DECAY_MS',
        flapHalfLifeMs: 'FLAP_HALF_LIFE_MS',
        flapPenaltyMsPerDrop: 'FLAP_PENALTY_MS_PER_DROP',
        flapPenaltyMaxMs: 'FLAP_PENALTY_MAX_MS',
    },
    selection: {
        strategy: 'SELECTION_STRATEGY',
    },
};

/**
 * Apply raw.NODES sub-key values onto a NODE_MANAGEMENT result object.
 */
function applyNodesToNodeManagement(nodes: UnknownRecord, nm: UnknownRecord): void {
    if (nodes.enabled !== undefined) nm.DEFAULT_ENABLED = nodes.enabled;
    if (Array.isArray(nodes.list)) nm.DEFAULT_NODES = nodes.list;
    const healthCheck = nodes.healthCheck;
    if (isUnknownRecord(healthCheck)) {
        const hc = filterCommentKeys(healthCheck);
        for (const [subKey, constantName] of Object.entries(NODES_SUBKEY_MAP.healthCheck)) {
            if (hc[subKey] !== undefined) nm[constantName] = hc[subKey];
        }
    }
    const selection = nodes.selection;
    if (isUnknownRecord(selection)) {
        const sel = filterCommentKeys(selection);
        for (const [subKey, constantName] of Object.entries(NODES_SUBKEY_MAP.selection)) {
            if (sel[subKey] !== undefined) nm[constantName] = sel[subKey];
        }
    }
}

/**
 * The NODES view built from a NODE_MANAGEMENT-style section. `healthCheck` and
 * `selection` are typed because callers read/write those sub-fields directly;
 * the index signature keeps unmapped passthrough keys reachable.
 */
interface NodesHealthCheckView {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    maxPingMs?: number;
    blacklistThreshold?: number;
    strikeDecayMs?: number;
    flapHalfLifeMs?: number;
    flapPenaltyMsPerDrop?: number;
    flapPenaltyMaxMs?: number;
    [key: string]: unknown;
}

interface NodesSelectionView {
    strategy?: string;
    preferredNode?: string | null;
    [key: string]: unknown;
}

export interface NodesView {
    enabled?: boolean;
    list?: string[];
    healthCheck: NodesHealthCheckView;
    selection: NodesSelectionView;
    [key: string]: unknown;
}

/**
 * Build the NODES view object from a NODE_MANAGEMENT-style section — the ONE
 * place that maps NODE_MANAGEMENT constants to the NODES consumer shape.
 * Shared by mergeSettings post-processing and buildDefaultGeneralSettings
 * (modules/constants.ts) so the runtime merge and the default settings
 * document can never drift. Passthrough of unmapped raw.NODES sub-keys stays
 * with the merge below; this only builds the base view.
 */
function buildNodesView(nm: UnknownRecord): NodesView {
    return {
        enabled: nm.DEFAULT_ENABLED as boolean | undefined,
        list: nm.DEFAULT_NODES as string[] | undefined,
        healthCheck: {
            enabled: true,
            intervalMs: nm.HEALTH_CHECK_INTERVAL_MS as number | undefined,
            timeoutMs: nm.HEALTH_CHECK_TIMEOUT_MS as number | undefined,
            maxPingMs: nm.MAX_PING_MS as number | undefined,
            blacklistThreshold: nm.BLACKLIST_THRESHOLD as number | undefined,
            strikeDecayMs: nm.FAILURE_STRIKE_DECAY_MS as number | undefined,
            flapHalfLifeMs: nm.FLAP_HALF_LIFE_MS as number | undefined,
            flapPenaltyMsPerDrop: nm.FLAP_PENALTY_MS_PER_DROP as number | undefined,
            flapPenaltyMaxMs: nm.FLAP_PENALTY_MAX_MS as number | undefined,
        },
        selection: {
            strategy: nm.SELECTION_STRATEGY as string | undefined,
            preferredNode: null,
        },
    };
}

/**
 * Merge user settings with code defaults using per-section strategies.
 *
 * @param raw      - Raw user settings object (from general.settings.json)
 * @param defaults - Code defaults object (AllConstants-shaped)
 * @returns Merged result with same shape as defaults (new objects where overridden,
 *          same references where not)
 */
function mergeSettings<T extends UnknownRecord>(rawInput: unknown, defaults: T): T {
    const raw: UnknownRecord = isUnknownRecord(rawInput) ? rawInput : {};

    const result: UnknownRecord = {};

    for (const key of Object.keys(defaults)) {
        const rawVal = raw[key];
        const defaultVal = defaults[key];

        if (rawVal === undefined || rawVal === null) {
            result[key] = defaultVal;
            continue;
        }

        const strategy = MERGE_STRATEGIES[key] || 'shallow';

        switch (strategy) {
            case 'replace':
                result[key] = rawVal;
                break;

            case 'shallow': {
                const cleanRaw = isUnknownRecord(rawVal) ? filterCommentKeys(rawVal) : rawVal;
                const base = isUnknownRecord(defaultVal) ? { ...defaultVal } : defaultVal;
                result[key] = isUnknownRecord(base)
                    ? (isUnknownRecord(cleanRaw) ? { ...base, ...cleanRaw } : base)
                    : cleanRaw;
                break;
            }

            case 'deep': {
                const cleanRaw = isUnknownRecord(rawVal) ? filterCommentKeys(rawVal) : rawVal;
                result[key] = isUnknownRecord(defaultVal) && isUnknownRecord(cleanRaw)
                    ? deepMerge(defaultVal, cleanRaw)
                    : cleanRaw;
                break;
            }
        }
    }

    // Post-processing: GRID_COMPARISON sub-object deep merge for GRID_LIMITS
    const rawGridLimits = raw.GRID_LIMITS;
    if (isUnknownRecord(rawGridLimits)) {
        const rawComparisonRaw = rawGridLimits.GRID_COMPARISON;
        if (isUnknownRecord(rawComparisonRaw)) {
            const rawComparison = filterCommentKeys(rawComparisonRaw);
            const defaultGridLimits = defaults.GRID_LIMITS;
            const defaultComparisonRaw = isUnknownRecord(defaultGridLimits) ? defaultGridLimits.GRID_COMPARISON : undefined;
            const defaultComparison = isUnknownRecord(defaultComparisonRaw) ? { ...defaultComparisonRaw } : {};
            const resultGridLimits = isUnknownRecord(result.GRID_LIMITS) ? result.GRID_LIMITS : {};
            result.GRID_LIMITS = {
                ...resultGridLimits,
                GRID_COMPARISON: { ...defaultComparison, ...rawComparison },
            };
        }
    }

    // Post-processing: NODES -> NODE_MANAGEMENT mapping, then build NODES output
    const resultNodeManagement = result.NODE_MANAGEMENT;
    if (isUnknownRecord(resultNodeManagement)) {
        const rawNodes = raw.NODES;

        // Step 1: Map raw.NODES sub-keys to NODE_MANAGEMENT constants
        let mergedNodeManagement = resultNodeManagement;
        if (isUnknownRecord(rawNodes)) {
            const nm = { ...resultNodeManagement };
            applyNodesToNodeManagement(rawNodes, nm);
            mergedNodeManagement = nm;
        }
        result.NODE_MANAGEMENT = mergedNodeManagement;

        // Step 2: Build NODES output object from merged NODE_MANAGEMENT
        const nodesConfig = buildNodesView(mergedNodeManagement);

        // Step 3: Passthrough unmapped top-level keys from raw.NODES
        if (isUnknownRecord(rawNodes)) {
            if (rawNodes.enabled !== undefined) nodesConfig.enabled = rawNodes.enabled as boolean;
            if (Array.isArray(rawNodes.list)) nodesConfig.list = rawNodes.list as string[];
            // HealthCheck: keep mapped values, add any unmapped sub-keys
            const rawHealthCheck = rawNodes.healthCheck;
            if (isUnknownRecord(rawHealthCheck)) {
                const nodeHealth = nodesConfig.healthCheck;
                for (const k of Object.keys(rawHealthCheck)) {
                    if (k.startsWith('_')) continue;
                    if (!(k in NODES_SUBKEY_MAP.healthCheck)) {
                        nodeHealth[k] = rawHealthCheck[k];
                    }
                }
            }
            // Selection: keep mapped values, add any unmapped sub-keys
            const rawSelection = rawNodes.selection;
            if (isUnknownRecord(rawSelection)) {
                const nodeSelection = nodesConfig.selection;
                for (const k of Object.keys(rawSelection)) {
                    if (k.startsWith('_')) continue;
                    if (!(k in NODES_SUBKEY_MAP.selection)) {
                        nodeSelection[k] = rawSelection[k];
                    }
                }
            }
        }

        result.NODES = nodesConfig;
    }

    return result as T;
}

export { deepMerge, mergeSettings, buildNodesView, MERGE_STRATEGIES }


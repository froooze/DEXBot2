

import { NODE_MANAGEMENT } from './constants.js';
import { getNodeHealthCacheFile } from './paths.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import {
    dropCounters,
    flapPenaltyMs,
    pruneDropTimes,
} from './node_flap_score.js';
import { getStorage } from './storage/index.js';
const storage = getStorage();
const { readJSON } = storage;

interface HealthCacheOptions {
    healthCacheFile?: string;
    stateDir?: string;
    now?: number;
    maxAgeMs?: number;
    /**
     * Flap-scoring tuning of the writer/reader. Defaults to
     * modules/node_flap_score.ts values (which modules/constants.ts also reuses),
     * so an operator who tuned `NODES.healthCheck.flap*` gets counters and
     * ordering that match their bot's own ranking instead of the stock maths.
     */
    flap?: {
        windowMs?: number;
        halfLifeMs?: number;
        penaltyMsPerDrop?: number;
        maxPenaltyMs?: number;
    };
}

interface NodeHealthStat {
    url?: string;
    status?: string;
    latencyMs?: number;
    lastCheckTime?: string | number | null;
    /** Transport drop timestamps (see modules/node_flap_score.ts). */
    dropTimes?: number[];
}

interface NodeHealthCacheEntry {
    url: string;
    status: string;
    latencyMs: number | null;
    lastCheckTime: string | number | null;
    /**
     * Connection churn, persisted so every consumer (bots, credential daemon)
     * can see stability and not just ping. `dropTimes` is the source of truth
     * for decay; the counters are derived for readers that only look at the
     * JSON.
     */
    dropTimes: number[];
    flapScore: number;
    flapPenaltyMs: number;
    dropsLastHour: number;
    drops24h: number;
    dropsPerHour: number;
}

interface NodeHealthCachePayload {
    version: number;
    updatedAt: string;
    updatedAtMs: number;
    nodes: NodeHealthCacheEntry[];
}

interface NodeSettings {
    NODES?: {
        list?: string[];
        enabled?: boolean;
        healthCheck?: {
            intervalMs?: number;
            enabled?: boolean;
        };
    };
}

function resolveHealthCacheFile(config: HealthCacheOptions = {}): string {
    if (typeof config.healthCacheFile === 'string' && config.healthCacheFile.trim()) {
        return config.healthCacheFile;
    }
    if (typeof config.stateDir === 'string' && config.stateDir.trim()) {
        return getNodeHealthCacheFile(config.stateDir);
    }
    return getNodeHealthCacheFile();
}

function normalizeNodeList(nodes: unknown): string[] {
    return Array.isArray(nodes)
        ? nodes.filter((node: unknown): node is string => typeof node === 'string' && node.trim() !== '')
        : [];
}

/**
 * Comparator for healthy/slow nodes: healthy first, then by *effective*
 * latency (measured ping + decayed connection-churn penalty).
 * Shared by node_health_cache and node_manager.
 */
function compareNodeHealth(a: { status: string; latencyMs?: number | null; dropTimes?: number[]; flapPenaltyMs?: number }, b: { status: string; latencyMs?: number | null; dropTimes?: number[]; flapPenaltyMs?: number }, nowMs: number = Date.now(), flap?: HealthCacheOptions['flap']): number {
    if (a.status !== b.status) return a.status === 'healthy' ? -1 : 1;
    // Compare without subtracting: two unknown latencies are both Infinity,
    // and Infinity - Infinity is NaN (an unstable sort comparator).
    const aRank = nodeRankLatency(a, nowMs, flap);
    const bRank = nodeRankLatency(b, nowMs, flap);
    if (aRank === bRank) return 0;
    return aRank < bRank ? -1 : 1;
}

/** Ranking latency: measured ping plus the churn penalty, Infinity when unknown. */
function nodeRankLatency(node: { latencyMs?: number | null; dropTimes?: number[]; flapPenaltyMs?: number }, nowMs: number, flap?: HealthCacheOptions['flap']): number {
    if (typeof node.latencyMs !== 'number' || !Number.isFinite(node.latencyMs)) return Infinity;
    // Prefer the penalty the writer persisted: recomputing from dropTimes here
    // would silently apply *this* reader's tuning (or the stock defaults) over
    // the one the cache was ordered with.
    if (typeof node.flapPenaltyMs === 'number' && Number.isFinite(node.flapPenaltyMs)) {
        return node.latencyMs + node.flapPenaltyMs;
    }
    const penalty = Array.isArray(node.dropTimes)
        ? flapPenaltyMs(node.dropTimes, { nowMs, ...flap })
        : 0;
    return node.latencyMs + penalty;
}

function buildHealthCachePayload(stats: Iterable<NodeHealthStat> | ArrayLike<NodeHealthStat> | null | undefined, now: number = Date.now(), flap: HealthCacheOptions['flap'] = undefined): NodeHealthCachePayload {
    const flapOptions = {
        nowMs: now,
        windowMs: flap?.windowMs ?? NODE_MANAGEMENT.FLAP_WINDOW_MS,
        halfLifeMs: flap?.halfLifeMs ?? NODE_MANAGEMENT.FLAP_HALF_LIFE_MS,
        penaltyMsPerDrop: flap?.penaltyMsPerDrop ?? NODE_MANAGEMENT.FLAP_PENALTY_MS_PER_DROP,
        maxPenaltyMs: flap?.maxPenaltyMs ?? NODE_MANAGEMENT.FLAP_PENALTY_MAX_MS,
    };
    const nodes: NodeHealthCacheEntry[] = Array.from(stats || [])
        .filter((stat): stat is NodeHealthStat & { status: 'healthy' | 'slow'; url: string } =>
            !!stat && (stat.status === 'healthy' || stat.status === 'slow') && typeof stat.url === 'string' && stat.url.trim() !== ''
        )
        .map((stat) => {
            const dropTimes = pruneDropTimes(stat.dropTimes, now, flapOptions.windowMs);
            const counters = dropCounters(dropTimes, flapOptions);
            return {
                url: stat.url,
                status: stat.status,
                latencyMs: Number.isFinite(stat.latencyMs) ? (stat.latencyMs ?? null) : null,
                lastCheckTime: stat.lastCheckTime || null,
                dropTimes,
                flapScore: counters.flapScore,
                flapPenaltyMs: counters.penaltyMs,
                dropsLastHour: counters.dropsLastHour,
                drops24h: counters.drops24h,
                dropsPerHour: counters.dropsPerHour,
            };
        });

    nodes.sort((a, b) => compareNodeHealth(a, b, now, flap));

    return {
        version: 1,
        updatedAt: new Date(now).toISOString(),
        updatedAtMs: now,
        nodes,
    };
}

function writeHealthCache(stats: Iterable<NodeHealthStat> | ArrayLike<NodeHealthStat> | null | undefined, options: HealthCacheOptions = {}): NodeHealthCachePayload {
    const file = resolveHealthCacheFile(options);
    const now = Number.isFinite(options.now) ? options.now! : Date.now();
    const payload = buildHealthCachePayload(stats, now, options.flap);
    // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A torn
    // health cache would either lose all health history or fail to parse.
    writeJsonFileAtomic(file, payload);
    return payload;
}

function readHealthCache(options: HealthCacheOptions = {}): NodeHealthCachePayload | null {
    const file = resolveHealthCacheFile(options);
    const maxAgeMs = Number.isFinite(options.maxAgeMs)
        ? options.maxAgeMs!
        : NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS;
    const now = Number.isFinite(options.now) ? options.now! : Date.now();

    try {
        const payload: NodeHealthCachePayload = readJSON(file);
        if (!payload || payload.version !== 1 || !Array.isArray(payload.nodes)) return null;
        if (!Number.isFinite(payload.updatedAtMs)) return null;
        if (maxAgeMs >= 0 && now - payload.updatedAtMs > maxAgeMs) return null;

        const nodes = payload.nodes
            .filter((node): node is NodeHealthCacheEntry & { status: 'healthy' | 'slow' } =>
                !!node && (node.status === 'healthy' || node.status === 'slow') && typeof node.url === 'string' && node.url.trim() !== ''
            )
            .map((node) => ({
                ...node,
                dropTimes: pruneDropTimes(node.dropTimes, now, options.flap?.windowMs ?? NODE_MANAGEMENT.FLAP_WINDOW_MS),
            }))
            .sort((a, b) => compareNodeHealth(a, b, now, options.flap));

        return {
            ...payload,
            nodes,
        };
    } catch {
        return null;
    }
}

function removeNodesFromHealthCache(urls: string | string[], options: HealthCacheOptions = {}): NodeHealthCachePayload | null {
    const toRemove = new Set(Array.isArray(urls) ? urls : [urls]);
    if (toRemove.size === 0) return null;
    const cache = readHealthCache(options);
    if (!cache || !Array.isArray(cache.nodes)) return null;
    // No-op when the nodes are already absent: an unlocked read-modify-write
    // clobbers any concurrent fresh health-check write with the stale snapshot
    // it read, so only rewrite the file when the exclusion actually changes
    // something (the write itself is atomic — a lost exclusion, never a torn
    // file).
    if (!cache.nodes.some((n) => n && n.url && toRemove.has(n.url))) return null;
    const remaining = cache.nodes
        .filter((n) => !n || !n.url || !toRemove.has(n.url))
        // Spread, not a field whitelist: dropping a node must not erase the
        // churn history (dropTimes) of the nodes that stay.
        .map((n) => ({ ...n, latencyMs: n.latencyMs ?? undefined, lastCheckTime: n.lastCheckTime }));
    // The rewrite re-derives the drops/h counters from `dropTimes` using the
    // caller's tuning (stock defaults when the caller has no bot config, e.g.
    // the credential daemon). A bot that tuned NODES.healthCheck.flap* restores
    // its own numbers on its next health sweep; until then the ordering can be
    // computed with defaults, which is the best a tuning-less process can do.
    return writeHealthCache(remaining, { ...options, now: Date.now() });
}

function orderNodesFromHealthCache(configuredNodes: unknown, options: HealthCacheOptions = {}): string[] {
    const configured = normalizeNodeList(configuredNodes);
    const configuredSet = new Set(configured);
    const cache = readHealthCache(options);
    if (!cache || cache.nodes.length === 0) return configured;

    const ordered: string[] = [];
    for (const node of cache.nodes) {
        if (!configuredSet.has(node.url) || ordered.includes(node.url)) continue;
        ordered.push(node.url);
    }
    for (const node of configured) {
        if (!ordered.includes(node)) ordered.push(node);
    }
    return ordered;
}

function resolveConfiguredNodes(settings: NodeSettings): string[] {
    const nodeSettings = settings?.NODES;
    const configuredNodes = normalizeNodeList(nodeSettings?.list);
    return configuredNodes.length > 0
        ? configuredNodes
        : NODE_MANAGEMENT.DEFAULT_NODES;
}

function resolveHealthCacheMaxAgeMs(settings: NodeSettings): number {
    const configuredInterval = settings?.NODES?.healthCheck?.intervalMs;
    return Number.isFinite(configuredInterval)
        ? configuredInterval!
        : NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS;
}

function orderNodesForSettings(settings: NodeSettings, options: HealthCacheOptions = {}): string[] {
    if (settings?.NODES?.healthCheck?.enabled === false) {
        return resolveConfiguredNodes(settings);
    }
    return orderNodesFromHealthCache(resolveConfiguredNodes(settings), {
        ...options,
        maxAgeMs: Number.isFinite(options.maxAgeMs)
            ? options.maxAgeMs
            : resolveHealthCacheMaxAgeMs(settings),
    });
}

export { compareNodeHealth, nodeRankLatency, orderNodesFromHealthCache, orderNodesForSettings, readHealthCache, removeNodesFromHealthCache, resolveConfiguredNodes, resolveHealthCacheFile, writeHealthCache }


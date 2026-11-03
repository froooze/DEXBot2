/**
 * modules/node_manager.ts - Multi-Node Health Checking and Failover Management
 *
 * Manages a configurable list of BitShares nodes with automatic health checking and
 * intelligent node selection based on latency and availability.
 *
 * ===============================================================================
 * FEATURES
 * ===============================================================================
 *
 * 1. Node Health Monitoring
 *    - Periodic health checks for all configured nodes
 *    - Latency measurement via WebSocket ping
 *    - Chain ID validation (ensure correct network)
 *    - Automatic blacklisting of failed nodes
 *
 * 2. Intelligent Node Selection
 *    - Ranks nodes by measured latency plus a time-decayed connection-churn
 *      penalty (see modules/node_flap_score.ts), so a fast node that keeps
 *      dropping its socket loses to a stable slightly-slower one
 *    - Falls back to slow nodes if no healthy ones available
 *    - Respects user-preferred node if healthy
 *
 * 3. Failover Integration
 *    - Exports node stats for monitoring
 *    - Designed to work with the native transport's setNodes() API
 *    - Automatic recovery when blacklisted nodes become healthy
 *
 * ===============================================================================
 * USAGE
 * ===============================================================================
 *
 * In bitshares_client.ts:
 *
 *   import NodeManager from './node_manager.js';
 *   const nodeManager = new NodeManager(config);
 *   await nodeManager.checkAllNodes();
 *   const bestNode = nodeManager.getBestNode();
 *   nativeClient.setNodes(nodeManager.getHealthyNodes());
 *   nodeManager.start();  // Begin periodic monitoring
 *
 * ===============================================================================
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import Logger from './order/logger.js';
import { NODE_MANAGEMENT } from './constants.js';
import { PATHS, getNodeBlacklistFile } from './paths.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import { getStorage } from './storage/index.js';
const storage = getStorage();
const { readJSON } = storage;
import { createFailureLedger } from './node_failure_ledger.js';
const _WebSocket = globalThis.WebSocket;
import {
    readHealthCache,
    resolveHealthCacheFile,
    writeHealthCache,
} from './node_health_cache.js';
import {
    dropCounters,
    effectiveLatencyMs,
    pruneDropTimes,
    recordDrop,
} from './node_flap_score.js';
import { getErrorMessage, getErrorCode } from './utils/errors.js';
import { nowIso } from './order/utils/system.js';

interface NodeManagerConfig {
    list?: string[];
    blacklistStateFile?: string;
    stateDir?: string;
    healthCheck?: {
        intervalMs?: number;
        timeoutMs?: number;
        maxPingMs?: number;
        blacklistThreshold?: number;
        /** Strikes live this long without a new failure before being forgiven. */
        strikeDecayMs?: number;
        /** Time for a connection drop's selection penalty to halve. */
        flapHalfLifeMs?: number;
        /** Effective-latency cost of one fresh (undecayed) drop. */
        flapPenaltyMsPerDrop?: number;
        /** Ceiling for the decayed penalty, so a degraded node stays usable. */
        flapPenaltyMaxMs?: number;
        enabled?: boolean;
    };
    selection?: {
        strategy?: string;
        preferredNode?: string | null;
    };
    healthCacheFile?: string;
    [key: string]: unknown;
}

type WebSocketLike = WebSocket;

interface NodeStat {
    url: string;
    status: string;
    latencyMs: number | null;
    failureCount: number;
    lastCheckTime: string | null;
    lastErrorMessage: string | null;
    chainId: string | null;
    blacklistedAt: number | null;
    /** When the most recent strike was recorded (drives strike decay). */
    lastFailureAtMs: number | null;
    /**
     * Timestamps of live-transport drops inside the flap window. This is the
     * stability signal node selection ranks on (see modules/node_flap_score.ts)
     * and the value persisted into the shared health cache as drops/h.
     */
    dropTimes: number[];
}

interface ResolvedNodeManagerConfig {
    list: string[];
    healthCheck: {
        intervalMs: number;
        timeoutMs: number;
        maxPingMs: number;
        blacklistThreshold: number;
        strikeDecayMs: number;
        flapHalfLifeMs: number;
        flapPenaltyMsPerDrop: number;
        flapPenaltyMaxMs: number;
        enabled: boolean;
    };
    selection: { strategy: string; preferredNode: string | null };
}

interface PersistedBlacklistEntry {
    status: string;
    blacklistedAt: number | null;
    failureCount: number;
    lastErrorMessage: string | null;
    /** Optional for backward compatibility with older state files. */
    lastFailureAtMs?: number | null;
}

/**
 * Failure sources that count as a live-operation reliability event for churn
 * scoring/selection.
 *
 * Included:
 * - `connection`   an unexpected socket close (code 1006/1001 etc.)
 * - `keep-alive`   the socket stayed open but stopped answering
 * - `broadcast`    a signed batch was accepted but never confirmed in time
 *                  (BROADCAST_DEADLINE) — the socket is up, the node is not
 *                  serving us, which is exactly the instability selection
 *                  should penalize
 *
 * Excluded:
 * - `health-check`    probe-side noise; it already moves the node out of the
 *                     healthy set, and probes may fail for reasons that never
 *                     affect a live session
 * - `forced-reconnect` a client-side recovery attempt, not evidence that the
 *                     node is bad (same rule as shouldCountNodeStrike in
 *                     bitshares_client)
 */
const CHURN_SOURCES = new Set(['connection', 'keep-alive', 'broadcast']);

/** Positive finite number or the fallback (config may carry 0/NaN/strings). */
function positiveOr(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * NodeManager - Manages health checking and selection of BitShares nodes
 *
 * Selection ranks healthy nodes on `latency + decayed churn penalty`, keeps a
 * time-decaying strike count for blacklisting, and exposes per-node churn
 * counters (drops/h) for logging and the shared health cache.
 *
 * @class
 * @param {Object} config - Configuration object
 * @param {string[]} config.list - List of node URLs to monitor (e.g., wss://dex.iobanker.com/ws)
 * @param {Object} [config.healthCheck] - Health check settings
 * @param {number} [config.healthCheck.intervalMs=NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS] - How often to check nodes (milliseconds)
 * @param {number} [config.healthCheck.timeoutMs=5000] - Timeout for each health check
 * @param {number} [config.healthCheck.maxPingMs=3000] - Max acceptable latency
 * @param {number} [config.healthCheck.blacklistThreshold=3] - Failures before blacklist
 * @param {number} [config.healthCheck.strikeDecayMs] - Lifetime of a strike without a new failure
 * @param {number} [config.healthCheck.flapHalfLifeMs] - Half-life of a connection-drop penalty
 * @param {number} [config.healthCheck.flapPenaltyMsPerDrop] - Effective-latency cost per fresh drop
 * @param {number} [config.healthCheck.flapPenaltyMaxMs] - Cap on the decayed churn penalty
 * @param {Object} [config.selection] - Node selection settings
 * @param {string} [config.selection.strategy="latency"] - Selection strategy (latency + churn penalty)
 * @param {string} [config.selection.preferredNode] - Optional preferred node (if healthy)
 */
class NodeManager {
    logger: Logger;
    blacklistStateFile: string;
    healthCacheFile: string;
    config: ResolvedNodeManagerConfig;
    nodeStats: Map<string, NodeStat>;
    _lastBlacklistWarnMs: Map<string, number>;
    monitoringActive: boolean;
    checkIntervalId: ReturnType<typeof setInterval> | null;
    checkAllNodesPromise: Promise<void> | null;
    expectedChainId: string;
    BLACKLIST_COOLDOWN_MS: number;
    FAILURE_REPORT_COOLDOWN_MS: number;
    failureLedger: ReturnType<typeof createFailureLedger>;

    constructor(config: NodeManagerConfig = {}) {
        this.logger = new Logger('NodeManager');
        this.blacklistStateFile = typeof config.blacklistStateFile === 'string' && config.blacklistStateFile.trim()
            ? config.blacklistStateFile
            : (typeof config.stateDir === 'string' && config.stateDir.trim()
                ? getNodeBlacklistFile(config.stateDir)
                : PATHS.PROFILES.NODE_BLACKLIST_JSON);
        this.healthCacheFile = resolveHealthCacheFile(config);
        this.config = {
            list: config.list || [],
            healthCheck: {
                intervalMs: config.healthCheck?.intervalMs ?? NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS,
                timeoutMs: config.healthCheck?.timeoutMs ?? NODE_MANAGEMENT.HEALTH_CHECK_TIMEOUT_MS,
                maxPingMs: config.healthCheck?.maxPingMs ?? NODE_MANAGEMENT.MAX_PING_MS,
                blacklistThreshold: config.healthCheck?.blacklistThreshold ?? NODE_MANAGEMENT.BLACKLIST_THRESHOLD,
                strikeDecayMs: positiveOr(config.healthCheck?.strikeDecayMs, NODE_MANAGEMENT.FAILURE_STRIKE_DECAY_MS),
                flapHalfLifeMs: positiveOr(config.healthCheck?.flapHalfLifeMs, NODE_MANAGEMENT.FLAP_HALF_LIFE_MS),
                flapPenaltyMsPerDrop: positiveOr(config.healthCheck?.flapPenaltyMsPerDrop, NODE_MANAGEMENT.FLAP_PENALTY_MS_PER_DROP),
                flapPenaltyMaxMs: positiveOr(config.healthCheck?.flapPenaltyMaxMs, NODE_MANAGEMENT.FLAP_PENALTY_MAX_MS),
                enabled: config.healthCheck?.enabled ?? true
            },
            selection: {
                strategy: config.selection?.strategy || NODE_MANAGEMENT.SELECTION_STRATEGY,
                preferredNode: config.selection?.preferredNode || null
            }
        };

        // Node statistics tracking
        this.nodeStats = new Map();
        // Shared failure-counting ledger (same rules as the credential daemon's
        // ledger — see modules/node_failure_ledger.ts). Counts live here; the
        // stats map mirrors them for persistence/health-gating.
        this.failureLedger = createFailureLedger({
            threshold: this.config.healthCheck.blacklistThreshold,
            cooldownMs: NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS,
            reportCooldownMs: NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS,
            // NodeManager semantics: the count that crossed the threshold is
            // kept (persisted via the blacklist state file), failures while a
            // node is blacklisted keep counting (each extends the blacklist),
            // and the health-check cooldown expiry resets the entry via reset().
            resetCountOnBlacklist: false,
            resetCountAfterCooldown: false,
            skipWhileBlacklisted: false,
        });
        this.initializeNodeStats();
        this.loadBlacklistState();
        this.loadChurnHistory();

        // Blacklist warning dedup: track last warn time per node+error to suppress repeats.
        this._lastBlacklistWarnMs = new Map();

        // Control flags
        this.monitoringActive = false;
        this.checkIntervalId = null;
        this.checkAllNodesPromise = null;

        // Expected chain ID (BitShares mainnet)
        this.expectedChainId = require('./bitshares-native/serial/chain_constants').GRAPHENE_CHAIN_ID;

        // Blacklist cooldown: retry blacklisted nodes after 24 hours
        this.BLACKLIST_COOLDOWN_MS = NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS;
        this.FAILURE_REPORT_COOLDOWN_MS = NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS;
    }

    /**
     * Initialize tracking for all configured nodes
     * @private
     */
    private initializeNodeStats(): void {
        for (const nodeUrl of this.config.list) {
            if (!this.nodeStats.has(nodeUrl)) {
                this.nodeStats.set(nodeUrl, {
                    url: nodeUrl,
                    status: 'unchecked',      // unchecked | healthy | slow | failed | blacklisted
                    latencyMs: null,
                    failureCount: 0,
                    lastCheckTime: null,
                    lastErrorMessage: null,
                    chainId: null,
                    blacklistedAt: null,
                    lastFailureAtMs: null,
                    dropTimes: []
                });
            }
        }
    }

    /**
     * Load persisted blacklist state from disk
     * @private
     */
    private loadBlacklistState(): void {
        try {
            const state = readJSON(this.blacklistStateFile) as Record<string, PersistedBlacklistEntry> | null;
            if (!state || typeof state !== 'object') return;
            for (const [nodeUrl, entry] of Object.entries(state)) {
                if (!entry || entry.status !== 'blacklisted') continue;
                const stats = this.nodeStats.get(nodeUrl);
                if (!stats) continue;
                stats.status = 'blacklisted';
                stats.failureCount = typeof entry.failureCount === 'number' ? entry.failureCount : this.config.healthCheck.blacklistThreshold;
                stats.blacklistedAt = typeof entry.blacklistedAt === 'number' ? entry.blacklistedAt : Date.now();
                stats.lastErrorMessage = typeof entry.lastErrorMessage === 'string' ? entry.lastErrorMessage : null;
                stats.lastFailureAtMs = typeof entry.lastFailureAtMs === 'number' ? entry.lastFailureAtMs : null;
                // Seed the shared ledger so counting continues across restarts
                // (a persisted blacklist must still count toward the threshold
                // until the cooldown expires or a health check re-admits the
                // node).
                this.failureLedger.seed(nodeUrl, {
                    failureCount: stats.failureCount,
                    blacklistedUntil: (stats.blacklistedAt || 0) + this.BLACKLIST_COOLDOWN_MS,
                });
                this.logger.debug(`Loaded persisted blacklist: ${nodeUrl}`);
            }
        } catch (err) {
            // A never-created blacklist file (normal first run) is not an error.
            if (getErrorCode(err) !== 'ENOENT') {
                this.logger.warn(`Failed to load blacklist state: ${getErrorMessage(err)}`);
            }
        }
    }

    /**
     * Persist blacklisted nodes to disk
     * @private
     */
    private saveBlacklistState(): void {
        try {
            const state: Record<string, PersistedBlacklistEntry> = {};
            for (const stats of this.nodeStats.values()) {
                if (stats.status === 'blacklisted') {
                    state[stats.url] = {
                        status: 'blacklisted',
                        blacklistedAt: stats.blacklistedAt,
                        failureCount: stats.failureCount,
                        lastErrorMessage: stats.lastErrorMessage,
                        lastFailureAtMs: stats.lastFailureAtMs
                    };
                }
            }
            // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A
            // truncated blacklist would cause the next process to either lose
            // all blacklist state or, worse, fail to parse it.
            writeJsonFileAtomic(this.blacklistStateFile, state);
        } catch (err) {
            this.logger.warn(`Failed to save blacklist state: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Seed the in-memory drop history from the shared health cache.
     *
     * Churn has to survive process restarts: a bot that is restarted every few
     * hours would otherwise start every node at zero drops and re-select the
     * flapping endpoint immediately. The cache is written by whichever process
     * last ran a health sweep, so treat it as advisory (any parse/age problem
     * just means "no history yet").
     * @private
     */
    private loadChurnHistory(): void {
        try {
            const cache = readHealthCache({
                healthCacheFile: this.healthCacheFile,
                // Keep history that is newer than the flap window; a 4h probe
                // staleness limit would throw away a valid 24h drop history.
                maxAgeMs: NODE_MANAGEMENT.FLAP_WINDOW_MS,
            });
            if (!cache || !Array.isArray(cache.nodes)) return;
            const now = Date.now();
            for (const entry of cache.nodes) {
                const stats = entry?.url ? this.nodeStats.get(entry.url) : undefined;
                if (!stats || !Array.isArray(entry.dropTimes) || entry.dropTimes.length === 0) continue;
                const flapOptions = this._flapOptions(now);
                stats.dropTimes = pruneDropTimes(entry.dropTimes, now, flapOptions.windowMs);
                if (stats.dropTimes.length > 0) {
                    const counters = dropCounters(stats.dropTimes, flapOptions);
                    this.logger.debug(
                        `Loaded churn history for ${entry.url.substring(0, 40)}... ` +
                        `(${counters.drops24h} drop(s)/24h, penalty ~${counters.penaltyMs}ms)`
                    );
                }
            }
        } catch (err) {
            this.logger.debug(`Churn history unavailable: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Persist the latest healthy/slow node ordering for lightweight consumers
     * such as the credential daemon.
     * @private
     */
    private saveHealthCache(): void {
        try {
            writeHealthCache(this.nodeStats.values() as unknown as Parameters<typeof writeHealthCache>[0], {
                healthCacheFile: this.healthCacheFile,
                // Pass this manager's tuning so the persisted drops/h counters
                // and ordering match what the bot itself would compute.
                flap: this._flapOptions(),
            });
        } catch (err) {
            this.logger.warn(`Failed to save node health cache: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Start periodic health monitoring
     */
    start(): void {
        if (this.monitoringActive) {
            this.logger.warn('Monitoring already active, ignoring duplicate start()');
            return;
        }

        this.monitoringActive = true;
        this.logger.info(`Started monitoring ${this.config.list.length} nodes (interval: ${this.config.healthCheck.intervalMs}ms)`);

        // Initial check immediately
        this.checkAllNodes().catch((err: unknown) => {
            this.logger.warn(`Initial health check failed: ${getErrorMessage(err)}`);
        });

        // Schedule periodic checks
        this.checkIntervalId = setInterval(() => {
            this.checkAllNodes().catch((err: unknown) => {
                this.logger.warn(`Health check cycle failed: ${getErrorMessage(err)}`);
            });
        }, this.config.healthCheck.intervalMs);
        if (typeof this.checkIntervalId.unref === 'function') {
            this.checkIntervalId.unref();
        }
    }

    /**
     * Stop periodic health monitoring
     */
    stop(): void {
        if (!this.monitoringActive) return;

        this.monitoringActive = false;
        if (this.checkIntervalId !== null) {
            clearInterval(this.checkIntervalId);
            this.checkIntervalId = null;
        }
        this.logger.info('Stopped monitoring');
    }

    /**
     * Check all nodes in parallel
     * @returns {Promise<void>}
     */
    async checkAllNodes(): Promise<void> {
        if (this.checkAllNodesPromise) {
            return this.checkAllNodesPromise;
        }

        this.checkAllNodesPromise = (async () => {
            const now = Date.now();
            const promises = Array.from(this.nodeStats.keys())
                .filter((nodeUrl) => {
                    const stats = this.nodeStats.get(nodeUrl);
                    if (stats?.status !== 'blacklisted') return true;
                    if (!stats.blacklistedAt) return false;
                    const cooldownRemaining = this.BLACKLIST_COOLDOWN_MS - (now - stats.blacklistedAt);
                    if (cooldownRemaining > 0) {
                        const remainingHours = Math.ceil(cooldownRemaining / 3600000);
                        this.logger.debug(`${nodeUrl.substring(0, 40)}... blacklisted (${remainingHours}h cooldown remaining)`);
                        return false;
                    }
                    stats.status = 'unchecked';
                    stats.failureCount = 0;
                    stats.blacklistedAt = null;
                    stats.lastFailureAtMs = null;
                    // Churn history is intentionally kept: a node coming off
                    // blacklist still has to prove stability, and the flap
                    // penalty is what keeps it behind a node that never drops.
                    this.failureLedger.reset(nodeUrl);
                    this.saveBlacklistState();
                    this.logger.info(`${nodeUrl.substring(0, 40)}... blacklist cooldown expired, re-enabling`);
                    return true;
                })
                .map((nodeUrl) => {
                    return this.checkNode(nodeUrl).catch((err: unknown) => {
                        // Don't throw, just log - one node failure shouldn't crash the check cycle
                        this.logger.debug(`Check failed for ${nodeUrl}: ${getErrorMessage(err)}`);
                    });
                });

            await Promise.all(promises);
            this.saveHealthCache();
        })();

        try {
            return await this.checkAllNodesPromise;
        } finally {
            this.checkAllNodesPromise = null;
        }
    }

    /**
     * Check a single node's health
     *
     * Measures:
     * 1. WebSocket handshake latency
     * 2. RPC ping latency (get_chain_id)
     * 3. Chain ID validation
     * 4. Classifies as: healthy, slow, or failed
     *
     * @param {string} nodeUrl - WebSocket URL of the node
     * @returns {Promise<Object>} Health check result: { status, latency, error }
     */
    async checkNode(nodeUrl: string): Promise<{ status: string; latency: number | null; error: string | null }> {
        const stats = this.nodeStats.get(nodeUrl);
        if (!stats) {
            this.logger.warn(`Node ${nodeUrl} not in configured list`);
            return { status: 'unknown', latency: null, error: 'Not configured' };
        }

        const timeoutMs = this.config.healthCheck.timeoutMs;

        try {
            // Connect with timeout
            const ws = await this.connectWithTimeout(nodeUrl, timeoutMs);

            try {
                // Measure RPC latency
                const rpcStart = Date.now();
                const result = await this.getChainId(ws, timeoutMs);
                const latencyMs = Date.now() - rpcStart;

                // Validate chain ID
                if (result !== this.expectedChainId) {
                    throw new Error(`Wrong chain ID: ${result}, expected: ${this.expectedChainId}`);
                }

                // Classify health
                const status = latencyMs > this.config.healthCheck.maxPingMs ? 'slow' : 'healthy';
                this._recordHealthCheckSuccess(nodeUrl, status, latencyMs, result);

                if (status === 'healthy') {
                    this.logger.debug(`✓ ${nodeUrl.substring(0, 40)}... (${latencyMs}ms)`);
                } else {
                    this.logger.debug(`⚠ ${nodeUrl.substring(0, 40)}... SLOW (${latencyMs}ms)`);
                }

                return { status, latency: latencyMs, error: null };
            } finally {
                ws.close();
            }
        } catch (err) {
            this.reportNodeFailure(nodeUrl, getErrorMessage(err), 'health-check');
            return { status: stats.status, latency: null, error: getErrorMessage(err) };
        }
    }

    /**
     * Remaining (decayed) strikes for a node at `nowMs`.
     *
     * A strike is worth 1.0 when recorded and falls linearly to 0 across
     * `strikeDecayMs`. Linear decay (not exponential) keeps the threshold
     * meaningful: three strikes on the same day still blacklist, while a node
     * that failed once three days ago starts from 0 again. The remainder is
     * rounded *up*, so a fresh single strike is not silently discounted to 0
     * within minutes by the rounding step.
     */
    _decayedStrikeCount(stats: NodeStat, nowMs: number = Date.now()): number {
        if (stats.failureCount <= 0) return 0;
        if (!stats.lastFailureAtMs) return stats.failureCount;
        const decayMs = this.config.healthCheck.strikeDecayMs;
        const age = Math.max(0, nowMs - stats.lastFailureAtMs);
        if (age >= decayMs) return 0;
        const remainingFactor = 1 - age / decayMs;
        return Math.max(0, Math.ceil(stats.failureCount * remainingFactor));
    }

    /**
     * Record a successful health-probe result: set status/latency and let the
     * strike count decay.
     *
     * This deliberately no longer *resets* strikes: the old
     * liveFailureSuccessStreak rule cleared a live-transport strike after two
     * successful probes, and with a 4h probe interval that forgave a
     * once-a-day flapper twice a day — every failure logged "attempt 1/3" and
     * the node was never blacklisted. Strikes now age out on their own
     * (`strikeDecayMs`), so probe success can re-admit a node's *status*
     * without erasing the evidence that it drops connections.
     *
     * @returns {{ recovered: boolean, failureCount: number }} whether every
     *   strike has aged out, and the remaining count.
     */
    _recordHealthCheckSuccess(nodeUrl: string, status: string, latencyMs: number | null, chainId: string | null): { recovered: boolean; failureCount: number } {
        const stats = this.nodeStats.get(nodeUrl);
        if (!stats) return { recovered: false, failureCount: 0 };

        stats.status = status;
        stats.latencyMs = latencyMs;
        stats.lastCheckTime = nowIso();
        stats.lastErrorMessage = null;
        stats.chainId = chainId;

        const remaining = this._decayedStrikeCount(stats);
        const recovered = remaining <= 0;
        if (stats.failureCount > 0) {
            if (remaining <= 0) {
                stats.failureCount = 0;
                stats.lastFailureAtMs = null;
                this.failureLedger.reset(nodeUrl);
            } else {
                stats.failureCount = remaining;
                // Keep the ledger and the visible count in step, otherwise the
                // next failure would blacklist on stale evidence.
                this.failureLedger.seed(nodeUrl, { failureCount: remaining, blacklistedUntil: 0 });
                this.logger.debug(
                    `${nodeUrl.substring(0, 40)}... ${status} but retaining ${remaining} decaying strike(s)`
                );
            }
        }
        return { recovered, failureCount: stats.failureCount };
    }

    _shouldLogBlacklistWarning(nodeUrl: string, errorMessage: string, nowMs: number = Date.now()): boolean {
        const errorKey = (errorMessage || '').slice(0, 160);
        const warnKey = `${nodeUrl}\0${errorKey}`;
        const lastWarnMs = this._lastBlacklistWarnMs.get(warnKey);
        if (lastWarnMs && (nowMs - lastWarnMs) <= 3_600_000) {
            return false;
        }
        this._lastBlacklistWarnMs.set(warnKey, nowMs);
        if (this._lastBlacklistWarnMs.size > 64) {
            const staleThreshold = nowMs - 3_600_000 * 2;
            for (const [key, ts] of this._lastBlacklistWarnMs) {
                if (ts < staleThreshold) this._lastBlacklistWarnMs.delete(key);
            }
        }
        return true;
    }

    _clearBlacklistWarningCooldown(nodeUrl: string | null = null): void {
        if (!nodeUrl) {
            this._lastBlacklistWarnMs.clear();
            return;
        }

        const prefix = `${nodeUrl}\0`;
        for (const key of this._lastBlacklistWarnMs.keys()) {
            if (key.startsWith(prefix)) {
                this._lastBlacklistWarnMs.delete(key);
            }
        }
    }

    /**
     * Connect to a WebSocket with timeout
     * @private
     * @param {string} nodeUrl - WebSocket URL
     * @param {number} timeoutMs - Connection timeout
     * @returns {Promise<WebSocket>} Connected WebSocket instance
     */
    connectWithTimeout(nodeUrl: string, timeoutMs: number): Promise<WebSocketLike> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let ws: WebSocketLike | null = null;
            const settle = <T,>(method: (value: T) => void, value: T) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                method(value);
            };
            const timeout = setTimeout(() => {
                if (ws) {
                    try {
                        const closable = ws as WebSocketLike & { terminate?: () => void };
                        if (typeof closable.terminate === 'function') {
                            closable.terminate();
                        } else {
                            ws.close();
                        }
                    } catch (err) { this.logger.warn(`WebSocket cleanup failed: ${getErrorMessage(err)}`); }
                }
                settle(reject, new Error(`Connection timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            try {
                ws = new _WebSocket(nodeUrl);

                ws.onopen = () => {
                    settle(resolve, ws!);
                };

                ws.onerror = (err: unknown) => {
                    settle(reject, new Error(`WebSocket error: ${getErrorMessage(err) || 'Unknown'}`));
                };

                ws.onclose = () => {
                    settle(reject, new Error('WebSocket closed unexpectedly'));
                };
            } catch (err) {
                settle(reject, err);
            }
        });
    }

    /**
     * Query the BitShares chain ID using the Graphene WebSocket RPC protocol.
     * @private
     * @param {WebSocket} ws - Connected WebSocket
     * @param {number} timeoutMs - RPC timeout
     * @returns {Promise<string>} Chain ID
     */
    async getChainId(ws: WebSocketLike, timeoutMs: number): Promise<string> {
        await this.rpcCall(ws, 'call', [1, 'login', ['', '']], timeoutMs);
        const databaseApiId = await this.rpcCall(ws, 'call', [1, 'database', []], timeoutMs);
        return this.rpcCall(ws, 'call', [databaseApiId, 'get_chain_id', []], timeoutMs) as Promise<string>;
    }

    /**
     * Make a JSON-RPC call to a WebSocket
     * @private
     * @param {WebSocket} ws - Connected WebSocket
     * @param {string} method - RPC method name
     * @param {Array} params - RPC parameters
     * @param {number} timeoutMs - RPC timeout
     * @returns {Promise<any>} RPC result
     */
    rpcCall(ws: WebSocketLike, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(7);
            const request = {
                jsonrpc: '2.0',
                id: requestId,
                method,
                params
            };

            let isResolved = false;
            const originalHandler = ws.onmessage;

            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    // Clean up message handler to prevent memory leak
                    ws.onmessage = originalHandler;
                    reject(new Error(`RPC timeout after ${timeoutMs}ms`));
                }
            }, timeoutMs);

            ws.onmessage = (msg: MessageEvent) => {
                try {
                    const data = JSON.parse(msg.data) as { id?: unknown; error?: { message?: string }; result?: unknown };
                    if (data.id === requestId && !isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        ws.onmessage = originalHandler;

                        if (data.error) {
                            reject(new Error(`RPC error: ${data.error.message}`));
                        } else {
                            resolve(data.result);
                        }
                    }
                } catch (err) {
                    // Continue listening for correct response
                }
            };

            try {
                ws.send(JSON.stringify(request));
            } catch (err) {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    ws.onmessage = originalHandler;
                    reject(err);
                }
            }
        });
    }

    /**
     * Flap-scoring options built from this manager's configuration.
     * Single place that maps config -> the pure ranking maths, so the ranking,
     * the logged counters and the persisted health cache always agree.
     * @private
     */
    private _flapOptions(nowMs: number = Date.now()): { nowMs: number; windowMs: number; halfLifeMs: number; penaltyMsPerDrop: number; maxPenaltyMs: number } {
        return {
            nowMs,
            windowMs: NODE_MANAGEMENT.FLAP_WINDOW_MS,
            halfLifeMs: this.config.healthCheck.flapHalfLifeMs,
            penaltyMsPerDrop: this.config.healthCheck.flapPenaltyMsPerDrop,
            maxPenaltyMs: this.config.healthCheck.flapPenaltyMaxMs,
        };
    }

    /**
     * Get list of healthy nodes, best first.
     *
     * Ranking is `measured latency + decayed connection-churn penalty`, so a
     * 50ms node that drops its socket daily loses to a stable 350ms node. See
     * modules/node_flap_score.ts for the penalty maths.
     * @returns {string[]} Array of node URLs
     */
    getHealthyNodes(): string[] {
        const preferredNode = this.config.selection.preferredNode;
        const flapOptions = this._flapOptions();
        const healthyStats = Array.from(this.nodeStats.values())
            .filter((stat) => stat.status === 'healthy' || stat.status === 'slow');
        // Precompute one rank per node: doing it inside the comparator would
        // prune and re-sort every node's drop history O(n log n) times.
        const ranks = new Map<NodeStat, number>();
        for (const stat of healthyStats) {
            ranks.set(stat, effectiveLatencyMs(stat.latencyMs, stat.dropTimes, flapOptions));
        }
        const healthy = healthyStats
            .sort((a, b) => {
                if (preferredNode) {
                    const aPreferred = a.url === preferredNode && a.status === 'healthy';
                    const bPreferred = b.url === preferredNode && b.status === 'healthy';
                    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
                }
                if (a.status !== b.status) return a.status === 'healthy' ? -1 : 1;
                // Compare without subtracting: two unknown latencies are both
                // Infinity, and Infinity - Infinity is NaN (an unstable sort
                // comparator).
                const aRank = ranks.get(a) ?? Infinity;
                const bRank = ranks.get(b) ?? Infinity;
                if (aRank === bRank) return 0;
                return aRank < bRank ? -1 : 1;
            })
            .map((stat) => stat.url);

        return healthy;
    }

    /**
     * Connection-churn counters for one node (drops/h, decayed score, penalty).
     * Used for logging and for the shared health cache.
     * @param {string} nodeUrl - Node URL
     * @returns {Object|null} Churn counters or null for an unknown node
     */
    getNodeChurn(nodeUrl: string, nowMs: number = Date.now()): { dropTimes: number[]; flapScore: number; penaltyMs: number; dropsLastHour: number; drops24h: number; dropsPerHour: number } | null {
        const stats = this.nodeStats.get(nodeUrl);
        if (!stats) return null;
        const flapOptions = this._flapOptions(nowMs);
        const dropTimes = pruneDropTimes(stats.dropTimes, nowMs, flapOptions.windowMs);
        return { dropTimes, ...dropCounters(dropTimes, flapOptions) };
    }

    /**
     * Get the single best-ranked healthy node (latency + churn penalty)
     * @returns {string|null} Best node URL or null if none available
     */
    getBestNode(): string | null {
        const healthy = this.getHealthyNodes();
        return healthy.length > 0 ? healthy[0] : null;
    }

    /**
     * Whether a node is currently blacklisted.
     * @param {string} nodeUrl - Node URL
     * @returns {boolean}
     */
    isBlacklisted(nodeUrl: string): boolean {
        return this.nodeStats.get(nodeUrl)?.status === 'blacklisted';
    }

    /**
     * Whether a node should be avoided for selection/reconnect right now
     * (currently failed or blacklisted). Healthy, slow, and not-yet-checked
     * nodes are treated as usable.
     * @param {string} nodeUrl - Node URL
     * @returns {boolean}
     */
    shouldAvoidNode(nodeUrl: string): boolean {
        const status = this.nodeStats.get(nodeUrl)?.status;
        return status === 'failed' || status === 'blacklisted';
    }

    /**
     * Report a node failure (from health check or broadcast).
     * Increments failureCount and auto-blacklists when the threshold is reached.
     * All node-failure paths route through here so the retry budget is synchronized.
     * Counting (threshold / cooldown / rate-limit) is delegated to the shared
     * failure ledger — the same rules the credential daemon applies.
     * @param {string} nodeUrl - Node URL that failed
     * @param {string} [errorMessage] - Optional error description
     * @param {string} [source] - Failure source ('health-check', 'broadcast',
     *   'connection', 'keep-alive'); controls log level and churn accounting
     * @param {number} [nowMs] - Timestamp for the strike/drop (defaults to now;
     *   injectable so tests do not need to sleep past the report cooldown)
     */
    reportNodeFailure(nodeUrl: string, errorMessage?: string, source?: string, nowMs: number = Date.now()): void {
        const stats = this.nodeStats.get(nodeUrl);
        if (!stats) {
            this.logger.warn(`Node ${nodeUrl} not in configured list, cannot report failure`);
            return;
        }
        const isHealthCheck = source === 'health-check';

        const result = this.failureLedger.recordFailure(nodeUrl, nowMs);

        stats.failureCount = result.failureCount;
        stats.lastCheckTime = nowIso();
        if (errorMessage) stats.lastErrorMessage = errorMessage;

        const counted = result.outcome === 'counted' || result.outcome === 'blacklisted';
        // A counted strike refreshes the decay clock. Recording it even for
        // probe failures keeps `failureCount` and its age consistent.
        if (counted) {
            stats.lastFailureAtMs = nowMs;
        }
        // Only live-operation failures feed the churn score used by selection
        // (see CHURN_SOURCES). Rate-limited reports restate the same event, so
        // they are excluded along with blacklisted-node repeats.
        if (counted && source && CHURN_SOURCES.has(source)) {
            stats.dropTimes = recordDrop(stats.dropTimes, nowMs, this._flapOptions(nowMs).windowMs);
        }

        if (result.outcome === 'rate-limited' || result.outcome === 'skipped-blacklisted') {
            return;
        }

        if (result.outcome === 'blacklisted') {
            stats.status = 'blacklisted';
            stats.blacklistedAt = nowMs;
            this.saveBlacklistState();
            this.saveHealthCache();

            if (this._shouldLogBlacklistWarning(nodeUrl, errorMessage || '')) {
                const churn = this.getNodeChurn(nodeUrl);
                this.logger.warn(
                    `✗ ${nodeUrl.substring(0, 40)}... BLACKLISTED after ${result.failureCount} failures (${errorMessage || 'unknown'}) ` +
                    `[churn ${churn ? `${churn.drops24h} drop(s)/24h, +${churn.penaltyMs}ms` : 'n/a'}]`
                );
            }
        } else {
            stats.status = 'failed';
            const log = isHealthCheck ? this.logger.debug.bind(this.logger) : this.logger.warn.bind(this.logger);
            const churn = this.getNodeChurn(nodeUrl);
            log(
                `⚠ ${nodeUrl.substring(0, 40)}... FAILED attempt ${result.failureCount}/${result.threshold} (${errorMessage || 'unknown'})` +
                (churn && churn.drops24h > 0 ? ` [churn ${churn.drops24h} drop(s)/24h, +${churn.penaltyMs}ms]` : '')
            );
        }
    }

    /**
     * Manually blacklist a node (e.g., when it causes a connection failure)
     * @param {string} nodeUrl - Node URL to blacklist
     */
    blacklistNode(nodeUrl: string): void {
        const stats = this.nodeStats.get(nodeUrl);
        if (stats) {
            stats.status = 'blacklisted';
            stats.failureCount = this.config.healthCheck.blacklistThreshold;
            stats.blacklistedAt = Date.now();
            stats.lastFailureAtMs = stats.blacklistedAt;
            this.failureLedger.seed(nodeUrl, {
                failureCount: stats.failureCount,
                blacklistedUntil: stats.blacklistedAt + this.BLACKLIST_COOLDOWN_MS,
            });
            this.saveBlacklistState();
            this.saveHealthCache();
            this.logger.warn(`Manually blacklisted: ${nodeUrl}`);
        }
    }

    /**
     * Reset blacklist for a specific node (allow recovery)
     * @param {string} nodeUrl - Node URL to reset
     */
    resetNode(nodeUrl: string): void {
        const stats = this.nodeStats.get(nodeUrl);
        if (stats) {
            stats.status = 'unchecked';
            stats.failureCount = 0;
            stats.latencyMs = null;
            stats.lastErrorMessage = null;
            stats.blacklistedAt = null;
            stats.lastFailureAtMs = null;
            // An explicit reset is the operator saying "give this node a clean
            // slate": churn history goes with the strikes.
            stats.dropTimes = [];
            this.failureLedger.reset(nodeUrl);
            this._clearBlacklistWarningCooldown(nodeUrl);
            this.saveBlacklistState();
            this.saveHealthCache();
            this.logger.info(`Reset node: ${nodeUrl}`);
        }
    }

    /**
     * Reset all nodes (allow full recovery)
     */
    resetAllNodes() {
        for (const stats of this.nodeStats.values()) {
            stats.status = 'unchecked';
            stats.failureCount = 0;
            stats.latencyMs = null;
            stats.lastErrorMessage = null;
            stats.chainId = null;
            stats.blacklistedAt = null;
            stats.lastFailureAtMs = null;
            stats.dropTimes = [];
        }
        this.failureLedger.clear();
        this._clearBlacklistWarningCooldown();
        this.saveBlacklistState();
        this.saveHealthCache();
        this.logger.info('Reset all nodes');
    }

    /**
     * Get current node statistics (for monitoring/logging)
     * @returns {Array<Object>} Array of node stats
     */
    getStats(): Array<{ url: string; status: string; latencyMs: number | null; failureCount: number; lastCheckTime: string | null; lastErrorMessage: string | null; drops24h: number; dropsPerHour: number; flapPenaltyMs: number }> {
        const nowMs = Date.now();
        return Array.from(this.nodeStats.values()).map((stat) => {
            const churn = this.getNodeChurn(stat.url, nowMs);
            return {
                url: stat.url,
                status: stat.status,
                latencyMs: stat.latencyMs,
                failureCount: stat.failureCount,
                lastCheckTime: stat.lastCheckTime,
                lastErrorMessage: stat.lastErrorMessage,
                drops24h: churn ? churn.drops24h : 0,
                dropsPerHour: churn ? churn.dropsPerHour : 0,
                flapPenaltyMs: churn ? churn.penaltyMs : 0
            };
        });
    }

    /**
     * Get summary statistics
     * @returns {Object} Summary stats
     */
    getSummary(): { monitoring: boolean; counts: Record<string, number>; bestNode: string | null; avgLatency: number | null; totalDrops24h: number } {
        const stats = Array.from(this.nodeStats.values());
        const counts: Record<string, number> = {
            total: stats.length,
            healthy: 0,
            slow: 0,
            failed: 0,
            blacklisted: 0,
            unchecked: 0
        };
        for (const s of stats) {
            if (s.status in counts) counts[s.status]++;
        }

        const bestNode = this.getBestNode();
        const statsWithLatency = stats.filter((s) => s.latencyMs !== null);
        const avgLatency = statsWithLatency.length > 0
            ? Math.round(statsWithLatency.reduce((sum, s) => sum + (s.latencyMs as number), 0) / statsWithLatency.length)
            : null;
        const nowMs = Date.now();
        const totalDrops24h = stats.reduce((sum, s) => {
            const churn = this.getNodeChurn(s.url, nowMs);
            return sum + (churn ? churn.drops24h : 0);
        }, 0);

        return {
            monitoring: this.monitoringActive,
            counts,
            bestNode,
            avgLatency,
            totalDrops24h
        };
    }
}

export default NodeManager


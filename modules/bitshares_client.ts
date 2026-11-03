/**
 * modules/bitshares_client.ts - BitShares Connection Manager
 *
 * Centralized BitShares client connection and account client factory.
 *
 * Features:
 * - Single shared connection for all database queries
 * - Connection state tracking with waitForConnected() helper
 * - Per-account client factory for signing/broadcasting transactions
 * - Subscription and event handling
 *
 * ===============================================================================
 * EXPORTS (17 items)
 * ===============================================================================
 *
 * 1. BitShares - Shared BitShares class for database operations
 *    Used for: querying accounts, assets, orders, subscriptions
 *    Never use for signing transactions
 *
 * 2. createAccountClient(name, key) - Create per-account client for signing
 * 3. waitForConnected(timeoutMs) - Wait for connection to ready state (async)
 * 4. getConnectionStatus() - Get current connection status
 * 5. disconnectClient() - Disconnect the client
 * 6. reconnectForCycle() - Reconnect for maintenance cycle
 * 7. setSuppressConnectionLog(bool) - Suppress/restore connection log output
 * 8. isSuppressConnectionLog() - Whether connection log output is currently suppressed
 * 9. shouldCountNodeStrike(source) - Whether a transport-reported node failure
 *    should count as a persistent strike against the node
 * 10. getNodeManager() - Get the NodeManager instance
 * 11. getNodeStats() - Get node health statistics
 * 12. getNodeSummary() - Get node summary
 * 13. getActiveNodeUrl() - Node currently in use (for failure attribution)
 * 14. getConnectionError() - Get last connection error
 * 15. onReconnect(callback) - Register reconnect callback
 * 16. withTimeout(promise, timeoutMs, options) - Wrap promise with timeout (re-exported from order/utils/timeout.js)
 * 17. _assessFailover() - Internal failover assessment
 * 18. _internal - @internal Internal state (connected flag) — test-only, do not rely on in production
 * ===============================================================================
 */


import { TIMING, NODE_MANAGEMENT, NATIVE_CLIENT } from './constants.js';
import NodeManager from './node_manager.js';
import { readGeneralSettings } from './general_settings.js';
import { sleep } from './order/utils/system.js';
import { withTimeout } from './order/utils/timeout.js';
import Logger from './order/logger.js';
import * as native from './bitshares-native/index.js';
import { createSigningClient } from './bitshares-native/index.js';
import { getErrorMessage } from './utils/errors.js';
import { resolveConnectedNodeAction } from './node_connect_policy.js';
const { TRANSPORT } = NATIVE_CLIENT;
const logger = new Logger('bitshares_client');

interface NodeConfig {
    enabled?: boolean;
    list?: string[];
    healthCheck?: { enabled?: boolean };
    [key: string]: unknown;
}

interface NativeClientRef {
    setNodes(nodes: string[]): void;
    connect(): Promise<unknown>;
    disconnect(): void;
    getNodes(): string[];
    getStatus(): string;
    getCoreAsset(): unknown;
    isConnected?(): boolean;
    transport?: { getNodeUrl?(): string | undefined };
    db: Record<string, unknown>;
    history: Record<string, unknown>;
    subscribe?(...args: unknown[]): unknown;
    unsubscribe?(...args: unknown[]): unknown;
    onReconnect?: () => Promise<void>;
    reportNodeFailure?(node: string, message?: string, source?: string): void;
}

interface SubscriptionManagerLike {
    onReconnect(): Promise<unknown>;
    subscribe(accountName: string, callback: unknown): Promise<unknown>;
    unsubscribe(accountName: string, callback?: unknown): Promise<void>;
    removeNoticeSubscription?(): void;
}

interface ResolversLike {
    resolveAsset(ref: string): unknown;
    resolveAccount(ref: string): Promise<unknown>;
}

type NativeSigningClient = ReturnType<typeof createSigningClient>['client'];

let connected = false;
let suppressConnectionLog = false;
let lastConnectionError: unknown = null;
let intentionalDisconnect = false;
let nodeManager: NodeManager | null = null;
let nodeConfig: NodeConfig | null = null;
let nodeManagerEnabled = false;
let startupNodeRefreshPromise: Promise<string[]> | null = null;
let failoverAssessmentPromise: Promise<boolean> | null = null;
let reconnectInProgress = false;
let lastFailoverAssessmentAt = 0;
const failoverAssessmentCooldownMs = NODE_MANAGEMENT.FAILOVER_ASSESSMENT_COOLDOWN_MS;

// Reconnection callbacks registered by consumers (e.g. DEXBot)
const _reconnectCallbacks = new Set<() => void>();

/**
 * Register a callback to be called after a successful reconnection.
 * @param {Function} callback - Called with no arguments after subscription re-establishment
 * @returns {Function} Unregister function
 */
function onReconnect(callback: unknown): () => void {
    if (typeof callback !== 'function') {
        logger.warn(`onReconnect requires a function, got ${typeof callback}`);
        return () => {};
    }
    const reconnectFn: () => void = callback as unknown as () => void;
    _reconnectCallbacks.add(reconnectFn);
    return () => { _reconnectCallbacks.delete(reconnectFn); };
}

async function notifyReconnectCallbacks() {
    if (_reconnectCallbacks.size === 0) return;
    for (const cb of [..._reconnectCallbacks]) {
        try { await Promise.resolve(cb()); } catch (err) {
            logger.warn(`Reconnect callback error: ${getErrorMessage(err)}`);
        }
    }
}

// Lazy initialization guard
let _initialized = false;

// Native client references (lazily initialized)
let _nativeClient: NativeClientRef;
let _subscriptionManager: SubscriptionManagerLike;
let _nativeBitSharesProxy: Record<string, unknown>;
let _resolvers: ResolversLike;

// Monotonic generation counter for native _nativeClient.connect() calls.
// The native transport's connect() sweep cannot be cancelled, so a timeout
// in the outer withTimeout wrapper only stops the *awaiter* — the sweep
// continues in the background and may resolve later. If the caller has
// since moved on (e.g. failover to a different node list), a late
// resolution would leave _nativeClient connected to the stale node set
// while the caller assumes the connect was abandoned. We tag each
// connect attempt with the current generation and, on resolution, drop
// the result and force a disconnect if the generation has moved on.
let _connectGeneration = 0;

/**
 * Whether a transport-reported node failure should count as a persistent strike
 * in the NodeManager ledger.
 *
 * Everything does EXCEPT 'forced-reconnect'. A forced reconnect is a
 * session-level recovery attempt, not evidence the node is bad: the transport
 * already deprioritizes that node in memory (failedNodes) for the next connect,
 * and that deprioritization is self-clearing once any node connects. Strikes, by
 * contrast, survive restarts and are only cleared by consecutive successful
 * health probes 4h apart — so a false positive costs a healthy node 24h of the
 * rotation. A node that only had a server-side login-session swap (the
 * 2026-09-25 incident) is perfectly healthy, yet 3 forced reconnects 30s apart
 * used to blacklist it.
 *
 * The fill-channel watchdog escalates to a real strike ('fill-channel-
 * unrecoverable') once recovery has demonstrably failed, so genuinely bad nodes
 * are still blacklisted — on the stronger evidence of repeated FAILED recovery
 * rather than mere attempts.
 */
export function shouldCountNodeStrike(source?: string): boolean {
    return source !== 'forced-reconnect';
}

function ensureInitialized() {
    if (_initialized) return;
    _initialized = true;

    const { createSubscriptionManager, createResolvers } = native;
    // Single sink for every node-failure path (live transport + signing/builder
    // fee fetch) so strike counting and blacklisting cannot diverge.
    const reportNodeFailureToManager = (nodeUrl: string, errorMessage?: string, source?: string): void => {
        // A forced reconnect is a session-level RECOVERY ATTEMPT, not evidence
        // that the node is bad — see shouldCountNodeStrike above. The transport's
        // own in-memory deprioritization still applies, so the reconnect rotates
        // away from a wedged node regardless; only the persistent strike is
        // withheld, and the fill-channel watchdog issues it if recovery fails.
        if (!shouldCountNodeStrike(source)) return;
        if (nodeManager) {
            nodeManager.reportNodeFailure(nodeUrl, errorMessage, source);
        }
    };
    _nativeClient = native.createChainClient({
        onStatusChange: handleConnectionStatus,
        // Live transport failures (unexpected close, keep-alive trip) feed
        // the NodeManager failure ledger so flapping nodes accumulate
        // strikes and get blacklisted (3 strikes, 24h cooldown) instead of
        // being re-selected forever. Late-bound because nodeManager is created
        // after the client.
        onNodeFailure: reportNodeFailureToManager,
        // Blacklist-aware reconnect: the transport prefers nodes that are not
        // failed/blacklisted, so a stale node is switched away from instead of
        // winning the reconnect race again.
        shouldSkipNode: (nodeUrl: string) => {
            if (!nodeManager) return false;
            return nodeManager.shouldAvoidNode(nodeUrl);
        },
        rpcTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
        connectTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
    } as never) as unknown as NativeClientRef;
    _subscriptionManager = createSubscriptionManager(_nativeClient as never) as unknown as SubscriptionManagerLike;
    _nativeClient.onReconnect = async () => {
        await _subscriptionManager.onReconnect();
        await notifyReconnectCallbacks();
    };
    // Required by modules/bitshares-native/tx/builder.ts (fee-cache failures).
    _nativeClient.reportNodeFailure = reportNodeFailureToManager;
    _resolvers = createResolvers(_nativeClient as never) as unknown as ResolversLike;

    _nativeBitSharesProxy = {
        get connect() {
            return (servers: string | string[], _autoreconnect: unknown) => {
                if (Array.isArray(servers)) _nativeClient.setNodes(servers);
                return _nativeClient.connect();
            };
        },
        get disconnect() { return () => _nativeClient.disconnect(); },
        get node() { return _nativeClient.getNodes(); },
        set node(_v) { _nativeClient.setNodes(Array.isArray(_v) ? _v : []); },
        get autoreconnect() { return true; },
        set autoreconnect(_v) {},
        get connectPromise() { return undefined; },
        set connectPromise(_v) {},
        get subscribe() {
            return (eventType: string, callback: unknown, accountName: string) => {
                if (eventType === 'account') {
                    return _subscriptionManager.subscribe(accountName, callback);
                }
                if (_nativeClient && _nativeClient.subscribe) {
                    return _nativeClient.subscribe(eventType, callback, accountName);
                }
            };
        },
        get unsubscribe() {
            return (eventType: string, callback: unknown, accountName: string) => {
                if (eventType === 'account') {
                    return _subscriptionManager.unsubscribe(accountName, callback);
                }
                if (_nativeClient && _nativeClient.unsubscribe) {
                    return _nativeClient.unsubscribe(eventType, callback, accountName);
                }
            };
        },
        get assets() {
            return new Proxy({}, {
                get(_target: unknown, prop: string | symbol) {
                    if (typeof prop !== 'string') return undefined;
                    return _resolvers.resolveAsset(prop);
                },
            });
        },
        get accounts() {
            return new Proxy({}, {
                get(_target: unknown, prop: string | symbol) {
                    if (typeof prop !== 'string') return undefined;
                    return _resolvers.resolveAccount(prop).then((acc: unknown) => acc || null);
                },
            });
        },
        get chain() { return { get coreAsset() { return _nativeClient.getCoreAsset(); } }; },
        get db() {
            // The native transport (modules/bitshares-native/transport.ts:380)
            // already enforces a per-RPC timeout of TRANSPORT.RPC_TIMEOUT_MS
            // (15s) on every call(). An additional wrapper here would only add
            // dead slack past the native rejection and produce misleading
            // error messages. Pass through directly.
            const source = _nativeClient.db;
            return new Proxy(source, {
                get(target, prop) {
                    const key = String(prop);
                    if (typeof target[key] === 'function') {
                        return (...args: unknown[]) => (target[key] as (...a: unknown[]) => unknown)(...args);
                    }
                    return (...args: unknown[]) => (target.call as (m: string, a: unknown[]) => unknown)(key, args);
                },
            });
        },
        get history() {
            const source = _nativeClient.history;
            return new Proxy(source, {
                get(target, prop) {
                    const key = String(prop);
                    if (typeof target[key] === 'function') {
                        return (...args: unknown[]) => (target[key] as (...a: unknown[]) => unknown)(...args);
                    }
                    return (...args: unknown[]) => (target.call as (m: string, a: unknown[]) => unknown)(key, args);
                },
            });
        },
    };

    const settings = readGeneralSettings({
        fallback: null,
            onError: (err: unknown) => {
            logger.warn(`Config load failed, continuing with defaults: ${getErrorMessage(err)}`);
        },
    });

    const nodeSettings = settings?.NODES;
    const configuredNodes: string[] = Array.isArray(nodeSettings?.list)
        ? (nodeSettings.list as unknown[]).filter((node): node is string => typeof node === 'string' && Boolean(node.trim()))
        : [];
    nodeManagerEnabled = nodeSettings?.enabled ?? NODE_MANAGEMENT.DEFAULT_ENABLED;

    const effectiveNodes = configuredNodes.length > 0 ? configuredNodes : NODE_MANAGEMENT.DEFAULT_NODES;
    _nativeClient.setNodes(effectiveNodes.slice());
    if (nodeManagerEnabled) {
        nodeConfig = {
            ...nodeSettings,
            enabled: nodeManagerEnabled,
            list: effectiveNodes,
        };
        nodeManager = new NodeManager(nodeConfig as unknown as ConstructorParameters<typeof NodeManager>[0]);
        if (!suppressConnectionLog) {
            logger.info(`Loaded config for ${nodeConfig!.list!.length} nodes`);
        }
    } else {
        if (!suppressConnectionLog) {
            logger.info(`Node management disabled; using ${effectiveNodes.length} configured node(s)`);
        }
    }
}

interface LazyBitShares {
    db: Record<string, (...args: unknown[]) => Promise<unknown>>;
    history: Record<string, (...args: unknown[]) => Promise<unknown>>;
    assets: Record<string, unknown>;
    accounts: Record<string, unknown>;
    chain: { coreAsset: unknown };
    connect(...args: unknown[]): unknown;
    disconnect(...args: unknown[]): unknown;
    subscribe(...args: unknown[]): Promise<unknown>;
    unsubscribe(...args: unknown[]): Promise<unknown>;
    node: unknown;
    autoreconnect: boolean;
    connectPromise: unknown;
    [key: string]: unknown;
}

// BitShares proxy that auto-initializes on first property access
const _lazyBitShares: LazyBitShares = new Proxy({}, {
    get(_target: object, prop: string | symbol) {
        ensureInitialized();
        if (typeof prop !== 'string') return undefined;
        return _nativeBitSharesProxy[prop];
    },
    set(_target: unknown, prop: string | symbol, value: unknown): boolean {
        ensureInitialized();
        if (typeof prop !== 'string') return false;
        _nativeBitSharesProxy[prop] = value;
        return true;
    },
}) as unknown as LazyBitShares;

/**
 * Suppress or restore connection log output.
 * @param {boolean} suppress - Whether to suppress connection logs
 * @returns {void}
 */
function setSuppressConnectionLog(suppress: boolean): void {
    suppressConnectionLog = suppress;
}

/** Whether connection log output is currently suppressed. */
function isSuppressConnectionLog(): boolean {
    return suppressConnectionLog;
}

/**
 * Restart the BitShares connection with a new server list.
 * @param {string|string[]} serverList - Node URL or array of node URLs
 * @param {string} [reason='startup'] - Reason for reconnection
 * @returns {Promise<boolean>} True if connection succeeded
 */
async function restartBitsharesConnection(serverList: string | string[] | null | undefined, reason: string = 'startup'): Promise<boolean> {
    ensureInitialized();
    if (reconnectInProgress) return false;
    const servers = Array.isArray(serverList)
        ? serverList.filter((server: unknown) => typeof server === 'string' && server.trim())
        : [];
    if (servers.length === 0) return false;

    // Keep an already-healthy socket. The transport's own connect() no-op only
    // applies when its candidate list still contains the active node, and this
    // function used to bypass that by disconnecting first — so every
    // maintenance/refresh cycle tore down a working connection (logs showed
    // 88 such socket cycles in 18 days, each costing a re-login, a
    // re-subscribe and a safety-net sync). If the node we are on is still an
    // acceptable target, re-point the candidate list and keep the socket.
    //
    // Never keep a blacklisted node: that would defeat the post-connect switch
    // in handleConnectionStatus('connected'). Wedged-session recovery does not
    // depend on this path — the transport's forceReconnect (api-id recovery and
    // the fill-channel watchdog) is unaffected by the skip.
    const activeNode = _nativeClient?.transport?.getNodeUrl?.() ?? null;
    const alreadyConnected = _nativeClient?.isConnected?.() ?? false;
    const activeNodeUsable = !!activeNode && !(nodeManager?.isBlacklisted(activeNode) ?? false);
    if (alreadyConnected && activeNode && activeNodeUsable && servers.includes(activeNode)) {
        _nativeClient.setNodes(servers);
        if (!suppressConnectionLog) {
            logger.info(`${reason}: keeping existing connection to ${activeNode}`);
        }
        return true;
    }

    try {
        reconnectInProgress = true;
        connected = false;

        try { _nativeClient.disconnect(); } catch (_) {}
        _nativeClient.setNodes(servers);
        const myGeneration = ++_connectGeneration;
        const connectPromise = _nativeClient.connect();
        try {
            await withTimeout(
                connectPromise,
                TRANSPORT.CONNECT_TOTAL_TIMEOUT_MS,
                { label: 'BitShares connection' }
            );
        } catch (connectErr) {
            // The native connect() sweep continues in the background even
            // though withTimeout rejected. Tag the sweep with the generation
            // it was started under — its eventual settlement forces a
            // disconnect to keep isConnected() consistent with the caller's
            // timeout. Two cases:
            //   - Generation has moved: a NEW connect is in progress. The
            //     late success would interfere with it, so force-disconnect.
            //   - Generation has NOT moved: no new connect was started. The
            //     late success would leave the transport internally connected
            //     while the module-level `connected` flag is still false,
            //     creating a state mismatch where isConnected() returns false
            //     but the transport is actually live. Force-disconnect to
            //     keep the state consistent.
            connectPromise
                .then(() => {
                    logger.warn(
                        `Late native connect success after timeout ` +
                        `(attempt generation=${myGeneration}, current=${_connectGeneration}). ` +
                        `Forcing disconnect to keep isConnected() state consistent.`
                    );
                    try { _nativeClient.disconnect(); } catch (_) {}
                })
                .catch(() => { /* expected when sweep gives up */ });
            throw connectErr;
        }
        if (_subscriptionManager) {
            try { await _subscriptionManager.onReconnect(); } catch (err) {
                logger.warn(`Subscription re-establishment after reconnect failed: ${getErrorMessage(err)}`);
            }
        }

        // Notify registered reconnection callbacks (e.g. DEXBot safety-net sync)
        await notifyReconnectCallbacks();

        if (!suppressConnectionLog) {
            const landedNode = _nativeClient?.transport?.getNodeUrl?.();
            logger.info(`${reason}: reconnect requested across ${servers.length} node(s), landed on ${landedNode || 'unknown'}`);
        }
        return true;
    } catch (err) {
        lastConnectionError = err;
        try { _nativeClient.disconnect(); } catch (_) {}
        if (!suppressConnectionLog) {
            logger.warn(`${reason}: reconnect request failed: ${getErrorMessage(err) || err}`);
        }
        return false;
    } finally {
        reconnectInProgress = false;
    }
}

/**
 * Assess failover: check node health and reconnect to a healthy node if current one is down.
 * @param {string} [reason='status change'] - Reason for failover assessment
 * @returns {Promise<boolean>} True if failover reconnect succeeded
 * @private
 */
async function assessFailover(reason: string = 'status change'): Promise<boolean> {
    ensureInitialized();
    if (!nodeManager || nodeConfig?.healthCheck?.enabled === false) return false;
    if (reconnectInProgress) return false;
    if (failoverAssessmentPromise) return failoverAssessmentPromise;
    // Cooldown: a single close can fan into multiple assessFailover calls
    // (probe socket close + live transport close). Skip the second one for a
    // short window so we only ever do one probe+restart per real disconnect.
    const now = Date.now();
    if (now - lastFailoverAssessmentAt < failoverAssessmentCooldownMs) return false;
    lastFailoverAssessmentAt = now;

    failoverAssessmentPromise = (async () => {
        const activeNode = _nativeClient?.transport?.getNodeUrl?.();
        logger.warn(`${reason} (node=${activeNode || 'unknown'}), triggering failover assessment`);
        try {
            await nodeManager.checkAllNodes();
            const healthyNodes = nodeManager.getHealthyNodes();
            const availableHealthyNodes = activeNode
                ? healthyNodes.filter((node) => node !== activeNode)
                : healthyNodes;
            const fallbackNodes = getConfiguredOrDefaultNodes();
            const availableFallbackNodes = activeNode
                ? fallbackNodes.filter((node) => node !== activeNode)
                : fallbackNodes;
            const nextNodes = availableHealthyNodes.length > 0
                ? availableHealthyNodes
                : (healthyNodes.length > 0 ? healthyNodes : (availableFallbackNodes.length > 0 ? availableFallbackNodes : fallbackNodes));
            // Avoid restarting to the same node we are already on. With the
            // transport connect() no-op, a redundant restart is at best a
            // no-op and at worst a forced disconnect cycle.
            if (activeNode && (nextNodes.length === 0 || (nextNodes.length === 1 && nextNodes[0] === activeNode))) {
                logger.info(`${reason}: no better node available, keeping ${activeNode}`);
                return false;
            }
            return restartBitsharesConnection(nextNodes, reason);
        } catch (err) {
            logger.warn(`Failover assessment error: ${getErrorMessage(err)}`);
            return false;
        }
    })();

    try {
        return await failoverAssessmentPromise;
    } finally {
        failoverAssessmentPromise = null;
    }
}

/**
 * Get the configured node list, falling back to defaults.
 * @returns {string[]} Array of node URLs
 */
function getConfiguredOrDefaultNodes() {
    ensureInitialized();
    return Array.isArray(nodeConfig?.list) && nodeConfig.list.length > 0
        ? nodeConfig.list
        : NODE_MANAGEMENT.DEFAULT_NODES;
}

/**
 * Handle connection status change events from the native client.
 * @param {string} status - Connection status string ('connected', 'connecting', 'closed')
 * @returns {boolean} Whether the event was handled
 */
function handleConnectionStatus(status: string): boolean {
    const canHandleFailover = nodeManager && nodeConfig?.healthCheck?.enabled !== false;

    if (status === 'connected') {
        connected = true;
        lastConnectionError = null;
        if (nodeManager && nodeConfig?.healthCheck?.enabled !== false && !nodeManager.monitoringActive) {
            nodeManager.start();
        }
        if (!suppressConnectionLog) {
            logger.info('BitShares connected');
        }
        if (nodeManager) {
            const activeNode = _nativeClient?.transport?.getNodeUrl?.();
            // Pure decision (modules/node_connect_policy): a blacklisted active
            // node switches to a healthy one (autonomous reconnects do not
            // consult the blacklist); otherwise align the transport's candidate
            // list with the healthy set so future reconnects avoid known-bad
            // nodes. The switch is deferred so we do not tear down the socket
            // from inside the transport's own status callback.
            const decision = resolveConnectedNodeAction({
                healthCheckEnabled: nodeConfig?.healthCheck?.enabled !== false,
                reconnectInProgress,
                activeNode,
                isBlacklisted: (nodeUrl: string) => nodeManager!.isBlacklisted(nodeUrl),
                getHealthyNodes: () => nodeManager!.getHealthyNodes(),
            });
            if (decision.action === 'switch') {
                logger.warn(`Connected to blacklisted node ${activeNode}; switching to a healthy node`);
                const { nodes: healthy } = decision;
                setTimeout(() => {
                    // Skip if the process is shutting down or the node has
                    // since recovered/been reset.
                    if (intentionalDisconnect || !activeNode || !nodeManager?.isBlacklisted(activeNode)) return;
                    restartBitsharesConnection(healthy, decision.reason)
                        .catch((err: unknown) => logger.warn(`Blacklisted-node switch failed: ${getErrorMessage(err)}`));
                }, 0);
            } else if (decision.action === 'align') {
                _nativeClient.setNodes(decision.nodes);
            }
        }
        return false;
    }

    if (status === 'closed') {
        connected = false;
        if (canHandleFailover && !reconnectInProgress) {
            if (intentionalDisconnect) {
                return true;
            }
            assessFailover('Connection closed').catch((err: unknown) => {
                logger.warn(`Failover assessment failed: ${getErrorMessage(err)}`);
            });
            return true;
        }
    }
    return false;
}

/**
 * Refresh node servers at startup by health-checking all configured nodes.
 * @param {string} [reason='startup'] - Reason for the refresh
 * @returns {Promise<string[]>} Array of selected node URLs
 */
async function refreshStartupNodeServers(reason: string = 'startup'): Promise<string[]> {
    ensureInitialized();
    if (!nodeManager || !nodeConfig?.list?.length) {
        return Array.isArray(nodeConfig?.list) ? nodeConfig.list : [];
    }
    if (startupNodeRefreshPromise) return startupNodeRefreshPromise;

    startupNodeRefreshPromise = (async () => {
        try {
            if (nodeConfig.healthCheck?.enabled === false) {
                const fallbackNodes = getConfiguredOrDefaultNodes();
                await restartBitsharesConnection(fallbackNodes, `Startup ${reason}`);
                if (!suppressConnectionLog) {
                    logger.info(`Startup ${reason}: using ${fallbackNodes.length} configured node(s) without health probing`);
                }
                return fallbackNodes;
            }
            await nodeManager.checkAllNodes();
            const healthyNodes = nodeManager.getHealthyNodes();
            const nextNodes = healthyNodes.length > 0 ? healthyNodes : getConfiguredOrDefaultNodes();
            await restartBitsharesConnection(nextNodes, `Startup ${reason}`);
            if (!suppressConnectionLog) {
                logger.info(`Startup ${reason}: using ${nextNodes.length} node(s)`);
            }
            return nextNodes;
        } catch (err) {
            if (!suppressConnectionLog) {
                logger.warn(`Startup ${reason} node refresh failed: ${getErrorMessage(err)}`);
            }
            return getConfiguredOrDefaultNodes();
        }
    })();

    try {
        return await startupNodeRefreshPromise;
    } finally {
        startupNodeRefreshPromise = null;
    }
}

/**
 * Wait for the BitShares connection to become ready.
 * @param {number} [timeoutMs=TIMING.CONNECTION_TIMEOUT_MS] - Max time to wait in ms
 * @param {Object} [options={}] - Wait options
 * @param {number} [options.retryDelayMs] - Initial retry delay in ms
 * @param {number} [options.maxRetryDelayMs] - Maximum retry delay in ms
 * @param {number} [options.refreshNodesEveryMs] - Interval to refresh nodes while waiting
 * @returns {Promise<boolean>} True when connected
 * @throws {Error} If connection times out
 */
async function waitForConnected(timeoutMs: number = TIMING.CONNECTION_TIMEOUT_MS, options: { retryDelayMs?: number; maxRetryDelayMs?: number; refreshNodesEveryMs?: number } = {}): Promise<boolean> {
    ensureInitialized();
    const start = Date.now();
    const initialDelayMs = Number.isFinite(options.retryDelayMs)
        ? Math.max(0, options.retryDelayMs!)
        : NODE_MANAGEMENT.STARTUP_RETRY_INITIAL_DELAY_MS;
    const maxDelayMs = Number.isFinite(options.maxRetryDelayMs)
        ? Math.max(initialDelayMs, options.maxRetryDelayMs!)
        : NODE_MANAGEMENT.STARTUP_RETRY_MAX_DELAY_MS;
    const refreshNodesEveryMs = Number.isFinite(options.refreshNodesEveryMs)
        ? Math.max(0, options.refreshNodesEveryMs!)
        : NODE_MANAGEMENT.STARTUP_REFRESH_INTERVAL_MS;
    let retryDelayMs = initialDelayMs;
    let nextNodeRefreshAt = 0;

    while (!connected) {
        const elapsedMs = Date.now() - start;
        if (elapsedMs >= timeoutMs) break;

        if (nodeManagerEnabled && Date.now() >= nextNodeRefreshAt) {
            const remainingBeforeRefreshMs = timeoutMs - (Date.now() - start);
            if (remainingBeforeRefreshMs <= 0) break;
            await Promise.race([
                refreshStartupNodeServers(elapsedMs === 0 ? 'initial' : 'retry'),
                sleep(Math.max(0, remainingBeforeRefreshMs)),
            ]);
            nextNodeRefreshAt = Date.now() + refreshNodesEveryMs;
        }

        if (connected) break;

        const remainingMs = timeoutMs - (Date.now() - start);
        const sleepMs = Math.min(retryDelayMs, Math.max(0, remainingMs));
        if (sleepMs > 0) await sleep(sleepMs);
        retryDelayMs = Math.min(maxDelayMs, retryDelayMs > 0 ? retryDelayMs * 2 : maxDelayMs);
    }

    if (!connected) {
        const suffix = (lastConnectionError as { message?: unknown } | null)?.message ? ` Last error: ${getErrorMessage(lastConnectionError)}` : '';
        throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms.${suffix}`);
    }
    return true;
}

/**
 * Create a per-account client for signing transactions.
 * @param {string} accountName - Account name
 * @param {string|Object} privateKey - Private key or daemon signing token
 * @returns {Promise<Object>} Account client with initPromise, newTx(), broadcast()
 */
async function createAccountClient(accountName: unknown, privateKey: unknown): Promise<NativeSigningClient> {
    ensureInitialized();
    await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);

    const signingClient = createSigningClient(_nativeClient as never, String(accountName), privateKey as string | object);
    return signingClient.client;
}

/**
 * Get the current connection status.
 * @returns {string} Status string from native client
 */
function getConnectionStatus() {
    ensureInitialized();
    return _nativeClient.getStatus();
}

/**
 * Disconnect the BitShares client.
 * @returns {Promise<void>}
 */
async function disconnectClient() {
    // Nothing to tear down if the client was never initialized. Calling
    // ensureInitialized() here would lazily create the whole client stack
    // (including the "Loaded config for N nodes" log) just to immediately
    // discard it — e.g. `dexbot bot` after an idle bot-manager session.
    if (!_initialized) return;
    intentionalDisconnect = true;
    connected = false;
    try {
        try { _nativeClient.disconnect(); } catch (_) {}
        // Stop periodic node health monitoring (see handleConnectionStatus:
        // the monitor starts on 'connected' and its immediate checkAllNodes()
        // sweep plus the transport reconnect it triggers open real WebSocket
        // handshakes to every configured node). disconnectClient is the single
        // teardown path, so stopping here covers both production shutdown
        // and unit tests that initialized the client stack for one read.
        try { nodeManager?.stop?.(); } catch (_) {}
        if (_subscriptionManager) {
            try {
                if (typeof _subscriptionManager.removeNoticeSubscription === 'function') {
                    _subscriptionManager.removeNoticeSubscription();
                }
            } catch (_) {}
        }
    } finally {
        intentionalDisconnect = false;
    }
}

/**
 * Reconnect using healthy nodes (for adapter cycles or periodic refresh).
 * @param {string} [reason='adapter-cycle'] - Reason for reconnection
 * @returns {Promise<boolean>} True if reconnection succeeded
 */
async function reconnectForCycle(reason: string = 'adapter-cycle'): Promise<boolean> {
    ensureInitialized();
    const nodes = nodeManager && nodeConfig?.healthCheck?.enabled !== false
        ? nodeManager.getHealthyNodes()
        : [];
    const effective = nodes.length > 0 ? nodes : getConfiguredOrDefaultNodes();
    return restartBitsharesConnection(effective, reason);
}

function getNodeManager() {
    ensureInitialized();
    return nodeManager;
}
function getNodeStats() {
    ensureInitialized();
    return nodeManager?.getStats();
}
/**
 * The node the transport is currently connected to (null when unknown).
 *
 * Use this — not `nodeManager.getBestNode()` — when attributing a failure to a
 * node: the best node is the lowest-ranked *candidate* and need not be the one
 * that served the request.
 *
 * Deliberately does NOT call ensureInitialized(): this is called from failure
 * and logging paths, and lazily creating the whole client stack just to return
 * null would be worse than reporting null.
 */
function getActiveNodeUrl(): string | null {
    return _nativeClient?.transport?.getNodeUrl?.() ?? null;
}
function getNodeSummary() {
    ensureInitialized();
    return nodeManager?.getSummary();
}
function getConnectionError() {
    return lastConnectionError;
}
/** @internal Exposed for unit tests only — do not rely on in production code. */
const _internal = {
    get connected() { return connected; },
};
const _default = { BitShares: _lazyBitShares, createAccountClient, waitForConnected, getConnectionStatus, disconnectClient, reconnectForCycle, setSuppressConnectionLog, isSuppressConnectionLog, onReconnect, withTimeout, _assessFailover: assessFailover, getNodeManager, getNodeStats, getNodeSummary, getActiveNodeUrl, getConnectionError, _internal }

export default _default;

export { _lazyBitShares as BitShares, createAccountClient, waitForConnected, getConnectionStatus, disconnectClient, reconnectForCycle, setSuppressConnectionLog, isSuppressConnectionLog, onReconnect, withTimeout, assessFailover as _assessFailover, getNodeManager, getNodeStats, getNodeSummary, getActiveNodeUrl, getConnectionError, _internal }

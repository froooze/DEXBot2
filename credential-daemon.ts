#!/usr/bin/env node
// node-only entry point — credential daemon (Unix socket, net, os, fs)
/**
 * credential-daemon.ts - Secure Private Key Server
 *
 * DEXBot credential daemon for multi-bot private key management.
 * Enables bot processes to request pre-decrypted keys via Unix socket.
 * Keeps the derived vault secret in RAM so key updates remain visible while the daemon runs.
 *
 * ===============================================================================
 * DAEMON OPERATION
 * ===============================================================================
 *
 * STARTUP:
 * 1. Prompts for master password ONCE at startup
 * 2. Authenticates with profiles/keys.json
 * 3. Re-wraps the decrypted account cache with a random session secret
 * 4. Keeps the derived vault secret and session cache in RAM during operation
 * 5. Listens on Unix socket for credential requests
 * 6. Services private key requests from bot processes
 *
 * COMMUNICATION:
 * - Socket: profiles/run/dexbot-cred-daemon.sock (or $DEXBOT_CRED_RUNTIME_DIR, or $XDG_RUNTIME_DIR/dexbot2/)
 * - Ready file: profiles/run/dexbot-cred-daemon.ready (or $DEXBOT_CRED_RUNTIME_DIR, or $XDG_RUNTIME_DIR/dexbot2/)
 * - Startup timeout: 60 seconds (DAEMON_STARTUP_TIMEOUT_MS)
 * - Linux only (Unix socket)
 *
 * REQUEST FORMAT:
 *   {"type": "ping", "accountName": "account-name"}
 *   {"type": "probe-account", "accountName": "account-name"}
 *   {"type": "execute-operations", "sessionId": "...", "accountName": "account-name", "operations": [...]}
 *
 * RESPONSE FORMAT:
 *   Success:  {"success": true, ...}
 *   Failure:  {"success": false, "error": "Error message"}
 *
 * ===============================================================================
 * SECURITY BENEFITS
 * ===============================================================================
 *
 * - Master password prompt only once (at daemon startup)
 * - Individual bot processes have no access to the derived vault secret
 * - No persisted raw password in environment variables or config files
 * - Private keys never written to disk unencrypted
 * - Centralized key management
 * - Unix socket provides process-level isolation
 *
 * ===============================================================================
 * USAGE
 * ===============================================================================
 *
 * Direct:
 *   node dist/credential-daemon.js
 *
 * Via PM2 (recommended):
 *   npm run unlock
 *   or: dexbot start
 *
 * Bot processes then access keys automatically via socket connection.
 *
 * ===============================================================================
 */

import { getErrorMessage, getErrorCode, getErrorField } from './modules/utils/errors.js';
import type { Server, Socket } from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { setUmask } = require('./modules/config');
setUmask(0o077);

const net = require('net');
const fs = require('fs');
const { path } = require('./modules/path_api');
const { randomBytes, createHmac } = require('./modules/crypto/sync');
const chainKeys = require('./modules/chain_keys');
const { TIMING, NODE_MANAGEMENT, DAEMON_ERRORS, DAEMON_CODES } = require('./modules/constants');
const { readGeneralSettings } = require('./modules/general_settings');
const { orderNodesForSettings } = require('./modules/node_health_cache');
const credentialPolicy = require('./modules/credential_policy');
const { getStorage } = require('./modules/storage');
const storage = getStorage();
interface NativeChainClient {
    getStatus(): string;
    setNodes(nodes: string[]): void;
    connect(): Promise<unknown>;
    disconnect(): void;
    transport?: { getNodeUrl?(): string | undefined };
    db: { lookup_asset_symbols(refs: string[]): Promise<unknown> };
}

interface SigningClientEntry {
    signingClient: { dispose?(): void; client: SigningClientLike };
    createdAt: number;
}

interface PolicyConfigShape {
    sessionTtlMs?: number;
    accounts?: Record<string, { botHmacSecret?: string }>;
    [key: string]: unknown;
}

interface BroadcastGuard {
    isFired(): boolean;
    promise: Promise<unknown>;
    currentNode: string | null;
    fire(reason: string): void;
    clearTimer(): void;
}

interface BroadcastOptions {
    startedAt?: number;
    guard?: BroadcastGuard;
    workRef?: { work: Promise<unknown> | null };
}

interface RequestPayload {
    type?: string;
    accountName?: string;
    sessionId?: string | null;
    operations?: Array<{ op_name?: string; op_data?: unknown }>;
    nodeUrl?: unknown;
    [key: string]: unknown;
}

interface TxBuilder {
    broadcast(): Promise<unknown>;
    [key: string]: unknown;
}

interface SigningClientLike {
    initPromise?: Promise<unknown>;
    newTx(): TxBuilder;
}

interface UncertainError extends Error {
    code: string;
    uncertain: boolean;
    accountName: string;
    startedAt: number;
    ageMs: number;
}

let _nativeChainClient: NativeChainClient;
let _nativeNodeList: string[] = [];

const native = require('./modules/bitshares-native');
_nativeChainClient = native.createChainClient({ rpcTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS, connectTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS });

// Register asset-ref resolver so the credential policy can resolve symbol
// names (e.g. "BTS" -> "1.3.0") using the native chain client instead of
// the legacy global BitShares object (which is not initialised in daemon
// context).
const assetResolver = async (assetRef: string): Promise<string | null> => {
    try {
        if (_nativeChainClient.getStatus() !== 'connected') {
            _nativeChainClient.setNodes(_nativeNodeList.length > 0 ? _nativeNodeList : NODE_MANAGEMENT.DEFAULT_NODES);
            await _nativeChainClient.connect();
        }
        const result = await _nativeChainClient.db.lookup_asset_symbols([assetRef]);
        const asset = Array.isArray(result) ? result[0] : null;
        return asset?.id ? String(asset.id) : null;
    } catch (_) {
        return null;
    }
};
credentialPolicy.setExternalAssetResolver(assetResolver);

_nativeNodeList = [];
const {
    assertPrivatePathSecurity,
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialRuntimeDir,
    getCredentialSocketPath,
} = require('./modules/credential_runtime');
const {
    buildSessionAccountCache,
    loadDaemonPrivateKey,
} = require('./modules/credential_session_cache');
const { fetchBootstrapPassword } = require('./modules/launcher/credential_bootstrap');
const { normalizeBootstrapCredential } = require('./modules/launcher/credential_secret');
const Logger = require('./modules/order/logger').default;
const { ensureDir, unlink: safeUnlink } = storage;
const { Config } = require('./modules/config');
const daemonLogger = new Logger('credential-daemon');

// Resolve project root — handles running from dist/ (compiled) vs source
const { PATHS } = require('./modules/paths');
const { sleep } = require('./modules/order/utils/system');
const { classifyBroadcastFailure } = require('./modules/broadcast_failure');

// Unix sockets are required; only Unix-like systems are supported

const RUNTIME_DIR = getCredentialRuntimeDir();
const SOCKET_PATH = getCredentialSocketPath({ runtimeDir: RUNTIME_DIR });
const READY_FILE = getCredentialReadyFilePath({ runtimeDir: RUNTIME_DIR });

let vaultSecret: Record<string, unknown> | Buffer | null = null;
let sessionSecret: Record<string, unknown> | Buffer | null = null;
let sessionAccountKeys: Map<string, unknown> = new Map();
let server: Server | null = null;
let daemonShuttingDown = false;

// Policy layer and session management
let policyConfig: PolicyConfigShape | null = null;
let activeSessions: Map<string, { accountName: string; createdAt: number }> = new Map();
let auditLogPath: string | null = null;
let auditLogQueue: Array<() => Promise<void>> = [];
let auditLogDraining = false;
// Policy-file watcher (cleared on shutdown so we don't leak the inotify FD
// or fire a debounced reload after secrets have been zeroed).
let policyWatcher: import('fs').FSWatcher | null = null;
let policyWatchDebounce: ReturnType<typeof setTimeout> | null = null;
let sessionPurgeInterval: ReturnType<typeof setInterval> | null = null;
let nodeRefreshIntervalTimer: ReturnType<typeof setInterval> | null = null;
let auditPruneIntervalTimer: ReturnType<typeof setInterval> | null = null;
// Signing client cache: key = `${accountName}:${keyFingerprint(wif)}`, value = full signing client + createdAt.
// Key rotation: loadDaemonPrivateKey re-reads from vault on every call. If the WIF changes the
// fingerprint changes → cache miss → new signing client created with the current key. No staleness.
// Cleared on transport reconnect (see broadcastWithDeadline). TTL-pruned (30 min) in pruneStaleSigningClients.
const signingClientCache = new Map<string, SigningClientEntry>();

function debugLog(message: string, err: unknown = null): void {
    const suffix = err && getErrorMessage(err) ? `: ${getErrorMessage(err)}` : '';
    daemonLogger.error(`[credential-daemon][debug] ${message}${suffix}`);
}

function formatFatalReason(reason: unknown): string {
    if (!reason) return 'unknown';
    if (reason instanceof Error) return reason.stack || reason.message;
    if (typeof reason === 'object') {
        try {
            return JSON.stringify(reason);
        } catch (_) {
            return String(reason);
        }
    }
    return String(reason);
}

function registerProcessDiagnostics() {
    process.on('uncaughtException', (err: unknown) => {
        daemonLogger.error(`[credential-daemon] Uncaught exception: ${formatFatalReason(err)}`);
        shutdown(1, 'uncaughtException');
    });

    process.on('unhandledRejection', (reason: unknown) => {
        daemonLogger.error(`[credential-daemon] Unhandled rejection: ${formatFatalReason(reason)}`);
        shutdown(1, 'unhandledRejection');
    });

    process.on('exit', (code: number) => {
        daemonLogger.log?.(`[credential-daemon] Process exiting with code ${code}`);
    });
}

/**
 * Policy and session management helpers
 */

function generateSessionId() {
    return randomBytes(16).toString('hex');
}

function purgeExpiredSessions() {
    const ttl = (policyConfig && policyConfig.sessionTtlMs) || 86400000;
    const now = Date.now();
    for (const [id, session] of activeSessions) {
        if (now - session.createdAt > ttl) {
            activeSessions.delete(id);
        }
    }
}

function keyFingerprint(key: string): string {
    // Returns a stable-but-unique 16-hex-char fingerprint of the WIF.
    // HMAC-SHA256 is timing-side-channel-resistant in the HMAC itself, but
    // .slice(0,16) and the string comparison in the cache lookup are not
    // constant-time.  This is acceptable because the cache lives in-process
    // and the WIF is already in cleartext memory — this is not a security
    // boundary, only a cache-consistency check for key rotation detection.
    return createHmac('sha256', 'cred-daemon-key-fingerprint')
        .update(key)
        .digest('hex')
        .slice(0, 16);
}

function pruneStaleSigningClients() {
    const TTL_MS = 30 * 60 * 1000;
    const now = Date.now();
    for (const [cacheKey, entry] of signingClientCache) {
        if (now - entry.createdAt > TTL_MS) {
            if (typeof entry.signingClient.dispose === 'function') {
                try { entry.signingClient.dispose(); } catch (_) {}
            }
            signingClientCache.delete(cacheKey);
        }
    }
}

function checkSessionValid(accountName: string, sessionId: string | null | undefined): boolean {
    // purgeExpiredSessions removed: handled by the 5-min interval timer in initialize()
    if (!sessionId) {
        return false;
    }
    const session = activeSessions.get(sessionId);
    return Boolean(session && session.accountName === accountName);
}

function drainAuditLogQueue() {
    while (auditLogQueue.length > 0) {
        const task = auditLogQueue.shift();
        if (task) {
            try {
                task().catch((err) => debugLog('Audit log operation failed', err));
            } catch (err) {
                debugLog('Audit log operation failed', err);
            }
        }
    }
    auditLogDraining = false;
}

function queueAuditLogWork(work: () => Promise<void>) {
    auditLogQueue.push(work);
    if (!auditLogDraining) {
        auditLogDraining = true;
        process.nextTick(drainAuditLogQueue);
    }
}

function performAuditLogPrune() {
    return new Promise<void>((resolve) => {
        if (!auditLogPath) {
            resolve();
            return;
        }

        try {
            const stat = storage.stat(auditLogPath);
            const perFileLimit = Math.floor(TIMING.AUDIT_LOG_MAX_SIZE / (TIMING.AUDIT_LOG_MAX_FILES + 1));
            if (stat.size >= perFileLimit) {
                for (let i = TIMING.AUDIT_LOG_MAX_FILES - 1; i >= 1; i--) {
                    const oldPath = auditLogPath + '.' + i;
                    const newPath = auditLogPath + '.' + (i + 1);
                    try { if (storage.exists(oldPath)) storage.rename(oldPath, newPath); } catch (err) { debugLog('Audit log rotation rename failed', err); }
                }
                try { if (storage.exists(auditLogPath)) storage.rename(auditLogPath, auditLogPath + '.1'); } catch (err) { debugLog('Audit log rotation rename failed', err); }
                resolve();
                return;
            }
        } catch (err) {
            debugLog('Audit log size check failed', err);
        }
        resolve();
    });
}

function pruneAuditLog() {
    return queueAuditLogWork(() => performAuditLogPrune());
}

function appendAuditLog(entry: Record<string, unknown>): void | Promise<void> {
    if (!auditLogPath) return;
    const line = JSON.stringify(entry) + '\n';
    return queueAuditLogWork(() => new Promise<void>((resolve) => {
        fs.appendFile(auditLogPath, line, (err: Error | null) => {
            if (err) {
                debugLog('Audit log write failed', err);
            }
            resolve();
        });
    }));
}

async function resolveVaultSecret() {
    // NOTE: The DAEMON_PASSWORD env-var path was removed.  No launcher in this
    // codebase ever sets it, and /proc/<pid>/environ retains deleted env values
    // in cleartext for the lifetime of the process — making it a high-value
    // extraction target for any local same-uid process.  All callers should use
    // the one-shot bootstrap socket (DEXBOT_CRED_BOOTSTRAP_PATH_FILE) instead.

    // Try the bootstrap path file first (stable path, no PM2 env leak).
    // The launcher writes the one-shot bootstrap socket path to this file
    // before starting the daemon.  We read it, connect, get the secret,
    // and delete the file.  Future restarts will not find the file and
    // will fall through to interactive auth.
    const bootstrapPathFile = Config.DEXBOT_CRED_BOOTSTRAP_PATH_FILE;
    if (bootstrapPathFile) {
        try {
            const bootstrapSocket = storage.readFile(bootstrapPathFile, 'utf-8').trim();
            if (bootstrapSocket) {
                // Uses delete on process.env directly (not Config) intentionally:
                // security cleanup — scrubs the one-shot path from the env block
                // so /proc/self/environ doesn't leak it to child processes.
                delete process.env.DEXBOT_CRED_BOOTSTRAP_PATH_FILE;
                safeUnlink(bootstrapPathFile)
                daemonLogger.log?.(`[credential-daemon] Resolving vault secret from bootstrap path file: ${bootstrapSocket}`);
                const secret = await fetchBootstrapPassword({ socketPath: bootstrapSocket, retries: 2 });
                daemonLogger.log?.('[credential-daemon] Bootstrap secret transfer completed');
                return normalizeBootstrapCredential(secret);
            }
        } catch (err) {
            // Bootstrap path file was consumed on a previous run (or never
            // written).  This is normal for a PM2 restart/resurrect — the
            // daemon is locked and needs re-authentication.
            safeUnlink(bootstrapPathFile)
            if (!process.stdin || !process.stdin.isTTY) {
                daemonLogger.log?.(
                    '[credential-daemon] Credential daemon is locked — no bootstrap path file and no TTY. ' +
                    'Run \'dexbot pm2\' to unlock.'
                );
                // delete on process.env directly (not Config) — see note above
                delete process.env.DEXBOT_CRED_BOOTSTRAP_PATH_FILE;
                process.exit(0);
            }
            daemonLogger.log?.(
                `[credential-daemon] Bootstrap path file not available (${getErrorMessage(err)}), falling back to interactive auth.`
            );
        }
        // delete on process.env directly (not Config) — see note above
        delete process.env.DEXBOT_CRED_BOOTSTRAP_PATH_FILE;
    }

    daemonLogger.log?.('[credential-daemon] Resolving vault secret from interactive authentication');
    return chainKeys.authenticate();
}

function removeSecureStaleFile(filePath: string, expectedType: string): void {
    if (!storage.exists(filePath)) {
        return;
    }

    // Intentionally throws rather than silently cleaning up: if the path fails
    // the security check (wrong owner, wrong permissions, or a symlink) we must
    // not remove it — doing so could mask an attack. The caller is expected to
    // surface the error and abort daemon startup.
    assertPrivatePathSecurity(filePath, {
        expectedType,
        requiredMode: 0o600,
    });

    storage.unlink(filePath);
}

async function loadCurrentPrivateKey(accountName: string): Promise<unknown> {
    return loadDaemonPrivateKey(accountName, {
        vaultSecret,
        sessionAccountKeys,
        sessionSecret,
        chainClient: _nativeChainClient,
    });
}

async function executeOperationsWithClient(client: SigningClientLike, operations: unknown): Promise<{ success: boolean; raw: unknown; operation_results: unknown[] }> {
    const ops = (Array.isArray(operations) ? operations.filter(Boolean) : []) as Array<{ op_name?: string; op_data?: unknown }>;
    if (ops.length === 0) {
        return { success: true, operation_results: [], raw: null };
    }

    if (client.initPromise) {
        await client.initPromise;
    }

    if (typeof client.newTx !== 'function') {
        throw new Error('Signing client does not support newTx()');
    }

    const tx = client.newTx();
    for (const op of ops) {
        if (!op || !op.op_name || !op.op_data) {
            throw new Error('Each operation requires op_name and op_data');
        }
        if (typeof tx[op.op_name] !== 'function') {
            throw new Error(`Transaction builder does not support ${op.op_name}`);
        }
        (tx[op.op_name] as (data: unknown) => void)(op.op_data);
    }

    const result = await tx.broadcast();
    const r = result as { operation_results?: unknown[]; trx?: { operation_results?: unknown[] } } | null;
    let operationResults: unknown[] = [];
    if (r && !Array.isArray(r) && Array.isArray(r.operation_results) && r.operation_results.length > 0) {
        operationResults = r.operation_results;
    } else if (r && !Array.isArray(r) && r.trx && Array.isArray(r.trx.operation_results) && r.trx.operation_results.length > 0) {
        operationResults = r.trx.operation_results;
    } else if (Array.isArray(result) && result[0]) {
        const first = result[0] as { trx?: { operation_results?: unknown[] } };
        if (first.trx && Array.isArray(first.trx.operation_results) && first.trx.operation_results.length > 0) {
            operationResults = first.trx.operation_results;
        }
    }

    return {
        success: true,
        raw: result,
        operation_results: operationResults,
    };
}

/**
 * Build a typed BROADCAST_DEADLINE error describing an uncertain broadcast.
 * The bot maps this code to BroadcastUncertainError and runs verify-before-
 * retry (chain read + adoption) instead of re-broadcasting.
 */
function buildUncertainError(accountName: string, startedAt: number, detail: string): UncertainError {
    const err = new Error(`${DAEMON_CODES.BROADCAST_DEADLINE}:${detail}`) as UncertainError;
    err.code = DAEMON_CODES.BROADCAST_DEADLINE;
    err.uncertain = true;
    err.accountName = accountName;
    err.startedAt = startedAt;
    err.ageMs = Date.now() - startedAt;
    return err;
}

/**
 * Serialize daemon broadcasts: the daemon shares ONE _nativeChainClient and
 * signing-client cache across all socket clients, so concurrent
 * broadcastWithDeadline calls would stomp each other's node pinning, connect
 * state, and cache clearing (a pre-existing hazard, widened by per-node
 * pinning). Broadcasts are queued as a promise chain; non-broadcast requests
 * are unaffected.
 *
 * The broadcast deadline guard (createBroadcastGuard) is created by the
 * request handler BEFORE the queue wait, so the deadline timer covers queue
 * wait + broadcast work together: total daemon wall time per request is
 * capped at CREDENTIAL_DAEMON_INNER_DEADLINE_MS, well inside the bot's
 * CREDENTIAL_BROADCAST_TIMEOUT_MS outer socket window. A broadcast that is
 * still queued when the deadline fires aborts via guard.isFired() before it
 * starts, and a client socket that dies (bot outer timeout destroys its end,
 * crash, restart) fires the guard too — so a broadcast can never land on
 * chain AFTER the bot already verified chain absence and re-broadcast the
 * same operation.
 */
let broadcastChain: Promise<unknown> = Promise.resolve();
function serializeBroadcast<T>(fn: () => Promise<T>, getWork?: () => Promise<unknown>): Promise<T> {
    const run = broadcastChain.then(fn, fn);
    // The chain must wait for the WORK to settle, not the deadline-raced
    // result: a deadline-aborted broadcast keeps running in the background
    // (the guard only aborts it at its next checkpoint), and starting the
    // next queued broadcast while that zombie still touches the shared
    // _nativeChainClient would stomp its node pinning / transport state.
    // getWork() is consulted AFTER run settles, when the zombie (if any) is
    // known; the transport disconnect + guard checkpoints terminate it fast,
    // so the queue wait stays well inside the next request's inner deadline.
    broadcastChain = Promise.resolve(getWork ? run.then(() => getWork(), () => getWork()) : run)
        .then(() => undefined, () => undefined);
    return run;
}

/**
 * Broadcast deadline guard shared between the queue wait and the broadcast
 * work. The timer starts at request receipt — before the serializeBroadcast
 * queue wait — so queued broadcasts cannot outlive the bot's outer socket
 * window. Firing the guard (deadline exceeded, or the requesting socket
 * died) aborts the queued/in-flight broadcast: the work checks isFired()
 * before every attempt, so a late broadcast can never land after the bot
 * already verified chain absence and re-broadcast the operation.
 */
function createBroadcastGuard(accountName: string, startedAt: number, deadlineMs: number): BroadcastGuard {
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectGuard: (reason?: unknown) => void = () => {};
    const promise = new Promise<unknown>((_, reject) => {
        rejectGuard = reject;
        timer = setTimeout(() => {
            fired = true;
            reject(buildUncertainError(accountName, startedAt, `inner broadcast deadline ${deadlineMs}ms exceeded`));
        }, deadlineMs);
    });
    // The guard promise is raced only once the serialized broadcast starts;
    // while the request sits in the queue a deadline rejection would
    // otherwise surface as an unhandled rejection.
    promise.catch(() => {});
    return {
        isFired: () => fired,
        promise,
        // The candidate in play when the guard fires, set by the broadcast
        // work loop (null until a candidate is attempted, or for a queued
        // deadline that never started). The request handler echoes it in the
        // BROADCAST_DEADLINE reply so the bot blames the node that actually
        // caused the outcome — never its original preference blindly.
        currentNode: null as string | null,
        fire: (reason: string) => {
            if (fired) return;
            fired = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            rejectGuard(buildUncertainError(accountName, startedAt, reason));
        },
        clearTimer: () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }
    };
}

function resolveInnerDeadlineMs() {
    return Number.isFinite(Number(TIMING?.CREDENTIAL_DAEMON_INNER_DEADLINE_MS))
        ? Number(TIMING.CREDENTIAL_DAEMON_INNER_DEADLINE_MS)
        : 20000;
}

async function broadcastWithDeadline(accountName: string, privateKey: unknown, broadcastFn: (client: SigningClientLike) => Promise<unknown>, nodeUrl: string | null = null, opts: BroadcastOptions = {}): Promise<unknown> {
    // Deadline-capped broadcast: each node gets CREDENTIAL_DAEMON_BROADCAST_RETRIES
    // attempts pinned to it (the transport sweeps ONLY the pinned node), and
    // only when they ALL fail with failures that provably never reached the
    // chain (pre-transmit: connection setup, WebSocket not open, frame send
    // errors) does the daemon report the node failure to the node health
    // ledger and rotate to the next best node from the health cache. An
    // uncertain failure — RPC timeout, or the connection dropped while a
    // response was pending — may have landed, and re-signing it would
    // duplicate the transaction on chain (each re-signing produces a new
    // transaction ID), so it is NEVER retried on any node: it is reported as
    // BROADCAST_DEADLINE so the bot layer verifies chain inclusion before any
    // re-broadcast (executeWithRetryOnUncertain, startup adoption). The inner
    // deadline caps the TOTAL wall time across all attempts — pre-transmit
    // failures are fast (no RPC wait), so retries never hang the bot — and
    // guarantees we
    // reply well before the bot's outer socket timer
    // (CREDENTIAL_BROADCAST_TIMEOUT_MS) fires. If we don't reply in time, the
    // bot raises BroadcastUncertainError and enters the recovery path.
    // See: modules/dexbot_credential_client.ts BroadcastUncertainError.
    const innerDeadlineMs = resolveInnerDeadlineMs();
    const maxRetries = Number.isFinite(Number(TIMING?.CREDENTIAL_DAEMON_BROADCAST_RETRIES))
        ? Number(TIMING.CREDENTIAL_DAEMON_BROADCAST_RETRIES)
        : 3;
    const retryBackoffMs = Number.isFinite(Number(TIMING?.CREDENTIAL_DAEMON_BROADCAST_BACKOFF_MS))
        ? Number(TIMING.CREDENTIAL_DAEMON_BROADCAST_BACKOFF_MS)
        : 1000;
    const startedAt = opts.startedAt ?? Date.now();
    // The guard covers the queue wait too when the request handler creates
    // it before serializeBroadcast (deadline timer started at request
    // receipt); without one it starts here and covers only the broadcast
    // work. isFired() lets the retry loop abort before any late background
    // broadcast, and the finally block resets the transport even while the
    // broadcast is still in flight.
    const guard = opts.guard ?? createBroadcastGuard(accountName, startedAt, innerDeadlineMs);
    const deadlinePromise = guard.promise;

    const work = (async () => {
        // Pin ALL attempts to ONE node at a time: up to `attemptsPerNode`
        // attempts on the best candidate, and only when those all fail with
        // provably-untransmitted errors do we report the node failure and
        // rotate to the next best node.
        const attemptsPerNode = Math.max(1, maxRetries);
        let lastErr: unknown = null;
        const exhaustedNodes: string[] = [];

        // Build the ordered candidate list: the bot-supplied nodeUrl is the
        // PREFERRED node (attempted first), followed by the healthy node set
        // ordered best-first by the shared health cache. Re-reads the cache
        // so bot-side blacklists are reflected immediately; daemon-side
        // blacklists (daemonNodeHealth) are excluded until their cooldown
        // expires.
        const buildCandidates = (): string[] => {
            refreshNodeList();
            const baseList = _nativeNodeList.length > 0 ? _nativeNodeList : NODE_MANAGEMENT.DEFAULT_NODES;
            const list = nodeUrl ? [nodeUrl, ...baseList.filter((n: string) => n !== nodeUrl)] : [...baseList];
            return list.filter((n: string) => !exhaustedNodes.includes(n) && !daemonNodeHealth.isBlacklisted(n));
        };

        // Candidate pool: healthy nodes best-first. When every available node
        // is daemon-blacklisted (or the health cache is empty/absent), fall
        // back to the configured defaults as a LAST RESORT — rebuilt the same
        // way on every rotation, so each rotation still gets its next
        // best-effort node: failing the broadcast outright would stall the
        // order until the bot's next cycle, and a stale blacklist (node
        // recovered inside its cooldown window) would otherwise go unused.
        // Ordering: never-failed/recovered nodes first, then blacklisted ones
        // cooldown-soonest-first.
        let lastResortWarned = false;
        const buildCandidatePool = (): string[] => {
            const pool = buildCandidates();
            if (pool.length > 0) return pool;
            const state = daemonNodeHealth.getState();
            const fallback = NODE_MANAGEMENT.DEFAULT_NODES
                .filter((n: string) => !exhaustedNodes.includes(n))
                .sort((a: string, b: string) =>
                    (state.get(a)?.blacklistedUntil ?? -Infinity) - (state.get(b)?.blacklistedUntil ?? -Infinity)
                );
            if (fallback.length > 0 && !lastResortWarned) {
                lastResortWarned = true;
                daemonLogger.warn?.(
                    `[credential-daemon] All healthy candidates blacklisted; falling back to last-resort node(s) (never-failed first, then cooldown-soonest)`
                );
            }
            return fallback;
        };

        // candidates[0] is always the next fresh node: every rotation pushes
        // the exhausted node onto the ledger and rebuilds the pool, so the
        // pool shrinks until it is empty.
        let candidates = buildCandidatePool();

        // The candidate in play when the deadline fires, exposed to the
        // request handler (via the guard) so the BROADCAST_DEADLINE reply can
        // name the node that actually caused it — never the bot's original
        // preference, which may be innocent after daemon-side rotation.
        if (opts.guard) opts.guard.currentNode = null;

        while (candidates.length > 0) {
            const candidate = candidates[0];
            if (opts.guard) opts.guard.currentNode = candidate;
            for (let attempt = 1; attempt <= attemptsPerNode; attempt++) {
                // Abort as soon as the guard fired (inner deadline won the
                // race, or the requesting socket died): the bot has been told
                // the outcome is uncertain and may verify + re-create — a
                // late background broadcast would duplicate the order.
                if (guard.isFired()) {
                    throw buildUncertainError(accountName, startedAt, 'inner broadcast deadline exceeded');
                }
                if (attempt > 1) {
                    await sleep(retryBackoffMs);
                    if (guard.isFired()) {
                        throw buildUncertainError(accountName, startedAt, 'inner broadcast deadline exceeded');
                    }
                }

                let phase: 'connect' | 'broadcast' = 'connect';
                try {
                    const currentNode = _nativeChainClient.transport?.getNodeUrl?.();
                    if (_nativeChainClient.getStatus() !== 'connected' || currentNode !== candidate) {
                        phase = 'connect';
                        // Pin the attempt to the current candidate: the transport
                        // sweeps ONLY the pinned node, so all attempts genuinely
                        // use the SAME node before any rotation.
                        _nativeChainClient.setNodes([candidate]);
                        await _nativeChainClient.connect();
                        // The guard may have fired while the connect handshake was
                        // in flight (slow node + inner deadline). Abort here —
                        // before any signing-client work — so the sign+broadcast
                        // never happens after the bot was told BROADCAST_DEADLINE:
                        // a late background broadcast would duplicate the order.
                        if (guard.isFired()) {
                            throw buildUncertainError(accountName, startedAt, 'inner broadcast deadline exceeded during connect');
                        }
                        // Transport reconnected — dispose all stale signing clients (heap-dump safety)
                        // then clear the cache so new clients use the fresh transport.
                        for (const [, entry] of signingClientCache) {
                            if (typeof entry.signingClient.dispose === 'function') {
                                try { entry.signingClient.dispose(); } catch (_) {}
                            }
                        }
                        signingClientCache.clear();
                    }
                    const fp = keyFingerprint(String(privateKey));
                    const cacheKey = accountName + ':' + fp;
                    let cached = signingClientCache.get(cacheKey);
                    if (!cached) {
                        // Proactively evict stale entries for the same account (different fingerprint)
                        // so key rotation never leaves dead entries in the map.
                        const stalePrefix = accountName + ':';
                        for (const [k, v] of signingClientCache) {
                            if (k !== cacheKey && k.startsWith(stalePrefix)) {
                                if (typeof v.signingClient.dispose === 'function') {
                                    try { v.signingClient.dispose(); } catch (_) {}
                                }
                                signingClientCache.delete(k);
                            }
                        }
                        pruneStaleSigningClients();
                        // Pre-convert WIF string → Buffer so dispose() can actually zero the bytes.
                        // The WIF string goes out of scope at function return and is GC'd (non-deterministic),
                        // but the Buffer passed to createSigningClient is filled with 0 by dispose() on eviction/shutdown.
                        const { createSigningClient, wifToBuffer } = require('./modules/bitshares-native');
                        const keyBuffer = wifToBuffer(String(privateKey));
                        const signingClient = createSigningClient(_nativeChainClient, accountName, keyBuffer);
                        cached = { signingClient, createdAt: Date.now() };
                        signingClientCache.set(cacheKey, cached);
                    }
                    const client = cached.signingClient.client;
                    await client.initPromise;
                    // The guard may have fired while the signing client fetched
                    // account/order metadata. Abort before the broadcast RPC so
                    // nothing is transmitted post-deadline — a zombie broadcast
                    // landing after the bot verified chain absence would duplicate
                    // the operation.
                    if (guard.isFired()) {
                        throw buildUncertainError(accountName, startedAt, 'inner broadcast deadline exceeded during signing client init');
                    }
                    phase = 'broadcast';
                    const result = await broadcastFn(client);
                    // Success — restore the full node list so other users of
                    // the shared client don't inherit the single-node pin.
                    _nativeChainClient.setNodes(_nativeNodeList.length > 0 ? _nativeNodeList : NODE_MANAGEMENT.DEFAULT_NODES);
                    return result;
                } catch (err) {
                    // Guard-fired aborts (deadline during connect/init) must
                    // propagate as uncertain immediately — they are never
                    // retryable, even during the connect phase, and a retry
                    // would just re-enter the same deadlined attempt.
                    if (getErrorCode(err) === DAEMON_CODES.BROADCAST_DEADLINE || getErrorField<boolean>(err, 'uncertain') === true) {
                        throw err;
                    }
                    // Connect-phase failures are always pre-transmit: no broadcast
                    // has been attempted yet. Broadcast-phase failures are only
                    // retryable when the RPC frame provably never reached the wire.
                    const cls = phase === 'connect' ? 'retryable' : classifyBroadcastFailure(err);
                    if (cls === 'retryable') {
                        lastErr = err;
                        const retryLabel = attempt < attemptsPerNode ? 'retrying same node' : 'exhausted; rotating to next best node';
                        debugLog(`Broadcast attempt ${attempt}/${attemptsPerNode} on ${candidate} failed pre-transmit (${getErrorMessage(err)}); ${retryLabel}`);
                        // Reset the transport so the next attempt reconnects
                        // cleanly against the pinned node.
                        try { _nativeChainClient.disconnect(); } catch (_) {}
                        continue;
                    }
                    if (cls === 'uncertain') {
                        // The transaction may have landed — never re-sign on ANY
                        // node. Report the typed uncertain reply so the bot's
                        // verify-before-retry machinery checks chain inclusion
                        // before any re-create.
                        throw buildUncertainError(accountName, startedAt, getErrorMessage(err));
                    }
                    // 'definite': the chain rejected the transaction or it could
                    // not be built — nothing landed; the error propagates as-is.
                    throw err;
                }
            }
            // All attempts on this candidate failed pre-transmit: nothing ever
            // reached the chain via this node. Report the failure so the node
            // health ledger counts it toward blacklisting, then rotate to the
            // next best node (re-reading the health cache first).
            exhaustedNodes.push(candidate);
            daemonNodeHealth.reportFailure(candidate, getErrorMessage(lastErr) || 'pre-transmit broadcast failure');
            candidates = buildCandidatePool();
        }
        // All candidates failed pre-transmit (or none were usable): nothing
        // ever reached the chain.
        if (!lastErr) {
            lastErr = new Error('Broadcast not attempted: no usable node candidates (all blacklisted or unavailable)');
        }
        throw lastErr;
    })();

    // Expose the WORK promise (not the deadline-raced result) to the broadcast
    // queue: serializeBroadcast chains the next queued broadcast on it, so a
    // deadline-aborted zombie cannot overlap the next broadcast on the shared
    // transport. The handler reads it back via opts.workRef.
    if (opts.workRef && typeof opts.workRef === 'object') {
        opts.workRef.work = work;
    }

    try {
        return await Promise.race([work, deadlinePromise]);
    } finally {
        guard.clearTimer();
        if (guard.isFired()) {
            // The guard won while the broadcast may still be in flight —
            // drop the connection so the next request starts clean. The
            // transport abort also kills any in-flight connect handshake, so
            // the zombie cannot resurrect a connection afterwards.
            try { _nativeChainClient.disconnect(); } catch (_) {}
        }
        // Prune stale signing clients on every broadcast, not just on cache
        // miss, so long-running daemons don't accumulate stale entries when
        // accounts always hit the cache (same WIF, no rotation).
        pruneStaleSigningClients();
    }
}

/**
 * Refresh the BitShares node list from the health cache.
 * Ensures the daemon isn't stuck on stale nodes if they fail during long uptime.
 */
function refreshNodeList() {
    const settings = readGeneralSettings({ fallback: null });
    const nodeSettings = settings?.NODES;
    const nodeManagerEnabled = nodeSettings?.enabled ?? NODE_MANAGEMENT.DEFAULT_ENABLED;

    if (nodeManagerEnabled) {
        try {
            const bestNodes = orderNodesForSettings(settings);
            if (bestNodes && bestNodes.length > 0) {
                // Never evict the node this daemon is currently connected to.
                // setNodes() replaces the transport candidate list, and
                // transport.connect() only keeps its socket when that list
                // still contains the active node — so a refresh built from the
                // health cache (which omits nodes that are momentarily
                // unhealthy) used to force a full teardown on the next
                // broadcast. Appending it as the last candidate is enough.
                const activeNode = _nativeChainClient.transport?.getNodeUrl?.();
                const nodes = activeNode && !bestNodes.includes(activeNode)
                    ? [...bestNodes, activeNode]
                    : bestNodes;
                _nativeNodeList = nodes;
                _nativeChainClient.setNodes(nodes);
                daemonLogger.log?.(`[credential-daemon] Node list refreshed: using best ${bestNodes.length} nodes from cache.`);
            }
        } catch (err) {
            daemonLogger.warn?.(`[credential-daemon] Failed to refresh node list: ${getErrorMessage(err)}`);
        }
    }
}

/**
 * Daemon-local node health ledger: blacklists persistently failing nodes so
 * the broadcast path rotates away from them and the shared health cache is
 * updated when a node hits the failure threshold. See
 * modules/daemon_node_health.ts for semantics.
 */
const { createNodeHealthLedger } = require('./modules/daemon_node_health');
const daemonNodeHealth = createNodeHealthLedger({ logger: daemonLogger });

function getCredentialDaemonNodeRefreshIntervalMs(settings: unknown): number {
    const s = settings as { NODES?: { credentialDaemonRefreshIntervalMs?: number; CREDENTIAL_DAEMON_NODE_REFRESH_INTERVAL_MS?: number } } | null | undefined;
    const configured = s?.NODES?.credentialDaemonRefreshIntervalMs
        ?? s?.NODES?.CREDENTIAL_DAEMON_NODE_REFRESH_INTERVAL_MS
        ?? NODE_MANAGEMENT.CREDENTIAL_DAEMON_NODE_REFRESH_INTERVAL_MS;
    return Number.isFinite(configured) && configured > 0
        ? configured
        : NODE_MANAGEMENT.CREDENTIAL_DAEMON_NODE_REFRESH_INTERVAL_MS;
}

/**
 * Initialize daemon: authenticate and start listening
 */
async function initialize() {
    try {
        // Check that the key vault exists at the resolved profiles dir
        const keysPath = PATHS.PROFILES.KEYS_JSON();
        if (!storage.exists(keysPath)) {
            throw new Error(`Key vault not found at ${keysPath}. Please run: dexbot key`);
        }

        // Accept a one-shot bootstrap secret when launched by a wrapper,
        // otherwise prompt once interactively.
        vaultSecret = await resolveVaultSecret();
        const accountsData = chainKeys.loadAccounts();
        const sessionState = buildSessionAccountCache(accountsData, vaultSecret, {
            onDecryptError: (accountName: string, err: unknown) => {
                debugLog(`Skipping account '${accountName}' — decryption failed: ${getErrorMessage(err)}`);
            },
        });
        sessionAccountKeys = sessionState.cache;
        sessionSecret = sessionState.sessionSecret;
        if (accountsData && typeof accountsData === 'object') {
            accountsData.accounts = null;
        }

        // Load policy config — auto-remediate legacy 0o644 permissions first
        const policyConfigPath = PATHS.PROFILES.DAEMON_POLICIES_JSON;
        credentialPolicy.checkPolicyFileSecurity(policyConfigPath);
        policyConfig = credentialPolicy.loadRequiredPolicyConfig(policyConfigPath);

        // Set audit log path
        const auditLogDir = PATHS.LOGS_DIR;
        if (!storage.exists(auditLogDir)) {
            try {
                ensureDir(auditLogDir, { mode: 0o700 });
            } catch (err) {
                debugLog(`Failed to create audit log directory ${auditLogDir}: ${getErrorMessage(err)}`);
            }
        }
        auditLogPath = path.join(auditLogDir, 'daemon-audit.jsonl');

        // Apply configured node list so the daemon uses the same
        // nodes as bot processes (when node management is enabled),
        // without instantiating NodeManager (which was crashing the
        // daemon ~80s after startup).  Mirror the enabled check from
        // bitshares_client.ts so both stay aligned.
        const settings = readGeneralSettings({ fallback: null });
        refreshNodeList();

        // Fire-and-forget connect so the asset resolver works on first request
        _nativeChainClient.setNodes(_nativeNodeList.length > 0 ? _nativeNodeList : NODE_MANAGEMENT.DEFAULT_NODES);
        _nativeChainClient.connect().catch(() => {});

        // Lightweight node list refresh from the health cache. This is separate
        // from updater schedules and does not run active node probes.
        nodeRefreshIntervalTimer = setInterval(refreshNodeList, getCredentialDaemonNodeRefreshIntervalMs(settings));
        if (typeof nodeRefreshIntervalTimer.unref === 'function') {
            nodeRefreshIntervalTimer.unref();
        }

        // Periodic purge of expired sessions (every 5 min) to prevent stale
        // session accumulation when bots probe but don't broadcast.
        const SESSION_PURGE_INTERVAL_MS = 5 * 60 * 1000;
        sessionPurgeInterval = setInterval(purgeExpiredSessions, SESSION_PURGE_INTERVAL_MS);
        if (typeof sessionPurgeInterval.unref === 'function') {
            sessionPurgeInterval.unref();
        }

        // Audit log prune on a timer (M5): replaces inline pruning on every
        // append, which caused read+rewrite of the entire file on each signed
        // operation.  Hourly prune is sufficient for the 7-day retention window.
        const AUDIT_LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
        auditPruneIntervalTimer = setInterval(() => { pruneAuditLog(); }, AUDIT_LOG_PRUNE_INTERVAL_MS);
        if (typeof auditPruneIntervalTimer.unref === 'function') {
            auditPruneIntervalTimer.unref();
        }

        // Register SIGHUP handler for policy and node list reload.
        // PM2 may forward SIGHUP on terminal disconnect, but we treat it
        // as a trigger to refresh configuration.
        process.on('SIGHUP', () => {
            daemonLogger.log?.('[credential-daemon] SIGHUP received: refreshing configuration and node list...');

            // Strict reload: fail closed if the operator just wrote an
            // invalid policy.  The try/catch wraps shutdown() so a
            // successful reload falls through to refreshNodeList().
            try {
                policyConfig = credentialPolicy.reloadPolicyFromDisk(policyConfigPath, { strict: true });
                debugLog('Policy config reloaded');
            } catch (err) {
                daemonLogger.error?.(`[credential-daemon] SIGHUP policy reload failed: ${getErrorMessage(err)}`);
                shutdown(1, 'invalid policy reload');
                return;
            }

            // Reload node list
            refreshNodeList();
        });

        // Watch policy config file for external changes (e.g. auto-provision
        // of botHmacSecret by a bot process).  fs.watch fires multiple events
        // per atomic rename, so debounce with a 500ms settle window.
        // This is the safety net that makes C2 fixes work end-to-end: the bot
        // writes a new secret, sends SIGHUP, and even if SIGHUP is lost or
        // delayed, the daemon picks up the change within 500ms.
        try {
            policyWatcher = fs.watch(policyConfigPath, { persistent: false }, (eventType: string) => {
                if (policyWatchDebounce) clearTimeout(policyWatchDebounce);
                policyWatchDebounce = setTimeout(() => {
                    policyWatchDebounce = null;
                    const newConfig = credentialPolicy.reloadPolicyFromDisk(policyConfigPath);
                    if (newConfig) {
                        policyConfig = newConfig;
                        debugLog(`Policy config reloaded via fs.watch (${eventType})`);
                    }
                    // On non-strict failure, reloadPolicyFromDisk already logs
                    // a warn; the existing in-memory config is kept.  This is
                    // intentionally distinct from SIGHUP's fail-closed policy.
                }, 500);
            });
        } catch (watchErr) {
            // fs.watch can fail on exotic filesystems (network FS, FUSE).
            // Log at WARN (not debug): without the watch AND without a
            // successful SIGHUP from the bot, the daemon keeps the stale
            // botHmacSecret until restart.  Operators need to see this.
            daemonLogger.warn?.(`[credential-daemon] Could not watch policy config file ${policyConfigPath}: ${getErrorMessage(watchErr)}. SIGHUP from bot process is now the only reload path.`);
        }

        ensureCredentialRuntimeDirSync({ runtimeDir: RUNTIME_DIR });
        daemonLogger.log?.(`[credential-daemon] Runtime socket path: ${SOCKET_PATH}`);
        daemonLogger.log?.(`[credential-daemon] Ready file path: ${READY_FILE}`);

        // Clean up old socket if it exists
        try {
            removeSecureStaleFile(SOCKET_PATH, 'socket');
            removeSecureStaleFile(READY_FILE, 'file');
        } catch (err) {
            throw new Error(`Insecure credential runtime path detected: ${getErrorMessage(err)}`);
        }

        // Create server
        const srv = net.createServer(handleConnection) as Server;
        server = srv;
        srv.listen(SOCKET_PATH, () => {
            try {
                storage.chmod(SOCKET_PATH, 0o600);
                assertPrivatePathSecurity(SOCKET_PATH, { expectedType: 'socket', requiredMode: 0o600 });
            } catch (err) {
                daemonLogger.error?.(`[credential-daemon] FATAL: Insecure socket permissions on ${SOCKET_PATH}: ${getErrorMessage(err)}`);
                shutdown(1, 'insecure socket permissions');
                return;
            }
            // Create ready file to signal startup completion.
            // Open with explicit 0o600 mode to avoid the TOCTOU window between
            // writeFileSync and chmodSync (the file is never world-readable).
            // Write JSON with pid so callers can send SIGHUP to trigger policy reload.
            try {
                const readyPayload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
                storage.writeFile(READY_FILE, readyPayload, { mode: 0o600 });
                assertPrivatePathSecurity(READY_FILE, { expectedType: 'file', requiredMode: 0o600 });
                daemonLogger.log?.(`[credential-daemon] Ready: listening on ${SOCKET_PATH}`);
            } catch (err) {
                daemonLogger.error?.(`[credential-daemon] FATAL: Insecure ready-file permissions on ${READY_FILE}: ${getErrorMessage(err)}`);
                shutdown(1, 'insecure ready-file permissions');
                return;
            }
        });

        srv.on('error', (error: Error) => {
            daemonLogger.error(`Server error: ${getErrorMessage(error)}`);
            process.exit(1);
        });

        // Handle graceful shutdown.
        // SIGTERM is sent by PM2 when stopping the daemon — honour it.
        // SIGINT is from stray Ctrl-C in the parent terminal; under PM2
        // management we ignore it so the daemon stays alive.  When running
        // interactively (not via PM2), SIGINT still works because the
        // process group leader is the shell.
        process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
        process.on('SIGINT', () => {
            daemonLogger.log?.(
                '[credential-daemon] SIGINT ignored (daemon is managed by PM2; use `pm2 stop dexbot-cred` to shut down).'
            );
        });

    } catch (error) {
        daemonLogger.error(`[credential-daemon] Startup failed: ${getErrorField<string>(error, 'stack') || getErrorMessage(error)}`);
        shutdown(1, 'startup failure');
    }
}

/**
 * Handle incoming client connection to daemon.
 * Reads newline-delimited JSON requests and processes credential requests.
 * 
 * @param {net.Socket} socket - Connected client socket
 */
function handleConnection(socket: Socket): void {
    let buffer = '';
    // Broadcast deadline guards for requests on this socket. Fired when the
    // socket dies (bot outer timeout destroys its end, crash, restart): the
    // queued/in-flight broadcast for a client that can no longer receive the
    // reply must abort — otherwise it can land on chain after the bot
    // verified chain absence and re-broadcast the same operation.
    const activeGuards = new Set<BroadcastGuard>();

    const abortSocketGuards = () => {
        for (const guard of activeGuards) {
            guard.fire('client socket closed before broadcast reply');
        }
        activeGuards.clear();
    };

    socket.setTimeout(TIMING.CREDENTIAL_DAEMON_SOCKET_TIMEOUT_MS);

    socket.on('timeout', () => {
        daemonLogger.debug?.('[credential-daemon] Socket timeout — client idle');
        abortSocketGuards();
        socket.destroy();
    });

    socket.on('data', (data: Buffer) => {
        try {
            buffer += data.toString();

            if (buffer.length > TIMING.CREDENTIAL_DAEMON_MAX_BUFFER_SIZE) {
                sendError(socket, 'Request too large');
                socket.destroy();
                return;
            }

            // Look for newline-delimited JSON
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.trim()) {
                    processRequest(line.trim(), socket, activeGuards);
                }
            }
        } catch (error) {
            sendError(socket, 'Invalid request');
        }
    });

    socket.on('end', () => {
        abortSocketGuards();
        socket.destroy();
    });

    socket.on('error', (error: Error) => {
        daemonLogger.debug?.('[credential-daemon] Socket error: ' + getErrorMessage(error));
        abortSocketGuards();
        socket.destroy();
    });

    socket.on('close', () => {
        abortSocketGuards();
    });
}

/**
 * Process incoming credential request from client.
 * Validates request format and retrieves private key if valid.
 * Sends success or error response back to client.
 * 
 * @param {string} requestStr - JSON string with {type, accountName}
 * @param {net.Socket} socket - Client socket to send response
 */
function processRequest(requestStr: string, socket: Socket, activeGuards: Set<BroadcastGuard> = new Set()): void {
    if (daemonShuttingDown) return;
    // The outer try/catch handles JSON parse errors and any synchronous throws.
    // Each async branch manages its own errors via .catch() → sendError(), so
    // the outer catch is not expected to fire for async operation failures.
    try {
        const request = JSON.parse(requestStr) as RequestPayload;
        const { type, accountName } = request;

        if (!type) {
            return sendError(socket, 'Missing "type" field');
        }

        if (!accountName) {
            return sendError(socket, 'Missing "accountName" field');
        }

        if (type === 'ping') {
            // Lightweight health check — no session created, no audit log entry.
            // Used by the credential daemon watchdog and pre-write probes where
            // we only need to verify the daemon is alive, not establish a session.
            sendSuccess(socket, { pong: true });
            return;
        }

        if (type === 'probe-account') {
            loadCurrentPrivateKey(accountName)
                .then(() => {
                    // Session registration
                    const sessionId = generateSessionId();
                    activeSessions.set(sessionId, {
                        accountName,
                        createdAt: Date.now(),
                    });
                    appendAuditLog({
                        event: 'session_created',
                        accountName,
                        sessionId,
                        timestamp: new Date().toISOString(),
                    });
                    sendSuccess(socket, { sessionId });
                })
                .catch((error: unknown) => sendError(socket, getErrorMessage(error)));
            return;
        }

        if (type === 'execute-operations') {
            const operations = request.operations;
            if (!Array.isArray(operations)) {
                return sendError(socket, 'Missing "operations" field');
            }

            const sessionId = request.sessionId || null;

            // Session validation
            if (!checkSessionValid(accountName, sessionId)) {
                const reason = DAEMON_ERRORS.SESSION_EXPIRED;
                appendAuditLog({
                    event: 'sign_denied',
                    accountName,
                    sessionId,
                    reason: 'session: ' + reason,
                    timestamp: new Date().toISOString(),
                });
                return sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + reason);
            }

            // Source authentication (HMAC verification)
            const hmacResult = credentialPolicy.verifySourceHmac(request, policyConfig);
            if (!hmacResult.valid) {
                appendAuditLog({
                    event: 'sign_denied',
                    accountName,
                    sessionId,
                    reason: 'source: ' + hmacResult.reason,
                    timestamp: new Date().toISOString(),
                });
                return sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + DAEMON_ERRORS.SOURCE_AUTH_DENIED);
            }

            // Policy evaluation — before any key material is touched
            const policy = credentialPolicy.resolveAccountPolicy(policyConfig, accountName);
            const context = credentialPolicy.buildPolicyContext(request);

            credentialPolicy.evaluatePolicy(policy, context)
                .then(async (result: { allow: boolean; policyId?: string | null; reason?: string | null }) => {
                    if (!result.allow) {
                        appendAuditLog({
                            event: 'sign_denied',
                            accountName,
                            sessionId,
                            policyId: result.policyId,
                            reason: result.reason,
                            opCount: operations.length,
                            opTypes: operations.map((o) => o && o.op_name).filter(Boolean),
                            timestamp: new Date().toISOString(),
                        });
                        sendError(socket, credentialPolicy.POLICY_DENIED_PREFIX + result.reason);
                        return;
                    }

                    const privateKey = await loadCurrentPrivateKey(accountName);
                    const broadcastNodeUrl = typeof request.nodeUrl === 'string' ? request.nodeUrl : null;
                    // Start the broadcast deadline NOW, before the
                    // serializeBroadcast queue wait, so total daemon wall time
                    // per request stays inside the bot's outer socket window.
                    // If the deadline fires while queued (burst concurrency),
                    // the queued broadcast aborts via guard.isFired() before
                    // it starts — it can never land after the bot verified
                    // chain absence and re-broadcast the same operation.
                    const broadcastStartedAt = Date.now();
                    const broadcastGuard = createBroadcastGuard(accountName, broadcastStartedAt, resolveInnerDeadlineMs());
                    activeGuards.add(broadcastGuard);
                    const broadcastWorkRef: { work: Promise<unknown> | null } = { work: null };
                    let signResult: unknown;
                    try {
                        signResult = await serializeBroadcast(
                            () => broadcastWithDeadline(
                                accountName, privateKey,
                                (client: unknown) => executeOperationsWithClient(client as SigningClientLike, operations),
                                broadcastNodeUrl,
                                { guard: broadcastGuard, startedAt: broadcastStartedAt, workRef: broadcastWorkRef }
                            ),
                            () => broadcastWorkRef.work || Promise.resolve()
                        );
                    } catch (broadcastErr) {
                        if (broadcastErr && getErrorCode(broadcastErr) === DAEMON_CODES.BROADCAST_DEADLINE) {
                            const broadcastErrAgeMs = getErrorField<number>(broadcastErr, 'ageMs');
                            const broadcastErrStartedAt = getErrorField<string>(broadcastErr, 'startedAt');
                            appendAuditLog({
                                event: 'sign_timeout',
                                accountName,
                                sessionId,
                                nodeUrl: broadcastGuard.currentNode || broadcastNodeUrl,
                                opCount: operations.length,
                                opTypes: operations.map((o) => o && o.op_name).filter(Boolean),
                                ageMs: broadcastErrAgeMs,
                                startedAt: broadcastErrStartedAt
                                    ? new Date(broadcastErrStartedAt).toISOString()
                                    : null,
                                timestamp: new Date().toISOString(),
                            });
                            return sendError(
                                socket,
                                'chain status uncertain after inner deadline',
                                DAEMON_CODES.BROADCAST_DEADLINE,
                                broadcastGuard.currentNode
                                    ? { nodeUrl: broadcastGuard.currentNode }
                                    : {}
                            );
                        }
                        throw broadcastErr;
                    } finally {
                        activeGuards.delete(broadcastGuard);
                    }

                    appendAuditLog({
                        event: 'sign_allowed',
                        accountName,
                        sessionId,
                        opCount: operations.length,
                        opTypes: operations.map((o) => o && o.op_name).filter(Boolean),
                        timestamp: new Date().toISOString(),
                    });
                    sendSuccess(socket, signResult as Record<string, unknown>);
                })
                .catch((error: unknown) => sendError(socket, getErrorMessage(error)));
            return;
        }

        return sendError(socket, `Unknown credential type: ${type}`);
    } catch (error) {
        sendError(socket, getErrorMessage(error));
    }
}

/**
 * Send successful credential response to client.
 * 
 * @param {net.Socket} socket - Client socket
 * @param {Object} data - Response data
 */
function sendSuccess(socket: Socket, data: Record<string, unknown>): void {
    const response = JSON.stringify({
        success: true,
        ...data
    });
    socket.write(response + '\n');
    socket.end();
}

/**
 * Send error response to client.
 *
 * @param {net.Socket} socket - Client socket
 * @param {string} message - Error message
 * @param {number} code - Error code
 * @param {Object} [extra] - Extra fields merged into the response (e.g. nodeUrl)
 */
function sendError(socket: Socket, message: string, code: string | null = null, extra: Record<string, unknown> = {}): void {
    const response = JSON.stringify({
        success: false,
        error: message,
        ...(code ? { code } : {}),
        ...extra
    });
    socket.write(response + '\n');
    socket.end();
}

/**
 * Gracefully shutdown daemon.
 * Clears the derived vault secret from memory and closes server.
 * @param {number} [exitCode=0] - Process exit code
 * @param {string} [reason='shutdown'] - Reason for shutdown (for logging)
 */
function shutdown(exitCode = 0, reason = 'shutdown') {
    if (daemonShuttingDown) return;
    daemonShuttingDown = true;
    daemonLogger.log?.(`[credential-daemon] Shutdown requested (${reason}, exitCode=${exitCode})`);

    // Clear derived vault secret from memory.  Vault and session secrets are
    // plain objects ({ kind, version, vaultKeyHex }) — not Buffers — so we
    // iterate their properties, zero any Buffer values, and null everything.
    // Hex-string properties (vaultKeyHex, sessionSaltHex) are immutable in V8
    // and cannot be zeroed in place; they will be reclaimed by GC after the
    // object reference is dropped.
    if (vaultSecret) {
        if (Buffer.isBuffer(vaultSecret)) {
            vaultSecret.fill(0);
        } else if (typeof vaultSecret === 'object') {
            for (const key of Object.keys(vaultSecret)) {
                if (Buffer.isBuffer(vaultSecret[key])) vaultSecret[key].fill(0);
                vaultSecret[key] = null;
            }
        }
        vaultSecret = null;
    }
    if (sessionSecret) {
        if (Buffer.isBuffer(sessionSecret)) {
            sessionSecret.fill(0);
        } else if (typeof sessionSecret === 'object') {
            for (const key of Object.keys(sessionSecret)) {
                if (Buffer.isBuffer(sessionSecret[key])) sessionSecret[key].fill(0);
                sessionSecret[key] = null;
            }
        }
        sessionSecret = null;
    }
    if (sessionAccountKeys) {
        for (const [_key, val] of sessionAccountKeys) {
            if (Buffer.isBuffer(val)) {
                val.fill(0);
            }
        }
        sessionAccountKeys.clear();
    }
    for (const [, entry] of signingClientCache) {
        if (typeof entry.signingClient.dispose === 'function') {
            try { entry.signingClient.dispose(); } catch (_) {}
        }
    }
    signingClientCache.clear();

    // Close server — don't wait for active connections, process.exit will
    // tear everything down.  A hanging server.close() would prevent PM2 from
    // stopping the daemon, causing a SIGKILL after 1.6s.
    if (server) {
        try { server.close(); } catch (_) {}
    }

    // Cancel any pending policy-watch debounce and close the inotify handle.
    // If we don't, a reload could fire AFTER secrets have been zeroed, or
    // the watcher could keep the event loop alive briefly during shutdown.
    if (policyWatchDebounce) {
        clearTimeout(policyWatchDebounce);
        policyWatchDebounce = null;
    }
    if (policyWatcher) {
        try { policyWatcher.close(); } catch (_) {}
        policyWatcher = null;
    }
    if (sessionPurgeInterval) {
        clearInterval(sessionPurgeInterval);
        sessionPurgeInterval = null;
    }
    if (nodeRefreshIntervalTimer) {
        clearInterval(nodeRefreshIntervalTimer);
        nodeRefreshIntervalTimer = null;
    }
    if (auditPruneIntervalTimer) {
        clearInterval(auditPruneIntervalTimer);
        auditPruneIntervalTimer = null;
    }

    daemonLogger.log?.('[credential-daemon] Server closed');
    daemonLogger.flush().finally(() => process.exit(exitCode));
}

// Start daemon
registerProcessDiagnostics();
initialize().catch(error => {
    daemonLogger.error(`[credential-daemon] Startup failed: ${error.stack || getErrorMessage(error)}`);
    shutdown(1, 'startup failure');
});
export {};

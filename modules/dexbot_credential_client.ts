/** Credential client module - connects to credential daemon for key operations */

import { getStorage } from './storage/index.js';
import { createHmac } from './crypto/sync.js';
import { TIMING, DAEMON_CODES } from './constants.js';
const storage = getStorage();
import {
    getCredentialReadyFilePath,
    getCredentialSocketPath,
    isPrivatePathSecure,
} from './credential_runtime.js';
import { sendSocketJsonRequest } from './socket_json_client.js';
import type { SocketJsonFailureKind } from './socket_json_client.js';
import { getErrorMessage } from './utils/errors.js';
interface BroadcastUncertainErrorDetails {
    operations?: unknown[] | null;
    accountName?: string | null;
    batchId?: string | null;
    payload?: unknown;
    timeoutMs?: number | null;
}

interface CredentialClientOptions {
    socketPath?: string;
    readyFilePath?: string;
    pollIntervalMs?: number;
    requestType?: string;
    timeoutMs?: number;
    sessionId?: string | null;
    botHmacSecret?: string | null;
    batchId?: string | null;
    nodeUrl?: string;
    /**
     * Fired with the node the daemon reports as in play when a broadcast ends
     * uncertain (BROADCAST_DEADLINE / outer timeout). The daemon echoes the
     * node actually used in the typed reply — including the node the daemon
     * itself chose when the bot did not request one. Without a daemon-reported
     * node (queued deadline, never-started work) nothing is fired.
     */
    onNodeFailed?: (nodeUrl: string) => void;
}

interface CredentialDaemonMeta {
    uncertainOnTimeout?: boolean;
    operations?: unknown[] | null;
    accountName?: string | null;
    batchId?: string | null;
}

interface CredentialDaemonResponse {
    success?: boolean;
    error?: string;
    code?: string;
    raw?: unknown;
    operation_results?: unknown[];
    /** Transaction envelope returned by some daemon/API broadcast replies. */
    trx?: {
        operation_results?: unknown[];
        [key: string]: unknown;
    } | null;
    /** Node reported by the daemon as in play at the failure (typed replies). */
    nodeUrl?: string | null;
}

interface RequestPayload {
    type: string;
    accountName: string;
    operations: unknown[];
    sessionId?: string | null;
    hmac?: string;
    nodeUrl?: string;
}

const DEFAULT_SOCKET_PATH = getCredentialSocketPath();
const DEFAULT_READY_FILE = getCredentialReadyFilePath();
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_BROADCAST_TIMEOUT_MS = TIMING.CREDENTIAL_BROADCAST_TIMEOUT_MS;
const DEFAULT_WAIT_TIMEOUT_MS = TIMING.DAEMON_STARTUP_TIMEOUT_MS;
const DEFAULT_POLL_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

/**
 * Typed error raised when the bot-side socket timer fires BEFORE the credential
 * daemon has responded. The chain status of the operations is unknown at this
 * point — the daemon may have signed and broadcast, or it may have stalled
 * before doing anything. Callers (chain_orders.ts / dexbot_class.ts) MUST catch
 * this and run the recovery path (read chain, match by fingerprint, adopt or
 * discard). A plain `Error` would lose the metadata the recovery path needs.
 *
 * Fields:
 *   - operations: the original op array sent to the daemon
 *   - accountName: account the ops were intended for
 *   - batchId: caller-provided correlation id (if any)
 *   - payload: the full request payload (for retry/log)
 *   - timeoutMs: the outer timeout that fired
 */
class BroadcastUncertainError extends Error {
    code: string;
    operations: unknown[] | null;
    accountName: string | null;
    batchId: string | null;
    payload: unknown;
    timeoutMs: number | null;

    constructor(message: string, details: BroadcastUncertainErrorDetails = {}) {
        super(message);
        this.name = 'BroadcastUncertainError';
        this.code = 'BROADCAST_UNCERTAIN';
        this.operations = details.operations || null;
        this.accountName = details.accountName || null;
        this.batchId = details.batchId || null;
        this.payload = details.payload || null;
        this.timeoutMs = details.timeoutMs || null;
    }
}

function getSocketPath(options: CredentialClientOptions = {}): string {
    return options.socketPath || DEFAULT_SOCKET_PATH;
}

function sendCredentialDaemonRequest(socketPath: string, payload: RequestPayload, timeoutMs: number, meta: CredentialDaemonMeta = {}): Promise<CredentialDaemonResponse> {
    const isBroadcast = !!(meta && meta.uncertainOnTimeout);
    return sendSocketJsonRequest({
        socketPath,
        timeoutMs,
        writePayload: (socket: { write(data: string): void }) => {
            socket.write(`${JSON.stringify(payload)}\n`);
        },
        buildError: (kind: SocketJsonFailureKind, detail: unknown) => {
            // For broadcast requests the chain may have already accepted the
            // operations by the time the connection dies (socket error,
            // truncated stream, or outer timeout). Use a typed error so the
            // recovery path can detect this case explicitly. Non-broadcast
            // requests stay on the plain Error path.
            if (kind === 'invalid' && !isBroadcast) {
                return new Error('Invalid credential daemon response');
            }
            const message = kind === 'timeout'
                ? `Credential daemon ${isBroadcast ? 'broadcast ' : ''}request timed out after ${timeoutMs}ms`
                : kind === 'connection'
                    ? `Credential daemon connection failed: ${getErrorMessage(detail)}`
                    : 'Credential daemon closed the connection before a complete response was received';
            if (isBroadcast) {
                return new BroadcastUncertainError(message, {
                    operations: meta.operations || null,
                    accountName: meta.accountName || null,
                    batchId: meta.batchId || null,
                    payload,
                    timeoutMs,
                });
            }
            return new Error(message);
        },
        handleResponse: (parsed: unknown, resolve: (value: CredentialDaemonResponse) => void) => {
            resolve(parsed as CredentialDaemonResponse);
        },
    }) as Promise<CredentialDaemonResponse>;
}

function getReadyFilePath(options: CredentialClientOptions = {}): string {
    return options.readyFilePath || DEFAULT_READY_FILE;
}

function isCredentialDaemonReady(options: CredentialClientOptions = {}): boolean {
    try {
        const readyFilePath = getReadyFilePath(options);
        const socketPath = getSocketPath(options);
        return storage.exists(readyFilePath) &&
            storage.exists(socketPath) &&
            isPrivatePathSecure(readyFilePath, { expectedType: 'file', requiredMode: 0o600 }) &&
            isPrivatePathSecure(socketPath, { expectedType: 'socket', requiredMode: 0o600 });
    } catch {
        return false;
    }
}

async function waitForCredentialDaemon(timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS, options: CredentialClientOptions = {}): Promise<void> {
    const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs))
        ? Number(options.pollIntervalMs)
        : DEFAULT_POLL_INTERVAL_MS;
    const start = Date.now();

    while (!isCredentialDaemonReady(options)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for DEXBot2 credential daemon after ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}

async function executeOperationsViaCredentialDaemon(accountName: string, operations: unknown[], options: CredentialClientOptions = {}): Promise<CredentialDaemonResponse> {
    if (!accountName) {
        throw new Error('accountName is required to execute operations');
    }
    if (!Array.isArray(operations)) {
        throw new Error('operations must be an array');
    }

    const socketPath = getSocketPath(options);
    // Broadcast requests have their own (longer) outer timeout. Non-broadcast
    // callers can still pass timeoutMs explicitly to override.
    const isBroadcast = options.requestType === 'broadcast';
    const defaultTimeout = isBroadcast ? DEFAULT_BROADCAST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Number(options.timeoutMs)
        : defaultTimeout;

    // Single attempt, no client-side node cycling. The daemon retries
    // internally ONLY failures that provably never reached the chain
    // (connect/send errors); an uncertain broadcast (RPC timeout, dropped
    // connection, 25s inner BROADCAST_DEADLINE) is never re-signed, and
    // re-sending the ops here is unsafe: an uncertain broadcast may have
    // landed, duplicating on-chain orders. The recovery layers (COW
    // retry verification, startup adoption, broadcast reconciliation)
    // verify chain inclusion before any re-broadcast. onNodeFailed fires for
    // the node the daemon reports as actually in play (the daemon echoes it in
    // the typed reply even when it chose the node itself), so callers can
    // blacklist it on an uncertain outcome.
    const nodeUrl = options.nodeUrl || undefined;

    const payload: RequestPayload = { type: 'execute-operations', accountName, operations };
    const sessionId = options.sessionId || null;
    if (sessionId) payload.sessionId = sessionId;
    if (nodeUrl) payload.nodeUrl = nodeUrl;

    const botHmacSecret = options.botHmacSecret || null;
    if (botHmacSecret && sessionId) {
        payload.hmac = createHmac('sha256', Buffer.from(botHmacSecret, 'hex'))
            .update(JSON.stringify({ sessionId, operations }))
            .digest('hex');
    }

    const meta = isBroadcast
        ? {
            uncertainOnTimeout: true,
            operations,
            accountName,
            batchId: options.batchId || null,
        }
        : {};

    // The node the daemon reports as in play when an uncertain outcome occurs
    // (BROADCAST_DEADLINE reply carries nodeUrl when determinable). options.nodeUrl
    // is only the bot's PREFERRED node — the daemon may have rotated after
    // pre-transmit failures, and a deadline fired while queued involves no node.
    let daemonNodeUrl: string | null = null;

    try {
        const response = await sendCredentialDaemonRequest(socketPath, payload, timeoutMs, meta);
        if (response.success) {
            return response;
        }
        if (typeof response?.nodeUrl === 'string' && response.nodeUrl) {
            daemonNodeUrl = response.nodeUrl;
        }
        const errMsg = response.error || 'Unknown credential daemon error';
        const errCode = response.code || null;
        // The daemon hit its inner deadline (BROADCAST_DEADLINE) and the chain
        // state is uncertain. Convert this typed failure back to a
        // BroadcastUncertainError so the recovery path picks it up. Only
        // relevant for broadcast requests — non-broadcast callers don't carry
        // the uncertainOnTimeout flag.
        if (
            isBroadcast &&
            (errCode === DAEMON_CODES.BROADCAST_DEADLINE ||
                (typeof errMsg === 'string' && errMsg.startsWith(DAEMON_CODES.BROADCAST_DEADLINE)))
        ) {
            throw new BroadcastUncertainError(
                `Credential daemon broadcast uncertain: ${errCode || errMsg}`,
                {
                    operations,
                    accountName,
                    batchId: options.batchId || null,
                    payload,
                    timeoutMs,
                }
            );
        }
        // Typed failure reply from the daemon (e.g. policy denied, bad op) —
        // the chain state is known (chain NOT touched), so a plain Error is
        // fine.
        throw new Error(errMsg);
    } catch (err) {
        if (err instanceof BroadcastUncertainError) {
            // Blame the node the daemon reported (the one actually in play at
            // the deadline), never the bot's original preference blindly: the
            // daemon may have rotated, and a queued deadline involves no node.
            // Without a daemon-reported node, nothing is reported (the daemon's
            // own ledger already records rotation failures).
            if (typeof options.onNodeFailed === 'function' && daemonNodeUrl) {
                options.onNodeFailed(daemonNodeUrl);
            }
            // NEVER re-send ops whose outcome is unknown: the broadcast may
            // have landed, and re-sending duplicates on-chain orders (the
            // daemon never re-signs an uncertain broadcast — it only retries
            // provably-untransmitted failures). Propagate the uncertain error
            // so the recovery layers (COW retry verification, startup
            // adoption, broadcast reconciliation) verify chain inclusion
            // before any re-broadcast.
            throw err;
        }
        throw err;
    }
}

export { DEFAULT_READY_FILE, DEFAULT_SOCKET_PATH, DEFAULT_BROADCAST_TIMEOUT_MS, executeOperationsViaCredentialDaemon, isCredentialDaemonReady, waitForCredentialDaemon, BroadcastUncertainError }


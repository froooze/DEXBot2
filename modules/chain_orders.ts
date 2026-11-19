/**
 * modules/chain_orders.ts - Blockchain Interaction Layer
 *
 * BitShares blockchain operations and order management interface.
 * Provides all blockchain I/O operations for the bot.
 *
 * Responsibilities:
 * - Account selection and management
 * - Reading open orders from blockchain
 * - Creating, updating, and canceling limit orders
 * - Listening for fill events via subscriptions
 * - Fetching on-chain asset balances and metadata
 * - Batch operation execution
 * - Fill deduplication and processing mode selection
 *
 * All order amounts are human-readable floats externally,
 * converted to blockchain integers internally using asset precision.
 *
 * ===============================================================================
 * EXPORTS (25 functions + 1 error class)
 * ===============================================================================
 *
 * ACCOUNT MANAGEMENT (4 functions - async)
 *   1. selectAccount() - Interactively select/authenticate an account
 *      Prompts for password if needed, caches selection
 *      Returns { accountName, privateKey, id }
 *
 *   2. setPreferredAccount(accountId, accountName) - Set preferred account
 *   3. resolveAccountId(accountName) - Resolve account name to ID (async, cached)
 *   4. resolveAccountName(accountRef) - Resolve account ID/name to name (async, cached)
 *
 * ORDER OPERATIONS (10 functions - async)
 *   5. readOpenOrders(accountId, timeoutMs, suppressLog) - Read all open orders
 *      Returns array of raw BitShares limit order objects (for_sale, sell_price, ...)
 *   6. readOpenOrdersWithMeta(accountId, timeoutMs, suppressLog) - Read open orders with meta
 *   7. readOpenOrdersWithMetaSafe(chainOrdersModule, accountId, timeoutMs, suppressLog) - Safe wrapper
 *   8. readOpenOrdersGuarded(chainOrdersModule, accountId, options) - Guarded read with failover
 *   9. readSingleOrder(orderId, timeoutMs) - Fetch a single limit order by id
 *      Returns raw order object, null if absent, throws on error
 *   10. batchReadOrders(orderIds, timeoutMs) - Fetch multiple orders by id
 *       Returns array of order objects (null for missing ids)
 *
 *   11. createOrder(accountName, privateKey, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration, dryRun, extraOptions)
 *       Create a limit order; returns { tx_id, operation_results } or throws
 *   12. updateOrder(accountName, privateKey, orderId, newParams, extraOptions)
 *       newParams: { amountToSell?, minToReceive?, newPrice?, orderType?, expiration? }
 *       Returns transaction result
 *   13. cancelOrder(accountName, privateKey, orderId, extraOptions) - Cancel order
 *       Returns transaction result
 *   14. executeBatch(accountName, privateKey, operations, extraOptions) - Execute batch of operations
 *       Executes multiple operations (create/update/cancel) in one transaction
 *
 * FILL EVENT HANDLING (1 function - async)
 *   15. listenForFills(accountRefOrCallback, callback?) - Subscribe to fill events
 *       Invokes callback with raw fill updates from the native subscription
 *       Returns unsubscribe function
 *
 * FILL DEDUPLICATION (2 functions)
 *   16. wasRecentlyOwnCancelled(orderId) - Check if order was recently self-cancelled
 *   17. recordOwnCancel(orderId) - Record a self-cancelled order
 *
 * ACCOUNT STATE (1 function - async)
 *   18. getOnChainAssetBalances(accountRef, assets, options) - Fetch account asset balances
 *       Returns map of assetRef → { assetId, symbol, precision, freeRaw, lockedRaw, free, locked, total }
 *
 * OPERATION BUILDERS (4 functions)
 *   19. buildCreateOrderOp(accountName, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration)
 *   20. buildUpdateOrderOp(accountName, orderId, newParams, cachedOrder)
 *   21. buildCancelOrderOp(accountName, orderId)
 *   22. buildLiquidityPoolExchangeOp(accountId, poolId, sellAmountInt, sellAssetId, minReceiveInt, receiveAssetId)
 *
 * CONFIGURATION:
 *   23. getFillProcessingMode() - Get current fill processing mode
 *       Returns 'history' (use fill event data) or 'open' (fetch open orders)
 *   24. broadcastTxWithClassification(tx, accountName, operations) - Broadcast with outcome classification
 *
 * BROADCAST FAILURE DETECTION (1 function)
 *   25. findOverReducingUpdateOpError(result, operations) - Detect limit_order_update
 *       ops whose negative delta would over-reduce the order
 *
 * ERROR HANDLING:
 *   26. BroadcastUncertainError - Error class for uncertain broadcast results
 *
 * ===============================================================================
 *
 * ACCOUNT RESOLUTION:
 * - Caches account name ↔ ID mappings to avoid repeated blockchain queries
 * - Shared with modules/chain_keys.ts for authentication
 *
 * FILL MODES:
 * - 'history' mode: Use fill event data directly (faster, preferred)
 * - 'open' mode: Fetch open orders from blockchain (backup method, more API calls)
 *
 * RACE CONDITION PREVENTION:
 * - _subscriptionLock: Serializes subscription map access
 * - _preferredAccountLock: Serializes preferred account access
 * - _resolutionLock: Serializes account resolution calls
 *
 * AUTHENTICATION:
 * Moved to modules/chain_keys.ts for centralized key management.
 * Use chain_keys.authenticate() and getPrivateKey() for auth operations.
 *
 * ===============================================================================
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import * as client from './bitshares_client.js';
const { BitShares, createAccountClient, waitForConnected, withTimeout } = client;
import { floatToBlockchainInt, blockchainToFloat, normalizeInt, validateOrderAmountsWithinLimits } from './order/utils/math.js';
import { FILL_PROCESSING, TIMING, NATIVE_CLIENT, DAEMON_CODES } from './constants.js';
import * as Format from './order/format.js';
import AsyncLock from './order/async_lock.js';
import { readInput, resolveAssetByRef } from './order/utils/system.js';
import * as chainKeys from './chain_keys.js';
import { getKeyStore } from './key_store.js';
import { BroadcastUncertainError } from './dexbot_credential_client.js';
import { classifyBroadcastFailure } from './broadcast_failure.js';
import Logger from './order/logger.js';
import { getErrorMessage } from './utils/errors.js';
import { normalizeAssetRef } from './utils/asset_symbols.js';
import type { ChainOrder } from './types.js';
import type { BtsdexTx } from './bitshares-native/signing_client.js';

/** A broadcastable operation envelope. */
interface OperationLike {
    op_name?: string;
    op_data?: Record<string, unknown>;
}

interface AccountSubscription {
    userCallbacks: Set<(updates: unknown[]) => unknown>;
    bsCallback: (updates: unknown) => Promise<void>;
}

interface ChainOrdersModuleLike {
    readOpenOrdersWithMeta?(accountId: string | null, timeoutMs?: number, suppressLog?: boolean): Promise<{ orders: ChainOrder[]; truncated: boolean }>;
    readOpenOrders(accountId?: string | null, ...args: unknown[]): Promise<unknown>;
}

/** Parameters accepted by buildUpdateOrderOp / updateOrder. */
interface UpdateOrderParams {
    amountToSell?: number | null;
    minToReceive?: number | null;
    newPrice?: number | null;
    orderType?: string;
    expiration?: string;
}
function getNodeManager() { return require('./bitshares_client').getNodeManager(); }
const { toFiniteNumber } = Format;

const chainOrdersLogger = new Logger('ChainOrders');
const { ORDER_EVENTS } = NATIVE_CLIENT;

// Ring buffer of order ids the local process just cancelled.
// Used by the fill consumer to ignore a fill/cancel-history entry that is
// really just the propagation of the bot's own broadcast cancel op. Entries
// expire after RECENT_OWN_CANCEL_TTL_MS so the buffer self-cleans.
const RECENT_OWN_CANCEL_TTL_MS = ORDER_EVENTS.RECENT_OWN_CANCEL_TTL_MS;
const RECENT_OWN_CANCEL_MAX_ENTRIES = ORDER_EVENTS.RECENT_OWN_CANCEL_MAX_ENTRIES;
const _recentOwnCancels = new Map<string, number>();

function recordOwnCancel(orderId: string | null | undefined) {
    if (!orderId) return;
    const now = Date.now();
    _recentOwnCancels.set(String(orderId), now);
    // Lazy GC: drop expired entries when the buffer grows.
    if (_recentOwnCancels.size > RECENT_OWN_CANCEL_MAX_ENTRIES) {
        for (const [id, ts] of _recentOwnCancels) {
            if (now - ts > RECENT_OWN_CANCEL_TTL_MS) _recentOwnCancels.delete(id);
        }
    }
}

function recordOwnCancelOps(operations: unknown) {
    for (const op of (operations as OperationLike[]) || []) {
        if (op?.op_name === 'limit_order_cancel' && op.op_data?.order) {
            recordOwnCancel(op.op_data.order as string);
        }
    }
}

function wasRecentlyOwnCancelled(orderId: string | null | undefined) {
    if (!orderId) return false;
    const ts = _recentOwnCancels.get(String(orderId));
    if (ts == null) return false;
    if (Date.now() - ts > RECENT_OWN_CANCEL_TTL_MS) {
        _recentOwnCancels.delete(String(orderId));
        return false;
    }
    return true;
}

// Key/auth helpers provided by modules/chain_keys.ts
// (authenticate(), getPrivateKey(), MasterPasswordError)

/**
 * Fill processing mode from FILL_PROCESSING.MODE constant:
 * - 'history': Use fill event data directly to match order_id with account_orders (preferred, faster)
 * - 'open': Fetch open orders from blockchain and sync (backup method, more API calls)
 */
const FILL_PROCESSING_MODE = FILL_PROCESSING.MODE;

// AsyncLock instances for preventing race conditions
// _subscriptionLock: Serializes access to accountSubscriptions map
// _preferredAccountLock: Serializes access to preferredAccount global state
// _resolutionLock: Serializes account resolution calls and caching
const _subscriptionLock = new AsyncLock();
const _preferredAccountLock = new AsyncLock();
const _resolutionLock = new AsyncLock();

// Cache for account resolutions (name -> id and id -> name)
const _accountResolutionCache = new Map<string, string>();

/**
 * Resolve asset precision from ID or symbol via BitShares DB.
 * @param {string} assetRef - Asset ID or symbol.
 * @returns {Promise<number>} The asset's precision (number of decimals).
 * @throws {Error} If precision cannot be resolved.
 * @private
 */
async function _getAssetPrecision(assetRef: string) {
    if (!assetRef) throw new Error("Asset reference required for _getAssetPrecision");
    const asset = await resolveAssetByRef(BitShares, assetRef);
    if (asset && typeof asset.precision === 'number') return asset.precision;
    throw new Error(`CRITICAL: Could not resolve precision for asset ${assetRef}. Halting operation to prevent scaling errors. Cause: asset not found or precision missing.`);
}

// Preferred account ID and name for operations (can be changed)
// Access MUST be protected by _preferredAccountLock to prevent race conditions
let preferredAccountId: string | null = null;
let preferredAccountName: string | null = null;
const _multiBotWarnings = new Set<string>();

function _warnOnce(key: string, message: string) {
    if (_multiBotWarnings.has(key)) return;
    _multiBotWarnings.add(key);
    chainOrdersLogger.warn(message);
}

/**
 * Set the preferred account for subsequent operations.
 * This allows other functions to operate without requiring account parameters.
 * Uses AsyncLock to prevent race conditions when multiple functions access this simultaneously.
 * Warns once when overwriting a different account (multi-bot monolithic mode detection).
 * @param {string} accountId - BitShares account ID (e.g., '1.2.12345')
 * @param {string} accountName - Human-readable account name
 */
async function setPreferredAccount(accountId: string | null, accountName: string | null) {
    await _preferredAccountLock.acquire(async () => {
        if (preferredAccountName && accountName && preferredAccountName !== accountName) {
            _warnOnce(
                `account-overwrite:${preferredAccountName}->${accountName}`,
                `[MULTI-BOT] Preferred account overwritten: '${preferredAccountName}' -> '${accountName}'. ` +
                `All functions without explicit account params now target '${accountName}'.`
            );
        }
        preferredAccountId = accountId;
        if (accountName) preferredAccountName = accountName;
    });
}

/**
 * Get the current preferred account (thread-safe).
 * @returns {Promise<{id: string|null, name: string|null}>}
 */
async function getPreferredAccount() {
    return await _preferredAccountLock.acquire(async () => {
        return { id: preferredAccountId, name: preferredAccountName };
    });
}

/**
 * Resolve an account reference against the shared name<->id cache under the
 * resolution lock. `direction` picks which field is looked up and returned:
 * 'to-name' resolves an id to a name, 'to-id' a name to an id. A reference
 * already shaped as the target (id for 'to-name', non-id for 'to-id') is
 * returned untouched, and the reverse mapping is cached alongside the result.
 * @param {string} accountRef - Account id or name
 * @param {'to-name'|'to-id'} direction - Direction of resolution
 * @returns {Promise<string|null>} Resolved value or null if not found
 */
async function resolveAccount(accountRef: string | null | undefined, direction: 'to-name' | 'to-id') {
    if (!accountRef) return null;
    if (typeof accountRef !== 'string') return null;
    if (direction === 'to-name' ? !/^1\.2\./.test(accountRef) : /^1\.2\.\d+$/.test(accountRef)) return accountRef;

    return await _resolutionLock.acquire(async () => {
        // Check cache first
        const cacheKey = `${direction === 'to-name' ? 'id->' : 'name->'}${accountRef}`;
        if (_accountResolutionCache.has(cacheKey)) {
            return _accountResolutionCache.get(cacheKey) ?? null;
        }

        try {
            await waitForConnected();
            const full = await BitShares.db.get_full_accounts([accountRef], false) as Array<[unknown, { account?: { name?: string; id?: string } }]>;
            const account = full && full[0] && full[0][1] && full[0][1].account;
            const result = direction === 'to-name' ? account?.name : account?.id;
            if (result) {
                _accountResolutionCache.set(cacheKey, result);
                // Also cache reverse mapping
                _accountResolutionCache.set(`${direction === 'to-name' ? 'name' : 'id'}->${result}`, accountRef);
                return result;
            }
        } catch (err) {
            // ignore resolution failures
        }
        return null;
    });
}

/**
 * Resolve an account ID to its human-readable name via chain lookup.
 * Results are cached to prevent repeated lookups (fixes Issue #4).
 * @param {string} accountRef - Account ID (e.g., '1.2.12345') or name
 * @returns {Promise<string|null>} Account name or null if not found
 */
async function resolveAccountName(accountRef: string | null | undefined) {
    return resolveAccount(accountRef, 'to-name');
}

/**
 * Resolve an account name to its ID via chain lookup.
 * Results are cached to prevent repeated lookups (fixes Issue #4).
 * @param {string} accountName - Human-readable account name
 * @returns {Promise<string|null>} Account ID or null if not found
 */
async function resolveAccountId(accountName: string | null | undefined) {
    return resolveAccount(accountName, 'to-id');
}

// Track active account subscriptions so we avoid duplicate listeners per account
// Map accountName -> { userCallbacks: Set<Function>, bsCallback: Function }
// Access MUST be protected by _subscriptionLock to prevent TOCTOU races (fixes Issue #1)
const accountSubscriptions = new Map<string, AccountSubscription>();

/**
 * Ensure a per-account BitShares subscription exists so we only subscribe once.
 * @param {string} accountName - The name of the account to subscribe to.
 * @param {Function} [userCallback] - Optional user callback to register before the native
 *   subscription's initial catch-up runs. Prevents initial catch-up fills from being lost.
 * @returns {Promise<Object>} The subscription entry { userCallbacks, bsCallback }.
 * @private
 */
async function _ensureAccountSubscriber(accountName: string, userCallback: ((updates: unknown[]) => unknown) | null = null) {
    return await _subscriptionLock.acquire(async () => {
        // Check again inside lock to prevent duplicate subscriptions
        if (accountSubscriptions.has(accountName)) {
            return accountSubscriptions.get(accountName);
        }

        const userCallbacks = new Set<(updates: unknown[]) => unknown>();
        if (typeof userCallback === 'function') {
            userCallbacks.add(userCallback);
        }

        // BitShares callback that receives raw updates and dispatches to user callbacks
        const bsCallback = async (updates: unknown) => {
            // Filter for fill-related operations
            const fills = (updates as Array<{ op?: unknown[] }>).filter((update) => {
                const op = update.op;
                return op && op[0] === FILL_PROCESSING.OPERATION_TYPE; // operation type for fill_order
            });

            if (fills.length > 0) {
                // Call each registered user callback with the fills array
                const failures: unknown[] = [];
                for (const c of [...userCallbacks]) {
                    try {
                        await Promise.resolve(c(fills));
                    } catch (e) {
                        failures.push(e);
                        chainOrdersLogger.error(`chain_orders listener error ${getErrorMessage(e)}`);
                    }
                }
                if (failures.length > 0) {
                    const err: Error & { causes?: unknown[] } = new Error(`Fill listener delivery failed for ${failures.length} callback(s): ${failures.map((e: unknown) => getErrorMessage(e) || String(e)).join('; ')}`);
                    err.causes = failures;
                    throw err;
                }
            }
        };

        try {
            await withTimeout(
                BitShares.subscribe('account', bsCallback, accountName),
                NATIVE_CLIENT.SUBSCRIPTIONS.SUBSCRIBE_TIMEOUT_MS,
                { label: 'BitShares.subscribe' }
            );
        } catch (subscribeErr) {
            // Roll back any partial native-subscription state set up before the
            // timeout or hard failure. BitShares.subscribe registers the entry
            // in the native subscriptions map and adds bsCallback to
            // entry.callbacks before its first await; if we fail before it
            // returns, that state would otherwise be leaked and the next call
            // for the same account would observe a half-dead subscription.
            if (typeof BitShares.unsubscribe === 'function') {
                try {
                    await BitShares.unsubscribe('account', bsCallback, accountName);
                } catch (rollbackErr) {
                    chainOrdersLogger.warn(
                        `Failed to roll back partial subscription for ${accountName} after error: ` +
                        `${getErrorMessage(rollbackErr)}`
                    );
                }
            }
            throw subscribeErr;
        }

        const entry = { userCallbacks, bsCallback };
        accountSubscriptions.set(accountName, entry);
        return entry;
    });
}

/**
 * Interactive account selection from stored encrypted keys.
 * Prompts user to authenticate and select an account.
 * Uses AsyncLock to prevent race conditions with concurrent listenForFills calls (fixes Issue #2, #5).
 * @returns {Promise<Object>} { accountName, privateKey, id }
 */
async function selectAccount() {
    const masterPassword = await chainKeys.authenticate();
    const accountsData = chainKeys.loadAccounts();
    const accountNames = Object.keys(accountsData.accounts);

    if (accountNames.length === 0) {
        throw new Error('No accounts found. Please add accounts using modules/chain_keys.ts');
    }

    console.log('Available accounts:');
    accountNames.forEach((name, index) => {
        console.log(`${index + 1}. ${name}`);
    });

    const choiceStr = await readInput('Select account number: ');
    const choice = parseInt(choiceStr, 10) - 1;
    if (choice < 0 || choice >= accountNames.length) {
        throw new Error('Invalid account selection.');
    }

    const selectedAccount = accountNames[choice];
    const privateKey = chainKeys.getPrivateKey(selectedAccount, masterPassword);

    let selectedId: string | null = null;
    try {
        const full = await BitShares.db.get_full_accounts([selectedAccount], false) as Array<[unknown, { account?: { id?: string } }]>;
        if (full && full[0]) {
            const candidateId = full[0][0];
            if (candidateId && String(candidateId).startsWith('1.2.')) selectedId = String(candidateId);
            else if (full[0][1] && full[0][1].account && full[0][1].account.id) selectedId = full[0][1].account.id;
        }
    } catch (e) {
        console.error(`Failed to resolve account ID for ${selectedAccount}: ${getErrorMessage(e)}`);
    }

    if (selectedId) {
        await setPreferredAccount(selectedId, selectedAccount);
    }

    const pref = await getPreferredAccount();
    console.log(`Selected account: ${selectedAccount} (ID: ${pref.id})`);
    return { accountName: selectedAccount, privateKey: privateKey, id: pref.id };
}

/**
 * Check if a value is a credential daemon signing token.
 * @param {*} value - Value to check
 * @returns {boolean} True if value is a daemon signing token
 */
function isDaemonSigningToken(value: unknown) {
    return getKeyStore().isDaemonSigningKey(value);
}

/**
 * Execute blockchain operations via the credential daemon.
 * @param {string} accountName - Account name
 * @param {Object} signingToken - Daemon signing token with socketPath, sessionId, botHmacSecret
 * @param {Array<any>} operations - Array of operation objects
 * @returns {Promise<any>} Broadcast result
 */
async function executeViaDaemonToken(accountName: string | null | undefined, signingToken: unknown, operations: unknown[], extraOptions: Record<string, unknown> = {}) {
    const nodeManager = getNodeManager();
    const healthyNodes = nodeManager?.getHealthyNodes() ?? [];
    const opts: Record<string, unknown> = extraOptions;
    if (healthyNodes.length > 0 && nodeManager && !opts.nodeUrl) {
        opts.nodeUrl = healthyNodes[0];
        opts.onNodeFailed = (nodeUrl: string) => nodeManager.reportNodeFailure(nodeUrl, DAEMON_CODES.BROADCAST_DEADLINE, 'broadcast');
    }
    return getKeyStore().executeOperations(accountName as string, operations as Parameters<ReturnType<typeof getKeyStore>['executeOperations']>[1], signingToken, opts);
}

/**
 * Fetch a single limit order by id from the blockchain.
 *
 * Used by the sync engine as a targeted refetch when the cached `rawOnChain.for_sale`
 * is observed to be smaller than the grid's own size (a "drift signal" — the chain
 * value can only decrease, never grow on its own). The refetch is the only
 * operation that re-anchors the cache to chain truth for an order whose in-memory
 * baseline has fallen out of sync (e.g., a missed fill event).
 *
 * Return semantics:
 *   - returns the raw order object on success
 *   - returns `null` if the order is genuinely absent from the chain (`get_objects`
 *     returns null for missing ids) — this is the authoritative "order is gone"
 *     signal
 *   - THROWS on any other error (connection timeout, RPC failure, etc.). Callers
 *     use try/catch to distinguish "tried-and-gone" (null) from "tried-and-failed"
 *     (caught) and fall back to the cache.
 *
 * @param {string} orderId - BitShares limit order id (e.g. "1.7.572840453")
 * @param {number} [timeoutMs] - Connection timeout in milliseconds. Defaults to
 *   the full CONNECTION_TIMEOUT_MS (30s); sync-engine callers should pass a
 *   smaller value so a disconnected node does not stall a fill cycle.
 * @returns {Promise<Object|null>} Raw chain order object, or null if not found
 * @throws {Error} On connection or RPC failure
 */
async function readSingleOrder(orderId: string, timeoutMs: number = TIMING.CONNECTION_TIMEOUT_MS): Promise<ChainOrder | null> {
    if (!orderId || typeof orderId !== 'string') return null;
    await waitForConnected(timeoutMs);
    if (!BitShares || !BitShares.db || typeof BitShares.db.get_objects !== 'function') {
        throw new Error('readSingleOrder: BitShares.db.get_objects unavailable');
    }
    const results = await BitShares.db.get_objects([orderId]);
    const order = Array.isArray(results) ? results[0] : null;
    if (!order) return null;
    if (order.id !== orderId) return null;
    return order;
}

/**
 * Fetch multiple limit orders by id in a single get_objects RPC call.
 *
 * Deduplicates input IDs and returns a Map of orderId → raw order object
 * (or null for absent IDs). Used by the sync engine to batch drift
 * refetches across all fills in a block group, replacing N individual
 * readSingleOrder calls with one RPC.
 *
 * Falls back to individual readSingleOrder calls on error.
 *
 * @param {string[]} orderIds - Array of BitShares limit order ids
 * @param {number} [timeoutMs] - Connection timeout in milliseconds
 * @returns {Promise<Map<string, Object|null>>} Map of orderId → raw order or null
 */
async function batchReadOrders(orderIds: string[], timeoutMs: number = TIMING.CONNECTION_TIMEOUT_MS) {
    if (!Array.isArray(orderIds) || orderIds.length === 0) return new Map();
    const uniqueIds = [...new Set(orderIds.filter((id: unknown) => id && typeof id === 'string'))];
    if (uniqueIds.length === 0) return new Map();

    await waitForConnected(timeoutMs);
    if (!BitShares || !BitShares.db || typeof BitShares.db.get_objects !== 'function') {
        throw new Error('batchReadOrders: BitShares.db.get_objects unavailable');
    }

    const results = await BitShares.db.get_objects(uniqueIds);
    const resultMap = new Map<string, ChainOrder | null>();
    if (Array.isArray(results)) {
        for (let i = 0; i < uniqueIds.length; i++) {
            const id = uniqueIds[i];
            const order = results[i];
            if (order && order.id === id) {
                resultMap.set(id, order);
            } else {
                resultMap.set(id, null);
            }
        }
    }
    return resultMap;
}

/**
 * Fetch all open limit orders for an account from the blockchain.
 * Uses AsyncLock to safely access preferred accountId (fixes Issue #2).
 * @param {string|null} accountId - Account ID to query (uses preferred if null)
 * @param {number} timeoutMs - Connection timeout in milliseconds
 * @param {boolean} suppress_log - Whether to suppress the log
 * @returns {Promise<Array>} Array of raw order objects from chain
 */
async function readOpenOrders(accountId: string | null = null, timeoutMs: number = TIMING.CONNECTION_TIMEOUT_MS, suppress_log: boolean = true): Promise<ChainOrder[]> {
    const { orders } = await readOpenOrdersWithMeta(accountId, timeoutMs, suppress_log);
    return orders;
}

/**
 * Read open orders with the truncation flag through a caller-supplied
 * chainOrders module/mock, falling back to a plain readOpenOrders when the
 * with-meta variant is unavailable (test mocks). Absence decisions MUST NOT
 * be made on `truncated: true` or empty reads (see readOpenOrdersWithMeta).
 * @param {Object} chainOrdersModule - chainOrders module (or mock) with readOpenOrders
 * @param {string|null} accountId - Account ID to query (uses preferred if null)
 * @param {number} [timeoutMs] - Connection timeout in milliseconds
 * @param {boolean} [suppress_log] - Whether to suppress the log
 * @returns {Promise<{orders: Array, truncated: boolean}>} Raw order objects plus truncation flag
 */
async function readOpenOrdersWithMetaSafe(chainOrdersModule: ChainOrdersModuleLike, accountId: string | null = null, timeoutMs: number = TIMING.CONNECTION_TIMEOUT_MS, suppress_log: boolean = true) {
    if (chainOrdersModule && typeof chainOrdersModule.readOpenOrdersWithMeta === 'function') {
        return await chainOrdersModule.readOpenOrdersWithMeta(accountId, timeoutMs, suppress_log);
    }
    return { orders: (await chainOrdersModule.readOpenOrders(accountId, timeoutMs, suppress_log)) as ChainOrder[], truncated: false };
}

/**
 * Read open orders for a sync/reconcile decision, deferring (returning null)
 * when the snapshot cannot drive absence/sync decisions:
 * - truncated: the get_full_accounts window omitted the freshest orders —
 *   syncing would virtualize live ACTIVE slots via pass-1 phantom cleanup;
 * - empty (only when deferEmpty is set): indistinguishable from a lagging
 *   node that missed a just-broadcast transaction.
 * Callers treat null as "defer this cycle" (optionally falling back to a
 * local sync); the raw orders are returned otherwise.
 * @param {Object} chainOrdersModule - chainOrders module (or mock)
 * @param {string|null} accountId - Account ID to query (uses preferred if null)
 * @param {Object} [options]
 * @param {Function} [options.log] - Logger callback (message, level); skipped when omitted
 * @param {string} [options.label] - Log prefix label (e.g. 'PERIODIC-SYNC')
 * @param {string} [options.detail] - Extra context appended to the default message
 * @param {boolean} [options.deferEmpty] - Treat an empty read as ambiguous too
 * @param {number} [options.timeoutMs] - Connection timeout in milliseconds
 * @param {string|Function} [options.skipMessage] - Replace the default log message;
 *   a function receives the kind ('TRUNCATED'|'EMPTY') to build a site-specific message
 * @returns {Promise<Array|null>} Open orders, or null when the read is ambiguous
 */
async function readOpenOrdersGuarded(chainOrdersModule: ChainOrdersModuleLike, accountId: string | null = null, options: {
    log?: (message: string, level?: string) => void;
    label?: string;
    detail?: string;
    deferEmpty?: boolean;
    timeoutMs?: number;
    skipMessage?: string | ((kind: string) => string);
} = {}) {
    const { log, label = 'SYNC', detail, deferEmpty = false, timeoutMs, skipMessage } = options;
    const read = await readOpenOrdersWithMetaSafe(chainOrdersModule, accountId, timeoutMs);
    const truncated = read?.truncated === true;
    const orders = read?.orders;
    const empty = !Array.isArray(orders) || orders.length === 0;
    if (!truncated && !(deferEmpty && empty)) return Array.isArray(orders) ? orders : [];

    if (typeof log === 'function') {
        const kind = truncated ? 'TRUNCATED' : 'EMPTY';
        const message = typeof skipMessage === 'function'
            ? skipMessage(kind)
            : (skipMessage || `[${label}] Open-order read ${kind}${detail ? ` (${detail})` : ''} - ambiguous snapshot (fresh orders omitted by the get_full_accounts window, or the node is lagging); deferring`);
        log(message, 'warn');
    }
    return null;
}

/**
 * Fetch all open limit orders for an account from the blockchain, returning
 * the raw order list together with the node's truncation flag.
 *
 * get_full_accounts caps each collection (api_limit_get_full_accounts_lists,
 * default 500 limit_orders; a node operator may lower it). The by_account
 * index is ordered (seller, object_id), so freshly created orders sort last
 * and are the FIRST entries truncated away on an oversized account. Callers
 * that make absence decisions (e.g. pre-retry broadcast verification) MUST
 * treat a truncated read as 'unknown' — a batch's fresh creates may simply
 * be missing from the returned window, not absent from the chain.
 * @param {string|null} accountId - Account ID to query (uses preferred if null)
 * @param {number} timeoutMs - Connection timeout in milliseconds
 * @param {boolean} suppress_log - Whether to suppress the log
 * @returns {Promise<{orders: Array, truncated: boolean}>} Raw order objects plus truncation flag
 */
async function readOpenOrdersWithMeta(accountId: string | null = null, timeoutMs: number = TIMING.CONNECTION_TIMEOUT_MS, suppress_log: boolean = true): Promise<{ orders: ChainOrder[]; truncated: boolean }> {
    await waitForConnected(timeoutMs);
    try {
        let accId = accountId;
        if (!accId) {
            const pref = await getPreferredAccount();
            accId = pref.id;
            if (!accId) {
                throw new Error('No account selected. Please call selectAccount() first or pass an account id');
            }
            _warnOnce(
                `readOpenOrders-no-accountId`,
                `[MULTI-BOT] readOpenOrders called without explicit accountId — using preferred '${pref.name || accId}'. ` +
                `Pass accountId explicitly in multi-bot mode.`
            );
        }
        const fullAccount = await BitShares.db.get_full_accounts([accId], false) as Array<[unknown, { limit_orders?: ChainOrder[]; more_data_available?: { limit_orders?: boolean } }]>;
        const accountObj = fullAccount[0][1];
        const orders = (accountObj.limit_orders || []) as ChainOrder[];
        const truncated = Boolean(accountObj.more_data_available?.limit_orders);

        if (!suppress_log) {
            chainOrdersLogger.info(`Found ${orders.length} open orders for account ${accId}${truncated ? ' (TRUNCATED)' : ''}`);
        }
        return { orders, truncated };
    } catch (error) {
        const msg = getErrorMessage(error);
        // Missing account is a caller-configuration error, not a chain failure;
        // downgrade to warn so intentional negative-path tests don't pollute
        // ERROR diagnostics and hide real fund-invariant violations.
        if (msg.includes('No account selected')) {
            chainOrdersLogger.warn(`Error reading open orders: ${msg}`);
        } else {
            chainOrdersLogger.error(`Error reading open orders: ${msg}`);
        }
        throw error;
    }
}

/**
 * Subscribe to fill events for an account.
 * Calls the callback when any of the account's orders are filled.
 * Uses AsyncLock to safely access preferredAccount and subscription state (fixes Issue #2, #5).
 *
 * @param {string|Function} accountRef - Account name/id, or callback if using preferred
 * @param {Function} [callback] - Function called with array of fill operations (when accountRef is a string)
 * @returns {Function} Unsubscribe function to stop listening
 */
async function listenForFills(accountRef: unknown, callback?: unknown) {
    let userCallback: ((updates: unknown[]) => unknown) | null = null;
    let accountToken: unknown = null;
    if (typeof accountRef === 'function' && arguments.length === 1) {
        userCallback = accountRef as (updates: unknown[]) => unknown;
    } else {
        accountToken = accountRef;
        userCallback = callback as (updates: unknown[]) => unknown;
    }

    if (typeof userCallback !== 'function') {
        chainOrdersLogger.error('listenForFills requires a callback function');
        return () => { };
    }

    // Safely access preferredAccount using getPreferredAccount (fixes Issue #2, #5)
    const pref = await getPreferredAccount();
    let accountName: string | null = (typeof accountToken === 'string' ? accountToken : null) || pref.name;
    if (!accountName && pref.id) {
        accountName = await resolveAccountName(pref.id);
    }

    if (!accountName) {
        chainOrdersLogger.error('listenForFills requires an account name or a preferredAccount to be set');
        return () => { };
    }

    let accountId: string | null = null;
    if (/^1\.2\./.test(String(accountToken || ''))) {
        accountId = String(accountToken);
    } else if (/^1\.2\./.test(String(accountName || ''))) {
        accountId = accountName;
    } else if (!accountToken && pref.id) {
        accountId = pref.id;
    }
    if (!accountId) {
        accountId = await resolveAccountId(accountName);
    }

    if (accountId) {
        readOpenOrders(accountId, TIMING.CONNECTION_TIMEOUT_MS, true).catch((error: unknown) => chainOrdersLogger.error(`Error loading account for listening: ${getErrorMessage(error)}`));
    } else {
        chainOrdersLogger.warn('Unable to derive account id before listening for fills; skipping open-order prefetch.');
    }

    // Pass userCallback to _ensureAccountSubscriber so the native subscription's
    // initial catch-up fills are dispatched to the caller (not lost).
    // If the subscription already exists, the callback is added below instead.
    const entry = await _ensureAccountSubscriber(accountName, userCallback);
    if (!entry) {
        return () => { };
    }

    // Add callback inside lock to prevent race with concurrent listenForFills calls.
    // If _ensureAccountSubscriber already added it (new subscription), this is a no-op
    // (Set.add deduplicates by reference).
    const listenerCount = await _subscriptionLock.acquire(async () => {
        entry.userCallbacks.add(userCallback);
        return entry.userCallbacks.size;
    });

    chainOrdersLogger.info(`Listening for fills on account: ${accountName} (total listeners: ${listenerCount})`);

    // Return an unsubscribe function that atomically removes the listener
    return async function unsubscribe() {
        try {
            await _subscriptionLock.acquire(async () => {
                entry.userCallbacks.delete(userCallback);
                if (entry.userCallbacks.size === 0) {
                    try {
                        if (typeof BitShares.unsubscribe === 'function') {
                            await BitShares.unsubscribe('account', entry.bsCallback, accountName);
                        }
                    } catch (e) { chainOrdersLogger.warn(`Unsubscribe failed: ${getErrorMessage(e)}`); }
                    accountSubscriptions.delete(accountName);
                }
            });
        } catch (e) {
            chainOrdersLogger.error(`Error unsubscribing listenForFills ${getErrorMessage(e)}`);
        }
    };
}

/**
 * Receive amount for a limit_order_update. Policy:
 * - minToReceive provided: absolute override.
 * - newPrice provided: `sellFloat` scaled by the price (multiply for a sell,
 *   divide for a buy).
 * - otherwise: keep the existing on-chain price ratio (`sellInt * quote/base`).
 * Shared by the pre- and post-delta computations so both agree.
 */
function computeOrderReceiveInt(
    newParams: UpdateOrderParams,
    receivePrecision: number,
    sellInt: number,
    sellFloat: number,
    priceRatioBase: number,
    priceRatioQuote: number,
): number {
    if (newParams.minToReceive !== undefined && newParams.minToReceive !== null) {
        return floatToBlockchainInt(newParams.minToReceive, receivePrecision);
    }
    if (newParams.newPrice !== undefined && newParams.newPrice !== null) {
        const price = toFiniteNumber(newParams.newPrice);
        const receiveFloat = newParams.orderType === 'sell' ? sellFloat * price : sellFloat / price;
        return floatToBlockchainInt(receiveFloat, receivePrecision);
    }
    return Math.round((sellInt * priceRatioQuote) / priceRatioBase);
}

/**
 * Build a limit_order_update operation.
 * @param {string} accountName - The name of the account.
 * @param {string} orderId - The ID of the order to update.
 * @param {Object} newParams - The new parameters for the order.
 * @param {number} [newParams.amountToSell] - New amount to sell.
 * @param {number} [newParams.minToReceive] - New minimum amount to receive.
 * @param {number} [newParams.newPrice] - New price.
 * @param {string} [newParams.orderType] - Type of the order ('buy' or 'sell').
 * @param {string} [newParams.expiration] - New expiration date.
 * @param {Object} [cachedOrder=null] - Optional already-fetched raw chain order.
 * @returns {Promise<Object|null>} Operation object or null if no change.
 * @throws {Error} If account or order not found, or if amounts exceed limits.
 */
async function buildUpdateOrderOp(accountName: string | null | undefined, orderId: string, newParams: UpdateOrderParams, cachedOrder: ChainOrder | Record<string, unknown> | null = null) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    // A size-update's delta_amount_to_sell must be built from the AUTHORITATIVE
    // current for_sale, not the caller's cached rawOnChain snapshot. A cached
    // snapshot can be stale — the order may have been partially filled since it
    // was captured — and a delta computed from it over-reduces the order, which
    // the chain rejects ("Cannot deduct all or more from order than order
    // contains"). That rejection kills the whole COW batch and cascades into
    // uncertain-broadcast recovery. Re-read the exact for_sale right before
    // building so the delta matches chain reality. Price-only updates (no size
    // change) carry no delta_amount_to_sell, so staleness cannot over-deduct and
    // the cached order remains safe to use.
    const wantsSizeChange = newParams?.amountToSell !== undefined && newParams?.amountToSell !== null;
    let order: ChainOrder | null = null;
    if (cachedOrder && !wantsSizeChange) {
        order = cachedOrder as ChainOrder;
    } else {
        order = await readSingleOrder(orderId);
        if (!order) {
            const orders = await readOpenOrders(accId);
            order = orders.find((o) => o.id === orderId) ?? null;
        }
    }

    if (!order) throw new Error(`Order ${orderId} not found`);

    const sellAssetId = order.sell_price.base.asset_id;
    const receiveAssetId = order.sell_price.quote.asset_id;
    const sellPrecision = await _getAssetPrecision(sellAssetId);
    const receivePrecision = await _getAssetPrecision(receiveAssetId);

    const currentSellInt = toFiniteNumber(order.for_sale);

    const priceRatioBase = toFiniteNumber(order.sell_price.base.amount);
    const priceRatioQuote = toFiniteNumber(order.sell_price.quote.amount);
    const currentReceiveInt = Math.round((currentSellInt * priceRatioQuote) / priceRatioBase);
    // Determine target sell amount first.
    // IMPORTANT: When amountToSell is undefined, use currentSellInt directly to avoid
    // floating-point precision loss (blockchainToFloat -> floatToBlockchainInt roundtrip).
    let newSellInt;
    let newSellFloat;
    if (newParams.amountToSell !== undefined && newParams.amountToSell !== null) {
        newSellFloat = newParams.amountToSell;
         
         newSellInt = floatToBlockchainInt(newSellFloat, sellPrecision);
    } else {
        // Keep current amount exactly as-is on-chain, bypassing float conversion
        newSellInt = currentSellInt;
        newSellFloat = blockchainToFloat(currentSellInt, sellPrecision);
    }

    // Determine an initial receive amount for price-change detection.
    const candidateReceiveInt = computeOrderReceiveInt(
        newParams, receivePrecision, newSellInt, newSellFloat, priceRatioBase, priceRatioQuote,
    );

    // Validate amounts before converting to blockchain integers / computing deltas
    const candidateReceiveFloat = blockchainToFloat(candidateReceiveInt, receivePrecision);
    if (!validateOrderAmountsWithinLimits(newSellFloat, candidateReceiveFloat, sellPrecision, receivePrecision)) {
        throw new Error(
            `Cannot update order: calculated amounts exceed blockchain limits. ` +
            `Sell: ${newSellFloat}, Receive: ${candidateReceiveFloat}. ` +
            `This typically happens with extreme price values or mixed absolute/relative price bounds that diverge too far. ` +
            `Consider adjusting minPrice/maxPrice configuration.`
        );
    }

    // Calculate delta (new - current)
    // IMPORTANT: BitShares limit_order_update takes a delta for amount_to_sell
    // But for the new_price, it takes the NEW total amounts.
    let deltaSellInt = newSellInt - currentSellInt;

    // PRECISION FIX: If delta is ±1 and it's due to floating-point precision loss,
    // use the current amount to avoid unnecessary blockchain changes.
    // This happens when newAmountToSell was rounded, causing floatToBlockchainInt
    // to produce a different value than what's currently on-chain.
    if (Math.abs(deltaSellInt) === 1 && newParams.amountToSell !== undefined && newParams.amountToSell !== null) {
        const roundedNewSellInt = normalizeInt(newSellInt, sellPrecision);
        const roundedCurrentSellInt = normalizeInt(currentSellInt, sellPrecision);

        // If they match after rounding to precision, use the current amount (delta = 0)
        if (roundedNewSellInt === roundedCurrentSellInt || Math.abs(roundedNewSellInt - roundedCurrentSellInt) <= 1) {
            newSellInt = currentSellInt;
            deltaSellInt = 0;
        }
    }

    // First, compute the receive amount with the current delta (not adjusted yet)
    let newReceiveInt = computeOrderReceiveInt(
        newParams, receivePrecision, newSellInt, newSellFloat, priceRatioBase, priceRatioQuote,
    );

    // Check if price or amount is actually changing
    const priceChanged = newReceiveInt !== currentReceiveInt;
    const amountChanged = deltaSellInt !== 0;

    // Skip update if BOTH amount and price are unchanged. Sub-unit price
    // changes that round to the same minToReceive are treated as no-op — the
    // caller restores the affected slots from master and retries only when a
    // delta large enough to survive rounding occurs.
    if (!amountChanged && !priceChanged) {
        return null;
    }

    // Adjust newSellInt to strict logic: current + delta
    const adjustedSellInt = currentSellInt + deltaSellInt;

    // Recompute the final receive amount with the adjusted sell amount
    newReceiveInt = computeOrderReceiveInt(
        newParams, receivePrecision, adjustedSellInt, blockchainToFloat(adjustedSellInt, sellPrecision), priceRatioBase, priceRatioQuote,
    );

    const adjustedSellFloat = blockchainToFloat(adjustedSellInt, sellPrecision);

    const finalReceiveFloat = blockchainToFloat(newReceiveInt, receivePrecision);
    if (!validateOrderAmountsWithinLimits(adjustedSellFloat, finalReceiveFloat, sellPrecision, receivePrecision)) {
        throw new Error(
            `Cannot update order: calculated amounts exceed blockchain limits. ` +
            `Sell: ${adjustedSellFloat}, Receive: ${finalReceiveFloat}. ` +
            `Consider adjusting minPrice/maxPrice configuration.`
        );
    }

    return {
        op: {
            op_name: 'limit_order_update',
            op_data: {
                fee: { amount: 0, asset_id: NATIVE_CLIENT.CHAIN.CORE_ASSET_ID },
                seller: accId,
                order: orderId,
                new_price: {
                    base: {
                        amount: adjustedSellInt,
                        asset_id: sellAssetId
                    },
                    quote: {
                        amount: newReceiveInt,
                        asset_id: receiveAssetId
                    }
                },
                ...(deltaSellInt !== 0 ? { delta_amount_to_sell: { amount: deltaSellInt, asset_id: sellAssetId } } : {}),
                ...(newParams.expiration ? { new_expiration: newParams.expiration } : {})
            }
        },
        finalInts: { sell: adjustedSellInt, receive: newReceiveInt, sellAssetId, receiveAssetId }
    };
}

/**
 * Broadcast a prepared transaction through the direct-key client, classifying
 * failures with the same rules as the credential daemon
 * (modules/broadcast_failure.ts): an 'uncertain' outcome (RPC timeout,
 * connection dropped while the response was pending, unknown error) may have
 * landed, so it is re-thrown as a BroadcastUncertainError — the verify-
 * before-retry machinery (COW retry verification, startup adoption) then
 * checks chain inclusion before any re-broadcast. 'definite' rejections
 * (node assertion, insufficient balance) and provably-untransmitted
 * ('retryable') failures propagate as plain errors.
 * @param {Object} tx - The prepared signing-client transaction.
 * @param {string} accountName - Account the ops were intended for.
 * @param {Array} [operations=[]] - The ops carried by the transaction (for the error payload).
 * @returns {Promise<Object>} Broadcast result.
 * @throws {BroadcastUncertainError} When the outcome may have reached the chain.
 */
async function broadcastTxWithClassification(tx: BtsdexTx, accountName: string | null | undefined, operations: unknown[] = []): Promise<unknown> {
    try {
        return await tx.broadcast();
    } catch (err) {
        if (classifyBroadcastFailure(err) === 'uncertain') {
            throw new BroadcastUncertainError(
                `Direct-key broadcast uncertain for ${accountName}: ${getErrorMessage(err)}`,
                { operations: operations.length > 0 ? operations : null, accountName, timeoutMs: null }
            );
        }
        throw err;
    }
}

/**
 * Update an existing limit order on the blockchain.
 * @param {string} accountName - The name of the account.
 * @param {string|Object} privateKey - The private key for signing (or daemon signing token).
 * @param {string} orderId - The ID of the order to update.
 * @param {Object} newParams - The new parameters for the order.
 * @returns {Promise<Object|null>} Success object or null if skipped.
 * @throws {Error} If update fails.
 */
async function updateOrder(accountName: string | null | undefined, privateKey: unknown, orderId: string, newParams: UpdateOrderParams, extraOptions: Record<string, unknown> = {}) {
    try {
        const buildResult = await buildUpdateOrderOp(accountName, orderId, newParams);
        if (!buildResult) {
            chainOrdersLogger.info(`Delta is 0; skipping limit_order_update (no change to amount_to_sell)`);
            return null;
        }

        const { op } = buildResult;
        if (isDaemonSigningToken(privateKey)) {
            const result = await executeViaDaemonToken(accountName, privateKey, [op], extraOptions);
            chainOrdersLogger.info(`Order ${orderId} updated successfully`);
            return { success: true, orderId, raw: result.raw, operation_results: result.operation_results };
        }

        const acc = await createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();

        // Use explicit method call for robustness
        if (typeof tx.limit_order_update === 'function') {
            tx.limit_order_update(op.op_data);
        } else {
            throw new Error(`Transaction builder does not support limit_order_update`);
        }
        await broadcastTxWithClassification(tx, accountName, [op]);

        chainOrdersLogger.info(`Order ${orderId} updated successfully`);
        return { success: true, orderId };
    } catch (error) {
        chainOrdersLogger.error(`Error updating order: ${getErrorMessage(error)}`);
        throw error;
    }
}

/**
 * Build a limit_order_create operation.
 * @param {string} accountName - The name of the account.
 * @param {number} amountToSell - The amount of the asset to sell.
 * @param {string} sellAssetId - The ID of the asset to sell.
 * @param {number} minToReceive - The minimum amount of the asset to receive.
 * @param {string} receiveAssetId - The ID of the asset to receive.
 * @param {string} [expiration] - The expiration date for the order.
 * @returns {Promise<Object|null>} The operation object, or null if amounts would round to 0.
 * @throws {Error} If account not found.
 */
async function buildCreateOrderOp(accountName: string | null | undefined, amountToSell: number, sellAssetId: string, minToReceive: number, receiveAssetId: string, expiration: string | null | undefined) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    if (!expiration) {
        const now = new Date();
        now.setFullYear(now.getFullYear() + 1);
        expiration = now.toISOString().split('T')[0] + 'T23:59:59';
    }

    const sellPrecision = await _getAssetPrecision(sellAssetId);
    const receivePrecision = await _getAssetPrecision(receiveAssetId);
    const amountToSellInt = floatToBlockchainInt(amountToSell, sellPrecision);
    const minToReceiveInt = floatToBlockchainInt(minToReceive, receivePrecision);

    // CRITICAL: Validate order amounts before creating operation
    // This prevents "Assert Exception: min_to_receive.amount > 0" errors from BitShares
    // when order sizes are too small and round to 0 after precision conversion
    // Returns null instead of throwing to allow caller to skip invalid orders gracefully
    if (!validateOrderAmountsWithinLimits(amountToSell, minToReceive, sellPrecision, receivePrecision)) {
        chainOrdersLogger.warn(
            `Order skipped: amounts would round to 0 on blockchain\n` +
            `  Float values: sell=${amountToSell}, receive=${minToReceive}\n` +
            `  Blockchain integers: sell=${amountToSellInt} (prec ${sellPrecision}), receive=${minToReceiveInt} (prec ${receivePrecision})\n` +
            `  Required: both > 0`
        );
        return null;
    }

    const op = {
        op_name: 'limit_order_create',
        op_data: {
            fee: { amount: 0, asset_id: NATIVE_CLIENT.CHAIN.CORE_ASSET_ID },
            seller: accId,
            amount_to_sell: { amount: amountToSellInt, asset_id: sellAssetId },
            min_to_receive: { amount: minToReceiveInt, asset_id: receiveAssetId },
            expiration: expiration,
            fill_or_kill: false,
            extensions: []
        }
    };
    return {
        op,
        finalInts: { sell: amountToSellInt, receive: minToReceiveInt, sellAssetId, receiveAssetId }
    };
}

/**
 * Create a new limit order on the blockchain.
 * @param {string} accountName - The name of the account.
 * @param {string|Object} privateKey - The private key for signing (or daemon signing token).
 * @param {number} amountToSell - The amount of the asset to sell.
 * @param {string} sellAssetId - The ID of the asset to sell.
 * @param {number} minToReceive - The minimum amount of the asset to receive.
 * @param {string} receiveAssetId - The ID of the asset to receive.
 * @param {string} [expiration] - The expiration date for the order.
 * @param {boolean} [dryRun=false] - Whether to simulate the operation.
 * @returns {Promise<Object>} The transaction result or dry run info.
 * @throws {Error} If account not found or creation fails.
 */
async function createOrder(accountName: string | null | undefined, privateKey: unknown, amountToSell: number, sellAssetId: string, minToReceive: number, receiveAssetId: string, expiration: string | null | undefined, dryRun: boolean = false, extraOptions: Record<string, unknown> = {}) {
    try {
        const buildResult = await buildCreateOrderOp(accountName, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration);
        if (!buildResult) return { skipped: true };
        const { op } = buildResult;

        if (dryRun) {
            chainOrdersLogger.info(`Dry run: Limit order prepared for account ${accountName} (not broadcasted)`);
            return { dryRun: true, params: op.op_data };
        }

        if (isDaemonSigningToken(privateKey)) {
            const result = await executeViaDaemonToken(accountName, privateKey, [op], extraOptions);
            chainOrdersLogger.info(`Limit order created successfully for account ${accountName}`);
            return result;
        }

        const acc = await createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();
        // Invoke standard method directly
        tx.limit_order_create(op.op_data);
        const result = await broadcastTxWithClassification(tx, accountName, [op]);
        chainOrdersLogger.info(`Limit order created successfully for account ${accountName}`);
        return result;
    } catch (error) {
        chainOrdersLogger.error(`Error creating limit order: ${getErrorMessage(error)}`);
        throw error;
    }
}

/**
 * Build a limit_order_cancel operation.
 * @param {string} accountName - The name of the account.
 * @param {string} orderId - The ID of the order to cancel.
 * @returns {Promise<Object>} The operation object.
 * @throws {Error} If account not found.
 */
async function buildCancelOrderOp(accountName: string | null | undefined, orderId: string) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    return {
        op_name: 'limit_order_cancel',
        op_data: {
            fee: { amount: 0, asset_id: NATIVE_CLIENT.CHAIN.CORE_ASSET_ID },
            fee_paying_account: accId,
            order: orderId
        }
    };
}

/**
 * Cancel an existing limit order on the blockchain.
 * @param {string} accountName - The name of the account.
 * @param {string|Object} privateKey - The private key for signing (or daemon signing token).
 * @param {string} orderId - The ID of the order to cancel.
 * @param {Object} [extraOptions] - Optional overrides.
 * @param {string} [extraOptions.nodeUrl] - Specific BitShares node URL for the broadcast.
 *   Only effective when using a daemon signing token (the createAccountClient
 *   fallback path ignores this field).
 * @returns {Promise<Object>} Success object with order ID and verification metadata.
 * @throws {Error} If cancellation fails.
 */
async function cancelOrder(accountName: string | null | undefined, privateKey: unknown, orderId: string, extraOptions: Record<string, unknown> = {}) {
    let accountId: string | null = null;
    try {
        const op = await buildCancelOrderOp(accountName, orderId);
        accountId = op.op_data.fee_paying_account;

        if (isDaemonSigningToken(privateKey)) {
            const result = await executeViaDaemonToken(accountName, privateKey, [op], extraOptions);
            recordOwnCancel(orderId);
            chainOrdersLogger.info(`Order ${orderId} cancelled successfully`);
            return { success: true, orderId, verified: true, raw: result.raw, operation_results: result.operation_results };
        }

        const acc = await createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();
        // Explicit call
        tx.limit_order_cancel(op.op_data);
        await broadcastTxWithClassification(tx, accountName, [op]);

        recordOwnCancel(orderId);
        chainOrdersLogger.info(`Order ${orderId} cancelled successfully`);
        return { success: true, orderId, verified: true };
    } catch (error) {
        if (accountId) {
            try {
                const { orders: openOrders, truncated } = await readOpenOrdersWithMeta(accountId, TIMING.CONNECTION_TIMEOUT_MS, true);
                // Only a NON-EMPTY, NON-TRUNCATED read is authoritative: the
                // order being absent from a live account snapshot confirms the
                // cancellation landed. An empty read is ambiguous (the node may
                // be lagging behind the broadcast) — treating it as confirmed
                // would free the slot and its capital while the order may still
                // be live on chain. A truncated read (get_full_accounts caps
                // the limit_orders window; fresh orders sort last and are the
                // first entries omitted) may omit the order without it being
                // cancelled, so absence is not authoritative there either.
                const stillPresent = Array.isArray(openOrders) && openOrders.some((order) => String(order?.id ?? '') === String(orderId));
                let confirmedAbsent = !stillPresent && !truncated && Array.isArray(openOrders) && openOrders.length > 0;
                if (!confirmedAbsent && !truncated && !stillPresent && Array.isArray(openOrders) && openOrders.length === 0) {
                    // An EMPTY account snapshot is ambiguous by itself (the node
                    // may be lagging behind the broadcast), but a direct
                    // get_objects probe of the order id is authoritative: the
                    // object store returns null for ids that no longer exist.
                    // This resolves the genuinely-empty account case (the
                    // cancelled order was the account's only order) without
                    // trusting a lagging node's empty window.
                    try {
                        const probe = await readSingleOrder(String(orderId), TIMING.CONNECTION_TIMEOUT_MS);
                        if (probe === null) confirmedAbsent = true;
                    } catch (_) {
                        // Probe failed — the snapshot remains ambiguous; fall
                        // through to the original error.
                    }
                }
                if (confirmedAbsent) {
                    // The cancellation is confirmed landed (authoritative
                    // non-empty, non-truncated read — or a direct object probe —
                    // shows the order gone) — arm the own-cancel marker exactly
                    // like the success paths above, or a later fill artifact for
                    // this order would not be skipped
                    // (dexbot_fill_runtime.ts wasRecentlyOwnCancelled).
                    recordOwnCancel(orderId);
                    chainOrdersLogger.info(`Order ${orderId} cancellation confirmed after broadcast failure`);
                    return { success: true, orderId, verified: true, verifiedAfterFailure: true };
                }
            } catch (_) {
                // Fall through to the original error.
            }
        }
        chainOrdersLogger.error(`Error cancelling order: ${getErrorMessage(error)}`);
        throw error;
    }
}

/**
 * Detect limit_order_update ops whose negative delta would over-reduce the
 * order's current on-chain for_sale (new size < 0). Returns an Error whose
 * message matches the chain's "Cannot deduct all or more from order than order
 * contains" rejection so callers route it through the size-drift repair path.
 * Returns null when no update op over-reduces. Throws only on read failure.
 *
 * A negative-delta op targeting an order that is no longer on chain ("gone")
 * is reported with the chain's stale-order message ("object <id> does not
 * exist") instead, so callers route it to stale-order cleanup — a gone order
 * has no for_sale to re-size, so the size-drift repair path would be a no-op.
 *
 * @param {Array} operations - Ops to verify (limit_order_update only).
 * @returns {Promise<Error|null>}
 */
async function findOverReducingUpdateOpError(operations: unknown): Promise<Error | null> {
    // Aggregate negative deltas per order: the chain applies a batch's update
    // ops sequentially, so a second reduction of the same order is validated
    // against the already-decremented for_sale, not the pre-batch value.
    // Checking each op independently against the original for_sale would miss
    // a cumulative over-reduction that the chain still rejects.
    //
    // Also validate the chain's new_price assertion for EVERY update op (not
    // only reductions): limit_order_update_evaluator requires
    //   new_price.base.amount <= max(for_sale, sell_price.base.amount) + delta
    // An update built from a stale for_sale read (a size-reducing update landed
    // between build and broadcast) otherwise aborts the whole chunk after the
    // earlier chunks have already landed. Both checks use one fresh chain read.
    const orderDeltas = new Map<string, number>();
    const updateOpsByOrder = new Map<string, OperationLike[]>();
    for (const op of (operations as OperationLike[]) || []) {
        if (op?.op_name !== 'limit_order_update') continue;
        const orderKey = String(op.op_data?.order);
        const deltaData = op.op_data?.delta_amount_to_sell as { amount?: unknown } | undefined;
        const delta = toFiniteNumber(deltaData?.amount);
        if (delta < 0) {
            orderDeltas.set(orderKey, (orderDeltas.get(orderKey) || 0) + delta);
        }
        const ops = updateOpsByOrder.get(orderKey) || [];
        ops.push(op);
        updateOpsByOrder.set(orderKey, ops);
    }
    if (updateOpsByOrder.size === 0) return null;

    const orderMap = await batchReadOrders([...updateOpsByOrder.keys()], TIMING.CONNECTION_TIMEOUT_MS);
    for (const [orderId, ops] of updateOpsByOrder) {
        const chainOrder = orderMap.get(orderId);
        const allDelta = ops.reduce((sum, op) => {
            const d = op.op_data?.delta_amount_to_sell as { amount?: unknown } | undefined;
            return sum + toFiniteNumber(d?.amount);
        }, 0);
        if (!chainOrder) {
            return new Error(
                `object ${orderId} does not exist: ` +
                `limit_order_update delta=${allDelta} targets an order missing on chain ` +
                `(detected pre-broadcast size-drift)`
            );
        }
        const currentForSale = toFiniteNumber(chainOrder.for_sale);
        const totalDelta = orderDeltas.get(orderId) || 0;
        if (currentForSale + totalDelta <= 0) {
            return new Error(
                `Cannot deduct all or more from order than order contains: ` +
                `order ${orderId} current for_sale=${currentForSale} ` +
                `delta=${totalDelta} (detected pre-broadcast size-drift)`
            );
        }

        // Mirror the chain evaluator sequentially: each op is validated against
        // the state left by the previous op in the same batch, then applies
        // (sell_price.base <- new_price.base, for_sale += delta).
        let simForSale = currentForSale;
        let simBase = toFiniteNumber(chainOrder.sell_price?.base?.amount);
        for (const op of ops) {
            const deltaData = op.op_data?.delta_amount_to_sell as { amount?: unknown } | undefined;
            const delta = toFiniteNumber(deltaData?.amount);
            const priceData = op.op_data?.new_price as { base?: { amount?: unknown } } | undefined;
            const newBase = Number(priceData?.base?.amount);
            if (Number.isFinite(newBase)) {
                const maxForSale = Math.max(simForSale, simBase) + delta;
                if (newBase > maxForSale) {
                    return new Error(
                        `Cannot set new_price.base above max_amount_for_sale: ` +
                        `order ${orderId} new_price.base=${newBase} > ` +
                        `max(for_sale=${simForSale}, sell_price.base=${simBase}) + delta=${delta} ` +
                        `(detected pre-broadcast size-drift)`
                    );
                }
                simBase = newBase;
            }
            simForSale += delta;
        }
    }
    return null;
}

/**
 * Execute a batch of operations in a single transaction.
 * @param {string} accountName - Account paying fees (usually the bot account)
 * @param {string|Object} privateKey - Private key for signing (or daemon signing token)
 * @param {Array} operations - Array of operation objects { op_name, op_data } returned by build helpers
 * @param {Object} [extraOptions] - Optional parameters (nodeUrl, onNodeFailed, etc.)
 * @returns {Promise<Object>} Transaction result
 */
async function executeBatch(accountName: string | null | undefined, privateKey: unknown, operations: OperationLike[], extraOptions: Record<string, unknown> = {}) {
    if (!operations || operations.length === 0) return { success: true, operations: 0 };

    // Pre-broadcast size-drift guard: a limit_order_update's negative delta is
    // built from the order's for_sale read during planning. If the order was
    // partially consumed between that read and this broadcast, the delta
    // over-reduces and the chain rejects the ENTIRE batch ("Cannot deduct all
    // or more from order than order contains"), which cascades into
    // uncertain-broadcast recovery. Re-read the affected orders right before
    // broadcasting and abort pre-broadcast with a size-drift error so the
    // caller's repair path (recoverBatchSizeDrift) re-reads the chain and
    // resizes the affected slots. Best-effort: a failed pre-read proceeds with
    // the broadcast — the chain's own rejection then routes to the same repair.
    let driftError: Error | null = null;
    try {
        driftError = await findOverReducingUpdateOpError(operations);
    } catch (preReadErr) {
        chainOrdersLogger.debug(
            `executeBatch: pre-broadcast size-drift read failed (proceeding with broadcast): ${getErrorMessage(preReadErr)}`
        );
    }
    if (driftError) throw driftError;

    try {
        if (isDaemonSigningToken(privateKey)) {
            const result = await executeViaDaemonToken(accountName, privateKey, operations, extraOptions);
            recordOwnCancelOps(operations);
            return result;
        }

        const acc = await createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();

        for (const op of operations) {
            const opName = op.op_name ?? '';
            const txMethod = tx[opName];
            if (typeof txMethod === 'function') {
                (txMethod as (data: unknown) => unknown)(op.op_data);
            } else {
                chainOrdersLogger.warn(`Transaction builder missing method for ${opName}`);
                throw new Error(`Transaction builder does not support ${opName}`);
            }
        }

        const result = await broadcastTxWithClassification(tx, accountName, operations);

        // Record own-cancel correlation for the self-cancel guard in the fill
        // consumer. Without this, batched cancels (the dominant COW path) would
        // skip the ring buffer and the guard would not recognize their
        // propagation artifacts as non-economic. Only fires after a successful
        // broadcast so failed batches never poison the buffer.
        recordOwnCancelOps(operations);

        // Normalize broadcast response shape across node variants.
        const reply = result as { operation_results?: unknown[]; trx?: { operation_results?: unknown[] } } | null | undefined;
        const operationResults =
            (reply && !Array.isArray(reply) && Array.isArray(reply.operation_results) && reply.operation_results.length > 0 && reply.operation_results) ||
            (reply && !Array.isArray(reply) && reply.trx && Array.isArray(reply.trx.operation_results) && reply.trx.operation_results.length > 0 && reply.trx.operation_results) ||
            (Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results.length > 0 && result[0].trx.operation_results) ||
            [];

        return {
            success: true,
            raw: result,
            operation_results: operationResults
        };
    } catch (error) {
        const msg = getErrorMessage(error);
        // Simulated / intentional negative-path failures (contain "simulated" or
        // the credential-daemon uncertain marker BROADCAST_DEADLINE) are expected
        // in tests. Downgrade to warn so intentional fixtures don't hide real
        // fund-invariant CRITICALs in the ERROR diagnostics.
        if (msg.includes('simulated') || msg.includes('Simulated') || msg.includes('Credential daemon broadcast uncertain') || msg.includes('BROADCAST_DEADLINE')) {
            chainOrdersLogger.warn(`Error executing batch transaction: ${msg}`);
        } else {
            chainOrdersLogger.error(`Error executing batch transaction: ${msg}`);
        }
        throw error;
    }
}

/**
 * Fetch on-chain balances and locked amounts for the specified account and assets.
 * This helper only reads on-chain balances and open-order locks and MUST NOT be
 * mixed with the manager's internal "available for orders" calculations.
 *
 * @param {String} accountRef - account name or id
 * @param {Array<String>} assets - array of asset ids or symbols to query (e.g. ['1.3.0','IOB.XRP'])
 * @param {Object} [options] - Optional parameters
 * @param {boolean} [options.includeCreditDeals=false] - When true, also query credit
 *        deal collateral and subtract it from free balances for each asset.
 * @returns {Object} mapping assetRef -> { assetId, symbol, precision, freeRaw, lockedRaw, free, locked, total }
 */
async function getOnChainAssetBalances(accountRef: unknown, assets: unknown, options: Record<string, unknown> = {}) {
    if (!accountRef) return {};
    try {
        await waitForConnected();
        const needsResolve = typeof accountRef === 'string' && !/^1\.2\./.test(accountRef);
        const full = await BitShares.db.get_full_accounts([accountRef], false);
        if (!Array.isArray(full) || !full[0] || !full[0][1]) return {};
        const accountData = full[0][1] || {};
        const accountId = needsResolve ? (accountData.account?.id || accountRef) : accountRef;
        const balances = accountData.balances || [];
        const limitOrders = accountData.limit_orders || [];

        // Build free balances map by asset id
        const freeInt = new Map();
        for (const b of balances) {
            const aid = String(b.asset_type || b.asset_id || b.asset);
            const val = toFiniteNumber(b.balance || b.amount);
            freeInt.set(aid, (freeInt.get(aid) || 0) + val);
        }

        // Build locked map (for_sale) grouped by base asset id
        const lockedInt = new Map();
        for (const o of limitOrders) {
            if (!o || !o.sell_price || !o.sell_price.base) continue;
            const baseId = String(o.sell_price.base.asset_id);
            const forSale = toFiniteNumber(o.for_sale);
            lockedInt.set(baseId, (lockedInt.get(baseId) || 0) + forSale);
        }

        // When includeCreditDeals is set, also subtract unvested credit deal
        // collateral from the free balance. The order manager otherwise sees an
        // inflated free balance on accounts that also run credit bots.
        if (options?.includeCreditDeals) {
            try {
                const deals = await BitShares.db.get_credit_deals_by_borrower([accountId]).catch(() => []);
                if (Array.isArray(deals) && deals.length > 0) {
                    for (const deal of deals) {
                        if (!deal) continue;
                        const collateralAssetId = String(deal.collateralAssetId || deal.collateral_asset || '');
                        if (!collateralAssetId) continue;
                        const collateralRaw = toFiniteNumber(deal.collateralAmount ?? deal.collateral_amount, 0);
                        if (collateralRaw <= 0) continue;
                        // Subtract collateral from free (it's not spendable by limit orders)
                        // The credit runtime accounts for this as committed credit collateral.
                        freeInt.set(collateralAssetId, Math.max(0, (freeInt.get(collateralAssetId) || 0) - collateralRaw));
                    }
                }
            } catch (dealErr) {
                chainOrdersLogger.warn(`getOnChainAssetBalances: failed to fetch credit deals for ${accountRef}: ${getErrorMessage(dealErr)}`);
            }
        }

        // If assets omitted, build list from balances and limit_orders
        let assetList: unknown[] = Array.isArray(assets) ? assets : [];
        if (assetList.length === 0) {
            assetList = [];
            for (const b of balances) assetList.push(String(b.asset_type || b.asset_id || b.asset));
            for (const o of limitOrders) {
                if (!o || !o.sell_price || !o.sell_price.base) continue;
                assetList.push(String(o.sell_price.base.asset_id));
            }
            // de-duplicate
            assetList = Array.from(new Set(assetList));
        }

        const out: Record<string, { assetId: string; symbol: string; precision: number; freeRaw: number; lockedRaw: number; free: number; locked: number; total: number }> = {};
        for (const a of assetList) {
            // resolve asset id and precision
            let aid: string = String(a);
            try {
                if (!/^1\.3\./.test(String(a))) {
                    // symbol -> asset
                    const res = await BitShares.db.lookup_asset_symbols([normalizeAssetRef(a)]).catch(() => null) as Array<{ id?: string }> | null;
                    if (res && res[0] && res[0].id) aid = res[0].id;
                }
            } catch (e) {
                chainOrdersLogger.warn(`lookup_asset_symbols failed for ${a}: ${getErrorMessage(e)}`);
            }

            // try to get precision and symbol
            let precision = null; let symbol = String(a);
            try {
                const am = await BitShares.db.get_assets([aid]).catch(() => null);
                if (Array.isArray(am) && am[0]) {
                    precision = typeof am[0].precision === 'number' ? am[0].precision : null;
                    symbol = am[0].symbol || symbol;
                }
            } catch (e) { 
                chainOrdersLogger.warn(`Failed to fetch asset data for ${aid}: ${getErrorMessage(e)}`);
            }

            if (precision === null) {
                chainOrdersLogger.error(`CRITICAL: Could not determine precision for asset ${aid}. Skipping balance entry to prevent massive scaling errors.`);
                continue;
            }

            const freeRaw = freeInt.get(String(aid)) || 0;
            const lockedRaw = lockedInt.get(String(aid)) || 0;
            const free = blockchainToFloat(freeRaw, precision);
            const locked = blockchainToFloat(lockedRaw, precision);
            out[String(a)] = { assetId: String(aid), symbol, precision, freeRaw, lockedRaw, free, locked, total: free + locked };
        }

        return out;
    } catch (err) {
        chainOrdersLogger.error(`getOnChainAssetBalances failed: ${getErrorMessage(err)}`);
        return {};
    }
}

/**
 * Build a liquidity_pool_exchange operation for swapping assets via AMM pool.
 * @param {string} accountId - The blockchain account ID (1.2.x)
 * @param {string} poolId - The liquidity pool ID (1.19.x)
 * @param {number} sellAmountInt - Amount to sell (blockchain integer, not float)
 * @param {string} sellAssetId - Asset ID to sell
 * @param {number} minReceiveInt - Minimum amount to receive (blockchain integer)
 * @param {string} receiveAssetId - Asset ID to receive
 * @returns {Object} The operation object with op_name and op_data
 */
function buildLiquidityPoolExchangeOp(accountId: string | null | undefined, poolId: string, sellAmountInt: number, sellAssetId: string, minReceiveInt: number, receiveAssetId: string) {
    return {
        op_name: 'liquidity_pool_exchange',
        op_data: {
            fee: { amount: 0, asset_id: NATIVE_CLIENT.CHAIN.CORE_ASSET_ID },
            account: accountId,
            pool: poolId,
            amount_to_sell: { amount: sellAmountInt, asset_id: sellAssetId },
            min_to_receive: { amount: minReceiveInt, asset_id: receiveAssetId },
            extensions: []
        }
    };
}

/**
 * Get the current fill processing mode.
 * @returns {string} 'history' or 'open'
 */
function getFillProcessingMode() {
    return FILL_PROCESSING_MODE;
}
export { selectAccount, setPreferredAccount, resolveAccountId, resolveAccountName, readOpenOrders, readOpenOrdersWithMeta, readOpenOrdersWithMetaSafe, readOpenOrdersGuarded, readSingleOrder, batchReadOrders, listenForFills, updateOrder, createOrder, cancelOrder, getOnChainAssetBalances, getFillProcessingMode, buildUpdateOrderOp, buildCreateOrderOp, buildCancelOrderOp, buildLiquidityPoolExchangeOp, executeBatch, findOverReducingUpdateOpError, wasRecentlyOwnCancelled, recordOwnCancel, BroadcastUncertainError, broadcastTxWithClassification }

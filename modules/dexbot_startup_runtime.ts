/** Startup runtime - bot initialization, grid placement, and startup sequence */
import { lazyShim } from './lazy_shim.js';

import { path } from './path_api.js';
import * as chainOrders from './chain_orders.js';
import { readOpenOrdersGuarded } from './chain_orders.js';
import { ORDER_STATES, TIMING } from './constants.js';
import { Config } from './config.js';
import { PATHS } from './paths.js';
import { getStorage } from './storage/index.js';
import { normalizeBotEntry } from './bot_settings.js';
import type { BotEntry } from './bot_settings.js';
import * as Format from './order/format.js';
import { AccountOrders } from './account_orders.js';
import { BitShares, onReconnect as registerReconnectHook } from './bitshares_client.js';
import orderModule from './order/index.js';
import { getErrorMessage } from './utils/errors.js';
import type { BotLike, ManagedOrder } from './types.js';
import { processSweepOrphanFill } from './dexbot_fill_runtime.js';
import { restoreLastMarketFill } from './order/utils/system.js';
import {
    ON_MISSING_GENESIS,
    recordMissingGenesisFault,
    resolvePersistedGenesis
} from './order/genesis_policy.js';
const { OrderManager, grid: Grid } = orderModule;
const initializeFeeCache = lazyShim('./order/utils/system', 'initializeFeeCache');
const parseJsonWithComments = lazyShim('./order/utils/system', 'parseJsonWithComments');
const withBlockchainRetry = lazyShim('./order/utils/system', 'withBlockchainRetry');
const buildFillKey = lazyShim('./order/utils/order', 'buildFillKey');
const correctAllPriceMismatches = lazyShim('./order/utils/order', 'correctAllPriceMismatches');
const parseChainOrder = lazyShim('./order/utils/order', 'parseChainOrder');
const restoreGapEvacStreaks = lazyShim('./order/utils/system', 'restoreGapEvacStreaks');
const applyPersistedPendingCrawls = lazyShim('./order/utils/system', 'applyPersistedPendingCrawls');
const startupSleep = lazyShim('./order/utils/system', 'sleep');
const storage = getStorage();
const attemptResumePersistedGridByPriceMatch = lazyShim('./order/grid_reconcile', 'attemptResumePersistedGridByPriceMatch');
const decideStartupGridAction = lazyShim('./order/grid_reconcile', 'decideStartupGridAction');
const reconcileGridOrders = lazyShim('./order/grid_reconcile', 'reconcileGridOrders');
function botRetryLogger(bot: BotLike): { log: (msg: string) => void } {
    return { log: (msg: string) => bot._log(msg) };
}

// Test seams: compiled ESM exports cannot be monkey-patched, so tests may
// substitute grid/reconcile modules and chain reads at the bot level.
interface GridModuleLike {
    initializeGrid(manager: unknown): Promise<void>;
    loadGrid(...args: unknown[]): Promise<unknown>;
}
interface GridReconcileModuleLike {
    decideStartupGridAction(...args: unknown[]): Promise<{ shouldRegenerate: boolean; [key: string]: unknown }>;
    attemptResumePersistedGridByPriceMatch(...args: unknown[]): unknown;
    reconcileGridOrders(...args: unknown[]): Promise<unknown>;
}
function botGridModule(bot: BotLike): GridModuleLike {
    return (bot._gridModule && typeof bot._gridModule === 'object') ? bot._gridModule as GridModuleLike : Grid;
}
function botReconcileModule(bot: BotLike): GridReconcileModuleLike {
    return (bot._gridReconcileModule && typeof bot._gridReconcileModule === 'object')
        ? bot._gridReconcileModule as GridReconcileModuleLike
        : { attemptResumePersistedGridByPriceMatch, decideStartupGridAction, reconcileGridOrders };
}
async function botGuardedOpenOrdersRead(bot: BotLike, opts: Record<string, unknown>): Promise<unknown[] | null> {
    if (typeof bot._readOpenOrdersHook === 'function') return await bot._readOpenOrdersHook() as unknown[] | null;
    return await readOpenOrdersGuarded(chainOrders, bot.accountId, opts);
}
const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

/**
 * Initialize the startup state: account orders, manager, persisted data.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Promise<Object>} startupState
 */
async function initializeStartupState(bot: BotLike) {
    bot.accountOrders = new AccountOrders({ botKey: bot.config.botKey ?? '' });
    bot._processedFillStore.configure({
        accountOrders: bot.accountOrders
    });

    const loadedPersistedFills = bot._processedFillStore.loadPersisted({
        minTimestamp: Date.now() - bot._fillRecordRetentionMs
    });
    if (loadedPersistedFills > 0) {
        bot._log(`Loaded ${loadedPersistedFills} persisted fill records to prevent reprocessing`);
    }

    const raw = storage.readFile(PROFILES_BOTS_FILE);
    const allBotsConfig = parseJsonWithComments(raw).bots || [];
    const myBotConfig = allBotsConfig
        .map((b: BotEntry, originalIdx: number) => b.active !== false ? normalizeBotEntry(b, originalIdx) : null)
        .find((b: BotEntry | null) => b && b.botKey === bot.config.botKey);

    if (myBotConfig) {
        await bot.accountOrders.syncMeta(myBotConfig);
    }

    if (!bot.manager) {
        const mgrLogFile = bot.config?.name ? path.join(PATHS.LOGS_DIR, `${bot.config.name}.log`) : undefined;
        bot.manager = new OrderManager({ ...bot.config, logFile: mgrLogFile });
        bot.manager.account = bot.account;
        bot.manager.accountId = bot.accountId;
        bot.manager.accountOrders = bot.accountOrders;
    }
    bot._wireStructuralGridResyncRequest();
    bot._wireBroadcastRegionEndDrain();
    bot._wireProcessedFillTracking();
    // No startBootstrap() here: the OrderManager constructor already enters
    // bootstrap mode (_bootstrapping = 1), and this extra level permanently
    // unbalanced the trigger-reset startup path. The normal grid-init flow
    // unwinds two levels (interior finish + finally) and happened to absorb
    // it, but the trigger-reset path has only ONE finishBootstrap — so after
    // a pending-trigger reset the refcount stayed at 1 forever: every fill
    // was routed through the bootstrap consumer (which skips dust detection
    // and post-fill grid maintenance) and checkGridHealth no-op'd on the
    // same stuck flag, leaving dust remnants uncancellable.

    try {
        if (bot.accountId && bot.config.assetA && bot.config.assetB) {
            await bot.manager._initializeAssets();
            await bot.manager.fetchAccountTotals(bot.accountId);
            bot._log('Fetched blockchain account balances at startup');
        }
    } catch (err) {
        bot._log(`Startup balance fetch FAILED: ${getErrorMessage(err)}. Order sizing may be incorrect until next successful sync.`, 'error');
    }

    try {
        await initializeFeeCache([bot.config || {}], BitShares);
    } catch (err) {
        bot._log(`Fee cache initialization FAILED: ${getErrorMessage(err)}. Fee calculations will use defaults until cache is refreshed.`, 'error');
    }

    const persistedGrid = bot.accountOrders.loadGrid();

    let repairedGrid = persistedGrid;
    if (persistedGrid && persistedGrid.length > 0) {
        let repairCount = 0;
        repairedGrid = persistedGrid.map((order: unknown) => {
            const ord = order as ManagedOrder;
            if (ord && ord.orderId && ord.orderId === ord.id) {
                repairCount++;
                const repairedOrder = { ...ord, orderId: '' };
                if (repairedOrder.state === ORDER_STATES.ACTIVE || repairedOrder.state === ORDER_STATES.PARTIAL) {
                    repairedOrder.state = ORDER_STATES.VIRTUAL;
                }
                return repairedOrder;
            }
            return ord;
        });
        if (repairCount > 0) {
            bot._log(`[REPAIR] Stripped ${repairCount} fake orderId(s) from persisted grid to restore rebalancing logic.`);
        }
    }

    const persistedBtsFeesOwed = bot.accountOrders.loadBtsFeesOwed();
    const persistedBoundaryIdx = bot.accountOrders.loadBoundaryIdx();
    const persistedBtsBalance = bot.accountOrders.loadBtsBalance();
    const persistedRecentFillKeys = bot.accountOrders.loadRecentFillKeys();
    const persistedGenesis = bot.accountOrders.loadGenesis?.() ?? null;
    const persistedGapEvacStreaks = bot.accountOrders.loadGapEvacStreaks?.() ?? null;

    return {
        persistedGrid: repairedGrid,
        persistedBtsFeesOwed,
        persistedBoundaryIdx,
        persistedBtsBalance,
        persistedRecentFillKeys,
        persistedGenesis,
        persistedGapEvacStreaks,
    };
}

/**
 * E3 startup gate: decide whether the persisted grid can be resumed at all.
 *
 * A snapshot with orders but no usable price ladder is refused (the same
 * `resolvePersistedGenesis` verdict `loadGrid` enforces, so the two cannot
 * drift) and the configured policy decides what happens next:
 *   'rebuild' (default) -> return `{ needsRebuild: true }`; the caller takes
 *       the regeneration branch, where `initializeGrid` re-derives prices
 *       (resolving mode strings such as "pool") and builds a fresh ladder
 *       before the first sync. Live orders are reconciled update-first, so
 *       only true surplus is cancelled.
 *   'halt' -> throw the fault; the startup sequence's catch logs it, shuts the
 *       bot down and rethrows. Nothing is cancelled without an operator.
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {unknown[]} persistedGrid - Persisted grid array (non-empty).
 * @param {unknown} persistedGenesis - Persisted ladder row (may be null).
 * @returns {{needsRebuild: boolean}}
 */
function evaluateStartupGenesisGate(bot: BotLike, persistedGrid: unknown, persistedGenesis: unknown): { needsRebuild: boolean } {
    const config = bot.manager?.config || bot.config;
    const resolution = resolvePersistedGenesis({
        config,
        grid: persistedGrid,
        genesisInput: persistedGenesis,
        log: (msg: string, level?: string) => bot._log(msg, level)
    });
    if (resolution.ok) return { needsRebuild: false };

    // Records the fault on the manager (so the E2 sync-entry assert and any
    // later read can name the reason) and logs the policy-specific guidance.
    const fault = recordMissingGenesisFault(bot.manager, { ...resolution });
    if (fault.policy === ON_MISSING_GENESIS.HALT) {
        throw fault;
    }
    bot._log(
        `[GENESIS] Persisted grid cannot be resumed without a price ladder — regenerating the grid from live ` +
        `config (missing-genesis policy='${fault.policy}'); the rebuild re-derives prices ` +
        `and reconciles against the live book update-first`,
        'warn'
    );
    return { needsRebuild: true };
}

/**
 * Wire up the post-bootstrap subsystem intervals and run the startup dust
 * health check. Shared by every startup path so the subsystem list stays in
 * lockstep (add a subsystem once). finishBootstrap() is intentionally left to
 * each caller — the bootstrap/try-finally ordering differs per path.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
async function startPostBootstrapSubsystems(bot: BotLike): Promise<void> {
    await bot._setupTriggerFileDetection();
    await bot._setupCreditRuntime();
    await bot._refreshAndSyncCreditRuntime();
    await bot._runCreditRuntimeMaintenance('startup');
    bot._setupBlockchainFetchInterval();
    if (typeof bot._setupBotsConfigPollInterval === 'function') bot._setupBotsConfigPollInterval();
    bot._setupCreditWatchdogInterval();
    bot._setupCredentialDaemonWatchdogInterval();
    bot._setupDustHealthCheckInterval();
    await bot._runDustHealthCheck();
    bot._log('[DUST] Startup health check complete');
}

/**
 * Finish the startup sequence: activate fill listener, reconcile grid, place initial orders.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} startupState
 */
async function finishStartupSequence(bot: BotLike, startupState: Awaited<ReturnType<typeof initializeStartupState>>) {
    let {
        persistedGrid,
        persistedBtsFeesOwed,
        persistedBoundaryIdx,
        persistedBtsBalance,
        persistedRecentFillKeys,
        persistedGenesis,
        persistedGapEvacStreaks,
    } = startupState;

    try {
        // Bot-scoped last-market-fill reference: restore BEFORE any chain
        // touching/placement work so spread correction (including the
        // post-reset path below) always has the last real trade price it must
        // not cross. Independent of the boundary/genesis restore, so a
        // regenerated grid still gets the anchor the genesis-bound pivot lost.
        try {
            restoreLastMarketFill(
                bot.manager,
                bot.manager?.accountOrders?.loadLastMarketFill?.() ?? null
            );
        } catch (marketRefErr) {
            bot._warn(`[SPREAD-CORRECTION] Last-market-fill restore failed (${getErrorMessage(marketRefErr)}); spread correction runs without a market anchor`);
        }
        if (typeof bot._fillsUnsubscribe === 'function') {
            await bot._fillsUnsubscribe().catch(() => { });
        }
        bot._fillsUnsubscribe = (typeof bot._listenForFillsHook === 'function')
            ? await bot._listenForFillsHook() as (() => Promise<unknown>) | null
            : await chainOrders.listenForFills(bot.account || undefined, bot._createFillCallback(chainOrders)) as (() => Promise<unknown>) | null;
        if (typeof bot._fillsUnsubscribe !== 'function') {
            bot._warn('Fill listener did not provide an unsubscribe handler. Shutdown cleanup may be incomplete.');
            bot._fillsUnsubscribe = null;
        }
        bot._log('Fill listener activated (ready to process fills during startup)');

        if (!bot._reconnectUnregister) {
            bot._reconnectUnregister = registerReconnectHook(() => {
                bot._log('Blockchain connection re-established; scheduling safety-net sync');
                const runSafetyNetSync = async () => {
                    if (bot.manager && bot.accountId && !bot._shuttingDown && !bot.config.dryRun) {
                        const safetyNetTimeoutMs = bot.config.timing?.SAFETY_NET_SYNC_TIMEOUT_MS;
                        let safetyNetTimer;
                        const workPromise = bot.manager._fillProcessingLock.acquire(async () => {
                            if (bot._shuttingDown) return;
                            // Truncated-read guard: the safety-net sync makes
                            // absence decisions (phantom cleanup); a partial
                            // get_full_accounts window must defer instead.
                            const chainOpenOrders = await botGuardedOpenOrdersRead(bot, {
                                log: (message: string, level: string) => bot._log(message, level),
                                label: 'RECONNECT-SYNC',
                            });
                            if (chainOpenOrders === null || bot._shuttingDown) return;
                            const syncResult = await bot.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                            if (bot._shuttingDown) return;
                            if (syncResult?.filledOrders?.length > 0) {
                                bot._refreshDynamicWeightDistribution('post-reconnect sync fill');
                                bot._log(`Post-reconnect sync: ${syncResult.filledOrders.length} grid order(s) found filled.`, 'info');
                                await bot._processFillsWithBatching(syncResult.filledOrders, new Set(), 'post-reconnect sync fill', { isReplay: true });
                                if (bot._shuttingDown) return;
                            }
                            bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
                            await bot.manager.persistGrid();

                            if (!bot._shuttingDown) {
                                try {
                                    const reconnectHealth = await bot.manager.checkGridHealth(
                                        bot.updateOrdersOnChainPlan.bind(bot)
                                    );
                                    await bot._cancelDustOrders({
                                        buy: reconnectHealth.buyDustOrders,
                                        sell: reconnectHealth.sellDustOrders,
                                    });
                                } catch (_dustErr) {
                                    bot._warn(`[RECONNECT] Dust cancel failed: ${getErrorMessage(_dustErr)}`);
                                }
                            }
                        });
                        try {
                            await Promise.race([
                                workPromise,
                                new Promise((_resolve: unknown, reject: (err: Error) => void) => {
                                    safetyNetTimer = setTimeout(
                                        () => reject(new Error(`Safety-net sync exceeded ${safetyNetTimeoutMs}ms cap`)),
                                        safetyNetTimeoutMs
                                    );
                                })
                            ]);
                        } catch (capErr) {
                            const fallback = await Promise.race([
                                workPromise.then(() => ({ ok: true as const })),
                                new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 0))
                            ]);
                            if (fallback.ok) {
                                bot._log(`Safety-net sync completed despite timeout — ignoring spurious error.`, 'info');
                            } else {
                                bot._warn(`Post-reconnect safety-net sync aborted: ${getErrorMessage(capErr)}`);
                            }
                        } finally {
                            if (safetyNetTimer) clearTimeout(safetyNetTimer);
                        }
                    }
                };
                setImmediate(() => {
                    runSafetyNetSync().catch((err: unknown) => {
                        try {
                            bot._warn('Post-reconnect safety-net sync failed: ' + (getErrorMessage(err)));
                        } catch (_) {
                        }
                    });
                });
            });
        }

        const hadTriggerReset = await bot._handlePendingTriggerReset();

        if (hadTriggerReset) {
            bot._log('Trigger reset completed. Skipping normal startup grid initialization.');

            await bot.manager._fillProcessingLock.acquire(async () => {
                if (bot._incomingFillQueue.length > 0) {
                    bot._log(`[POST-RESET] ${bot._incomingFillQueue.length} fill(s) detected during trigger reset. Processing...`);

                    const fills = bot._incomingFillQueue.splice(0);
                    const processedFillKeys = new Set<string>();
                    let requiresOpenOrdersSync = false;

                    for (const fill of fills) {
                        if (!fill || fill.op?.[0] !== 4) continue;

                        const fillOp = fill.op[1];
                        const gridOrder = bot.manager.orders.get(fillOp.order_id) ||
                            (Array.from(bot.manager.orders.values()) as ManagedOrder[]).find((o) => o.orderId === fillOp.order_id);

                        if (!gridOrder) {
                            if (await processSweepOrphanFill(bot, fill, fillOp, processedFillKeys, {
                                context: 'POST-RESET',
                                label: 'POST-RESET',
                                logger: { log: bot._log.bind(bot) },
                                replayMessage: (op: { order_id?: string }) => `[POST-RESET] Replay detected for orphan fill ${op.order_id}; skipping duplicate credit`
                            })) {
                                requiresOpenOrdersSync = true;
                            }
                            continue;
                        }

                        bot._log(`[POST-RESET] Processing fill for ${gridOrder.type} order ${gridOrder.id} at price ${gridOrder.price}`);

                        const trackedFillKey = buildFillKey(fill);
                        if (trackedFillKey && !bot._isNewFillKey(trackedFillKey, processedFillKeys, '[POST-RESET]', fillOp.order_id)) {
                            continue;
                        }

                        bot.manager.lockOrders([gridOrder.id]);
                        try {
                            const accountingResult = await bot._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                                context: 'POST-RESET',
                                logger: { log: bot._log.bind(bot) },
                                replayMessage: (op: { order_id?: string }) => `[POST-RESET] Replay detected for ${op.order_id}; skipping duplicate rebalance`
                            });
                            if (accountingResult.status === 'missing_key') {
                                requiresOpenOrdersSync = true;
                                continue;
                            }
                            if (accountingResult.status !== 'applied') {
                                continue;
                            }
                            const result = await bot._processFillsWithBatching([gridOrder], new Set(), `[POST-RESET] fill ${gridOrder.id}`, { isReplay: true });
                            if (result.aborted) {
                                bot._warn('[POST-RESET] Aborted batch due to illegal state; skipping grid persistence this cycle');
                                continue;
                            }
                        } finally {
                            bot.manager.unlockOrders([gridOrder.id]);
                        }
                    }

                    if (requiresOpenOrdersSync) {
                        bot._log('[POST-RESET] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
                        // Truncated-read guard: syncing on a partial
                        // get_full_accounts window would virtualize live ACTIVE
                        // slots (pass-1 phantom cleanup). Defer — the guarded
                        // pre-spread sync below picks up on a clean read.
                        const postResetChainOpenOrders = await botGuardedOpenOrdersRead(bot, {
                            log: (message: string, level: string) => bot._log(message, level),
                            label: 'POST-RESET',
                            detail: 'open-orders fallback',
                        });
                        if (postResetChainOpenOrders !== null) {
                            const syncResult = await bot.manager.syncFromOpenOrders(postResetChainOpenOrders);
                            if (syncResult.filledOrders?.length > 0) {
                                await bot._processFillsWithBatching(syncResult.filledOrders, new Set(), '[POST-RESET] open-orders fallback', { isReplay: true });
                            }
                        }
                    }

                    await bot._flushProcessedFillPersistence('post-reset-batch');

                    bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
                    await bot.manager.persistGrid();
                }

                const { aborted: postResetAborted, hasUnmatched: postResetUnmatched } =
                    await bot._syncOpenOrdersAndProcessFills('[POST-RESET] pre-spread');

                if (postResetUnmatched) {
                    bot._warn(`[POST-RESET] Skipping spread correction: ${postResetUnmatched} unmatched chain order(s) require maintenance reconciliation`);
                }

                await bot.manager.recalculateFunds();
                if (!postResetAborted && !postResetUnmatched) {
                    const spreadResult = await bot.manager.checkSpreadCondition(
                        BitShares,
                        bot.updateOrdersOnChainPlan.bind(bot)
                    );
                    if (spreadResult && (spreadResult.ordersPlaced ?? 0) > 0) {
                        bot._log(`✓ Spread correction after trigger reset: ${spreadResult.ordersPlaced ?? 0} order(s) placed`);
                        await bot._persistAndRecoverIfNeeded();
                    }
                }

                if (!bot._shuttingDown) {
                    try {
                        const postResetHealth = await bot.manager.checkGridHealth(
                            bot.updateOrdersOnChainPlan.bind(bot)
                        );
                        await bot._cancelDustOrders({
                            buy: postResetHealth.buyDustOrders,
                            sell: postResetHealth.sellDustOrders,
                        });
                    } catch (_dustErr) {
                        bot._warn(`[POST-RESET] Dust cancel failed: ${getErrorMessage(_dustErr)}`);
                    }
                }
                bot._log('Bootstrap phase complete - fill processing resumed', 'info');
            });

            await startPostBootstrapSubsystems(bot);
            bot.manager.finishBootstrap();

            if (bot._isOpenOrdersSyncLoopEnabled()) {
                bot._startOpenOrdersSyncLoop();
            } else {
                bot._log('Open-orders sync loop disabled by configuration');
            }
            bot._log(`DEXBot v${Config.VERSION} started. OrderManager running (dryRun=${!!bot.config.dryRun})`);
            return;
        }

        await bot.manager._fundLock.acquire(async () => {
            await bot.manager.resetFunds();
        });
        if (bot.config.assetA !== 'BTS' && bot.config.assetB !== 'BTS') {
            if (persistedBtsBalance && typeof persistedBtsBalance === 'object') {
                const bal = persistedBtsBalance as { free?: number; total?: number; locked?: number };
                bot.manager.btsBalance = {
                    free: bal.free || 0,
                    total: bal.total || 0,
                    locked: bal.locked || 0
                };
            }
        }

        if (persistedRecentFillKeys && typeof persistedRecentFillKeys === 'object') {
            for (const [fillKey, timestamp] of Object.entries(persistedRecentFillKeys)) {
                bot._recentlyQueuedFills.set(fillKey, Number(timestamp));
            }
            bot._log(`Restored ${Object.keys(persistedRecentFillKeys).length} recently queued fill key(s) from persisted snapshot`, 'debug');
        }

        if (!bot.config.dryRun && !bot.accountId) {
            throw new Error('Cannot start bot without a resolved account ID');
        }

        const guardedChainOrders = bot.config.dryRun
            ? []
            : await botGuardedOpenOrdersRead(bot, {
                log: (message: string, level: string) => bot._log(message, level),
                label: 'STARTUP',
            });
        // Truncated reads defer all chain-touching steps below; the decision
        // function must never see the partial snapshot (it could wrongly
        // resume/regenerate on ambiguous data), so it gets the empty list.
        let chainReadTruncated = guardedChainOrders === null;
        let chainOpenOrders = guardedChainOrders === null ? [] : guardedChainOrders;
        // STARTUP EMPTY-READ CONFIRM: with a persisted grid, a 0-order
        // snapshot is ambiguous — the node may be lagging behind the
        // pre-restart state — and accepting it would regenerate/virtualize
        // live orders (phantom wipe). Confirm with one re-read after
        // SYNC_EMPTY_READ_CONFIRM_DELAY_MS before accepting the empty read.
        // First launch (no persisted grid) legitimately has an empty account,
        // so no confirm is needed there — and deferEmpty must NOT be used
        // here, since it would treat that legitimate empty as ambiguous.
        // A contradicted re-read (non-empty) replaces the snapshot; a
        // truncated re-read defers like any truncated read.
        if (!bot.config.dryRun && !chainReadTruncated && Array.isArray(chainOpenOrders) && chainOpenOrders.length === 0
            && Array.isArray(persistedGrid) && persistedGrid.length > 0) {
            try {
                // Test seam: bot._skipEmptyReadConfirmDelay skips the
                // production SYNC_EMPTY_READ_CONFIRM_DELAY_MS pacing (tests
                // cover the confirm state machine, not the delay duration).
                if (!bot._skipEmptyReadConfirmDelay) {
                    await startupSleep(Math.max(0, Number((TIMING as Record<string, unknown>).SYNC_EMPTY_READ_CONFIRM_DELAY_MS) || 0));
                }
                const confirmRead = await botGuardedOpenOrdersRead(bot, {
                    log: (message: string, level: string) => bot._log(message, level),
                    label: 'STARTUP-CONFIRM',
                    detail: 'persisted-grid empty confirm re-read',
                });
                if (confirmRead === null) {
                    bot._log('[STARTUP] Empty-read confirm re-read TRUNCATED — deferring chain-touching steps to the sync loop', 'warn');
                    chainReadTruncated = true;
                    chainOpenOrders = [];
                } else if (Array.isArray(confirmRead) && confirmRead.length > 0) {
                    bot._log(`[STARTUP] Empty open-order read contradicted by confirm re-read (${confirmRead.length} order(s) present) — using fresh non-empty snapshot`, 'warn');
                    chainOpenOrders = confirmRead;
                } else {
                    bot._log('[STARTUP] Empty open-order read confirmed by re-read — accepting empty account', 'info');
                }
            } catch (confirmErr) {
                bot._log(`[STARTUP] Empty-read confirm re-read failed (${getErrorMessage(confirmErr)}) — deferring chain-touching steps to the sync loop`, 'warn');
                chainReadTruncated = true;
                chainOpenOrders = [];
            }
        }
        // Seed LAST-FILL-GUARD from the live book so it survives restarts
        // (closes the in-memory-only window until the first fill arrives).
        if (!chainReadTruncated && Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
            try { bot.manager?.seedLastFilledPricesFromBook?.(chainOpenOrders); } catch {}
        }

        const reconcileMod = botReconcileModule(bot);
        let shouldRegenerate = false;
        if (!persistedGrid || persistedGrid.length === 0) {
            shouldRegenerate = true;
            bot._log('No persisted grid found. Generating new grid.');
        } else {
            // E3 STARTUP GATE (docs/GRID_PRICE_INVARIANT.md): a persisted grid with
            // no usable price ladder must never reach the first sync — every
            // slot-price consumer degrades to a tolerance matcher from there on.
            // Ask the SAME question loadGrid asks (one resolver, two callers) and
            // take the configured action BEFORE deciding resume-vs-regenerate, so
            // a genesis-less snapshot is rebuilt instead of half-loaded.
            const genesisGate = evaluateStartupGenesisGate(bot, persistedGrid, persistedGenesis);
            if (genesisGate.needsRebuild) {
                shouldRegenerate = true;
            } else {
                await bot.manager._initializeAssets();
                const decision = await reconcileMod.decideStartupGridAction({
                    persistedGrid,
                    chainOpenOrders,
                    manager: bot.manager,
                    logger: botRetryLogger(bot),
                    storeGrid: async (orders: ManagedOrder[]) => {
                        await bot.manager.persistGrid(orders);
                    },
                    boundaryIdx: persistedBoundaryIdx,
                    genesis: persistedGenesis,
                    attemptResumeFn: reconcileMod.attemptResumePersistedGridByPriceMatch,
                });
                shouldRegenerate = decision.shouldRegenerate;

                if (shouldRegenerate && chainOpenOrders.length === 0) {
                    bot._log('Persisted grid found, but no matching active orders on-chain. Generating new grid.');
                }

                if (shouldRegenerate && chainOpenOrders.length > 0 && bot.manager?.assets) {
                    const orderCount = chainOpenOrders.filter(
                        (o: unknown) => parseChainOrder(o, bot.manager.assets) !== null
                    ).length;
                    if (orderCount === 0) {
                        bot._log(`Persisted grid found with no matching orders (${chainOpenOrders.length} other-pair order(s) on account). Generating new grid.`);
                    }
                }
            }
        }

        if (!shouldRegenerate) {
            const btsFeesOwed = Number(persistedBtsFeesOwed);
            if (btsFeesOwed > 0) {
                await bot.manager._fundLock.acquire(async () => {
                    bot.manager.funds.btsFeesOwed = btsFeesOwed;
                });
                bot._log(`✓ Restored BTS fees owed: ${Format.formatAmount8(btsFeesOwed)} BTS`);
            }
        } else {
            bot._log(`ℹ Grid regenerating - resetting BTS fees to clean state`);
            await bot.manager._fundLock.acquire(async () => {
                bot.manager.funds.btsFeesOwed = 0;
            });
        }

        await bot.manager._fillProcessingLock.acquire(async () => {
            try {
                bot._refreshDynamicWeightDistribution('startup');
                if (shouldRegenerate) {
                    await bot.manager._initializeAssets();
                }
                if (shouldRegenerate) {
                    if (!chainReadTruncated && Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                        bot._log('Generating new grid and syncing with existing on-chain orders...');
                        await botGridModule(bot).initializeGrid(bot.manager);
                        await bot.manager.syncFromOpenOrders(chainOpenOrders, { skipAccounting: true });
                        // Drain queued fills BEFORE re-placement (P3 ordering): fills
                        // replayed from history reference the PRE-restart order ids.
                        // Processing them now (freshly synced grid) keeps their slot
                        // provenance; processing them after reconcile re-placement
                        // finds no grid order and falls back to orphan proceeds
                        // credits, which drift the fund bookkeeping.
                        if (bot._incomingFillQueue.length > 0) {
                            bot._log(`[STARTUP] Processing ${bot._incomingFillQueue.length} queued fill(s) before re-placement (order provenance intact)`, 'info');
                            await bot._processFillsWithBootstrapMode(chainOrders);
                        }
                        const rebalanceResult = await reconcileMod.reconcileGridOrders({
                            manager: bot.manager,
                            config: bot.config,
                            account: bot.account,
                            privateKey: bot.privateKey,
                            chainOrders,
                            chainOpenOrders,
                        });

                        await bot._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (regenerated grid)');
                    } else if (!chainReadTruncated) {
                        bot._log('Generating new grid and placing initial orders on-chain...');
                        await bot.placeInitialOrders();
                    } else {
                        // Truncated snapshot: the account MAY have live orders
                        // outside the window. Placing initial orders or adopting
                        // from the partial snapshot could duplicate them — defer
                        // both to the sync loop's clean-read reconciliation.
                        bot._log('[STARTUP] Skipping initial placement/adoption: truncated snapshot is ambiguous — the next sync cycle will reconcile the grid', 'warn');
                    }
                    await bot._persistAndRecoverIfNeeded();
                } else {
                    bot._log('Found active session. Loading and syncing existing grid.');
                    // Pure in-band stranding is the transient SPREAD-GUARD /
                    // partial-fill-anchor state, not snapshot poison: the
                    // re-anchor deliberately leaves the fill's own PARTIAL
                    // residual inside the band until GAP-EVAC clears it.
                    // Keep the persisted boundary (warn + load) exactly like
                    // the recovery path; a rebuild here would undo the repair.
                    await botGridModule(bot).loadGrid(
                        bot.manager,
                        persistedGrid,
                        persistedBoundaryIdx,
                        persistedGenesis,
                        { tolerateTransientStranding: true }
                    );
                    // Phase 3 restart resilience: restore persisted gap-evacuation
                    // streaks (pruned to surviving slots) so an order stranded
                    // in-band across frequent restarts still reaches the cancel
                    // threshold instead of resetting its cycle count each boot.
                    const restoredStreaks = restoreGapEvacStreaks(bot.manager, persistedGapEvacStreaks);
                    if (restoredStreaks > 0) {
                        bot._log(`[GAP-EVAC] Restored ${restoredStreaks} persisted in-band streak(s) from snapshot`);
                    }
                    // Pending-crawl application: fills recorded but never
                    // committed before shutdown (refused broadcast, aborted
                    // plan) owe their crawl to the restored boundary. Apply
                    // before sync/reconcile so holes left by consumed fills
                    // fall into the gap instead of being refilled same-side
                    // (Sep-10: 4 consumed buys re-bought after restart).
                    // Shared with the recovery reload so the two boundary-load
                    // paths can never drift. Best-effort: reconcile proceeds
                    // with the restored boundary either way.
                    await applyPersistedPendingCrawls(bot, {
                        log: (message: string, level?: string) => bot._log(message, level)
                    });
                    let startupChainOpenOrders = chainOpenOrders;
                    if (chainReadTruncated) {
                        // Sync on a partial window would virtualize live ACTIVE
                        // slots (pass-1 phantom cleanup) and re-create them as
                        // duplicates — defer to the sync loop's clean reads.
                        bot._log('[STARTUP] Skipping syncFromOpenOrders: truncated snapshot would virtualize live slots; deferring to the sync loop', 'warn');
                    } else {
                        const syncResult = await bot.manager.syncFromOpenOrders(startupChainOpenOrders, { skipAccounting: true });

                        if (syncResult.ordersNeedingCorrection?.length > 0) {
                            await correctAllPriceMismatches(
                                bot.manager, bot.account, bot.privateKey, chainOrders
                            );
                        }

                        if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                            bot._log(`Startup sync: ${syncResult.filledOrders.length} grid order(s) found filled. Processing proceeds.`, 'info');
                            const batchResult = await bot._processFillsWithBatching(
                                syncResult.filledOrders, new Set(), 'startup sync fill rebalance',
                                { skipAccountTotalsUpdate: true, isReplay: true }
                            );

                            if (!batchResult?.aborted) {
                                const reReadOrders = await botGuardedOpenOrdersRead(bot, {
                                    log: (message: string, level: string) => bot._log(message, level),
                                    label: 'STARTUP',
                                    detail: 'post-fill re-read',
                                });
                                if (reReadOrders !== null) {
                                    startupChainOpenOrders = reReadOrders;
                                    await bot.manager.synchronizeWithChain(startupChainOpenOrders, 'readOpenOrders');
                                    try { bot.manager?.seedLastFilledPricesFromBook?.(startupChainOpenOrders); } catch {}
                                }
                            }
                        }
                    }

                    // P3 ordering: drain queued (and shutdown-surviving replayed)
                    // fills against the LOADED grid before reconcile re-placement
                    // changes it. The loaded grid still maps the pre-restart order
                    // ids to their slots, so proceeds/fill accounting attach to the
                    // right slots instead of degrading to orphan "unknown order"
                    // proceeds credits that drift the fund bookkeeping.
                    if (bot._incomingFillQueue.length > 0) {
                        bot._log(`[STARTUP] Processing ${bot._incomingFillQueue.length} queued fill(s) before reconcile (order provenance intact)`, 'info');
                        await bot._processFillsWithBootstrapMode(chainOrders);
                    }

                    if (chainReadTruncated) {
                        // Same reasoning: reconcile on a partial snapshot could
                        // cancel/adopt against an incomplete view of the chain.
                        bot._log('[STARTUP] Skipping startup reconcile: truncated snapshot — deferring to the sync loop', 'warn');
                    } else {
                        const rebalanceResult = await reconcileMod.reconcileGridOrders({
                            manager: bot.manager,
                            config: bot.config,
                            account: bot.account,
                            privateKey: bot.privateKey,
                            chainOrders,
                            chainOpenOrders: startupChainOpenOrders,
                        });

                        await bot._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (loaded grid)');
                    }

                    await bot._persistAndRecoverIfNeeded();

                    await bot._rejectCorruptedGridSnapshot('startup');
                }

                if (bot._incomingFillQueue.length > 0) {
                    bot._log(`[STARTUP] Processing ${bot._incomingFillQueue.length} queued fill(s) before bootstrap ends`);
                    await bot._processFillsWithBootstrapMode(chainOrders);
                }

                // Fetch fresh account totals BEFORE finishBootstrap so the drift
                // check inside finishBootstrap uses accurate on-chain balances
                // rather than the stale snapshot from initializeStartupState.
                // Uses shared withBlockchainRetry for timeout + retry + node failover.
                try {
                    await withBlockchainRetry(
                        () => bot.manager.fetchAccountTotals(),
                        'fetchAccountTotals',
                        { logger: botRetryLogger(bot) }
                    );
                } catch (fetchErr) {
                    bot._log(
                        `[STARTUP] [${bot.config?.botKey || 'unknown'}] fetchAccountTotals failed after retries: ${getErrorMessage(fetchErr)}. Continuing with cached account totals.`,
                        'warn'
                    );
                }

                bot.manager.finishBootstrap();

                await bot._runGridMaintenance('startup');

                const startupHealth = await bot.manager.checkGridHealth(
                    bot.updateOrdersOnChainPlan.bind(bot)
                );
                await bot._cancelDustOrders({
                    buy: startupHealth.buyDustOrders,
                    sell: startupHealth.sellDustOrders,
                });

                bot._log('Bootstrap phase complete - fill processing resumed', 'info');
            } finally {
                bot.manager.finishBootstrap();
            }
        });

        await startPostBootstrapSubsystems(bot);

        if (bot._isOpenOrdersSyncLoopEnabled()) {
            bot._startOpenOrdersSyncLoop();
        } else {
            bot._log('Open-orders sync loop disabled by configuration');
        }
        bot._log(`DEXBot v${Config.VERSION} started. OrderManager running (dryRun=${!!bot.config.dryRun})`);

    } catch (err) {
        bot._warn(`Error during grid initialization: ${getErrorMessage(err)}`);
        await bot.shutdown();
        throw err;
    }
}

/**
 * Place initial orders on the blockchain (extracted logic from original placeInitialOrders).
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
async function placeInitialOrdersImpl(bot: BotLike) {
    if (!bot.manager) {
        const mgrLogFile = bot.config?.name ? path.join(PATHS.LOGS_DIR, `${bot.config.name}.log`) : undefined;
        bot.manager = new OrderManager({ ...bot.config, logFile: mgrLogFile });
        bot.manager.accountOrders = bot.accountOrders;
    }
    bot._wireStructuralGridResyncRequest();
    bot._wireBroadcastRegionEndDrain();
    bot.manager.startBootstrap();
    try {
        try {
            const botFunds = bot.config && bot.config.botFunds ? bot.config.botFunds : {};
            const needsPercent = (v: unknown) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (bot.accountId || bot.account)) {
                if (typeof bot.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await bot.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch) {
            bot._warn(`Could not fetch account totals before initializing grid: ${errFetch && getErrorMessage(errFetch) ? getErrorMessage(errFetch) : errFetch}`);
        }

        await botGridModule(bot).initializeGrid(bot.manager);

        if (bot.config.dryRun) {
            bot.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            await bot.manager.persistGrid();
            return;
        }

        bot.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = bot.manager.getInitialOrdersToActivate();

        const orderGroups = bot._buildOutsideInPairGroupsForOrders(ordersToActivate);

        for (const group of orderGroups) {
            await bot.updateOrdersOnChainPlan({ ordersToPlace: group });
        }

        await bot.manager.persistGrid();
    } finally {
        bot.manager.finishBootstrap();
    }
}

export { initializeStartupState, finishStartupSequence, placeInitialOrdersImpl }


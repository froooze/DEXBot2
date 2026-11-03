/** State recovery runtime - grid persistence, recovery sync, size-drift repair */

import * as client from './bitshares_client.js';
const { BitShares } = client;
import * as chainOrders from './chain_orders.js';
import { readOpenOrdersGuarded } from './chain_orders.js';
import { ORDER_TYPES, TIMING } from './constants.js';
import * as Format from './order/format.js';
import * as grid from './order/grid.js';
import { convertToSpreadPlaceholder, parseChainOrder, isNonBlockingUnmatchedOrder, detectGapEvacuationCandidates, updateGapEvacuationStreaks } from './order/utils/order.js';
import { restoreGapEvacStreaks, applyPersistedPendingCrawls, resetLastFillPivot, hasUnsettledFills } from './order/utils/system.js';
import { blockchainToFloat, calculateGapSlots, resolveGapSlots, validatePersistedBoundary, isTransientInBandRejection } from './order/utils/math.js';
import { ON_MISSING_GENESIS, isMissingGenesisError } from './order/genesis_policy.js';
import type { ManagedOrder, ChainOrder } from './types.js';
import type { GridGenesis } from './order/utils/math.js';
import { hasExecutableActions } from './order/utils/validate.js';
import { getErrorMessage } from './utils/errors.js';
import type { BotLike } from './types.js';
const { isGridBloated } = grid;

/**
 * Persist the current grid state and trigger recovery if validation fails.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
async function persistAndRecoverIfNeeded(bot: BotLike) {
    bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
    const validation = await bot.manager.persistGrid();
    if (!validation.isValid) {
        bot._warn(`Startup validation failed: ${validation.reason}. Triggering immediate recovery...`);
        const recoveryValidation = await bot.manager.accountant._performStateRecovery(bot.manager);
        if (recoveryValidation.isValid) {
            bot._log(`✓ Startup recovery successful. Persistent state restored.`);
            bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
            await bot.manager.persistGrid();
        } else {
            bot._warn(`Startup recovery failed: ${recoveryValidation.reason}. Bot proceeding with caution.`);
        }
    }
}

/**
 * Snapshot the recently queued fill keys as a plain object for crash-durable persistence.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Record<string, number>}
 */
function getRecentFillKeysSnapshot(bot: BotLike) {
    const snapshot: Record<string, number> = {};
    const now = Date.now();
    for (const [key, timestamp] of bot._recentlyQueuedFills) {
        if (now - Number(timestamp) < bot._fillDedupeWindowMs) {
            snapshot[key] = Number(timestamp);
        }
    }
    if (bot.manager?._recentFillKeysSnapshot) {
        for (const [key, timestamp] of Object.entries(bot.manager._recentFillKeysSnapshot)) {
            if (!(key in snapshot) && now - Number(timestamp) < bot._fillDedupeWindowMs) {
                snapshot[key as string] = Number(timestamp);
            }
        }
    }
    return snapshot;
}

/**
 * Trigger a full state recovery sync (fetch chain + sync from open orders + persist).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} [reason='state recovery sync']
 */
async function triggerStateRecoverySync(bot: BotLike, reason: string = 'state recovery sync') {
    if (!bot.manager) return;

    if (bot._recoverySyncInFlight) {
        bot.manager.logger.log(`[RECOVERY] Skipping duplicate recovery request: ${reason}`, 'warn');
        return;
    }

    bot._recoverySyncInFlight++;
    (bot as unknown as { _recoverySyncInFlightStartedAt?: number })._recoverySyncInFlightStartedAt = Date.now();
    try {
        bot.manager.logger.log(`Triggering state recovery sync (${reason})...`, 'info');
        await bot.manager.fetchAccountTotals(bot.accountId);
        // Truncated-read guard: syncing on a partial get_full_accounts window
        // would virtualize live ACTIVE slots (pass-1 phantom cleanup) and let
        // the next cycle re-create them as duplicates. Defer to a clean read.
        const openOrders = await readOpenOrdersGuarded(chainOrders, bot.accountId, {
            log: (message: string, level?: string) => bot.manager.logger.log(message, level),
            label: 'RECOVERY',
            detail: 'during state recovery sync',
        });
        if (openOrders === null) return;
        await bot.manager.syncFromOpenOrders(openOrders, { skipAccounting: true });
        if (typeof bot.manager.persistGrid === 'function') {
            await bot.manager.persistGrid();
        }
        // Re-derive the target grid so a reconcile-only sync re-places rails
        // that were consumed while recovery was pending. Deferred: this sync is
        // often invoked from a batch-abort catch (handleBatchHardAbort /
        // recoverBatchSizeDrift) where broadcasting a fresh COW batch would race
        // the batch's own finally cleanup, and from flows holding the fill lock.
        _schedulePostRecoveryRebalance(bot, `state recovery sync (${reason})`);
    } catch (err) {
        bot.manager.logger.log(
            `[RECOVERY] State recovery sync (${reason}) failed: ${getErrorMessage(err)}. Preserving current state; the next sync cycle will retry.`,
            'error'
        );
    } finally {
        bot._recoverySyncInFlight = Math.max(0, bot._recoverySyncInFlight - 1);
        if (bot._recoverySyncInFlight === 0) {
            (bot as unknown as { _recoverySyncInFlightStartedAt?: number })._recoverySyncInFlightStartedAt = 0;
        }
    }
}

/**
 * Abort the current flow if an illegal state signal was raised.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} flowContext
 * @returns {Promise<boolean>}
 */
async function abortFlowIfIllegalState(bot: BotLike, flowContext: string) {
    const illegalSignal = bot.manager?.consumeIllegalStateSignal?.();
    if (!illegalSignal) {
        return false;
    }

    bot.manager.logger.log(
        `[HARD-ABORT] ${flowContext} aborted due to illegal state (${illegalSignal.context}): ${illegalSignal.message}`,
        'error'
    );
    await bot._triggerStateRecoverySync(`hard-abort ${flowContext}`);
    bot._maintenanceCooldownCycles = Math.max(bot._maintenanceCooldownCycles, 1);
    return true;
}

/**
 * Handle a hard abort from batch processing due to illegal state or accounting failure.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Error} err
 * @param {string} [phase='batch processing']
 * @param {number} [opsCount=0]
 * @returns {Promise<Object|null>}
 */
async function handleBatchHardAbort(bot: BotLike, err: unknown, phase: string = 'batch processing', opsCount: number = 0) {
    const baseResult = { executed: false, hadRotation: false };
    const opsInfo = opsCount > 0 ? ` with ${opsCount} ops` : '';

    if ((err as { code?: string } | null | undefined)?.code === 'ACCOUNTING_COMMITMENT_FAILED') {
        const accountingSignal = bot.manager.consumeAccountingFailureSignal?.();
        const reason = accountingSignal
            ? `accounting lock failure (${accountingSignal.side} ${Format.formatAmount8(accountingSignal.amount)}) during ${accountingSignal.context}`
            : `accounting commitment lock failure during ${phase}${opsInfo}`;
        await bot._triggerStateRecoverySync(reason);
        bot._maintenanceCooldownCycles = Math.max(bot._maintenanceCooldownCycles, 1);
        return { ...baseResult, abortedForAccountingFailure: true };
    }

    const illegalSignal = bot.manager.consumeIllegalStateSignal?.();
    if (illegalSignal) {
        await bot._triggerStateRecoverySync(illegalSignal.message || `illegal order state during ${phase}${opsInfo}`);
        bot._maintenanceCooldownCycles = Math.max(bot._maintenanceCooldownCycles, 1);
        return { ...baseResult, abortedForIllegalState: true };
    }

    return null;
}

/**
 * Apply recoverable grid updates (order virtualisation) after a batch failure.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array<Object>} updates
 * @param {string} [context='recoverable-grid-update']
 * @returns {Promise<number>}
 */
async function applyRecoverableGridUpdates(bot: BotLike, updates: unknown[], context: string = 'recoverable-grid-update') {
    if (!bot.manager || !Array.isArray(updates) || updates.length === 0) {
        return 0;
    }

    let applied;
    if (typeof bot.manager.applyGridUpdateBatch === 'function') {
        await bot.manager.applyGridUpdateBatch(updates, context);
        applied = updates.length;
    } else {
        applied = 0;
        for (const update of updates) {
            if (typeof bot.manager._updateOrder !== 'function') break;
            await bot.manager._updateOrder(update as ManagedOrder, context);
            applied++;
        }
    }

    if (applied > 0 && typeof bot.manager.persistGrid === 'function') {
        await bot.manager.persistGrid();
    }

    return applied;
}

/**
 * Recover from explicit stale order errors by virtualizing affected grid slots.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Set<string>|string[]} staleOrderIds
 * @param {string} [reason='stale order cleanup']
 * @returns {Promise<Object>}
 */
async function recoverExplicitStaleOrders(bot: BotLike, staleOrderIds: unknown, reason: string = 'stale order cleanup') {
    const staleIds = Array.from((staleOrderIds as Iterable<unknown>) || []).filter(Boolean) as string[];
    if (staleIds.length === 0) {
        return { executed: false, hadRotation: false, stale: false };
    }
    const staleIdSet = new Set(staleIds);

    bot.manager.logger.log(
        `[COW] Stale order(s) detected: ${staleIds.join(', ')}. Applying targeted cleanup.`,
        'warn'
    );

    const updates: unknown[] = [];

    for (const [, gridOrder] of bot.manager.orders.entries()) {
        if (!gridOrder?.orderId || !staleIdSet.has(gridOrder.orderId)) continue;
        bot._staleCleanedOrderIds.set(gridOrder.orderId, Date.now());
        updates.push(convertToSpreadPlaceholder(gridOrder));
    }

    for (const orderId of staleIds) {
        if (!bot._staleCleanedOrderIds.has(orderId)) {
            bot._staleCleanedOrderIds.set(orderId, Date.now());
        }
    }

    if (updates.length > 0) {
        await bot._applyRecoverableGridUpdates(updates, reason);
    } else {
        bot.manager.logger.log(
            `[COW] No local grid slot matched stale order cleanup request (${staleIds.join(', ')}).`,
            'debug'
        );
    }

    return {
        executed: false,
        hadRotation: false,
        stale: true,
        recoveredByVirtualization: updates.length > 0
    };
}

/**
 * Recover from on-chain size drift detected during batch broadcast.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Error} err
 * @param {Array<Object>} [opContexts=[]]
 * @returns {Promise<Object>}
 */
async function recoverBatchSizeDrift(bot: BotLike, err: unknown, opContexts: unknown = []) {
    const affectedOrderIds = extractSizeDriftOrderIds(opContexts);
    if (affectedOrderIds.length > 0) {
        bot.manager.logger.log(
            `[COW] Targeted size-drift repair for ${affectedOrderIds.length} order(s): ${affectedOrderIds.join(', ')}`,
            'debug'
        );
        const repaired = await bot._targetedOrderRepair(affectedOrderIds);
        if (repaired) {
            // The batch that carried the rotation (boundary crawl + opposite-side
            // CREATE for the consumed order) was discarded, so re-derive the
            // target grid after the repair to re-place it. Targeted repair only
            // re-sizes/re-types the affected slots — it never completes the
            // rotation. Without this, a fully-consumed order would sit unplaced
            // until the next fill or maintenance divergence check. Deferred so it
            // runs after the failed batch's teardown completes.
            _schedulePostRecoveryRebalance(bot, `targeted size-drift repair (${affectedOrderIds.join(', ')})`);
            return {
                executed: false,
                hadRotation: false,
                recoveredBySync: true,
                reason: 'ORDER_SIZE_DRIFT_TARGETED'
            };
        }
        bot.manager.logger.log(
            '[COW] Targeted repair failed, falling back to full state recovery sync.',
            'warn'
        );
    }

    const reason = `recoverable size drift during COW batch: ${getErrorMessage(err)}`;
    bot.manager.logger.log(
        `[COW] Recovering from on-chain size drift via recovery sync: ${getErrorMessage(err)}`,
        'warn'
    );
    await bot._triggerStateRecoverySync(reason);
    return {
        executed: false,
        hadRotation: false,
        recoveredBySync: true,
        reason: 'ORDER_SIZE_DRIFT'
    };
}

/**
 * Extract chain order IDs from opContexts for size-drift operations.
 * @param {Array<Object>} opContexts
 * @returns {string[]}
 */
function extractSizeDriftOrderIds(opContexts: unknown) {
    if (!Array.isArray(opContexts)) return [];
    const ids = new Set<string>();
    for (const ctx of opContexts as Array<{ kind?: string; updateInfo?: { partialOrder?: { orderId?: string } }; rotation?: { oldOrder?: { orderId?: string } } }>) {
        if (ctx?.kind === 'size-update' && ctx?.updateInfo?.partialOrder?.orderId) {
            ids.add(ctx.updateInfo.partialOrder.orderId);
        } else if (ctx?.kind === 'rotation' && ctx?.rotation?.oldOrder?.orderId) {
            ids.add(ctx.rotation.oldOrder.orderId);
        }
    }
    return Array.from(ids);
}

/**
 * Reload the grid from the persisted on-disk snapshot and reconcile with chain.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
async function recoverFromPersistedGrid(bot: BotLike) {
    if (!bot.accountOrders || !bot.manager) {
        return { success: false, reason: 'accountOrders or manager unavailable' };
    }

    const accountRef = bot.accountId || (bot.account as unknown as { id?: string } | null)?.id || bot.account;
    if (!accountRef) {
        return { success: false, reason: 'no account reference' };
    }

    bot.manager.logger.log('[RECOVERY] Attempting full grid reload from persisted snapshot...', 'warn');

    try {
        const persistedGrid = bot.accountOrders.loadGrid(true);
        if (!persistedGrid || persistedGrid.length === 0) {
            return { success: false, reason: 'no persisted grid on disk' };
        }

        const boundaryIdx = bot.accountOrders.loadBoundaryIdx(true);

        // PERSISTED-BOUNDARY GATE: a snapshot whose stored boundary fails
        // validation is poison (e.g. committed by the pre-5eb3ca7 promotion
        // overrun).  Refuse the snapshot BEFORE loadGrid so the caller's
        // fallback — requestGridReset(refreshCenterPrice) — rebuilds clean
        // geometry instead of re-ingesting the damage and reporting success.
        // Without this, structural resync would "recover" straight back into
        // the corrupted state on every attempt.
        // Transient exception: `placed_order_in_band` (any count) is the normal
        // SPREAD-GUARD mid-evacuation state (live orders crawled into the band,
        // GAP-EVAC streak already tracking it; the snapshot may also be stale
        // by one crawl).  Rejecting it here forces a structural resync that
        // wipes the in-progress evacuation — the <bot> 2026-09-13 sabotage
        // loop.  Warn + load instead; GAP-EVAC/sync sweeps own the cleanup.
        // All other reasons stay rebuild-worthy.
        let tolerateTransientStranding = false;
        if (typeof boundaryIdx === 'number') {
            // Same gapSlots source as loadGrid's restore gate (config-derived,
            // NOT manager._gapSlots — a stale value from a prior load with a
            // since-changed config must not flip this verdict).
            const gapSlots = calculateGapSlots(
                bot.manager.config?.incrementPercent,
                bot.manager.config?.targetSpreadPercent,
                bot.manager.config?.gridLimits
            );
            const check = validatePersistedBoundary(boundaryIdx, persistedGrid, gapSlots);
            if (!check.ok && isTransientInBandRejection(check)) {
                tolerateTransientStranding = true;
                bot.manager.logger.log(
                    `[RECOVERY] Persisted snapshot has transient in-band placement (${check.reason}: ${check.detail}). ` +
                    `Proceeding with load; GAP-EVAC/sync sweeps own cleanup (no structural resync).`,
                    'warn'
                );
            } else if (!check.ok) {
                bot.manager.logger.log(
                    `[RECOVERY] Persisted boundary failed validation (${check.reason}: ${check.detail}). ` +
                    `Rejecting snapshot so structural resync rebuilds clean geometry.`,
                    'error'
                );
                return { success: false, reason: `persisted boundary rejected (${check.reason})` };
            }
        }

        const persistedGenesis = (bot.accountOrders.loadGenesis?.(true) ?? null) as GridGenesis | null;
        await grid.loadGrid(bot.manager, persistedGrid as ManagedOrder[], boundaryIdx, persistedGenesis, { tolerateTransientStranding });
        // Restart resilience: same pruning rules as the startup path — streaks
        // only survive for slots that still exist in the reloaded grid.
        const restoredStreaks = restoreGapEvacStreaks(bot.manager, bot.accountOrders.loadGapEvacStreaks?.(true) ?? null);
        if (restoredStreaks > 0) {
            bot.manager.logger.log(`[GAP-EVAC] Restored ${restoredStreaks} persisted in-band streak(s) during recovery reload`, 'info');
        }

        // Same contract as the startup resume path: fills recorded but never
        // committed owe their crawl to the restored boundary, so apply the
        // stored records BEFORE sync/reconcile — and before the persistGrid
        // below, which would otherwise write the empty in-memory array and
        // erase the owed crawls from disk without ever applying them. Shared
        // helper, so startup and recovery cannot drift.
        try {
            await applyPersistedPendingCrawls(bot, {
                forceReload: true,
                log: (message: string, level?: string) => bot.manager.logger.log(message, level)
            });
        } catch (pendingErr) {
            bot.manager.logger.log(
                `[BOUNDARY] Pending-crawl application failed during recovery reload (${getErrorMessage(pendingErr)}); continuing with the restored boundary`,
                'warn'
            );
        }

        if (await bot._rejectCorruptedGridSnapshot('recovery')) {
            // P4: rejected snapshot's boundary must not survive for rebuild.
            // clearGrid() already wiped persisted boundaryIdx; also clear the
            // in-memory boundary so subsequent re-derivation (P3) starts clean
            // instead of reusing the stale restored value (131 in the incident).
            try {
                (bot.manager as unknown as { _restoreBoundary?(value: unknown): void })._restoreBoundary?.(null);
            } catch {}
            (bot.manager as unknown as { boundaryIdx?: number | null }).boundaryIdx = null;
            return { success: false, reason: 'corrupted grid snapshot rejected (fund drift)' };
        }

        // Truncated-read guard: syncing on a partial get_full_accounts window
        // would virtualize live ACTIVE slots (pass-1 phantom cleanup) and
        // re-create them as duplicates. A reload that cannot reconcile with
        // chain did not complete its contract — fail so the caller escalates
        // to a structural resync (which defers the same way on a clean read).
        let chainOpenOrders = await readOpenOrdersGuarded(chainOrders, accountRef, {
            log: (message: string, level?: string) => bot.manager.logger.log(message, level),
            label: 'RECOVERY',
            detail: 'full grid reload from persisted snapshot',
        });
        if (chainOpenOrders === null) {
            // Window read truncated: fall back to an ID-based read of the order
            // ids the persisted snapshot already tracks. This recovers the bot's
            // own orders (including creates adopted by id after a refused COW
            // commit, whose ids are now persisted) even when the account exceeds
            // the get_full_accounts window — without virtualizing live ACTIVE
            // slots. It cannot discover brand-new orphans whose ids are nowhere
            // in the snapshot; those are prevented at source by the COW adoption
            // path (adoptPlacedBatchFromChain reads by id immediately after
            // broadcast). When no known ids are available, still defer.
            const knownIds = (persistedGrid || [])
                .map((s: unknown) => (s as { orderId?: string } | null)?.orderId)
                .filter((id: unknown) => id && /^1\.7\.\d+$/.test(String(id)));
            let recoveredById: ChainOrder[] | null = null;
            if (knownIds.length > 0 && typeof chainOrders.batchReadOrders === 'function') {
                try {
                    const map = await Promise.resolve(chainOrders.batchReadOrders(knownIds as string[]));
                    const byId: ChainOrder[] = [];
                    if (map && typeof (map as Map<string, ChainOrder>).forEach === 'function') {
                        (map as Map<string, ChainOrder>).forEach((o) => { if (o) byId.push(o); });
                    }
                    recoveredById = byId;
                    recoveredById = byId;
                } catch (byIdErr) {
                    bot.manager.logger.log(`[RECOVERY] ID-based fallback read failed: ${getErrorMessage(byIdErr)}`, 'warn');
                }
            }
            if (recoveredById && recoveredById.length > 0) {
                bot.manager.logger.log(
                    `[RECOVERY] Window truncated; recovered ${recoveredById.length}/${knownIds.length} known order(s) by id instead of deferring`,
                    'warn'
                );
                chainOpenOrders = recoveredById;
            } else {
                return { success: false, reason: 'truncated open-order read; full grid reload deferred' };
            }
        }

        if (chainOpenOrders === null) {
            return { success: false, reason: 'truncated open-order read; full grid reload deferred' };
        }

        if (chainOpenOrders.length > 0 && bot.manager?.syncFromOpenOrders) {
            await bot.manager.syncFromOpenOrders(chainOpenOrders, {
                skipAccounting: true,
            });
        }

        if (typeof bot.manager.persistGrid === 'function') {
            await bot.manager.persistGrid();
        }

        const assets = bot.manager?.assets;
        const matchedCount = assets
            ? chainOpenOrders.filter((o: unknown) => parseChainOrder(o as Parameters<typeof parseChainOrder>[0], assets) !== null).length
            : chainOpenOrders.length;
        bot.manager.logger.log(
            `[RECOVERY] Grid reloaded from persisted snapshot: ${bot.manager.orders.size} orders, ` +
            `${matchedCount} on-chain orders synced`,
            'info'
        );

        const remainingUnmatched = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
            ? bot.manager._lastUnmatchedChainOrders
            : [];
        // Out-of-grid holds are permanent by design (live orders held outside
        // the frozen rail): they survive every reload, so they must not fail
        // snapshot recovery — otherwise each restart forces a full grid reset
        // while a hold exists. Only adoptable/cancellable orphans reject.
        const blockingUnmatched = remainingUnmatched.filter((u: unknown) => !isNonBlockingUnmatchedOrder(u as Parameters<typeof isNonBlockingUnmatchedOrder>[0]));
        if (blockingUnmatched.length > 0) {
            const sample = blockingUnmatched.slice(0, 3)
                .map((o: unknown) => bot._formatUnmatchedChainOrderForLog(o))
                .join(' | ');
            bot.manager.logger.log(
                `[RECOVERY] Persisted grid reloaded but ${blockingUnmatched.length} unmatched chain order(s) ` +
                `remain${sample ? ` (${sample})` : ''}. Rejecting — full grid reset required.`,
                'warn'
            );
            return { success: false, reason: `grid inconsistent after reload: ${blockingUnmatched.length} unmatched remain` };
        }
        if (remainingUnmatched.length > 0) {
            bot.manager.logger.log(
                `[RECOVERY] Persisted grid reloaded with ${remainingUnmatched.length} out-of-grid hold(s) kept (no reset required).`,
                'info'
            );
        }

        const ordersArr = Array.from(bot.manager.orders.values());
        const bloatPostRecovery = isGridBloated(bot.manager, ordersArr);
        if (bloatPostRecovery.bloated && bloatPostRecovery.details) {
            const d = bloatPostRecovery.details;
            bot.manager.logger.log(
                `[RECOVERY] Persisted grid reloaded but still bloated ` +
                `(${d.gridSize} slots, max ${d.maxAllowed}). Rejecting — full grid reset required.`,
                'warn'
            );
            return { success: false, reason: 'grid still bloated after reload' };
        }

        // Re-derive the target grid so a boundary crawl that aborted mid-batch
        // re-places missing rails. syncFromOpenOrders is reconcile-only — it
        // virtualizes consumed orders but never re-derives the target, so a
        // hole (e.g. a sell fully consumed while the snapshot still listed it)
        // would otherwise persist indefinitely. Best-effort: if the rebalance
        // cannot run or its broadcast fails, the next maintenance divergence
        // check closes the gap — recovery itself must not fail on it.
        await _rebalanceAfterRecovery(bot, 'persisted grid reload');

        return { success: true };
    } catch (err) {
        if (isMissingGenesisError(err)) {
            // Fail closed on the snapshot, not on the manager: `loadGrid`
            // refused it before touching any state. What happens next is the
            // configured missing-genesis policy (docs/GRID_PRICE_INVARIANT.md):
            //   'rebuild' -> fail the reload; the caller runs the structural
            //                resync, which re-derives the ladder from live config.
            //   'halt'    -> do NOT auto-rebuild; the operator must run a manual
            //                grid reset. Signalled to the caller with
            //                `halt: true` so it skips the resync branch.
            if (err.policy === ON_MISSING_GENESIS.HALT) {
                bot.manager.logger.log(
                    `[RECOVERY] Refusing the persisted snapshot — no usable price ladder ` +
                    `(${err.reason}: ${err.detail}); missing-genesis policy='halt', so the automatic ` +
                    `structural resync is suppressed. Run a manual grid reset for this bot (or set ` +
                    `gridLimits.MISSING_GENESIS_POLICY=rebuild to auto-rebuild instead).`,
                    'error'
                );
                return { success: false, reason: `missing price ladder (${err.reason})`, halt: true };
            }
            bot.manager.logger.log(
                `[RECOVERY] Refusing the persisted snapshot — no usable price ladder ` +
                `(${err.reason}: ${err.detail}). Escalating to a structural resync, which re-derives the ladder.`,
                'error'
            );
            return { success: false, reason: `missing price ladder (${err.reason})` };
        }
        bot.manager.logger.log(
            `[RECOVERY] Full grid reload from persisted snapshot failed: ${getErrorMessage(err)}`,
            'error'
        );
        return { success: false, reason: getErrorMessage(err) };
    }
}

/**
 * Rate limit for gap-evac repairs (one fill-less re-plan per bot per minute).
 * The post-commit hook and the maintenance sweep can both observe the same
 * stranding; without a floor a plan that fails to resolve it (guard, funds,
 * crossing) would re-plan on every commit and burn broadcasts.
 */
const GAP_EVAC_REPAIR_COOLDOWN_MS = 60 * TIMING.MILLISECONDS_PER_SECOND;
const _lastGapEvacRepairAt = new WeakMap<object, number>();

/**
 * Detect live orders resting INSIDE the committed gap band and schedule the
 * repair (fill-less COW re-plan + cancel-only teeth as last resort).
 *
 * Why this exists: a boundary commit that moves the boundary away from a live
 * order strands it inside the spread band. The plan normally evacuates it with
 * a rotation in the SAME batch, but the LAST-FILL-GUARD re-proves an evacuation
 * against the PRE-COMMIT geometry and refuses it as stale when the plan's own
 * crawl is what created the stranding (fail-closed by design — see the
 * 2026-10-30 bid-edge incident). The batch then commits the new boundary with
 * the stranded order still live, and because plans are fill-driven the state
 * never heals while the market is quiet: the 4-slot spread band keeps two live
 * buys and the real spread collapses (observed: 1.21% against a 2.0% target).
 *
 * Re-planning AFTER the commit is safe where the in-batch rotation is not: the
 * committed geometry is now the LIVE geometry, so the evacuation stamp passes
 * `isEvacuationStampStillValid` and the rotation executes as one price update.
 *
 * Cheap when healthy: one `detectGapEvacuationCandidates` scan (O(grid)) and an
 * early return. Callers run it on commit (writer of the stranding) and on the
 * maintenance tick (covers restarts and commits from paths without a bot
 * reference).
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} context - Label for logging/telemetry
 * @returns `{ stranded, scheduled }` — stranded slot ids found, whether a
 *          re-plan was scheduled.
 */
function scheduleGapEvacRepair(bot: BotLike, context: string = 'gap-evac sweep'): { stranded: string[]; scheduled: boolean } {
    const manager = bot.manager;
    if (!manager || !(manager.orders instanceof Map) || manager.orders.size === 0) {
        return { stranded: [], scheduled: false };
    }
    try {
        // UNKNOWN GEOMETRY IS NOT HEALTH. Without a committed boundary (or a
        // known band width) there is no band to judge, so this sweep must not
        // conclude "clean" — clearing the ledger or scheduling against a guessed
        // band would be the same "absent reads as 0" trap that hid the stranding
        // in the first place. Same fail-closed contract as
        // isEvacuationStampStillValid.
        const boundaryKnown = Number.isFinite(Format.toKnownNumber(manager.boundaryIdx));
        const gapKnown = Number.isFinite(Format.toKnownNumber(manager._gapSlots))
            || Number.isFinite(Format.toKnownNumber(manager._genesis?.gapSlots));
        if (!boundaryKnown || !gapKnown) return { stranded: [], scheduled: false };
        const gapSlots = resolveGapSlots(manager);
        const candidates = detectGapEvacuationCandidates(
            manager.orders,
            manager.boundaryIdx,
            gapSlots,
            { assets: manager.assets, genesis: manager._genesis }
        );
        const streaks = manager._gapEvacStreaks instanceof Map ? manager._gapEvacStreaks : null;
        if (candidates.length === 0) {
            // Healthy: drop resolved ledger entries so a future return to the
            // band re-arms instead of inheriting a stale cycle count.
            const resolved = streaks ? streaks.size : 0;
            if (streaks && resolved > 0) {
                updateGapEvacuationStreaks(streaks, []);
                manager.logger?.log?.(
                    `[GAP-EVAC] Spread band clean: cleared ${resolved} resolved in-band streak(s)`,
                    'debug'
                );
            }
            return { stranded: [], scheduled: false };
        }
        const stranded = candidates.map((c) => `${c.id}(${c.type})`);
        // Re-derive the streak ledger against the COMMITTED geometry (drops
        // resolved ids) WITHOUT counting a new observation: reconcileGrid ticks
        // this same ledger at plan-build time, and counting twice per cycle
        // armed the cancel-only teeth in the very cycle whose rotation was about
        // to evacuate the order. Observed live: the sweep's tick plus the plan's
        // tick took a restored streak of 1 to 3 (cancel threshold), the teeth
        // queued a cancel for both rotation sources, the pre-batch drain
        // cancelled them, and the UPDATE batch was rejected pre-broadcast with
        // "2 target(s) missing on chain" → structural resync + full grid reload
        // instead of two in-place price updates.
        const tick = streaks
            ? updateGapEvacuationStreaks(streaks, candidates, null, { increment: false })
            : { streaks: {}, ready: [] as Array<{ id: string }> };
        // The cancel-only teeth stay the LAST resort. `_processGapEvacuationTeeth`
        // returns the number it actually queued (it re-verifies live geometry and
        // honours queued-once), so report that — not the number of candidates it
        // was offered.
        const queueTeeth = (ready: Array<{ id: string }>): number => {
            const teeth = (manager as unknown as { _processGapEvacuationTeeth?: (ready: unknown) => unknown })._processGapEvacuationTeeth;
            if (typeof teeth !== 'function' || ready.length === 0) return 0;
            const queued = Number(teeth.call(manager, ready));
            return Number.isFinite(queued) && queued > 0 ? queued : 0;
        };

        // The repair is a broadcast: only claim to schedule it when the bot can
        // actually run a fill-less rebalance (same precondition the scheduler
        // itself checks), so the log never promises a repair that cannot run.
        if (typeof manager.performSafeRebalance !== 'function'
            || typeof bot.updateOrdersOnChainBatch !== 'function') {
            // No plan cycle can run on this path, so this sweep is the ONLY
            // ticker for the observation: advance the ledger before consulting it.
            const ready = streaks ? updateGapEvacuationStreaks(streaks, candidates).ready : tick.ready;
            const queued = queueTeeth(ready);
            manager.logger?.log?.(
                `[GAP-EVAC] ${stranded.length} live order(s) stranded inside the spread band ` +
                `(boundary ${manager.boundaryIdx}, gap ${gapSlots}): ${stranded.join(', ')} — ` +
                `no fill-less re-plan available on this path; teeth queued=${queued}`,
                // Warn only when this tick actually did something; a bot shape
                // without a re-plan path must not warn on every tick.
                queued > 0 ? 'warn' : 'debug'
            );
            return { stranded, scheduled: false };
        }

        const now = Date.now();
        const lastAt = _lastGapEvacRepairAt.get(bot as unknown as object) ?? 0;
        const cooling = lastAt > 0 && (now - lastAt) < GAP_EVAC_REPAIR_COOLDOWN_MS;
        if (cooling) {
            // The previous re-plan either is still in flight or did not clear
            // the stranding: fall back to the cancel-only teeth so a repeatedly
            // unfixable slot cannot sit in the band forever. Readiness comes from
            // the ledger as the PLAN cycles left it — scheduled re-plans keep
            // running through the cooldown and each ticks it once, so the sweep
            // must not count the same observation again.
            const queued = queueTeeth(tick.ready);
            manager.logger?.log?.(
                `[GAP-EVAC] ${stranded.length} live order(s) inside the spread band (${stranded.join(', ')}) — ` +
                `repair cooldown active (${Math.round((GAP_EVAC_REPAIR_COOLDOWN_MS - (now - lastAt)) / 1000)}s left); ` +
                `teeth queued=${queued}`,
                queued > 0 ? 'warn' : 'debug'
            );
            return { stranded, scheduled: false };
        }
        _lastGapEvacRepairAt.set(bot as unknown as object, now);
        manager.logger?.log?.(
            `[GAP-EVAC] ${stranded.length} live order(s) stranded inside the spread band ` +
            `(boundary ${manager.boundaryIdx}, gap ${gapSlots}): ${stranded.join(', ')} — ` +
            `scheduling a fill-less re-plan to evacuate (${context})`,
            'warn'
        );
        _schedulePostRecoveryRebalance(bot, `gap-evac repair (${context})`);
        return { stranded, scheduled: true };
    } catch (err) {
        bot.manager?.logger?.log?.(
            `[GAP-EVAC] Stranding sweep failed (non-fatal): ${getErrorMessage(err)}`,
            'debug'
        );
        return { stranded: [], scheduled: false };
    }
}

/**
 * Best-effort target-grid rebalance after a snapshot reload.
 *
 * Runs a no-fill COW rebalance so slots the reconcile-only sync could not
 * re-derive are re-placed. syncFromOpenOrders only reconciles existing slots;
 * an order that was fully consumed on chain while the persisted snapshot still
 * listed it leaves a permanent rail hole unless the target grid is re-derived
 * and the missing orders re-created. The COW machinery's own guards (fund
 * validation, create-slot validation, pending-broadcast protection, single
 * flight) keep this safe to run here.
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} context - Label for logging
 */
async function _rebalanceAfterRecovery(bot: BotLike, context: string) {
    if (!bot.manager || typeof bot.manager.performSafeRebalance !== 'function' || typeof bot.updateOrdersOnChainBatch !== 'function') {
        return;
    }
    try {
        const rebalanceResult = await bot.manager.performSafeRebalance([], new Set());
        if (!rebalanceResult || rebalanceResult.aborted) {
            // A deferred abort means owed work is still outstanding (broadcast
            // held the plan, or the identical-held-plan suppression is waiting
            // for a fresh fill). That wait can be indefinite on a stale grid
            // with no fills, so surface it — the spread-correction path and
            // the out-of-spread watchdog are the heal paths, not this scheduler.
            bot.manager.logger?.log?.(
                `[RECOVERY] Target-grid rebalance skipped after ${context} ` +
                `(${rebalanceResult?.reason || 'aborted'})`,
                rebalanceResult?.deferred ? 'warn' : 'debug'
            );
            return;
        }
        if (!hasExecutableActions(rebalanceResult)) {
            bot.manager.logger?.log?.(
                `[RECOVERY] Target-grid rebalance after ${context}: grid already consistent`,
                'debug'
            );
            // performSafeRebalance pushes a working grid for every non-aborted
            // result — including this empty-action one. Release it so the
            // rebalance stack stays balanced and _rebalanceState returns to
            // NORMAL (mirrors _executeBatchIfNeeded's no-action pop). Aborted
            // results are never pushed, so only this branch needs the pop.
            bot.manager?._popWorkingGridRef?.(rebalanceResult);
            return;
        }
        bot.manager.logger?.log?.(
            `[RECOVERY] Re-placing ${(rebalanceResult.actions ?? []).length} missing rail(s) after ${context}`,
            'info'
        );
        await bot.updateOrdersOnChainBatch(rebalanceResult);
    } catch (err) {
        bot.manager.logger?.log?.(
            `[RECOVERY] Target-grid rebalance after ${context} failed ` +
            `(will be handled by maintenance divergence check): ${getErrorMessage(err)}`,
            'warn'
        );
    }
}

/**
 * Schedule a best-effort target-grid rebalance after a recovery sync.
 *
 * The sync is often called from a batch-abort catch (handleBatchHardAbort /
 * recoverBatchSizeDrift) where a COW batch is still mid-teardown, or from flows
 * holding the fill lock — broadcasting a fresh batch there would race the batch's
 * own finally cleanup. Defer via a zero-delay timer and re-defer until both
 * `_batchInFlight` and `_recoverySyncInFlight` settle, so the rebalance always
 * runs in a clean context. At most one deferred rebalance is scheduled at a time.
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} context - Label for logging
 */
function _schedulePostRecoveryRebalance(bot: BotLike, context: string) {
    if (!bot.manager || typeof bot.manager.performSafeRebalance !== 'function' || typeof bot.updateOrdersOnChainBatch !== 'function') {
        return;
    }
    if (bot._postRecoveryRebalanceTimer) {
        return;
    }
    const run = () => {
        bot._postRecoveryRebalanceTimer = null;
        if (bot._shuttingDown) return;
        if (bot._batchInFlight > 0 || bot._recoverySyncInFlight > 0) {
            // Throttled visibility: a pipeline that never clears would
            // otherwise re-defer silently forever (the hang class of the
            // 2026-09-12 incident). First wait at debug, then a warn every
            // ~30s (120 x LOCK_REFRESH_MIN_MS) while still blocked.
            bot._postRecoveryRebalanceDefers = (bot._postRecoveryRebalanceDefers || 0) + 1;
            if (bot._postRecoveryRebalanceDefers === 1 || bot._postRecoveryRebalanceDefers % 120 === 0) {
                bot.manager?.logger?.log?.(
                    `[RECOVERY] Post-recovery rebalance (${context}) waiting for pipeline to clear ` +
                    `(batchInFlight=${bot._batchInFlight || 0}, recoverySyncInFlight=${bot._recoverySyncInFlight || 0}, waits=${bot._postRecoveryRebalanceDefers})`,
                    bot._postRecoveryRebalanceDefers === 1 ? 'debug' : 'warn'
                );
            }
            bot._postRecoveryRebalanceTimer = setTimeout(run, TIMING.LOCK_REFRESH_MIN_MS);
            return;
        }
        bot._postRecoveryRebalanceDefers = 0;
        _rebalanceAfterRecovery(bot, context);
    };
    bot._postRecoveryRebalanceTimer = setTimeout(run, 0);
}

/**
 * Reject a corrupted grid snapshot when catastrophic fund drift is detected.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {'startup'|'recovery'} context
 * @returns {Promise<boolean>}
 */
async function rejectCorruptedGridSnapshot(bot: BotLike, context: string) {
    if (!bot.manager?.checkFundDriftAfterFills) return false;
    // A drift measured while fills are queued/draining/deferred (or while a
    // COW/recovery batch is in flight) is NOT snapshot corruption: the queued
    // fills still have to move the grid/books. Deleting the snapshot here
    // destroys a valid grid and the following recovery does nothing
    // (2026-11-03: drift 6234.93639 == the two queued fills; another snapshot
    // rejected as corrupted while deferred fills were pending). Gate the
    // destructive decision on a settled pipeline.
    const pipeline = hasUnsettledFills(bot);
    const batchInFlight = Number((bot as unknown as { _batchInFlight?: unknown })._batchInFlight) || 0;
    const recoveryInFlight = Number((bot as unknown as { _recoverySyncInFlight?: unknown })._recoverySyncInFlight) || 0;
    const placementHeld = typeof bot.manager.isPlacementActive === 'function' && bot.manager.isPlacementActive() === true;
    const deferredRebalance = Number((bot.manager as unknown as { _deferredRebalanceAt?: unknown })._deferredRebalanceAt) || 0;
    if (pipeline.unsettled || batchInFlight > 0 || recoveryInFlight > 0 || placementHeld || deferredRebalance > 0) {
        const why = pipeline.reason
            || (batchInFlight > 0 ? 'batch in flight'
                : recoveryInFlight > 0 ? 'recovery sync in flight'
                    : placementHeld ? `placement region held by ${bot.manager.placementKind?.() || 'unknown'}`
                        : 'deferred rebalance pending');
        bot._warn?.(
            `[SNAPSHOT-REJECT] Skipping corruption check (${context}): pipeline not settled — ` +
            `${why}; the snapshot is preserved and re-checked once fills settle`
        );
        return false;
    }
    const driftCheck = bot.manager.checkFundDriftAfterFills();
    if (driftCheck.isValid) return false;

    const tag = context === 'recovery' ? '[RECOVERY][SNAPSHOT-REJECT]' : '[SNAPSHOT-REJECT]';
    bot._warn(
        `${tag} Corrupted grid snapshot detected: ` +
        `drift sell=${Number(driftCheck.driftSell ?? 0).toFixed(2)} buy=${Number(driftCheck.driftBuy ?? 0).toFixed(2)}. ` +
        `Deleting corrupted snapshot.`
    );
    if (bot.accountOrders && typeof bot.accountOrders.clearGrid === 'function') {
        // Keep a timestamped copy before the destructive clear. Drift is not
        // always corruption (genuine unadopted orphans, re-anchoring), so the
        // pre-reject grid/boundary/pivot/crawls are the only forensics and the
        // only path to manual recovery. AccountOrders owns the path/storage
        // knowledge. Best-effort: the clear proceeds either way.
        try {
            const backupPath = typeof bot.accountOrders.backupSnapshot === 'function'
                ? await bot.accountOrders.backupSnapshot('rejected-drift')
                : null;
            if (backupPath) {
                bot._warn(`${tag} Kept pre-reject snapshot copy at ${backupPath}`);
            }
        } catch (backupErr: unknown) {
            bot._warn(`${tag} Failed to keep pre-reject snapshot copy: ${getErrorMessage(backupErr)}`);
        }
        try {
            await bot.accountOrders.clearGrid();
            bot._warn(`${tag} Corrupted grid snapshot deleted.`);
        } catch (clearErr: unknown) {
            bot._warn(`${tag} Failed to delete corrupted snapshot: ${getErrorMessage(clearErr)}`);
        }
    }
    // P4: clear in-memory boundary together with snapshot so a stale
    // restored value (e.g. 131 in the incident) is not reused for rebuild.
    // clearGrid() already wiped persisted boundaryIdx; also clear manager
    // state so P3 re-derivation starts from a clean null boundary.
    const mgrRecovery = bot.manager as unknown as {
        _restoreBoundary?(value: unknown): void;
        boundaryIdx?: number | null;
        _clearPendingFillCrawls?(reason?: string): void;
        _resetLastFillPivot?(reason?: string): void;
    };
    try {
        mgrRecovery._restoreBoundary?.(null);
    } catch {}
    mgrRecovery.boundaryIdx = null;
    // Owed crawls belonged to the rejected generation: the rebuild re-anchors
    // the boundary absolutely, so applying their relative deltas would
    // double-count the movement the new anchor already contains. clearGrid()
    // wiped the persisted copy; drop the in-memory record (marks the grid
    // dirty so the wipe reaches disk on the next flush too).
    mgrRecovery._clearPendingFillCrawls?.('grid snapshot rejected');
    // The LAST-FILL-GUARD pivot was armed against the rejected generation's
    // geometry: drop it so the rebuild re-arms on a fresh fill instead of
    // vetoing placements against a boundary that no longer exists.
    try {
        if (typeof mgrRecovery._resetLastFillPivot === 'function') {
            mgrRecovery._resetLastFillPivot('grid snapshot rejected');
        } else {
            resetLastFillPivot(bot.manager, 'grid snapshot rejected');
        }
    } catch {}
    return true;
}

/**
 * Attempt to repair size-drift for specific order IDs from chain state.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string[]} orderIds
 * @returns {Promise<boolean>}
 */
async function targetedOrderRepair(bot: BotLike, orderIds: string[]) {
    try {
        const objects = await BitShares.db.get_objects(orderIds);
        if (!Array.isArray(objects) || objects.length !== orderIds.length) return false;

        const updates: unknown[] = [];
        for (let i = 0; i < orderIds.length; i++) {
            const chainOrder = objects[i];
            const gridOrder = (Array.from(bot.manager.orders.values()) as ManagedOrder[])
                .find((o) => o.orderId === orderIds[i]);
            if (!gridOrder) continue;

            if (!chainOrder || typeof chainOrder.for_sale === 'undefined') {
                bot.manager.logger.log(
                    `[RECOVERY] fill-cleanup: converting ${gridOrder.id} (${gridOrder.type}, size=${gridOrder.size}) to SPREAD placeholder`,
                    'debug'
                );
                updates.push(convertToSpreadPlaceholder(gridOrder));
            } else {
                const chainUnits = Number(chainOrder.for_sale);
                if (Number.isFinite(chainUnits)) {
                    const prec = gridOrder.type === ORDER_TYPES.SELL
                        ? bot.manager.assets.assetA.precision
                        : bot.manager.assets.assetB.precision;
                    const floatSize = blockchainToFloat(chainUnits, prec);
                    if (floatSize !== gridOrder.size) {
                        updates.push({
                            id: gridOrder.id,
                            size: floatSize,
                            rawOnChain: chainOrder,
                        });
                    }
                }
            }
        }

        if (updates.length > 0) {
            await bot._applyRecoverableGridUpdates(updates, 'targeted-size-drift-repair');
        }
        return true;
    } catch (err: unknown) {
        bot.manager.logger.log(
            `[COW] Targeted order repair failed: ${getErrorMessage(err)}`,
            'debug'
        );
        return false;
    }
}

export { persistAndRecoverIfNeeded, getRecentFillKeysSnapshot, triggerStateRecoverySync, abortFlowIfIllegalState, handleBatchHardAbort, applyRecoverableGridUpdates, recoverExplicitStaleOrders, recoverBatchSizeDrift, recoverFromPersistedGrid, rejectCorruptedGridSnapshot, targetedOrderRepair, scheduleGapEvacRepair, _schedulePostRecoveryRebalance as schedulePostRecoveryRebalance }


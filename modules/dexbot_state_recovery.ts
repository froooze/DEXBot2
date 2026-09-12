/** State recovery runtime - grid persistence, recovery sync, size-drift repair */

import * as client from './bitshares_client.js';
const { BitShares } = client;
import * as chainOrders from './chain_orders.js';
import { readOpenOrdersGuarded } from './chain_orders.js';
import { ORDER_TYPES, TIMING } from './constants.js';
import * as Format from './order/format.js';
import * as grid from './order/grid.js';
import { convertToSpreadPlaceholder, parseChainOrder, isNonBlockingUnmatchedOrder } from './order/utils/order.js';
import { restoreGapEvacStreaks, applyPersistedPendingCrawls } from './order/utils/system.js';
import { blockchainToFloat, calculateGapSlots, validatePersistedBoundary } from './order/utils/math.js';
import { hasExecutableActions } from './order/utils/validate.js';
import { getErrorMessage } from './utils/errors.js';
const { isGridBloated } = grid;

/**
 * Persist the current grid state and trigger recovery if validation fails.
 * @param {import('./dexbot_class.js').DEXBot} bot
 */
async function persistAndRecoverIfNeeded(bot: any) {
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
function getRecentFillKeysSnapshot(bot: any) {
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
async function triggerStateRecoverySync(bot: any, reason: any = 'state recovery sync') {
    if (!bot.manager) return;

    if (bot._recoverySyncInFlight) {
        bot.manager.logger.log(`[RECOVERY] Skipping duplicate recovery request: ${reason}`, 'warn');
        return;
    }

    bot._recoverySyncInFlight++;
    try {
        bot.manager.logger.log(`Triggering state recovery sync (${reason})...`, 'info');
        await bot.manager.fetchAccountTotals(bot.accountId);
        // Truncated-read guard: syncing on a partial get_full_accounts window
        // would virtualize live ACTIVE slots (pass-1 phantom cleanup) and let
        // the next cycle re-create them as duplicates. Defer to a clean read.
        const openOrders = await readOpenOrdersGuarded(chainOrders, bot.accountId, {
            log: (message: string, level: any) => bot.manager.logger.log(message, level),
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
    } catch (err: any) {
        bot.manager.logger.log(
            `[RECOVERY] State recovery sync (${reason}) failed: ${getErrorMessage(err)}. Preserving current state; the next sync cycle will retry.`,
            'error'
        );
    } finally {
        bot._recoverySyncInFlight--;
    }
}

/**
 * Abort the current flow if an illegal state signal was raised.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} flowContext
 * @returns {Promise<boolean>}
 */
async function abortFlowIfIllegalState(bot: any, flowContext: any) {
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
async function handleBatchHardAbort(bot: any, err: any, phase: any = 'batch processing', opsCount: any = 0) {
    const baseResult = { executed: false, hadRotation: false };
    const opsInfo = opsCount > 0 ? ` with ${opsCount} ops` : '';

    if (err?.code === 'ACCOUNTING_COMMITMENT_FAILED') {
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
async function applyRecoverableGridUpdates(bot: any, updates: any, context: any = 'recoverable-grid-update') {
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
            await bot.manager._updateOrder(update, context);
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
async function recoverExplicitStaleOrders(bot: any, staleOrderIds: any, reason: any = 'stale order cleanup') {
    const staleIds = Array.from(staleOrderIds || []).filter(Boolean) as string[];
    if (staleIds.length === 0) {
        return { executed: false, hadRotation: false, stale: false };
    }
    const staleIdSet = new Set(staleIds);

    bot.manager.logger.log(
        `[COW] Stale order(s) detected: ${staleIds.join(', ')}. Applying targeted cleanup.`,
        'warn'
    );

    const updates: any[] = [];

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
async function recoverBatchSizeDrift(bot: any, err: any, opContexts: any = []) {
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
function extractSizeDriftOrderIds(opContexts: any) {
    if (!Array.isArray(opContexts)) return [];
    const ids = new Set();
    for (const ctx of opContexts) {
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
async function recoverFromPersistedGrid(bot: any) {
    if (!bot.accountOrders || !bot.manager) {
        return { success: false, reason: 'accountOrders or manager unavailable' };
    }

    const accountRef = bot.accountId || bot.account?.id || bot.account;
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
            if (!check.ok) {
                bot.manager.logger.log(
                    `[RECOVERY] Persisted boundary failed validation (${check.reason}: ${check.detail}). ` +
                    `Rejecting snapshot so structural resync rebuilds clean geometry.`,
                    'error'
                );
                return { success: false, reason: `persisted boundary rejected (${check.reason})` };
            }
        }

        const persistedGenesis = bot.accountOrders.loadGenesis?.(true) ?? null;
        await grid.loadGrid(bot.manager, persistedGrid, boundaryIdx, persistedGenesis);
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
                log: (message: string, level?: any) => bot.manager.logger.log(message, level)
            });
        } catch (pendingErr: any) {
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
                (bot.manager as any)._restoreBoundary?.(null);
            } catch {}
            (bot.manager as any).boundaryIdx = null;
            return { success: false, reason: 'corrupted grid snapshot rejected (fund drift)' };
        }

        // Truncated-read guard: syncing on a partial get_full_accounts window
        // would virtualize live ACTIVE slots (pass-1 phantom cleanup) and
        // re-create them as duplicates. A reload that cannot reconcile with
        // chain did not complete its contract — fail so the caller escalates
        // to a structural resync (which defers the same way on a clean read).
        let chainOpenOrders = await readOpenOrdersGuarded(chainOrders, accountRef, {
            log: (message: string, level: any) => bot.manager.logger.log(message, level),
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
                .map((s: any) => s && s.orderId)
                .filter((id: any) => id && /^1\.7\.\d+$/.test(String(id)));
            let recoveredById: any[] | null = null;
            if (knownIds.length > 0 && typeof chainOrders.batchReadOrders === 'function') {
                try {
                    const map = await chainOrders.batchReadOrders(knownIds);
                    const byId: any[] = [];
                    if (map && typeof map.forEach === 'function') {
                        map.forEach((o: any) => { if (o) byId.push(o); });
                    }
                    recoveredById = byId;
                } catch (byIdErr: any) {
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
            ? chainOpenOrders.filter((o: any) => parseChainOrder(o, assets) !== null).length
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
        const blockingUnmatched = remainingUnmatched.filter((u: any) => !isNonBlockingUnmatchedOrder(u));
        if (blockingUnmatched.length > 0) {
            const sample = blockingUnmatched.slice(0, 3)
                .map((o: any) => bot._formatUnmatchedChainOrderForLog(o))
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
        if (bloatPostRecovery.bloated) {
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
    } catch (err: any) {
        bot.manager.logger.log(
            `[RECOVERY] Full grid reload from persisted snapshot failed: ${getErrorMessage(err)}`,
            'error'
        );
        return { success: false, reason: getErrorMessage(err) };
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
async function _rebalanceAfterRecovery(bot: any, context: any) {
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
            `[RECOVERY] Re-placing ${rebalanceResult.actions.length} missing rail(s) after ${context}`,
            'info'
        );
        await bot.updateOrdersOnChainBatch(rebalanceResult);
    } catch (err: any) {
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
function _schedulePostRecoveryRebalance(bot: any, context: any) {
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
async function rejectCorruptedGridSnapshot(bot: any, context: any) {
    if (!bot.manager?.checkFundDriftAfterFills) return false;
    const driftCheck = bot.manager.checkFundDriftAfterFills();
    if (driftCheck.isValid) return false;

    const tag = context === 'recovery' ? '[RECOVERY][SNAPSHOT-REJECT]' : '[SNAPSHOT-REJECT]';
    bot._warn(
        `${tag} Corrupted grid snapshot detected: ` +
        `drift sell=${driftCheck.driftSell.toFixed(2)} buy=${driftCheck.driftBuy.toFixed(2)}. ` +
        `Deleting corrupted snapshot.`
    );
    if (bot.accountOrders && typeof bot.accountOrders.clearGrid === 'function') {
        try {
            await bot.accountOrders.clearGrid();
            bot._warn(`${tag} Corrupted grid snapshot deleted.`);
        } catch (clearErr: unknown) {
            bot._warn(`${tag} Failed to delete corrupted snapshot: ${(clearErr as any)?.message ?? clearErr}`);
        }
    }
    // P4: clear in-memory boundary together with snapshot so a stale
    // restored value (e.g. 131 in the incident) is not reused for rebuild.
    // clearGrid() already wiped persisted boundaryIdx; also clear manager
    // state so P3 re-derivation starts from a clean null boundary.
    try {
        (bot.manager as any)._restoreBoundary?.(null);
    } catch {}
    (bot.manager as any).boundaryIdx = null;
    // Owed crawls belonged to the rejected generation: the rebuild re-anchors
    // the boundary absolutely, so applying their relative deltas would
    // double-count the movement the new anchor already contains. clearGrid()
    // wiped the persisted copy; drop the in-memory record (marks the grid
    // dirty so the wipe reaches disk on the next flush too).
    (bot.manager as any)._clearPendingFillCrawls?.('grid snapshot rejected');
    return true;
}

/**
 * Attempt to repair size-drift for specific order IDs from chain state.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string[]} orderIds
 * @returns {Promise<boolean>}
 */
async function targetedOrderRepair(bot: any, orderIds: any) {
    try {
        const objects = await BitShares.db.get_objects(orderIds);
        if (!Array.isArray(objects) || objects.length !== orderIds.length) return false;

        const updates: any[] = [];
        for (let i = 0; i < orderIds.length; i++) {
            const chainOrder = objects[i];
            const gridOrder = (Array.from(bot.manager.orders.values()) as any[])
                .find((o: any) => o.orderId === orderIds[i]);
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
            `[COW] Targeted order repair failed: ${(err as any)?.message ?? err}`,
            'debug'
        );
        return false;
    }
}

export { persistAndRecoverIfNeeded, getRecentFillKeysSnapshot, triggerStateRecoverySync, abortFlowIfIllegalState, handleBatchHardAbort, applyRecoverableGridUpdates, recoverExplicitStaleOrders, recoverBatchSizeDrift, extractSizeDriftOrderIds, recoverFromPersistedGrid, rejectCorruptedGridSnapshot, targetedOrderRepair, _schedulePostRecoveryRebalance as schedulePostRecoveryRebalance }


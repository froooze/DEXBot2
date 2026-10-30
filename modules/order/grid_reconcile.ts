import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import {
    _countActiveOnGrid, _cancelChainOrder, _recoverStartupSyncFailure,
    _refreshStartupUpdatePlans,
    _executeStartupUpdateBatch,
    _executeStartupSequentialUpdateFallback,
    _executePlannedStartupCreates, _reconcileStartupSide,
} from './grid_reconcile_internal.js';
import { ORDER_TYPES, ORDER_STATES, TIMING } from '../constants.js';
import { readOpenOrdersGuarded } from '../chain_orders.js';
import { getAssetFeesSafe, pricesOnSameLevel } from './utils/math.js';
import {
    isOrderPlaced, parseChainOrder, isOrderOnChain, findLiveOrderOwnerByChainId,
    chainOrderMatchesSlotWithTolerance,
    duplicateOrphanLogInfo, resolveEdgeCount,
} from './utils/order.js';
import * as Format from './format.js';
import { getErrorMessage } from '../utils/errors.js';
import type { OrderManagerLike, ChainOrder, ChainOrdersLike, ManagedOrder, ParsedChainEntry, PendingPriceCorrection, GridConfig, LoggerLike, StartupCancelPlan, StartupUpdatePlan, StartupCreatePlan } from '../types.js';

function _startupChainSnapshotSignature(orders: ChainOrder[], manager: OrderManagerLike): Map<string, string> {
    const signature = new Map<string, string>();
    for (const raw of Array.isArray(orders) ? orders : []) {
        if (!raw?.id) continue;
        const parsed = parseChainOrder(raw, manager.assets);
        if (!parsed) continue;
        signature.set(String(raw.id), `${parsed.type}|${parsed.price}|${parsed.size}`);
    }
    return signature;
}

/**
 * Validate a Phase-1 startup cancellation immediately before Phase 2.
 * The plan is only safe if its specific chain order is still unchanged and
 * the live grid still has the same ownership/role that justified the
 * cancellation. Other orders may have legitimately changed since planning.
 */
function _startupCancelPlanStillCurrent(
    plan: StartupCancelPlan,
    manager: OrderManagerLike,
    initialChainSignature: Map<string, string>,
    currentChainSignature: Map<string, string>
): boolean {
    const chainOrderId = String(plan?.chainOrderId || '');
    if (!chainOrderId || !currentChainSignature.has(chainOrderId)) return false;
    if (currentChainSignature.get(chainOrderId) !== initialChainSignature.get(chainOrderId)) return false;

    if (plan.gridOrderId) {
        if (plan.boundaryIdx !== undefined && (
            plan.boundaryIdx !== manager?.boundaryIdx || plan.gapSlots !== manager?._gapSlots
        )) return false;
        const slot = manager?.orders instanceof Map ? manager.orders.get(plan.gridOrderId) : null;
        if (!slot || !isOrderOnChain(slot) || slot.orderId !== plan.chainOrderId) return false;
        if (plan.orderType && slot.type !== plan.orderType) return false;
        if (plan.gridOrder && Number.isFinite(Number(plan.gridOrder.price))
            && Number(slot.price) !== Number(plan.gridOrder.price)) return false;
        return true;
    }

    // An originally unmatched plan is safe only while the chain order is still
    // untracked. If it has since been adopted into any live slot, skip it.
    return !findLiveOrderOwnerByChainId(manager, plan.chainOrderId);
}

/**
 * Resume a persisted grid whose order ids no longer match the book, by
 * re-adopting the live chain orders into the frozen ladder (nearest-slot).
 *
 * The name is historical: there is no price matcher here any more. It loads the
 * persisted grid (which establishes the price ladder, or is refused with
 * MissingGenesisError and reported as "not resumed") and lets the normal sync
 * bind each live chain order to the slot its price maps to. A grid whose ladder
 * is unusable never resumes — the caller regenerates.
 *
 * Returns { resumed: boolean, matchedCount: number }.
 * @param {Object} params - Destructured parameters
 * @param {Object} params.manager - OrderManager instance
 * @param {Array<Object>} params.persistedGrid - Persisted grid orders
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @param {Object} params.logger - Logger instance
 * @param {Function} params.storeGrid - Grid persistence callback
 * @returns {Promise<{resumed: boolean, matchedCount: number}>}
 */
export async function attemptResumePersistedGridByPriceMatch({
    manager,
    persistedGrid,
    chainOpenOrders,
    logger,
    storeGrid,
    boundaryIdx = null,
    genesis = null,
}: {
    manager: OrderManagerLike;
    persistedGrid: ManagedOrder[];
    chainOpenOrders: ChainOrder[];
    logger: LoggerLike;
    storeGrid: (orders: ManagedOrder[]) => unknown;
    boundaryIdx?: number | null;
    genesis?: unknown;
}): Promise<{ resumed: boolean; matchedCount: number }> {
    if (!Array.isArray(persistedGrid) || persistedGrid.length === 0) return { resumed: false, matchedCount: 0 };
    if (!Array.isArray(chainOpenOrders) || chainOpenOrders.length === 0) return { resumed: false, matchedCount: 0 };
    if (!manager || typeof manager.synchronizeWithChain !== 'function') return { resumed: false, matchedCount: 0 };

    try {
        logger && logger.log && logger.log('No matching active order IDs found. Attempting to re-adopt by ladder level...', 'info');
        const { loadGrid } = require('./grid');
        // Prefer explicit genesis if caller wired it, else fall back to manager._genesis
        const genesisArg = genesis ?? manager._genesis ?? null;
        // This is a resume/adoption path, not a poison-ingestion path. Pure
        // in-band stranding is the normal SPREAD-GUARD / partial-fill-anchor
        // state and GAP-EVAC owns cleanup; keep the persisted boundary so a
        // re-anchor surviving in the snapshot is not rebuilt away here.
        await loadGrid(manager, persistedGrid, boundaryIdx, genesisArg, { tolerateTransientStranding: true });
        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

        const matchedOrderIds = new Set(
            (Array.from(manager.orders.values()))
                .filter((o) => o && isOrderOnChain(o))
                .map((o) => o.orderId)
                .filter(Boolean)
        );

        if (matchedOrderIds.size === 0) {
            logger && logger.log && logger.log('Ladder-level re-adoption found no matches. Generating new grid.', 'info');
            return { resumed: false, matchedCount: 0 };
        }

        logger && logger.log && logger.log(`Successfully re-adopted ${matchedOrderIds.size} orders by ladder level. Resuming with existing grid.`, 'info');
        if (typeof storeGrid === 'function') {
            await storeGrid(Array.from(manager.orders.values()));
        }
        return { resumed: true, matchedCount: matchedOrderIds.size };
    } catch (err) {
        logger && logger.log && logger.log(`Ladder-level resume attempt failed: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`, 'warn');
        return { resumed: false, matchedCount: 0 };
    }
}

/**
 * Decide whether a startup should regenerate the grid or resume a persisted grid.
 *
 * Resulting behavior matches the existing startup policy:
 * - If no persisted grid -> regenerate
 * - If any persisted ACTIVE orderId exists on-chain -> resume
 * - Else if there are on-chain orders -> attempt price-based matching; resume if it matches any
 * - Else -> regenerate
 * @param {Object} params - Destructured parameters
 * @param {Array<Object>} params.persistedGrid - Persisted grid orders
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @param {Object} params.manager - OrderManager instance
 * @param {Object} params.logger - Logger instance
 * @param {Function} params.storeGrid - Grid persistence callback
 * @param {Function} [params.attemptResumeFn=attemptResumePersistedGridByPriceMatch] - Resume function
 * @returns {Promise<Object>} { shouldRegenerate, hasActiveMatch, resumedByPrice, matchedCount }
 */
export async function decideStartupGridAction({
    persistedGrid,
    chainOpenOrders,
    manager,
    logger,
    storeGrid,
    boundaryIdx = null,
    genesis = null,
    attemptResumeFn = attemptResumePersistedGridByPriceMatch,
}: {
    persistedGrid: ManagedOrder[];
    chainOpenOrders: ChainOrder[];
    manager: OrderManagerLike;
    logger: LoggerLike;
    storeGrid: (orders: ManagedOrder[]) => unknown;
    boundaryIdx?: number | null;
    genesis?: unknown;
    attemptResumeFn?: typeof attemptResumePersistedGridByPriceMatch;
}) {
    const persisted = Array.isArray(persistedGrid) ? persistedGrid : [];
    const chain = Array.isArray(chainOpenOrders) ? chainOpenOrders : [];

    if (persisted.length === 0) {
        return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
    }

    const chainOrderIds = new Set(chain.map(o => o && o.id).filter(Boolean));
    const hasActiveMatch = persisted.some(order => order && order.state === ORDER_STATES.ACTIVE && order.orderId && chainOrderIds.has(order.orderId));
    if (hasActiveMatch) {
        return { shouldRegenerate: false, hasActiveMatch: true, resumedByPrice: false, matchedCount: 0 };
    }

    if (chain.length > 0) {
        const resume = await attemptResumeFn({ manager, persistedGrid: persisted, chainOpenOrders: chain, logger, storeGrid, boundaryIdx, genesis });
        return { shouldRegenerate: !resume.resumed, hasActiveMatch: false, resumedByPrice: !!resume.resumed, matchedCount: resume.matchedCount || 0 };
    }

    return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
}

/**
 * Reconcile existing on-chain orders to a newly generated grid.
 *
 * Policy (per side):
 * - Prefer updating existing unmatched chain orders to match the target grid slots.
 * - Then create missing orders if chain has fewer than target.
 * - Then cancel excess orders if chain has more than target.
 *
 * Targets are derived from config.coreOrders.{buy,sell} and chain counts are computed
 * from current on-chain open orders.
 * @param {Object} params - Destructured parameters
 * @param {Object} params.manager - OrderManager instance
 * @param {Object} params.config - Bot configuration
 * @param {string} params.account - Account ID or name
 * @param {string} params.privateKey - Active/owner private key
 * @param {Function} params.chainOrders - Chain order query function
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @returns {Promise<Object|null>} Reconciliation result, or null when reconciliation completes without a summary object
 */
export async function reconcileGridOrders({
    manager,
    config,
    account,
    privateKey,
    chainOrders,
    chainOpenOrders,
}: {
    manager: OrderManagerLike;
    config: GridConfig;
    account: string;
    privateKey: string;
    chainOrders: ChainOrdersLike;
    chainOpenOrders: ChainOrder[];
}) {
    // Parameter validation
    if (!manager || typeof manager.synchronizeWithChain !== 'function') {
        throw new Error('reconcileGridOrders: manager must be provided with synchronizeWithChain method');
    }
    if (typeof manager.getOrdersByTypeAndState !== 'function') {
        throw new Error('reconcileGridOrders: manager.getOrdersByTypeAndState method not found');
    }
    if (!account || !privateKey) {
        throw new Error('reconcileGridOrders: account and privateKey are required');
    }
    if (!chainOrders || typeof chainOrders.cancelOrder !== 'function' || typeof chainOrders.createOrder !== 'function') {
        throw new Error('reconcileGridOrders: chainOrders must provide cancelOrder and createOrder methods');
    }
    if (typeof chainOrders.readOpenOrders !== 'function') {
        throw new Error('reconcileGridOrders: chainOrders.readOpenOrders is required for recovery sync');
    }
    const supportsBatchUpdate = typeof chainOrders.buildUpdateOrderOp === 'function' && typeof chainOrders.executeBatch === 'function';
    const supportsSequentialUpdate = typeof chainOrders.updateOrder === 'function';
    if (!supportsBatchUpdate && !supportsSequentialUpdate) {
        throw new Error('reconcileGridOrders: chainOrders must provide updateOrder or (buildUpdateOrderOp + executeBatch) for startup updates');
    }

    const logger = manager && manager.logger;
    const dryRun = !!(config && config.dryRun);

    const parsedChain: ParsedChainEntry[] = (chainOpenOrders || [])
        .map((co) => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
        .filter((x): x is ParsedChainEntry => x.parsed !== null);

    const activeCfg = (config && config.coreOrders) ? config.coreOrders : {};
    let targetBuy = Math.max(0, Number.isFinite(Number(activeCfg.buy)) ? Number(activeCfg.buy) : 1)
        + resolveEdgeCount(config, 'buy');
    let targetSell = Math.max(0, Number.isFinite(Number(activeCfg.sell)) ? Number(activeCfg.sell) : 1)
        + resolveEdgeCount(config, 'sell');

    const chainBuys = parsedChain.filter((x) => x.parsed.type === ORDER_TYPES.BUY).map((x) => x.chain);
    const chainSells = parsedChain.filter((x) => x.parsed.type === ORDER_TYPES.SELL).map((x) => x.chain);

    // PHASE 1: In-memory reconciliation under lock — pure planning, no blockchain I/O.
    // All cancellations are collected into plannedCancels and executed in Phase 2.
    // This keeps the lock hierarchy clean (no _gridLock held across sync calls).
    const phase1Result = await manager._gridLock.acquire(async () => {
        if (typeof manager._applyOrderUpdate !== 'function') {
            throw new Error('manager._applyOrderUpdate is required for startup reconciliation');
        }
        const applyUpdate = manager._applyOrderUpdate.bind(manager);

        const chainIds = new Set<string>((Array.isArray(chainOpenOrders) ? chainOpenOrders : []).map(o => o?.id).filter((id): id is string => Boolean(id)));
        for (const order of manager.orders.values()) {
            if (isOrderPlaced(order)) {
                if (!order.orderId || !chainIds.has(order.orderId)) {
                    // Absence-decision guard: only virtualize as a phantom when
                    // the absence is trustworthy. An orderId assigned within the
                    // sync-lock window may be an in-flight create/adopt whose
                    // broadcast has not landed or is not yet visible to a
                    // lagging/truncated read. Virtualizing it here and
                    // re-creating would duplicate a real live order (the
                    // reconcile-timeout death-spiral root cause). Mirror the
                    // sync_engine committed-order guard; ghost orders (PARTIAL +
                    // size=0) still pass through so known fills get cleaned up.
                    const assignedAt = manager._orderIdAssignedAt?.get(order.orderId ?? '') || 0;
                    const isGhost = order.size <= 0 && order.state === ORDER_STATES.PARTIAL;
                    if (!isGhost && assignedAt > 0 && Date.now() - assignedAt < TIMING.SYNC_LOCK_TIMEOUT_MS) {
                        logger?.log?.(
                            `Startup: Order ${order.id} (ID ${order.orderId}) absent from snapshot but freshly assigned ` +
                            `(${Date.now() - assignedAt}ms ago); deferring phantom cleanup (duplicate-order protection).`,
                            'warn'
                        );
                        continue;
                    }
                    logger?.log?.(`Startup: Found phantom order ${order.id} (ID ${order.orderId}) not on chain. Resetting to VIRTUAL.`, 'warn');

                    await applyUpdate({
                        ...order,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: "",
                        rawOnChain: null
                    }, 'startup-phantom', { skipAccounting: true });
                }
            }
        }

        const matchedChainOrderIds = new Set<string>();
        for (const gridOrder of manager.orders.values()) {
            if (gridOrder && gridOrder.orderId) {
                matchedChainOrderIds.add(gridOrder.orderId);
            }
        }

        const unmatchedChain = (Array.isArray(chainOpenOrders) ? chainOpenOrders : []).filter((co) => co && !matchedChainOrderIds.has(co.id));
        let unmatchedParsed: ParsedChainEntry[] = unmatchedChain
            .map((co) => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter((x): x is ParsedChainEntry => x.parsed !== null);

        const plannedCancels: StartupCancelPlan[] = [];
        const cancelledDuplicateIds = new Set<string>();
        const activeGridOrders = (Array.from(manager.orders.values())).filter((o) => o && o.orderId && isOrderPlaced(o));
        // Update-first policy: unmatched chain orders are NEVER cancelled here.
        // They flow into _reconcileStartupSide below, which price-updates them onto
        // rail slots in a single batch (plannedUpdates), creates missing orders, and
        // cancels only true surplus (chainCount > targetCount). Pre-emptive
        // cancellation would turn one batched update into per-order cancel+create
        // churn and strip the bot's own live orders during a reset.
        for (const u of unmatchedParsed) {
            const p = u.parsed!;
            const desc = `Unmatched chain order: ${p.orderId} (${p.type === ORDER_TYPES.BUY ? 'BUY' : 'SELL'}), price=${Format.formatPrice6(p.price)}, size=${Format.formatSizeByOrderType(p.size ?? 0, p.type, manager.assets)}`;
            let nearest: { gridOrder: ManagedOrder; priceDiff: number; isEqual: boolean } | null = null;
            for (const gridOrder of activeGridOrders) {
                if (gridOrder.type !== p.type) continue;
                // Tolerance-based level check, NOT priceSlotEqual at the asset
                // precision (a low-precision asset collapses adjacent levels).
                const isEqual = pricesOnSameLevel(p.price, p.size ?? 0, p.type, gridOrder.price, gridOrder.size, gridOrder.type, manager.assets, manager.config?.incrementPercent);
                const priceDiff = Math.abs(p.price - gridOrder.price);
                const candidate = { gridOrder, priceDiff, isEqual };
                if (!nearest || priceDiff < nearest.priceDiff) nearest = candidate;
            }
            if (nearest && nearest.isEqual) {
                // The sync layer already owns this duplicate: PASS 2 queues a
                // cancel-only correction, and startup runs it (correctAllPriceMismatches)
                // before reconcile — leaving a stale snapshot where the order is already
                // cancelled. Defer to the correction so a single orphan is cancelled once,
                // but restore the untracked-fund accounting its cancel-only path does not
                // perform (reconcile's Phase-2 cancel used to do it via releaseUntrackedFunds).
                const alreadyQueued = Array.isArray(manager.ordersNeedingPriceCorrection) &&
                    manager.ordersNeedingPriceCorrection.some((q) => q?.chainOrderId === p.orderId && q?.cancelOnly === true);
                const alreadyCancelled = typeof chainOrders.wasRecentlyOwnCancelled === 'function' &&
                    chainOrders.wasRecentlyOwnCancelled(p.orderId);
                if (alreadyQueued || alreadyCancelled) {
                    if (manager.accountant && manager._fundLock && p.size != null && p.size > 0) {
                        const size = p.size;
                        await manager._fundLock.acquire(async () => {
                            await manager.accountant.addToChainFree(p.type, size, 'startup-skip-duplicate');
                        });
                    }
                    cancelledDuplicateIds.add(p.orderId);
                    continue;
                }
                const { level, suffix } = duplicateOrphanLogInfo(p.orderId);
                logger?.log?.(
                    `SUSPECTED DUPLICATE: ${desc} - nearest active grid ${nearest.gridOrder.id} ` +
                    `(orderId=${nearest.gridOrder.orderId}, price=${Format.formatPrice6(nearest.gridOrder.price)}, ` +
                    `diff=${Format.formatPrice6(nearest.priceDiff)}, slotEqual=${nearest.isEqual})${suffix}`,
                    level
                );
                // Queue duplicate for Phase 2 cancellation instead of executing under lock
                cancelledDuplicateIds.add(p.orderId);
                plannedCancels.push({
                    chainOrderId: p.orderId,
                    chainOrderObj: u.chain,
                    releaseUntrackedFunds: true,
                });
            } else if (nearest) {
                logger?.log?.(
                    `${desc}; nearest active same-side grid ${nearest.gridOrder.id} ` +
                    `(orderId=${nearest.gridOrder.orderId}, price=${Format.formatPrice6(nearest.gridOrder.price)}, ` +
                    `diff=${Format.formatPrice6(nearest.priceDiff)}, slotEqual=${nearest.isEqual})`,
                    'warn'
                );
            } else {
                logger?.log?.(`${desc}; no active same-side grid order exists`, 'warn');
            }
        }

        if (cancelledDuplicateIds.size > 0) {
            unmatchedParsed = unmatchedParsed.filter((u) => !cancelledDuplicateIds.has(u.parsed.orderId));
        }

        let unmatchedBuys = unmatchedParsed.filter((x) => x.parsed.type === ORDER_TYPES.BUY).map((x) => x.chain);
        let unmatchedSells = unmatchedParsed.filter((x) => x.parsed.type === ORDER_TYPES.SELL).map((x) => x.chain);
        const plannedCreates: StartupCreatePlan[] = [];
        const plannedUpdates: StartupUpdatePlan[] = [];

        logger && logger.log && logger.log(
            `Startup reconcile starting: unmatched(sell=${unmatchedSells.length}, buy=${unmatchedBuys.length}), target(sell=${targetSell}, buy=${targetBuy})`,
            'info'
        );

        const sellResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.SELL,
            targetCount: targetSell,
            chainSideOrders: chainSells,
            unmatchedSideOrders: unmatchedSells,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
            plannedCancels,
            planOnly: true,
        });

        const buyResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY,
            targetCount: targetBuy,
            chainSideOrders: chainBuys,
            unmatchedSideOrders: unmatchedBuys,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
            plannedCancels,
            planOnly: true,
        });

        return { plannedCreates, plannedUpdates, plannedCancels, chainSellCount: sellResult.chainCount, chainBuyCount: buyResult.chainCount };
    });

    // PHASE 2: Blockchain operations outside lock (batch updates, creates, cancels, read)
    // These are the heavy operations that would block all other grid operations
    // if held under _gridLock. All lock acquisitions here follow the canonical
    // hierarchy (fillProcessingLock → syncLock → gridLock → fundLock).
    // P0 placement mutex: the whole of Phase 2 is broadcast I/O plus master-grid
    // mutations, and it is NOT under _gridLock. Without the broadcasting gate a
    // fill-driven COW rebalance can plan and broadcast the SAME slots in parallel
    // with this loop: the commit is then refused ("master mutation during
    // broadcasting"), both order generations land on chain, and the loser becomes
    // a duplicate-price orphan backlog that blocks placements until drained.
    // startBroadcasting() defers that rebalance —
    // manager.performSafeRebalance waits on the flag and the fill consumer gates
    // on it. The flag is refcounted and has a 120s stale-clear watchdog.
    if (typeof manager.startBroadcasting === 'function') manager.startBroadcasting();
    try {
        const { plannedCreates, plannedUpdates, plannedCancels, chainSellCount, chainBuyCount } = phase1Result;

        // Execute planned cancellations (duplicates, edge, excess) outside lock.
        // Re-read immediately before the first cancellation: Phase 1 is pure
        // planning and releases _gridLock, so the ownership/role snapshot that
        // justified a cancel can become stale before any broadcast is sent.
        const phase2CancellationPlanIds = new Set<string>();
        if (!dryRun && plannedCancels.length > 0) {
            // An empty, non-truncated read is intentionally authoritative here:
            // every plan is an explicit cancel target, so [] safely skips all
            // plans. We do not use deferEmpty because this is not a retry probe.
            for (const cancelPlan of plannedCancels) {
                if (cancelPlan?.chainOrderId) phase2CancellationPlanIds.add(String(cancelPlan.chainOrderId));
            }
            const initialChainSignature = _startupChainSnapshotSignature(chainOpenOrders || [], manager);
            let currentChainSignature: Map<string, string> | null = null;
            try {
                const currentChainOrders = await readOpenOrdersGuarded(chainOrders, account, {
                    log: (message: string, level?: string) => logger?.log?.(message, level),
                    label: 'STARTUP-PHASE2-CANCEL',
                });
                if (currentChainOrders === null) {
                    logger?.log?.(
                        `Startup: Skipping ${plannedCancels.length} stale cancellation plan(s): ` +
                        `the pre-cancel chain read was ambiguous or truncated`,
                        'warn'
                    );
                } else {
                    currentChainSignature = _startupChainSnapshotSignature(currentChainOrders, manager);
                }
            } catch (readErr) {
                logger?.log?.(
                    `Startup: Skipping ${plannedCancels.length} stale cancellation plan(s): ` +
                    `pre-cancel chain read failed (${getErrorMessage(readErr)})`,
                    'warn'
                );
            }

            if (currentChainSignature) {
                logger?.log?.(`Startup: Executing ${plannedCancels.length} queued cancellations (Phase 2)`, 'info');
                // The chain signature is intentionally read once for the loop,
                // not once per broadcast. If an earlier plan cancels, the next
                // order-gone handling covers that intra-loop drift safely.
                for (const cancelPlan of plannedCancels) {
                    try {
                        const submitted = await _cancelChainOrder({
                            chainOrders,
                            account,
                            privateKey,
                            manager,
                            chainOrderId: cancelPlan.chainOrderId,
                            dryRun,
                            chainOrderObj: cancelPlan.chainOrderObj,
                            releaseUntrackedFunds: cancelPlan.releaseUntrackedFunds,
                            shouldCancel: () => _startupCancelPlanStillCurrent(
                                cancelPlan,
                                manager,
                                initialChainSignature,
                                currentChainSignature as Map<string, string>
                            ),
                        });
                        if (!submitted) {
                            logger?.log?.(
                                `Startup: Skipping stale planned cancellation ${cancelPlan.chainOrderId} (ownership, role, geometry, or chain snapshot changed)`,
                                'warn'
                            );
                            continue;
                        }
                        logger?.log?.(
                            `Startup: Cancelled queued order ${cancelPlan.chainOrderId} (Phase 2)`,
                            'info'
                        );
                    } catch (cancelErr) {
                        logger?.log?.(
                            `Startup: Failed to cancel queued order ${cancelPlan.chainOrderId}: ${getErrorMessage(cancelErr)}. ` +
                            `The order stays live: the relocation/create phases will skip a placement ` +
                            `that would cross it (STARTUP-CROSS-GUARD) and re-align on the next cycle.`,
                            'error'
                        );
                    }
                }
            }
        }

        if (!dryRun && plannedUpdates.length > 0) {
            let updatePlans = plannedUpdates;
            const maxBatchAttempts = 3;
            let batchCompleted = false;

            if (supportsBatchUpdate) {
                for (let attempt = 1; attempt <= maxBatchAttempts; attempt++) {
                    try {
                        const batchResult = await _executeStartupUpdateBatch({
                            updatePlans,
                            chainOrders,
                            account,
                            privateKey,
                            manager,
                            dryRun,
                        });

                        if (batchResult.executed) {
                            logger?.log?.(`Startup: Update batch complete (${batchResult.prepared} updated)`, 'info');
                        }
                        batchCompleted = true;
                        break;
                    } catch (err) {
                        logger?.log?.(`Startup: Update batch attempt ${attempt}/${maxBatchAttempts} failed: ${getErrorMessage(err)}`, 'error');

                        const refreshedChainOrders = await _recoverStartupSyncFailure({
                            chainOrders,
                            manager,
                            account,
                            logger,
                            triggerMessage: `Startup: Triggering recovery sync after update batch failure (attempt ${attempt}/${maxBatchAttempts})`,
                            source: 'startupReconcileUpdateBatchFailure',
                        });

                        updatePlans = _refreshStartupUpdatePlans(updatePlans, refreshedChainOrders ?? []);
                        if (updatePlans.length === 0) {
                            logger?.log?.('Startup: No update plans remain after recovery sync; skipping further update attempts', 'warn');
                            batchCompleted = true;
                            break;
                        }

                        if (attempt >= maxBatchAttempts) {
                            logger?.log?.('Startup: Update batch retries exhausted; switching to sequential fallback', 'warn');
                            break;
                        }
                    }
                }
            } else {
                logger?.log?.('Startup: Batch update helpers unavailable; using sequential fallback updates', 'warn');
            }

            if (!batchCompleted && updatePlans.length > 0) {
                try {
                    const fallbackResult = await _executeStartupSequentialUpdateFallback({
                        updatePlans,
                        chainOrders,
                        account,
                        privateKey,
                        manager,
                        dryRun,
                    });

                    if (fallbackResult.executed > 0 || fallbackResult.skipped > 0 || fallbackResult.failed > 0) {
                        logger?.log?.(
                            `Startup: Sequential fallback complete (updated=${fallbackResult.executed}, skipped=${fallbackResult.skipped}, failed=${fallbackResult.failed})`,
                            fallbackResult.failed > 0 ? 'warn' : 'info'
                        );
                    }
                } catch (err) {
                    logger?.log?.(`Startup: Sequential fallback failed unexpectedly: ${getErrorMessage(err)}`, 'error');
                }
            }
        }

        const phase2CreatedOrderIds = new Set<string>();
        if (!dryRun && plannedCreates.length > 0) {
            const createdIds = await _executePlannedStartupCreates({
                createPlans: plannedCreates,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
            });
            for (const id of createdIds) {
                phase2CreatedOrderIds.add(id);
            }
        }

        let finalChainSellCount = chainSellCount;
        let finalChainBuyCount = chainBuyCount;
        if (!dryRun) {
            try {
                // Truncated-read guard: get_full_accounts caps the limit_orders
                // window and fresh orders (exactly the Phase-2 creates) sort last
                // and are the first entries omitted. The adoption loop and the
                // surplus-cancel counts would silently operate on a partial
                // snapshot — defer to the sync loop's targeted drift detection and
                // keep the pre-Phase-2 counts for the summary log.
                const freshOpenOrders = await readOpenOrdersGuarded(chainOrders, account, {
                    log: (message: string, level?: string) => logger?.log?.(message, level),
                    label: 'STARTUP',
                    detail: 'Post-Phase-2 chain read',
                });
                if (freshOpenOrders !== null) {
                    const freshParsed: ParsedChainEntry[] = (Array.isArray(freshOpenOrders) ? freshOpenOrders : [])
                        .map((co) => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
                        .filter((x): x is ParsedChainEntry => x.parsed !== null);

                    const gridOrderIds = new Set<string>();
                    for (const order of manager.orders.values()) {
                        if (order && order.orderId) gridOrderIds.add(order.orderId);
                    }
                    // Merge any chain order IDs Phase 2 successfully created on-chain
                    // (even if _applySync failed to register them in manager.orders).
                    // This prevents Phase 3 from cancelling legitimately created orders.
                    for (const id of phase2CreatedOrderIds) {
                        gridOrderIds.add(id);
                    }

                    // Adopt any Phase-2 uncertain-landed chain orders that never made
                    // it into grid slots (the group adoption sync only runs when the
                    // post-uncertain read returned orders). Targeted slot adoption
                    // only: match VIRTUAL/SPREAD slots without an orderId by
                    // type+price+size within tolerance (clamped to ~2 quanta —
                    // the just-broadcast create may have landed with
                    // rounding-drifted price; the strict matcher would miss it
                    // and the next cycle would re-broadcast a duplicate).
                    // Full syncFromOpenOrders is
                    // deliberately NOT used here — its pass-1 virtualizes ACTIVE slots
                    // missing from the snapshot, and a lagging read right after the
                    // Phase-2 broadcast would destroy the confirmed grid.
                    const btsFeeData = getAssetFeesSafe('BTS');
                    for (const entry of freshParsed) {
                        const co: ChainOrder = entry.chain;
                        const parsed = entry.parsed;
                        if (!co?.id || !parsed) continue;
                        if (gridOrderIds.has(co.id)) continue;
                        const candidate: ManagedOrder | undefined = Array.from(manager.orders.values()).find((o) => {
                            if (!o || o.orderId || o.state !== ORDER_STATES.VIRTUAL) return false;
                            return chainOrderMatchesSlotWithTolerance(parsed, o, manager.assets);
                        });
                        if (!candidate) continue;
                        try {
                            await manager._applySync({
                                gridOrderId: candidate.id,
                                chainOrderId: co.id,
                                isPartialPlacement: false,
                                expectedType: parsed.type,
                                fee: btsFeeData?.createFee || 0,
                            }, 'createOrder');
                            gridOrderIds.add(co.id);
                            phase2CreatedOrderIds.add(co.id);
                            logger?.log?.(
                                `Startup: Adopted uncertain-landed chain order ${co.id} into slot ${candidate.id} (${parsed.type}, price=${parsed.price})`,
                                'warn'
                            );
                        } catch (adoptErr) {
                            logger?.log?.(
                                `Startup: Failed to adopt landed order ${co.id} into slot ${candidate?.id}: ${getErrorMessage(adoptErr)}`,
                                'warn'
                            );
                            // The order IS on chain (Phase-2 uncertain-landed). Even
                            // though the slot registration failed, the ID must still
                            // be protected from the same pass's surplus-cancel —
                            // mirror the capturedId protection of _createOrderFromGrid.
                            // The next sync loop's orphan adoption registers it.
                            gridOrderIds.add(co.id);
                        }
                    }
                    const queuedCancellationIds = new Set(
                        (Array.isArray(manager.ordersNeedingPriceCorrection) ? manager.ordersNeedingPriceCorrection : [])
                            .filter((entry: PendingPriceCorrection) => entry?.chainOrderId && (entry?.cancelOnly === true || entry?.isSurplus === true))
                            .map((entry: PendingPriceCorrection) => String(entry.chainOrderId))
                    );
                    const staleSurplusCancels: Array<{ chainOrderObj: ChainOrder; sideLabel: string }> = [];
                    for (const side of [ORDER_TYPES.SELL, ORDER_TYPES.BUY]) {
                        const targetCount = side === ORDER_TYPES.SELL ? targetSell : targetBuy;
                        let sideOrders = freshParsed.filter((x) => x.parsed.type === side);
                        const sideLabel = side === ORDER_TYPES.SELL ? 'SELL' : 'BUY';

                        if (sideOrders.length > targetCount) {
                            // Sort by chain ID for deterministic cancellation order.
                            sideOrders = sideOrders.sort((a, b) =>
                                (a.chain.id || '').localeCompare(b.chain.id || '')
                            );
                            let cancelLimit = sideOrders.length - targetCount;
                            // Protected candidates do not consume cancelLimit;
                            // selection therefore moves to the next eligible
                            // sorted order instead of the pre-guard candidate.
                            for (const so of sideOrders) {
                                if (cancelLimit <= 0) break;
                                const recentlyCancelled = typeof chainOrders.wasRecentlyOwnCancelled === 'function'
                                    && chainOrders.wasRecentlyOwnCancelled(so.chain.id);
                                if (!gridOrderIds.has(so.chain.id)
                                    && !queuedCancellationIds.has(String(so.chain.id))
                                    && !phase2CancellationPlanIds.has(String(so.chain.id))
                                    && !recentlyCancelled) {
                                    staleSurplusCancels.push({ chainOrderObj: so.chain, sideLabel });
                                    cancelLimit--;
                                }
                            }
                        }
                    }

                    let cancelledSellCount = 0;
                    let cancelledBuyCount = 0;
                    if (staleSurplusCancels.length > 0) {
                        for (const sc of staleSurplusCancels) {
                            try {
                                await _cancelChainOrder({
                                    chainOrders,
                                    account,
                                    privateKey,
                                    manager,
                                    chainOrderId: sc.chainOrderObj.id,
                                    dryRun,
                                    chainOrderObj: sc.chainOrderObj,
                                    releaseUntrackedFunds: true,
                                });
                                if (sc.sideLabel === 'SELL') cancelledSellCount++;
                                else cancelledBuyCount++;
                                logger?.log?.(`Startup: Cancelled stale surplus ${sc.sideLabel} order ${sc.chainOrderObj.id}`, 'info');
                            } catch (e) {
                                logger?.log?.(`Startup: Failed to cancel surplus ${sc.sideLabel} ${sc.chainOrderObj.id}: ${getErrorMessage(e)}`, 'warn');
                            }
                        }
                    }

                    finalChainSellCount = freshParsed.filter((x) => x.parsed.type === ORDER_TYPES.SELL).length - cancelledSellCount;
                    finalChainBuyCount = freshParsed.filter((x) => x.parsed.type === ORDER_TYPES.BUY).length - cancelledBuyCount;
                }
            } catch (err) {
                logger?.log?.(`Startup: Failed to refresh final chain counts: ${getErrorMessage(err)}`, 'warn');
            }
        }

        logger && logger.log && logger.log(
            `Startup reconcile complete: target(sell=${targetSell}, buy=${targetBuy}), chain(sell=${finalChainSellCount}, buy=${finalChainBuyCount}), ` +
            `gridActive(sell=${_countActiveOnGrid(manager, ORDER_TYPES.SELL)}, buy=${_countActiveOnGrid(manager, ORDER_TYPES.BUY)})`,
            'info'
        );
    } finally {
        if (typeof manager.stopBroadcasting === 'function') manager.stopBroadcasting();
    }

    return null;
}



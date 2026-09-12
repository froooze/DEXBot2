/** Fill processing runtime - handles order fill events and replay-safe accounting */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import * as chainOrders from './chain_orders.js';
import { PROCESSED_FILL_PERSISTENCE_MODES } from './order/processed_fill_store.js';
import { NATIVE_CLIENT, FILL_PROCESSING, TIMING, MAINTENANCE, ORDER_TYPES } from './constants.js';
import { getErrorMessage } from './utils/errors.js';
import { isOrderDoesNotExistError } from './dexbot_maintenance_runtime.js';
import { slotIndexForPrice, isChainPriceOutOfGrid, isSlotInRail } from './order/utils/math.js';
import { ORDER_STATES } from './constants.js';
function buildFillKey(...args: any) { return require('./order/utils/order').buildFillKey(...args); }
function correctAllPriceMismatches(...args: any) { return require('./order/utils/order').correctAllPriceMismatches(...args); }
function parseChainOrder(...args: any) { return require('./order/utils/order').parseChainOrder(...args); }
function retryPersistenceIfNeeded(...args: any) { return require('./order/utils/system').retryPersistenceIfNeeded(...args); }
const { readOpenOrdersGuarded } = chainOrders;

interface SweepOrphanFillOptions {
    context: string;
    label: string;
    logger?: any;
    replayMessage?: any;
}

/**
 * Whether an unknown fill's order plausibly belongs to THIS bot's grid and
 * should be adopted before its proceeds are credited. The by-id chain read
 * confirms the order is still live; the asset and price checks (inside the
 * grid's slot price extremes expanded by a 1.25 factor) filter out foreign
 * orders on shared accounts or other markets, which keep the legacy
 * credit-as-orphan path.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {any} fillOp - Fill operation ({order_id, ...})
 * @returns {Promise<boolean>} True when the order is live and in-grid-range
 */
async function isUnknownFillOrderAdoptable(bot: any, fillOp: any): Promise<boolean> {
    try {
        const orderId = fillOp?.order_id != null ? String(fillOp.order_id) : null;
        if (!orderId) return false;
        const chainMap = await chainOrders.batchReadOrders([orderId]);
        const liveOrder = chainMap ? chainMap.get(orderId) : undefined;
        if (!liveOrder) return false;

        // Asset gate: only orders in THIS bot's market can be ours. Shared
        // accounts hold other bots'/markets' orders — never adopt those.
        const assetAId = bot.manager?.assets?.assetA?.id;
        const assetBId = bot.manager?.assets?.assetB?.id;
        const sellPrice = liveOrder?.sell_price;
        const baseId = sellPrice?.base?.asset_id;
        const quoteId = sellPrice?.quote?.asset_id;
        if (!baseId || !quoteId) return false;
        const assetsMatch = (baseId === assetAId && quoteId === assetBId) || (baseId === assetBId && quoteId === assetAId);
        if (!assetsMatch) return false;

        const parsed = parseChainOrder(liveOrder, bot.manager.assets);
        const price = Number(parsed?.price);
        if (!Number.isFinite(price) || price <= 0) return false;

        // Genesis-frozen: price gate via nearest-slot determinism. If genesis exists, check if nearest slot is available and in-rail.
        const genesis = (bot.manager as any)?._genesis;
        if (genesis && Array.isArray(genesis.priceLevels) && genesis.priceLevels.length > 0) {
            try {
                const idx = slotIndexForPrice(price, genesis);
                // Out-of-grid hold (mirror of the sync Pass-2 guard): the
                // clamp onto edge slot 0/N-1 is not a real match. An
                // out-of-grid live order is not adoptable here — fall
                // through to the credit path instead of deferring credit
                // to an adoption sync that must not adopt it.
                {
                    const precision = parsed.type === ORDER_TYPES.SELL
                        ? bot.manager?.assets?.assetA?.precision
                        : bot.manager?.assets?.assetB?.precision;
                    if (isChainPriceOutOfGrid(price, genesis, precision)) return false;
                }
                const slotId = `slot-${idx}`;
                const slot = bot.manager.orders.get(slotId);
                if (!slot) return false;
                const boundaryIdx = (bot.manager as any).boundaryIdx;
                const gapSlots = genesis.gapSlots ?? (bot.manager as any)._gapSlots ?? 0;
                if (boundaryIdx != null && !isSlotInRail(boundaryIdx, gapSlots, parsed.type, { id: slotId } as any)) return false;
                return slot.state === ORDER_STATES.VIRTUAL || !slot.orderId;
            } catch { return false; }
        }
        let minPrice = Infinity;
        let maxPrice = 0;
        for (const o of (bot.manager?.orders?.values?.() ?? []) as any[]) {
            const p = Number(o?.price);
            if (!Number.isFinite(p) || p <= 0) continue;
            if (p < minPrice) minPrice = p;
            if (p > maxPrice) maxPrice = p;
        }
        if (!Number.isFinite(minPrice) || maxPrice <= 0) return false;
        const rangeFactor = 1.25;
        return price >= minPrice / rangeFactor && price <= maxPrice * rangeFactor;
    } catch {
        // Read failure → not adoptable here; caller falls back to crediting.
        return false;
    }
}

/**
 * Handle a sweep fill whose grid order could not be resolved (orphan): derive a
 * replay-safe key (with degraded fallback), skip already-processed fills, credit
 * the fill's proceeds via replay-safe orphan accounting, and report whether the
 * fill was missing a history key (which should trigger an open-orders sync).
 * Shared by the bootstrap/post-reset/orphan-fill sweep loops.
 *
 * Adoption-before-credit (Fix E): when the unknown order is still LIVE on-chain
 * and priced inside this bot's grid range, its proceeds are NOT credited
 * outside slot accounting — the function returns true so the caller triggers
 * the open-orders sync whose pass-2 adoption brings the order into the grid
 * (fills credited unaccounted because the order was never adopted). Only
 * confirmed-gone (fully filled) or read-failure/foreign orders take the
 * legacy credit path.
 *
 * @returns true when the fill was missing a replay-safe history identifier OR
 *   the fill was deferred to the adoption sync (order still live on-chain).
 */
async function processSweepOrphanFill(bot: any, fill: any, fillOp: any, processedFillKeys: Set<any>, opts: SweepOrphanFillOptions): Promise<boolean> {
    let orphanFillKey = buildFillKey(fill);
    if (!orphanFillKey) {
        orphanFillKey = bot._buildOrphanFillFallbackKey(fill);
    }
    if (orphanFillKey && !bot._isNewFillKey(orphanFillKey, processedFillKeys, opts.label, fillOp.order_id)) {
        return false;
    }

    if (await isUnknownFillOrderAdoptable(bot, fillOp)) {
        (opts.logger ?? bot.manager.logger).log(
            `[${opts.label}] Unknown order ${fillOp.order_id} is LIVE on-chain inside grid range — deferring proceeds credit to adoption sync`,
            'warn'
        );
        // Release the dedupe key consumed by _isNewFillKey so the fill can be
        // re-processed against the adopted slot after the sync runs.
        if (orphanFillKey) {
            processedFillKeys.delete(orphanFillKey);
            bot._recentlyQueuedFills?.delete?.(orphanFillKey);
        }
        return true;
    }

    (opts.logger ?? bot.manager.logger).log(
        `[${opts.label}] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`,
        'warn'
    );
    const accountingResult = await bot._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
        context: opts.context,
        logger: opts.logger,
        replayMessage: opts.replayMessage,
    });
    return accountingResult.status === 'missing_key';
}

function wireProcessedFillTracking(bot: any) {
    if (!bot.manager) return;

    bot._processedFillStore.configure({
        accountOrders: bot.accountOrders
    });

    bot._processedFillStore.mergeTracker(bot.manager.processedFillTracker);

    bot.manager.processedFillTracker = bot._recentlyProcessedFills;
    bot.manager.processedFillStore = bot._processedFillStore;
}

/**
 * Explicitly cancel residual orders that the chain still holds after a fill was
 * treated as a full fill (other-side rounds to 0). The chain only auto-culls an
 * order when its residual value in the QUOTE asset truncates to 0 (bitshares-core
 * maybe_cull_small_order); a residual of >= 1 base unit with non-zero quote value
 * is NOT culled and would be stranded once the slot is virtualized. Best-effort:
 * tolerates "order does not exist"
 * (already culled), logs other failures for the next cycle's reconciliation.
 */
async function cancelResidualOrders(bot: any, residualCancels: any[]) {
    if (!residualCancels || residualCancels.length === 0) return;
    for (const rc of residualCancels) {
        if (!rc || !rc.orderId) continue;
        try {
            await chainOrders.cancelOrder(bot.account, bot.privateKey, rc.orderId);
            bot.manager.logger.log(
                `[RESIDUAL] Cancelled residual order ${rc.orderId}${rc.id ? ` (slot ${rc.id})` : ''} left on chain after sub-dust fill`,
                'warn'
            );
        } catch (err: any) {
            const errMsg = getErrorMessage(err) || '';
            if (isOrderDoesNotExistError(errMsg, rc.orderId)) {
                bot.manager.logger.log(
                    `[RESIDUAL] Residual order ${rc.orderId} already gone from chain; nothing to cancel`,
                    'debug'
                );
            } else {
                bot.manager.logger.log(
                    `[RESIDUAL] Failed to cancel residual order ${rc.orderId}: ${errMsg}`,
                    'warn'
                );
            }
        }
    }
}

/**
 * Flush all pending processed fill writes to persistent storage.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} [reason='manual'] - Reason label for the flush
 * @param {Object} [options] - Flush options forwarded to ProcessedFillStore.flush
 * @returns {Promise<void>}
 */
async function flushProcessedFillPersistence(bot: any, reason: any = 'manual', options: any = {}) {
    bot._processedFillStore.setShuttingDown(bot._shuttingDown);
    await bot._processedFillStore.flush(reason, options);
}

/**
 * Flush pending processed fill writes for specific fill keys.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string[]|Set<string>} fillKeys - Fill keys to flush
 * @param {string} [reason='manual-selected'] - Reason label for the flush
 * @param {Object} [options] - Flush options forwarded to ProcessedFillStore.flushKeys
 * @returns {Promise<void>}
 */
async function flushProcessedFillPersistenceForKeys(bot: any, fillKeys: any, reason: any = 'manual-selected', options: any = {}) {
    bot._processedFillStore.setShuttingDown(bot._shuttingDown);
    await bot._processedFillStore.flushKeys(fillKeys, reason, options);
}

/**
 * Build a degraded orphan fill replay key when the standard fill history id is missing.
 * The fallback key is derived from order_id, block_num, pays/receives amounts and asset IDs.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {any} fill - Raw fill event
 * @returns {string|null} Orphan fallback key or null if insufficient data
 */
function buildOrphanFillFallbackKey(bot: any, fill: any) {
    const fillOp = fill?.op?.[1];
    const orderId = fillOp?.order_id;
    const blockNum = fill?.block_num;
    const paysAssetId = fillOp?.pays?.asset_id;
    const paysAmount = fillOp?.pays?.amount;
    const receivesAssetId = fillOp?.receives?.asset_id;
    const receivesAmount = fillOp?.receives?.amount;
    if (fillOp?.is_maker == null) {
        bot?._warn?.(`[ORPHAN-FALLBACK] is_maker undefined for fill ${fillOp?.order_id}; defaulting to 'maker' for dedup key`);
    }
    const makerRole = fillOp?.is_maker === false ? 'taker' : 'maker';
    // Include operation-type ID, transaction-in-block index, and
    // operation-in-transaction index to reduce collision risk when
    // multiple fills match on order + amounts + block number.
    const opType = fill?.op?.[0];
    const trxInBlock = fill?.trx_in_block;
    const opInTrx = fill?.op_in_trx;
    if (!orderId || blockNum == null || !paysAssetId || paysAmount == null || !receivesAssetId || receivesAmount == null) {
        return null;
    }
    return `orphan:${orderId}:${blockNum}:${paysAssetId}:${paysAmount}:${receivesAssetId}:${receivesAmount}:${makerRole}:${opType ?? ''}:${trxInBlock ?? ''}:${opInTrx ?? ''}`;
}

/**
 * Apply fill accounting with replay-safe deduplication.
 * Prevents the same fill from being accounted twice across restarts or re-syncs.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {any} fill - Raw fill event
 * @param {any} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {Function} [options.missingKeyMessage] - Callback to generate log message when fill key is missing
 * @param {Function} [options.fallbackKeyMessage] - Callback to generate log message when fallback key is used
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {Function} [options.errorMessage] - Callback to generate log message on error
 * @param {Object} [options.logger] - Logger instance
 * @param {string} [options.missingKeyLevel='warn'] - Log level for missing key messages
 * @param {string} [options.fallbackKeyLevel='warn'] - Log level for fallback key messages
 * @param {string} [options.replayLevel='debug'] - Log level for replay messages
 * @param {string} [options.persistenceMode='immediate'] - Processed fill persistence mode (wrappers default to 'batched')
 * @param {boolean} [options.allowOrphanFallbackKey=false] - Allow degraded orphan fallback key
 * @returns {Promise<any>}
 */
async function applyReplaySafeFillAccounting(bot: any, fill: any, fillOp: any, {
    missingKeyMessage,
    fallbackKeyMessage,
    replayMessage,
    errorMessage,
    logger = bot.manager?.logger,
    missingKeyLevel = 'warn',
    fallbackKeyLevel = 'warn',
    replayLevel = 'debug',
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE,
    allowOrphanFallbackKey = false
}: {
    missingKeyMessage?: any;
    fallbackKeyMessage?: any;
    replayMessage?: any;
    errorMessage?: any;
    logger?: any;
    missingKeyLevel?: string;
    fallbackKeyLevel?: string;
    replayLevel?: string;
    persistenceMode?: any;
    allowOrphanFallbackKey?: boolean;
} = {}) {
    let fillKey = buildFillKey(fill);
    let usedFallbackKey = false;

    if (!fillKey && allowOrphanFallbackKey) {
        fillKey = buildOrphanFillFallbackKey(bot, fill);
        usedFallbackKey = Boolean(fillKey);
        if (usedFallbackKey && fallbackKeyMessage) {
            logger?.log?.(fallbackKeyMessage(fillOp, fill, fillKey), fallbackKeyLevel);
        }
    }

    if (!fillKey) {
        if (missingKeyMessage) {
            logger?.log?.(missingKeyMessage(fillOp, fill), missingKeyLevel);
        }
        return { status: 'missing_key', fillKey: null };
    }

    try {
        const applied = await bot.manager.accountant.processFillAccounting(fillOp, fillKey, { persistenceMode });
        if (!applied) {
            if (replayMessage) {
                logger?.log?.(replayMessage(fillOp, fill, fillKey), replayLevel);
            }
            return { status: 'duplicate', fillKey };
        }

        return { status: 'applied', fillKey, usedFallbackKey };
    } catch (err: any) {
        if (errorMessage) {
            logger?.log?.(errorMessage(fillOp, fill, err), 'error');
            return { status: 'error', fillKey, error: err };
        }
        throw err;
    }
}

/**
 * Apply replay-safe fill accounting for tracked fills (with fill history id).
 * Wraps applyReplaySafeFillAccounting with context and default message builders.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {any} fill - Raw fill event
 * @param {any} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {string} [options.context] - Context label for log messages
 * @param {Object} [options.logger] - Logger instance
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {string} [options.persistenceMode='batched'] - Processed fill persistence mode
 * @returns {Promise<any>}
 */
async function applyReplaySafeTrackedFillAccounting(bot: any, fill: any, fillOp: any, {
    context,
    logger = bot.manager?.logger,
    replayMessage,
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
}: {
    context?: string;
    logger?: any;
    replayMessage?: any;
    persistenceMode?: any;
} = {}) {
    return applyReplaySafeFillAccounting(bot, fill, fillOp, {
        logger,
        missingKeyMessage: (op: any) => `[${context}] Missing fill history id for ${op.order_id}; deferring to open-orders sync`,
        replayMessage,
        errorMessage: (op: any, _fill: any, err: any) => `[${context}] Failed to process accounting for ${op.order_id}: ${getErrorMessage(err)}`,
        persistenceMode
    });
}

/**
 * Apply replay-safe fill accounting for orphan fills (missing fill history id).
 * Uses a degraded orphan fallback key when the standard key is unavailable.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {any} fill - Raw fill event
 * @param {any} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {string} [options.context] - Context label for log messages
 * @param {Object} [options.logger] - Logger instance
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {string} [options.persistenceMode='batched'] - Processed fill persistence mode
 * @returns {Promise<any>}
 */
async function applyReplaySafeOrphanFillAccounting(bot: any, fill: any, fillOp: any, {
    context,
    logger = bot.manager?.logger,
    replayMessage,
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
}: {
    context?: string;
    logger?: any;
    replayMessage?: any;
    persistenceMode?: any;
} = {}) {
    return applyReplaySafeFillAccounting(bot, fill, fillOp, {
        logger,
        missingKeyMessage: (op: any) => `[${context}] Missing fill history id and orphan fallback key for ${op.order_id}; deferring to open-orders sync`,
        fallbackKeyMessage: (op: any) => `[${context}] Missing fill history id for orphan fill ${op.order_id}; using degraded orphan replay key for proceeds-only accounting`,
        replayMessage,
        errorMessage: (op: any, _fill: any, err: any) => `[${context}] Failed to process accounting for ${op.order_id}: ${getErrorMessage(err)}`,
        persistenceMode,
        allowOrphanFallbackKey: true
    });
}

/**
 * Create a fill callback handler for blockchain subscription events.
 * Queues incoming fills and triggers fill queue consumption.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module
 * @returns {Function} Async callback function accepting an array of fill events
 */
function createFillCallback(bot: any, chainOrders: any) {
    return async (fills: any) => {
        if (bot._shuttingDown) {
            return;
        }

        if (bot.manager && !bot.config.dryRun && Array.isArray(fills) && fills.length > 0) {
            const maxQueueDepth = NATIVE_CLIENT.SUBSCRIPTIONS.MAX_INCOMING_FILL_QUEUE;
            if (bot._incomingFillQueue.length + fills.length > maxQueueDepth) {
                const message = `Incoming fill queue back-pressure: ${bot._incomingFillQueue.length} queued + ${fills.length} incoming exceeds limit ${maxQueueDepth}`;
                bot._warn(message);
                throw new Error(message);
            }
            bot._markGridActivity?.('fill queued');
            bot._incomingFillQueue.push(...fills);
            bot._consumeFillQueue(chainOrders).catch((err: any) => {
                bot._warn(`Fill queue consume failed: ${getErrorMessage(err)}`);
            });
        }
    };
}

/**
 * Returns the maximum consecutive fill consumer failures allowed before backoff.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {number}
 */
function maxConsecutiveFillConsumerFailures(bot: any) {
    return bot.config.fillProcessing?.MAX_CONSECUTIVE_CONSUMER_FAILURES ?? FILL_PROCESSING.MAX_CONSECUTIVE_CONSUMER_FAILURES;
}

/**
 * Compute the backoff delay for fill-consumer retries after the failure
 * budget (MAX_CONSECUTIVE_CONSUMER_FAILURES) is exhausted. Each retry
 * doubles the previous delay, capped at CONSUMER_BACKOFF_MAX_MS. The
 * consumer NEVER permanently stops re-scheduling — it just slows down.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {number} failures The current consecutive-failure count.
 * @returns {number} Delay in milliseconds before the next retry.
 */
function computeFillConsumerBackoffMs(bot: any, failures: any) {
    const fp = bot.config.fillProcessing || FILL_PROCESSING;
    const initial = fp.CONSUMER_BACKOFF_INITIAL_MS;
    const max = fp.CONSUMER_BACKOFF_MAX_MS;
    const stepAfterMax = Math.max(0, failures - maxConsecutiveFillConsumerFailures(bot));
    return Math.min(max, initial * Math.pow(2, stepAfterMax));
}

/**
 * Consume the deferred-drain marker at the start of a fill cycle.
 *
 * When fills were parked by the consumer's broadcast/order-pipeline deferral
 * (or by a region-end / pipeline-clear drain), the cycle that finally runs
 * them deals with ledger deltas that interacted with mid-rebalance grid
 * state. Mirror the orphan-fill credit treatment: stamp
 * manager._orphanFillsCreditedAt so the fund-invariant tolerance is widened
 * (×5) for this cycle only — the drain itself must not trip the invariant.
 * Idempotent: returns true only when a marker was actually consumed.
 * @param {any} bot
 * @returns {boolean} true when the drain marker was consumed (tolerance widened)
 */
export function consumeDeferredDrainMarker(bot: any): boolean {
    if (bot && (bot as any)._deferredFillsPending) {
        (bot as any)._deferredFillsPending = false;
        if (bot.manager) bot.manager._orphanFillsCreditedAt = Date.now();
        return true;
    }
    return false;
}

/**
 * Decide whether the fill consumer must defer because a broadcast region is
 * active — WITHOUT acquiring _fillProcessingLock first.
 *
 * Background: a fill-driven rebalance waits up to 30s for broadcast idle
 * INSIDE _fillProcessingLock (20s acquisition timeout). While it sleeps,
 * every concurrent consumer queues as a lock waiter and dies at the 20s
 * timeout ("Error processing fills: Lock acquisition timeout"), cascading
 * under backlog. Deferring before the acquire avoids the sleep entirely:
 * the broadcast's finally plus the region-end hook reschedule the consumer,
 * so freshness is preserved without the wait.
 *
 * Bounded: deferral longer than TIMING.FILL_BROADCAST_DEFER_MAX_MS falls
 * through ({ defer: false, stuckFallback: true }) to the legacy path whose
 * in-lock wait still caps at 30s and proceeds — a leaked flag can delay
 * fills, never starve them. The marker resets whenever the consumer
 * proceeds, so only continuous deferral counts toward the bound.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {number} [nowMs] - Clock override (tests)
 * @returns {{ defer: boolean; stuckFallback: boolean }} defer=true means the
 *   caller must return without acquiring the lock.
 */
function shouldDeferFillForBroadcast(bot: any, nowMs?: number): { defer: boolean; stuckFallback: boolean } {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    let active = false;
    try {
        active = bot?.manager?.isBroadcastingActive?.() === true;
    } catch { active = false; }
    if (!active) {
        if ((bot as any)?._fillBroadcastDeferSince) (bot as any)._fillBroadcastDeferSince = 0;
        return { defer: false, stuckFallback: false };
    }
    const deferMaxMs = Number((TIMING as any)?.FILL_BROADCAST_DEFER_MAX_MS) > 0
        ? Number((TIMING as any).FILL_BROADCAST_DEFER_MAX_MS)
        : 60000;
    const since = Number((bot as any)?._fillBroadcastDeferSince) || 0;
    if (!since) (bot as any)._fillBroadcastDeferSince = now;
    if (since && (now - since) >= deferMaxMs) {
        (bot as any)._fillBroadcastDeferSince = 0;
        return { defer: false, stuckFallback: true };
    }
    return { defer: true, stuckFallback: false };
}

/**
 * Schedule a fill consumer restart with exponential backoff when the
 * failure budget is exhausted, or immediate retry via setImmediate when
 * within the budget. The consumer NEVER permanently stops re-scheduling.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module
 */
function scheduleFillConsumerRestart(bot: any, chainOrders: any) {
    const failures = bot._consecutiveConsumeFailures;
    if (failures >= maxConsecutiveFillConsumerFailures(bot)) {
        const backoffMs = computeFillConsumerBackoffMs(bot, failures);
        const elapsedSec = bot._consumeFailureFirstAt
            ? Math.round((Date.now() - bot._consumeFailureFirstAt) / TIMING.MILLISECONDS_PER_SECOND)
            : null;
        const elapsed = elapsedSec !== null ? `${elapsedSec}s` : 'unknown';
        const sustainedLevel = (failures >= 20 || (elapsedSec !== null && elapsedSec >= 900))
            ? 'critical'
            : (failures >= 10 || (elapsedSec !== null && elapsedSec >= 300))
                ? 'error'
                : 'warn';
        bot._log(
            `[FILL-QUEUE] Fill consumer has failed ${failures} consecutive times over ${elapsed}; ` +
            `backing off ${Math.round(backoffMs / TIMING.MILLISECONDS_PER_SECOND)}s before retry. ` +
            `Queue: ${bot._incomingFillQueue.length} fills.`,
            sustainedLevel
        );
        setTimeout(() => {
            if (bot._shuttingDown) return;
            bot._consumeFillQueue(chainOrders).catch((err: any) => {
                if (!bot._consumeFailureFirstAt) {
                    bot._consumeFailureFirstAt = Date.now();
                }
                bot._consecutiveConsumeFailures++;
                const newFailures = bot._consecutiveConsumeFailures;
                const newElapsedSec = bot._consumeFailureFirstAt
                    ? Math.round((Date.now() - bot._consumeFailureFirstAt) / TIMING.MILLISECONDS_PER_SECOND)
                    : null;
                const resumeLevel = (newFailures >= 20 || (newElapsedSec !== null && newElapsedSec >= 900))
                    ? 'critical'
                    : (newFailures >= 10 || (newElapsedSec !== null && newElapsedSec >= 300))
                        ? 'error'
                        : 'warn';
                bot._log(
                    `Fill consumer resume after backoff failed ` +
                    `(${newFailures} total, ` +
                    `next backoff ${Math.round(computeFillConsumerBackoffMs(bot, newFailures) / TIMING.MILLISECONDS_PER_SECOND)}s): ` +
                    `${getErrorMessage(err)}`,
                    resumeLevel
                );
                bot._scheduleFillConsumerRestart(chainOrders);
            });
        }, backoffMs);
        return;
    }

    setImmediate(() => bot._consumeFillQueue(chainOrders).catch((err: any) => {
        if (!bot._consumeFailureFirstAt) {
            bot._consumeFailureFirstAt = Date.now();
        }
        bot._consecutiveConsumeFailures++;
        const remaining = maxConsecutiveFillConsumerFailures(bot) - bot._consecutiveConsumeFailures;
        bot._log(
            `Fill consumer failed (${bot._consecutiveConsumeFailures}/${maxConsecutiveFillConsumerFailures(bot)}, ` +
            `${remaining} attempts remaining): ${getErrorMessage(err)}`,
            bot._consecutiveConsumeFailures >= 3 ? 'warn' : 'error'
        );
    }));
}

/**
 * Process fills during bootstrap phase using the standard fill pipeline.
 * Delegates to the same fill pipeline as the post-reset path.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module for blockchain operations
 * @returns {Promise<void>}
 */
async function processFillsWithBootstrapMode(bot: any, chainOrders: any) {
    if (bot._shuttingDown) {
        bot._warn('Fill processing skipped: shutdown in progress');
        return;
    }
    if (bot._incomingFillQueue.length === 0) return;

    const startTime = Date.now();
    const fills = bot._incomingFillQueue.splice(0);
    const validFills: any[] = [];
    const processedFillKeys = new Set();
    let requiresOpenOrdersSync = false;

    for (const fill of fills) {
        if (!fill || fill.op?.[0] !== FILL_PROCESSING.OPERATION_TYPE) continue;

        const fillOp = fill.op[1];
        const gridOrder = bot.manager.orders.get(fillOp.order_id) ||
            (Array.from(bot.manager.orders.values()) as any[]).find((o: any) => o.orderId === fillOp.order_id);
        if (!gridOrder) {
            if (await processSweepOrphanFill(bot, fill, fillOp, processedFillKeys, { context: 'BOOTSTRAP', label: 'BOOTSTRAP' })) {
                requiresOpenOrdersSync = true;
            }
            continue;
        }

        const trackedFillKey = buildFillKey(fill);
        if (trackedFillKey && !bot._isNewFillKey(trackedFillKey, processedFillKeys, '[BOOTSTRAP]', fillOp.order_id)) {
            continue;
        }

        bot.manager.lockOrders([gridOrder.id]);
        try {
            const accountingResult = await bot._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                context: 'BOOTSTRAP',
                replayMessage: (op: any) => `[BOOTSTRAP] Replay detected for ${op.order_id}; skipping duplicate bootstrap rebalance`
            });
            if (accountingResult.status === 'missing_key') {
                requiresOpenOrdersSync = true;
                continue;
            }
            if (accountingResult.status !== 'applied') {
                continue;
            }

            validFills.push({ ...fill, gridOrder });

            const fillType = gridOrder.type === ORDER_TYPES.BUY ? 'BUY' : 'SELL';
            bot._log(`[BOOTSTRAP] Fill detected: ${fillType} order (${fillOp.is_maker !== false ? 'maker' : 'taker'})`);
        } finally {
            bot.manager.unlockOrders([gridOrder.id]);
        }
    }

    if (requiresOpenOrdersSync) {
        bot._log('[BOOTSTRAP] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
        // Truncated-read guard: syncing on a partial get_full_accounts window
        // would virtualize live ACTIVE slots (pass-1 phantom cleanup). Defer —
        // the guarded sync loop picks up on a clean read.
        const bootstrapChainOpenOrders = await readOpenOrdersGuarded(chainOrders, bot.accountId, {
            log: (message: string, level: any) => bot._log(message, level),
            label: 'BOOTSTRAP',
            detail: 'open-orders fallback',
        });
        if (bootstrapChainOpenOrders !== null) {
            const syncResult = await bot.manager.syncFromOpenOrders(bootstrapChainOpenOrders);
            if (syncResult.filledOrders?.length > 0) {
                const queuedOrderIds = new Set(validFills.map((fill: any) => fill?.gridOrder?.orderId).filter(Boolean));
                for (const filledOrder of syncResult.filledOrders) {
                    if (!filledOrder?.orderId || queuedOrderIds.has(filledOrder.orderId)) continue;
                    validFills.push({ gridOrder: filledOrder });
                    queuedOrderIds.add(filledOrder.orderId);
                }
            }
        }
    }

    await bot._flushProcessedFillPersistence('bootstrap-batch');

    if (validFills.length === 0) return;

    if (bot._shuttingDown) {
        bot._warn(`[BOOTSTRAP] Fill processing skipped: shutdown in progress (${validFills.length} fill(s) discarded)`);
        return;
    }

    try {
        bot._log(`[BOOTSTRAP] Processing ${validFills.length} fill(s) through standard pipeline`, 'info');

        const filledOrders = validFills.map((f: any) => f.gridOrder);
        const result = await bot._processFillsWithBatching(
            filledOrders,
            new Set(),
            '[BOOTSTRAP] fill processing'
        );

        if (result.aborted) {
            bot._warn('[BOOTSTRAP] Aborted batch due to illegal state; skipping grid persistence this cycle');
        }

        bot._metrics.fillsProcessed += validFills.length;
        bot._metrics.fillProcessingTimeMs += Date.now() - startTime;
    } catch (err: any) {
        bot._warn(`[BOOTSTRAP] Error processing fills: ${getErrorMessage(err)}`);
        bot.manager.logger.log(`[BOOTSTRAP] Fill error: ${getErrorMessage(err)}`, 'error');
    }
}

/**
 * Release replay-safety dedupe keys consumed by _isNewFillKey for fills that
 * are NOT being processed after all (stale-totals deferral). Without this, a
 * re-queued fill is skipped as a duplicate within _fillDedupeWindowMs — the
 * deferral would credit nothing AND poison the retry. Mirrors the
 * orphan-adoption release in processSweepOrphanFill.
 * @param {any} bot
 * @param {Set<any>} processedFillKeys - Per-cycle key set to release from
 * @param {any[]} fills - Raw fill events whose keys were consumed
 */
function releaseFillDedupeKeys(bot: any, processedFillKeys: Set<any>, fills: any[]) {
    if (!bot || !processedFillKeys || !Array.isArray(fills)) return;
    for (const fill of fills) {
        try {
            const key = buildFillKey(fill);
            if (!key) continue;
            processedFillKeys.delete(key);
            bot._recentlyQueuedFills?.delete?.(key);
        } catch { /* best-effort */ }
    }
}

/**
 * Park fills deferred on a stale accountTotals refresh for a bounded retry.
 *
 * Background: syncFromFillHistory(Batch) returns { deferred: true } when the
 * accountTotals refresh fails — accounting is NOT applied. The old code
 * dropped those fills (already spliced from the queue) while their dedupe
 * keys stayed marked processed: silent fund loss with a "retrying next
 * cycle" comment, but the next cycle only exists with backlog.
 *
 * Parked fills are held OUTSIDE the live queue (so the maintenance idle gate
 * keeps working) and re-queued on a backoff timer (FILL_TOTALS_RETRY_BASE_MS,
 * doubling, capped at FILL_TOTALS_RETRY_MAX_MS). The retry re-runs the same
 * idempotent sync — safe because nothing was applied and the keys were
 * released. Retries never stop (attempt counter resets on the first cycle
 * with no deferrals); the parked array is capped at MAX_INCOMING_FILL_QUEUE
 * with a critical log as a catastrophic backstop.
 * @param {any} bot
 * @param {Object} chainOrders - Chain orders module for blockchain operations
 * @param {any[]} fills - Raw fill events to park
 * @param {Object} [options]
 * @param {number} [options.retryDelayMs] - Override the computed backoff (tests)
 */
export function parkFillsForTotalsRetry(bot: any, chainOrders: any, fills: any[], options: { retryDelayMs?: number } = {}) {
    if (!bot || !Array.isArray(fills) || fills.length === 0) return;
    if (!Array.isArray((bot as any)._fillTotalsParkedFills)) (bot as any)._fillTotalsParkedFills = [];
    const parked = (bot as any)._fillTotalsParkedFills;
    const maxParked = Number((NATIVE_CLIENT as any)?.SUBSCRIPTIONS?.MAX_INCOMING_FILL_QUEUE) > 0
        ? Number((NATIVE_CLIENT as any).SUBSCRIPTIONS.MAX_INCOMING_FILL_QUEUE)
        : 1000;
    if (parked.length + fills.length > maxParked) {
        // Cap overflow: drop OLDEST first (parked front, then incoming front)
        // so the surviving set reflects the most current chain state. Either
        // direction is fund-loss without the fund-drift backstop; newest-wins
        // is the safer choice because stale fills are the most likely to have
        // been superseded on-chain.
        const overflow = parked.length + fills.length - maxParked;
        const dropped: any[] = [];
        let remaining = overflow;
        if (parked.length > 0 && remaining > 0) {
            const take = Math.min(parked.length, remaining);
            dropped.push(...parked.splice(0, take));
            remaining -= take;
        }
        if (remaining > 0) {
            dropped.push(...fills.splice(0, remaining));
        }
        bot.manager?.logger?.log?.(
            `[FILL] Totals-refresh retry park overflow (cap ${maxParked}): dropping ${dropped.length} oldest fill(s) ` +
            `(${(dropped as any[]).map((f: any) => f?.op?.[1]?.order_id ?? '?').join(',')}); fund-drift detection is the backstop`,
            'error'
        );
        if (fills.length === 0) return;
    }
    parked.push(...fills);
    // A retry is already scheduled — it picks these up; one timer at a time.
    if ((bot as any)._fillTotalsRetryTimer) return;
    const attempt = Number((bot as any)._fillTotalsRetryAttempt) || 0;
    const baseMs = Number((TIMING as any)?.FILL_TOTALS_RETRY_BASE_MS) > 0
        ? Number((TIMING as any).FILL_TOTALS_RETRY_BASE_MS)
        : 10000;
    const maxMs = Number((TIMING as any)?.FILL_TOTALS_RETRY_MAX_MS) > 0
        ? Number((TIMING as any).FILL_TOTALS_RETRY_MAX_MS)
        : 60000;
    const delayMs = (options as any)?.retryDelayMs
        ?? Math.min(baseMs * Math.pow(2, Math.min(attempt, 3)), maxMs);
    bot.manager?.logger?.log?.(
        `[FILL] Parked ${fills.length} fill(s) on totals-refresh failure ` +
        `(parked=${parked.length}, attempt=${attempt + 1}, retry in ${Math.round(delayMs / 1000)}s); accounting not yet applied`,
        'warn'
    );
    (bot as any)._fillTotalsRetryTimer = setTimeout(() => {
        (bot as any)._fillTotalsRetryTimer = null;
        if (bot._shuttingDown) {
            bot.manager?.logger?.log?.(
                `[FILL] Shutdown with ${((bot as any)._fillTotalsParkedFills as any[])?.length || 0} totals-parked fill(s) unprocessed; grid persistence snapshot is the backstop`,
                'error'
            );
            return;
        }
        // Re-read the attempt counter fresh at fire time (do NOT reuse the
        // `attempt` captured at park time): a clean cycle may have reset
        // _fillTotalsRetryAttempt to 0 while this timer was pending, and
        // writing back the stale captured value would spuriously inflate the
        // backoff chain. Fresh-read self-corrects; the next park recomputes
        // the delay from the current counter.
        const freshAttempt = Number((bot as any)._fillTotalsRetryAttempt) || 0;
        (bot as any)._fillTotalsRetryAttempt = freshAttempt + 1;
        const due = Array.isArray((bot as any)._fillTotalsParkedFills)
            ? (bot as any)._fillTotalsParkedFills.splice(0)
            : [];
        if (due.length === 0) return;
        // NOTE: this unshift runs BEFORE _consumeFillQueue acquires
        // _fillProcessingLock. Interleaving with an in-flight cycle is benign
        // by design: the in-flight run already snapshotted its batch, so the
        // re-queued fills are simply picked up one cycle later (worst case),
        // and _deferredFillsPending widens the invariant tolerance for that
        // drain. Do not move the unshift inside the lock without re-checking
        // the single-flight / bootstrap branches in consumeFillQueue.
        bot._incomingFillQueue.unshift(...due);
        (bot as any)._deferredFillsPending = true;
        bot.manager?.logger?.log?.(
            `[FILL] Retrying ${due.length} totals-parked fill(s) (attempt ${freshAttempt + 1})`,
            'warn'
        );
        const consume = typeof bot._consumeFillQueue === 'function'
            ? () => bot._consumeFillQueue(chainOrders)
            : () => consumeFillQueue(bot, chainOrders);
        consume().catch((err: any) => {
            bot._warn?.(`Totals-parked fill retry failed: ${getErrorMessage(err)}`);
        });
    }, delayMs);
}

/**
 * Consume queued fills from incomingFillQueue and rebalance.
 * Deduplicates fills against already-processed set (replay-safe), syncs filled
 * orders from history or open orders mode, handles price mismatches, processes
 * fills sequentially with interruptible rebalancing, and periodically cleans old
 * fill records.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module for blockchain operations
 */
async function consumeFillQueue(bot: any, chainOrders: any) {
    const resetFailureWatchdogIfSet = () => {
        if (bot._consecutiveConsumeFailures > 0 || bot._consumeFailureFirstAt > 0) {
            bot._consecutiveConsumeFailures = 0;
            bot._consumeFailureFirstAt = 0;
        }
    };

    // Deferral marks the queue as a "drain residue": the fills that finally
    // run were parked while the order pipeline / broadcast mutated grid
    // state, so their optimistic ledger interacts with mid-rebalance
    // geometry. The flag is consumed at lock acquire to widen the invariant
    // tolerance like an orphan credit (×5) for that drain cycle only — the
    // drain itself must not trip the fund invariant.
    const markDeferredDrain = () => { (bot as any)._deferredFillsPending = true; };

    if (bot._incomingFillQueue.length === 0) {
        resetFailureWatchdogIfSet();
        return;
    }

    if (bot._shuttingDown) {
        bot._warn('Fill processing skipped: shutdown in progress');
        resetFailureWatchdogIfSet();
        return;
    }

    if (bot._batchInFlight || bot._recoverySyncInFlight) {
        bot.manager?.logger?.log?.(
            `Fill processing deferred: order pipeline active (${bot._incomingFillQueue.length} queued)`,
            'debug'
        );
        markDeferredDrain();
        resetFailureWatchdogIfSet();
        return;
    }

    // Broadcast pre-check (lock-timeout robustness — see
    // shouldDeferFillForBroadcast): never acquire the fill lock just to
    // sleep in the 30s broadcast wait while concurrent consumers pile up as
    // lock waiters and time out. The broadcast's finally + region-end hook
    // reschedule this consumer when the region ends.
    const broadcastDefer = shouldDeferFillForBroadcast(bot);
    if (broadcastDefer.defer) {
        bot.manager?.logger?.log?.(
            `Fill processing deferred: broadcast active (${bot._incomingFillQueue.length} queued)`,
            'debug'
        );
        markDeferredDrain();
        resetFailureWatchdogIfSet();
        return;
    }
    if (broadcastDefer.stuckFallback) {
        bot.manager?.logger?.log?.(
            'Fill processing proceeding despite stuck broadcast flag (deferral bound exceeded; in-lock wait still applies)',
            'warn'
        );
    }

    let pendingFillKeysForCurrentCycle = new Set();
    // Set when this run parked totals-deferred fills: the retry-attempt
    // backoff counter only resets on runs with no deferrals.
    let parkedTotalsRetryThisRun = false;
    try {
        if (bot.manager.isBootstrapping()) {
            let bootstrapSkipped = false;
            await bot.manager._fillProcessingLock.acquire(async () => {
                if (!bot.manager.isBootstrapping()) {
                    bootstrapSkipped = true;
                    return;
                }
                await bot._processFillsWithBootstrapMode(chainOrders);
            });
            if (bootstrapSkipped) {
                resetFailureWatchdogIfSet();
            }
            return;
        }

        // Single-flight: getQueueLength() counts WAITERS, not the active
        // holder — without isLocked() every concurrent consumer queues behind
        // a long batch (e.g. a broadcast wait) and dies at the 20s
        // acquisition timeout. The holder's while-loop drains late arrivals
        // (splice-all per iteration + non-empty tail reschedule), so a second
        // consumer is purely redundant — return instead of queueing.
        const fillLock = bot.manager._fillProcessingLock;
        const lockBusy = (typeof fillLock?.isLocked === 'function' && fillLock.isLocked())
            || (typeof fillLock?.getQueueLength === 'function' && fillLock.getQueueLength() > 0);
        if (lockBusy) {
            bot._metrics.lockContentionEvents++;
            resetFailureWatchdogIfSet();
            return;
        }

        await bot.manager._fillProcessingLock.acquire(async () => {
            bot.manager._orphanFillsCreditedAt = null;
            // Deferred-drain residue tolerance: fills that were parked while a
            // broadcast/order pipeline held the queue are now running against
            // post-rebalance grid state. Mirror the orphan-fill treatment —
            // widen the invariant tolerance for this cycle so the drain itself
            // does not fire a fund-invariant violation. Bounded: cleared at the
            // next cycle start or by the next fresh chain fetch.
            consumeDeferredDrainMarker(bot);

            while (bot._incomingFillQueue.length > 0) {
                const batchStartTime = Date.now();
                bot._metrics.maxQueueDepth = Math.max(bot._metrics.maxQueueDepth, bot._incomingFillQueue.length);

                const allFills = bot._incomingFillQueue.splice(0);

                const validFills: any[] = [];
                const processedFillKeys = new Set();
                pendingFillKeysForCurrentCycle = new Set();
                let requiresOpenOrdersSync = false;

                for (const fill of allFills) {
                    if (fill && fill.op && fill.op[0] === FILL_PROCESSING.OPERATION_TYPE) {
                        const fillOp = fill.op[1];

                        const hasFillEconomics = fillOp?.pays?.asset_id && fillOp?.pays?.amount != null
                            && fillOp?.receives?.asset_id && fillOp?.receives?.amount != null;

                        if (chainOrders && typeof chainOrders.wasRecentlyOwnCancelled === 'function'
                            && chainOrders.wasRecentlyOwnCancelled(fillOp.order_id)
                            && !hasFillEconomics) {
                            bot.manager.logger.log(
                                `[SELF-CANCEL] Skipping non-economic fill artifact for order ${fillOp.order_id} (just cancelled by this bot)`,
                                'debug'
                            );
                            continue;
                        }

                        const gridOrder = bot.manager.orders.get(fillOp.order_id) ||
            (Array.from(bot.manager.orders.values()) as any[]).find((o: any) => o.orderId === fillOp.order_id);
                        if (!gridOrder) {
                            const staleMarkedAt = bot._staleCleanedOrderIds.get(fillOp.order_id);
                            if (staleMarkedAt != null) {
                                const staleAgeMs = Date.now() - staleMarkedAt;
                                if (staleAgeMs <= bot._staleCleanupRetentionMs) {
                                    bot.manager.logger.log(
                                        `[ORPHAN-FILL] Skipping double-credit for stale-cleaned order ${fillOp.order_id} ` +
                                        `(funds already freed by batch cleanup, age=${staleAgeMs}ms)`,
                                        'warn'
                                    );
                                    continue;
                                }
                                bot._staleCleanedOrderIds.delete(fillOp.order_id);
                            }

                            if (await processSweepOrphanFill(bot, fill, fillOp, processedFillKeys, {
                                context: 'ORPHAN-FILL',
                                label: 'ORPHAN-FILL',
                                replayMessage: (op: any) => `[ORPHAN-FILL] Replay detected for ${op.order_id}; skipping duplicate credit`
                            })) {
                                requiresOpenOrdersSync = true;
                            }
                            bot.manager._orphanFillsCreditedAt = Date.now();
                            continue;
                        }

                        const roleStr = fillOp.is_maker !== false ? 'maker' : 'taker';
                        bot.manager.logger.log(`Processing ${roleStr} fill for order ${fillOp.order_id}`, 'debug');

                        const fillKey = buildFillKey(fill);
                        if (!fillKey) {
                            bot.manager.logger.log(
                                `[FILL] Missing history id for order ${fillOp.order_id} block ${fill.block_num}; deferring to open-orders sync`,
                                'warn'
                            );
                            requiresOpenOrdersSync = true;
                            continue;
                        }
                        if (!bot._isNewFillKey(fillKey, processedFillKeys, '[FILL]', fillOp.order_id)) {
                            continue;
                        }
                        validFills.push(fill);

                        const paysAmount = fillOp.pays ? fillOp.pays.amount : '?';
                        const receivesAmount = fillOp.receives ? fillOp.receives.amount : '?';
                        // Asset IDs are logged alongside the raw satoshi amounts so
                        // offline consumers (e.g. `dexbot export`, which resolves
                        // precisions from profiles/orders/<bot>.json) can derive
                        // side/price without chain access. See issue #22.
                        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : '?';
                        const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : '?';
                        bot._log(`\n===== FILL DETECTED =====`);
                        bot._log(`Order ID: ${fillOp.order_id}`);
                        bot._log(`Pays: ${paysAmount} (${paysAssetId}), Receives: ${receivesAmount} (${receivesAssetId})`);
                        bot._log(`Block: ${fill.block_num} (History ID: ${fill.id || 'N/A'})`);
                        bot._log(`=========================\n`);
                    }
                }

                const cleanupTimestamp = Date.now();
                let cleanedCount = 0;
                for (const [key, timestamp] of bot._recentlyQueuedFills) {
                    if (cleanupTimestamp - timestamp > bot._fillDedupeWindowMs) {
                        bot._recentlyQueuedFills.delete(key);
                        cleanedCount++;
                    }
                }
                if (cleanedCount > 0) {
                    bot.manager.logger.log(`Cleaned ${cleanedCount} old queued fill records. Remaining: ${bot._recentlyQueuedFills.size}`, 'debug');
                }

                if (validFills.length === 0 && !requiresOpenOrdersSync) continue;

                let allFilledOrders: any[] = [];
                let ordersNeedingCorrection: any[] = [];
                const residualCancels: any[] = [];
                // Fills deferred on a stale accountTotals refresh: accounting
                // NOT applied. Collected here, keys released, parked for a
                // bounded retry after the block loop (never dropped).
                const deferredRefills: any[] = [];

                const processValidFills = async (fillsToSync: any) => {
                    let resolvedOrders: any[] = [];
                    {
                        bot.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (history mode)`, 'info');

                        if (fillsToSync.length >= 2) {
                            const batchResult = await bot.manager.syncFromFillHistoryBatch(fillsToSync, {
                                persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
                            });
                            if (batchResult.deferred) {
                                // Deferred: stale accountTotals refresh failed —
                                // accounting NOT applied. Release the consumed
                                // dedupe keys and park for a bounded retry.
                                // (The old code returned here: the fills were
                                // already spliced from the queue and their keys
                                // stayed marked processed — silent fund loss.)
                                releaseFillDedupeKeys(bot, processedFillKeys, fillsToSync);
                                deferredRefills.push(...fillsToSync);
                                bot.manager.logger.log(
                                    `[FILL] Deferred ${fillsToSync.length} fill(s) (stale accountTotals, refresh failed); parking for retry.`,
                                    'warn'
                                );
                                return resolvedOrders;
                            }
                            for (const fill of fillsToSync) {
                                const fillKey = buildFillKey({
                                    orderId: fill?.op?.[1]?.order_id,
                                    blockNum: fill?.block_num,
                                    historyId: fill?.id
                                });
                                if (fillKey) pendingFillKeysForCurrentCycle.add(fillKey);
                            }
                            if (batchResult.filledOrders) resolvedOrders.push(...batchResult.filledOrders);
                            if (batchResult.residualCancels) residualCancels.push(...batchResult.residualCancels);
                            if (batchResult.requiresOpenOrdersSync) requiresOpenOrdersSync = true;
                        } else {
                            for (const fill of fillsToSync) {
                                const resultHistory = await bot.manager.syncFromFillHistory(fill, {
                                    persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
                                });
                                const fillKey = buildFillKey({
                                    orderId: fill?.op?.[1]?.order_id,
                                    blockNum: fill?.block_num,
                                    historyId: fill?.id
                                });
                                if (resultHistory.deferred) {
                                    // Same totals-refresh deferral as the batch
                                    // path: release keys, park for retry.
                                    releaseFillDedupeKeys(bot, processedFillKeys, [fill]);
                                    deferredRefills.push(fill);
                                    bot.manager.logger.log(
                                        `[FILL] Deferred fill (stale accountTotals, refresh failed); parking for retry.`,
                                        'warn'
                                    );
                                    continue;
                                }
                                if (fillKey) pendingFillKeysForCurrentCycle.add(fillKey);
                                if (resultHistory.filledOrders) resolvedOrders.push(...resultHistory.filledOrders);
                                if (resultHistory.residualCancels) residualCancels.push(...resultHistory.residualCancels);
                                if (resultHistory.requiresOpenOrdersSync) requiresOpenOrdersSync = true;
                            }
                        }
                    }

                    if (requiresOpenOrdersSync) {
                        bot.manager.logger.log(
                            'Falling back to open-orders sync for fill(s) missing replay-safe history identifiers',
                            'warn'
                        );
                        bot.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (open orders mode)`, 'info');
                        // Truncated-read guard: syncing on a partial
                        // get_full_accounts window would virtualize live ACTIVE
                        // slots (pass-1 phantom cleanup). Defer this batch.
                        const chainOpenOrders = await readOpenOrdersGuarded(chainOrders, bot.account, {
                            log: (message: string, level: any) => bot.manager.logger.log(message, level),
                            label: 'FILL-SYNC',
                            detail: 'open-orders mode',
                        });
                        if (chainOpenOrders !== null) {
                            const resultOpenOrders = await bot.manager.syncFromOpenOrders(chainOpenOrders);
                            if (resultOpenOrders.filledOrders) resolvedOrders.push(...resultOpenOrders.filledOrders);
                            if (resultOpenOrders.ordersNeedingCorrection) ordersNeedingCorrection.push(...resultOpenOrders.ordersNeedingCorrection);
                        }
                    }
                    return resolvedOrders;
                };

                bot.manager.pauseFundRecalc();
                try {
                    const fillsByBlock = new Map();
                    const fillsWithoutBlock: any[] = [];
                    for (const fill of validFills) {
                        if (fill.block_num != null) {
                            const list = fillsByBlock.get(fill.block_num);
                            if (list) list.push(fill);
                            else fillsByBlock.set(fill.block_num, [fill]);
                        } else {
                            fillsWithoutBlock.push(fill);
                        }
                    }

                    const sortedBlocks = [...fillsByBlock.keys()].sort((a: any, b: any) => a - b);
                    const accumulatedOrders: any[] = [];
                    let anyRequiresSync = false;
                    const initialRequiresSync = requiresOpenOrdersSync;
                    for (const blockNum of sortedBlocks) {
                        requiresOpenOrdersSync = false;
                        bot.manager.logger.log(
                            `[FILL-BLOCK] Processing ${fillsByBlock.get(blockNum).length} fill(s) from block ${blockNum}`,
                            'debug'
                        );
                        const blockResult = await processValidFills(fillsByBlock.get(blockNum));
                        accumulatedOrders.push(...blockResult);
                        if (requiresOpenOrdersSync) anyRequiresSync = true;
                    }
                    requiresOpenOrdersSync = anyRequiresSync || initialRequiresSync;
                    if (fillsWithoutBlock.length > 0) {
                        bot.manager.logger.log(
                            `[FILL-BLOCK] Processing ${fillsWithoutBlock.length} fill(s) without block info`,
                            'debug'
                        );
                        const noBlockResult = await processValidFills(fillsWithoutBlock);
                        accumulatedOrders.push(...noBlockResult);
                        if (requiresOpenOrdersSync) anyRequiresSync = true;
                    }
                    if (requiresOpenOrdersSync && !anyRequiresSync) {
                        bot.manager.logger.log(
                            '[FILL-BLOCK] Running open-orders sync for fills with missing history identifiers',
                            'warn'
                        );
                        const fallbackOrders = await processValidFills([]);
                        accumulatedOrders.push(...fallbackOrders);
                    }
                    allFilledOrders = accumulatedOrders;

                    if (deferredRefills.length > 0) {
                        parkedTotalsRetryThisRun = true;
                        parkFillsForTotalsRetry(bot, chainOrders, deferredRefills);
                    }

                    if (ordersNeedingCorrection.length > 0) {
                        const correctionResult = await correctAllPriceMismatches(
                            bot.manager, bot.account, bot.privateKey, chainOrders
                        );
                        if (correctionResult.failed > 0) bot.manager.logger.log(`${correctionResult.failed} corrections failed`, 'error');
                    }

                } finally {
                    await bot.manager.resumeFundRecalc();
                }

                bot._refreshDynamicWeightDistribution('fill queue');

                if (allFilledOrders.length > 0) {
                    const result = await bot._processFillsWithBatching(
                        allFilledOrders, null, 'fill set'
                    );
                    let abortedFillCycle = result.aborted;
                    const deferredFillCycle = (result as any)?.deferred === true;
                    if (deferredFillCycle) {
                        // Accounting + crawls are applied; only the broadcast was
                        // deferred to avoid sleeping in-lock on the broadcast
                        // flag. Post-fill maintenance would immediately attempt
                        // the same blocked broadcasts, so skip it here:
                        // _processFillsWithBatching already scheduled the
                        // no-fill rebalance that applies the owed boundary
                        // shift once the pipeline is clear (same idempotent
                        // scheduler the region-end hook uses).
                        bot.manager?.logger?.log?.(
                            '[FILL-QUEUE] Fill rebalance deferred (broadcast active); post-fill maintenance deferred to region end',
                            'debug'
                        );
                    }
                    if (!abortedFillCycle) {
                        const batchFillKeys = new Set(allFilledOrders.map((filledOrder: any) => buildFillKey({
                            orderId: filledOrder?.orderId,
                            blockNum: filledOrder?.blockNum,
                            historyId: filledOrder?.historyId
                        })).filter(Boolean));
                        // Same-order fills are aggregated into one filled order by
                        // syncFromFillHistoryBatch, so the raw per-fill keys of the
                        // cycle must be flushed here too — otherwise the aggregated
                        // order only carries the last fill's key and the earlier
                        // same-order fills (already credited in Phase 3 accounting)
                        // would be re-credited on crash recovery.
                        for (const fillKey of pendingFillKeysForCurrentCycle) batchFillKeys.add(fillKey);
                        await bot._flushProcessedFillPersistenceForKeys(batchFillKeys, 'fill-batch-committed');
                    } else {
                        bot.manager.logger.log(
                            '[FILL-DEDUP] Fill cycle aborted; fill key persistence guarded under abort path.',
                            'warn'
                        );
                    }

                    const fullFillCount = allFilledOrders.filter((o: any) =>
                        o && o.isPartial !== true
                    ).length;
                    const hasAnyFills = allFilledOrders.some((o: any) => o);
                    const shouldRunPostFillChecks = !abortedFillCycle && !deferredFillCycle && fullFillCount > 0;
                    const shouldRunDustDetection = !abortedFillCycle && !deferredFillCycle && hasAnyFills;

                    if (shouldRunDustDetection) {
                        const healthResult = await bot.manager.checkGridHealth(
                            bot.updateOrdersOnChainPlan.bind(bot)
                        );
                        const allDust = [
                            ...(healthResult.buyDustOrders || []),
                            ...(healthResult.sellDustOrders || []),
                        ];
                        if (allDust.length > 0) {
                            const dustCancelResult = await bot._cancelDustOrders({
                                buy: healthResult.buyDustOrders,
                                sell: healthResult.sellDustOrders,
                            });
                            if (dustCancelResult?.batchResult?.aborted) {
                                abortedFillCycle = true;
                            }
                        }
                    }

                    // Cancel residuals the chain still holds after sub-dust full
                    // fills were virtualized. The chain only auto-culls orders whose
                    // QUOTE-side residual rounds to 0; a leftover of >= 1 base unit
                    // is NOT culled and would otherwise sit on the book forever once
                    // the slot stopped referencing it. Runs BEFORE post-fill grid
                    // maintenance so the residual cannot be re-adopted into a slot
                    // first (which would turn this cancel into a ghost: a grid order
                    // referencing a chain order that no longer exists).
                    if (!abortedFillCycle && residualCancels.length > 0) {
                        await cancelResidualOrders(bot, residualCancels);
                    }

                    if (shouldRunPostFillChecks && !abortedFillCycle) {
                        await bot._runGridMaintenance('post-fill');
                    }
                } else if (pendingFillKeysForCurrentCycle.size > 0) {
                    await bot._flushProcessedFillPersistenceForKeys(
                        pendingFillKeysForCurrentCycle, 'fill-batch-no-rotations'
                    );
                }

                bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
                await retryPersistenceIfNeeded(bot.manager);

                bot._fillCleanupCounter += validFills.length;

                const cleanupThreshold = MAINTENANCE.CLEANUP_PROBABILITY > 0 && MAINTENANCE.CLEANUP_PROBABILITY < 1
                    ? Math.floor(1 / MAINTENANCE.CLEANUP_PROBABILITY)
                    : 100;

                if (bot._fillCleanupCounter >= cleanupThreshold) {
                    try {
                        await bot.accountOrders.cleanOldProcessedFills(TIMING.FILL_RECORD_RETENTION_MS);
                        bot._fillCleanupCounter = 0;
                    } catch (err: any) {
                        bot.manager?.logger?.log(`Warning: Fill cleanup failed (will retry): ${getErrorMessage(err)}`, 'warn');
                    }
                }

                bot._metrics.fillsProcessed += validFills.length;
                bot._metrics.fillProcessingTimeMs += Date.now() - batchStartTime;

                if (bot._staleCleanedOrderIds.size > 0) {
                    const now = Date.now();
                    let prunedCount = 0;
                    for (const [orderId, markedAt] of bot._staleCleanedOrderIds) {
                        if (now - markedAt > bot._staleCleanupRetentionMs) {
                            bot._staleCleanedOrderIds.delete(orderId);
                            prunedCount++;
                        }
                    }
                    if (prunedCount > 0) {
                        bot.manager.logger.log(
                            `[STALE-CLEANUP] Pruned ${prunedCount} expired stale-cleaned order IDs ` +
                            `(retention=${bot._staleCleanupRetentionMs}ms, remaining=${bot._staleCleanedOrderIds.size})`,
                            'debug'
                        );
                    }
                }

            }

            bot._markGridActivity('fill processing end');
            // A run with no totals-deferrals breaks the retry backoff chain.
            if (!parkedTotalsRetryThisRun) bot._fillTotalsRetryAttempt = 0;
            bot._consecutiveConsumeFailures = 0;
            bot._consumeFailureFirstAt = 0;
        });
    } catch (err: any) {
        const isCredentialOutage = bot._isCredentialDaemonError(err);
        if (pendingFillKeysForCurrentCycle.size > 0) {
            const flushReason = isCredentialOutage
                ? 'credential-outage-verified-fills'
                : 'fill-cycle-error-verified-fills';

            if (isCredentialOutage) {
                bot._credentialRecoveryNeeded = true;
                bot._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${getErrorMessage(err)}`);
            }

            try {
                await bot._flushProcessedFillPersistenceForKeys(
                    pendingFillKeysForCurrentCycle, flushReason, { throwOnError: true }
                );
                const credentialSuffix = isCredentialOutage
                    ? '; grid persistence is suspended until recovery'
                    : '';
                bot.manager?.logger?.log?.(
                    `[FILL-DEDUP] Persisted ${pendingFillKeysForCurrentCycle.size} verified processed-fill write(s) after fill cycle error${credentialSuffix}.`,
                    isCredentialOutage ? 'warn' : 'info'
                );
            } catch (flushErr: any) {
                bot.manager?.logger?.log?.(
                    `[FILL-DEDUP] Failed to persist verified fill keys during fill error handling: ${getErrorMessage(flushErr)}`,
                    'warn'
                );
            }
        }

        if (isCredentialOutage && pendingFillKeysForCurrentCycle.size === 0) {
            bot._credentialRecoveryNeeded = true;
            bot._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${getErrorMessage(err)}`);
        }
        bot._log(`Error processing fills: ${getErrorMessage(err)}`, 'error');
        if (err.stack) bot._log(err.stack, 'error');
    }

    if (!bot._shuttingDown && bot._incomingFillQueue.length > 0) {
        scheduleFillConsumerRestart(bot, chainOrders);
    }
}

export { wireProcessedFillTracking, flushProcessedFillPersistence, flushProcessedFillPersistenceForKeys, buildOrphanFillFallbackKey, applyReplaySafeFillAccounting, applyReplaySafeTrackedFillAccounting, applyReplaySafeOrphanFillAccounting, processSweepOrphanFill, createFillCallback, maxConsecutiveFillConsumerFailures, computeFillConsumerBackoffMs, scheduleFillConsumerRestart, shouldDeferFillForBroadcast, consumeFillQueue, processFillsWithBootstrapMode }


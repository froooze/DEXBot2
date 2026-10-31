/**
 * modules/dexbot_cow_runtime.ts - COW (Copy-on-Write) Batch Execution Runtime
 *
 * Handles on-chain order execution with Copy-on-Write working grid semantics,
 * broadcast uncertainty recovery, and result processing.
 *
 * Each function takes the DEXBot instance as its first parameter, following
 * the same pattern as dexbot_fill_runtime.ts.
 */

import * as chainOrdersModule from './chain_orders.js';
const chainOrders = chainOrdersModule;
const { readOpenOrdersWithMetaSafe } = chainOrdersModule;
import { BroadcastUncertainError as BroadcastUncertainErrorBinding } from './dexbot_credential_client.js';
const BroadcastUncertainError = BroadcastUncertainErrorBinding;
import * as orderUtils from './order/utils/order.js';
import { sleep, setLastFillPivot, fireStructuralResync, evaluateSpreadCorrectionReadiness, resolveLastFillGuardReference, resolveSpreadCrossingFloor, isLastFillGuardBlocked } from './order/utils/system.js';
const {
    buildCreateOrderArgs,
    buildCreateOpFingerprint,
    extractBatchOperationResults,
    formatUnmatchedChainOrder,
    convertToSpreadPlaceholder,
    toRailHolePlaceholder,
    buildOutsideInPairGroups,
    isOrderPlaced,
    chainOrderUnchangedFromCache,
    detectCrossedBookPlan,
    collectKnownOnChainOrderIds,
} = orderUtils;
import * as validate from './order/utils/validate.js';
const { validateCreateTargetSlots, evaluateCommit, hasExecutableActions, stampGapEvacuationRotation } = validate;
import * as math from './order/utils/math.js';
const { validateOrderSize, findCrossedOrder, sameGridLevel, isEvacuationRotationAllowed, isEvacuationSizeStillValid, getSellStartIdx, getPrecisionByOrderType, isSlotIndexInGapBand, getAssetFeesSafe, blockchainToFloat, floatToBlockchainInt, quantizeFloat } = math;
import { parseSlotIndex } from './order/utils/slot.js';

/**
 * Re-verify a B-stamped gap-evacuation rotation against the LIVE committed
 * geometry (boundaryIdx/_gapSlots at execution time). The stamp freezes
 * plan-build geometry, but a boundary commit can land between plan-build and
 * execution; when the live geometry is finite and the source is no longer
 * in-band (or the dest no longer rail), the stamp is stale and the rotation
 * must be re-proven by the unstamped live probe instead of bypassing the
 * last-fill guard. Non-finite live geometry cannot disprove the stamp and
 * keeps the plan-build authority (fail-open to the stamp, never to the guard).
 */
export function isEvacuationStampStillValid(liveBoundary: unknown, liveGapSlots: unknown, sourceId: unknown, destId: unknown, orderType: unknown): boolean {
    if (orderType !== ORDER_TYPES.BUY && orderType !== ORDER_TYPES.SELL) return false;
    // Explicit null/undefined/'' guard BEFORE Number(): Number(null) === 0 and
    // Number('') === 0 are finite and would read an unknown live geometry as
    // boundary 0, falsely DISPROVING the stamp and downgrading the rotation to
    // the live guard — the opposite of the documented "non-finite geometry
    // keeps plan-build authority" contract (undefined already fails open via
    // NaN). Same Number(null)===0 trap guarded elsewhere in the COW runtime.
    if (liveBoundary === null || liveBoundary === undefined || liveBoundary === '') return true;
    if (liveGapSlots === null || liveGapSlots === undefined || liveGapSlots === '') return true;
    const b = Number(liveBoundary);
    const g = Number(liveGapSlots);
    if (!Number.isFinite(b) || !Number.isFinite(g) || g < 0) return true;
    const srcIdx = parseSlotIndex(sourceId);
    const dstIdx = parseSlotIndex(destId);
    if (srcIdx === null || srcIdx === undefined || dstIdx === null || dstIdx === undefined) return false;
    if (!isSlotIndexInGapBand(srcIdx, b, g)) return false;
    if (isSlotIndexInGapBand(dstIdx, b, g)) return false;
    const sellStartIdx = getSellStartIdx(b, g);
    const dstInRail = orderType === ORDER_TYPES.SELL ? Number(dstIdx) >= sellStartIdx : Number(dstIdx) <= b;
    return dstInRail;
}
function hasSlotPriceCollision(items: SlotLike[], targetPrice: number, genesis: unknown, excludeId: string | null, predicate?: (it: SlotLike) => boolean) {
    for (const it of items) {
        if (predicate && !predicate(it)) continue;
        if (excludeId && (it.id === excludeId || it.orderId === excludeId)) continue;
        const p = it.order ? it.order.price : it.price;
        if (p == null) continue;
        // Grid-vs-grid: resolve both prices to their frozen ladder level (a
        // low-precision asset must not collapse adjacent levels, and a price
        // rounded a quantum off its level still resolves back).
        if (sameGridLevel(Number(p), targetPrice, genesis)) return it;
    }
    return null;
}
import * as constantsModule from './constants.js';
const {
    COW_ACTIONS,
    COW_ORIGINS,
    COW_PERFORMANCE,
    ORDER_STATES,
    ORDER_TYPES,
    REBALANCE_STATES,
} = constantsModule;
import { acquireIfNotHeld } from './order/async_lock.js';
import * as FormatModule from './order/format.js';
const Format = FormatModule;
import * as workingGridModule from './order/working_grid.js';
const { WorkingGrid } = workingGridModule;
import { getErrorMessage, resolveSeamMs, resolveSeamMsOrNull, getErrorField } from './utils/errors.js';
import type { BotLike, OrderManagerLike, ManagedOrder, ChainOrder, UnknownRecord, AssetInfo, CowAction } from './types.js';

/** Loose JSON-object view. */
type JsonObj = UnknownRecord;

/** Final integer tuple for a planned order op. */
interface FinalInts {
    sell: number;
    receive: number;
    sellAssetId: string;
    receiveAssetId: string;
    [key: string]: unknown;
}

/** A pending-broadcast entry recorded before chain submission. */
interface PendingEntry {
    slotId?: unknown;
    finalInts?: FinalInts;
    orderType?: unknown;
    fingerprint?: unknown;
    order?: ManagedOrder;
    context?: JsonObj;
    ctxIndex?: number;
    opIndex?: number;
    [key: string]: unknown;
}

/**
 * The COW plan result: a projected working grid plus the actions to execute.
 * Produced by `buildCowResultFromPlan` and threaded through the pre-broadcast
 * guards and the batch executor.
 */
export interface CowResult extends JsonObj {
    actions: CowAction[];
    workingBoundary: number;
    workingGrid: InstanceType<typeof WorkingGrid>;
    workingIndexes: unknown;
    origin?: string;
    refillSlotIds?: string[];
    /**
     * Owed fill-crawl records this plan's derivation actually folded. The
     * commit clears ONLY these; a record the derivation could not apply (a
     * truncated cross-chunk shift, an edge-classified slot, a newer record for
     * the same slot) stays owed. Without this the commit cleared the whole
     * ledger and silently lost the difference (2026-10-25: 7 fills swept
     * slots 147-153, boundary ended 7 levels behind).
     */
    consumedCrawlIds?: Array<{ slotId: string; side: string; ts?: number }>;
    fills?: unknown[];
}

/** Result of the pre-broadcast guard chain. */
interface PreBroadcastGuardResult extends JsonObj {
    proceed: boolean;
    result?: JsonObj;
    crossingCandidates?: unknown[];
    intraBatchCandidates?: unknown[];
}

/** Result of the last-fill guard probe. */
interface LastFillGuardResult {
    blocked: boolean;
    pivot: number | null;
    /** The pivot itself: the direction rule has no separate band threshold. */
    threshold?: number | null;
}

/** Per-batch last-fill guard counters. */
interface LastFillGuardStats {
    checked: number;
    pivotOffGrid?: number;
    [key: string]: unknown;
}

/** A CREATE op context with its resolved order + integer tuple. */
type CreateContext = OpPhase & { finalInts: FinalInts; order: ManagedOrder };

/** A pending broadcast that matched a chain order. */
interface AdoptedEntry {
    entry: PendingEntry;
    match: ChainOrderLike;
}

/** A chain order enriched with the loose fields COW recovery reads. */
export interface ChainOrderLike extends ChainOrder {
    type?: unknown;
    sellInt?: unknown;
    receiveInt?: unknown;
    sell?: unknown;
    receive?: unknown;
    orderId?: unknown;
    slotId?: unknown;
    chainOrderId?: unknown;
    price?: unknown;
    order?: JsonObj;
}

/** Normalized integer tuple used by pending-broadcast recovery. */
interface NormalizedChainOrder {
    side: string;
    assetA: string;
    assetB: string;
    sellInt: number;
    receiveInt: number;
}

/** A COW operation context (create/update/cancel/rotation). */
export interface OpPhase extends JsonObj {
    kind?: unknown;
    id?: unknown;
    order?: ManagedOrder;
    finalInts?: FinalInts;
    updateInfo?: JsonObj;
    rotation?: JsonObj;
}

/** Slot/order-ish item used by collision and grouping helpers. */
interface SlotLike {
    id?: unknown;
    orderId?: unknown;
    price?: unknown;
    order?: { price?: unknown; [key: string]: unknown };
    [key: string]: unknown;
}

// Maximum number of times the pre-broadcast staleness guard may re-plan the
// batch from a fresh master before proceeding anyway. Bounded so a master
// grid that keeps mutating (fill bursts, sync loops) can never livelock the
// pipeline: after one re-plan the batch is shipped regardless, and the
// commit-time guard + post-refused-commit chain adoption close divergence.
const STALE_PLAN_REPLAN_LIMIT = 1;

// Maximum wall-clock time (ms) a COW batch waits for an in-flight broadcast to
// settle before proceeding anyway. The in-flight batch clears the flag in its
// outer finally, so this only triggers if the flag is left stuck by a crash in
// a non-finally path — proceed after the cap and let the commit guard + chain
// adoption close divergence instead of blocking the pipeline forever.
const SINGLE_FLIGHT_MAX_WAIT_MS = 120000;

/**
 * Group orders into outside-in pairs for atomic create execution.
 * @param {Array} orders
 * @returns {Array<Array>}
 */
function buildOutsideInPairGroupsForOrders(orders: ManagedOrder[]) {
    return buildOutsideInPairGroupsWithAdapter(orders, (o: unknown) => o as ManagedOrder);
}

/**
 * Build outside-in pair groups for create entry contexts.
 * @param {Array} createEntries
 * @returns {Array<Array>}
 */
function buildOutsideInPairGroupsForCreateEntries(createEntries: PendingEntry[]) {
    return buildOutsideInPairGroupsWithAdapter(createEntries, (e: unknown) => (e as PendingEntry)?.context?.order);
}

/**
 * Shared outside-in delegation: project each item to its order, then group
 * with the single order adapter. The ForOrders/ForCreateEntries wrappers
 * differ only in this projection.
 * @param {Array} items
 * @param {Function} toOrder - Project an item to its order object
 * @returns {Array<Array>}
 */
function buildOutsideInPairGroupsWithAdapter(items: unknown[], toOrder: (item: unknown) => unknown) {
    return buildOutsideInPairGroups(items, {
        isValid: (item: unknown) => Boolean(toOrder(item)),
        getType: (item: unknown) => String((toOrder(item) as JsonObj | undefined)?.type ?? ''),
        getPrice: (item: unknown) => (toOrder(item) as JsonObj | undefined)?.price as string | number,
    });
}

/**
 * Create a create-op fingerprint for a specific slot, used for
 * pending-broadcast matching and chain-order fingerprinting.
 * Consolidates the fingerprint construction pattern found in
 * recordPendingBroadcast, buildChainOrderFingerprint, findChainOrderForSlot,
 * and verifyCreateAbsent.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} order - The order object
 * @param {Object} finalInts - The final integer tuple { sell, receive, sellAssetId, receiveAssetId }
 * @param {string} slotId - The slot identifier
 * @returns {string|null}
 */
function createOpFingerprintForSlot(bot: BotLike, order: ManagedOrder, finalInts: FinalInts, slotId: string): string | null {
    if (!order || !finalInts || !slotId) return null;
    return buildCreateOpFingerprint({
        side: order.type,
        assetA: bot.manager?.assets?.assetA?.id,
        assetB: bot.manager?.assets?.assetB?.id,
        sellInt: finalInts.sell,
        receiveInt: finalInts.receive,
        slotId,
    });
}

/**
 * Read the pending-broadcast entries as an array. The manager map is
 * created lazily by recordPendingBroadcast, so every reader must guard
 * on `instanceof Map` — this helper is the single spelling of that guard.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {Array}
 */
function getPendingBroadcasts(bot: BotLike): PendingEntry[] {
    return (bot.manager && bot.manager._pendingBroadcasts instanceof Map)
        ? Array.from(bot.manager._pendingBroadcasts.values()) as PendingEntry[]
        : [];
}

/**
 * Probe the chain snapshot for a pending-broadcast entry's slot.
 * Single spelling of the findChainOrderForSlot probe literal used by
 * reconcile (first pass + re-read), the poll confirmer, and the
 * create-absence verifier.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} chainSnapshot
 * @param {Object} entry - Pending entry ({ slotId, finalInts, orderType, fingerprint })
 * @returns {Object|null}
 */
function findChainOrderForPendingEntry(bot: BotLike, chainSnapshot: ChainOrder[], entry: PendingEntry) {
    if (!entry?.slotId) return null;
    return findChainOrderForSlot(bot, chainSnapshot, String(entry.slotId), {
        sell: entry.finalInts?.sell,
        receive: entry.finalInts?.receive,
        orderType: entry.orderType,
        fingerprint: entry.fingerprint,
    });
}

/**
 * Check whether a chain read is authoritative enough to make
 * definitive absence/lPresence decisions. An authoritative read is
 * non-empty, non-truncated, and non-null.
 * @param {Object} readResult - The result of readOpenOrdersWithMeta
 * @returns {boolean}
 */
function isAuthoritativeChainRead(readResult: { orders?: unknown; truncated?: unknown } | null | undefined): boolean {
    if (!readResult || !Array.isArray(readResult.orders)) return false;
    if (readResult.truncated) return false;
    return readResult.orders.length > 0;
}

/**
 * Build a rawOnChain metadata object from final integer values.
 * Used in processBatchResults for size-update, create, and rotation
 * contexts to enrich order objects with on-chain identity.
 * Returns null when the order id (or final ints) is missing: downstream
 * chainOrderUnchangedFromCache treats a null cache as "not unchanged" and
 * defers, which is the safer direction versus comparing an id-less object.
 * @param {string} orderId - The on-chain order id
 * @param {Object} finalInts - The final integer tuple
 * @returns {Object|null}
 */
function rawOnChainFromInts(orderId: unknown, finalInts: FinalInts | null | undefined): Record<string, unknown> | null {
    if (!orderId || !finalInts) return null;
    return {
        id: orderId,
        for_sale: String(finalInts.sell),
        sell_price: {
            base: { amount: String(finalInts.sell), asset_id: finalInts.sellAssetId },
            quote: { amount: String(finalInts.receive), asset_id: finalInts.receiveAssetId },
        },
    };
}

/**
 * Extract operation results from a batch transaction result.
 * @param {Object|Array|null} result
 * @param {string} [warnContext='']
 * @param {Function} [logFn] - Optional logger function, called with (msg, level) on unrecognized shape
 * @returns {Array}
 */
function extractOperationResults(result: unknown, warnContext: string = '', logFn: ((message: string, level?: string) => void) | null = null): unknown[] {
    const extracted = extractBatchOperationResults(result);

    if (Array.isArray(extracted)) return extracted;

    if (result && logFn) {
        const resultObj = result as JsonObj;
        const resultType = Array.isArray(result) ? 'array' : typeof result;
        const keySummary = (resultType === 'object' && !Array.isArray(result))
            ? Object.keys(resultObj).slice(0, 8).join(',')
            : '';
        const contextSuffix = warnContext ? ` (${warnContext})` : '';
        const keysSuffix = keySummary ? `; keys=[${keySummary}]` : '';
        logFn(
            `[COW] Unrecognized operation_results shape${contextSuffix}; defaulting to empty results. resultType=${resultType}${keysSuffix}`,
            'warn'
        );
    }

    return [];
}

/**
 * Find CREATE operation contexts whose broadcast result did not include a chain order id.
 * @param {Array} operationResults
 * @param {Array} opContexts
 * @returns {Array<{index:number, ctx:Object}>}
 */
function findMissingCreateResultContexts(operationResults: unknown, opContexts: unknown): { index: number; ctx: OpPhase }[] {
    const missing: { index: number; ctx: OpPhase }[] = [];
    if (!Array.isArray(opContexts)) return missing;

    for (let i = 0; i < opContexts.length; i++) {
        const ctx = opContexts[i] as OpPhase;
        if (ctx?.kind !== 'create') continue;
        const chainOrderId = (operationResults as unknown[][])?.[i]?.[1];
        if (!chainOrderId || !/^1\.7\.\d+$/.test(String(chainOrderId))) {
            missing.push({ index: i, ctx });
        }
    }

    return missing;
}

/**
 * Merge missing CREATE result contexts into manager._lastUnmatchedChainOrders.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array<{index:number, ctx:Object}>} missingCreateResults
 */
function markMissingCreateResultsAsStructuralBlocker(bot: BotLike, missingCreateResults: { index: number; ctx: OpPhase }[]) {
    const blockers = Array.isArray(missingCreateResults)
        ? missingCreateResults.map((item) => {
            const order = (item.ctx?.order ?? {}) as JsonObj;
            const fingerprint = [
                `type=${order.type || 'unknown'}`,
                `price=${Format.formatPrice6(Number(order.price))}`,
                `size=${Format.formatAmount(Number(order.size))}`
            ].join(',');
            return {
                chainOrderId: 'unknown',
                type: order.type || null,
                price: order.price,
                size: order.size,
                slotId: order.id || item.ctx?.id || null,
                reason: 'missing-create-result',
                operationIndex: item.index,
                fingerprint,
            };
        })
        : [];

    if (bot.manager && blockers.length > 0) {
        const existing = Array.isArray(bot.manager._lastUnmatchedChainOrders)
            ? bot.manager._lastUnmatchedChainOrders
            : [];
        const keys = new Set(existing.map((order) => `${order.reason || ''}:${order.slotId || ''}:${order.operationIndex ?? ''}`));
        const merged = [...existing];
        for (const blocker of blockers) {
            const key = `${blocker.reason || ''}:${blocker.slotId || ''}:${blocker.operationIndex ?? ''}`;
            if (!keys.has(key)) {
                merged.push(blocker as unknown as import('./types.js').UnmatchedChainOrder);
                keys.add(key);
            }
        }
        bot.manager._lastUnmatchedChainOrders = merged;
        bot.manager._lastUnmatchedChainOrdersAt = Date.now();
    }
}

/**
 * Format an unmatched chain order for COW logs.
 * @param {Object} order
 * @returns {string}
 */
function formatUnmatchedChainOrderForLog(order: JsonObj) {
    return formatUnmatchedChainOrder(order as unknown as ChainOrder);
}

/**
 * Record a pending CREATE broadcast on the manager.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} entry
 * @returns {string|null} The fingerprint the entry was stored under (null
 *   when recording was skipped). Callers that must later remap the entry's
 *   stored opIndex/ctxIndex (the final pivot gate's compaction) collect
 *   these to identify exactly which pending entries belong to THIS batch —
 *   entry.batchId is unreliable because _currentBatchId is never populated
 *   in production (always null), so batchId scoping cannot discriminate.
 */
function recordPendingBroadcast(bot: BotLike, entry: PendingEntry & { opIndex?: unknown; ctxIndex?: unknown }): string | null {
    if (!bot.manager || !entry || !entry.order || !entry.finalInts) return null;
    if (!bot.manager._pendingBroadcasts || !(bot.manager._pendingBroadcasts instanceof Map)) {
        bot.manager._pendingBroadcasts = new Map();
    }
    const fingerprint = createOpFingerprintForSlot(bot, entry.order, entry.finalInts, entry.order.id);
    if (!fingerprint) {
        bot.manager.logger.log?.(
            `[COW] Skipped pending-broadcast record: could not build fingerprint for ${entry.order?.id || 'unknown'}`,
            'warn'
        );
        return null;
    }
    bot.manager._pendingBroadcasts.set(fingerprint, {
        fingerprint,
        opIndex: entry.opIndex,
        ctxIndex: entry.ctxIndex,
        slotId: entry.order.id,
        orderId: entry.order.id,
        orderType: entry.order.type,
        order: entry.order,
        finalInts: entry.finalInts,
        batchId: bot._currentBatchId != null ? String(bot._currentBatchId) : null,
        recordedAt: Date.now()
    });
    return fingerprint;
}

/**
 * Clear the pending-broadcast cache.
 * @param {Map} pendingBroadcasts
 */
function clearPendingBroadcasts(pendingBroadcasts: unknown) {
    if (pendingBroadcasts instanceof Map) {
        pendingBroadcasts.clear();
    }
}

/**
 * Human-readable label for an order returned by findCrossedOrder.
 * Master orders carry id/orderId; unmatched chain orders carry
 * chainOrderId; pending-broadcast entries carry slotId and order.
 * @param {Object} crossed
 * @returns {string}
 */
function crossedOrderLabel(crossed: JsonObj): string {
    if (!crossed) return 'unknown';
    const id = crossed.id || crossed.chainOrderId || crossed.slotId || 'unknown';
    const orderId = crossed.orderId || crossed.chainOrderId || 'n/a';
    const type = crossed.type || (crossed.order as JsonObj | undefined)?.type || 'unknown';
    const price = crossed.price ?? (crossed.order as JsonObj | undefined)?.price;
    return `${type} ${id} (${orderId}) @${price != null ? Format.formatPrice6(Number(price)) : 'n/a'}`;
}

/**
 * Build the candidate set for crossing-placement checks: master orders
 * plus chain-side orders that may exist on chain but are not (yet)
 * adopted into the master grid — pending broadcasts from earlier
 * uncertain batches and unmatched chain orders (orphans). Without these,
 * an UPDATE-only rotation batch can re-price across an un-adopted chain
 * order that master-grid-only checks cannot see (the pending/unmatched
 * batch guards fire only for CREATE batches).
 *
 * Delegates to the shared order-utils builder so every crossing guard (COW
 * create/rotation/fallback, startup reconcile placement, price-correction)
 * sees the same set. Pending entries are pushed as wrappers (slotId +
 * order): their inner order has no chain id yet, so orderId-only
 * predicates would blind the guard to them — the shared
 * isCrossingCheckCandidate predicate accepts slot-id-only wrappers.
 * @param {Object} bot
 * @returns {unknown[]}
 */
function buildCrossingCandidates(bot: BotLike): JsonObj[] {
    return orderUtils.buildCrossingCheckCandidates(bot?.manager);
}

/**
 * Drop only the pending-broadcast entries for the given CREATE slots.
 *
 * Used by the re-plan path: the original plan's ops are abandoned with its
 * working grid, so their pending entries must not trip the recursion's own
 * pending-broadcast guard. Entries recorded by an EARLIER unresolved batch
 * (different slots) are KEPT — clearing them here would let the fresh plan
 * re-create slots whose earlier uncertain broadcast may have landed
 * (duplicate orders). The batch-entry guard only fires for batches WITH
 * CREATE actions, so a create-less batch can reach the re-plan path while
 * earlier entries are still live.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} actions - The abandoned batch's actions (COW_ACTIONS)
 */
function clearPendingBroadcastsForSlots(bot: BotLike, actions: JsonObj[]) {
    if (!(bot.manager?._pendingBroadcasts instanceof Map) || !Array.isArray(actions)) return;
    const slotIds = new Set(
        actions
            .filter((a) => a?.type === COW_ACTIONS.CREATE)
            .map((a) => a?.id)
            .filter(Boolean)
    );
    if (slotIds.size === 0) return;
    for (const [fp, entry] of bot.manager._pendingBroadcasts) {
        if (entry?.slotId && slotIds.has(entry.slotId)) {
            bot.manager._pendingBroadcasts.delete(fp);
        }
    }
}

/**
 * Pop a pushed working-grid stack entry exactly once, guarded on the push
 * marker (manager-owned discipline — see OrderManager._pushWorkingGridRef /
 * _popWorkingGridRef). Results that were never pushed (aborted plans,
 * no-trigger processFilledOrders outputs, updateOrdersOnChainPlan cowResults,
 * reconcileGridOrders null results) leave the stack untouched — an unmatched
 * pop could steal a nested grid's entry.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} cowResult - Rebalance/COW result carrying _workingGridPushed
 */
function popPushedWorkingGrid(bot: BotLike, cowResult: JsonObj) {
    bot.manager?._popWorkingGridRef?.(cowResult);
}

/**
 * Defer an uncertain-broadcast reconciliation on an ambiguous chain read
 * (empty/truncated/failed). An empty snapshot may be a node lagging behind
 * the just-broadcast transaction and a truncated get_full_accounts window
 * omits the freshest orders (exactly the batch's creates), so absence is
 * never authoritative: the pending-broadcast protection is kept and a
 * structural resync is requested so the next cycle adopts any landed orders.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} detail - The failure detail (before the common suffix)
 * @param {string} suffix - Parenthetical explanation appended to the message
 * @param {string} resyncReason - Reason string passed to the structural resync
 * @param {Object} [resyncOptions={}] - Extra resync context (batchId, truncated...)
 * @returns {Object} Ambiguous-read reconciliation result
 */
async function deferUncertainBroadcastRead(bot: BotLike, detail: string, suffix: string, resyncReason: string, resyncOptions: JsonObj = {}) {
    bot.manager.logger.log(
        `[COW][UNCERTAIN] ${detail}; keeping pending-broadcast protection ${suffix}`,
        'warn'
    );
    // Fix #6 (docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md §2): an ambiguous/truncated chain read is
    // node lag, not a missing order — the broadcast already succeeded. Previously every
    // such read requested a structural resync, piling pending broadcasts (up to 14) and
    // forcing a resync mid-broadcast (the <bot> 06:43Z thrash). The pending-broadcast
    // protection already prevents double-creates on the next cycle, so we keep it and
    // only escalate to a structural resync once per cooldown window. The next clean
    // read adopts any landed orders without the churn.
    const cooldownMs = (bot.config?.maintenance?.uncertainReadResyncCooldownMs as number) || 30_000;
    const lastAt = bot._lastUncertainResyncAt || 0;
    if (Date.now() - lastAt >= cooldownMs && typeof bot.manager.requestStructuralGridResync === 'function') {
        bot._lastUncertainResyncAt = Date.now();
        await bot.manager.requestStructuralGridResync(resyncReason, resyncOptions);
    } else {
        bot.manager.logger.log(
            `[COW][UNCERTAIN] Structural resync escalation suppressed (cooldown ${cooldownMs}ms) — ` +
            `pending-broadcast protection retained; next clean read adopts landed orders.`,
            'debug'
        );
    }
    return { executed: false, hadRotation: false, uncertain: true, ambiguousRead: true };
}

/**
 * Build a fingerprint for an on-chain order so it can be matched against
 * the pending-broadcast cache.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrder
 * @param {string} slotId
 * @returns {string|null}
 */
function buildChainOrderFingerprint(bot: BotLike, chainOrder: ChainOrderLike, slotId: string) {
    if (!chainOrder || !slotId) return null;
    const normalized = normalizeChainOrderForPendingMatch(bot, chainOrder);
    if (!normalized) return null;
    return buildCreateOpFingerprint({
        side: normalized.side,
        assetA: normalized.assetA,
        assetB: normalized.assetB,
        sellInt: normalized.sellInt,
        receiveInt: normalized.receiveInt,
        slotId
    });
}

/**
 * Normalize raw BitShares limit_order_object data into the integer tuple
 * used by pending-broadcast recovery.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrder
 * @returns {{side: string, assetA: string, assetB: string, sellInt: number, receiveInt: number}|null}
 */
function normalizeChainOrderForPendingMatch(bot: BotLike, chainOrder: ChainOrderLike): NormalizedChainOrder | null {
    if (!chainOrder) return null;
    const assetA = bot.manager?.assets?.assetA?.id;
    const assetB = bot.manager?.assets?.assetB?.id;
    if (!assetA || !assetB) return null;

    const explicitSide = (chainOrder.type === 'buy' || chainOrder.type === 'sell')
        ? chainOrder.type
        : null;
    const explicitSell = chainOrder.sellInt ?? chainOrder.sell;
    const explicitReceive = chainOrder.receiveInt ?? chainOrder.receive;
    if (explicitSide && Number.isFinite(Number(explicitSell)) && Number.isFinite(Number(explicitReceive))) {
        return {
            side: explicitSide,
            assetA,
            assetB,
            sellInt: Number(explicitSell),
            receiveInt: Number(explicitReceive)
        };
    }

    const base = chainOrder.sell_price?.base;
    const quote = chainOrder.sell_price?.quote;
    if (!base || !quote || !base.asset_id || !quote.asset_id) return null;
    const baseAmount = Number(base.amount);
    const quoteAmount = Number(quote.amount);
    if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount)) return null;

    if (base.asset_id === assetA && quote.asset_id === assetB) {
        return { side: 'sell', assetA, assetB, sellInt: baseAmount, receiveInt: quoteAmount };
    }
    if (base.asset_id === assetB && quote.asset_id === assetA) {
        return { side: 'buy', assetA, assetB, sellInt: baseAmount, receiveInt: quoteAmount };
    }
    return null;
}

/**
 * Find a chain order that matches a planned slot using price+size proximity.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} chainOrders - Open chain orders for the account
 * @param {string} slotId - Planned grid slot id
 * @param {Object} planned - { sell, receive, orderType } integers from the planned op
 * @returns {Object|null} Matching chain order, or null
 */
function findChainOrderForSlot(bot: BotLike, chainOrders: ChainOrderLike[], slotId: string, planned: { sell?: unknown; receive?: unknown; orderType?: unknown; side?: unknown; fingerprint?: unknown } | null | undefined) {
    if (!Array.isArray(chainOrders) || !slotId) return null;
    const assetA = bot.manager?.assets?.assetA?.id;
    const assetB = bot.manager?.assets?.assetB?.id;
    if (!assetA || !assetB) return null;

    // 1. Exact fingerprint match.
    for (const o of chainOrders) {
        const fp = buildChainOrderFingerprint(bot, o, slotId);
        if (fp && bot.manager._pendingBroadcasts?.has(fp)) {
            return o;
        }
    }
    if (!planned || !Number.isFinite(Number(planned.sell)) || !Number.isFinite(Number(planned.receive))) {
        return null;
    }
    // 2. Near match: same side, sell int within 1, receive int within 1% or 2 units.
    const targetSell = Number(planned.sell);
    const targetReceive = Number(planned.receive);
    const plannedSide = planned.orderType ||
        planned.side ||
        bot.manager._pendingBroadcasts?.get?.(String(planned.fingerprint))?.orderType ||
        bot.manager.orders.get(slotId)?.type;
    if (plannedSide !== 'buy' && plannedSide !== 'sell') {
        return null;
    }
    let best = null;
    let bestDistance = Infinity;
    for (const o of chainOrders) {
        const normalized = normalizeChainOrderForPendingMatch(bot, o);
        if (!normalized) continue;
        if (normalized.side !== plannedSide) continue;
        const sell = Number(normalized.sellInt);
        const receive = Number(normalized.receiveInt);
        if (!Number.isFinite(sell) || !Number.isFinite(receive)) continue;
        const sellDelta = Math.abs(sell - targetSell);
        const receiveDelta = Math.abs(receive - targetReceive);
        const receiveTol = Math.max(2, Math.floor(targetReceive * 0.01));
        if (sellDelta > 1 || receiveDelta > receiveTol) continue;
        const distance = sellDelta * 1000 + receiveDelta;
        if (distance < bestDistance) {
            best = o;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * Reconcile a broadcast whose chain state is unknown.
 * Thin wrapper that optionally acquires _fillProcessingLock before delegating.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {BroadcastUncertainError} err
 * @param {Array<Object>} opContexts
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function reconcileAfterUncertainBroadcast(bot: BotLike, err: unknown, opContexts: OpPhase[], options: JsonObj = {}) {
    return acquireIfNotHeld(bot.manager?._fillProcessingLock, () =>
        reconcileAfterUncertainBroadcastImpl(bot, err, opContexts, options)
    );
}

/**
 * Match pending broadcasts against a chain snapshot (first pass by slot
 * probe, second pass by fingerprint across all pending slots), then
 * re-read the chain for discarded CREATEs to close the TOCTOU window.
 * Returns `{ adopted, discarded }`, or `{ deferred }` when the re-read
 * is ambiguous/failed and the caller must defer (pending protection kept).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} pending
 * @param {Array} chainSnapshot
 * @param {Array} opContexts
 * @param {*} accountRef
 * @param {*} err
 */
async function matchPendingToChain(bot: BotLike, pending: PendingEntry[], chainSnapshot: ChainOrderLike[], opContexts: OpPhase[], accountRef: unknown, err: unknown): Promise<{ adopted: AdoptedEntry[]; discarded: PendingEntry[] } | { deferred: JsonObj }> {
    const adopted: AdoptedEntry[] = [];
    let discarded: PendingEntry[] = [];

    // 2. For each pending broadcast, look for a chain match.
    for (const entry of pending) {
        const match = findChainOrderForPendingEntry(bot, chainSnapshot, entry);
        if (match) {
            adopted.push({ entry, match });
        } else {
            discarded.push(entry);
        }
    }

    // 2b. Second pass: search for any unmatched chain orders by fingerprint
    // across all known pending slots.
    if (adopted.length < pending.length) {
        const adoptedSlotIds = new Set(adopted.map((a) => a.entry.slotId));
        for (const o of chainSnapshot) {
            if (adopted.some((a) => a.match.id === o.id)) continue;
            for (const entry of pending) {
                if (adoptedSlotIds.has(entry.slotId)) continue;
                const fp = buildChainOrderFingerprint(bot, o, String(entry.slotId));
                if (fp && bot.manager._pendingBroadcasts?.has(fp)) {
                    adopted.push({ entry, match: o });
                    adoptedSlotIds.add(entry.slotId);
                    break;
                }
            }
        }
        // Rebuild discarded list to remove newly adopted entries.
        const newlyAdoptedSlotIds = new Set(adopted.map((a) => a.entry.slotId));
        discarded = pending.filter((e) => !newlyAdoptedSlotIds.has(e.slotId));
    }

    // 3a. Re-read chain for discarded CREATE entries to catch broadcasts that
    // landed between the initial read and this point (TOCTOU window).
    if (discarded.length > 0 && typeof chainOrders.readOpenOrders === 'function') {
        const createDiscarded = discarded.filter((e) => {
            const ctx = opContexts[e.ctxIndex ?? -1];
            return ctx && ctx.kind === 'create';
        });
        if (createDiscarded.length > 0) {
            try {
                const freshRead = await readOpenOrdersWithMetaSafe(chainOrders, accountRef as string | null | undefined);
                // An empty/truncated re-read is as ambiguous as the initial
                // read: a truncated get_full_accounts window omits the freshest
                // creates (exactly the discarded ones being re-verified), and an
                // empty snapshot may be a node lagging behind the just-broadcast
                // transaction. Absence in either case is NOT authoritative —
                // discarding here would free the slot + clear the pending
                // protection and let the next cycle re-create (duplicate) an
                // order that actually landed in the TOCTOU window. Keep the
                // pending-broadcast protection and defer to a structural resync.
                if (!isAuthoritativeChainRead(freshRead)) {
                    const ambiguous = !freshRead || !Array.isArray(freshRead.orders) || freshRead.orders.length === 0;
                    return {
                        deferred: await deferUncertainBroadcastRead(
                            bot,
                            `${ambiguous ? 'Empty' : 'Truncated'} re-read for ${createDiscarded.length} discarded CREATE(s)`,
                            '(absence is not authoritative on an ambiguous re-read)',
                            'uncertain broadcast — ambiguous re-read for discarded creates',
                            { batchId: (err as JsonObj | undefined)?.batchId || null, truncated: !ambiguous }
                        )
                    };
                }
                const freshChain = freshRead.orders as ChainOrderLike[];
                const remainingDiscarded: PendingEntry[] = [];
                for (const entry of discarded) {
                    const ctx = opContexts[entry.ctxIndex ?? -1];
                    if (ctx && ctx.kind === 'create') {
                        const match = findChainOrderForPendingEntry(bot, freshChain, entry);
                        if (match) {
                            adopted.push({ entry, match });
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Late-adopted discarded CREATE for slot ${entry.slotId} (${match.id}) via fresh chain read`,
                                'info'
                            );
                        } else {
                            remainingDiscarded.push(entry);
                        }
                    } else {
                        remainingDiscarded.push(entry);
                    }
                }
                discarded = remainingDiscarded;
            } catch (reReadErr) {
                return {
                    deferred: await deferUncertainBroadcastRead(
                        bot,
                        `Fresh chain read for late adoption FAILED (${getErrorMessage(reReadErr)})`,
                        '(absence is not authoritative on a failed re-read)',
                        'uncertain broadcast — failed re-read for discarded creates',
                        { batchId: (err as JsonObj | undefined)?.batchId || null }
                    )
                };
            }
        }
    }

    return { adopted, discarded };
}

/**
 * Adopt matched pending broadcasts into the master grid (CREATE slots
 * synchronize with the chain) and clear their pending entries.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} adopted
 * @param {Array} opContexts
 * @returns {Promise<number>} adoptedCount
 */
async function adoptMatchedEntries(bot: BotLike, adopted: AdoptedEntry[], opContexts: OpPhase[]): Promise<number> {
    let adoptedCount = 0;
    for (const { entry, match } of adopted) {
        adoptedCount++;
        const plannedOpCtx = opContexts[entry.ctxIndex ?? -1];
        if (plannedOpCtx && plannedOpCtx.kind === 'create') {
            const chainOrderId = match.id;
            const expectedType = plannedOpCtx.order?.type || entry.orderType;

            try {
                const btsFeeData = getAssetFeesSafe('BTS');
                await bot.manager.synchronizeWithChain({
                    gridOrderId: plannedOpCtx.order?.id || String(entry.slotId),
                    chainOrderId,
                    expectedType,
                    fee: btsFeeData?.createFee || 0,
                    order: plannedOpCtx.order ?? entry.order ?? null,
                }, 'createOrder');
            } catch (syncErr) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Failed to adopt matched order ${chainOrderId} for slot ${entry.slotId}: ${getErrorMessage(syncErr)}`,
                    'error'
                );
            }
        }

        // Remove from pending broadcasts — matched entries are resolved.
        if (entry.fingerprint != null && bot.manager._pendingBroadcasts?.has(String(entry.fingerprint))) {
            bot.manager._pendingBroadcasts.delete(String(entry.fingerprint));
        }
    }
    return adoptedCount;
}

/**
 * Restore discarded CREATE slots to creation-uncertain state and clear
 * their pending entries; residual pending entries that survive the
 * decide phase are cleaned defensively.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} discarded
 * @param {Array} opContexts
 * @returns {Promise<number>} discardedCount
 */
async function restoreDiscardedCreates(bot: BotLike, discarded: PendingEntry[], opContexts: OpPhase[]): Promise<number> {
    let discardedCount = 0;
    for (const entry of discarded) {
        discardedCount++;
        const plannedOpCtx = opContexts[entry.ctxIndex ?? -1];
        // A pending-broadcast entry is always a CREATE (recordPendingBroadcast
        // only records creates), so the slot restore below must not depend on
        // opContexts being present: the PENDING_BROADCASTS reject path invokes
        // this reconcile with an empty opContexts array, and skipping the
        // restore would leave the slot a clean hole that the next cycle could
        // re-CREATE (duplicate) once the original broadcast lands. The inner
        // entry.order checks still choose between creation-uncertain restore
        // and plain target-size restore.
        const isDiscardedCreate = (plannedOpCtx && plannedOpCtx.kind === 'create')
            || (entry.order?.id && entry.order?.type);
        if (isDiscardedCreate) {
            try {
                // Restore target grid sizes for discarded CREATEs so the slots are
                // immediately available for the next cycle without waiting for a
                // structural resync. entry.order is the pending-broadcast target
                // order (captured at broadcast time, before the working grid was
                // committed or discarded).
                if (entry.order?.id && entry.order?.size && entry.order?.type) {
                    const slot = bot.manager.orders.get(entry.order.id);
                    if (slot) {
                        const plannedType = entry.order.type;
                        if (plannedType === ORDER_TYPES.BUY || plannedType === ORDER_TYPES.SELL) {
                            // Creation-uncertain state: the broadcast MAY have
                            // landed on chain even though no match was found yet.
                            // Keep the planned type and size on the slot (VIRTUAL)
                            // instead of restoring the SPREAD placeholder, whose
                            // size is normalized to 0 by the SPREAD invariant.
                            // A possibly-landed order must never be released as a
                            // clean hole — that frees the slot for a duplicate
                            // CREATE and later orphan adoption double-commits the
                            // funds. The next sync's orphan adoption reconciles a
                            // landed order into this slot cleanly.
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Restored creation-uncertain state for slot ${entry.slotId} ` +
                                `(type=${plannedType}, size: ${entry.order.size}); next sync adoption will reconcile landed orders`,
                                'warn'
                            );
                            const updates = [{
                                ...slot,
                                type: plannedType,
                                size: entry.order.size,
                                price: entry.order.price,
                                state: ORDER_STATES.VIRTUAL,
                                // Durable orphan evidence: this sized VIRTUAL slot
                                // is the product of a lost CREATE broadcast result,
                                // not a normal planned slot. The loadGrid sanitizer
                                // only drops the size for flagged slots.
                                createUncertain: true,
                                // Clear any stale order identity: the broadcast
                                // MAY have landed, but the slot must look like a
                                // clean adoption target (no orderId/rawOnChain)
                                // so the next sync's orphan adoption can reconcile
                                // a landed order into it. A retained orderId would
                                // make pass-2 adoption skip the slot (it requires
                                // !adoptedSlot.orderId), leaving the landed order
                                // unmatched and auto-cancelled; a stale rawOnChain
                                // would feed a bogus drift signal.
                                orderId: null,
                                rawOnChain: null,
                            }];
                            if (typeof bot.manager.applyGridUpdateBatch === 'function') {
                                await bot.manager.applyGridUpdateBatch(updates, 'uncertain-broadcast-discard-restore');
                            }
                        } else {
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Restored target size for discarded CREATE slot ${entry.slotId} (size: ${entry.order.size})`,
                                'debug'
                            );
                            const updates = [{
                                ...slot,
                                size: entry.order.size,
                                price: entry.order.price,
                            }];
                            if (typeof bot.manager.applyGridUpdateBatch === 'function') {
                                await bot.manager.applyGridUpdateBatch(updates, 'uncertain-broadcast-discard-restore');
                            }
                        }
                    } else {
                        // Slot missing from master (grid reset raced the uncertain
                        // broadcast). Deleting the pending entry below without
                        // restoring anything would leave a clean hole the next
                        // cycle re-CREATEs — duplicating a possibly-landed order.
                        // Materialize the creation-uncertain slot from the
                        // broadcast-time descriptor so the next sync's orphan
                        // adoption reconciles a landed order into it.
                        const missingType = entry.order.type;
                        if (missingType === ORDER_TYPES.BUY || missingType === ORDER_TYPES.SELL) {
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Slot ${entry.order.id} missing from master after discard — materializing creation-uncertain state ` +
                                `(type=${missingType}, size: ${entry.order.size}); next sync adoption will reconcile landed orders`,
                                'warn'
                            );
                            const updates = [{
                                id: entry.order.id,
                                type: missingType,
                                size: entry.order.size,
                                price: entry.order.price,
                                state: ORDER_STATES.VIRTUAL,
                                createUncertain: true,
                                orderId: null,
                                rawOnChain: null,
                            }];
                            if (typeof bot.manager.applyGridUpdateBatch === 'function') {
                                await bot.manager.applyGridUpdateBatch(updates, 'uncertain-broadcast-discard-restore');
                            }
                        } else {
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Slot ${entry.order.id} missing from master after discard with unrecognized type ${missingType} — cannot reconstruct creation-uncertain state; next sync must adopt a landed order as an orphan`,
                                'error'
                            );
                        }
                    }
                } else {
                    bot.manager.logger.log(
                        `[COW][UNCERTAIN] Discarded CREATE for slot ${entry.slotId} has no usable placement descriptor (id=${entry.order?.id ?? 'none'}, size=${entry.order?.size ?? 'none'}, type=${entry.order?.type ?? 'none'}) — nothing restored; next sync must adopt a landed order as an orphan`,
                        'error'
                    );
                }
            } catch (restoreErr) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Failed to restore slot ${entry.slotId} after discard: ${getErrorMessage(restoreErr)}`,
                    'error'
                );
            }
        } else {
            bot.manager.logger.log(
                `[COW][UNCERTAIN] Discarded pending broadcast for slot ${entry.slotId} is not a recognizable CREATE (no create opContext, no order id/type) — skipping restore; next sync must adopt a landed order as an orphan`,
                'error'
            );
        }
        // Remove from pending broadcasts.
        if (entry.fingerprint != null && bot.manager._pendingBroadcasts?.has(String(entry.fingerprint))) {
            bot.manager._pendingBroadcasts.delete(String(entry.fingerprint));
        }
    }

    // 4. If some entries remain unresolved (broadcasts that point to opContext
    // indices beyond the array — shouldn't happen, but guard defensively),
    // treat them as discarded.
    const remainingAfterDecide = bot.manager._pendingBroadcasts instanceof Map
        ? bot.manager._pendingBroadcasts.size
        : 0;
    if (remainingAfterDecide > 0) {
        const remainingEntries = Array.from(bot.manager._pendingBroadcasts.values()) as PendingEntry[];
        for (const entry of remainingEntries) {
            discardedCount++;
            bot.manager.logger.log(
                `[COW][UNCERTAIN] Cleaning residual pending broadcast for slot ${entry.slotId} (opIndex=${entry.opIndex})`,
                'debug'
            );
        }
        bot.manager._pendingBroadcasts.clear();
    }
    return discardedCount;
}

/**
 * Request a structural resync when chain orders remain unaccounted for
 * after the uncertain-broadcast reconciliation.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {*} err
 * @param {Array} pending
 * @param {Array} chainSnapshot
 * @param {Array} adopted
 * @param {number} adoptedCount
 * @param {number} discardedCount
 */
async function resyncIfUnreconciled(bot: BotLike, err: unknown, pending: PendingEntry[], chainSnapshot: ChainOrderLike[], adopted: AdoptedEntry[], adoptedCount: number, discardedCount: number) {
    // 7. Request structural resync if any chain orders remain unaccounted for
    // after the reconciliation, ensuring the next cycle re-plans from a clean
    // chain snapshot.
    const alreadyScheduled = bot._structuralGridResyncRunning || bot._structuralGridResyncTimer;
    if (!alreadyScheduled && chainSnapshot.length > 0) {
        // "Unreconciled" must mean chain orders absent from MASTER, not merely
        // absent from this batch's adopted set. Every resting order master
        // already tracks is reconciled by definition; counting those as
        // unreconciled forced a structural resync (grid rebuild + LAST-FILL
        // pivot clear) after every uncertain broadcast on a populated grid.
        const reconciledOrderIds = new Set(adopted.map((a) => a.match?.id).filter(Boolean));
        try {
            const known = collectKnownOnChainOrderIds(bot.manager, null, null).masterIds;
            for (const id of known) reconciledOrderIds.add(id);
        } catch { /* best-effort: fall back to the adopted-only set */ }
        const unreconciledCount = chainSnapshot.filter((o) => !reconciledOrderIds.has(o.id)).length;
        if (unreconciledCount > 0) {
            bot.manager.logger.log(
                `[COW][UNCERTAIN] ${unreconciledCount} chain order(s) unknown to master remain after uncertain ` +
                `broadcast recovery (neither adopted nor tracked). Requesting structural resync.`,
                'warn'
            );
            await requestStructuralResync(
                bot,
                'unreconciled orders after uncertain broadcast',
                {
                    batchId: (err as JsonObj | undefined)?.batchId || null,
                    pendingCount: pending.length,
                    adoptedCount,
                    discardedCount,
                    unreconciledCount
                }
            );
        }
    }
}

/**
 * Reconcile a broadcast whose chain state is unknown (implementation).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {BroadcastUncertainError} err
 * @param {Array<Object>} opContexts
 * @param {Object} options
 * @returns {Promise<Object>}
 */
async function reconcileAfterUncertainBroadcastImpl(bot: BotLike, err: unknown, opContexts: OpPhase[], _options: JsonObj) {
    const startedAt = Date.now();
    const pending: PendingEntry[] = getPendingBroadcasts(bot);
    const createContextCount = opContexts.filter((c: { kind?: unknown } | null | undefined) => c && c.kind === 'create').length;
    const nonCreateContextCount = opContexts.length - createContextCount;

    bot.manager.logger.log(
        `[COW][UNCERTAIN] batchId=${(err as JsonObj | undefined)?.batchId || 'n/a'} ops=${opContexts.length} ` +
        `creates=${createContextCount} nonCreates=${nonCreateContextCount} ` +
        `staleSinceMs=${(err as JsonObj | undefined)?.timeoutMs || 'n/a'}. Entering reconcile-then-decide.`,
        'warn'
    );

    if (!chainOrders?.readOpenOrdersWithMeta) {
        bot.manager.logger.log(
            '[COW][UNCERTAIN] readOpenOrdersWithMeta unavailable; falling back to structural resync only.',
            'error'
        );
        await requestStructuralResync(
            bot,
            'broadcast uncertain — readOpenOrders unavailable',
            { batchId: (err as JsonObj | undefined)?.batchId || null }
        );
        clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
        return { executed: false, hadRotation: false, uncertain: true };
    }

    // 1. Read the chain
    const accountRef = bot.accountId || (bot.account as unknown as { id?: string } | null)?.id || bot.account;
    let chainSnapshot: ChainOrderLike[] = [];
    let chainReadTruncated = false;
    try {
        const chainRead = await chainOrders.readOpenOrdersWithMeta(accountRef);
        chainSnapshot = chainRead.orders;
        chainReadTruncated = chainRead.truncated;
    } catch (readErr) {
        bot.manager.logger.log(
            `[COW][UNCERTAIN] readOpenOrders failed: ${getErrorMessage(readErr)}. ` +
            `Falling back to structural resync.`,
            'error'
        );
        await requestStructuralResync(
            bot,
            'broadcast uncertain — readOpenOrders failed',
            { batchId: (err as JsonObj | undefined)?.batchId || null, error: getErrorMessage(readErr) || String(readErr) }
        );
        clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
        return { executed: false, hadRotation: false, uncertain: true };
    }

    // 1.5. Empty/truncated-read guard: an empty snapshot is ambiguous — the
    // account is either genuinely empty or the node is lagging behind the
    // just-broadcast transaction. A truncated snapshot (get_full_accounts
    // capped limit_orders; fresh creates sort last in the by_account index
    // and are the first entries omitted) is equally ambiguous: the batch's
    // creates may simply be missing from the returned window. Treating every
    // pending broadcast as discarded would clear the pending-broadcast
    // protection and let the next cycle re-CREATE slots whose orders may
    // actually be on chain (duplicate orders). Keep the protection and let
    // the structural resync adopt any landed orders.
    if (pending.length > 0 && (chainSnapshot.length === 0 || chainReadTruncated)) {
        return await deferUncertainBroadcastRead(
            bot,
            `${chainSnapshot.length === 0 ? 'Empty' : 'Truncated'} chain read for ${pending.length} pending broadcast(s)`,
            '(node may be lagging or the result set capped; no discard decisions made)',
            'uncertain broadcast — empty/truncated chain read',
            { batchId: (err as JsonObj | undefined)?.batchId || null, truncated: chainReadTruncated }
        );
    }

    // 2-3a. Match pending broadcasts to the chain: slot probe, fingerprint
    // second pass, and a TOCTOU re-read for discarded CREATEs (see
    // matchPendingToChain). A deferred re-read returns its result directly.
    const matched = await matchPendingToChain(bot, pending, chainSnapshot, opContexts, accountRef, err);
    if ('deferred' in matched) return matched.deferred;
    const { adopted, discarded } = matched;

    // 3b. Apply decisions
    const adoptedCount = await adoptMatchedEntries(bot, adopted, opContexts);
    let discardedCount = await restoreDiscardedCreates(bot, discarded, opContexts);

    // 5. Log structured summary
    const elapsed = Date.now() - startedAt;
    bot.manager.logger.log(
        `[COW][UNCERTAIN] Reconciled: ${adoptedCount} adopted, ${discardedCount} discarded ` +
        `(opContexts=${opContexts.length}, pending=${pending.length}, ` +
        `chainOrders=${chainSnapshot.length}) in ${elapsed}ms.`,
        'info'
    );

    // 6. Persist master grid changes from the reconciliation.
    if (adoptedCount > 0 || discardedCount > 0) {
        if (typeof bot.manager.persistGrid === 'function') {
            try {
                await bot.manager.persistGrid();
            } catch (persistErr) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Persist after reconcile failed: ${getErrorMessage(persistErr)}`,
                    'error'
                );
            }
        }
    }

    // 7. Request structural resync if any chain orders remain unaccounted for
    // after the reconciliation, ensuring the next cycle re-plans from a clean
    // chain snapshot.
    await resyncIfUnreconciled(bot, err, pending, chainSnapshot, adopted, adoptedCount, discardedCount);

    return { executed: false, hadRotation: false, uncertain: true, adoptedCount, discardedCount };
}

/**
 * Check whether to execute creates in outside-in pair mode.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} opContexts
 * @returns {boolean}
 */
function shouldExecuteCreatePairMode(_bot: unknown, opContexts: OpPhase[]) {
    if (!Array.isArray(opContexts) || opContexts.length < 2) return false;
    if (!opContexts.every((ctx) => ctx?.kind === 'create' && ctx?.order)) return false;

    let hasBuy = false;
    let hasSell = false;
    for (const ctx of opContexts) {
        if (ctx.order?.type === ORDER_TYPES.BUY) hasBuy = true;
        if (ctx.order?.type === ORDER_TYPES.SELL) hasSell = true;
        if (hasBuy && hasSell) return true;
    }
    return false;
}

/**
 * Verify one op context against a fresh chain snapshot for pre-retry
 * re-broadcast safety. Verdicts per kind (see the kind-specific verifiers):
 *  - 'absent'  → provably never transmitted → retry safe
 *  - 'landed'  → provably applied on chain → must defer
 *  - 'unknown' → chain state unverifiable → must defer
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} freshChain - Non-empty, non-truncated chain snapshot
 * @param {Object} ctx - Operation context (kind: create/cancel/size-update/rotation)
 * @returns {'absent' | 'landed' | 'unknown'}
 */
function verifyOpAgainstChain(bot: BotLike, freshChain: ChainOrderLike[], ctx: OpPhase): 'absent' | 'landed' | 'unknown' {
    if (ctx.kind === 'create') return verifyCreateAbsent(bot, freshChain, ctx);
    if (ctx.kind === 'cancel') return verifyCancelLanded(freshChain, ctx);
    if (ctx.kind === 'size-update' || ctx.kind === 'rotation') return verifyUpdateUnapplied(freshChain, ctx);
    return 'unknown';
}

/**
 * CREATE verify: 'absent' only when the batch's creates are found NOWHERE in
 * the snapshot (fingerprint/near-match) — never transmitted → retry safe.
 * Any match means the broadcast landed ('landed'). A create without
 * fingerprint data cannot match anything, so it is treated as absent
 * (original semantics).
 */
function verifyCreateAbsent(bot: BotLike, freshChain: ChainOrderLike[], ctx: OpPhase): 'absent' | 'landed' | 'unknown' {
    if (!ctx.finalInts || !ctx.order) return 'absent';
    const finalInts = ctx.finalInts;
    const order = ctx.order;
    const match = findChainOrderForSlot(bot, freshChain, order.id, {
        sell: finalInts.sell,
        receive: finalInts.receive,
        orderType: order.type,
        fingerprint: createOpFingerprintForSlot(bot, order, finalInts, order.id)
    });
    return match ? 'landed' : 'absent';
}

/**
 * CANCEL verify: the order still present → the cancel never landed ('absent',
 * retry safe). Absent from a live snapshot → the cancel landed ('landed').
 * No orderId → unverifiable ('unknown').
 */
function verifyCancelLanded(freshChain: ChainOrderLike[], ctx: OpPhase): 'absent' | 'landed' | 'unknown' {
    const chainOrderId = ctx.order?.orderId;
    if (!chainOrderId) return 'unknown';
    if (!freshChain.some((o) => String(o?.id ?? '') === String(chainOrderId))) {
        return 'landed';
    }
    return 'absent';
}

/**
 * UPDATE verify (size-update/rotation): limit_order_update ops are DELTAS, so
 * a landed broadcast double-applies the size change on re-broadcast. Retry
 * ('absent') only when the chain order is provably UNCHANGED from the
 * pre-update cache (the update never applied). Target applied, partially
 * filled after a landed update, or the order missing (filled/cancelled
 * concurrently) → 'unknown' (defer).
 */
function verifyUpdateUnapplied(freshChain: ChainOrderLike[], ctx: OpPhase): 'absent' | 'landed' | 'unknown' {
    const updateInfo = ctx.updateInfo as JsonObj | undefined;
    const rotation = ctx.rotation as JsonObj | undefined;
    const chainOrderId = ctx.kind === 'size-update'
        ? ((updateInfo?.partialOrder as JsonObj | undefined)?.orderId)
        : ((rotation?.oldOrder as JsonObj | undefined)?.orderId);
    const cachedRaw = ctx.kind === 'size-update'
        ? ((updateInfo?.partialOrder as JsonObj | undefined)?.rawOnChain)
        : ((rotation?.oldOrder as JsonObj | undefined)?.rawOnChain);
    if (!chainOrderId) return 'unknown';
    const chainOrder = freshChain.find(
        (o) => String(o?.id ?? '') === String(chainOrderId)
    );
    if (!chainOrder) return 'unknown';
    if (!chainOrderUnchangedFromCache(chainOrder, cachedRaw as { sell_price?: { base?: { amount?: unknown }; quote?: { amount?: unknown } }; for_sale?: unknown } | null | undefined)) return 'unknown';
    return 'absent';
}

/**
 * Execute operations with retry on BroadcastUncertainError.
 *
 * Never re-broadcasts blindly: an uncertain broadcast may have landed, and
 * re-sending the same ops would duplicate on-chain orders. A retry is only
 * allowed on AUTHORITATIVE ABSENCE — a successful non-empty, non-truncated
 * chain read where every op verifies 'absent' (see verifyOpAgainstChain). An
 * empty read (node may be lagging), a truncated read (get_full_accounts
 * capped the result set; fresh creates sort last and are the first entries
 * omitted), or any 'landed'/'unknown' verdict defers to the post-broadcast
 * reconciliation machinery (pollChainForConfirmation +
 * reconcileAfterUncertainBroadcast), which verifies inclusion and adopts
 * landed orders before the next cycle.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} operations
 * @param {Array} opContexts
 * @returns {Promise<{result: Object, opContexts: Array}>}
 */
async function executeWithRetryOnUncertain(bot: BotLike, operations: unknown[], opContexts: OpPhase[]) {
    const MAX_RETRIES = 1;
    for (let attempt = 1; ; attempt++) {
        try {
            return await executeOperationsWithStrategy(bot, operations, opContexts);
        } catch (err) {
            const isRetriable = err instanceof BroadcastUncertainError
                && !getErrorField<boolean>(err, 'partialOnChainState')
                && attempt <= MAX_RETRIES;
            if (isRetriable) {
                // Verify per operation kind against a live snapshot before
                // re-broadcasting (see verifyOpAgainstChain): only a provably
                // unapplied batch may be retried; a truncated or empty read is
                // never authoritative (nodes lag / get_full_accounts caps the
                // window) → defer.
                let absence: 'absent' | 'landed' | 'unknown' = 'unknown';
                try {
                    const accountRef = bot.accountId || (bot.account as unknown as { id?: string } | null)?.id || bot.account;
                    const freshRead = await chainOrders.readOpenOrdersWithMeta(accountRef);
                    const freshChain = freshRead.orders;
                    // A truncated read (get_full_accounts caps limit_orders, and
                    // fresh creates sort last in the by_account index) omits the
                    // very orders this batch may have landed — 'absent' is not
                    // authoritative here, degrade to 'unknown' and defer.
                    if (isAuthoritativeChainRead(freshRead)) {
                        absence = 'absent';
                        for (const ctx of opContexts) {
                            if (!ctx) continue;
                            const verdict = verifyOpAgainstChain(bot, freshChain, ctx);
                            if (verdict !== 'absent') {
                                absence = verdict;
                                break;
                            }
                        }
                    }
                } catch (verifyErr) {
                    bot.manager.logger.log(
                        `[COW] Pre-retry chain verification failed (non-fatal): ${getErrorMessage(verifyErr)}`,
                        'warn'
                    );
                }

                if (absence === 'absent') {
                    bot.manager.logger.log(
                        `[COW] Broadcast uncertain (attempt ${attempt}/${MAX_RETRIES + 1}); verified unapplied on chain, retrying...`,
                        'warn'
                    );
                    // The CREATE prep recorded pending-broadcast entries for this
                    // batch; re-entering executeOperationsWithStrategy would hit the
                    // PENDING_BROADCASTS guard and fall back to structural resync
                    // instead of re-broadcasting. We have just PROVEN this batch is
                    // absent on chain (authoritative read), so dropping this batch's
                    // own entries is safe and lets the intended re-broadcast happen.
                    // Only THIS batch's slots are dropped; entries from other
                    // unresolved batches are preserved (their broadcasts may have
                    // landed, so clearing them could re-create duplicates).
                    const retriedCreateSlots = (opContexts || [])
                        .filter((ctx) => ctx && ctx.kind === 'create')
                        .map((ctx) => ({ type: COW_ACTIONS.CREATE, id: ctx.id }));
                    if (retriedCreateSlots.length > 0) {
                        clearPendingBroadcastsForSlots(bot, retriedCreateSlots);
                    }
                    await bot._ensureCredentialDaemonWritable('COW batch retry');
                    continue;
                }

                bot.manager.logger.log(
                    `[COW] Broadcast uncertain (attempt ${attempt}/${MAX_RETRIES + 1}); ` +
                    `${absence === 'landed' ? 'operation(s) confirmed applied on chain' : 'chain state unverifiable (empty/truncated/lagging read)'} — ` +
                    `deferring to post-broadcast reconciliation (no blind re-broadcast)`,
                    'warn'
                );
                throw err;
            }
            throw err;
        }
    }
}

/**
 * Summarize a partial (non-atomic) broadcast for the batch-failure catch log.
 * Supports both the pair-mode grouped path (groupsBroadcast/groupsTotal) and
 * the chunked broadcast path. For chunked broadcasts only fully-executed
 * chunks are counted as broadcast: chunks that failed are excluded, and
 * chunks that were never attempted (aborted after a definitive failure) are
 * excluded too, so the ratio reflects how many chunks actually completed.
 * @param {Error} err - The partial-state error thrown by the execution path
 * @returns {string} e.g. "1/3 chunks broadcast" or "1/2 groups broadcast"
 */
function formatPartialBroadcastSummary(err: unknown) {
    if (!err || typeof err !== 'object') return '?/?';
    const info = err as JsonObj;
    if (info.chunkedBroadcast === true) {
        const total = Number.isFinite(Number(info.chunksTotal)) ? Number(info.chunksTotal) : null;
        const failed = Number.isFinite(Number(info.chunksFailed)) ? Number(info.chunksFailed) : 0;
        const aborted = Number.isFinite(Number(info.chunksAborted)) ? Number(info.chunksAborted) : 0;
        if (total === null) return '?/? chunks broadcast';
        const broadcast = Math.max(0, total - failed - aborted);
        return `${broadcast}/${total} chunks broadcast`;
    }
    const broadcast = info.groupsBroadcast;
    const total = info.groupsTotal;
    return `${broadcast ?? '?'}/${total ?? '?'} groups broadcast`;
}

/**
 * Execute a batch with retry-on-uncertain semantics, enforcing a gap-slot
 * per-broadcast operation cap (_getGapSlotBatchSize = gapSlots + 1). When the
 * batch carries more operations than the cap, it is split into sequential
 * broadcast chunks of at most `maxOps` operations each, so a single on-chain
 * transaction never holds more than gapSlots + 1 order operations (the
 * original "N fills per broadcast" intent, applied at the op level rather
 * than the fill level).
 *
 * Failure isolation — no swallowed orders: if one chunk's broadcast is
 * uncertain (BroadcastUncertainError), the remaining chunks are STILL
 * broadcast, so no order is silently dropped. A definitively rejected chunk
 * (e.g. insufficient funds, stale order) aborts the remaining chunks — nothing
 * in a definitively rejected transaction landed, so continuing would only burn
 * rejected broadcasts. The first failure is re-thrown after the loop (with
 * partialOnChainState set when any earlier chunk landed), letting the caller's
 * recovery machinery adopt the landed chunks' orders from the chain and
 * re-plan the failed chunk's orders. Chunks that broadcast successfully are
 * merged into a single grouped result compatible with the existing success
 * path.
 *
 * Known limitation: chunk boundaries are cut by array index, not by create-pair
 * group boundaries. Pair-mode grouping (buy+sell placed outside→center in one
 * transaction) is applied per chunk, so a buy/sell pair that straddles a chunk
 * boundary is placed in two sequential transactions rather than one atomic
 * pair transaction.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} operations
 * @param {Array} opContexts
 * @returns {Promise<{result: Object, opContexts: Array}>}
 */
async function executeChunkedWithRetryOnUncertain(bot: BotLike, operations: unknown[], opContexts: OpPhase[]) {
    const fromAccessor = typeof bot._getMaxOpsPerBroadcast === 'function'
        ? bot._getMaxOpsPerBroadcast()
        : (typeof bot._getGapSlotBatchSize === 'function' ? bot._getGapSlotBatchSize() : undefined);
    const requested = Number(fromAccessor);
    const maxOps = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;
    if (!Array.isArray(operations) || operations.length <= maxOps) {
        return await executeWithRetryOnUncertain(bot, operations, opContexts);
    }

    const chunks: { operations: unknown[]; opContexts: OpPhase[] }[] = [];
    for (let i = 0; i < operations.length; i += maxOps) {
        chunks.push({
            operations: operations.slice(i, i + maxOps),
            opContexts: opContexts.slice(i, i + maxOps),
        });
    }

    bot.manager.logger.log(
        `[COW] Splitting ${operations.length} operations into ${chunks.length} broadcast chunk(s) of at most ${maxOps} ops each (gap-slot batch size).`,
        'info'
    );

    const mergedOperationResults: unknown[] = [];
    const mergedRawResults: unknown[] = [];
    const mergedContexts: OpPhase[] = [];
    let firstFailure: { index: number; err: JsonObj } | null = null;
    let failedChunkCount = 0;
    let abortedChunkCount = 0;
    // Accumulate partial-state markers from EVERY failed chunk, not just the
    // first: a later uncertain chunk that fails mid-pair-groups (landed some
    // groups) carries its own partialOnChainState/broadcastedOperationCount
    // that must contribute to the re-thrown error.
    let landedOpsFromFailures = 0;
    let anyFailurePartial = false;

    for (let idx = 0; idx < chunks.length; idx++) {
        const chunk = chunks[idx];
        // Refresh the broadcast heartbeat per chunk: a multi-chunk sequence
        // holds the broadcast slot for its full duration, so the watchdog (if
        // ever wired to this timestamp) must not observe a stale heartbeat.
        bot._lastBroadcastHeartbeatAt = Date.now();
        bot.manager.logger.log(
            `[COW] Broadcasting chunk ${idx + 1}/${chunks.length} with ${chunk.operations.length} operation(s)...`,
            'info'
        );
        try {
            const exec = await executeWithRetryOnUncertain(bot, chunk.operations, chunk.opContexts);
            const chunkResults = extractOperationResults(exec.result, 'chunked-broadcast', bot.manager?.logger?.log?.bind(bot.manager?.logger));
            mergedOperationResults.push(...chunkResults);
            mergedRawResults.push((exec.result as JsonObj | null | undefined)?.raw || null);
            mergedContexts.push(...exec.opContexts);
        } catch (err) {
            if (firstFailure === null) firstFailure = { index: idx, err: err as JsonObj };
            failedChunkCount++;
            const rawFailedChunkLandedOps = getErrorField<number>(err, 'broadcastedOperationCount');
            const failedChunkLandedOps = Number.isFinite(Number(rawFailedChunkLandedOps))
                ? Number(rawFailedChunkLandedOps)
                : 0;
            landedOpsFromFailures += failedChunkLandedOps;
            if (getErrorField<boolean>(err, 'partialOnChainState') === true || failedChunkLandedOps > 0) anyFailurePartial = true;
            if (err instanceof BroadcastUncertainError) {
                // Uncertainty: the tx result is unknown — the chunk may or may
                // not have landed. Continuing the remaining chunks preserves
                // their orders (no swallowing) and recovery reconciles the
                // uncertain chunk against the chain.
                bot.manager.logger.log(
                    `[COW] Chunk ${idx + 1}/${chunks.length} broadcast uncertain (${getErrorMessage(err)}); ` +
                    `continuing with the remaining ${chunks.length - idx - 1} chunk(s) so no orders are swallowed.`,
                    'error'
                );
                continue;
            }
            // Definitive failure (e.g. insufficient funds, stale order): the
            // transaction was rejected, so nothing in this chunk landed. Pair
            // mode already stops at the first failed group; the chunked wrapper
            // should match — continuing would only burn rejected broadcasts.
            abortedChunkCount = chunks.length - idx - 1;
            bot.manager.logger.log(
                `[COW] Chunk ${idx + 1}/${chunks.length} broadcast failed definitively (${getErrorMessage(err)}); ` +
                `aborting the remaining ${abortedChunkCount} chunk(s) — the rejected chunk landed nothing.`,
                'error'
            );
            break;
        }
    }

    if (firstFailure !== null) {
        const failedErr = firstFailure.err;
        // Preserve partial-state markers from ANY failed chunk (e.g. pair mode
        // landed some groups INSIDE a failing chunk) — the wrapper must only
        // add to them, never downgrade (downgrading would skip the forensic
        // log and force a wasted poll in the caller).
        failedErr.partialOnChainState = mergedContexts.length > 0
            || anyFailurePartial;
        failedErr.chunkedBroadcast = true;
        failedErr.chunksTotal = chunks.length;
        failedErr.chunksFailed = failedChunkCount;
        failedErr.chunksAborted = abortedChunkCount;
        failedErr.broadcastedOperationCount = mergedContexts.length + landedOpsFromFailures;
        throw failedErr;
    }

    // All chunks succeeded — merge into the grouped result shape the success
    // path already understands (same shape as executeOperationsWithStrategy's
    // pair-mode output).
    return {
        result: {
            success: true,
            raw: {
                grouped: true,
                groupsExecuted: chunks.length,
                groupResults: mergedRawResults,
            },
            operation_results: mergedOperationResults,
            grouped: true,
            groupsExecuted: chunks.length
        },
        opContexts: mergedContexts
    };
}

/**
 * Execute blockchain operations with appropriate strategy (single batch or pair mode).
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} operations
 * @param {Array} opContexts
 * @returns {Promise<{result: Object, opContexts: Array}>}
 */
async function executeOperationsWithStrategy(bot: BotLike, operations: unknown[], opContexts: OpPhase[]): Promise<{ result: unknown; opContexts: OpPhase[] }> {
    if (!shouldExecuteCreatePairMode(bot, opContexts)) {
        const result = await chainOrders.executeBatch(bot.account, bot.privateKey, operations as Parameters<typeof chainOrders.executeBatch>[2]);
        return { result, opContexts };
    }

    const createEntries: PendingEntry[] = [];
    for (let i = 0; i < operations.length; i++) {
        createEntries.push({
            operation: operations[i],
            context: opContexts[i],
        });
    }

    const groups = buildOutsideInPairGroupsForCreateEntries(createEntries);
    const mergedOperationResults: unknown[] = [];
    const mergedRawResults: unknown[] = [];
    const mergedContexts: OpPhase[] = [];

    for (let idx = 0; idx < groups.length; idx++) {
        const group = groups[idx];
        const groupOps = group.map((e) => (e as JsonObj).operation);
        const groupContexts = group.map((e) => (e as JsonObj).context);
        bot.manager.logger.log(
            `[COW] Broadcasting create pair group ${idx + 1}/${groups.length} (${groupOps.length} op${groupOps.length > 1 ? 's' : ''}, outside->center)`,
            'info'
        );
        let groupResult;
        try {
            groupResult = await chainOrders.executeBatch(bot.account, bot.privateKey, groupOps as Parameters<typeof chainOrders.executeBatch>[2]);
        } catch (err) {
            const groupsBroadcast = idx;
            const groupsTotal = groups.length;
            const broadcastedOperationCount = mergedContexts.length;
            bot.manager.logger.log(
                `[COW] Grouped create execution failed at group ${idx + 1}/${groupsTotal}; ${groupsBroadcast} group(s) already broadcast (${broadcastedOperationCount} op context(s)). Partial on-chain state is possible.`,
                'error'
            );
            const broadcastErrAugment = err as {
                partialOnChainState?: boolean;
                groupsBroadcast?: number;
                groupsTotal?: number;
                broadcastedOperationCount?: number;
            };
            broadcastErrAugment.partialOnChainState = groupsBroadcast > 0;
            broadcastErrAugment.groupsBroadcast = groupsBroadcast;
            broadcastErrAugment.groupsTotal = groupsTotal;
            broadcastErrAugment.broadcastedOperationCount = broadcastedOperationCount;
            throw err;
        }
        const groupOpResults = extractOperationResults(groupResult, '', bot.manager?.logger?.log?.bind(bot.manager?.logger));

        mergedOperationResults.push(...groupOpResults);
        mergedRawResults.push(groupResult?.raw || null);
        mergedContexts.push(...(groupContexts as OpPhase[]));
    }

    return {
        result: {
            success: true,
            raw: {
                grouped: true,
                groupsExecuted: groups.length,
                groupResults: mergedRawResults,
            },
            operation_results: mergedOperationResults,
            grouped: true,
            groupsExecuted: groups.length
        },
        opContexts: mergedContexts
    };
}

/**
 * Validate that operations can be executed with available funds before broadcasting.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} operations
 * @param {Object} assetA
 * @param {Object} assetB
 * @returns {Object} { isValid: boolean, summary: string }
 */
function validateOperationFunds(bot: BotLike, operations: JsonObj[], assetA: AssetInfo, assetB: AssetInfo): { isValid: boolean; summary: string; violations?: JsonObj[] } {
    if (!operations || operations.length === 0) {
        return { isValid: true, summary: 'No operations to validate' };
    }

    let snap = bot.manager?.getChainFundsSnapshot?.();
    if (!snap) {
        snap = { chainFreeSell: 0, chainFreeBuy: 0 } as unknown as NonNullable<typeof snap>;
        bot.manager?.logger?.log?.(
            '[COW][VALIDATION] getChainFundsSnapshot unavailable — fund validation skipped (assuming no balance)',
            'warn'
        );
    }
    const assetKeyA = assetA.id ?? '';
    const assetKeyB = assetB.id ?? '';
    const netRequiredFunds: Record<string, number> = { [assetKeyA]: 0, [assetKeyB]: 0 };
    const runningRequiredFunds: Record<string, number> = { [assetKeyA]: 0, [assetKeyB]: 0 };
    const peakRequiredFunds: Record<string, number> = { [assetKeyA]: 0, [assetKeyB]: 0 };

    for (const op of operations) {
        const opData = op?.op_data as JsonObj | undefined;
        if (!opData) continue;

        let sellAssetId: string | null = null;
        let sellAmountInt: number | null = null;

        if (op.op_name === 'limit_order_create') {
            const ats = opData.amount_to_sell as JsonObj | undefined;
            sellAssetId = (ats?.asset_id as string | undefined) ?? null;
            sellAmountInt = ats?.amount != null ? Number(ats.amount) : null;
        } else if (op.op_name === 'limit_order_update') {
            const base = (opData.new_price as JsonObj | undefined)?.base as JsonObj | undefined;
            sellAssetId = (base?.asset_id as string | undefined) ?? null;
            sellAmountInt = base?.amount != null ? Number(base.amount) : null;
        }

        if (sellAssetId && sellAmountInt != null) {
            const precision = (sellAssetId === assetKeyA) ? assetA.precision : assetB.precision;
            const assetSymbol = (sellAssetId === assetKeyA) ? assetA.symbol : assetB.symbol;

            if (Number(sellAmountInt) <= 0) {
                return {
                    isValid: false,
                    summary: `[VALIDATION] CRITICAL: Zero amount order detected for ${assetSymbol} (assetId=${sellAssetId})`,
                    violations: [{ asset: assetSymbol, sizeInt: sellAmountInt, reason: 'Zero amount' }]
                };
            }

            let signedDelta = 0;
            if (op.op_name === 'limit_order_update') {
                const deltaAmount = opData.delta_amount_to_sell as JsonObj | undefined;
                const deltaAssetId = deltaAmount?.asset_id;
                const deltaSellInt = deltaAmount?.amount;
                if (deltaAssetId === sellAssetId && Number.isFinite(Number(deltaSellInt))) {
                    signedDelta = blockchainToFloat(deltaSellInt, precision);
                }
            } else {
                signedDelta = blockchainToFloat(sellAmountInt, precision);
            }

            netRequiredFunds[sellAssetId] = quantizeFloat(
                (netRequiredFunds[sellAssetId] || 0) + signedDelta,
                precision
            );

            runningRequiredFunds[sellAssetId] = quantizeFloat(
                (runningRequiredFunds[sellAssetId] || 0) + signedDelta,
                precision
            );

            const nextPeak = Math.max(
                Number(peakRequiredFunds[sellAssetId] || 0),
                Number(runningRequiredFunds[sellAssetId] || 0)
            );
            peakRequiredFunds[sellAssetId] = quantizeFloat(nextPeak, precision);
        }
    }

    const availableFunds: Record<string, number> = {
        [assetKeyA]: quantizeFloat(snap.chainFreeSell || 0, assetA.precision),
        [assetKeyB]: quantizeFloat(snap.chainFreeBuy || 0, assetB.precision)
    };

    const fundViolations: JsonObj[] = [];
    for (const assetId in peakRequiredFunds) {
        const required = peakRequiredFunds[assetId];
        const netRequired = netRequiredFunds[assetId] || 0;
        const available = availableFunds[assetId] || 0;

        const prec = (assetId === assetKeyA) ? assetA.precision : assetB.precision;
        if (floatToBlockchainInt(required, prec) > floatToBlockchainInt(available, prec)) {
            fundViolations.push({
                asset: assetId === assetKeyA ? assetA.symbol : assetB.symbol,
                required,
                netRequired,
                available,
                deficit: quantizeFloat(required - available, prec)
            });
        }
    }

    if (fundViolations.length > 0) {
        let summary = `[VALIDATION] Fund validation FAILED:\n`;
        for (const v of fundViolations) {
            summary += `  ${v.asset}: peakRequired=${Format.formatAmount8(Number(v.required))}, netRequired=${Format.formatAmount8(Number(v.netRequired))}, available=${Format.formatAmount8(Number(v.available))}, deficit=${Format.formatAmount8(Number(v.deficit))}\n`;
        }
        return { isValid: false, summary: summary.trim(), violations: fundViolations };
    }

    const summary = `[VALIDATION] PASSED: ${operations.length} operations`;
    return { isValid: true, summary };
}

/**
 * Resolve the ideal size from an order-like object with fallback.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object|null} orderLike
 * @param {number|null} [fallbackSize=null]
 * @returns {number|null}
 */
function resolveIdealSizeForValidation(_bot: unknown, orderLike: JsonObj | null | undefined, fallbackSize: number | null = null): number | null {
    const nested = orderLike?.order as JsonObj | undefined;
    const candidates = [
        orderLike?.idealSize,
        nested?.idealSize,
        orderLike?.size,
        nested?.size,
        fallbackSize
    ];

    for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }
    }

    return null;
}

/**
 * Validate that an order size is safe to execute.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {number} size
 * @param {string} type
 * @param {Object|null} [orderLike=null]
 * @param {number|null} [fallbackSize=null]
 * @returns {unknown}
 */
function validateOrderSizeForExecution(bot: BotLike, size: number, type: string, orderLike: JsonObj | null = null, fallbackSize: number | null = null) {
    return validateOrderSize(
        size,
        type,
        bot.manager.assets,
        bot.config.gridLimits?.MIN_ORDER_SIZE_FACTOR,
        resolveIdealSizeForValidation(bot, orderLike, fallbackSize),
        bot.config.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE
    );
}

/**
 * GRID-PRICE-INVARIANT (blocking) — thin COW-side wrappers over the shared
 * implementation in order/utils/order.ts. The emitted price for a slot must be
 * that slot's genesis level; range guards only test configured min/max bounds,
 * so an off-grid price inside the bounds had no check on the broadcast path.
 * See docs/GRID_PRICE_INVARIANT.md.
 */
type GridPriceInvariantStats = { checked: number; violated: number; unchecked: number };

function checkGridPriceInvariant(slotId: unknown, price: unknown, genesis: unknown): { ok: boolean; reason: string; expected: number | null; idx: number | null; drift: number | null } {
    return orderUtils.checkGridPriceInvariant(slotId as string | null | undefined, price as string | number | null | undefined, genesis as never);
}

/**
 * Derive the authoritative price for a rotation destination slot.
 *
 * A rotation re-prices to the destination slot, so the destination's genesis
 * level is the authoritative price — not `action.newPrice`, which the planner
 * copies from the destination hole's `order.price` and which is therefore only
 * as sound as whatever last wrote that object. Deriving the emitted price here
 * means a planner bug cannot produce a mis-priced UPDATE on its own; the
 * invariant check remains as the backstop.
 *
 * @returns {number} the destination's genesis level, or NaN when there is no
 *   genesis ladder / no parseable destination index (caller falls back to the
 *   planned price — an undefined grid, which the load and sync gates refuse).
 */
function deriveRotationPrice(bot: BotLike, newGridId: unknown): number {
    try {
        const idx = parseSlotIndex(newGridId);
        if (idx === null || idx === undefined || !Number.isFinite(idx)) return NaN;
        const genesis = (bot?.manager as unknown as JsonObj | undefined)?._genesis as JsonObj | undefined;
        if (!Array.isArray(genesis?.priceLevels) || genesis.priceLevels.length === 0) return NaN;
        const lvl = Number(math.priceForSlot(idx, genesis as unknown as import('./order/utils/math.js').GridGenesis));
        return (Number.isFinite(lvl) && lvl > 0) ? lvl : NaN;
    } catch {
        return NaN;
    }
}

/**
 * Record one GRID-PRICE-INVARIANT check for an emitted order price.
 *
 * BLOCKING: returns false when the price is a genuine off-grid mismatch, so the
 * caller must SKIP the emission. A price that is not a slot's genesis level is
 * not a valid grid price, so placing it is the failure this guard exists to
 * prevent — rejecting is the point, not a side effect.
 *
 * Fails OPEN on anything unjudgeable (no genesis, unparseable id, non-finite
 * price, checker error): those are metadata problems, not off-grid prices, and
 * blocking on them would halt legitimate trading. Only 'off-grid-price' blocks.
 *
 * A missing slotId is counted as unchecked rather than falling back to another
 * id: for a rotation UPDATE the id must be the DESTINATION slot (newPrice is
 * that slot's price), so substituting the source would flag every legitimate
 * relocation. Callers pass the id they actually mean, or nothing.
 *
 * @returns {boolean} true when the caller MAY emit; false when it must skip
 */
function recordGridPriceInvariantCheck(bot: BotLike, slotId: unknown, price: unknown, stats: GridPriceInvariantStats, site: string): boolean {
    try {
        if (slotId == null || slotId === '') {
            stats.unchecked++;
            return true;
        }
        const inv = checkGridPriceInvariant(slotId, price, (bot?.manager as unknown as JsonObj | undefined)?._genesis);
        if (inv.reason !== 'ok' && inv.reason !== 'off-grid-price') {
            stats.unchecked++;
            return true;
        }
        stats.checked++;
        if (inv.ok) {
            // A CLEAN check clears the run for this slot: escalation must mean
            // "rejected N consecutive batches", not "rejected N times ever".
            // Without this reset a slot rejected once an hour would accumulate
            // to the threshold over a day and fire a resync it never earned.
            const streakMap = getInvariantRejectStreak(bot);
            if (streakMap.has(String(slotId))) streakMap.delete(String(slotId));
            return true;
        }
        stats.violated++;
        orderUtils.reportGridPriceInvariant(bot?.manager, String(slotId), price as string | number, site);
        considerGridPriceInvariantEscalation(bot, slotId, price, inv, site);
        return false;
    } catch {
        // A checker failure must never block a broadcast.
        return true;
    }
}

/**
 * Per-slot count of CONSECUTIVE batches that rejected this slot's emission as
 * off-grid, scoped to the BOT rather than the module.
 *
 * Scope matters because the monolithic runtime (`dexbot.ts`, the `dexbot` bin)
 * constructs EVERY active bot in one process, so a module-level map would pool
 * unrelated bots' rejections: one bot rejecting a slot twice would leave the
 * next bot at the threshold on its FIRST rejection and fire a spurious
 * structural resync (reload, possibly a full grid reset) on a healthy bot.
 * Keeping it on the bot also keeps the count from outliving the resync that
 * repairs the slot, and lets tests start from a clean slate.
 *
 * @param {unknown} bot
 * @returns {Map<string, number>}
 */
function getInvariantRejectStreak(bot: BotLike): Map<string, number> {
    if (!(bot?._gridPriceInvariantRejectStreak instanceof Map)) {
        bot._gridPriceInvariantRejectStreak = new Map<string, number>();
    }
    return bot._gridPriceInvariantRejectStreak;
}

/**
 * Escalate a PERSISTENT off-grid rejection to a structural resync.
 *
 * A single rejection is handled correctly by skipping the emission and warning;
 * the next cycle re-plans. But if the corruption lives in-process (the planner
 * carries `candidate.price` straight from `manager.orders`), the next cycle
 * re-plans from the SAME bad `slot.price`, is rejected identically, and warns
 * again -- forever. The slot is dead while the bot looks healthy.
 *
 * After `GRID_PRICE_INVARIANT_RESYNC_THRESHOLD` consecutive rejecting batches
 * for one slot, ask for the structural resync that repairs it (loadGrid derives
 * slot prices from the genesis ladder). Fire-and-forget: the resync is already
 * debounced (`_structuralGridResyncRunning`/`Timer`) and batch-in-flight aware,
 * so repeats inside the cooldown are cheap and safe.
 *
 * @returns {number} the slot's current consecutive-rejection streak
 */
function considerGridPriceInvariantEscalation(bot: BotLike, slotId: unknown, price: unknown, inv: JsonObj, site: string): number {
    const key = String(slotId);
    const streakMap = getInvariantRejectStreak(bot);
    const streak = (streakMap.get(key) || 0) + 1;
    streakMap.set(key, streak);

    const threshold = Number(constantsModule.TIMING?.GRID_PRICE_INVARIANT_RESYNC_THRESHOLD) > 0
        ? Number(constantsModule.TIMING.GRID_PRICE_INVARIANT_RESYNC_THRESHOLD)
        : 3;
    if (streak < threshold) return streak;

    if (typeof bot?.manager?.requestStructuralGridResync !== 'function') {
        bot?.manager?.logger?.log?.(
            `[GRID-PRICE-INVARIANT] ${slotId} rejected ${streak}x consecutively but ` +
            `requestStructuralGridResync is unavailable; slot stays unhealed until restart`,
            'error'
        );
        return streak;
    }

    // Dedicated cooldown key (NOT BOUNDARY_HOLD_RESYNC_COOLDOWN_MS: the watchdogs
    // must tune independently). Once per cooldown window is enough -- the streak
    // keeps counting so a later window escalates again if still unhealed.
    const cooldownMs = Number(constantsModule.TIMING?.GRID_PRICE_INVARIANT_RESYNC_COOLDOWN_MS) > 0
        ? Number(constantsModule.TIMING.GRID_PRICE_INVARIANT_RESYNC_COOLDOWN_MS)
        : 15 * 60 * 1000;
    const now = Date.now();
    const lastAt = Number(bot?._lastGridPriceInvariantResyncAt) || 0;
    if (now - lastAt < cooldownMs) return streak;
    bot._lastGridPriceInvariantResyncAt = now;

    const expected = inv?.expected != null ? Number(inv.expected) : NaN;
    const actual = Number(price);
    bot?.manager?.logger?.log?.(
        `[GRID-PRICE-INVARIANT] ${slotId} (${site}) rejected ${streak} consecutive batch(es) at ` +
        `${Number.isFinite(actual) ? Format.formatPrice6(actual) : 'n/a'} ` +
        `(genesis ${Number.isFinite(expected) ? Format.formatPrice6(expected) : 'n/a'}); ` +
        `requesting structural resync to repair the slot`,
        'error'
    );
    fireStructuralResync(bot, 'grid-price-invariant-violation', {
        slotId: String(slotId),
        expected: Number.isFinite(expected) ? expected : null,
        actual: Number.isFinite(actual) ? actual : null,
        site,
        streak,
    }, '[GRID-PRICE-INVARIANT] Structural resync request failed');
    return streak;
}

/**
 * Emit the per-batch GRID-PRICE-INVARIANT summary. Quiet when the batch had no
 * checkable emission; warn when any off-grid emission was REJECTED, else info.
 * A rejected emission is logged per-site by reportGridPriceInvariant; this is
 * the aggregate so a batch that silently placed fewer orders than planned is
 * explained without reading every line.
 */
function logGridPriceInvariantSummary(bot: BotLike, stats: GridPriceInvariantStats, site: string): void {
    try {
        if (!stats || stats.checked === 0) return;
        bot?.manager?.logger?.log?.(
            `[GRID-PRICE-INVARIANT] site=${site} checked=${stats.checked} ` +
            `violated=${stats.violated} unchecked=${stats.unchecked}`,
            stats.violated > 0 ? 'warn' : 'info'
        );
    } catch { /* summary is best-effort */ }
}

/**
 * P2 observability (advisory, never blocks): count a BUY emitted at or above
 * the last filled BUY pivot.
 *
 * This is the "re-stamp a just-filled BUY above the anchor" shape the
 * LAST-FILL-GUARD exists to block (`BUY > pivot*(1-half)`), so a counted
 * emission means the guard was bypassed (spread correction / stamped gap
 * evacuation) or the pivot was unjudgeable and the probe failed open. The
 * counter makes a bypass leak visible without changing placement policy —
 * the guard already owns enforcement, and turning this into a second gate
 * would re-introduce the reverted placement-guard class.
 *
 * Warns at most once per batch (keyed on `_currentCycleId`). Never throws.
 *
 * @returns {boolean} true when the emission was counted
 */
function recordRestampBuyAboveAnchor(bot: BotLike, price: unknown, type: unknown): boolean {
    try {
        if (type !== ORDER_TYPES.BUY) return false;
        if (bot?.manager?._lastFilledType !== ORDER_TYPES.BUY) return false;
        const pivot = Number(bot?.manager?._lastFilledPrice);
        const p = Number(price);
        if (!Number.isFinite(pivot) || pivot <= 0 || !Number.isFinite(p) || p <= 0) return false;
        // At or above the pivot is the re-stamp shape; a lower BUY is the
        // legitimate rotation target (I3) and is not counted.
        if (p < pivot) return false;
        if (bot._metrics) bot._metrics.restampBuyAboveAnchorCount = (bot._metrics.restampBuyAboveAnchorCount || 0) + 1;
        // Warn at most once per batch. Stored as a single scalar (not a
        // per-cycle map key) so the flag cannot accumulate unbounded keys on
        // the bot across cycles.
        const cycleId = bot?._currentCycleId ?? 'na';
        const botRecord = bot as unknown as Record<string, unknown>;
        if (botRecord._lastRestampWarnCycleId !== cycleId) {
            botRecord._lastRestampWarnCycleId = cycleId;
            bot?.manager?.logger?.log?.(
                `[RESTAMP-BUY] BUY emitted at ${Format.formatPrice6(p)} at/above the last filled BUY ` +
                `${Format.formatPrice6(pivot)} (guard bypass or unjudgeable pivot); counted, not blocked. ` +
                `(reported once per batch)`,
                'warn'
            );
        }
        return true;
    } catch { return false; }
}

/**
 * Collect non-spread-correction CREATE/UPDATE destinations that sit inside
 * the plan's gap band.
 *
 * Mode C(a) SHADOW: the gap band is not unconditionally illegal — spread
 * correction legitimately places INTO it (the LAST-FILL-GUARD bypass exists
 * for exactly that) and gap evacuation moves an order OUT of it. Excluding
 * those origins leaves the genuinely suspicious set: a rail placement whose
 * destination geometry IS the spread. The result is counted/warned, never
 * blocked (see the guard call site for the revert-history rationale).
 *
 * Pure and never throws. A non-finite boundary/gap selects the empty set.
 *
 * @param {Array<Object>|null} actions - COW actions
 * @param {unknown} boundary - The PLAN's boundary (workingBoundary), not the committed one
 * @param {unknown} gapSlots - Gap slot count
 * @returns {string[]} destinations inside the gap band
 */
function collectGapBandPlacementShadowSlots(actions: CowAction[] | null | undefined, boundary: unknown, gapSlots: unknown): string[] {
    try {
        // Explicit null/empty guard BEFORE Number(): Number(null) === 0 and
        // Number('') === 0 would otherwise read an unknown boundary as slot 0
        // and select a real gap band around it (same trap that
        // buildCowResultFromPlan guards for workingBoundary).
        if (boundary === null || boundary === undefined || boundary === '') return [];
        if (gapSlots === null || gapSlots === undefined || gapSlots === '') return [];
        const b = Number(boundary);
        const g = Number(gapSlots);
        if (!Number.isFinite(b) || !Number.isFinite(g) || !Array.isArray(actions)) return [];
        const out: string[] = [];
        for (const action of actions) {
            if (action?.type !== COW_ACTIONS.CREATE && action?.type !== COW_ACTIONS.UPDATE) continue;
            const origin = action?.origin;
            if (origin === COW_ORIGINS.SPREAD_CORRECTION || origin === COW_ORIGINS.GAP_EVACUATION) continue;
            const destId = String(action?.newGridId || action?.id || action?.order?.id || '');
            if (!destId) continue;
            const idx = parseSlotIndex(destId);
            if (idx === null || idx === undefined) continue;
            if (!isSlotIndexInGapBand(idx, b, g)) continue;
            out.push(destId);
        }
        return out;
    } catch { return []; }
}

/**
 * Whether a spread-correction CREATE may bypass the LAST-FILL-GUARD.
 *
 * Remaining purpose: the STARTUP BOOK SEED proxy. Before the first real fill a
 * single-sided book arms the guard on our own resting quote (max bid / min
 * ask) — a proxy that `b14a1fc8` deliberately keeps non-persistent ("a book
 * seed never fossilizes into the snapshot as market truth") because it goes
 * wrong whenever the book is not adjacent to the last fill. Blocking a
 * tightening placement against that proxy would be arbitrary, so the correction
 * is released from it while the local snapshot can be trusted.
 *
 * A real FILL reference always denies the bypass. Since the planner now filters
 * candidates with the SAME predicate the guard applies, planner-built
 * corrections never even propose an op that would need it — the bypass is a
 * proxy-case valve, not a licence to trade through the last real fill.
 *
 * Denied too when the snapshot is stale or has known-unmatched chain orders
 * (a stale edge can hide the real window edge), fail-closed on a gate throw.
 *
 * Exported for tests.
 * @param {Object} bot
 * @returns {boolean} True when the bypass may be used
 */
function isSpreadCorrectionBypassAllowed(bot: BotLike): boolean {
    const mgr = bot?.manager;
    if (!mgr) return true; // no manager state ⇒ nothing for the guard to protect
    // ONE verdict with the planner (evaluateSpreadCorrectionReadiness): the
    // bypass is licensed only when the snapshot is trusted AND no real FILL
    // reference exists. The LAST-FILL-GUARD is fill-based, so a live market
    // price (which only strengthens the planner's crossing floor) must not
    // change this decision. A real fill denies it; a stale or known-unmatched
    // snapshot denies it too (the guard applies instead). Fail-closed (deny
    // bypass) if the gate throws — never less safe than applying the guard.
    try {
        const readiness = evaluateSpreadCorrectionReadiness(mgr);
        return readiness.snapshotTrusted && readiness.fillMarketRef == null;
    } catch {
        return false;
    }
}

/**
 * Refresh the LAST-FILL guard pivot from fills that arrived while the current
 * batch was being planned or broadcast but have not been ingested yet.
 *
 * The pivot (_lastFilledPrice) is recorded per fill-processing batch, but a
 * multi-chunk COW broadcast spans tens of seconds — fills detected mid-cycle
 * sit in _incomingFillQueue until the cycle ends, so ops built for later
 * chunks would be checked against a stale pivot (production incident: a chunk
 * planned with a pre-crash pivot placed asks 0.6% below the true latest fill
 * that was already queued). Peek-only: never drains the queue, the owning
 * fill cycle still processes every entry. Best-effort: returns false when no
 * queued fill yields a usable side + price.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {boolean} True when the pivot was refreshed from queued fills
 */
function refreshLastFillPivotFromQueue(bot: BotLike): boolean {
    try {
        const queue = bot?._incomingFillQueue;
        if (!Array.isArray(queue) || queue.length === 0) return false;
        const mgr = bot?.manager;
        if (!mgr || !mgr.orders) return false;
        const assets = mgr.assets;
        const findSlotByOrderId = (orderId: unknown) => {
            if (!orderId) return null;
            try {
                for (const o of mgr.orders.values()) {
                    if (o?.orderId === orderId) return o as unknown as ManagedOrder;
                }
            } catch { /* ignore iteration errors */ }
            return null;
        };
        let latest: { price: number; type: string } | null = null;
        for (const fill of queue) {
            const fillOp = fill?.op?.[1] || fill;
            const orderId = fillOp?.order_id || fill?.orderId;
            let type: unknown = null;
            let price: number | null = null;
            // FILL ECONOMICS FIRST: the pays/receives amounts are the trade
            // fact. The grid slot is only an identity hint — after a
            // refused-commit adoption it can still be keyed at an old
            // generation price (live incident: slot-118 @1267 for an order
            // that traded at 1345.73), and preferring the slot price made the
            // last-fill pivot / re-anchor judge a market that never traded.
            if (fillOp?.pays && fillOp?.receives && assets?.assetA && assets?.assetB) {
                try {
                    const pays = fillOp.pays as { asset_id?: unknown; amount?: unknown };
                    const receives = fillOp.receives as { amount?: unknown };
                    const paysId = pays.asset_id;
                    const paysAmt = Number(pays.amount);
                    const recvAmt = Number(receives.amount);
                    if (Number.isFinite(paysAmt) && paysAmt > 0 && Number.isFinite(recvAmt) && recvAmt > 0) {
                        const paysFloat = (base: number, precision: number) => base / Math.pow(10, precision);
                        if (paysId === assets.assetA.id) {
                            type = ORDER_TYPES.SELL;
                            price = paysFloat(recvAmt, assets.assetB.precision) / paysFloat(paysAmt, assets.assetA.precision);
                        } else if (paysId === assets.assetB.id) {
                            type = ORDER_TYPES.BUY;
                            price = paysFloat(paysAmt, assets.assetB.precision) / paysFloat(recvAmt, assets.assetA.precision);
                        }
                    }
                } catch { /* best-effort */ }
            }
            // Fall back to the grid slot only when the fill amounts are absent
            // (a limit fill normally executes at its slot price).
            if ((type == null || price == null)) {
                const slot = findSlotByOrderId(orderId);
                if (slot && (slot.type === ORDER_TYPES.BUY || slot.type === ORDER_TYPES.SELL)) {
                    type = slot.type;
                    const slotPrice = Number(slot.price);
                    if (Number.isFinite(slotPrice) && slotPrice > 0) price = slotPrice;
                }
            }
            if ((type === ORDER_TYPES.BUY || type === ORDER_TYPES.SELL)
                && Number.isFinite(price as number) && (price as number) > 0) {
                latest = { price: price as number, type };
            }
        }
        if (!latest) return false;
        // Shared free writer (utils/system) — the same implementation the
        // manager's _setLastFillPivot method delegates to and restoreLast-
        // FillPivot uses, so the queued-fill refresh cannot write a different
        // scalar-family shape than any other pivot writer.
        setLastFillPivot(mgr, (latest as { price: number; type: string }).type, (latest as { price: number; type: string }).price, 'fill');
        try {
            mgr.logger?.log?.(
                `[LAST-FILL-GUARD] Pivot refreshed from ${queue.length} pending queued fill(s): ` +
                `${(latest as { price: number; type: string }).type} @${Format.formatPrice6((latest as { price: number; type: string }).price)}`,
                'debug'
            );
        } catch { /* ignore logging errors */ }
        return true;
    } catch { return false; }
}

/**
 * Resolve the grid increment percent for the LAST-FILL guard in one place so
 * every check site and the batch summary use (and print) the same value.
 * Falls back to the default 0.5 when unset/invalid.
 *
 * CALL CONTRACT: this takes the BOT (`{ manager }`), not the increment or the
 * manager. The lookup order below is `bot.manager.config` first, which works
 * only because `OrderManager` exposes its own `config`. Callers that pass a
 * bare manager instead of a bot get the `bot.config` / DEFAULT_CONFIG
 * fallbacks and silently lose the manager's tuning, so pass the bot.
 * (The manager-first order is deliberate: the guard must use the same
 * increment the grid was built with, not whatever the bot-level config holds.)
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @returns {number} Positive increment percent
 */
function resolveLastFillGuardIncrement(bot: { manager?: BotLike["manager"]; config?: BotLike["config"] }): number {
    const raw = Number(
        bot?.manager?.config?.incrementPercent
        ?? bot?.config?.incrementPercent
        ?? constantsModule?.DEFAULT_CONFIG?.incrementPercent
        ?? 0.5
    );
    if (Number.isFinite(raw) && raw > 0) return raw;
    return Number(constantsModule?.DEFAULT_CONFIG?.incrementPercent) > 0
        ? Number(constantsModule?.DEFAULT_CONFIG?.incrementPercent)
        : 0.5;
}

/**
 * Build COW actions array from a simple plan object.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object|Array} plan
 * @returns {Array}
 */
function buildActionsFromPlan(_bot: BotLike, plan: JsonObj | JsonObj[]): CowAction[] {
    const normalizedPlan: JsonObj = Array.isArray(plan)
        ? { ordersToPlace: plan }
        : (plan || {});

    const ordersToPlace = (normalizedPlan.ordersToPlace ?? []) as CowAction[];
    const ordersToRotate = (normalizedPlan.ordersToRotate ?? []) as JsonObj[];
    const ordersToUpdate = (normalizedPlan.ordersToUpdate ?? []) as JsonObj[];
    const ordersToCancel = (normalizedPlan.ordersToCancel ?? []) as JsonObj[];

    // Per-action origin: guard bypasses are scoped per action (not per batch),
    // so a future rotation entry merged into a correction plan cannot silently
    // inherit the spread-correction bypass. Actions built outside this helper
    // carry no origin and default to guarded (safe default).
    const planOrigin = normalizedPlan.origin as string | undefined;
    // B-stamp inputs: the plan-level boundary + gap width frozen AT
    // PLAN-BUILD TIME. The stamp carries this geometry so the execution
    // guard can bypass on it — and re-verifies it against the LIVE
    // committed geometry at execution time (isEvacuationStampStillValid),
    // downgrading stale stamps to the live probe.
    const mgrView = _bot?.manager as unknown as JsonObj | undefined;
    const frozenBoundaryRaw = Number(
        normalizedPlan.boundaryIdx ?? mgrView?.boundaryIdx
    );
    const frozenGapRaw = Number(
        normalizedPlan.gapSlots ?? mgrView?._gapSlots
    );
    const hasFrozenGeometry = Number.isFinite(frozenBoundaryRaw) && Number.isFinite(frozenGapRaw) && frozenGapRaw >= 0;
    const withOrigin = (action: CowAction, sourceMaster: ManagedOrder | null = null): CowAction => {
        if (!planOrigin) return action;
        // Origin only rides UPDATEs (where the guard reads it). Gap-plan
        // CREATEs carry a provably dead origin — the spread-correction
        // CREATE check falls back to the batch origin, so dropping the
        // per-action origin there is safe. Other plan origins keep riding
        // non-UPDATE actions unchanged.
        if (action?.type !== COW_ACTIONS.UPDATE) {
            return planOrigin === COW_ORIGINS.GAP_EVACUATION ? { ...action } : { ...action, origin: planOrigin };
        }
        if (planOrigin !== COW_ORIGINS.GAP_EVACUATION) return { ...action, origin: planOrigin };
        if (!hasFrozenGeometry) return { ...action, origin: planOrigin };
        // Route through the real stampler: geometry (source in-band, dest
        // rail), bit-exact non-growing size (side precision) and outward
        // repricing must all PROVE — a plan-level origin alone never grants
        // the bypass. Without a source master the proof is impossible, so
        // the action stays unstamped (the live probe at execution can still
        // re-prove it from the master grid).
        const base: CowAction = { ...action, origin: planOrigin };
        if (!sourceMaster) return { ...base, origin: undefined };
        // The stampler wants the ORDER type (SELL/BUY), which rides on
        // action.order.type — action.type is the COW action kind ('update').
        const rotOrderType = action?.order?.type ?? action?.type;
        const proved = stampGapEvacuationRotation(
            base, sourceMaster, action.newPrice as number, action.newSize as number, rotOrderType as string,
            frozenBoundaryRaw, frozenGapRaw, mgrView?.assets as AssetInfo extends never ? never : Parameters<typeof stampGapEvacuationRotation>[7]
        );
        // Proof refused: strip the origin so the action is exactly an
        // unstamped rotation (never an origin claim without a stamp).
        if (!proved?.evacBoundary && !proved?.evacGapSlots) {
            proved.origin = undefined;
        }
        return proved;
    };

    const actions: CowAction[] = [];

    for (const o of ordersToCancel) {
        if (o?.orderId) {
            actions.push({ type: COW_ACTIONS.CANCEL, id: String(o.id), orderId: o.orderId as string | null | undefined });
        }
    }

    for (const r of ordersToRotate) {
        const rv = r as JsonObj;
        const oldOrder = (rv.oldOrder ?? rv) as JsonObj;
        const id = String(oldOrder.id ?? rv.id ?? '');
        const orderId = (oldOrder.orderId ?? rv.orderId) as string | null | undefined;
        const newGridId = String(rv.newGridId ?? id);
        const newSize = Number.isFinite(Number(rv.newSize))
            ? Number(rv.newSize)
            : Number(rv.size || oldOrder.size || 0);
        const newPrice = Number.isFinite(Number(rv.newPrice))
            ? Number(rv.newPrice)
            : Number(rv.price || oldOrder.price);
        const orderType = (rv.type || oldOrder.type) as ManagedOrder['type'];

        if (!id || !orderId || !newGridId || !orderType || !Number.isFinite(newPrice) || !(newSize > 0)) continue;

        actions.push(withOrigin({
            type: COW_ACTIONS.UPDATE,
            id,
            orderId,
            newGridId,
            newSize,
            newPrice,
            order: {
                id: newGridId,
                type: orderType,
                price: newPrice,
                size: newSize
            } as unknown as ManagedOrder
        }, oldOrder as unknown as ManagedOrder));
    }

    for (const o of ordersToUpdate) {
        const ov = o as JsonObj;
        const partialOrder = (ov.partialOrder ?? ov) as JsonObj;
        const id = String(ov.id ?? partialOrder.id ?? '');
        const orderId = (ov.orderId ?? partialOrder.orderId) as string | null | undefined;
        const orderType = (ov.type || partialOrder.type) as ManagedOrder['type'];
        const newSize = Number.isFinite(Number(ov.newSize))
            ? Number(ov.newSize)
            : Number(partialOrder.size || 0);

        if (!id || !orderId) continue;

        actions.push(withOrigin({
            type: COW_ACTIONS.UPDATE,
            id,
            orderId,
            newSize,
            order: {
                ...(partialOrder || {}),
                id,
                orderId,
                type: orderType,
                size: newSize
            } as unknown as ManagedOrder
        }));
    }

    for (const o of ordersToPlace) {
        if (!o?.id) continue;
        actions.push(withOrigin({ type: COW_ACTIONS.CREATE, id: String(o.id), order: o as unknown as ManagedOrder }));
    }

    return actions;
}

/**
 * Build a COW result object (workingGrid + actions) from a simple plan.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object|Array} plan
 * @returns {{workingGrid: any, workingIndexes: Object, workingBoundary: number, actions: Array}}
 */
function buildCowResultFromPlan(bot: BotLike, plan: JsonObj): CowResult {
    const workingGrid = new WorkingGrid(bot.manager.orders, {
        baseVersion: Number.isFinite(Number(bot.manager._gridVersion)) ? bot.manager._gridVersion : 0
    });
    // Guard null/undefined explicitly: Number(null) === 0 would be treated as a
    // valid finite boundary (index 0), silently biasing role classification.
    const rawBoundary = plan?.boundaryIdx;
    // Absent-aware: null/undefined/'' are unknown (NaN), never boundary 0.
    const requestedBoundary = Format.toKnownNumber(rawBoundary);
    const workingBoundary = Number.isFinite(requestedBoundary)
        ? requestedBoundary
        : bot.manager.boundaryIdx;
    const actions = buildActionsFromPlan(bot, plan);

    // Rail-aware hole projection (Phase 2): a cleared in-rail slot stays a
    // rail-typed VIRTUAL hole with its booked size preserved (rotation
    // sources keep the remainder the guard/plan must see); only true
    // gap-band slots become side-neutral SPREAD holes.
    const toWorkingHole = (slot: ManagedOrder) => {
        try {
            const idx = parseSlotIndex(slot?.id);
            // Explicit null/'' guard: the workingBoundary fallback (manager.boundaryIdx)
            // can be null, and Number(null) === 0 would misclassify slot 0 as a BUY
            // rail hole (same trap guarded for plan.boundaryIdx above).
            const b = (workingBoundary === null || workingBoundary === undefined || (workingBoundary as unknown) === '')
                ? NaN
                : Number(workingBoundary);
            const rawGapSlots: unknown = bot?.manager?._gapSlots;
            const gapSlots = (rawGapSlots === null || rawGapSlots === undefined || rawGapSlots === '')
                ? NaN
                : Number(rawGapSlots);
            if (idx !== null && idx !== undefined && Number.isFinite(b) && Number.isFinite(gapSlots) && gapSlots >= 0) {
                if (Number(idx) <= b) return toRailHolePlaceholder(slot, ORDER_TYPES.BUY);
                if (Number(idx) >= getSellStartIdx(b, gapSlots)) return toRailHolePlaceholder(slot, ORDER_TYPES.SELL);
            }
        } catch { /* fall through to SPREAD */ }
        return convertToSpreadPlaceholder(slot);
    };

    for (const action of actions) {
        if (action.type === COW_ACTIONS.CANCEL) {
            const current = workingGrid.get(action.id);
            if (!current) continue;
            workingGrid.set(action.id, toWorkingHole(current));
        } else if (action.type === COW_ACTIONS.CREATE) {
            if (!action.id || !action.order) continue;
            const current = workingGrid.get(action.id) || { id: action.id };
            workingGrid.set(action.id, {
                ...current,
                ...action.order,
                id: action.id,
                state: ORDER_STATES.VIRTUAL,
                orderId: null,
            });
        } else if (action.type === COW_ACTIONS.UPDATE) {
            if (action.newGridId && action.newGridId !== action.id) {
                const current = workingGrid.get(action.id);
                if (current) {
                    workingGrid.set(action.id, toWorkingHole(current));
                }

                const targetId = action.newGridId;
                const targetCurrent = workingGrid.get(targetId) || ({ id: targetId } as unknown as ManagedOrder);
                const rotatedSize = Number.isFinite(Number(action.newSize))
                    ? Number(action.newSize)
                    : Number(targetCurrent.size || 0);
                const rotatedPrice = Number.isFinite(Number(action.newPrice))
                    ? Number(action.newPrice)
                    : Number(action.order?.price ?? targetCurrent.price);

                workingGrid.set(targetId, {
                    ...targetCurrent,
                    ...(action.order || {}),
                    id: targetId,
                    size: rotatedSize,
                    price: rotatedPrice,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null,
                });
            }

            const current = workingGrid.get(action.id);
            if (!current) continue;
            const newSize = Number.isFinite(Number(action.newSize))
                ? Number(action.newSize)
                : Number(current.size || 0);
            workingGrid.set(action.id, {
                ...current,
                ...(action.order || {}),
                id: action.id,
                orderId: action.orderId || current.orderId,
                size: newSize,
            });
        }
    }

    // Refill-slot wire (boundary-hold): producers attach the slot ids of
    // hole-CREATEs that justify this plan's boundary shift; the executor
    // holds the committed boundary when a listed refill is guard-skipped.
    // Absent/non-array => undefined (guarded default at execution, never
    // fail-open). Spread-correction plans never set this (disjoint bypass).
    const refillSlotIds = Array.isArray(plan?.refillSlotIds)
        ? plan.refillSlotIds.filter((id: unknown) => typeof id === 'string' && id.length > 0)
        : undefined;
    // Crawl-ledger wire: exactly which owed records this plan's derivation
    // folded (see CowResult.consumedCrawlIds). Absent/non-array => undefined,
    // which the commit reads as "clear nothing" rather than "clear all".
    const consumedCrawlIds = Array.isArray(plan?.consumedCrawlIds)
        ? (plan.consumedCrawlIds as unknown[])
            .filter((e): e is { slotId: string; side: string; ts?: number } => {
                const rec = e as { slotId?: unknown; side?: unknown } | null;
                return !!rec && typeof rec.slotId === 'string' && rec.slotId.length > 0
                    && typeof rec.side === 'string' && rec.side.length > 0;
            })
        : undefined;
    return {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: workingBoundary as number,
        actions,
        origin: plan.origin as string | undefined,
        ...(refillSlotIds !== undefined ? { refillSlotIds } : {}),
        ...(consumedCrawlIds !== undefined ? { consumedCrawlIds } : {})
    };
}

/**
 * Pre-apply rotation state transitions to the working grid before commit.
 * This makes the COW commit truly atomic for structural changes — source slots
 * are cleared to VIRTUAL and destination slots are activated with the inherited
 * orderId before the working grid is committed to master, eliminating the need
 * for post-commit structural patching in processBatchResults.
 *
 * Only slot-to-slot rotations (newGridId exists) need pre-application;
 * in-place rotations already have their size/price changes in the working grid.
 */
function applyRotationTransitionsToWorkingGrid(bot: BotLike, workingGrid: InstanceType<typeof WorkingGrid>, executedContexts: OpPhase[]) {
    if (!workingGrid || !executedContexts) return;

    for (const ctx of executedContexts) {
        if (ctx.kind !== 'rotation' || !ctx.rotation?.newGridId) continue;

        const rotation = ctx.rotation as JsonObj | undefined;
        const oldOrder = rotation?.oldOrder as JsonObj | undefined;
        const oldOrderId = oldOrder?.id != null ? String(oldOrder.id) : null;
        const newGridId = String(rotation?.newGridId ?? '');
        const newPrice = rotation?.newPrice;
        const newSize = rotation?.newSize;
        const type = rotation?.type;
        if (!newGridId) continue;

        // Source slot → VIRTUAL (if it's a different slot). Phase 2: the
        // source stays a RAIL-TYPED hole with its booked size preserved —
        // only state/orderId/rawOnChain are cleared, never type or size
        // (no SPREAD retype, no zeroing). In-rail sources must remain
        // visible to candidate-selection and evacuation geometry.
        if (oldOrderId && oldOrderId !== newGridId) {
            const sourceSlot = workingGrid.get(oldOrderId);
            if (sourceSlot && sourceSlot.orderId) {
                workingGrid.set(oldOrderId, {
                    ...sourceSlot,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null,
                    rawOnChain: null,
                });
                bot.manager.logger.log(
                    `[COW] Pre-applied rotation: source ${oldOrderId} → VIRTUAL (order ${sourceSlot.orderId} moved to ${newGridId})`,
                    'debug'
                );
            }
        }

        // Destination slot → ACTIVE with inherited orderId from source
        const destSlot = workingGrid.get(newGridId);
        if (destSlot) {
            workingGrid.set(newGridId, {
                ...destSlot,
                id: newGridId,
                type: type as ManagedOrder['type'],
                size: newSize as number,
                price: newPrice as number,
                state: ORDER_STATES.ACTIVE,
                // oldOrder?.orderId is the authoritative source: the rotation
                // moved this orderId from the source slot.  destSlot.orderId
                // is only a fallback for edge cases where the destination
                // already held a prior committed ID (e.g. a partial commit
                // left a stale reference).  The source-of-truth is always the
                // original order being rotated.
                orderId: (oldOrder?.orderId as string | null | undefined) || destSlot.orderId || null,
            });
            bot.manager.logger.log(
                `[COW] Pre-applied rotation: dest ${newGridId} → ACTIVE (orderId=${(oldOrder?.orderId as string | null | undefined) || destSlot.orderId || 'none'})`,
                'debug'
            );
        }
    }
}

/**
 * Poll the chain after an uncertain broadcast to check if CREATE operations
 * were actually accepted. Uses fingerprint matching against readOpenOrders.
 * Falls back to reconciliation if polling cannot confirm within retries.
 *
 * We specifically confirm CREATE operations because they leave a detectable
 * footprint on the chain (new order with matching fingerprint). UPDATEs and
 * CANCELs modify existing orders and cannot be reliably distinguished from
 * "not yet visible" state by simple polling.
 *
 * @param {Object} [options]
 * @param {number} [options.maxPollRetries] - Poll attempts before reconciliation fallback
 * @param {number} [options.pollIntervalMs] - Delay between polls; tests pass 0
 *   to skip the production 1.5s pacing without changing the poll semantics
 * @returns {{ allConfirmed: boolean, confirmed: Array, unconfirmed: Array }}
 */
async function pollChainForConfirmation(bot: BotLike, opContexts: OpPhase[], options: JsonObj = {}): Promise<{
    allConfirmed: boolean;
    confirmed: CreateContext[];
    unconfirmed: OpPhase[];
    confirmedChainIds: string[];
}> {
    const maxPollRetries = Number(options.maxPollRetries) || 4;
    // Test seam (see updateOrdersOnChainBatchCOW): bot._testPollIntervalMs
    // overrides the production pacing when set by the tests. An explicit 0 is
    // honored; null/undefined falls through to the production 1.5s default.
    const explicitPollMs = options.pollIntervalMs;
    const seamMs = bot?._testPollIntervalMs;
    const pollIntervalMs = resolveSeamMs(
        explicitPollMs,
        resolveSeamMs(seamMs, 1500)
    );

    // Only CREATE operations can be confirmed by polling (they appear as new orders on chain)
    const createContexts = opContexts.filter(
        (ctx): ctx is CreateContext => !!ctx && ctx.kind === 'create' && !!ctx.finalInts && !!ctx.order
    );
    if (createContexts.length === 0) {
        return { allConfirmed: false, confirmed: [], unconfirmed: [...opContexts], confirmedChainIds: [] };
    }

    const accountRef = bot.accountId || (bot.account as unknown as { id?: string } | null)?.id || bot.account;
    let remaining: CreateContext[] = [...createContexts];
    // Chain ids of the poll-matched fresh creates. Retained (not just
    // logged) so the poll-confirmed adoption path can re-read them BY ID —
    // the window fallback cannot prove a lagging node has them yet.
    const matchedChainIds: string[] = [];

    for (let attempt = 1; attempt <= maxPollRetries; attempt++) {
        try {
            const chainRead = await readOpenOrdersWithMetaSafe(chainOrders, accountRef);
            const chainSnapshot = chainRead.orders;
            // A truncated read omits the freshest orders — the exact CREATEs
            // this poll is trying to confirm — so absence cannot be
            // distinguished from window truncation. Fall back to the
            // reconciliation machinery immediately instead of burning the
            // remaining polls.
            if (chainRead.truncated) {
                bot.manager.logger.log(
                    `[COW][POLL] Chain read TRUNCATED (account exceeds the get_full_accounts window); ` +
                    `fresh creates cannot be confirmed — deferring to reconciliation`,
                    'warn'
                );
                break;
            }
            if (!Array.isArray(chainSnapshot) || chainSnapshot.length === 0) {
                if (attempt < maxPollRetries) {
                    await sleep(pollIntervalMs);
                }
                continue;
            }

            const stillUnconfirmed: CreateContext[] = [];
            for (const ctx of remaining) {
                const match = findChainOrderForSlot(bot, chainSnapshot, ctx.order.id, {
                    sell: ctx.finalInts.sell,
                    receive: ctx.finalInts.receive,
                    orderType: ctx.order.type,
                    fingerprint: createContexts.length > 0
                        ? createOpFingerprintForSlot(bot, ctx.order, ctx.finalInts, ctx.order.id)
                        : undefined
                });

                if (match) {
                    bot.manager.logger.log(
                        `[COW][POLL] Confirmed CREATE for slot ${ctx.order.id} on chain as ${match.id}`,
                        'debug'
                    );
                    if (match.id && /^1\.7\.\d+$/.test(String(match.id))) matchedChainIds.push(String(match.id));
                } else {
                    stillUnconfirmed.push(ctx);
                }
            }

            if (stillUnconfirmed.length === 0) {
                const confirmed = createContexts;
                bot.manager.logger.log(
                    `[COW][POLL] All ${confirmed.length} CREATE(s) confirmed on chain after ${attempt} poll(s)`,
                    'info'
                );
                return { allConfirmed: true, confirmed, unconfirmed: [], confirmedChainIds: [...matchedChainIds] };
            }

            remaining = stillUnconfirmed;
            if (attempt < maxPollRetries) {
                await sleep(pollIntervalMs);
            }
        } catch (pollErr) {
            bot.manager.logger.log(
                `[COW][POLL] Chain read attempt ${attempt}/${maxPollRetries} failed: ${getErrorMessage(pollErr)}`,
                'warn'
            );
            if (attempt < maxPollRetries) {
                await sleep(pollIntervalMs);
            }
        }
    }

    const confirmed = createContexts.filter((ctx) => !remaining.includes(ctx));
    bot.manager.logger.log(
        `[COW][POLL] ${confirmed.length}/${createContexts.length} CREATE(s) confirmed after ${maxPollRetries} polls; ` +
        `${remaining.length} unconfirmed. Falling back to reconciliation.`,
        'warn'
    );
    return { allConfirmed: false, confirmed, unconfirmed: remaining, confirmedChainIds: [...matchedChainIds] };
}

/**
 * Normalize a producer-supplied refillSlotIds wire into a Set.
 * Absent/empty/non-array => empty (guarded default, never fail-open).
 */
function toRefillSlotIdSet(refillSlotIds: unknown): Set<string> {
    const set = new Set<string>();
    if (Array.isArray(refillSlotIds)) {
        for (const id of refillSlotIds) {
            if (typeof id === 'string' && id.length > 0) set.add(id);
        }
    }
    return set;
}

/**
 * Boundary-hold decision for guard-skipped refills.
 * When a skipped slot is one of the plan's refill slots — a hole-CREATE that
 * justified the planned boundary shift — the committed boundary is kept: the
 * slot was never placed (CREATE skip) or restored to master (UPDATE skip), so
 * committing the planned boundary would strand empty rail holes past it
 * (91->94 with 91-94 empty self-legalizes via resolveGapBand).
 * Unrelated vetoes (skip ids outside the refill set) never pin geometry.
 * The grid still commits; only the boundary value is held (same discipline
 * as the overrun-hold in validateBoundaryCommit).
 */
function resolveRefillBoundaryHold(
    workingBoundary: unknown,
    committedBoundary: unknown,
    skippedUpdateSlotIds: Iterable<string> | null | undefined,
    clampedUpdateSlotIds: Iterable<string> | null | undefined,
    refillSlotIds: unknown,
    skippedCreateSlotIds: Iterable<string> | null | undefined = undefined
): { effectiveBoundary: unknown; heldRefillSlotIds: string[] } {
    const refills = toRefillSlotIdSet(refillSlotIds);
    const heldRefillSlotIds: string[] = [];
    if (refills.size > 0) {
        const seen = new Set<string>();
        const skipCollections = skippedCreateSlotIds !== undefined
            ? [skippedUpdateSlotIds, clampedUpdateSlotIds, skippedCreateSlotIds]
            : [skippedUpdateSlotIds, clampedUpdateSlotIds];
        for (const coll of skipCollections) {
            if (!coll || typeof coll[Symbol.iterator] !== 'function') continue;
            for (const id of coll) {
                if (typeof id === 'string' && refills.has(id) && !seen.has(id)) {
                    seen.add(id);
                    heldRefillSlotIds.push(id);
                }
            }
        }
    }
    return {
        effectiveBoundary: heldRefillSlotIds.length > 0 ? committedBoundary : workingBoundary,
        heldRefillSlotIds
    };
}

/**
 * Derive the boundary the actual rails imply.
 *
 * `boundary` is a claim about where the BUY rail ends and the gap band begins;
 * live orders are the fact. A fill-driven plan built at a re-anchored boundary
 * places COUNTER orders above the committed boundary (SELL fill at slot s =>
 * counter BUY at s - gapSlots). If the refill hold then keeps the old boundary,
 * those counters sit inside the implied band; the next plan sees the old
 * geometry and places a SELL on top of them, collapsing the spread (live
 * incident: a sweep's counters at 1329.7-1345.7 were reclassified as in-band by
 * a hold to 133, then sells were rotated to 1345.728664 — the exact price of
 * the buy that had just filled).
 *
 * Rails are clamped by construction:
 *
 *     maxBuyIdx <= boundary <= minSellIdx - gapSlots - 1
 *
 * Counter orders therefore win over empty refill holes: a held boundary may
 * never strand a placed counter. When the plan did not place an order on the
 * promoted rail (the normal refill-hold case) `maxBuyIdx` stays at/below the
 * committed boundary and the hold is preserved unchanged.
 *
 * @param manager - OrderManager (master grid rails)
 * @param opContexts - Kept op contexts of the batch (post guard/final gate)
 * @param desiredBoundary - Plan boundary (falls back to the committed one)
 * @param gapSlots - Gap band width
 * @returns Boundary implied by the rails, or null when no rail geometry is
 *   usable / the rails already cross (caller keeps the current value).
 */
export function deriveRailBoundary(
    manager: OrderManagerLike,
    opContexts: Iterable<unknown> | null | undefined,
    desiredBoundary: unknown,
    gapSlots: unknown
): { boundary: number | null; maxBuyIdx: number | null; minSellIdx: number | null; clamped: boolean; reason?: string } {
    let rawGap = Format.toKnownNumber(gapSlots);
    if (!Number.isFinite(rawGap)) {
        // Fall back to the genesis gap width before giving up: a restored
        // manager can briefly hold a null _gapSlots while the genesis is set.
        rawGap = Format.toKnownNumber((manager as { _genesis?: { gapSlots?: unknown } })?._genesis?.gapSlots);
    }
    if (!Number.isFinite(rawGap) || rawGap < 0) {
        return { boundary: null, maxBuyIdx: null, minSellIdx: null, clamped: false, reason: 'no-gap' };
    }
    const gap = Math.floor(rawGap);
    const isSide = (t: unknown): t is string => t === ORDER_TYPES.BUY || t === ORDER_TYPES.SELL;
    // Base first: the proximity window below is measured from it.
    const desired = Format.toKnownNumber(desiredBoundary);
    const committed = Format.toKnownNumber((manager as { boundaryIdx?: unknown })?.boundaryIdx);
    const gates = manager as unknown as JsonObj;
    const coreBuy = Number((gates.config as { coreOrders?: { buy?: unknown } } | undefined)?.coreOrders?.buy);
    const coreSell = Number((gates.config as { coreOrders?: { sell?: unknown } } | undefined)?.coreOrders?.sell);
    const windowSize = Math.max(1, Number.isFinite(coreBuy) ? coreBuy : 1, Number.isFinite(coreSell) ? coreSell : 1);
    // STRAY RULE: a MASTER rail order only speaks for this batch if it sits on
    // its own side of the planned boundary — a BUY at/below it, a SELL at/above
    // the implied sellStart. Anything else is a rail-typed order parked in the
    // wrong zone (a refused-commit adoption at an old generation level, a
    // SPREAD-GUARD stray, a stranded hold) and letting it clamp the boundary
    // would SELF-LEGALIZE the corrupt state (live class: one live sell 18 slots
    // below clamped 138 -> 115 and re-typed the whole window).
    // Ops of THIS batch are always counted: a counter order is the rail fact.
    const baseForProximity = Number.isFinite(desired) ? Number(desired) : (Number.isFinite(committed) ? Number(committed) : null);
    // Kept for the report line: how many window slots this grid claims per side
    // (informational; the stray rule needs no window size).
    const proximityWindow = windowSize + gap + 1;

    // Start from the live master rails, then apply the kept ops as a delta.
    // This is the post-batch rail set: cancels remove, creates add, rotations
    // move (source -> destination), size updates stay.
    // Rail index per entry is the LIVE ladder position where known (a slot id
    // can be stale after a refused-commit adoption — same rule the fill, gap
    // and crossing paths already use), with the slot id as fallback.
    const rails = new Map<string, { side: string; idx: number | null; byOp: boolean }>();
    const vacatedSlotIds = new Set<string>();
    const master = (manager as { orders?: unknown })?.orders;
    let maxSlotIdx: number | null = null;
    if (master instanceof Map) {
        for (const raw of master.values()) {
            const o = raw as ManagedOrder | null | undefined;
            if (!o || !o.id) continue;
            const parsed = parseSlotIndex(o.id);
            if (parsed !== null && parsed !== undefined && Number.isFinite(Number(parsed))) {
                maxSlotIdx = maxSlotIdx === null ? Number(parsed) : Math.max(maxSlotIdx, Number(parsed));
            }
            if (!o.orderId || (o.state !== ORDER_STATES.ACTIVE && o.state !== ORDER_STATES.PARTIAL)) continue;
            if (!isSide(o.type)) continue;
            const live = orderUtils.resolveLiveOrderLadderPosition(o, manager?.assets, manager?._genesis);
            const idx = live.idx !== null && Number.isFinite(Number(live.idx)) ? Number(live.idx) : null;
            rails.set(String(o.id), { side: o.type, idx, byOp: false });
        }
    }

    if (opContexts && typeof (opContexts as Iterable<unknown>)[Symbol.iterator] === 'function') {
        for (const raw of opContexts) {
            const ctx = raw as JsonObj | null | undefined;
            if (!ctx) continue;
            if (ctx.kind === 'cancel') {
                const id = (ctx.order as JsonObj | undefined)?.id;
                if (id != null) {
                    rails.delete(String(id));
                    vacatedSlotIds.add(String(id));
                }
            } else if (ctx.kind === 'create') {
                const id = ctx.id;
                const side = (ctx.order as JsonObj | undefined)?.type;
                if (id != null) {
                    const parsedId = parseSlotIndex(String(id));
                    if (parsedId !== null && parsedId !== undefined && Number.isFinite(Number(parsedId))) {
                        maxSlotIdx = maxSlotIdx === null ? Number(parsedId) : Math.max(maxSlotIdx, Number(parsedId));
                    }
                    if (isSide(side)) {
                        rails.set(String(id), {
                            side,
                            idx: parsedId !== null && parsedId !== undefined && Number.isFinite(Number(parsedId)) ? Number(parsedId) : null,
                            byOp: true
                        });
                    }
                }
            } else if (ctx.kind === 'rotation') {
                const rotation = ctx.rotation as JsonObj | undefined;
                const oldId = (rotation?.oldOrder as JsonObj | undefined)?.id;
                const newId = rotation?.newGridId;
                const side = rotation?.type;
                if (oldId != null) {
                    rails.delete(String(oldId));
                    vacatedSlotIds.add(String(oldId));
                }
                if (newId != null) {
                    const parsedId = parseSlotIndex(String(newId));
                    if (parsedId !== null && parsedId !== undefined && Number.isFinite(Number(parsedId))) {
                        maxSlotIdx = maxSlotIdx === null ? Number(parsedId) : Math.max(maxSlotIdx, Number(parsedId));
                    }
                    if (isSide(side)) {
                        rails.set(String(newId), {
                            side,
                            idx: parsedId !== null && parsedId !== undefined && Number.isFinite(Number(parsedId)) ? Number(parsedId) : null,
                            byOp: true
                        });
                    }
                }
            } else if (ctx.kind === 'size-update') {
                const o = (ctx.updateInfo as JsonObj | undefined)?.partialOrder as JsonObj | undefined;
                if (o?.id != null && isSide(o.type)) {
                    const parsedId = parseSlotIndex(String(o.id));
                    rails.set(String(o.id), {
                        side: o.type,
                        idx: parsedId !== null && parsedId !== undefined && Number.isFinite(Number(parsedId)) ? Number(parsedId) : null,
                        byOp: true
                    });
                }
            }
        }
    }

    let maxBuyIdx: number | null = null;
    let minSellIdx: number | null = null;
    let ignoredStrays = 0;
    const sellStartForStray = baseForProximity !== null ? baseForProximity + gap + 1 : null;
    for (const [, rail] of rails) {
        const idx = rail.idx;
        if (idx === null || !Number.isFinite(idx)) continue;
        if (!rail.byOp && baseForProximity !== null) {
            const stray = rail.side === ORDER_TYPES.BUY
                ? idx > baseForProximity
                : (sellStartForStray !== null && idx < sellStartForStray);
            if (stray) {
                ignoredStrays++;
                continue;
            }
        }
        if (rail.side === ORDER_TYPES.BUY) maxBuyIdx = maxBuyIdx === null ? idx : Math.max(maxBuyIdx, idx);
        else minSellIdx = minSellIdx === null ? idx : Math.min(minSellIdx, idx);
    }
    if (maxBuyIdx === null && minSellIdx === null) {
        return { boundary: null, maxBuyIdx: null, minSellIdx: null, clamped: false, reason: 'no-rails' };
    }

    // A live BUY at b needs boundary >= b; a live SELL at s needs
    // boundary <= s - gap - 1. An empty interval means the rails already
    // overlap (pre-existing crossed book): do not legalize it here.
    const upper = minSellIdx === null ? Infinity : minSellIdx - gap - 1;
    if (maxBuyIdx !== null && maxBuyIdx > upper) {
        return {
            boundary: null,
            maxBuyIdx,
            minSellIdx,
            clamped: false,
            reason: `rail-crossed maxBuy=${maxBuyIdx} > minSell-gap-1=${upper}`
        };
    }

    let base = baseForProximity;
    if (base === null) {
        base = maxBuyIdx !== null ? maxBuyIdx : (Number.isFinite(upper) ? upper : 0);
    }

    // Grid ceiling: the SELL rail must fit (sellStart <= last slot). A
    // destination slot in this batch can extend the observed maximum.
    const gridCeiling = maxSlotIdx !== null && maxSlotIdx - gap - 1 >= 0
        ? maxSlotIdx - gap - 1
        : null;
    const allowedUpper = Number.isFinite(upper)
        ? (gridCeiling === null ? (upper as number) : Math.min(upper as number, gridCeiling))
        : gridCeiling;
    if (maxBuyIdx !== null && allowedUpper !== null && maxBuyIdx > allowedUpper) {
        return {
            boundary: null,
            maxBuyIdx,
            minSellIdx,
            clamped: false,
            reason: `rail-exceeds-grid maxBuy=${maxBuyIdx} > ceiling=${allowedUpper}`
        };
    }
    let next = base as number;
    if (allowedUpper !== null) next = Math.min(next, allowedUpper);
    if (maxBuyIdx !== null) next = Math.max(next, maxBuyIdx);
    next = Math.max(0, next);

    // FINAL GATE — the SAME validator the restore and commit paths use
    // (validatePersistedBoundary), so the rail clamp can never legalize a
    // boundary that strands a live order inside the implied band. Slots this
    // batch vacates (cancels / rotation sources) are allow-listed: they will
    // not be placed after the batch, so judging them as stranding would refuse
    // every legitimate evacuation clamp.
    //
    // Dense-ladder condition: validateBoundaryCommit derives its sell-rail
    // ceiling from the SORTED ARRAY LENGTH (`slots.length - 1`), which only
    // equals the grid ceiling when the master map holds every slot 0..N-1 (the
    // production invariant). A sparse/partial map would make the gate reject
    // every candidate as out-of-range, so it is skipped there — the clamp
    // inequalities above stay the authority in that state.
    {
        const slotsForGate: unknown[] = master instanceof Map ? Array.from(master.values()) : [];
        const dense = slotsForGate.length > 0
            && maxSlotIdx !== null
            && Number(maxSlotIdx) === slotsForGate.length - 1;
        if (dense) {
            const check = math.validatePersistedBoundary(
                next,
                slotsForGate,
                gap,
                vacatedSlotIds.size > 0 ? { allowInBandSlotIds: vacatedSlotIds } : undefined
            );
            if (!check || check.ok !== true) {
                return {
                    boundary: null,
                    maxBuyIdx,
                    minSellIdx,
                    clamped: false,
                    reason: `unsafe: ${check?.reason ?? 'unknown'}${check?.detail ? ` (${check.detail})` : ''}`
                };
            }
        }
    }

    return {
        boundary: next,
        maxBuyIdx,
        minSellIdx,
        clamped: next !== base,
        ...(next !== base
            ? { reason: `rail-clamped maxBuy=${maxBuyIdx ?? 'none'} minSell=${minSellIdx ?? 'none'}${ignoredStrays > 0 ? ` (${ignoredStrays} stray rail order(s) ignored)` : ''}` }
            : (ignoredStrays > 0 ? { reason: `rail-steady (${ignoredStrays} stray rail order(s) ignored; window=${proximityWindow})` } : {}))
    };
}
/**
 * Track consecutive boundary-hold batches on the manager (ops visibility).
 *
 * A single hold is normal maker discipline: the guard vetoed stale-priced
 * refills, so the committed boundary stays instead of advancing past
 * stranded rail holes. A growing run means the grid is trailing the market
 * (plans keep pricing refills against a racing guard pivot, typically while
 * fill batches run on backlogged state) and only fresh fills unstick it —
 * worth escalating so it cannot hide inside per-batch warns.
 *
 * Also records a hold signature (`_lastHeldPlanSignature`) for the
 * identical-held-plan suppression in `performSafeRebalance`, and the caller
 * escalates a long run to a guard-aware structural re-center. A fill-less
 * re-plan from unchanged master re-derives the identical plan and re-hits
 * the identical guard blocks, so it is suppressed rather than re-broadcast;
 * the heal path is a fresh fill-driven plan or the re-center.
 * @param {unknown} manager - Order manager (mutable tracking fields)
 * @param {boolean} held - Whether this batch held the boundary
 * @param {unknown} keptBoundary - Committed boundary that was kept
 * @param {unknown} plannedBoundary - Boundary the plan wanted
 * @param {string[]} heldSlotIds - Refill slots skipped this batch
 * @returns {number} Consecutive-hold count after this batch (0 when clear)
 */
function trackBoundaryHold(manager: OrderManagerLike, held: boolean, keptBoundary: unknown, plannedBoundary: unknown, heldSlotIds: string[]): number {
    if (!manager) return 0;
    const prev = Number(manager._consecutiveBoundaryHolds) || 0;
    const consecutive = held ? prev + 1 : 0;
    manager._consecutiveBoundaryHolds = consecutive;
    if (held) {
        manager._lastBoundaryHoldInfo = {
            at: Date.now(),
            kept: keptBoundary,
            planned: plannedBoundary,
            slots: Array.isArray(heldSlotIds) ? [...heldSlotIds] : [],
        };
        // Signature for the identical-held-plan suppression in
        // performSafeRebalance: a fill-less replan with the same boundary,
        // pivot and fill timestamp can only reproduce this hold.
        manager._lastHeldPlanSignature = {
            boundaryIdx: keptBoundary as number | null | undefined,
            pivot: manager._lastFilledPrice ?? null,
            fillsAt: manager._lastFilledAt ?? 0,
            wire: Array.isArray(heldSlotIds) ? [...heldSlotIds] : [],
        };
    } else {
        manager._lastHeldPlanSignature = null;
    }
    return consecutive;
}
/**
 * Restore skipped update slots in the working grid to master state.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {unknown} workingGrid
 * @param {Set<string>} skippedSlotIds
 * @param {number} [skippedCount=0]
 */
function restoreSkippedUpdateSlotsInWorkingGrid(bot: BotLike, workingGrid: InstanceType<typeof WorkingGrid>, skippedSlotIds: Set<string> | null | undefined, skippedCount: number = 0) {
    if (!workingGrid || !skippedSlotIds || skippedSlotIds.size === 0) {
        return;
    }

    const masterVersion = Number.isFinite(Number(bot.manager?._gridVersion))
        ? Number(bot.manager._gridVersion)
        : undefined;

    for (const slotId of skippedSlotIds) {
        workingGrid.syncFromMaster(bot.manager.orders, slotId, masterVersion);
    }

    bot.manager.logger.log(
        `[COW] Restored ${skippedSlotIds.size} slot(s) after ${skippedCount} skipped update action(s).`,
        'debug'
    );
}

/**
 * Bounded re-plan for a stale pre-broadcast plan (regression-safe policy).
 *
 * Policy (bounded re-plan + proceed):
 *   * First staleness hit → re-plan ONCE from fresh master using the same
 *     fills; the recursion re-runs this guard against the fresh plan. A
 *     re-plan with no executable actions means the grid is already consistent
 *     post-fills — the stale plan must NOT ship.
 *   * Still stale (master kept mutating), or no fill context to re-plan with
 *     → PROCEED with the plan anyway and request a structural resync. Never
 *     hard-abort on staleness: an abort would silently drop the fill set that
 *     triggered this rebalance (_processFillsWithBatching only hard-aborts on
 *     illegal-state or accounting failures), and the post-broadcast commit
 *     guard + chain adoption below close any residual divergence.
 *
 * Stack discipline: the original plan's grid is popped before the fresh
 * re-plan pushes (LIFO order); when the re-plan fails/aborts, the original
 * grid is pushed back (marker restored) so the later commit/catch pop sites
 * release exactly the entry they were pushed with, instead of underflowing
 * or stealing a nested grid's entry.
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} cowResult - The stale plan result
 * @param {number} replanDepth - Recursion depth (0 = first attempt)
 * @param {Object} preBroadcastGuard - The failed evaluateCommit result
 * @returns {Promise<{handled: boolean, result?: Object}>} handled=true when the
 *   batch was resolved by the re-plan (fresh plan executed, or stale plan
 *   skipped as already-consistent); handled=false when the caller must proceed
 *   with the original plan.
 */
async function replanStaleBatch(bot: BotLike, cowResult: CowResult, replanDepth: number, preBroadcastGuard: JsonObj, seamPollIntervalMs?: number): Promise<{ handled: boolean; result?: JsonObj }> {
    const canReplan = replanDepth < STALE_PLAN_REPLAN_LIMIT
        && Array.isArray(cowResult.fills) && cowResult.fills.length > 0;
    if (!canReplan) {
        bot.manager.logger.log(
            `[COW] Plan stale pre-broadcast (${preBroadcastGuard.reason}); ` +
            (replanDepth >= STALE_PLAN_REPLAN_LIMIT
                ? 'still stale after re-plan — proceeding with plan (commit guard + chain adoption close divergence)'
                : 'no fill context for re-plan — proceeding with plan (commit guard + chain adoption close divergence)'),
            'warn'
        );
        await requestStructuralResync(
            bot,
            'plan stale pre-broadcast (proceeding with plan)',
            { reason: preBroadcastGuard.reason }
        );
        return { handled: false };
    }

    bot.manager.logger.log(
        `[COW] Plan stale pre-broadcast (${preBroadcastGuard.reason}); re-planning once from fresh master`,
        'warn'
    );

    // Abandon the original plan's working grid: it can no longer commit. Pop
    // it so the rebalance stack stays balanced — the fresh plan's grid (pushed
    // by performSafeRebalance below) is popped by the recursion's own
    // commit/cleanup path. Guarded on the push marker (plan-path calls never
    // pushed a grid); the marker is cleared so a later throw in this frame
    // (e.g. the recursion) cannot pop the entry a second time.
    const hadPushedGrid = cowResult?._workingGridPushed === true;
    popPushedWorkingGrid(bot, cowResult);

    let replanned: CowResult | null = null;
    try {
        // Restore the boundary-shift budget consumed by the abandoned plan:
        // it was built from the same fills and never shipped, so the re-plan
        // must derive from the FULL batch budget — not the leftover. Without
        // the restore, each stale-plan re-plan spends the budget twice and
        // drifts conservative (boundary under-shift).
        if (bot.manager?._boundaryShiftBudgetBase != null) {
            bot.manager._boundaryShiftBudget = bot.manager._boundaryShiftBudgetBase;
        }
        if (typeof bot.manager.performSafeRebalance === 'function') {
            // skipBroadcastWait: this frame is itself inside the executor's
            // startBroadcasting() region — waiting on the flag we hold would
            // stall the re-plan for the full _awaitBroadcastIdle timeout.
            replanned = await bot.manager.performSafeRebalance(
                cowResult.fills,
                (cowResult.excludeIds as Set<string> | null | undefined) || new Set(),
                { skipBroadcastWait: true }
            ) as unknown as CowResult;
        }
    } catch (replanErr) {
        bot.manager.logger.log(
            `[COW] Re-plan failed: ${getErrorMessage(replanErr)}; proceeding with original plan`,
            'warn'
        );
    }

    if (replanned && !replanned.aborted) {
        if (hasExecutableActions(replanned)) {
            // The original plan's ops are abandoned with its working grid;
            // drop THEIR pending-broadcast entries only, or the recursion's
            // own pending-broadcast guard would reject the fresh plan's
            // CREATEs. Entries from an earlier unresolved batch are
            // deliberately KEPT: the entry guard only covers CREATE batches,
            // so a create-less batch can reach this path while earlier
            // entries are still live — clearing them here would let the fresh
            // plan re-create slots whose earlier broadcast may have landed
            // (duplicate orders). The recursion's guard will then abort +
            // reconcile instead.
            clearPendingBroadcastsForSlots(bot, cowResult.actions);
            return {
                handled: true,
                result: await updateOrdersOnChainBatchCOW(bot, replanned, {
                    replanDepth: replanDepth + 1,
                    // Carry the seam through the recursion explicitly: the inner
                    // frame re-sets and re-restores it, so it must not depend on
                    // the outer frame's side-channel value surviving.
                    ...(seamPollIntervalMs != null ? { pollIntervalMs: seamPollIntervalMs } : {})
                }),
            };
        }
        // Re-plan confirms the grid is already consistent post-fills; the
        // stale original plan must NOT ship. Pop the fresh plan's grid too
        // (it was never committed).
        popPushedWorkingGrid(bot, replanned);
        clearPendingBroadcastsForSlots(bot, cowResult.actions);
        bot.manager.logger.log(
            '[COW] Re-plan produced no executable actions; grid is already consistent post-fills, skipping stale plan',
            'info'
        );
        return { handled: true, result: { executed: false, hadRotation: false, skippedStalePlan: true } };
    }

    // Re-plan failed or aborted — the original plan proceeds after all. Its
    // grid was popped above to keep the stack LIFO-balanced for the fresh
    // plan; push it back (marker restored) so the broadcast commit / catch
    // pop sites release exactly the entry they were pushed with, instead of
    // underflowing or stealing a nested grid's entry.
    if (hadPushedGrid && cowResult.workingGrid) {
        if (typeof bot.manager._pushWorkingGridRef === 'function') {
            bot.manager._pushWorkingGridRef(cowResult.workingGrid, cowResult);
        } else {
            (bot.manager as unknown as { _currentWorkingGridStack?: unknown[] })._currentWorkingGridStack?.push?.(cowResult.workingGrid);
            bot.manager._resetRebalanceStateToDepth?.();
            cowResult._workingGridPushed = true;
        }
    }
    bot.manager.logger.log(
        '[COW] Re-plan unavailable; proceeding with original plan (commit guard + chain adoption close divergence)',
        'warn'
    );
    await requestStructuralResync(
        bot,
        're-plan unavailable (proceeding with original plan)',
        { reason: preBroadcastGuard.reason }
    );
    return { handled: false };
}

/**
 * Wait for any in-flight COW broadcast to settle before this batch proceeds.
 * The in-flight batch sets _cowBroadcastInFlight right before broadcasting and
 * clears it in its outer finally, so this wait is bounded by the broadcast +
 * recovery duration. Returns after the flag clears, the cap is exceeded, or
 * shutdown begins. Callers MUST set bot._cowBroadcastInFlight = true
 * synchronously (before the next await) once this resolves so the
 * check-and-set stays atomic and two planning batches cannot both win the
 * broadcast slot.
 *
 * Returns true when the caller must abort the batch (shutdown began before or
 * during the wait — proceeding would broadcast with post-shutdown state),
 * false when the caller may proceed to claim the broadcast slot.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} label - Stage label for the deferral log (e.g. 'entry', 'pre-broadcast')
 * @returns {Promise<boolean>}
 */
async function waitForCowBroadcastSingleFlight(bot: BotLike, label: string): Promise<boolean> {
    if (bot._shuttingDown) return true;
    if (!bot._cowBroadcastInFlight) return false;
    bot.manager.logger.log(
        `[COW] ${label}: a COW broadcast is already in flight; deferring this batch until it settles (prevents overlapping-broadcast commit collision).`,
        'warn'
    );
    const waitDeadline = Date.now() + SINGLE_FLIGHT_MAX_WAIT_MS;
    // Test seam: a caller may shorten the poll cadence via
    // bot._cowSingleFlightPollMs. Production leaves it unset and keeps the
    // 250 ms rung, but tests that release the in-flight batch immediately must
    // not pay a full poll interval after the slot clears.
    const configuredPollMs = Number((bot as { _cowSingleFlightPollMs?: number })._cowSingleFlightPollMs);
    const pollMs = Number.isFinite(configuredPollMs) && configuredPollMs > 0 ? configuredPollMs : 250;
    while (bot._cowBroadcastInFlight) {
        if (bot._shuttingDown || Date.now() > waitDeadline) break;
        await sleep(pollMs);
    }
    if (bot._shuttingDown) {
        bot.manager.logger.log(
            `[COW] ${label}: shutdown began while waiting for the in-flight broadcast; aborting this batch.`,
            'warn'
        );
        return true;
    }
    if (bot._cowBroadcastInFlight) {
        bot.manager.logger.log(
            `[COW] ${label}: waited for in-flight broadcast but it did not settle within the cap; proceeding (commit guard + chain adoption will close divergence).`,
            'warn'
        );
    }
    return false;
}

/**
 * COW broadcast: Execute blockchain operations and commit working grid on success.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} cowResult
 * @param {Object} [options={}] - Internal execution options (replanDepth)
 * @returns {Promise<Object>}
 */
/**
 * Derive an update action's planned target size (shared by the rotation and
 * plain size-update op builders).
 * @param {Object} action - COW action
 * @returns {number}
 */
function plannedUpdateSize(action: CowAction): number {
    return Number.isFinite(Number(action.newSize))
        ? Number(action.newSize)
        : Number(action.order?.size || 0);
}

/**
 * Post-fill size invariant for COW UPDATE ops: a partially-filled order
 * (slot state PARTIAL — the fill is already booked into slot.size) must
 * never be GROWN in place by a plan update. Growing it would restore the
 * pre-fill size on chain while the fill accounting stays on the booked
 * remaining size — chain and books diverge and the fill effectively
 * vanishes from the bot's ledger. Clamp the target to the booked remaining
 * size and keep the plan's price intent; a deliberate full-size top-up must
 * go through a cancel+create cycle, not a silent in-place grow.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} masterOrder - Live master-grid slot for the action
 * @param {number} newSize - Plan's target size for the update op
 * @param {Object} action - The COW action being built
 * @returns {number} The (possibly clamped) target size
 */
function clampPostFillUpdateSize(bot: BotLike, masterOrder: ManagedOrder, newSize: number, action: CowAction): number {
    const target = Number(newSize);
    if (!masterOrder || masterOrder.state !== ORDER_STATES.PARTIAL) return target;
    const booked = Number(masterOrder.size);
    if (!Number.isFinite(target) || !Number.isFinite(booked) || booked <= 0) return target;
    if (target > booked) {
        bot.manager.logger.log(
            `[COW] Post-fill size clamp for ${action?.id || masterOrder?.id}: slot is PARTIAL with ` +
            `booked remaining ${Format.formatAmount(booked)} but the plan targets ` +
            `${Format.formatAmount(target)} — clamping to booked remaining. ` +
            `A partially-filled order must not be grown in place by a COW update (fill accounting divergence).`,
            'warn'
        );
        return booked;
    }
    return target;
}

/**
 * Pre-broadcast guard chain for a COW batch: create-slot validation (with
 * tolerance-violation filtering), recovery-exhausted block, pending-broadcast
 * and unmatched-chain-order guards (with adoption sync), and the crossed-book
 * gate. Every refusal pops the pushed working grid before returning.
 *
 * Mutates cowResult.actions in place (tolerance-violating CREATEs are
 * filtered); the caller holds the same array reference.
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} cowResult - Rebalance/COW result carrying actions
 * @returns {Promise<Object>} { proceed:false, result } on refusal, or
 *   { proceed:true, crossingCandidates, intraBatchCandidates } on pass
 */
async function runPreBroadcastGuards(bot: BotLike, cowResult: CowResult): Promise<PreBroadcastGuardResult> {
    const { actions } = cowResult;
    const chainOrderCandidates = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    const createSlotValidation = validateCreateTargetSlots(actions, bot.manager?.orders, bot.manager?.assets, chainOrderCandidates, bot.manager?.config?.incrementPercent ?? null);
    if (!createSlotValidation.isValid) {
        for (const violation of createSlotValidation.violations) {
            let reason: string;
            switch (violation.reason) {
                case 'price_collision':
                    reason = `existing placed order ${violation.currentOrderId} at same price`;
                    break;
                case 'same_batch_price_collision':
                    reason = `another CREATE in the same batch at same price`;
                    break;
                case 'chain_orphan_collision':
                    reason = `unmatched on-chain order ${violation.currentOrderId} at same price`;
                    break;
                case 'same_batch_price_duplicate':
                    reason = `another CREATE in the same batch at same broadcast price (duplicate of ${violation.duplicateOf})`;
                    break;
                case 'create_price_invalid':
                    reason = `broadcast price is not a finite number`;
                    break;
                default:
                    reason = `existing orderId=${violation.currentOrderId}`;
            }
            bot.manager.logger.log(
                `[COW] Rejecting CREATE for slot ${violation.targetId}: ${reason} ` +
                `(type=${violation.currentType}, state=${violation.currentState})`,
                'error'
            );
        }

        // Differentiate violation types:
        //   * slot_occupied — hard constraint, not a false positive (the
        //     target slot literally has a placed order).  Abort the batch.
        //   * price_collision / chain_orphan_collision / same_batch_price_collision
        //     — tolerance-based; can false-positive on low-precision assets
        //     where calculatePriceTolerance exceeds the grid increment.
        //     Skip only the violating CREATEs so the rest of the batch
        //     (valid CREATEs, CANCELs, UPDATEs) still proceeds.
        const hasHardOccupiedViolation = createSlotValidation.violations.some(
            (v) => v.reason === 'slot_occupied'
        );

        if (hasHardOccupiedViolation) {
            popPushedWorkingGrid(bot, cowResult);
            return {
                proceed: false,
                result: {
                    executed: false,
                    aborted: true,
                    reason: 'CREATE_SLOT_OCCUPIED',
                    violations: createSlotValidation.violations,
                    hadRotation: false
                }
            };
        }

        const violatingIds = createSlotValidation.violatingTargetIds;
        const filteredActions = actions.filter((action) => {
            if (action.type !== COW_ACTIONS.CREATE) return true;
            const targetId = action.id || action.order?.id;
            return !violatingIds.has(String(targetId));
        });

        actions.length = 0;
        actions.push(...filteredActions);

        // All violations at this point are tolerance-based; slot_occupied
        // would have aborted above.
        bot.manager.logger.log(
            `[COW] Filtered ${createSlotValidation.violations.length} tolerance-violating CREATE(s); ` +
            `${actions.length} action(s) remaining in batch`,
            'warn'
        );

        if (!actions.some((action) => action.type === COW_ACTIONS.CREATE)) {
            if (actions.length === 0) {
                // Same exactly-once marker discipline as the other early
                // returns: a pushed working grid must be popped here or the
                // caller would leak the stack entry.
                popPushedWorkingGrid(bot, cowResult);
                return { proceed: false, result: { executed: false, hadRotation: false } };
            }
        }
    }

    const hasCreateActions = actions.some((action) => action.type === COW_ACTIONS.CREATE);

    if (hasCreateActions && bot.manager?._recoveryExhaustedAt) {
        const exhaustedAge = Date.now() - bot.manager._recoveryExhaustedAt;
        bot.manager.logger.log?.(
            `[RECOVERY-EXHAUSTED] Blocking ${actions.filter((a) => a.type === COW_ACTIONS.CREATE).length} CREATE(s) ` +
            `(exhausted ${(exhaustedAge / 1000).toFixed(0)}s ago). ` +
            `Waiting for next fill or sync cycle to reset recovery state.`,
            'warn'
        );
        popPushedWorkingGrid(bot, cowResult);
        return {
            proceed: false,
            result: {
                executed: false,
                aborted: true,
                reason: 'RECOVERY_EXHAUSTED',
                hadRotation: false
            }
        };
    }

    const unmatchedChainOrders = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    // Out-of-grid holds are permanent by design (live orders held outside
    // the frozen rail): they can never be adopted and collide with nothing,
    // so they must not block CREATES — otherwise one dip-protection hold
    // freezes the whole grid. Only adoptable/cancellable orphans block.
    const blockingUnmatched = unmatchedChainOrders.filter((u) => !orderUtils.isNonBlockingUnmatchedOrder(u));
    const pendingBroadcasts: PendingEntry[] = getPendingBroadcasts(bot);
    if (hasCreateActions && (blockingUnmatched.length > 0 || pendingBroadcasts.length > 0)) {
        if (pendingBroadcasts.length > 0) {
            bot.manager.logger.log(
                `[COW] Rejecting CREATE batch: ${pendingBroadcasts.length} pending broadcast(s) from a prior uncertain ` +
                `broadcast. Running recovery before placing replacement orders.`,
                'error'
            );
            await requestStructuralResync(
                bot,
                'pending broadcasts before COW create',
                { pendingBroadcasts: pendingBroadcasts.map((p) => p.slotId) }
            );
            try {
                await reconcileAfterUncertainBroadcast(
                    bot,
                    new BroadcastUncertainError(
                        'rejected CREATE batch had pending broadcasts',
                        {
                            operations: pendingBroadcasts.map((p) => p.order),
                            accountName: bot.account,
                            batchId: bot._currentBatchId != null ? String(bot._currentBatchId) : null,
                            payload: null,
                            timeoutMs: null
                        }
                    ),
                    []
                );
            } catch (recoverErr) {
                bot.manager.logger.log(
                    `[COW] Recovery from pending broadcasts failed: ${getErrorMessage(recoverErr)}`,
                    'error'
                );
            }
            popPushedWorkingGrid(bot, cowResult);
            return {
                proceed: false,
                result: {
                    executed: false,
                    aborted: true,
                    reason: 'PENDING_BROADCASTS',
                    hadRotation: false
                }
            };
        }

        const unmatchedSample = blockingUnmatched
            .slice(0, 3)
            .map((o) => formatUnmatchedChainOrderForLog(o))
            .join(' | ');
        bot.manager.logger.log(
            `[COW] ${blockingUnmatched.length} unmatched chain order(s) blocking CREATES ` +
            (unmatchedSample ? `(${unmatchedSample})` : '') +
            ` — adopting via sync instead of cancelling`,
            'info'
        );
        try {
            const accountRef = bot.account;
            const freshRead = await chainOrders.readOpenOrdersWithMeta(accountRef);
            // Truncated-read guard: a partial get_full_accounts window omits the
            // freshest orders; syncing on it would virtualize live slots and
            // re-create duplicates. Defer the adoption to a clean read — the
            // unmatched orders keep blocking CREATEs until then.
            if (!isAuthoritativeChainRead(freshRead)) {
                bot.manager.logger.log(
                    '[COW] Post-guard chain snapshot not authoritative; skipping adoption sync (partial snapshot would virtualize live slots) — unmatched chain orders keep blocking CREATEs',
                    'warn'
                );
            } else if (freshRead.orders && freshRead.orders.length > 0) {
                const freshSnapshot = freshRead.orders;
                const syncResult = await bot.manager.syncFromOpenOrders(freshSnapshot, {
                    // Accounting enabled: the adopted chain orders were never
                    // registered in master (they are unmatched/orphan), so the
                    // adoption must lock their capital. skipAccounting:true would
                    // leave the optimistic balances drifted until the next fetch
                    // — inconsistent with the open-orders loop convention
                    // ('readOpenOrders' → skipAccounting:false).
                    skipAccounting: false,
                });
                if (syncResult && Array.isArray(syncResult.unmatchedChainOrders)) {
                    const processed = (syncResult.filledOrders?.length || 0) +
                                      (syncResult.updatedOrders?.length || 0) +
                                      (syncResult.ordersNeedingCorrection?.length || 0);
                    if (processed > 0) {
                        bot.manager._lastUnmatchedChainOrders = syncResult.unmatchedChainOrders;
                        bot.manager.logger.log(
                            `[COW] Adopted chain order(s) via sync: ${processed} processed, ` +
                            `${syncResult.unmatchedChainOrders.length} still unmatched`,
                            'info'
                        );
                    } else {
                        const syncUnmatchedCount = syncResult.unmatchedChainOrders.length;
                        bot.manager.logger.log(
                            `[COW] Sync returned without processing (processed=0, ` +
                            `unmatched=${syncUnmatchedCount} in result, ` +
                            `_lastUnmatchedChainOrders=${unmatchedChainOrders.length}). ` +
                            `Structural resync will handle adoption.`,
                            syncUnmatchedCount > 0 ? 'warn' : 'debug'
                        );
                        if (syncUnmatchedCount > 0 && syncUnmatchedCount !== unmatchedChainOrders.length) {
                            bot.manager._lastUnmatchedChainOrders = syncResult.unmatchedChainOrders.map((o) => ({ ...o }));
                            bot.manager.logger.log(
                                `[COW] Updated _lastUnmatchedChainOrders from sync result: ` +
                                `${unmatchedChainOrders.length} → ${syncUnmatchedCount}`,
                                'debug'
                            );
                        }
                    }
                }
            }
        } catch (syncErr) {
            bot.manager.logger.log(
                `[COW] Failed to sync/unmatched orders: ${getErrorMessage(syncErr)}`,
                'warn'
            );
        }
        await requestStructuralResync(
            bot,
            'unmatched chain orders before COW create',
            { unmatchedChainOrders: unmatchedChainOrders }
        );
        bot.manager.logger.log(
            `[COW] Rejecting CREATE batch after sync: working grid invalidated by master mutation`,
            'info'
        );
        popPushedWorkingGrid(bot, cowResult);
        return {
            proceed: false,
            result: {
                executed: false,
                aborted: true,
                reason: 'UNMATCHED_CHAIN_ORDERS',
                hadRotation: false
            }
        };
    }

    // MODE C(b) — pre-broadcast UPDATE-target existence check off the
    // slot->orderId map. A tracked order that is already gone on chain makes a
    // limit_order_update abort the broadcast chunk ("Order does not exist …
    // cannot update") and leaves a partially-applied grid. Re-reading the
    // referenced ids right before broadcast turns that into a clean
    // pre-broadcast refusal + structural resync, so nothing is half-applied.
    const updateTargetIds = new Set<string>();
    for (const action of actions) {
        if (action?.type === COW_ACTIONS.UPDATE && action.orderId) updateTargetIds.add(String(action.orderId));
    }
    if (updateTargetIds.size > 0 && typeof chainOrders.batchReadOrders === 'function') {
        try {
            const readResult = await chainOrders.batchReadOrders([...updateTargetIds], 3000) as unknown;
            const readMap = readResult as { get?: (id: string) => unknown } | null | undefined;
            // Fail OPEN on a non-Map result (tests/other accessors): only an
            // authoritative map can prove an order gone.
            if (readMap && typeof readMap.get === 'function') {
                const missing: string[] = [];
                for (const id of updateTargetIds) {
                    if (!readMap.get(id)) missing.push(id);
                }
                if (missing.length > 0 && typeof chainOrders.readSingleOrder === 'function') {
                    // Second, independent read before an absence decision: a
                    // node that has not yet seen a freshly created order can
                    // return null from the batch read. Re-reading each candidate
                    // individually cancels the absence when the order is found;
                    // a failed re-read must not manufacture an absence (fail
                    // open), so only a read that returns an explicit null is
                    // treated as confirming the gap.
                    const stillMissing: string[] = [];
                    for (const id of missing) {
                        let present = true;
                        try {
                            present = Boolean(await chainOrders.readSingleOrder(id, 3000));
                        } catch { /* failed re-verify must not manufacture an absence */ }
                        if (!present) stillMissing.push(id);
                    }
                    missing.length = 0;
                    missing.push(...stillMissing);
                }
                if (missing.length > 0) {
                    bot.manager.logger.log(
                        `[COW] Rejecting UPDATE batch pre-broadcast: ${missing.length} target(s) missing on chain ` +
                        `(${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}); ` +
                        `grid/chain existence divergence — structural resync required`,
                        'error'
                    );
                    popPushedWorkingGrid(bot, cowResult);
                    await requestStructuralResync(
                        bot,
                        'pre-broadcast update target missing on chain',
                        { missingUpdateOrderIds: missing }
                    );
                    return {
                        proceed: false,
                        result: {
                            executed: false,
                            aborted: true,
                            reason: 'UPDATE_TARGET_MISSING',
                            missingUpdateOrderIds: missing,
                            hadRotation: false
                        }
                    };
                }
            }
        } catch (existenceErr) {
            // A failed/foreign read must never block a legitimate broadcast;
            // the chain's own rejection remains the backstop.
            bot.manager.logger.log(
                `[COW] Pre-broadcast UPDATE existence check failed (${getErrorMessage(existenceErr)}); ` +
                `proceeding (chain rejection remains the backstop)`,
                'debug'
            );
        }
    }

    // MODE C(a) — gap-band placement SHADOW check (observability + summary,
    // no placement change). A non-spread-correction CREATE/UPDATE whose
    // destination sits inside the plan's gap band is the Mode-C geometry that
    // the reverted P1/P2 cancellation nets used to mop up; enforcement is
    // deliberately NOT done here because spread correction legitimately places
    // INTO the band (the LAST-FILL-GUARD bypass exists for exactly that) and a
    // hard reject would re-open the P1-e2898e51 regression class. Count + warn
    // so the leak is measurable before any policy change.
    try {
        const planBoundaryValue = (cowResult as JsonObj)?.workingBoundary;
        const planBoundaryRaw = (planBoundaryValue === null || planBoundaryValue === undefined || planBoundaryValue === '')
            ? NaN
            : Number(planBoundaryValue);
        // Fall back to the committed boundary only when it is itself known:
        // Number(null) === 0 and Number('') === 0 must not silently become
        // slot 0 (same trap the helper guards).
        const managerBoundaryRaw: unknown = bot.manager?.boundaryIdx;
        const shadowBoundary = Number.isFinite(planBoundaryRaw)
            ? planBoundaryRaw
            : (managerBoundaryRaw != null && managerBoundaryRaw !== '' ? Number(managerBoundaryRaw) : NaN);
        // Absent-aware gap: Number(null) === 0 would defeat the helper's own
        // null guard by passing a collapsed 0 band before the helper sees it.
        const shadowGapSlots = Format.toKnownNumber(bot.manager?._gapSlots);
        const shadowSlots = collectGapBandPlacementShadowSlots(actions, shadowBoundary, shadowGapSlots);
        if (shadowSlots.length > 0) {
            if (bot._metrics) {
                bot._metrics.gapBandPlacementShadowCount =
                    (bot._metrics.gapBandPlacementShadowCount || 0) + shadowSlots.length;
            }
            bot.manager.logger.log(
                `[COW-GAP-BAND] shadow: ${shadowSlots.length} non-spread-correction placement(s) ` +
                `inside the plan's gap band (boundary ${shadowBoundary}, gap ${shadowGapSlots}): ` +
                `${shadowSlots.slice(0, 8).join(', ')}${shadowSlots.length > 8 ? ', …' : ''} ` +
                `— counted for observability, NOT blocked`,
                'warn'
            );
        }
    } catch { /* shadow check must never break a batch */ }

    // Crossing-check candidate set (master + pending-broadcast + unmatched
    // chain orders). Built after the batch-level pending/unmatched guards so
    // it reflects any sync they triggered.
    const crossingCandidates = buildCrossingCandidates(bot);
    const intraBatchCandidates: JsonObj[] = [];

    // CROSSED-BOOK GATE: refuse to broadcast any batch whose simulated result
    // prices a BUY at-or-above a SELL (see detectCrossedBookPlan).
    const crossedBookDetail = detectCrossedBookPlan(bot.manager, actions);
    if (crossedBookDetail) {
        bot.manager.logger.log(
            `[COW] Rejecting batch pre-broadcast: crossed book detected (${crossedBookDetail})`,
            'error'
        );
        popPushedWorkingGrid(bot, cowResult);
        return {
            proceed: false,
            result: {
                executed: false,
                aborted: true,
                reason: 'CROSSED_BOOK',
                detail: crossedBookDetail,
                hadRotation: false
            }
        };
    }

    return { proceed: true, crossingCandidates, intraBatchCandidates };
}

function restoreTestPollIntervalSeam(bot: BotLike, prev: unknown) {
    try {
        if (prev === undefined) delete bot._testPollIntervalMs;
        else bot._testPollIntervalMs = prev as number | undefined;
    } catch { /* seam restore must never break the batch */ }
}

async function updateOrdersOnChainBatchCOW(bot: BotLike, cowResult: CowResult, options: JsonObj = {}): Promise<JsonObj> {
    const replanDepth = Number.isFinite(Number(options?.replanDepth)) ? Number(options.replanDepth) : 0;
    // Test seam: options.pollIntervalMs overrides the production 1.5s pacing
    // in pollChainForConfirmation (missing-create path below) so tests do
    // not sleep on wall-clock time. Held on the bot only for the duration of
    // this call (see the wrapper's finally) so the inner missing-create
    // branch and any re-plan recursion pick it up without changing the
    // production call signature used by the runtime.
    const seamPollIntervalMs = resolveSeamMsOrNull(options?.pollIntervalMs);
    const prevSeamPollIntervalMs = bot?._testPollIntervalMs;
    if (seamPollIntervalMs != null) {
        bot._testPollIntervalMs = seamPollIntervalMs;
    }
    // Expose the resolved interval using the same precedence the missing-create
    // poll path applies (explicit option > bot seam > production 1500ms).
    // Recorded in the wrapper rather than in pollChainForConfirmation so it is
    // observable on every batch exit, including the pre-broadcast guard
    // refusals that never reach the poll (a `||`-vs-`??` regression here is
    // otherwise invisible: the only effect is a slower poll).
    bot._lastResolvedPollIntervalMs = resolveSeamMs(
        seamPollIntervalMs,
        resolveSeamMs(bot?._testPollIntervalMs, 1500)
    );
    // The seam override must not survive this call: every exit path (dry run,
    // entry/pre-broadcast single-flight aborts, guard refusals, re-plan
    // recursion, throws) funnels through the body() finally below, so no exit
    // can leak bot._testPollIntervalMs onto the bot.
    try {
        return await updateOrdersOnChainBatchCOWBody(
            bot, cowResult, replanDepth,
            seamPollIntervalMs ?? undefined
        );
    } finally {
        // Restore only when this frame actually wrote a seam. The entry
        // single-flight await (inside body()) lets a second, seam-less batch
        // run concurrently: an unguarded restore would delete the seam owned
        // by an in-flight sibling call (captured prev === undefined), and that
        // sibling's pollChainForConfirmation — which reads the bot field only,
        // since it takes no pollIntervalMs option at its call sites — would
        // silently fall back to the production 1500ms pacing. Guarding keeps
        // the write-ownership scoped to this call; the saved prev still makes
        // the nested re-plan recursion LIFO-correct.
        if (seamPollIntervalMs != null) {
            restoreTestPollIntervalSeam(bot, prevSeamPollIntervalMs);
        }
    }
}

async function updateOrdersOnChainBatchCOWBody(
    bot: BotLike,
    cowResult: CowResult,
    replanDepth: number,
    seamPollIntervalMs: number | undefined
): Promise<JsonObj> {
    bot._currentCycleId = (Number.isFinite(Number(bot._currentCycleId)) ? Number(bot._currentCycleId) : 0) + 1;
    const { workingGrid, workingIndexes, workingBoundary, actions } = cowResult;
    // Boundary-hold value: computed pre-broadcast after the skip-restore and
    // frozen for every downstream commit path (success + uncertain-catch).
    // workingBoundary itself stays untouched (audit trail).
    let effectiveBoundary: number = workingBoundary;
    // True when the refill hold pinned the committed boundary over the plan's
    // target. Hoisted out of the broadcast try block: the uncertain-broadcast
    // catch commits too, and a held boundary must keep the owed fill crawls
    // there as well (see _commitWorkingGrid pending-crawl bookkeeping).
    let boundaryHeld = false;
    // Consecutive-hold re-center tuning (see the escalation block below).
    const boundaryHoldTiming: JsonObj = constantsModule?.TIMING || {};
    const holdResyncThreshold = Number(boundaryHoldTiming.BOUNDARY_HOLD_RESYNC_THRESHOLD) > 0
        ? Number(boundaryHoldTiming.BOUNDARY_HOLD_RESYNC_THRESHOLD)
        : 4;
    const holdResyncCooldownMs = Number(boundaryHoldTiming.BOUNDARY_HOLD_RESYNC_COOLDOWN_MS) > 0
        ? Number(boundaryHoldTiming.BOUNDARY_HOLD_RESYNC_COOLDOWN_MS)
        : 5 * 60 * 1000;

    if (bot.config.dryRun) {
        const cancelCount = actions.filter((a: { type?: unknown }) => a.type === COW_ACTIONS.CANCEL).length;
        const createCount = actions.filter((a: { type?: unknown }) => a.type === COW_ACTIONS.CREATE).length;
        const updateCount = actions.filter((a: { type?: unknown }) => a.type === COW_ACTIONS.UPDATE).length;
        if (cancelCount > 0) bot.manager.logger.log(`Dry run: would cancel ${cancelCount} orders`, 'info');
        if (createCount > 0) bot.manager.logger.log(`Dry run: would place ${createCount} new orders`, 'info');
        if (updateCount > 0) bot.manager.logger.log(`Dry run: would update ${updateCount} orders`, 'info');
        popPushedWorkingGrid(bot, cowResult);
        return { executed: true, hadRotation: false };
    }

    // Single-flight COW broadcast guard (entry check): never broadcast two
    // batches concurrently. Overlapping broadcasts plan from the same base
    // grid version; when the first commits it bumps _gridVersion, so the
    // second's commit is refused (base-version mismatch) -> adopt-from-chain
    // -> snapshot reload that can drop the adopted order and produce an
    // orphan fill. This entry wait is an optimization; the authoritative
    // atomic check-and-set happens right before the broadcast below.
    if (await waitForCowBroadcastSingleFlight(bot, 'entry')) {
        popPushedWorkingGrid(bot, cowResult);
        return { executed: false, aborted: true, reason: 'SHUTDOWN_IN_PROGRESS', hadRotation: false };
    }

    // DRAIN PENDING CORRECTIONS before the batch is planned/broadcast.
    // Cancel-only corrections (duplicate-price orphans) queued by an earlier
    // sync must not sit while batches run back-to-back (startup create
    // groups, fill bursts) — with the open-orders sync loop disabled they
    // would otherwise linger indefinitely, keep blocking same-level CREATEs,
    // and risk cancelling the wrong side of a duplicate later. Draining here
    // also keeps this batch's collision checks (chain_orphan_collision)
    // honest: orphaned chain orders already queued for cancellation are
    // resolved before the plan validates its CREATE targets against them.
    const pendingCorrectionCount = Array.isArray(bot.manager?.ordersNeedingPriceCorrection)
        ? bot.manager.ordersNeedingPriceCorrection.length
        : 0;
    if (pendingCorrectionCount > 0 && !bot._shuttingDown) {
        try {
            bot.manager.logger.log(
                `[COW] Draining ${pendingCorrectionCount} pending correction(s) before batch`,
                'info'
            );
            const drainResult = await orderUtils.correctAllPriceMismatches(
                bot.manager, bot.account as string, bot.privateKey as string,
                chainOrders as unknown as Parameters<typeof orderUtils.correctAllPriceMismatches>[3]
            );
            if (drainResult?.failed > 0) {
                bot.manager.logger.log(
                    `[COW] ${drainResult.failed} correction(s) failed pre-batch` +
                    ((drainResult.staleDropped ?? 0) > 0 ? `, ${drainResult.staleDropped} stale dropped` : '') +
                    `; remaining entries retry on next sync/maintenance tick`,
                    'warn'
                );
            } else if ((drainResult?.staleDropped ?? 0) > 0) {
                bot.manager.logger.log(
                    `[COW] Pre-batch drain resolved, ${drainResult.staleDropped} stale correction(s) dropped`,
                    'info'
                );
            }
        } catch (drainErr) {
            bot.manager.logger.log(
                `[COW] Pre-batch correction drain failed: ${getErrorMessage(drainErr)}`,
                'warn'
            );
        }
    }

    // Pre-broadcast guard chain (create-slot validation, recovery-exhausted
    // block, pending/unmatched guards, crossed-book gate) — see
    // runPreBroadcastGuards. Refusals already popped the working grid.
    const guards = await runPreBroadcastGuards(bot, cowResult);
    if (!guards.proceed) return guards.result ?? { executed: false, hadRotation: false };
    const { crossingCandidates = [], intraBatchCandidates = [] } = guards;

    const { assetA, assetB } = bot.manager.assets;
    const operations: unknown[] = [];
    const opContexts: OpPhase[] = [];
    const skippedUpdateSlotIds = new Set();
    let skippedUpdateCount = 0;
    // Guard-skipped CREATE slot ids (hole-refills never placed). Fed to the
    // boundary-hold intersect alongside the UPDATE sets above — a skipped
    // refill CREATE strands its rail hole exactly like a restored UPDATE.
    const skippedCreateSlotIds = new Set();
    // Per-batch LAST-FILL-GUARD disposition counters. Per-action pass lines
    // would spam big batches, so the guard emits one batch summary instead
    // (see the summary after the action loop below).
    const lastFillGuardStats = { checked: 0, passed: 0, skipped: 0, bypassed: 0, pivotOffGrid: 0 };
    // One crossing-CREATE observation per batch (see warnCrossingCreate).
    let crossingCreateWarned = false;
    // Fingerprints of the pending-broadcast entries recorded by THIS batch's
    // op-building (both CREATE paths). The final pivot gate's compaction
    // remaps these entries' stored opIndex/ctxIndex to their post-drop
    // positions; entry.batchId cannot discriminate batches (always null in
    // production), so the fingerprint set is the ownership marker.
    const batchPendingFps = new Set<string>();
    // Per-batch GRID-PRICE-INVARIANT counters (BLOCKING). Tracks emitted prices
    // that are not the genesis level for their slot — such emissions are
    // rejected, not placed. One batch summary.
    const gridPriceInvariantStats: GridPriceInvariantStats = { checked: 0, violated: 0, unchecked: 0 };
    // Whether any guard check in this batch refreshed the pivot from
    // still-queued fills — reported in the batch summary so a pivot change
    // that altered a guard decision is visible at info, not just debug.
    let lastFillGuardPivotRefreshed = false;
    // Slots whose size-update op was broadcast with a post-fill-clamped
    // target: the working grid still holds the planned (larger) size, so the
    // slots are re-synced from master before commit to keep the committed
    // books equal to the broadcast chain amounts.
    const clampedUpdateSlotIds = new Set();
    // orderId -> operations index of its cancel op. A crossing re-pricing
    // update is only safe when the crossed order's cancel was already queued
    // at an earlier position: ops broadcast in gap-slot-sized chunks,
    // so an earlier index means the cancel confirms on chain (same or earlier
    // chunk, applied sequentially) before the crossing order lands.
    const cancelOpIndexByOrderId = new Map<string, number>();

    const idsToLock = new Set();
    for (const action of actions) {
        if (action.type === COW_ACTIONS.CANCEL && action.orderId) {
            idsToLock.add(action.orderId);
            if (action.id) idsToLock.add(action.id);
        } else if (action.type === COW_ACTIONS.CREATE && action.id) {
            idsToLock.add(action.id);
        } else if (action.type === COW_ACTIONS.UPDATE && action.orderId) {
            idsToLock.add(action.orderId);
            if (action.id) idsToLock.add(action.id);
        }
    }

    bot.manager.lockOrders(idsToLock);

    // Ownership of the single-flight broadcast slot for THIS frame. Only the
    // frame that claimed the slot (set bot._cowBroadcastInFlight = true below)
    // may clear it in the finally. A frame that waits at the entry check or
    // early-returns after planning (fund validation, create-slot abort, op-prep
    // throw) never owns the slot and MUST NOT clear it — an unconditional clear
    // would wipe a concurrent batch's in-flight flag and let a third batch
    // broadcast on top of it (the exact overlap this guard prevents).
    let heldBroadcastSlot = false;

    try {
        bot._batchInFlight++;
        bot._markGridActivity('batch start');
        bot.manager._setRebalanceState(REBALANCE_STATES.BROADCASTING);
        bot.manager.startBroadcasting();

        // P3 — freeze the guard pivot once per batch: per-action refreshes
        // mutated the pivot mid-batch (02:03 pivots drifted 0.001523→0.001529
        // across 20 checks), so early actions were judged against a different
        // pivot than later ones. The batch summary still reports whether this
        // freeze moved the pivot under the plan. The frozen value feeds the
        // final pre-broadcast gate below (runFinalPivotGate), which re-checks
        // built ops when a fill queued AFTER the freeze moved the pivot.
        // freezeQueueDepth is the Step-2 observability half: queue depth at
        // freeze time, paired with the gate's own queue readout.
        let freezeQueueDepth: number | null = null;
        try {
            freezeQueueDepth = Array.isArray(bot?._incomingFillQueue)
                ? bot._incomingFillQueue.length
                : null;
        } catch { freezeQueueDepth = null; }
        try { if (refreshLastFillPivotFromQueue(bot)) lastFillGuardPivotRefreshed = true; } catch { /* best-effort */ }
        // Captured AFTER the freeze refresh, not before: the refresh is part
        // of the freeze, so the baseline must be the pivot the ops are about
        // to be judged against. Capturing pre-refresh would make every batch
        // whose freeze picked up a pre-freeze queued fill look "moved" at the
        // gate — a spurious warn plus a redundant full re-check against the
        // identical pivot.
        // Same effective reference the per-action guard judges against (live
        // pivot, else the bot-scoped market fill) so the freeze cannot run cold
        // while the guard still blocks.
        const frozenRef = resolveLastFillGuardReference(bot.manager);
        const frozenPivotAtBatchStart = frozenRef.price;
        const frozenTypeAtBatchStart = frozenRef.type;
        for (const action of actions) {
            if (action.type === COW_ACTIONS.CANCEL) {
                try {
                    const op = await chainOrders.buildCancelOrderOp(bot.account, action.orderId as string);
                    operations.push(op);
                    if (action.orderId) cancelOpIndexByOrderId.set(action.orderId, operations.length - 1);
                    const order = bot.manager.orders.get(action.id) || { id: action.id, orderId: action.orderId };
                    opContexts.push({ kind: 'cancel', order: order as ManagedOrder });
                } catch (err) {
                    const orderNotFound = /\bnot found\b/i.test(getErrorMessage(err)) || /\bdoes not exist\b/i.test(getErrorMessage(err));
                    if (orderNotFound) {
                        bot.manager.logger.log(
                            `[COW] Cancel skipped for ${action.id} (${action.orderId}): order already removed from chain`,
                            'debug'
                        );
                    } else {
                        bot.manager.logger.log(`Failed to prepare cancel op for ${action.id}: ${getErrorMessage(err)}`, 'error');
                    }
                }
            } else if (action.type === COW_ACTIONS.CREATE) {
                try {
                    const order = action.order as ManagedOrder;
                    const sizeValidation = validateOrderSizeForExecution(
                        bot,
                        order.size,
                        order.type,
                        order,
                        order.size
                    );
                    if (!sizeValidation.isValid) {
                        bot.manager.logger.log(
                            `Skipping create op for ${action.id}: ${sizeValidation.reason}`,
                            'warn'
                        );
                        if (action.id) skippedCreateSlotIds.add(action.id);
                        continue;
                    }
                    const liveSlot = bot.manager.orders.get(order.id);
                    const plannedPrice = Number(order.price);
                    const livePrice = liveSlot ? Number(liveSlot.price) : NaN;
                    const priceDrift = Number.isFinite(plannedPrice) && Number.isFinite(livePrice)
                        ? Math.abs(livePrice - plannedPrice)
                        : 0;
                    // The planned price is emitted as-is. A pre-broadcast
                    // substitution with liveSlot.price used to rewrite it here
                    // at `debug` level, which meant a slot whose price had been
                    // mutated off its genesis level got re-broadcast under a
                    // different number than the plan validated (crossing,
                    // collision and last-fill guards all ran on `createPrice`).
                    // slot.price is derived from the genesis ladder, not
                    // authoritative, so a divergence is a signal to report —
                    // never a value to adopt. Reported at `warn`: a divergence
                    // here is a writer bug, not routine freshness.
                    const effectiveOrder = order;
                    if (priceDrift > 0) {
                        bot.manager.logger.log(
                            `[COW] Pre-broadcast price drift on slot ${order.id}: ` +
                            `planned=${plannedPrice} live=${livePrice} (diff=${priceDrift}); ` +
                            `emitting planned price (live slot price is derived from genesis and is not authoritative).`,
                            'warn'
                        );
                    }

                    const createPrice = effectiveOrder.price;
                    const batchCollision = hasSlotPriceCollision(opContexts as unknown as SlotLike[], createPrice, bot.manager._genesis, order.id, (ctx: SlotLike)=> ctx.kind==='create' && (ctx.order as JsonObj | undefined)?.price != null);
                    if (batchCollision) {
                        bot.manager.logger.log(
                            `[COW] Skipping CREATE for ${order.id} at ${Format.formatPrice6(createPrice)}: ` +
                            `same-batch CREATE ${batchCollision.id} already at ` +
                            `price ${Format.formatPrice6(Number(batchCollision.order?.price ?? batchCollision.price))}. ` +
                            `The next reconcile cycle will resolve the mismatch.`,
                            'warn'
                        );
                        if (order.id) skippedCreateSlotIds.add(order.id);
                        continue;
                    }

                    // CROSSING-PLACEMENT GUARD (create variant): the batch-level
                    // validators (validateCreateTargetSlots, detectCrossedBookPlan)
                    // simulated the PLANNED price. That is now the price emitted
                    // (the pre-broadcast substitution was removed), but the guard
                    // is retained as defence-in-depth: it re-checks on the FINAL
                    // price against live and chain-side orders not already
                    // cancelled at an earlier op position — an opposite-side
                    // order cancelled in a later chunk would otherwise coexist
                    // with this create mid-broadcast and self-trade (production
                    // incident class).
                    const createCrossed = findCrossedOrder(
                        crossingCandidates as never,
                        createPrice,
                        order.type,
                        bot.manager.assets,
                        (o: Parameters<typeof orderUtils.isCrossingCheckCandidate>[0]) => orderUtils.isCrossingCheckCandidate(o, null, cancelOpIndexByOrderId)
                    );
                    const intraBatchCrossed = createCrossed ? null : findCrossedOrder(
                        intraBatchCandidates as never,
                        createPrice,
                        order.type,
                        bot.manager.assets
                    );
                    const effectiveCrossed = createCrossed || intraBatchCrossed;
                    if (effectiveCrossed) {
                        bot.manager.logger.log(
                            `[COW-CROSS-GUARD] Skipping CREATE for ${order.id} at ` +
                            `${Format.formatPrice6(createPrice)}: crosses live ` +
                            `${crossedOrderLabel(effectiveCrossed)}; re-planned after its cancel confirms.`,
                            'warn'
                        );
                        if (order.id) skippedCreateSlotIds.add(order.id);
                        continue;
                    }

                    // LAST-FILL PRICE GUARD: direction rule (BUY < pivot, SELL > pivot).
                    // Bypass is per-action: only spread-correction CREATES skip so gap repair can close.
                    // The batch-level origin is honored only for actions without their own origin stamp
                    // (back-compat for plans that bypass buildActionsFromPlan). Cold (null) => disabled.
                    try {
                        const actionOrigin = action?.origin;
                        const batchOrigin = cowResult?.origin;
                        const isCorrectionCreate = (actionOrigin === COW_ORIGINS.SPREAD_CORRECTION
                            || (actionOrigin == null && batchOrigin === COW_ORIGINS.SPREAD_CORRECTION))
                            && isSpreadCorrectionBypassAllowed(bot);
                        if (!isCorrectionCreate) {
                            const { check, refreshed } = runLastFillGuardCheck(bot, createPrice, order.type, lastFillGuardStats, true);
                            if (refreshed) lastFillGuardPivotRefreshed = true;
                            if (check.blocked) {
                                lastFillGuardStats.skipped++;
                                const dir = order.type === ORDER_TYPES.BUY ? 'above' : 'below';
                                bot.manager.logger.log(
                                    `[LAST-FILL-GUARD] Skipping ${order.type} CREATE for ${order.id} at ${Format.formatPrice6(createPrice)}: ${dir} last filled ${Format.formatPrice6(Number(check.pivot))} (direction rule: BUY must be below / SELL above the last fill); re-planned after market moves`,
                                    'debug'
                                );
                                if (order.id) skippedCreateSlotIds.add(order.id);
                                continue;
                            }
                            lastFillGuardStats.passed++;
                        } else {
                            lastFillGuardStats.bypassed++;
                        }
                    } catch (_e) { /* guard is best-effort */ }

                    // PLANNER/EXECUTION ASYMMETRY (observability only).
                    // The spread-correction planner refuses a candidate that
                    // crosses the live-market/fill floor (doesNotCrossMarket);
                    // this generic CREATE path (reconcile refills, rotation
                    // fallbacks) has no such gate — deliberately, because a hard
                    // veto here would re-open the counter-order deadlock: after
                    // a gap the counter lands on the better side of the market
                    // by construction, and a gapped market can put the planned
                    // level on the other side, where it executes at the BEST
                    // available price (a taker fill, never a worse price).
                    // So this is a fee/liquidity observation, not a safety veto.
                    if (!crossingCreateWarned) {
                        crossingCreateWarned = warnCrossingCreate(bot, createPrice, order.type, order.id);
                    }

                    const args = buildCreateOrderArgs(effectiveOrder, assetA, assetB);
                    // GRID-PRICE-INVARIANT (blocking): the CREATE price must be
                    // the genesis level for this slot. A mismatch means state
                    // corruption upstream, so the emission is skipped rather
                    // than placed — the next reconcile cycle re-plans. See
                    // docs/GRID_PRICE_INVARIANT.md.
                    if (!recordGridPriceInvariantCheck(bot, order.id, createPrice, gridPriceInvariantStats, 'CREATE')) {
                        if (order.id) skippedCreateSlotIds.add(order.id);
                        continue;
                    }
                    recordRestampBuyAboveAnchor(bot, createPrice, order.type);
                    const buildResult = await chainOrders.buildCreateOrderOp(
                        bot.account,
                        args.amountToSell,
                        args.sellAssetId as string,
                        args.minToReceive,
                        args.receiveAssetId as string,
                        null
                    );
                    if (!buildResult) {
                        bot.manager.logger.log(
                            `Skipping create op for ${action.id}: amounts would round to 0 on blockchain`,
                            'warn'
                        );
                        if (action.id) skippedCreateSlotIds.add(action.id);
                        continue;
                    }
                    operations.push(buildResult.op);
                    opContexts.push({ kind: 'create', id: order.id, order: effectiveOrder, args, finalInts: buildResult.finalInts });
                    intraBatchCandidates.push(effectiveOrder);
                    const recordedFp = recordPendingBroadcast(bot, {
                        opIndex: operations.length - 1,
                        ctxIndex: opContexts.length - 1,
                        order: effectiveOrder,
                        finalInts: buildResult.finalInts
                    });
                    if (recordedFp) batchPendingFps.add(recordedFp);
                } catch (err) {
                    bot.manager.logger.log(`Failed to prepare create op for ${action.id}: ${getErrorMessage(err)}`, 'error');
                }
            } else if (action.type === COW_ACTIONS.UPDATE) {
                try {
                    if (action.newGridId && action.newGridId !== action.id) {
                        const masterOrder = bot.manager.orders.get(action.id);
                        const orderType = action.order?.type || masterOrder?.type;
                        // ROTATION PRICE IS THE DESTINATION'S GENESIS LEVEL.
                        //
                        // A rotation re-prices to the destination slot, so the
                        // destination's level is the authoritative price — not
                        // action.newPrice, which the planner copies from
                        // hole.order.price and which is therefore only as sound
                        // as whatever wrote that object. Deriving it here means a
                        // planner bug cannot produce a mis-priced UPDATE even if
                        // the invariant check below were bypassed; the check
                        // stays as the backstop that catches a missing genesis
                        // ladder (where it fails open) rather than the only
                        // thing standing between a bad plan and a live order.
                        const derivedNewPrice = deriveRotationPrice(bot, action.newGridId);
                        const plannedNewPrice = Number.isFinite(Number(action.newPrice))
                            ? Number(action.newPrice)
                            : Number(action.order?.price);
                        let newPrice = Number.isFinite(derivedNewPrice) ? derivedNewPrice : plannedNewPrice;
                        if (Number.isFinite(derivedNewPrice) && Number.isFinite(plannedNewPrice)
                            && Math.abs(derivedNewPrice - plannedNewPrice) > Math.max(1e-12, Math.abs(derivedNewPrice) * 1e-9)) {
                            bot.manager.logger.log(
                                `[GRID-PRICE-INVARIANT] Rotation ${action.id} -> ${action.newGridId}: planned price ${Format.formatPrice6(plannedNewPrice)} ` +
                                `differs from the destination's genesis level ${Format.formatPrice6(derivedNewPrice)} — ` +
                                `emitting the genesis level`,
                                'warn'
                            );
                        }
                        const newSize = plannedUpdateSize(action);

                        if (!masterOrder || !action.orderId || !orderType || !Number.isFinite(newPrice) || newSize <= 0) {
                            continue;
                        }

                        // POST-FILL GROWTH GUARD (rotation): a rotation must
                        // not GROW a partially-filled order back above its
                        // booked remaining size — the fill is already booked
                        // into slot.size, and growing in place diverges the
                        // fill accounting (chain restores the pre-fill size
                        // while the books keep the post-fill remainder). Skip
                        // like the guards above: the working grid restores the
                        // slot from master and the next plan re-evaluates.
                        if (masterOrder.state === ORDER_STATES.PARTIAL
                            && Number.isFinite(Number(masterOrder.size))
                            && Number(masterOrder.size) > 0
                            && newSize > Number(masterOrder.size)) {
                            skippedUpdateCount++;
                            if (action.id) skippedUpdateSlotIds.add(action.id);
                            if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                            bot.manager.logger.log(
                                `[COW] Skipping rotation update ${action.id} -> ${action.newGridId}: ` +
                                `slot is PARTIAL with booked remaining ${Format.formatAmount(Number(masterOrder.size))} ` +
                                `but the plan targets ${Format.formatAmount(newSize)} — a partially-filled order ` +
                                `must not be grown in place (fill accounting divergence).`,
                                'warn'
                            );
                            continue;
                        }

                        const rotationSizeValidation = validateOrderSizeForExecution(
                            bot,
                            newSize,
                            orderType,
                            action.order,
                            newSize
                        );
                        if (!rotationSizeValidation.isValid) {
                            // Record like every sibling skip site: the skip set
                            // feeds both the working-grid restore and the
                            // boundary hold (a skipped refill must not let the
                            // committed boundary advance past its empty slot).
                            skippedUpdateCount++;
                            if (action.id) skippedUpdateSlotIds.add(action.id);
                            if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                            bot.manager.logger.log(
                                `Skipping rotation update ${action.id} -> ${action.newGridId}: ${rotationSizeValidation.reason}`,
                                'warn'
                            );
                            continue;
                        }

                        // CROSSING-PLACEMENT GUARD: re-pricing an order must
                        // never cross an opposite-side live order whose cancel
                        // is not already queued at an earlier op position.
                        // Re-pricing a buy upward across our own live sell
                        // ladder self-trades during the chunked broadcast
                        // window (production incident: a startup buy was
                        // re-priced upward and filled against our own live
                        // opposite-side sells that this same plan was still
                        // cancelling in later chunks — dozens of self-fills,
                        // fatal fund assert). Skipping is safe: the slot keeps its
                        // old commitment and the next plan re-evaluates once
                        // the crossed order's cancel confirms.
                        const crossedOrder = findCrossedOrder(
                            [...crossingCandidates, ...intraBatchCandidates] as never,
                            newPrice,
                            orderType,
                            bot.manager.assets,
                            (o: Parameters<typeof orderUtils.isCrossingCheckCandidate>[0]) => orderUtils.isCrossingCheckCandidate(o, action.orderId, cancelOpIndexByOrderId)
                        );
                        if (crossedOrder) {
                            skippedUpdateCount++;
                            if (action.id) skippedUpdateSlotIds.add(action.id);
                            if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                            bot.manager.logger.log(
                                `[COW-CROSS-GUARD] Skipping rotation update ${action.id} -> ${action.newGridId}: ` +
                                `new ${orderType} @${Format.formatPrice6(newPrice)} crosses live ` +
                                `${crossedOrderLabel(crossedOrder)}; re-planned after its cancel confirms.`,
                                'warn'
                            );
                            continue;
                        }

                        // LAST-FILL PRICE GUARD (UPDATE rotation): direction rule — same as CREATE,
                        // plus the GAP-EVACUATION ALLOWANCE (violation-reducing): a rotation stamped
                        // origin='gap-evacuation' at plan-build moves a live order OUT of the gap band
                        // onto its rail with bit-exact non-growing size — it shrinks the violation
                        // surface instead of adding exposure, so it bypasses the guard. The bypass
                        // is UPDATE-only (CREATEs carry no source slot and can never qualify) and
                        // honors the frozen B-stamp (evacBoundary/evacGapSlots captured when the
                        // plan was built — never re-derived here, since plans can validate against
                        // a later-committed boundary):
                        // - B-stamped: plan-build geometry already proved the evacuation; bypass
                        //   outright (logged + counted as bypassed).
                        // - Unstamped gap-evacuation: prove it live from oldPrice/oldSize read
                        //   off the MASTER grid above (bot.manager.orders.get, before rotation
                        //   pre-application virtualizes sources — after that the lookup lies);
                        //   fail closed (block) when unresolvable; otherwise run the pure
                        //   isEvacuationRotationAllowed decision and bypass only on allow.
                        // Everything else obeys the guard (per-action scoping: a rotation entry
                        // merged into another plan inherits no bypass).
                        // The pivot is refreshed from still-queued fills first: fills detected mid-broadcast
                        // sit in _incomingFillQueue until the fill cycle ends, and without this the later
                        // chunks of a long broadcast would be checked against a stale pivot.
                        try {
                            let bypassedEvacuation = false;
                            const rotationOrigin = action?.origin;
                            if (rotationOrigin === COW_ORIGINS.GAP_EVACUATION) {
                                // Absent-aware: a legacy stamp carrying null/''
                                // geometry must not read as boundary 0 / gap 0.
                                const frozenB = Format.toKnownNumber(action?.evacBoundary);
                                const frozenG = Format.toKnownNumber(action?.evacGapSlots);
                                let stampUsable = Number.isFinite(frozenB) && Number.isFinite(frozenG);
                                if (stampUsable) {
                                    // Stale-stamp check: the stamp froze PLAN-BUILD
                                    // geometry; if a boundary commit landed between
                                    // plan-build and execution and the source is no
                                    // longer in-band (or dest no longer rail) under
                                    // the LIVE geometry, re-prove via the unstamped
                                    // live probe below instead of bypassing outright.
                                    const stampValid = isEvacuationStampStillValid(
                                        bot.manager?.boundaryIdx, bot.manager?._gapSlots,
                                        action.id, action.newGridId, orderType
                                    );
                                    if (!stampValid) {
                                        stampUsable = false;
                                        bot.manager.logger.log(
                                            `[LAST-FILL-GUARD] Stamped evacuation for ${action.id} -> ${action.newGridId} is stale under live ` +
                                            `boundary ${bot.manager?.boundaryIdx}/gap ${bot.manager?._gapSlots} — refusing the stale plan`,
                                            'warn'
                                        );
                                    }
                                }
                                if (stampUsable) {
                                    // Stamped-size re-proof: the stamp proved the
                                    // plan-time size, but an unprocessed fill can
                                    // land between plan-build and execution and
                                    // shrink the booked remaining below the
                                    // planned size (the PARTIAL-only growth guard
                                    // above misses it when the slot is not yet
                                    // PARTIAL). Re-prove against the LIVE master
                                    // size; invalidating the stamp routes into
                                    // the unstamped probe below, whose
                                    // isEvacuationRotationAllowed also rejects
                                    // growth and then falls through to the
                                    // normal last-fill guard.
                                    let stampPrecision: number | null = null;
                                    try { stampPrecision = getPrecisionByOrderType(bot.manager.assets, orderType); } catch { stampPrecision = null; }
                                    if (!isEvacuationSizeStillValid(newSize, Number(masterOrder?.size), stampPrecision)) {
                                        stampUsable = false;
                                        bot.manager.logger.log(
                                            `[LAST-FILL-GUARD] Stamped evacuation for ${action.id} -> ${action.newGridId} lost its size cover: ` +
                                            `planned ${Format.formatAmount(newSize)} exceeds booked remaining ${Format.formatAmount(Number(masterOrder?.size))} — re-proving live`,
                                            'warn'
                                        );
                                    }
                                }
                                if (stampUsable) {
                                    bypassedEvacuation = true;
                                    bot.manager.logger.log(
                                        `[LAST-FILL-GUARD] Allowing ${orderType} evacuation UPDATE for ${action.id} -> ${action.newGridId} at ${Format.formatPrice6(newPrice)}: ` +
                                        `gap-evacuation stamped at plan-build (boundary ${frozenB}, gap ${frozenG})`,
                                        'warn'
                                    );
                                } else {
                                    // Unstamped: prove violation-reducing live. masterOrder was
                                    // captured from the master grid before any rotation
                                    // pre-application — it must NOT be re-read afterwards.
                                    const oldPrice = Number(masterOrder?.price);
                                    const oldSize = Number(masterOrder?.size);
                                    if (!Number.isFinite(oldPrice) || !(oldPrice > 0) || !Number.isFinite(oldSize) || !(oldSize > 0)) {
                                        lastFillGuardStats.checked++;
                                        lastFillGuardStats.skipped++;
                                        skippedUpdateCount++;
                                        if (action.id) skippedUpdateSlotIds.add(action.id);
                                        if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                                        bot.manager.logger.log(
                                            `[LAST-FILL-GUARD] Skipping ${orderType} UPDATE for ${action.id} -> ${action.newGridId}: ` +
                                            `gap-evacuation source unresolvable from master grid (fail-closed)`,
                                            'warn'
                                        );
                                        continue;
                                    }
                                    let sidePrecision: number | null = null;
                                    try { sidePrecision = getPrecisionByOrderType(bot.manager.assets, orderType); } catch { sidePrecision = null; }
                                    // Geometry re-proof under the LIVE boundary. A stale
                                    // evacuation must NOT fall through to the direction-only
                                    // last-fill guard: that guard only checks the fill price,
                                    // not whether the move still makes grid sense. Live
                                    // incident 2026-10-30: a plan built at boundary 124
                                    // wanted to evacuate buys 125-128; by execution the
                                    // boundary was 128 and those orders were valid in-rail.
                                    // The stale probe was rejected, the normal guard then
                                    // allowed the four lower buys, and the grid lost its
                                    // bid edge (spread 1.51% -> 2.74%). Fail closed: skip
                                    // the op and let the next plan/reconcile re-evaluate.
                                    // Non-finite live geometry keeps plan-build authority
                                    // (isEvacuationStampStillValid returns true there).
                                    let staleSkipReason: string | null = null;
                                    if (!isEvacuationStampStillValid(bot.manager?.boundaryIdx, bot.manager?._gapSlots, action.id, action.newGridId, orderType)) {
                                        staleSkipReason = `source/dest no longer evacuation geometry under live boundary ${bot.manager?.boundaryIdx}/gap ${bot.manager?._gapSlots}`;
                                    } else {
                                        const evacCheck = isEvacuationRotationAllowed(oldPrice, oldSize, newPrice, newSize, orderType, sidePrecision);
                                        if (evacCheck.allowed) {
                                            bypassedEvacuation = true;
                                            bot.manager.logger.log(
                                                `[LAST-FILL-GUARD] Allowing ${orderType} evacuation UPDATE for ${action.id} -> ${action.newGridId} at ${Format.formatPrice6(newPrice)}: ` +
                                                `${evacCheck.reason} (probed live: ${Format.formatPrice6(oldPrice)} -> ${Format.formatPrice6(newPrice)})`,
                                                'warn'
                                            );
                                        } else {
                                            staleSkipReason = evacCheck.reason;
                                        }
                                    }
                                    if (!bypassedEvacuation) {
                                        lastFillGuardStats.checked++;
                                        lastFillGuardStats.skipped++;
                                        skippedUpdateCount++;
                                        if (action.id) skippedUpdateSlotIds.add(action.id);
                                        if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                                        bot.manager.logger.log(
                                            `[LAST-FILL-GUARD] Skipping ${orderType} UPDATE for ${action.id} -> ${action.newGridId}: ` +
                                            `stale gap-evacuation (${staleSkipReason ?? 'not violation-reducing'}) — next plan re-evaluates`,
                                            'warn'
                                        );
                                        continue;
                                    }
                                }
                            }
                            if (bypassedEvacuation) {
                                lastFillGuardStats.bypassed++;
                            } else {
                            const { check, refreshed } = runLastFillGuardCheck(bot, newPrice, orderType, lastFillGuardStats, true);
                            if (refreshed) lastFillGuardPivotRefreshed = true;
                            if (check.blocked) {
                                lastFillGuardStats.skipped++;
                                skippedUpdateCount++;
                                if (action.id) skippedUpdateSlotIds.add(action.id);
                                if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                                const dir = orderType === ORDER_TYPES.BUY ? 'above' : 'below';
                                bot.manager.logger.log(
                                    `[LAST-FILL-GUARD] Skipping ${orderType} UPDATE for ${action.id} -> ${action.newGridId} at ${Format.formatPrice6(newPrice)}: ${dir} last filled ${Format.formatPrice6(Number(check.pivot))} (direction rule: BUY must be below / SELL above the last fill)`,
                                    'debug'
                                );
                                continue;
                            }
                            lastFillGuardStats.passed++;
                            }
                        } catch (_e) { /* best-effort */ }

                        const { amountToSell, minToReceive } = buildCreateOrderArgs(
                            { type: orderType, size: newSize, price: newPrice },
                            assetA,
                            assetB
                        );
                        // GRID-PRICE-INVARIANT (blocking): the emitted price
                        // is action.newPrice, which every planner derives from the
                        // object named by action.newGridId (verified: grid.ts:1867,
                        // utils/system.ts:1195, validate.ts:600/746). Pass the
                        // destination id only — no source fallback, so a missing id
                        // counts as unchecked instead of checking the wrong slot.
                        if (!recordGridPriceInvariantCheck(bot, action.newGridId, newPrice, gridPriceInvariantStats, 'UPDATE')) {
                            skippedUpdateCount++;
                            if (action.id) skippedUpdateSlotIds.add(action.id);
                            if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                            continue;
                        }
                        recordRestampBuyAboveAnchor(bot, newPrice, orderType);

                        const buildResult = await chainOrders.buildUpdateOrderOp(
                            bot.account,
                            action.orderId,
                            { amountToSell, minToReceive, newPrice, orderType },
                            masterOrder.rawOnChain || null
                        );
                        if (!buildResult) {
                            skippedUpdateCount++;
                            if (action.id) skippedUpdateSlotIds.add(action.id);
                            if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                            bot.manager.logger.log(
                                `[COW] Skipping rotation update ${action.id} -> ${action.newGridId}: no blockchain delta`,
                                'debug'
                            );
                            continue;
                        }

                        operations.push(buildResult.op);
                        opContexts.push({
                            kind: 'rotation',
                            rotation: {
                                oldOrder: { ...masterOrder },
                                newGridId: action.newGridId,
                                newPrice,
                                newSize,
                                type: orderType
                            },
                            finalInts: buildResult.finalInts
                        });
                        intraBatchCandidates.push({ type: orderType, price: newPrice, orderId: action.orderId, id: action.newGridId || action.id });
                        continue;
                    }

                    const masterOrder = bot.manager.orders.get(action.id);
                    const plannedNewSize = plannedUpdateSize(action);
                    const newSize = clampPostFillUpdateSize(bot, masterOrder as ManagedOrder, plannedNewSize, action);
                    if (newSize !== plannedNewSize) {
                        clampedUpdateSlotIds.add(action.id);
                    }
                    const orderType = action.order?.type || masterOrder?.type;
                    const cachedRawOnChain = masterOrder?.rawOnChain || action.order?.rawOnChain || null;

                    const op = await chainOrders.buildUpdateOrderOp(
                        bot.account,
                        action.orderId as string,
                        { amountToSell: newSize, orderType },
                        cachedRawOnChain
                    );
                    if (!op) {
                        skippedUpdateCount++;
                        if (action.id) skippedUpdateSlotIds.add(action.id);
                        if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                        bot.manager.logger.log(
                            `[COW] Skipping size update ${action.id} (${action.orderId}): no blockchain delta`,
                            'debug'
                        );
                        continue;
                    }
                    operations.push(op.op);
                    if (masterOrder?.price != null) intraBatchCandidates.push({ type: orderType, price: masterOrder.price, orderId: action.orderId, id: action.id });
                    const partialOrder = masterOrder || {
                        id: action.id,
                        orderId: action.orderId,
                        type: orderType
                    };
                    opContexts.push({ kind: 'size-update', updateInfo: { partialOrder, newSize }, finalInts: op.finalInts });
                } catch (err) {
                    const orderNotFound = /\bnot found\b/i.test(getErrorMessage(err)) || /\bdoes not exist\b/i.test(getErrorMessage(err));
                    if (orderNotFound) {
                        try {
                            const fbOrder = action.order || bot.manager.orders.get(action.id);
                            const fbType = fbOrder?.type;
                            const fbSize = action.newSize || fbOrder?.size || 0;
                            const targetSlotId = action.newGridId || action.id;
                            const plannedPrice = action.newPrice || action.order?.price || 0;
                            const liveSlotForPrice = bot.manager.orders.get(targetSlotId);
                            const livePrice = liveSlotForPrice ? Number(liveSlotForPrice.price) : NaN;
                            const priceDrift = Number.isFinite(plannedPrice) && Number.isFinite(livePrice)
                                ? Math.abs(livePrice - plannedPrice)
                                : 0;
                            const fbPrice = plannedPrice;
                            if (priceDrift > 0) {
                                // Same rationale as the primary CREATE path: emit
                                // the planned price and report the divergence
                                // rather than adopting a derived live price.
                                bot.manager.logger.log(
                                    `[COW] CREATE fallback price drift for ${action.id} -> ${targetSlotId}: ` +
                                    `planned=${plannedPrice} live=${livePrice} (diff=${priceDrift}); ` +
                                    `emitting planned price.`,
                                    'warn'
                                );
                            }
                            const sizeCheck = validateOrderSizeForExecution(bot, fbSize, fbType as string, fbOrder as unknown as JsonObj, fbSize);
                            if (!sizeCheck.isValid) {
                                bot.manager.logger.log(
                                    `[COW] CREATE fallback for ${action.id} rejected by size validation: ${sizeCheck.reason}`,
                                    'warn'
                                );
                            } else if (fbType && fbSize > 0 && fbPrice > 0) {
                                const fbCollision = hasSlotPriceCollision([...bot.manager.orders.values()], fbPrice, bot.manager._genesis, targetSlotId, isOrderPlaced as (it: SlotLike) => boolean);
                                if (fbCollision) {
                                    bot.manager.logger.log(
                                        `[COW] Skipping CREATE fallback for ${targetSlotId} at ${Format.formatPrice6(fbPrice)}: ` +
                                        `existing placed order ${fbCollision.id} (${fbCollision.orderId}) ` +
                                        `already at price ${Format.formatPrice6(Number(fbCollision.price))}.`,
                                        'warn'
                                    );
                                    continue;
                                }
                                const fbBatchCollision = hasSlotPriceCollision(opContexts as unknown as SlotLike[], fbPrice, bot.manager._genesis, targetSlotId, (ctx: SlotLike)=> ctx.kind==='create');
                                if (fbBatchCollision) {
                                    bot.manager.logger.log(
                                        `[COW] Skipping CREATE fallback for ${targetSlotId} at ${Format.formatPrice6(fbPrice)}: ` +
                                        `same-batch CREATE ${fbBatchCollision.id} already at ` +
                                        `price ${Format.formatPrice6(Number(fbBatchCollision.order?.price ?? fbBatchCollision.price))}.`,
                                        'warn'
                                    );
                                    continue;
                                }
                                // CROSSING-PLACEMENT GUARD (fallback variant):
                                // the not-found conversion re-prices to the
                                // rotation's target price, so it must obey the
                                // same crossing rule as the rotation UPDATE it
                                // replaces — no crossing of an opposite-side
                                // live order whose cancel is not already
                                // queued at an earlier op position.
                                const fbCrossed = findCrossedOrder(
                                    crossingCandidates as never,
                                    fbPrice,
                                    fbType,
                                    bot.manager.assets,
                                    (o: Parameters<typeof orderUtils.isCrossingCheckCandidate>[0]) => orderUtils.isCrossingCheckCandidate(o, null, cancelOpIndexByOrderId)
                                );
                                if (fbCrossed) {
                                    bot.manager.logger.log(
                                        `[COW-CROSS-GUARD] Skipping CREATE fallback for ${targetSlotId} at ` +
                                        `${Format.formatPrice6(fbPrice)}: new ${fbType} crosses live ` +
                                        `${crossedOrderLabel(fbCrossed)}; re-planned after its cancel confirms.`,
                                        'warn'
                                    );
                                    continue;
                                }
                                // LAST-FILL GUARD (fallback variant): this CREATE
                                // replaces a rotation UPDATE at a repriced level,
                                // so it obeys the same guard against the frozen
                                // batch pivot — no origin bypass, same as rotations.
                                try {
                                    const { check: fbCheck, refreshed: fbRefreshed } = runLastFillGuardCheck(bot, fbPrice, fbType, lastFillGuardStats, true);
                                    if (fbRefreshed) lastFillGuardPivotRefreshed = true;
                                    if (fbCheck.blocked) {
                                        lastFillGuardStats.skipped++;
                                        const fbDir = fbType === ORDER_TYPES.BUY ? 'above' : 'below';
                                        bot.manager.logger.log(
                                            `[LAST-FILL-GUARD] Skipping CREATE fallback for ${targetSlotId} at ` +
                                            `${Format.formatPrice6(fbPrice)}: ${fbDir} last filled ` +
                                            `${Format.formatPrice6(Number(fbCheck.pivot))} (direction rule: BUY must be ` +
                                            `below / SELL above the last fill); re-planned after market moves`,
                                            'debug'
                                        );
                                        continue;
                                    }
                                    lastFillGuardStats.passed++;
                                } catch (_fbGuardErr) { /* guard is best-effort */ }
                                const fbArgs = buildCreateOrderArgs(
                                    { type: fbType, size: fbSize, price: fbPrice },
                                    assetA, assetB
                                );
                                // GRID-PRICE-INVARIANT (blocking): fallback CREATE.
                                if (!recordGridPriceInvariantCheck(bot, targetSlotId, fbPrice, gridPriceInvariantStats, 'CREATE-FALLBACK')) {
                                    continue;
                                }
                                recordRestampBuyAboveAnchor(bot, fbPrice, fbType);
                                const fbResult = await chainOrders.buildCreateOrderOp(
                                    bot.account,
                                    fbArgs.amountToSell,
                                    fbArgs.sellAssetId as string,
                                    fbArgs.minToReceive,
                                    fbArgs.receiveAssetId as string,
                                    null
                                );
                                if (fbResult) {
                                    operations.push(fbResult.op);
                                    opContexts.push({
                                        kind: 'create',
                                        id: targetSlotId,
                                        order: { id: targetSlotId, type: fbType, price: fbPrice, size: fbSize } as unknown as ManagedOrder,
                                        args: { amountToSell: fbArgs.amountToSell, minToReceive: fbArgs.minToReceive },
                                        finalInts: fbResult.finalInts
                                    });
                                    const fbRecordedFp = recordPendingBroadcast(bot, {
                                        opIndex: operations.length - 1,
                                        ctxIndex: opContexts.length - 1,
                                        order: { id: targetSlotId, type: fbType, price: fbPrice, size: fbSize } as unknown as ManagedOrder,
                                        finalInts: fbResult.finalInts
                                    });
                                    if (fbRecordedFp) batchPendingFps.add(fbRecordedFp);
                                    bot.manager.logger.log(
                                        `[COW] Recovered "not found" for ${action.id}: converted UPDATE to CREATE for slot ${targetSlotId}`,
                                        'warn'
                                    );
                                    continue;
                                }
                            }
                        } catch (fbErr) {
                            bot.manager.logger.log(
                                `[COW] CREATE fallback also failed for ${action.id}: ${getErrorMessage(fbErr)}`,
                                'warn'
                            );
                        }
                    }
                    bot.manager.logger.log(`Failed to prepare update op for ${action.id}: ${getErrorMessage(err)}`, 'error');
                }
            }
        }

        // FINAL PRE-BROADCAST PIVOT GATE (2026-09-13 incident on a live
        // market-pair bot): a
        // fill queued AFTER the batch-start freeze but BEFORE broadcast
        // passes every per-action check on a stale pivot (freeze .745, fill
        // queued .765, broadcast .910). Re-check the BUILT ops against a
        // re-refreshed pivot here — after op-building, before the batch
        // summary (drops count as skipped, not passed), fund validation
        // (snapshot reflects filtered ops) and single-flight claim.
        // op indexes recorded during op-building are rebuilt from kept
        // contexts below, so any future reader sees live indexes.
        // The gate runs on its OWN stats object: its re-checks would
        // otherwise double-count the build loop's checked/passed/skipped
        // totals in the batch summary below. Gate contributions are
        // reported separately (gateChecked=... fields).
        const skippedUpdateCountRef = { count: 0 };
        const finalGateStats = { checked: 0, passed: 0, skipped: 0, bypassed: 0, pivotOffGrid: 0 };
        let finalGate: { dropped: unknown[]; pivotChanged: boolean; refreshed: boolean } | null = null;
        try {
            finalGate = runFinalPivotGate(bot, operations, opContexts, {
                actions,
                cowResult,
                frozenPivot: frozenPivotAtBatchStart,
                frozenType: frozenTypeAtBatchStart,
                lastFillGuardStats: finalGateStats,
                skippedUpdateSlotIds,
                skippedCreateSlotIds,
                skippedUpdateCountRef,
                freezeQueueDepth,
                batchPendingFps,
            });
            if (finalGate.refreshed) lastFillGuardPivotRefreshed = true;
            if (finalGate.pivotChanged) {
                try {
                    const fmtP = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? 'none' : Format.formatPrice6(Number(v)));
                    bot.manager?.logger?.log?.(
                        `[LAST-FILL-GUARD] Final gate: pivot moved under batch ` +
                        `${fmtP(frozenPivotAtBatchStart)}(${frozenTypeAtBatchStart ?? 'cold'})` +
                        `->${fmtP(bot.manager?._lastFilledPrice)}(${bot.manager?._lastFilledType ?? 'cold'}) ` +
                        `(freezeQueue=${freezeQueueDepth ?? '?'}) ` +
                        `dropped=${finalGate.dropped.length}`,
                        'warn'
                    );
                } catch { /* logging is best-effort */ }
            }
            // Rebuild cancelOpIndexByOrderId from the KEPT contexts: the
            // gate compacted operations/opContexts in lockstep, so indexes
            // recorded during op-building are stale for every op after the
            // first drop. cancelOpIndexByOrderId has NO readers past this
            // point (verified: the op-building loop is its last use —
            // pair-mode/chunk grouping is computed lazily at broadcast from
            // opContexts with no stored indexes), so this rebuild is
            // defence-in-depth for future readers, not a live fix.
            cancelOpIndexByOrderId.clear();
            for (let ci = 0; ci < opContexts.length; ci++) {
                const cctx = opContexts[ci] as OpPhase;
                const cord = cctx?.order;
                const cOrderId = cctx?.kind === 'cancel'
                    ? cctx?.order?.orderId || cctx?.orderId
                    : cord?.orderId;
                if (cOrderId) cancelOpIndexByOrderId.set(String(cOrderId), ci);
            }
            // skippedUpdateCount is threaded via countRef so the restore
            // below covers gate-dropped rotations too.
            if (skippedUpdateCountRef.count > 0) skippedUpdateCount += skippedUpdateCountRef.count;
        } catch (_gateErr) { /* gate is fail-open: keep the built ops */ }

        // Batch-level LAST-FILL-GUARD summary: per-action pass lines would spam
        // big batches, so one line per batch records the mode, pivot, resolved
        // increment, and pass/skip/bypass counts — the guard's pass decisions
        // are what incident reconstruction needs. Origin folds in here as
        // mode=bypassed(<origin>); there is no second source of truth.
        // Cold (guard off) is warn, not info — a disabled guard must say so.
        // pivotRefreshed surfaces whether the batch-start freeze picked up a
        // queued fill (the refresh itself stays debug). The pivot is frozen
        // for the whole batch, so every action was checked against the same
        // pivot printed here.
        try {
            // The final gate reports on its OWN counters (finalGateStats), so
            // checked/passed/skipped/bypassed here are the build loop's
            // verdicts only — the gate's re-checks never inflate them. The
            // gate's contributions ride along as gate* fields, omitted when
            // the gate did not re-check anything (same convention as
            // pivotOffGrid above). totalGuarded includes the gate so a
            // batch that was ONLY gate-checked (e.g. cold freeze armed
            // mid-batch) still prints.
            const gateGuarded = finalGateStats.checked + finalGateStats.bypassed;
            const totalGuarded = lastFillGuardStats.checked + lastFillGuardStats.bypassed + gateGuarded;
            if (totalGuarded > 0) {
                // Same effective reference the guard judged against (live pivot
                // else the bot-scoped market fill) so the summary cannot report
                // disabled(cold) while placements were actually blocked.
                const sumRef = resolveLastFillGuardReference(bot.manager);
                const sumPivotRaw = sumRef.price;
                const sumType = sumRef.type;
                const sumInc = resolveLastFillGuardIncrement(bot);
                const cold = sumPivotRaw == null || !Number.isFinite(Number(sumPivotRaw)) || sumType == null;
                const batchOrigin = cowResult?.origin;
                const mode = cold
                    ? 'disabled(cold)'
                    : (lastFillGuardStats.bypassed > 0 && lastFillGuardStats.checked === 0)
                        ? `bypassed(${batchOrigin || 'unknown'})`
                        : (lastFillGuardStats.bypassed > 0
                            ? `active+bypassed(${batchOrigin || 'unknown'})`
                            : 'active');
                const pivotStr = cold ? 'none' : `${Format.formatPrice6(Number(sumPivotRaw))}(${sumType})`;
                // Report when the pivot used for this batch was NOT a ladder
                // level: that is the precondition for a pivoted ratchet, and
                // the value alone does not reveal it.
                const batchPivot = cold ? null : resolveOnGridPivot(bot.manager, sumPivotRaw);
                const pivotGridStr = cold
                    ? ''
                    : (batchPivot && batchPivot.idx != null
                        ? ` pivotSlot=${batchPivot.idx}${batchPivot.snapped ? '(snapped)' : ''}`
                        : ' pivotOffGrid=true');
                bot.manager.logger.log(
                    `[LAST-FILL-GUARD] mode=${mode} pivot=${pivotStr}${pivotGridStr} inc=${sumInc}% ` +
                    `pivotRefreshed=${lastFillGuardPivotRefreshed} ` +
                    `checked=${lastFillGuardStats.checked} passed=${lastFillGuardStats.passed} ` +
                    `skipped=${lastFillGuardStats.skipped} bypassed=${lastFillGuardStats.bypassed}` +
                    // Per-action off-ladder count. The batch-level
                    // `pivotOffGrid=true` flag above only says the pivot was
                    // off-grid; this says HOW MANY guarded probes judged a
                    // placement against an unsnapped pivot, which is the
                    // quantity that grows during the ratchet this guard
                    // exists to catch. Omitted (not `0`) when never set, so
                    // "no off-grid probes" stays distinguishable from
                    // "counter unavailable".
                    (Number(lastFillGuardStats.pivotOffGrid) > 0
                        ? ` pivotOffGrid=${lastFillGuardStats.pivotOffGrid}`
                        : '') +
                    (gateGuarded > 0
                        ? ` gateChecked=${finalGateStats.checked} gatePassed=${finalGateStats.passed} ` +
                          `gateSkipped=${finalGateStats.skipped} gateBypassed=${finalGateStats.bypassed}`
                        : ''),
                    cold || (batchPivot && batchPivot.idx == null) ? 'warn' : 'info'
                );
            }
        } catch { /* summary is best-effort */ }

        // Batch-level GRID-PRICE-INVARIANT summary (rejected emissions).
        logGridPriceInvariantSummary(bot, gridPriceInvariantStats, 'COW');

        if (skippedUpdateCount > 0) {
            restoreSkippedUpdateSlotsInWorkingGrid(bot, workingGrid, skippedUpdateSlotIds as Set<string>, skippedUpdateCount);
        }

        if (clampedUpdateSlotIds.size > 0) {
            const masterVersion = Number.isFinite(Number(bot.manager?._gridVersion))
                ? Number(bot.manager._gridVersion)
                : undefined;
            for (const slotId of clampedUpdateSlotIds) {
                workingGrid.syncFromMaster(bot.manager.orders, String(slotId), masterVersion);
            }
            bot.manager.logger.log(
                `[COW] Re-synced ${clampedUpdateSlotIds.size} post-fill-clamped slot(s) from master before commit`,
                'debug'
            );
        }
        // BOUNDARY HOLD: skipped refill slots strand empty rail holes past the
        // planned boundary (commit gate skips empties, self-legalizing) — hold
        // the committed boundary; intersect-only, grid still commits.
        const refillHold = resolveRefillBoundaryHold(
            workingBoundary,
            bot.manager.boundaryIdx,
            skippedUpdateSlotIds as Iterable<string> | null | undefined,
            clampedUpdateSlotIds as Iterable<string> | null | undefined,
            cowResult?.refillSlotIds,
            skippedCreateSlotIds as Iterable<string> | null | undefined
        );
        effectiveBoundary = refillHold.effectiveBoundary as number;
        boundaryHeld = refillHold.heldRefillSlotIds.length > 0;
        if (refillHold.heldRefillSlotIds.length > 0) {
            bot.manager.logger.log(
                `[COW] Boundary hold: ${refillHold.heldRefillSlotIds.length} refill slot(s) skipped ` +
                `(${refillHold.heldRefillSlotIds.join(', ')}) — keeping ${bot.manager.boundaryIdx} over planned ${workingBoundary}`,
                'warn'
            );
        }
        // RAIL-DERIVED BOUNDARY: the committed boundary must match the rails the
        // batch actually places. A fill-driven plan built at a re-anchored
        // boundary puts counter orders on the promoted rail (SELL fill at s ->
        // counter BUY at s-gap); holding the old boundary would reclassify those
        // counters as in-band and the next plan would place sells on top of them
        // (spread collapse). Counter orders win over empty refill holes: clamp
        // to [maxBuy, minSell-gap-1]. In the pure-refill-hold case no order was
        // placed above the committed boundary, so this is a no-op.
        const railBoundary = deriveRailBoundary(
            bot.manager,
            opContexts,
            effectiveBoundary,
            (bot.manager as { _gapSlots?: unknown })?._gapSlots
        );
        if (railBoundary.boundary !== null && Number.isFinite(Number(railBoundary.boundary))) {
            const railEffective = Number(railBoundary.boundary);
            if (railEffective !== effectiveBoundary) {
                bot.manager.logger.log(
                    `[COW] Boundary rail-derived: planned ${workingBoundary}, held ${effectiveBoundary} -> ${railEffective} ` +
                    `(maxBuy=${railBoundary.maxBuyIdx ?? 'none'}, minSell=${railBoundary.minSellIdx ?? 'none'}) ` +
                    `— keeping placed counter orders on their rails`,
                    'warn'
                );
                effectiveBoundary = railEffective;
            }
        } else if (railBoundary.reason) {
            bot.manager.logger.log(
                `[COW] Boundary rail-derived: unusable (${railBoundary.reason}); keeping ${effectiveBoundary}`,
                'warn'
            );
        }
        // Commit bookkeeping follows the boundary actually committed: a plan
        // whose target equals the effective value applied its crawls even when
        // the refill hold triggered (the counters carried the shift).
        boundaryHeld = effectiveBoundary !== workingBoundary;
        // Consecutive-hold tracking (INV-COW-007 visibility): escalate a
        // growing run — the grid is trailing the market and only fresh
        // fills unstick it. Cleared automatically on the first clean batch.
        const consecutiveHolds = trackBoundaryHold(
            bot.manager,
            boundaryHeld,
            bot.manager.boundaryIdx,
            workingBoundary,
            refillHold.heldRefillSlotIds
        );
        if (consecutiveHolds >= 3) {
            bot.manager.logger.log(
                `[COW] Boundary held ${consecutiveHolds} consecutive batches ` +
                `(keeping ${bot.manager.boundaryIdx} over planned ${workingBoundary}). ` +
                `Grid is trailing the market — refills re-price once the guard pivot settles; ` +
                `heals on the next fill-driven plan. Investigate only if the run keeps growing without new fills.`,
                'warn'
            );
        }

        // Guard-aware re-center escalation (INV-COW-007 heal path): a run of
        // holds carrying fresh fills means the grid is trailing the market and
        // will not heal from fill-less replans (they re-derive the identical
        // veto). Request a structural resync that re-derives centers on the
        // live pivot; the cooldown prevents resync storms. requestStructuralGridResync
        // re-defers while this batch is still in flight, so it runs in a clean context.
        if (boundaryHeld && consecutiveHolds >= holdResyncThreshold) {
            const freshFills = Array.isArray(cowResult?.fills) && cowResult.fills.length > 0;
            const lastResyncAt = Number(bot.manager._lastBoundaryHoldResyncAt) || 0;
            if (freshFills && (Date.now() - lastResyncAt) >= holdResyncCooldownMs) {
                bot.manager._lastBoundaryHoldResyncAt = Date.now();
                bot.manager.logger.log(
                    `[COW] Boundary held ${consecutiveHolds} consecutive batches with fresh fills; ` +
                    `requesting guard-aware structural re-center (cooldown ${Math.round(holdResyncCooldownMs / 1000)}s)`,
                    'warn'
                );
                try {
                    void bot.manager.requestStructuralGridResync?.(
                        'boundary-hold-trailing-market',
                        { reason: 'boundary-hold-trailing-market' }
                    );
                } catch (err) {
                    bot.manager.logger.log(
                        `[COW] Structural re-center request failed (non-fatal): ${getErrorMessage(err)}`,
                        'warn'
                    );
                }
            }
        }

        if (operations.length === 0) {
            // Pop the working grid: in the re-plan recursion the fresh plan's
            // grid was pushed by performSafeRebalance, and nothing downstream
            // will commit it — leaving it on the stack would stick the manager
            // in REBALANCING permanently (the outer frame already popped its
            // own grid before recursing). Guarded on the push marker so plan
            // path calls (never pushed) cannot pop an unrelated entry.
            popPushedWorkingGrid(bot, cowResult);
            return { executed: false, hadRotation: false };
        }

        const validation = validateOperationFunds(bot, operations as JsonObj[], assetA, assetB);
        bot.manager.logger.log(validation.summary, validation.isValid ? 'info' : 'warn');

        if (!validation.isValid) {
            bot.manager.logger.log(`Skipping batch broadcast: ${validation.violations!.length} fund violation(s) detected`, 'warn');
            popPushedWorkingGrid(bot, cowResult);
            return { executed: false, hadRotation: false };
        }

        // Refuse stale plans BEFORE broadcasting: a master-grid change during
        // planning (fills, syncs) makes the working grid invalid. Broadcasting
        // anyway would place orders the commit will refuse to register, leaving
        // on-chain state ahead of the grid.
        // NOTE: the commit-time evaluateCommit also rejects empty deltas; here
        // (pre-broadcast) that case is already covered by the operations.length
        // guard above, so only staleness and version-mismatch are checked.
        const preBroadcastGuard = evaluateCommit(workingGrid, {
            hasLock: false,
            currentVersion: bot.manager._gridVersion
        });
        if (!preBroadcastGuard.canCommit) {
            // Bounded re-plan + proceed — policy documented on replanStaleBatch.
            const replan = await replanStaleBatch(bot, cowResult, replanDepth, preBroadcastGuard, seamPollIntervalMs);
            if (replan.handled) {
                return replan.result ?? { executed: false, hadRotation: false };
            }
            // Fall through: proceed with the current plan (bounded policy).
        }
        // True when the plan was still valid against the master at this point.
        // Only then can a later version change be attributed to the in-flight
        // broadcast we are about to wait on (see the post-wait recheck). If the
        // re-plan above already ran and fell through, re-raising the same
        // staleness after the wait would double the structural-resync request
        // for one event.
        const preBroadcastWasFresh = preBroadcastGuard.canCommit;

        // Single-flight broadcast slot (authoritative, atomic check-and-set):
        // by this point this batch finished planning; any other batch that
        // started planning concurrently and beat us here holds the slot. Wait
        // for it to settle, then claim the slot synchronously (no await
        // between the check inside waitForCowBroadcastSingleFlight and the
        // assignment below), so two batches can never broadcast together.
        if (await waitForCowBroadcastSingleFlight(bot, 'pre-broadcast')) {
            popPushedWorkingGrid(bot, cowResult);
            return { executed: false, aborted: true, reason: 'SHUTDOWN_IN_PROGRESS', hadRotation: false };
        }
        bot._cowBroadcastInFlight = true;
        heldBroadcastSlot = true;

        // Re-validate the plan AFTER winning the broadcast slot, but only when
        // the plan was fresh before the wait. The version check above ran BEFORE
        // the single-flight wait, so it cannot see a master-grid advance
        // committed by the batch that just held the slot. Broadcasting such a
        // plan places rails the winner already placed (the commit-time guard
        // refuses the commit, but the duplicate orders are already on-chain and
        // must be cancelled). The 2026-09-25 restart produced exactly this: two
        // 4-op CREATEs of slots 203/204/205 landed ~2.4s apart, then three
        // duplicate orders had to be cancelled. Re-plan from the fresh master
        // instead. Release the slot first so the re-plan recursion (which uses
        // skipBroadcastWait) does not wait on a flag this frame still holds.
        if (preBroadcastWasFresh) {
            const postWaitGuard = evaluateCommit(workingGrid, {
                hasLock: false,
                currentVersion: bot.manager._gridVersion
            });
            if (!postWaitGuard.canCommit) {
                bot.manager.logger.log(
                    `[COW] Plan went stale while waiting for an in-flight broadcast ` +
                    `(${postWaitGuard.reason}); releasing the broadcast slot and re-planning from fresh master`,
                    'warn'
                );
                bot._cowBroadcastInFlight = false;
                heldBroadcastSlot = false;
                const replan = await replanStaleBatch(bot, cowResult, replanDepth, postWaitGuard, seamPollIntervalMs);
                if (replan.handled) {
                    return replan.result ?? { executed: false, hadRotation: false };
                }
                // No fill context for a re-plan (or the re-plan limit was
                // reached). The stale policy proceeds with the original plan, so
                // re-claim the broadcast slot before shipping it.
                if (await waitForCowBroadcastSingleFlight(bot, 'post-stale-replan')) {
                    popPushedWorkingGrid(bot, cowResult);
                    return { executed: false, aborted: true, reason: 'SHUTDOWN_IN_PROGRESS', hadRotation: false };
                }
                bot._cowBroadcastInFlight = true;
                heldBroadcastSlot = true;
            }
        }

        await bot._ensureCredentialDaemonWritable('COW batch broadcast');

        bot.manager.logger.log(`[COW] Broadcasting batch with ${operations.length} operations...`, 'info');
        bot._lastBroadcastHeartbeatAt = Date.now();
        const execution = await executeChunkedWithRetryOnUncertain(bot, operations, opContexts);
        const result = execution.result as JsonObj;
        const executedContexts = execution.opContexts;

        bot.manager.pauseFundRecalc();
        try {
            bot.manager._throwOnIllegalState = true;
            
            if (result.success) {
                const preCommitResults = extractOperationResults(result, 'pre-commit-integrity', bot.manager?.logger?.log?.bind(bot.manager?.logger));
                const missingCreateResults = findMissingCreateResultContexts(preCommitResults, executedContexts);
                if (missingCreateResults.length > 0) {
                    const missingSlots = missingCreateResults
                        .map((item) => item.ctx?.order?.id || item.ctx?.id || `op-${item.index}`)
                        .join(', ');
                    bot.manager.logger.log(
                        `[COW] ${missingCreateResults.length} CREATE op(s) returned no chainOrderId ` +
                        `(${missingSlots}). Resolving from chain before commit (normalize, don't reject).`,
                        'warn'
                    );
                    // Layer 2 (normalize, don't reject + uncertain-broadcast routing):
                    // the batch otherwise succeeded, so a missing id is the
                    // "broadcast succeeded but attach lost" ambiguous case. Poll the
                    // chain to separate REAL on-chain orders (adopt their id into the
                    // working grid so they commit normally) from PHANTOMS (normalize the
                    // slot in place to a clean empty). Either way the REST of the batch
                    // commits — we never discard a whole batch over one missing id.
                    const confirmation = await pollChainForConfirmation(
                        bot,
                        missingCreateResults.map((m) => m.ctx)
                    );
                    const accountRef = bot.accountId || (bot.account as unknown as { id?: string } | null)?.id || bot.account;
                    let chainSnap: ChainOrderLike[] | null = null;
                    try {
                        const cr = await readOpenOrdersWithMetaSafe(chainOrders, accountRef);
                        if (cr && !cr.truncated) chainSnap = cr.orders;
                    } catch { /* best-effort; confirmed set already known from poll */ }

                    let adoptedCount = 0;
                    let normalizedCount = 0;
                    for (const item of missingCreateResults) {
                        const slotId = String(item.ctx?.order?.id ?? item.ctx?.id ?? '');
                        const slot = workingGrid.get(slotId);
                        if (!slot) continue;
                        const isConfirmed = confirmation.confirmed.some(
                            (c) => (c?.order?.id || c?.id) === slotId
                        );
                        if (isConfirmed && chainSnap) {
                            const match = findChainOrderForSlot(bot, chainSnap, String(slotId), {
                                sell: (item.ctx?.finalInts as FinalInts | undefined)?.sell,
                                receive: (item.ctx?.finalInts as FinalInts | undefined)?.receive,
                                orderType: item.ctx?.order?.type,
                                fingerprint: createOpFingerprintForSlot(bot, item.ctx?.order as ManagedOrder, item.ctx?.finalInts as FinalInts, String(slotId))
                            });
                            if (match?.id) {
                                workingGrid.set(slotId, { ...slot, orderId: match.id });
                                adoptedCount++;
                                continue;
                            }
                        }
                        // Normalize: drop the size so the slot cannot persist as a
                        // phantom placed order (VIRTUAL + size>0 + no orderId) — the
                        // exact corrupt shape that recurs as a sized orphan. It commits
                        // as a clean empty and is re-placed by the next cycle / spread
                        // correction.
                        workingGrid.set(slotId, {
                            ...slot,
                            size: 0,
                            orderId: null,
                            state: ORDER_STATES.VIRTUAL
                        });
                        normalizedCount++;
                    }
                    bot.manager.logger.log(
                        `[COW] Missing CREATEs resolved: ${adoptedCount} adopted from chain, ` +
                        `${normalizedCount} normalized in place; committing remainder of batch.`,
                        'warn'
                    );
                    // NOTE: we intentionally do NOT mark these as structural blockers.
                    // Normalizing the slot to a clean empty lets the next cycle re-create
                    // it, and the regular open-orders sync adopts any order that really
                    // did land on chain — so a permanent block (which would reject every
                    // subsequent CREATE batch) is avoided.
                    // DO NOT pop/discard the working grid — fall through to commit the
                    // rest of the batch below.
                }

                // Pre-apply rotation state transitions to the working grid so the
                // COW commit is truly atomic for structural changes (source → VIRTUAL,
                // dest → ACTIVE with orderId). Remaining post-commit patches in
                // processBatchResults are limited to rawOnChain metadata enrichment
                // that depends on broadcast result data.
                applyRotationTransitionsToWorkingGrid(bot, workingGrid, executedContexts);

                bot.manager.logger.log('[COW] Blockchain success - committing working grid to master', 'info');
                // _commitWorkingGrid releases the stack entry on every settle
                // path (return or throw) and clears the push marker via
                // options.result, so a later throw in this frame (e.g.
                // processBatchResults after a successful commit) cannot pop a
                // second time for the same grid in the batch catch below.
                const commitOk: boolean = await bot.manager._commitWorkingGrid(
                    workingGrid,
                    workingIndexes,
                    effectiveBoundary,
                    {
                        skipRecalc: true,
                        result: cowResult,
                        boundaryHeld,
                        consumedCrawlIds: cowResult?.consumedCrawlIds
                    }
                );
                if (!commitOk) {
                    // Master changed during broadcast (e.g. a fill landed and was
                    // processed concurrently) so the commit was refused. The batch
                    // is on chain; adopt the placed orders from the chain so master
                    // converges instead of remaining divergent until a later sync.
                    return await recoverRefusedCommit(
                        bot, chainOrders, '[COW]',
                        { placedResults: result, placedContexts: executedContexts },
                        executedContexts, effectiveBoundary,
                        {
                            failureResyncReason: 'commit refused after broadcast (chain adoption unavailable)',
                            failureLogMessage: 'Commit refused and chain adoption unavailable; keeping pending-broadcast protection pending structural resync',
                            preAdoptLogMessage: 'Commit refused after broadcast; adopting placed orders from chain to keep master in sync',
                        }
                    );
                }
                
                const batchResult = await processBatchResults(bot, result, executedContexts);

                // A `suspended` persist result is a deliberate, temporary gate
                // (credential-daemon outage), NOT a corrupt/ahead state: the
                // in-memory master stays authoritative and the dirty-flush
                // pipeline persists it once suspension lifts. Treat it as a
                // deferral — never as a structural-resync trigger.
                const isSuspendedPersist = (r: unknown): boolean => {
                    const v = r as { skipped?: unknown; suspended?: unknown } | null | undefined;
                    return Boolean(v && v.skipped && v.suspended === true);
                };
                const persistResult = await bot.manager.persistGrid();
                if (persistResult && (persistResult.skipped || persistResult.isValid === false)) {
                    bot.manager.logger.log(
                        `[COW][PERSIST-GUARD] First persist attempt was ` +
                        `${persistResult.skipped ? 'skipped' : 'invalid'} ` +
                        `(${persistResult.reason || 'no reason'}); retrying once before ` +
                        `clearing working grid reference.`,
                        'warn'
                    );
                    bot.manager._persistenceWarning = persistResult;
                    const retryResult = await bot.manager.persistGrid();
                    if (isSuspendedPersist(retryResult)) {
                        bot.manager.logger.log(
                            `[COW][PERSIST-GUARD] Grid persistence is suspended ` +
                            `(${(retryResult as { reason?: string }).reason || 'no reason'}); deferring disk flush until it resumes.`,
                            'warn'
                        );
                        // The committed grid is not on disk yet. Mark it dirty so
                        // the end-of-tick flushGridDirty safety net retries it at
                        // the next end-of-tick flush after the suspension lifts,
                        // instead of relying on the next COW/recovery persist to
                        // converge disk.
                        try { bot.manager._markGridDirty?.(); } catch { /* best-effort */ }
                        delete bot.manager._persistenceWarning;
                    } else if (retryResult && (retryResult.skipped || retryResult.isValid === false)) {
                        bot.manager.logger.log(
                            `[COW][PERSIST-GUARD] Retry also skipped/invalid ` +
                            `(${retryResult.reason || 'no reason'}). Master grid in memory ` +
                            `is ahead of disk snapshot; structural resync requested.`,
                            'error'
                        );
                        await requestStructuralResync(
                            bot,
                            'persistence guard triggered after COW batch',
                            { persistReason: retryResult.reason || 'unknown' }
                        );
                    } else {
                        delete bot.manager._persistenceWarning;
                    }
                } else if (bot.manager._persistenceWarning) {
                    delete bot.manager._persistenceWarning;
                }

                bot._metrics.batchesExecuted++;
                clearPendingBroadcasts(bot.manager?._pendingBroadcasts);

                return { ...batchResult, executed: true, hadRotation: true };
            } else {
                bot.manager.logger.log('[COW] Blockchain failed - working grid discarded, master unchanged', 'warn');
                popPushedWorkingGrid(bot, cowResult);
                clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
                return { ...result, executed: false, hadRotation: false };
            }
        } finally {
            bot.manager._throwOnIllegalState = false;
            await bot.manager.resumeFundRecalc();
            bot.manager.stopBroadcasting();
            const createCount = actions.filter((a: { type?: unknown }) => a.type === COW_ACTIONS.CREATE).length;
            const cancelCount = actions.filter((a: { type?: unknown }) => a.type === COW_ACTIONS.CANCEL).length;
            bot.manager.logger.logFundsStatus(bot.manager, `AFTER COW batch (created=${createCount}, cancelled=${cancelCount})`);
        }

    } catch (err) {
        bot.manager.logger.log(`[COW] Batch transaction failed: ${getErrorMessage(err)}`, 'error');
        if (getErrorField<boolean>(err, 'partialOnChainState')) {
            bot.manager.logger.log(
                `[COW] Non-atomic grouped execution detected (${formatPartialBroadcastSummary(err)}). Local rollback cannot undo confirmed on-chain operations; next sync/reconcile will converge state.`,
                'warn'
            );
        }
        bot.manager.stopBroadcasting();

        // Chain polling: for uncertain broadcasts (not partial), try to confirm
        // CREATE operations on chain before clearing the working grid. If all
        // planned CREATEs are confirmed, the entire batch was accepted atomically
        // and we can commit the working grid directly, bypassing the expensive
        // reconciliation state machine. This handles the ~90% case where the
        // chain accepted the transaction but the response was lost.
        if (err instanceof BroadcastUncertainError && getErrorField<boolean>(err, 'partialOnChainState') !== true) {
            try {
                const confirmation = await pollChainForConfirmation(bot, opContexts);
                if (confirmation.allConfirmed) {
                    // pollChainForConfirmation only verifies CREATE ops (see its doc).
                    // If the batch had non-CREATE ops (UPDATEs/CANCELs), they are NOT
                    // confirmed here — we assume atomic batch acceptance.  Log the
                    // composition so a misbehaving partial-broadcast (partialOnChainState
                    // incorrectly false) leaves a forensic trace.
                    const createCount = confirmation.confirmed.length;
                    const totalOps = opContexts.length;
                    if (createCount < totalOps) {
                        bot.manager.logger.log(
                            `[COW][UNCERTAIN] Chain polling confirmed ${createCount}/${totalOps} CREATEs on chain ` +
                            `(${totalOps - createCount} non-CREATE ops assumed confirmed via atomic batch). ` +
                            `Committing working grid.`,
                            'info'
                        );
                    } else {
                        bot.manager.logger.log(
                            `[COW][UNCERTAIN] Chain polling confirmed all ${createCount} CREATE(s) on chain. Committing working grid directly.`,
                            'info'
                        );
                    }
                    applyRotationTransitionsToWorkingGrid(bot, workingGrid, opContexts);
                    // Same exactly-once discipline as the success path:
                    // _commitWorkingGrid pops on every settle path and clears
                    // the push marker via options.result, so a later throw here
                    // must not pop again in the batch catch below.
                    const pollCommitOk: boolean = await bot.manager._commitWorkingGrid(
                        workingGrid,
                        workingIndexes,
                        effectiveBoundary,
                        {
                            skipRecalc: true,
                            result: cowResult,
                            boundaryHeld,
                            consumedCrawlIds: cowResult?.consumedCrawlIds
                        }
                    );
                    if (!pollCommitOk) {
                        // Master moved while polling — same recovery as the
                        // refused-commit path: adopt from chain, keep pending
                        // protection if adoption is unavailable.
                        return await recoverRefusedCommit(
                            bot, chainOrders, '[COW][UNCERTAIN]',
                            { placedContexts: opContexts, polledCreateIds: confirmation.confirmedChainIds },
                            opContexts, effectiveBoundary,
                            {
                                successReturn: { executed: false, hadRotation: false, commitRefused: true, uncertainResolved: true },
                                failureResyncReason: 'poll-confirmed commit refused (chain adoption unavailable)',
                                failureLogMessage: 'Poll-refused commit with unavailable chain adoption; keeping pending protection pending structural resync',
                                preAdoptLogMessage: 'Poll-confirmed commit refused; adopting placed orders from chain',
                            }
                        );
                    }
                    // Enrich master grid with chain-assigned order IDs and amounts;
                    // accounting enabled so the adopted orders' capital is locked
                    // and any cancelled orders release theirs. The adoption result
                    // is authoritative: a truncated read right after the confirming
                    // poll can omit the batch's own fresh creates (they sort last
                    // in the by_account index), so clearing the pending protection
                    // on a failed adoption would let the next cycle re-create the
                    // VIRTUAL slots as duplicate on-chain orders. Keep the
                    // protection and defer to a structural resync instead.
                    // The commit happened without processBatchResults (no success
                    // result to extract); deduct create fees so the optimistic
                    // balance reflects the on-chain cost (shared with the
                    // refused-commit paths via recoverRefusedCommit).
                    return await recoverRefusedCommit(
                        bot, chainOrders, '[COW][UNCERTAIN]',
                        { placedContexts: opContexts, polledCreateIds: confirmation.confirmedChainIds },
                        opContexts, effectiveBoundary,
                        {
                            // Poll-confirmed SUCCESS: the commit was accepted;
                            // this funnel is only reused for chain adoption +
                            // fee deduction, so it must not count as a refusal.
                            refusedCommit: false,
                            extraReturn: { commitRefused: false },
                            successReturn: { executed: true, hadRotation: false, uncertainResolved: true },
                            failureResyncReason: 'poll-confirmed commit (chain adoption unavailable)',
                            failureLogMessage: 'Poll-confirmed commit with unavailable chain adoption; keeping pending protection pending structural resync',
                        }
                    );
                }
            } catch (pollErr) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Chain polling threw unexpectedly: ${getErrorMessage(pollErr)}. Falling back to reconciliation.`,
                    'error'
                );
            }
        }

        popPushedWorkingGrid(bot, cowResult);

        if (err instanceof BroadcastUncertainError) {
            return await reconcileAfterUncertainBroadcast(bot, err, opContexts);
        }

        const hardAbortResult = await bot._handleBatchHardAbort(err, 'COW batch processing', operations.length);
        if (hardAbortResult) return hardAbortResult as JsonObj;

        const staleOrderIds = new Set();
        const patterns = [
            /Limit order (1\.7\.\d+) does not exist/g,
            /Unable to find Object (1\.7\.\d+)/g,
            /object (1\.7\.\d+) (?:does not exist|not found)/gi
        ];
        for (const pattern of patterns) {
            let m;
            while ((m = pattern.exec(getErrorMessage(err))) !== null) {
                staleOrderIds.add(m[1]);
            }
        }

        if (/Cannot deduct all or more from order than order contains/.test(getErrorMessage(err))) {
            return await bot._recoverBatchSizeDrift(err, opContexts) as JsonObj;
        }

        if (staleOrderIds.size > 0) {
            return await bot._recoverExplicitStaleOrders(staleOrderIds, 'cow-stale-order-cleanup') as JsonObj;
        }

        throw err;
    } finally {
        bot._batchInFlight--;
        if (heldBroadcastSlot) bot._cowBroadcastInFlight = false;
        bot._markGridActivity('batch end');
        bot.manager.unlockOrders(idsToLock);

        if (!bot._shuttingDown && bot._incomingFillQueue.length > 0) {
            bot._scheduleFillConsumerRestart(chainOrders);
        }
    }
}

/**
 * Request a structural grid resync with the recovery-state flag raised, so a
 * later plan cannot duplicate orders placed by a batch whose chain adoption is
 * pending. No-op when the manager has no structural-resync handler.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} reason - Human-readable resync reason
 * @param {Object} [details={}] - Details passed to the resync handler
 */
async function requestStructuralResync(bot: BotLike, reason: string, details: JsonObj = {}) {
    if (typeof bot.manager?.requestStructuralGridResync !== 'function') {
        bot._warn?.(`[COW] requestStructuralGridResync unavailable; cannot schedule structural resync (reason: ${reason}).`);
        return;
    }
    if (bot.manager._recoveryState) {
        bot.manager._recoveryState = { ...bot.manager._recoveryState, structuralResyncRequested: true };
    }
    await bot.manager.requestStructuralGridResync(reason, details);
}

/**
 * Adopt a batch's placed orders from the chain after the commit was refused
 * or after a poll-confirmed uncertain commit. The batch ops are already on
 * chain but never reached master, so a full chain sync with accounting
 * enabled locks the placed orders' capital and releases any cancelled ones.
 * Returns true when the adoption sync ran; false when the chain state could
 * not be read (empty/lagging read, truncated read, or sync failure) — the
 * caller then keeps the pending-broadcast protection and defers adoption to
 * a structural resync.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module
 * @param {string} logPrefix - Log prefix for sync failure messages
 * @returns {Promise<boolean>}
 */
/**
 * Converge master with the chain after a COW commit was refused (master moved
 * during broadcast) or an uncertain broadcast was poll-confirmed.
 *
 * Preferred path (when the broadcast result is available): re-read the exact
 * on-chain orders BY ID — every id master already tracks plus the batch's
 * fresh CREATE ids. get_objects returns the complete, authoritative set
 * regardless of account size, so syncFromOpenOrders converges master instead
 * of dropping the freshest creates (which previously left permanent orphans
 * and tripped the fund invariant). This is fully immune to the
 * get_full_accounts window truncation that broke the old window-read path.
 *
 * Fallback (no broadcast result, e.g. uncertain paths, or by-id read
 * unavailable): window read. A truncated read is ambiguous — only the
 * freshest orders are dropped — so it MUST NOT drive adoption; we return false
 * and let the caller keep pending-broadcast protection + structural resync.
 *
 * @param {unknown} bot
 * @param {unknown} chainOrders - chain_orders module (has readOpenOrdersWithMetaSafe + batchReadOrders)
 * @param {string} logPrefix
 * @param {Object} [opts]
 * @param {unknown} [opts.placedResults] - broadcast result carrying operation_results
 * @param {unknown[]} [opts.placedContexts] - opContexts aligned with operation_results
 * @param {string[]} [opts.polledCreateIds] - fresh CREATE chain ids confirmed by
 *   the uncertain-broadcast poll (no broadcast result exists on that path);
 *   routes the poll call sites through the by-id path with its lagging-create
 *   retry instead of the unguarded window fallback
 * @returns {Promise<boolean>} true if master was adopted from the chain
 */
/**
 * P1-atomic: after a refused/uncertain COW commit is recovered by adopting the
 * placed orders from the chain, re-apply the rotational boundary this batch had
 * already computed (workingBoundary) to master. The refused commit discarded
 * the working grid, so without this the next rebalance would re-derive the
 * boundary from a master that still reflects the pre-fill layout and could
 * re-stamp the just-filled slot x. Applying workingBoundary commits the
 * post-fill rotation immediately (no re-broadcast), so the next placement lands
 * at the shifted slot, never at x.
 *
 * @param {unknown} bot
 * @param {number} workingBoundary - boundary index the refused batch targeted
 */
async function restoreBoundaryAfterAdoption(bot: BotLike, workingBoundary: number): Promise<void> {
    try {
        if (workingBoundary === undefined || workingBoundary === null) return;
        if (typeof bot.manager._restoreBoundary === 'function') {
            bot.manager._restoreBoundary(workingBoundary);
        } else {
            bot.manager.boundaryIdx = workingBoundary;
        }
        bot.manager.logger.log(
            `[COW] Restored rotational boundary ${workingBoundary} after refused/uncertain commit + chain adoption (atomic re-plan)`,
            'info'
        );
    } catch (e) {
        bot.manager.logger.log(`[COW] Post-adoption boundary restore failed: ${getErrorMessage(e)}`, 'warn');
    }
}

async function adoptPlacedBatchFromChain(bot: BotLike, chainOrders: typeof chainOrdersModule, logPrefix: string, opts: JsonObj = {}): Promise<boolean> {
    const { placedResults = null, placedContexts = null, polledCreateIds = null } = opts || {};
    try {
        const mgr = bot.manager;
        const accountRef = bot.accountId || (bot.account as unknown as { id?: string } | null)?.id || bot.account;

        // PREFERRED: re-read the exact placed/existing orders by id. The by-id
        // set needs the broadcast result (freshest CREATE ids), the
        // poll-confirmed CREATE ids, or at minimum the contexts referencing
        // existing chain orders — without any id hints the set would be
        // incomplete and would wrongly sync master against a partial picture.
        const haveIdHints = Boolean(placedResults)
            || (Array.isArray(placedContexts) && placedContexts.length > 0)
            || (Array.isArray(polledCreateIds) && polledCreateIds.length > 0);
        const { all: knownIds, createIds } = haveIdHints
            ? collectKnownOnChainOrderIds(mgr, placedResults, placedContexts as Parameters<typeof collectKnownOnChainOrderIds>[2], polledCreateIds as string[] | null | undefined)
            : { all: [], createIds: [] as string[] };
        if (knownIds.length > 0 && typeof chainOrders.batchReadOrders === 'function') {
            // Retry/backoff (fix #6): a fresh CREATE absent from the first read
            // is a lagging node, not a missing order; a read error is equally
            // transient. Retry with backoff before deferring to the structural
            // resync path — deferral blocks CREATEs for minutes.
            const maxAttempts = Math.max(1, Number(COW_PERFORMANCE.ADOPTION_READ_MAX_ATTEMPTS) || 3);
            const baseBackoff = Math.max(250, Number(COW_PERFORMANCE.ADOPTION_READ_BACKOFF_MS) || 2000);
            let chainMap: Map<string, ChainOrderLike> | null = null;
            let laggingCreateIds: string[] = [];
            let lastReadError: string | null = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                chainMap = null;
                laggingCreateIds = [];
                lastReadError = null;
                try {
                    chainMap = await chainOrders.batchReadOrders(knownIds);
                } catch (byIdErr) {
                    // A by-id read failure must NOT fall through to the window read
                    // (which would also miss the freshest creates and virtualize them).
                    lastReadError = getErrorMessage(byIdErr);
                }
                if (chainMap) {
                    // Lagging-node guard (phantom-virtualization risk): a FRESHLY
                    // BROADCAST create id returning null here almost certainly means the
                    // queried node has not yet indexed the order (it was just placed), not
                    // that it is gone. If we synced a partial set, syncFromOpenOrders'
                    // phantom-cleanup would virtualize that live order and count it as a
                    // fill, re-creating a duplicate on the next cycle — the exact orphan
                    // class this path exists to prevent.
                    for (const id of createIds) {
                        if (chainMap.get(id) == null) laggingCreateIds.push(id);
                    }
                }
                if (chainMap && laggingCreateIds.length === 0) break;
                if (attempt < maxAttempts) {
                    const wait = baseBackoff * Math.pow(2, attempt - 1);
                    bot.manager.logger.log(
                        `${logPrefix} By-id adoption read retry ${attempt}/${maxAttempts - 1} in ${wait}ms ` +
                        `(${chainMap ? `fresh CREATE(s) absent: ${laggingCreateIds.join(', ')}` : `read failed: ${lastReadError}`})`,
                        'warn'
                    );
                    await sleep(wait);
                }
            }
            if (!chainMap) {
                bot.manager.logger.log(
                    `${logPrefix} By-id adoption read failed after ${maxAttempts} attempt(s): ${lastReadError}; deferring (pending-broadcast protection kept)`,
                    'warn'
                );
                return false;
            }
            if (laggingCreateIds.length > 0) {
                bot.manager.logger.log(
                    `${logPrefix} By-id adoption deferred: fresh CREATE(s) ${laggingCreateIds.join(', ')} absent from ` +
                    `${maxAttempts} chain read(s) (likely lagging node). ` +
                    'Keeping pending-broadcast protection pending a caught-up read.',
                    'error'
                );
                return false;
            }

            const fullChain: ChainOrderLike[] = [];
            if (chainMap && typeof chainMap.forEach === 'function') {
                chainMap.forEach((order) => { if (order) fullChain.push(order); });
            } else if (Array.isArray(chainMap)) {
                for (const o of chainMap as unknown as ChainOrderLike[]) if (o) fullChain.push(o);
            }
            // Informational: any other known id (master's pre-existing orders)
            // absent is expected — those were cancelled/filled in this batch.
            if (fullChain.length < knownIds.length) {
                bot.manager.logger.log(
                    `${logPrefix} By-id adoption: ${knownIds.length - fullChain.length}/${knownIds.length} known id(s) absent ` +
                    '(expected cancels/fills); adopting the rest',
                    'debug'
                );
            }
            if (fullChain.length > 0 && typeof mgr.syncFromOpenOrders === 'function') {
                await mgr.syncFromOpenOrders(fullChain, { skipAccounting: false });
                bot.manager.logger.log(
                    `${logPrefix} Adopted ${fullChain.length} on-chain order(s) by id after refused/uncertain commit (truncation-immune)`,
                    'info'
                );
                return true;
            }
        }

        // FALLBACK: window read (ambiguous when truncated).
        const freshRead = await readOpenOrdersWithMetaSafe(chainOrders, accountRef as string | null | undefined);
        if (!isAuthoritativeChainRead(freshRead)) {
            bot.manager.logger.log(
                `${logPrefix} Chain read ${freshRead?.truncated ? 'TRUNCATED' : 'EMPTY'} after batch broadcast; adoption deferred (pending-broadcast protection kept)`,
                'warn'
            );
            return false;
        }
        const freshChain = freshRead.orders;
        if (freshChain.length > 0 && typeof bot.manager.syncFromOpenOrders === 'function') {
            await bot.manager.syncFromOpenOrders(freshChain, { skipAccounting: false });
            return true;
        }
    } catch (syncErr) {
        bot.manager.logger.log(
            `${logPrefix} Chain sync after batch broadcast failed: ${getErrorMessage(syncErr)}`,
            'error'
        );
    }
    return false;
}

/**
 * Persist the master grid after a chain adoption and clear the pending
 * broadcast protection. Persist failures are logged, not thrown — the
 * in-memory master is authoritative and the next sync/persist converges disk.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {string} logPrefix - Log prefix for persist failure messages
 */
async function persistGridAndClearPendingBroadcasts(bot: BotLike, logPrefix: string) {
    try {
        await bot.manager.persistGrid();
    } catch (persistErr) {
        bot.manager.logger.log(
            `${logPrefix} Persist after chain adoption failed: ${getErrorMessage(persistErr)}`,
            'error'
        );
    }
    clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
}

/**
 * Recover from a refused commit after a COW batch broadcast.
 * Adopts placed orders from the chain, applies fee accounting, restores
 * the boundary, and persists. All three commit-refused paths
 * (success-path refused, poll-refused, and poll-confirmed uncertain)
 * share this exact sequence.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module
 * @param {string} logPrefix - Log prefix for messages
 * @param {Object} adoptOpts - Options passed to adoptPlacedBatchFromChain
 * @param {Array} contexts - Op contexts for fee accounting
 * @param {Object} workingBoundary - The working boundary
 * @param {Object} [opts={}] - Named options (object form: adjacent string
 *   options were positional before, a transposition would compile silently).
 * @param {Object} [opts.extraReturn={}] - Extra fields merged into the failure return object
 * @param {Object|null} [opts.successReturn=null] - Return object on successful adoption
 *   (defaults to the commit-refused shape; the poll-confirmed path passes its
 *   executed:true shape)
 * @param {string} [opts.failureResyncReason='commit refused after broadcast (chain adoption unavailable)']
 * @param {string} [opts.failureLogMessage='Commit refused and chain adoption unavailable; keeping pending-broadcast protection pending structural resync']
 *   - Failure-path log body (prefixed with logPrefix); each call site passes
 *   its original wording so log greps keep matching.
 * @param {string|null} [opts.preAdoptLogMessage=null] - Optional warn logged before
 *   the adoption attempt (the success-path and poll-refused sites log one;
 *   the poll-confirmed site never did)
 * @returns {Promise<Object>} The commit-refused return object
 */
async function recoverRefusedCommit(bot: BotLike, chainOrders: typeof chainOrdersModule, logPrefix: string, adoptOpts: JsonObj, contexts: OpPhase[], workingBoundary: number, opts: JsonObj = {}): Promise<JsonObj> {
    // P2 observability: count genuine commit refusals at this single funnel (so
    // the three call sites cannot double-count). This function is ALSO the
    // shared funnel for the poll-confirmed SUCCESS path (chain adoption + fee
    // deduction), which passes `refusedCommit: false` because the commit was
    // accepted — counting it would overstate the refusal signal. Never gates
    // behavior.
    try {
        if (opts.refusedCommit !== false && bot._metrics) {
            bot._metrics.refusedCommitCount = (bot._metrics.refusedCommitCount || 0) + 1;
        }
    } catch { /* metrics are best-effort */ }
    const extraReturn = (opts.extraReturn ?? {}) as JsonObj;
    const successReturn = opts.successReturn as JsonObj | null | undefined;
    const failureResyncReason = (opts.failureResyncReason ?? 'commit refused after broadcast (chain adoption unavailable)') as string;
    const failureLogMessage = (opts.failureLogMessage ?? 'Commit refused and chain adoption unavailable; keeping pending-broadcast protection pending structural resync') as string;
    const preAdoptLogMessage = opts.preAdoptLogMessage as string | null | undefined;
    if (preAdoptLogMessage) {
        bot.manager.logger.log(`${logPrefix} ${preAdoptLogMessage}`, 'warn');
    }
    const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, logPrefix, adoptOpts);
    if (!adopted) {
        bot.manager.logger.log(
            `${logPrefix} ${failureLogMessage}`,
            'error'
        );
        await requestStructuralResync(
            bot,
            failureResyncReason,
            { reason: 'chain-adoption-unavailable' }
        );
        return { executed: false, hadRotation: false, commitRefused: true, chainAdoptionPending: true, ...extraReturn };
    }
    await applyAdoptionFeeAccounting(bot, contexts);
    await restoreBoundaryAfterAdoption(bot, workingBoundary);
    await persistGridAndClearPendingBroadcasts(bot, logPrefix);
    return successReturn ?? { executed: false, hadRotation: false, commitRefused: true, ...extraReturn };
}

/**
 * Resolve the LAST-FILL guard pivot to an ON-GRID price.
 *
 * The pivot was a raw fill price, and nothing validated it. That made it a
 * ratchet input: any bad pivot (a corrupt fill price, an adopted off-grid
 * order) shifted every subsequent threshold, so an off-market buy could read
 * as legitimate. A price is only meaningful relative to the ladder it trades
 * on, so the pivot is converted to its nearest slot index and back to that
 * slot's genesis price: the result is by construction a real grid level and
 * cannot drift off the ladder.
 *
 * Falls back to the raw price when genesis is unavailable (pre-genesis
 * startup), so the guard degrades to its previous behaviour rather than
 * silently disabling. Never throws.
 *
 * @param {unknown} manager
 * @param {number|null|undefined} rawPrice
 * @returns {{price: number|null, snapped: boolean, idx: number|null, nearestDrift: number|null}}
 */
function resolveOnGridPivot(manager: OrderManagerLike, rawPrice: unknown): { price: number|null; snapped: boolean; idx: number|null; nearestDrift: number|null } {
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) return { price: null, snapped: false, idx: null, nearestDrift: null };
    try {
        const genesis = manager?._genesis as Parameters<typeof math.slotIndexForPrice>[1] | null | undefined;
        const levels = genesis?.priceLevels;
        if (!genesis || !Array.isArray(levels) || levels.length === 0) return { price, snapped: false, idx: null, nearestDrift: null };
        const idx = math.slotIndexForPrice(price, genesis);
        if (!Number.isFinite(idx)) return { price, snapped: false, idx: null, nearestDrift: null };
        // Only accept a genuine ladder level and only a nearest match. A price
        // that is wildly off-ladder (an adopted orphan far outside the grid)
        // must NOT be silently rewritten onto an edge slot -- that would make a
        // bad pivot look like a legitimate grid fill. Leave it snapped=false and
        // let the caller decide.
        const candidate = Number(math.priceForSlot(idx, genesis));
        if (!Number.isFinite(candidate) || candidate <= 0) return { price, snapped: false, idx: null, nearestDrift: null };
        // Reject a snap that moves the pivot by more than one increment: any
        // in-grid fill is within half an increment of its slot price, so a
        // larger move means the pivot itself is not a real fill price.
        const drift = Math.abs(candidate - price) / price;
        // resolveLastFillGuardIncrement takes a BOT-shaped argument and reads
        // `bot.manager.config` first. resolveOnGridPivot only ever has the
        // manager (no bot in scope), so wrap it to satisfy that contract.
        // Passing the manager directly would silently skip its own tuning and
        // fall through to DEFAULT_CONFIG, making the snap tolerance wrong for
        // any grid not built on the default increment.
        const increment = resolveLastFillGuardIncrement({ manager }) / 100;
        const maxDrift = Number.isFinite(increment) && increment > 0 ? increment : 0.005;
        // nearestDrift is reported even when the snap is refused, so a caller
        // can tell a near-miss (rounding, one increment out) from a price that
        // is nowhere near the ladder (a genuinely corrupt pivot).
        if (drift > maxDrift) return { price, snapped: false, idx: null, nearestDrift: drift };
        return { price: candidate, snapped: drift > 0, idx, nearestDrift: drift };
    } catch { return { price, snapped: false, idx: null, nearestDrift: null }; }
}

/**
 * Warn (once per batch) when a generic CREATE is emitted on the ADVERSE side of
 * the crossing floor — the guard the spread-correction planner applies through
 * `doesNotCrossMarket`.
 *
 * Non-blocking by design (see the call site): a crossing limit order executes at
 * the BEST available price, so the risk is taker fees and unintended immediate
 * execution, not a worse price. Blocking here would re-open the counter-order
 * deadlock — after a gap the counter lands on the better side by construction,
 * and a gapped market can put the planned level on the other side of the floor,
 * where waiting for the market to return is worse than taking it.
 *
 * The floor is a pure read of already-cached evidence (a fresh live market read
 * wins over the fill reference by recency), so this costs no chain call.
 *
 * @param {Object} bot
 * @param {unknown} price - Emitted CREATE price
 * @param {unknown} type - ORDER_TYPES.BUY/SELL
 * @param {unknown} slotId - Slot the CREATE targets (log context)
 * @returns {boolean} True when a warning was emitted (caller stops re-checking this batch)
 */
function warnCrossingCreate(bot: BotLike, price: unknown, type: unknown, slotId: unknown): boolean {
    if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) return false;
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return false;
    let floor: number | null = null;
    try { floor = resolveSpreadCrossingFloor(bot.manager); } catch { floor = null; }
    if (floor == null || !Number.isFinite(floor) || floor <= 0) return false;
    const crossing = type === ORDER_TYPES.BUY ? p >= floor : p <= floor;
    if (!crossing) return false;
    try {
        bot.manager?.logger?.log?.(
            `[COW-CROSS-GUARD] CREATE ${type} for ${String(slotId ?? 'unknown')} at ${Format.formatPrice6(p)} sits on the ` +
            `crossing side of the floor ${Format.formatPrice6(floor)} (the planner refuses these; a generic refill does not) — ` +
            `it executes at the best available price, so this is a taker-fee observation, not a veto. Once per batch.`,
            'warn'
        );
    } catch { /* logging is best-effort */ }
    return true;
}

/**
 * Run the last-fill guard probe: optionally refresh the pivot from
 * still-queued fills, read the durable pivot, and evaluate
 * isLastFillGuardBlocked. Consolidates the identical probe pattern in the
 * CREATE, UPDATE-rotation, and CREATE-fallback guards (origin bypasses and
 * skip logging stay at the call sites, which differ per action kind).
 * Batch callers pass skipRefresh=true: the batch-start freeze owns refreshes
 * so every action in a batch is judged against the same pivot.
 *
 * FINAL-GATE CONTRACT (see runFinalPivotGate): the gate re-checks BUILT ops
 * against a re-refreshed pivot AFTER the op-building loop. It must run BEFORE
 * any later mutation of operations/opContexts (fund validation snapshot,
 * pair-mode/chunk grouping) — those stages index op positions and read stale
 * indexes after a filter. Call sites after the gate must treat
 * operations/opContexts as the filtered arrays.
 * @param {Object} bot
 * @param {number} price - Target order price
 * @param {string} type - ORDER_TYPES.BUY/SELL
 * @param {Object} stats - lastFillGuardStats tracker (checked++ here)
 * @param {boolean} [skipRefresh=false] - Skip the queued-fill pivot refresh
 * @returns {{check: Object, refreshed: boolean}}
 */
function runLastFillGuardCheck(bot: BotLike, price: number, type: string, stats: LastFillGuardStats, skipRefresh: boolean = false): { check: LastFillGuardResult; refreshed: boolean } {
    let refreshed = false;
    // The batch-start freeze (see broadcast loop head) owns pivot refreshes;
    // per-action refreshes are disabled so every action in a batch is judged
    // against the same pivot. Kept opt-in for non-batch callers.
    if (!skipRefresh) {
        try { refreshed = !!refreshLastFillPivotFromQueue(bot); } catch { /* best-effort */ }
    }
    // Effective reference: the live pivot when armed, else the bot-scoped
    // market fill that survives a grid regeneration. Without the fallback a
    // rebuild un-arms the guard until the next fill.
    const lastRef = resolveLastFillGuardReference(bot.manager);
    const lastPrice = lastRef.price;
    const lastType = lastRef.type;
    // Validate the pivot onto the ladder before use (see resolveOnGridPivot).
    // Reported once per probe at warn when the raw pivot was NOT a grid level:
    // that is the ratchet precondition, and it is otherwise invisible because
    // the pivot is only ever logged by value.
    const onGrid = resolveOnGridPivot(bot.manager, lastPrice);
    if (lastPrice != null && onGrid.idx == null && Number.isFinite(Number(lastPrice))) {
        try {
            // A persistently off-ladder pivot is exactly the corruption case, so
            // this branch would otherwise warn once per guarded action per batch
            // on top of the batch summary (which already reports pivotOffGrid).
            // Warn once per distinct pivot value per batch: repeated identical
            // pivots are the same condition, and a CHANGED pivot still warns.
            const warnedKey = `lastFillPivotWarned:${bot?._currentCycleId ?? 'na'}`;
            const alreadyWarned = (bot as unknown as Record<string, unknown>)[warnedKey];
            if (alreadyWarned !== Number(lastPrice)) {
                (bot as unknown as Record<string, unknown>)[warnedKey] = Number(lastPrice);
                // Distinguish "close to a level but too far to snap" from "nowhere
                // near the ladder". The former is a rounding/drift artifact; the
                // latter means the pivot itself is not a real fill price.
                const far = onGrid.nearestDrift == null || onGrid.nearestDrift > 0.02;
                const kind = far ? 'off-ladder' : 'near-ladder'
                    + (onGrid.nearestDrift != null ? ` (${(onGrid.nearestDrift * 100).toFixed(4)}% from the nearest level)` : '');
                bot.manager?.logger?.log?.(
                    `[LAST-FILL-GUARD] Pivot ${Format.formatPrice6(Number(lastPrice))} is not a grid level ` +
                    `(${kind}); using raw value. A non-grid pivot can ` +
                    `misjudge which placements are off-market. ` +
                    `(reported once per batch per pivot value)`,
                    'warn'
                );
            }
        } catch { /* logging is best-effort */ }
        stats.pivotOffGrid = (stats.pivotOffGrid || 0) + 1;
    }
    const check = isLastFillGuardBlocked(price, type, onGrid.price, lastType);
    stats.checked++;
    return { check, refreshed };
}

/**
 * Final pre-broadcast pivot gate: re-check BUILT ops against a re-refreshed
 * pivot RIGHT BEFORE broadcast.
 *
 * Why this exists (2026-09-13 incident on a live market-pair bot): the batch-start freeze
 * refreshes the pivot once, then every CREATE / rotation-UPDATE /
 * fallback-CREATE is judged against that frozen value (skipRefresh=true).
 * A fill that is queued AFTER the freeze but BEFORE broadcast (in the
 * incident: freeze at .745, fill queued at .765, broadcast at .910) passes
 * every per-action check on a stale pivot and ships. The batch summary
 * prints pivotRefreshed=false — the freeze honestly found nothing — and
 * the violating ops broadcast anyway.
 *
 * Placement (see FINAL-GATE CONTRACT on runLastFillGuardCheck):
 *   1. Called after the op-building action loop, BEFORE the LAST-FILL-GUARD
 *      batch summary line (so dropped ops are visible as skipped, not
 *      passed) and BEFORE fund validation (so the VALIDATION snapshot
 *      reflects the filtered ops).
 *   2. Must run before pair-mode/chunk grouping, which indexes op positions.
 *      executeOperationsWithStrategy groups lazily at broadcast time from
 *      the (filtered) opContexts it receives, so filtering here is safe —
 *      but any future grouping computed between op-building and broadcast
 *      must be rebuilt after the gate (same rule as the contract).
 *
 * Semantics:
 *   - Peek-only refresh (never drains the fill queue — same as the freeze).
 *   - Pivot UNCHANGED since the freeze => pure no-op: returns the input
 *     arrays untouched, no extra log lines beyond queue-depth debug.
 *   - Pivot CHANGED => re-run isLastFillGuardBlocked against each built op's
 *     final price with the SAME bypass rules as the build loop
 *     (spread-correction CREATEs, stamped gap-evacuation UPDATEs). Violating
 *     ops + their contexts are dropped; their slots feed the existing
 *     skippedUpdateSlotIds/skippedCreateSlotIds restore paths so the working
 *     grid stays consistent (dropped rotations restore from master, dropped
 *     creates count toward the boundary-hold intersect).
 *   - fail-open on everything unjudgeable: unresolvable price/type, cold
 *     pivot (null), or a refresh/inference throw => the op is KEPT. A gate
 *     that cannot prove a violation must not invent one — dropping a healthy
 *     op strands its slot, while a missed violation is still caught by the
 *     next cycle's guard + commit chain adoption.
 *   - size-update ops are NEVER gated (same-price, no repricing).
 *   - cancel ops are NEVER gated or dropped.
 *
 * Stale-index hygiene: recordPendingBroadcast stores opIndex/ctxIndex
 * against the build-time arrays. Dropped CREATEs must have their pending
 * entries removed (else the reconcile path adopts a broadcast that never
 * shipped), and KEPT entries must have their stored indexes REMAPPED: a
 * lockstep compaction keeps operations/opContexts aligned with each other,
 * but the absolute indexes stored inside the pending entries are not
 * rewritten by it — after the first drop, an unremapped ctxIndex resolves
 * to a shifted position (undefined at best, a DIFFERENT create's context at
 * worst, which would let adoptMatchedEntries synchronize the wrong slot
 * with a matched chain order). The gate therefore builds an old→new index
 * map during compaction and remaps/removes entries identified by
 * opts.batchPendingFps (the fingerprints THIS batch recorded — entry.batchId
 * is always null in production, so it cannot discriminate). Sibling
 * batches' entries are never touched (their indexes refer to their own
 * build-time arrays).
 *
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array} operations - Built chain ops (mutated in place on drop)
 * @param {Array} opContexts - Built op contexts (mutated in place on drop)
 * @param {Object} opts - { actions, cowResult, frozenPivot, frozenType,
 *   lastFillGuardStats, skippedUpdateSlotIds, skippedCreateSlotIds,
 *   skippedUpdateCountRef: { count }, freezeQueueDepth, batchPendingFps }
 * @returns {{ dropped: Array, pivotChanged: boolean, refreshed: boolean }}
 */
function runFinalPivotGate(bot: BotLike, operations: unknown[], opContexts: OpPhase[], opts: JsonObj = {}): { dropped: JsonObj[]; pivotChanged: boolean; refreshed: boolean } {
    const empty = { dropped: [], pivotChanged: false, refreshed: false };
    try {
        if (!Array.isArray(operations) || !Array.isArray(opContexts) || operations.length === 0) return empty;
        const stats = opts.lastFillGuardStats as LastFillGuardStats | undefined;
        const frozenPivot = Number(opts?.frozenPivot);
        const frozenType = opts.frozenType as string | null | undefined;
        const frozenCold = !Number.isFinite(frozenPivot) || frozenType == null;
        const queueDepthBefore = Array.isArray(bot?._incomingFillQueue)
            ? bot._incomingFillQueue.length
            : null;
        // Peek-only re-refresh: never drains the queue (same as the freeze).
        let refreshed = false;
        try { refreshed = !!refreshLastFillPivotFromQueue(bot); } catch { refreshed = false; }
        const queueDepthAfter = Array.isArray(bot?._incomingFillQueue)
            ? bot._incomingFillQueue.length
            : null;
        const liveRef = resolveLastFillGuardReference(bot.manager);
        const livePivot = Number(liveRef.price);
        const liveType = liveRef.type;
        const liveCold = !Number.isFinite(livePivot) || liveType == null;
        // No-op fast path: pivot unchanged (or uncomparable) since the freeze.
        // frozenCold + liveCold: guard stayed disabled — nothing to re-check.
        // frozenCold + liveArmed: the freeze ran cold but a fill arrived
        // mid-batch. The built ops were NEVER guarded; treat as changed so
        // they are checked below (fail-open keeps whatever is unjudgeable).
        let pivotChanged = refreshed;
        if (frozenCold && liveCold) pivotChanged = false;
        else if (!frozenCold && !liveCold) pivotChanged = livePivot !== frozenPivot || liveType !== frozenType;
        else pivotChanged = true;
        try {
            bot.manager?.logger?.log?.(
                `[LAST-FILL-GUARD] Final gate: queue ${queueDepthBefore ?? '?'}->${queueDepthAfter ?? '?'} ` +
                `pivot ${Number.isFinite(frozenPivot) ? Format.formatPrice6(frozenPivot) : 'none'}(${frozenType ?? 'cold'})` +
                `->${Number.isFinite(livePivot) ? Format.formatPrice6(livePivot) : 'none'}(${liveType ?? 'cold'}) ` +
                `changed=${pivotChanged} refreshed=${refreshed}`,
                'debug'
            );
        } catch { /* logging is best-effort */ }
        // Pivot moved (or armed mid-batch): re-check every built op's FINAL
        // price. Same bypass rules as the build loop; unjudgeable => KEEP.
        const actions = (Array.isArray(opts.actions) ? opts.actions : []) as CowAction[];
        // A stamped gap-evacuation can also go stale WITHOUT a pivot change:
        // a boundary commit can land between op-building and this gate. Do not
        // take the no-op fast path while any such stamp no longer matches the
        // LIVE geometry. The loop below drops it fail-closed.
        const hasStaleStampedEvac = actions.some((a) => {
            if (!a || a.origin !== COW_ORIGINS.GAP_EVACUATION) return false;
            if (!Number.isFinite(Format.toKnownNumber(a.evacBoundary))
                || !Number.isFinite(Format.toKnownNumber(a.evacGapSlots))) return false;
            const evacType = a.order?.type ?? a.type;
            return !isEvacuationStampStillValid(
                bot.manager?.boundaryIdx, bot.manager?._gapSlots,
                a.id, a.newGridId, evacType
            );
        });
        if (!pivotChanged && !hasStaleStampedEvac) return { ...empty, refreshed };
        const batchOrigin = (opts.cowResult as JsonObj | undefined)?.origin as string | undefined;
        const actionBySlot = new Map<string, CowAction>();
        for (const a of actions) {
            if (!a) continue;
            // Rotation UPDATEs are keyed by DESTINATION slot (the emitted
            // price is the destination's level); plain CREATEs by slot id.
            const rotDest = a?.newGridId;
            const key = (a?.type === COW_ACTIONS.UPDATE && rotDest && rotDest !== a?.id) ? rotDest : a?.id;
            if (key && !actionBySlot.has(key)) actionBySlot.set(key, a);
        }
        const dropIdx = new Set<number>();
        const dropped: JsonObj[] = [];
        const onGrid = resolveOnGridPivot(bot.manager, liveRef.price);
        for (let i = 0; i < opContexts.length; i++) {
            const ctx = opContexts[i];
            if (!ctx || ctx.kind === 'cancel' || ctx.kind === 'size-update') continue;
            let price: number | null = null;
            let type: string | null = null;
            let slotId: string | null = null;
            let action: CowAction | null = null;
            if (ctx.kind === 'create') {
                slotId = (ctx.id as string | undefined) || ctx.order?.id || null;
                price = Number(ctx.order?.price);
                type = ctx.order?.type || null;
                action = (slotId && actionBySlot.get(slotId)) || null;
                // Spread-correction CREATE bypass (mirrors the build loop:
                // per-action origin, batch origin as back-compat fallback).
                const actionOrigin = action?.origin;
                if ((actionOrigin === COW_ORIGINS.SPREAD_CORRECTION
                    || (actionOrigin == null && batchOrigin === COW_ORIGINS.SPREAD_CORRECTION))
                    && isSpreadCorrectionBypassAllowed(bot)) {
                    if (stats) stats.bypassed = (Number(stats.bypassed) || 0) + 1;
                    continue;
                }
            } else if (ctx.kind === 'rotation') {
                const rot = (ctx.rotation || {}) as JsonObj;
                slotId = (rot.newGridId as string | undefined) || (rot.oldOrder as JsonObj | undefined)?.id as string | undefined || null;
                price = Number(rot.newPrice);
                type = (rot.type as string | undefined) || null;
                // Rotation UPDATEs are keyed by DESTINATION slot (the
                // emitted price is the destination's level) — EXCEPT the
                // same-slot size-only form (no newGridId, or newGridId ===
                // source id), which buildActionsFromPlan emits for
                // ordersToUpdate and which must resolve to the source
                // action. A same-slot UPDATE carries no repricing, so a
                // dest-keyed lookup that misses it would ALSO miss its
                // origin stamp — fall back to the source id before
                // judging the bypass.
                action = (slotId && actionBySlot.get(slotId)) || null;
                if (!action) {
                    const srcId = ((rot.oldOrder as JsonObj | undefined)?.id as string | undefined) || null;
                    if (srcId) action = actionBySlot.get(srcId) || null;
                }
                // Gap-evacuation UPDATE bypass mirrors the build loop's
                // stamped path ONLY — with one deliberate asymmetry (see
                // below): the build loop re-proves UNSTAMPED evacuations
                // live from the master grid; the gate guards them normally.
                // An unstamped rotation reaching the final gate was either
                // (a) probed-and-allowed at build time — in which case its
                // price already survived an evacuation proof and the guard
                // re-check here is harmless duplication, or (b) probe-
                // rejected/failed-closed — in which case it was SKIPPED at
                // build time and never reached op-building, so the gate
                // cannot see it either. Either way there is no live
                // unstamped evacuation in the built ops that needs
                // re-proving: re-proving here would need the master-grid
                // source read the build loop does, and the source may have
                // been pre-applied since. Stamped rotations carry origin +
                // evacBoundary/evacGapSlots.
                //
                // ASYMMETRY (fail-open, not fail-closed): the build loop's
                // unstamped path FAILS CLOSED (unresolvable source => skip
                // the op). The gate FAILS OPEN (unjudgeable => keep). A
                // dropped op strands its slot until the next cycle; a kept
                // op is still subject to the commit guard + chain adoption.
                // The gate must not invent a block it cannot prove —
                // especially not on an op the build loop already allowed.
                const rotOrigin = action?.origin;
                if (rotOrigin === COW_ORIGINS.GAP_EVACUATION
                    && Number.isFinite(Format.toKnownNumber(action?.evacBoundary))
                    && Number.isFinite(Format.toKnownNumber(action?.evacGapSlots))) {
                    // Stale-stamp backstop: the build loop already refuses a
                    // stamp that no longer matches the LIVE geometry, but the
                    // final gate must not re-grant the bypass if the boundary
                    // moved after op-building. Drop when the source/dest
                    // geometry is no longer valid (the normal guard only
                    // checks price direction).
                    const evacSrcId = ((rot.oldOrder as JsonObj | undefined)?.id as string | undefined) || null;
                    const evacDestId = (rot.newGridId as string | undefined) || null;
                    const evacStampLive = evacSrcId != null && evacDestId != null
                        && isEvacuationStampStillValid(
                            bot.manager?.boundaryIdx, bot.manager?._gapSlots,
                            evacSrcId, evacDestId, type
                        );
                    if (evacStampLive) {
                        if (stats) stats.bypassed = (Number(stats.bypassed) || 0) + 1;
                        continue;
                    }
                    // Geometry went stale after op-building (e.g. a boundary
                    // commit landed mid-batch). Dropping is the only fail-closed
                    // option: the normal guard below only checks the fill price,
                    // so a non-violating stale move would still ship.
                    dropIdx.add(i);
                    if (stats) stats.skipped = (Number(stats.skipped) || 0) + 1;
                    dropped.push({ index: i, kind: ctx.kind, slotId, price, type });
                    try {
                        bot.manager?.logger?.log?.(
                            `[LAST-FILL-GUARD] Final gate dropping stale gap-evacuation ` +
                            `${ctx.kind} ${slotId ?? 'unknown'}: source/dest no longer evacuation ` +
                            `geometry under live boundary ${bot.manager?.boundaryIdx}/gap ${bot.manager?._gapSlots}`,
                            'warn'
                        );
                    } catch { /* logging is best-effort */ }
                    continue;
                }
            } else {
                continue;
            }
            // Fail-open: unresolvable price/type => KEEP (never invent a
            // violation the gate cannot prove).
            if (!Number.isFinite(price as number) || (price as number) <= 0) continue;
            if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) continue;
            const check = isLastFillGuardBlocked(price as number, type, onGrid.price, liveType);
            if (stats) stats.checked = (Number(stats.checked) || 0) + 1;
            if (!check.blocked) {
                if (stats) stats.passed = (Number(stats.passed) || 0) + 1;
                continue;
            }
            // Blocked: drop the op + context, restore the slot below.
            dropIdx.add(i);
            if (stats) stats.skipped = (Number(stats.skipped) || 0) + 1;
            const dir = type === ORDER_TYPES.BUY ? 'above' : 'below';
            dropped.push({ index: i, kind: ctx.kind, slotId, price, type });
            try {
                bot.manager?.logger?.log?.(
                    `[LAST-FILL-GUARD] Final gate dropping ${type} ${ctx.kind} for ${slotId ?? 'unknown'} at ` +
                    `${Format.formatPrice6(price as number)}: ${dir} last filled ${check.pivot != null ? Format.formatPrice6(Number(check.pivot)) : 'n/a'} ` +
                    `(direction rule: BUY must be below / SELL above the last fill); re-planned after market moves`,
                    'warn'
                );
            } catch { /* logging is best-effort */ }
        }
        if (dropIdx.size === 0) return { dropped, pivotChanged, refreshed };
        // Compact operations/opContexts in lockstep so every surviving index
        // still lines up. The caller rebuilds cancelOpIndexByOrderId from the
        // kept contexts (it was built during op-building and goes stale for
        // every op after the first drop), and the remap pass below re-points
        // THIS batch's kept pending-broadcast entries at their new positions
        // — lockstep keeps the two arrays aligned with each other, but the
        // absolute indexes stored INSIDE pending entries are not rewritten
        // by a compaction, so they must be remapped explicitly.
        const keptOps: unknown[] = [];
        const keptCtxs: OpPhase[] = [];
        const oldToNew = new Map<number, number>();
        for (let i = 0, ni = 0; i < opContexts.length; i++) {
            if (dropIdx.has(i)) continue;
            oldToNew.set(i, ni);
            ni++;
            keptOps.push(operations[i]);
            keptCtxs.push(opContexts[i]);
        }
        operations.length = 0;
        operations.push(...keptOps);
        opContexts.length = 0;
        opContexts.push(...keptCtxs);
        // Slot restore: dropped rotations restore source+dest from master
        // (same sets the build loop feeds to restoreSkippedUpdateSlots...);
        // dropped creates count toward the refill-hold intersect. Pending
        // entries for dropped CREATEs are removed (never shipped); kept
        // CREATEs get their stored opIndex/ctxIndex remapped to the
        // compacted positions (see the remap pass below — an unremapped
        // absolute index would resolve to a SHIFTED context after the first
        // drop: undefined at best, a DIFFERENT create's context at worst,
        // which would let the uncertain-broadcast reconcile adopt a matched
        // chain order into the wrong slot).
        const skippedUpdateSlotIds = opts.skippedUpdateSlotIds as Set<string> | null | undefined;
        const skippedCreateSlotIds = opts.skippedCreateSlotIds as Set<string> | null | undefined;
        const countRef = opts.skippedUpdateCountRef as { count: number } | null | undefined;
        try {
            const pending = bot.manager?._pendingBroadcasts;
            for (const d of dropped) {
                if (d.kind === 'rotation') {
                    const act = d.slotId ? (actionBySlot.get(String(d.slotId)) ?? null) : null;
                    const srcId = act?.id || null;
                    if (srcId && skippedUpdateSlotIds instanceof Set) skippedUpdateSlotIds.add(srcId);
                    if (d.slotId && skippedUpdateSlotIds instanceof Set) skippedUpdateSlotIds.add(String(d.slotId));
                    if (countRef && typeof countRef === 'object') countRef.count = (Number(countRef.count) || 0) + 1;
                } else if (d.kind === 'create') {
                    if (d.slotId && skippedCreateSlotIds instanceof Set) skippedCreateSlotIds.add(String(d.slotId));
                    if (pending instanceof Map) {
                        for (const [fp, entry] of pending) {
                            // Match by slot only: the fingerprint embeds
                            // side/amounts/slot (no op indexes), but entry.slotId
                            // is the narrowest predicate that cannot touch a
                            // sibling batch's entry for a different slot.
                            if (entry?.slotId && entry.slotId === d.slotId) {
                                pending.delete(fp);
                            }
                        }
                    }
                }
            }
            // Remap THIS batch's kept pending entries (identified by the
            // fingerprint set the build loop collected — entry.batchId is
            // always null in production and cannot discriminate). A stored
            // ctxIndex whose old position was dropped means the entry was
            // not slot-matched above; it could never resolve post-compaction,
            // so it is removed. Everything else is re-pointed at the same
            // context object it was recorded with. Sibling batches' entries
            // are never touched: their indexes refer to their own long-gone
            // build-time arrays.
            if (pending instanceof Map && opts?.batchPendingFps instanceof Set) {
                for (const fp of opts.batchPendingFps) {
                    const entry = pending.get(fp) as unknown as PendingEntry | undefined;
                    if (!entry) continue; // dropped create: already removed by slot
                    const newCtx = oldToNew.get(Number(entry.ctxIndex));
                    if (newCtx == null) {
                        // Referenced op was dropped (or the entry predates
                        // lockstep indexing) — the index cannot be healed.
                        pending.delete(fp);
                        continue;
                    }
                    entry.ctxIndex = newCtx;
                    const newOp = oldToNew.get(Number(entry.opIndex));
                    entry.opIndex = newOp == null ? entry.opIndex : newOp;
                }
            }
        } catch { /* restore bookkeeping is best-effort */ }
        return { dropped, pivotChanged, refreshed };
    } catch { return empty; }
}

/**
 * Apply BTS create-fee accounting for a batch that bypassed the normal
 * processBatchResults pipeline (commit refused after broadcast, or
 * poll-confirmed uncertain commit). Mirrors the create branch of
 * processBatchResults using master-grid state after chain adoption, so the
 * optimistic balance reflects the on-chain create cost.
 *
 * Safe on adopted/committed slots only: the slot must already carry its
 * orderId, so the transition old(ACTIVE)→new(ACTIVE) is delta-zero and only
 * the fee is applied — no double capital commitment. Cancel/rotation fee
 * accounting is intentionally skipped: the chain sync already performed the
 * capital release for cancelled orders (diff-based, applying it again would
 * double-release), and rotations without a committed destination cannot be
 * accounted locally.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Array<Object>} contexts - Executed op contexts (create/rotation/cancel)
 */
async function applyAdoptionFeeAccounting(bot: BotLike, contexts: OpPhase[]) {
    if (!bot.manager?.accountant || !Array.isArray(contexts) || contexts.length === 0) return;
    const btsFeeData = getAssetFeesSafe('BTS');
    const btsSide = (typeof bot.manager.accountant._getBtsOrderType === 'function')
        ? bot.manager.accountant._getBtsOrderType()
        : null;

    for (const ctx of contexts) {
        if (ctx?.kind === 'create') {
            const order = ctx.order;
            if (!order) continue;
            const slot = order.id ? bot.manager.orders.get(order.id) : null;
            if (!slot?.orderId) continue;
            try {
                await bot.manager.synchronizeWithChain({
                    gridOrderId: order.id,
                    chainOrderId: slot.orderId,
                    isPartialPlacement: false,
                    expectedType: order.type,
                    fee: btsFeeData?.createFee || 0,
                    order: order,
                }, 'createOrder');
            } catch (feeErr) {
                bot.manager.logger.log(
                    `[COW] Adoption fee accounting failed for create slot ${order.id}: ${getErrorMessage(feeErr)}`,
                    'warn'
                );
            }
        } else if (ctx?.kind === 'cancel') {
            // The cancel landed but the commit was refused / the adoption path
            // bypassed processBatchResults. Master still holds the slot; the
            // next sync's phantom cleanup releases its commitment with fee 0 —
            // charge the cancel fee here so the optimistic BTS balance reflects
            // the on-chain cost exactly once (mirrors the sync's
            // 'cancel-order-unmatched-fee' pattern; the deferred-fee refund is
            // reconciled by the next sync's fill/cancel processing).
            if (btsSide && btsFeeData && (btsFeeData.cancelFee ?? 0) > 0) {
                try {
                    await bot.manager.accountant.adjustTotalBalance(btsSide, -(btsFeeData.cancelFee ?? 0), 'cancel-adopt-fee');
                } catch (feeErr) {
                    bot.manager.logger.log(
                        `[COW] Adoption fee accounting failed for cancel ${ctx.order?.orderId}: ${getErrorMessage(feeErr)}`,
                        'warn'
                    );
                }
            }
        } else if (ctx?.kind === 'size-update' || ctx?.kind === 'rotation') {
            // Same reasoning as cancels: the update landed but its fee was never
            // charged on this path; the next sync's size reconciliation applies
            // the chain state without an update fee (fee 0), so charge it once
            // here to prevent optimistic BTS drift.
            if (btsSide && btsFeeData && (btsFeeData.updateFee ?? 0) > 0) {
                try {
                    await bot.manager.accountant.adjustTotalBalance(btsSide, -(btsFeeData.updateFee ?? 0), 'update-adopt-fee');
                } catch (feeErr) {
                    bot.manager.logger.log(
                        `[COW] Adoption fee accounting failed for update ${ctx.kind === 'size-update' ? ((ctx.updateInfo as JsonObj | undefined)?.partialOrder as JsonObj | undefined)?.orderId : (ctx.rotation?.oldOrder as JsonObj | undefined)?.orderId}: ${getErrorMessage(feeErr)}`,
                        'warn'
                    );
                }
            }
        }
    }
}

/**
 * Table-driven optimistic fee call for processBatchResults: the cancel,
 * size-update, and both rotation branches all invoke
 * updateOptimisticFreeBalance(oldOrder, newOrder, context, fee, false)
 * under the same accountant guard — one spelling instead of four.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} oldOrder
 * @param {Object} newOrder
 * @param {string} context - Fee context ('fill-cancel' | 'order-update')
 * @param {number} fee - BTS fee amount
 */
async function applyOptimisticFeeBalance(bot: BotLike, oldOrder: ManagedOrder, newOrder: ManagedOrder, context: string, fee: number) {
    if (oldOrder && newOrder && bot.manager.accountant) {
        await bot.manager.accountant.updateOptimisticFreeBalance(
            oldOrder,
            newOrder,
            context,
            fee || 0,
            false
        );
    }
}

/**
 * Process results from batch transaction execution.
 * Updates order state, synchronizes with chain, and deducts BTS fees.
 * @param {import('./dexbot_class.js').DEXBot} bot
 * @param {Object} result
 * @param {Array} opContexts
 * @returns {Object} Result with { executed: boolean, hadRotation: boolean }
 */
async function processBatchResults(bot: BotLike, result: JsonObj, opContexts: OpPhase[]) {
    const results = extractOperationResults(result, 'processBatchResults', bot.manager?.logger?.log?.bind(bot.manager?.logger));
    // Safe variant: this runs AFTER the working grid committed, so a throw
    // here (fee cache unset) would hard-fail the whole batch post-commit and
    // land in the executor catch, where the stack-entry marker is already
    // cleared — leaving the grid committed but its post-commit processing
    // (fee deduction, metadata) silently skipped. Zero-fee fallback keeps the
    // accounting close; the next sync converges the residual.
    const btsFeeData = getAssetFeesSafe('BTS');
    let hadRotation = false;
    let updateOperationCount = 0;
    let createOperationCount = 0;
    let rotationOperationCount = 0;

    const updatesToApply: JsonObj[] = [];

    for (let i = 0; i < opContexts.length; i++) {
        const ctx = opContexts[i];
        const res = results[i];
        const ctxOrder = ctx.order as ManagedOrder;
        const ctxUpdateInfo = ctx.updateInfo as JsonObj;

        if (ctx.kind === 'cancel') {
            bot.manager.logger.log(`Cancelled surplus order ${ctxOrder.id} (${ctxOrder.orderId})`, 'info');
            const oldOrder = ctxOrder;
            const committedOrder = oldOrder?.id ? bot.manager.orders.get(oldOrder.id) : null;

            await applyOptimisticFeeBalance(bot, oldOrder as ManagedOrder, committedOrder as ManagedOrder, 'fill-cancel', btsFeeData?.cancelFee || 0);
        }
        else if (ctx.kind === 'size-update') {
            const oldOrder = ctxUpdateInfo.partialOrder as JsonObj;
            const ord = bot.manager.orders.get(String(oldOrder.id));

            await applyOptimisticFeeBalance(bot, oldOrder as ManagedOrder, ord as ManagedOrder, 'order-update', btsFeeData?.updateFee || 0);

            if (ord) {
                const updatedSlot = { ...ord, size: Number(ctxUpdateInfo.newSize) };
                if (ctx.finalInts) {
                    updatedSlot.rawOnChain = rawOnChainFromInts(ord.orderId, ctx.finalInts);
                }
                updatesToApply.push({ order: updatedSlot, context: 'post-update-metadata' });
            }
            bot.manager.logger.log(`Size update complete: ${(ctxUpdateInfo.partialOrder as JsonObj).orderId}`, 'info');
            updateOperationCount++;
        }
        else if (ctx.kind === 'create') {
            createOperationCount++;
            const chainOrderId = res && (res as unknown[])[1];
            if (chainOrderId) {
                await bot.manager.synchronizeWithChain({
                    gridOrderId: ctxOrder.id, chainOrderId, expectedType: ctxOrder.type, fee: btsFeeData?.createFee || 0,
                    order: ctxOrder ?? null,
                }, 'createOrder');

                if (ctx.finalInts) {
                    const syncedOrder = bot.manager.orders.get(ctxOrder.id);
                    if (syncedOrder) {
                        updatesToApply.push({
                            order: {
                                ...syncedOrder,
                                rawOnChain: rawOnChainFromInts(chainOrderId, ctx.finalInts)
                            },
                            context: 'post-placement-metadata'
                        });
                    }
                }
                // Success line mirrors the failure-path fingerprint below
                // (type/price/size) so both are greppable by the same keys —
                // this is what ties a fill back to the slot that placed it.
                bot.manager.logger.log(
                    `Placed ${ctxOrder.type} order ${ctxOrder.id} ` +
                    `@${Format.formatPrice6(ctxOrder.price)} x${Format.formatAmount(ctxOrder.size)} ` +
                    `-> ${chainOrderId}`,
                    'info'
                );
            } else {
                const fingerprint = [
                    `type=${ctxOrder.type || 'unknown'}`,
                    `price=${Format.formatPrice6(ctxOrder.price)}`,
                    `size=${Format.formatAmount(ctxOrder.size)}`
                ].join(',');
                bot.manager.logger.log(
                    `[COW] CRITICAL: Create op for slot ${ctxOrder.id} (type=${ctxOrder.type}) ` +
                    `returned no chainOrderId. Identify orphaned on-chain orders by local fingerprint ` +
                    `${fingerprint} before cancelling.`,
                    'error'
                );
            }
        }
        else if (ctx.kind === 'rotation') {
            hadRotation = true;
            rotationOperationCount++;
            const rotation = (ctx.rotation ?? {}) as JsonObj;
            const oldOrder = rotation.oldOrder as JsonObj | undefined;
            const newPrice = rotation.newPrice;
            const newGridId = rotation.newGridId as string | undefined;
            const newSize = rotation.newSize;
            const type = rotation.type as ManagedOrder['type'];

            if (!newGridId) {
                const ord = bot.manager.orders.get(String(oldOrder?.id || rotation.id));

                await applyOptimisticFeeBalance(bot, oldOrder as unknown as ManagedOrder, ord as ManagedOrder, 'order-update', btsFeeData?.updateFee || 0);

                if (ord) {
                    const updatedSlot = { ...ord, size: newSize as number };
                    if (ctx.finalInts) {
                        updatedSlot.rawOnChain = rawOnChainFromInts(ord.orderId, ctx.finalInts);
                    }
                    updatesToApply.push({ order: updatedSlot, context: 'post-update-metadata' });
                }
                updateOperationCount++;
                continue;
            }

            const slot = bot.manager.orders.get(newGridId);
            if (!slot) {
                bot.manager.logger.log(
                    `[ROTATION] Destination slot ${newGridId} missing from master grid after COW commit - skipping activation, sync will reconcile`,
                    'error'
                );
                if (oldOrder?.id && oldOrder.id !== newGridId) {
                    const staleSource = bot.manager.orders.get(String(oldOrder.id));
                    if (staleSource?.orderId) {
                        updatesToApply.push({
                            order: { ...staleSource, state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null },
                            context: 'post-rotation-source-clear'
                        });
                    }
                }
                continue;
            }
            const updatedSlot = {
                ...slot,
                id: newGridId,
                type,
                size: newSize,
                price: newPrice,
                state: ORDER_STATES.ACTIVE,
                orderId: (oldOrder?.orderId as string | null | undefined) || slot.orderId || null
            };

            if (ctx.finalInts) {
                updatedSlot.rawOnChain = rawOnChainFromInts(updatedSlot.orderId, ctx.finalInts);
            }

            await applyOptimisticFeeBalance(bot, oldOrder as ManagedOrder, updatedSlot as ManagedOrder, 'order-update', btsFeeData?.updateFee || 0);

            if (oldOrder?.id && oldOrder.id !== newGridId) {
                const currentSource = bot.manager.orders.get(String(oldOrder.id));
                if (currentSource && currentSource.orderId) {
                    updatesToApply.push({
                        order: {
                            ...currentSource,
                            state: ORDER_STATES.VIRTUAL,
                            orderId: null,
                            rawOnChain: null
                        },
                        context: 'post-rotation-source-clear'
                    });
                }
            }

            updatesToApply.push({ order: updatedSlot, context: 'post-rotation-metadata' });
        }
    }

    if (updatesToApply.length > 0) {
        await bot.manager.applyGridUpdateBatch(
            updatesToApply.map((u) => u.order), 
            'batch-results-process',
            { skipAccounting: true }
        );
    }

    return {
        executed: true,
        hadRotation,
        updateOperationCount,
        // Actions that reached post-broadcast processing (guards already
        // removed skipped ops). Callers that report "orders placed" must use
        // this instead of the plan's pre-guard action count.
        executedActionCount: opContexts.length,
        createOperationCount,
        rotationOperationCount
    };
}
export { isSpreadCorrectionBypassAllowed, isLastFillGuardBlocked, resolveOnGridPivot, warnCrossingCreate, checkGridPriceInvariant, recordRestampBuyAboveAnchor, collectGapBandPlacementShadowSlots, deriveRotationPrice, refreshLastFillPivotFromQueue, runFinalPivotGate, buildOutsideInPairGroupsForOrders, buildOutsideInPairGroupsForCreateEntries, markMissingCreateResultsAsStructuralBlocker, formatUnmatchedChainOrderForLog, recordPendingBroadcast, clearPendingBroadcasts, popPushedWorkingGrid, findChainOrderForSlot, reconcileAfterUncertainBroadcast, executeWithRetryOnUncertain, executeChunkedWithRetryOnUncertain, formatPartialBroadcastSummary, buildActionsFromPlan, buildCowResultFromPlan, applyRotationTransitionsToWorkingGrid, updateOrdersOnChainBatchCOW, processBatchResults, adoptPlacedBatchFromChain, resolveRefillBoundaryHold, toRefillSlotIdSet, trackBoundaryHold };
// Exported for regression tests (issue #23 sibling): the uncertain-broadcast
// discard path must never drop a placement silently when master lost the slot.
export { restoreDiscardedCreates };


export default {
    buildOutsideInPairGroupsForOrders,
    buildOutsideInPairGroupsForCreateEntries,
    markMissingCreateResultsAsStructuralBlocker,
    formatUnmatchedChainOrderForLog,
    recordPendingBroadcast,
    clearPendingBroadcasts,
    findChainOrderForSlot,
    reconcileAfterUncertainBroadcast,
    executeWithRetryOnUncertain,
    executeChunkedWithRetryOnUncertain,
    popPushedWorkingGrid,
    buildCowResultFromPlan,
    updateOrdersOnChainBatchCOW,
    processBatchResults,
};

/**
 * modules/order/fill_ledger.ts
 *
 * Fill identity, traded-side resolution and booked-fill membership.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * A fill used to be identified, sided and de-duplicated in three places:
 *   - `buildFillKey` / `buildOrphanFillFallbackKey` in `dexbot_fill_runtime.ts`,
 *   - the pays-asset side mapping copied into `SyncEngine._computeFillContext`,
 *     `attributeUnmatchedFillToGrid` (`order/utils/order.ts`) and the queued
 *     pivot refresh (`dexbot_cow_runtime.ts`),
 *   - the booked-fill check split between `_isNewFillKey` (bot level) and
 *     `OrderManager.processedFillStore` (the persisted authority).
 *
 * The copies drifted: `6afa0c4b` had to patch the same "undefined pays asset"
 * collision in three sites at once, and `cb1041b6` had to fix a side that the
 * slot label had laundered. This module is the single owner of the two pure
 * questions ("which fill is this?" and "which side did it trade?") so a fourth
 * copy is a review failure rather than a silent divergence.
 *
 * WHAT IT DOES NOT OWN
 * --------------------
 * - Duplicate *booking* stays with `OrderManager.processedFillStore`; this
 *   module only exposes its membership test (`isFillBooked`).
 * - The SPREAD price fallback policy stays with the caller that has the
 *   genesis price (`resolveSpreadOrderSide`); `resolveTradedSide` takes the
 *   already-resolved fallback side as an argument instead of re-deriving it.
 * - Rails: `slot.type` is the ACCOUNTING side after a partial fill retags it
 *   (`sync_engine` PARTIAL transition, see docs/COW_INVARIANTS.md INV-SYNC-008
 *   and `cb1041b6`). Rail identity is geometry and is never derived here.
 *
 * Browser-safe: no imports beyond the constants, no `process`/`fs` usage.
 */

import { ORDER_TYPES } from '../constants.js';

/** Minimal shape the key builder reads (a chain fill op, a history row, or a queue entry). */
export interface FillKeySource {
    op?: unknown[];
    orderId?: string;
    block_num?: number;
    blockNum?: number;
    id?: string;
    historyId?: string;
}

/** Minimal asset-pair shape needed to map a paid asset onto a side. */
export interface FillSideAssets {
    assetA?: { id?: unknown } | null;
    assetB?: { id?: unknown } | null;
}

/** Persisted dedupe store shape (`OrderManager.processedFillStore`). */
export interface FillBookedStore {
    tracker?: Map<string, number> | null;
}

/**
 * The chain identity of a fill: `orderId:blockNum:historyId`.
 *
 * All three parts are required. A fill without them cannot be de-duplicated
 * across restarts, so callers treat `null` as "no identity" (the fill runtime
 * then tries its orphan fallback key) rather than inventing one.
 */
function fillKeyOf(fillOrParts: FillKeySource | null | undefined): string | null {
    const fillOp = fillOrParts?.op?.[1] as { order_id?: string } | undefined;
    const orderId = fillOp?.order_id ?? fillOrParts?.orderId;
    const blockNum = fillOrParts?.block_num ?? fillOrParts?.blockNum;
    const historyId = fillOrParts?.id ?? fillOrParts?.historyId;
    if (!orderId || blockNum == null || !historyId) return null;
    return `${orderId}:${blockNum}:${historyId}`;
}

/**
 * The side a fill actually traded, resolved from the asset that was PAID.
 *
 * Paying the quote asset (assetB) buys the base; paying the base (assetA)
 * sells it. This is chain truth and must not be replaced by the slot label:
 * a slot can be retyped (BUY<->SELL) before its resting order is corrected,
 * and the slot type is the ACCOUNTING side after a partial fill (`6afa0c4b`,
 * `cb1041b6`).
 *
 * `fallbackType` is used only when the fill event carries no usable pays
 * asset (legacy/malformed fill). The caller supplies it — the matched slot's
 * type, or a SPREAD slot's price-vs-startPrice resolution
 * (`resolveSpreadOrderSide`) — so the SPREAD policy stays with the site that
 * has the price ladder. A fallback that is not BUY/SELL yields `null`: the
 * side is never guessed from a price here.
 *
 * @param paysAssetId - Asset the fill paid (chain `pays.asset_id`)
 * @param assets - Asset pair (ids only; precisions are not needed)
 * @param fallbackType - Side to use when no pays asset identifies one
 * @returns 'buy' | 'sell' | null
 */
function resolveTradedSide(
    paysAssetId: unknown,
    assets: FillSideAssets | null | undefined,
    fallbackType?: unknown,
): string | null {
    const a = assets?.assetA?.id;
    const b = assets?.assetB?.id;
    if (paysAssetId != null && b != null && paysAssetId === b) return ORDER_TYPES.BUY;
    if (paysAssetId != null && a != null && paysAssetId === a) return ORDER_TYPES.SELL;
    if (fallbackType === ORDER_TYPES.BUY || fallbackType === ORDER_TYPES.SELL) return fallbackType;
    return null;
}

/**
 * Is this fill already booked?
 *
 * Reads the persisted dedupe authority (`ProcessedFillStore.tracker`) without
 * mutating it. `_isNewFillKey` (bot level) still owns the *claim* — this is
 * the membership question the accounting path asks before it books a credit.
 * An unreadable store is reported as `false` (not booked) deliberately: the
 * caller keeps its existing claim path, and a missing tracker cannot be turned
 * into a silent double credit by this helper.
 */
function isFillBooked(store: FillBookedStore | null | undefined, fillKey: string | null | undefined): boolean {
    if (!fillKey) return false;
    const tracker = store?.tracker;
    if (!(tracker instanceof Map)) return false;
    return tracker.has(fillKey);
}

export { fillKeyOf, resolveTradedSide, isFillBooked };

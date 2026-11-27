/**
 * Single owner of the in-memory one-counter-per-fill obligation ledger.
 *
 * A full fill on either rail owes exactly one counter order on the opposite
 * rail. The debt is keyed by chain fill identity, never by the grid slot id
 * (a regeneration can re-use slot ids). Partial residuals and dust-cancel
 * synthetic fills owe nothing: their slot is still live, or the cancellation
 * is maintenance rather than a trade.
 *
 * Nothing here is persisted, and no funds are reserved: sizing stays driven
 * by the side budget. Debts are settled only when their stamped op is
 * confirmed through `clearCounterDebtsFromContexts` in the COW runtime.
 */

import { ORDER_TYPES } from '../../constants.js';
import { fillKeyOf } from '../fill_ledger.js';
import { resolveGapSlots } from './math.js';
import { parseSlotIndex } from './slot.js';
import type { OrderManagerLike, CounterDebtEntry } from '../../types.js';

// Hard bound on unsatisfied obligations. Matches the pending-crawl ledger cap
// in strategy.ts: an unsatisfiable debt (no rail slot, direction-rule block,
// phantom CREATE) must not accumulate forever and turn every plan into an
// O(debts x slots) scan. Deferred-first (then oldest) eviction keeps the
// freshest fills owed without dropping an in-flight stamped counter.
const MAX_COUNTER_DEBTS = 500;

// Diagnostics must never abort fill attribution: this helper is called from
// the fill pipeline, where a throwing logger would lose the whole fill.
function safeWarn(manager: OrderManagerLike, msg: string): void {
    try { manager.logger?.log?.(msg, 'warn'); } catch { /* best-effort */ }
}

export interface CounterFillInput {
    id?: string;
    type?: string;
    price?: number;
    size?: number;
    isPartial?: boolean;
    isDelayedRotationTrigger?: boolean;
    orderId?: string | null;
    blockNum?: number;
    block_num?: number;
    historyId?: string;
}

/**
 * Record the counter obligation for a fill. Returns true only for a new debt
 * (re-delivery replaces the entry without minting a second obligation).
 */
export function recordCounterDebt(manager: OrderManagerLike, fill: CounterFillInput): boolean {
    if (fill.isPartial === true || fill.isDelayedRotationTrigger === true) return false;
    if (fill.type !== ORDER_TYPES.BUY && fill.type !== ORDER_TYPES.SELL) return false;
    try {
        const debt = manager._counterDebt;
        if (!(debt instanceof Map)) return false;
        const fillIdx = typeof fill.id === 'string' ? parseSlotIndex(fill.id) : null;
        const gap = resolveGapSlots(manager as never, manager._genesis?.gapSlots, manager.config ?? undefined);
        if (fillIdx == null || !Number.isFinite(gap) || gap < 0) return false;
        // `fill.id` is the GRID SLOT id and must never be used as the chain
        // history id: a regeneration could otherwise mint a second debt for
        // the same trade.
        const chainKey = fillKeyOf({
            orderId: fill.orderId ?? undefined,
            blockNum: fill.blockNum ?? fill.block_num,
            historyId: fill.historyId
        });
        const key = chainKey ?? `${fill.id ?? 'unknown'}|${String(fill.orderId ?? '')}|${String(fill.price ?? '')}`;
        // With a zero-width gap the fill and counter slots share a price,
        // which the direction rule blocks; step one rung across the pivot.
        const offset = gap > 0 ? gap : 1;
        const counterIdx = fill.type === ORDER_TYPES.SELL ? fillIdx - offset : fillIdx + offset;
        const prior = debt.get(key);
        const entry: CounterDebtEntry = {
            fillKey: key,
            fillSide: String(fill.type),
            fillSlotId: String(fill.id),
            counterSide: fill.type === ORDER_TYPES.SELL ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            counterSlotId: `slot-${Math.max(0, counterIdx)}`,
            at: prior?.at ?? Date.now(),
            attempts: prior?.attempts ?? 0,
            lastDeferReason: prior?.lastDeferReason
        };
        debt.set(key, entry);
        if (!prior) {
            // Prefer an UNSELECTED debt: resolveCounterQuota clears
            // lastDeferReason when it selects a debt into the current plan, so
            // evicting a deferred entry cannot invalidate an in-flight stamped
            // op. Only when every entry is selected do we fall back to the
            // oldest insertion (Map order is stable on re-delivery).
            while (debt.size > MAX_COUNTER_DEBTS) {
                let oldest: string | undefined;
                for (const [k, v] of debt) {
                    if (v.lastDeferReason) { oldest = k; break; }
                }
                if (oldest == null) oldest = debt.keys().next().value as string | undefined;
                if (oldest == null) break;
                debt.delete(oldest);
                safeWarn(manager, `[COUNTER-DEBT] Dropped oldest debt ${oldest}: ledger cap ${MAX_COUNTER_DEBTS} reached`);
            }
            if (manager._metrics) {
                manager._metrics.counterOrdersOwedCount = (manager._metrics.counterOrdersOwedCount || 0) + 1;
                manager._metrics.counterDebtSlotsCount = debt.size;
            }
        }
        return !prior;
    } catch (err) {
        // The single owner of the guarantee must not fail silently: a malformed
        // manager or a throwing resolver otherwise loses a counter with no
        // trace. Ordinary partial/type early-returns above stay quiet.
        safeWarn(manager,
            `[COUNTER-DEBT] Could not record obligation for fill ${String(fill.id ?? '')}: ${String(err)}`);
        return false;
    }
}

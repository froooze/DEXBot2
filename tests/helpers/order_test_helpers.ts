/**
 * Verify that every entry in a manager's orders Map is structurally sound
 * (non-null, has state and type).  Replaces the removed validateIndices().
 */
export function assertOrdersStructurallySound(manager: any): void {
    for (const [id, order] of manager.orders) {
        if (!order) throw new Error(`Index corruption: ${id} exists in orders Map but is null/undefined`);
        if (!order.state) throw new Error(`Index corruption: ${id} has no state`);
        if (!order.type) throw new Error(`Index corruption: ${id} has no type`);
    }
}

/**
 * Build a frozen price ladder (genesis) for a test manager.
 *
 * The engine is genesis-frozen: `slot-<idx>` IS its price, and the sync/load
 * gates REFUSE a populated grid with no ladder (INV-GRID-004), so every test
 * that syncs needs one. Levels are derived exactly the way `createOrderGrid`
 * does (derivePriceLevels), so a fixture can never disagree with a real build.
 *
 * @param {Object} [opts]
 * @param {number} [opts.startPrice=100] - Center level (level `count-1`).
 * @param {number} [opts.incrementPercent=1] - Rail step, in percent.
 * @param {number} [opts.count=11] - Number of levels (odd -> symmetric).
 * @param {number} [opts.gapSlots=0] - Gap geometry (spread band) size.
 * @returns {any} A `GridGenesis` with a `levelAt(idx)` convenience.
 */
export function makeTestGenesis(opts: {
    startPrice?: number;
    incrementPercent?: number;
    count?: number;
    gapSlots?: number;
} = {}): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const math = require('../../modules/order/utils/math.js');
    const startPrice = opts.startPrice ?? 100;
    const incrementPercent = opts.incrementPercent ?? 1;
    const count = Math.max(3, opts.count ?? 11);
    const gapSlots = opts.gapSlots ?? 0;
    const half = Math.floor(count / 2);
    const minPrice = startPrice * Math.pow(1 + incrementPercent / 100, -half);
    const maxPrice = startPrice * Math.pow(1 + incrementPercent / 100, half);
    const priceLevels = math.derivePriceLevels(startPrice, minPrice, maxPrice, incrementPercent);
    const genesis = math.buildGenesisFromPriceLevels(startPrice, incrementPercent, gapSlots, priceLevels);
    genesis.levelAt = (idx: number) => math.priceForSlot(idx, genesis);
    return genesis;
}

/**
 * Attach a test ladder to a manager under test (or return a ready-made one).
 * Mirrors what `loadGrid` / `createOrderGrid` do in production, so the sync
 * gates see a supported state rather than the refused one.
 */
export function withTestGenesis<T>(target: any, opts: Parameters<typeof makeTestGenesis>[0] = {}): T {
    const genesis = makeTestGenesis(opts);
    if (target && typeof target === 'object') target._genesis = genesis;
    return genesis as T;
}

/**
 * Build a frozen ladder out of an explicit set of prices (ascending, deduped).
 *
 * For harnesses whose slots already carry hand-picked prices: the ladder then
 * contains every level the fixture uses, so the genesis-gated checks
 * (`priceSlotEqual` against a slot's own level, reserve-edge anchoring) behave
 * exactly as they do in production instead of taking the refused ladder-less
 * path.
 */
export function makeLadderFromPrices(prices: number[], opts: { gapSlots?: number; incrementPercent?: number } = {}): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const math = require('../../modules/order/utils/math.js');
    const levels = [...new Set(prices.filter((p) => Number.isFinite(p)).map((p) => Number(p)))].sort((a, b) => a - b);
    const safe = levels.length > 0 ? levels : [1];
    const incrementPercent = opts.incrementPercent ?? 1;
    const genesis = math.buildGenesisFromPriceLevels(safe[0], incrementPercent, opts.gapSlots ?? 0, safe);
    genesis.levelAt = (idx: number) => math.priceForSlot(idx, genesis);
    return genesis;
}

/**
 * Age a chain-id assignment so the absence guard no longer defers.
 *
 * The engine treats a chain id learned within `SYNC_LOCK_TIMEOUT_MS` as "the
 * snapshot may not be able to show it yet", so an absence decision defers for
 * that window (`LifecycleView.isInFlight()` — the single guard shared by the sync
 * pass-1 phantom cleanup, the startup reconcile and the fund recalibration
 * sweep). A fixture that places an order by calling `_updateOrder` and then
 * asserts the very next sync VIRTUALIZES it must therefore age the stamp: in
 * production that state ("placed, never committed, absent from the book") is
 * only reached once the placement is old enough for a read to have caught up.
 *
 * @param manager - Test manager (OrderManager or a shaped double)
 * @param orderId - Chain order id whose assignment should look settled
 * @param [ageMs] - Age to apply (defaults to just past twice the guard window)
 */
export function ageChainIdAssignment(manager: any, orderId: string, ageMs?: number): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const timing = require('../../modules/constants.js').TIMING;
    const guard = Number(timing.SYNC_LOCK_TIMEOUT_MS) || 20000;
    const age = Number.isFinite(Number(ageMs)) ? Number(ageMs) : guard * 2 + 1000;
    if (manager?._orderIdAssignedAt instanceof Map && orderId) {
        manager._orderIdAssignedAt.set(String(orderId), Date.now() - age);
    }
}

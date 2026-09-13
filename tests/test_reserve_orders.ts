/**
 * tests/test_reserve_orders.ts
 *
 * Reserve ladder (edge-pinned fat-finger insurance): extra live orders resting
 * at the grid edges, outside activeOrders window accounting, no boundary crawl.
 * Buys pin at the floor, sells at the ceiling.
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, COW_ACTIONS } = require('../modules/constants');
const {
    resolveReserveCount,
    resolveReserveOrders,
    resolveReserveEdgeAnchorPrice,
    resolveLiveReserveEdgeAnchorPrice,
    reserveEdgeIdSet,
    liveWindowIdSet,
    compareReserveEdge,
    selectReserveEdgeSlots,
    deriveTargetBoundary,
    getActiveOrdersTotal,
    collectRefillSlotIds,
} = require('../modules/order/utils/order');

const { _setFeeCache } = require('../modules/order/utils/math');
const { reconcileGrid, optimizeRebalanceActions } = require('../modules/order/utils/validate');
const { _reconcileStartupSide, _countActiveOnGrid, _pickVirtualSlotsToActivate } = require('../modules/order/grid_reconcile_internal');
const { countLiveReserveOrders, getTargetedSyncReason } = require('../modules/dexbot_maintenance_runtime');
_setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 }
    }
});

async function runTests() {
    console.log('Running Reserve Orders Tests...');

    console.log(' - resolveReserveCount clamps per-side config...');
    {
        assert.strictEqual(resolveReserveCount({}, 'buy'), 0, 'missing disables');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: 3 } }, 'buy'), 3, 'buy passes');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: 3 } }, 'sell'), 0, 'sell defaults 0');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { sell: 2.9 } }, 'sell'), 0, 'non-integer disables (matches validation)');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: -1 } }, 'buy'), 0, 'negative disables');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: 'x' } }, 'buy'), 0, 'garbage disables');
        assert.strictEqual(resolveReserveOrders({ reserveOrders: { buy: 2, sell: 1 } }), 3, 'total sums sides');
        assert.deepStrictEqual(DEFAULT_CONFIG.reserveOrders, { buy: 0, sell: 0 }, 'default off');
    }

    console.log(' - edge id sets anchor floor/ceiling...');
    {
        const slots = [
            { id: 'slot-9', price: 109, type: ORDER_TYPES.SELL },
            { id: 'slot-8', price: 108, type: ORDER_TYPES.SELL },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const floor = reserveEdgeIdSet(slots, { reserveOrders: { buy: 2, sell: 0 } }, ORDER_TYPES.BUY);
        assert(floor.has('slot-0') && floor.has('slot-1') && floor.size === 2, 'floor: lowest buys');
        const ceil = reserveEdgeIdSet(slots, { reserveOrders: { buy: 0, sell: 1 } }, ORDER_TYPES.SELL);
        assert(ceil.has('slot-9') && ceil.size === 1, 'ceiling: highest sells');
        const asc = slots.slice().sort((a, b) => a.price - b.price);
        assert.deepStrictEqual(
            selectReserveEdgeSlots(asc, 2, new Set(['slot-0']), 'floor').map((s) => s.id),
            ['slot-1', 'slot-2'],
            'selector skips windowed, floor first'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(asc, 1, new Set(), 'ceiling').map((s) => s.id),
            ['slot-9'],
            'selector takes ceiling last'
        );
    }
    console.log(' - edge anchors resolve bounds, selectors hold both insurance ends...');
    {
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ minPrice: 80 }, 'buy'), 80, 'numeric minPrice anchors buys');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ maxPrice: 120 }, 'sell'), 120, 'numeric maxPrice anchors sells');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ minPrice: '2x', startPrice: 100 }, 'buy'), 50, 'relative minPrice resolves via startPrice');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ maxPrice: '2x', startPrice: 100 }, 'sell'), 200, 'relative maxPrice resolves via startPrice');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({}, 'buy'), null, 'missing bound leaves legacy rank behavior');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ minPrice: 'x' }, 'buy'), null, 'garbage bound leaves legacy rank behavior');
        // Stale sub-anchor BUY (price 79 below the 80 anchor): anchored floor
        // picks hold the dip-insurance end instead of the stale rank-lowest slot.
        const stale = [
            { id: 'slot-9', price: 109, type: ORDER_TYPES.SELL },
            { id: 'slot-7', price: 79, type: ORDER_TYPES.BUY },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const anchoredFloor = reserveEdgeIdSet(stale, { reserveOrders: { buy: 2, sell: 0 } }, ORDER_TYPES.BUY, 80);
        assert(anchoredFloor.has('slot-0') && anchoredFloor.has('slot-1') && anchoredFloor.size === 2, 'floor ids anchor at/above the threshold');
        const legacyFloor = reserveEdgeIdSet(stale, { reserveOrders: { buy: 2, sell: 0 } }, ORDER_TYPES.BUY);
        assert(legacyFloor.has('slot-7') && legacyFloor.has('slot-0'), 'no anchor keeps legacy rank-lowest');
        const staleAsc = stale.slice().sort((a, b) => a.price - b.price);
        assert.deepStrictEqual(
            selectReserveEdgeSlots(staleAsc, 2, new Set(), 'floor', 80).map((s) => s.id),
            ['slot-0', 'slot-1'],
            'anchored floor selector skips stale sub-anchor slots'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(staleAsc, 2, new Set(), 'floor').map((s) => s.id),
            ['slot-7', 'slot-0'],
            'unanchored floor selector keeps legacy behavior'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(staleAsc, 2, new Set(['slot-0']), 'floor', 80).map((s) => s.id),
            ['slot-1', 'slot-2'],
            'anchored floor selector still skips windowed ids'
        );
        // Stale supra-anchor SELL (price 111 above the 109 anchor): anchored
        // ceiling picks hold the spike-insurance end instead of the stale top.
        const staleSell = [
            { id: 'slot-8', price: 108, type: ORDER_TYPES.SELL },
            { id: 'slot-9', price: 109, type: ORDER_TYPES.SELL },
            { id: 'slot-6', price: 111, type: ORDER_TYPES.SELL },
        ];
        const anchoredCeil = reserveEdgeIdSet(staleSell, { reserveOrders: { buy: 0, sell: 1 } }, ORDER_TYPES.SELL, 109);
        assert(anchoredCeil.has('slot-9') && anchoredCeil.size === 1, 'ceiling ids anchor at/below the threshold');
        const legacyCeil = reserveEdgeIdSet(staleSell, { reserveOrders: { buy: 0, sell: 1 } }, ORDER_TYPES.SELL);
        assert(legacyCeil.has('slot-6'), 'no anchor keeps legacy rank-highest');
        const sellAsc = staleSell.slice().sort((a, b) => a.price - b.price);
        assert.deepStrictEqual(
            selectReserveEdgeSlots(sellAsc, 2, new Set(), 'ceiling', 109).map((s) => s.id),
            ['slot-9', 'slot-8'],
            'anchored ceiling selector skips stale supra-anchor slots'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(sellAsc, 2, new Set(), 'ceiling').map((s) => s.id),
            ['slot-6', 'slot-9'],
            'unanchored ceiling selector keeps legacy behavior'
        );
    }
    console.log(' - compareReserveEdge shared comparator (single source)...');
    {
        const rows = [
            { id: 'sub', price: 79, type: ORDER_TYPES.BUY },
            { id: 'near-in', price: 80, type: ORDER_TYPES.BUY },
            { id: 'far-in', price: 82, type: ORDER_TYPES.BUY },
            { id: 'far-out', price: 78, type: ORDER_TYPES.BUY },
        ];
        const sortedFloor = rows.slice().sort((a, b) => compareReserveEdge(a, b, 'floor', 80));
        assert.deepStrictEqual(
            sortedFloor.map((s) => s.id),
            ['near-in', 'far-in', 'sub', 'far-out'],
            'floor comparator: in-bound nearest first, out-of-bound nearest last'
        );
        const sortedNoAnchor = rows.slice().sort((a, b) => compareReserveEdge(a, b, 'floor', null));
        assert.deepStrictEqual(
            sortedNoAnchor.map((s) => s.id),
            ['far-out', 'sub', 'near-in', 'far-in'],
            'null anchor keeps rank-lowest fallback'
        );
        const sellRows = [
            { id: 'supra', price: 111, type: ORDER_TYPES.SELL },
            { id: 'near-in', price: 109, type: ORDER_TYPES.SELL },
            { id: 'far-in', price: 107, type: ORDER_TYPES.SELL },
            { id: 'far-out', price: 112, type: ORDER_TYPES.SELL },
        ];
        const sortedCeil = sellRows.slice().sort((a, b) => compareReserveEdge(a, b, 'ceiling', 109));
        assert.deepStrictEqual(
            sortedCeil.map((s) => s.id),
            ['near-in', 'far-in', 'supra', 'far-out'],
            'ceiling comparator mirrors floor toward maxPrice'
        );
        const sortedNoAnchorCeil = sellRows.slice().sort((a, b) => compareReserveEdge(a, b, 'ceiling', null));
        assert.deepStrictEqual(
            sortedNoAnchorCeil.map((s) => s.id),
            ['far-out', 'supra', 'near-in', 'far-in'],
            'null anchor keeps rank-highest fallback'
        );
    }


    console.log(' - live edge anchors come from the grid geometry (ladder first)...');
    {
        const levels = [80, 81, 82, 83, 84, 85, 86, 87, 88, 89];
        const poolCfg = { startPrice: 'pool', minPrice: '3x', maxPrice: '3x', reserveOrders: { buy: 2, sell: 1 } };
        const genManager = {
            config: poolCfg,
            _genesis: { priceLevels: levels, startPrice: 84 },
            orders: new Map(),
            boundaryIdx: 4,
            _gapSlots: 2,
        };
        assert.strictEqual(resolveReserveEdgeAnchorPrice(poolCfg, 'buy'), null, 'config-only anchor stays null for pool + relative bounds');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(genManager, 'buy'), 80, 'ladder floor anchors the buy edge');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(genManager, 'sell'), 89, 'ladder ceiling anchors the sell edge');

        // The live ladder beats a divergent/stale configured bound.
        const divergent = { ...genManager, config: { ...poolCfg, minPrice: 120, maxPrice: 200 } };
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(divergent, 'buy'), 80, 'live ladder beats the configured floor');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(divergent, 'sell'), 89, 'live ladder beats the configured ceiling');

        // A leftover slot below the live floor ranks last, so the reserve stays
        // on live-rail slots — the behavior the null config anchor could not
        // deliver.
        const rail = [
            { id: 'slot-x', price: 79, type: ORDER_TYPES.BUY },
            ...levels.slice(0, 5).map((price, i) => ({ id: `slot-${i}`, price, type: ORDER_TYPES.BUY })),
        ].sort((a, b) => a.price - b.price);
        const liveFloorAnchor = resolveLiveReserveEdgeAnchorPrice(genManager, 'buy');
        assert.deepStrictEqual(
            selectReserveEdgeSlots(rail, 2, new Set(), 'floor', liveFloorAnchor).map((s) => s.id),
            ['slot-0', 'slot-1'],
            'live-anchored floor skips the sub-floor leftover'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(rail, 2, new Set(), 'floor', null).map((s) => s.id),
            ['slot-x', 'slot-0'],
            'null anchor keeps the leftover first (legacy)'
        );

        // Tier 2: no genesis -> live in-rail extreme of the master grid.
        // Non-grid shelf/manual ids (e.g. a fork-kept deep-* order below the
        // rail) never drag the anchor: isSlotInRail is fail-open for
        // unparseable ids, so the Tier 2 scan skips them explicitly
        // (issue #27 follow-up) and the live rail floor wins.
        assert.strictEqual(
            resolveLiveReserveEdgeAnchorPrice({
                config: poolCfg,
                _genesis: null,
                orders: new Map(rail.map((s) => [s.id, { ...s }])),
                boundaryIdx: 4,
                _gapSlots: 2,
            }, 'buy'),
            80,
            'no genesis falls back to the live in-rail extreme (shelf ids skipped)'
        );

        // Tier 3/4: nothing to read -> config bound, then legacy null.
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice({ config: poolCfg }, 'buy'), null, 'no geometry + unresolvable config keeps legacy rank');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice({ config: { minPrice: 80, startPrice: 'pool' } }, 'buy'), 80, 'no geometry falls back to the config bound');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(null, 'buy'), null, 'missing manager keeps legacy rank');
    }

    console.log(' - no-crawl classification follows the live edge anchor...');
    {
        const slots = [
            { id: 'slot-7', price: 79, type: ORDER_TYPES.BUY },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const cfg = { startPrice: 'pool', minPrice: '3x', maxPrice: '3x', reserveOrders: { buy: 2, sell: 0 } };
        const configAnchored = reserveEdgeIdSet(slots, cfg, ORDER_TYPES.BUY);
        const liveAnchored = reserveEdgeIdSet(slots, cfg, ORDER_TYPES.BUY, 80);
        assert(configAnchored && configAnchored.has('slot-7'), 'unresolved config anchor classifies the leftover as a reserve');
        assert(liveAnchored && liveAnchored.has('slot-0') && liveAnchored.has('slot-1') && !liveAnchored.has('slot-7'), 'live anchor keeps classification inside the live rail');
    }

    console.log(' - shelf/manual ids are never reserves (issue #27 follow-up)...');
    {
        // Fork-kept shelf orders below the rail (non-slot-N ids, live on-chain)
        // must not be counted as the reserve edge in any anchor outcome:
        // otherwise the deficit can never appear while the shelf is live and
        // the targeted-sync reserve reason stays silent.
        const shelfSlots = [
            { id: 'deep-1', price: 70, type: ORDER_TYPES.BUY },
            { id: 'deep-0', price: 71, type: ORDER_TYPES.BUY },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const shelfCfg = { reserveOrders: { buy: 2, sell: 0 } };
        const rankFallback = reserveEdgeIdSet(shelfSlots, shelfCfg, ORDER_TYPES.BUY);
        assert(rankFallback && rankFallback.has('slot-0') && rankFallback.has('slot-1') && rankFallback.size === 2, 'rank fallback skips shelf ids');
        const anchored = reserveEdgeIdSet(shelfSlots, shelfCfg, ORDER_TYPES.BUY, 80);
        assert(anchored && anchored.has('slot-0') && anchored.has('slot-1') && anchored.size === 2, 'finite anchor skips shelf ids');
        // Shelf-only grid: empty edge set, so the deficit (0/2) can fire.
        const shelfOnly = reserveEdgeIdSet(shelfSlots.slice(0, 2), shelfCfg, ORDER_TYPES.BUY, 80);
        assert(shelfOnly && shelfOnly.size === 0, 'no rail slots means no live reserves');
        // Tier 2 anchor scan skips shelf ids even though isSlotInRail is
        // fail-open for unparseable ids: the live rail floor wins.
        const shelfManager = {
            config: { startPrice: 'pool', minPrice: '3x', maxPrice: '3x' },
            _genesis: null,
            orders: new Map(shelfSlots.map((s) => [s.id, { ...s }])),
            boundaryIdx: 4,
            _gapSlots: 2,
        };
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(shelfManager, 'buy'), 80, 'shelf ids never drag the live anchor');
    }

    console.log(' - getActiveOrdersTotal includes both sides...');
    {
        assert.strictEqual(
            getActiveOrdersTotal({ activeOrders: { buy: 5, sell: 5 }, reserveOrders: { buy: 2, sell: 1 } }),
            13,
            'buy+sell+reserves'
        );
        assert.strictEqual(
            getActiveOrdersTotal({ activeOrders: { buy: 5, sell: 5 } }),
            10,
            'no reserve unchanged'
        );
    }

    console.log(' - reserve fills never crawl the boundary...');
    {
        const allSlots = [];
        for (let i = 0; i < 10; i++) {
            allSlots.push({ id: `slot-${i}`, price: 80 + i, type: i < 8 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL });
        }
        const cfg = {
            startPrice: 100,
            activeOrders: { buy: 3, sell: 3 },
            reserveOrders: { buy: 2, sell: 1 },
        };
        const floorFill = [{ id: 'slot-0', type: ORDER_TYPES.BUY }];
        const ceilFill = [{ id: 'slot-9', type: ORDER_TYPES.SELL }];
        const midBuy = [{ id: 'slot-5', type: ORDER_TYPES.BUY }];
        const midSell = [{ id: 'slot-8', type: ORDER_TYPES.SELL }];
        assert.strictEqual(
            deriveTargetBoundary(floorFill, 5, allSlots, cfg, 2, null).boundaryIdx, 5,
            'floor buy fill holds'
        );
        assert.strictEqual(
            deriveTargetBoundary(ceilFill, 5, allSlots, cfg, 2, null).boundaryIdx, 5,
            'ceiling sell fill holds'
        );
        assert.strictEqual(
            deriveTargetBoundary(midBuy, 5, allSlots, cfg, 2, null).boundaryIdx, 4,
            'window buy fill crawls down'
        );
        assert.strictEqual(
            deriveTargetBoundary(midSell, 5, allSlots, cfg, 2, null).boundaryIdx, 6,
            'window sell fill crawls up'
        );
    }

    console.log(' - live edge anchors drive no-crawl classification...');
    {
        const allSlots = [
            { id: 'slot-7', price: 50, type: ORDER_TYPES.BUY },      // stray below the live floor (idx 0)
            ...Array.from({ length: 5 }, (_, i) => ({ id: `slot-${i}`, price: 80 + i, type: ORDER_TYPES.BUY })), // idx 1..5
            { id: 'gap-0', price: 85, type: ORDER_TYPES.SPREAD },
            { id: 'gap-1', price: 86, type: ORDER_TYPES.SPREAD },
            { id: 'slot-8', price: 90, type: ORDER_TYPES.SELL },     // idx 8
            { id: 'slot-9', price: 91, type: ORDER_TYPES.SELL },
        ];
        const cfg = {
            startPrice: 'pool', minPrice: '3x', maxPrice: '3x',
            activeOrders: { buy: 2, sell: 1 },
            reserveOrders: { buy: 2, sell: 0 },
        };
        const strayFill = [{ id: 'slot-7', type: ORDER_TYPES.BUY }];
        const liveAnchors = { buy: 80, sell: 91 };
        assert.strictEqual(
            deriveTargetBoundary(strayFill, 5, allSlots, cfg, 2, null).boundaryIdx, 5,
            'without live anchors the stray is classified as a reserve and holds the boundary'
        );
        assert.strictEqual(
            deriveTargetBoundary(strayFill, 5, allSlots, cfg, 2, null, null, liveAnchors).boundaryIdx, 4,
            'with live anchors the stray is ordinary market movement and crawls'
        );
        assert.strictEqual(
            deriveTargetBoundary([{ id: 'slot-0', type: ORDER_TYPES.BUY }], 5, allSlots, cfg, 2, null, null, liveAnchors).boundaryIdx, 5,
            'real live-floor reserve fills still never crawl'
        );
    }

    console.log(' - reserve activation uses stored sizes only (no re-derivation)...');
    {
        const makeMgr = async (size: number, type: string, liveReserveIds: string[] = []) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: 3, sell: 2 }, weightDistribution: { sell: 0.5, buy: 0.5 },
                reserveOrders: { buy: 2, sell: 1 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = {
                assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' },
            };
            await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = 9;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 14; i++) {
                const live = liveReserveIds.includes(`slot-${i}`);
                await mgr._updateOrder({
                    id: `slot-${i}`,
                    type: live ? ORDER_TYPES.BUY : type,
                    price: 80 + i,
                    size: live ? 100 : size,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            return mgr;
        };
        const planBuy = async (mgr: any) => {
            const plannedCreates: any[] = [];
            await _reconcileStartupSide({
                orderType: ORDER_TYPES.BUY, targetCount: 5,
                chainSideOrders: [], unmatchedSideOrders: [],
                manager: mgr, chainOrders: {}, account: 'acct', privateKey: 'pk',
                dryRun: true, plannedCreates, plannedUpdates: [], plannedCancels: [], planOnly: true,
            });
            return plannedCreates.map((c: any) => ({ id: c.gridOrder?.id, size: Number(c.gridOrder?.size) }));
        };

        // Steady state: the edge reserves are planned with the size the grid
        // already carries — never a locally re-derived one.
        const sizedPlan = await planBuy(await makeMgr(100, ORDER_TYPES.BUY));
        const sizedEdge = sizedPlan.filter((p) => p.id === 'slot-0' || p.id === 'slot-1');
        assert.strictEqual(sizedEdge.length, 2, 'sized reserves planned at the live edge');
        assert.deepStrictEqual(sizedEdge.map((p) => p.size), [100, 100], 'reserve size is the stored size, untouched');

        // Unsized edge (fresh grid / virtualized slot): nothing is invented. The
        // reserve share of the deficit is held back for the edge instead of being
        // filled with middle window slots, so the target-grid sizing pipeline
        // creates them at the edge directly (no place-then-rotate churn).
        const unsizedPlan = await planBuy(await makeMgr(0, ORDER_TYPES.SPREAD));
        const unsizedIds = unsizedPlan.map((p) => p.id);
        assert(!unsizedIds.includes('slot-0') && !unsizedIds.includes('slot-1'), 'unsized reserves are not activated');
        assert.deepStrictEqual(unsizedIds, ['slot-9', 'slot-8', 'slot-7'], 'window only, closest-to-market first');
        assert.strictEqual(unsizedPlan.length, 3, 'reserve share of the deficit held back for the edge');

        // Live reserves on-chain + empty window: the deficit is window-only, so
        // nothing is held back (a live reserve is already matchedOnGrid and must
        // not shrink the window plan).
        const livePlan = await planBuy(await makeMgr(0, ORDER_TYPES.SPREAD, ['slot-0', 'slot-1']));
        assert.deepStrictEqual(
            livePlan.map((p) => p.id), ['slot-9', 'slot-8', 'slot-7'],
            'live reserves do not shrink the window plan'
        );

        // Reconcile placement agrees with reserve classification: a kept
        // virtual non-grid shelf (non-slot-N id below the rail, e.g.
        // fork-injected deep-*) is never activated as a reserve, in both
        // the anchored case (gated live-edge anchor keeps it out-of-bound
        // and ranks it last) and the rank-fallback case (slot-N gate in
        // _pickEdgeReserveSlots, since isSlotInRail is fail-open for
        // unparseable ids) — issue #27 follow-up.
        const shelfMgr = await makeMgr(100, ORDER_TYPES.BUY);
        await shelfMgr._updateOrder({
            id: 'deep-a', type: ORDER_TYPES.BUY, price: 70,
            size: 100, state: ORDER_STATES.VIRTUAL, orderId: null,
        });
        const shelfPlanIds = (await planBuy(shelfMgr)).map((p) => p.id);
        assert(!shelfPlanIds.includes('deep-a'), 'non-slot-N shelf never activated as a reserve');
        assert(shelfPlanIds.includes('slot-0') && shelfPlanIds.includes('slot-1'), 'rail edge reserves still placed');
    }

    console.log(' - target grid unions window + edges (middle stays VIRTUAL)...');
    {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
            activeOrders: { buy: 3, sell: 2 }, weightDistribution: { sell: 0.5, buy: 0.5 },
            reserveOrders: { buy: 2, sell: 1 },
        });
        mgr.logger.level = 'silent';
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        await mgr.resetFunds();
        mgr._gapSlots = 0;
        mgr.boundaryIdx = 9;
        mgr.pauseFundRecalc();
        for (let i = 0; i < 14; i++) {
            await mgr._updateOrder({
                id: `slot-${i}`, type: i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                price: 80 + i, size: 100, state: ORDER_STATES.VIRTUAL,
            });
        }
        await mgr.resumeFundRecalc();

        const StrategyEngine = require('../modules/order/strategy').default;
        const strategy = new StrategyEngine(mgr);
        // Funded snapshot: strategy budgets off allocated funds, and an empty
        // harness manager allocates nothing on its own.
        const funds = { ...mgr.funds, allocatedBuy: 10000, allocatedSell: 100 };
        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: mgr.orders,
            config: mgr.config,
            accountAssets: mgr.assets,
            funds,
            fills: [],
            currentBoundaryIdx: mgr.boundaryIdx,
        });
        assert.strictEqual(boundaryIdx, 9, 'no fills, boundary holds');
        const activeBuys = [...targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE
        );
        const activeSells = [...targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.ACTIVE
        );
        assert.strictEqual(activeBuys.length, 5, 'buy window 3 + floor 2 live');
        assert.strictEqual(activeSells.length, 3, 'sell window 2 + ceiling 1 live');
        const buyIds = new Set(activeBuys.map((o) => o.id));
        assert(buyIds.has('slot-0') && buyIds.has('slot-1'), 'floor pinned live');
        const sellIds = new Set(activeSells.map((o) => o.id));
        assert(sellIds.has('slot-13'), 'ceiling pinned live');
        const mid = targetGrid.get('slot-5');
        assert(mid && mid.state === ORDER_STATES.VIRTUAL, 'middle stays VIRTUAL');

        // Same grid, reserves off: windows only.
        const plain = strategy.calculateTargetGrid({
            frozenMasterGrid: mgr.orders,
            config: { ...mgr.config, reserveOrders: { buy: 0, sell: 0 } },
            accountAssets: mgr.assets,
            funds,
            fills: [],
            currentBoundaryIdx: mgr.boundaryIdx,
        });
        const plainBuys = [...plain.targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE
        );
        const plainSells = [...plain.targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.ACTIVE
        );
        assert.strictEqual(plainBuys.length, 3, 'no reserve means buy window only');
        assert.strictEqual(plainSells.length, 2, 'no reserve means sell window only');
    }

    console.log(' - refill wire excludes reserve CREATEs (boundary hold)...');
    {
        const slots: any[] = [];
        for (let i = 0; i < 14; i++) {
            slots.push({ id: `slot-${i}`, type: i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, price: 80 + i });
        }
        const actions = [
            { type: COW_ACTIONS.CREATE, id: 'slot-0' },
            { type: COW_ACTIONS.CREATE, id: 'slot-1' },
            { type: COW_ACTIONS.CREATE, id: 'slot-8' },
            { type: COW_ACTIONS.CREATE, id: 'slot-13' },
            { type: COW_ACTIONS.UPDATE, id: 'slot-9', newGridId: 'slot-2' },
        ];
        const cfg = { reserveOrders: { buy: 2, sell: 1 } };
        const anchors = { buy: 80, sell: 93 };
        const wire = collectRefillSlotIds(actions, { config: cfg, slots, edgeAnchors: anchors });
        assert.deepStrictEqual(wire, ['slot-8'],
            'floor/ceiling reserve CREATEs are not refills; the window CREATE stays');
        assert.deepStrictEqual(
            collectRefillSlotIds(actions, { config: cfg, slots: new Map(slots.map((s) => [s.id, s])), edgeAnchors: anchors }),
            ['slot-8'],
            'Map slots (the plan path passes manager.orders) classify like the array form'
        );
        const plainWire = ['slot-0', 'slot-1', 'slot-8', 'slot-13'];
        assert.deepStrictEqual(
            collectRefillSlotIds(actions, { config: { reserveOrders: { buy: 0, sell: 0 } }, slots }),
            plainWire,
            'disabled reserves keep the plain CREATE wire'
        );
        assert.deepStrictEqual(
            collectRefillSlotIds(actions, {}),
            plainWire,
            'no classification context (legacy callers) must not drop ids'
        );
        assert.deepStrictEqual(
            collectRefillSlotIds([{ type: COW_ACTIONS.CANCEL, id: 'slot-3' }, { type: COW_ACTIONS.CREATE }], {}),
            [],
            'cancel/malformed actions never enter the wire'
        );
    }

    console.log(' - COW plan path: reserve CREATEs never enter the refill wire...');
    {
        const mgr: any = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
            activeOrders: { buy: 3, sell: 2 }, weightDistribution: { sell: 0.5, buy: 0.5 },
            reserveOrders: { buy: 2, sell: 1 },
        });
        mgr.logger.level = 'silent';
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        await mgr.resetFunds();
        mgr._gapSlots = 0;
        mgr.boundaryIdx = 9;
        mgr.pauseFundRecalc();
        for (let i = 0; i < 14; i++) {
            await mgr._updateOrder({
                id: `slot-${i}`, type: i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                price: 80 + i, size: 100, state: ORDER_STATES.VIRTUAL,
            });
        }
        await mgr.resumeFundRecalc();

        const StrategyEngine = require('../modules/order/strategy').default;
        const strategy = new StrategyEngine(mgr);
        const funds = { ...mgr.funds, allocatedBuy: 10000, allocatedSell: 100 };
        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: mgr.orders,
            config: mgr.config,
            accountAssets: mgr.assets,
            funds,
            fills: [],
            currentBoundaryIdx: mgr.boundaryIdx,
        });
        const reconciled = reconcileGrid(mgr.orders, targetGrid, boundaryIdx, {
            logger: () => {},
            dustThresholdPercent: 0,
            assets: mgr.assets,
            gapSlots: mgr._gapSlots,
        });
        const optimized = optimizeRebalanceActions(reconciled.actions, mgr.orders, {
            assets: mgr.assets,
            boundaryIdx,
            gapSlots: mgr._gapSlots,
        });
        const edgeAnchors = {
            buy: resolveLiveReserveEdgeAnchorPrice(mgr, 'buy'),
            sell: resolveLiveReserveEdgeAnchorPrice(mgr, 'sell'),
        };
        const createIds = optimized
            .filter((a: any) => a?.type === COW_ACTIONS.CREATE && typeof a?.id === 'string')
            .map((a: any) => a.id);
        const wire = collectRefillSlotIds(optimized, { config: mgr.config, slots: mgr.orders, edgeAnchors });

        assert(createIds.includes('slot-0') && createIds.includes('slot-1') && createIds.includes('slot-13'),
            `fixture must plan the reserve edges as CREATEs (got ${createIds.join(', ')})`);
        assert(!wire.includes('slot-0') && !wire.includes('slot-1') && !wire.includes('slot-13'),
            `reserve CREATEs must never justify a boundary hold (wire: ${wire.join(', ')})`);
        assert(wire.includes('slot-7') && wire.includes('slot-10'),
            `window hole CREATEs stay in the wire (wire: ${wire.join(', ')})`);
    }

    console.log(' - window exclusion keeps counting and placement in agreement (issue #27 follow-up)...');
    {
        // Window + edge are additive in every target (orders, fees, hold-back),
        // and the placement pickers exclude window ids from the edge pick.
        // Classification must exclude them too: a window that reaches the grid
        // edge (keep-low window = bottom slots = floor edge) otherwise makes
        // the edge pick land on window members and the live-reserve count
        // reads N/N with zero dedicated reserves, so the deficit never fires.
        const slots = [
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
            { id: 'slot-3', price: 83, type: ORDER_TYPES.BUY },
        ];
        const cfg = { reserveOrders: { buy: 2, sell: 0 } };
        const ids = reserveEdgeIdSet(slots, cfg, ORDER_TYPES.BUY);
        assert.deepStrictEqual([...(ids || [])].sort(), ['slot-0', 'slot-1'], 'plain pick pins the floor edge');
        const excluded = reserveEdgeIdSet(slots, cfg, ORDER_TYPES.BUY, null, new Set(['slot-0', 'slot-1', 'slot-2', 'slot-3']));
        assert.strictEqual(excluded && excluded.size, 0, 'windowed ids are skipped, overlapping edge pick is empty');
        const partial = reserveEdgeIdSet(slots, cfg, ORDER_TYPES.BUY, null, new Set(['slot-0']));
        assert.deepStrictEqual([...(partial || [])].sort(), ['slot-1', 'slot-2'], 'partially windowed edge refills the count from the next floor slots');
    }

    console.log(' - liveWindowIdSet mirrors the picker window slice...');
    {
        const makeMgr = async (opts: { boundary: number; window: number; live: number[] }) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: opts.window, sell: 3 },
                reserveOrders: { buy: 2, sell: 0 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = { assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' } };
            await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = opts.boundary;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 14; i++) {
                const live = opts.live.includes(i);
                await mgr._updateOrder({
                    id: `slot-${i}`, type: i < opts.boundary ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                    price: 80 + i, size: 100,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            return mgr;
        };

        // Window slice is geometric (full rail, not live-only): buys closest to
        // market first, virtual holes included.
        const mgr = await makeMgr({ boundary: 10, window: 3, live: [0, 1, 8] });
        assert.deepStrictEqual(
            [...(liveWindowIdSet(mgr, ORDER_TYPES.BUY) || [])].sort(),
            ['slot-7', 'slot-8', 'slot-9'],
            'buy window = highest in-rail slots (closest to market)'
        );

        // Unknown boundary geometry: null (fail open — no exclusion).
        mgr.boundaryIdx = null as any;
        assert.strictEqual(liveWindowIdSet(mgr, ORDER_TYPES.BUY), null, 'null boundary fails open');
    }

    console.log(' - live-reserve count excludes window members (issue #27 follow-up)...');
    {
        const makeMgr = async (opts: { boundary: number; window: number; live: number[] }) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: opts.window, sell: 3 },
                reserveOrders: { buy: 2, sell: 0 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = { assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' } };
            await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = opts.boundary;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 14; i++) {
                const live = opts.live.includes(i);
                await mgr._updateOrder({
                    id: `slot-${i}`, type: i < opts.boundary ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                    price: 80 + i, size: 100,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            return mgr;
        };

        // THE overlap case: keep-low window = bottom 6 = floor edge (buy rail
        // is slot-0..5). Without exclusion the edge pick (slot-0, slot-1)
        // lands on live window orders and the count reads 2/2 with zero
        // dedicated reserves — the deficit never fires.
        const overlap = await makeMgr({ boundary: 6, window: 6, live: [0, 1, 2, 3, 4, 5] });
        assert.strictEqual(
            countLiveReserveOrders(overlap, overlap.config, ORDER_TYPES.BUY), 0,
            'window covering the floor edge counts zero dedicated reserves'
        );

        // Upstream default (closest window) never overlaps: window at the top
        // of the buy rail, dedicated reserves live at the floor.
        const control = await makeMgr({ boundary: 10, window: 6, live: [0, 1, 4, 5, 6, 7, 8, 9] });
        assert.strictEqual(
            countLiveReserveOrders(control, control.config, ORDER_TYPES.BUY), 2,
            'dedicated floor reserves still count under a closest window'
        );

        // Under-filled window must not swallow live reserves either (the slice
        // runs over the full rail, so floor reserves keep their identity).
        const partial = await makeMgr({ boundary: 10, window: 6, live: [0, 1, 8, 9] });
        assert.strictEqual(
            countLiveReserveOrders(partial, partial.config, ORDER_TYPES.BUY), 2,
            'live reserves count even when the window itself is under-filled'
        );
    }

    console.log(' - reserve deficit fires its own targeted-sync reason (issue #27)...');
    {
        // Original 26f1ab0 mechanism: target 6+2=8 vs 12 live — the window
        // shortfall (live >= target) stays silent while the reserve edge sits
        // empty. The reserve reason must fire independently (budget-gated).
        const makeTriggerMgr = async (liveIdx: number[]) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: 6, sell: 0 },
                reserveOrders: { buy: 2, sell: 0 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = { assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' } };
            await mgr.setAccountTotals({ buy: 100000, sell: 100, buyFree: 100000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = 14;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 16; i++) {
                const live = liveIdx.includes(i);
                await mgr._updateOrder({
                    id: `slot-${i}`, type: i < 14 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                    price: 80 + i, size: 100,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            (mgr as any).getChainFundsSnapshot = undefined;
            (mgr as any).checkFundDriftAfterFills = () => null;
            return mgr;
        };
        // Deficit with surplus: 12 live buys (slot-2..13), floor reserves
        // slot-0/1 virtual. Window shortfall silent (12 >= 8), reserve fires.
        const deficitMgr = await makeTriggerMgr([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
        assert.strictEqual(
            countLiveReserveOrders(deficitMgr, deficitMgr.config, ORDER_TYPES.BUY), 0,
            'floor reserves virtual while rail carries surplus'
        );
        const deficitReason: any = getTargetedSyncReason({ manager: deficitMgr, config: deficitMgr.config });
        assert(deficitReason && typeof deficitReason.reason === 'string', 'reserve deficit returns a reason');
        assert(
            deficitReason.reason.includes('buy reserves 0/2'),
            `reserve reason names the deficit (got: ${deficitReason.reason})`
        );
        assert(
            !deficitReason.reason.includes('buy 12/8'),
            `window surplus stays silent (got: ${deficitReason.reason})`
        );
        // Filled clears: floor reserves live + window live (8 >= 8) => null.
        const filledMgr = await makeTriggerMgr([0, 1, 8, 9, 10, 11, 12, 13]);
        assert.strictEqual(
            countLiveReserveOrders(filledMgr, filledMgr.config, ORDER_TYPES.BUY), 2,
            'floor reserves live once filled'
        );
        assert.strictEqual(
            getTargetedSyncReason({ manager: filledMgr, config: filledMgr.config }),
            null,
            'filled reserves clear the reason'
        );
        // Disabled reserves stay silent despite the same surplus.
        const disabledReason: any = getTargetedSyncReason({
            manager: deficitMgr,
            config: { ...deficitMgr.config, reserveOrders: { buy: 0, sell: 0 } },
        });
        assert.strictEqual(disabledReason, null, 'disabled reserves never fire');
        // Budget gate: no allocated funds suppresses the reserve reason.
        const brokeMgr: any = await makeTriggerMgr([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
        brokeMgr.getChainFundsSnapshot = () => ({ allocatedBuy: 0, allocatedSell: 0 });
        assert.strictEqual(
            getTargetedSyncReason({ manager: brokeMgr, config: brokeMgr.config }),
            null,
            'empty budget suppresses the reserve reason'
        );
    }

    console.log(' - startup excess plans matched cancels on a fully-placed grid (issue #27 follow-up)...');
    {
        // The vacancy question: on a fully-placed grid (every rail slot live,
        // zero virtual) there is no placement target and no window shortfall,
        // so only the startup excess path can cancel the surplus and create
        // room for the additive window+edge target. Startup reconcile always
        // plans (planOnly) and executes in Phase 2 — but the matched-excess
        // cancel leg used to exist only in the execute branch, so a fully
        // placed grid dropped its surplus silently and sat static forever.
        const makePlacedMgr = async (liveCount: number) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: 6, sell: 3 },
                reserveOrders: { buy: 2, sell: 0 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = { assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' } };
            await mgr.setAccountTotals({ buy: 100000, sell: 100, buyFree: 100000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = 12;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 14; i++) {
                const live = i < liveCount;
                await mgr._updateOrder({
                    id: `slot-${i}`, type: i < 12 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                    price: 80 + i, size: 100,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            return mgr;
        };
        const runStartup = async (mgr: any, chainBuys: any[], unmatched: any[]) => {
            const plannedCancels: any[] = [];
            const plannedCreates: any[] = [];
            await _reconcileStartupSide({
                orderType: ORDER_TYPES.BUY, targetCount: 8,
                chainSideOrders: chainBuys, unmatchedSideOrders: unmatched,
                manager: mgr, chainOrders: {}, account: 'acct', privateKey: 'pk',
                dryRun: true, plannedCreates, plannedUpdates: [], plannedCancels, planOnly: true,
            });
            return { plannedCancels, plannedCreates };
        };

        // THE fully-placed case: 12 live matched buys vs target 6+2=8. The
        // surplus is entirely on matched slots (unmatched is empty) — it must
        // still be planned, reserve edge slots last.
        const placed = await makePlacedMgr(12);
        const chainBuys = Array.from({ length: 12 }, (_, i) => ({ id: `1.7.${900 + i}` }));
        const placedPlan = await runStartup(placed, chainBuys, []);
        assert.strictEqual(placedPlan.plannedCancels.length, 4, 'surplus (12-8) matched cancels are planned');
        assert.deepStrictEqual(
            placedPlan.plannedCancels.map((c: any) => c.chainOrderId),
            ['1.7.902', '1.7.903', '1.7.904', '1.7.905'],
            'lowest non-reserve matched slots cancel first (post-state: floor reserves + closest window)'
        );
        const placedIds = new Set(placedPlan.plannedCancels.map((c: any) => c.chainOrderId));
        assert(!placedIds.has('1.7.900') && !placedIds.has('1.7.901'), 'floor reserve slots cancel last');
        assert.strictEqual(placedPlan.plannedCreates.length, 0, 'no creates on a fully-placed grid');

        // Mixed surplus: unmatched orphans plan first (releaseUntrackedFunds),
        // matched surplus fills the remaining budget — same priority as the
        // execute branch.
        const mixed = await makePlacedMgr(12);
        const orphan = {
            id: '1.7.950',
            sell_price: { base: { asset_id: '1.3.1', amount: 1000 }, quote: { asset_id: '1.3.0', amount: 80000 } },
            for_sale: 1000,
        };
        const mixedPlan = await runStartup(mixed, [...chainBuys, orphan], [orphan]);
        assert.strictEqual(mixedPlan.plannedCancels.length, 5, 'unmatched orphan + 4 matched surplus planned');
        assert.strictEqual(mixedPlan.plannedCancels[0].chainOrderId, '1.7.950', 'unmatched orphan cancels first');
        assert.strictEqual(mixedPlan.plannedCancels[0].releaseUntrackedFunds, true, 'orphans release untracked funds');
        assert.deepStrictEqual(
            mixedPlan.plannedCancels.slice(1).map((c: any) => c.chainOrderId),
            ['1.7.902', '1.7.903', '1.7.904', '1.7.905'],
            'matched surplus follows with the same selection as the execute branch'
        );

        // At target: no surplus, nothing planned (cancelCount clamps to 0).
        const atTarget = await makePlacedMgr(8);
        const atTargetPlan = await runStartup(atTarget, Array.from({ length: 8 }, (_, i) => ({ id: `1.7.${900 + i}` })), []);
        assert.strictEqual(atTargetPlan.plannedCancels.length, 0, 'at-target grid plans no cancels');

        // Plan/execute parity: the shared matchedExcess selection must produce
        // the identical cancel set in both branches (planning can never drift
        // from execution). Execute mode runs with a cancel stub and a resolved
        // _applySync (dryRun would short-circuit inside _cancelChainOrder).
        const parityPlan = await makePlacedMgr(12);
        const parityPlanned: any[] = [];
        await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY, targetCount: 8,
            chainSideOrders: chainBuys, unmatchedSideOrders: [],
            manager: parityPlan, chainOrders: {}, account: 'acct', privateKey: 'pk',
            dryRun: true, plannedCreates: [], plannedUpdates: [], plannedCancels: parityPlanned, planOnly: true,
        });
        const parityExec = await makePlacedMgr(12);
        const executedIds: string[] = [];
        const stubChain = {
            cancelOrder: async (_a: any, _p: any, orderId: string) => { executedIds.push(orderId); return {}; },
            createOrder: async () => ({}),
            readOpenOrders: async () => [],
        };
        await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY, targetCount: 8,
            chainSideOrders: chainBuys, unmatchedSideOrders: [],
            manager: parityExec, chainOrders: stubChain, account: 'acct', privateKey: 'pk',
            dryRun: false, plannedCreates: [], plannedUpdates: [], plannedCancels: [], planOnly: false,
        });
        assert.deepStrictEqual(
            parityPlanned.map((c: any) => c.chainOrderId).sort(),
            executedIds.sort(),
            'planOnly and execute select the identical excess cancel set'
        );
        const postExec = parityExec.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).filter((o: any) => o && o.orderId);
        assert.strictEqual(postExec.length, 8, 'execute branch converges to the window+edge target');
    }

    console.log(' - startup excess never cancels shelf/manual orders (issue #27 follow-up)...');
    {
        // Fork-kept shelf (non-slot-N ids, live below the rail with real manual
        // sizes) heads the cheapest-first matched sort — without the slot-N gate
        // the new matched-excess plan leg wipes it on the next boot. Shelf ids
        // must never appear in planned cancels (same gate as reserveEdgeIdSet).
        // No-op upstream (grids only mint slot-N).
        const makeShelfMgr = async (liveCount: number) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: 6, sell: 3 },
                reserveOrders: { buy: 2, sell: 0 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = { assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' } };
            await mgr.setAccountTotals({ buy: 100000, sell: 100, buyFree: 100000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = 12;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 14; i++) {
                const live = i < liveCount;
                await mgr._updateOrder({
                    id: `slot-${i}`, type: i < 12 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                    price: 80 + i, size: 100,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            return mgr;
        };
        const runShelfStartup = async (mgr: any, chainBuys: any[], unmatched: any[]) => {
            const plannedCancels: any[] = [];
            const plannedCreates: any[] = [];
            await _reconcileStartupSide({
                orderType: ORDER_TYPES.BUY, targetCount: 8,
                chainSideOrders: chainBuys, unmatchedSideOrders: unmatched,
                manager: mgr, chainOrders: {}, account: 'acct', privateKey: 'pk',
                dryRun: true, plannedCreates, plannedUpdates: [], plannedCancels, planOnly: true,
            });
            return { plannedCancels, plannedCreates };
        };
        const shelfMgr = await makeShelfMgr(12);
        shelfMgr.pauseFundRecalc();
        const shelfIds = [
            { id: 'deep-2', price: 70, orderId: '1.7.800' },
            { id: 'deep-1', price: 71, orderId: '1.7.801' },
            { id: 'deep-0', price: 72, orderId: '1.7.802' },
        ];
        for (const s of shelfIds) {
            await shelfMgr._updateOrder({
                id: s.id, type: ORDER_TYPES.BUY,
                price: s.price, size: 500,
                state: ORDER_STATES.ACTIVE,
                orderId: s.orderId,
            });
        }
        await shelfMgr.resumeFundRecalc();
        const railChain = Array.from({ length: 12 }, (_, i) => ({ id: `1.7.${900 + i}` }));
        const shelfChain = shelfIds.map((s) => ({ id: s.orderId }));
        const fullChain = [...railChain, ...shelfChain];
        // Shelf sits outside window accounting: chain 12 grid (shelf excluded)
        // vs target 8 => cancelCount 4, all from rail. The shelf surplus must
        // not fabricate extra cancels (issue #27 follow-up).
        const shelfPlan = await runShelfStartup(shelfMgr, fullChain, []);
        assert.deepStrictEqual(
            shelfPlan.plannedCancels.map((c: any) => c.chainOrderId),
            ['1.7.902', '1.7.903', '1.7.904', '1.7.905'],
            'cheapest non-reserve rail cancels first, floor reserves (900/901) last, shelf never a candidate'
        );
        const cancelled = new Set(shelfPlan.plannedCancels.map((c: any) => c.chainOrderId));
        for (const s of shelfIds) {
            assert(!cancelled.has(s.orderId), `shelf ${s.id} (${s.orderId}) is never a cancel candidate`);
        }
        assert(!cancelled.has('1.7.900') && !cancelled.has('1.7.901'), 'floor reserve slots cancel last');
        // Every planned cancel resolves to a slot-N grid slot.
        for (const c of shelfPlan.plannedCancels) {
            const slot = shelfMgr.orders.get((c.chainOrderObj as any)?.id);
            assert(slot && /^slot-\d+$/.test(String(slot.id)), `cancel candidate is slot-N (got ${String(slot?.id)})`);
        }
        // Plan/execute parity with shelf present: the execute branch selects
        // the identical set and leaves shelf + floor reserves + closest window.
        const execMgr = await makeShelfMgr(12);
        execMgr.pauseFundRecalc();
        for (const s of shelfIds) {
            await execMgr._updateOrder({
                id: s.id, type: ORDER_TYPES.BUY,
                price: s.price, size: 500,
                state: ORDER_STATES.ACTIVE,
                orderId: s.orderId,
            });
        }
        await execMgr.resumeFundRecalc();
        const executedIds: string[] = [];
        const stubChain = {
            cancelOrder: async (_a: any, _p: any, orderId: string) => { executedIds.push(orderId); return {}; },
            createOrder: async () => ({}),
            readOpenOrders: async () => [],
        };
        await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY, targetCount: 8,
            chainSideOrders: fullChain, unmatchedSideOrders: [],
            manager: execMgr, chainOrders: stubChain, account: 'acct', privateKey: 'pk',
            dryRun: false, plannedCreates: [], plannedUpdates: [], plannedCancels: [], planOnly: false,
        });
        assert.deepStrictEqual(
            executedIds.sort(),
            [...cancelled].sort(),
            'execute selects the identical shelf-safe cancel set'
        );
        const liveBuys = execMgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).filter((o: any) => o && o.orderId);
        // Grid count converges to target (8 rail); the shelf survives alongside
        // outside window accounting, so the raw live total reads 8 + 3.
        const gridBuys = liveBuys.filter((o: any) => /^slot-\d+$/.test(String(o.id)));
        assert.strictEqual(gridBuys.length, 8, 'grid count converges to target (8 rail, shelf excluded)');
        assert.strictEqual(liveBuys.length, 11, 'raw live total reads 8 rail + 3 shelf');
        const liveIds = new Set(liveBuys.map((o: any) => o.id));
        for (const s of shelfIds) {
            assert(liveIds.has(s.id), `shelf ${s.id} survives execution`);
        }
        for (const rid of ['slot-0', 'slot-1', 'slot-6', 'slot-7', 'slot-8', 'slot-9', 'slot-10', 'slot-11']) {
            assert(liveIds.has(rid), `rail survivor ${rid} stays live (floor reserves + closest window)`);
        }
    }

    console.log(' - shelf orders never inflate grid counts or mask shortfalls (issue #27 follow-up)...');
    {
        // Local maker (the shelf block above scopes its own): 14-slot grid,
        // first N buys live, no reserves in the base config.
        const makeCountMgr = async (liveCount: number) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: 6, sell: 3 },
                reserveOrders: { buy: 2, sell: 0 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = { assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' } };
            await mgr.setAccountTotals({ buy: 100000, sell: 100, buyFree: 100000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = 12;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 14; i++) {
                const live = i < liveCount;
                await mgr._updateOrder({
                    id: `slot-${i}`, type: i < 12 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                    price: 80 + i, size: 100,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            return mgr;
        };
        // _countActiveOnGrid gates to slot-N: a live shelf must not inflate
        // matchedOnGrid, or neededSlots/creates get suppressed.
        const mgr = await makeCountMgr(5);
        mgr.pauseFundRecalc();
        for (const s of [
            { id: 'deep-0', price: 70, orderId: '1.7.800' },
            { id: 'deep-1', price: 71, orderId: '1.7.801' },
        ]) {
            await mgr._updateOrder({
                id: s.id, type: ORDER_TYPES.BUY,
                price: s.price, size: 500,
                state: ORDER_STATES.ACTIVE,
                orderId: s.orderId,
            });
        }
        await mgr.resumeFundRecalc();
        assert.strictEqual(
            _countActiveOnGrid(mgr, ORDER_TYPES.BUY), 5,
            'matchedOnGrid counts 5 rail actives, shelf excluded'
        );
        // Startup creates: 5 rail live vs target 8 => 3 creates planned, not
        // suppressed to 0 by the 2 shelf orders.
        const plannedCancels: any[] = [];
        const plannedCreates: any[] = [];
        await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY, targetCount: 8,
            chainSideOrders: Array.from({ length: 5 }, (_, i) => ({ id: `1.7.${900 + i}` }))
                .concat([{ id: '1.7.800' }, { id: '1.7.801' }]),
            unmatchedSideOrders: [],
            manager: mgr, chainOrders: {}, account: 'acct', privateKey: 'pk',
            dryRun: true, plannedCreates, plannedUpdates: [], plannedCancels, planOnly: true,
        });
        assert.strictEqual(plannedCancels.length, 0, 'no surplus: shelf excluded from chainCount');
        assert(plannedCreates.length >= 3, `window shortfall creates 3 (got ${plannedCreates.length})`);
        // Targeted sync: 5 rail live + 2 shelf vs target 6+2=8 => the window
        // shortfall (5 < 8) must fire; shelf must not mask it to 7-8.
        (mgr as any).config = { ...(mgr as any).config, activeOrders: { buy: 6, sell: 0 }, reserveOrders: { buy: 2, sell: 0 } };
        (mgr as any).checkFundDriftAfterFills = () => null;
        const reason: any = getTargetedSyncReason({ manager: mgr, config: (mgr as any).config });
        assert(reason && typeof reason.reason === 'string', 'window shortfall returns a reason despite shelf');
        assert(
            reason.reason.includes('buy 5/8'),
            `shortfall names the grid count without shelf (got: ${reason.reason})`
        );
        // _pickVirtualSlotsToActivate never spends window budget on a VIRTUAL shelf.
        const shelfVirtualMgr = await makeCountMgr(5);
        shelfVirtualMgr.pauseFundRecalc();
        await shelfVirtualMgr._updateOrder({
            id: 'deep-9', type: ORDER_TYPES.BUY,
            price: 69, size: 500,
            state: ORDER_STATES.VIRTUAL,
        });
        await shelfVirtualMgr.resumeFundRecalc();
        const picks = _pickVirtualSlotsToActivate(shelfVirtualMgr, ORDER_TYPES.BUY, 8);
        assert(
            picks.every((p: any) => /^slot-\d+$/.test(String(p.id))),
            'window activation picks only slot-N ids'
        );
    }

    console.log('✓ Reserve orders tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});

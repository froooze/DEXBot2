/**
 * Boundary-anchor recovery + rail-edge telemetry.
 *
 * Production incident (<market-pair>): after GRID-LOAD rejected
 * the persisted boundary (96, sell stranded in-band) with no safe
 * re-derivation, the committed boundary stayed null — and the Sep-9 removal
 * of the fund-driven writer left fills as the only boundary mover. The first
 * fills after 14h quiet hit the null-boundary recovery, which ran
 * calculateIdealBoundary with config.startPrice="pool" (an unresolved mode
 * string). Every `price >= "pool"` comparison is false, so splitIdx fell
 * through to allSlots.length: base 213, ceiling-clamped to 211 for the
 * dust-sell batch, then 209 after 4 buy crawls. The window ran off the rail
 * top (2 sell slots), and ordinal pairing teleported live buys 77-92 up to
 * 190-205 (+48-58%). Cross-guard, boundary-hold and fund validation refused
 * the broadcast; the bot sat boundary-less with the poison (96) still on
 * disk, re-rejecting every restart (storeMasterGrid never persists null).
 *
 * The fix anchors recovery from live fill prices (gap-side extreme), then
 * numeric config, genesis, rail-center — never a rail-edge fabrication —
 * skips the crawl on fill-anchored recovery batches (the anchor already
 * contains the fill info; crawling would double-count; genesis/rail-center
 * anchors still crawl), and erases the poisoned snapshot
 * value on unrecoverable GRID-LOAD rejection. No rotation-distance filter:
 * with an honest anchor the teleport never plans in the first place.
 */

const assert = require('assert');
const {
    calculateIdealBoundary,
    deriveTargetBoundary,
} = require('../modules/order/utils/order');
const { COWRebalanceEngine } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

const GAP = 4;
const N_SLOTS = 216;

function buildSlots(count) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        slots.push({ id: `slot-${i}`, price: 0.001 + i * 0.000004 });
    }
    return slots;
}

const NUMERIC_CFG = {
    startPrice: 0.0015,
    coreOrders: { buy: 20, sell: 20 },
};
const POOL_CFG = {
    startPrice: 'pool',
    coreOrders: { buy: 20, sell: 20 },
};

async function testP0a_NonNumericReferenceFallsToCenter() {
    console.log('\n[ANCHOR-001] calculateIdealBoundary("pool") returns rail-center, not rail-top...');
    const b = calculateIdealBoundary(buildSlots(N_SLOTS), 'pool', GAP);
    assert.ok(b > 0 && b < N_SLOTS - GAP - 1,
        `"pool" reference must not fabricate a rail-edge boundary (got ${b})`);
    assert.strictEqual(b, Math.floor((N_SLOTS - 1 - GAP) / 2), 'expected rail-center fallback');
    console.log('✓ ANCHOR-001 passed');
}

async function testP0b_NumericReferenceUnchanged() {
    console.log('\n[ANCHOR-002] numeric reference still resolves the honest boundary...');
    const slots = buildSlots(N_SLOTS);
    const b = calculateIdealBoundary(slots, 0.0015, GAP);
    const split = slots.findIndex((s) => s.price >= 0.0015);
    assert.strictEqual(b, split - Math.floor(GAP / 2) - 1, 'honest boundary math unchanged');
    console.log('✓ ANCHOR-002 passed');
}

async function testP0c_NullBoundaryWithoutPricedAnchorFallsToCenter() {
    console.log('\n[ANCHOR-003] null boundary + priceless fills + "pool" + no genesis falls to rail-center...');
    // The fill carries no price, so Tier 1 has nothing to anchor on; pool is
    // non-numeric and no genesis was forwarded. The bounded center guess
    // beats an abort storm — and is never a rail-edge fabrication.
    const { boundaryIdx } = deriveTargetBoundary(
        [{ id: 'slot-100', type: ORDER_TYPES.SELL, isPartial: true, isDelayedRotationTrigger: true }],
        null,
        buildSlots(N_SLOTS),
        POOL_CFG,
        GAP,
        null
    );
    // Center anchor (102) plus the eligible dust-sell crawl (+1): non-fill
    // anchors fall through to the crawl, only Tier-1 fill anchors skip it.
    assert.strictEqual(boundaryIdx, Math.floor((N_SLOTS - 1 - GAP) / 2) - Math.floor(GAP / 2) - 1 + 1,
        'center fallback plus fill crawl must stay mid-rail, never rail-top');
    console.log('✓ ANCHOR-003 passed');
}

async function testP0d_GenesisAnchorRecoversHonestBoundary() {
    console.log('\n[ANCHOR-004] null boundary + genesis anchor recovers the honest center...');
    const slots = buildSlots(N_SLOTS);
    const genesisStart = 0.0015;
    const { boundaryIdx } = deriveTargetBoundary(
        [{ id: 'slot-100', type: ORDER_TYPES.SELL, isPartial: true, isDelayedRotationTrigger: true }],
        null,
        slots,
        { ...POOL_CFG, genesisStartPrice: genesisStart },
        GAP,
        null
    );
    const split = slots.findIndex((s) => s.price >= genesisStart);
    // Genesis anchor plus the eligible dust-sell crawl (+1): non-fill
    // anchors fall through to the crawl, only Tier-1 fill anchors skip it.
    assert.strictEqual(boundaryIdx, split - Math.floor(GAP / 2) - 1 + 1,
        'genesis-anchored recovery plus fill crawl must land near the honest center');
    console.log('✓ ANCHOR-004 passed');
}

async function testP0f_NullBoundaryAnchorUsesEligibleFillsOnly() {
    console.log('\n[ANCHOR-010] null-boundary fill anchor ignores fills the guard refused...');
    // Tier-1 recovery used to take its extremum from RAW fills ("eligible or
    // dust"), so a premium sweep / wrong-side fill the pivot writer refused
    // could position the absolute boundary through this early return, which
    // bypasses the filtered crawl loop. The injected single-source predicate
    // must gate the anchor too; omitting it keeps legacy callers unchanged.
    const slots = buildSlots(N_SLOTS);
    const eligible = 0.0015;
    const hijack = 0.0011;
    const fills = [
        { id: 'slot-125', type: ORDER_TYPES.SELL, price: eligible },
        { id: 'slot-25', type: ORDER_TYPES.SELL, price: hijack },
    ];
    const isEligible = (f: any) => Number(f?.price) > 0.0013;

    const { boundaryIdx: honest } = deriveTargetBoundary(
        fills, null, slots, POOL_CFG, GAP, null, null, null, isEligible
    );
    const { boundaryIdx: legacy } = deriveTargetBoundary(
        fills, null, slots, POOL_CFG, GAP
    );

    assert.strictEqual(honest, calculateIdealBoundary(slots, eligible, GAP),
        'the anchor must use the fill the guard would have armed');
    assert.strictEqual(legacy, calculateIdealBoundary(slots, hijack, GAP),
        'without the predicate the legacy extremum is unchanged');
    assert.notStrictEqual(honest, legacy, 'the rejected fill must not be able to move the anchor');
    console.log('  ✓ fill-anchor recovery consumes only eligible fills');
}

async function testP0e_KnownBoundaryCrawlUnchanged() {
    console.log('\n[ANCHOR-005] known-boundary fill crawl unchanged (no anchor needed)...');
    const { boundaryIdx } = deriveTargetBoundary(
        [{ id: 'slot-100', type: ORDER_TYPES.SELL }],
        96,
        buildSlots(N_SLOTS),
        POOL_CFG,
        GAP,
        null
    );
    assert.strictEqual(boundaryIdx, 97, 'sell crawl 96 -> 97 must not consult any price anchor');
    console.log('✓ ANCHOR-005 passed');
}

function engineWithPlan(targetGrid, boundaryIdx, fills = []) {
    const logs = [];
    const engine = new COWRebalanceEngine({
        strategy: {
            calculateTargetGrid: () => ({ targetGrid, boundaryIdx }),
        },
        logger: { log: (msg) => { logs.push(String(msg)); } },
        assets: { assetA: { precision: 8 }, assetB: { precision: 5 } },
        config: {
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 0.05 },
            coreOrders: { buy: 20, sell: 20 },
        },
    });
    return { engine, logs };
}

function slotEntry(id: string, idx: number, type: string, state: string, orderId: string): [string, any] {
    return [id, {
        id,
        price: 0.001 + idx * 0.000004,
        type,
        size: state === ORDER_STATES.VIRTUAL ? 0 : 100,
        idealSize: 100,
        state,
        orderId: orderId || '',
        committedSide: type,
        rawOnChain: orderId ? {} : null,
    }];
}

async function testP4_NullBoundaryPlanAbortsWithResync() {
    console.log('\n[ANCHOR-006] null-boundary plan aborts with needsResync (dust included)...');
    const { engine } = engineWithPlan(new Map(), null,
        [{ id: 'slot-100', type: ORDER_TYPES.SELL, isPartial: true, isDelayedRotationTrigger: true }]);
    const result = await engine.execute({
        masterGrid: new Map(),
        gridVersion: 1,
        boundaryIdx: null,
        funds: { allocatedBuy: 1e9, allocatedSell: 1e9 },
        fills: [{ id: 'slot-100', type: ORDER_TYPES.SELL, isPartial: true, isDelayedRotationTrigger: true }],
    });
    assert.strictEqual(result.aborted, true, 'unanchored plan must abort');
    assert.strictEqual(result.needsResync, true, 'abort must request a structural resync');
    assert.strictEqual(result.actions.length, 0, 'no actions may be planned without an anchor');
    console.log('✓ ANCHOR-006 passed');
}
async function testP1_RailEdgePlanWarnsAndProceeds() {
    console.log('\n[ANCHOR-007] off-rail window plan warns (not aborts) and proceeds...');
    const target = new Map();
    for (let i = 192; i <= 211; i++) target.set(`slot-${i}`, slotEntry(`slot-${i}`, i, ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, '')[1]);
    const { engine, logs } = engineWithPlan(target, 211);
    const result = await engine.execute({
        masterGrid: new Map(),
        gridVersion: 1,
        boundaryIdx: null,
        funds: { allocatedBuy: 1e9, allocatedSell: 1e9 },
        fills: [],
    });
    assert.strictEqual(result.aborted, false, 'rail-edge telemetry must not abort the plan');
    assert.ok(logs.some((l) => l.includes('Rail-edge plan')),
        'truncated window must be visible at warn in the logs');
    console.log('✓ ANCHOR-007 passed');
}

async function testFillAnchoredRecovery_ReplaysIncidentBatches() {
    console.log('\n[ANCHOR-008] Sep-10 incident batches anchor near the market, not the rail top...');
    // Batch 1 (02:03:19): dust-cancel sell slot-100, null boundary, pool cfg.
    // Old code: base 213 + eligible sell crawl +1, ceiling-clamped to 211.
    const batch1 = deriveTargetBoundary(
        [{ id: 'slot-100', type: ORDER_TYPES.SELL, price: 0.001 + 100 * 0.000004, isPartial: true, isDelayedRotationTrigger: true }],
        null,
        buildSlots(N_SLOTS),
        POOL_CFG,
        GAP,
        null
    );
    assert.strictEqual(batch1.boundaryIdx, 100 - Math.floor(GAP / 2) - 1,
        `dust-sell batch must anchor at the fill slot minus the gap convention (got ${batch1.boundaryIdx}, want 97)`);
    assert.strictEqual(batch1.remainingBudget, 10, 'no crawl may be consumed on a recovery batch');
    // Batch 2 (02:03:33): 4 full buys 93-96, null boundary, pool cfg.
    // Old code: base 213 - 4 crawls = 209, window off the rail top.
    const batch2 = deriveTargetBoundary(
        [96, 95, 94, 93].map((i) => ({ id: `slot-${i}`, type: ORDER_TYPES.BUY, price: 0.001 + i * 0.000004, isPartial: false })),
        null,
        buildSlots(N_SLOTS),
        POOL_CFG,
        GAP,
        null
    );
    assert.strictEqual(batch2.boundaryIdx, 96 - Math.floor(GAP / 2) - 1,
        `4-buy batch must anchor at the top fill slot minus the gap convention (got ${batch2.boundaryIdx}, want 93)`);
    assert.strictEqual(batch2.remainingBudget, 10, 'no crawl may be consumed on a recovery batch');
    console.log('✓ ANCHOR-008 passed');
}

async function testShortRotationStillPlans() {
    console.log('\n[ANCHOR-009] short rotation (1 slot) still plans normally...');
    const master = new Map([
        slotEntry('slot-77', 77, ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, '1.7.1'),
        slotEntry('slot-78', 78, ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, ''),
        slotEntry('slot-100', 100, ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, '1.7.2'),
    ]);
    const target = new Map([
        slotEntry('slot-77', 77, ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, ''),
        slotEntry('slot-78', 78, ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, ''),
        slotEntry('slot-100', 100, ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, ''),
    ]);
    const { engine } = engineWithPlan(target, 96, []);
    const result = await engine.execute({
        masterGrid: master,
        gridVersion: 1,
        boundaryIdx: 96,
        funds: { allocatedBuy: 1e9, allocatedSell: 1e9 },
        fills: [],
    });
    assert.strictEqual(result.aborted, false, 'short rotation must not abort');
    assert.strictEqual(result.needsResync, undefined, 'no resync flag on a healthy plan');
    const rotation = result.actions.find((a) => a.type === COW_ACTIONS.UPDATE);
    assert.ok(rotation && rotation.newGridId === 'slot-78', 'expected the 1-slot rotation to survive');
    console.log('✓ ANCHOR-009 passed');
}

async function main() {
    await testP0a_NonNumericReferenceFallsToCenter();
    await testP0b_NumericReferenceUnchanged();
    await testP0c_NullBoundaryWithoutPricedAnchorFallsToCenter();
    await testP0d_GenesisAnchorRecoversHonestBoundary();
    await testP0f_NullBoundaryAnchorUsesEligibleFillsOnly();
    await testP0e_KnownBoundaryCrawlUnchanged();
    await testP4_NullBoundaryPlanAbortsWithResync();
    await testP1_RailEdgePlanWarnsAndProceeds();
    await testFillAnchoredRecovery_ReplaysIncidentBatches();
    await testShortRotationStillPlans();
    console.log('\nAll boundary-anchor recovery tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

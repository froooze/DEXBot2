const assert = require('assert');
const {
    validateBoundaryCommit,
    validatePersistedBoundary,
    isTransientInBandRejection,
    buildGenesisFromPriceLevels,
    calculateGapSlots,
    BOUNDARY_REJECT_PLACED_IN_BAND
} = require('../modules/order/utils/math');
const { loadGrid } = require('../modules/order/grid');
const { recoverFromPersistedGrid } = require('../modules/dexbot_state_recovery');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { isMissingGenesisError } = require('../modules/order/genesis_policy');

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * The price ladder that describes `buildGrid()`'s slots (price 1 + i*0.01).
 *
 * loadGrid REQUIRES a ladder for a non-empty snapshot (docs/GRID_PRICE_INVARIANT.md,
 * INV-GRID-004): a genesis-less grid is refused before any state is touched.
 * These tests exercise boundary restore/repair, so they hand loadGrid the
 * ladder the snapshot would really carry.
 */
function gridLadder() {
    return buildGenesisFromPriceLevels(1.05, 1, calculateGapSlots(1, 1), buildGrid().map((s) => s.price));
}

/**
 * Build a 10-slot price-sorted grid:
 *   slots 0..5  BUY rail   (placed)
 *   slots 6..7  gap band   (empty/virtual)
 *   slots 8..9  SELL rail  (placed)
 * Honest boundary = 5, gapSlots = 2.
 */
function buildGrid() {
    const grid = [];
    for (let i = 0; i < 6; i++) {
        grid.push({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            orderId: `1.7.${100 + i}`
        });
    }
    for (let i = 6; i < 8; i++) {
        grid.push({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: ''
        });
    }
    for (let i = 8; i < 10; i++) {
        grid.push({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            orderId: `1.7.${200 + i}`
        });
    }
    return grid;
}

function buildFakeManager(config) {
    const manager = {
        config,
        logs: [],
        logger: null,
        funds: { btsFeesOwed: 0 },
        orders: new Map(),
        _gridVersion: 0,
        boundaryIdx: null,
        _gapSlots: null,
        _missingGenesis: null,
        assets: { assetA: {}, assetB: {} },
        initialSpreadCount: 0,
        currentSpreadCount: 0,
        _gridLock: { acquire: async (fn) => await fn() },
        _fundLock: { acquire: async (fn) => await fn() },
        _initializeAssets: async () => {},
        resetFunds: async () => {},
        pauseRecalcLogging: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        resumeRecalcLogging: () => {},
        _applyOrderUpdate: async (order) => {
            manager.orders.set(order.id, Object.freeze({ ...order }));
        },
        _restoreBoundary: (newIdx) => { manager.boundaryIdx = newIdx; }
    };
    manager.logger = {
        log: (msg, level) => { manager.logs.push({ msg, level }); }
    };
    return manager;
}

// ── unit: validator semantics ───────────────────────────────────────────

async function testValidatorSemantics() {
    console.log('Running test: boundary validator semantics');

    const grid = buildGrid();

    // Honest geometry: boundary 5, gap 6-7, sells 8-9.
    assert.strictEqual(validateBoundaryCommit(5, grid, 2).ok, true, 'commit gate accepts honest boundary');
    assert.strictEqual(validatePersistedBoundary(5, grid, 2).ok, true, 'restore gate accepts honest boundary');
    assert.strictEqual(validateBoundaryCommit(null, grid, 2).ok, true, 'null boundary is always acceptable');

    // Absent-vs-garbage contract (pinned): null/undefined/'' are "no
    // proposal" (ok) — '' only because Number('') === 0 would otherwise
    // self-legalize a fake boundary-0 commit. Everything else non-numeric is
    // FAIL-CLOSED non_integer_boundary: this gate backs
    // validatePersistedBoundary (disk-trust), where a corrupt value must
    // surface as a rejection (rebuild), never silently pass as "no
    // proposal".
    assert.deepStrictEqual(validateBoundaryCommit(undefined, grid, 2), { ok: true }, 'undefined boundary = no proposal');
    assert.deepStrictEqual(validateBoundaryCommit('' as any, grid, 2), { ok: true }, "'' boundary = no proposal (the pre-1.6.13 Number('')===0 hole)");
    assert.strictEqual(validateBoundaryCommit('abc' as any, grid, 2).reason, 'non_integer_boundary', 'garbage string fail-closed, not "no proposal"');
    assert.strictEqual(validateBoundaryCommit(NaN as any, grid, 2).reason, 'non_integer_boundary', 'NaN fail-closed');
    assert.strictEqual(validateBoundaryCommit(Infinity as any, grid, 2).reason, 'non_integer_boundary', 'Infinity fail-closed');
    assert.strictEqual(validatePersistedBoundary('abc' as any, grid, 2).reason, 'non_integer_boundary', 'restore gate treats garbage as poison, not absence');

    // Numeric sanity.
    assert.strictEqual(validateBoundaryCommit(4.5, grid, 2).ok, false, 'non-integer rejected');
    assert.strictEqual(validateBoundaryCommit(-1, grid, 2).ok, false, 'negative rejected');
    assert.strictEqual(validateBoundaryCommit(99, grid, 2).reason, 'boundary_out_of_range', 'out-of-range rejected');

    // Sell-rail ceiling (writer alignment): both boundary writers clamp to
    // [0, N−gapSlots−1]; the gate rejects beyond-ceiling proposals so an
    // overrun from a legacy snapshot or buggy writer cannot self-legalize
    // zero-SELL geometry via resolveGapBand. N=10, g=2 -> maxAllowed 7.
    const ceilResult = validateBoundaryCommit(8, grid, 2);
    assert.strictEqual(ceilResult.ok, false, 'beyond-ceiling boundary rejected at commit gate');
    assert.strictEqual(ceilResult.reason, 'sell_rail_ceiling_exceeded', 'stable reason for ceiling overrun');
    assert.ok(/maxAllowed=7/.test(ceilResult.detail), 'detail carries the ceiling');
    assert.strictEqual(validateBoundaryCommit(7, grid, 2).ok, true, 'ceiling value itself accepted (writer parity)');
    assert.strictEqual(validatePersistedBoundary(9, grid, 2).ok, false,
        'restore gate rejects past-ceiling persisted boundary');

    // Crossed-placed-book check limitation (pinned deliberately): entries
    // are price-sorted before position classification, so any BUY-side index
    // always prices <= any SELL-side index. Equal prices sort ADJACENTLY and
    // can never straddle a band with gapSlots >= 1, so the
    // crossed_book_geometry branch is unreachable there. The real
    // restore-time poison signal is stranding, covered below.
    const collision = [
        { id: 'a', price: 1.02, orderId: '1.7.1' },
        { id: 'b', price: 1.00 },
        { id: 'c', price: 1.00 },
        { id: 'd', price: 1.00 },                    // boundary idx 3
        { id: 'e', price: 1.02, orderId: '1.7.2' },  // sorts adjacent to 'a'
        { id: 'f', price: 1.03 },
        { id: 'g', price: 1.04 }
    ];
    assert.strictEqual(
        validateBoundaryCommit(3, collision, 1).ok, true,
        'known limitation: equal prices sort adjacently, cannot straddle band'
    );

    // Stranding: placed order strictly inside the implied band.
    // Default commit gate tolerates it (upstream caps prevent it; post-commit
    // detector owns it) — restore gate REPORTS it.  Callers separate the
    // transient case (SPREAD-GUARD mid-evacuation strand: warn + keep boundary,
    // GAP-EVAC owns cleanup) from true poison via isTransientInBandRejection().
    const stranded = buildGrid();
    stranded[6] = { ...stranded[6], orderId: '1.7.999', state: ORDER_STATES.ACTIVE, size: 10 };
    assert.strictEqual(
        validateBoundaryCommit(5, stranded, 2).ok, true,
        'commit gate does NOT own in-band placements'
    );
    const strandResult = validatePersistedBoundary(5, stranded, 2);
    assert.strictEqual(strandResult.ok, false, 'restore gate reports stranded placement');
    assert.strictEqual(strandResult.reason, BOUNDARY_REJECT_PLACED_IN_BAND);
    assert.strictEqual(isTransientInBandRejection(strandResult), true,
        'in-band placement without structural signal classifies as transient (no rebuild)');
    assert.strictEqual(isTransientInBandRejection({ ok: true }), false,
        'ok result is not transient');
    assert.strictEqual(isTransientInBandRejection(validatePersistedBoundary(9, grid, 2)), false,
        'ceiling overrun stays rebuild-worthy');

    // Downward overrun poison (the pre-5eb3ca7 failure shape): boundary slid
    // onto the buy rail so placed BUYs sit inside the implied band. No price
    // crossing — only geometry detects it.
    const downResult = validatePersistedBoundary(3, grid, 2);
    assert.strictEqual(downResult.ok, false, 'downward-overrun boundary rejected at restore');
    assert.strictEqual(downResult.reason, BOUNDARY_REJECT_PLACED_IN_BAND);
    assert.ok(/count=2/.test(downResult.detail || ''),
        `detail carries the strand count (got: ${downResult.detail})`);

    console.log('  PASS: validator semantics match commit vs restore strictness');
}

// ── loadGrid: honest restore passes through unchanged ───────────────────

async function testLoadGridValidBoundaryPassthrough() {
    console.log('Running test: loadGrid accepts an honest persisted boundary');

    const grid = buildGrid();
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });

    await loadGrid(manager, grid, 5, gridLadder());

    assert.strictEqual(manager.boundaryIdx, 5, 'honest boundary restored verbatim');
    assert.strictEqual(manager._gapSlots, 2, 'gapSlots set from config math');
    assert.strictEqual(manager.orders.size, 10, 'all slots loaded');
    assert.ok(!manager.logs.some(l => l.msg.includes('[GRID-LOAD] Persisted boundary rejected')),
        'no rejection logged for honest state');

    console.log('  PASS: honest persisted boundary loads without repair');
}

// ── loadGrid: poisoned boundary is repaired by re-derivation ────────────

async function testLoadGridRepairsPoisonedBoundary() {
    console.log('Running test: loadGrid repairs a poisoned persisted boundary');

    // Overrun poison: downward slide left placed BUYs (idx 4,5) strictly
    // inside the implied band under restored boundary 3.
    const grid = buildGrid();
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });

    await loadGrid(manager, grid, 3, gridLadder());

    // calculateIdealBoundary with startPrice=1.07: splitIdx=7 -> 7-1-1=5,
    // which is exactly the honest boundary and passes re-validation.
    assert.strictEqual(manager.boundaryIdx, 5, 'poisoned boundary repaired to re-derived value');
    assert.strictEqual(manager._gapSlots, 2, 'gapSlots set after repair');

    // Slot types must match the REPAIRED geometry.
    for (let i = 0; i <= 5; i++) {
        assert.strictEqual(manager.orders.get(`slot-${i}`).type, ORDER_TYPES.BUY, `slot-${i} BUY`);
    }
    for (let i = 6; i <= 7; i++) {
        assert.strictEqual(manager.orders.get(`slot-${i}`).type, ORDER_TYPES.SPREAD, `slot-${i} SPREAD`);
    }
    for (let i = 8; i <= 9; i++) {
        assert.strictEqual(manager.orders.get(`slot-${i}`).type, ORDER_TYPES.SELL, `slot-${i} SELL`);
    }

    assert.ok(manager.logs.some(l => l.msg.includes('Persisted boundary rejected') && l.level === 'error'),
        'rejection logged at error level');
    assert.ok(manager.logs.some(l => l.msg.includes('boundary repaired: 3 -> 5')), 'repair logged');

    console.log('  PASS: poisoned persisted boundary repaired via re-derivation');
}

// ── loadGrid: unrepairable poison falls back to no boundary ─────────────

async function testLoadGridFallsBackToNullBoundary() {
    console.log('Running test: loadGrid falls back to null when re-derivation is impossible');

    const grid = buildGrid();
    // startPrice not numeric ("pool"/"book" modes) -> cannot re-derive.
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 'pool' });
    manager.boundaryIdx = 42;      // sentinel: must NOT be overwritten by poison
    manager._gapSlots = 'unset';   // sentinel: null path must not touch it

    await loadGrid(manager, grid, 3, gridLadder());

    assert.strictEqual(manager.boundaryIdx, 42, 'poison discarded, previous value kept');
    assert.strictEqual(manager._gapSlots, 'unset', 'null-boundary path leaves _gapSlots untouched');
    assert.strictEqual(manager.orders.size, 10, 'grid still loads without a boundary');
    assert.ok(manager.logs.some(l => l.msg.includes('Could not re-derive a safe boundary') && l.level === 'error'),
        'fallback logged at error level');

    console.log('  PASS: unrepairable poison degrades to boundary-less load');
}

// ── loadGrid: a ladder-less snapshot is refused (genesis invariant) ────

async function testLoadGridRefusesSnapshotWithoutLadder() {
    console.log('Running test: loadGrid refuses a snapshot that carries no price ladder');

    // Reversed snapshot AND no persisted/in-memory ladder. Before the genesis
    // invariant this loaded "as-is" and the repair mapped the derived index
    // back into the stored (unsorted) positions; the state is now unreachable
    // because a grid without a ladder has no defined slot prices at all.
    const grid = buildGrid().slice().reverse();
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });

    let thrown = null;
    try { await loadGrid(manager, grid, 3, null); } catch (e) { thrown = e; }
    assert.ok(isMissingGenesisError(thrown), 'loadGrid refuses the ladder-less snapshot');
    assert.strictEqual(thrown.reason, 'non_finite_config',
        'the fixture config has no numeric rail to migrate from');
    assert.strictEqual(manager.orders.size, 0, 'no slot installed from a refused snapshot');
    assert.strictEqual(manager.boundaryIdx, null, 'boundary untouched');
    assert.ok(manager._missingGenesis && manager._missingGenesis.reason === 'non_finite_config',
        'the fault is recorded for observability');

    // The same snapshot WITH its ladder loads and is re-sorted to canonical
    // slot-N order before the boundary gate reads it.
    const manager2 = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });
    await loadGrid(manager2, grid, 3, gridLadder());
    assert.ok(manager2.logs.some(l => l.msg.includes('Re-sorted')),
        'a reversed snapshot with a ladder is re-sorted to canonical order');
    assert.strictEqual(manager2.orders.size, 10, 'all slots loaded');
    // Canonical order + boundary 3 (poison) is re-derived against THAT order.
    assert.ok(manager2.logs.some(l => l.msg.includes('boundary repaired')),
        'the boundary is re-derived after the canonical re-sort');

    // Canonical order + boundary 3 (poison) is re-derived against THAT order:
    // the honest structural center is 5, gap 2 -> sellStart 8.
    assert.strictEqual(manager2.boundaryIdx, 5, 'boundary re-derived in canonical order');
    // Types follow loadGrid's standard reassignment over the canonical order
    // (rail-typed holes: empty in-rail slots keep BUY/SELL by geometry, only
    // true band slots are SPREAD; placed slots resolve per its retype rules).
    assert.strictEqual(manager2.orders.get('slot-8').type, ORDER_TYPES.SELL, 'empty in-rail hole keeps rail type');
    assert.strictEqual(manager2.orders.get('slot-7').type, ORDER_TYPES.SPREAD, 'empty band slot normalized');
    assert.strictEqual(manager2.orders.get('slot-5').type, ORDER_TYPES.BUY);
    assert.strictEqual(manager2.orders.get('slot-4').type, ORDER_TYPES.BUY,
        'on-chain slot keeps persisted rail type instead of SPREAD');

    console.log('  PASS: ladder-less snapshots refused; unsorted snapshots re-sorted canonically');
}

// ── recovery: poisoned snapshot refused so resync rebuilds clean ────────
// NOTE: transient stranding (placed_order_in_band) is tolerated by recovery
// (<bot> 2026-09-13: stale snapshot mid-evacuation must not force a resync
// that wipes the evacuation).  This test pins the still-rejected structural
// poison shape: sell-rail ceiling overrun (N=10, g=2 -> maxAllowed 7).

async function testRecoveryRejectsPoisonedSnapshot() {
    console.log('Running test: recoverFromPersistedGrid refuses a snapshot with invalid boundary');

    const grid = buildGrid();
    const bot = {
        accountId: '1.2.3',
        accountOrders: {
            loadGrid: () => grid,
            loadBoundaryIdx: () => 9,
            loadGenesis: () => gridLadder()
        },
        // Gate reads config-derived gapSlots (calculateGapSlots(1,1) = 2),
        // matching loadGrid's restore gate exactly.
        manager: buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1 })
    };
    // If the gate failed to fire, the next step (grid.loadGrid) would run and
    // blow up on the missing _gridLock surface of this stub manager — any
    // non-gate failure yields a different reason string, so asserting on the
    // reason proves the early return happened BEFORE loading.
    bot.manager._gridLock = undefined;

    const result = await recoverFromPersistedGrid(bot);

    assert.strictEqual(result.success, false, 'recovery refuses poisoned snapshot');
    assert.ok(/persisted boundary rejected/.test(result.reason || ''),
        `reason must cite the boundary gate (got: ${result.reason})`);
    assert.ok(/sell_rail_ceiling_exceeded/.test(result.reason || ''),
        `structural poison reason preserved (got: ${result.reason})`);
    assert.ok(bot.manager.logs.some(l => l.msg.includes('[RECOVERY] Persisted boundary failed validation')),
        'rejection logged');

    console.log('  PASS: structural resync falls through to clean rebuild on poisoned snapshot');
}

// ── recovery: transient stranding proceeds (no structural resync) ───────

async function testRecoveryToleratesTransientStranding() {
    console.log('Running test: recoverFromPersistedGrid tolerates transient in-band stranding');

    // Single SPREAD-GUARD strand: honest boundary 5 with slot-6 still placed
    // (fill-driven crawl moved it into the band; GAP-EVAC pending).  Under
    // the old gate this forced rms_structural_grid_resync and wiped the
    // in-progress evacuation (<bot> 2026-09-13: slot-96 → slot-116 plan lost).
    const grid = buildGrid();
    grid[6] = { ...grid[6], orderId: '1.7.999', state: ORDER_STATES.ACTIVE, size: 10 };
    const bot = {
        accountId: '1.2.3',
        accountOrders: {
            loadGrid: () => grid,
            loadBoundaryIdx: () => 5,
            loadGenesis: () => gridLadder()
        },
        manager: buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1 }),
        // Sentinel AFTER the load: reaching it proves the gate tolerated the
        // strand (old behavior returned 'persisted boundary rejected' before
        // loading).  Placed before the chain read so no network is touched.
        _rejectCorruptedGridSnapshot: async () => { throw new Error('SENTINEL-reached-post-load'); }
    };

    // NOTE: recoverFromPersistedGrid wraps its body in a catch-all that
    // converts throws to { success:false, reason }, so the sentinel surfaces
    // as result.reason — reaching it still proves the gate loaded (old
    // behavior returned 'persisted boundary rejected' before loading).
    const result = await recoverFromPersistedGrid(bot);
    assert.ok(result && /SENTINEL-reached-post-load/.test(result.reason || ''),
        `gate must proceed to load on transient stranding (got: ${result && result.reason})`);
    assert.strictEqual(bot.manager.boundaryIdx, 5,
        'transient snapshot boundary kept, not nulled/re-derived');
    assert.ok(bot.manager.logs.some(l => l.msg.includes('transient in-band placement') && l.level === 'warn'),
        'transient tolerance logged at warn level');
    assert.ok(!bot.manager.logs.some(l => l.msg.includes('[RECOVERY] Persisted boundary failed validation')),
        'no poison rejection logged for transient stranding');

    console.log('  PASS: transient stranding loads without structural resync');
}

// ── loadGrid: tolerate flag keeps transient boundary ────────────────────

async function testLoadGridToleratesTransientStranding() {
    console.log('Running test: loadGrid keeps boundary with tolerateTransientStranding');

    const grid = buildGrid();
    grid[6] = { ...grid[6], orderId: '1.7.999', state: ORDER_STATES.ACTIVE, size: 10 };
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });

    await loadGrid(manager, grid, 5, gridLadder(), { tolerateTransientStranding: true });

    assert.strictEqual(manager.boundaryIdx, 5, 'transient boundary kept verbatim');
    assert.ok(manager.logs.some(l => l.msg.includes('transient in-band placement') && l.level === 'warn'),
        'tolerance logged at warn level');
    assert.ok(!manager.logs.some(l => l.msg.includes('Persisted boundary rejected')),
        'no rejection/repair logged for tolerated stranding');

    // Default (strict) path unchanged: same snapshot without the flag takes
    // the repair path (rejection logged, boundary re-derived).
    const strictManager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });
    await loadGrid(strictManager, buildGrid().map((s, i) => i === 6
        ? { ...s, orderId: '1.7.999', state: ORDER_STATES.ACTIVE, size: 10 } : s), 5, gridLadder());
    assert.ok(strictManager.logs.some(l => l.msg.includes('Persisted boundary rejected')),
        'strict loadGrid still rejects transient stranding (repair path)');

    console.log('  PASS: tolerate flag keeps transient boundary');
}

// ── loadGrid: re-anchored PARTIAL residual is transient, not poison ─────
async function testLoadGridToleratesReanchoredPartialResidual() {
    console.log('Running test: loadGrid keeps a re-anchored boundary with the fill PARTIAL residual');

    const levels = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];
    const genesis = buildGenesisFromPriceLevels(105, 1, 1, levels);
    const grid = levels.map((price, idx) => ({
        id: `slot-${idx}`,
        price,
        type: idx <= 6 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
        state: idx === 7 ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE,
        size: 10,
        orderId: `1.7.${400 + idx}`,
    }));
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 105 });
    const gap = calculateGapSlots(1, 1);

    const check = validatePersistedBoundary(6, grid, gap);
    assert.strictEqual(check.reason, BOUNDARY_REJECT_PLACED_IN_BAND,
        'precondition: the anchor-slot PARTIAL is in-band under the re-anchored boundary');
    assert.strictEqual(isTransientInBandRejection(check), true,
        'precondition: the residual shape is classified transient');

    await loadGrid(manager, grid, 6, genesis, { tolerateTransientStranding: true });
    assert.strictEqual(manager.boundaryIdx, 6,
        'the persisted re-anchored boundary must survive startup/recovery loading');
    assert.ok(manager.logs.some(l => l.msg.includes('transient in-band placement') && l.level === 'warn'),
        'the partial-residual load is warned, not rejected');
    assert.ok(!manager.logs.some(l => l.msg.includes('Persisted boundary rejected')),
        'the residual must not trigger a boundary rebuild');

    console.log('  PASS: re-anchored PARTIAL residual loads with the boundary intact');
}

// ── runner ──────────────────────────────────────────────────────────────

// ── crossed-book takes precedence over co-occurring stranding ──────────

async function testCrossedBookPrecedenceOverStranding() {
    console.log('Running test: crossed-book takes precedence over co-occurring stranding');

    // Flat prices: every placed slot prices 1.00, so bestPlacedBuy (idx<=2)
    // equals bestImpliedSell (idx>=4) -> crossed — while slot-3 is also
    // stranded in the band (2,4). Must report crossed (structural, rebuild),
    // never the transient strand (which recovery would tolerate and load).
    // N=6, gap=1 -> ceiling maxAllowed=4, so boundary 2 clears it.
    const flat = [];
    for (let i = 0; i < 6; i++) {
        flat.push({
            id: `slot-${i}`,
            price: 1.00,
            // slot-3 keeps a rail type: the SPREAD-GUARD survivor shape.
            // (Stored type is irrelevant to the validator; position rules.)
            type: i <= 3 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            orderId: `1.7.${300 + i}`
        });
    }
    const result = validatePersistedBoundary(2, flat, 1);
    assert.strictEqual(result.reason, 'crossed_book_geometry',
        `crossed book must take precedence (got: ${result.reason}: ${result.detail})`);
    assert.strictEqual(isTransientInBandRejection(result), false,
        'crossed snapshot must NOT classify as transient');
    // Commit gate (no in-band flag) agrees — cross is flag-independent.
    assert.strictEqual(validateBoundaryCommit(2, flat, 1).reason, 'crossed_book_geometry',
        'commit gate reports the same cross');

    console.log('  PASS: crossed-book outranks stranding');
}

async function runAll() {
    await testValidatorSemantics();
    await testCrossedBookPrecedenceOverStranding();
    await testLoadGridValidBoundaryPassthrough();
    await testLoadGridRepairsPoisonedBoundary();
    await testLoadGridFallsBackToNullBoundary();
    await testLoadGridRefusesSnapshotWithoutLadder();
    await testRecoveryRejectsPoisonedSnapshot();
    await testRecoveryToleratesTransientStranding();
    await testLoadGridToleratesTransientStranding();
    await testLoadGridToleratesReanchoredPartialResidual();
    console.log('All boundary restore validation tests passed');
}

runAll().catch(error => {
    console.error('Test FAILED:', error);
    process.exit(1);
});

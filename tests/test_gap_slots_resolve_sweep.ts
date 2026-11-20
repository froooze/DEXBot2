/**
 * tests/test_gap_slots_resolve_sweep.ts
 *
 * M2 regression: geometry reads of the gap width go through resolveGapSlots
 * (absent-aware `_gapSlots ?? config-derived`), never the raw `_gapSlots` field.
 * An absent/unpublished field previously read as 0 and collapsed the band, so
 * `_validatePriceCorrectionEntry` could drop a still-live type-mismatch or
 * gap-evacuation cancel, and _processGapEvacuationTeeth could skip a real
 * in-band order during the restore window. Note a genuine numeric 0 is finite
 * and is passed through by resolveGapSlots; the pre-load `_gapSlots` placeholder
 * on the manager is overwritten by grid load/init, so that separate live-value
 * case is not what this sweep addresses.
 *
 * Mutation checks:
 *  - restore `manager?._gapSlots` at either correction-liveness site → the
 *    behavioural cases fail;
 *  - restore a raw read at any audited call site → the source guards fail.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _validatePriceCorrectionEntry } = require('../modules/order/utils/order');
const { resolveGapSlots } = require('../modules/order/utils/math');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function makeManager() {
    const manager: any = {
        orders: new Map([
            ['slot-1', { id: 'slot-1', orderId: '1.7.1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL, price: 105 }]
        ]),
        ordersNeedingPriceCorrection: [],
        _lastUnmatchedChainOrders: [],
        boundaryIdx: 0,
        _gapSlots: undefined, // unpublished: the window this sweep closes
        config: { incrementPercent: 10, targetSpreadPercent: 10, gridLimits: {} },
        assets: {
            assetA: { id: '1.3.0', precision: 5, symbol: 'TEST' },
            assetB: { id: '1.3.861', precision: 5, symbol: 'BTS' }
        }
    };
    return manager;
}

function source(relativePath: string): string {
    return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

async function run() {
    console.log('Running gap-slot resolve sweep tests...');

    const manager = makeManager();
    assert.ok(resolveGapSlots(manager) > 0, 'fixture: config-derived gap must be non-zero');

    // M2-01 — type-mismatch liveness: unpublished _gapSlots must still resolve
    // a SPREAD band, so a wrong-side order in the band is NOT treated as repaired.
    {
        const check = _validatePriceCorrectionEntry(manager, {
            chainOrderId: '1.7.1',
            typeMismatch: true,
            type: ORDER_TYPES.SELL,
            gridOrder: { id: 'slot-1' }
        });
        assert.strictEqual(check.valid, true, 'M2-01: in-band type-mismatch cancel must stay queued while geometry is unresolved');
        assert.ok(String(check.reason).includes('geometry'), 'M2-01: geometry contradiction is the reason');
    }

    // M2-02 — gap-evacuation liveness: same absent-aware read at the second site.
    {
        const check = _validatePriceCorrectionEntry(manager, {
            chainOrderId: '1.7.1',
            gapEvacuation: true,
            gridOrder: { id: 'slot-1' }
        });
        assert.strictEqual(check.valid, true, 'M2-02: in-band evacuation target must stay queued while geometry is unresolved');
        assert.strictEqual(check.reason, 'gap-evacuation-still-live', 'M2-02: still in the resolved band');
    }

    // M2-03/M2-04 — audited call sites: no raw _gapSlots geometry reads remain.
    // Regexes with whitespace tolerance and open argument tails: a reformat or
    // an added preferred/config argument must not fail the test without a
    // behaviour change. The negative checks detect a regression to a raw read.
    {
        const managerSrc = source('modules/order/manager.ts');
        assert.ok(/geometryTypeForSlotIndex\s*\(\s*idx\s*,\s*this\.boundaryIdx\s*,\s*resolveGapSlots\s*\(/.test(managerSrc),
            'M2-03: fill-eligibility geometry must use resolveGapSlots');
        assert.ok(/const\s+gapSlots\s*=\s*resolveGapSlots\s*\(/.test(managerSrc),
            'M2-03: gap evacuation must use resolveGapSlots');
        assert.ok(!/geometryTypeForSlotIndex\s*\(\s*idx\s*,\s*this\.boundaryIdx\s*,\s*this\._gapSlots/.test(managerSrc),
            'M2-03: raw _gapSlots read still present in manager.ts');
        assert.ok(!/const\s+gapSlots\s*=\s*this\._gapSlots/.test(managerSrc),
            'M2-03: raw _gapSlots assignment still present in manager.ts');

        const syncSrc = source('modules/order/sync_engine.ts');
        assert.ok(/geometryTypeForSlotIndex\s*\(\s*liveIdx\s*,\s*mgr\.boundaryIdx\s*,\s*resolveGapSlots\s*\(/.test(syncSrc),
            'M2-03: gap-evacuation detection must use resolveGapSlots');
        assert.ok(!/geometryTypeForSlotIndex\s*\(\s*liveIdx\s*,\s*mgr\.boundaryIdx\s*,\s*mgr\._gapSlots/.test(syncSrc),
            'M2-03: raw _gapSlots read still present in sync_engine.ts');

        const orderSrc = source('modules/order/utils/order.ts');
        // Two new correction-liveness reads plus the pre-existing sweep reader.
        const resolverCalls = (orderSrc.match(/MathUtils\s*\.\s*resolveGapSlots\s*\(\s*manager\s+as\s+never/g) || []).length;
        assert.ok(resolverCalls >= 3, 'M2-03: both correction-liveness reads must use resolveGapSlots');
        assert.ok(!/manager\s*\?\s*\._gapSlots/.test(orderSrc),
            'M2-03: raw manager?._gapSlots read still present in order.ts');
    }

    {
        const strategySrc = source('modules/order/strategy.ts');
        assert.ok(/geometryTypeForSlotIndex\s*\(\s*parseSlotIndex\s*\(\s*currentSlot\?\.id\s*\)\s*,\s*mgr\.boundaryIdx\s*,\s*mgr\s*\?\s*resolveGapSlots\s*\(/.test(strategySrc),
            'M2-04: fill virtualization must resolve the gap, not read the raw field');
        assert.ok(!/mgr\.boundaryIdx\s*,\s*mgr\._gapSlots/.test(strategySrc),
            'M2-04: raw gap still fed to fill-virtualization geometry');

        const systemSrc = source('modules/order/utils/system.ts');
        // Two pre-existing resolver calls plus the two added here.
        const systemResolverCalls = (systemSrc.match(/resolveGapSlots\s*\(\s*manager\s+as\s+never/g) || []).length;
        assert.ok(systemResolverCalls >= 4,
            'M2-04: anchor-eligibility and rotation geometry must resolve the gap');
        assert.ok(!/gapSlots\s*:\s*manager\._gapSlots/.test(systemSrc),
            'M2-04: raw gap still fed to optimizeRebalanceActions');
        assert.ok(!/_gapSlots\?:\s*string\s*\|\s*number\s*\|\s*null\s*\}\s*\)\s*\._gapSlots/.test(systemSrc),
            'M2-04: raw gap still read by anchor eligibility');
    }

    // M2-05 — a frozen genesis gap must go through the same absent-aware
    // reader as _gapSlots. `genesis.gapSlots ?? resolveGapSlots(...)` lets an
    // empty / non-numeric / fractional value through as a band width, while
    // resolveGapSlots(manager, genesis.gapSlots) validates, floors and falls
    // back to _gapSlots then config-derived geometry.
    {
        const preferred = [
            ['modules/order/sync_engine.ts', /resolveGapSlots\s*\(\s*mgr\s*,\s*genesis\?\.gapSlots\s*\)/],
            ['modules/order/accounting.ts', /resolveGapSlots\s*\(\s*mgr\s*,\s*genesis\?\.gapSlots\s*\)/],
            ['modules/dexbot_fill_runtime.ts', /resolveGapSlots\s*\(\s*bot\.manager\s*,\s*genesis\.gapSlots\s*\)/],
        ] as const;
        for (const [rel, pattern] of preferred) {
            const src = source(rel);
            assert.ok(!/gapSlots\s*\?\?\s*resolveGapSlots\s*\(/.test(src),
                `M2-05: ${rel} still bypasses the absent-aware gap reader`);
            assert.ok(pattern.test(src),
                `M2-05: ${rel} must pass the genesis gap as resolveGapSlots' preferred argument`);
        }
        // Behaviour: a fractional genesis gap is floored, an empty one falls
        // through to the config-derived width rather than collapsing the band.
        const cfgManager = makeManager();
        assert.strictEqual(resolveGapSlots(cfgManager, ''), resolveGapSlots(cfgManager),
            'M2-05: an empty genesis gap must fall back to the config-derived gap');
        assert.strictEqual(resolveGapSlots(cfgManager, 2.9), 2,
            'M2-05: a fractional genesis gap is floored by the shared reader');
    }

    console.log('  ✓ gap-slot resolve sweep');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

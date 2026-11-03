/**
 * tests/test_validate_create_target_slots.ts
 *
 * Tests the four-layer CREATE validation in validateCreateTargetSlots:
 *   1. Slot occupancy — target slot already has a placed order
 *   2. Master grid price collision — a placed order at the same price in another slot
 *   3. Chain orphan collision — an unmatched on-chain order at the same price
 *   4. Same-batch duplicate — two CREATEs at identical price
 */

const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const { validateCreateTargetSlots } = require('../modules/order/utils/validate');

// Helpers
function makeOrder(id, type, price, size, state, orderId) {
    // An EXPLICIT null means "this slot owns no chain order" (an empty/VIRTUAL
    // slot). The old `orderId || fallback` turned that into a synthetic id,
    // which is indistinguishable from a live order id — and occupancy is now
    // decided by the id alone (a VIRTUAL slot that still owns an id may hold a
    // live order on chain, so CREATE must not duplicate the level).
    return { id, type, price, size, state, orderId: orderId === undefined ? `${id}-oid` : orderId };
}

function makeCreateAction(targetId, price, type, size = 100) {
    return {
        type: COW_ACTIONS.CREATE,
        id: targetId,
        order: { id: targetId, price, type, size }
    };
}

function makeCancelAction(targetId) {
    return { type: COW_ACTIONS.CANCEL, id: targetId };
}

function makeRotationAction(sourceId, targetId) {
    return { type: COW_ACTIONS.UPDATE, id: sourceId, newGridId: targetId };
}

function mapToOrders(arr) {
    return new Map(arr.map(o => [o.id, o]));
}

const dummyAssets = {
    assetA: { id: '1.3.0', symbol: 'TEST', precision: 8 },
    assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 }
};

async function runTests() {
    console.log('Running validateCreateTargetSlots tests...');

    // ── 1. Slot occupancy ──────────────────────────────────────────────
    console.log(' - 1. Slot occupancy detection...');
    {
        const orders = mapToOrders([
            makeOrder('slot-1', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.1')
        ]);
        const actions = [makeCreateAction('slot-1', 100, ORDER_TYPES.BUY)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, false, 'create into occupied slot should be invalid');
        assert.strictEqual(result.violations.length, 1, 'exactly one violation');
        assert.strictEqual(result.violations[0].reason, 'slot_occupied', 'reason should be slot_occupied');
    }

    // ── 2. Master grid price collision — REMOVED (genesis-frozen determinism)
    // Same-price different-slot is now VALID (price not authority, slot id is).
    console.log(' - 2. Master grid price collision (now valid)...');
    {
        const orders = mapToOrders([
            makeOrder('slot-a', ORDER_TYPES.SELL, 123.45, 30, ORDER_STATES.ACTIVE, '1.7.10'),
            makeOrder('slot-b', ORDER_TYPES.SELL, 123.45, 30, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-b', 123.45, ORDER_TYPES.SELL)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'same-price different-slot should now be valid (price collision layer removed)');
        assert.strictEqual(result.violations.length, 0, 'zero violations');
    }

    // ── 3. Same price on different side is now VALID ───────────
    console.log(' - 2b. Same price different side is now valid...');
    {
        const orders = mapToOrders([
            makeOrder('slot-buy', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.20'),
            makeOrder('slot-sell', ORDER_TYPES.SELL, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-sell', 100, ORDER_TYPES.SELL)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'same price different side is now valid');
        assert.strictEqual(result.violations.length, 0, 'zero violations');
    }

    // ── 4. Chain orphan collision ─────────────────────────────────────
    console.log(' - 3. Chain orphan collision...');
    {
        const orders = mapToOrders([
            makeOrder('slot-new', ORDER_TYPES.BUY, 200, 40, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-new', 200, ORDER_TYPES.BUY)];
        const chainOrderCandidates = [
            { chainOrderId: '1.7.99', chainSlotId: 'slot-new', candidateSlotId: 'slot-new', price: 200, size: 10, type: ORDER_TYPES.BUY }
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets, chainOrderCandidates);
        assert.strictEqual(result.isValid, false, 'chain orphan collision should be invalid');
        assert.strictEqual(result.violations.length, 1, 'exactly one violation');
        assert.strictEqual(result.violations[0].reason, 'chain_orphan_collision', 'reason should be chain_orphan_collision');
    }

    // ── 5. Same-batch duplicate (duplicate slotId) ──────────────────────
    console.log(' - 4. Same-batch duplicate...');
    {
        const orders = mapToOrders([
            makeOrder('slot-x', ORDER_TYPES.BUY, 50, 20, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [
            makeCreateAction('slot-x', 50, ORDER_TYPES.BUY),
            makeCreateAction('slot-x', 50, ORDER_TYPES.BUY)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, false, 'same-batch duplicate should be invalid');
        assert.strictEqual(result.violations.length, 1, 'exactly one violation');
        assert.strictEqual(result.violations[0].reason, 'same_batch_price_collision', 'reason should be same_batch_price_collision');
    }

    // ── 6. Clean batch passes ─────────────────────────────────────────
    console.log(' - 5. Clean batch passes...');
    {
        const orders = mapToOrders([
            makeOrder('s1', ORDER_TYPES.BUY, 90, 20, ORDER_STATES.VIRTUAL, null),
            makeOrder('s2', ORDER_TYPES.SELL, 110, 20, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [
            makeCreateAction('s1', 90, ORDER_TYPES.BUY),
            makeCreateAction('s2', 110, ORDER_TYPES.SELL)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'clean batch should be valid');
        assert.strictEqual(result.violations.length, 0, 'zero violations');
    }

    // ── 7. Released slots (cancel frees the slot) ─────────────────────
    console.log(' - 6. Cancel releases slot...');
    {
        const orders = mapToOrders([
            makeOrder('slot-occ', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.1'),
            makeOrder('slot-vac', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        // Cancel releases slot-occ, then create into it (same id, same price)
        const actions = [
            makeCancelAction('slot-occ'),
            makeCreateAction('slot-occ', 100, ORDER_TYPES.BUY)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'cancel releases slot for create');
    }

    // ── 8. Chain orphan with malformed entries ────────────────────────
    console.log(' - 7. Malformed chain orphan entries are skipped...');
    {
        const orders = mapToOrders([
            makeOrder('slot-m', ORDER_TYPES.SELL, 150, 30, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-m', 150, ORDER_TYPES.SELL)];
        // One entry missing chainOrderId, one missing price — both should be filtered
        const chainOrderCandidates = [
            { price: 150, size: 10, type: ORDER_TYPES.SELL },
            { chainOrderId: '1.7.200', size: 10, type: ORDER_TYPES.SELL }
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets, chainOrderCandidates);
        assert.strictEqual(result.isValid, true, 'malformed entries should be filtered without crashing');
    }

    // ── 9. Assets required for collision checks ────────────────────────
    console.log(' - 8. No assets → no price collision checks (slot occupancy still works)...');
    {
        const orders = mapToOrders([
            makeOrder('slot-a', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.1')
        ]);
        const actions = [makeCreateAction('slot-a', 100, ORDER_TYPES.BUY)];
        const result = validateCreateTargetSlots(actions, orders, null);
        assert.strictEqual(result.isValid, false, 'slot occupancy works without assets');
        assert.strictEqual(result.violations[0].reason, 'slot_occupied');
    }

    // ── 10. Release via rotation (UPDATE with newGridId) ──────────────
    console.log(' - 9. Rotation releases source slot...');
    {
        const orders = mapToOrders([
            makeOrder('src', ORDER_TYPES.SELL, 100, 50, ORDER_STATES.ACTIVE, '1.7.1'),
            makeOrder('released-slot', ORDER_TYPES.SELL, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        // Rotation UPDATE releases src; create into src slot at same price
        const actions = [
            makeRotationAction('src', 'released-slot'),
            makeCreateAction('src', 100, ORDER_TYPES.SELL)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'rotation releases source slot for create');
    }

    // ── 11. Exact-level same-batch price duplicate (ladder-level key) ────
    console.log(' - 10. Layer-5 exact-level price duplicate keying...');
    {
        // Two CREATEs at the SAME price on different slots are a degenerate
        // plan and must collide so only the first survives.
        const identical = [
            makeCreateAction('slot-a', 100, ORDER_TYPES.SELL),
            makeCreateAction('slot-b', 100, ORDER_TYPES.SELL)
        ];
        const resIdentical = validateCreateTargetSlots(identical, new Map(), dummyAssets);
        assert.strictEqual(resIdentical.isValid, false, 'one-price plan is a duplicate');
        const dup = resIdentical.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(dup, 'violation reason is same_batch_price_duplicate');
        assert.strictEqual(dup.targetId, 'slot-b', 'first target wins, later duplicate flagged');

        // Distinct ladder levels must NOT false-positive, even when they
        // quantize to the same ASSET-precision integer. A price is not an
        // amount: rounding it through one asset's precision collapses an
        // adjacent band for a low-precision asset (precision-4 quote).
        const adjacent = [
            makeCreateAction('slot-a', 100.0000001, ORDER_TYPES.SELL),
            makeCreateAction('slot-b', 100.0000002, ORDER_TYPES.SELL)
        ];
        const resAdjacent = validateCreateTargetSlots(adjacent, new Map(), dummyAssets);
        const dupAdjacent = resAdjacent.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(!dupAdjacent, 'distinct levels are distinct prices, no false positive');

        // The reported production shape: precision-4 quote asset, adjacent
        // BUY ladder levels 0.000318 / 0.000319 (both -> 3 at precision 4).
        const lowPrecisionAssets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 8 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 4 }
        };
        const lowPrecisionBuys = [
            { type: COW_ACTIONS.CREATE, id: 'slot-77', order: { id: 'slot-77', price: 0.000318, type: ORDER_TYPES.BUY, size: 1.67 } },
            { type: COW_ACTIONS.CREATE, id: 'slot-78', order: { id: 'slot-78', price: 0.000319, type: ORDER_TYPES.BUY, size: 1.68 } }
        ];
        const resLowPrecision = validateCreateTargetSlots(lowPrecisionBuys, new Map(), lowPrecisionAssets);
        const dupLowPrecision = resLowPrecision.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(!dupLowPrecision, 'adjacent low-precision BUY levels must not collapse into a duplicate');

        // Asset-less callers behave the same (exact float key).
        const resFallback = validateCreateTargetSlots(adjacent, new Map(), null);
        const dupFallback = resFallback.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(!dupFallback, 'asset-less callers use the exact float key');
    }

    // ── 12. Broadcast-price keying (layer-5 guards the batch) ────
    console.log(' - 11. Layer-5 keys on the broadcast price, not the live slot price...');
    {
        // Live slots sit at divergent prices (100 vs 200); both CREATEs
        // broadcast 150. Keying on the live price would see {100, 200} (no
        // collision); keying on the broadcast price sees {150, 150}.
        const orders = mapToOrders([
            makeOrder('slot-a', ORDER_TYPES.SELL, 100, 30, ORDER_STATES.VIRTUAL, null),
            makeOrder('slot-b', ORDER_TYPES.SELL, 200, 30, ORDER_STATES.VIRTUAL, null)
        ]);
        // makeOrder defaults orderId to `${id}-oid` when falsy — VIRTUAL
        // slots are never on-chain, so clear them explicitly.
        (orders.get('slot-a') as any).orderId = null;
        (orders.get('slot-b') as any).orderId = null;
        const actions = [
            makeCreateAction('slot-a', 150, ORDER_TYPES.SELL),
            makeCreateAction('slot-b', 150, ORDER_TYPES.SELL)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, false, 'two CREATEs broadcasting the same price must collide');
        const dup = result.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(dup, 'violation reason is same_batch_price_duplicate');
        assert.strictEqual(dup.targetId, 'slot-b', 'first target wins, later duplicate flagged');
    }

    // ── 13. NaN broadcast price fails closed ────
    console.log(' - 12. NaN broadcast price fails closed...');
    {
        const orders = mapToOrders([
            makeOrder('slot-n', ORDER_TYPES.SELL, 150, 30, ORDER_STATES.VIRTUAL, null)
        ]);
        (orders.get('slot-n') as any).orderId = null;
        const actions = [makeCreateAction('slot-n', NaN, ORDER_TYPES.SELL)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, false, 'unpriceable CREATE must be invalid');
        const bad = result.violations.find(v => v.reason === 'create_price_invalid');
        assert.ok(bad, 'violation reason is create_price_invalid');
        assert.strictEqual(bad.targetId, 'slot-n', 'violation targets the unpriceable CREATE slot');
    }

    // ── 14. A virtualised slot that still OWNS a chain id is occupied ──
    // Live incident class: a slot virtualised while its order stayed on chain
    // (phantom cleanup on a truncated read, refused-commit adoption) read as
    // "empty" under isOrderOnChain (ACTIVE/PARTIAL only), so a CREATE was
    // planned onto a level that already held a live order — a duplicate price
    // level. Occupancy is the ID, not the state.
    console.log(' - 14. Virtualised slot owning a chain id is occupied...');
    {
        const orders = mapToOrders([
            makeOrder('slot-dark', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.VIRTUAL, '1.7.424242')
        ]);
        const actions = [makeCreateAction('slot-dark', 100, ORDER_TYPES.BUY)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, false, 'a VIRTUAL slot owning a chain id must refuse the CREATE');
        assert.strictEqual(result.violations[0].reason, 'slot_occupied');

        // THE SAME SLOT with the id gone is a genuine hole: creatable again.
        // (Sync pass 1 clears a stale id with `sync-clear-stale-id`, so a level
        // whose order really disappeared is never stranded by this gate.)
        const clearOrders = mapToOrders([
            makeOrder('slot-dark', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        const cleared = validateCreateTargetSlots(actions, clearOrders, dummyAssets);
        assert.strictEqual(cleared.isValid, true, `a cleared/stale-free hole must stay creatable, got ${JSON.stringify(cleared.violations)}`);

        // A possibly-landed CREATE (createUncertain) is occupied too: its order
        // may exist on chain under an id the master does not know yet.
        const uncertainOrders = mapToOrders([
            makeOrder('slot-uncertain', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        (uncertainOrders.get('slot-uncertain') as any).createUncertain = true;
        const uncertain = validateCreateTargetSlots(
            [makeCreateAction('slot-uncertain', 100, ORDER_TYPES.BUY)], uncertainOrders, dummyAssets
        );
        assert.strictEqual(uncertain.isValid, false, 'an uncertain CREATE must not be re-created');
        // Distinct reason: an unknown outcome is NOT proof of a live order, so
        // the batch is not hard-aborted — only this CREATE is withheld.
        assert.strictEqual(uncertain.violations[0].reason, 'slot_create_uncertain');
    }

    // ── 15. Chain-orphan price fallback honors the increment cap ────
    console.log(' - 15. Chain-orphan fallback caps tolerance to the grid increment...');
    {
        // A dust-sized order inflates calculatePriceTolerance above the grid
        // step, so without the cap the adjacent level 0.000319 collides with
        // the CREATE at 0.000318 through the slotless chain-orphan fallback.
        const lowPrecisionAssets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 8 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 4 }
        };
        const actions = [{
            type: COW_ACTIONS.CREATE, id: 'slot-77',
            order: { id: 'slot-77', price: 0.000318, type: ORDER_TYPES.BUY, size: 1e-6 }
        }];
        // Slotless orphan (no chainSlotId/candidateSlotId) → price fallback.
        const slotlessOrphan = [
            { chainOrderId: '1.7.500', price: 0.000319, size: 1e-6, type: ORDER_TYPES.BUY }
        ];

        const uncapped = validateCreateTargetSlots(actions, new Map(), lowPrecisionAssets, slotlessOrphan);
        assert.ok(
            uncapped.violations.some(v => v.reason === 'chain_orphan_collision'),
            'without an increment, the dust-inflated tolerance collides adjacent levels'
        );

        const capped = validateCreateTargetSlots(actions, new Map(), lowPrecisionAssets, slotlessOrphan, 0.4);
        assert.ok(
            !capped.violations.some(v => v.reason === 'chain_orphan_collision'),
            'increment cap keeps adjacent chain-orphan levels distinct'
        );
    }

    // ── 16. Pending-broadcast collision ────────────────────────────────
    console.log(' - 16. Pending uncertain CREATE blocks duplicate slot/price...');
    {
        const emptySlot = mapToOrders([
            makeOrder('slot-10', ORDER_TYPES.BUY, 100, 0, ORDER_STATES.VIRTUAL, null)
        ]);
        const pending = [{ slotId: 'slot-10', price: 100, size: 100, type: ORDER_TYPES.BUY, fingerprint: 'fp-10' }];
        const sameSlot = validateCreateTargetSlots(
            [makeCreateAction('slot-10', 100, ORDER_TYPES.BUY)], emptySlot, dummyAssets, [], null, pending
        );
        assert.strictEqual(sameSlot.isValid, false, 'a pending CREATE on the same slot must block the new CREATE');
        assert.strictEqual(sameSlot.violations[0].reason, 'pending_broadcast_collision');

        const samePrice = validateCreateTargetSlots(
            [makeCreateAction('slot-11', 100, ORDER_TYPES.BUY)], emptySlot, dummyAssets, [], null, pending
        );
        assert.strictEqual(samePrice.isValid, false, 'a pending CREATE at the same price on another slot must block the new CREATE');
        assert.strictEqual(samePrice.violations[0].reason, 'pending_broadcast_collision');

        const otherSide = validateCreateTargetSlots(
            [makeCreateAction('slot-11', 100, ORDER_TYPES.SELL)], emptySlot, dummyAssets, [], null, pending
        );
        assert.strictEqual(otherSide.isValid, true, 'the opposite side at the same price is not a collision');
    }

    console.log('\n✓ validateCreateTargetSlots tests PASSED!');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});

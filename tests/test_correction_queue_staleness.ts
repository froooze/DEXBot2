/**
 * tests/test_correction_queue_staleness.ts
 *
 * Regression tests for the stale-correction replay incident class
 * (duplicate price levels from a resync-reverting UPDATE):
 *
 * Fix 1 — correctAllPriceMismatches validates price-update entries against
 *   the LIVE slot at drain time and drops stale ones without broadcasting:
 *   1a. Re-slotted entry (slot now owns a different chain order) is dropped.
 *   1b. Re-priced entry (slot now targets a different price) is dropped.
 *   1c. Fresh entry (slot still owns the order at the queued price) broadcasts.
 *   1d. Untracked cancel-only entries still cancel; once the same chain id
 *       is relocated/adopted into a live slot, the stale cancel is dropped.
 * Fix 2 — a zero-delta updateOrder (null) counts as resolved, not failed:
 *   2a. null update yields {success:true, skipped:true} (not failed).
 *   2b. correctAllPriceMismatches reports failed===0 for a no-op drain.
 * Fix 3 — provenance: stale-drop log names the queuing detector + time.
 * Fix 4 — a fill-retagged slot is not a repaired mismatch:
 *   4a. slot.type adopted the chain side but the rail geometry disagrees → cancel.
 *   4b. slot.type AND the rail geometry agree with the chain side → drop.
 *   4c. a gap-band level is never "repaired" by its label.
 */
const assert = require('assert');
const {
    correctOrderPriceOnChain,
    correctAllPriceMismatches,
    _validatePriceCorrectionEntry,
    _stampCorrectionProvenance,
} = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { makeLadderFromPrices } = require('./helpers/order_test_helpers');

const ASSETS = {
    assetA: { id: '1.3.0', precision: 5, symbol: 'HONEST' },
    assetB: { id: '1.3.861', precision: 5, symbol: 'BTS' },
};

function liveSell(id, orderId, price, size = 850) {
    return { id, orderId, type: ORDER_TYPES.SELL, price, size, state: ORDER_STATES.ACTIVE };
}

// Minimal manager harness: live slots Map + correction queue + logger + fake _gridLock.
function createManager(ordersList, queue = []) {
    const logs = [];
    // The engine is genesis-frozen: staleness is decided by priceSlotEqual
    // against the slot's own level, which needs a ladder. Build one from the
    // prices this fixture uses so every slot price IS a level.
    const fixturePrices = [
        ...ordersList.map((o) => o.price),
        ...queue.map((e) => e.expectedPrice),
    ];
    const manager = {
        orders: new Map(ordersList.map((o) => [o.id, { ...o }])),
        assets: ASSETS,
        ordersNeedingPriceCorrection: queue.map((e) => ({ ...e })),
        _lastUnmatchedChainOrders: [] as any[],
        _placedAt: new Map<string, number>(),
        _genesis: makeLadderFromPrices(fixturePrices),
        boundaryIdx: 0,
        _gapSlots: 0,
        config: { fillProcessing: { CORRECTION_INTER_OP_DELAY_MS: 0 } } as any,
        isBroadcastingActive: undefined as any,
        _gapEvacCancelQueued: new Set<string>(),
        logger: { log: (msg, level) => logs.push(`[${level}] ${msg}`) },
        _gridLock: { acquire: async (fn) => fn() },
    };
    return { manager, logs };
}

function priceEntry(slotId, chainOrderId, expectedPrice, extra = {}) {
    return {
        gridOrder: { id: slotId },
        chainOrderId,
        expectedPrice,
        actualPrice: expectedPrice - 0.001,
        size: 850,
        type: ORDER_TYPES.SELL,
        isSurplus: false,
        cancelOnly: false,
        queuedAt: Date.now() - 3600_000,
        queuedBy: 'sync-price-mismatch',
        ...extra,
    };
}

async function run() {
    console.log('Running correction queue staleness tests...');

    // ---- 1a. Re-slotted entry is dropped without broadcast ----
    {
        const { manager, logs } = createManager(
            [liveSell('slot-89', '1.7.999', 0.312638)], // slot re-slotted to a NEW chain order
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, false, 'stale re-slotted entry must not broadcast');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'stale entry must be dropped');
        assert.strictEqual(out.staleDropped, 1, 'summary must count the stale drop');
        assert.strictEqual(out.failed, 0, 'stale drop must not count as failed');
        assert(logs.some((l) => l.includes('Dropping stale price correction for 1.7.574249250')), 'must log the drop');
        assert(logs.some((l) => l.includes('sync-price-mismatch')), 'drop log must name the queuing detector');
        console.log('  - re-slotted entry dropped without broadcast');
    }

    // ---- 1b. Re-priced entry is dropped without broadcast ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.320000)], // same order, slot moved on
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, false, 'stale re-priced entry must not broadcast');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'stale entry must be dropped');
        assert.strictEqual(out.staleDropped, 1);
        console.log('  - re-priced entry dropped without broadcast');
    }

    // ---- 1c. Fresh entry still broadcasts ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return { success: true }; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, true, 'fresh entry must broadcast');
        assert.strictEqual(out.corrected, 1);
        assert.strictEqual(out.staleDropped, 0);
        console.log('  - fresh entry broadcasts normally');
    }

    // ---- 1c2. Direct surplus settlement never falls back to a stale snapshot ----
    {
        const oldChainId = '1.7.574249250';
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.999', 0.312638)],
            [{
                gridOrder: { id: 'slot-89', type: ORDER_TYPES.SELL, price: 0.312638, size: 850 },
                chainOrderId: oldChainId,
                expectedPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                isSurplus: true,
            }]
        );
        let cancelCalled = false;
        let applyCalled = false;
        (manager as any)._applyOrderUpdate = async () => { applyCalled = true; return true; };
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };

        const out = await correctOrderPriceOnChain(manager, manager.ordersNeedingPriceCorrection[0], 'acct', 'k', accountOrders);
        assert.strictEqual(out.success, true, 'surplus cancellation should still succeed');
        assert.strictEqual(cancelCalled, true, 'surplus cancellation should broadcast');
        assert.strictEqual(applyCalled, false,
            'settlement must not virtualize a slot that now owns a different chain order');
        console.log('  - direct surplus settlement rejects a stale-snapshot fallback');
    }

    // ---- 1d. Untracked cancel-only entry still broadcasts ----
    {
        const { manager } = createManager(
            [], // no grid slot owns this chain order, so duplicate-orphan cancel is still valid
            [{
                gridOrder: { id: 'slot-89' },
                chainOrderId: '1.7.111',
                expectedPrice: 0.31,
                size: 850,
                type: ORDER_TYPES.SELL,
                isSurplus: true,
                cancelOnly: true,
                queuedAt: Date.now(),
                queuedBy: 'sync-duplicate-orphan',
            }]
        );
        let cancelCalled = false;
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancelCalled, true, 'untracked cancel-only entry must still broadcast');
        assert.strictEqual(out.corrected, 1);
        console.log('  - untracked cancel-only entries still cancel');
    }

    // ---- 1d2. Relocated cancel-only entry is dropped without broadcast ----
    // Incident shape: sync classified a chain order as a duplicate of slot-91,
    // then startup reconcile relocated that same chain id into empty slot-92.
    // Replaying the old cancel would destroy the successful in-place update.
    {
        const chainOrderId = '1.7.900000833';
        const { manager, logs } = createManager(
            [
                liveSell('slot-91', '1.7.900000838', 0.312638),
                liveSell('slot-92', chainOrderId, 0.309000),
            ],
            [{
                gridOrder: { id: 'slot-91' },
                chainOrderId,
                expectedPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                isSurplus: true,
                cancelOnly: true,
                queuedAt: Date.now() - 1_000,
                queuedBy: 'sync-duplicate-orphan',
            }]
        );
        manager._lastUnmatchedChainOrders = [{ chainOrderId }];
        let cancelCalled = false;
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);

        assert.strictEqual(cancelCalled, false, 'relocated chain order must not be cancelled');
        assert.strictEqual(out.corrected, 0, 'stale cancel must not count as corrected');
        assert.strictEqual(out.staleDropped, 1, 'relocated cancel must be counted as stale');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'stale cancel must leave the queue');
        assert.deepStrictEqual(manager._lastUnmatchedChainOrders, [], 'adopted order must leave the unmatched set');
        assert(logs.some((l) => l.includes('Dropping stale cancel correction')), 'must log the stale cancel drop');
        assert(logs.some((l) => l.includes('now owned by slot-92')), 'log must identify the new owning slot');
        console.log('  - relocated cancel-only entry dropped without cancel broadcast');
    }

    // ---- 1d3. Repaired type-mismatch entry is dropped without broadcast ----
    // A type-mismatch correction must not replay after the live slot has been
    // retyped to the chain order's actual side.
    {
        const chainOrderId = '1.7.900001001';
        const { manager } = createManager(
            [liveSell('slot-89', chainOrderId, 0.31)],
            [{
                gridOrder: { id: 'slot-89' },
                chainOrderId,
                expectedPrice: 0.31,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                queuedAt: Date.now() - 1_000,
                queuedBy: 'sync-type-mismatch',
            }]
        );
        manager._lastUnmatchedChainOrders = [{ chainOrderId }];
        let cancelCalled = false;
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);

        assert.strictEqual(cancelCalled, false, 'repaired type-mismatch order must not be cancelled');
        assert.strictEqual(out.staleDropped, 1);
        assert.deepStrictEqual(manager._lastUnmatchedChainOrders, []);
        console.log('  - repaired type-mismatch entry dropped without cancel broadcast');
    }

    // ---- 1d4. Gap-evacuation entry is dropped after geometry repair ----
    {
        const chainOrderId = '1.7.900001002';
        const { manager, logs } = createManager(
            [liveSell('slot-101', chainOrderId, 0.31)],
            [{
                gridOrder: { id: 'slot-101', type: ORDER_TYPES.SELL, price: 0.31, size: 850 },
                chainOrderId,
                expectedPrice: 0.31,
                size: 850,
                type: ORDER_TYPES.SELL,
                isSurplus: true,
                gapEvacuation: true,
                boundaryIdx: 100,
                queuedAt: Date.now() - 1_000,
                queuedBy: 'gap-evacuation',
            }]
        );
        manager.boundaryIdx = 100;
        manager._gapSlots = 0; // slot-101 is now outside the current gap
        manager._gapEvacCancelQueued = new Set(['slot-101']);
        manager._lastUnmatchedChainOrders = [{ chainOrderId }];
        let cancelCalled = false;
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);

        assert.strictEqual(cancelCalled, false, 'geometry-repaired gap-evacuation order must not be cancelled');
        assert.strictEqual(out.staleDropped, 1);
        assert.strictEqual(manager._gapEvacCancelQueued.size, 0, 'stale gap marker must be released');
        assert.deepStrictEqual(manager._lastUnmatchedChainOrders, []);
        assert(logs.some((l) => l.includes('no longer in the current gap band')));
        console.log('  - geometry-repaired gap-evacuation entry dropped without cancel broadcast');
    }

    // ---- 1d5. Still-valid surplus decisions still cancel ----
    {
        const chainOrderId = '1.7.900001003';
        const { manager } = createManager(
            [{ ...liveSell('slot-89', chainOrderId, 0.31), type: ORDER_TYPES.BUY }],
            [{
                gridOrder: { id: 'slot-89', type: ORDER_TYPES.BUY, price: 0.31 },
                chainOrderId,
                expectedPrice: 0.31,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                queuedAt: Date.now() - 1_000,
                queuedBy: 'sync-type-mismatch',
            }]
        );
        let cancelCalled = false;
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);

        assert.strictEqual(cancelCalled, true, 'unrepaired type-mismatch must still cancel');
        assert.strictEqual(out.corrected, 1);
        console.log('  - unrepaired type-mismatch still cancels');
    }

    // ---- 1d6. Still-valid gap-evacuation entry still cancels ----
    {
        const chainOrderId = '1.7.900001004';
        const { manager } = createManager(
            [liveSell('slot-101', chainOrderId, 0.31)],
            [{
                gridOrder: { id: 'slot-101', type: ORDER_TYPES.SELL, price: 0.31, size: 850 },
                chainOrderId,
                expectedPrice: 0.31,
                size: 850,
                type: ORDER_TYPES.SELL,
                isSurplus: true,
                gapEvacuation: true,
                boundaryIdx: 100,
                queuedAt: Date.now() - 1_000,
                queuedBy: 'gap-evacuation',
            }]
        );
        manager.boundaryIdx = 100;
        manager._gapSlots = 2; // slot-101 remains inside the current gap
        manager._gapEvacCancelQueued = new Set(['slot-101']);
        let cancelCalled = false;
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);

        assert.strictEqual(cancelCalled, true, 'still-in-band gap evacuation must cancel');
        assert.strictEqual(out.corrected, 1);
        console.log('  - still-valid gap-evacuation entry still cancels');
    }

    // ---- 1e. Missing slot drops the entry (unit-level) ----
    {
        const { manager } = createManager([], []);
        const check = _validatePriceCorrectionEntry(manager, priceEntry('slot-89', '1.7.1', 0.31));
        assert.strictEqual(check.valid, false, 'entry for a missing slot is stale');
        assert(check.reason.includes('no longer exists'));
        console.log('  - missing-slot entry invalid');
    }

    // ---- 1f. Fill-changed size drops the entry without broadcast ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638, 400)], // partial fill: 850 -> 400
            [priceEntry('slot-89', '1.7.574249250', 0.312638, { size: 850 })]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, false, 'fill-changed entry must not broadcast stale size');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'stale entry must be dropped');
        assert.strictEqual(out.staleDropped, 1);
        console.log('  - fill-changed size entry dropped without broadcast');
    }

    // ---- 1g. Stale cancel sibling is removed without suppressing its price update ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [
                // Same chain id, different queue keys: the cancel sibling must
                // survive when the price sibling is consumed.
                priceEntry('slot-89', '1.7.574249250', 0.312638),
                {
                    gridOrder: { id: 'slot-89' },
                    chainOrderId: '1.7.574249250',
                    expectedPrice: 0.312638,
                    size: 850,
                    type: ORDER_TYPES.SELL,
                    isSurplus: true,
                    cancelOnly: true,
                    queuedAt: Date.now(),
                    queuedBy: 'sync-duplicate-orphan',
                },
            ]
        );
        let cancelCalled = false;
        const accountOrders = {
            updateOrder: async () => ({ success: true }),
            cancelOrder: async () => { cancelCalled = true; return { success: true }; },
        };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        // The price entry remains actionable. Its cancel-only sibling describes
        // an untracked duplicate that no longer exists because the same order is
        // now owned by the live grid, so only the UPDATE broadcasts.
        assert.strictEqual(cancelCalled, false, 'stale cancel sibling must not broadcast');
        assert.strictEqual(out.corrected, 1, 'price sibling must still correct');
        assert.strictEqual(out.staleDropped, 1, 'cancel sibling must be dropped as stale');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'both entries resolved');
        console.log('  - stale cancel sibling dropped while price sibling updates');
    }

    // ---- 1h. Sibling survives when only the price entry is consumed ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [
                priceEntry('slot-89', '1.7.574249250', 0.312638),
                {
                    gridOrder: { id: 'slot-89' },
                    chainOrderId: '1.7.574249250',
                    expectedPrice: 0.312638,
                    size: 850,
                    type: ORDER_TYPES.SELL,
                    isSurplus: true,
                    cancelOnly: true,
                    queuedAt: Date.now(),
                    queuedBy: 'sync-duplicate-orphan',
                },
            ]
        );
        // Only the price entry executes: its full-key removal must leave the
        // cancel sibling queued. (correctOrderPriceOnChain consumes one entry.)
        const accountOrders = { updateOrder: async () => ({ success: true }) };
        const priceOnly = manager.ordersNeedingPriceCorrection.find((e) => !e.isSurplus);
        const { correctOrderPriceOnChain: single } = require('../modules/order/utils/order');
        await single(manager, priceOnly, 'acct', 'k', accountOrders);
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 1, 'sibling entry must survive');
        assert.strictEqual(
            manager.ordersNeedingPriceCorrection[0].cancelOnly, true, 'survivor must be the cancel sibling'
        );
        console.log('  - single-entry removal preserves the sibling');
    }

    // ---- 2a. Zero-delta (null) update resolves instead of failing ----
    {
        const { manager } = createManager([liveSell('slot-89', '1.7.574249250', 0.312638)]);
        manager.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.574249250' }];
        const accountOrders = { updateOrder: async () => null }; // "Delta is 0; skipping"
        const result = await correctOrderPriceOnChain(
            manager, priceEntry('slot-89', '1.7.574249250', 0.312638), 'acct', 'k', accountOrders
        );
        assert.strictEqual(result.success, true, 'no-op update must report success');
        assert.strictEqual(result.skipped, true, 'no-op update must report skipped');
        assert.strictEqual(result.error, undefined, 'no-op update must carry no error');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'no-op entry must be dequeued');
        console.log('  - zero-delta update counts as resolved');
    }

    // ---- 2b. No-op drain reports failed===0 ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        const accountOrders = { updateOrder: async () => null };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(out.corrected, 1, 'no-op counts as corrected (resolved)');
        assert.strictEqual(out.failed, 0, 'no-op must not count as failed');
        console.log('  - no-op drain reports zero failures');
    }

    // ---- 3. Provenance stamping preserves first-seen values ----
    {
        const first = _stampCorrectionProvenance({ chainOrderId: '1.7.1' }, 'sync-price-mismatch');
        assert(first.queuedAt > 0 && first.queuedBy === 'sync-price-mismatch', 'stamp must fill missing provenance');
        const kept = _stampCorrectionProvenance(
            { chainOrderId: '1.7.1', queuedAt: 123, queuedBy: 'sync-duplicate-orphan' },
            'sync-price-mismatch'
        );
        assert.strictEqual(kept.queuedAt, 123, 're-queue must keep original queuedAt');
        assert.strictEqual(kept.queuedBy, 'sync-duplicate-orphan', 're-queue must keep original detector');
        console.log('  - provenance stamping preserves first-seen values');
    }

    // ---- 4a. Update budget caps the sequential loop; remainder stays queued ----
    {
        const slots = [];
        const queue = [];
        for (let i = 0; i < 7; i++) {
            slots.push(liveSell(`slot-b${i}`, `1.7.b${i}`, 0.3 + i * 0.01));
            queue.push(priceEntry(`slot-b${i}`, `1.7.b${i}`, 0.3 + i * 0.01));
        }
        const { manager } = createManager(slots, queue);
        manager.config = { fillProcessing: { CORRECTION_MAX_UPDATES_PER_CYCLE: 3, CORRECTION_INTER_OP_DELAY_MS: 0 } };
        let updates = 0;
        const accountOrders = { updateOrder: async () => { updates++; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updates, 3, 'only the budgeted updates broadcast');
        assert.strictEqual(out.corrected, 3);
        assert.strictEqual(out.deferredUpdates, 4, 'remainder reported as deferred');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 4, 'remainder stays queued durably');
        console.log('  - update budget caps the sequential loop; remainder stays queued');
    }

    // ---- 4a-time. Hold-time budget caps the drain when no count cap is set ----
    {
        const slots = [];
        const queue = [];
        for (let i = 0; i < 6; i++) {
            slots.push(liveSell(`slot-t${i}`, `1.7.t${i}`, 0.3 + i * 0.01));
            queue.push(priceEntry(`slot-t${i}`, `1.7.t${i}`, 0.3 + i * 0.01));
        }
        const { manager } = createManager(slots, queue);
        // No CORRECTION_MAX_UPDATES_PER_CYCLE, so the elapsed-time budget alone
        // must bound the drain. Simulate a slow chain (large RPC round-trip) by
        // advancing the clock past the budget on the first update.
        manager.config = { fillProcessing: { CORRECTION_LOCK_HOLD_BUDGET_MS: 4000, CORRECTION_INTER_OP_DELAY_MS: 0 } };
        const realNow = Date.now;
        let clock = 1_000_000;
        Date.now = () => clock;
        let updates = 0;
        const accountOrders = {
            updateOrder: async () => { updates++; clock += 60_000; return {}; },
        };
        let out;
        try {
            out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        } finally {
            Date.now = realNow;
        }
        assert.strictEqual(updates, 1, 'slow chain must stop once the time budget is exceeded');
        assert.strictEqual(out.corrected, 1);
        assert.strictEqual(out.deferredUpdates, 5, 'remainder reported as deferred');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 5, 'remainder stays queued durably');
        console.log('  - hold-time budget caps the drain without a count cap');
    }

    // ---- 4b. Zero update budget still drains cancel-class entries ----
    {
        const { manager } = createManager(
            [liveSell('slot-x', '1.7.x', 0.3)],
            [
                priceEntry('slot-x', '1.7.x', 0.3),
                {
                    gridOrder: { id: 'slot-x' },
                    chainOrderId: '1.7.cancel',
                    expectedPrice: 0.3,
                    size: 850,
                    type: ORDER_TYPES.SELL,
                    isSurplus: true,
                    cancelOnly: true,
                    queuedAt: Date.now(),
                    queuedBy: 'sync-duplicate-orphan',
                },
            ]
        );
        manager.config = { fillProcessing: { CORRECTION_MAX_UPDATES_PER_CYCLE: 0, CORRECTION_INTER_OP_DELAY_MS: 0 } };
        let cancels = 0; let updates = 0;
        const accountOrders = {
            updateOrder: async () => { updates++; return {}; },
            cancelOrder: async () => { cancels++; return { success: true }; },
        };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 1, 'cancel-class entries must always drain');
        assert.strictEqual(updates, 0, 'zero budget suppresses updates');
        assert.strictEqual(out.deferredUpdates, 1, 'update deferred to next cycle');
        console.log('  - zero update budget still drains cancels');
    }

    // ---- 4c. Broadcast-active pre-acquire deferral (7a) ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        let lockAcquired = false;
        manager._gridLock = { acquire: async () => { lockAcquired = true; throw new Error('must not acquire during broadcast'); } };
        manager.isBroadcastingActive = () => true;
        let updates = 0;
        const accountOrders = { updateOrder: async () => { updates++; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(out.deferred, true, 'drain must defer under broadcast');
        assert.strictEqual(lockAcquired, false, 'must not take _gridLock during broadcast');
        assert.strictEqual(updates, 0, 'no broadcast during defer');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 1, 'entry stays queued');
        console.log('  - broadcast-active drain defers without taking _gridLock');
    }

    // ---- 4d. Backlog threshold alarm (6b) ----
    {
        const { manager, logs } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638), liveSell('slot-90', '1.7.90', 0.4)],
            [priceEntry('slot-89', '1.7.574249250', 0.312638), priceEntry('slot-90', '1.7.90', 0.4)]
        );
        manager.config = { fillProcessing: { CORRECTION_QUEUE_WARN_THRESHOLD: 2, CORRECTION_INTER_OP_DELAY_MS: 0 } };
        const accountOrders = { updateOrder: async () => ({}) };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.ok(logs.some((l: string) => l.includes('Backlog')), 'backlog threshold must warn');
        console.log('  - backlog threshold emits a warn');
    }

    // ---- 5. Type-mismatch cancels bypass the fresh-placement grace ----
    // A live order on the WRONG side must not rest for SURPLUS_CANCEL_GRACE_MS
    // (15 min): its next fill is classified against the slot's wrong side
    // (2026-11-04 live incident: a sell on a slot retyped BUY produced a
    // filledAmount=0 phantom fill and a re-buy at the fill level).
    {
        const freshChainId = '1.7.777001';
        const wrongSideSlot = {
            id: 'slot-80', orderId: freshChainId, type: ORDER_TYPES.BUY,
            price: 0.312638, size: 850, state: ORDER_STATES.ACTIVE,
        };
        const { manager, logs } = createManager(
            [wrongSideSlot],
            [{
                gridOrder: { id: 'slot-80', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: freshChainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        // Freshly placed: inside the 15-minute surplus-cancel grace.
        manager._placedAt = new Map([[freshChainId, Date.now()]]);
        let cancels = 0; let updates = 0;
        const accountOrders = {
            updateOrder: async () => { updates++; return {}; },
            cancelOrder: async () => { cancels++; return { success: true }; },
        };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 1, 'a fresh type-mismatch order must be cancelled, not deferred');
        assert.strictEqual(updates, 0, 'a wrong-side order is cancelled, never price-updated');
        assert.strictEqual(out.corrected, 1, 'the cancel must count as corrected');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'the entry must leave the queue');
        assert(!logs.some((l) => l.includes('inside grace window')), 'type mismatch must not hit the grace log');
        console.log('  - fresh type-mismatch order is cancelled immediately');
    }

    // ---- 5b. Regular surplus keeps the grace (no churn on fresh placements) ----
    {
        const freshChainId = '1.7.777002';
        const { manager, logs } = createManager(
            [{ id: 'slot-81', orderId: freshChainId, type: ORDER_TYPES.BUY, price: 0.312638, size: 850, state: ORDER_STATES.ACTIVE }],
            [{
                gridOrder: { id: 'slot-81', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: freshChainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.BUY,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-surplus',
            }]
        );
        manager._placedAt = new Map([[freshChainId, Date.now()]]);
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 0, 'a regular fresh surplus must still be held by the grace');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 1, 'held entry stays queued');
        assert(logs.some((l) => l.includes('inside grace window')), 'the grace deferral must still be logged');
        console.log('  - regular fresh surplus still honours the grace window');
    }

    // ---- 5c. A fill-retagged slot does not launder the mismatch ----
    // A partial fill stores the TRADED side into the slot (size dimensions
    // stay consistent for accounting). If the level is still on the opposite
    // rail, that label must not be read as a repair: the residual order is
    // known-wrong and must be cancelled. Geometry (index vs boundary), not
    // the stored label, is the repair authority.
    {
        const chainId = '1.7.777003';
        const adoptedSlot = {
            id: 'slot-80', orderId: chainId, type: ORDER_TYPES.SELL,
            price: 0.312638, size: 595, state: ORDER_STATES.PARTIAL,
        };
        const { manager, logs } = createManager(
            [adoptedSlot],
            [{
                gridOrder: { id: 'slot-80', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: chainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 595,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        // slot-80 <= boundary 99 => BUY rail; the chain order is a SELL.
        manager.boundaryIdx = 99;
        manager._placedAt = new Map([[chainId, Date.now()]]);
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 1, 'a retagged slot on the opposite rail must still be cancelled');
        assert(!logs.some((l) => l.includes('was repaired')), 'the adopted label must not count as a repair');
        console.log('  - a fill-retagged slot on the wrong rail is still cancelled');
    }

    // ---- 5d. A genuine rail repair drops the stale cancel ----
    // The level flipped to the SELL rail and the slot already carries the
    // chain's SELL: the order is correct, only the old queue entry is stale.
    {
        const chainId = '1.7.777004';
        const repairedSlot = {
            id: 'slot-80', orderId: chainId, type: ORDER_TYPES.SELL,
            price: 0.312638, size: 850, state: ORDER_STATES.ACTIVE,
        };
        const { manager, logs } = createManager(
            [repairedSlot],
            [{
                gridOrder: { id: 'slot-80', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: chainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        // slot-80 > boundary 79 => SELL rail, matching the chain side.
        manager.boundaryIdx = 79;
        manager._placedAt = new Map([[chainId, Date.now()]]);
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 0, 'a repaired rail must not cancel the matching order');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'the stale entry is dropped');
        assert(logs.some((l) => l.includes('was repaired')), 'the drop must say the rail repaired it');
        console.log('  - a genuinely repaired rail drops the stale cancel');
    }

    // ---- 5e. An in-band level is never "repaired" by its label ----
    // A resolved SPREAD geometry contradicts a rail side: no order should
    // rest inside the gap band, so the mismatch cancel must survive even when
    // the stored type already carries the chain side.
    {
        const chainId = '1.7.777005';
        const inBandSlot = {
            id: 'slot-80', orderId: chainId, type: ORDER_TYPES.SELL,
            price: 0.312638, size: 595, state: ORDER_STATES.PARTIAL,
        };
        const { manager, logs } = createManager(
            [inBandSlot],
            [{
                gridOrder: { id: 'slot-80', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: chainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 595,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        // slot-80 sits in the 2-slot band above boundary 79 (sellStart 82).
        manager.boundaryIdx = 79;
        manager._gapSlots = 2;
        manager._placedAt = new Map([[chainId, Date.now()]]);
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 1, 'an in-band order must be cancelled even if its label matches');
        assert(!logs.some((l) => l.includes('was repaired')), 'the band is not a repair');
        console.log('  - an in-band level is not treated as repaired');
    }

    // ---- 5f. Unknown geometry falls back to the stored-type check ----
    // The fail-safe: never invent a rail. A missing boundary, a missing gap
    // width, or a non-slot id (shelf/manual order) keeps the pre-geometry
    // behaviour — the stored type decides whether the entry is stale.
    {
        const chainId = '1.7.777006';
        const { manager } = createManager(
            [{ id: 'slot-80', orderId: chainId, type: ORDER_TYPES.SELL, price: 0.312638, size: 850, state: ORDER_STATES.ACTIVE }],
            [{
                gridOrder: { id: 'slot-80', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: chainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        (manager as any).boundaryIdx = null; // unknown boundary
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 0, 'unknown boundary + matching stored type => stale entry dropped');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'the stale entry is dropped');
        console.log('  - unknown boundary falls back to the stored type');
    }

    {
        const chainId = '1.7.777007';
        const { manager } = createManager(
            [{ id: 'slot-80', orderId: chainId, type: ORDER_TYPES.BUY, price: 0.312638, size: 850, state: ORDER_STATES.ACTIVE }],
            [{
                gridOrder: { id: 'slot-80', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: chainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        (manager as any).boundaryIdx = null;
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 1, 'unknown boundary + disagreeing stored type => still cancelled');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'the cancelled entry leaves the queue');
        console.log('  - unknown boundary keeps a stored-type mismatch actionable');
    }

    {
        // Non-slot id (shelf/manual order): parseSlotIndex is null => no rail.
        const chainId = '1.7.777008';
        const { manager } = createManager(
            [{ id: 'deep-1', orderId: chainId, type: ORDER_TYPES.SELL, price: 0.312638, size: 850, state: ORDER_STATES.ACTIVE }],
            [{
                gridOrder: { id: 'deep-1', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: chainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 0, 'a non-slot id has no rail => stored-type fallback drops');
        console.log('  - non-slot ids fall back to the stored type');
    }

    {
        // Missing gap width: geometryTypeForSlotIndex fails closed on null.
        const chainId = '1.7.777009';
        const { manager } = createManager(
            [{ id: 'slot-80', orderId: chainId, type: ORDER_TYPES.SELL, price: 0.312638, size: 850, state: ORDER_STATES.ACTIVE }],
            [{
                gridOrder: { id: 'slot-80', type: ORDER_TYPES.BUY, price: 0.312638, size: 850 },
                chainOrderId: chainId,
                expectedPrice: 0.312638,
                actualPrice: 0.312638,
                size: 850,
                type: ORDER_TYPES.SELL,
                sideUpdated: ORDER_TYPES.SELL,
                typeMismatch: true,
                isSurplus: true,
                cancelOnly: false,
                queuedAt: Date.now(),
                queuedBy: 'sync-pass1-type-mismatch',
            }]
        );
        manager.boundaryIdx = 79;
        (manager as any)._gapSlots = null;
        let cancels = 0;
        const accountOrders = { cancelOrder: async () => { cancels++; return { success: true }; } };
        await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancels, 0, 'unknown gap width => stored-type fallback drops');
        console.log('  - unknown gap width falls back to the stored type');
    }

    console.log('PASS test_correction_queue_staleness');
}

run().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});

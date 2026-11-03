/**
 * tests/test_startup_dust_policy.ts
 *
 * Unit tests for _classifyStartupOrderReuse (modules/order/grid_reconcile_internal).
 *
 * Policy under test:
 *  - dust = below the per-slot single-dust threshold (5% of the mean ideal
 *    slot size by default);
 *  - when enough NON-dust orders exist to cover every needed slot, dust orders
 *    are CANCEL-only (excluded from the update pool, never re-created);
 *  - when non-dust cannot cover the target, dust stays eligible to fill the
 *    remaining slots.
 *
 * This is the centralized dust policy: startup reconcile must never price a
 * dust order into a full-size slot while enough real orders already exist.
 */

const assert = require('assert');
const { _classifyStartupOrderReuse } = require('../modules/order/grid_reconcile_internal');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const ASSETS = {
    assetA: { id: '1.3.5537', precision: 5, symbol: 'XRP' },
    assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
};

// Build a raw sell chain order whose parsed size is `size` XRP.
function sellOrder(id: string, size: number, price: number) {
    const base = Math.round(size * 1e5);
    const quote = Math.round(size * price * 1e5);
    return {
        id,
        sell_price: {
            base: { amount: String(base), asset_id: '1.3.5537' },
            quote: { amount: String(quote), asset_id: '1.3.0' },
        },
        for_sale: String(base),
    };
}

function slot(id: string, size: number, price: number) {
    return { id, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price, size };
}

async function testEnoughNonDustCancelsDust() {
    console.log('\n - enough non-dust orders: dust is cancel-only...');
    const desiredSlots = [slot('slot-0', 100, 101), slot('slot-1', 100, 102), slot('slot-2', 100, 103)];
    const sortedUnmatched = [
        sellOrder('1.7.1', 100, 101),
        sellOrder('1.7.2', 100, 102),
        sellOrder('1.7.3', 100, 103),
        sellOrder('1.7.4', 1, 104), // dust (1% of ideal)
        sellOrder('1.7.5', 2, 105), // dust
    ];
    const result = _classifyStartupOrderReuse({ sortedUnmatched, desiredSlots, assets: ASSETS });
    assert.strictEqual(result.enoughNonDust, true);
    assert.strictEqual(result.nonDustCount, 3);
    assert.strictEqual(result.dustCount, 2);
    assert.strictEqual(result.updatePool.length, 3, 'only non-dust orders are update targets');
    assert.strictEqual(result.dustSurplus.length, 2, 'both dust orders are cancel-only');
    assert.ok(result.updatePool.every((o: { id: string }) => !['1.7.4', '1.7.5'].includes(o.id)));
    console.log('  PASS');
}

async function testNotEnoughNonDustKeepsDustEligible() {
    console.log('\n - not enough non-dust: dust stays eligible for remaining slots...');
    const desiredSlots = [slot('slot-0', 100, 101), slot('slot-1', 100, 102), slot('slot-2', 100, 103)];
    const sortedUnmatched = [
        sellOrder('1.7.1', 100, 101), // only one non-dust
        sellOrder('1.7.2', 1, 104),   // dust
        sellOrder('1.7.3', 2, 105),   // dust
    ];
    const result = _classifyStartupOrderReuse({ sortedUnmatched, desiredSlots, assets: ASSETS });
    assert.strictEqual(result.enoughNonDust, false);
    assert.strictEqual(result.nonDustCount, 1);
    assert.strictEqual(result.updatePool.length, 3, 'dust remains eligible');
    assert.strictEqual(result.dustSurplus.length, 0, 'nothing is cancelled when the target is not covered');
    console.log('  PASS');
}

async function testEmptyTargetNeverClassifiesDust() {
    console.log('\n - no target slots: no dust classification...');
    const result = _classifyStartupOrderReuse({
        sortedUnmatched: [sellOrder('1.7.1', 1, 101)],
        desiredSlots: [],
        assets: ASSETS,
    });
    assert.strictEqual(result.enoughNonDust, false);
    assert.strictEqual(result.dustSurplus.length, 0);
    assert.strictEqual(result.dustThreshold, 0);
    console.log('  PASS');
}

(async () => {
    console.log('Running startup dust policy tests...');
    await testEnoughNonDustCancelsDust();
    await testNotEnoughNonDustKeepsDustEligible();
    await testEmptyTargetNeverClassifiesDust();
    console.log('\n✓ All startup dust policy tests passed');
})().catch((err) => {
    console.error('❌ Startup dust policy test failed:', err);
    process.exit(1);
});

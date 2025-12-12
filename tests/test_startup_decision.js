const assert = require('assert');

console.log('Running startup_decision tests');

const { decideStartupGridAction } = require('../modules/order/startup_reconcile');

(async () => {
    // 1) No persisted grid => regenerate
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [],
            chainOpenOrders: [],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: false };
            }
        });
        assert.strictEqual(result.shouldRegenerate, true);
        assert.strictEqual(result.hasActiveMatch, false);
        assert.strictEqual(called.resume, false, 'resume should not be attempted when no persisted grid');
    }

    // 2) Persisted ACTIVE orderId exists on-chain => resume without attempting price-match
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [{ state: 'active', orderId: '1.7.1' }],
            chainOpenOrders: [{ id: '1.7.1' }],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: true, matchedCount: 99 };
            }
        });
        assert.strictEqual(result.shouldRegenerate, false);
        assert.strictEqual(result.hasActiveMatch, true);
        assert.strictEqual(result.resumedByPrice, false);
        assert.strictEqual(called.resume, false, 'resume should not be attempted when an ACTIVE orderId matches');
    }

    // 3) No ACTIVE orderId match + chain has orders => attempt price-match and accept success
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [{ state: 'active', orderId: '1.7.x' }],
            chainOpenOrders: [{ id: '1.7.y' }],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: true, matchedCount: 2 };
            }
        });
        assert.strictEqual(called.resume, true);
        assert.strictEqual(result.shouldRegenerate, false);
        assert.strictEqual(result.hasActiveMatch, false);
        assert.strictEqual(result.resumedByPrice, true);
        assert.strictEqual(result.matchedCount, 2);
    }

    // 4) No ACTIVE orderId match + chain has orders => attempt price-match and regenerate on failure
    {
        const called = { resume: false };
        const result = await decideStartupGridAction({
            persistedGrid: [{ state: 'active', orderId: '1.7.x' }],
            chainOpenOrders: [{ id: '1.7.y' }],
            attemptResumeFn: async () => {
                called.resume = true;
                return { resumed: false, matchedCount: 0 };
            }
        });
        assert.strictEqual(called.resume, true);
        assert.strictEqual(result.shouldRegenerate, true);
        assert.strictEqual(result.hasActiveMatch, false);
        assert.strictEqual(result.resumedByPrice, false);
        assert.strictEqual(result.matchedCount, 0);
    }

    console.log('startup_decision tests passed');
})().catch((err) => {
    console.error('startup_decision tests failed');
    console.error(err);
    process.exit(1);
});

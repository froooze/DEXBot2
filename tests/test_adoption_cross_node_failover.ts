/**
 * tests/test_adoption_cross_node_failover.ts
 *
 * A by-id adoption read that misses a fresh CREATE is a lagging NODE signal,
 * not proof the order is gone. The 2026-11-18 cascade showed both bots
 * deferring after 3 reads of the same node, then duplicating levels and
 * forcing a destructive reload. This pins the bounded cross-node fallback:
 * after the normal retry budget, request failover once and retry the by-id
 * read on the replacement node before deferring.
 */

const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
esmMockEntry();

function makeSwappableModule(defaults: Record<string, any>) {
    const overrides = new Map<string, any>();
    const resolved = (key: string) => (overrides.has(key) ? overrides.get(key) : defaults[key]);
    const target: Record<string, any> = {};
    for (const key of Object.keys(defaults)) {
        target[key] = typeof defaults[key] === 'function'
            ? (...args: any[]) => resolved(key)(...args)
            : defaults[key];
    }
    return new Proxy(target, {
        set(_t: any, prop: string | symbol, value: any) {
            const key = String(prop);
            if (target[key] === value) overrides.delete(key);
            else overrides.set(key, value);
            return true;
        },
    });
}

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');
const chainOrders = makeSwappableModule({
    BroadcastUncertainError,
    selectAccount: async () => {},
    setPreferredAccount: async () => {},
    resolveAccountId: async () => null,
    resolveAccountName: async () => null,
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    readSingleOrder: async () => null,
    batchReadOrders: async () => new Map(),
    listenForFills: async () => () => {},
    updateOrder: async () => null,
    createOrder: async () => null,
    cancelOrder: async () => null,
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    buildUpdateOrderOp: async () => null,
    buildCreateOrderOp: async () => null,
    buildCancelOrderOp: async () => null,
    buildLiquidityPoolExchangeOp: async () => null,
    executeBatch: async () => ({}),
    findOverReducingUpdateOpError: async () => null,
    wasRecentlyOwnCancelled: () => false,
    recordOwnCancel: () => {},
    broadcastTxWithClassification: async () => ({}),
});
defineEsmMockAbs(require.resolve('../modules/chain_orders'), [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], chainOrders);

const { adoptPlacedBatchFromChain } = require('../modules/dexbot_cow_runtime');

const FRESH_ID = '1.7.999001';
// Inject a single read and zero backoff so the lagging-read paths run instantly.
const SEAMS = { adoptionReadMaxAttempts: 1, adoptionReadBackoffMs: 0 };

function makeBot() {
    const logs: string[] = [];
    const bot = {
        accountId: '1.2.100',
        account: 'account-name',
        manager: {
            orders: new Map(),
            logger: { log: (msg: string) => logs.push(String(msg)) },
            syncFromOpenOrders: async () => {},
        },
        _log: () => {},
        _warn: () => {},
    };
    return { bot, logs };
}

async function main() {
    {
        console.log('\n[FAILOVER-01] a lagging by-id read recovers on the replacement node');
        {
            const { bot, logs } = makeBot();
            let reads = 0;
            let failovers = 0;
            chainOrders.batchReadOrders = async () => {
                reads += 1;
                // First read (on the lagging node) misses; the post-failover read sees it.
                return reads === 1 ? new Map() : new Map([[FRESH_ID, { id: FRESH_ID }]]);
            };
            const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', {
                ...SEAMS,
                polledCreateIds: [FRESH_ID],
                nodeFailover: async () => { failovers += 1; return true; },
            });
            assert.strictEqual(adopted, true, 'adoption must succeed after the cross-node retry');
            assert.strictEqual(failovers, 1, 'failover must be requested exactly once');
            assert.strictEqual(reads, 2, 'one by-id read before and one after failover');
            assert.ok(logs.some((l) => l.includes('requesting cross-node failover')), 'failover must be logged');
            assert.ok(logs.some((l) => l.includes('recovered on the replacement node')), 'recovery must be logged');
            console.log('  ✓ cross-node retry recovers the fresh CREATE');
        }

        console.log('\n[FAILOVER-02] the failover request is bounded by a per-bot cooldown');
        {
            const { bot } = makeBot();
            let failovers = 0;
            chainOrders.batchReadOrders = async () => new Map();
            const opts = {
                ...SEAMS,
                polledCreateIds: [FRESH_ID],
                nodeFailover: async () => { failovers += 1; return true; },
            };
            assert.strictEqual(await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', opts), false);
            assert.strictEqual(await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', opts), false);
            assert.strictEqual(failovers, 1, 'a repeated lag must not reconnect again within the cooldown');

            const otherBot = makeBot();
            await adoptPlacedBatchFromChain(otherBot.bot, chainOrders, 'TEST', {
                ...SEAMS,
                polledCreateIds: [FRESH_ID],
                nodeFailover: async () => { failovers += 1; return true; },
            });
            assert.strictEqual(failovers, 2, 'the cooldown is per bot, not global');
            console.log('  ✓ failover is bounded per bot');
        }

        console.log('\n[FAILOVER-03] a failing failover still defers (fail closed)');
        {
            const { bot, logs } = makeBot();
            chainOrders.batchReadOrders = async () => new Map();
            const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', {
                ...SEAMS,
                polledCreateIds: [FRESH_ID],
                nodeFailover: async () => { throw new Error('node manager unavailable'); },
            });
            assert.strictEqual(adopted, false, 'a failed failover must not fall through to adoption');
            assert.ok(logs.some((l) => l.includes('deferring as before')), 'deferral must be logged');
            console.log('  ✓ failed failover keeps pending-broadcast protection');
        }

        console.log('\n[FAILOVER-04] a declined failover must not claim replacement-node recovery');
        {
            const { bot, logs } = makeBot();
            chainOrders.batchReadOrders = async () => new Map();
            const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', {
                ...SEAMS,
                polledCreateIds: [FRESH_ID],
                nodeFailover: async () => false, // cooldown / disabled / no alternative
            });
            assert.strictEqual(adopted, false, 'a declined failover must defer');
            assert.ok(logs.some((l) => l.includes('failover unavailable')), 'decline must be logged');
            assert.ok(!logs.some((l) => l.includes('recovered on the replacement node')),
                'must not claim a node switch that did not happen');
            console.log('  ✓ declined failover is honest and fail-closed');
        }

        console.log('\n[FAILOVER-05] a clean decline retries on the short interval');
        {
            const { bot } = makeBot();
            let reads = 0;
            let failovers = 0;
            chainOrders.batchReadOrders = async () => {
                reads += 1;
                // Two lagging pre-reads, then the post-failover read sees the id.
                return reads <= 2 ? new Map() : new Map([[FRESH_ID, { id: FRESH_ID }]]);
            };
            const opts = {
                ...SEAMS,
                failoverCooldownMs: 200,
                failoverDeclineRetryMs: 20,
                polledCreateIds: [FRESH_ID],
                nodeFailover: async () => { failovers += 1; return failovers > 1; },
            };
            assert.strictEqual(await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', opts), false);
            assert.strictEqual(failovers, 1, 'first decline must be recorded');
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.strictEqual(await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', opts), true,
                'a clean decline must not burn the full five-minute cooldown');
            assert.strictEqual(failovers, 2, 'failover must be retried on the short interval');
            console.log('  ✓ clean decline uses the short retry interval');
        }

        console.log('\n[FAILOVER-06] a read failure after a successful reconnect keeps the latch');
        {
            const { bot } = makeBot();
            let reads = 0;
            let failovers = 0;
            chainOrders.batchReadOrders = async () => {
                reads += 1;
                if (reads === 2) throw new Error('fresh connection not ready');
                return new Map();
            };
            const opts = {
                ...SEAMS,
                failoverCooldownMs: 200,
                failoverDeclineRetryMs: 20,
                polledCreateIds: [FRESH_ID],
                nodeFailover: async () => { failovers += 1; return true; },
            };
            assert.strictEqual(await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', opts), false);
            assert.strictEqual(failovers, 1, 'the successful failover must have been attempted');
            // The post-failover read threw; the success-stamped full latch must
            // survive that error so we do not reconnect again on the next tick.
            assert.strictEqual(await adoptPlacedBatchFromChain(bot, chainOrders, 'TEST', opts), false);
            assert.strictEqual(failovers, 1, 'a read error after reconnect must not clear the latch');
            console.log('  ✓ post-reconnect read failure keeps the full latch');
        }

        console.log('All cross-node adoption failover tests passed.');
    }
}

Promise.resolve()
    .then(main)
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Test failed!', err);
        process.exit(1);
    });

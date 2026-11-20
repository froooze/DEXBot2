/**
 * tests/test_reconcile_pipeline_source.ts
 *
 * B2 route (b) from docs/FILL_PIPELINE.md: the startup/targeted reconcile's
 * unsettled-fill gate used to read only manager state, so a fill accepted
 * during its chain read was invisible to the window top-up and the slot could
 * be re-created against pre-fill state. Callers that own a bot now pass it as
 * `options.pipelineSource`, and the SAME fail-closed reader sees the bot queue.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { reconcileGridOrders } = require('../modules/order/grid_reconcile');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function makeScenario() {
    const logs: Array<{ msg: string; level?: string }> = [];
    const orders = new Map();
    const manager: any = {
        orders,
        boundaryIdx: 1,
        _gapSlots: 2,
        logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        },
        accountTotals: { sellFree: 1000, buyFree: 1000 },
        strategy: { hasAnyDust: () => false, rebalance: async () => null },
        accountant: { addToChainFree: () => {} },
        getOrdersByTypeAndState: (type: string, state: string) =>
            Array.from(orders.values()).filter((o: any) => o && o.type === type && o.state === state),
        _gridLock: { acquire: async (fn: any) => await fn() },
        _fundLock: { acquire: async (fn: any) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async () => {},
        _updateOrder: (order: any) => { orders.set(order.id, order); },
        _applyOrderUpdate: async (order: any) => { orders.set(order.id, order); return true; },
        _orderIdAssignedAt: new Map(),
    };
    // One empty BUY rail slot to top up; no chain orders at all.
    orders.set('slot-0', { id: 'slot-0', price: 0.02, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', size: 100 });
    orders.set('slot-1', { id: 'slot-1', price: 0.021, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', size: 100 });
    orders.set('slot-3', { id: 'slot-3', price: 0.023, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, orderId: '', size: 100 });

    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => {},
        createOrder: async () => [],
        readOpenOrders: async () => [],
    };
    const config = { coreOrders: { buy: 1, sell: 0 }, dryRun: true };
    // Mirror production: readFillPipelineState reads the bot-level queue from
    // the source and manager-level fill state from source.manager, which must
    // be the SAME manager being reconciled (not a detached empty stub).
    const bot: any = { manager, _incomingFillQueue: [], _deferredFillsPending: false };
    return { manager, chainOrders, config, logs, bot };
}

async function reconcile(opts: { withBot?: boolean; queued?: boolean; deferred?: boolean; managerCrawl?: boolean } = {}) {
    const { manager, chainOrders, config, logs, bot } = makeScenario();
    bot._incomingFillQueue = opts.queued ? [{ id: 'fill-1' }] : [];
    bot._deferredFillsPending = opts.deferred === true;
    // Sentinel for the manager branch of the reader: with an empty bot queue,
    // a defer here proves source.manager is consulted, not just the bot fields.
    (manager as any)._pendingFillCrawls = opts.managerCrawl ? [{ slotId: 'slot-0', side: 'buy', ts: Date.now() }] : [];
    await reconcileGridOrders({
        manager,
        config,
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders: [],
        options: opts.withBot === true ? { pipelineSource: bot } : {},
    });
    return logs.filter((l) => l.msg.includes('Deferring') && l.msg.includes('window top-up create'));
}

async function main() {
    console.log('=== Reconcile pipeline-source tests ===\n');

    let defers = await reconcile();
    assert.strictEqual(defers.length, 0, 'manager-only gate must stay as before when no bot is passed');
    console.log('   ✓ RG-PIPE-1 manager-only caller unchanged');

    defers = await reconcile({ withBot: true });
    assert.strictEqual(defers.length, 0, 'an empty bot queue with a settled manager must not defer');
    defers = await reconcile({ withBot: true, managerCrawl: true });
    assert.ok(defers.length > 0, 'the reader must also see manager-level owed crawls through source.manager');
    console.log('   ✓ RG-PIPE-2 both bot and manager branches are read');

    defers = await reconcile({ withBot: true, queued: true });
    assert.ok(defers.length > 0, `a queued bot-level fill must defer the top-up (logs: ${JSON.stringify(defers)})`);
    assert.ok(defers[0].msg.includes('BUY'), 'the deferred side is named');
    console.log('   ✓ RG-PIPE-3 queued bot-level fill defers the top-up');

    defers = await reconcile({ withBot: true, deferred: true });
    assert.ok(defers.length > 0, 'the deferred-drain flag must defer the top-up too');
    console.log('   ✓ RG-PIPE-4 deferred-drain flag defers the top-up');

    // RG-PIPE-1..4 inject pipelineSource themselves; deleting the optional
    // one-liner at a production call site would keep them green. Pin the three
    // bot-owning callers directly (recalculateGrid legitimately omits it).
    const callers: Array<[string, number]> = [
        ['dexbot_startup_runtime.ts', 2],
        ['dexbot_maintenance_runtime.ts', 1],
    ];
    for (const [file, expected] of callers) {
        const text = fs.readFileSync(path.join(__dirname, '../../modules', file), 'utf8');
        const count = (text.match(/pipelineSource:\s*bot\b/g) || []).length;
        assert.ok(count >= expected, `${file} must pass pipelineSource: bot at ${expected} call site(s)`);
    }
    console.log('   ✓ RG-PIPE-5 bot-owning callers pass pipelineSource');

    console.log('\n✅ All reconcile pipeline-source tests passed');
}

if (require.main === module) {
    main().catch((err) => { console.error('RECONCILE PIPELINE-SOURCE TEST FAILURE:', err); process.exit(1); });
}

export { main };

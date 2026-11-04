/**
 * tests/test_fill_store_authority.ts
 *
 * P2 gates: the processed-fill store is the dedupe authority, and it is marked
 * at CREDIT time, not after the persist flush.
 *
 * The bug class this closes: `processFillAccounting` only wrote the tracker
 * after a successful flush. During the window between "key queued" and "flush
 * done" a second event with the same key passed the duplicate check, so the
 * only thing standing between it and a second credit was the bot-level claim
 * lease (5 s, and absent in a bare manager). The invariant tested here is
 * "credited ⇒ tracker has the key", with rollback on every failure so a
 * half-claimed key cannot block a retry.
 *
 * Also pinned: `_isNewFillKey` refuses a BOOKED key without consulting any
 * clock. The lease only covers accepted-but-unbooked fills.
 */

const assert = require('assert');
const { TIMING } = require('../modules/constants');
const Accountant = require('../modules/order/accounting').default;

let failures = 0;
function check(name: string, actual: any, expected: any) {
    try {
        assert.deepStrictEqual(actual, expected);
        console.log(`   ✓ ${name}`);
    } catch {
        failures += 1;
        console.error(`   ✗ ${name}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`);
    }
}

function makeManager() {
    return {
        assets: { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } },
        config: { assetA: 'BASE', assetB: 'QUOTE' },
        logger: { log: () => {} },
        orders: new Map(),
        accountTotals: { buy: 100000, sell: 1000, buyFree: 100000, sellFree: 1000 },
        _fundLock: { acquire: async (fn: any) => await fn() },
        processedFillTracker: new Map(),
        processedFillStore: null as any,
    };
}

function makeFill() {
    return {
        order_id: '1.7.150',
        pays: { asset_id: '1.3.0', amount: 100000 },
        receives: { asset_id: '1.3.1', amount: 250000 },
        is_maker: true,
    };
}

const FILL_KEY = '1.7.150:900:1.11.700';

async function testClaimBeforeCredit() {
    console.log('\n[1] The key is visible to the duplicate check before any balance moves');
    const mgr = makeManager();
    const accountant = new Accountant(mgr);
    let trackerHadKeyAtCredit: boolean | null = null;
    const original = accountant._applyBalanceAdjustments.bind(accountant);
    accountant._applyBalanceAdjustments = async (adjustments: any) => {
        trackerHadKeyAtCredit = mgr.processedFillTracker.has(FILL_KEY);
        return original(adjustments);
    };
    await accountant.processFillAccounting(makeFill(), FILL_KEY, {});
    check('tracker marked before credit', trackerHadKeyAtCredit, true);
    check('key still booked after success', mgr.processedFillTracker.has(FILL_KEY), true);
}

async function testSecondCreditIsRefusedInFlight() {
    console.log('\n[2] A duplicate that arrives while the first is in flight is refused');
    const mgr = makeManager();
    const accountant = new Accountant(mgr);
    let observedSecond: boolean | null = null;
    const original = accountant._applyBalanceAdjustments.bind(accountant);
    accountant._applyBalanceAdjustments = async (adjustments: any) => {
        // Re-enter with the same key from inside the credit window, exactly as a
        // second consumer would. Before the pre-credit mark this saw no key.
        const second = await accountant.processFillAccounting(makeFill(), FILL_KEY, {});
        observedSecond = second;
        return original(adjustments);
    };
    const first = await accountant.processFillAccounting(makeFill(), FILL_KEY, {});
    check('first credit applied', first, true);
    check('in-flight duplicate refused', observedSecond, false);
    // SELL: pays base (-1), receives quote (+2.5). Exactly one application.
    check('base side credited exactly once', mgr.accountTotals.sell, 999);
    check('quote side credited exactly once', mgr.accountTotals.buy, 100000 + 2.5);
}

async function testRollbackOnAdjustmentFailure() {
    console.log('\n[3] A failed credit releases the claim so the fill can be retried');
    const mgr = makeManager();
    const accountant = new Accountant(mgr);
    const original = accountant._applyBalanceAdjustments.bind(accountant);
    let threw = false;
    accountant._applyBalanceAdjustments = async (adjustments: any) => {
        if (!threw) {
            threw = true;
            throw new Error('injected adjustment failure');
        }
        return original(adjustments);
    };
    let rejected = false;
    try {
        await accountant.processFillAccounting(makeFill(), FILL_KEY, {});
    } catch {
        rejected = true;
    }
    check('failure surfaces (not silently swallowed)', rejected, true);
    check('claim released', mgr.processedFillTracker.has(FILL_KEY), false);
    const retried = await accountant.processFillAccounting(makeFill(), FILL_KEY, {});
    check('retry is accepted', retried, true);
    check('retry credits base exactly once', mgr.accountTotals.sell, 999);
    check('retry credits quote exactly once', mgr.accountTotals.buy, 100000 + 2.5);
}

async function testAtomicCredit() {
    console.log('\n[4] A mid-credit failure reverses the applied prefix (no half credit on retry)');
    const mgr = makeManager();
    const accountant = new Accountant(mgr);
    let calls = 0;
    const original = accountant.adjustTotalBalance.bind(accountant);
    accountant.adjustTotalBalance = async (orderType: any, delta: any, operation: any) => {
        calls += 1;
        if (calls === 2) throw new Error('injected second-adjustment failure');
        return original(orderType, delta, operation);
    };
    let rejected = false;
    try {
        await accountant.processFillAccounting(makeFill(), FILL_KEY, {});
    } catch {
        rejected = true;
    }
    check('failure surfaces', rejected, true);
    check('applied prefix reversed (base)', mgr.accountTotals.sell, 1000);
    check('applied prefix reversed (quote)', mgr.accountTotals.buy, 100000);
    check('claim released', mgr.processedFillTracker.has(FILL_KEY), false);
}

async function testRollbackOnPersistFailure() {
    console.log('\n[5] A failed persist flush rolls the credit AND the claim back');
    const mgr = makeManager();
    const discarded: string[] = [];
    mgr.processedFillStore = {
        tracker: mgr.processedFillTracker,
        pendingWrites: new Map(),
        persist: async (key: string, ts: number) => { mgr.processedFillTracker.set(key, ts); },
        flush: async () => { throw new Error('injected persist failure'); },
        discard: (key: string) => { discarded.push(key); },
        flushKeys: async () => {},
        configure: () => {},
        setShuttingDown: () => {},
        loadPersisted: () => 0,
        mergeTracker: () => {},
    };
    const accountant = new Accountant(mgr);
    let rejected = false;
    try {
        await accountant.processFillAccounting(makeFill(), FILL_KEY, {});
    } catch {
        rejected = true;
    }
    check('persist failure surfaces', rejected, true);
    check('claim released', mgr.processedFillTracker.has(FILL_KEY), false);
    check('pending write discarded', discarded, [FILL_KEY]);
    check('balances rolled back', mgr.accountTotals.sell, 1000);
}

function testIngestConsultsTheStore() {
    console.log('\n[6] A booked key is refused at ingest, regardless of its age');
    const DEXBot = require('../modules/dexbot_class').default;
    const bot: any = Object.create(DEXBot.prototype);
    bot._processedFillStore = { tracker: new Map() };
    bot._recentlyQueuedFills = new Map();
    bot._fillDedupeWindowMs = TIMING.FILL_DEDUPE_WINDOW_MS;
    bot.manager = { logger: { log: () => {} } };

    // Booked 10 days ago: far beyond any lease, still refused (7-day retention is
    // longer than the lease, and the check takes no clock at all).
    bot._processedFillStore.tracker.set(FILL_KEY, Date.now() - 10 * 24 * 60 * 60 * 1000);
    check('booked key refused without a claim', bot._isNewFillKey(FILL_KEY, new Set()), false);
    check('refusal does not create a claim', bot._recentlyQueuedFills.size, 0);

    // Unbooked + unclaimed: accepted and claimed.
    const otherKey = '1.7.151:901:1.11.701';
    check('unbooked key accepted', bot._isNewFillKey(otherKey, new Set()), true);
    check('accepted key is claimed', bot._recentlyQueuedFills.has(otherKey), true);

    // Fresh claim (lease held): refused.
    check('fresh claim refused', bot._isNewFillKey(otherKey, new Set()), false);

    // Expired claim and still unbooked: accepted again (the lease is the only
    // thing that expires; a booked key does not).
    bot._recentlyQueuedFills.set(otherKey, Date.now() - (bot._fillDedupeWindowMs + 1000));
    check('expired unbooked claim is retried', bot._isNewFillKey(otherKey, new Set()), true);
}

async function run() {
    console.log('Processed-fill store authority tests');
    await testClaimBeforeCredit();
    await testSecondCreditIsRefusedInFlight();
    await testRollbackOnAdjustmentFailure();
    await testAtomicCredit();
    await testRollbackOnPersistFailure();
    testIngestConsultsTheStore();
    if (failures > 0) {
        console.error(`\n❌ ${failures} store-authority assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All store-authority assertions passed');
}

run();

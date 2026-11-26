/**
 * Regression: shared-account available-funds scope in the funds-ratio trigger.
 *
 * On a shared account accountTotals.*Free is account-wide. The divergence
 * check divided that raw figure by this bot's share-scaled allocation, so a
 * 20% bot saw ratio=336% (968289 / 288086) against a 3% threshold and emitted
 * a full 20-order UPDATE batch every maintenance tick. Each batch was refused
 * at commit (sub-0.1% deltas) but still paid 20 x 0.375 BTS in update fees.
 *
 * The fix share-scales the free balance before any comparison or sizing read.
 */

const assert = require('assert');
const fundRegistry = require('../modules/fund_registry');
const { calculateAvailableFundsValue } = require('../modules/order/utils/math');
const { checkAndUpdateGridIfNeeded } = require('../modules/order/grid');
const { GRID_LIMITS } = require('../modules/constants');

const ACCOUNT_FREE = 1192413;
const VIRTUAL_BUY = 224124;
const ALLOCATED_BUY = 288086;
const EXPECTED_SHARE = 0.2;
const EXPECTED_AVAILABLE = ACCOUNT_FREE * EXPECTED_SHARE - VIRTUAL_BUY; // ~14359

function makeFunds() {
    return {
        virtual: { buy: VIRTUAL_BUY, sell: 0 },
        allocated: { buy: ALLOCATED_BUY, sell: 0 },
        total: { grid: { buy: ALLOCATED_BUY - 12, sell: 0 } },
        available: { buy: 0, sell: 0 },
        btsFeesOwed: 0,
        btsBalance: null,
    };
}

function makeTotals() {
    return { buy: 1440430, sell: 0, buyFree: ACCOUNT_FREE, sellFree: 0 };
}

async function testShareScalingInHelper() {
    console.log('\n[AVAIL-SHARE-001] available-funds helper share-scales free balances...');

    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('shared-account', 'small-bot', 'buy', '20%', 'TESTB');
    await fundRegistry.registerAllocation('shared-account', 'big-bot', 'buy', '80%', 'TESTB');

    const scaled = calculateAvailableFundsValue(
        'buy', makeTotals(), makeFunds(), 'TESTA', 'TESTB',
        null, null, null, 'shared-account', 'small-bot'
    );
    assert.ok(
        Math.abs(scaled - EXPECTED_AVAILABLE) < 1,
        `expected share-scaled ${EXPECTED_AVAILABLE.toFixed(2)}, got ${scaled.toFixed(2)}`
    );

    // Without account/bot context (single-bot deployments) behaviour is unchanged.
    const raw = calculateAvailableFundsValue(
        'buy', makeTotals(), makeFunds(), 'TESTA', 'TESTB'
    );
    assert.ok(
        Math.abs(raw - (ACCOUNT_FREE - VIRTUAL_BUY)) < 1,
        `unregistered bot should keep account-wide free, got ${raw.toFixed(2)}`
    );
    console.log('✓ AVAIL-SHARE-001 passed');
}

async function testDivergenceRatioUsesSharedFree() {
    console.log('\n[AVAIL-SHARE-002] divergence ratio uses share-scaled free...');

    const logs = [];
    const manager = {
        config: {
            assetA: 'TESTA',
            assetB: 'TESTB',
            preferredAccount: 'shared-account',
            botKey: 'small-bot',
            coreOrders: null,
            min_BTS_value: 0,
            gridLimits: { GRID_REGENERATION_PERCENTAGE: GRID_LIMITS.GRID_REGENERATION_PERCENTAGE },
        },
        accountTotals: makeTotals(),
        funds: makeFunds(),
        assets: {
            assetA: { precision: 5 },
            assetB: { precision: 5 },
        },
        orders: new Map(),
        _gridSidesUpdated: new Set(),
        logger: { log: (msg) => logs.push(String(msg)) },
        getChainFundsSnapshot() {
            return {
                chainTotalBuy: this.accountTotals.buy,
                chainTotalSell: this.accountTotals.sell,
                allocatedBuy: ALLOCATED_BUY,
                allocatedSell: 0,
            };
        },
    };

    checkAndUpdateGridIfNeeded(manager);
    const line = logs.find((l) => l.includes('[DIVERGENCE] BUY ratio check'));
    assert(line, 'BUY ratio check must be logged');

    const available = Number(/availableFunds=([\d.]+)/.exec(line)[1]);
    const ratio = Number(/ratio=([\d.]+)%/.exec(line)[1]);
    assert.ok(
        Math.abs(available - EXPECTED_AVAILABLE) < 2,
        `ratio check must use share-scaled free (${EXPECTED_AVAILABLE.toFixed(2)}), got ${available}`
    );
    assert.ok(ratio < 10, `ratio must be sane (~5%), got ${ratio}%`);
    console.log(`  availableFunds=${available.toFixed(2)}, ratio=${ratio.toFixed(2)}% (was 968289 / 336%)`);
    console.log('✓ AVAIL-SHARE-002 passed');
}

async function testEachSideUsesItsOwnShare() {
    console.log('\n[AVAIL-SHARE-003] each side scales by its own share...');

    fundRegistry.resetRegistry();
    // Buy asset is assetB (ASSETY), sell asset is assetA (ASSETX).
    await fundRegistry.registerAllocation('shared-account', 'small-bot', 'buy', '50%', 'ASSETY');
    await fundRegistry.registerAllocation('shared-account', 'big-bot', 'buy', '50%', 'ASSETY');
    await fundRegistry.registerAllocation('shared-account', 'small-bot', 'sell', '10%', 'ASSETX');
    await fundRegistry.registerAllocation('shared-account', 'big-bot', 'sell', '90%', 'ASSETX');

    const totals = { buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 };
    const funds = {
        virtual: { buy: 0, sell: 0 },
        allocated: { buy: 0, sell: 0 },
        total: { grid: { buy: 0, sell: 0 } },
        available: { buy: 0, sell: 0 },
        btsFeesOwed: 0,
        btsBalance: { free: 0 },
    };
    const coreOrders = { buy: 2, sell: 2 };
    const minBtsValue = 100; // btsDeficit = 100 (btsBalance.free = 0)

    // Correct: buy share 0.5, sell share 0.1 -> totalFree = 500 + 100 = 600.
    // A single buy share applied to both sides would give 500 + 50 = 550.
    const buy = calculateAvailableFundsValue('buy', totals, funds, 'ASSETX', 'ASSETY', coreOrders, minBtsValue, null, 'shared-account', 'small-bot');
    const expectedBuy = 500 - 100 * (500 / 600);
    assert.ok(Math.abs(buy - expectedBuy) < 2, `buy must use both shares (${expectedBuy.toFixed(2)}), got ${buy.toFixed(2)}`);

    const sell = calculateAvailableFundsValue('sell', totals, funds, 'ASSETX', 'ASSETY', coreOrders, minBtsValue, null, 'shared-account', 'small-bot');
    const expectedSell = 100 - 100 * (100 / 600);
    assert.ok(Math.abs(sell - expectedSell) < 2, `sell must use both shares (${expectedSell.toFixed(2)}), got ${sell.toFixed(2)}`);

    console.log(`  buy=${buy.toFixed(2)} (expected ${expectedBuy.toFixed(2)}), sell=${sell.toFixed(2)} (expected ${expectedSell.toFixed(2)})`);
    console.log('✓ AVAIL-SHARE-003 passed');
}

(async () => {
    await testShareScalingInHelper();
    await testDivergenceRatioUsesSharedFree();
    await testEachSideUsesItsOwnShare();
    console.log('\nAll shared available-funds ratio tests passed.');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

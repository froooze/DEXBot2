/**
 * Shared-account accounting regressions.
 *
 * IMPORTANT: DEXBOT_PROFILE_ROOT must be set before requiring any module that
 * loads config.ts (it snapshots process.env at module-load time).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-shared-acct-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_ROOT;

const assert = require('assert');
const fundRegistry = require('../modules/fund_registry');
const { PATHS } = require('../modules/paths');
const Accountant = require('../modules/order/accounting').default;
const { checkFundDrift } = require('../modules/order/utils/validate');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const REGISTRY_FILE = PATHS.PROFILES.FUND_REGISTRY_JSON;

function silentLogger(logs: Array<{ msg: string; level: string }> = []) {
    return {
        level: 'debug',
        log: (msg: string, level: string = 'info') => { logs.push({ msg: String(msg), level }); },
        warn: (msg: string) => { logs.push({ msg: String(msg), level: 'warn' }); },
        error: (msg: string) => { logs.push({ msg: String(msg), level: 'error' }); },
    };
}

function invariantManager(overrides: Record<string, any> = {}, logs: Array<{ msg: string; level: string }> = []) {
    const mgr: Record<string, any> = {
        config: {
            preferredAccount: 'shared',
            botKey: 'botA',
            assetA: 'IOB.XRP',
            assetB: 'BTS',
            gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 },
        },
        assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
        accountTotals: { buy: 1_000_000, buyFree: 950_000, sell: 100, sellFree: 90 },
        funds: { committed: { chain: { buy: 40_000, sell: 10 } } },
        _fillBatchInFlight: 0,
        _orphanFillsCreditedAt: null,
        _fundDriftLedger: null,
        logger: silentLogger(logs),
    };
    Object.assign(mgr, overrides);
    return mgr;
}

async function run() {
  try {
    // --- 1. Percentage strings (the Number('80%') -> NaN -> null bug) -------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('shared', 'botA', 'buy', '80%', 'BTS');
    // This is exactly what dexbot.ts used to pass through Number(pct).
    await fundRegistry.registerAllocation('shared', 'botB', 'buy', Number('80%') as any, 'BTS');
    assert.strictEqual(fundRegistry.getBotAllocationPct('shared', 'botA', 'buy', 'BTS'), 0.8,
        'percentage string must be parsed to a decimal');
    assert.strictEqual(fundRegistry.getBotAllocationPct('shared', 'botB', 'buy', 'BTS'), null,
        'NaN allocation must be rejected, not persisted');
    const rawRegistry = fs.readFileSync(REGISTRY_FILE, 'utf8');
    assert.ok(!rawRegistry.includes('NaN') && !/"buy":\s*null/.test(rawRegistry),
        'registry must not contain NaN/null allocations');
    console.log('✓ SHARED-001 percentage strings preserved; NaN rejected');

    // --- 2. Asset-scoped allocations (two bots, different sell assets) ------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('shared', 'botA', 'buy', '80%', 'BTS');
    await fundRegistry.registerAllocation('shared', 'botB', 'buy', '20%', 'BTS');
    await fundRegistry.registerAllocation('shared', 'botA', 'sell', '100%', 'IOB.XRP');
    await fundRegistry.registerAllocation('shared', 'botB', 'sell', '100%', 'IOB.XLM');
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('shared', 'botA', 'buy', 1000, 'BTS'), 800);
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('shared', 'botB', 'buy', 1000, 'BTS'), 200);
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('shared', 'botA', 'sell', 1000, 'IOB.XRP'), 1000,
        'sole seller of an asset must not be halved by a sibling selling a different asset');
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('shared', 'botB', 'sell', 1000, 'IOB.XLM'), 1000);
    assert.strictEqual(fundRegistry.getBotShareSync('shared', 'botA', 'buy', 'BTS'), 0.8);
    assert.strictEqual(fundRegistry.getBotShareSync('shared', 'botB', 'sell', 'IOB.XLM'), 1);
    assert.strictEqual(fundRegistry.getBotShareSync(undefined, undefined, 'buy'), 1,
        'single-bot/unregistered accounts keep share 1');
    console.log('✓ SHARED-002 asset-scoped allocations and shares');

    // --- 3. Legacy registry entries remain supported -----------------------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('legacy', 'botA', 'buy', '100%');
    await fundRegistry.registerAllocation('legacy', 'botB', 'buy', '100%');
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('legacy', 'botA', 'buy', 1000), 500);
    assert.strictEqual(fundRegistry.getBotShareSync('legacy', 'botB', 'buy'), 0.5);
    console.log('✓ SHARED-003 legacy side allocations still work');

    // --- 4. Explicit zero allocation is respected --------------------------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('zero', 'botA', 'buy', '100%', 'BTS');
    await fundRegistry.registerAllocation('zero', 'botB', 'buy', '0%', 'BTS');
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('zero', 'botB', 'buy', 1000, 'BTS'), 0,
        'explicit 0% must resolve to 0, not fall back to config');
    console.log('✓ SHARED-004 explicit zero allocation');

    // --- 5. Shutdown-safe release + stale-entry pruning --------------------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('shared', 'botA', 'buy', '80%', 'BTS');
    await fundRegistry.registerAllocation('shared', 'botB', 'buy', '20%', 'BTS');
    assert.strictEqual(await fundRegistry.releaseAllocationOnShutdown('shared', 'botA'), false,
        'shutdown must keep a sibling\'s share intact');
    assert.deepStrictEqual(fundRegistry.getRegisteredBots('shared').sort(), ['botA', 'botB']);
    await fundRegistry.releaseAllocation('shared', 'botB');
    assert.strictEqual(await fundRegistry.releaseAllocationOnShutdown('shared', 'botA'), true,
        'last bot shutdown releases the account entry');
    assert.deepStrictEqual(fundRegistry.getRegisteredBots('shared'), []);

    await fundRegistry.registerAllocation('shared', 'active', 'buy', '100%', 'BTS');
    await fundRegistry.registerAllocation('shared', 'stale', 'buy', '100%', 'BTS');
    assert.strictEqual(await fundRegistry.pruneAccount('shared', ['active']), 1);
    assert.deepStrictEqual(fundRegistry.getRegisteredBots('shared'), ['active']);
    assert.strictEqual(fundRegistry.getTotalAllocatedPct('shared', 'buy', 'BTS'), 1,
        'pruning must restore the surviving bot\'s full share');
    console.log('✓ SHARED-005 shutdown-safe release and stale pruning');

    // --- 5b. Shared detection survives an empty/corrupt registry -----------
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [
            { name: 'botA', active: true, preferredAccount: 'cfg-shared' },
            { name: 'botB', active: true, preferredAccount: 'cfg-shared' },
        ],
    }));
    fundRegistry.resetRegistry();
    assert.strictEqual(fundRegistry.isSharedAccount('cfg-shared'), true,
        'active bots.json entries must keep shared-account mode even if the registry is empty');
    console.log('✓ SHARED-005b shared-account detection falls back to bots.json');

    // --- 6. Fund invariant must not flag a sibling's committed orders ------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('shared', 'botA', 'buy', '80%', 'BTS');
    await fundRegistry.registerAllocation('shared', 'botB', 'buy', '20%', 'BTS');
    const logs: Array<{ msg: string; level: string }> = [];
    const mgr = invariantManager({}, logs);
    const accountant = new Accountant(mgr);
    accountant._attemptFundRecovery = async () => false;
    // Account-wide buy total (1,000,000) = free (950,000) + BOTH bots' orders
    // (40,000 + 10,000). botA's tracked total is free + its own 40,000.
    await accountant._verifyFundInvariants(mgr, 950_000, 90, 40_000, 10, 1_000_000, 100);
    assert.strictEqual(logs.filter((l) => l.msg.includes('Fund invariant violation')).length, 0,
        `shared-account drift must not be a violation; got: ${JSON.stringify(logs)}`);
    assert.strictEqual(mgr._fundDriftLedger, null, 'no drift ledger for structural sibling balance');
    console.log('✓ SHARED-006 shared-account invariant passes with sibling committed');

    // --- 7. Cross-bot over-allocation is still detected --------------------
    const overLogs: Array<{ msg: string; level: string }> = [];
    const overMgr = invariantManager({ funds: { committed: { chain: { buy: 950_000, sell: 10 } } } }, overLogs);
    const overAccountant = new Accountant(overMgr);
    overAccountant._attemptFundRecovery = async () => false;
    await overAccountant._verifyFundInvariants(overMgr, 950_000, 90, 950_000, 10, 1_000_000, 100);
    assert.ok(overLogs.some((l) => l.msg.includes('[SHARED ACCOUNT] BUY over-allocation')),
        'over-allocation beyond the proportional share must still be flagged');
    console.log('✓ SHARED-007 cross-bot over-allocation still detected');

    // --- 8. checkFundDrift scaling and manager wiring ----------------------
    const orders = new Map<string, any>([
        ['slot-1', { id: 'slot-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '1.7.1', size: 40_000 }],
        ['slot-2', { id: 'slot-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, orderId: '1.7.2', size: 10 }],
    ]);
    const totals: any = { buy: 1_000_000, buyFree: 950_000, sell: 100, sellFree: 90 };
    const assets: any = { assetA: { precision: 5 }, assetB: { precision: 5 } };
    const limits: any = { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 };
    const unscaled = checkFundDrift(orders, totals, assets, limits);
    assert.strictEqual(unscaled.isValid, false, 'unscaled formula must still see the sibling gap');
    const scaled = checkFundDrift(orders, totals, assets, limits, { buy: 0.8, sell: 1 });
    assert.strictEqual(scaled.isValid, true, 'share-scaled formula must pass');
    assert.strictEqual(scaled.driftBuy, 0);

    const fakeManager: any = {
        orders,
        accountTotals: totals,
        assets,
        config: { preferredAccount: 'shared', botKey: 'botA', assetA: 'IOB.XRP', assetB: 'BTS', gridLimits: limits },
    };
    const viaManager = OrderManager.prototype.checkFundDriftAfterFills.call(fakeManager);
    assert.strictEqual(viaManager.isValid, true,
        'manager must pass the registry-derived share into checkFundDrift');
    console.log('✓ SHARED-008 drift check scaled via registry and manager');

    // --- 9. Shared heal must not double-scale the free balance ------------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('shared', 'botA', 'buy', '80%', 'BTS');
    await fundRegistry.registerAllocation('shared', 'botB', 'buy', '20%', 'BTS');
    const healMgr: Record<string, any> = invariantManager({
        config: {
            preferredAccount: 'shared',
            botKey: 'botA',
            assetA: 'IOB.XRP',
            assetB: 'BTS',
            gridLimits: {
                FUND_INVARIANT_PERCENT_TOLERANCE: 0.1,
                FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true,
                FUND_INVARIANT_HEAL_ALLOW_SHARED: true,
                FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2,
            },
        },
        accountTotals: { buy: 1_000_000, buyFree: 900_000, sell: 100, sellFree: 90 },
        _fundDriftLedger: { side: 'buy', direction: 'tracked-low', count: 2, firstAt: Date.now() - 60_000, lastAt: Date.now() },
    });
    const healAccountant = new Accountant(healMgr);
    const healed = await healAccountant._tryTrustChainFreeHeal(healMgr, {
        isValid: false,
        driftBuy: 1000,
        allowedDriftBuy: 100,
        driftSell: 0,
        allowedDriftSell: 10,
    } as any);
    assert.ok(healed, 'shared heal must be eligible with allow-shared enabled');
    assert.strictEqual(healMgr.accountTotals.buyFree, 1_000_000 - 40_000 / 0.8,
        'shared heal must seed an account-scale free balance');
    const afterHealLogs: Array<{ msg: string; level: string }> = [];
    const afterHealMgr = invariantManager({
        accountTotals: { ...healMgr.accountTotals },
    }, afterHealLogs);
    const afterHealAccountant = new Accountant(afterHealMgr);
    afterHealAccountant._attemptFundRecovery = async () => false;
    await afterHealAccountant._verifyFundInvariants(
        afterHealMgr,
        afterHealMgr.accountTotals.buyFree,
        90,
        40_000,
        10,
        afterHealMgr.accountTotals.buy,
        100
    );
    assert.strictEqual(afterHealLogs.filter((l) => l.msg.includes('Fund invariant violation')).length, 0,
        `healed shared balance must pass the share-scaled invariant; got ${JSON.stringify(afterHealLogs)}`);
    console.log('✓ SHARED-009 shared heal consistent with scaled invariant');

    // --- 10. Registry loss must not turn a shared account into single-bot --
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [
            { name: 'botA', botKey: 'botA', active: true, preferredAccount: 'cfg-shared', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '80%', sell: '100%' } },
            { name: 'botB', botKey: 'botB', active: true, preferredAccount: 'cfg-shared', assetA: 'XLM', assetB: 'BTS', botFunds: { buy: '20%', sell: '100%' } },
        ],
    }));
    fundRegistry.resetRegistry(); // registry load failure / staggered PM2 start
    assert.strictEqual(fundRegistry.getBotShareSync('cfg-shared', 'botA', 'buy', 'BTS'), 0.8);
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('cfg-shared', 'botA', 'buy', 1000, 'BTS'), 800);
    const fallbackMgr = invariantManager({
        config: { preferredAccount: 'cfg-shared', botKey: 'botA', assetA: 'XRP', assetB: 'BTS', gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 } },
    });
    const fallbackLogs: Array<{ msg: string; level: string }> = [];
    fallbackMgr.logger = silentLogger(fallbackLogs);
    const fallbackAccountant = new Accountant(fallbackMgr);
    fallbackAccountant._attemptFundRecovery = async () => false;
    await fallbackAccountant._verifyFundInvariants(fallbackMgr, 950_000, 90, 40_000, 10, 1_000_000, 100);
    assert.strictEqual(fallbackLogs.filter((l) => l.msg.includes('Fund invariant violation')).length, 0,
        'bots.json fallback must keep the invariant clean when the registry is empty');
    console.log('✓ SHARED-010 shared detection fallback protects invariant and allocation');

    // --- 11. Legacy registry + assetKey production path -------------------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('legacy-asset', 'botA', 'buy', '80%');
    await fundRegistry.registerAllocation('legacy-asset', 'botB', 'buy', '20%');
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('legacy-asset', 'botA', 'buy', 1000, 'BTS'), 800,
        'legacy side entries must keep working when callers pass an asset key');
    assert.strictEqual(fundRegistry.getBotShareSync('legacy-asset', 'botB', 'buy', 'BTS'), 0.2);
    console.log('✓ SHARED-011 legacy registry works with asset keys');

    // --- 12. Pair change must clear stale asset-scoped totals --------------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('pairs', 'botA', 'sell', '100%', 'XRP');
    await fundRegistry.registerAllocation('pairs', 'botB', 'sell', '100%', 'XRP');
    assert.strictEqual(fundRegistry.getBotShareSync('pairs', 'botB', 'sell', 'XRP'), 0.5);
    await fundRegistry.registerAllocation('pairs', 'botA', 'sell', '100%', 'XLM');
    assert.strictEqual(fundRegistry.getBotShareSync('pairs', 'botB', 'sell', 'XRP'), 1,
        'old asset total must be released when a bot changes pair');
    assert.strictEqual(fundRegistry.getBotShareSync('pairs', 'botA', 'sell', 'XLM'), 1);
    console.log('✓ SHARED-012 pair change clears stale asset allocations');

    // --- 13. Drift ledger direction from actual vs expected ----------------
    const dirMgr = invariantManager({
        config: { assetA: 'XRP', assetB: 'BTS', gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 } },
        funds: { committed: { chain: { buy: 50_000, sell: 10 } } },
    });
    const dirAccountant = new Accountant(dirMgr);
    dirAccountant._attemptFundRecovery = async () => false;
    // actual 990,000 < expected 950,000 + 50,000 = 1,000,000
    await dirAccountant._verifyFundInvariants(dirMgr, 950_000, 90, 50_000, 10, 990_000, 100);
    assert.ok(dirMgr._fundDriftLedger, 'one-sided drift must seed a ledger');
    assert.strictEqual(dirMgr._fundDriftLedger.side, 'buy');
    assert.strictEqual(dirMgr._fundDriftLedger.direction, 'tracked-high',
        'direction must be computed from actual vs expected');
    console.log('✓ SHARED-013 drift ledger direction from actual vs expected');

    // --- 14. Registry 0% caps spendable funds even when config says 50% ----
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('zero-cap', 'botA', 'buy', '0%', 'BTS');
    const zeroMgr: any = {
        config: { preferredAccount: 'zero-cap', botKey: 'botA', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
        accountTotals: { buy: 1000, buyFree: 1000, sell: 100, sellFree: 100 },
        funds: { committed: { chain: { buy: 0, sell: 0 } }, available: { buy: 1000, sell: 100 } },
    };
    OrderManager.prototype.applyBotFundsAllocation.call(zeroMgr);
    assert.strictEqual(zeroMgr.funds.allocated.buy, 0);
    assert.strictEqual(zeroMgr.funds.available.buy, 0, 'registry 0% must cap available funds');
    console.log('✓ SHARED-014 registry zero allocation caps spendable funds');

    // --- 15. Solo bot keeps its configured percentage ---------------------
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [{ name: 'solo-bot', active: true, preferredAccount: 'solo', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } }],
    }));
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('solo', 'solo-bot', 'buy', '50%', 'BTS');
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('solo', 'solo-bot', 'buy', 1000, 'BTS'), 500);
    const soloMgr: any = {
        config: { preferredAccount: 'solo', botKey: 'solo-bot', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
        accountTotals: { buy: 1000, buyFree: 1000, sell: 100, sellFree: 100 },
        funds: { committed: { chain: { buy: 0, sell: 0 } }, available: { buy: 1000, sell: 100 } },
    };
    OrderManager.prototype.applyBotFundsAllocation.call(soloMgr);
    assert.strictEqual(soloMgr.funds.allocated.buy, 500, 'solo allocation must not normalize to 100%');
    fundRegistry.resetRegistry(); // config-only fallback
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('solo', 'solo-bot', 'buy', 1000, 'BTS'), 500);
    console.log('✓ SHARED-015 solo bot keeps its configured cap');

    // --- 16. Staggered registration still sees both configured bots -------
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [
            { name: 'botA', botKey: 'botA', active: true, preferredAccount: 'staggered', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
            { name: 'botB', botKey: 'botB', active: true, preferredAccount: 'staggered', assetA: 'XLM', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
        ],
    }));
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('staggered', 'botA', 'buy', '50%', 'BTS');
    assert.strictEqual(fundRegistry.getBotShareSync('staggered', 'botA', 'buy', 'BTS'), 0.5);
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('staggered', 'botA', 'buy', 1000, 'BTS'), 500);
    console.log('✓ SHARED-016 staggered registration keeps the configured share');

    // --- 17. Idle sibling must not trip the account-wide equality ---------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('shared', 'botA', 'buy', '50%', 'BTS');
    await fundRegistry.registerAllocation('shared', 'botB', 'buy', '50%', 'BTS');
    const idleLogs: Array<{ msg: string; level: string }> = [];
    const idleMgr = invariantManager({
        config: { preferredAccount: 'shared', botKey: 'botA', assetA: 'XRP', assetB: 'BTS', gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 } },
        accountTotals: { buy: 1_000_000, buyFree: 500_000, sell: 100, sellFree: 90 },
        funds: { committed: { chain: { buy: 500_000, sell: 10 } } },
    }, idleLogs);
    const idleAccountant = new Accountant(idleMgr);
    idleAccountant._attemptFundRecovery = async () => false;
    await idleAccountant._verifyFundInvariants(idleMgr, 500_000, 90, 500_000, 10, 1_000_000, 100);
    assert.strictEqual(idleLogs.filter((l) => l.msg.includes('Fund invariant violation')).length, 0,
        'an idle sibling must not create false drift on shared accounts');
    console.log('✓ SHARED-017 idle sibling does not trigger invariant');

    // --- 18. Prune after an account stops being shared --------------------
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('once-shared', 'stale-bot', 'buy', '50%', 'BTS');
    await fundRegistry.registerAllocation('once-shared', 'active-bot', 'buy', '50%', 'BTS');
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [{ name: 'active-bot', active: true, preferredAccount: 'once-shared', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '100%', sell: '100%' } }],
    }));
    assert.strictEqual(await fundRegistry.pruneAccount('once-shared', ['active-bot']), 1);
    assert.deepStrictEqual(fundRegistry.getRegisteredBots('once-shared'), ['active-bot']);
    assert.strictEqual(fundRegistry.getBotShareSync('once-shared', 'active-bot', 'buy', 'BTS'), 1);
    console.log('✓ SHARED-018 stale sibling pruned when sharing ends');

    // --- 19. Credit-only bots do not dilute trade-side shares -------------
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [
            { name: 'grid', botKey: 'grid', active: true, preferredAccount: 'mixed', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
            { name: 'credit', botKey: 'credit', active: true, creditOnly: true, preferredAccount: 'mixed', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '100%', sell: '100%' } },
        ],
    }));
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('mixed', 'grid', 'buy', '50%', 'BTS');
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('mixed', 'grid', 'buy', 1000, 'BTS'), 500);
    // Register the credit bot's collateral: the account now has two registry
    // entries, but the grid bot's side budget must not flip to 100%.
    await fundRegistry.registerCollateralAllocation('mixed', 'credit', '1.3.1', '100%');
    assert.deepStrictEqual(fundRegistry.getRegisteredBots('mixed').sort(), ['credit', 'grid']);
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('mixed', 'grid', 'buy', 1000, 'BTS'), 500,
        'a collateral-only sibling must not change a grid bot allocation');
    await fundRegistry.registerAllocation('mixed', 'grid2', 'buy', '50%', 'BTS');
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [
            { name: 'grid', botKey: 'grid', active: true, preferredAccount: 'mixed', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
            { name: 'grid2', botKey: 'grid2', active: true, preferredAccount: 'mixed', assetA: 'XLM', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
            { name: 'credit', botKey: 'credit', active: true, creditOnly: true, preferredAccount: 'mixed', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '100%', sell: '100%' } },
        ],
    }));
    assert.strictEqual(fundRegistry.getBotShareSync('mixed', 'grid', 'buy', 'BTS'), 0.5,
        'two grid bots split; the credit-only bot is excluded');
    console.log('✓ SHARED-019 credit-only bots excluded from side shares');

    // --- 20. Upgrade: stale credit side entries are stripped --------------
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [
            { name: 'grid', botKey: 'grid', active: true, preferredAccount: 'upgrade', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '50%', sell: '100%' } },
            { name: 'credit', botKey: 'credit', active: true, creditOnly: true, preferredAccount: 'upgrade', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '100%', sell: '100%' } },
        ],
    }));
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('upgrade', 'grid', 'buy', '50%', 'BTS');
    // Account-level sharing is determined by config, not by collateral timing.
    assert.strictEqual(fundRegistry.isSharedAccount('upgrade'), true);
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('upgrade', 'grid', 'buy', 1000, 'BTS'), 500);

    await fundRegistry.registerAllocation('upgrade', 'credit', 'buy', '100%', 'BTS'); // old launcher
    await fundRegistry.registerCollateralAllocation('upgrade', 'credit', '1.3.1', '100%');
    assert.strictEqual(fundRegistry.isSharedAccount('upgrade'), true);
    assert.ok(Math.abs(fundRegistry.getEffectiveAllocationSync('upgrade', 'grid', 'buy', 1000, 'BTS') - 1000 / 3) < 1e-9,
        'stale credit side dilutes the grid share until cleaned');
    await fundRegistry.clearSideAllocations('upgrade', 'credit');
    assert.strictEqual(fundRegistry.getBotAllocationPct('upgrade', 'credit', 'buy', 'BTS'), null);
    assert.strictEqual(fundRegistry.getEffectiveAllocationSync('upgrade', 'grid', 'buy', 1000, 'BTS'), 500);
    assert.strictEqual(fundRegistry.getEffectiveCollateralAllocationSync('upgrade', 'credit', '1.3.1', 1000), 1000,
        'clearing sides must keep collateral');
    console.log('✓ SHARED-020 upgrade strips stale credit side allocations');

    // --- 21. Subset launches cannot prune live siblings --------------------
    fs.writeFileSync(PATHS.PROFILES.BOTS_JSON, JSON.stringify({
        bots: [
            { name: 'grid', botKey: 'grid', active: true, preferredAccount: 'subset', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '100%', sell: '100%' } },
            { name: 'credit', botKey: 'credit', active: true, creditOnly: true, preferredAccount: 'subset', assetA: 'XRP', assetB: 'BTS', botFunds: { buy: '100%', sell: '100%' } },
        ],
    }));
    fundRegistry.resetRegistry();
    await fundRegistry.registerAllocation('subset', 'grid', 'buy', '100%', 'BTS');
    await fundRegistry.registerCollateralAllocation('subset', 'credit', '1.3.1', '100%');
    await fundRegistry.registerAllocation('subset', 'gone', 'buy', '100%', 'BTS'); // removed from profile
    assert.strictEqual(await fundRegistry.pruneAccount('subset', ['grid']), 1,
        'only the bot absent from the profile may be pruned');
    assert.deepStrictEqual(fundRegistry.getRegisteredBots('subset').sort(), ['credit', 'grid']);
    assert.strictEqual(fundRegistry.getEffectiveCollateralAllocationSync('subset', 'credit', '1.3.1', 1000), 1000,
        'a live credit sibling keeps its collateral budget');
    console.log('✓ SHARED-021 subset launch keeps live siblings');

    console.log('\nAll shared-account accounting regression tests passed');
  } finally {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

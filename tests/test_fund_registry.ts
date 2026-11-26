'use strict';

const assert = require('assert');
const path = require('path');

console.log('Running fund registry tests');

// Compiled ESM: require the built module (require(esm)); the ESM instance
// cache is per-process, so a fresh run always gets a fresh registry.
const fundRegistryPath = path.resolve(__dirname, '../modules/fund_registry.js');
const fundRegistry = require(fundRegistryPath);

// Helper: in-memory test helper to avoid file-system cross-contamination
// We use resetRegistry() before each test to clear the persisted + in-memory state.
// Since the registry caches in-process, all tests in this file share the module
// instance but we isolate via resetRegistry().

function assertApproxEqual(actual, expected, message = '') {
    const tolerance = 0.001;
    if (Math.abs(actual - expected) > tolerance) {
        assert.fail(`${message}: Expected ${expected}, got ${actual}`);
    }
}

(async () => {
    // =========================================================
    // Test 1: Fresh registry is empty
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const bots = fundRegistry.getRegisteredBots('test-acct');
        assert.strictEqual(bots.length, 0, 'fresh registry should have no bots');
        const shared = fundRegistry.isSharedAccount('test-acct');
        assert.strictEqual(shared, false, 'empty account is not shared');
        const totalBuy = fundRegistry.getTotalAllocatedPct('test-acct', 'buy');
        assert.strictEqual(totalBuy, 0, 'total buy pct should be 0');
        const totalSell = fundRegistry.getTotalAllocatedPct('test-acct', 'sell');
        assert.strictEqual(totalSell, 0, 'total sell pct should be 0');
    }
    console.log('  PASS test 1: fresh registry');

    // =========================================================
    // Test 2: Register a single grid bot (buy only)
    // =========================================================
    fundRegistry.resetRegistry();
    {
        await fundRegistry.registerAllocation('acct-1', 'bot-alpha', 'buy', '100%');
        const totalBuy = fundRegistry.getTotalAllocatedPct('acct-1', 'buy');
        assert.strictEqual(totalBuy, 1.0, 'single bot 100% buy = 1.0 decimal');
        const botPct = fundRegistry.getBotAllocationPct('acct-1', 'bot-alpha', 'buy');
        assert.strictEqual(botPct, 1.0, 'bot buy pct should be 1.0');
        const bots = fundRegistry.getRegisteredBots('acct-1');
        assert.deepStrictEqual(bots, ['bot-alpha']);
        const shared = fundRegistry.isSharedAccount('acct-1');
        assert.strictEqual(shared, false, 'single bot is not shared');
    }
    console.log('  PASS test 2: single grid bot');

    // =========================================================
    // Test 3: Two grid bots sharing an account get proportional split
    // =========================================================
    fundRegistry.resetRegistry();
    {
        await fundRegistry.registerAllocation('acct-2', 'bot-a', 'buy', '100%');
        await fundRegistry.registerAllocation('acct-2', 'bot-b', 'buy', '100%');
        const shared = fundRegistry.isSharedAccount('acct-2');
        assert.strictEqual(shared, true, 'two bots should be shared');
        const totalBuy = fundRegistry.getTotalAllocatedPct('acct-2', 'buy');
        assert.strictEqual(totalBuy, 2.0, 'two 100% bots = 2.0 total');

        const allocA = fundRegistry.getEffectiveAllocationSync('acct-2', 'bot-a', 'buy', 1000);
        const allocB = fundRegistry.getEffectiveAllocationSync('acct-2', 'bot-b', 'buy', 1000);
        assert.strictEqual(allocA, 500, 'bot-a gets 500 of 1000 (50%)');
        assert.strictEqual(allocB, 500, 'bot-b gets 500 of 1000 (50%)');

        // Non-registered bot gets null
        const allocC = fundRegistry.getEffectiveAllocationSync('acct-2', 'bot-c', 'buy', 1000);
        assert.strictEqual(allocC, null, 'unregistered bot returns null');
    }
    console.log('  PASS test 3: two grid bots proportional split');

    // =========================================================
    // Test 4: Three grid bots with different percentages
    // =========================================================
    fundRegistry.resetRegistry();
    {
        await fundRegistry.registerAllocation('acct-3', 'bot-a', 'sell', '100%');
        await fundRegistry.registerAllocation('acct-3', 'bot-b', 'sell', '50%');
        await fundRegistry.registerAllocation('acct-3', 'bot-c', 'sell', '50%');
        const totalSell = fundRegistry.getTotalAllocatedPct('acct-3', 'sell');
        assert.strictEqual(totalSell, 2.0, '100+50+50 = 2.0 total');

        const allocA = fundRegistry.getEffectiveAllocationSync('acct-3', 'bot-a', 'sell', 1000);
        const allocB = fundRegistry.getEffectiveAllocationSync('acct-3', 'bot-b', 'sell', 1000);
        const allocC = fundRegistry.getEffectiveAllocationSync('acct-3', 'bot-c', 'sell', 1000);
        assert.strictEqual(allocA, 500, 'bot-a gets 500 (50%)');
        assert.strictEqual(allocB, 250, 'bot-b gets 250 (25%)');
        assert.strictEqual(allocC, 250, 'bot-c gets 250 (25%)');
    }
    console.log('  PASS test 4: three grid bots varied percentages');

    // =========================================================
    // Test 5: Re-registration updates percentage correctly
    // =========================================================
    fundRegistry.resetRegistry();
    {
        await fundRegistry.registerAllocation('acct-4', 'bot-x', 'buy', '100%');
        let total = fundRegistry.getTotalAllocatedPct('acct-4', 'buy');
        assert.strictEqual(total, 1.0, 'initial total = 1.0');

        // Re-register with 50%
        await fundRegistry.registerAllocation('acct-4', 'bot-x', 'buy', '50%');
        total = fundRegistry.getTotalAllocatedPct('acct-4', 'buy');
        assert.strictEqual(total, 0.5, 'after re-registration total = 0.5');

        const alloc = fundRegistry.getEffectiveAllocationSync('acct-4', 'bot-x', 'buy', 1000);
        assert.strictEqual(alloc, 500, 'a solo bot keeps its configured percentage');
    }
    console.log('  PASS test 5: re-registration updates percentage');

    // =========================================================
    // Test 6: Credit bot collateral registration
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        await fundRegistry.registerCollateralAllocation('acct-5', 'credit-bot-1', btsAssetId, '100%');

        // Check total collateral pct for BTS
        const totalPct = fundRegistry.getTotalAllocatedPct('acct-5', 'buy');
        assert.strictEqual(totalPct, 0, 'grid totals unaffected by collateral registration');

        // Check effective collateral allocation
        const effective = fundRegistry.getEffectiveCollateralAllocationSync('acct-5', 'credit-bot-1', btsAssetId, 2000);
        assert.strictEqual(effective, 2000, 'single credit bot gets 100% of chain total');

        // Unregistered asset returns null
        const usdAssetId = '1.3.1';
        const effectiveUsd = fundRegistry.getEffectiveCollateralAllocationSync('acct-5', 'credit-bot-1', usdAssetId, 1000);
        assert.strictEqual(effectiveUsd, null, 'unregistered collateral asset returns null');
    }
    console.log('  PASS test 6: credit bot collateral registration');

    // =========================================================
    // Test 7: Two credit bots sharing collateral get proportional split
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        await fundRegistry.registerCollateralAllocation('acct-6', 'credit-a', btsAssetId, '100%');
        await fundRegistry.registerCollateralAllocation('acct-6', 'credit-b', btsAssetId, '100%');

        const allocA = fundRegistry.getEffectiveCollateralAllocationSync('acct-6', 'credit-a', btsAssetId, 1000);
        const allocB = fundRegistry.getEffectiveCollateralAllocationSync('acct-6', 'credit-b', btsAssetId, 1000);
        assert.strictEqual(allocA, 500, 'credit-a gets 500 (50%)');
        assert.strictEqual(allocB, 500, 'credit-b gets 500 (50%)');

        // Different collateral asset doesn't interfere
        const usdAssetId = '1.3.1';
        const allocUsdA = fundRegistry.getEffectiveCollateralAllocationSync('acct-6', 'credit-a', usdAssetId, 1000);
        assert.strictEqual(allocUsdA, null, 'different collateral asset returns null for unregistered');
    }
    console.log('  PASS test 7: two credit bots proportional collateral split');

    // =========================================================
    // Test 8: Three credit bots with varied percentages
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        await fundRegistry.registerCollateralAllocation('acct-7', 'credit-a', btsAssetId, '100%');
        await fundRegistry.registerCollateralAllocation('acct-7', 'credit-b', btsAssetId, '50%');
        await fundRegistry.registerCollateralAllocation('acct-7', 'credit-c', btsAssetId, '50%');

        const allocA = fundRegistry.getEffectiveCollateralAllocationSync('acct-7', 'credit-a', btsAssetId, 1000);
        const allocB = fundRegistry.getEffectiveCollateralAllocationSync('acct-7', 'credit-b', btsAssetId, 1000);
        const allocC = fundRegistry.getEffectiveCollateralAllocationSync('acct-7', 'credit-c', btsAssetId, 1000);
        assert.strictEqual(allocA, 500, 'credit-a gets 500 (50%)');
        assert.strictEqual(allocB, 250, 'credit-b gets 250 (25%)');
        assert.strictEqual(allocC, 250, 'credit-c gets 250 (25%)');
    }
    console.log('  PASS test 8: three credit bots varied percentages');

    // =========================================================
    // Test 9: Credit bot with multiple collateral assets (no interference)
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        const usdAssetId = '1.3.1';
        await fundRegistry.registerCollateralAllocation('acct-8', 'credit-x', btsAssetId, '100%');
        await fundRegistry.registerCollateralAllocation('acct-8', 'credit-y', btsAssetId, '100%');
        await fundRegistry.registerCollateralAllocation('acct-8', 'credit-x', usdAssetId, '100%');
        await fundRegistry.registerCollateralAllocation('acct-8', 'credit-y', usdAssetId, '50%');

        // BTS split: 50/50
        const btsX = fundRegistry.getEffectiveCollateralAllocationSync('acct-8', 'credit-x', btsAssetId, 1000);
        const btsY = fundRegistry.getEffectiveCollateralAllocationSync('acct-8', 'credit-y', btsAssetId, 1000);
        assert.strictEqual(btsX, 500, 'BTS credit-x gets 500 (50%)');
        assert.strictEqual(btsY, 500, 'BTS credit-y gets 500 (50%)');

        // USD split: 66.6/33.3
        const usdX = fundRegistry.getEffectiveCollateralAllocationSync('acct-8', 'credit-x', usdAssetId, 900);
        const usdY = fundRegistry.getEffectiveCollateralAllocationSync('acct-8', 'credit-y', usdAssetId, 900);
        assertApproxEqual(usdX, 600, 'USD credit-x gets 600 (66.67%)');
        assertApproxEqual(usdY, 300, 'USD credit-y gets 300 (33.33%)');
    }
    console.log('  PASS test 9: multiple collateral assets per bot');

    // =========================================================
    // Test 10: Release allocation cleans up collateral entries
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        await fundRegistry.registerCollateralAllocation('acct-9', 'credit-z', btsAssetId, '100%');
        await fundRegistry.registerAllocation('acct-9', 'grid-z', 'sell', '50%');

        let bots = fundRegistry.getRegisteredBots('acct-9');
        assert.strictEqual(bots.length, 2, 'two bots registered');

        // Release credit bot
        await fundRegistry.releaseAllocation('acct-9', 'credit-z');
        bots = fundRegistry.getRegisteredBots('acct-9');
        assert.deepStrictEqual(bots, ['grid-z'], 'grid bot remains after credit release');

        const collEff = fundRegistry.getEffectiveCollateralAllocationSync('acct-9', 'credit-z', btsAssetId, 1000);
        assert.strictEqual(collEff, null, 'released credit bot returns null');

        // Release grid bot
        await fundRegistry.releaseAllocation('acct-9', 'grid-z');
        bots = fundRegistry.getRegisteredBots('acct-9');
        assert.strictEqual(bots.length, 0, 'no bots remain after full release');
    }
    console.log('  PASS test 10: release allocation cleans collateral');

    // =========================================================
    // Test 11: Grid + credit on same account (no interference)
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        // Grid bot registers buy/sell
        await fundRegistry.registerAllocation('acct-10', 'grid-bot', 'buy', '100%');
        await fundRegistry.registerAllocation('acct-10', 'grid-bot', 'sell', '50%');
        // Credit bot registers collateral
        await fundRegistry.registerCollateralAllocation('acct-10', 'credit-bot', btsAssetId, '100%');

        // Grid totals unaffected by credit
        const gridBuy = fundRegistry.getEffectiveAllocationSync('acct-10', 'grid-bot', 'buy', 1000);
        assert.strictEqual(gridBuy, 1000, 'grid buy unaffected by credit registration');
        const gridSell = fundRegistry.getEffectiveAllocationSync('acct-10', 'grid-bot', 'sell', 1000);
        assert.strictEqual(gridSell, 500, 'grid sell keeps its configured 50% despite credit registration');

        // Collateral totals unaffected by grid
        const collEff = fundRegistry.getEffectiveCollateralAllocationSync('acct-10', 'credit-bot', btsAssetId, 2000);
        assert.strictEqual(collEff, 2000, 'credit collateral unaffected by grid registration');

        // Total pcts are separate
        const totalBuy = fundRegistry.getTotalAllocatedPct('acct-10', 'buy');
        assert.strictEqual(totalBuy, 1.0, 'buy total is from grid only');
        const totalSell = fundRegistry.getTotalAllocatedPct('acct-10', 'sell');
        assert.strictEqual(totalSell, 0.5, 'sell total is from grid only');
    }
    console.log('  PASS test 11: grid + credit no interference');

    // =========================================================
    // Test 12: Number and string percentage inputs work
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        await fundRegistry.registerCollateralAllocation('acct-11', 'bot-num', btsAssetId, 0.75);
        await fundRegistry.registerCollateralAllocation('acct-11', 'bot-pct', btsAssetId, '75%');
        await fundRegistry.registerCollateralAllocation('acct-11', 'bot-str', btsAssetId, '0.75');

        const effNum = fundRegistry.getEffectiveCollateralAllocationSync('acct-11', 'bot-num', btsAssetId, 1000);
        const effPct = fundRegistry.getEffectiveCollateralAllocationSync('acct-11', 'bot-pct', btsAssetId, 1000);
        const effStr = fundRegistry.getEffectiveCollateralAllocationSync('acct-11', 'bot-str', btsAssetId, 1000);
        assertApproxEqual(effNum, 333.333, 'number 0.75 gives 1/3 of total');
        assertApproxEqual(effPct, 333.333, 'string 75% gives 1/3 of total');
        assertApproxEqual(effStr, 333.333, 'string 0.75 gives 1/3 of total');
    }
    console.log('  PASS test 12: number and string percentage inputs');

    // =========================================================
    // Test 13: Backward compatibility — existing grid registry unaffected
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        // Simulate old-style registry: just grid bots, no collateral entries
        await fundRegistry.registerAllocation('legacy-acct', 'bot1', 'buy', '100%');
        await fundRegistry.registerAllocation('legacy-acct', 'bot2', 'sell', '50%');

        // Grid still works
        const eff = fundRegistry.getEffectiveAllocationSync('legacy-acct', 'bot1', 'buy', 500);
        assert.strictEqual(eff, 500, 'legacy bot1 gets full buy');

        // Collateral queries on legacy account return null (not crash)
        const collEff = fundRegistry.getEffectiveCollateralAllocationSync('legacy-acct', 'bot1', btsAssetId, 1000);
        assert.strictEqual(collEff, null, 'legacy account returns null for collateral query');

        // Old-style account entry doesn't have totalAllocatedCollateralPct — ensure it works
        // (this was the migration concern)
        const bots = fundRegistry.getRegisteredBots('legacy-acct');
        assert.deepStrictEqual(bots, ['bot1', 'bot2'], 'legacy bots still listed');
    }
    console.log('  PASS test 13: backward compatibility');

    // =========================================================
    // Test 14: isSharedAccount considers collateral bots
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        let shared = fundRegistry.isSharedAccount('coll-ab');
        assert.strictEqual(shared, false, 'empty is not shared');

        await fundRegistry.registerCollateralAllocation('coll-ab', 'credit-a', btsAssetId, '100%');
        shared = fundRegistry.isSharedAccount('coll-ab');
        assert.strictEqual(shared, false, 'one credit bot is not shared');

        await fundRegistry.registerCollateralAllocation('coll-ab', 'credit-b', btsAssetId, '100%');
        shared = fundRegistry.isSharedAccount('coll-ab');
        assert.strictEqual(shared, true, 'two credit bots is shared');
    }
    console.log('  PASS test 14: isSharedAccount with collateral bots');

    // =========================================================
    // Test 15: botKey-style identifiers work (with stable id suffix)
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        const botKey = 'credit-bts-usdt-a1b2c3d4';
        await fundRegistry.registerCollateralAllocation('acct-15', botKey, btsAssetId, '100%');
        await fundRegistry.registerCollateralAllocation('acct-15', 'credit-xrp-usdt-e5f6g7h8', btsAssetId, '100%');

        const alloc = fundRegistry.getEffectiveCollateralAllocationSync('acct-15', botKey, btsAssetId, 800);
        assert.strictEqual(alloc, 400, 'botKey-style id works with proportional split');

        // Name-only (no id suffix) still works too
        await fundRegistry.registerCollateralAllocation('acct-15', 'simple-bot', btsAssetId, '100%');
        const allocSimple = fundRegistry.getEffectiveCollateralAllocationSync('acct-15', 'simple-bot', btsAssetId, 900);
        assertApproxEqual(allocSimple, 300, 'simple name key works alongside botKey-style keys');
    }
    console.log('  PASS test 15: botKey-style identifiers');

    // =========================================================
    // Test 16: Name and botKey are NOT interchangeable (mismatch returns null)
    // Documents invariant: registry key must match exactly.
    // =========================================================
    fundRegistry.resetRegistry();
    {
        const btsAssetId = '1.3.0';
        // Register under botKey (as dexbot.ts Phase 5 does)
        await fundRegistry.registerCollateralAllocation('acct-16a', 'credit-bts-usdt-a1b2c3d4', btsAssetId, '100%');
        // Lookup under name (as credit_runtime would if using name instead of botKey)
        const allocWrong = fundRegistry.getEffectiveCollateralAllocationSync('acct-16a', 'credit-bts-usdt', btsAssetId, 500);
        assert.strictEqual(allocWrong, null, 'lookup by name returns null when registered by botKey');

        // Name-only input at registration time works — isolated account, single bot
        await fundRegistry.registerCollateralAllocation('acct-16b', 'simple-name', btsAssetId, '100%');
        const allocRight = fundRegistry.getEffectiveCollateralAllocationSync('acct-16b', 'simple-name', btsAssetId, 500);
        assert.strictEqual(allocRight, 500, 'lookup matches when same key is used on single-bot account');
    }
    console.log('  PASS test 16: name vs botKey mismatch returns null');

    console.log('All fund registry tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});

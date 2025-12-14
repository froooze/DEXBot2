const assert = require('assert');
const { AccountOrders } = require('../modules/account_orders');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Test that pendingProceeds are properly persisted and restored
 * This ensures funds from partial fills are not lost on bot restart
 */

async function testPendingProceedsPersistence() {
    // Use temp directory for test
    const tmpDir = path.join(os.tmpdir(), 'dexbot-test-pending-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        // Create AccountOrders instance with test directory
        const accountDb = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });

        const botKey = 'test-bot-pending';
        const testBotConfig = { name: 'test-bot', assetA: 'BTS', assetB: 'USD', active: true, botKey };
        
        // Ensure bot entry exists
        accountDb.ensureBotEntries([testBotConfig]);

        const testPendingProceeds = { buy: 123.45678901, sell: 234.56789012 };

        console.log('Test 1: Save and load pendingProceeds');
        accountDb.updatePendingProceeds(botKey, testPendingProceeds);
        
        // Create new instance to simulate restart
        const accountDb2 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loaded = accountDb2.loadPendingProceeds(botKey);
        
        assert.strictEqual(loaded.buy, testPendingProceeds.buy, 'Buy pending proceeds not persisted correctly');
        assert.strictEqual(loaded.sell, testPendingProceeds.sell, 'Sell pending proceeds not persisted correctly');
        console.log('✓ pendingProceeds persisted and restored correctly');

        console.log('\nTest 2: Clear pendingProceeds on rotation completion');
        const clearedProceeds = { buy: 0, sell: 0 };
        accountDb2.updatePendingProceeds(botKey, clearedProceeds);
        
        const accountDb3 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loadedCleared = accountDb3.loadPendingProceeds(botKey);
        
        assert.strictEqual(loadedCleared.buy, 0, 'Cleared buy pending proceeds not persisted');
        assert.strictEqual(loadedCleared.sell, 0, 'Cleared sell pending proceeds not persisted');
        console.log('✓ Cleared pendingProceeds state persisted correctly');

        console.log('\nTest 3: Partial proceeds (only one side cleared)');
        const partialProceeds = { buy: 100.5, sell: 0 };
        accountDb3.updatePendingProceeds(botKey, partialProceeds);
        
        const accountDb4 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loadedPartial = accountDb4.loadPendingProceeds(botKey);
        
        assert.strictEqual(loadedPartial.buy, 100.5, 'Partial buy proceeds not restored');
        assert.strictEqual(loadedPartial.sell, 0, 'Sell proceeds should be cleared');
        console.log('✓ Partial pendingProceeds state persisted correctly');

        console.log('\nTest 4: Default return on missing botKey');
        const accountDb5 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const defaultProceeds = accountDb5.loadPendingProceeds('nonexistent-bot');
        
        assert.deepStrictEqual(defaultProceeds, { buy: 0, sell: 0 }, 'Should return default {buy:0, sell:0} for nonexistent bot');
        console.log('✓ Default pendingProceeds returned for nonexistent bot');

        console.log('\nTest 5: Accumulation of proceeds (multiple partial fills)');
        accountDb5.updatePendingProceeds(botKey, { buy: 50, sell: 0 });
        
        // Simulate another partial fill
        const current = accountDb5.loadPendingProceeds(botKey);
        const accumulated = { 
            buy: current.buy + 25.5, 
            sell: current.sell 
        };
        accountDb5.updatePendingProceeds(botKey, accumulated);
        
        const accountDb6 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loadedAccumulated = accountDb6.loadPendingProceeds(botKey);
        
        assert.strictEqual(loadedAccumulated.buy, 75.5, 'Accumulated proceeds not correct');
        console.log('✓ Accumulated pendingProceeds persisted correctly');

        console.log('\n✅ All pendingProceeds persistence tests passed!');

    } finally {
        // Cleanup
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}

// Run test
testPendingProceedsPersistence().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});

#!/usr/bin/env node

/**
 * Test: Verify pendingProceeds are persisted to orders.json
 */

const path = require('path');
const { AccountOrders, createBotKey } = require('../modules/account_orders');

async function testPendingProceedsPersistenceToFile() {
    console.log('\n=== Test: PendingProceeds Persistence to File ===\n');

    const config = {
        name: 'test-bot-persistence',
        assetA: 'BTS',
        assetB: 'USD',
        botKey: createBotKey({ name: 'test-bot-persistence' }, 0),
    };

    const accountOrders = new AccountOrders();

    // Test 1: storeMasterGrid with pendingProceeds
    console.log('Test 1: Store grid with pendingProceeds');
    const orders = [
        { id: 'sell-1', type: 'sell', price: 1.5, size: 10, state: 'ACTIVE' },
        { id: 'buy-1', type: 'buy', price: 0.9, size: 10, state: 'ACTIVE' }
    ];
    
    const cacheFunds = { buy: 500, sell: 500 };
    const pendingProceeds = { buy: 199.85817653, sell: 0.00000000 };

    accountOrders.storeMasterGrid(config.botKey, orders, cacheFunds, pendingProceeds);
    
    // Verify it was stored in memory
    const savedBot = accountOrders.data.bots[config.botKey];
    if (savedBot && savedBot.pendingProceeds) {
        console.log(`✓ pendingProceeds stored in memory: Buy ${savedBot.pendingProceeds.buy.toFixed(8)}, Sell ${savedBot.pendingProceeds.sell.toFixed(8)}`);
    } else {
        console.log('✗ pendingProceeds NOT stored in memory');
    }

    // Test 2: Load from disk (fresh instance)
    console.log('\nTest 2: Load from fresh instance (from disk)');
    const accountOrders2 = new AccountOrders();
    const loadedProceeds = accountOrders2.loadPendingProceeds(config.botKey);
    
    if (loadedProceeds && loadedProceeds.buy > 0) {
        console.log(`✓ pendingProceeds loaded from disk: Buy ${loadedProceeds.buy.toFixed(8)}, Sell ${loadedProceeds.sell.toFixed(8)}`);
    } else {
        console.log(`✗ pendingProceeds NOT loaded from disk. Got: Buy ${loadedProceeds.buy}, Sell ${loadedProceeds.sell}`);
    }

    // Test 3: Verify loadBotGrid also returns grid
    console.log('\nTest 3: Verify grid is also saved and loaded');
    const loadedGrid = accountOrders2.loadBotGrid(config.botKey);
    if (loadedGrid && loadedGrid.length > 0) {
        console.log(`✓ Grid loaded from disk: ${loadedGrid.length} orders`);
    } else {
        console.log('✗ Grid NOT loaded from disk');
    }

    // Test 4: Update pendingProceeds separately
    console.log('\nTest 4: Update pendingProceeds after initial storage');
    const newProceeds = { buy: 250.12345678, sell: 50.87654321 };
    accountOrders.updatePendingProceeds(config.botKey, newProceeds);
    
    const accountOrders3 = new AccountOrders();
    const updatedProceeds = accountOrders3.loadPendingProceeds(config.botKey);
    
    if (updatedProceeds.buy === newProceeds.buy && updatedProceeds.sell === newProceeds.sell) {
        console.log(`✓ Updated pendingProceeds persisted: Buy ${updatedProceeds.buy.toFixed(8)}, Sell ${updatedProceeds.sell.toFixed(8)}`);
    } else {
        console.log(`✗ Updated pendingProceeds NOT persisted correctly. Got: Buy ${updatedProceeds.buy}, Sell ${updatedProceeds.sell}`);
    }

    // Test 5: Clear pendingProceeds
    console.log('\nTest 5: Clear pendingProceeds and verify persistence');
    accountOrders.updatePendingProceeds(config.botKey, { buy: 0, sell: 0 });
    
    const accountOrders4 = new AccountOrders();
    const clearedProceeds = accountOrders4.loadPendingProceeds(config.botKey);
    
    if (clearedProceeds.buy === 0 && clearedProceeds.sell === 0) {
        console.log(`✓ Cleared pendingProceeds persisted: Buy ${clearedProceeds.buy}, Sell ${clearedProceeds.sell}`);
    } else {
        console.log(`✗ Cleared pendingProceeds NOT persisted correctly`);
    }

    console.log('\n=== All persistence tests completed ===\n');
}

testPendingProceedsPersistenceToFile().catch(console.error);

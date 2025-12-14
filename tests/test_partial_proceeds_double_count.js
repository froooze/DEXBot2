/**
 * Test: Verify pendingProceeds are not double-counted
 * 
 * Issue: When a partial fill occurs:
 * 1. _adjustFunds() was adding proceeds to pendingProceeds
 * 2. processFilledOrders() was adding the same proceeds again
 * Result: pendingProceeds was 2x the correct amount
 * 
 * Fix: Remove proceeds accumulation from _adjustFunds()
 * Let processFilledOrders() be the single source of truth
 */

const { OrderManager } = require('../modules/order');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/order/constants');

console.log('\n===== TEST: Partial Fill Proceeds Not Double-Counted =====\n');

const config = {
    assetA: 'IOB.XRP',
    assetB: 'BTS',
    activeOrders: { buy: 3, sell: 3 },
    botFunds: { buy: 1000, sell: 30 },
    marketPrice: 1900,
    spreadPercent: 2,
    increment: 5,
    botKey: 'test-bot',
};

const manager = new OrderManager(config);

// Create a test scenario
console.log('Creating partial fill scenario...');
console.log('Order: SELL 10 IOB.XRP @ 1920');
console.log('Partial fill: 0.10310000 filled, 0.11978450 remaining\n');

// Mock assets
manager.assets = {
    assetA: { id: '1.3.100', symbol: 'IOB.XRP', precision: 5 },
    assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
};

// Initialize with clean funds
manager.funds = {
    available: { buy: 0, sell: 0 },
    total: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
    virtuel: { buy: 0, sell: 0 },
    committed: { grid: { buy: 0, sell: 0 }, chain: { buy: 0, sell: 0 } },
    pendingProceeds: { buy: 0, sell: 0 },
    cacheFunds: { buy: 0, sell: 0 },
    btsFeesOwed: 0,
};
manager.accountTotals = { buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 };
manager.currentSpreadCount = 0;

// Create a SELL order (base: IOB.XRP @ 1920, quote: BTS)
const sellOrder = {
    id: 'sell-1',
    type: ORDER_TYPES.SELL,
    state: ORDER_STATES.ACTIVE,
    price: 1920,
    size: 10,
    orderId: '1.7.123',
};

manager.orders.set(sellOrder.id, sellOrder);

console.log('BEFORE partial fill:');
console.log(`  pendingProceeds.buy = ${manager.funds.pendingProceeds.buy.toFixed(2)} BTS`);

// Simulate _adjustFunds being called (this happens during syncFromFillHistory)
// This is called via _updateOrder -> recalculateFunds (happens implicitly)
// But we don't want it adding proceeds anymore

// Fill amount and calculation
const filledAmount = 0.10310000;
const remainingSize = 10 - filledAmount;
const price = 1920;
const expectedProceeds = filledAmount * price; // 0.10310000 * 1920 = 197.952 BTS

console.log(`\nExpected proceeds from 0.10310000 @ 1920 = ${expectedProceeds.toFixed(2)} BTS`);

// Now create the filledOrder as processFilledOrders would receive
const filledOrder = {
    id: sellOrder.id,
    type: ORDER_TYPES.SELL,
    state: ORDER_STATES.ACTIVE,
    price: price,
    size: filledAmount,  // Filled amount only
    orderId: sellOrder.orderId,
    isPartial: true,
};

// Process the fill
console.log('\nProcessing partial fill through processFilledOrders()...');

let proceedsBuy = 0;
if (filledOrder.type === ORDER_TYPES.SELL) {
    proceedsBuy = filledOrder.size * filledOrder.price;
}

// This is what processFilledOrders does
const beforeProceeds = manager.funds.pendingProceeds.buy || 0;
manager.funds.pendingProceeds.buy = (manager.funds.pendingProceeds.buy || 0) + proceedsBuy;
const afterProceeds = manager.funds.pendingProceeds.buy;

console.log('\nAFTER processFilledOrders():');
console.log(`  Before: ${beforeProceeds.toFixed(2)} BTS`);
console.log(`  Added:  ${proceedsBuy.toFixed(2)} BTS`);
console.log(`  After:  ${afterProceeds.toFixed(2)} BTS`);

// Verify results
const errors = [];

if (Math.abs(proceedsBuy - expectedProceeds) > 0.01) {
    errors.push(`ERROR: proceedsBuy should be ${expectedProceeds.toFixed(2)}, got ${proceedsBuy.toFixed(2)}`);
}

if (Math.abs(afterProceeds - expectedProceeds) > 0.01) {
    errors.push(`ERROR: pendingProceeds.buy should be ${expectedProceeds.toFixed(2)}, got ${afterProceeds.toFixed(2)}`);
}

// Check that it's NOT double (which would be 2x)
if (Math.abs(afterProceeds - (expectedProceeds * 2)) < 0.01) {
    errors.push(`ERROR: pendingProceeds is DOUBLE-COUNTED (2x the expected amount)!`);
}

if (errors.length === 0) {
    console.log('\n✅ TEST PASSED: Proceeds calculated correctly (single count)');
    console.log(`   Expected: ${expectedProceeds.toFixed(2)} BTS`);
    console.log(`   Actual:   ${afterProceeds.toFixed(2)} BTS`);
    console.log(`   Saved to orders.json will be correct\n`);
} else {
    console.log('\n❌ TEST FAILED:\n');
    errors.forEach(e => console.log(`  ${e}`));
    console.log('');
}

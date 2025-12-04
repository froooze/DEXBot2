const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OrderManager } = require('../modules/order/manager');
const { AccountOrders } = require('../modules/account_orders');

console.log('Running partial-fill unit test (using syncFromOpenOrders)...');

// Prepare a temporary account_orders path for the test
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
const tmpIndexPath = path.join(tmpDir, 'orders.partial.json');
if (fs.existsSync(tmpIndexPath)) fs.unlinkSync(tmpIndexPath);

// Create manager with a minimal config and mocked assets
const cfg = { assetA: 'ASSTA', assetB: 'ASSTB', marketPrice: 2, botFunds: { buy: 1000, sell: 1000 } };
const mgr = new OrderManager(cfg);

// Mock asset metadata (ids and precisions) so conversions work
mgr.assets = {
    assetA: { id: '1.3.100', precision: 3 },
    assetB: { id: '1.3.101', precision: 3 }
};

// Create a single active SELL grid order
const gridId = 'grid-1';
const chainOrderId = '1.7.5000';
const initialSize = 10; // human units of assetA
const price = 2; // quote per base
const gridOrder = { id: gridId, orderId: chainOrderId, type: 'sell', state: 'active', size: initialSize, price };
mgr.orders.set(gridId, gridOrder);
// Initialize funds consistent with an active SELL order
mgr.resetFunds();
mgr.funds.committed.sell = initialSize;
mgr.funds.available.sell = Math.max(0, mgr.funds.available.sell - initialSize);

// Simulate partial fill: 3.5 units of assetA filled
// The blockchain will report for_sale as the remaining amount (10 - 3.5 = 6.5)
const partialFilledHuman = 3.5;
const remainingHuman = initialSize - partialFilledHuman;
const remainingInt = Math.round(remainingHuman * Math.pow(10, mgr.assets.assetA.precision));

// Simulate chain order that matches our grid order (partially filled)
// sell_price.base is assetA, sell_price.quote is assetB
const chainOrders = [{
    id: chainOrderId,
    sell_price: {
        base: { asset_id: mgr.assets.assetA.id, amount: Math.round(initialSize * Math.pow(10, mgr.assets.assetA.precision)) },
        quote: { asset_id: mgr.assets.assetB.id, amount: Math.round(initialSize * price * Math.pow(10, mgr.assets.assetB.precision)) }
    },
    for_sale: remainingInt  // Remaining after partial fill
}];

// Fill info for logging
const fillInfo = {
    pays: { amount: Math.round(partialFilledHuman * Math.pow(10, mgr.assets.assetA.precision)), asset_id: mgr.assets.assetA.id },
    receives: { amount: Math.round(partialFilledHuman * price * Math.pow(10, mgr.assets.assetB.precision)), asset_id: mgr.assets.assetB.id }
};

(async () => {
    try {
        // Call the new syncFromOpenOrders method
        const result = mgr.syncFromOpenOrders(chainOrders, fillInfo);

        // Should have no filled orders (partial fill keeps order active)
        assert(result.filledOrders.length === 0, `Expected 0 filled orders, got ${result.filledOrders.length}`);
        
        // Should have 1 updated order
        assert(result.updatedOrders.length === 1, `Expected 1 updated order, got ${result.updatedOrders.length}`);

        // Check updated grid order size
        const updated = mgr.orders.get(gridId);
        const expectedRemaining = +(remainingHuman).toFixed(8);
        assert(Math.abs(updated.size - expectedRemaining) < 1e-9, `Expected remaining size ${expectedRemaining}, got ${updated.size}`);
        assert(updated.state === 'active', `Expected state 'active', got ${updated.state}`);

        // Check funds adjustments: committed.sell decreased
        const expectedCommittedSell = remainingHuman;
        assert(Math.abs(mgr.funds.committed.sell - expectedCommittedSell) < 1e-9, `committed.sell expected ${expectedCommittedSell}, got ${mgr.funds.committed.sell}`);

        // Persist snapshot using AccountOrders and verify file contains updated size
        const idx = new AccountOrders({ profilesPath: tmpIndexPath });
        const botKey = 'test-bot-0';
        idx.storeMasterGrid(botKey, Array.from(mgr.orders.values()));

        const raw = fs.readFileSync(tmpIndexPath, 'utf8');
        const parsed = JSON.parse(raw);
        assert(parsed.bots && parsed.bots[botKey], 'Expected bot entry in persisted account_orders');
        const persistedOrders = parsed.bots[botKey].grid;
        assert(Array.isArray(persistedOrders), 'Persisted grid should be an array');
        const persisted = persistedOrders.find(o => o.id === gridId);
        assert(persisted, 'Persisted grid should contain the updated order');
        assert(Math.abs(persisted.size - expectedRemaining) < 1e-9, `Persisted size ${persisted.size} != expected ${expectedRemaining}`);

        console.log('Partial-fill test passed.');
        process.exit(0);
    } catch (err) {
        console.error('Partial-fill test failed:', err && err.message ? err.message : err);
        process.exit(1);
    }
})();

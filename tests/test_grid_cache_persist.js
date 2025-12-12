const fs = require('fs');
const path = require('path');
const os = require('os');
const { AccountOrders } = require('../modules/account_orders');
const Grid = require('../modules/order/grid');

// Create a temporary profiles file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-test-'));
const tmpFile = path.join(tmpDir, 'orders.json');

// Bootstrap a minimal profiles structure
const initial = { bots: {}, lastUpdated: new Date().toISOString() };
fs.writeFileSync(tmpFile, JSON.stringify(initial, null, 2) + '\n', 'utf8');

const db = new AccountOrders({ profilesPath: tmpFile });
const botKey = 'test-bot-0';

db.data.bots[botKey] = { meta: { key: botKey, name: 'test', assetA: null, assetB: null, active: false, index: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, grid: [], cacheFunds: { buy: 123.456, sell: 0 }, createdAt: new Date().toISOString(), lastUpdated: new Date().toISOString() };
fs.writeFileSync(tmpFile, JSON.stringify(db.data, null, 2) + '\n', 'utf8');

// Verify initial persisted cacheFunds
const rawBefore = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
if (!rawBefore.bots[botKey] || rawBefore.bots[botKey].cacheFunds.buy !== 123.456) {
  console.error('Setup failed: initial cacheFunds not written');
  process.exit(2);
}

// Simulate manager object minimal shape needed by Grid.checkAndUpdateGridIfNeeded
const ORDER_TYPES = require('../modules/order/constants').ORDER_TYPES;
const manager = {
  funds: { total: { grid: { buy: 100 } }, cacheFunds: { buy: 123.456, sell: 0 } },
  config: { botKey, incrementPercent: 1, weightDistribution: { buy: 0.5, sell: 0.5 } },
  logger: { log: () => {}, logFundsStatus: () => {}, logOrderGrid: () => {} },
  orders: new Map(),
  assets: { assetA: { precision: 8 }, assetB: { precision: 8 } },
  _updateOrder(updated) {
    if (!updated || !updated.id) return;
    this.orders.set(updated.id, updated);
  },
  recalculateFunds() {},
};

// populate some buy orders so updateGridOrderSizesForSide has targets
for (let i = 0; i < 4; i++) {
  const id = `buy-${i}`;
  manager.orders.set(id, { id, type: ORDER_TYPES.BUY, state: 'virtual', price: 90 + i, size: 10 });
}

// Call the function which should clear & persist cacheFunds when threshold exceeded
// inject the AccountOrders instance so Grid uses the test DB instead of creating a new one
manager.accountOrders = db;
const result = Grid.checkAndUpdateGridIfNeeded(manager, manager.funds.cacheFunds);

// Read back persisted file
const rawAfter = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
const persisted = rawAfter.bots[botKey].cacheFunds || { buy: null, sell: null };

if (persisted.buy !== 0) {
  console.error('Test failed: persisted cacheFunds.buy was not cleared, got', persisted.buy);
  process.exit(1);
}

console.log('Test passed: persisted cacheFunds was cleared');
process.exit(0);

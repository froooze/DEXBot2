const assert = require('assert');
console.log('Running rotation cacheFunds tests');

const { OrderManager, grid: Grid, constants } = require('../modules/order/index.js');
const ORDER_TYPES = constants.ORDER_TYPES;
const ORDER_STATES = constants.ORDER_STATES;

async function makeManager() {
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', marketPrice: 100,
        minPrice: 50, maxPrice: 200, incrementPercent: 10, targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 }, activeOrders: { buy: 4, sell: 4 }
    });
    mgr.assets = { assetA: { precision: 5 }, assetB: { precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });
    mgr.resetFunds();
    return mgr;
}

function seedGridForRotation(mgr, targetType, orderCount) {
    // Clear state
    mgr.orders = new Map();
    mgr._ordersByState = { [ORDER_STATES.VIRTUAL]: new Set(), [ORDER_STATES.ACTIVE]: new Set(), [ORDER_STATES.PARTIAL]: new Set() };
    mgr._ordersByType = { [ORDER_TYPES.BUY]: new Set(), [ORDER_TYPES.SELL]: new Set(), [ORDER_TYPES.SPREAD]: new Set() };

    // Add active orders of targetType to rotate
    for (let i = 0; i < orderCount; i++) {
        const id = (targetType === ORDER_TYPES.BUY) ? `buyA${i}` : `sellA${i}`;
        mgr._updateOrder({ id, type: targetType, state: ORDER_STATES.ACTIVE, price: 50 + i, size: 1, orderId: `1.7.${i}` });
    }

    // Add at least orderCount spread slots
    for (let i = 0; i < orderCount; i++) {
        mgr._updateOrder({ id: `s${i}`, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 90 + i, size: 0 });
    }
}

(async () => {
    // Test 1: geometric sizes sum < available -> surplus should be added to cacheFunds
    const mgr1 = await makeManager();
    seedGridForRotation(mgr1, ORDER_TYPES.BUY, 4);
    mgr1.funds.pendingProceeds = { buy: 100, sell: 0 };
    mgr1.funds.cacheFunds = { buy: 0, sell: 0 };

    // Monkeypatch geometric sizing to sum to 80
    const GridModule = require('../modules/order/grid');
    const origFn = GridModule.calculateRotationOrderSizes;
    GridModule.calculateRotationOrderSizes = () => [30, 20, 20, 10]; // sum=80

    const rotations1 = await mgr1.prepareFurthestOrdersForRotation(ORDER_TYPES.BUY, 4);
    // After allocation, we expect surplus = 20 added to cacheFunds.buy
    const cached1 = mgr1.funds.cacheFunds.buy || 0;
    assert(Math.abs(cached1 - 20) < 1e-8, `Expected cacheFunds.buy ~= 20, got ${cached1}`);
    console.log('Test 1 passed: surplus added to cacheFunds when geometric < available');

    // Restore
    GridModule.calculateRotationOrderSizes = origFn;

    // Test 2: geometric sizes sum > available -> sizes scaled, no surplus
    const mgr2 = await makeManager();
    seedGridForRotation(mgr2, ORDER_TYPES.BUY, 4);
    mgr2.funds.pendingProceeds = { buy: 100, sell: 0 };
    mgr2.funds.cacheFunds = { buy: 0, sell: 0 };

    // Patch to sum to 120
    GridModule.calculateRotationOrderSizes = () => [40, 30, 30, 20]; // sum=120

    const rotations2 = await mgr2.prepareFurthestOrdersForRotation(ORDER_TYPES.BUY, 4);
    const cached2 = mgr2.funds.cacheFunds.buy || 0;
    assert(Math.abs(cached2 - 0) < 1e-8, `Expected cacheFunds.buy == 0 after scaling, got ${cached2}`);
    console.log('Test 2 passed: geometric > available scaled and no cacheFunds added');

    // Restore original
    GridModule.calculateRotationOrderSizes = origFn;

    console.log('rotation cacheFunds tests passed');
})();

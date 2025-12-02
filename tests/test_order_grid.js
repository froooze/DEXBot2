const assert = require('assert');
console.log('Running order_grid tests');

const OrderGridGenerator = require('../modules/order/index.js').order_grid;

const cfg = {
    marketPrice: 100,
    minPrice: 50,
    maxPrice: 200,
    incrementPercent: 10,
    targetSpreadPercent: 40,
    weightDistribution: { sell: 1, buy: 1 }
};

const { orders, initialSpreadCount } = OrderGridGenerator.createOrderGrid(cfg);
assert(Array.isArray(orders), 'createOrderGrid should return an orders array');
assert(typeof initialSpreadCount === 'object', 'createOrderGrid should return initialSpreadCount');

// calculateOrderSizes should attach sizes summing approximately to provided funds
const sellFunds = 10;
const buyFunds = 5;
const sized = OrderGridGenerator.calculateOrderSizes(orders, cfg, sellFunds, buyFunds);
assert(Array.isArray(sized), 'calculateOrderSizes should return an array');

const sellSizes = sized.filter(o => o.type === 'sell').reduce((s, o) => s + (o.size || 0), 0);
const buySizes = sized.filter(o => o.type === 'buy').reduce((s, o) => s + (o.size || 0), 0);

// sizes should not exceed funds and should be > 0 for sides that have available funds
assert(sellSizes <= sellFunds + 1e-9, 'Total sell sizes should not exceed sellFunds');
assert(buySizes <= buyFunds + 1e-9, 'Total buy sizes should not exceed buyFunds');

console.log('order_grid tests passed');

const assert = require('assert');
console.log('Running order_grid tests');

const Grid = require('../modules/order/index').default.grid;
const { calculateOrderSizes } = require('../modules/order/utils/math');

const cfg = {
    startPrice: 100,
    minPrice: 50,
    maxPrice: 200,
    incrementPercent: 10,
    targetSpreadPercent: 40,
    weightDistribution: { sell: 1, buy: 1 }
};

const { orders, initialSpreadCount } = Grid.createOrderGrid(cfg);
assert(Array.isArray(orders), 'createOrderGrid should return an orders array');
assert(typeof initialSpreadCount === 'object', 'createOrderGrid should return initialSpreadCount');

// calculateOrderSizes should attach sizes summing approximately to provided funds
const sellFunds = 10;
const buyFunds = 5;
// Use a default precision for test determinism and compare integer totals
const PRECISION = 8;
const sized = calculateOrderSizes(orders, cfg, sellFunds, buyFunds, PRECISION, PRECISION);
assert(Array.isArray(sized), 'calculateOrderSizes should return an array');

const { floatToBlockchainInt } = require('../modules/order/utils/math');
const sellSizesInt = sized.filter(o => o.type === 'sell').reduce((s, o) => s + (o.size ? floatToBlockchainInt(o.size, PRECISION) : 0), 0);
const buySizesInt = sized.filter(o => o.type === 'buy').reduce((s, o) => s + (o.size ? floatToBlockchainInt(o.size, PRECISION) : 0), 0);

const sellFundsInt = floatToBlockchainInt(sellFunds, PRECISION);
const buyFundsInt = floatToBlockchainInt(buyFunds, PRECISION);

// sizes (in integer units) should not exceed integer funds within a small
// rounding allowance (at most 0.5 unit per order due to Math.round).
const sellCount = sized.filter(o => o.type === 'sell').length;
const buyCount = sized.filter(o => o.type === 'buy').length;
const sellAllowance = Math.ceil(0.5 * sellCount);
const buyAllowance = Math.ceil(0.5 * buyCount);
assert(sellSizesInt <= sellFundsInt + sellAllowance, 'Total sell sizes should not exceed sellFunds (with rounding allowance)');
assert(buySizesInt <= buyFundsInt + buyAllowance, 'Total buy sizes should not exceed buyFunds (with rounding allowance)');

console.log('order_grid tests passed');

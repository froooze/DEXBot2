const assert = require('assert');

console.log('Running chain_helpers tests');

const utils = require('../modules/order/utils.js');

// parseChainOrder test (sell case)
const assets = { assetA: { id: '1.3.1', precision: 4 }, assetB: { id: '1.3.2', precision: 5 } };
const chainOrderSell = {
    id: '1.7.100',
    sell_price: {
        base: { asset_id: '1.3.1', amount: 1000 },
        quote: { asset_id: '1.3.2', amount: 200000 }
    },
    for_sale: 500
};

const parsed = utils.parseChainOrder(chainOrderSell, assets);
assert.ok(parsed, 'parsed should not be null');
assert.strictEqual(parsed.orderId, '1.7.100', 'orderId matches');
// price = (200000/1000) * 10^(4-5) = 200 * 0.1 = 20
assert.ok(Math.abs(parsed.price - 20) < 1e-12, `price should be 20, got ${parsed.price}`);
assert.strictEqual(parsed.type, 'sell');
assert.ok(Math.abs(parsed.size - 0.05) < 1e-12, `size should be 0.05, got ${parsed.size}`);

// parseChainOrder test (buy case)
const chainOrderBuy = {
    id: '1.7.101',
    sell_price: {
        // base is assetB, quote is assetA -> BUY type (we sell assetB to receive assetA)
        base: { asset_id: '1.3.2', amount: 250000 },
        quote: { asset_id: '1.3.1', amount: 1000 }
    },
    for_sale: 12345
};

const parsedBuy = utils.parseChainOrder(chainOrderBuy, assets);
assert.ok(parsedBuy, 'parsedBuy should not be null');
assert.strictEqual(parsedBuy.orderId, '1.7.101', 'buy orderId matches');
assert.strictEqual(parsedBuy.type, 'buy');
// BUY size must be in assetB units -> for_sale converted by assetB precision (5)
assert.ok(Math.abs(parsedBuy.size - 0.12345) < 1e-12, `buy size should be 0.12345, got ${parsedBuy.size}`);

// getMinOrderSize test
const minSell = utils.getMinOrderSize('sell', assets, 50);
assert.ok(Math.abs(minSell - 0.005) < 1e-12, `expected minSell 0.005 got ${minSell}`);

// findBestMatchByPrice simple test
const ordersMap = new Map();
ordersMap.set('g1', { id: 'g1', price: 20.0, type: 'sell', size: 1 });
ordersMap.set('g2', { id: 'g2', price: 25.0, type: 'sell', size: 1 });
const candidates = ['g1','g2'];
const chain = { price: 20.1, type: 'sell' };
const calcTol = () => 0.2; // tolerance 0.2 allows 20.1 to match g1 (diff 0.1)
const best = utils.findBestMatchByPrice(chain, candidates, ordersMap, calcTol);
assert.strictEqual(best.match.id, 'g1', 'expect g1 to be best match');

console.log('chain_helpers tests passed');

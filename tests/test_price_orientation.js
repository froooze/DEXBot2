const assert = require('assert');

async function main() {
    const bsModule = require('../modules/bitshares_client');
    const originalBS = bsModule.BitShares;

    const mock = { assets: {}, db: {} };
    const assetA = 'IOB.XRP';
    const assetB = 'BTS';
    mock.assets[assetA.toLowerCase()] = { id: '1.3.100' };
    mock.assets[assetB.toLowerCase()] = { id: '1.3.101' };

    mock.db.lookup_asset_symbols = async arr => arr.map(s => ({ id: s.toLowerCase() === assetA.toLowerCase() ? '1.3.100' : '1.3.101', precision: 0 }));
    mock.db.get_assets = async ids => ids.map(id => ({ id: String(id), precision: 0 }));

    mock.db.get_liquidity_pool_by_asset_ids = async (a, b) => null;
    mock.db.get_liquidity_pools = async () => [{ id: '1.19.500', asset_ids: ['1.3.100', '1.3.101'], total_reserve: 100000 }];
    mock.db.get_objects = async (ids) => {
        if (Array.isArray(ids) && ids[0] === '1.19.500') return [{
            id: '1.19.500',
            reserves: [{ asset_id: '1.3.100', amount: 20000 }, { asset_id: '1.3.101', amount: 3000000 }],
        }];
        return [];
    };

    // Make get_order_book return reciprocal mid values depending on order
    mock.db.get_order_book = async (a, b, limit) => {
        if (String(a) === '1.3.100' && String(b) === '1.3.101') return { bids: [{ price: 0.0014, size: 5 }], asks: [{ price: 0.0016, size: 3 }] };
        if (String(a) === '1.3.101' && String(b) === '1.3.100') return { bids: [{ price: 666.6666666666666, size: 5 }], asks: [{ price: 666.6666666666666, size: 3 }] };
        return { bids: [], asks: [] };
    };
    mock.db.get_ticker = async (a, b) => {
        if (a === '1.3.100' && b === '1.3.101') return { latest: 0.0015 };
        if (a === '1.3.101' && b === '1.3.100') return { latest: 666.6666666666666 };
        return { latest: null };
    };

    bsModule.BitShares = mock;

    try {
        const { derivePoolPrice, deriveMarketPrice } = require('../modules/order/utils');

        const poolAB = await derivePoolPrice(mock, assetA, assetB);
        const poolBA = await derivePoolPrice(mock, assetB, assetA);
        assert(Number.isFinite(poolAB) && Number.isFinite(poolBA));
        assert(Math.abs(poolAB * poolBA - 1) < 1e-9, `pool(A/B)*pool(B/A) != 1: ${poolAB} * ${poolBA}`);

        const marketAB = await deriveMarketPrice(mock, assetA, assetB);
        const marketBA = await deriveMarketPrice(mock, assetB, assetA);
        assert(Number.isFinite(marketAB) && Number.isFinite(marketBA));
        assert(Math.abs(marketAB * marketBA - 1) < 1e-9, `market(A/B)*market(B/A) != 1: ${marketAB} * ${marketBA}`);

        console.log('Orientation test passed: swapping assets inverts the price (reciprocal).');
    } finally {
        bsModule.BitShares = originalBS;
    }

    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(2); });

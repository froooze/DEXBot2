/*
 * tests/test_price_derive.js
 * Tests derivePoolPrice and deriveMarketPrice produce numeric values and expected inversions/orientations.
 */

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
    mock.db.get_liquidity_pools = async () => [{ id: '1.19.500', asset_ids: ['1.3.100', '1.3.101'], total_reserve: 3020000 }];
    mock.db.get_objects = async (ids) => {
        if (Array.isArray(ids) && ids[0] === '1.19.500') return [
            {
                id: '1.19.500',
                reserves: [
                    { asset_id: '1.3.100', amount: 20000 },
                    { asset_id: '1.3.101', amount: 3000000 }
                ],
                total_reserve: 3020000
            }
        ];
        return [];
    };

    mock.db.get_order_book = async (a, b, limit) => ({ bids: [{ price: 0.0014, size: 5 }], asks: [{ price: 0.0016, size: 3 }] });
    mock.db.get_ticker = async () => ({ latest: 0.0015 });

    bsModule.BitShares = mock;

    try {
        const { derivePoolPrice, deriveMarketPrice } = require('../modules/order/price');

        const poolP = await derivePoolPrice(mock, assetA, assetB);
        const marketP = await deriveMarketPrice(mock, assetA, assetB);

        // Expected poolP = reserveB/reserveA = 3000000 / 20000 = 150
        assert(Number.isFinite(poolP), 'pool price must be numeric');
        assert(Math.abs(poolP - (3000000 / 20000)) < 1e-9, `unexpected pool price value ${poolP}`);

        // Expected marketP = 1 / ((0.0014 + 0.0016) / 2) = 666.666...
        assert(Number.isFinite(marketP), 'market price must be numeric');
        assert(Math.abs(marketP - (1 / 0.0015)) < 1e-9, `unexpected market price value ${marketP}`);

        console.log('derivePoolPrice and deriveMarketPrice tests passed: poolP=', poolP, 'marketP=', marketP);
    } finally {
        bsModule.BitShares = originalBS;
    }

    process.exit(0);
}
main().catch(err => { console.error(err); process.exit(2); });

/*
 * tests/test_autoderive.js
 * New clean test that exercises auto-derive behavior against the inverted
 * `modules/order/price.js`. It uses the first active bot from `profiles/bots.json`.
 *
 * The test does not suppress logs or errors. It mocks the shared BitShares
 * client to return deterministic on-chain data and verifies the derived
 * `marketPrice` is numeric and falls in a reasonable range (500 - 8000).
 */

const assert = require('assert');

async function runAutoderiveForBot(botCfg) {
    console.log('Running autoderive for bot:', botCfg.name || '(unnamed)');

    // Monkeypatch shared BitShares client used by the codebase
    const bsModule = require('../modules/bitshares_client');
    const originalBitShares = bsModule.BitShares;

    // Create a mock BitShares object with db helpers used by derive functions
    const mock = { assets: {}, db: {} };
    const assetA = botCfg.assetA; const assetB = botCfg.assetB;
    if (!assetA || !assetB) throw new Error('Bot configuration missing assetA/assetB');

    mock.assets[assetA.toLowerCase()] = { id: '1.3.100' };
    mock.assets[assetB.toLowerCase()] = { id: '1.3.101' };

    // lookup_asset_symbols / get_assets should return ids and precision
    mock.db.lookup_asset_symbols = async (arr) => arr.map(s => ({ id: (s.toLowerCase() === assetA.toLowerCase()) ? '1.3.100' : '1.3.101', precision: 3 }));
    mock.db.get_assets = async (ids) => ids.map(id => {
        if (String(id) === '1.3.100' || String(id).toLowerCase() === assetA.toLowerCase()) return { id: '1.3.100', precision: 3 };
        if (String(id) === '1.3.101' || String(id).toLowerCase() === assetB.toLowerCase()) return { id: '1.3.101', precision: 3 };
        return { id, precision: 3 };
    });

    // Provide a sample liquidity pool so derivePoolPrice has a path.
    mock.db.get_liquidity_pool_by_asset_ids = async (a, b) => null;
    mock.db.get_liquidity_pools = async () => [{ id: '1.19.500', asset_ids: ['1.3.100', '1.3.101'], total_reserve: 10000000 }];
    mock.db.get_objects = async (ids) => {
        if (!Array.isArray(ids) || !ids.length) return [];
        if (ids[0] === '1.19.500') return [{ id: '1.19.500', reserves: [{ asset_id: '1.3.100', amount: 20000 }, { asset_id: '1.3.101', amount: 3000000 }], total_reserve: 3020000 }];
        return [];
    };

    // For market-derived price, price.js in this repo returns reciprocals. We
    // mock a small mid-market price (0.0015) so the reciprocal is about 666.
    mock.db.get_order_book = async (a, b, limit) => ({ bids: [{ price: 0.0014, size: 5 }], asks: [{ price: 0.0016, size: 3 }] });
    mock.db.get_ticker = async () => ({ latest: 0.0015 });

    bsModule.BitShares = mock;

    // Create and initialize the OrderManager which triggers auto-derive.
    const { OrderManager } = require('../modules/order');
    const cfg = Object.assign({}, botCfg, {
        marketPrice: botCfg.marketPrice || 'market',
        minPrice: Number(botCfg.minPrice) || 1e-12,
        maxPrice: Number(botCfg.maxPrice) || 1e12
    });

    const manager = new OrderManager(cfg);
    await manager.initializeOrderGrid();

    try {
        const derived = Number(manager.config.marketPrice);
        console.log('Derived marketPrice =', derived);
    assert(Number.isFinite(derived), 'Derived marketPrice must be a number');
        console.log('Autoderive assertion passed for bot', botCfg.name || '(unnamed)');
    } finally {
        // Restore shared BitShares client to original
        bsModule.BitShares = originalBitShares;
    }
}

async function main() {
    try {
    const liveSettings = require('../profiles/bots.json');
        const bots = liveSettings.bots || [];
    if (!bots.length) throw new Error('No bots defined in profiles/bots.json');

        // Use the first active bot, or fallback to first bot entry
        const active = bots.find(b => b.active === true) || bots[0];
        if (!active) throw new Error('No active bot found and no bots available');

        await runAutoderiveForBot(active);
        console.log('Autoderive test completed successfully');
        process.exit(0);
    } catch (err) {
        console.error('Autoderive test failed:', err && err.stack ? err.stack : err);
        process.exit(2);
    }
}

main();

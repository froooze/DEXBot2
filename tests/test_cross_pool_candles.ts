const assert = require('assert');

console.log('Running cross-pool candle tests');

const { synthesizeCrossCandles } = require('../market_adapter/utils/cross_candles');
const {
    findCrossRoutes,
    fetchCrossPoolCandlesForPair,
    __test: { quoteReserve, poolAssetIds, listPoolsByAsset, scanAllPools },
} = require('../market_adapter/inputs/cross_pool_candles');

const A = { id: '1.3.101', precision: 4, symbol: 'A' };
const B = { id: '1.3.102', precision: 4, symbol: 'B' };
const CORE = { id: '1.3.0', precision: 5, symbol: 'CORE' };
const OTHER = { id: '1.3.103', precision: 4, symbol: 'OTHER' };

function pool(id, assetA, assetB, balanceA, balanceB) {
    return { id, asset_a: assetA, asset_b: assetB, balance_a: String(balanceA), balance_b: String(balanceB) };
}

function clientWithPools({ poolsByAsset, allPools, assets }: { poolsByAsset?: Record<string, unknown>; allPools?: unknown; assets?: Record<string, unknown> }) {
    const db: Record<string, unknown> = {};
    if (poolsByAsset) {
        db.get_liquidity_pools_by_one_asset = async (assetId) => poolsByAsset[assetId] || [];
    }
    if (allPools) {
        db.list_liquidity_pools = async () => allPools;
    }
    if (assets) {
        db.get_assets = async (ids) => ids.map((id) => assets[id] || null);
    }
    return { BitShares: { db } };
}

function testSyntheticCrossMath() {
    const left = [[1000, 2, 4, 1, 3, 10]];
    const right = [[1000, 2, 4, 1, 3, 5]];
    const [row] = synthesizeCrossCandles(left, right);
    assert.strictEqual(row[0], 1000);
    assert.strictEqual(row[1], 1);   // open = 2/2
    assert.strictEqual(row[2], 4);   // high = leftHigh / rightLow
    assert.strictEqual(row[3], 0.25); // low = leftLow / rightHigh
    assert.strictEqual(row[4], 1);   // close = 3/3
    assert.strictEqual(row[5], 10);  // numerator base volume

    // Only exact timestamp matches are crossed; degenerate legs are dropped.
    const unmatched = synthesizeCrossCandles(
        [[1000, 1, 1, 1, 1, 1], [2000, 2, 2, 2, 2, 2]],
        [[1000, 1, 1, 1, 1, 1], [3000, 2, 2, 2, 2, 2], [4000, 0, 0, 0, 0, 1]],
    );
    assert.deepStrictEqual(unmatched.map((c) => c[0]), [1000]);
}

function testPoolHelpers() {
    const p = pool('1.19.9', CORE.id, A.id, 100, 250);
    assert.deepStrictEqual(poolAssetIds(p), [CORE.id, A.id]);
    assert.strictEqual(quoteReserve(p, CORE.id), 100);
    assert.strictEqual(quoteReserve(p, A.id), 250);
    assert.ok(Number.isNaN(quoteReserve(p, '1.3.999')));
}

async function testFindRoutesByOneAssetApi() {
    const poolsByAsset = {
        [A.id]: [
            pool('1.19.aaa', CORE.id, A.id, 400, 20),
            pool('1.19.direct', A.id, B.id, 10, 10),
            pool('1.19.abb', OTHER.id, A.id, 5, 20),
            pool('1.19.shallow', CORE.id, A.id, 1, 20),
        ],
        [B.id]: [
            pool('1.19.bbb', CORE.id, B.id, 200, 30),
            pool('1.19.direct', A.id, B.id, 10, 10),
            pool('1.19.bbb2', OTHER.id, B.id, 3, 30),
        ],
    };
    const client = clientWithPools({
        poolsByAsset,
        assets: {
            [CORE.id]: { id: CORE.id, symbol: 'CORE', precision: 5 },
            [OTHER.id]: { id: OTHER.id, symbol: 'OTHER', precision: 4 },
        },
    });
    const routes = await findCrossRoutes(A, B, client);
    assert.deepStrictEqual(routes.map((r) => r.quote.id), [CORE.id, OTHER.id]);
    assert.strictEqual(routes[0].quote.symbol, 'CORE');
    assert.strictEqual(routes[0].quote.precision, 5);
    // Weaker leg decides the ranking, normalized to the quote's precision.
    assert.strictEqual(routes[0].score, 200 / 1e5);
    assert.strictEqual(routes[1].score, 3 / 1e4);
    assert.strictEqual(String(routes[0].legs[0].pool.id), '1.19.aaa');
    assert.strictEqual(String(routes[0].legs[1].pool.id), '1.19.bbb');
    // The direct A/B pool is never offered as a bridge.
    assert.ok(!routes.some((r) => r.quote.id === A.id || r.quote.id === B.id));
}

async function testFindRoutesFallsBackToListScan() {
    const allPools = [
        pool('1.19.1', CORE.id, A.id, 400, 20),
        pool('1.19.2', CORE.id, B.id, 200, 30),
        pool('1.19.3', OTHER.id, OTHER.id, 1, 1),
    ];
    const client = clientWithPools({ allPools, assets: {} });
    const routes = await findCrossRoutes(A, B, client);
    assert.deepStrictEqual(routes.map((r) => r.quote.id), [CORE.id]);
    assert.strictEqual(routes[0].quote.symbol, CORE.id); // no get_assets: id fallback
}

async function testPreferredBridgeWinsOverRawIntegerReserve() {
    const BIG = { id: '1.3.104', precision: 8, symbol: 'BIG' };
    const poolsByAsset = {
        [A.id]: [pool('1.19.1', CORE.id, A.id, 200, 1), pool('1.19.2', BIG.id, A.id, 1e15, 1)],
        [B.id]: [pool('1.19.3', CORE.id, B.id, 200, 1), pool('1.19.4', BIG.id, B.id, 1e15, 1)],
    };
    const client = clientWithPools({
        poolsByAsset,
        assets: {
            [CORE.id]: { id: CORE.id, symbol: 'CORE', precision: 5 },
            [BIG.id]: { id: BIG.id, symbol: 'BIG', precision: 8 },
        },
    });
    const routes = await findCrossRoutes(A, B, client);
    assert.deepStrictEqual(routes.map((r) => r.quote.id), [CORE.id, BIG.id]);
}

async function testPreferredBridgeByIdWhenMetadataMissing() {
    const BIG = { id: '1.3.104', precision: 8, symbol: 'BIG' };
    const poolsByAsset = {
        [A.id]: [pool('1.19.1', CORE.id, A.id, 200, 1), pool('1.19.2', BIG.id, A.id, 1e15, 1)],
        [B.id]: [pool('1.19.3', CORE.id, B.id, 200, 1), pool('1.19.4', BIG.id, B.id, 1e15, 1)],
    };
    const client = clientWithPools({ poolsByAsset }); // no get_assets: symbols are ids
    const routes = await findCrossRoutes(A, B, client);
    assert.deepStrictEqual(routes.map((r) => r.quote.id), [CORE.id, BIG.id]);
}

async function testPaginatorsHandleInclusiveCursors() {
    const mkPage = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => pool(`1.19.${from + i}`, CORE.id, A.id, 1, 1));
    const pages = [mkPage(1, 100), mkPage(100, 150)];
    const cursors = [];
    const db: Record<string, unknown> = {
        get_liquidity_pools_by_one_asset: async (_id: unknown, _limit: unknown, start: unknown) => {
            cursors.push(start);
            return pages.shift() || [];
        },
    };
    const byAsset = await listPoolsByAsset(db, A.id);
    assert.strictEqual(byAsset.length, 150); // boundary pool deduped
    assert.deepStrictEqual([...new Set(byAsset.map((p) => p.id))].length, 150);
    assert.deepStrictEqual(cursors, [null, '1.19.100']);

    const listPages = [mkPage(1, 100), mkPage(100, 150)];
    const starts = [];
    const listDb: Record<string, unknown> = {
        list_liquidity_pools: async (_limit: unknown, start: unknown) => {
            starts.push(start);
            return listPages.shift() || [];
        },
    };
    const all = await scanAllPools(listDb);
    assert.deepStrictEqual(starts, ['1.19.0', '1.19.100']);
    assert.strictEqual(all.length, 150); // second page's inclusive first row skipped
}

async function testFallbackWhenOneAssetApiThrows() {
    const allPools = [
        pool('1.19.1', CORE.id, A.id, 400, 20),
        pool('1.19.2', CORE.id, B.id, 200, 30),
    ];
    const client = clientWithPools({ allPools, assets: {} });
    client.BitShares.db.get_liquidity_pools_by_one_asset = async () => { throw new Error('method not allowed'); };
    const routes = await findCrossRoutes(A, B, client);
    assert.deepStrictEqual(routes.map((r) => r.quote.id), [CORE.id]);
}

async function testNoRoutesWhenListScanThrows() {
    const client = clientWithPools({ assets: {} });
    client.BitShares.db.list_liquidity_pools = async () => { throw new Error('method not allowed'); };
    const routes = await findCrossRoutes(A, B, client);
    assert.deepStrictEqual(routes, []);
}

async function testFetchFallsThroughEmptyRoute() {
    const routes = [
        {
            quote: { id: OTHER.id, symbol: 'OTHER' },
            legs: [{ pool: { id: '1.19.abb' } }, { pool: { id: '1.19.bbb2' } }],
            score: 1,
        },
        {
            quote: { id: CORE.id, symbol: 'CORE' },
            legs: [{ pool: { id: '1.19.aaa' } }, { pool: { id: '1.19.bbb' } }],
            score: 2,
        },
    ];
    const calls = [];
    const fetchLeg = async (poolId) => {
        calls.push(poolId);
        if (poolId === '1.19.abb' || poolId === '1.19.bbb2') return [];
        if (poolId === '1.19.aaa') return [[1000, 2, 2, 2, 2, 7]];
        return [[1000, 4, 4, 4, 4, 9]];
    };
    const result = await fetchCrossPoolCandlesForPair(A, B, { routes, fetchLeg }, null);
    assert.ok(result);
    assert.strictEqual(result.route.quote.id, CORE.id);
    assert.deepStrictEqual(result.candles, [[1000, 0.5, 0.5, 0.5, 0.5, 7]]);
    assert.deepStrictEqual(calls, ['1.19.abb', '1.19.aaa', '1.19.bbb']);
}

async function testFetchReturnsNullWhenNoRouteHasData() {
    const routes = [{
        quote: { id: CORE.id, symbol: 'CORE' },
        legs: [{ pool: { id: '1.19.aaa' } }, { pool: { id: '1.19.bbb' } }],
        score: 2,
    }];
    const fetchLeg = async () => [];
    const result = await fetchCrossPoolCandlesForPair(A, B, { routes, fetchLeg }, null);
    assert.strictEqual(result, null);
}

(async () => {
    testSyntheticCrossMath();
    testPoolHelpers();
    await testFindRoutesByOneAssetApi();
    await testPreferredBridgeWinsOverRawIntegerReserve();
    await testPreferredBridgeByIdWhenMetadataMissing();
    await testPaginatorsHandleInclusiveCursors();
    await testFindRoutesFallsBackToListScan();
    await testFallbackWhenOneAssetApiThrows();
    await testNoRoutesWhenListScanThrows();
    await testFetchFallsThroughEmptyRoute();
    await testFetchReturnsNullWhenNoRouteHasData();
    console.log('All cross-pool candle tests passed');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

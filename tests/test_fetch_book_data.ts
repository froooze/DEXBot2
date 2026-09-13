const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running fetch book data tests');

const {
    bookCacheKey,
    bookOutputPath,
    isBookChunkMatch,
    fetchMarketCandlesSequentially,
} = require('../market_adapter/inputs/fetch_book_data');
const { discoverPoolAssets } = require('../market_adapter/inputs/kibana_source');

const ASSET_A = { id: '1.3.1', precision: 5, symbol: 'BTS' };
const ASSET_B = { id: '1.3.2', precision: 4, symbol: 'TEST.USD' };

const FILL_FIELD_MAP = {
    soldAssetField: 'operation_history.op_object.pays.asset_id.keyword',
    receivedAssetField: 'operation_history.op_object.receives.asset_id.keyword',
    soldAmountField: 'operation_history.op_object.pays.amount',
    receivedAmountField: 'operation_history.op_object.receives.amount',
};

function fillHit({ id, ts, soldAssetId, receivedAssetId, soldAmount, receivedAmount }) {
    const seq = Number(String(id).match(/(\d+)$/)?.[1] || 0);
    return {
        _id: id,
        sort: [new Date(ts).toISOString(), seq],
        _source: {
            operation_id_num: seq,
            account_history: { operation_id: id },
            block_data: { block_time: new Date(ts).toISOString() },
            operation_history: {
                op_object: {
                    pays: { asset_id: soldAssetId, amount: soldAmount },
                    receives: { asset_id: receivedAssetId, amount: receivedAmount },
                },
            },
        },
    };
}

function soldAssetFromQuery(query) {
    return query.query.bool.filter.find((f) => f.term?.[FILL_FIELD_MAP.soldAssetField])
        ?.term?.[FILL_FIELD_MAP.soldAssetField];
}

function testBookCacheKeyIsOrientationSensitive() {
    assert.strictEqual(bookCacheKey(ASSET_A, ASSET_B), 'bts_test_usd');
    assert.notStrictEqual(
        bookCacheKey(ASSET_A, ASSET_B),
        bookCacheKey(ASSET_B, ASSET_A),
        'B-per-A candles differ by orientation, so the cache key must too'
    );
}

function testBookOutputPathShape() {
    const out = bookOutputPath(ASSET_A, ASSET_B, 3600);
    assert.ok(out.endsWith('.json'), 'chunk-family path must be a .json file');
    assert.ok(out.includes('book_bts_test_usd_1h.json'), `unexpected output path: ${out}`);
}

function testIsBookChunkMatch() {
    const key = {
        source: 'book',
        pair: 'bts_test_usd',
        assetA: { id: ASSET_A.id, precision: ASSET_A.precision, symbol: ASSET_A.symbol },
        assetB: { id: ASSET_B.id, precision: ASSET_B.precision, symbol: ASSET_B.symbol },
        intervalSeconds: 3600,
    };
    assert.ok(isBookChunkMatch({ ...key }, key), 'identical meta must match');
    assert.ok(!isBookChunkMatch({ ...key, pair: 'bts_other' }, key), 'pair mismatch must not match');
    assert.ok(!isBookChunkMatch({ ...key, intervalSeconds: 14400 }, key), 'interval mismatch must not match');
    assert.ok(
        !isBookChunkMatch({ ...key, assetA: { ...key.assetA, precision: 6 } }, key),
        'precision mismatch must not match'
    );
}

async function testDiscoveryAcceptsExplicitTimeRange() {
    const seen = [];
    const mockSearch = async (_cfg, query) => {
        seen.push(query);
        return { aggregations: { sold_assets: { buckets: [{ key: '1.3.0' }, { key: '1.3.121' }] } } };
    };
    const ids = await discoverPoolAssets('1.19.1', {
        kibanaSearch: mockSearch,
        timeRange: { gte: '2025-01-01T00:00:00.000Z', lte: '2025-02-01T00:00:00.000Z' },
    });
    assert.deepStrictEqual(ids, ['1.3.0', '1.3.121']);
    const range = seen[0].query.bool.filter.find((f) => f.range?.['block_data.block_time'])
        ?.range?.['block_data.block_time'];
    assert.deepStrictEqual(
        range,
        { gte: '2025-01-01T00:00:00.000Z', lte: '2025-02-01T00:00:00.000Z' },
        'explicit timeRange must reach the discovery query for reproducible backtests'
    );

    seen.length = 0;
    await discoverPoolAssets('1.19.1', { kibanaSearch: mockSearch, lookbackHours: 48 });
    const fallback = seen[0].query.bool.filter.find((f) => f.range?.['block_data.block_time'])
        ?.range?.['block_data.block_time'];
    assert.deepStrictEqual(
        fallback,
        { gte: 'now-48h', lte: 'now' },
        'omitting timeRange must keep the relative now-lookback window'
    );
}

async function testSequentialFetchReusesDiskCache() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-book-test-'));
    const outPath = path.join(dir, 'book_bts_test_usd_1h.json');
    const timeRange = { gte: '2026-01-01T00:00:00.000Z', lte: '2026-03-01T00:00:00.000Z' };
    let searchCalls = 0;

    const mockSearch = async (_cfg, query) => {
        searchCalls += 1;
        const range = query.query.bool.filter.find((f) => f.range?.['block_data.block_time'])
            ?.range?.['block_data.block_time'];
        const gteMs = Date.parse(range.gte);
        // One fill per month window so each chunk has real data.
        const ts = gteMs + 14 * 24 * 3600 * 1000;
        if (soldAssetFromQuery(query) !== ASSET_A.id) return { hits: { hits: [] } };
        return {
            hits: {
                hits: [
                    fillHit({
                        id: `1.11.${searchCalls}`,
                        ts,
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 100000,
                        receivedAmount: 5000,
                    }),
                ],
            },
        };
    };

    const opts = {
        intervalSeconds: 3600,
        timeRange,
        chunkMonths: 1,
        outPath,
        kibanaSearch: mockSearch,
    };
    const first = await fetchMarketCandlesSequentially(ASSET_A, ASSET_B, opts);
    assert.ok(first.length > 0, 'first fetch must return candles');
    const callsAfterFirst = searchCalls;
    assert.ok(callsAfterFirst > 0, 'first fetch must query Kibana');

    const second = await fetchMarketCandlesSequentially(ASSET_A, ASSET_B, opts);
    assert.deepStrictEqual(second, first, 'cached rerun must return identical candles');
    assert.strictEqual(
        searchCalls,
        callsAfterFirst,
        'cached rerun must not issue new Kibana queries'
    );

    fs.rmSync(dir, { recursive: true, force: true });
}

// A partial window (one direction failed) must be returned for the run
// but NOT persisted — otherwise the gap-filled zeros would claim coverage
// and the failed direction would never be re-queried.
async function testPartialWindowIsNotCached() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-book-partial-test-'));
    const outPath = path.join(dir, 'book_bts_test_usd_1h.json');
    const timeRange = { gte: '2026-01-01T00:00:00.000Z', lte: '2026-01-03T00:00:00.000Z' };
    let failBDirection = true;
    let searchCalls = 0;

    const mockSearch = async (_cfg, query) => {
        searchCalls += 1;
        if (soldAssetFromQuery(query) !== ASSET_A.id) {
            if (failBDirection) throw new Error('socket hang up');
            return { hits: { hits: [] } };
        }
        return {
            hits: {
                hits: [
                    fillHit({
                        id: `1.11.${searchCalls}`,
                        ts: Date.parse('2026-01-02T00:00:00Z'),
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 100000,
                        receivedAmount: 5000,
                    }),
                ],
            },
        };
    };
    const opts = {
        intervalSeconds: 3600,
        timeRange,
        chunkMonths: 1,
        outPath,
        kibanaSearch: mockSearch,
        kibanaRetryDelayMs: 1,
    };

    const partial = await fetchMarketCandlesSequentially(ASSET_A, ASSET_B, opts);
    assert.ok(partial.length > 0, 'partial fetch must still return the surviving side');
    const shardsAfterPartial = fs.readdirSync(dir).filter((n) => n.includes('.shard_'));
    assert.strictEqual(
        shardsAfterPartial.length,
        0,
        'a partial window must not be persisted to disk'
    );

    // Heal the failing direction: the next run re-queries and caches.
    failBDirection = false;
    const healed = await fetchMarketCandlesSequentially(ASSET_A, ASSET_B, opts);
    assert.ok(healed.length > 0, 'healed fetch must return candles');
    const shardsAfterHeal = fs.readdirSync(dir).filter((n) => n.includes('.shard_'));
    assert.ok(shardsAfterHeal.length > 0, 'healed fetch must persist month-shard files');

    fs.rmSync(dir, { recursive: true, force: true });
}

async function run() {
    testBookCacheKeyIsOrientationSensitive();
    testBookOutputPathShape();
    testIsBookChunkMatch();
    await testDiscoveryAcceptsExplicitTimeRange();
    await testSequentialFetchReusesDiskCache();
    await testPartialWindowIsNotCached();
}

run()
    .then(() => {
        console.log('fetch book data tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });

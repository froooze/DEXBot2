const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running fetch_lp_data parsing tests');

const {
    fetchCandlesSequentially,
    __test: { applyPrecisionOverrides, parseBotsConfig, selectBot, loadCachedFetchContext, parseArgs },
} = require('../market_adapter/inputs/fetch_lp_data');

{
    const raw = `{
  // single-line comment
  "bots": [
    {
      /* block comment */
      "name": "AAA-BBB",
      "active": true,
      "startPrice": "pool",
      "assetA": "IOB.XRP",
      "assetB": "BTS"
    }
  ]
}`;

    const bots = parseBotsConfig(raw, 'inline-fixture');
    assert.ok(Array.isArray(bots), 'parseBotsConfig should return an array');
    assert.strictEqual(bots.length, 1, 'commented bots fixture should parse one bot');
    assert.strictEqual(bots[0].name, 'AAA-BBB', 'parsed bot name should match');
}

{
    assert.throws(
        () => parseBotsConfig('{"foo": 1}', 'invalid-fixture'),
        /Invalid bots\.json format: invalid-fixture/,
        'invalid format should throw with source label'
    );
}

{
    const bots = [
        { name: 'A', active: false, startPrice: 'pool' },
        { name: 'B', active: true, startPrice: 'book' },
        { name: 'C', active: true, startPrice: 'pool' },
    ];
    const selected = selectBot(bots, null);
    assert.strictEqual(selected.name, 'C', 'selectBot should pick first active pool-price bot');
}

{
    const { assetA, assetB } = applyPrecisionOverrides(
        { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
        { id: '1.3.0', precision: 5, symbol: 'BTS' },
        8,
        null
    );
    assert.strictEqual(assetA.precision, 8, 'precision override should be applied to cached or resolved asset A metadata');
    assert.strictEqual(assetB.precision, 5, 'missing override should preserve the existing asset B precision');
}

const LP_ASSET_A = { id: '1.3.0', precision: 5, symbol: 'BTS' };
const LP_ASSET_B = { id: '1.3.5537', precision: 4, symbol: 'IOB.XRP' };

function lpSoldAssetFromQuery(query) {
    return query.query.bool.filter.find(
        (f) => f.term?.['operation_history.op_object.amount_to_sell.asset_id.keyword']
    )?.term?.['operation_history.op_object.amount_to_sell.asset_id.keyword'];
}

function lpHit(id, ts) {
    return {
        _id: id,
        sort: [new Date(ts).toISOString(), 1],
        _source: {
            operation_id_num: 1,
            account_history: { operation_id: id },
            block_data: { block_time: new Date(ts).toISOString() },
            operation_history: {
                op_object: {
                    pool: '1.19.133',
                    amount_to_sell: { asset_id: LP_ASSET_A.id, amount: 100000 },
                    min_to_receive: { asset_id: LP_ASSET_B.id },
                },
                operation_result_object: {
                    data_object: { received: { amount: 5000 } },
                },
            },
        },
    };
}

// The LP fetcher must go through the same runCachedWindows path as book and
// feed: stable month-shard files are written next to outPath and exact-reruns
// reuse them without new Kibana queries.
async function testLpSequentialCachesAndReuses() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-lp-test-'));
    const outPath = path.join(dir, 'lp_pool_133_1h.json');
    const timeRange = { gte: '2026-01-01T00:00:00.000Z', lte: '2026-01-03T00:00:00.000Z' };
    let searchCalls = 0;
    const mockSearch = async (_cfg, query) => {
        searchCalls += 1;
        if (lpSoldAssetFromQuery(query) !== LP_ASSET_A.id) return { hits: { hits: [] } };
        return { hits: { hits: [lpHit(`1.11.${searchCalls}`, Date.parse('2026-01-02T00:00:00Z'))] } };
    };
    const config = { intervalSeconds: 3600, chunkMonths: 1, timeRange, kibanaSearch: mockSearch, kibanaRetryDelayMs: 1 };

    const first = await fetchCandlesSequentially('1.19.133', LP_ASSET_A, LP_ASSET_B, config, outPath);
    assert.ok(first.length > 0, 'first LP fetch must return candles');
    const callsAfterFirst = searchCalls;
    assert.ok(callsAfterFirst > 0, 'first LP fetch must query Kibana');
    const shards = fs.readdirSync(dir).filter((n) => n.includes('.shard_'));
    assert.ok(shards.length > 0, 'LP fetch must persist month-shard files for reuse');

    const second = await fetchCandlesSequentially('1.19.133', LP_ASSET_A, LP_ASSET_B, config, outPath);
    assert.deepStrictEqual(second, first, 'cached LP rerun must return identical candles');
    assert.strictEqual(searchCalls, callsAfterFirst, 'cached LP rerun must not issue new Kibana queries');

    fs.rmSync(dir, { recursive: true, force: true });
}

// A transient range failure must be retried by the shared runner budget
// (fetchAttempts), not fail the whole multi-month fetch.
async function testLpSequentialRetriesFailedRange() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-lp-retry-test-'));
    const outPath = path.join(dir, 'lp_pool_133_1h.json');
    const timeRange = { gte: '2026-01-01T00:00:00.000Z', lte: '2026-01-03T00:00:00.000Z' };
    let searchCalls = 0;
    const mockSearch = async (_cfg, query) => {
        searchCalls += 1;
        // Fail the first 9 calls: both directions exhaust their 4-attempt
        // page budgets (4+4) so the shared runner's window budget must kick
        // in; the retry then succeeds.
        if (searchCalls <= 9) throw new Error('socket hang up');
        if (lpSoldAssetFromQuery(query) !== LP_ASSET_A.id) return { hits: { hits: [] } };
        return { hits: { hits: [lpHit('1.11.9', Date.parse('2026-01-02T00:00:00Z'))] } };
    };
    const config = { intervalSeconds: 3600, chunkMonths: 1, timeRange, kibanaSearch: mockSearch, kibanaRetryDelayMs: 1 };

    const candles = await fetchCandlesSequentially('1.19.133', LP_ASSET_A, LP_ASSET_B, config, outPath);
    assert.ok(candles.length > 0, 'LP fetch must recover from a transient range failure');
    assert.ok(searchCalls > 9, 'recovery should take more than both page budgets combined');

    fs.rmSync(dir, { recursive: true, force: true });
}

// After the month-shard refactor, dexbot tv/dw only write shard files. The
// cached-context fast path (skip the blockchain connect) must recognize them
// too, not just the whole-history export.
function testLoadCachedFetchContextReadsShardOnlyCache() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-lp-ctx-'));
    const bot = { name: 'X', assetA: 'TESTA', assetB: 'TESTB' };
    const meta = {
        pool: '1.19.9',
        intervalSeconds: 3600,
        assetA: { id: '1.3.11', precision: 4, symbol: 'TESTA' },
        assetB: { id: '1.3.12', precision: 5, symbol: 'TESTB' },
        timeRange: { gte: '2026-01-01T00:00:00.000Z', lte: '2026-02-01T00:00:00.000Z' },
        fetchedAt: '2026-02-01T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, 'lp_pool_9_1h.shard_2026-01.json'),
        JSON.stringify({ meta, candles: [] }));
    fs.writeFileSync(path.join(dir, 'lp_pool_9_4h.shard_2026-01.json'),
        JSON.stringify({ meta: { ...meta, intervalSeconds: 14400 }, candles: [] }));

    try {
        const ctx = loadCachedFetchContext(bot, 3600, dir);
        assert.ok(ctx, 'a shard-only cache must still resolve a cached fetch context');
        assert.strictEqual(ctx.poolId, '1.19.9', 'pool id comes from shard meta');
        assert.strictEqual(ctx.assetA.id, '1.3.11', 'asset A id comes from shard meta');
        assert.strictEqual(ctx.assetB.id, '1.3.12', 'asset B id comes from shard meta');

        assert.strictEqual(loadCachedFetchContext(bot, 14400, dir).poolId, '1.19.9',
            'the 4h shard resolves for a 4h request');
        assert.strictEqual(loadCachedFetchContext(bot, 900, dir), null,
            'no shard/base for another interval resolves to null');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function testCliArgValidation() {
    const originalArgv = process.argv;
    const withArgv = <T,>(args: string[], fn: () => T): T => {
        process.argv = ['node', 'fetch_lp_data.js', ...args];
        try {
            return fn();
        } finally {
            process.argv = originalArgv;
        }
    };

    assert.throws(
        () => withArgv(['--chunkMonths', 'abc'], parseArgs),
        /--chunkMonths: invalid value "abc" \(expected an integer >= 1\)/,
        'non-numeric --chunkMonths should be rejected'
    );
    assert.throws(
        () => withArgv(['--chunkMonths', '0'], parseArgs),
        /--chunkMonths: invalid value "0"/,
        'zero --chunkMonths should be rejected'
    );
    assert.throws(
        () => withArgv(['--precA', '-1'], parseArgs),
        /--precA: invalid value "-1"/,
        'negative precision should be rejected'
    );
    assert.throws(
        () => withArgv(['--precB', '1.5'], parseArgs),
        /--precB: invalid value "1.5"/,
        'fractional precision should be rejected'
    );
    assert.throws(
        () => withArgv(['--precA='], parseArgs),
        /--precA: invalid value ""/,
        'an empty inline integer should be rejected, not read as zero'
    );
    assert.throws(
        () => withArgv(['--out', ''], parseArgs),
        /--out: expected a non-empty value/,
        'empty output path should be rejected'
    );
    assert.throws(
        () => withArgv(['--apiKey', '--nope'], parseArgs),
        /Flag --apiKey expects a value/,
        'a flag-shaped value should be reported as missing'
    );

    const parsed = withArgv(
        ['--chunkMonths=7', '--precA=8', '--precB', '3', '--out=--odd.json', '--apiKey=abc123'],
        parseArgs
    ) as {
        precA: number | null;
        precB: number | null;
        config: { chunkMonths: number; outPath?: string; apiKey: string | null };
    };
    assert.strictEqual(parsed.config.chunkMonths, 7, 'inline --chunkMonths should parse');
    assert.strictEqual(parsed.precA, 8, 'inline --precA should parse');
    assert.strictEqual(parsed.precB, 3, 'bare --precB should parse');
    assert.strictEqual(parsed.config.outPath, '--odd.json', 'inline value may start with --');
    assert.strictEqual(parsed.config.apiKey, 'abc123', 'inline --apiKey should parse');
}

(async () => {
    testLoadCachedFetchContextReadsShardOnlyCache();
    await testLpSequentialCachesAndReuses();
    await testLpSequentialRetriesFailedRange();
    testCliArgValidation();
})()
    .then(() => {
        console.log('fetch_lp_data parsing tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });

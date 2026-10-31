const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running kibana feed source tests');

const {
    __test: {
        OP_TYPE_FEED,
        backingPerMpa,
        hitToFeedPrice,
        buildFeedDocumentQuery,
        bucketPricesToCandles,
        invertCandles,
        crossPointsToRatios,
        getFeedCandlesForMpa,
        getFeedCandlesForPair,
        getFeedCandlesForMpaCross,
    },
} = require('../market_adapter/inputs/kibana_feed_source');

const MPA = { id: '1.3.5649', precision: 4, symbol: 'HONEST.USD' };
const EUR = { id: '1.3.6315', precision: 4, symbol: 'HONEST.EUR' };
const BTS = { id: '1.3.0', precision: 5, symbol: 'BTS' };

// 100 BTS per 20 MPA => 5 BTS per MPA (base = backing side).
function feedHit({ id, ts, base, quote }) {
    const seq = Number(String(id).match(/(\d+)$/)?.[1] || 0);
    return {
        _id: id,
        sort: [new Date(ts).toISOString(), seq],
        _source: {
            operation_id_num: seq,
            account_history: { operation_id: id },
            block_data: { block_time: new Date(ts).toISOString().replace('.000Z', '') },
            operation_history: {
                op_object: {
                    asset_id: MPA.id,
                    feed: {
                        settlement_price: { base, quote },
                    },
                },
            },
        },
    };
}

function mpaPerBtsHit(id, ts, mpaAmount, btsAmount) {
    return feedHit({
        id,
        ts,
        base: { amount: btsAmount, asset_id: BTS.id },
        quote: { amount: mpaAmount, asset_id: MPA.id },
    });
}

function testBackingPerMpaHandlesBothOrientations() {
    // Base = backing (BTS), quote = MPA: 100 BTS / 20 MPA = 5 BTS per MPA.
    assert.strictEqual(
        backingPerMpa(
            { base: { amount: 10000000, asset_id: BTS.id }, quote: { amount: 200000, asset_id: MPA.id } },
            MPA,
            BTS
        ),
        5
    );
    // Base = MPA, quote = backing: same economic price, flipped orientation.
    assert.strictEqual(
        backingPerMpa(
            { base: { amount: 200000, asset_id: MPA.id }, quote: { amount: 10000000, asset_id: BTS.id } },
            MPA,
            BTS
        ),
        5
    );
    // String amounts (observed on-chain) coerce cleanly.
    assert.strictEqual(
        backingPerMpa(
            { base: { amount: '10000000', asset_id: BTS.id }, quote: { amount: '200000', asset_id: MPA.id } },
            MPA,
            BTS
        ),
        5
    );
    // Unrelated asset pair yields null instead of a bogus price.
    assert.strictEqual(
        backingPerMpa(
            { base: { amount: 1, asset_id: '1.3.1' }, quote: { amount: 2, asset_id: BTS.id } },
            MPA,
            BTS
        ),
        null
    );
    assert.strictEqual(backingPerMpa(null, MPA, BTS), null);
}

function testHitToFeedPrice() {
    const hit = mpaPerBtsHit('1.11.9', '2026-05-01T02:15:00Z', 200000, 10000000);
    const point = hitToFeedPrice(hit, { mpaAsset: MPA, backingAsset: BTS });
    assert.strictEqual(point.price, 5);
    assert.strictEqual(point.tsMs, Date.parse('2026-05-01T02:15:00Z'));

    const bad = feedHit({
        id: '1.11.10',
        ts: '2026-05-01T02:16:00Z',
        base: { amount: 0, asset_id: BTS.id },
        quote: { amount: 200000, asset_id: MPA.id },
    });
    assert.strictEqual(hitToFeedPrice(bad, { mpaAsset: MPA, backingAsset: BTS }), null);
}

function testFeedDocumentQuery() {
    const query = buildFeedDocumentQuery({
        mpaAssetId: MPA.id,
        lookbackHours: 24,
        timeRange: { gte: '2026-05-01T00:00:00.000Z', lte: '2026-05-02T00:00:00.000Z' },
        size: 500,
    });
    assert.strictEqual(query.track_total_hits, false);
    const filters = query.query.bool.filter;
    assert.ok(filters.some((f) => f.term?.operation_type === OP_TYPE_FEED), 'filters op_type 19');
    assert.ok(
        filters.some((f) => f.term?.['operation_history.op_object.asset_id.keyword'] === MPA.id),
        'filters the published MPA asset id'
    );
    assert.deepStrictEqual(query.sort, [
        { 'block_data.block_time': { order: 'asc' } },
        { operation_id_num: { order: 'asc' } },
    ]);
}

function testBucketPricesToCandles() {
    const hour = Date.parse('2026-05-01T02:00:00Z');
    const points = [
        { tsMs: hour + 10 * 60 * 1000, price: 5 },
        { tsMs: hour + 50 * 60 * 1000, price: 7 },
        { tsMs: hour + 20 * 60 * 1000, price: 4 },
        { tsMs: hour + 3600 * 1000 + 5 * 60 * 1000, price: 6 },
        { tsMs: hour + 1 * 60 * 1000, price: -3 },
        { tsMs: Number.NaN, price: 9 },
    ];
    const candles = bucketPricesToCandles(points, 3600);
    assert.strictEqual(candles.length, 2);
    // Unordered input still yields open = earliest, close = latest.
    assert.deepStrictEqual(candles[0], [hour, 5, 7, 4, 7, 3]);
    assert.deepStrictEqual(candles[1], [hour + 3600 * 1000, 6, 6, 6, 6, 1]);
    assert.deepStrictEqual(bucketPricesToCandles([], 3600), []);
}

function testInvertCandles() {
    const out = invertCandles([[1000, 2, 4, 1, 3, 9]]);
    assert.strictEqual(out.length, 1);
    const [ts, o, h, l, c, v] = out[0];
    assert.strictEqual(ts, 1000);
    assert.strictEqual(v, 9);
    assert.ok(Math.abs(o - 1 / 3) < 1e-12);
    assert.ok(Math.abs(h - 1 / 1) < 1e-12);
    assert.ok(Math.abs(l - 1 / 4) < 1e-12);
    assert.ok(Math.abs(c - 1 / 2) < 1e-12);
    assert.deepStrictEqual(invertCandles([[1000, 0, 1, 1, 1, 1]]), []);
}

async function testFeedCandlesForPairOrientation() {
    const hits = [
        mpaPerBtsHit('1.11.21', '2026-05-01T02:10:00Z', 200000, 10000000),
        mpaPerBtsHit('1.11.22', '2026-05-01T02:40:00Z', 200000, 12000000),
    ];
    const stub = async () => ({ hits: { hits } });
    const cfg = {
        intervalSeconds: 3600,
        fillGaps: false,
        kibanaSearch: stub,
        timeRange: { gte: '2026-05-01T00:00:00.000Z', lte: '2026-05-01T04:00:00.000Z' },
    };

    // (MPA, BTS): B-per-A = BTS-per-MPA, feed as-is (5 → 6).
    const direct = await getFeedCandlesForPair(MPA, BTS, MPA, BTS, cfg);
    assert.strictEqual(direct.length, 1);
    assert.deepStrictEqual(direct[0].slice(1, 5), [5, 6, 5, 6]);

    // (BTS, MPA): B-per-A = MPA-per-BTS, inverted feed (feed 5 → 6 inverts to 1/6 → 1/5).
    const inverted = await getFeedCandlesForPair(BTS, MPA, MPA, BTS, cfg);
    assert.strictEqual(inverted.length, 1);
    const [, o, h, l, c] = inverted[0];
    assert.ok(Math.abs(o - 1 / 6) < 1e-12);
    assert.ok(Math.abs(h - 1 / 5) < 1e-12);
    assert.ok(Math.abs(l - 1 / 6) < 1e-12);
    assert.ok(Math.abs(c - 1 / 5) < 1e-12);

    await assert.rejects(
        getFeedCandlesForPair(MPA, { id: '1.3.1', precision: 4, symbol: 'OTHER' }, MPA, BTS, cfg),
        /cannot price/i
    );
}

function eurPerBtsHit(id, ts, eurAmount, btsAmount) {
    return feedHit({
        id,
        ts,
        base: { amount: btsAmount, asset_id: BTS.id },
        quote: { amount: eurAmount, asset_id: EUR.id },
    });
}

function testCrossPointsToRatios() {
    const hour = Date.parse('2026-05-01T02:00:00Z');
    const num = [
        { tsMs: hour + 1 * 60 * 1000, price: 9 },
        { tsMs: hour + 10 * 60 * 1000, price: 5 },
        { tsMs: hour + 40 * 60 * 1000, price: 6 },
    ];
    const den = [
        { tsMs: hour + 5 * 60 * 1000, price: 10 },
        { tsMs: hour + 50 * 60 * 1000, price: 20 },
    ];
    // Leading numerator point predates the first denominator publish: dropped.
    assert.deepStrictEqual(crossPointsToRatios(num, den), [
        { tsMs: hour + 10 * 60 * 1000, price: 0.5 },
        { tsMs: hour + 40 * 60 * 1000, price: 0.6 },
    ]);
    assert.deepStrictEqual(crossPointsToRatios(num, []), []);
}

async function testFeedCrossCandles() {
    const legUSD = { mpa: MPA, backing: BTS };
    const legEUR = { mpa: EUR, backing: BTS };
    // 5 BTS/USD and 10 BTS/EUR in the same hour => 0.5 EUR per USD.
    const hitsByAsset = {
        [MPA.id]: [
            mpaPerBtsHit('1.11.40', '2026-05-01T02:05:00Z', 200000, 10000000),
            mpaPerBtsHit('1.11.41', '2026-05-01T02:20:00Z', 200000, 10000000),
        ],
        [EUR.id]: [eurPerBtsHit('1.11.42', '2026-05-01T02:10:00Z', 100000, 10000000)],
    };
    const stub = async (_cfg: any, query: any) => {
        const filter = query.query.bool.filter.find((f: any) => f.term?.['operation_history.op_object.asset_id.keyword']);
        const id = String(filter ? Object.values(filter.term)[0] : '');
        return { hits: { hits: (hitsByAsset as any)[id] || [] } };
    };
    const cfg = {
        intervalSeconds: 3600,
        fillGaps: false,
        kibanaSearch: stub,
        timeRange: { gte: '2026-05-01T00:00:00.000Z', lte: '2026-05-01T04:00:00.000Z' },
    };

    const straight = await getFeedCandlesForMpaCross(MPA, EUR, legUSD, legEUR, cfg);
    assert.strictEqual(straight.length, 1);
    assert.deepStrictEqual(straight[0].slice(1, 5), [0.5, 0.5, 0.5, 0.5]);
    assert.strictEqual(straight[0][5], 1.5, 'cross volume is the average of both feed publication counts');

    // Flipped legs still orient to B-per-A (2 USD per EUR).
    const flipped = await getFeedCandlesForMpaCross(EUR, MPA, legUSD, legEUR, cfg);
    assert.strictEqual(flipped.length, 1);
    assert.deepStrictEqual(flipped[0].slice(1, 5), [2, 2, 2, 2]);

    await assert.rejects(
        getFeedCandlesForMpaCross(MPA, EUR, legUSD, { mpa: EUR, backing: { id: '1.3.113', precision: 4, symbol: 'CNY' } }, cfg),
        /shared backing/i
    );
    await assert.rejects(
        getFeedCandlesForMpaCross(MPA, MPA, legUSD, legUSD, cfg),
        /distinct/i
    );
    await assert.rejects(
        getFeedCandlesForMpaCross(MPA, BTS, legUSD, legEUR, cfg),
        /covers/i
    );
}

async function testFeedCandlesFillGaps() {
    const hits = [mpaPerBtsHit('1.11.31', '2026-05-01T02:10:00Z', 200000, 10000000)];
    const candles = await getFeedCandlesForMpa(MPA, BTS, {
        intervalSeconds: 3600,
        kibanaSearch: async () => ({ hits: { hits } }),
        timeRange: { gte: '2026-05-01T00:00:00.000Z', lte: '2026-05-01T04:00:00.000Z' },
    });
    assert.ok(candles.length >= 1, 'gap-filled range should cover the window');
    assert.strictEqual(candles[0][4], 5);
}


async function run() {
    testBackingPerMpaHandlesBothOrientations();
    testHitToFeedPrice();
    testFeedDocumentQuery();
    testBucketPricesToCandles();
    testInvertCandles();
    testCrossPointsToRatios();
    await testFeedCandlesForPairOrientation();
    await testFeedCandlesFillGaps();
    await testFeedCrossCandles();
}

run()
    .then(() => {
        console.log('kibana feed source tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });

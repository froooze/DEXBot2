'use strict';

const assert = require('assert');

const {
    OHLC_STANDARD,
    OHLC_CLOSE_HIGH_LOW,
    OHLC_GATE,
    OHLC_KRAKEN,
    parseCandleRow,
    parseCandleRows,
    parseHtxObjectRow,
    __test: { normalizeTimestamp },
} = require('../market_adapter/inputs/cex_candle_parsing');

function testNormalizeTimestamp() {
    assert.strictEqual(normalizeTimestamp(1710000000), 1710000000000, 'seconds -> ms');
    assert.strictEqual(normalizeTimestamp(1710000000000), 1710000000000, 'ms unchanged');
    assert.ok(Number.isNaN(normalizeTimestamp('nope')));
    assert.ok(Number.isNaN(normalizeTimestamp(undefined)));
}

function testStandardLayout() {
    const rows = [
        [1710000000000, '1', '1.1', '0.9', '1.02', '10'],
        [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
    ];
    const out = parseCandleRows(rows, OHLC_STANDARD);
    assert.deepStrictEqual(out, [
        [1710000000000, 1, 1.1, 0.9, 1.02, 10],
        [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
    ]);
}

function testCloseHighLowLayout() {
    // [ts, open, close, high, low, volume]
    const out = parseCandleRow([1710000000000, 1, 1.05, 1.1, 0.9, 10], OHLC_CLOSE_HIGH_LOW);
    assert.deepStrictEqual(out, [1710000000000, 1, 1.1, 0.9, 1.05, 10]);
}

function testGateLayout() {
    // [ts, quoteVolume, close, high, low, open, baseVolume, windowClosed]
    const out = parseCandleRow([1710000000000, 999, 1.05, 1.1, 0.9, 1, 10, true], OHLC_GATE);
    assert.deepStrictEqual(out, [1710000000000, 1, 1.1, 0.9, 1.05, 10]);
}

function testKrakenLayout() {
    // [tsSeconds, open, high, low, close, vwap, volume, count]
    const out = parseCandleRow([1710000000, 1, 1.1, 0.9, 1.05, 1.0, 10, 5], OHLC_KRAKEN);
    assert.deepStrictEqual(out, [1710000000000, 1, 1.1, 0.9, 1.05, 10]);
}

function testRejectsInvalidAndShortRows() {
    assert.strictEqual(parseCandleRow([1, 2, 3], OHLC_STANDARD), null, 'too short');
    assert.strictEqual(parseCandleRow('nope', OHLC_STANDARD), null, 'not an array');
    assert.strictEqual(parseCandleRow([1710000000000, 'x', 1, 1, 1, 1], OHLC_STANDARD), null, 'non-numeric OHLC');
    assert.strictEqual(parseCandleRow([NaN, 1, 1, 1, 1, 1], OHLC_STANDARD), null, 'non-finite ts');
}

function testVolumeFallbackAndSorting() {
    const rows = [
        [1710003600000, 2, 2, 2, 2, null],
        [1710000000000, 1, 1, 1, 1, 5],
    ];
    const out = parseCandleRows(rows, OHLC_STANDARD);
    assert.strictEqual(out[0][0], 1710000000000, 'ascending sort');
    assert.strictEqual(out[1][5], 0, 'non-finite volume falls back to 0');
}

function testHtxObjectRow() {
    const out = parseHtxObjectRow({ id: 1710000000, open: 1, high: 1.1, low: 0.9, close: 1.05, amount: 10 });
    assert.deepStrictEqual(out, [1710000000000, 1, 1.1, 0.9, 1.05, 10]);
    assert.strictEqual(parseHtxObjectRow({ open: 1 }), null, 'missing ts rejected');
    assert.strictEqual(parseHtxObjectRow(null), null);
}

function main() {
    testNormalizeTimestamp();
    testStandardLayout();
    testCloseHighLowLayout();
    testGateLayout();
    testKrakenLayout();
    testRejectsInvalidAndShortRows();
    testVolumeFallbackAndSorting();
    testHtxObjectRow();
    console.log('cex candle parsing tests passed');
}

main();

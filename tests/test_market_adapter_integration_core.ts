const assert = require('assert');
const { 
    normalizeNativeMarketHistoryCandles,
    __test: { parseNativeMarketHistoryTimestamp },
} = require('../market_adapter/utils/native_history');

console.log('Running market_adapter integration core tests (BitShares Core 7.0.x parity)');

/**
 * 1. Test BitShares Core 7.0.x Timestamp Serialization
 * BitShares Core (fc::time_point_sec) serializes as ISO-8601 WITHOUT 'Z' suffix.
 * We must ensure this is always interpreted as UTC regardless of local timezone.
 */
{
    console.log('  Testing BitShares Core ISO timestamp parsing...');
    const rawEntry = {
        key: {
            open: '2026-05-09T10:00:00'
        }
    };
    const ts = parseNativeMarketHistoryTimestamp(rawEntry);
    const expected = Date.UTC(2026, 4, 9, 10, 0, 0); // May is index 4
    assert.strictEqual(ts, expected, `ISO timestamp without Z must be UTC. Got ${new Date(ts).toISOString()}, expected ${new Date(expected).toISOString()}`);
}

/**
 * 2. Test BitShares Core share_type as string
 * Core returns large integers as strings in JSON.
 */
{
    console.log('  Testing BitShares Core string-encoded share_types...');
    const assetA = { id: '1.3.1', precision: 4 };
    const assetB = { id: '1.3.0', precision: 5 };
    
    const history = [{
        key: {
            base: '1.3.0',
            quote: '1.3.1',
            open: '2026-05-09T10:00:00'
        },
        open_base: '100000',  // 1.00000 BTS
        open_quote: '20000',  // 2.0000 XRP
        high_base: '150000',
        high_quote: '20000',
        low_base: '100000',
        low_quote: '20000',
        close_base: '100000',
        close_quote: '20000',
        base_volume: '500000',
        quote_volume: '100000'
    }];
    
    const candles = normalizeNativeMarketHistoryCandles(history, assetA, assetB);
    assert.strictEqual(candles.length, 1);
    const [ts, open, high, low, close, volume] = candles[0];
    
    // orientation: base=BTS(assetB), quote=XRP(assetA)
    // ratio = base/quote = 1.0 / 2.0 = 0.5 BTS per XRP
    assert.strictEqual(open, 0.5, 'Open ratio should be calculated correctly from strings');
    assert.strictEqual(volume, 10, 'Volume should be normalized to assetA (quote in this case, 100000/10^4 = 10)');
}

/**
 * 3. Test handle for 10-digit epoch seconds from alternative nodes
 * Some plugins or middleware might return 10-digit epoch.
 */
{
    console.log('  Testing 10-digit epoch second normalization...');
    const history = [{
        key: {
            base: '1.3.0',
            quote: '1.3.1',
            open: 1778330400 // Sat May 09 2026 10:00:00 UTC
        },
        open_base: 100000,
        open_quote: 20000,
        high_base: 100000,
        high_quote: 20000,
        low_base: 100000,
        low_quote: 20000,
        close_base: 100000,
        close_quote: 20000,
        base_volume: 100000,
        quote_volume: 20000
    }];
    const assetA = { id: '1.3.1', precision: 4 };
    const assetB = { id: '1.3.0', precision: 5 };
    
    const candles = normalizeNativeMarketHistoryCandles(history, assetA, assetB);
    assert.strictEqual(candles[0][0], 1778330400000, '10-digit epoch should be converted to ms');
}

/**
 * 4. Test Zero Volume / Invalid Ratio handling
 */
{
    console.log('  Testing zero-volume and invalid ratio skipping...');
    const assetA = { id: '1.3.1', precision: 4 };
    const assetB = { id: '1.3.0', precision: 5 };
    
    const history = [
        {
            key: { base: '1.3.0', quote: '1.3.1', open: '2026-05-09T10:00:00' },
            open_base: '0', // Invalid open
            open_quote: '20000',
            base_volume: '100000',
            quote_volume: '20000'
        },
        {
            key: { base: '1.3.0', quote: '1.3.1', open: '2026-05-09T11:00:00' },
            open_base: '100000',
            open_quote: '20000',
            high_base: '100000',
            high_quote: '20000',
            low_base: '100000',
            low_quote: '20000',
            close_base: '100000',
            close_quote: '20000',
            base_volume: '0', // Zero volume should be kept as 0, but candle should still exist
            quote_volume: '0'
        }
    ];
    
    const candles = normalizeNativeMarketHistoryCandles(history, assetA, assetB);
    assert.strictEqual(candles.length, 1, 'Candle with 0 open_base should be skipped');
    assert.strictEqual(candles[0][5], 0, 'Candle with zero volume should be kept with volume 0');
}

/**
 * 5. Test nativeHistoryRowToTrade logic simulation (BitShares Core 7.0.x structure)
 * This simulates how the row-to-trade extraction works in market_adapter.js
 */
{
    console.log('  Testing liquidity_pool_history row extraction...');
    
    // Simulate parseChainTimeToMs as it is in market_adapter.ts
    const parseChainTimeToMs = (timeStr) => {
        if (!timeStr) return Number.NaN;
        const s = String(timeStr);
        return Date.parse(s.endsWith('Z') ? s : `${s}Z`);
    };

    const row = {
        time: '2026-05-09T12:00:00',
        sequence: '12345',
        op: {
            op: [63, {
                amount_to_sell: { amount: '10000', asset_id: '1.3.1' },
                min_to_receive: { amount: '40000', asset_id: '1.3.0' }
            }],
            result: [2, {
                received: [{ amount: '45000', asset_id: '1.3.0' }]
            }],
            block_time: '2026-05-09T12:00:00'
        }
    };

    // Manual extraction logic matching market_adapter.js
    const tsMs = parseChainTimeToMs(row?.time || row?.op?.block_time);
    const opPayload = Array.isArray(row?.op?.op) ? row.op.op[1] : null;
    const resultPayload = Array.isArray(row?.op?.result) ? row.op.result[1] : null;
    const received = Array.isArray((resultPayload as any)?.received)
        ? (resultPayload as any).received[0]
        : ((resultPayload as any)?.received || null);

    assert.strictEqual(tsMs, Date.UTC(2026, 4, 9, 12, 0, 0), 'Row timestamp should be parsed as UTC');
    assert.strictEqual((opPayload as any)?.amount_to_sell?.amount, '10000', 'Sell amount should be extracted');
    assert.strictEqual(received?.amount, '45000', 'Received amount should be extracted from result payload');
}

console.log('All integration core tests passed!');
process.exit(0);

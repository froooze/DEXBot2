const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running kibana candle tests');

const {
    buildDirectionalDocumentQuery,
    fetchKibanaCandles,
    resolveRequestedFillRange,
    __test: { sourceFieldsForFieldMap },
} = require('../market_adapter/core/kibana_candles');

const FIELD_MAP = {
    soldAssetField: 'operation_history.op_object.amount_to_sell.asset_id.keyword',
    receivedAssetField: 'operation_history.op_object.min_to_receive.asset_id.keyword',
    soldAmountField: 'operation_history.op_object.amount_to_sell.amount',
    receivedAmountField: 'operation_history.operation_result_object.data_object.received.amount',
    poolField: 'operation_history.op_object.pool.keyword',
    operationIdField: 'account_history.operation_id',
};

const ASSET_A = { id: '1.3.1', precision: 0, symbol: 'A' };
const ASSET_B = { id: '1.3.2', precision: 0, symbol: 'B' };

function hit({ id, ts, soldAssetId, receivedAssetId, soldAmount, receivedAmount, poolId = '1.19.1', opId, receivedAsArray = false }) {
    const seq = Number(String(opId || id).match(/(\d+)$/)?.[1] || 0);
    return {
        _id: id,
        sort: [new Date(ts).toISOString(), seq],
        _source: {
            operation_id_num: seq,
            account_history: {
                operation_id: opId || id,
            },
            block_data: { block_time: new Date(ts).toISOString() },
            operation_history: {
                op_object: {
                    pool: poolId,
                    amount_to_sell: {
                        asset_id: soldAssetId,
                        amount: soldAmount,
                    },
                    min_to_receive: {
                        asset_id: receivedAssetId,
                    },
                },
                operation_result_object: {
                    data_object: {
                        received: receivedAsArray
                            ? [{ amount: receivedAmount, asset_id: receivedAssetId }]
                            : { amount: receivedAmount },
                    },
                },
            },
        },
    };
}

function kibanaHits(hits) {
    return {
        hits: { hits },
    };
}

function soldAssetFromQuery(query) {
    return query.query.bool.filter.find((f) => f.term?.[FIELD_MAP.soldAssetField])?.term?.[FIELD_MAP.soldAssetField];
}

async function testTimeRangeControlsRequestedFillRange() {
    const hour = 3600000;
    const start = Date.parse('2026-04-28T00:10:00Z');
    const end = Date.parse('2026-04-28T03:59:59Z');

    const range = resolveRequestedFillRange({
        intervalSeconds: 3600,
        timeRange: {
            gte: new Date(start).toISOString(),
            lte: new Date(end).toISOString(),
        },
    });

    assert.deepStrictEqual(
        range,
        {
            startTs: Date.parse('2026-04-28T00:00:00Z'),
            endTs: Date.parse('2026-04-28T03:00:00Z'),
        },
        'explicit timeRange should define the fill range instead of falling back to now-lookback'
    );

    const calls = [];
    const candles = await fetchKibanaCandles({
        opType: 63,
        fieldMap: FIELD_MAP,
        assetA: ASSET_A,
        assetB: ASSET_B,
        poolId: '1.19.1',
        config: {
            intervalSeconds: 3600,
            timeRange: {
                gte: new Date(start).toISOString(),
                lte: new Date(end).toISOString(),
            },
            kibanaSearch: async (_cfg, query) => {
                calls.push(query);
                return soldAssetFromQuery(query) === ASSET_A.id
                    ? kibanaHits([hit({
                        id: '1.11.1',
                        opId: '1.11.1',
                        ts: Date.parse('2026-04-28T02:00:00Z'),
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 10,
                        receivedAmount: 20,
                    })])
                    : kibanaHits([]);
            },
        },
    });

    assert.strictEqual(calls.length, 2, 'both directions should still be queried');
    assert.deepStrictEqual(
        candles.map((c) => c[0]),
        [
            Date.parse('2026-04-28T02:00:00Z'),
            Date.parse('2026-04-28T03:00:00Z'),
        ],
        'timeRange fill should skip leading gaps if no baseline, but still fill trailing gaps'
    );
    assert.strictEqual(candles[0][4], 2, 'first known candle retains its close');
    assert.strictEqual(candles[1][4], 2, 'range-tail fills retain the last known close');
    assert.strictEqual(candles.length, 2, 'filled span should only start from the first known trade');
}

async function testLiveAdapterCanDisableRequestedRangeFill() {
    const candles = await fetchKibanaCandles({
        opType: 63,
        fieldMap: FIELD_MAP,
        assetA: ASSET_A,
        assetB: ASSET_B,
        poolId: '1.19.1',
        config: {
            intervalSeconds: 3600,
            lookbackHours: 720,
            fillGapsToRequestedRange: false,
            kibanaSearch: async (_cfg, query) => {
                return soldAssetFromQuery(query) === ASSET_A.id
                    ? kibanaHits([hit({
                        id: '1.11.1',
                        opId: '1.11.1',
                        ts: Date.parse('2026-04-01T00:00:00Z'),
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 10,
                        receivedAmount: 20,
                    })])
                    : kibanaHits([]);
            },
        },
    });

    assert.deepStrictEqual(
        candles.map((c) => c[0]),
        [Date.parse('2026-04-01T00:00:00Z')],
        'live adapter mode should not synthesize a stale tail from the last Kibana bucket to now'
    );
}

async function testKibanaBuildsTrueOhlcFromTradeDocuments() {
    const bucketTs = Date.parse('2026-04-28T02:00:00Z');
    const candles = await fetchKibanaCandles({
        opType: 63,
        fieldMap: FIELD_MAP,
        assetA: ASSET_A,
        assetB: ASSET_B,
        poolId: '1.19.1',
        config: {
            intervalSeconds: 3600,
            fillGaps: false,
            kibanaSearch: async (_cfg, query) => {
                if (soldAssetFromQuery(query) !== ASSET_A.id) return kibanaHits([]);
                return kibanaHits([
                    hit({
                        id: '1.11.10',
                        opId: '1.11.10',
                        ts: bucketTs + 1000,
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 10,
                        receivedAmount: 20,
                        receivedAsArray: true,
                    }),
                    hit({
                        id: '1.11.11',
                        opId: '1.11.11',
                        ts: bucketTs + 2000,
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 10,
                        receivedAmount: 40,
                        receivedAsArray: true,
                    }),
                    hit({
                        id: '1.11.12',
                        opId: '1.11.12',
                        ts: bucketTs + 3000,
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 10,
                        receivedAmount: 30,
                        receivedAsArray: true,
                    }),
                ]);
            },
        },
    });

    assert.deepStrictEqual(
        candles,
        [[bucketTs, 2, 4, 2, 3, 30]],
        'Kibana candles should use true document-level OHLC from trade documents'
    );
}

function testDirectionalDocumentQueryDisablesTotalHitCounting() {
    const query = buildDirectionalDocumentQuery({
        opType: 63,
        soldAssetField: FIELD_MAP.soldAssetField,
        receivedAssetField: FIELD_MAP.receivedAssetField,
        poolField: FIELD_MAP.poolField,
        soldAssetId: ASSET_A.id,
        receivedAssetId: ASSET_B.id,
        lookbackHours: 24,
        poolId: '1.19.1',
        timeRange: null,
        size: 1000,
    });

    assert.strictEqual(query.track_total_hits, false, 'paginated kibana scans should not ask Elasticsearch for exact total hit counts');
}

async function testFetchKibanaCandlesForwardsAbortSignal() {
    const controller = new AbortController();
    const seenSignals = [];

    await fetchKibanaCandles({
        opType: 63,
        fieldMap: FIELD_MAP,
        assetA: ASSET_A,
        assetB: ASSET_B,
        poolId: '1.19.1',
        config: {
            intervalSeconds: 3600,
            fillGaps: false,
            signal: controller.signal,
            kibanaSearch: async (cfg) => {
                seenSignals.push(cfg.signal);
                return kibanaHits([]);
            },
        },
    });

    assert.strictEqual(seenSignals.length, 2, 'both directions should receive the shared search signal');
    assert.ok(seenSignals.every((signal) => signal === controller.signal), 'fetchKibanaCandles should forward the same abort signal to each paginated search');
}

function testSourceFieldsForFieldMap() {
    const fields = sourceFieldsForFieldMap(FIELD_MAP);

    assert.ok(
        fields.includes('block_data.block_time'),
        'source projection must always include the block timestamp'
    );
    assert.ok(
        fields.includes('operation_id_num'),
        'source projection must always include the top-level sort/sequence field'
    );
    assert.ok(
        fields.includes('operation_history.op_object.amount_to_sell'),
        'source projection must include the sold-amount branch from the field map'
    );
    assert.ok(
        fields.includes('operation_history.operation_result_object.data_object'),
        'source projection must include the received-amount branch from the field map'
    );
    assert.ok(
        fields.every((f) => !f.endsWith('.keyword')),
        'source projection should not carry .keyword suffixes (those are query-time only)'
    );

    const fillFields = sourceFieldsForFieldMap({
        soldAssetField: 'operation_history.op_object.pays.asset_id.keyword',
        receivedAssetField: 'operation_history.op_object.receives.asset_id.keyword',
        soldAmountField: 'operation_history.op_object.pays.amount',
        receivedAmountField: 'operation_history.op_object.receives.amount',
    });
    assert.ok(
        fillFields.includes('operation_history.op_object.pays'),
        'fill_order field map should project the pays branch'
    );
    assert.ok(
        fillFields.includes('operation_history.op_object.receives'),
        'fill_order field map should project the receives branch'
    );
}

function testDirectionalDocumentQueryUsesSourceProjection() {
    const sourceFields = sourceFieldsForFieldMap(FIELD_MAP);
    const query = buildDirectionalDocumentQuery({
        opType: 63,
        soldAssetField: FIELD_MAP.soldAssetField,
        receivedAssetField: FIELD_MAP.receivedAssetField,
        poolField: FIELD_MAP.poolField,
        soldAssetId: ASSET_A.id,
        receivedAssetId: ASSET_B.id,
        lookbackHours: 24,
        poolId: '1.19.1',
        timeRange: null,
        size: 1000,
        sourceFields,
    });

    assert.deepStrictEqual(
        query._source,
        sourceFields,
        'paginated queries should request only the projected _source fields'
    );

    const legacy = buildDirectionalDocumentQuery({
        opType: 63,
        soldAssetField: FIELD_MAP.soldAssetField,
        receivedAssetField: FIELD_MAP.receivedAssetField,
        poolField: FIELD_MAP.poolField,
        soldAssetId: ASSET_A.id,
        receivedAssetId: ASSET_B.id,
        lookbackHours: 24,
        poolId: '1.19.1',
        timeRange: null,
        size: 1000,
    });
    assert.strictEqual(legacy._source, true, 'omitting sourceFields keeps the legacy full _source behavior');
}

async function testTransientPageErrorsAreRetried() {
    let aDirectionAttempts = 0;

    const candles = await fetchKibanaCandles({
        opType: 63,
        fieldMap: FIELD_MAP,
        assetA: ASSET_A,
        assetB: ASSET_B,
        poolId: '1.19.1',
        config: {
            intervalSeconds: 3600,
            fillGaps: false,
            kibanaRetryDelayMs: 1,
            kibanaSearch: async (_cfg, query) => {
                if (soldAssetFromQuery(query) !== ASSET_A.id) return kibanaHits([]);
                aDirectionAttempts++;
                if (aDirectionAttempts <= 3) {
                    // First three attempts die mid-transfer like a proxy
                    // connection reset; the four-attempt budget should
                    // recover the page.
                    throw new Error('Kibana response aborted (connection reset mid-transfer)');
                }
                return kibanaHits([hit({
                    id: '1.11.1',
                    opId: '1.11.1',
                    ts: Date.parse('2026-04-28T02:00:00Z'),
                    soldAssetId: ASSET_A.id,
                    receivedAssetId: ASSET_B.id,
                    soldAmount: 10,
                    receivedAmount: 20,
                })]);
            },
        },
    });

    assert.strictEqual(candles.length, 1, 'a recovered page should still produce its candle');
    assert.strictEqual(
        aDirectionAttempts,
        4,
        'transient aborts should be retried until the page succeeds (3 failures + 1 success within the 4-attempt budget)'
    );
}

function captureWarns() {
    const original = console.warn;
    const messages: string[] = [];
    console.warn = (...args: any[]) => {
        messages.push(args.map(String).join(' '));
    };
    return {
        messages,
        restore() { console.warn = original; },
    };
}

async function testPartialDirectionFailureKeepsSurvivingSide() {
    const capture = captureWarns();
    try {
        const candles = await fetchKibanaCandles({
            opType: 63,
            fieldMap: FIELD_MAP,
            assetA: ASSET_A,
            assetB: ASSET_B,
            poolId: '1.19.1',
            config: {
                intervalSeconds: 3600,
                fillGaps: false,
                kibanaSearch: async (_cfg: any, query: any) => {
                    if (soldAssetFromQuery(query) !== ASSET_A.id) {
                        throw new Error('proxy reset after all retries');
                    }
                    return kibanaHits([hit({
                        id: '1.11.1',
                        opId: '1.11.1',
                        ts: Date.parse('2026-04-28T02:00:00Z'),
                        soldAssetId: ASSET_A.id,
                        receivedAssetId: ASSET_B.id,
                        soldAmount: 10,
                        receivedAmount: 20,
                    })]);
                },
            },
        });

        assert.strictEqual(candles.length, 1, 'surviving direction should still produce its candle');
        assert.strictEqual(candles[0][4], 2, 'surviving candle keeps its close');
        assert.ok(
            capture.messages.some((m) => m.includes('partial fetch')),
            'a one-direction failure should warn instead of failing silently'
        );
    } finally {
        capture.restore();
    }
}

async function testBothDirectionsFailingStillThrows() {
    await assert.rejects(
        () => fetchKibanaCandles({
            opType: 63,
            fieldMap: FIELD_MAP,
            assetA: ASSET_A,
            assetB: ASSET_B,
            poolId: '1.19.1',
            config: {
                intervalSeconds: 3600,
                fillGaps: false,
                kibanaSearch: async () => {
                    throw new Error('kibana down');
                },
            },
        }),
        /both directions/,
        'a both-directions failure must still throw'
    );
}

async function testMaxPagesGuardThrows() {
    const twoHits = () => kibanaHits([
        hit({
            id: '1.11.1',
            opId: '1.11.1',
            ts: Date.parse('2026-04-28T02:00:00Z'),
            soldAssetId: ASSET_A.id,
            receivedAssetId: ASSET_B.id,
            soldAmount: 10,
            receivedAmount: 20,
        }),
        hit({
            id: '1.11.2',
            opId: '1.11.2',
            ts: Date.parse('2026-04-28T02:30:00Z'),
            soldAssetId: ASSET_A.id,
            receivedAssetId: ASSET_B.id,
            soldAmount: 10,
            receivedAmount: 30,
        }),
    ]);
    await assert.rejects(
        () => fetchKibanaCandles({
            opType: 63,
            fieldMap: FIELD_MAP,
            assetA: ASSET_A,
            assetB: ASSET_B,
            poolId: '1.19.1',
            config: {
                intervalSeconds: 3600,
                fillGaps: false,
                kibanaPageSize: 2,
                kibanaMaxPages: 1,
                kibanaSearch: async () => twoHits(),
            },
        }),
        /kibanaMaxPages/,
        'a stuck cursor should trip the page budget instead of paging forever'
    );
}

async function testDroppedDocumentsWarn() {
    const capture = captureWarns();
    try {
        const candles = await fetchKibanaCandles({
            opType: 63,
            fieldMap: FIELD_MAP,
            assetA: ASSET_A,
            assetB: ASSET_B,
            poolId: '1.19.1',
            config: {
                intervalSeconds: 3600,
                fillGaps: false,
                kibanaSearch: async (_cfg: any, query: any) => {
                    if (soldAssetFromQuery(query) !== ASSET_A.id) return kibanaHits([]);
                    return kibanaHits([
                        hit({
                            id: '1.11.1',
                            opId: '1.11.1',
                            ts: Date.parse('2026-04-28T02:00:00Z'),
                            soldAssetId: ASSET_A.id,
                            receivedAssetId: ASSET_B.id,
                            soldAmount: 10,
                            receivedAmount: 20,
                        }),
                        hit({
                            id: '1.11.2',
                            opId: '1.11.2',
                            ts: Date.parse('2026-04-28T02:30:00Z'),
                            soldAssetId: ASSET_A.id,
                            receivedAssetId: ASSET_B.id,
                            soldAmount: 0,
                            receivedAmount: 30,
                        }),
                    ]);
                },
            },
        });

        assert.strictEqual(candles.length, 1, 'the parseable trade should still produce its candle');
        assert.ok(
            capture.messages.some((m) => m.includes('skipped 1 unparseable')),
            'skipped documents should be reported on the terminal'
        );
    } finally {
        capture.restore();
    }
}

async function run() {
    await testTimeRangeControlsRequestedFillRange();
    await testLiveAdapterCanDisableRequestedRangeFill();
    await testKibanaBuildsTrueOhlcFromTradeDocuments();
    testDirectionalDocumentQueryDisablesTotalHitCounting();
    await testFetchKibanaCandlesForwardsAbortSignal();
    testSourceFieldsForFieldMap();
    testDirectionalDocumentQueryUsesSourceProjection();
    await testTransientPageErrorsAreRetried();
    await testPartialDirectionFailureKeepsSurvivingSide();
    await testBothDirectionsFailingStillThrows();
    await testMaxPagesGuardThrows();
    await testDroppedDocumentsWarn();
}

run()
    .then(() => {
        console.log('kibana candle tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });

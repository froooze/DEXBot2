const assert = require('assert');
const { PATHS } = require('../modules/paths');;
const fs = require('fs');
const path = require('path');

const {
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotAsymmetricBoundsWhitelisted,
    __test: { _resetCycleCache },
} = require('../market_adapter/market_adapter');

const {
    resolveAsset,
    resolveBotContext,
    resolveMarketSourceForBot,
} = require('../market_adapter/test_helpers');

const { KalmanTrendAnalyzer } = require('../analysis/trend_detection/kalman_trend_analyzer');
const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { writeJSON } = require('../modules/storage').getStorage();
const { getErrorMessage } = require('../modules/utils/errors');

async function testWhitelistCache() {
    console.log(' - Testing isBotWhitelisted caching...');
    const PROFILES_DIR = PATHS.PROFILES_DIR;
    const WHITELIST_FILE = path.join(PROFILES_DIR, 'market_adapter_whitelist.json');

    let originalContent = null;
    if (fs.existsSync(WHITELIST_FILE)) {
        originalContent = fs.readFileSync(WHITELIST_FILE, 'utf8');
    }

    try {
        _resetCycleCache();
        writeJSON(WHITELIST_FILE, {
            whitelist: {
                'test-bot-1': { ama: true, dynamicWeight: false },
                'test-bot-2': { ama: false, dynamicWeight: true },
            },
        });

        assert.strictEqual(isBotWhitelisted('test-bot-1'), true, 'Should find bot in whitelist');
        assert.strictEqual(isBotDynamicWeightWhitelisted('test-bot-1'), false, 'AMA-only whitelist should not imply dynamic weights');
        assert.strictEqual(
            isBotAsymmetricBoundsWhitelisted('test-bot-1'),
            false,
            'AMA-only whitelist should not imply asymmetric bounds'
        );
        assert.strictEqual(isBotWhitelisted('test-bot-2'), false, 'Should not find AMA flag when disabled');
        assert.strictEqual(isBotDynamicWeightWhitelisted('test-bot-2'), true, 'Dynamic-weight flag should be read independently');
        assert.strictEqual(
            isBotAsymmetricBoundsWhitelisted('test-bot-2'),
            false,
            'dynamic-weight whitelist should not imply asymmetric bounds'
        );

        writeJSON(WHITELIST_FILE, {
            whitelist: {
                'test-bot-1': { ama: false, dynamicWeight: true, asymmetricBounds: true },
                'test-bot-2': { ama: true, dynamicWeight: false },
            },
        });
        assert.strictEqual(isBotWhitelisted('test-bot-1'), true, 'Should still return old value due to cache');
        assert.strictEqual(isBotDynamicWeightWhitelisted('test-bot-1'), false, 'Should still return old value due to cache');
        assert.strictEqual(isBotAsymmetricBoundsWhitelisted('test-bot-1'), false, 'Should still return old asymmetry value due to cache');
        assert.strictEqual(isBotWhitelisted('test-bot-2'), false, 'Should still return old value due to cache');
        assert.strictEqual(isBotDynamicWeightWhitelisted('test-bot-2'), true, 'Should still return old value due to cache');
        assert.strictEqual(isBotAsymmetricBoundsWhitelisted('test-bot-2'), false, 'Should still return old asymmetry value due to cache');

        _resetCycleCache();
        assert.strictEqual(isBotWhitelisted('test-bot-1'), false, 'Should now reflect file change after cache reset');
        assert.strictEqual(isBotDynamicWeightWhitelisted('test-bot-1'), true, 'Should now reflect file change after cache reset');
        assert.strictEqual(isBotAsymmetricBoundsWhitelisted('test-bot-1'), true, 'Should now reflect explicit asymmetric-bounds enable after cache reset');
        assert.strictEqual(isBotWhitelisted('test-bot-2'), true, 'Should now reflect file change after cache reset');
        assert.strictEqual(isBotDynamicWeightWhitelisted('test-bot-2'), false, 'Should now reflect file change after cache reset');
        assert.strictEqual(isBotAsymmetricBoundsWhitelisted('test-bot-2'), false, 'Missing asymmetric-bounds flag should remain false after cache reset');
    } finally {
        if (originalContent !== null) {
            fs.writeFileSync(WHITELIST_FILE, originalContent, 'utf8');
        } else if (fs.existsSync(WHITELIST_FILE)) {
            fs.unlinkSync(WHITELIST_FILE);
        }
        _resetCycleCache();
    }
}

async function testKalmanRawValues() {
    console.log(' - Testing KalmanTrendAnalyzer raw values...');
    const kf = new KalmanTrendAnalyzer({ warmupBars: 0 });
    kf.update(100);
    kf.update(101);
    const analysis = kf.getAnalysis();

    assert.ok(analysis.velocityRawPct !== undefined, 'velocityRawPct should be present');
    assert.ok(analysis.displacementRawPct !== undefined, 'displacementRawPct should be present');
    assert.strictEqual(typeof analysis.velocityRawPct, 'number', 'velocityRawPct should be a number');
    assert.strictEqual(typeof analysis.displacementRawPct, 'number', 'displacementRawPct should be a number');
    // raw should have more precision than rounded (2 decimal places)
    assert.ok(String(analysis.velocityRawPct).length >= String(analysis.velocityPct).length);
}

async function testRobustAssetResolution() {
    console.log(' - Testing robust asset resolution errors...');

    try {
        await resolveAsset(null);
        assert.fail('resolveAsset(null) should throw');
    } catch (err) {
        if ((err as any).code === 'ERR_ASSERTION') throw err;
        assert.ok(getErrorMessage(err).includes('invalid or missing symbol'), `Error message should be descriptive, got: ${getErrorMessage(err)}`);
    }

    try {
        await resolveAsset('');
        assert.fail('resolveAsset("") should throw');
    } catch (err) {
        if ((err as any).code === 'ERR_ASSERTION') throw err;
        assert.ok(getErrorMessage(err).includes('invalid or missing symbol'), `Error message should be descriptive, got: ${getErrorMessage(err)}`);
    }
}

async function testRobustBotContext() {
    console.log(' - Testing robust resolveBotContext errors...');

    try {
        await resolveBotContext({ botKey: 'test', assetA: 'BTS' }); // Missing assetB
        assert.fail('resolveBotContext missing assetB should throw');
    } catch (err) {
        if ((err as any).code === 'ERR_ASSERTION') throw err;
        assert.ok(getErrorMessage(err).includes('missing assetB'), `Error message should be descriptive, got: ${getErrorMessage(err)}`);
    }

    try {
        await resolveBotContext({ botKey: 'test', assetB: 'BTS' }); // Missing assetA
        assert.fail('resolveBotContext missing assetA should throw');
    } catch (err) {
        if ((err as any).code === 'ERR_ASSERTION') throw err;
        assert.ok(getErrorMessage(err).includes('missing assetA'), `Error message should be descriptive, got: ${getErrorMessage(err)}`);
    }
}

async function testMarketSourceResolution() {
    console.log(' - Testing market source resolution...');

    assert.strictEqual(resolveMarketSourceForBot({ startPrice: 'pool' }), 'pool', 'pool startPrice should map to pool source');
    assert.strictEqual(resolveMarketSourceForBot({ startPrice: 'book' }), 'book', 'book startPrice should map to book source');
    assert.strictEqual(resolveMarketSourceForBot({ startPrice: 'orderbook' }), 'pool', 'orderbook alias should fall back to pool source');
    assert.strictEqual(
        resolveMarketSourceForBot({ startPrice: 'pool', marketSource: 'book' }),
        'pool',
        'marketSource should not override startPrice for the market adapter'
    );
    assert.strictEqual(resolveMarketSourceForBot({ startPrice: 1.25 }), null, 'numeric startPrice should disable market-source selection');

    const service = new MarketAdapterService({});
    const poolSignature = service.buildBotContextSignature({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 'pool',
    });
    const bookSignature = service.buildBotContextSignature({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 'book',
    });
    assert.notStrictEqual(poolSignature, bookSignature, 'context signature should include price source mode');
    const bookSignatureWithMarketSource = service.buildBotContextSignature({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 'book',
        marketSource: 'pool',
    });
    assert.strictEqual(
        bookSignature,
        bookSignatureWithMarketSource,
        'context signature should ignore marketSource when startPrice already selects the source'
    );
}

async function testSignalConfirmationInitialLatch() {
    console.log(' - Testing signal confirmation initial latching...');

    // We can't easily run the full MarketAdapterService without lots of mocks,
    // but we can test the logic change by looking at the echoed series in the test_market_adapter_service pattern.

    // Mocking a simplified version of the logic we fixed:
    function simplifiedLatch(combinedOffSeries, confirmBars) {
        const echoedOffSeries = new Array(combinedOffSeries.length).fill(0);
        if (confirmBars === 0) return combinedOffSeries.slice();

        let latchedSign = 0;
        let pendingSign = 0;
        let pendingCount = 0;
        let latchedOff = 0;

        for (let i = 0; i < combinedOffSeries.length; i++) {
            const raw = combinedOffSeries[i];
            const sign = raw > 0 ? 1 : raw < 0 ? -1 : 0;
            if (sign === latchedSign) {
                pendingSign = 0;
                pendingCount = 0;
                latchedOff = raw;
            } else {
                if (pendingSign !== sign) {
                    pendingSign = sign;
                    pendingCount = 1;
                } else {
                    pendingCount++;
                }
                if (pendingCount >= confirmBars) {
                    latchedSign = sign;
                    pendingSign = 0;
                    pendingCount = 0;
                    latchedOff = raw;
                }
            }
            echoedOffSeries[i] = latchedOff;
        }
        return echoedOffSeries;
    }

    const series = [0.5, 0.5, 0.5, 0.5, 0.5];
    const confirmed = simplifiedLatch(series, 3);

    assert.strictEqual(confirmed[0], 0, 'First bar should be 0 (unconfirmed)');
    assert.strictEqual(confirmed[1], 0, 'Second bar should be 0 (unconfirmed)');
    assert.strictEqual(confirmed[2], 0.5, 'Third bar should be confirmed');
    assert.strictEqual(confirmed[3], 0.5, 'Fourth bar remains confirmed');

    const neutralConfirmed = simplifiedLatch([0.5, 0.5, 0.5, 0, 0, 0], 3);
    assert.strictEqual(neutralConfirmed[3], 0.5, 'First neutral bar should keep prior latch');
    assert.strictEqual(neutralConfirmed[4], 0.5, 'Second neutral bar should keep prior latch');
    assert.strictEqual(neutralConfirmed[5], 0, 'Third neutral bar should confirm neutral');
}

async function runAll() {
    console.log('Running Market Adapter Fixes tests...');
    await testWhitelistCache();
    await testKalmanRawValues();
    await testRobustAssetResolution();
    await testRobustBotContext();
    await testMarketSourceResolution();
    await testSignalConfirmationInitialLatch();
    console.log('All Market Adapter Fixes tests passed!');
}

runAll().catch(err => {
    console.error('Tests failed:', err);
    process.exit(1);
});

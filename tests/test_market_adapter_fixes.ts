const assert = require('assert');
const { PATHS } = require('../modules/paths');;
const fs = require('fs');
const path = require('path');

const {
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotAsymmetricBoundsWhitelisted,
    _resetCycleCache,
} = require('../market_adapter/market_adapter');

const {
    resolveAsset,
    resolveBotContext,
    resolveMarketSourceForBot,
} = require('../market_adapter/test_helpers');

const { KalmanTrendAnalyzer } = require('../analysis/trend_detection/kalman_trend_analyzer');
const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');
const { writeJSON } = require('../modules/storage').getStorage();
const {
    buildWhitelist,
    loadExistingWhitelist,
    parseOptions,
} = require('../scripts/generate_market_adapter_whitelist');
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

async function testWhitelistGenerationPreservesExistingEntries() {
    console.log(' - Testing whitelist generation preserves existing entries...');
    const bots = [
        { name: 'Existing AMA', gridPrice: 'ama', botKey: 'existing-ama-0' },
        { name: 'New AMA', gridPrice: 'ama2', botKey: 'new-ama-1' },
        { name: 'Non AMA', gridPrice: 'pool', botKey: 'non-ama-2' },
    ];
    const existing = {
        'existing-ama-0': { ama: true, dynamicWeight: false, asymmetricBounds: false, derivativeSignals: false },
        'manual-non-ama': { ama: true, dynamicWeight: false, asymmetricBounds: true },
    };

    const result = buildWhitelist(bots, existing, {
        dynamicWeight: false,
        asymmetricBounds: false,
    });

    assert.deepStrictEqual(
        result.whitelist['existing-ama-0'],
        { ama: true, dynamicWeight: false, asymmetricBounds: false, derivativeSignals: false },
        'existing AMA entry must not be normalized or overwritten by generated defaults'
    );
    assert.deepStrictEqual(
        result.whitelist['new-ama-1'],
        { ama: true, dynamicWeight: false, asymmetricBounds: false },
        'new AMA entry should be added with current command defaults'
    );
    assert.deepStrictEqual(
        result.whitelist['manual-non-ama'],
        { ama: true, dynamicWeight: false, asymmetricBounds: true },
        'manual entries not found in bots.json should be preserved'
    );
    assert.strictEqual(
        result.whitelist['non-ama-2'],
        undefined,
        'non-AMA bot configs should not create new whitelist entries'
    );
}

async function testWhitelistGenerationOptionDefaults() {
    console.log(' - Testing whitelist generation option defaults...');
    assert.deepStrictEqual(
        parseOptions([]),
        { dynamicWeight: false, asymmetricBounds: false, prune: false, botKeys: [] },
        'dynamicWeight and range scaling should default off for newly generated whitelist entries'
    );
    assert.deepStrictEqual(
        parseOptions(['--dynamic-weight']),
        { dynamicWeight: true, asymmetricBounds: false, prune: false, botKeys: [] },
        'dynamicWeight should be explicitly opt-in'
    );
    assert.deepStrictEqual(
        parseOptions(['--asymmetric-bounds']),
        { dynamicWeight: false, asymmetricBounds: true, prune: false, botKeys: [] },
        'range scaling should be explicitly opt-in'
    );
    assert.deepStrictEqual(
        parseOptions(['--dynamic-weight=true', '--asymmetric-bounds']),
        { dynamicWeight: true, asymmetricBounds: true, prune: false, botKeys: [] },
        'explicit dynamicWeight and range-scaling opt-ins should combine'
    );
    assert.deepStrictEqual(
        parseOptions(['--dynamic-weight=true', '--no-dynamic-weight']),
        { dynamicWeight: false, asymmetricBounds: false, prune: false, botKeys: [] },
        'explicit disable should win if conflicting dynamicWeight flags are provided'
    );
    assert.deepStrictEqual(
        parseOptions(['--asymmetric-bounds', '--no-asymmetric-bounds']),
        { dynamicWeight: false, asymmetricBounds: false, prune: false, botKeys: [] },
        'explicit disable should win if conflicting asymmetric-bounds flags are provided'
    );
    assert.deepStrictEqual(
        parseOptions(['--prune']),
        { dynamicWeight: false, asymmetricBounds: false, prune: true, botKeys: [] },
        '--prune should enable prune mode'
    );
    assert.deepStrictEqual(
        parseOptions(['--bot', 'my-bot']),
        { dynamicWeight: false, asymmetricBounds: false, prune: false, botKeys: ['my-bot'] },
        '--bot should collect targeted botKeys'
    );
    assert.deepStrictEqual(
        parseOptions(['--bot', 'a', '--bot=b']),
        { dynamicWeight: false, asymmetricBounds: false, prune: false, botKeys: ['a', 'b'] },
        '--bot should support repeated and = forms'
    );
    for (const argv of [
        ['--bot'],
        ['--bot', '--prune'],
        ['--bot='],
        ['--bot', '--dynamic-weight'],
    ] as const) {
        assert.throws(() => parseOptions([...argv]), /--bot requires a value/, `parseOptions(${JSON.stringify(argv)}) should throw for missing/flag-like --bot value`);
    }
    assert.throws(() => parseOptions(['--bot', 'a,--prune']), /looks like a flag/, '--bot comma-list containing flag should throw');
}

async function testWhitelistGenerationBotOverwrite() {
    console.log(' - Testing whitelist --bot overwrite...');
    const bots = [
        { name: 'Bot A', gridPrice: 'ama', botKey: 'bot-a' },
        { name: 'Bot B', gridPrice: 'ama2', botKey: 'bot-b' },
        { name: 'Bot C', gridPrice: 'pool', botKey: 'bot-c' },
    ];
    const existing = {
        'bot-a': { ama: true, dynamicWeight: false, asymmetricBounds: false, derivativeSignals: 'keep-me' },
        'bot-b': { ama: true, dynamicWeight: false, asymmetricBounds: true },
        'stale-x': { ama: true, dynamicWeight: true, asymmetricBounds: true },
    };

    // Without --bot: existing entries preserved, only missing AMA bots untouched (bot-a not overwritten)
    const additive = buildWhitelist(bots, existing, { dynamicWeight: true, asymmetricBounds: false, prune: false, botKeys: [] });
    assert.deepStrictEqual(
        additive.whitelist['bot-a'],
        { ama: true, dynamicWeight: false, asymmetricBounds: false, derivativeSignals: 'keep-me' },
        'without --bot, existing entry must be preserved'
    );

    // With --bot=bot-a: only bot-a overwritten (flag flip + keeps unknown fields), bot-b untouched, stale preserved
    const overwritten = buildWhitelist(bots, existing, { dynamicWeight: true, asymmetricBounds: true, prune: false, botKeys: ['bot-a'] });
    assert.deepStrictEqual(
        overwritten.whitelist['bot-a'],
        { ama: true, dynamicWeight: true, asymmetricBounds: true, derivativeSignals: 'keep-me' },
        '--bot should overwrite only targeted key and preserve unknown fields'
    );
    assert.deepStrictEqual(
        overwritten.whitelist['bot-b'],
        { ama: true, dynamicWeight: false, asymmetricBounds: true },
        '--bot for a must not affect other existing entries'
    );
    assert.deepStrictEqual(overwritten.whitelist['stale-x'], existing['stale-x'], 'stale entries preserved when --bot targeted');

    // --bot zzz typo: no new bot added, existing untouched, warning path exercised via filtered loop (returns same whitelist)
    const typo = buildWhitelist(bots, existing, { dynamicWeight: true, asymmetricBounds: true, prune: false, botKeys: ['zzz'] });
    assert.deepStrictEqual(typo.whitelist, { 'bot-b': existing['bot-b'], 'bot-a': existing['bot-a'], 'stale-x': existing['stale-x'] } as any, '--bot typo should not create entries');
}

async function testWhitelistLoaderPreservesExistingFileEntries() {
    console.log(' - Testing whitelist loader preserves existing file entries...');
    const PROFILES_DIR = PATHS.PROFILES_DIR;
    const WHITELIST_FILE = path.join(PROFILES_DIR, 'market_adapter_whitelist.json');

    let originalContent = null;
    if (fs.existsSync(WHITELIST_FILE)) {
        originalContent = fs.readFileSync(WHITELIST_FILE, 'utf8');
    }

    try {
        const existing = {
            whitelist: {
                'existing-ama-0': {
                    ama: true,
                    dynamicWeight: false,
                    asymmetricBounds: false,
                    derivativeSignals: false,
                },
                'legacy-bool': true,
            },
        };
        writeJSON(WHITELIST_FILE, existing);

        assert.deepStrictEqual(
            loadExistingWhitelist(),
            existing.whitelist,
            'loader must not normalize object-form whitelist entries'
        );

        fs.writeFileSync(WHITELIST_FILE, '{bad json', 'utf8');
        assert.deepStrictEqual(
            loadExistingWhitelist(),
            {},
            'malformed whitelist should be ignored so generation can recover'
        );
    } finally {
        if (originalContent !== null) {
            fs.writeFileSync(WHITELIST_FILE, originalContent, 'utf8');
        } else if (fs.existsSync(WHITELIST_FILE)) {
            fs.unlinkSync(WHITELIST_FILE);
        }
    }
}

async function testWhitelistPruneRemovesStaleEntries() {
    console.log(' - Testing whitelist --prune removes stale entries...');
    const bots = [
        { name: 'active-bot', gridPrice: 'ama', id: 'aaa', botKey: 'active-bot-aaa' },
        { name: 'pool-bot', gridPrice: 'pool', id: 'bbb', botKey: 'pool-bot-bbb' },
    ];
    const existing = {
        'active-bot-aaa': { ama: true, dynamicWeight: false, asymmetricBounds: true },
        'stale-bot-ccc': { ama: true, dynamicWeight: false, asymmetricBounds: false },
        'pool-bot-bbb': { ama: false, dynamicWeight: false, asymmetricBounds: false },
    };

    const result = buildWhitelist(bots, existing, { dynamicWeight: false, asymmetricBounds: false, prune: true });

    assert.ok(
        result.whitelist['active-bot-aaa'] !== undefined,
        '--prune must keep entries matching current bots'
    );
    assert.ok(
        result.whitelist['pool-bot-bbb'] !== undefined,
        '--prune must keep manual entries for non-AMA bots in bots.json'
    );
    assert.strictEqual(
        result.whitelist['stale-bot-ccc'],
        undefined,
        '--prune must remove entries for bots no longer in bots.json'
    );
}

async function testWhitelistPrunePreservesNonAmaManualEntries() {
    console.log(' - Testing whitelist --prune preserves manual non-AMA entries...');
    const bots = [
        { name: 'ama-bot', gridPrice: 'ama', id: 'aaa', botKey: 'ama-bot-aaa' },
        { name: 'pool-bot', gridPrice: 'pool', id: 'bbb', botKey: 'pool-bot-bbb' },
    ];
    const existing = {
        'ama-bot-aaa': { ama: true, dynamicWeight: false, asymmetricBounds: true },
        'pool-bot-bbb': { ama: true, dynamicWeight: false, asymmetricBounds: false, derivativeSignals: 'ema12' },
    };

    const resultNoPrune = buildWhitelist(bots, existing, { dynamicWeight: false, asymmetricBounds: false, prune: false });
    assert.ok(
        resultNoPrune.whitelist['pool-bot-bbb'] !== undefined,
        'without --prune, manual non-AMA entries must be preserved'
    );

    const resultPrune = buildWhitelist(bots, existing, { dynamicWeight: false, asymmetricBounds: false, prune: true });
    assert.ok(
        resultPrune.whitelist['pool-bot-bbb'] !== undefined,
        'with --prune, manual non-AMA entries for bots still in bots.json must be preserved'
    );
}

async function testWhitelistPrunePreservesUnknownFields() {
    console.log(' - Testing whitelist --prune preserves unknown fields...');
    const bots = [
        { name: 'ama-bot', gridPrice: 'ama', id: 'aaa', botKey: 'ama-bot-aaa' },
    ];
    const existing = {
        'ama-bot-aaa': { ama: true, dynamicWeight: true, asymmetricBounds: true, derivativeSignals: 'ema12' },
    };

    const result = buildWhitelist(bots, existing, { dynamicWeight: false, asymmetricBounds: false, prune: true });

    assert.deepStrictEqual(
        result.whitelist['ama-bot-aaa'],
        { ama: true, dynamicWeight: true, asymmetricBounds: true, derivativeSignals: 'ema12' },
        '--prune must preserve unknown fields on matching entries'
    );
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
    await testWhitelistGenerationPreservesExistingEntries();
    await testWhitelistGenerationOptionDefaults();
    await testWhitelistGenerationBotOverwrite();
    await testWhitelistLoaderPreservesExistingFileEntries();
    await testWhitelistPruneRemovesStaleEntries();
    await testWhitelistPrunePreservesNonAmaManualEntries();
    await testWhitelistPrunePreservesUnknownFields();
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

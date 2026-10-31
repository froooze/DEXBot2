'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const {
    generateHTML,
} = require('../market_adapter/lp_chart_core');
const {
    defaultUplotMarketChartPath,
    generateMarketLpChartUplot,
    parseArgs,
} = require('../scripts/generate_lp_chart');
const {
    __test: { DEFAULT_COMPARISON_STRATEGIES },
} = require('../market_adapter/lp_chart_runner');
const {
    DEFAULT_STRATEGIES,
} = require('../analysis/ama_fitting/generate_unified_comparison_chart');
const { MARKET_ADAPTER } = require('../modules/constants');
const { writeJSON } = require('../modules/storage').getStorage();

function testParseArgs() {
    const parsed = parseArgs(['--data', 'foo.json', '--out', 'out.html', '--no-open']);
    assert.strictEqual(parsed.dataFile.endsWith('foo.json'), true);
    assert.strictEqual(parsed.outFile.endsWith('out.html'), true);
    assert.strictEqual(parsed.noOpen, true);
    assert.strictEqual(parsed.help, false);
}

function testGenerateHtml() {
    const html = generateHTML(
        {
            assetA: { symbol: 'XRP' },
            assetB: { symbol: 'BTS' },
            intervalSeconds: 3600,
            fetchedAt: '2026-04-13T00:00:00.000Z',
        },
        [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
            [1710010800000, 1.15, 1.24, 1.05, 1.2, 14],
        ],
        [
            {
                name: 'FAST',
                color: '#26a69a',
                dash: 'dot',
                lineWidth: 2,
                erPeriod: 1,
                fastPeriod: 2,
                slowPeriod: 3,
                values: [1.01, 1.06, 1.12, 1.16],
            },
            {
                name: 'SLOW',
                color: '#fb8c00',
                dash: 'solid',
                lineWidth: 1.5,
                erPeriod: 1,
                fastPeriod: 2,
                slowPeriod: 3,
                values: [1.0, 1.03, 1.08, 1.12],
            },
        ]
    );

    assert.ok(html.includes('leeoniya/uPlot') && !html.includes('../uplot/'), 'uPlot runtime should be inlined, not referenced relatively');
    assert.ok(html.includes('price-chart'));
    assert.ok(html.includes('dev-chart'));
    assert.ok(html.includes('vol-chart'));
    assert.ok(html.includes('AMA Parameters'));
    assert.ok(html.includes('LP Swap Price'));

    const match = html.match(/<script>\s*(const payload =[\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(match, 'expected browser script block');
    new vm.Script(match[1]);
}

function testGenerateMarketLpChartUplot() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot2-lp-uplot-'));
    const dataFile = path.join(tmpDir, 'lp_pool_133_1h.json');
    const outFile = path.join(tmpDir, 'lp_chart.html');
    writeJSON(dataFile, {
        meta: {
            pool: '1.19.133',
            intervalSeconds: 3600,
            fetchedAt: '2026-04-13T00:00:00.000Z',
            assetA: { id: '1.3.3926', symbol: 'IOB.XRP' },
            assetB: { id: '1.3.0', symbol: 'BTS' },
        },
        candles: [
            [1710000000000, 1.00, 1.10, 0.95, 1.02, 10],
            [1710003600000, 1.02, 1.16, 1.00, 1.08, 12],
            [1710007200000, 1.08, 1.20, 1.04, 1.14, 9],
            [1710010800000, 1.14, 1.25, 1.10, 1.19, 14],
            [1710014400000, 1.19, 1.28, 1.15, 1.23, 11],
        ],
    });
    // AMA strategies for the synthetic pair.  The repo has no checked-in
    // market_profiles.json (it is auto-generated on first run), so the test
    // must provide its own profile fixture instead of depending on live
    // profile data that may not exist in a fresh checkout.
    writeJSON(path.join(tmpDir, 'market_profiles.json'), {
        profiles: [
            {
                assetA: 'IOB.XRP',
                assetB: 'BTS',
                assetAId: '1.3.3926',
                assetBId: '1.3.0',
                intervalSeconds: 3600,
                updatedAt: '2026-04-13T00:00:00.000Z',
                amas: {
                    AMA1: { name: 'AMA1', erPeriod: 1, fastPeriod: 2, slowPeriod: 3 },
                    AMA2: { name: 'AMA2', erPeriod: 2, fastPeriod: 4, slowPeriod: 10 },
                    AMA3: { name: 'AMA3', erPeriod: 3, fastPeriod: 8, slowPeriod: 20 },
                    AMA4: { name: 'AMA4', erPeriod: 5, fastPeriod: 16, slowPeriod: 40 },
                },
            },
        ],
    });
    const result = generateMarketLpChartUplot({
        dataFile,
        noOpen: true,
        outFile,
        profilesFile: path.join(tmpDir, 'market_profiles.json'),
        logger: { log() {} },
    });

    assert.strictEqual(fs.existsSync(outFile), true);
    const html = fs.readFileSync(outFile, 'utf8');
    assert.ok(html.includes('leeoniya/uPlot') && !html.includes('../uplot/'), 'uPlot runtime should be inlined, not referenced relatively');
    assert.ok(html.includes('price-chart'));
    const match = html.match(/<script>\s*(const payload =[\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(match, 'expected browser script block');
    new vm.Script(match[1]);
    assert.ok(result.amaResults.length > 0);
    assert.ok(defaultUplotMarketChartPath(result.meta).endsWith('.html'));
}

function assertProductionAmaDefaults(strategies) {
    const expected: any[] = Object.values(MARKET_ADAPTER.AMAS);
    assert.strictEqual(strategies.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
        assert.strictEqual((strategies[i] as any).name, expected[i].name);
        assert.strictEqual((strategies[i] as any).erPeriod, expected[i].erPeriod);
        assert.strictEqual((strategies[i] as any).fastPeriod, expected[i].fastPeriod);
        assert.strictEqual((strategies[i] as any).slowPeriod, expected[i].slowPeriod);
    }
}

function testProductionAmaDefaults() {
    assertProductionAmaDefaults(DEFAULT_COMPARISON_STRATEGIES);
    assertProductionAmaDefaults(DEFAULT_STRATEGIES);
}

function main() {
    testParseArgs();
    testGenerateHtml();
    testGenerateMarketLpChartUplot();
    testProductionAmaDefaults();
    console.log('lp chart tests passed');
}

main();

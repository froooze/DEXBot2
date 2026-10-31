'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ensureDir, unlink: safeUnlink, writeJSON } = require('../modules/storage').getStorage();
const { PATHS } = require('../modules/paths');

// The loader resolves optimizer results against the runtime PROJECT_ROOT and
// latest LP data against the resolved LP data dir — write fixtures there.
const ANALYSIS_AMA_FITTING_DIR = path.join(PATHS.PROJECT_ROOT, 'analysis', 'ama_fitting');
const LP_DATA_DIR = PATHS.MARKET_ADAPTER.LP_DATA_DIR;

const {
    findLatestLpData,
    parseLpChartCliArgs,
} = require('../market_adapter/lp_chart_runner');
const { loadLatestLpSeries, loadLpSeriesFromPath, loadLpSeriesFromBasePath } = require('../market_adapter/utils/data_discovery');
const {
    loadStrategiesForLpChart,
    __test: { loadStrategiesFromProfiles },
} = require('../market_adapter/lp_chart_strategy_loader');

function writeJson(filePath, payload) {
    ensureDir(path.dirname(filePath));
    writeJSON(filePath, payload);
}

function removeFile(filePath) {
    safeUnlink(filePath)
}

// Fixtures are written into the real (gitignored) LP data dir so discovery
// sees them. unlink() leaves the empty per-test directory behind, so a test
// run leaks one dir each time and `findLatestLpData`'s full-tree scan grows.
// Remove the fixture directory itself, but never the shared LP_DATA_DIR.
function removeFixtureDir(filePath) {
    const dir = path.dirname(filePath);
    if (dir === LP_DATA_DIR || !dir.startsWith(`${LP_DATA_DIR}${path.sep}`)) return;
    fs.rmSync(dir, { recursive: true, force: true });
}

function makeAmaConfig(name, erPeriod, fastPeriod, slowPeriod) {
    return { name, erPeriod, fastPeriod, slowPeriod };
}

function testLoaderFindsOptimizerResultsFromAnalysisDir() {
    const suffix = `${Date.now()}-${process.pid}`;
    const dataFile = path.join(
        LP_DATA_DIR,
        `test_pair_${suffix}`,
        `lp_pool_${suffix}_1h.json`
    );
    const resultsFile = path.join(
        ANALYSIS_AMA_FITTING_DIR,
        `optimization_results_lp_pool_${suffix}_1h.json`
    );

    writeJson(dataFile, {
        meta: {
            assetA: { symbol: 'TESTA' },
            assetB: { symbol: 'TESTB' },
            intervalSeconds: 3600,
        },
        candles: [],
    });
    writeJson(resultsFile, {
        meta: {
            amas: {
                AMA1: { label: 'AMA1 Fast', er: 10, fast: 2, slow: 30 },
                AMA2: { label: 'AMA2 Mid', er: 20, fast: 3, slow: 60 },
                AMA3: { label: 'AMA3 Slow', er: 30, fast: 4, slow: 90 },
                AMA4: { label: 'AMA4 Slowest', er: 40, fast: 5, slow: 120 },
            },
        },
    });

    try {
        const strategies = loadStrategiesForLpChart({
            dataFile,
            meta: {
                assetA: { symbol: 'TESTA' },
                assetB: { symbol: 'TESTB' },
                intervalSeconds: 3600,
            },
        });

        assert.ok(Array.isArray(strategies), 'strategies should be loaded from optimizer results');
        assert.strictEqual(strategies.length, 4);
        assert.strictEqual(strategies[0].erPeriod, 10);
        assert.strictEqual(strategies[3].slowPeriod, 120);
    } finally {
        removeFixtureDir(dataFile);
        removeFile(resultsFile);
    }
}

function testProfilesMatchByIntervalLabelFallback() {
    const suffix = `${Date.now()}-${process.pid}`;
    const profilesFile = path.join(__dirname, '..', 'tmp', `lp_chart_profiles_${suffix}.json`);

    writeJson(profilesFile, {
        profiles: [
            {
                assetA: 'TESTA',
                assetB: 'TESTB',
                intervalLabel: '1h',
                updatedAt: '2026-04-12T00:00:00.000Z',
                amas: {
                    AMA1: makeAmaConfig('AMA1', 11, 2, 31),
                    AMA2: makeAmaConfig('AMA2', 22, 3, 62),
                    AMA3: makeAmaConfig('AMA3', 33, 4, 93),
                    AMA4: makeAmaConfig('AMA4', 44, 5, 124),
                },
            },
        ],
    });

    try {
        const strategies = loadStrategiesFromProfiles(profilesFile, {
            assetA: { symbol: 'TESTA' },
            assetB: { symbol: 'TESTB' },
            intervalSeconds: 3600,
        });

        assert.ok(Array.isArray(strategies), 'strategies should load when profile only matches by intervalLabel');
        assert.strictEqual(strategies.length, 4);
        assert.strictEqual(strategies[2].erPeriod, 33);
        assert.strictEqual(strategies[3].slowPeriod, 124);
    } finally {
        removeFile(profilesFile);
    }
}

function testLatestLpDataPrefersNewerFile() {
    const suffix = `${Date.now()}-${process.pid}`;
    const olderFile = path.join(
        LP_DATA_DIR,
        `older_pair_${suffix}`,
        `lp_pool_${suffix}_older.json`
    );
    const dataFile = path.join(
        LP_DATA_DIR,
        `newer_pair_${suffix}`,
        `lp_pool_${suffix}_data.json`
    );
    const shardFile = path.join(
        LP_DATA_DIR,
        `newer_pair_${suffix}`,
        `lp_pool_${suffix}_1h.shard_2026-01.json`
    );
    const chunkFile = path.join(
        LP_DATA_DIR,
        `newer_pair_${suffix}`,
        `lp_pool_${suffix}_1h.chunk_01_2026-01-01_2026-02-01.json`
    );

    writeJson(olderFile, { meta: {}, candles: [] });
    writeJson(dataFile, { meta: {}, candles: [] });
    writeJson(shardFile, { meta: {}, candles: [] });
    writeJson(chunkFile, { meta: {}, candles: [] });

    const now = Date.now();
    fs.utimesSync(olderFile, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(dataFile, new Date(now + 10_000), new Date(now + 10_000));
    // Shards/chunks are slices, not the series, and the active shard is
    // rewritten every run — by mtime they would otherwise always win.
    fs.utimesSync(shardFile, new Date(now + 20_000), new Date(now + 20_000));
    fs.utimesSync(chunkFile, new Date(now + 30_000), new Date(now + 30_000));

    try {
        assert.strictEqual(findLatestLpData(), dataFile,
            'latest LP data must pick the newer whole-history file, ignoring shards/chunks');
    } finally {
        removeFixtureDir(olderFile);
        removeFixtureDir(dataFile);
    }
}

function testLoadLatestLpSeriesAssemblesShardOnlyCache() {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-lp-series-'));
    const pairDir = path.join(dir, 'TESTA_TESTB');
    fs.mkdirSync(pairDir, { recursive: true });
    const meta = {
        pool: '1.19.9',
        intervalSeconds: 3600,
        assetA: { id: '1.3.11', precision: 4, symbol: 'TESTA' },
        assetB: { id: '1.3.12', precision: 5, symbol: 'TESTB' },
    };
    const c1 = [Date.parse('2026-01-01T00:00:00.000Z'), 1, 1, 1, 1, 10];
    const c2 = [Date.parse('2026-02-01T00:00:00.000Z'), 2, 2, 2, 2, 5];
    fs.writeFileSync(path.join(pairDir, 'lp_pool_9_1h.shard_2026-01.json'),
        JSON.stringify({ meta: { ...meta, shard: '2026-01' }, candles: [c1] }));
    fs.writeFileSync(path.join(pairDir, 'lp_pool_9_1h.shard_2026-02.json'),
        JSON.stringify({ meta: { ...meta, shard: '2026-02' }, candles: [c2] }));

    try {
        // Shard-only: path discovery yields nothing, but the series assembles.
        assert.strictEqual(findLatestLpData({ dataDir: dir }), null,
            'path-only discovery must not return a partial shard');
        const series = loadLatestLpSeries({ dataDir: dir });
        assert.ok(series, 'shard-only cache must yield an assembled series');
        assert.strictEqual(series.assembled, true, 'series is flagged as assembled');
        assert.deepStrictEqual(series.candles, [c1, c2], 'candles merge across months in order');
        assert.strictEqual(series.meta.pool, '1.19.9', 'merged meta keeps pool identity');
        assert.strictEqual(series.meta.shard, undefined, 'per-shard meta is dropped');
        assert.strictEqual(series.meta.candleCount, 2, 'merged meta reports the full count');

        // A newer whole-history export wins over shards.
        const whole = path.join(pairDir, 'lp_pool_9_1h.json');
        const c3 = [Date.parse('2026-03-01T00:00:00.000Z'), 3, 3, 3, 3, 1];
        fs.writeFileSync(whole, JSON.stringify({ meta, candles: [c1, c2, c3] }));
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(whole, future, future);
        const wholeSeries = loadLatestLpSeries({ dataDir: dir });
        assert.strictEqual(wholeSeries.assembled, false, 'a newer whole-history export is preferred');
        assert.strictEqual(wholeSeries.candles.length, 3, 'whole-history export is returned intact');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function testParseLpChartCliArgsSupportsWrapperModes() {
    const scriptArgs = parseLpChartCliArgs(['--data', 'market_adapter/data/example.json', '--no-open'], {
        dataFlags: ['--data', '--file'],
    });
    assert.ok(scriptArgs.dataFile.endsWith(path.join('market_adapter', 'data', 'example.json')));
    assert.strictEqual(scriptArgs.noOpen, true);

    const marketArgs = parseLpChartCliArgs(['--file', 'market_adapter/data/example.json'], {
        dataFlags: ['--file'],
    });
    assert.ok(marketArgs.dataFile.endsWith(path.join('market_adapter', 'data', 'example.json')));
    assert.strictEqual(marketArgs.noOpen, false);

    const analysisArgs = parseLpChartCliArgs(['--data', 'market_adapter/data/example.json', 'ignored.json'], {
        dataFlags: ['--data'],
        allowPositional: false,
    });
    assert.ok(analysisArgs.dataFile.endsWith(path.join('market_adapter', 'data', 'example.json')));
    assert.strictEqual(analysisArgs.noOpen, false);
}

function testShardAwareExplicitPathAssembly() {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-lp-path-'));
    const pairDir = path.join(dir, 'TESTA_TESTB');
    fs.mkdirSync(pairDir, { recursive: true });
    const meta = {
        pool: '1.19.9',
        intervalSeconds: 3600,
        assetA: { id: '1.3.11', precision: 4, symbol: 'TESTA' },
        assetB: { id: '1.3.12', precision: 5, symbol: 'TESTB' },
    };
    const c1 = [Date.parse('2026-01-01T00:00:00.000Z'), 1, 1, 1, 1, 10];
    const c2 = [Date.parse('2026-02-01T00:00:00.000Z'), 2, 2, 2, 2, 5];
    const shard1 = path.join(pairDir, 'lp_pool_9_1h.shard_2026-01.json');
    const shard2 = path.join(pairDir, 'lp_pool_9_1h.shard_2026-02.json');
    const base = path.join(pairDir, 'lp_pool_9_1h.json');
    fs.writeFileSync(shard1, JSON.stringify({ meta: { ...meta, shard: '2026-01' }, candles: [c1] }));
    fs.writeFileSync(shard2, JSON.stringify({ meta: { ...meta, shard: '2026-02' }, candles: [c2] }));

    try {
        // Pointing --data at ONE shard must chart the whole family, not a month.
        const fromShard = loadLpSeriesFromPath(shard1);
        assert.ok(fromShard, 'explicit shard path must load');
        assert.strictEqual(fromShard.assembled, true, 'explicit shard path is assembled');
        assert.strictEqual(fromShard.candles.length, 2, 'explicit shard path merges its family');
        assert.strictEqual(fromShard.meta.shard, undefined, 'assembled meta drops per-shard fields');

        // Base-path assembly works with no whole-history export on disk.
        const fromBase = loadLpSeriesFromBasePath(base);
        assert.ok(fromBase && fromBase.assembled === true && fromBase.candles.length === 2,
            'base-path assembly reads the shard family with no export present');

        // The derived export lives at the base path: a later write there must
        // not change how the series is read when shards exist.
        fs.writeFileSync(base, JSON.stringify({ meta, candles: [c1] }));
        const fromBaseWithPartialExport = loadLpSeriesFromBasePath(base);
        assert.strictEqual(fromBaseWithPartialExport.candles.length, 2,
            'derived export ignores a narrower sibling export');

        // A non-shard path with no family is read literally.
        const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-lp-plain-'));
        const plain = path.join(plainDir, 'lp_pool_9_1h.json');
        fs.writeFileSync(plain, JSON.stringify({ meta, candles: [c1, c2] }));
        const fromPlain = loadLpSeriesFromPath(plain);
        assert.ok(fromPlain && fromPlain.assembled === false, 'non-shard path reads as-is');
        assert.strictEqual(fromPlain.candles.length, 2, 'non-shard path keeps its candles');
        fs.rmSync(plainDir, { recursive: true, force: true });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function main() {
    testLoaderFindsOptimizerResultsFromAnalysisDir();
    testProfilesMatchByIntervalLabelFallback();
    testLatestLpDataPrefersNewerFile();
    testLoadLatestLpSeriesAssemblesShardOnlyCache();
    testShardAwareExplicitPathAssembly();
    testParseLpChartCliArgsSupportsWrapperModes();
    console.log('lp chart strategy loader tests passed');
}

main();

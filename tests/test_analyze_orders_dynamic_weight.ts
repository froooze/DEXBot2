'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The analyzer reads bots.json at module load. Point the profile root at a temp
// fixture so the test does not depend on the machine's repo/home profiles.
const TEST_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-analyze-dw-'));
process.env.DEXBOT_PROFILE_ROOT = TEST_PROFILE_ROOT;
fs.writeFileSync(path.join(TEST_PROFILE_ROOT, 'bots.json'), JSON.stringify({ bots: [] }));

const { Config } = require('../modules/config');

const { ensureDir, writeJSON } = require('../modules/storage').getStorage();
const { PATHS } = require('../modules/paths');
const ORDERS_DIR = PATHS.ORDERS_DIR;
const ANALYZER_PATH = path.resolve(__dirname, '..', 'scripts', 'analyze-orders.js');
const { resetMarketAdapterWhitelistCache } = require('../modules/market_adapter_whitelist');
const TEST_WHITELIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-analyze-whitelist-'));
const TEST_WHITELIST_PATH = path.join(TEST_WHITELIST_DIR, 'market_adapter_whitelist.json');

function loadAnalyzer() {
  delete require.cache[ANALYZER_PATH];
  // The analyzer is compiled to dist by the build; require() loads the
  // compiled .js module directly.
  return require(ANALYZER_PATH);
}

function stripColorCodes(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

function writeSnapshot(botKey, payload) {
  const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
  ensureDir(path.dirname(filePath));
  writeJSON(filePath, payload);
  return filePath;
}

function removeSnapshot(botKey) {
  const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function withWhitelist(entries, fn) {
  const originalEnv = process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE;
  const originalConfigWhitelist = Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE;
  writeJSON(TEST_WHITELIST_PATH, { whitelist: entries });
  process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = TEST_WHITELIST_PATH;
  Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = TEST_WHITELIST_PATH;
  // The whitelist module caches per load; reset so the override file is
  // re-read (require.cache deletion no longer works for compiled ESM).
  resetMarketAdapterWhitelistCache();
  try {
    return fn();
  } finally {
    if (originalEnv === undefined) {
      delete process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE;
    } else {
      process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = originalEnv;
    }
    Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = originalConfigWhitelist;
    if (fs.existsSync(TEST_WHITELIST_PATH)) {
      fs.unlinkSync(TEST_WHITELIST_PATH);
    }
    resetMarketAdapterWhitelistCache();
  }
}

function testSnapshotStalenessMatchesTwoMarketAdapterCycles() {
  const { DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS } = loadAnalyzer();
  const { MARKET_ADAPTER } = require('../modules/constants');
  const expected = 2 * MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds * 1000;
  assert.strictEqual(
    DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS,
    expected,
    `staleness window should be 2 * pollSeconds * 1000 (expected ${expected} ms, got ${DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS} ms)`,
  );
}

function testIsAmaGridPrice() {
  const { isAmaGridPrice } = loadAnalyzer();
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'ama' }), true, 'ama should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'AMA' }), true, 'uppercase should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'ama2' }), true, 'ama2 should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'ama4' }), true, 'ama4 should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: '  ama  ' }), true, 'whitespace tolerated');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'fixed' }), false, 'fixed is not AMA');
  assert.strictEqual(isAmaGridPrice({ gridPrice: '' }), false, 'empty is not AMA');
  assert.strictEqual(isAmaGridPrice({ gridPrice: null }), false, 'null is not AMA');
  assert.strictEqual(isAmaGridPrice({}), false, 'missing gridPrice is not AMA');
  assert.strictEqual(isAmaGridPrice(null), false, 'null config is not AMA');
}

function testBuildDynamicWeightInfoRecentSnapshot() {
  const botKey = `dw-recent-${Date.now()}`;
  // Updated 1 second ago - definitely recent.
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    centerPrice: 100,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      baseWeights: { sell: 0.5, buy: 0.5 },
      trend: 'UP',
      isReady: true,
      finalOffset: 0.05,
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'expected info for recent snapshot');
    assert.strictEqual(info.live.buy, 0.45, 'live buy should match effectiveWeights.buy');
    assert.strictEqual(info.live.sell, 0.55, 'live sell should match effectiveWeights.sell');
    assert.strictEqual(info.base.buy, 0.5, 'base buy should match snapshot baseWeights');
    assert.strictEqual(info.base.sell, 0.5, 'base sell should match snapshot baseWeights');
    assert.strictEqual(info.isRecent, true, 'snapshot is recent');
    assert.strictEqual(info.isReady, true);
    assert.strictEqual(info.trend, 'UP');
    assert.strictEqual(info.finalOffset, 0.05);
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoStaleSnapshot() {
  const botKey = `dw-stale-${Date.now()}`;
  // Updated 3 hours ago - past the 2-cycle freshness window (2h default).
  const updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    centerPrice: 100,
    dynamicWeights: {
      effectiveWeights: { sell: 0.7, buy: 0.3 },
      baseWeights: { sell: 0.5, buy: 0.5 },
      trend: 'DOWN',
      isReady: true,
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'snapshot is read even when stale');
    assert.strictEqual(info.isRecent, false, 'snapshot is NOT recent');
    assert.strictEqual(info.live.sell, 0.7);
    assert.strictEqual(info.live.buy, 0.3);
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoNonAmaBot() {
  const { buildDynamicWeightInfo } = loadAnalyzer();
  const botKey = `dw-nonama-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.6, buy: 0.4 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const info = buildDynamicWeightInfo(botKey, { gridPrice: 'fixed', weightDistribution: { buy: 0.5, sell: 0.5 } });
    assert.strictEqual(info, null, 'non-AMA bots should skip dynamic weight lookup');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoMissingSnapshot() {
  const { buildDynamicWeightInfo } = loadAnalyzer();
  const info = buildDynamicWeightInfo('does-not-exist-bot', { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
  assert.strictEqual(info, null, 'no snapshot should yield null info');
}

function testBuildDynamicWeightInfoFallsBackToConfigBase() {
  const botKey = `dw-fallback-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      // No baseWeights - we should fall back to config.weightDistribution.
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.4, sell: 0.6 } });
    });
    assert.ok(info, 'expected info when baseWeights missing but config provides baseline');
    assert.strictEqual(info.base.buy, 0.4, 'base buy should fall back to config');
    assert.strictEqual(info.base.sell, 0.6, 'base sell should fall back to config');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoRejectsMissingEffectiveWeights() {
  const botKey = `dw-noeff-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      // No effectiveWeights: adapter status is still useful, but live weights are not.
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'missing effectiveWeights should still expose adapter snapshot status');
    assert.strictEqual(info.live, null, 'missing effectiveWeights should not expose live weights');
    assert.strictEqual(info.isRecent, true, 'fresh snapshot remains fresh without effectiveWeights');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoReadsRootAsymmetricBounds() {
  const botKey = `dw-rootbounds-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    amaCenterPrice: 101,
    // No dynamicWeights — root-level asymmetricBounds is written by the
    // market adapter when asymmetricBounds: true but dynamicWeight: false.
    asymmetricBounds: {
      rawAsymmetryFactor: 0.08,
      appliedAsymmetryFactor: 0.045,
      trend: 'DOWN',
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: true },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'expected adapter status for AMA bot with dynamicWeight: false');
    assert.strictEqual(info.live, null, 'dynamicWeight: false should not expose live weights');
    assert.strictEqual(info.amaCenterPrice, 101, 'AMA center should be available');
    assert.strictEqual(info.appliedAsymmetryFactor, 0.045, 'root-level appliedAsymmetryFactor should be read');
    assert.strictEqual(info.rawAsymmetryFactor, 0.08, 'root-level rawAsymmetryFactor should be read');
    assert.strictEqual(info.trend, 'DOWN', 'root-level trend should be read');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoIgnoresRootBoundsWhenDynamicWeightsPresent() {
  const botKey = `dw-ignoreroot-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    amaCenterPrice: 101,
    // Both root-level and dynamicWeights data present.
    asymmetricBounds: {
      rawAsymmetryFactor: 0.99,
      appliedAsymmetryFactor: 0.99,
      trend: 'UP',
    },
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      baseWeights: { sell: 0.5, buy: 0.5 },
      appliedAsymmetryFactor: 0.045,
      rawAsymmetryFactor: 0.08,
      trend: 'DOWN',
      isReady: true,
      finalOffset: 0.05,
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: true },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'expected adapter status');
    assert.strictEqual(info.live.buy, 0.45, 'live weights from dynamicWeights should be exposed');
    assert.strictEqual(info.appliedAsymmetryFactor, 0.045, 'dynamicWeights.appliedAsymmetryFactor wins over root');
    assert.strictEqual(info.rawAsymmetryFactor, 0.08, 'dynamicWeights.rawAsymmetryFactor wins over root');
    assert.strictEqual(info.trend, 'DOWN', 'dynamicWeights.trend wins over root');
  } finally {
    removeSnapshot(botKey);
  }
}

function testAnalyzeOrderIncludesAsymmetricBoundsFromRoot() {
  const botKey = `dw-asymroot-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    amaCenterPrice: 101,
    gridCenterPrice: 100,
    asymmetricBounds: {
      rawAsymmetryFactor: 0.04,
      appliedAsymmetryFactor: 0.04,
      trend: 'UP',
    },
  });

  try {
    const botData = {
      meta: { assetA: 'BTS', assetB: 'XBTSX.USDT', updatedAt: new Date().toISOString() },
      boundaryIdx: 0,
      grid: [
        { type: 'buy', state: 'active', orderId: 'a', price: 100, size: 1 },
        { type: 'sell', state: 'active', orderId: 'b', price: 110, size: 1 },
      ],
    };
    const config = {
      gridPrice: 'ama',
      minPrice: '1.55x',
      maxPrice: '1.55x',
      targetSpreadPercent: 2,
      incrementPercent: 0.5,
      coreOrders: { buy: 20, sell: 20 },
      botFunds: { buy: '100%', sell: '100%' },
      weightDistribution: { buy: 1, sell: 1 },
    };
    const analysis = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: true },
    }, () => {
      const { analyzeOrder } = loadAnalyzer();
      return analyzeOrder(botData, config, botKey);
    });
    assert.ok(analysis.asymmetricBounds, 'asymmetricBounds should be computed from root-level data');
    assert.strictEqual(analysis.asymmetricBounds.trend, 'UP');
    assert.strictEqual(analysis.asymmetricBounds.appliedAsymmetryFactor, 0.04);
    // With trend=UP, the whole band shifts up by (1 + appliedAsymmetryFactor):
    // center=101, minPrice=101/1.55≈65.16, maxPrice=101*1.55≈156.55
    // resolvedMin = 65.16 * 1.04, resolvedMax = 156.55 * 1.04
    assert.ok(Number.isFinite(analysis.asymmetricBounds.resolvedMinPrice), 'resolvedMinPrice should be finite');
    assert.ok(Number.isFinite(analysis.asymmetricBounds.resolvedMaxPrice), 'resolvedMaxPrice should be finite');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoRequiresAmaWhitelistForSnapshotStatus() {
  const botKey = `dw-not-whitelisted-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    amaCenterPrice: 101,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const amaOnlyInfo = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(amaOnlyInfo, 'AMA-only whitelist should expose adapter snapshot status');
    assert.strictEqual(amaOnlyInfo.live, null, 'AMA-only whitelist should not enable dynamic weight display');
    assert.strictEqual(amaOnlyInfo.amaCenterPrice, 101, 'AMA center should be available for AMA-only bots');

    const dynamicOnlyInfo = withWhitelist({
      [botKey]: { ama: false, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.strictEqual(dynamicOnlyInfo, null, 'dynamicWeight-only whitelist should not expose adapter data');
  } finally {
    removeSnapshot(botKey);
  }
}

function testFormatWeightLineAmaWithoutDynamicWhitelistStaysWhite() {
  const botKey = `dw-white-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.7, buy: 0.3 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const line = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo, formatWeightLine } = loadAnalyzer();
      const dynamicWeight = buildDynamicWeightInfo(botKey, {
        gridPrice: 'ama',
        weightDistribution: { buy: 0.5, sell: 0.5 },
      });
      return formatWeightLine({ buy: 0.5, sell: 0.5 }, dynamicWeight);
    });
    assert.ok(line, 'expected static weight line');
    const stripped = stripColorCodes(line);
    assert.ok(stripped.includes('0.50 buy'), 'buy static value should be displayed');
    assert.ok(stripped.includes('0.50 sell'), 'sell static value should be displayed');
    assert.ok(!stripped.includes('0.70'), 'live sell value should not be displayed');
    assert.ok(!stripped.includes('0.30'), 'live buy value should not be displayed');
    assert.ok(!stripped.includes('(adapter offline)'), 'offline alert should not render without dynamic whitelist');
    assert.ok(!line.includes('\x1b[91m0.50'), 'static buy/sell values should not be red');
    assert.ok(!line.includes('\x1b[92m0.50'), 'static buy/sell values should not be green');
    assert.ok(!line.includes('\x1b[38;5;246m0.50'), 'static buy/sell values should not be grey');
  } finally {
    removeSnapshot(botKey);
  }
}

function testFormatWeightLineStaleAmaWithoutDynamicWhitelistShowsOffline() {
  const botKey = `dw-ama-stale-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    amaCenterPrice: 101,
    dynamicWeights: {
      effectiveWeights: { sell: 0.7, buy: 0.3 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const line = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo, formatWeightLine } = loadAnalyzer();
      const dynamicWeight = buildDynamicWeightInfo(botKey, {
        gridPrice: 'ama',
        weightDistribution: { buy: 0.5, sell: 0.5 },
      });
      return formatWeightLine({ buy: 0.5, sell: 0.5 }, dynamicWeight);
    });
    const stripped = stripColorCodes(line);
    assert.ok(stripped.includes('(adapter offline)'), 'stale AMA-only snapshot should show adapter offline alert');
    assert.ok(!stripped.includes('0.70'), 'dynamicWeight-disabled live sell value should not be displayed');
    assert.ok(!stripped.includes('0.30'), 'dynamicWeight-disabled live buy value should not be displayed');
    assert.ok(!line.includes('\x1b[38;5;246m0.50'), 'AMA-only stale static weights should not be grey');
  } finally {
    removeSnapshot(botKey);
  }
}

function testFormatWeightLineStaticOnly() {
  const { formatWeightLine } = loadAnalyzer();
  const line = formatWeightLine({ buy: 0.5, sell: 0.5 }, null);
  assert.ok(line, 'expected a line when static weights are present');
  assert.ok(line.includes('0.50'), 'static value should be normalized to two decimals');
  assert.ok(line.startsWith('   Weight:'), 'line should use the Weight: prefix');
  const stripped = stripColorCodes(line);
  // No live values: stripped should not contain the " (<static>)" envelope.
  assert.ok(!stripped.includes('('), 'static-only line should not include the live envelope');
}

function testFormatWeightLineBuyHigherIsRed() {
  const { formatWeightLine } = loadAnalyzer();
  // live buy (0.6) > live sell (0.4): the side with the higher live weight
  // is the "losing" side (red); the lower is the "winning" side (green).
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: true, live: { buy: 0.6, sell: 0.4 } }
  );
  assert.ok(line, 'expected a line when live weights are recent');
  const stripped = stripColorCodes(line);
  assert.ok(stripped.includes('0.60 buy'), 'expected buy side live value');
  assert.ok(stripped.includes('0.40 sell'), 'expected sell side live value');
  assert.ok(!stripped.includes('(0.50)'), 'live line should not repeat static baseline in parentheses');
  // Buy is higher -> red; sell is lower -> green.
  assert.ok(line.includes('\x1b[91m'), 'red color must be applied to the higher live value (buy)');
  assert.ok(line.includes('\x1b[92m'), 'green color must be applied to the lower live value (sell)');
  // The first color in the line should be red (buy losing), then green (sell winning).
  const redIdx = line.indexOf('\x1b[91m');
  const greenIdx = line.indexOf('\x1b[92m');
  assert.ok(redIdx < greenIdx, 'red (losing/buy) must appear before green (winning/sell)');
  // Reset codes must follow the colored segments.
  assert.ok(line.includes('\x1b[0m'), 'color segments must be terminated with a reset');
}

function testFormatWeightLineSellHigherIsRed() {
  const { formatWeightLine } = loadAnalyzer();
  // live sell (0.6) > live buy (0.4): sell is the higher live weight -> red,
  // buy is the lower live weight -> green.
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: true, live: { buy: 0.4, sell: 0.6 } }
  );
  assert.ok(line, 'expected a line');
  const stripped = stripColorCodes(line);
  assert.ok(stripped.includes('0.40 buy'), 'expected buy side live value');
  assert.ok(stripped.includes('0.60 sell'), 'expected sell side live value');
  assert.ok(!stripped.includes('(0.50)'), 'live line should not repeat static baseline in parentheses');
  // Sell is higher -> red (losing); buy is lower -> green (winning).
  assert.ok(line.includes('\x1b[91m'), 'red color must be present for the higher live value (sell)');
  assert.ok(line.includes('\x1b[92m'), 'green color must be present for the lower live value (buy)');
  const redIdx = line.indexOf('\x1b[91m');
  const greenIdx = line.indexOf('\x1b[92m');
  assert.ok(greenIdx < redIdx, 'green (winning/buy) must appear before red (losing/sell)');
}

function testFormatWeightLineLiveEqualBothGrey() {
  const { formatWeightLine } = loadAnalyzer();
  // Live values are equal - neither side is higher or lower - both are grey.
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: true, live: { buy: 0.5, sell: 0.5 } }
  );
  assert.ok(line, 'expected a line');
  // No red or green colors should be used for the live values. The side labels
  // remain green/red, so assert against the numeric segments specifically.
  assert.ok(!line.includes('\x1b[92m0.50'), 'no green numeric value when live weights are equal');
  assert.ok(!line.includes('\x1b[91m0.50'), 'no red numeric value when live weights are equal');
  const stripped = stripColorCodes(line);
  assert.ok(stripped.includes('0.50 buy'), 'equal live buy value should still be displayed');
  assert.ok(stripped.includes('0.50 sell'), 'equal live sell value should still be displayed');
  assert.ok(!stripped.includes('(0.50)'), 'equal live line should not repeat static baseline in parentheses');
}

function testFormatWeightLineLiveStaleFallsBackToStatic() {
  const { formatWeightLine } = loadAnalyzer();
  // Stale snapshot: live data is present but isRecent is false -> static only
  // plus a red "(adapter offline)" alert.
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: false, live: { buy: 0.7, sell: 0.3 }, dynamicWeightEnabled: true }
  );
  assert.ok(line, 'expected a line');
  const stripped = stripColorCodes(line);
  assert.ok(!stripped.includes('0.70'), 'stale live value should not be displayed');
  assert.ok(stripped.includes('0.50'), 'static value should be displayed');
  assert.ok(stripped.includes('(adapter offline)'), 'stale snapshot should show adapter offline alert');
  assert.ok(line.includes('\x1b[91m'), 'alert should be rendered in red');
  assert.ok(line.includes('\x1b[38;5;246m'), 'static values should be grey');
}

function testFormatWeightLineMissingSnapshotHasNoAlert() {
  const { formatWeightLine } = loadAnalyzer();
  // No snapshot at all: dynamicWeight is null. We render static only, with no
  // "(adapter offline)" alert (we have no signal that the adapter is offline
  // versus that the bot has not yet been processed for the first time).
  const line = formatWeightLine({ buy: 0.5, sell: 0.5 }, null);
  assert.ok(line, 'expected a line');
  const stripped = stripColorCodes(line);
  assert.ok(!stripped.includes('(adapter offline)'),
    'missing snapshot should NOT show the adapter offline alert');
  assert.ok(stripped.includes('0.50'), 'static value should be displayed');
}

function testFormatWeightLineNullWeights() {
  const { formatWeightLine } = loadAnalyzer();
  assert.strictEqual(formatWeightLine(null, null), null, 'null weightDistribution should yield null');
  assert.strictEqual(formatWeightLine(undefined, null), null, 'undefined weightDistribution should yield null');
  assert.strictEqual(formatWeightLine({ buy: 'invalid', sell: 'invalid' }, null), null,
    'non-numeric weightDistribution should yield null');
}

function testAnalyzeOrderIncludesDynamicWeightForAma() {
  const botKey = `dw-analyze-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      baseWeights: { sell: 0.5, buy: 0.5 },
      isReady: true,
      trend: 'UP',
      finalOffset: 0.05,
    },
  });

  try {
    const botData = {
      meta: { assetA: 'XRP', assetB: 'BTS', updatedAt: new Date().toISOString() },
      boundaryIdx: 0,
      grid: [
        { type: 'buy', state: 'active', orderId: 'a', price: 100, size: 1 },
        { type: 'sell', state: 'active', orderId: 'b', price: 110, size: 1 },
      ],
    };
    const config = {
      gridPrice: 'ama',
      targetSpreadPercent: 1.5,
      incrementPercent: 0.5,
      coreOrders: { buy: 1, sell: 1 },
      botFunds: { buy: 1, sell: 1 },
      weightDistribution: { buy: 0.5, sell: 0.5 },
    };
    const analysis = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { analyzeOrder } = loadAnalyzer();
      return analyzeOrder(botData, config, botKey);
    });
    assert.ok(analysis.dynamicWeight, 'analyzeOrder should attach dynamicWeight for AMA bots');
    assert.strictEqual(analysis.dynamicWeight.live.buy, 0.45);
    assert.strictEqual(analysis.dynamicWeight.isRecent, true);
  } finally {
    removeSnapshot(botKey);
  }
}

function testAnalyzeOrderOmitsDynamicWeightForNonAma() {
  const { analyzeOrder } = loadAnalyzer();
  const botData = {
    meta: { assetA: 'XRP', assetB: 'BTS', updatedAt: new Date().toISOString() },
    boundaryIdx: 0,
    grid: [
      { type: 'buy', state: 'active', orderId: 'a', price: 100, size: 1 },
      { type: 'sell', state: 'active', orderId: 'b', price: 110, size: 1 },
    ],
  };
  const config = {
    gridPrice: 'fixed',
    targetSpreadPercent: 1.5,
    incrementPercent: 0.5,
    coreOrders: { buy: 1, sell: 1 },
    weightDistribution: { buy: 0.5, sell: 0.5 },
  };
  const analysis = analyzeOrder(botData, config, 'does-not-exist');
  assert.strictEqual(analysis.dynamicWeight, null, 'non-AMA bot should have null dynamicWeight');
}

function testAnalyzeOrderFormatsNumericBotFunds() {
  const { analyzeOrder, formatAnalysis } = loadAnalyzer();
  const botData = {
    meta: { assetA: 'XRP', assetB: 'BTS', updatedAt: new Date().toISOString() },
    boundaryIdx: 0,
    grid: [
      { type: 'buy', state: 'active', orderId: 'a', price: 100, size: 1 },
      { type: 'sell', state: 'active', orderId: 'b', price: 110, size: 1 },
    ],
  };
  // bots.json documents botFunds as either percentage strings ("90%") or
  // absolute numbers. A numeric value used to crash formatAnalysis with
  // "str.replace is not a function" because the Funds display path calls
  // string methods on the raw config values.
  const config = {
    gridPrice: 'fixed',
    targetSpreadPercent: 1.5,
    incrementPercent: 0.5,
    coreOrders: { buy: 1, sell: 1 },
    botFunds: { buy: 35, sell: 90 },
    weightDistribution: { buy: 0.5, sell: 0.5 },
  };
  const analysis = analyzeOrder(botData, config, 'numeric-funds-bot');
  assert.strictEqual(analysis.botFunds.buy, '35', 'numeric botFunds.buy should be normalized to a string');
  assert.strictEqual(analysis.botFunds.sell, '90', 'numeric botFunds.sell should be normalized to a string');

  // The original crash: formatAnalysis renders the Funds line with
  // padEnd/stripColorCodes on these values.
  let output;
  assert.doesNotThrow(() => { output = formatAnalysis(analysis); }, 'formatAnalysis must survive numeric botFunds configs');
  const fundsLine = stripColorCodes(String(output)).split('\n').find((l) => l.includes('Funds:'));
  assert.ok(fundsLine, 'Funds line should be rendered');
  assert.ok(fundsLine.includes('35'), 'Funds line should show the numeric buy value');
  assert.ok(fundsLine.includes('90'), 'Funds line should show the numeric sell value');

  // Percentage strings must keep their exact form.
  const analysisPct = analyzeOrder(botData, { ...config, botFunds: { buy: '35%', sell: '90%' } }, 'pct-funds-bot');
  assert.strictEqual(analysisPct.botFunds.buy, '35%', 'percentage botFunds.buy should pass through unchanged');
  assert.strictEqual(analysisPct.botFunds.sell, '90%', 'percentage botFunds.sell should pass through unchanged');
  assert.doesNotThrow(() => { formatAnalysis(analysisPct); }, 'formatAnalysis must survive percentage botFunds configs');
}

function testResolveAmaKey() {
  const { resolveAmaKey } = loadAnalyzer();
  assert.strictEqual(resolveAmaKey({ gridPrice: 'ama' }), 'AMA3', 'ama resolves to AMA3 (default)');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'AMA' }), 'AMA3', 'uppercase ama resolves to AMA3');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'ama2' }), 'AMA2', 'ama2 resolves to AMA2');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'ama4' }), 'AMA4', 'ama4 resolves to AMA4');
  assert.strictEqual(resolveAmaKey({ gridPrice: '  ama3  ' }), 'AMA3', 'whitespace tolerated');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'pool' }), null, 'pool is not AMA');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'book' }), null, 'book is not AMA');
  assert.strictEqual(resolveAmaKey({ gridPrice: '' }), null, 'empty is not AMA');
  assert.strictEqual(resolveAmaKey({ gridPrice: null }), null, 'null is not AMA');
  assert.strictEqual(resolveAmaKey({}), null, 'missing gridPrice is not AMA');
  assert.strictEqual(resolveAmaKey(null), null, 'null config returns null');
}

function makeMockAnalysis(overrides) {
  return {
    pair: 'TEST/TEST',
    botName: 'test-bot',
    lastUpdated: new Date(),
    hasConfig: true,
    spread: { real: 2, target: 2, diff: 0, pass: true },
    increment: { avg: 0.5, target: 0.5, min: 0.49, max: 0.51, pass: true },
    slots: { buy: 10, sell: 10, spread: 0, activeBuy: 5, virtualBuy: 5, activeSell: 5, virtualSell: 5, partialBuy: 0, partialSell: 0 },
    gridMinPrice: 90,
    gridMaxPrice: 110,
    marketPrice: null,
    coreOrdersTarget: { buy: 10, sell: 10 },
    weightDistribution: { buy: 0.5, sell: 0.5 },
    gridPriceLabel: null,
    gridPriceValue: null,
    gridPriceStale: false,
    dynamicWeight: null,
    asymmetricBounds: null,
    distribution: {
      slots: { buyPercent: 50, sellPercent: 50 },
      funds: { buyPercent: 50, sellPercent: 50 },
      match: { buyDiff: 0, sellDiff: 0 },
    },
    funds: { buy: { bts: 100, xrp: 0.5 }, sell: { xrp: 100, bts: 20000 } },
    slotData: { buy: [], sell: [] },
    ...overrides,
  };
}

function testFormatAnalysisGridPriceLine() {
  const { formatAnalysis } = loadAnalyzer();

  // Grid mode: numeric gridPrice -> emits Grid: line
  const mockGrid = makeMockAnalysis({
    gridPriceLabel: 'Grid',
    gridPriceValue: 100,
    marketPrice: 105,
  });
  const gridLine = formatAnalysis(mockGrid);
  const strippedGrid = stripColorCodes(gridLine);
  assert.ok(strippedGrid.includes('Grid: 100.0'), 'numeric gridPrice should emit Grid: line');
  assert.ok(strippedGrid.includes('(+5.0%)'), 'grid price diff should be shown');

  // AMA mode with recent snapshot -> emits AMA3: line
  const mockAma = makeMockAnalysis({
    gridPriceLabel: 'AMA3',
    gridPriceValue: 100,
    marketPrice: 90,
  });
  const amaLine = formatAnalysis(mockAma);
  const strippedAma = stripColorCodes(amaLine);
  assert.ok(strippedAma.includes('AMA3: 100.0'), 'AMA mode should emit AMA3: line');
  assert.ok(strippedAma.includes('(-10.0%)'), 'AMA price diff should be shown');

  // Pool/book/startPrice mode -> no grid price line
  const mockNull = makeMockAnalysis({
    gridPriceLabel: null,
    gridPriceValue: null,
    marketPrice: 100,
  });
  const nullLine = formatAnalysis(mockNull);
  const strippedNull = stripColorCodes(nullLine);
  assert.ok(!/\bAMA[1-4]?:/.test(strippedNull), 'no AMA<N>: line without AMA label');
  assert.ok(!/\bGrid:/.test(strippedNull), 'no Grid: line without Grid label');
}

function testFormatAnalysisGridPriceStale() {
  const analyzer = loadAnalyzer();
  const { formatAnalysis, colors } = analyzer;

  // Stale snapshot -> price rendered in grey
  const mockStale = makeMockAnalysis({
    gridPriceLabel: 'AMA2',
    gridPriceValue: 200,
    gridPriceStale: true,
    marketPrice: 210,
  });
  const staleLine = formatAnalysis(mockStale);
  const mStale = staleLine.match(/\n {5}AMA2:/);
  const afterStaleAma = mStale ? staleLine.slice(mStale.index! + 1, mStale.index! + 1 + 30) : '';
  assert.ok(afterStaleAma.includes(colors.gray), 'stale AMA price should be grey');
  assert.ok(stripColorCodes(staleLine).includes('AMA2: 200.0'), 'stale line still shows label and price');

  // Recent snapshot -> price NOT grey (only the AMA3: line segment)
  const mockRecent = makeMockAnalysis({
    gridPriceLabel: 'AMA3',
    gridPriceValue: 100,
    gridPriceStale: false,
    marketPrice: 105,
  });
  const recentLine = formatAnalysis(mockRecent);
  const mRecent = recentLine.match(/\n {5}AMA3:/);
  const afterRecentAma = mRecent ? recentLine.slice(mRecent.index! + 1, mRecent.index! + 1 + 30) : '';
  assert.ok(!afterRecentAma.includes(colors.gray), 'recent AMA price should NOT be grey');
  assert.ok(stripColorCodes(recentLine).includes('AMA3: 100.0'), 'recent line shows label and price');
}

function testAnalyzeOrderBoundaryLessClassifiesByType() {
  const { analyzeOrder, formatAnalysis } = loadAnalyzer();
  const botKey = `boundaryless-${Date.now()}`;
  const botData = {
    meta: { assetA: 'BTS', assetB: 'XBTSX.USDT', updatedAt: new Date().toISOString() },
    // Poisoned-boundary erasure persists null; the bot keeps trading with a
    // live grid and no boundary until fills re-anchor.
    boundaryIdx: null,
    grid: [
      { type: 'buy', state: 'active', orderId: 'b1', price: 90, size: 1 },
      { type: 'buy', state: 'active', orderId: 'b2', price: 95, size: 1 },
      { type: 'sell', state: 'active', orderId: 's1', price: 105, size: 1 },
      { type: 'sell', state: 'active', orderId: 's2', price: 110, size: 1 },
    ],
  };
  const config = {
    name: 'boundaryless-test',
    gridPrice: 'fixed',
    minPrice: '1.55x',
    maxPrice: '1.55x',
    targetSpreadPercent: 2,
    incrementPercent: 0.5,
    coreOrders: { buy: 4, sell: 4 },
    botFunds: { buy: '100%', sell: '100%' },
    weightDistribution: { buy: 1, sell: 1 },
  };
  const analysis = analyzeOrder(botData, config, botKey);
  assert.strictEqual(analysis.boundaryLess, true, 'null boundary should flag boundary-less mode');
  assert.strictEqual(analysis.slots.buy, 2, 'boundary-less report must count both buys by type');
  assert.strictEqual(analysis.slots.sell, 2, 'boundary-less report must count both sells by type');
  // Legacy index slicing would hide everything past slot 0 and collapse the
  // spread edges; these assert the real geometry is reported instead.
  assert.strictEqual(analysis.marketPrice, 100, 'market price uses real max-buy / min-sell');
  assert.ok(Math.abs(analysis.spread.real - (105 - 95) / 95) < 1e-9, 'spread uses real edges');
  const stripped = stripColorCodes(formatAnalysis(analysis));
  assert.ok(stripped.includes('boundary-less mode'), 'report should announce boundary-less mode');
}

function testAnalyzeOrderNumericBoundaryReportsStrandedOrders() {
  const { analyzeOrder, formatAnalysis } = loadAnalyzer();
  const botKey = `boundary-numeric-${Date.now()}`;
  const botData = {
    meta: { assetA: 'BTS', assetB: 'XBTSX.USDT', updatedAt: new Date().toISOString() },
    boundaryIdx: 1,
    // A live BUY above the numeric boundary is a STRANDED order (a boundary
    // commit moved away from it; GAP-EVAC owns the evacuation). It keeps its
    // rail type, so it must stay visible: index-slicing used to drop it from
    // every bucket (buy+spread+sell summed to less than the grid) and to
    // measure the spread from the geometry edge instead of the real top of
    // book — the exact way a collapsed spread read as "on target".
    grid: [
      { type: 'buy', state: 'active', orderId: 'b1', price: 90, size: 1 },
      { type: 'sell', state: 'active', orderId: 's1', price: 105, size: 1 },
      { type: 'buy', state: 'active', orderId: 'b2', price: 95, size: 1 },
      { type: 'sell', state: 'active', orderId: 's2', price: 110, size: 1 },
    ],
  };
  const config = {
    name: 'boundary-numeric-test',
    gridPrice: 'fixed',
    minPrice: '1.55x',
    maxPrice: '1.55x',
    targetSpreadPercent: 2,
    incrementPercent: 0.5,
    coreOrders: { buy: 4, sell: 4 },
    botFunds: { buy: '100%', sell: '100%' },
    weightDistribution: { buy: 1, sell: 1 },
  };
  const analysis = analyzeOrder(botData, config, botKey);
  assert.strictEqual(analysis.boundaryLess, false, 'numeric boundary must not flag boundary-less mode');
  assert.strictEqual(analysis.slots.buy, 2, 'every live buy stays visible regardless of its index');
  assert.strictEqual(analysis.slots.sell, 2, 'every live sell stays visible regardless of its index');
  assert.strictEqual(
    analysis.slots.buy + analysis.slots.sell + analysis.slots.spread,
    botData.grid.length,
    'slot buckets must account for every grid slot (no hidden orders)'
  );
  // b2 (95) is the stranded in-band buy: it IS the real best bid, so the spread
  // is measured from it, not from the boundary slot's 90.
  assert.ok(
    Math.abs(analysis.spread.real - (105 - 95) / 95) < 1e-9,
    `spread must use the real top of book (got ${analysis.spread.real})`
  );
  // Both rails can strand: with gap 3 the band is 2..4, so the buy at index 2
  // AND the sell at index 3 are inside it.
  const stranded = (analysis.gapBand && analysis.gapBand.inBandPlaced) || [];
  assert.strictEqual(stranded.length, 2, 'every in-band live order must be reported');
  // No slot id in the fixture: the chain order id is the actionable label.
  assert.deepStrictEqual(stranded.map((o) => o.id).sort(), ['b2', 's2'], 'the stranded orders are named');
  const stripped = stripColorCodes(formatAnalysis(analysis));
  assert.ok(
    stripped.includes('Spread band occupied'),
    'the report must surface the occupied band instead of a passing spread line'
  );
}

async function main() {
  testResolveAmaKey();
  testFormatAnalysisGridPriceLine();
  testFormatAnalysisGridPriceStale();
  testIsAmaGridPrice();
  testSnapshotStalenessMatchesTwoMarketAdapterCycles();
  testBuildDynamicWeightInfoRecentSnapshot();
  testBuildDynamicWeightInfoStaleSnapshot();
  testBuildDynamicWeightInfoNonAmaBot();
  testBuildDynamicWeightInfoMissingSnapshot();
  testBuildDynamicWeightInfoFallsBackToConfigBase();
  testBuildDynamicWeightInfoRejectsMissingEffectiveWeights();
  testBuildDynamicWeightInfoReadsRootAsymmetricBounds();
  testBuildDynamicWeightInfoIgnoresRootBoundsWhenDynamicWeightsPresent();
  testAnalyzeOrderIncludesAsymmetricBoundsFromRoot();
  testBuildDynamicWeightInfoRequiresAmaWhitelistForSnapshotStatus();
  testFormatWeightLineAmaWithoutDynamicWhitelistStaysWhite();
  testFormatWeightLineStaleAmaWithoutDynamicWhitelistShowsOffline();
  testFormatWeightLineStaticOnly();
  testFormatWeightLineBuyHigherIsRed();
  testFormatWeightLineSellHigherIsRed();
  testFormatWeightLineLiveEqualBothGrey();
  testFormatWeightLineLiveStaleFallsBackToStatic();
  testFormatWeightLineMissingSnapshotHasNoAlert();
  testFormatWeightLineNullWeights();
  testAnalyzeOrderIncludesDynamicWeightForAma();
  testAnalyzeOrderOmitsDynamicWeightForNonAma();
  testAnalyzeOrderFormatsNumericBotFunds();
  testAnalyzeOrderBoundaryLessClassifiesByType();
  testAnalyzeOrderNumericBoundaryReportsStrandedOrders();
  console.log('analyze-orders dynamic weight tests passed');
  fs.rmSync(TEST_PROFILE_ROOT, { recursive: true, force: true });
}

main().catch((err) => {
  fs.rmSync(TEST_PROFILE_ROOT, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});

'use strict';

const assert = require('assert');
const { PATHS } = require('../modules/paths');;
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const { isDistCodeRoot } = require('../modules/launcher/runtime_entry');
const _isDist = isDistCodeRoot(path.dirname(__dirname));
function _resolveAdapterModule() {
  return _isDist
    ? path.resolve(__dirname, '..', 'market_adapter', 'market_adapter.js')
    : require.resolve('../market_adapter/market_adapter.ts');
}

const {
  loadAmaCenterPrice,
  loadAmaCenterSnapshot
} = require('../modules/order/utils/system');

async function testSnapshotReaderExposesCenterOnly() {
  const botKey = `snapshot-${Date.now()}`;
  const filePath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    amaCenterPrice: 100,
    centerPrice: 101.5,
    gridPriceOffsetPct: 0.75,
    amaSlopePercentMode: 'perBar',
    amaSlope: {
      trend: 'DOWN',
      slopePct: -0.28,
      slopeOffset: -0.14,
    },
    gridRangeScalingAmaSlope: {
      trend: 'UP',
      slopePct: 0.42,
      slopeOffset: 0.21,
    },
    amaSlopeDeltaPercent: 0.18,
    amaSlopeThresholdPercent: 0.1,
    source: 'market_adapter/market_adapter.ts',
    updatedAt: '2026-01-01T00:00:00Z',
  }, null, 2) + '\n', 'utf8');

  try {
    const snapshot = loadAmaCenterSnapshot(botKey);
    assert(snapshot, 'snapshot should be returned for a valid file');
    assert.strictEqual(snapshot.amaCenterPrice, 100);
    assert.strictEqual(snapshot.centerPrice, 101.5);
    assert.strictEqual(snapshot.amaSlopePercentMode, 'perBar');
    assert.deepStrictEqual(snapshot.amaSlope, {
      trend: 'DOWN',
      slopePct: -0.28,
      slopeOffset: -0.14,
    });
    assert.deepStrictEqual(snapshot.gridRangeScalingAmaSlope, {
      trend: 'UP',
      slopePct: 0.42,
      slopeOffset: 0.21,
    });
    assert.strictEqual(snapshot.amaSlopeDeltaPercent, 0.18);
    assert.strictEqual(snapshot.amaSlopeThresholdPercent, 0.1);
    assert.strictEqual(snapshot.gridPriceOffsetPct, 0.75);
    assert.strictEqual(loadAmaCenterPrice(botKey), 101.5);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function testSnapshotReaderRejectsLegacyEffectiveCenterOnly() {
  const botKey = `snapshot-legacy-${Date.now()}`;
  const filePath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    amaCenterPrice: 100,
    effectiveCenterPrice: 101.5,
    source: 'market_adapter/market_adapter.ts',
    updatedAt: '2026-01-01T00:00:00Z'
  }, null, 2) + '\n', 'utf8');

  try {
    const snapshot = loadAmaCenterSnapshot(botKey);
    assert.strictEqual(snapshot, null, 'legacy snapshot without centerPrice should be rejected');
    assert.strictEqual(loadAmaCenterPrice(botKey), null);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

async function testCenterSnapshotWriterUsesOnlyNewCollateralField() {
  const marketAdapterPath = _resolveAdapterModule();
  delete require.cache[marketAdapterPath];

  const originalWriteFileSync = fsSync.writeFileSync;
  const originalRenameSync = fsSync.renameSync;
  const capturedWrites = [];

  try {
    fsSync.writeFileSync = (filePath, data) => {
      capturedWrites.push({ filePath, data: String(data) });
    };
    fsSync.renameSync = (src, dst) => {
      capturedWrites.push({ rename: [src, dst] });
    };

    const { writeCenterSnapshot } = require('../market_adapter/test_helpers');
    writeCenterSnapshot({
      bots: {
        testBot: {
          botName: 'test-bot',
          gridCenterPrice: 123.45,
          amaCenterPrice: 120.5,
          lastGridResetAt: '2026-01-01T00:00:00Z',
          lastGridResetSource: 'manual_grid_resync',
          lastAmaPrice: 121.25,
          lastDeltaPercent: 1.5,
          amaSlopeDeltaPercent: 0.12,
          amaSlopeThresholdPercent: 0.1,
          weights: { buy: 0.6, sell: 0.4 },
          effectiveWeights: { buy: 0.55, sell: 0.45 },
          collateralRecommendation: 1.62,
          amaSlope: {
            trend: 'UP',
            slopePct: 0.28,
            slopeOffset: 0.14,
          },
          atr: 0.34,
        },
      },
    });

    const write = capturedWrites.find((entry) => entry.filePath && String(entry.filePath).endsWith('.tmp'));
    assert(write, 'snapshot writer should emit a JSON payload');
	    const parsed = JSON.parse(write.data);
	    assert.strictEqual(parsed.bots.testBot.gridCenterPrice, 123.45);
	    assert.strictEqual(parsed.bots.testBot.centerPrice, 123.45);
	    assert.strictEqual(parsed.bots.testBot.lastGridResetSource, 'manual_grid_resync');
	    assert.strictEqual(parsed.bots.testBot.collateralRecommendation, 1.62);
	    assert.strictEqual(parsed.bots.testBot.amaSlopeDeltaPercent, 0.12);
	    assert.strictEqual(parsed.bots.testBot.amaSlopeThresholdPercent, 0.1);
	    assert.strictEqual(parsed.bots.testBot.amaSlopePercentMode, 'perBar');
	    assert.deepStrictEqual(parsed.bots.testBot.amaSlope, {
      trend: 'UP',
      slopePct: 0.28,
      slopeOffset: 0.14,
    });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.bots.testBot, 'collateral'), false, 'legacy collateral field should not be written');
  } finally {
    fsSync.writeFileSync = originalWriteFileSync;
    fsSync.renameSync = originalRenameSync;
    delete require.cache[marketAdapterPath];
  }
}

async function testCenterSnapshotWriterIgnoresLegacyCollateralInput() {
  const marketAdapterPath = _resolveAdapterModule();
  delete require.cache[marketAdapterPath];

  const originalWriteFileSync = fsSync.writeFileSync;
  const originalRenameSync = fsSync.renameSync;
  const capturedWrites = [];

  try {
    fsSync.writeFileSync = (filePath, data) => {
      capturedWrites.push({ filePath, data: String(data) });
    };
    fsSync.renameSync = (src, dst) => {
      capturedWrites.push({ rename: [src, dst] });
    };

    const { writeCenterSnapshot } = require('../market_adapter/test_helpers');
    writeCenterSnapshot({
      bots: {
        testBot: {
          botName: 'test-bot',
          centerPrice: 123.45,
          amaCenterPrice: 120.5,
          collateral: 1.62,
        },
      },
    });

    const write = capturedWrites.find((entry) => entry.filePath && String(entry.filePath).endsWith('.tmp'));
    assert(write, 'snapshot writer should emit a JSON payload');
    const parsed = JSON.parse(write.data);
    assert.strictEqual(parsed.bots.testBot.collateralRecommendation, null, 'legacy collateral input should not be upgraded implicitly');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed.bots.testBot, 'collateral'), false, 'legacy collateral field should remain absent');
  } finally {
    fsSync.writeFileSync = originalWriteFileSync;
    fsSync.renameSync = originalRenameSync;
    delete require.cache[marketAdapterPath];
  }
}

async function testAdapterStateMergePreservesBotResetMetadata() {
  const marketAdapterPath = _resolveAdapterModule();
  delete require.cache[marketAdapterPath];

  const botKey = `adapter-merge-${Date.now()}`;
  const filePath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    gridCenterPrice: 123.45,
    centerPrice: 123.45,
    amaCenterPrice: 130.25,
    lastGridResetAt: '2026-05-15T00:01:00.327Z',
    lastGridResetSource: 'dexbot_grid_resync',
    source: 'market_adapter/market_adapter.ts',
    updatedAt: '2026-05-15T00:01:00.327Z',
  }, null, 2) + '\n', 'utf8');

  try {
    const { mergeGridResetMetadataFromDynamicGrid } = require('../market_adapter/market_adapter').__test;
    const state = {
      bots: {
        [botKey]: {
          gridCenterPrice: 100,
          centerPrice: 100,
          lastGridResetAt: '2026-05-13T18:00:01.190Z',
        },
      },
    };

    mergeGridResetMetadataFromDynamicGrid(state);

    assert.strictEqual(state.bots[botKey].gridCenterPrice, 123.45);
    assert.strictEqual(state.bots[botKey].centerPrice, 123.45);
    assert.strictEqual(state.bots[botKey].lastGridResetAt, '2026-05-15T00:01:00.327Z');
    assert.strictEqual((state.bots[botKey] as any).lastGridResetSource, 'dexbot_grid_resync');
  } finally {
    await fs.unlink(filePath).catch(() => {});
    delete require.cache[marketAdapterPath];
  }
}

async function testDynamicGridWritePreservesExistingResetMetadata() {
  const marketAdapterPath = _resolveAdapterModule();
  delete require.cache[marketAdapterPath];

  const botKey = `adapter-existing-reset-${Date.now()}`;
  const filePath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    gridCenterPrice: 100,
    centerPrice: 100,
    amaCenterPrice: 101,
    lastGridResetAt: '2026-05-15T00:01:00.327Z',
    lastGridResetSource: 'manual_grid_resync',
    source: 'market_adapter/market_adapter.ts',
    updatedAt: '2026-05-15T00:01:00.327Z',
  }, null, 2) + '\n', 'utf8');

  try {
    const { writeBotDynamicGrid } = require('../market_adapter/test_helpers');
    assert.strictEqual(writeBotDynamicGrid(botKey, 123.45, {
      amaCenterPrice: 130.25,
    }), true);

    const updated = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
    assert.strictEqual(updated.gridCenterPrice, 123.45);
    assert.strictEqual(updated.lastGridResetAt, '2026-05-15T00:01:00.327Z');
    assert.strictEqual(updated.lastGridResetSource, 'manual_grid_resync');
  } finally {
    await fs.unlink(filePath).catch(() => {});
    delete require.cache[marketAdapterPath];
  }
}

async function testDynamicGridWritePreservesNewerResetCenterWhenAdapterStateIsStale() {
  const marketAdapterPath = _resolveAdapterModule();
  delete require.cache[marketAdapterPath];

  const botKey = `adapter-stale-reset-${Date.now()}`;
  const filePath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({
    gridCenterPrice: 150,
    centerPrice: 150,
    amaCenterPrice: 151,
    lastGridResetAt: '2026-05-15T00:01:00.327Z',
    lastGridResetSource: 'manual_grid_resync',
    source: 'market_adapter/market_adapter.ts',
    updatedAt: '2026-05-15T00:01:00.327Z',
  }, null, 2) + '\n', 'utf8');

  try {
    const { writeBotDynamicGrid } = require('../market_adapter/test_helpers');
    assert.strictEqual(writeBotDynamicGrid(botKey, 100, {
      amaCenterPrice: 130.25,
      observedLastGridResetAt: '2026-05-13T18:00:01.190Z',
      dynamicWeights: {
        isReady: true,
        effectiveWeights: { sell: 0.55, buy: 0.45 },
      },
    }), true);

    const updated = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
    assert.strictEqual(updated.gridCenterPrice, 150, 'stale adapter writes should not roll back the newer reset center');
    assert.strictEqual(updated.centerPrice, 150, 'center alias should stay aligned with the preserved reset center');
    assert.strictEqual(updated.amaCenterPrice, 130.25, 'fresh AMA diagnostics should still be written');
    assert.strictEqual(updated.lastGridResetAt, '2026-05-15T00:01:00.327Z');
    assert.strictEqual(updated.lastGridResetSource, 'manual_grid_resync');
  } finally {
    await fs.unlink(filePath).catch(() => {});
    delete require.cache[marketAdapterPath];
  }
}

async function testGridResetTriggerWriteIsAtomicRename() {
  const marketAdapterPath = _resolveAdapterModule();
  delete require.cache[marketAdapterPath];

  const originalWriteFileSync = fsSync.writeFileSync;
  const originalRenameSync = fsSync.renameSync;
  const writes = [];
  const renames = [];
  const botKey = `atomic-trigger-${Date.now()}`;

  try {
    fsSync.writeFileSync = (filePath, data, encoding) => {
      writes.push({ filePath: String(filePath), data: String(data), encoding });
    };
    fsSync.renameSync = (src, dst) => {
      renames.push({ src: String(src), dst: String(dst) });
    };

    const { writeGridResetTrigger } = require('../market_adapter/test_helpers');
    const triggerPath = writeGridResetTrigger({
      name: 'Atomic Trigger Bot',
      botKey,
    }, {
      reason: 'market_adapter_delta_threshold',
      newCenterPrice: 123.45,
    });

    assert.strictEqual(writes.length, 1, 'trigger writer should write exactly one temp payload');
    assert.notStrictEqual(writes[0].filePath, triggerPath, 'trigger JSON should not be written directly to the final path');
    assert.ok(writes[0].filePath.startsWith(`${triggerPath}.`), 'temp trigger path should be adjacent to the final trigger');
    assert.ok(writes[0].filePath.endsWith('.tmp'), 'temp trigger path should use a .tmp suffix');
    assert.deepStrictEqual(renames, [{ src: writes[0].filePath, dst: triggerPath }], 'trigger writer should publish with one rename');

    const parsed = JSON.parse(writes[0].data);
    const _expectedSource = 'market_adapter/market_adapter' + (_isDist ? '.js' : '.ts');
    assert.strictEqual(parsed.source, _expectedSource);
    assert.strictEqual(parsed.reason, 'market_adapter_delta_threshold');
    assert.strictEqual(parsed.newCenterPrice, 123.45);
  } finally {
    fsSync.writeFileSync = originalWriteFileSync;
    fsSync.renameSync = originalRenameSync;
    delete require.cache[marketAdapterPath];
  }
}

async function main() {
  await testSnapshotReaderExposesCenterOnly();
  await testSnapshotReaderRejectsLegacyEffectiveCenterOnly();
  await testCenterSnapshotWriterUsesOnlyNewCollateralField();
  await testCenterSnapshotWriterIgnoresLegacyCollateralInput();
  await testAdapterStateMergePreservesBotResetMetadata();
  await testDynamicGridWritePreservesExistingResetMetadata();
  await testDynamicGridWritePreservesNewerResetCenterWhenAdapterStateIsStale();
  await testGridResetTriggerWriteIsAtomicRename();
  console.log('ama center snapshot tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

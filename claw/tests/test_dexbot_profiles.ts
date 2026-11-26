'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { GRID_LIMITS, DEFAULT_CONFIG } = require('../../modules/constants');

const {
  createBotKey,
  createDexbotProfileAdapter,
  matchBotIdentifier,
  normalizeBotEntries,
  writeJsonFileAtomic,
} = require('../modules/dexbot_profiles');

function createCaptureLogger() {
  const messages: any[] = [];
  return {
    logger: {
      log: (msg: any) => messages.push(String(msg)),
      warn: (msg: any) => messages.push(String(msg))
    },
    messages
  };
}

async function testNormalizeAcceptsAssetIdAliases() {
  const { logger, messages } = createCaptureLogger();
  const bots = await normalizeBotEntries([
    {
      assetAId: '1.3.111',
      assetBId: '1.3.222',
      name: 'id-only'
    }
  ], { logger });

  assert.strictEqual(messages.length, 0, 'asset ID-only bots should not produce missing-key warnings');
  assert.strictEqual(bots[0].botKey, 'id-only', `botKey should be the sanitized name, got: ${bots[0].botKey}`);
}

async function testAtomicWriteFailsFastWhenLockCannotBeAcquired() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-'));
  const filePath = path.join(dir, 'bots.json');
  const lockPath = filePath + '.lock';

  const originalDateNow = Date.now;
  let now = 0;

  Date.now = () => {
    now += 2500;
    return now;
  };

  // Pre-create lock file so acquireFileLock sees EEXIST.  The Date.now mock
  // advances the deadline by 2500ms per call, making the 5-second retry
  // loop expire in ~100ms real time.
  await fs.writeFile(lockPath, JSON.stringify({ pid: 99999, at: new Date().toISOString() }), 'utf8');

  try {
    await assert.rejects(
      () => writeJsonFileAtomic(filePath, { bots: [] }),
      /Could not acquire lock/,
      'writeJsonFileAtomic should abort instead of writing without a lock'
    );
  } finally {
    Date.now = originalDateNow;
    await fs.unlink(lockPath).catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
}

async function testUpdateBotSettingsPreservesSingleObjectFormat() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-single-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    name: 'solo',
    assetA: 'USD',
    assetB: 'BTS'
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const updated = await adapter.updateBotSettings('solo', {
    incrementPercent: 0.4
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));

  assert.strictEqual(updated.incrementPercent, 0.4);
  assert.strictEqual(written.incrementPercent, 0.4);
  assert.strictEqual(written.name, 'solo');
  assert.strictEqual(Array.isArray(written.bots), false, 'single-object format must not gain a wrapper array');
}

async function testConcurrentUpdateBotSettingsPreservesBothPatches() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-race-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'alpha',
        assetA: 'USD',
        assetB: 'BTS'
      },
      {
        name: 'beta',
        assetA: 'CNY',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  await Promise.all([
    adapter.updateBotSettings('alpha', { incrementPercent: 0.1 }),
    adapter.updateBotSettings('beta', { incrementPercent: 0.2 })
  ]);

  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));
  assert.strictEqual(written.bots[0].incrementPercent, 0.1, 'first concurrent patch should persist');
  assert.strictEqual(written.bots[1].incrementPercent, 0.2, 'second concurrent patch should persist');
}

async function testApplyBotSettingsPatchAcceptsNumericStringBounds() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-legacy-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'legacy',
        assetA: 'HONEST.MONEY',
        assetB: 'BTS',
        active: true,
        dryRun: false,
        startPrice: 'pool',
        minPrice: '0.55',
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        coreOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const view = await adapter.getBotSettings('legacy', true);
  const result = await adapter.applyBotSettingsPatch('legacy', {
    incrementPercent: 0.4
  }, {
    trigger: false
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));

  assert.deepStrictEqual(view.validation.errors, []);
  assert.strictEqual(view.validation.valid, true);
  assert.strictEqual(result.updatedBot.incrementPercent, 0.4);
  assert.strictEqual(written.bots[0].incrementPercent, 0.4);
  assert.strictEqual(written.bots[0].minPrice, '0.55', 'numeric-string bounds must remain valid during unrelated updates');
}

async function testApplyBotSettingsPatchRejectsUnknownNestedPatchKeys() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-nested-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'strict',
        assetA: 'USD',
        assetB: 'BTS',
        startPrice: 'pool',
        minPrice: 0.55,
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        coreOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('strict', {
    weightDistribution: { buy: 0.7, typo: 123 }
  }, {
    forceReload: true
  });

  assert.strictEqual(preview.valid, false);
  assert.match(preview.errors.join('\n'), /weightDistribution contains unrecognized keys: typo/);
  await assert.rejects(
    () => adapter.applyBotSettingsPatch('strict', {
      weightDistribution: { buy: 0.7, typo: 123 }
    }, {
      trigger: false
    }),
    /weightDistribution contains unrecognized keys: typo/
  );
}

async function testApplyBotSettingsPatchWritesTriggerAtomically() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-apply-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS',
        coreOrders: { sell: 20, buy: 20 },
        botFunds: { sell: '100%', buy: '100%' },
        weightDistribution: { sell: 0.5, buy: 0.5 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const result = await adapter.applyBotSettingsPatch('solo', {
    incrementPercent: 0.4,
    weightDistribution: { buy: 0.7 }
  }, {
    trigger: true,
    triggerPayload: { reason: 'manual_test', changedKeys: ["incrementPercent"] }
  });

  const canonicalKey = result.updatedBot.botKey;
  const triggerFile = path.join(profilesDir, `recalculate.${canonicalKey}.trigger`);

  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));
  const trigger = JSON.parse(await fs.readFile(triggerFile, 'utf8'));

  assert.strictEqual(result.updatedBot.incrementPercent, 0.4);
  assert.strictEqual(result.updatedBot.weightDistribution.buy, 0.7);
  assert.strictEqual(result.updatedBot.weightDistribution.sell, 0.5, 'partial nested patch must preserve existing fields');
  assert.strictEqual(written.bots[0].incrementPercent, 0.4);
  assert.strictEqual(written.bots[0].weightDistribution.buy, 0.7);
  assert.strictEqual(written.bots[0].weightDistribution.sell, 0.5);
  assert.strictEqual(result.triggerPath, triggerFile);
  assert.strictEqual(trigger.reason, 'manual_test', 'caller-supplied diagnostic reason must be preserved');
  assert.strictEqual(trigger.source, 'manual_grid_full_reset', 'a settings-patch trigger is a clean-slate operator reset');
  assert.strictEqual(result.triggerPayload.source, 'manual_grid_full_reset');
}

async function testSparseBotPatchRespectsDefaultBackedValidation() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-defaults-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const minSpreadPattern = new RegExp(`targetSpreadPercent must be >= ${GRID_LIMITS.MIN_SPREAD_FACTOR}x incrementPercent`);
  const preview = await adapter.previewBotSettingsUpdate('solo', {
    targetSpreadPercent: 0.1
  }, {
    forceReload: true
  });

  assert.strictEqual(preview.valid, false, 'preview must reject patches that are invalid after defaults are applied');
  assert.match(preview.errors.join('\n'), minSpreadPattern);
  await assert.rejects(
    () => adapter.applyBotSettingsPatch('solo', {
      targetSpreadPercent: 0.1
    }, {
      trigger: false
    }),
    minSpreadPattern
  );
}

async function testInvalidPersistedOffsetPolicyBlocksUnrelatedPatch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-policy-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS',
        incrementPercent: -1,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        coreOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const view = await adapter.getBotSettings('solo', true);

  assert.strictEqual(view.validation.valid, false, 'effective view must expose invalid persisted field');
  assert.match(view.validation.errors.join('\n'), /incrementPercent must be a positive number/);
  await assert.rejects(
    () => adapter.applyBotSettingsPatch('solo', {
      targetSpreadPercent: 1.6
    }, {
      trigger: false
    }),
    /incrementPercent must be a positive number/
  );
}

async function testApplyBotSettingsPatchWithoutIdentifierReturnsResolvedBotMetadata() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-default-target-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const result = await adapter.applyBotSettingsPatch(null, {
    incrementPercent: 0.4
  }, {
    trigger: false
  });

  assert.strictEqual(result.updatedBot.botKey, 'solo', `botKey should be the sanitized name, got: ${result.updatedBot.botKey}`);
  assert.strictEqual(result.updatedBot.botIndex, 0);
  const canonicalKey = result.updatedBot.botKey;
  assert.strictEqual(result.next.files.orderSnapshot, path.join(profilesDir, 'orders', `${canonicalKey}.json`));
  assert.strictEqual(result.next.files.gridPriceSnapshot, path.join(profilesDir, 'orders', `${canonicalKey}.dynamicgrid.json`));
  assert.strictEqual(result.next.files.trigger, path.join(profilesDir, `recalculate.${canonicalKey}.trigger`));
}

async function testUpdateBotSettingsValidatesPatchAndPreservesExistingFields() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-validated-update-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'validated-update',
        assetA: 'USD',
        assetB: 'BTS',
        incrementPercent: 1.0
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const updated = await adapter.updateBotSettings('validated-update', {
    targetSpreadPercent: 2.2
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));

  assert.strictEqual(updated.targetSpreadPercent, 2.2);
  assert.strictEqual(written.bots[0].targetSpreadPercent, 2.2);
  assert.strictEqual(written.bots[0].incrementPercent, 1.0, 'updateBotSettings should preserve existing fields while validating the patch');

  // Verify invalid patches are now rejected
  await assert.rejects(
    adapter.updateBotSettings('validated-update', { incrementPercent: -1 }),
    /incrementPercent must be a positive number/
  );
}

async function testWeightDistributionRejectsNullAndFalseValues() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-weight-types-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'strict-weight',
        assetA: 'USD',
        assetB: 'BTS',
        startPrice: 'pool',
        minPrice: 0.55,
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        coreOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('strict-weight', {
    weightDistribution: { sell: null, buy: false }
  }, {
    forceReload: true
  });

  assert.strictEqual(preview.valid, false);
  assert.match(preview.errors.join('\n'), /weightDistribution\.sell must be a finite number/);
  assert.match(preview.errors.join('\n'), /weightDistribution\.buy must be a finite number/);
}

async function testNestedPatchValidationDoesNotDuplicateErrors() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-no-dupes-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'no-dupes',
        assetA: 'USD',
        assetB: 'BTS',
        startPrice: 'pool',
        minPrice: 0.55,
        maxPrice: '15x',
        incrementPercent: 0.4,
        targetSpreadPercent: 1.6,
        weightDistribution: { sell: 0.5, buy: 0.5 },
        botFunds: { sell: '100%', buy: '100%' },
        coreOrders: { sell: 20, buy: 20 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('no-dupes', {
    weightDistribution: { sell: null }
  }, {
    forceReload: true
  });

  const sellErrors = preview.errors.filter((entry: any) => entry === 'weightDistribution.sell must be a finite number');
  assert.strictEqual(sellErrors.length, 1, 'nested patch validation should not duplicate the same field error');
}

async function testNestedStateValidationRejectsWrongContainerTypes() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-bad-nested-state-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'bad-nested-state',
        assetA: 'USD',
        assetB: 'BTS',
        weightDistribution: 'oops',
        coreOrders: 0,
        botFunds: true
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const view = await adapter.getBotSettings('bad-nested-state', true);

  assert.strictEqual(view.rawValidation.valid, false);
  assert.match(view.rawValidation.errors.join('\n'), /weightDistribution must be an object with sell and buy/);
  assert.match(view.rawValidation.errors.join('\n'), /coreOrders must be an object with sell and buy/);
  assert.match(view.rawValidation.errors.join('\n'), /botFunds must be an object with sell and buy/);
}

async function testUpdateBotSettingsWithoutIdentifierReturnsResolvedBot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-default-update-return-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'solo',
        assetA: 'USD',
        assetB: 'BTS'
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const updated = await adapter.updateBotSettings(null, {
    incrementPercent: 0.4
  });

  assert.ok(updated, 'updateBotSettings(null, patch) should return the resolved bot');
  assert.strictEqual(updated.botKey, 'solo', `botKey should be the sanitized name, got: ${updated.botKey}`);
  assert.strictEqual(updated.botIndex, 0);
  assert.strictEqual(updated.incrementPercent, 0.4);
}

function testCreateBotKeyFallsBackToAssetIds() {
  const key = createBotKey({ assetAId: '1.3.1', assetBId: '1.3.0' }, 0);
  assert.ok(key.includes('1-3-1'), `botKey should contain sanitized assetAId, got: ${key}`);
  assert.ok(key.includes('1-3-0'), `botKey should contain sanitized assetBId, got: ${key}`);

  // Symbol fields still take precedence
  const symKey = createBotKey({ assetA: 'IOB.XRP', assetB: 'BTS', assetAId: '1.3.1', assetBId: '1.3.0' }, 0);
  assert.ok(symKey.includes('iob'), `symbol-based key should take precedence, got: ${symKey}`);
}

async function testMatchBotIdentifierHandlesIdOnlyBots() {
  const bot = (await normalizeBotEntries([{ assetAId: '1.3.1', assetBId: '1.3.0' }]))[0];

  // String pair match with IDs
  assert.strictEqual(matchBotIdentifier(bot, '1.3.1/1.3.0'), true, 'should match ID pair string');
  assert.strictEqual(matchBotIdentifier(bot, '1.3.1/1.3.999'), false, 'should not match wrong ID');

  // Object match with IDs
  assert.strictEqual(matchBotIdentifier(bot, { assetAId: '1.3.1', assetBId: '1.3.0' }), true, 'should match ID object');
  assert.strictEqual(matchBotIdentifier(bot, { assetAId: '1.3.1', assetBId: '1.3.999' }), false, 'should not match wrong ID object');

  // Mixed bot with both symbols and IDs
  const mixedBot = (await normalizeBotEntries([{ assetA: 'IOB.XRP', assetB: 'BTS', assetAId: '1.3.1', assetBId: '1.3.0' }]))[0];
  assert.strictEqual(matchBotIdentifier(mixedBot, 'IOB.XRP/BTS'), true, 'symbol pair should still work');
  assert.strictEqual(matchBotIdentifier(mixedBot, '1.3.1/1.3.0'), true, 'ID pair should also work for mixed bot');
}

async function testLiveOnlyPatchSkipsTriggerByDefault() {
  // Live-pickup keys (coreOrders/edgeOrders/botFunds/weightDistribution/
  // min_BTS_value/debtPolicy) are applied by the running bot within ~1min,
  // so a patch touching only them must not force a full grid-resync trigger.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-live-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'live',
        assetA: 'USD',
        assetB: 'BTS',
        coreOrders: { sell: 15, buy: 15 }
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const preview = await adapter.previewBotSettingsUpdate('live', {
    coreOrders: { buy: 20 }
  });
  assert.strictEqual(preview.triggerRequired, false, 'live-only patch must not require a trigger');
  const result = await adapter.applyBotSettingsPatch('live', {
    coreOrders: { buy: 20 }
  });
  const written = JSON.parse(await fs.readFile(botsFile, 'utf8'));
  assert.strictEqual(written.bots[0].coreOrders.buy, 20, 'patch must still be saved');
  assert.strictEqual(result.triggerPath, null, 'live-only patch must not write a trigger');
  assert.ok(result.next.mutability.livePickupOnChange.includes('coreOrders'), 'catalog must list live-pickup keys');
  assert.ok(result.next.mutability.triggerOnChange.includes('incrementPercent'), 'catalog keeps full trigger set');
  const files = await fs.readdir(profilesDir);
  assert.ok(!files.some((f: string) => f.startsWith('recalculate.')), 'no recalculate trigger file may exist');
}

async function testGeometryPatchKeepsTriggerByDefault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-geo-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      {
        name: 'geo',
        assetA: 'USD',
        assetB: 'BTS',
        incrementPercent: 0.4
      }
    ]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const result = await adapter.applyBotSettingsPatch('geo', {
    incrementPercent: 0.5
  });
  const canonicalKey = result.updatedBot.botKey;
  assert.strictEqual(result.triggerPath, path.join(profilesDir, `recalculate.${canonicalKey}.trigger`));
  await fs.access(result.triggerPath);
  const trigger = JSON.parse(await fs.readFile(result.triggerPath, 'utf8'));
  assert.strictEqual(trigger.source, 'manual_grid_full_reset', 'default settings-patch trigger must be a clean-slate reset');
  assert.strictEqual(trigger.reason, 'settings_update');
}

async function testSettingsPatchTriggerPayloadEdgeCases() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-profiles-trigger-edges-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [{ name: 'edges', assetA: 'USD', assetB: 'BTS', incrementPercent: 0.4 }]
  }, null, 2));

  const adapter = createDexbotProfileAdapter(profilesDir);
  const readTrigger = async (filePath: string) => fs.readFile(filePath, 'utf8');

  try {
    // null is the documented opt-out: an empty trigger is a normal reset.
    const nullResult = await adapter.applyBotSettingsPatch('edges', { incrementPercent: 0.5 }, {
      trigger: true,
      triggerPayload: null
    });
    assert.strictEqual(nullResult.triggerPayload, null);
    assert.strictEqual(await readTrigger(nullResult.triggerPath), '', 'null payload must write a legacy empty trigger');

    // An explicitly supplied source is caller intent and must not be escalated.
    const foreignResult = await adapter.applyBotSettingsPatch('edges', { incrementPercent: 0.6 }, {
      trigger: true,
      triggerPayload: { source: 'manual_grid_resync', reason: 'reprice' }
    });
    const foreign = JSON.parse(await readTrigger(foreignResult.triggerPath));
    assert.strictEqual(foreign.source, 'manual_grid_resync', 'an explicit source must keep the guard');
    assert.strictEqual(foreign.reason, 'reprice');

    // A non-object payload is written verbatim and parses as a normal reset.
    const stringResult = await adapter.applyBotSettingsPatch('edges', { incrementPercent: 0.7 }, {
      trigger: true,
      triggerPayload: 'manual'
    });
    assert.strictEqual(JSON.parse(await readTrigger(stringResult.triggerPath)), 'manual');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testLauncherResetWritesCleanSlateTrigger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexbot-launcher-reset-'));
  const profilesDir = path.join(dir, 'profiles');
  const botsFile = path.join(profilesDir, 'bots.json');

  await fs.mkdir(profilesDir, { recursive: true });
  await fs.writeFile(botsFile, JSON.stringify({
    bots: [
      { name: 'reset-target', assetA: 'USD', assetB: 'BTS', active: false },
      { name: 'reset-active', assetA: 'USD', assetB: 'BTS', active: true },
    ]
  }, null, 2));

  try {
    const { launcherReset } = require('../modules/claw_launcher');
    const result = await launcherReset('reset-target', { profileRoot: profilesDir });
    assert.strictEqual(result.reset, true);
    assert.strictEqual(result.targets.length, 1);

    const triggerFile = path.join(profilesDir, result.targets[0].triggerFile);
    const trigger = JSON.parse(await fs.readFile(triggerFile, 'utf8'));
    assert.strictEqual(trigger.source, 'manual_grid_full_reset', 'claw launcher reset must use the CLI clean-slate source');
    assert.deepStrictEqual(Object.keys(trigger), ['source'], 'no stale timestamp payload may remain');

    const allResult = await launcherReset('all', { profileRoot: profilesDir });
    assert.strictEqual(allResult.targets.length, 1, '"all" must normalize to null and skip explicitly inactive bots');
    assert.strictEqual(allResult.targets[0].botName, 'reset-active');
    for (const target of allResult.targets) {
      const payload = JSON.parse(await fs.readFile(path.join(profilesDir, target.triggerFile), 'utf8'));
      assert.strictEqual(payload.source, 'manual_grid_full_reset');
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testNormalizeBotEntriesDelegatesToSharedSeeder() {
  console.log(' - Testing normalizeBotEntries delegates to shared bot defaults...');
  const entries = await normalizeBotEntries([
    { name: 'missing-active' },
    { name: 'null-active', active: null },
    { name: 'false-active', active: false },
  ]);
  assert.strictEqual(entries[0].active, DEFAULT_CONFIG.active,
    'missing active → DEFAULT_CONFIG.active (shared seeder, was hardcoded true)');
  assert.strictEqual(entries[1].active, null,
    'present null passes through raw (claw used to coerce to false — unified in Phase 3)');
  assert.strictEqual(entries[2].active, false, 'active:false preserved');
  assert.strictEqual(entries[0].botIndex, 0, 'index stamped');
  assert.ok(entries[0].botKey, 'botKey generated');
}

async function main() {
  await testNormalizeAcceptsAssetIdAliases();
  await testNormalizeBotEntriesDelegatesToSharedSeeder();
  testCreateBotKeyFallsBackToAssetIds();
  await testMatchBotIdentifierHandlesIdOnlyBots();
  await testAtomicWriteFailsFastWhenLockCannotBeAcquired();
  await testUpdateBotSettingsPreservesSingleObjectFormat();
  await testConcurrentUpdateBotSettingsPreservesBothPatches();
  await testApplyBotSettingsPatchAcceptsNumericStringBounds();
  await testApplyBotSettingsPatchRejectsUnknownNestedPatchKeys();
  await testApplyBotSettingsPatchWritesTriggerAtomically();
  await testSparseBotPatchRespectsDefaultBackedValidation();
  await testInvalidPersistedOffsetPolicyBlocksUnrelatedPatch();
  await testApplyBotSettingsPatchWithoutIdentifierReturnsResolvedBotMetadata();
  await testUpdateBotSettingsValidatesPatchAndPreservesExistingFields();
  await testWeightDistributionRejectsNullAndFalseValues();
  await testNestedPatchValidationDoesNotDuplicateErrors();
  await testNestedStateValidationRejectsWrongContainerTypes();
  await testUpdateBotSettingsWithoutIdentifierReturnsResolvedBot();
  await testLiveOnlyPatchSkipsTriggerByDefault();
  await testGeometryPatchKeepsTriggerByDefault();
  await testSettingsPatchTriggerPayloadEdgeCases();
  await testLauncherResetWritesCleanSlateTrigger();
  console.log('dexbot profile tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

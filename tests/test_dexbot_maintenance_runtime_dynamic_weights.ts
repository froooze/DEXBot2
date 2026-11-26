'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Compiled ESM namespaces are frozen and cannot be swapped via require.cache;
// scenarios whose mocks conflict run in their own hooked child process and
// register their own loader-hook module mocks via defineEsmMockAbs().
// Scenarios that share an identical mock set and hold no cross-stage state are
// grouped into one worker by runEsmMockStagesGrouped so each group pays worker
// startup + module-graph evaluation once instead of once per scenario.
const { runEsmMockStagesGrouped, defineEsmMockAbs } = require('./helpers/esm_mocks');

console.log('Running dexbot maintenance runtime dynamic weight tests');

const _adapterSource = 'market_adapter/market_adapter.js';

// Name unions: every name any compiled consumer statically imports from the
// mocked modules. Supersets are safe (extra synthetic re-exports are unused);
// missing names break ESM linking with SyntaxError.
const NAMES = {
    bitsharesClient: ['BitShares', 'onReconnect', 'waitForConnected'],
    chainOrders: [
        'readOpenOrdersGuarded', 'readOpenOrders', 'listenForFills',
        'resolveAccountId', 'selectAccount', 'setPreferredAccount',
        'executeBatch', 'cancelOrder',
    ],
    grid: [
        'calculateCurrentSpread', 'calculateGapSlots', 'checkGridHealth',
        'checkSpreadCondition', 'initializeGrid', 'recalculateGrid',
        'monitorDivergence', 'resolveRmsThresholdPct',
        'updateGridFromBlockchainSnapshot',
        'isGridBloated', 'isGridBloatGraceActive', 'clearGridBloatFlag',
    ],
    system: [
        'cloneMap', 'deepFreeze', 'deriveLiquidityPoolTokenValue',
        'deriveMarketPrice', 'derivePrice', 'ensureDir',
        'ensureProfilesDirectory', 'loadAmaCenterPrice',
        'loadAmaCenterSnapshot', 'lookupAsset', 'nowIso',
        'parseJsonWithComments', 'persistGridSnapshot', 'readInput',
        'readPassword', 'resolveAccountRef', 'resolveAssetByRef', 'sleep',
        'withBlockchainRetry', 'retryPersistenceIfNeeded',
        'applyGridDivergenceCorrections', 'initializeFeeCache',
        'restoreGapEvacStreaks', 'applyPersistedPendingCrawls',
        'resetLastFillPivot', 'restoreLastFillPivot', 'restoreLastMarketFill',
        'resolveSpreadMarketReference', 'evaluateSpreadCorrectionReadiness',
        'resolveLastFillGuardReference', 'resolveGuardGenerationKey', 'isLastFillGuardBlocked', 'evaluateLastFillGuard',
        'maybeRefreshLiveMarketPrice', 'refreshLiveMarketPrice',
        'resolveSpreadFreshnessMs', 'resolveSpreadCrossingFloor',
        'setLastFillPivot', 'normalizeLastFillPivot', 'hasLiveRefusedFillLevels',
        'rearmLastFillPivotFromMarketFill', 'reanchorBoundaryFromLastFill',
        'expireLastFillGuardReferences',
        'fireStructuralResync',
        // Fill-discipline predicates (grid_reconcile_internal / maintenance
        // runtime): stubbed settled here so the resync stages below exercise
        // their own subject instead of the new deferral gates.
        'hasUnsettledFills', 'isLastFillPlacementBlocked',
        'resolveGridUpdateBlockers', 'noteGridUpdateBlockers',
        // Newly consolidated single-source readers used by modules loaded
        // under this manifest (order.ts, maintenance/cow runtime, accounting).
        'offMarketFill', 'readBotInFlightFlags', 'readFillPipelineState',
        'extractGoneOrderIds', 'extractUpdateTargetOrderIds',
    ],
    format: ['formatCurrency', 'formatMetric2', 'isValidNumber', 'toFiniteNumber', 'toKnownNumber', 'formatPrice6', 'formatPercent'],
    orderUtils: [
        'applyChainSizeToGridOrder', 'assignGridRoles', 'buildCreateOrderArgs',
        'buildCrossingCheckCandidates', 'buildDelta', 'buildFillKey', 'buildIndexes',
        'buildOutsideInPairGroups', 'calculateBudgetedSizes',
        'calculateIdealBoundary', 'chainOrderMatchesSlot',
        'chainOrderMatchesSlotWithTolerance', 'checkSizesBeforeMinimum', 'checkSizeThreshold',
        'clearDuplicateOrphanDetection', 'collectRefillSlotIds', 'compareEdge', 'consumePendingFillCrawls', 'convertToSpreadPlaceholder',
        'deriveTargetBoundary', 'duplicateOrphanLogInfo',
        'extractBatchOperationResults', 'filterOrdersByType',
        'geometryTypeForSlotIndex',
        'getCoreOrdersTotal',
        'getSideBudget', 'hasOnChainId', 'isCrossingCheckCandidate', 'isEmptyGridSlot',
        'isOrderGoneErrorMessage', 'isOrderHealthy', 'isOrderOnChain',
        'isOrderPlaced', 'isOrderVirtual', 'isPhantomOrder', 'isShiftEligibleFill',
        'isNonBlockingUnmatchedOrder',
        'isSlotAvailable', 'parseChainOrder', 'edgeOrderIdSet', 'liveWindowIdSet', 'collectEdgePinnedFillIds',
        'isSignificantSizeChange', 'resolveSizeUpdateMinChangePercent',
        'resolveConfiguredPriceBound', 'resolveLiveEdgeAnchorPrice',
        'resolveOnChainRetypeType', 'resolveEdgeCount',
        'resolveSpreadOrderSide', 'selectEdgeSlots', 'shouldFlagOutOfSpread', 'virtualizeOrder',
        'formatUnmatchedChainOrder', 'correctAllPriceMismatches',
        'getOrderTypeFromUpdatedFlags',
        // Gap-evac stranding sweep (dexbot_state_recovery.scheduleGapEvacRepair,
        // reached from the maintenance tick).
        'detectGapEvacuationCandidates', 'updateGapEvacuationStreaks',
    ],
    validate: [
        'buildAbortedResult', 'buildStateUpdates', 'buildSuccessResult',
        'checkFundDrift', 'evaluateCommit', 'hasExecutableActions',
        'optimizeRebalanceActions', 'projectTargetToWorkingGrid',
        'reconcileGrid', 'validateGridForPersistence', 'validateOrder',
        'validateWorkingGridFunds',
    ],
    math: [
        'adjustBudgetForBtsFees', 'allocateFundsByWeights',
        'blockchainToFloat', 'calculateAvailableFundsValue',
        'calculateGapSlots', 'calculateGridSideDivergenceMetric',
        'calculateOrderCreationFees', 'calculateOrderSizes',
        'calculatePriceTolerance', 'calculateRotationOrderSizes',
        'calculateSpreadFromOrders', 'clamp', 'computeChainFundTotals',
        'countGapBandSpread', 'fixedTo',
        'floatToBlockchainInt', 'getAssetFees', 'getAssetFeesSafe',
        'getBtsSide', 'getDoubleDustThreshold', 'getGridBestPrices',
        'getMinOrderSize', 'getPrecisionByOrderType',
        'getPrecisionsForManager', 'getPrecisionSlack', 'getSellStartIdx',
        'getSingleDustThreshold', 'hasValidAccountTotals',
        'isExplicitZeroAllocation', 'isPercentageString', 'isPositiveInt',
        'isPositiveNumber', 'isPositiveNumberOrPercent', 'isSlotInRail',
        'isSlotIndexInGapBand', 'isTransientInBandRejection',
        'normalizeInt', 'parsePercentageString', 'resolveConfigValue',
        'resolveConfigValueWithRegistry', 'resolveGapBand',
        'resolveGapSlots', 'resolveRelativePrice', 'roundTo',
        'roundToDecimals', 'toDecimal', 'validateBoundaryCommit',
        'validateOrderAmountsWithinLimits', 'validatePersistedBoundary',
        'cloneWeightDistribution', 'priceLevelsForGenesis', 'priceForSlot',
        'slotIndexForPrice', 'slotIdForPrice', 'assertSlotPriceInvariant',
        'priceSlotEqual', 'pricesOnSameLevel', 'sameGridPrice', 'sameGridLevel', 'derivePriceLevels', 'buildGenesisFromPriceLevels', 'hashPriceLevels',
        'quantumForPrecision', 'quantizeFloat',
        'validateOrderSize', 'getDustThresholdFactor', 'calculateSwapInAmount',
        'findCrossedOrder', 'getPrecision',
    ],
    processedFillStore: ['ProcessedFillStore', 'PROCESSED_FILL_PERSISTENCE_MODES', 'resolveProcessedFillPersistenceMode'],
    startupReconcile: ['attemptResumePersistedGridByPriceMatch', 'decideStartupGridAction', 'reconcileGridOrders'],
    accountOrders: ['AccountOrders', 'createBotKey', 'sanitizeKey'],
    botSettings: [
        'assertNoDuplicateBotKeys', 'loadSettingsFile', 'normalizeBotEntries',
        'normalizeBotEntry', 'resolveRawBotEntries', 'saveSettingsFile',
        'selectActiveBotEntries',
    ],
    marketAdapterRuntime: ['isLikelyMarketAdapterProcess', 'isLockStale', 'getSharedMarketAdapterRuntime'],
    // checkPipelineInFlightWatchdogs is statically imported by dexbot_fill_runtime.
    maintenanceRuntime: ['isOrderDoesNotExistError', 'usesAmaGridPrice', 'checkPipelineInFlightWatchdogs'],
};

function requireStorage() {
    return require('../modules/storage').getStorage();
}

// Lazy requires for modules that must load AFTER per-stage env vars are set
// (Config snapshots process.env at module-load time).
function requirePaths() {
    return require('../modules/paths').PATHS;
}

function makeTempWhitelist(flagsByBot) {
    const wlPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-dw-wl-')), 'market_adapter_whitelist.json');
    requireStorage().writeJSON(wlPath, { whitelist: flagsByBot });
    // Must be set before Config first loads in this child process.
    process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = wlPath;
    return {
        update(flagsByBotUpdate) {
            requireStorage().writeJSON(wlPath, { whitelist: flagsByBotUpdate });
        },
        cleanup() {
            try { fs.rmSync(path.dirname(wlPath), { recursive: true, force: true }); } catch (_) {}
            delete process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE;
        },
    };
}

function patchBotsJson(bots) {
    const originalExistsSync = fs.existsSync;
    const originalReadFileSync = fs.readFileSync;
    const payload = JSON.stringify({ bots });
    fs.existsSync = (filePath) => {
        if (String(filePath).endsWith('/profiles/bots.json')) return true;
        return originalExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        if (String(filePath).endsWith('/profiles/bots.json')) return payload;
        return originalReadFileSync(filePath, encoding);
    };
    return () => {
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
    };
}

// Replica of the guarded open-orders read contract: clean array passes
// through, null signals an ambiguous/truncated read.
function guardedReadOpenOrdersReplica(chainOrdersModule: any, accountId: any, opts: any = {}) {
    return (async () => {
        try {
            const orders = await chainOrdersModule.readOpenOrders(accountId);
            return Array.isArray(orders) ? orders : [];
        } catch (err: any) {
            if (typeof opts.log === 'function') opts.log(`open-orders read failed: ${err?.message || err}`, 'warn');
            return [];
        }
    })();
}

function installCoreResyncMocks({ snapshotMode = 'live', expireSpy = null, guardedRead = null } = {}) {
    defineEsmMockAbs(require.resolve('../modules/bitshares_client'), NAMES.bitsharesClient, {
        BitShares: {},
        waitForConnected: async () => {},
        onReconnect: () => {},
    });
    defineEsmMockAbs(require.resolve('../modules/chain_orders'), NAMES.chainOrders, {
        readOpenOrders: async () => [],
        readOpenOrdersGuarded: guardedRead || ((mod, accountId, opts) => guardedReadOpenOrdersReplica(mod, accountId, opts)),
        listenForFills: async () => async () => {},
        executeBatch: async () => ({ tx_id: 'noop' }),
    });
    defineEsmMockAbs(require.resolve('../modules/order/utils/system'), NAMES.system, {
        loadAmaCenterSnapshot: () => ({
            centerPrice: 100,
            dynamicWeights: {
                isReady: snapshotMode !== 'stale',
                trend: 'NEUTRAL',
                confidence: 0,
                effectiveWeights: { sell: 0.42, buy: 0.22 },
                baseWeights: snapshotMode === 'base-changed'
                    ? { sell: 0.8, buy: 0.2 }
                    : { sell: 0.6, buy: 0.4 },
            },
        }),
        parseJsonWithComments: (text) => JSON.parse(text),
        nowIso: () => new Date().toISOString(),
        retryPersistenceIfNeeded: async () => {},
        applyGridDivergenceCorrections: async () => ({}),
        hasUnsettledFills: () => ({ unsettled: false, reason: null }),
        isLastFillPlacementBlocked: () => ({ blocked: false, pivot: null }),
        resolveGridUpdateBlockers: () => [],
        noteGridUpdateBlockers: () => ({ cycles: 0, escalate: false }),
        offMarketFill: () => null,
        readBotInFlightFlags: () => ({
            ok: true, batchInFlight: false, recoveryInFlight: false, deferredRebalance: false,
        }),
        readFillPipelineState: () => ({ ok: true, queued: 0, deferred: false, inFlight: 0, owed: 0 }),
        extractGoneOrderIds: () => new Set<string>(),
        extractUpdateTargetOrderIds: () => new Set<string>(),
        sleep: async () => {},
        expireLastFillGuardReferences: expireSpy || (() => {}),
        resolveGuardGenerationKey: () => '',
    });
}

async function testPerformGridResyncAppliesVolatilityOnlyDynamicWeights() {
    const logs = [];
    let recalculateCalled = false;
    let persistCalled = false;
    let startCalled = false;
    let finishCalled = false;

    const restoreFs = patchBotsJson([
        { name: 'Volatility Bot', weightDistribution: { sell: 0.6, buy: 0.4 } },
    ]);
    const wl = makeTempWhitelist({ 'volatility-bot-0': { ama: true, dynamicWeight: true } });

    installCoreResyncMocks({ snapshotMode: 'live' });
    defineEsmMockAbs(require.resolve('../modules/order/grid'), NAMES.grid, {
        recalculateGrid: async (manager, opts) => {
            recalculateCalled = true;
            assert.deepStrictEqual(
                manager.config.weightDistribution,
                { sell: 0.42, buy: 0.22 },
                'manager config should receive the volatility-only dynamic weights before recalculation'
            );
            assert.deepStrictEqual(
                opts.config.weightDistribution,
                { sell: 0.42, buy: 0.22 },
                'recalculateGrid should receive the updated weight distribution'
            );
        },
    });
    defineEsmMockAbs(require.resolve('../modules/order/format'), NAMES.format, {});
    defineEsmMockAbs(require.resolve('../modules/order/utils/order'), NAMES.orderUtils, {
        virtualizeOrder: (order) => order,
        convertToSpreadPlaceholder: (order) => ({ ...order, type: 'spread', size: 0, state: 'virtual', orderId: null }),
        isSignificantSizeChange: () => true,
        resolveSizeUpdateMinChangePercent: () => 3,
        resolveSizeTolerancePercent: () => 0.1,
    });
    defineEsmMockAbs(require.resolve('../modules/launcher/market_adapter_runtime'), NAMES.marketAdapterRuntime, {
        getSharedMarketAdapterRuntime: () => ({
            syncBot: async () => ({ running: false, started: false, stopped: false }),
            releaseBot: async () => ({ running: false, stopped: false }),
        }),
    });

    const { performGridResync } = require('../modules/dexbot_maintenance_runtime');

    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        manager: {
            config: {
                name: 'Volatility Bot',
                botKey: 'volatility-bot-0',
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 5 },
            startBootstrap: () => { startCalled = true; },
            finishBootstrap: () => { finishCalled = true; },
            _fundLock: { acquire: async (fn) => fn() },
            persistGrid: async () => { persistCalled = true; },
        },
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile: '/tmp/nonexistent-dw.trigger',
    };

    try {
        const ok = await performGridResync(self);

        assert.strictEqual(ok, true, 'performGridResync should succeed');
        assert.strictEqual(startCalled, true, 'bootstrap should start');
        assert.strictEqual(finishCalled, true, 'bootstrap should finish');
        assert.strictEqual(recalculateCalled, true, 'grid recalculation should run');
        assert.strictEqual(persistCalled, true, 'grid state should persist after resync');
        assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
        assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });
        assert.strictEqual(self.manager.funds.btsFeesOwed, 0, 'fee accumulator should reset after resync');
        assert.ok(
            logs.some((msg) => String(msg).includes('Applied live dynamic weights (grid resync): sell=0.42 buy=0.22')),
            'resync should log that it applied the dynamic weights'
        );
    } finally {
        restoreFs();
        wl.cleanup();
    }
}

function makeRefreshSelf(logs: any[] = []) {
    return {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        },
        _log: (msg) => { if (logs) logs.push(msg); },
    };
}

async function testRefreshDynamicWeightDistributionAppliesAndFallsBack() {
    const wl = makeTempWhitelist({ 'volatility-bot-0': { ama: true, dynamicWeight: true } });
    installCoreResyncMocks({ snapshotMode: 'live' });
    const { refreshDynamicWeightDistribution } = require('../modules/dexbot_maintenance_runtime');

    try {
        const self = makeRefreshSelf();
        const applied = refreshDynamicWeightDistribution(self, 'unit-test-live');
        assert.strictEqual(applied.applied, true, 'ready dynamic weights should be applied');
        assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
        assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });
    } finally {
        wl.cleanup();
    }
}

async function testRefreshDynamicWeightDistributionStaleFallback() {
    const wl = makeTempWhitelist({ 'volatility-bot-0': { ama: true, dynamicWeight: true } });
    installCoreResyncMocks({ snapshotMode: 'stale' });
    const { refreshDynamicWeightDistribution } = require('../modules/dexbot_maintenance_runtime');

    try {
        const self = makeRefreshSelf();
        const reverted = refreshDynamicWeightDistribution(self, 'unit-test-stale');
        assert.strictEqual(reverted.applied, false, 'stale dynamic weights should not be applied');
        assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
        assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    } finally {
        wl.cleanup();
    }
}

async function testRefreshDynamicWeightDistributionReloadsWhitelistFlags() {
    const wl = makeTempWhitelist({ 'volatility-bot-0': { ama: true, dynamicWeight: true } });
    installCoreResyncMocks({ snapshotMode: 'live' });
    const { refreshDynamicWeightDistribution } = require('../modules/dexbot_maintenance_runtime');

    try {
        const self = makeRefreshSelf();
        const applied = refreshDynamicWeightDistribution(self, 'unit-test-live-whitelist');
        assert.strictEqual(applied.applied, true, 'whitelisted bot should apply live weights');
        assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
        assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });

        wl.update({});
        const reverted = refreshDynamicWeightDistribution(self, 'unit-test-whitelist-removed');
        assert.strictEqual(reverted.applied, false, 'refresh should pick up whitelist removal without restart');
        assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
        assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    } finally {
        wl.cleanup();
    }
}

async function testRefreshDynamicWeightDistributionRejectsStaleBaseWeights() {
    const logs = [];
    const wl = makeTempWhitelist({ 'volatility-bot-0': { ama: true, dynamicWeight: true } });
    installCoreResyncMocks({ snapshotMode: 'base-changed' });
    const { refreshDynamicWeightDistribution } = require('../modules/dexbot_maintenance_runtime');

    try {
        const self = makeRefreshSelf(logs);
        const result = refreshDynamicWeightDistribution(self, 'unit-test-base-mismatch');
        assert.strictEqual(result.applied, false, 'stale base weights should cause fallback to static');
        assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
        assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
        assert.ok(
            logs.some((msg) => String(msg).includes('Skipping stale dynamic weights')),
            'should log a warning about stale dynamic weights'
        );
        assert.ok(
            logs.some((msg) => String(msg).includes('snapshot base (sell=0.8, buy=0.2) != config (sell=0.6, buy=0.4)')),
            'should log the mismatched base vs config values'
        );
    } finally {
        wl.cleanup();
    }
}

async function testUpdateBotGridResetMetadataRecordsActualReset() {
    const PATHS = requirePaths();
    const { ensureDir, readJSON, writeJSON } = requireStorage();

    const { updateBotGridResetMetadata } = require('../modules/dexbot_maintenance_runtime');

    const botKey = `metadata-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const snapshotFile = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 123.45,
        centerPrice: 123.45,
        amaCenterPrice: 130.25,
        gridPriceOffsetPct: 0.8,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });

    const prevReadFileSync = fs.readFileSync;
    let adapterStateReadCount = 0;
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/market_adapter/state/market_adapter_state.json')
                || text.endsWith('/market_adapter/state/market_adapter_centers.json')) {
            adapterStateReadCount += 1;
            throw new Error(`unexpected adapter state read: ${text}`);
        }
        return prevReadFileSync(filePath, encoding);
    };

    try {
        const ok = updateBotGridResetMetadata(botKey, {
            resetAt: '2026-05-15T00:01:00.327Z',
            resetSource: 'unit_test_resync',
        });
        assert.strictEqual(ok, true, 'metadata update should succeed when snapshot exists');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.gridCenterPrice, 123.45, 'metadata update should preserve grid center');
        assert.strictEqual(updated.centerPrice, 123.45, 'metadata update should preserve center alias');
        assert.strictEqual(updated.amaCenterPrice, 130.25, 'metadata update should preserve current AMA diagnostics');
        assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'metadata update should preserve actual offset');
        assert.strictEqual(updated.lastGridResetAt, '2026-05-15T00:01:00.327Z');
        assert.strictEqual(updated.lastGridResetSource, 'unit_test_resync');
        assert.strictEqual(updated.updatedAt, '2026-05-15T00:01:00.327Z');
        assert.strictEqual(adapterStateReadCount, 0, 'metadata update should not touch adapter-owned state snapshots');
    } finally {
        fs.readFileSync = prevReadFileSync;
        try { fs.unlinkSync(snapshotFile); } catch (_) {}
    }
}

async function testUpdateBotGridResetMetadataRejectsInvalidSnapshot() {
    const PATHS = requirePaths();
    const { ensureDir, readJSON, writeJSON } = requireStorage();
    const { updateBotGridResetMetadata } = require('../modules/dexbot_maintenance_runtime');

    const botKey = `metadata-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const snapshotFile = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 0,
        centerPrice: 0,
        amaCenterPrice: 130.25,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });

    try {
        const ok = updateBotGridResetMetadata(botKey, {
            resetAt: '2026-05-15T00:01:00.327Z',
            resetSource: 'unit_test_resync',
        });
        assert.strictEqual(ok, false, 'metadata update should report false when no valid center can be preserved');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.lastGridResetAt, undefined);
        assert.strictEqual(updated.lastGridResetSource, undefined);
    } finally {
        try { fs.unlinkSync(snapshotFile); } catch (_) {}
    }
}

// Manual / market-adapter trigger resets drive the REAL performGridResync and
// promoteAmaCenterSnapshotForGridReset against real snapshot files; only the
// resync collaborators (grid recalculation, open-order reads, AMA snapshot
// source) are mocked.
function installTriggerResetMocks({ expireSpy = null, recalculateSpy = null, guardedRead = null } = {}) {
    installCoreResyncMocks({ snapshotMode: 'live', expireSpy, guardedRead });
    defineEsmMockAbs(require.resolve('../modules/order/grid'), NAMES.grid, {
        recalculateGrid: recalculateSpy || (async () => {}),
    });
    defineEsmMockAbs(require.resolve('../modules/launcher/market_adapter_runtime'), NAMES.marketAdapterRuntime, {
        getSharedMarketAdapterRuntime: () => ({
            syncBot: async () => ({ running: false, started: false, stopped: false }),
            releaseBot: async () => ({ running: false, stopped: false }),
        }),
    });
}

async function runManualTriggerScenario({ botName, botKey, snapshotPayload, triggerPayload = null, assertUpdated, mocks = {}, assertState = null }) {
    const PATHS = requirePaths();
    const { ensureDir, readJSON, writeJSON } = requireStorage();

    const triggerFile = path.join(os.tmpdir(), `${botKey}.trigger`);
    const snapshotFile = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, snapshotPayload);
    if (triggerPayload) {
        writeJSON(triggerFile, triggerPayload);
    } else {
        fs.writeFileSync(triggerFile, '', 'utf8');
    }

    const wl = makeTempWhitelist({ [botKey]: { ama: true, dynamicWeight: true } });
    const restoreFs = patchBotsJson([{ name: botName, weightDistribution: { sell: 0.6, buy: 0.4 } }]);
    installTriggerResetMocks(mocks);
    const logs = [];

    const self = {
        config: {
            name: botName,
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: botName,
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: { acquire: async (fn) => fn() },
            _fundLock: { acquire: async (fn) => fn() },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
            _lastFilledPrice: 7.7,
            _lastFilledType: 'sell',
            _lastMarketFillPrice: 7.7,
            lastFillPivotSource: 'fill',
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    try {
        const { handlePendingTriggerReset } = require('../modules/dexbot_maintenance_runtime');
        const ok = await handlePendingTriggerReset(self);
        assert.strictEqual(ok, true, 'trigger reset should succeed');
        if (assertState) await assertState(self);
        await assertUpdated(readJSON(snapshotFile), logs);
    } finally {
        restoreFs();
        wl.cleanup();
        try { fs.unlinkSync(triggerFile); } catch (_) {}
        try { fs.unlinkSync(snapshotFile); } catch (_) {}
    }
}

// Manual CLI reset is a clean slate: both guard references (live + persisted)
// are dropped, the rebuild is told not to re-arm/anchor, and watchdog memory
// keyed to the old pivot is cleared. Automatic resync sources must not take
// this path — that invariant stays pinned by the other stages here.
async function runFullResetScenario({
    ambiguous = false,
    ambiguousConfirm = false,
    eraseFails = false,
    noApi = false,
    genesisMismatch = false,
} = {}) {
    const PATHS = requirePaths();
    const { ensureDir, readJSON, writeJSON } = requireStorage();

    const botName = 'Full Reset Bot';
    // Multiple parallel stage workers can start in the same millisecond.
    const botKey = `manual-full-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const triggerFile = path.join(os.tmpdir(), `${botKey}.trigger`);
    const snapshotFile = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        centerPrice: 100,
        amaCenterPrice: 123.45,
        gridPriceOffsetPct: 0.8,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });
    writeJSON(triggerFile, { source: 'manual_grid_full_reset' });

    const expireCalls: Array<{ reason: string; manager: unknown; options: unknown }> = [];
    const persistedClears: string[] = [];
    const restoredRows: unknown[] = [];
    const recalcOptions: any[] = [];
    const expireSpy = (manager: any, reason: string, options: unknown) => {
        expireCalls.push({ manager, reason, options });
        // Mirror the production helper's in-memory half.
        manager._lastFilledPrice = null;
        manager._lastFilledType = null;
        manager._lastFilledAt = 0;
        manager.lastFillPivotSource = null;
        manager._lastFilledBuyPrice = null;
        manager._lastFilledSellPrice = null;
        manager._lastMarketFillPrice = null;
        manager._lastMarketFillType = null;
        manager._lastMarketFillAt = 0;
    };
    let guardedReadCalls = 0;
    let readResult: unknown = 'unset';
    const guardedRead = ambiguousConfirm
        ? (async () => { guardedReadCalls++; return guardedReadCalls === 1 ? [] : null; })
        : (ambiguous || genesisMismatch)
            ? (async () => { guardedReadCalls++; return null; })
            : null;
    installTriggerResetMocks({
        expireSpy,
        guardedRead,
        recalculateSpy: async (manager: any, opts: any) => {
            recalcOptions.push(opts);
            // Drive the guarded read inside recalculateGrid so the truncated
            // read flag is actually set for the rollback scenarios.
            if (ambiguousConfirm) {
                readResult = await opts.readOpenOrdersFn();
            } else if (ambiguous || genesisMismatch) {
                await opts.readOpenOrdersFn();
                if (genesisMismatch) manager._genesis = { priceLevelsHash: 'new-genesis' };
            }
        },
    });

    const wl = makeTempWhitelist({ [botKey]: { ama: true, dynamicWeight: true } });
    const restoreFs = patchBotsJson([{ name: botName, weightDistribution: { sell: 0.6, buy: 0.4 } }]);
    const logs: string[] = [];
    const persistedPivotRow = { price: 123.45, type: 'sell', fillsAt: 1700000000000, genesisHash: 'old-genesis' };
    const persistedMarketRow = { price: 123.45, type: 'sell', fillsAt: 1700000000000 };
    const accountOrders: any = noApi ? {} : {
        loadLastFillPivot: async () => persistedPivotRow,
        loadLastMarketFill: async () => persistedMarketRow,
        clearLastFillGuardRows: async () => {
            // Resolve on a later tick: the caller must AWAIT this before
            // recording success or clearing the trigger.
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (eraseFails) throw new Error('simulated persistence failure');
            persistedClears.push('both');
        },
        restoreLastFillGuardRows: async (pivot: unknown, marketFill: unknown) => { restoredRows.push(pivot, marketFill); },
    };
    const manager: any = {
        config: { name: botName, botKey, botIndex: 0, weightDistribution: { sell: 0.6, buy: 0.4 } },
        funds: { btsFeesOwed: 2 },
        accountOrders,
        _fillProcessingLock: { acquire: async (fn: () => Promise<void>) => fn() },
        _fundLock: { acquire: async (fn: () => Promise<void>) => fn() },
        startBootstrap: () => {},
        finishBootstrap: () => {},
        persistGrid: async () => {},
        _spreadRailOversubscribed: { side: 'sell', virtual: 1, free: 2, at: 3 },
        _lastFilledPrice: 123.45,
        _lastFilledType: 'sell',
        _lastFilledAt: 1700000000000,
        lastFillPivotSource: 'fill',
        _lastFilledBuyPrice: 100,
        _lastFilledSellPrice: 123.45,
        _lastMarketFillPrice: 123.45,
        _lastMarketFillType: 'sell',
        _lastMarketFillAt: 1700000000000,
    };
    const self: any = {
        config: manager.config,
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager,
        accountOrders,
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _lastGeometryResyncPivotKey: 'old-pivot',
        _geometryResyncWarnedPivotKey: 'old-warn-pivot',
        _lastSpreadStaleResyncAt: 1,
        _outOfSpreadSince: 1,
        _outOfSpreadStaleWarned: true,
        _outOfSpreadTransientCount: 3,
        _outOfSpreadToleranceSince: 5,
        _outOfSpreadNoProgressWarned: true,
        _spreadCorrectionStall: 'last-fill-blocked',
        _spreadStallArmed: true,
        _log: (msg: string) => logs.push(msg),
        _warn: (msg: string) => logs.push(`WARN:${msg}`),
    };

    try {
        const { handlePendingTriggerReset } = require('../modules/dexbot_maintenance_runtime');
        const ok = await handlePendingTriggerReset(self);

        if (noApi) {
            assert.strictEqual(ok, false, 'missing guard persistence API must refuse the reset');
            assert.strictEqual(expireCalls.length, 0, 'no live clear when the API preflight fails');
            assert.deepStrictEqual(persistedClears, []);
            assert.strictEqual(manager._lastFilledPrice, 123.45, 'guard must stay intact');
            assert.strictEqual(self._lastGeometryResyncPivotKey, 'old-pivot');
            assert.ok(fs.existsSync(triggerFile), 'trigger must be retained for retry');
            assert.ok(
                logs.some((msg) => String(msg).includes('Guard persistence API unavailable')),
                'missing API must be warned loudly'
            );
            return;
        }

        assert.strictEqual(expireCalls.length, 1, 'guard expiry should run exactly once');
        assert.strictEqual(expireCalls[0].reason, 'manual full grid reset');
        assert.strictEqual(expireCalls[0].manager, manager);
        assert.deepStrictEqual(expireCalls[0].options, { skipPersistedClear: true }, 'disk deletes must be deferred to the reset caller');
        assert.strictEqual(recalcOptions.length, 1, 'recalculateGrid should receive the resync options');
        assert.strictEqual(recalcOptions[0]?.clearLastFillGuards, true, 'rebuild must be told to skip re-arm/fill anchor');

        if (ambiguous || ambiguousConfirm || eraseFails || genesisMismatch) {
            assert.strictEqual(ok, false, 'a failed rebuild must not commit the reset');
            assert.deepStrictEqual(persistedClears, [], 'disk rows must survive a failed rebuild');
            assert.strictEqual(restoredRows.length, 2, 'both row slots must be passed to the restore helper');
            assert.deepStrictEqual(
                restoredRows[0],
                genesisMismatch ? null : persistedPivotRow,
                'a pivot bound to a superseded genesis must NOT be restored'
            );
            assert.deepStrictEqual(restoredRows[1], persistedMarketRow, 'market-fill row must always be restored');
            assert.strictEqual(manager._lastFilledPrice, 123.45, 'live pivot must be restored');
            assert.strictEqual(manager._lastMarketFillPrice, 123.45, 'live market row must be restored');
            assert.strictEqual(manager.lastFillPivotSource, 'fill');
            assert.strictEqual(self._lastGeometryResyncPivotKey, 'old-pivot', 'watchdog state must not be cleared on failure');
            assert.strictEqual(self._spreadCorrectionStall, 'last-fill-blocked');
            assert.ok(fs.existsSync(triggerFile), 'trigger must be retained for retry');
            assert.strictEqual(readJSON(snapshotFile).lastGridResetSource, undefined, 'no reset metadata on failure');
            assert.ok(
                logs.some((msg) => String(msg).includes('[FULL-RESET] Guard state rolled back; trigger retained')),
                'a successful rollback must be auditable'
            );
            if (ambiguousConfirm) {
                assert.strictEqual(readResult, null, 'a truncated confirm must abort recalculateGrid before rebuilding');
                assert.strictEqual(guardedReadCalls, 2, 'empty read + confirm read must both be attempted');
            }
            if (genesisMismatch) {
                assert.ok(
                    logs.some((msg) => String(msg).includes('genesis changed during the failed rebuild')),
                    'dropping the dead pivot must be logged'
                );
            }
            if (eraseFails) {
                assert.ok(
                    logs.some((msg) => String(msg).includes('Failed to clear persisted guard rows')),
                    'erase failure must be warned loudly'
                );
            }
        } else {
            assert.strictEqual(ok, true, 'full-reset trigger should succeed');
            assert.deepStrictEqual(persistedClears, ['both'], 'both persisted rows must be erased in ONE awaited call');
            assert.strictEqual(restoredRows.length, 0, 'a successful reset must not roll back');
            assert.strictEqual(manager._lastFilledPrice, null);
            assert.strictEqual(manager.lastFillPivotSource, null);
            assert.strictEqual(manager._lastMarketFillPrice, null);
            assert.strictEqual(self._lastGeometryResyncPivotKey, '');
            assert.strictEqual(self._geometryResyncWarnedPivotKey, '');
            assert.strictEqual(self._lastSpreadStaleResyncAt, 0);
            assert.strictEqual(self._outOfSpreadSince, 0);
            assert.strictEqual(self._outOfSpreadStaleWarned, false);
            assert.strictEqual(self._outOfSpreadTransientCount, 0);
            assert.strictEqual(self._outOfSpreadToleranceSince, 0);
            assert.strictEqual(self._outOfSpreadNoProgressWarned, false);
            assert.strictEqual(self._spreadCorrectionStall, null);
            assert.strictEqual(self._spreadStallArmed, false, 'stall cause and flag must never drift');
            assert.strictEqual(manager._spreadRailOversubscribed, null);
            const updated = readJSON(snapshotFile);
            assert.strictEqual(updated.lastGridResetSource, 'manual_grid_full_reset');
            assert.ok(
                logs.some((msg) => String(msg).includes('[FULL-RESET] Cleared persisted guard rows and spread watchdog memory.')),
                'full reset should log the committed guard clear'
            );
        }
    } finally {
        restoreFs();
        wl.cleanup();
        try { fs.unlinkSync(triggerFile); } catch (_) {}
        try { fs.unlinkSync(snapshotFile); } catch (_) {}
    }
}

async function testManualFullResetTriggerClearsLastFillGuards() {
    await runFullResetScenario();
}

async function testManualFullResetRollsBackOnFailedRebuild() {
    await runFullResetScenario({ ambiguous: true });
}

async function testManualFullResetAbortsOnTruncatedConfirm() {
    await runFullResetScenario({ ambiguousConfirm: true });
}

async function testManualFullResetRollsBackOnEraseFailure() {
    await runFullResetScenario({ eraseFails: true });
}

async function testManualFullResetDropsDeadPivotOnRollback() {
    await runFullResetScenario({ genesisMismatch: true });
}

async function testManualFullResetRejectsMissingPersistenceApi() {
    await runFullResetScenario({ noApi: true });
}

async function testForeignSourcedTriggerStaysManual() {
    const recalcOptions: any[] = [];
    await runManualTriggerScenario({
        botName: 'Foreign Source Bot',
        botKey: `foreign-source-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        snapshotPayload: {
            centerPrice: 100,
            amaCenterPrice: 123.45,
            source: _adapterSource,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        triggerPayload: { source: 'rms_structural_grid_resync' },
        mocks: { recalculateSpy: async (_manager: unknown, opts: unknown) => { recalcOptions.push(opts); } },
        assertUpdated: async (updated) => {
            assert.strictEqual(updated.lastGridResetSource, 'manual_grid_resync', 'foreign sources must keep legacy manual provenance');
            assert.strictEqual(updated.centerPrice, 123.45, 'foreign sources must keep the manual center refresh');
            assert.strictEqual(recalcOptions[0]?.clearLastFillGuards, false, 'foreign sources must not clear guards');
        },
    });
}

async function testManualNormalResetKeepsLastFillGuard() {
    const recalcOptions: any[] = [];
    const expireCalls: any[] = [];
    await runManualTriggerScenario({
        botName: 'Normal Reset Bot',
        botKey: `manual-normal-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        snapshotPayload: {
            centerPrice: 100,
            amaCenterPrice: 123.45,
            source: _adapterSource,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        mocks: {
            expireSpy: (...args: any[]) => { expireCalls.push(args); },
            recalculateSpy: async (_manager: unknown, opts: unknown) => { recalcOptions.push(opts); },
        },
        assertState: async (self) => {
            assert.strictEqual(expireCalls.length, 0, 'a plain manual reset must not clear guard references');
            assert.strictEqual(recalcOptions.length, 1);
            assert.strictEqual(recalcOptions[0]?.clearLastFillGuards, false, 'normal reset must keep the guard');
            assert.strictEqual(self.manager._lastFilledPrice, 7.7, 'live pivot must survive a normal reset');
            assert.strictEqual(self.manager.lastFillPivotSource, 'fill');
        },
        assertUpdated: async (updated) => {
            assert.strictEqual(updated.lastGridResetSource, 'manual_grid_resync');
        },
    });
}

async function testManualTriggerResetRefreshesCenterPrice() {
    await runManualTriggerScenario({
        botName: 'Manual Reset Bot',
        botKey: `manual-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        snapshotPayload: {
            centerPrice: 100,
            amaCenterPrice: 123.45,
            gridPriceOffsetPct: 0.8,
            source: _adapterSource,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        assertUpdated: async (updated, logs) => {
            assert.strictEqual(updated.centerPrice, 123.45, 'manual reset should refresh centerPrice from amaCenterPrice');
            assert.strictEqual(updated.gridCenterPrice, 123.45, 'manual reset should refresh gridCenterPrice from amaCenterPrice');
            assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'manual reset should preserve the AMA spread offset for the rebuild');
            assert.strictEqual(updated.lastGridResetSource, 'manual_grid_resync', 'manual reset should record manual reset provenance');
            assert.ok(
                logs.some((msg) => String(msg).includes('Refreshed AMA center snapshot for manual grid reset.')),
                'manual reset should log that the center snapshot was refreshed'
            );
        },
    });
}

async function testManualTriggerResetKeepsOffsetWhenCenterAlreadyCurrent() {
    await runManualTriggerScenario({
        botName: 'Manual Reset Current Bot',
        botKey: `manual-reset-current-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        snapshotPayload: {
            gridCenterPrice: 123.45,
            centerPrice: 123.45,
            amaCenterPrice: 123.45,
            gridPriceOffsetPct: 0.8,
            source: _adapterSource,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        assertUpdated: async (updated) => {
            assert.strictEqual(updated.centerPrice, 123.45, 'manual reset should leave the current AMA center intact');
            assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'manual reset should preserve the AMA spread offset when center is already current');
        },
    });
}

async function testMarketAdapterTriggerResetRefreshesAmaCenterPrice() {
    await runManualTriggerScenario({
        botName: 'Market Adapter Reset Bot',
        botKey: `market-adapter-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        snapshotPayload: {
            gridCenterPrice: 100,
            centerPrice: 100,
            amaCenterPrice: 123.45,
            gridPriceOffsetPct: 0.8,
            source: _adapterSource,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        triggerPayload: {
            source: _adapterSource,
            reason: 'market_adapter_delta_threshold',
            newCenterPrice: 100,
            amaCenterPrice: 123.45,
        },
        assertUpdated: async (updated, logs) => {
            assert.strictEqual(updated.centerPrice, 123.45, 'market-adapter reset should refresh centerPrice from latest amaCenterPrice');
            assert.strictEqual(updated.amaCenterPrice, 123.45, 'market-adapter reset should preserve raw AMA diagnostics');
            assert.strictEqual(updated.lastGridResetSource, 'market_adapter_delta_threshold', 'market-adapter reset should preserve the trigger reason as reset provenance');
            assert.ok(
                logs.some((msg) => String(msg).includes('AMA center grid reset')),
                'market-adapter reset should log that the AMA center snapshot was refreshed'
            );
        },
    });
}

async function testMarketAdapterBootstrapTriggerResetRecordsBootstrapSource() {
    await runManualTriggerScenario({
        botName: 'Market Adapter Bootstrap Bot',
        botKey: `market-adapter-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        snapshotPayload: {
            gridCenterPrice: 100,
            centerPrice: 100,
            amaCenterPrice: 123.45,
            source: _adapterSource,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        triggerPayload: {
            source: _adapterSource,
            reason: 'market_adapter_bootstrap',
            newCenterPrice: 100,
            amaCenterPrice: 123.45,
        },
        assertUpdated: async (updated, logs) => {
            assert.strictEqual(updated.centerPrice, 123.45, 'market-adapter bootstrap reset should refresh centerPrice from latest amaCenterPrice');
            assert.strictEqual(updated.amaCenterPrice, 123.45, 'market-adapter bootstrap reset should preserve raw AMA diagnostics');
            assert.strictEqual(updated.lastGridResetSource, 'market_adapter_bootstrap', 'market-adapter bootstrap reset should preserve bootstrap provenance');
            assert.ok(
                logs.some((msg) => String(msg).includes('AMA bootstrap grid reset')),
                'market-adapter bootstrap reset should log that the AMA center snapshot was refreshed'
            );
        },
    });
}

async function testMarketAdapterSlopeTriggerResetRecordsSlopeSource() {
    await runManualTriggerScenario({
        botName: 'Market Adapter Slope Bot',
        botKey: `market-adapter-slope-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        snapshotPayload: {
            gridCenterPrice: 100,
            centerPrice: 100,
            amaCenterPrice: 123.45,
            source: _adapterSource,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        triggerPayload: {
            source: _adapterSource,
            reason: 'market_adapter_ama_slope_delta_threshold',
            newCenterPrice: 100,
            amaCenterPrice: 123.45,
        },
        assertUpdated: async (updated, logs) => {
            assert.strictEqual(updated.centerPrice, 123.45, 'market-adapter slope reset should refresh centerPrice from latest amaCenterPrice');
            assert.strictEqual(updated.amaCenterPrice, 123.45, 'market-adapter slope reset should preserve raw AMA diagnostics');
            assert.strictEqual(updated.lastGridResetSource, 'market_adapter_ama_slope_delta_threshold', 'market-adapter slope reset should preserve slope provenance');
            assert.ok(
                logs.some((msg) => String(msg).includes('AMA slope grid reset')),
                'market-adapter slope reset should log that the AMA center snapshot was refreshed'
            );
        },
    });
}

function installDivergenceMocks(opts) {
    defineEsmMockAbs(require.resolve('../modules/bitshares_client'), NAMES.bitsharesClient, { BitShares: {}, waitForConnected: async () => {} });
    defineEsmMockAbs(require.resolve('../modules/order/utils/system'), NAMES.system, {
        retryPersistenceIfNeeded: async () => {},
        applyGridDivergenceCorrections: opts.applyCorrections,
        loadAmaCenterSnapshot: () => null,
        parseJsonWithComments: (text) => JSON.parse(text),
        nowIso: () => new Date().toISOString(),
        hasUnsettledFills: () => ({ unsettled: false, reason: null }),
        isLastFillPlacementBlocked: () => ({ blocked: false, pivot: null }),
        resolveGridUpdateBlockers: () => [],
        noteGridUpdateBlockers: () => ({ cycles: 0, escalate: false }),
        offMarketFill: () => null,
        readBotInFlightFlags: () => ({
            ok: true, batchInFlight: false, recoveryInFlight: false, deferredRebalance: false,
        }),
        readFillPipelineState: () => ({ ok: true, queued: 0, deferred: false, inFlight: 0, owed: 0 }),
        extractGoneOrderIds: () => new Set<string>(),
        extractUpdateTargetOrderIds: () => new Set<string>(),
        sleep: async () => {},
        expireLastFillGuardReferences: () => {},
        resolveGuardGenerationKey: () => '',
    });
    defineEsmMockAbs(require.resolve('../modules/order/grid'), NAMES.grid, {
        monitorDivergence: async () => {
            opts.markDivergenceChecked?.();
            return opts.divergence;
        },
        resolveRmsThresholdPct: () => 14.3,
    });
    defineEsmMockAbs(require.resolve('../modules/order/format'), NAMES.format, {
        formatPrice6: (value) => Number(value).toFixed(6),
        formatPercent: (value, decimals = 2) => Number(value).toFixed(decimals),
    });
    defineEsmMockAbs(require.resolve('../modules/order/utils/order'), NAMES.orderUtils, {
        virtualizeOrder: (order) => order,
        convertToSpreadPlaceholder: (order) => ({ ...order, type: 'spread', size: 0, state: 'virtual', orderId: null }),
        isSignificantSizeChange: () => true,
        resolveSizeUpdateMinChangePercent: () => 3,
        resolveSizeTolerancePercent: () => 0.1,
    });
    defineEsmMockAbs(require.resolve('../modules/launcher/market_adapter_runtime'), NAMES.marketAdapterRuntime, {
        getSharedMarketAdapterRuntime: () => ({
            syncBot: async () => ({ running: false, started: false, stopped: false }),
            releaseBot: async () => ({ running: false, stopped: false }),
        }),
    });
}

function makeDivergenceSelf(opts) {
    return {
        config: {
            botKey: opts.botKey,
            dryRun: true,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        _maintenanceCooldownCycles: 0,
        _dustSinceMap: new Map(),
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            orders: new Map([
                ['buy-0', { id: 'buy-0', type: 'buy', price: 1, size: 1 }],
            ]),
            recalculateFunds: async () => {},
            _clearStaleBroadcastFlag: () => {},
            clearStalePipelineOperations: () => {},
            isPipelineEmpty: () => ({ isEmpty: true }),
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
            checkSpreadCondition: async () => {
                opts.markSpreadChecked();
                return null;
            },
        },
        accountOrders: {
            loadGrid: () => [{ id: 'buy-0', type: 'buy', price: 1, size: 1 }],
        },
        _incomingFillQueue: opts.incomingFillQueue ?? [],
        _getPipelineSignals: () => ({
            incomingFillQueueLength: 0,
            shadowLocks: 0,
            batchInFlight: false,
            recoveryInFlight: false,
            livenessOk: true,
            broadcasting: false,
        }),
        _cancelDustOrders: async () => ({ cancelledCount: 0, batchResult: null }),
        _abortFlowIfIllegalState: async () => false,
        _performGridResync: async (_options?: any) => {
            opts.markResync?.();
            return true;
        },
        updateOrdersOnChainBatch: async () => {},
        updateOrdersOnChainPlan: async () => {},
        _persistAndRecoverIfNeeded: async () => {},
        _log: (msg) => opts.logs.push(String(msg)),
        _warn: (msg) => opts.logs.push(`WARN:${msg}`),
    };
}

async function testRmsDivergenceRunsFullGridResync() {
    let resyncOptions = null;
    let correctionCalled = false;
    let spreadChecked = false;
    const logs = [];

    installDivergenceMocks({
        applyCorrections: async () => {
            correctionCalled = true;
        },
        divergence: {
            needsUpdate: true,
            buy: { ratio: false, rms: true, metric: 14.8 },
            sell: { ratio: false, rms: false, metric: 0 },
        },
    });

    const { executeMaintenanceLogic } = require('../modules/dexbot_maintenance_runtime');
    const self = makeDivergenceSelf({
        botKey: 'rms-reset-bot-0',
        logs,
        markSpreadChecked: () => { spreadChecked = true; },
    });
    self.updateOrdersOnChainBatch = async () => {
        throw new Error('correction batch should not run for RMS resync');
    };
    self._performGridResync = async (options) => {
        resyncOptions = options;
        return true;
    };

    await executeMaintenanceLogic(self, 'unit-test-rms');

    assert.deepStrictEqual(resyncOptions, {
        refreshCenterPrice: false,
        centerRefreshContext: 'RMS structural grid resync',
        centerRefreshLabel: 'RMS structural grid resync',
        resetSource: 'rms_structural_grid_resync',
        clearLastFillGuards: false,
    }, 'RMS divergence should run full grid resync as state repair WITHOUT clearing the last-fill guards or re-anchoring (docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md §2 fix #1: re-anchoring orphaned live orders)');
    assert.strictEqual(correctionCalled, false, 'RMS divergence should not use correction-only path');
    assert.strictEqual(spreadChecked, false, 'maintenance should stop after full RMS resync');
    assert.ok(
        logs.some((msg) => msg.includes('[RMS] Grid update triggered by structural divergence during unit-test-rms')),
        'RMS divergence should be logged with [RMS] tag'
    );
    assert.ok(
        logs.some((msg) => msg.includes('threshold=') && msg.includes('TRIGGER-RESYNC')),
        'RMS divergence log should show threshold and trigger decision'
    );
}

async function testSpreadCheckRunsWithoutDivergence() {
    let spreadChecked = false;
    let correctionCalled = false;
    let resyncCalled = false;
    const logs = [];

    // Incidents scenario: the grid is internally consistent (order count was
    // restored to 20/20) so divergence is NOT flagged, yet the realized spread
    // is wide. The spread check must still run on this pipeline-empty tick.
    installDivergenceMocks({
        applyCorrections: async () => {
            correctionCalled = true;
        },
        divergence: {
            needsUpdate: false,
            buy: { updated: false, ratio: false, rms: false, metric: 0 },
            sell: { updated: false, ratio: false, rms: false, metric: 0 },
        },
    });

    const { executeMaintenanceLogic } = require('../modules/dexbot_maintenance_runtime');
    await executeMaintenanceLogic(
        makeDivergenceSelf({
            botKey: 'spread-no-divergence-bot-0',
            logs,
            markSpreadChecked: () => { spreadChecked = true; },
            markResync: () => { resyncCalled = true; },
        }),
        'unit-test-no-divergence'
    );

    assert.strictEqual(correctionCalled, false, 'no divergence → no divergence corrections should run');
    assert.strictEqual(resyncCalled, false, 'no divergence → no grid resync should run');
    assert.strictEqual(spreadChecked, true, 'spread check must run on a pipeline-empty tick even when divergence is not flagged');

    console.log('✓ spread check runs without divergence (no-divergence tick)');
}

async function testDivergenceDefersWhenFillQueuedMidTick() {
    let divergenceChecked = false;
    let correctionCalled = false;
    let resyncCalled = false;
    let spreadChecked = false;
    const logs = [];

    // A fill lands after the pipeline gate passed (the gate is mocked empty) but
    // before divergence detection. Fills are priority 1: the whole divergence
    // phase must be skipped — including the RMS resync path — so no correction
    // or resync runs against pre-fill budgets. The divergence fixture is flagged
    // so an unguarded tick would definitely take the resync branch.
    installDivergenceMocks({
        markDivergenceChecked: () => { divergenceChecked = true; },
        applyCorrections: async () => {
            correctionCalled = true;
        },
        divergence: {
            needsUpdate: true,
            buy: { ratio: false, rms: true, metric: 18 },
            sell: { ratio: false, rms: false, metric: 0 },
        },
    });

    const { executeMaintenanceLogic } = require('../modules/dexbot_maintenance_runtime');
    await executeMaintenanceLogic(
        makeDivergenceSelf({
            botKey: 'divergence-mid-tick-fill-bot-0',
            logs,
            incomingFillQueue: [{}],
            markSpreadChecked: () => { spreadChecked = true; },
            markResync: () => { resyncCalled = true; },
        }),
        'unit-test-mid-tick-fill'
    );

    assert.strictEqual(divergenceChecked, false, 'monitorDivergence must not run when a fill queued mid-tick');
    assert.strictEqual(correctionCalled, false, 'divergence corrections must be deferred when a fill queued mid-tick');
    assert.strictEqual(resyncCalled, false, 'RMS resync must be deferred when a fill queued mid-tick');
    assert.strictEqual(spreadChecked, false, 'the spread check keeps its own queue re-check and also defers');
    assert.ok(
        logs.some((msg) => String(msg).includes('[DIVERGENCE] Deferring divergence check: 1 fill(s) queued since pipeline gate')),
        'the deferral must be logged with the fill count and reason'
    );

    console.log('✓ divergence phase defers to a fill queued mid-tick');
}

async function testDexbotClassPerformGridResyncForwardsOptions() {
    let forwardedThis = null;
    let forwardedOptions = null;

    defineEsmMockAbs(require.resolve('../modules/dexbot_maintenance_runtime'), NAMES.maintenanceRuntime, {
        isOrderDoesNotExistError: () => false,
        usesAmaGridPrice: (bot) => /^ama(?:[1-4])?$/.test(String(bot?.gridPrice || '').trim().toLowerCase()),
        checkPipelineInFlightWatchdogs: () => {},
        performGridResync(bot, options = {}) {
            forwardedThis = bot;
            forwardedOptions = options;
            return Promise.resolve('forwarded');
        },
    });
    defineEsmMockAbs(require.resolve('../modules/bitshares_client'), NAMES.bitsharesClient, {
        BitShares: {},
        waitForConnected: async () => {},
        onReconnect: () => ({}),
    });
    defineEsmMockAbs(require.resolve('../modules/chain_orders'), NAMES.chainOrders, {});
    defineEsmMockAbs(require.resolve('../modules/order'), [], { OrderManager: class {}, grid: {} });
    defineEsmMockAbs(require.resolve('../modules/order/utils/system'), NAMES.system, {
        retryPersistenceIfNeeded: async () => {},
        initializeFeeCache: async () => {},
        applyGridDivergenceCorrections: async () => ({}),
        parseJsonWithComments: (text) => JSON.parse(text),
        nowIso: () => new Date().toISOString(),
        hasUnsettledFills: () => ({ unsettled: false, reason: null }),
        isLastFillPlacementBlocked: () => ({ blocked: false, pivot: null }),
        resolveGridUpdateBlockers: () => [],
        noteGridUpdateBlockers: () => ({ cycles: 0, escalate: false }),
        offMarketFill: () => null,
        readBotInFlightFlags: () => ({
            ok: true, batchInFlight: false, recoveryInFlight: false, deferredRebalance: false,
        }),
        readFillPipelineState: () => ({ ok: true, queued: 0, deferred: false, inFlight: 0, owed: 0 }),
        extractGoneOrderIds: () => new Set<string>(),
        extractUpdateTargetOrderIds: () => new Set<string>(),
        sleep: async () => {},
    });
    defineEsmMockAbs(require.resolve('../modules/order/utils/validate'), NAMES.validate, {
        hasExecutableActions: () => false,
        validateCreateTargetSlots: () => [],
    });
    defineEsmMockAbs(require.resolve('../modules/order/utils/order'), NAMES.orderUtils, {
        buildCreateOrderArgs: () => null,
        getOrderTypeFromUpdatedFlags: () => null,
        virtualizeOrder: (order) => order,
        correctAllPriceMismatches: () => [],
        convertToSpreadPlaceholder: (order) => ({ ...order, type: 'spread', size: 0, state: 'virtual', orderId: null }),
        buildOutsideInPairGroups: () => [],
        extractBatchOperationResults: () => [],
        buildFillKey: () => 'fill-key',
        isSignificantSizeChange: () => true,
        resolveSizeUpdateMinChangePercent: () => 3,
        resolveSizeTolerancePercent: () => 0.1,
    });
    defineEsmMockAbs(require.resolve('../modules/order/utils/math'), NAMES.math, {
        validateOrderSize: () => true,
        calculateRotationOrderSizes: () => ({}),
        cloneWeightDistribution: (weights, fallback) => weights || fallback || null,
    });
    defineEsmMockAbs(require.resolve('../modules/order/processed_fill_store'), NAMES.processedFillStore, {
        ProcessedFillStore: class {},
        PROCESSED_FILL_PERSISTENCE_MODES: {},
    });
    defineEsmMockAbs(require.resolve('../modules/dexbot_fill_runtime'), ['processSweepOrphanFill'], {});
    defineEsmMockAbs(require.resolve('../modules/credit_runtime'), [], class {});
    defineEsmMockAbs(require.resolve('../modules/order/grid_reconcile'), NAMES.startupReconcile, {
        attemptResumePersistedGridByPriceMatch: async () => null,
        decideStartupGridAction: () => null,
        reconcileGridOrders: async () => null,
    });
    defineEsmMockAbs(require.resolve('../modules/account_orders'), NAMES.accountOrders, {
        AccountOrders: class {},
        createBotKey: () => 'bot-key',
    });
    defineEsmMockAbs(require.resolve('../modules/bot_settings'), NAMES.botSettings, {
        normalizeBotEntry: (entry) => entry,
    });
    defineEsmMockAbs(require.resolve('../modules/order/format'), NAMES.format, {});

    const DEXBot = require('../modules/dexbot_class').default;
    const fakeBot = { config: { botKey: 'forward-bot' } };

    const options = {
        refreshCenterPrice: true,
        centerRefreshContext: 'RMS structural grid resync',
        resetSource: 'rms_structural_grid_resync',
    };

    const result = await DEXBot.prototype._performGridResync.call(fakeBot, options);

    assert.strictEqual(result, 'forwarded');
    assert.strictEqual(forwardedThis, fakeBot, 'wrapper should preserve the bot instance');
    assert.strictEqual(forwardedOptions, options, 'wrapper should forward resync options unchanged');
}

const STAGES = {
    resync_applies_volatility_weights: testPerformGridResyncAppliesVolatilityOnlyDynamicWeights,
    refresh_applies_live_weights: testRefreshDynamicWeightDistributionAppliesAndFallsBack,
    refresh_stale_fallback: testRefreshDynamicWeightDistributionStaleFallback,
    refresh_reloads_whitelist_flags: testRefreshDynamicWeightDistributionReloadsWhitelistFlags,
    refresh_rejects_stale_base_weights: testRefreshDynamicWeightDistributionRejectsStaleBaseWeights,
    metadata_records_actual_reset: testUpdateBotGridResetMetadataRecordsActualReset,
    metadata_rejects_invalid_snapshot: testUpdateBotGridResetMetadataRejectsInvalidSnapshot,
    manual_full_reset_clears_last_fill_guards: testManualFullResetTriggerClearsLastFillGuards,
    manual_full_reset_rolls_back_on_failed_rebuild: testManualFullResetRollsBackOnFailedRebuild,
    manual_full_reset_aborts_on_truncated_confirm: testManualFullResetAbortsOnTruncatedConfirm,
    manual_full_reset_rolls_back_on_erase_failure: testManualFullResetRollsBackOnEraseFailure,
    manual_full_reset_drops_dead_pivot_on_rollback: testManualFullResetDropsDeadPivotOnRollback,
    manual_full_reset_rejects_missing_persistence_api: testManualFullResetRejectsMissingPersistenceApi,
    foreign_sourced_trigger_stays_manual: testForeignSourcedTriggerStaysManual,
    manual_normal_reset_keeps_guard: testManualNormalResetKeepsLastFillGuard,
    manual_trigger_reset_refreshes_center_price: testManualTriggerResetRefreshesCenterPrice,
    manual_trigger_reset_keeps_offset_when_current: testManualTriggerResetKeepsOffsetWhenCenterAlreadyCurrent,
    market_adapter_trigger_reset_refreshes_center: testMarketAdapterTriggerResetRefreshesAmaCenterPrice,
    market_adapter_bootstrap_trigger_reset: testMarketAdapterBootstrapTriggerResetRecordsBootstrapSource,
    market_adapter_slope_trigger_reset: testMarketAdapterSlopeTriggerResetRecordsSlopeSource,
    rms_divergence_runs_full_grid_resync: testRmsDivergenceRunsFullGridResync,
    spread_check_runs_without_divergence: testSpreadCheckRunsWithoutDivergence,
    divergence_defers_when_fill_queued_mid_tick: testDivergenceDefersWhenFillQueuedMidTick,
    dexbot_class_perform_grid_resync_forwards_options: testDexbotClassPerformGridResyncForwardsOptions,
};

// Stages are grouped into units by mock compatibility. A unit runs every stage
// it lists sequentially in one worker, so they must share an identical mock set
// and the module under test must hold no cross-stage state:
//   - both whitelist-refresh scenarios install installCoreResyncMocks({live});
//   - the metadata scenarios install no mocks and only touch per-bot files;
//   - the five manual/market-adapter trigger scenarios all install
//     installTriggerResetMocks().
// The refresh stale/base-mismatch scenarios vary the mock's snapshotMode, and
// the volatility/RMS/spread scenarios install closures that differ per stage,
// so each of those stays its own unit.
const STAGE_UNITS = [
    'resync_applies_volatility_weights',
    ['refresh_applies_live_weights', 'refresh_reloads_whitelist_flags'],
    'refresh_stale_fallback',
    'refresh_rejects_stale_base_weights',
    ['metadata_records_actual_reset', 'metadata_rejects_invalid_snapshot'],
    // Own units: custom guard-expiry spy, recalculateGrid capture, and (for the
    // rollback case) a truncated-open-orders read.
    'manual_full_reset_clears_last_fill_guards',
    'manual_full_reset_rolls_back_on_failed_rebuild',
    'manual_full_reset_aborts_on_truncated_confirm',
    'manual_full_reset_rolls_back_on_erase_failure',
    'manual_full_reset_drops_dead_pivot_on_rollback',
    'manual_full_reset_rejects_missing_persistence_api',
    'foreign_sourced_trigger_stays_manual',
    'manual_normal_reset_keeps_guard',
    [
        'manual_trigger_reset_refreshes_center_price',
        'manual_trigger_reset_keeps_offset_when_current',
        'market_adapter_trigger_reset_refreshes_center',
        'market_adapter_bootstrap_trigger_reset',
        'market_adapter_slope_trigger_reset',
    ],
    'rms_divergence_runs_full_grid_resync',
    'spread_check_runs_without_divergence',
    // Installs its own divergence mock (queued-fill fixture) — keep as its own unit.
    'divergence_defers_when_fill_queued_mid_tick',
    'dexbot_class_perform_grid_resync_forwards_options',
];

runEsmMockStagesGrouped(STAGE_UNITS, async (stage) => {
    await STAGES[stage]();
    console.log(`  ✓ ${stage}`);
});

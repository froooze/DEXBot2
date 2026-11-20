'use strict';

const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM namespaces are frozen and cannot be swapped via require.cache;
// the credit runtime and maintenance runtime modules are replaced through the
// loader-hook harness before dexbot_class is loaded.
esmMockEntry();

console.log('Running dexbot credit wiring test');

const calls = [];

// Static methods dexbot_class (and its sub-runtimes) may touch on the
// maintenance runtime module during construction/wiring.
const maintenanceStaticNoops = {
    cancelDustOrders: async () => ({ cancelledCount: 0, batchResult: null }),
    clearDustMaintenanceTimer: () => {},
    scheduleDustMaintenanceCheck: () => {},
    seedDustTimersFromPartialUpdates: async () => {},
    executeMaintenanceLogic: async () => {},
    getMetrics: () => ({}),
    getPipelineSignals: () => ({
        incomingFillQueueLength: 0,
        shadowLocks: 0,
        batchInFlight: false,
        recoveryInFlight: false,
        livenessOk: true,
        broadcasting: false,
    }),
    handlePendingTriggerReset: async () => {},
    isOpenOrdersSyncLoopEnabled: () => false,
    markGridActivity: () => {},
    performGridResync: async () => {},
    refreshDynamicWeightDistribution: () => {},
    releaseMarketAdapterRuntime: () => {},
    requestGridReset: () => {},
    runDustHealthCheck: async () => {},
    runGridMaintenance: async () => {},
    setupBlockchainFetchInterval: () => {},
    setupDustHealthCheckInterval: () => {},
    setupTriggerFileDetection: () => {},
    startOpenOrdersSyncLoop: () => {},
    stopBlockchainFetchInterval: () => {},
    stopOpenOrdersSyncLoop: () => {},
    syncOpenOrdersAndProcessFills: async () => {},
    wireStructuralGridResyncRequest: () => {},
};

defineEsmMockAbs(require.resolve('../modules/dexbot_maintenance_runtime'), [
    'isOrderDoesNotExistError',
    'usesAmaGridPrice',
    // dexbot_fill_runtime statically imports the leak watchdog for its
    // parked-queue retry path; the mock must expose the new named export.
    'checkPipelineInFlightWatchdogs',
], {
    ...maintenanceStaticNoops,
    isOrderDoesNotExistError: () => false,
    checkPipelineInFlightWatchdogs: () => {},
    // market_adapter named-imports this from the maintenance runtime module;
    // replicate grid_price_source's canonical helper so runtime_settings
    // resolution keeps working under the mock.
    usesAmaGridPrice: (bot) => /^ama(?:[1-4])?$/.test(String(bot?.gridPrice || '').trim().toLowerCase()),
    performPeriodicGridChecks: async function () {
        calls.push('grid-maintenance');
        return 'grid-ok';
    },
});

class FakeCreditRuntime {
    [key: string]: any;
    constructor(bot) {
        this.bot = bot;
        this.loadStateCalls = 0;
        this.runMaintenanceCalls = [];
        this.runCreditWatchdogCalls = 0;
    }

    async loadState() {
        this.loadStateCalls += 1;
    }

    async runMaintenance(context) {
        this.runMaintenanceCalls.push(context);
        calls.push(`credit-${context}`);
        return { context };
    }

    async runCreditWatchdog() {
        this.runCreditWatchdogCalls += 1;
        calls.push('credit-watchdog');
        return { mpa: null, credit: null };
    }
}

defineEsmMockAbs(require.resolve('../modules/credit_runtime'), [], FakeCreditRuntime);

async function main() {
    let bot;
    try {
        const DEXBot = require('../modules/dexbot_class').default;

        bot = new DEXBot({
            name: 'credit-bot',
            active: true,
            dryRun: false,
            preferredAccount: 'alice',
            assetA: 'BTS',
            assetB: 'HONEST.USD',
            startPrice: 'pool',
            minPrice: '3x',
            maxPrice: '3x',
            incrementPercent: 0.5,
            debtPolicy: {
                lending: [{
                    asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
                    type: 'mpa',
                    maxBorrowAmount: 1000,
                    maxCollateralAmount: 10000,
                    minCollateralRatio: 2,
                    maxCollateralRatio: 2.5,
                }],
            },
        }, { logPrefix: '[test]' });

        const runtime = bot._getCreditRuntime();
        assert(runtime, 'credit runtime should be created when supported debtPolicy.lending exists');

        await bot._setupCreditRuntime();
        assert.strictEqual(runtime.loadStateCalls, 1, 'startup wiring should load runtime state');

        await bot._runCreditRuntimeMaintenance('startup');
        assert.deepStrictEqual(runtime.runMaintenanceCalls, ['startup'], 'startup should run credit maintenance once');

        const result = await bot._performPeriodicGridChecks();
        assert.strictEqual(result, 'grid-ok', 'periodic maintenance should preserve grid result');
        assert.deepStrictEqual(calls, ['credit-startup', 'grid-maintenance'], 'periodic grid checks should not touch credit runtime');
        assert.deepStrictEqual(runtime.runMaintenanceCalls, ['startup'], 'credit runMaintenance should not be called from periodic grid checks');

        bot._setupCreditWatchdogInterval();
        assert.ok(bot._creditWatchdogInterval, 'credit watchdog interval should be created');
        assert.strictEqual(runtime.runCreditWatchdogCalls, 0, 'watchdog should not fire immediately');

        const legacyBot = new DEXBot({
            name: 'legacy-credit-bot',
            active: true,
            dryRun: false,
            preferredAccount: 'alice',
            assetA: 'BTS',
            assetB: 'HONEST.USD',
            startPrice: 'pool',
            minPrice: '3x',
            maxPrice: '3x',
            incrementPercent: 0.5,
            debtPolicy: { mpa: { targetCollateralRatio: 2 } },
        }, { logPrefix: '[test-legacy]' });
        assert.strictEqual(legacyBot._getCreditRuntime(), null, 'legacy flat debtPolicy should not create a no-op credit runtime');
    } finally {
        bot._stopCreditWatchdogInterval();
    }

    console.log('dexbot credit wiring test passed');
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});

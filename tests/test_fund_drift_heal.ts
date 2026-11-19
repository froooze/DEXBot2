/**
 * tests/test_fund_drift_heal.ts
 *
 * Trust-chain free-balance heal (FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL) and the
 * one-sided persistent drift ledger that gates it.
 *
 * Background (a live market-pair bot, Sep 2026): a fill/broadcast chaos window
 * left the tracked SELL free balance ~74 units short of the chain total. State
 * recovery kept failing on the SAME one-sided drift: committed-side
 * recalibration re-seeds grid sizes but free balances are never derived from
 * chain (shared-account safety). This suite verifies the opt-in heal seeds the
 * tracked free balance from the fresh chain total minus the reconciled
 * committed grid — only when the operator enabled it, the drift is one-sided,
 * and the same side+direction persisted across checks that are also spread
 * over time; and that the ledger gates / clears correctly.
 *
 * HEAL-010..060 — _tryTrustChainFreeHeal (modules/order/accounting):
 *   heal/refusal matrix (flag, persistence count, persistence duration,
 *   one-sidedness, direction re-validation, committed>total, shared account).
 * LEDGER-070..090 — _verifyFundInvariants ledger updates (side/direction,
 *   count accumulation, clear-on-pass, both-side reset).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// registerAllocation() rewrites a shared JSON registry. The test runner executes
// suites in parallel, so give this process its own profile root (set BEFORE any
// module load — fund_registry.ts snapshots REGISTRY_FILE at load time) to keep
// the HEAL-060 fixture hermetic.
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-heal-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;

const AccountingModule = require('../modules/order/accounting');
const Accountant = AccountingModule.default;
const fundRegistry = require('../modules/fund_registry');
const { createSilentLogger } = require('./helpers/silent_logger');
const { FILL_PROCESSING } = require('../modules/constants');

const now = Date.now();
// Unique (per-run) account names keep the fund-registry fixture hermetic — no
// dependence on whatever accounts other suites register on disk.
const nonSharedAccount = `test-account-${now}`;
// Ledger fixture: persistent episode that satisfies both gates (count >= 2
// and a wall-clock span above FUND_INVARIANT_HEAL_MIN_PERSIST_MS).
const persistentLedger = (side: string, direction: string, count: number = 2) => ({
    side,
    direction,
    count,
    firstAt: now - 120_000,
    lastAt: now,
});

function makeDriftValidation({ driftBuy = 0, allowedBuy = 100, driftSell = 0, allowedSell = 100 } = {}) {
    return { driftBuy, allowedDriftBuy: allowedBuy, driftSell, allowedDriftSell: allowedSell };
}

async function testHEAL010_FlagOffRefuses() {
    console.log('\n[HEAL-010] Flag off (default) refuses the heal and never mutates balances...');
    const mgr: any = {
        config: { gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: false } },
        account: nonSharedAccount,
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 300000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 74.1 } } },
        _fundDriftLedger: persistentLedger('sell', 'tracked-low'),
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftSell: 74.41, allowedSell: 0.56 }));
    assert.strictEqual(res, null, 'flag off must refuse');
    assert.strictEqual(mgr.accountTotals.sellFree, 414.84, 'sellFree must not change');
    assert.ok(mgr._fundDriftLedger, 'ledger must stay untouched');
    console.log('✓ HEAL-010 passed');
}

async function testHEAL020_NotEnoughPersistence() {
    console.log('\n[HEAL-020] One-sided drift with insufficient persistence count refuses...');
    const mgr: any = {
        config: { gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true, FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2 } },
        account: nonSharedAccount,
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 300000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 74.1 } } },
        _fundDriftLedger: persistentLedger('sell', 'tracked-low', 1),
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftSell: 74.41, allowedSell: 0.56 }));
    assert.strictEqual(res, null, 'count 1 < min 2 must refuse');
    assert.strictEqual(mgr.accountTotals.sellFree, 414.84);
    console.log('✓ HEAL-020 passed');
}

async function testHEAL025_NotEnoughWallClockSpan() {
    console.log('\n[HEAL-025] Sub-second double-recalc span refuses despite enough checks...');
    const mgr: any = {
        config: {
            gridLimits: {
                FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true,
                FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2,
                FUND_INVARIANT_HEAL_MIN_PERSIST_MS: 30_000,
            },
        },
        account: nonSharedAccount,
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 300000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 74.1 } } },
        // count=3 but first/last span only 10ms → two back-to-back recalc
        // calls within one busy fill cycle, must NOT qualify as persistent.
        _fundDriftLedger: { side: 'sell', direction: 'tracked-low', count: 3, firstAt: now - 10, lastAt: now },
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftSell: 74.41, allowedSell: 0.56 }));
    assert.strictEqual(res, null, 'span < min persist ms must refuse');
    assert.strictEqual(mgr.accountTotals.sellFree, 414.84);
    console.log('✓ HEAL-025 passed');
}

async function testHEAL030_TwoSidedDriftRefuses() {
    console.log('\n[HEAL-030] Two-sided drift refuses even with full eligibility...');
    const mgr: any = {
        config: { gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true, FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2 } },
        account: nonSharedAccount,
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 320000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 74.1 } } },
        _fundDriftLedger: persistentLedger('sell', 'tracked-low'),
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftBuy: 16900, allowedBuy: 320, driftSell: 74.41, allowedSell: 0.56 }));
    assert.strictEqual(res, null, 'both sides violated must refuse (residue must be unambiguous)');
    console.log('✓ HEAL-030 passed');
}

async function testHEAL035_DirectionRevalidatedAtHealTime() {
    console.log('\n[HEAL-035] Direction flip between checks and heal-time re-validation refuses...');
    const mgr: any = {
        config: { gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true, FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2 } },
        account: nonSharedAccount,
        assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
        // Current mismatch: chain ABOVE tracked → tracked-low.
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 300000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 74.1 } } },
        // Ledger claims the opposite direction (stale/incorrect episode).
        _fundDriftLedger: persistentLedger('sell', 'tracked-high'),
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftSell: 74.41, allowedSell: 0.56 }));
    assert.strictEqual(res, null, 'direction mismatch must refuse');
    assert.strictEqual(mgr.accountTotals.sellFree, 414.84);
    console.log('✓ HEAL-035 passed');
}

async function testHEAL040_SeedsSellFree() {
    console.log('\n[HEAL-040] Eligible one-sided SELL drift seeds sellFree from chain total − committed...');
    const mgr: any = {
        config: {
            gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true, FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2 },
            botKey: 'grid-bot',
        },
        account: nonSharedAccount,
        assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 300000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 74.1 } } },
        _fundDriftLedger: persistentLedger('sell', 'tracked-low'),
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftSell: 74.41, allowedSell: 0.56 }));
    assert.ok(res, 'eligible heal must apply');
    assert.strictEqual(res.side, 'sell');
    assert.ok(Math.abs(res.seededFree - (563.3516 - 74.1)) < 1e-9, `seededFree=${res.seededFree} must be chainTotal − committed`);
    assert.strictEqual(res.committed, 74.1);
    assert.strictEqual(res.chainTotal, 563.3516);
    assert.strictEqual(mgr.accountTotals.sellFree, 563.3516 - 74.1, 'sellFree must be seeded');
    assert.strictEqual(mgr._fundDriftLedger, null, 'ledger cleared after healing (episode closed)');
    console.log('✓ HEAL-040 passed');
}

async function testHEAL045_CommittedOverTotalRefuses() {
    console.log('\n[HEAL-045] committed > chainTotal refuses (broken state, fail loudly)...');
    const mgr: any = {
        config: {
            gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true, FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2 },
            botKey: 'grid-bot',
        },
        account: nonSharedAccount,
        assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
        // Committed (90) exceeds the chain total (80): books hold more orders
        // than the chain can cover — seeding free=0 would re-trip drift. Note
        // committed > chainTotal always reads as tracked-HIGH at heal time
        // (expected >= committed > chainTotal).
        accountTotals: { sell: 80, sellFree: 5, buy: 300000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 90 } } },
        _fundDriftLedger: persistentLedger('sell', 'tracked-high'),
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    let refusedLogged = '';
    mgr.logger.log = (msg: string) => { if (typeof msg === 'string' && msg.includes('exceeds chain total')) refusedLogged = msg; };
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftSell: 15, allowedSell: 0.08 }));
    assert.strictEqual(res, null, 'committed > total must refuse the heal');
    assert.match(refusedLogged, /exceeds chain total/, 'refusal must be logged');
    assert.strictEqual(mgr.accountTotals.sellFree, 5, 'sellFree untouched on refusal');
    console.log('✓ HEAL-045 passed');
}

async function testHEAL050_SeedsBuyFree() {
    console.log('\n[HEAL-050] Eligible one-sided BUY drift seeds buyFree...');
    const mgr: any = {
        config: {
            gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true, FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2 },
            botKey: 'grid-bot',
        },
        account: nonSharedAccount,
        assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
        accountTotals: { sell: 100, sellFree: 90, buy: 320000, buyFree: 290000 },
        funds: { committed: { chain: { buy: 10000, sell: 10 } } },
        _fundDriftLedger: persistentLedger('buy', 'tracked-low'),
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    const res = await accountant._tryTrustChainFreeHeal(mgr, makeDriftValidation({ driftBuy: 16900, allowedBuy: 320 }));
    assert.ok(res, 'eligible BUY heal must apply');
    assert.strictEqual(res.side, 'buy');
    assert.strictEqual(mgr.accountTotals.buyFree, 320000 - 10000, 'buyFree must be seeded');
    console.log('✓ HEAL-050 passed');
}

async function testHEAL060_SharedAccountGuard() {
    console.log('\n[HEAL-060] Shared account refuses unless allow-shared...');
    const acct = `shared-${Date.now()}`;
    try {
        await fundRegistry.registerAllocation(acct, 'botA', 'sell', 0.5);
        await fundRegistry.registerAllocation(acct, 'botB', 'sell', 0.5);
        assert.ok(fundRegistry.getRegisteredBots(acct).length >= 2, 'fixture must register 2 bots');

        const makeMgr = (allowShared: boolean) => ({
            config: {
                gridLimits: { FUND_INVARIANT_HEAL_ON_RECOVERY_FAIL: true, FUND_INVARIANT_HEAL_ALLOW_SHARED: allowShared, FUND_INVARIANT_HEAL_MIN_PERSISTENT_CHECKS: 2 },
                botKey: 'botA',
            },
            account: acct,
            assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
            accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 300000, buyFree: 290000 },
            funds: { committed: { chain: { buy: 10000, sell: 74.1 } } },
            _fundDriftLedger: persistentLedger('sell', 'tracked-low'),
            logger: createSilentLogger(),
        });

        const refusedMgr = makeMgr(false);
        let refusalLogged = '';
        refusedMgr.logger.log = (msg: string) => { if (typeof msg === 'string' && msg.includes('refused')) refusalLogged = msg; };
        const accountantA = new Accountant(refusedMgr);
        const refused = await accountantA._tryTrustChainFreeHeal(refusedMgr, makeDriftValidation({ driftSell: 74.41, allowedSell: 0.56 }));
        assert.strictEqual(refused, null, 'shared account without allow-shared must refuse');
        assert.match(refusalLogged, /refused/, 'refusal must be logged');
        assert.strictEqual(refusedMgr.accountTotals.sellFree, 414.84, 'sellFree untouched on refusal');

        const allowedMgr = makeMgr(true);
        const accountantB = new Accountant(allowedMgr);
        const res = await accountantB._tryTrustChainFreeHeal(allowedMgr, makeDriftValidation({ driftSell: 74.41, allowedSell: 0.56 }));
        assert.ok(res, 'allow-shared override must heal');
        assert.strictEqual(allowedMgr.accountTotals.sellFree, 563.3516 - 74.1);
        console.log('✓ HEAL-060 passed');
    } finally {
        fundRegistry.resetRegistry();
    }
}

async function testLEDGER070_BuildsOnFirstViolation() {
    console.log('\n[LEDGER-070] First one-sided violation seeds the ledger with side/direction...');
    const mgr: any = {
        assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 303100, buyFree: 300000 },
        config: { gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 } },
        _fillBatchInFlight: 0,
        _orphanFillsCreditedAt: null,
        _fundDriftLedger: null,
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    accountant._attemptFundRecovery = async () => false;
    // chainFreeBuy=300000, chainFreeSell=414.84, chainBuy=3100, chainSell=74.1
    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 303100, 563.3516);
    assert.ok(mgr._fundDriftLedger, 'ledger must be created on violation');
    assert.strictEqual(mgr._fundDriftLedger.side, 'sell');
    assert.strictEqual(mgr._fundDriftLedger.direction, 'tracked-low');
    assert.strictEqual(mgr._fundDriftLedger.count, 1);
    console.log('✓ LEDGER-070 passed');
}

async function testLEDGER080_AccumulatesSameSideDirection() {
    console.log('\n[LEDGER-080] Same side+direction accumulates; passing state clears...');
    const mgr: any = {
        assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 303100, buyFree: 300000 },
        config: { gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 } },
        _fillBatchInFlight: 0,
        _orphanFillsCreditedAt: null,
        _fundDriftLedger: null,
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    accountant._attemptFundRecovery = async () => false;

    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 303100, 563.3516);
    assert.strictEqual(mgr._fundDriftLedger.count, 1);
    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 303100, 563.3516);
    assert.strictEqual(mgr._fundDriftLedger.count, 2, 'persistent same-side drift must accumulate');

    // Passing state (chain syncs up): ledger must clear.
    mgr.accountTotals.sell = 488.94;
    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 303100, 488.94);
    assert.strictEqual(mgr._fundDriftLedger, null, 'passing check must clear the ledger');
    console.log('✓ LEDGER-080 passed');
}

async function testINV100_UnreadablePipelineDefersThenEscalates() {
    console.log('\n[INV-100] an unreadable manager-scoped pipeline field defers, then escalates...');
    const limit: number = Number(FILL_PROCESSING.GRID_BLOCKED_ESCALATE_CYCLES) || 12;
    const args: [number, number, number, number, number, number] = [300000, 414.84, 3100, 74.1, 303100, 563.3516];
    // _verifyFundInvariants is called with the MANAGER (accounting.ts:550), so
    // readFillPipelineState sees only manager-scoped fields. Malforming the
    // bot-scoped _incomingFillQueue here would exercise a shape this call site
    // cannot produce. Both reachable triggers are covered.
    for (const bad of [
        { name: '_pendingFillCrawls (non-array)', field: '_pendingFillCrawls', value: 'broken' },
        { name: '_fillBatchInFlight (non-numeric)', field: '_fillBatchInFlight', value: 'broken' },
    ]) {
        const logs: Array<{ msg: string; level?: string }> = [];
        const mgr: any = {
            assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
            accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 303100, buyFree: 300000 },
            config: { gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 } },
            _pendingFillCrawls: [],
            _fillBatchInFlight: 0,
            _orphanFillsCreditedAt: null,
            _fundDriftLedger: null,
            logger: { level: 'debug', log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) },
        };
        mgr[bad.field] = bad.value;
        const accountant = new Accountant(mgr);
        accountant._attemptFundRecovery = async () => false;

        for (let cycle = 1; cycle < limit; cycle++) {
            await accountant._verifyFundInvariants(mgr, ...args);
            assert.strictEqual(mgr._fundDriftLedger, null, `${bad.name}: cycle ${cycle} must still defer`);
        }
        assert.strictEqual(mgr._fundInvariantUnreadableCycles, limit - 1, `${bad.name}: each unreadable cycle is counted`);
        await accountant._verifyFundInvariants(mgr, ...args);
        assert(logs.some((l) => l.msg.includes(`Fill pipeline unreadable for ${limit} cycles`) && l.level === 'error'),
            `${bad.name}: the escalation is observable at error level`);
        assert(mgr._fundDriftLedger, `${bad.name}: the forced check must run the CRITICAL guard`);

        // A readable pipeline resets the counter, so healthy cycles cannot accumulate.
        mgr[bad.field] = bad.field === '_pendingFillCrawls' ? [] : 0;
        await accountant._verifyFundInvariants(mgr, ...args);
        assert.strictEqual(mgr._fundInvariantUnreadableCycles, 0, `${bad.name}: readable state clears the streak`);
    }
    console.log('✓ INV-100 passed');
}

async function testLEDGER090_BothSidesAndFlipReset() {
    console.log('\n[LEDGER-090] Two-sided drift and direction flips reset the ledger...');
    const mgr: any = {
        assets: { assetA: { precision: 4 }, assetB: { precision: 4 } },
        accountTotals: { sell: 563.3516, sellFree: 414.84, buy: 303100, buyFree: 300000 },
        config: { gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 } },
        _fillBatchInFlight: 0,
        _orphanFillsCreditedAt: null,
        _fundDriftLedger: null,
        logger: createSilentLogger(),
    };
    const accountant = new Accountant(mgr);
    accountant._attemptFundRecovery = async () => false;

    // SELL-only violation → ledger seeded on SELL.
    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 303100, 563.3516);
    assert.strictEqual(mgr._fundDriftLedger.side, 'sell');
    assert.strictEqual(mgr._fundDriftLedger.count, 1);

    // Two-sided violation resets to null (not healable).
    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 320000, 563.3516);
    assert.strictEqual(mgr._fundDriftLedger, null, 'two-sided drift must reset the ledger');

    // Direction flip: tracked HIGH (chain below tracked) must reset the
    // previous tracked-low entry and record the new direction.
    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 303100, 563.3516);
    assert.strictEqual(mgr._fundDriftLedger.direction, 'tracked-low');
    await accountant._verifyFundInvariants(mgr, 300000, 414.84, 3100, 74.1, 303100, 400);
    assert.strictEqual(mgr._fundDriftLedger.direction, 'tracked-high', 'direction flip must replace the entry');
    assert.strictEqual(mgr._fundDriftLedger.count, 1, 'flip resets the persistence count');
    console.log('✓ LEDGER-090 passed');
}

async function runAllTests() {
    console.log('=== Fund-Drift Heal Test Suite ===\n');
    await testHEAL010_FlagOffRefuses();
    await testHEAL020_NotEnoughPersistence();
    await testHEAL025_NotEnoughWallClockSpan();
    await testHEAL030_TwoSidedDriftRefuses();
    await testHEAL035_DirectionRevalidatedAtHealTime();
    await testHEAL040_SeedsSellFree();
    await testHEAL045_CommittedOverTotalRefuses();
    await testHEAL050_SeedsBuyFree();
    await testHEAL060_SharedAccountGuard();
    await testLEDGER070_BuildsOnFirstViolation();
    await testLEDGER080_AccumulatesSameSideDirection();
    await testLEDGER090_BothSidesAndFlipReset();
    await testINV100_UnreadablePipelineDefersThenEscalates();
    console.log('\n=== All fund-drift heal tests passed! ===');
}

runAllTests()
    .catch((e: any) => { console.error(e); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });
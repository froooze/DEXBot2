/**
 * tests/test_guard_generation_and_gate_owner.ts
 *
 * Post-v1.7.3 propagation fixes, two families:
 *
 * GG-001..004 — the spread-stale watchdog used to key "one re-center per guard
 *   generation" off the armed pivot alone. A refused (off-market) sweep leaves
 *   that pivot COLD, so the key was '', the watermark could never be set, and
 *   the bounded pivot-expiry heal was unreachable for exactly the cold-pivot
 *   case it was written for (retrospective §9.12 Addendum 3 / §9.14). The key
 *   now has one owner over BOTH guard references, and the planner may report
 *   the cold-pivot bind by name without re-centering every cycle.
 *
 * GG-005..006 — deferral/scheduling gates still peeked raw in-flight counters,
 *   so an unreadable counter read as "idle" and opened the gate (INV-FILL-003).
 *   They now use the same owner as the destructive gates.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ORDER_TYPES, TIMING, GRID_LIMITS } = require('../modules/constants');
const {
    resolveGuardGenerationKey,
    liveRefusedFillLevels,
    hasLiveRefusedFillLevels,
} = require('../modules/order/utils/system');
const { trackOutOfSpreadStaleness } = require('../modules/dexbot_maintenance_runtime');
const { triggerStateRecoverySync, schedulePostRecoveryRebalance } = require('../modules/dexbot_state_recovery');

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`   ✓ ${name}`); }
    catch (err) { failures += 1; console.error(`   ✗ ${name}\n      ${(err as any)?.stack || err}`); }
}
function source(file: string): string {
    return fs.readFileSync(path.join(__dirname, '../../modules', file), 'utf8');
}

function stubSpreadBot(): any {
    return {
        _outOfSpreadSince: 0,
        _outOfSpreadStaleWarned: false,
        _outOfSpreadNoProgressWarned: false,
        _outOfSpreadTransientCount: 0,
        _lastSpreadStaleResyncAt: 0,
        _lastGeometryResyncPivotKey: '',
        _geometryResyncWarnedPivotKey: '',
        _spreadCorrectionStall: 'last-fill-blocked',
        _spreadRecheckTimer: null,
        _spreadRecheckInFlight: false,
        _shuttingDown: true,
        _log: () => {},
        manager: {
            outOfSpread: 2,
            resyncRequests: [] as any[],
            logger: { log: () => {} },
            _lastRefusedFillLevels: [] as any[],
            requestStructuralGridResync: async function (reason: string) {
                (this as any).resyncRequests.push(reason);
                return { scheduled: true };
            },
        },
    };
}

async function main() {
    console.log('=== Guard-generation key & in-flight owner tests ===\n');

    await test('GG-001 armed pivot wins; key unchanged from the old rule', () => {
        const mgr: any = {
            _lastFilledPrice: 0.44764,
            _lastFilledType: ORDER_TYPES.SELL,
            _lastFilledAt: Date.now(),
            _lastRefusedFillLevels: [{ price: 0.44, type: ORDER_TYPES.SELL, at: Date.now() - 1000 }],
        };
        assert.strictEqual(resolveGuardGenerationKey(mgr), `0.44764|${ORDER_TYPES.SELL}`);
    });

    await test('GG-002 cold pivot keys on the oldest live refused level, stably across a sweep', () => {
        const now = Date.now();
        const mgr: any = {
            _lastRefusedFillLevels: [
                { price: 0.44, type: ORDER_TYPES.SELL, at: now - 5000 },
                { price: 0.4405, type: ORDER_TYPES.SELL, at: now - 4000 },
                { price: 0.441, type: ORDER_TYPES.SELL, at: now - 3000 },
            ],
        };
        const key = resolveGuardGenerationKey(mgr);
        assert.strictEqual(key, `refused:0.44|${ORDER_TYPES.SELL}`);
        // Adding another rung of the same sweep must not fork the generation.
        mgr._lastRefusedFillLevels.push({ price: 0.4415, type: ORDER_TYPES.SELL, at: now - 1000 });
        assert.strictEqual(resolveGuardGenerationKey(mgr), key, 'a sweep must get ONE re-center budget');
        // A refused SELL rung must not be mistaken for a BUY-side geometry bind.
        assert.strictEqual(hasLiveRefusedFillLevels(mgr, ORDER_TYPES.BUY), false);
        assert.strictEqual(hasLiveRefusedFillLevels(mgr, ORDER_TYPES.SELL), true);
        assert.strictEqual(liveRefusedFillLevels(mgr, ORDER_TYPES.SELL).length, 4);
    });

    await test('GG-003 an expired marker leaves the key cold; legacy scalar still works', () => {
        const ttl = Number(GRID_LIMITS.LAST_FILL_REFUSED_LEVEL_TTL_MS);
        const mgr: any = {
            _lastRefusedFillLevels: [{ price: 0.44, type: ORDER_TYPES.SELL, at: Date.now() - ttl - 1000 }],
            _lastRefusedFillPrice: 0.44,
            _lastRefusedFillType: ORDER_TYPES.SELL,
            _lastRefusedFillAt: Date.now() - ttl - 1000,
        };
        assert.strictEqual(resolveGuardGenerationKey(mgr), '', 'expired refused levels must not bind a generation');
        mgr._lastRefusedFillAt = Date.now();
        assert.strictEqual(resolveGuardGenerationKey(mgr), `refused:0.44|${ORDER_TYPES.SELL}`, 'scalar fallback');
    });

    await test('GG-004 a cold-pivot guard generation reaches the bounded expiry heal', () => {
        const now = Date.now();
        const bot = stubSpreadBot();
        const key = `refused:0.44|${ORDER_TYPES.SELL}`;
        bot.manager._lastRefusedFillLevels = [{ price: 0.44, type: ORDER_TYPES.SELL, at: now - 1000 }];
        bot._lastGeometryResyncPivotKey = key; // the one re-center already happened
        assert.strictEqual(resolveGuardGenerationKey(bot.manager), key);

        // Before the bounded window: marker intact, no escalation.
        bot._outOfSpreadSince = now - (Number(TIMING.SPREAD_STALE_WARN_MS) + 60_000);
        let r = trackOutOfSpreadStaleness(bot, true, 0);
        assert.strictEqual(r.escalated, false, 'premature escalation');
        assert.strictEqual(bot.manager._lastRefusedFillLevels.length, 1, 'marker survives until expiry');

        // Past SPREAD_STALE_PIVOT_EXPIRE_MS: the SAME branch as an armed pivot fires.
        bot._outOfSpreadSince = now - (Number(TIMING.SPREAD_STALE_PIVOT_EXPIRE_MS) + 60_000);
        r = trackOutOfSpreadStaleness(bot, true, 0);
        assert.strictEqual(r.escalated, true, 'cold-pivot generation must reach the expiry heal');
        assert.strictEqual(bot.manager._lastRefusedFillLevels.length, 0, 'expiry clears the refused-level marker');
        assert.strictEqual(bot.manager._lastMarketFillPrice, null, 'expiry clears the market-fill reference');
        assert.strictEqual(resolveGuardGenerationKey(bot.manager), '', 'generation is cold after expiry');
    });

    await test('GG-005 no raw counter peeks remain in the deferral/scheduling gates', () => {
        const maintenance = source('dexbot_maintenance_runtime.ts');
        const recovery = source('dexbot_state_recovery.ts');
        assert.ok(!/!\s*bot\._recoverySyncInFlight\s*&&\s*!\s*bot\._batchInFlight/.test(maintenance),
            'lightweight-sync gate must use readBotInFlightFlags');
        assert.ok(!/\(bot\._batchInFlight\s*\|\|\s*0\)\s*>\s*0/.test(maintenance),
            'pipeline-clear drain must use readBotInFlightFlags');
        assert.ok(!/bot\._batchInFlight\s*>\s*0\s*\|\|\s*bot\._recoverySyncInFlight\s*>\s*0/.test(recovery),
            'post-recovery rebalance must use readBotInFlightFlags');
        assert.ok(/readBotInFlightFlags\(bot\)/.test(maintenance) && /readBotInFlightFlags\(bot\)/.test(recovery),
            'both modules must call the single owner');
        assert.strictEqual(typeof schedulePostRecoveryRebalance, 'function');
    });

    await test('GG-006 an unreadable in-flight counter does not start a second recovery sync', async () => {
        let fetches = 0;
        const bot: any = {
            manager: {
                _batchInFlight: 1,
                logger: { log: () => {} },
                fetchAccountTotals: async () => { fetches += 1; },
            },
            _batchInFlight: NaN, // unreadable: old code never read it here at all
            _recoverySyncInFlight: 0,
        };
        await triggerStateRecoverySync(bot, 'gg-006');
        assert.strictEqual(fetches, 0, 'unreadable/occupied pipeline must defer');
    });

    if (failures > 0) {
        console.error(`\n❌ ${failures} guard-generation assertion(s) failed`);
        process.exit(1);
    }
    console.log('\n✅ All guard-generation assertions passed');
}

if (require.main === module) {
    main().catch((err) => { console.error('GUARD-GENERATION TEST FAILURE:', err); process.exit(1); });
}

export { main };

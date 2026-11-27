/**
 * tests/test_guard_generation_and_gate_owner.ts
 *
 * Post-v1.7.3 propagation fixes, two families:
 *
 * GG-001..004 — the generation key used to have a second leg from a refused
 *   level marker. The whole marker family is now removed: an armed pivot keys
 *   as `price|side`, a cold reference keys as ''. The bounded-expiry heal still
 *   works for an ARMED generation; a cold one has no marker to clear.
 *
 * GG-005..006 — deferral/scheduling gates still peeked raw in-flight counters,
 *   so an unreadable counter read as "idle" and opened the gate (INV-FILL-003).
 *   They now use the same owner as the destructive gates; GG-005 pins ALL SEVEN
 *   gates (the four originally converted plus the fill consumer, open-orders
 *   sync loop and region-end drain).
 * GG-007..010 — fail-closed gates need a real wake. A malformed (NaN) counter
 *   or deferred stamp must defer the consumer AND be force-cleared; because a
 *   non-empty queue idle-gates maintenance, the parked-queue retry path must
 *   run the watchdog and re-consume (GG-009), and telemetry must not report
 *   "idle" while the gates defer (GG-010). Without these the safety net is fake.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ORDER_TYPES, TIMING } = require('../modules/constants');
const { resolveGuardGenerationKey } = require('../modules/order/utils/system');
const {
    trackOutOfSpreadStaleness,
    checkPipelineInFlightWatchdogs,
    getPipelineSignals,
    getMetrics,
} = require('../modules/dexbot_maintenance_runtime');
const { triggerStateRecoverySync, schedulePostRecoveryRebalance } = require('../modules/dexbot_state_recovery');
const { consumeFillQueue, scheduleDeferredFillRetry } = require('../modules/dexbot_fill_runtime');

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`   ✓ ${name}`); }
    catch (err) { failures += 1; console.error(`   ✗ ${name}\n      ${(err as any)?.stack || err}`); }
}
function source(file: string): string {
    return fs.readFileSync(path.join(__dirname, '../../modules', file), 'utf8');
}

/** Extract one function/method body by signature so a gate check is scoped to that gate. */
function functionBody(file: string, signature: string): string {
    const text = source(file);
    const start = text.indexOf(signature);
    assert.ok(start >= 0, `${file} must define ${signature}`);
    const open = text.indexOf('{', start + signature.length);
    assert.ok(open >= 0, `${signature} must have a body`);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    assert.fail(`${signature} has an unbalanced body`);
    return '';
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
            requestStructuralGridResync: async function (reason: string) {
                (this as any).resyncRequests.push(reason);
                return { scheduled: true };
            },
        },
    };
}

async function main() {
    console.log('=== Guard-generation key & in-flight owner tests ===\n');

    await test('GG-001 an armed pivot keys as price|side', () => {
        const mgr: any = {
            _lastFilledPrice: 0.44764,
            _lastFilledType: ORDER_TYPES.SELL,
            _lastFilledAt: Date.now(),
        };
        assert.strictEqual(resolveGuardGenerationKey(mgr), `0.44764|${ORDER_TYPES.SELL}`);
    });

    await test('GG-002 a cold pivot keys as empty; no marker helper survives', () => {
        const mgr: any = { _lastFilledPrice: null, _lastFilledType: null, _lastFilledAt: 0 };
        assert.strictEqual(resolveGuardGenerationKey(mgr), '', 'the marker leg is gone');
        const src = source('order/utils/system.ts');
        assert.ok(!/export function (?:liveRefusedFillLevels|hasLiveRefusedFillLevels|releaseRefutedRefusedLevels)\(/.test(src),
            'no marker reader/release helper may be exported');
        const runtime = require('../modules/order/utils/system');
        assert.strictEqual(runtime.hasLiveRefusedFillLevels, undefined);
        assert.strictEqual(runtime.liveRefusedFillLevels, undefined);
    });

    await test('GG-003 only the armed pivot contributes a generation identity', () => {
        const key = functionBody('order/utils/system.ts', 'export function resolveGuardGenerationKey(');
        assert.ok(!/refused|Refused/i.test(key), 'no refused-level branch remains in the owner');
        assert.ok(/return ''/.test(key), 'cold reference yields the empty key');
        const mgr: any = { _lastFilledPrice: 0, _lastFilledType: ORDER_TYPES.SELL, _lastFilledAt: Date.now() };
        assert.strictEqual(resolveGuardGenerationKey(mgr), '', 'an unarmed (zero) pivot stays cold');
    });

    await test('GG-004 a cold generation has no marker to expire', () => {
        const now = Date.now();
        const bot = stubSpreadBot();
        bot._lastGeometryResyncPivotKey = '';
        assert.strictEqual(resolveGuardGenerationKey(bot.manager), '', 'cold key');

        // A cold key has no watermark, so the ordinary geometry window applies.
        bot._outOfSpreadSince = now - (Number(TIMING.SPREAD_STALE_WARN_MS) / 2);
        let r = trackOutOfSpreadStaleness(bot, true, 0);
        assert.strictEqual(r.escalated, false, 'premature escalation');

        bot._outOfSpreadSince = now - (Number(TIMING.SPREAD_STALE_GEOMETRY_ESCALATE_MS) + 60_000);
        r = trackOutOfSpreadStaleness(bot, true, 0);
        assert.strictEqual(r.escalated, true, 'the cold generation still reaches the escalation window');
        assert.strictEqual(resolveGuardGenerationKey(bot.manager), '', 'generation stays cold');
    });

    await test('GG-005 all seven gates call the single liveness owner inside their own body', () => {
        const gates: Array<[string, string, string]> = [
            ['fill consumer', 'dexbot_fill_runtime.ts', 'async function consumeFillQueue('],
            ['region-end drain', 'dexbot_class.ts', '_wireBroadcastRegionEndDrain()'],
            ['lightweight-sync gate', 'dexbot_maintenance_runtime.ts', 'async function executeMaintenanceLogic('],
            ['pipeline-clear drain', 'dexbot_maintenance_runtime.ts', 'function drainFillQueueAfterPipelineClear('],
            ['open-orders sync loop', 'dexbot_maintenance_runtime.ts', 'function startOpenOrdersSyncLoop('],
            ['recovery request gate', 'dexbot_state_recovery.ts', 'async function triggerStateRecoverySync('],
            ['post-recovery rebalance', 'dexbot_state_recovery.ts', 'function _schedulePostRecoveryRebalance('],
        ];
        for (const [label, file, signature] of gates) {
            assert.ok(/readBotInFlightFlags\(/.test(functionBody(file, signature)),
                `${label} must call the single owner inside its own body`);
        }
        const fill = source('dexbot_fill_runtime.ts');
        const maintenance = source('dexbot_maintenance_runtime.ts');
        const cls = source('dexbot_class.ts');
        const recovery = source('dexbot_state_recovery.ts');
        // The four originally converted gates.
        assert.ok(!/!\s*bot\._recoverySyncInFlight\s*&&\s*!\s*bot\._batchInFlight/.test(maintenance),
            'lightweight-sync gate must use readBotInFlightFlags');
        assert.ok(!/\(bot\._batchInFlight\s*\|\|\s*0\)\s*>\s*0/.test(maintenance),
            'pipeline-clear drain must use readBotInFlightFlags');
        assert.ok(!/bot\._batchInFlight\s*>\s*0\s*\|\|\s*bot\._recoverySyncInFlight\s*>\s*0/.test(recovery),
            'post-recovery rebalance must use readBotInFlightFlags');
        // The three raw peeks that remained (the fill consumer is the
        // highest-stakes of all: it runs whenever the queue is non-empty).
        assert.ok(!/bot\._batchInFlight\s*\|\|\s*bot\._recoverySyncInFlight/.test(fill),
            'fill consumer must use readBotInFlightFlags');
        assert.ok(!/!\s*bot\._recoverySyncInFlight\s*&&/.test(maintenance),
            'open-orders sync loop must use readBotInFlightFlags');
        // Scope to the drain method: the constructor legitimately initialises
        // both counters to 0 and is not a gate.
        const drainStart = cls.indexOf('_wireBroadcastRegionEndDrain()');
        const drainEnd = cls.indexOf('getMetrics()', drainStart);
        assert.ok(drainStart >= 0 && drainEnd > drainStart, 'region-end drain method must be present');
        const drain = cls.slice(drainStart, drainEnd);
        assert.ok(!/this\._(batchInFlight|recoverySyncInFlight)/.test(drain),
            'region-end drain must use readBotInFlightFlags');
        const modules: Array<[string, string]> = [
            ['fill runtime', fill], ['bot class', cls], ['maintenance', maintenance], ['state recovery', recovery],
        ];
        for (const [label, text] of modules) {
            assert.ok(/readBotInFlightFlags\(/.test(text), `${label} must call the single owner`);
        }
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

    await test('GG-007 a malformed counter defers the fill consumer and arms its wake', async () => {
        const bot: any = {
            _incomingFillQueue: [{ order_id: '1.7.0' }],
            _shuttingDown: false,
            _batchInFlight: NaN, // unreadable: the raw `||` gate read this as idle
            _recoverySyncInFlight: 0,
            _deferredFillsPending: false,
            _deferredFillRetryTimer: null,
            _deferredFillRetryWaits: 0,
            _consecutiveConsumeFailures: 0,
            _consumeFailureFirstAt: 0,
            _warn: () => {},
            manager: {
                // No broadcast deferral, and a throwing lock: if the gate opens
                // on NaN the consumer proceeds and the test fails.
                isBroadcastingActive: () => false,
                _fillProcessingLock: { acquire: async () => { throw new Error('lock acquired during deferral'); } },
                _orphanFillsCreditedAt: null,
                logger: { log: () => {} },
            },
        };
        await consumeFillQueue(bot, {});
        assert.strictEqual(bot._deferredFillsPending, true, 'unreadable counter must defer, not consume');
        assert.ok(bot._deferredFillRetryTimer != null, 'the fail-closed deferral must arm the retry wake');
        clearTimeout(bot._deferredFillRetryTimer);
        bot._deferredFillRetryTimer = null;
    });

    await test('GG-008 the leak watchdog force-clears a non-finite counter', () => {
        const warns: string[] = [];
        const bot: any = {
            _batchInFlight: NaN,
            _batchInFlightStartedAt: 0,
            _recoverySyncInFlight: 0,
            _recoverySyncInFlightStartedAt: 0,
            _shuttingDown: false,
            _incomingFillQueue: [],
            _warn: (message: string) => { warns.push(String(message)); },
            // Even while a placement is held, a malformed counter has no
            // coherent live holder and must be cleared (unlike a stale count).
            manager: {
                isPlacementActive: () => true,
                logger: { log: () => {} },
                _deferredRebalanceAt: NaN, // also feeds readBotInFlightFlags.ok
            },
        };
        checkPipelineInFlightWatchdogs(bot);
        assert.strictEqual(bot._batchInFlight, 0, 'NaN must not skip the watchdog (Number(x) || 0 trap)');
        assert.strictEqual(bot._batchInFlightStartedAt, 0, 'the paired stamp must be cleared too');
        assert.strictEqual(bot.manager._deferredRebalanceAt, 0, 'an unreadable deferred stamp must be healed too');
        assert.ok(warns.some((w) => w.includes('malformed')), 'the force-clear must be reported');
        assert.ok(warns.some((w) => w.includes('deferred-rebalance')), 'the stamp clear must be reported');
    });

    await test('GG-009 a parked-queue retry tick heals a malformed counter before re-consuming', async () => {
        const observed: number[] = [];
        // Completion signal, not a wall-clock wait: the fake consumer resolves
        // this on the exact retry tick, so a loaded CI box cannot flake here.
        let resolveConsumed!: () => void;
        const consumed = new Promise<void>((resolve) => { resolveConsumed = resolve; });
        const bot: any = {
            _incomingFillQueue: [{ order_id: '1.7.0' }], // queue parked: maintenance is idle-gated
            _shuttingDown: false,
            _batchInFlight: NaN,
            _recoverySyncInFlight: 0,
            _deferredFillRetryTimer: null,
            _deferredFillRetryWaits: 0,
            _warn: () => {},
            _log: () => {},
            _consumeFillQueue: async () => {
                observed.push(Number(bot._batchInFlight));
                resolveConsumed();
            },
            manager: { isPlacementActive: () => false, logger: { log: () => {} } },
        };
        // 0 ms seam: drive one retry tick without the derived ~5 s backoff.
        scheduleDeferredFillRetry(bot, {}, 'unreadable pipeline', { retryDelayMs: 0 });
        assert.ok(bot._deferredFillRetryTimer != null, 'the retry must be armed');
        let guard: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            consumed,
            new Promise<never>((_, reject) => {
                guard = setTimeout(() => reject(new Error('retry never re-consumed')), 2000);
            }),
        ]);
        if (guard) clearTimeout(guard);
        assert.strictEqual(bot._batchInFlight, 0, 'the retry path must heal the counter maintenance cannot reach');
        assert.strictEqual(observed.length, 1, 'exactly one wake: the retry re-consumes, no separate drain');
        assert.ok(observed.every((v) => v === 0), 'the retry must re-consume only once the counter is readable');
        if (bot._deferredFillRetryTimer) clearTimeout(bot._deferredFillRetryTimer);
    });

    await test('GG-010 telemetry and metrics report unreadable liveness distinctly from idle', () => {
        const bot: any = {
            _incomingFillQueue: [],
            _batchInFlight: NaN,
            _recoverySyncInFlight: 0,
            _shuttingDown: false,
            _metrics: {},
            _recentlyProcessedFills: new Set(),
            manager: { logger: { log: () => {} } },
        };
        const signals = getPipelineSignals(bot);
        assert.strictEqual(signals.livenessOk, false, 'unreadable must not look settled in telemetry');
        assert.strictEqual(signals.batchInFlight, false, 'the known flag is still reported');
        assert.strictEqual(signals.recoveryInFlight, false);
        const metrics = getMetrics(bot);
        assert.strictEqual(metrics.pipelineLivenessOk, false, 'the field must reach the metrics snapshot used by the shutdown log, not just a test');
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

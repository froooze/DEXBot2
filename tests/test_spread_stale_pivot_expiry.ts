/**
 * SPREAD-STALE PIVOT EXPIRY — the out-of-spread watchdog clears a deadlocked
 * last-fill pivot instead of waiting the 24h TTL.
 *
 * Live episode (2026-11-14, a live market-pair bot): a crossed-book artifact
 * armed the LAST-FILL-GUARD pivot on the WRONG side of the market (a BUY far
 * above mid). The one geometry re-center per pivot could not clear the veto
 * (the pivot sits outside the new generation's placeable side), so the
 * watchdog escalated to NOTHING — "a fill or the pivot TTL is the only heal"
 * — and the sell rail stayed unquoted for the full 24h pivot lifetime,
 * because every rebuild re-armed the same pivot from the persisted row.
 *
 * The invariant under test: after the ONE re-center per pivot has already
 * run, the watchdog grants the pivot a bounded extra window
 * (TIMING.SPREAD_STALE_PIVOT_EXPIRE_MS) and then EXPIRES the guard
 * references outright — pivot and last-market-fill cleared live AND
 * persisted (so a rebuild cannot re-arm) — instead of escalating to
 * Infinity. SPREAD_STALE_PIVOT_EXPIRE_MS = 0 restores the legacy
 * never-expire behavior.
 */

const assert = require('assert');
const { trackOutOfSpreadStaleness } = require('../modules/dexbot_maintenance_runtime');
const { TIMING } = require('../modules/constants');

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    ${msg}`);
    }
}

const NOW = Date.now();
const GEOMETRY_ESCALATE_MS = 10 * 60 * 1000;   // SPREAD_STALE_GEOMETRY_ESCALATE_MS
const PIVOT_EXPIRE_MS = 20 * 60 * 1000;        // SPREAD_STALE_PIVOT_EXPIRE_MS default

function makeBot(over: Record<string, unknown> = {}) {
    const logs: Array<{ msg: string; level?: string }> = [];
    const cleared: string[] = [];
    const bot: any = {
        _outOfSpreadSince: 0,
        _outOfSpreadStaleWarned: false,
        _outOfSpreadTransientCount: 0,
        _outOfSpreadToleranceSince: 0,
        _lastSpreadStaleResyncAt: 0,
        _lastGeometryResyncPivotKey: '',
        _geometryResyncWarnedPivotKey: '',
        _spreadCorrectionStall: 'last-fill-blocked',
        manager: {
            outOfSpread: 1,
            _lastFilledPrice: 3058.69,
            _lastFilledType: 'buy',
            _lastFilledAt: NOW - 60_000,
            _lastMarketFillPrice: 3058.69,
            _lastMarketFillType: 'buy',
            _lastMarketFillAt: NOW - 60_000,
            accountOrders: {
                clearPersistedLastMarketFill: () => cleared.push('market-fill'),
                clearPersistedLastFillPivot: () => cleared.push('pivot')
            },
            requestStructuralGridResync: () => { throw new Error('resync must not fire after the pivot expiry window'); },
            logger: { log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }) }
        },
        _log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }),
        logs,
        cleared,
        ...over
    };
    return bot;
}

function staleLongEnough(bot: any, ms: number) {
    bot._outOfSpreadSince = NOW - ms;
}

// The pivot key must match what the watchdog derives from the manager
// reference: `${price}|${type}`.
const PIVOT_KEY = `${3058.69}|buy`;

run('EXPIRY-1 inside the bounded extra window nothing is expired', () => {
    const bot = makeBot({ _lastGeometryResyncPivotKey: PIVOT_KEY });
    // Just past the geometry-escalate window but BEFORE the pivot-expiry
    // window: the pivot-expiry window IS the escalation threshold now, so
    // nothing fires and the pivot survives.
    staleLongEnough(bot, GEOMETRY_ESCALATE_MS + 60_000);
    bot._lastSpreadStaleResyncAt = NOW - 10 * 60 * 1000;
    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.escalated, false, 'inside the pivot-expiry window the watchdog waits');
    assert.strictEqual(bot.manager._lastFilledPrice, 3058.69, 'the pivot survives inside its expiry window');
    assert.deepStrictEqual(bot.cleared, [], 'nothing persisted may be erased yet');
});

run('EXPIRY-2 past the pivot-expiry window the guard references are expired', () => {
    const bot = makeBot({ _lastGeometryResyncPivotKey: PIVOT_KEY });
    staleLongEnough(bot, PIVOT_EXPIRE_MS + 60_000);
    bot._lastSpreadStaleResyncAt = NOW - 10 * 60 * 1000;
    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(bot.manager._lastFilledPrice, null, 'the pivot must be cleared');
    assert.strictEqual(bot.manager._lastMarketFillPrice, null, 'the market-fill reference must be cleared');
    assert.deepStrictEqual(bot.cleared.sort(), ['market-fill', 'pivot'],
        'both persisted rows must be erased so a rebuild cannot re-arm');
    assert.strictEqual(bot._lastGeometryResyncPivotKey, '', 'the re-center memory must be reset');
    assert.strictEqual(bot._outOfSpreadSince, 0, 'the stale clock must restart');
    assert.ok(bot.logs.some((l: any) => /Expired guard references/.test(l.msg) && l.level === 'warn'),
        'the expiry must be logged loudly');
});

run('EXPIRY-3 before the re-center has run, the ladder is unchanged (re-center fires)', () => {
    const bot = makeBot({ _lastGeometryResyncPivotKey: '' });
    let resyncs = 0;
    bot.manager.requestStructuralGridResync = () => { resyncs++; };
    staleLongEnough(bot, GEOMETRY_ESCALATE_MS + 60_000);
    bot._lastSpreadStaleResyncAt = NOW - 10 * 60 * 1000;
    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(resyncs, 1, 'the ONE geometry re-center per pivot must still be requested');
    assert.strictEqual(bot.manager._lastFilledPrice, 3058.69, 'the pivot is NOT expired by the re-center path');
    assert.strictEqual(bot._lastGeometryResyncPivotKey, PIVOT_KEY, 'the re-center memory records the pivot');
});

run('EXPIRY-4 a placement heals everything (no expiry, counters reset)', () => {
    const bot = makeBot({ _lastGeometryResyncPivotKey: PIVOT_KEY });
    staleLongEnough(bot, PIVOT_EXPIRE_MS + 60_000);
    const r = trackOutOfSpreadStaleness(bot, true, 1, false);
    assert.strictEqual(r.staleMs, 0);
    assert.strictEqual(r.escalated, false);
    assert.strictEqual(bot.manager._lastFilledPrice, 3058.69, 'a heal must never expire the pivot');
    assert.deepStrictEqual(bot.cleared, []);
});

run('EXPIRY-5 the expiry window is the bounded 20-minute default (never Infinity)', () => {
    // TIMING is frozen at module scope, so the 0-disable path is exercised by
    // operators via general.settings.json; what is pinned here is the default
    // the watchdog falls back to: a bounded window, not the legacy Infinity.
    assert.strictEqual(Number(TIMING.SPREAD_STALE_PIVOT_EXPIRE_MS), PIVOT_EXPIRE_MS,
        'the default pivot-expiry window must be 20 minutes');
});

run('EXPIRY-6 the cooldown still applies between expiry attempts', () => {
    const bot = makeBot({ _lastGeometryResyncPivotKey: PIVOT_KEY });
    staleLongEnough(bot, PIVOT_EXPIRE_MS + 60_000);
    bot._lastSpreadStaleResyncAt = NOW - 10_000; // just fired
    const r = trackOutOfSpreadStaleness(bot, true, 0, false);
    assert.strictEqual(r.escalated, false, 'inside the cooldown nothing fires');
    assert.strictEqual(bot.manager._lastFilledPrice, 3058.69);
    assert.deepStrictEqual(bot.cleared, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

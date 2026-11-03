/**
 * tests/test_node_flap_score.ts — time-decayed connection-churn scoring.
 *
 * Node selection used to rank on raw ping only, so a 50ms endpoint that drops
 * its socket daily always beat a stable 350ms endpoint. These tests pin the
 * pure maths that replaces that: drops decay with a half life inside a 24h
 * window, a stable node ranks on ping alone, and the penalty is capped.
 */

const assert = require('assert');
const {
    DEFAULT_FLAP_HALF_LIFE_MS,
    DEFAULT_FLAP_PENALTY_MAX_MS,
    DEFAULT_FLAP_PENALTY_MS_PER_DROP,
    DEFAULT_FLAP_WINDOW_MS,
    MAX_DROP_TIMES,
    dropCounters,
    effectiveLatencyMs,
    flapPenaltyMs,
    flapScore,
    pruneDropTimes,
    recordDrop,
} = require('../modules/node_flap_score');

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function close(actual: number, expected: number, message: string, eps = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= eps, `${message}: expected ~${expected}, got ${actual}`);
}

// ── FS-001: no drops means ping alone ────────────────────────────────────────
{
    console.log('[FS-001] A node without drops ranks on its ping alone...');
    assert.strictEqual(flapScore([], NOW), 0);
    assert.strictEqual(flapPenaltyMs([], { nowMs: NOW }), 0);
    assert.strictEqual(effectiveLatencyMs(350, [], { nowMs: NOW }), 350);
    // Unknown latency never outranks a measured node, even with a penalty.
    assert.strictEqual(effectiveLatencyMs(null, [NOW], { nowMs: NOW }), Infinity);
    assert.strictEqual(effectiveLatencyMs(undefined, [], { nowMs: NOW }), Infinity);
    console.log('✓ FS-001 passed');
}

// ── FS-002: a fresh drop costs one penalty unit and then decays ──────────────
{
    console.log('[FS-002] A fresh drop costs one penalty unit and halves each half-life...');
    // Use a 4h half-life so two half-lives still sit inside the 24h window
    // (2 x the default 12h half-life lands exactly on the window edge).
    const halfLife = 4 * HOUR;
    assert.strictEqual(flapPenaltyMs([NOW], { nowMs: NOW }), DEFAULT_FLAP_PENALTY_MS_PER_DROP);
    close(flapScore([NOW], NOW, halfLife), 1, 'fresh drop weight');
    close(flapScore([NOW - halfLife], NOW, halfLife), 0.5, 'one half-life later');
    close(flapScore([NOW - 2 * halfLife], NOW, halfLife), 0.25, 'two half-lives later');
    close(flapScore([NOW - DEFAULT_FLAP_HALF_LIFE_MS], NOW), 0.5, 'default half-life also halves');
    close(
        flapPenaltyMs([NOW - halfLife], { nowMs: NOW, halfLifeMs: halfLife }),
        DEFAULT_FLAP_PENALTY_MS_PER_DROP / 2,
        'penalty after one half-life'
    );
    console.log('✓ FS-002 passed');
}

// ── FS-003: only the trailing 24h window counts ──────────────────────────────
{
    console.log('[FS-003] Drops outside the 24h window are ignored...');
    const stale = NOW - DEFAULT_FLAP_WINDOW_MS - HOUR;
    assert.strictEqual(flapPenaltyMs([stale], { nowMs: NOW }), 0, 'stale drop must not penalize');
    assert.deepStrictEqual(pruneDropTimes([stale, NOW - HOUR], NOW), [NOW - HOUR]);
    // Same drop, same age, but a window wide enough to include it.
    assert.ok(flapPenaltyMs([stale], { nowMs: NOW, windowMs: 48 * HOUR }) > 0, 'window is configurable');
    console.log('✓ FS-003 passed');
}

// ── FS-004: recordDrop prunes, dedupes and caps ──────────────────────────────
{
    console.log('[FS-004] recordDrop prunes, dedupes same-ms events and caps history...');
    const once = recordDrop([], NOW);
    assert.deepStrictEqual(once, [NOW]);
    assert.deepStrictEqual(recordDrop(once, NOW), [NOW], 'same millisecond is one event');
    const pruned = recordDrop([NOW - DEFAULT_FLAP_WINDOW_MS - 1], NOW);
    assert.deepStrictEqual(pruned, [NOW], 'out-of-window history is dropped');

    const many: number[] = [];
    for (let i = 0; i < MAX_DROP_TIMES + 20; i++) many.push(NOW - i * 1000);
    const capped = recordDrop(many, NOW);
    assert.strictEqual(capped.length, MAX_DROP_TIMES, 'history is bounded');
    assert.strictEqual(capped[capped.length - 1], NOW, 'newest drop is retained');
    console.log('✓ FS-004 passed');
}

// ── FS-005: drops/hour counters ──────────────────────────────────────────────
{
    console.log('[FS-005] Churn counters report last-hour and 24h rates...');
    const times = [NOW, NOW - 10 * 60 * 1000, NOW - 5 * HOUR, NOW - 23 * HOUR];
    const counters = dropCounters(times, { nowMs: NOW });
    assert.strictEqual(counters.dropsLastHour, 2, 'two drops in the last hour');
    assert.strictEqual(counters.drops24h, 4, 'four drops in 24h');
    close(counters.dropsPerHour, 4 / 24, 'averaged drops per hour', 0.01);
    assert.ok(counters.penaltyMs > 0, 'penalty is reported alongside the counters');
    assert.strictEqual(dropCounters([], { nowMs: NOW }).dropsPerHour, 0);
    console.log('✓ FS-005 passed');
}

// ── FS-006: the penalty is capped ────────────────────────────────────────────
{
    console.log('[FS-006] The penalty is capped so a degraded node stays a last resort...');
    const storm: number[] = [];
    for (let i = 0; i < 40; i++) storm.push(NOW - i * 60 * 1000);
    const uncapped = flapPenaltyMs(storm, { nowMs: NOW, maxPenaltyMs: Number.MAX_SAFE_INTEGER });
    assert.ok(uncapped > 60_000, `storm penalty should be large (got ${uncapped})`);
    assert.strictEqual(flapPenaltyMs(storm, { nowMs: NOW, maxPenaltyMs: 60_000 }), 60_000, 'cap is honoured');
    assert.ok(flapPenaltyMs(storm, { nowMs: NOW }) <= DEFAULT_FLAP_PENALTY_MAX_MS, 'default cap bounds the penalty');
    assert.ok(effectiveLatencyMs(50, storm, { nowMs: NOW }) > 350, 'fast-but-flapping ranks behind stable');
    console.log('✓ FS-006 passed');
}

// ── FS-007: the decision shape from the live logs ────────────────────────────
{
    console.log('[FS-007] Live-log shape: 51ms Cloudflare node vs 350ms stable node...');
    const fastFlapping = { latency: 51, drops: [NOW - 3 * HOUR] };
    const stableSlow = { latency: 350, drops: [] as number[] };
    const fastRank = effectiveLatencyMs(fastFlapping.latency, fastFlapping.drops, { nowMs: NOW });
    const slowRank = effectiveLatencyMs(stableSlow.latency, stableSlow.drops, { nowMs: NOW });
    assert.ok(fastRank > slowRank, `stable node must win (fast=${fastRank}, stable=${slowRank})`);

    // ...and once the drop is old enough the fast node is allowed back.
    const later = NOW + 3 * DEFAULT_FLAP_HALF_LIFE_MS;
    const fastLater = effectiveLatencyMs(fastFlapping.latency, fastFlapping.drops, { nowMs: later });
    assert.ok(fastLater < slowRank, `decayed penalty must restore rank (fast=${fastLater})`);
    console.log('✓ FS-007 passed');
}

console.log('='.repeat(60));
console.log('All node flap-score tests passed!');
console.log('='.repeat(60));

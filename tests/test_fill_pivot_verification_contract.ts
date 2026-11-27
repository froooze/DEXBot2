/**
 * FILL-PIVOT VERIFICATION CONTRACT.
 *
 * One writer owns the LAST-FILL-GUARD scalar family (setLastFillPivot in
 * order/utils/system.ts), one verifier owns the market re-read
 * (verifyFillMarketReference), and one helper derives fill evidence from
 * pays/receives (fillEvidenceFromEconomics). Every LIVE path that writes a
 * fill-provenance pivot must verify at an async boundary first; this test is
 * the ratchet that stops a new path from silently bypassing it.
 *
 * Documented exceptions: rearmLastFillPivotFromMarketFill and
 * restoreLastFillPivot run with no client and no live mid (fail-open by
 * design, §9.12/P1) — they are in the same module as the single writer.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
        console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
}

const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function main() {
    console.log('\n=== FILL-PIVOT VERIFICATION CONTRACT ===\n');

    run('CONTRACT-1 dexbot_class verifies before the fill-batch pivot stamp', () => {
        const src = read('modules/dexbot_class.ts');
        const verify = src.indexOf('await verifyFillMarketReference(');
        const stamp = src.indexOf('recordLastFilledPrices?.(fillBatch)');
        assert.ok(verify > 0 && stamp > verify, 'verification must precede recordLastFilledPrices');
    });

    run('CONTRACT-2 COW freeze and final gate both verify before the queued pivot write', () => {
        const src = read('modules/dexbot_cow_runtime.ts');
        const freezeVerify = src.indexOf('await verifyQueuedFillMarket(bot)');
        const freezeWrite = src.indexOf('if (refreshLastFillPivotFromQueue(bot))');
        assert.ok(freezeVerify > 0 && freezeWrite > freezeVerify, 'freeze must verify first');
        const gateVerify = src.indexOf('await verifyQueuedFillMarket(bot)', freezeWrite + 1);
        const gate = src.indexOf('finalGate = runFinalPivotGate(bot', freezeWrite);
        assert.ok(gateVerify > 0 && gate > gateVerify, 'final gate must verify first');
        assert.ok(/await verifyFillMarketReference\(/.test(src), 'the queued verifier must use the shared helper');
    });

    run('CONTRACT-3 orphan-fill sweep verifies before direct attribution', () => {
        const src = read('modules/dexbot_fill_runtime.ts');
        const verify = src.indexOf('await verifyFillMarketReference(');
        const write = src.indexOf('attributeUnmatchedFillToGrid(bot.manager');
        assert.ok(verify > 0 && write > verify, 'orphan attribution must verify first');
    });

    run('CONTRACT-4 sync-engine verifies at BOTH unmatched-fill absorption sites', () => {
        const src = read('modules/order/sync_engine.ts');
        const verifies = src.split('await verifyFillMarketReference(').length - 1;
        const writes = src.split('this._absorbUnmatchedFill(mgr,').length - 1;
        assert.ok(writes >= 2, `expected both absorption sites, found ${writes}`);
        assert.strictEqual(verifies, writes, 'one verification per unmatched-fill absorption site');
    });

    run('CONTRACT-5 unmatched attribution uses the shared evidence derivation', () => {
        const src = read('modules/order/utils/order.ts');
        assert.ok(src.includes('fillEvidenceFromEconomics('), 'attribution must use the shared evidence helper');
    });

    run('CONTRACT-6 the low-level pivot writer stays synchronous with documented exceptions', () => {
        const src = read('modules/order/utils/system.ts');
        assert.ok(/export function setLastFillPivot\(/.test(src), 'the single writer must stay sync');
        assert.ok(!/export async function setLastFillPivot\(/.test(src), 'never make the writer async');
        for (const exception of ['rearmLastFillPivotFromMarketFill', 'restoreLastFillPivot']) {
            assert.ok(src.includes(exception), `documented exception ${exception} must remain in the owner module`);
        }
    });

    run('CONTRACT-7 COW verification resolves the client before peeking the queue', () => {
        const src = read('modules/dexbot_cow_runtime.ts');
        const fn = src.indexOf('async function verifyQueuedFillMarket(');
        assert.ok(fn > 0, 'the queued verifier must exist');
        const body = src.slice(fn, src.indexOf('\n}', fn) + 2);
        const clientAt = body.indexOf('await guardMarketClient()');
        const peekAt = body.indexOf('latestQueuedFillEvidence(bot)');
        assert.ok(clientAt > 0 && peekAt > clientAt,
            'a queued fill arriving during the client await must be included in the peek');
    });

    run('CONTRACT-8 marker release belongs to the single price owner, with its own step guard', () => {
        const src = read('modules/order/utils/system.ts');
        const owner = src.indexOf('export async function maybeRefreshLiveMarketPrice(');
        const releaseCall = src.indexOf('releaseRefutedRefusedLevels(manager, previousMid, refreshed)', owner);
        assert.ok(owner > 0 && releaseCall > owner, 'both read paths must release through the price owner');
        const verifier = src.indexOf('export async function verifyFillMarketReference(');
        assert.ok(src.indexOf('releaseRefutedRefusedLevels(', verifier) === -1,
            'the fill gate must not duplicate release policy');
        const helper = src.indexOf('export function releaseRefutedRefusedLevels(');
        assert.ok(helper > 0 && /midStepDistance\(manager, before, after\) < 1/.test(src.slice(helper, helper + 900)),
            'the one-step guard must live inside the release helper');
    });

    run('CONTRACT-9 both market verifiers share one lazy client accessor', () => {
        const cow = read('modules/dexbot_cow_runtime.ts');
        const fill = read('modules/dexbot_fill_runtime.ts');
        const shared = read('modules/lazy_client_access.ts');
        assert.ok(/export function getLazyBitSharesClient\(/.test(shared), 'the shared accessor must exist');
        assert.ok(cow.includes('getLazyBitSharesClient as guardMarketClient'), 'COW must use the shared accessor');
        assert.ok(fill.includes("import { getLazyBitSharesClient } from './lazy_client_access.js';"),
            'the fill runtime must use the same accessor');
        assert.ok(!/from '\.\/bitshares_client\.js'/.test(fill),
            'the fill runtime must not reintroduce a static client import');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();

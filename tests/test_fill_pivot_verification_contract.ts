/**
 * FILL-PIVOT CONTRACT (fill-authoritative policy, compatibility surface removed).
 *
 * There is no market re-verification any more: no verifier, no market-bound
 * classifier, no refused-level helper is exported or called. Nothing may sit
 * between fill intake and the synchronous setLastFillPivot writer. This suite
 * pins the new contract:
 *
 *   - the verification/marker surface is absent from source and runtime;
 *   - no verification call in the fill-batch loop or in the writer chain;
 *   - writer stays synchronous and has no marker/market-bound branch;
 *   - evidence derivation from pays/receives still has one owner;
 *   - the generation key keys only off the armed fill pivot.
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

/** Extract a function body by signature so a check is scoped to that function. */
function body(src: string, signature: string): string {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
    const open = src.indexOf('{', start + signature.length);
    assert.ok(open >= 0, `${signature} must have a body`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    assert.fail(`unbalanced body for ${signature}`);
    return '';
}

function main() {
    console.log('\n=== FILL-PIVOT CONTRACT ===\n');

    run('CONTRACT-1 no verification between chunk intake and the pivot stamp', () => {
        const src = read('modules/dexbot_class.ts');
        assert.ok(!/verifyFillMarketReference|offMarketFill|fillOutsideMarket/.test(src),
            'the fill-batch loop must not reference a removed helper');
        const stamp = src.indexOf('recordLastFilledPrices?.(fillBatch)');
        assert.ok(stamp > 0, 'the per-chunk pivot stamp must remain');
        const chunk = src.slice(Math.max(0, stamp - 900), stamp);
        assert.ok(/fillBatch/.test(chunk), 'the stamp is still inside the per-chunk loop');
        assert.ok(!/await\s/.test(chunk.slice(chunk.lastIndexOf('fillList.slice'))),
            'no await may sit between slice and stamp');
    });

    run('CONTRACT-2 the writer stays synchronous and has no verification branch', () => {
        const src = read('modules/order/utils/system.ts');
        const writer = body(src, 'export function setLastFillPivot(');
        assert.ok(!/async|await/.test(writer), 'setLastFillPivot must be sync');
        assert.ok(!/verifyFillMarketReference|offMarketFill|RefusedFill|Refusing to arm/.test(writer),
            'no market read or marker may gate the writer');
        assert.ok(/manager\._lastFilledPrice = p/.test(writer), 'the writer still arms the pivot directly');
        assert.ok(!/export async function verifyFillMarketReference\(/.test(src),
            'no standalone verifier may remain');
    });

    run('CONTRACT-3 no removed helper is exported from the system module', () => {
        const src = read('modules/order/utils/system.ts');
        for (const name of ['offMarketFill', 'fillOutsideMarket', 'verifyFillMarketReference',
            'liveRefusedFillLevels', 'hasLiveRefusedFillLevels', 'releaseRefutedRefusedLevels',
            'resolveFillMidVerifyMs']) {
            assert.ok(!new RegExp(`export (?:async )?function ${name}\\(`).test(src),
                `${name} must not be exported`);
        }
        assert.ok(!/export interface RefusedFillLevel\b/.test(src), 'the marker type must not be exported');
        const runtime = require('../modules/order/utils/system');
        assert.strictEqual(runtime.verifyFillMarketReference, undefined);
        assert.strictEqual(runtime.offMarketFill, undefined);
        assert.strictEqual(runtime.hasLiveRefusedFillLevels, undefined);
    });

    run('CONTRACT-4 recordLastFilledPrices goes straight to the single writer', () => {
        const src = read('modules/order/manager.ts');
        const writer = body(src, 'recordLastFilledPrices(fills:');
        assert.ok(!/verifyFillMarketReference|offMarketFill|fillOutsideMarket/.test(writer),
            'the funnel must not call a removed classifier');
        assert.ok(/this\._setLastFillPivot\(/.test(writer), 'the funnel must still call the single writer');
        assert.ok(!/band-skipped|skippedInBand/.test(writer), 'gap-band skip is gone');
        assert.ok(/edgeFillIds\.has/.test(writer), 'edge-pinned insurance exclusion stays');
    });

    run('CONTRACT-5 no verifier call site survives in any fill path', () => {
        const files = ['modules/dexbot_cow_runtime.ts', 'modules/dexbot_fill_runtime.ts',
            'modules/order/sync_engine.ts', 'modules/dexbot_class.ts', 'modules/order/manager.ts'];
        for (const file of files) {
            const src = read(file);
            assert.ok(!/verifyFillMarketReference\(|offMarketFill\(|fillOutsideMarket\(/.test(src),
                `${file} must not call a removed fill classifier`);
            assert.ok(!/verifyQueuedFillMarket\(/.test(src),
                `${file} must not keep the async queued-fill verification step`);
        }
    });

    run('CONTRACT-6 fill evidence derivation still has a single owner', () => {
        const src = read('modules/order/utils/system.ts');
        assert.ok(/export function fillEvidenceFromEconomics\(/.test(src));
        const cow = read('modules/dexbot_cow_runtime.ts');
        assert.ok(cow.includes('fillEvidenceFromEconomics('), 'queued evidence uses the shared helper');
        const order = read('modules/order/utils/order.ts');
        assert.ok(order.includes('fillEvidenceFromEconomics('), 'unmatched attribution uses the shared helper');
    });

    run('CONTRACT-7 no refused-level writer survives anywhere', () => {
        const src = read('modules/order/utils/system.ts');
        assert.ok(!/export function isRefusedLevelRefillBlocked\(/.test(src), 'the marker writer/reader is gone');
        assert.ok(!/RefusedFillLevel/.test(src), 'the marker type is gone');
        for (const rel of ['modules/order/grid.ts', 'modules/dexbot_cow_runtime.ts', 'modules/order/utils/system.ts']) {
            assert.ok(!/hasLiveRefusedFillLevels|liveRefusedFillLevels|releaseRefutedRefusedLevels/.test(read(rel)),
                `${rel} must not read a refused marker`);
        }
    });

    run('CONTRACT-8 generation key falls back to cold, with no refused-level branch', () => {
        const src = read('modules/order/utils/system.ts');
        const key = body(src, 'export function resolveGuardGenerationKey(');
        assert.ok(!/refused:/.test(key), 'the refused marker branch is gone');
        assert.ok(/return ''/.test(key), 'cold reference yields the empty key');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();

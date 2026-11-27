/**
 * FILL-PIVOT CONTRACT (fill-authoritative policy).
 *
 * The old contract required a market re-verification at every async boundary
 * before a pivot could be written. With fills authoritative there is nothing
 * to verify: verifyFillMarketReference is a no-op, no book RPC is spent on a
 * fill, and nothing may sit between fill intake and the synchronous
 * setLastFillPivot writer. This suite pins the new contract:
 *
 *   - no verification call in the fill-batch loop or in the writer chain;
 *   - any surviving verifier call site is a standalone no-op (result unused);
 *   - writer stays synchronous and has no marker/market-bound branch;
 *   - evidence derivation from pays/receives still has one owner.
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
        assert.strictEqual(src.split('verifyFillMarketReference(').length - 1, 0,
            'the fill-batch loop must not call the verifier');
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
        assert.ok(!/async|await/.test(writer.split('(')[0] + writer), 'setLastFillPivot must be sync');
        assert.ok(!/verifyFillMarketReference|offMarketFill|RefusedFill|Refusing to arm/.test(writer),
            'no market read or marker may gate the writer');
        assert.ok(/manager\._lastFilledPrice = p/.test(writer), 'the writer still arms the pivot directly');
        const verifier = body(src, 'export async function verifyFillMarketReference(');
        assert.ok(!/db\.|get_ticker|get_order_book|maybeRefreshLiveMarketPrice/.test(verifier),
            'the no-op verifier must not read the book');
    });

    run('CONTRACT-3 recordLastFilledPrices goes straight to the single writer', () => {
        const src = read('modules/order/manager.ts');
        const writer = body(src, 'recordLastFilledPrices(fills:');
        assert.strictEqual(writer.split('verifyFillMarketReference(').length - 1, 0);
        assert.ok(/this\._setLastFillPivot\(/.test(writer), 'the funnel must still call the single writer');
        assert.ok(!/band-skipped|skippedInBand/.test(writer), 'gap-band skip is gone');
        assert.ok(/edgeFillIds\.has/.test(writer), 'edge-pinned insurance exclusion stays');
    });

    run('CONTRACT-4 no verifier result may gate a pivot write', () => {
        const files = ['modules/dexbot_cow_runtime.ts', 'modules/dexbot_fill_runtime.ts',
            'modules/order/sync_engine.ts', 'modules/dexbot_class.ts'];
        let calls = 0;
        for (const file of files) {
            const src = read(file);
            calls += src.split('verifyFillMarketReference(').length - 1;
            assert.ok(!/(?:const|let|var)\s+\w+\s*=\s*await\s+verifyFillMarketReference\(/.test(src),
                `${file} must not branch on the verifier result`);
            assert.ok(!/if\s*\(\s*await\s+verifyFillMarketReference\(/.test(src),
                `${file} must not gate on the verifier result`);
            assert.ok(!/verifyQueuedFillMarket\(/.test(src),
                `${file} must not keep the async queued-fill verification step`);
        }
        // Every remaining call (if any) is a standalone no-op; the writer chain
        // never depends on its result.
        assert.ok(calls === 0 || calls === 2, `unexpected verifier call count: ${calls}`);
    });

    run('CONTRACT-5 fill evidence derivation still has a single owner', () => {
        const src = read('modules/order/utils/system.ts');
        assert.ok(/export function fillEvidenceFromEconomics\(/.test(src));
        const cow = read('modules/dexbot_cow_runtime.ts');
        assert.ok(cow.includes('fillEvidenceFromEconomics('), 'queued evidence uses the shared helper');
        const order = read('modules/order/utils/order.ts');
        assert.ok(order.includes('fillEvidenceFromEconomics('), 'unmatched attribution uses the shared helper');
    });

    run('CONTRACT-6 no refused-level writer survives; marker readers are stubs', () => {
        const src = read('modules/order/utils/system.ts');
        const live = body(src, 'export function liveRefusedFillLevels(');
        const has = body(src, 'export function hasLiveRefusedFillLevels(');
        const release = body(src, 'export function releaseRefutedRefusedLevels(');
        assert.ok(/return \[\]/.test(live), 'liveRefusedFillLevels returns an empty set');
        assert.ok(/return false/.test(has), 'hasLiveRefusedFillLevels is always false');
        assert.ok(/return 0/.test(release), 'releaseRefutedRefusedLevels is a no-op');
        assert.ok(!/export function isRefusedLevelRefillBlocked\(/.test(src), 'the marker writer/reader is gone');
        assert.ok(!/_lastRefusedFillLevels\s*=|\[[^\]]*\]\s*\.push/.test(live + has + release),
            'the stubs must never write a marker');
    });

    run('CONTRACT-7 generation key falls back to cold, with no refused-level branch', () => {
        const src = read('modules/order/utils/system.ts');
        const key = body(src, 'export function resolveGuardGenerationKey(');
        assert.ok(!/refused:/.test(key), 'the refused marker branch is gone');
        assert.ok(/return ''/.test(key), 'cold reference yields the empty key');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();

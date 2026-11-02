'use strict';

/**
 * Shared case-insensitive asset lookup (modules/asset_lookup.ts).
 *
 * Every CLI that accepts an asset from a human resolves it here, so these tests
 * pin the contract: canonical UPPERCASE spelling in one batched `get_assets`
 * call, `1.3.x` ids untouched, caller order preserved, and a spelling-as-typed
 * retry only when the canonical form misses.
 */

const assert = require('assert');

const { lookupAssetRefs, resolveAssetRef, LOOKUP_BATCH } = require('../modules/asset_lookup');

console.log('Running asset lookup tests');

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>) {
    const result = (() => {
        try {
            return fn();
        } catch (err: any) {
            failed++;
            console.error(`  FAIL: ${name}`);
            console.error(`    ${err && err.message ? err.message : err}`);
            return null;
        }
    })();
    if (result instanceof Promise) {
        return result.then(
            () => { passed++; },
            (err: any) => {
                failed++;
                console.error(`  FAIL: ${name}`);
                console.error(`    ${err && err.message ? err.message : err}`);
            },
        );
    }
    passed++;
    return Promise.resolve();
}

/** Stub reader for `get_assets`; `onChain` maps the exact ref to an asset id. */
function stubRead(onChain: Record<string, string>) {
    const calls: string[][] = [];
    const read = async (method: string, args: unknown[]) => {
        assert.strictEqual(method, 'get_assets');
        const refs = args[0] as string[];
        calls.push(refs);
        return refs.map((ref) => (onChain[ref]
            ? { id: onChain[ref], symbol: ref.toUpperCase(), precision: 5 }
            : null));
    };
    return { read, calls };
}

const TOKEN = { 'TOKEN.SYM': '1.3.777' };

function testLowerCaseSymbolUsesCanonicalSpelling() {
    const { read, calls } = stubRead(TOKEN);
    return resolveAssetRef(read, 'token.sym').then((asset) => {
        assert.ok(asset);
        assert.strictEqual(asset.id, '1.3.777');
        // One request, canonical spelling — no case-sensitive miss first.
        assert.deepStrictEqual(calls, [['TOKEN.SYM']]);
    });
}

function testUpperCaseIsIdempotent() {
    const { read, calls } = stubRead(TOKEN);
    return lookupAssetRefs(read, ['TOKEN.SYM']).then(([result]) => {
        assert.strictEqual(result.request, 'TOKEN.SYM');
        assert.strictEqual(result.asset.id, '1.3.777');
        assert.deepStrictEqual(calls, [['TOKEN.SYM']]);
    });
}

function testObjectIdPassesThrough() {
    const { read, calls } = stubRead({ '1.3.0': '1.3.0' });
    return resolveAssetRef(read, ' 1.3.0 ').then((asset) => {
        assert.strictEqual(asset.id, '1.3.0');
        assert.deepStrictEqual(calls, [['1.3.0']]);
    });
}

function testBatchPreservesOrderAndSpelling() {
    const { read, calls } = stubRead({ 'TOKENA': '1.3.1', 'TOKENB': '1.3.2', '1.3.0': '1.3.0' });
    return lookupAssetRefs(read, ['tokena', '1.3.0', 'TokenB', 'missing']).then((results) => {
        assert.deepStrictEqual(results.map((r) => r.request), ['tokena', '1.3.0', 'TokenB', 'missing']);
        assert.deepStrictEqual(results.map((r) => r.asset && r.asset.id), ['1.3.1', '1.3.0', '1.3.2', null]);
        // One request for the whole list, plus one for the unresolved ref's
        // spelling as typed (canonicalisation changes it, so a retry is allowed).
        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(calls[0], ['TOKENA', '1.3.0', 'TOKENB', 'MISSING']);
        assert.deepStrictEqual(calls[1], ['missing']);
    });
}

function testRetryUsesSpellingAsTyped() {
    // Simulates a node that really stores a non-canonical symbol.
    const { read, calls } = stubRead({ 'lower.tok': '1.3.900' });
    return resolveAssetRef(read, 'lower.tok').then((asset) => {
        assert.strictEqual(asset.id, '1.3.900');
        assert.deepStrictEqual(calls, [['LOWER.TOK'], ['lower.tok']]);
    });
}

function testEmptyRefsAreNotRequested() {
    const { read, calls } = stubRead({});
    return lookupAssetRefs(read, ['', null, '   ']).then((results) => {
        assert.deepStrictEqual(results.map((r) => r.asset), [null, null, null]);
        assert.strictEqual(calls.length, 0);
    });
}

function testChunksAtLookupBatch() {
    const onChain: Record<string, string> = {};
    const refs: string[] = [];
    for (let i = 0; i < LOOKUP_BATCH + 3; i++) {
        const symbol = `TOKEN${i}`;
        refs.push(symbol);
        onChain[symbol] = `1.3.${1000 + i}`;
    }
    const { read, calls } = stubRead(onChain);
    return lookupAssetRefs(read, refs).then((results) => {
        assert.strictEqual(results.filter((r) => r.asset).length, refs.length);
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0].length, LOOKUP_BATCH);
        assert.strictEqual(calls[1].length, 3);
    });
}

const tests: Array<[string, () => void | Promise<void>]> = [
    ['lowercase symbol resolves via canonical UPPERCASE', testLowerCaseSymbolUsesCanonicalSpelling],
    ['uppercase input produces the same single request', testUpperCaseIsIdempotent],
    ['1.3.x ids pass through untouched', testObjectIdPassesThrough],
    ['a batch keeps order and echoes the caller spelling', testBatchPreservesOrderAndSpelling],
    ['as-typed spelling is retried only after a canonical miss', testRetryUsesSpellingAsTyped],
    ['empty references are never requested', testEmptyRefsAreNotRequested],
    ['large lists are chunked', testChunksAtLookupBatch],
];

(async () => {
    for (const [name, fn] of tests) await check(name, fn);
    console.log(`\nAsset lookup tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();

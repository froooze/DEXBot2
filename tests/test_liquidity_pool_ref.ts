'use strict';

/**
 * Pool reference resolution (modules/liquidity_pool_ref.ts).
 *
 * Every command that takes a pool accepts the same two spellings — an object id
 * (`133` / `1.19.133`) or the pool token (the LP share-asset symbol) — so this
 * suite pins the shared parsing and the chain lookups with stub readers:
 * `dexbot liq`, `dexbot tv`, `dexbot dw` and the liquidity analyzer all route
 * through it and must not drift apart.
 */

const assert = require('assert');

const {
    normalizePoolRef,
    isPoolIdRef,
    isPoolRefLike,
    poolAssetIds,
    resolvePoolRef,
} = require('../modules/liquidity_pool_ref');

console.log('Running liquidity pool ref tests');

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

/** Stub database_api reader: handlers[method] is a value or an args→value function. */
function stubRead(handlers: Record<string, unknown>) {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const read = async (method: string, args?: unknown[]) => {
        calls.push([method, args]);
        if (!(method in handlers)) throw new Error(`unexpected chain call: ${method}`);
        const handler = handlers[method];
        return typeof handler === 'function' ? (handler as (a?: unknown[]) => unknown)(args) : handler;
    };
    return { read, calls };
}

const POOL = { id: '1.19.9', asset_a: '1.3.1', asset_b: '1.3.2', share_asset: '1.3.3' };

function testNormalize() {
    assert.strictEqual(normalizePoolRef('133'), '1.19.133');
    assert.strictEqual(normalizePoolRef(' 42 '), '1.19.42');
    assert.strictEqual(normalizePoolRef('1.19.133'), '1.19.133');
    assert.strictEqual(normalizePoolRef('POOLTOK'), null);
    assert.strictEqual(normalizePoolRef('1.19.x'), null);
    assert.strictEqual(normalizePoolRef(''), null);
    assert.strictEqual(normalizePoolRef(null), null);
    assert.strictEqual(normalizePoolRef(undefined), null);
}

function testPredicates() {
    assert.strictEqual(isPoolIdRef('133'), true);
    assert.strictEqual(isPoolIdRef('1.19.7'), true);
    assert.strictEqual(isPoolIdRef('POOLTOK'), false);

    assert.strictEqual(isPoolRefLike('133'), true);
    assert.strictEqual(isPoolRefLike('1.19.7'), true);
    assert.strictEqual(isPoolRefLike('POOLTOK'), true);
    assert.strictEqual(isPoolRefLike('POOL.TOKEN_1'), true);
    assert.strictEqual(isPoolRefLike('has space'), false);
    assert.strictEqual(isPoolRefLike('A/B'), false);
    assert.strictEqual(isPoolRefLike(''), false);
    assert.strictEqual(isPoolRefLike('A'.repeat(64)), true);
    assert.strictEqual(isPoolRefLike('A'.repeat(65)), false);
}

function testPoolAssetIds() {
    assert.deepStrictEqual(poolAssetIds(POOL), ['1.3.1', '1.3.2']);
    assert.deepStrictEqual(poolAssetIds({ asset_ids: ['1.3.4', '1.3.5'] }), ['1.3.4', '1.3.5']);
    assert.deepStrictEqual(poolAssetIds({}), [null, null]);
    assert.deepStrictEqual(poolAssetIds(null), [null, null]);
}

function testResolveById() {
    const { read, calls } = stubRead({ get_objects: [POOL] });
    return resolvePoolRef(read, '133').then((pool) => {
        assert.strictEqual(pool.id, '1.19.9');
        assert.deepStrictEqual(calls, [['get_objects', [['1.19.133']]]]);
    });
}

function testResolveByIdToleratesNestedAndWrappedShapes() {
    const nested = stubRead({ get_objects: [[POOL]] });
    return resolvePoolRef(nested.read, '1.19.9').then((pool) => {
        assert.strictEqual(pool.id, '1.19.9');
        const wrapped = stubRead({ get_objects: [{ pool: POOL }] });
        return resolvePoolRef(wrapped.read, '9').then((inner) => {
            assert.strictEqual(inner.id, '1.19.9');
        });
    });
}

function testResolveByPoolToken() {
    const { read, calls } = stubRead({
        lookup_asset_symbols: [{ id: '1.3.3', symbol: 'POOLTOK' }],
        get_liquidity_pools_by_share_asset: [{ pool: POOL }],
    });
    return resolvePoolRef(read, 'POOLTOK').then((pool) => {
        assert.strictEqual(pool.id, '1.19.9');
        assert.deepStrictEqual(calls, [
            ['lookup_asset_symbols', [['POOLTOK']]],
            ['get_liquidity_pools_by_share_asset', [['1.3.3'], false, false]],
        ]);
    });
}

function testResolveByPoolTokenRetriesUppercase() {
    const { read, calls } = stubRead({
        lookup_asset_symbols: (args?: unknown[]) => {
            const symbol = (args?.[0] as string[] | undefined)?.[0];
            return symbol === 'POOLTOK' ? [{ id: '1.3.3', symbol: 'POOLTOK' }] : [null];
        },
        get_liquidity_pools_by_share_asset: [POOL],
    });
    return resolvePoolRef(read, 'pooltok').then((pool) => {
        assert.strictEqual(pool.id, '1.19.9');
        assert.deepStrictEqual(calls.map(([method, args]) => [method, args?.[0]]), [
            ['lookup_asset_symbols', ['pooltok']],
            ['lookup_asset_symbols', ['POOLTOK']],
            ['get_liquidity_pools_by_share_asset', ['1.3.3']],
        ]);
    });
}

function testResolveErrors() {
    const missingPool = stubRead({ get_objects: [null] });
    return assert.rejects(
        () => resolvePoolRef(missingPool.read, '13'),
        /Liquidity pool 1\.19\.13 not found on chain/,
    ).then(() => {
        const notAToken = stubRead({
            lookup_asset_symbols: [{ id: '1.3.44', symbol: 'PLAIN' }],
            get_liquidity_pools_by_share_asset: [],
        });
        return assert.rejects(
            () => resolvePoolRef(notAToken.read, 'PLAIN'),
            /'PLAIN' \(1\.3\.44\) is not a liquidity-pool token/,
        );
    }).then(() => {
        const unknownToken = stubRead({ lookup_asset_symbols: [null] });
        return assert.rejects(
            () => resolvePoolRef(unknownToken.read, 'NOPE'),
            /Pool token 'NOPE' not found on chain/,
        );
    }).then(() => {
        const empty = stubRead({});
        return assert.rejects(() => resolvePoolRef(empty.read, '   '), /Pool reference is empty/);
    });
}

const tests: Array<[string, () => void | Promise<void>]> = [
    ['normalizePoolRef: ids vs pool tokens', testNormalize],
    ['isPoolIdRef / isPoolRefLike', testPredicates],
    ['poolAssetIds: asset_a/b and asset_ids', testPoolAssetIds],
    ['resolvePoolRef: pool id', testResolveById],
    ['resolvePoolRef: nested/wrapped get_objects shapes', testResolveByIdToleratesNestedAndWrappedShapes],
    ['resolvePoolRef: pool token', testResolveByPoolToken],
    ['resolvePoolRef: pool token retries UPPERCASE', testResolveByPoolTokenRetriesUppercase],
    ['resolvePoolRef: error messages', testResolveErrors],
];

(async () => {
    for (const [name, fn] of tests) await check(name, fn);
    console.log(`\nLiquidity pool ref tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();

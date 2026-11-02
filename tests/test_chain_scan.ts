'use strict';

/**
 * Chain object-id scan (modules/chain_scan.ts).
 *
 * The 1.15.x legacy balances and 1.13.x vesting balances have no list API, so
 * both reports enumerate them by probing ids with `get_objects`. These tests pin
 * the walk (holes, gap tolerance, max-id truncation), the batch backoff that
 * keeps strict nodes working, and the progress reporting the CLI turns into its
 * `[Assets] scanning ... N ids` line.
 */

const assert = require('assert');

const { scanIdRange, DEFAULT_SCAN_BATCH, MIN_SCAN_BATCH } = require('../modules/chain_scan');

console.log('Running chain scan tests');

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

/**
 * Stub `get_objects`: `live` maps an id number to the returned object (or the
 * id is a hole). Records every batch so the walk can be inspected.
 */
function stubReader(live: Map<number, unknown>, opts: { failAbove?: number } = {}) {
    const batches: string[][] = [];
    const read = async (method: string, args: unknown[]) => {
        assert.strictEqual(method, 'get_objects');
        const ids = (args[0] as string[]);
        batches.push(ids);
        if (opts.failAbove != null && ids.length > opts.failAbove) {
            throw new Error(`batch of ${ids.length} refused (max ${opts.failAbove})`);
        }
        return ids.map((id) => {
            const n = Number(id.split('.')[2]);
            return live.has(n) ? live.get(n) : null;
        });
    };
    return { read, batches };
}

function liveRange(from: number, to: number) {
    const map = new Map<number, unknown>();
    for (let n = from; n <= to; n++) map.set(n, { id: `1.15.${n}` });
    return map;
}

function testDenseWalk() {
    const { read, batches } = stubReader(liveRange(0, 49));
    return scanIdRange({ read, prefix: '1.15', maxId: 200, gap: 20, batchSize: 10 }).then((result) => {
        // Every live object is collected, in id order.
        assert.deepStrictEqual(result.objects.map((o) => o.id), Array.from({ length: 50 }, (_, i) => `1.15.${i}`));
        // The walk stops only after `gap` ids past the last live object (49).
        assert.strictEqual(result.scannedTo, 70);
        assert.strictEqual(result.hitLimit, false);
        assert.strictEqual(batches.length, 7);
        assert.deepStrictEqual(batches[0], Array.from({ length: 10 }, (_, i) => `1.15.${i}`));
        assert.deepStrictEqual(batches[1][0], '1.15.10');
    });
}

function testTruncationAtMaxId() {
    const { read } = stubReader(liveRange(0, 24));
    return scanIdRange({ read, prefix: '1.15', maxId: 25, gap: 1000, batchSize: 10 }).then((result) => {
        assert.strictEqual(result.objects.length, 25);
        assert.strictEqual(result.scannedTo, 26);
        // Stopped at the probe limit while objects were still close by.
        assert.strictEqual(result.hitLimit, true);
    });
}

function testGapStopInEmptyRange() {
    const { read, batches } = stubReader(new Map());
    return scanIdRange({ read, prefix: '1.13', maxId: 10_000, gap: 20, batchSize: 10 }).then((result) => {
        assert.deepStrictEqual(result.objects, []);
        // gap is measured from id 0 when nothing is live: two batches reach 20,
        // the third would need index - (-1) > 20.
        assert.strictEqual(result.scannedTo, 20);
        assert.strictEqual(result.hitLimit, false);
        assert.strictEqual(batches.length, 2);
        assert.strictEqual(batches[0][0], '1.13.0');
    });
}

function testBatchBackoff() {
    const live = liveRange(0, 19);
    const { read, batches } = stubReader(live, { failAbove: 200 });
    return scanIdRange({ read, prefix: '1.15', maxId: 5000, gap: 1000, batchSize: 800 }).then((result) => {
        // 800 -> 400 (refused) -> 200 (accepted); the refused windows are retried.
        assert.strictEqual(batches[0].length, 800);
        assert.strictEqual(batches[1].length, 400);
        assert.strictEqual(batches[2].length, 200);
        assert.ok(batches.slice(3).every((ids) => ids.length <= 200));
        assert.strictEqual(result.objects.length, 20);
        // Refused windows are retried from the same start: no ids are skipped.
        assert.strictEqual(batches[1][0], '1.15.0');
        assert.strictEqual(batches[2][0], '1.15.0');
        assert.strictEqual(batches[2][199], '1.15.199');
        assert.strictEqual(result.scannedTo, 1020);
    });
}

function testBackoffGivesUpAtMinimum() {
    const { read } = stubReader(new Map(), { failAbove: 0 });
    return scanIdRange({ read, prefix: '1.15', maxId: 500, gap: 50, batchSize: 400 }).then(
        () => { throw new Error('expected the scan to reject once it hit the minimum batch'); },
        (err: any) => {
            assert.match(err.message, /max 0/);
        },
    );
}

function testProgressAndDefaults() {
    const { read, batches } = stubReader(liveRange(0, 19));
    const seen: number[] = [];
    return scanIdRange({
        read,
        prefix: '1.15',
        maxId: 100,
        gap: 20,
        batchSize: 10,
        onProgress: (n: number) => seen.push(n),
    }).then(() => {
        assert.deepStrictEqual(seen, [10, 20, 30, 40]);
    }).then(() => {
        // Defaults: 1000 ids per call (public nodes all accept it), floor 100.
        assert.strictEqual(DEFAULT_SCAN_BATCH, 1000);
        assert.strictEqual(MIN_SCAN_BATCH, 100);
        const plain = stubReader(new Map());
        return scanIdRange({ read: plain.read, prefix: '1.15', maxId: 2000, gap: 1000 }).then(() => {
            assert.strictEqual(plain.batches[0].length, 1000);
        });
    });
}

const tests: Array<[string, () => void | Promise<void>]> = [
    ['dense walk collects every live object and honours gap', testDenseWalk],
    ['maxId truncation is reported as hitLimit', testTruncationAtMaxId],
    ['empty range stops after gap ids', testGapStopInEmptyRange],
    ['a refusing node triggers batch backoff without losing ids', testBatchBackoff],
    ['backoff throws once the minimum batch is refused', testBackoffGivesUpAtMinimum],
    ['progress ticks per batch; defaults are 1000/100', testProgressAndDefaults],
];

(async () => {
    for (const [name, fn] of tests) await check(name, fn);
    console.log(`\nChain scan tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();

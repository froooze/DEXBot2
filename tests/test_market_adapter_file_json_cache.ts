'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readCachedJson, noteJsonWritten, __test: { clearJsonCache } } = require('../market_adapter/utils/file_json_cache');

/**
 * The candle-file read cache must be a pure speedup: it may only ever hand back
 * the exact value this process wrote, only while the file is provably unchanged,
 * and never at the cost of correctness when another writer touches the file.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-adapter-json-cache-'));
const filePath = path.join(tmpDir, 'candles.json');

function writeFile(value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
    return value;
}

function countingLoader(): any {
    const state: any = { calls: 0 };
    state.loader = () => {
        state.calls++;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    };
    return state;
}

function testFirstReadAlwaysParses() {
    clearJsonCache();
    writeFile({ candles: [[1, 2, 3]] });
    const counter = countingLoader();
    const loader = counter.loader;
    const first = readCachedJson(filePath, loader);
    assert.strictEqual(counter.calls, 1, 'the first read must parse');
    assert.deepStrictEqual(first, { candles: [[1, 2, 3]] });
    // Nothing was written by us, so there is nothing safe to reuse.
    const second = readCachedJson(filePath, loader);
    assert.strictEqual(counter.calls, 2, 'a parsed value must not be cached for reuse');
}

function testWriteThroughReadIsServedWithoutParsing() {
    clearJsonCache();
    const payload = { meta: { marketSource: 'pool' }, candles: [[1, 1, 1, 1, 1, 1]] };
    writeFile(payload);
    noteJsonWritten(filePath, payload);
    const counter = countingLoader();
    const loader = counter.loader;
    const served = readCachedJson(filePath, loader);
    assert.strictEqual(counter.calls, 0, 'our own write must be served without re-parsing');
    assert.strictEqual(served, payload, 'the served value is the object we serialized');
}

function testServedEntryIsConsumed() {
    // A cycle that reads, mutates and then fails before writing must not be able
    // to poison the next cycle, so a served entry is used at most once.
    clearJsonCache();
    const payload = { candles: [[1]] };
    writeFile(payload);
    noteJsonWritten(filePath, payload);
    const counter = countingLoader();
    const loader = counter.loader;
    readCachedJson(filePath, loader);
    readCachedJson(filePath, loader);
    assert.strictEqual(counter.calls, 1, 'the second read must fall back to the loader');
}

function testExternalWriteInvalidatesTheEntry() {
    clearJsonCache();
    const payload = { candles: [[1]] };
    writeFile(payload);
    // Force the recorded stamp into the past so the foreign write below is
    // guaranteed a strictly newer mtime even on coarse-granularity filesystems
    // (a same-millisecond rewrite is the pathological case the cache's
    // mtime+size stamp cannot distinguish; without this the test is
    // filesystem-timing dependent).
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(filePath, past, past);
    noteJsonWritten(filePath, payload);
    // Another writer (gap repair, ama_signal_runner, clear script) rewrites it.
    writeFile({ candles: [[2]] });
    const counter = countingLoader();
    const loader = counter.loader;
    const served = readCachedJson(filePath, loader);
    assert.strictEqual(counter.calls, 1, 'a foreign write must invalidate the cached value');
    assert.deepStrictEqual(served, { candles: [[2]] }, 'the new content must be visible');
}

function testSameSizeRewriteStillInvalidates() {
    // mtime + size is the stamp; a same-size rewrite inside the same millisecond
    // is the pathological case, so verify the size alone is not what carries it.
    clearJsonCache();
    const payload = { candles: [[1]] };
    writeFile(payload);
    noteJsonWritten(filePath, payload);
    const before = fs.statSync(filePath).mtimeMs;
    writeFile({ candles: [[9]] });
    const after = fs.statSync(filePath).mtimeMs;
    if (before === after) return;   // filesystem mtime granularity: nothing to assert
    const counter = countingLoader();
    const loader = counter.loader;
    readCachedJson(filePath, loader);
    assert.strictEqual(counter.calls, 1, 'an mtime change alone must invalidate the cached value');
}

function testUnstattablePathNeverCaches() {
    clearJsonCache();
    const missing = path.join(tmpDir, 'does-not-exist.json');
    let calls = 0;
    const loader = () => { calls++; return { fallback: true }; };
    for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual(readCachedJson(missing, loader), { fallback: true });
    }
    assert.strictEqual(calls, 3, 'a file that cannot be stat-ed must never be cached');
    // noteJsonWritten on a missing file must not create a phantom entry either.
    noteJsonWritten(missing, { fallback: true });
    readCachedJson(missing, loader);
    assert.strictEqual(calls, 4, 'noteJsonWritten must not cache an unstattable file');
}

function testClearDropsEverything() {
    const payload = { candles: [[1]] };
    writeFile(payload);
    noteJsonWritten(filePath, payload);
    clearJsonCache();
    const counter = countingLoader();
    const loader = counter.loader;
    readCachedJson(filePath, loader);
    assert.strictEqual(counter.calls, 1, 'clearJsonCache must drop write-through entries');
}

testFirstReadAlwaysParses();
testWriteThroughReadIsServedWithoutParsing();
testServedEntryIsConsumed();
testExternalWriteInvalidatesTheEntry();
testSameSizeRewriteStillInvalidates();
testUnstattablePathNeverCaches();
testClearDropsEverything();

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('All market adapter file JSON cache tests passed');

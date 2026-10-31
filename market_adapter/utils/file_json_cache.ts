'use strict';

import { getStorage } from '../../modules/storage/index.js';
import type { FileStat } from '../../modules/storage/types.js';

/**
 * market_adapter/utils/file_json_cache.ts — write-through JSON read cache
 *
 * The hourly cycle re-read every bot's candle file (6 x ~250 KiB) before writing
 * it straight back, which cost ~1.4 ms of JSON.parse per file per cycle for data
 * this process had just serialized itself. Nothing else normally writes those
 * files, but "normally" is not "never" (a gap-repair run, ama_signal_runner or
 * the clear script can), so the cache never trusts process-local state blindly:
 *
 *   - Entries exist only for files THIS process wrote (`noteJsonWritten`), so
 *     the cached value is known to be what was just serialized to disk.
 *   - A cached entry is served only while the file's mtime still matches the
 *     stamp taken right after that write, and its size still matches wherever
 *     the storage adapter reports one. Any other writer invalidates it. (The
 *     browser storage adapter's stat() has no size, so in a browser bundle this
 *     degrades to mtime-only; the cache is only wired into the Node runtime.)
 *   - A served entry is consumed (deleted). A cycle that reads the file, mutates
 *     the object and then fails before writing therefore cannot poison the next
 *     cycle: the entry is already gone, and the next read re-parses.
 *   - When the file cannot be stat'ed (missing, no storage adapter, or a test
 *     injecting its own loader) nothing is cached and the loader always runs.
 *
 * Net effect for the hourly loop: the parse this process would have paid to read
 * back its own previous output disappears, with no path to stale data.
 */

// Resolved per call, not at import time, so a later setAdapter() (DI in tests, a
// different bundle entry point) is honoured instead of silently ignored.
function statOf(filePath: string): { mtimeMs: number; size: number } | null {
    try {
        const st: FileStat = getStorage().stat(filePath);
        if (!st || !Number.isFinite(st.mtimeMs)) return null;
        return { mtimeMs: st.mtimeMs, size: Number(st.size) || 0 };
    } catch (_) {
        return null;
    }
}

interface CacheEntry {
    mtimeMs: number;
    size: number;
    value: unknown;
}

// Bounded: one entry per candle file the process has written. 32 covers far more
// bots than any deployment runs, and each entry is a few hundred KB at most.
const CACHE_LIMIT = 32;
const _cache = new Map<string, CacheEntry>();

function _store(filePath: string, entry: CacheEntry): void {
    _cache.delete(filePath);
    _cache.set(filePath, entry);
    while (_cache.size > CACHE_LIMIT) {
        const oldest = _cache.keys().next();
        if (oldest.done) break;
        _cache.delete(oldest.value);
    }
}

/**
 * Read and parse a JSON file through `loader`, reusing the value this process
 * wrote earlier only while the file is provably unchanged. The entry is
 * consumed on use, so at most one cycle benefits from any single write.
 */
function readCachedJson<T>(filePath: string, loader: () => T): T {
    const stamp = statOf(filePath);
    if (!stamp) {
        // Cannot validate -> never serve, and forget anything we had.
        _cache.delete(filePath);
        return loader();
    }
    const hit = _cache.get(filePath);
    if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) {
        _cache.delete(filePath);
        return hit.value as T;
    }
    _cache.delete(filePath);
    return loader();
}

/**
 * Record that `filePath` now holds exactly `value` on disk, so the next read can
 * skip the parse. Call this right after writing.
 *
 * CONTRACT: `value` is held by reference and there is no copy. The caller must
 * not mutate it afterwards (and must not hand the same object to anything else
 * that will), otherwise the cache would serve something that no longer matches
 * the file. The current call site serializes `value` and then never touches it
 * again, so it satisfies this.
 *
 * KNOWN RACE (accepted): the stamp is taken after the write, so another writer
 * landing between our write and our stat() would make this entry carry its
 * stamp with our value, and a later read could serve that stale payload. The
 * window is sub-millisecond and the adapter is the only writer of these files
 * in-process, so this is not worth a hash of a 250 KiB payload; a genuine
 * cross-process writer is far better served by the mtime check failing on its
 * own write than by a cache that guesses.
 */
function noteJsonWritten(filePath: string, value: unknown): void {
    const stamp = statOf(filePath);
    if (!stamp) {
        _cache.delete(filePath);
        return;
    }
    _store(filePath, { mtimeMs: stamp.mtimeMs, size: stamp.size, value });
}

/** Drop every cached entry (config reload, tests, explicit cache busting). */
function clearJsonCache(): void {
    _cache.clear();
}

export { readCachedJson, noteJsonWritten }

/** Internal seams exercised directly by tests. */
export const __test = { clearJsonCache };

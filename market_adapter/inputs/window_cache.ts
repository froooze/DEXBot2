'use strict';
/**
 * WINDOW CACHE — generic persistent bucket cache for windowed Kibana candle fetches.
 *
 * Problem: callers anchor their range at floored-"now", so every run shifts all
 * windows and an exact time-range match would invalidate the whole cache.
 * This module makes reuse range-aware instead: sibling chunk files are loaded
 * once, buckets inside the new window are kept, and only missing buckets are
 * queried (plus a tail refresh for late-indexed trades).
 *
 * Chunk files live next to `outPath`:
 *   `<base>.chunk_<ii>_<YYYY-MM-DD>_<YYYY-MM-DD><ext>`
 * each holding `{ meta, candles }`. Callers supply:
 *   - `requestKey` — opaque identity object stored in each chunk's meta,
 *   - `isMatch(meta, requestKey)` — same-pool/feed/interval/assets check,
 *   - `fetchRange(gteIso, lteIso)` — query one (sub-)range, gap-filled grid,
 *   - `metaForWindow(window)` — meta to persist with a (re)fetched chunk.
 *
 * Node-only (disk I/O via storage). Browser-safe code must not import this.
 */

import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import { writeJsonAtomic } from '../utils/atomic_write.js';
import { getErrorMessage, sleepMs } from '../../modules/utils/errors.js';
import { mergeCandles } from '../candle_utils.js';

const storage = getStorage();
const { readJSON } = storage;

// Trailing overlap always re-fetched on the newest window. Kibana indexing
// can lag minutes–hours, so buckets cached as zero-volume fills may gain
// real trades after the fact. 48h bounds the extra query to a small range.
const TAIL_REFRESH_HOURS = 48;

// Windows fully in the past are immutable: blockchain history does not change
// and Kibana indexing lag (minutes–hours) is long past. Leading buckets with
// no trades stay empty forever, so re-querying them every shifted rerun is
// pure waste. Only the recent past is re-checked (see TAIL_REFRESH_HOURS).
const IMMUTABLE_WINDOW_AGE_MS = 7 * 24 * 3600 * 1000;

function siblingChunkFiles(outPath: any) {
    const resolved = path.resolve(outPath);
    const parsed = path.parse(resolved);
    if (!storage.exists(parsed.dir)) return [];
    const prefix = `${parsed.name}.chunk_`;
    return storage.readdir(parsed.dir)
        .filter((name: any) => name.startsWith(prefix) && name.endsWith(parsed.ext))
        .map((name: any) => path.join(parsed.dir, name))
        .sort();
}

function chunkPathFor(outPath: any, index: any, window: any) {
    const parsed = path.parse(outPath);
    const start = String(window.gte).slice(0, 10);
    const end = String(window.lte).slice(0, 10);
    return path.join(parsed.dir, `${parsed.name}.chunk_${String(index).padStart(2, '0')}_${start}_${end}${parsed.ext}`);
}

function readCacheChunk(chunkFile: any, requestKey: any, isMatch: (meta: any, requestKey: any) => boolean) {
    // Same-identity check WITHOUT the timeRange match — any chunk for this
    // request can contribute buckets.
    try {
        const parsed = readJSON(chunkFile);
        const meta = parsed?.meta || {};
        if (!isMatch(meta, requestKey)) return null;
        if (!Array.isArray(parsed.candles)) return null;
        const rangeGte = Date.parse(String(meta.timeRange?.gte || ''));
        const rangeLte = Date.parse(String(meta.timeRange?.lte || ''));
        const gte = Number.isFinite(rangeGte) ? rangeGte : null;
        const lte = Number.isFinite(rangeLte) ? rangeLte : null;
        // Ranges actually queried to produce these candles. Pre-fix files
        // predate sub-range fetches (full-window only), so their timeRange
        // claim is exact and serves as the fallback.
        const queried = Array.isArray(meta.queriedRanges)
            ? meta.queriedRanges
                .filter((q: any) => Number.isFinite(Number(q?.gte)) && Number.isFinite(Number(q?.lte)))
                .map((q: any) => ({ gte: Number(q.gte), lte: Number(q.lte) }))
            : (gte !== null && lte !== null ? [{ gte, lte }] : []);
        return {
            candles: parsed.candles,
            fetchedAt: meta.fetchedAt || null,
            file: chunkFile,
            rangeGte: gte,
            rangeLte: lte,
            queried,
        };
    } catch (_: any) {
        return null;
    }
}

// Previously-proven coverage surviving a same-filename overwrite, clipped
// to the window being persisted. Sound: any in-window range the old file
// vouched for was really queried, and had it held trades those candles
// would be in that same file (hence carried forward as reusable, never
// missing). Out-of-window parts are dropped by the clip, so nothing is
// vouched for beyond what the rewritten file can testify to.
function priorQueriedInWindow(chunkFile: any, requestKey: any, isMatch: (meta: any, requestKey: any) => boolean, gteMs: number, lteMs: number) {
    const chunk = readCacheChunk(chunkFile, requestKey, isMatch);
    if (!chunk) return [];
    return chunk.queried
        .filter((q: any) => q.lte > gteMs && q.gte < lteMs)
        .map((q: any) => ({ gte: Math.max(q.gte, gteMs), lte: Math.min(q.lte, lteMs) }));
}

function loadBucketCache(outPath: any, requestKey: any, isMatch: (meta: any, requestKey: any) => boolean) {
    const byTs = new Map();
    const fileCover: { gte: number | null; lte: number | null; count: number; queried: { gte: number; lte: number }[] }[] = [];
    let files = 0;
    for (const file of siblingChunkFiles(outPath)) {
        const chunk = readCacheChunk(file, requestKey, isMatch);
        if (!chunk) continue;
        files += 1;
        fileCover.push({ gte: chunk.rangeGte, lte: chunk.rangeLte, count: chunk.candles.length, queried: chunk.queried });
        for (const c of chunk.candles) {
            if (!Array.isArray(c)) continue;
            const ts = Number(c[0]);
            if (!Number.isFinite(ts)) continue;
            const prev = byTs.get(ts);
            if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) byTs.set(ts, c);
        }
    }
    return { byTs, files, fileCover };
}

function cachedCandlesInRange(localCache: any, gteMs: number, lteMs: number) {
    const out: any[] = [];
    for (const [ts, c] of localCache.byTs) {
        if (ts >= gteMs && ts <= lteMs) out.push(c);
    }
    out.sort((a: any, b: any) => a[0] - b[0]);
    return out;
}

function addUtcMonths(date: any, months: any) {
    const result = new Date(date.getTime());
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(
        result.getUTCFullYear(),
        result.getUTCMonth() + 1,
        0
    )).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
}

function normalizeDateInput(raw: any, label: any) {
    const ms = Date.parse(String(raw || ''));
    if (!Number.isFinite(ms)) {
        throw new Error(`Invalid ${label} date: ${raw}`);
    }
    return new Date(ms);
}

function buildFetchWindowsFromRange(timeRange: any, chunkMonths: any) {
    const start = normalizeDateInput(timeRange.gte, 'start');
    const end = normalizeDateInput(timeRange.lte, 'end');

    if (start >= end) {
        throw new Error(`Invalid fetch range: ${start.toISOString()} must be earlier than ${end.toISOString()}`);
    }

    const windows: any[] = [];
    let cursor = start;
    while (cursor < end) {
        const next = addUtcMonths(cursor, chunkMonths);
        const windowEnd = next < end ? next : end;
        windows.push({
            gte: cursor.toISOString(),
            lte: windowEnd.toISOString(),
        });
        cursor = windowEnd;
    }

    return windows;
}

function findMissingBucketRanges(gteMs: number, lteMs: number, bucketMs: number, haveTs: Set<number>) {
    const first = Math.floor(gteMs / bucketMs) * bucketMs;
    const last = Math.floor(lteMs / bucketMs) * bucketMs;
    const missing: { gte: number; lte: number; hours: number }[] = [];
    let runStart: number | null = null;
    for (let ts = first; ts <= last; ts += bucketMs) {
        if (haveTs.has(ts)) {
            if (runStart !== null) {
                missing.push({ gte: runStart, lte: ts - bucketMs, hours: Math.round((ts - runStart) / bucketMs) });
                runStart = null;
            }
        } else if (runStart === null) {
            runStart = ts;
        }
    }
    if (runStart !== null) {
        missing.push({ gte: runStart, lte: last, hours: Math.round((last - runStart) / bucketMs) + 1 });
    }
    return missing;
}

function pruneImmutableGaps(missing: { gte: number; lte: number; hours: number }[], lteMs: number, fileCover: { gte: number | null; lte: number | null; count: number; queried: { gte: number; lte: number }[] }[], nowMs: number = Date.now()) {
    const windowOld = lteMs < nowMs - IMMUTABLE_WINDOW_AGE_MS;
    return missing.filter((m: any) => {
        // Absence of local buckets is NEVER proof of emptiness: stray
        // buckets from a sibling window's file (e.g. boundary over-fetch)
        // must not vouch for anything. Only queriedRanges count, and only
        // for old windows — recent files may predate late-indexed trades.
        // (A former "leading no-trade gap" heuristic pruned everything
        // before the first local bucket; it once certified a whole month
        // as empty from 5 stray boundary buckets of the next window.)
        // Ranges an existing chunk file actually queried (only trusted for
        // old windows — recent files may predate late-indexed trades).
        // Coverage comes from meta.queriedRanges, not the file's overall
        // timeRange: a chunk rewritten from reused buckets plus sub-range
        // fetches only proves its fetched sub-ranges empty, never the
        // ranges it merely copied forward.
        if (windowOld) {
            for (const f of fileCover) {
                for (const q of f.queried || []) {
                    if (q.gte <= m.gte && q.lte >= m.lte) return false;
                }
            }
        }
        return true;
    });
}

function persistCacheChunk(chunkFile: any, meta: any, candles: any) {
    const payload = {
        meta: {
            ...meta,
            candleCount: candles.length,
            firstTs: candles.length > 0 ? new Date(candles[0][0]).toISOString() : null,
            lastTs: candles.length > 0 ? new Date(candles[candles.length - 1][0]).toISOString() : null,
        },
        candles,
    };
    writeJsonAtomic(chunkFile, payload);
}

// Stale chunk files accumulate when shifted windows change date-based file
// names (an hour shift crossing midnight orphans the old name). Only files
// whose embedded meta matches this request are eligible, and only once the
// caller has completed all windows — a failed run never deletes.
// Files whose recorded range does not overlap the run's active coverage are
// KEPT: a narrow run (e.g. --month 3) must not wipe older history cached by
// a wider run — out-of-window buckets are never carried forward, so deleting
// those files would destroy history that can only be refetched from Kibana.
function cleanupOrphanCacheChunks(outPath: any, requestKey: any, isMatch: (meta: any, requestKey: any) => boolean, activeFiles: Set<string>, activeRange?: { gte: number; lte: number } | null) {
    const removed: string[] = [];
    try {
        for (const file of siblingChunkFiles(outPath)) {
            if (activeFiles.has(path.resolve(file))) continue;
            const chunk = readCacheChunk(file, requestKey, isMatch);
            if (!chunk) continue;
            if (activeRange && Number.isFinite(chunk.rangeGte) && Number.isFinite(chunk.rangeLte)
                && Number.isFinite(activeRange.gte) && Number.isFinite(activeRange.lte)
                && ((chunk.rangeLte as number) <= activeRange.gte || (chunk.rangeGte as number) >= activeRange.lte)) continue;
            try {
                storage.unlink(file);
                removed.push(file);
            } catch (err: any) {
                console.warn(`  Could not remove orphan chunk ${path.relative(process.cwd(), file)}: ${getErrorMessage(err)}`);
            }
        }
    } catch (err: any) {
        console.warn(`  Orphan chunk cleanup skipped: ${getErrorMessage(err)}`);
        return [];
    }
    return removed;
}

/**
 * Reuse plan for one window: buckets already on disk + the ranges that still
 * need querying. When `allowSubFetch` is false (data with cross-range state
 * such as forward-filled crosses), the tail widening is skipped and the
 * caller must take full-window fetches — reuse (zero queries) still applies.
 */
function planWindowReuse(localCache: any, opts: { gteMs: number; lteMs: number; bucketMs: number; isTail: boolean; allowSubFetch?: boolean; nowMs?: number }) {
    const { gteMs, lteMs, bucketMs, isTail } = opts;
    const allowSubFetch = opts.allowSubFetch !== false;
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const valid = Number.isFinite(gteMs) && Number.isFinite(lteMs) && Number.isFinite(bucketMs) && bucketMs > 0;
    const reusable = valid
        ? cachedCandlesInRange(localCache, gteMs, lteMs)
        : [];
    let missing = valid
        ? findMissingBucketRanges(gteMs, lteMs, bucketMs, new Set(reusable.map((c: any) => Number(c[0]))))
        : [];
    // Immutable history (pruned again after the tail widening below, which
    // reintroduces the leading gap via its refresh set).
    const prune = () => {
        missing = pruneImmutableGaps(missing, lteMs, localCache.fileCover, nowMs);
    };
    prune();
    // Late-indexing guard: the newest window always re-fetches its
    // trailing overlap so zero-volume fills can gain real trades.
    if (allowSubFetch && isTail && reusable.length > 0) {
        const refreshFromMs = lteMs - TAIL_REFRESH_HOURS * 3600 * 1000;
        if (refreshFromMs > gteMs) {
            const refreshSet = new Set(
                reusable.filter((c: any) => Number(c[0]) < refreshFromMs).map((c: any) => Number(c[0])),
            );
            const refreshed = findMissingBucketRanges(gteMs, lteMs, bucketMs, refreshSet);
            // Only widen, never narrow: keep previously-missing buckets.
            const seen = new Set(missing.map((m: any) => `${m.gte}-${m.lte}`));
            for (const m of refreshed) {
                if (!seen.has(`${m.gte}-${m.lte}`)) missing.push(m);
            }
            missing.sort((a: any, b: any) => a.gte - b.gte);
            prune();
        }
    }
    const missingHours = missing.reduce((sum: number, m: any) => sum + m.hours, 0);
    const windowHours = valid ? Math.max(1, Math.round((lteMs - gteMs) / bucketMs)) : 1;
    return { reusable, missing, missingHours, windowHours, inputsValid: valid };
}

// ─── Shared progress output ───────────────────────────────────────────────────
// Both fetch modes (pool chunks, feed windows) print the same per-window
// lines so the output is comparable: one line per cached/reused window and
// one line per executed range query.
function formatWindowLine(unit: string, index: number, total: number, gte: string, lte: string, detail = '') {
    return `  ${unit} ${index}/${total}: ${gte} → ${lte}${detail ? ` ${detail}` : ''}`;
}

/**
 * Per-range fetch budget shared by every cached candle fetcher (pool, book,
 * feed). Retries a failing range up to `attempts` times with linear backoff
 * and an optional per-attempt timeout (aborted via signal passed as the 4th
 * fetchRange argument — fetchers that ignore it simply get no abort).
 * Defaults (attempts 1, no timeout) preserve the old single-shot behavior.
 */
async function fetchRangeWithRetry(
    fetchRange: (gteIso: string, lteIso: string, window: any, signal?: AbortSignal) => Promise<any>,
    opts: {
        gte: string;
        lte: string;
        window: any;
        label: string;
        attempts?: number;
        backoffBaseMs?: number;
        timeoutMs?: number;
        onRetry?: (info: { attempt: number; attempts: number; backoffMs: number; error: any; gte: string; lte: string }) => void;
    }
) {
    const attempts = Number.isFinite(Number(opts.attempts)) && Number(opts.attempts) >= 1 ? Math.floor(Number(opts.attempts)) : 1;
    const backoffBaseMs = Number.isFinite(Number(opts.backoffBaseMs)) && Number(opts.backoffBaseMs) >= 0 ? Number(opts.backoffBaseMs) : 0;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let signal: AbortSignal | undefined;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;
        const timeoutMessage = `${opts.label} timed out after ${Math.round(timeoutMs / 1000)}s`;
        if (timeoutMs > 0) {
            const controller = new AbortController();
            signal = controller.signal;
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort(new Error(timeoutMessage));
            }, timeoutMs);
        }
        try {
            const candles = await fetchRange(opts.gte, opts.lte, opts.window, signal);
            return { candles, attempts: attempt };
        } catch (err: any) {
            lastErr = timedOut && (err?.name === 'AbortError' || err?.message === timeoutMessage)
                ? new Error(timeoutMessage)
                : err;
            if (attempt < attempts) {
                const backoffMs = backoffBaseMs * attempt;
                try { opts.onRetry?.({ attempt, attempts, backoffMs, error: lastErr, gte: opts.gte, lte: opts.lte }); } catch (_) { /* logging must never fail the fetch */ }
                if (backoffMs > 0) await sleepMs(backoffMs);
            }
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    throw lastErr;
}

async function fetchRangeLogged(fetchRange: (gteIso: string, lteIso: string, window?: any, signal?: AbortSignal) => Promise<any[] | { candles: any[]; complete?: boolean }>, opts: { unit: string; index: number; total: number; gte: string; lte: string; note?: string; window?: any; retry?: { attempts?: number; backoffBaseMs?: number; timeoutMs?: number; onRetry?: (info: any) => void } }) {
    const startMs = Date.now();
    const label = `${opts.unit} ${opts.index}/${opts.total}`;
    const { candles: raw, attempts } = await fetchRangeWithRetry(fetchRange, {
        gte: opts.gte,
        lte: opts.lte,
        window: opts.window,
        label,
        attempts: opts.retry?.attempts,
        backoffBaseMs: opts.retry?.backoffBaseMs,
        timeoutMs: opts.retry?.timeoutMs,
        onRetry: opts.retry?.onRetry,
    });
    // A fetcher may return { candles, complete: false } for a partial result
    // (e.g. one swap direction failed). Partial candles are still merged
    // into this run's output, but the caller must not persist them as full
    // coverage — otherwise the missing side would never be re-queried.
    const complete = !Array.isArray(raw) && raw?.complete === false ? false : true;
    const candles = Array.isArray(raw) ? raw : (raw?.candles ?? []);
    const attemptNote = attempts > 1 ? ` (attempt ${attempts})` : '';
    const partialNote = complete ? '' : ' (partial — not cached)';
    const note = opts.note ? `${opts.note}` : '';
    console.log(formatWindowLine(opts.unit, opts.index, opts.total, opts.gte, opts.lte, `-> ${candles.length} candles (${((Date.now() - startMs) / 1000).toFixed(1)}s)${attemptNote}${partialNote}${note}`));
    return { candles, complete };
}

function higherVolumeWins(existing: any, incoming: any) {
    return incoming[5] > existing[5] ? incoming : existing;
}

/**
 * Run windows with bucket-level reuse. `windows` entries are
 * `{ index, gte, lte, file }` (1-based index). Returns merged candles.
 *
 * Fetch policy per window: exact reuse when nothing is missing, sub-range
 * queries merged over local when gaps are small (and `allowSubFetch`), else
 * one full-window fetch merged over local. Fresh data wins collisions by
 * volume/count, output is clamped to the window and sorted. A window whose
 * fetch reports partial (`{ candles, complete: false }`) is merged into
 * this run's output but NOT persisted, so the missing side is re-queried
 * on the next run instead of being baked in as gap-filled zeros.
 */
async function runCachedWindows(opts: {
    windows: any[];
    outPath: any;
    requestKey: any;
    isMatch: (meta: any, requestKey: any) => boolean;
    metaForWindow: (window: any) => any;
    // A fetch may return either a candle array (complete) or
    // { candles, complete: false } for a partial result that must be merged
    // but NOT persisted (see fetchRangeLogged).
    fetchRange: (gteIso: string, lteIso: string, window: any, signal?: AbortSignal) => Promise<any[] | { candles: any[]; complete?: boolean }>;
    bucketMs: number;
    allowSubFetch?: boolean;
    nowMs?: number;
    // Shared per-range fetch budget (used by the LP fetcher; book/feed keep
    // the single-shot default). See fetchRangeWithRetry.
    fetchAttempts?: number;
    fetchBackoffBaseMs?: number;
    fetchTimeoutMs?: number;
    onFetchRetry?: (info: { attempt: number; attempts: number; backoffMs: number; error: any; gte: string; lte: string }) => void;
}) {
    const { windows, outPath, requestKey, isMatch, metaForWindow, fetchRange, bucketMs } = opts;
    const allowSubFetch = opts.allowSubFetch !== false;
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const total = windows.length;
    const retry = {
        attempts: opts.fetchAttempts,
        backoffBaseMs: opts.fetchBackoffBaseMs,
        timeoutMs: opts.fetchTimeoutMs,
        onRetry: opts.onFetchRetry,
    };

    const localCache = loadBucketCache(outPath, requestKey, isMatch);
    if (localCache.files > 0) {
        console.log(`  Local cache: ${localCache.files} chunk files, ${localCache.byTs.size} buckets — fetching only what is missing`);
    }

    let merged: any[] = [];
    for (const windowEntry of windows) {
        const tag = formatWindowLine('Chunk', windowEntry.index, total, windowEntry.gte, windowEntry.lte);
        const gteMs = Date.parse(String(windowEntry.gte));
        const lteMs = Date.parse(String(windowEntry.lte));

        // Exact-match fast path: chunk file already holds this exact range.
        const exact = readCacheChunk(windowEntry.file, requestKey, isMatch);
        if (exact && exact.rangeGte === gteMs && exact.rangeLte === lteMs) {
            console.log(`${tag} (cached ${exact.candles.length} candles)`);
            merged = merged.length === 0
                ? exact.candles
                : mergeCandles(merged, exact.candles, { onCollision: higherVolumeWins });
            continue;
        }

        const plan = planWindowReuse(localCache, {
            gteMs, lteMs, bucketMs,
            isTail: windowEntry.index === total,
            allowSubFetch, nowMs,
        });
        const { reusable, missing, missingHours, windowHours, inputsValid } = plan;
        const reusableNote = reusable.length > 0 ? `, ${reusable.length} buckets local` : '';
        if (inputsValid && missing.length === 0 && (reusable.length > 0 || localCache.files > 0)) {
            console.log(`${tag} (reused ${reusable.length} local buckets, nothing missing)`);
            persistCacheChunk(windowEntry.file, { ...metaForWindow(windowEntry), fetchedAt: new Date().toISOString(), queriedRanges: priorQueriedInWindow(windowEntry.file, requestKey, isMatch, gteMs, lteMs) }, reusable);
            merged = merged.length === 0
                ? reusable
                : mergeCandles(merged, reusable, { onCollision: higherVolumeWins });
            continue;
        }

        let candles: any[];
        let queriedRanges: { gte: number; lte: number }[];
        // A partial sub-range makes the whole window partial: gap-filled
        // buckets from the surviving side would otherwise claim coverage
        // the failed side never earned, baking the skew into the cache.
        let windowComplete = true;
        if (allowSubFetch && reusable.length > 0 && missing.length > 0 && missingHours <= windowHours / 2 && missing.length <= 3) {
            // Small gaps: query only the missing sub-ranges, merge over local.
            console.log(`${tag} (local cover${reusableNote}; fetching ${missingHours}h in ${missing.length} sub-range(s))`);
            let mergedLocal: any[] = reusable.slice();
            for (const m of missing) {
                // Extend lte past the final bucket start: the ES range is
                // inclusive and m.lte is a bucket *start*, so without this
                // the bucket's real trades are cut off and the gap-filler
                // freezes it as a zero-volume candle. Over-fetch is safe —
                // merged output is clamped to the window below.
                const part = await fetchRangeLogged(
                    fetchRange,
                    { unit: 'Chunk', index: windowEntry.index, total, gte: new Date(m.gte).toISOString(), lte: new Date(m.lte + bucketMs).toISOString(), window: windowEntry, retry },
                );
                if (!part.complete) windowComplete = false;
                mergedLocal = mergeCandles(mergedLocal, part.candles, { onCollision: higherVolumeWins });
            }
            // Clamp to the window (drops the one-bucket over-fetch above).
            candles = mergedLocal.filter((c: any) => Number(c[0]) >= gteMs && Number(c[0]) <= lteMs);
            // Claimed coverage is the canonical missing ranges (a conservative
            // subset of what was actually queried with the +1-bucket overlap),
            // plus previously-proven in-window coverage surviving the rewrite.
            queriedRanges = missing.map((m: any) => ({ gte: m.gte, lte: m.lte }))
                .concat(priorQueriedInWindow(windowEntry.file, requestKey, isMatch, gteMs, lteMs));
        } else {
            if (reusable.length > 0) {
                console.log(`${tag} (local cover${reusableNote}; gap too large — full window fetch)`);
            }
            const fresh = await fetchRangeLogged(
                fetchRange,
                { unit: 'Chunk', index: windowEntry.index, total, gte: windowEntry.gte, lte: windowEntry.lte, window: windowEntry, retry },
            );
            if (!fresh.complete) windowComplete = false;
            candles = reusable.length > 0
                ? mergeCandles(reusable, fresh.candles, { onCollision: higherVolumeWins }).filter((c: any) => Number(c[0]) >= gteMs && Number(c[0]) <= lteMs).sort((a: any, b: any) => a[0] - b[0])
                : fresh.candles;
            queriedRanges = [{ gte: gteMs, lte: lteMs }];
        }
        if (windowComplete) {
            persistCacheChunk(windowEntry.file, { ...metaForWindow(windowEntry), fetchedAt: new Date().toISOString(), queriedRanges }, candles);
        } else {
            console.log(`${tag} (partial — kept for this run, not cached; will re-query next run)`);
        }
        merged = merged.length === 0
            ? candles
            : mergeCandles(merged, candles, { onCollision: higherVolumeWins });
    }

    const windowGtes = windows.map((w: any) => Date.parse(String(w.gte))).filter(Number.isFinite);
    const windowLtes = windows.map((w: any) => Date.parse(String(w.lte))).filter(Number.isFinite);
    const activeRange = windowGtes.length > 0 && windowLtes.length > 0
        ? { gte: Math.min(...windowGtes), lte: Math.max(...windowLtes) }
        : null;
    const removed = cleanupOrphanCacheChunks(outPath, requestKey, isMatch, new Set(windows.map((w: any) => path.resolve(w.file))), activeRange);
    if (removed.length > 0) {
        console.log(`  Cleaned ${removed.length} orphan chunk file(s): ${removed.map((f: string) => path.basename(f)).join(', ')}`);
    }
    return merged;
}

export {
    TAIL_REFRESH_HOURS,
    IMMUTABLE_WINDOW_AGE_MS,
    siblingChunkFiles,
    chunkPathFor,
    readCacheChunk,
    priorQueriedInWindow,
    loadBucketCache,
    cachedCandlesInRange,
    addUtcMonths,
    normalizeDateInput,
    buildFetchWindowsFromRange,
    findMissingBucketRanges,
    pruneImmutableGaps,
    persistCacheChunk,
    cleanupOrphanCacheChunks,
    planWindowReuse,
    formatWindowLine,
    fetchRangeLogged,
    fetchRangeWithRetry,
    runCachedWindows,
};

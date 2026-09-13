'use strict';
/**
 * WINDOW CACHE — persistent bucket cache for windowed Kibana candle fetches.
 *
 * Storage is decoupled from querying: candles live in fixed calendar-month
 * shards (`<base>.shard_YYYY-MM.json`, UTC), one file per month with a stable
 * name that never shifts. A run maps its requested range onto the overlapping
 * shards, loads ONLY those files, fetches only genuinely missing buckets, and
 * writes back ONLY shards that gained buckets or query coverage. Pure-reuse
 * runs perform zero writes and zero deletes.
 *
 * Each shard holds `{ meta, candles }` where `meta.queriedRanges` records the
 * spans actually queried to produce the data (monotonically unioned on every
 * write). Missing buckets are pruned only against recorded query coverage —
 * the absence of local buckets alone never certifies history as empty.
 *
 * Legacy `*.chunk_<ii>_<start>_<end>.json` files (run-relative naming) are
 * still read: their buckets and query coverage are absorbed into the
 * overlapping shards, and a legacy file is deleted once every one of its
 * buckets provably lives in a shard. Disjoint legacy files are simply never
 * loaded and never touched — narrow runs cannot wipe older history by
 * construction (no orphan-deletion pass exists anymore).
 *
 * Callers supply:
 *   - `requestKey` — opaque identity object stored in each shard's meta,
 *   - `isMatch(meta, requestKey)` — same-pool/feed/interval/assets check,
 *   - `fetchRange(gteIso, lteIso)` — query one (sub-)range, gap-filled grid,
 *   - `metaForWindow(window)` — identity meta fields (source/feed/pool/...);
 *     the runner overrides timeRange with the shard bounds and drops
 *     chunkIndex, which is meaningless for stable shards.
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

// ─── Month-shard naming ───────────────────────────────────────────────────────
// Shard key is the UTC calendar month; bounds are half-open [start, end) so
// every bucket timestamp maps to exactly one shard (a bucket exactly at a
// month boundary belongs to the new month).

function shardKeyForTimestamp(tsMs: any) {
    const d = new Date(Number(tsMs));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shardBoundsForKey(key: any) {
    const parts = String(key).split('-').map(Number);
    const start = Date.UTC(parts[0], parts[1] - 1, 1);
    const end = parts[1] === 12 ? Date.UTC(parts[0] + 1, 0, 1) : Date.UTC(parts[0], parts[1], 1);
    return { start, end };
}

function shardKeysForRange(gteMs: any, lteMs: any) {
    const keys: string[] = [];
    let cursor = new Date(Date.UTC(
        new Date(Number(gteMs)).getUTCFullYear(),
        new Date(Number(gteMs)).getUTCMonth(), 1));
    const last = new Date(Number(lteMs));
    while (cursor <= last) {
        keys.push(shardKeyForTimestamp(cursor.getTime()));
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return keys;
}

function shardRangeOverlaps(shardKey: any, gteMs: any, lteMs: any) {
    const { start, end } = shardBoundsForKey(shardKey);
    return start <= lteMs && end > gteMs;
}

function shardPathFor(outPath: any, shardKey: any) {
    const parsed = path.parse(outPath);
    return path.join(parsed.dir, `${parsed.name}.shard_${shardKey}${parsed.ext}`);
}

function siblingCacheFiles(outPath: any) {
    const resolved = path.resolve(outPath);
    const parsed = path.parse(resolved);
    if (!storage.exists(parsed.dir)) return [];
    const shardPrefix = `${parsed.name}.shard_`;
    const legacyPrefix = `${parsed.name}.chunk_`;
    const out: { file: string; kind: 'shard' | 'legacy'; shardKey: string | null }[] = [];
    for (const name of storage.readdir(parsed.dir)) {
        if (!name.endsWith(parsed.ext)) continue;
        if (name.startsWith(shardPrefix)) {
            const key = name.slice(shardPrefix.length, name.length - parsed.ext.length);
            if (!/^\d{4}-\d{2}$/.test(key)) continue;
            out.push({ file: path.join(parsed.dir, name), kind: 'shard', shardKey: key });
        } else if (name.startsWith(legacyPrefix)) {
            out.push({ file: path.join(parsed.dir, name), kind: 'legacy', shardKey: null });
        }
    }
    out.sort((a: any, b: any) => (a.file < b.file ? -1 : 1));
    return out;
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

function rangesOverlap(aGte: any, aLte: any, bGte: any, bLte: any) {
    return aGte <= bLte && aLte >= bGte;
}

function loadBucketCache(outPath: any, requestKey: any, isMatch: (meta: any, requestKey: any) => boolean, range?: { gte: number; lte: number } | null) {
    const byTs = new Map();
    const fileCover: { gte: number | null; lte: number | null; count: number; queried: { gte: number; lte: number }[] }[] = [];
    const legacy: { file: string; candles: any[]; queried: { gte: number; lte: number }[] }[] = [];
    const shards: { file: string; shardKey: string; candles: any[]; queried: { gte: number; lte: number }[] }[] = [];
    let files = 0;
    const scoped = range && Number.isFinite(range.gte) && Number.isFinite(range.lte);
    for (const entry of siblingCacheFiles(outPath)) {
        if (entry.kind === 'shard' && entry.shardKey) {
            // Shards outside the requested range are never even opened —
            // a narrow run reads only the months it needs.
            if (scoped && !shardRangeOverlaps(entry.shardKey, (range as any).gte, (range as any).lte)) continue;
        }
        const chunk = readCacheChunk(entry.file, requestKey, isMatch);
        if (!chunk) continue;
        if (entry.kind === 'legacy' && scoped
            && chunk.rangeGte !== null && chunk.rangeLte !== null
            && !rangesOverlap(chunk.rangeGte, chunk.rangeLte, (range as any).gte, (range as any).lte)) continue;
        files += 1;
        fileCover.push({ gte: chunk.rangeGte, lte: chunk.rangeLte, count: chunk.candles.length, queried: chunk.queried });
        for (const c of chunk.candles) {
            if (!Array.isArray(c)) continue;
            const ts = Number(c[0]);
            if (!Number.isFinite(ts)) continue;
            const prev = byTs.get(ts);
            if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) byTs.set(ts, c);
        }
        if (entry.kind === 'legacy') {
            legacy.push({ file: entry.file, candles: chunk.candles.filter((c: any) => Array.isArray(c)), queried: chunk.queried });
        } else if (entry.shardKey) {
            shards.push({ file: entry.file, shardKey: entry.shardKey, candles: chunk.candles.filter((c: any) => Array.isArray(c)), queried: chunk.queried });
        }
    }
    return { byTs, files, fileCover, legacy, shards };
}

function cachedCandlesInRange(localCache: any, gteMs: number, lteMs: number) {
    const out: any[] = [];
    for (const [ts, c] of localCache.byTs) {
        if (ts >= gteMs && ts <= lteMs) out.push(c);
    }
    out.sort((a: any, b: any) => a[0] - b[0]);
    return out;
}

// ─── Queried-range set ops ────────────────────────────────────────────────────
// Coverage provenance: normalize recorded spans (sort, merge overlapping or
// bucket-adjacent) so growth checks and absorption decisions are exact.

function unionQueriedRanges(ranges: { gte: number; lte: number }[], bucketMs: number) {
    const clean = (ranges || [])
        .filter((q: any) => q && Number.isFinite(Number(q.gte)) && Number.isFinite(Number(q.lte)) && Number(q.lte) >= Number(q.gte))
        .map((q: any) => ({ gte: Number(q.gte), lte: Number(q.lte) }))
        .sort((a: any, b: any) => a.gte - b.gte || a.lte - b.lte);
    const merged: { gte: number; lte: number }[] = [];
    const gap = Number.isFinite(Number(bucketMs)) && Number(bucketMs) > 0 ? Number(bucketMs) : 0;
    for (const q of clean) {
        const top = merged[merged.length - 1];
        if (top && q.gte <= top.lte + gap) {
            if (q.lte > top.lte) top.lte = q.lte;
        } else {
            merged.push({ gte: q.gte, lte: q.lte });
        }
    }
    return merged;
}

function rangesCoveredBy(have: { gte: number; lte: number }[], want: { gte: number; lte: number }[]) {
    for (const w of want || []) {
        let covered = false;
        for (const h of have || []) {
            if (h.gte <= w.gte && h.lte >= w.lte) { covered = true; break; }
        }
        if (!covered) return false;
    }
    return true;
}

function clipRangeTo(q: { gte: number; lte: number }, gteMs: number, lteMs: number) {
    const gte = Math.max(q.gte, gteMs);
    const lte = Math.min(q.lte, lteMs);
    return lte >= gte ? { gte, lte } : null;
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

function candlesEqual(a: any[], b: any[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
        for (let j = 0; j < x.length; j++) {
            if (Number(x[j]) !== Number(y[j])) return false;
        }
    }
    return true;
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

function sortedCandles(byTs: Map<number, any>) {
    return [...byTs.values()].sort((a: any, b: any) => Number(a[0]) - Number(b[0]));
}

/**
 * Run windows with bucket-level reuse against month-shard storage. `windows`
 * entries are `{ index, gte, lte }` (1-based index, fetch-planning splits —
 * `chunkMonths` controls query batching only, never file layout). Returns
 * merged candles clipped to the requested windows.
 *
 * Fetch policy per window: exact reuse when nothing is missing, sub-range
 * queries merged over local when gaps are small (and `allowSubFetch`), else
 * one full-window fetch merged over local. Fresh data wins collisions by
 * volume/count, output is clamped to the window and sorted. A window whose
 * fetch reports partial (`{ candles, complete: false }`) is merged into
 * this run's output but NOT persisted, so the missing side is re-queried
 * on the next run instead of being baked in as gap-filled zeros.
 *
 * Persistence is per shard and write-on-change only: a shard file is
 * rewritten solely when it gains buckets or query coverage. Reuse-only runs
 * touch nothing on disk. Legacy `*.chunk_*` files overlapping the run are
 * absorbed (buckets + coverage folded into the shards) and deleted once
 * every one of their buckets provably lives in a shard; disjoint legacy
 * files are never loaded and never deleted.
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

    const bounds = windows.map((w: any) => ({
        gte: Date.parse(String(w.gte)),
        lte: Date.parse(String(w.lte)),
    }));
    const finiteBounds = bounds.every((b: any) => Number.isFinite(b.gte) && Number.isFinite(b.lte));
    const overall = finiteBounds && bounds.length > 0
        ? { gte: Math.min(...bounds.map((b: any) => b.gte)), lte: Math.max(...bounds.map((b: any) => b.lte)) }
        : null;

    // Scoped load: only shards/legacy files overlapping the run are opened.
    const localCache = loadBucketCache(outPath, requestKey, isMatch, overall);
    if (localCache.files > 0) {
        console.log(`  Local cache: ${localCache.files} file(s), ${localCache.byTs.size} buckets — fetching only what is missing`);
    }

    // In-memory shard states for every month the run touches, seeded from
    // whatever shard files already exist.
    const shardStates = new Map<string, {
        key: string; file: string;
        candles: Map<number, any>;
        queried: { gte: number; lte: number }[];
        pendingQueried: { gte: number; lte: number }[];
    }>();
    if (overall) {
        for (const key of shardKeysForRange(overall.gte, overall.lte)) {
            const file = shardPathFor(outPath, key);
            const existing = localCache.shards.find((s: any) => s.shardKey === key);
            const candles = new Map<number, any>();
            if (existing) {
                for (const c of existing.candles) {
                    const ts = Number(c[0]);
                    if (Number.isFinite(ts)) candles.set(ts, c);
                }
            }
            shardStates.set(key, {
                key, file, candles,
                queried: unionQueriedRanges(existing?.queried ?? [], bucketMs),
                pendingQueried: [],
            });
        }
        // Fold legacy query coverage into the overlapping shards so the
        // provenance survives absorption (a span the legacy file really
        // queried stays proven-queried after the file is gone).
        for (const leg of localCache.legacy) {
            for (const q of leg.queried) {
                for (const state of shardStates.values()) {
                    const { start, end } = shardBoundsForKey(state.key);
                    const clipped = clipRangeTo(q, start, end);
                    if (clipped) state.pendingQueried.push(clipped);
                }
            }
        }
    }

    const noteCompletedWindow = (gteMs: number, lteMs: number, candles: any[], queried: { gte: number; lte: number }[]) => {
        // Later windows plan against what earlier windows proved: fresh
        // buckets join the pool and fresh coverage joins the cover, so a
        // re-query inside one run never fetches the same span twice.
        // Only complete windows feed this — partial data stays in this
        // run's output and is re-queried next run.
        for (const c of candles) {
            if (!Array.isArray(c)) continue;
            const ts = Number(c[0]);
            if (!Number.isFinite(ts)) continue;
            const prev = localCache.byTs.get(ts);
            if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) localCache.byTs.set(ts, c);
        }
        if (queried.length > 0) {
            localCache.fileCover.push({ gte: gteMs, lte: lteMs, count: candles.length, queried });
        }
        // Fan window results out to the shards they fall in.
        for (const state of shardStates.values()) {
            const { start, end } = shardBoundsForKey(state.key);
            for (const c of candles) {
                const ts = Number(c[0]);
                if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
                const prev = state.candles.get(ts);
                if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) state.candles.set(ts, c);
            }
            for (const q of queried) {
                const clipped = clipRangeTo(q, start, end);
                if (clipped) state.pendingQueried.push(clipped);
            }
        }
    };

    let merged: any[] = [];
    for (const windowEntry of windows) {
        const tag = formatWindowLine('Chunk', windowEntry.index, total, windowEntry.gte, windowEntry.lte);
        const gteMs = Date.parse(String(windowEntry.gte));
        const lteMs = Date.parse(String(windowEntry.lte));

        const plan = planWindowReuse(localCache, {
            gteMs, lteMs, bucketMs,
            isTail: windowEntry.index === total,
            allowSubFetch, nowMs,
        });
        const { reusable, missing, missingHours, windowHours, inputsValid } = plan;
        const reusableNote = reusable.length > 0 ? `, ${reusable.length} buckets local` : '';
        if (inputsValid && missing.length === 0 && (reusable.length > 0 || localCache.files > 0)) {
            console.log(`${tag} (reused ${reusable.length} local buckets, nothing missing)`);
            // Reuse is read-only: shard files already hold these buckets, so
            // nothing is rewritten.
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
            // subset of what was actually queried with the +1-bucket overlap).
            queriedRanges = missing.map((m: any) => ({ gte: m.gte, lte: m.lte }));
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
            noteCompletedWindow(gteMs, lteMs, candles, queriedRanges);
        } else {
            console.log(`${tag} (partial — kept for this run, not cached; will re-query next run)`);
        }
        merged = merged.length === 0
            ? candles
            : mergeCandles(merged, candles, { onCollision: higherVolumeWins });
    }

    // Flush: rewrite only shards that gained buckets or coverage. Everything
    // else on disk is already current.
    if (overall) {
        const fetchedAt = new Date().toISOString();
        for (const state of shardStates.values()) {
            const { start, end } = shardBoundsForKey(state.key);
            // Absorb every loaded bucket in this shard's span (legacy files
            // included): presence on disk already makes a bucket reusable,
            // so folding it into its home shard preserves trust semantics
            // exactly while letting the legacy file retire below.
            for (const [ts, c] of localCache.byTs) {
                if (ts < start || ts >= end) continue;
                const prev = state.candles.get(ts);
                if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) state.candles.set(ts, c);
            }
            const before = sortedCandles(new Map(
                (localCache.shards.find((s: any) => s.shardKey === state.key)?.candles || [])
                    .filter((c: any) => Array.isArray(c) && Number.isFinite(Number(c[0])))
                    .map((c: any) => [Number(c[0]), c] as [number, any]),
            ));
            const after = sortedCandles(state.candles);
            const union = unionQueriedRanges(state.queried.concat(state.pendingQueried), bucketMs);
            if (candlesEqual(before, after) && rangesCoveredBy(state.queried, union)) continue;
            const synthWindow = {
                index: 0,
                gte: new Date(start).toISOString(),
                lte: new Date(end).toISOString(),
            };
            const meta = { ...metaForWindow(synthWindow), fetchedAt, queriedRanges: union };
            meta.timeRange = { gte: synthWindow.gte, lte: synthWindow.lte };
            meta.shard = state.key;
            delete meta.chunkIndex;
            persistCacheChunk(state.file, meta, after);
            state.queried = union;
            state.pendingQueried = [];
        }

        // Retire legacy files whose every bucket now provably lives in a
        // shard. Buckets outside this run's range block retirement (their
        // home shards were not loaded), so nothing absorbable is ever lost —
        // a later wider run retires them. Disjoint legacy files were never
        // loaded and are never touched.
        const absorbed: string[] = [];
        for (const leg of localCache.legacy) {
            let complete = true;
            for (const c of leg.candles) {
                const ts = Number(c?.[0]);
                if (!Number.isFinite(ts)) continue;
                if (overall && (ts < overall.gte || ts > overall.lte)) { complete = false; break; }
                const state = shardStates.get(shardKeyForTimestamp(ts));
                if (!state || !state.candles.has(ts)) { complete = false; break; }
            }
            if (!complete) continue;
            try {
                storage.unlink(leg.file);
                absorbed.push(leg.file);
            } catch (err: any) {
                console.warn(`  Could not absorb legacy chunk ${path.relative(process.cwd(), leg.file)}: ${getErrorMessage(err)}`);
            }
        }
        if (absorbed.length > 0) {
            console.log(`  Absorbed ${absorbed.length} legacy chunk file(s): ${absorbed.map((f: string) => path.basename(f)).join(', ')}`);
        }
    }
    return merged;
}

export {
    TAIL_REFRESH_HOURS,
    IMMUTABLE_WINDOW_AGE_MS,
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    shardPathFor,
    readCacheChunk,
    loadBucketCache,
    cachedCandlesInRange,
    unionQueriedRanges,
    rangesCoveredBy,
    addUtcMonths,
    normalizeDateInput,
    buildFetchWindowsFromRange,
    findMissingBucketRanges,
    pruneImmutableGaps,
    persistCacheChunk,
    planWindowReuse,
    formatWindowLine,
    fetchRangeLogged,
    fetchRangeWithRetry,
    runCachedWindows,
};

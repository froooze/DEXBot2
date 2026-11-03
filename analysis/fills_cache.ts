'use strict';

/**
 * FILLS CACHE — persistent calendar-month shard cache for per-account
 * `fill_order` fetches (`analysis/fills_source.ts`).
 *
 * `dexbot pnl` re-queries Kibana on every run; this layer lets a settled month
 * be answered from disk. It mirrors the design principles of the candle cache
 * (`market_adapter/inputs/window_cache.ts`) but is intentionally fills-specific:
 * fills are sparse point events, so reuse is driven purely by recorded query
 * COVERAGE (a month queried and found empty is still covered), not by a
 * bucket-by-bucket presence grid.
 *
 * Storage: `<cacheDir>/fills/<accountId>.shard_YYYY-MM.json`, one file per UTC
 * calendar month, holding `{ meta: { accountId, fetchedAt, queriedRanges },
 * fills }`. `queriedRanges` records the spans actually queried together with
 * `at` (when the query ran).
 *
 * Reuse rule: a recorded span is trusted only up to `at - TAIL_SETTLE_LAG_MS`,
 * because Kibana indexes fills with a lag — a query cannot certify the last
 * few hours before it ran. The unsettled tail is therefore re-queried on the
 * next run (incremental refresh), while older settled spans are reused with
 * zero queries and zero writes. `refresh` (from `--refresh-account`) ignores
 * coverage and re-queries the whole requested range, but still merges what it
 * gets back so a fresh query can never drop fills outside the requested span.
 */

import path from 'node:path';
import { getStorage } from '../modules/storage/index.js';
import { PATHS } from '../modules/paths.js';
import { isAccountIdRef } from './bot_key_utils.js';
import { writeJsonAtomic } from '../market_adapter/utils/atomic_write.js';
import {
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    shardPathFor,
    unionQueriedRanges,
    compactCoverage,
    mergeSpans,
    subtractRanges,
} from '../market_adapter/utils/month_shards.js';
import type { QueriedRange, Span } from '../market_adapter/utils/month_shards.js';
import { fetchAllFills, FillRecord } from './fills_source.js';

const storage = getStorage();
const { readJSON } = storage;

/** How long after a query its trailing fills may still be late-indexed. */
const TAIL_SETTLE_LAG_MS = 6 * 3600 * 1000;
/** Upper bound on spans persisted per shard (keeps coverage bookkeeping small). */
const MAX_COVERAGE_SPANS = 64;
const SHARD_EXT = '.json';

interface FillsShard {
    meta: { accountId: string; fetchedAt: string; queriedRanges: QueriedRange[] };
    fills: FillRecord[];
}

interface FetchFillsOptions {
    /** Override the cache root (tests). */
    cacheDir?: string;
    /** Ignore coverage and re-query the requested range (still merges results). */
    refresh?: boolean;
    /** Fixed "now" for deterministic settle math (tests). */
    nowMs?: number;
    /** Injected range fetcher (tests); defaults to the real Kibana query. */
    fetchRange?: (gteIso: string, lteIso: string) => Promise<FillRecord[]>;
    quiet?: boolean;
}

function accountFileBase(accountId: string): string {
    const s = String(accountId ?? '').trim();
    if (isAccountIdRef(s)) return s;
    return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
}

function basePathFor(cacheDir: string, accountId: string): string {
    return path.join(cacheDir, 'fills', `${accountFileBase(accountId)}${SHARD_EXT}`);
}

function readShard(shardFile: string, accountId: string): FillsShard | null {
    try {
        const parsed = readJSON<{ meta?: { accountId?: unknown; fetchedAt?: unknown; queriedRanges?: QueriedRange[] }; fills?: FillRecord[] }>(shardFile);
        if (!parsed || parsed.meta?.accountId !== accountId) return null;
        if (!Array.isArray(parsed.fills)) return null;
        return {
            meta: {
                accountId,
                fetchedAt: String(parsed.meta?.fetchedAt || ''),
                queriedRanges: Array.isArray(parsed.meta?.queriedRanges) ? parsed.meta.queriedRanges : [],
            },
            fills: parsed.fills,
        };
    } catch (_) {
        return null;
    }
}

/** Sort, merge overlapping/adjacent same-`at` spans, cap the list length. */
function normalizeQueried(ranges: QueriedRange[]): QueriedRange[] {
    return compactCoverage(unionQueriedRanges(ranges || [], 1), MAX_COVERAGE_SPANS);
}

/** Record a freshly queried span, dropping older spans it fully supersedes. */
function addCoverage(queried: QueriedRange[], span: Span, atMs: number): QueriedRange[] {
    const kept = queried.filter((q: QueriedRange) => !(q.gte >= span.gte && q.lte <= span.lte));
    return normalizeQueried([...kept, { gte: span.gte, lte: span.lte, at: atMs }]);
}

/**
 * Portions of queried spans that are safe to reuse: the part up to
 * `at - TAIL_SETTLE_LAG_MS`. A span with an unknown `at` certifies nothing.
 */
function trustedSegments(queried: QueriedRange[], nowMs: number): Span[] {
    const segs: Span[] = [];
    for (const q of queried) {
        if (q.at == null) continue;
        const end = Math.min(q.lte, q.at - TAIL_SETTLE_LAG_MS, nowMs - TAIL_SETTLE_LAG_MS);
        if (end >= q.gte) segs.push({ gte: q.gte, lte: end });
    }
    return mergeSpans(segs);
}

function fillKey(f: FillRecord): string {
    return `${f.blockNum}:${f.opNum}`;
}

function compareFills(a: FillRecord, b: FillRecord): number {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    if (a.blockNum !== b.blockNum) return a.blockNum - b.blockNum;
    return a.opNum - b.opNum;
}

/** Union two fill lists, deduped by the unique operation identity. */
function mergeFills(existing: FillRecord[], incoming: FillRecord[]): FillRecord[] {
    const byKey = new Map<string, FillRecord>();
    for (const f of existing) byKey.set(fillKey(f), f);
    for (const f of incoming) byKey.set(fillKey(f), f);
    return [...byKey.values()].sort(compareFills);
}

/**
 * Fetch every fill_order for an account over [gteIso, lteIso], reusing cached
 * month shards and querying only their missing spans. Falls back to a direct
 * fetch when the range is malformed.
 */
async function fetchFillsCached(
    config: Record<string, unknown>,
    accountId: string,
    gteIso: string,
    lteIso: string,
    options: FetchFillsOptions = {},
): Promise<FillRecord[]> {
    const gteMs = Date.parse(gteIso);
    const lteMs = Date.parse(lteIso);
    const doFetch = options.fetchRange ?? ((gte: string, lte: string) => fetchAllFills(config, accountId, gte, lte));
    if (!Number.isFinite(gteMs) || !Number.isFinite(lteMs) || lteMs < gteMs) {
        return doFetch(gteIso, lteIso);
    }

    const nowMs = options.nowMs ?? Date.now();
    const cacheDir = options.cacheDir ?? PATHS.ANALYSIS.CACHE_DIR;
    const basePath = basePathFor(cacheDir, accountId);
    const collected = new Map<string, FillRecord>();
    let fetchedSpans = 0;
    let queriedFills = 0;
    let reusedMonths = 0;

    for (const key of shardKeysForRange(gteMs, lteMs)) {
        const { start, end } = shardBoundsForKey(key);
        const shardGte = Math.max(gteMs, start);
        const shardLte = Math.min(lteMs, end - 1);
        if (shardLte < shardGte) continue;

        const shardFile = shardPathFor(basePath, key);
        const shard = readShard(shardFile, accountId);
        const existingQueried = shard ? normalizeQueried(shard.meta.queriedRanges) : [];
        const trusted = options.refresh ? [] : trustedSegments(existingQueried, nowMs);
        const missing = subtractRanges({ gte: shardGte, lte: shardLte }, trusted);
        if (shard && missing.length === 0) reusedMonths += 1;

        let fills = shard ? shard.fills : [];
        let queried = existingQueried;
        let changed = false;
        for (const span of missing) {
            const incoming = await doFetch(new Date(span.gte).toISOString(), new Date(span.lte).toISOString());
            queriedFills += incoming.length;
            fetchedSpans += 1;
            fills = mergeFills(fills, incoming);
            queried = addCoverage(queried, span, nowMs);
            changed = true;
        }

        for (const f of fills) {
            const t = Date.parse(f.time);
            if (Number.isFinite(t) && t >= gteMs && t <= lteMs) collected.set(fillKey(f), f);
        }

        if (changed) {
            writeJsonAtomic(shardFile, {
                meta: { accountId, fetchedAt: new Date(nowMs).toISOString(), queriedRanges: queried },
                fills,
            });
        }
    }

    if (!options.quiet && fetchedSpans > 0) {
        const reuseNote = reusedMonths > 0 ? `; ${reusedMonths} month(s) reused from cache` : '';
        console.log(`  [cache] queried ${fetchedSpans} fill range(s) (${queriedFills} fill(s))${reuseNote}`);
    }

    return [...collected.values()].sort(compareFills);
}

export {
    fetchFillsCached,
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    basePathFor,
    shardPathFor,
    trustedSegments,
    subtractRanges,
    mergeFills,
    fillKey,
    TAIL_SETTLE_LAG_MS,
    MAX_COVERAGE_SPANS,
};
export type { QueriedRange, FillsShard, FetchFillsOptions };

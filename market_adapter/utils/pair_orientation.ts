'use strict';
/**
 * PAIR ORIENTATION — one definition of "the same pair, seen from the other
 * side", shared by the LP / order-book / feed candle caches.
 *
 * The three candle sources historically keyed their cache on the exact typed
 * orientation (assetA/assetB in order), so `BTS/IOB.XRP` and `IOB.XRP/BTS`
 * were two unrelated cache families holding reciprocal data. They now store
 * under ONE canonical orientation and translate on the way in/out:
 *
 *   canonical  — the asset with the lower id is leg A (BTS-first for ids
 *                `1.3.0` vs `1.3.5537`). Deterministic and request-independent,
 *                so both directions resolve to the same folder.
 *   inversion  — OHLC reciprocals with high/low swapped. open↔open and
 *                close↔close (NOT swapped): that is exactly what a direct
 *                fetch of the inverse pair produces for a chronological
 *                bucket. Verified against real pool shards (`bts_iob_xrp`
 *                open 0.00099711 ↔ `iob_xrp_bts` open 1002.8976).
 *
 * Also the single home for the folder slug, the same/swapped asset-identity
 * checks and the legacy-inverse sibling-path rule, so the three source
 * fetchers cannot drift on what "the other orientation" means.
 *
 * Pure and I/O-free (only path arithmetic and string slugs) so any runtime
 * can import it.
 */

import { path } from '../../modules/path_api.js';
import { slugPart } from '../interval_utils.js';

interface OrientableAsset {
    id?: string | null;
    precision?: unknown;
    symbol?: string | null;
}

/** The asset legs stored on every shard meta and cache request key. */
interface AssetPairLike {
    assetA?: { id?: string | null; precision?: unknown } | null;
    assetB?: { id?: string | null; precision?: unknown } | null;
}

type Candle = number[];

/** Numeric-aware compare of dotted BitShares ids (`1.3.2` < `1.3.10`). */
function compareAssetIds(a: unknown, b: unknown): number {
    const pa = String(a ?? '').split('.');
    const pb = String(b ?? '').split('.');
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = Number(pa[i]);
        const y = Number(pb[i]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            if (x !== y) return x - y;
        } else {
            const sx = String(pa[i] ?? '');
            const sy = String(pb[i] ?? '');
            if (sx !== sy) return sx < sy ? -1 : 1;
        }
    }
    return 0;
}

/**
 * Order a pair canonically (lower asset id first). Falls back to symbol order
 * when ids are missing, and keeps the caller's order (flipped=false) when
 * neither can order the legs.
 */
function canonicalPair<A extends OrientableAsset, B extends OrientableAsset>(assetA: A, assetB: B): { assetA: A | B; assetB: A | B; flipped: boolean } {
    let cmp = compareAssetIds(assetA?.id, assetB?.id);
    if (cmp === 0) {
        const sa = String(assetA?.symbol ?? '');
        const sb = String(assetB?.symbol ?? '');
        cmp = sa === sb ? 0 : (sa < sb ? -1 : 1);
    }
    if (cmp <= 0) return { assetA, assetB, flipped: false };
    return { assetA: assetB, assetB: assetA, flipped: true };
}

/** Slug of the pair cache folder (`bts_iob_xrp`), canonical-agnostic. */
function pairFolderSlug(assetA: OrientableAsset | null | undefined, assetB: OrientableAsset | null | undefined): string {
    return `${slugPart(assetA?.symbol || assetA?.id)}_${slugPart(assetB?.symbol || assetB?.id)}`;
}

/** Same asset legs, same order (id + precision). */
function sameAssets(meta: AssetPairLike | null | undefined, requestKey: AssetPairLike | null | undefined): boolean {
    return meta?.assetA?.id != null
        && meta.assetB?.id != null
        && meta.assetA.id === requestKey?.assetA?.id
        && meta.assetB.id === requestKey?.assetB?.id
        && meta.assetA.precision === requestKey?.assetA?.precision
        && meta.assetB.precision === requestKey?.assetB?.precision;
}

/** Same asset legs, opposite order — a legacy pre-canonicalization shard. */
function swappedAssets(meta: AssetPairLike | null | undefined, requestKey: AssetPairLike | null | undefined): boolean {
    return meta?.assetA?.id != null
        && meta.assetB?.id != null
        && meta.assetA.id === requestKey?.assetB?.id
        && meta.assetB.id === requestKey?.assetA?.id
        && meta.assetA.precision === requestKey?.assetB?.precision
        && meta.assetB.precision === requestKey?.assetA?.precision;
}

/**
 * Opposite-orientation twin of a standard-layout cache path, or null for a
 * custom path. Migration source only: the pre-canonicalization cache wrote the
 * inverse pair to its own folder. The parent folder must be the canonical
 * pair folder (so test temp dirs and `--out` targets are skipped), and callers
 * that encode the folder in the filename (book) pass `inverseBaseName`.
 */
function inverseSiblingOutPath(outPath: string, canonicalA: OrientableAsset, canonicalB: OrientableAsset, inverseBaseName?: string): string | null {
    const resolved = path.resolve(outPath);
    const parent = path.dirname(resolved);
    if (path.basename(parent) !== pairFolderSlug(canonicalA, canonicalB)) return null;
    return path.join(path.dirname(parent), pairFolderSlug(canonicalB, canonicalA), inverseBaseName || path.basename(resolved));
}

/**
 * Invert a candle series to the opposite pair orientation.
 *
 * `volume`:
 *   - 'scale'    (LP / order-book): new base volume ≈ old base volume × close,
 *                 the same approximation the TV chart uses for its inverse view.
 *   - 'preserve' (feed): volume is a publish count, unchanged.
 *
 * Rows whose OHLC are not all finite and positive pass through untouched
 * (defensive; cache data should never hit this, and dropping rows would break
 * gap-filled continuity).
 */
function invertCandleSeries(candles: unknown, opts: { volume?: 'scale' | 'preserve' } = {}): Candle[] {
    const preserveVolume = opts.volume === 'preserve';
    const list = Array.isArray(candles) ? candles : [];
    const out: Candle[] = [];
    for (const c of list) {
        if (!Array.isArray(c) || c.length < 5) { out.push(c); continue; }
        const [ts, open, high, low, close] = c;
        if (![open, high, low, close].every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) {
            out.push(c);
            continue;
        }
        const volume = Number(c[5] ?? 0);
        const nextVolume = !Number.isFinite(volume)
            ? 0
            : preserveVolume
                ? volume
                : volume * Number(close);
        const next = [ts, 1 / close, 1 / low, 1 / high, 1 / open, nextVolume];
        for (let i = 6; i < c.length; i++) next.push(c[i]);
        out.push(next);
    }
    return out;
}

export { compareAssetIds, canonicalPair, pairFolderSlug, sameAssets, swappedAssets, inverseSiblingOutPath, invertCandleSeries };

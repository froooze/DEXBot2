'use strict';

/**
 * CHAIN OBJECT-ID SCAN
 *
 * Some object types have no list API: legacy 1.15.x balance objects and 1.13.x
 * vesting balances can only be enumerated by probing ids with `get_objects`,
 * which answers `null` for holes. Ids are allocated monotonically and never
 * reused, so a range is "dense-ish" — walking from 0 and stopping after `gap`
 * consecutive misses finds every live object without knowing where the range
 * ends.
 *
 * Two details keep that affordable on every report:
 *   - one large `get_objects` batch per round trip (1000 ids measurably beats
 *     100 by ~4x because the per-call overhead dominates), with an automatic
 *     halving fallback for nodes that refuse big batches, and
 *   - no filtering here: callers filter the objects they need (e.g. by
 *     `balance.asset_id`), because the node exposes no per-asset index for
 *     these types.
 *
 * The module is pure (the reader is injected), so it stays browser-safe.
 */

/** Ids per `get_objects` call; all public nodes accept this batch size. */
const DEFAULT_SCAN_BATCH = 1000;
/** Never fall below this when backing off, so a refusal cannot loop forever. */
const MIN_SCAN_BATCH = 100;
/**
 * Trailing miss budget for the dense implementation spaces (2.3.x, 2.4.x, 1.3.x,
 * 1.16.x): one object per asset / smart asset, ids never reused, holes measured
 * in single digits. The legacy spaces (1.13.x vesting, 1.15.x balances) have
 * real holes and keep the larger `--gap` default.
 */
const DENSE_SPACE_GAP = 2_000;

interface ChainScanOptions {
    /** Database reader; `read('get_objects', [ids])` must resolve to `(T|null)[]`. */
    read: (method: string, args: unknown[]) => Promise<unknown>;
    /** Object id prefix, e.g. `'1.15'`. */
    prefix: string;
    /** Highest id to probe (the walk always starts at 0). */
    maxId: number;
    /** Stop after this many consecutive missing ids. */
    gap: number;
    /**
     * Ids per call (default 1000). An explicit smaller value is honoured as-is;
     * a node error halves the batch down to `MIN_SCAN_BATCH`.
     */
    batchSize?: number;
    /** Called after each batch with the number of ids walked so far. */
    onProgress?: (scanned: number) => void;
}

interface ChainScanResult<T> {
    objects: T[];
    /** Number of ids walked (exclusive upper bound of the scanned range). */
    scannedTo: number;
    /** True when the walk stopped at `maxId`, so the range may be truncated. */
    hitLimit: boolean;
}

/**
 * Walk `prefix.0 … prefix.maxId` in batches and collect every live object.
 *
 * @throws when `get_objects` keeps failing even at `MIN_SCAN_BATCH`.
 */
async function scanIdRange<T>(options: ChainScanOptions): Promise<ChainScanResult<T>> {
    const { read, prefix, maxId, gap, onProgress } = options;
    let batch = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_SCAN_BATCH));
    const objects: T[] = [];
    let index = 0;
    let lastSeen = -1;

    // `gap` means exactly "gap consecutive missing ids": after the last live
    // object only ids up to lastSeen+gap are worth probing. Clipping the batch
    // to that bound makes the walk independent of the batch size — without it a
    // larger batch probes (and reports) further than the documented --gap.
    while (index <= maxId) {
        const limit = Math.min(maxId, lastSeen + gap);
        if (index > limit) break;
        const count = Math.min(batch, limit - index + 1);
        const ids = Array.from({ length: count }, (_, i) => `${prefix}.${index + i}`);
        let page: (T | null)[] | null;
        try {
            page = await read('get_objects', [ids]) as (T | null)[] | null;
        } catch (err) {
            // A node may cap the batch size; retry the same window smaller
            // instead of failing the whole report.
            if (batch > MIN_SCAN_BATCH) {
                batch = Math.max(MIN_SCAN_BATCH, Math.floor(batch / 2));
                continue;
            }
            throw err;
        }
        for (let j = 0; j < count; j++) {
            const obj = page?.[j];
            if (obj) {
                lastSeen = index + j;
                objects.push(obj);
            }
        }
        index += count;
        onProgress?.(index);
    }

    return { objects, scannedTo: index, hitLimit: index > maxId };
}

export { scanIdRange, DEFAULT_SCAN_BATCH, DENSE_SPACE_GAP, MIN_SCAN_BATCH };
export type { ChainScanOptions, ChainScanResult };

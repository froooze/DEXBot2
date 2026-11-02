#!/usr/bin/env node
'use strict';
/**
 * Shared one-step chart-command pipeline behind `dexbot tv` and `dexbot dw`.
 * Both entries (scripts/tv.ts, scripts/dw.ts) are thin wrappers around run(cmd).
 *
 * Usage:
 *   dexbot tv <bot|pool-id|AssetA/AssetB> [--month N] [--chart <path>] [--feed|--pool|--book]
 *   dexbot dw <bot|pool-id|AssetA/AssetB> [--month N] [--chart <path>] [--feed|--pool|--book]
 *
 * The pipeline owns everything up to the rendered HTML:
 *   1. parse target/flags (parseArgs),
 *   2. resolve the target → assets (bot name/key, pool id, AssetA/AssetB),
 *   3. route the candle source (auto: pool-first with orderbook fallback;
 *      --feed/--pool/--book override; MPA + prediction-market guards),
 *   4. fetch 1h candles in cached 1-month chunks (the SAME cache files every
 *      other consumer of these fetchers uses — reruns query only what is missing),
 *   5. write the candles to a temp JSON file,
 *   6. spawn the renderer registered in RENDERERS[cmd].
 *
 * Steps 1–5 are identical for both commands. The only per-command differences
 * live in the RENDERERS table: exporter binary, title kind label, usage blurb,
 * plus the cmd-derived file prefix (tv_ / dw_) and log prefix ([tv] / [dw]).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BotEntry } from '../modules/bot_settings.js';

interface AssetMeta {
    id?: string;
    precision?: number;
    symbol?: string;
    [key: string]: unknown;
}

interface ChainClientLike {
    BitShares?: { db?: Record<string, (...args: unknown[]) => Promise<unknown>> };
}

interface MpaBackingCtx {
    [key: string]: unknown;
    mpa: AssetMeta;
    backing: AssetMeta;
    isPredictionMarket: boolean;
    feedPublicationTime: string | null;
}

interface FeedCtx {
    [key: string]: unknown;
    kind: string;
    legs: MpaBackingCtx[];
}
import { PATHS } from '../modules/paths.js';
import { normalizePoolId, resolveAsset, findPoolByAssets } from '../market_adapter/utils/chain.js';
import { normalizeAssetSymbol, splitPairTarget } from '../modules/utils/asset_symbols.js';
import { fetchCandlesSequentially, outputPath } from '../market_adapter/inputs/fetch_lp_data.js';
import { fetchMarketCandlesSequentially } from '../market_adapter/inputs/fetch_book_data.js';
import { fetchFeedCandlesSequentially } from '../market_adapter/inputs/kibana_feed_source.js';
import { muteChainLogs } from '../modules/utils/chain_logs.js';
import { sanitizeKey } from '../modules/utils/sanitize_key.js';
import { slugPart, parseChainTimeToMs } from '../market_adapter/interval_utils.js';
import { monthsToHours } from '../modules/utils/time_range.js';
import { findBotByTarget, isPoolIdTarget, knownTargetsHint } from './chart_targets.js';
import { runAnalysisScript } from './analysis_runner.js';

const INTERVAL_SECONDS = 3600;
const DEFAULT_MONTHS = 3;
// Explicit --feed warns when the settlement feed is older than this
// (a stale feed draws a flat/misleading chart). Default: 7 days.
const FEED_STALE_WARN_AGE_MS = 7 * 24 * 3600 * 1000;
const CHUNK_MONTHS = 1;

/** Chart command identity: 'tv' → TradingView exporter, 'dw' → dynamic-weight research chart. */
type ChartCmd = 'tv' | 'dw';

/** The only part of the pipeline that differs between commands. */
interface ChartRenderer {
    /** Analyzer entry point, relative to analysis/ (compiled .js). */
    analyzerRel: string[];
    /** Label used in existence/exit error messages. */
    exporterName: string;
    /** Suffix in the chart title: `<bot> · <label> · 1h · <titleLabel>`. */
    titleLabel: string;
    /** Lines printed directly under the `Usage:` line. */
    usageBlurb: string[];
}

const RENDERERS: Record<ChartCmd, ChartRenderer> = {
    tv: {
        analyzerRel: ['tradingview', 'analyze_tradingview.js'],
        exporterName: 'TradingView exporter',
        titleLabel: 'TradingView',
        usageBlurb: [
            'One-step TradingView-style 1h chart; bot charts also get the AMA + order overlay.',
        ],
    },
    dw: {
        analyzerRel: ['analyze_dynamic_weight.js'],
        exporterName: 'Dynamic weight chart generator',
        titleLabel: 'Dynamic Weight',
        usageBlurb: [
            'One-step dynamic-weight research chart (AMA slope + Kalman, Hurst/PE regime gate).',
            'A bot target feeds its resolved AMA config; research knobs (--alpha, --gain, --dw,',
            '--lb, --clip) stay on analysis/analyze_dynamic_weight.js.',
        ],
    },
};

function printUsage(cmd: ChartCmd = 'tv'): void {
    console.log(`Usage: dexbot ${cmd} <bot|pool-id|AssetA/AssetB> [--month N] [--chart <path>] [--feed|--pool|--book]`);
    for (const line of RENDERERS[cmd].usageBlurb) console.log(line);
    console.log('');
    console.log('  <bot>          Bot name or key from profiles/bots.json');
    console.log('  <pool-id>      Liquidity pool id, e.g. 133 or 1.19.133 (always pool candles)');
    console.log('  AssetA/AssetB  Pair symbols, e.g. TOKENA/TOKENB (pool-first, orderbook fallback)');
    console.log('                 Case-insensitive: assetA/assetB is uppercased before it reaches the chain');
    console.log('                 MPA pairs (e.g. BTS/HONEST.USD) can chart price-feed history via --feed');
    console.log('');
    console.log('Options:');
    console.log(`  --month N        Months of 1h history (default ${DEFAULT_MONTHS})`);
    console.log('  --months N       Alias for --month');
    console.log('  --chart <path>   Override auto output path');
    console.log('  --feed           Price-feed candles (MPA pairs; BTS/MPA or MPA/MPA cross)');
    console.log('  --pool           Force LP pool candles (errors when the pair has no pool)');
    console.log('  --book           Force order-book fill candles (--orderbook is an alias)');
}
async function resolveMpaBacking(mpaSymbol: string, bitsharesClient: ChainClientLike): Promise<MpaBackingCtx | null> {
    const db = bitsharesClient.BitShares?.db;
    if (!db || typeof db.lookup_asset_symbols !== 'function') return null;
    // Canonical UPPERCASE symbol for the chain call and for every message
    // below, so a lowercase assetA/assetB pair is reported UPPERCASE.
    mpaSymbol = normalizeAssetSymbol(mpaSymbol);
    let mpa: AssetMeta | null = null;
    try {
        const found = await db.lookup_asset_symbols([mpaSymbol]) as AssetMeta[] | null;
        mpa = found?.[0] || null;
    } catch (_) {
        return null;
    }
    if (!mpa?.id || !mpa.bitasset_data_id) return null;
    try {
        const objs = await db.get_objects([mpa.bitasset_data_id]) as AssetMeta[] | AssetMeta | null;
        const bitasset = (Array.isArray(objs) ? objs[0] : objs) as { options?: { short_backing_asset?: unknown; is_prediction_market?: unknown }; current_feed_publication_time?: unknown } | null | undefined;
        const backingId = String(bitasset?.options?.short_backing_asset || '');
        if (!backingId) return null;
        const metas = typeof db.get_assets === 'function' ? await db.get_assets([backingId]) : null;
        const list = (Array.isArray(metas) ? metas.flat(Infinity) : []) as AssetMeta[];
        const backing = list.find((a) => String(a?.id) === backingId) || null;
        if (!backing?.id || !Number.isFinite(Number(backing.precision))) return null;
        return {
            mpa: { id: String(mpa.id), precision: Number(mpa.precision), symbol: mpaSymbol },
            backing: { id: String(backing.id), precision: Number(backing.precision), symbol: String(backing.symbol || backingId) },
            isPredictionMarket: bitasset?.options?.is_prediction_market === true,
            feedPublicationTime: typeof bitasset?.current_feed_publication_time === 'string' ? bitasset.current_feed_publication_time : null,
        };
    } catch (_) {
        return null;
    }
}

async function pickFeedContext(symA: string, symB: string, source: string, bitsharesClient: ChainClientLike): Promise<FeedCtx | null> {
    // Feed candles are strictly opt-in (--feed). All other modes chart
    // tradeable market candles (pool-first, orderbook fallback) without
    // touching the chain for MPA detection.
    if (source !== 'feed') return null;
    const ctxA = await resolveMpaBacking(symA, bitsharesClient);
    const ctxB = await resolveMpaBacking(symB, bitsharesClient);
    const legs = [ctxA, ctxB].filter(Boolean) as MpaBackingCtx[];
    if (legs.length === 0) throw new Error(`--feed requires an MPA pair, got ${symA}/${symB}`);
    // Prediction markets are bitassets too, but their "feed" is a binary
    // settlement outcome, not a price series — never chart it as one.
    for (const leg of legs) {
        if (leg.isPredictionMarket) throw new Error(`--feed cannot chart ${leg.mpa.symbol}: prediction-market feeds are settlement outcomes, not prices`);
    }
    if (legs.length === 2) {
        if (String(legs[0].backing.id) !== String(legs[1].backing.id)) {
            throw new Error(`--feed cannot cross ${legs[0].mpa.symbol}/${legs[1].mpa.symbol}: different backing assets (${legs[0].backing.symbol} vs ${legs[1].backing.symbol})`);
        }
        return { kind: 'cross', legs };
    }
    return { kind: 'single', legs };
}

function feedAgeMs(ctx: { feedPublicationTime: string | null }, nowMs: number = Date.now()): number | null {
    if (!ctx?.feedPublicationTime) return null;
    const ts = parseChainTimeToMs(ctx.feedPublicationTime);
    if (!Number.isFinite(ts)) return null;
    return nowMs - ts;
}

function feedName(feedCtx: FeedCtx): string {
    if (feedCtx.kind === 'cross') return `${feedCtx.legs[0].mpa.symbol}/${feedCtx.legs[1].mpa.symbol}`;
    return String(feedCtx.legs[0].mpa.symbol ?? '');
}

async function activateFeedIfCovered(symA: string, symB: string, assetA: AssetMeta, assetB: AssetMeta, source: string, bitsharesClient: ChainClientLike, label = 'tv'): Promise<FeedCtx | null> {
    const ctx = await pickFeedContext(symA, symB, source, bitsharesClient);
    if (!ctx) return null;
    const ids = [String(assetA?.id || ''), String(assetB?.id || '')];
    if (ctx.kind === 'cross') {
        const covered = ids.includes(String(ctx.legs[0].mpa.id)) && ids.includes(String(ctx.legs[1].mpa.id));
        if (!covered) {
            throw new Error(`--feed cannot price ${assetA?.symbol || ''}/${assetB?.symbol || ''}: the cross feed covers ${feedName(ctx)} only`);
        }
    } else if (!ids.includes(String(ctx.legs[0].mpa.id)) || !ids.includes(String(ctx.legs[0].backing.id))) {
        throw new Error(`--feed cannot price ${assetA?.symbol || ''}/${assetB?.symbol || ''}: the ${ctx.legs[0].mpa.symbol} feed covers ${ctx.legs[0].backing.symbol}/${ctx.legs[0].mpa.symbol} only`);
    }
    // A stale settlement price draws a flat/misleading chart. Explicit
    // --feed still charts it on request, but says so out loud.
    // For a cross, the stalest leg gates the warning.
    const ages = ctx.legs.map((leg) => feedAgeMs(leg));
    const known: number[] = ages.filter((a): a is number => a != null);
    const worst = known.length === ages.length && known.length > 0 ? Math.max(...known) : null;
    if (worst == null || worst > FEED_STALE_WARN_AGE_MS) {
        const ageLabel = worst == null ? 'unknown age' : `${Math.round(worst / 86400000)}d old`;
        console.warn(`[${label}] Warning: ${feedName(ctx)} feed is stale (${ageLabel}); charting it anyway by explicit request`);
    }
    return ctx;
}

function parseArgs(argv: string[], cmd: ChartCmd = 'tv'): { target: string | null; months: number; chart: string | null; source: string; help: boolean } {
    let target: string | null = null;
    let months = DEFAULT_MONTHS;
    let chart: string | null = null;
    let source = 'auto';
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') help = true;
        else if (arg === '--month' || arg === '--months') {
            const raw = argv[++i];
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--month: invalid value "${raw}" (expected positive months, e.g. --month 6)`);
            months = n;
        } else if (arg.startsWith('--month=') || arg.startsWith('--months=')) {
            // `--month` is the canonical spelling; `--months` is a pure alias
            // (same value, same error label).
            const n = Number(arg.split('=')[1]);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--month: invalid value "${arg}" (expected positive months, e.g. --month 6)`);
            months = n;
        } else if (arg === '--chart') {
            chart = String(argv[++i] || '');
            if (!chart) throw new Error('--chart: missing path');
        } else if (arg.startsWith('--chart=')) {
            chart = arg.split('=').slice(1).join('=');
            if (!chart) throw new Error('--chart: missing path');
        } else if (arg === '--feed' || arg === '--pool' || arg === '--book' || arg === '--orderbook') {
            const picked = arg === '--feed' ? 'feed' : arg === '--pool' ? 'pool' : 'book';
            if (source !== 'auto' && source !== picked) throw new Error(`Conflicting source flags: --${source} with ${arg} (use only one of --feed, --pool, --book)`);
            source = picked;
        } else if (arg.startsWith('--')) {
            throw new Error(`Unknown flag "${arg}". Usage: dexbot ${cmd} <bot|pool-id|AssetA/AssetB> [--month N]`);
        } else if (!target) {
            target = arg;
        } else {
            throw new Error(`Unexpected argument "${arg}". Only one target is supported. Usage: dexbot ${cmd} <bot|pool-id|AssetA/AssetB> [--month N]`);
        }
    }
    return { target, months, chart, source, help };
}

function monthsLabel(months: number): string {
    return Number.isInteger(months) ? `${months}m` : `${String(months).replace('.', 'p')}m`;
}

async function resolvePoolAssets(poolId: string, bitsharesClient: ChainClientLike): Promise<{ assetA: AssetMeta; assetB: AssetMeta }> {
    const fullId = normalizePoolId(poolId) as string;
    // Chain pool object via get_objects([poolId]) → asset_a / asset_b.
    const db = bitsharesClient.BitShares?.db;
    if (db && typeof db.get_objects === 'function') {
        try {
            const objs = await db.get_objects([fullId]) as AssetMeta[] | null;
            const pool = (Array.isArray(objs) ? objs[0] : null) as { asset_a?: unknown; asset_b?: unknown; asset_ids?: unknown[] } | null;
            const idA = pool?.asset_a || pool?.asset_ids?.[0];
            const idB = pool?.asset_b || pool?.asset_ids?.[1];
            if (idA && idB) {
                const assets = typeof db.get_assets === 'function' ? await db.get_assets([String(idA), String(idB)]) : null;
                // Tolerate both [..] and [[..]] result shapes.
                const list = (Array.isArray(assets) ? assets.flat(Infinity) : []) as AssetMeta[];
                const metaA = list.find((a) => String(a?.id) === String(idA));
                const metaB = list.find((a) => String(a?.id) === String(idB));
                if (metaA && metaB) {
                    return {
                        assetA: { id: String(metaA.id), precision: Number(metaA.precision), symbol: String(metaA.symbol || idA) },
                        assetB: { id: String(metaB.id), precision: Number(metaB.precision), symbol: String(metaB.symbol || idB) },
                    };
                }
            }
        } catch (_) {
            // Fall through to Kibana discovery below.
        }
    }
    // Fallback: Kibana discovery (what went into the pool) + chain precision lookup.
    const { discoverPoolAssets } = await import('../market_adapter/inputs/kibana_source.js');
    const ids = await discoverPoolAssets(fullId, {});
    if (!Array.isArray(ids) || ids.length !== 2) {
        throw new Error(`Pool ${fullId}: expected exactly 2 assets, discovered [${(ids || []).join(', ')}]. Pass AssetA/AssetB instead.`);
    }
    const [idA, idB] = ids.map(String);
    if (!db || typeof db.get_assets !== 'function') throw new Error(`Pool ${fullId}: chain asset lookup unavailable`);
    const assets = await db.get_assets([idA, idB]) as AssetMeta[] | null;
    const metaA = (assets || []).find((a) => String(a?.id) === idA);
    const metaB = (assets || []).find((a) => String(a?.id) === idB);
    if (!metaA || !metaB || !Number.isFinite(Number(metaA.precision)) || !Number.isFinite(Number(metaB.precision))) {
        throw new Error(`Pool ${fullId}: failed to resolve asset metadata for ${idA}/${idB}`);
    }
    return {
        assetA: { id: idA, precision: Number(metaA.precision), symbol: String(metaA.symbol || idA) },
        assetB: { id: idB, precision: Number(metaB.precision), symbol: String(metaB.symbol || idB) },
    };
}

async function run(cmd: ChartCmd): Promise<void> {
    // Mute chain connection chatter first — shared helper, console.error untouched.
    muteChainLogs();
    const { target, months, chart, source, help } = parseArgs(process.argv.slice(2), cmd);
    if (help || !target) {
        printUsage(cmd);
        if (!target && !help) process.exit(1);
        process.exit(0);
    }

    const lookbackHours = monthsToHours(months);
    const bucketMs = INTERVAL_SECONDS * 1000;
    const endMs = Math.floor(Date.now() / bucketMs) * bucketMs;
    const startMs = endMs - lookbackHours * 3600 * 1000;
    const timeRange = { gte: new Date(startMs).toISOString(), lte: new Date(endMs).toISOString() };

    // Classify the target locally first so a typo'd bot / malformed pair
    // fails fast without waiting for a chain connection.
    const botHit = findBotByTarget(target as string);
    const poolTarget = !botHit && isPoolIdTarget(target as string);
    const pairTarget = !botHit && !poolTarget && (target as string).includes('/');
    // A pair target may be typed in any case ("assetb/asseta"); the legs are
    // canonicalized here so the chain call, the cache keys, the chart title and
    // the exported HTML all speak the same UPPERCASE symbols.
    const pairParts = pairTarget ? splitPairTarget(target) : [];
    if (!botHit && !poolTarget && !pairTarget) {
        throw new Error(`Unknown target "${target}". ${knownTargetsHint(true)}`);
    }
    if (pairTarget && pairParts.length !== 2) throw new Error(`Invalid pair "${target}". Use AssetA/AssetB, e.g. TOKENA/TOKENB (case is normalized to uppercase)`);

    const bitsharesClient = await import('../modules/bitshares_client.js');
    const { waitForConnected } = bitsharesClient;
    await waitForConnected();

    let tmpFile: string | null = null;
    try {
        let assetA: AssetMeta = {};
        let assetB: AssetMeta = {};
        let poolId: string | null = null;
        let feedCtx: FeedCtx | null = null;
        let sourceLabel = '';
        let botKey: string | null = null;
        let botMeta: BotEntry | null = null;
        if (botHit) {
            botKey = botHit.botKey;
            botMeta = botHit.meta;
            const symA = normalizeAssetSymbol(botMeta.assetA);
            const symB = normalizeAssetSymbol(botMeta.assetB);
            if (!symA || !symB) throw new Error(`Bot '${target}' has no assetA/assetB pair in profiles/bots.json`);
            const [metaA, metaB] = await Promise.all([resolveAsset(symA, bitsharesClient), resolveAsset(symB, bitsharesClient)]);
            assetA = { id: metaA.id, precision: metaA.precision, symbol: symA };
            assetB = { id: metaB.id, precision: metaB.precision, symbol: symB };
            feedCtx = await activateFeedIfCovered(symA, symB, assetA, assetB, source, bitsharesClient, cmd);
            if (feedCtx) {
                sourceLabel = `feed ${feedName(feedCtx)}`;
            } else if (source === 'book') {
                sourceLabel = 'orderbook';
            } else {
                try {
                    poolId = (await findPoolByAssets(String(assetA.id), String(assetB.id), { bitsharesClient, sortBy: 'assetABalance' })).id ?? null;
                } catch (_) {
                    poolId = null;
                }
                sourceLabel = poolId ? `pool ${poolId}` : 'orderbook';
            }
        } else if (poolTarget) {
            poolId = normalizePoolId((target as string).trim()) as string;
            const resolved = await resolvePoolAssets(poolId, bitsharesClient);
            assetA = resolved.assetA;
            assetB = resolved.assetB;
            sourceLabel = `pool ${poolId}`;
        } else {
            const [metaA, metaB] = await Promise.all([resolveAsset(pairParts[0], bitsharesClient), resolveAsset(pairParts[1], bitsharesClient)]);
            assetA = { id: metaA.id, precision: metaA.precision, symbol: pairParts[0] };
            assetB = { id: metaB.id, precision: metaB.precision, symbol: pairParts[1] };
            feedCtx = await activateFeedIfCovered(pairParts[0], pairParts[1], assetA, assetB, source, bitsharesClient, cmd);
            if (feedCtx) {
                sourceLabel = `feed ${feedName(feedCtx)}`;
            } else if (source === 'book') {
                sourceLabel = 'orderbook';
            } else {
                try {
                    poolId = (await findPoolByAssets(String(assetA.id), String(assetB.id), { bitsharesClient, sortBy: 'assetABalance' })).id ?? null;
                } catch (_) {
                    poolId = null;
                }
                sourceLabel = poolId ? `pool ${poolId}` : 'orderbook';
            }
        }

        // ── Data pull (the only shared job of this pipeline) ─────────────────
        // All three sources share ONE chunk-cache function (runCachedWindows)
        // in 1-month windows; the LP path additionally sets a per-chunk
        // timeout/retry budget. Reruns query only what is missing.
        // No fetch logic is duplicated anywhere (tv/dw or vs. other tools).
        console.log(`[${cmd}] Fetching 1h candles (${months}mo, ${timeRange.gte.slice(0, 10)} → ${timeRange.lte.slice(0, 10)}) from ${sourceLabel} for ${assetA.symbol}/${assetB.symbol}...`);
        let candles: number[][];
        if (feedCtx) {
            // Feed publishes go through the same chunk-cache machinery as LP
            // candles: reruns reuse local buckets and query only what is
            // missing (plus a tail refresh for late-indexed publishes).
            candles = await fetchFeedCandlesSequentially(feedCtx, assetA, assetB, {
                intervalSeconds: INTERVAL_SECONDS,
                timeRange,
                chunkMonths: CHUNK_MONTHS,
            });
        } else if (poolId) {
            candles = await fetchCandlesSequentially(poolId, assetA, assetB, {
                intervalSeconds: INTERVAL_SECONDS,
                timeRange,
                chunkMonths: CHUNK_MONTHS,
            }, outputPath(poolId, INTERVAL_SECONDS, assetA, assetB));
        } else {
            // Order-book fills go through the same chunk-cache machinery as LP
            // candles and feed publishes: reruns reuse local buckets and query
            // only what is missing (plus a tail refresh for late-indexed fills).
            candles = await fetchMarketCandlesSequentially(assetA, assetB, {
                intervalSeconds: INTERVAL_SECONDS,
                timeRange,
                chunkMonths: CHUNK_MONTHS,
            });
        }
        if (!Array.isArray(candles) || candles.length === 0) throw new Error('No candles returned for the requested range');

        tmpFile = path.join(os.tmpdir(), `dexbot-${cmd}-${sanitizeKey(botKey || assetA.symbol + '-' + assetB.symbol)}-${process.pid}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({
            meta: {
                fetchedAt: new Date().toISOString(),
                feed: feedCtx ? feedName(feedCtx) : null,
                pool: poolId,
                assetA: { id: assetA.id, precision: assetA.precision, symbol: assetA.symbol },
                assetB: { id: assetB.id, precision: assetB.precision, symbol: assetB.symbol },
                intervalSeconds: INTERVAL_SECONDS,
                lookbackHours,
                format: feedCtx
                    ? '[timestamp_ms, open, high, low, close, feed_publish_count]'
                    : '[timestamp_ms, open, high, low, close, volume_A]',
            },
            candles,
        }), 'utf8');

        // ── Delegate rendering to the registered exporter ────────────────────
        // Everything above this point is identical for every command; only the
        // RENDERERS entry below differs.
        const renderer = RENDERERS[cmd];
        const feedSuffix = feedCtx ? '_feed' : '';
        const baseName = botKey
            ? `${cmd}_${sanitizeKey(botKey)}${feedSuffix}`
            : poolId
                ? `${cmd}_pool_${String(poolId).replace(/^1\.19\./, '')}`
                : `${cmd}_${slugPart(assetA.symbol)}_${slugPart(assetB.symbol)}${feedSuffix}`;
        const chartFile = chart
            ? path.resolve(chart)
            : path.join(PATHS.ANALYSIS.CHARTS_DIR, `${baseName}_1h_${monthsLabel(months)}.html`);
        const label = feedCtx
            ? `Feed ${feedName(feedCtx)} (${assetA.symbol}/${assetB.symbol})`
            : poolId ? `Pool ${String(poolId).replace(/^1\.19\./, '')}` : `${assetA.symbol}/${assetB.symbol}`;
        const title = botKey && botMeta?.name ? `${botMeta.name} · ${label} · 1h · ${renderer.titleLabel}` : `${label} · 1h · ${renderer.titleLabel}`;
        const analyzerArgs = ['--file', tmpFile, '--chart', chartFile, '--title', title];
        // Both renderers resolve bot-scoped config themselves from the SAME
        // --bot-key (AMA config via resolveAmaConfig; tv additionally grid
        // bounds + order overlay). Explicit --ama-*-period forwarding was
        // dropped on purpose: it duplicated that resolution.
        if (botKey) analyzerArgs.push('--bot-key', botKey);
        runAnalysisScript(renderer.analyzerRel, analyzerArgs, renderer.exporterName);
        try { fs.unlinkSync(tmpFile); } catch (_) { /* keep on failure path only */ }
        tmpFile = null;
    } finally {
        try {
            const { disconnectClient: dc } = await import('../modules/bitshares_client.js');
            dc();
        } catch (_) { /* best-effort */ }
        // The BitShares WS + node monitor keep the event loop alive; exit explicitly.
        setTimeout(() => process.exit(0), 50).unref();
    }
}

export { parseArgs, isPoolIdTarget, resolveMpaBacking, pickFeedContext, activateFeedIfCovered, feedAgeMs, feedName, run, FEED_STALE_WARN_AGE_MS }
export type { ChartCmd, ChartRenderer }

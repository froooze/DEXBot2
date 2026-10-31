'use strict';

import { path } from '../modules/path_api.js';
import { getStorage } from '../modules/storage/index.js';
import { isExactPair, isSamePair } from './utils/chain.js';
import { normalizeAssetSymbol } from '../modules/utils/asset_symbols.js';
import { toIntervalLabel } from './interval_utils.js';
import { PATHS } from '../modules/paths.js';

const storage = getStorage();
const { readJSON } = storage;


const ANALYSIS_AMA_FITTING_DIR = path.join(PATHS.PROJECT_ROOT, 'analysis', 'ama_fitting');
const MARKET_ADAPTER_DIR = path.join(PATHS.PROJECT_ROOT, 'market_adapter');

interface AmaLike {
    label?: unknown;
    name?: unknown;
    erPeriod?: unknown;
    er?: unknown;
    fastPeriod?: unknown;
    fast?: unknown;
    slowPeriod?: unknown;
    slow?: unknown;
    [key: string]: unknown;
}

type AmaStrategy = {
    name: string;
    erPeriod: unknown;
    fastPeriod: unknown;
    slowPeriod: unknown;
    color: string;
    dash: string;
    lineWidth: number;
};

interface LpMeta {
    intervalSeconds?: unknown;
    assetA?: { symbol?: unknown; id?: unknown };
    assetB?: { symbol?: unknown; id?: unknown };
    amas?: Record<string, AmaLike>;
    areaCapPct?: unknown;
    prodCapPct?: unknown;
    [key: string]: unknown;
}

interface ProfileEntry {
    assetA?: unknown;
    assetB?: unknown;
    assetAId?: unknown;
    assetBId?: unknown;
    intervalSeconds?: unknown;
    intervalLabel?: unknown;
    updatedAt?: unknown;
    amas?: Record<string, AmaLike>;
}

function inferIntervalLabel(meta: { intervalSeconds?: unknown } | null | undefined): string | null {
    const sec = Number(meta?.intervalSeconds);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return toIntervalLabel(sec);
}

function buildAmaStrategy(name: string, ama: AmaLike | null | undefined, color: string, dash: string, lineWidth: number = 1.5): AmaStrategy | null {
    if (!ama) return null;
    return {
        name,
        erPeriod: ama.erPeriod ?? ama.er,
        fastPeriod: ama.fastPeriod ?? ama.fast,
        slowPeriod: ama.slowPeriod ?? ama.slow,
        color,
        dash,
        lineWidth,
    };
}

function loadStrategiesFromResults(resultsPath: string): AmaStrategy[] | null {
    if (!resultsPath || !storage.exists(resultsPath)) return null;

    const json = readJSON(resultsPath);
    const meta = json?.meta as LpMeta | undefined;
    if (!meta) return null;

    if (meta.amas && meta.amas.AMA1 && meta.amas.AMA2 && meta.amas.AMA3 && meta.amas.AMA4) {
        const order: Array<[string, string, string]> = [
            ['AMA1', '#fb8c00', 'solid'],
            ['AMA2', '#42a5f5', 'dash'],
            ['AMA3', '#66bb6a', 'longdash'],
            ['AMA4', '#ef5350', 'longdashdot'],
        ];
        const out: AmaStrategy[] = [];
        for (const [k, color, dash] of order) {
            const r = meta.amas[k];
            if (!r) continue;
            const cleaned = String(r.label || '')
                .replace(/^AMA\d\s*/i, '')
                .replace(/^[-:\s]+/, '')
                .replace(/min move,\s*/i, '')
                .trim();
            const name = cleaned ? `${k} - ${cleaned}` : k;
            const strat = buildAmaStrategy(name, r, color, dash, 1.5);
            if (strat) out.push(strat);
        }
        return out.length ? out : null;
    }

    const metaCfg: LpMeta = meta;
    const strategies: AmaStrategy[] = [];
    function add(key: string, label: string, color: string, dash: string) {
        const r = metaCfg[key] as AmaLike | undefined;
        const strat = buildAmaStrategy(label, r, color, dash, 1.5);
        if (strat) strategies.push(strat);
    }

    const areaCap = Number.isFinite(metaCfg.areaCapPct) ? Number(metaCfg.areaCapPct) : null;
    const prodCap = Number.isFinite(metaCfg.prodCapPct) ? Number(metaCfg.prodCapPct) : null;
    add('bestProdMaxDist', 'MAX PROD/MAXDIST', '#42a5f5', 'dash');
    add('bestAreaMaxDist', 'MAX AREA/MAXDIST', '#fb8c00', 'solid');
    add('bestAreaMaxDistCapped', areaCap === null ? 'MAX AREA/MAXDIST (cap)' : `MAX AREA/MAXDIST (<=${areaCap.toFixed(1)}%)`, '#66bb6a', 'longdash');
    add('bestProdMaxDistCapped', prodCap === null ? 'MAX PROD/MAXDIST (cap)' : `MAX PROD/MAXDIST (<=${prodCap.toFixed(1)}%)`, '#ef5350', 'longdashdot');

    return strategies.length ? strategies : null;
}

function loadStrategiesFromProfiles(profilesPath: string | null | undefined, meta: LpMeta | null | undefined): AmaStrategy[] | null {
    if (!profilesPath || !storage.exists(profilesPath)) return null;
    if (!meta) return null;

    const json = readJSON(profilesPath);
    const profiles: ProfileEntry[] = Array.isArray(json?.profiles) ? json.profiles : [];
    if (profiles.length === 0) return null;

    const assetASymbol = normalizeAssetSymbol(meta?.assetA?.symbol);
    const assetBSymbol = normalizeAssetSymbol(meta?.assetB?.symbol);
    const assetAId = normalizeAssetSymbol(meta?.assetA?.id);
    const assetBId = normalizeAssetSymbol(meta?.assetB?.id);
    const intervalSeconds = Number(meta?.intervalSeconds);
    const intervalLabel = inferIntervalLabel(meta);

    const matches = profiles.map((p) => {
        const pA = normalizeAssetSymbol(p?.assetA);
        const pB = normalizeAssetSymbol(p?.assetB);
        const pAId = normalizeAssetSymbol(p?.assetAId);
        const pBId = normalizeAssetSymbol(p?.assetBId);

        const exactBySymbol = assetASymbol && assetBSymbol && isExactPair(assetASymbol, assetBSymbol, pA, pB);
        const exactById = assetAId && assetBId && isExactPair(assetAId, assetBId, pAId, pBId);
        const symmetricBySymbol = assetASymbol && assetBSymbol && isSamePair(assetASymbol, assetBSymbol, pA, pB);
        const symmetricById = assetAId && assetBId && isSamePair(assetAId, assetBId, pAId, pBId);
        const matchRank = (exactBySymbol || exactById) ? 2 : ((symmetricBySymbol || symmetricById) ? 1 : 0);
        return { profile: p, matchRank };
    }).filter((entry) => entry.matchRank > 0);
    if (matches.length === 0) return null;

    const exactMatches = matches.filter((entry) => entry.matchRank === 2);
    const matchedProfiles = (exactMatches.length > 0 ? exactMatches : matches)
        .map((entry) => entry.profile);

    const sameInterval = matchedProfiles.filter((p) => {
        if (Number.isFinite(intervalSeconds) && intervalSeconds > 0 && Number(p?.intervalSeconds) === intervalSeconds) {
            return true;
        }
        if (intervalLabel && String(p?.intervalLabel || '').toLowerCase() === intervalLabel.toLowerCase()) {
            return true;
        }
        return false;
    });
    const candidates = sameInterval.length > 0 ? sameInterval : matchedProfiles;
    const profile = [...candidates].sort((a, b) => {
        const aTs = Date.parse(String(a?.updatedAt || 0)) || 0;
        const bTs = Date.parse(String(b?.updatedAt || 0)) || 0;
        return bTs - aTs;
    })[0];

    const ama1 = profile?.amas?.AMA1;
    const ama2 = profile?.amas?.AMA2;
    const ama3 = profile?.amas?.AMA3;
    const ama4 = profile?.amas?.AMA4;
    if (!ama1 || !ama2 || !ama3 || !ama4) return null;

    return [
        buildAmaStrategy(String(ama1.name || 'AMA1'), ama1, '#fb8c00', 'solid'),
        buildAmaStrategy(String(ama2.name || 'AMA2'), ama2, '#42a5f5', 'dash', 2),
        buildAmaStrategy(String(ama3.name || 'AMA3'), ama3, '#66bb6a', 'longdash'),
        buildAmaStrategy(String(ama4.name || 'AMA4'), ama4, '#ef5350', 'longdashdot'),
    ].filter((x): x is AmaStrategy => x != null);
}

function candidateResultsPaths(dataFile: string, extraSearchDirs: string[] = []): string[] {
    const base = path.basename(dataFile, '.json');
    const dirs = [
        path.dirname(dataFile),
        path.dirname(path.dirname(dataFile)),
        ANALYSIS_AMA_FITTING_DIR,
        MARKET_ADAPTER_DIR,
        ...extraSearchDirs,
    ].filter(Boolean);
    const seen = new Set();
    const out: string[] = [];

    for (const dir of dirs) {
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(path.join(resolved, `optimization_results_${base}.json`));
    }

    return out;
}

function loadStrategiesForLpChart({ dataFile, meta, profilesFile, extraSearchDirs = [] }: { dataFile: string; meta: LpMeta | null | undefined; profilesFile?: string | null; extraSearchDirs?: string[] }): AmaStrategy[] | null {
    for (const resultsPath of candidateResultsPaths(dataFile, extraSearchDirs)) {
        const fromResults = loadStrategiesFromResults(resultsPath);
        if (fromResults) return fromResults;
    }

    return loadStrategiesFromProfiles(profilesFile, meta);
}

export { loadStrategiesForLpChart }

/** Internal seams exercised directly by tests. */
export const __test = { loadStrategiesFromProfiles };


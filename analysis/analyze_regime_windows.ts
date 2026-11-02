#!/usr/bin/env node
'use strict';

/**
 * REGIME WINDOW OPTIMIZER
 *
 * Grid-searches optimal Hurst and Permutation Entropy window sizes to maximize
 * regime quality — a composite score of stability, directional accuracy, and
 * information content.
 *
 * Scoring:
 *   - regimeStability: mean duration (bars) before regime switches
 *   - entropyDefect: penalty for being stuck in the "random" band (H 0.45–0.55)
 *
 * Usage:
 *   node dist/analysis/analyze_regime_windows.js \
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

import { getErrorMessage } from '../modules/utils/errors.js';
import path from 'node:path';
import { HurstAnalyzer, classifyHurst }  from './trend_detection/hurst_analyzer.js';
import { PermutationEntropyAnalyzer } from './trend_detection/permutation_entropy_analyzer.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { PATHS } from '../modules/paths.js';
import { writeChartFile, toFileUrl } from './chart_utils.js';
import { CLI_TAGS, savedLine } from '../modules/cli_progress.js';
import { getCandleClose }            from './math_utils.js';
import { roundTo } from '../modules/order/utils/math.js';
import { resolveSource, listAvailableBots, type SourceConfig } from './resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from './analyze_args.js';

const HURST_CONFIG = MARKET_ADAPTER.HURST_CONFIG;
const PE_CONFIG = MARKET_ADAPTER.PE_CONFIG;


const HURST_CENTER   = HURST_CONFIG.window;
const PE_CENTER      = PE_CONFIG.window;
const RANGE_FACTOR   = 2;
const N_POINTS       = 20;

function geoRange(center: number, factor: number, n: number) {
    const lo = center / factor;
    const hi = center * factor;
    const r  = Math.pow(hi / lo, 1 / (n - 1));
    const vals: number[] = [];
    for (let i = 0; i < n; i++) vals.push(lo * Math.pow(r, i));
    return vals;
}

const HURST_WINDOWS  = geoRange(HURST_CENTER, RANGE_FACTOR, N_POINTS);
const PE_WINDOWS     = geoRange(PE_CENTER, RANGE_FACTOR, N_POINTS);
const HURST_SCALES   = HURST_CONFIG.scales;
const PE_M           = PE_CONFIG.m;
const PE_DELAY       = PE_CONFIG.delay;

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source:    { type: string; config: SourceConfig };
        chartFile: string;
        quiet:     boolean;
        listBots:  boolean;
    } = {
        ...baseAnalysisConfig(),
        chartFile: path.join(PATHS.ANALYSIS.CHARTS_DIR, 'regime_windows_heatmap.html'),
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if      (arg === '--chart')       config.chartFile               = args[++i];
    }

    return config;
}

// Signal-quality bands from MARKET_ADAPTER.PE_NODES (structured / mixed / noise).
const PE_STRUCTURED = MARKET_ADAPTER.PE_NODES[0];
const PE_NOISE = MARKET_ADAPTER.PE_NODES[MARKET_ADAPTER.PE_NODES.length - 1];

// Hurst band classification delegates to the production classifyHurst
// (market_adapter/core/signals/hurst_analyzer.ts) so boundary semantics
// (inclusive >=/<=) and zone width stay on one logic path.
function regimeBand(H: number | null): string {
    if (H === null) return 'RANDOM';
    return classifyHurst(H).regime;
}

function rankNormalize(arr: number[]) {
    const sorted = arr.slice().sort((a: number, b: number) => a - b);
    return arr.map((v: number) => {
        const idx = sorted.findIndex((x: number) => x === v);
        return idx / (sorted.length - 1);
    });
}

function scoreWindowPair(prices: number[], hurstWindow: number, peWindow: number) {
    const n = prices.length;

    const hurstAnalyzer = new HurstAnalyzer({ window: hurstWindow, scales: HURST_SCALES });
    const peAnalyzer    = new PermutationEntropyAnalyzer({ m: PE_M, delay: PE_DELAY, window: peWindow });

    const hArr: (number | null)[] = [];
    const pArr: (number | null)[] = [];

    for (let i = 0; i < n; i++) {
        const h = hurstAnalyzer.update(prices[i]);
        const p = peAnalyzer.update(prices[i]);
        hArr.push(h.isReady ? h.hurst : null);
        pArr.push(p.isReady ? p.normalizedEntropy : null);
    }

    const firstReady = hArr.findIndex(v => v !== null);
    if (firstReady < 0) return null;

    // ── Regime sequences ──────────────────────────────────────────────────
    // Pair H and PE strictly per bar: both analyzers become ready on different
    // schedules (PE window vs Hurst window), so slicing from Hurst readiness
    // and independently null-filtering PE would index-shift the pairing.
    const hBands: string[] = [];
    const pBands: string[] = [];
    for (let i = 0; i < n; i++) {
        if (hArr[i] === null || pArr[i] === null) continue;
        hBands.push(regimeBand(hArr[i]));
        pBands.push(pArr[i]! < PE_STRUCTURED ? 'STRUCTURED' : pArr[i]! > PE_NOISE ? 'NOISE' : 'MIXED');
    }
    const m = hBands.length;
    if (m < 50) return null;

    const combined = hBands.map((h, i) => `${h}|${pBands[i]}`);

    // ── Stability: mean run-length of combined regime ───────────────────
    let stabilitySum = 0, stabilityCount = 0;
    let runLen = 1;
    for (let i = 1; i < combined.length; i++) {
        if (combined[i] === combined[i - 1]) {
            runLen++;
        } else {
            stabilitySum += runLen;
            stabilityCount++;
            runLen = 1;
        }
    }
    stabilitySum += runLen;
    stabilityCount++;
    const meanStability = stabilitySum / stabilityCount;



    // ── Entropy defect: how often stuck in random band ───────────────────
    const randomCount = hBands.filter(b => b === 'RANDOM').length;
    const entropyDefect = randomCount / m;

    // ── Structured fraction: how often PE is structured ───────────────────
    const structuredCount = pBands.filter(b => b === 'STRUCTURED').length;
    const structuredFrac = structuredCount / m;

    // ── Lag score: inverse window size — smaller windows respond faster ─────
    const minH = HURST_WINDOWS[0];
    const minP = PE_WINDOWS[0];
    const lagScore = 0.5 * (minH / hurstWindow) + 0.5 * (minP / peWindow);

    return {
        hurstWindow,
        peWindow,
        meanStability,
        entropyDefect,
        structuredFrac,
        lagScore,
        _stabilityRaw:   meanStability,
        _entropyRaw:     1 - entropyDefect,
        _structuredRaw:  structuredFrac,
        _lagRaw:         lagScore,
        n: m,
    };
}

interface RegimeRaw {
    hurstWindow: number;
    peWindow: number;
    meanStability: number;
    entropyDefect: number;
    structuredFrac: number;
    lagScore: number;
    _stabilityRaw: number;
    _entropyRaw: number;
    _structuredRaw: number;
    _lagRaw: number;
    n: number;
}

interface RegimeResult extends RegimeRaw {
    composite: number;
    stabilityScore: number;
    entropyScore: number;
    structuredScore: number;
    lagScore: number;
}

function computeComposite(allResults: RegimeRaw[]): RegimeResult[] {
    const n = allResults.length;
    if (n === 0) return [];

    const stabilityVals   = allResults.map((r) => r._stabilityRaw);
    const entropyVals     = allResults.map((r) => r._entropyRaw);
    const structuredVals  = allResults.map((r) => r._structuredRaw);
    const lagVals         = allResults.map((r) => r._lagRaw);

    const [rnStability, rnEntropy, rnStructured, rnLag] =
        [stabilityVals, entropyVals, structuredVals, lagVals].map(rankNormalize);

    // Weights: lag=30%, stability=30%, entropy=25%, structured=15%
    const W = { lag: 0.30, stability: 0.30, entropy: 0.25, structured: 0.15 };

    return allResults.map((r, i) => {
        const composite =
            W.lag        * rnLag[i] +
            W.stability  * rnStability[i] +
            W.entropy    * rnEntropy[i] +
            W.structured * rnStructured[i];

        return {
            ...r,
            stabilityScore:    roundTo(rnStability[i], 1000),
            entropyScore:       roundTo(rnEntropy[i], 1000),
            structuredScore:    roundTo(rnStructured[i], 1000),
            lagScore:           roundTo(rnLag[i], 1000),
            composite:          roundTo(composite, 1000),
        };
    });
}

function generateHeatmapHTML(results: RegimeResult[], hurstVals: number[], peVals: number[]): string {
    const maxComposite = Math.max(...results.map((r) => r.composite));
    const minComposite = Math.min(...results.map((r) => r.composite));
    const range = maxComposite - minComposite || 1;

    const grid: Record<string, RegimeResult> = {};
    results.forEach((r) => { grid[`${r.hurstWindow},${r.peWindow}`] = r; });

    const defaultH = HURST_CENTER;
    const defaultP = PE_CENTER;
    const geoRatio = Math.pow(RANGE_FACTOR, 1 / (N_POINTS - 1));
    const epsH = Math.abs(HURST_WINDOWS[HURST_WINDOWS.length - 1] - HURST_WINDOWS[0]) / (N_POINTS - 1) * 0.6;
    const epsP = Math.abs(PE_WINDOWS[PE_WINDOWS.length - 1] - PE_WINDOWS[0]) / (N_POINTS - 1) * 0.6;

    const best = results.reduce((a, b) => a.composite > b.composite ? a : b);
    const top10 = results.slice().sort((a, b) => b.composite - a.composite).slice(0, 10);

    const currentResult = results.find((r) =>
        Math.abs(r.hurstWindow - defaultH) < epsH && Math.abs(r.peWindow - defaultP) < epsP
    );

    function cell(r: RegimeResult | undefined, h: number, p: number): string {
        if (!r) return '<td class="empty"></td>';
        const norm = (r.composite - minComposite) / range; // 0 = worst, 1 = best

        // Color ramp: red (worst) → orange → yellow → green (best)
        // norm 0.0 → rgb(248,81,73)   red
        // norm 0.5 → rgb(240,140,0)   orange
        // norm 1.0 → rgb(46,160,67)   green
        const rr = norm < 0.5
            ? Math.round(248 - (248 - 240) * norm * 2)
            : Math.round(240 - (240 - 46) * (norm - 0.5) * 2);
        const rg = norm < 0.5
            ? Math.round(81 + (140 - 81) * norm * 2)
            : Math.round(140 + (160 - 140) * (norm - 0.5) * 2);
        const rb = norm < 0.5
            ? Math.round(73 + (0 - 73) * norm * 2)
            : Math.round(0 + (67 - 0) * (norm - 0.5) * 2);
        const bg = `rgb(${rr},${rg},${rb})`;

        const isCenter = Math.abs(h - defaultH) < epsH && Math.abs(p - defaultP) < epsP;
        const isBest   = r === best;
        let border = isBest ? '2px solid #fff' : isCenter ? '2px solid #58a6ff' : '1px solid #1c2128';

        return `<td class="cell" style="background:${bg};${border}"
            title="H=${Math.round(h)} PE=${Math.round(p)}
composite=${r.composite} (${(norm * 100).toFixed(1)}% of range)
stability=${r.meanStability.toFixed(1)}b  lag=${r.lagScore.toFixed(3)}
noise=${(r.entropyDefect*100).toFixed(1)}%">
            <span class="val" style="color:${norm > 0.7 ? '#fff' : norm > 0.35 ? '#0b0e14' : 'rgba(255,255,255,0.75)'}">${r.composite.toFixed(3)}</span>
        </td>`;
    }

    // PE on Y axis (rows), Hurst on X axis (columns)
    const colHeaders = hurstVals.map((h: number) => `<th>${Math.round(h)}</th>`).join('');
    const rows = peVals.map((p: number) =>
        `<tr><td class="row-label">${Math.round(p)}</td>${hurstVals.map((h: number) => cell(grid[`${h},${p}`], h, p)).join('')}</tr>`
    ).join('\n');

    const top10Bars = top10.map((r, i) => {
        const isCenter = Math.abs(r.hurstWindow - defaultH) < epsH && Math.abs(r.peWindow - defaultP) < epsP;
        const isBest = r === best;
        const barNorm = (r.composite - minComposite) / range;
        const rr = barNorm < 0.5
            ? Math.round(248 - (248 - 240) * barNorm * 2)
            : Math.round(240 - (240 - 46) * (barNorm - 0.5) * 2);
        const rg = barNorm < 0.5
            ? Math.round(81 + (140 - 81) * barNorm * 2)
            : Math.round(140 + (160 - 140) * (barNorm - 0.5) * 2);
        const rb = barNorm < 0.5
            ? Math.round(73 + (0 - 73) * barNorm * 2)
            : Math.round(0 + (67 - 0) * (barNorm - 0.5) * 2);
        const barColor = `rgb(${rr},${rg},${rb})`;
        return `<div class="bar-row" title="H=${Math.round(r.hurstWindow)} PE=${Math.round(r.peWindow)}  stability=${r.meanStability.toFixed(1)}b  lag=${r.lagScore.toFixed(3)}">
            <span class="bar-label" style="color:${isBest ? '#3fb950' : isCenter ? '#58a6ff' : '#8b949e'}">#${i+1}  H=${Math.round(r.hurstWindow)} PE=${Math.round(r.peWindow)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(barNorm * 100).toFixed(1)}%;background:${barColor}"></div></div>
            <span class="bar-score" style="color:${barColor}">${r.composite.toFixed(3)}</span>
            <span class="bar-meta">${r.meanStability.toFixed(1)}b  lag=${r.lagScore.toFixed(2)}  ${(r.entropyDefect*100).toFixed(0)}%noise</span>
        </div>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Regime Window Optimization</title>
    <style>
        * { box-sizing: border-box; }
        body { background: #0b0e14; color: #d1d5db; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
        h1 { color: #fff; font-size: 16px; margin: 0 0 4px 0; }
        .subtitle { color: #8b949e; font-size: 11px; margin: 0 0 12px 0; }
        .topline { display: flex; gap: 32px; margin-bottom: 14px; font-size: 12px; }
        .topline span { color: #8b949e; }
        .topline .highlight { color: #3fb950; font-weight: bold; }
        .topline .current { color: #58a6ff; }
        .layout { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
        .col-label { font-size: 11px; color: #8b949e; margin-bottom: 4px; }
        table { border-collapse: collapse; }
        th, td { padding: 0; text-align: center; }
        th { color: #8b949e; font-size: 10px; font-weight: normal; height: 20px; line-height: 20px; }
        td.cell { width: 36px; height: 26px; cursor: default; }
        td.cell .val { display: block; font-size: 9px; font-weight: bold; line-height: 26px; }
        td.row-label { color: #8b949e; font-size: 10px; text-align: right; padding-right: 8px; width: 40px; }
        td.empty { background: #161b22; }
        .legend { display: flex; gap: 10px; align-items: center; font-size: 10px; color: #8b949e; margin-top: 8px; }
        .legend-bar { width: 100px; height: 6px; border-radius: 2px; background: linear-gradient(to right, #f85149, #f08c00, #3fb950); }
        .section-title { color: #8b949e; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0; border-bottom: 1px solid #30363d; padding-bottom: 4px; }
        .top10-chart { display: flex; flex-direction: column; gap: 6px; min-width: 380px; }
        .bar-row { display: flex; align-items: center; gap: 10px; }
        .bar-label { font-size: 10px; color: #8b949e; min-width: 100px; text-align: right; font-family: monospace; }
        .bar-track { flex: 1; height: 18px; background: #161b22; border-radius: 2px; overflow: hidden; }
        .bar-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease; }
        .bar-score { font-size: 11px; font-weight: bold; min-width: 44px; text-align: right; font-family: monospace; }
        .bar-meta { font-size: 9px; color: #555; min-width: 140px; }
        .bottom-row { display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap; margin-top: 24px; }
        .score-breakdown { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
        .score-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 14px; }
        .score-card h3 { color: #8b949e; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0; font-weight: normal; }
        .score-card .value { font-size: 18px; font-weight: bold; color: #3fb950; }
        .score-card .desc { font-size: 10px; color: #8b949e; margin-top: 2px; }
        .params-table { font-size: 11px; color: #8b949e; }
        .params-table td { padding: 3px 0; }
        .params-table td:first-child { color: #555; padding-right: 16px; }
    </style>
</head>
<body>
    <h1>Regime Window Optimization</h1>
    <p class="subtitle">
        Composite = 0.30×lag + 0.30×stability + 0.25×entropy + 0.15×structured
        &nbsp;&middot;&nbsp; ${hurstVals.length}×${peVals.length} grid (${hurstVals.length * peVals.length} combos)
        &nbsp;&middot;&nbsp; ${results[0]?.n ?? 0} usable bars
    </p>

    <div class="topline">
        <span>Best: <span class="highlight">H=${Math.round(best.hurstWindow)} PE=${Math.round(best.peWindow)}</span> score=${best.composite}</span>
        <span>Current: <span class="current">H=${defaultH} PE=${defaultP}</span> score=${currentResult ? currentResult.composite : '—'}</span>
        <span>Ratio: <span class="highlight">${(best.composite / (currentResult?.composite || 1)).toFixed(3)}</span></span>
        <span>&Delta;: <span class="highlight">+${((best.composite - (currentResult?.composite || 0)) * 100).toFixed(1)}%</span></span>
    </div>

    <div class="layout">
        <div>
            <div class="col-label">Hurst window &rarr;</div>
            <table class="heatmap">
                <thead><tr><th></th>${colHeaders}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="legend">
                <span style="color:#f85149">bad</span>
                <div class="legend-bar"></div>
                <span style="color:#3fb950">good</span>
                <span style="margin-left:12px;border-left:2px solid #58a6ff;padding-left:6px;">current</span>
                <span style="border-left:2px solid #fff;padding-left:6px;">best</span>
            </div>
        </div>

        <div>
            <p class="section-title">Top 10 — Best combinations</p>
            <div class="top10-chart">${top10Bars}</div>
        </div>
    </div>

    <div class="bottom-row">
        <div class="score-breakdown">
            <div class="score-card">
                <h3>Lag</h3>
                <div class="value">30%</div>
                <div class="desc">Responsiveness (inverse window size)</div>
            </div>
            <div class="score-card">
                <h3>Stability</h3>
                <div class="value">30%</div>
                <div class="desc">Mean regime run-length</div>
            </div>
            <div class="score-card">
                <h3>Entropy</h3>
                <div class="value">25%</div>
                <div class="desc">1 − random-band fraction</div>
            </div>
            <div class="score-card">
                <h3>Structured</h3>
                <div class="value">15%</div>
                <div class="desc">PE structured fraction</div>
            </div>
        </div>

        <table class="params-table">
            <tr><td>Hurst range</td><td>${Math.round(hurstVals[0])} – ${Math.round(hurstVals[hurstVals.length-1])} (center=${defaultH})</td></tr>
            <tr><td>PE range</td><td>${Math.round(peVals[0])} – ${Math.round(peVals[peVals.length-1])} (center=${defaultP})</td></tr>
            <tr><td>Hurst scales</td><td>[${HURST_SCALES.join(', ')}]</td></tr>
            <tr><td>PE embedding</td><td>m=${PE_M}, delay=${PE_DELAY}</td></tr>
            <tr><td>Spacing</td><td>geometric (ratio=${geoRatio.toFixed(3)})</td></tr>
        </table>
    </div>
</body>
</html>`;
}

async function main() {
    const config = parseArgs();

    try {
        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        if (!config.quiet) console.log(`[RegimeWindows] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const prices = candles.map(c => getCandleClose(c) ?? 0);

        if (!config.quiet) console.log(`[RegimeWindows] ${prices.length} candles — running grid search...`);

        const rawResults: RegimeRaw[] = [];
        for (const hW of HURST_WINDOWS) {
            for (const pW of PE_WINDOWS) {
                if (!config.quiet) process.stdout.write(`  H=${hW.toFixed(1)} PE=${pW.toFixed(1)} ... `);
                const r = scoreWindowPair(prices, hW, pW);
                if (r) {
                    rawResults.push(r);
                    if (!config.quiet) console.log(`stab=${r._stabilityRaw.toFixed(1)}b  entr=${(r._entropyRaw*100).toFixed(1)}%  lag=${r._lagRaw.toFixed(3)}`);
                } else {
                    if (!config.quiet) console.log('skip (not enough data)');
                }
            }
        }

        const results = computeComposite(rawResults);

        if (!config.quiet) {
            const best = results.reduce((a, b) => a.composite > b.composite ? a : b);
            console.log(`\n[RegimeWindows] Best: H=${Math.round(best.hurstWindow)} PE=${Math.round(best.peWindow)}  score=${best.composite}  (stab=${best.stabilityScore}  entr=${best.entropyScore}  lag=${best.lagScore})`);
        }

        const html = generateHeatmapHTML(results, HURST_WINDOWS, PE_WINDOWS);
        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(savedLine(CLI_TAGS.regimeWindows, 'Chart', toFileUrl(config.chartFile)));

    } catch (err: unknown) {
        console.error(`[RegimeWindows] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

#!/usr/bin/env node
'use strict';
/**
 * CEX vs DEX cross-rate overlay.
 *
 * Loads a DEX synthetic cross (e.g. IOB.XRP/IOB.XLM via BTS) from a generated
 * TradingView chart payload, loads a CEX synthetic cross produced by
 * `market_adapter/inputs/fetch_cex_synthetic_data.ts` (e.g. XRP/USDT ÷ XLM/USDT
 * on MEXC), aligns both on exact 1h buckets and writes ONE self-contained chart
 * with the two prices overlaid plus a DEX-minus-CEX percentage panel.
 *
 * The CEX side is never fetched by hand here: --fetch reuses the existing seed
 * fetcher so the CEX legs, cross math and gap filling stay identical to the
 * market-adapter seed path.
 *
 * Usage:
 *   npx tsx analysis/compare_cex_dex_cross.ts --fetch \
 *       --dex analysis/charts/tv_iob_xrp_iob_xlm_cross_1h_12m.html
 *   node dist/analysis/compare_cex_dex_cross.js --cex <cex-seed.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PATHS } from '../modules/paths.js';
import {
    escapeHtml,
    serializeJsonForScript,
    writeChartFile,
    UPLOT_SHARED_SCRIPT,
    uplotInlineTags,
} from './chart_utils.js';
import { sharedChartCSS } from './chart_css.js';

interface OhlcRow {
    timeSec: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface Args {
    dex: string;
    cexPath: string;
    chart: string;
    fetch: boolean;
    exchange: string;
    base: string;
    quote: string;
    commonQuote: string;
    interval: string;
    lookbackHours: number;
    limit: number;
    title: string | null;
    help: boolean;
}

interface Stats {
    overlap: number;
    latestTimeSec: number;
    latestDex: number;
    latestCex: number;
    latestPct: number;
    meanPct: number;
    medianPct: number;
    minPct: number;
    maxPct: number;
    returnCorr: number | null;
    dexFlatPct: number;
}

const DEFAULT_DEX = path.join(PATHS.ANALYSIS.CHARTS_DIR, 'tv_iob_xrp_iob_xlm_cross_1h_12m.html');
const DEFAULT_CEX = path.join(PATHS.ANALYSIS.RESULTS_DIR, 'cex_synthetic_xrp_xlm_mexc_1h.json');
const DEFAULT_CHART = path.join(PATHS.ANALYSIS.CHARTS_DIR, 'tv_iob_xrp_iob_xlm_cex_dex_overlay_1h_12m.html');

function parseArgs(argv: string[]): Args {
    const args: Args = {
        dex: DEFAULT_DEX,
        cexPath: DEFAULT_CEX,
        chart: DEFAULT_CHART,
        fetch: false,
        exchange: 'mexc',
        base: 'XRP',
        quote: 'XLM',
        commonQuote: 'USDT',
        interval: '1h',
        lookbackHours: 8760,
        limit: 500,
        title: null,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        switch (flag) {
            case '--dex': args.dex = value; i++; break;
            case '--cex': args.cexPath = value; i++; break;
            case '--chart': args.chart = value; i++; break;
            case '--fetch': args.fetch = true; break;
            case '--exchange': args.exchange = value; i++; break;
            case '--base': args.base = value; i++; break;
            case '--quote': args.quote = value; i++; break;
            case '--common-quote': args.commonQuote = value; i++; break;
            case '--interval': args.interval = value; i++; break;
            case '--lookback-hours': args.lookbackHours = Number(value); i++; break;
            case '--limit': args.limit = Number(value); i++; break;
            case '--title': args.title = value; i++; break;
            case '--help':
            case '-h': args.help = true; break;
            default: throw new Error(`Unknown option: ${flag} (try --help)`);
        }
    }
    // The --fetch child runs with cwd = project root; make every path absolute
    // here so --out, the later read and --chart always point at one file even
    // when the command is invoked from another directory.
    args.dex = path.resolve(args.dex);
    args.cexPath = path.resolve(args.cexPath);
    args.chart = path.resolve(args.chart);
    return args;
}

function validateArgs(args: Args): void {
    if (args.interval !== '1h') {
        throw new Error(`--interval must be 1h (the DEX payload is 1h); got ${args.interval}`);
    }
    if (!Number.isFinite(args.lookbackHours) || args.lookbackHours <= 0) {
        throw new Error('--lookback-hours must be a positive number');
    }
    if (!Number.isFinite(args.limit) || args.limit <= 0) {
        throw new Error('--limit must be a positive number');
    }
}

function printHelp(): void {
    console.log(`Usage:
  npx tsx analysis/compare_cex_dex_cross.ts [--fetch | --cex <cex-seed.json>] [options]

Overlay a DEX synthetic cross (from a generated chart payload or a candles JSON)
with a CEX synthetic cross (XRP/USDT / XLM/USDT on MEXC by default).

Options:
  --dex <path>            DEX chart HTML or candles JSON (default: ${DEFAULT_DEX})
  --cex <path>            CEX seed JSON from fetch_cex_synthetic_data.ts (default: ${DEFAULT_CEX})
  --fetch                 Fetch the CEX seed first with the existing seed fetcher
  --exchange <name>       CEX exchange (default: mexc)
  --base <asset>          Numerator asset (default: XRP)
  --quote <asset>         Denominator asset (default: XLM)
  --common-quote <asset>  Common quote for both legs (default: USDT)
  --interval <label>      Candle interval (default: 1h)
  --lookback-hours <n>    Fetch depth when --fetch is set (default: 8760)
  --limit <n>             Per-request page size when --fetch is set (default: 500)
  --chart <path>          Output HTML (default: ${DEFAULT_CHART})
  --title <text>          Override chart title
  --help                  Show this help
`);
}

function asRows(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

function numberAt(value: unknown, fallback = NaN): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** One row normalizer for both sources: chart payloads use seconds, CEX seeds ms. */
function normalizeRow(timeValue: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown): OhlcRow | null {
    const rawTime = numberAt(timeValue);
    const timeSec = rawTime > 1e11 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
    const close = numberAt(c);
    if (!Number.isFinite(timeSec) || !Number.isFinite(close) || close <= 0) return null;
    return {
        timeSec,
        open: numberAt(o, close),
        high: numberAt(h, close),
        low: numberAt(l, close),
        close,
        volume: numberAt(v, 0),
    };
}

function sortedRows(rows: OhlcRow[], file: string): OhlcRow[] {
    rows.sort((a, b) => a.timeSec - b.timeSec);
    if (rows.length === 0) throw new Error(`${file}: no usable candles`);
    return rows;
}

/** Read the DEX candles out of a TradingView chart payload or a plain JSON file. */
function loadDexCandles(file: string): OhlcRow[] {
    const raw = fs.readFileSync(file, 'utf8');
    let candles: unknown = null;
    if (/\.html?$/i.test(file)) {
        const match = raw.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/);
        if (!match) throw new Error(`${file}: no <script id="payload"> block found`);
        const payload = JSON.parse(match[1]) as { candles?: unknown };
        candles = payload.candles;
    } else {
        const parsed = JSON.parse(raw) as { candles?: unknown };
        candles = Array.isArray(parsed) ? parsed : parsed.candles;
    }
    if (!Array.isArray(candles)) throw new Error(`${file}: no candles array found`);
    const rows: OhlcRow[] = [];
    for (const item of asRows(candles)) {
        const row = normalizeRow(
            item.time ?? item.t ?? item[0],
            item.open ?? item[1],
            item.high ?? item[2],
            item.low ?? item[3],
            item.close ?? item[4],
            item.volume ?? item[5],
        );
        if (row) rows.push(row);
    }
    return sortedRows(rows, file);
}

/** Read the CEX seed emitted by fetch_cex_synthetic_data.ts (timestamp in ms). */
function loadCexCandles(file: string): OhlcRow[] {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { candles?: unknown };
    if (!Array.isArray(parsed.candles)) throw new Error(`${file}: no candles array found`);
    const rows: OhlcRow[] = [];
    for (const item of asRows(parsed.candles)) {
        const row = normalizeRow(item[0], item[1], item[2], item[3], item[4], item[5]);
        if (row) rows.push(row);
    }
    return sortedRows(rows, file);
}

/** Run the existing CEX seed fetcher; keep its output path so callers can reuse it. */
function fetchCexSeed(args: Args): void {
    const cexCli = [
        '--exchange', args.exchange,
        '--base', args.base,
        '--quote', args.quote,
        '--common-quote', args.commonQuote,
        '--interval', args.interval,
        '--lookback-hours', String(args.lookbackHours),
        '--limit', String(args.limit),
        '--out', args.cexPath,
        '--quiet',
    ];
    const fromSource = /\.ts$/.test(process.argv[1] || '');
    const command = fromSource ? 'npx' : process.execPath;
    const commandArgs = fromSource
        ? ['--no-install', 'tsx', path.join(PATHS.PROJECT_ROOT, 'market_adapter/inputs/fetch_cex_synthetic_data.ts'), ...cexCli]
        : [path.join(PATHS.PROJECT_ROOT, 'dist/market_adapter/inputs/fetch_cex_synthetic_data.js'), ...cexCli];
    fs.mkdirSync(path.dirname(args.cexPath), { recursive: true });
    console.log(`[cex-dex] Fetching ${args.base}/${args.commonQuote} and ${args.quote}/${args.commonQuote} from ${args.exchange} ...`);
    const result = spawnSync(command, commandArgs, { cwd: PATHS.PROJECT_ROOT, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`CEX seed fetcher exited with status ${result.status}`);
}

interface Aligned {
    xs: number[];
    dex: number[];
    cex: number[];
    pct: number[];
    zero: number[];
}

function align(dexRows: OhlcRow[], cexRows: OhlcRow[]): Aligned {
    const cexByTime = new Map(cexRows.map((row) => [row.timeSec, row]));
    const dexByTime = new Map(dexRows.map((row) => [row.timeSec, row]));
    const times = [...dexByTime.keys()]
        .filter((t) => cexByTime.has(t))
        .sort((a, b) => a - b);
    const out: Aligned = { xs: [], dex: [], cex: [], pct: [], zero: [] };
    for (const t of times) {
        const dex = dexByTime.get(t);
        const cex = cexByTime.get(t);
        if (!dex || !cex || !(cex.close > 0)) continue;
        out.xs.push(t);
        out.dex.push(dex.close);
        out.cex.push(cex.close);
        out.pct.push(Number(((dex.close / cex.close - 1) * 100).toFixed(4)));
        out.zero.push(0);
    }
    if (out.xs.length < 2) throw new Error('DEX and CEX candles have fewer than two overlapping buckets');
    return out;
}

function quantile(sorted: number[], p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function computeStats(data: Aligned, dexRows: OhlcRow[]): Stats {
    const pct = data.pct;
    const sorted = [...pct].sort((a, b) => a - b);
    const mean = pct.reduce((sum, v) => sum + v, 0) / pct.length;
    const retDex: number[] = [];
    const retCex: number[] = [];
    for (let i = 1; i < data.xs.length; i++) {
        retDex.push(Math.log(data.dex[i] / data.dex[i - 1]));
        retCex.push(Math.log(data.cex[i] / data.cex[i - 1]));
    }
    let corr: number | null = null;
    if (retDex.length > 2) {
        const meanD = retDex.reduce((a, b) => a + b, 0) / retDex.length;
        const meanC = retCex.reduce((a, b) => a + b, 0) / retCex.length;
        let cov = 0;
        let varD = 0;
        let varC = 0;
        for (let i = 0; i < retDex.length; i++) {
            cov += (retDex[i] - meanD) * (retCex[i] - meanC);
            varD += (retDex[i] - meanD) ** 2;
            varC += (retCex[i] - meanC) ** 2;
        }
        corr = varD > 0 && varC > 0 ? cov / Math.sqrt(varD * varC) : null;
    }
    const flat = dexRows.filter((row) => row.volume === 0 || row.close === row.open).length;
    const last = data.xs.length - 1;
    return {
        overlap: data.xs.length,
        latestTimeSec: data.xs[last],
        latestDex: data.dex[last],
        latestCex: data.cex[last],
        latestPct: data.pct[last],
        meanPct: mean,
        medianPct: quantile(sorted, 0.5),
        minPct: sorted[0],
        maxPct: sorted[sorted.length - 1],
        returnCorr: corr,
        dexFlatPct: (flat / Math.max(1, dexRows.length)) * 100,
    };
}

function renderChart(data: Aligned, stats: Stats, args: Args, dexLabel: string, cexLabel: string): string {
    const title = args.title || `${dexLabel} vs ${cexLabel} cross-rate overlay · 1h`;
    const payload = {
        xs: data.xs,
        dex: data.dex,
        cex: data.cex,
        pct: data.pct,
        zero: data.zero,
        dexLabel,
        cexLabel,
        stats,
        sourceDex: path.basename(args.dex),
        sourceCex: path.basename(args.cexPath),
    };
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${sharedChartCSS()}
body { display: flex; flex-direction: column; height: 100vh; }
#header { height: auto; min-height: 64px; flex: 0 0 auto; gap: 18px; }
#title-box { min-width: 0; }
#chart-title { font-size: 15px; font-weight: 700; color: #f5f8fb; }
#chart-sub { font-size: 11px; color: #8290a2; margin-top: 3px; }
#stats { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: #8290a2; }
#stats b { color: #eef4fb; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#panels { flex: 1 1 auto; min-height: 0; height: auto; width: auto; }
.pane { position: relative; flex: 1 1 auto; min-height: 0; }
#diff-pane { flex: 0 0 24%; border-top: 1px solid #263241; }
#price-chart, #diff-chart { width: 100%; height: 100%; position: relative; }
.legend { top: 10px; left: 14px; gap: 16px; }
.l-dot { width: 9px; height: 9px; border-radius: 999px; display: inline-block; }
.val { color: #eef4fb; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
.section-label { top: 10px; right: 14px; }
</style>
${uplotInlineTags()}
</head>
<body>
<div id="header">
  <div id="title-box">
    <div id="chart-title">${escapeHtml(title)}</div>
    <div id="chart-sub">DEX: ${escapeHtml(path.basename(args.dex))} · CEX: ${escapeHtml(path.basename(args.cexPath))} · aligned on exact 1h buckets</div>
  </div>
  <div id="stats">
    <span>overlap <b id="s-overlap">-</b></span>
    <span>DEX <b id="s-dex">-</b></span>
    <span>CEX <b id="s-cex">-</b></span>
    <span>DEX−CEX <b id="s-diff">-</b></span>
    <span>mean <b id="s-mean">-</b></span>
    <span>return corr <b id="s-corr">-</b></span>
  </div>
</div>
<div id="panels">
  <div class="pane" id="price-pane">
    <div class="legend">
      <span class="legend-item"><span class="l-dot" style="background:#5ea1ff"></span>${escapeHtml(dexLabel)} <span class="val" id="l-dex">-</span></span>
      <span class="legend-item"><span class="l-dot" style="background:#f59e0b"></span>${escapeHtml(cexLabel)} <span class="val" id="l-cex">-</span></span>
      <span class="legend-item">time <span class="val" id="l-time">-</span></span>
    </div>
    <div class="section-label">price</div>
    <div id="price-chart"></div>
  </div>
  <div class="pane" id="diff-pane">
    <div class="legend">
      <span class="legend-item"><span class="l-dot" style="background:#2dd4bf"></span>DEX − CEX <span class="val" id="l-pct">-</span></span>
    </div>
    <div class="section-label">difference · %</div>
    <div id="diff-chart"></div>
  </div>
</div>
<script id="overlay-payload" type="application/json">${serializeJsonForScript(payload)}</script>
<script>
(function () {
  const d = JSON.parse(document.getElementById('overlay-payload').textContent);
  const xMin = d.xs[0], xMax = d.xs[d.xs.length - 1];
  const charts = [];
  let pendingRange = null;
  let pendingRangeRaf = 0;
  ${UPLOT_SHARED_SCRIPT}

  const fmt = (v) => (v == null || !isFinite(v)) ? '-' : Number(v).toFixed(4);
  const fmtPct = (v) => (v == null || !isFinite(v)) ? '-' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  const fmtTime = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const st = d.stats;
  document.getElementById('s-overlap').textContent = String(st.overlap);
  document.getElementById('s-dex').textContent = fmt(st.latestDex);
  document.getElementById('s-cex').textContent = fmt(st.latestCex);
  document.getElementById('s-diff').textContent = fmtPct(st.latestPct);
  document.getElementById('s-mean').textContent = fmtPct(st.meanPct);
  document.getElementById('s-corr').textContent = st.returnCorr == null ? '-' : st.returnCorr.toFixed(3);

  let syncingCursor = false;
  function setLegend(idx) {
    const i = Number.isFinite(idx) ? Math.max(0, Math.min(d.xs.length - 1, idx)) : d.xs.length - 1;
    document.getElementById('l-time').textContent = fmtTime(d.xs[i]);
    document.getElementById('l-dex').textContent = fmt(d.dex[i]);
    document.getElementById('l-cex').textContent = fmt(d.cex[i]);
    document.getElementById('l-pct').textContent = fmtPct(d.pct[i]);
  }
  function cursorHook(self, other) {
    if (syncingCursor) return;
    const idx = self.cursor.idx;
    setLegend(idx);
    if (idx == null || !other) return;
    syncingCursor = true;
    try { other.setCursor({ idx: Number(idx) }, false); } finally { syncingCursor = false; }
  }

  const priceEl = document.getElementById('price-chart');
  const diffEl = document.getElementById('diff-chart');
  // Declared before the hooks so a synchronous setCursor during construction
  // can never read a not-yet-initialized chart (TDZ).
  let price = null;
  let diff = null;
  const common = {
    width: priceEl.clientWidth || 1000,
    cursor: { drag: { x: false, y: false } },
    legend: { show: false },
    scales: { x: { time: false } },
    axes: [
      { stroke: '#8290a2', grid: { stroke: 'rgba(255,255,255,0.05)' }, values: (u, vals) => vals.map((v) => fmtTime(v).slice(5, 11)) },
      { stroke: '#8290a2', grid: { stroke: 'rgba(255,255,255,0.05)' }, size: 62 },
    ],
  };
  price = new uPlot({
    ...common,
    height: Math.max(240, priceEl.clientHeight || 420),
    series: [
      {},
      { label: d.dexLabel, stroke: '#5ea1ff', width: 1.6, points: { show: false } },
      { label: d.cexLabel, stroke: '#f59e0b', width: 1.6, points: { show: false } },
    ],
    hooks: { setCursor: [(u) => cursorHook(u, diff)] },
  }, [d.xs, d.dex, d.cex], priceEl);

  diff = new uPlot({
    ...common,
    height: Math.max(120, diffEl.clientHeight || 160),
    series: [
      {},
      { label: 'DEX - CEX %', stroke: '#2dd4bf', width: 1.4, points: { show: false }, fill: (u, s) => ({ fillTo: u.valToPos(0, 'y'), fill: 'rgba(45,212,191,0.10)' }) },
      { label: '0%', stroke: '#465569', width: 1, dash: [4, 4], points: { show: false } },
    ],
    hooks: { setCursor: [(u) => cursorHook(u, price)] },
  }, [d.xs, d.pct, d.zero], diffEl);

  charts.push(price, diff);
  bindWheelZoom(price);
  bindWheelZoom(diff);
  bindPan(price);
  bindPan(diff);

  setLegend(d.xs.length - 1);
  window.addEventListener('resize', () => {
    price.setSize({ width: priceEl.clientWidth, height: Math.max(240, priceEl.clientHeight) });
    diff.setSize({ width: diffEl.clientWidth, height: Math.max(120, diffEl.clientHeight) });
  });
})();
</script>
</body>
</html>
`;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }
    validateArgs(args);
    if (args.fetch) fetchCexSeed(args);
    else if (!fs.existsSync(args.cexPath)) {
        throw new Error(`CEX seed not found: ${args.cexPath} (pass --fetch or --cex <path>)`);
    }

    const dexRows = loadDexCandles(args.dex);
    const cexRows = loadCexCandles(args.cexPath);
    const data = align(dexRows, cexRows);
    const stats = computeStats(data, dexRows);
    const dexLabel = `${args.base}/${args.quote} DEX`;
    const cexLabel = `${args.exchange.toUpperCase()} ${args.base}/${args.quote}`;
    writeChartFile(args.chart, renderChart(data, stats, args, dexLabel, cexLabel));

    console.log(`[cex-dex] overlap: ${stats.overlap} hourly buckets (${fmtUtc(stats.latestTimeSec)})`);
    console.log(`[cex-dex] latest DEX ${stats.latestDex.toFixed(6)} · CEX ${stats.latestCex.toFixed(6)} · diff ${stats.latestPct.toFixed(3)}%`);
    console.log(`[cex-dex] DEX−CEX pct over window: mean ${stats.meanPct.toFixed(3)}% median ${stats.medianPct.toFixed(3)}% [${stats.minPct.toFixed(3)}%, ${stats.maxPct.toFixed(3)}%]`);
    console.log(`[cex-dex] hourly return correlation ${stats.returnCorr == null ? '-' : stats.returnCorr.toFixed(4)} (DEX flat/zero-volume bars ${stats.dexFlatPct.toFixed(1)}%)`);
    console.log(`[cex-dex] chart written to ${args.chart}`);
}

function fmtUtc(tsSec: number): string {
    return new Date(tsSec * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

try {
    main();
} catch (err) {
    const e = err as { stack?: unknown; message?: unknown } | null | undefined;
    console.error(e?.stack || e?.message || String(err));
    process.exit(1);
}

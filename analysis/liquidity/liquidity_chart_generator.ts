'use strict';

/**
 * LIQUIDITY DEPTH CHART (uPlot)
 *
 * Renders one asset pair's liquidity: cumulative order-book depth and the
 * constant-product AMM pool curve, overlaid side by side on the same price
 * axis. The two sources are shown as independent curves (never summed), so the
 * trader can see which one actually supplies the depth at a given price. The
 * pool curve is fee-adjusted: each side terminates at its effective edge and
 * the shaded band between them is the AMM spread a taker has to cross. The
 * visual model follows PoolTool's depth chart, rebuilt with the vendored uPlot
 * runtime used by every other DEXBot2 chart exporter.
 *
 * The page is fully self-contained (uPlot JS+CSS inlined) and needs no network
 * access once written.
 */

import { embedFunctionSources, escapeHtml, serializeJsonForScript, uplotInlineTags } from '../chart_utils.js';
import { sharedChartCSS } from '../chart_css.js';
import { formatCurrency, formatFundsValue, formatPercentLabel, isValidNumber, safeFormat } from '../../modules/order/format.js';
import type { BookStats, DepthBuildResult, PoolState, PriceWindow } from './liquidity_depth_model.js';
import { buildDepthView } from './liquidity_view.js';

interface ChartAsset {
    symbol: string;
    id?: string;
    precision?: number;
}

interface LiquidityChartInput {
    base: ChartAsset;
    quote: ChartAsset;
    pool: PoolState | null;
    book: BookStats;
    series: DepthBuildResult;
    window: PriceWindow;
    generatedAt?: string;
}

const COLORS = {
    bidBook: '#3fb950',
    askBook: '#f85149',
    bidPool: '#58a6ff',
    askPool: '#d2a8ff',
    // Spread bands: book = best bid..best ask, pool = the fee band between the
    // fee-adjusted pool edges. Distinct hues so both can be compared at once;
    // the fill fades downward so a band wider than the viewport reads as a
    // highlight strip instead of tinting the whole chart.
    bookSpreadFillTop: 'rgba(210,153,34,0.20)',
    bookSpreadFillBottom: 'rgba(210,153,34,0.02)',
    bookSpreadEdge: 'rgba(227,179,65,0.5)',
    poolSpreadFillTop: 'rgba(210,168,255,0.24)',
    poolSpreadFillBottom: 'rgba(210,168,255,0.03)',
    poolSpreadEdge: 'rgba(210,168,255,0.65)',
};


function generateLiquidityHTML(input: LiquidityChartInput, title?: string): string {
    const { base, quote, pool, book, series, window } = input;
    const poolPrice = series.poolPrice;
    const pageTitle = title || `Liquidity Depth — ${base.symbol} / ${quote.symbol}`;
    const priceLabel = `${quote.symbol} per ${base.symbol}`;
    const depthLabel = quote.symbol;

    const payload = {
        base: {
            symbol: base.symbol,
            id: base.id ?? null,
            precision: base.precision ?? null,
        },
        quote: {
            symbol: quote.symbol,
            id: quote.id ?? null,
            precision: quote.precision ?? null,
        },
        pool: pool
            ? {
                id: pool.id ?? null,
                shareAsset: pool.shareAsset ?? null,
                baseReserve: pool.baseReserve,
                quoteReserve: pool.quoteReserve,
                feePercent: pool.feePercent ?? null,
                price: poolPrice,
            }
            : null,
        book: {
            bestBid: book.bestBid,
            bestAsk: book.bestAsk,
            mid: book.mid,
            spreadPercent: book.spreadPercent,
            bidOrders: book.bidOrders,
            askOrders: book.askOrders,
            bidQuoteTotal: book.bidQuoteTotal,
            askQuoteTotal: book.askQuoteTotal,
        },
        series,
        window,
        priceLabel,
        depthLabel,
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        colors: COLORS,
    };

    const poolBadge = pool
        ? `<span class="badge badge-pool">POOL ${escapeHtml(pool.id ?? 'unknown')}</span>
           <span class="badge" id="badge-pool-price">${escapeHtml(formatCurrency(poolPrice as number))} ${escapeHtml(priceLabel)}</span>`
        : `<span class="badge badge-muted">NO AMM POOL</span>`;

    // The pool draws two curves that stop at their fee-adjusted edges, so the
    // header states the fee and the spread it opens between them.
    const poolBidEdge = series.poolBidPrice;
    const poolAskEdge = series.poolAskPrice;
    const poolSpreadPercent = poolBidEdge != null && poolAskEdge != null && poolAskEdge > 0
        ? ((poolAskEdge - poolBidEdge) / poolAskEdge) * 100
        : null;
    const feeBadge = pool && pool.feePercent != null
        ? `<span class="badge badge-pool" title="AMM taker fee (charged on the output side)">FEE ${escapeHtml(formatPercentLabel(pool.feePercent))}${poolSpreadPercent != null ? ` &middot; POOL SPREAD ${escapeHtml(formatPercentLabel(poolSpreadPercent))}` : ''}</span>`
        : '';

    const midBadge = book.mid != null
        ? `<span class="badge" id="badge-mid">BOOK MID ${escapeHtml(formatCurrency(book.mid))}</span>`
        : `<span class="badge badge-muted">ONE-SIDED BOOK</span>`;

    const spreadBadge = book.spreadPercent != null
        ? `<span class="badge badge-book">BOOK SPREAD ${escapeHtml(formatPercentLabel(book.spreadPercent))}</span>`
        : '';

    const windowBadge = `<span class="badge badge-muted">&plusmn;${escapeHtml(formatPercentLabel(((window.max - window.min) / (2 * (poolPrice ?? book.mid ?? window.min))) * 100))} WINDOW</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(pageTitle)}</title>
    ${uplotInlineTags()}
    <style>
        ${sharedChartCSS()}
        #header { height: 64px; }
        #panels { height: calc(100vh - 64px); }
        #liquidity-panel { flex: 1 1 auto; min-height: 0; position: relative; }
        #liquidity-chart { position: absolute; inset: 0; }
        .badge { display: inline-block; padding: 3px 9px; border-radius: 3px; font-size: 11px; font-weight: 600;
                 letter-spacing: 0.4px; background: rgba(110,118,129,0.16); color: #adbac7; white-space: nowrap; }
        .badge-pool { background: rgba(88,166,255,0.18); color: #79c0ff; }
        .badge-book { background: rgba(210,153,34,0.18); color: #e3b341; }
        .badge-muted { color: #6e7681; }
        .readout { position: absolute; top: 10px; left: 12px; z-index: 10; pointer-events: none;
                   background: rgba(11,14,20,0.82); border: 1px solid #21262d; border-radius: 6px;
                   padding: 7px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                   font-size: 13px; color: #adbac7; line-height: 1.45; white-space: nowrap; }
        .readout .price { color: #e6edf3; font-size: 15px; font-weight: 600; }
        .readout table { border-collapse: collapse; margin-top: 3px; }
        .readout th { font-weight: 600; color: #6e7681; padding: 0 10px 0 0; text-align: right; }
        .readout th.side { text-align: left; }
        .readout td { padding: 0 10px 0 0; text-align: right; }
        .readout td.side-bid { color: ${COLORS.bidBook}; text-align: left; }
        .readout td.side-ask { color: ${COLORS.askBook}; text-align: left; }
        .spread-block { margin-top: 5px; padding-top: 5px; border-top: 1px solid #21262d; }
        .spread-row { display: flex; align-items: baseline; gap: 7px; line-height: 1.5; }
        .spread-row .swatch { width: 9px; height: 9px; border-radius: 2px; align-self: center; flex: 0 0 auto; }
        .spread-key { width: 30px; color: #6e7681; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }
        .spread-pct { color: #adbac7; font-size: 14px; font-weight: 600; }
        .spread-row.is-tighter .spread-pct { color: #7ee787; }
        .spread-tag { display: none; font-size: 9px; letter-spacing: 0.4px; color: #3fb950; border: 1px solid rgba(63,185,80,0.5);
                      border-radius: 3px; padding: 0 4px; }
        .spread-row.is-tighter .spread-tag { display: inline-block; }
        .spread-range { color: #8b949e; font-size: 11px; }
        .hint { font-size: 12px; color: #8b949e; white-space: nowrap; }
        .legend-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
        .legend-item { display: inline-flex; align-items: center; gap: 5px; margin-left: 8px; vertical-align: middle; }
    </style>
</head>
<body>
    <div id="header">
        <div style="display:flex;flex-direction:column;gap:3px;">
            <div style="font-weight:bold;color:#fff;font-size:13px;">${escapeHtml(pageTitle)}</div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                ${poolBadge}
                ${feeBadge}
                ${midBadge}
                ${spreadBadge}
                ${windowBadge}
                <span class="badge badge-muted">${escapeHtml(String(book.bidOrders))} BID / ${escapeHtml(String(book.askOrders))} ASK ORDERS</span>
            </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end;">
            <div class="hint">Scroll&nbsp;=&nbsp;zoom &middot; Drag&nbsp;=&nbsp;pan &middot; Double-click&nbsp;=&nbsp;reset</div>
            <div class="hint">
                <span class="legend-item"><span class="legend-swatch" style="background:${COLORS.bidBook};"></span>book bids</span>
                <span class="legend-item"><span class="legend-swatch" style="background:${COLORS.askBook};"></span>book asks</span>
                <span class="legend-item"><span class="legend-swatch" style="background:${COLORS.bidPool};"></span>pool bids</span>
                <span class="legend-item"><span class="legend-swatch" style="background:${COLORS.askPool};"></span>pool asks</span>
            </div>
        </div>
    </div>

    <div id="panels">
        <div id="liquidity-panel">
            <div class="readout" id="readout">
                <div>Price <span class="price" id="r-price">-</span> <span id="r-unit">${escapeHtml(priceLabel)}</span></div>
                <table>
                    <thead><tr><th class="side"></th><th>book</th><th>pool</th></tr></thead>
                    <tbody>
                        <tr>
                            <td class="side-bid">BIDS</td>
                            <td id="r-book-bid" style="color:${COLORS.bidBook};">-</td>
                            <td id="r-pool-bid" style="color:${COLORS.bidPool};">-</td>
                        </tr>
                        <tr>
                            <td class="side-ask">ASKS</td>
                            <td id="r-book-ask" style="color:${COLORS.askBook};">-</td>
                            <td id="r-pool-ask" style="color:${COLORS.askPool};">-</td>
                        </tr>
                    </tbody>
                </table>
                <div class="spread-block">
                    <div class="spread-row" id="spread-book">
                        <span class="swatch" style="background:${COLORS.bookSpreadEdge};"></span>
                        <span class="spread-key">BOOK</span>
                        <span class="spread-pct" id="r-book-spread">-</span>
                        <span class="spread-tag">tighter</span>
                        <span class="spread-range" id="r-book-spread-range"></span>
                    </div>
                    <div class="spread-row" id="spread-pool">
                        <span class="swatch" style="background:${COLORS.poolSpreadEdge};"></span>
                        <span class="spread-key">POOL</span>
                        <span class="spread-pct" id="r-pool-spread">-</span>
                        <span class="spread-tag">tighter</span>
                        <span class="spread-range" id="r-pool-spread-range"></span>
                    </div>
                </div>
                <div style="color:#8b949e;font-size:11px;margin-top:3px;">depth in <span id="r-depth-unit">${escapeHtml(depthLabel)}</span> &middot; shaded bands = spreads to cross</div>
                <div style="color:#8b949e;font-size:11px;">click axes: y = depth asset &middot; x = invert price</div>
            </div>
            <div id="liquidity-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript(payload)}</script>

    <script>
    (function () {
        const data = JSON.parse(document.getElementById('payload').textContent);
        ${embedFunctionSources([buildDepthView, formatPercentLabel, isValidNumber, safeFormat, formatCurrency, formatFundsValue])}
        const fmtPrice = formatCurrency;
        const fmtDepth = formatFundsValue;
        const colors = data.colors;
        const series = data.series;
        const quoteUnit = data.quote.symbol;
        const baseUnit = data.base.symbol;

        // orientation: 'normal' = quote per base, 'inverted' = base per quote.
        // depthMode is relative to the current orientation: 'quote' means the
        // current quote asset, 'base' the current base asset.
        let orientation = 'normal';
        let depthMode = 'quote';
        let view = null;
        const guides = [];
        let xMin = data.window.min;
        let xMax = data.window.max;

        function currentPriceUnit() {
            return orientation === 'normal' ? data.priceLabel : baseUnit + ' per ' + quoteUnit;
        }
        function currentDepthUnit() {
            if (orientation === 'normal') return depthMode === 'base' ? baseUnit : quoteUnit;
            return depthMode === 'base' ? quoteUnit : baseUnit;
        }

        // Build the currently displayed arrays. The transform is shared with
        // the Node tests (liquidity_view.ts) and embedded verbatim above.
        function buildView() {
            return buildDepthView(series, {
                orientation: orientation,
                depthMode: depthMode,
                poolPrice: data.pool ? data.pool.price : null,
                mid: data.book.mid,
                window: data.window,
                bookBestBid: data.book.bestBid,
                bookBestAsk: data.book.bestAsk,
            });
        }
        function currentChartData() {
            return [view.prices, view.poolBid, view.poolAsk, view.bookBid, view.bookAsk];
        }
        function rebuildGuides() {
            guides.length = 0;
            if (view.poolPrice != null) {
                guides.push({ price: view.poolPrice, color: 'rgba(230,237,243,0.85)', dash: [6, 4], label: 'POOL' });
            }
            if (view.mid != null) {
                guides.push({ price: view.mid, color: 'rgba(196,205,216,0.9)', dash: [2, 4], label: 'BOOK MID' });
            }
        }
        view = buildView();
        rebuildGuides();
        xMin = view.min;
        xMax = view.max;

        // ── formatting ──────────────────────────────────────────────────────
        // 4-significant-digit formatting comes from modules/order/format.ts
        // (formatCurrency / formatFundsValue), embedded above so generated
        // charts run the same formatters as DEXBot's order logs.

        // ── view range (zoom / pan) ─────────────────────────────────────────
        let pendingRange = null, pendingRangeRaf = 0;
        function currentX(chart) {
            const s = chart.scales.x || {};
            return {
                min: Number.isFinite(s.min) ? s.min : xMin,
                max: Number.isFinite(s.max) ? s.max : xMax,
            };
        }
        function clampXRange(min, max) {
            const full = xMax - xMin;
            const minSpan = full * 0.02;
            let span = max - min;
            if (!Number.isFinite(span) || span <= 0) return { min: xMin, max: xMax };
            span = Math.max(minSpan, Math.min(full, span));
            let nextMin = min;
            let nextMax = min + span;
            if (nextMin < xMin) { nextMin = xMin; nextMax = xMin + span; }
            if (nextMax > xMax) { nextMax = xMax; nextMin = xMax - span; }
            return { min: nextMin, max: nextMax };
        }
        function applyXRange(chart, min, max) {
            pendingRange = clampXRange(min, max);
            if (pendingRangeRaf) return;
            const raf = typeof requestAnimationFrame !== 'undefined'
                ? requestAnimationFrame.bind(window)
                : (fn) => setTimeout(fn, 0);
            pendingRangeRaf = raf(() => {
                const next = pendingRange;
                pendingRange = null;
                pendingRangeRaf = 0;
                if (next) chart.setScale('x', next);
            });
        }

        // ── guide lines + label block ───────────────────────────────────────
        function drawGuides(u) {
            const { ctx, bbox } = u;
            const xScale = u.scales.x;
            if (!xScale || !Number.isFinite(xScale.min) || !Number.isFinite(xScale.max)) return;
            // uPlot leaves this context unscaled, so every coordinate here is a
            // DEVICE pixel. Text sizes and paddings must be multiplied by the
            // device pixel ratio or the labels render at half size on a HiDPI
            // display while uPlot's own axis text stays correct.
            const canvas = ctx.canvas;
            const pr = canvas.width && canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
            const px = (value) => value * pr;
            ctx.save();
            ctx.beginPath();
            ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
            ctx.clip();
            // Spread bands, book first then the (usually much narrower) pool fee
            // band on top. Each band is filled and bounded by two edge lines so
            // it stays readable when zoomed in, and the pool curves terminate at
            // exactly the pool band edges (inverted view swaps the sides).
            function paintBand(lo, hi, fillTop, fillBottom, edge) {
                if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return;
                const x0 = u.valToPos(Math.max(lo, xScale.min), 'x', true);
                const x1 = u.valToPos(Math.min(hi, xScale.max), 'x', true);
                if (!(x1 > x0)) return;
                const fill = ctx.createLinearGradient(0, bbox.top, 0, bbox.top + bbox.height);
                fill.addColorStop(0, fillTop);
                // Fade out by half height: a band wider than the viewport then
                // reads as a highlight strip instead of a full-chart tint.
                fill.addColorStop(0.5, fillBottom);
                ctx.fillStyle = fill;
                ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
                ctx.strokeStyle = edge;
                ctx.lineWidth = Math.max(1, px(1));
                ctx.setLineDash([px(3), px(3)]);
                ctx.beginPath();
                ctx.moveTo(x0, bbox.top);
                ctx.lineTo(x0, bbox.top + bbox.height);
                ctx.moveTo(x1, bbox.top);
                ctx.lineTo(x1, bbox.top + bbox.height);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            paintBand(view.bookBidPrice, view.bookAskPrice, colors.bookSpreadFillTop, colors.bookSpreadFillBottom, colors.bookSpreadEdge);
            paintBand(view.poolBidPrice, view.poolAskPrice, colors.poolSpreadFillTop, colors.poolSpreadFillBottom, colors.poolSpreadEdge);
            for (let i = 0; i < guides.length; i++) {
                const guide = guides[i];
                if (guide.price < xScale.min || guide.price > xScale.max) continue;
                const x = u.valToPos(guide.price, 'x', true);
                ctx.strokeStyle = guide.color;
                ctx.lineWidth = Math.max(1, px(1));
                ctx.setLineDash(guide.dash.map(px));
                ctx.beginPath();
                ctx.moveTo(x, bbox.top);
                ctx.lineTo(x, bbox.top + bbox.height);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            // One aligned label block, parked beside the pool fee band instead
            // of on top of it, so neither the band nor the curves hide the text.
            if (guides.length > 0) {
                ctx.font = '600 ' + px(15) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
                ctx.textAlign = 'left';
                const entries = guides.map((guide) => ({
                    color: guide.color,
                    dash: guide.dash,
                    text: guide.label + ' ' + fmtPrice(guide.price),
                }));
                const swatchW = px(14);
                const gap = px(9);
                const pad = px(9);
                const lineH = px(20);
                const textW = Math.max.apply(null, entries.map((entry) => ctx.measureText(entry.text).width));
                const blockW = Math.min(pad + swatchW + gap + textW + pad, bbox.width - px(12));
                const blockH = pad * 2 + (entries.length - 1) * lineH + px(15);
                const minLeft = bbox.left + px(6);
                const maxLeft = bbox.left + bbox.width - blockW - px(6);
                let left;
                const bandLo = view.poolBidPrice;
                const bandHi = view.poolAskPrice;
                if (bandLo != null && bandHi != null && bandHi > bandLo) {
                    const bandLeft = Math.max(bbox.left, Math.min(u.valToPos(bandLo, 'x', true), bbox.left + bbox.width));
                    const bandRight = Math.max(bbox.left, Math.min(u.valToPos(bandHi, 'x', true), bbox.left + bbox.width));
                    left = bbox.left + bbox.width - bandRight >= blockW + px(16)
                        ? bandRight + px(12)
                        : bandLeft - px(12) - blockW;
                } else {
                    left = maxLeft;
                }
                left = Math.max(minLeft, Math.min(left, maxLeft));
                const top = bbox.top + px(8);
                ctx.fillStyle = 'rgba(11,14,20,0.84)';
                ctx.strokeStyle = 'rgba(48,54,61,0.95)';
                ctx.lineWidth = Math.max(1, px(1));
                ctx.beginPath();
                ctx.rect(left, top, blockW, blockH);
                ctx.fill();
                ctx.stroke();
                for (let i = 0; i < entries.length; i++) {
                    const baseY = top + pad + px(11) + i * lineH;
                    ctx.strokeStyle = entries[i].color;
                    ctx.lineWidth = Math.max(1, px(1));
                    ctx.setLineDash(entries[i].dash.map(px));
                    ctx.beginPath();
                    ctx.moveTo(left + pad, baseY - px(5));
                    ctx.lineTo(left + pad + swatchW, baseY - px(5));
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = entries[i].color;
                    ctx.fillText(entries[i].text, left + pad + swatchW + gap, baseY);
                }
            }
            ctx.restore();
        }

        // ── chart ───────────────────────────────────────────────────────────
        const chartEl = document.getElementById('liquidity-panel');
        const chart = new uPlot({
            width: chartEl.offsetWidth,
            height: chartEl.offsetHeight,
            padding: [10, 44, 10, 8],
            legend: { show: false },
            select: { show: false },
            cursor: {
                show: true,
                x: true,
                y: false,
                points: { show: false },
                drag: { x: false, y: false, setScale: false },
                focus: { prox: -1 },
            },
            scales: {
                x: { time: false },
                y: {
                    auto: true,
                    range: (u, min, max) => [0, Number.isFinite(max) && max > 0 ? max * 1.08 : 1],
                },
            },
            series: [
                { label: 'Price' },
                { label: 'Pool bids', stroke: colors.bidPool, width: 1.5, fill: 'rgba(88,166,255,0.09)', points: { show: false } },
                { label: 'Pool asks', stroke: colors.askPool, width: 1.5, fill: 'rgba(210,168,255,0.09)', points: { show: false } },
                { label: 'Book bids', stroke: colors.bidBook, width: 1.6, dash: [4, 3], fill: 'rgba(63,185,80,0.10)', points: { show: false } },
                { label: 'Book asks', stroke: colors.askBook, width: 1.6, dash: [4, 3], fill: 'rgba(248,81,73,0.10)', points: { show: false } },
            ],
            axes: [
                {
                    stroke: '#ffffff',
                    grid: { stroke: '#1c2128' },
                    ticks: { stroke: '#30363d', width: 1 },
                    size: 34,
                    font: '13px Segoe UI, sans-serif',
                    label: 'Price (' + currentPriceUnit() + ')',
                    labelSize: 20,
                    labelFont: '12px Segoe UI, sans-serif',
                    values: (u, splits) => splits.map((v) => fmtPrice(v)),
                },
                {
                    side: 1,
                    stroke: '#ffffff',
                    grid: { stroke: '#1c2128', dash: [4, 4] },
                    ticks: { stroke: '#30363d', width: 1 },
                    size: 70,
                    font: '13px Segoe UI, sans-serif',
                    label: 'Cumulative depth (' + currentDepthUnit() + ')',
                    labelSize: 20,
                    labelFont: '12px Segoe UI, sans-serif',
                    values: (u, splits) => splits.map((v) => fmtDepth(v)),
                },
            ],
            hooks: { draw: [drawGuides] },
        }, currentChartData(), document.getElementById('liquidity-chart'));

        // ── cursor readout ──────────────────────────────────────────────────
        function nearestIndex(price) {
            const prices = view.prices;
            let lo = 0, hi = prices.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (prices[mid] < price) lo = mid + 1;
                else hi = mid;
            }
            if (lo > 0 && Math.abs(prices[lo - 1] - price) <= Math.abs(prices[lo] - price)) return lo - 1;
            return lo;
        }
        function setText(id, value) {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        }

        // Spread comparison: the book's own bid/ask gap next to the pool fee
        // band, so the cheaper entry is obvious without reading two badges.
        function updateSpreads() {
            const rows = [
                { row: 'spread-book', pct: 'r-book-spread', range: 'r-book-spread-range',
                  lo: view.bookBidPrice, hi: view.bookAskPrice, value: null },
                { row: 'spread-pool', pct: 'r-pool-spread', range: 'r-pool-spread-range',
                  lo: view.poolBidPrice, hi: view.poolAskPrice, value: null },
            ];
            for (const r of rows) {
                r.value = r.lo != null && r.hi != null && r.lo > 0 && r.hi > r.lo
                    ? ((r.hi - r.lo) / r.hi) * 100
                    : null;
            }
            // Only call one of them "tighter" when both are measurable.
            const comparable = rows.every((r) => r.value != null);
            const tightest = comparable ? Math.min(rows[0].value, rows[1].value) : null;
            for (const r of rows) {
                setText(r.pct, r.value != null ? formatPercentLabel(r.value) : '—');
                setText(r.range, r.lo != null && r.hi != null && r.hi > r.lo
                    ? fmtPrice(r.lo) + ' – ' + fmtPrice(r.hi)
                    : '');
                const rowEl = document.getElementById(r.row);
                if (rowEl) rowEl.classList.toggle('is-tighter', tightest != null && r.value <= tightest + 1e-12);
            }
        }
        function updateReadout(idx) {
            if (idx == null || idx < 0 || idx >= view.prices.length) {
                // Park the readout on the best bid (top-of-book depth) rather
                // than the pool price: the pool price sits inside the fee band,
                // where both pool sides are legitimately zero, which reads as an
                // empty readout on first paint.
                const anchor = view.bookBidPrice != null
                    ? view.bookBidPrice
                    : (view.poolPrice != null ? view.poolPrice : (view.mid != null ? view.mid : view.min));
                idx = nearestIndex(anchor);
            }
            setText('r-price', fmtPrice(view.prices[idx]));
            setText('r-book-bid', fmtDepth(view.bookBid[idx]));
            setText('r-pool-bid', fmtDepth(view.poolBid[idx]));
            setText('r-book-ask', fmtDepth(view.bookAsk[idx]));
            setText('r-pool-ask', fmtDepth(view.poolAsk[idx]));
        }

        function updateHeaderPrices() {
            if (view.poolPrice != null) setText('badge-pool-price', fmtPrice(view.poolPrice) + ' ' + currentPriceUnit());
            if (view.mid != null) setText('badge-mid', 'BOOK MID ' + fmtPrice(view.mid));
        }

        // ── axis toggles (y = depth asset, x = invert price) ────────────────
        function inYAxisZone(e) {
            const over = chart.over && chart.over.getBoundingClientRect();
            return !!over && e.clientX >= over.right - 2;
        }
        function inXAxisZone(e) {
            const over = chart.over && chart.over.getBoundingClientRect();
            return !!over && e.clientY >= over.bottom - 2;
        }
        function maxOf(arrays) {
            let max = 0;
            for (const arr of arrays) {
                for (const v of arr) if (Number.isFinite(v) && v > max) max = v;
            }
            return max;
        }
        function applyView() {
            view = buildView();
            xMin = view.min;
            xMax = view.max;
            chart.setData(currentChartData());
            chart.axes[0].label = 'Price (' + currentPriceUnit() + ')';
            chart.axes[1].label = 'Cumulative depth (' + currentDepthUnit() + ')';
            rebuildGuides();
            // setSize re-lays out the axis labels; it also redraws the chart.
            chart.setSize({ width: chartEl.offsetWidth, height: chartEl.offsetHeight });
            const maxY = maxOf([view.bookBid, view.poolBid, view.bookAsk, view.poolAsk]);
            chart.setScale('y', { min: 0, max: Number.isFinite(maxY) && maxY > 0 ? maxY * 1.08 : 1 });
            chart.setScale('x', { min: xMin, max: xMax });
            setText('r-unit', currentPriceUnit());
            setText('r-depth-unit', currentDepthUnit());
            updateHeaderPrices();
            updateSpreads();
            updateReadout(null);
        }
        // Axis clicks toggle, but a drag that starts on an axis gutter must not
        // be mistaken for a click when the mouse is released.
        let pointerDownX = 0;
        let pointerDownY = 0;
        chart.root.addEventListener('click', (e) => {
            if (Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > 4) return;
            if (inYAxisZone(e)) {
                depthMode = depthMode === 'quote' ? 'base' : 'quote';
                applyView();
                return;
            }
            if (inXAxisZone(e)) {
                orientation = orientation === 'normal' ? 'inverted' : 'normal';
                applyView();
            }
        });
        updateHeaderPrices();
        updateSpreads();

        let leavePending = null;
        chart.over.addEventListener('mousemove', () => {
            if (leavePending !== null) { clearTimeout(leavePending); leavePending = null; }
            updateReadout(chart.cursor.idx);
        });
        chart.over.addEventListener('mouseleave', () => {
            leavePending = setTimeout(() => { leavePending = null; updateReadout(null); }, 60);
        });

        // ── zoom / pan / reset ──────────────────────────────────────────────
        chart.root.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = chart.root.getBoundingClientRect();
            const left = e.clientX - rect.left - (chart.bbox.left / (chart.pxRatio || 1));
            const center = chart.posToVal(left, 'x');
            const current = currentX(chart);
            const span = current.max - current.min;
            if (!Number.isFinite(span) || span <= 0) return;
            const factor = e.deltaY < 0 ? 0.85 : 1.15;
            const nextSpan = Math.max((xMax - xMin) * 0.02, Math.min(xMax - xMin, span * factor));
            const ratio = (center - current.min) / span;
            applyXRange(chart, center - nextSpan * ratio, center - nextSpan * ratio + nextSpan);
        }, { passive: false });

        chart.root.addEventListener('dblclick', () => {
            chart.setScale('x', { min: xMin, max: xMax });
        });

        let dragging = false;
        let dragStartX = 0;
        let dragStartMin = xMin;
        let dragStartMax = xMax;
        let xUnitsPerPx = 0;
        function endDrag() {
            if (!dragging) return;
            dragging = false;
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', endDrag);
        }
        function onMouseMove(e) {
            if (!dragging) return;
            e.preventDefault();
            const deltaPx = e.clientX - dragStartX;
            applyXRange(chart, dragStartMin - deltaPx * xUnitsPerPx, dragStartMax - deltaPx * xUnitsPerPx);
        }
        chart.root.addEventListener('mousedown', (e) => {
            if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
            pointerDownX = e.clientX;
            pointerDownY = e.clientY;
            const rect = chart.root.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
            // Axis gutters are click zones (y = depth asset, x = invert price), not pan.
            const overRect = chart.over && chart.over.getBoundingClientRect();
            if (overRect && (e.clientX >= overRect.right - 2 || e.clientY >= overRect.bottom - 2)) return;
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            dragStartX = e.clientX;
            const current = currentX(chart);
            dragStartMin = current.min;
            dragStartMax = current.max;
            xUnitsPerPx = (current.max - current.min) / (chart.bbox.width / (chart.pxRatio || 1));
            document.body.style.cursor = 'grabbing';
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', endDrag, { once: true });
        });
        window.addEventListener('blur', endDrag);
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === '0') chart.setScale('x', { min: xMin, max: xMax });
        });

        // ── resize ──────────────────────────────────────────────────────────
        function sizeChart() {
            chart.setSize({ width: chartEl.offsetWidth, height: chartEl.offsetHeight });
        }
        window.addEventListener('resize', sizeChart);
        sizeChart();
        updateReadout(null);
        requestAnimationFrame(() => requestAnimationFrame(sizeChart));
    })();
    </script>
</body>
</html>`;
}

export { generateLiquidityHTML };
export type { LiquidityChartInput, ChartAsset };

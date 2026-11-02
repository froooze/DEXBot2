const assert = require('assert');

console.log('Running liquidity depth chart tests');

const {
    normalizeOrderBook,
    computePoolPrice,
    computeBookStats,
    resolvePriceWindow,
    buildDepthSeries,
    poolBidDepth,
    poolAskDepth,
    poolBidBaseDepth,
    poolAskBaseDepth,
} = require('../analysis/liquidity/liquidity_depth_model');
const { decodePool, selectPool, normalizeLimitOrders, fetchOrderBook } = require('../analysis/liquidity/liquidity_chain');
const { buildDepthView } = require('../analysis/liquidity/liquidity_view');
const { generateLiquidityHTML } = require('../analysis/liquidity/liquidity_chart_generator');

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
    try {
        fn();
        passed++;
    } catch (err: any) {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
}

function close(actual: number, expected: number, eps = 1e-9) {
    assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}

// ── order-book normalization ──────────────────────────────────────
check('normalize: on-chain bids are real asks, on-chain asks are real bids', () => {
    const sides = normalizeOrderBook({
        bids: [{ base: '2', quote: '10' }],
        asks: [{ base: '2.5', quote: '10' }],
    });
    assert.strictEqual(sides.asks.length, 1);
    assert.strictEqual(sides.bids.length, 1);
    close(sides.asks[0].price, 5);
    close(sides.bids[0].price, 4);
    close(sides.asks[0].quote, 10);
    close(sides.bids[0].quote, 10);
});

check('normalize: sorts best bid first and best ask first', () => {
    const sides = normalizeOrderBook({
        bids: [
            { base: '1', quote: '10' },
            { base: '1', quote: '12' },
        ],
        asks: [
            { base: '1', quote: '14' },
            { base: '1', quote: '13' },
        ],
    });
    assert.deepStrictEqual(sides.asks.map((o: any) => o.price), [10, 12]);
    assert.deepStrictEqual(sides.bids.map((o: any) => o.price), [14, 13]);
});

check('normalize: skips malformed orders without throwing', () => {
    const sides = normalizeOrderBook({
        bids: [{ base: '0', quote: '10' }, { base: '1', quote: 'x' }, null as any],
        asks: undefined,
    });
    assert.strictEqual(sides.bids.length, 0);
    assert.strictEqual(sides.asks.length, 0);
    assert.deepStrictEqual(normalizeOrderBook(null), { bids: [], asks: [] });
});

// ── pool curve math ───────────────────────────────────────────────
check('pool: constant-product depth matches the closed-form solution', () => {
    const baseReserve = 100;
    const quoteReserve = 200;
    const p0 = quoteReserve / baseReserve;
    close(computePoolPrice({ baseReserve, quoteReserve }) as number, 2);
    close(poolBidDepth(1, p0, quoteReserve), 200 * (1 - Math.sqrt(0.5)));
    close(poolAskDepth(4, p0, quoteReserve), 200 * (Math.sqrt(2) - 1));
    // No depth on the wrong side of the pool price and zero at the pool price.
    assert.strictEqual(poolBidDepth(2, p0, quoteReserve), 0);
    assert.strictEqual(poolAskDepth(2, p0, quoteReserve), 0);
    assert.strictEqual(poolBidDepth(3, p0, quoteReserve), 0);
    assert.strictEqual(poolAskDepth(1, p0, quoteReserve), 0);
});

// The closed forms must be an exact re-parameterization of a constant-product
// swap, not just a look-alike: applying the quote/base depth at price p has to
// leave x*y unchanged and move the pool price to exactly p.
check('pool: closed-form depth satisfies the x*y = k swap invariant', () => {
    const baseReserve = 2727.9005;
    const quoteReserve = 3658504.96369;
    const k = baseReserve * quoteReserve;
    const p0 = quoteReserve / baseReserve;
    for (const factor of [0.5, 0.667, 0.8, 0.95, 1.05, 1.2, 1.5]) {
        const price = p0 * factor;
        let newX = baseReserve;
        let newY = quoteReserve;
        if (price < p0) {
            // Sell base into the pool: base in, quote out.
            newX += poolBidBaseDepth(price, p0, baseReserve);
            newY -= poolBidDepth(price, p0, quoteReserve);
        } else if (price > p0) {
            // Buy base from the pool: base out, quote in.
            newX -= poolAskBaseDepth(price, p0, baseReserve);
            newY += poolAskDepth(price, p0, quoteReserve);
        }
        close(newX * newY, k, Math.abs(k) * 1e-12);
        close(newY / newX, price, price * 1e-12);
    }
});

// PoolTool (1.0.0 depthchart.py) prices in A per B and measures depth in B:
//   get_pool_buys:  amount_y * (sqrt(p_pool / p) - 1), p < p_pool
//   get_pool_sells: amount_y * (1 - sqrt(p_pool / p)), p > p_pool
// Our display price is its reciprocal, so the same depth curves appear as
// poolAsk (above p0) and poolBid (below p0).
check('pool: matches PoolTool depthchart formulas under inverted price', () => {
    const baseReserve = 100;   // PoolTool asset_x
    const quoteReserve = 200;  // PoolTool amount_y
    const pPoolTool = baseReserve / quoteReserve;
    const poolToolBuys = (p: number) => quoteReserve * (Math.sqrt(pPoolTool / p) - 1);
    const poolToolSells = (p: number) => quoteReserve * (1 - Math.sqrt(pPoolTool / p));
    const p0Our = quoteReserve / baseReserve;

    for (const pTool of [pPoolTool * 0.5, pPoolTool * 0.75, pPoolTool * 0.95]) {
        // PoolTool "buys" (buying the base) sit below its pool price and equal
        // our asks at the reciprocal price.
        close(poolAskDepth(1 / pTool, p0Our, quoteReserve), poolToolBuys(pTool));
    }
    for (const pTool of [pPoolTool * 1.05, pPoolTool * 1.25, pPoolTool * 2]) {
        // PoolTool "sells" (selling the base) sit above its pool price and
        // equal our bids at the reciprocal price.
        close(poolBidDepth(1 / pTool, p0Our, quoteReserve), poolToolSells(pTool));
    }
});

check('pool: invalid reserves yield no price', () => {
    assert.strictEqual(computePoolPrice(null), null);
    assert.strictEqual(computePoolPrice({ baseReserve: 0, quoteReserve: 10 }), null);
    assert.strictEqual(computePoolPrice({ baseReserve: 10, quoteReserve: Number.NaN }), null);
});

// ── window and book stats ─────────────────────────────────────────
check('window: symmetric fraction around the center', () => {
    assert.deepStrictEqual(resolvePriceWindow(100, 0.5), { min: 50, max: 150 });
    close(resolvePriceWindow(2, 0.25).min, 1.5);
    close(resolvePriceWindow(2, 0.25).max, 2.5);
    assert.throws(() => resolvePriceWindow(0, 0.5));
    assert.throws(() => resolvePriceWindow(100, 0.95));
    assert.throws(() => resolvePriceWindow(100, 0));
});

check('book stats: best levels, mid, spread and totals', () => {
    const stats = computeBookStats({
        bids: [{ price: 9, quote: 30, base: 3 }, { price: 8, quote: 10, base: 1 }],
        asks: [{ price: 11, quote: 20, base: 2 }],
    });
    assert.strictEqual(stats.bestBid, 9);
    assert.strictEqual(stats.bestAsk, 11);
    assert.strictEqual(stats.mid, 10);
    close(stats.spreadPercent as number, (2 / 11) * 100);
    assert.strictEqual(stats.bidOrders, 2);
    assert.strictEqual(stats.askOrders, 1);
    assert.strictEqual(stats.bidQuoteTotal, 40);
    assert.strictEqual(stats.askQuoteTotal, 20);
});

check('book stats: one-sided book has no spread but keeps a mid', () => {
    const stats = computeBookStats({ bids: [{ price: 9, quote: 5, base: 1 }], asks: [] });
    assert.strictEqual(stats.bestBid, 9);
    assert.strictEqual(stats.bestAsk, null);
    assert.strictEqual(stats.mid, 9);
    assert.strictEqual(stats.spreadPercent, null);
});

// ── blended depth series ──────────────────────────────────────────
function sampleSeries() {
    return buildDepthSeries({
        bids: [
            { price: 1.8, quote: 100, base: 100 / 1.8 },
            { price: 1.5, quote: 50, base: 50 / 1.5 },
        ],
        asks: [
            { price: 2.2, quote: 60, base: 60 / 2.2 },
            { price: 2.5, quote: 40, base: 40 / 2.5 },
        ],
        pool: { id: '1.19.1', baseReserve: 100, quoteReserve: 200, feePercent: 0.5 },
        window: { min: 1, max: 3 },
        steps: 21,
    });
}

check('series: all arrays align with the price axis', () => {
    const s = sampleSeries();
    const n = s.prices.length;
    assert.ok(n >= 21);
    for (const key of ['bookBid', 'poolBid', 'bookAsk', 'poolAsk', 'bookBidBase', 'poolBidBase', 'bookAskBase', 'poolAskBase']) {
        assert.strictEqual((s as any)[key].length, n, `${key} length`);
        assert.ok((s as any)[key].every((v: number) => Number.isFinite(v)), `${key} finite`);
    }
    assert.strictEqual(s.priceCount, n);
    assert.strictEqual(s.poolPrice, 2);
    // Base-unit series are sampled on the same axis and wired correctly.
    close(s.bookBidBase[0], 100 / 1.8 + 50 / 1.5);
    close(s.poolBidBase[0], 100 * (Math.sqrt(2) - 1));
    close(s.bookAskBase[n - 1], 60 / 2.2 + 40 / 2.5);
    close(s.poolAskBase[n - 1], 100 * (1 - Math.sqrt(2 / 3)));
});

check('series: each source is monotonic toward its window edge', () => {
    const s = sampleSeries();
    for (let i = 1; i < s.prices.length; i++) {
        assert.ok(s.bookBid[i] <= s.bookBid[i - 1] + 1e-9, `book bid monotonic at ${i}`);
        assert.ok(s.poolBid[i] <= s.poolBid[i - 1] + 1e-9, `pool bid monotonic at ${i}`);
        assert.ok(s.bookAsk[i] >= s.bookAsk[i - 1] - 1e-9, `book ask monotonic at ${i}`);
        assert.ok(s.poolAsk[i] >= s.poolAsk[i - 1] - 1e-9, `pool ask monotonic at ${i}`);
    }
});

check('series: book and pool are independent curves, not a summed total', () => {
    const s = sampleSeries();
    const n = s.prices.length;
    for (let i = 0; i < n; i++) {
        assert.ok(Number.isFinite(s.bookBid[i]) && Number.isFinite(s.poolBid[i]));
        assert.ok(Number.isFinite(s.bookAsk[i]) && Number.isFinite(s.poolAsk[i]));
    }
    // At the window edges both sources are non-zero, so a stacked total would
    // differ from each individual series.
    const near = 0;
    const far = n - 1;
    assert.ok(s.bookBid[near] > 0 && s.poolBid[near] > 0);
    assert.ok(s.bookAsk[far] > 0 && s.poolAsk[far] > 0);
    assert.notStrictEqual(s.poolAsk[far], s.bookAsk[far]);
    // No total* fields exist on the model anymore.
    assert.strictEqual((s as any).totalBid, undefined);
    assert.strictEqual((s as any).totalAsk, undefined);
});

check('series: exact book levels are included at their own price', () => {
    const s = sampleSeries();
    const bidIdx = s.prices.indexOf(1.8);
    const askIdx = s.prices.indexOf(2.2);
    assert.ok(bidIdx >= 0, 'bid level present in grid');
    assert.ok(askIdx >= 0, 'ask level present in grid');
    // Best bid at 1.8 (100); the lower 1.5 bid is not "at or better".
    assert.strictEqual(s.bookBid[bidIdx], 100);
    // Ask at 2.2 (60) is the best ask, nothing better (lower) yet.
    assert.strictEqual(s.bookAsk[askIdx], 60);
});

check('series: an epsilon step past a book level removes it from depth', () => {
    const s = sampleSeries();
    const lowerBidIdx = s.prices.indexOf(1.5);
    const bestAskIdx = s.prices.indexOf(2.2);
    assert.ok(lowerBidIdx >= 0 && bestAskIdx > 0);
    // Just above 1.5 only the 1.8 bid remains.
    assert.strictEqual(s.bookBid[lowerBidIdx + 1], 100);
    // Just below 2.2 no ask is "at or better".
    assert.strictEqual(s.bookAsk[bestAskIdx - 1], 0);
});

check('series: works without a pool (book-only chart)', () => {
    const s = buildDepthSeries({
        bids: [{ price: 9, quote: 10, base: 1 }],
        asks: [{ price: 11, quote: 20, base: 1 }],
        pool: null,
        window: { min: 8, max: 12 },
        steps: 11,
    });
    assert.strictEqual(s.poolPrice, null);
    assert.ok(s.poolBid.every((v: number) => v === 0));
    assert.ok(s.poolAsk.every((v: number) => v === 0));
    assert.strictEqual(s.bookBid[0], 10);
    assert.strictEqual(s.bookAsk[s.bookAsk.length - 1], 20);
});

check('series: rejects an invalid window', () => {
    assert.throws(() => buildDepthSeries({
        bids: [],
        asks: [],
        window: { min: 0, max: 1 },
    }));
    assert.throws(() => buildDepthSeries({
        bids: [],
        asks: [],
        window: { min: 2, max: 1 },
    }));
});

// ── chart view transform (shared with the embedded browser script) ──
check('view: normal orientation passes the sampled series through', () => {
    const s = sampleSeries();
    const v = buildDepthView(s, { orientation: 'normal', depthMode: 'quote', poolPrice: 2, mid: 1.9, window: { min: 1, max: 3 } });
    assert.strictEqual(v.prices, s.prices);
    assert.strictEqual(v.bookBid, s.bookBid);
    assert.strictEqual(v.poolAsk, s.poolAsk);
    assert.strictEqual(v.min, 1);
    assert.strictEqual(v.max, 3);
});

check('view: inverted price is 1/p ascending and centered on the reciprocal centre', () => {
    const s = sampleSeries();
    const v = buildDepthView(s, { orientation: 'inverted', depthMode: 'quote', poolPrice: 2, mid: 1.9, window: { min: 1, max: 3 } });
    const n = s.prices.length;
    close(v.prices[0], 1 / s.prices[n - 1]);
    close(v.prices[n - 1], 1 / s.prices[0]);
    for (let i = 1; i < n; i++) assert.ok(v.prices[i] >= v.prices[i - 1], `inverted prices ascending at ${i}`);
    // Symmetric inverted window around the reciprocal centre (0.5), not a
    // reciprocal of the normal edges: 0.5 * (1 -+ 0.5) => [0.25, 0.75].
    close(v.min, 0.25);
    close(v.max, 0.75);
    close(v.poolPrice as number, 0.5);
    close(v.mid as number, 1 / 1.9);
});

check('view: inversion swaps bid/ask roles and picks the right depth asset', () => {
    const s = sampleSeries();
    const n = s.prices.length;
    const quoteView = buildDepthView(s, { orientation: 'inverted', depthMode: 'quote', poolPrice: 2, mid: 2, window: { min: 1, max: 3 } });
    // Old bids (buying the old base) become asks in the inverted market.
    assert.deepStrictEqual(quoteView.bookAsk, [...s.bookBidBase].reverse());
    assert.deepStrictEqual(quoteView.bookBid, [...s.bookAskBase].reverse());
    assert.deepStrictEqual(quoteView.poolAsk, [...s.poolBidBase].reverse());
    assert.deepStrictEqual(quoteView.poolBid, [...s.poolAskBase].reverse());

    const baseView = buildDepthView(s, { orientation: 'inverted', depthMode: 'base', poolPrice: 2, mid: 2, window: { min: 1, max: 3 } });
    assert.deepStrictEqual(baseView.bookAsk, [...s.bookBid].reverse());
    assert.deepStrictEqual(baseView.bookBid, [...s.bookAsk].reverse());
    assert.strictEqual(baseView.prices.length, n);
});

// ── chain decoding ────────────────────────────────────────────────
const baseAsset = { id: '1.3.1', symbol: 'BASE', precision: 2 };
const quoteAsset = { id: '1.3.2', symbol: 'QUOTE', precision: 3 };

check('chain: decodes pool reserves regardless of asset ordering', () => {
    const pool = decodePool({
        id: '1.19.5',
        asset_a: '1.3.2',
        asset_b: '1.3.1',
        balance_a: '100000',
        balance_b: '2500000',
        share_asset: '1.3.9',
        taker_fee_percent: 50,
    }, baseAsset, quoteAsset);
    assert.ok(pool);
    close(pool!.quoteReserve, 100);
    close(pool!.baseReserve, 25000);
    close(pool!.feePercent as number, 0.5);
    assert.strictEqual(pool!.id, '1.19.5');
    assert.strictEqual(pool!.shareAsset, '1.3.9');
});

check('chain: rejects pools for other assets and invalid balances', () => {
    assert.strictEqual(decodePool({ asset_a: '1.3.7', asset_b: '1.3.8' }, baseAsset, quoteAsset), null);
    assert.strictEqual(decodePool({ asset_a: '1.3.2', asset_b: '1.3.1', balance_a: '0', balance_b: '10' }, baseAsset, quoteAsset), null);
});

check('chain: selects the deepest pool unless an id is requested', () => {
    const pools = [
        { id: '1.19.1', asset_a: '1.3.1', asset_b: '1.3.2', balance_a: '100', balance_b: '50000' },
        { id: '1.19.2', asset_a: '1.3.1', asset_b: '1.3.2', balance_a: '100', balance_b: '90000' },
    ];
    assert.strictEqual(selectPool(pools, baseAsset, quoteAsset)!.id, '1.19.2');
    assert.strictEqual(selectPool(pools, baseAsset, quoteAsset, '1.19.1')!.id, '1.19.1');
    assert.strictEqual(selectPool(pools, baseAsset, quoteAsset, '1.19.9'), null);
});

// ── higher-limit order fetch (get_limit_orders) ──────────────────
check('limit orders: decodes both sides with precision-scaled prices', () => {
    const raw = [
        { for_sale: 125, sell_price: { base: { amount: 250, asset_id: '1.3.1' }, quote: { amount: 5000, asset_id: '1.3.2' } } },
        { for_sale: 4000, sell_price: { base: { amount: 4000, asset_id: '1.3.2' }, quote: { amount: 160, asset_id: '1.3.1' } } },
    ];
    const sides = normalizeLimitOrders(raw, baseAsset, quoteAsset);
    assert.strictEqual(sides.asks.length, 1);
    assert.strictEqual(sides.bids.length, 1);
    close(sides.asks[0].price, 2);
    close(sides.asks[0].quote, 2.5);
    close(sides.asks[0].base, 1.25);
    close(sides.bids[0].price, 2.5);
    close(sides.bids[0].quote, 4);
    close(sides.bids[0].base, 1.6);
});

check('limit orders: skips malformed and other-asset orders', () => {
    const sides = normalizeLimitOrders([
        { for_sale: 0, sell_price: { base: { amount: 0, asset_id: '1.3.1' }, quote: { amount: 10, asset_id: '1.3.2' } } },
        { for_sale: 10, sell_price: { base: { amount: 10, asset_id: '1.3.9' }, quote: { amount: 10, asset_id: '1.3.1' } } },
        null,
    ], baseAsset, quoteAsset);
    assert.strictEqual(sides.bids.length, 0);
    assert.strictEqual(sides.asks.length, 0);
});

check('limit orders: fetchOrderBook prefers get_limit_orders and retries lower caps', async () => {
    const calls: number[] = [];
    const client = {
        db: async (method: string, args: any[]) => {
            if (method === 'get_limit_orders') {
                calls.push(args[2]);
                if (args[2] > 300) throw new Error('Assert Exception: limit <= configured_limit');
                return [
                    { for_sale: 250, sell_price: { base: { amount: 250, asset_id: '1.3.1' }, quote: { amount: 5000, asset_id: '1.3.2' } } },
                ];
            }
            throw new Error('unexpected method ' + method);
        },
    };
    const sides = await fetchOrderBook(client, baseAsset, quoteAsset, 500);
    assert.deepStrictEqual(calls, [500, 300]);
    assert.strictEqual(sides.asks.length, 1);
    close(sides.asks[0].price, 2);
});

check('limit orders: fetchOrderBook falls back to get_order_book', async () => {
    const methods: string[] = [];
    const client = {
        db: async (method: string) => {
            methods.push(method);
            if (method === 'get_limit_orders') throw new Error('unknown method get_limit_orders');
            return {
                bids: [{ base: '2', quote: '4' }],
                asks: [{ base: '2', quote: '5' }],
            };
        },
    };
    const sides = await fetchOrderBook(client, baseAsset, quoteAsset, 300);
    assert.ok(methods.includes('get_limit_orders'));
    assert.ok(methods.includes('get_order_book'));
    assert.strictEqual(sides.asks.length, 1);
    assert.strictEqual(sides.bids.length, 1);
    close(sides.asks[0].price, 2);
    close(sides.bids[0].price, 2.5);
});

// ── HTML generation ───────────────────────────────────────────────
function buildChartHtml() {
    const series = sampleSeries();
    return generateLiquidityHTML({
        base: { symbol: 'BASE', id: '1.3.1', precision: 4 },
        quote: { symbol: 'QUOTE', id: '1.3.2', precision: 5 },
        pool: { id: '1.19.123', baseReserve: 100, quoteReserve: 200, feePercent: 0.5 },
        book: computeBookStats({
            bids: [{ price: 1.8, quote: 100, base: 100 / 1.8 }],
            asks: [{ price: 2.2, quote: 60, base: 60 / 2.2 }],
        }),
        series,
        window: { min: 1, max: 3 },
        generatedAt: '2026-01-01T00:00:00.000Z',
    }, 'Liquidity Depth — BASE / QUOTE');
}

check('html: self-contained uPlot and no sibling asset references', () => {
    const html = buildChartHtml();
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('uPlot'));
    assert.ok(!html.includes('../uplot/'));
    assert.ok(!/<script[^>]+src=/.test(html));
    assert.ok(html.includes('Liquidity Depth'));
    assert.ok(html.includes('1.19.123'));
});

check('html: payload carries aligned series arrays and summary data', () => {
    const html = buildChartHtml();
    const match = html.match(/<script id="payload" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(match, 'payload script present');
    const payload = JSON.parse(match![1]);
    const n = payload.series.prices.length;
    assert.strictEqual(payload.series.bookBid.length, n);
    assert.strictEqual(payload.series.poolBid.length, n);
    assert.strictEqual(payload.series.bookAsk.length, n);
    assert.strictEqual(payload.series.poolAsk.length, n);
    assert.strictEqual(payload.series.bookBidBase.length, n);
    assert.strictEqual(payload.series.poolAskBase.length, n);
    assert.strictEqual(payload.series.totalBid ?? null, null);
    assert.strictEqual(payload.book.bestAsk, 2.2);
    assert.strictEqual(payload.pool.price, 2);
    assert.strictEqual(payload.priceLabel, 'QUOTE per BASE');
    assert.strictEqual(payload.depthLabel, 'QUOTE');
    assert.ok(payload.series.prices.every((v: number) => Number.isFinite(v)));
});

check('html: asset symbols are HTML-escaped', () => {
    const series = sampleSeries();
    const html = generateLiquidityHTML({
        base: { symbol: '<IMG>', id: '1.3.1' },
        quote: { symbol: 'QUOTE & CO', id: '1.3.2' },
        pool: null,
        book: computeBookStats({ bids: [], asks: [] }),
        series,
        window: { min: 1, max: 3 },
    });
    assert.ok(!html.includes('<IMG>'));
    assert.ok(html.includes('&lt;IMG&gt;'));
    assert.ok(html.includes('QUOTE &amp; CO'));
});

check('html: embeds the shared 4-digit formatters', () => {
    const html = buildChartHtml();
    assert.ok(html.includes('function formatCurrency'));
    assert.ok(html.includes('function formatFundsValue'));
    assert.ok(html.includes('function buildDepthView'));
    // Sample pool price is 2 => formatCurrency(2) renders 4 active digits.
    assert.ok(html.includes('2.000 QUOTE per BASE'));
});

console.log(`\nLiquidity depth tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

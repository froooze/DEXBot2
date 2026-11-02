'use strict';

/**
 * LIQUIDITY DEPTH MODEL (pure, no I/O)
 *
 * Blends the limit-order book with the constant-product AMM pool of one asset
 * pair into a single cumulative-depth curve, in the style of PoolTool's depth
 * chart.
 *
 * Conventions
 * -----------
 * - `base`  = asset A (the asset whose price is quoted)
 * - `quote` = asset B (the asset the depth is measured in)
 * - display price = quote per base (B/A), matching DEXBot2's price orientation
 * - depth = cumulative quote (B) liquidity at or better than that price:
 *     * bids: quote the buyer has to spend to fill every bid at price >= p
 *     * asks: quote the seller receives for every ask at price <= p
 *   Parallel base-unit (A) depth arrays are sampled for the chart's y-axis
 *   toggle: bids/asks accumulate order base amounts, and the pool uses the
 *   mirror constant-product solution (see poolBidBaseDepth/poolAskBaseDepth).
 *
 * The on-chain order book exposes orders as `base`/`quote` decimal strings.
 * `get_order_book(A, B)` returns:
 *   - `bids`: orders that SELL A (real asks) — the source code puts every
 *     order whose `sell_price.base` is asset A into this list.
 *   - `asks`: orders that SELL B, i.e. buy A (real bids).
 * `normalizeOrderBook` performs that side flip, so the rest of this module
 * (and the chart) speaks plain real bid/ask.
 *
 * Pool depth is the exact constant-product solution for moving the pool price
 * from p0 to p:
 *   - below p0 (selling base into the pool):
 *       quote received = quoteReserve * (1 - sqrt(p / p0))
 *   - above p0 (buying base from the pool):
 *       quote paid     = quoteReserve * (sqrt(p / p0) - 1)
 * which is the same curve PoolTool plots as `amount_y * (1 - sqrt(p_pool/p))`
 * and `amount_y * (sqrt(p_pool/p) - 1)` (there p_pool/p is inverted because
 * PoolTool's price is base-per-quote). The closed forms preserve x*y = k and
 * move the implied pool price to exactly p; the taker fee is not applied,
 * matching PoolTool's depth chart.
 */

interface RawBookOrder {
    price?: string | number;
    base?: string | number;
    quote?: string | number;
    id?: string;
    owner_name?: string;
}

interface RawOrderBook {
    bids?: RawBookOrder[];
    asks?: RawBookOrder[];
}

interface BookOrder {
    /** Display price in quote per base. */
    price: number;
    /** Amount of quote asset traded by this order (the depth unit). */
    quote: number;
    /** Amount of base asset traded by this order. */
    base: number;
}

interface BookSides {
    /** Real bids (buyers of base), highest price first. */
    bids: BookOrder[];
    /** Real asks (sellers of base), lowest price first. */
    asks: BookOrder[];
}

interface PoolState {
    id?: string;
    shareAsset?: string;
    baseReserve: number;
    quoteReserve: number;
    /** AMM taker fee in percent (e.g. 0.2 = 20 bps), when known. */
    feePercent?: number | null;
}

interface DepthSeries {
    prices: number[];
    /** Cumulative quote (B) depth. */
    bookBid: number[];
    poolBid: number[];
    bookAsk: number[];
    poolAsk: number[];
    /** Cumulative base (A) depth, same price axis (toggled by the chart). */
    bookBidBase: number[];
    poolBidBase: number[];
    bookAskBase: number[];
    poolAskBase: number[];
}

interface PriceWindow {
    min: number;
    max: number;
}

interface BookStats {
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    spreadPercent: number | null;
    bidOrders: number;
    askOrders: number;
    bidQuoteTotal: number;
    askQuoteTotal: number;
}

interface DepthBuildInput {
    bids: BookOrder[];
    asks: BookOrder[];
    pool?: PoolState | null;
    window: PriceWindow;
    steps?: number;
}

interface DepthBuildResult extends DepthSeries {
    poolPrice: number | null;
    /** Union grid including exact book levels for sharp step corners. */
    priceCount: number;
}

const DEFAULT_STEPS = 400;

function isFinitePositive(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toPositiveNumber(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Convert the raw `get_order_book` payload into real bid/ask sides and display
 * prices (quote per base). Invalid orders (missing/zero amounts) are skipped.
 * See the module header for why the on-chain `bids` list becomes real asks.
 */
function normalizeOrderBook(rawBook: RawOrderBook | null | undefined): BookSides {
    const bids: BookOrder[] = [];
    const asks: BookOrder[] = [];
    const collect = (list: unknown, target: BookOrder[]): void => {
        if (!Array.isArray(list)) return;
        for (const entry of list as RawBookOrder[]) {
            const base = toPositiveNumber(entry?.base);
            const quote = toPositiveNumber(entry?.quote);
            if (base == null || quote == null) continue;
            target.push({ price: quote / base, quote, base });
        }
    };
    // On-chain `bids` sell the base asset => real asks.
    collect(rawBook?.bids, asks);
    // On-chain `asks` sell the quote asset => real bids.
    collect(rawBook?.asks, bids);

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);
    return { bids, asks };
}

function computePoolPrice(pool: PoolState | null | undefined): number | null {
    if (!pool) return null;
    if (!isFinitePositive(pool.baseReserve) || !isFinitePositive(pool.quoteReserve)) return null;
    return pool.quoteReserve / pool.baseReserve;
}

function computeBookStats(sides: BookSides): BookStats {
    const bestBid = sides.bids.length ? sides.bids[0].price : null;
    const bestAsk = sides.asks.length ? sides.asks[0].price : null;
    const mid = bestBid != null && bestAsk != null
        ? (bestBid + bestAsk) / 2
        : bestBid ?? bestAsk ?? null;
    const spreadPercent = bestBid != null && bestAsk != null && bestAsk > 0
        ? ((bestAsk - bestBid) / bestAsk) * 100
        : null;
    return {
        bestBid,
        bestAsk,
        mid,
        spreadPercent,
        bidOrders: sides.bids.length,
        askOrders: sides.asks.length,
        bidQuoteTotal: sides.bids.reduce((sum, o) => sum + o.quote, 0),
        askQuoteTotal: sides.asks.reduce((sum, o) => sum + o.quote, 0),
    };
}

/**
 * Symmetric linear window around the pool price (or the book mid when there is
 * no pool), e.g. range 0.5 => [0.5 * center, 1.5 * center].
 */
function resolvePriceWindow(center: number | null, range: number): PriceWindow {
    if (!isFinitePositive(center)) {
        throw new Error('resolvePriceWindow: center price must be a positive finite number');
    }
    if (!Number.isFinite(range) || range <= 0 || range >= 0.95) {
        throw new Error('resolvePriceWindow: range must be between 0 (exclusive) and 0.95 (exclusive)');
    }
    return { min: center * (1 - range), max: center * (1 + range) };
}

function lowerBound(values: number[], target: number): number {
    let lo = 0, hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function upperBound(values: number[], target: number): number {
    let lo = 0, hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function buildPriceGrid(input: DepthBuildInput, poolPrice: number | null): number[] {
    const { window } = input;
    const steps = Math.max(2, Math.floor(input.steps ?? DEFAULT_STEPS));
    const span = window.max - window.min;
    const eps = Math.max(span * 1e-9, Number.MIN_VALUE);
    const values: number[] = [];

    for (let i = 0; i < steps; i++) {
        values.push(window.min + (span * i) / (steps - 1));
    }
    // Duplicate each book level with a tiny offset so the cumulative step is
    // drawn as a near-vertical jump instead of a diagonal ramp between samples.
    // Bids: depth excludes the level once price moves above it (p + eps).
    // Asks: depth excludes the level once price moves below it (p - eps).
    for (const order of input.bids) {
        values.push(order.price, order.price + eps);
    }
    for (const order of input.asks) {
        values.push(order.price, order.price - eps);
    }
    if (poolPrice != null) values.push(poolPrice);

    const inWindow = values.filter((v) => Number.isFinite(v) && v > 0 && v >= window.min && v <= window.max);
    inWindow.sort((a, b) => a - b);
    const deduped: number[] = [];
    for (const v of inWindow) {
        if (deduped.length === 0 || v !== deduped[deduped.length - 1]) deduped.push(v);
    }
    return deduped;
}

/**
 * Build cumulative book depth lookup tables. Bids are stored ascending with a
 * suffix sum (depth at p = sum of bids priced >= p); asks ascending with a
 * prefix sum (depth at p = sum of asks priced <= p).
 */
function buildBookLookups(sides: BookSides): {
    bidPrices: number[];
    bidSuffix: number[];
    bidSuffixBase: number[];
    askPrices: number[];
    askPrefix: number[];
    askPrefixBase: number[];
} {
    const bidAsc = [...sides.bids].sort((a, b) => a.price - b.price);
    const bidPrices = bidAsc.map((o) => o.price);
    const bidSuffix = new Array<number>(bidPrices.length + 1).fill(0);
    const bidSuffixBase = new Array<number>(bidPrices.length + 1).fill(0);
    for (let i = bidAsc.length - 1; i >= 0; i--) {
        bidSuffix[i] = bidSuffix[i + 1] + bidAsc[i].quote;
        bidSuffixBase[i] = bidSuffixBase[i + 1] + bidAsc[i].base;
    }
    const askAsc = [...sides.asks].sort((a, b) => a.price - b.price);
    const askPrices = askAsc.map((o) => o.price);
    const askPrefix = new Array<number>(askPrices.length + 1).fill(0);
    const askPrefixBase = new Array<number>(askPrices.length + 1).fill(0);
    for (let i = 0; i < askAsc.length; i++) {
        askPrefix[i + 1] = askPrefix[i] + askAsc[i].quote;
        askPrefixBase[i + 1] = askPrefixBase[i] + askAsc[i].base;
    }
    return { bidPrices, bidSuffix, bidSuffixBase, askPrices, askPrefix, askPrefixBase };
}

function poolBidDepth(price: number, poolPrice: number, quoteReserve: number): number {
    if (!(price < poolPrice)) return 0;
    return quoteReserve * (1 - Math.sqrt(price / poolPrice));
}

function poolAskDepth(price: number, poolPrice: number, quoteReserve: number): number {
    if (!(price > poolPrice)) return 0;
    return quoteReserve * (Math.sqrt(price / poolPrice) - 1);
}

function poolBidBaseDepth(price: number, poolPrice: number, baseReserve: number): number {
    if (!(price < poolPrice)) return 0;
    return baseReserve * (Math.sqrt(poolPrice / price) - 1);
}

function poolAskBaseDepth(price: number, poolPrice: number, baseReserve: number): number {
    if (!(price > poolPrice)) return 0;
    return baseReserve * (1 - Math.sqrt(poolPrice / price));
}

/**
 * Sample the two liquidity sources independently over a price window. The
 * returned arrays are all the same length and share the `prices` axis.
 *
 * Book depth and pool depth are deliberately NOT summed: an on-chain order and
 * an AMM reserve are different claims on liquidity, so the chart shows them
 * side by side at each price instead of collapsing them into one stacked total.
 */
function buildDepthSeries(input: DepthBuildInput): DepthBuildResult {
    const { window } = input;
    if (!isFinitePositive(window.min) || !isFinitePositive(window.max) || window.max <= window.min) {
        throw new Error('buildDepthSeries: window must be positive with max > min');
    }
    const poolPrice = computePoolPrice(input.pool);
    const quoteReserve = poolPrice != null && input.pool ? input.pool.quoteReserve : 0;
    const prices = buildPriceGrid(input, poolPrice);
    if (prices.length === 0) throw new Error('buildDepthSeries: empty price grid');

    const { bidPrices, bidSuffix, bidSuffixBase, askPrices, askPrefix, askPrefixBase } = buildBookLookups({
        bids: input.bids,
        asks: input.asks,
    });
    const baseReserve = poolPrice != null && input.pool ? input.pool.baseReserve : 0;

    const series: DepthBuildResult = {
        prices,
        bookBid: [],
        poolBid: [],
        bookAsk: [],
        poolAsk: [],
        bookBidBase: [],
        poolBidBase: [],
        bookAskBase: [],
        poolAskBase: [],
        poolPrice,
        priceCount: prices.length,
    };

    for (const price of prices) {
        const bookBid = bidSuffix[lowerBound(bidPrices, price)] ?? 0;
        const bookAsk = askPrefix[upperBound(askPrices, price)] ?? 0;
        const bookBidBase = bidSuffixBase[lowerBound(bidPrices, price)] ?? 0;
        const bookAskBase = askPrefixBase[upperBound(askPrices, price)] ?? 0;
        const poolBid = poolPrice != null ? poolBidDepth(price, poolPrice, quoteReserve) : 0;
        const poolAsk = poolPrice != null ? poolAskDepth(price, poolPrice, quoteReserve) : 0;
        const poolBidBase = poolPrice != null ? poolBidBaseDepth(price, poolPrice, baseReserve) : 0;
        const poolAskBase = poolPrice != null ? poolAskBaseDepth(price, poolPrice, baseReserve) : 0;

        series.bookBid.push(bookBid);
        series.poolBid.push(poolBid);
        series.bookAsk.push(bookAsk);
        series.poolAsk.push(poolAsk);
        series.bookBidBase.push(bookBidBase);
        series.poolBidBase.push(poolBidBase);
        series.bookAskBase.push(bookAskBase);
        series.poolAskBase.push(poolAskBase);
    }

    return series;
}

export {
    DEFAULT_STEPS,
    normalizeOrderBook,
    computePoolPrice,
    computeBookStats,
    resolvePriceWindow,
    buildDepthSeries,
    poolBidDepth,
    poolAskDepth,
    poolBidBaseDepth,
    poolAskBaseDepth,
};
export type {
    RawBookOrder,
    RawOrderBook,
    BookOrder,
    BookSides,
    PoolState,
    DepthSeries,
    DepthBuildInput,
    DepthBuildResult,
    PriceWindow,
    BookStats,
};

'use strict';

/**
 * LIQUIDITY CHART VIEW TRANSFORM (pure, shared by Node tests and the chart)
 *
 * The browser chart can show four combinations of price orientation and depth
 * asset. This function is the single source of truth for that transform; the
 * generated HTML embeds the exact same source via embedFunctionSources(), so
 * the Node tests exercise the code the chart actually runs.
 *
 *   orientation 'normal'   price = quote per base (B/A)
 *   orientation 'inverted' price = base per quote (A/B) = 1 / price
 *
 * Inversion swaps bid/ask roles: a bid for the old base is an ask for the new
 * base. `depthMode` selects the asset the cumulative depth is measured in,
 * relative to the current orientation ('quote' or 'base').
 *
 * The same transform carries the two spread bands the chart shades: the pool's
 * fee-adjusted edges and the book's best bid/ask. Inversion flips both, so the
 * bands stay on the correct sides instead of mirroring the wrong way round.
 */

import type { DepthSeries, PriceWindow } from './liquidity_depth_model.js';

interface DepthView {
    prices: number[];
    bookBid: number[];
    poolBid: number[];
    bookAsk: number[];
    poolAsk: number[];
    poolPrice: number | null;
    /** Fee-adjusted pool bid edge in the current price orientation. */
    poolBidPrice: number | null;
    /** Fee-adjusted pool ask edge in the current price orientation. */
    poolAskPrice: number | null;
    /** Best book bid (the low edge of the order-book spread band). */
    bookBidPrice: number | null;
    /** Best book ask (the high edge of the order-book spread band). */
    bookAskPrice: number | null;
    mid: number | null;
    min: number;
    max: number;
}

interface DepthViewOptions {
    orientation: 'normal' | 'inverted';
    depthMode: 'quote' | 'base';
    poolPrice: number | null;
    mid: number | null;
    window: PriceWindow;
    /** Best book bid/ask, so the book spread band follows the orientation. */
    bookBestBid?: number | null;
    bookBestAsk?: number | null;
}

function buildDepthView(series: DepthSeries, options: DepthViewOptions): DepthView {
    const useQuote = options.depthMode === 'quote';
    if (options.orientation === 'normal') {
        return {
            prices: series.prices,
            bookBid: useQuote ? series.bookBid : series.bookBidBase,
            poolBid: useQuote ? series.poolBid : series.poolBidBase,
            bookAsk: useQuote ? series.bookAsk : series.bookAskBase,
            poolAsk: useQuote ? series.poolAsk : series.poolAskBase,
            poolPrice: options.poolPrice,
            poolBidPrice: series.poolBidPrice,
            poolAskPrice: series.poolAskPrice,
            bookBidPrice: options.bookBestBid != null && options.bookBestBid > 0 ? options.bookBestBid : null,
            bookAskPrice: options.bookBestAsk != null && options.bookBestAsk > 0 ? options.bookBestAsk : null,
            mid: options.mid,
            min: options.window.min,
            max: options.window.max,
        };
    }

    const n = series.prices.length;
    const prices = new Array<number>(n);
    const bookBid = new Array<number>(n);
    const poolBid = new Array<number>(n);
    const bookAsk = new Array<number>(n);
    const poolAsk = new Array<number>(n);

    // 1/p reverses ordering, so walk the source backwards to keep the output
    // ascending (uPlot requires an ascending x axis).
    for (let out = 0, i = n - 1; i >= 0; i--, out++) {
        prices[out] = 1 / series.prices[i];
        bookBid[out] = useQuote ? series.bookAskBase[i] : series.bookAsk[i];
        poolBid[out] = useQuote ? series.poolAskBase[i] : series.poolAsk[i];
        bookAsk[out] = useQuote ? series.bookBidBase[i] : series.bookBid[i];
        poolAsk[out] = useQuote ? series.poolBidBase[i] : series.poolBid[i];
    }

    // Keep the market center visually centered: a linearly symmetric window in
    // normal price becomes an asymmetric window under 1/p, so rebuild the
    // inverted view as a symmetric window around the reciprocal center instead
    // of simply reciprocating the edges. The server samples a wider price range
    // (up to p0 / (1 - range)) so this window is fully covered by data.
    const span = options.window.max - options.window.min;
    const range = span / (options.window.max + options.window.min);
    const center = options.poolPrice != null ? options.poolPrice : options.mid;
    const qCenter = center != null && center > 0 ? 1 / center : 1 / ((options.window.min + options.window.max) / 2);
    const validRange = Number.isFinite(range) && range > 0 && range < 1;

    return {
        prices,
        bookBid,
        poolBid,
        bookAsk,
        poolAsk,
        poolPrice: options.poolPrice != null ? 1 / options.poolPrice : null,
        // Inversion swaps the sides, so the pool's bid edge becomes 1/askEdge.
        poolBidPrice: series.poolAskPrice != null ? 1 / series.poolAskPrice : null,
        poolAskPrice: series.poolBidPrice != null ? 1 / series.poolBidPrice : null,
        // The best book bid becomes the inverted market's best ask, and vice
        // versa, so the spread band survives an orientation flip intact.
        bookBidPrice: options.bookBestAsk != null && options.bookBestAsk > 0 ? 1 / options.bookBestAsk : null,
        bookAskPrice: options.bookBestBid != null && options.bookBestBid > 0 ? 1 / options.bookBestBid : null,
        mid: options.mid != null ? 1 / options.mid : null,
        min: validRange ? qCenter * (1 - range) : 1 / options.window.max,
        max: validRange ? qCenter * (1 + range) : 1 / options.window.min,
    };
}

export { buildDepthView };
export type { DepthView, DepthViewOptions };

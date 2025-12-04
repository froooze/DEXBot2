const { ORDER_TYPES, DEFAULT_CONFIG } = require('./constants');

// MIN_SPREAD_FACTOR constant (moved from constants.js)
const MIN_SPREAD_FACTOR = 2;

// Build the foundational grid of virtual orders based on increments, spread, and funds.
class OrderGridGenerator {
    static createOrderGrid(config) {
        // Compute helper arrays of buy/sell price levels relative to the market price.
        const { marketPrice, minPrice, maxPrice, incrementPercent } = config;
        // Use explicit step multipliers for clarity:
        const stepUp = 1 + (incrementPercent / 100);    // e.g. 1.02 for +2%
        const stepDown = 1 - (incrementPercent / 100);  // e.g. 0.98 for -2%
        
        // Ensure targetSpreadPercent is at least `minSpreadFactor * incrementPercent` to guarantee spread orders.
        // This implementation uses the constant MIN_SPREAD_FACTOR defined in this module.
        const spreadFactor = Number(MIN_SPREAD_FACTOR);
        const minSpreadPercent = incrementPercent * spreadFactor;
        const targetSpreadPercent = Math.max(config.targetSpreadPercent, minSpreadPercent);
        if (config.targetSpreadPercent < minSpreadPercent) {
            console.log(`[WARN] targetSpreadPercent (${config.targetSpreadPercent}%) is less than ${spreadFactor}*incrementPercent (${minSpreadPercent.toFixed(2)}%). ` +
                        `Auto-adjusting to ${minSpreadPercent.toFixed(2)}% to ensure spread orders are created.`);
        }
        
        // Calculate number of spread orders based on target spread vs increment
        // Ensure at least 2 spread orders (1 buy, 1 sell) to maintain a proper spread zone
        // Number of increments needed to cover the target spread using stepUp^n >= (1 + targetSpread)
        const calculatedNOrders = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(stepUp));
        const nOrders = Math.max(2, calculatedNOrders); // Minimum 2 spread orders

        const calculateLevels = (start, min) => {
            const levels = [];
            for (let current = start; current >= min; current *= stepDown) {
                levels.push(current);
            }
            return levels;
        };

        const sellLevels = calculateLevels(maxPrice, marketPrice);
        // Start the buy side one step below the last sell level (or marketPrice) using stepDown
        const buyStart = (sellLevels[sellLevels.length - 1] || marketPrice) * stepDown;
        const buyLevels = calculateLevels(buyStart, minPrice);

        const buySpread = Math.floor(nOrders / 2);
        const sellSpread = nOrders - buySpread;
        const initialSpreadCount = { buy: 0, sell: 0 };

        const sellOrders = sellLevels.map((price, i) => ({
            price,
            type: i >= sellLevels.length - sellSpread ? (initialSpreadCount.sell++, ORDER_TYPES.SPREAD) : ORDER_TYPES.SELL,
            id: `sell-${i}`,
            state: 'virtual'
        }));

        const buyOrders = buyLevels.map((price, i) => ({
            price,
            type: i < buySpread ? (initialSpreadCount.buy++, ORDER_TYPES.SPREAD) : ORDER_TYPES.BUY,
            id: `buy-${i}`,
            state: 'virtual'
        }));

        return { orders: [...sellOrders, ...buyOrders], initialSpreadCount };
    }

    // Distribute funds across the grid respecting weights and increment guidance.
    static calculateOrderSizes(orders, config, sellFunds, buyFunds, minSellSize = 0, minBuySize = 0) {
        const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
        const incrementFactor = incrementPercent / 100;

        // side: 'sell' or 'buy' - explicit instead of comparing weights
        // minSize: enforce a minimum human-unit size per order; allocations below
        // minSize are removed and their funds redistributed among remaining orders.
        const calculateSizes = (ordersForSide, weight, totalFunds, side, minSize) => {
            if (!Array.isArray(ordersForSide) || ordersForSide.length === 0) return [];
            const n = ordersForSide.length;
            // Validate totalFunds to avoid NaN propagation
            if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

            const reverse = (side === 'sell');
            const base = 1 - incrementFactor;
            // Precompute per-index raw weights
            const rawWeights = new Array(n);
            for (let i = 0; i < n; i++) {
                const idx = reverse ? (n - 1 - i) : i;
                rawWeights[i] = Math.pow(base, idx * weight);
            }

            // Compute sizes (single-pass). `remaining`/`fundsLeft` not needed
            // since we abort the whole allocation when a per-order minimum
            // cannot be satisfied.
            let sizes = new Array(n).fill(0);

            // Single-pass allocation. If no minSize is enforced, allocate once.
            // If minSize is enforced, perform the allocation and abort (return zeros)
            // when any allocated order would be below the minimum. This keeps
            // grid-generation simple and allows the caller to abort creating
            // the grid when the per-order minimum cannot be satisfied.
            if (!Number.isFinite(minSize) || minSize <= 0) {
                const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
            } else {
                const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
                // If any allocated size is below the minimum, try a fallback:
                // - If there are totalFunds available, retry the allocation without
                //   enforcing the per-order minimum (i.e. minSize=0).
                // - If totalFunds is zero or not finite, signal failure with
                //   a zero-filled array so the caller can decide how to proceed.
                const anyBelow = sizes.some(sz => sz < minSize - 1e-12);
                if (anyBelow) {
                    if (Number.isFinite(totalFunds) && totalFunds > 0) {
                        // Retry allocation without min-size (single-pass)
                        const fallbackTotalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                        for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / fallbackTotalWeight) * totalFunds;
                    } else {
                        return new Array(n).fill(0);
                    }
                }
            }

            // Note: intentionally not applying a residual correction here.
            // Small floating-point rounding differences are accepted and will
            // be handled at higher-level logic (e.g. when converting to
            // integer chain units) rather than by altering individual
            // allocation amounts here.

            return sizes;
        };

        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

        const sellSizes = calculateSizes(sellOrders, sellWeight, sellFunds, 'sell', minSellSize);
        const buySizes = calculateSizes(buyOrders, buyWeight, buyFunds, 'buy', minBuySize);

        const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
        return orders.map(order => ({
            ...order,
            size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
        }));
    }
}

module.exports = OrderGridGenerator;


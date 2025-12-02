const { ORDER_TYPES } = require('./constants');

class OrderGridGenerator {
    static createOrderGrid(config) {
        const { marketPrice, minPrice, maxPrice, incrementPercent, targetSpreadPercent } = config;
        const incrementFactor = 1 + (incrementPercent / 100);
        const nOrders = Math.ceil(Math.log((1 + (targetSpreadPercent / 100)) / incrementFactor) / Math.log(incrementFactor));

        const calculateLevels = (start, min) => {
            const levels = [];
            for (let current = start; current >= min; current /= incrementFactor) {
                levels.push(current);
            }
            return levels;
        };

        const sellLevels = calculateLevels(maxPrice, marketPrice);
        const buyLevels = calculateLevels((sellLevels[sellLevels.length - 1] || marketPrice) / incrementFactor, minPrice);

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

    static calculateOrderSizes(orders, config, sellFunds, buyFunds) {
        const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
        const incrementFactor = incrementPercent / 100;

        const calculateSizes = (orders, weight, totalFunds) => {
            if (orders.length === 0 || totalFunds <= 0) return new Array(orders.length).fill(0);

            const weights = orders.map((_, i) => Math.pow(1 - incrementFactor, (weight === sellWeight ? orders.length - 1 - i : i) * weight));
            const totalWeight = weights.reduce((sum, w) => sum + w, 0);
            return weights.map(w => w * (totalFunds / totalWeight));
        };

        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

        const sellSizes = calculateSizes(sellOrders, sellWeight, sellFunds);
        const buySizes = calculateSizes(buyOrders, buyWeight, buyFunds);

        const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
        return orders.map(order => ({
            ...order,
            size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
        }));
    }
}

module.exports = OrderGridGenerator;


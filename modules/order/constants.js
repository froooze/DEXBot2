/* Constants and default configuration for OrderManager */
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',
    ACTIVE: 'active',
    FILLED: 'filled'
});

const DEFAULT_CONFIG = {
    marketPrice: "pool",
    minPrice: "5x",
    maxPrice: "5x",
    incrementPercent: 1,
    targetSpreadPercent: 5,
    active: true,
    dryRun: false,
    assetA: null,
    assetB: null,
    weightDistribution: { sell: 1, buy: 1 },
    botFunds: { buy: "100%", sell: "100%" },
    activeOrders: { buy: 24, sell: 24 },
    minOrderSize: 1e-8
};

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG };


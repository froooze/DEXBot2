/* Constants and default configuration for OrderManager */
// Order categories used by the OrderManager when classifying grid entries.
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

// Life-cycle states assigned to generated or active orders.
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',
    ACTIVE: 'active',
    FILLED: 'filled'
});

// Defaults applied when instantiating an OrderManager with minimal configuration.
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
    weightDistribution: { sell: 0.5, buy: 0.5 },
    botFunds: { buy: "100%", sell: "100%" },
    activeOrders: { buy: 24, sell: 24 },
};

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG };


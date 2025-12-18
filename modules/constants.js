/**
 * Constants and default configuration for OrderManager
 * 
 * ORDER_TYPES: Categories for grid entries
 * - SELL: Orders above market price, size in base asset (assetA)
 * - BUY: Orders below market price, size in quote asset (assetB)
 * - SPREAD: Placeholder orders in the spread zone around market price
 * 
 * ORDER_STATES: Lifecycle states for orders (affects fund tracking)
 * - VIRTUAL: Not yet on-chain, size contributes to funds.virtuel (reserved)
 *            Also used for filled orders that are converted to SPREAD placeholders
 * - ACTIVE: Placed on-chain, size contributes to funds.committed
 */

// Order categories used by the OrderManager when classifying grid entries.
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

// Life-cycle states assigned to generated or active orders.
// State transitions affect fund calculations in manager.recalculateFunds()
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',   // Not on-chain, size in funds.virtuel; also used for fully filled orders converted to SPREAD
    ACTIVE: 'active',     // On-chain, size in funds.committed.grid (and .chain if has orderId)
    PARTIAL: 'partial'    // On-chain, partially filled order, size in funds.committed.grid (and .chain if has orderId)
});

// Defaults applied when instantiating an OrderManager with minimal configuration.
const DEFAULT_CONFIG = {
    marketPrice: "pool",
    minPrice: "4x",
    maxPrice: "4x",
    incrementPercent: 1,
    targetSpreadPercent: 3,
    active: true,
    dryRun: false,
    assetA: null,
    assetB: null,
    weightDistribution: { sell: 0.5, buy: 0.5 },
    // Order of keys changed: place sell first then buy for readability/consistency
    botFunds: { sell: "100%", buy: "100%" },
    activeOrders: { sell: 20, buy: 20 },
};

// Timing constants used by OrderManager and helpers
const TIMING = Object.freeze({
    SYNC_DELAY_MS: 500,
    ACCOUNT_TOTALS_TIMEOUT_MS: 10000,
    // Blockchain fetch interval: how often to refresh blockchain account values (in minutes)
    // Default: 120 minutes (2 hours). Set to 0 or non-number to disable periodic fetches.
    BLOCKCHAIN_FETCH_INTERVAL_MIN: 240
});

// Grid limits and scaling constants
const GRID_LIMITS = Object.freeze({
    MIN_SPREAD_FACTOR: 2,
    MIN_ORDER_SIZE_FACTOR: 50,
    // Grid regeneration threshold (percentage)
    // When (cacheFunds / total.grid) * 100 >= this percentage on one side, trigger Grid.updateGridOrderSizes() for that side
    // Checked independently for buy and sell sides
    // Example: If cacheFunds.buy = 100 and total.grid.buy = 1000, ratio = 10%
    // If threshold = 5%, then 10% >= 5% triggers update for buy side only
    GRID_REGENERATION_PERCENTAGE: 1,
    // Grid comparison metrics
    // Stores the normalized sum of squared relative differences between calculated and persisted grids
    // Used to detect significant divergence between in-memory grid and persisted state
    GRID_COMPARISON: Object.freeze({
        // Metric: sum of ((calculated - persisted) / persisted)^2 / count
        // Represents average squared relative error across non-spread orders
        SUMMED_RELATIVE_SQUARED_DIFFERENCE: 'summedRelativeSquaredDiff',

        // Divergence threshold for automatic grid regeneration (as promille)
        // 1 promille = 0.1% quadratic difference
        // When compareGrids() metric exceeds this value, updateGridOrderSizes will be triggered
        //
        // Threshold Reference Table (Average Real Order Error):
        // Formula: real_error = √(promille / 1000)
        // ┌──────────────────────────────────────────────────────────────┐
        // │ Promille │ Avg Error │ Description                           │
        // ├──────────────────────────────────────────────────────────────┤
        // │ 0.1      │ ~1.0%     │ Very strict (almost no drift allowed) │
        // │ 0.5      │ ~2.2%     │ Strict                                │
        // │ 1        │ ~3.2%     │ Default (balanced)                    │
        // │ 2        │ ~4.5%     │ Lenient                               │
        // │ 5        │ ~7.1%     │ Very lenient                          │
        // │ 10       │ ~10%      │ Extremely lenient                     │
        // └──────────────────────────────────────────────────────────────┘
        DIVERGENCE_THRESHOLD_Promille: 0.1
    })
});

// Logging Level Configuration
// Options:
// - 'debug': Verbose output including calculation details, API calls, and flow tracing.
// - 'info':  Standard production output. State changes (Active/Filled), keys confirmations, and errors.
// - 'warn':  Warnings (non-critical issues) and errors only.
// - 'error': Critical errors only.
const LOG_LEVEL = 'debug';

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL };


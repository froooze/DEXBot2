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
const fs = require('fs');
const path = require('path');

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
let DEFAULT_CONFIG = {
    startPrice: "pool",
    minPrice: "3x",
    maxPrice: "3x",
    incrementPercent: 0.5,
    targetSpreadPercent: 2,
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
let TIMING = {
    SYNC_DELAY_MS: 500,
    ACCOUNT_TOTALS_TIMEOUT_MS: 10000,
    // Blockchain fetch interval: how often to refresh blockchain account values (in minutes)
    // Default: 240 minutes (4 hours). Set to 0 or non-number to disable periodic fetches.
    BLOCKCHAIN_FETCH_INTERVAL_MIN: 240,

    // Fill processing timing
    FILL_DEDUPE_WINDOW_MS: 5000,    // 5 seconds - window for deduplicating same fill events
    FILL_CLEANUP_INTERVAL_MS: 10000, // 10 seconds - clean old fill records (2x dedup window)
    FILL_RECORD_RETENTION_MS: 3600000, // 1 hour - how long to keep persisted fill records

    // Order locking timing
    LOCK_TIMEOUT_MS: 30000  // 30 seconds - allows for blockchain transaction latency
};

// Grid limits and scaling constants
let GRID_LIMITS = {
    MIN_SPREAD_FACTOR: 2,
    MIN_ORDER_SIZE_FACTOR: 50,
    // Grid regeneration threshold (percentage)
    // When (cacheFunds / total.grid) * 100 >= this percentage on one side, trigger Grid.updateGridOrderSizes() for that side
    // Checked independently for buy and sell sides
    // Default: 3% (was 2%) — more conservative by default to reduce unnecessary churn
    // Example: If cacheFunds.buy = 100 and total.grid.buy = 1000, ratio = 10%
    // If threshold = 5%, then 10% >= 5% triggers update for buy side only
    GRID_REGENERATION_PERCENTAGE: 3,
    // Threshold for considering a partial order as "dust" relative to neighboring active orders.
    // If (partial.size / nearestActive.size) * 100 < PARTIAL_DUST_THRESHOLD_PERCENTAGE, it is marked for refill.
    // Default: 5 (5%)
    PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5,
    // Grid comparison metrics
    // Detects significant divergence between calculated (in-memory) and persisted grid state
    // after order fills and rotations
    GRID_COMPARISON: {
        // Metric calculation: RMS (Root Mean Square) of relative order size differences
        // Formula: RMS = √(mean of ((calculated - persisted) / persisted)²)
        // Represents the quadratic mean of relative size errors
        SUMMED_RELATIVE_SQUARED_DIFFERENCE: 'summedRelativeSquaredDiff',

        // Divergence threshold for automatic grid regeneration (RMS as percentage)
        // When compareGrids() metric exceeds this threshold, updateGridOrderSizes will be triggered
        //
        // RMS Threshold Reference Table (for 5% distribution: 5% outliers, 95% perfect):
        // ┌────────────────────────────────────────────────────────┐
        // │ RMS %       │ Avg Error │ Description                 │
        // ├────────────────────────────────────────────────────────┤
        // │ 4.5%        │ ~1.0%     │ Very strict                 │
        // │ 9.8%        │ ~2.2%     │ Strict                      │
        // │ 14.3%       │ ~3.2%     │ Default (balanced)          │
        // │ 20.1%       │ ~4.5%     │ Lenient                     │
        // │ 31.7%       │ ~7.1%     │ Very lenient                │
        // │ 44.7%       │ ~10%      │ Extremely lenient           │
        // └────────────────────────────────────────────────────────┘
        RMS_PERCENTAGE: 14.3
    }
};

// Logging Level Configuration
// Options:
// - 'debug': Verbose output including calculation details, API calls, and flow tracing.
// - 'info':  Standard production output. State changes (Active/Filled), keys confirmations, and errors.
// - 'warn':  Warnings (non-critical issues) and errors only.
// - 'error': Critical errors only.
let LOG_LEVEL = 'info';

// --- LOCAL SETTINGS OVERRIDES ---
// Load user-defined settings from profiles/general.settings.json if it exists.
// This allows preserving settings during updates without git stashing.
const SETTINGS_FILE = path.join(__dirname, '..', 'profiles', 'general.settings.json');

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(raw);

        if (settings.LOG_LEVEL) LOG_LEVEL = settings.LOG_LEVEL;
        
        if (settings.TIMING) {
            TIMING = { ...TIMING, ...settings.TIMING };
        }
        
        if (settings.GRID_LIMITS) {
            const gridSettings = settings.GRID_LIMITS;
            GRID_LIMITS = { 
                ...GRID_LIMITS, 
                ...gridSettings,
                GRID_COMPARISON: { ...GRID_LIMITS.GRID_COMPARISON, ...(gridSettings.GRID_COMPARISON || {}) }
            };
        }

        if (settings.DEFAULT_CONFIG) {
            DEFAULT_CONFIG = { ...DEFAULT_CONFIG, ...settings.DEFAULT_CONFIG };
        }
    } catch (err) {
        console.warn(`[WARN] Failed to load local settings from ${SETTINGS_FILE}: ${err.message}`);
    }
}

// Freeze objects to prevent accidental runtime modifications
Object.freeze(ORDER_TYPES);
Object.freeze(ORDER_STATES);
Object.freeze(TIMING);
Object.freeze(GRID_LIMITS);
Object.freeze(GRID_LIMITS.GRID_COMPARISON);

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL };

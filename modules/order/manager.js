/**
 * OrderManager - Core grid-based order management system for DEXBot2
 * 
 * This module is responsible for:
 * - Creating and maintaining a virtual order grid across a price range
 * - Tracking order states (VIRTUAL -> ACTIVE -> back to VIRTUAL/SPREAD when filled)
 * - Synchronizing grid state with on-chain orders
 * - Managing funds allocation and commitment tracking
 * - Processing fills and rebalancing the grid
 * 
 * The order grid spans from minPrice to maxPrice with orders placed at
 * regular incrementPercent intervals. Orders near the market price form
 * the "spread" zone. When orders are filled, new orders are created on
 * the opposite side to maintain grid coverage.
 * 
 * FUND CALCULATION MODEL:
 * The manager tracks funds using a dual-source model (chain + grid):
 * 
 * Source data:
 * - chainFree (accountTotals.buyFree/sellFree): Free balance on chain (not locked in orders)
 * - virtuel: Sum of VIRTUAL order sizes (grid positions not yet placed on-chain)
 * - committed.grid: Sum of ACTIVE order sizes (internal grid tracking)
 * - committed.chain: Sum of ACTIVE orders that have an orderId (confirmed on-chain)
 * - pendingProceeds: Temporary proceeds from fills awaiting rotation consumption
 * 
 * Calculated values:
 * - available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
 * - total.chain = chainFree + committed.chain
 * - total.grid = committed.grid + virtuel
 * 
 * Fund flow lifecycle:
 * 1. Startup: chainFree fetched from chain, virtuel = sum of grid VIRTUAL orders
 * 2. Order placement (VIRTUAL → ACTIVE): virtuel decreases, committed increases
 * 3. Order fill: pendingProceeds set with fill value, available increases temporarily
 * 4. After rotation: pendingProceeds cleared as funds are consumed by new orders
 */
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL } = require('../constants');
const { parsePercentageString, blockchainToFloat, floatToBlockchainInt, resolveRelativePrice, calculatePriceTolerance, checkPriceWithinTolerance, parseChainOrder, findMatchingGridOrderByOpenOrder, findMatchingGridOrderByHistory, applyChainSizeToGridOrder, correctOrderPriceOnChain, getMinOrderSize, getAssetFees } = require('./utils');
const Logger = require('./logger');
// Grid functions (initialize/recalculate) are intended to be
// called directly via require('./grid').initializeGrid(manager) by callers.

// Constants for manager operations are provided by modules/constants.js
// Size comparisons are performed by converting human-readable floats
// to blockchain integer amounts using floatToBlockchainInt(...) and
// comparing integers. This provides exact, deterministic behavior that
// matches on-chain granularity and avoids arbitrary tolerances.
// MIN_ORDER_SIZE_FACTOR and MIN_SPREAD_FACTOR are defined in modules/constants.js
// and exposed via GRID_LIMITS (e.g. GRID_LIMITS.MIN_ORDER_SIZE_FACTOR)

/**
 * OrderManager class - manages grid-based trading strategy
 * 
 * Key concepts:
 * - Virtual orders: Grid positions not yet placed on-chain (reserved in virtuel)
 * - Active orders: Orders placed on blockchain (tracked in committed.grid/chain)
 * - Filled orders: Orders that have been fully executed (converted to VIRTUAL/SPREAD placeholders)
 * - Spread orders: Placeholder orders in the zone around market price
 * 
 * Funds structure (this.funds):
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ available    = max(0, chainFree - virtuel - cacheFunds                │
 * │                     - btsFeesOwed) + pendingProceeds                   │
 * │               Free funds that can be used for new orders or rotations  │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ total.chain  = chainFree + committed.chain                             │
 * │               Total on-chain balance (free + locked in orders)         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ total.grid   = committed.grid + virtuel                                │
 * │               Total grid allocation (active + virtual orders)          │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ virtuel      = Sum of VIRTUAL order sizes                              │
 * │               Reserved funds for grid positions not yet on-chain       │
 * │               (alias: reserved for backwards compatibility)            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ committed.grid  = Sum of ACTIVE order sizes (internal tracking)        │
 * │ committed.chain = Sum of ACTIVE orders with orderId (on-chain)         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ pendingProceeds = Temporary fill proceeds awaiting rotation            │
 * │                   Cleared after rotation consumes the funds            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ cacheFunds   = Leftover funds from rotation sizing (below precision)   │
 * │               Persisted per-bot for consistent grid rebuilding         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ btsFeesOwed  = BTS blockchain fees from filled orders                  │
 * │               Only tracked if BTS is in the trading pair               │
 * └─────────────────────────────────────────────────────────────────────────┘
 * 
 * Fund lifecycle:
 * 1. Startup: chainFree from chain, virtuel from grid VIRTUAL orders
 * 2. Order placement (VIRTUAL → ACTIVE): virtuel↓, committed↑
 * 3. Order fill: pendingProceeds set, available↑ temporarily
 * 4. Rotation complete: pendingProceeds cleared, funds consumed
 * 
 * Price tolerance:
 * - Chain orders may have slightly different prices due to integer rounding
 * - Tolerance is calculated based on asset precisions and order sizes
 * - Orders within tolerance are considered matching
 * 
 * @class
 */
class OrderManager {
    /**
     * Create a new OrderManager instance
     * @param {Object} config - Bot configuration
     * @param {string|number} config.marketPrice - Center price or 'pool'/'market' for auto-derive
     * @param {string|number} config.minPrice - Lower bound (number or '5x' relative)
     * @param {string|number} config.maxPrice - Upper bound (number or '5x' relative)
     * @param {number} config.incrementPercent - Price step between orders (e.g., 1 for 1%)
     * @param {number} config.targetSpreadPercent - Target spread width percentage
     * @param {Object} config.botFunds - Funds allocation { buy: amount/'%', sell: amount/'%' }
     * @param {Object} config.activeOrders - Max active orders { buy: n, sell: n }
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        this.logger = new Logger(LOG_LEVEL);
        this.logger.marketName = this.marketName;
        this.orders = new Map();
        // Indices for fast lookup by state and type (optimization)
        this._ordersByState = {
            [ORDER_STATES.VIRTUAL]: new Set(),
            [ORDER_STATES.ACTIVE]: new Set(),
            [ORDER_STATES.PARTIAL]: new Set()
        };
        this._ordersByType = {
            [ORDER_TYPES.BUY]: new Set(),
            [ORDER_TYPES.SELL]: new Set(),
            [ORDER_TYPES.SPREAD]: new Set()
        };
        this.resetFunds();
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = false;
        this.assets = null; // To be populated in initializeGrid
        // Promise that resolves when accountTotals (both buy & sell) are populated.
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        // Orders that need price correction on blockchain (orderId matched but price outside tolerance)
        this.ordersNeedingPriceCorrection = [];
        // Track recently rotated orderIds to prevent double-rotation (cleared after successful rotation)
        this._recentlyRotatedOrderIds = new Set();
    }

    // Helper: Resolve config value (percentage, number, or string)
    _resolveConfigValue(value, total) {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const p = parsePercentageString(value);
            if (p !== null) {
                if (total === null || total === undefined) {
                    this.logger?.log(`Cannot resolve percentage-based botFunds '${value}' because account total is not set. Attempting on-chain lookup (will default to 0 while fetching).`, 'warn');
                    // Kick off an async fetch of account balances if possible; do not block here.
                    if (!this._isFetchingTotals) {
                        this._isFetchingTotals = true;
                        this._fetchAccountBalancesAndSetTotals().finally(() => { this._isFetchingTotals = false; });
                    }
                    return 0;
                }
                return total * p;
            }
            const n = parseFloat(value);
            return Number.isNaN(n) ? 0 : n;
        }
        return 0;
    }

    _computeChainFundTotals() {
        const chainFreeBuy = Number.isFinite(Number(this.accountTotals?.buyFree)) ? Number(this.accountTotals.buyFree) : 0;
        const chainFreeSell = Number.isFinite(Number(this.accountTotals?.sellFree)) ? Number(this.accountTotals.sellFree) : 0;
        const committedChainBuy = Number(this.funds?.committed?.chain?.buy) || 0;
        const committedChainSell = Number(this.funds?.committed?.chain?.sell) || 0;

        const freePlusLockedBuy = chainFreeBuy + committedChainBuy;
        const freePlusLockedSell = chainFreeSell + committedChainSell;

        // Prefer accountTotals.buy/sell (free + locked in open orders) when available, but ensure
        // we don't regress to free-only by treating totals as at least (free + locked).
        const chainTotalBuy = Number.isFinite(Number(this.accountTotals?.buy))
            ? Math.max(Number(this.accountTotals.buy), freePlusLockedBuy)
            : freePlusLockedBuy;
        const chainTotalSell = Number.isFinite(Number(this.accountTotals?.sell))
            ? Math.max(Number(this.accountTotals.sell), freePlusLockedSell)
            : freePlusLockedSell;

        return {
            chainFreeBuy,
            chainFreeSell,
            committedChainBuy,
            committedChainSell,
            freePlusLockedBuy,
            freePlusLockedSell,
            chainTotalBuy,
            chainTotalSell
        };
    }

    getChainFundsSnapshot() {
        const totals = this._computeChainFundTotals();
        const allocatedBuy = Number.isFinite(Number(this.funds?.allocated?.buy)) ? Number(this.funds.allocated.buy) : totals.chainTotalBuy;
        const allocatedSell = Number.isFinite(Number(this.funds?.allocated?.sell)) ? Number(this.funds.allocated.sell) : totals.chainTotalSell;
        return {
            ...totals,
            allocatedBuy,
            allocatedSell
        };
    }

    /**
     * Apply botFunds allocation constraints to available funds.
     * Called at grid initialization to respect percentage-based botFunds when multiple bots share an account.
     *
     * This ensures:
     * - Bot1 with botFunds.buy="90%" gets 90% of chainFree (what's free on-chain)
     * - Bot2 with botFunds.buy="10%" gets 10% of remaining chainFree
     *
     * During trading, available funds are recalculated normally without this constraint
     * (available = chainFree - virtuel + pendingProceeds)
     */
    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;

        const { chainTotalBuy, chainTotalSell } = this._computeChainFundTotals();

        const allocatedBuy = this._resolveConfigValue(this.config.botFunds.buy, chainTotalBuy);
        const allocatedSell = this._resolveConfigValue(this.config.botFunds.sell, chainTotalSell);

        // Deduct BTS creation fees if BTS is in the trading pair
        let btsFeesForCreation = 0;
        const assetA = this.config.assetA;
        const assetB = this.config.assetB;
        const hasBtsPair = (assetA === 'BTS' || assetB === 'BTS');

        if (hasBtsPair) {
            try {
                const { getAssetFees } = require('./utils');
                const targetBuy = Math.max(0, Number.isFinite(Number(this.config.activeOrders?.buy)) ? Number(this.config.activeOrders.buy) : 1);
                const targetSell = Math.max(0, Number.isFinite(Number(this.config.activeOrders?.sell)) ? Number(this.config.activeOrders.sell) : 1);
                const totalOrdersToCreate = targetBuy + targetSell;

                if (totalOrdersToCreate > 0) {
                    const btsFeeData = getAssetFees('BTS', 1);
                    btsFeesForCreation = btsFeeData.createFee * totalOrdersToCreate;
                }
            } catch (err) {
                this.logger?.log?.(`Warning: Could not calculate BTS creation fees in applyBotFundsAllocation: ${err.message}`, 'warn');
            }
        }

        // Note: BTS fee deduction happens in Grid.updateGridOrderSizesForSide() during actual sizing
        // Do not deduct fees here to avoid double-counting
        let finalAllocatedBuy = allocatedBuy;
        let finalAllocatedSell = allocatedSell;

        // Expose allocation for grid sizing (and diagnostics)
        this.funds.allocated = { buy: finalAllocatedBuy, sell: finalAllocatedSell };

        // Cap available to not exceed allocation
        if (finalAllocatedBuy > 0) {
            this.funds.available.buy = Math.min(this.funds.available.buy, finalAllocatedBuy);
        }
        if (finalAllocatedSell > 0) {
            this.funds.available.sell = Math.min(this.funds.available.sell, finalAllocatedSell);
        }

        this.logger?.log(
            `Applied botFunds allocation (based on total): buy=${finalAllocatedBuy.toFixed(8)} (total=${chainTotalBuy.toFixed(8)}, available=${this.funds.available.buy.toFixed(8)}), ` +
            `sell=${finalAllocatedSell.toFixed(8)} (total=${chainTotalSell.toFixed(8)}, available=${this.funds.available.sell.toFixed(8)})`,
            'info'
        );
    }

    /**
     * Central calculation for available funds.
     * Formula: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
     *
     * @param {string} side - 'buy' or 'sell'
     * @returns {number} Available funds for the given side
     */
    calculateAvailableFunds(side) {
        if (!side || (side !== 'buy' && side !== 'sell')) return 0;

        const chainFree = side === 'buy' ? (this.accountTotals?.buyFree || 0) : (this.accountTotals?.sellFree || 0);
        const virtuel = side === 'buy' ? (this.funds.virtuel?.buy || 0) : (this.funds.virtuel?.sell || 0);
        const cacheFunds = side === 'buy' ? (this.funds.cacheFunds?.buy || 0) : (this.funds.cacheFunds?.sell || 0);
        const pending = side === 'buy' ? (this.funds.pendingProceeds?.buy || 0) : (this.funds.pendingProceeds?.sell || 0);
        const btsFeesOwed = this.funds.btsFeesOwed || 0;

        return Math.max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pending;
    }

    /**
     * Recalculate all fund values based on current order states.
     *
     * This method iterates all orders and computes:
     * - committed.grid: Sum of ACTIVE order sizes (internal tracking)
     * - committed.chain: Sum of ACTIVE orders with orderId (confirmed on-chain)
     * - virtuel: Sum of VIRTUAL order sizes (reserved for future placement)
     *
     * Then calculates derived values:
     * - available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
     * - total.chain = chainFree + committed.chain
     * - total.grid = committed.grid + virtuel
     *
     * Called automatically by _updateOrder() whenever order state changes.
     */
    recalculateFunds() {
        if (!this.funds) this.resetFunds();

        let gridBuy = 0, gridSell = 0;
        let chainBuy = 0, chainSell = 0;
        let virtuelBuy = 0, virtuelSell = 0;

        for (const order of this.orders.values()) {
            const size = Number(order.size) || 0;
            if (size <= 0) continue;

            if (order.type === ORDER_TYPES.BUY) {
                if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) {
                    gridBuy += size;
                    if (order.orderId) chainBuy += size;
                } else if (order.state === ORDER_STATES.VIRTUAL) {
                    virtuelBuy += size;
                }
            } else if (order.type === ORDER_TYPES.SELL) {
                if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) {
                    gridSell += size;
                    if (order.orderId) chainSell += size;
                } else if (order.state === ORDER_STATES.VIRTUAL) {
                    virtuelSell += size;
                }
            }
        }

        // Get chain free balances (stored via setAccountTotals)
        const chainFreeBuy = this.accountTotals?.buyFree || 0;
        const chainFreeSell = this.accountTotals?.sellFree || 0;

        // Set committed
        this.funds.committed.grid = { buy: gridBuy, sell: gridSell };
        this.funds.committed.chain = { buy: chainBuy, sell: chainSell };

        // Set virtuel (virtual orders) - alias: reserved
        this.funds.virtuel = { buy: virtuelBuy, sell: virtuelSell };
        this.funds.reserved = this.funds.virtuel; // backwards compat alias

        // Set totals
        // Prefer on-chain totals (free + locked in open orders) when available.
        // Fallback to inferred totals based on grid orders that have an orderId.
        const inferredChainTotalBuy = chainFreeBuy + chainBuy;
        const inferredChainTotalSell = chainFreeSell + chainSell;
        const onChainTotalBuy = Number.isFinite(Number(this.accountTotals?.buy)) ? Number(this.accountTotals.buy) : null;
        const onChainTotalSell = Number.isFinite(Number(this.accountTotals?.sell)) ? Number(this.accountTotals.sell) : null;
        this.funds.total.chain = {
            buy: onChainTotalBuy !== null ? Math.max(onChainTotalBuy, inferredChainTotalBuy) : inferredChainTotalBuy,
            sell: onChainTotalSell !== null ? Math.max(onChainTotalSell, inferredChainTotalSell) : inferredChainTotalSell
        };
        this.funds.total.grid = { buy: gridBuy + virtuelBuy, sell: gridSell + virtuelSell };

        // Set available using centralized calculation function
        // Formula: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
        this.funds.available.buy = this.calculateAvailableFunds('buy');
        this.funds.available.sell = this.calculateAvailableFunds('sell');
    }

    _updateOrder(order) {
        const existing = this.orders.get(order.id);
        if (existing) {
            this._ordersByState[existing.state]?.delete(order.id);
            this._ordersByType[existing.type]?.delete(order.id);
        }
        this._ordersByState[order.state]?.add(order.id);
        this._ordersByType[order.type]?.add(order.id);
        this.orders.set(order.id, order);
        this.recalculateFunds(); // Sync funds whenever order state/size changes
    }

    _logAvailable(label = '') {
        if (!this.logger) return;
        const avail = this.funds?.available || { buy: 0, sell: 0 };
        const pend = this.funds?.pendingProceeds || { buy: 0, sell: 0 };
        this.logger.log(
            `Available${label ? ' [' + label + ']' : ''}: buy=${(avail.buy || 0).toFixed(8)}, sell=${(avail.sell || 0).toFixed(8)}, pendingProceeds buy=${(pend.buy || 0).toFixed(8)}, sell=${(pend.sell || 0).toFixed(8)}`,
            'info'
        );
    }

    // Adjust funds for partial fills detected via size deltas (applied before _updateOrder recalc)
    _adjustFunds(gridOrder, deltaSize) {
        if (!gridOrder || !Number.isFinite(deltaSize)) return;
        if (deltaSize >= 0) return; // only react to size decreases (fills)

        const fillSize = Math.abs(deltaSize);
        const price = Number(gridOrder.price || 0);
        if (fillSize <= 0 || price <= 0) return;

        if (!this.funds) this.resetFunds();
        if (!this.accountTotals) {
            this.accountTotals = { buy: 0, sell: 0, buyFree: 0, sellFree: 0 };
        }

        const bumpTotal = (key, delta) => {
            const next = (Number(this.accountTotals[key]) || 0) + delta;
            this.accountTotals[key] = next < 0 ? 0 : next;
        };

        // Partial proceeds: ONLY update chain totals/free, NOT pendingProceeds
        // (pendingProceeds will be calculated once by processFilledOrders to avoid double-counting)
        if (gridOrder.type === ORDER_TYPES.SELL) {
            // SELL partial: receive quote asset; free balance rises, base total drops
            const proceeds = fillSize * price;
            bumpTotal('buyFree', proceeds);
            bumpTotal('buy', proceeds);
            bumpTotal('sell', -fillSize);
            this.recalculateFunds();
            // Note: Don't log available here - proceeds not yet added to pendingProceeds
            // They will be added later by processFilledOrders()
        } else if (gridOrder.type === ORDER_TYPES.BUY) {
            // BUY partial: receive base asset; free base rises, quote total drops
            const proceeds = fillSize / price;
            bumpTotal('sellFree', proceeds);
            bumpTotal('sell', proceeds);
            bumpTotal('buy', -fillSize);
            this.recalculateFunds();
            // Note: Don't log available here - proceeds not yet added to pendingProceeds
            // They will be added later by processFilledOrders()
        }
    }

    // Note: findBestMatchByPrice is available from utils; callers should pass
    // a tolerance function that includes the manager's assets, for example:
    // utils.findBestMatchByPrice(chainOrder, candidates, this.orders, (p,s,t) => calculatePriceTolerance(p,s,t,this.assets))

    // NOTE: _calcTolerance shim removed — callers should call
    // calculatePriceTolerance(gridPrice, orderSize, orderType, this.assets)

    /**
     * Initialize the funds structure with zeroed values.
     * Sets up accountTotals (buyFree/sellFree from chain) and the funds object
     * with available, total, virtuel, committed, and pendingProceeds.
     */
    resetFunds() {
        this.accountTotals = this.accountTotals || (this.config.accountTotals ? { ...this.config.accountTotals } : { buy: null, sell: null, buyFree: null, sellFree: null });

        this.funds = {
            available: { buy: 0, sell: 0 },
            total: {
                chain: { buy: 0, sell: 0 },
                grid: { buy: 0, sell: 0 }
            },
            virtuel: { buy: 0, sell: 0 },
            reserved: { buy: 0, sell: 0 }, // backwards compat alias
            committed: {
                grid: { buy: 0, sell: 0 },
                chain: { buy: 0, sell: 0 }
            },
            pendingProceeds: { buy: 0, sell: 0 },  // Proceeds from fills awaiting rotation
            cacheFunds: { buy: 0, sell: 0 },     // Leftover funds from rotation sizing (below precision threshold)
            btsFeesOwed: 0  // BTS blockchain fees from filled orders (only if BTS is in pair)
        };
        // Make reserved an alias for virtuel
        this.funds.reserved = this.funds.virtuel;
    }

    /**
     * Update on-chain balance information and recalculate funds.
     * Called when fetching balances from blockchain or after order changes.
     * 
     * @param {Object} totals - Balance information from chain
     * @param {number|null} totals.buy - Total buy asset balance (free + locked)
     * @param {number|null} totals.sell - Total sell asset balance (free + locked)
     * @param {number|null} totals.buyFree - Free buy asset balance (not in orders)
     * @param {number|null} totals.sellFree - Free sell asset balance (not in orders)
     */
    setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        this.accountTotals = { ...this.accountTotals, ...totals };

        if (!this.funds) this.resetFunds();

        // Recalculate with new chain data
        this.recalculateFunds();

        // If someone is waiting for account totals, resolve the waiter once both values are available.
        const haveBuy = this.accountTotals && this.accountTotals.buyFree !== null && this.accountTotals.buyFree !== undefined && Number.isFinite(Number(this.accountTotals.buyFree));
        const haveSell = this.accountTotals && this.accountTotals.sellFree !== null && this.accountTotals.sellFree !== undefined && Number.isFinite(Number(this.accountTotals.sellFree));
        if (haveBuy && haveSell && typeof this._accountTotalsResolve === 'function') {
            try { this._accountTotalsResolve(); } catch (e) { /* ignore */ }
            this._accountTotalsPromise = null; this._accountTotalsResolve = null;
        }
    }

    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        const haveBuy = this.accountTotals && this.accountTotals.buy !== null && this.accountTotals.buy !== undefined && Number.isFinite(Number(this.accountTotals.buy));
        const haveSell = this.accountTotals && this.accountTotals.sell !== null && this.accountTotals.sell !== undefined && Number.isFinite(Number(this.accountTotals.sell));
        if (haveBuy && haveSell) return; // already satisfied

        if (!this._accountTotalsPromise) {
            this._accountTotalsPromise = new Promise((resolve) => { this._accountTotalsResolve = resolve; });
        }

        await Promise.race([
            this._accountTotalsPromise,
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
    }

    async _fetchAccountBalancesAndSetTotals() {
        // Attempt to read balances from the chain for configured account.
        try {
            const { BitShares } = require('../bitshares_client');
            if (!BitShares || !BitShares.db) return;

            // We need an account id or name to query
            const accountIdOrName = this.accountId || this.account || null;
            if (!accountIdOrName) return;

            // Ensure assets are initialized so we have ids/precisions
            try { await this._initializeAssets(); } catch (err) { /* best-effort */ }
            const assetAId = this.assets && this.assets.assetA && this.assets.assetA.id;
            const assetBId = this.assets && this.assets.assetB && this.assets.assetB.id;
            const precisionA = this.assets && this.assets.assetA && this.assets.assetA.precision;
            const precisionB = this.assets && this.assets.assetB && this.assets.assetB.precision;

            if (!assetAId || !assetBId) return;

            // Use centralized helper to fetch on-chain balances for the two configured assets
            try {
                const { getOnChainAssetBalances } = require('../chain_orders');
                const lookup = await getOnChainAssetBalances(accountIdOrName, [assetAId, assetBId]);
                const aInfo = lookup && (lookup[assetAId] || lookup[this.config.assetA]);
                const bInfo = lookup && (lookup[assetBId] || lookup[this.config.assetB]);
                // Total = free + locked (in orders)
                const sellTotal = aInfo && typeof aInfo.total === 'number' ? aInfo.total : null;
                const buyTotal = bInfo && typeof bInfo.total === 'number' ? bInfo.total : null;
                // Free = available balance not in orders
                const sellFree = aInfo && typeof aInfo.free === 'number' ? aInfo.free : sellTotal;
                const buyFree = bInfo && typeof bInfo.free === 'number' ? bInfo.free : buyTotal;
                this.logger && this.logger.log && this.logger.log('Fetched on-chain balances for accountTotals (via helper)', 'info');
                this.setAccountTotals({ buy: buyTotal, sell: sellTotal, buyFree, sellFree });
            } catch (err) {
                // fall back to raw chain query in the unlikely event helper fails
                const full = await BitShares.db.get_full_accounts([accountIdOrName], false);
                if (!full || !Array.isArray(full) || !full[0]) return;
                const accountData = full[0][1];
                const balances = accountData && accountData.balances ? accountData.balances : [];

                const findBalanceInt = (assetId) => {
                    const b = balances.find(x => x.asset_type === assetId || x.asset_type === assetId.toString());
                    return b ? Number(b.balance || b.amount || 0) : 0;
                };

                const rawSell = findBalanceInt(assetAId);
                const rawBuy = findBalanceInt(assetBId);

                const buyTotal = Number.isFinite(Number(rawBuy)) ? blockchainToFloat(rawBuy, precisionB !== undefined ? precisionB : 8) : null;
                const sellTotal = Number.isFinite(Number(rawSell)) ? blockchainToFloat(rawSell, precisionA !== undefined ? precisionA : 8) : null;

                // In fallback mode, balance IS the free amount (no order breakdown available)
                this.logger && this.logger.log && this.logger.log('Fetched on-chain balances for accountTotals (fallback raw)', 'info');
                this.setAccountTotals({ buy: buyTotal, sell: sellTotal, buyFree: buyTotal, sellFree: sellTotal });
            }
        } catch (err) {
            this.logger && this.logger.log && this.logger.log(`Failed to fetch on-chain balances: ${err && err.message ? err.message : err}`, 'warn');
        }
    }

    async _initializeAssets() {
        if (this.assets) return; // Already initialized
        try {
            const { lookupAsset } = require('./utils');
            const { BitShares } = require('../bitshares_client');
            this.assets = {
                assetA: await lookupAsset(BitShares, this.config.assetA),
                assetB: await lookupAsset(BitShares, this.config.assetB)
            };
            if (!this.assets.assetA || !this.assets.assetB) {
                throw new Error(`Could not resolve assets ${this.config.assetA}/${this.config.assetB}`);
            }
        } catch (err) {
            this.logger.log(`Asset metadata lookup failed: ${err.message}`, 'error');
            throw err;
        }
    }

    /**
     * Sync grid orders from fresh blockchain open orders after a fill event.
     * This is the preferred way to handle fills:
     * 1. Fetch current open orders from blockchain
     * 2. Match grid orders to chain orders by orderId
     * 3. Check if price difference is within tolerance (based on asset precision)
     * 4. If orderId matches but price outside tolerance, flag for correction
     * 5. If orderId not found but price matches, update orderId (never update price)
     * 6. Update sizes from blockchain for_sale values
     * 7. Convert to VIRTUAL/SPREAD if they no longer exist on chain (filled)
     * 
     * @param {Array} chainOrders - Array of open orders from blockchain
     * @param {Object} fillInfo - Optional fill event info for logging (pays/receives amounts)
     * @returns {Object} - { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] }
     */
    syncFromOpenOrders(chainOrders, fillInfo = null) {
        if (!Array.isArray(chainOrders) || chainOrders.length === 0) {
            this.logger.log('syncFromOpenOrders: No valid chain orders provided', 'debug');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        this.logger.log(`syncFromOpenOrders: Processing ${chainOrders.length} open orders from blockchain`, 'debug');

        // DEBUG: Check assets
        if (this.assets) {
            this.logger.log(`DEBUG: Assets loaded: A=${this.assets.assetA?.symbol}(${this.assets.assetA?.id}), B=${this.assets.assetB?.symbol}(${this.assets.assetB?.id})`, 'debug');
        } else {
            this.logger.log(`DEBUG: ERROR - this.assets is missing!`, 'error');
        }

        // Cache asset precisions for hot paths
        const assetAPrecision = this.assets?.assetA?.precision;
        const assetBPrecision = this.assets?.assetB?.precision;

        // Parse all chain orders
        const parsedChainOrders = new Map();
        const rawChainOrders = new Map(); // Keep raw orders for correction
        let debugLogged = false;
        for (const chainOrder of chainOrders) {
            if (!debugLogged) {
                this.logger.log(`DEBUG: First chain order raw: ${JSON.stringify(chainOrder)}`, 'info');
                debugLogged = true;
            }
            const parsed = parseChainOrder(chainOrder, this.assets);
            if (parsed) {
                parsedChainOrders.set(parsed.orderId, parsed);
                rawChainOrders.set(parsed.orderId, chainOrder);
            } else {
                this.logger.log(`DEBUG: Failed to parse chain order ${chainOrder.id}`, 'warn');
            }
        }
        this.logger.log(`DEBUG: Parsed ${parsedChainOrders.size} valid chain orders.`, 'debug');

        const filledOrders = [];
        const updatedOrders = [];
        const ordersNeedingCorrection = [];
        const chainOrderIdsOnGrid = new Set();

        // Clear previous correction list
        this.ordersNeedingPriceCorrection = [];

        // First pass: Match by orderId and check price tolerance
        for (const gridOrder of this.orders.values()) {
            // allow matching virtual orders if they have an ID (e.g. loaded from persistence)
            if (!gridOrder.orderId) continue;

            const chainOrder = parsedChainOrders.get(gridOrder.orderId);

            if (chainOrder) {
                // Order still exists on chain - check price tolerance
                // Mark as ACTIVE now that we confirmed it's on chain
                gridOrder.state = ORDER_STATES.ACTIVE;

                const toleranceCheck = checkPriceWithinTolerance(gridOrder, chainOrder, this.assets);

                if (!toleranceCheck.isWithinTolerance) {
                    // Price difference exceeds tolerance - need to correct order on blockchain
                    this.logger.log(
                        `Order ${gridOrder.id} (${gridOrder.orderId}): PRICE MISMATCH - ` +
                        `grid=${toleranceCheck.gridPrice.toFixed(8)}, chain=${toleranceCheck.chainPrice.toFixed(8)}, ` +
                        `diff=${toleranceCheck.priceDiff.toFixed(8)}, tolerance=${toleranceCheck.tolerance.toFixed(8)}. ` +
                        `Flagging for correction.`,
                        'warn'
                    );

                    const correctionInfo = {
                        gridOrder: { ...gridOrder },
                        chainOrderId: gridOrder.orderId,
                        rawChainOrder: rawChainOrders.get(gridOrder.orderId),
                        expectedPrice: gridOrder.price,
                        actualPrice: chainOrder.price,
                        size: chainOrder.size || gridOrder.size,
                        type: gridOrder.type
                    };
                    ordersNeedingCorrection.push(correctionInfo);
                    this.ordersNeedingPriceCorrection.push(correctionInfo);
                    chainOrderIdsOnGrid.add(gridOrder.orderId);
                    // Don't update size yet - will be updated after correction
                    continue;
                }

                // Price within tolerance - update size if different
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                const oldSize = Number(gridOrder.size || 0);
                const newSize = Number(chainOrder.size || 0);

                // Compare using asset precision so we only treat on-chain-significant
                // size changes as different. Use the order-type to pick precision.
                const precision = (gridOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                // Use integer equality to detect chain-significant size changes
                const oldInt = floatToBlockchainInt(oldSize, precision);
                const newInt = floatToBlockchainInt(newSize, precision);
                if (oldInt !== newInt) {
                    const fillAmount = oldSize - newSize;
                    this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}): size changed ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (filled: ${fillAmount.toFixed(8)})`, 'info');

                    // Create copy for update
                    const updatedOrder = { ...gridOrder };
                    applyChainSizeToGridOrder(this, updatedOrder, newSize);

                    // Transition to PARTIAL state since it was partially filled
                    if (updatedOrder.state === ORDER_STATES.ACTIVE) {
                        updatedOrder.state = ORDER_STATES.PARTIAL;
                    }
                    this._updateOrder(updatedOrder);
                    updatedOrders.push(updatedOrder);
                } else {
                    this._updateOrder(gridOrder);
                }
            } else {
                // Order no longer exists on chain - it was fully filled
                // Only treat as filled if it was previously ACTIVE or PARTIAL. If it was VIRTUAL and not on chain, it's just a virtual order.
                if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                    this.logger.log(`Order ${gridOrder.id} (${gridOrder.orderId}) no longer on chain - marking as VIRTUAL (fully filled)`, 'info');
                    const filledOrder = { ...gridOrder };

                    // Create copy for update
                    const updatedOrder = { ...gridOrder, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null };

                    this._updateOrder(updatedOrder);
                    filledOrders.push(filledOrder);
                }
            }
        }

        // Second pass: Check for chain orders that don't match any grid orderId but match by price
        // This handles cases where orders were recreated with new IDs OR picking up existing orders for virtual spots
        for (const [chainOrderId, chainOrder] of parsedChainOrders) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue; // Already matched

            // Find a grid order that matches by type and price but has a stale/missing orderId
            // Use calculatePriceTolerance(...) which computes tolerance based on asset precisions and order sizes
            let bestMatch = null;
            let bestPriceDiff = Infinity;

            for (const gridOrder of this.orders.values()) {
                // Skip if already confirmed active on another ID
                if ((gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) && gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) continue;
                // If it's active but the ID is dead/missing, we can match. If it's VIRTUAL, we can match.

                if (gridOrder.type !== chainOrder.type) continue;
                // Skip if this grid order's orderId is still valid on chain (covered by first pass)
                if (gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) continue;

                const priceDiff = Math.abs(gridOrder.price - chainOrder.price);

                // Prefer using the chain-reported size when available for a more accurate tolerance
                const orderSize = (chainOrder.size && Number.isFinite(Number(chainOrder.size))) ? Number(chainOrder.size) : (gridOrder.size && Number.isFinite(Number(gridOrder.size)) ? Number(gridOrder.size) : null);

                // Compute tolerance using the same formula used elsewhere in the manager
                let tolerance = null;
                try {
                    if (orderSize !== null && orderSize > 0) {
                        tolerance = calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type, this.assets);
                    }
                } catch (e) {
                    tolerance = null;
                }

                // Ensure we have a usable tolerance from calculatePriceTolerance (it provides a fallback)
                if (!tolerance || !Number.isFinite(tolerance)) {
                    tolerance = calculatePriceTolerance(gridOrder.price, orderSize, gridOrder.type, this.assets);
                }

                if (priceDiff <= tolerance && priceDiff < bestPriceDiff) {
                    bestMatch = gridOrder;
                    bestPriceDiff = priceDiff;
                }
            }

            if (bestMatch) {
                this.logger.log(`Order ${bestMatch.id}: Found matching open order ${chainOrderId} (diff=${bestPriceDiff.toFixed(8)}). Syncing...`, 'info');
                bestMatch.orderId = chainOrderId;
                bestMatch.state = ORDER_STATES.ACTIVE;
                // Update size from chain but NEVER update price
                const oldSize = Number(bestMatch.size || 0);
                const newSize = Number(chainOrder.size || 0);
                // Determine precision from the matching grid order (if available)
                const precision = (bestMatch && bestMatch.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const oldInt = floatToBlockchainInt(oldSize, precision);
                const newInt = floatToBlockchainInt(newSize, precision);
                if (oldInt !== newInt) {
                    applyChainSizeToGridOrder(this, bestMatch, newSize);
                }
                this._updateOrder(bestMatch);
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            } else {
                this.logger.log(`Chain order ${chainOrderId} (type=${chainOrder.type}, price=${chainOrder.price.toFixed(4)}) has no matching grid order`, 'warn');
            }
        }

        // Log fill info if provided
        if (fillInfo && fillInfo.pays && fillInfo.receives) {
            this.logger.log(`Fill event: pays ${fillInfo.pays.amount} (${fillInfo.pays.asset_id}), receives ${fillInfo.receives.amount} (${fillInfo.receives.asset_id})`, 'debug');
        }

        // Log summary of orders needing correction
        if (ordersNeedingCorrection.length > 0) {
            this.logger.log(`${ordersNeedingCorrection.length} order(s) need price correction on blockchain`, 'warn');
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection };
    }

    /**
     * Process a fill event directly from history/subscription data.
     * Uses order_id from the fill event to match with orders in the grid.
     * This is the preferred method (faster, no extra API calls).
     * 
     * The fill event contains:
     * - order_id: The chain order ID that was filled (e.g., '1.7.12345')
     * - pays: { amount, asset_id } - What the maker paid out
     * - receives: { amount, asset_id } - What the maker received
     * - is_maker: boolean - Whether this account was the maker
     * 
     * @param {Object} fillOp - Fill operation data (fillEvent.op[1])
     * @returns {Object} - { filledOrders: [], updatedOrders: [], partialFill: boolean }
     */
    syncFromFillHistory(fillOp) {
        if (!fillOp || !fillOp.order_id) {
            this.logger.log('syncFromFillHistory: No valid fill operation provided', 'debug');
            return { filledOrders: [], updatedOrders: [], partialFill: false };
        }

        const orderId = fillOp.order_id;
        const paysAmount = fillOp.pays ? Number(fillOp.pays.amount) : 0;
        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
        const receivesAmount = fillOp.receives ? Number(fillOp.receives.amount) : 0;
        const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;

        this.logger.log(`syncFromFillHistory: Processing fill for order_id=${orderId}`, 'debug');
        this.logger.log(`  Pays: ${paysAmount} (${paysAssetId}), Receives: ${receivesAmount} (${receivesAssetId})`, 'debug');

        const filledOrders = [];
        const updatedOrders = [];
        let partialFill = false;

        // Find the grid order by orderId
        let matchedGridOrder = null;
        for (const gridOrder of this.orders.values()) {
            if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                matchedGridOrder = gridOrder;
                break;
            }
        }

        if (!matchedGridOrder) {
            this.logger.log(`syncFromFillHistory: No matching grid order found for order_id=${orderId}`, 'warn');
            return { filledOrders, updatedOrders, partialFill };
        }

        this.logger.log(`syncFromFillHistory: Matched order_id=${orderId} to grid order ${matchedGridOrder.id} (type=${matchedGridOrder.type})`, 'debug');

        // Determine the fill amount based on order type and which asset was paid
        // For SELL orders: pays is assetA (what we're selling)
        // For BUY orders: pays is assetB (what we're selling to buy assetA)
        const orderType = matchedGridOrder.type;
        const currentSize = Number(matchedGridOrder.size || 0);

        // Get asset precisions for conversion
        const assetAPrecision = this.assets?.assetA?.precision || 5;
        const assetBPrecision = this.assets?.assetB?.precision || 5;
        const assetAId = this.assets?.assetA?.id;
        const assetBId = this.assets?.assetB?.id;

        // Calculate the filled amount in human-readable units
        let filledAmount = 0;
        if (orderType === ORDER_TYPES.SELL) {
            // SELL order: size is in assetA, pays is assetA
            if (paysAssetId === assetAId) {
                filledAmount = blockchainToFloat(paysAmount, assetAPrecision);
            }
        } else {
            // BUY order: size is in assetB, pays is assetB
            if (paysAssetId === assetBId) {
                filledAmount = blockchainToFloat(paysAmount, assetBPrecision);
            }
        }

        const newSize = Math.max(0, currentSize - filledAmount);

        // Check if fully filled or partially filled
        // Use blockchain integer comparison for precision
        const precision = (orderType === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
        const newSizeInt = floatToBlockchainInt(newSize, precision);

        if (newSizeInt <= 0) {
            // Fully filled
            this.logger.log(`Order ${matchedGridOrder.id} (${orderId}) FULLY FILLED (filled ${filledAmount.toFixed(8)}), pendingProceeds: Buy ${(this.funds.pendingProceeds.buy || 0).toFixed(8)} | Sell ${(this.funds.pendingProceeds.sell || 0).toFixed(8)}`, 'info');
            const filledOrder = { ...matchedGridOrder };

            // Create copy for update
            const updatedOrder = { ...matchedGridOrder, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null };

            this._updateOrder(updatedOrder);
            filledOrders.push(filledOrder);
        } else {
            // Partially filled - transition to PARTIAL state
            this.logger.log(`Order ${matchedGridOrder.id} (${orderId}) PARTIALLY FILLED: ${filledAmount.toFixed(8)} filled, remaining ${newSize.toFixed(8)}, pendingProceeds: Buy ${(this.funds.pendingProceeds.buy || 0).toFixed(8)} | Sell ${(this.funds.pendingProceeds.sell || 0).toFixed(8)}`, 'info');

            // Create a "virtual" filled order with just the filled amount for proceeds calculation
            // Mark as partial so processFilledOrders knows NOT to trigger rebalancing
            const filledPortion = { ...matchedGridOrder, size: filledAmount, isPartial: true };
            filledOrders.push(filledPortion);

            // Create copy for update with remaining size
            const updatedOrder = { ...matchedGridOrder };

            // Update state to PARTIAL first to ensure correct index updates
            // (applyChainSizeToGridOrder calls _updateOrder internally)
            updatedOrder.state = ORDER_STATES.PARTIAL;

            applyChainSizeToGridOrder(this, updatedOrder, newSize);

            // Sanity check: ensure orderId is still there
            if (!updatedOrder.orderId) {
                this.logger.log(`CRITICAL: orderId lost in syncFromFillHistory for ${updatedOrder.id}! Restoring from param ${orderId}`, 'error');
                updatedOrder.orderId = orderId;
            }

            this._updateOrder(updatedOrder);
            updatedOrders.push(updatedOrder);
            partialFill = true;
        }

        return { filledOrders, updatedOrders, partialFill };
    }

    async synchronizeWithChain(chainData, source) {
        if (!this.assets) {
            this.logger.log('Asset metadata not available, cannot synchronize.', 'warn');
            return { newOrders: [], ordersNeedingCorrection: [] };
        }
        this.logger.log(`Syncing from ${source}`, 'debug');
        // Cache asset precisions for hot paths
        const assetAPrecision = this.assets?.assetA?.precision;
        const assetBPrecision = this.assets?.assetB?.precision;
        let newOrders = [];
        // Reset the instance-level correction list for readOpenOrders case
        if (source === 'readOpenOrders') {
            this.ordersNeedingPriceCorrection = [];
        }
        this.logger.log(`DEBUG: synchronizeWithChain entering switch, source=${source}, chainData.length=${Array.isArray(chainData) ? chainData.length : 'N/A'}`, 'debug');
        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId } = chainData;
                const gridOrder = this.orders.get(gridOrderId);
                if (gridOrder) {
                    // Deduct order size from chainFree when moving from VIRTUAL to ACTIVE
                    // This keeps accountTotals.buyFree/sellFree accurate without re-fetching
                    if (gridOrder.state === ORDER_STATES.VIRTUAL && gridOrder.size > 0) {
                        const size = Number(gridOrder.size) || 0;
                        if (gridOrder.type === ORDER_TYPES.BUY && this.accountTotals?.buyFree !== undefined) {
                            this.accountTotals.buyFree = Math.max(0, this.accountTotals.buyFree - size);
                        } else if (gridOrder.type === ORDER_TYPES.SELL && this.accountTotals?.sellFree !== undefined) {
                            this.accountTotals.sellFree = Math.max(0, this.accountTotals.sellFree - size);
                        }
                    }
                    // Create a new object with updated state to avoid mutation bugs in _updateOrder
                    // (if we mutate in place, _updateOrder can't find the old state index to remove from)
                    // Preserve PARTIAL state if the order was already PARTIAL (e.g. during a move)
                    const newState = (gridOrder.state === ORDER_STATES.PARTIAL) ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                    const updatedOrder = { ...gridOrder, state: newState, orderId: chainOrderId };
                    this._updateOrder(updatedOrder);
                    this.logger.log(`Order ${updatedOrder.id} synced with on-chain ID ${updatedOrder.orderId} (state=${newState})`, 'info');
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: this.orders, ordersByState: this._ordersByState, assets: this.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, this.assets), logger: this.logger });
                if (gridOrder) {
                    // Restore order size to chainFree when moving from ACTIVE to VIRTUAL
                    // This keeps accountTotals.buyFree/sellFree accurate without re-fetching
                    if (gridOrder.state === ORDER_STATES.ACTIVE && gridOrder.size > 0) {
                        const size = Number(gridOrder.size) || 0;
                        if (gridOrder.type === ORDER_TYPES.BUY && this.accountTotals?.buyFree !== undefined) {
                            this.accountTotals.buyFree += size;
                        } else if (gridOrder.type === ORDER_TYPES.SELL && this.accountTotals?.sellFree !== undefined) {
                            this.accountTotals.sellFree += size;
                        }
                    }
                    // Create a new object to avoid mutation bug
                    const updatedOrder = { ...gridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
                    this._updateOrder(updatedOrder);
                    this.logger.log(`Order ${updatedOrder.id} (${orderId}) cancelled and reverted to VIRTUAL`, 'info');
                }
                break;
            }
            case 'readOpenOrders': {
                const matchedChainOrders = new Set();  // chainOrderIds that matched a grid order
                const seenOnChain = new Set();         // all chain orderIds seen during this sync
                const relevantChainOrders = [];        // only chain orders in THIS market pair
                this.logger.log(`DEBUG: readOpenOrders: ${chainData.length} chain orders to process, ${this.orders.size} grid orders loaded.`, 'debug');
                let parsedCount = 0;

                // Step 1: Match chain orders to grid orders
                for (const chainOrder of chainData) {
                    const parsedOrder = parseChainOrder(chainOrder, this.assets);
                    if (!parsedOrder) {
                        this.logger.log(`DEBUG: Could not parse chain order ${chainOrder.id}; attempting fallback by orderId`, 'warn');
                        // Fallback: attempt to match by orderId even if parsing failed.
                        const idFallback = { orderId: chainOrder.id };
                        const gridOrderById = findMatchingGridOrderByOpenOrder(idFallback, { orders: this.orders, ordersByState: this._ordersByState, assets: this.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, this.assets), logger: this.logger });
                        if (!gridOrderById) {
                            // Nothing to do for this chain order.
                            continue;
                        }
                        this.logger.log(`DEBUG: Matched chain order ${chainOrder.id} to grid order ${gridOrderById.id} via orderId fallback`, 'info');
                        // Build a shallow parsedOrder so the rest of the code can proceed.
                        parsedOrder = { orderId: chainOrder.id, type: gridOrderById.type, price: gridOrderById.price, size: gridOrderById.size };
                    }
                    relevantChainOrders.push(chainOrder);
                    seenOnChain.add(parsedOrder.orderId);
                    parsedCount++;
                    this.logger.log(`DEBUG: Parsed chain order ${parsedOrder.orderId}: type=${parsedOrder.type}, price=${parsedOrder.price?.toFixed(6)}, size=${parsedOrder.size?.toFixed(8)}`, 'info');

                    const gridOrder = findMatchingGridOrderByOpenOrder(parsedOrder, { orders: this.orders, ordersByState: this._ordersByState, assets: this.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, this.assets), logger: this.logger });
                    if (gridOrder) {
                        matchedChainOrders.add(parsedOrder.orderId);

                        // IMPORTANT: do NOT mutate the existing order object in-place.
                        // _updateOrder uses the previously stored object's state/type to update indices.
                        // If we mutate first, old indices won't be cleaned up.
                        const updatedOrder = {
                            ...gridOrder,
                            orderId: parsedOrder.orderId,
                            state: ORDER_STATES.ACTIVE
                        };
                        this.logger.log(`Grid ${updatedOrder.id} now ACTIVE with orderId ${parsedOrder.orderId}`, 'info');

                        // Apply chain size to updated order (reconcile sizes)
                        if (parsedOrder.size !== null && parsedOrder.size !== undefined && Number.isFinite(Number(parsedOrder.size))) {
                            try {
                                applyChainSizeToGridOrder(this, updatedOrder, parsedOrder.size);
                            } catch (e) {
                                this.logger.log(`Error applying chain size: ${e.message}`, 'warn');
                            }
                        }

                        this._updateOrder(updatedOrder);
                    } else {
                        this.logger.log(`No grid match for chain ${parsedOrder.orderId} (type=${parsedOrder.type}, price=${parsedOrder.price.toFixed(4)}, size=${parsedOrder.size?.toFixed(8)})`, 'warn');
                    }
                }

                // Step 2: Find grid orders not on-chain (treat as filled)
                const unmatchedGridOrders = [];
                for (const gridOrder of this.orders.values()) {
                    // A grid order is missing only if its orderId is NOT present on chain.
                    if ((gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) && gridOrder.orderId && !seenOnChain.has(gridOrder.orderId)) {
                        this.logger.log(`Grid order ${gridOrder.id} (${gridOrder.orderId}) not found on-chain - treating as FILLED`, 'info');
                        unmatchedGridOrders.push(gridOrder);
                    }
                }

                // Step 3: Find chain orders that don't match any grid order
                // IMPORTANT: only consider orders in this market pair.
                const unmatchedChainOrders = relevantChainOrders.filter(co => !matchedChainOrders.has(co.id));

                // Summary
                this.logger.log(`Sync summary: ${parsedCount} chain orders, ${this.orders.size} grid orders, matched=${matchedChainOrders.size}, unmatched_chain=${unmatchedChainOrders.length}, unmatched_grid=${unmatchedGridOrders.length}`, 'debug');

                // Process unmatched grid orders as fills
                let rebalanceResult = { ordersToPlace: [], ordersToRotate: [] };
                if (unmatchedGridOrders.length > 0) {
                    rebalanceResult = await this.processFilledOrders(unmatchedGridOrders, new Set(this.ordersNeedingPriceCorrection.map(c => c.chainOrderId)));
                }

                // Return results
                return {
                    newOrders,
                    ordersNeedingCorrection: this.ordersNeedingPriceCorrection,
                    rebalanceResult,
                    unmatchedChainOrders,  // Chain orders that don't match any grid (candidates for cancel or reuse)
                    unmatchedGridOrders    // Grid orders not on-chain (treated as filled, trigger rebalancing)
                };
            }
        }
        return { newOrders, ordersNeedingCorrection: this.ordersNeedingPriceCorrection };
    }

    /**
     * Get the initial set of orders to place on-chain.
     * Selects the closest virtual orders to market price,
     * respecting the configured activeOrders limits and
     * filtering out orders below minimum size.
     * 
     * Orders are sorted from outside-in for optimal placement:
     * - Sells: highest price first
     * - Buys: lowest price first
     * 
     * @returns {Array} Array of order objects to activate
     */
    getInitialOrdersToActivate() {
        const sellCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.sell ? this.config.activeOrders.sell : 1));
        const buyCount = Math.max(0, Number(this.config.activeOrders && this.config.activeOrders.buy ? this.config.activeOrders.buy : 1));

        // Get minimum order sizes for each type
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        // --- Sells ---
        const allVirtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualSells.sort((a, b) => a.price - b.price);
        // Take the block of orders that will become active
        const futureActiveSells = allVirtualSells.slice(0, sellCount);
        // Filter out orders below minimum size and log warnings
        const validSells = futureActiveSells.filter(order => {
            if (order.size < minSellSize) {
                this.logger.log(`Skipping sell order ${order.id}: size ${order.size.toFixed(8)} < minOrderSize ${minSellSize.toFixed(8)}`, 'warn');
                return false;
            }
            return true;
        });
        // Sort that block from the outside-in
        validSells.sort((a, b) => b.price - a.price);

        // --- Buys ---
        const allVirtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        // Sort closest to market price first
        allVirtualBuys.sort((a, b) => b.price - a.price);
        // Take the block of orders that will become active
        const futureActiveBuys = allVirtualBuys.slice(0, buyCount);
        // Filter out orders below minimum size and log warnings
        const validBuys = futureActiveBuys.filter(order => {
            if (order.size < minBuySize) {
                this.logger.log(`Skipping buy order ${order.id}: size ${order.size.toFixed(8)} < minOrderSize ${minBuySize.toFixed(8)}`, 'warn');
                return false;
            }
            return true;
        });
        // Sort that block from the outside-in
        validBuys.sort((a, b) => a.price - b.price);

        if (validSells.length < futureActiveSells.length || validBuys.length < futureActiveBuys.length) {
            this.logger.log(`Filtered ${futureActiveSells.length - validSells.length} sell and ${futureActiveBuys.length - validBuys.length} buy orders below minimum size threshold`, 'debug');
        }

        return [...validSells, ...validBuys];
    }

    /**
     * Filter tracked orders by type and/or state using optimized indices.
     * @param {string|null} type - ORDER_TYPES.BUY, SELL, or SPREAD (null for all)
     * @param {string|null} state - ORDER_STATES.VIRTUAL or ACTIVE (null for all)
     * @returns {Array} Filtered array of order objects
     */
    getOrdersByTypeAndState(type, state) {
        let candidateIds;

        // Use indices for faster lookup when possible
        if (state !== null && type !== null) {
            // Intersection of both state and type indices
            const stateIds = this._ordersByState[state] || new Set();
            const typeIds = this._ordersByType[type] || new Set();
            candidateIds = [...stateIds].filter(id => typeIds.has(id));
            return candidateIds.map(id => this.orders.get(id)).filter(Boolean);
        } else if (state !== null) {
            // Use state index only
            candidateIds = this._ordersByState[state] || new Set();
            return [...candidateIds].map(id => this.orders.get(id)).filter(Boolean);
        } else if (type !== null) {
            // Use type index only
            candidateIds = this._ordersByType[type] || new Set();
            return [...candidateIds].map(id => this.orders.get(id)).filter(Boolean);
        } else {
            // No filtering, return all orders
            return Array.from(this.orders.values());
        }
    }

    /**
     * Get all PARTIAL orders of a specific type.
     * @param {string} type - ORDER_TYPES.BUY or SELL
     * @returns {Array} Array of partial order objects
     */
    getPartialOrdersOnSide(type) {
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL);
    }

    // Periodically poll for fills and recalculate orders on demand.
    async fetchOrderUpdates(options = { calculate: false }) {
        try { const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE); if (activeOrders.length === 0 || (options && options.calculate)) { const { remaining, filled } = await this.calculateOrderUpdates(); remaining.forEach(order => this.orders.set(order.id, order)); if (filled.length > 0) await this.processFilledOrders(filled); this.checkSpreadCondition(); return { remaining, filled }; } return { remaining: activeOrders, filled: [] }; } catch (error) { this.logger.log(`Error fetching order updates: ${error.message}`, 'error'); return { remaining: [], filled: [] }; }
    }

    // Simulate fills by identifying the closest active order (will be converted to VIRTUAL/SPREAD by processFilledOrders).
    async calculateOrderUpdates() { const marketPrice = this.config.marketPrice; const spreadRange = marketPrice * (this.config.targetSpreadPercent / 100); const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE); const activeSells = activeOrders.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => Math.abs(a.price - this.config.marketPrice) - Math.abs(b.price - this.config.marketPrice)); const activeBuys = activeOrders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => Math.abs(a.price - this.config.marketPrice) - Math.abs(b.price - this.config.marketPrice)); const filledOrders = []; if (activeSells.length > 0) filledOrders.push({ ...activeSells[0] }); else if (activeBuys.length > 0) filledOrders.push({ ...activeBuys[0] }); const remaining = activeOrders.filter(o => !filledOrders.some(f => f.id === o.id)); return { remaining, filled: filledOrders }; }

    // Flag whether the spread has widened beyond configured limits so we can rebalance.
    // Flag whether the spread has widened beyond configured limits so we can rebalance.
    checkSpreadCondition() {
        const currentSpread = this.calculateCurrentSpread();
        const targetSpread = this.config.targetSpreadPercent + this.config.incrementPercent;

        // Only trigger spread warning if we have at least one active order on BOTH sides.
        const activeBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        const hasBothSides = activeBuys.length > 0 && activeSells.length > 0;

        if (hasBothSides && currentSpread > targetSpread) {
            this.outOfSpread = true;
            this.logger.log(`Spread too wide (${currentSpread.toFixed(2)}% > ${targetSpread}%), will add extra orders on next fill`, 'warn');
        } else {
            this.outOfSpread = false;
        }
    }

    /**
     * Process filled orders and trigger rebalancing.
     * For each filled order:
     * 1. Converts directly to VIRTUAL/SPREAD placeholder (single step)
     * 2. Updates funds (transfers proceeds to available pool)
     * 3. Triggers creation of new orders on the opposite side
     * 
     * @param {Array} filledOrders - Array of orders that were filled
     * @param {Set} excludeOrderIds - Set of chain orderIds to exclude from rotation (e.g., just corrected)
     * @returns {Array} Newly activated orders that need on-chain placement
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        this.logger.log(`>>> processFilledOrders() called with ${filledOrders.length} filled orders`, 'info');
        const filledCounts = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };
        const partialFillCount = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };
        // Collect proceeds to add AFTER all maybeConvertToSpread calls
        // (because maybeConvertToSpread calls _updateOrder which runs recalculateFunds and would overwrite)
        let proceedsBuy = 0;
        let proceedsSell = 0;
        // Track balance deltas so we can adjust accountTotals immediately without waiting for a fresh chain fetch
        let deltaBuyFree = 0;
        let deltaSellFree = 0;
        let deltaBuyTotal = 0;
        let deltaSellTotal = 0;

        // Check if BTS is in the trading pair and track BTS fees only if it is
        const hasBtsPair = this.config.assetA === 'BTS' || this.config.assetB === 'BTS';

        for (const filledOrder of filledOrders) {
            // Track if this is a partial fill (remaining amount still locked on-chain)
            const isPartial = filledOrder.isPartial === true;
            if (isPartial) {
                partialFillCount[filledOrder.type]++;
            } else {
                filledCounts[filledOrder.type]++;
            }

            // Calculate proceeds before converting to SPREAD
            if (filledOrder.type === ORDER_TYPES.SELL) {
                const proceeds = filledOrder.size * filledOrder.price;
                proceedsBuy += proceeds;  // Collect, don't add yet
                // SELL means we receive quote asset (buy side) and give up base asset (sell side)
                deltaBuyFree += proceeds;
                deltaBuyTotal += proceeds;
                // sellFree was reduced at order creation; the locked size is now sold, so only the total decreases
                deltaSellTotal -= filledOrder.size;
                const quoteName = this.config.assetB || 'quote';
                const baseName = this.config.assetA || 'base';
                this.logger.log(`Sell filled: +${proceeds.toFixed(8)} ${quoteName}, -${filledOrder.size.toFixed(8)} ${baseName} committed (orderId=${filledOrder.id}, size=${filledOrder.size.toFixed(8)}, price=${filledOrder.price}, isPartial=${filledOrder.isPartial})`, 'info');
            } else {
                const proceeds = filledOrder.size / filledOrder.price;
                proceedsSell += proceeds;  // Collect, don't add yet
                // BUY means we receive base asset (sell side tracker) and spend quote asset (buy side)
                deltaSellFree += proceeds;
                deltaSellTotal += proceeds;
                // buyFree was reduced at order creation; only total decreases to reflect the spend
                deltaBuyTotal -= filledOrder.size;
                const quoteName = this.config.assetB || 'quote';
                const baseName = this.config.assetA || 'base';
                this.logger.log(`Buy filled: +${proceeds.toFixed(8)} ${baseName}, -${filledOrder.size.toFixed(8)} ${quoteName} committed (orderId=${filledOrder.id}, size=${filledOrder.size.toFixed(8)}, price=${filledOrder.price}, isPartial=${filledOrder.isPartial})`, 'info');
            }

            // Only convert to SPREAD if this is a FULLY filled order, not a partial
            if (!isPartial) {
                // Convert directly to SPREAD placeholder (one step: ACTIVE -> VIRTUAL/SPREAD)
                // Create copy for update
                const updatedOrder = { ...filledOrder, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null };
                this._updateOrder(updatedOrder);

                this.currentSpreadCount++;
                this.logger.log(`Converted order ${filledOrder.id} to SPREAD`, 'debug');
            } else {
                // Partial fill: order already updated to PARTIAL state by syncFromFillHistory
                // Just log for clarity
                this.logger.log(`Partial fill processed: order ${filledOrder.id} remains PARTIAL with ${filledOrder.size.toFixed(8)} filled`, 'debug');
            }
        }

        // Accumulate BTS fees based on number of fills: (number_of_fills × total_fee)
        if (hasBtsPair && filledOrders.length > 0) {
            const btsFeeData = getAssetFees('BTS', 0);
            const totalFillCount = filledOrders.length;
            const btsFeesForFills = totalFillCount * btsFeeData.total;
            this.funds.btsFeesOwed += btsFeesForFills;
            this.logger.log(`BTS fees for ${totalFillCount} fill(s): ${btsFeesForFills.toFixed(8)} BTS (total owed: ${this.funds.btsFeesOwed.toFixed(8)} BTS)`, 'debug');
        }

        // Apply proceeds directly to accountTotals so availability reflects fills immediately (no waiting for a chain refresh)
        if (!this.accountTotals) {
            this.accountTotals = { buy: 0, sell: 0, buyFree: 0, sellFree: 0 };
        }

        const bumpTotal = (key, delta) => {
            if (this.accountTotals[key] === null || this.accountTotals[key] === undefined) this.accountTotals[key] = 0;
            const next = (Number(this.accountTotals[key]) || 0) + delta;
            this.accountTotals[key] = next < 0 ? 0 : next;
        };

        bumpTotal('buyFree', deltaBuyFree);
        bumpTotal('sellFree', deltaSellFree);
        bumpTotal('buy', deltaBuyTotal);
        bumpTotal('sell', deltaSellTotal);

        // Hold proceeds in pendingProceeds so availability reflects them through rotation
        // This is the single source of truth for proceeds calculation (not _adjustFunds)
        const proceedsBefore = { buy: this.funds.pendingProceeds.buy || 0, sell: this.funds.pendingProceeds.sell || 0 };
        this.funds.pendingProceeds.buy = (this.funds.pendingProceeds.buy || 0) + proceedsBuy;
        this.funds.pendingProceeds.sell = (this.funds.pendingProceeds.sell || 0) + proceedsSell;
        this.recalculateFunds();
        this.logger.log(`Proceeds applied: Before Buy ${proceedsBefore.buy.toFixed(8)} + ${proceedsBuy.toFixed(8)} = After ${(this.funds.pendingProceeds.buy || 0).toFixed(8)} | Before Sell ${proceedsBefore.sell.toFixed(8)} + ${proceedsSell.toFixed(8)} = After ${(this.funds.pendingProceeds.sell || 0).toFixed(8)}`, 'info');
        
        // CRITICAL: Persist pending proceeds so they survive bot restart
        // These funds from partial fills must not be lost when the bot restarts
        try {
            if (this.config && this.config.botKey && this.accountOrders) {
                this.accountOrders.updatePendingProceeds(this.config.botKey, this.funds.pendingProceeds);
                this.logger.log(`Persisted pendingProceeds: Buy ${(this.funds.pendingProceeds.buy || 0).toFixed(8)}, Sell ${(this.funds.pendingProceeds.sell || 0).toFixed(8)}`, 'debug');
            }
        } catch (e) {
            this.logger.log(`Warning: Failed to persist pendingProceeds: ${e.message}`, 'warn');
        }
        
        if (this.logger.level === 'debug') this._logAvailable('after proceeds apply');
        const extraOrderCount = this.outOfSpread ? 1 : 0;
        if (this.outOfSpread) {
            this.logger.log(`Adding extra order due to previous wide spread condition`, 'info');
            this.outOfSpread = false;
        }
        // Log available funds before rotation
        this.logger.log(`Available funds before rotation: Buy ${this.funds.available.buy.toFixed(8)} | Sell ${this.funds.available.sell.toFixed(8)}`, 'info');
        this._logAvailable('before rotation');
        
        // CRITICAL: Only rebalance if there are ACTUAL fully-filled orders, not just partial fills
        // Partial fills don't need rotations - the remaining amount stays locked and the order continues
        const hasFullFills = filledCounts[ORDER_TYPES.BUY] > 0 || filledCounts[ORDER_TYPES.SELL] > 0;
        const onlyPartialFills = !hasFullFills && (partialFillCount[ORDER_TYPES.BUY] > 0 || partialFillCount[ORDER_TYPES.SELL] > 0);
        
        if (onlyPartialFills) {
            this.logger.log(`Only partial fills detected (no rotations needed). Skipping rebalance.`, 'info');
            return { ordersToPlace: [], ordersToRotate: [], partialMoves: [] };
        }
        
        const newOrders = await this.rebalanceOrders(filledCounts, extraOrderCount, excludeOrderIds);

        // Add updateFee to BTS fees if partial orders were moved during rotation
        // Partial fills require an update operation on the blockchain, incurring an additional updateFee
        if (hasBtsPair && newOrders.partialMoves && newOrders.partialMoves.length > 0) {
            const btsFeeData = getAssetFees('BTS', 0); // Get updateFee from cached fees
            const updateFeePerPartial = btsFeeData.updateFee;
            const totalUpdateFee = updateFeePerPartial * newOrders.partialMoves.length;

            this.funds.btsFeesOwed += totalUpdateFee;
            this.logger.log(`Added updateFee for ${newOrders.partialMoves.length} partial move(s): +${totalUpdateFee.toFixed(8)} BTS (total fees owed: ${this.funds.btsFeesOwed.toFixed(8)} BTS)`, 'info');
        }

        // Clear pending proceeds only for sides that had fills processed
        // (preserve pending proceeds from partial fills on the other side)
        const proceedsBeforeClear = { buy: this.funds.pendingProceeds.buy || 0, sell: this.funds.pendingProceeds.sell || 0 };
        if (filledCounts[ORDER_TYPES.SELL] > 0) {
            // SELL fills produce buy-side proceeds (quote asset received)
            this.funds.pendingProceeds.buy = 0;
        }
        if (filledCounts[ORDER_TYPES.BUY] > 0) {
            // BUY fills produce sell-side proceeds (base asset received)
            this.funds.pendingProceeds.sell = 0;
        }
        this.recalculateFunds();
        
        this.logger.log(`Cleared pendingProceeds after rotation: Before Buy ${proceedsBeforeClear.buy.toFixed(8)} -> After ${(this.funds.pendingProceeds.buy || 0).toFixed(8)} | Before Sell ${proceedsBeforeClear.sell.toFixed(8)} -> After ${(this.funds.pendingProceeds.sell || 0).toFixed(8)}`, 'info');
        
        // CRITICAL: Persist cleared pendingProceeds so cleared state survives restart
        try {
            if (this.config && this.config.botKey && this.accountOrders) {
                this.accountOrders.updatePendingProceeds(this.config.botKey, this.funds.pendingProceeds);
                this.logger.log(`Persisted pendingProceeds: Buy ${(this.funds.pendingProceeds.buy || 0).toFixed(8)}, Sell ${(this.funds.pendingProceeds.sell || 0).toFixed(8)}`, 'debug');
            }
        } catch (e) {
            this.logger.log(`Warning: Failed to persist pendingProceeds: ${e.message}`, 'warn');
        }
        
        this._logAvailable('after rotation clear');

        this.logger && this.logger.logFundsStatus && this.logger.logFundsStatus(this);
        return newOrders;
    }

    // Note: Filled orders are now converted directly to SPREAD in processFilledOrders, syncFromOpenOrders, and syncFromFillHistory

    /**
     * Rebalance orders after fills using the "rotate furthest" strategy:
     * 
     * When a SELL fills:
     * 1. Activate closest VIRTUAL SELL to spread -> needs on-chain order placement
     * 2. Find furthest active BUY from spread -> cancel and recreate at new price (uses available funds)
     * 
     * When a BUY fills:
     * 1. Activate closest VIRTUAL BUY to spread -> needs on-chain order placement  
     * 2. Find furthest active SELL from spread -> cancel and recreate at new price (uses available funds)
     * 
     * Returns { ordersToPlace, ordersToRotate } for blockchain operations.
     * @param {Object} filledCounts - Count of filled orders by type { buy: n, sell: n }
     * @param {number} extraOrderCount - Extra orders to create (for spread widening)
     * @param {Set} excludeOrderIds - Set of chain orderIds to exclude from rotation (e.g., just corrected)
     * @returns {Object} { ordersToPlace: [], ordersToRotate: [], partialMoves: [] }
     */
    async rebalanceOrders(filledCounts, extraOrderCount = 0, excludeOrderIds = new Set()) {
        const ordersToPlace = [];    // New orders to place on-chain (activated virtuals)
        const ordersToRotate = [];   // Orders to cancel and recreate at new price
        const partialMoves = [];     // Partial orders to move away from market (also feed preferred rotation slots)

        // When SELL orders fill: activate virtual sells (need on-chain) and rotate furthest buys
        if (filledCounts[ORDER_TYPES.SELL] > 0) {
            const count = filledCounts[ORDER_TYPES.SELL] + extraOrderCount;
            const partialMoveSlots = filledCounts[ORDER_TYPES.SELL]; // move partials strictly by number of fills

            // Step 1: Activate closest virtual SELL orders - these need on-chain placement
            const activatedSells = await this.activateClosestVirtualOrdersForPlacement(ORDER_TYPES.SELL, count);
            ordersToPlace.push(...activatedSells);
            this.logger.log(`Prepared ${activatedSells.length} virtual SELL orders for on-chain placement`, 'info');

            // Step 2: Move partial BUY (opposite side) before we select spread targets for rotation
            const partialBuys = this.getPartialOrdersOnSide(ORDER_TYPES.BUY);
            if (partialBuys.length === 1) {
                const reservedBuyGridIds = new Set(); // rotation targets unknown yet; rely on virtual-only search
                const moveInfo = this.preparePartialOrderMove(partialBuys[0], partialMoveSlots, reservedBuyGridIds);
                if (moveInfo) {
                    partialMoves.push(moveInfo);
                    this.logger.log(`Prepared partial BUY move: ${moveInfo.partialOrder.id} -> ${moveInfo.newGridId}`, 'info');
                }
            } else if (partialBuys.length > 1) {
                this.logger.log(`WARNING: ${partialBuys.length} partial BUY orders exist - skipping partial move`, 'warn');
            }

            // Step 3: Find furthest active BUY orders and prepare them for rotation (cancel + recreate)
            // Rotation requires available funds - new order consumes available, old order moves to reserved
            if (this.calculateAvailableFunds('buy') > 0) {
                const rotatedBuys = await this.prepareFurthestOrdersForRotation(
                    ORDER_TYPES.BUY,
                    count,
                    excludeOrderIds,
                    filledCounts[ORDER_TYPES.SELL],
                    {
                        avoidPrices: partialMoves.map(m => m.newPrice),
                        preferredSlots: partialMoves
                            .filter(m => m.partialOrder.type === ORDER_TYPES.BUY)
                            .map(m => ({ id: m.vacatedGridId, price: m.vacatedPrice }))
                    }
                );
                ordersToRotate.push(...rotatedBuys);

                if (rotatedBuys.length < count) {
                    this.logger.log(`Only prepared ${rotatedBuys.length}/${count} BUY orders for rotation`, 'warn');
                }
            } else {
                this.logger.log(`No available buy funds to rotate orders`, 'warn');
            }
        }

        // When BUY orders fill: activate virtual buys (need on-chain) and rotate furthest sells
        if (filledCounts[ORDER_TYPES.BUY] > 0) {
            const count = filledCounts[ORDER_TYPES.BUY] + extraOrderCount;
            const partialMoveSlots = filledCounts[ORDER_TYPES.BUY]; // move partials strictly by number of fills

            // Step 1: Activate closest virtual BUY orders - these need on-chain placement
            const activatedBuys = await this.activateClosestVirtualOrdersForPlacement(ORDER_TYPES.BUY, count);
            ordersToPlace.push(...activatedBuys);
            this.logger.log(`Prepared ${activatedBuys.length} virtual BUY orders for on-chain placement`, 'info');

            // Step 2: Move partial SELL (opposite side) before we select spread targets for rotation
            const partialSells = this.getPartialOrdersOnSide(ORDER_TYPES.SELL);
            if (partialSells.length === 1) {
                const reservedSellGridIds = new Set();
                const moveInfo = this.preparePartialOrderMove(partialSells[0], partialMoveSlots, reservedSellGridIds);
                if (moveInfo) {
                    partialMoves.push(moveInfo);
                    this.logger.log(`Prepared partial SELL move: ${moveInfo.partialOrder.id} -> ${moveInfo.newGridId}`, 'info');
                }
            } else if (partialSells.length > 1) {
                this.logger.log(`WARNING: ${partialSells.length} partial SELL orders exist - skipping partial move`, 'warn');
            }

            // Step 3: Find furthest active SELL orders and prepare them for rotation
            // Rotation requires available funds - new order consumes available, old order moves to reserved
            if (this.calculateAvailableFunds('sell') > 0) {
                const rotatedSells = await this.prepareFurthestOrdersForRotation(
                    ORDER_TYPES.SELL,
                    count,
                    excludeOrderIds,
                    filledCounts[ORDER_TYPES.BUY],
                    {
                        avoidPrices: partialMoves.map(m => m.newPrice),
                        preferredSlots: partialMoves
                            .filter(m => m.partialOrder.type === ORDER_TYPES.SELL)
                            .map(m => ({ id: m.vacatedGridId, price: m.vacatedPrice }))
                    }
                );
                ordersToRotate.push(...rotatedSells);

                if (rotatedSells.length < count) {
                    this.logger.log(`Only prepared ${rotatedSells.length}/${count} SELL orders for rotation`, 'warn');
                }
            } else {
                this.logger.log(`No available sell funds to rotate orders`, 'warn');
            }
        }

        return { ordersToPlace, ordersToRotate, partialMoves };
    }

    /**
     * Activate the closest VIRTUAL orders for on-chain placement.
     * These orders will be placed as new limit orders on the blockchain.
     * Funds ARE committed here since these become real on-chain orders.
     * 
     * IMPORTANT: Only selects orders that are currently in VIRTUAL state.
     * Orders that are already ACTIVE (on-chain) are excluded.
     * 
     * @param {string} targetType - ORDER_TYPES.BUY or SELL
     * @param {number} count - Number of orders to activate
     * @returns {Array} Array of order objects ready for on-chain placement
     */
    async activateClosestVirtualOrdersForPlacement(targetType, count) {
        if (count <= 0) return [];

        // Only get orders that are truly VIRTUAL (not yet on-chain)
        const virtualOrders = this.getOrdersByTypeAndState(targetType, ORDER_STATES.VIRTUAL);

        // Debug: log what we found
        this.logger.log(`Found ${virtualOrders.length} VIRTUAL ${targetType} orders for activation`, 'debug');

        // Sort by distance to market price (closest first)
        // For BUY: highest price is closest to market (below market)
        // For SELL: lowest price is closest to market (above market)
        virtualOrders.sort((a, b) =>
            targetType === ORDER_TYPES.BUY
                ? b.price - a.price  // Highest price first for buys
                : a.price - b.price  // Lowest price first for sells
        );

        const toActivate = virtualOrders.slice(0, count);
        const activated = [];

        // These orders inherit their grid position's size (already calculated)
        for (const order of toActivate) {
            // Double-check the order is still VIRTUAL (not already being processed)
            const currentOrder = this.orders.get(order.id);
            if (!currentOrder || currentOrder.state !== ORDER_STATES.VIRTUAL) {
                this.logger.log(`Order ${order.id} is no longer VIRTUAL (state=${currentOrder?.state}), skipping`, 'warn');
                continue;
            }

            const orderSize = order.size || 0;

            if (orderSize <= 0) {
                this.logger.log(`Skipping virtual ${targetType} at ${order.price.toFixed(4)} - no size defined`, 'warn');
                continue;
            }

            // Do not mutate grid state yet; placement will set ACTIVE once the chain returns an orderId
            activated.push({ ...order });
            this.logger.log(`Prepared virtual ${order.type} ${order.orderId || order.id} at price ${order.price.toFixed(4)}, size ${orderSize.toFixed(8)} for on-chain placement (state unchanged until confirmed)`, 'debug');
        }

        return activated;
    }

    /**
     * Find the furthest ACTIVE orders and prepare them for rotation.
     * Rotation means: cancel the old order, then update it to a new price from a SPREAD slot.
     * 
     * For BUY rotation (when SELL fills):
     *   - Furthest active BUY (lowest price) → becomes VIRTUAL
     *   - LOWEST SPREAD price → becomes the new BUY order
     * 
     * For SELL rotation (when BUY fills):
     *   - Furthest active SELL (highest price) → becomes VIRTUAL  
     *   - HIGHEST SPREAD price → becomes the new SELL order
     * 
    * @param {string} targetType - ORDER_TYPES.BUY or SELL (type of orders to rotate)
    * @param {number} count - Number of orders to rotate
    * @param {Set} excludeOrderIds - Set of chain orderIds to exclude (e.g., just corrected)
    * @param {Object} options - Optional overrides
    * @param {string|null} options.overrideGridId - If provided, use this grid slot (and its price) as the first rotation target instead of a spread slot
     * @returns {Array} Array of rotation objects { oldOrder, newPrice, newSize, newGridId }
     */
    async prepareFurthestOrdersForRotation(targetType, count, excludeOrderIds = new Set(), filledCount = 0, options = {}) {
        if (count <= 0) return [];

        // Get orderIds that are pending price correction - exclude these from rotation
        const correctionOrderIds = new Set(
            (this.ordersNeedingPriceCorrection || []).map(c => c.chainOrderId).filter(Boolean)
        );

        // Also exclude recently rotated orders (prevents double-rotation from rapid fill events)
        const recentlyRotated = this._recentlyRotatedOrderIds || new Set();

        // Combine all exclusion sets
        const allExcluded = new Set([...correctionOrderIds, ...excludeOrderIds, ...recentlyRotated]);

        if (allExcluded.size > 0) {
            this.logger.log(`Excluding ${allExcluded.size} order(s) from rotation (corrected, pending, or recently rotated)`, 'debug');
        }

        const activeOrders = this.getOrdersByTypeAndState(targetType, ORDER_STATES.ACTIVE)
            .filter(o => !allExcluded.has(o.orderId)); // Exclude orders that were corrected, pending, or recently rotated

        // Sort by distance from market price (furthest first)
        // For BUY: lowest price is furthest from market
        // For SELL: highest price is furthest from market
        activeOrders.sort((a, b) =>
            targetType === ORDER_TYPES.BUY
                ? a.price - b.price  // Lowest price first for buys (furthest from market)
                : b.price - a.price  // Highest price first for sells (furthest from market)
        );

        const ordersToProcess = activeOrders.slice(0, count);
        const rotations = [];

        if (ordersToProcess.length === 0) {
            return [];
        }

        // Find new prices from SPREAD orders
        // For BUY rotation (when SELL fills): use LOWEST spread (closest to buy side)
        // For SELL rotation (when BUY fills): use HIGHEST spread (closest to sell side)
        // No market price filtering - spread orders are always in the middle zone
        const avoidPrices = Array.isArray(options.avoidPrices) ? options.avoidPrices : [];
        const preferredSlots = Array.isArray(options.preferredSlots) ? options.preferredSlots : [];

        // Enforce layering: partials stay closest to spread; rotations must not place new orders inside the partial boundary.
        const partialsOnSide = this.getPartialOrdersOnSide(targetType) || [];
        let boundaryPrice = null;
        if (partialsOnSide.length > 0) {
            if (targetType === ORDER_TYPES.SELL) {
                // Sells decrease toward spread; the lowest price partial is closest to spread
                boundaryPrice = Math.min(...partialsOnSide.map(p => Number(p.price) || 0));
            } else {
                // Buys increase toward spread; the highest price partial is closest to spread
                boundaryPrice = Math.max(...partialsOnSide.map(p => Number(p.price) || 0));
            }
        }

        const spreadOrders = this.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL)
            .filter(o => {
                const priceOk = (() => {
                    if (boundaryPrice === null) return true;
                    if (targetType === ORDER_TYPES.SELL) return (o.price || 0) >= boundaryPrice; // keep new sells outside/above partial
                    return (o.price || 0) <= boundaryPrice; // keep new buys outside/below partial
                })();
                if (!priceOk) return false;
                if (!avoidPrices.length) return true;
                return !avoidPrices.some(p => Math.abs((o.price || 0) - p) < 1e-6);
            });

        // Preferred slots (typically vacated partial positions) go first if eligible by boundary/avoid filters
        const preferredSpreadOrders = preferredSlots
            .map(s => {
                const order = this.orders.get(s.id);
                const price = s.price !== undefined ? s.price : order?.price;
                if (price === undefined || price === null) return null;
                const priceOk = (() => {
                    if (boundaryPrice === null) return true;
                    if (targetType === ORDER_TYPES.SELL) return price >= boundaryPrice;
                    return price <= boundaryPrice;
                })();
                if (!priceOk) return null;
                if (avoidPrices.some(p => Math.abs(price - p) < 1e-6)) return null;
                return { id: s.id, price };
            })
            .filter(Boolean);

        const mergedSpreadOrders = [...preferredSpreadOrders, ...spreadOrders];

        const seenIds = new Set();
        const eligibleSpreadOrders = mergedSpreadOrders
            .filter(o => {
                if (seenIds.has(o.id)) return false;
                seenIds.add(o.id);
                return true;
            })
            // Sort to get the right edge of spread zone:
            // For BUY: lowest price first (edge closest to buy orders)
            // For SELL: highest price first (edge closest to sell orders)
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        // Calculate available funds using centralized function
        // Formula: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
        const side = targetType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        let availableFunds = this.calculateAvailableFunds(side);

        // If BTS fees were already accounted for in calculateAvailableFunds, track deduction here
        const hasBtsPair = this.config.assetA === 'BTS' || this.config.assetB === 'BTS';
        if (hasBtsPair && this.funds.btsFeesOwed > 0) {
            const isBtsOnThisSide = (side === 'buy' && this.config.assetB === 'BTS') || (side === 'sell' && this.config.assetA === 'BTS');
            if (isBtsOnThisSide) {
                const feesOwedThisSide = Math.min(this.funds.btsFeesOwed, this.funds.pendingProceeds?.[side] ?? 0);
                if (feesOwedThisSide > 0) {
                    this.funds.btsFeesOwed -= feesOwedThisSide;
                    this.logger.log(`Rotation deducting BTS fees: ${feesOwedThisSide.toFixed(8)} BTS. Remaining fees: ${this.funds.btsFeesOwed.toFixed(8)} BTS`, 'info');
                }
            }
        }

        const orderCount = Math.min(ordersToProcess.length, eligibleSpreadOrders.length);
        const simpleDistribution = orderCount > 0 ? availableFunds / orderCount : 0;

        // Calculate geometric distribution across ALL grid slots
        // This ensures the rotation order size reflects what a full grid reset would allocate
        let geometricSizes = [];
        let allocatedSizes = [];
        let allocatedSum = 0;
        if (orderCount > 0) {
            const Grid = require('./grid');
            
            // Get all orders on this side (both ACTIVE and VIRTUAL)
            // CRITICAL: Add filledCount to account for filled orders that were just converted to SPREAD placeholders
            // When opposite-side orders fill, they're converted to SPREAD orders, expanding the total grid
            const allOrdersOnSide = [
                ...this.getOrdersByTypeAndState(targetType, ORDER_STATES.ACTIVE),
                ...this.getOrdersByTypeAndState(targetType, ORDER_STATES.VIRTUAL)
            ];
            const totalSlots = allOrdersOnSide.length + filledCount;
            
            // Calculate total funds for rotation sizing
            // Total = total.grid (committed + virtuel) + cacheFunds + pendingProceeds
            const totalFunds = side === 'buy'
                ? (this.funds.total?.grid?.buy || 0) + (this.funds.cacheFunds?.buy || 0) + (this.funds.pendingProceeds?.buy || 0)
                : (this.funds.total?.grid?.sell || 0) + (this.funds.cacheFunds?.sell || 0) + (this.funds.pendingProceeds?.sell || 0);
            
            // Create dummy orders matching the actual grid structure (all active + virtual)
            const dummyOrders = Array(totalSlots).fill(null).map((_, i) => ({
                id: `dummy-${i}`,
                type: targetType,
                price: 0 // price doesn't matter for sizing
            }));
            
            // Calculate sizes using the same logic as grid.initializeGrid
            const precision = side === 'buy' ? (this.assets?.assetB?.precision ?? 8) : (this.assets?.assetA?.precision ?? 8);
            const sellFunds = side === 'sell' ? totalFunds : 0;
            const buyFunds = side === 'buy' ? totalFunds : 0;
            
            const sizedOrders = Grid.calculateOrderSizes(
                dummyOrders,
                this.config,
                sellFunds,
                buyFunds,
                0,  // minSellSize
                0,  // minBuySize
                precision,
                precision
            );
            
            // Extract sizes for the orders being rotated
            // For SELL: sizes are [smallest, ..., largest] → take from END (largest)
            // For BUY: sizes are [largest, ..., smallest] → take from BEGINNING (largest)
            if (side === 'sell') {
                geometricSizes = sizedOrders.slice(-orderCount).map(o => o.size);
            } else {
                geometricSizes = sizedOrders.slice(0, orderCount).map(o => o.size);
            }
            
            const totalGeometric = geometricSizes.reduce((s, v) => s + (Number(v) || 0), 0);
            const totalAllSlots = sizedOrders.reduce((s, o) => s + (Number(o.size) || 0), 0);
            const weight = side === 'buy' ? this.config.weightDistribution?.buy : this.config.weightDistribution?.sell;

            // DEBUG: show detailed geometric calculation
            try {
                this.logger?.log?.(
                    `DEBUG Rotation Details: side=${side}, totalSlots=${totalSlots} (ACTIVE+VIRTUAL), weight=${weight}, orderCount=${orderCount}`,
                    'debug'
                );
                this.logger?.log?.(
                    `DEBUG Funds: chainSnapshot=${totalFunds.toFixed(8)}`,
                    'debug'
                );
                const allSlotsSized = sizedOrders.map(o => Number(o.size).toFixed(8));
                const allSlotsDisplay = allSlotsSized.length > 1 ? `[${allSlotsSized[0]}, ... ${allSlotsSized[allSlotsSized.length - 1]}]` : `[${allSlotsSized.join(', ')}]`;
                this.logger?.log?.(
                    `DEBUG AllSlots: ${allSlotsDisplay}, sum=${totalAllSlots.toFixed(8)}`,
                    'debug'
                );
                const geometricSized = geometricSizes.map(s => Number(s).toFixed(8));
                const geometricDisplay = geometricSized.length > 1 ? `[${geometricSized[0]}, ... ${geometricSized[geometricSized.length - 1]}]` : `[${geometricSized.join(', ')}]`;
                this.logger?.log?.(
                    `DEBUG Rotation: geometric=${geometricDisplay}, totalGeometric=${totalGeometric.toFixed(8)}`,
                    'debug'
                );
            } catch (e) { this.logger?.log?.(`Warning: failed to log rotation geometric details: ${e.message}`, 'warn'); }

            if (totalGeometric > 0 && totalGeometric > availableFunds) {
                // Scale down all geometric sizes proportionally so the total equals availableFunds
                const scale = availableFunds / totalGeometric;
                for (let i = 0; i < orderCount; i++) {
                    const g = geometricSizes[i] !== undefined ? geometricSizes[i] : 0;
                    const allocated = g * scale;
                    allocatedSizes.push(allocated);
                    allocatedSum += allocated;
                }
                try { const allocSized = allocatedSizes.map(s => Number(s).toFixed(8)); const allocDisplay = allocSized.length > 1 ? `[${allocSized[0]}, ... ${allocSized[allocSized.length - 1]}]` : `[${allocSized.join(', ')}]`; this.logger?.log?.(`DEBUG Rotation Scaled Allocated: ${allocDisplay}, sum=${allocatedSum.toFixed(8)}`, 'debug'); } catch (e) { this.logger?.log?.(`Warning: failed to log scaled allocated sizes: ${e.message}`, 'warn'); }
            } else {
                // Use geometric sizes as-is (may sum to less than availableFunds)
                for (let i = 0; i < orderCount; i++) {
                    const g = geometricSizes[i] !== undefined ? geometricSizes[i] : 0;
                    allocatedSizes.push(g);
                    allocatedSum += g;
                }
                try { const allocSized = allocatedSizes.map(s => Number(s).toFixed(8)); const allocDisplay = allocSized.length > 1 ? `[${allocSized[0]}, ... ${allocSized[allocSized.length - 1]}]` : `[${allocSized.join(', ')}]`; this.logger?.log?.(`DEBUG Rotation Allocated (unscaled): ${allocDisplay}, sum=${allocatedSum.toFixed(8)}`, 'debug'); } catch (e) { this.logger?.log?.(`Warning: failed to log allocated sizes: ${e.message}`, 'warn'); }
            }
        }

        // Determine surplus (availableFunds unallocated after sizing) and add to cacheFunds only if positive
        let surplus = 0;
        const EPS = 1e-12;
        if (availableFunds - allocatedSum > EPS) {
            surplus = availableFunds - allocatedSum;
            try { this.logger?.log?.(`DEBUG Rotation Surplus: available=${availableFunds.toFixed(8)}, allocated=${allocatedSum.toFixed(8)}, surplus=${surplus.toFixed(8)}`, 'debug'); } catch (e) { this.logger?.log?.(`Warning: failed to log rotation surplus: ${e.message}`, 'warn'); }
            const oldCacheFundsValue = this.funds.cacheFunds[side] || 0;
            const newCacheFundsValue = oldCacheFundsValue + surplus;
            this.funds.cacheFunds[side] = newCacheFundsValue;
            this.logger.log(`Allocated sum (${allocatedSum.toFixed(8)}) smaller than available (${availableFunds.toFixed(8)}). Adding surplus ${surplus.toFixed(8)} to cacheFunds.${side}`, 'info');

            // Persist cacheFunds and trigger grid comparison when value changes
            let accountDb = null;
            try {
                const { AccountOrders } = require('../account_orders');
                if (this.config && this.config.botKey) {
                    accountDb = this.accountOrders || new AccountOrders({ profilesPath: this.config.profilesPath });
                    accountDb.updateCacheFunds(this.config.botKey, this.funds.cacheFunds);
                    this.logger.log(`Persisted cacheFunds.${side} = ${newCacheFundsValue.toFixed(8)}`, 'debug');
                }

                // Centralized grid comparison trigger after cacheFunds change:
                // 1. First check: simple percentage-based (GRID_REGENERATION_PERCENTAGE)
                // 2. If simple check passes, update order sizes and skip expensive quadratic comparison
                // 3. If simple check fails, run expensive quadratic comparison (DIVERGENCE_THRESHOLD_Percent)
                if (accountDb) {
                    const Grid = require('./grid');

                    // Step 1: Simple percentage-based check
                    const simpleCheckResult = Grid.checkAndUpdateGridIfNeeded(this, this.funds.cacheFunds);

                    // Step 2: If simple check didn't trigger, run expensive quadratic comparison
                    if (!simpleCheckResult.buyUpdated && !simpleCheckResult.sellUpdated) {
                        const persistedGrid = accountDb.loadBotGrid(this.config.botKey) || [];
                        const calculatedGrid = Array.from(this.orders.values());

                        const comparisonResult = Grid.compareGrids(calculatedGrid, persistedGrid, this, this.funds.cacheFunds);

                        if (comparisonResult.buy.metric > 0 || comparisonResult.sell.metric > 0) {
                            this.logger.log(
                                `Grid divergence detected after cacheFunds change: buy=${comparisonResult.buy.metric.toFixed(6)}, sell=${comparisonResult.sell.metric.toFixed(6)}`,
                                'info'
                            );
                        }
                    }
                }
            } catch (err) {
                this.logger?.log && this.logger.log(
                    `Warning: Could not persist/compare grid after cacheFunds update: ${err.message}`,
                    'warn'
                );
            }
        }

        // Track remaining funds locally since this.funds.available gets reset by recalculateFunds
        let remainingFunds = Math.max(0, availableFunds - allocatedSum - surplus);

        for (let i = 0; i < ordersToProcess.length; i++) {
            const oldOrder = ordersToProcess[i];
            // Always consume the next spread slot for price (shift band toward market)
            const priceSource = eligibleSpreadOrders.shift();
            if (!priceSource) break; // no slot available

            const targetGridId = priceSource.id;
            const targetPrice = priceSource.price;

            // Use precomputed allocatedSizes (capped geometric or simple distribution)
            let newSize = (allocatedSizes.length > i) ? allocatedSizes[i] : simpleDistribution;
            if (newSize <= 0) {
                this.logger.log(`No available funds for rotation, skipping`, 'warn');
                continue;
            }

            // Create the rotation info
            const rotation = {
                oldOrder: {
                    id: oldOrder.id,
                    orderId: oldOrder.orderId,
                    type: oldOrder.type,
                    price: oldOrder.price,
                    size: oldOrder.size
                },
                newPrice: targetPrice,
                newSize: newSize,
                newGridId: targetGridId,
                type: targetType
            };

            // Convert the slot to the target type (will become ACTIVE after chain confirm)
            const updatedOrder = { ...priceSource, id: targetGridId, type: targetType, size: newSize, state: ORDER_STATES.VIRTUAL, price: targetPrice };
            this._updateOrder(updatedOrder);
            this.currentSpreadCount--;

            // Track remaining funds locally
            remainingFunds = Math.max(0, remainingFunds - newSize);

            // Move old order from committed.grid to virtuel
            const oldSize = Number(oldOrder.size) || 0;
            this.funds.committed.grid[side] = Math.max(0, this.funds.committed.grid[side] - oldSize);
            this.funds.virtuel[side] += oldSize;

            // Track this orderId as being rotated to prevent double-rotation
            if (oldOrder.orderId) {
                this._recentlyRotatedOrderIds.add(oldOrder.orderId);
            }

            rotations.push(rotation);
            this.logger.log(`Prepared ${targetType} rotation: old ${oldOrder.orderId} @ ${oldOrder.price.toFixed(4)} -> ${targetGridId} @ ${targetPrice.toFixed(4)}, size ${newSize.toFixed(8)}`, 'debug');
        }

        // Set final available funds (after recalculateFunds might have reset it)
        this.funds.available[side] = remainingFunds;

        return rotations;
    }

    /**
     * Complete the order rotation after blockchain confirmation.
     * Marks the old order position as VIRTUAL (returns it to the grid).
     * The type (BUY/SELL) is preserved - only the state changes to VIRTUAL.
     * 
     * @param {Object} oldOrderInfo - Info about the old order { id, orderId, type, price, size }
     */
    completeOrderRotation(oldOrderInfo) {
        const order = this.orders.get(oldOrderInfo.id);
        if (order) {
            // Return the old order position to VIRTUAL state, keeping the same type and size.
            // The order keeps its original grid size so it can be re-activated later when price moves back.
            // No funds adjustment here - the old order's committed funds were already released when it was cancelled,
            // and the new order's funds were committed in prepareFurthestOrdersForRotation.
            const virtualOrder = { ...order, state: ORDER_STATES.VIRTUAL, orderId: null };
            this._updateOrder(virtualOrder);
            this.logger.log(`Rotated order ${oldOrderInfo.id} (${oldOrderInfo.type}) at price ${oldOrderInfo.price.toFixed(4)} -> VIRTUAL (size preserved: ${order.size?.toFixed(8) || 0})`, 'info');

            // Clear this orderId from recently rotated tracking (rotation complete)
            if (oldOrderInfo.orderId) {
                this._recentlyRotatedOrderIds.delete(oldOrderInfo.orderId);
            }
        }
    }

    /**
     * Prepare a partial order to move X grid slots toward market/spread.
     * The order keeps its current size but gets a new price closer to spread.
     * This makes room for rotated orders coming in from the furthest active position.
     *
     * @param {Object} partialOrder - The partial order to move
     * @param {number} gridSlotsToMove - Number of grid positions to move toward market
     * @param {Set} reservedGridIds - Grid IDs that will be consumed by rotations/placements in this batch (avoid landing here)
     * @returns {Object|null} Move info { partialOrder, newGridId, newPrice, newMinToReceive } or null if cannot move
     */
    preparePartialOrderMove(partialOrder, gridSlotsToMove, reservedGridIds = new Set()) {
        if (!partialOrder || gridSlotsToMove <= 0) return null;

        // Ensure we have a valid orderId to move
        if (!partialOrder.orderId) {
            this.logger.log(`Cannot move partial order ${partialOrder.id} - missing orderId`, 'warn');
            return null;
        }

        // Parse grid position from ID (e.g., "sell-67" -> { side: "sell", pos: 67 })
        const match = partialOrder.id.match(/^(sell|buy)-(\d+)$/);
        if (!match) {
            this.logger.log(`Cannot parse grid position from order id: ${partialOrder.id}`, 'warn');
            return null;
        }

        const orderSide = match[1];
        const currentPosition = parseInt(match[2], 10);

        // Walk toward market by the requested number of grid slots.
        const direction = orderSide === 'sell' ? 1 : -1; // sells increase index toward spread; buys decrease index
        const startPosition = currentPosition + (direction * gridSlotsToMove);
        if (startPosition < 0) {
            this.logger.log(`Cannot move ${partialOrder.id} by ${gridSlotsToMove} - would go below index 0`, 'warn');
            return null;
        }

        const newGridId = `${orderSide}-${startPosition}`;
        const targetGridOrder = this.orders.get(newGridId);

        if (!targetGridOrder) {
            this.logger.log(`Target grid slot ${newGridId} does not exist (edge of grid)`, 'warn');
            return null;
        }

        if (reservedGridIds.has(newGridId)) {
            this.logger.log(`Target grid slot ${newGridId} is reserved for rotation/placement - skipping partial move`, 'warn');
            return null;
        }

        // Only allow moving into the exact requested virtual slot.
        if (targetGridOrder.state !== ORDER_STATES.VIRTUAL) {
            this.logger.log(`Target grid slot ${newGridId} is not virtual (state=${targetGridOrder.state}) - skipping partial move`, 'warn');
            return null;
        }

        const newPrice = targetGridOrder.price;

        // Keep the partial order's current size (what's on chain)
        let newMinToReceive;
        if (partialOrder.type === ORDER_TYPES.SELL) {
            // SELL: size is base asset, receive quote asset
            newMinToReceive = partialOrder.size * newPrice;
        } else {
            // BUY: size is quote asset, receive base asset
            newMinToReceive = partialOrder.size / newPrice;
        }

        this.logger.log(
            `Prepared partial ${partialOrder.type} move: ${partialOrder.id} (${partialOrder.orderId}) ` +
            `price ${partialOrder.price.toFixed(4)} -> ${newPrice.toFixed(4)} (slot ${newGridId})`,
            'info'
        );

        return {
            partialOrder: {
                id: partialOrder.id,
                orderId: partialOrder.orderId,
                type: partialOrder.type,
                price: partialOrder.price,
                size: partialOrder.size
            },
            newGridId,
            newPrice,
            newMinToReceive,
            targetGridOrder,
            vacatedGridId: partialOrder.id,
            vacatedPrice: partialOrder.price
        };
    }

    /**
     * Complete the partial order move after blockchain confirmation.
     * Updates the grid state: old slot becomes VIRTUAL, new slot gets the partial order.
     *
     * @param {Object} moveInfo - Info about the move from preparePartialOrderMove
     */
    completePartialOrderMove(moveInfo) {
        const { partialOrder, newGridId, newPrice } = moveInfo;

        // Old slot becomes virtual again
        const oldGridOrder = this.orders.get(partialOrder.id);
        if (oldGridOrder) {
            const updatedOld = {
                ...oldGridOrder,
                state: ORDER_STATES.VIRTUAL,
                orderId: null,
                size: 0
            };
            this._updateOrder(updatedOld);
        }

        // New slot becomes PARTIAL with the moved order (still partial filled)
        // Also set the type to match the partial order's type (it may be moving into a spread slot)
        const targetGridOrder = this.orders.get(newGridId);
        if (targetGridOrder) {
            const updatedNew = {
                ...targetGridOrder,
                type: partialOrder.type,  // Preserve the partial order's type (buy/sell)
                state: ORDER_STATES.PARTIAL,
                orderId: partialOrder.orderId,
                size: partialOrder.size,
                price: newPrice
            };
            this._updateOrder(updatedNew);
        }

        this.logger.log(`Partial move complete: ${partialOrder.id} -> ${newGridId} at price ${newPrice.toFixed(4)}`, 'info');
    }

    /**
     * Activate spread placeholder orders as buy/sell orders.
     * Selects eligible spread orders closest to market price,
     * allocates funds evenly, and transitions them to ACTIVE state.
     * 
     * @param {string} targetType - ORDER_TYPES.BUY or SELL
     * @param {number} count - Number of orders to activate
     * @returns {Array} Array of newly activated order objects for on-chain placement
     */
    async activateSpreadOrders(targetType, count) {
        if (count <= 0) return 0;
        const allSpreadOrders = this.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);
        const spreadOrders = allSpreadOrders
            .filter(o => (targetType === ORDER_TYPES.BUY && o.price < this.config.marketPrice) || (targetType === ORDER_TYPES.SELL && o.price > this.config.marketPrice))
            // Selection rule:
            // - For BUY activation: choose the SPREAD entries with the lowest prices first (furthest from market below price)
            // - For SELL activation: choose the SPREAD entries with the highest prices first (furthest from market above price)
            // This ensures newly created buy orders use the lowest available spread price and sells use the highest.
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);
        const availableFunds = this.calculateAvailableFunds(targetType === ORDER_TYPES.BUY ? 'buy' : 'sell');
        if (availableFunds <= 0) { this.logger.log(`No available funds to create ${targetType} orders`, 'warn'); return []; }
        let desiredCount = Math.min(count, spreadOrders.length);
        if (desiredCount <= 0) {
            this.logger.log(`No SPREAD orders available for ${targetType} (total spreads: ${allSpreadOrders.length}, eligible at ${targetType === ORDER_TYPES.BUY ? 'below' : 'above'} market price ${this.config.marketPrice}: ${spreadOrders.length})`, 'warn');
            return [];
        }
        const minSize = getMinOrderSize(targetType, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const maxByFunds = minSize > 0 ? Math.floor(availableFunds / minSize) : desiredCount;
        const ordersToCreate = Math.max(0, Math.min(desiredCount, maxByFunds || desiredCount));
        if (ordersToCreate === 0) { this.logger.log(`Insufficient funds to create any ${targetType} orders (available=${availableFunds}, minOrderSize=${minSize})`, 'warn'); return []; }
        const actualOrders = spreadOrders.slice(0, ordersToCreate);
        const fundsPerOrder = availableFunds / actualOrders.length;
        if (fundsPerOrder < minSize) { this.logger.log(`Available funds insufficient for requested orders after adjustment: fundsPerOrder=${fundsPerOrder} < minOrderSize=${minSize}`, 'warn'); return []; }
        const activatedOrders = [];
        actualOrders.forEach(order => {
            if (fundsPerOrder <= 0) return;
            const activatedOrder = { ...order, type: targetType, size: fundsPerOrder, state: ORDER_STATES.ACTIVE };
            this._updateOrder(activatedOrder);
            activatedOrders.push(activatedOrder);
            this.currentSpreadCount--;
            this.logger.log(`Prepared ${targetType} order at ${order.price.toFixed(2)} (Amount: ${fundsPerOrder.toFixed(8)})`, 'info');
        });
        return activatedOrders;
    }

    /**
     * Calculate the current percentage spread between best bid and ask.
     * Uses active orders if available, falls back to virtual orders.
     * @returns {number} Spread percentage (e.g., 5.0 for 5%)
     */
    calculateCurrentSpread() {
        const activeBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        const virtualBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL);
        const virtualSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL);
        const pickBestBuy = () => { if (activeBuys.length) return Math.max(...activeBuys.map(o => o.price)); if (virtualBuys.length) return Math.max(...virtualBuys.map(o => o.price)); return null; };
        const pickBestSell = () => { if (activeSells.length) return Math.min(...activeSells.map(o => o.price)); if (virtualSells.length) return Math.min(...virtualSells.map(o => o.price)); return null; };
        const bestBuy = pickBestBuy(); const bestSell = pickBestSell(); if (bestBuy === null || bestSell === null || bestBuy === 0) return 0; return ((bestSell / bestBuy) - 1) * 100;
    }

    /**
     * Log a comprehensive status summary to the console.
     * Displays: market, funds, order counts, spread info.
     */
    // Full status display moved to Logger; use this.logger.displayStatus(this)
}

module.exports = { OrderManager };

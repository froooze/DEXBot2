/**
 * DEXBot - Core trading bot class
 * Shared implementation used by both bot.js (single bot) and dexbot.js (multi-bot orchestration)
 *
 * This class handles:
 * - Bot initialization and account setup
 * - Order placement and batch operations
 * - Fill processing and synchronization
 * - Grid rebalancing and rotation
 * - Divergence detection and correction
 */

const fs = require('fs');
const path = require('path');
const { BitShares, waitForConnected } = require('./bitshares_client');
const chainKeys = require('./chain_keys');
const chainOrders = require('./chain_orders');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./order');
const { persistGridSnapshot, retryPersistenceIfNeeded, buildCreateOrderArgs, getOrderTypeFromUpdatedFlags } = OrderUtils;
const { ORDER_STATES, ORDER_TYPES, TIMING } = require('./constants');
const { attemptResumePersistedGridByPriceMatch, decideStartupGridAction, reconcileStartupOrders } = require('./order/startup_reconcile');
const { AccountOrders } = require('./account_orders');
const AsyncLock = require('./order/async_lock');

const PROFILES_BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

class DEXBot {
    /**
     * Create a new DEXBot instance
     * @param {Object} config - Bot configuration from profiles/bots.json
     * @param {Object} options - Optional settings
     * @param {string} options.logPrefix - Prefix for console logs (e.g., "[bot.js]")
     */
    constructor(config, options = {}) {
        this.config = config;
        this.account = null;
        this.privateKey = null;
        this.manager = null;
        this.accountOrders = null;  // Will be initialized in start()
        this.triggerFile = path.join(PROFILES_DIR, `recalculate.${config.botKey}.trigger`);
        this._recentlyProcessedFills = new Map();

        // Time-based configuration for fill processing (from constants.TIMING)
        this._fillDedupeWindowMs = TIMING.FILL_DEDUPE_WINDOW_MS;      // Window for deduplicating same fill events
        this._fillCleanupIntervalMs = TIMING.FILL_CLEANUP_INTERVAL_MS;  // Clean old fill records periodically

        // AsyncLock instances to prevent TOCTOU races
        // These ensure only one fill processing or divergence correction runs at a time
        this._fillProcessingLock = new AsyncLock();
        this._divergenceLock = new AsyncLock();

        this._incomingFillQueue = [];
        this.logPrefix = options.logPrefix || '';

        // Metrics for monitoring lock contention and fill processing
        this._metrics = {
            fillsProcessed: 0,
            fillProcessingTimeMs: 0,
            batchesExecuted: 0,
            lockContentionEvents: 0,
            maxQueueDepth: 0
        };

        // Shutdown state
        this._shuttingDown = false;
    }

    _log(msg) {
        if (this.logPrefix) {
            console.log(`${this.logPrefix} ${msg}`);
        } else {
            console.log(msg);
        }
    }

    _warn(msg) {
        if (this.logPrefix) {
            console.warn(`${this.logPrefix} ${msg}`);
        } else {
            console.warn(msg);
        }
    }

    /**
     * Create the fill callback for listenForFills.
     * Separated from start() to allow deferred activation after startup completes.
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @returns {Function} Async callback for processing fills
     * @private
     */
    _createFillCallback(chainOrders) {
        return async (fills) => {
            if (this.manager && !this.config.dryRun) {
                // PUSH to queue immediately (non-blocking)
                this._incomingFillQueue.push(...fills);

                // Trigger consumer (fire-and-forget: it will acquire lock if needed)
                this._consumeFillQueue(chainOrders);
                return;
            }
        };
    }

    /**
     * Consume fills from the incoming queue in a loop.
     * Protected by AsyncLock to ensure single consumer.
     * Interruptible: checks queue between steps to merge new work.
     *
     * Uses lock state to atomically prevent multiple consumers from queuing up.
     * If lock is already acquired or has waiters, this call returns immediately.
     */
    async _consumeFillQueue(chainOrders) {
        // Prevent stacking of consumer calls by checking lock state atomically
        // If lock is already processing or has queued waiters, don't queue another consumer
        if (this._fillProcessingLock.isLocked() || this._fillProcessingLock.getQueueLength() > 0) {
            this._metrics.lockContentionEvents++;
            return;
        }

        // Check shutdown state
        if (this._shuttingDown) {
            this._warn('Fill processing skipped: shutdown in progress');
            return;
        }

        try {
            await this._fillProcessingLock.acquire(async () => {
                while (this._incomingFillQueue.length > 0) {
                    const batchStartTime = Date.now();

                    // Track max queue depth
                    this._metrics.maxQueueDepth = Math.max(this._metrics.maxQueueDepth, this._incomingFillQueue.length);

                    // 1. Take snapshot of current work
                    const allFills = [...this._incomingFillQueue];
                    this._incomingFillQueue = []; // Clear buffer

                    const validFills = [];
                    const processedFillKeys = new Set();

                    // 2. Filter and Deduplicate (Standard Logic)
                    for (const fill of allFills) {
                        if (fill && fill.op && fill.op[0] === 4) {
                            const fillOp = fill.op[1];
                            if (fillOp.is_maker === false) {
                                this.manager.logger.log(`Skipping taker fill (is_maker=false)`, 'debug');
                                continue;
                            }

                            const fillKey = `${fillOp.order_id}:${fill.block_num}:${fill.id || ''}`;
                            const now = Date.now();
                            if (this._recentlyProcessedFills.has(fillKey)) {
                                const lastProcessed = this._recentlyProcessedFills.get(fillKey);
                                if (now - lastProcessed < this._fillDedupeWindowMs) {
                                    this.manager.logger.log(`Skipping duplicate fill for ${fillOp.order_id} (processed ${now - lastProcessed}ms ago)`, 'debug');
                                    continue;
                                }
                            }

                            if (processedFillKeys.has(fillKey)) continue;

                            processedFillKeys.add(fillKey);
                            this._recentlyProcessedFills.set(fillKey, now);
                            validFills.push(fill);

                            // Log info
                            const paysAmount = fillOp.pays ? fillOp.pays.amount : '?';
                            const receivesAmount = fillOp.receives ? fillOp.receives.amount : '?';
                            console.log(`\n===== FILL DETECTED =====`);
                            console.log(`Order ID: ${fillOp.order_id}`);
                            console.log(`Pays: ${paysAmount}, Receives: ${receivesAmount}`);
                            console.log(`Block: ${fill.block_num} (History ID: ${fill.id || 'N/A'})`);
                            console.log(`=========================\n`);
                        }
                    }

                    // Clean up dedupe cache (periodically remove old entries)
                    // Entries older than FILL_CLEANUP_INTERVAL_MS are removed to prevent memory leak
                    const cleanupTimestamp = Date.now();
                    let cleanedCount = 0;
                    for (const [key, timestamp] of this._recentlyProcessedFills) {
                        if (cleanupTimestamp - timestamp > this._fillCleanupIntervalMs) {
                            this._recentlyProcessedFills.delete(key);
                            cleanedCount++;
                        }
                    }
                    if (cleanedCount > 0) {
                        this.manager?.logger?.log(`Cleaned ${cleanedCount} old fill records. Remaining: ${this._recentlyProcessedFills.size}`, 'debug');
                    }

                    if (validFills.length === 0) continue; // Loop back for more

                    // 3. Sync and Collect Filled Orders
                    let allFilledOrders = [];
                    let ordersNeedingCorrection = [];
                    const fillMode = chainOrders.getFillProcessingMode();

                    const processValidFills = async (fillsToSync) => {
                        let resolvedOrders = [];
                        if (fillMode === 'history') {
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (history mode)`, 'info');
                            for (const fill of fillsToSync) {
                                const fillOp = fill.op[1];
                                const result = this.manager.syncFromFillHistory(fillOp);
                                if (result.filledOrders) resolvedOrders.push(...result.filledOrders);
                            }
                        } else {
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (open orders mode)`, 'info');
                            const chainOpenOrders = await chainOrders.readOpenOrders(this.account);
                            const result = this.manager.syncFromOpenOrders(chainOpenOrders, fillsToSync[0].op[1]);
                            if (result.filledOrders) resolvedOrders.push(...result.filledOrders);
                            if (result.ordersNeedingCorrection) ordersNeedingCorrection.push(...result.ordersNeedingCorrection);
                        }
                        return resolvedOrders;
                    };

                    allFilledOrders = await processValidFills(validFills);

                    // 4. Handle Price Corrections
                    if (ordersNeedingCorrection.length > 0) {
                        const correctionResult = await OrderUtils.correctAllPriceMismatches(
                            this.manager, this.account, this.privateKey, chainOrders
                        );
                        if (correctionResult.failed > 0) this.manager.logger.log(`${correctionResult.failed} corrections failed`, 'error');
                    }

                    // 5. Sequential Rebalance Loop (Interruptible)
                    if (allFilledOrders.length > 0) {
                        this.manager.logger.log(`Processing ${allFilledOrders.length} filled orders sequentially...`, 'info');

                        let anyRotations = false;

                        let i = 0;
                        while (i < allFilledOrders.length) {
                            const filledOrder = allFilledOrders[i];
                            i++;

                            this.manager.logger.log(`>>> Processing sequential fill for order ${filledOrder.id} (${i}/${allFilledOrders.length})`, 'info');

                            // Create an exclusion set from ALL other pending fills in the worklist
                            // to prevent the rebalancer from picking an order that is about to be processed
                            const fullExcludeSet = new Set();
                            for (const other of allFilledOrders) {
                                if (other.orderId) fullExcludeSet.add(other.orderId);
                                if (other.id) fullExcludeSet.add(other.id);
                            }

                            const rebalanceResult = await this.manager.processFilledOrders([filledOrder], fullExcludeSet);
                            const batchResult = await this.updateOrdersOnChainBatch(rebalanceResult);

                            if (batchResult.hadRotation) anyRotations = true;
                            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                            // INTERRUPT CHECK: Did new fills arrive while we broadcasted?
                            // This includes consequential fills (e.g., a newly placed buy order being filled instantly)
                            if (this._incomingFillQueue.length > 0) {
                                this.manager.logger.log(`INTERRUPT: ${this._incomingFillQueue.length} new fills detected during sequential loop! Prioritizing...`, 'info');

                                const newRawFills = [...this._incomingFillQueue];
                                this._incomingFillQueue = [];

                                const validNewFills = [];
                                for (const nf of newRawFills) {
                                    // Minimal dedupe check
                                    const nfOp = nf.op[1];
                                    const nfKey = `${nfOp.order_id}:${nf.block_num}:${nf.id || ''}`;
                                    if (this._recentlyProcessedFills.has(nfKey)) continue;

                                    this._recentlyProcessedFills.set(nfKey, Date.now());
                                    processedFillKeys.add(nfKey); // Ensure interrupt fills are persisted too
                                    validNewFills.push(nf);
                                }

                                if (validNewFills.length > 0) {
                                    const newResolved = await processValidFills(validNewFills);
                                    if (newResolved.length > 0) {
                                        // Insert new fills IMMEDIATELY after the current index (i) 
                                        // to prioritize them over the remaining original batch
                                        allFilledOrders.splice(i, 0, ...newResolved);
                                        this.manager.logger.log(`Inserted ${newResolved.length} consequential fill(s) into current worklist. Total: ${allFilledOrders.length}`, 'info');
                                    }
                                }
                            }
                        }

                        // Check spread and health after sequential rotations complete
                        if (anyRotations || allFilledOrders.length > 0) {
                            this.manager.recalculateFunds();
                            
                            const spreadResult = await this.manager.checkSpreadCondition(
                                this.BitShares,
                                this.updateOrdersOnChainBatch.bind(this)
                            );
                            if (spreadResult && spreadResult.ordersPlaced > 0) {
                                this.manager.logger.log(`✓ Spread correction after sequential fills: ${spreadResult.ordersPlaced} order(s) placed, ` +
                                    `${spreadResult.partialsMoved} partial(s) moved`, 'info');
                                persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                            }

                            // ALWAYS check grid health after fill handling
                            const healthResult = await this.manager.checkGridHealth(
                                this.updateOrdersOnChainBatch.bind(this)
                            );
                            if (healthResult.buyDust && healthResult.sellDust) {
                                persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                            }
                        }

                        // Only run divergence checks if rotation was completed
                        if (anyRotations) {
                            await this._divergenceLock.acquire(async () => {
                                await OrderUtils.runGridComparisons(this.manager, this.accountOrders, this.config.botKey);
                                if (this.manager._gridSidesUpdated && this.manager._gridSidesUpdated.length > 0) {
                                    const orderType = getOrderTypeFromUpdatedFlags(
                                        this.manager._gridSidesUpdated.includes('buy'),
                                        this.manager._gridSidesUpdated.includes('sell')
                                    );
                                    await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, false);
                                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                                }
                                await OrderUtils.applyGridDivergenceCorrections(
                                    this.manager, this.accountOrders, this.config.botKey, this.updateOrdersOnChainBatch.bind(this)
                                );
                            });
                        }
                    }

                    // Save processed fills
                    await retryPersistenceIfNeeded(this.manager);
                    if (validFills.length > 0 && this.accountOrders) {
                        try {
                            const fillsToSave = {};
                            for (const fillKey of processedFillKeys) {
                                fillsToSave[fillKey] = this._recentlyProcessedFills.get(fillKey) || Date.now();
                            }
                            await this.accountOrders.updateProcessedFillsBatch(this.config.botKey, fillsToSave);
                            this.manager.logger.log(`Persisted ${processedFillKeys.size} fill records to prevent reprocessing`, 'debug');
                        } catch (err) {
                            this.manager?.logger?.log(`Warning: Failed to persist processed fills: ${err.message}`, 'warn');
                        }
                    }

                    // Periodically clean up old fill records (10% chance per batch)
                    if (Math.random() < 0.1) {
                        try {
                            await this.accountOrders.cleanOldProcessedFills(this.config.botKey, TIMING.FILL_RECORD_RETENTION_MS);
                        } catch (err) { /* warn */ }
                    }

                    // Update metrics
                    this._metrics.fillsProcessed += validFills.length;
                    this._metrics.fillProcessingTimeMs += Date.now() - batchStartTime;

                } // End while(_incomingFillQueue)

            });
        } catch (err) {
            this._log(`Error processing fills: ${err.message}`);
            if (this.manager && this.manager.logger) {
                this.manager.logger.log(`Error processing fills: ${err.message}`, 'error');
                if (err.stack) this.manager.logger.log(err.stack, 'error');
            } else {
                console.error('CRITICAL: Error processing fills (logger unavailable):', err);
            }
        } finally {
            // Check if new fills arrived while processing the batch
            // If queue is not empty and lock is free, trigger another consumer cycle
            // Fire-and-forget with error handling to prevent uncaught exceptions in finally
            if (this._incomingFillQueue.length > 0 &&
                !this._fillProcessingLock.isLocked() &&
                this._fillProcessingLock.getQueueLength() === 0) {
                this._consumeFillQueue(chainOrders).catch(err => {
                    this._warn(`Error in finally-block consumer restart: ${err.message}`);
                });
            }
        }
    }

    async initialize(masterPassword = null) {
        await waitForConnected(30000);
        let accountData = null;
        if (this.config && this.config.preferredAccount) {
            try {
                const pwd = masterPassword || await chainKeys.authenticate();
                const privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, pwd);
                let accId = null;
                try {
                    const full = await BitShares.db.get_full_accounts([this.config.preferredAccount], false);
                    if (full && full[0]) {
                        const maybe = full[0][0];
                        if (maybe && String(maybe).startsWith('1.2.')) accId = maybe;
                        else if (full[0][1] && full[0][1].account && full[0][1].account.id) accId = full[0][1].account.id;
                    }
                } catch (e) { /* best-effort */ }

                if (accId) chainOrders.setPreferredAccount(accId, this.config.preferredAccount);
                accountData = { accountName: this.config.preferredAccount, privateKey, id: accId };
            } catch (err) {
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                // dexbot.js has fallback to selectAccount, bot.js throws
                if (typeof chainOrders.selectAccount === 'function') {
                    accountData = await chainOrders.selectAccount();
                } else {
                    throw err;
                }
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
        this.account = accountData.accountName;
        this.accountId = accountData.id || null;
        this.privateKey = accountData.privateKey;
        this._log(`Initialized DEXBot for account: ${this.account}`);
    }

    async placeInitialOrders() {
        if (!this.manager) {
            this.manager = new OrderManager(this.config);
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }
        try {
            const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await this.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch) {
            this._warn(`Could not fetch account totals before initializing grid: ${errFetch && errFetch.message ? errFetch.message : errFetch}`);
        }

        await Grid.initializeGrid(this.manager);

        if (this.config.dryRun) {
            this.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
            return;
        }

        this.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = this.manager.getInitialOrdersToActivate();

        const sellOrders = ordersToActivate.filter(o => o.type === 'sell');
        const buyOrders = ordersToActivate.filter(o => o.type === 'buy');
        const interleavedOrders = [];
        const maxLen = Math.max(sellOrders.length, buyOrders.length);
        for (let i = 0; i < maxLen; i++) {
            if (i < sellOrders.length) interleavedOrders.push(sellOrders[i]);
            if (i < buyOrders.length) interleavedOrders.push(buyOrders[i]);
        }

        const { assetA, assetB } = this.manager.assets;
        const { getAssetFees } = require('./order/utils');
        const btsFeeData = getAssetFees('BTS', 1);

        const createAndSyncOrder = async (order) => {
            this.manager.logger.log(`Placing ${order.type} order: size=${order.size}, price=${order.price}`, 'debug');
            const args = buildCreateOrderArgs(order, assetA, assetB);
            const result = await chainOrders.createOrder(
                this.account, this.privateKey, args.amountToSell, args.sellAssetId,
                args.minToReceive, args.receiveAssetId, null, false
            );
            const chainOrderId = result && result[0] && result[0].trx && result[0].trx.operation_results && result[0].trx.operation_results[0] && result[0].trx.operation_results[0][1];
            if (!chainOrderId) {
                throw new Error('Order creation response missing order_id');
            }
            await this.manager.synchronizeWithChain({
                gridOrderId: order.id,
                chainOrderId,
                fee: btsFeeData.createFee
            }, 'createOrder');
        };

        const placeOrderGroup = async (ordersGroup) => {
            const settled = await Promise.allSettled(ordersGroup.map(order => createAndSyncOrder(order)));
            settled.forEach((result, index) => {
                if (result.status === 'rejected') {
                    const order = ordersGroup[index];
                    const reason = result.reason;
                    const errMsg = reason && reason.message ? reason.message : `${reason}`;
                    this.manager.logger.log(`Failed to place ${order.type} order ${order.id}: ${errMsg}`, 'error');
                }
            });
        };

        const orderGroups = [];
        for (let i = 0; i < interleavedOrders.length;) {
            const current = interleavedOrders[i];
            const next = interleavedOrders[i + 1];
            if (next && current.type === 'sell' && next.type === 'buy') {
                orderGroups.push([current, next]);
                i += 2;
            } else {
                orderGroups.push([current]);
                i += 1;
            }
        }

        for (const group of orderGroups) {
            await placeOrderGroup(group);
        }
        persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
    }

    async updateOrdersOnChainBatch(rebalanceResult) {
        const { ordersToPlace, ordersToRotate, partialMoves = [] } = rebalanceResult;

        if (this.config.dryRun) {
            if (ordersToPlace && ordersToPlace.length > 0) {
                this.manager.logger.log(`Dry run: would place ${ordersToPlace.length} new orders on-chain`, 'info');
            }
            if (ordersToRotate && ordersToRotate.length > 0) {
                this.manager.logger.log(`Dry run: would update ${ordersToRotate.length} orders on-chain`, 'info');
            }
            if (partialMoves && partialMoves.length > 0) {
                this.manager.logger.log(`Dry run: would move ${partialMoves.length} partial order(s) on-chain`, 'info');
            }
            return;
        }

        const { assetA, assetB } = this.manager.assets;
        const operations = [];
        const opContexts = [];

        // Collect IDs to lock (shadow) during this transaction
        const idsToLock = new Set();
        if (ordersToPlace) ordersToPlace.forEach(o => idsToLock.add(o.id));
        if (ordersToRotate) ordersToRotate.forEach(r => {
            if (r.oldOrder?.orderId) idsToLock.add(r.oldOrder.orderId);
            if (r.newGridId) idsToLock.add(r.newGridId);
        });
        if (partialMoves) partialMoves.forEach(m => {
            if (m.partialOrder?.orderId) idsToLock.add(m.partialOrder.orderId);
            if (m.newGridId) idsToLock.add(m.newGridId);
        });

        // LOCK ORDERS (Shadowing)
        this.manager.lockOrders(idsToLock);

        try {
            // Step 1: Build create operations
            if (ordersToPlace && ordersToPlace.length > 0) {
                for (const order of ordersToPlace) {
                    try {
                        const args = buildCreateOrderArgs(order, assetA, assetB);
                        const op = await chainOrders.buildCreateOrderOp(
                            this.account, args.amountToSell, args.sellAssetId,
                            args.minToReceive, args.receiveAssetId, null
                        );
                        operations.push(op);
                        opContexts.push({ kind: 'create', order });
                    } catch (err) {
                        this.manager.logger.log(`Failed to prepare create op for ${order.type} order ${order.id}: ${err.message}`, 'error');
                    }
                }
            }

            // Step 2: Build update operations for partial order moves (processed before rotations for atomic swap semantics)
            if (partialMoves && partialMoves.length > 0) {
                for (const moveInfo of partialMoves) {
                    try {
                        const { partialOrder, newPrice } = moveInfo;
                        if (!partialOrder.orderId) continue;

                        const op = await chainOrders.buildUpdateOrderOp(
                            this.account, partialOrder.orderId,
                            {
                                newPrice: newPrice,
                                orderType: partialOrder.type
                            }
                        );

                        if (op) {
                            operations.push(op);
                            opContexts.push({ kind: 'partial-move', moveInfo });
                            this.manager.logger.log(
                                `Prepared partial move op: ${partialOrder.orderId} price ${partialOrder.price.toFixed(4)} -> ${moveInfo.newPrice.toFixed(4)}`,
                                'debug'
                            );
                        } else {
                            this.manager.logger.log(`No change needed for partial move of ${partialOrder.orderId}`, 'debug');
                        }
                    } catch (err) {
                        this.manager.logger.log(`Failed to prepare partial move op: ${err.message}`, 'error');
                    }
                }
            }

            // Step 3: Build update operations (rotation)
            if (ordersToRotate && ordersToRotate.length > 0) {
                const seenOrderIds = new Set();
                const uniqueRotations = ordersToRotate.filter(r => {
                    const orderId = r?.oldOrder?.orderId;
                    if (!orderId || seenOrderIds.has(orderId)) {
                        if (orderId) this.manager.logger.log(`Skipping duplicate rotation for ${orderId}`, 'debug');
                        return false;
                    }
                    seenOrderIds.add(orderId);
                    return true;
                });

                for (const rotation of uniqueRotations) {
                    try {
                        const { oldOrder, newPrice, newSize, type } = rotation;
                        if (!oldOrder.orderId) continue;

                        let newAmountToSell, newMinToReceive;
                        if (type === 'sell') {
                            newAmountToSell = newSize;
                            newMinToReceive = newSize * newPrice;
                            // Round both to their respective asset precision
                            const baseAssetPrecision = this.manager.assets?.assetA?.precision || 8;
                            const quoteAssetPrecision = this.manager.assets?.assetB?.precision || 8;
                            const baseScaleFactor = Math.pow(10, baseAssetPrecision);
                            const quoteScaleFactor = Math.pow(10, quoteAssetPrecision);
                            const newAmountToSellBeforeRound = newAmountToSell;
                            const newMinToReceiveBeforeRound = newMinToReceive;
                            newAmountToSell = Math.round(newAmountToSell * baseScaleFactor) / baseScaleFactor;
                            newMinToReceive = newAmountToSell * newPrice;
                            newMinToReceive = Math.round(newMinToReceive * quoteScaleFactor) / quoteScaleFactor;
                            this.manager.logger.log(
                                `[Rotation SELL] oldOrder=${oldOrder.orderId}, newPrice=${newPrice.toFixed(4)}, ` +
                                `newSize=${newSize.toFixed(8)} (amount before rounding=${newAmountToSellBeforeRound.toFixed(8)}, after=${newAmountToSell.toFixed(8)}), ` +
                                `minReceive before=${newMinToReceiveBeforeRound.toFixed(8)}, after=${newMinToReceive.toFixed(8)} ` +
                                `(basePrec=${baseAssetPrecision}, quotePrec=${quoteAssetPrecision})`,
                                'debug'
                            );
                        } else {
                            newAmountToSell = newSize;
                            newMinToReceive = newSize / newPrice;
                            // Round both to their respective asset precision
                            const baseAssetPrecision = this.manager.assets?.assetA?.precision || 8;
                            const quoteAssetPrecision = this.manager.assets?.assetB?.precision || 8;
                            const baseScaleFactor = Math.pow(10, baseAssetPrecision);
                            const quoteScaleFactor = Math.pow(10, quoteAssetPrecision);
                            const newAmountToSellBeforeRound = newAmountToSell;
                            const newMinToReceiveBeforeRound = newMinToReceive;
                            newAmountToSell = Math.round(newAmountToSell * quoteScaleFactor) / quoteScaleFactor;
                            newMinToReceive = newAmountToSell / newPrice;
                            newMinToReceive = Math.round(newMinToReceive * baseScaleFactor) / baseScaleFactor;
                            this.manager.logger.log(
                                `[Rotation BUY] oldOrder=${oldOrder.orderId}, newPrice=${newPrice.toFixed(4)}, ` +
                                `newSize=${newSize.toFixed(8)} (amount before rounding=${newAmountToSellBeforeRound.toFixed(8)}, after=${newAmountToSell.toFixed(8)}), ` +
                                `minReceive before=${newMinToReceiveBeforeRound.toFixed(8)}, after=${newMinToReceive.toFixed(8)} ` +
                                `(basePrec=${baseAssetPrecision}, quotePrec=${quoteAssetPrecision})`,
                                'debug'
                            );
                        }

                        const op = await chainOrders.buildUpdateOrderOp(
                            this.account, oldOrder.orderId,
                            { 
                                amountToSell: newAmountToSell, 
                                minToReceive: newMinToReceive,
                                newPrice: newPrice,
                                orderType: type
                            }
                        );

                        if (op) {
                            operations.push(op);
                            opContexts.push({ kind: 'rotation', rotation });
                        } else {
                            // CRITICAL: If buildUpdateOrderOp returns null (no change detected due to precision),
                            // we must NOT add this to operations. The rotation will NOT be marked complete,
                            // preventing a loop where available funds trigger threshold but never get consumed.
                            this.manager.logger.log(`Skipping rotation of ${oldOrder.orderId}: no blockchain change needed (precision tolerance)`, 'debug');
                        }
                    } catch (err) {
                        this.manager.logger.log(`Failed to prepare update op for rotation: ${err.message}`, 'error');
                    }
                }
            }

            if (operations.length === 0) {
                return { executed: false, hadRotation: false };  // No batch executed
            }

            // Step 4: Execute Batch
            let hadRotation = false;
            let updateOperationCount = 0;  // Track update operations for fee accounting
            try {
                this.manager.logger.log(`Broadcasting batch with ${operations.length} operations...`, 'info');
                const result = await chainOrders.executeBatch(this.account, this.privateKey, operations);

                // Step 5: Map results in operation order (supports atomic partial-move + rotation swaps)
                const results = (result && result[0] && result[0].trx && result[0].trx.operation_results) || [];
                const { getAssetFees } = require('./order/utils');
                const btsFeeData = getAssetFees('BTS', 1);

                for (let i = 0; i < opContexts.length; i++) {
                    const ctx = opContexts[i];
                    const res = results[i];

                    if (ctx.kind === 'create') {
                        const { order } = ctx;
                        const chainOrderId = res && res[1];
                        if (chainOrderId) {
                            await this.manager.synchronizeWithChain({
                                gridOrderId: order.id,
                                chainOrderId,
                                fee: btsFeeData.createFee
                            }, 'createOrder');
                            this.manager.logger.log(`Placed ${order.type} order ${order.id} -> ${chainOrderId}`, 'info');
                        } else {
                            this.manager.logger.log(`Batch result missing ID for created order ${order.id}`, 'warn');
                        }
                        continue;
                    }

                    if (ctx.kind === 'partial-move') {
                        const { moveInfo } = ctx;
                        this.manager.completePartialOrderMove(moveInfo);
                        await this.manager.synchronizeWithChain(
                            {
                                gridOrderId: moveInfo.newGridId,
                                chainOrderId: moveInfo.partialOrder.orderId,
                                fee: btsFeeData.updateFee
                            },
                            'createOrder'
                        );
                        this.manager.logger.log(
                            `Partial move complete: ${moveInfo.partialOrder.orderId} moved to ${moveInfo.newPrice.toFixed(4)}`,
                            'info'
                        );
                        updateOperationCount++;  // Count as update operation
                        continue;
                    }

                    if (ctx.kind === 'rotation') {
                        // Skip rotation if we're running divergence corrections (prevents feedback loops)
                        // Check if divergence lock is currently processing (locked or queued)
                        if (this._divergenceLock?.isLocked() || this._divergenceLock?.getQueueLength() > 0) {
                            this.manager.logger.log(`Skipping rotation during divergence correction phase: ${ctx.rotation?.oldOrder?.orderId}`, 'debug');
                            continue;
                        }

                        hadRotation = true;
                        const { rotation } = ctx;
                        const { oldOrder, newPrice, newGridId, newSize } = rotation;

                        // SIZE-CORRECTION rotations (divergence/threshold triggered) don't have newGridId
                        // They just resize existing on-chain orders - grid slots already have correct prices/sizes
                        // Don't create synthetic slots with undefined id which corrupts the grid
                        if (!newGridId) {
                            // Just mark the rotation complete and count the update
                            this.manager.completeOrderRotation(oldOrder);
                            const sizeStr = (newSize !== undefined && newSize !== null && Number.isFinite(newSize))
                                ? newSize.toFixed(8) : 'N/A';
                            const priceStr = (newPrice !== undefined && newPrice !== null && Number.isFinite(newPrice))
                                ? newPrice.toFixed(4) : 'N/A';
                            this.manager.logger.log(`Size correction applied: ${oldOrder.orderId} resized to ${sizeStr} @ ${priceStr}`, 'info');

                            // Optimistically deduct the update fee if BTS is the pair asset
                            if (this.manager.config.assetA === 'BTS' || this.manager.config.assetB === 'BTS') {
                                const btsSide = (this.manager.config.assetA === 'BTS') ? 'sell' : 'buy';
                                const orderType = (btsSide === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
                                this.manager._deductFromChainFree(orderType, btsFeeData.updateFee, 'resize-fee');
                            }

                            updateOperationCount++;
                            continue;
                        }

                        // FILL-TRIGGERED rotations have newGridId - update target grid slot
                        const actualSize = newSize;  // Use the rounded newAmountToSell/newMinToReceive
                        const slot = this.manager.orders.get(newGridId) || { id: newGridId, type: rotation.type, price: newPrice, size: 0, state: ORDER_STATES.VIRTUAL };

                        // Detect if rotation was placed with partial proceeds (size < grid slot size)
                        const isPartialPlacement = slot.size > 0 && actualSize < slot.size;

                        // CRITICAL: Complete old rotation BEFORE updating new slot state
                        // This ensures if synchronization fails, old order is properly marked complete
                        this.manager.completeOrderRotation(oldOrder);

                        // Update the target grid slot with actual size and price from rotation
                        // NOTE: state=VIRTUAL, orderId=null initially - synchronizeWithChain will update to ACTIVE+orderId
                        const updatedSlot = {
                            ...slot,
                            id: newGridId,
                            type: rotation.type,
                            size: actualSize,
                            price: newPrice,
                            state: ORDER_STATES.VIRTUAL,
                            orderId: null
                        };
                        this.manager._updateOrder(updatedSlot);

                        // Synchronize new grid slot with blockchain (MUST succeed or grid is inconsistent)
                        try {
                            await this.manager.synchronizeWithChain({
                                gridOrderId: newGridId,
                                chainOrderId: oldOrder.orderId,
                                isPartialPlacement,
                                fee: btsFeeData.updateFee
                            }, 'createOrder');
                            this.manager.logger.log(`Order size updated: ${oldOrder.orderId} new price ${newPrice.toFixed(4)}, new size ${actualSize.toFixed(8)}`, 'info');
                            updateOperationCount++;  // Count as update operation
                        } catch (err) {
                            this.manager.logger.log(
                                `ERROR: Synchronization failed for rotation ${oldOrder.orderId} -> ${newGridId}: ${err.message}. ` +
                                `Grid slot stuck in VIRTUAL state. Manual recovery may be needed.`,
                                'error'
                            );
                            // NOTE: Grid is now inconsistent - slot has size but no orderId and state=VIRTUAL
                            // This should trigger grid reconciliation on next sync to recover
                        }
                    }
                }

                // Account for BTS update fees paid during batch operations
                // Only if BTS is in the trading pair (reuses btsFeeData from line 664)
                if (updateOperationCount > 0 && (this.manager.config.assetA === 'BTS' || this.manager.config.assetB === 'BTS')) {
                    try {
                        const totalUpdateFees = btsFeeData.updateFee * updateOperationCount;

                        this.manager.funds.btsFeesOwed += totalUpdateFees;
                        this.manager.logger.log(
                            `BTS update fees for batch: ${updateOperationCount} update operations × ${btsFeeData.updateFee.toFixed(8)} = +${totalUpdateFees.toFixed(8)} BTS (total owed: ${this.manager.funds.btsFeesOwed.toFixed(8)} BTS)`,
                            'info'
                        );

                        // Persist the updated fees owed
                        await this.manager._persistBtsFeesOwed();
                    } catch (err) {
                        this.manager.logger.log(`Warning: Could not account for BTS update fees: ${err.message}`, 'warn');
                    }
                }

            } catch (err) {
                this.manager.logger.log(`Batch transaction failed: ${err.message}`, 'error');
                return { executed: false, hadRotation: false };
            }

            // Track batch metrics
            this._metrics.batchesExecuted++;

            return { executed: true, hadRotation };  // Return whether batch executed and if rotation happened
        } finally {
            // UNLOCK ORDERS (release shadowing)
            this.manager.unlockOrders(idsToLock);
        }
    }


    async start(masterPassword = null) {
        await this.initialize(masterPassword);

        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });

        // Load persisted processed fills to prevent reprocessing after restart
        // This prevents double-deduction of fees if fills are reprocessed
        const persistedFills = this.accountOrders.loadProcessedFills(this.config.botKey);
        for (const [fillKey, timestamp] of persistedFills) {
            this._recentlyProcessedFills.set(fillKey, timestamp);
        }
        if (persistedFills.size > 0) {
            this._log(`Loaded ${persistedFills.size} persisted fill records to prevent reprocessing`);
        }

        // Ensure bot metadata is properly initialized in storage BEFORE any Grid operations
        const { parseJsonWithComments } = require('./account_bots');
        const { createBotKey } = require('./account_orders');

        const normalizeBotEntry = (entry, index = 0) => {
            const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
            return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
        };

        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        const allActiveBots = allBotsConfig
            .filter(b => b.active !== false)
            .map((b, idx) => normalizeBotEntry(b, idx));

        await this.accountOrders.ensureBotEntries(allActiveBots);

        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;  // Enable cacheFunds persistence
        }

        // Fetch account totals from blockchain at startup to initialize funds
        try {
            if (this.accountId && this.config.assetA && this.config.assetB) {
                await this.manager._initializeAssets();
                await this.manager.fetchAccountTotals(this.accountId);
                this._log('Fetched blockchain account balances at startup');
            }
        } catch (err) {
            this._warn(`Failed to fetch account totals at startup: ${err.message}`);
        }

        // Ensure fee cache is initialized before any fill processing that calls getAssetFees().
        try {
            await OrderUtils.initializeFeeCache([this.config || {}], BitShares);
        } catch (err) {
            this._warn(`Fee cache initialization failed: ${err.message}`);
        }

        const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey);
        const persistedCacheFunds = this.accountOrders.loadCacheFunds(this.config.botKey);
        const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed(this.config.botKey);

        // Restore and consolidate cacheFunds
        this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
        if (persistedCacheFunds) {
            this.manager.funds.cacheFunds.buy += Number(persistedCacheFunds.buy || 0);
            this.manager.funds.cacheFunds.sell += Number(persistedCacheFunds.sell || 0);
        }

        // Use this.accountId which was set during initialize()
        const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

        let shouldRegenerate = false;
        if (!persistedGrid || persistedGrid.length === 0) {
            shouldRegenerate = true;
            this._log('No persisted grid found. Generating new grid.');
        } else {
            await this.manager._initializeAssets();
            const decision = await decideStartupGridAction({
                persistedGrid,
                chainOpenOrders,
                manager: this.manager,
                logger: { log: (msg) => this._log(msg) },
                storeGrid: (orders) => {
                    // Temporarily replace manager.orders to persist the specific orders
                    const originalOrders = this.manager.orders;
                    this.manager.orders = new Map(orders.map(o => [o.id, o]));
                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                    this.manager.orders = originalOrders;
                },
                attemptResumeFn: attemptResumePersistedGridByPriceMatch,
            });
            shouldRegenerate = decision.shouldRegenerate;

            if (shouldRegenerate && chainOpenOrders.length === 0) {
                this._log('Persisted grid found, but no matching active orders on-chain. Generating new grid.');
            }
        }

        // Restore BTS fees owed ONLY if we're NOT regenerating the grid
        if (!shouldRegenerate) {
            // CRITICAL: Restore BTS fees owed from blockchain operations
            if (persistedBtsFeesOwed > 0) {
                this.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
                this._log(`✓ Restored BTS fees owed: ${persistedBtsFeesOwed.toFixed(8)} BTS`);
            }
        } else {
            this._log(`ℹ Grid regenerating - resetting cacheFunds and BTS fees to clean state`);
            this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
            this.manager.funds.btsFeesOwed = 0;
        }

        if (shouldRegenerate) {
            await this.manager._initializeAssets();
            
            // If there are existing on-chain orders, reconcile them with the new grid
            if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                this._log('Generating new grid and syncing with existing on-chain orders...');
                await Grid.initializeGrid(this.manager);
                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                await reconcileStartupOrders({
                    manager: this.manager,
                    config: this.config,
                    account: this.account,
                    privateKey: this.privateKey,
                    chainOrders,
                    chainOpenOrders,
                    syncResult,
                });
            } else {
                // No existing orders: place initial orders on-chain
                // placeInitialOrders() handles both Grid.initializeGrid() and broadcast
                this._log('Generating new grid and placing initial orders on-chain...');
                await this.placeInitialOrders();
            }
            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
        } else {
            this._log('Found active session. Loading and syncing existing grid.');
            await Grid.loadGrid(this.manager, persistedGrid);
            const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

            // Reconcile existing on-chain orders to the configured target counts.
            // This ensures activeOrders changes in bots.json are applied on restart:
            // - If user increased activeOrders (e.g., 10→20), new virtual orders activate
            // - If user decreased activeOrders (e.g., 20→10), excess orders are cancelled
            await reconcileStartupOrders({
                manager: this.manager,
                config: this.config,
                account: this.account,
                privateKey: this.privateKey,
                chainOrders,
                chainOpenOrders,
                syncResult,
            });

            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
        }

        // Check if newly fetched blockchain funds or divergence trigger a grid update at startup
        // Note: Grid checks only run if no fills are being processed
        // Since fill listener was just set up, fills should not be processing yet at startup

        // Step 1: Threshold check (available funds)
        try {
            // Only run grid checks if no fills are being processed
            if (this.manager && this.manager.orders && this.manager.orders.size > 0) {
                const gridCheckResult = Grid.checkAndUpdateGridIfNeeded(this.manager, this.manager.funds.cacheFunds);
                if (gridCheckResult.buyUpdated || gridCheckResult.sellUpdated) {
                    this._log(`Grid updated at startup due to available funds (buy: ${gridCheckResult.buyUpdated}, sell: ${gridCheckResult.sellUpdated})`);

                    // CRITICAL: First recalculate grid sizes with chain totals
                    // This updates order sizes in memory to include newly deposited funds
                    const orderType = getOrderTypeFromUpdatedFlags(gridCheckResult.buyUpdated, gridCheckResult.sellUpdated);
                    await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);

                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                    // Apply grid corrections on-chain immediately to use new funds
                    try {
                        await OrderUtils.applyGridDivergenceCorrections(
                            this.manager,
                            this.accountOrders,
                            this.config.botKey,
                            this.updateOrdersOnChainBatch.bind(this)
                        );
                        this._log(`Grid corrections applied on-chain at startup`);
                    } catch (err) {
                        this._warn(`Error applying grid corrections at startup: ${err.message}`);
                    }
                }

                // Step 2: Divergence check (only if threshold didn't trigger)
                // Detects structural mismatch between calculated and persisted grid
                if (!gridCheckResult.buyUpdated && !gridCheckResult.sellUpdated) {
                    try {
                        const persistedGrid = this.accountOrders.loadBotGrid(this.config.botKey) || [];
                        const calculatedGrid = Array.from(this.manager.orders.values());
                        const comparisonResult = Grid.compareGrids(calculatedGrid, persistedGrid, this.manager, this.manager.funds.cacheFunds);

                        if (comparisonResult.buy.updated || comparisonResult.sell.updated) {
                            this._log(`Grid divergence detected at startup: buy=${comparisonResult.buy.metric.toFixed(6)}, sell=${comparisonResult.sell.metric.toFixed(6)}`);

                            // Update grid with blockchain snapshot already fresh from initialization
                            // fromBlockchainTimer=true because blockchain was just fetched at startup (line 499)
                            const orderType = getOrderTypeFromUpdatedFlags(comparisonResult.buy.updated, comparisonResult.sell.updated);
                            await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);

                            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                            // Apply grid corrections on-chain immediately
                            try {
                                await OrderUtils.applyGridDivergenceCorrections(
                                    this.manager,
                                    this.accountOrders,
                                    this.config.botKey,
                                    this.updateOrdersOnChainBatch.bind(this)
                                );
                                this._log(`Grid divergence corrections applied on-chain at startup`);
                            } catch (err) {
                                this._warn(`Error applying divergence corrections at startup: ${err.message}`);
                            }
                        }
                    } catch (err) {
                        this._warn(`Error running divergence check at startup: ${err.message}`);
                    }
                }
            }
        } catch (err) {
            this._warn(`Error checking grid at startup: ${err.message}`);
        }

        // Check spread condition at startup (after grid operations complete)
        // Protected by _fillProcessingLock to respect AsyncLock pattern and prevent races with early fills
        // PROACTIVE: immediately corrects spread if needed, no waiting for next fill
        try {
            await this._fillProcessingLock.acquire(async () => {
                // CRITICAL: Recalculate funds before spread correction to ensure accurate available values
                // During startup, funds may be in inconsistent state until recalculated
                this.manager.recalculateFunds();

                const spreadResult = await this.manager.checkSpreadCondition(
                    this.BitShares,
                    this.updateOrdersOnChainBatch.bind(this)
                );
                if (spreadResult.ordersPlaced > 0) {
                    this._log(`✓ Spread correction at startup: ${spreadResult.ordersPlaced} order(s) placed, ` +
                        `${spreadResult.partialsMoved} partial(s) moved`);
                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                }

                // check grid health immediately after spread check
                const healthResult = await this.manager.checkGridHealth(
                    this.updateOrdersOnChainBatch.bind(this)
                );
                if (healthResult.buyDust && healthResult.sellDust) {
                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                }
            });
        } catch (err) {
            this._warn(`Error checking spread condition at startup: ${err.message}`);
        }

        /**
         * Perform a full grid resync: cancel orphan orders and regenerate grid.
         * Triggered by the presence of a `recalculate.<botKey>.trigger` file.
         * Uses AsyncLock to prevent concurrent resync/fill processing.
         */
        const performResync = async () => {
            // Use fill lock to prevent concurrent modifications during resync
            await this._fillProcessingLock.acquire(async () => {
                this._log('Grid regeneration triggered. Performing full grid resync...');
                try {
                    // 1. Reload configuration from disk to pick up any changes
                    try {
                        const { parseJsonWithComments } = require('./account_bots');
                        const { createBotKey } = require('./account_orders');
                        const content = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
                        const allBotsConfig = parseJsonWithComments(content).bots || [];
                        
                        // Find this bot by name or fallback to index if name changed? 
                        // Better: find by current name.
                        const myName = this.config.name;
                        const updatedBot = allBotsConfig.find(b => b.name === myName);
                        
                        if (updatedBot) {
                            this._log(`Reloaded configuration for bot '${myName}'`);
                            // Keep botKey and index if they were set
                            const oldKey = this.config.botKey;
                            const oldIndex = this.config.botIndex;
                            this.config = { ...updatedBot, botKey: oldKey, botIndex: oldIndex };
                            this.manager.config = { ...this.manager.config, ...this.config };
                        }
                    } catch (e) {
                        this._warn(`Failed to reload config during resync (using current settings): ${e.message}`);
                    }

                    // 2. Perform the actual grid recalculation
                    const readFn = () => chainOrders.readOpenOrders(this.accountId);
                    await Grid.recalculateGrid(this.manager, {
                        readOpenOrdersFn: readFn,
                        chainOrders,
                        account: this.account,
                        privateKey: this.privateKey,
                        config: this.config,
                    });
                    
                    // Reset cacheFunds when grid is regenerated (already handled inside recalculateGrid, but ensure local match)
                    this.manager.funds.cacheFunds = { buy: 0, sell: 0 };
                    this.manager.funds.btsFeesOwed = 0;
                    persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                    if (fs.existsSync(this.triggerFile)) {
                        fs.unlinkSync(this.triggerFile);
                        this._log('Removed trigger file.');
                    }
                } catch (err) {
                    this._log(`Error during triggered resync: ${err.message}`);
                }
            });
        };

        if (fs.existsSync(this.triggerFile)) {
            await performResync();
        }

        // Debounced watcher to avoid duplicate rapid triggers on some platforms
        let _triggerDebounce = null;
        try {
            fs.watch(PROFILES_DIR, (eventType, filename) => {
                try {
                    if (filename === path.basename(this.triggerFile)) {
                        if ((eventType === 'rename' || eventType === 'change') && fs.existsSync(this.triggerFile)) {
                            if (_triggerDebounce) clearTimeout(_triggerDebounce);
                            _triggerDebounce = setTimeout(() => {
                                _triggerDebounce = null;
                                performResync();
                            }, 200);
                        }
                    }
                } catch (err) {
                    this._warn(`fs.watch handler error: ${err && err.message ? err.message : err}`);
                }
            });
        } catch (err) {
            this._warn(`Failed to setup file watcher: ${err.message}`);
        }

        // Activate fill listener AFTER all startup operations complete
        // This prevents race conditions between startup grid operations and fill processing
        await chainOrders.listenForFills(this.account || undefined, this._createFillCallback(chainOrders));
        this._log('Fill listener activated (after startup complete)');

        // Start periodic blockchain fetch to keep blockchain variables updated
        this._setupBlockchainFetchInterval();

        // Main loop
        const loopDelayMs = Number(process.env.RUN_LOOP_MS || 5000);
        this._log(`DEXBot started. Running loop every ${loopDelayMs}ms (dryRun=${!!this.config.dryRun})`);

        (async () => {
            while (true) {
                try {
                    if (this.manager && !this.config.dryRun) {
                        // Wrap fetchOrderUpdates in fill lock to prevent concurrent modifications
                        await this._fillProcessingLock.acquire(async () => {
                            await this.manager.fetchOrderUpdates();
                        });
                    }
                } catch (err) { console.error('Order manager loop error:', err.message); }
                await new Promise(resolve => setTimeout(resolve, loopDelayMs));
            }
        })();

        console.log('DEXBot started. OrderManager running (dryRun=' + !!this.config.dryRun + ')');
    }

    /**
     * Set up periodic blockchain account balance fetch interval.
     * Fetches available funds at regular intervals to keep blockchain variables up-to-date.
     * @private
     */
    _setupBlockchainFetchInterval() {
        const { TIMING } = require('./constants');
        const intervalMin = TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN;

        // Validate the interval setting
        if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
            this._log(`Blockchain fetch interval disabled (value: ${intervalMin}). Periodic blockchain updates will not run.`);
            return;
        }

        // Validate manager and account ID
        if (!this.manager || typeof this.manager.fetchAccountTotals !== 'function') {
            this._warn('Cannot start blockchain fetch interval: manager or fetchAccountTotals method missing');
            return;
        }

        if (!this.accountId) {
            this._warn('Cannot start blockchain fetch interval: account ID not available');
            return;
        }

        // Convert minutes to milliseconds
        const intervalMs = intervalMin * 60 * 1000;

        // Set up the periodic fetch
        // Entire callback wrapped in fill lock to prevent race with fill processing
        this._blockchainFetchInterval = setInterval(async () => {
            try {
                await this._fillProcessingLock.acquire(async () => {
                    this._log(`Fetching blockchain account values (interval: every ${intervalMin}min)`);
                    await this.manager.fetchAccountTotals(this.accountId);

                    // Check if newly fetched blockchain funds trigger a grid update
                    if (this.manager && this.manager.orders && this.manager.orders.size > 0) {
                        const gridCheckResult = Grid.checkAndUpdateGridIfNeeded(this.manager, this.manager.funds.cacheFunds);
                        if (gridCheckResult.buyUpdated || gridCheckResult.sellUpdated) {
                            this._log(`Cache ratio threshold triggered grid update (buy: ${gridCheckResult.buyUpdated}, sell: ${gridCheckResult.sellUpdated})`);

                            // Divergence lock for grid updates (nested inside fill lock)
                            await this._divergenceLock.acquire(async () => {
                                // Update grid with fresh blockchain snapshot from 4-hour timer
                                const orderType = getOrderTypeFromUpdatedFlags(gridCheckResult.buyUpdated, gridCheckResult.sellUpdated);
                                await Grid.updateGridFromBlockchainSnapshot(this.manager, orderType, true);

                                persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);

                                // Apply grid corrections on-chain to use new funds
                                await OrderUtils.applyGridDivergenceCorrections(
                                    this.manager,
                                    this.accountOrders,
                                    this.config.botKey,
                                    this.updateOrdersOnChainBatch.bind(this)
                                );
                                this._log(`Grid corrections applied on-chain from periodic blockchain fetch`);
                            });
                        }

                        // Check spread condition after periodic blockchain fetch
                        // Protected by outer _fillProcessingLock - respects AsyncLock pattern
                        // PROACTIVE: immediately corrects spread if needed, no waiting for fills
                        // CRITICAL: Recalculate funds before spread correction to ensure accurate state
                        this.manager.recalculateFunds();

                        const spreadResult = await this.manager.checkSpreadCondition(
                            this.BitShares,
                            this.updateOrdersOnChainBatch.bind(this)
                        );
                        if (spreadResult.ordersPlaced > 0) {
                            this._log(`✓ Spread correction at 4h fetch: ${spreadResult.ordersPlaced} order(s) placed, ` +
                                `${spreadResult.partialsMoved} partial(s) moved`);
                            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                        }

                        // check grid health after periodic blockchain fetch
                        const healthResult = await this.manager.checkGridHealth(
                            this.updateOrdersOnChainBatch.bind(this)
                        );
                        if (healthResult.buyDust && healthResult.sellDust) {
                            persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                        }
                    }
                });
            } catch (err) {
                this._warn(`Error during periodic blockchain fetch: ${err && err.message ? err.message : err}`);
            }
        }, intervalMs);

        this._log(`Started periodic blockchain fetch interval: every ${intervalMin} minute(s)`);
    }

    /**
     * Stop the periodic blockchain fetch interval.
     * @private
     */
    _stopBlockchainFetchInterval() {
        if (this._blockchainFetchInterval !== null && this._blockchainFetchInterval !== undefined) {
            clearInterval(this._blockchainFetchInterval);
            this._blockchainFetchInterval = null;
            this._log('Stopped periodic blockchain fetch interval');
        }
    }

    /**
     * Get current metrics for monitoring and debugging.
     * @returns {Object} Metrics snapshot
     */
    getMetrics() {
        return {
            ...this._metrics,
            queueDepth: this._incomingFillQueue.length,
            fillProcessingLockActive: this._fillProcessingLock?.isLocked() || false,
            divergenceLockActive: this._divergenceLock?.isLocked() || false,
            shadowLocksActive: this.manager?.shadowOrderIds?.size || 0,
            recentFillsTracked: this._recentlyProcessedFills.size
        };
    }

    /**
     * Gracefully shutdown the bot.
     * Waits for current fill processing to complete, persists state, and stops intervals.
     * @returns {Promise<void>}
     */
    async shutdown() {
        this._log('Initiating graceful shutdown...');
        this._shuttingDown = true;

        // Stop accepting new work
        this._stopBlockchainFetchInterval();

        // Wait for current fill processing to complete
        try {
            await this._fillProcessingLock.acquire(async () => {
                this._log('Fill processing lock acquired for shutdown');

                // Log any remaining queued fills
                if (this._incomingFillQueue.length > 0) {
                    this._warn(`${this._incomingFillQueue.length} fills queued but not processed at shutdown`);
                }

                // Persist final state
                if (this.manager && this.accountOrders && this.config?.botKey) {
                    try {
                        persistGridSnapshot(this.manager, this.accountOrders, this.config.botKey);
                        this._log('Final grid snapshot persisted');
                    } catch (err) {
                        this._warn(`Failed to persist final state: ${err.message}`);
                    }
                }
            });
        } catch (err) {
            this._warn(`Error during shutdown lock acquisition: ${err.message}`);
        }

        // Log final metrics
        const metrics = this.getMetrics();
        this._log(`Shutdown complete. Final metrics: fills=${metrics.fillsProcessed}, batches=${metrics.batchesExecuted}, ` +
            `avgProcessingTime=${metrics.fillsProcessed > 0 ? (metrics.fillProcessingTimeMs / metrics.fillsProcessed).toFixed(2) : 0}ms, ` +
            `lockContentions=${metrics.lockContentionEvents}, maxQueueDepth=${metrics.maxQueueDepth}`);
    }
}

module.exports = DEXBot;

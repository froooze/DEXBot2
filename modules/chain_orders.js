/**
 * Chain Orders Module - BitShares blockchain interaction layer
 * 
 * This module provides the interface for all blockchain operations:
 * - Account selection (authentication via chain_keys.js)
 * - Reading open orders from the chain
 * - Creating, updating, and canceling limit orders
 * - Listening for fill events via subscriptions
 * - Fetching on-chain asset balances
 * 
 * All order amounts are handled as human-readable floats externally
 * and converted to blockchain integers internally using asset precision.
 */
const { BitShares, createAccountClient, waitForConnected } = require('./bitshares_client');
const { floatToBlockchainInt, blockchainToFloat, validateOrderAmountsWithinLimits } = require('./order/utils');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readlineSync = require('readline-sync');
const chainKeys = require('./chain_keys');

// Key/auth helpers provided by modules/chain_keys.js
// (authenticate(), getPrivateKey(), MasterPasswordError)

/**
 * Fill processing mode:
 * - 'history': Use fill event data directly to match order_id with account_orders (preferred, faster)
 * - 'open': Fetch open orders from blockchain and sync (backup method, more API calls)
 */
const FILL_PROCESSING_MODE = 'history';

// Resolve asset precision from id or symbol via BitShares DB; returns 0 on failure
async function _getAssetPrecision(assetRef) {
    if (!assetRef) return 0;
    try {
        if (typeof assetRef === 'string' && assetRef.match(/^1\.3\.\d+$/)) {
            if (BitShares && BitShares.db && typeof BitShares.db.get_assets === 'function') {
                const assets = await BitShares.db.get_assets([assetRef]);
                if (Array.isArray(assets) && assets[0] && typeof assets[0].precision === 'number') return assets[0].precision;
            }
        } else if (typeof assetRef === 'string') {
            if (BitShares && BitShares.db && typeof BitShares.db.lookup_asset_symbols === 'function') {
                const res = await BitShares.db.lookup_asset_symbols([assetRef]);
                if (Array.isArray(res) && res[0] && typeof res[0].precision === 'number') return res[0].precision;
            }
        }
    } catch (e) { }
    return 0;
}

// Preferred account ID and name for operations (can be changed)
let preferredAccountId = null;
let preferredAccountName = null;

/**
 * Set the preferred account for subsequent operations.
 * This allows other functions to operate without requiring account parameters.
 * @param {string} accountId - BitShares account ID (e.g., '1.2.12345')
 * @param {string} accountName - Human-readable account name
 */
function setPreferredAccount(accountId, accountName) {
    preferredAccountId = accountId;
    if (accountName) preferredAccountName = accountName;
}

/**
 * Resolve an account ID to its human-readable name via chain lookup.
 * @param {string} accountRef - Account ID (e.g., '1.2.12345') or name
 * @returns {Promise<string|null>} Account name or null if not found
 */
async function resolveAccountName(accountRef) {
    if (!accountRef) return null;
    if (typeof accountRef !== 'string') return null;
    if (!/^1\.2\./.test(accountRef)) return accountRef;
    try {
        await waitForConnected();
        const full = await BitShares.db.get_full_accounts([accountRef], false);
        if (full && full[0] && full[0][1] && full[0][1].account && full[0][1].account.name) {
            return full[0][1].account.name;
        }
    } catch (err) {
        // ignore resolution failures
    }
    return null;
}

/**
 * Resolve an account name to its ID via chain lookup.
 * @param {string} accountName - Human-readable account name
 * @returns {Promise<string|null>} Account ID or null if not found
 */
async function resolveAccountId(accountName) {
    if (!accountName) return null;
    if (typeof accountName !== 'string') return null;
    // If already in ID format, return as-is
    if (/^1\.2\.\d+$/.test(accountName)) return accountName;
    try {
        await waitForConnected();
        const full = await BitShares.db.get_full_accounts([accountName], false);
        // full[0][0] is the account name (key), full[0][1] contains account data
        if (full && full[0] && full[0][1] && full[0][1].account && full[0][1].account.id) {
            return full[0][1].account.id;
        }
    } catch (err) {
        // ignore resolution failures
    }
    return null;
}

// Track active account subscriptions so we avoid duplicate listeners per account
// Map accountName -> { userCallbacks: Set<Function>, bsCallback: Function }
const accountSubscriptions = new Map();

// Ensure a per-account BitShares subscription exists so we only subscribe once.
function _ensureAccountSubscriber(accountName) {
    if (accountSubscriptions.has(accountName)) return accountSubscriptions.get(accountName);

    const userCallbacks = new Set();

    // BitShares callback that receives raw updates and dispatches to user callbacks
    const bsCallback = (updates) => {
        // Filter for fill-related operations
        const fills = updates.filter(update => {
            const op = update.op;
            return op && op[0] === 4; // operation type 4 is fill_order
        });

        if (fills.length > 0) {
            // Call each registered user callback with the fills array
            for (const c of Array.from(userCallbacks)) {
                try { c(fills); } catch (e) { console.error('chain_orders listener error', e.message); }
            }
        }
    };

    try {
        BitShares.subscribe('account', bsCallback, accountName);
    } catch (e) { }

    const entry = { userCallbacks, bsCallback };
    accountSubscriptions.set(accountName, entry);
    return entry;
}

/**
 * Interactive account selection from stored encrypted keys.
 * Prompts user to authenticate and select an account.
 * @returns {Promise<Object>} { accountName, privateKey, id }
 */
async function selectAccount() {
    const masterPassword = await chainKeys.authenticate();
    const accountsData = chainKeys.loadAccounts();
    const accountNames = Object.keys(accountsData.accounts);

    if (accountNames.length === 0) {
        throw new Error('No accounts found. Please add accounts using modules/chain_keys.js');
    }

    console.log('Available accounts:');
    accountNames.forEach((name, index) => {
        console.log(`${index + 1}. ${name}`);
    });

    const choice = readlineSync.questionInt('Select account number: ') - 1;
    if (choice < 0 || choice >= accountNames.length) {
        throw new Error('Invalid account selection.');
    }

    const selectedAccount = accountNames[choice];
    const privateKey = chainKeys.getPrivateKey(selectedAccount, masterPassword);

    try {
        const full = await BitShares.db.get_full_accounts([selectedAccount], false);
        if (full && full[0]) {
            const candidateId = full[0][0];
            if (candidateId && String(candidateId).startsWith('1.2.')) setPreferredAccount(candidateId, selectedAccount);
            else if (full[0][1] && full[0][1].account && full[0][1].account.id) setPreferredAccount(full[0][1].account.id, selectedAccount);
        }
    } catch (e) { }

    console.log(`Selected account: ${selectedAccount} (ID: ${preferredAccountId})`);
    return { accountName: selectedAccount, privateKey: privateKey, id: preferredAccountId };
}

/**
 * Fetch all open limit orders for an account from the blockchain.
 * @param {string|null} accountId - Account ID to query (uses preferred if null)
 * @param {number} timeoutMs - Connection timeout in milliseconds
 * @returns {Promise<Array>} Array of raw order objects from chain
 */
async function readOpenOrders(accountId = null, timeoutMs = 30000, suppress_log = false) {
    await waitForConnected(timeoutMs);
    try {
        const accId = accountId || preferredAccountId;
        if (!accId) {
            throw new Error('No account selected. Please call selectAccount() first or pass an account id');
        }
        const fullAccount = await BitShares.db.get_full_accounts([accId], false);
        const orders = fullAccount[0][1].limit_orders || [];

        if (!suppress_log) {
            console.log(`Found ${orders.length} open orders for account ${accId}`);
        }
        return orders;
    } catch (error) {
        console.error('Error reading open orders:', error.message);
        throw error;
    }
}

/**
 * Subscribe to fill events for an account.
 * Calls the callback when any of the account's orders are filled.
 * 
 * @param {string|Function} accountRef - Account name/id, or callback if using preferred
 * @param {Function} callback - Function called with array of fill operations
 * @returns {Function} Unsubscribe function to stop listening
 */
async function listenForFills(accountRef, callback) {
    let userCallback = null;
    let accountToken = null;
    if (typeof accountRef === 'function' && arguments.length === 1) {
        userCallback = accountRef;
    } else {
        accountToken = accountRef;
        userCallback = callback;
    }

    if (typeof userCallback !== 'function') {
        console.error('listenForFills requires a callback function');
        return () => { };
    }

    let accountName = accountToken || preferredAccountName;
    if (!accountName && preferredAccountId) {
        accountName = await resolveAccountName(preferredAccountId);
    }
    if (!accountName && accountToken) {
        accountName = await resolveAccountName(accountToken);
    }

    if (!accountName) {
        console.error('listenForFills requires an account name or a preferredAccount to be set');
        return () => { };
    }

    let accountId = /^1\.2\./.test(accountToken || '') ? accountToken : preferredAccountId;
    if (!accountId) {
        accountId = await resolveAccountId(accountName);
    }

    if (accountId) {
        readOpenOrders(accountId, 30000, true).catch(error => console.error('Error loading account for listening:', error.message));
    } else {
        console.warn('Unable to derive account id before listening for fills; skipping open-order prefetch.');
    }

    const entry = _ensureAccountSubscriber(accountName);
    entry.userCallbacks.add(userCallback);

    console.log(`Listening for fills on account: ${accountName} (total listeners: ${entry.userCallbacks.size})`);

    return function unsubscribe() {
        try {
            entry.userCallbacks.delete(userCallback);
            if (entry.userCallbacks.size === 0) {
                try {
                    if (typeof BitShares.unsubscribe === 'function') {
                        BitShares.unsubscribe('account', entry.bsCallback, accountName);
                    }
                } catch (e) { }
                accountSubscriptions.delete(accountName);
            }
        } catch (e) {
            console.error('Error unsubscribing listenForFills', e.message);
        }
    };
}

/**
 * Build a limit_order_update operation.
 * @returns {Promise<Object|null>} Operation object or null if no change
 */
async function buildUpdateOrderOp(accountName, orderId, newParams) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    // We can't use the account client here easily for reading, but we need raw reads anyway.
    // However, existing updateOrder logic uses readOpenOrders which just needs an ID.
    const orders = await readOpenOrders(accId);
    const order = orders.find(o => o.id === orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    const sellAssetId = order.sell_price.base.asset_id;
    const receiveAssetId = order.sell_price.quote.asset_id;
    const sellPrecision = await _getAssetPrecision(sellAssetId);
    const receivePrecision = await _getAssetPrecision(receiveAssetId);

    const currentSellInt = order.for_sale;
    const currentSellFloat = blockchainToFloat(currentSellInt, sellPrecision);

    const priceRatioBase = order.sell_price.base.amount;
    const priceRatioQuote = order.sell_price.quote.amount;
    const currentReceiveInt = Math.round((currentSellInt * priceRatioQuote) / priceRatioBase);
    const currentReceiveFloat = blockchainToFloat(currentReceiveInt, receivePrecision);

    // Determine target sell amount first.
    const newSellFloat = (newParams.amountToSell !== undefined && newParams.amountToSell !== null)
        ? newParams.amountToSell
        : currentSellFloat;
    const newSellInt = floatToBlockchainInt(newSellFloat, sellPrecision);

    // Determine an initial receive amount for price-change detection.
    // Policy:
    // - If minToReceive is provided: use it as an absolute override.
    // - Else if newPrice is provided: compute receive from the new sell amount.
    // - Else: keep the existing on-chain price by scaling receive with sell.
    let candidateReceiveInt;
    if (newParams.minToReceive !== undefined && newParams.minToReceive !== null) {
        candidateReceiveInt = floatToBlockchainInt(newParams.minToReceive, receivePrecision);
    } else if (newParams.newPrice !== undefined && newParams.newPrice !== null) {
        const price = Number(newParams.newPrice);
        const receiveFloat = (newParams.orderType === 'sell')
            ? (newSellFloat * price)
            : (newSellFloat / price);
        candidateReceiveInt = floatToBlockchainInt(receiveFloat, receivePrecision);
    } else {
        candidateReceiveInt = Math.round((newSellInt * priceRatioQuote) / priceRatioBase);
    }

    // Validate amounts before converting to blockchain integers / computing deltas
    const candidateReceiveFloat = blockchainToFloat(candidateReceiveInt, receivePrecision);
    if (!validateOrderAmountsWithinLimits(newSellFloat, candidateReceiveFloat, sellPrecision, receivePrecision)) {
        throw new Error(
            `Cannot update order: calculated amounts exceed blockchain limits. ` +
            `Sell: ${newSellFloat}, Receive: ${candidateReceiveFloat}. ` +
            `This typically happens with extreme price values or mixed absolute/relative price bounds that diverge too far. ` +
            `Consider adjusting minPrice/maxPrice configuration.`
        );
    }

    // Calculate delta (new - current)
    // IMPORTANT: BitShares limit_order_update takes a delta for amount_to_sell
    // But for the new_price, it takes the NEW total amounts.
    let deltaSellInt = newSellInt - currentSellInt;

    // Check if price is actually changing (compare ratios)
    // Current price ratio: base/quote = priceRatioBase/priceRatioQuote
    // New price ratio: newSellInt/newReceiveInt
    // They're different if: currentSellInt * newReceiveInt != newSellInt * currentReceiveInt
    const priceChanged = (currentSellInt * candidateReceiveInt) !== (newSellInt * currentReceiveInt);

    // Skip update only if BOTH amount and price are unchanged
    if (deltaSellInt === 0 && !priceChanged) {
        return null;
    }

    // Enforce minimum delta: if deltaSellInt is 0 but price is changing,
    // adjust delta by ±1 toward market center to ensure meaningful update
    if (deltaSellInt === 0 && priceChanged) {
        // Determine direction toward market center:
        // For SELL orders: newReceiveInt < currentReceiveInt means moving down toward market (lower price = better for selling)
        // For BUY orders: newReceiveInt < currentReceiveInt means moving down toward market (lower price = better for buying, get more BTC for same USD)
        const isMovingTowardMarket = candidateReceiveInt < currentReceiveInt;

        if (isMovingTowardMarket) {
            // Adjust delta by +1 to push order size slightly (toward market center)
            deltaSellInt = 1;
            console.log(
                `[buildUpdateOrderOp] Delta was 0 but price changed toward market. Enforcing minimum delta: +1 ` +
                `(order ${orderId}, ${newParams.orderType}, receive ${currentReceiveInt} → ${candidateReceiveInt})`
            );
        } else {
            // Moving away from market - allow zero delta but log it
            console.log(
                `[buildUpdateOrderOp] Delta is 0 and price moving away from market. Allowing zero delta. ` +
                `(order ${orderId}, ${newParams.orderType}, receive ${currentReceiveInt} → ${candidateReceiveInt})`
            );
        }
    }

    // Adjust newSellInt to strict logic: current + delta
    const adjustedSellInt = currentSellInt + deltaSellInt;

    // Compute the final receive amount consistent with the final sell amount.
    let newReceiveInt;
    if (newParams.minToReceive !== undefined && newParams.minToReceive !== null) {
        newReceiveInt = floatToBlockchainInt(newParams.minToReceive, receivePrecision);
    } else if (newParams.newPrice !== undefined && newParams.newPrice !== null) {
        const price = Number(newParams.newPrice);
        const adjustedSellFloat = blockchainToFloat(adjustedSellInt, sellPrecision);
        const receiveFloat = (newParams.orderType === 'sell')
            ? (adjustedSellFloat * price)
            : (adjustedSellFloat / price);
        newReceiveInt = floatToBlockchainInt(receiveFloat, receivePrecision);
    } else {
        // Keep existing on-chain price ratio.
        newReceiveInt = Math.round((adjustedSellInt * priceRatioQuote) / priceRatioBase);
    }

    const adjustedSellFloat = blockchainToFloat(adjustedSellInt, sellPrecision);
    const finalReceiveFloat = blockchainToFloat(newReceiveInt, receivePrecision);
    if (!validateOrderAmountsWithinLimits(adjustedSellFloat, finalReceiveFloat, sellPrecision, receivePrecision)) {
        throw new Error(
            `Cannot update order: calculated amounts exceed blockchain limits. ` +
            `Sell: ${adjustedSellFloat}, Receive: ${finalReceiveFloat}. ` +
            `Consider adjusting minPrice/maxPrice configuration.`
        );
    }

    const op = {
        op_name: 'limit_order_update',
        op_data: {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: accId,
            order: orderId,
            new_price: {
                base: {
                    amount: adjustedSellInt,
                    asset_id: sellAssetId
                },
                quote: {
                    amount: newReceiveInt,
                    asset_id: receiveAssetId
                }
            }
        }
    };
    // Only include delta_amount_to_sell if non-zero (BitShares rejects zero delta)
    if (deltaSellInt !== 0) {
        op.op_data.delta_amount_to_sell = {
            amount: deltaSellInt,
            asset_id: sellAssetId
        };
    }
    if (newParams.expiration) op.op_data.expiration = newParams.expiration;

    return op;
}

/**
 * Update an existing limit order on the blockchain.
 */
async function updateOrder(accountName, privateKey, orderId, newParams) {
    try {
        const op = await buildUpdateOrderOp(accountName, orderId, newParams);
        if (!op) {
            console.log(`Delta is 0; skipping limit_order_update (no change to amount_to_sell)`);
            return null;
        }

        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();

        // Use explicit method call for robustness
        if (typeof tx.limit_order_update === 'function') {
            tx.limit_order_update(op.op_data);
        } else {
            // Fallback for some library versions or if method is missing
            console.warn(`tx.limit_order_update not found, trying add_operation logic or throwing`);
            if (typeof tx.add_operation === 'function') {
                // Reconstruct full op object if needed? No, btsdex add_operation usually takes ID + data
                // But let's assume limit_order_update exists if create exists
                throw new Error(`Transaction builder does not support limit_order_update`);
            }
            throw new Error(`Transaction builder does not support limit_order_update`);
        }
        await tx.broadcast();

        console.log(`Order ${orderId} updated successfully`);
        return { success: true, orderId };
    } catch (error) {
        console.error('Error updating order:', error.message);
        throw error;
    }
}

/**
 * Build a limit_order_create operation.
 */
async function buildCreateOrderOp(accountName, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    if (!expiration) {
        const now = new Date();
        now.setFullYear(now.getFullYear() + 1);
        expiration = now.toISOString().split('T')[0] + 'T23:59:59';
    }

    const sellPrecision = await _getAssetPrecision(sellAssetId);
    const receivePrecision = await _getAssetPrecision(receiveAssetId);
    const amountToSellInt = floatToBlockchainInt(amountToSell, sellPrecision);
    const minToReceiveInt = floatToBlockchainInt(minToReceive, receivePrecision);

    const op = {
        op_name: 'limit_order_create',
        op_data: {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: accId,
            amount_to_sell: { amount: amountToSellInt, asset_id: sellAssetId },
            min_to_receive: { amount: minToReceiveInt, asset_id: receiveAssetId },
            expiration: expiration,
            fill_or_kill: false,
            extensions: []
        }
    };
    return op;
}

/**
 * Create a new limit order on the blockchain.
 */
async function createOrder(accountName, privateKey, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration, dryRun = false) {
    try {
        const accId = await resolveAccountId(accountName);
        if (!accId) throw new Error(`Account ${accountName} not found`);

        if (!expiration) {
            const now = new Date();
            now.setFullYear(now.getFullYear() + 1);
            expiration = now.toISOString().split('T')[0] + 'T23:59:59';
        }

        const sellPrecision = await _getAssetPrecision(sellAssetId);
        const receivePrecision = await _getAssetPrecision(receiveAssetId);
        const amountToSellInt = floatToBlockchainInt(amountToSell, sellPrecision);
        const minToReceiveInt = floatToBlockchainInt(minToReceive, receivePrecision);

        const createParams = {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: accId,
            amount_to_sell: { amount: amountToSellInt, asset_id: sellAssetId },
            min_to_receive: { amount: minToReceiveInt, asset_id: receiveAssetId },
            expiration: expiration,
            fill_or_kill: false,
            extensions: []
        };

        if (dryRun) {
            console.log(`Dry run: Limit order prepared for account ${accountName} (not broadcasted)`);
            return { dryRun: true, params: createParams };
        }

        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();
        // Invoke standard method directly
        tx.limit_order_create(createParams);
        const result = await tx.broadcast();
        console.log(`Limit order created successfully for account ${accountName}`);
        return result;
    } catch (error) {
        console.error('Error creating limit order:', error.message);
        throw error;
    }
}

/**
 * Build a limit_order_cancel operation.
 */
async function buildCancelOrderOp(accountName, orderId) {
    const accId = await resolveAccountId(accountName);
    if (!accId) throw new Error(`Account ${accountName} not found`);

    return {
        op_name: 'limit_order_cancel',
        op_data: {
            fee: { amount: 0, asset_id: '1.3.0' },
            fee_paying_account: accId,
            order: orderId
        }
    };
}

/**
 * Cancel an existing limit order on the blockchain.
 */
async function cancelOrder(accountName, privateKey, orderId) {
    try {
        const op = await buildCancelOrderOp(accountName, orderId);

        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();
        // Explicit call
        tx.limit_order_cancel(op.op_data);
        await tx.broadcast();

        console.log(`Order ${orderId} cancelled successfully`);
        return { success: true, orderId };
    } catch (error) {
        console.error('Error cancelling order:', error.message);
        throw error;
    }
}

/**
 * Execute a batch of operations in a single transaction.
 * @param {string} accountName - Account paying fees (usually the bot account)
 * @param {string} privateKey - Private key for signing
 * @param {Array} operations - Array of operation objects { op_name, op_data } returned by build helpers
 * @returns {Promise<Object>} Transaction result
 */
async function executeBatch(accountName, privateKey, operations) {
    if (!operations || operations.length === 0) return { success: true, operations: 0 };

    try {
        console.log(`Executing batch of ${operations.length} operations for ${accountName}...`);
        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const tx = acc.newTx();

        for (const op of operations) {
            if (typeof tx[op.op_name] === 'function') {
                tx[op.op_name](op.op_data);
            } else {
                console.warn(`Transaction builder missing method for ${op.op_name}`);
                throw new Error(`Transaction builder does not support ${op.op_name}`);
            }
        }

        const result = await tx.broadcast();
        console.log(`Batch transaction broadcasted successfully.`);
        return result;
    } catch (error) {
        console.error('Error executing batch transaction:', error.message);
        throw error;
    }
}

/**
 * Fetch on-chain balances and locked amounts for the specified account and assets.
 * This helper only reads on-chain balances and open-order locks and MUST NOT be
 * mixed with the manager's internal "available for orders" calculations.
 *
 * @param {String} accountRef - account name or id
 * @param {Array<String>} assets - array of asset ids or symbols to query (e.g. ['1.3.0','IOB.XRP'])
 * @returns {Object} mapping assetRef -> { assetId, symbol, precision, freeRaw, lockedRaw, free, locked, total }
 */
async function getOnChainAssetBalances(accountRef, assets) {
    if (!accountRef) return {};
    try {
        await waitForConnected();
        // Resolve account id if name provided
        let accountId = accountRef;
        if (typeof accountRef === 'string' && !/^1\.2\./.test(accountRef)) {
            const full = await BitShares.db.get_full_accounts([accountRef], false);
            if (Array.isArray(full) && full[0] && full[0][0]) accountId = full[0][0];
        }

        // Fetch full account data so we have balances and limit_orders
        const full = await BitShares.db.get_full_accounts([accountId], false);
        if (!Array.isArray(full) || !full[0] || !full[0][1]) return {};
        const accountData = full[0][1] || {};
        const balances = accountData.balances || [];
        const limitOrders = accountData.limit_orders || [];

        // Build free balances map by asset id
        const freeInt = new Map();
        for (const b of balances) {
            const aid = String(b.asset_type || b.asset_id || b.asset);
            const val = Number(b.balance || b.amount || 0);
            freeInt.set(aid, (freeInt.get(aid) || 0) + val);
        }

        // Build locked map (for_sale) grouped by base asset id
        const lockedInt = new Map();
        for (const o of limitOrders) {
            if (!o || !o.sell_price || !o.sell_price.base) continue;
            const baseId = String(o.sell_price.base.asset_id);
            const forSale = Number(o.for_sale || 0);
            lockedInt.set(baseId, (lockedInt.get(baseId) || 0) + forSale);
        }

        // If assets omitted, build list from balances and limit_orders
        let assetList = assets;
        if (!assetList || !Array.isArray(assetList) || assetList.length === 0) {
            assetList = [];
            for (const b of balances) assetList.push(String(b.asset_type || b.asset_id || b.asset));
            for (const o of limitOrders) {
                if (!o || !o.sell_price || !o.sell_price.base) continue;
                assetList.push(String(o.sell_price.base.asset_id));
            }
            // de-duplicate
            assetList = Array.from(new Set(assetList));
        }

        const out = {};
        for (const a of assetList) {
            // resolve asset id and precision
            let aid = a;
            try {
                if (!/^1\.3\./.test(String(a))) {
                    // symbol -> asset
                    const res = await BitShares.db.lookup_asset_symbols([String(a)]).catch(() => null);
                    if (res && res[0] && res[0].id) aid = res[0].id;
                }
            } catch (e) { }

            // try to get precision and symbol
            let precision = 0; let symbol = String(a);
            try {
                const am = await BitShares.db.get_assets([aid]).catch(() => null);
                if (Array.isArray(am) && am[0]) {
                    precision = typeof am[0].precision === 'number' ? am[0].precision : precision;
                    symbol = am[0].symbol || symbol;
                }
            } catch (e) { }

            const freeRaw = freeInt.get(String(aid)) || 0;
            const lockedRaw = lockedInt.get(String(aid)) || 0;
            const free = blockchainToFloat(freeRaw, precision);
            const locked = blockchainToFloat(lockedRaw, precision);
            out[String(a)] = { assetId: String(aid), symbol, precision, freeRaw, lockedRaw, free, locked, total: free + locked };
        }

        return out;
    } catch (err) {
        return {};
    }
}

/**
 * Get the current fill processing mode.
 * @returns {string} 'history' or 'open'
 */
function getFillProcessingMode() {
    return FILL_PROCESSING_MODE;
}

module.exports = {
    selectAccount,
    setPreferredAccount,
    readOpenOrders,
    listenForFills,
    updateOrder,
    createOrder,
    cancelOrder,
    getOnChainAssetBalances,
    getFillProcessingMode,
    FILL_PROCESSING_MODE,
    buildUpdateOrderOp,
    buildCreateOrderOp,
    buildCancelOrderOp,
    executeBatch,

    // Note: authentication and key retrieval moved to modules/chain_keys.js
};

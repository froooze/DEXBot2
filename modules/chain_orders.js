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
const { floatToBlockchainInt, blockchainToFloat } = require('./order/utils');
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
    try {
        await waitForConnected();
        const full = await BitShares.db.get_full_accounts([accountName], false);
        if (full && full[0] && full[0][0]) {
            return full[0][0];
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
async function readOpenOrders(accountId = null, timeoutMs = 30000) {
    await waitForConnected(timeoutMs);
    try {
        const accId = accountId || preferredAccountId;
        if (!accId) {
            throw new Error('No account selected. Please call selectAccount() first or pass an account id');
        }
        const fullAccount = await BitShares.db.get_full_accounts([accId], false);
        const orders = fullAccount[0][1].limit_orders || [];

        console.log(`Found ${orders.length} open orders for account ${accId}`);
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
        readOpenOrders(accountId).catch(error => console.error('Error loading account for listening:', error.message));
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
 * Update an existing limit order on the blockchain.
 * Uses limit_order_update operation to modify amounts without canceling.
 * 
 * BitShares stores orders as amount_to_sell and min_to_receive.
 * This function calculates the delta internally.
 * 
 * @param {string} accountName - Account that owns the order
 * @param {string} privateKey - Private key for signing
 * @param {string} orderId - Chain order ID (e.g., '1.7.12345')
 * @param {Object} newParams - New order parameters
 * @param {number} newParams.amountToSell - New amount to sell (human units)
 * @param {number} newParams.minToReceive - New minimum to receive (human units)
 * @returns {Promise<Object|null>} Transaction result or null if no change
 */
async function updateOrder(accountName, privateKey, orderId, newParams) {
    try {
        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const orders = await readOpenOrders(acc.account.id);
        const order = orders.find(o => o.id === orderId);
        if (!order) throw new Error(`Order ${orderId} not found`);

        const sellAssetId = order.sell_price.base.asset_id;
        const receiveAssetId = order.sell_price.quote.asset_id;
        const sellPrecision = await _getAssetPrecision(sellAssetId);
        const receivePrecision = await _getAssetPrecision(receiveAssetId);

        // Current values from the order (for_sale is the remaining amount to sell)
        const currentSellInt = order.for_sale;
        const currentSellFloat = blockchainToFloat(currentSellInt, sellPrecision);

        // Calculate current min_to_receive from price ratio and for_sale
        // price ratio = quote.amount / base.amount from sell_price
        const priceRatioBase = order.sell_price.base.amount;
        const priceRatioQuote = order.sell_price.quote.amount;
        const currentReceiveInt = Math.round((currentSellInt * priceRatioQuote) / priceRatioBase);
        const currentReceiveFloat = blockchainToFloat(currentReceiveInt, receivePrecision);

        // Determine new desired values
        const newSellFloat = (newParams.amountToSell !== undefined && newParams.amountToSell !== null)
            ? newParams.amountToSell
            : currentSellFloat;
        const newReceiveFloat = (newParams.minToReceive !== undefined && newParams.minToReceive !== null)
            ? newParams.minToReceive
            : currentReceiveFloat;

        // Convert to blockchain integers
        const newSellInt = floatToBlockchainInt(newSellFloat, sellPrecision);
        const newReceiveInt = floatToBlockchainInt(newReceiveFloat, receivePrecision);

        // Calculate delta (new - current)
        let deltaSellInt = newSellInt - currentSellInt;

        // Only skip when delta is exactly zero (no change). Negative deltas
        // (reducing amount_to_sell) are allowed and will be sent to the chain.
        if (deltaSellInt === 0) {
            console.log(`Delta is 0; skipping limit_order_update (no change to amount_to_sell)`);
            return null;
        }

        // Build the new_price as the ratio between the new amounts
        // Adjust newSellInt to match the delta we're actually sending
        const adjustedSellInt = currentSellInt + deltaSellInt;

        const updateParams = {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: acc.account.id,
            order: orderId,
            delta_amount_to_sell: {
                amount: deltaSellInt,
                asset_id: sellAssetId
            },
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
        };

        if (newParams.expiration) updateParams.expiration = newParams.expiration;

        console.log(`Updating order ${orderId}: sell ${currentSellFloat} -> ${newSellFloat}, receive ${currentReceiveFloat} -> ${newReceiveFloat}, delta=${deltaSellInt}`);

        const tx = acc.newTx();
        tx.limit_order_update(updateParams);
        await tx.broadcast();

        console.log(`Order ${orderId} updated successfully`);
        // Return a simple success object instead of the tx Proxy to avoid any
        // accidental method calls on the finalized transaction
        return { success: true, orderId };
    } catch (error) {
        console.error('Error updating order:', error.message);
        throw error;
    }
}

/**
 * Create a new limit order on the blockchain.
 * 
 * @param {string} accountName - Account to create order for
 * @param {string} privateKey - Private key for signing
 * @param {number} amountToSell - Amount to sell (human units)
 * @param {string} sellAssetId - Asset ID being sold (e.g., '1.3.0')
 * @param {number} minToReceive - Minimum amount to receive (human units)
 * @param {string} receiveAssetId - Asset ID to receive
 * @param {string|null} expiration - ISO date string or null for 1-year default
 * @param {boolean} dryRun - If true, prepare but don't broadcast
 * @returns {Promise<Object>} Transaction result
 */
async function createOrder(accountName, privateKey, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration, dryRun = false) {
    try {
        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;

        if (!expiration) {
            const now = new Date();
            now.setFullYear(now.getFullYear() + 1);
            expiration = now.toISOString().split('T')[0] + 'T23:59:59';
        }

        // Convert float human values to blockchain integer amounts using asset precision
        const sellPrecision = await _getAssetPrecision(sellAssetId);
        const receivePrecision = await _getAssetPrecision(receiveAssetId);
        const amountToSellInt = floatToBlockchainInt(amountToSell, sellPrecision);
        const minToReceiveInt = floatToBlockchainInt(minToReceive, receivePrecision);

        const createParams = {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: acc.account.id,
            amount_to_sell: { amount: amountToSellInt, asset_id: sellAssetId },
            min_to_receive: { amount: minToReceiveInt, asset_id: receiveAssetId },
            expiration: expiration,
            fill_or_kill: false,
            extensions: []
        };

        const tx = acc.newTx();
        tx.limit_order_create(createParams);

        if (dryRun) {
            console.log(`Dry run: Limit order prepared for account ${accountName} (not broadcasted)`);
            // Return simplified object instead of tx Proxy
            return { dryRun: true, params: createParams };
        }

        const result = await tx.broadcast();
        console.log(`Limit order created successfully for account ${accountName}`);
        return result;
    } catch (error) {
        console.error('Error creating limit order:', error.message);
        throw error;
    }
}

/**
 * Cancel an existing limit order on the blockchain.
 * @param {string} accountName - Account that owns the order
 * @param {string} privateKey - Private key for signing
 * @param {string} orderId - Chain order ID to cancel (e.g., '1.7.12345')
 * @returns {Promise<Object>} Transaction result
 */
async function cancelOrder(accountName, privateKey, orderId) {
    try {
        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const cancelParams = { fee: { amount: 0, asset_id: '1.3.0' }, order: orderId, fee_paying_account: acc.account.id };
        const tx = acc.newTx();
        tx.limit_order_cancel(cancelParams);
        await tx.broadcast();
        console.log(`Order ${orderId} cancelled successfully`);
        // Return simple success object instead of tx Proxy
        return { success: true, orderId };
    } catch (error) {
        console.error('Error cancelling order:', error.message);
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

    // Note: authentication and key retrieval moved to modules/chain_keys.js
};

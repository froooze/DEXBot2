// Utilities for managing BitShares account keys, fills, and limit-order operations.
const { BitShares, createAccountClient, waitForConnected } = require('./bitshares_client');
const { floatToBlockchainInt, blockchainToFloat } = require('./order/utils');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readlineSync = require('readline-sync');

const PROFILES_KEYS_FILE = path.join(__dirname, '..', 'profiles', 'keys.json');

// Encrypt data with password
function encrypt(text, password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

// Decrypt data with password
function decrypt(encrypted, password) {
    const parts = encrypted.split(':');
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encryptedText = parts[3];
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// Load accounts data
function loadAccounts() {
    try {
        if (!fs.existsSync(PROFILES_KEYS_FILE)) {
            return { masterPasswordHash: '', accounts: {} };
        }
        const content = fs.readFileSync(PROFILES_KEYS_FILE, 'utf8').trim();
        if (!content) {
            return { masterPasswordHash: '', accounts: {} };
        }
        return JSON.parse(content);
    } catch (error) {
        console.error('Error loading accounts file, resetting to default:', error.message);
        return { masterPasswordHash: '', accounts: {} };
    }
}

// Hash password for verification
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

class MasterPasswordError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MasterPasswordError';
        this.code = 'MASTER_PASSWORD_FAILED';
    }
}

const MASTER_PASSWORD_MAX_ATTEMPTS = 3;
let masterPasswordAttempts = 0;

// Prompt the user for the master password, limiting the total attempts.
function _promptPassword() {
    if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
        throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
    }
    masterPasswordAttempts += 1;
    return readlineSync.question('Enter master password: ', { hideEchoBack: true });
}

// Authenticate and get master password
function authenticate() {
    const accountsData = loadAccounts();
    if (!accountsData.masterPasswordHash) {
        throw new Error('No master password set. Please run modules/account_keys.js first.');
    }

    while (true) {
        const enteredPassword = _promptPassword();
        if (hashPassword(enteredPassword) === accountsData.masterPasswordHash) {
            masterPasswordAttempts = 0;
            return enteredPassword;
        }
        if (masterPasswordAttempts < MASTER_PASSWORD_MAX_ATTEMPTS) {
            console.log('Master password not correct. Please try again.');
        }
    }
}

// Decrypt and return the stored private key for the requested account.
function getPrivateKey(accountName, masterPassword) {
    const accountsData = loadAccounts();
    const account = accountsData.accounts[accountName];
    if (!account) {
        throw new Error(`Account '${accountName}' not found.`);
    }
    return decrypt(account.encryptedKey, masterPassword);
}

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
    } catch (e) {}
    return 0;
}

// Preferred account ID and name for operations (can be changed)
let preferredAccountId = null;
let preferredAccountName = null;

// Remember the preferred account id/name for reuse in other helpers.
function setPreferredAccount(accountId, accountName) {
    preferredAccountId = accountId;
    if (accountName) preferredAccountName = accountName;
}

// Attempt to derive an account name from an id by querying the BitShares chain.
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

// Attempt to derive an account id from a name using on-chain lookup.
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
                try { c(fills); } catch (e) { console.error('account_orders listener error', e.message); }
            }
        }
    };

    try {
        BitShares.subscribe('account', bsCallback, accountName);
    } catch (e) {}

    const entry = { userCallbacks, bsCallback };
    accountSubscriptions.set(accountName, entry);
    return entry;
}

// Prompt user to select an account after authenticating with the master password.
async function selectAccount() {
    const masterPassword = authenticate();
    const accountsData = loadAccounts();
    const accountNames = Object.keys(accountsData.accounts);

    if (accountNames.length === 0) {
        throw new Error('No accounts found. Please add accounts using modules/account_keys.js');
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
    const privateKey = getPrivateKey(selectedAccount, masterPassword);

    try {
        const full = await BitShares.db.get_full_accounts([selectedAccount], false);
        if (full && full[0]) {
            const candidateId = full[0][0];
            if (candidateId && String(candidateId).startsWith('1.2.')) setPreferredAccount(candidateId, selectedAccount);
            else if (full[0][1] && full[0][1].account && full[0][1].account.id) setPreferredAccount(full[0][1].account.id, selectedAccount);
        }
    } catch (e) {}

    console.log(`Selected account: ${selectedAccount} (ID: ${preferredAccountId})`);
    return { accountName: selectedAccount, privateKey: privateKey, id: preferredAccountId };
}

// Fetch open orders for an account after ensuring connection.
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

// Listen for fill events on an account and notify callbacks.
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
        return () => {};
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
        return () => {};
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
                } catch (e) {}
                accountSubscriptions.delete(accountName);
            }
        } catch (e) {
            console.error('Error unsubscribing listenForFills', e.message);
        }
    };
}

// Update an existing limit order to new desired values.
// BitShares stores orders as amount_to_sell and min_to_receive (price = min_to_receive / amount_to_sell).
// This function accepts the new desired values and calculates the required delta internally.
//
// Parameters:
//   newParams.amountToSell - new desired amount to sell (in human-readable units)
//   newParams.minToReceive - new desired minimum to receive (in human-readable units)
// 
// If only one is provided, the other is kept from the current order.
// The function calculates delta_amount_to_sell = newAmount - currentAmount
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
        return tx;
    } catch (error) {
        console.error('Error updating order:', error.message);
        throw error;
    }
}

// Build and optionally broadcast a new limit order using provided values.
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
            return tx;
        }

        const result = await tx.broadcast();
        console.log(`Limit order created successfully for account ${accountName}`);
        return result;
    } catch (error) {
        console.error('Error creating limit order:', error.message);
        throw error;
    }
}

// Cancel a limit order and broadcast the cancellation.
async function cancelOrder(accountName, privateKey, orderId) {
    try {
        const acc = createAccountClient(accountName, privateKey);
        await acc.initPromise;
        const cancelParams = { fee: { amount: 0, asset_id: '1.3.0' }, order: orderId, fee_paying_account: acc.account.id };
        const tx = acc.newTx();
        tx.limit_order_cancel(cancelParams);
        await tx.broadcast();
        console.log(`Order ${orderId} cancelled successfully`);
        return tx;
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
            } catch (e) {}

            // try to get precision and symbol
            let precision = 0; let symbol = String(a);
            try {
                const am = await BitShares.db.get_assets([aid]).catch(() => null);
                if (Array.isArray(am) && am[0]) {
                    precision = typeof am[0].precision === 'number' ? am[0].precision : precision;
                    symbol = am[0].symbol || symbol;
                }
            } catch (e) {}

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

module.exports = {
    authenticate,
    selectAccount,
    getPrivateKey,
    setPreferredAccount,
    readOpenOrders,
    listenForFills,
    updateOrder,
    createOrder,
    cancelOrder,
    getOnChainAssetBalances,
    
    MasterPasswordError
};


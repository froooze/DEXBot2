const { BitShares, createAccountClient, waitForConnected } = require('./bitshares_client');
const { floatToBlockchainInt } = require('./order/utils');
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

// Authenticate and get master password
function authenticate() {
    const accountsData = loadAccounts();
    if (!accountsData.masterPasswordHash) {
        throw new Error('No master password set. Please run modules/account_keys.js first.');
    }

    const enteredPassword = readlineSync.question('Enter master password: ', { hideEchoBack: true });
    if (hashPassword(enteredPassword) !== accountsData.masterPasswordHash) {
        throw new Error('Incorrect master password!');
    }
    return enteredPassword;
}

// Get decrypted private key for an account
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

// Set preferred account
function setPreferredAccount(accountId, accountName) {
    preferredAccountId = accountId;
    if (accountName) preferredAccountName = accountName;
}

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

// Helper: create BitShares-level account subscription which fans out to user callbacks
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

// Select account for operations
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

async function updateOrder(accountName, privateKey, orderId, newParams) {
    try {
        const acc = createAccountClient(accountName, privateKey);
        const orders = await readOpenOrders(acc.id);
        const order = orders.find(o => o.id === orderId);
        if (!order) throw new Error(`Order ${orderId} not found`);

        // If caller provided newParams.amount (float in human units), convert to integer scaled by precision
        let deltaAmountValue = newParams.amount || order.sell_price.base.amount;
        if (newParams.amount !== undefined && newParams.amount !== null) {
            const basePrecision = await _getAssetPrecision(order.sell_price.base.asset_id);
            deltaAmountValue = floatToBlockchainInt(newParams.amount, basePrecision);
        }

        const updateParams = {
            fee: { amount: 0, asset_id: '1.3.0' },
            order: orderId,
            delta_amount_to_sell: {
                amount: deltaAmountValue,
                asset_id: order.sell_price.base.asset_id
            },
            new_price: {
                base: order.sell_price.base,
                quote: {
                    amount: Math.round((newParams.price || order.sell_price.quote.amount / order.sell_price.base.amount) * order.sell_price.base.amount),
                    asset_id: order.sell_price.quote.asset_id
                }
            }
        };

        if (newParams.expiration) updateParams.expiration = newParams.expiration;

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

async function createOrder(accountName, privateKey, amountToSell, sellAssetId, minToReceive, receiveAssetId, expiration, dryRun = false) {
    try {
        const acc = createAccountClient(accountName, privateKey);

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
            seller: acc.id,
            amount_to_sell: { amount: amountToSellInt, asset_id: sellAssetId },
            min_to_receive: { amount: minToReceiveInt, asset_id: receiveAssetId },
            expiration: expiration
        };

        const tx = acc.newTx();
        tx.limit_order_create(createParams);

        if (dryRun) {
            console.log(`Dry run: Limit order prepared for account ${accountName} (not broadcasted)`);
            return tx;
        }

        await tx.broadcast();
        console.log(`Limit order created successfully for account ${accountName}`);
        return tx;
    } catch (error) {
        console.error('Error creating limit order:', error.message);
        throw error;
    }
}

async function cancelOrder(accountName, privateKey, orderId) {
    try {
        const acc = createAccountClient(accountName, privateKey);
        const cancelParams = { fee: { amount: 0, asset_id: '1.3.0' }, order: orderId, fee_paying_account: acc.id };
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

module.exports = {
    authenticate,
    selectAccount,
    getPrivateKey,
    setPreferredAccount,
    readOpenOrders,
    listenForFills,
    updateOrder,
    createOrder,
    cancelOrder
};


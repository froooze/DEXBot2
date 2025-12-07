#!/usr/bin/env node
"use strict";

/**
 * bot.js (inside modules/) - PM2-friendly runner for one bot instance
 *
 * This file is mostly a copy of the top-level `bot.js` but with adjusted
 * require paths and ROOT so moving it under `modules/` does not change behavior.
 */

const path = require('path');
const fs = require('fs');
const ordersModule = require('./chain_orders');
const chainKeys = require('./chain_keys');
const { BitShares } = require('./bitshares_client');
const OrderManagerModule = require('./order');

// Environment-driven instance settings
const BOT_NUMBER = process.env.BOT_NUMBER || '00';
const ASSET_A_NAME = process.env.ASSET_A_NAME || process.env.ASSET_A || '';
const ASSET_B_NAME = process.env.ASSET_B_NAME || process.env.ASSET_B || '';
const MARKET = process.env.MARKET || (ASSET_A_NAME && ASSET_B_NAME ? `${ASSET_A_NAME}/${ASSET_B_NAME}` : 'unknown-market');
const PREFERRED_ACCOUNT = process.env.PREFERRED_ACCOUNT || null;

// When this file is inside modules/ the project root is one directory up 
// preserve the same semantics as when bot.js lived at repo root.
const ROOT = path.resolve(__dirname, '..');

let running = false;
let orderManager = null;
let activeAccountName = null;
let activePrivateKey = null;
let activeAccountId = null;
let _accountUnsub = null;

const DRY_RUN = !((process.env.DRY_RUN || '').toString().toLowerCase() === 'false' || process.env.DRY_RUN === '0');

function log(...args) {
    const assetContext = ASSET_A_NAME && ASSET_B_NAME ? `${ASSET_A_NAME}/${ASSET_B_NAME}` : MARKET;
    console.log(new Date().toISOString(), `[bot ${BOT_NUMBER} ${assetContext}]`, ...args);
}

// Boot up an OrderManager instance using available config/env and authenticate a preferred account if provided.
async function startBot(settings = {}) {
    if (running) {
        log('startBot called but bot already running');
        return;
    }

    log('Starting bot instance', { BOT_NUMBER, MARKET, PREFERRED_ACCOUNT });
    running = true;

    // Create an OrderManager using modules/order config if available
    try {
        orderManager = (OrderManagerModule && typeof OrderManagerModule.OrderManager === 'function')
            ? new OrderManagerModule.OrderManager()
            : (typeof OrderManagerModule === 'function' ? new OrderManagerModule() : null);
    } catch (err) {
        if (typeof OrderManagerModule === 'function') {
            try {
                const cfgLive = path.join(ROOT, 'live', 'bots.json');
                const cfgDefault = path.join(ROOT, 'config', 'bots.json');
                const cfgFile = fs.existsSync(cfgLive) ? cfgLive : cfgDefault;
                let runtimeCfg = {};
                if (fs.existsSync(cfgFile)) {
                    try {
                        const raw = fs.readFileSync(cfgFile, 'utf8');
                        const cleaned = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s*)\/\/.*$/, '')).join('\n');
                        runtimeCfg = JSON.parse(cleaned);
                    } catch (e) {
                        log('Failed to parse settings', e.message);
                    }
                }

                let chosenBot = null;
                if (runtimeCfg && Array.isArray(runtimeCfg.bots) && runtimeCfg.bots.length > 0) {
                    const envName = process.env.LIVE_BOT_NAME || process.env.BOT_NAME;
                    if (envName) {
                        chosenBot = runtimeCfg.bots.find(b => String(b.name).toLowerCase() === String(envName).toLowerCase());
                    }
                    if (!chosenBot) chosenBot = runtimeCfg.bots[0];
                } else if (runtimeCfg && typeof runtimeCfg === 'object' && Object.keys(runtimeCfg).length > 0) {
                    chosenBot = runtimeCfg;
                }

                if (chosenBot) {
                    log('Selected bot from settings', chosenBot.name || '<unnamed>');
                    if (!PREFERRED_ACCOUNT && chosenBot.preferredAccount) {
                        global.PREFERRED_ACCOUNT_OVERRIDE = chosenBot.preferredAccount;
                        log('Using preferredAccount from bot config:', chosenBot.preferredAccount);
                    }

                    if (OrderManagerModule && typeof OrderManagerModule.OrderManager === 'function') {
                        orderManager = new OrderManagerModule.OrderManager({ ...chosenBot });
                    } else if (typeof OrderManagerModule === 'function') {
                        orderManager = new OrderManagerModule({ ...chosenBot });
                    }
                } else {
                    if (OrderManagerModule && typeof OrderManagerModule.OrderManager === 'function') {
                        orderManager = new OrderManagerModule.OrderManager();
                    } else if (typeof OrderManagerModule === 'function') {
                        orderManager = new OrderManagerModule();
                    }
                }
            } catch (err) {
                if (typeof OrderManagerModule === 'function') orderManager = new OrderManagerModule();
            }

            const effectivePreferredAccount = PREFERRED_ACCOUNT || global.PREFERRED_ACCOUNT_OVERRIDE || null;
            if (effectivePreferredAccount) {
                try {
                    const masterPassword = await chainKeys.authenticate();
                    const privateKey = chainKeys.getPrivateKey(effectivePreferredAccount, masterPassword);
                    activeAccountName = effectivePreferredAccount;
                    activePrivateKey = privateKey;

                    try {
                        let accId = null;
                        try {
                            const full = await BitShares.db.get_full_accounts([effectivePreferredAccount], false);
                            if (full && full[0]) {
                                const maybe = full[0][0];
                                if (maybe && String(maybe).startsWith('1.2.')) accId = maybe;
                                else if (full[0][1] && full[0][1].account && full[0][1].account.id) accId = full[0][1].account.id;
                            }
                        } catch (e) { }
                        activeAccountId = accId;
                        ordersModule.setPreferredAccount(accId, effectivePreferredAccount);
                        log('Authenticated and set preferred account', effectivePreferredAccount, accId);

                        async function lookupAssetBySymbol(symbol) {
                            if (!symbol) return null;
                            const cleaned = String(symbol).trim();
                            try { if (BitShares.assets && BitShares.assets[cleaned.toLowerCase()]) { const a = await BitShares.assets[cleaned.toLowerCase()]; if (a && a.id) return { id: a.id, precision: a.precision, symbol: a.symbol || cleaned }; } } catch (e) { }
                            try { if (BitShares.db && typeof BitShares.db.lookup_asset_symbols === 'function') { const r = await BitShares.db.lookup_asset_symbols([cleaned]); if (Array.isArray(r) && r[0] && r[0].id) return { id: r[0].id, precision: r[0].precision, symbol: r[0].symbol || cleaned }; } } catch (e) { }
                            try { if (BitShares.db && typeof BitShares.db.get_assets === 'function') { const g = await BitShares.db.get_assets([cleaned]); if (Array.isArray(g) && g[0] && g[0].id) return { id: g[0].id, precision: g[0].precision, symbol: g[0].symbol || cleaned }; } } catch (e) { }
                            return null;
                        }

                        if (orderManager && typeof orderManager.setAccountTotals === 'function') {
                            try {
                                const SELL_ASSET_ID = process.env.SELL_ASSET_ID || process.env.SELL_ASSET || null;
                                const RECEIVE_ASSET_ID = process.env.RECEIVE_ASSET_ID || process.env.RECEIVE_ASSET || null;
                                let sellPrecision = Number(process.env.SELL_ASSET_PRECISION || process.env.SELL_PRECISION || '8');
                                let receivePrecision = Number(process.env.RECEIVE_ASSET_PRECISION || process.env.RECEIVE_PRECISION || '8');

                                let sellAssetId = SELL_ASSET_ID;
                                let receiveAssetId = RECEIVE_ASSET_ID;

                                if ((!sellAssetId || !receiveAssetId) && orderManager && orderManager.config) {
                                    const symA = orderManager.config.assetA || ASSET_A_NAME;
                                    const symB = orderManager.config.assetB || ASSET_B_NAME;
                                    if ((!sellAssetId || !receiveAssetId) && symA) {
                                        const discovered = await lookupAssetBySymbol(symA);
                                        if (discovered && !sellAssetId) {
                                            sellAssetId = discovered.id;
                                            log('Discovered SELL asset', symA, discovered.id, 'precision', discovered.precision);
                                            if (!process.env.SELL_ASSET_PRECISION && !process.env.SELL_PRECISION && discovered.precision !== undefined) {
                                                sellPrecision = Number(discovered.precision);
                                                log('Using discovered precision for SELL asset:', sellPrecision);
                                            }
                                        }
                                    }
                                    if ((!receiveAssetId || !sellAssetId) && symB) {
                                        const discoveredB = await lookupAssetBySymbol(symB);
                                        if (discoveredB && !receiveAssetId) {
                                            receiveAssetId = discoveredB.id;
                                            log('Discovered RECEIVE asset', symB, discoveredB.id, 'precision', discoveredB.precision);
                                            if (!process.env.RECEIVE_ASSET_PRECISION && !process.env.RECEIVE_PRECISION && discoveredB.precision !== undefined) {
                                                receivePrecision = Number(discoveredB.precision);
                                                log('Using discovered precision for RECEIVE asset:', receivePrecision);
                                            }
                                        }
                                    }
                                }

                                if (sellAssetId && receiveAssetId) {
                                    try {
                                        const full = await BitShares.db.get_full_accounts([activeAccountId], false);
                                        const accountData = full && full[0] && full[0][1];
                                        const balances = accountData && accountData.balances ? accountData.balances : [];

                                        const findBalance = (assetId) => {
                                            const b = balances.find(x => x.asset_type === assetId || x.asset_type === assetId.toString());
                                            return b ? Number(b.balance || b.amount || 0) : 0;
                                        };

                                        const rawSell = findBalance(sellAssetId);
                                        const rawBuy = findBalance(receiveAssetId);

                                        const buyTotal = OrderManagerModule.blockchainToFloat(rawBuy, receivePrecision);
                                        const sellTotal = OrderManagerModule.blockchainToFloat(rawSell, sellPrecision);

                                        orderManager.setAccountTotals({ buy: buyTotal, sell: sellTotal });
                                        log('Set accountTotals for OrderManager', { buy: buyTotal, sell: sellTotal });
                                    } catch (errFs) {
                                        log('Failed to fetch balances for account when setting account totals:', errFs.message);
                                    }
                                } else {
                                    log('SELL_ASSET_ID and/or RECEIVE_ASSET_ID not configured; skipping auto-balance fetch for accountTotals');
                                }
                            } catch (errSetTotals) {
                                log('Error while trying to set accountTotals on OrderManager:', errSetTotals.message);
                            }
                        }

                    } catch (errId) {
                        log('Authenticated but failed to derive account ID for preferred account (will retry on demand):', errId.message);
                    }
                } catch (errAuth) {
                    log('Failed to auth preferred account:', errAuth.message);
                }
            }

        }
    }
}

module.exports = {
    startBot
};


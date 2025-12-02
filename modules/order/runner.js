const fs = require('fs');
const path = require('path');
const { OrderManager } = require('./manager');

async function runOrderManagerCalculation() {
    const cfgFile = path.join(__dirname, '..', 'profiles', 'bots.json');
    let runtimeConfig = {};
    try {
        if (!fs.existsSync(cfgFile)) {
            throw new Error('profiles/bots.json not found (run npm run bootstrap:profiles)');
        }
        const raw = fs.readFileSync(cfgFile, 'utf8');
        const cleaned = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s*)\/\/.*$/, '')).join('\n');
        runtimeConfig = JSON.parse(cleaned);
    } catch (err) {
        console.warn('Failed to read bot configuration (profiles/bots.json):', err.message);
        throw err;
    }

    if (runtimeConfig && Array.isArray(runtimeConfig.bots) && runtimeConfig.bots.length > 0) {
        const envName = process.env.LIVE_BOT_NAME || process.env.BOT_NAME;
        let chosenBot = null;
        if (envName) chosenBot = runtimeConfig.bots.find(b => String(b.name).toLowerCase() === String(envName).toLowerCase());
        if (!chosenBot) chosenBot = runtimeConfig.bots[0];
        console.log(`Using bot from settings: ${chosenBot.name || '<unnamed>'}`);
        runtimeConfig = { ...chosenBot };
    }

    const rawMarketPrice = runtimeConfig.marketPrice;
    const mpIsPool = typeof rawMarketPrice === 'string' && rawMarketPrice.trim().toLowerCase() === 'pool';
    const mpIsMarket = typeof rawMarketPrice === 'string' && rawMarketPrice.trim().toLowerCase() === 'market';

    if ((rawMarketPrice === undefined || rawMarketPrice === null || rawMarketPrice === 0) || mpIsPool || mpIsMarket) {
        const tryPool = mpIsPool || !!runtimeConfig.pool;
        const tryMarket = mpIsMarket || !!runtimeConfig.market;

        const { derivePoolPrice, deriveMarketPrice } = require('./price');
        if (tryPool && (runtimeConfig.assetA && runtimeConfig.assetB)) {
            try {
                const { BitShares } = require('../bitshares_client');
                const symA = runtimeConfig.assetA; const symB = runtimeConfig.assetB;
                const p = await derivePoolPrice(BitShares, symA, symB);
                if (p !== null) runtimeConfig.marketPrice = p;
            } catch (err) { console.warn('Pool-based price lookup failed:', err.message); }
        } else if (tryMarket && (runtimeConfig.assetA && runtimeConfig.assetB)) {
            try {
                const { BitShares } = require('../bitshares_client');
                const symA = runtimeConfig.assetA; const symB = runtimeConfig.assetB;
                const m = await deriveMarketPrice(BitShares, symA, symB);
                if (m !== null) runtimeConfig.marketPrice = m;
            } catch (err) { console.warn('Market-based price lookup failed:', err.message); }
    } else { throw new Error('No marketPrice provided and neither "pool" nor "market" were set in bots.json \u2014 define at least one to derive price.'); }

        try {
            const { BitShares } = require('../bitshares_client');
            const symA = runtimeConfig.assetA; const symB = runtimeConfig.assetB;
            const m = await deriveMarketPrice(BitShares, symA, symB);
            if (m !== null) { runtimeConfig.marketPrice = m; console.log('Derived marketPrice from on-chain', runtimeConfig.assetA + '/' + runtimeConfig.assetB, m); }
        } catch (err) { console.warn('Failed to auto-derive marketPrice from chain:', err.message); }
    }

    try {
        const cfgMin = Number(runtimeConfig.minPrice || 80000);
        const cfgMax = Number(runtimeConfig.maxPrice || 160000);
        const mp = Number(runtimeConfig.marketPrice);
        if (!Number.isFinite(mp)) throw new Error('Invalid marketPrice (not a number)');
        if (mp < cfgMin || mp > cfgMax) { throw new Error(`Derived marketPrice ${mp} is outside configured range [${cfgMin}, ${cfgMax}] \u2014 refusing to create orders.`); }
    } catch (err) { throw err; }

    const manager = new OrderManager(runtimeConfig);
    await manager.initialize();

    const cycles = Number(process.env.CALC_CYCLES || 3);
    const delayMs = Number(process.env.CALC_DELAY_MS || 500);

    for (let cycle = 1; cycle <= cycles; cycle++) {
        manager.logger.log(`\n----- Cycle ${cycle}/${cycles} -----`, 'info');
        await manager.fetchOrderUpdates({ calculate: true });
        manager.displayStatus();
        if (cycle < cycles) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
}

module.exports = { runOrderManagerCalculation };


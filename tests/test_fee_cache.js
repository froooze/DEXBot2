/**
 * tests/test_fee_cache.js
 *
 * Test script demonstrating the new fee caching functions in utils.js:
 * - initializeFeeCache(): Loads fees from all assets in bots.json
 * - getAssetFees(): Returns maker/taker/market fees for a given asset and amount
 *
 * Usage:
 *   node tests/test_fee_cache.js
 */

const BitShares = require('btsdex');
const fs = require('fs');
const path = require('path');
const { initializeFeeCache, getAssetFees, getCachedFees } = require('../modules/order/utils');

async function main() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('FEE CACHE SYSTEM TEST');
        console.log('='.repeat(80));

        // Connect to BitShares
        console.log('\nConnecting to BitShares blockchain...');
        await BitShares.connect();
        console.log('✓ Connected to BitShares');

        // Load bot configuration
        console.log('\nLoading bot configuration from profiles/bots.json...');
        const botsJsonPath = path.join(__dirname, '../profiles/bots.json');
        const botsConfig = JSON.parse(fs.readFileSync(botsJsonPath, 'utf8'));

        if (!botsConfig.bots || !Array.isArray(botsConfig.bots)) {
            throw new Error('Invalid bots.json format - missing "bots" array');
        }

        console.log(`✓ Loaded ${botsConfig.bots.length} bot configurations`);

        // Extract unique assets from bot configs
        const assets = new Set(['BTS']);
        for (const bot of botsConfig.bots) {
            if (bot.assetA) assets.add(bot.assetA);
            if (bot.assetB) assets.add(bot.assetB);
        }
        console.log(`✓ Found assets: ${Array.from(assets).join(', ')}`);

        // Initialize the fee cache
        console.log('\nInitializing fee cache...');
        const feeCache = await initializeFeeCache(botsConfig.bots, BitShares);
        console.log('✓ Fee cache initialized');

        // Display cached fees
        console.log('\n' + '-'.repeat(80));
        console.log('CACHED FEE INFORMATION');
        console.log('-'.repeat(80));

        for (const assetSymbol of assets) {
            const cachedFees = getCachedFees(assetSymbol);
            if (!cachedFees) {
                console.log(`\n${assetSymbol}: ⚠ Failed to cache`);
                continue;
            }

            console.log(`\n${assetSymbol}:`);
            if (assetSymbol === 'BTS') {
                console.log(`  Order Creation Fee: ${cachedFees.limitOrderCreate.bts.toFixed(8)} BTS`);
                console.log(`  Order Cancel Fee: ${cachedFees.limitOrderCancel.bts.toFixed(8)} BTS`);
            } else {
                console.log(`  Asset ID: ${cachedFees.assetId}`);
                console.log(`  Precision: ${cachedFees.precision}`);
                console.log(`  Market Fee: ${cachedFees.marketFee.percent.toFixed(4)}%`);
                if (cachedFees.takerFee) {
                    console.log(`  Taker Fee: ${cachedFees.takerFee.percent.toFixed(4)}%`);
                }
            }
        }

        // Test getAssetFees function
        console.log('\n' + '-'.repeat(80));
        console.log('TEST: GET MAKER FEES');
        console.log('-'.repeat(80));

        // Test BTS (blockchain fees)
        console.log('\n--- BTS ---');
        const btsFees = getAssetFees('BTS', 1000);
        console.log(`getAssetFees('BTS', 1000) = ${btsFees.toFixed(8)} BTS`);

        // Test IOB.XRP
        console.log('\n--- IOB.XRP ---');
        const xrpFees = getAssetFees('IOB.XRP', 100);
        console.log(`getAssetFees('IOB.XRP', 100) = ${xrpFees.toFixed(8)} IOB.XRP`);

        // Test HONEST.MONEY
        console.log('\n--- HONEST.MONEY ---');
        const honestMoneyFees = getAssetFees('HONEST.MONEY', 500);
        console.log(`getAssetFees('HONEST.MONEY', 500) = ${honestMoneyFees.toFixed(8)} HONEST.MONEY`);


        console.log('\n' + '='.repeat(80) + '\n');

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    } finally {
        if (BitShares.ws && BitShares.ws.isConnected) {
            BitShares.disconnect();
        }
    }
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

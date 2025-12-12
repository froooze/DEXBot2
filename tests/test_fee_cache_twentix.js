/**
 * tests/test_fee_cache_twentix.js
 *
 * Test script demonstrating fee caching for TWENTIX specifically
 * Shows how the fee cache system handles assets with both market fees and taker fees
 *
 * Usage:
 *   node tests/test_fee_cache_twentix.js
 */

const BitShares = require('btsdex');
const { initializeFeeCache, getAssetFees } = require('../modules/order/utils');

async function main() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('FEE CACHE TEST: TWENTIX');
        console.log('='.repeat(80));

        // Connect to BitShares
        console.log('\nConnecting to BitShares blockchain...');
        await BitShares.connect();
        console.log('✓ Connected to BitShares');

        // Initialize cache with a custom bot config that includes TWENTIX
        console.log('\nInitializing fee cache with TWENTIX...');
        const botsConfig = [
            {
                assetA: 'TWENTIX',
                assetB: 'BTS'
            }
        ];

        await initializeFeeCache(botsConfig, BitShares);
        console.log('✓ Fee cache initialized');

        // Test getAssetFees with different amounts
        console.log('\n' + '-'.repeat(80));
        console.log('TWENTIX MAKER FEE CALCULATION');
        console.log('-'.repeat(80));

        const testAmounts = [100, 1000, 5000, 10000];

        for (const amount of testAmounts) {
            const fees = getAssetFees('TWENTIX', amount);
            console.log(`getAssetFees('TWENTIX', ${amount}) = ${fees.toFixed(8)} TWENTIX`);
        }

        // Test BTS blockchain fees
        console.log('\n' + '-'.repeat(80));
        console.log('BTS BLOCKCHAIN MAKER FEE');
        console.log('-'.repeat(80));

        const btsFees = getAssetFees('BTS', 1000);
        console.log(`\ngetAssetFees('BTS', 1000) = ${btsFees.toFixed(8)} BTS`);

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

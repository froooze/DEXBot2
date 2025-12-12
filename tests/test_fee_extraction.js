/**
 * tests/test_fee_extraction.js
 *
 * Test script to extract and display fee information from the blockchain:
 * - Blockchain operation fees (maker vs taker)
 * - Asset market fees for IOB.XRP and XBTSX.BTC
 * - Maker fee refund calculation
 *
 * Usage:
 *   node tests/test_fee_extraction.js
 */

const BitShares = require('btsdex');

async function main() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('BLOCKCHAIN FEE EXTRACTION TEST');
        console.log('='.repeat(80));

        // Initialize BitShares connection
        await BitShares.connect();
        console.log('\n✓ Connected to BitShares blockchain');

        // =====================================================================
        // PART 1: BLOCKCHAIN OPERATION FEES
        // =====================================================================
        console.log('\n' + '-'.repeat(80));
        console.log('PART 1: BLOCKCHAIN OPERATION FEES');
        console.log('-'.repeat(80));

        const blockchainFees = await extractBlockchainFees();
        displayBlockchainFees(blockchainFees);

        // =====================================================================
        // PART 2: ASSET MARKET FEES
        // =====================================================================
        console.log('\n' + '-'.repeat(80));
        console.log('PART 2: ASSET MARKET FEES');
        console.log('-'.repeat(80));

        const assets = ['IOB.XRP', 'XBTSX.BTC', 'TWENTIX', 'BTS'];
        const assetFees = await extractAssetFees(assets);
        displayAssetFees(assetFees);

        // =====================================================================
        // PART 3: MAKER FEE REFUND CALCULATION
        // =====================================================================
        console.log('\n' + '-'.repeat(80));
        console.log('PART 3: MAKER FEE REFUND CALCULATION');
        console.log('-'.repeat(80));

        const makerRefundInfo = calculateMakerRefund(blockchainFees);
        displayMakerRefund(makerRefundInfo);

        // =====================================================================
        // PART 4: CONSOLIDATED SUMMARY
        // =====================================================================
        console.log('\n' + '-'.repeat(80));
        console.log('PART 4: CONSOLIDATED SUMMARY FOR TRADING PAIR');
        console.log('-'.repeat(80));

        const summary = await extractTradingPairFees('IOB.XRP', 'XBTSX.BTC');
        displayTradingPairSummary(summary);

        console.log('\n' + '='.repeat(80) + '\n');

    } catch (error) {
        console.error('Error during fee extraction:', error);
        process.exit(1);
    } finally {
        if (BitShares.ws && BitShares.ws.isConnected) {
            BitShares.disconnect();
        }
    }
}

/**
 * Extract blockchain operation fees
 * Returns fees for all limit_order operations
 */
async function extractBlockchainFees() {
    try {
        // Get global properties which contain current fee structure
        const globalProps = await BitShares.db.getGlobalProperties();
        const currentFees = globalProps.parameters.current_fees;

        // The fee structure contains operation fees at specific indices
        // Operation 1: limit_order_create
        // Operation 2: limit_order_cancel
        // Operation 4: fill_order (virtual - shows in history)

        const fees = {
            limitOrderCreate: null,
            limitOrderCancel: null,
            fillOrder: null,
            timestamp: new Date().toISOString()
        };

        // Extract fees from the current_fees array
        // The structure is: parameters[index] = [operation_code, {fee, ...}]
        for (let i = 0; i < currentFees.parameters.length; i++) {
            const param = currentFees.parameters[i];
            if (!param || param.length < 2) continue;

            const opCode = param[0];
            const feeData = param[1];

            if (opCode === 1 && feeData.fee !== undefined) {
                // limit_order_create fee (in satoshis)
                fees.limitOrderCreate = {
                    raw: feeData.fee,
                    satoshis: Number(feeData.fee),
                    bts: blockchainToFloat(feeData.fee, 5) // BTS has 5 decimal places
                };
            } else if (opCode === 2 && feeData.fee !== undefined) {
                // limit_order_cancel fee
                fees.limitOrderCancel = {
                    raw: feeData.fee,
                    satoshis: Number(feeData.fee),
                    bts: blockchainToFloat(feeData.fee, 5)
                };
            }
        }

        // For fill_order (operation 4), we need to understand the maker/taker distinction:
        // - Maker: order creator who provides liquidity (fee is refunded later)
        // - Taker: order taker who removes liquidity (full fee applies)
        // The fill_order operation fee is typically embedded in the transaction fee calculation

        fees.notes = {
            maker: 'Maker gets refunded most of the fill_order fee after order executes',
            taker: 'Taker pays the full fee for taking liquidity from the order book'
        };

        return fees;

    } catch (error) {
        console.error('Error extracting blockchain fees:', error);
        throw error;
    }
}

/**
 * Extract market fees for specified assets
 */
async function extractAssetFees(assetSymbols) {
    const assetFees = {};

    for (const symbol of assetSymbols) {
        try {
            console.log(`Fetching fees for ${symbol}...`);

            // Lookup asset to get ID
            const assetData = await BitShares.db.lookupAssetSymbols([symbol]);
            if (!assetData || !assetData[0]) {
                console.warn(`  ⚠ Asset ${symbol} not found`);
                assetFees[symbol] = { error: 'Asset not found' };
                continue;
            }

            const asset = assetData[0];
            const assetId = asset.id;

            // Get full asset data including options
            const fullAssets = await BitShares.db.getAssets([assetId]);
            if (!fullAssets || !fullAssets[0]) {
                console.warn(`  ⚠ Could not fetch full data for ${symbol}`);
                assetFees[symbol] = { error: 'Could not fetch asset data' };
                continue;
            }

            const fullAsset = fullAssets[0];
            const options = fullAsset.options || {};

            // Market fees are stored as basis points (0.01%)
            const marketFeeBasisPoints = options.market_fee_percent || 0;
            const marketFeePercent = marketFeeBasisPoints / 100; // Convert to percentage

            // Extract taker fee - can be in extensions or directly in options
            let takerFeePercent = null;

            // Check extensions first (format: {taker_fee_percent: 20} means 0.20%)
            if (options.extensions && typeof options.extensions === 'object') {
                if (options.extensions.taker_fee_percent !== undefined) {
                    const value = Number(options.extensions.taker_fee_percent || 0);
                    takerFeePercent = value / 100; // Convert basis points (0.01%) to percentage
                }
            }

            // Check if taker_fee_percent exists directly in options (alternative format)
            if (takerFeePercent === null && options.taker_fee_percent !== undefined) {
                const value = Number(options.taker_fee_percent || 0);
                takerFeePercent = value / 100; // Convert basis points to percentage
            }

            assetFees[symbol] = {
                assetId: assetId,
                symbol: symbol,
                precision: fullAsset.precision,
                marketFee: {
                    basisPoints: marketFeeBasisPoints,
                    percent: marketFeePercent,
                    display: `${(marketFeePercent).toFixed(4)}%`
                },
                maxMarketFee: {
                    raw: options.max_market_fee || 0,
                    satoshis: Number(options.max_market_fee || 0),
                    float: blockchainToFloat(options.max_market_fee || 0, fullAsset.precision)
                },
                takerFee: takerFeePercent !== null ? {
                    percent: takerFeePercent,
                    display: `${(takerFeePercent).toFixed(4)}%`
                } : null,
                issuer: fullAsset.issuer
            };

        } catch (error) {
            console.error(`Error fetching fees for ${symbol}:`, error.message);
            assetFees[symbol] = { error: error.message };
        }
    }

    return assetFees;
}

/**
 * Calculate maker fee refund amounts
 * Maker gets refunded most (but not all) of the order creation fee
 */
function calculateMakerRefund(blockchainFees) {
    const limitOrderCreateFee = blockchainFees.limitOrderCreate;

    if (!limitOrderCreateFee) {
        return {
            error: 'Could not determine order creation fee',
            notes: 'Unable to calculate maker refund without blockchain fee data'
        };
    }

    // Maker refund calculation:
    // Typically 90% of the order creation fee is refunded when order is executed as maker
    const refundPercent = 0.90; // Standard BitShares maker refund percentage
    const refundAmount = limitOrderCreateFee.satoshis * refundPercent;
    const actualFeeCharged = limitOrderCreateFee.satoshis * (1 - refundPercent);

    return {
        orderCreationFee: {
            satoshis: limitOrderCreateFee.satoshis,
            bts: limitOrderCreateFee.bts,
            display: `${limitOrderCreateFee.bts.toFixed(8)} BTS`
        },
        makerRefundPercent: refundPercent * 100,
        makerRefund: {
            satoshis: refundAmount,
            bts: blockchainToFloat(refundAmount, 5),
            display: `${blockchainToFloat(refundAmount, 5).toFixed(8)} BTS`
        },
        makerFeeCharged: {
            satoshis: actualFeeCharged,
            bts: blockchainToFloat(actualFeeCharged, 5),
            display: `${blockchainToFloat(actualFeeCharged, 5).toFixed(8)} BTS`
        },
        notes: [
            'Maker order creator pays full fee initially',
            `When order executes, ${(refundPercent * 100).toFixed(0)}% is refunded`,
            `Net cost to maker: ${((1 - refundPercent) * 100).toFixed(0)}% of order creation fee`,
            'Taker (market taker) receives full deduction with no refund'
        ]
    };
}

/**
 * Extract all fees for a specific trading pair
 */
async function extractTradingPairFees(assetASymbol, assetBSymbol) {
    const blockchainFees = await extractBlockchainFees();
    const allAssetFees = await extractAssetFees([assetASymbol, assetBSymbol]);
    const makerRefund = calculateMakerRefund(blockchainFees);

    return {
        pair: `${assetASymbol} / ${assetBSymbol}`,
        blockchainFees,
        assetFees: {
            [assetASymbol]: allAssetFees[assetASymbol],
            [assetBSymbol]: allAssetFees[assetBSymbol]
        },
        makerRefundInfo: makerRefund,
        timestamp: new Date().toISOString()
    };
}

/**
 * Display blockchain fees
 */
function displayBlockchainFees(fees) {
    console.log('\nBlockchain Operation Fees (on-chain):');

    if (fees.limitOrderCreate) {
        console.log(`\n  Limit Order Create Fee:`);
        console.log(`    Raw: ${fees.limitOrderCreate.raw} satoshis`);
        console.log(`    BTS: ${fees.limitOrderCreate.bts.toFixed(8)}`);
    }

    if (fees.limitOrderCancel) {
        console.log(`\n  Limit Order Cancel Fee:`);
        console.log(`    Raw: ${fees.limitOrderCancel.raw} satoshis`);
        console.log(`    BTS: ${fees.limitOrderCancel.bts.toFixed(8)}`);
    }

    if (fees.notes) {
        console.log(`\n  Maker vs Taker Distinction:`);
        console.log(`    Maker: ${fees.notes.maker}`);
        console.log(`    Taker: ${fees.notes.taker}`);
    }
}

/**
 * Display asset fees
 */
function displayAssetFees(assetFees) {
    for (const [symbol, feeData] of Object.entries(assetFees)) {
        console.log(`\n${symbol}:`);

        if (feeData.error) {
            console.log(`  ⚠ Error: ${feeData.error}`);
            continue;
        }

        console.log(`  Asset ID: ${feeData.assetId}`);
        console.log(`  Precision: ${feeData.precision}`);

        console.log(`\n  Market Fee (charged on every trade):`);
        console.log(`    Basis Points: ${feeData.marketFee.basisPoints}`);
        console.log(`    Percentage: ${feeData.marketFee.display}`);

        console.log(`\n  Max Market Fee (cap per transaction):`);
        console.log(`    Raw: ${feeData.maxMarketFee.raw} satoshis`);
        console.log(`    Float: ${feeData.maxMarketFee.float.toFixed(8)} ${symbol}`);

        if (feeData.takerFee) {
            console.log(`\n  Taker Fee (additional, if present):`);
            console.log(`    Percentage: ${feeData.takerFee.display}`);
        }

        console.log(`  Issuer: ${feeData.issuer}`);
    }
}

/**
 * Display maker refund calculation
 */
function displayMakerRefund(info) {
    if (info.error) {
        console.log(`⚠ ${info.error}`);
        console.log(`  ${info.notes}`);
        return;
    }

    console.log(`\nOrder Creation Fee:`);
    console.log(`  ${info.orderCreationFee.display} (${info.orderCreationFee.satoshis} satoshis)`);

    console.log(`\nMaker Refund:`);
    console.log(`  Refund Percentage: ${info.makerRefundPercent.toFixed(0)}%`);
    console.log(`  Refund Amount: ${info.makerRefund.display}`);
    console.log(`  Net Fee to Maker: ${info.makerFeeCharged.display}`);

    console.log(`\nNotes:`);
    info.notes.forEach(note => {
        console.log(`  • ${note}`);
    });
}

/**
 * Display trading pair fee summary
 */
function displayTradingPairSummary(summary) {
    console.log(`\nTrade Pair: ${summary.pair}`);
    console.log(`\nBlockchain Fees:`);

    if (summary.blockchainFees.limitOrderCreate) {
        console.log(`  Create Order: ${summary.blockchainFees.limitOrderCreate.bts.toFixed(8)} BTS`);
    }

    console.log(`\nAsset Market Fees:`);
    for (const [symbol, feeData] of Object.entries(summary.assetFees)) {
        if (!feeData.error) {
            console.log(`  ${symbol}: ${feeData.marketFee.display}`);
        }
    }

    console.log(`\nMaker Fee Structure:`);
    if (!summary.makerRefundInfo.error) {
        console.log(`  Order Creation Cost: ${summary.makerRefundInfo.orderCreationFee.display}`);
        console.log(`  Maker Refund: ${summary.makerRefundInfo.makerRefund.display} (90%)`);
        console.log(`  Net Cost to Maker: ${summary.makerRefundInfo.makerFeeCharged.display} (10%)`);
    }

    console.log(`\nData Retrieved: ${summary.timestamp}`);
}

/**
 * Helper: Convert blockchain integer to float using precision
 */
function blockchainToFloat(intValue, precision) {
    if (intValue === null || intValue === undefined) return 0;
    const p = Number(precision || 0);
    return Number(intValue) / Math.pow(10, p);
}

// Run the test
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

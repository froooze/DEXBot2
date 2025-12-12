const BitShares = require('btsdex');

function blockchainToFloat(intValue, precision) {
    if (intValue === null || intValue === undefined) return 0;
    const p = Number(precision || 0);
    return Number(intValue) / Math.pow(10, p);
}

(async () => {
  try {
    console.log('Connecting to BitShares...');
    await BitShares.connect();
    console.log('✓ Connected\n');

    const symbol = 'TWENTIX';
    console.log(`Fetching ${symbol}...`);

    const assetData = await BitShares.db.lookupAssetSymbols([symbol]);
    if (!assetData || !assetData[0]) {
        console.error(`Asset ${symbol} not found`);
        process.exit(1);
    }

    const assetId = assetData[0].id;
    const fullAssets = await BitShares.db.getAssets([assetId]);
    const fullAsset = fullAssets[0];
    const options = fullAsset.options || {};

    const marketFeeBasisPoints = options.market_fee_percent || 0;
    const marketFeePercent = marketFeeBasisPoints / 100;

    let takerFeePercent = null;
    if (options.extensions && typeof options.extensions === 'object') {
        if (options.extensions.taker_fee_percent !== undefined) {
            const value = Number(options.extensions.taker_fee_percent || 0);
            takerFeePercent = value / 100;
        }
    }

    console.log(`\n${symbol}:`);
    console.log(`  Asset ID: ${assetId}`);
    console.log(`  Precision: ${fullAsset.precision}`);
    console.log(`\n  Market Fee:`);
    console.log(`    Basis Points: ${marketFeeBasisPoints}`);
    console.log(`    Percentage: ${marketFeePercent.toFixed(4)}%`);

    if (takerFeePercent !== null) {
        console.log(`\n  Taker Fee (additional):`);
        console.log(`    Percentage: ${takerFeePercent.toFixed(4)}%`);
    } else {
        console.log(`\n  Taker Fee: None`);
    }

  } catch(e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();

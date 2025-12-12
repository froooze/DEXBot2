const BitShares = require('btsdex');

(async () => {
  try {
    await BitShares.connect();
    console.log('Looking up TWENTIX...');

    const assets = await BitShares.db.lookupAssetSymbols(['TWENTIX']);
    console.log('Found:', assets[0].id);

    const fullAssets = await BitShares.db.getAssets([assets[0].id]);
    const asset = fullAssets[0];

    console.log('\n=== TWENTIX Asset Data ===');
    console.log('Symbol:', asset.symbol);
    console.log('Precision:', asset.precision);
    console.log('\n=== Options ===');
    console.log('market_fee_percent:', asset.options.market_fee_percent);
    console.log('max_market_fee:', asset.options.max_market_fee);
    console.log('taker_fee_percent (direct):', asset.options.taker_fee_percent);

    console.log('\n=== Extensions ===');
    if (asset.options.extensions) {
      console.log(JSON.stringify(asset.options.extensions, null, 2));
    } else {
      console.log('No extensions');
    }

  } catch(e) {
    console.error('Error:', e.message);
  }
})();

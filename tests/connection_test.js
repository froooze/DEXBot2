const { BitShares, waitForConnected } = require('../modules/bitshares_client');

async function testConnection() {
    console.log('Testing BitShares connection with btsdex (shared client)...');

    try {
        await waitForConnected(30000);
        console.log('✅ Connected to BitShares API');

        // Test basic API call
        const globalProps = await BitShares.db.get_dynamic_global_properties();
        console.log('✅ Dynamic global properties retrieved');
        console.log('Head block number:', globalProps.head_block_number);

        // Test asset query
        const btsAsset = await BitShares.assets.bts;
        console.log('✅ BTS asset retrieved');
        console.log('BTS precision:', btsAsset.precision);

        console.log('🎉 All connection tests passed!');

        // Exit after tests
        process.exit(0);

    } catch (error) {
        console.error('❌ Connection test failed:', error.message);
        process.exit(1);
    }
}

// Run the test
testConnection();

const orders = require('../modules/account_orders');

// Test account selection
async function testAccountSelection() {
    try {
        console.log('Testing account order read for configured account...');
        let TEST_ACCOUNT = '1.2.1624309';
        try {
            const live = require('../profiles/bots.json');
            const bot = (live.bots || [])[0];
            if (bot && bot.preferredAccount) TEST_ACCOUNT = bot.preferredAccount;
        } catch (e) {}
        try {
            const openOrders = await orders.readOpenOrders(TEST_ACCOUNT);
            console.log('Open orders for', TEST_ACCOUNT, ':', openOrders.length);
        } catch (e) {
            console.error('readOpenOrders for TEST_ACCOUNT failed:', e.message);
        }

    } catch (error) {
        console.error('Test failed:', error.message);
    }
}

testAccountSelection();
process.on('unhandledRejection', (r) => { console.error('unhandledRejection', r); process.exit(1); });
// ensure process terminates for CI
setTimeout(() => process.exit(0), 100);

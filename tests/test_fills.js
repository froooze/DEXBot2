const { listenForFills } = require('../modules/account_orders');

console.log('Starting test for listening to filled orders...');
let TEST_ACCOUNT = '1.2.1624309';
try {
    const live = require('../profiles/bots.json');
    // prefer a bot declared with a preferredAccount in live settings
    const bot = (live.bots || []).find(b => !!b.preferredAccount) || (live.bots || [])[0];
    if (bot && bot.preferredAccount) TEST_ACCOUNT = bot.preferredAccount;
} catch (e) {}

console.log(`Listening for fills on account ${TEST_ACCOUNT}. Waiting briefly and then exiting.`);

let unsub;
(async () => {
    try {
        unsub = await listenForFills(TEST_ACCOUNT, (fills) => {
            console.log('🎯 Fill detected!');
            fills.forEach((fillOp, index) => {
                const fill = fillOp.op[1]; // The fill operation details
                console.log(`Fill ${index + 1}:`);
                console.log(`  Order ID: ${fill.order_id}`);
                console.log(`  Pays: ${fill.pays.amount} of ${fill.pays.asset_id}`);
                console.log(`  Receives: ${fill.receives.amount} of ${fill.receives.asset_id}`);
                console.log(`  Fill Price: ${fill.fill_price.base.amount} ${fill.fill_price.base.asset_id} / ${fill.fill_price.quote.amount} ${fill.fill_price.quote.asset_id}`);
                console.log('---');
            });
        });
    } catch (err) {
        console.error('listenForFills error:', err.message || err);
    }
})();

setTimeout(() => {
    try {
        if (typeof unsub === 'function') unsub();
    } catch (e) {}
    console.log('\nStopping listener (test timeout)');
    process.exit(0);
}, 1000);

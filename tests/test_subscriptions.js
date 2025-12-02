const orders = require('../modules/account_orders');

console.log('Testing listenForFills subscribe/unsubscribe behavior');

(async () => {
    try {
        // subscribe twice for same account id
        // prefer account selected from profiles/bots.json (preferredAccount) for test consistency
        let TEST_ACCOUNT = '1.2.1624309';
        try {
            const live = require('../profiles/bots.json');
            const bot = (live.bots || [])[0];
            if (bot && bot.preferredAccount) TEST_ACCOUNT = bot.preferredAccount;
        } catch (e) {}

        const unsubA = await orders.listenForFills(TEST_ACCOUNT, (fills) => { /* noop */ });
        const unsubB = await orders.listenForFills(TEST_ACCOUNT, (fills) => { /* noop */ });

        console.log('subscribe returns:', typeof unsubA, typeof unsubB);

        // unsubscribe safely
        if (typeof unsubA === 'function') unsubA();
        if (typeof unsubB === 'function') unsubB();

        console.log('Unsubscribe calls completed without throwing');
    } catch (err) {
        console.error('subscribe/unsubscribe threw:', err.message || err);
        process.exit(1);
    }

    console.log('OK');
    // end the process quickly; ensure CI doesn't hang
    setTimeout(() => process.exit(0), 50);
})();

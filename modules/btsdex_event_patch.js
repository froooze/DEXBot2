const historyApi = require('btsdex-api').history;
let patched = false;
try {
    const eventModule = require('btsdex/lib/event');
    const accountModule = require('btsdex/lib/account');
    const EventClass = eventModule && (eventModule.default || eventModule);
    const accountHelpers = accountModule && (accountModule.default || accountModule);
    if (EventClass && typeof EventClass.updateAccounts === 'function') {
        EventClass.updateAccounts = async function (ids) {
            if (!this.account || !this.account.map) return;
            const updateAcc = new Set();
            for (const id of ids) {
                try {
                    const accNameInfo = await accountHelpers.id(id);
                    if (!accNameInfo || !accNameInfo.name) continue;
                    const name = accNameInfo.name;
                    const acc = this.account.map[name];
                    if (!acc) continue;
                    if (!acc.history) acc.history = '1.11.0';
                    let events = await historyApi.getAccountHistory(id, acc.history, 100, '1.11.0');
                    if (!Array.isArray(events)) events = [];
                    acc.events = events;
                    if (acc.events.length > 0 && acc.events[0] && acc.events[0].id) {
                        acc.history = acc.events[0].id;
                    } else {
                        acc.history = acc.history || '1.11.0';
                    }
                    updateAcc.add(name);
                } catch (err) {
                    console.error('event patch: failed to update account', id, err.message || err);
                }
            }
            if (updateAcc.size > 0) this.account.notify(updateAcc);
        };
        patched = true;
    }
} catch (err) {
    console.warn('event patch: btsdex event not available', err.message || err);
}
module.exports = { patched };

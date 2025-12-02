// Shared BitShares client wrapper
// Exposes a single `BitShares` export for subscription/db work and
// a `createAccountClient` helper for per-account signing/broadcasting clients.

const BitSharesLib = require('btsdex');
require('./btsdex_event_patch');

// Shared connection state for the process. Modules should use waitForConnected()
// to ensure the shared BitShares client is connected before making DB calls.
let connected = false;
const connectedCallbacks = new Set();

try {
    BitSharesLib.subscribe('connected', () => {
        connected = true;
        console.log('modules/bitshares_client: BitShares connected');
        for (const cb of Array.from(connectedCallbacks)) {
            try { cb(); } catch (e) { console.error('connected callback error', e.message); }
        }
    });
} catch (e) {
    // Some environments may not have subscribe available at require time; that's okay
}

async function waitForConnected(timeoutMs = 30000) {
    const start = Date.now();
    while (!connected) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

function onConnected(cb) { connectedCallbacks.add(cb); return () => connectedCallbacks.delete(cb); }

function createAccountClient(accountName, privateKey) {
    // Keep using per-account instance for signing/broadcasting where needed
    return new BitSharesLib(accountName, privateKey);
}

module.exports = {
    BitShares: BitSharesLib,
    createAccountClient,
    waitForConnected,
    onConnected,
    _internal: { get connected() { return connected; } }
};


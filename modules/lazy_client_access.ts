/**
 * Shared cached lazy accessor for the chain client.
 *
 * Runtimes that need a client at an async boundary (market verification before
 * a fill-pivot veto) use this instead of a static `bitshares_client` import.
 * The dynamic import keeps client acquisition off the module-load path; a
 * transient load failure clears the cache so it cannot disable verification
 * for the rest of the process. Both consumers therefore share ONE rule for
 * acquiring and retrying the client.
 */

let clientPromise: Promise<unknown> | null = null;

export function getLazyBitSharesClient(): Promise<unknown> {
    if (!clientPromise) {
        clientPromise = import('./bitshares_client.js')
            .then((m) => {
                if (!m.BitShares) throw new Error('BitShares client export missing');
                return m.BitShares;
            })
            .catch(() => {
                // A transient module-load failure must not disable market
                // verification for the rest of the process.
                clientPromise = null;
                return null;
            });
    }
    return clientPromise;
}

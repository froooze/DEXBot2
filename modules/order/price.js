// Try several on-chain lookups to resolve an asset symbol or id to metadata.
const lookupAsset = async (BitShares, s) => {
    try { const a = await BitShares.assets[s.toLowerCase()]; if (a && a.id) return a; } catch (e) {}
    try { const r = await BitShares.db.lookup_asset_symbols([s]); if (r && r[0] && r[0].id) return r[0]; } catch (e) {}
    try { const g = await BitShares.db.get_assets([s]); if (g && g[0] && g[0].id) return g[0]; } catch (e) {}
    return null;
};

// Derive a market-based price via orderbooks/ticker data and invert to quote per base.
const deriveMarketPrice = async (BitShares, symA, symB) => {
    try {
        const aMeta = await lookupAsset(BitShares, symA);
        const bMeta = await lookupAsset(BitShares, symB);
        if (!aMeta || !bMeta) throw new Error('Could not discover assets for market lookup');

        const baseId = aMeta.id; const quoteId = bMeta.id;
        let mid = null;
        try {
            if (BitShares.db && typeof BitShares.db.get_order_book === 'function') {
                const ob = await BitShares.db.get_order_book(baseId, quoteId, 5);
                const bestBid = ob.bids && ob.bids.length ? Number(ob.bids[0].price) : null;
                const bestAsk = ob.asks && ob.asks.length ? Number(ob.asks[0].price) : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            }
        } catch (e) {}

    if (mid === null) {
            try {
                if (BitShares.db && typeof BitShares.db.get_ticker === 'function') {
                    const t = await BitShares.db.get_ticker(baseId, quoteId);
                    if (t && (t.latest || t.latest === 0)) mid = Number(t.latest);
                    if (!mid && t && t.latest_price) mid = Number(t.latest_price);
                }
            } catch (err) {}
        }

    // invert market price (reciprocal) — avoid division by zero
    if (mid !== null && Number.isFinite(mid) && mid !== 0) return 1 / mid;
    return null;
    } catch (err) {
        return null;
    }
};

// Derive a price from a liquidity pool reserve ratio, falling back to weighted OB averaging.
const derivePoolPrice = async (BitShares, symA, symB) => {
    try {
        const aMeta = await lookupAsset(BitShares, symA);
        const bMeta = await lookupAsset(BitShares, symB);
        if (!aMeta || !bMeta) throw new Error('Could not discover assets for pool lookup');

        let chosen = null;
        try {
            if (BitShares.db && typeof BitShares.db.get_liquidity_pool_by_asset_ids === 'function') {
                const pool = await BitShares.db.get_liquidity_pool_by_asset_ids(aMeta.id, bMeta.id);
                if (pool && pool.id) chosen = pool;
            }
        } catch (e) {}

        try {
            if (!chosen && BitShares.db && typeof BitShares.db.get_liquidity_pools === 'function') {
                const pools = await BitShares.db.get_liquidity_pools();
                if (Array.isArray(pools)) {
                    const matches = pools.filter(p => {
                        const ids = (p.asset_ids || []).map(x => String(x));
                        return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                    });
                    if (matches.length > 0) {
                        chosen = matches.sort((x, y) => (Number(y.total_reserve || 0) - Number(x.total_reserve || 0)))[0];
                        try {
                            if (chosen && !Array.isArray(chosen.reserves) && chosen.id && BitShares.db && typeof BitShares.db.get_objects === 'function') {
                                const objs = await BitShares.db.get_objects([chosen.id]);
                                if (Array.isArray(objs) && objs[0]) chosen = objs[0];
                            }
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}

        // If no pool chosen, fallback to order-book averaging (weighted)
        if (!chosen) {
            try {
                if (BitShares.db && typeof BitShares.db.get_order_book === 'function') {
                    const ob = await BitShares.db.get_order_book(aMeta.id, bMeta.id, 100);
                    const bids = (ob.bids || []).slice(0, 50);
                    const asks = (ob.asks || []).slice(0, 50);
                    const weightAvg = (arr) => {
                        if (!arr || arr.length === 0) return null;
                        let num = 0, den = 0;
                        arr.forEach(p => {
                            const price = Number(p.price || 0);
                            const amount = Number(p.size || p.base_amount || p.quantity || 1);
                            num += price * amount; den += amount;
                        });
                        return den ? num / den : null;
                    };
                    const bidAvg = weightAvg(bids);
                    const askAvg = weightAvg(asks);
                    if (bidAvg !== null && askAvg !== null) {
                        const mid = (bidAvg + askAvg) / 2;
                        return (mid !== 0 && Number.isFinite(mid)) ? 1 / mid : null;
                    }
                    if (bidAvg !== null) return (bidAvg !== 0 && Number.isFinite(bidAvg)) ? 1 / bidAvg : null;
                    if (askAvg !== null) return (askAvg !== 0 && Number.isFinite(askAvg)) ? 1 / askAvg : null;
                }
            } catch (e) {}
            return null;
        }

    // Compute price from pool reserves
        try {
        // First try an asset-id aware mapping from chosen.reserves
        let foundAmountA = null; let foundAmountB = null; let precisionA = null; let precisionB = null;
        if (Array.isArray(chosen.reserves) && chosen.reserves.length >= 2) {
            const rA = chosen.reserves.find(r => r && String(r.asset_id) === String(aMeta.id));
            const rB = chosen.reserves.find(r => r && String(r.asset_id) === String(bMeta.id));
            if (rA && rB) {
                foundAmountA = Number(rA.amount || 0);
                foundAmountB = Number(rB.amount || 0);
                try { if (rA.asset_id && rB.asset_id && BitShares.db && typeof BitShares.db.get_assets === 'function') {
                    const assetsMeta = await BitShares.db.get_assets([rA.asset_id, rB.asset_id]);
                    if (assetsMeta && assetsMeta[0] && typeof assetsMeta[0].precision === 'number') precisionA = assetsMeta[0].precision;
                    if (assetsMeta && assetsMeta[1] && typeof assetsMeta[1].precision === 'number') precisionB = assetsMeta[1].precision;
                } } catch (e) {}
            }
        }
        // If not found via asset_id, fall back to named pool fields (reserve_a/reserve_b) only
        if (foundAmountA === null || foundAmountB === null) {
            const reserveA = Number(chosen.reserve_a || chosen.reserve_base || 0);
            const reserveB = Number(chosen.reserve_b || chosen.reserve_quote || 0);
            if (Number.isFinite(reserveA) && Number.isFinite(reserveB) && reserveA !== 0) {
                foundAmountA = reserveA; foundAmountB = reserveB; precisionA = precisionA; precisionB = precisionB;
            }
        }
        // If still not found, do not fall back to positional indexing
        if (foundAmountA === null || foundAmountB === null) return null;
        const floatA = Number.isFinite(precisionA) ? (foundAmountA / Math.pow(10, precisionA)) : foundAmountA;
        const floatB = Number.isFinite(precisionB) ? (foundAmountB / Math.pow(10, precisionB)) : foundAmountB;
        // Return quote per base (floatB / floatA) to match deriveMarketPrice orientation
        if (Number.isFinite(floatA) && Number.isFinite(floatB) && floatA !== 0) return (floatB !== 0 && Number.isFinite(floatB)) ? floatB / floatA : null;
        } catch (e) {}

        return null;
    } catch (err) {
        return null;
    }
};

// derivePrice: try pool -> market/orderbook -> aggregated limit orders
// mode can be undefined|'auto'|'pool'|'market'
const derivePrice = async (BitShares, symA, symB, mode) => {
    mode = (mode === undefined || mode === null) ? 'auto' : String(mode).toLowerCase();
    // if caller forces a mode, honor it
    if (mode === 'pool') {
        try { const p = await derivePoolPrice(BitShares, symA, symB); if (p && Number.isFinite(p) && p > 0) return p; } catch (e) { return null; }
        return null;
    }
    if (mode === 'market') {
        try { const m = await deriveMarketPrice(BitShares, symA, symB); if (m && Number.isFinite(m) && m > 0) return m; } catch (e) { return null; }
        return null;
    }
    try {
        // pool first
        try {
            const p = await derivePoolPrice(BitShares, symA, symB);
            if (p && Number.isFinite(p) && p > 0) return p;
        } catch (e) {}

        // market / orderbook next
        try {
            const m = await deriveMarketPrice(BitShares, symA, symB);
            if (m && Number.isFinite(m) && m > 0) return m;
        } catch (e) {}

        // Final fallback: try aggregating limit orders (weighted by base size)
        try {
            // resolve assets to ids
            const aMeta = await lookupAsset(BitShares, symA);
            const bMeta = await lookupAsset(BitShares, symB);
            if (!aMeta || !bMeta) return null;
            const aId = aMeta.id; const bId = bMeta.id;

            // Fetch orders in both orientations, try direct first
            let orders = await (BitShares.db && typeof BitShares.db.get_limit_orders === 'function' ? BitShares.db.get_limit_orders(aId, bId, 100) : null).catch(() => null);
            if (!orders || !orders.length) {
                const rev = await (BitShares.db && typeof BitShares.db.get_limit_orders === 'function' ? BitShares.db.get_limit_orders(bId, aId, 100) : null).catch(() => null);
                orders = rev || [];
            }
            if (!orders || !orders.length) return null;

            // helper to parse a limit order into { price: quotePerBase, size: baseHuman, baseId, quoteId }
            const parseOrder = async (order) => {
                if (!order || !order.sell_price) return null;
                const { base, quote } = order.sell_price;
                // get precisions (best-effort)
                const basePrec = await (BitShares.assets && BitShares.assets[base.asset_id] ? (BitShares.assets[base.asset_id].precision || 0) : (async () => { try { const a = await BitShares.db.get_assets([base.asset_id]); return (a && a[0] && typeof a[0].precision === 'number') ? a[0].precision : 0; } catch (e) { return 0; } })());
                // basePrec may be a promise, normalize
                const basePrecision = typeof basePrec === 'number' ? basePrec : await basePrec;
                const quotePrec = await (BitShares.assets && BitShares.assets[quote.asset_id] ? (BitShares.assets[quote.asset_id].precision || 0) : (async () => { try { const a = await BitShares.db.get_assets([quote.asset_id]); return (a && a[0] && typeof a[0].precision === 'number') ? a[0].precision : 0; } catch (e) { return 0; } })());
                const quotePrecision = typeof quotePrec === 'number' ? quotePrec : await quotePrec;

                const baseAmt = Number(base.amount || 0);
                const quoteAmt = Number(quote.amount || 0);
                if (!baseAmt || !quoteAmt) return null;
                const price = (quoteAmt / baseAmt) * Math.pow(10, basePrecision - quotePrecision);
                const size = Number(order.for_sale || 0) / Math.pow(10, basePrecision || 0);
                return { price, size, baseId: String(base.asset_id), quoteId: String(quote.asset_id) };
            };

            let sumNum = 0, sumDen = 0;
            for (const o of orders) {
                const p = await parseOrder(o);
                if (!p) continue;
                // We need quote per base for (aId,bId).
                let priceInDesired = null;
                if (p.baseId === String(aId) && p.quoteId === String(bId)) priceInDesired = p.price;
                else if (p.baseId === String(bId) && p.quoteId === String(aId)) { if (p.price !== 0) priceInDesired = 1 / p.price; }
                else continue; // skip
                if (!Number.isFinite(priceInDesired) || priceInDesired <= 0) continue;
                const weight = Math.max(1e-12, p.size);
                sumNum += priceInDesired * weight;
                sumDen += weight;
            }
            if (!sumDen) return null;
            return sumNum / sumDen;
        } catch (e) {}

        return null;
    } catch (err) {
        return null;
    }
};

module.exports = { lookupAsset, derivePoolPrice, deriveMarketPrice, derivePrice };

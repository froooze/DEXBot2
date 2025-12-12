const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('./constants');
const OrderUtils = require('./utils');

function _countActiveOnGrid(manager, type) {
    const active = manager.getOrdersByTypeAndState(type, ORDER_STATES.ACTIVE).filter(o => o && o.orderId);
    const partial = manager.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter(o => o && o.orderId);
    return active.length + partial.length;
}

function _pickVirtualSlotsToActivate(manager, type, count) {
    if (count <= 0) return [];

    let effectiveMin = 0;
    try {
        effectiveMin = OrderUtils.getMinOrderSize(type, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
    } catch (e) {
        effectiveMin = 0;
    }

    const allVirtual = manager.getOrdersByTypeAndState(type, ORDER_STATES.VIRTUAL);

    // Closest-to-market block
    if (type === ORDER_TYPES.SELL) {
        allVirtual.sort((a, b) => a.price - b.price); // lowest sell first (closest to market)
    } else {
        allVirtual.sort((a, b) => b.price - a.price); // highest buy first (closest to market)
    }

    const block = allVirtual.slice(0, count);
    const valid = block.filter(o => (Number(o.size) || 0) >= effectiveMin);

    // Outside-in ordering
    if (type === ORDER_TYPES.SELL) valid.sort((a, b) => (b.price || 0) - (a.price || 0));
    else valid.sort((a, b) => (a.price || 0) - (b.price || 0));

    return valid;
}

async function _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId, gridOrder, dryRun }) {
    if (dryRun) return;

    const size = Number(gridOrder.size) || 0;
    const price = Number(gridOrder.price) || 0;
    const minToReceive = (gridOrder.type === ORDER_TYPES.SELL)
        ? (size * price)
        : (price > 0 ? (size / price) : 0);

    await chainOrders.updateOrder(account, privateKey, chainOrderId, {
        newPrice: gridOrder.price,
        amountToSell: gridOrder.size,
        minToReceive,
        orderType: gridOrder.type,
    });

    const updatedGrid = { ...gridOrder, orderId: chainOrderId, state: ORDER_STATES.ACTIVE };
    manager._updateOrder(updatedGrid);
}

async function _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun }) {
    if (dryRun) return;

    const { assetA, assetB } = manager.assets;
    let amountToSell, sellAssetId, minToReceive, receiveAssetId;

    if (gridOrder.type === ORDER_TYPES.SELL) {
        amountToSell = gridOrder.size;
        sellAssetId = assetA.id;
        minToReceive = gridOrder.size * gridOrder.price;
        receiveAssetId = assetB.id;
    } else {
        amountToSell = gridOrder.size;
        sellAssetId = assetB.id;
        minToReceive = gridOrder.size / gridOrder.price;
        receiveAssetId = assetA.id;
    }

    const result = await chainOrders.createOrder(
        account,
        privateKey,
        amountToSell,
        sellAssetId,
        minToReceive,
        receiveAssetId,
        null,
        false
    );

    const chainOrderId =
        result &&
        result[0] &&
        result[0].trx &&
        result[0].trx.operation_results &&
        result[0].trx.operation_results[0] &&
        result[0].trx.operation_results[0][1];

    if (chainOrderId) {
        const updatedGrid = { ...gridOrder, orderId: chainOrderId, state: ORDER_STATES.ACTIVE };
        manager._updateOrder(updatedGrid);
    }
}

async function _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId, dryRun }) {
    if (dryRun) return;

    await chainOrders.cancelOrder(account, privateKey, chainOrderId);
    await manager.synchronizeWithChain(chainOrderId, 'cancelOrder');
}

/**
 * Attempt to resume a persisted grid when orderIds don't match (e.g. orders.json out of sync),
 * by matching existing on-chain open orders to grid orders using price+size matching.
 *
 * Returns { resumed: boolean, matchedCount: number }.
 */
async function attemptResumePersistedGridByPriceMatch({
    manager,
    persistedGrid,
    chainOpenOrders,
    logger,
    storeGrid,
}) {
    if (!Array.isArray(persistedGrid) || persistedGrid.length === 0) return { resumed: false, matchedCount: 0 };
    if (!Array.isArray(chainOpenOrders) || chainOpenOrders.length === 0) return { resumed: false, matchedCount: 0 };
    if (!manager || typeof manager.synchronizeWithChain !== 'function') return { resumed: false, matchedCount: 0 };

    try {
        logger && logger.log && logger.log('No matching active order IDs found. Attempting to match by price...', 'info');
        const Grid = require('./grid');
        await Grid.loadGrid(manager, persistedGrid);
        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

        const matchedOrderIds = new Set(
            Array.from(manager.orders.values())
                .filter(o => o && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL))
                .map(o => o.orderId)
                .filter(Boolean)
        );

        if (matchedOrderIds.size === 0) {
            logger && logger.log && logger.log('Price-based matching found no matches. Generating new grid.', 'info');
            return { resumed: false, matchedCount: 0 };
        }

        logger && logger.log && logger.log(`Successfully matched ${matchedOrderIds.size} orders by price. Resuming with existing grid.`, 'info');
        if (typeof storeGrid === 'function') {
            storeGrid(Array.from(manager.orders.values()));
        }
        return { resumed: true, matchedCount: matchedOrderIds.size };
    } catch (err) {
        logger && logger.log && logger.log(`Price-based resume attempt failed: ${err && err.message ? err.message : err}`, 'warn');
        return { resumed: false, matchedCount: 0 };
    }
}

/**
 * Decide whether a startup should regenerate the grid or resume a persisted grid.
 *
 * Resulting behavior matches the existing startup policy:
 * - If no persisted grid -> regenerate
 * - If any persisted ACTIVE orderId exists on-chain -> resume
 * - Else if there are on-chain orders -> attempt price-based matching; resume if it matches any
 * - Else -> regenerate
 */
async function decideStartupGridAction({
    persistedGrid,
    chainOpenOrders,
    manager,
    logger,
    storeGrid,
    attemptResumeFn = attemptResumePersistedGridByPriceMatch,
}) {
    const persisted = Array.isArray(persistedGrid) ? persistedGrid : [];
    const chain = Array.isArray(chainOpenOrders) ? chainOpenOrders : [];

    if (persisted.length === 0) {
        return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
    }

    const chainOrderIds = new Set(chain.map(o => o && o.id).filter(Boolean));
    const hasActiveMatch = persisted.some(order => order && order.state === 'active' && order.orderId && chainOrderIds.has(order.orderId));
    if (hasActiveMatch) {
        return { shouldRegenerate: false, hasActiveMatch: true, resumedByPrice: false, matchedCount: 0 };
    }

    if (chain.length > 0) {
        const resume = await attemptResumeFn({ manager, persistedGrid: persisted, chainOpenOrders: chain, logger, storeGrid });
        return { shouldRegenerate: !resume.resumed, hasActiveMatch: false, resumedByPrice: !!resume.resumed, matchedCount: resume.matchedCount || 0 };
    }

    return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
}

/**
 * Reconcile existing on-chain orders to a newly generated grid.
 *
 * Policy (per side):
 * - Prefer updating existing unmatched chain orders to match the target grid slots.
 * - Then create missing orders if chain has fewer than target.
 * - Then cancel excess orders if chain has more than target.
 *
 * Targets are derived from config.activeOrders.{buy,sell} and chain counts are computed
 * from current on-chain open orders.
 */
async function reconcileStartupOrders({
    manager,
    config,
    account,
    privateKey,
    chainOrders,
    chainOpenOrders,
    syncResult,
}) {
    const logger = manager && manager.logger;
    const dryRun = !!(config && config.dryRun);

    const parsedChain = (chainOpenOrders || [])
        .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    const activeCfg = (config && config.activeOrders) ? config.activeOrders : {};
    const targetBuy = Math.max(0, Number.isFinite(Number(activeCfg.buy)) ? Number(activeCfg.buy) : 1);
    const targetSell = Math.max(0, Number.isFinite(Number(activeCfg.sell)) ? Number(activeCfg.sell) : 1);

    const chainBuys = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    const chainSells = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    const unmatchedChain = (syncResult && syncResult.unmatchedChainOrders) ? syncResult.unmatchedChainOrders : [];
    const unmatchedParsed = unmatchedChain
        .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    let unmatchedBuys = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    let unmatchedSells = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    // ---- SELL SIDE ----
    const matchedSell = _countActiveOnGrid(manager, ORDER_TYPES.SELL);
    const needSellSlots = Math.max(0, targetSell - matchedSell);
    const desiredSellSlots = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.SELL, needSellSlots);

    const sellUpdates = Math.min(unmatchedSells.length, desiredSellSlots.length);
    for (let i = 0; i < sellUpdates; i++) {
        const chainOrder = unmatchedSells[i];
        const gridOrder = desiredSellSlots[i];
        logger && logger.log && logger.log(
            `Startup: Updating chain SELL ${chainOrder.id} -> grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId: chainOrder.id, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to update SELL ${chainOrder.id}: ${err.message}`, 'error');
        }
    }
    unmatchedSells = unmatchedSells.slice(sellUpdates);

    const chainSellCount = chainSells.length;
    const sellCreateCount = Math.max(0, targetSell - chainSellCount);
    const remainingSellSlots = desiredSellSlots.slice(sellUpdates);
    for (let i = 0; i < Math.min(sellCreateCount, remainingSellSlots.length); i++) {
        const gridOrder = remainingSellSlots[i];
        logger && logger.log && logger.log(
            `Startup: Creating SELL for grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to create SELL: ${err.message}`, 'error');
        }
    }

    let sellCancelCount = Math.max(0, chainSellCount - targetSell);
    if (sellCancelCount > 0) {
        const parsedUnmatchedSells = unmatchedSells
            .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort((a, b) => (b.parsed.price || 0) - (a.parsed.price || 0));

        for (const x of parsedUnmatchedSells) {
            if (sellCancelCount <= 0) break;
            logger && logger.log && logger.log(`Startup: Cancelling excess SELL chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: x.chain.id, dryRun });
                sellCancelCount--;
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to cancel SELL ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (sellCancelCount > 0) {
            const activeSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort((a, b) => (b.price || 0) - (a.price || 0));

            for (const o of activeSells) {
                if (sellCancelCount <= 0) break;
                logger && logger.log && logger.log(`Startup: Cancelling excess matched SELL ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun });
                    sellCancelCount--;
                } catch (err) {
                    logger && logger.log && logger.log(`Startup: Failed to cancel matched SELL ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    // ---- BUY SIDE ----
    const matchedBuy = _countActiveOnGrid(manager, ORDER_TYPES.BUY);
    const needBuySlots = Math.max(0, targetBuy - matchedBuy);
    const desiredBuySlots = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.BUY, needBuySlots);

    const buyUpdates = Math.min(unmatchedBuys.length, desiredBuySlots.length);
    for (let i = 0; i < buyUpdates; i++) {
        const chainOrder = unmatchedBuys[i];
        const gridOrder = desiredBuySlots[i];
        logger && logger.log && logger.log(
            `Startup: Updating chain BUY ${chainOrder.id} -> grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId: chainOrder.id, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to update BUY ${chainOrder.id}: ${err.message}`, 'error');
        }
    }
    unmatchedBuys = unmatchedBuys.slice(buyUpdates);

    const chainBuyCount = chainBuys.length;
    const buyCreateCount = Math.max(0, targetBuy - chainBuyCount);
    const remainingBuySlots = desiredBuySlots.slice(buyUpdates);
    for (let i = 0; i < Math.min(buyCreateCount, remainingBuySlots.length); i++) {
        const gridOrder = remainingBuySlots[i];
        logger && logger.log && logger.log(
            `Startup: Creating BUY for grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to create BUY: ${err.message}`, 'error');
        }
    }

    let buyCancelCount = Math.max(0, chainBuyCount - targetBuy);
    if (buyCancelCount > 0) {
        const parsedUnmatchedBuys = unmatchedBuys
            .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort((a, b) => (a.parsed.price || 0) - (b.parsed.price || 0));

        for (const x of parsedUnmatchedBuys) {
            if (buyCancelCount <= 0) break;
            logger && logger.log && logger.log(`Startup: Cancelling excess BUY chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: x.chain.id, dryRun });
                buyCancelCount--;
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to cancel BUY ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (buyCancelCount > 0) {
            const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort((a, b) => (a.price || 0) - (b.price || 0));

            for (const o of activeBuys) {
                if (buyCancelCount <= 0) break;
                logger && logger.log && logger.log(`Startup: Cancelling excess matched BUY ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun });
                    buyCancelCount--;
                } catch (err) {
                    logger && logger.log && logger.log(`Startup: Failed to cancel matched BUY ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    logger && logger.log && logger.log(
        `Startup reconcile complete: target(sell=${targetSell}, buy=${targetBuy}), chain(sell=${chainSellCount}, buy=${chainBuyCount}), ` +
        `gridActive(sell=${_countActiveOnGrid(manager, ORDER_TYPES.SELL)}, buy=${_countActiveOnGrid(manager, ORDER_TYPES.BUY)})`,
        'info'
    );
}

module.exports = {
    reconcileStartupOrders,
    attemptResumePersistedGridByPriceMatch,
    decideStartupGridAction,
};

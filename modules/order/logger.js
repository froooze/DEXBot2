/**
 * Logger - Color-coded console logger for OrderManager
 * 
 * Provides structured logging with:
 * - Log levels: debug, info, warn, error
 * - Color coding for order types (buy=green, sell=red, spread=yellow)
 * - Color coding for order states (virtual=gray, active=green)
 * - Formatted order grid display
 * - Fund status display (logFundsStatus)
 * 
 * Fund display (logFundsStatus) shows:
 * - available: max(0, chainFree - virtuel) + pendingProceeds
 * - total.chain: chainFree + committed.chain (on-chain balance)
 * - total.grid: committed.grid + virtuel (grid allocation)
 * - virtuel: VIRTUAL order sizes (reserved for future placement)
 * - committed.grid: ACTIVE order sizes (internal tracking)
 * - committed.chain: ACTIVE orders with orderId (confirmed on-chain)
 * 
 * @class
 */
class Logger {
    /**
     * Create a new Logger instance.
     * @param {string} level - Minimum log level to display ('debug', 'info', 'warn', 'error')
     */
    constructor(level = 'info') {
        this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
        this.level = level;
        this.colors = {
            reset: '\x1b[0m',
            buy: '\x1b[32m', sell: '\x1b[31m', spread: '\x1b[33m',
            debug: '\x1b[36m', info: '\x1b[37m', warn: '\x1b[33m', error: '\x1b[31m',
            virtual: '\x1b[90m', active: '\x1b[32m', partial: '\x1b[34m'
        };
    }

    log(message, level = 'info') {
        if (this.levels[level] >= this.levels[this.level]) {
            const color = this.colors[level] || '';
            console.log(`${color}[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${this.colors.reset}`);
        }
    }

    logOrderGrid(orders, marketPrice) {
        console.log('\n===== ORDER GRID =====');
        if (this.marketName) console.log(`Market: ${this.marketName} @ ${marketPrice}`);
        console.log('Price\t\tType\t\tState\t\tSize');
        console.log('-----------------------------------------------');
        const sorted = [...orders].sort((a, b) => b.price - a.price);
        sorted.forEach(order => {
            const typeColor = this.colors[order.type] || '';
            const stateColor = this.colors[order.state] || '';
            console.log(
                `${order.price.toFixed(4)}\t` +
                `${typeColor}${order.type.padEnd(8)}${this.colors.reset}\t` +
                `${stateColor}${order.state.padEnd(8)}${this.colors.reset}\t` +
                `${order.size.toFixed(8)}`
            );
        });
        console.log('===============================================\n');
    }

    /**
     * Print a summary of fund status for diagnostics.
     * Displays the complete fund structure from manager.funds:
     * - available: Free funds for new orders (chainFree - virtuel + pendingProceeds)
     * - total.chain: Total on-chain balance (chainFree + committed.chain)
     * - total.grid: Total grid allocation (committed.grid + virtuel)
     * - virtuel: VIRTUAL order sizes (reserved for future on-chain placement)
     * - committed.grid: ACTIVE order sizes (internal grid tracking)
     * - committed.chain: ACTIVE orders with orderId (confirmed on blockchain)
     * 
     * @param {OrderManager} manager - OrderManager instance to read funds from
     */
    logFundsStatus(manager) {
        if (!manager) return;
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        console.log('\n===== FUNDS STATUS =====');

        // Use new nested structure
        const gridBuy = Number.isFinite(Number(manager.funds?.available?.buy)) ? manager.funds.available.buy.toFixed(8) : 'N/A';
        const gridSell = Number.isFinite(Number(manager.funds?.available?.sell)) ? manager.funds.available.sell.toFixed(8) : 'N/A';
        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtuelBuy = manager.funds?.virtuel?.buy ?? 0;
        const virtuelSell = manager.funds?.virtuel?.sell ?? 0;
        const cacheBuy = manager.funds?.cacheFunds?.buy ?? 0;
        const cacheSell = manager.funds?.cacheFunds?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;

        console.log(`funds.available: Buy ${gridBuy} ${buyName} | Sell ${gridSell} ${sellName}`);
        console.log(`total.chain: Buy ${totalChainBuy.toFixed(8)} ${buyName} | Sell ${totalChainSell.toFixed(8)} ${sellName}`);
        console.log(`total.grid: Buy ${totalGridBuy.toFixed(8)} ${buyName} | Sell ${totalGridSell.toFixed(8)} ${sellName}`);
        console.log(`virtuel.grid: Buy ${virtuelBuy.toFixed(8)} ${buyName} | Sell ${virtuelSell.toFixed(8)} ${sellName}`);
        console.log(`cacheFunds: Buy ${cacheBuy.toFixed(8)} ${buyName} | Sell ${cacheSell.toFixed(8)} ${sellName}`);
        console.log(`committed.grid: Buy ${committedGridBuy.toFixed(8)} ${buyName} | Sell ${committedGridSell.toFixed(8)} ${sellName}`);
        console.log(`committed.chain: Buy ${committedChainBuy.toFixed(8)} ${buyName} | Sell ${committedChainSell.toFixed(8)} ${sellName}`);
    }

    // Print a comprehensive status summary using manager state.
    displayStatus(manager) {
        if (!manager) return;
        const market = manager.marketName || manager.config?.market || 'unknown';
        const activeOrders = manager.getOrdersByTypeAndState(null, 'active');
        const partialOrders = manager.getOrdersByTypeAndState(null, 'partial');
        const virtualOrders = manager.getOrdersByTypeAndState(null, 'virtual');
        console.log('\n===== STATUS =====');
        console.log(`Market: ${market}`);
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';

        // Use new nested structure
        const gridBuy = Number.isFinite(Number(manager.funds?.available?.buy)) ? manager.funds.available.buy.toFixed(8) : 'N/A';
        const gridSell = Number.isFinite(Number(manager.funds?.available?.sell)) ? manager.funds.available.sell.toFixed(8) : 'N/A';
        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtuelBuy = manager.funds?.virtuel?.buy ?? 0;
        const virtuelSell = manager.funds?.virtuel?.sell ?? 0;
        const cacheBuy = manager.funds?.cacheFunds?.buy ?? 0;
        const cacheSell = manager.funds?.cacheFunds?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;

        console.log(`funds.available: Buy ${gridBuy} ${buyName} | Sell ${gridSell} ${sellName}`);
        console.log(`total.chain: Buy ${totalChainBuy.toFixed(8)} ${buyName} | Sell ${totalChainSell.toFixed(8)} ${sellName}`);
        console.log(`total.grid: Buy ${totalGridBuy.toFixed(8)} ${buyName} | Sell ${totalGridSell.toFixed(8)} ${sellName}`);
        console.log(`virtuel.grid: Buy ${virtuelBuy.toFixed(8)} ${buyName} | Sell ${virtuelSell.toFixed(8)} ${sellName}`);
        console.log(`cacheFunds: Buy ${cacheBuy.toFixed(8)} ${buyName} | Sell ${cacheSell.toFixed(8)} ${sellName}`);
        console.log(`committed.grid: Buy ${committedGridBuy.toFixed(8)} ${buyName} | Sell ${committedGridSell.toFixed(8)} ${sellName}`);
        console.log(`committed.chain: Buy ${committedChainBuy.toFixed(8)} ${buyName} | Sell ${committedChainSell.toFixed(8)} ${sellName}`);
        console.log(`Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Partial ${partialOrders.length}`);
        console.log(`Spreads: ${manager.currentSpreadCount}/${manager.targetSpreadCount}`);
        // calculateCurrentSpread may exist on manager
        const spread = typeof manager.calculateCurrentSpread === 'function' ? manager.calculateCurrentSpread() : 0;
        console.log(`Current Spread: ${Number(spread).toFixed(2)}%`);
        console.log(`Spread Condition: ${manager.outOfSpread ? 'TOO WIDE' : 'Normal'}`);
    }
}

module.exports = Logger;


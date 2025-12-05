/**
 * Logger - Color-coded console logger for OrderManager
 * 
 * Provides structured logging with:
 * - Log levels: debug, info, warn, error
 * - Color coding for order types (buy=green, sell=red, spread=yellow)
 * - Color coding for order states (virtual=gray, active=green, filled=magenta)
 * - Formatted order grid display
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
            virtual: '\x1b[90m', active: '\x1b[32m', filled: '\x1b[35m'
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

    // Print a summary of available vs committed funds for diagnostics.
    // Accepts a manager instance and reads its funds & config to display names.
    logFundsStatus(manager) {
        if (!manager) return;
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        console.log('\n===== FUNDS STATUS =====');
        // Two kinds of "available" values exist:
        // - manager.funds.available -> funds available for creating new grid orders (grid allocation)
        // - manager.accountTotals (when present) -> free on-chain balances fetched from the blockchain
        const gridBuy = Number.isFinite(Number(manager.funds?.available?.buy)) ? manager.funds.available.buy.toFixed(8) : 'N/A';
        const gridSell = Number.isFinite(Number(manager.funds?.available?.sell)) ? manager.funds.available.sell.toFixed(8) : 'N/A';
        const chainBuy = (manager.accountTotals && Number.isFinite(Number(manager.accountTotals.buy))) ? Number(manager.accountTotals.buy).toFixed(8) : 'N/A';
        const chainSell = (manager.accountTotals && Number.isFinite(Number(manager.accountTotals.sell))) ? Number(manager.accountTotals.sell).toFixed(8) : 'N/A';
        console.log(`Available (grid): Buy ${gridBuy} ${buyName} | Sell ${gridSell} ${sellName}`);
        console.log(`Available (chain): Buy ${chainBuy} ${buyName} | Sell ${chainSell} ${sellName}`);
        console.log(`Committed: Buy ${manager.funds.committed.buy.toFixed(8)} ${buyName} | Sell ${manager.funds.committed.sell.toFixed(8)} ${sellName}`);
    }

    // Print a comprehensive status summary using manager state.
    displayStatus(manager) {
        if (!manager) return;
        const market = manager.marketName || manager.config?.market || 'unknown';
        const activeOrders = manager.getOrdersByTypeAndState(null, 'active');
        const virtualOrders = manager.getOrdersByTypeAndState(null, 'virtual');
        const filledOrders = manager.getOrdersByTypeAndState(null, 'filled');
        console.log('\n===== STATUS =====');
        console.log(`Market: ${market}`);
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';
        const gridBuy = Number.isFinite(Number(manager.funds?.available?.buy)) ? manager.funds.available.buy.toFixed(8) : 'N/A';
        const gridSell = Number.isFinite(Number(manager.funds?.available?.sell)) ? manager.funds.available.sell.toFixed(8) : 'N/A';
        const chainBuy = (manager.accountTotals && Number.isFinite(Number(manager.accountTotals.buy))) ? Number(manager.accountTotals.buy).toFixed(8) : 'N/A';
        const chainSell = (manager.accountTotals && Number.isFinite(Number(manager.accountTotals.sell))) ? Number(manager.accountTotals.sell).toFixed(8) : 'N/A';
        console.log(`Available Funds (grid): Buy ${gridBuy} ${buyName} | Sell ${gridSell} ${sellName}`);
        console.log(`Available Funds (chain): Buy ${chainBuy} ${buyName} | Sell ${chainSell} ${sellName}`);
        console.log(`Committed Funds: Buy ${manager.funds.committed.buy.toFixed(8)} ${buyName} | Sell ${manager.funds.committed.sell.toFixed(8)} ${sellName}`);
        console.log(`Start Funds: Buy ${manager.funds.total.buy.toFixed(8)} ${buyName} | Sell ${manager.funds.total.sell.toFixed(8)} ${sellName}`);
        console.log(`Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Filled ${filledOrders.length}`);
        console.log(`Spreads: ${manager.currentSpreadCount}/${manager.targetSpreadCount}`);
        // calculateCurrentSpread may exist on manager
        const spread = typeof manager.calculateCurrentSpread === 'function' ? manager.calculateCurrentSpread() : 0;
        console.log(`Current Spread: ${Number(spread).toFixed(2)}%`);
        console.log(`Spread Condition: ${manager.outOfSpread ? 'TOO WIDE' : 'Normal'}`);
    }
}

module.exports = Logger;


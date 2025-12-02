class Logger {
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
}

module.exports = Logger;


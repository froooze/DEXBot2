const assert = require('assert');
console.log('Running logger tests');

const Logger = require('../modules/order/index.js').logger;

// Capture console.log output
let captured = [];
const origLog = console.log;
console.log = (...args) => { captured.push(args.join(' ')); };

const logger = new Logger('debug');
logger.marketName = 'TEST/PAIR';

// Should log when level is debug (and info > debug)
logger.log('hello world', 'info');
logger.log('debug message', 'debug');

// logOrderGrid should print header and market
const sampleOrders = [ { price: 100, type: 'buy', state: 'virtual', size: 1 }, { price: 200, type: 'sell', state: 'virtual', size: 2 } ];
logger.logOrderGrid(sampleOrders, 150);

// Test logFundsStatus and displayStatus using a small manager-like stub
const mgrStub = {
	marketName: 'TEST/PAIR',
	config: { assetA: 'BASE', assetB: 'QUOTE', market: 'TEST/PAIR' },
	funds: { available: { buy: 1.2345, sell: 2.3456 }, committed: { buy: 0.5, sell: 0.25 }, total: { buy: 10, sell: 20 } },
	currentSpreadCount: 2,
	targetSpreadCount: 3,
	outOfSpread: false,
	getOrdersByTypeAndState: (type, state) => {
		if (state === 'active') return [1,2];
		if (state === 'virtual') return [1,2,3,4];
		if (state === 'filled') return [];
		return [];
	},
	calculateCurrentSpread: () => 3.1415
};

logger.logFundsStatus(mgrStub);
logger.displayStatus(mgrStub);

// Restore console.log
console.log = origLog;

// Assertions
const joined = captured.join('\n');
assert(joined.includes('hello world'), 'should include the info message');
assert(joined.includes('debug message'), 'should include debug message');
assert(joined.includes('ORDER GRID') || joined.includes('ORDER GRID'), 'should include ORDER GRID header');
assert(joined.includes('TEST/PAIR'), 'should include market name in grid');
// Ensure both grid and chain available funds are displayed
assert(joined.includes('Available (grid)') || joined.includes('Available Funds (grid)'), 'should include Available (grid) funds label');
assert(joined.includes('Available (chain)') || joined.includes('Available Funds (chain)'), 'should include Available (chain) funds label');

console.log('logger tests passed');

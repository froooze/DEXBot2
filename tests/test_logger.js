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

// Restore console.log
console.log = origLog;

// Assertions
const joined = captured.join('\n');
assert(joined.includes('hello world'), 'should include the info message');
assert(joined.includes('debug message'), 'should include debug message');
assert(joined.includes('ORDER GRID') || joined.includes('ORDER GRID'), 'should include ORDER GRID header');
assert(joined.includes('TEST/PAIR'), 'should include market name in grid');

console.log('logger tests passed');

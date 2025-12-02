const { OrderManager } = require('./manager');
// Runner may contain I/O and larger logic; require lazily to avoid loading it
// during small unit tests. Expose a lazy accessor instead.
const utils = require('./utils');
const constants = require('./constants');
const logger = require('./logger');
const order_grid = require('./order_grid');

module.exports = {
  OrderManager,
  runOrderManagerCalculation: (...args) => require('./runner').runOrderManagerCalculation(...args),
  utils,
  constants,
  logger,
  order_grid,
};


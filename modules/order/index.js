/**
 * modules/order/index.js - Combined entry point for the order subsystem
 * 
 * Exposes the OrderManager and supporting utilities for grid-based trading.
 * 
 * Key exports:
 * - OrderManager: Core class managing order grid and fund tracking
 * - grid: Grid creation and sizing utilities
 * - utils: Parsing, tolerance, matching, and reconciliation helpers
 * - constants: ORDER_TYPES, ORDER_STATES, defaults, and limits
 * - logger: Color-coded console output for debugging
 * 
 * Fund tracking model (see manager.js for details):
 * - available = max(0, chainFree - virtuel - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)
 * - total.chain = chainFree + committed.chain
 * - total.grid = committed.grid + virtuel
 */
const { OrderManager } = require('./manager');
// Runner may contain I/O and larger logic; require lazily to avoid loading it
// during small unit tests. Expose a lazy accessor instead.
const utils = require('./utils');
const constants = require('../constants');
const logger = require('./logger');
const grid = require('./grid');

module.exports = {
  OrderManager,
  // Lazy-load the calculation runner so tests can require this module without triggering heavy I/O.
  runOrderManagerCalculation: (...args) => require('./runner').runOrderManagerCalculation(...args),
  utils,
  constants,
  logger,
  grid,
};


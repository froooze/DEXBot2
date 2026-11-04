/**
 * modules/order/index.ts - Order Subsystem Entry Point
 *
 * Combined entry point that exports the order subsystem components.
 * Exposes OrderManager and supporting utilities for grid-based trading.
 *
 * ===============================================================================
 * EXPORTS
 * ===============================================================================
 *
 * CORE COMPONENTS:
 * - OrderManager - Core class managing order grid and fund tracking (manager.ts)
 * - grid - Grid creation and sizing utilities (grid.ts)
 * - utils - Combined helpers from utils/math.ts, utils/order.ts, and utils/system.ts
 * - constants - ORDER_TYPES, ORDER_STATES, defaults, and limits (../constants.ts)
 * - logger - Color-coded console output for debugging (logger.ts)
 *
 * ===============================================================================
 *
 * FUND TRACKING MODEL (see manager.ts for details):
 * - available = max(0, chainFree - virtual - applicableBtsFeesOwed - btsFeesReservation)
 * - total.chain = chainFree + committed.chain (on-blockchain)
 * - total.grid = committed.grid + virtual (grid allocation)
 *
 * ORDER STATES:
 * - VIRTUAL: Not placed on blockchain, reserved on grid
 * - ACTIVE: Placed on blockchain, active in market
 * - PARTIAL: Partially filled on blockchain
 *
 * ===============================================================================
 *
 * SUBSYSTEM MODULES:
 * 1. manager.ts - OrderManager class (order lifecycle, fund tracking)
 * 2. grid.ts - Grid engine (grid creation, synchronization, health)
 * 3. utils/math.ts, utils/order.ts, utils/system.ts - Helper functions by concern
 * 4. format.ts - Numeric formatting (18 functions for consistent display)
 * 5. accounting.ts - Accountant class (fund calculations and reconciliation)
 * 6. logger.ts - Logger class (structured, color-coded output)
 * 7. async_lock.ts - AsyncLock class (race condition prevention)
 * 8. working_grid.ts - WorkingGrid class (copy-on-write grid state)
 * 9. export.ts - Trade history extraction and CSV export
 * 10. grid_reconcile.ts - Grid reconciliation against chain (startup + maintenance)
 * 11. strategy.ts - StrategyEngine class (boundary-crawl rebalancing, target grid)
 * 12. sync_engine.ts - Real-time blockchain synchronization
 *
 * ===============================================================================
 */

// The logger is required lazily: it pulls in console/formatting setup that small
// unit tests do not need, and `logger` is exposed as a lazy getter below.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { OrderManager } from './manager.js';
import * as math from './utils/math.js';
import * as order from './utils/order.js';
import * as system from './utils/system.js';
import * as constants from '../constants.js';
import * as grid from './grid.js';
const utils = { ...math, ...order, ...system };

let _logger: unknown;
function getLogger(): unknown {
    if (!_logger) _logger = require('./logger').default;
    return _logger;
}

type OrderModuleExports = {
  OrderManager: typeof OrderManager;
  utils: typeof utils;
  constants: typeof constants;
  grid: typeof grid;
  logger?: unknown;
};
const _export: OrderModuleExports = {
  OrderManager,
  utils,
  constants,
  grid,
};
Object.defineProperty(_export, 'logger', { get: getLogger, enumerable: true });
export default _export

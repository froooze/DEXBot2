
import { getStorage } from '../storage/index.js';
import { path } from '../path_api.js';
import { runtime } from '../runtime.js';
import * as Format from './format.js';
import LoggerState from './logger_state.js';
import { LOGGING_CONFIG, ORDER_STATES, TIMING } from '../constants.js';
import { Config } from '../config.js';
import { getErrorMessage } from '../utils/errors.js';
import { withTimeout } from './utils/timeout.js';
import { CLI_COLORS } from '../cli_colors.js';

const storage = getStorage();

/**
 * Process-wide console-output floor shared by all Logger instances.
 * When set (e.g. to 'warn'), console output below that level is suppressed
 * for every logger while file logging continues unchanged. Used to keep
 * interactive prompts (bot configurator) free of chain-stack INFO spam
 * during short supervised operations. Always save/restore via
 * setGlobalConsoleLevel — never leave a non-null value behind.
 */
let _globalConsoleLevel: string | null = null;

/**
 * Set or clear the process-wide console log floor.
 * @param {string|null} level - Minimum level shown on console ('debug' |
 *   'info' | 'warn' | 'error' | 'critical'), or null to restore per-logger levels.
 *
 * Single-flight only: no concurrency guard, no nesting support. Overlapping
 * users clobber each other's saved value on restore — restrict to short
 * supervised sections of single-threaded CLI flows (bot editor, one-shot
 * analysis tools). NEVER use from a concurrent or long-running runtime.
 */
function setGlobalConsoleLevel(level: string | null) {
    _globalConsoleLevel = level;
}

/** Return the current process-wide console log floor (null = per-logger levels). */
function getGlobalConsoleLevel(): string | null {
    return _globalConsoleLevel;
}

/**
 * Color-coded console logger with structured output, optional file logging,
 * batched async writes, log rotation, JSON output, and correlation ID tracing.
 *
 * Configuration (LOGGING_CONFIG in constants.js):
 * - changeTracking: Smart detection of changes (only log what changed)
 * - display.colors.enabled: Force colors on/off (null = auto-detect TTY)
 * - display.fundStatus: Enable/disable fund status display
 * - display.statusSummary: Enable/disable comprehensive status summaries
 * - rotation: Size-based log rotation (total budget / maxFiles)
 * - json: Structured JSON output to file (optional)
 */
class Logger {
    level: string;
    config: any;
    category: string;
    quiet: boolean;
    logFile: any;
    state: any;
    levels: Record<string, number>;
    colors: any;
    marketName: any;
    correlationId: string | null;

    _writeQueue: string[];
    _writeTimer: ReturnType<typeof setTimeout> | null;
    _writeInterval: number;
    _maxQueueSize: number;
    _draining: boolean;
    _maxTotalSize: number;
    _maxLogFiles: number;
    _jsonOutput: boolean;
    _flushResolve: (() => void) | null;
    _flushPromise: Promise<void> | null;
    _lastFileErrorTime: number;

    /**
     * @param {string} [category='DEXBot'] - Logger category/prefix
     * @param {Object} [options]
     * @param {boolean} [options.quiet] - Suppress console output
     * @param {boolean} [options.quietUnderPm2=true] - Auto-quiet under PM2
     * @param {string} [options.logFile] - Optional path to log file
     * @param {string} [options.level='info'] - Log level
     * @param {Object} [options.configOverride] - Override LOGGING_CONFIG
     * @param {string} [options.correlationId] - Tracing ID for JSON output
     */
    constructor(category = 'DEXBot', options: { quiet?: boolean; quietUnderPm2?: boolean; logFile?: string; level?: string; configOverride?: any; correlationId?: string } = {}) {
        this.category = category;

        const isUnderPm2 = !!Config.pm_exec_path;
        const hasPm2Logging = !!(Config.pm_out_log_path || Config.pm_err_log_path);
        const pm2AutoQuiet = isUnderPm2 && hasPm2Logging;
        const quietUnderPm2 = options.quietUnderPm2 !== false;

        this.logFile = options.logFile || null;
        this.quiet = options.quiet ?? (!!this.logFile || (quietUnderPm2 && pm2AutoQuiet));
        this.level = options.level || 'info';
        this.config = options.configOverride || LOGGING_CONFIG;

        this.state = new LoggerState();

        this.levels = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 };

        let useColors = runtime.stdout.isTTY;
        if (this.config.display?.colors?.enabled === false) {
            useColors = false;
        } else if (this.config.display?.colors?.enabled === true) {
            useColors = true;
        }

        this.colors = useColors ? {
            reset: CLI_COLORS.reset,
            buy: CLI_COLORS.buy, sell: CLI_COLORS.sell, spread: CLI_COLORS.spread,
            debug: CLI_COLORS.cyan, info: CLI_COLORS.white, warn: CLI_COLORS.spread, error: CLI_COLORS.sell, critical: CLI_COLORS.redStrong,
            virtual: CLI_COLORS.brightBlack, active: CLI_COLORS.buy, partial: CLI_COLORS.lightBlue
        } : {
            reset: '', buy: '', sell: '', spread: '',
            debug: '', info: '', warn: '', error: '', critical: '',
            virtual: '', active: '', partial: ''
        };

        this.marketName = null;
        this.correlationId = options.correlationId || null;

        this._writeQueue = [];
        this._writeTimer = null;
        this._writeInterval = 100;
        this._maxQueueSize = 1000;
        this._draining = false;
        this._maxTotalSize = this.config.rotation?.maxSize || 1181116007; // 1.1 GB (1.1 * 1024^3, rounded up)
        this._maxLogFiles = this.config.rotation?.maxFiles || 10;
        this._jsonOutput = this.config.json?.enabled ?? false;
        this._flushResolve = null;
        this._flushPromise = null;
        this._lastFileErrorTime = 0;
    }

    _enqueueWrite(text: string) {
        if (!this.logFile) return;
        if (Config.pm_out_log_path || Config.pm_err_log_path) return;
        this._writeQueue.push(text);
        if (this._writeQueue.length >= this._maxQueueSize) {
            this._drainQueue();
        } else if (!this._writeTimer) {
            this._writeTimer = setTimeout(() => this._drainQueue(), this._writeInterval);
        }
    }

    async _drainQueue() {
        this._writeTimer = null;
        if (this._draining || this._writeQueue.length === 0) return;

        // Capture a drain deadline so a single stuck write never hangs flush()
        // indefinitely. If _drainQueue runs past this timeout, force-resolve
        // the flush promise and drop remaining lines rather than blocking
        // shutdown or the caller forever.
        const drainDeadline = Date.now() + TIMING.LOGGER_DRAIN_TIMEOUT_MS; // 10s max per drain cycle
        this._draining = true;

        const batch = this._writeQueue.splice(0, this._maxQueueSize);
        const plainLines = batch.map(t => t.replace(/\x1b\[[0-9;]*m/g, ''));

        try {
            const dir = path.dirname(this.logFile);
            storage.ensureDir(dir);

            const perFileLimit = Math.floor(this._maxTotalSize / (this._maxLogFiles + 1));
            if (perFileLimit > 0) {
                try {
                    const stat = storage.stat(this.logFile);
                    if ((stat.size ?? 0) >= perFileLimit) {
                        this._rotateLogFile();
                    }
                } catch (err: any) {
                }
            }

            await storage.appendFileAsync(this.logFile, plainLines.join('\n') + '\n', 'utf8');
        } catch (err: any) {
            const now = Date.now();
            if (now - this._lastFileErrorTime > 60000) {
                this._lastFileErrorTime = now;
                console.error(`[LOGGER] File write failed (${this.logFile}): ${getErrorMessage(err)}`);
            }
        }

        this._draining = false;

        // If drain took too long, force-resolve the flush promise so callers
        // (including shutdown) are not blocked indefinitely.
        if (Date.now() >= drainDeadline) {
            const timedOutResolve = this._flushResolve;
            this._flushResolve = null;
            if (timedOutResolve) timedOutResolve();
            console.error(`[LOGGER] Drain timeout — ${this._writeQueue.length} lines remaining`);
            this._writeQueue = []; // discard remaining to prevent infinite loop
            return;
        }

        if (this._writeQueue.length > 0) {
            // Resolve will be re-attached when flush() is called again
            this._writeTimer = setTimeout(() => this._drainQueue(), this._writeInterval);
        } else {
            const resolve = this._flushResolve;
            this._flushResolve = null;
            if (resolve) resolve();
        }
    }

    _rotateLogFile() {
        const maxFiles = this._maxLogFiles;
        if (maxFiles <= 0) return;

        for (let i = maxFiles - 1; i >= 1; i--) {
            const oldPath = this.logFile + '.' + i;
            const newPath = this.logFile + '.' + (i + 1);
            try {
                storage.access(oldPath);
                storage.rename(oldPath, newPath);
            } catch (err: any) {
            }
        }

        try {
            storage.access(this.logFile);
            storage.rename(this.logFile, this.logFile + '.1');
        } catch (err: any) {
        }
    }

    _getJsonLine(level: string, message: string, correlationId?: string | null): string | null {
        if (!this._jsonOutput) return null;
        const ts = new Date().toISOString();
        const entry: any = {
            timestamp: ts,
            level: level.toUpperCase(),
            category: this.category,
            message: message
        };
        if (correlationId) {
            entry.correlationId = correlationId;
        }
        return JSON.stringify(entry);
    }

    /**
     * Log a message with optional timestamp and level.
     * Console output is immediate; file output is queued and batched.
     * When json output is enabled, file receives JSON only (console stays text).
     * @param {string} message
     * @param {string} [level='info'] - debug | info | warn | error | critical
     */
    log(message: string, level = 'info') {
        const effectiveLevel = _globalConsoleLevel ?? this.level;
        if (this.levels[level] >= this.levels[effectiveLevel]) {
            const color = this.colors[level] || '';
            const isUnderPm2 = !!Config.pm_exec_path;
            const timestamp = isUnderPm2 ? '' : new Date().toISOString();
            const timestampPart = timestamp ? `[${timestamp}] ` : '';
            const output = `${color}${timestampPart}[${level.toUpperCase()}] [${this.category}] ${message}${this.colors.reset}`;

            if (!this.quiet) {
                if (level === 'error') {
                    console.error(output);
                } else if (level === 'warn') {
                    console.warn(output);
                } else {
                    console.log(output);
                }
            }

            if (this._jsonOutput) {
                const jsonLine = this._getJsonLine(level, message, this.correlationId);
                if (jsonLine) {
                    this._enqueueWrite(jsonLine);
                }
            } else {
                this._enqueueWrite(output);
            }
        }
    }

    /** Log at info level. */
    info(msg: string) { this.log(msg, 'info'); }
    /** Log at warn level. */
    warn(msg: string) { this.log(msg, 'warn'); }
    /** Log at error level. */
    error(msg: string) { this.log(msg, 'error'); }
    /** Log at debug level. */
    debug(msg: string) { this.log(msg, 'debug'); }
    /** Log at critical level (above error — sustained failure signal). */
    critical(msg: string) { this.log(msg, 'critical'); }

    /**
     * Console visibility for direct (un-leveled) output such as grid dumps
     * and status tables. Treated as 'info': hidden while a global floor
     * above info is set. File logging is unaffected — the floor is
     * console-only. `raw()` and the [LOGGER] self-diagnostics bypass this
     * deliberately: raw() is explicit caller output, and logger-internal
     * errors must never be silencable.
     */
    _consoleVisible(level = 'info'): boolean {
        if (this.quiet) return false;
        if (_globalConsoleLevel == null) return true;
        return (this.levels[level] ?? 1) >= (this.levels[_globalConsoleLevel] ?? 0);
    }

    /**
     * Write raw output (no timestamp, no level).
     * @param {string} text - Text to write
     */
    raw(text: string) {
        if (!this.quiet) {
            runtime.stdout.write(text);
        }
        this._enqueueWrite(text);
    }

    /**
     * Set tracing ID for subsequent log lines (per-instance, not per-call).
     * Included in JSON output when enabled. Cleared by passing null.
     */
    setCorrelationId(id: string | null) {
        this.correlationId = id;
    }

    /**
     * Wait until the write queue is empty.
     * Call during shutdown to guarantee all pending lines are flushed.
     * Concurrent callers share the in-flight flush promise instead of
     * replacing each other's resolver.
     */
    flush(timeoutMs: number = 15000): Promise<void> {
        if (!this._flushPromise) {
            const inner = new Promise<void>((resolve) => {
                if (this._writeQueue.length === 0 && !this._draining) {
                    resolve();
                    return;
                }
                this._flushResolve = resolve;
                if (this._writeTimer) {
                    clearTimeout(this._writeTimer);
                    this._writeTimer = null;
                }
                this._drainQueue();
            });
            this._flushPromise = inner.finally(() => {
                this._flushPromise = null;
            });
        }
        return withTimeout(this._flushPromise, timeoutMs, { onTimeout: 'resolve', defaultValue: undefined as any });
    }

    /**
     * Log a sample of the order grid.
     * @param {Array<Object>} orders - The list of orders.
     * @param {number} startPrice - The market start price.
     */
    logOrderGrid(orders: any[], startPrice: number) {
        const header = '\n===== ORDER GRID (SAMPLE) =====';
        let output = header + '\n';
        if (this.marketName) output += `Market: ${this.marketName} @ ${startPrice}\n`;
        output += 'Price       Slot      Type      State       Size\n';
        output += '----------------------------------------------------\n';

        if (this._consoleVisible()) console.log(header);
        if (this.marketName && this._consoleVisible()) console.log(`Market: ${this.marketName} @ ${startPrice}`);
        if (this._consoleVisible()) console.log('Price       Slot      Type      State       Size');
        if (this._consoleVisible()) console.log('----------------------------------------------------');

        const sorted = [...orders].sort((a, b) => b.price - a.price);

        const allSells = sorted.filter(o => o.type === 'sell');
        const allSpreads = sorted.filter(o => o.type === 'spread');
        const allBuys = sorted.filter(o => o.type === 'buy');

        const sellEdge = allSells.slice(0, 3);
        const sellNearSpread = allSells.slice(-3);
        [...sellEdge, ...sellNearSpread].forEach(order => this._logOrderRow(order));

        if (allSpreads.length > 0) {
            const highIdx = 0;
            const midIdx = Math.floor(allSpreads.length / 2);
            const lowIdx = allSpreads.length - 1;

            const high = allSpreads[highIdx];
            const mid = (allSpreads.length > 2) ? allSpreads[midIdx] : null;
            const low = allSpreads[lowIdx];

            this._logOrderRow(high);
            if (mid) {
                if (midIdx > highIdx + 1) { if (this._consoleVisible()) console.log(''); output += '\n'; }
                this._logOrderRow(mid);
                if (lowIdx > midIdx + 1) { if (this._consoleVisible()) console.log(''); output += '\n'; }
            } else if (lowIdx > highIdx + 1) {
                if (this._consoleVisible()) console.log(''); output += '\n';
            }

            if (low.id !== high.id) {
                this._logOrderRow(low);
            }
        }

        const buyNearSpread = allBuys.slice(0, 3);
        const buyEdge = allBuys.slice(-3);
        [...buyNearSpread, ...buyEdge].forEach(order => this._logOrderRow(order));

        const footer = '===============================================\n';
        if (this._consoleVisible()) console.log(footer);
        this._enqueueWrite(output + footer);
    }

    _logOrderRow(order: any) {
        const typeColor = this.colors[order.type] || '';
        const stateColor = this.colors[order.state] || '';
        const price = Format.formatPrice4(order.price).padEnd(12);
        const id = (order.id || '').padEnd(10);
        const type = order.type.padEnd(10);
        const state = order.state.padEnd(12);
        const size = Format.formatAmount8(order.size);
        const output = `${price}${id}${typeColor}${type}${this.colors.reset}${stateColor}${state}${this.colors.reset}${size}`;

        if (this._consoleVisible()) {
            console.log(output);
        }
        this._enqueueWrite(output);
    }

    /**
     * Print a summary of fund status for diagnostics with optional context.
     * Skips output if nothing changed (change detection) unless forceDetailed.
     * @param {Object} manager - OrderManager instance
     * @param {string} context - Context label (e.g. "AFTER fill")
     * @param {boolean} forceDetailed - Force output even if no change
     */
    logFundsStatus(manager: any, context = '', forceDetailed = false) {
        if (!manager) return;
        if (!this.config.display?.fundStatus?.enabled && !forceDetailed) return;

        const isDebugMode = this.level === 'debug';
        const buyName = manager.config?.assetB?.symbol || manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA?.symbol || manager.config?.assetA || 'base';
        const headerContext = context ? ` [${context}]` : '';

        const fundState = {
            availableBuy: manager.funds?.available?.buy,
            availableSell: manager.funds?.available?.sell,
            btsFeesOwed: manager.funds?.btsFeesOwed
        };

        const isCriticalEvent = forceDetailed ||
            context.includes('fill') ||
            context.includes('order_created') ||
            context.includes('order_cancelled') ||
            context.includes('anomaly') ||
            context.includes('violation') ||
            context.includes('ERROR');

        if (this.config.changeTracking?.enabled) {
            const { isNew, changes } = this.state.detectChanges('funds', fundState);
            if (!isNew && !Object.keys(changes).length && !isCriticalEvent) {
                return;
            }
        }

        const buyPrecision = manager.config?.assetB?.precision;
        const sellPrecision = manager.config?.assetA?.precision;
        const availableBuy = (Number.isFinite(Number(manager.funds?.available?.buy)) && buyPrecision !== undefined)
            ? Format.formatAmountByPrecision(manager.funds.available.buy, buyPrecision)
            : 'N/A';
        const availableSell = (Number.isFinite(Number(manager.funds?.available?.sell)) && sellPrecision !== undefined)
            ? Format.formatAmountByPrecision(manager.funds.available.sell, sellPrecision)
            : 'N/A';

        const c = this.colors;
        const buy = c.buy;
        const sell = c.sell;
        const reset = c.reset;

        const output = `Funds${headerContext}: ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`;
        this.log(output, 'info');

        if (isDebugMode && isCriticalEvent && this.config.display?.fundStatus?.showDetailed) {
            this._logDetailedFunds(manager, headerContext);
        }
    }

    _logDetailedFunds(manager: any, headerContext = '') {
        const buyName = manager.config?.assetB?.symbol || manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA?.symbol || manager.config?.assetA || 'base';
        const buyPrecision = manager.config?.assetB?.precision;
        const sellPrecision = manager.config?.assetA?.precision;
        if (buyPrecision === undefined || sellPrecision === undefined) {
            this.log(`[Funds] Detailed funds unavailable: missing precision for ${buyName}/${sellName}`, 'debug');
            return;
        }
        const c = this.colors;
        const debug = c.debug;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        const availableBuy = Number.isFinite(Number(manager.funds?.available?.buy))
            ? Format.formatAmountByPrecision(manager.funds.available.buy, buyPrecision)
            : 'N/A';
        const availableSell = Number.isFinite(Number(manager.funds?.available?.sell))
            ? Format.formatAmountByPrecision(manager.funds.available.sell, sellPrecision)
            : 'N/A';

        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;
        const btsFeesOwed = manager.funds?.btsFeesOwed ?? 0;

        const lines = [
            `\n${debug}=== DETAILED FUNDS STATUS${headerContext} ===${reset}`,
            `${debug}AVAILABLE:${reset}`,
            `  ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`,
            `\n${debug}CHAIN BALANCES:${reset}`,
            `  total.chain: ${buy}Buy ${Format.formatAmountByPrecision(totalChainBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(totalChainSell, sellPrecision)}${reset}`,
            `\n${debug}GRID ALLOCATIONS:${reset}`,
            `  total.grid: ${buy}Buy ${Format.formatAmountByPrecision(totalGridBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(totalGridSell, sellPrecision)}${reset}`,
            `  committed.grid: ${buy}Buy ${Format.formatAmountByPrecision(committedGridBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(committedGridSell, sellPrecision)}${reset}`,
            `  virtual (reserved): ${buy}Buy ${Format.formatAmountByPrecision(virtualBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(virtualSell, sellPrecision)}${reset}`,
            `\n${debug}COMMITTED ON-CHAIN:${reset}`,
            `  ${buy}Buy ${Format.formatAmountByPrecision(committedChainBuy, buyPrecision)}${reset} | ${sell}Sell ${Format.formatAmountByPrecision(committedChainSell, sellPrecision)}${reset}`,
            `\n${debug}DEDUCTIONS:${reset}`,
            `  btsFeesOwed: ${Format.formatAmount8(btsFeesOwed)} BTS${reset}\n`
        ];

        lines.forEach(line => {
            if (this._consoleVisible()) console.log(line);
            this._enqueueWrite(line);
        });
    }

    /**
     * Print a comprehensive status summary using manager state.
     * @param {Object} manager - The manager instance
     * @param {boolean} forceOutput - Force output even if disabled in config
     */
    displayStatus(manager: any, forceOutput = false) {
        if (!manager) return;
        if (!this.config.display?.statusSummary?.enabled && !forceOutput) return;

        const market = manager.marketName || manager.config?.market || 'unknown';
        const activeOrders = manager.getOrdersByTypeAndState?.(null, ORDER_STATES.ACTIVE) || [];
        const partialOrders = manager.getOrdersByTypeAndState?.(null, ORDER_STATES.PARTIAL) || [];
        const virtualOrders = manager.getOrdersByTypeAndState?.(null, ORDER_STATES.VIRTUAL) || [];

        const buyName = manager.config?.assetB?.symbol || manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA?.symbol || manager.config?.assetA || 'base';
        const buyPrecision = manager.config?.assetB?.precision;
        const sellPrecision = manager.config?.assetA?.precision;
        if (buyPrecision === undefined || sellPrecision === undefined) {
            this.log(`[Status] Status summary unavailable: missing precision for ${buyName}/${sellName}`, 'debug');
            return;
        }

        const gridBuy = Number.isFinite(Number(manager.funds?.available?.buy))
            ? Format.formatAmountByPrecision(manager.funds.available.buy, buyPrecision)
            : 'N/A';
        const gridSell = Number.isFinite(Number(manager.funds?.available?.sell))
            ? Format.formatAmountByPrecision(manager.funds.available.sell, sellPrecision)
            : 'N/A';

        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;

        const c = this.colors;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        const lines = [
            '\n===== STATUS =====',
            `Market: ${market}`,
            `funds.available: ${buy}Buy ${gridBuy}${reset} ${buyName} | ${sell}Sell ${gridSell}${reset} ${sellName}`,
            `total.chain: ${buy}Buy ${Format.formatAmountByPrecision(totalChainBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(totalChainSell, sellPrecision)}${reset} ${sellName}`,
            `total.grid: ${buy}Buy ${Format.formatAmountByPrecision(totalGridBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(totalGridSell, sellPrecision)}${reset} ${sellName}`,
            `virtual.grid: ${buy}Buy ${Format.formatAmountByPrecision(virtualBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(virtualSell, sellPrecision)}${reset} ${sellName}`,
            `committed.grid: ${buy}Buy ${Format.formatAmountByPrecision(committedGridBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(committedGridSell, sellPrecision)}${reset} ${sellName}`,
            `committed.chain: ${buy}Buy ${Format.formatAmountByPrecision(committedChainBuy, buyPrecision)}${reset} ${buyName} | ${sell}Sell ${Format.formatAmountByPrecision(committedChainSell, sellPrecision)}${reset} ${sellName}`,
            `Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Partial ${partialOrders.length}`,
            `Spreads: ${manager.initialSpreadCount > 0 ? `${manager.currentSpreadCount}/${manager.initialSpreadCount} (gap)` : 'n/a (gap)'}`,
        ];

        if (typeof manager.calculateCurrentSpread === 'function') {
            const spread = manager.calculateCurrentSpread();
            lines.push(`Current Spread: ${Number.isFinite(spread) ? `${Format.formatPercent2(spread)}%` : 'one-sided (n/a)'}`);
        }

        lines.push(`Spread Condition: ${manager.outOfSpread > 0 ? 'TOO WIDE (' + manager.outOfSpread + ')' : 'Normal'}`);

        lines.forEach(line => {
            if (this._consoleVisible()) console.log(line);
            this._enqueueWrite(line);
        });
    }
}

function isPm2Runtime(): boolean {
    return !!Config.pm_exec_path;
}

function createPm2AwareLogger(category: string, options: { quietUnderPm2?: boolean } = {}) {
    return new Logger(category, options);
}
export { createPm2AwareLogger, isPm2Runtime, setGlobalConsoleLevel, getGlobalConsoleLevel }
export default Logger



/**
 * modules/order/export.ts - Trade Export Module
 *
 * Trading history extraction and CSV export engine.
 * Parses PM2 log files to extract trading fills and exports to standardized format.
 *
 * Usage:
 *   import * as exporter from './modules/order/export.js';
 *   const result = await exporter.exportBotTrades(botKey, botConfig, outputDir);
 *
 * Output Format:
 * - CSV: Trades in standardized format (unix, price, amount, side, fee_asset, fee_amount, order_id)
 * - JSON: Sanitized bot settings (excludes private keys)
 *
 * ===============================================================================
 * TABLE OF CONTENTS (5 exported functions + internal helpers)
 * ===============================================================================
 *
 * PUBLIC EXPORTS (5 functions)
 *   1. exportBotTrades(botKey, botConfig, outputDir) - Main export function (async)
 *      Orchestrates trade extraction and writing CSV/JSON exports
 *      Returns: { success, trades_exported, csv_path, settings_path, output_dir, timestamp }
 *
 *   2. parseLogFile(logFilePath, assetContext?) - Parse PM2 log file to extract trades (async)
 *      Reads line-by-line, extracts legacy FILL entries AND multi-line
 *      FILL DETECTED blocks, links with fee information
 *      Returns: Array of trade objects with { timestamp, side, amount, price, proceeds, fee_asset, fee_amount, order_id }
 *
 *   3. parseFillLine(line) - Parse legacy fill entry from a single log line
 *      Expected format: [TIMESTAMP] [DEBUG] [FILL] side fill: size=X, price=Y, proceeds=Z [order=1.7.N]
 *      Returns: { timestamp, side, amount, price, proceeds, order_id? } or null
 *
 *   4. parseFeeLine(line) - Parse fee information from log line
 *      Expected format: [TIMESTAMP] [INFO] [FEES] N maker fills @ FEE ASSET = TOTAL
 *      Returns: { timestamp, count, fee_per_fill, fee_asset, total_fee } or null
 *
 *   5. deriveTradeFromFillBlock(block, assetContext) - Derive a trade from a
 *      parsed FILL DETECTED block using the available asset context.
 *
 * INTERNAL HELPERS
 *   - isoToUnixSeconds(iso) - Shared ISO-timestamp to unix-seconds conversion
 *   - extractLogTimestamp(line) - Pull unix-seconds timestamp from a log line prefix
 *   - rawToHuman(raw, precision) - Scale satoshi amounts (soft variant of
 *     blockchainToFloat that returns NaN instead of throwing; kept local so
 *     the offline exporter avoids pulling in utils/math's dependency tree)
 *   - buildOrientationHypothesis(...) - Trade fields for one pays-asset orientation
 *   - resolveExportAssetContext(botKey, botConfig) - Resolve offline asset metadata
 *     Reads profiles/orders/<botKey>.json for assetA/assetB ids+precisions and
 *     grid price stats. No chain access (export stays offline/browser-safe).
 *     Returns: { assetA, assetB, gridMedianPrice?, ... } or null
 *   - writeTradesCSV(trades, outputPath) - Write the generated trade CSV
 *   - writeSettingsJSON(botConfig, botName, outputPath) - Write sanitized settings JSON
 *
 * ===============================================================================
 *
 * LOG FORMAT PATTERNS:
 * Legacy fill line (kept for backward compat; may carry an order= suffix):
 *   [2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS
 * Legacy fee line:
 *   [2026-01-15T15:29:06.185Z] [INFO] [FEES] BTS fees calculated: 1 maker fills @ 0.04826000 BTS = 0.04826000 BTS
 * Current fill block (emitted by dexbot_fill_runtime.ts; asset IDs in parens
 * present on logs written after the issue-#22 fix, absent on older logs):
 *   [2026-08-28T18:19:51.192Z] [INFO] [DEXBot] ===== FILL DETECTED =====
 *   [2026-08-28T18:19:51.192Z] [INFO] [DEXBot] Order ID: 1.7.573895253
 *   [2026-08-28T18:19:51.192Z] [INFO] [DEXBot] Pays: 1036496 (1.3.5537), Receives: 74071699 (1.3.0)
 *   [2026-08-28T18:19:51.192Z] [INFO] [DEXBot] Block: 113873892 (History ID: 1.11.1395319063)
 *
 * CSV HEADER:
 * unix, price, amount, side, fee_asset, fee_amount, order_id
 *
 * ===============================================================================
 */


import { getStorage } from '../storage/index.js';
import { createRequire } from 'node:module';
import { path } from '../path_api.js';
import * as Format from './format.js';
import { TIMING, DEFAULT_CONFIG } from '../constants.js';
import { PATHS } from '../paths.js';
import Logger from '../order/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import type { GridConfig, UnknownRecord } from '../types.js';
import { nowIso } from './utils/system.js';
const _require = createRequire(import.meta.url);
const storage = getStorage();
interface ReadlineModule {
    createInterface(options: { input: unknown; crlfDelay?: number }): AsyncIterable<string>;
}
let _readline: ReadlineModule | null = null;
function getReadline(): ReadlineModule {
    if (!_readline && _require) _readline = _require('readline');
    return _readline!;
}
const exportLogger = new Logger('Export');

/**
 * Parse a legacy fill line from PM2 log file
 * Expected format: [2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS
 * An optional trailing `order=1.7.123` suffix is captured when present.
 * @param {string} line - Raw log line
 * @returns {Object|null} Parsed fill object or null on no match
 */
interface FillCore {
    side: string;
    amount: number;
    price: number;
    proceeds: number;
}

interface FillEntry extends FillCore {
    timestamp: number;
    fee_asset: string;
    fee_amount: number;
    order_id?: string;
}

interface FeeEntry {
    count: number;
    fee_per_fill: number;
    fee_asset: string;
    total_fee: number;
    timestamp: number;
}

/** Shared ISO-8601 to unix-seconds conversion for all log parsers. */
function isoToUnixSeconds(iso: string): number {
    return new Date(iso).getTime() / TIMING.MILLISECONDS_PER_SECOND;
}

function parseFillLine(line: string): FillEntry | null {
    const fillMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\].*\[FILL\]\s+(\w+)\s+fill:\s+size=([\d.]+),\s+price=([\d.]+),\s+proceeds=([\d.]+)(?:\s+[A-Za-z.]+)?(?:\s+order=(1\.7\.\d+))?/);

    if (!fillMatch) return null;

    return {
        timestamp: isoToUnixSeconds(fillMatch[1]),               // Unix timestamp in seconds
        side: fillMatch[2],                                   // 'buy' or 'sell'
        amount: parseFloat(fillMatch[3]),                     // Size in base asset
        price: parseFloat(fillMatch[4]),                      // Execution price
        proceeds: parseFloat(fillMatch[5]),                    // Proceeds/cost
        fee_asset: 'BTS',
        fee_amount: 0,
        order_id: fillMatch[6] || ''
    };
}

/**
 * Parse fee information from log line
 * Expected format: [2026-01-15T15:29:06.185Z] [INFO] [FEES] BTS fees calculated: 1 maker fills @ 0.04826000 BTS = 0.04826000 BTS
 * @param {string} line - Raw log line
 * @returns {Object|null} Parsed fee object or null on no match
 */
function parseFeeLine(line: string): FeeEntry | null {
    const feeMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\].*\[FEES\].*?(\d+)\s+maker\s+fills\s+@\s+([\d.]+)\s+(\w+)\s*=\s*([\d.]+)\s+\w+/);

    if (!feeMatch) return null;

    return {
        count: parseInt(feeMatch[2]),
        fee_per_fill: parseFloat(feeMatch[3]),
        fee_asset: feeMatch[4],
        total_fee: parseFloat(feeMatch[5]),
        timestamp: isoToUnixSeconds(feeMatch[1])
    };
}

/**
 * Offline asset metadata for trade derivation (no chain access — export stays
 * offline/browser-safe). Resolved from the bot's persisted grid file.
 */
interface ExportAsset {
    id: string;
    precision: number;
    symbol?: string;
}

interface ExportAssetContext {
    assetA: ExportAsset;
    assetB: ExportAsset;
    /** Median grid price (assetB per assetA), used to disambiguate bare pre-#22 blocks. */
    gridMedianPrice?: number;
}

interface FillBlock {
    timestamp?: number;
    orderId?: string;
    paysRaw?: number;
    paysAssetId?: string;
    receivesRaw?: number;
    receivesAssetId?: string;
    blockNum?: number;
    historyId?: string;
}

const FILL_BLOCK_HEADER_RE = /=+\s*FILL DETECTED\s*=+/;
const LOG_TIMESTAMP_RE = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/;
const FILL_BLOCK_ORDER_RE = /Order ID:\s*(1\.7\.\d+)/;
// Matches both variants (asset IDs in parens were added by the issue-#22 fix):
//   Pays: 1036496 (1.3.5537), Receives: 74071699 (1.3.0)   (new)
//   Pays: 1036496, Receives: 74071699                        (old/bare)
const FILL_BLOCK_AMOUNTS_RE = /Pays:\s*(\S+?)(?:\s*\(\s*([\d.]+)\s*\))?\s*,?\s*Receives:\s*(\S+?)(?:\s*\(\s*([\d.]+)\s*\))?\s*$/;
const FILL_BLOCK_HEIGHT_RE = /Block:\s*(\d+)\s*\(History ID:\s*([^)]+)\)/;

/** Extract a unix-seconds timestamp from a log line prefix, or undefined. */
function extractLogTimestamp(line: string): number | undefined {
    const m = line.match(LOG_TIMESTAMP_RE);
    return m ? isoToUnixSeconds(m[1]) : undefined;
}

function rawToHuman(raw: number, precision: number): number {
    return raw / Math.pow(10, precision);
}

/**
 * Build a trade hypothesis for one pays-asset orientation.
 * @param {boolean} paysIsA - True when the pays asset is assetA (a SELL)
 * @returns Trade fields or null when amounts are not positive finite numbers
 */
function buildOrientationHypothesis(paysRaw: number, receivesRaw: number, paysIsA: boolean, ctx: ExportAssetContext): FillCore | null {
    const paysHuman = rawToHuman(paysRaw, paysIsA ? ctx.assetA.precision : ctx.assetB.precision);
    const receivesHuman = rawToHuman(receivesRaw, paysIsA ? ctx.assetB.precision : ctx.assetA.precision);
    if (!Number.isFinite(paysHuman) || paysHuman <= 0 || !Number.isFinite(receivesHuman) || receivesHuman <= 0) return null;
    // Price convention (assetB per assetA), mirroring parseChainOrder:
    // SELL pays A and receives B, BUY pays B and receives A.
    const price = paysIsA ? receivesHuman / paysHuman : paysHuman / receivesHuman;
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
        side: paysIsA ? 'sell' : 'buy',
        amount: paysIsA ? paysHuman : receivesHuman,  // base-asset (A) quantity traded
        price,
        proceeds: paysIsA ? receivesHuman : paysHuman  // quote-asset (B) value: BTS proceeds on SELL, BTS cost on BUY
    };
}

/**
 * Derive a trade from a parsed FILL DETECTED block.
 * Side comes from the pays/receives asset orientation, price from
 * precision-scaled amounts. Bare pre-#22 blocks carry no asset IDs; they are
 * disambiguated by log-distance to the grid median price (the two hypotheses
 * sit symmetric around 10^(precA-precB) on a log scale, so the grid median —
 * which tracks the market — picks the right one decisively; near-ties are
 * treated as ambiguous and skipped).
 * @returns FillEntry or null when the block cannot be derived exactly
 */
function deriveTradeFromFillBlock(block: FillBlock, ctx: ExportAssetContext | null): FillEntry | null {
    if (!ctx) return null;
    if (block.timestamp == null) return null;
    if (block.paysRaw == null || block.receivesRaw == null) return null;

    let hypothesis: FillCore | null = null;

    if (block.paysAssetId && block.receivesAssetId) {
        const sellOrientation = block.paysAssetId === ctx.assetA.id && block.receivesAssetId === ctx.assetB.id;
        const buyOrientation = block.paysAssetId === ctx.assetB.id && block.receivesAssetId === ctx.assetA.id;
        if (!sellOrientation && !buyOrientation) return null;  // foreign-market fill, not ours
        hypothesis = buildOrientationHypothesis(block.paysRaw, block.receivesRaw, sellOrientation, ctx);
    } else if (block.paysAssetId || block.receivesAssetId) {
        // Half-present block (truncated log line): exactly one side survived.
        // Pays present orients directly; receives present inverts
        // (receives A => pays B => BUY; receives B => pays A => SELL).
        // A present side matching neither local asset is a foreign-market fill.
        let paysIsA: boolean;
        if (block.paysAssetId) {
            if (block.paysAssetId !== ctx.assetA.id && block.paysAssetId !== ctx.assetB.id) return null;
            paysIsA = block.paysAssetId === ctx.assetA.id;
        } else {
            if (block.receivesAssetId !== ctx.assetA.id && block.receivesAssetId !== ctx.assetB.id) return null;
            paysIsA = block.receivesAssetId === ctx.assetB.id;
        }
        hypothesis = buildOrientationHypothesis(block.paysRaw, block.receivesRaw, paysIsA, ctx);
    } else {
        // Bare pre-#22 block: no asset orientation logged.
        const sellHyp = buildOrientationHypothesis(block.paysRaw, block.receivesRaw, true, ctx);
        const buyHyp = buildOrientationHypothesis(block.paysRaw, block.receivesRaw, false, ctx);
        if (sellHyp && !buyHyp) hypothesis = sellHyp;
        else if (buyHyp && !sellHyp) hypothesis = buyHyp;
        else if (sellHyp && buyHyp && ctx.gridMedianPrice && ctx.gridMedianPrice > 0) {
            const sellDist = Math.abs(Math.log(sellHyp.price) - Math.log(ctx.gridMedianPrice));
            const buyDist = Math.abs(Math.log(buyHyp.price) - Math.log(ctx.gridMedianPrice));
            if (Math.abs(sellDist - buyDist) < 0.5) return null;  // ambiguous, skip
            hypothesis = sellDist < buyDist ? sellHyp : buyHyp;
        } else return null;
    }

    if (!hypothesis) return null;
    return {
        timestamp: block.timestamp,
        ...hypothesis,
        fee_asset: 'BTS',
        fee_amount: 0,
        order_id: block.orderId || ''
    };
}

/**
 * Resolve offline asset metadata + grid price stats for a bot from its
 * persisted grid file (profiles/orders/<botKey>.json). Falls back to scanning
 * all persisted grids for a matching meta.key/meta.name. No chain access.
 * @returns ExportAssetContext or null when nothing usable was found
 */
interface GridFileDoc extends UnknownRecord {
    assets?: { assetA?: { id?: unknown; precision?: number; symbol?: string }; assetB?: { id?: unknown; precision?: number; symbol?: string } };
    meta?: { key?: unknown; name?: unknown };
    grid?: unknown;
}

function resolveExportAssetContext(botKey: string, botConfig: GridConfig | null | undefined): ExportAssetContext | null {
    const readGridFile = (fileName: string): GridFileDoc | null => {
        try {
            return JSON.parse(storage.readFile(path.join(PATHS.ORDERS_DIR, fileName), 'utf8'));
        } catch {
            return null;
        }
    };

    // Exact bot file first, then a meta.key/meta.name scan over all grids.
    let dirFiles: string[] = [];
    try {
        dirFiles = storage.readdir(PATHS.ORDERS_DIR).filter((f: string) => f.endsWith('.json'));
    } catch { /* no orders dir */ }
    const exactName = `${botKey}.json`;
    const ordered = [exactName, ...dirFiles.filter((f) => f !== exactName)];
    const wantKey = String(botKey).toLowerCase();
    const wantName = String(botConfig?.name || botKey).toLowerCase();

    let doc: GridFileDoc | null = null;
    for (const fileName of ordered) {
        const candidate = readGridFile(fileName);
        if (!candidate || !candidate.assets) continue;
        if (fileName === exactName) {
            doc = candidate;
            break;
        }
        const metaKey = candidate.meta?.key ? String(candidate.meta.key).toLowerCase() : '';
        const metaName = candidate.meta?.name ? String(candidate.meta.name).toLowerCase() : '';
        if ((metaKey && metaKey === wantKey) || (metaName && metaName === wantName)) {
            doc = candidate;
            break;
        }
    }
    if (!doc) return null;
    const assetA = doc.assets?.assetA;
    const assetB = doc.assets?.assetB;
    if (!assetA?.id || !assetB?.id) return null;
    if (!Number.isFinite(assetA.precision) || !Number.isFinite(assetB.precision)) return null;

    const ctx: ExportAssetContext = {
        assetA: { id: String(assetA.id), precision: assetA.precision as number, symbol: assetA.symbol },
        assetB: { id: String(assetB.id), precision: assetB.precision as number, symbol: assetB.symbol }
    };

    try {
        const grid = Array.isArray(doc.grid) ? doc.grid : Object.values(doc.grid || {});
        const prices = grid
            .map((o: { price?: unknown }) => Number(o?.price))
            .filter((p: number) => Number.isFinite(p) && p > 0)
            .sort((a: number, b: number) => a - b);
        if (prices.length > 0) ctx.gridMedianPrice = prices[Math.floor(prices.length / 2)];
    } catch { /* grid stats are best-effort */ }

    return ctx;
}

/**
 * Parse PM2 log file to extract trades
 * Handles legacy single-line [FILL] entries AND multi-line FILL DETECTED
 * blocks (current fill-runtime format, see issue #22).
 * @param {string} logFilePath - Path to PM2 log file
 * @param {ExportAssetContext|null} [assetContext] - Offline asset metadata for block derivation
 * @returns {Promise<Array>} Array of trade objects
 */
async function parseLogFile(logFilePath: string | null | undefined, assetContext: ExportAssetContext | null = null) {
    const fills: FillEntry[] = [];
    const fees: FeeEntry[] = [];
    let pendingBlock: FillBlock | null = null;
    let skippedBlocks = 0;

    const finalizeBlock = (block: FillBlock) => {
        // Fee defaults already set by deriveTradeFromFillBlock.
        const trade = deriveTradeFromFillBlock(block, assetContext);
        if (trade) fills.push(trade);
        else skippedBlocks++;
    };

    try {
        const fileStream = storage.createReadStream(logFilePath as string);
        const rl = getReadline().createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            // Parse legacy fill lines (fee defaults already set by the parser)
            const fill = parseFillLine(line);
            if (fill) {
                fills.push(fill);
                continue;
            }

            // Collect fee lines; linked to fills in one pass after the loop
            const fee = parseFeeLine(line);
            if (fee) {
                fees.push(fee);
                continue;
            }

            // FILL DETECTED block header starts a new block (a missing Block
            // line in the previous block finalizes it best-effort).
            if (FILL_BLOCK_HEADER_RE.test(line)) {
                if (pendingBlock) finalizeBlock(pendingBlock);
                pendingBlock = { timestamp: extractLogTimestamp(line) };
                continue;
            }

            if (pendingBlock) {
                const ts = extractLogTimestamp(line);
                if (ts !== undefined && pendingBlock.timestamp === undefined) pendingBlock.timestamp = ts;

                const orderMatch = line.match(FILL_BLOCK_ORDER_RE);
                if (orderMatch) {
                    pendingBlock.orderId = orderMatch[1];
                    continue;
                }

                const amountsMatch = line.match(FILL_BLOCK_AMOUNTS_RE);
                if (amountsMatch) {
                    const pays = Number(amountsMatch[1]);
                    const receives = Number(amountsMatch[3]);
                    if (Number.isFinite(pays)) pendingBlock.paysRaw = pays;
                    if (Number.isFinite(receives)) pendingBlock.receivesRaw = receives;
                    if (amountsMatch[2]) pendingBlock.paysAssetId = amountsMatch[2];
                    if (amountsMatch[4]) pendingBlock.receivesAssetId = amountsMatch[4];
                    continue;
                }

                const blockMatch = line.match(FILL_BLOCK_HEIGHT_RE);
                if (blockMatch) {
                    pendingBlock.blockNum = parseInt(blockMatch[1], 10);
                    pendingBlock.historyId = blockMatch[2].trim();
                    // Block line is the last line the emitter writes per fill.
                    finalizeBlock(pendingBlock);
                    pendingBlock = null;
                    continue;
                }
            }
        }

        // Best-effort: close a trailing block whose Block line never arrived.
        if (pendingBlock) finalizeBlock(pendingBlock);

        if (skippedBlocks > 0) {
            exportLogger.warn(`Skipped ${skippedBlocks} fill block(s) that could not be derived (missing asset context or ambiguous orientation)`);
        }

        // Link any remaining fills with fees. A FEES line aggregates N fills
        // ("N maker fills @ per_fill = total"), so each fill in the window gets
        // the per-fill share (== total when N == 1, preserving legacy behavior
        // for the single-fill case); the closest fee line in the window wins.
        for (const fill of fills) {
            if (fill.fee_amount === 0 && fees.length > 0) {
                let best: FeeEntry | null = null;
                let bestDist = Infinity;
                for (const f of fees) {
                    const dist = Math.abs((f as { timestamp?: number }).timestamp! - fill.timestamp);
                    if (dist < 5 && dist < bestDist) {
                        best = f;
                        bestDist = dist;
                    }
                }
                if (best) {
                    fill.fee_asset = best.fee_asset;
                    const perFill = Number.isFinite(best.fee_per_fill)
                        ? best.fee_per_fill
                        : (best.count > 0 ? best.total_fee / best.count : best.total_fee);
                    fill.fee_amount = perFill;
                }
            }
        }

        return fills;
    } catch (err) {
        exportLogger.error(`Failed to parse log file ${logFilePath}: ${getErrorMessage(err)}`);
        return [];
    }
}

/**
 * Write trades to CSV file for local analysis/ tooling
 * @param {Array} trades - Array of trade objects
 * @param {string} outputPath - Path to output CSV file
 * @returns {Promise<Object>} { success: boolean, count: number } or { success: false, error: string }
 */
async function writeTradesCSV(trades: FillEntry[], outputPath: string) {
    try {
        // CSV header
        const headers = ['unix', 'price', 'amount', 'side', 'fee_asset', 'fee_amount', 'order_id'];

        // CSV rows
        const rows = trades.map((trade: FillEntry) => [
            trade.timestamp.toFixed(1),
            Format.formatPrice(trade.price),
            Format.formatAmount8(trade.amount),
            trade.side,
            trade.fee_asset || 'BTS',
            Format.formatAmount8(trade.fee_amount || 0),
            trade.order_id || ''
        ]);

        // Combine and write
        const csv = [headers, ...rows]
            .map((row: Array<string | number>) => row.map((val: string | number) => {
                // Wrap in quotes when the value contains a comma, double-quote,
                // or newline; escape embedded quotes by doubling them
                if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            }).join(','))
            .join('\n');

        storage.writeFile(outputPath, csv + '\n', 'utf8');
        exportLogger.info(`✓ Exported ${trades.length} trades to ${outputPath}`);

        return { success: true, count: trades.length };
    } catch (err) {
        exportLogger.error(`Failed to write CSV: ${getErrorMessage(err)}`);
        return { success: false, error: getErrorMessage(err) };
    }
}

/**
 * Write sanitized bot settings to JSON file
 * Excludes private keys and sensitive data
 * @param {Object} botConfig - Bot configuration object
 * @param {string} botName - Bot name
 * @param {string} outputPath - Path to output JSON file
 * @returns {Promise<Object>} Write result { success, count } or { success: false, error }
 */
async function writeSettingsJSON(botConfig: GridConfig, botName: string, outputPath: string) {
    try {
        const sanitized = {
            bot_name: botName,
            strategy: botConfig.strategy || 'grid_trading',
            market: botConfig.market || `${botConfig.assetA}/${botConfig.assetB}`,
            parameters: {
                start_price: botConfig.startPrice || DEFAULT_CONFIG.startPrice,
                min_price: botConfig.minPrice || DEFAULT_CONFIG.minPrice,
                max_price: botConfig.maxPrice || DEFAULT_CONFIG.maxPrice,
                increment_percent: botConfig.incrementPercent || DEFAULT_CONFIG.incrementPercent,
                target_spread_percent: botConfig.targetSpreadPercent || DEFAULT_CONFIG.targetSpreadPercent,
                core_orders: botConfig.coreOrders || DEFAULT_CONFIG.coreOrders,
                edge_orders: botConfig.edgeOrders ?? DEFAULT_CONFIG.edgeOrders,
                bot_funds: botConfig.botFunds || DEFAULT_CONFIG.botFunds,
                weight_distribution: botConfig.weightDistribution || DEFAULT_CONFIG.weightDistribution,
                dry_run: botConfig.dryRun || false,
                active: botConfig.active !== false
            },
            assets: {
                base: botConfig.assetA,
                quote: botConfig.assetB
            },
            exported_at: nowIso()
        };

        storage.writeFile(outputPath, JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
        exportLogger.info(`✓ Exported settings to ${outputPath}`);

        return { success: true };
    } catch (err) {
        exportLogger.error(`Failed to write settings JSON: ${getErrorMessage(err)}`);
        return { success: false, error: getErrorMessage(err) };
    }
}

/**
 * Export bot trades from PM2 log file to CSV
 * @param {string} botKey - Bot identifier (e.g., 'aaa-bbb-0')
 * @param {Object} botConfig - Bot configuration object
 * @param {string} outputDir - Output directory for exports (default: './exports')
 * @returns {Promise<Object>} Export result status
 */
async function exportBotTrades(botKey: string, botConfig: GridConfig, outputDir: string = './exports') {
    try {
        // Ensure output directory exists
        storage.ensureDir(outputDir);

        // Find log file (PM2 format: {botKey}-error.log or {botKey}.log)
        const logsDir = PATHS.LOGS_DIR;
        let logFilePath: string | null = null;

        try {
            const logFiles = storage.readdir(logsDir);
            const want = String(botKey).toLowerCase();
            // Case-insensitive: log files use the display name (<bot>.log)
            // while bot keys are lowercase (e.g. <botKey>). Prefer the exact
            // "<key>.log" hit, fall back to any non-error log containing the key.
            const exactLog = logFiles.find((f: string) =>
                f.toLowerCase() === `${want}.log`
            );
            const matchingLog = exactLog || logFiles.find((f: string) =>
                f.toLowerCase().includes(want) && f.endsWith('.log') && !f.toLowerCase().includes('error')
            );

            if (matchingLog) {
                logFilePath = path.join(logsDir, matchingLog);
            }
        } catch (err) {
            exportLogger.warn(`Could not read logs directory: ${getErrorMessage(err)}`);
        }

        // Resolve offline asset metadata so FILL DETECTED blocks can be
        // derived to side/price/amount (issue #22). Pure file reads, no chain.
        const assetContext = resolveExportAssetContext(botKey, botConfig);
        if (!assetContext) {
            exportLogger.warn(`No persisted asset metadata found for ${botKey}; fill blocks without asset IDs will be skipped`);
        }

        // Parse trades from log file
        const trades = logFilePath ? await parseLogFile(logFilePath, assetContext) : [];

        if (trades.length === 0) {
            exportLogger.warn(`No trades found in log file for ${botKey}`);
        }

        // Write trades CSV
        const csvPath = path.join(outputDir, `${botKey}_trades.csv`);
        const csvResult = await writeTradesCSV(trades, csvPath);

        // Write settings JSON
        const settingsPath = path.join(outputDir, `${botKey}_settings.json`);
        const settingsResult = await writeSettingsJSON(botConfig, botKey, settingsPath);

        return {
            success: csvResult.success && settingsResult.success,
            trades_exported: trades.length,
            csv_path: csvPath,
            settings_path: settingsPath,
            output_dir: outputDir,
            timestamp: nowIso()
        };
    } catch (err) {
        exportLogger.error(`Export failed for ${botKey}: ${getErrorMessage(err)}`);
        return {
            success: false,
            error: getErrorMessage(err),
            bot_key: botKey
        };
    }
}

export { exportBotTrades, parseLogFile, parseFillLine, parseFeeLine, deriveTradeFromFillBlock }


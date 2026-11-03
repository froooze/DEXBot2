#!/usr/bin/env node

/**
 * DEXBot Order Analysis Script
 *
 * Analyzes all order files in profiles/orders/ sorted by modified date.
 * Provides compact terminal output checking:
 * - Real spread vs. target spread (including double-sided status)
 * - Increment value % geometric consistency between grid slots
 * - Total funds of AssetA and AssetB in the grid
 * - Grid slot distribution (% near center) vs grid composition
 *
 * Usage:
 *   node dist/scripts/analyze-orders.js                  # terminal output
 *   node dist/scripts/analyze-orders.js <bot|account>    # one bot, or every bot on an account
 *   node dist/scripts/analyze-orders.js --export         # standalone HTML report
 */



import fs from 'node:fs';
import path from 'node:path';
import { formatCurrency, formatFundsValue } from '../modules/order/format.js';
import { resolveConfiguredPriceBound } from '../modules/order/utils/order.js';
import { ORDER_TYPES, ORDER_STATES, MARKET_ADAPTER } from '../modules/constants.js';
import { applyAsymmetricBounds } from '../market_adapter/core/asymmetric_bounds.js';
import { PATHS } from '../modules/paths.js';
import { getWhitelistFlags } from '../modules/market_adapter_whitelist.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../modules/utils/errors.js';
import { toFileUrl } from '../analysis/chart_utils.js';
import { CLI_TAGS, savedLine } from '../modules/cli_progress.js';
import { isSameBotName } from '../modules/utils/sanitize_key.js';
// Bot keys and `<bot|account>` target matching are shared with the other
// analysis tools (analysis/bot_key_utils) so the commands cannot drift.
import { computeBotKey, matchBotAccountTarget, matchBotEntryTarget } from '../analysis/bot_key_utils.js';
import { CLI_COLORS as colors } from '../modules/cli_colors.js';
import { pathToFileURL } from 'node:url';

/** Loose JSON-object view used across the analyzer. */
type JsonObj = Record<string, unknown>;

interface GridSlot {
  type?: string;
  state?: string;
  price: number;
  size: number;
  orderId?: string | null;
  [key: string]: unknown;
}

interface GridSnapshot {
  meta?: JsonObj;
  grid?: GridSlot[];
  assets?: { assetA?: { symbol?: unknown }; assetB?: { symbol?: unknown } };
  boundaryIdx?: number | null;
  [key: string]: unknown;
}

interface WeightSnapshot {
  effectiveWeights?: JsonObj;
  baseWeights?: JsonObj;
  rawAsymmetryFactor?: unknown;
  appliedAsymmetryFactor?: unknown;
  maxAsymmetryFactor?: unknown;
  isReady?: unknown;
  trend?: unknown;
  finalOffset?: unknown;
  [key: string]: unknown;
}

interface DynamicGridSnapshot extends GridSnapshot {
  dynamicWeights?: WeightSnapshot;
  asymmetricBounds?: JsonObj;
  amaCenterPrice?: unknown;
  gridCenterPrice?: unknown;
  updatedAt?: unknown;
}

interface BotConfig {
  name?: unknown;
  minPrice?: unknown;
  maxPrice?: unknown;
  targetSpreadPercent?: unknown;
  incrementPercent?: unknown;
  gridPrice?: unknown;
  coreOrders?: unknown;
  botFunds?: JsonObj;
  weightDistribution?: JsonObj;
  [key: string]: unknown;
}

interface DynamicWeightInfo {
  amaCenterPrice?: unknown;
  rawAsymmetryFactor?: unknown;
  appliedAsymmetryFactor?: unknown;
  trend?: unknown;
  isRecent?: unknown;
  minPrice?: unknown;
  maxPrice?: unknown;
  effectiveWeights?: JsonObj;
  baseWeights?: JsonObj;
  live?: JsonObj | null;
  base?: JsonObj | null;
  [key: string]: unknown;
}

interface SpreadAnalysis { real: number; target: number | null; diff: number | null; pass: boolean | null }
interface IncrementAnalysis { avg: number; target: number | null; [key: string]: unknown }
interface SlotCounts {
  buy: number; sell: number; spread: number;
  activeBuy: number; virtualBuy: number; activeSell: number; virtualSell: number;
  partialBuy: number; partialSell: number;
  [key: string]: unknown;
}
interface FundSide { bts: number; xrp: number; [key: string]: unknown }
interface FundsBreakdown { buy: FundSide; sell: FundSide; [key: string]: unknown }
interface DistributionAnalysis { match: { buyDiff: number; sellDiff: number; [key: string]: unknown }; [key: string]: unknown }
interface AsymmetricBoundsDisplay {
  resolvedMinPrice: number; resolvedMaxPrice: number; trend: string; appliedAsymmetryFactor: number;
  [key: string]: unknown;
}
interface AnalysisResult {
  pair: string;
  botName: string;
  lastUpdated: Date;
  hasConfig: boolean;
  marketPrice: number | null;
  gridMinPrice: number | null;
  gridMaxPrice: number | null;
  spread: SpreadAnalysis;
  increment: IncrementAnalysis;
  slots: SlotCounts;
  funds: FundsBreakdown;
  coreOrdersTarget: { buy: number; sell: number } | null;
  botFunds: { buy: string; sell: string } | null;
  weightDistribution: JsonObj | null;
  dynamicWeight: DynamicWeightInfo | null;
  asymmetricBounds: AsymmetricBoundsDisplay | null;
  slotData: { buy: GridSlot[]; sell: GridSlot[] };
  distribution: DistributionAnalysis;
  boundaryLess: boolean;
  gridPriceLabel: unknown;
  gridPriceValue: unknown;
  gridPriceStale: unknown;
  [key: string]: unknown;
}

interface DistributionCounts {
  activeBuy: number;
  virtualBuy: number;
  spread: number;
  activeSell: number;
  virtualSell: number;
}

const ORDERS_DIR = PATHS.ORDERS_DIR;
const BOTS_CONFIG = PATHS.PROFILES.BOTS_JSON;

// Color codes for terminal output (centralized in modules/cli_colors.ts).

// Partial block characters for weight visualization (0-8 eighths height)
const partialBlocks = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Maximum age (ms) for a dynamic grid snapshot to be considered "recently available".
// The market adapter writes a fresh snapshot on every cycle; a gap larger than this
// typically means the adapter is stopped or stuck for that bot. We allow up to two
// full cycles of drift (one missed cycle + slack for slow processing) before falling
// back to the static-only display, so the live colors track the actual adapter
// cadence rather than a hand-tuned timeout.
const DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS = 2 * MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds * 1000;

// Tolerance (absolute weight delta) for treating the two live weights as equal
// when picking a color. Half a percentage point avoids noisy green/red flicker
// when the dynamic weight sits exactly on the static baseline.
const DYNAMIC_WEIGHT_EPSILON = 0.005;

// Bar width configuration (single source of truth)
const BAR_WIDTH = 51;
// Header width: prefix width (11 chars for "   Slots:  ") + bar width
const HEADER_WIDTH = 11 + BAR_WIDTH;

/**
 * Utility Functions
 * Helper functions for file I/O, formatting, and data retrieval
 */

function hasOrderGrid(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as JsonObj;
  return Boolean(d.meta && typeof d.meta === 'object' && Array.isArray(d.grid));
}

/**
 * isAmaGridPrice: Detect bots whose grid price follows the AMA (Kaufman) stream.
 *
 * Mirrors the predicate used in market_adapter.ts / unlock.ts / pm2.ts so the
 * analyzer only attempts to load a dynamic grid snapshot for AMA bots. Non-AMA
 * bots never have a meaningful dynamic grid file.
 */
function isAmaGridPrice(config: unknown) {
  return resolveAmaKey(config) !== null;
}

// Mirrors MARKET_ADAPTER.DEFAULT_AMA_KEY in modules/constants.ts — keep in sync.
function resolveAmaKey(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const cfg = config as { gridPrice?: unknown };
  const gridPrice = typeof cfg.gridPrice === 'string' ? cfg.gridPrice.trim().toLowerCase() : '';
  if (!/^ama(?:[1-4])?$/.test(gridPrice)) return null;
  if (gridPrice === 'ama') return MARKET_ADAPTER.DEFAULT_AMA_KEY;
  return gridPrice.toUpperCase();
}

function readDynamicGridSnapshot(botKey: string): DynamicGridSnapshot | null {
  if (!botKey) return null;
  try {
    const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    if (!fs.existsSync(filePath)) return null;
    const data = readJSON(filePath);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

/**
 * computeAsymmetricBoundsPrices: Delegates to the production applyAsymmetricBounds
 * so the displayed resolved bounds stay in lockstep with live grid scaling.
 * (appliedAsymmetryFactor is already the clamped live value, so it is fed back
 * through the canonical function with maxSlopeOffset/maxAsymmetryFactor = 1.)
 */
function computeAsymmetricBoundsPrices(centerPrice: number, minPrice: number, maxPrice: number, trend: string, appliedAsymmetryFactor: number): { resolvedMinPrice: number; resolvedMaxPrice: number } | null {
  if (!Number.isFinite(centerPrice) || centerPrice <= 0
    || !Number.isFinite(minPrice) || minPrice <= 0
    || !Number.isFinite(maxPrice) || maxPrice <= 0
    || !Number.isFinite(appliedAsymmetryFactor)
    || (trend !== 'UP' && trend !== 'DOWN')) {
    return null;
  }
  const metrics = applyAsymmetricBounds({
    centerPrice,
    minPrice,
    maxPrice,
    trend,
    slopeOffset: appliedAsymmetryFactor,
    maxSlopeOffset: 1,
    maxAsymmetryFactor: 1,
  });
  if (!Number.isFinite(metrics.resolvedMinPrice) || !Number.isFinite(metrics.resolvedMaxPrice)) {
    return null;
  }
  return { resolvedMinPrice: metrics.resolvedMinPrice, resolvedMaxPrice: metrics.resolvedMaxPrice };
}

/**
 * buildDynamicWeightInfo: Extract a display-ready market-adapter payload.
 *
 * Reads the latest AMA dynamic-grid snapshot for AMA-whitelisted bots. Dynamic
 * weight values are attached only when the bot is also dynamic-weight
 * whitelisted and the snapshot contains effective weights. AMA center and
 * freshness status remain available for AMA-only bots.
 */
function buildDynamicWeightInfo(botKey: string, config: BotConfig): DynamicWeightInfo | null {
  if (!isAmaGridPrice(config)) return null;
  const whitelistFlags = getWhitelistFlags(botKey);
  if (whitelistFlags.ama !== true) return null;
  const snapshot = readDynamicGridSnapshot(botKey);
  if (!snapshot) return null;
  const dw = snapshot.dynamicWeights && typeof snapshot.dynamicWeights === 'object'
    ? snapshot.dynamicWeights
    : null;
  const hasDynamicWeightData = whitelistFlags.dynamicWeight === true
    && dw
    && dw.effectiveWeights
    && typeof dw.effectiveWeights === 'object';
  let live: JsonObj | null = null;
  let base: JsonObj | null = null;
  if (hasDynamicWeightData) {
    const effBuy = Number(dw.effectiveWeights?.buy);
    const effSell = Number(dw.effectiveWeights?.sell);
    if (Number.isFinite(effBuy) && Number.isFinite(effSell)) {
      const baseFromSnapshot = dw.baseWeights && typeof dw.baseWeights === 'object' ? dw.baseWeights : null;
      const baseBuy = baseFromSnapshot && Number.isFinite(Number(baseFromSnapshot.buy))
        ? Number(baseFromSnapshot.buy)
        : (config.weightDistribution && Number.isFinite(Number(config.weightDistribution.buy))
            ? Number(config.weightDistribution.buy)
            : null);
      const baseSell = baseFromSnapshot && Number.isFinite(Number(baseFromSnapshot.sell))
        ? Number(baseFromSnapshot.sell)
        : (config.weightDistribution && Number.isFinite(Number(config.weightDistribution.sell))
            ? Number(config.weightDistribution.sell)
            : null);
      if (Number.isFinite(baseBuy) && Number.isFinite(baseSell)) {
        live = { buy: effBuy, sell: effSell };
        base = { buy: baseBuy, sell: baseSell };
      }
    }
  }
  const updatedAtMs = Date.parse(String(snapshot.updatedAt || ''));
  const isRecent = Number.isFinite(updatedAtMs)
    && (Date.now() - updatedAtMs) <= DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS;
  // Fallback to root-level asymmetricBounds when dynamicWeights is absent.
  // The market adapter writes this when asymmetricBounds: true, regardless of
  // whether dynamicWeight is enabled for this bot.
  const rootBounds = !dw && snapshot?.asymmetricBounds && typeof snapshot.asymmetricBounds === 'object'
    ? snapshot.asymmetricBounds
    : null;
  const amaCenterPrice = Number.isFinite(Number(snapshot.amaCenterPrice))
    ? Number(snapshot.amaCenterPrice)
    : (Number.isFinite(Number(snapshot.gridCenterPrice)) ? Number(snapshot.gridCenterPrice) : null);
  const rawAsymmetryFactor = dw && Number.isFinite(Number(dw.rawAsymmetryFactor))
    ? Number(dw.rawAsymmetryFactor)
    : (rootBounds && Number.isFinite(Number(rootBounds.rawAsymmetryFactor))
        ? Number(rootBounds.rawAsymmetryFactor)
        : null);
  const appliedAsymmetryFactor = dw && Number.isFinite(Number(dw.appliedAsymmetryFactor))
    ? Number(dw.appliedAsymmetryFactor)
    : (rootBounds && Number.isFinite(Number(rootBounds.appliedAsymmetryFactor))
        ? Number(rootBounds.appliedAsymmetryFactor)
        : null);
  const maxAsymmetryFactor = dw && Number.isFinite(Number(dw.maxAsymmetryFactor))
    ? Number(dw.maxAsymmetryFactor)
    : null;
  return {
    live,
    base,
    dynamicWeightEnabled: whitelistFlags.dynamicWeight === true,
    isReady: dw ? dw.isReady === true : false,
    trend: dw && typeof dw.trend === 'string' ? dw.trend
      : (rootBounds && typeof rootBounds.trend === 'string' ? rootBounds.trend : null),
    finalOffset: dw && Number.isFinite(Number(dw.finalOffset)) ? Number(dw.finalOffset) : null,
    amaCenterPrice,
    centerPrice: Number.isFinite(Number(snapshot.centerPrice)) ? Number(snapshot.centerPrice) : null,
    isRecent,
    updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs) : null,
    rawAsymmetryFactor,
    appliedAsymmetryFactor,
    maxAsymmetryFactor,
  };
}

function isRealGridOrder(order: unknown): boolean {
  if (!order || typeof order !== 'object') return false;
  const o = order as { state?: unknown; type?: unknown; orderId?: unknown; price?: unknown; size?: unknown };
  const hasRealState = o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL;
  const hasRealType = o.type === ORDER_TYPES.BUY || o.type === ORDER_TYPES.SELL;
  const hasOrderId = typeof o.orderId === 'string' && o.orderId.trim().length > 0;
  return hasRealState
    && hasRealType
    && hasOrderId
    && Number(o.price) > 0
    && Number(o.size) > 0;
}

function getRealGridOrders(botData: GridSnapshot): GridSlot[] {
  return Array.isArray(botData?.grid) ? botData.grid.filter(isRealGridOrder) : [];
}

/**
 * getModifiedTime: Get file modification timestamp
 * Used to sort order files by most recently updated
 * @param {string} filePath - Path to file
 * @returns {Date} Modification time
 */
function getModifiedTime(filePath: string): Date {
  return fs.statSync(filePath).mtime;
}

/**
 * formatPercent: Convert decimal to percentage string
 * Example: 0.05 -> "5.00%"
 * @param {number} value - Decimal value (0-1)
 * @returns {string} Formatted percentage with 2 decimal places
 */
function formatPercent(value: number): string {
  return (value * 100).toFixed(2) + '%';
}

/**
 * stripColorCodes: Remove ANSI color codes from a string
 * @param {string} str - String that may contain color codes
 * @returns {string} String without color codes
 */
function stripColorCodes(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * padStringCentered: Pad a string to a target visual width, accounting for color codes
 * Centers the string within the specified width with padding
 * @param {string} str - String that may contain color codes
 * @param {number} width - Target visual width
 * @returns {string} Padded string with original colors preserved
 */
// Load bot configurations
const botsConfig = readJSON<{ bots?: JsonObj[] }>(BOTS_CONFIG).bots ?? [];

/**
 * formatBotFunds: Normalize a botFunds side value for display.
 *
 * botFunds accepts both percentage strings ("90%") and absolute numbers (35
 * meaning 35 units of the side's asset) — see the README bot options table.
 * The "Funds:" display path calls string methods (padEnd/replace) on these
 * values, so a numeric setting crashed the whole analysis with
 * "str.replace is not a function". Always hand the display a string.
 *
 * @param {string|number|null} value - raw botFunds side value from bots.json
 * @returns {string} display representation, '-' when unset
 */
function formatBotFunds(value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '-';
  const str = String(value);
  return str.length > 0 ? str : '-';
}

function getConfiguredBotConfig(botKey: string, botData: GridSnapshot): JsonObj | null {
  const meta = botData?.meta || {};
  return botsConfig.find((bot: JsonObj, index: number) => {
    if (!bot) return false;
    // Same key generator the runtime writes with (analysis/bot_key_utils →
    // modules/account_orders), so a renamed pair can never drift.
    return computeBotKey(bot, index) === botKey || (meta.name && isSameBotName(bot.name, meta.name));
  }) || null;
}

interface OrderFileCandidate {
  include: boolean;
  reason?: string;
  report?: boolean;
  name?: string;
  path?: string;
  botKey?: string;
  config?: BotConfig | null;
  mtime?: Date;
  [key: string]: unknown;
}

function getOrderFileCandidate(fileName: string): OrderFileCandidate {
  const filePath = path.join(ORDERS_DIR, fileName);
  if (!fileName.endsWith('.json')) {
    return { include: false, reason: 'not a JSON file', report: false };
  }
  if (fileName.endsWith('.dynamicgrid.json')) {
    return { include: false, reason: 'dynamic grid snapshot', report: false };
  }

  let data;
  try {
    data = readJSON(filePath);
  } catch (error) {
    return { include: false, reason: `invalid JSON: ${getErrorMessage(error)}`, report: true, name: fileName };
  }

  if (!hasOrderGrid(data)) {
    return { include: false, reason: 'not a persisted order grid', report: true, name: fileName };
  }

  // Derive botKey from the file name: profiles/orders/<botKey>.json
  const botKey = fileName.replace(/\.json$/, '');
  const botData = data;

  const config = getConfiguredBotConfig(botKey, botData);
  if (!config) {
    return { include: false, reason: 'no matching bot config', report: true, name: fileName };
  }

  const realOrders = getRealGridOrders(botData);
  if (realOrders.length === 0) {
    return { include: false, reason: 'no real on-chain orders', report: true, name: fileName };
  }

  return { include: true, name: fileName, path: filePath, botKey, config };
}

// Get all order files sorted by modified date
function getOrderFiles() {
  const candidates = fs.readdirSync(ORDERS_DIR).map(getOrderFileCandidate);
  const files = candidates
    .filter((candidate) => candidate.include)
    .map((f) => ({
      ...f,
      mtime: getModifiedTime(f.path as string)
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return {
    files,
    skippedCandidates: candidates.filter((candidate) => !candidate.include && candidate.report)
  };
}

/**
 * analyzeOrder: Comprehensive analysis of a single bot's order grid
 *
 * Examines all aspects of grid health:
 * - Spread: Gap between best buy and best sell vs. target
 * - Increment: Consistency of price steps between grid slots
 * - Funds: Total funds allocated to each side
 * - Distribution: Comparison of slot count vs. fund allocation
 * - Double-sided mode: Whether sides are intentionally unbalanced
 *
 * Terminology:
 * - boundaryIdx: Index of best buy slot (highest buy price)
 * - Slots > boundaryIdx are sells
 * - Slots < boundaryIdx are buys at boundary position
 * - Spread slots are outside normal grid (rare)
 *
 * @param {Object} botData - Order data with grid array and metadata
 * @param {Object} config - Bot configuration (optional) for comparison
 * @param {string} [botKey] - Bot key used to locate the dynamic grid snapshot
 * @returns {Object} Analysis result with spread, increment, funds, distribution
 */
function analyzeOrder(botData: GridSnapshot, config: BotConfig, botKey: string): JsonObj {
  const meta: JsonObj = botData.meta || {};
  const grid: GridSlot[] = Array.isArray(botData.grid) ? botData.grid : [];

  // Extract asset pair: prioritize assets object from order data, fall back to meta
  let assetA = meta.assetA;
  let assetB = meta.assetB;

  // If metadata is null/missing, get from assets object in order file
  if (!assetA && botData.assets && botData.assets.assetA) {
    assetA = botData.assets.assetA.symbol;
  }
  if (!assetB && botData.assets && botData.assets.assetB) {
    assetB = botData.assets.assetB.symbol;
  }

  /**
   * Grid Slot Separation
   * The grid contains buy slots (prices below market), sell slots (above market),
   * and optional spread slots. Separation enables independent analysis.
   */
  // A persisted boundary can be absent: GRID-LOAD erases a poisoned boundary
  // (clearPersistedBoundary) and keeps running boundary-less until fills
  // re-anchor. Index-based rail slicing then degenerates (null coerces to 0),
  // hiding live rail orders. Detect it and classify by slot type so every live
  // order stays visible in the report.
  const hasBoundary = typeof botData.boundaryIdx === 'number' && Number.isFinite(botData.boundaryIdx);
  const boundaryIdx = hasBoundary ? (botData.boundaryIdx as number) : 0;
  const boundaryLess = !hasBoundary;
  const buySlots = boundaryLess
    ? grid.filter((s) => s.type === ORDER_TYPES.BUY)
    : grid.filter((s, i) => i <= boundaryIdx && s.type === ORDER_TYPES.BUY);
  const sellSlots = boundaryLess
    ? grid.filter((s) => s.type === ORDER_TYPES.SELL)
    : grid.filter((s, i) => i > boundaryIdx && s.type === ORDER_TYPES.SELL);
  const spreadSlots = grid.filter((s) => s.type === ORDER_TYPES.SPREAD);

  const activeBuySlots = buySlots.filter((s) => s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL);
  const virtualBuySlots = buySlots.filter((s) => s.state === ORDER_STATES.VIRTUAL);
  const activeSellSlots = sellSlots.filter((s) => s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL);
  const virtualSellSlots = sellSlots.filter((s) => s.state === ORDER_STATES.VIRTUAL);

  /**
   * Best Prices Identification
   * bestBuySlot: Highest buy price (at boundary, closest to market)
   * bestSellSlot: Lowest sell price (first sell after boundary, closest to market)
   * The spread between these is the "real" spread of the grid
   */
  // Best prices come from the ACTUALLY PLACED orders (orderId present), not
  // merely the slot geometry. A sized virtual slot that lost its orderId (e.g.
  // after a boundary shift / divergence reconciliation) would otherwise be
  // reported as the spread edge, masking a real on-chain gap and showing a
  // false (too-tight) spread. Fall back to geometry only when no placed order
  // exists on a side (e.g. dry-run or pre-placement grids).
  //
  // NOTE (mixed-fallback): the two edges are chosen independently. If only one
  // side has a placed order, the spread mixes a real on-chain edge with a
  // geometry edge — it will read artificially tight. This is accepted by
  // design (a partially-placed grid IS partially masked); it is not a bug, but
  // the output should be read with that caveat in mind.
  const hasOrderId = (s: GridSlot) => !!(s && s.orderId);
  const railBuys = boundaryLess ? grid.filter((s) => s.type === ORDER_TYPES.BUY) : grid.slice(0, boundaryIdx + 1);
  const railSells = boundaryLess ? grid.filter((s) => s.type === ORDER_TYPES.SELL) : grid.slice(boundaryIdx + 1);
  const placedBuys = railBuys.filter((s) => s.type === ORDER_TYPES.BUY && hasOrderId(s));
  const placedSells = railSells.filter((s) => s.type === ORDER_TYPES.SELL && hasOrderId(s));
  const geoBuy = railBuys.filter((s) => s.type === ORDER_TYPES.BUY);
  const geoSell = railSells.filter((s) => s.type === ORDER_TYPES.SELL);
  const bestBuySlot = placedBuys.length
    ? placedBuys.reduce((a, b) => (b.price > a.price ? b : a))
    : (geoBuy.length ? geoBuy.reduce((a, b) => (b.price > a.price ? b : a)) : (boundaryLess ? null : (grid[boundaryIdx] || null)));
  const bestSellSlot = placedSells.length
    ? placedSells.reduce((a, b) => (b.price < a.price ? b : a))
    : (geoSell.length ? geoSell.reduce((a, b) => (b.price < a.price ? b : a)) : null);

  /**
   * Real Spread Calculation
   * Formula: (bestSellPrice - bestBuyPrice) / bestBuyPrice
   * This is the actual gap in the market, measured as percentage from buy price
   * Example: buy=100, sell=105 -> spread = 5%
   */
  const realSpread = bestBuySlot && bestSellSlot
    ? ((bestSellSlot.price - bestBuySlot.price) / bestBuySlot.price)
    : 0;

  let spreadDiff, targetSpread, incrementCheck;

  /**
   * Config-based Comparisons
   * If bot has configuration, compare actual to target values
   * Otherwise, just report actual values
   */
  if (config) {
    // Config exists - calculate variance from target
    targetSpread = Number(config.targetSpreadPercent) / 100;

    spreadDiff = realSpread - targetSpread;
    incrementCheck = checkGeometricIncrement(grid, Number(config.incrementPercent) / 100);
  } else {
    // No config - report actual values only
    targetSpread = null;
    spreadDiff = null;
    incrementCheck = checkGeometricIncrement(grid, null);
  }

  // Calculate total funds committed to buy and sell sides
  const gridFunds = calculateGridFunds(buySlots, sellSlots, bestBuySlot, bestSellSlot);
  const activeGridFunds = calculateGridFunds(activeBuySlots, activeSellSlots, bestBuySlot, bestSellSlot);
  const virtualGridFunds = calculateGridFunds(virtualBuySlots, virtualSellSlots, bestBuySlot, bestSellSlot);

  // Analyze how funds are distributed across slots
  const distribution = analyzeDistribution(buySlots, sellSlots, bestBuySlot, bestSellSlot);

  // Calculate grid extremes and market price
  const gridMinPrice = grid.length > 0 ? Math.min(...grid.map((s) => s.price)) : null;
  const gridMaxPrice = grid.length > 0 ? Math.max(...grid.map((s) => s.price)) : null;
  const marketPrice = bestBuySlot && bestSellSlot
    ? (bestBuySlot.price + bestSellSlot.price) / 2
    : null;

  /**
   * Return comprehensive analysis object
   * Includes all metrics needed for health check output
   */
  const _dynamicWeight = buildDynamicWeightInfo(botKey, config);
  const _ab = computeGridRangeScalingDisplay(config, _dynamicWeight);
  let gridPriceValue: unknown = null;
  let gridPriceLabel: unknown = null;
  let gridPriceStale = false;
  const _amaKey = resolveAmaKey(config);
  if (_amaKey && _dynamicWeight?.amaCenterPrice != null) {
    gridPriceLabel = _amaKey;
    gridPriceValue = _dynamicWeight.amaCenterPrice;
    gridPriceStale = _dynamicWeight.isRecent === false;
  } else if (typeof config?.gridPrice === 'number' && Number.isFinite(config.gridPrice) && config.gridPrice > 0) {
    gridPriceLabel = 'Grid';
    gridPriceValue = config.gridPrice;
  }
  return {
    pair: `${assetA}/${assetB}`,
    botName: config?.name || botKey,
    lastUpdated: new Date(String(meta.updatedAt || botData.lastUpdated)),
    gridMinPrice: gridMinPrice,
    marketPrice: marketPrice,
    gridMaxPrice: gridMaxPrice,
    hasConfig: !!config,
    // Spread metrics
    spread: {
      real: realSpread,
      target: targetSpread,
      diff: spreadDiff,
      // Pass if within 0.1% of target (or null if no config to compare)
      pass: config ? Math.abs(spreadDiff ?? 0) < 0.001 : null
    },
    // Increment consistency metrics
    increment: incrementCheck,
    // Fund allocation breakdown
    funds: gridFunds,
    activeFunds: activeGridFunds,
    virtualFunds: virtualGridFunds,
    // Slot vs fund distribution analysis
    distribution: distribution,
    // True when the snapshot carries no boundary (poisoned-boundary erasure):
    // slot rows are classified by slot type, not rail geometry.
    boundaryLess: boundaryLess,
    // Slot counts for structure overview
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      spread: spreadSlots.length,
      activeBuy: activeBuySlots.length,
      virtualBuy: virtualBuySlots.length,
      activeSell: activeSellSlots.length,
      virtualSell: virtualSellSlots.length,
      partialBuy: buySlots.filter((s) => s.state === ORDER_STATES.PARTIAL).length,
      partialSell: sellSlots.filter((s) => s.state === ORDER_STATES.PARTIAL).length
    },
    // Slot data for weight visualization
    slotData: {
      buy: buySlots,
      sell: sellSlots
    },
    // Target active orders from config
    coreOrdersTarget: config ? config.coreOrders : null,
    // Bot fund allocation settings from config (normalized to strings for
    // the display paths; bots.json allows percentage strings or numbers)
    botFunds: config && config.botFunds
      ? { buy: formatBotFunds(config.botFunds.buy), sell: formatBotFunds(config.botFunds.sell) }
      : null,
    // Weight distribution from config
    weightDistribution: config ? config.weightDistribution : null,
    // Resolved grid price label, value, and staleness flag
    // (null label/value when gridPrice is pool/book/null)
    gridPriceLabel,
    gridPriceValue,
    gridPriceStale,
    // Latest dynamic weight payload from the market adapter (AMA bots only).
    // Null when the bot is not AMA, or when no fresh snapshot is available.
    dynamicWeight: _dynamicWeight,
    // Grid range scaling (asymmetric bounds) display data, null if not applicable.
    asymmetricBounds: _ab,
  };
}

/**
 * computeGridRangeScalingDisplay: Compute resolved prices from grid range scaling.
 * Returns null when the bot is not whitelisted or data is incomplete.
 */
function computeGridRangeScalingDisplay(config: BotConfig, dynamicWeight: DynamicWeightInfo | null): JsonObj | null {
  if (!dynamicWeight || dynamicWeight.amaCenterPrice == null) {
    return null;
  }
  const centerPrice = Number(dynamicWeight.amaCenterPrice);
  let minPrice, maxPrice;
  try {
    minPrice = resolveConfiguredPriceBound((config && config.minPrice) as string | number | null | undefined, undefined, centerPrice, 'min');
    maxPrice = resolveConfiguredPriceBound((config && config.maxPrice) as string | number | null | undefined, undefined, centerPrice, 'max');
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return null;

  const hasAsym = Number.isFinite(dynamicWeight.appliedAsymmetryFactor)
    && (dynamicWeight.trend === 'UP' || dynamicWeight.trend === 'DOWN');

  let resolvedMinPrice = minPrice;
  let resolvedMaxPrice = maxPrice;
  if (hasAsym) {
    const prices = computeAsymmetricBoundsPrices(
      centerPrice, minPrice as number, maxPrice as number,
      dynamicWeight.trend as string, Number(dynamicWeight.appliedAsymmetryFactor)
    );
    if (prices) {
      resolvedMinPrice = prices.resolvedMinPrice;
      resolvedMaxPrice = prices.resolvedMaxPrice;
    }
  }

  const trend = hasAsym ? dynamicWeight.trend : null;
  return {
    resolvedMinPrice,
    resolvedMaxPrice,
    configuredMinPrice: minPrice,
    configuredMaxPrice: maxPrice,
    appliedAsymmetryFactor: hasAsym ? dynamicWeight.appliedAsymmetryFactor : 0,
    rawAsymmetryFactor: hasAsym ? dynamicWeight.rawAsymmetryFactor : 0,
    trend,
    isRecent: dynamicWeight.isRecent,
  };
}

/**
 * checkGeometricIncrement: Verify grid uses consistent geometric price progression
 *
 * A proper grid should have constant percentage increments between slots.
 * This function checks if increments are consistent (low standard deviation).
 *
 * Geometric increment formula:
 * increment = (nextPrice - currentPrice) / currentPrice
 * This is a percentage change from one slot to the next.
 *
 * Example with 2% increment:
 * - Slot 1: 100
 * - Slot 2: 102 (increment = 0.02 or 2%)
 * - Slot 3: 104.04 (increment = 0.02 or 2%)
 *
 * Metrics:
 * - avg: Average increment across all slots
 * - stdDev: Standard deviation (should be < 0.1% for good grids)
 * - pass: True if avg matches target and is consistent (for grids with config)
 *
 * @param {Array} grid - All grid slots
 * @param {number} targetIncrement - Target increment ratio (e.g., 0.02 for 2%)
 * @returns {Object} Increment analysis with avg, target, stdDev, consistency
 */
function checkGeometricIncrement(grid: GridSlot[], targetIncrement: number | null): JsonObj {
  // Filter out spread slots (only analyze regular buy/sell slots)
  const slots = grid.filter((s) => s.type !== 'spread');

  // Need at least 2 slots to calculate increment
  if (slots.length < 2) {
    return { pass: null, avgIncrement: 0, consistent: true, target: targetIncrement };
  }

  /**
   * Calculate increment for each consecutive pair of slots
   * Increment = percentage change from previous to current price
   */
  const increments: number[] = [];
  for (let i = 1; i < slots.length; i++) {
    const prevPrice = slots[i - 1].price;
    const currPrice = slots[i].price;
    // Relative price change as decimal (0.02 = 2%)
    const increment = (currPrice - prevPrice) / prevPrice;
    increments.push(increment);
  }

  /**
   * Statistical Analysis
   * Average: Mean of all increments
   * Standard deviation: Measure of variability (lower = more consistent)
   */
  const avgIncrement = increments.reduce((a, b) => a + b) / increments.length;

  // Calculate standard deviation (measure of consistency)
  const stdDev = Math.sqrt(
    increments.reduce((sum, inc) => sum + Math.pow(inc - avgIncrement, 2), 0) / increments.length
  );

  return {
    avg: avgIncrement,                    // Actual average increment
    target: targetIncrement,              // Expected increment from config
    // Difference from target (null if no config)
    diff: targetIncrement ? avgIncrement - targetIncrement : null,
    stdDev: stdDev,                       // Consistency metric
    // Grid is "consistent" if std dev < 0.1%
    consistent: stdDev < 0.001,
    // Pass if matches target AND is consistent (null if no config)
    pass: targetIncrement ? (Math.abs(avgIncrement - targetIncrement) < 0.0001 && stdDev < 0.001) : null
  };
}

/**
 * calculateGridFunds: Calculate total funds in buy and sell sides
 *
 * Currency Note:
 * - Buy slot sizes: Measured in AssetB (quote currency, e.g., BTS)
 *   Each buy slot uses quote currency to purchase base currency
 * - Sell slot sizes: Measured in AssetA (base currency, e.g., XRP)
 *   Each sell slot holds base currency ready to sell
 *
 * Conversion logic:
 * - BTS fund in buy side represents potential XRP purchase: totalBTS / marketPrice
 * - XRP fund in sell side converts to BTS equivalent: totalXRP * marketPrice
 * - Uses market price (midpoint between best buy and best sell) for accurate valuation
 *
 * @param {Array} buySlots - Buy order slots
 * @param {Array} sellSlots - Sell order slots
 * @param {Object} bestBuySlot - Best (highest) buy price slot
 * @param {Object} bestSellSlot - Best (lowest) sell price slot
 * @returns {Object} Fund breakdown {buy: {bts, xrp}, sell: {xrp, bts}}
 */
function calculateGridFunds(buySlots: GridSlot[], sellSlots: GridSlot[], bestBuySlot: GridSlot | null, bestSellSlot: GridSlot | null): JsonObj {
  /**
   * Direct Fund Aggregation
   * Sum all slot sizes on each side
   * Buy slots: Total BTS committed
   * Sell slots: Total XRP (or base currency) available
   */
  const totalBTS = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalXRP = sellSlots.reduce((sum, s) => sum + s.size, 0);

  /**
   * Market Price Calculation
   * Use the midpoint between best buy and best sell prices
   * This represents the fair market price for fund valuation
   */
  const marketPrice = bestBuySlot && bestSellSlot
    ? (bestBuySlot.price + bestSellSlot.price) / 2
    : 1;

  // How much XRP the buy-side BTS could purchase (at market price)
  const totalXRPFromBuy = totalBTS / marketPrice;
  // How much BTS the sell-side XRP could generate (at market price)
  const totalBTSFromSell = totalXRP * marketPrice;

  return {
    // Buy side: funds dedicated to purchasing base currency
    buy: {
      bts: totalBTS,            // Direct BTS allocation
      xrp: totalXRPFromBuy      // Equivalent XRP buying power
    },
    // Sell side: funds available to sell base currency
    sell: {
      xrp: totalXRP,            // Direct XRP holdings
      bts: totalBTSFromSell     // Equivalent BTS revenue potential
    }
  };
}

/**
 * getDeltaColor: Return color code based on delta percentage value
 * Under 10%: green, 10-20%: yellow, over 20%: red
 * @param {number} deltaValue - The delta percentage value
 * @returns {string} Color code
 */
/**
 * createDistributionBar: Create a horizontal bar chart showing BUY/SELL/spread distribution
 * Differentiates between active (dark) and virtual (light) slots
 * @param {Object} counts - Object containing activeBuy, virtualBuy, activeSell, virtualSell, spread
 * @returns {{bar: string, buyWidth: number}} Colored bar visualization
 */
function createDistributionBar(counts: DistributionCounts): { bar: string; buyWidth: number } {
  const barWidth = BAR_WIDTH; // total width in characters
  const total = counts.activeBuy + counts.virtualBuy + counts.spread + counts.activeSell + counts.virtualSell;

  if (total === 0) return { bar: ' '.repeat(barWidth), buyWidth: 0 };

  // Calculate widths proportionally
  let activeBuyWidth = Math.round((counts.activeBuy / total) * barWidth);
  let virtualBuyWidth = Math.round((counts.virtualBuy / total) * barWidth);
  let spreadWidth = Math.round((counts.spread / total) * barWidth);
  let activeSellWidth = Math.round((counts.activeSell / total) * barWidth);
  let virtualSellWidth = Math.round((counts.virtualSell / total) * barWidth);

  // Ensure spread is visible if it exists
  if (counts.spread > 0 && spreadWidth === 0) {
    spreadWidth = 1;
    // Borrow from largest other section
    const widths = [
      { name: 'activeBuy', val: activeBuyWidth },
      { name: 'virtualBuy', val: virtualBuyWidth },
      { name: 'activeSell', val: activeSellWidth },
      { name: 'virtualSell', val: virtualSellWidth }
    ].sort((a, b) => b.val - a.val);
    if (widths[0].val > 0) {
      if (widths[0].name === 'activeBuy') activeBuyWidth--;
      else if (widths[0].name === 'virtualBuy') virtualBuyWidth--;
      else if (widths[0].name === 'activeSell') activeSellWidth--;
      else if (widths[0].name === 'virtualSell') virtualSellWidth--;
    }
  }

  // Adjust to ensure total is exactly barWidth
  const sum = activeBuyWidth + virtualBuyWidth + spreadWidth + activeSellWidth + virtualSellWidth;
  if (sum !== barWidth) {
    let diff = barWidth - sum;
    const sections = [
      { name: 'activeBuyWidth', get: () => activeBuyWidth, set: (v: number) => { activeBuyWidth = v; } },
      { name: 'virtualBuyWidth', get: () => virtualBuyWidth, set: (v: number) => { virtualBuyWidth = v; } },
      { name: 'spreadWidth', get: () => spreadWidth, set: (v: number) => { spreadWidth = v; } },
      { name: 'activeSellWidth', get: () => activeSellWidth, set: (v: number) => { activeSellWidth = v; } },
      { name: 'virtualSellWidth', get: () => virtualSellWidth, set: (v: number) => { virtualSellWidth = v; } }
    ];

    while (diff > 0) {
      const target = sections
        .slice()
        .sort((a, b) => b.get() - a.get())[0];
      target.set(target.get() + 1);
      diff--;
    }

    while (diff < 0) {
      const target = sections
        .filter((section) => section.get() > 0)
        .sort((a, b) => b.get() - a.get())[0];
      if (!target) break;
      target.set(target.get() - 1);
      diff++;
    }
  }

  const buyBar = colors.buy + '█'.repeat(virtualBuyWidth) + colors.buyDark + '█'.repeat(activeBuyWidth) + colors.reset;
  const spreadBar = colors.white + '█'.repeat(spreadWidth) + colors.reset; // white
  const sellBar = colors.sellDark + '█'.repeat(activeSellWidth) + colors.sell + '█'.repeat(virtualSellWidth) + colors.reset;

  return { bar: `${buyBar}${spreadBar}${sellBar}`, buyWidth: activeBuyWidth + virtualBuyWidth };
}

/**
 * createWeightFactorBar: Visualize capital distribution using actual order sizes
 *
 * Shows how capital is distributed across BUY and SELL orders using arithmetic averages.
 * Buy funds measured in quote currency, sell funds in base currency - converts to common basis.
 * Each side scales independently: highest order on each side = 100% (█)
 * Character width is proportional to fund amount on each side (not 50/50 split).
 * Full block (█) = maximum average capital on that side
 * Partial blocks (▁-▇) = progressively lower average capital
 *
 * @param {Array} buyOrders - Buy orders with size property (in quote currency)
 * @param {Array} sellOrders - Sell orders with size property (in base currency)
 * @param {number} barWidth - Target width in characters (default: BAR_WIDTH=51)
 * @param {number} marketPrice - Market price for currency conversion (sell to quote basis)
 * @returns {string} Colored weight visualization with independent scaling
 */
function createWeightFactorBar(buyOrders: GridSlot[], sellOrders: GridSlot[], barWidth: number = BAR_WIDTH, marketPrice: number = 1): string {
  if ((!buyOrders || buyOrders.length === 0) && (!sellOrders || sellOrders.length === 0)) {
    return '(no orders)';
  }

  // Calculate total fund weight on each side using arithmetic sum
  const buyTotalSize = (buyOrders || []).reduce((sum, o) => sum + (o.size || 0), 0);
  const sellTotalSize = (sellOrders || []).reduce((sum, o) => sum + (o.size || 0), 0);

  // Convert sell side to quote currency equivalent for accurate ratio calculation
  // Buy side is in quote currency, sell side is in base currency
  // Using market price to convert: sell_base * market_price = sell_quote_equivalent
  const sellTotalInQuote = sellTotalSize * marketPrice;
  const totalFunds = buyTotalSize + sellTotalInQuote;

  // Allocate widths proportionally based on fund ratios (in common currency basis)
  // This ensures character length reflects the actual fund distribution
  let buyWidth, sellWidth;
  if (totalFunds > 0) {
    buyWidth = Math.round((buyTotalSize / totalFunds) * barWidth);
    sellWidth = barWidth - buyWidth;
  } else {
    // Fallback to 50/50 if no funds
    buyWidth = Math.floor(barWidth / 2);
    sellWidth = barWidth - buyWidth;
  }

  // Create buy side with independent scaling (max on buy side = 100%)
  const buyBar = createWeightSide(buyOrders, colors.buyDark, colors.buy, buyWidth);

  // Create sell side with independent scaling (max on sell side = 100%)
  const sellBar = createWeightSide(sellOrders, colors.sellDark, colors.sell, sellWidth);

  return `${buyBar}${sellBar}`;
}

/**
 * Helper: Create weight visualization for one side with independent scaling
 * Distributes orders evenly across bar width, ensuring all bars are filled
 * @param {Array} orders - Orders on this side
 * @param {string} activeColor - Color for active orders
 * @param {string} virtualColor - Color for virtual orders
 * @param {number} sideWidth - Width allocated to this side
 */
function createWeightSide(orders: GridSlot[], activeColor: string, virtualColor: string, sideWidth: number): string {
  if (!orders || orders.length === 0 || sideWidth === 0) {
    return virtualColor + ' '.repeat(sideWidth) + colors.reset;
  }

  // Get sizes and find max for THIS SIDE only (independent scaling)
  const sizes = orders.map((o) => o.size || 0);
  const maxSize = Math.max(...sizes);

  if (maxSize === 0) {
    return virtualColor + '░'.repeat(sideWidth) + colors.reset;
  }

  const compressedWeights: string[] = [];

  // Distribute orders evenly across all bar positions
  // Each bar maps to a position in the orders array
  for (let barIdx = 0; barIdx < sideWidth; barIdx++) {
    // Map bar position to order range
    // This ensures even distribution even if orders < sideWidth
    const startPos = (barIdx * orders.length) / sideWidth;
    const endPos = ((barIdx + 1) * orders.length) / sideWidth;

    // Get all orders that fall within this bar's range
    const startIdx = Math.floor(startPos);
    const endIdx = Math.ceil(endPos);
    const groupOrders = orders.slice(startIdx, endIdx);

    if (groupOrders.length === 0) {
      // Fallback: if no orders in range, find nearest order
      const nearestIdx = Math.round(startPos);
      groupOrders.push(orders[Math.min(nearestIdx, orders.length - 1)]);
    }

    const groupSizes = groupOrders.map((o) => o.size || 0);
    // Calculate arithmetic average of sizes in this group
    const avgSize = groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length;

    // Normalize to max on THIS SIDE (1-8, minimum 1 for visibility)
    const ratio = avgSize / maxSize;
    const blockHeight = Math.max(1, Math.round(ratio * 8));

    // ACTIVE and PARTIAL slots are both real on-chain orders in this analysis.
    const hasLiveOrder = groupOrders.some((o) => o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL);
    const color = hasLiveOrder ? activeColor : virtualColor;

    compressedWeights.push(color + partialBlocks[blockHeight] + colors.reset);
  }

  return compressedWeights.join('');
}

/**
 * analyzeDistribution: Compare slot distribution vs fund distribution
 *
 * Identifies imbalances between:
 * - Slot distribution: How many buy vs sell slots exist
 * - Fund distribution: How much funds are allocated to buy vs sell
 *
 * These should ideally match:
 * - If 50% slots are buy, ~50% of funds should be on buy side
 * - Deviation suggests intentional weighting or uneven fees
 *
 * Example:
 * - 100 total slots: 40 buy + 60 sell = 40% buy slots
 * - Funds: 6000 BTS buy + 4000 BTS sell equivalent = 60% buy funds
 * - Delta buy: |40% - 60%| = 20% (funds weight more toward buy)
 *
 * @param {Array} buySlots - Buy order slots
 * @param {Array} sellSlots - Sell order slots
 * @param {Object} bestBuySlot - Best buy price (used for market price calculation)
 * @param {Object} bestSellSlot - Best sell price (used for market price calculation)
 * @returns {Object} Distribution analysis with slot%, fund%, and deltas
 */
function analyzeDistribution(buySlots: GridSlot[], sellSlots: GridSlot[], bestBuySlot: GridSlot | null, bestSellSlot: GridSlot | null): JsonObj {
  /**
   * Slot Distribution
   * Simple count: what percentage of total slots are buy vs sell
   */
  const totalSlots = buySlots.length + sellSlots.length;
  const buySlotPercent = totalSlots > 0 ? (buySlots.length / totalSlots) * 100 : 0;
  const sellSlotPercent = totalSlots > 0 ? (sellSlots.length / totalSlots) * 100 : 0;

  /**
   * Fund Distribution
   * Calculate total funds on each side, convert to common currency basis
   * This shows if sides have equal capital or if one is prioritized
   */
  const totalBuyFunds = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalSellFunds = sellSlots.reduce((sum, s) => sum + s.size, 0);

  /**
   * Currency Conversion for Comparison
   * Buy side funds: Measured in AssetB (quote)
   * Sell side funds: Measured in AssetA (base)
   * Convert both to common basis using market price (midpoint between best buy/sell)
   */
  const marketPrice = bestBuySlot && bestSellSlot
    ? (bestBuySlot.price + bestSellSlot.price) / 2
    : 1;

  // Convert sell-side funds (XRP) to quote currency equivalent (BTS)
  // This allows apples-to-apples fund comparison using market price
  const sellFundsInBTS = totalSellFunds * marketPrice;
  const totalFunds = totalBuyFunds + sellFundsInBTS;

  /**
   * Fund Percentage
   * What % of total funds are allocated to buy vs sell
   */
  const buyFundPercent = totalFunds > 0 ? (totalBuyFunds / totalFunds) * 100 : 0;
  const sellFundPercent = totalFunds > 0 ? (sellFundsInBTS / totalFunds) * 100 : 0;

  return {
    // Slot-level breakdown
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      buyPercent: buySlotPercent,
      sellPercent: sellSlotPercent
    },
    // Fund-level breakdown (in common currency)
    funds: {
      buyPercent: buyFundPercent,
      sellPercent: sellFundPercent
    },
    // Delta: difference between slot% and fund% (shows imbalance)
    // If match is 0, slots and funds are perfectly balanced
    // If match is high, one side is over/under-weighted in funds
    match: {
      buyDiff: buyFundPercent - buySlotPercent,
      sellDiff: sellFundPercent - sellSlotPercent
    }
  };
}

/**
 * getRawWeightValues: Extract raw buy/sell value strings for column alignment,
 * without any color codes or formatting artifacts.
 *
 * Mirrors the display-mode logic of formatWeightLine but returns plain strings.
 *
 * @param {Object|null} weightDistribution
 * @param {Object|null} dynamicWeight
 * @returns {{ buy: string, sell: string } | null}
 */
function getRawWeightValues(weightDistribution: JsonObj | null, dynamicWeight: DynamicWeightInfo | null): { buy: string; sell: string } | null {
  if (!weightDistribution) return null;
  const staticBuy = Number(weightDistribution.buy);
  const staticSell = Number(weightDistribution.sell);
  if (!Number.isFinite(staticBuy) || !Number.isFinite(staticSell)) return null;

  if (dynamicWeight && dynamicWeight.isRecent === false) {
    return { buy: staticBuy.toFixed(2), sell: staticSell.toFixed(2) };
  }

  const useLive = !!(dynamicWeight
    && dynamicWeight.isRecent
    && dynamicWeight.live
    && Number.isFinite(Number(dynamicWeight.live?.buy))
    && Number.isFinite(Number(dynamicWeight.live?.sell)));

  if (!useLive) {
    return { buy: staticBuy.toFixed(2), sell: staticSell.toFixed(2) };
  }

  const liveBuy = Number(dynamicWeight.live?.buy);
  const liveSell = Number(dynamicWeight.live?.sell);
  return {
    buy: liveBuy.toFixed(2),
    sell: liveSell.toFixed(2)
  };
}

/**
 * formatWeightLine: Render the "Weight:" line, optionally with live dynamic values.
 *
 * Has three display modes:
 * 1. No dynamic snapshot at all (static-only) — e.g. legacy bots
 * 2. Stale snapshot — static values grayed only when dynamic weights are enabled
 * 3. Live snapshot — live values colored by delta
 *
 * When maxBuyWidth/maxSellWidth are provided, the value portion in each column
 * is right-padded so it aligns with the widest value across the Active/Weight/Funds block.
 *
 * @param {Object|null} weightDistribution - Static weight config from bots.json
 * @param {Object|null} dynamicWeight - Live weight snapshot from dynamic grid
 * @param {number} [maxBuyWidth] - Target width for buy-side values (for column alignment)
 * @param {number} [maxSellWidth] - Target width for sell-side values (for column alignment)
 * @returns {string|null} Formatted weight line or null if no valid data
 */
function formatWeightLine(weightDistribution: JsonObj | null, dynamicWeight: DynamicWeightInfo | null, maxBuyWidth?: number, maxSellWidth?: number): string | null {
  if (!weightDistribution) return null;
  const staticBuy = Number(weightDistribution.buy);
  const staticSell = Number(weightDistribution.sell);
  if (!Number.isFinite(staticBuy) || !Number.isFinite(staticSell)) return null;

  // Stale snapshot: snapshot file exists but updatedAt is older than the
  // freshness window. Surface a red "(adapter offline)" alert so the operator
  // knows the live envelope is being withheld, not just absent.
  if (dynamicWeight && dynamicWeight.isRecent === false) {
    const buyVal = staticBuy.toFixed(2);
    const sellVal = staticSell.toFixed(2);
    const alertStr = `${colors.sell}(adapter offline)${colors.reset}`;
    const valueColor = dynamicWeight.dynamicWeightEnabled === true ? colors.gray : '';
    const valueReset = valueColor ? colors.reset : '';
    return `   Weight: ${valueColor}${maxBuyWidth ? buyVal.padEnd(maxBuyWidth) : buyVal}${valueReset} ${colors.buy}buy${colors.reset} | ${valueColor}${maxSellWidth ? sellVal.padEnd(maxSellWidth) : sellVal}${valueReset} ${colors.sell}sell${colors.reset} ${alertStr}`;
  }

  const useLive = !!(dynamicWeight
    && dynamicWeight.isRecent
    && dynamicWeight.live
    && Number.isFinite(Number(dynamicWeight.live?.buy))
    && Number.isFinite(Number(dynamicWeight.live?.sell)));

  if (!useLive) {
    const buyVal = staticBuy.toFixed(2);
    const sellVal = staticSell.toFixed(2);
    return `   Weight: ${maxBuyWidth ? buyVal.padEnd(maxBuyWidth) : buyVal} ${colors.buy}buy${colors.reset} | ${maxSellWidth ? sellVal.padEnd(maxSellWidth) : sellVal} ${colors.sell}sell${colors.reset}`;
  }

  const liveBuy = Number(dynamicWeight.live?.buy);
  const liveSell = Number(dynamicWeight.live?.sell);
  // Compare the two live weights, not their deltas: the side with the larger
  // live weight is the one the bot is leaning on most heavily (the "losing"
  // side for that asset). When the two live weights are equal, no side is
  // being favored, so both fall back to white (default terminal color).
  const liveDelta = liveBuy - liveSell;
  let buyColor;
  let sellColor;
  if (Math.abs(liveDelta) <= DYNAMIC_WEIGHT_EPSILON) {
    buyColor = '';
    sellColor = '';
  } else if (liveDelta > 0) {
    // Buy is higher -> losing side (red); sell is lower -> winning side (green)
    buyColor = colors.sell;
    sellColor = colors.buy;
  } else {
    // Buy is lower -> winning side (green); sell is higher -> losing side (red)
    buyColor = colors.buy;
    sellColor = colors.sell;
  }

  const liveBuyStr = `${buyColor}${liveBuy.toFixed(2)}${colors.reset}`;
  const liveSellStr = `${sellColor}${liveSell.toFixed(2)}${colors.reset}`;
  const buyValVisual = liveBuy.toFixed(2);
  const sellValVisual = liveSell.toFixed(2);
  const coloredBuyVal = liveBuyStr;
  const coloredSellVal = liveSellStr;
  const paddedBuyVal = maxBuyWidth ? coloredBuyVal + ' '.repeat(Math.max(0, maxBuyWidth - buyValVisual.length)) : coloredBuyVal;
  const paddedSellVal = maxSellWidth ? coloredSellVal + ' '.repeat(Math.max(0, maxSellWidth - sellValVisual.length)) : coloredSellVal;

  return `   Weight: ${paddedBuyVal} ${colors.buy}buy${colors.reset} | ${paddedSellVal} ${colors.sell}sell${colors.reset}`;
}

/**
 * formatAnalysis: Format analysis results into readable console output
 *
 * Creates a compact, emoji-enriched display of all analysis metrics.
 * Each line is designed to fit in typical terminal width.
 *
 * Output layout:
 * 📊 PAIR
 *    Updated: [timestamp]
 *    [warnings if applicable]
 *    Spread: [status] [real]% (target: [target]%) [direction][delta]
 *    Increment: [status] [avg]% (target: [target]%) [direction][delta] σ=[stddev]
 *    Slots: [buy] buy + [spread] spread + [sell] sell
 *    Grid: BUY [amount] QUOTE ≈ [amount] BASE
 *           SELL [amount] BASE ≈ [amount] QUOTE
 *    Dist: BUY slots [%] vs funds [%] (Δ[diff]%) | SELL slots [%] vs funds [%] (Δ[diff]%)
 *
 * Symbols:
 * ✓ = passes threshold
 * ✗ = exceeds threshold (needs attention)
 * ↓ = value is lower than target
 * ↑ = value is higher than target
 * σ = standard deviation (consistency)
 * Δ = delta (difference)
 *
 * @param {Object} analysis - Analysis result object from analyzeOrder()
 * @returns {string} Formatted multi-line output ready for console.log
 */
function formatAnalysis(analysisInput: JsonObj): string {
  const analysis = analysisInput as unknown as AnalysisResult;
  const lines: string[] = [];

  // Header: Trading pair name
  lines.push(`\n${colors.cyan}📊 ${analysis.pair}${colors.reset} (${analysis.botName})`);
  lines.push(`   ${colors.gray}Update: ${analysis.lastUpdated.toLocaleString()}${colors.reset}`);
  // Boundary-less snapshot: say so out loud so geometry rows are read as
  // type-based counts, not rail positions.
  if (analysis.boundaryLess) {
    lines.push(`   ${colors.gray}⚠️  boundary-less mode - slot rows by slot type (no rail geometry)${colors.reset}`);
  }
  lines.push(``);

  // Warning: No config available for comparison
  if (!analysis.hasConfig) {
    lines.push(`   ${colors.gray}⚠️  No config found - showing grid data only${colors.reset}`);
  }

  /**
   * Spread Analysis
   * Shows: actual spread vs target spread
   * Status: ✓ if within 0.1% of target, ✗ if not
   * Direction: ↑ if above target, ↓ if below target
   */
  if (analysis.hasConfig) {
    lines.push(
      `   Spread:${formatPercent(analysis.spread.real).padStart(6)} (${formatPercent(Number(analysis.spread.target))}) | Incr.:${formatPercent(analysis.increment.avg).padStart(6)} (${formatPercent(Number(analysis.increment.target))})`
    );
  } else {
    lines.push(`   Spread:${formatPercent(analysis.spread.real).padStart(6)} | Incr.:${formatPercent(analysis.increment.avg).padStart(6)}`);
  }

  // Active orders comparison
  if (analysis.hasConfig && analysis.coreOrdersTarget) {
    const buyTarget = analysis.coreOrdersTarget.buy;
    const sellTarget = analysis.coreOrdersTarget.sell;
    const buyActual = analysis.slots.activeBuy;
    const sellActual = analysis.slots.activeSell;

    // Collect raw buy/sell values across Active, Weight, Funds for column alignment
    const rawWeightVals = getRawWeightValues(analysis.weightDistribution, analysis.dynamicWeight);
    const buyValues: string[] = [`${buyActual}/${buyTarget}`];
    const sellValues: string[] = [`${sellActual}/${sellTarget}`];
    if (rawWeightVals) {
      buyValues.push(rawWeightVals.buy);
      sellValues.push(rawWeightVals.sell);
    }
    if (analysis.botFunds) {
      buyValues.push(analysis.botFunds.buy);
      sellValues.push(analysis.botFunds.sell);
    }
    const maxBuyWidth = Math.max(...buyValues.map((v) => stripColorCodes(v).length));
    const maxSellWidth = Math.max(...sellValues.map((v) => stripColorCodes(v).length));

    lines.push(`   Active: ${(buyActual + '/' + buyTarget).padEnd(maxBuyWidth)} ${colors.buy}buy${colors.reset} | ${(sellActual + '/' + sellTarget).padEnd(maxSellWidth)} ${colors.sell}sell${colors.reset}`);
    lines.push(``);
    const weightLine = formatWeightLine(analysis.weightDistribution, analysis.dynamicWeight, maxBuyWidth, maxSellWidth);
    if (weightLine) {
      lines.push(weightLine);
    }
    if (analysis.botFunds) {
      lines.push(`    Funds: ${analysis.botFunds.buy.padEnd(maxBuyWidth)} ${colors.buy}buy${colors.reset} | ${analysis.botFunds.sell.padEnd(maxSellWidth)} ${colors.sell}sell${colors.reset}`);
    }
    if (analysis.gridPriceLabel && analysis.gridPriceValue != null) {
      lines.push(``);
      const rawPrice = Number(analysis.gridPriceValue);
      const priceStr = formatCurrency(rawPrice);

      const priceColor = analysis.gridPriceStale ? colors.gray : '';
      const priceReset = priceColor ? colors.reset : '';

      let diffStr = '';
      if (analysis.marketPrice != null && rawPrice !== 0) {
        const diff = (analysis.marketPrice - rawPrice) / rawPrice;
        const diffColor = diff > 0 ? colors.buy : diff < 0 ? colors.sell : '';
        const sign = diff > 0 ? '+' : '';
        diffStr = ` ${diffColor}(${sign}${(diff * 100).toFixed(1)}%)${colors.reset}`;
      }

      lines.push(`     ${analysis.gridPriceLabel}: ${priceColor}${priceStr}${priceReset}${diffStr}`);
    }
    if (analysis.asymmetricBounds) {
      const ab = analysis.asymmetricBounds;
      const minStr = formatCurrency(ab.resolvedMinPrice);
      const maxStr = formatCurrency(ab.resolvedMaxPrice);
      const asymSign = ab.trend === 'DOWN' ? '-' : '+';
      const pctStr = ab.appliedAsymmetryFactor !== 0
        ? ` (${asymSign}${(ab.appliedAsymmetryFactor * 100).toFixed(1)}%)`
        : '';
      lines.push(`   Bounds: ${colors.buy}${minStr}${colors.reset} - ${colors.sell}${maxStr}${colors.reset}${pctStr}`);
    }
    lines.push(``);
  }

  // Calculate bar positioning based on slot distribution
  const totalSlots = analysis.slots.buy + analysis.slots.sell + analysis.slots.spread;
  const buyBarWidth = totalSlots > 0 ? Math.floor((analysis.slots.buy / totalSlots) * BAR_WIDTH) : 0;
  const spreadBarWidth = analysis.slots.spread > 0 ? Math.max(1, Math.floor((analysis.slots.spread / totalSlots) * BAR_WIDTH)) : 0;
  const sellBarWidth = BAR_WIDTH - buyBarWidth - spreadBarWidth;

  // Create formatted labels for three-column layout
  const buyLabel = `${analysis.slots.buy} buy`;
  const spreadLabel = `${analysis.slots.spread} spread`;
  const sellLabel = `${analysis.slots.sell} sell`;

  // Price Range - formatted with three-column alignment
  const buyPrice = analysis.gridMinPrice ? `${colors.buy}${formatCurrency(analysis.gridMinPrice)}${colors.reset}` : 'N/A';
  const midPrice = analysis.marketPrice ? formatCurrency(analysis.marketPrice) : 'N/A';
  const sellPrice = analysis.gridMaxPrice ? `${colors.sell}${formatCurrency(analysis.gridMaxPrice)}${colors.reset}` : 'N/A';

  const pricePrefix = `    Price: `;
  const slotsPrefix = `    Slots: `;

  // Get visual lengths (without color codes)
  const buyPriceVisualLen = stripColorCodes(buyPrice).length;
  const midPriceVisualLen = stripColorCodes(midPrice).length;
  const sellPriceVisualLen = stripColorCodes(sellPrice).length;
  const buyLabelVisualLen = buyLabel.length;
  const spreadLabelVisualLen = spreadLabel.length;
  const sellLabelVisualLen = sellLabel.length;

  // Calculate positions where items should end to align with bar sections
  const barStart = 0;
  const buySection = barStart + buyBarWidth;
  const spreadSection = buySection + spreadBarWidth;
  const barEnd = spreadSection + sellBarWidth;

  // Position items right-aligned at section boundaries, with minimum 1 space gap
  // Buy item: right-align to buySection
  // Spread item: positioned to center in spread zone
  const spreadMid = buySection + spreadBarWidth / 2;
  const midPriceSpacing1 = Math.max(1, Math.round(spreadMid - midPriceVisualLen / 2) - buyPriceVisualLen);
  // Sell item: right-align to barEnd
  const sellPriceSpacing2 = Math.max(1, barEnd - sellPriceVisualLen - buyPriceVisualLen - midPriceVisualLen - midPriceSpacing1);

  lines.push(
    `${pricePrefix}${buyPrice}${' '.repeat(midPriceSpacing1)}${midPrice}${' '.repeat(Math.max(1, sellPriceSpacing2))}${sellPrice}`
  );

  // Same logic for slots line
  const spreadMidLabel = buySection + spreadBarWidth / 2;
  const spreadLabelSpacing1 = Math.max(1, Math.round(spreadMidLabel - spreadLabelVisualLen / 2) - buyLabelVisualLen);
  const sellLabelSpacing2 = Math.max(1, barEnd - sellLabelVisualLen - buyLabelVisualLen - spreadLabelVisualLen - spreadLabelSpacing1);

  lines.push(
    `${slotsPrefix}${colors.buy}${buyLabel}${colors.reset}${' '.repeat(spreadLabelSpacing1)}${spreadLabel}${' '.repeat(Math.max(1, sellLabelSpacing2))}${colors.sell}${sellLabel}${colors.reset}`
  );

  /**
   * Fund Allocation Breakdown
   * Shows funds in each currency (quote for buy, base for sell)
   * Also shows cross-currency equivalent for comparison
   * Example: BUY 1000 BTS ≈ 50 XRP (at avg buy price)
   */
  const [assetASymbol, assetBSymbol] = analysis.pair.split('/');

  // Fallback for null symbols (shouldn't happen after fix, but added for safety)
  const aSymbol = assetASymbol || 'BASE';
  const bSymbol = assetBSymbol || 'QUOTE';

  /**
   * Distribution Analysis
   * Compares slot count % with fund allocation %
   * Shows if one side is over/under-weighted relative to slot count
   * Δ (delta) = difference between slot % and fund %
   *   Δ 0% = perfectly balanced (slots match funds)
   *   Δ 20% = significant imbalance (e.g., 40% slots but 60% funds)
   */
  const { bar: slotDistBar, buyWidth: slotDistBuyWidth } = createDistributionBar({
    activeBuy: analysis.slots.activeBuy,
    virtualBuy: analysis.slots.virtualBuy,
    spread: analysis.slots.spread,
    activeSell: analysis.slots.activeSell,
    virtualSell: analysis.slots.virtualSell
  });

  // Weight factor visualization (funds distribution across all orders)
  const weightBar = createWeightFactorBar(
    analysis.slotData?.buy,
    analysis.slotData?.sell,
    BAR_WIDTH,
    analysis.marketPrice || 1
  );

  lines.push(
    `           ${slotDistBar}`
  );

  // Position delta indicator directly under the spread slot character
  const buyDiffVal = analysis.distribution.match.buyDiff;
  const signedMatch = (buyDiffVal > 0 ? '+' : '') + buyDiffVal.toFixed(1);
  const deltaStr = `Δ ${signedMatch}%`;
  const spreadStart = 11 + slotDistBuyWidth; // Position where spread character starts (11 = prefix length)
  lines.push(
    `${' '.repeat(spreadStart)}${deltaStr}`
  );

  lines.push(
    `    Funds: ${weightBar}`
  );

  // Funds breakdown: BUY on left, SELL on right (right-aligned within its column)
  const buyValueStr = `${formatFundsValue(analysis.funds.buy.bts)} ${bSymbol}`;
  const sellValueStr = `${formatFundsValue(analysis.funds.sell.xrp)} ${aSymbol}`;
  const buyEquivStr = `≈ ${formatFundsValue(analysis.funds.buy.xrp)} ${aSymbol}`;
  const sellEquivStr = `≈ ${formatFundsValue(analysis.funds.sell.bts)} ${bSymbol}`;

  // Right column width is the maximum of sell value or sell equivalent
  const rightColWidth = Math.max(sellValueStr.length, sellEquivStr.length);

  // Right-align both sell strings within the right column width
  const sellValueRight = ' '.repeat(Math.max(0, rightColWidth - sellValueStr.length)) + sellValueStr;
  const sellEquivRight = ' '.repeat(Math.max(0, rightColWidth - sellEquivStr.length)) + sellEquivStr;

  // Build prefix strings and calculate their lengths
  const prefix1 = `           `;
  const prefix2 = `           `;
  const prefix1Len = prefix1.length;
  const prefix2Len = prefix2.length;

  // Calculate spacing to match the Slots line width (prefix + bar width)
  // This ensures funds breakdown lines align with the visual bar width
  const barLinePrefix = `    Funds: `;
  const targetWidth = barLinePrefix.length + BAR_WIDTH;

  // Spacing for each line: targetWidth - line prefix - buyValue - sellColumn
  const spacing1 = Math.max(2, targetWidth - prefix1Len - buyValueStr.length - rightColWidth);
  const spacing2 = Math.max(2, targetWidth - prefix2Len - buyEquivStr.length - rightColWidth);

  lines.push(`${prefix1}${colors.buy}${buyValueStr}${colors.reset}${' '.repeat(spacing1)}${colors.sell}${sellValueRight}${colors.reset}`);
  lines.push(`${prefix2}${buyEquivStr}${' '.repeat(spacing2)}${sellEquivRight}`);

  // Align pipe separators across all lines so every | sits at the same column
  let maxPipePos = 0;
  const pipeLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const pipeIdx = lines[i].indexOf('|');
    if (pipeIdx !== -1) {
      pipeLines.push(i);
      const visualLen = stripColorCodes(lines[i].substring(0, pipeIdx)).length;
      if (visualLen > maxPipePos) maxPipePos = visualLen;
    }
  }
  for (const idx of pipeLines) {
    const pipeIdx = lines[idx].indexOf('|');
    const visualLen = stripColorCodes(lines[idx].substring(0, pipeIdx)).length;
    if (visualLen < maxPipePos) {
      lines[idx] = lines[idx].substring(0, pipeIdx) + ' '.repeat(maxPipePos - visualLen) + lines[idx].substring(pipeIdx);
    }
  }

  return lines.join('\n');
}

/**
 * main: Entry point - analyze all order files and display results
 *
 * Flow:
 * 1. Get all order files from profiles/orders/ (sorted by modified date)
 * 2. For each file:
 *    - Parse order data JSON
 *    - Look up bot configuration from profiles/bots.json
 *    - Perform comprehensive analysis
 *    - Format and display results
 * 3. Handle errors gracefully (skip bad files, continue)
 * 4. Print summary statistics
 *
 * Error handling:
 * - Invalid JSON: Catch and skip file with error message
 * - Missing config: Display grid data only (no target comparisons)
 * - Empty orders directory: Display message and exit
 *
 * Output order: Files sorted by modification time (most recent first)
 * makes it easy to see which bots were most recently updated
 */
/**
 * generateHtmlReport: Export all analyses as a standalone HTML report.
 *
 * Produces a self-contained HTML file with visually styled cards, colored
 * distribution bars, and aligned metrics — matching the terminal output's
 * information density in a browser-friendly format.
 *
 * @param {Array<Object>} analyses - Array of analysis results from analyzeOrder()
 */
function generateHtmlReport(analyses: JsonObj[]) {
  const cssColors = {
    buy: '#00ff00',
    buyDark: '#007700',
    sell: '#ff0000',
    sellDark: '#990000',
    spread: '#ffff00',
    cyan: '#5fffff',
    gray: '#949494'
  };

  const htmlColorMap: Record<string, string> = {
    [colors.buy]: `<span style="color:${cssColors.buy}">`,
    [colors.sell]: `<span style="color:${cssColors.sell}">`,
    [colors.buyDark]: `<span style="color:${cssColors.buyDark}">`,
    [colors.sellDark]: `<span style="color:${cssColors.sellDark}">`,
    [colors.spread]: `<span style="color:${cssColors.spread}">`,
    [colors.cyan]: `<span style="color:${cssColors.cyan}">`,
    [colors.gray]: `<span style="color:${cssColors.gray}">`,
    [colors.white]: '<span style="color:#ffffff">' // white for spread bar
  };

  function ansiToHtml(str: string): string {
    let escaped = String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    
    let colorOpen = false;

    return escaped.replace(/\x1b\[[0-9;]*m/g, (code) => {
      let close = '';
      if (colorOpen) {
        colorOpen = false;
        close = '</span>';
      }

      if (code === colors.reset) return close;

      const html = htmlColorMap[code];
      if (!html) return close;

      colorOpen = true;
      return close + html;
    }) + (colorOpen ? '</span>' : '');
  }

  const reports = analyses.map((a) => ansiToHtml(formatAnalysis(a))).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="darkreader-lock">
<title>Order Analysis Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; padding: 24px; }
  h1 { color: ${cssColors.cyan}; font-size: 20px; margin-bottom: 8px; }
  .subtitle { color: ${cssColors.gray}; font-size: 13px; margin-bottom: 24px; }
  .summary { margin-top: 16px; color: ${cssColors.cyan}; font-size: 13px; }
  pre { 
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; 
    font-size: 14px; 
    line-height: 1.5; 
    background: #000; 
    padding: 16px; 
    border-radius: 8px; 
    border: 1px solid #30363d; 
    overflow-x: auto;
  }
</style>
</head>
<body>
<h1>🔍 Order Analysis</h1>
<div class="subtitle">${analyses.length} bot${analyses.length !== 1 ? 's' : ''} analyzed — ${new Date().toLocaleString()}</div>
<pre>${reports}</pre>
<div class="summary">Total: ${analyses.length} analyzed</div>
</body>
</html>`;

  const outPath = path.join(PATHS.ANALYSIS.CHARTS_DIR, 'order-analysis.html');
  fs.mkdirSync(PATHS.ANALYSIS.CHARTS_DIR, { recursive: true });
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log(savedLine(CLI_TAGS.orders, 'Order Analysis', toFileUrl(outPath), 'report'));
}

function main() {
  const rawArgs = process.argv.slice(2);
  const exportHtml = rawArgs.includes('--export');
  // Positional (non-flag) args select the analysed grids: a bot name/key, or a
  // chain account (every bot trading it). Examples:
  //   node dist/scripts/analyze-orders.js <bot|account>
  //   node dist/scripts/analyze-orders.js <bot|account> --export
  const botKeyFilter = rawArgs.find((arg) => !arg.startsWith('-'))?.trim().toLowerCase() || null;

  if (!exportHtml) {
    const targetNote = botKeyFilter ? ` (filter: ${botKeyFilter})` : '';
    console.log(`\n${colors.cyan}🔍 Order Analysis${targetNote}${colors.reset}`);
    console.log(`${colors.cyan}${'='.repeat(HEADER_WIDTH)}${colors.reset}`);
  }

  // Get all order files sorted by modification time (newest first)
  let { files, skippedCandidates } = getOrderFiles();

  // Filter to the requested bot or account. Target matching is the shared
  // `<bot|account>` rule set (analysis/bot_key_utils): bot key, bot name, or the
  // chain account the bot trades from (`preferredAccount` name / 1.2.x id).
  // The file's own key still matches when a snapshot has no bots.json entry.
  if (botKeyFilter) {
    const matched = files.filter((file) => {
      const config = file.config ?? null;
      return matchBotEntryTarget(config, botKeyFilter, file.botKey) !== null
        || matchBotAccountTarget(config, botKeyFilter);
    });
    if (matched.length === 0) {
      if (exportHtml) {
        generateHtmlReport([]);
      } else {
        console.log(`${colors.sell}No order grid found for '${botKeyFilter}'.${colors.reset}`);
        console.log('Available bots:');
        files.forEach((file) => {
          const config = file.config ?? null;
          const name = config?.name ? String(config.name) : '';
          const nameSuffix = name && name.toLowerCase() !== String(file.botKey).toLowerCase() ? ` (${name})` : '';
          const account = config?.preferredAccount ? ` (account: ${String(config.preferredAccount)})` : '';
          console.log(`  - ${file.botKey}${nameSuffix}${account}`);
        });
      }
      process.exit(0);
    }
    files = matched;
  }

  // Handle fully empty directory case. If files were skipped, report why below.
  if (files.length === 0 && skippedCandidates.length === 0) {
    if (!exportHtml) {
      console.log(`No order files found in ${ORDERS_DIR}`);
    }
    process.exit(0);
  }

  // Counters for summary statistics
  let analyzed = 0;
  let skipped = 0;
  const analyses: JsonObj[] = [];

  /**
   * Process each order file
   * Try-catch ensures one bad file doesn't stop analysis of others
   */
  files.forEach((file, index) => {
    try {
      // Parse order file JSON
      const orderData = readJSON(file.path as string);
      // Per-bot file: data is the bot's entry directly (no bots wrapper)
      if (!orderData || !orderData.meta || !Array.isArray(orderData.grid)) {
        throw new Error('Not a persisted order grid');
      }
      const botKey = file.botKey as string;
      const botData = orderData;

      // Candidate validation already required a configured bot entry.
      const config = file.config || getConfiguredBotConfig(botKey, botData);
      if (!config) {
        throw new Error(`Missing configured bot entry for ${botKey}`);
      }

      // Analyze the order grid (botKey is used to load the dynamic grid snapshot)
      const analysis = analyzeOrder(botData, config, botKey);
      analyses.push(analysis);

      if (!exportHtml) {
        // Display formatted results
        let output = formatAnalysis(analysis);
        // Remove leading newline from first pair to avoid blank line after header
        if (index === 0) {
          output = output.replace(/^\n/, '');
          console.log(output);
          console.log('');  // Extra blank line after first batch
        } else {
          console.log(output);
        }
      }
      analyzed++;

    } catch (error) {
      // Log error but continue processing other files
      console.error(`\n❌ Error processing ${file.name}: ${getErrorMessage(error)}`);
      skipped++;
    }
  });

  if (exportHtml) {
    generateHtmlReport(analyses);
    return;
  }

  if (skippedCandidates.length > 0 && !botKeyFilter) {
    console.log('');
    console.log(`${colors.cyan}${'='.repeat(HEADER_WIDTH)}${colors.reset}`);
    skippedCandidates.forEach((candidate) => {
      console.log(`${colors.gray}Skipped ${candidate.name}: ${candidate.reason}${colors.reset}`);
      skipped++;
    });
  }

  // Summary line
  console.log(`${colors.cyan}${'='.repeat(HEADER_WIDTH)}${colors.reset}`);
  console.log(`${colors.cyan}Summary: ${analyzed} analyzed, ${skipped} skipped${colors.reset}\n`);
}

// Execute analysis only when invoked as a script. When required from a test we
// expose the helpers below without triggering the analyzer side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { resolveAmaKey, isAmaGridPrice, readDynamicGridSnapshot, buildDynamicWeightInfo, formatWeightLine, getRawWeightValues, analyzeOrder, formatAnalysis, generateHtmlReport, colors, DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS, DYNAMIC_WEIGHT_EPSILON }


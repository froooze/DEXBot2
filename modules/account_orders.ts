/**
 * modules/account_orders.ts - Order Grid Persistence Layer
 *
 * Local persistence for order grid snapshots and state.
 * Enables bot recovery after crashes or restarts.
 *
 * Per-Bot Architecture:
 * Each bot has its own dedicated file: profiles/orders/{botKey}.json
 * The file stores a single bot's data directly (no per-file wrapper),
 * which makes the doubled-entry bug structurally impossible.
 *
 * ===============================================================================
 * EXPORTS (1 class + 2 helpers)
 * ===============================================================================
 *
 * 1. AccountOrders(options) - Class for per-bot order persistence
 *    Constructor options: { botKey, ordersDir?, profilesPath? } (botKey required, throws if missing)
 *    Methods:
 *      syncMeta(botConfig), storeMasterGrid(orders, btsFeesOwed, boundaryIdx, assets, debugInputs, recentFillKeys, genesis, gapEvacStreaks, pendingFillCrawls, lastFillPivot, lastMarketFill)
 *      loadGrid(forceReload), loadRecentFillKeys(forceReload), loadPersistedAssets(forceReload), loadPendingFillCrawls(forceReload)
 *      loadBoundaryIdx(forceReload), loadBtsBalance(forceReload), loadBtsFeesOwed(forceReload), loadGapEvacStreaks(forceReload), loadGenesis(forceReload), loadLastFillPivot(forceReload), loadLastMarketFill(forceReload)
 *      clearGrid(), clearPersistedBoundary(), clearPersistedLastFillPivot(), clearPersistedLastMarketFill(), backupSnapshot(reason)
 *      loadProcessedFills(options), updateProcessedFillsBatch(fills), cleanOldProcessedFills(olderThanMs)
 *      getAssetBalances(forceReload)
 *
 * 2. createBotKey(bot, index) - Generate unique bot key string
 *    Uses sanitized bot.name; unnamed bots fall back to asset pair + index
 *
 * 3. sanitizeKey(value) - Re-export of utils/sanitize_key: filename-safe key
 *    normalization (trim, lowercase, collapse non-alphanumeric runs to '-')
 *
 * ===============================================================================
 *
 * FILE STRUCTURE (profiles/orders/{botKey}.json):
 * {
 *   "meta": {
 *     "name": "Bot name",
 *     "assetA": "BTS",
 *     "assetB": "USD",
 *     "active": true,
 *     "index": 0
 *   },
 *   "grid": [
 *     { "id": "slot-0", "type": "buy", "state": "virtual", "price": 100, "size": 1, "orderId": null },
 *     ...
 *   ],
 *   "btsFeesOwed": 0.1,
 *   "createdAt": "ISO timestamp",
 *   "lastUpdated": "ISO timestamp"
 * }
 *
 * GRID ENTRY FIELDS:
 * - id: Unique identifier (format: slot-N or custom)
 * - type: 'buy', 'sell', or 'spread'
 * - state: 'virtual', 'active', or 'partial'
 * - price: Price level
 * - size: Order size in base asset
 * - orderId: Blockchain order ID (null for VIRTUAL)
 * - createUncertain: (optional, only when true) slot keeps its size because a
 *   CREATE broadcast result was lost; consumed by the loadGrid orphan sanitizer
 *
 * ===============================================================================
 */


import { path } from './path_api.js';
import { getStorage } from './storage/index.js';
import { ORDER_TYPES, ORDER_STATES } from './constants.js';
import { PATHS } from './paths.js';
import AsyncLock from './order/async_lock.js';
import { isPhantomOrder } from './order/utils/order.js';
import { hasGenesisLadder } from './order/genesis_policy.js';
import * as Format from './order/format.js';
import { ensureDir, nowIso, normalizeLastFillPivot, normalizeLastMarketFill } from './order/utils/system.js';
import Logger from './order/logger.js';
import { getErrorMessage, getErrorCode } from './utils/errors.js';
import { sanitizeKey } from './utils/sanitize_key.js';
const storage = getStorage();
const { toFiniteNumber } = Format;


const accountOrdersLogger = new Logger('AccountOrders');

/**
 * Ensures that the directory for the given file path exists.
 * @param {string} filePath - The file path to check.
 * @private
 */
function ensureDirExists(filePath: string) {
  ensureDir(path.dirname(filePath));
}

/**
 * Generate a unique key for identifying a bot in storage.
 * Bot names are enforced unique, so for named bots the key is simply
 * the sanitized name. Unnamed bots fall back to sanitized asset pair + index.
 *
 * @param {Object} bot - Bot configuration
 * @param {number} index - Index in bots array (used for unnamed fallback)
 * @returns {string} Sanitized key
 */
function createBotKey(bot: Record<string, unknown> | null | undefined, index: number) {
  if (bot && bot.name) {
    return sanitizeKey(bot.name);
  }
  const identifier = bot && bot.assetA && bot.assetB
    ? `${bot.assetA}/${bot.assetB}`
    : bot && bot.assetAId && bot.assetBId
      ? `${bot.assetAId}/${bot.assetBId}`
      : `bot-${index}`;
  return `${sanitizeKey(identifier)}-${index}`;
}

const SENSITIVE_KEY_PATTERN = /(private|secret|password|credential|wif|token|hmac|memo)/i;

function cloneForDebug(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Map) {
    seen.add(value);
    return Object.fromEntries(Array.from(value.entries(), ([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(String(key)) ? '[REDACTED]' : cloneForDebug(item, seen)
    ]));
  }
  if (value instanceof Set) {
    seen.add(value);
    return Array.from(value.values(), (item) => cloneForDebug(item, seen));
  }
  if (value instanceof Date) return value.toISOString();

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => cloneForDebug(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue;
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : cloneForDebug(item, seen);
  }
  return result;
}

/**
 * Builds an empty per-bot data object. The file is single-object, so this is
 * the default content when the file does not yet exist.
 * @returns {Object} Fresh data object
 * @private
 */
function emptyData() {
  const timestamp = nowIso();
  return {
    meta: null,
    grid: [],
    btsFeesOwed: 0,
    btsBalance: null,
    boundaryIdx: null,
    assets: null,
    debugInputs: null,
    processedFills: {},
    recentFillKeys: {},
    genesis: null,
    createdAt: timestamp,
    lastUpdated: timestamp
  };
}

interface BotMeta {
  key: string;
  name: string | null;
  assetA: string | null;
  assetB: string | null;
  active: boolean;
  index: number;
  createdAt: string;
  updatedAt: string;
}

interface SerializedOrder {
  id: string | null;
  type: string | null;
  state: string | null;
  price: number;
  size: number;
  orderId: string;
  createUncertain?: boolean;
}

interface BotData {
  meta: BotMeta | null;
  grid: SerializedOrder[];
  btsFeesOwed: number;
  btsBalance: Record<string, unknown> | null;
  boundaryIdx: number | null;
  assets: Record<string, unknown> | null;
  debugInputs: Record<string, unknown> | null;
  processedFills: Record<string, number>;
  recentFillKeys: Record<string, unknown>;
  genesis: Record<string, unknown> | null;
  createdAt: string;
  lastUpdated: string;
  gapEvacStreaks?: Record<string, number>;
  pendingFillCrawls?: { slotId: string; side: string; ts: number }[];
  lastFillPivot?: unknown;
  /** Bot-scoped last-market-fill reference (survives grid regeneration). */
  lastMarketFill?: { price: number; type: string; fillsAt: number };
}

/**
 * AccountOrders class - manages order grid persistence
 *
 * Provides methods to:
 * - Store and load order grid snapshots
 * - Track bot metadata and state
 * - Calculate asset balances from stored grids
 *
 * Each bot has its own file: {botkey}.json
 * The file holds the bot's data directly (no `bots: { [key]: ... }` wrapper).
 *
 * @class
 */
class AccountOrders {
  botKey: string;
  profilesPath: string;
  _persistenceLock: AsyncLock;
  _needsBootstrapSave: boolean;
  data!: BotData;
  _rejectedGenesis?: { reason: string; at: number };

  /**
   * Create an AccountOrders instance.
   * @param {Object} options - Configuration options
   * @param {string} options.botKey - Bot identifier (e.g., 'asset1-asset2-0', 'market-a-1')
   * @param {string} [options.ordersDir] - Optional override for the per-bot storage directory
   * @param {string} [options.profilesPath] - Optional override for the per-bot storage file path
   */
  constructor(options: { botKey: string; ordersDir?: string; profilesPath?: string } = { botKey: '' }) {
    if (!options.botKey) throw new Error("botKey required for AccountOrders");
    this.botKey = options.botKey;

    // Use per-bot file: {botKey}.json
    const ordersDir = options.ordersDir || PATHS.ORDERS_DIR;
    this.profilesPath = options.profilesPath || path.join(ordersDir, `${this.botKey}.json`);

    // AsyncLock prevents concurrent read-modify-write races on file I/O
    this._persistenceLock = new AsyncLock();

    this._needsBootstrapSave = !storage.exists(this.profilesPath);
    this._reload();
    if (this._needsBootstrapSave) {
      this._persist();
    }
  }

  /**
   * Loads the data for the current bot from its profile file.
   * @returns {Object|null} The loaded data or null if not found.
   * @private
   */
  _loadData() {
    // Load the file directly - per-bot files only contain their own bot's data
    return this._readFile(this.profilesPath);
  }

  /**
   * Reload `this.data` from disk, falling back to empty state on a miss.
   * Single home for the read-modify-write preamble inside the persistence lock.
   * @private
   */
  _reload(): void {
    this.data = this._loadData() || emptyData();
  }

  /**
   * Reload `this.data` from disk when `forceReload` is set. Shared preamble of
   * every `loadX(forceReload)` accessor.
   * @param {boolean} [forceReload=false]
   * @private
   */
  _ensureLoaded(forceReload: boolean = false): void {
    if (forceReload) this._reload();
  }

  /**
   * Reads and parses a JSON file.
   * @param {string} filePath - The path to the file.
   * @returns {Object|null} The parsed object or null on failure.
   * @private
   */
  _readFile(filePath: string): BotData | null {
    try {
      const parsed = storage.readJSON(filePath);
      if (typeof parsed === 'object' && parsed !== null) return parsed as unknown as BotData;
    } catch (err) {
      if (getErrorCode(err) === 'ENOENT') {
        return null;
      }
      if (err instanceof SyntaxError) {
        accountOrdersLogger.warn(
          `Corrupt profile file ${filePath} (${getErrorMessage(err)}); ` +
          `starting from empty state — the next persist will overwrite it.`
        );
        return null;
      }
      accountOrdersLogger.warn(`Failed to read ${filePath} - ${getErrorMessage(err)}`);
    }
    return null;
  }

  /**
   * Persists the current data to the profile file.
   * @private
   */
  _persist() {
    ensureDirExists(this.profilesPath);
    storage.writeJSON(this.profilesPath, this.data, { fsync: true });
  }

  /**
   * Sync the persisted meta for this bot from its bots.json entry.
   * Creates a new file if the meta was never written; updates the existing
   * meta in place if it has drifted. The grid and other state are not touched.
   * @param {Object} botConfig - The bot config matching this.botKey
   */
  async syncMeta(botConfig: unknown) {
    if (!botConfig) return;

    await this._persistenceLock.acquire(async () => {
      // Reload from disk to ensure we have the latest state
      this._reload();

      const cfg = botConfig as Record<string, unknown>;
      const newMeta = this._buildMeta(botConfig, this.botKey, typeof cfg.botIndex === 'number' ? cfg.botIndex : 0, this.data.meta);
      const prevMeta = this.data.meta;

      if (this._metaChanged(prevMeta, newMeta)) {
        accountOrdersLogger.info(`Metadata changed for bot ${this.botKey}: updating from old metadata to new`);
        accountOrdersLogger.info(`  OLD: name=${prevMeta?.name}, assetA=${prevMeta?.assetA}, assetB=${prevMeta?.assetB}, active=${prevMeta?.active}`);
        accountOrdersLogger.info(`  NEW: name=${newMeta.name}, assetA=${newMeta.assetA}, assetB=${newMeta.assetB}, active=${newMeta.active}`);
        this.data.meta = { ...(prevMeta || {}), ...newMeta, createdAt: prevMeta?.createdAt || newMeta.createdAt };
        this.data.lastUpdated = nowIso();
        this._persist();
      } else {
        accountOrdersLogger.info(`No metadata change for bot ${this.botKey} - skipping update`);
        accountOrdersLogger.info(`  CURRENT: name=${prevMeta?.name}, assetA=${prevMeta?.assetA}, assetB=${prevMeta?.assetB}, active=${prevMeta?.active}`);
        accountOrdersLogger.info(`  PASSED:  name=${newMeta.name}, assetA=${newMeta.assetA}, assetB=${newMeta.assetB}, active=${newMeta.active}`);
      }
    });
  }

  /**
   * Checks whether two meta objects differ on the relevant fields.
   * @param {Object} existing - The existing meta (possibly null).
   * @param {Object} next - The new meta.
   * @returns {boolean} True if meta has changed.
   * @private
   */
  _metaChanged(existing: BotMeta | null, next: BotMeta) {
    if (!existing) return true;
    return existing.name !== next.name ||
      existing.assetA !== next.assetA ||
      existing.assetB !== next.assetB ||
      existing.active !== next.active ||
      existing.index !== next.index;
  }

  /**
   * Builds a metadata object for a bot.
   * @param {Object} bot - The bot configuration.
   * @param {string} key - The bot key.
   * @param {number} index - The bot index.
   * @param {Object|null} [existing=null] - Existing metadata for preserving createdAt.
   * @returns {Object} The new meta object.
   * @private
   */
  _buildMeta(bot: unknown, key: string, index: number, existing: { createdAt?: string } | null = null): BotMeta {
    const timestamp = nowIso();
    const b = bot as Record<string, unknown>;
    return {
      key,
      name: (b.name as string) || null,
      assetA: (b.assetA as string) || null,
      assetB: (b.assetB as string) || null,
      active: !!b.active,
      index,
      createdAt: (existing && existing.createdAt) || timestamp,
      updatedAt: timestamp
    };
  }

  /**
   * Save the current order grid snapshot for this bot.
   * Called after grid changes (initialization, fills, syncs).
   * @param {Array} orders - Array of order objects from OrderManager
   * @param {number|null} btsFeesOwed - Optional BTS blockchain fees owed
   * @param {number|null} boundaryIdx - Optional master boundary index for StrategyEngine
   * @param {Object|null} assets - Optional asset metadata { assetA, assetB }
   * @param {Object|null} debugInputs - Optional debug-only input snapshot
   * @param {Object|null} recentFillKeys - Optional fill key dedup snapshot for crash recovery
   * @param {Object|null} genesis - Optional frozen genesis (priceLevels etc)
   */
  async storeMasterGrid(orders: unknown[] = [], btsFeesOwed: number | null = null, boundaryIdx: number | null = null, assets: Record<string, unknown> | null = null, debugInputs: unknown = null, recentFillKeys: Record<string, unknown> | null = null, genesis: unknown = null, gapEvacStreaks: unknown = undefined, pendingFillCrawls: unknown = undefined, lastFillPivot: unknown = undefined, lastMarketFill: unknown = undefined) {
    // Use AsyncLock to serialize read-modify-write operations
    await this._persistenceLock.acquire(async () => {
      // Reload from disk before writing to prevent race conditions
      this._reload();

      const snapshot = Array.isArray(orders) ? orders.map((order) => this._serializeOrder(order)) : [];
      const debugSnapshot = debugInputs ? cloneForDebug(debugInputs) as Record<string, unknown> : null;

      this.data.grid = snapshot;

      if (Number.isFinite(btsFeesOwed)) {
        this.data.btsFeesOwed = btsFeesOwed as number;
      }

      if (Number.isFinite(boundaryIdx)) {
        this.data.boundaryIdx = boundaryIdx;
      }

      if (assets) {
        this.data.assets = assets;
      }

      if (debugSnapshot) {
        this.data.debugInputs = debugSnapshot;
      }

      // Persist btsBalance for non-BTS pairs (passed via debugInputs)
      if (debugSnapshot && debugSnapshot.btsBalance) {
        this.data.btsBalance = debugSnapshot.btsBalance as Record<string, unknown>;
      }

      // Persist recent fill keys for crash-durable dedup window
      if (recentFillKeys) {
        this.data.recentFillKeys = recentFillKeys;
      } else if (!this.data.recentFillKeys) {
        this.data.recentFillKeys = {};
      }

      if (genesis && typeof genesis === 'object' && Array.isArray((genesis as Record<string, unknown>).priceLevels)) {
        this.data.genesis = genesis as Record<string, unknown>;
      }

      // Persist gap-evacuation streaks (Phase 3 restart resilience): only
      // finite positive per-slot counts survive; an empty map clears the
      // stored entry so stale ids never resurrect after a grid reset.
      if (gapEvacStreaks !== undefined) {
        const sanitized: Record<string, number> = {};
        if (gapEvacStreaks && typeof gapEvacStreaks === 'object') {
          for (const [id, count] of Object.entries(gapEvacStreaks)) {
            const n = Math.floor(Number(count));
            if (id && Number.isFinite(n) && n > 0) sanitized[id] = n;
          }
        }
        if (Object.keys(sanitized).length > 0) {
          this.data.gapEvacStreaks = sanitized;
        } else {
          delete this.data.gapEvacStreaks;
        }
      }
      // Persist pending fill crawls (restart resilience): fills whose
      // boundary crawl was recorded but never committed. Only sanitized
      // entries survive; an empty array clears the stored entry so
      // consumed entries never resurrect after a commit.
      if (pendingFillCrawls !== undefined) {
        const sanitized: { slotId: string; side: string; ts: number }[] = [];
        if (Array.isArray(pendingFillCrawls)) {
          for (const e of pendingFillCrawls.slice(-500)) {
            if (e && typeof e.slotId === 'string' && e.slotId.length > 0
              && (e.side === 'buy' || e.side === 'sell') && Number.isFinite(Number(e.ts))) {
              sanitized.push({ slotId: e.slotId, side: e.side, ts: Number(e.ts) });
            }
          }
        }
        if (sanitized.length > 0) {
          this.data.pendingFillCrawls = sanitized;
        } else {
          delete this.data.pendingFillCrawls;
        }
      }

      if (lastFillPivot !== undefined) {
        // Only a fill-derived, validated-on-grid pivot survives (provenance
        // gate: a book-derived or unvalidated heuristic is never written as
        // if it were market truth). genesisHash binds it to the snapshot the
        // boundary lives in: a persisted pivot from an old genesis is not
        // valid after a grid regeneration/re-derive, and the restore helper
        // refuses it on mismatch (same lockstep contract as pendingFillCrawls).
        // null clears any previously stored row on every live-grid persist so
        // a consumed pivot never resurrects; undefined (legacy callers) is a
        // no-op; any other malformed shape is treated as an explicit clear
        // (never store, never leave a stale row behind). Row validation is
        // the shared normalizeLastFillPivot gate — the loader enforces the
        // exact same shape, so the two gates cannot drift.
        if (lastFillPivot === undefined) {
          // Legacy no-op (backward-compatible callers), mirror gapEvacStreaks.
        } else if (lastFillPivot === null) {
          delete this.data.lastFillPivot;
        } else {
          const normalized = normalizeLastFillPivot(lastFillPivot);
          if (normalized) {
            this.data.lastFillPivot = normalized;
          } else {
            delete this.data.lastFillPivot;
          }
        }
      }

      // Bot-scoped last-market-fill reference. Same absent-value contract as
      // lastFillPivot above: undefined is a legacy no-op, null clears, a
      // validated row is written, any other malformed shape clears (never
      // store a stale row). The difference from the pivot is lifetime only —
      // clearGrid() deliberately preserves this row, so it survives a grid
      // regeneration instead of being bound to one generation.
      if (lastMarketFill !== undefined) {
        if (lastMarketFill === null) {
          delete this.data.lastMarketFill;
        } else {
          const normalized = normalizeLastMarketFill(lastMarketFill);
          if (normalized) {
            this.data.lastMarketFill = normalized;
          } else {
            delete this.data.lastMarketFill;
          }
        }
      }

      const timestamp = nowIso();
      this.data.lastUpdated = timestamp;
      if (this.data.meta) this.data.meta.updatedAt = timestamp;
      this._persist();
    });
  }
  /**
   * Erase a poisoned persisted boundary after GRID-LOAD rejects it with no
   * safe re-derivation. storeMasterGrid deliberately never writes a null
   * boundary (Number.isFinite guard), so without this the rejected value
   * survives every flush and re-arms the rejection on every restart.
   * Explicit-only: normal persists keep passing the live boundary through.
   * Boot-time only: this reloads from disk inside the lock, discarding any
   * unsaved in-memory mutations — safe at the GRID-LOAD call site (before
   * fills mutate state) but do NOT invoke later in the lifecycle.
   */
  async clearPersistedBoundary() {
    await this._persistenceLock.acquire(async () => {
      this._reload();
      this.data.boundaryIdx = null;
      this._persist();
    });
  }

  /**
   * Erase a persisted LAST-FILL-GUARD pivot that restoreLastFillPivot
   * rejected (genesis mismatch / TTL expiry / off-ladder). storeMasterGrid
   * deliberately keeps an untouched row for legacy `undefined` callers, so
   * without this explicit erase a rejected value would re-arm the rejection
   * on every restart. Load-time only: this reloads from disk inside the
   * lock, discarding any unsaved in-memory mutations — safe at the
   * loadGrid/restore call site (startup load and recovery reload, both
   * before fills mutate state) but do NOT invoke from an arbitrary runtime
   * path.
   */
  async clearPersistedLastFillPivot() {
    await this._persistenceLock.acquire(async () => {
      this._reload();
      delete this.data.lastFillPivot;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Load the persisted order grid for this bot.
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {Array|null} Order grid array or null if not found
   */
  loadGrid(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    return (this.data && Array.isArray(this.data.grid)) ? this.data.grid : null;
  }

  /**
   * Load the persisted price-ladder (genesis) for this bot.
   *
   * SCHEMA GATE (docs/GRID_PRICE_INVARIANT.md, "Schema"): a usable ladder needs a
   * NON-EMPTY `priceLevels` array. A row without one is not a ladder --
   * accepting it would hand `loadGrid` a genesis it cannot validate against
   * (and, for an empty array, silently disable every genesis-derived consumer).
   * Refusing it here means the caller takes the missing-genesis path once, at
   * the source, instead of at every consumer.
   *
   * The hash is deliberately NOT required here: a present-but-tampered hash is
   * still returned, because the hash-mismatch warning belongs to `loadGrid`,
   * which can say what it compared against (`hasGenesisLadder` in
   * modules/order/genesis_policy.ts draws the same distinction).
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} The genesis object, or null when absent/invalid
   */
  loadGenesis(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    const genesis = this.data?.genesis;
    // Same predicate as loadGrid/genesis_policy: one definition of "usable
    // ladder", so the schema gate cannot diverge from the load-time gate.
    if (hasGenesisLadder(genesis)) {
      return genesis;
    }
    if (genesis) {
      this._noteRejectedGenesis(genesis);
    }
    return null;
  }

  /**
   * Record why a persisted genesis row was refused (observability for the
   * schema gate above; loadGrid cannot report a row it never receives).
   */
  private _noteRejectedGenesis(genesis: unknown) {
    try {
      const g = (genesis && typeof genesis === 'object') ? genesis as { priceLevels?: unknown } : null;
      const levels = g?.priceLevels;
      const reason = !Array.isArray(levels)
        ? 'priceLevels is not an array'
        : (levels.length === 0 ? 'priceLevels is empty' : 'malformed');
      this._rejectedGenesis = { reason, at: Date.now() };
    } catch { /* never fail a load for telemetry */ }
  }

  /**
   * Load the persisted gap-evacuation streaks (per-slot in-band cycle counts).
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} {slotId: count} map or null when absent
   */
  loadGapEvacStreaks(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    if (this.data && this.data.gapEvacStreaks && typeof this.data.gapEvacStreaks === 'object') {
      return this.data.gapEvacStreaks;
    }
    return null;
  }

  loadLastFillPivot(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    // Shared row gate (normalizeLastFillPivot): identical validation to the
    // storeMasterGrid sanitizer, one shape contract for the whole ledger.
    return normalizeLastFillPivot(this.data && this.data.lastFillPivot);
  }

  /**
   * Load the persisted bot-scoped last-market-fill reference.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} {price, type, fillsAt} or null when absent/invalid
   */
  loadLastMarketFill(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    return normalizeLastMarketFill(this.data && this.data.lastMarketFill);
  }

  /**
   * Load the persisted sync-pass-1 "size already applied" markers.
   * Stored in the free-form debugInputs blob (no order-row schema change).
   * Returns a sanitized `{ orderId: { filledInt, at } }` map (empty when
   * absent/malformed); freshness/TTL enforcement happens manager-side.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object}
   */
  loadChainSizeAppliedFills(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    const out: Record<string, { filledInt: number; at: number }> = {};
    const stored = this.data && this.data.debugInputs
      ? (this.data.debugInputs as Record<string, unknown>).chainSizeAppliedFills
      : null;
    if (!stored || typeof stored !== 'object') return out;
    let count = 0;
    for (const [id, raw] of Object.entries(stored as Record<string, unknown>)) {
      if (!id || count >= 500) continue;
      const e = raw as { filledInt?: unknown; at?: unknown } | null;
      const filledInt = Math.round(Number(e?.filledInt));
      const at = Number(e?.at);
      if (!Number.isFinite(filledInt) || filledInt <= 0 || !Number.isFinite(at)) continue;
      out[id] = { filledInt, at };
      count++;
    }
    return out;
  }

  /**
   * Erase a persisted last-market-fill row that restoreLastMarketFill
   * rejected (TTL expiry / malformed). Mirrors clearPersistedLastFillPivot:
   * without an explicit erase a dead row would re-arm the same rejection on
   * every restart. Load-time only.
   */
  async clearPersistedLastMarketFill() {
    await this._persistenceLock.acquire(async () => {
      this._reload();
      delete this.data.lastMarketFill;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Copy the on-disk snapshot to a timestamped sibling file before a
   * destructive operation (snapshot rejection / regeneration). The reason tag
   * is sanitized into the suffix: `<profile>.rejected-drift-<ts>`. Owns the
   * path/storage knowledge so callers never reach through to the filesystem.
   * @param {string} [reason='backup'] - Reason tag for the filename
   * @returns {Promise<string|null>} Backup path, or null when absent/failed
   */
  async backupSnapshot(reason: string = 'backup') {
    return await this._persistenceLock.acquire(async () => {
      try {
        if (!storage.exists(this.profilesPath)) return null;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const tag = String(reason).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
        const backupPath = `${this.profilesPath}.${tag}-${ts}`;
        const snapshot = storage.readJSON(this.profilesPath);
        storage.writeJSON(backupPath, snapshot, { fsync: true });
        return backupPath;
      } catch {
        return null;
      }
    });
  }

  /**
   * Load persisted pending fill crawls for this bot.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Array} Sanitized pending crawl entries (possibly empty)
   */
  loadPendingFillCrawls(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    const out: { slotId: string; side: string; ts: number }[] = [];
    const stored = this.data && this.data.pendingFillCrawls;
    if (Array.isArray(stored)) {
      for (const e of stored) {
        if (e && typeof e.slotId === 'string' && e.slotId.length > 0
          && (e.side === 'buy' || e.side === 'sell') && Number.isFinite(Number(e.ts))) {
          out.push({ slotId: e.slotId, side: e.side, ts: Number(e.ts) });
        }
      }
    }
    return out;
  }

  /**
   * Load the recently queued fill keys for crash-durable dedup.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} Recent fill keys map or null if not found
   */
  loadRecentFillKeys(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    if (this.data && this.data.recentFillKeys) {
      return this.data.recentFillKeys;
    }
    return null;
  }

  /**
   * Load persisted asset metadata for this bot.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} Asset metadata { assetA, assetB } or null if not found
   */
  loadPersistedAssets(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    if (this.data && this.data.assets) {
      return this.data.assets;
    }
    return null;
  }

  /**
   * Load the master boundary index for this bot.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {number|null} Boundary index or null if not found
   */
  loadBoundaryIdx(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    if (this.data) {
      const idx = this.data.boundaryIdx;
      if (typeof idx === 'number' && Number.isFinite(idx)) {
        return idx;
      }
    }
    return null;
  }

  /**
   * Load persisted BTS balance for this bot (non-BTS pairs only).
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} BTS balance { free, total, locked } or null if not found
   */
  loadBtsBalance(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    if (this.data && this.data.btsBalance && typeof this.data.btsBalance === 'object') {
      return this.data.btsBalance;
    }
    return null;
  }

  /**
   * Load BTS blockchain fees owed for this bot.
   * BTS fees accumulate during fill processing and must persist across restarts
   * to ensure they are properly deducted from proceeds during rotation.
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {number} BTS fees owed or 0 if not found
   */
  loadBtsFeesOwed(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);
    if (this.data) {
      const fees = this.data.btsFeesOwed;
      if (typeof fees === 'number' && Number.isFinite(fees)) {
        return fees;
      }
    }
    return 0;
  }

  /**
   * Clear the persisted grid for this bot.
   * @returns {Promise<boolean>} true if cleared successfully
   */
  async clearGrid() {
    return await this._persistenceLock.acquire(async () => {
      this._reload();
      this.data.grid = [];
      this.data.btsFeesOwed = 0;
      this.data.boundaryIdx = null;
      // Snapshot wipe takes the boundary bookkeeping with it: owed fill crawls
      // are relative deltas against the deleted boundary/grid, so a rebuilt
      // generation must not inherit them (the rebuild re-anchors absolutely).
      delete this.data.pendingFillCrawls;
      // The persisted LAST-FILL-GUARD pivot belongs to the deleted snapshot's
      // generation (its slot ids and genesis): a rebuilt grid must re-arm on
      // a fresh fill, not inherit a pivot validated against wiped geometry.
      delete this.data.lastFillPivot;
      // The bot-scoped last-market-fill reference is DELIBERATELY preserved:
      // it records the last price the ACCOUNT traded at, not grid geometry, so
      // a rebuilt grid still must not trade through it. (TTL applied on restore.)
      this.data.lastUpdated = nowIso();
      this._persist();
      return true;
    });
  }

  /**
   * Load processed fill IDs for this bot to prevent reprocessing fills across
   * restarts. Returns a Map of fillKey => timestamp for fills already processed.
   * @param {boolean|Object} options - Reload/filter options
   * @returns {Map} Map of fillKey => timestamp
   */
  loadProcessedFills(options: boolean | { forceReload?: boolean; minTimestamp?: number } = {}) {
    const forceReload = typeof options === 'boolean' ? options : options?.forceReload === true;
    const minTimestamp = typeof options === 'object' && options !== null && Number.isFinite(options.minTimestamp)
      ? options.minTimestamp
      : null;

    this._ensureLoaded(forceReload);

    if (this.data) {
      const fills = this.data.processedFills || {};
      const entries = Object.entries(fills).filter(([, timestamp]) =>
        minTimestamp == null || (Number.isFinite(timestamp) && timestamp >= minTimestamp!)
      );
      return new Map(entries);
    }
    return new Map();
  }

  /**
   * Persist a batch of processed fill records in one locked disk write.
   * @param {Map<string, number>} fills - Processed fill entries
   */
  async updateProcessedFillsBatch(fills: Map<string, number>) {
    if (!(fills instanceof Map) || fills.size === 0) return;

    await this._persistenceLock.acquire(async () => {
      this._reload();

      if (!this.data.processedFills) {
        this.data.processedFills = {};
      }

      let changed = false;
      for (const [fillKey, timestamp] of fills) {
        if (!fillKey) continue;
        if (this.data.processedFills[fillKey] === timestamp) continue;
        this.data.processedFills[fillKey] = timestamp;
        changed = true;
      }

      if (!changed) return;

      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Clean up old processed fill records (remove entries older than specified age).
   * Prevents processedFills from growing unbounded over time.
   * @param {number} olderThanMs - Remove fills processed more than this many milliseconds ago
   */
  async cleanOldProcessedFills(olderThanMs: number = 3600000) {
    // Default: 1 hour (3600000ms)
    await this._persistenceLock.acquire(async () => {
      this._reload();

      if (!this.data.processedFills) {
        return;
      }

      const now = Date.now();
      const fills = this.data.processedFills;
      let deletedCount = 0;

      for (const [fillKey, timestamp] of Object.entries(fills)) {
        if (now - timestamp > olderThanMs) {
          delete fills[fillKey];
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.data.lastUpdated = nowIso();
        this._persist();
      }
    });
  }

  /**
   * Calculate asset balances from the persisted grid for this bot.
   * Sums order sizes by asset and state (active vs virtual).
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {Object|null} Balance summary or null if no data
   */
  getAssetBalances(forceReload: boolean = false) {
    this._ensureLoaded(forceReload);

    if (!this.data) return null;
    const meta: Partial<BotMeta> = this.data.meta || {};
    const grid = Array.isArray(this.data.grid) ? this.data.grid : [];
    const sums = {
      assetA: { active: 0, virtual: 0 },
      assetB: { active: 0, virtual: 0 },
      meta: { key: this.botKey, name: meta.name || null, assetA: meta.assetA || null, assetB: meta.assetB || null }
    };

    for (const o of grid) {
      const size = toFiniteNumber(o?.size);
      const state = o && o.state || '';
      const typ = o && o.type || '';

      if (typ === ORDER_TYPES.SELL) {
        if (state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL) sums.assetA.active += size;
        else if (state === ORDER_STATES.VIRTUAL) sums.assetA.virtual += size;
      } else if (typ === ORDER_TYPES.BUY) {
        if (state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL) sums.assetB.active += size;
        else if (state === ORDER_STATES.VIRTUAL) sums.assetB.virtual += size;
      }
    }

    return sums;
  }

  /**
   * Serializes an order object for persistence.
   * @param {Object} [order={}] - The order object to serialize.
   * @returns {Object} The serialized order.
   * @private
   */
  _serializeOrder(order: unknown = {}): SerializedOrder {
    const o = order as Record<string, unknown>;
    const priceValue = toFiniteNumber(o.price);
    const sizeValue = toFiniteNumber(o.size);

    // SANITY CHECK: If order is ACTIVE/PARTIAL but has no orderId, it's corrupted.
    // Downgrade to VIRTUAL to prevent persisting phantom active orders.
    // This fixes the root cause of "Active No ID" state in JSON files.
    let state = (o.state as string) || null;
    let orderId = (o.orderId as string) || '';

    if (isPhantomOrder(order as Parameters<typeof isPhantomOrder>[0])) {
        state = ORDER_STATES.VIRTUAL;
        orderId = '';
    }

    const serialized: SerializedOrder = {
      id: (o.id as string) || null,
      type: (o.type as string) || null,
      state: state,
      price: Number.isFinite(priceValue) ? priceValue : 0,
      size: Number.isFinite(sizeValue) ? sizeValue : 0,
      orderId
    };

    // Durable marker: a CREATE whose broadcast result was lost (uncertain)
    // leaves the slot VIRTUAL with its planned size. Only that flagged state
    // is a true sized-orphan candidate at load (grid.ts sanitizer) — plain
    // sized VIRTUAL slots are the normal planned-but-unplaced grid state.
    if (o.createUncertain === true) {
      serialized.createUncertain = true;
    }

    return serialized;
  }
}

export { AccountOrders, createBotKey, sanitizeKey }


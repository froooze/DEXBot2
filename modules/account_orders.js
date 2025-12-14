/**
 * Account Orders Module - Local persistence for order grid snapshots
 * 
 * This module manages the profiles/orders.json file which stores:
 * - Per-bot order grid snapshots (prices, sizes, states, chain IDs)
 * - Bot metadata (name, assets, active status)
 * - Timestamps for tracking changes
 * 
 * The grid snapshot allows the bot to resume from where it left off
 * without regenerating orders, maintaining consistency with on-chain state.
 * 
 * File structure:
 * {
 *   "bots": {
 *     "botkey-0": {
 *       "meta": { name, assetA, assetB, active, index },
 *       "grid": [ { id, type, state, price, size, orderId }, ... ],
 *       "createdAt": "ISO timestamp",
 *       "lastUpdated": "ISO timestamp"
 *     }
 *   },
 *   "lastUpdated": "ISO timestamp"
 * }
 */
const fs = require('fs');
const path = require('path');
const { ORDER_STATES } = require('./order/constants');

const PROFILES_ORDERS_FILE = path.join(__dirname, '..', 'profiles', 'orders.json');

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeKey(source) {
  if (!source) return 'bot';
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';
}

/**
 * Generate a unique key for identifying a bot in storage.
 * Uses bot name or asset pair, sanitized and indexed.
 * @param {Object} bot - Bot configuration
 * @param {number} index - Index in bots array
 * @returns {string} Sanitized key like 'mybot-0' or 'iob-xrp-bts-1'
 */
function createBotKey(bot, index) {
  const identifier = bot && bot.name
    ? bot.name
    : bot && bot.assetA && bot.assetB
      ? `${bot.assetA}/${bot.assetB}`
      : `bot-${index}`;
  return `${sanitizeKey(identifier)}-${index}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * AccountOrders class - manages order grid persistence
 * 
 * Provides methods to:
 * - Store and load order grid snapshots
 * - Track bot metadata and state
 * - Calculate asset balances from stored grids
 * 
 * @class
 */
class AccountOrders {
  /**
   * Create an AccountOrders instance.
   * @param {Object} options - Configuration options
   * @param {string} options.profilesPath - Custom path for orders.json
   */
  constructor(options = {}) {
    this.profilesPath = options.profilesPath || PROFILES_ORDERS_FILE;
    this._needsBootstrapSave = !fs.existsSync(this.profilesPath);
    this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    if (this._needsBootstrapSave) {
      this._persist();
    }
  }

  _loadData() {
    return this._readFile(this.profilesPath);
  }

  _readFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (err) {
      console.warn('account_orders: failed to read', filePath, '-', err.message);
    }
    return null;
  }

  _persist() {
    ensureDirExists(this.profilesPath);
    fs.writeFileSync(this.profilesPath, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }

  /**
   * Ensure storage entries exist for all provided bot configurations.
   * Creates new entries for unknown bots, updates metadata for existing ones.
   * @param {Array} botEntries - Array of bot configurations from bots.json
   */
  ensureBotEntries(botEntries = []) {
    if (!Array.isArray(botEntries)) return;
    const validKeys = new Set();
    let changed = false;

    // 1. Update/Create active bots
    for (const [index, bot] of botEntries.entries()) {
      const key = bot.botKey || createBotKey(bot, index);
      validKeys.add(key);

      let entry = this.data.bots[key];
      const meta = this._buildMeta(bot, key, index, entry && entry.meta);

      if (!entry) {
        entry = {
          meta,
          grid: [],
          cacheFunds: { buy: 0, sell: 0 },
          createdAt: meta.createdAt,
          lastUpdated: meta.updatedAt
        };
        this.data.bots[key] = entry;
        changed = true;
      } else {
        // Ensure cacheFunds exists even for existing bots
        if (!entry.cacheFunds || typeof entry.cacheFunds.buy !== 'number') {
          entry.cacheFunds = { buy: 0, sell: 0 };
          changed = true;
        }

        entry.grid = entry.grid || [];
        if (this._metaChanged(entry.meta, meta)) {
          entry.meta = { ...entry.meta, ...meta, createdAt: entry.meta?.createdAt || meta.createdAt };
          entry.lastUpdated = nowIso();
          changed = true;
        }
      }
      bot.botKey = key;
    }

    // 2. Prune zombie bots (remove entries not in botEntries)
    for (const key of Object.keys(this.data.bots)) {
      if (!validKeys.has(key)) {
        console.log(`[AccountOrders] Pruning stale bot entry: ${key}`);
        delete this.data.bots[key];
        changed = true;
      }
    }

    if (changed) {
      this.data.lastUpdated = nowIso();
      this._persist();
    }
  }

  _metaChanged(existing, next) {
    if (!existing) return true;
    return existing.name !== next.name ||
      existing.assetA !== next.assetA ||
      existing.assetB !== next.assetB ||
      existing.active !== next.active ||
      existing.index !== next.index;
  }

  _buildMeta(bot, key, index, existing = {}) {
    const timestamp = nowIso();
    return {
      key,
      name: bot.name || null,
      assetA: bot.assetA || null,
      assetB: bot.assetB || null,
      active: !!bot.active,
      index,
      createdAt: existing.createdAt || timestamp,
      updatedAt: timestamp
    };
  }

  /**
   * Save the current order grid snapshot for a bot.
   * Called after grid changes (initialization, fills, syncs).
   * @param {string} botKey - Bot identifier key
   * @param {Array} orders - Array of order objects from OrderManager
   * @param {Object} cacheFunds - Optional cached funds { buy: number, sell: number }
   */
  storeMasterGrid(botKey, orders = [], cacheFunds = null, pendingProceeds = null) {
    if (!botKey) return;
    const snapshot = Array.isArray(orders) ? orders.map(order => this._serializeOrder(order)) : [];
    if (!this.data.bots[botKey]) {
      const meta = this._buildMeta({ name: null, assetA: null, assetB: null, active: false }, botKey, null);
      this.data.bots[botKey] = {
        meta,
        grid: snapshot,
        cacheFunds: cacheFunds || { buy: 0, sell: 0 },
        pendingProceeds: pendingProceeds || { buy: 0, sell: 0 },
        createdAt: meta.createdAt,
        lastUpdated: meta.updatedAt
      };
    } else {
      this.data.bots[botKey].grid = snapshot;
      if (cacheFunds) {
        this.data.bots[botKey].cacheFunds = cacheFunds;
      }
      if (pendingProceeds) {
        this.data.bots[botKey].pendingProceeds = pendingProceeds;
      }
      const timestamp = nowIso();
      this.data.bots[botKey].lastUpdated = timestamp;
      if (this.data.bots[botKey].meta) this.data.bots[botKey].meta.updatedAt = timestamp;
    }
    this.data.lastUpdated = nowIso();
    this._persist();
  }

  /**
   * Load the persisted order grid for a bot.
   * @param {string} botKey - Bot identifier key
   * @returns {Array|null} Order grid array or null if not found
   */
  loadBotGrid(botKey) {
    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      return botData.grid || null;
    }
    return null;
  }

  /**
   * Load cached funds for a bot (difference between available and calculated rotation sizes).
   * @param {string} botKey - Bot identifier key
   * @returns {Object|null} Cached funds { buy, sell } or null if not found
   */
  loadCacheFunds(botKey) {
    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const cf = botData.cacheFunds;
      if (cf && typeof cf.buy === 'number' && typeof cf.sell === 'number') {
        return cf;
      }
    }
    return { buy: 0, sell: 0 };
  }

  /**
   * Update cached funds for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {Object} cacheFunds - Cached funds { buy, sell }
   */
  updateCacheFunds(botKey, cacheFunds) {
    if (!botKey || !this.data || !this.data.bots || !this.data.bots[botKey]) {
      return;
    }
    this.data.bots[botKey].cacheFunds = cacheFunds || { buy: 0, sell: 0 };
    this.data.lastUpdated = nowIso();
    this._persist();
  }

  /**
   * Load pending proceeds for a bot (funds from partial fills awaiting rotation).
   * @param {string} botKey - Bot identifier key
   * @returns {Object|null} Pending proceeds { buy, sell } or { buy: 0, sell: 0 } if not found
   */
  loadPendingProceeds(botKey) {
    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const pp = botData.pendingProceeds;
      if (pp && typeof pp.buy === 'number' && typeof pp.sell === 'number') {
        return pp;
      }
    }
    return { buy: 0, sell: 0 };
  }

  /**
   * Update (persist) pending proceeds for a bot.
   * Pending proceeds are temporary funds from partial order fills that are awaiting consumption
   * during the next rotation. They must persist across restarts so fills aren't lost.
   * @param {string} botKey - Bot identifier key
   * @param {Object} pendingProceeds - Pending proceeds { buy, sell }
   */
  updatePendingProceeds(botKey, pendingProceeds) {
    if (!botKey || !this.data || !this.data.bots || !this.data.bots[botKey]) {
      return;
    }
    this.data.bots[botKey].pendingProceeds = pendingProceeds || { buy: 0, sell: 0 };
    this.data.lastUpdated = nowIso();
    this._persist();
  }

  /**
   * Calculate asset balances from a stored grid.
   * Sums order sizes by asset and state (active vs virtual).
   * @param {string} botKeyOrName - Bot key or name to look up
   * @returns {Object|null} Balance summary or null if not found
   */
  getDBAssetBalances(botKeyOrName) {
    if (!botKeyOrName) return null;
    // Find entry by key or by matching meta.name (case-insensitive)
    let key = null;
    if (this.data && this.data.bots) {
      if (this.data.bots[botKeyOrName]) key = botKeyOrName;
      else {
        const lower = String(botKeyOrName).toLowerCase();
        for (const k of Object.keys(this.data.bots)) {
          const meta = this.data.bots[k] && this.data.bots[k].meta;
          if (meta && meta.name && String(meta.name).toLowerCase() === lower) { key = k; break; }
        }
      }
    }
    if (!key) return null;
    const entry = this.data.bots[key];
    if (!entry) return null;
    const meta = entry.meta || {};
    const grid = Array.isArray(entry.grid) ? entry.grid : [];

    const sums = {
      assetA: { active: 0, virtual: 0 },
      assetB: { active: 0, virtual: 0 },
      meta: { key, name: meta.name || null, assetA: meta.assetA || null, assetB: meta.assetB || null }
    };

    for (const o of grid) {
      const size = Number(o && o.size) || 0;
      const state = o && o.state ? String(o.state).toLowerCase() : '';
      const typ = o && o.type ? String(o.type).toLowerCase() : '';

      if (typ === 'sell') {
        if (state === 'active') sums.assetA.active += size;
        else if (state === 'virtual') sums.assetA.virtual += size;
      } else if (typ === 'buy') {
        if (state === 'active') sums.assetB.active += size;
        else if (state === 'virtual') sums.assetB.virtual += size;
      }
    }

    return sums;
  }

  _serializeOrder(order = {}) {
    const priceValue = Number(order.price !== undefined && order.price !== null ? order.price : 0);
    const sizeValue = Number(order.size !== undefined && order.size !== null ? order.size : 0);
    // Preserve orderId for both ACTIVE and PARTIAL orders
    const shouldHaveId = order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL;
    const orderId = shouldHaveId ? (order.orderId || order.id || '') : '';
    return {
      id: order.id || null,
      type: order.type || null,
      state: order.state || null,
      price: Number.isFinite(priceValue) ? priceValue : 0,
      size: Number.isFinite(sizeValue) ? sizeValue : 0,
      orderId
    };
  }
}

module.exports = {
  AccountOrders,
  createBotKey
};


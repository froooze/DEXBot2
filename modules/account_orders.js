// Local persistence for per-bot order-grid snapshots and metadata (profiles/orders.json)
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

class AccountOrders {
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

  ensureBotEntries(botEntries = []) {
    if (!Array.isArray(botEntries)) return;
    let changed = false;
    for (const [index, bot] of botEntries.entries()) {
      const key = bot.botKey || createBotKey(bot, index);
      let entry = this.data.bots[key];
      const meta = this._buildMeta(bot, key, index, entry && entry.meta);
      if (!entry) {
        entry = {
          meta,
          grid: [],
          createdAt: meta.createdAt,
          lastUpdated: meta.updatedAt
        };
        this.data.bots[key] = entry;
        changed = true;
      } else {
        entry.grid = entry.grid || [];
        if (this._metaChanged(entry.meta, meta)) {
          entry.meta = { ...entry.meta, ...meta, createdAt: entry.meta?.createdAt || meta.createdAt };
          entry.lastUpdated = nowIso();
          changed = true;
        }
      }
      bot.botKey = key;
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

  storeMasterGrid(botKey, orders = []) {
    if (!botKey) return;
    const snapshot = Array.isArray(orders) ? orders.map(order => this._serializeOrder(order)) : [];
    if (!this.data.bots[botKey]) {
      const meta = this._buildMeta({ name: null, assetA: null, assetB: null, active: false }, botKey, null);
      this.data.bots[botKey] = {
        meta,
        grid: snapshot,
        createdAt: meta.createdAt,
        lastUpdated: meta.updatedAt
      };
    } else {
      this.data.bots[botKey].grid = snapshot;
      const timestamp = nowIso();
      this.data.bots[botKey].lastUpdated = timestamp;
      if (this.data.bots[botKey].meta) this.data.bots[botKey].meta.updatedAt = timestamp;
    }
    this.data.lastUpdated = nowIso();
    this._persist();
  }

  loadBotGrid(botKey) {
    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      return botData.grid || null;
    }
    return null;
  }

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
    const orderId = order.state === ORDER_STATES.ACTIVE ? (order.orderId || order.id || '') : '';
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


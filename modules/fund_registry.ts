
import { getErrorMessage } from './utils/errors.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { getStorage } from './storage/index.js';
import { PATHS } from './paths.js';
import AsyncLock from './order/async_lock.js';
import { acquireFileLock } from '../market_adapter/utils/file_lock.js';
import { isSameBotName } from './utils/sanitize_key.js';
const storage = getStorage();
const { readJSON, writeJSON } = storage;

const REGISTRY_FILE = PATHS.PROFILES.FUND_REGISTRY_JSON;

const _lock = new AsyncLock();

/** Allocation value stored in the registry: a decimal number or a percentage string. */
type PercentageValue = number | string;
type FundSide = 'buy' | 'sell';

interface SideAllocations {
    buy?: PercentageValue;
    sell?: PercentageValue;
}

interface BotAllocationEntry extends SideAllocations {
    /** Per-asset allocations. Sell side is assetA, buy side is assetB. */
    assets?: Record<string, SideAllocations>;
    collateral?: Record<string, PercentageValue>;
}

interface AccountRegistryEntry {
    totalAllocatedPct: { buy: number; sell: number };
    /** Per-asset totals: keyed by asset symbol/id, then side. */
    totalAssetAllocatedPct?: Record<string, { buy: number; sell: number }>;
    totalAllocatedCollateralPct: Record<string, number>;
    bots: Record<string, BotAllocationEntry>;
}

type FundRegistry = Record<string, AccountRegistryEntry>;

interface BotConfigLike {
    active?: boolean;
    creditOnly?: boolean;
    name?: string;
    botKey?: string;
    preferredAccount?: string;
    assetA?: string;
    assetB?: string;
    botFunds?: { buy?: PercentageValue; sell?: PercentageValue };
}

let _registry: FundRegistry | null = null;
let _registryMtimeMs: number | null = null;
let _configBotsCache: BotConfigLike[] | null = null;
let _configBotsKey: string | null = null;

function _statMtimeMs(filePath: string): number | null {
    try {
        const fs = require('node:fs');
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * Parse a percentage value (number, percentage string, or numeric string) to a decimal.
 * Lazy-required from math.ts to avoid a circular module dependency.
 * @param {*} value
 * @returns {number}
 */
function _parsePercentage(value: unknown): number {
    return require('./order/utils/math').toDecimal(value);
}

/**
 * Reject NaN / negative / non-finite allocations before they are persisted.
 * A previous caller passed Number('80%') which produced NaN and was written
 * to JSON as null, silently disabling every shared-account guard.
 */
function _sanitizedPercentage(value: unknown, context: string): number | null {
    const parsed = _parsePercentage(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        console.error(`[fund_registry] Invalid allocation (${JSON.stringify(value)}) for ${context}; registration skipped`);
        return null;
    }
    return parsed;
}

/**
 * Mutations are serialized twice: the in-process AsyncLock for concurrent
 * callers in one process, and a cross-process file lock for PM2 bots that
 * share the same registry file (INV-REG-002).
 */
function _mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    return _lock.acquire(async () => {
        const release = await acquireFileLock(REGISTRY_FILE, { staleMs: 30 * 1000, timeoutMs: 10 * 1000 });
        try {
            return await fn();
        } finally {
            release();
        }
    });
}

function _loadRegistry(): FundRegistry {
    if (_registry !== null) {
        const mtime = _statMtimeMs(REGISTRY_FILE);
        if (mtime !== null && mtime !== _registryMtimeMs) {
            _registry = null;
        }
    }
    if (_registry !== null) return _registry;
    let loaded: FundRegistry;
    try {
        loaded = storage.exists(REGISTRY_FILE)
            ? readJSON<FundRegistry>(REGISTRY_FILE)
            : {};
    } catch (err) {
        console.error(
            `[fund_registry] Failed to load ${REGISTRY_FILE} (${getErrorMessage(err)}); ` +
            `resetting to an empty registry — previously registered bot allocations are unavailable ` +
            `and will be overwritten on the next save. Restore the file from backup before restarting other bots.`
        );
        loaded = {};
    }
    _registry = loaded;
    _registryMtimeMs = _statMtimeMs(REGISTRY_FILE);
    return loaded;
}

function _saveRegistry(): void {
    writeJSON(REGISTRY_FILE, _registry);
    _registryMtimeMs = _statMtimeMs(REGISTRY_FILE);
}

function _ensureAccount(registry: FundRegistry, account: string): AccountRegistryEntry {
    if (!registry[account]) {
        registry[account] = {
            totalAllocatedPct: { buy: 0, sell: 0 },
            totalAssetAllocatedPct: {},
            totalAllocatedCollateralPct: {},
            bots: {}
        };
    } else {
        if (!registry[account].totalAllocatedCollateralPct) {
            registry[account].totalAllocatedCollateralPct = {};
        }
        if (!registry[account].totalAssetAllocatedPct) {
            registry[account].totalAssetAllocatedPct = {};
        }
    }
    return registry[account];
}

function _assetTotals(acc: AccountRegistryEntry, assetKey: string): { buy: number; sell: number } {
    if (!acc.totalAssetAllocatedPct) acc.totalAssetAllocatedPct = {};
    if (!acc.totalAssetAllocatedPct[assetKey]) acc.totalAssetAllocatedPct[assetKey] = { buy: 0, sell: 0 };
    return acc.totalAssetAllocatedPct[assetKey];
}

/** Drop a bot's allocations for a side under old assets after a pair change. */
function _clearOtherAssetAllocations(acc: AccountRegistryEntry, bot: BotAllocationEntry, side: FundSide, keepAssetKey: string): void {
    if (bot.assets) {
        for (const [assetKey, sides] of Object.entries(bot.assets)) {
            if (assetKey === keepAssetKey || sides[side] === undefined) continue;
            const parsed = _parsePercentage(sides[side]);
            const totals = _assetTotals(acc, assetKey);
            totals[side] = Math.max(0, totals[side] - (Number.isFinite(parsed) ? parsed : 0));
            delete sides[side];
            if (Object.keys(sides).length === 0) delete bot.assets[assetKey];
        }
    }
    // A bot that switches to asset-scoped entries must not keep a legacy side.
    if (bot[side] !== undefined) {
        const parsed = _parsePercentage(bot[side]);
        acc.totalAllocatedPct[side] = Math.max(0, acc.totalAllocatedPct[side] - (Number.isFinite(parsed) ? parsed : 0));
        delete bot[side];
    }
}

/** Remove a bot's trade-side entries and subtract them from all side totals. */
function _stripSideAllocations(acc: AccountRegistryEntry, bot: BotAllocationEntry): void {
    for (const side of ['buy', 'sell'] as const) {
        const pct = bot[side];
        if (pct === undefined) continue;
        const parsed = _parsePercentage(pct);
        acc.totalAllocatedPct[side] = Math.max(0, acc.totalAllocatedPct[side] - (Number.isFinite(parsed) ? parsed : 0));
        delete bot[side];
    }
    if (bot.assets) {
        for (const [assetKey, sides] of Object.entries(bot.assets)) {
            const totals = _assetTotals(acc, assetKey);
            for (const side of ['buy', 'sell'] as const) {
                const pct = sides[side];
                if (pct === undefined) continue;
                const parsed = _parsePercentage(pct);
                totals[side] = Math.max(0, totals[side] - (Number.isFinite(parsed) ? parsed : 0));
                delete sides[side];
            }
            if (Object.keys(sides).length === 0) delete bot.assets[assetKey];
        }
        if (Object.keys(bot.assets).length === 0) delete bot.assets;
    }
}

/** Subtract a bot's contributions from all account totals and remove its entry. */
function _removeBotFromAccount(acc: AccountRegistryEntry, botName: string): boolean {
    const bot = acc.bots[botName];
    if (!bot) return false;
    _stripSideAllocations(acc, bot);
    if (bot.collateral) {
        for (const [assetId, pct] of Object.entries(bot.collateral)) {
            const parsed = _parsePercentage(pct);
            acc.totalAllocatedCollateralPct[assetId] = Math.max(
                0,
                (acc.totalAllocatedCollateralPct[assetId] || 0) - (Number.isFinite(parsed) ? parsed : 0)
            );
        }
    }
    delete acc.bots[botName];
    return true;
}

function _rawAllocation(account: string, botName: string, side: FundSide, assetKey?: string): PercentageValue | undefined {
    const acc = _loadRegistry()[account];
    const bot = acc?.bots?.[botName];
    if (!bot) return undefined;
    if (assetKey && bot.assets?.[assetKey] && bot.assets[assetKey][side] !== undefined) {
        return bot.assets[assetKey][side];
    }
    // Legacy entries (no asset key) remain valid for older registry files.
    return bot[side];
}

function _totalsFor(account: string, side: FundSide, assetKey?: string): number {
    const acc = _loadRegistry()[account];
    if (!acc) return 0;
    const raw = assetKey ? acc.totalAssetAllocatedPct?.[assetKey]?.[side] : acc.totalAllocatedPct?.[side];
    return Number.isFinite(raw) ? Number(raw) : 0;
}

/** Active profile entries, cached by mtime (shared-account checks run per recalc). */
function _configBotsSync(): BotConfigLike[] {
    // mtime + size avoids stale reads on filesystems with coarse timestamps.
    let key: string | null = null;
    try {
        const stat = require('node:fs').statSync(PATHS.PROFILES.BOTS_JSON);
        key = `${stat.mtimeMs}:${stat.size}`;
    } catch { /* no profile file */ }
    if (_configBotsCache !== null && key === _configBotsKey) return _configBotsCache;
    try {
        const cfg = storage.exists(PATHS.PROFILES.BOTS_JSON)
            ? readJSON<{ bots?: BotConfigLike[] }>(PATHS.PROFILES.BOTS_JSON)
            : {};
        _configBotsCache = Array.isArray(cfg?.bots) ? cfg.bots : [];
    } catch {
        _configBotsCache = [];
    }
    _configBotsKey = key;
    return _configBotsCache;
}

function _configBotsFor(account: string, side?: FundSide, assetKey?: string): BotConfigLike[] {
    // Credit-only bots register collateral, not trade-side allocations; their
    // seeded botFunds defaults must not dilute a grid bot's side share.
    let bots = _configBotsSync().filter((b) => b.active !== false && b.creditOnly !== true && b.preferredAccount === account);
    if (side && assetKey) {
        bots = bots.filter((b) => String(side === 'buy' ? b.assetB : b.assetA) === assetKey);
    }
    return bots;
}

function _configRawValue(account: string, botName: string, side: FundSide, assetKey?: string): PercentageValue | null {
    const bot = _configBotsFor(account, side, assetKey).find(
        (b) => isSameBotName(b.botKey || b.name, botName)
    );
    const raw = bot?.botFunds?.[side];
    return raw === undefined || raw === null ? null : raw;
}

/**
 * Percentage of an account side belonging to one bot, derived from bots.json
 * when the registry is missing or only partially populated (staggered PM2
 * startup). This keeps invariant and allocation paths consistent with the
 * shared-account detection fallback.
 */
function _configShareSync(account: string, botName: string, side: FundSide, assetKey?: string): number | null {
    let mine: number | null = null;
    let total = 0;
    for (const b of _configBotsFor(account, side, assetKey)) {
        const raw = b.botFunds?.[side];
        if (raw === undefined || raw === null) continue;
        const pct = _parsePercentage(raw);
        if (!Number.isFinite(pct) || pct < 0) continue;
        total += pct;
        if (isSameBotName(b.botKey || b.name, botName)) mine = pct;
    }
    if (mine === null || total <= 0) return null;
    const share = mine / total;
    return Number.isFinite(share) && share >= 0 && share <= 1 ? share : null;
}

/** Side-level sharing: a collateral-only sibling must not change a grid bot's cap. */
function _sideShared(account: string, side: FundSide, assetKey?: string): boolean {
    const configCount = _configBotsFor(account, side, assetKey).filter(
        (b) => b.botFunds?.[side] !== undefined && b.botFunds?.[side] !== null
    ).length;
    return configCount > 1 || _registeredBotCountForSide(account, side, assetKey) > 1;
}

/** True when fewer bots are registered than the active profile declares for this side/asset. */
function _registryIncomplete(account: string, side: FundSide, assetKey?: string): boolean {
    const configCount = _configBotsFor(account, side, assetKey).filter(
        (b) => b.botFunds?.[side] !== undefined && b.botFunds?.[side] !== null
    ).length;
    return configCount > _registeredBotCountForSide(account, side, assetKey);
}

/** Number of bots registered for one account side/asset. */
function _registeredBotCountForSide(account: string, side: FundSide, assetKey?: string): number {
    const acc = _loadRegistry()[account];
    if (!acc) return 0;
    return Object.values(acc.bots).filter((bot) => (
        assetKey ? bot.assets?.[assetKey]?.[side] !== undefined : bot[side] !== undefined
    )).length;
}

/**
 * Register a bot's allocation on an account for a given side.
 * When assetKey is supplied the allocation is scoped to that asset (sell uses
 * assetA, buy uses assetB), so two bots selling different assets do not split
 * each other's funds. Called during bot startup.
 */
async function registerAllocation(account: string, botName: string, side: FundSide, percentage: PercentageValue, assetKey?: string): Promise<void> {
    return _mutate(async () => {
        const normalized = _sanitizedPercentage(percentage, `${account}/${botName}/${side}${assetKey ? ` (${assetKey})` : ''}`);
        if (normalized === null) return;
        const registry = _loadRegistry();
        const acc = _ensureAccount(registry, account);
        const bot = acc.bots[botName] || (acc.bots[botName] = {});
        if (assetKey) _clearOtherAssetAllocations(acc, bot, side, assetKey);
        const totals = assetKey ? _assetTotals(acc, assetKey) : acc.totalAllocatedPct;
        const store: SideAllocations = assetKey
            ? (bot.assets || (bot.assets = {}))[assetKey] || ((bot.assets[assetKey] = {}))
            : bot;
        const existing = store[side];
        if (existing !== undefined) {
            const previous = _parsePercentage(existing);
            totals[side] = Math.max(0, totals[side] - (Number.isFinite(previous) ? previous : 0));
        }
        store[side] = percentage;
        totals[side] = totals[side] + normalized;
        _saveRegistry();
    });
}

/**
 * Register a credit bot's collateral allocation on an account for a given collateral asset.
 */
async function registerCollateralAllocation(account: string, botName: string, collateralAssetId: string, percentage: PercentageValue): Promise<void> {
    return _mutate(async () => {
        const normalized = _sanitizedPercentage(percentage, `${account}/${botName}/collateral/${collateralAssetId}`);
        if (normalized === null) return;
        const registry = _loadRegistry();
        const acc = _ensureAccount(registry, account);
        const bot = acc.bots[botName] || (acc.bots[botName] = {});
        bot.collateral || (bot.collateral = {});
        const existingPct = bot.collateral[collateralAssetId];
        if (existingPct !== undefined) {
            const prevDecimal = _parsePercentage(existingPct);
            acc.totalAllocatedCollateralPct[collateralAssetId] = Math.max(
                0,
                (acc.totalAllocatedCollateralPct[collateralAssetId] || 0) - (Number.isFinite(prevDecimal) ? prevDecimal : 0)
            );
        }
        bot.collateral[collateralAssetId] = percentage;
        acc.totalAllocatedCollateralPct[collateralAssetId] = (acc.totalAllocatedCollateralPct[collateralAssetId] || 0) + normalized;
        _saveRegistry();
    });
}

/**
 * Get the effective collateral allocation for a credit bot on a given account/collateral asset.
 * Returns chainTotal * (myPercent / sum(allPercentages)).
 * Synchronous — operates on in-memory cache.
 * Returns null if no registry entry exists (caller falls back to direct balance resolution).
 */
function getEffectiveCollateralAllocationSync(account: string, botName: string, collateralAssetId: string, chainTotal: number): number | null {
    const registry = _loadRegistry();
    const acc = registry[account];
    const raw = acc?.bots?.[botName]?.collateral?.[collateralAssetId];
    if (raw === undefined) return null;
    const myPct = _parsePercentage(raw);
    const totalPct = acc.totalAllocatedCollateralPct[collateralAssetId] || 0;
    if (!Number.isFinite(myPct) || myPct < 0 || !Number.isFinite(totalPct) || totalPct <= 0) return null;
    if (myPct === 0) return 0;
    return chainTotal * (myPct / totalPct);
}

/**
 * Get the effective allocation for a bot on a given account side.
 * Returns chainTotal * (myPercent / sum(allPercentages)).
 * Synchronous — operates on in-memory cache.
 * Returns null if no registry entry exists (caller falls back to resolveConfigValue).
 * An explicitly registered 0% returns 0 (not null) so the caller can cap to zero.
 */
function getEffectiveAllocationSync(account: string, botName: string, side: FundSide, chainTotal: number, assetKey?: string): number | null {
    const raw = _rawAllocation(account, botName, side, assetKey);
    const shared = _sideShared(account, side, assetKey);
    if (!shared) {
        // Solo bots keep their configured percentage (or absolute budget).
        // Normalizing a single registered bot to 1 would hand it the account.
        const soloRaw = raw === undefined || raw === null ? _configRawValue(account, botName, side, assetKey) : raw;
        if (soloRaw === null) return null;
        return require('./order/utils/math').resolveConfigValue(soloRaw, chainTotal);
    }
    if (shared && _registryIncomplete(account, side, assetKey)) {
        const configShare = _configShareSync(account, botName, side, assetKey);
        if (configShare !== null) return chainTotal * configShare;
    }
    if (raw === undefined || raw === null) {
        const configShare = _configShareSync(account, botName, side, assetKey);
        return configShare === null ? null : chainTotal * configShare;
    }
    const myPct = _parsePercentage(raw);
    // Legacy files have a side value but no asset-specific total. Fall back to
    // the legacy account total in that case; an asset-scoped entry always uses
    // its own asset total.
    const acc = _loadRegistry()[account];
    const assetScoped = assetKey !== undefined && acc?.bots?.[botName]?.assets?.[assetKey]?.[side] !== undefined;
    const totalPct = assetScoped ? _totalsFor(account, side, assetKey) : _totalsFor(account, side);
    if (!Number.isFinite(myPct) || myPct < 0) return null;
    // An explicit zero is a valid allocation even when the total is zero.
    if (myPct === 0) return 0;
    if (totalPct <= 0) {
        const configShare = _configShareSync(account, botName, side, assetKey);
        return configShare === null ? null : chainTotal * configShare;
    }
    return chainTotal * (myPct / totalPct);
}

/** Get the total allocated percentage for an account side (optionally per asset). */
function getTotalAllocatedPct(account: string, side: FundSide, assetKey?: string): number {
    return _totalsFor(account, side, assetKey);
}

/**
 * Get the raw percentage for a bot's allocation on a side.
 * Returns null for missing/corrupt values; a valid explicit 0% returns 0.
 */
function getBotAllocationPct(account: string, botName: string, side: FundSide, assetKey?: string): number | null {
    const raw = _rawAllocation(account, botName, side, assetKey);
    if (raw === undefined || raw === null) return null;
    const parsed = _parsePercentage(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Bot's proportional share of an account side, in [0, 1].
 * Returns 1 when the account/bot is not registered (single-bot behavior), so
 * existing single-account invariants are unchanged.
 */
function getBotShareSync(account: string | undefined, botName: string | undefined, side: FundSide, assetKey?: string): number {
    if (!account || !botName) return 1;
    const myPct = getBotAllocationPct(account, botName, side, assetKey);
    if (myPct === 0) return 0;

    // A partially populated registry (staggered PM2 start, crashed sibling)
    // would normalize to 1 and re-create the false-drift spiral. Whenever
    // fewer bots are registered than the profile declares for this side,
    // derive the share from bots.json instead.
    if (_registryIncomplete(account, side, assetKey)) {
        const configShare = _configShareSync(account, botName, side, assetKey);
        if (configShare !== null) return configShare;
    }

    const acc = _loadRegistry()[account];
    const assetScoped = assetKey !== undefined && acc?.bots?.[botName]?.assets?.[assetKey]?.[side] !== undefined;
    const totalPct = assetScoped ? getTotalAllocatedPct(account, side, assetKey) : getTotalAllocatedPct(account, side);
    if (myPct !== null && Number.isFinite(totalPct) && totalPct > 0) {
        const share = myPct / totalPct;
        if (Number.isFinite(share) && share >= 0 && share <= 1) return share;
    }
    return _configShareSync(account, botName, side, assetKey) ?? 1;
}

/**
 * Release all allocations for a bot on an account.
 * Called during bot shutdown.
 */
async function releaseAllocation(account: string, botName: string): Promise<void> {
    return _mutate(async () => {
        const registry = _loadRegistry();
        const acc = registry[account];
        if (!acc || !_removeBotFromAccount(acc, botName)) return;
        if (Object.keys(acc.bots).length === 0) {
            delete registry[account];
        }
        _saveRegistry();
    });
}

/**
 * Upgrade cleanup: remove side allocations written by the old launcher for a
 * credit-only bot, keeping its collateral and registry entry intact.
 */
async function clearSideAllocations(account: string, botName: string): Promise<void> {
    return _mutate(async () => {
        const registry = _loadRegistry();
        const acc = registry[account];
        const bot = acc?.bots?.[botName];
        if (!bot) return;
        _stripSideAllocations(acc, bot);
        _saveRegistry();
    });
}

/**
 * Shutdown-safe release: when siblings are still registered on the account,
 * keep this bot's allocation so their proportional shares do not jump (and so
 * an explicit re-registration on restart is idempotent).
 * Returns true if an entry was actually released.
 */
async function releaseAllocationOnShutdown(account: string, botName: string): Promise<boolean> {
    return _mutate(async () => {
        const acc = _loadRegistry()[account];
        if (!acc?.bots?.[botName]) return false;
        if (Object.keys(acc.bots).length > 1) return false;
        const registry = _loadRegistry();
        if (!_removeBotFromAccount(acc, botName)) return false;
        if (Object.keys(acc.bots).length === 0) delete registry[account];
        _saveRegistry();
        return true;
    });
}

/**
 * Remove registry entries for bots that are no longer active. Called at
 * startup with the active bot keys so crashed/removed bots cannot keep
 * inflating the account totals and shrinking surviving bots' shares.
 * Returns the number of pruned entries.
 */
async function pruneAccount(account: string, activeBotKeys: string[]): Promise<number> {
    return _mutate(async () => {
        const registry = _loadRegistry();
        const acc = registry[account];
        if (!acc) return 0;
        const active = new Set(activeBotKeys.filter(Boolean));
        // A launcher may start a subset of bots (single-bot restart, `dexbot
        // start <bot>`). Never delete a sibling that is still active in the
        // profile just because it is not in this launch's key set.
        const configActive = _configBotsSync().filter(
            (b) => b.active !== false && b.preferredAccount === account
        );
        let pruned = 0;
        for (const name of Object.keys(acc.bots)) {
            const stillConfigured = configActive.some((b) => isSameBotName(b.botKey || b.name, name));
            if (!active.has(name) && !stillConfigured && _removeBotFromAccount(acc, name)) {
                pruned += 1;
            }
        }
        if (Object.keys(acc.bots).length === 0) delete registry[account];
        if (pruned > 0) _saveRegistry();
        return pruned;
    });
}

/** Get names of all registered bots on an account. */
function getRegisteredBots(account: string): string[] {
    const acc = _loadRegistry()[account];
    if (!acc) return [];
    return Object.keys(acc.bots);
}

/**
 * Check if multiple bots share the same account.
 * The registry is the primary source; bots.json is a fallback because a failed
 * registry load resets it to empty and would otherwise drop the shared-account
 * fetch cadence from 5 minutes back to the 240-minute default.
 */
function _accountConfigBots(account: string): BotConfigLike[] {
    return _configBotsSync().filter((b) => b.active !== false && b.preferredAccount === account);
}

function isSharedAccount(account: string): boolean {
    if (getRegisteredBots(account).length > 1) return true;
    // Account-level sharing includes credit-only bots: it drives fetch cadence,
    // heal guard and invariant mode. Side-level sharing deliberately excludes
    // them (see _configBotsFor / _sideShared).
    return _accountConfigBots(account).length > 1;
}

/** Accounts with registry entries (used to prune entries after a split). */
function getRegisteredAccounts(): string[] {
    return Object.keys(_loadRegistry());
}

/** Reset the registry file (for testing/setup only; intentionally bypasses
 * the cross-process lock so tests can set up fixtures synchronously). */
function resetRegistry(): void {
    _registry = {};
    // Test-only: clear profile-derived caches too so rewritten fixtures are seen.
    _configBotsCache = null;
    _configBotsKey = null;
    _saveRegistry();
}

export {
    registerAllocation,
    registerCollateralAllocation,
    releaseAllocation,
    releaseAllocationOnShutdown,
    clearSideAllocations,
    pruneAccount,
    getEffectiveAllocationSync,
    getEffectiveCollateralAllocationSync,
    getTotalAllocatedPct,
    getBotAllocationPct,
    getBotShareSync,
    getRegisteredBots,
    getRegisteredAccounts,
    isSharedAccount,
    resetRegistry
};

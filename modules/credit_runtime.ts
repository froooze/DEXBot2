'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { path } from './path_api.js';
import { getStorage } from './storage/index.js';
import * as client from './bitshares_client.js';
const { BitShares, waitForConnected } = client;
import * as chainOrders from './chain_orders.js';
import { blockchainToFloat, floatToBlockchainInt, floorToBlockchainInt, resolveConfigValue, isPercentageString, parsePercentageString, roundToDecimals } from './order/utils/math.js';
import { toFiniteNumber } from './order/format.js';
import { createBotKey } from './account_orders.js';
import * as fundRegistry from './fund_registry.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import { resolveAssetByRef, nowIso } from './order/utils/system.js';
import { normalizeAssetRef } from './utils/asset_symbols.js';
import { FEE_PARAMETERS, DEFAULT_TARGET_CR, TIMING, NATIVE_CLIENT } from './constants.js';
import { PATHS } from './paths.js';
import {
    deriveLiquidityPoolTokenValue,
    derivePriceWithBridges,
    ensureDir as ensureDirSync,
} from './order/utils/system.js';

const storage = getStorage();
import {
    buildCollateralFallbackPlan,
    buildDebtFirstCrPlan,
    positiveOrNull,
    resolveMinCollateralIncreaseThreshold,
    resolveTargetCollateralRatio,
} from './cr_planner.js';
import {
    borrowAmountForCollateral as sharedBorrowAmountForCollateral,
    capBorrowToCollateral as sharedCapBorrowToCollateral,
    collateralValueFromOfferPrice as sharedCollateralValueFromOfferPrice,
    creditDealFee as sharedCreditDealFee,
    dailyOfferFeeRate as sharedDailyOfferFeeRate,
    extractOfferConversionRate as sharedExtractOfferConversionRate,
    normalizeCollateralMap,
    requiredCollateralForBorrow as sharedRequiredCollateralForBorrow,
} from './credit_pricing.js';
import { getErrorMessage, resolveSeamMsOrNull } from './utils/errors.js';
import type {BotLike, GridConfig, LogFn, UnknownRecord} from './types.js';

const CREDIT_FEE_RATE_DENOM = FEE_PARAMETERS.GRAPHENE_FEE_RATE_DENOM;
const ZERO_ASSET_ID = NATIVE_CLIENT.CHAIN.CORE_ASSET_ID;
const DEFAULT_STATE_DIR = PATHS.CREDIT_RUNTIME_DIR;
const GRAPHENE_COLLATERAL_RATIO_DENOM = FEE_PARAMETERS.GRAPHENE_COLLATERAL_RATIO_DENOM;
// Raw debt-asset units kept unspent by a renewal repay, so the repay still fits
// if the free balance drifts by a tick between the balance read and broadcast.
// The on-chain repay fee is exact, so without this the sizing can land precisely
// on the free balance and any one-unit drift would fail the whole batch.
const CREDIT_REBORROW_FREE_BALANCE_BUFFER_INT = 1;


function deepClone<T>(value: T): T {
    return value === undefined ? undefined as T : JSON.parse(JSON.stringify(value)) as T;
}

function normalizeResolvedPriceResult(value: unknown, liveSource: unknown, missingSource: unknown): { price: number | null; source: unknown } {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const v = value as { price?: unknown; source?: unknown };
        const price = positiveOrNull(v.price);
        return {
            price,
            source: price !== null
                ? (typeof v.source === 'string' && v.source ? v.source : liveSource)
                : missingSource,
        };
    }
    const price = positiveOrNull(value);
    return {
        price,
        source: price !== null ? liveSource : missingSource,
    };
}

function positiveOrPercentOrNull(value: unknown): number | null {
    const numeric = positiveOrNull(value);
    if (numeric !== null) return numeric;
    if (!isPercentageString(value)) return null;
    const parsed = parsePercentageString(value);
    return parsed !== null && parsed > 0 ? parsed : null;
}

function normalizeNumberArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((item) => String(item)).filter(Boolean)
        : [];
}

function toGrapheneCollateralRatio(value: unknown): number | null {
    const numeric = positiveOrNull(value);
    if (numeric === null) return null;
    const scaled = Math.round(numeric * GRAPHENE_COLLATERAL_RATIO_DENOM);
    return Number.isInteger(scaled) && scaled > 0 && scaled <= 0xffff ? scaled : null;
}

function getPriceQuoteAssetId(price: unknown): string | null {
    const p = price as { quote?: { asset_id?: string } } | null | undefined;
    return p?.quote?.asset_id || null;
}

function toAmountObject(amount: number, assetId: string): { amount: number; asset_id: string } {
    return {
        amount,
        asset_id: assetId,
    };
}

function getChainAmountValue(value: unknown): number {
    if (value && typeof value === 'object' && (value as { amount?: unknown }).amount !== undefined) {
        return toFiniteNumber((value as { amount?: unknown }).amount, undefined);
    }
    return toFiniteNumber(value, undefined);
}

function getAssetPrecision(asset: unknown): number | null {
    const precision = Number((asset as { precision?: unknown } | null | undefined)?.precision);
    return Number.isFinite(precision) ? precision : null;
}

function blockchainAmountToFloat(value: unknown, asset: unknown): number | null {
    const amount = getChainAmountValue(value);
    const precision = getAssetPrecision(asset);
    if (!Number.isFinite(amount) || precision === null) {
        return null;
    }
    return blockchainToFloat(amount, precision);
}

function isDeterministicMpaDebtBalanceError(err: unknown, plan: unknown): boolean {
    const debtDelta = toFiniteNumber((plan as { debtDelta?: unknown } | null | undefined)?.debtDelta, 0);
    if (!Number.isFinite(debtDelta) || debtDelta >= 0) {
        return false;
    }
    const message = String((err as { message?: unknown } | null | undefined)?.message || err || '').toLowerCase();
    return message.includes('insufficient')
        && (message.includes('balance') || message.includes('fund') || message.includes('mpa'));
}

function isMaxBorrowAmountError(err: unknown): boolean {
    const message = String((err as { message?: unknown } | null | undefined)?.message || err || '');
    return /would exceed maxBorrowAmount/.test(message) || /exceeds maxBorrowAmountPerOperation/.test(message);
}

function resolveAutoRepayValue(value: unknown): number {
    if (value === true) return 1;
    if (value === false || value === null || value === undefined) return 0;
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const int = Math.trunc(num);
    if (int < 0) return 0;
    if (int > 2) return 2;
    return int;
}

function normalizeAmountSpec(spec: unknown): { amount: unknown; assetId: unknown } | null {
    if (spec === null || spec === undefined) return null;
    if (typeof spec === 'number' || typeof spec === 'string') {
        return { amount: spec, assetId: null };
    }
    if (typeof spec === 'object') {
        const s = spec as { amount?: unknown; value?: unknown; asset_id?: unknown; assetId?: unknown; asset?: unknown };
        return {
            amount: s.amount ?? s.value ?? null,
            assetId: s.asset_id || s.assetId || s.asset || null,
        };
    }
    return null;
}

function isPercentageAmountSpec(spec: unknown): boolean {
    const normalized = normalizeAmountSpec(spec);
    return typeof normalized?.amount === 'string' && normalized.amount.trim().endsWith('%');
}

/**
 * Whether a credit-offer policy should top a renewal's collateral budget up from
 * the borrower's free balance. Default `true`; only an explicit `false` opts out.
 */
function resolveUseFreeCollateral(policy: UnknownRecord | null | undefined): boolean {
    return policy?.useFreeCollateral !== false;
}

function getAccountRef(bot: BotLike): string | null {
    return bot?.accountId
        || (bot?.account as unknown as { id?: string; name?: string } | null)?.id
        || (bot?.account as unknown as { id?: string; name?: string } | null)?.name
        || bot?.config?.preferredAccount
        || null;
}

/** Registry-key account name only — never accountId (the registry is keyed by name). */
function getAccountName(bot: BotLike): string | null {
    return bot?.config?.preferredAccount
        || (bot?.account as unknown as { id?: string; name?: string } | null)?.name
        || null;
}

function snakeToCamel(method: unknown): string {
    return String(method || '').replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseFullAccount(fullAccountResult: unknown): unknown {
    if (!Array.isArray(fullAccountResult) || fullAccountResult.length === 0) return null;
    const entry = fullAccountResult[0];
    if (Array.isArray(entry) && entry.length >= 2) {
        return entry[1] || null;
    }
    return entry || null;
}

function parseCallOrders(accountObj: unknown): unknown[] {
    if (!accountObj || typeof accountObj !== 'object') return [];
    const obj = accountObj as { call_orders?: unknown; account?: { call_orders?: unknown } };
    if (Array.isArray(obj.call_orders)) return obj.call_orders;
    if (obj.account && Array.isArray(obj.account.call_orders)) return obj.account.call_orders;
    return [];
}

interface DebtAssetSnapshot {
    assetId: string;
    mpaDebt: number;
    mpaCollateral: number;
    creditDebt: number;
    creditCollateral: number;
    offeredBalance: number;
    totalDebt: number;
    totalCollateral: number;
    [key: string]: unknown;
}

interface DebtSnapshot {
    assets: Record<string, DebtAssetSnapshot>;
    mpaCallOrders: unknown[];
    creditDeals: unknown[];
    ownedCreditOffers: unknown[];
    [key: string]: unknown;
}

type DebtBumpField = 'mpaDebt' | 'mpaCollateral' | 'creditDebt' | 'creditCollateral' | 'offeredBalance';

interface FallbackOfferCandidate extends UnknownRecord {
    offer: UnknownRecord;
    op: unknown;
    dailyRate: number;
    feeRate: number;
    balance: number;
    duration: number;
}

interface IncreaseOfferCandidate extends FallbackOfferCandidate {
    borrowAmount: number;
    collateralAmount: number;
    capped: boolean;
}

/**
 * Shared ranking fields for a credit-offer candidate. Every selector scores
 * offers through this helper so the ranking inputs cannot drift apart.
 */
function offerRankingFields(
    dailyRate: number,
    offer: UnknownRecord,
): Pick<FallbackOfferCandidate, 'dailyRate' | 'feeRate' | 'balance' | 'duration'> {
    return {
        dailyRate,
        feeRate: toFiniteNumber(offer.fee_rate, Number.MAX_SAFE_INTEGER),
        balance: toFiniteNumber(offer.current_balance, 0),
        duration: toFiniteNumber(offer.max_duration_seconds, 0),
    };
}

/**
 * Canonical credit-offer ranking policy: cheapest daily rate first, then the
 * lowest fee rate, then the longest duration, then the largest remaining
 * balance, then a stable tie-break on offer id. Single source of truth for
 * all offer selectors.
 */
function compareCreditOfferCandidates(a: FallbackOfferCandidate, b: FallbackOfferCandidate): number {
    return a.dailyRate - b.dailyRate
        || a.feeRate - b.feeRate
        || b.duration - a.duration
        || b.balance - a.balance
        || String(a.offer.id).localeCompare(String(b.offer.id));
}

interface DealSummary {
    id: unknown;
    borrower: unknown;
    offerId: unknown;
    offerOwner: unknown;
    debtAssetId: unknown;
    debtAmount: number;
    collateralAssetId: unknown;
    collateralAmount: number;
    feeRate: number;
    latestRepayTime: unknown;
    autoRepay: number;
}

function parseDealSummary(deal: unknown): DealSummary | null {
    if (!deal || typeof deal !== 'object') return null;
    const d = deal as {
        id?: unknown; borrower?: unknown; offerId?: unknown; offer_id?: unknown;
        offerOwner?: unknown; offer_owner?: unknown; debtAssetId?: unknown; debt_asset?: unknown;
        debtAmount?: unknown; debt_amount?: unknown; collateralAssetId?: unknown; collateral_asset?: unknown;
        collateralAmount?: unknown; collateral_amount?: unknown; feeRate?: unknown; fee_rate?: unknown;
        latestRepayTime?: unknown; latest_repay_time?: unknown; autoRepay?: unknown; auto_repay?: unknown;
    };
    return {
        id: d.id,
        borrower: d.borrower,
        offerId: d.offerId || d.offer_id || null,
        offerOwner: d.offerOwner || d.offer_owner || null,
        debtAssetId: d.debtAssetId || d.debt_asset || null,
        debtAmount: toFiniteNumber(d.debtAmount ?? d.debt_amount, 0) || 0,
        collateralAssetId: d.collateralAssetId || d.collateral_asset || null,
        collateralAmount: toFiniteNumber(d.collateralAmount ?? d.collateral_amount, 0) || 0,
        feeRate: toFiniteNumber(d.feeRate ?? d.fee_rate, 0) || 0,
        latestRepayTime: d.latestRepayTime || d.latest_repay_time || null,
        autoRepay: toFiniteNumber(d.autoRepay ?? d.auto_repay, 0) || 0,
    };
}

interface CallOrderSummary {
    id: unknown;
    borrower: unknown;
    debtAssetId: unknown;
    debtAmount: number;
    collateralAssetId: unknown;
    collateralAmount: number;
    debt: { amount?: unknown } | null;
    collateral: { amount?: unknown } | null;
    call_price: { quote?: { asset_id?: unknown }; base?: { asset_id?: unknown } } | null;
}

function parseCallOrderSummary(order: unknown): CallOrderSummary | null {
    if (!order || typeof order !== 'object') return null;
    const o = order as {
        id?: unknown; borrower?: unknown; debtAssetId?: unknown; debtAmount?: unknown;
        collateralAssetId?: unknown; collateralAmount?: unknown; debt?: { amount?: unknown };
        collateral?: { amount?: unknown }; call_price?: { quote?: { asset_id?: unknown }; base?: { asset_id?: unknown } };
    };
    return {
        id: o.id || null,
        borrower: o.borrower || null,
        debtAssetId: o.debtAssetId || o.call_price?.quote?.asset_id || null,
        debtAmount: toFiniteNumber(o.debt?.amount ?? o.debtAmount, 0) || 0,
        collateralAssetId: o.collateralAssetId || o.call_price?.base?.asset_id || null,
        collateralAmount: toFiniteNumber(o.collateral?.amount ?? o.collateralAmount, 0) || 0,
        debt: o.debt || null,
        collateral: o.collateral || null,
        call_price: o.call_price || null,
    };
}

interface CreditOfferSummary {
    id: unknown;
    ownerAccount: unknown;
    assetType: unknown;
    totalBalance: number;
    currentBalance: number;
    feeRate: number;
    maxDurationSeconds: number;
    minDealAmount: number;
    enabled: boolean;
    acceptableCollateral: unknown;
}

function parseCreditOfferSummary(offer: unknown): CreditOfferSummary | null {
    if (!offer || typeof offer !== 'object') return null;
    const o = offer as {
        id?: unknown; owner_account?: unknown; ownerAccount?: unknown; asset_type?: unknown; assetType?: unknown;
        total_balance?: unknown; totalBalance?: unknown; current_balance?: unknown; currentBalance?: unknown;
        fee_rate?: unknown; feeRate?: unknown; max_duration_seconds?: unknown; maxDurationSeconds?: unknown;
        min_deal_amount?: unknown; minDealAmount?: unknown; enabled?: unknown;
        acceptable_collateral?: unknown; acceptableCollateral?: unknown;
    };
    return {
        id: o.id || null,
        ownerAccount: o.owner_account || o.ownerAccount || null,
        assetType: o.asset_type || o.assetType || null,
        totalBalance: toFiniteNumber(o.total_balance ?? o.totalBalance, 0) || 0,
        currentBalance: toFiniteNumber(o.current_balance ?? o.currentBalance, 0) || 0,
        feeRate: toFiniteNumber(o.fee_rate ?? o.feeRate, 0) || 0,
        maxDurationSeconds: toFiniteNumber(o.max_duration_seconds ?? o.maxDurationSeconds, 0) || 0,
        minDealAmount: toFiniteNumber(o.min_deal_amount ?? o.minDealAmount, 0) || 0,
        enabled: !!o.enabled,
        acceptableCollateral: o.acceptable_collateral || o.acceptableCollateral || null,
    };
}

/** A configured lending item (MPA or credit-offer policy). */
interface LendingItem extends UnknownRecord {
    type?: string;
    asset?: unknown;
    collateralAsset?: unknown;
    collateralAssetId?: unknown;
    minCollateralRatio?: number;
    maxCollateralRatio?: number;
    targetCollateralRatio?: number;
    maxBorrowAmount?: number;
    maxBorrowAmountPerOperation?: number;
    maxCollateralAmount?: number | string;
    minCollateralIncreaseThreshold?: number;
    debtOnly?: boolean;
    autoRepay?: boolean;
    autoReborrow?: boolean;
    disallowedDealIds?: unknown;
}

/** The `config.debtPolicy` surface. */
interface DebtPolicy extends UnknownRecord {
    lending: LendingItem[];
}

/** Persisted per-position credit-runtime state. */
interface PositionState extends UnknownRecord {
    currentCollateralAmount?: number;
    currentDebtAmount?: number;
    feedPrice?: number;
    assignedCollateralBudget?: number;
    currentCollateralFundsTotal?: number;
    creditDeals?: UnknownRecord[];
    lastCreditIncrease?: UnknownRecord;
    lastMpaAction?: UnknownRecord;
    mpaSelectionConflict?: unknown;
}

interface CreditState extends UnknownRecord {
    positions: Record<string, PositionState>;
    pendingReborrows: UnknownRecord[];
    activeDealIds: unknown[];
    activeOfferIds: unknown[];
    mpaCallOrders: unknown[];
    ownedCreditOffers: Record<string, unknown>[];
    creditDeals: Record<string, unknown>[];
    reborrowPending: boolean;
    botKey: string;
}

class CreditRuntime {
    bot: BotLike;
    config: GridConfig;
    options: { stateDir?: string; [key: string]: unknown };
    log: LogFn;
    warn: LogFn;
    botKey: string;
    _getOnChainAssetBalancesFn?: typeof chainOrders.getOnChainAssetBalances | null;
    _lastResolvedSettleDelayMs?: number;
    stateDir: string;
    statePath: string;
    _assetCache: Map<string, Record<string, unknown>>;
    _objectCache: Map<string, Record<string, unknown>>;
    _fullAccountCache: { ref?: unknown; account: UnknownRecord | null } | null;
    _borrowerDealsCache: DealSummary[] | null;
    state: CreditState;
    _loaded: boolean;
    _maintenanceInFlight: boolean;
    _watchdogInFlight: boolean;
    _reborrowsInFlight: boolean;
    _splitInFlight: boolean;

    constructor(bot: BotLike, options: { stateDir?: string; [key: string]: unknown } = {}) {
        this.bot = bot || {};
        this.config = this.bot.config || {};
        this.options = options || {};
        this.log = typeof this.bot._log === 'function' ? this.bot._log.bind(this.bot) : console.log.bind(console);
        this.warn = typeof this.bot._warn === 'function' ? this.bot._warn.bind(this.bot) : console.warn.bind(console);

        this.botKey = this.config.botKey
            || createBotKey(this.config, Number(this.config.botIndex ?? 0));
        this.stateDir = this.options.stateDir || DEFAULT_STATE_DIR;
        this.statePath = path.join(this.stateDir, `${this.botKey}.json`);
        this._assetCache = new Map();
        this._objectCache = new Map();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        this.state = this._createDefaultState();
        this._loaded = false;
        this._maintenanceInFlight = false;
        this._watchdogInFlight = false;
        this._reborrowsInFlight = false;
        this._splitInFlight = false;
    }

    _createDefaultState(): CreditState {
        return {
            botKey: this.botKey,
            updatedAt: null,
            mpaCallOrders: [],
            activeDealIds: [],
            activeOfferIds: [],
            ownedCreditOffers: [],
            creditDeals: [],
            debtSnapshot: null,
            lastBorrowRequest: null,
            lastRepayAt: null,
            lastGridResetAt: null,
            lastCrAdjustment: null,
            reborrowPending: false,
            pendingReborrows: [],
            positions: {}, // debtAssetId -> positionState
        };
    }

    get debtPolicy(): DebtPolicy | null {
        const dp = this.config?.debtPolicy;
        return dp && typeof dp === 'object' ? dp as DebtPolicy : null;
    }

    isEnabled() {
        const dp = this.debtPolicy;
        if (!dp) return false;
        if (!Array.isArray(dp.lending) || dp.lending.length === 0) return false;
        return dp.lending.every((item: Record<string, unknown>) =>
            typeof item.collateralAsset === 'string' && item.collateralAsset.length > 0
        );
    }

    _positionKey(debtAssetId: unknown, collateralAssetId: unknown): string {
        return `${debtAssetId}:${collateralAssetId}`;
    }

    async _findLendingItemForAsset(assetId: unknown, typeFilter: unknown): Promise<UnknownRecord | null> {
        if (!assetId || !this.debtPolicy?.lending) return null;
        for (const item of (this.debtPolicy.lending as UnknownRecord[])) {
            if (typeFilter && item.type !== typeFilter) continue;
            let cached = this._assetCache.get(String(item.asset));
            if (!cached && item.asset) {
                cached = (await this._resolveAsset(item.asset)) ?? undefined;
            }
            if (cached && String(cached.id) === String(assetId)) {
                return item;
            }
        }
        return null;
    }

    _stateWithDefaults(state: unknown = {}): CreditState {
        const merged = { ...this._createDefaultState(), ...deepClone(state || {}) } as CreditState;
        merged.activeDealIds = Array.isArray(merged.activeDealIds) ? merged.activeDealIds : [];
        merged.activeOfferIds = Array.isArray(merged.activeOfferIds) ? merged.activeOfferIds : [];
        merged.mpaCallOrders = Array.isArray(merged.mpaCallOrders) ? merged.mpaCallOrders : [];
        merged.ownedCreditOffers = Array.isArray(merged.ownedCreditOffers) ? merged.ownedCreditOffers : [];
        merged.creditDeals = Array.isArray(merged.creditDeals) ? merged.creditDeals : [];
        merged.pendingReborrows = Array.isArray(merged.pendingReborrows) ? merged.pendingReborrows : [];
        merged.reborrowPending = merged.pendingReborrows.length > 0 || !!merged.reborrowPending;
        merged.botKey = merged.botKey || this.botKey;
        merged.positions = merged.positions && typeof merged.positions === 'object' ? merged.positions : {};
        return merged;
    }

    async loadState({ forceReload = false }: { forceReload?: boolean } = {}): Promise<unknown> {
        if (this._loaded && !forceReload) {
            return this.state;
        }

        ensureDirSync(this.stateDir);
        if (!storage.exists(this.statePath)) {
            this.state = this._stateWithDefaults();
            this._loaded = true;
            return this.state;
        }

        try {
            const parsed = storage.readJSON(this.statePath);
            this.state = this._stateWithDefaults(parsed);
        } catch (err) {
            this.warn(`credit runtime: failed to load ${this.statePath}: ${getErrorMessage(err)}`);
            this.state = this._stateWithDefaults();
        }

        this._loaded = true;
        return this.state;
    }

    async persistState(reason: unknown = 'update'): Promise<unknown> {
        ensureDirSync(this.stateDir);
        this.state.updatedAt = nowIso();
        this.state.botKey = this.botKey;
        this.state.reborrowPending = Array.isArray(this.state.pendingReborrows) && this.state.pendingReborrows.length > 0;

        // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A plain
        // writeFileSync here could leave a truncated state file on crash and
        // cause the next process startup to lose all credit/MPA tracking.
        writeJsonFileAtomic(this.statePath, this.state);
        if (reason) {
            this.log(`credit runtime: persisted ${this.botKey} state (${reason})`);
        }
        return this.state;
    }

    async shutdown(): Promise<void> {
        if (!this._loaded) return;
        await this.persistState('shutdown');
    }

    async _dbCall(method: string, args: unknown[] = []): Promise<unknown> {
        await waitForConnected();
        if (!BitShares?.db) {
            throw new Error('BitShares DB client is unavailable');
        }

        const camelMethod = snakeToCamel(method);
        if (camelMethod && typeof BitShares.db[camelMethod] === 'function') {
            return BitShares.db[camelMethod](...(Array.isArray(args) ? args : []));
        }

        if (typeof BitShares.db.call !== 'function') {
            throw new Error(`BitShares DB method is unavailable: ${method}`);
        }
        return BitShares.db.call(method, args);
    }

    async _resolveAccountId(accountRef: unknown): Promise<string | null> {
        if (!accountRef) return null;
        const ref = String(accountRef);
        if (/^1\.2\.\d+$/.test(ref)) return ref;
        return chainOrders.resolveAccountId(ref);
    }

    async _resolveAccountName(accountRef: unknown): Promise<string | null> {
        if (!accountRef) return null;
        const ref = String(accountRef);
        if (!/^1\.2\.\d+$/.test(ref)) return ref;
        return chainOrders.resolveAccountName(ref);
    }

    async _getFullAccount(accountRef: unknown): Promise<UnknownRecord | null> {
        if (!accountRef) return null;
        if (this._fullAccountCache && this._fullAccountCache.ref === String(accountRef)) {
            return this._fullAccountCache.account;
        }
        const accounts = await this._dbCall('get_full_accounts', [[accountRef], false]);
        const account = parseFullAccount(accounts);
        this._fullAccountCache = { ref: String(accountRef), account: (account ?? null) as unknown as UnknownRecord | null };
        return (account ?? null) as unknown as UnknownRecord | null;
    }

    async _resolveAsset(assetRef: unknown): Promise<UnknownRecord | null> {
        if (!assetRef) return null;
        // Canonical key: debtPolicy.lending refs and the --asset/--collateral
        // overrides of scripts/test-credit-renewal.ts would otherwise each get
        // their own cache slot for the same asset.
        const cacheKey = normalizeAssetRef(assetRef);
        if (this._assetCache.has(cacheKey)) {
            return this._assetCache.get(cacheKey) ?? null;
        }

        await waitForConnected();
        const asset = await resolveAssetByRef(BitShares, cacheKey);

        if (asset) {
            this._assetCache.set(cacheKey, asset);
            if (asset.id) {
                this._assetCache.set(String(asset.id), asset);
            }
            if (asset.symbol) {
                this._assetCache.set(String(asset.symbol), asset);
            }
        }

        return asset;
    }

    async _resolveBitassetData(assetRef: unknown): Promise<UnknownRecord | null> {
        const asset = await this._resolveAsset(assetRef);
        const bitassetDataId = asset?.bitasset_data_id != null ? String(asset.bitasset_data_id) : null;
        if (!bitassetDataId) return null;

        if (this._objectCache.has(bitassetDataId)) {
            return this._objectCache.get(bitassetDataId) ?? null;
        }

        const objects = await this._dbCall('get_objects', [[bitassetDataId]]);
        const bitassetData = Array.isArray(objects) ? objects[0] : null;
        if (bitassetData) {
            this._objectCache.set(bitassetDataId, bitassetData);
        }
        return bitassetData;
    }

    _computeBtsPerDebt(settlementPrice: UnknownRecord | null | undefined, debtAsset: UnknownRecord | null | undefined, backingAsset: UnknownRecord | null | undefined): number | null {
        const base = settlementPrice?.base as UnknownRecord | undefined;
        const quote = settlementPrice?.quote as UnknownRecord | undefined;
        if (!base || !quote || !debtAsset || !backingAsset) return null;

        const baseAsset = base.asset_id === debtAsset.id ? debtAsset : backingAsset;
        const quoteAsset = quote.asset_id === debtAsset.id ? debtAsset : backingAsset;
        const baseAmount = blockchainAmountToFloat(base.amount, baseAsset);
        const quoteAmount = blockchainAmountToFloat(quote.amount, quoteAsset);
        if (baseAmount == null || quoteAmount == null || baseAmount <= 0 || quoteAmount <= 0) {
            return null;
        }

        if (base.asset_id === backingAsset.id && quote.asset_id === debtAsset.id) {
            return baseAmount / quoteAmount;
        }
        if (base.asset_id === debtAsset.id && quote.asset_id === backingAsset.id) {
            return quoteAmount / baseAmount;
        }
        return null;
    }

    _normalizePolicyList(value: unknown): string[] {
        return normalizeNumberArray(value);
    }

    _rebuildCreditTrackingFromPositions(): void {
        const allActiveDealIds: string[] = [];
        const allActiveOfferIds: string[] = [];
        const allCreditDeals: unknown[] = [];
        for (const pos of (Object.values(this.state.positions || {}) as UnknownRecord[])) {
            if (Array.isArray(pos.activeDealIds)) {
                allActiveDealIds.push(...pos.activeDealIds);
            }
            if (Array.isArray(pos.activeOfferIds)) {
                allActiveOfferIds.push(...pos.activeOfferIds);
            }
            if (Array.isArray(pos.creditDeals)) {
                allCreditDeals.push(...pos.creditDeals);
            }
        }
        this.state.activeDealIds = allActiveDealIds;
        this.state.activeOfferIds = allActiveOfferIds;
        this.state.creditDeals = allCreditDeals as Record<string, unknown>[];
    }

    async _pruneCreditStateForPolicy(lendingItems: UnknownRecord[] = []) {
        const validCreditPositionKeys = new Set<string>();
        for (const item of lendingItems) {
            if (item?.type !== 'creditOffer') continue;
            const debtAsset = await this._resolveAsset(item.asset);
            const collateralAsset = await this._resolveAsset(item.collateralAsset);
            if (debtAsset?.id && collateralAsset?.id) {
                validCreditPositionKeys.add(this._positionKey(String(debtAsset.id), String(collateralAsset.id)));
            }
        }

        for (const [key, pos] of (Object.entries(this.state.positions || {}) as Array<[string, UnknownRecord]>)) {
            if (validCreditPositionKeys.has(key)) continue;
            if (!pos || typeof pos !== 'object') continue;
            delete pos.creditDeals;
            delete pos.activeDealIds;
            delete pos.activeOfferIds;
            delete pos.creditConversionRate;
        }
    }

    async _resolveAmountToBlockchainInt(spec: unknown, asset: UnknownRecord, accountRef: unknown, { balanceField = 'total', referenceAmount = null, referenceLabel = 'available balance' }: { balanceField?: string; referenceAmount?: number | null; referenceLabel?: string } = {}): Promise<number | null> {
        const normalized = normalizeAmountSpec(spec);
        if (!normalized || normalized.amount === null || normalized.amount === undefined) {
            return null;
        }
        if (!asset || !asset.id) {
            throw new Error('Unable to resolve asset metadata for amount spec');
        }

        const isPercent = typeof normalized.amount === 'string' && normalized.amount.trim().endsWith('%');
        let total: number | null = null;
        if (isPercent) {
            if (Number.isFinite(referenceAmount)) {
                total = Number(referenceAmount);
            } else {
                if (!accountRef) {
                    throw new Error(`Unable to resolve account for percentage amount on ${String(asset.id)}`);
                }
                const balances = await chainOrders.getOnChainAssetBalances(accountRef, [String(asset.id)]);
                const balance = this._pickOnChainBalanceEntry(balances, asset.id, asset);
                total = toFiniteNumber(balance?.[balanceField], NaN);
                if (!Number.isFinite(total) || total < 0) {
                    throw new Error(`Unable to resolve ${referenceLabel} for ${String(asset.id)}`);
                }
            }
            if (!Number.isFinite(total) || total < 0) {
                throw new Error(`Unable to resolve account for percentage amount on ${String(asset.id)}`);
            }
        }

        const resolved = resolveConfigValue(normalized.amount, total);
        if (!Number.isFinite(resolved) || resolved <= 0) {
            return null;
        }
        if (isPercent && total !== null && resolved > total) {
            throw new Error(`Requested amount ${resolved} exceeds available ${balanceField} balance ${total} for ${String(asset.id)}`);
        }

        const intValue = floatToBlockchainInt(resolved, asset.precision as number);
        if (!Number.isFinite(intValue) || intValue <= 0) {
            return null;
        }

        return intValue;
    }

    async _resolveLendingPolicyForOffer(offer: UnknownRecord | null | undefined): Promise<unknown> {
        const offerDebtAssetId = offer?.asset_type || null;
        if (!offerDebtAssetId || !this.debtPolicy?.lending) return null;
        for (const item of this.debtPolicy.lending) {
            if (item.type !== 'creditOffer') continue;
            let cached = this._assetCache.get(String(item.asset));
            if (!cached && item.asset) {
                cached = (await this._resolveAsset(item.asset)) ?? undefined;
            }
            if (cached && String(cached.id) === String(offerDebtAssetId)) {
                return item;
            }
        }
        return null;
    }

    /**
     * Resolve the MPA feed price for a given debt/collateral pair.
     * Uses cached value if fresh, otherwise fetches from the blockchain.
     * @param {string} debtAssetId - The debt asset ID
     * @param {string} collateralAssetId - The collateral asset ID
     * @param {Object} [options] - Optional settings
     * @param {boolean} [options.includeSource] - When true, returns { price, source } object
     * @returns {number|Object|null} Price number, { price, source } object, or null
     */
    async _resolveMpaFeedPrice(debtAssetId: unknown, collateralAssetId: unknown, options: { includeSource?: boolean } = {}): Promise<number | { price: number | null; source: string } | null> {
        if (!debtAssetId || !collateralAssetId) return null;

        const MPA_FEED_MAX_AGE_MS = require('./constants').TIMING.MPA_FEED_MAX_AGE_MS;
        const posKey = this._positionKey(debtAssetId, collateralAssetId);
        const cached = positiveOrNull(this.state.positions[posKey]?.mpaFeedPrice);
        const cachedAt = (this.state.positions[posKey]?.mpaFeedPriceAt as number | undefined) || 0;
        const cachedIsFresh = cached !== null && (Date.now() - cachedAt) < MPA_FEED_MAX_AGE_MS;

        const bitassetData = await this._resolveBitassetData(debtAssetId);
        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);
        if (!debtAsset || !collateralAsset) {
            if (options.includeSource) {
                return cachedIsFresh
                    ? { price: cached, source: 'cached-feed' }
                    : { price: null, source: 'missing-feed' };
            }
            return cachedIsFresh ? cached : null;
        }

        const feedPrice = this._computeBtsPerDebt((bitassetData?.current_feed as UnknownRecord | undefined)?.settlement_price as UnknownRecord | null | undefined, debtAsset, collateralAsset);
        if (feedPrice != null && Number.isFinite(feedPrice) && feedPrice > 0) {
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].mpaFeedPrice = feedPrice;
            this.state.positions[posKey].mpaFeedPriceAt = Date.now();
            return options.includeSource ? { price: feedPrice, source: 'live-feed' } : feedPrice;
        }

        if (options.includeSource) {
            return cachedIsFresh
                ? { price: cached, source: 'cached-feed' }
                : { price: null, source: 'missing-feed' };
        }
        return cachedIsFresh ? cached : null;
    }

    /**
     * Resolve the credit conversion rate for a given lending item.
     * Uses cached value if fresh, otherwise derives from credit deals.
     * @param {Object} lendingItem - The lending item config
     * @param {string} debtAssetId - The debt asset ID
     * @param {string} collateralAssetId - The collateral asset ID
     * @param {Object} [options] - Optional settings
     * @param {boolean} [options.includeSource] - When true, returns { price, source } object
     * @returns {number|Object|null} Rate number, { price, source } object, or null
     */
    async _resolveCreditConversionRate(lendingItem: UnknownRecord | null | undefined, debtAssetId: unknown, collateralAssetId: unknown, options: { includeSource?: boolean } = {}): Promise<number | { price: number | null; source: string } | null> {
        if (!debtAssetId || !collateralAssetId) return null;

        const CREDIT_RATE_MAX_AGE_MS = require('./constants').TIMING.CREDIT_RATE_MAX_AGE_MS;
        const posKey = this._positionKey(debtAssetId, collateralAssetId);
        const cached = positiveOrNull(this.state.positions[posKey]?.creditConversionRate);
        const cachedAt = (this.state.positions[posKey]?.creditConversionRateAt as number | undefined) || 0;
        const cachedIsFresh = cached !== null && (Date.now() - cachedAt) < CREDIT_RATE_MAX_AGE_MS;

        // LP-share collateral is a claim on pool reserves, so its market value
        // comes from the live pool and must win over the offer's fixed
        // acceptable_collateral price (a contract haircut). This matches the
        // borrow gate in _calculateCollateralValueInDebtAsset(). Other
        // collateral uses the offer map; pool/market pricing is only a
        // fallback for those pairs.
        {
            const debtAsset = await this._resolveAsset(debtAssetId);
            const collateralAsset = await this._resolveAsset(collateralAssetId);
            if (collateralAsset?.for_liquidity_pool && debtAsset?.id) {
                const poolRate = await deriveLiquidityPoolTokenValue(BitShares, String(collateralAsset.id), String(debtAsset.id), 'auto', true).catch((e) => {
                    this.log(`credit runtime: pool token rate derivation failed for ${collateralAsset.id}/${debtAsset.id}: ${getErrorMessage(e)}`);
                    return null;
                });
                if (poolRate != null && Number.isFinite(poolRate) && poolRate > 0) {
                    if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                    this.state.positions[posKey].creditConversionRate = poolRate;
                    this.state.positions[posKey].creditConversionRateAt = Date.now();
                    return options.includeSource ? { price: poolRate, source: 'pool-derived' } : poolRate;
                }
            }
        }

        // Non-LP collateral uses the offer map (live-offer / owned-offer) —
        // the offer's acceptable_collateral price is the contract's
        // debt-per-collateral conversion rate.
        const offerIds = new Set();

        const deals = Array.isArray(this.state.positions[posKey]?.creditDeals)
            ? this.state.positions[posKey].creditDeals
            : [];
        for (const deal of deals) {
            if (deal?.offerId) offerIds.add(String(deal.offerId));
        }

        const allowedOfferIds = this._normalizePolicyList(lendingItem?.allowedOfferIds);
        for (const id of allowedOfferIds) {
            if (id) offerIds.add(String(id));
        }

        if (offerIds.size === 0) {
            // Fallback: scan owned credit offers for pricing when no deal-based
            // or allowed offer IDs are configured.
            const ownedOffers = Array.isArray(this.state.ownedCreditOffers) ? this.state.ownedCreditOffers : [];
            if (ownedOffers.length > 0 && debtAssetId && collateralAssetId) {
                const debtAsset = await this._resolveAsset(debtAssetId);
                const collateralAsset = await this._resolveAsset(collateralAssetId);
                if (debtAsset && collateralAsset) {
                    const match = ownedOffers.find((o: Record<string, unknown>) =>
                        String(o.assetType) === String(debtAssetId) && o.enabled !== false
                    );
                    if (match) {
                        const collateralMap = normalizeCollateralMap(match.acceptableCollateral);
                        const rate = this._extractRateFromCollateralMap(collateralMap, String(collateralAssetId), debtAsset, collateralAsset);
                        if (rate !== null) {
                            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                            this.state.positions[posKey].creditConversionRate = rate;
                            this.state.positions[posKey].creditConversionRateAt = Date.now();
                            return options.includeSource ? { price: rate, source: 'owned-offer' } : rate;
                        }
                    }
                }
            }
            // No owned-offer entry — fall through to pool derivation before
            // returning cached/missing (pool is fallback for LP shares with
            // no offer entry).
        }

        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);
        if (!debtAsset || !collateralAsset) {
            if (options.includeSource) {
                return cachedIsFresh
                    ? { price: cached, source: 'cached-offer' }
                    : { price: null, source: 'missing-offer' };
            }
            return cachedIsFresh ? cached : null;
        }

        const offerObjects = await this._dbCall('get_objects', [Array.from(offerIds)]);
        if (Array.isArray(offerObjects)) {
            for (const offer of offerObjects) {
                if (!offer || String(offer.asset_type) !== String(debtAssetId)) continue;
                if (offer.enabled === false) continue;

                const collateralMap = normalizeCollateralMap(offer?.acceptable_collateral);
                const rate = this._extractRateFromCollateralMap(collateralMap, String(collateralAssetId), debtAsset, collateralAsset);
                if (rate === null) continue;

                if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                this.state.positions[posKey].creditConversionRate = rate;
                this.state.positions[posKey].creditConversionRateAt = Date.now();
                return options.includeSource ? { price: rate, source: 'live-offer' } : rate;
            }
        }

        // Offer map had no usable entry (or the LP pool valuation above
        // failed) — fall back to pool derivation for LP shares, then to
        // universal DEX pricing (direct market, else bridge hops via BTS) so
        // every collateral/debt pair resolves a rate even when the collateral
        // or pool is not part of the credit offer. Only attempt when cached is
        // stale to avoid hourly deriveLiquidityPoolTokenValue failures.
        // Reuses debtAsset/collateralAsset resolved above.
        if (!cachedIsFresh) {
            if (collateralAsset?.for_liquidity_pool && debtAsset?.id) {
                const poolRate = await deriveLiquidityPoolTokenValue(BitShares, String(collateralAsset.id), String(debtAsset.id), 'auto', true).catch((e) => {
                    this.log(`credit runtime: pool token rate derivation failed for ${collateralAsset.id}/${debtAsset.id}: ${getErrorMessage(e)}`);
                    return null;
                });
                if (poolRate != null && Number.isFinite(poolRate) && poolRate > 0) {
                    if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                    this.state.positions[posKey].creditConversionRate = poolRate;
                    this.state.positions[posKey].creditConversionRateAt = Date.now();
                    return options.includeSource ? { price: poolRate, source: 'pool-derived' } : poolRate;
                }
            }
            if (collateralAsset?.id && debtAsset?.id) {
                const bridged = await derivePriceWithBridges(BitShares, String(collateralAsset.id), String(debtAsset.id)).catch((e) => {
                    this.log(`credit runtime: market rate derivation failed for ${collateralAsset.id}/${debtAsset.id}: ${getErrorMessage(e)}`);
                    return null;
                });
                if (bridged && Number.isFinite(bridged.rate) && bridged.rate > 0) {
                    if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                    this.state.positions[posKey].creditConversionRate = bridged.rate;
                    this.state.positions[posKey].creditConversionRateAt = Date.now();
                    const source = bridged.path === 'direct' ? 'market-direct' : `market-${bridged.path}`;
                    return options.includeSource ? { price: bridged.rate, source } : bridged.rate;
                }
            }
        }

        if (options.includeSource) {
            return cachedIsFresh
                ? { price: cached, source: 'cached-offer' }
                : { price: null, source: 'missing-offer' };
        }
        return cachedIsFresh ? cached : null;
    }

    async _calculateCollateralDistribution() {
        const dp = this.debtPolicy;
        if (!dp || !Array.isArray(dp.lending)) return;

        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return;

        // Group lending items by their collateral asset
        const groups = new Map();
        for (const item of dp.lending) {
            const ref = item.collateralAsset;
            if (!ref) continue;
            if (!groups.has(ref)) groups.set(ref, []);
            groups.get(ref).push(item);
        }

        const validAssetIds = new Set();
        let allGroupsResolved = true;

        for (const [collateralRef, items] of groups) {
            const collateralAsset = await this._resolveAsset(collateralRef);
            if (!collateralAsset) {
                this.warn(`credit runtime: unable to resolve collateral asset ${String(collateralRef)}; keeping existing position state for this group`);
                allGroupsResolved = false;
                continue;
            }

            const totalCollateralAvailable = await this._getCollateralPercentageBase(accountRef, String(collateralAsset.id));
            const totalMaxCollateral = resolveConfigValue(dp.maxCollateralAmount ?? '100%', totalCollateralAvailable as number);
            const C_total = Math.min(totalCollateralAvailable as number, totalMaxCollateral as number);

            let groupHasNoUsablePrice = false;
            const weightEntries = await Promise.all(
                items.map(async (item: UnknownRecord) => {
                    const ratio = Number(item.outputWeight ?? 1);
                    const resolvedAsset = await this._resolveAsset(item.asset);
                    const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;

                    let targetCr = 1.0;
                    let weight = 0;

                    if (item.type === 'mpa') {
                        targetCr = resolveTargetCollateralRatio(item) ?? DEFAULT_TARGET_CR;
                        const resolvedFeedPrice = assetId
                            ? normalizeResolvedPriceResult(
                                await this._resolveMpaFeedPrice(assetId, collateralAsset.id, { includeSource: true }),
                                'live-feed',
                                'missing-feed'
                            )
                            : { price: null, source: 'missing-feed' };
                        if (resolvedFeedPrice.price !== null) {
                            weight = ratio * resolvedFeedPrice.price * targetCr;
                            if (resolvedFeedPrice.source === 'cached-feed') {
                                this.warn(`credit runtime: live MPA feed price unavailable for ${item.asset}; using last known feed price for collateral group ${collateralRef}`);
                            }
                        } else {
                            if (assetId) {
                                this.warn(`credit runtime: unable to resolve MPA feed price for ${item.asset}; no usable last known feed price for collateral group ${collateralRef}`);
                                groupHasNoUsablePrice = true;
                            }
                        }
                    } else if (item.type === 'creditOffer') {
                        targetCr = toFiniteNumber(item.maxCollateralRatio, 2.0);
                        const resolvedConversionRate = assetId
                            ? normalizeResolvedPriceResult(
                                await this._resolveCreditConversionRate(item, assetId, collateralAsset.id, { includeSource: true }),
                                'live-offer',
                                'missing-offer'
                            )
                            : { price: null, source: 'missing-offer' };
                        if (resolvedConversionRate.price !== null) {
                            weight = (ratio * targetCr) / resolvedConversionRate.price;
                            if (resolvedConversionRate.source === 'cached-offer') {
                                this.warn(`credit runtime: live credit offer price unavailable for ${item.asset}; using last known price for collateral group ${collateralRef}`);
                            }
                        } else {
                            if (assetId) {
                                this.warn(`credit runtime: unable to resolve credit offer price for ${item.asset}; no usable last known price for collateral group ${collateralRef}`);
                                groupHasNoUsablePrice = true;
                            }
                        }
                    } else {
                        weight = ratio * targetCr;
                    }

                    return { item, weight, assetId };
                })
            );

            if (groupHasNoUsablePrice) {
                // Keep existing assignedCollateralBudget for this group's positions until a live or cached price is available again.
                for (const item of items) {
                    const resolvedAsset = await this._resolveAsset(item.asset);
                    const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
                    if (assetId && collateralAsset.id) {
                        const posKey = this._positionKey(assetId, String(collateralAsset.id));
                        validAssetIds.add(posKey);
                    }
                }
                continue;
            }

            const totalWeight = weightEntries.reduce((sum, e) => sum + e.weight, 0);
            if (totalWeight === 0) {
                this.warn(`credit runtime: collateral group ${collateralAsset.id} has zero total weight; keeping existing position state for this group`);
                allGroupsResolved = false;
                continue;
            }

            for (const { weight, assetId } of weightEntries) {
                if (!assetId || !collateralAsset.id) continue;
                const posKey = this._positionKey(assetId, String(collateralAsset.id));
                validAssetIds.add(posKey);
                const C_i = (C_total * weight) / totalWeight;
                if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                this.state.positions[posKey].assignedCollateralBudget = C_i;
            }
        }

        if (!allGroupsResolved) return;

        for (const key of Object.keys(this.state.positions)) {
            if (!validAssetIds.has(key)) {
                delete this.state.positions[key];
            }
        }
    }

    _precisionOfPair(debtAsset: UnknownRecord | null, collateralAsset: UnknownRecord | null): (assetId: string) => number | null {
        return (assetId: string) => {
            if (debtAsset && String(assetId) === String(debtAsset.id)) return getAssetPrecision(debtAsset);
            if (collateralAsset && String(assetId) === String(collateralAsset.id)) return getAssetPrecision(collateralAsset);
            return null;
        };
    }

    _extractRateFromCollateralMap(collateralMap: ReadonlyMap<string, unknown> | null | undefined, collateralAssetId: string, debtAsset: UnknownRecord | null, collateralAsset: UnknownRecord | null): number | null {
        const rate = sharedExtractOfferConversionRate(
            collateralMap,
            String(collateralAssetId),
            String(debtAsset?.id || ''),
            this._precisionOfPair(debtAsset, collateralAsset),
        );
        // The offer lists this collateral but the price is unusable (missing
        // asset precision or invalid base/quote amounts) — log it, otherwise
        // the null is indistinguishable from "not listed" downstream.
        if (rate === null && collateralMap?.get(String(collateralAssetId)) != null) {
            this.log(`credit runtime: offer lists ${collateralAssetId} but its price cannot be resolved (missing precision or invalid base/quote amounts)`);
        }
        return rate;
    }

    _calculateBorrowAmountFromCollateral(collateralAmountInt: unknown, collateralPrice: Parameters<typeof sharedBorrowAmountForCollateral>[1], debtAsset: UnknownRecord | null = null, collateralAsset: UnknownRecord | null = null): number | null {
        return sharedBorrowAmountForCollateral(
            collateralAmountInt,
            collateralPrice,
            debtAsset?.id != null ? String(debtAsset.id) : null,
            collateralAsset?.id != null ? String(collateralAsset.id) : null,
        );
    }

    _enforceMaxBorrowAmount(policy: UnknownRecord, borrowInt: unknown, debtAsset: UnknownRecord, options: UnknownRecord = {}): void {
        const maxBorrowAmountValue = positiveOrNull(policy?.maxBorrowAmount);
        if (maxBorrowAmountValue === null) return;
        const borrowFloat = blockchainToFloat(borrowInt, debtAsset.precision as number);
        if (!Number.isFinite(borrowFloat)) return;
        const currentTotal = this._getCreditDebtForAsset(debtAsset);
        const pendingRepayFloat = Number(options.pendingRepayAmount) || 0;
        if (currentTotal - pendingRepayFloat + borrowFloat > maxBorrowAmountValue) {
            throw new Error(`borrowAmount ${borrowFloat} would exceed maxBorrowAmount ${maxBorrowAmountValue} (current total ${currentTotal}, pending repay ${pendingRepayFloat})`);
        }
    }

    _getCreditDebtForAsset(asset: unknown): number {
        return this._sumCreditFieldForAsset(asset, 'debtAssetId', 'debtAmount');
    }

    _getCreditCollateralForAsset(asset: unknown): number {
        return this._sumCreditFieldForAsset(asset, 'collateralAssetId', 'collateralAmount');
    }

    /**
     * Sum a raw credit-deal amount across all deals matching `asset` on the
     * given asset-id field, converted to float at the asset's precision.
     * Shared by the debt and collateral totals (see _getCreditDebtForAsset and
     * _getCreditCollateralForAsset).
     */
    _sumCreditFieldForAsset(asset: unknown, assetField: string, amountField: string): number {
        const assetId = (asset as UnknownRecord | null | undefined)?.id ?? asset;
        const deals = Array.isArray(this.state?.creditDeals) ? this.state.creditDeals : [];
        return deals.reduce((sum: number, deal: Record<string, unknown>) => {
            if (String(deal?.[assetField]) === String(assetId)) {
                return sum + (blockchainAmountToFloat(deal?.[amountField], asset) || 0);
            }
            return sum;
        }, 0);
    }

    async _getCollateralPercentageBase(accountId: unknown, assetId: unknown): Promise<number | null> {
        if (!accountId || !assetId) return null;

        const asset = await this._resolveAsset(assetId);
        if (!asset) return null;

        const [balances, account, deals] = await Promise.all([
            chainOrders.getOnChainAssetBalances(accountId as string | null | undefined, [String(assetId)]),
            this._getFullAccount(accountId).catch(() => null),
            this._fetchBorrowerDeals().catch(() => []),
        ]);

        const balance = this._pickOnChainBalanceEntry(balances, assetId, asset);
        const onChainTotal = toFiniteNumber(balance?.total, NaN);
        if (!Number.isFinite(onChainTotal)) {
            return null;
        }

        let committed = 0;
        for (const order of parseCallOrders(account) as Array<{ call_price?: { base?: { asset_id?: unknown } }; collateral?: unknown }>) {
            const orderCollateralAssetId = order?.call_price?.base?.asset_id || null;
            if (String(orderCollateralAssetId) !== String(assetId)) continue;
            committed += blockchainAmountToFloat(order?.collateral, asset) || 0;
        }

        for (const deal of deals) {
            if (String(deal?.collateralAssetId) !== String(assetId)) continue;
            const dealAsset = await this._resolveAsset(deal.collateralAssetId);
            committed += blockchainAmountToFloat(deal?.collateralAmount, dealAsset || asset) || 0;
        }

        const total = onChainTotal + committed;

        // Apply registry proportional split for shared-account credit bots
        const accountName = getAccountName(this.bot);
        const botName = this.botKey;
        if (accountName && botName) {
            const effective = fundRegistry.getEffectiveCollateralAllocationSync(accountName, botName, String(assetId), total);
            if (effective !== null) return effective;
        }

        return total;
    }

    async _enforceMaxCollateralAmount(policy: UnknownRecord, collateralInt: unknown, collateralAsset: UnknownRecord, accountId: unknown, options: UnknownRecord = {}): Promise<void> {
        const maxCollateralAmountValue = policy?.maxCollateralAmount;
        if (maxCollateralAmountValue == null) return;
        let limitFloat = positiveOrNull(maxCollateralAmountValue);
        if (limitFloat === null) {
            const trimmed = typeof maxCollateralAmountValue === 'string' ? maxCollateralAmountValue.trim() : '';
            if (!trimmed.endsWith('%')) return;
            const referenceAmount = await this._getCollateralPercentageBase(accountId, collateralAsset.id as string);
            if (!Number.isFinite(referenceAmount)) {
                throw new Error(`Unable to resolve collateral percentage base for ${String(collateralAsset.id)}`);
            }
            limitFloat = resolveConfigValue(maxCollateralAmountValue, referenceAmount);
        }
        if (!Number.isFinite(limitFloat) || limitFloat < 0) return;
        const collateralFloat = blockchainToFloat(collateralInt, collateralAsset.precision as number);
        if (!Number.isFinite(collateralFloat)) return;
        const currentTotal = this._getCreditCollateralForAsset(collateralAsset);
        const pendingReleaseFloat = Number(options.pendingReleaseCollateralAmount) || 0;
        if (currentTotal - pendingReleaseFloat + collateralFloat > limitFloat) {
            throw new Error(`collateralAmount ${collateralFloat} would exceed maxCollateralAmount ${limitFloat} (current total ${currentTotal}, pending release ${pendingReleaseFloat})`);
        }
    }

    _calculateDailyFeeRate(offer: UnknownRecord): number {
        const feeRateDenom = this.bot?.config?.feeParams?.GRAPHENE_FEE_RATE_DENOM ?? FEE_PARAMETERS.GRAPHENE_FEE_RATE_DENOM;
        return sharedDailyOfferFeeRate(offer, feeRateDenom);
    }

    _getDefaultMaxFeeRatePerDay(): number {
        return this.bot?.config?.feeParams?.DEFAULT_MAX_FEE_RATE_PER_DAY ?? FEE_PARAMETERS.DEFAULT_MAX_FEE_RATE_PER_DAY;
    }

    _validateCreditPolicy(policy: UnknownRecord, offer: UnknownRecord | null | undefined, deal: UnknownRecord | null = null): UnknownRecord {
        if (!policy || typeof policy !== 'object') return { allow: false, reason: 'creditOffer policy missing' };
        const allowedOfferIds = this._normalizePolicyList(policy.allowedOfferIds);
        const maxFeeRatePerDay = positiveOrNull(policy.maxFeeRatePerDay) ?? this._getDefaultMaxFeeRatePerDay();
        const maxBorrowAmount = positiveOrNull(policy.maxBorrowAmount);
        const maxCollateralAmount = positiveOrPercentOrNull(policy.maxCollateralAmount);
        const maxCollateralRatio = positiveOrNull(policy.maxCollateralRatio);

        if (maxCollateralRatio === null) {
            return { allow: false, reason: 'creditOffer maxCollateralRatio is required' };
        }
        if (policy.maxBorrowAmount != null && maxBorrowAmount === null) {
            return { allow: false, reason: 'creditOffer maxBorrowAmount must be positive' };
        }
        if (policy.maxCollateralAmount != null && maxCollateralAmount === null) {
            return { allow: false, reason: 'creditOffer maxCollateralAmount must be positive or percentage' };
        }

        if (allowedOfferIds.length > 0 && offer?.id && !allowedOfferIds.includes(String(offer.id))) {
            return { allow: false, reason: `offer ${offer.id} is not allowed` };
        }

        if (deal) {
            if (allowedOfferIds.length > 0 && deal.offerId && !allowedOfferIds.includes(String(deal.offerId))) {
                return { allow: false, reason: `deal offer ${deal.offerId} is not allowed` };
            }
        }

        const dailyRate = this._calculateDailyFeeRate(offer as UnknownRecord);
        if (dailyRate > maxFeeRatePerDay) {
            return { allow: false, reason: `offer daily fee rate ${dailyRate.toFixed(6)} exceeds maxFeeRatePerDay ${maxFeeRatePerDay}` };
        }

        return { allow: true, reason: null };
    }

    async _calculateCollateralValueInDebtAsset(collateralAmountInt: unknown, collateralAsset: UnknownRecord, debtAsset: UnknownRecord, collateralPrice: unknown): Promise<number | null> {
        if (collateralAsset?.for_liquidity_pool) {
            const collateralAmountFloat = blockchainToFloat(collateralAmountInt, collateralAsset.precision as number);
            if (!Number.isFinite(collateralAmountFloat) || collateralAmountFloat <= 0) {
                return null;
            }
            const valuePerShare = await deriveLiquidityPoolTokenValue(BitShares, String(collateralAsset.id), String(debtAsset.id), 'auto', true);
            if (valuePerShare == null || !Number.isFinite(valuePerShare) || valuePerShare <= 0) {
                return null;
            }
            return collateralAmountFloat * valuePerShare;
        }

        return this._calculateCreditOfferCollateralValueInDebtAsset(collateralAmountInt, collateralAsset, debtAsset, collateralPrice);
    }

    _calculateCreditOfferCollateralValueInDebtAsset(collateralAmountInt: unknown, collateralAsset: UnknownRecord, debtAsset: UnknownRecord, collateralPrice: unknown): number | null {
        return sharedCollateralValueFromOfferPrice(
            collateralAmountInt,
            collateralAsset?.precision,
            collateralPrice,
            String(debtAsset?.id || ''),
            String(collateralAsset?.id || ''),
            this._precisionOfPair(debtAsset, collateralAsset),
        );
    }

    async _fetchBorrowerDeals(): Promise<DealSummary[]> {
        if (this._borrowerDealsCache !== null) return this._borrowerDealsCache;
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return [];
        const accountId = await this._resolveAccountId(accountRef);
        if (!accountId) return [];
        const dealObjects = await this._dbCall('get_credit_deals_by_borrower', [accountId]);
        const normalized = Array.isArray(dealObjects) ? dealObjects.map(parseDealSummary).filter((d): d is DealSummary => d !== null) : [];
        this._borrowerDealsCache = normalized;
        return normalized;
    }

    async _fetchOwnedCreditOffers(): Promise<CreditOfferSummary[]> {
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return [];
        }

        const accountId = await this._resolveAccountId(accountRef) || accountRef;
        const offers = await this._dbCall('get_credit_offers_by_owner', [accountId]);
        return Array.isArray(offers) ? offers.map(parseCreditOfferSummary).filter((o): o is CreditOfferSummary => o !== null) : [];
    }

    async _buildDebtSnapshot(): Promise<DebtSnapshot> {
        const snapshot: DebtSnapshot = {
            assets: {},
            mpaCallOrders: Array.isArray(this.state.mpaCallOrders) ? this.state.mpaCallOrders : [],
            creditDeals: Array.isArray(this.state.creditDeals) ? this.state.creditDeals : [],
            ownedCreditOffers: Array.isArray(this.state.ownedCreditOffers) ? this.state.ownedCreditOffers : [],
        };

        const bump = (assetId: unknown, field: DebtBumpField, amount: number): void => {
            if (!assetId || !Number.isFinite(amount) || amount === 0) return;
            const key = String(assetId);
            if (!snapshot.assets[key]) {
                snapshot.assets[key] = {
                    assetId: key,
                    mpaDebt: 0,
                    mpaCollateral: 0,
                    creditDebt: 0,
                    creditCollateral: 0,
                    offeredBalance: 0,
                    totalDebt: 0,
                    totalCollateral: 0,
                };
            }
            snapshot.assets[key][field] += amount;
        };

        for (const entry of snapshot.mpaCallOrders) {
            const order = entry as UnknownRecord;
            const debtAsset = order?.debtAssetId ? await this._resolveAsset(order.debtAssetId) : null;
            const collateralAsset = order?.collateralAssetId ? await this._resolveAsset(order.collateralAssetId) : null;
            bump(order?.debtAssetId, 'mpaDebt', blockchainAmountToFloat(order?.debtAmount, debtAsset) || 0);
            bump(order?.collateralAssetId, 'mpaCollateral', blockchainAmountToFloat(order?.collateralAmount, collateralAsset) || 0);
        }

        for (const entry of snapshot.creditDeals) {
            const deal = entry as UnknownRecord;
            const debtAsset = deal?.debtAssetId ? await this._resolveAsset(deal.debtAssetId) : null;
            const collateralAsset = deal?.collateralAssetId ? await this._resolveAsset(deal.collateralAssetId) : null;
            bump(deal?.debtAssetId, 'creditDebt', blockchainAmountToFloat(deal?.debtAmount, debtAsset) || 0);
            bump(deal?.collateralAssetId, 'creditCollateral', blockchainAmountToFloat(deal?.collateralAmount, collateralAsset) || 0);
        }

        for (const entry of snapshot.ownedCreditOffers) {
            const offer = entry as UnknownRecord;
            const asset = offer?.assetType ? await this._resolveAsset(offer.assetType) : null;
            bump(offer?.assetType, 'offeredBalance', blockchainAmountToFloat(offer?.currentBalance, asset) || 0);
        }

        for (const entry of Object.values(snapshot.assets)) {
            entry.totalDebt = (entry.mpaDebt || 0) + (entry.creditDebt || 0);
            entry.totalCollateral = (entry.mpaCollateral || 0) + (entry.creditCollateral || 0);
        }

        return snapshot;
    }

    async refreshMpaState(lendingItem: UnknownRecord | null | undefined): Promise<unknown> {
        await this.loadState();
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('refreshMpaState requires a lendingItem');
        }

        const accountRef = getAccountRef(this.bot);
        if (!accountRef) {
            return null;
        }

        const debtAsset = await this._resolveAsset(lendingItem.asset);
        if (!debtAsset || !debtAsset.id) {
            return null;
        }
        const assetId = String(debtAsset.id);

        const account = await this._getFullAccount(accountRef);
        const callOrders = parseCallOrders(account).map(parseCallOrderSummary).filter(Boolean);
        this.state.mpaCallOrders = callOrders;

        const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const configuredCollateralAssetId = configuredCollateralAsset?.id ? String(configuredCollateralAsset.id) : null;
        const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : String(assetId);

        const candidateOrders = callOrders.filter((entry) =>
            String(entry?.call_price?.quote?.asset_id) === assetId
        );

        const createEmptyState = (reason: unknown): UnknownRecord => {
            const empty = {
                activeCallOrderId: null,
                mpaSelectionConflict: reason || null,
                debtAssetId: assetId,
                currentCollateralAssetId: null,
                currentDebtAmount: 0,
                currentCollateralAmount: 0,
                currentCollateralFundsTotal: null,
                currentCollateralRatio: null,
                feedPrice: null,
                targetCollateralRatio: resolveTargetCollateralRatio(lendingItem),
                minCollateralRatio: positiveOrNull(lendingItem.minCollateralRatio),
                maxCollateralRatio: positiveOrNull(lendingItem.maxCollateralRatio),
            };
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            Object.assign(this.state.positions[posKey], empty);
            return empty;
        };

        if (candidateOrders.length === 0) {
            return createEmptyState('no matching MPA position');
        }

        if (candidateOrders.length > 1) {
            const reason = `multiple matching MPA positions found for ${assetId} in ${this.botKey}`;
            this.warn(`credit runtime: ${reason}; refusing to select one automatically`);
            return createEmptyState(reason);
        }

        const callOrder = candidateOrders[0];
        const callOrderCollateralAssetId = callOrder?.call_price?.base?.asset_id || null;
        const collateralAsset = callOrderCollateralAssetId ? await this._resolveAsset(callOrderCollateralAssetId) : null;

        if (configuredCollateralAssetId && callOrderCollateralAssetId && String(callOrderCollateralAssetId) !== String(configuredCollateralAssetId)) {
            return createEmptyState(`call order collateral ${callOrderCollateralAssetId} does not match configured collateral ${configuredCollateralAssetId}`);
        }

        const bitassetData = await this._resolveBitassetData(assetId);

        const debtAmount = blockchainAmountToFloat(callOrder?.debt, debtAsset) || 0;
        const collateralAmount = blockchainAmountToFloat(callOrder?.collateral, collateralAsset) || 0;
        // Test seam: runtime._getOnChainAssetBalancesFn overrides the live
        // balance fetch so offline tests do not open a chain connection.
        const balancesFn = typeof this._getOnChainAssetBalancesFn === 'function'
            ? this._getOnChainAssetBalancesFn
            : (acct: string, assets: string[]) => chainOrders.getOnChainAssetBalances(acct, assets);
        const collateralBalances = callOrderCollateralAssetId ? await balancesFn(accountRef, [String(callOrderCollateralAssetId)]) : {};
        const collateralMap = collateralBalances as Record<string, unknown>;
        const collateralBalance = callOrderCollateralAssetId ? ((collateralMap?.[String(callOrderCollateralAssetId)] || collateralMap?.[String(collateralAsset?.symbol)] || null) as UnknownRecord | null) : null;
        let currentCollateralFundsTotal = toFiniteNumber(collateralBalance?.total, undefined);

        // Apply registry proportional split for shared-account credit bots
        if (currentCollateralFundsTotal !== null && callOrderCollateralAssetId) {
            const accountName = getAccountName(this.bot);
            const botName = this.botKey;
            if (accountName && botName) {
                const effective = fundRegistry.getEffectiveCollateralAllocationSync(accountName, botName, String(callOrderCollateralAssetId), currentCollateralFundsTotal);
                if (effective !== null) currentCollateralFundsTotal = effective;
            }
        }

        const feedPrice = this._computeBtsPerDebt((bitassetData?.current_feed as UnknownRecord | undefined)?.settlement_price as UnknownRecord | null | undefined, debtAsset, collateralAsset);
        if (feedPrice != null && Number.isFinite(feedPrice) && feedPrice > 0) {
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].mpaFeedPrice = feedPrice;
        }
        const currentCollateralRatio = debtAmount > 0 && feedPrice != null && feedPrice > 0
            ? collateralAmount / (debtAmount * feedPrice)
            : null;

        const posState = {
            activeCallOrderId: callOrder?.id || null,
            debtAssetId: assetId,
            currentCollateralAssetId: callOrderCollateralAssetId,
            currentDebtAmount: debtAmount,
            currentCollateralAmount: collateralAmount,
            currentCollateralFundsTotal,
            currentCollateralRatio,
            feedPrice,
            targetCollateralRatio: resolveTargetCollateralRatio(lendingItem),
            minCollateralRatio: positiveOrNull(lendingItem.minCollateralRatio),
            maxCollateralRatio: positiveOrNull(lendingItem.maxCollateralRatio),
            mpaSelectionConflict: null,
        };

        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
        Object.assign(this.state.positions[posKey], posState);

        return posState;
    }

    async refreshCreditState(options: UnknownRecord = {}, lendingItem: UnknownRecord): Promise<unknown> {
        await this.loadState();
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('refreshCreditState requires a lendingItem');
        }

        const debtAsset = await this._resolveAsset(lendingItem.asset);
        if (!debtAsset || !debtAsset.id) {
            return null;
        }
        const assetId = String(debtAsset.id);

        const normalizedDeals = Array.isArray(options.deals)
            ? options.deals.map(parseDealSummary).filter((d): d is DealSummary => d !== null)
            : await this._fetchBorrowerDeals();
        const ownedCreditOffers = Array.isArray(options.ownedCreditOffers)
            ? options.ownedCreditOffers.map(parseCreditOfferSummary).filter((o): o is CreditOfferSummary => o !== null)
            : await this._fetchOwnedCreditOffers();
        const trackedOffers = new Map();

        const offerIdsFromDeals = normalizedDeals.map((deal) => deal.offerId).filter(Boolean);
        const offerIds = Array.from(new Set(offerIdsFromDeals.map(String)));

        if (offerIds.length > 0) {
            const offerObjects = await this._dbCall('get_objects', [offerIds]);
            if (Array.isArray(offerObjects)) {
                for (const offer of offerObjects) {
                    if (offer && offer.id) {
                        trackedOffers.set(String(offer.id), offer);
                    }
                }
            }
        }

        const expectedCollateralAssetObj = await this._resolveAsset(lendingItem.collateralAsset);
        const expectedCollateralId = expectedCollateralAssetObj?.id ? String(expectedCollateralAssetObj.id) : null;
        const posKey = expectedCollateralId ? this._positionKey(assetId, expectedCollateralId) : String(assetId);

        // Cache conversion rate from discovered offers to avoid duplicate fetches in distribution.
        // This is a price for the debt+collateral asset pair, not for a specific offer id.
        // In practice, offers for the same pair should expose interchangeable acceptable-collateral pricing.
        if (expectedCollateralId) {
            const debtAssetResolved = await this._resolveAsset(assetId);
            const collateralAssetResolved = await this._resolveAsset(expectedCollateralId);
            if (debtAssetResolved && collateralAssetResolved) {
                for (const offer of trackedOffers.values()) {
                    if (String(offer?.asset_type) !== assetId) continue;
                    if (offer?.enabled === false) continue;
                    const collateralMap = normalizeCollateralMap(offer?.acceptable_collateral);
                    const rate = this._extractRateFromCollateralMap(collateralMap, expectedCollateralId, debtAssetResolved, collateralAssetResolved);
                    if (rate === null) continue;
                    if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                    this.state.positions[posKey].creditConversionRate = rate;
                    this.state.positions[posKey].creditConversionRateAt = Date.now();
                    break;
                }

                // Fallback: cache conversion rate from owned credit offers.
                // This ensures pricing is available even when there are no active
                // borrowing deals and allowedOfferIds is empty.
                if (!this.state.positions[posKey]?.creditConversionRate) {
                    for (const offer of ownedCreditOffers) {
                        if (String(offer.assetType) !== assetId) continue;
                        if (offer.enabled === false) continue;
                        const collateralMap = normalizeCollateralMap(offer.acceptableCollateral);
                        const rate = this._extractRateFromCollateralMap(collateralMap, expectedCollateralId, debtAssetResolved, collateralAssetResolved);
                        if (rate === null) continue;
                        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
                        this.state.positions[posKey].creditConversionRate = rate;
                        this.state.positions[posKey].creditConversionRateAt = Date.now();
                        break;
                    }
                }
            }
        }

        const activeDeals: UnknownRecord[] = [];
        for (const deal of normalizedDeals) {
            if (String(deal.debtAssetId) !== assetId) {
                continue;
            }
            if (expectedCollateralId && deal.collateralAssetId && String(deal.collateralAssetId) !== expectedCollateralId) {
                activeDeals.push({
                    ...deal,
                    offerEnabled: false,
                    offerFeeRate: deal.feeRate,
                    canReborrow: false,
                    collateralMismatch: true,
                });
                continue;
            }
            const offer = deal.offerId ? trackedOffers.get(String(deal.offerId)) : null;
            const validation = this._validateCreditPolicy(lendingItem, offer, deal as unknown as UnknownRecord);
            if (!validation.allow) {
                continue;
            }
            activeDeals.push({
                ...deal,
                offerEnabled: !!offer?.enabled,
                offerFeeRate: toFiniteNumber(offer?.fee_rate, deal.feeRate) || deal.feeRate,
                offerMaxDurationSeconds: toFiniteNumber(offer?.max_duration_seconds, undefined),
                canReborrow: !!offer?.enabled,
            });
        }

        const activeDealIds = activeDeals.map((deal) => deal.id).filter(Boolean);
        const activeOfferIds = Array.from(new Set(activeDeals.map((deal) => deal.offerId).filter(Boolean)));

        if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
        this.state.positions[posKey].creditDeals = activeDeals;
        this.state.positions[posKey].activeDealIds = activeDealIds;
        this.state.positions[posKey].activeOfferIds = activeOfferIds;

        this._rebuildCreditTrackingFromPositions();

        this.state.ownedCreditOffers = ownedCreditOffers as unknown as Record<string, unknown>[];
        this.state.lastBorrowRequest = this.state.lastBorrowRequest || null;
        this.state.reborrowPending = Array.isArray(this.state.pendingReborrows) && this.state.pendingReborrows.length > 0;

        return this.state;
    }

    async refreshState(): Promise<unknown> {
        this._assetCache.clear();
        this._objectCache.clear();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        await this.loadState();
        const dp = this.debtPolicy;
        if (!dp || !Array.isArray(dp.lending)) {
            return this.persistState('refresh');
        }

        const allDeals = await this._fetchBorrowerDeals();

        for (const item of dp.lending) {
            if (item.type === 'mpa') {
                await this.refreshMpaState(item);
            } else if (item.type === 'creditOffer') {
                await this.refreshCreditState({ deals: allDeals }, item);
            }
        }
        await this._pruneCreditStateForPolicy(dp.lending);
        await this._calculateCollateralDistribution();
        this._rebuildCreditTrackingFromPositions();

        this.state.debtSnapshot = await this._buildDebtSnapshot();
        this._fullAccountCache = null;
        this._borrowerDealsCache = null;
        return this.persistState('refresh');
    }

    async _buildMpaPlanFromState(lendingItem: UnknownRecord, assetId: unknown): Promise<UnknownRecord | null> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_buildMpaPlanFromState requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_buildMpaPlanFromState requires an assetId');
        }
        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const collateralAssetId = collateralAsset?.id;
        const posKey = collateralAssetId ? this._positionKey(assetId, collateralAssetId) : String(assetId);
        const posState = this.state.positions[posKey];
        if (!posState) return null;

        if (posState.mpaSelectionConflict) {
            return { blocked: true, reason: posState.mpaSelectionConflict };
        }
        const plan = buildDebtFirstCrPlan({
            currentCollateralAmount: posState.currentCollateralAmount,
            currentDebtAmount: posState.currentDebtAmount,
            feedPrice: posState.feedPrice,
            minCollateralRatio: lendingItem.minCollateralRatio as number | undefined,
            maxCollateralRatio: lendingItem.maxCollateralRatio as number | undefined,
            targetCollateralRatio: lendingItem.targetCollateralRatio as number | undefined,
            maxBorrowAmount: lendingItem.maxBorrowAmount as number | undefined,
            maxBorrowAmountPerOperation: lendingItem.maxBorrowAmountPerOperation as number | undefined,
            maxCollateralAmount: (posState.assignedCollateralBudget ?? lendingItem.maxCollateralAmount) as number | undefined,
            collateralLimitReferenceAmount: posState.currentCollateralFundsTotal,
            minCollateralIncreaseThreshold: lendingItem.minCollateralIncreaseThreshold as number | undefined,
            debtOnly: lendingItem.debtOnly as boolean | undefined,
        });

        if (!plan) return null;
        if (plan.blocked) return plan;
        return plan;
    }

    async buildMpaUpdateOperation(plan: UnknownRecord, options: UnknownRecord = {}, lendingItem: UnknownRecord, assetId: unknown): Promise<UnknownRecord | null> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('buildMpaUpdateOperation requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('buildMpaUpdateOperation requires an assetId');
        }
        const policy = lendingItem;

        if (!policy || !plan) return null;
        if (plan.blocked) {
            throw new Error(String(plan.reason || 'MPA plan blocked'));
        }

        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const collateralAssetId = collateralAsset?.id;
        const posKey = collateralAssetId ? this._positionKey(assetId, collateralAssetId) : String(assetId);
        const posState = this.state.positions[posKey];
        if (!posState) return null;

        const leg = options.leg || 'combined';

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for MPA update');
        }

        const debtAsset = posState.debtAssetId ? await this._resolveAsset(posState.debtAssetId) : null;
        const account = await this._getFullAccount(getAccountRef(this.bot));
        const currentCallOrder = (parseCallOrders(account) as Array<{ id?: unknown; call_price?: { base?: { asset_id?: unknown } } }>).find((entry) => entry.id === posState.activeCallOrderId) || null;
        const callOrderCollateralAssetId = currentCallOrder?.call_price?.base?.asset_id || null;
        const callOrderCollateralAsset = callOrderCollateralAssetId ? await this._resolveAsset(callOrderCollateralAssetId) : null;

        if (!debtAsset || !callOrderCollateralAsset) {
            throw new Error('Unable to resolve MPA asset metadata');
        }

        const debtDelta = leg === 'collateral' ? 0 : plan.debtDelta;
        const collateralDelta = leg === 'debt' ? 0 : plan.collateralDelta;
        const debtInt = floatToBlockchainInt(debtDelta, Number(debtAsset.precision));
        const collateralInt = floatToBlockchainInt(collateralDelta, Number(callOrderCollateralAsset.precision));
        if (debtInt === 0 && collateralInt === 0) {
            return null;
        }

        const extensions: UnknownRecord = {};
        const targetCollateralRatio = toGrapheneCollateralRatio(plan.targetCollateralRatio);
        if (targetCollateralRatio !== null) {
            extensions.target_collateral_ratio = targetCollateralRatio;
        }

        return {
            op_name: 'call_order_update',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                funding_account: accountId,
                delta_collateral: toAmountObject(collateralInt, String(callOrderCollateralAsset.id)),
                delta_debt: toAmountObject(debtInt, String(debtAsset.id)),
                extensions,
            }
        };
    }

    async buildCreditOfferAcceptOperation({ offer, borrowAmount, collateralAmount, autoRepay = false, specificPolicy = null, pendingRepayAmount = null, pendingReleaseCollateralAmount = null, availableCollateralAmount = null }: { offer?: UnknownRecord | null; borrowAmount?: unknown; collateralAmount?: unknown; autoRepay?: boolean; specificPolicy?: UnknownRecord | null; pendingRepayAmount?: unknown; pendingReleaseCollateralAmount?: unknown; availableCollateralAmount?: number | null } = {}): Promise<UnknownRecord> {
        let policy = specificPolicy;
        if (!policy) {
            const dp = this.debtPolicy;
            const offerObj = typeof offer === 'object' ? offer : null;
            const offerDebtAssetId = offerObj?.asset_type || null;
            if (dp?.lending && offerDebtAssetId) {
                for (const item of dp.lending) {
                    if (item.type !== 'creditOffer') continue;
                    let cached = this._assetCache.get(String(item.asset));
                    if (!cached && item.asset) {
                        cached = (await this._resolveAsset(item.asset)) ?? undefined;
                    }
                    if (cached && String(cached.id) === String(offerDebtAssetId)) {
                        policy = item;
                        break;
                    }
                }
            }
        }
        if (!policy) {
            throw new Error('creditOffer policy missing');
        }
        const renewOnly = policy.renewOnly === true;
        const isReborrowContext = pendingRepayAmount !== null && pendingRepayAmount !== undefined
            || pendingReleaseCollateralAmount !== null && pendingReleaseCollateralAmount !== undefined;
        if (renewOnly && !isReborrowContext) {
            throw new Error('creditOffer policy is renewOnly; refusing standalone credit borrow');
        }

        const offerObj = typeof offer === 'object' ? offer : null;
        const offerId = offerObj?.id || offer;
        if (!offerId) {
            throw new Error('credit offer id is required');
        }

        const validation = this._validateCreditPolicy(policy as UnknownRecord, offerObj as UnknownRecord, null);
        if (!validation.allow) {
            throw new Error(String(validation.reason || 'credit offer rejected by policy'));
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit offer accept');
        }

        const debtAssetId = offerObj?.asset_type || null;
        const debtAsset = debtAssetId ? await this._resolveAsset(debtAssetId) : null;
        if (!debtAsset) {
            throw new Error('Unable to resolve debt asset metadata for credit offer');
        }

        const collateralMap = normalizeCollateralMap(offerObj?.acceptable_collateral);
        const collateralSpec = normalizeAmountSpec(collateralAmount);
        const collateralAssetId = collateralSpec?.assetId || offerObj?.collateral_asset_id || null;
        if (!collateralAssetId && collateralMap.size > 1) {
            throw new Error('collateral asset is required for multi-asset credit offers');
        }
        let collateralPrice = collateralAssetId ? collateralMap.get(String(collateralAssetId)) : null;
        if (!collateralPrice && collateralMap.size === 1 && !collateralAssetId) {
            collateralPrice = collateralMap.values().next().value;
        }
        if (!collateralPrice) {
            if (collateralAssetId && collateralMap.size > 0) {
                throw new Error(`collateral asset ${collateralAssetId} is not in offer ${offerId} acceptable_collateral`);
            }
            throw new Error('Unable to determine acceptable collateral for credit offer');
        }

        const inferredCollateralAssetId = collateralAssetId
            || (collateralMap.size === 1 ? collateralMap.keys().next().value : null)
            || getPriceQuoteAssetId(collateralPrice);
        const collateralAsset = await this._resolveAsset(inferredCollateralAssetId);
        if (!collateralAsset) {
            throw new Error('Unable to resolve collateral asset metadata for credit offer');
        }

        let borrowInt: number | null = null;
        let requiredCollateralInt: number | null = null;
        let requestedBorrowInt: number | null = null;
        let clampedByCollateral = false;
        const requestedBorrowAmount = borrowAmount !== undefined && borrowAmount !== null
            ? positiveOrNull(borrowAmount)
            : null;

        if (borrowAmount !== undefined && borrowAmount !== null && requestedBorrowAmount === null) {
            throw new Error('borrowAmount must be positive');
        }

        if (requestedBorrowAmount !== null) {
            borrowInt = floatToBlockchainInt(requestedBorrowAmount, Number(debtAsset.precision));
            if (!Number.isFinite(borrowInt) || borrowInt <= 0) {
                throw new Error('borrowAmount must be positive');
            }
            requestedBorrowInt = borrowInt;

            // A reborrow can only lock the collateral the repay just released.
            // If the requested borrow needs more than that (for example the
            // market moved against the collateral since the deal was opened),
            // scale the borrow down to what the budget supports instead of
            // emitting an op that cannot be collateralized.
            const hasCollateralBudget = availableCollateralAmount !== null && availableCollateralAmount !== undefined && availableCollateralAmount > 0;
            if (hasCollateralBudget) {
                const cappedBorrowInt = sharedCapBorrowToCollateral(
                    borrowInt,
                    availableCollateralAmount,
                    collateralPrice,
                    String(debtAsset.id),
                    String(collateralAsset.id),
                );
                if (cappedBorrowInt === null || cappedBorrowInt <= 0) {
                    throw new Error('released collateral cannot support any reborrow at offer price');
                }
                if (cappedBorrowInt < borrowInt) {
                    this.log(`credit runtime: shrinking reborrow from ${blockchainToFloat(borrowInt, Number(debtAsset.precision))} to ${blockchainToFloat(cappedBorrowInt, Number(debtAsset.precision))} — released collateral ${blockchainToFloat(availableCollateralAmount, Number(collateralAsset.precision))} ${collateralAsset.symbol} supports only that much`);
                    borrowInt = cappedBorrowInt;
                    clampedByCollateral = true;
                }
            }

            this._enforceMaxBorrowAmount(policy, borrowInt, debtAsset, { pendingRepayAmount });

            const minimumCollateralInt = this._calculateRequiredCollateral(borrowInt, collateralPrice, debtAsset, collateralAsset);
            const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                ? await this._getCollateralPercentageBase(accountId, String(collateralAsset.id))
                : null;
            requiredCollateralInt = collateralSpec?.amount !== null && collateralSpec?.amount !== undefined
                ? await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'total', referenceAmount: collateralReferenceAmount, referenceLabel: 'total collateral balance' })
                : minimumCollateralInt;

            // An explicit collateral amount (e.g. the deal's old collateral on a
            // renewal) acts as a floor: when the offer price moved against the
            // collateral and the budget (released + free collateral) allows it,
            // top it up to what the borrow actually requires instead of failing
            // or under-borrowing.
            if (hasCollateralBudget && minimumCollateralInt != null && requiredCollateralInt != null && requiredCollateralInt < minimumCollateralInt) {
                requiredCollateralInt = minimumCollateralInt;
            }

            // An explicit collateral amount (e.g. a percentage spec) may still
            // exceed the budget; cap it so the op cannot over-lock. Do
            // NOT recompute the borrow here — it was already clamped above and
            // must never grow back past the requested amount.
            if (hasCollateralBudget && requiredCollateralInt != null && requiredCollateralInt > availableCollateralAmount) {
                requiredCollateralInt = availableCollateralAmount;
            }

            if (minimumCollateralInt != null && requiredCollateralInt != null && requiredCollateralInt < minimumCollateralInt) {
                throw new Error(`collateral amount ${requiredCollateralInt} is below required collateral ${minimumCollateralInt}`);
            }
        } else {
            const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                ? await this._getCollateralPercentageBase(accountId, String(collateralAsset.id))
                : null;
            requiredCollateralInt = await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, { balanceField: 'total', referenceAmount: collateralReferenceAmount, referenceLabel: 'total collateral balance' });
            borrowInt = this._calculateBorrowAmountFromCollateral(requiredCollateralInt, collateralPrice, debtAsset, collateralAsset);
            requestedBorrowInt = borrowInt;
            if (borrowInt != null && Number.isFinite(borrowInt) && borrowInt > 0) {
                this._enforceMaxBorrowAmount(policy, borrowInt, debtAsset, { pendingRepayAmount });
            }
        }

        // Enforce per-operation borrow limit
        const maxPerOp = positiveOrNull(policy?.maxBorrowAmountPerOperation);
        if (maxPerOp !== null && borrowInt != null && borrowInt > 0) {
            const borrowFloat = blockchainToFloat(borrowInt, Number(debtAsset.precision));
            if (Number.isFinite(borrowFloat) && borrowFloat > maxPerOp) {
                throw new Error(`borrowAmount ${borrowFloat} exceeds maxBorrowAmountPerOperation ${maxPerOp}`);
            }
        }

        if (requiredCollateralInt == null || requiredCollateralInt <= 0) {
            throw new Error('Unable to determine collateral amount for credit offer');
        }

        if (borrowInt == null || borrowInt <= 0) {
            throw new Error('Unable to determine borrow amount from collateral amount');
        }

        await this._enforceMaxCollateralAmount(policy, requiredCollateralInt, collateralAsset, accountId, {
            pendingReleaseCollateralAmount,
        });

        const minDealAmount = toFiniteNumber(offerObj?.min_deal_amount, null);
        if (minDealAmount !== null && borrowInt < minDealAmount) {
            throw new Error(`borrowAmount ${borrowInt} is below min_deal_amount ${minDealAmount}`);
        }

        const maxFeeRatePerDayValue = positiveOrNull(policy.maxFeeRatePerDay) ?? this._getDefaultMaxFeeRatePerDay();
        const dailyRate = this._calculateDailyFeeRate(offerObj as UnknownRecord);
        if (dailyRate > maxFeeRatePerDayValue) {
            throw new Error(`offer daily fee rate ${dailyRate.toFixed(6)} exceeds maxFeeRatePerDay ${maxFeeRatePerDayValue}`);
        }

        const offerFeeRate = toFiniteNumber(offerObj?.fee_rate, 0) || 0;

        if (offerObj?.enabled === false) {
            throw new Error(`credit offer ${offerId} is disabled`);
        }

        const minDurationSeconds = positiveOrNull(policy.minDurationSeconds);
        const minDuration = minDurationSeconds !== null ? minDurationSeconds : 0;
        const policyCollateralAssetRef = policy.collateralAsset;
        if (policyCollateralAssetRef && collateralAsset?.id) {
            const policyCollateralAsset = await this._resolveAsset(policyCollateralAssetRef);
            if (policyCollateralAsset?.id && String(collateralAsset.id) !== String(policyCollateralAsset.id)) {
                throw new Error(`collateral asset ${collateralAsset.id} does not match policy.collateralAsset`);
            }
        }

        const maxCollateralRatioValue = positiveOrNull(policy.maxCollateralRatio);
        if (maxCollateralRatioValue === null) {
            throw new Error('creditOffer maxCollateralRatio is required');
        }

        const borrowAmountFloat = blockchainToFloat(borrowInt, Number(debtAsset.precision));
        const collateralValueInDebtAsset: number | null = await this._calculateCollateralValueInDebtAsset(requiredCollateralInt, collateralAsset, debtAsset, collateralPrice);
        const offerCollateralValueInDebtAsset: number | null = this._calculateCreditOfferCollateralValueInDebtAsset(requiredCollateralInt, collateralAsset, debtAsset, collateralPrice);
        if (collateralValueInDebtAsset == null || offerCollateralValueInDebtAsset == null || borrowAmountFloat <= 0 || collateralValueInDebtAsset <= 0 || offerCollateralValueInDebtAsset <= 0) {
            throw new Error(collateralAsset?.for_liquidity_pool
                ? 'Unable to value liquidity pool collateral for credit offer'
                : 'Unable to determine collateral value for credit offer');
        }

        const collateralRatio = collateralValueInDebtAsset / borrowAmountFloat;
        if (collateralRatio > maxCollateralRatioValue) {
            throw new Error(`collateral ratio ${collateralRatio} exceeds maxCollateralRatio ${maxCollateralRatioValue}`);
        }

        const extensions: UnknownRecord = {};
        const autoRepayValue = resolveAutoRepayValue(autoRepay);
        if (autoRepayValue > 0) {
            extensions.auto_repay = autoRepayValue;
        }

        const op = {
            op_name: 'credit_offer_accept',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                borrower: accountId,
                offer_id: offerId,
                borrow_amount: toAmountObject(borrowInt, String(debtAsset.id)),
                collateral: toAmountObject(requiredCollateralInt, String(collateralAsset.id)),
                max_fee_rate: offerFeeRate,
                min_duration_seconds: minDuration,
                extensions,
            }
        };

        this.state.lastBorrowRequest = {
            offerId: String(offerId),
            borrowAmount: borrowInt,
            requestedBorrowAmount: requestedBorrowInt,
            collateralAmount: requiredCollateralInt,
            clampedByCollateral,
            autoReborrow: !!policy?.autoReborrow,
            requestedAt: nowIso()
        };

        return op;
    }

    _calculateRequiredCollateral(borrowAmountInt: unknown, collateralPrice: Parameters<typeof sharedRequiredCollateralForBorrow>[1], debtAsset: UnknownRecord | null = null, collateralAsset: UnknownRecord | null = null): number | null {
        return sharedRequiredCollateralForBorrow(
            borrowAmountInt,
            collateralPrice,
            debtAsset?.id != null ? String(debtAsset.id) : null,
            collateralAsset?.id != null ? String(collateralAsset.id) : null,
        );
    }

    _calculateCreditFee(repayAmountInt: unknown, feeRate: unknown): number {
        return sharedCreditDealFee(repayAmountInt, feeRate, CREDIT_FEE_RATE_DENOM);
    }

    async buildCreditDealRepayOperation(deal: unknown, repayAmount: unknown): Promise<UnknownRecord> {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : null;
        if (!dealSummary) {
            throw new Error('credit deal is required');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit repay');
        }

        const debtAsset = await this._resolveAsset(dealSummary.debtAssetId);
        if (!debtAsset) {
            throw new Error('Unable to resolve debt asset metadata for credit repay');
        }

        const repayInt = floatToBlockchainInt(repayAmount, Number(debtAsset.precision));
        if (!Number.isFinite(repayInt) || repayInt <= 0) {
            throw new Error('repayAmount must be positive');
        }
        if (repayInt > dealSummary.debtAmount) {
            throw new Error(`repayAmount ${repayInt} exceeds unpaid amount ${dealSummary.debtAmount}`);
        }

        const creditFee = this._calculateCreditFee(repayInt, dealSummary.feeRate);

        return {
            op_name: 'credit_deal_repay',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                account: accountId,
                deal_id: dealSummary.id,
                repay_amount: toAmountObject(repayInt, String(debtAsset.id)),
                credit_fee: toAmountObject(creditFee, String(debtAsset.id)),
                extensions: [] as unknown,
            }
        };
    }

    async buildCreditDealUpdateOperation(deal: unknown, autoRepay: unknown): Promise<UnknownRecord> {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : null;
        if (!dealSummary) {
            throw new Error('credit deal is required');
        }

        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        if (!accountId) {
            throw new Error('Unable to resolve account for credit deal update');
        }

        return {
            op_name: 'credit_deal_update',
            op_data: {
                fee: { amount: 0, asset_id: ZERO_ASSET_ID },
                account: accountId,
                deal_id: dealSummary.id,
                auto_repay: resolveAutoRepayValue(autoRepay),
                extensions: [] as unknown,
            }
        };
    }

    async executeOperations(operations: unknown[], reason: string = 'credit runtime'): Promise<unknown> {
        if (!Array.isArray(operations) || operations.length === 0) {
            return { skipped: true, reason: 'no operations', operations: [] };
        }

        if (this.bot?.config?.dryRun) {
            return { dryRun: true, reason, operations: deepClone(operations) };
        }

        const accountName = await this._resolveAccountName(getAccountRef(this.bot));
        if (!accountName) {
            throw new Error('Unable to resolve account name for broadcast');
        }
        if (!this.bot?.privateKey) {
            throw new Error('Missing signing key for credit runtime broadcast');
        }

        return chainOrders.executeBatch(accountName, this.bot.privateKey, operations as Parameters<typeof chainOrders.executeBatch>[2]);
    }

    async _checkGridMaintenanceAfterCreditUpdate(context: unknown = 'credit capital update', options: UnknownRecord = {}): Promise<unknown> {
        const manager = this.bot?.manager;
        if (!this.bot || !manager) {
            return { skipped: true, reason: 'grid maintenance unavailable' };
        }

        const accountId = this.bot?.accountId || (this.bot?.account as unknown as { id?: string } | null)?.id || null;
        const lock = manager?._fillProcessingLock;
        const runCheck = async () => {
            if (typeof manager.fetchAccountTotals === 'function' && accountId) {
                await manager.fetchAccountTotals(accountId);
            }
            return this.bot._runGridMaintenance(context, {
                ...options,
            });
        };

        try {
            if (!lock || typeof lock.acquire !== 'function') {
                return await runCheck();
            }
            return await lock.acquire(runCheck);
        } catch (err) {
            this.warn(`credit runtime: post-credit grid maintenance failed during ${context}: ${getErrorMessage(err)}`);
            return { skipped: false, error: getErrorMessage(err) };
        }
    }


    async repayCreditDeal(deal: UnknownRecord, repayAmount: unknown, options: UnknownRecord = {}): Promise<unknown> {
        const dealSummary = typeof deal === 'object' ? parseDealSummary(deal) : await this._getDealById(deal);
        if (!dealSummary) {
            throw new Error('credit deal not found');
        }

        const repayOp = await this.buildCreditDealRepayOperation(dealSummary, repayAmount);
        const operations: unknown[] = [repayOp];
        const reborrowPolicy = (options.specificPolicy || await this._findLendingItemForAsset(dealSummary.debtAssetId, 'creditOffer') || {}) as UnknownRecord;
        let shouldAutoReborrow = options.autoReborrow !== false && !!reborrowPolicy.autoReborrow;
        if (shouldAutoReborrow) {
            const disallowedDealIds = this._normalizePolicyList(reborrowPolicy.disallowedDealIds);
            if (disallowedDealIds.length > 0 && dealSummary.id && disallowedDealIds.includes(String(dealSummary.id))) {
                shouldAutoReborrow = false;
            }
        }
        let deferredReborrowRequest: UnknownRecord | null = null;
        let inlineReborrowPlanned = false;
        let availableReborrowCollateralInt: number | null = null;
        let releasedReborrowCollateralInt: number | null = null;
        // Snapshot the deals that already exist before this repay broadcasts.
        // A later pending reborrow can then distinguish a genuine replacement
        // (a deal that appeared after the repay) from a sibling deal that was
        // already present on the same offer and must not suppress the reborrow.
        const preRepayDealIds = this._collectActiveDealIds();

        if (shouldAutoReborrow) {
            // Collateral this repay frees — the baseline of the ceiling a
            // reborrow may lock. By default the borrower's free balance of the
            // same collateral is added to the budget so the reborrow can keep
            // the original principal when the offer's collateral price moved;
            // `useFreeCollateral: false` restores the released-only ceiling.
            const useFreeCollateral = options.useFreeCollateral !== undefined
                ? options.useFreeCollateral === true
                : resolveUseFreeCollateral(reborrowPolicy);
            const offer = await this._getOfferById(dealSummary.offerId);
            const collateralBudget = await this._computeCollateralBudget(dealSummary, repayAmount, {
                ...options,
                useFreeCollateral,
                offer,
            });
            availableReborrowCollateralInt = collateralBudget.budget;
            releasedReborrowCollateralInt = collateralBudget.released;
            const reborrowAmount = options.reborrowAmount !== undefined && options.reborrowAmount !== null
                ? options.reborrowAmount
                : repayAmount;
            let reborrowCollateralAmount: number | UnknownRecord | null = options.collateralAmount !== undefined
                ? (options.collateralAmount as number | UnknownRecord)
                : null;
            if (reborrowCollateralAmount !== null && dealSummary.collateralAssetId) {
                const isBare = typeof reborrowCollateralAmount === 'number'
                    || (typeof reborrowCollateralAmount === 'object' && (reborrowCollateralAmount as UnknownRecord).assetId == null);
                if (isBare) {
                    const amountVal = typeof reborrowCollateralAmount === 'number'
                        ? reborrowCollateralAmount
                        : ((reborrowCollateralAmount as UnknownRecord).amount ?? null);
                    reborrowCollateralAmount = { amount: amountVal, assetId: dealSummary.collateralAssetId };
                }
            }
            let effectiveCollateralAssetId = dealSummary.collateralAssetId;
            if (options.collateralAsset && dealSummary.collateralAssetId) {
                const overrideId = typeof options.collateralAsset === 'object'
                    ? ((options.collateralAsset as UnknownRecord).id ?? (options.collateralAsset as UnknownRecord).asset_id ?? null)
                    : options.collateralAsset;
                if (overrideId && String(overrideId) !== String(dealSummary.collateralAssetId)) {
                    const amountVal = reborrowCollateralAmount === null
                        ? null
                        : (typeof reborrowCollateralAmount === 'number'
                            ? reborrowCollateralAmount
                            : ((reborrowCollateralAmount as UnknownRecord).amount ?? null));
                    reborrowCollateralAmount = { amount: amountVal, assetId: overrideId };
                    effectiveCollateralAssetId = overrideId;
                }
            }
            const policyHasAutoRepay = Object.prototype.hasOwnProperty.call(reborrowPolicy, 'autoRepay');
            const autoRepaySetting = (options.autoRepay !== undefined
                ? options.autoRepay
                : (policyHasAutoRepay ? reborrowPolicy.autoRepay : (dealSummary.autoRepay ?? false))) as boolean;
            const selectFallbackReborrow = async (deferReason: string, selectionNote: string): Promise<void> => {
                const fallback = await this._selectFallbackCreditOffer({
                    debtAssetId: dealSummary.debtAssetId,
                    collateralAssetId: effectiveCollateralAssetId,
                    policy: reborrowPolicy,
                    borrowAmount: reborrowAmount,
                    collateralAmount: reborrowCollateralAmount,
                    autoRepay: autoRepaySetting,
                    pendingRepayAmount: repayAmount,
                    pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                    availableCollateralAmount: availableReborrowCollateralInt,
                    excludeOfferId: dealSummary.offerId,
                });
                if (fallback) {
                    this.warn(`credit runtime: fallback reborrow offer ${fallback.offer.id} selected ${selectionNote}`);
                    operations.push(fallback.op);
                    inlineReborrowPlanned = true;
                    return;
                }
                deferredReborrowRequest = {
                    sourceDealId: dealSummary.id,
                    offerId: dealSummary.offerId,
                    borrowAmount: reborrowAmount,
                    collateralAmount: reborrowCollateralAmount,
                    autoRepay: autoRepaySetting,
                    specificPolicy: reborrowPolicy,
                    preRepayDealIds,
                    availableCollateralAmount: availableReborrowCollateralInt,
                    releasedCollateralAmount: releasedReborrowCollateralInt,
                    useFreeCollateral,
                    collateralAssetId: effectiveCollateralAssetId,
                    debtAssetId: dealSummary.debtAssetId,
                    pendingRepayAmount: repayAmount,
                    pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                    requestedAt: nowIso(),
                    reason: deferReason,
                };
            };
            if (offer) {
                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: reborrowAmount,
                        collateralAmount: reborrowCollateralAmount,
                        autoRepay: autoRepaySetting,
                        specificPolicy: options.specificPolicy as UnknownRecord | null | undefined,
                        pendingRepayAmount: repayAmount,
                        pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                        availableCollateralAmount: availableReborrowCollateralInt,
                    });
                    operations.push(acceptOp);
                    inlineReborrowPlanned = true;
                } catch (err) {
                    await selectFallbackReborrow(
                        getErrorMessage(err),
                        `after original offer ${dealSummary.offerId} failed: ${getErrorMessage(err)}`,
                    );
                }
            } else {
                await selectFallbackReborrow(
                    'offer unavailable',
                    `because original offer ${dealSummary.offerId} is unavailable`,
                );
            }
        }

        const result = await this.executeOperations(operations, 'credit repay');
        this.state.lastRepayAt = nowIso();
        const onChainDeals = await this._fetchBorrowerDeals();
        const sourceDealStillActive = onChainDeals.some((entry) => String(entry?.id) === String(dealSummary.id));
        await this.refreshState();
        if (shouldAutoReborrow && !inlineReborrowPlanned && !sourceDealStillActive) {
            const reborrowOffer = await this._getOfferById(dealSummary.offerId);
            const fallbackUseFreeCollateral = options.useFreeCollateral !== undefined
                ? options.useFreeCollateral === true
                : resolveUseFreeCollateral(reborrowPolicy);
            const fallbackCollateralAssetId = options.collateralAsset ?? dealSummary.collateralAssetId ?? null;
            const reborrowRequest: UnknownRecord = deferredReborrowRequest || {
                sourceDealId: dealSummary.id,
                offerId: dealSummary.offerId,
                borrowAmount: options.reborrowAmount !== undefined && options.reborrowAmount !== null
                    ? options.reborrowAmount
                    : repayAmount,
                collateralAmount: options.collateralAmount !== undefined ? options.collateralAmount : null,
                autoRepay: options.autoRepay !== undefined
                    ? options.autoRepay
                    : (Object.prototype.hasOwnProperty.call(reborrowPolicy, 'autoRepay')
                        ? reborrowPolicy.autoRepay
                        : (dealSummary.autoRepay ?? false)),
                specificPolicy: reborrowPolicy,
                preRepayDealIds,
                availableCollateralAmount: availableReborrowCollateralInt,
                releasedCollateralAmount: releasedReborrowCollateralInt,
                useFreeCollateral: fallbackUseFreeCollateral,
                collateralAssetId: fallbackCollateralAssetId,
                debtAssetId: dealSummary.debtAssetId,
                pendingRepayAmount: repayAmount,
                pendingReleaseCollateralAmount: options.pendingReleaseCollateralAmount,
                requestedAt: nowIso(),
                reason: (deferredReborrowRequest as UnknownRecord | null)?.reason || null,
            };
            if (reborrowOffer) {
                try {
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer: reborrowOffer,
                        borrowAmount: reborrowRequest.borrowAmount,
                        collateralAmount: reborrowRequest.collateralAmount,
                        autoRepay: reborrowRequest.autoRepay as boolean | undefined,
                        specificPolicy: reborrowRequest.specificPolicy as UnknownRecord | null | undefined,
                        pendingReleaseCollateralAmount: reborrowRequest.pendingReleaseCollateralAmount,
                        availableCollateralAmount: (reborrowRequest.availableCollateralAmount as number | null) ?? null,
                    });
                    await this.executeOperations([acceptOp], 'credit reborrow');
                    await this.refreshState();
                    deferredReborrowRequest = null;
                } catch (err) {
                    this.queueReborrow({
                        ...reborrowRequest,
                        reason: getErrorMessage(err),
                    });
                }
            } else {
                this.queueReborrow({
                    ...reborrowRequest,
                    reason: 'offer unavailable',
                });
            }
        } else if (shouldAutoReborrow && deferredReborrowRequest && !inlineReborrowPlanned && !sourceDealStillActive) {
            this.queueReborrow(deferredReborrowRequest);
        } else if (shouldAutoReborrow && deferredReborrowRequest && !inlineReborrowPlanned && sourceDealStillActive) {
            this.warn(`credit runtime: deferred reborrow for deal ${dealSummary.id} dropped — source deal still active on-chain after repay`);
        }
        await this._checkGridMaintenanceAfterCreditUpdate('credit capital update');
        await this.persistState('credit repay');
        return result;
    }

    queueReborrow(request: UnknownRecord): void {
        if (!request || typeof request !== 'object') return;
        this.state.pendingReborrows = Array.isArray(this.state.pendingReborrows) ? this.state.pendingReborrows : [];
        this.state.pendingReborrows.push({
            sourceDealId: request.sourceDealId || null,
            offerId: request.offerId || null,
            borrowAmount: request.borrowAmount ?? null,
            collateralAmount: request.collateralAmount ?? null,
            autoRepay: request.autoRepay ?? false,
            specificPolicy: request.specificPolicy || null,
            preRepayDealIds: Array.isArray(request.preRepayDealIds) ? request.preRepayDealIds.map((id: unknown) => String(id)) : null,
            availableCollateralAmount: request.availableCollateralAmount ?? null,
            releasedCollateralAmount: request.releasedCollateralAmount ?? null,
            useFreeCollateral: request.useFreeCollateral !== false,
            collateralAssetId: request.collateralAssetId ?? null,
            debtAssetId: request.debtAssetId ?? null,
            reborrowAttempts: Number(request.reborrowAttempts) || 0,
            pendingRepayAmount: request.pendingRepayAmount ?? null,
            pendingReleaseCollateralAmount: request.pendingReleaseCollateralAmount ?? null,
            requestedAt: request.requestedAt || nowIso(),
            reason: request.reason || null,
        });
        this.state.reborrowPending = this.state.pendingReborrows.length > 0;
    }

    _extractDealNumericId(id: unknown): number {
        if (!id) return 0;
        const parts = String(id).split('.');
        const num = Number(parts[parts.length - 1]);
        return Number.isFinite(num) ? num : 0;
    }

    _collectActiveDealIds(): string[] {
        // state.creditDeals is the flattened mirror of positions[*].creditDeals
        // rebuilt after every refresh, so it is the single source of truth here.
        const ids = new Set<string>();
        const deals = Array.isArray(this.state.creditDeals) ? this.state.creditDeals : [];
        for (const deal of deals) {
            const id = (deal as UnknownRecord | null)?.id;
            if (id) ids.add(String(id));
        }
        return Array.from(ids);
    }

    /**
     * Pick a balance entry from a `getOnChainAssetBalances` result by asset id,
     * falling back to the asset symbol. Centralizes the lookup shape shared by
     * the percentage/amount resolvers and the credit helpers.
     */
    _pickOnChainBalanceEntry(balances: unknown, assetId: unknown, asset: UnknownRecord | null): UnknownRecord | null {
        const balanceMap = balances as Record<string, unknown> | null | undefined;
        const symbol = (asset as { symbol?: unknown } | null)?.symbol;
        return (balanceMap?.[String(assetId)]
            || (symbol != null ? balanceMap?.[String(symbol)] : undefined)
            || null) as UnknownRecord | null;
    }

    /**
     * Read the chain-free balance of the debt asset. Returns null when the
     * balance cannot be determined so callers can fall back to the legacy
     * (full-deal) renewal path instead of guessing.
     */
    async _getFreeDebtAssetBalance(debtAssetId: unknown, debtAsset: UnknownRecord | null): Promise<number | null> {
        const accountRef = getAccountRef(this.bot);
        if (!accountRef || !debtAssetId) return null;
        try {
            const balances = await chainOrders.getOnChainAssetBalances(accountRef, [String(debtAssetId)]);
            const entry = this._pickOnChainBalanceEntry(balances, debtAssetId, debtAsset);
            const free = toFiniteNumber(entry?.free, NaN);
            return Number.isFinite(free) ? free : null;
        } catch (err) {
            this.warn(`credit runtime: unable to read free balance for ${String(debtAssetId)}: ${getErrorMessage(err)}`);
            return null;
        }
    }

    /**
     * Read the chain-free balance of a collateral asset. Mirrors
     * `_getFreeDebtAssetBalance`; returns null when it cannot be determined.
     */
    async _getFreeCollateralBalance(collateralAssetId: unknown, collateralAsset: UnknownRecord | null): Promise<number | null> {
        const accountRef = getAccountRef(this.bot);
        if (!accountRef || !collateralAssetId) return null;
        try {
            const balances = await chainOrders.getOnChainAssetBalances(accountRef, [String(collateralAssetId)]);
            const entry = this._pickOnChainBalanceEntry(balances, collateralAssetId, collateralAsset);
            const free = toFiniteNumber(entry?.free, NaN);
            return Number.isFinite(free) ? free : null;
        } catch (err) {
            this.warn(`credit runtime: unable to read free collateral balance for ${String(collateralAssetId)}: ${getErrorMessage(err)}`);
            return null;
        }
    }

    /**
     * Highest raw collateral this deal's position may hold, from the position's
     * `assignedCollateralBudget`. The renewed deal is one member of the
     * position, so its ceiling is the budget minus the collateral the position's
     * other deals already hold. Returns null when no budget is known.
     */
    _positionCollateralCapInt(dealSummary: DealSummary | UnknownRecord | null, collateralAsset: UnknownRecord | null, releasedInt: number): number | null {
        const collateralPrecision = getAssetPrecision(collateralAsset);
        if (collateralPrecision === null || !collateralAsset?.id) return null;
        const posKey = this._positionKey(dealSummary?.debtAssetId, collateralAsset.id);
        const posState = this.state?.positions?.[posKey] as UnknownRecord | undefined;
        const assignedBudget = positiveOrNull(posState?.assignedCollateralBudget);
        if (assignedBudget === null) return null;
        const deals = Array.isArray(posState?.creditDeals) ? (posState.creditDeals as UnknownRecord[]) : [];
        const positionCollateral = deals.reduce(
            (sum, d) => sum + (blockchainAmountToFloat(d?.collateralAmount, collateralAsset) || 0),
            0,
        );
        const releasedFloat = blockchainToFloat(releasedInt, collateralPrecision);
        const otherLocked = Math.max(0, positionCollateral - releasedFloat);
        const headroom = Math.max(releasedFloat, assignedBudget - otherLocked);
        const capInt = floatToBlockchainInt(headroom, collateralPrecision);
        return Number.isFinite(capInt) && capInt > 0 ? capInt : null;
    }

    /**
     * Raw collateral available to a reborrow, as `{ released, budget }`:
     *   - `released` — the portion freed by this repay (the collateral floor),
     *   - `budget`   — the ceiling the new accept may lock: the released portion
     *                  plus the borrower's free balance of the same asset (when
     *                  `useFreeCollateral` is on, the default), bounded by the
     *                  position's `assignedCollateralBudget`.
     * Precedence for `released`:
     *   1. explicit raw `options.availableCollateralAmount` (collateral-switch flow),
     *   2. exact on-chain `floor(repay * collateral / debt)` when the deal's own
     *      collateral asset is used,
     *   3. explicit `options.pendingReleaseCollateralAmount` (float) as a fallback.
     * Returns `{ released: null, budget: null }` when it cannot be determined, so
     * the accept builder keeps the legacy (unclamped) behaviour.
     */
    async _computeCollateralBudget(dealSummary: DealSummary | UnknownRecord | null, repayAmount: unknown, options: UnknownRecord): Promise<{ released: number | null; budget: number | null }> {
        // 1. Explicit raw budget (collateral-switch flow) wins. Return no
        //    `released` base: this snapshot is the account's total balance of the
        //    new collateral, not collateral freed by a repay, so a deferred retry
        //    must not add the free balance on top (double count). With a null
        //    base, `_refreshReborrowBudget` reuses the stored budget unchanged.
        const explicitRaw = toFiniteNumber(options?.availableCollateralAmount, null);
        if (explicitRaw !== null && explicitRaw > 0) {
            return { released: null, budget: Math.floor(explicitRaw) };
        }

        const effectiveCollateralAssetId = options?.collateralAsset ?? dealSummary?.collateralAssetId ?? null;
        const dealCollateralAssetId = dealSummary?.collateralAssetId ?? null;
        const sameCollateralAsset = !dealCollateralAssetId || !effectiveCollateralAssetId
            || String(dealCollateralAssetId) === String(effectiveCollateralAssetId);
        if (!sameCollateralAsset) return { released: null, budget: null };

        const collateralAsset = effectiveCollateralAssetId ? await this._resolveAsset(effectiveCollateralAssetId) : null;
        const collateralPrecision = getAssetPrecision(collateralAsset);
        const collateralAssetId = effectiveCollateralAssetId ?? dealCollateralAssetId;
        const debtAsset = await this._resolveAsset(dealSummary?.debtAssetId);
        const debtPrecision = getAssetPrecision(debtAsset);

        // 2. Exact on-chain release: floor(repay * collateral / debt), matching
        //    credit_deal_repay_evaluator::do_apply. Preferred over the float
        //    fallback so the budget never over-states the freed collateral.
        let released: number | null = null;
        if (debtPrecision !== null) {
            const repayInt = floatToBlockchainInt(repayAmount, debtPrecision);
            const debtInt = toFiniteNumber(dealSummary?.debtAmount, 0);
            const collateralInt = toFiniteNumber(dealSummary?.collateralAmount, 0);
            if (Number.isFinite(repayInt) && repayInt > 0 && debtInt > 0 && collateralInt > 0) {
                const value = Math.floor(collateralInt * Math.min(repayInt, debtInt) / debtInt);
                if (value > 0) released = value;
            }
        }

        // 3. Fallback when raw deal amounts are unavailable: use an explicit
        //    released float, floored at the collateral precision.
        if ((released === null || released <= 0) && collateralPrecision !== null
            && options?.pendingReleaseCollateralAmount !== null && options?.pendingReleaseCollateralAmount !== undefined) {
            const explicitFloat = toFiniteNumber(options.pendingReleaseCollateralAmount, null);
            if (explicitFloat !== null && explicitFloat > 0) {
                const value = floorToBlockchainInt(explicitFloat, collateralPrecision);
                if (Number.isFinite(value) && value > 0) released = value;
            }
        }

        if (released === null || released <= 0) return { released: null, budget: null };

        let budget = released;
        if (options?.useFreeCollateral !== false && collateralPrecision !== null) {
            // Skip the chain read when the released collateral already backs the
            // requested reborrow at the offer price (no price move against us).
            let needsFree = true;
            const offer = options?.offer as UnknownRecord | null | undefined;
            const repayFloat = toFiniteNumber(repayAmount, null);
            // Compare against the actual reborrow, not the repay: a caller may
            // request a larger reborrow than it repays.
            const reborrowFloat = toFiniteNumber(options?.reborrowAmount, null) ?? repayFloat;
            if (offer && reborrowFloat !== null) {
                const collateralMap = normalizeCollateralMap(offer.acceptable_collateral);
                const offerRate = this._extractRateFromCollateralMap(collateralMap, String(collateralAssetId), debtAsset, collateralAsset);
                const releasedFloat = blockchainToFloat(released, collateralPrecision);
                if (offerRate !== null && releasedFloat > 0 && offerRate >= reborrowFloat / releasedFloat) {
                    needsFree = false;
                }
            }
            if (needsFree) {
                const free = await this._getFreeCollateralBalance(collateralAssetId, collateralAsset);
                if (free !== null) {
                    const freeInt = floatToBlockchainInt(free, collateralPrecision);
                    if (Number.isFinite(freeInt) && freeInt > 0) budget = released + freeInt;
                }
            }
        }

        // Never top up past the position's assigned collateral budget.
        const capInt = this._positionCollateralCapInt(dealSummary, collateralAsset, released);
        if (capInt !== null) budget = Math.min(budget, capInt);

        return { released, budget };
    }

    /**
     * Recompute a persisted pending reborrow's collateral budget from its stored
     * released base, the current free balance, and the current position budget —
     * not the snapshot taken when it was queued. If the free balance shrank after
     * deferral the ceiling drops (no over-lock / on-chain failure); if it grew the
     * ceiling rises (no unnecessary clamp). Entries without a released base —
     * legacy ones and the collateral-switch flow, whose budget is the new asset's
     * total balance, not freed collateral — keep their stored budget unchanged.
     */
    async _refreshReborrowBudget(request: UnknownRecord | null): Promise<number | null> {
        const stored = toFiniteNumber(request?.availableCollateralAmount, null);
        const released = toFiniteNumber(request?.releasedCollateralAmount, null);
        if (released === null || released <= 0) return stored;
        const assetId = request?.collateralAssetId ?? null;
        const asset = assetId ? await this._resolveAsset(assetId) : null;
        const precision = getAssetPrecision(asset);
        if (precision === null || !assetId) return stored ?? released;
        let budget = released;
        if (request?.useFreeCollateral !== false) {
            const free = await this._getFreeCollateralBalance(assetId, asset);
            if (free !== null) {
                const freeInt = floatToBlockchainInt(free, precision);
                if (Number.isFinite(freeInt) && freeInt > 0) budget = released + freeInt;
            }
        }
        // Re-derive the position ceiling from current state rather than the
        // queue-time snapshot; `_positionCollateralCapInt` floors at `released`.
        const debtAssetId = request?.debtAssetId ?? null;
        if (debtAssetId) {
            const capInt = this._positionCollateralCapInt({ debtAssetId }, asset, released);
            if (capInt !== null) budget = Math.min(budget, capInt);
        } else if (stored !== null) {
            budget = Math.min(budget, stored);
        }
        return budget;
    }

    /**
     * Decide how much of a maturing deal can actually be repaid and reborrowed
     * with the currently free debt-asset balance. The repay leg is funded from
     * the borrower's free balance before the atomic reborrow returns anything,
     * so when the borrowed asset has been deployed into the grid the full deal
     * cannot be renewed in one shot. In that case we roll the largest affordable
     * piece (bounded by min_deal_amount and maxBorrowAmountPerOperation) and let
     * the remaining debt be handled on the next cycle.
     *
     * Returns null when sizing is not possible (unknown balance / malformed
     * deal) so the caller keeps the existing full-renewal behaviour.
     */
    async _resolveRenewalSizing({ deal, debtAsset, offer, policy }: { deal: UnknownRecord | null; debtAsset: UnknownRecord | null; offer: UnknownRecord | null; policy: UnknownRecord | null }): Promise<UnknownRecord | null> {
        const fullAmount = blockchainAmountToFloat(deal?.debtAmount, debtAsset);
        if (fullAmount == null || fullAmount <= 0) return null;
        const feeRate = Number(deal?.feeRate) || 0;
        const free = await this._getFreeDebtAssetBalance(deal?.debtAssetId, debtAsset);
        if (free === null) return null;

        // Work in raw debt units and reuse the on-chain (ceil) fee helper so the
        // sizing matches what the repay will actually require.
        const precisionRaw = Number((debtAsset as { precision?: unknown } | null)?.precision);
        const decimals = Number.isFinite(precisionRaw) && precisionRaw >= 0 ? Math.trunc(precisionRaw) : 0;
        const fullInt = floorToBlockchainInt(fullAmount, decimals);
        const freeInt = floorToBlockchainInt(free, decimals);
        const requiredInt = fullInt + sharedCreditDealFee(fullInt, feeRate, CREDIT_FEE_RATE_DENOM);
        const required = blockchainToFloat(requiredInt, decimals);
        const spendableInt = freeInt - CREDIT_REBORROW_FREE_BALANCE_BUFFER_INT;
        if (spendableInt >= requiredInt) {
            return { partial: false, amount: fullAmount, free, required };
        }

        const minDealInt = toFiniteNumber(offer?.min_deal_amount, null);
        const minDeal = minDealInt !== null ? blockchainToFloat(minDealInt, decimals) : null;

        // Start from an upper estimate and step down until piece + ceil(fee)
        // fits the spendable balance; the loop runs at most a couple of iterations.
        let pieceInt = spendableInt > 0 ? Math.ceil(spendableInt / (1 + feeRate / CREDIT_FEE_RATE_DENOM)) : 0;
        while (pieceInt > 0 && pieceInt + sharedCreditDealFee(pieceInt, feeRate, CREDIT_FEE_RATE_DENOM) > spendableInt) {
            pieceInt -= 1;
        }
        const maxPerOp = positiveOrNull(policy?.maxBorrowAmountPerOperation);
        if (maxPerOp !== null && maxPerOp > 0) {
            const maxPerOpInt = floorToBlockchainInt(maxPerOp, decimals);
            if (maxPerOpInt < pieceInt) pieceInt = maxPerOpInt;
        }
        const affordable = blockchainToFloat(pieceInt, decimals);

        if (
            !Number.isFinite(affordable)
            || affordable <= 0
            || (minDeal !== null && minDeal > 0 && affordable < minDeal)
        ) {
            return { partial: false, insufficient: true, amount: 0, free, required, minDeal };
        }
        if (affordable >= fullAmount) {
            return { partial: false, amount: fullAmount, free, required };
        }
        return { partial: true, amount: affordable, free, required, minDeal };
    }

    async _getOfferById(offerId: unknown): Promise<UnknownRecord | null> {
        if (!offerId) return null;
        const cacheKey = `offer:${offerId}`;
        const cached = this._objectCache.get(cacheKey);
        if (cached) {
            // Check TTL: re-fetch from chain if the cached offer is too old.
            // Offers rarely change their min_deal_amount, so a moderate TTL
            // (OFFER_CACHE_TTL_MS, default 10min) balances freshness with RPC
            // load. Without this guard, a stale cached min_deal_amount could
            // cause deal-split guards to pass against a value that no longer
            // holds on-chain.
            const OFFER_CACHE_TTL_MS = require('./constants').TIMING.OFFER_CACHE_TTL_MS;
            const cachedAt = Number(cached._cachedAt) || 0;
            if (Date.now() - cachedAt < OFFER_CACHE_TTL_MS) {
                return cached;
            }
            // Expired: fall through to re-fetch
            this._objectCache.delete(cacheKey);
        }
        const objects = await this._dbCall('get_objects', [[offerId]]);
        const offer = Array.isArray(objects) ? objects[0] : null;
        if (offer) {
            this._objectCache.set(cacheKey, { ...offer, _cachedAt: Date.now() });
        }
        return offer;
    }

    async _fetchCreditOffersByAsset(assetId: unknown): Promise<UnknownRecord[]> {
        if (!assetId) return [];
        try {
            const limit = 100;
            const offers: UnknownRecord[] = [];
            const seen = new Set<string>();
            let startId: string | null = null;
            for (let pageCount = 0; pageCount < 50; pageCount++) {
                const args = startId ? [assetId, limit, startId] : [assetId, limit];
                const page = await this._dbCall('get_credit_offers_by_asset', args);
                if (!Array.isArray(page) || page.length === 0) break;
                let added = 0;
                for (const offer of page) {
                    if (!offer?.id || seen.has(String(offer.id))) continue;
                    seen.add(String(offer.id));
                    offers.push(offer);
                    added++;
                }
                const lastId = page[page.length - 1]?.id;
                if (!lastId || page.length < limit || added === 0) break;
                startId = lastId;
            }
            return offers;
        } catch (err) {
            this.warn(`credit runtime: unable to fetch fallback credit offers for ${assetId}: ${getErrorMessage(err)}`);
            return [];
        }
    }

    async _resolveFallbackAssetIds(policy: UnknownRecord, offer: UnknownRecord | null = null): Promise<{ debtAssetId: string | null; collateralAssetId: string | null }> {
        const debtAsset = offer?.asset_type
            ? await this._resolveAsset(offer.asset_type)
            : await this._resolveAsset(policy?.asset);
        const collateralAsset = policy?.collateralAsset
            ? await this._resolveAsset(policy.collateralAsset)
            : null;
        return {
            debtAssetId: debtAsset?.id ? String(debtAsset.id) : null,
            collateralAssetId: collateralAsset?.id ? String(collateralAsset.id) : null,
        };
    }

    async _selectFallbackCreditOffer({ debtAssetId, collateralAssetId, policy, borrowAmount, collateralAmount, autoRepay, pendingRepayAmount = null, pendingReleaseCollateralAmount, availableCollateralAmount = null, excludeOfferId = null }: { debtAssetId?: unknown; collateralAssetId?: unknown; policy?: UnknownRecord; borrowAmount?: unknown; collateralAmount?: unknown; autoRepay?: unknown; pendingRepayAmount?: unknown; pendingReleaseCollateralAmount?: unknown; availableCollateralAmount?: number | null; excludeOfferId?: unknown } = {}): Promise<FallbackOfferCandidate | null> {
        const offers = await this._fetchCreditOffersByAsset(debtAssetId);
        const candidates: FallbackOfferCandidate[] = [];
        for (const offer of offers) {
            if (!offer?.id) continue;
            if (excludeOfferId && String(offer.id) === String(excludeOfferId)) continue;
            if (String(offer.asset_type) !== String(debtAssetId)) continue;
            if (offer.enabled === false) continue;
            const collateralMap = normalizeCollateralMap(offer.acceptable_collateral);
            if (!collateralMap.has(String(collateralAssetId))) continue;
            const validation = this._validateCreditPolicy(policy as UnknownRecord, offer);
            if (!validation.allow) continue;
            try {
                const op = await this.buildCreditOfferAcceptOperation({
                    offer,
                    borrowAmount,
                    collateralAmount,
                    autoRepay: autoRepay as boolean | undefined,
                    specificPolicy: policy,
                    pendingRepayAmount,
                    pendingReleaseCollateralAmount,
                    availableCollateralAmount,
                });
                candidates.push({
                    offer,
                    op,
                    ...offerRankingFields(this._calculateDailyFeeRate(offer), offer),
                });
            } catch (_) {
                // Candidate does not satisfy amount, ratio, balance, or duration policy.
            }
        }

        candidates.sort(compareCreditOfferCandidates);
        return candidates[0] || null;
    }

    async _selectCreditOfferForIncrease({ debtAssetId, collateralAssetId, policy, collateralAmount, minCollateralIncrease = 0, remainingBorrowCapacity = null, autoRepay }: { debtAssetId?: unknown; collateralAssetId?: unknown; policy?: UnknownRecord; collateralAmount?: unknown; minCollateralIncrease?: number; remainingBorrowCapacity?: unknown; autoRepay?: unknown } = {}): Promise<IncreaseOfferCandidate | null> {
        const allowedOfferIds = this._normalizePolicyList(policy?.allowedOfferIds);
        const offers: UnknownRecord[] = [];
        const seen = new Set<string>();
        const accountId = await this._resolveAccountId(getAccountRef(this.bot));
        const debtAsset = await this._resolveAsset(debtAssetId);
        const collateralAsset = await this._resolveAsset(collateralAssetId);
        const finiteRemainingBorrowCapacity = Number.isFinite(Number(remainingBorrowCapacity)) && Number(remainingBorrowCapacity) > 0
            ? Number(remainingBorrowCapacity)
            : null;

        // Apply per-operation borrow limit on top of remaining capacity
        const maxPerOp = positiveOrNull(policy?.maxBorrowAmountPerOperation);
        const effectiveBorrowCapacity = finiteRemainingBorrowCapacity !== null && maxPerOp !== null
            ? Math.min(finiteRemainingBorrowCapacity, maxPerOp)
            : finiteRemainingBorrowCapacity ?? maxPerOp;

        for (const offerId of allowedOfferIds) {
            const offer = await this._getOfferById(offerId);
            if (offer?.id && !seen.has(String(offer.id))) {
                seen.add(String(offer.id));
                offers.push(offer);
            }
        }

        if (offers.length === 0) {
            for (const offer of await this._fetchCreditOffersByAsset(debtAssetId)) {
                if (offer?.id && !seen.has(String(offer.id))) {
                    seen.add(String(offer.id));
                    offers.push(offer);
                }
            }
        }

        const candidates: IncreaseOfferCandidate[] = [];
        for (const offer of offers) {
            if (!offer?.id) continue;
            if (String(offer.asset_type) !== String(debtAssetId)) continue;
            if (offer.enabled === false) continue;
            const collateralMap = normalizeCollateralMap(offer.acceptable_collateral);
            if (!collateralMap.has(String(collateralAssetId))) continue;
            const collateralPrice = collateralMap.get(String(collateralAssetId));
            const validation = this._validateCreditPolicy(policy as UnknownRecord, offer);
            if (!validation.allow) continue;
            try {
                let acceptArgs: UnknownRecord = {
                    offer,
                    collateralAmount,
                    autoRepay,
                    specificPolicy: policy,
                };
                if (accountId && debtAsset && collateralAsset && effectiveBorrowCapacity !== null) {
                    const collateralSpec = normalizeAmountSpec(collateralAmount);
                    const collateralReferenceAmount = isPercentageAmountSpec(collateralSpec)
                        ? await this._getCollateralPercentageBase(accountId, String(collateralAsset.id))
                        : null;
                    const requestedCollateralInt = await this._resolveAmountToBlockchainInt(collateralSpec, collateralAsset, accountId, {
                        balanceField: 'total',
                        referenceAmount: collateralReferenceAmount,
                        referenceLabel: 'total collateral balance',
                    });
                    const desiredBorrowInt = this._calculateBorrowAmountFromCollateral(
                        requestedCollateralInt,
                        collateralPrice,
                        debtAsset,
                        collateralAsset
                    );
                    const desiredBorrowAmount = blockchainToFloat(desiredBorrowInt, Number(debtAsset.precision));
                    if (Number.isFinite(desiredBorrowAmount) && desiredBorrowAmount > effectiveBorrowCapacity) {
                        acceptArgs = {
                            offer,
                            borrowAmount: effectiveBorrowCapacity,
                            collateralAmount: { assetId: collateralAsset.id },
                            autoRepay,
                            specificPolicy: policy,
                        };
                    }
                }

                let op: UnknownRecord | null = null;
                try {
                    op = await this.buildCreditOfferAcceptOperation(acceptArgs);
                } catch (err) {
                    if (!isMaxBorrowAmountError(err)) {
                        throw err;
                    }
                    if (effectiveBorrowCapacity === null) {
                        throw err;
                    }
                    op = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: effectiveBorrowCapacity,
                        collateralAmount: { assetId: collateralAssetId },
                        autoRepay: autoRepay as boolean | undefined,
                        specificPolicy: policy,
                    });
                }
                const opBorrowAmount = blockchainAmountToFloat((op?.op_data as UnknownRecord | undefined)?.borrow_amount, await this._resolveAsset(debtAssetId));
                const opCollateralAmount = blockchainAmountToFloat((op?.op_data as UnknownRecord | undefined)?.collateral, await this._resolveAsset(collateralAssetId));
                if (opBorrowAmount == null || opCollateralAmount == null || opBorrowAmount <= 0 || opCollateralAmount <= 0) {
                    continue;
                }
                const capped = opCollateralAmount < toFiniteNumber((collateralAmount as UnknownRecord | null | undefined)?.amount ?? collateralAmount, 0);
                if (capped && opCollateralAmount < minCollateralIncrease) {
                    continue;
                }
                candidates.push({
                    offer,
                    op,
                    borrowAmount: opBorrowAmount,
                    collateralAmount: opCollateralAmount,
                    capped,
                    ...offerRankingFields(this._calculateDailyFeeRate(offer), offer),
                });
            } catch (_) {
                // Candidate does not satisfy amount, ratio, balance, or duration policy.
            }
        }

        candidates.sort(compareCreditOfferCandidates);
        return candidates[0] || null;
    }

    async _buildCreditIncreasePlan(lendingItem: UnknownRecord, assetId: unknown, posState: UnknownRecord): Promise<UnknownRecord | null> {
        if (!Object.prototype.hasOwnProperty.call(lendingItem, 'minCollateralIncreaseThreshold')) return null;
        const assignedCollateralBudget = positiveOrNull(posState?.assignedCollateralBudget);
        if (assignedCollateralBudget === null) return null;
        const minCollateralIncrease = resolveMinCollateralIncreaseThreshold(
            lendingItem.minCollateralIncreaseThreshold,
            assignedCollateralBudget
        );
        if (minCollateralIncrease === null) return null;

        const debtAsset = await this._resolveAsset(assetId);
        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        if (!debtAsset || !collateralAsset) return null;

        const currentDebtAmount = ((posState.creditDeals as Record<string, unknown>[] | undefined) || []).reduce((sum: number, deal: Record<string, unknown>) => {
            return sum + (blockchainAmountToFloat(deal?.debtAmount, debtAsset) || 0);
        }, 0);
        const currentCollateralAmount = ((posState.creditDeals as Record<string, unknown>[] | undefined) || []).reduce((sum: number, deal: Record<string, unknown>) => {
            return sum + (blockchainAmountToFloat(deal?.collateralAmount, collateralAsset) || 0);
        }, 0);

        const collateralIncreaseAmount = assignedCollateralBudget - currentCollateralAmount;
        if (
            !Number.isFinite(collateralIncreaseAmount)
            || collateralIncreaseAmount <= 0
            || collateralIncreaseAmount < minCollateralIncrease
        ) {
            return null;
        }

        const maxBorrowAmount = positiveOrNull(lendingItem.maxBorrowAmount);
        const remainingBorrowCapacity = maxBorrowAmount !== null
            ? maxBorrowAmount - currentDebtAmount
            : null;
        if (remainingBorrowCapacity !== null && remainingBorrowCapacity <= 0) {
            return null;
        }

        return {
            action: 'increase_credit_debt',
            currentCollateralAmount: roundToDecimals(currentCollateralAmount, 8),
            collateralIncreaseAmount: roundToDecimals(collateralIncreaseAmount, 8),
            minCollateralIncrease: roundToDecimals(minCollateralIncrease, 8),
            currentDebtAmount: roundToDecimals(currentDebtAmount, 8),
            maxBorrowAmount: maxBorrowAmount !== null ? roundToDecimals(maxBorrowAmount, 8) : null,
            remainingBorrowCapacity: remainingBorrowCapacity !== null ? roundToDecimals(remainingBorrowCapacity, 8) : null,
            assignedCollateralBudget: roundToDecimals(assignedCollateralBudget, 8),
        };
    }

    async _splitOversizedCreditDeals(lendingItem: UnknownRecord, assetId: unknown, posState: UnknownRecord, runtimeContext: UnknownRecord = {}): Promise<unknown> {
        const maxPerOp = positiveOrNull(lendingItem.maxBorrowAmountPerOperation);
        if (maxPerOp === null) return null;

        // T2: Concurrency guard — prevent concurrent splits from runMaintenance / watchdog
        if (this._splitInFlight) return { skipped: true, reason: 'split in flight' };
        this._splitInFlight = true;
        try {
            return await this._doSplitOversizedCreditDeals(lendingItem, assetId, posState, runtimeContext);
        } finally {
            this._splitInFlight = false;
        }
    }

    async _doSplitOversizedCreditDeals(lendingItem: UnknownRecord, assetId: unknown, posState: UnknownRecord, _runtimeContext: UnknownRecord = {}): Promise<unknown> {
        const maxPerOp = positiveOrNull(lendingItem.maxBorrowAmountPerOperation);
        if (maxPerOp === null) return null;

        const debtAsset = await this._resolveAsset(assetId);
        const collateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        if (!debtAsset || !collateralAsset) return null;

        const deals = Array.isArray(posState?.creditDeals) ? posState.creditDeals : [];
        const oversized = deals.filter((d: Record<string, unknown>) => {
            const debt = blockchainAmountToFloat(d?.debtAmount, debtAsset);
            return debt != null && debt > maxPerOp;
        });
        if (oversized.length === 0) return null;

        // T3: Use canonical settle-delay resolution matching dexbot_maintenance_runtime.ts.
        // Test seam: runtimeContext.settleDelayMs overrides the production
        // BLOCKCHAIN_SETTLE_DELAY_MS pacing so tests do not sleep on
        // wall-clock time; the split sequencing itself is unchanged.
        const seamDelay = resolveSeamMsOrNull(_runtimeContext?.settleDelayMs);
        const settleDelay = seamDelay != null
            ? seamDelay
            : (Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
                ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
                : 6_000);
        // Expose the resolved delay so tests can assert the seam resolution
        // itself (a `||`-vs-`??` regression here is otherwise invisible: the
        // only observable effect is a slower sleep, which nothing measures).
        // Only written when resolution is reached — the oversized.length === 0
        // early return above precedes this point, so a caller reusing one
        // runtime across scenarios can observe a stale value.
        this._lastResolvedSettleDelayMs = settleDelay;

        // T4: Hard cap on pieces per cycle so the watchdog interval is never exceeded
        const MAX_PIECES_PER_CYCLE = Number.isFinite(TIMING.CREDIT_DEAL_SPLIT_MAX_PIECES)
            ? Math.max(0, TIMING.CREDIT_DEAL_SPLIT_MAX_PIECES)
            : 48;

        const configuredCollateralAssetId = collateralAsset.id;
        const posKey = configuredCollateralAssetId
            ? this._positionKey(assetId, configuredCollateralAssetId)
            : assetId;
        let prevPieceAt = 0;
        let totalPiecesThisCycle = 0;

        for (const deal of oversized) {
            const dealId = String(deal.id);
            let currentDeal = deal;

            const dealDebt = blockchainAmountToFloat(currentDeal.debtAmount, debtAsset);
            if (dealDebt == null || dealDebt <= maxPerOp) continue;

            // Check min_deal_amount on the offer to avoid reborrows that would fail.
            // Note: _getOfferById caches with a TTL (OFFER_CACHE_TTL_MS, default 10min)
            // and re-fetches from chain once the cached offer expires, so a mid-split
            // min_deal_amount change is picked up on the next re-fetch.
            const dealOffer = await this._getOfferById(parseDealSummary(currentDeal)?.offerId);
            const minDealAmount = toFiniteNumber(dealOffer?.min_deal_amount, null);
            const numPieces = Math.ceil((dealDebt as number) / maxPerOp);
            const pieceAmount = roundToDecimals((dealDebt as number) / numPieces, Number(debtAsset.precision));
            if (minDealAmount !== null && pieceAmount < blockchainToFloat(minDealAmount, Number(debtAsset.precision))) {
                this.warn(`credit runtime: cannot split deal ${dealId} — piece amount ${pieceAmount} below min_deal_amount ${blockchainToFloat(minDealAmount, Number(debtAsset.precision))} for offer ${dealOffer?.id}`);
                continue;
            }

            const dealPieces = Math.min(numPieces - 1, MAX_PIECES_PER_CYCLE - totalPiecesThisCycle);
            if (dealPieces <= 0) {
                const remainingDeals = oversized.length - oversized.indexOf(deal) - 1;
                this.warn(`credit runtime: hit cap (${MAX_PIECES_PER_CYCLE}); deferring deal ${dealId} and ${remainingDeals} other deal(s)`);
                break;
            }
            if (dealPieces < numPieces - 1) {
                this.warn(`credit runtime: splitting only ${dealPieces} of ${numPieces - 1} pieces for deal ${dealId} this cycle (cap: ${MAX_PIECES_PER_CYCLE})`);
            }

            for (let i = 0; i < dealPieces; i++) {
                // T1: Abort on shutdown during settle delay
                if (prevPieceAt > 0) {
                    await new Promise((resolve, reject) => {
                        const t = setTimeout(resolve, settleDelay);
                        if (this.bot?._shuttingDown) {
                            clearTimeout(t);
                            reject(new Error('shutting down'));
                        }
                    });
                }

                // Re-fetch deal from current state (may have been refreshed by repayCreditDeal)
                const pos = this.state.positions?.[String(posKey)];
                const refreshed = Array.isArray(pos?.creditDeals)
                    ? pos.creditDeals.find((d: Record<string, unknown>) => String(d.id) === dealId)
                    : null;
                if (!refreshed) {
                    this.warn(`credit runtime: deal ${dealId} (asset ${assetId}) vanished during restructure`);
                    break;
                }
                currentDeal = refreshed;

                const remaining = blockchainAmountToFloat(currentDeal.debtAmount, debtAsset);
                if (remaining == null || remaining <= maxPerOp) break;

                const currentPiece = Math.min(pieceAmount, remaining - maxPerOp);
                if (currentPiece <= 0) break;

                this.log(`credit runtime: splitting deal ${dealId}: repaying ${currentPiece} of ${remaining} debt (piece ${i + 1}/${dealPieces})`);

                await this.repayCreditDeal(currentDeal, currentPiece, {
                    autoReborrow: true,
                    specificPolicy: lendingItem,
                });

                prevPieceAt = Date.now();
                totalPiecesThisCycle++;
            }
        }

        if (prevPieceAt > 0) {
            // N3: skip heavy refresh on cap-exit — repayCreditDeal already called refreshState
            if (totalPiecesThisCycle < MAX_PIECES_PER_CYCLE) {
                await this.refreshCreditState({}, lendingItem);
            }
            const gridResult = await this._checkGridMaintenanceAfterCreditUpdate('credit restructure');
            return { action: 'restructured', gridMaintenanceResult: gridResult };
        }
        return null;
    }

    async _getDealById(dealId: unknown): Promise<UnknownRecord | null> {
        if (!dealId) return null;
        const deals = Array.isArray(this.state.creditDeals) ? this.state.creditDeals : [];
        const fromState = deals.find((entry: Record<string, unknown>) => String(entry.id) === String(dealId));
        if (fromState) return fromState;
        const accountRef = getAccountRef(this.bot);
        if (!accountRef) return null;
        const accountId = await this._resolveAccountId(accountRef) || accountRef;
        const dealObjects = await this._dbCall('get_credit_deals_by_borrower', [accountId]);
        const normalized = Array.isArray(dealObjects) ? dealObjects.map(parseDealSummary).filter((d): d is DealSummary => d !== null) : [];
        return (normalized.find((entry) => String(entry?.id) === String(dealId)) || null) as unknown as UnknownRecord | null;
    }

    async processPendingReborrows(): Promise<unknown> {
        if (!Array.isArray(this.state.pendingReborrows) || this.state.pendingReborrows.length === 0) {
            return { processed: 0, remaining: 0 };
        }
        if (this._reborrowsInFlight) {
            return { skipped: true, reason: 'reborrow processing already in flight' };
        }
        this._reborrowsInFlight = true;

        const configuredMaxAttempts = Number(this.config?.timing?.CREDIT_REBORROW_MAX_ATTEMPTS);
        const maxReborrowAttempts = Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts > 0
            ? Math.trunc(configuredMaxAttempts)
            : TIMING.CREDIT_REBORROW_MAX_ATTEMPTS;

        try {
            const onChainDeals = await this._fetchBorrowerDeals();
            const activeDealIds = new Set(onChainDeals.map((deal) => String(deal?.id)).filter(Boolean));
            const nextQueue: UnknownRecord[] = [];
            let processed = 0;

            // Bounded retry: build/broadcast failures increment the attempt count
            // and are dropped once the limit is reached. Transient deferrals
            // (offer missing/disabled, source deal still active) are not counted.
            const recordFailedAttempt = (request: UnknownRecord, label: string, err: unknown): void => {
                const attempts = (Number(request.reborrowAttempts) || 0) + 1;
                if (attempts >= maxReborrowAttempts) {
                    this.warn(`credit runtime: dropping ${label} for offer ${request.offerId} after ${attempts} failed attempt(s) — last error: ${getErrorMessage(err)}`);
                    return;
                }
                this.warn(`credit runtime: ${label} for offer ${request.offerId} failed (attempt ${attempts}/${maxReborrowAttempts}): ${getErrorMessage(err)}`);
                nextQueue.push({ ...request, reborrowAttempts: attempts, reason: getErrorMessage(err) });
            };

            for (const request of this.state.pendingReborrows) {
                if (!request?.offerId || (request.borrowAmount == null && request.collateralAmount == null)) {
                    this.warn(`credit runtime: dropping invalid pending reborrow request${request?.sourceDealId ? ` for deal ${request.sourceDealId}` : ''} — missing offerId or borrow/collateral amounts`);
                    continue;
                }

                const offer = await this._getOfferById(request.offerId);
                const requestPolicy = (request.specificPolicy || (offer ? await this._resolveLendingPolicyForOffer(offer) : null)) as UnknownRecord | null;
                if (!requestPolicy || !requestPolicy.autoReborrow) {
                    this.warn(`credit runtime: dropping pending reborrow for offer ${request.offerId}; autoReborrow disabled or policy missing`);
                    continue;
                }

                if (request.sourceDealId && requestPolicy) {
                    const disallowedDealIds = this._normalizePolicyList(requestPolicy.disallowedDealIds);
                    if (disallowedDealIds.length > 0 && disallowedDealIds.includes(String(request.sourceDealId))) {
                        this.warn(`credit runtime: dropping pending reborrow for deal ${request.sourceDealId} — deal excluded by disallowedDealIds`);
                        continue;
                    }
                }

                if (request.sourceDealId && activeDealIds.has(String(request.sourceDealId))) {
                    this.warn(`credit runtime: pending reborrow for deal ${request.sourceDealId} deferred — source deal still active on-chain`);
                    nextQueue.push({ ...request, reason: 'source deal still active on-chain' });
                    continue;
                }

                // If the source deal is gone but a replacement deal from the same
                // offer already exists (higher deal ID, same offer), this pending
                // request is stale — the reborrow was already handled elsewhere.
                if (request.sourceDealId && request.offerId && requestPolicy?.renewOnly === true) {
                    const sourceNum = this._extractDealNumericId(request.sourceDealId);
                    if (sourceNum > 0) {
                        const preRepaySnapshot = Array.isArray(request.preRepayDealIds)
                            ? new Set(request.preRepayDealIds.map((id: unknown) => String(id)))
                            : null;
                        const hasNewerReplacement = onChainDeals.some((d) => {
                            if (String(d?.offerId) !== String(request.offerId)) return false;
                            if (this._extractDealNumericId(d.id) <= sourceNum) return false;
                            // With a pre-repay snapshot, only deals that appeared
                            // after the repay count as replacements. Sibling deals
                            // already present on the same offer are not.
                            return preRepaySnapshot ? !preRepaySnapshot.has(String(d.id)) : true;
                        });
                        if (hasNewerReplacement) {
                            this.warn(`credit runtime: dropping stale pending reborrow for deal ${request.sourceDealId} — replacement deal already exists for offer ${request.offerId}`);
                            processed++;
                            continue;
                        }
                    }
                }

                let effectiveCollateralAmount: unknown = request.collateralAmount ?? null;
                if (effectiveCollateralAmount !== null && requestPolicy?.collateralAsset) {
                    const isBare = typeof effectiveCollateralAmount === 'number'
                        || (typeof effectiveCollateralAmount === 'object' && (effectiveCollateralAmount as UnknownRecord).assetId == null);
                    if (isBare) {
                        const colAsset = await this._resolveAsset(requestPolicy.collateralAsset);
                        if (colAsset?.id) {
                            const amountVal = typeof effectiveCollateralAmount === 'number'
                                ? effectiveCollateralAmount
                                : ((effectiveCollateralAmount as UnknownRecord).amount ?? null);
                            effectiveCollateralAmount = { amount: amountVal, assetId: colAsset.id };
                        }
                    }
                }

                if (!offer || offer.enabled === false) {
                    const fallbackIds = await this._resolveFallbackAssetIds(requestPolicy, offer);
                    const effectiveReborrowBudget = await this._refreshReborrowBudget(request);
                    const fallback = fallbackIds.debtAssetId && fallbackIds.collateralAssetId
                        ? await this._selectFallbackCreditOffer({
                            debtAssetId: fallbackIds.debtAssetId,
                            collateralAssetId: fallbackIds.collateralAssetId,
                            policy: requestPolicy,
                            borrowAmount: request.borrowAmount,
                            collateralAmount: effectiveCollateralAmount,
                            autoRepay: (request.autoRepay ?? false) as boolean,
                            pendingReleaseCollateralAmount: request.pendingReleaseCollateralAmount,
                            availableCollateralAmount: effectiveReborrowBudget,
                            excludeOfferId: request.offerId,
                        })
                        : null;
                    if (fallback) {
                        try {
                            this.warn(`credit runtime: fallback reborrow offer ${fallback.offer.id} selected for pending request after offer ${request.offerId} became unavailable`);
                            await this.executeOperations([fallback.op], 'credit reborrow');
                            processed++;
                        } catch (err) {
                            recordFailedAttempt(request, 'fallback reborrow', err);
                        }
                    } else {
                        this.warn(`credit runtime: pending reborrow for offer ${request.offerId} deferred — ${offer ? 'offer disabled' : 'offer unavailable'}`);
                        nextQueue.push({ ...request, reason: offer ? 'offer disabled' : 'offer unavailable' });
                    }
                    continue;
                }

                try {
                    const effectiveReborrowBudget = await this._refreshReborrowBudget(request);
                    const acceptOp = await this.buildCreditOfferAcceptOperation({
                        offer,
                        borrowAmount: request.borrowAmount ?? null,
                        collateralAmount: effectiveCollateralAmount,
                        autoRepay: (request.autoRepay ?? false) as boolean,
                        specificPolicy: (request.specificPolicy || requestPolicy) as UnknownRecord | undefined,
                        pendingReleaseCollateralAmount: request.pendingReleaseCollateralAmount,
                        availableCollateralAmount: effectiveReborrowBudget,
                    });
                    await this.executeOperations([acceptOp], 'credit reborrow');
                    processed++;
                } catch (err) {
                    recordFailedAttempt(request, 'pending reborrow', err);
                }
            }

            this.state.pendingReborrows = nextQueue;
            this.state.reborrowPending = nextQueue.length > 0;
            await this.refreshState();
            let gridMaintenanceResult = null;
            if (processed > 0) {
                gridMaintenanceResult = await this._checkGridMaintenanceAfterCreditUpdate('credit capital update');
            }
            await this.persistState('pending reborrows');

            return { processed, remaining: nextQueue.length, gridMaintenanceResult };
        } finally {
            this._reborrowsInFlight = false;
        }
    }

    async _runMpaMaintenance(context: unknown, _options: UnknownRecord, lendingItem: UnknownRecord, assetId: unknown): Promise<unknown> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_runMpaMaintenance requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_runMpaMaintenance requires an assetId');
        }

        const plan = await this._buildMpaPlanFromState(lendingItem, assetId);
        if (plan?.blocked) {
            return { blocked: true, reason: plan.reason };
        }
        if (!plan) {
            return null;
        }

        const executed: { leg: string; operation: unknown; result: unknown }[] = [];
        let result: unknown = null;

        // Efficient path: Try combined operation first
        const combinedOp = await this.buildMpaUpdateOperation(plan, { leg: 'combined' }, lendingItem, assetId);
        if (combinedOp) {
            try {
                result = await this.executeOperations([combinedOp], `mpa maintenance:${context} combined`);
                executed.push({ leg: 'combined', operation: combinedOp, result });
                await this.refreshMpaState(lendingItem);
            } catch (err) {
                if (!isDeterministicMpaDebtBalanceError(err, plan)) {
                    throw err;
                }
                this.warn(`credit runtime: MPA combined operation failed; attempting collateral fallback: ${getErrorMessage(err)}`);
                await this.refreshMpaState(lendingItem);

                if (lendingItem.debtOnly) {
                    throw err;
                }

                // Combined op failed for debt balance, so a debt-only retry would fail too.
                // Try collateral-only repair; if unavailable, surface the original broadcast failure.
                const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
                const configuredCollateralAssetId = configuredCollateralAsset?.id;
                const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : String(assetId);
                const posState = this.state.positions[posKey];
                const collateralPlan = buildCollateralFallbackPlan({
                    currentCollateralAmount: posState?.currentCollateralAmount,
                    currentDebtAmount: posState?.currentDebtAmount,
                    feedPrice: posState?.feedPrice,
                    targetCollateralRatio: plan.targetCollateralRatio as number | undefined,
                    maxCollateralAmount: (posState?.assignedCollateralBudget ?? lendingItem.maxCollateralAmount) as number | undefined,
                    collateralLimitReferenceAmount: posState?.currentCollateralFundsTotal,
                });
                if (collateralPlan) {
                    const collateralOp = await this.buildMpaUpdateOperation(collateralPlan, { leg: 'collateral' }, lendingItem, assetId);
                    if (collateralOp) {
                        result = await this.executeOperations([collateralOp], `mpa maintenance:${context} collateral fallback`);
                        executed.push({ leg: 'collateral-fallback', operation: collateralOp, result });
                        await this.refreshMpaState(lendingItem);
                    }
                }
                if (executed.length === 0) {
                    throw err;
                }
            }
        }

        if (executed.length > 0) {
            const lastAction = {
                context,
                plan,
                executedAt: nowIso(),
                executed,
            };
            const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
            const configuredCollateralAssetId = configuredCollateralAsset?.id;
            const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : String(assetId);
            if (!this.state.positions[posKey]) this.state.positions[posKey] = {};
            this.state.positions[posKey].lastMpaAction = lastAction;

            this.state.lastCrAdjustment = {
                context,
                plan,
                executedAt: nowIso(),
            };
            if (typeof this.bot?.requestGridReset === 'function') {
                try {
                    const resetReason = String(plan.resetReason || 'cr-adjustment');
                    const resetResult = await this.bot.requestGridReset(resetReason);
                    this.state.lastGridResetAt = nowIso();
                    return { plan, executed, resetResult };
                } catch (err) {
                    this.warn(`credit runtime: grid reset after CR adjustment failed: ${getErrorMessage(err)}`);
                    return { plan, executed, resetError: getErrorMessage(err) };
                }
            }
            return { plan, executed };
        }
        return null;
    }

    async _runCreditMaintenance(lendingItem: UnknownRecord, assetId: unknown, runtimeContext: UnknownRecord = {}): Promise<unknown> {
        if (!lendingItem || typeof lendingItem !== 'object') {
            throw new Error('_runCreditMaintenance requires a lendingItem');
        }
        if (!assetId) {
            throw new Error('_runCreditMaintenance requires an assetId');
        }

        const configuredCollateralAsset = await this._resolveAsset(lendingItem.collateralAsset);
        const configuredCollateralAssetId = configuredCollateralAsset?.id;
        const posKey = configuredCollateralAssetId ? this._positionKey(assetId, configuredCollateralAssetId) : String(assetId);

        // Phase 1: Proactively repay deals nearing expiration before processing reborrows
        const expiryThresholdHours = this.bot?.config?.timing?.CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS ?? TIMING.CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS;
        const expiryThresholdMs = expiryThresholdHours * 60 * 60 * 1000;

        const posState = this.state.positions[posKey];
        if (!posState) return null;

        // Phase 0: Split oversized credit deals that exceed maxBorrowAmountPerOperation
        try {
            const splitResult = await this._splitOversizedCreditDeals(lendingItem, assetId, posState, runtimeContext);
            if (splitResult) {
                this.log(`credit runtime: restructured oversized deals for ${assetId}`);
            }
        } catch (err) {
            this.warn(`credit runtime: deal restructuring failed: ${getErrorMessage(err)}`);
        }

        let activeDealIds = new Set((posState.creditDeals || []).map((d: Record<string, unknown>) => String(d?.id)).filter(Boolean));

        for (const deal of (posState.creditDeals || [])) {
            if (!activeDealIds.has(String(deal?.id))) continue;
            if (!deal.latestRepayTime) continue;
            const timeLeft = new Date(deal.latestRepayTime as string | number).getTime() - Date.now();
            if (timeLeft < expiryThresholdMs) {
                try {
                    this.warn(`credit runtime: deal ${deal.id} expires in ${Math.round(timeLeft / 60000)}m; proactively repaying and reborrowing`);
                    const debtAsset = await this._resolveAsset(deal.debtAssetId);
                    const repayAmount = blockchainAmountToFloat(deal.debtAmount, debtAsset);
                    if (repayAmount == null || repayAmount <= 0) {
                        throw new Error(`unable to convert deal ${deal.id} debt amount for repay`);
                    }
                    const isCollateralMismatch = deal.collateralMismatch === true;
                    let existingCollateralAmount: number | null = null;
                    let explicitAvailableCollateralInt: number | null = null;
                    if (isCollateralMismatch) {
                        const accountRef = getAccountRef(this.bot);
                        const balances = await chainOrders.getOnChainAssetBalances(accountRef, [configuredCollateralAssetId]);
                        const balance = this._pickOnChainBalanceEntry(balances, configuredCollateralAssetId, configuredCollateralAsset);
                        const available = toFiniteNumber(balance?.total, undefined);
                        if (!Number.isFinite(available) || available <= 0) {
                            this.warn(`credit runtime: skipping collateral switch for deal ${deal.id} — no balance of new collateral ${configuredCollateralAssetId}`);
                            continue;
                        }
                        const configuredCollateralPrecision = getAssetPrecision(configuredCollateralAsset);
                        if (configuredCollateralPrecision !== null) {
                            explicitAvailableCollateralInt = floatToBlockchainInt(available, configuredCollateralPrecision);
                            if (!Number.isFinite(explicitAvailableCollateralInt) || explicitAvailableCollateralInt <= 0) {
                                explicitAvailableCollateralInt = null;
                            }
                        }
                    }
                    if (!isCollateralMismatch) {
                        const collateralAsset = await this._resolveAsset(deal.collateralAssetId);
                        existingCollateralAmount = blockchainAmountToFloat(deal.collateralAmount, collateralAsset);
                        if (existingCollateralAmount == null || existingCollateralAmount <= 0) {
                            throw new Error(`unable to convert deal ${deal.id} collateral amount for release`);
                        }
                    }
                    // Shortfall-aware renewal: the repay leg is funded from the
                    // free debt-asset balance before the atomic reborrow returns
                    // anything, so when the borrowed asset has been deployed into
                    // the grid the full deal cannot be renewed at once. Roll the
                    // largest affordable piece instead and leave the rest for the
                    // next cycle rather than failing the whole renewal.
                    const renewalOffer = await this._getOfferById(deal.offerId);
                    const sizing = await this._resolveRenewalSizing({ deal, debtAsset, offer: renewalOffer, policy: lendingItem });
                    let renewalAmount = repayAmount;
                    let isPartialRenewal = false;
                    if (sizing?.partial === true) {
                        renewalAmount = sizing.amount as number;
                        isPartialRenewal = renewalAmount < repayAmount;
                    } else if (sizing?.insufficient === true) {
                        // Nothing affordable — fall back to the full renewal so the
                        // on-chain failure still surfaces rather than silently
                        // skipping a deal that is about to expire.
                        this.warn(`credit runtime: cannot size a partial renewal for deal ${deal.id} (free ${sizing.free}, required ${sizing.required}); attempting full renewal`);
                    }
                    let renewalPendingReleaseCollateral: number | null = isCollateralMismatch ? null : existingCollateralAmount;
                    if (isPartialRenewal && !isCollateralMismatch && existingCollateralAmount != null) {
                        renewalPendingReleaseCollateral = existingCollateralAmount * (renewalAmount / repayAmount);
                    }
                    if (isPartialRenewal) {
                        this.warn(`credit runtime: insufficient free ${debtAsset?.symbol ?? deal.debtAssetId} for full renewal of deal ${deal.id} (have ${sizing?.free}, need ${sizing?.required}); repaying/reborrowing ${renewalAmount} and rolling the rest`);
                    }
                    // Snapshot pre-existing pending reborrows for this deal so we
                    // can prune stale ones after repayCreditDeal without removing
                    // any new deferred entry that repayCreditDeal itself may queue.
                    const staleSnapshot = Array.isArray(this.state.pendingReborrows)
                        ? this.state.pendingReborrows.filter(
                            (r: Record<string, unknown>) => r.sourceDealId === String(deal.id)
                        )
                        : [];
                    const staleKeys = new Set(
                        staleSnapshot.map((r: Record<string, unknown>) => `${r.sourceDealId}:${r.offerId}:${r.requestedAt}`)
                    );

                    const useFreeCollateral = resolveUseFreeCollateral(lendingItem);
                    await this.repayCreditDeal(deal, renewalAmount, {
                        autoReborrow: true,
                        // The deal's old collateral is the floor; free collateral
                        // (added to the budget by useFreeCollateral, on by
                        // default) lets the accept builder top it up to what the
                        // borrow requires instead of scaling the principal down.
                        collateralAmount: isCollateralMismatch || isPartialRenewal ? null : {
                            amount: existingCollateralAmount,
                            assetId: deal.collateralAssetId,
                        },
                        collateralAsset: configuredCollateralAssetId,
                        pendingReleaseCollateralAmount: renewalPendingReleaseCollateral,
                        availableCollateralAmount: explicitAvailableCollateralInt,
                        useFreeCollateral,
                        specificPolicy: lendingItem,
                    });

                    // Prune only the stale entries that existed before the call
                    // (identified by requestedAt), not any freshly queued one.
                    if (staleKeys.size > 0 && Array.isArray(this.state.pendingReborrows)) {
                        const before = this.state.pendingReborrows.length;
                        this.state.pendingReborrows = this.state.pendingReborrows.filter(
                            (r: Record<string, unknown>) => !staleKeys.has(`${r.sourceDealId}:${r.offerId}:${r.requestedAt}`)
                        );
                        if (this.state.pendingReborrows.length < before) {
                            this.log(`credit runtime: pruned ${before - this.state.pendingReborrows.length} stale pending reborrow(s) for deal ${deal.id}`);
                        }
                        this.state.reborrowPending = this.state.pendingReborrows.length > 0;
                    }
                    // repayCreditDeal calls refreshState() which mutates this.state.positions[posKey];
                    // re-read from fresh state for subsequent loop iterations
                    const refreshedPosState = this.state.positions[posKey];
                    if (refreshedPosState && Array.isArray(refreshedPosState.creditDeals)) {
                        activeDealIds = new Set(refreshedPosState.creditDeals.map((d: Record<string, unknown>) => String(d?.id)).filter(Boolean));
                    } else {
                        activeDealIds.delete(String(deal.id));
                    }
                } catch (err) {
                    this.warn(`credit runtime: proactive repay/reborrow for deal ${deal.id} failed: ${getErrorMessage(err)}`);
                }
            }
        }

        // Phase 2: Ensure auto_repay matches policy on existing deals
        const policyAutoRepay = resolveAutoRepayValue(lendingItem?.autoRepay);
        if (policyAutoRepay > 0) {
            const currentDeals = (this.state.positions[posKey]?.creditDeals) || [];
            for (const deal of currentDeals) {
                if (resolveAutoRepayValue(deal.autoRepay) !== policyAutoRepay) {
                    try {
                        this.log(`credit runtime: updating auto_repay on deal ${deal.id} to ${policyAutoRepay}`);
                        const updateOp = await this.buildCreditDealUpdateOperation(deal, policyAutoRepay);
                        await this.executeOperations([updateOp], 'credit deal auto_repay update');
                        deal.autoRepay = policyAutoRepay;
                    } catch (err) {
                        this.warn(`credit runtime: failed to update auto_repay on deal ${deal.id}: ${getErrorMessage(err)}`);
                    }
                }
            }
        }

        // Phase 3: If collateral distribution assigns more credit capacity than current deals use,
        // accept an additional deal to move the asset back toward its target output ratio.
        if (lendingItem.renewOnly !== true) {
            const increasePlan = await this._buildCreditIncreasePlan(lendingItem, assetId, posState);
            if (increasePlan) {
                const offer = await this._selectCreditOfferForIncrease({
                    debtAssetId: assetId,
                    collateralAssetId: configuredCollateralAssetId,
                    policy: lendingItem,
                    collateralAmount: {
                        amount: increasePlan.collateralIncreaseAmount,
                        assetId: configuredCollateralAssetId,
                    },
                    minCollateralIncrease: increasePlan.minCollateralIncrease as number,
                    remainingBorrowCapacity: increasePlan.remainingBorrowCapacity,
                    autoRepay: lendingItem.autoRepay ?? false,
                });
                if (offer) {
                    const result = await this.executeOperations([offer.op], 'credit increase');
                    posState.lastCreditIncrease = {
                        plan: increasePlan,
                        cappedByBorrowCapacity: !!offer.capped,
                        collateralAmount: offer.collateralAmount,
                        borrowAmount: offer.borrowAmount,
                        offerId: offer.offer.id,
                        executedAt: nowIso(),
                    };
                    await this.refreshCreditState({}, lendingItem);
                    const gridMaintenanceResult = await this._checkGridMaintenanceAfterCreditUpdate('credit capital update', {
                    });
                    return {
                        plan: increasePlan,
                        offer: offer.offer.id,
                        cappedByBorrowCapacity: !!offer.capped,
                        collateralAmount: offer.collateralAmount,
                        borrowAmount: offer.borrowAmount,
                        gridMaintenanceResult,
                        result,
                    };
                }
                this.warn(`credit runtime: no acceptable credit offer found for ${assetId} collateral increase of ${increasePlan.collateralIncreaseAmount}`);
            }
        }

        return null;
    }

    async runMaintenance(context: unknown = 'periodic', options: UnknownRecord = {}): Promise<unknown> {
        if (!this.isEnabled()) {
            return { skipped: true, reason: 'debt policy disabled' };
        }
        if (this._maintenanceInFlight) {
            return { skipped: true, reason: 'maintenance already in flight' };
        }
        this._maintenanceInFlight = true;

        try {
            await this.refreshState();

            const results: { context: unknown; mpa: unknown[]; credit: unknown[] } = {
                context,
                mpa: [],
                credit: [],
            };

            const dp = this.debtPolicy;
            for (const item of dp?.lending ?? []) {
                const resolvedAsset = await this._resolveAsset(item.asset);
                const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
                if (!assetId) {
                    this.warn(`credit runtime: unable to resolve asset "${item.asset}" for lending item; skipping`);
                    continue;
                }
                if (item.type === 'mpa') {
                    results.mpa.push(await this._runMpaMaintenance(context, options, item, assetId));
                } else if (item.type === 'creditOffer') {
                    results.credit.push(await this._runCreditMaintenance(item, assetId, { context, options }));
                }
            }

            const reborrowResult = await this.processPendingReborrows();
            await this.persistState(context);
            return { ...results, reborrows: reborrowResult };
        } finally {
            this._maintenanceInFlight = false;
        }
    }

    async runCreditWatchdog(): Promise<unknown> {
        if (!this.isEnabled()) {
            return { skipped: true, reason: 'debt policy disabled' };
        }
        if (this._watchdogInFlight) {
            return { skipped: true, reason: 'watchdog already in flight' };
        }
        this._watchdogInFlight = true;
        try {
            await this.refreshState();

            const mpaResults: unknown[] = [];
            const creditResults: unknown[] = [];

            const dp = this.debtPolicy;
            for (const item of dp?.lending ?? []) {
                const resolvedAsset = await this._resolveAsset(item.asset);
                const assetId = resolvedAsset?.id ? String(resolvedAsset.id) : null;
                if (!assetId) {
                    this.warn(`credit runtime: unable to resolve asset "${item.asset}" for lending item; skipping`);
                    continue;
                }
                if (item.type === 'mpa') {
                    mpaResults.push(await this._runMpaMaintenance('watchdog', {}, item, assetId));
                } else if (item.type === 'creditOffer') {
                    creditResults.push(await this._runCreditMaintenance(item, assetId, { context: 'watchdog', options: {} }));
                }
            }

            const reborrowResult = await this.processPendingReborrows();
            await this.persistState('watchdog');
            return {
                mpa: mpaResults,
                credit: creditResults,
                reborrows: reborrowResult,
                remainingDeals: Array.isArray(this.state.creditDeals) ? this.state.creditDeals.length : 0,
            };
        } catch (err) {
            this.warn(`credit runtime: watchdog error: ${getErrorMessage(err)}`);
            return { skipped: true, reason: getErrorMessage(err) };
        } finally {
            this._watchdogInFlight = false;
        }
    }


    getStateSnapshot(): unknown {
        return deepClone(this.state);
    }
}

export default CreditRuntime


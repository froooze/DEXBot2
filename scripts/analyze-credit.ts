import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

'use strict';

/**
 * DEXBot Credit Analysis Script
 *
 * Live-chain overview of active MPA (margin / call-order) and credit
 * (borrowed deal) positions, summed per asset per bot — the credit
 * counterpart to `dexbot order` (scripts/analyze-orders.ts). Credit deals
 * additionally report per-pair and average CR, but only for pairs that are
 * both whitelisted in bots.json (debtPolicy.lending) and listed on the
 * current credit offer (acceptable_collateral) — anything else is reported
 * as ignored/unpriced and excluded from the average. LP-share collateral is
 * valued from live pool reserves/supply, not the offer's fixed
 * acceptable_collateral price (a contract haircut); the source tag on each
 * Avar. CR line shows `pool` or `offer`. A borrow-now preview per configured
 * pair shows the rate a fresh borrow would get today.
 *
 * Chain source of truth (see bitshares-core):
 * - MPA positions:  database_api::get_margin_positions(account)
 *   (== get_call_orders_by_account(account, 1.3.0, api_limit_get_call_orders),
 *   libraries/app/database_api.cpp). call_order_object (chain/market_object.hpp):
 *   borrower, collateral (int, call_price.base.asset_id), debt (int,
 *   call_price.quote.asset_id), call_price { base, quote }.
 * - Credit deals:   database_api::get_credit_deals_by_borrower(account, ...)
 *   (libraries/app/database_api.cpp). credit_deal_object
 *   (chain/credit_offer_object.hpp): borrower, offer_id, offer_owner,
 *   debt_asset, debt_amount, collateral_asset, collateral_amount.
 *
 * Usage:
 *   node dist/scripts/analyze-credit.js                # credit-enabled bots only
 *   node dist/scripts/analyze-credit.js <bot>          # single bot (name or key)
 *   node dist/scripts/analyze-credit.js <account>      # every bot on that account
 *
 * The positional target matches a bot name/key, or the chain account the bot
 * trades from (`preferredAccount` as a name or 1.2.x id, or the `accountId`
 * stamped beside it by analysis/account_resolver.ts). Account matching is what
 * makes `dexbot credit <account>` work on a shared account, where one account
 * hosts several bot entries — the same target spelling `dexbot pnl` accepts.
 */

const { BitShares, waitForConnected, disconnectClient, setSuppressConnectionLog } = require('../modules/bitshares_client');
const { FEE_PARAMETERS } = require('../modules/constants');
const { PATHS } = require('../modules/paths');
const { getErrorMessage } = require('../modules/utils/errors');
const { normalizeAssetRef, normalizeAssetSymbol, isSameAssetSymbol } = require('../modules/utils/asset_symbols');
const { loadSettingsFile, resolveRawBotEntries, normalizeBotEntries } = require('../modules/bot_settings');
import type { BotEntry, BotLendingEntry } from '../modules/bot_settings.js';
import { pathToFileURL } from 'node:url';
// Terminal colors: centralized palette (modules/cli_colors.ts), shared with
// `dexbot order` so both analyzers stay visually in lockstep.
import { CLI_COLORS as colors } from '../modules/cli_colors.js';
// `<bot|account>` target matching lives in analysis/bot_key_utils so `credit`,
// `order`, `pnl` and the chart commands share one rule set.
import { matchBotTargetIn } from '../analysis/bot_key_utils.js';
import { muteChainLogs } from '../modules/utils/chain_logs.js';
import { setGlobalConsoleLevel } from '../modules/order/logger.js';
import { deriveLiquidityPoolTokenValue } from '../modules/order/utils/system.js';

const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const CONNECT_TIMEOUT_MS = 30000;
const PAGE_LIMIT = 300;

// Chain connection chatter is muted via the shared modules/utils/chain_logs.ts
// helper (console.error stays untouched so real failures still surface).
muteChainLogs();

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  let quotient = value;
  let suffix = '';
  if (abs >= 1_000_000) { quotient = value / 1_000_000; suffix = 'M'; }
  else if (abs >= 1000) { quotient = value / 1000; suffix = 'K'; }
  const absQ = Math.abs(quotient);
  const intDigits = Math.floor(Math.log10(Math.max(absQ, 1e-10))) + 1;
  let formatted: string;
  if (intDigits >= 4) formatted = String(Math.round(quotient));
  else {
    const dp = Math.max(0, 4 - intDigits);
    formatted = quotient.toFixed(dp).replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, '');
  }
  return formatted + suffix;
}

function formatExpiryDate(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(2, 10);
}

function parseExpiryMs(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const ms = new Date(String(raw)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

interface CallOrder {
  id?: string;
  debt?: unknown;
  collateral?: unknown;
  call_price?: { base?: { asset_id?: unknown }; quote?: { asset_id?: unknown } };
  [key: string]: unknown;
}

interface CreditDeal {
  id?: string;
  offer_id?: unknown;
  debt_asset?: string;
  collateral_asset?: string;
  debt_amount?: unknown;
  collateral_amount?: unknown;
  latest_repay_time?: unknown;
  latestRepayTime?: unknown;
  [key: string]: unknown;
}

interface CreditOffer {
  id?: string;
  enabled?: boolean;
  current_balance?: unknown;
  acceptable_collateral?: unknown;
  fee_rate?: unknown;
  max_duration_seconds?: unknown;
  [key: string]: unknown;
}

function hasLending(bot: BotEntry | null | undefined): boolean {
  return Boolean(bot && bot.debtPolicy && Array.isArray(bot.debtPolicy.lending) && bot.debtPolicy.lending.length > 0);
}

// Credit CR math lives in modules/credit_pricing.ts (single source of truth,
// shared with the live credit runtime) — no local copies here.
import {
  averageCollateralRatio as averageCreditCr,
  creditDealCollateralRatio as creditDealCr,
  dailyOfferFeeRate,
  extractOfferConversionRate,
  normalizeCollateralMap as normalizeOfferCollateralMap,
  selectCollateralConversionRate,
} from '../modules/credit_pricing.js';

function lendingAssetsOfType(bot: BotEntry, type: string): string[] {
  const items = bot.debtPolicy?.lending ?? [];
  return items
    .filter((item) => item && item.type === type && typeof item.asset === 'string' && item.asset.length > 0)
    .map((item) => String(item.asset));
}

function allLendingAssets(bot: BotEntry): string[] {
  const items = bot.debtPolicy?.lending ?? [];
  return items
    .filter((item) => item && typeof item.asset === 'string' && item.asset.length > 0)
    .map((item) => String(item.asset));
}

async function dbCall(method: string, args: unknown[]): Promise<unknown> {
  if (BitShares?.db && typeof BitShares.db.call === 'function') {
    return BitShares.db.call(method, args);
  }
  throw new Error('BitShares DB client is unavailable');
}

async function fetchMarginPositions(account: string): Promise<CallOrder[]> {
  try {
    const res = await dbCall('get_margin_positions', [account]);
    if (Array.isArray(res)) return res as CallOrder[];
  } catch (_) { /* fall through to paged variant */ }
  const res = await dbCall('get_call_orders_by_account', [account, '1.3.0', PAGE_LIMIT]);
  return Array.isArray(res) ? res as CallOrder[] : [];
}

async function fetchBorrowerDeals(account: string): Promise<CreditDeal[]> {
  const all: CreditDeal[] = [];
  let start: string | null = null;
  for (;;) {
    const args = start == null ? [account] : [account, PAGE_LIMIT, start];
    const page = await dbCall('get_credit_deals_by_borrower', args);
    if (!Array.isArray(page) || page.length === 0) break;
    // start_id is inclusive (>=) per database_api docs, so drop the overlap
    // row when paginating to avoid double-counting one deal.
    const rows = start != null && (page[0] as CreditDeal)?.id === start ? (page as CreditDeal[]).slice(1) : (page as CreditDeal[]);
    if (rows.length === 0) break;
    all.push(...rows);
    if (page.length < PAGE_LIMIT) break;
    const lastId = (page[page.length - 1] as CreditDeal)?.id;
    if (typeof lastId !== 'string' || lastId === start) break;
    start = lastId;
    if (all.length >= 5000) break;
  }
  return all;
}

function mpaDebtAssetId(order: CallOrder | null | undefined): string | null {
  const q = order?.call_price?.quote?.asset_id;
  if (typeof q === 'string' && q) return q;
  const d = (order?.debt as { asset_id?: unknown } | undefined)?.asset_id;
  if (typeof d === 'string' && d) return d;
  return null;
}

function mpaCollateralAssetId(order: CallOrder | null | undefined): string | null {
  const b = order?.call_price?.base?.asset_id;
  if (typeof b === 'string' && b) return b;
  const c = (order?.collateral as { asset_id?: unknown } | undefined)?.asset_id;
  if (typeof c === 'string' && c) return c;
  return null;
}

function mpaDebtRaw(order: CallOrder | null | undefined): number {
  const v = Number(order?.debt);
  if (Number.isFinite(v)) return v;
  const a = Number((order?.debt as { amount?: unknown } | undefined)?.amount);
  return Number.isFinite(a) ? a : NaN;
}

function mpaCollateralRaw(order: CallOrder | null | undefined): number {
  const v = Number(order?.collateral);
  if (Number.isFinite(v)) return v;
  const a = Number((order?.collateral as { amount?: unknown } | undefined)?.amount);
  return Number.isFinite(a) ? a : NaN;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('-h') || rawArgs.includes('--help')) {
    console.log('Usage: dexbot credit [<bot|account>]');
    console.log('  No args      Summed MPA + borrowed-credit positions for credit-enabled bots.');
    console.log('  <bot>        Only the named bot (matches name or bot key).');
    console.log('  <account>    Only the bots trading that account (preferredAccount name or 1.2.x id);');
    console.log('               a shared account lists every bot entry that uses it.');
    console.log('Live chain data via get_margin_positions + get_credit_deals_by_borrower per preferredAccount.');
    process.exit(0);
  }
  const botFilter = rawArgs.find((a) => !a.startsWith('-'))?.trim().toLowerCase() || null;

  const { config } = loadSettingsFile(BOTS_FILE);
  // Keep every entry (with its file-order index, which unnamed bots' keys are
  // derived from) so target matching cannot drift from what the runtime writes.
  const allBots = normalizeBotEntries(resolveRawBotEntries(config)).filter((b: BotEntry) => Boolean(b));
  const activeBots = allBots.filter((b: BotEntry) => b.active !== false);
  // One account can back several bot entries, so a matched account selects all
  // of them — the account-level view `dexbot credit <account>` promises.
  const targets = botFilter ? matchBotTargetIn(allBots, botFilter) : [];
  const targeted = botFilter ? new Set(targets.map((m) => m.meta)) : null;
  let bots = activeBots.filter((b: BotEntry) => hasLending(b) && (!targeted || targeted.has(b)));
  if (botFilter && bots.length === 0) {
    const matchedEntries = targets.map((m) => m.meta as BotEntry);
    const describe = (b: BotEntry) =>
      `  - ${b.name || b.botKey || 'unnamed'}${b.preferredAccount ? ` (account: ${b.preferredAccount})` : ''}${hasLending(b) ? '' : ' (no debtPolicy)'}${b.active === false ? ' (inactive)' : ''}`;
    // The `Available bots` hint keeps listing inactive entries so a disabled
    // bot's name and account stay discoverable.
    if (matchedEntries.length === 0) {
      console.log(`${colors.sell}No credit bot or account found for '${botFilter}'.${colors.reset}`);
      console.log('Available bots:');
      allBots.forEach((b: BotEntry) => console.log(describe(b)));
      process.exit(0);
    }
    const enabledMatches = matchedEntries.filter((b) => b.active !== false);
    if (enabledMatches.length === 0) {
      // Disabled bots are never reported, whatever their policy.
      console.log(`${colors.yellow}Matched '${botFilter}' only on inactive entries:${colors.reset}`);
      matchedEntries.forEach((b) => console.log(describe(b)));
      console.log('Enable it with `dexbot enable <bot>`, or drop the filter to sum the active credit bots.');
      process.exit(0);
    }
    // Enabled match(es) without a debtPolicy: that policy also supplies the
    // per-bot asset filter, so without it a shared account's positions cannot
    // be attributed. List every match — an inactive entry may still carry the
    // policy and only need enabling.
    console.log(`${colors.yellow}Matched '${botFilter}' but no enabled entry has debtPolicy.lending:${colors.reset}`);
    matchedEntries.forEach((b) => console.log(describe(b)));
    // Every enabled match lacks the policy here (a credit-enabled one would have
    // been reported), so both remedies are always offered.
    console.log('Add a debtPolicy via `dexbot bot` to include it in `dexbot credit`.');
    if (matchedEntries.some((b) => b.active === false)) {
      console.log('Disabled entries also need `dexbot enable <bot>` first.');
    }
    process.exit(0);
  }
  if (bots.length === 0) {
    console.log(`No credit-enabled bots found in ${BOTS_FILE} (debtPolicy.lending is empty everywhere).`);
    process.exit(0);
  }

  const accountUsers = new Map<string, number>();
  for (const b of bots) {
    const acc = String(b.preferredAccount || '');
    if (acc) accountUsers.set(acc, (accountUsers.get(acc) || 0) + 1);
  }

  setSuppressConnectionLog(true);
  // One-shot CLI: keep the analyzer's own console.log output, but silence
  // Logger INFO chatter emitted while valuing LP collateral (e.g.
  // derivePoolPrice). Warnings/errors still surface.
  setGlobalConsoleLevel('warn');
  await waitForConnected(CONNECT_TIMEOUT_MS);
  // Asset metadata cache: id -> { symbol, precision, forLiquidityPool }
  interface AssetInfo { symbol: string; precision: number; forLiquidityPool: string | null }
  const assetCache = new Map<string, AssetInfo>();
  async function assetInfo(assetId: string): Promise<AssetInfo> {
    if (assetCache.has(assetId)) return assetCache.get(assetId)!;
    const res = await dbCall('get_assets', [[assetId]]);
    const a = Array.isArray(res) ? res[0] : null;
    const info: AssetInfo = {
      symbol: String(a?.symbol || assetId),
      precision: Number.isFinite(Number(a?.precision)) ? Number(a.precision) : 5,
      forLiquidityPool: a?.for_liquidity_pool ? String(a.for_liquidity_pool) : null,
    };
    assetCache.set(assetId, info);
    return info;
  }
  // LP-share collateral is valued from pool reserves/supply, not from the
  // credit offer's fixed contract price. Cache per collateral/debt pair.
  const poolValueCache = new Map<string, number | null>();
  async function poolValueFor(collateralId: string, debtId: string): Promise<number | null> {
    const key = `${collateralId}:${debtId}`;
    if (poolValueCache.has(key)) return poolValueCache.get(key)!;
    const value = await deriveLiquidityPoolTokenValue(BitShares, collateralId, debtId, 'auto', true).catch(() => null);
    poolValueCache.set(key, value);
    return value;
  }
  async function toFloat(raw: number, assetId: string): Promise<number | null> {
    if (!Number.isFinite(raw)) return null;
    const info = await assetInfo(assetId);
    return raw / Math.pow(10, info.precision);
  }
  async function symbolOf(assetId: string): Promise<string> {
    return (await assetInfo(assetId)).symbol;
  }
  async function resolveLendingRef(ref: string): Promise<{ id: string | null; symbol: string }> {
    // Refs come from bots.json debtPolicy.lending AND from --mpa/--collateral
    // filters; canonicalize so a lowercase filter still matches the pair.
    const s = normalizeAssetRef(ref);
    if (/^1\.3\.\d+$/.test(s)) {
      try { return { id: s, symbol: await symbolOf(s) }; } catch { return { id: s, symbol: s }; }
    }
    try {
      const res = await dbCall('lookup_asset_symbols', [[s]]);
      const a = Array.isArray(res) ? res[0] : null;
      if (a?.id) {
        assetCache.set(String(a.id), {
          symbol: String(a.symbol || s),
          precision: Number(a.precision ?? 5),
          forLiquidityPool: a.for_liquidity_pool ? String(a.for_liquidity_pool) : null,
        });
        return { id: String(a.id), symbol: String(a.symbol || s) };
      }
    } catch { /* keep raw symbol */ }
    return { id: null, symbol: s };
  }
  async function fetchOfferObjects(offerIds: string[]): Promise<Map<string, CreditOffer>> {
    const out = new Map<string, CreditOffer>();
    const unique = [...new Set(offerIds.filter(Boolean).map(String))];
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      try {
        const res = await dbCall('get_objects', [batch]);
        if (Array.isArray(res)) {
          for (const o of res) {
            const offer = o as CreditOffer;
            if (offer?.id) out.set(String(offer.id), offer);
          }
        }
      } catch { /* leave missing; LP-share collateral can still be pool-valued */ }
    }
    return out;
  }
  // Paginate to exhaustion (no page cap — books with >300 offers must not
  // silently lose pairs). MAX_OFFER_PAGES is only an infinite-loop guard
  // against a misbehaving node; the loop normally ends on a short page or
  // a repeated cursor.
  const MAX_OFFER_PAGES = 100;
  async function fetchLiveOffers(debtAssetId: string): Promise<CreditOffer[]> {
    const out: CreditOffer[] = [];
    const seen = new Set<string>();
    let start: string | null = null;
    for (let page = 0; page < MAX_OFFER_PAGES; page++) {
      const args = start == null ? [debtAssetId, 100] : [debtAssetId, 100, start];
      let rows: unknown;
      try {
        rows = await dbCall('get_credit_offers_by_asset', args);
      } catch { break; }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const o of rows) {
        const offer = o as CreditOffer;
        if (offer?.id && !seen.has(String(offer.id))) {
          seen.add(String(offer.id));
          out.push(offer);
        }
      }
      if (rows.length < 100) break;
      const lastId = (rows[rows.length - 1] as CreditOffer)?.id;
      if (typeof lastId !== 'string' || lastId === start) break;
      start = lastId;
    }
    return out;
  }
  // Wallet (free) balances per asset id, raw ints. Parsed from
  // get_full_accounts the same way chain_orders.getOnChainAssetBalances does.
  const walletCache = new Map<string, Map<string, number>>();
  async function fetchWalletRaw(account: string): Promise<Map<string, number>> {
    if (walletCache.has(account)) return walletCache.get(account)!;
    const out = new Map<string, number>();
    try {
      const res = await dbCall('get_full_accounts', [[account], false]);
      const entry = (Array.isArray(res) && Array.isArray(res[0]) && res[0].length >= 2 ? res[0][1] : (res as unknown[] | undefined)?.[0]) as { balances?: Array<Record<string, unknown>> } | undefined;
      const balances = entry?.balances || [];
      for (const b of balances) {
        const aid = String(b?.asset_type || b?.asset_id || b?.asset || '');
        const raw = Number(b?.balance ?? b?.amount);
        if (aid && Number.isFinite(raw) && raw > 0) {
          out.set(aid, (out.get(aid) || 0) + raw);
        }
      }
    } catch { /* empty map; borrow-now shows N/A wallet */ }
    walletCache.set(account, out);
    return out;
  }
  const precisionOf = (assetId: string): number | null => {
    const info = assetCache.get(String(assetId));
    return info ? info.precision : null;
  };
  async function ensurePrecisions(assetIds: Iterable<string>): Promise<void> {
    for (const id of assetIds) {
      if (id && !assetCache.has(String(id))) {
        try { await assetInfo(String(id)); } catch { /* leave missing */ }
      }
    }
  }

  console.log(`\n${colors.cyan}💳 Credit Overview (live chain)${botFilter ? ` — filter: ${botFilter}` : ''}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(62)}${colors.reset}`);

  let totalMpa = 0;
  let totalDeals = 0;
  let analyzed = 0;

  for (const bot of bots) {
    const botName = String(bot.name || bot.botKey || 'unnamed');
    const account = String(bot.preferredAccount || '');
    if (!account) {
      console.log(`\n${colors.yellowBold}📊 ${botName}${colors.reset} ${colors.gray}(no preferredAccount — skipped)${colors.reset}`);
      continue;
    }
    const shared = (accountUsers.get(account) || 0) > 1;

    let callOrders: CallOrder[] = [];
    let deals: CreditDeal[] = [];
    let fetchError: string | null = null;
    try {
      [callOrders, deals] = await Promise.all([fetchMarginPositions(account), fetchBorrowerDeals(account)]);
    } catch (err) {
      fetchError = getErrorMessage(err) || String(err);
    }
    if (fetchError) {
      console.log(`\n${colors.yellowBold}📊 ${botName}${colors.reset} ${colors.gray}(${account})${colors.reset}`);
      console.log(`   ${colors.sell}chain fetch failed: ${fetchError}${colors.reset}`);
      continue;
    }

    // Per-bot policy filter: chain positions are per-account, so when an
    // account is shared (or holds stray positions) only the debt assets in
    // this bot's debtPolicy count towards this bot's sums.
    const mpaRefs = lendingAssetsOfType(bot, 'mpa');
    const creditRefs = lendingAssetsOfType(bot, 'creditOffer');
    const unionRefs = allLendingAssets(bot);
    const mpaFilterRefs = mpaRefs.length > 0 ? mpaRefs : unionRefs;
    const creditFilterRefs = creditRefs.length > 0 ? creditRefs : unionRefs;
    const resolvedMpa = await Promise.all(mpaFilterRefs.map(resolveLendingRef));
    const resolvedCredit = await Promise.all(creditFilterRefs.map(resolveLendingRef));
    const mpaIds = new Set(resolvedMpa.map((r) => r.id).filter(Boolean) as string[]);
    const mpaSyms = new Set(resolvedMpa.map((r) => normalizeAssetSymbol(r.symbol)));
    const creditIds = new Set(resolvedCredit.map((r) => r.id).filter(Boolean) as string[]);
    const creditSyms = new Set(resolvedCredit.map((r) => normalizeAssetSymbol(r.symbol)));
    const filterActive = unionRefs.length > 0;

    async function debtMatches(debtAssetId: string | null, ids: Set<string>, syms: Set<string>): Promise<boolean> {
      if (!filterActive) return true;
      if (!debtAssetId) return false;
      if (ids.has(debtAssetId)) return true;
      try {
        const sym = normalizeAssetSymbol(await symbolOf(debtAssetId));
        return syms.has(sym);
      } catch { return false; }
    }

    const mpaOrders: CallOrder[] = [];
    for (const o of callOrders) {
      if (await debtMatches(mpaDebtAssetId(o), mpaIds, mpaSyms)) mpaOrders.push(o);
    }
    const creditDeals: CreditDeal[] = [];
    for (const d of deals) {
      const debtId = typeof d?.debt_asset === 'string' ? d.debt_asset : null;
      let symOk = false;
      if (!filterActive) symOk = true;
      else if (debtId && creditIds.has(debtId)) symOk = true;
      else if (debtId) {
        try { symOk = creditSyms.has(normalizeAssetSymbol(await symbolOf(debtId))); } catch { symOk = false; }
      }
      if (symOk) creditDeals.push(d);
    }

    // Sum per asset: debt totals keyed by debt asset, collateral totals keyed
    // by collateral asset. Debt entries also track the biggest single
    // position for the "(×N, ▲ …)" display plus the earliest
    // latest_repay_time per debt asset (next credit expiry).
    type DebtEntry = { total: number; count: number; max: number; earliest?: number | null };
    async function sumPositions(kind: 'mpa' | 'credit', items: unknown[]) {
      const debt = new Map<string, DebtEntry>();
      const coll = new Map<string, { total: number; count: number; max: number }>();
      for (const it of items) {
        const item = it as CallOrder & CreditDeal;
        if (kind === 'mpa') {
          const dId = mpaDebtAssetId(item);
          const cId = mpaCollateralAssetId(item);
          const dRaw = mpaDebtRaw(item);
          const cRaw = mpaCollateralRaw(item);
          if (dId) {
            const f = await toFloat(dRaw, dId);
            if (f != null) {
              const e = debt.get(dId) || { total: 0, count: 0, max: 0 };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f); debt.set(dId, e);
            }
          }
          if (cId) {
            const f = await toFloat(cRaw, cId);
            if (f != null) {
              const e = coll.get(cId) || { total: 0, count: 0, max: 0 };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f); coll.set(cId, e);
            }
          }
        } else {
          const dId = typeof item.debt_asset === 'string' ? item.debt_asset : null;
          const cId = typeof item.collateral_asset === 'string' ? item.collateral_asset : null;
          const dRaw = Number(item.debt_amount);
          const cRaw = Number(item.collateral_amount);
          if (dId && Number.isFinite(dRaw)) {
            const f = await toFloat(dRaw, dId);
            if (f != null) {
              const e = debt.get(dId) || { total: 0, count: 0, max: 0, earliest: null as number | null };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f);
              const ms = parseExpiryMs(item.latest_repay_time ?? item.latestRepayTime);
              if (ms !== null && (e.earliest == null || ms < e.earliest)) e.earliest = ms;
              debt.set(dId, e);
            }
          }
          if (cId && Number.isFinite(cRaw)) {
            const f = await toFloat(cRaw, cId);
            if (f != null) {
              const e = coll.get(cId) || { total: 0, count: 0, max: 0 };
              e.total += f; e.count += 1; e.max = Math.max(e.max, f); coll.set(cId, e);
            }
          }
        }
      }
      return { debt, coll };
    }

    // Display sums are deliberately UNFILTERED (account truth): every live
    // MPA position and credit deal on the account counts, including strays
    // outside this bot's debtPolicy. CR rows, pair logic, the offer fetch,
    // and the summary totals stay on the policy-filtered lists.
    const mpaSumAll = await sumPositions('mpa', callOrders);
    const creditSumAll = await sumPositions('credit', deals);
    totalMpa += mpaOrders.length;
    totalDeals += creditDeals.length;
    analyzed++;

    // ---- Credit CR: whitelisted pairs only ----
    // A deal counts towards the CR numbers only when its exact
    // debt←collateral pair is whitelisted in this bot's debtPolicy
    // (type creditOffer) AND the pair is listed on the current credit
    // offer (acceptable_collateral). Anything else is reported separately
    // as ignored/unpriced and excluded from the average CR.
    const lendingItems: BotLendingEntry[] = bot.debtPolicy?.lending ?? [];
    // Configured credit pairs drive the whitelist, per-pair CR lines, and
    // the borrow-now preview.
    const creditPairs: Array<{ debtId: string | null; debtSym: string; collId: string | null; collSym: string; collForLiquidityPool: boolean; maxCR: number | null }> = [];
    for (const item of lendingItems) {
      if (!item || item.type !== 'creditOffer' || typeof item.asset !== 'string' || typeof item.collateralAsset !== 'string') continue;
      const [debtR, collR] = await Promise.all([
        resolveLendingRef(String(item.asset)),
        resolveLendingRef(String(item.collateralAsset)),
      ]);
      const maxCR = Number((item as { maxCollateralRatio?: unknown }).maxCollateralRatio);
      const collInfo = collR.id ? await assetInfo(collR.id) : null;
      creditPairs.push({
        debtId: debtR.id, debtSym: debtR.symbol,
        collId: collR.id, collSym: collR.symbol,
        collForLiquidityPool: Boolean(collInfo?.forLiquidityPool),
        maxCR: Number.isFinite(maxCR) && maxCR > 0 ? maxCR : null,
      });
    }
    const pairIdKeys = new Set(
      creditPairs.filter((p) => p.debtId && p.collId).map((p) => `${p.debtId}←${p.collId}`),
    );
    const pairSymKeys = new Set(
      creditPairs.map((p) => `${normalizeAssetSymbol(p.debtSym)}←${normalizeAssetSymbol(p.collSym)}`),
    );

    // Offer objects for the deals' conversion rates (debt per collateral).
    const dealOfferIds = creditDeals.map((d) => d?.offer_id).filter(Boolean).map(String);
    const offerById = await fetchOfferObjects(dealOfferIds);
    await ensurePrecisions((() => {
      const legIds = new Set<string>();
      for (const o of offerById.values()) {
        for (const price of normalizeOfferCollateralMap(o?.acceptable_collateral).values()) {
          if (price?.base?.asset_id) legIds.add(String(price.base.asset_id));
          if (price?.quote?.asset_id) legIds.add(String(price.quote.asset_id));
        }
      }
      return legIds;
    })());

    interface CrRow {
      dealId: string | null; debtId: string | null; debtSym: string; debtFloat: number | null;
      collId: string | null; collSym: string; collFloat: number | null;
      supported: boolean; rate: number | null; source: string | null;
      offerId: string | null; value: number | null; cr: number | null;
    }
    const crRows: CrRow[] = [];
    for (const d of creditDeals) {
      const debtId = typeof d?.debt_asset === 'string' ? d.debt_asset : null;
      const collId = typeof d?.collateral_asset === 'string' ? d.collateral_asset : null;
      const [debtFloat, collFloat] = await Promise.all([
        debtId ? toFloat(Number(d?.debt_amount), debtId) : null,
        collId ? toFloat(Number(d?.collateral_amount), collId) : null,
      ]);
      const debtSym = debtId ? await symbolOf(debtId) : '?';
      const collSym = collId ? await symbolOf(collId) : '?';
      let supported = false;
      if (debtId && collId && pairIdKeys.has(`${debtId}←${collId}`)) supported = true;
      else if (pairSymKeys.size > 0 && debtId && collId) {
        try {
          supported = pairSymKeys.has(`${(await symbolOf(debtId)).toUpperCase()}←${(await symbolOf(collId)).toUpperCase()}`);
        } catch { /* stays false */ }
      }
      // Conversion rate: LP-share collateral is valued from the live pool
      // (reserves/supply), because the offer's fixed acceptable_collateral
      // price is a contract haircut, not the share's market value. Other
      // collateral uses the deal's current credit offer price; if the offer
      // is missing there is no CR.
      const offerId = d?.offer_id != null ? String(d.offer_id) : null;
      const offer = offerId ? offerById.get(offerId) : null;
      const collInfo = collId ? await assetInfo(collId) : null;
      const isLiquidityPoolShare = Boolean(collInfo?.forLiquidityPool);
      const poolRate = isLiquidityPoolShare && collId && debtId
        ? await poolValueFor(collId, debtId)
        : null;
      const offerRate = offer && collId && debtId
        ? extractOfferConversionRate(offer?.acceptable_collateral, collId, debtId, precisionOf)
        : null;
      const { rate, source } = selectCollateralConversionRate({ offerRate, poolRate, isLiquidityPoolShare });
      const value = debtFloat != null && collFloat != null && rate !== null ? collFloat * rate : null;
      const cr = debtFloat != null && collFloat != null ? creditDealCr(debtFloat, collFloat, rate) : null;
      crRows.push({
        dealId: d?.id != null ? String(d.id) : null, debtId, debtSym, debtFloat,
        collId, collSym, collFloat, supported, rate, source, offerId, value, cr,
      });
    }
    const supportedRows = crRows.filter((r) => r.supported);
    const ignoredRows = crRows.filter((r) => !r.supported);
    const pricedSupported = supportedRows.filter((r) => r.cr !== null && r.value !== null && r.debtFloat !== null);
    const unpricedSupported = supportedRows.filter((r) => r.cr === null);

    async function fmtParts(m: Map<string, { total: number; count: number; max?: number; earliest?: number | null }>, showBiggest = false): Promise<string[]> {
      if (m.size === 0) return [];
      const parts: string[] = [];
      for (const [id, e] of [...m.entries()].sort((a, b) => b[1].total - a[1].total)) {
        const sym = await symbolOf(id);
        const inner: string[] = [];
        const expiry = formatExpiryDate(e.earliest);
        if (expiry) inner.push(`${colors.yellowBold}${expiry}${colors.gray}`);
        if (showBiggest && e.count > 1 && Number.isFinite(e.max) && (e.max as number) > 0) {
          inner.push(`▲ ${formatAmount(e.max as number)}`);
        }
        if (e.count > 1) inner.push(`×${e.count}`);
        const suffix = inner.length > 0 ? ` ${colors.gray}(${inner.join(', ')})${colors.reset}` : '';
        parts.push(`${formatAmount(e.total)} ${sym}${suffix}`);
      }
      return parts;
    }

    // One asset per line; continuation lines align with the value column
    // (labels are all 11 chars wide, so `   <label>: ` is 16 chars).
    // Debt labels print red (money owed), collateral labels green (backing
    // locked) — same buy-green/sell-red semantics as `dexbot order`.
    async function printAssetLines(label: string, m: Map<string, { total: number; count: number; max?: number; earliest?: number | null }>, showBiggest = false, labelColor: string = colors.yellowBold): Promise<void> {
      const plainPrefix = `   ${label}: `;
      const prefix = `   ${labelColor}${colors.bold}${label}:${colors.reset} `;
      const cont = ' '.repeat(plainPrefix.length);
      const parts = await fmtParts(m, showBiggest);
      parts.forEach((p, i) => {
        console.log(`${i === 0 ? prefix : cont}${p}`);
      });
    }

    console.log(`\n${colors.yellowBold}📊 ${botName}${colors.reset} ${colors.gray}(${account})${colors.reset}${shared ? ` ${colors.gray}[shared account]${colors.reset}` : ''}`);
    // Only list sections with active positions — empty sides stay hidden.
    if (callOrders.length > 0) {
      await printAssetLines('MPA    debt', mpaSumAll.debt, false, colors.sell);
      console.log('');
      await printAssetLines('MPA    coll', mpaSumAll.coll, false, colors.buy);
    }
    if (deals.length > 0) {
      if (callOrders.length > 0) console.log('');
      await printAssetLines('Credit debt', creditSumAll.debt, true, colors.sell);
      console.log('');
      await printAssetLines('Credit coll', creditSumAll.coll, true, colors.buy);
      if (creditPairs.length > 0) console.log('');
      // Compact CR summary: one Avar. CR line per borrowed credit (debt
      // asset), then one Curr. CR line per whitelisted pair. A CR exists only
      // for pairs both whitelisted in bots.json and listed on the current
      // credit offer.
      const feeDenom = Number(FEE_PARAMETERS?.GRAPHENE_FEE_RATE_DENOM) || 1000000;
      const walletRaw = await fetchWalletRaw(account);
      const matchPair = (pair: { debtId: string | null; debtSym: string; collId: string | null; collSym: string }, r: CrRow): boolean =>
        (pair.debtId !== null && r.debtId !== null && pair.debtId === r.debtId && pair.collId !== null && r.collId !== null && pair.collId === r.collId) ||
        (isSameAssetSymbol(pair.debtSym, r.debtSym) && isSameAssetSymbol(pair.collSym, r.collSym));
      if (pricedSupported.length > 0) {
        // Group by borrowed credit (debt asset) so unrelated debt assets are
        // not blended into one figure; each line carries its own
        // value-weighted average CR.
        const debtGroups = new Map<string, { debtSym: string; rows: CrRow[] }>();
        for (const r of pricedSupported) {
          const key = r.debtId ?? `sym:${normalizeAssetSymbol(r.debtSym)}`;
          if (!debtGroups.has(key)) debtGroups.set(key, { debtSym: r.debtSym, rows: [] });
          debtGroups.get(key)!.rows.push(r);
        }
        // Largest borrowed credit first so the biggest exposure leads.
        const debtOrder = [...debtGroups.values()].sort((a, b) =>
          b.rows.reduce((s, r) => s + (r.debtFloat || 0), 0)
          - a.rows.reduce((s, r) => s + (r.debtFloat || 0), 0));
        for (const group of debtOrder) {
          const groupCr = averageCreditCr(group.rows.map((r) => ({ debt: r.debtFloat as number, value: r.value as number })));
          if (groupCr === null) continue;
          // Label in orange to distinguish from Curr. CR; value keeps the
          // original health color (single shared max → green/red, mixed or
          // undefined max → white).
          const groupMaxSet = new Set<number>();
          for (const r of group.rows) {
            const pair = creditPairs.find((p) => matchPair(p, r));
            if (pair?.maxCR != null) groupMaxSet.add(pair.maxCR);
          }
          const groupMax = groupMaxSet.size === 1 ? [...groupMaxSet][0] : null;
          const groupColor = groupMax === null ? colors.white : groupCr > groupMax ? colors.sell : colors.buy;
          const collTotals = new Map<string, { collSym: string; debt: number; coll: number }>();
          for (const r of group.rows) {
            const key = r.collId ?? `sym:${normalizeAssetSymbol(r.collSym)}`;
            if (!collTotals.has(key)) collTotals.set(key, { collSym: r.collSym, debt: 0, coll: 0 });
            const t = collTotals.get(key)!;
            t.debt += r.debtFloat || 0;
            t.coll += r.collFloat || 0;
          }
          const segments = [...collTotals.values()]
            .map((t) => `${formatAmount(t.debt)} ${group.debtSym} ← ${formatAmount(t.coll)} ${t.collSym}`)
            .join(' + ');
          const sources = [...new Set(group.rows.map((r) => r.source).filter((s): s is string => !!s))];
          const sourceTag = sources.length === 1 ? `, ${sources[0]}` : sources.length > 1 ? ', mixed' : '';
          console.log(`   ${colors.orange}${colors.bold}Avar. CR:${colors.reset} ${groupColor}${formatAmount(groupCr)}${colors.reset}, ${segments} ${colors.gray}(x${group.rows.length}${sourceTag})${colors.reset}`);
        }
      } else if (supportedRows.length > 0) {
        console.log(`   ${colors.orange}${colors.bold}Avar. CR:${colors.reset} n/a (no priced, available credit)`);
      }
      const ignored = ignoredRows.length;
      const unpriced = unpricedSupported.length;
      if (ignored + unpriced > 0) {
        const reasons: string[] = [];
        if (ignored > 0) reasons.push(`${ignored} not whitelisted`);
        if (unpriced > 0) reasons.push(`${unpriced} no offer price`);
        console.log(`   ${colors.gray}Excluded: ${ignored + unpriced} deal${ignored + unpriced === 1 ? '' : 's'} (${reasons.join(', ')})${colors.reset}`);
      }
      if (supportedRows.length > 0 && creditPairs.length > 0) console.log('');
      for (const pair of creditPairs) {
        const pairRows = supportedRows.filter((r) => matchPair(pair, r));
        const pricedPair = pairRows.filter((r) => r.cr !== null && r.value !== null && r.debtFloat !== null);
        const pairDebt = pricedPair.reduce((s, r) => s + (r.debtFloat || 0), 0);
        const pairValue = pricedPair.reduce((s, r) => s + (r.value || 0), 0);
        const pairCr = pairDebt > 0 ? pairValue / pairDebt : null;
        const walletFloat = pair.collId && walletRaw.has(pair.collId)
          ? await toFloat(walletRaw.get(pair.collId)!, pair.collId)
          : null;
        // Current credit for the pair: active deal's offer first, else the
        // cheapest live offer listing the pair.
        let liveOffer: CreditOffer | null = null;
        let liveRate: number | null = null;
        let liveOfferId: string | null = null;
        // Select the offer used by the active deals even when the CR rate
        // itself came from the pool (LP-share collateral).
        const offerRows = pairRows.filter((r) => r.rate !== null && r.offerId);
        if (offerRows.length > 0) {
          const ranked = offerRows.map((r) => ({ r, daily: dailyOfferFeeRate(offerById.get(r.offerId!), feeDenom) }))
            .sort((a, b) => a.daily - b.daily || String(a.r.offerId).localeCompare(String(b.r.offerId)));
          liveOffer = offerById.get(ranked[0].r.offerId!) || null;
          liveRate = ranked[0].r.rate;
          liveOfferId = ranked[0].r.offerId != null ? String(ranked[0].r.offerId) : null;
        } else if (pair.debtId && pair.collId) {
          const liveOffers = (await fetchLiveOffers(pair.debtId)).filter((o) => o?.enabled !== false);
          const cands: Array<{ offer: CreditOffer; rate: number; daily: number; id: string }> = [];
          for (const o of liveOffers) {
            await ensurePrecisions((() => {
              const ids = new Set<string>();
              for (const price of normalizeOfferCollateralMap(o?.acceptable_collateral).values()) {
                if (price?.base?.asset_id) ids.add(String(price.base.asset_id));
                if (price?.quote?.asset_id) ids.add(String(price.quote.asset_id));
              }
              return ids;
            })());
            const rate = extractOfferConversionRate(o?.acceptable_collateral, pair.collId, pair.debtId, precisionOf);
            if (rate !== null) cands.push({ offer: o, rate, daily: dailyOfferFeeRate(o, feeDenom), id: String(o.id) });
          }
          cands.sort((a, b) => a.daily - b.daily || a.id.localeCompare(b.id));
          if (cands.length > 0) { liveOffer = cands[0].offer; liveRate = cands[0].rate; liveOfferId = cands[0].id; }
        }
        const avail = liveOffer && pair.debtId
          ? await toFloat(Number(liveOffer.current_balance), pair.debtId)
          : null;
        // No live liquidity for the pair: skip the line entirely —
        // Curr. CR only reports live on-chain offers with funds.
        if (!liveOffer || avail === null || avail <= 0) continue;
        // No active debt: borrow-now CR — wallet collateral value against
        // the offer's available funds, i.e. the CR a fresh borrow of the
        // full available amount would land at.
        let displayCr = pairCr;
        if (displayCr === null && walletFloat !== null && walletFloat > 0 && avail !== null && avail > 0) {
          const displayRate = pair.collForLiquidityPool && pair.collId && pair.debtId
            ? await poolValueFor(pair.collId, pair.debtId)
            : liveRate;
          if (displayRate !== null && displayRate > 0) displayCr = (walletFloat * displayRate) / avail;
        }
        // Green at/below the user max (borrow allowed), red above it, white
        // when no max is defined, gray when there is no CR at all.
        const crColor = displayCr === null
          ? colors.gray
          : pair.maxCR === null
            ? colors.white
            : displayCr > pair.maxCR ? colors.sell : colors.buy;
        const crText = displayCr !== null ? formatAmount(displayCr) : 'n/a';
        if (!liveOfferId && liveOffer?.id != null) liveOfferId = String(liveOffer.id);
        const availText = avail !== null && avail > 0
          ? `${formatAmount(avail)} ${pair.debtSym}`
          : 'no funds';
        const idSuffix = liveOfferId ? ` ${colors.gray}(${liveOfferId})${colors.reset}` : '';
        console.log(`   ${colors.white}${colors.bold}Curr. CR:${colors.reset} ${crColor}${crText}${colors.reset}, ${pair.debtSym}←${pair.collSym} | ${availText}${idSuffix}`);
      }
    }
    if (callOrders.length === 0 && deals.length === 0) {
      console.log(`   ${colors.gray}no active MPA/credit positions${colors.reset}`);
    }
  }

  console.log(`${colors.cyan}${'='.repeat(62)}${colors.reset}`);
  console.log(`${colors.cyan}Summary: ${analyzed} bots, ${totalMpa} MPA positions, ${totalDeals} credit deals${colors.reset}\n`);

  setGlobalConsoleLevel(null);
  try { disconnectClient(); } catch { /* already disconnected */ }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`credit: ${getErrorMessage(err) || err}`);
    setGlobalConsoleLevel(null);
    try { disconnectClient(); } catch { /* noop */ }
    process.exit(1);
  });
}

export { formatAmount, hasLending };

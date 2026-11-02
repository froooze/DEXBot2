#!/usr/bin/env node

/**
 * BitShares BTS supply distribution analyzer.
 *
 * Answers the question "where is all the BTS?" by walking the live chain and
 * bucketing the core asset (1.3.0) into the places the protocol can hold it:
 *
 *   Collateral / debt
 *     - call-order collateral         1.8.x   call_order_object
 *     - global settlement fund        2.4.x   asset_bitasset_data_object.settlement_fund
 *     - individual settlement fund    2.4.x   asset_bitasset_data_object.individual_settlement_fund
 *                                     (reported with its debt, fund-implied price and force-settle params)
 *     - collateral bids after GS      2.17.x  collateral_bid_object
 *
 *   Governance / long-term locks
 *     - tickets (voting/governance)   1.18.x  ticket_object (lock_forever, lock_N_days)
 *     - vesting balances              1.13.x  vesting_balance_object (witness/worker/cashback)
 *     - legacy 1.15.x balances        1.15.x  balance_object (claimable, not vesting)
 *
 *   DeFi / pooled funds
 *     - liquidity pools               1.19.x  liquidity_pool_object
 *     - SameT funds                   1.20.x  samet_fund_object
 *     - credit offers                 1.21.x  credit_offer_object.current_balance
 *     - credit-deal collateral        1.22.x  credit_deal_object.collateral_amount
 *     - HTLC escrow                   1.16.x  htlc_object.transfer
 *
 *   Protocol-controller accounts
 *     - asset fee pools               all 2.3.x fee_pool (denominated in core BTS)
 *
 * Everything left over is reported as the liquid residual: account balances
 * (2.5.x), limit-order escrow (1.7.x) and blinded balances (a subset, reported
 * separately). That residual is derived, not enumerated, so it stays cheap:
 * scanning every 2.5.x account balance or every 1.7.x limit order would need
 * millions of object ids.
 *
 * Two extras complete the picture:
 *   - the top liquid holders, fetched from asset_api::get_asset_holders (the
 *     same source as scripts/rich_list.ts), with a best-effort exchange tag on
 *     account names (MEXC, Gate, Huobi, ...) — the tag is a heuristic, not proof;
 *     `--holders all` pages the whole list and splits the residual into account
 *     balances / blinded balances / order books + other, with a balance histogram;
 *   - a closing comparison of every bucket against total supply and against a
 *     derived circulating float (supply − identified/dormant). BitShares has no
 *     protocol-level circulating field, so the float is derived; an optional
 *     --circulating reference can be supplied for an aggregator/exchange figure.
 *
 * Chain source of truth: bitshares-core 7.0.x
 *   - libraries/protocol/include/graphene/protocol/types.hpp (object id spaces)
 *   - libraries/chain/include/graphene/chain/*_object.hpp (object layouts)
 *   - libraries/plugins/api_helper_indexes/ (amount_in_collateral / next ids)
 *   - libraries/app/database_api.cpp (list_* endpoints used for pagination)
 *
 * The script is read-only, opens its own ephemeral WebSocket connection (it
 * never touches a running bot's connection) and has no runtime dependencies.
 *
 * Usage:
 *   dexbot asset bts [options]                            # CLI shortcut (also: dexbot a bts)
 *   node dist/scripts/bts_distribution.js                 # terminal + HTML
 *   node dist/scripts/bts_distribution.js --json          # JSON + HTML
 *   node dist/scripts/bts_distribution.js --no-html       # terminal only
 *   node dist/scripts/bts_distribution.js --detail 20     # bigger tables
 *   node dist/scripts/bts_distribution.js --holders 100   # rich-list size
 *   node dist/scripts/bts_distribution.js --circulating 2996921386.30283
 *   node dist/scripts/bts_distribution.js --node wss://cloud.xbts.io/ws
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE_MANAGEMENT } from '../modules/constants.js';
import { PATHS } from '../modules/paths.js';
import { CLI_COLORS as colors } from '../modules/cli_colors.js';
import { toFileUrl } from '../analysis/chart_utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_API = 0;                 // database_api is registered first
const LOGIN_API = 1;              // login_api is registered second
const CORE_SYMBOL = 'BTS';
const CORE_ID_FALLBACK = '1.3.0';
const OBJECT_BATCH = 100;         // get_objects ids per call
const NAME_BATCH = 50;            // get_accounts ids per call
const DEFAULT_DETAIL = 10;
const DEFAULT_VESTING_MAX = 200_000;
const DEFAULT_SCAN_GAP = 20_000;
const DEFAULT_HTML = path.join(PATHS.ANALYSIS.CHARTS_DIR, 'bts-distribution.html');
const DEFAULT_HOLDERS = 100;
const MAX_HOLDERS = 1000;
// Console tag for status lines, matching the `[Liquidity]` / `[TradingView]`
// style used by the other analysis entries.
const LOG_TAG = '[Assets]';

// asset_api (get_asset_holders) is allowlisted on only a few public nodes; this
// list mirrors the one in scripts/rich_list.ts, which solves the same problem.
const HOLDER_NODES = [
    'wss://dex.iobanker.com/ws',
    'wss://api.dex.trading/',
];

// ---------------------------------------------------------------------------
// Types (only the fields this analyzer reads)
// ---------------------------------------------------------------------------

interface Amount {
    amount: string | number;
    asset_id: string;
}

interface AssetObject {
    id: string;
    symbol: string;
    precision: number;
    bitasset_data_id?: string;
    dynamic_asset_data_id: string;
    total_in_collateral?: string | number;
    total_backing_collateral?: string | number;
    options?: { max_supply?: string };
    current_supply?: string;
}

interface DynamicAssetObject {
    id: string;
    current_supply: string | number;
    confidential_supply: string | number;
    fee_pool: string | number;
    accumulated_fees: string | number;
    accumulated_collateral_fees: string | number;
}

interface BitassetObject {
    id: string;
    asset_id: string;
    options: {
        short_backing_asset: string;
        force_settlement_offset_percent?: number;
        force_settlement_delay_sec?: number;
        maximum_force_settlement_volume?: number;
        extensions?: { force_settle_fee_percent?: number };
    };
    settlement_price?: { base: Amount; quote: Amount };
    settlement_fund: string | number;
    individual_settlement_fund: string | number;
    individual_settlement_debt: string | number;
    force_settled_volume?: string | number;
}

interface CallOrderObject {
    id: string;
    collateral: string | number;
    debt: string | number;
    call_price: { base: Amount; quote: Amount };
}

interface CollateralBidObject {
    id: string;
    bidder: string;
    inv_swan_price: { base: Amount; quote: Amount };
}

interface VestingObject {
    id: string;
    owner: string;
    balance: Amount;
    balance_type?: string;
    policy?: unknown;
}

interface BalanceObject {
    id: string;
    owner: string;
    balance: Amount;
    vesting_policy?: unknown;
}

interface TicketObject {
    id: string;
    account: string;
    amount: Amount;
    target_type?: string;
    current_type: string;
    status: string;
    value: string | number;
}

interface LiquidityPoolObject {
    id: string;
    asset_a: string;
    asset_b: string;
    balance_a: string | number;
    balance_b: string | number;
    share_asset: string;
}

interface SametFundObject {
    id: string;
    owner_account: string;
    asset_type: string;
    balance: string | number;
    unpaid_amount: string | number;
}

interface CreditOfferObject {
    id: string;
    owner_account: string;
    asset_type: string;
    total_balance: string | number;
    current_balance: string | number;
}

interface CreditDealObject {
    id: string;
    borrower: string;
    debt_asset: string;
    debt_amount: string | number;
    collateral_asset: string;
    collateral_amount: string | number;
}

interface HtlcObject {
    id: string;
    transfer: { from: string; to: string; amount: string | number; asset_id: string };
}

interface AccountObject {
    id: string;
    name: string;
}

interface AssetHolderObject {
    name: string;
    account_id: string;
    amount: string | number;
}

interface DynamicGlobalProperties {
    head_block_number: number;
    time: string;
}

interface NodeConfig {
    has_api_helper_indexes_plugin?: boolean;
    api_limit_get_assets?: number;
    api_limit_get_tickets?: number;
    api_limit_get_liquidity_pools?: number;
    api_limit_get_samet_funds?: number;
    api_limit_get_credit_offers?: number;
    api_limit_list_htlcs?: number;
    api_limit_get_call_orders?: number;
    api_limit_get_asset_holders?: number;
}

interface Options {
    nodes: string[];
    json: boolean;
    html: string | null;
    detail: number;
    holders: number;
    circulating: string | null;
    vestingMax: number;
    gap: number;
    help: boolean;
}

interface Bucket {
    key: string;
    label: string;
    amount: bigint;
    color: string;
    note: string;
    shareOfSupply?: string;
    shareOfCirculating?: string;
}

interface HolderRow {
    id: string;
    name?: string;
    amount: bigint;
    rank?: number;
    exchange?: string;
}

interface ExchangeAgg {
    label: string;
    amount: bigint;
    count: number;
}

interface ConcentrationRow {
    top: number;
    amount: bigint;
    count: number;
}

interface HolderBucketRow {
    label: string;
    count: number;
    amount: bigint;
}

interface TypeRow {
    type: string;
    amount: bigint;
    count: number;
}

interface MpaRow {
    assetId: string;
    symbol: string;
    collateral: bigint;
    settlementFund: bigint;
    individualSettlementFund: bigint;
    settled: boolean;
}

interface SettlementRow {
    assetId: string;
    symbol: string;
    precision: number;
    fund: bigint;
    debt: bigint;
    fundPrice: number | null;
    offsetPercent: number | null;
    feePercent: number | null;
    delaySeconds: number | null;
    maxVolume: bigint;
    settledVolume: bigint;
    remainingPercent: number | null;
}

interface PoolRow {
    id: string;
    pair: string;
    bts: bigint;
}

interface FundRow {
    id: string;
    owner: string;
    name?: string;
    amount: bigint;
    exchange?: string;
}

interface FeePoolRow {
    symbol: string;
    amount: bigint;
}

interface Report {
    node: string;
    blockNum: number;
    blockTime: string;
    generatedAt: string;
    asset: { id: string; symbol: string; precision: number; maxSupply: bigint | null };
    supply: { current: bigint; confidential: bigint };
    buckets: Bucket[];
    identified: bigint;
    residual: bigint;
    circulating: {
        derived: bigint;
        includingLegacy: bigint;
        reference: bigint | null;
        lockedPerCirculating: number;
    };
    details: {
        assetCount: number;
        mpaCount: number;
        mpaBackedCollateral: bigint;
        collateralFromApi: boolean;
        collateralTruncated: boolean;
        mpas: MpaRow[];
        settlementCount: number;
        settlements: SettlementRow[];
        collateralBids: { count: number; total: bigint };
        tickets: {
            count: number;
            total: bigint;
            byType: TypeRow[];
            byStatus: TypeRow[];
            top: HolderRow[];
        };
        vesting: {
            count: number;
            total: bigint;
            byType: TypeRow[];
            top: HolderRow[];
            scannedTo: number;
            hitLimit: boolean;
        };
        genesis: { count: number; total: bigint; vestingCount: number; claimableCount: number };
        pools: { count: number; withBts: number; total: bigint; top: PoolRow[] };
        samet: { count: number; total: bigint; btsCount: number; top: FundRow[] };
        credit: {
            offerCount: number;
            btsOfferCount: number;
            offerTotal: bigint;
            dealCount: number;
            btsDealCount: number;
            dealTotal: bigint;
        };
        htlcs: { count: number; total: bigint };
        feePools: { total: bigint; top: FeePoolRow[] };
        holders: {
            sourceNode: string | null;
            count: number;
            totalCount: number | null;
            total: bigint;
            complete: boolean;
            untrackedLiquid: bigint | null;
            orderBookAndOther: bigint | null;
            median: bigint | null;
            mean: bigint | null;
            top: HolderRow[];
            exchanges: ExchangeAgg[];
            concentration: ConcentrationRow[];
            histogram: HolderBucketRow[];
        };
        warnings: string[];
    };
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function printHelp(): void {
    console.log(`BitShares BTS supply distribution.

Walks the live chain and reports every place BTS is held: call-order collateral,
settlement pools, governance tickets, vesting balances, liquidity pools, SameT
funds, credit offers/deals, HTLC escrow, asset fee pools and the legacy 1.15.x
balances. The remaining liquid supply (accounts, order books, blinded balances)
is reported as a derived residual.

Usage:
  dexbot asset bts [options]
  node dist/scripts/bts_distribution.js [options]

Options:
  --node URL          Pin a WebSocket node (repeatable; default built-in pool)
  --detail N          Rows in detail tables (default ${DEFAULT_DETAIL})
  --holders N|all     Liquid holders to fetch via asset_api (default ${DEFAULT_HOLDERS};
                      \`all\` pages the whole rich list and splits the residual exactly)
  --circulating N     Optional reference circulating supply in BTS (e.g. an exchange/
                      aggregator figure) to compare the chain-derived float against
  --vesting-max N     Highest 1.13.x object id to probe (default ${DEFAULT_VESTING_MAX})
  --gap N             Stop id scans after N consecutive missing ids (default ${DEFAULT_SCAN_GAP})
  --html PATH         HTML report path (default ${DEFAULT_HTML})
  --no-html           Do not write an HTML report
  --json              Print JSON to stdout instead of the terminal table
  -h, --help          This help

Data sources (bitshares-core 7.0.x):
  database_api::get_assets / list_assets, get_objects, list_tickets,
  list_liquidity_pools, list_samet_funds, list_credit_offers,
  list_credit_deals, list_htlcs, get_collateral_bids.
  Call-order collateral uses the api_helper_indexes extended asset field
  total_in_collateral when the node exposes it (fallback: sum get_call_orders).
  Top liquid holders come from asset_api::get_asset_holders (the same source as
  scripts/rich_list.ts); if the connected node denies asset_api, the script
  retries on a node that exposes it. Known exchange account names are tagged
  (MEXC, Gate, Huobi, ...) but the tag is a name heuristic, not proof.`);
}

function parseArgs(argv: string[]): Options {
    const VALUE_FLAGS = new Set(['--node', '--detail', '--holders', '--circulating', '--vesting-max', '--gap', '--html']);
    const args: string[] = [];
    for (const a of argv) {
        const eq = a.indexOf('=');
        if (a.startsWith('--') && eq > 0 && VALUE_FLAGS.has(a.slice(0, eq))) {
            args.push(a.slice(0, eq), a.slice(eq + 1));
        } else {
            args.push(a);
        }
    }
    const opts: Options = {
        nodes: [],
        json: false,
        html: DEFAULT_HTML,
        detail: DEFAULT_DETAIL,
        holders: DEFAULT_HOLDERS,
        circulating: null,
        vestingMax: DEFAULT_VESTING_MAX,
        gap: DEFAULT_SCAN_GAP,
        help: false,
    };
    const positiveInt = (flag: string, raw: string): number => {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive integer`);
        return n;
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const next = (): string => {
            const v = args[++i];
            if (v === undefined) throw new UsageError(`Missing value for ${a}`);
            return v;
        };
        if (a === '--node') opts.nodes.push(next());
        else if (a === '--detail') opts.detail = positiveInt(a, next());
        else if (a === '--holders') {
            const raw = next().toLowerCase();
            opts.holders = raw === 'all' ? 0 : Math.min(positiveInt(a, raw), MAX_HOLDERS);
        }
        else if (a === '--circulating') {
            const raw = next().replace(/,/g, '');
            if (!/^\d+(\.\d+)?$/.test(raw)) throw new UsageError('--circulating must be a positive BTS amount');
            opts.circulating = raw;
        }
        else if (a === '--vesting-max') opts.vestingMax = positiveInt(a, next());
        else if (a === '--gap') opts.gap = positiveInt(a, next());
        else if (a === '--html') opts.html = path.resolve(next());
        else if (a === '--no-html') opts.html = null;
        else if (a === '--json') opts.json = true;
        else if (a === '-h' || a === '--help') opts.help = true;
        else if (a.startsWith('-')) throw new UsageError(`Unknown flag: ${a}`);
        else throw new UsageError(`Unexpected argument: ${a}`);
    }
    return opts;
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC-over-WebSocket client (zero dependencies)
// ---------------------------------------------------------------------------

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

interface RpcErrorBody {
    message?: string;
    data?: { message?: string };
}

class RpcClient {
    readonly url: string;
    private _id = 0;
    private _pending = new Map<number, Pending>();
    private _closed = false;
    private _ws: WebSocket | null = null;

    constructor(url: string) {
        this.url = url;
    }

    connect(timeoutMs = 15000): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(this.url);
            this._ws = ws;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch { /* ignore */ }
                reject(new Error(`connect timeout: ${this.url}`));
            }, timeoutMs);
            ws.onopen = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            ws.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error(`connect error: ${this.url}`));
            };
            ws.onclose = () => {
                this._closed = true;
                for (const { reject: rj } of this._pending.values()) rj(new Error('connection closed'));
                this._pending.clear();
            };
            ws.onmessage = (ev) => {
                let msg: { id?: number; result?: unknown; error?: RpcErrorBody };
                try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
                catch { return; }
                const p = this._pending.get(msg.id as number);
                if (!p) return;
                this._pending.delete(msg.id as number);
                if (msg.error) {
                    const text = msg.error.data?.message || msg.error.message || JSON.stringify(msg.error);
                    p.reject(new Error(text));
                } else {
                    p.resolve(msg.result);
                }
            };
        });
    }

    call<T = unknown>(api: number, method: string, args: unknown[], timeoutMs = 60000): Promise<T> {
        if (this._closed) return Promise.reject(new Error('connection closed'));
        return new Promise<T>((resolve, reject) => {
            const id = ++this._id;
            const timer = setTimeout(() => {
                if (!this._pending.has(id)) return;
                this._pending.delete(id);
                reject(new Error(`rpc timeout: ${method}`));
            }, timeoutMs);
            this._pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v as T); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            this._ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'call', params: [api, method, args] }));
        });
    }

    close(): void {
        try { this._ws?.close(); } catch { /* ignore */ }
    }
}

interface Session {
    client: RpcClient;
    node: string;
    config: NodeConfig;
    assetApi: number | null;
}

async function openSession(nodes: string[]): Promise<Session> {
    const errors: string[] = [];
    for (const url of nodes) {
        const client = new RpcClient(url);
        try {
            await client.connect();
            await client.call(LOGIN_API, 'login', ['', '']);
            const config = await client.call<NodeConfig>(LOGIN_API, 'get_config', []);
            let assetApi: number | null = null;
            try {
                const api = await client.call<number>(LOGIN_API, 'asset', []);
                if (typeof api === 'number') assetApi = api;
            } catch {
                // Most public nodes deny asset_api; holders are fetched on a
                // dedicated node below when necessary.
            }
            return { client, node: url, config: config || {}, assetApi };
        } catch (e) {
            errors.push(`${url}: ${(e as Error).message}`);
            client.close();
        }
    }
    throw new Error(`No reachable BitShares node.\n  ${errors.join('\n  ')}`);
}

/**
 * Find a node that grants anonymous access to asset_api (get_asset_holders).
 * The main database session is left untouched; the caller must close this one.
 */
async function openAssetApiSession(excludeNodes: string[]): Promise<Session | null> {
    const excluded = new Set(excludeNodes);
    const candidates = [...HOLDER_NODES, ...NODE_MANAGEMENT.DEFAULT_NODES]
        .filter((node, index, all) => all.indexOf(node) === index && !excluded.has(node));
    for (const url of candidates) {
        const client = new RpcClient(url);
        try {
            await client.connect(10000);
            await client.call(LOGIN_API, 'login', ['', '']);
            const config = await client.call<NodeConfig>(LOGIN_API, 'get_config', []);
            const api = await client.call<number>(LOGIN_API, 'asset', []);
            if (typeof api === 'number') {
                return { client, node: url, config: config || {}, assetApi: api };
            }
        } catch {
            // try the next node
        }
        client.close();
    }
    return null;
}

/** Page through the rich-list endpoint (holders come back balance-descending). */
async function fetchAssetHolders(
    session: Session,
    assetId: string,
    want: number,
    onProgress?: (fetched: number) => void,
): Promise<{ rows: AssetHolderObject[]; totalCount: number | null; complete: boolean }> {
    if (session.assetApi === null) throw new Error('asset_api unavailable on this node');
    const api = session.assetApi;
    const pageSize = Math.max(1, Math.min(session.config.api_limit_get_asset_holders ?? 100, 100));
    const rows: AssetHolderObject[] = [];
    const unlimited = want <= 0;
    let complete = false;
    let nextProgress = 10000;
    for (let start = 0; unlimited || start < want; start += pageSize) {
        const size = unlimited ? pageSize : Math.min(pageSize, want - start);
        const page = await session.client.call<AssetHolderObject[]>(
            api, 'get_asset_holders', [assetId, start, size]);
        if (!Array.isArray(page) || page.length === 0) {
            complete = true;
            break;
        }
        rows.push(...page);
        if (rows.length >= nextProgress) {
            onProgress?.(rows.length);
            nextProgress += 10000;
        }
        if (page.length < size) {
            complete = true;
            break;
        }
        if (rows.length >= 2_000_000) break;
    }
    let totalCount: number | null = null;
    try {
        const count = await session.client.call<number>(api, 'get_asset_holders_count', [assetId]);
        if (typeof count === 'number') totalCount = count;
    } catch {
        // optional
    }
    return { rows, totalCount, complete };
}

/**
 * Best-effort exchange tag from the account name. This is a heuristic: anyone
 * can register a name containing an exchange brand, so the tag is a hint.
 */
const CEX_BRANDS: Array<[RegExp, string]> = [
    [/mexc|mxccom|\bmxc\b/i, 'MEXC'],
    [/gate-?io|\bgate\b/i, 'Gate'],
    [/poloniex|\bpolo\b/i, 'Poloniex'],
    [/huobi/i, 'Huobi'],
    [/binance/i, 'Binance'],
    [/\bokx\b|\bokex\b/i, 'OKX'],
    [/kucoin/i, 'KuCoin'],
    [/bybit/i, 'Bybit'],
    [/bitget/i, 'Bitget'],
    [/bittrex/i, 'Bittrex'],
    [/upbit/i, 'Upbit'],
    [/bithumb/i, 'Bithumb'],
    [/coinbase/i, 'Coinbase'],
    [/kraken/i, 'Kraken'],
    [/bitfinex/i, 'Bitfinex'],
    [/bitstamp/i, 'Bitstamp'],
    [/bitmart/i, 'BitMart'],
    [/lbank/i, 'LBank'],
    [/probit/i, 'ProBit'],
    [/ascendex|bitmax/i, 'AscendEX'],
    [/coinex/i, 'CoinEx'],
    [/coinspot/i, 'Coinspot'],
    [/hitbtc/i, 'HitBTC'],
    [/\baex\b/i, 'AEX'],
    [/\bexx/i, 'EXX'],
    [/exmo/i, 'EXMO'],
    [/bitso\b/i, 'Bitso'],
    [/wazirx/i, 'WazirX'],
    [/zebpay/i, 'Zebpay'],
    [/gemini/i, 'Gemini'],
    [/bitpanda/i, 'Bitpanda'],
    [/crypto\.?com/i, 'Crypto.com'],
    [/luno/i, 'Luno'],
    [/btcturk/i, 'BTC Turk'],
    [/tokocrypto/i, 'Tokocrypto'],
    [/indodax/i, 'Indodax'],
    [/\bvalr\b/i, 'VALR'],
];

const CEX_HINT = /(^|[-_.\s])(exchange|cex|hot-?wallet|cold-?wallet|deposit|withdrawal|payout|transfers?)([-_.\s]|$)/i;

function detectExchange(name: string | undefined): string | undefined {
    if (!name) return undefined;
    for (const [pattern, label] of CEX_BRANDS) {
        if (pattern.test(name)) return label;
    }
    if (CEX_HINT.test(name)) return 'CEX?';
    return undefined;
}

// ---------------------------------------------------------------------------
// Numeric helpers (all on-chain amounts are exact bigints)
// ---------------------------------------------------------------------------

function toBig(value: string | number | null | undefined): bigint {
    if (value === null || value === undefined) return 0n;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return 0n;
        return BigInt(Math.round(value));
    }
    try { return BigInt(value); } catch { return 0n; }
}

function amountOf(amount: Amount | null | undefined): bigint {
    return amount ? toBig(amount.amount) : 0n;
}

function formatUnits(raw: bigint, precision: number): string {
    const negative = raw < 0n;
    const abs = negative ? -raw : raw;
    const divisor = 10n ** BigInt(precision);
    const whole = abs / divisor;
    const frac = precision > 0 ? (abs % divisor).toString().padStart(precision, '0').replace(/0+$/, '') : '';
    return `${negative ? '-' : ''}${formatInteger(whole)}${frac ? `.${frac}` : ''}`;
}

/** Parse a human decimal amount (e.g. "2996921386.30283") into chain units. */
function parseUnits(text: string, precision: number): bigint {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
    if (!match) throw new Error(`invalid amount: ${text}`);
    const whole = BigInt(match[1]);
    const fraction = (match[2] ?? '').slice(0, precision).padEnd(precision, '0');
    return whole * 10n ** BigInt(precision) + BigInt(fraction || '0');
}

function formatInteger(value: bigint): string {
    const s = value.toString();
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact human number for chart centres: 2.997B, 890.386M, 26.269M. */
function compactUnits(raw: bigint, precision: number): string {
    const divisor = 10n ** BigInt(precision);
    const whole = raw / divisor;
    const negative = whole < 0n;
    const abs = negative ? -whole : whole;
    const tiers: Array<[bigint, string]> = [
        [10n ** 12n, 'T'],
        [10n ** 9n, 'B'],
        [10n ** 6n, 'M'],
        [10n ** 3n, 'K'],
    ];
    for (const [tier, suffix] of tiers) {
        if (abs < tier) continue;
        const milli = (abs * 1000n) / tier;
        const intPart = milli / 1000n;
        const frac = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
        return `${negative ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}${suffix}`;
    }
    return `${negative ? '-' : ''}${abs}`;
}

function sharePercent(part: bigint, whole: bigint, digits = 2): string {
    if (whole <= 0n) return '—';
    const scaled = Number((part * 1_000_000n) / whole); // percent * 10^4
    return `${(scaled / 10_000).toFixed(digits)}%`;
}

function shareFraction(part: bigint, whole: bigint): number {
    if (whole <= 0n) return 0;
    return Number((part * 10_000n) / whole) / 10_000;
}

function compareDesc(a: bigint, b: bigint): number {
    return a > b ? -1 : a < b ? 1 : 0;
}

function sum(values: bigint[]): bigint {
    return values.reduce((acc, v) => acc + v, 0n);
}

// ---------------------------------------------------------------------------
// Chain queries
// ---------------------------------------------------------------------------

async function callDb<T>(session: Session, method: string, args: unknown[]): Promise<T> {
    return session.client.call<T>(DB_API, method, args);
}

/** Fetch object ids in chunks; the node returns null for ids that do not exist. */
async function fetchObjects<T>(session: Session, ids: string[]): Promise<(T | null)[]> {
    const out: (T | null)[] = [];
    for (let i = 0; i < ids.length; i += OBJECT_BATCH) {
        const chunk = ids.slice(i, i + OBJECT_BATCH);
        const page = await callDb<(T | null)[]>(session, 'get_objects', [chunk]);
        for (let j = 0; j < chunk.length; j++) out.push(page?.[j] ?? null);
    }
    return out;
}

/**
 * Paginate a `list_*` endpoint whose signature is `(limit, start_id)`.
 * Every page is de-duplicated by id, so an inclusive lower bound cannot loop.
 */
async function listPages<T extends { id: string }>(
    session: Session,
    method: string,
    limit: number,
    maxPages = 5000,
): Promise<T[]> {
    const seen = new Set<string>();
    const out: T[] = [];
    let start: string | null = null;
    for (let page = 0; page < maxPages; page++) {
        const rows: T[] = await callDb<T[]>(session, method, [limit, start]);
        if (!rows || rows.length === 0) break;
        let fresh = 0;
        for (const row of rows) {
            if (!row || typeof row.id !== 'string' || seen.has(row.id)) continue;
            seen.add(row.id);
            out.push(row);
            fresh++;
        }
        if (rows.length < limit || fresh === 0) break;
        start = rows[rows.length - 1].id;
    }
    return out;
}

/**
 * Enumerate every asset via `list_assets` (symbol-ordered, inclusive lower
 * bound). Assets are keyed by symbol, so pagination advances on the last
 * symbol and duplicates are ignored.
 */
async function listAllAssets(session: Session): Promise<AssetObject[]> {
    const limit = Math.max(1, Math.min(session.config.api_limit_get_assets ?? 100, 1000));
    const seen = new Set<string>();
    const out: AssetObject[] = [];
    let lower = '';
    for (let page = 0; page < 5000; page++) {
        const rows = await callDb<AssetObject[]>(session, 'list_assets', [lower, limit]);
        if (!Array.isArray(rows) || rows.length === 0) break;
        let fresh = 0;
        for (const row of rows) {
            if (!row || seen.has(row.id)) continue;
            seen.add(row.id);
            out.push(row);
            fresh++;
        }
        if (rows.length < limit) break;
        const lastSymbol = rows[rows.length - 1]?.symbol;
        if (typeof lastSymbol !== 'string') break;
        if (fresh === 0) break;
        lower = lastSymbol;
    }
    return out;
}

/**
 * Scan a dense-ish object id range (`prefix.N`) with a gap tolerance. Object
 * ids are allocated monotonically but are never reused, so a range contains
 * holes; the scan stops once it has walked `gap` ids past the last live object.
 */
async function scanIdRange<T>(
    session: Session,
    prefix: string,
    maxId: number,
    gap: number,
    onProgress?: (scannedHint: number) => void,
): Promise<{ objects: T[]; scannedTo: number; hitLimit: boolean }> {
    const objects: T[] = [];
    let index = 0;
    let lastSeen = -1;
    while (index <= maxId && index - lastSeen <= gap) {
        const count = Math.min(OBJECT_BATCH, maxId - index + 1);
        const ids = Array.from({ length: count }, (_, i) => `${prefix}.${index + i}`);
        const page = await callDb<(T | null)[]>(session, 'get_objects', [ids]);
        for (let j = 0; j < count; j++) {
            const obj = page?.[j];
            if (obj) {
                lastSeen = index + j;
                objects.push(obj);
            }
        }
        index += count;
        onProgress?.(index);
    }
    return { objects, scannedTo: index, hitLimit: index > maxId && index - lastSeen <= gap };
}

async function resolveAccountNames(session: Session, ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const unique = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < unique.length; i += NAME_BATCH) {
        const chunk = unique.slice(i, i + NAME_BATCH);
        try {
            const rows = await callDb<(AccountObject | null)[]>(session, 'get_accounts', [chunk]);
            for (const row of rows) if (row) names.set(row.id, row.name);
        } catch {
            // Name resolution is cosmetic; ids are still shown.
        }
    }
    return names;
}

/** Fallback when api_helper_indexes is unavailable: sum per-MPA call orders. */
async function sumCallOrderCollateral(
    session: Session,
    mpas: AssetObject[],
): Promise<{ total: bigint; truncated: boolean }> {
    const limit = Math.max(1, Math.min(session.config.api_limit_get_call_orders ?? 100, 1000));
    let total = 0n;
    let truncated = false;
    for (const mpa of mpas) {
        try {
            const rows = await callDb<CallOrderObject[]>(session, 'get_call_orders', [mpa.id, limit]);
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
                if (row.call_price?.base?.asset_id === CORE_ID_FALLBACK) total += toBig(row.collateral);
            }
            if (rows.length >= limit) truncated = true;
        } catch {
            truncated = true;
        }
    }
    return { total, truncated };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function progress(enabled: boolean, message: string): void {
    if (!enabled) return;
    if (!process.stderr.isTTY) return;
    process.stderr.write(`\r\x1b[2K${LOG_TAG} ${message}`);
}

function clearProgress(enabled: boolean): void {
    if (!enabled || !process.stderr.isTTY) return;
    process.stderr.write('\r\x1b[2K');
}

const COLORS = [
    '#5eb0ef', '#f0883e', '#3fb950', '#db61a2', '#a371f7', '#e3b341',
    '#39c5cf', '#ff7b72', '#7ee787', '#d2a8ff', '#ffa657', '#8b949e',
    '#79c0ff', '#ffd33d', '#56d364', '#f778ba',
];

async function collect(session: Session, opts: Options): Promise<Report> {
    const showProgress = !opts.json;
    const warnings: string[] = [];
    const generatedAt = new Date().toISOString();

    // ---- Core asset + supply ------------------------------------------------
    const found = await callDb<(AssetObject | null)[]>(session, 'lookup_asset_symbols', [[CORE_SYMBOL]]);
    const coreStub = found?.[0];
    if (!coreStub) throw new Error(`core asset ${CORE_SYMBOL} not found on this node`);

    const coreRows = await callDb<(AssetObject | null)[]>(session, 'get_assets', [[coreStub.id]]);
    const core: AssetObject = { ...coreStub, ...(coreRows?.[0] ?? {}) };
    const coreId = core.id || CORE_ID_FALLBACK;

    const dynRows = await fetchObjects<DynamicAssetObject>(session, [core.dynamic_asset_data_id]);
    const coreDyn = dynRows[0];
    if (!coreDyn) throw new Error('core asset dynamic data missing');
    const currentSupply = toBig(coreDyn.current_supply);
    const confidentialSupply = toBig(coreDyn.confidential_supply);

    const global = await callDb<DynamicGlobalProperties>(session, 'get_dynamic_global_properties', []);

    // ---- All assets: MPAs, symbols, fee pools -------------------------------
    progress(showProgress, 'enumerating assets ...');
    const assets = await listAllAssets(session);
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const symbolOf = (id: string): string => assetById.get(id)?.symbol ?? id;

    progress(showProgress, `fetching dynamic data for ${assets.length} assets ...`);
    const dynamicIds = assets.map((a) => a.dynamic_asset_data_id).filter(Boolean);
    const dynamicRows = await fetchObjects<DynamicAssetObject>(session, dynamicIds);
    const dynamicById = new Map<string, DynamicAssetObject>();
    for (const dyn of dynamicRows) if (dyn) dynamicById.set(dyn.id, dyn);

    const mpaAssets = assets.filter((a) => typeof a.bitasset_data_id === 'string' && a.bitasset_data_id);
    const bitassetRows = await fetchObjects<BitassetObject>(
        session,
        mpaAssets.map((a) => a.bitasset_data_id as string),
    );
    const bitassetById = new Map<string, BitassetObject>();
    bitassetRows.forEach((bit) => {
        if (bit) bitassetById.set(bit.id, bit);
    });

    const btsBackedMpas = mpaAssets.filter((a) => {
        const bit = a.bitasset_data_id ? bitassetById.get(a.bitasset_data_id) : undefined;
        return bit?.options?.short_backing_asset === coreId;
    });

    // ---- Fee pools (fee_pool is denominated in the core asset) --------------
    let feePoolTotal = 0n;
    const feePoolRows: FeePoolRow[] = [];
    for (const dyn of dynamicRows) {
        if (!dyn) continue;
        const value = toBig(dyn.fee_pool);
        feePoolTotal += value;
        if (value > 0n) {
            const asset = assetById.get(dyn.id.replace(/^2\.3\./, '1.3.'));
            feePoolRows.push({ symbol: asset?.symbol ?? dyn.id, amount: value });
        }
    }
    feePoolRows.sort((a, b) => compareDesc(a.amount, b.amount));

    // ---- Call-order collateral ---------------------------------------------
    let collateral: bigint;
    let collateralFromApi = core.total_in_collateral !== undefined && core.total_in_collateral !== null;
    let collateralTruncated = false;
    if (collateralFromApi) {
        collateral = toBig(core.total_in_collateral);
    } else {
        progress(showProgress, 'summing call orders (api_helper_indexes unavailable) ...');
        const fallback = await sumCallOrderCollateral(session, btsBackedMpas);
        collateral = fallback.total;
        collateralTruncated = fallback.truncated;
        collateralFromApi = false;
        warnings.push(
            'Node does not expose api_helper_indexes extended asset fields; '
            + 'call-order collateral is a per-MPA sum of get_call_orders and may be truncated.',
        );
    }

    // ---- Settlement pools + per-MPA table -----------------------------------
    let settlementFund = 0n;
    let individualSettlementFund = 0n;
    let mpaBackedCollateral = 0n;
    const mpaRows: MpaRow[] = [];
    const globallySettled: AssetObject[] = [];
    for (const mpa of btsBackedMpas) {
        const bit = mpa.bitasset_data_id ? bitassetById.get(mpa.bitasset_data_id) : undefined;
        if (!bit) continue;
        const sf = toBig(bit.settlement_fund);
        const isf = toBig(bit.individual_settlement_fund);
        const backed = mpa.total_backing_collateral !== undefined && mpa.total_backing_collateral !== null
            ? toBig(mpa.total_backing_collateral)
            : 0n;
        settlementFund += sf;
        individualSettlementFund += isf;
        mpaBackedCollateral += backed;
        const settled = amountOf(bit.settlement_price?.base) > 0n;
        if (settled) globallySettled.push(mpa);
        if (backed > 0n || sf > 0n || isf > 0n) {
            mpaRows.push({
                assetId: mpa.id,
                symbol: mpa.symbol,
                collateral: backed,
                settlementFund: sf,
                individualSettlementFund: isf,
                settled,
            });
        }
    }
    mpaRows.sort((a, b) => compareDesc(
        a.collateral + a.settlementFund + a.individualSettlementFund,
        b.collateral + b.settlementFund + b.individualSettlementFund,
    ));

    // Force-settlement / individual settlement pools. The fund is denominated
    // in BTS (and is part of the bucket above); the debt, max volume and settled
    // volume are denominated in the MPA itself, so they are shown next to it but
    // are NOT added to the BTS totals.
    const settlementRows: SettlementRow[] = [];
    for (const mpa of btsBackedMpas) {
        const bit = mpa.bitasset_data_id ? bitassetById.get(mpa.bitasset_data_id) : undefined;
        if (!bit) continue;
        const fund = toBig(bit.individual_settlement_fund);
        const debt = toBig(bit.individual_settlement_debt);
        const settledVolume = toBig(bit.force_settled_volume);
        if (fund === 0n && debt === 0n) continue;

        const dyn = dynamicById.get(mpa.dynamic_asset_data_id);
        const supply = dyn ? toBig(dyn.current_supply) : 0n;
        const flag = bit.options.maximum_force_settlement_volume ?? 0;
        let maxVolume = 0n;
        if (flag === 10000) maxVolume = supply + settledVolume;
        else if (flag > 0) maxVolume = ((supply + settledVolume) * BigInt(flag)) / 10000n;

        const debtHuman = Number(debt) / 10 ** mpa.precision;
        const fundHuman = Number(fund) / 10 ** (core.precision ?? 5);
        const fundPrice = debt > 0n && fundHuman > 0 ? fundHuman / debtHuman : null;

        settlementRows.push({
            assetId: mpa.id,
            symbol: mpa.symbol,
            precision: mpa.precision,
            fund,
            debt,
            fundPrice,
            offsetPercent: bit.options.force_settlement_offset_percent !== undefined
                ? bit.options.force_settlement_offset_percent / 100
                : null,
            feePercent: bit.options.extensions?.force_settle_fee_percent !== undefined
                ? (bit.options.extensions.force_settle_fee_percent as number) / 100
                : null,
            delaySeconds: bit.options.force_settlement_delay_sec ?? null,
            maxVolume,
            settledVolume,
            remainingPercent: maxVolume > 0n
                ? Math.max(0, 1 - Number(settledVolume) / Number(maxVolume)) * 100
                : null,
        });
    }
    settlementRows.sort((a, b) => compareDesc(a.fund, b.fund));
    if (!collateralFromApi && mpaBackedCollateral > 0n) {
        // Backing collateral is still additive information even in fallback mode.
        collateral = mpaBackedCollateral;
    }
    if (collateralFromApi && mpaBackedCollateral > 0n && mpaBackedCollateral !== collateral) {
        warnings.push(
            `total_in_collateral (${formatUnits(collateral, core.precision)}) and the sum of per-MPA `
            + `total_backing_collateral (${formatUnits(mpaBackedCollateral, core.precision)}) disagree.`,
        );
    }

    // ---- Collateral bids (only meaningful after a global settlement) --------
    let bidCount = 0;
    let bidTotal = 0n;
    for (const mpa of globallySettled) {
        let start = 0;
        for (let page = 0; page < 100; page++) {
            let rows: CollateralBidObject[];
            try {
                rows = await callDb<CollateralBidObject[]>(session, 'get_collateral_bids', [mpa.id, 100, start]);
            } catch {
                break;
            }
            if (!Array.isArray(rows) || rows.length === 0) break;
            for (const row of rows) {
                if (row.inv_swan_price?.base?.asset_id !== coreId) continue;
                bidCount++;
                bidTotal += amountOf(row.inv_swan_price.base);
            }
            start += rows.length;
            if (rows.length < 100) break;
        }
    }

    // ---- Tickets (voting / governance locks) --------------------------------
    progress(showProgress, 'listing governance tickets ...');
    const ticketLimit = Math.max(1, Math.min(session.config.api_limit_get_tickets ?? 100, 1000));
    const tickets = await listPages<TicketObject>(session, 'list_tickets', ticketLimit);
    let ticketTotal = 0n;
    const ticketByType = new Map<string, TypeRow>();
    const ticketByStatus = new Map<string, TypeRow>();
    const ticketByAccount = new Map<string, bigint>();
    let ticketCount = 0;
    for (const ticket of tickets) {
        if (ticket.amount?.asset_id !== coreId) continue;
        ticketCount++;
        const value = amountOf(ticket.amount);
        ticketTotal += value;
        const typeKey = ticket.current_type || 'unknown';
        const typeRow = ticketByType.get(typeKey) ?? { type: typeKey, amount: 0n, count: 0 };
        typeRow.amount += value;
        typeRow.count++;
        ticketByType.set(typeKey, typeRow);
        const statusRow = ticketByStatus.get(ticket.status) ?? { type: ticket.status || 'unknown', amount: 0n, count: 0 };
        statusRow.amount += value;
        statusRow.count++;
        ticketByStatus.set(ticket.status, statusRow);
        ticketByAccount.set(ticket.account, (ticketByAccount.get(ticket.account) ?? 0n) + value);
    }
    const ticketTop: HolderRow[] = [...ticketByAccount.entries()]
        .map(([id, amount]) => ({ id, amount }))
        .sort((a, b) => compareDesc(a.amount, b.amount))
        .slice(0, opts.detail);

    // ---- Vesting balances (1.13.x) ------------------------------------------
    progress(showProgress, 'scanning vesting balances (1.13.x) ...');
    const vestingScan = await scanIdRange<VestingObject>(
        session, '1.13', opts.vestingMax, opts.gap,
        (n) => progress(showProgress, `scanning vesting balances (1.13.x) ... ${n}`),
    );
    let vestingTotal = 0n;
    const vestingByType = new Map<string, TypeRow>();
    const vestingByOwner = new Map<string, bigint>();
    let vestingCount = 0;
    for (const vesting of vestingScan.objects) {
        if (vesting.balance?.asset_id !== coreId) continue;
        vestingCount++;
        const value = amountOf(vesting.balance);
        vestingTotal += value;
        const typeKey = vesting.balance_type || 'unspecified';
        const row = vestingByType.get(typeKey) ?? { type: typeKey, amount: 0n, count: 0 };
        row.amount += value;
        row.count++;
        vestingByType.set(typeKey, row);
        vestingByOwner.set(vesting.owner, (vestingByOwner.get(vesting.owner) ?? 0n) + value);
    }
    const vestingTop: HolderRow[] = [...vestingByOwner.entries()]
        .map(([id, amount]) => ({ id, amount }))
        .sort((a, b) => compareDesc(a.amount, b.amount))
        .slice(0, opts.detail);

    // ---- Legacy 1.15.x balance objects --------------------------------------
    progress(showProgress, 'scanning legacy balances (1.15.x) ...');
    const genesisScan = await scanIdRange<BalanceObject>(session, '1.15', 200_000, opts.gap);
    if (genesisScan.hitLimit) {
        warnings.push('Legacy 1.15.x scan hit its 200,000-id probe limit; the legacy bucket may be incomplete.');
    }
    let genesisTotal = 0n;
    let genesisCount = 0;
    let genesisVesting = 0;
    let genesisClaimable = 0;
    for (const balance of genesisScan.objects) {
        if (balance.balance?.asset_id !== coreId) continue;
        genesisCount++;
        genesisTotal += amountOf(balance.balance);
        if (balance.vesting_policy) genesisVesting++;
        else genesisClaimable++;
    }

    // ---- Liquidity pools (1.19.x) -------------------------------------------
    progress(showProgress, 'listing liquidity pools ...');
    const poolLimit = Math.max(1, Math.min(session.config.api_limit_get_liquidity_pools ?? 100, 1000));
    const pools = await listPages<LiquidityPoolObject>(session, 'list_liquidity_pools', poolLimit);
    let poolTotal = 0n;
    let poolsWithBts = 0;
    const poolRows: PoolRow[] = [];
    for (const pool of pools) {
        let bts = 0n;
        if (pool.asset_a === coreId) bts += toBig(pool.balance_a);
        if (pool.asset_b === coreId) bts += toBig(pool.balance_b);
        if (bts <= 0n) continue;
        poolsWithBts++;
        poolTotal += bts;
        poolRows.push({
            id: pool.id,
            pair: `${symbolOf(pool.asset_a)} / ${symbolOf(pool.asset_b)}`,
            bts,
        });
    }
    poolRows.sort((a, b) => compareDesc(a.bts, b.bts));

    // ---- SameT funds (1.20.x) -----------------------------------------------
    progress(showProgress, 'listing SameT funds ...');
    const sametLimit = Math.max(1, Math.min(session.config.api_limit_get_samet_funds ?? 100, 1000));
    const sametFunds = await listPages<SametFundObject>(session, 'list_samet_funds', sametLimit);
    let sametTotal = 0n;
    let sametBtsCount = 0;
    const sametRows: FundRow[] = [];
    for (const fund of sametFunds) {
        if (fund.asset_type !== coreId) continue;
        sametBtsCount++;
        const value = toBig(fund.balance);
        sametTotal += value;
        sametRows.push({ id: fund.id, owner: fund.owner_account, amount: value });
    }
    sametRows.sort((a, b) => compareDesc(a.amount, b.amount));

    // ---- Credit offers / deals (1.21.x / 1.22.x) ----------------------------
    progress(showProgress, 'listing credit offers and deals ...');
    const creditLimit = Math.max(1, Math.min(session.config.api_limit_get_credit_offers ?? 100, 1000));
    const offers = await listPages<CreditOfferObject>(session, 'list_credit_offers', creditLimit);
    let offerTotal = 0n;
    let btsOfferCount = 0;
    for (const offer of offers) {
        if (offer.asset_type !== coreId) continue;
        btsOfferCount++;
        offerTotal += toBig(offer.current_balance);
    }
    const deals = await listPages<CreditDealObject>(session, 'list_credit_deals', creditLimit);
    let dealTotal = 0n;
    let btsDealCount = 0;
    for (const deal of deals) {
        if (deal.collateral_asset !== coreId) continue;
        btsDealCount++;
        dealTotal += toBig(deal.collateral_amount);
    }

    // ---- HTLC escrow (1.16.x) -----------------------------------------------
    progress(showProgress, 'listing HTLCs ...');
    let htlcTotal = 0n;
    let htlcCount = 0;
    for (let index = 0; index < 100_000; index += OBJECT_BATCH) {
        const ids = Array.from({ length: OBJECT_BATCH }, (_, i) => `1.16.${index + i}`);
        const rows = await fetchObjects<HtlcObject>(session, ids);
        const live = rows.filter((r): r is HtlcObject => !!r);
        for (const row of live) {
            htlcCount++;
            if (row.transfer?.asset_id === coreId) htlcTotal += toBig(row.transfer.amount);
        }
        if (live.length === 0) break;
    }

    // ---- Build buckets ------------------------------------------------------
    const named = (id: string, fallback: string): string => {
        const name = symbolOf(id);
        return name === id ? fallback : name;
    };
    const buckets: Bucket[] = [
        {
            key: 'collateral',
            label: 'Call-order collateral (MPAs)',
            amount: collateral,
            color: COLORS[0],
            note: `${btsBackedMpas.length} BTS-backed smart assets`,
        },
        {
            key: 'settlementFund',
            label: 'Global settlement fund',
            amount: settlementFund,
            color: COLORS[1],
            note: 'Collateral collected when an MPA globally settles',
        },
        {
            key: 'individualSettlementFund',
            label: 'Individual settlement fund',
            amount: individualSettlementFund,
            color: COLORS[2],
            note: 'Per-order settlement pools (BSIP-74 / individual settlement)',
        },
        {
            key: 'collateralBids',
            label: 'Collateral bids (post-settlement)',
            amount: bidTotal,
            color: COLORS[3],
            note: `${bidCount} bid(s) for debt after global settlement`,
        },
        {
            key: 'tickets',
            label: 'Governance tickets (voting locks)',
            amount: ticketTotal,
            color: COLORS[4],
            note: `${ticketCount} ticket(s): lock_forever / lock_N_days`,
        },
        {
            key: 'vesting',
            label: 'Vesting balances',
            amount: vestingTotal,
            color: COLORS[5],
            note: `${vestingCount} vesting balance(s): witness / worker / cashback`,
        },
        {
            key: 'genesis',
            label: 'Legacy balances (1.15.x)',
            amount: genesisTotal,
            color: COLORS[6],
            note: `${genesisCount} claimable balance object(s) from the 2.0 migration`,
        },
        {
            key: 'liquidityPools',
            label: 'Liquidity pools',
            amount: poolTotal,
            color: COLORS[7],
            note: `${poolsWithBts} of ${pools.length} pools hold ${named(coreId, CORE_SYMBOL)}`,
        },
        {
            key: 'sametFunds',
            label: 'SameT funds',
            amount: sametTotal,
            color: COLORS[8],
            note: `${sametBtsCount} fund(s) denominated in ${named(coreId, CORE_SYMBOL)}`,
        },
        {
            key: 'creditOffers',
            label: 'Credit offer funds',
            amount: offerTotal,
            color: COLORS[9],
            note: `${btsOfferCount} offer(s) with ${named(coreId, CORE_SYMBOL)} available`,
        },
        {
            key: 'creditCollateral',
            label: 'Credit-deal collateral',
            amount: dealTotal,
            color: COLORS[10],
            note: `${btsDealCount} active deal(s) collateralised in ${named(coreId, CORE_SYMBOL)}`,
        },
        {
            key: 'htlc',
            label: 'HTLC escrow',
            amount: htlcTotal,
            color: COLORS[11],
            note: `${htlcCount} hash/time-locked contract(s)`,
        },
        {
            key: 'feePools',
            label: 'Asset fee pools',
            amount: feePoolTotal,
            color: COLORS[12],
            note: 'fee_pool of every asset is denominated in core BTS',
        },
    ];

    const identified = sum(buckets.map((b) => b.amount));
    let residual = currentSupply - identified;
    if (residual < 0n) {
        warnings.push(
            `Identified holdings (${formatUnits(identified, core.precision)}) exceed current supply `
            + `(${formatUnits(currentSupply, core.precision)}); residual clamped to 0.`,
        );
        residual = 0n;
    }
    if (confidentialSupply > residual) {
        warnings.push('Blinded supply is larger than the computed residual; check node data.');
    }

    // ---- Circulating float comparison --------------------------------------
    // BitShares only exposes current_supply (coins in existence); there is no
    // protocol-level "circulating" field. We derive it by removing everything
    // this report could identify as protocol-held or dormant.
    const circulatingDerived = residual;
    const circulatingIncludingLegacy = residual + genesisTotal;
    const reference = opts.circulating
        ? parseUnits(opts.circulating, core.precision)
        : null;
    const lockedPerCirculating = circulatingDerived > 0n
        ? Number((identified * 10_000n) / circulatingDerived) / 10_000
        : 0;
    for (const bucket of buckets) {
        bucket.shareOfSupply = sharePercent(bucket.amount, currentSupply);
        bucket.shareOfCirculating = sharePercent(bucket.amount, circulatingDerived);
    }

    // ---- Top liquid holders (rich list via asset_api) ----------------------
    progress(showProgress, 'fetching the liquid rich list (asset_api) ...');
    let holderSession: Session | null = session;
    let closeHolderSession = false;
    if (session.assetApi === null) {
        holderSession = await openAssetApiSession([session.node]);
        closeHolderSession = true;
    }
    let holderSource: string | null = null;
    let holderCount = 0;
    let holderTotalCount: number | null = null;
    let holderTotal = 0n;
    let holderComplete = false;
    let holderAmounts: bigint[] = [];
    const holderTop: HolderRow[] = [];
    const exchangeAgg = new Map<string, ExchangeAgg>();
    const concentration: ConcentrationRow[] = [];
    const histogram: HolderBucketRow[] = [];
    let holderMedian: bigint | null = null;
    let holderMean: bigint | null = null;
    if (holderSession?.assetApi !== null && holderSession?.assetApi !== undefined) {
        holderSource = holderSession.node;
        try {
            const fetched = await fetchAssetHolders(
                holderSession,
                coreId,
                opts.holders,
                (n) => progress(showProgress, `fetching the rich list ... ${formatInteger(BigInt(n))} accounts`),
            );
            holderCount = fetched.rows.length;
            holderTotalCount = fetched.totalCount;
            holderComplete = fetched.complete;
            fetched.rows.forEach((holder, index) => {
                const amount = toBig(holder.amount);
                const exchange = detectExchange(holder.name);
                holderTotal += amount;
                holderAmounts.push(amount);
                if (exchange) {
                    const agg = exchangeAgg.get(exchange) ?? { label: exchange, amount: 0n, count: 0 };
                    agg.amount += amount;
                    agg.count++;
                    exchangeAgg.set(exchange, agg);
                }
                if (index < opts.detail) {
                    holderTop.push({
                        rank: index + 1,
                        id: holder.account_id,
                        name: holder.name,
                        amount,
                        exchange,
                    });
                }
            });

            // Holders arrive balance-descending, but sort defensively before
            // publishing concentration numbers.
            holderAmounts = [...holderAmounts].sort((a, b) => compareDesc(a, b));
            for (const top of [10, 100, 1000, 10000]) {
                if (holderAmounts.length < top) continue;
                concentration.push({ top, count: top, amount: sum(holderAmounts.slice(0, top)) });
            }

            if (holderComplete && holderAmounts.length > 0) {
                const unit = 10n ** BigInt(core.precision ?? 5);
                const specs: Array<[string, bigint, bigint | null]> = [
                    ['< 0.001 BTS', 0n, unit / 1000n],
                    ['0.001 – 0.01 BTS', unit / 1000n, unit / 100n],
                    ['0.01 – 0.1 BTS', unit / 100n, unit / 10n],
                    ['0.1 – 1 BTS', unit / 10n, unit],
                    ['1 – 10 BTS', unit, 10n * unit],
                    ['10 – 100 BTS', 10n * unit, 100n * unit],
                    ['100 – 1,000 BTS', 100n * unit, 1000n * unit],
                    ['1,000 – 1,000,000 BTS', 1000n * unit, 1_000_000n * unit],
                    ['≥ 1,000,000 BTS', 1_000_000n * unit, null],
                ];
                for (const [label, low, high] of specs) {
                    let count = 0;
                    let amount = 0n;
                    for (const value of holderAmounts) {
                        if (value < low) continue;
                        if (high !== null && value >= high) continue;
                        count++;
                        amount += value;
                    }
                    if (count > 0) histogram.push({ label, count, amount });
                }
                const ascending = [...holderAmounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                holderMedian = ascending[Math.floor(ascending.length / 2)];
                holderMean = holderTotal / BigInt(holderAmounts.length);
            }
        } catch (e) {
            warnings.push(`Top liquid holders unavailable: ${(e as Error).message}`);
        }
    } else {
        warnings.push('No reachable node exposes asset_api::get_asset_holders; top liquid holders unavailable.');
    }
    if (closeHolderSession) holderSession?.client.close();

    const untrackedLiquid = holderComplete ? residual - holderTotal : null;
    const orderBookAndOther = holderComplete
        ? residual - holderTotal - confidentialSupply
        : null;
    if (orderBookAndOther !== null && orderBookAndOther < 0n) {
        warnings.push('Account balances plus blinded supply exceed the derived residual; check node data.');
    }

    // ---- Resolve human names for top holders -------------------------------
    const nameMap = await resolveAccountNames(session, [
        ...ticketTop.map((r) => r.id),
        ...vestingTop.map((r) => r.id),
        ...sametRows.slice(0, opts.detail).map((r) => r.owner),
    ]);
    for (const row of ticketTop) {
        row.name = nameMap.get(row.id);
        row.exchange = detectExchange(row.name);
    }
    for (const row of vestingTop) {
        row.name = nameMap.get(row.id);
        row.exchange = detectExchange(row.name);
    }
    for (const row of sametRows) {
        row.name = nameMap.get(row.owner);
        row.exchange = detectExchange(row.name);
    }

    clearProgress(showProgress);

    return {
        node: session.node,
        blockNum: global.head_block_number,
        blockTime: global.time,
        generatedAt,
        asset: {
            id: coreId,
            symbol: core.symbol || CORE_SYMBOL,
            precision: core.precision ?? 5,
            maxSupply: core.options?.max_supply ? toBig(core.options.max_supply) : null,
        },
        supply: { current: currentSupply, confidential: confidentialSupply },
        buckets,
        identified,
        residual,
        circulating: {
            derived: circulatingDerived,
            includingLegacy: circulatingIncludingLegacy,
            reference,
            lockedPerCirculating,
        },
        details: {
            assetCount: assets.length,
            mpaCount: btsBackedMpas.length,
            mpaBackedCollateral,
            collateralFromApi,
            collateralTruncated,
            mpas: mpaRows.slice(0, opts.detail),
            settlementCount: settlementRows.length,
            settlements: settlementRows.slice(0, Math.max(opts.detail, 10)),
            collateralBids: { count: bidCount, total: bidTotal },
            tickets: {
                count: ticketCount,
                total: ticketTotal,
                byType: [...ticketByType.values()].sort((a, b) => compareDesc(a.amount, b.amount)),
                byStatus: [...ticketByStatus.values()].sort((a, b) => compareDesc(a.amount, b.amount)),
                top: ticketTop,
            },
            vesting: {
                count: vestingCount,
                total: vestingTotal,
                byType: [...vestingByType.values()].sort((a, b) => compareDesc(a.amount, b.amount)),
                top: vestingTop,
                scannedTo: vestingScan.scannedTo,
                hitLimit: vestingScan.hitLimit,
            },
            genesis: { count: genesisCount, total: genesisTotal, vestingCount: genesisVesting, claimableCount: genesisClaimable },
            pools: { count: pools.length, withBts: poolsWithBts, total: poolTotal, top: poolRows.slice(0, opts.detail) },
            samet: { count: sametFunds.length, total: sametTotal, btsCount: sametBtsCount, top: sametRows.slice(0, opts.detail) },
            credit: {
                offerCount: offers.length,
                btsOfferCount,
                offerTotal,
                dealCount: deals.length,
                btsDealCount,
                dealTotal,
            },
            htlcs: { count: htlcCount, total: htlcTotal },
            feePools: { total: feePoolTotal, top: feePoolRows.slice(0, opts.detail) },
            holders: {
                sourceNode: holderSource,
                count: holderCount,
                totalCount: holderTotalCount,
                total: holderTotal,
                complete: holderComplete,
                untrackedLiquid,
                orderBookAndOther,
                median: holderMedian,
                mean: holderMean,
                top: holderTop,
                exchanges: [...exchangeAgg.values()].sort((a, b) => compareDesc(a.amount, b.amount)),
                concentration,
                histogram,
            },
            warnings,
        },
    };
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

function bar(value: bigint, whole: bigint, width = 26): string {
    if (whole <= 0n) return '';
    const filled = Math.round(shareFraction(value, whole) * width);
    if (filled <= 0) return '·';
    return '█'.repeat(Math.min(filled, width));
}

function padEnd(text: string, width: number): string {
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
    return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function renderTerminal(report: Report, opts: Options): void {
    const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
    const c = (code: string, text: string): string => (useColor ? `${code}${text}${colors.reset}` : text);
    const p = report.asset.precision;
    const money = (v: bigint): string => formatUnits(v, p);
    const supply = report.supply.current;
    const labelWidth = Math.min(
        46,
        report.buckets.reduce((m, b) => Math.max(m, b.label.length), 0) + 2,
    );
    const amountWidth = 22;
    const pctWidth = 8;

    console.log();
    console.log(c(colors.bold + colors.yellow, '  BitShares · BTS supply distribution'));
    console.log(c(colors.gray, `  block ${formatInteger(BigInt(report.blockNum))} · ${report.blockTime} UTC · ${report.node}`));
    console.log(c(
        colors.gray,
        `  ${report.asset.symbol} (${report.asset.id}) · precision ${p} · total supply ${money(supply)}`
        + (report.asset.maxSupply ? ` · max ${money(report.asset.maxSupply)}` : ''),
    ));
    console.log();

    const maxBucket = report.buckets.reduce((m, b) => (b.amount > m ? b.amount : m), 0n);
    const header = `  ${padEnd('CATEGORY', labelWidth)} ${padStart('BTS', amountWidth)} ${padStart('SHARE', pctWidth)}`;
    console.log(c(colors.bold, header));
    console.log(c(colors.gray, `  ${'─'.repeat(labelWidth + amountWidth + pctWidth + 2)}`));

    for (const bucket of report.buckets) {
        if (bucket.amount === 0n) continue;
        const pct = sharePercent(bucket.amount, supply);
        const label = padEnd(bucket.label.slice(0, labelWidth - 2), labelWidth);
        const line = `  ${c(colors.cyan, label)} ${padStart(money(bucket.amount), amountWidth)} `
            + `${c(colors.spread, padStart(pct, pctWidth))}  ${c(colors.gray, '▕')}`
            + c(colors.blue, bar(bucket.amount, maxBucket)) + c(colors.gray, '▏');
        console.log(line);
    }

    console.log(c(colors.gray, `  ${'─'.repeat(labelWidth + amountWidth + pctWidth + 2)}`));
    console.log(
        `  ${c(colors.bold, padEnd('Identified / dormant', labelWidth))} `
        + `${c(colors.bold, padStart(money(report.identified), amountWidth))} `
        + `${c(colors.bold + colors.spread, padStart(sharePercent(report.identified, supply), pctWidth))}`,
    );
    console.log(
        `  ${c(colors.bold, padEnd('Liquid residual', labelWidth))} `
        + `${c(colors.bold, padStart(money(report.residual), amountWidth))} `
        + `${c(colors.bold + colors.spread, padStart(sharePercent(report.residual, supply), pctWidth))}`
        + c(colors.gray, '  accounts · order books · blinded'),
    );
    console.log(c(
        colors.gray,
        `  of which blinded balances: ${money(report.supply.confidential)} `
        + `(${sharePercent(report.supply.confidential, supply)}) — part of the residual, not additive`,
    ));
    console.log(c(colors.gray, `  bars are scaled to the largest bucket; check the reconcile: `
        + `${money(report.identified + report.residual)} = supply`));

    // ---- Detail sections ----------------------------------------------------
    const section = (title: string): void => {
        console.log();
        console.log(c(colors.bold + colors.yellow, `  ── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`));
    };

    section(`Settlement pools (${report.details.mpaCount} BTS-backed MPAs)`);
    console.log(
        c(colors.gray, '  Global: ' + money(report.buckets.find((b) => b.key === 'settlementFund')?.amount ?? 0n))
        + c(colors.gray, '  ·  Individual: ')
        + c(colors.white, money(report.buckets.find((b) => b.key === 'individualSettlementFund')?.amount ?? 0n)),
    );
    printMpaTable(report, opts.detail, money, c);
    printSettlementTable(report, money, c);

    section('Governance tickets by lock type');
    printTypeTable(report.details.tickets.byType, supply, money, c);

    section('Vesting balances by balance type');
    printTypeTable(report.details.vesting.byType, supply, money, c);
    if (report.details.vesting.hitLimit) {
        console.log(c(colors.sell, `  warning: vesting scan reached --vesting-max ${opts.vestingMax}; totals may be incomplete`));
    }

    section('Top governance ticket holders');
    printHolderTable(report.details.tickets.top, money, c);

    section('Top vesting balance owners');
    printHolderTable(report.details.vesting.top, money, c);

    section('Liquidity pools with BTS');
    printPoolTable(report, opts.detail, money, c);

    section(`Top liquid holders (rich list, ${report.details.holders.count} fetched)`);
    const holders = report.details.holders;
    if (holders.top.length === 0) {
        console.log(c(colors.gray, '  (asset_api unavailable — no holder data)'));
    } else {
        console.log(c(
            colors.gray,
            `  ${holders.complete ? `${holders.count} account balances` : `top ${holders.count} account balances`} = `
            + `${money(holders.total)} BTS `
            + `(${sharePercent(holders.total, supply)} of supply, `
            + `${sharePercent(holders.total, report.residual)} of the residual)`
            + (holders.totalCount !== null ? ` · ${holders.totalCount} holder rows on-chain` : ''),
        ));
        if (holders.complete && holders.untrackedLiquid !== null && holders.orderBookAndOther !== null) {
            console.log(c(
                colors.gray,
                `  residual split: accounts ${money(holders.total)} `
                + `(${sharePercent(holders.total, report.residual)}) · blinded ${money(report.supply.confidential)} · `
                + `order books + other ${money(holders.orderBookAndOther)} `
                + `(${sharePercent(holders.orderBookAndOther, report.residual)})`,
            ));
        }
        for (const row of holders.top) {
            const tag = row.exchange ? c(colors.spread, ` [${row.exchange}]`) : '';
            console.log(
                `  #${String(row.rank ?? 0).padStart(3)} ${padEnd((row.name ?? row.id).slice(0, 30), 30)} `
                + `${padStart(money(row.amount), 20)} ${padStart(sharePercent(row.amount, supply), 8)}${tag}`,
            );
        }
        if (holders.exchanges.length > 0) {
            console.log(c(colors.gray, '  exchange-linked holdings in the fetched set:'));
            for (const agg of holders.exchanges) {
                console.log(
                    `      ${padEnd(agg.label.slice(0, 14), 14)} ${padStart(money(agg.amount), 18)} `
                    + `${padStart(sharePercent(agg.amount, supply), 8)} `
                    + c(colors.gray, `${agg.count} account(s)`),
                );
            }
        }
        if (holders.concentration.length > 0) {
            console.log(c(colors.gray, '  concentration of the liquid residual:'));
            for (const row of holders.concentration) {
                console.log(
                    `      top ${String(row.top).padStart(6)} accounts ${padStart(money(row.amount), 18)} `
                    + `${padStart(sharePercent(row.amount, report.residual), 8)} of the residual`,
                );
            }
        }
        if (holders.median !== null && holders.mean !== null) {
            console.log(c(
                colors.gray,
                `  median balance ${money(holders.median)} BTS · mean ${money(holders.mean)} BTS`,
            ));
        }
        if (holders.histogram.length > 0) {
            console.log(c(colors.gray, '  balance distribution across all holder accounts:'));
            for (const row of holders.histogram) {
                console.log(
                    `      ${padEnd(row.label, 24)} ${String(row.count).padStart(8)} accounts `
                    + `${padStart(money(row.amount), 18)} `
                    + `${padStart(sharePercent(row.amount, report.residual), 8)} of residual`,
                );
            }
        }
    }

    section('Credit & SameT');
    const credit = report.details.credit;
    console.log(`  credit offers      ${padStart(money(credit.offerTotal), 20)}  ${c(colors.gray, `${credit.btsOfferCount}/${credit.offerCount} offers in ${report.asset.symbol}`)}`);
    console.log(`  credit collateral  ${padStart(money(credit.dealTotal), 20)}  ${c(colors.gray, `${credit.btsDealCount}/${credit.dealCount} deals collateralised in ${report.asset.symbol}`)}`);
    console.log(`  SameT funds        ${padStart(money(report.details.samet.total), 20)}  ${c(colors.gray, `${report.details.samet.btsCount}/${report.details.samet.count} funds in ${report.asset.symbol}`)}`);

    section('Asset fee pools (held in BTS)');
    console.log(`  total              ${padStart(money(report.details.feePools.total), 20)}`);
    for (const row of report.details.feePools.top) {
        console.log(`  ${padEnd(row.symbol.slice(0, 22), 22)} ${padStart(money(row.amount), 20)}`);
    }

    section('Legacy 1.15.x balances');
    console.log(`  claimable objects  ${padStart(money(report.details.genesis.total), 20)}  ${c(colors.gray, `${report.details.genesis.count} object(s), ${report.details.genesis.claimableCount} without vesting policy`)}`);

    // ---- Final comparison against circulating supply ----------------------
    section('Circulating supply comparison');
    const circ = report.circulating;
    const circWidth = 24;
    console.log(
        `  ${padEnd('Total supply (current_supply)', 36)} ${padStart(money(supply), circWidth)} `
        + `${padStart('100.00%', pctWidth)}`,
    );
    console.log(
        `  ${padEnd('− identified / dormant', 36)} ${padStart(money(report.identified), circWidth)} `
        + `${padStart(sharePercent(report.identified, supply), pctWidth)}`,
    );
    console.log(
        `  ${c(colors.bold, padEnd('= circulating float (derived)', 36))} `
        + `${c(colors.bold, padStart(money(circ.derived), circWidth))} `
        + `${c(colors.bold + colors.spread, padStart(sharePercent(circ.derived, supply), pctWidth))}`,
    );
    console.log(
        c(colors.gray, `    blinded balances inside the float: ${money(report.supply.confidential)} `
        + `(${sharePercent(report.supply.confidential, circ.derived)} of the float)`),
    );
    console.log(
        c(colors.gray, `    legacy 1.15.x treated as circulating instead: ${money(circ.includingLegacy)} `
        + `(${sharePercent(circ.includingLegacy, supply)} of supply)`),
    );
    console.log(
        `  ${padEnd('Locked per 1 circulating BTS', 36)} ${padStart(circ.lockedPerCirculating.toFixed(4), circWidth)}`,
    );
    if (circ.reference !== null) {
        const delta = circ.derived - circ.reference;
        const relative = circ.reference > 0n
            ? `${delta >= 0n ? '+' : ''}${(Number((delta * 10_000n) / circ.reference) / 100).toFixed(2)}%`
            : '—';
        console.log(
            `  ${padEnd('Reference circulating (--circulating)', 36)} ${padStart(money(circ.reference), circWidth)}`,
        );
        console.log(
            `  ${padEnd('Chain float − reference', 36)} ${padStart(money(delta), circWidth)} `
            + c(colors.gray, ` ${relative}`),
        );
    }
    console.log();
    console.log(c(colors.bold, `  ${padEnd('CATEGORY', labelWidth)} ${padStart('BTS', amountWidth)} `
        + `${padStart('% SUPPLY', pctWidth)} ${padStart('% FLOAT', pctWidth)}`));
    console.log(c(colors.gray, `  ${'─'.repeat(labelWidth + amountWidth + pctWidth * 2 + 3)}`));
    for (const bucket of report.buckets) {
        if (bucket.amount === 0n) continue;
        console.log(
            `  ${padEnd(bucket.label.slice(0, labelWidth - 2), labelWidth)} `
            + `${padStart(money(bucket.amount), amountWidth)} `
            + `${padStart(sharePercent(bucket.amount, supply), pctWidth)} `
            + `${padStart(sharePercent(bucket.amount, circ.derived), pctWidth)}`,
        );
    }
    console.log(c(colors.gray, `  ${'─'.repeat(labelWidth + amountWidth + pctWidth * 2 + 3)}`));
    console.log(
        c(colors.gray, '  Float = supply − identified/dormant. BitShares has no protocol-level '
        + '"circulating" field; this is a derived float.'),
    );

    if (report.details.warnings.length > 0) {
        section('Warnings');
        for (const warning of report.details.warnings) console.log(c(colors.sell, `  ! ${warning}`));
    }

    console.log();
    if (opts.html) console.log(c(colors.brightGreen, `  HTML report: ${opts.html}`));
    console.log(c(colors.gray, '  Collateral: api_helper_indexes total_in_collateral; rest via list_* / get_objects scans.'));
    console.log();
}

function printMpaTable(
    report: Report,
    detail: number,
    money: (v: bigint) => string,
    c: (code: string, text: string) => string,
): void {
    const rows = report.details.mpas.slice(0, detail);
    if (rows.length === 0) {
        console.log(c(colors.gray, '  (none)'));
        return;
    }
    console.log(c(colors.gray, `  ${padEnd('MPA', 14)} ${padStart('COLLATERAL', 18)} ${padStart('SETTLE FUND', 16)} ${padStart('INDIV. FUND', 16)}`));
    for (const row of rows) {
        const flags = row.settled ? ' [settled]' : '';
        console.log(
            `  ${padEnd(row.symbol.slice(0, 14), 14)} ${padStart(money(row.collateral), 18)} `
            + `${padStart(money(row.settlementFund), 16)} ${padStart(money(row.individualSettlementFund), 16)}`
            + c(colors.gray, flags),
        );
    }
}

function formatDelay(seconds: number | null): string {
    if (seconds === null) return '—';
    if (seconds >= 86400) return `${(seconds / 86400).toFixed(seconds % 86400 === 0 ? 0 : 1)}d`;
    if (seconds >= 3600) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
    if (seconds >= 60) return `${(seconds / 60).toFixed(seconds % 60 === 0 ? 0 : 1)}m`;
    return `${seconds}s`;
}

function printSettlementTable(
    report: Report,
    money: (v: bigint) => string,
    c: (code: string, text: string) => string,
): void {
    const rows = report.details.settlements;
    if (rows.length === 0) return;
    console.log();
    console.log(c(colors.gray, '  Individual settlement pools: the fund is BTS (already counted above);'));
    console.log(c(colors.gray, '  debt / max / settled volumes are in each MPA\'s own units and are not BTS.'));
    console.log(c(colors.gray, `  ${padEnd('MPA', 12)} ${padStart('FUND (BTS)', 18)} ${padStart('INDIV. DEBT', 18)} `
        + `${padStart('FUND PRICE', 16)} ${padStart('OFF', 6)} ${padStart('FEE', 6)} ${padStart('DELAY', 7)} `
        + `${padStart('MAX/PERIOD', 14)} ${padStart('SETTLED', 12)} ${padStart('REMAIN', 7)}`));
    for (const row of rows) {
        const debt = formatUnits(row.debt, row.precision);
        const maxVolume = formatUnits(row.maxVolume, row.precision);
        const settled = formatUnits(row.settledVolume, row.precision);
        const price = row.fundPrice !== null ? `${row.fundPrice.toFixed(4)}` : '—';
        console.log(
            `  ${padEnd(row.symbol.slice(0, 12), 12)} ${padStart(money(row.fund), 18)} ${padStart(debt, 18)} `
            + `${padStart(price, 16)} ${padStart(row.offsetPercent !== null ? `${row.offsetPercent.toFixed(1)}%` : '—', 6)} `
            + `${padStart(row.feePercent !== null ? `${row.feePercent.toFixed(1)}%` : '—', 6)} `
            + `${padStart(formatDelay(row.delaySeconds), 7)} ${padStart(maxVolume, 14)} ${padStart(settled, 12)} `
            + `${padStart(row.remainingPercent !== null ? `${row.remainingPercent.toFixed(1)}%` : '—', 7)}`,
        );
    }
    console.log(c(colors.gray, '  fund price = individual settlement fund (BTS) / individual settlement debt (MPA units).'));
}

function printTypeTable(
    rows: TypeRow[],
    supply: bigint,
    money: (v: bigint) => string,
    c: (code: string, text: string) => string,
): void {
    if (rows.length === 0) {
        console.log(c(colors.gray, '  (none)'));
        return;
    }
    for (const row of rows) {
        console.log(
            `  ${padEnd(row.type.slice(0, 18), 18)} ${padStart(money(row.amount), 20)} `
            + `${padStart(sharePercent(row.amount, supply), 8)} ${c(colors.gray, `${row.count} object(s)`)}`,
        );
    }
}

function printHolderTable(
    rows: HolderRow[],
    money: (v: bigint) => string,
    c: (code: string, text: string) => string,
): void {
    if (rows.length === 0) {
        console.log(c(colors.gray, '  (none)'));
        return;
    }
    for (const row of rows) {
        const name = row.name ? `${row.name} (${row.id})` : row.id;
        const tag = row.exchange ? ` [${row.exchange}]` : '';
        console.log(`  ${padEnd(name.slice(0, 32), 32)} ${padStart(money(row.amount), 20)}${tag}`);
    }
}

function printPoolTable(
    report: Report,
    detail: number,
    money: (v: bigint) => string,
    c: (code: string, text: string) => string,
): void {
    const rows = report.details.pools.top.slice(0, detail);
    if (rows.length === 0) {
        console.log(c(colors.gray, '  (none)'));
        return;
    }
    console.log(c(colors.gray, `  ${padEnd('POOL', 12)} ${padEnd('PAIR', 24)} ${padStart('BTS', 18)}`));
    for (const row of rows) {
        console.log(`  ${padEnd(row.id, 12)} ${padEnd(row.pair.slice(0, 24), 24)} ${padStart(money(row.bts), 18)}`);
    }
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

function esc(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

interface Slice {
    label: string;
    value: bigint;
    color: string;
}

/** Fold hairline slices into a single "Other" wedge so the donut stays readable. */
function groupSlices(slices: Slice[], total: bigint, minShare = 0.004): Slice[] {
    const kept: Slice[] = [];
    let other = 0n;
    for (const slice of slices) {
        if (slice.value === 0n) continue;
        if (shareFraction(slice.value, total) < minShare) other += slice.value;
        else kept.push(slice);
    }
    if (other > 0n) kept.push({ label: 'Other (smaller buckets)', value: other, color: '#6e7681' });
    return kept;
}

function donutSvg(
    slices: Slice[],
    total: bigint,
    centerLabel: string,
    centerValue: string,
    precision: number,
): string {
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    const parts: string[] = [];
    for (const slice of slices) {
        const length = circumference * shareFraction(slice.value, total);
        const pct = sharePercent(slice.value, total);
        parts.push(
            `<circle cx="50" cy="50" r="${radius}" fill="none" stroke="${slice.color}" stroke-width="15"`
            + ` stroke-dasharray="${length.toFixed(3)} ${(circumference - length).toFixed(3)}"`
            + ` stroke-dashoffset="${(-offset).toFixed(3)}" transform="rotate(-90 50 50)">`
            + `<title>${esc(slice.label)}: ${esc(formatUnits(slice.value, precision))} BTS (${pct})</title>`
            + '</circle>',
        );
        offset += length;
    }
    return `<svg viewBox="0 0 100 100" role="img" aria-label="BTS supply composition" class="donut">
        <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#21262d" stroke-width="15"/>
        ${parts.join('')}
        <text x="50" y="44.5" text-anchor="middle" class="donut-kicker">${esc(centerLabel)}</text>
        <text x="50" y="55" text-anchor="middle" class="donut-value">${esc(centerValue)}</text>
        <text x="50" y="62" text-anchor="middle" class="donut-unit">BTS</text>
    </svg>`;
}

function htmlTable(headers: string[], rows: string[][], numericFrom = 1): string {
    if (rows.length === 0) return '<p class="muted">No data.</p>';
    const head = headers.map((h, i) => `<th class="${i >= numericFrom ? 'num' : ''}">${esc(h)}</th>`).join('');
    const body = rows.map((row) => `<tr>${row.map((cell, i) => `<td class="${i >= numericFrom ? 'num' : ''}">${cell}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderHtml(report: Report): string {
    const p = report.asset.precision;
    const supply = report.supply.current;
    const money = (v: bigint): string => formatUnits(v, p);
    const pct = (v: bigint): string => sharePercent(v, supply);

    const allSlices: Slice[] = [
        ...report.buckets.map((b) => ({ label: b.label, value: b.amount, color: b.color })),
        { label: 'Liquid residual', value: report.residual, color: '#4b5563' },
    ];
    const slices = groupSlices(allSlices, supply);
    const lockedSlices = groupSlices(
        report.buckets.map((b) => ({ label: b.label, value: b.amount, color: b.color })),
        report.identified > 0n ? report.identified : 1n,
    );

    const legend = slices
        .map((s) => `<li>
            <span class="dot" style="background:${s.color}"></span>
            <span class="legend-label">${esc(s.label)}</span>
            <span class="legend-value">${money(s.value)}</span>
            <span class="legend-share">${pct(s.value)}</span>
        </li>`)
        .join('');

    const maxBucket = report.buckets.reduce((m, b) => (b.amount > m ? b.amount : m), 0n);
    const bars = report.buckets
        .filter((b) => b.amount > 0n)
        .map((b) => `<div class="bar-row">
            <span class="bar-label"><span class="dot" style="background:${b.color}"></span>${esc(b.label)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(shareFraction(b.amount, maxBucket) * 100).toFixed(4)}%;background:${b.color}"></span></span>
            <span class="bar-amount">${money(b.amount)}</span>
            <span class="bar-share">${pct(b.amount)}</span>
        </div>`)
        .join('');

    const mpaRows = report.details.mpas.map((row) => [
        `${esc(row.symbol)}${row.settled ? ' <span class="tag">settled</span>' : ''}`,
        esc(row.assetId),
        money(row.collateral),
        money(row.settlementFund),
        money(row.individualSettlementFund),
    ]);

    const ticketTypeRows = report.details.tickets.byType.map((row) => [esc(row.type), String(row.count), money(row.amount), pct(row.amount)]);
    const vestingRows = report.details.vesting.byType.map((row) => [esc(row.type), String(row.count), money(row.amount), pct(row.amount)]);
    const holderBadge = (row: HolderRow): string =>
        `${esc(row.name ?? row.id)}${row.exchange ? ` <span class="tag cex">${esc(row.exchange)}</span>` : ''}`;
    const ticketTopRows = report.details.tickets.top.map((row) => [
        holderBadge(row),
        esc(row.id),
        money(row.amount),
        pct(row.amount),
    ]);
    const vestingTopRows = report.details.vesting.top.map((row) => [
        holderBadge(row),
        esc(row.id),
        money(row.amount),
        pct(row.amount),
    ]);
    const settlementRows = report.details.settlements.map((row) => [
        esc(row.symbol),
        money(row.fund),
        formatUnits(row.debt, row.precision),
        row.fundPrice !== null ? `${row.fundPrice.toFixed(4)} BTS/${esc(row.symbol)}` : '—',
        row.offsetPercent !== null ? `${row.offsetPercent.toFixed(1)}%` : '—',
        row.feePercent !== null ? `${row.feePercent.toFixed(1)}%` : '—',
        formatDelay(row.delaySeconds),
        formatUnits(row.maxVolume, row.precision),
        formatUnits(row.settledVolume, row.precision),
        row.remainingPercent !== null ? `${row.remainingPercent.toFixed(1)}%` : '—',
    ]);
    const settlementCard = `<section class="card">
      <div class="head-row"><h2>Force settlement / individual pools</h2><span class="hint">${report.details.settlementCount} MPA(s) with individual settlement pools</span></div>
      <p class="muted" style="margin:0 0 10px">
        The fund column is BTS and is exactly what the <em>Individual settlement fund</em> bucket sums.
        Debt, max-volume and settled-volume columns are denominated in each MPA and are not added to the BTS totals.
        Fund price is <code>fund / debt</code> (the UI's "Force Settlement Price (offset included)" is feed-based; this is the pool-implied price).
      </p>
      ${htmlTable(
          ['MPA', 'Individual fund (BTS)', 'Individual debt', 'Fund price', 'Offset', 'Fee', 'Delay', 'Max / period', 'Already settled', 'Remaining'],
          settlementRows,
          1,
      )}
      <p class="muted" style="margin-top:10px">
        The settlement fund is held by the protocol and only moves when the MPA is force-settled, so it is
        reported as locked BTS even though the debt side is denominated in the MPA.
      </p>
    </section>`;

    const holders = report.details.holders;
    const holderRows = holders.top.map((row) => [
        String(row.rank ?? ''),
        holderBadge(row),
        esc(row.id),
        money(row.amount),
        pct(row.amount),
    ]);
    const exchangeRows = holders.exchanges.map((row) => [
        `<span class="tag cex">${esc(row.label)}</span>`,
        String(row.count),
        money(row.amount),
        pct(row.amount),
    ]);
    const concentrationRows = holders.concentration.map((row) => [
        `Top ${row.top}`,
        String(row.count),
        money(row.amount),
        sharePercent(row.amount, report.residual),
    ]);
    const histogramRows = holders.histogram.map((row) => [
        esc(row.label),
        String(row.count),
        money(row.amount),
        sharePercent(row.amount, report.residual),
    ]);
    const poolRows = report.details.pools.top.map((row) => [esc(row.id), esc(row.pair), money(row.bts), pct(row.bts)]);
    const sametRows = report.details.samet.top.map((row) => [esc(row.name ?? row.owner), esc(row.id), money(row.amount), pct(row.amount)]);
    const feeRows = report.details.feePools.top.map((row) => [esc(row.symbol), money(row.amount), pct(row.amount)]);

    const warningHtml = report.details.warnings.length > 0
        ? `<section class="card warn"><h2>Warnings</h2><ul>${report.details.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`
        : '';

    const credit = report.details.credit;
    const circ = report.circulating;
    const lockedWidth = (shareFraction(report.identified, supply) * 100).toFixed(3);
    const floatWidth = (shareFraction(circ.derived, supply) * 100).toFixed(3);
    const comparisonRows = report.buckets
        .filter((b) => b.amount > 0n)
        .map((b) => [esc(b.label), money(b.amount), pct(b.amount), sharePercent(b.amount, circ.derived)]);
    const referenceHtml = circ.reference !== null
        ? (() => {
            const delta = circ.derived - circ.reference;
            const relative = circ.reference > 0n
                ? `${delta >= 0n ? '+' : ''}${(Number((delta * 10_000n) / circ.reference) / 100).toFixed(2)}%`
                : '—';
            return `<p class="muted" style="margin-top:12px">
                Reference circulating (<code>--circulating</code>): <strong>${money(circ.reference)}</strong> BTS ·
                chain float − reference: <strong>${money(delta)}</strong> BTS (${relative})
            </p>`;
        })()
        : '';
    const circulatingCard = `<section class="card">
    <div class="head-row"><h2>Circulating supply comparison</h2><span class="hint">float = current supply − identified / dormant</span></div>
    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Total supply</div><div class="v">${money(supply)}</div><div class="s">current_supply · 100%</div></div>
      <div class="kpi"><div class="k">Identified / dormant</div><div class="v">${money(report.identified)}</div><div class="s">${pct(report.identified)} of supply</div></div>
      <div class="kpi"><div class="k">Circulating float</div><div class="v">${money(circ.derived)}</div><div class="s">${pct(circ.derived)} of supply</div></div>
      <div class="kpi"><div class="k">Locked per 1 float</div><div class="v">${circ.lockedPerCirculating.toFixed(4)}</div><div class="s">BTS held per BTS circulating</div></div>
    </div>
    <div class="flow-bar">
      <span class="flow-locked" style="width:${lockedWidth}%">locked ${pct(report.identified)}</span>
      <span class="flow-float" style="width:${floatWidth}%">float ${pct(circ.derived)}</span>
    </div>
    ${htmlTable(['Bucket', 'BTS', '% of supply', '% of float'], comparisonRows, 1)}
    <p class="muted" style="margin-top:12px">
      BitShares exposes only <code>current_supply</code> (coins in existence); there is no protocol-level
      circulating field. The float above removes every bucket this report can identify, including
      pre-migration balances and order-book escrow implicit in the residual.
      If legacy 1.15.x balances are treated as circulating, the float becomes
      <strong>${money(circ.includingLegacy)}</strong> BTS (${pct(circ.includingLegacy)} of supply).
      Blinded balances inside the float: ${money(report.supply.confidential)} BTS
      (${sharePercent(report.supply.confidential, circ.derived)} of the float).
    </p>
    ${referenceHtml}
  </section>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>BTS distribution · block ${formatInteger(BigInt(report.blockNum))}</title>
<style>
:root{
  --bg:#0b0e14; --panel:#11161d; --panel-2:#161b22; --border:#242c38;
  --text:#d1d5db; --muted:#8b949e; --bright:#f0f6fc; --accent:#5eb0ef; --warn:#f0883e;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
body{padding:28px 22px 52px;max-width:1320px;margin:0 auto;line-height:1.45}
h1,h2,h3{margin:0;font-weight:600;color:var(--bright)}
h1{font-size:26px;letter-spacing:.2px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:1.3px;color:var(--muted);margin-bottom:14px}
a{color:var(--accent)}
.sub{color:var(--muted);font-size:13px;margin-top:6px;font-variant-numeric:tabular-nums}
.hero{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap;margin-bottom:22px}
.badge{display:inline-block;padding:3px 9px;border:1px solid var(--border);border-radius:999px;font-size:11px;color:var(--muted);background:var(--panel)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.kpi .k{font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:var(--muted)}
.kpi .v{font-size:23px;font-weight:600;color:var(--bright);margin-top:5px;font-variant-numeric:tabular-nums;word-break:break-all}
.kpi .s{font-size:12px;color:var(--muted);margin-top:2px}
.grid{display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:18px;margin-bottom:18px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px 22px}
.card.warn{border-color:#5c3a12;background:#1a1207;margin-bottom:18px}
.card.warn h2{color:var(--warn)}
.card.warn li{color:#f3c99a}
.donut{width:100%;height:auto;max-height:380px;display:block}
.donut-kicker{fill:var(--muted);font-size:4.4px;text-transform:uppercase;letter-spacing:.9px}
.donut-value{fill:var(--bright);font-size:9px;font-weight:600;font-variant-numeric:tabular-nums}
.donut-unit{fill:var(--muted);font-size:4.2px;letter-spacing:1px}
.legend{list-style:none;margin:18px 0 0;padding:0;font-size:12.5px}
.legend li{display:grid;grid-template-columns:12px 1fr auto 62px;gap:8px;align-items:center;padding:5px 0;border-top:1px solid #1c222b}
.legend li:first-child{border-top:0}
.dot{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.legend-label{color:var(--text)}
.legend-value{font-variant-numeric:tabular-nums;color:var(--bright)}
.legend-share{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.bars{display:flex;flex-direction:column;gap:9px}
.bar-row{display:grid;grid-template-columns:minmax(190px,270px) 1fr 150px 62px;gap:12px;align-items:center;font-size:12.5px}
.bar-label{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{height:13px;background:#1b212b;border-radius:7px;overflow:hidden;border:1px solid #222b37}
.bar-fill{display:block;height:100%;border-radius:7px;min-width:2px}
.bar-amount{text-align:right;font-variant-numeric:tabular-nums;color:var(--bright)}
.bar-share{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
@media(max-width:760px){.bar-row{grid-template-columns:1fr 90px 54px}.bar-track{display:none}}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1c222b;white-space:nowrap}
th{font-size:10.5px;text-transform:uppercase;letter-spacing:.9px;color:var(--muted);font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:#151b23}
.tag{display:inline-block;padding:1px 6px;margin-left:6px;border-radius:999px;font-size:10px;background:#3b2a12;color:#f0b46d;border:1px solid #64401a}
.tag.cex{background:#10263a;color:#7cc4ff;border-color:#245273}
.muted{color:var(--muted);font-size:12.5px}
footer{margin-top:24px;color:var(--muted);font-size:11.5px;border-top:1px solid var(--border);padding-top:14px}
footer p{margin:4px 0}
.split{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:900px){.split{grid-template-columns:1fr}}
.stack{display:grid;gap:18px}
.head-row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:10px}
.head-row .hint{font-size:11.5px;color:var(--muted)}
.flow-bar{display:flex;height:30px;border-radius:8px;overflow:hidden;border:1px solid var(--border);margin:8px 0 14px;font-size:11.5px}
.flow-bar span{display:flex;align-items:center;justify-content:center;white-space:nowrap;font-weight:600;min-width:2px}
.flow-locked{background:#f0883e;color:#1a1207}
.flow-float{background:#4b5563;color:#e6edf3}
</style>
</head>
<body>
<div class="hero">
  <div>
    <h1>BTS supply distribution</h1>
    <div class="sub">block ${esc(formatInteger(BigInt(report.blockNum)))} · ${esc(report.blockTime)} · ${esc(report.node)}</div>
    <div class="sub">${esc(report.asset.symbol)} (${esc(report.asset.id)}) · precision ${p} · total supply ${money(supply)}${report.asset.maxSupply ? ` · max ${money(report.asset.maxSupply)}` : ''}</div>
  </div>
  <div><span class="badge">generated ${esc(report.generatedAt)}</span> <span class="badge">${report.details.assetCount} assets scanned</span></div>
</div>

<div class="kpis">
  <div class="kpi"><div class="k">Total supply</div><div class="v">${money(supply)}</div><div class="s">${esc(report.asset.symbol)} in existence</div></div>
  <div class="kpi"><div class="k">Identified / dormant</div><div class="v">${money(report.identified)}</div><div class="s">${pct(report.identified)} of supply</div></div>
  <div class="kpi"><div class="k">Liquid residual</div><div class="v">${money(report.residual)}</div><div class="s">${pct(report.residual)} of supply</div></div>
  <div class="kpi"><div class="k">Blinded balances</div><div class="v">${money(report.supply.confidential)}</div><div class="s">${pct(report.supply.confidential)} · part of the residual</div></div>
  <div class="kpi"><div class="k">Top ${holders.count} liquid holders</div><div class="v">${money(holders.total)}</div><div class="s">${pct(holders.total)} of supply · rich list via asset_api</div></div>
</div>

<div class="grid">
  <section class="card">
    <h2>Where the BTS is</h2>
    ${donutSvg(slices, supply, 'total supply', compactUnits(supply, p), p)}
    <ul class="legend">${legend}</ul>
  </section>
  <section class="card">
    <div class="head-row"><h2>Identified supply composition</h2><span class="hint">residual excluded · bars scaled to largest bucket</span></div>
    ${donutSvg(lockedSlices, report.identified > 0n ? report.identified : 1n, 'identified', compactUnits(report.identified, p), p)}
    <div class="bars" style="margin-top:22px">${bars}</div>
  </section>
</div>

<div class="stack">
  <section class="card">
    <h2>Category breakdown</h2>
    ${htmlTable(
        ['Category', 'BTS', 'Share of supply', 'What it is'],
        report.buckets.map((b) => [
            `<span class="dot" style="background:${b.color};margin-right:8px"></span>${esc(b.label)}`,
            money(b.amount),
            pct(b.amount),
            `<span class="muted">${esc(b.note)}</span>`,
        ]),
        1,
    )}
  </section>

  <section class="card">
    <div class="head-row"><h2>Top liquid holders (rich list)</h2><span class="hint">account balances only · asset_api${holders.sourceNode ? ` · ${esc(holders.sourceNode)}` : ''}</span></div>
    <p class="muted" style="margin:0 0 10px">
      Top ${holders.count}${holders.totalCount !== null ? ` of ${holders.totalCount}` : ''} accounts hold
      <strong>${money(holders.total)}</strong> BTS — ${pct(holders.total)} of supply and
      ${sharePercent(holders.total, report.residual)} of the liquid residual.
      Exchange tags come from a name heuristic (anyone can register a brand-like name), so treat them as hints.
    </p>
    ${htmlTable(['#', 'Account', 'Id', 'BTS', 'Share of supply'], holderRows, 3)}
    ${holders.complete && holders.untrackedLiquid !== null && holders.orderBookAndOther !== null ? `
    <p class="muted" style="margin:14px 0 0">
      <strong>Residual split:</strong> account balances ${money(holders.total)} BTS
      (${sharePercent(holders.total, report.residual)} of the residual) ·
      blinded balances ${money(report.supply.confidential)} BTS ·
      order books + other ${money(holders.orderBookAndOther)} BTS
      (${sharePercent(holders.orderBookAndOther, report.residual)} of the residual).
      ${holders.median !== null && holders.mean !== null
          ? `Median account balance ${money(holders.median)} BTS · mean ${money(holders.mean)} BTS.`
          : ''}
    </p>` : ''}
    <h3 style="margin:18px 0 10px;font-size:13px">Exchange-linked holdings in the fetched set</h3>
    ${htmlTable(['Exchange', 'Accounts', 'BTS', 'Share of supply'], exchangeRows, 1)}
    ${concentrationRows.length > 0 ? `
    <h3 style="margin:18px 0 10px;font-size:13px">Concentration of the liquid residual</h3>
    ${htmlTable(['Accounts', 'Count', 'BTS', 'Share of residual'], concentrationRows, 1)}` : ''}
    ${histogramRows.length > 0 ? `
    <h3 style="margin:18px 0 10px;font-size:13px">Balance distribution across all holder accounts</h3>
    ${htmlTable(['Balance band', 'Accounts', 'BTS', 'Share of residual'], histogramRows, 1)}` : ''}
  </section>

  <section class="card">
    <div class="head-row"><h2>Collateral &amp; settlement pools</h2><span class="hint">${report.details.mpaCount} BTS-backed MPAs</span></div>
    ${htmlTable(
        ['MPA', 'Asset id', 'Collateral (BTS)', 'Global settlement fund', 'Individual settlement fund'],
        mpaRows,
        2,
    )}
    <p class="muted" style="margin-top:10px">Call-order collateral total: <strong>${money(report.buckets.find((b) => b.key === 'collateral')?.amount ?? 0n)}</strong> BTS${report.details.collateralFromApi ? ' (api_helper_indexes total_in_collateral)' : ' (fallback: summed per-MPA call orders)'}${report.details.collateralTruncated ? ' — truncated by node limits' : ''}.</p>
  </section>

  ${settlementCard}

  <div class="split">
    <section class="card">
      <h2>Governance tickets</h2>
      ${htmlTable(['Lock type', 'Tickets', 'BTS locked', 'Share'], ticketTypeRows, 1)}
      <p class="muted" style="margin-top:12px">Status: ${report.details.tickets.byStatus.map((s) => `${esc(s.type)} ${money(s.amount)}`).join(' · ') || 'none'}</p>
      <h3 style="margin:16px 0 10px;font-size:13px">Top holders</h3>
      ${htmlTable(['Account', 'Id', 'BTS', 'Share'], ticketTopRows, 2)}
    </section>
    <section class="card">
      <h2>Vesting balances</h2>
      ${htmlTable(['Balance type', 'Objects', 'BTS', 'Share'], vestingRows, 1)}
      <p class="muted" style="margin-top:12px">Scanned 1.13.0–1.13.${report.details.vesting.scannedTo}${report.details.vesting.hitLimit ? ' (scan hit --vesting-max, totals may be incomplete)' : ''}.</p>
      <h3 style="margin:16px 0 10px;font-size:13px">Top owners</h3>
      ${htmlTable(['Account', 'Id', 'BTS', 'Share'], vestingTopRows, 2)}
    </section>
  </div>

  <div class="split">
    <section class="card">
      <h2>Liquidity pools with BTS</h2>
      <p class="muted" style="margin:0 0 10px">${report.details.pools.withBts} of ${report.details.pools.count} pools hold BTS · ${money(report.details.pools.total)} BTS pooled.</p>
      ${htmlTable(['Pool', 'Pair', 'BTS', 'Share'], poolRows, 2)}
    </section>
    <section class="card">
      <h2>DeFi lending</h2>
      ${htmlTable(
          ['Bucket', 'BTS', 'Share', 'Objects'],
          [
              ['Credit offer funds', money(credit.offerTotal), pct(credit.offerTotal), `${credit.btsOfferCount} / ${credit.offerCount}`],
              ['Credit-deal collateral', money(credit.dealTotal), pct(credit.dealTotal), `${credit.btsDealCount} / ${credit.dealCount}`],
              ['SameT funds', money(report.details.samet.total), pct(report.details.samet.total), `${report.details.samet.btsCount} / ${report.details.samet.count}`],
              ['HTLC escrow', money(report.details.htlcs.total), pct(report.details.htlcs.total), String(report.details.htlcs.count)],
              ['Collateral bids', money(report.details.collateralBids.total), pct(report.details.collateralBids.total), String(report.details.collateralBids.count)],
          ],
          1,
      )}
      <h3 style="margin:16px 0 10px;font-size:13px">SameT funds</h3>
      ${htmlTable(['Owner', 'Fund', 'BTS', 'Share'], sametRows, 2)}
    </section>
  </div>

  <div class="split">
    <section class="card">
      <h2>Asset fee pools (BTS)</h2>
      <p class="muted" style="margin:0 0 10px">Every asset's <code>fee_pool</code> is denominated in core BTS. Total ${money(report.details.feePools.total)} BTS.</p>
      ${htmlTable(['Asset', 'BTS', 'Share'], feeRows, 1)}
    </section>
    <section class="card">
      <h2>Legacy balances</h2>
      ${htmlTable(
          ['Metric', 'Value'],
          [
              ['1.15.x balance objects', String(report.details.genesis.count)],
              ['Claimable without vesting policy', String(report.details.genesis.claimableCount)],
              ['With linear vesting policy', String(report.details.genesis.vestingCount)],
              ['Total BTS', money(report.details.genesis.total)],
          ],
          1,
      )}
      <h2 style="margin-top:20px">Reconciliation</h2>
      ${htmlTable(
          ['Line', 'BTS', 'Share'],
          [
              ['Identified / dormant', money(report.identified), pct(report.identified)],
              ['Liquid residual', money(report.residual), pct(report.residual)],
              ['Current supply', money(supply), '100.00%'],
          ],
          1,
      )}
    </section>
  </div>

  ${circulatingCard}
</div>

${warningHtml}

<footer>
  <p><strong>Residual</strong> = current supply − all identified holdings. It contains account balances (2.5.x), limit-order escrow (1.7.x), blinded balances (${money(report.supply.confidential)} BTS) and any object type not listed above. It is derived, not enumerated.</p>
  <p>Sources: bitshares-core 7.0.x database_api — <code>list_assets</code>, <code>get_objects</code>, <code>list_tickets</code>, <code>list_liquidity_pools</code>, <code>list_samet_funds</code>, <code>list_credit_offers</code>, <code>list_credit_deals</code>, <code>list_htlcs</code>, <code>get_collateral_bids</code>${report.details.collateralFromApi ? ', <code>total_in_collateral</code>' : ''}${holders.sourceNode ? ', <code>asset_api::get_asset_holders</code>' : ''}. Read-only; no keys, no transactions. Exchange tags are name heuristics, not verified identities.</p>
  <p>Generated by <code>scripts/bts_distribution.ts</code> · block ${esc(formatInteger(BigInt(report.blockNum)))} · ${esc(report.blockTime)} UTC.</p>
</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    let opts: Options;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        if (e instanceof UsageError) {
            console.error(`${LOG_TAG} Error: ${e.message}\n`);
            printHelp();
            process.exit(2);
        }
        throw e;
    }
    if (opts.help) {
        printHelp();
        return;
    }

    if (!opts.json) console.log(`${LOG_TAG} Loading BTS supply distribution from chain...`);
    const nodes = opts.nodes.length > 0 ? opts.nodes : [...NODE_MANAGEMENT.DEFAULT_NODES];
    const session = await openSession(nodes);
    try {
        const report = await collect(session, opts);

        if (opts.html) {
            fs.mkdirSync(path.dirname(opts.html), { recursive: true });
            fs.writeFileSync(opts.html, renderHtml(report), 'utf8');
        }

        if (opts.json) {
            console.log(JSON.stringify({ ...report, html: opts.html }, (_key, value: unknown) => {
                return typeof value === 'bigint' ? value.toString() : value;
            }, 2));
        } else {
            renderTerminal(report, opts);
            if (opts.html) console.log(`\n${LOG_TAG} ✓ Report saved. Open report: (${toFileUrl(opts.html)})`);
        }
    } finally {
        session.client.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error(`\n${LOG_TAG} Error: ${(e as Error).message}`);
        process.exit(1);
    });
}

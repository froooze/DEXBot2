#!/usr/bin/env node

/**
 * BitShares token distribution analyzer.
 *
 * The per-asset companion to scripts/bts_distribution.ts: answers "where is all
 * of <token>?" on the live chain. Works for any issued asset (UIA/MPA) except
 * the core asset (use bts_distribution for BTS).
 *
 * Buckets:
 *   - free account balances        2.5.x   account_balance_object (asset_api rich list)
 *   - limit orders                 1.7.x   limit_order_object.for_sale (token sold)
 *   - liquidity pools              1.19.x  liquidity_pool_object reserves
 *   - vesting balances             1.13.x  vesting_balance_object (worker/witness/cashback/...)
 *   - P2P credit offers            1.21.x  credit_offer_object.current_balance
 *   - P2P deal collateral          1.22.x  credit_deal_object.collateral_amount
 *   - SameT funds                  1.20.x  samet_fund_object.balance
 *   - HTLC escrow                  1.16.x  htlc_object.transfer
 *   - accumulated market fees      2.3.x   asset_dynamic_data_object.accumulated_fees
 *   - blinded balances             2.3.x   asset_dynamic_data_object.confidential_supply
 *
 * The liquidity side is grouped by *counterpart asset*: every pool and every
 * token sell order is bucketed by the asset on the other side of the trade
 * (token/BTS, token/USD, token/other), so you can see which markets actually
 * hold the token. The HTML report adds a separate liquidity donut and a 3%
 * depth comparison: how much token can be sold (price -3%) or bought (price
 * +3%), combining orderbook and constant-product pool per market, with the
 * result also expressed as a percentage of total supply.
 *
 * Limit orders are not globally indexed by asset in bitshares-core, so the only
 * exact enumeration is one get_limit_orders(token, other) call per listed asset
 * (~6k calls on mainnet). Those calls run concurrently and are skipped with
 * --no-orders.
 *
 * Read-only: opens its own ephemeral WebSocket, never touches a running bot,
 * no keys, no transactions. Chain source of truth: bitshares-core 7.0.x.
 *
 * Usage:
 *   dexbot asset <symbol|1.3.x> [options]            # CLI shortcut
 *   dexbot a <symbol|1.3.x> [options]                # shorthand for the line above
 *   node dist/scripts/token_distribution.js <symbol|1.3.x>
 *   node dist/scripts/token_distribution.js <token> --json
 *   node dist/scripts/token_distribution.js <asset-id> --no-html
 *   node dist/scripts/token_distribution.js <token> --no-orders
 *   node dist/scripts/token_distribution.js <token> --node wss://cloud.xbts.io/ws
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE_MANAGEMENT } from '../modules/constants.js';
import { PATHS } from '../modules/paths.js';
import { CLI_COLORS as colors } from '../modules/cli_colors.js';
import {
    CLI_TAGS, clearProgressLine, loadingLine, savedLine, section, summaryLine, taggedProgress, warningsBlock,
} from '../modules/cli_progress.js';
import { scanIdRange, DENSE_SPACE_GAP } from '../modules/chain_scan.js';
import { resolveAssetRef } from '../modules/asset_lookup.js';
import { toFileUrl } from '../analysis/chart_utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_API = 0;
const LOGIN_API = 1;
const CORE_ID = '1.3.0';
const OBJECT_BATCH = 100;
const NAME_BATCH = 50;
const DEFAULT_DETAIL = 15;
const DEFAULT_VESTING_MAX = 200_000;
const DEFAULT_SCAN_GAP = 20_000;
// One get_limit_orders call per asset (core exposes no per-asset order index);
// 32 concurrent reads measured ~2x faster than 12 with an identical report.
const DEFAULT_CONCURRENCY = 32;
// Holder pages are offset-addressable (asset_api walks by_asset_balance by
// position), so the rich list is fetched in parallel pages. The asset_api nodes
// tolerate this well; 8 keeps ~800 holders in flight.
const HOLDER_PAGE_CONCURRENCY = 8;
const DEFAULT_HTML = path.join(PATHS.ANALYSIS.CHARTS_DIR, 'token-distribution.html');
// Console tag for status lines, matching the `[Liquidity]` style used by the
// other analysis entries.
const LOG_TAG = CLI_TAGS.assets;
const progress = taggedProgress(LOG_TAG);
const clearProgress = clearProgressLine;

// asset_api (get_asset_holders) is allowlisted on only a few public nodes; this
// mirrors scripts/rich_list.ts and scripts/bts_distribution.ts.
const HOLDER_NODES = [
    'wss://dex.iobanker.com/ws',
    'wss://api.dex.trading/ws',
];

const COLORS = [
    '#5eb0ef', '#f0883e', '#3fb950', '#db61a2', '#a371f7', '#e3b341',
    '#39c5cf', '#ff7b72', '#7ee787', '#d2a8ff', '#ffa657', '#8b949e',
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
    issuer: string;
    dynamic_asset_data_id: string;
    bitasset_data_id?: string;
    for_liquidity_pool?: string;
    options?: {
        max_supply?: string;
        market_fee_percent?: number;
        flags?: number;
        issuer_permissions?: number;
    };
}

interface DynamicAssetObject {
    id: string;
    current_supply: string | number;
    confidential_supply: string | number;
    accumulated_fees: string | number;
    fee_pool: string | number;
}

interface LiquidityPoolObject {
    id: string;
    asset_a: string;
    asset_b: string;
    balance_a: string | number;
    balance_b: string | number;
    share_asset: string;
    taker_fee_percent?: number;
}

interface LimitOrderObject {
    id: string;
    seller: string;
    for_sale: string | number;
    sell_price: { base: Amount; quote: Amount };
}

interface VestingObject {
    id: string;
    owner: string;
    balance: Amount;
    balance_type?: string;
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

interface SametFundObject {
    id: string;
    owner_account: string;
    asset_type: string;
    balance: string | number;
    unpaid_amount: string | number;
}

interface HtlcObject {
    id: string;
    transfer: { from: string; to: string; amount: string | number; asset_id: string };
}

interface AssetHolderObject {
    name: string;
    account_id: string;
    amount: string | number;
}

interface AccountObject {
    id: string;
    name: string;
}

interface DynamicGlobalProperties {
    head_block_number: number;
    time: string;
}

interface NodeConfig {
    api_limit_get_assets?: number;
    api_limit_get_limit_orders?: number;
    api_limit_get_asset_holders?: number;
    api_limit_get_liquidity_pools?: number;
    api_limit_get_credit_offers?: number;
    api_limit_get_samet_funds?: number;
    api_limit_list_htlcs?: number;
}

interface Options {
    asset: string | null;
    nodes: string[];
    json: boolean;
    html: string | null;
    detail: number;
    vestingMax: number;
    gap: number;
    concurrency: number;
    scanOrders: boolean;
    help: boolean;
}

interface Bucket {
    key: string;
    label: string;
    amount: bigint;
    color: string;
    note: string;
}

interface HolderRow {
    rank: number;
    id: string;
    name?: string;
    amount: bigint;
    exchange?: string;
}

interface TypeRow {
    type: string;
    count: number;
    amount: bigint;
}

interface CounterpartRow {
    assetId: string;
    symbol: string;
    precision: number;
    amount: bigint;
    count: number;
}

interface LiquidityRow extends CounterpartRow {
    poolAmount: bigint;
    orderAmount: bigint;
    poolCount: number;
    orderCount: number;
    obDownQuote: bigint;
    obDownToken: bigint;
    obUpQuote: bigint;
    obUpToken: bigint;
    obTruncated: boolean;
    poolDownQuote: bigint;
    poolDownToken: bigint;
    poolUpQuote: bigint;
    poolUpToken: bigint;
}

interface DealRow {
    id: string;
    account: string;
    accountName?: string;
    debtAsset: string;
    debtSymbol: string;
    debtPrecision: number;
    debtAmount: bigint;
    collateralAsset: string;
    collateralSymbol: string;
    collateralPrecision: number;
    collateralAmount: bigint;
}

interface Report {
    node: string;
    blockNum: number;
    blockTime: string;
    generatedAt: string;
    asset: {
        id: string;
        symbol: string;
        precision: number;
        issuer: string;
        issuerName?: string;
        maxSupply: bigint | null;
        marketFeePercent: number;
        flags: number | null;
        issuerPermissions: number | null;
        isBitasset: boolean;
        poolShareAssetId: string | null;
    };
    supply: { current: bigint; confidential: bigint; accumulatedFees: bigint };
    buckets: Bucket[];
    free: bigint;
    locked: bigint;
    identified: bigint;
    residual: bigint;
    float: bigint;
    floatInclBlinded: bigint;
    holders: {
        sourceNode: string | null;
        count: number;
        totalCount: number | null;
        total: bigint;
        complete: boolean;
        top: HolderRow[];
        concentration: Array<{ top: number; amount: bigint; count: number }>;
    };
    orders: {
        scanned: boolean;
        scannedAssets: number;
        orderCount: number;
        pairsWith: number;
        truncatedPairs: number;
        failedPairs: number;
        total: bigint;
        byCounterpart: CounterpartRow[];
    };
    pools: { count: number; total: bigint; byCounterpart: CounterpartRow[] };
    vesting: { count: number; total: bigint; byType: TypeRow[]; scannedTo: number; hitLimit: boolean };
    credit: {
        offersCount: number;
        offersTotal: bigint;
        offers: DealRow[];
        collateralCount: number;
        collateralTotal: bigint;
        collateralDeals: DealRow[];
        debtCount: number;
        debtTotal: bigint;
        debtDeals: DealRow[];
    };
    samet: { count: number; total: bigint };
    htlcs: { count: number; total: bigint };
    liquidityByCounterpart: LiquidityRow[];
    depth: {
        downToken: bigint;
        upToken: bigint;
        downOrderbookToken: bigint;
        downPoolToken: bigint;
        upOrderbookToken: bigint;
        upPoolToken: bigint;
    };
    warnings: string[];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

class UsageError extends Error {}

const HELP = `BitShares token distribution analyzer (read-only)

Usage:
  dexbot asset <symbol|1.3.x> [options]      (shorthand: dexbot a <symbol|1.3.x>)
  node dist/scripts/token_distribution.js <symbol|1.3.x> [options]

Options:
  --node URL          BitShares node (repeatable; defaults to NODE_MANAGEMENT.DEFAULT_NODES)
  --detail N          Rows in top-holder / P2P / vesting tables (default ${DEFAULT_DETAIL})
  --no-orders         Skip the per-asset limit-order scan (~6.5k calls; saves ~15s)
  --concurrency N     Concurrent get_limit_orders calls (default ${DEFAULT_CONCURRENCY}, max 64)
  --vesting-max N     Highest 1.13.x object id to scan (default ${DEFAULT_VESTING_MAX})
  --gap N             Stop the 1.13.x scan after N consecutive missing ids (default ${DEFAULT_SCAN_GAP})
  --html PATH         HTML output path (default ${DEFAULT_HTML})
  --no-html           Skip the HTML report
  --json              Machine-readable JSON (HTML is still written unless --no-html)
  -h, --help          Show this help

The token argument accepts a symbol (<token>) or an asset id (<asset-id>).
BTS itself is rejected: use scripts/bts_distribution.ts for the core asset.
`;

function parseArgs(argv: string[]): Options {
    const VALUE_FLAGS = new Set([
        '--node', '--detail', '--concurrency', '--vesting-max', '--gap', '--html', '--asset',
    ]);
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
        asset: null,
        nodes: [],
        json: false,
        html: DEFAULT_HTML,
        detail: DEFAULT_DETAIL,
        vestingMax: DEFAULT_VESTING_MAX,
        gap: DEFAULT_SCAN_GAP,
        concurrency: DEFAULT_CONCURRENCY,
        scanOrders: true,
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
            const value = args[++i];
            if (value === undefined) throw new UsageError(`Missing value for ${a}`);
            return value;
        };
        if (a === '--node') opts.nodes.push(next());
        else if (a === '--asset') opts.asset = next();
        else if (a === '--detail') opts.detail = positiveInt(a, next());
        else if (a === '--concurrency') opts.concurrency = Math.min(positiveInt(a, next()), 64);
        else if (a === '--vesting-max') opts.vestingMax = positiveInt(a, next());
        else if (a === '--gap') opts.gap = positiveInt(a, next());
        else if (a === '--html') opts.html = path.resolve(next());
        else if (a === '--no-html') opts.html = null;
        else if (a === '--no-orders') opts.scanOrders = false;
        else if (a === '--json') opts.json = true;
        else if (a === '-h' || a === '--help') opts.help = true;
        else if (a.startsWith('-')) throw new UsageError(`Unknown flag: ${a}`);
        else if (opts.asset === null) opts.asset = a;
        else throw new UsageError(`Unexpected argument: ${a}`);
    }
    if (!opts.help && !opts.asset) throw new UsageError('a token symbol or asset id is required');
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

    connect(timeoutMs = 20000): Promise<void> {
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
                const pending = this._pending.get(msg.id as number);
                if (!pending) return;
                this._pending.delete(msg.id as number);
                if (msg.error) {
                    const text = msg.error.data?.message || msg.error.message || JSON.stringify(msg.error);
                    pending.reject(new Error(text));
                } else {
                    pending.resolve(msg.result);
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
                resolve: (value) => { clearTimeout(timer); resolve(value as T); },
                reject: (error) => { clearTimeout(timer); reject(error); },
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
                // Most public nodes deny asset_api; holders use a dedicated node.
            }
            return { client, node: url, config: config || {}, assetApi };
        } catch (e) {
            errors.push(`${url}: ${(e as Error).message}`);
            client.close();
        }
    }
    throw new Error(`No reachable BitShares node.\n  ${errors.join('\n  ')}`);
}

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
            if (typeof api === 'number') return { client, node: url, config: config || {}, assetApi: api };
        } catch {
            // try the next node
        }
        client.close();
    }
    return null;
}

// ---------------------------------------------------------------------------
// Chain queries
// ---------------------------------------------------------------------------

async function callDb<T>(session: Session, method: string, args: unknown[]): Promise<T> {
    return session.client.call<T>(DB_API, method, args);
}

async function fetchObjects<T>(session: Session, ids: string[]): Promise<(T | null)[]> {
    const out: (T | null)[] = [];
    for (let i = 0; i < ids.length; i += OBJECT_BATCH) {
        const chunk = ids.slice(i, i + OBJECT_BATCH);
        const page = await callDb<(T | null)[]>(session, 'get_objects', [chunk]);
        for (let j = 0; j < chunk.length; j++) out.push(page?.[j] ?? null);
    }
    return out;
}

/** Paginate an endpoint whose cursor is the last returned object id. */
async function listPages<T extends { id: string }>(
    fetchPage: (start: string | null) => Promise<T[]>,
    limit: number,
    maxPages = 10000,
): Promise<T[]> {
    const seen = new Set<string>();
    const out: T[] = [];
    let start: string | null = null;
    for (let page = 0; page < maxPages; page++) {
        const rows = await fetchPage(start);
        if (!Array.isArray(rows) || rows.length === 0) break;
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



async function resolveAccountNames(session: Session, ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const unique = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < unique.length; i += NAME_BATCH) {
        const chunk = unique.slice(i, i + NAME_BATCH);
        try {
            const rows = await callDb<(AccountObject | null)[]>(session, 'get_accounts', [chunk]);
            for (const row of rows) if (row) names.set(row.id, row.name);
        } catch {
            // Cosmetic only.
        }
    }
    return names;
}

async function resolveAsset(session: Session, input: string): Promise<AssetObject> {
    // Shared case-insensitive lookup (modules/asset_lookup.ts), so a lowercase
    // symbol such as `token.sym` resolves to the on-chain TOKEN.SYM. The legacy
    // `bit*` MPA aliases were renamed on chain, so those are retried with the
    // prefix stripped.
    const read = (method: string, args: unknown[]) => callDb<unknown>(session, method, args);
    let stub = await resolveAssetRef(read, input) as AssetObject | null;
    if (!stub && input.toLowerCase().startsWith('bit')) {
        stub = await resolveAssetRef(read, input.slice(3)) as AssetObject | null;
    }
    if (!stub) throw new Error(`asset not found: ${input}`);
    // The shared resolver fetches through get_assets, so this is already the
    // extended object (float/dynamic ids included): no second round trip.
    return stub;
}

async function fetchAssetHolders(
    session: Session,
    assetId: string,
    onProgress?: (fetched: number) => void,
): Promise<{ rows: AssetHolderObject[]; totalCount: number | null; complete: boolean }> {
    if (session.assetApi === null) throw new Error('asset_api unavailable on this node');
    const api = session.assetApi;
    // The node caps holders per call (api_limit_get_asset_holders, commonly 100).
    const pageSize = Math.max(1, Math.min(session.config.api_limit_get_asset_holders ?? 100, 100));
    let totalCount: number | null = null;
    try {
        const count = await session.client.call<number>(api, 'get_asset_holders_count', [assetId]);
        if (typeof count === 'number' && count >= 0) totalCount = count;
    } catch {
        // optional: only used to plan the pages
    }

    const rows: AssetHolderObject[] = [];
    let complete = false;
    // Reported while the pages are still in flight (rows is empty until the
    // parallel fetch is reassembled), so count the rows themselves.
    let fetchedRows = 0;
    let fetchedPages = 0;
    const report = (rowsInPage: number): void => {
        fetchedRows += rowsInPage;
        fetchedPages += 1;
        if (fetchedPages % 20 === 0) onProgress?.(fetchedRows);
    };

    // `get_asset_holders(asset, start, limit)` walks the by_asset_balance index by
    // *position*, so offsets are independent. With the holder count known the
    // whole rich list is fetched as parallel pages instead of one blocking chain
    // (15k holders = 153 sequential calls today).
    if (totalCount !== null && totalCount > pageSize) {
        const offsets: number[] = [];
        for (let start = 0; start < totalCount; start += pageSize) offsets.push(start);
        // One sentinel page past the count: it absorbs a balance that appeared
        // (or a rank that shifted) mid-scan, so a full last page cannot be
        // mistaken for the whole list.
        offsets.push(offsets[offsets.length - 1] + pageSize);
        const pages = new Array<AssetHolderObject[]>(offsets.length);
        let cursor = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                const index = cursor++;
                if (index >= offsets.length) return;
                const page = await session.client.call<AssetHolderObject[]>(
                    api, 'get_asset_holders', [assetId, offsets[index], pageSize]);
                pages[index] = Array.isArray(page) ? page : [];
                report(pages[index].length);
            }
        };
        const workers = Math.min(HOLDER_PAGE_CONCURRENCY, offsets.length);
        await Promise.all(Array.from({ length: workers }, () => worker()));
        // Reassemble in rank order. A balance change mid-scan can shift ranks and
        // repeat an account, so keep its highest-ranked occurrence only.
        const seen = new Set<string>();
        let shortPage = false;
        for (const page of pages) {
            for (const holder of page) {
                if (!holder?.account_id || seen.has(holder.account_id)) continue;
                seen.add(holder.account_id);
                rows.push(holder);
            }
            if (page.length < pageSize) {
                shortPage = true;
                break;
            }
        }
        complete = shortPage ? true : rows.length >= totalCount;
        onProgress?.(rows.length);
        return { rows, totalCount, complete };
    }

    let nextProgress = 10000;
    for (let start = 0; start < 2_000_000; start += pageSize) {
        const page = await session.client.call<AssetHolderObject[]>(
            api, 'get_asset_holders', [assetId, start, pageSize]);
        if (!Array.isArray(page) || page.length === 0) {
            complete = true;
            break;
        }
        rows.push(...page);
        if (rows.length >= nextProgress) {
            onProgress?.(rows.length);
            nextProgress += 10000;
        }
        if (page.length < pageSize) {
            complete = true;
            break;
        }
    }
    return { rows, totalCount, complete };
}

// ---------------------------------------------------------------------------
// Numeric + formatting helpers
// ---------------------------------------------------------------------------

function mulDiv(a: bigint, b: bigint, divisor: bigint): bigint {
    if (divisor === 0n) return 0n;
    return (a * b) / divisor;
}

interface DepthAgg {
    downQuote: bigint;
    downToken: bigint;
    upQuote: bigint;
    upToken: bigint;
}

/**
 * Constant-product depth for a 3% spot move. Reserves are the pool's token (X)
 * and counterpart (Y) balances; fee is taken from the output side (as in the
 * core liquidity_pool_exchange evaluator).
 */
function poolDepthFor(tokenBalance: bigint, counterpartBalance: bigint, feePercent: number): DepthAgg {
    const x = Number(tokenBalance);
    const y = Number(counterpartBalance);
    if (!(x > 0) || !(y > 0)) return { downQuote: 0n, downToken: 0n, upQuote: 0n, upToken: 0n };
    const fee = Math.max(0, Math.min(feePercent, 10000)) / 10000;
    const downFactor = 0.97;
    const upFactor = 1.03;
    const xDown = x / Math.sqrt(downFactor);
    const yDown = y * Math.sqrt(downFactor);
    const xUp = x / Math.sqrt(upFactor);
    const yUp = y * Math.sqrt(upFactor);
    return {
        downToken: toBig(Math.ceil(xDown - x)),
        downQuote: toBig(Math.max(0, Math.floor((y - yDown) * (1 - fee)))),
        upQuote: toBig(Math.ceil(yUp - y)),
        upToken: toBig(Math.max(0, Math.floor((x - xUp) * (1 - fee)))),
    };
}

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

function formatInteger(value: bigint): string {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatUnits(raw: bigint, precision: number): string {
    const negative = raw < 0n;
    const abs = negative ? -raw : raw;
    const divisor = 10n ** BigInt(precision);
    const whole = abs / divisor;
    const frac = precision > 0
        ? (abs % divisor).toString().padStart(precision, '0').replace(/0+$/, '')
        : '';
    return `${negative ? '-' : ''}${formatInteger(whole)}${frac ? `.${frac}` : ''}`;
}

function compactUnits(raw: bigint, precision: number): string {
    const divisor = 10n ** BigInt(precision);
    const whole = raw / divisor;
    const negative = whole < 0n;
    const abs = negative ? -whole : whole;
    if (abs < 1000n) return formatUnits(raw, precision);
    const tiers: Array<[bigint, string]> = [
        [10n ** 12n, 'T'], [10n ** 9n, 'B'], [10n ** 6n, 'M'], [10n ** 3n, 'K'],
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
    const scaled = Number((part * 1_000_000n) / whole);
    return `${(scaled / 10_000).toFixed(digits)}%`;
}

function shareFraction(part: bigint, whole: bigint): number {
    if (whole <= 0n) return 0;
    return Number((part * 10_000n) / whole) / 10_000;
}

function compareDesc(a: bigint, b: bigint): number {
    return a > b ? -1 : a < b ? 1 : 0;
}

function padStart(text: string, width: number): string {
    return text.padStart(width);
}

function padEnd(text: string, width: number): string {
    return text.padEnd(width);
}

function esc(text: string): string {
    return text.replace(/[&<>"']/g, (ch) => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return '&#39;';
        }
    });
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

interface PriceLevel {
    token: bigint;
    quote: bigint;
    price: number;
}

interface MarketDepth {
    downQuote: bigint;
    downToken: bigint;
    upQuote: bigint;
    upToken: bigint;
    truncated: boolean;
}

async function scanLimitOrders(
    session: Session,
    tokenId: string,
    assets: AssetObject[],
    limit: number,
    concurrency: number,
    onProgress?: (done: number, total: number) => void,
): Promise<{
    total: bigint;
    orderCount: number;
    pairsWith: number;
    truncatedPairs: number;
    failedPairs: number;
    scannedAssets: number;
    byCounterpart: Map<string, { amount: bigint; count: number }>;
    depthByCounterpart: Map<string, MarketDepth>;
}> {
    const byCounterpart = new Map<string, { amount: bigint; count: number }>();
    const depthByCounterpart = new Map<string, MarketDepth>();
    let total = 0n;
    let orderCount = 0;
    let pairsWith = 0;
    let truncatedPairs = 0;
    let failedPairs = 0;
    let done = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = cursor++;
            if (index >= assets.length) return;
            const other = assets[index];
            if (other.id === tokenId) continue;
            let rows: LimitOrderObject[] | null = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    rows = await callDb<LimitOrderObject[]>(
                        session, 'get_limit_orders', [tokenId, other.id, limit]);
                    break;
                } catch {
                    if (attempt === 1) failedPairs++;
                }
            }
            if (rows) {
                const asks: PriceLevel[] = [];
                const bids: PriceLevel[] = [];
                let side = 0;
                for (const order of rows) {
                    const base = order.sell_price?.base;
                    const quote = order.sell_price?.quote;
                    if (!base || !quote) continue;
                    const baseAmount = toBig(base.amount);
                    const quoteAmount = toBig(quote.amount);
                    if (baseAmount <= 0n || quoteAmount <= 0n) continue;
                    if (base.asset_id === tokenId) {
                        // Token sell order (ask): token for sale, counterpart to receive.
                        const token = toBig(order.for_sale);
                        const receive = mulDiv(token, quoteAmount, baseAmount);
                        asks.push({
                            token, quote: receive,
                            price: Number(quoteAmount) / Number(baseAmount),
                        });
                        side++;
                        total += token;
                    } else if (base.asset_id === other.id && quote.asset_id === tokenId) {
                        // Counterpart sell order (bid): counterpart for sale, token to receive.
                        const counterpart = toBig(order.for_sale);
                        const receive = mulDiv(counterpart, quoteAmount, baseAmount);
                        bids.push({
                            token: receive, quote: counterpart,
                            price: Number(baseAmount) / Number(quoteAmount),
                        });
                    }
                }
                if (side > 0) {
                    const agg = byCounterpart.get(other.id) ?? { amount: 0n, count: 0 };
                    agg.amount += asks.reduce((acc, level) => acc + level.token, 0n);
                    agg.count += side;
                    byCounterpart.set(other.id, agg);
                    orderCount += side;
                    pairsWith++;
                    if (side >= limit) truncatedPairs++;
                }

                // 3% depth around the local orderbook mid.
                let bestBid = 0;
                let bestAsk = Number.POSITIVE_INFINITY;
                for (const level of bids) if (level.price > bestBid) bestBid = level.price;
                for (const level of asks) if (level.price < bestAsk) bestAsk = level.price;
                let mid: number | null = null;
                if (bestBid > 0 && Number.isFinite(bestAsk)) mid = (bestBid + bestAsk) / 2;
                else if (bestAsk !== Number.POSITIVE_INFINITY) mid = bestAsk;
                else if (bestBid > 0) mid = bestBid;
                if (mid && mid > 0) {
                    const depth: MarketDepth = {
                        downQuote: 0n, downToken: 0n, upQuote: 0n, upToken: 0n,
                        truncated: asks.length >= limit || bids.length >= limit,
                    };
                    for (const level of bids) {
                        if (level.price < mid * 0.97) continue;
                        depth.downQuote += level.quote;
                        depth.downToken += level.token;
                    }
                    for (const level of asks) {
                        if (level.price > mid * 1.03) continue;
                        depth.upQuote += level.quote;
                        depth.upToken += level.token;
                    }
                    depthByCounterpart.set(other.id, depth);
                }
            }
            done++;
            if (done % 500 === 0) onProgress?.(done, assets.length);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return {
        total, orderCount, pairsWith, truncatedPairs, failedPairs,
        scannedAssets: assets.length, byCounterpart, depthByCounterpart,
    };
}

async function collect(session: Session, opts: Options): Promise<Report> {
    if (!opts.asset) throw new UsageError('a token symbol or asset id is required');
    const showProgress = !opts.json;
    const warnings: string[] = [];
    const generatedAt = new Date().toISOString();

    // ---- Asset + supply -----------------------------------------------------
    progress(showProgress, 'resolving asset ...');
    const asset = await resolveAsset(session, opts.asset);
    if (asset.id === CORE_ID) {
        throw new Error('BTS is the core asset; use scripts/bts_distribution.ts for the BTS distribution');
    }
    const dynRows = await fetchObjects<DynamicAssetObject>(session, [asset.dynamic_asset_data_id]);
    const dyn = dynRows[0];
    if (!dyn) throw new Error(`dynamic data missing for ${asset.symbol}`);
    const supply = toBig(dyn.current_supply);
    const confidential = toBig(dyn.confidential_supply);
    const accumulatedFees = toBig(dyn.accumulated_fees);

    const global = await callDb<DynamicGlobalProperties>(session, 'get_dynamic_global_properties', []);
    const precision = asset.precision;
    const money = (value: bigint): string => formatUnits(value, precision);

    // ---- Assets (symbols + order scan universe) -----------------------------
    // Assets are enumerated by id instead of `list_assets` (100 assets per page):
    // the 1.3.x space is dense and append-only, so a batched get_objects walk is
    // the same payload with ~7 round trips instead of ~66. The object list also
    // feeds the limit-order sweep below.
    progress(showProgress, 'listing assets (1.3.x) ...');
    const assetScan = await scanIdRange<AssetObject>({
        read: (method, args) => callDb(session, method, args),
        prefix: '1.3',
        maxId: 200_000,
        gap: DENSE_SPACE_GAP,
        onProgress: (n) => progress(showProgress, `listing assets (1.3.x) ... ${n} ids`),
    });
    const assets = assetScan.objects;
    if (assetScan.hitLimit) {
        warnings.push('Asset enumeration hit its 200,000-id limit; the limit-order scan may miss newer assets.');
    }
    const assetById = new Map(assets.map((row) => [row.id, row]));
    assetById.set(asset.id, asset);
    const symbolOf = (id: string): string => assetById.get(id)?.symbol ?? id;
    const precisionOf = (id: string): number => assetById.get(id)?.precision ?? 0;

    // ---- Free account balances (rich list) ----------------------------------
    progress(showProgress, 'fetching the rich list (asset_api) ...');
    let holderSession: Session | null = session;
    let closeHolderSession = false;
    if (session.assetApi === null) {
        holderSession = await openAssetApiSession([session.node]);
        closeHolderSession = holderSession !== null;
    }
    let holderSource: string | null = null;
    let holderCount = 0;
    let holderTotalCount: number | null = null;
    let holderComplete = false;
    let free = 0n;
    const holderTop: HolderRow[] = [];
    const holderAmounts: bigint[] = [];
    const concentration: Array<{ top: number; amount: bigint; count: number }> = [];
    if (holderSession?.assetApi !== null && holderSession?.assetApi !== undefined) {
        holderSource = holderSession.node;
        try {
            const fetched = await fetchAssetHolders(
                holderSession, asset.id,
                (n) => progress(showProgress, `fetching the rich list ... ${formatInteger(BigInt(n))} accounts`),
            );
            holderCount = fetched.rows.length;
            holderTotalCount = fetched.totalCount;
            holderComplete = fetched.complete;
            fetched.rows.forEach((holder, index) => {
                const amount = toBig(holder.amount);
                free += amount;
                holderAmounts.push(amount);
                if (index < opts.detail) {
                    holderTop.push({
                        rank: index + 1,
                        id: holder.account_id,
                        name: holder.name,
                        amount,
                        exchange: detectExchange(holder.name),
                    });
                }
            });
            holderAmounts.sort((a, b) => compareDesc(a, b));
            for (const top of [1, 10, 100, 1000]) {
                if (holderAmounts.length < top) continue;
                concentration.push({
                    top, count: top,
                    amount: holderAmounts.slice(0, top).reduce((acc, value) => acc + value, 0n),
                });
            }
        } catch (e) {
            warnings.push(`Rich list unavailable: ${(e as Error).message}`);
        }
    } else {
        warnings.push('No reachable node exposes asset_api::get_asset_holders; free balances are missing.');
    }
    if (closeHolderSession) holderSession?.client.close();

    // ---- Liquidity pools ----------------------------------------------------
    progress(showProgress, 'listing liquidity pools ...');
    const poolLimit = Math.max(1, Math.min(session.config.api_limit_get_liquidity_pools ?? 100, 1000));
    let pools: LiquidityPoolObject[] = [];
    try {
        pools = await listPages<LiquidityPoolObject>(
            (start) => callDb<LiquidityPoolObject[]>(
                session, 'get_liquidity_pools_by_one_asset', [asset.id, poolLimit, start]),
            poolLimit,
        );
    } catch (e) {
        warnings.push(`Liquidity pools unavailable: ${(e as Error).message}`);
    }
    let poolTotal = 0n;
    const poolByCounterpart = new Map<string, { amount: bigint; count: number }>();
    const poolDepthByCounterpart = new Map<string, DepthAgg>();
    for (const pool of pools) {
        let amount = 0n;
        let tokenBalance = 0n;
        let counterpartBalance = 0n;
        let counterpart: string | null = null;
        if (pool.asset_a === asset.id) {
            amount = toBig(pool.balance_a);
            tokenBalance = amount;
            counterpartBalance = toBig(pool.balance_b);
            counterpart = pool.asset_b;
        } else if (pool.asset_b === asset.id) {
            amount = toBig(pool.balance_b);
            tokenBalance = amount;
            counterpartBalance = toBig(pool.balance_a);
            counterpart = pool.asset_a;
        }
        if (!counterpart) continue;
        poolTotal += amount;
        const agg = poolByCounterpart.get(counterpart) ?? { amount: 0n, count: 0 };
        agg.amount += amount;
        agg.count++;
        poolByCounterpart.set(counterpart, agg);

        const depth = poolDepthFor(tokenBalance, counterpartBalance, pool.taker_fee_percent ?? 0);
        const depthAgg = poolDepthByCounterpart.get(counterpart)
            ?? { downQuote: 0n, downToken: 0n, upQuote: 0n, upToken: 0n };
        depthAgg.downQuote += depth.downQuote;
        depthAgg.downToken += depth.downToken;
        depthAgg.upQuote += depth.upQuote;
        depthAgg.upToken += depth.upToken;
        poolDepthByCounterpart.set(counterpart, depthAgg);
    }

    // ---- Limit orders (token for sale) --------------------------------------
    let ordersTotal = 0n;
    let orderCount = 0;
    let ordersPairsWith = 0;
    let ordersTruncated = 0;
    let ordersFailed = 0;
    const orderByCounterpart = new Map<string, { amount: bigint; count: number }>();
    let orderDepthByCounterpart = new Map<string, MarketDepth>();
    if (opts.scanOrders) {
        progress(showProgress, `scanning limit orders across ${formatInteger(BigInt(assets.length))} assets ...`);
        const orderLimit = Math.max(1, Math.min(session.config.api_limit_get_limit_orders ?? 300, 1000));
        const scan = await scanLimitOrders(
            session, asset.id, assets, orderLimit, opts.concurrency,
            (done, total) => progress(showProgress, `scanning limit orders ... ${done}/${total} assets`),
        );
        ordersTotal = scan.total;
        orderCount = scan.orderCount;
        ordersPairsWith = scan.pairsWith;
        ordersTruncated = scan.truncatedPairs;
        ordersFailed = scan.failedPairs;
        for (const [id, agg] of scan.byCounterpart) orderByCounterpart.set(id, agg);
        orderDepthByCounterpart = scan.depthByCounterpart;
        if (ordersTruncated > 0) {
            warnings.push(`${ordersTruncated} market(s) hit the per-side order limit; order totals may be undercounted.`);
        }
        if (ordersFailed > 0) {
            warnings.push(`${ordersFailed} market(s) failed the order query after retry; order totals may be undercounted.`);
        }
    } else {
        warnings.push('Limit-order scan skipped (--no-orders); the limit-order bucket is incomplete.');
    }

    // ---- Vesting balances (1.13.x) ------------------------------------------
    progress(showProgress, 'scanning vesting balances (1.13.x) ...');
    const vestingScan = await scanIdRange<VestingObject>({
        read: (method, args) => callDb(session, method, args),
        prefix: '1.13',
        maxId: opts.vestingMax,
        gap: opts.gap,
        onProgress: (n) => progress(showProgress, `scanning vesting balances (1.13.x) ... ${n} ids`),
    });
    let vestingTotal = 0n;
    let vestingCount = 0;
    const vestingByType = new Map<string, { amount: bigint; count: number }>();
    const vestingByOwner = new Map<string, bigint>();
    for (const vesting of vestingScan.objects) {
        if (vesting.balance?.asset_id !== asset.id) continue;
        const amount = amountOf(vesting.balance);
        vestingCount++;
        vestingTotal += amount;
        const type = vesting.balance_type || 'unspecified';
        const agg = vestingByType.get(type) ?? { amount: 0n, count: 0 };
        agg.amount += amount;
        agg.count++;
        vestingByType.set(type, agg);
        vestingByOwner.set(vesting.owner, (vestingByOwner.get(vesting.owner) ?? 0n) + amount);
    }

    // ---- P2P credit offers / deals ------------------------------------------
    progress(showProgress, 'listing P2P credit offers and deals ...');
    const creditLimit = Math.max(1, Math.min(session.config.api_limit_get_credit_offers ?? 100, 1000));
    let offers: CreditOfferObject[] = [];
    try {
        offers = await listPages<CreditOfferObject>(
            (start) => callDb<CreditOfferObject[]>(
                session, 'get_credit_offers_by_asset', [asset.id, creditLimit, start]),
            creditLimit,
        );
    } catch {
        try {
            const all = await listPages<CreditOfferObject>(
                (start) => callDb<CreditOfferObject[]>(session, 'list_credit_offers', [creditLimit, start]),
                creditLimit,
            );
            offers = all.filter((offer) => offer.asset_type === asset.id);
        } catch (e) {
            warnings.push(`Credit offers unavailable: ${(e as Error).message}`);
        }
    }
    let offersTotal = 0n;
    for (const offer of offers) offersTotal += toBig(offer.current_balance);

    let collateralDeals: CreditDealObject[] = [];
    try {
        collateralDeals = await listPages<CreditDealObject>(
            (start) => callDb<CreditDealObject[]>(
                session, 'get_credit_deals_by_collateral_asset', [asset.id, creditLimit, start]),
            creditLimit,
        );
    } catch {
        try {
            const all = await listPages<CreditDealObject>(
                (start) => callDb<CreditDealObject[]>(session, 'list_credit_deals', [creditLimit, start]),
                creditLimit,
            );
            collateralDeals = all.filter((deal) => deal.collateral_asset === asset.id);
        } catch (e) {
            warnings.push(`Credit deals (collateral) unavailable: ${(e as Error).message}`);
        }
    }
    let collateralTotal = 0n;
    for (const deal of collateralDeals) collateralTotal += toBig(deal.collateral_amount);

    let debtDeals: CreditDealObject[] = [];
    try {
        debtDeals = await listPages<CreditDealObject>(
            (start) => callDb<CreditDealObject[]>(
                session, 'get_credit_deals_by_debt_asset', [asset.id, creditLimit, start]),
            creditLimit,
        );
    } catch {
        try {
            const all = await listPages<CreditDealObject>(
                (start) => callDb<CreditDealObject[]>(session, 'list_credit_deals', [creditLimit, start]),
                creditLimit,
            );
            debtDeals = all.filter((deal) => deal.debt_asset === asset.id);
        } catch (e) {
            warnings.push(`Credit deals (debt) unavailable: ${(e as Error).message}`);
        }
    }
    let debtTotal = 0n;
    for (const deal of debtDeals) debtTotal += toBig(deal.debt_amount);
    // A deal whose collateral and debt are both this asset is one lock, not two.
    const collateralDealIds = new Set(collateralDeals.map((deal) => deal.id));
    debtDeals = debtDeals.filter((deal) => !collateralDealIds.has(deal.id));

    // ---- SameT funds --------------------------------------------------------
    progress(showProgress, 'listing SameT funds ...');
    const sametLimit = Math.max(1, Math.min(session.config.api_limit_get_samet_funds ?? 100, 1000));
    let sametFunds: SametFundObject[] = [];
    try {
        sametFunds = await listPages<SametFundObject>(
            (start) => callDb<SametFundObject[]>(
                session, 'get_samet_funds_by_asset', [asset.id, sametLimit, start]),
            sametLimit,
        );
    } catch (e) {
        warnings.push(`SameT funds unavailable: ${(e as Error).message}`);
    }
    let sametTotal = 0n;
    for (const fund of sametFunds) sametTotal += toBig(fund.balance);

    // ---- HTLC escrow --------------------------------------------------------
    progress(showProgress, 'listing HTLCs ...');
    const htlcLimit = Math.max(1, Math.min(session.config.api_limit_list_htlcs ?? 100, 1000));
    let htlcs: HtlcObject[] = [];
    try {
        htlcs = await listPages<HtlcObject>(
            (start) => callDb<HtlcObject[]>(session, 'list_htlcs', [start ?? '1.16.0', htlcLimit]),
            htlcLimit,
        );
    } catch (e) {
        warnings.push(`HTLCs unavailable: ${(e as Error).message}`);
    }
    let htlcTotal = 0n;
    for (const htlc of htlcs) {
        if (htlc.transfer?.asset_id === asset.id) htlcTotal += toBig(htlc.transfer.amount);
    }

    // ---- Buckets + supply reconciliation ------------------------------------
    const locked = ordersTotal + poolTotal + vestingTotal + offersTotal
        + collateralTotal + sametTotal + htlcTotal + accumulatedFees;
    const identified = free + locked + confidential;
    const residual = supply - identified;
    const float = supply - locked;
    const floatInclBlinded = float;

    const buckets: Bucket[] = [
        {
            key: 'free', label: 'Free account balances', amount: free, color: COLORS[0],
            note: `${formatInteger(BigInt(holderCount))} holder accounts via asset_api`,
        },
        {
            key: 'orders', label: 'Limit orders (for sale)', amount: ordersTotal, color: COLORS[1],
            note: opts.scanOrders
                ? `${formatInteger(BigInt(orderCount))} orders across ${ordersPairsWith} markets`
                : 'scan skipped with --no-orders',
        },
        {
            key: 'pools', label: 'Liquidity pools', amount: poolTotal, color: COLORS[2],
            note: `${formatInteger(BigInt(pools.length))} pool reserves`,
        },
        {
            key: 'vesting', label: 'Vesting balances', amount: vestingTotal, color: COLORS[3],
            note: `${formatInteger(BigInt(vestingCount))} vesting objects (1.13.x)`,
        },
        {
            key: 'creditOffers', label: 'P2P credit offers', amount: offersTotal, color: COLORS[4],
            note: `${offers.length} offer fund(s) currently lendable`,
        },
        {
            key: 'creditCollateral', label: 'P2P deal collateral', amount: collateralTotal, color: COLORS[5],
            note: `${collateralDeals.length} deal(s) using ${asset.symbol} as collateral`,
        },
        {
            key: 'samet', label: 'SameT funds', amount: sametTotal, color: COLORS[6],
            note: `${sametFunds.length} same-transaction fund(s)`,
        },
        {
            key: 'htlc', label: 'HTLC escrow', amount: htlcTotal, color: COLORS[7],
            note: `${htlcs.filter((h) => h.transfer?.asset_id === asset.id).length} HTLC(s)`,
        },
        {
            key: 'fees', label: 'Accumulated market fees', amount: accumulatedFees, color: COLORS[8],
            note: 'issuer-claimable fees held by the asset object',
        },
        {
            key: 'confidential', label: 'Blinded balances', amount: confidential, color: COLORS[9],
            note: 'confidential_supply, not visible in account balances',
        },
    ];
    if (residual !== 0n) {
        buckets.push({
            key: 'other', label: residual > 0n ? 'Other / unattributed' : 'Double-counted (negative)',
            amount: residual, color: COLORS[11],
            note: residual > 0n
                ? 'supply not matched to a known bucket (node drift or an unenumerated sink)'
                : 'buckets exceed supply; usually node/block drift between queries',
        });
        warnings.push(`Supply reconciliation is off by ${money(residual)} ${asset.symbol}.`);
    }

    // ---- Liquidity by counterpart -------------------------------------------
    const liquidityMap = new Map<string, LiquidityRow>();
    const liquidityRow = (id: string): LiquidityRow => {
        const row = liquidityMap.get(id) ?? {
            assetId: id, symbol: symbolOf(id), precision: precisionOf(id), amount: 0n, count: 0,
            poolAmount: 0n, orderAmount: 0n, poolCount: 0, orderCount: 0,
            obDownQuote: 0n, obDownToken: 0n, obUpQuote: 0n, obUpToken: 0n, obTruncated: false,
            poolDownQuote: 0n, poolDownToken: 0n, poolUpQuote: 0n, poolUpToken: 0n,
        };
        liquidityMap.set(id, row);
        return row;
    };
    for (const [id, agg] of poolByCounterpart) {
        const row = liquidityRow(id);
        row.poolAmount += agg.amount;
        row.poolCount += agg.count;
        row.amount += agg.amount;
        row.count += agg.count;
    }
    for (const [id, agg] of orderByCounterpart) {
        const row = liquidityRow(id);
        row.orderAmount += agg.amount;
        row.orderCount += agg.count;
        row.amount += agg.amount;
        row.count += agg.count;
    }
    for (const [id, depth] of poolDepthByCounterpart) {
        const row = liquidityRow(id);
        row.poolDownQuote += depth.downQuote;
        row.poolDownToken += depth.downToken;
        row.poolUpQuote += depth.upQuote;
        row.poolUpToken += depth.upToken;
    }
    for (const [id, depth] of orderDepthByCounterpart) {
        const row = liquidityRow(id);
        row.obDownQuote += depth.downQuote;
        row.obDownToken += depth.downToken;
        row.obUpQuote += depth.upQuote;
        row.obUpToken += depth.upToken;
        row.obTruncated = row.obTruncated || depth.truncated;
    }
    const liquidityByCounterpart = [...liquidityMap.values()]
        .filter((row) => row.amount > 0n)
        .sort((a, b) => compareDesc(a.amount, b.amount));
    const depth = {
        downOrderbookToken: liquidityByCounterpart.reduce((acc, row) => acc + row.obDownToken, 0n),
        downPoolToken: liquidityByCounterpart.reduce((acc, row) => acc + row.poolDownToken, 0n),
        upOrderbookToken: liquidityByCounterpart.reduce((acc, row) => acc + row.obUpToken, 0n),
        upPoolToken: liquidityByCounterpart.reduce((acc, row) => acc + row.poolUpToken, 0n),
    };
    const depthTotals = {
        ...depth,
        downToken: depth.downOrderbookToken + depth.downPoolToken,
        upToken: depth.upOrderbookToken + depth.upPoolToken,
    };

    // ---- Names for detail rows ----------------------------------------------
    const allOwnerIds = [
        ...vestingByOwner.keys(),
        ...offers.map((offer) => offer.owner_account),
        ...collateralDeals.map((deal) => deal.borrower),
        ...debtDeals.map((deal) => deal.borrower),
    ];
    const accountNames = await resolveAccountNames(session, allOwnerIds);
    let issuerName: string | undefined;
    if (asset.issuer) {
        const issuerNames = await resolveAccountNames(session, [asset.issuer]);
        issuerName = issuerNames.get(asset.issuer);
    }

    const offerRows: DealRow[] = offers
        .slice()
        .sort((a, b) => compareDesc(toBig(a.current_balance), toBig(b.current_balance)))
        .slice(0, opts.detail)
        .map((offer) => ({
            id: offer.id,
            account: offer.owner_account,
            accountName: accountNames.get(offer.owner_account),
            debtAsset: offer.asset_type,
            debtSymbol: symbolOf(offer.asset_type),
            debtPrecision: precisionOf(offer.asset_type),
            debtAmount: 0n,
            collateralAsset: offer.asset_type,
            collateralSymbol: symbolOf(offer.asset_type),
            collateralPrecision: precisionOf(offer.asset_type),
            collateralAmount: toBig(offer.current_balance),
        }));

    const dealRow = (deal: CreditDealObject): DealRow => ({
        id: deal.id,
        account: deal.borrower,
        accountName: accountNames.get(deal.borrower),
        debtAsset: deal.debt_asset,
        debtSymbol: symbolOf(deal.debt_asset),
        debtPrecision: precisionOf(deal.debt_asset),
        debtAmount: toBig(deal.debt_amount),
        collateralAsset: deal.collateral_asset,
        collateralSymbol: symbolOf(deal.collateral_asset),
        collateralPrecision: precisionOf(deal.collateral_asset),
        collateralAmount: toBig(deal.collateral_amount),
    });
    const collateralRows = collateralDeals
        .slice()
        .sort((a, b) => compareDesc(toBig(a.collateral_amount), toBig(b.collateral_amount)))
        .slice(0, opts.detail)
        .map(dealRow);
    const debtRows = debtDeals
        .slice()
        .sort((a, b) => compareDesc(toBig(a.debt_amount), toBig(b.debt_amount)))
        .slice(0, opts.detail)
        .map(dealRow);

    // ---- Report -------------------------------------------------------------
    return {
        node: session.node,
        blockNum: global.head_block_number,
        blockTime: global.time,
        generatedAt,
        asset: {
            id: asset.id,
            symbol: asset.symbol,
            precision,
            issuer: asset.issuer,
            issuerName,
            maxSupply: asset.options?.max_supply ? toBig(asset.options.max_supply) : null,
            marketFeePercent: (asset.options?.market_fee_percent ?? 0) / 100,
            flags: asset.options?.flags ?? null,
            issuerPermissions: asset.options?.issuer_permissions ?? null,
            isBitasset: Boolean(asset.bitasset_data_id),
            poolShareAssetId: asset.for_liquidity_pool ?? null,
        },
        supply: { current: supply, confidential, accumulatedFees },
        buckets,
        free,
        locked,
        identified,
        residual,
        float,
        floatInclBlinded,
        holders: {
            sourceNode: holderSource,
            count: holderCount,
            totalCount: holderTotalCount,
            total: free,
            complete: holderComplete,
            top: holderTop,
            concentration,
        },
        orders: {
            scanned: opts.scanOrders,
            scannedAssets: assets.length,
            orderCount,
            pairsWith: ordersPairsWith,
            truncatedPairs: ordersTruncated,
            failedPairs: ordersFailed,
            total: ordersTotal,
            byCounterpart: [...orderByCounterpart.entries()]
                .map(([id, agg]) => ({
                    assetId: id, symbol: symbolOf(id), precision: precisionOf(id),
                    amount: agg.amount, count: agg.count,
                }))
                .sort((a, b) => compareDesc(a.amount, b.amount)),
        },
        pools: {
            count: pools.length,
            total: poolTotal,
            byCounterpart: [...poolByCounterpart.entries()]
                .map(([id, agg]) => ({
                    assetId: id, symbol: symbolOf(id), precision: precisionOf(id),
                    amount: agg.amount, count: agg.count,
                }))
                .sort((a, b) => compareDesc(a.amount, b.amount)),
        },
        vesting: {
            count: vestingCount,
            total: vestingTotal,
            byType: [...vestingByType.entries()]
                .map(([type, agg]) => ({ type, count: agg.count, amount: agg.amount }))
                .sort((a, b) => compareDesc(a.amount, b.amount)),
            scannedTo: vestingScan.scannedTo,
            hitLimit: vestingScan.hitLimit,
        },
        credit: {
            offersCount: offers.length,
            offersTotal,
            offers: offerRows,
            collateralCount: collateralDeals.length,
            collateralTotal,
            collateralDeals: collateralRows,
            debtCount: debtDeals.length,
            debtTotal,
            debtDeals: debtRows,
        },
        samet: { count: sametFunds.length, total: sametTotal },
        htlcs: {
            count: htlcs.filter((h) => h.transfer?.asset_id === asset.id).length,
            total: htlcTotal,
        },
        liquidityByCounterpart,
        depth: depthTotals,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Exchange-name heuristic
// ---------------------------------------------------------------------------

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
    [/coinbase/i, 'Coinbase'],
    [/kraken/i, 'Kraken'],
    [/bitfinex/i, 'Bitfinex'],
    [/bitstamp/i, 'Bitstamp'],
    [/coinex/i, 'CoinEx'],
    [/hitbtc/i, 'HitBTC'],
    [/crypto\.?com/i, 'Crypto.com'],
    [/luno/i, 'Luno'],
    [/btcturk/i, 'BTC Turk'],
    [/indodax/i, 'Indodax'],
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
// Terminal rendering
// ---------------------------------------------------------------------------

function renderTerminal(report: Report, opts: Options): void {
    const precision = report.asset.precision;
    const symbol = report.asset.symbol;
    const supply = report.supply.current;
    const money = (value: bigint): string => formatUnits(value, precision);
    const pct = (value: bigint, whole: bigint = supply): string => sharePercent(value, whole);
    const c = (code: string, text: string): string => `${code}${text}${colors.reset}`;

    console.log();
    console.log(c(colors.bold + colors.cyan, `  ${symbol} distribution · block ${formatInteger(BigInt(report.blockNum))}`));
    console.log(c(colors.gray, `  ${report.node} · ${report.blockTime} · ${report.generatedAt}`));
    console.log(c(colors.gray,
        `  ${symbol} (${report.asset.id}) · precision ${precision} · issuer ${report.asset.issuerName ?? report.asset.issuer}`
        + `${report.asset.isBitasset ? ' · MPA' : ''}${report.asset.poolShareAssetId ? ' · pool share asset' : ''}`));
    console.log();
    console.log(`  Total supply       ${c(colors.white, money(supply))}`);
    console.log(`  Free balances      ${c(colors.buy, money(report.free))}  ${pct(report.free)}`);
    console.log(`  Locked             ${c(colors.sell, money(report.locked))}  ${pct(report.locked)}`);
    console.log(`  Float (supply−lock)${c(colors.white, money(report.float))}  ${pct(report.float)}`);
    console.log(`  Blinded            ${money(report.supply.confidential)}  ${pct(report.supply.confidential)}`);
    if (report.locked > 0n && report.float > 0n) {
        console.log(c(colors.gray,
            `  locked / float     ${(Number(report.locked * 10_000n / report.float) / 10_000).toFixed(2)}×`));
    }

    const heading = (title: string): void => { console.log(section(title)); };

    heading('Where the token sits');
    console.log(c(colors.gray,
        `  ${padEnd('Category', 26)} ${padStart(symbol, 18)} ${padStart('% supply', 10)} ${padStart('% float', 10)}`));
    for (const bucket of report.buckets) {
        console.log(
            `  ${padEnd(bucket.label.slice(0, 26), 26)} ${padStart(money(bucket.amount), 18)} `
            + `${padStart(pct(bucket.amount), 10)} ${padStart(pct(bucket.amount, report.float), 10)}`,
        );
    }

    section(`Liquidity by counterpart (${report.liquidityByCounterpart.length} assets)`);
    console.log(c(colors.gray,
        `  ${padEnd('Counterpart', 18)} ${padStart('POOLS', 16)} ${padStart('ORDERS', 16)} `
        + `${padStart('TOTAL', 16)} ${padStart('% LOCKED LIQ', 12)} ${padStart('% SUPPLY', 10)}`));
    for (const row of report.liquidityByCounterpart.slice(0, Math.max(opts.detail, 15))) {
        console.log(
            `  ${padEnd(row.symbol.slice(0, 18), 18)} ${padStart(money(row.poolAmount), 16)} `
            + `${padStart(money(row.orderAmount), 16)} ${padStart(money(row.amount), 16)} `
            + `${padStart(pct(row.amount, report.pools.total + report.orders.total), 12)} `
            + `${padStart(pct(row.amount), 10)}`,
        );
    }
    console.log(c(colors.gray,
        `  pools ${money(report.pools.total)} in ${report.pools.count} pool(s) · `
        + `orders ${money(report.orders.total)} in ${report.orders.orderCount} order(s)`));

    section('3% price-change liquidity');
    console.log(c(colors.gray,
        '  sellable = token sold until price −3% · buyable = token bought until +3%'));
    console.log(c(colors.gray,
        '  per market: orderbook + pool combined · each venue from its own mid/spot · OB% is token-based'));
    const downToken = report.depth.downToken;
    const upToken = report.depth.upToken;
    console.log(
        `  Sellable within −3%: ${c(colors.sell, money(downToken))} ${symbol} = `
        + `${c(colors.bold, pct(downToken))} of supply`,
    );
    console.log(c(colors.gray,
        `    orderbook ${money(report.depth.downOrderbookToken)} (${pct(report.depth.downOrderbookToken)}) + `
        + `pools ${money(report.depth.downPoolToken)} (${pct(report.depth.downPoolToken)})`));
    console.log(
        `  Buyable within +3%: ${c(colors.buy, money(upToken))} ${symbol} = `
        + `${c(colors.bold, pct(upToken))} of supply`,
    );
    console.log(c(colors.gray,
        `    orderbook ${money(report.depth.upOrderbookToken)} (${pct(report.depth.upOrderbookToken)}) + `
        + `pools ${money(report.depth.upPoolToken)} (${pct(report.depth.upPoolToken)})`));
    console.log(c(colors.gray,
        '  aggregate measure, not one simultaneous trade: venues are measured independently at their own prices'));

    const depthRows = report.liquidityByCounterpart
        .map((row) => ({
            row,
            down: row.obDownToken + row.poolDownToken,
            up: row.obUpToken + row.poolUpToken,
        }))
        .filter((item) => item.down > 0n || item.up > 0n)
        .sort((a, b) => compareDesc(a.down, b.down));
    const rowLimit = Math.max(opts.detail, 10);
    const shownRows = depthRows.slice(0, rowLimit);
    const restRows = depthRows.slice(rowLimit);
    const restDown = restRows.reduce((acc, item) => acc + item.down, 0n);
    const restUp = restRows.reduce((acc, item) => acc + item.up, 0n);
    const restObDown = restRows.reduce((acc, item) => acc + item.row.obDownToken, 0n);
    const restObUp = restRows.reduce((acc, item) => acc + item.row.obUpToken, 0n);

    console.log();
    console.log(c(colors.gray,
        `  ${padEnd('Counterpart', 18)} ${padStart('SELLABLE −3%', 20)} ${padStart('% SUPPLY', 9)} ${padStart('OB%', 7)} `
        + `${padStart('BUYABLE +3%', 20)} ${padStart('% SUPPLY', 9)} ${padStart('OB%', 7)}`));
    const printDepthLine = (label: string, down: bigint, downOb: bigint, up: bigint, upOb: bigint): void => {
        console.log(
            `  ${padEnd(label.slice(0, 18), 18)} ${padStart(money(down), 20)} ${padStart(pct(down), 9)} `
            + `${padStart(sharePercent(downOb, down), 7)} ${padStart(money(up), 20)} ${padStart(pct(up), 9)} `
            + `${padStart(sharePercent(upOb, up), 7)}`,
        );
    };
    for (const item of shownRows) {
        printDepthLine(item.row.symbol, item.down, item.row.obDownToken, item.up, item.row.obUpToken);
    }
    if (restRows.length > 0) {
        printDepthLine(`Other ${restRows.length} markets`, restDown, restObDown, restUp, restObUp);
    }
    if (depthRows.length === 0) {
        console.log(c(colors.gray, '  no pool or orderbook depth inside ±3%'));
    }

    section(`Top holders (${report.holders.count} accounts, rich list)`);
    if (report.holders.top.length === 0) {
        console.log(c(colors.gray, '  no holder data (asset_api unavailable)'));
    } else {
        for (const row of report.holders.top) {
            console.log(
                `  #${String(row.rank).padStart(3)} ${padEnd((row.name ?? row.id).slice(0, 28), 28)} `
                + `${padStart(money(row.amount), 20)} ${padStart(pct(row.amount), 8)}`
                + (row.exchange ? c(colors.gray, `  [${row.exchange}]`) : ''),
            );
        }
        if (report.holders.concentration.length > 0) {
            console.log(c(colors.gray, '  concentration:'));
            for (const row of report.holders.concentration) {
                console.log(c(colors.gray,
                    `    top ${String(row.top).padStart(5)} = ${money(row.amount)} (${pct(row.amount)})`));
            }
        }
    }

    if (report.vesting.count > 0) {
        section('Vesting balances');
        for (const row of report.vesting.byType) {
            console.log(
                `  ${padEnd(row.type.slice(0, 24), 24)} ${String(row.count).padStart(6)} object(s) `
                + `${padStart(money(row.amount), 20)} ${padStart(pct(row.amount), 8)}`,
            );
        }
        if (report.vesting.hitLimit) {
            console.log(c(colors.sell, `  warning: scan reached --vesting-max ${opts.vestingMax}; totals may be incomplete`));
        }
    }

    if (report.credit.offersCount > 0 || report.credit.collateralCount > 0 || report.credit.debtCount > 0) {
        section('P2P credit');
        console.log(c(colors.gray,
            `  offers ${money(report.credit.offersTotal)} in ${report.credit.offersCount} fund(s) · `
            + `deal collateral ${money(report.credit.collateralTotal)} in ${report.credit.collateralCount} deal(s) · `
            + `debt outstanding ${money(report.credit.debtTotal)} in ${report.credit.debtCount} deal(s) (not locked)`));
    }

    if (report.samet.count > 0 || report.htlcs.count > 0) {
        section('Other protocol locks');
        if (report.samet.count > 0) {
            console.log(`  SameT funds       ${money(report.samet.total)} in ${report.samet.count} fund(s)`);
        }
        if (report.htlcs.count > 0) {
            console.log(`  HTLC escrow       ${money(report.htlcs.total)} in ${report.htlcs.count} HTLC(s)`);
        }
    }

    if (report.warnings.length > 0) console.log(warningsBlock(report.warnings));
    console.log();
    console.log(summaryLine(
        `reconcile: free ${money(report.free)} + locked ${money(report.locked)} `
        + `+ blinded ${money(report.supply.confidential)} + other ${money(report.residual)} = ${money(supply)}`));
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

interface Slice {
    label: string;
    value: bigint;
    color: string;
}

function groupSlices(slices: Slice[], total: bigint): Slice[] {
    const kept: Slice[] = [];
    let other = 0n;
    for (const slice of slices) {
        if (slice.value <= 0n) continue;
        if (shareFraction(slice.value, total) < 0.01) other += slice.value;
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
    unit: string,
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
            + `<title>${esc(slice.label)}: ${esc(formatUnits(slice.value, precision))} ${esc(unit)} (${pct})</title>`
            + '</circle>',
        );
        offset += length;
    }
    return `<svg viewBox="0 0 100 100" role="img" aria-label="${esc(unit)} supply composition" class="donut">
        <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#21262d" stroke-width="15"/>
        ${parts.join('')}
        <text x="50" y="44.5" text-anchor="middle" class="donut-kicker">${esc(centerLabel)}</text>
        <text x="50" y="55" text-anchor="middle" class="donut-value">${esc(centerValue)}</text>
        <text x="50" y="62" text-anchor="middle" class="donut-unit">${esc(unit)}</text>
    </svg>`;
}

function htmlTable(headers: string[], rows: string[][], numericFrom = 1): string {
    if (rows.length === 0) return '<p class="muted">No data.</p>';
    const head = headers.map((h, i) => `<th class="${i >= numericFrom ? 'num' : ''}">${esc(h)}</th>`).join('');
    const body = rows.map((row) => `<tr>${row.map((cell, i) => `<td class="${i >= numericFrom ? 'num' : ''}">${cell}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderHtml(report: Report): string {
    const precision = report.asset.precision;
    const symbol = report.asset.symbol;
    const supply = report.supply.current;
    const money = (value: bigint): string => formatUnits(value, precision);
    const pct = (value: bigint, whole: bigint = supply): string => sharePercent(value, whole);
    const kpiValue = (value: bigint): string => {
        const full = money(value);
        return full.length > 14 ? compactUnits(value, precision) : full;
    };
    const fmtAsset = (value: bigint, assetPrecision: number, assetSymbol: string): string =>
        `${formatUnits(value, assetPrecision)} ${assetSymbol}`;

    const allSlices: Slice[] = [
        ...report.buckets.map((bucket) => ({ label: bucket.label, value: bucket.amount, color: bucket.color })),
    ];
    const slices = groupSlices(allSlices, supply);
    const legend = slices.map((slice) => `<li>
        <span class="dot" style="background:${slice.color}"></span>
        <span class="legend-label">${esc(slice.label)}</span>
        <span class="legend-value">${money(slice.value)}</span>
        <span class="legend-share">${pct(slice.value)}</span>
    </li>`).join('');

    const maxBucket = report.buckets.reduce((max, bucket) => (bucket.amount > max ? bucket.amount : max), 0n);
    const bars = report.buckets.filter((bucket) => bucket.amount !== 0n).map((bucket) => `<div class="bar-row">
        <span class="bar-label"><span class="dot" style="background:${bucket.color}"></span>${esc(bucket.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(shareFraction(bucket.amount, maxBucket) * 100).toFixed(2)}%;background:${bucket.color}"></span></span>
        <span class="bar-amount">${money(bucket.amount)}</span>
        <span class="bar-share">${pct(bucket.amount)}</span>
    </div>`).join('');

    const bucketRows = report.buckets.map((bucket) => [
        `<span class="dot" style="background:${bucket.color};margin-right:8px"></span>${esc(bucket.label)}`,
        money(bucket.amount),
        pct(bucket.amount),
        pct(bucket.amount, report.float),
        `<span class="muted">${esc(bucket.note)}</span>`,
    ]);

    const liquidityRows = report.liquidityByCounterpart.map((row) => [
        esc(row.symbol),
        money(row.poolAmount),
        money(row.orderAmount),
        money(row.amount),
        pct(row.amount, report.pools.total + report.orders.total),
        pct(row.amount),
    ]);

    const holderRows = report.holders.top.map((row) => [
        String(row.rank),
        `${esc(row.name ?? row.id)}${row.exchange ? ` <span class="tag cex">${esc(row.exchange)}</span>` : ''}`,
        esc(row.id),
        money(row.amount),
        pct(row.amount),
    ]);
    const concentrationRows = report.holders.concentration.map((row) => [
        `Top ${row.top}`,
        String(row.count),
        money(row.amount),
        pct(row.amount),
    ]);

    const vestingRows = report.vesting.byType.map((row) => [
        esc(row.type), String(row.count), money(row.amount), pct(row.amount),
    ]);

    const offerRows = report.credit.offers.map((row) => [
        esc(row.accountName ?? row.account),
        esc(row.id),
        fmtAsset(row.collateralAmount, row.collateralPrecision, row.collateralSymbol),
        pct(row.collateralAmount),
    ]);
    const collateralRows = report.credit.collateralDeals.map((row) => [
        esc(row.accountName ?? row.account),
        fmtAsset(row.collateralAmount, row.collateralPrecision, row.collateralSymbol),
        `${fmtAsset(row.debtAmount, row.debtPrecision, row.debtSymbol)} debt`,
        esc(row.id),
    ]);
    const debtRows = report.credit.debtDeals.map((row) => [
        esc(row.accountName ?? row.account),
        fmtAsset(row.debtAmount, row.debtPrecision, row.debtSymbol),
        fmtAsset(row.collateralAmount, row.collateralPrecision, row.collateralSymbol),
        esc(row.id),
    ]);

    const liquidityTotal = report.pools.total + report.orders.total;
    const liquiditySlices = groupSlices(
        report.liquidityByCounterpart.map((row, index) => ({
            label: row.symbol, value: row.amount, color: COLORS[index % COLORS.length],
        })),
        liquidityTotal,
    );
    const liquidityLegend = liquiditySlices.map((slice) => `<li>
        <span class="dot" style="background:${slice.color}"></span>
        <span class="legend-label">${esc(slice.label)}</span>
        <span class="legend-value">${compactUnits(slice.value, precision)}</span>
        <span class="legend-share">${sharePercent(slice.value, liquidityTotal)}</span>
    </li>`).join('');
    const poolShare = shareFraction(report.pools.total, liquidityTotal);
    const orderShare = shareFraction(report.orders.total, liquidityTotal);
    const depthMarkets = report.liquidityByCounterpart
        .map((row) => ({
            row,
            down: row.obDownToken + row.poolDownToken,
            up: row.obUpToken + row.poolUpToken,
        }))
        .filter((item) => item.down > 0n || item.up > 0n)
        .sort((a, b) => compareDesc(a.down, b.down));
    const depthTop = depthMarkets.slice(0, 15);
    const depthRest = depthMarkets.slice(15);
    const restDepth = depthRest.reduce((acc, item) => ({
        down: acc.down + item.down,
        up: acc.up + item.up,
        obDown: acc.obDown + item.row.obDownToken,
        obUp: acc.obUp + item.row.obUpToken,
    }), { down: 0n, up: 0n, obDown: 0n, obUp: 0n });
    const sellableRows = depthTop.map((item) => [
        `${esc(item.row.symbol)}${item.row.obTruncated ? ' <span class="tag">capped</span>' : ''}`,
        money(item.down),
        pct(item.down),
        sharePercent(item.row.obDownToken, item.down),
        money(item.up),
        pct(item.up),
        sharePercent(item.row.obUpToken, item.up),
    ]);
    if (depthRest.length > 0) {
        sellableRows.push([
            `Other ${depthRest.length} markets`,
            money(restDepth.down),
            pct(restDepth.down),
            sharePercent(restDepth.obDown, restDepth.down),
            money(restDepth.up),
            pct(restDepth.up),
            sharePercent(restDepth.obUp, restDepth.up),
        ]);
    }

    const warnings = report.warnings.length > 0
        ? `<section class="card warn"><h2>Warnings</h2><ul>${report.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`
        : '';
    const vestingSection = report.vesting.count > 0 ? `<section class="card">
        <div class="head-row"><h2>Vesting balances</h2><span class="hint">1.13.x scan to ${formatInteger(BigInt(report.vesting.scannedTo))}</span></div>
        ${htmlTable(['Type', 'Count', symbol, 'Share of supply'], vestingRows, 1)}
      </section>` : '';
    const creditSection = (report.credit.offersCount + report.credit.collateralCount + report.credit.debtCount) > 0
        ? `<section class="card">
        <div class="head-row"><h2>P2P credit</h2><span class="hint">offers are locked; deal debt is owed, not locked</span></div>
        <h3 class="subhead">Credit offers (${money(report.credit.offersTotal)} in ${report.credit.offersCount} fund(s))</h3>
        ${htmlTable(['Owner', 'Offer', `${symbol} offered`, 'Share of supply'], offerRows, 2)}
        <h3 class="subhead">Deals using ${esc(symbol)} as collateral (${money(report.credit.collateralTotal)} locked)</h3>
        ${htmlTable(['Borrower', `Collateral (${symbol})`, 'Debt', 'Deal'], collateralRows, 1)}
        <h3 class="subhead">Deals with ${esc(symbol)} debt outstanding (${money(report.credit.debtTotal)} not locked)</h3>
        ${htmlTable(['Borrower', 'Debt', 'Collateral', 'Deal'], debtRows, 1)}
      </section>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(symbol)} distribution · block ${formatInteger(BigInt(report.blockNum))}</title>
<style>
:root{--bg:#0b0e14;--panel:#11161d;--panel-2:#161b22;--border:#242c38;--text:#d1d5db;--muted:#8b949e;--bright:#f0f6fc;--accent:#5eb0ef;--warn:#f0883e}
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
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:22px}
.kpi{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.kpi .k{font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:var(--muted)}
.kpi .v{font-size:23px;font-weight:600;color:var(--bright);margin-top:5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.tag{display:inline-block;padding:1px 6px;margin-left:6px;border-radius:999px;font-size:10px;background:#10263a;color:#7cc4ff;border:1px solid #245273}
.muted{color:var(--muted);font-size:12.5px}
.subhead{margin:18px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.9px;color:var(--muted)}
footer{margin-top:24px;color:var(--muted);font-size:11.5px;border-top:1px solid var(--border);padding-top:14px}
footer p{margin:4px 0}
.stack{display:grid;gap:18px}
.head-row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:10px}
.head-row .hint{font-size:11.5px;color:var(--muted)}
</style>
</head>
<body>
<div class="hero">
  <div>
    <h1>${esc(symbol)} token distribution</h1>
    <div class="sub">block ${esc(formatInteger(BigInt(report.blockNum)))} · ${esc(report.blockTime)} · ${esc(report.node)}</div>
    <div class="sub">${esc(symbol)} (${esc(report.asset.id)}) · precision ${precision} · issuer ${esc(report.asset.issuerName ?? report.asset.issuer)}${report.asset.isBitasset ? ' · MPA' : ''}</div>
  </div>
  <div><span class="badge">generated ${esc(report.generatedAt)}</span> <span class="badge">${report.orders.scannedAssets} assets scanned</span></div>
</div>

${warnings}

<div class="kpis">
  <div class="kpi"><div class="k">Total supply</div><div class="v">${kpiValue(supply)}</div><div class="s">${money(supply)} ${esc(symbol)} in existence</div></div>
  <div class="kpi"><div class="k">Free balances</div><div class="v">${kpiValue(report.free)}</div><div class="s">${pct(report.free)} · ${report.holders.count} accounts</div></div>
  <div class="kpi"><div class="k">Locked</div><div class="v">${kpiValue(report.locked)}</div><div class="s">${pct(report.locked)} of supply</div></div>
  <div class="kpi"><div class="k">Float</div><div class="v">${kpiValue(report.float)}</div><div class="s">${pct(report.float)} · supply − locked</div></div>
  <div class="kpi"><div class="k">Liquidity</div><div class="v">${kpiValue(report.pools.total + report.orders.total)}</div><div class="s">pools ${kpiValue(report.pools.total)} · orders ${kpiValue(report.orders.total)}</div></div>
  <div class="kpi"><div class="k">Sellable within −3%</div><div class="v">${kpiValue(report.depth.downToken)}</div><div class="s">${pct(report.depth.downToken)} of supply · OB ${pct(report.depth.downOrderbookToken)} + pool ${pct(report.depth.downPoolToken)}</div></div>
</div>

<div class="grid">
  <section class="card">
    <h2>Where the ${esc(symbol)} is</h2>
    ${donutSvg(slices, supply, 'total supply', compactUnits(supply, precision), symbol, precision)}
    <ul class="legend">${legend}</ul>
  </section>
  <section class="card">
    <div class="head-row"><h2>Bucket sizes</h2><span class="hint">bars scaled to the largest bucket</span></div>
    <div class="bars">${bars}</div>
    <p class="muted" style="margin-top:16px">
      Float = supply − locked. Locked covers limit orders, pools, vesting, P2P offers/collateral,
      SameT funds, HTLC escrow and accumulated market fees. Blinded balances are invisible but
      part of the float; "Other" only appears when the buckets do not reconcile to supply.
    </p>
  </section>
</div>

<div class="stack">
  <section class="card">
    <h2>Category breakdown</h2>
    ${htmlTable(
        ['Category', symbol, 'Share of supply', 'Share of float', 'What it is'],
        bucketRows,
        1,
    )}
  </section>

  <section class="card">
    <div class="head-row"><h2>Liquidity by counterpart</h2><span class="hint">pools + token sell orders, grouped by the asset on the other side</span></div>
    ${htmlTable(
        ['Counterpart', 'Pools', 'Limit orders', 'Total', 'Share of liquidity', 'Share of supply'],
        liquidityRows,
        1,
    )}
    <p class="muted" style="margin-top:10px">
      ${report.pools.count} pool(s) holding ${money(report.pools.total)} ${esc(symbol)} ·
      ${report.orders.orderCount} sell order(s) holding ${money(report.orders.total)} ${esc(symbol)}
      ${report.orders.scanned ? `· scanned ${report.orders.scannedAssets} assets` : '· order scan skipped'}
      ${report.orders.truncatedPairs > 0 ? `· ${report.orders.truncatedPairs} market(s) truncated` : ''}
      ${report.orders.failedPairs > 0 ? `· ${report.orders.failedPairs} market(s) failed` : ''}.
    </p>
  </section>

  <section class="card">
    <div class="head-row"><h2>Liquidity distribution by counterpart</h2><span class="hint">pools + token sell orders · token units</span></div>
    ${liquidityTotal > 0n ? `<div class="grid" style="margin-bottom:0;grid-template-columns:minmax(280px,360px) 1fr">
      <div>
        ${donutSvg(liquiditySlices, liquidityTotal, 'liquidity', compactUnits(liquidityTotal, precision), symbol, precision)}
      </div>
      <div>
        <div class="flow-bar" title="pool vs orderbook share of token liquidity">
          <span style="width:${(poolShare * 100).toFixed(2)}%;background:#3fb950;color:#0b0e14">pools ${compactUnits(report.pools.total, precision)} (${(poolShare * 100).toFixed(1)}%)</span>
          <span style="width:${(orderShare * 100).toFixed(2)}%;background:#f0883e;color:#1a1207">orders ${compactUnits(report.orders.total, precision)} (${(orderShare * 100).toFixed(1)}%)</span>
        </div>
        <ul class="legend">${liquidityLegend}</ul>
      </div>
    </div>` : '<p class="muted">No pool or orderbook liquidity found.</p>'}
  </section>

  <section class="card">
    <div class="head-row"><h2>3% price-change liquidity</h2><span class="hint">orderbook + pool combined · token units</span></div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin:0 0 14px">
      <div class="kpi">
        <div class="k">Sellable within −3%</div>
        <div class="v">${kpiValue(report.depth.downToken)}</div>
        <div class="s">${pct(report.depth.downToken)} of supply · OB ${pct(report.depth.downOrderbookToken)} + pool ${pct(report.depth.downPoolToken)}</div>
      </div>
      <div class="kpi">
        <div class="k">Buyable within +3%</div>
        <div class="v">${kpiValue(report.depth.upToken)}</div>
        <div class="s">${pct(report.depth.upToken)} of supply · OB ${pct(report.depth.upOrderbookToken)} + pool ${pct(report.depth.upPoolToken)}</div>
      </div>
    </div>
    <p class="muted" style="margin:0 0 10px">
      <strong>Sellable</strong> = token sold until the price falls 3%; <strong>buyable</strong> = token bought until the
      price rises 3%. For every market the orderbook and constant-product pool contributions are added into one value.
      Each venue is measured from its own mid/spot, and pool depth is net of the pool taker fee. OB share is the
      token-based share of that combined value. Orderbook depth is capped by the node's per-side order limit.
    </p>
    ${sellableRows.length > 0
        ? htmlTable(
            ['Counterpart', 'Sellable −3%', '% supply', 'OB share', 'Buyable +3%', '% supply', 'OB share'],
            sellableRows,
            1,
        )
        : '<p class="muted">No pool or orderbook depth inside ±3%.</p>'}
    <p class="muted" style="margin-top:10px">
      Aggregate measure, not one simultaneous trade: the same token cannot be sold in every market at once, so the
      totals are the sum of independent 3% moves per venue. Top 15 markets by sellable amount are shown; the remainder
      is aggregated into "Other markets".
    </p>
  </section>

  <section class="card">
    <div class="head-row"><h2>Top holders</h2><span class="hint">asset_api rich list${report.holders.sourceNode ? ` · ${esc(report.holders.sourceNode)}` : ''}</span></div>
    <p class="muted" style="margin:0 0 10px">
      Top ${report.holders.count}${report.holders.totalCount !== null ? ` of ${report.holders.totalCount}` : ''} accounts hold
      ${money(report.holders.total)} ${esc(symbol)} (${pct(report.holders.total)} of supply).
      Exchange tags are name heuristics, not verified identities.
    </p>
    ${htmlTable(['#', 'Account', 'Id', symbol, 'Share of supply'], holderRows, 3)}
    ${concentrationRows.length > 0 ? `<h3 class="subhead">Concentration</h3>
    ${htmlTable(['Accounts', 'Count', symbol, 'Share of supply'], concentrationRows, 1)}` : ''}
  </section>

  ${vestingSection}
  ${creditSection}

  <section class="card">
    <h2>Asset info</h2>
    ${htmlTable(['Field', 'Value'], [
        ['Asset id', esc(report.asset.id)],
        ['Precision', String(precision)],
        ['Issuer', `${esc(report.asset.issuerName ?? report.asset.issuer)} (${esc(report.asset.issuer)})`],
        ['Max supply', report.asset.maxSupply !== null ? money(report.asset.maxSupply) : '—'],
        ['Market fee', `${report.asset.marketFeePercent.toFixed(2)}%`],
        ['Type', report.asset.isBitasset ? 'MPA (market-issued)' : 'UIA (user-issued)'],
        ['Pool share asset', report.asset.poolShareAssetId ? esc(report.asset.poolShareAssetId) : '—'],
        ['Accumulated fees', money(report.supply.accumulatedFees)],
        ['Blinded supply', money(report.supply.confidential)],
    ], 1)}
  </section>
</div>

<footer>
  <p>Sources: bitshares-core 7.0.x database_api — <code>get_objects</code> (1.3.x assets, 1.13.x vesting), <code>get_limit_orders</code>, <code>get_liquidity_pools_by_one_asset</code>, <code>get_credit_offers_by_asset</code>, <code>get_credit_deals_by_collateral_asset</code>, <code>get_credit_deals_by_debt_asset</code>, <code>get_samet_funds_by_asset</code>, <code>list_htlcs</code>${report.holders.sourceNode ? ', <code>asset_api::get_asset_holders</code>' : ''}.</p>
  <p>Read-only; no keys, no transactions. Limit-order totals are per market and capped by the node's per-side limit.</p>
</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function htmlPathFor(report: Report, opts: Options): string | null {
    if (!opts.html) return null;
    if (opts.html !== DEFAULT_HTML) return opts.html;
    const safe = report.asset.symbol.replace(/[^A-Za-z0-9._-]+/g, '_');
    return path.join(path.dirname(DEFAULT_HTML), `token-${safe}-distribution.html`);
}

async function main(): Promise<void> {
    let opts: Options;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        if (e instanceof UsageError) {
            console.error(`${LOG_TAG} Error: ${e.message}\n`);
            console.error(HELP);
            process.exit(2);
        }
        throw e;
    }
    if (opts.help) {
        console.log(HELP);
        return;
    }

    if (!opts.json) console.log(loadingLine(LOG_TAG, `Loading token distribution for ${opts.asset} from chain...`));
    const nodes = opts.nodes.length > 0 ? opts.nodes : [...NODE_MANAGEMENT.DEFAULT_NODES];
    const session = await openSession(nodes);
    try {
        const report = await collect(session, opts);
        clearProgress(!opts.json);
        const htmlPath = htmlPathFor(report, opts);
        if (htmlPath) {
            fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
            fs.writeFileSync(htmlPath, renderHtml(report), 'utf8');
        }
        if (opts.json) {
            console.log(JSON.stringify({ ...report, html: htmlPath }, (_key, value: unknown) => {
                return typeof value === 'bigint' ? value.toString() : value;
            }, 2));
        } else {
            renderTerminal(report, opts);
            if (htmlPath) console.log(savedLine(LOG_TAG, 'Report', toFileUrl(htmlPath)));
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

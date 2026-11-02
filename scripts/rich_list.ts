#!/usr/bin/env node
/**
 * BitShares per-asset rich list / top-holder reporter.
 *
 * Query one asset, or a list of assets, and print their top holders. Uses the
 * chain's `asset_api` (`get_asset_holders`, `get_asset_holders_count`). Those
 * endpoints are often restricted to allowlisted API users, so this script first
 * tries candidate nodes that expose `asset_api` to anonymous logins.
 *
 * The returned holders are ordered by balance descending server-side (the
 * account_balance_index `by_asset_balance` key sorts balance with
 * `std::greater`), so page 0 is already the rich list.
 *
 * CLI:  dexbot rich <ASSET> [ASSET...] [--top N]
 *       npm run richlist -- <ASSET> --top 10
 */

import { pathToFileURL } from 'node:url';
import { lookupAssetRefs } from '../modules/asset_lookup.js';

const DB_API = 0;          // database_api is always registered first
const LOGIN_API = 1;       // login_api (registered second)
const FALLBACK_HOLDER_LIMIT = 100;  // used when the node does not report api_limit_get_asset_holders
const LOOKUP_PAGE = 100;   // get_objects chunk size for the 2.3.x supply fetch

/** Nodes known to expose `asset_api` to anonymous logins come first. */
const DEFAULT_NODES = [
    'wss://dex.iobanker.com/ws',
    'wss://api.dex.trading/',
    'wss://api.bitshares.dev/ws',
    'wss://cloud.xbts.io/ws',
    'wss://node.xbts.io/ws',
    'wss://api.bts.mobi/ws',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Options {
    assets: string[];
    top: number;
    topSet: boolean;
    concurrency: number;
    nodes: string[];
    json: boolean;
    csv: boolean;
    help: boolean;
}

interface AssetRef {
    request: string;
    found: boolean;
    id?: string;
    symbol?: string;
    precision?: number;
    alias?: string;
}

interface Holder {
    name: string;
    account_id: string;
    amount: string;
}

interface Row {
    request: string;
    found: boolean;
    id?: string;
    symbol?: string;
    precision?: number;
    alias?: string;
    holders: Holder[];
    count: number | null;
    supply?: string | null;
}

interface DynamicAssetObject {
    current_supply: string;
}

interface Session {
    client: RpcClient;
    assetApi: number;
    dbApi: number;
    holderLimit: number;
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printHelp(): void {
    console.log(`BitShares per-asset rich list.

Usage:
  dexbot rich <ASSET> [ASSET...] [--top N]

Examples:
  dexbot rich <asset>
  dexbot rich <asset-a> <asset-b> <asset-c> --top 10
  dexbot rich <asset-a> <asset-b> --json

Flags:
  --top N           Holders per asset (default: node holder limit, usually 100)
  --concurrency N   Parallel asset queries (default 8)
  --node URL        Pin websocket node (repeatable)
  --json            JSON output
  --csv             CSV output
  -h, --help        This help`);
}

function parseArgs(argv: string[]): Options {
    const VALUE_FLAGS = new Set(['--top', '--concurrency', '--node']);
    // Normalise `--flag=value` into `--flag value` for the value-taking flags.
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
        assets: [],
        top: 0,          // 0 = unset; resolved after the node holder limit is known
        topSet: false,
        concurrency: 8,
        nodes: [],
        json: false,
        csv: false,
        help: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const next = (): string => {
            const v = args[++i];
            if (v === undefined) throw new UsageError(`Missing value for ${a}`);
            return v;
        };
        if (a === '--top') { opts.top = Number(next()); opts.topSet = true; }
        else if (a === '--concurrency') opts.concurrency = Number(next());
        else if (a === '--node') opts.nodes.push(next());
        else if (a === '--json') opts.json = true;
        else if (a === '--csv') opts.csv = true;
        else if (a === '-h' || a === '--help') opts.help = true;
        else if (a.startsWith('-')) throw new UsageError(`Unknown flag: ${a}`);
        else opts.assets.push(a);
    }
    if (opts.topSet && (!Number.isInteger(opts.top) || opts.top < 1)) {
        throw new UsageError('--top must be a positive integer');
    }
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new UsageError('--concurrency must be >= 1');
    if (opts.assets.length === 0 && !opts.help) {
        throw new UsageError('Provide at least one ASSET (or an asset list).');
    }
    if (opts.json && opts.csv) throw new UsageError('--json and --csv are mutually exclusive');
    return opts;
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC-over-WebSocket client
// ---------------------------------------------------------------------------

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
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
                let msg: { id?: number; result?: unknown; error?: { message?: string } };
                try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
                catch { return; }
                const p = this._pending.get(msg.id as number);
                if (!p) return;
                this._pending.delete(msg.id as number);
                if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else p.resolve(msg.result);
            };
        });
    }

    call<T = unknown>(api: number, method: string, args: unknown[], timeoutMs = 30000): Promise<T> {
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

// ---------------------------------------------------------------------------
// Asset API session
// ---------------------------------------------------------------------------

/** Connect to the first node that grants anonymous access to `asset_api`. */
async function openSession(nodes: string[]): Promise<Session> {
    const errors: string[] = [];
    for (const url of nodes) {
        const client = new RpcClient(url);
        try {
            await client.connect();
            await client.call(LOGIN_API, 'login', [null, null]);
            const assetApi = await client.call(LOGIN_API, 'asset', []);
            if (typeof assetApi !== 'number') throw new Error('asset() did not return an API id');
            const holderLimit = await readHolderLimit(client);
            return { client, assetApi, dbApi: DB_API, holderLimit };
        } catch (e) {
            errors.push(`${url}: ${(e as Error).message}`);
            client.close();
        }
    }
    throw new Error(`No node exposes asset_api.\n  ${errors.join('\n  ')}`);
}

/** Read the node's configured get_asset_holders page cap, falling back to 100. */
async function readHolderLimit(client: RpcClient): Promise<number> {
    try {
        const cfg = await client.call<{ api_limit_get_asset_holders?: number }>(LOGIN_API, 'get_config', []);
        const limit = cfg?.api_limit_get_asset_holders;
        if (typeof limit === 'number' && limit > 0) return limit;
    } catch { /* older nodes omit it */ }
    return FALLBACK_HOLDER_LIMIT;
}

// ---------------------------------------------------------------------------
// Chain queries
// ---------------------------------------------------------------------------

export async function lookupSymbols(session: Session, symbolsOrIds: string[]): Promise<AssetRef[]> {
    // Shared case-insensitive lookup (modules/asset_lookup.ts): one batched
    // get_assets call for the whole list, `request` keeps the caller's spelling
    // so "asset not found" still echoes the input.
    const looked = await lookupAssetRefs(
        (method, args) => session.client.call<unknown>(session.dbApi, method, args),
        symbolsOrIds,
    );
    // An object missing its symbol/precision is useless downstream, so treat it
    // exactly like a miss instead of formatting amounts with `undefined`.
    return looked.map(({ request, asset }): AssetRef => (asset && asset.id && asset.symbol
        && typeof asset.precision === 'number'
        ? { request, found: true, id: asset.id, symbol: asset.symbol, precision: asset.precision }
        : { request, found: false }));
}

/**
 * Look up symbols/ids. Legacy `bit*` MPA names were renamed on-chain without the
 * `bit` prefix, so unresolved `bit*` names are retried stripped and reported as
 * an alias.
 */
export async function fetchAssets(session: Session, symbolsOrIds: string[]): Promise<AssetRef[]> {
    const out = await lookupSymbols(session, symbolsOrIds);
    const retry: number[] = [];
    out.forEach((a, i) => {
        if (!a.found && /^bit./i.test(a.request) && a.request.length > 3) retry.push(i);
    });
    if (retry.length > 0) {
        const aliased = await lookupSymbols(session, retry.map((i) => out[i].request.slice(3)));
        retry.forEach((i, j) => {
            const a = aliased[j];
            if (a.found) out[i] = { ...a, request: out[i].request, alias: out[i].request };
        });
    }
    return out;
}

async function fetchSupplies(session: Session, assetIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (assetIds.length === 0) return map;
    // dynamic asset data id mirrors the asset instance: 1.3.N -> 2.3.N
    const dynIds = assetIds.map((id) => `2.3.${id.split('.')[2]}`);
    for (let i = 0; i < dynIds.length; i += LOOKUP_PAGE) {
        const slice = dynIds.slice(i, i + LOOKUP_PAGE);
        const objs = await session.client.call<(DynamicAssetObject | null)[]>(
            session.dbApi, 'get_objects', [slice]);
        slice.forEach((_, j) => {
            const o = objs[j];
            if (o) map.set(assetIds[i + j], o.current_supply);
        });
    }
    return map;
}

async function fetchTopHolders(session: Session, asset: AssetRef, top: number): Promise<{ holders: Holder[]; count: number }> {
    const holders = await session.client.call<Holder[]>(
        session.assetApi, 'get_asset_holders', [asset.id, 0, top]);
    const count = await session.client.call<number>(
        session.assetApi, 'get_asset_holders_count', [asset.id]);
    return { holders: holders || [], count };
}

/** Run `fn` over items with bounded concurrency, preserving order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatAmount(raw: string, precision: number): string {
    const s = BigInt(raw).toString().padStart(precision + 1, '0');
    const intPart = s.slice(0, s.length - precision);
    let frac = precision > 0 ? s.slice(s.length - precision) : '';
    frac = frac.replace(/0+$/, '');
    return intPart + (frac ? `.${frac}` : '');
}

function pct(raw: string, supply: string | null | undefined): string {
    if (!supply || supply === '0') return '';
    const bp = (BigInt(raw) * 10000n) / BigInt(supply);   // basis points
    return `${bp / 100n}.${(bp % 100n).toString().padStart(2, '0')}%`;
}

const NAME_MAX_WIDTH = 30;

/** Pick a stable name column width for one asset, capped for readability. */
function nameColumnWidth(holders: Holder[]): number {
    const longest = holders.reduce((m, h) => Math.max(m, h.name.length), 0);
    return Math.min(longest, NAME_MAX_WIDTH);
}

function padName(name: string, width: number): string {
    if (name.length <= width) return name.padEnd(width);
    return name.slice(0, width - 1) + '\u2026';
}

function widthOf(values: string[]): number {
    return values.reduce((m, v) => Math.max(m, v.length), 0);
}

function printTable(rows: Row[]): void {
    for (const r of rows) {
        if (!r.found) {
            console.error(`?? ${r.request}: asset not found`);
            continue;
        }
        const head = `${r.symbol} (${r.id})  precision=${r.precision}` +
            (r.count != null ? `  holders=${r.count}` : '') +
            (r.supply ? `  supply=${formatAmount(r.supply, r.precision ?? 0)}` : '');
        console.log(`\n${head}`);
        if (r.holders.length === 0) {
            console.log('  (no holders)');
            continue;
        }
        console.log(`  ${r.holders.length > 1 ? `top ${r.holders.length}` : 'top holder'}:`);
        const nameWidth = nameColumnWidth(r.holders);
        const rankWidth = String(r.holders.length).length;
        const amounts = r.holders.map((h) => formatAmount(h.amount, r.precision ?? 0));
        const shares = r.holders.map((h) => pct(h.amount, r.supply));
        const amountWidth = widthOf(amounts);
        const shareWidth = widthOf(shares);
        r.holders.forEach((h, i) => {
            const share = shares[i];
            console.log(`   #${String(i + 1).padStart(rankWidth)}  ${padName(h.name, nameWidth)}  ${amounts[i].padStart(amountWidth)}` +
                (share ? `  ${share.padStart(shareWidth)}` : '') + `  ${h.account_id}`);
        });
    }
}

function printCsv(rows: Row[]): void {
    console.log('symbol,asset_id,rank,account,account_id,amount,percent');
    for (const r of rows) {
        if (!r.found) continue;
        r.holders.forEach((h, i) => {
            console.log([r.symbol, r.id, i + 1, h.name, h.account_id,
                formatAmount(h.amount, r.precision ?? 0), pct(h.amount, r.supply)].join(','));
        });
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function collectRows(session: Session, assets: AssetRef[], opts: Options): Promise<Row[]> {
    const showProgress = !opts.json && !opts.csv && assets.length > 10;
    let done = 0;
    const queried = await mapPool<AssetRef, Row>(assets, opts.concurrency, async (asset) => {
        const { holders, count } = await fetchTopHolders(session, asset, opts.top);
        if (showProgress) {
            done++;
            process.stderr.write(`\r  queried ${done}/${assets.length} assets ...`);
        }
        return { ...asset, holders, count };
    });
    if (showProgress) process.stderr.write('\r');

    const supplies = await fetchSupplies(session, queried.map((r) => r.id as string));
    return queried.map((r) => ({ ...r, supply: supplies.get(r.id as string) || null }));
}

async function main(): Promise<void> {
    let opts: Options;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        if (e instanceof UsageError) { console.error(`Error: ${e.message}\n`); printHelp(); process.exit(2); }
        throw e;
    }
    if (opts.help) { printHelp(); return; }

    const nodes = opts.nodes.length > 0 ? opts.nodes : DEFAULT_NODES;
    const session = await openSession(nodes);

    // Resolve --top against the node's advertised cap now that we know it.
    if (!opts.topSet) opts.top = session.holderLimit;
    if (opts.top > session.holderLimit) {
        if (!opts.json && !opts.csv) {
            console.error(`Note: --top ${opts.top} clamped to node limit ${session.holderLimit}.`);
        }
        opts.top = session.holderLimit;
    }

    try {
        const looked = await fetchAssets(session, opts.assets);
        const assets = looked.filter((a) => {
            if (!a.found) { console.error(`Warning: asset not found: ${a.request}`); return false; }
            if (a.alias) console.error(`Note: ${a.alias} was renamed; using ${a.symbol}.`);
            return a.found;
        });
        if (assets.length === 0) { console.error('No valid assets.'); process.exit(1); }

        const rows = await collectRows(session, assets, opts);
        if (opts.json) console.log(JSON.stringify(rows, null, 2));
        else if (opts.csv) printCsv(rows);
        else printTable(rows);
    } finally {
        session.client.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error(`Error: ${(e as Error).message}`);
        process.exit(1);
    });
}

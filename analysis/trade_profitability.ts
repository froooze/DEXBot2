#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAccountRef } from './account_resolver.js';
import {
    BTS_ID,
    assetPrec as getPrec,
    assetSymbol,
    resolveAssetPrecisions,
    FillRecord,
    classifyFill,
    matchesAssetRef,
} from './fills_source.js';
import { writePnlReport } from './pnl_report.js';
import { percentile } from './math_utils.js';
import { fetchFillsCached } from './fills_cache.js';
import { toFileUrl } from './chart_utils.js';
import { PATHS } from '../modules/paths.js';
import { sanitizeKey } from '../modules/utils/sanitize_key.js';
import { monthsToHours } from '../modules/utils/time_range.js';
import { muteChainLogs } from '../modules/utils/chain_logs.js';
import { formatFundsValue } from '../modules/order/format.js';

/**
 * TRADE PROFITABILITY ANALYZER
 *
 * Fetches fill_order operations for a BitShares account from Kibana
 * within a specified time range, then analyzes profitability using
 * FIFO or sequential (LIFO) inventory tracking per asset pair.
 *
 * Usage:
 *   node dist/analysis/trade_profitability.js 1.2.3 --start 2025-01-01 --end 2025-06-01
 *   node dist/analysis/trade_profitability.js 1.2.3 --month 3
 *   node dist/analysis/trade_profitability.js 1.2.3 --start 2025-01-01T00:00:00Z --end 2025-06-01T00:00:00Z
 *   node dist/analysis/trade_profitability.js 1.2.3 --hours 168 --asset 1.3.113
 *   node dist/analysis/trade_profitability.js 1.2.3 --hours 168 --csv trades.csv
 *   node dist/analysis/trade_profitability.js 1.2.3 --hours 168 --json results.json
 *   node dist/analysis/trade_profitability.js "account-name" --month 3
 *   node dist/analysis/trade_profitability.js 1.2.3 --hours 168 --trades
 *   node dist/analysis/trade_profitability.js 1.2.3 --hours 168 --match-mode fifo
 */

// ─── Constants ────────────────────────────────────────────────────────────────

let BLOCKCHAIN_FEE_PER_FILL = 0.09652; // BTS — flat blockchain operation fee (not market fee); override with --fee-per-order

// ─── Types ────────────────────────────────────────────────────────────────────

interface TradeFill {
    time: string;
    orderId: string;
    direction: 'buy' | 'sell';
    baseAsset: string;
    quoteAsset: string;
    baseAmount: number;
    quoteAmount: number;
    price: number;
    isMaker: boolean;
    sequence: number;
    marketFeeReal: number;
    marketFeeAsset: string;
}

interface InventoryLot {
    amount: number;
    grossPrice: number;
    effPrice: number;
    time: string;
    entryOrderId: string;
    entryIsMaker: boolean;
}

interface RealizedPnl {
    sellPrice: number;
    buyPrice: number;
    amount: number;
    pnl: number;
    pnlPct: number;
    effPrice: number;
    marketFeeEntry: number;
    marketFeeExit: number;
    feeBts: number;
    pnlNet: number;
    pnlNetPct: number;
    entryTime: string;
    exitTime: string;
    entryOrderId: string;
    exitOrderId: string;
    entryIsMaker: boolean;
    exitIsMaker: boolean;
}

interface PairAnalysis {
    baseAsset: string;
    quoteAsset: string;
    buys: TradeFill[];
    sells: TradeFill[];
    realizedPnls: RealizedPnl[];
    totalBuyBase: number;
    totalSellBase: number;
    totalBuyQuote: number;
    totalSellQuote: number;
    unmatchedSellBase: number;
    totalRealizedPnl: number;
    totalMarketFees: number;
    totalBlockchainFees: number;
    totalRealizedPnlNet: number;
    netPosition: number;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`\
Usage: node dist/analysis/trade_profitability.js <account|bot> [options]

Analyzes filled orders for a BitShares account, computing realized PnL
via FIFO or sequential (LIFO) inventory tracking.

Arguments:
  account|bot            Local bot profile name, BitShares account name, or 1.2.x id.
                         Local profiles are checked first, then the chain.

Options:
  --month <n>            Lookback months (730 h each; default 3; alias --months).
  --start <iso>          Start time (ISO 8601, e.g. 2025-01-01 or 2025-01-01T00:00:00Z)
  --end <iso>            End time (ISO 8601)
  --hours <n>            Lookback hours from now (alternative to --month/--start/--end)
  --pair <BASE/QUOTE>    Filter to one pair, by symbol or 1.3.x id (e.g. TOKENA/BTS)
  --asset <assetId>      Filter to one base asset (e.g. 1.3.113 for bitUSD)
  --refresh-account      Force re-resolution and bypass the fills cache (re-query the range)
  --html                 Write a self-contained HTML report instead of terminal tables
  --report <file>        Override the auto-named HTML report path (implies --html)
  --csv <file>           Export trade list as CSV
  --json <file>          Export full analysis as JSON
  --trades               Show per-order PnL detail (terminal mode only)
  --match-mode <mode>    Matching mode: sequential (default, LIFO) or fifo
  --fee-per-order <bts>  Blockchain fee per limit_order_create op in BTS (default: 0.09652)
  --verbose              Print extra debug info
  --help, -h             Show this help

Examples:
  dexbot pnl my-bot --month 3
  dexbot pnl 1.2.123456 --month 6 --pair TOKENA/BTS
  node dist/analysis/trade_profitability.js 1.2.123456 --hours 720
  node dist/analysis/trade_profitability.js 1.2.123456 --start 2025-01-01 --end 2025-06-01
  node dist/analysis/trade_profitability.js 1.2.123456 --hours 720 --asset 1.3.113 --csv trades.csv`);
}

interface TradeProfitabilityOptions {
    accountId: string;
    hours: number | null;
    months: number | null;
    start: string | null;
    end: string | null;
    asset: string | null;
    pair: string | { base: string; quote: string } | null;
    refreshAccount: boolean;
    csv: string | null;
    json: string | null;
    matchMode: string;
    showPnlDetail: boolean;
    verbose: boolean;
    feePerOrder: number | null;
    html: boolean;
    report: string | null;
}

function parseArgs(argv: string[] = process.argv.slice(2)) {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        printHelp();
        process.exit(0);
    }

    const opts: TradeProfitabilityOptions = {
        accountId: argv[0],
        hours: null,
        months: null as number | null,
        start: null,
        end: null,
        asset: null,
        pair: null,
        refreshAccount: false,
        csv: null,
        json: null,
        matchMode: 'sequential',
        showPnlDetail: false,
        verbose: false,
        feePerOrder: null as number | null,
        html: false,
        report: null as string | null,
    };

    // Reject a missing flag value explicitly (e.g. `--pair` at end of argv)
    // instead of silently letting `undefined` disable the option.
    const requireValue = (name: string, raw: string | undefined): string => {
        const v = raw == null ? '' : String(raw);
        if (!v || v.startsWith('--')) throw new Error(`${name}: missing value`);
        return v;
    };

    const setMonths = (raw: string) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--month: invalid value "${raw}" (expected positive months, e.g. --month 6)`);
        opts.months = n;
    };
    const setHours = (raw: string) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--hours: invalid value "${raw}" (expected positive hours)`);
        opts.hours = n;
    };

    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--hours':        setHours(requireValue('--hours', argv[++i])); break;
            case '--month':
            case '--months':       setMonths(requireValue('--month', argv[++i])); break;
            case '--start':        opts.start    = requireValue('--start', argv[++i]); break;
            case '--end':          opts.end      = requireValue('--end', argv[++i]); break;
            case '--asset':        opts.asset    = requireValue('--asset', argv[++i]); break;
            case '--pair':         opts.pair     = requireValue('--pair', argv[++i]); break;
            case '--refresh-account': opts.refreshAccount = true; break;
            case '--csv':          opts.csv      = requireValue('--csv', argv[++i]); break;
            case '--json':         opts.json     = requireValue('--json', argv[++i]); break;
            case '--trades':         opts.showPnlDetail  = true; break;
            case '--html':           opts.html = true; break;
            case '--report':         opts.report = requireValue('--report', argv[++i]); opts.html = true; break;
            case '--fee-per-order':  opts.feePerOrder = parseFloat(requireValue('--fee-per-order', argv[++i])); break;
            case '--match-mode': {
                const m = requireValue('--match-mode', argv[++i]);
                if (m !== 'sequential' && m !== 'fifo') throw new Error(`Invalid --match-mode: ${m} (expected: sequential | fifo)`);
                opts.matchMode = m;
                break;
            }
            case '--verbose':        opts.verbose   = true; break;
            default: {
                // `--flag=value` spellings, same validation as the space form.
                const eq = /^--(month|months|hours|start|end|asset|pair|csv|json|report)=(.*)$/.exec(arg);
                if (eq) {
                    const [, name, rawValue] = eq;
                    if (name === 'month' || name === 'months') setMonths(rawValue);
                    else if (name === 'hours') setHours(rawValue);
                    else if (name === 'report') { opts.report = requireValue('--report', rawValue); opts.html = true; }
                    else (opts as unknown as Record<string, unknown>)[name] = requireValue(`--${name}`, rawValue);
                    break;
                }
                throw new Error(`Unknown option: ${arg}`);
            }
        }
    }

    if (!opts.hours && !opts.start && opts.months == null) {
        opts.months = 3; // default: 3 months
    }

    if (opts.pair) {
        const parts = String(opts.pair).split('/');
        if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
            throw new Error(`--pair: expected BASE/QUOTE (e.g. --pair TOKENA/BTS), got "${opts.pair}"`);
        }
        opts.pair = { base: parts[0].trim(), quote: parts[1].trim() };
    }

    return opts;
}

// ─── Fill Classification ─────────────────────────────────────────────────────

/**
 * Classify fills into trade records. Direction/base/quote resolution and the
 * amount sanity check live in fills_source.classifyFill (single home, also used
 * by grid_correction_check); this wrapper owns the PnL-specific market-fee
 * handling, the asset/pair filters and the unknown-precision skip count.
 */
function classifyFills(fills: FillRecord[], filterAsset: string | null, pairFilter: { base: string; quote: string } | null = null): { trades: TradeFill[]; pairs: Set<string> } {
    const trades: TradeFill[] = [];
    const pairs = new Set<string>();
    let skipped = 0;

    for (const f of fills) {
        const c = classifyFill(f);
        if (!c) { skipped++; continue; }

        // Market fee is always deducted from receives; an unknown fee asset
        // precision makes the fee (and therefore net PnL) uncomputable.
        const feePrec = getPrec(f.fee.asset_id);
        if (feePrec === undefined || isNaN(f.fee.amount)) { skipped++; continue; }
        const marketFeeReal = f.fee.amount / Math.pow(10, feePrec);
        const marketFeeAsset = f.fee.asset_id;

        const { direction, baseAsset, quoteAsset, baseAmount, quoteAmount, price } = c;

        if (filterAsset && baseAsset !== filterAsset) continue;
        if (pairFilter && !(matchesAssetRef(pairFilter.base, baseAsset) && matchesAssetRef(pairFilter.quote, quoteAsset))) continue;

        // Validate market fee asset: fee is always deducted from receives
        // (base for buys, quote for sells). Warn if unexpected.
        if (marketFeeReal > 0 && marketFeeAsset !== '' && marketFeeAsset !== f.receives.asset_id) {
            console.warn(`  [warn] Fill ${f.orderId}: fee asset ${marketFeeAsset} ≠ receives asset ${f.receives.asset_id}. Market fee PnL may be incorrect.`);
        }

        const pairKey = `${baseAsset}:${quoteAsset}`;
        pairs.add(pairKey);

        trades.push({
            time: f.time,
            orderId: f.orderId,
            direction,
            baseAsset,
            quoteAsset,
            baseAmount,
            quoteAmount,
            price,
            isMaker: f.isMaker,
            sequence: f.blockNum * 1e6 + f.opNum,
            marketFeeReal,
            marketFeeAsset,
        });
    }

    if (skipped > 0) {
        console.warn(`  [warn] ${skipped} fill(s) skipped due to unknown asset precision.`);
    }

    return { trades, pairs };
}

// ─── PnL Calculation (FIFO / Sequential) ─────────────────────────────────────

function analyzePair(trades: TradeFill[], matchMode: 'fifo' | 'sequential' = 'sequential'): PairAnalysis {
    const buys = trades.filter(t => t.direction === 'buy').sort((a, b) => a.sequence - b.sequence);
    const sells = trades.filter(t => t.direction === 'sell').sort((a, b) => a.sequence - b.sequence);

    const totalBuyBase = buys.reduce((s, t) => s + t.baseAmount, 0);
    const totalSellBase = sells.reduce((s, t) => s + t.baseAmount, 0);
    const totalBuyQuote = buys.reduce((s, t) => s + t.quoteAmount, 0);
    const totalSellQuote = sells.reduce((s, t) => s + t.quoteAmount, 0);

    // Merge all trades chronologically.
    // FIFO: buys add to queue, sells consume oldest lots (queue front).
    // Sequential: buys add to queue, sells consume newest lots (queue back / LIFO).
    const all = [...trades].sort((a, b) => a.sequence - b.sequence);
    const inventory: InventoryLot[] = [];
    const realizedPnls: RealizedPnl[] = [];
    let unmatchedSellBase = 0;

    for (const trade of all) {
        const grossPrice = trade.price;

        if (trade.direction === 'buy') {
            // Enter lot with net amount (gross receives minus market fee on receives)
            const lotAmount = trade.baseAmount - trade.marketFeeReal;
            if (lotAmount < 1e-12) continue;
            const lotEffPrice = trade.quoteAmount / lotAmount;
            inventory.push({
                amount: lotAmount,
                grossPrice: grossPrice,
                effPrice: lotEffPrice,
                time: trade.time,
                entryOrderId: trade.orderId,
                entryIsMaker: trade.isMaker,
            });
        } else {
            let remaining = trade.baseAmount;

            while (remaining > 0.00000001 && inventory.length > 0) {
                const lotIndex = matchMode === 'sequential' ? inventory.length - 1 : 0;
                const lot = inventory[lotIndex];
                const matched = Math.min(remaining, lot.amount);

                // Gross PnL using gross prices (before market fee deduction)
                const grossPnl = (grossPrice - lot.grossPrice) * matched;
                const grossPnlPct = lot.grossPrice > 0 ? ((grossPrice - lot.grossPrice) / lot.grossPrice) * 100 : 0;

                realizedPnls.push({
                    sellPrice: grossPrice,
                    buyPrice: lot.grossPrice,
                    amount: matched,
                    pnl: grossPnl,
                    pnlPct: grossPnlPct,
                    effPrice: lot.effPrice,
                    marketFeeEntry: 0,
                    marketFeeExit: 0,
                    feeBts: 0,
                    pnlNet: grossPnl,
                    pnlNetPct: grossPnlPct,
                    entryTime: lot.time,
                    exitTime: trade.time,
                    entryOrderId: lot.entryOrderId,
                    exitOrderId: trade.orderId,
                    entryIsMaker: lot.entryIsMaker,
                    exitIsMaker: trade.isMaker,
                });

                lot.amount -= matched;
                remaining -= matched;

                if (lot.amount < 0.00000001) {
                    if (matchMode === 'sequential') {
                        inventory.pop();
                    } else {
                        inventory.shift();
                    }
                }
            }

            if (remaining > 0.00000001) {
                unmatchedSellBase += remaining;
            }
        }
    }

    // ─── Market fee allocation (aggregated per order) ──────────────────────
    // A limit order may be filled across multiple fill_order_operations with
    // the same orderId.  Aggregate all fills' market fees per order, then
    // allocate pro-rata using the fill's net acquired amount as denominator.
    // (Market fee is paid on acquisition; the portion tied to unsold inventory
    //  is not yet realised.)
    const entryOrderFees = new Map<string, { feeInQuote: number; totalAcquired: number }>();
    const exitOrderFees = new Map<string, { feeInQuote: number; totalDisposed: number }>();

    for (const t of buys) {
        const e = entryOrderFees.get(t.orderId) || { feeInQuote: 0, totalAcquired: 0 };
        if (t.marketFeeReal > 0) {
            // Buy-side fee is in base → convert to quote using effective price
            const netBase = t.baseAmount - t.marketFeeReal;
            e.feeInQuote += netBase > 0 ? t.marketFeeReal * (t.quoteAmount / netBase) : 0;
        }
        e.totalAcquired += t.baseAmount - t.marketFeeReal;
        entryOrderFees.set(t.orderId, e);
    }

    for (const t of sells) {
        const e = exitOrderFees.get(t.orderId) || { feeInQuote: 0, totalDisposed: 0 };
        if (t.marketFeeReal > 0)
            e.feeInQuote += t.marketFeeReal; // Sell-side fee is already in quote
        e.totalDisposed += t.baseAmount;
        exitOrderFees.set(t.orderId, e);
    }

    for (const r of realizedPnls) {
        const eObj = entryOrderFees.get(r.entryOrderId);
        if (eObj && eObj.totalAcquired > 0)
            r.marketFeeEntry = eObj.feeInQuote * (r.amount / eObj.totalAcquired);

        const xObj = exitOrderFees.get(r.exitOrderId);
        if (xObj && xObj.totalDisposed > 0)
            r.marketFeeExit = xObj.feeInQuote * (r.amount / xObj.totalDisposed);

        r.pnlNet = r.pnl - r.marketFeeEntry - r.marketFeeExit;
        r.pnlNetPct = r.buyPrice > 0 ? (r.pnlNet / (r.buyPrice * r.amount)) * 100 : 0;
    }

    // ─── Blockchain fee allocation ─────────────────────────────────────────
    const buyOrderIds = new Set(buys.map(t => t.orderId));
    const sellOrderIds = new Set(sells.map(t => t.orderId));
    const entryTotalMatched = new Map<string, number>();
    const exitTotalMatched = new Map<string, number>();
    for (const r of realizedPnls) {
        entryTotalMatched.set(r.entryOrderId, (entryTotalMatched.get(r.entryOrderId) || 0) + r.amount);
        exitTotalMatched.set(r.exitOrderId, (exitTotalMatched.get(r.exitOrderId) || 0) + r.amount);
    }

    const totalBlockchainFees = (buyOrderIds.size + sellOrderIds.size) * BLOCKCHAIN_FEE_PER_FILL;
    for (const r of realizedPnls) {
        const eTotal = entryTotalMatched.get(r.entryOrderId) || 1;
        const xTotal = exitTotalMatched.get(r.exitOrderId) || 1;
        r.feeBts = BLOCKCHAIN_FEE_PER_FILL * (r.amount / eTotal) + BLOCKCHAIN_FEE_PER_FILL * (r.amount / xTotal);
        r.pnlNet -= r.feeBts;
        const costBasis = r.effPrice * r.amount;
        r.pnlNetPct = costBasis > 0 ? (r.pnlNet / costBasis) * 100 : 0;
    }

    const totalBuyBaseNet = buys.reduce((s, t) => s + t.baseAmount - t.marketFeeReal, 0);
    const totalRealizedPnl = realizedPnls.reduce((s, r) => s + r.pnl, 0);
    const totalMarketFees = realizedPnls.reduce((s, r) => s + r.marketFeeEntry + r.marketFeeExit, 0);
    const totalRealizedPnlNet = realizedPnls.reduce((s, r) => s + r.pnlNet, 0);
    const netPosition = totalBuyBaseNet - totalSellBase;
    const baseAsset = trades[0]?.baseAsset ?? '';
    const quoteAsset = trades[0]?.quoteAsset ?? '';

    return {
        baseAsset,
        quoteAsset,
        buys,
        sells,
        realizedPnls,
        totalBuyBase,
        totalSellBase,
        totalBuyQuote,
        totalSellQuote,
        unmatchedSellBase,
        totalRealizedPnl,
        totalMarketFees,
        totalBlockchainFees,
        totalRealizedPnlNet,
        netPosition,
    };
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function fmt(n: number): string {
    // Shared 4-significant-figure formatter (see modules/order/format.ts) so
    // terminal output matches the HTML report and `dexbot order`.
    return Number.isFinite(n) ? formatFundsValue(n) : 'NaN';
}

function fmtPct(n: number): string {
    if (!Number.isFinite(n)) return 'NaN%';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtAsset(id: string): string {
    return assetSymbol(id);
}

/** Group pairs by quote asset for the grand-total sections. */
function groupPairsByQuote(pairs: PairAnalysis[]): Map<string, PairAnalysis[]> {
    const quoteGroups = new Map<string, PairAnalysis[]>();
    for (const p of pairs) {
        const q = p.quoteAsset;
        if (!quoteGroups.has(q)) quoteGroups.set(q, []);
        quoteGroups.get(q)!.push(p);
    }
    return quoteGroups;
}

function printSummary(pairs: PairAnalysis[]) {
    console.log('');

    for (const pair of pairs) {
        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;
        const totalBought = pair.totalBuyBase;
        const totalSold = pair.totalSellBase;
        const avgBuy = pair.totalBuyBase > 0 ? pair.totalBuyQuote / pair.totalBuyBase : 0;
        const avgSell = pair.totalSellBase > 0 ? pair.totalSellQuote / pair.totalSellBase : 0;

        console.log(` ── ${pairLabel}`);
        console.log(`    Buys:        ${fmt(totalBought)} @ ${fmt(avgBuy)} = ${fmt(pair.totalBuyQuote)} ${fmtAsset(pair.quoteAsset)}`);
        console.log(`    Sells:       ${fmt(totalSold)} @ ${fmt(avgSell)} = ${fmt(pair.totalSellQuote)} ${fmtAsset(pair.quoteAsset)}`);
        console.log(`    Net inventory \u0394: ${fmt(pair.netPosition)} ${fmtAsset(pair.baseAsset)} (bought \u2212 sold in window)`);
        console.log(`    Trades:      ${pair.realizedPnls.length} realized lots, ${pair.buys.length} buys, ${pair.sells.length} sells`);
        if (pair.unmatchedSellBase > 0.0001) {
            console.log(`    Unmatched:   ${fmt(pair.unmatchedSellBase)} ${fmtAsset(pair.baseAsset)} (sold without prior buy in window — expected if inventory predates window)`);
        }
        console.log(`    Gross PnL:    ${fmtAsset(pair.quoteAsset)} ${fmt(pair.totalRealizedPnl)}`);
        const mktFee = pair.totalMarketFees;
        const blkFee = pair.totalBlockchainFees;
        if (mktFee > 0.0001) {
            console.log(`    Market fees:  ${fmtAsset(pair.quoteAsset)} ${fmt(-mktFee)}`);
        }
        if (blkFee > 0.0001) {
            console.log(`    Blockchain:   BTS ${fmt(-blkFee)}`);
        }
        console.log(`    Net PnL:      ${fmtAsset(pair.quoteAsset)} ${fmt(pair.totalRealizedPnlNet)}`);
        if (pair.quoteAsset !== BTS_ID) {
            console.log(`    ⚠ Non-BTS quote — PnL is in ${fmtAsset(pair.quoteAsset)}, not BTS`);
        }
        console.log('');
    }

    // Grand totals grouped by quote asset
    const quoteGroups = groupPairsByQuote(pairs);
    if (pairs.length > 1 && quoteGroups.size > 0) {
        for (const [quoteAsset, group] of quoteGroups) {
            const groupPnl = group.reduce((s, p) => s + p.totalRealizedPnl, 0);
            const groupMktFees = group.reduce((s, p) => s + p.totalMarketFees, 0);
            const groupBlkFees = group.reduce((s, p) => s + p.totalBlockchainFees, 0);
            const groupNet = group.reduce((s, p) => s + p.totalRealizedPnlNet, 0);
            const groupVol = group.reduce((s, p) => s + p.totalBuyQuote + p.totalSellQuote, 0);
            const qSymbol = fmtAsset(quoteAsset);
            console.log(` ── TOTAL (${qSymbol}) — ${group.length} pair(s)`);
            console.log(`    Gross PnL:    ${fmtAsset(quoteAsset)} ${fmt(groupPnl)}`);
            if (groupMktFees > 0.0001) {
                console.log(`    Market fees:  ${fmtAsset(quoteAsset)} ${fmt(-groupMktFees)}`);
            }
            if (groupBlkFees > 0.0001) {
                console.log(`    Blockchain:   BTS ${fmt(-groupBlkFees)}`);
            }
            console.log(`    Net PnL:      ${fmtAsset(quoteAsset)} ${fmt(groupNet)}`);
            console.log(`    Volume:       ${fmt(groupVol)} ${qSymbol}`);
            console.log('');
        }
    }
    console.log(`  Note: PnL uses gross prices. Net PnL deducts market fees (charged by`);
    console.log(`        asset issuer on receives, both issuer and network portions) and`);
    console.log(`        blockchain operation fees (BTS per limit_order_create). Market`);
    console.log(`        fees are converted to quote asset. Buy lots are entered at net`);
    console.log(`        receives (gross minus buy-side market fee) so inventory matching`);
    console.log(`        reflects what the account actually held. If inventory predates the`);
    console.log(`        window or crosses asset pairs, the realized lots may not reflect`);
    console.log(`        true trade economics.`);
    console.log('');
}

function printPnlDetail(pairs: PairAnalysis[]) {
    for (const pair of pairs) {
        if (pair.realizedPnls.length === 0) continue;

        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;
        console.log('');
        console.log(` ── ${pairLabel} — Realized PnL Detail`);
        console.log('');

        const hdr = ' #   Buy Price    EffBuy      Sell Price   Amount    PnL         PnL%      MktFee    OpFeeBTS  Net PnL     Net%     Legs  Entry Time              Exit Time';
        console.log(hdr);
        console.log(' ' + '─'.repeat(hdr.length - 1));

        for (let i = 0; i < pair.realizedPnls.length; i++) {
            const r = pair.realizedPnls[i];
            const idx = String(i + 1).padStart(2);
            const bp = fmt(r.buyPrice).padStart(11);
            const ep = fmt(r.effPrice).padStart(11);
            const sp = fmt(r.sellPrice).padStart(11);
            const amt = fmt(r.amount).padStart(9);
            const pnlStr = fmt(r.pnl).padStart(9);
            const pctStr = fmtPct(r.pnlPct).padStart(8);
            const mktFeeStr = fmt(r.marketFeeEntry + r.marketFeeExit).padStart(8);
            const feeStr = fmt(r.feeBts).padStart(8);
            const netStr = fmt(r.pnlNet).padStart(10);
            const netPctStr = fmtPct(r.pnlNetPct).padStart(8);
            const mk = (r.entryIsMaker ? 'M' : 'T') + '/' + (r.exitIsMaker ? 'M' : 'T') + ' ';
            const et = (r.entryTime || '').slice(0, 22).padEnd(22);
            const xt = (r.exitTime || '').slice(0, 22).padEnd(22);
            console.log(` ${idx}  ${bp}  ${ep}  ${sp}  ${amt}  ${pnlStr}  ${pctStr}  ${mktFeeStr}  ${feeStr}  ${netStr}  ${netPctStr}  ${mk}  ${et}  ${xt}`);
        }
        console.log('');
    }
}

// ─── Performance Metrics ──────────────────────────────────────────────────────

interface WindowRange {
    /** The analysis window actually queried — drives annualisation. */
    startMs: number;
    endMs: number;
}

interface TradingMetrics {
    totalLots: number;
    winRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    avgWinLossRatio: number;
    expectancyBts: number;
    expectancyPct: number;
    expectancyR: number;
    netExpectancyBts: number;
    // Risk-adjusted ratios annualised from the analysis window (see
    // --hours/--start/--end). Binned 1d for windows >= 3 days, else 1h; every
    // period in the window is zero-filled so flat periods count as 0 PnL and
    // the window scales cleanly to a year. Only whole periods are scored: a
    // trailing partial period is excluded from ratios AND projection alike,
    // so both share the same denominator.
    sharpeAnn: number;          // NaN when undefined (no dispersion / < 2 periods)
    sortinoAnn: number;         // Infinity when the window has no losing periods
    sharpeAnnSE: number;        // standard error of sharpeAnn (estimation uncertainty)
    periodLabel: string;        // '1h' | '1d'
    periodCount: number;        // whole periods scored, including zero-PnL ones
    periodSpanDays: number;     // queried window length
    scoredSpanDays: number;     // whole-period span actually scored (nPeriods × bin)
    annualFactor: number;       // sqrt(periods per year)
    projectedNetPnlPerDay: number;
    projectedNetPnlAnn: number;
    maxConsecWins: number;
    maxConsecLosses: number;
    avgHoldHours: number;
    limitOrderRatio: number;
    bestTradePct: number;
    worstTradePct: number;
    mddPct: number;
    mddAbsBts: number;
    /** Lowest cumulative equity before a stable peak formed (quote asset); 0 when a peak existed. */
    prePeakMinEquity: number;
    mddHadStablePeak: boolean;
    isOngoingRecovery: boolean;
    currentDrawdownDays: number;
    medianPnlPct: number;
    p25PnlPct: number;
    p75PnlPct: number;

    feeDragPct: number;
    maxRecoveryDays: number;
    sellOrdersFilled: number;
    fillsPerOrderMean: number;
    fillsPerOrderMedian: number;
    fillsPerOrderMax: number;
    oneShotOrderRatio: number;
    fillsPerDay: number;
    avgVolumePerDay: number;
    medianR: number;
    pctRGreater1: number;
    pctRGreater2: number;
    pctRLessNeg1: number;
}

function computeMetrics(pair: PairAnalysis, window?: WindowRange): TradingMetrics {
    const pnls = pair.realizedPnls;
    const total = pnls.length;
    if (total === 0) {
        return {
            totalLots: 0, winRate: 0, profitFactor: 0,
            avgWin: 0, avgLoss: 0, avgWinLossRatio: 0,
            expectancyBts: 0, expectancyPct: 0, expectancyR: 0,
            netExpectancyBts: 0,
            sharpeAnn: NaN, sortinoAnn: NaN, sharpeAnnSE: NaN,
            periodLabel: '—', periodCount: 0, periodSpanDays: 0, scoredSpanDays: 0,
            annualFactor: 0,
            projectedNetPnlPerDay: 0, projectedNetPnlAnn: 0,
            maxConsecWins: 0, maxConsecLosses: 0,
            avgHoldHours: 0, limitOrderRatio: 0,
            bestTradePct: 0, worstTradePct: 0,
            mddPct: 0,
            mddAbsBts: 0,
            prePeakMinEquity: 0,
            mddHadStablePeak: false,
            isOngoingRecovery: false,
            currentDrawdownDays: 0,
            medianPnlPct: 0, p25PnlPct: 0, p75PnlPct: 0,
            feeDragPct: 0, maxRecoveryDays: 0,
            medianR: 0, pctRGreater1: 0, pctRGreater2: 0, pctRLessNeg1: 0,
            sellOrdersFilled: 0, fillsPerOrderMean: 0, fillsPerOrderMedian: 0,
            fillsPerOrderMax: 0, oneShotOrderRatio: 0, fillsPerDay: 0, avgVolumePerDay: 0,
        };
    }

    const wins = pnls.filter(r => r.pnl > 0);
    const losses = pnls.filter(r => r.pnl < 0);
    const winRate = wins.length / total;
    const makerEntryCount = pnls.filter(r => r.entryIsMaker).length;
    const makerExitCount = pnls.filter(r => r.exitIsMaker).length;
    const totalMakerLegs = makerEntryCount + makerExitCount;

    const grossProfit = wins.reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const totalFeeDrag = pair.totalMarketFees + pair.totalBlockchainFees;
    const feeDragPct = grossProfit > 0 ? (totalFeeDrag / grossProfit) * 100 : 0;

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length : 0;

    const avgWinPct = wins.length > 0 ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0;

    const avgWinLossRatio = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0;

    const expectancyBts = (winRate * avgWin) + ((1 - winRate) * avgLoss);
    const expectancyPct = (winRate * avgWinPct) + ((1 - winRate) * avgLossPct);
    const rMultiple = Math.abs(avgLoss);
    const expectancyR = rMultiple > 0
        ? winRate * (avgWin / rMultiple) - (1 - winRate)
        : Infinity;

    const netExpectancyBts = pair.totalRealizedPnlNet / total;

    // ─── Risk-adjusted ratios (window-aware annualisation) ────────────────
    // Bin the window's net PnL into calendar periods and annualise with the
    // matching periods-per-year. Every period in the window is represented
    // (zero-filled): flat periods must count as 0 PnL, otherwise a bot that
    // trades a few days a week is scored as if it traded every day, and the
    // window cannot be scaled honestly to a year.
    const HOUR_MS = 3600_000;
    const DAY_MS = 86_400_000;
    const times = pnls.map(r => Date.parse(r.exitTime)).filter(t => Number.isFinite(t));
    const firstMs = window?.startMs ?? (times.length > 0 ? Math.min(...times) : 0);
    const lastMs = window?.endMs ?? (times.length > 0 ? Math.max(...times) : firstMs + DAY_MS);
    const spanMs = Math.max(lastMs - firstMs, window ? HOUR_MS : DAY_MS);
    const periodSpanDays = spanMs / DAY_MS;
    // Daily buckets need a handful of observations before a daily std means
    // anything; shorter windows fall back to hourly bins so they still
    // annualise instead of dividing by a one-sample std.
    const useHourly = periodSpanDays < 3;
    const periodMs = useHourly ? HOUR_MS : DAY_MS;
    const periodsPerYear = useHourly ? 8760 : 365;
    const periodLabel = useHourly ? '1h' : '1d';

    // Score only whole periods: a trailing partial period (window not an exact
    // multiple of the bin) would otherwise be a deflated observation. It is
    // excluded from ratios, projection AND activity rates alike, so every
    // window-derived metric shares one basis. Bins are aligned to the window
    // start, so an exact-multiple window scores everything.
    const nPeriods = Math.max(1, Math.floor(spanMs / periodMs));
    const scoredSpanDays = nPeriods * periodMs / DAY_MS;
    const scoredEndMs = firstMs + nPeriods * periodMs;
    const exactWindow = spanMs === nPeriods * periodMs;
    // A fill belongs to the scored window if it falls inside the whole
    // periods. On an exact-multiple window the end boundary is inclusive (the
    // ES range query includes `lte`); with a partial tail that boundary fill
    // is trailing and excluded along with the rest of the tail.
    const inScoredWindow = (t: number) =>
        Number.isFinite(t) && t >= firstMs
        && (t < scoredEndMs || (exactWindow && t === scoredEndMs));
    const periodPnl = new Array<number>(nPeriods).fill(0);
    let scoredFillCount = 0;
    for (const r of pnls) {
        const t = Date.parse(r.exitTime);
        if (!inScoredWindow(t)) continue;
        let idx = Math.floor((t - firstMs) / periodMs);
        if (idx === nPeriods) idx = nPeriods - 1; // inclusive end boundary
        periodPnl[idx] += r.pnlNet;
        scoredFillCount++;
    }

    const meanPeriod = periodPnl.reduce((s, v) => s + v, 0) / nPeriods;
    // Sample variance (n-1): the window is a sample, not the whole population.
    const periodVar = nPeriods > 1
        ? periodPnl.reduce((s, v) => s + (v - meanPeriod) ** 2, 0) / (nPeriods - 1)
        : 0;
    const periodStd = Math.sqrt(periodVar);
    const annualFactor = Math.sqrt(periodsPerYear);
    const sharpeAnn = periodStd > 0 ? (meanPeriod / periodStd) * annualFactor : NaN;

    // Estimation uncertainty of the annualised Sharpe (Lo 2002, i.i.d. returns).
    const srPerPeriod = periodStd > 0 ? meanPeriod / periodStd : NaN;
    const sharpeAnnSE = nPeriods > 1 && Number.isFinite(srPerPeriod)
        ? Math.sqrt((1 + 0.5 * srPerPeriod * srPerPeriod) / nPeriods) * annualFactor
        : NaN;

    // Target downside deviation (MAR = 0), sample denominator (n-1) to match
    // the Sharpe convention above — the two ratios stay internally
    // comparable (many textbook Sortinos divide by N; we deliberately
    // don't mix conventions). With no losing periods Sortino is undefined —
    // reporting 0 would read as "terrible", the opposite of truth.
    const downsideVar = nPeriods > 1
        ? periodPnl.reduce((s, v) => s + (v < 0 ? v * v : 0), 0) / (nPeriods - 1)
        : 0;
    const downsideStd = Math.sqrt(downsideVar);
    const sortinoAnn = nPeriods < 2
        ? NaN
        : (downsideStd > 0
            ? (meanPeriod / downsideStd) * annualFactor
            : (meanPeriod > 0 ? Infinity : NaN));

    // "This window repeated all year" — linear projection of the scored
    // window's net PnL. Uses the same whole-period basis as the ratios
    // above (not the raw window total), so Sharpe and projection can never
    // disagree about what the window contains.
    const scoredPnl = periodPnl.reduce((s, v) => s + v, 0);
    const projectedNetPnlPerDay = scoredPnl / scoredSpanDays;
    const projectedNetPnlAnn = projectedNetPnlPerDay * 365;

    // Fills-per-order distribution (grouped by sell order)
    const fillCounts: number[] = [];
    const orderMap = new Map<string, number>();
    for (const r of pnls) {
        orderMap.set(r.exitOrderId, (orderMap.get(r.exitOrderId) || 0) + 1);
    }
    for (const c of orderMap.values()) fillCounts.push(c);
    const sellOrdersFilled = orderMap.size;
    const fillsPerOrderMean = sellOrdersFilled > 0
        ? fillCounts.reduce((s, v) => s + v, 0) / sellOrdersFilled
        : 0;
    const fillsPerOrderMax = sellOrdersFilled > 0
        ? fillCounts.reduce((a, b) => Math.max(a, b), 0)
        : 0;
    const sortedCounts = [...fillCounts].sort((a, b) => a - b);
    const fillsPerOrderMedian = sellOrdersFilled > 0 ? percentile(sortedCounts, 50, { sorted: true, empty: 0 }) : 0;
    const oneShotOrderRatio = sellOrdersFilled > 0
        ? fillCounts.filter(c => c === 1).length / sellOrdersFilled
        : 0;
    // Activity rates share the scored whole-period basis: numerator and
    // denominator both cover exactly the lots/fills the ratios scored. A fill
    // with an unparseable timestamp has no period, so it is excluded here too.
    const scoredNotional = [...pair.buys, ...pair.sells]
        .reduce((s, f) => s + (inScoredWindow(Date.parse(f.time)) ? f.quoteAmount : 0), 0);
    const fillsPerDay = scoredSpanDays > 0 ? scoredFillCount / scoredSpanDays : 0;
    const avgVolumePerDay = scoredSpanDays > 0 ? scoredNotional / scoredSpanDays : 0;

    // Avg hold duration
    let totalHours = 0;
    let hourCount = 0;
    for (const r of pnls) {
        const entry = new Date(r.entryTime).getTime();
        const exit = new Date(r.exitTime).getTime();
        if (!isNaN(entry) && !isNaN(exit) && exit > entry) {
            totalHours += (exit - entry) / 3600000;
            hourCount++;
        }
    }
    const avgHoldHours = hourCount > 0 ? totalHours / hourCount : 0;

    // Max consecutive wins / losses (aggregated by exit order)
    const orderPnls = new Map<string, { pnl: number; time: string }>();
    for (const r of pnls) {
        const existing = orderPnls.get(r.exitOrderId);
        if (existing) {
            existing.pnl += r.pnl;
        } else {
            orderPnls.set(r.exitOrderId, { pnl: r.pnl, time: r.exitTime });
        }
    }
    const orderResults = [...orderPnls.values()].sort((a, b) =>
        new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    let consecW = 0, consecL = 0;
    let maxW = 0, maxL = 0;
    for (const { pnl } of orderResults) {
        if (pnl > 0) { consecW++; consecL = 0; maxW = Math.max(maxW, consecW); }
        else if (pnl < 0) { consecL++; consecW = 0; maxL = Math.max(maxL, consecL); }
        else { consecW = 0; consecL = 0; }
    }

    // ─── Max Drawdown + Recovery Time ───────────────────────────────────
    const STABILITY_TRADES = 3;
    const MIN_TRADES_FOR_PEAK = 10; // backstop for monotonic equity curves
    const chronological = [...pnls].sort((a, b) =>
        new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime()
    );
    let equity = 0, peak = 0, mddPct = 0, mddAbsBts = 0;
    let maxRecoveryDays = 0;
    let isOngoingRecovery = false;
    let currentDrawdownDays = 0;
    let drawdownStartTime = 0;
    let troughTime = 0;
    let currentTroughEquity = Infinity;
    let hadStablePeak = false;
    let tradesSincePeakSet = 0;
    let hasPrePeakEquity = false;
    let prePeakMinEquity = 0;
    let totalTradesProcessed = 0;

    for (const r of chronological) {
        totalTradesProcessed++;
        equity += r.pnlNet;
        if (equity > peak) {
            if (troughTime > 0 && hadStablePeak) {
                const recoveryDays = (new Date(r.exitTime).getTime() - troughTime) / 86400000;
                if (recoveryDays > maxRecoveryDays) maxRecoveryDays = recoveryDays;
            }
            peak = equity;
            tradesSincePeakSet = 0;
            currentTroughEquity = Infinity;
            troughTime = 0;
            drawdownStartTime = 0;
        } else {
            tradesSincePeakSet++;
            if (tradesSincePeakSet >= STABILITY_TRADES) {
                hadStablePeak = true;
            }
        }
        if (!hadStablePeak && totalTradesProcessed >= MIN_TRADES_FOR_PEAK) {
            hadStablePeak = true;
        }

        if (hadStablePeak && equity < peak && peak > 0) {
            if (drawdownStartTime === 0) drawdownStartTime = new Date(r.exitTime).getTime();
            if (equity < currentTroughEquity) {
                currentTroughEquity = equity;
                troughTime = new Date(r.exitTime).getTime();
            }
            const dd = (equity - peak) / peak;
            if (dd < mddPct) mddPct = dd;
            const ddAbs = peak - equity;
            if (ddAbs > mddAbsBts) mddAbsBts = ddAbs;
        }

        if (peak > 0 && !hadStablePeak) {
            if (!hasPrePeakEquity || equity < prePeakMinEquity) {
                prePeakMinEquity = equity;
                hasPrePeakEquity = true;
            }
        }
    }

    if (drawdownStartTime > 0 && hadStablePeak) {
        const lastTime = new Date(chronological[chronological.length - 1].exitTime).getTime();
        currentDrawdownDays = (lastTime - drawdownStartTime) / 86400000;
        isOngoingRecovery = true;
        if (currentDrawdownDays > maxRecoveryDays) {
            maxRecoveryDays = currentDrawdownDays;
        }
    }

    if (hadStablePeak) {
        mddPct *= 100;
        prePeakMinEquity = 0;
    } else {
        mddPct = 0;
        mddAbsBts = 0;
        prePeakMinEquity = hasPrePeakEquity ? prePeakMinEquity : 0;
    }

    // Payoff distribution stats
    const pnlPcts = [...pnls.map(r => r.pnlPct)].sort((a, b) => a - b);
    const medianPnlPct = percentile(pnlPcts, 50, { sorted: true, empty: 0 });
    const p25PnlPct = percentile(pnlPcts, 25, { sorted: true, empty: 0 });
    const p75PnlPct = percentile(pnlPcts, 75, { sorted: true, empty: 0 });
    const absAvgLoss = Math.abs(avgLoss);
    let rValues: number[] = [];
    if (absAvgLoss > 0) {
        rValues = pnls.map(r => r.pnl / absAvgLoss).sort((a, b) => a - b);
    }
    const medianR = rValues.length > 0 ? percentile(rValues, 50, { sorted: true, empty: 0 }) : 0;
    const pctRGreater1 = rValues.length > 0 ? rValues.filter(r => r > 1).length / rValues.length : 0;
    const pctRGreater2 = rValues.length > 0 ? rValues.filter(r => r > 2).length / rValues.length : 0;
    const pctRLessNeg1 = rValues.length > 0 ? rValues.filter(r => r < -1).length / rValues.length : 0;

    const bestTradePct = pnlPcts.length > 0 ? pnlPcts[pnlPcts.length - 1] : 0;
    const worstTradePct = pnlPcts.length > 0 ? pnlPcts[0] : 0;

    return {
        totalLots: total,
        winRate,
        profitFactor,
        avgWin,
        avgLoss,
        avgWinLossRatio,
        expectancyBts,
        expectancyPct,
        expectancyR,
        netExpectancyBts,
        sharpeAnn,
        sortinoAnn,
        sharpeAnnSE,
        periodLabel,
        periodCount: nPeriods,
        periodSpanDays,
        scoredSpanDays,
        annualFactor,
        projectedNetPnlPerDay,
        projectedNetPnlAnn,
        feeDragPct,
        maxConsecWins: maxW,
        maxConsecLosses: maxL,
        avgHoldHours,
        limitOrderRatio: total > 0 ? totalMakerLegs / (total * 2) : 0,
        bestTradePct,
        worstTradePct,
        mddPct,
        mddAbsBts,
        prePeakMinEquity,
        mddHadStablePeak: hadStablePeak,
        isOngoingRecovery,
        currentDrawdownDays,
        maxRecoveryDays,
        medianPnlPct,
        p25PnlPct,
        p75PnlPct,
        medianR,
        pctRGreater1,
        pctRGreater2,
        pctRLessNeg1,
        sellOrdersFilled,
        fillsPerOrderMean,
        fillsPerOrderMedian,
        fillsPerOrderMax,
        oneShotOrderRatio,
        fillsPerDay,
        avgVolumePerDay,
    };
}

function printMetrics(pairs: PairAnalysis[], window?: WindowRange) {
    for (const pair of pairs) {
        if (pair.realizedPnls.length === 0) continue;

        const m = computeMetrics(pair, window);
        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;

        console.log('');
        console.log(` ── ${pairLabel} — Performance Metrics`);
        console.log('');
        // Edge
        console.log(`  Win Rate:             ${(m.winRate * 100).toFixed(1)}%`);
        console.log(`  Profit Factor:        ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`);
        const mktFeeStr = pair.totalMarketFees > 0.0001 ? ` (market ${fmt(pair.totalMarketFees)})` : '';
        const blkFeeStr = pair.totalBlockchainFees > 0.0001 ? ` (op ${fmt(pair.totalBlockchainFees)} BTS)` : '';
        console.log(`  Fee Drag:             ${m.feeDragPct > 0 ? m.feeDragPct.toFixed(2) + '% of gross profit' + mktFeeStr + blkFeeStr : '—'}`);
        console.log(`  Avg Win / Avg Loss:   ${m.avgWinLossRatio === Infinity ? '∞' : m.avgWinLossRatio.toFixed(2)}`);
        const qSymbol = fmtAsset(pair.quoteAsset);
        console.log(`  Expectancy (gross):   ${fmt(m.expectancyBts)} ${qSymbol} (${fmtPct(m.expectancyPct)}) per trade`);
        const rDisplay = m.expectancyR === Infinity ? '∞' : m.expectancyR.toFixed(3) + 'R';
        console.log(`  Expectancy (R):       ${rDisplay}`);
        console.log(`  Expectancy (net):     ${fmt(m.netExpectancyBts)} ${qSymbol} per trade`);
        console.log('');
        // Edge quality
        console.log(`  Median R:             ${m.medianR.toFixed(2)}`);
        console.log(`  Trades > 1R / > 2R:   ${(m.pctRGreater1 * 100).toFixed(1)}% / ${(m.pctRGreater2 * 100).toFixed(1)}%`);
        console.log(`  Trades < -1R:         ${(m.pctRLessNeg1 * 100).toFixed(1)}%`);
        console.log('');
        // PnL distribution
        console.log(`  Median PnL:           ${fmtPct(m.medianPnlPct)}`);
        console.log(`  P25 / P75:            ${fmtPct(m.p25PnlPct)} / ${fmtPct(m.p75PnlPct)}`);
        console.log(`  Best / Worst Trade:   ${fmtPct(m.bestTradePct)} / ${fmtPct(m.worstTradePct)}`);
        console.log('');
        // Risk-adjusted — annualised from the analysis window, zero-filled bins
        const ratioStr = (v: number) => Number.isFinite(v) ? v.toFixed(2) : (v === Infinity ? '∞' : 'n/a');
        const seStr = Number.isFinite(m.sharpeAnnSE) ? ` ± ${m.sharpeAnnSE.toFixed(2)}` : '';
        const confidence = m.periodSpanDays < 30 ? 'low confidence' : 'ok';
        console.log(`  Sharpe (ann):         ${ratioStr(m.sharpeAnn)}${seStr}   [${m.periodLabel} bins, n=${m.periodCount}, ${confidence}]`);
        const sortinoNote = m.sortinoAnn === Infinity ? '   (no losing periods)' : '';
        console.log(`  Sortino (ann):        ${ratioStr(m.sortinoAnn)}${sortinoNote}`);
        if (m.periodLabel === '1h') {
            console.log(`    ⚠ window < 3 days: hourly bins over an unrepresentative sample — treat the annualised ratios as indicative only and never rank them against 1d-binned runs`);
        }
        const spanStr = m.scoredSpanDays < m.periodSpanDays - 1e-9
            ? `${m.scoredSpanDays.toFixed(1)}d scored of ${m.periodSpanDays.toFixed(1)}d window`
            : `${m.periodSpanDays.toFixed(1)}d`;
        console.log(`  Projected net PnL:    ${fmt(m.projectedNetPnlAnn)} ${qSymbol}/yr   (${fmt(m.projectedNetPnlPerDay)}/day over ${spanStr})`);
        console.log('');
        // Tail risk
        if (m.mddHadStablePeak) {
            console.log(`  Max Drawdown:         ${fmt(m.mddAbsBts)} ${qSymbol} (${fmtPct(m.mddPct)} of peak cumulative profit)`);
        } else {
            console.log(`  Min Equity:            ${fmt(m.prePeakMinEquity)} ${fmtAsset(pair.quoteAsset)}`);
        }
        const recLabel = m.maxRecoveryDays > 0 ? m.maxRecoveryDays.toFixed(1) + ' days' + (m.isOngoingRecovery ? ' (ongoing)' : '') : '—';
        console.log(`  Max Recovery Time:    ${recLabel}`);
        if (m.currentDrawdownDays > 0) {
            console.log(`  Current Drawdown:     ${m.currentDrawdownDays.toFixed(1)} days (active)`);
        }
        console.log('');
        // Behavioral
        console.log(`  Max Consecutive W/L:  ${m.maxConsecWins} / ${m.maxConsecLosses}`);
        const holdDisplay = m.avgHoldHours > 0 ? m.avgHoldHours.toFixed(1) : '—';
        console.log(`  Avg hold time:        ${holdDisplay} hours`);
        console.log(`  Maker / Taker:        ${(m.limitOrderRatio * 100).toFixed(1)}% / ${((1 - m.limitOrderRatio) * 100).toFixed(1)}%`);
        console.log('');
        // Activity
        console.log(`  Sell orders filled:   ${m.sellOrdersFilled}`);
        console.log(`  Partial fills/order:  ${m.fillsPerOrderMean.toFixed(2)} mean, ${m.fillsPerOrderMedian.toFixed(1)} med, ${m.fillsPerOrderMax} max`);
        console.log(`  One-shot orders:      ${(m.oneShotOrderRatio * 100).toFixed(0)}%`);
        console.log(`  Fills/day:            ${m.fillsPerDay.toFixed(2)}`);
        console.log(`  Avg vol/day:          ${fmt(m.avgVolumePerDay)} ${fmtAsset(pair.quoteAsset)}`);
        console.log('');

    }

    // Grand totals grouped by quote asset
    const quoteGroups = groupPairsByQuote(pairs);
    if (pairs.length > 1 && quoteGroups.size > 0) {
        for (const [quoteAsset, group] of quoteGroups) {
            const totalLots = group.reduce((s, p) => s + p.realizedPnls.length, 0);
            const totalNet = group.reduce((s, p) => s + p.totalRealizedPnlNet, 0);
            const totalMktFees = group.reduce((s, p) => s + p.totalMarketFees, 0);
            const totalBlkFees = group.reduce((s, p) => s + p.totalBlockchainFees, 0);
            const qSymbol = fmtAsset(quoteAsset);
            console.log(` ── TOTAL (${qSymbol}) — ${group.length} pair(s)`);
            console.log(`    Lots:      ${totalLots}`);
            const feeParts: string[] = [];
            if (totalMktFees > 0.0001) feeParts.push(`market ${fmt(totalMktFees)} ${qSymbol}`);
            if (totalBlkFees > 0.0001) feeParts.push(`op ${fmt(totalBlkFees)} BTS`);
            const feeSuffix = feeParts.length > 0 ? `  (${feeParts.join(', ')})` : '';
            console.log(`    Net PnL:   ${fmtAsset(quoteAsset)} ${fmt(totalNet)}${feeSuffix}`);
            console.log('');
        }
    }
}

// ─── CSV Export ──────────────────────────────────────────────────────────────

function exportCsv(pairs: PairAnalysis[], filePath: string) {
    const esc = (v: unknown) => { const s = String(v); return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = ['time,orderId,direction,baseAsset,quoteAsset,baseAmount,quoteAmount,price,isMaker,marketFeeReal,marketFeeAsset'];

    for (const pair of pairs) {
        for (const t of [...pair.buys, ...pair.sells].sort((a, b) => a.sequence - b.sequence)) {
            lines.push([
                esc(t.time),
                esc(t.orderId),
                esc(t.direction),
                esc(t.baseAsset),
                esc(t.quoteAsset),
                t.baseAmount,
                t.quoteAmount,
                t.price,
                t.isMaker ? '1' : '0',
                t.marketFeeReal,
                esc(t.marketFeeAsset),
            ].join(','));
        }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    console.log(`  Trades exported to ${filePath}`);
}

// ─── JSON Export ─────────────────────────────────────────────────────────────

function exportJson(accountId: string, start: string, end: string, pairs: PairAnalysis[], filePath: string) {
    const data = {
        accountId,
        period: { start, end },
        pairs: pairs.map(p => ({
            baseAsset: p.baseAsset,
            quoteAsset: p.quoteAsset,
            summary: {
                totalBuyBase: p.totalBuyBase,
                totalSellBase: p.totalSellBase,
                totalBuyQuote: p.totalBuyQuote,
                totalSellQuote: p.totalSellQuote,
                netPosition: p.netPosition,
                totalRealizedPnl: p.totalRealizedPnl,
                totalMarketFees: p.totalMarketFees,
                totalBlockchainFees: p.totalBlockchainFees,
                totalRealizedPnlNet: p.totalRealizedPnlNet,
            },
            realizedPnls: p.realizedPnls.map(r => ({
                ...r,
                marketFeeEntry: r.marketFeeEntry,
                marketFeeExit: r.marketFeeExit,
                feeBts: r.feeBts,
                pnlNet: r.pnlNet,
                pnlNetPct: r.pnlNetPct,
            })),
            totalBuys: p.buys.length,
            totalSells: p.sells.length,
        })),
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  Full analysis exported to ${filePath}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Normalize a user-supplied time bound into an ES-compatible ISO string.
 *
 * Parsing goes through `new Date()` so offset-bearing ISO strings
 * (e.g. 2026-07-07T12:00:00+02:00) are honored instead of being corrupted by a
 * blind 'Z' append (+02:00Z). A date-only --end expands to the end of that UTC
 * day (T23:59:59.999Z) — treating it as midnight silently dropped the final day.
 */
function normalizeTimeBound(raw: string, isEnd: boolean): string {
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) {
        throw new Error(`Invalid ${isEnd ? '--end' : '--start'} time: ${raw}`);
    }
    let ms = parsed.getTime();
    if (isEnd && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
        ms += 24 * 3600 * 1000 - 1;
    }
    return new Date(ms).toISOString();
}

/** Auto-named report file: bot/account + pair filter + requested range. */
function reportFileName(opts: TradeProfitabilityOptions, accountRef: string, botName: string | null): string {
    const slugBase = botName ? sanitizeKey(botName) : sanitizeKey(accountRef);
    const pair = opts.pair as { base: string; quote: string } | null;
    const pairSlug = pair ? `_${sanitizeKey(pair.base)}-${sanitizeKey(pair.quote)}` : '';
    let rangeSlug: string;
    if (opts.months != null) rangeSlug = `_${String(opts.months).replace('.', 'p')}m`;
    else if (opts.start) rangeSlug = `_${String(opts.start).slice(0, 10)}${opts.end ? '_' + String(opts.end).slice(0, 10) : ''}`;
    else rangeSlug = `_${opts.hours || 168}h`;
    return `pnl_${slugBase}${pairSlug}${rangeSlug}.html`;
}

async function run(argv: string[] = process.argv.slice(2)) {
    muteChainLogs();
    const opts = parseArgs(argv);
    let accountId = opts.accountId;
    let resolvedBotName: string | null = null;

    if (!/^1\.2\.\d+$/.test(String(accountId))) {
        // The Kibana query below filters on the 1.2.x account_id field, so a
        // name must always resolve first (a raw name would silently return
        // zero fills). Shared resolver: a local bot profile is checked first
        // (no chain call), then a stored accountId, then a fresh lookup; the
        // result is stamped back onto the bot entry.
        const resolved = await resolveAccountRef(accountId, { refresh: opts.refreshAccount });
        if (!resolved.accountId) {
            console.error(`  Could not resolve "${accountId}" to an account ID`);
            process.exit(1);
        }
        accountId = resolved.accountId;
        resolvedBotName = (resolved.botMeta?.name as string) ?? null;
    }

    // Build time range
    const now = new Date();
    let gte: string, lte: string;

    if (opts.start && opts.end) {
        gte = normalizeTimeBound(opts.start, false);
        lte = normalizeTimeBound(opts.end, true);
    } else if (opts.start) {
        gte = normalizeTimeBound(opts.start, false);
        lte = now.toISOString();
    } else {
        const hours = opts.months != null ? monthsToHours(opts.months) : (opts.hours || 168);
        const start = new Date(now.getTime() - hours * 3600 * 1000);
        gte = start.toISOString();
        lte = now.toISOString();
    }

    const KIBANA_CFG = { timeout: 60000 };

    // Month-shard cache keyed by the resolved accountId; --refresh-account
    // bypasses coverage trust and re-queries the requested range.
    const fills = await fetchFillsCached(KIBANA_CFG, accountId, gte, lte, { refresh: opts.refreshAccount });

    if (fills.length === 0) {
        console.log('  No fills found in the specified time range.');
        process.exit(0);
    }

    // Resolve unknown asset precisions from blockchain
    await resolveAssetPrecisions(fills);

    // Classify fills
    const { trades, pairs } = classifyFills(fills, opts.asset, opts.pair as { base: string; quote: string } | null | undefined);

    if (trades.length === 0) {
        console.log('  No trades could be classified (check pair/asset filter or time range).');
        process.exit(0);
    }

    console.log(`Account:  ${accountId}${resolvedBotName ? `  (bot: ${resolvedBotName})` : ''}`);
    console.log(`Period:   ${gte.slice(0, 10)}  →  ${lte.slice(0, 10)}`);
    console.log(`Pairs:    ${pairs.size}, ${trades.length} classified trades`);
    const hasCrossPair = [...pairs].some(p => p.split(':')[1] !== BTS_ID);
    if (hasCrossPair) {
        console.log(`  Note: cross-pair trades (non-BTS quote) are included but PnL is in the pair's quote asset.`);
    }
    console.log('');

    // Override blockchain fee from CLI if provided. Explicit --fee-per-order 0
    // is valid (free-fee account) and must not be dropped by a falsy check.
    if (opts.feePerOrder != null) {
        if (!Number.isFinite(opts.feePerOrder) || opts.feePerOrder < 0) {
            console.error(`Invalid --fee-per-order: ${opts.feePerOrder}`);
            process.exit(1);
        }
        BLOCKCHAIN_FEE_PER_FILL = opts.feePerOrder;
    }

    // Analyze each pair
    const pairMap = new Map<string, TradeFill[]>();
    for (const t of trades) {
        const pairKey = `${t.baseAsset}:${t.quoteAsset}`;
        if (!pairMap.has(pairKey)) pairMap.set(pairKey, []);
        pairMap.get(pairKey)!.push(t);
    }

    const analyses: PairAnalysis[] = [];
    for (const [key, pairTrades] of pairMap) {
        const analysis = analyzePair(pairTrades, opts.matchMode as 'sequential' | 'fifo');
        analyses.push(analysis);

        if (opts.verbose) {
            const [base, quote] = key.split(':');
            console.log(`  ${fmtAsset(base)}/${fmtAsset(quote)}: ${pairTrades.filter(t => t.direction === 'buy').length} buys, ${pairTrades.filter(t => t.direction === 'sell').length} sells, ${analysis.realizedPnls.length} realized lots`);
        }
    }

    // Sort pairs by volume (total quote)
    analyses.sort((a, b) => (b.totalBuyQuote + b.totalSellQuote) - (a.totalBuyQuote + a.totalSellQuote));

    const reportWindow = { startMs: Date.parse(gte), endMs: Date.parse(lte) };

    if (opts.html) {
        // HTML is the primary output of `dexbot pnl`: write the self-contained
        // report and print the file link, skipping the terminal tables.
        const reportPath = opts.report
            ? path.resolve(String(opts.report))
            : path.join(PATHS.ANALYSIS.CHARTS_DIR, reportFileName(opts, String(opts.accountId), resolvedBotName));
        writePnlReport({
            accountRef: String(opts.accountId),
            accountId,
            botName: resolvedBotName,
            start: gte,
            end: lte,
            matchMode: opts.matchMode as 'sequential' | 'fifo',
            pairFilter: opts.pair ? `${(opts.pair as { base: string; quote: string }).base}/${(opts.pair as { base: string; quote: string }).quote}` : null,
            assetFilter: opts.asset,
            pairs: analyses.map(pair => ({ pair, metrics: computeMetrics(pair, reportWindow) })),
        }, reportPath);
        console.log(`\n📄 PnL report saved. Open report: (${toFileUrl(reportPath)})`);
    } else {
        // Output: summaries → grand total → per-match detail
        printSummary(analyses);

        if (opts.showPnlDetail) {
            printPnlDetail(analyses);
        }

        printMetrics(analyses, reportWindow);
    }

    if (opts.csv) {
        exportCsv(analyses, opts.csv);
    }

    if (opts.json) {
        exportJson(accountId, gte, lte, analyses, opts.json);
    }
}

export { analyzePair, classifyFills, computeMetrics, parseArgs, run, reportFileName, TradeFill, FillRecord, PairAnalysis, TradingMetrics };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().then(() => process.exit(0)).catch(e => {
        console.error('\n[fatal]', e.message);
        if (process.env.DEBUG) console.error(e.stack);
        process.exit(1);
    });
}

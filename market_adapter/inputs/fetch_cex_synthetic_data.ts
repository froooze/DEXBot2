#!/usr/bin/env node
'use strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);


/**
 * Probe public CEX APIs for a base/quote cross and synthesize candles from
 * the two legs against a common quote (e.g. XRP/USDT + XAUT/USDT).
 *
 * This is intended as a seed generator for brand-new market_adapter files.
 * It does not rely on TradingView or Kibana.
 */
const { getStorage } = require('../../modules/storage');
const storage = getStorage();
const { fillCandleGaps } = require('../candle_utils');
const { writeJsonAtomic } = require('../utils/atomic_write');
const { parseJsonWithComments } = require('../../modules/order/utils/system');
const { createBotKey } = require('../../modules/account_orders');
const { PATHS } = require('../../modules/paths');
const { MARKET_ADAPTER } = require('../../modules/constants');
const { getAmaWarmupBars } = require('../core/strategies/ama');
const { getErrorMessage } = require('../../modules/utils/errors');
const { isSameBotName } = require('../../modules/utils/sanitize_key');
const { candleFileForBot } = require('../../analysis/bot_key_utils');
const {
    DEFAULTS: MARKET_ADAPTER_DEFAULTS,
    resolveAmaForBot,
    resolveBotCfg,
} = require('../market_adapter');

const DEFAULT_INTERVAL = '1h';
const DEFAULT_LIMIT = 1000;
const DEFAULT_BASE = 'XRP';
const DEFAULT_QUOTE = 'XAUT';
const DEFAULT_COMMON_QUOTE = 'USDT';
const DEFAULT_BOOTSTRAP_LOOKBACK_HOURS = 720;
const DEFAULT_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
import type { BotEntry } from '../../modules/bot_settings.js';
import {
    parseCandleRow,
    parseCandleRows,
    parseHtxObjectRow,
    OHLC_STANDARD,
    OHLC_CLOSE_HIGH_LOW,
    OHLC_GATE,
    OHLC_KRAKEN,
} from './cex_candle_parsing.js';
import type { CandleRow } from './cex_candle_parsing.js';

interface MarketRow {
    base: string;
    quote: string;
    id: string;
    [key: string]: unknown;
}

interface RangeInfo {
    count: number;
    oldestTs: number | null;
    newestTs: number | null;
    spanHours: number;
}

interface CandlesUrlOpts {
    id: string;
    interval: string;
    intervalSeconds?: number;
    limit: number;
    sinceMs: number | null;
    untilMs: number | null;
}

interface ExchangeAdapter {
    name: string;
    maxLimit?: number;
    marketsUrl: string;
    formatInterval: (interval: string) => string;
    candlesUrl: (opts: CandlesUrlOpts) => string;
    parseMarkets: (json: unknown) => MarketRow[];
    parseCandles: (json: unknown) => CandleRow[];
}

interface AmaConfig {
    erPeriod: number;
    fastPeriod: number;
    slowPeriod: number;
}

interface ProbeResult {
    exchangeId: string;
    name?: string;
    error?: string;
    markets?: MarketRow[];
    baseCommon?: MarketRow | null;
    quoteCommon?: MarketRow | null;
    nativeCross?: MarketRow | null;
    baseCandles: CandleRow[];
    quoteCandles: CandleRow[];
    requiredCandles: number;
    probeLookbackHours: number;
    probeCandles: number;
    hasUsableTimeframe?: boolean;
    lookbackSatisfied?: boolean;
    baseRange?: RangeInfo | null;
    quoteRange?: RangeInfo | null;
    availableCandles?: number;
    availableLookbackHours?: number;
}

interface RankedProbe extends ProbeResult {
    score: number;
    depthScore: number;
    preferredRank: number;
    usable: boolean;
}

interface CexConfig {
    exchange: string;
    interval: string;
    limit: number;
    lookbackHours: number | null;
    botName: string | null;
    botsFile: string;
    base: string;
    quote: string;
    commonQuote: string;
    botKey: string | null;
    out: string | null;
    checkOnly: boolean;
    quiet: boolean;
    baseProvided: boolean;
    quoteProvided: boolean;
    help: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

const DEFAULT_EXCHANGES = [
    'bybit',
    'htx',
    'mexc',
];

function upper(value: unknown) {
    return String(value || '').trim().toUpperCase();
}

function lower(value: unknown) {
    return String(value || '').trim().toLowerCase();
}

function parseInterval(raw: unknown): { seconds: number; label: string } {
    const value = String(raw || DEFAULT_INTERVAL).trim().toLowerCase();
    const map: Record<string, { seconds: number; label: string }> = {
        '1m': { seconds: 60, label: '1m' },
        '5m': { seconds: 300, label: '5m' },
        '15m': { seconds: 900, label: '15m' },
        '30m': { seconds: 1800, label: '30m' },
        '1h': { seconds: 3600, label: '1h' },
        '4h': { seconds: 14400, label: '4h' },
        '6h': { seconds: 21600, label: '6h' },
        '12h': { seconds: 43200, label: '12h' },
        '1d': { seconds: 86400, label: '1d' },
        '1w': { seconds: 604800, label: '1w' },
    };

    if (map[value]) return map[value];
    if (/^\d+$/.test(value)) {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes <= 0) {
            throw new Error(`Invalid interval: ${raw}`);
        }
        return { seconds: minutes * 60, label: `${minutes}m` };
    }

    throw new Error(`Unsupported interval: ${raw}`);
}

function loadBotNameIndex(botsFile: string | null | undefined): Array<{ bot: BotEntry; index: number }> {
    try {
        if (!botsFile || !storage.exists(botsFile)) return [];
        const raw = storage.readFile(botsFile, 'utf8');
        if (!raw.trim()) return [];
        const parsed = parseJsonWithComments(raw);
        const bots: unknown[] = Array.isArray(parsed?.bots) ? parsed.bots : [];
        return bots
            .map((bot, index: number) => ({ bot: bot as BotEntry, index }))
            .filter(({ bot }) => bot && typeof bot === 'object' && bot.name);
    } catch (_err) {
        return [];
    }
}

function resolveBotEntryFromIdentity(config: CexConfig): { bot: BotEntry; index: number } | null {
    const botName = String(config.botName || '').trim();
    if (!botName) return null;

    const botsFile = config.botsFile ? String(config.botsFile) : DEFAULT_BOTS_FILE;
    const entries = loadBotNameIndex(botsFile);
    const match = entries.find(({ bot }) => isSameBotName(bot.name, botName));
    return match || null;
}

function resolveBotKeyFromIdentity(config: CexConfig): string | null {
    if (config.botKey) return String(config.botKey).trim();

    const match = resolveBotEntryFromIdentity(config);
    if (match) return createBotKey(match.bot, match.index);

    return null;
}

function normalizeCexAssetSymbol(value: unknown) {
    const raw = upper(value);
    if (!raw) return raw;
    const knownGatewayPrefixes = [
        'IOB.',
        'XBTSX.',
        'BTWTY.',
        'XBTS.',
        'GDEX.',
        'RUDEX.',
        'BRIDGE.',
        'OPEN.',
        'HONEST.',
    ];
    for (const prefix of knownGatewayPrefixes) {
        if (raw.startsWith(prefix) && raw.length > prefix.length) {
            return raw.slice(prefix.length);
        }
    }
    return raw;
}

function resolveBotContextFromIdentity(config: CexConfig) {
    const match = resolveBotEntryFromIdentity(config);
    if (!match) return null;
    return {
        bot: {
            ...match.bot,
            botKey: createBotKey(match.bot, match.index),
        },
        index: match.index,
    };
}

function normalizeBaseAsset(base: unknown, symbol: unknown) {
    const rawBase = upper(base);
    const rawSymbol = upper(symbol);
    const goldMatch = rawBase.match(/^GOLD\(([^)]+)\)$/);
    if (goldMatch && goldMatch[1]) {
        return upper(goldMatch[1]);
    }
    if (rawSymbol.includes('XAUT') && rawBase.includes('GOLD')) {
        return 'XAUT';
    }
    return rawBase;
}

function computeRequiredCandles(amaConfig: AmaConfig | null = null, cfg: { amaSlope?: { lookbackBars?: unknown } } | null = null): number {
    const ama = amaConfig || MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY as keyof typeof MARKET_ADAPTER.AMAS] || MARKET_ADAPTER.AMAS.AMA3;
    if (!ama) return DEFAULT_BOOTSTRAP_LOOKBACK_HOURS;

    const warmupBars = getAmaWarmupBars(
        ama.erPeriod,
        ama.slowPeriod,
        cfg?.amaSlope?.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        ama.fastPeriod
    );
    const analysisKeepCount = warmupBars + 1;
    return Math.max(DEFAULT_BOOTSTRAP_LOOKBACK_HOURS, analysisKeepCount);
}

function candlesToLookbackHours(candleCount: unknown, intervalSeconds: unknown) {
    const candles = Number(candleCount);
    const seconds = Number(intervalSeconds);
    if (!Number.isFinite(candles) || candles <= 0) return 0;
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.ceil((candles * seconds) / 3600);
}

function lookbackHoursToCandles(lookbackHours: unknown, intervalSeconds: unknown) {
    const hours = Number(lookbackHours);
    const seconds = Number(intervalSeconds);
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.ceil((hours * 3600) / seconds);
}

function measureCandles(candles: unknown, intervalSeconds: unknown): RangeInfo {
    const rows = Array.isArray(candles) ? candles.filter((row): row is CandleRow => Array.isArray(row) && Number.isFinite((row as unknown[])[0])) : [];
    if (rows.length === 0) {
        return {
            count: 0,
            oldestTs: null,
            newestTs: null,
            spanHours: 0,
        };
    }
    const sorted = rows.slice().sort((a, b) => a[0] - b[0]);
    const oldestTs = sorted[0][0];
    const newestTs = sorted[sorted.length - 1][0];
    const intervalMs = Math.max(1, Number(intervalSeconds || 3600)) * 1000;
    return {
        count: sorted.length,
        oldestTs,
        newestTs,
        spanHours: ((newestTs - oldestTs) + intervalMs) / 3600000,
    };
}

async function fetchJson(url: string, { headers = {}, timeoutMs = 20000 }: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: {
                'accept': 'application/json',
                'user-agent': 'Mozilla/5.0',
                ...headers,
            },
            signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (_err) {
            json = null;
        }
        return { ok: res.ok, status: res.status, statusText: res.statusText, json, text };
    } finally {
        clearTimeout(timer);
    }
}

function marketRow(base: unknown, quote: unknown, id: unknown, extra: Record<string, unknown> = {}): MarketRow {
    return {
        base: upper(base),
        quote: upper(quote),
        id: String(id),
        ...extra,
    };
}

function extractMarketsFromList(list: unknown, mapper: (row: unknown) => MarketRow): MarketRow[] {
    const rows = asArray(list);
    return rows.map(mapper).filter((row): row is MarketRow => Boolean(row && row.id && row.base && row.quote));
}

// Interval → venue-specific unit tables. Most CEX APIs share one of a few
// shapes; keep one table per shape and compose where a venue overrides a
// single unit (Kraken day/week, MEXC's case-sensitive `1W`).
const INTERVAL_MINUTES: Record<string, string> = {
    '1m': '1',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '4h': '240',
    '6h': '360',
    '12h': '720',
    '1d': 'D',
    '1w': 'W',
};
const INTERVAL_KRAKEN: Record<string, string> = {
    ...INTERVAL_MINUTES,
    '1d': '1440',
    '1w': '10080',
};
const INTERVAL_DURATION: Record<string, string> = {
    '1m': '1min',
    '5m': '5min',
    '15m': '15min',
    '30m': '30min',
    '1h': '1hour',
    '4h': '4hour',
    '6h': '6hour',
    '12h': '12hour',
    '1d': '1day',
    '1w': '1week',
};
const INTERVAL_HTX: Record<string, string> = {
    ...INTERVAL_DURATION,
    '1h': '60min',
};
const INTERVAL_BITGET: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '4h': '4h',
    '6h': '6h',
    '12h': '12h',
    '1d': '1d',
    '1w': '1w',
};
const INTERVAL_MEXC: Record<string, string> = {
    ...INTERVAL_BITGET,
    '1h': '60m',
    // MEXC interval enums are case-sensitive
    '1w': '1W',
};

const intervalFormatter = (map: Record<string, string>) => (interval: string) => map[lower(interval)] || interval;

const EXCHANGES: Record<string, ExchangeAdapter> = {
    binance: {
        name: 'Binance',
        formatInterval: (interval: string) => interval,
        marketsUrl: 'https://api.binance.com/api/v3/exchangeInfo',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }: CandlesUrlOpts) => {
            const url = new URL('https://api.binance.com/api/v3/klines');
            url.searchParams.set('symbol', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('startTime', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('endTime', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(asRecord(json).symbols, (row: unknown) => {
            const r = asRecord(row);
            return marketRow(r.baseAsset, r.quoteAsset, r.symbol, { status: r.status });
        }),
        parseCandles: (json: unknown): CandleRow[] => parseCandleRows(asArray(json), OHLC_STANDARD),
    },
    bybit: {
        name: 'Bybit',
        formatInterval: intervalFormatter(INTERVAL_MINUTES),
        marketsUrl: 'https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }: CandlesUrlOpts) => {
            const url = new URL('https://api.bybit.com/v5/market/kline');
            url.searchParams.set('category', 'spot');
            url.searchParams.set('symbol', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('start', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('end', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(asRecord(asRecord(json).result).list, (row: unknown) => {
            const r = asRecord(row);
            return marketRow(r.baseCoin, r.quoteCoin, r.symbol, { status: r.status });
        }),
        parseCandles: (json: unknown): CandleRow[] => parseCandleRows(asArray(asRecord(asRecord(json).result).list), OHLC_STANDARD),
    },
    gate: {
        name: 'Gate',
        formatInterval: (interval: string) => interval,
        marketsUrl: 'https://api.gateio.ws/api/v4/spot/currency_pairs',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }: CandlesUrlOpts) => {
            const url = new URL('https://api.gateio.ws/api/v4/spot/candlesticks');
            url.searchParams.set('currency_pair', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('from', String(Math.max(0, Math.trunc(sinceMs / 1000))));
            if (untilMs != null) url.searchParams.set('to', String(Math.max(0, Math.trunc(untilMs / 1000))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(json, (row: unknown) => {
            const r = asRecord(row);
            return marketRow(r.base, r.quote, r.id, { tradeStatus: r.trade_status });
        }),
        parseCandles: (json: unknown): CandleRow[] => parseCandleRows(asArray(json), OHLC_GATE),
    },
    bitget: {
        name: 'Bitget',
        formatInterval: intervalFormatter(INTERVAL_BITGET),
        marketsUrl: 'https://api.bitget.com/api/v2/spot/public/symbols',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }: CandlesUrlOpts) => {
            const url = new URL('https://api.bitget.com/api/v2/spot/market/candles');
            url.searchParams.set('symbol', id);
            url.searchParams.set('granularity', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('startTime', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('endTime', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(asRecord(json).data, (row: unknown) => {
            const r = asRecord(row);
            return marketRow(r.baseCoin, r.quoteCoin, r.symbol, { status: r.status });
        }),
        parseCandles: (json: unknown): CandleRow[] => parseCandleRows(asArray(asRecord(json).data), OHLC_STANDARD),
    },
    kucoin: {
        name: 'KuCoin',
        formatInterval: intervalFormatter(INTERVAL_DURATION),
        marketsUrl: 'https://api.kucoin.com/api/v2/symbols',
        candlesUrl: ({ id, interval, sinceMs, untilMs }: CandlesUrlOpts) => {
            const url = new URL('https://api.kucoin.com/api/v1/market/candles');
            url.searchParams.set('symbol', id);
            url.searchParams.set('type', interval);
            if (sinceMs != null) url.searchParams.set('startAt', String(Math.max(0, Math.trunc(sinceMs / 1000))));
            if (untilMs != null) url.searchParams.set('endAt', String(Math.max(0, Math.trunc(untilMs / 1000))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(asRecord(json).data, (row: unknown) => {
            const r = asRecord(row);
            return marketRow(r.baseCurrency, r.quoteCurrency, r.symbol, { enableTrading: r.enableTrading });
        }),
        parseCandles: (json: unknown): CandleRow[] => parseCandleRows(asArray(asRecord(json).data), OHLC_CLOSE_HIGH_LOW),
    },
    htx: {
        name: 'HTX',
        formatInterval: intervalFormatter(INTERVAL_HTX),
        marketsUrl: 'https://api.htx.com/v1/common/symbols',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }: CandlesUrlOpts) => {
            // Official Huobi/HTX spot historical kline endpoint is /market/history/kline
            const url = new URL('https://api.htx.com/market/history/kline');
            url.searchParams.set('symbol', id);
            url.searchParams.set('period', interval);
            url.searchParams.set('size', String(limit));
            if (sinceMs != null) url.searchParams.set('from', String(Math.max(0, Math.trunc(sinceMs / 1000))));
            if (untilMs != null) url.searchParams.set('to', String(Math.max(0, Math.trunc(untilMs / 1000))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(Array.isArray(asRecord(json).data) ? asRecord(json).data : json, (row: unknown) => {
            const r = asRecord(row);
            const base = r.baseCurrency || r['base-currency'] || r.base_currency;
            const quote = r.quoteCurrency || r['quote-currency'] || r.quote_currency;
            const id = r.symbol || r['symbol'];
            return marketRow(base, quote, id, { state: r.state });
        }),
        parseCandles: (json: unknown): CandleRow[] => {
            const data = asRecord(json).data;
            const rows = Array.isArray(data) ? data as unknown[] : asArray(json);
            return rows
                .map((row) => (Array.isArray(row) ? parseCandleRow(row, OHLC_CLOSE_HIGH_LOW) : parseHtxObjectRow(row)))
                .filter((x): x is CandleRow => x != null)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    kraken: {
        name: 'Kraken',
        formatInterval: intervalFormatter(INTERVAL_KRAKEN),
        marketsUrl: 'https://api.kraken.com/0/public/AssetPairs',
        candlesUrl: ({ id, interval, intervalSeconds, limit, sinceMs }: CandlesUrlOpts) => {
            const url = new URL('https://api.kraken.com/0/public/OHLC');
            url.searchParams.set('pair', id);
            url.searchParams.set('interval', interval);
            const since = sinceMs != null ? Math.max(0, Math.floor(sinceMs / 1000) - Math.max(1, Math.floor(Number(intervalSeconds || 3600)))) : Math.max(0, Math.floor(Date.now() / 1000) - Math.floor((Number(limit) || DEFAULT_LIMIT) * Number(intervalSeconds || 3600)));
            url.searchParams.set('since', String(since));
            return url.toString();
        },
        parseMarkets: (json: unknown) => {
            const entries = Object.entries(asRecord(asRecord(json).result));
            return entries.map(([key, row]) => {
                const r = asRecord(row);
                const ws = String(r.wsname || '').toUpperCase();
                const [baseFromWs, quoteFromWs] = ws.includes('/') ? ws.split('/') : [null, null];
                const base = baseFromWs || upper(r.base);
                const quote = quoteFromWs || upper(r.quote);
                const id = r.altname || key;
                return marketRow(base, quote, id, { wsname: r.wsname });
            }).filter((row): row is MarketRow => Boolean(row.id && row.base && row.quote));
        },
        parseCandles: (json: unknown): CandleRow[] => {
            const result = asRecord(asRecord(json).result);
            const pairKey: string | undefined = Object.keys(result).find((key) => key !== 'last');
            if (!pairKey) return [];
            return parseCandleRows(asArray(result[pairKey]), OHLC_KRAKEN);
        },
    },
    okx: {
        name: 'OKX',
        // /api/v5/market/candles caps limit at CEX_PAGE_LIMIT_CAPS.okx per request
        maxLimit: MARKET_ADAPTER.CEX_PAGE_LIMIT_CAPS.okx,
        formatInterval: intervalFormatter(INTERVAL_MINUTES),
        marketsUrl: 'https://www.okx.com/api/v5/public/instruments?instType=SPOT',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }: CandlesUrlOpts) => {
            const url = new URL('https://www.okx.com/api/v5/market/candles');
            url.searchParams.set('instId', id);
            url.searchParams.set('bar', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('before', String(Math.max(0, Math.trunc(sinceMs - 1))));
            if (untilMs != null) url.searchParams.set('after', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(asRecord(json).data, (row: unknown) => {
            const r = asRecord(row);
            return marketRow(r.baseCcy, r.quoteCcy, r.instId, { state: r.state });
        }),
        parseCandles: (json: unknown): CandleRow[] => parseCandleRows(asArray(asRecord(json).data), OHLC_STANDARD),
    },
    mexc: {
        name: 'MEXC',
        // /api/v3/klines caps limit at CEX_PAGE_LIMIT_CAPS.mexc per request
        maxLimit: MARKET_ADAPTER.CEX_PAGE_LIMIT_CAPS.mexc,
        formatInterval: intervalFormatter(INTERVAL_MEXC),
        marketsUrl: 'https://api.mexc.com/api/v3/exchangeInfo',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }: CandlesUrlOpts) => {
            const url = new URL('https://api.mexc.com/api/v3/klines');
            url.searchParams.set('symbol', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('startTime', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('endTime', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json: unknown) => extractMarketsFromList(asRecord(json).symbols, (row: unknown) => {
            const r = asRecord(row);
            return marketRow(normalizeBaseAsset(r.baseAsset, r.symbol), r.quoteAsset, r.symbol, { status: r.status });
        }),
        parseCandles: (json: unknown): CandleRow[] => parseCandleRows(asArray(json), OHLC_STANDARD),
    },
};

function parseArgs(): CexConfig {
    const args = process.argv.slice(2);
    const config: CexConfig = {
        exchange: 'auto',
        interval: DEFAULT_INTERVAL,
        limit: DEFAULT_LIMIT,
        lookbackHours: null,
        botName: null,
        botsFile: DEFAULT_BOTS_FILE,
        base: DEFAULT_BASE,
        quote: DEFAULT_QUOTE,
        commonQuote: DEFAULT_COMMON_QUOTE,
        botKey: null,
        out: null,
        checkOnly: false,
        quiet: false,
        baseProvided: false,
        quoteProvided: false,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        switch (arg) {
            case '--exchange':
                config.exchange = next;
                i++;
                break;
            case '--interval':
                config.interval = next;
                i++;
                break;
            case '--limit':
                config.limit = Number(next);
                i++;
                break;
            case '--lookback-hours':
            case '--lookbackHours':
                config.lookbackHours = Number(next);
                i++;
                break;
            case '--base':
            case '--base-asset':
                config.base = next;
                config.baseProvided = true;
                i++;
                break;
            case '--quote':
            case '--quote-asset':
                config.quote = next;
                config.quoteProvided = true;
                i++;
                break;
            case '--common-quote':
            case '--commonQuote':
                config.commonQuote = next;
                i++;
                break;
            case '--bot-key':
                config.botKey = next;
                i++;
                break;
            case '--bot-name':
                config.botName = next;
                i++;
                break;
            case '--bots-file':
                config.botsFile = next;
                i++;
                break;
            case '--out':
                config.out = next;
                i++;
                break;
            case '--check':
            case '--check-only':
                config.checkOnly = true;
                break;
            case '--quiet':
                config.quiet = true;
                break;
            case '--help':
            case '-h':
                config.help = true;
                break;
        }
    }

    return config;
}

function applyBotDerivedConfig(config: CexConfig): { config: CexConfig; botContext: { bot: BotEntry & { botKey: string }; index: number } | null; botCfg: { amaSlope?: { lookbackBars?: unknown } } | null; botAma: AmaConfig | null } {
    const botContext = resolveBotContextFromIdentity(config);
    if (!botContext) {
        if (config.botName) {
            throw new Error(`Could not resolve bot name "${config.botName}" in ${config.botsFile || DEFAULT_BOTS_FILE}`);
        }
        return { config, botContext: null, botCfg: null, botAma: null };
    }

    const next = { ...config };
    if (!next.baseProvided && botContext.bot.assetA) {
        next.base = normalizeCexAssetSymbol(botContext.bot.assetA);
    }
    if (!next.quoteProvided && botContext.bot.assetB) {
        next.quote = normalizeCexAssetSymbol(botContext.bot.assetB);
    }

    const botCfg = resolveBotCfg(botContext.bot, MARKET_ADAPTER_DEFAULTS);
    const botAma = resolveAmaForBot(botContext.bot, null, botCfg);

    return { config: next, botContext, botCfg, botAma };
}

function printHelp() {
    console.log(`Usage:
  node dist/market_adapter/inputs/fetch_cex_synthetic_data.js [options]

Options:
  --exchange <name|auto>   Exchange to use or comma-separated preference list
  --interval <label>       Candle interval (1m|5m|15m|30m|1h|4h|6h|12h|1d|1w, or bare
                           minutes like \`90\` = 90m), default ${DEFAULT_INTERVAL}
  --limit <n>              Number of candles to fetch from each leg, default ${DEFAULT_LIMIT}
  --lookback-hours <n>     Probe depth in hours; default is the adapter seed requirement
  --base <asset>           Base asset, default ${DEFAULT_BASE}
  --quote <asset>          Synthetic quote asset, default ${DEFAULT_QUOTE}
  --common-quote <asset>   Common quote asset, default ${DEFAULT_COMMON_QUOTE}
  --bot-key <key>          Default output becomes market_adapter/data/market_adapter_<key>_<interval>.json
  --bot-name <bot>        Resolve the output key from profiles/bots.json by bot name
  --bots-file <path>       Alternate bots.json file for resolving --bot-name
  --out <file>             Write to an explicit path
  --check-only             Probe markets and candle endpoints without writing output
  --quiet                  Suppress the summary table
`);
}

function normalizeExchangeList(raw: unknown): string[] {
    const list = String(raw || 'auto')
        .split(',')
        .map((item) => lower(item))
        .filter(Boolean);
    if (list.length === 0 || (list.length === 1 && list[0] === 'auto')) {
        return DEFAULT_EXCHANGES.slice();
    }
    return list;
}

function findMarketId(markets: MarketRow[], base: unknown, quote: unknown): MarketRow | null {
    const targetBase = upper(base);
    const targetQuote = upper(quote);
    const market = markets.find((row) => upper(row.base) === targetBase && upper(row.quote) === targetQuote);
    return market || null;
}

function buildSyntheticCandle(left: unknown, right: unknown): CandleRow | null {
    // Guard against degenerate zero/negative leg prices: dividing by them
    // would produce Infinity/NaN OHLC rows in the seed file.
    const l = asArray(left).map(Number);
    const r = asArray(right).map(Number);
    const leftPrices = [l[1], l[2], l[3], l[4]];
    const rightPrices = [r[1], r[2], r[3], r[4]];
    if (!leftPrices.every((v) => Number.isFinite(v) && v > 0)
        || !rightPrices.every((v) => Number.isFinite(v) && v > 0)) {
        return null;
    }
    const open = l[1] / r[1];
    const close = l[4] / r[4];
    const high = Math.max(l[2] / r[3], open, close);
    const low = Math.min(l[3] / r[2], open, close);
    if (![open, high, low, close].every(Number.isFinite)) return null;
    const volume = Number(l[5] || 0);
    return [l[0], open, high, low, close, Number.isFinite(volume) ? volume : 0];
}

function synthesizeCrossCandles(leftCandles: CandleRow[], rightCandles: CandleRow[]): CandleRow[] {
    const leftMap = new Map<number, CandleRow>(leftCandles.map((row) => [row[0], row] as [number, CandleRow]));
    const rightMap = new Map<number, CandleRow>(rightCandles.map((row) => [row[0], row] as [number, CandleRow]));
    const timestamps = Array.from(leftMap.keys()).filter((ts) => rightMap.has(ts)).sort((a, b) => a - b);
    return timestamps
        .map((ts) => buildSyntheticCandle(leftMap.get(ts), rightMap.get(ts)))
        .filter((row): row is CandleRow => row != null);
}

function chooseOutputPath(config: CexConfig, intervalLabel: string): string {
    if (config.out) return config.out;
    const botKey = resolveBotKeyFromIdentity(config);
    if (!botKey) {
        if (config.botName) {
            throw new Error(`Could not resolve bot name "${config.botName}" in ${config.botsFile || DEFAULT_BOTS_FILE}`);
        }
        throw new Error('Provide --bot-key or --out when generating candles');
    }
    return candleFileForBot(botKey, intervalLabel);
}

function dedupeCandles(candles: unknown): CandleRow[] {
    const map = new Map<number, CandleRow>();
    for (const candle of asArray(candles)) {
        if (!Array.isArray(candle) || !Number.isFinite((candle as unknown[])[0])) continue;
        const row = candle as CandleRow;
        map.set(row[0], row);
    }
    return [...map.values()].sort((a, b) => a[0] - b[0]);
}

async function fetchHistoricalCandles(def: ExchangeAdapter, marketId: string, interval: string, intervalSeconds: number, lookbackHours: number, pageLimit: number): Promise<CandleRow[]> {
    const apiInterval = def.formatInterval ? def.formatInterval(interval) : interval;
    // Respect the exchange's per-request page cap (e.g. OKX 300, MEXC 500)
    const effectivePageLimit = Math.max(1, Math.min(Number(pageLimit) || DEFAULT_LIMIT, Number(def.maxLimit) || Infinity));
    const intervalMs = Math.max(1, Number(intervalSeconds || 3600)) * 1000;
    const endMs = Math.floor(Date.now() / intervalMs) * intervalMs;
    const lookbackMs = Math.max(1, Number(lookbackHours || DEFAULT_BOOTSTRAP_LOOKBACK_HOURS)) * 3600 * 1000;
    const startMs = Math.max(0, endMs - lookbackMs);
    const maxIterations = Math.ceil(lookbackMs / Math.max(intervalMs, effectivePageLimit * intervalMs * 0.8)) + 8;
    let cursor = startMs;
    let collected: CandleRow[] = [];

    for (let i = 0; i < maxIterations && cursor <= endMs; i++) {
        const pageEnd = Math.min(endMs, cursor + intervalMs * Math.max(1, effectivePageLimit - 1));
        const res = await fetchJson(def.candlesUrl({
            id: marketId,
            interval: apiInterval,
            intervalSeconds,
            limit: effectivePageLimit,
            sinceMs: cursor,
            untilMs: pageEnd,
        }));
        if (!res.ok || !res.json) {
            console.warn(`[CEX] ${def.name}: HTTP ${res.status} ${res.statusText} at cursor=${cursor} — skipping page`);
            break;
        }

        const page = def.parseCandles(res.json);
        if (!Array.isArray(page) || page.length === 0) {
            break;
        }
        collected = collected.concat(page);

        const lastTs = page[page.length - 1][0];
        if (!Number.isFinite(lastTs) || lastTs <= cursor) {
            break;
        }

        cursor = lastTs + intervalMs;
        if (cursor > endMs) {
            break;
        }

        if (i < maxIterations - 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, MARKET_ADAPTER.CEX_API_DELAY_MS));
        }
    }

    return dedupeCandles(collected);
}

async function probeExchange(exchangeId: string, base: string, quote: string, commonQuote: string, interval: string, intervalSeconds: number, requiredCandles: number, probeLookbackHours: number, pageLimit: number): Promise<ProbeResult> {
    const def = EXCHANGES[exchangeId];
    if (!def) {
        return { exchangeId, error: `Unknown exchange: ${exchangeId}`, baseCandles: [], quoteCandles: [], requiredCandles, probeLookbackHours, probeCandles: 0 };
    }

    try {
        const marketsRes = await fetchJson(def.marketsUrl);
        if (!marketsRes.ok || !marketsRes.json) {
            return {
                exchangeId,
                name: def.name,
                error: `markets HTTP ${marketsRes.status} ${marketsRes.statusText}`.trim(),
                baseCandles: [],
                quoteCandles: [],
                requiredCandles,
                probeLookbackHours,
                probeCandles: 0,
            };
        }

        const markets = def.parseMarkets(marketsRes.json);
        const baseCommon = findMarketId(markets, base, commonQuote);
        const quoteCommon = findMarketId(markets, quote, commonQuote);
        const nativeCross = findMarketId(markets, base, quote);

        const result: ProbeResult = {
            exchangeId,
            name: def.name,
            markets,
            baseCommon,
            quoteCommon,
            nativeCross,
            baseCandles: [],
            quoteCandles: [],
            requiredCandles,
            probeLookbackHours,
            probeCandles: lookbackHoursToCandles(probeLookbackHours, intervalSeconds),
        };
        if (baseCommon && quoteCommon) {
            result.baseCandles = await fetchHistoricalCandles(def, baseCommon.id, interval, intervalSeconds, probeLookbackHours, pageLimit);
            result.quoteCandles = await fetchHistoricalCandles(def, quoteCommon.id, interval, intervalSeconds, probeLookbackHours, pageLimit);
            result.hasUsableTimeframe = result.baseCandles.length > 0 && result.quoteCandles.length > 0;
            result.lookbackSatisfied = result.baseCandles.length >= result.requiredCandles
                && result.quoteCandles.length >= result.requiredCandles;
            result.baseRange = measureCandles(result.baseCandles, intervalSeconds);
            result.quoteRange = measureCandles(result.quoteCandles, intervalSeconds);
            result.availableCandles = Math.min(result.baseRange.count, result.quoteRange.count);
            result.availableLookbackHours = Math.min(result.baseRange.spanHours, result.quoteRange.spanHours);
        }

        return result;
    } catch (err) {
        return {
            exchangeId,
            name: def.name,
            error: getErrorMessage(err),
            baseCandles: [],
            quoteCandles: [],
            requiredCandles,
            probeLookbackHours,
            probeCandles: 0,
        };
    }
}

function pickBestExchange(probes: ProbeResult[], preferredExchangeIds: string[]): RankedProbe | null {
    const preferred = preferredExchangeIds.map((id) => lower(id));
    const ranked = rankProbes(probes, preferred, true);
    return ranked[0] || null;
}

function rankProbes(probes: ProbeResult[], preferredExchangeIds: string[], onlyUsable = false): RankedProbe[] {
    const preferred = preferredExchangeIds.map((id) => lower(id));
    return probes
        .filter((probe) => Boolean(probe && !probe.error && probe.baseCommon && probe.quoteCommon && probe.hasUsableTimeframe))
        .map((probe) => ({
            ...probe,
            score: Math.min(probe.baseRange?.count || 0, probe.quoteRange?.count || 0),
            depthScore: Math.min(probe.baseRange?.spanHours || 0, probe.quoteRange?.spanHours || 0),
            preferredRank: preferred.length > 0 ? preferred.indexOf(lower(probe.exchangeId)) : -1,
            usable: Boolean(probe.lookbackSatisfied),
        }))
        .filter((probe) => (onlyUsable ? probe.usable : true))
        .sort((a, b) => {
            if (a.usable !== b.usable) return a.usable ? -1 : 1;
            if (b.depthScore !== a.depthScore) return b.depthScore - a.depthScore;
            if (b.score !== a.score) return b.score - a.score;
            if (a.preferredRank >= 0 && b.preferredRank >= 0 && a.preferredRank !== b.preferredRank) {
                return a.preferredRank - b.preferredRank;
            }
            if (a.preferredRank >= 0 && b.preferredRank < 0) return -1;
            if (a.preferredRank < 0 && b.preferredRank >= 0) return 1;
            return a.exchangeId.localeCompare(b.exchangeId);
        });
}

function printSummary(probes: RankedProbe[], base: unknown, quote: unknown, commonQuote: unknown): void {
    const rows = probes.map((probe, index) => {
        const baseLeg = probe.baseCommon ? `yes (${probe.baseCommon.id})` : 'no';
        const quoteLeg = probe.quoteCommon ? `yes (${probe.quoteCommon.id})` : 'no';
        const cross = probe.nativeCross ? `yes (${probe.nativeCross.id})` : 'no';
        const candleState = probe.error
            ? `error: ${probe.error}`
            : `${probe.baseRange?.count || 0}/${probe.quoteRange?.count || 0} candles`;
        const usable = (!probe.error && probe.baseCommon && probe.quoteCommon && probe.lookbackSatisfied) ? 'yes' : 'no';
        const depth = probe.error
            ? '-'
            : `${(probe.availableLookbackHours || 0).toFixed(1)}h`;
        return {
            rank: index + 1,
            exchange: probe.exchangeId,
            name: probe.name || probe.exchangeId,
            baseLeg,
            quoteLeg,
            cross,
            usable,
            required: `${probe.requiredCandles || '?'} candles`,
            observed: depth,
            lookback: probe.lookbackSatisfied ? 'ok' : `need ${probe.requiredCandles || '?'} candles`,
            candles: candleState,
        };
    });

    console.table(rows);
    console.log(`Target: ${upper(base)}/${upper(quote)} from ${upper(base)}/${upper(commonQuote)} and ${upper(quote)}/${upper(commonQuote)}`);
}

async function main() {
    const parsedConfig = parseArgs();
    // Handle --help before bot-derived resolution so a typo'd --bot-name does
    // not crash instead of printing usage.
    if ((parsedConfig as unknown as { config?: { help?: boolean } }).config?.help) {
        printHelp();
        return;
    }
    const {
        config,
        botContext,
        botCfg,
        botAma,
    } = applyBotDerivedConfig(parsedConfig);

    const { seconds: intervalSeconds, label: intervalLabel } = parseInterval(config.interval);
    const requiredCandles = computeRequiredCandles(botAma, botCfg);
    const probeLookbackHours = Number.isFinite(Number(config.lookbackHours)) && Number(config.lookbackHours) > 0
        ? Number(config.lookbackHours)
        : candlesToLookbackHours(requiredCandles, intervalSeconds);
    const pageLimit = Number.isFinite(Number(config.limit)) && Number(config.limit) > 0
        ? Math.min(DEFAULT_LIMIT, Math.trunc(Number(config.limit)))
        : DEFAULT_LIMIT;
    const preferredExchangeIds = normalizeExchangeList(config.exchange);

    const probes: ProbeResult[] = [];
    for (const exchangeId of preferredExchangeIds) {
        if (!EXCHANGES[exchangeId]) continue;
        probes.push(await probeExchange(exchangeId, config.base, config.quote, config.commonQuote, config.interval, intervalSeconds, requiredCandles, probeLookbackHours, pageLimit));
    }

    const rankedProbes = rankProbes(probes, preferredExchangeIds, false);
    if (!config.quiet) {
        printSummary(rankedProbes, config.base, config.quote, config.commonQuote);
    }

    if (config.checkOnly) {
        return;
    }

    const forcedExchange = lower(config.exchange) !== 'auto' && preferredExchangeIds.length === 1
        ? preferredExchangeIds[0]
        : null;
    const selected = forcedExchange
        ? rankedProbes.find((probe) => probe.exchangeId === forcedExchange && probe.lookbackSatisfied)
        : pickBestExchange(probes, preferredExchangeIds);

    if (!selected) {
        throw new Error('No exchange found that exposes both leg markets and enough lookback depth');
    }

    const def = EXCHANGES[selected.exchangeId];
    const baseMarket = selected.baseCommon;
    const quoteMarket = selected.quoteCommon;
    const baseCandles = selected.baseCandles;
    const quoteCandles = selected.quoteCandles;

    if (baseCandles.length === 0 || quoteCandles.length === 0) {
        throw new Error(`Selected exchange ${selected.exchangeId} returned no candles for one of the legs`);
    }

    const synthetic = synthesizeCrossCandles(baseCandles, quoteCandles);
    if (synthetic.length === 0) {
        throw new Error(`Selected exchange ${selected.exchangeId} produced no overlapping synthetic candles`);
    }
    const firstTs = synthetic[0][0];
    const lastTs = synthetic[synthetic.length - 1][0];
    const filled = fillCandleGaps(
        synthetic,
        intervalSeconds,
        firstTs,
        lastTs,
        { baselinePrice: synthetic[0][4] }
    );
    if (filled.length < selected.requiredCandles) {
        throw new Error(`Selected exchange ${selected.exchangeId} produced only ${filled.length} synthetic candles; need at least ${selected.requiredCandles}`);
    }

    const outPath = chooseOutputPath(config, intervalLabel);
    const payload = {
        meta: {
            source: 'cex-synthetic',
            exchange: selected.exchangeId,
            exchangeName: def.name,
            baseAsset: upper(config.base),
            quoteAsset: upper(config.quote),
            commonQuote: upper(config.commonQuote),
            sourcePairs: {
                baseLeg: `${upper(config.base)}/${upper(config.commonQuote)}`,
                quoteLeg: `${upper(config.quote)}/${upper(config.commonQuote)}`,
            },
            interval: intervalLabel,
            intervalSeconds,
            requiredCandles,
            amaConfigSource: botAma && botContext ? 'bot-effective' : 'default',
            amaConfig: botAma ? {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
            } : null,
            bot: botContext ? {
                name: botContext.bot.name || null,
                botKey: botContext.bot.botKey || null,
                assetA: botContext.bot.assetA || null,
                assetB: botContext.bot.assetB || null,
            } : null,
            probeLookbackHours,
            requiredSeedCandles: selected.requiredCandles,
            observedCandles: selected.availableCandles,
            observedLookbackHours: Number(selected.availableLookbackHours?.toFixed?.(2) || 0),
            pageLimit,
            volumeBasis: upper(config.base),
            format: '[timestamp_ms, open, high, low, close, volume]',
            fetchedAt: new Date().toISOString(),
        },
        candles: filled,
    };

    writeJsonAtomic(outPath, payload);
    if (!config.quiet) {
        console.log(`Wrote ${filled.length} synthetic candles to ${outPath}`);
        console.log(`Source: ${selected.exchangeId} (${def.name})`);
        console.log(`Legs: ${baseMarket?.id ?? '?'} and ${quoteMarket?.id ?? '?'}`);
        console.log(`Output pair: ${upper(config.base)}/${upper(config.quote)}`);
    }
}

main().catch((err: unknown) => {
    const e = err as { stack?: unknown; message?: unknown } | null | undefined;
    console.error(e?.stack || e?.message || String(err));
    process.exit(1);
});

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../modules/paths.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON, writeJSON } = getStorage();
import { parseJsonWithComments } from '../modules/order/utils/system.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { loadMarketProfiles } from './tradingview/tradingview_uplot_chart_generator.js';
import { isSameBotName, sanitizeKey } from '../modules/utils/sanitize_key.js';
import { isSameAssetSymbol, canonicalizeBotAssetSymbols } from '../modules/utils/asset_symbols.js';
// Single source of truth for bot keys (named AND unnamed bots) so analysis
// tools resolve the same files production writes.
import { createBotKey } from '../modules/account_orders.js';


const DEFAULT_AMA_KEY = String(MARKET_ADAPTER.DEFAULT_AMA_KEY).toUpperCase();
const BUILTIN_AMAS = MARKET_ADAPTER.AMAS as Record<string, typeof MARKET_ADAPTER.AMAS.AMA1>;
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);

type BotEntry = Record<string, unknown>;

interface AmaConfig {
    erPeriod: number;
    fastPeriod: number;
    slowPeriod: number;
}

function loadBotSettings(filePath = PATHS.PROFILES.BOTS_JSON): { bots?: BotEntry[] } | null {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return readJSON(filePath);
    } catch (_) {
        // The bot editor reads/writes through a comment-tolerant parser, so
        // operator comments may legally exist — fall back before giving up.
        try {
            return parseJsonWithComments(fs.readFileSync(filePath, 'utf8'));
        } catch (_) {
            return null;
        }
    }
}

function computeBotKey(bot: unknown, index: number): string {
    // Delegate to the production key generator (modules/account_orders.ts):
    // named bots → sanitized name; unnamed bots → sanitized asset pair + index.
    // The previous local fallback produced `bot-<idx>-<idx>` keys that could
    // never match what the bot runtime actually wrote to disk.
    return createBotKey(bot as BotEntry | null | undefined, index);
}

function resolveBotKey(botName: unknown, filePath = PATHS.PROFILES.BOTS_JSON): string | null {
    if (!botName) return null;
    const settings = loadBotSettings(filePath);
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    const sanitized = sanitizeKey(botName);
    const entry = entries.find((b) => sanitizeKey(b.name) === sanitized);
    if (!entry) return null;
    return computeBotKey(entry, entries.indexOf(entry));
}

function candleFileForBot(botKey: string, intervalLabel: string, dataDir = PATHS.MARKET_ADAPTER.DATA_DIR) {
    return path.join(dataDir, `market_adapter_${botKey}_${intervalLabel}.json`);
}

function resolveCandleFile(botKey: string, intervalLabel: string, dataDir = PATHS.MARKET_ADAPTER.DATA_DIR, botsFile = PATHS.PROFILES.BOTS_JSON) {
    const directPath = candleFileForBot(botKey, intervalLabel, dataDir);
    if (fs.existsSync(directPath)) return directPath;
    const resolved = resolveBotKey(botKey, botsFile);
    if (resolved) {
        const resolvedPath = candleFileForBot(resolved, intervalLabel, dataDir);
        if (fs.existsSync(resolvedPath)) return resolvedPath;
    }
    return null;
}

function loadBotMeta(botKey: unknown, filePath = PATHS.PROFILES.BOTS_JSON): BotEntry | null {
    const settings = loadBotSettings(filePath);
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    if (!botKey) return null;
    const normalizedKey = String(botKey).toLowerCase();
    // Analysis-side twin of modules/bot_settings.normalizeBotEntry: hand out
    // the pair in BitShares' canonical UPPERCASE so a hand-edited lowercase
    // bots.json cannot leak into titles, overlays or symbol comparisons. The
    // same single definition of the symbol-carrying keys is reused (no second
    // copy of the rule), and persistBotAccountId patches the raw file by
    // index, so nothing here can rewrite the operator's JSON.
    const exact = entries.find((bot, index) => computeBotKey(bot, index) === normalizedKey);
    if (exact) return canonicalizeBotAssetSymbols(exact);
    const loose = entries.find((bot) => sanitizeKey(bot?.name) === normalizedKey.replace(/-\d+$/, ''));
    return loose ? canonicalizeBotAssetSymbols(loose) : null;
}

/**
 * Locate the source span of the entryIndex-th object literal inside the
 * top-level "bots" array of a (possibly comment-bearing) JSON document.
 * Strings and // + block comments are skipped while scanning, so braces
 * inside them never disturb the balance count. Returns null when the
 * document shape is unexpected — callers fall back to a full rewrite.
 */
function findBotsEntrySpan(raw: string, entryIndex: number): { start: number; end: number } | null {
    const m = /"bots"\s*:\s*\[/.exec(raw);
    if (!m) return null;
    let i = m.index + m[0].length; // just past '['
    const n = raw.length;
    let count = 0;
    const skipWsComments = () => {
        while (i < n) {
            const c = raw[i];
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
            if (c === '/' && raw[i + 1] === '/') { while (i < n && raw[i] !== '\n') i++; continue; }
            if (c === '/' && raw[i + 1] === '*') { i += 2; while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; continue; }
            break;
        }
    };
    const skipString = () => {
        const q = raw[i];
        i++;
        while (i < n) {
            const c = raw[i];
            if (c === '\\') { i += 2; continue; }
            if (c === q) { i++; return; }
            i++;
        }
    };
    // Skip one JSON value starting at raw[i]; false on malformed input.
    const skipValue = (): boolean => {
        skipWsComments();
        if (i >= n) return false;
        const c = raw[i];
        if (c === '"' || c === "'") { skipString(); return true; }
        if (c === '{' || c === '[') {
            const open = c;
            const close = c === '{' ? '}' : ']';
            i++;
            let depth = 1;
            while (i < n && depth > 0) {
                const d = raw[i];
                if (d === '"' || d === "'") { skipString(); continue; }
                if (d === '/' && raw[i + 1] === '/') { while (i < n && raw[i] !== '\n') i++; continue; }
                if (d === '/' && raw[i + 1] === '*') { i += 2; while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; continue; }
                if (d === open) depth++;
                else if (d === close) depth--;
                i++;
            }
            return depth === 0;
        }
        while (i < n && raw[i] !== ',' && raw[i] !== ']' && raw[i] !== '}') i++;
        return true;
    };
    for (;;) {
        skipWsComments();
        if (i >= n) return null;
        if (raw[i] === ']') return null; // array ended before entryIndex
        if (raw[i] === '{') {
            const start = i;
            if (!skipValue()) return null;
            if (count === entryIndex) return { start, end: i };
            count++;
        } else if (!skipValue()) {
            return null;
        }
        skipWsComments();
        if (i < n && raw[i] === ',') { i++; continue; }
        if (i < n && raw[i] === ']') return null;
        return null; // malformed separator
    }
}

/**
 * Locate the string value of a top-level key inside one bot-entry source
 * span. Unlike a regex, this scan skips over // and block comments as well
 * as string literals, so a key-looking fragment inside a comment (e.g.
 * `// "accountId": "1.2.9999" (old)`) can never be mistaken for the real
 * key. Returns the span of the quoted value (including quotes), or null
 * when the key is absent or its value is not a string.
 */
function findEntryKeyValueSpan(entrySrc: string, key: string): { valueStart: number; valueEnd: number } | null {
    const n = entrySrc.length;
    const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    let i = 0;
    let depth = 0;
    while (i < n) {
        const c = entrySrc[i];
        if (isWs(c)) { i++; continue; }
        if (c === '/' && entrySrc[i + 1] === '/') { while (i < n && entrySrc[i] !== '\n') i++; continue; }
        if (c === '/' && entrySrc[i + 1] === '*') { i += 2; while (i < n && !(entrySrc[i] === '*' && entrySrc[i + 1] === '/')) i++; i += 2; continue; }
        if (c === '{' || c === '[') { depth++; i++; continue; }
        if (c === '}' || c === ']') { depth--; i++; continue; }
        if (c !== '"') { i++; continue; }
        // String literal: read it (honoring backslash escapes).
        let j = i + 1;
        let str = '';
        while (j < n) {
            const d = entrySrc[j];
            if (d === '\\') { str += entrySrc.slice(j, j + 2); j += 2; continue; }
            if (d === '"') break;
            str += d; j++;
        }
        if (j >= n) return null;
        const closingQuote = j;
        if (depth !== 1 || str !== key) { i = closingQuote + 1; continue; }
        // Candidate key at top level: expect `:` then a quoted value.
        let k = closingQuote + 1;
        while (k < n && isWs(entrySrc[k])) k++;
        if (entrySrc[k] !== ':') { i = closingQuote + 1; continue; }
        k++;
        while (k < n && isWs(entrySrc[k])) k++;
        if (entrySrc[k] !== '"') { i = closingQuote + 1; continue; }
        let m = k + 1;
        while (m < n) {
            const e = entrySrc[m];
            if (e === '\\') { m += 2; continue; }
            if (e === '"') return { valueStart: k, valueEnd: m + 1 };
            m++;
        }
        return null;
    }
    return null;
}

/**
 * Byte-preserving accountId update: replaces the value in place, or inserts
 * `"accountId"` right after `"preferredAccount"` keeping the line indent, so
 * comments, key order and formatting elsewhere in the file survive. The
 * patched document is re-parsed (comments allowed) and the value asserted
 * before the atomic tmp+rename write. Returns false on any uncertainty —
 * callers fall back to a full rewrite.
 */
function patchAccountIdInRaw(filePath: string, entryIndex: number, accountId: string): boolean {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        return false;
    }
    const span = findBotsEntrySpan(raw, entryIndex);
    if (!span) return false;
    const entrySrc = raw.slice(span.start, span.end);
    let patchedEntry: string | null = null;
    const idSpan = findEntryKeyValueSpan(entrySrc, 'accountId');
    if (idSpan) {
        patchedEntry = entrySrc.slice(0, idSpan.valueStart)
            + `"${accountId}"`
            + entrySrc.slice(idSpan.valueEnd);
    } else {
        const prefSpan = findEntryKeyValueSpan(entrySrc, 'preferredAccount');
        if (!prefSpan) return false;
        const lineStart = entrySrc.lastIndexOf('\n', prefSpan.valueEnd) + 1;
        const indentMatch = /^[ \t]*/.exec(entrySrc.slice(lineStart));
        const indent = indentMatch ? indentMatch[0] : '  ';
        patchedEntry = entrySrc.slice(0, prefSpan.valueEnd)
            + `,\n${indent}"accountId": "${accountId}"`
            + entrySrc.slice(prefSpan.valueEnd);
    }
    if (!patchedEntry || patchedEntry === entrySrc) return false;
    const patched = raw.slice(0, span.start) + patchedEntry + raw.slice(span.end);
    try {
        const reparsed = parseJsonWithComments(patched);
        const checkEntries = Array.isArray(reparsed?.bots) ? reparsed.bots : [];
        if (checkEntries[entryIndex]?.accountId !== accountId) return false;
    } catch (_) {
        return false;
    }
    const tmpPath = `${filePath}.tmp-persist-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, patched, 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (_) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort cleanup */ }
        return false;
    }
}

/**
 * Persist a resolved account name → ID mapping onto the bot entry in
 * profiles/bots.json (`accountId` next to `preferredAccount`), so analysis
 * tools can skip the chain lookup on subsequent runs. No-op when the stored
 * value already matches. Prefers a byte-preserving textual patch (comments,
 * key order and formatting survive); falls back to a full rewrite using the
 * same atomic writeJSON serialization the bot editor uses. Returns true when
 * the file was updated.
 */
function persistBotAccountId(botKey: unknown, accountId: string, filePath = PATHS.PROFILES.BOTS_JSON): boolean {
    if (!botKey || !isAccountIdRef(accountId)) return false;
    let settings: { bots?: BotEntry[] } | null = null;
    try {
        settings = loadBotSettings(filePath);
    } catch (_) {
        return false;
    }
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    const normalizedKey = String(botKey).toLowerCase();
    const index = entries.findIndex((bot, i) => computeBotKey(bot, i) === normalizedKey);
    if (index < 0 || entries[index]?.accountId === accountId) return false;
    try {
        if (patchAccountIdInRaw(filePath, index, String(accountId))) return true;
    } catch (_) {
        // Fall through to the full rewrite below.
    }
    entries[index].accountId = String(accountId);
    try {
        writeJSON(filePath, settings);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Return the stored chain account ID for a bot key, or null when none is
 * stamped yet. When expectedRef is given, the stored ID is only returned if
 * the entry's current preferredAccount still matches it — a rename must
 * never silently reuse a stale ID.
 */
function getStoredBotAccountId(botKey: unknown, expectedRef?: string | null, filePath = PATHS.PROFILES.BOTS_JSON): string | null {
    if (!botKey) return null;
    let meta: BotEntry | null = null;
    try {
        meta = loadBotMeta(botKey, filePath);
    } catch (_) {
        return null;
    }
    if (!meta) return null;
    const accountIdRaw = String(meta.accountId ?? '');
    const stored = isAccountIdRef(accountIdRaw) ? accountIdRaw : null;
    if (!stored) return null;
    if (expectedRef != null && String(meta.preferredAccount ?? '').toLowerCase() !== String(expectedRef).toLowerCase()) return null;
    return stored;
}

/**
 * Chain account id (`1.2.x`) test — the single spelling rule for account ids.
 * Analysis tools used to carry a private copy of this regex (`account_resolver`,
 * `trade_profitability`, `fills_cache`, `resolve_bot_accounts`).
 */
function isAccountIdRef(ref: unknown): boolean {
    return /^1\.2\.\d+$/.test(String(ref ?? '').trim());
}

/**
 * Find the bot entry whose preferredAccount matches a raw account reference
 * (case-insensitive). Used by tools that accept a bare account name to locate
 * the stored accountId and the persist target. Returns null for 1.2.x input
 * or when no bot claims the name.
 */
function findBotKeyByAccountRef(ref: unknown, filePath = PATHS.PROFILES.BOTS_JSON): { botKey: string; meta: BotEntry } | null {
    if (!ref || isAccountIdRef(ref)) return null;
    let settings: { bots?: BotEntry[] } | null = null;
    try {
        settings = loadBotSettings(filePath);
    } catch (_) {
        return null;
    }
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry && matchBotAccountTarget(entry, ref)) {
            return { botKey: computeBotKey(entry, i), meta: entry };
        }
    }
    return null;
}

/**
 * Which spelling of a `<bot|account>` CLI target matched a bot entry.
 * `name`/`key` identify one bot; `account` identifies the chain account and
 * therefore every entry that trades from it.
 */
type BotTargetKind = 'name' | 'key' | 'account';

interface BotTargetMatch {
    botKey: string;
    meta: BotEntry;
    matchedBy: BotTargetKind;
}

/** Trimmed target or '' — the positional is user input, so never assume a string. */
function normalizeBotTarget(target: unknown): string {
    return typeof target === 'string' ? target.trim() : '';
}

/**
 * Match one bot entry against a `<bot>` target: display name (the same
 * case/space-insensitive rule `resolveBotKey` uses) or bot key. `botKey` is a
 * parameter because callers that key entries by a stored file name
 * (`analyze-orders` reads `profiles/orders/<botKey>.json`) know the key without
 * an entry, and a key must still match when the config entry is missing.
 */
function matchBotEntryTarget(entry: BotEntry | null | undefined, target: unknown, botKey?: unknown): BotTargetKind | null {
    const raw = normalizeBotTarget(target);
    if (!raw) return null;
    if (entry && isSameBotName(entry.name, raw)) return 'name';
    const key = String(botKey ?? '').trim();
    if (!key) return null;
    return key.toLowerCase() === raw.toLowerCase() || sanitizeKey(key) === sanitizeKey(raw) ? 'key' : null;
}

/**
 * Does the target name the chain account behind this bot? Covers both stored
 * spellings: `preferredAccount` (name or typed 1.2.x id) and the `accountId`
 * `account_resolver.ts` stamps next to it. Matched case-insensitively — chain
 * account names are lowercase, but operators type them any way they like.
 */
function matchBotAccountTarget(entry: BotEntry | null | undefined, target: unknown): boolean {
    const raw = normalizeBotTarget(target).toLowerCase();
    if (!entry || !raw) return false;
    const account = String(entry.preferredAccount ?? '').trim().toLowerCase();
    if (account && account === raw) return true;
    const accountId = String(entry.accountId ?? '').trim().toLowerCase();
    return Boolean(accountId) && accountId === raw;
}

/**
 * Canonical `<bot|account>` target resolution: every entry matching the target
 * as a bot name, a bot key, or the chain account it trades from. This is the
 * one rule set behind `dexbot credit`, `dexbot order` and the chart commands —
 * they previously each carried a slightly different copy (some name-only, some
 * key-only, `credit` a third variant). Each caller picks the spellings it
 * accepts from `matchedBy`: a chart command takes the first `name`/`key` match
 * (an account is ambiguous there), while `credit` reports every match.
 */
function matchBotTargetIn(entries: Array<BotEntry | null | undefined> | null | undefined, target: unknown): BotTargetMatch[] {
    const out: BotTargetMatch[] = [];
    const list = Array.isArray(entries) ? entries : [];
    for (let index = 0; index < list.length; index++) {
        const entry = list[index];
        if (!entry) continue;
        const botKey = computeBotKey(entry, index);
        const matchedBy = matchBotEntryTarget(entry, target, botKey)
            ?? (matchBotAccountTarget(entry, target) ? 'account' : null);
        if (matchedBy) out.push({ botKey, meta: entry, matchedBy });
    }
    return out;
}

function resolveAmaConfig(botKey: unknown): AmaConfig {
    const botMeta = loadBotMeta(botKey);
    if (!botMeta) return { ...MARKET_ADAPTER.AMAS.AMA3 };

    const rawGridPrice = String(botMeta?.gridPrice || '').trim().toLowerCase();
    const isAmaKeyword = AMA_KEYWORDS.has(rawGridPrice);
    const botAmaInline = (botMeta.ama && typeof botMeta.ama === 'object') ? botMeta.ama as BotEntry : null;

    // Priority: inline bot.ama overrides market profile for analysis visibility.
    // Production inverts this (profiles first, inline as fallback —
    // resolveAmaForBot in market_adapter.ts).
    if (botAmaInline) {
        const cfg: AmaConfig = {
            erPeriod: Number(botAmaInline.erPeriod),
            fastPeriod: Number(botAmaInline.fastPeriod),
            slowPeriod: Number(botAmaInline.slowPeriod),
        };
        if (isAmaKeyword) {
            const key = rawGridPrice === 'ama' ? DEFAULT_AMA_KEY : rawGridPrice.toUpperCase();
            const preset = BUILTIN_AMAS[key];
            if (preset) {
                if (!Number.isFinite(cfg.erPeriod) || cfg.erPeriod < 1) cfg.erPeriod = preset.erPeriod;
                if (!Number.isFinite(cfg.fastPeriod) || cfg.fastPeriod < 1) cfg.fastPeriod = preset.fastPeriod;
                if (!Number.isFinite(cfg.slowPeriod) || cfg.slowPeriod < 1) cfg.slowPeriod = preset.slowPeriod;
            }
        }
        if (!Number.isFinite(cfg.erPeriod) || cfg.erPeriod < 1) cfg.erPeriod = MARKET_ADAPTER.AMAS.AMA3.erPeriod;
        if (!Number.isFinite(cfg.fastPeriod) || cfg.fastPeriod < 1) cfg.fastPeriod = MARKET_ADAPTER.AMAS.AMA3.fastPeriod;
        if (!Number.isFinite(cfg.slowPeriod) || cfg.slowPeriod < 1) cfg.slowPeriod = MARKET_ADAPTER.AMAS.AMA3.slowPeriod;
        if (cfg.fastPeriod > cfg.slowPeriod) {
            const t = cfg.fastPeriod; cfg.fastPeriod = cfg.slowPeriod; cfg.slowPeriod = t;
        }
        return cfg;
    }

    const marketProfiles = loadMarketProfiles();
    // Pair match is case-insensitive AND orientation-insensitive: a profile may
    // have been fitted from either side of the pair (the candle cache stores
    // canonically). Matching only the bot's typed order would silently drop the
    // profile and fall back to builtin AMA defaults.
    const selectedProfile = (marketProfiles?.profiles
        ? marketProfiles.profiles.find((entry: { assetA?: unknown; assetB?: unknown; intervalSeconds?: unknown }) =>
            Number(entry.intervalSeconds) === 3600 &&
            ((isSameAssetSymbol(entry.assetA, botMeta.assetA) && isSameAssetSymbol(entry.assetB, botMeta.assetB)) ||
             (isSameAssetSymbol(entry.assetA, botMeta.assetB) && isSameAssetSymbol(entry.assetB, botMeta.assetA))))
        : null) as { defaultAma?: string; amas?: Record<string, { erPeriod: number; fastPeriod: number; slowPeriod: number }> } | null | undefined;

    if (selectedProfile?.amas) {
        const fallbackKey = selectedProfile.defaultAma || DEFAULT_AMA_KEY;
        const requestedKey = isAmaKeyword
            ? (rawGridPrice === 'ama' ? fallbackKey : rawGridPrice.toUpperCase())
            : fallbackKey;
        const fromProfile = selectedProfile.amas[requestedKey] || selectedProfile.amas[fallbackKey];
        const fromBuiltin = BUILTIN_AMAS[requestedKey] || BUILTIN_AMAS[fallbackKey];
        const base = fromProfile || fromBuiltin;
        if (base) {
            return { erPeriod: base.erPeriod, fastPeriod: base.fastPeriod, slowPeriod: base.slowPeriod };
        }
    }

    const key = isAmaKeyword
        ? (rawGridPrice === 'ama' ? DEFAULT_AMA_KEY : rawGridPrice.toUpperCase())
        : DEFAULT_AMA_KEY;
    const builtin = BUILTIN_AMAS[key] || MARKET_ADAPTER.AMAS.AMA3;
    return { erPeriod: builtin.erPeriod, fastPeriod: builtin.fastPeriod, slowPeriod: builtin.slowPeriod };
}

function resolveAmaKey(botKey: unknown): string {
    const botMeta = loadBotMeta(botKey);
    if (!botMeta) return 'AMA3';
    const rawGridPrice = String(botMeta?.gridPrice || '').trim().toLowerCase();
    if (AMA_KEYWORDS.has(rawGridPrice)) {
        return rawGridPrice === 'ama' ? DEFAULT_AMA_KEY : rawGridPrice.toUpperCase();
    }
    return 'AMA3';
}

export { loadBotSettings, sanitizeKey, computeBotKey, resolveBotKey, candleFileForBot, resolveCandleFile, loadBotMeta, getStoredBotAccountId, findBotKeyByAccountRef, persistBotAccountId, resolveAmaConfig, resolveAmaKey, isAccountIdRef, matchBotEntryTarget, matchBotAccountTarget, matchBotTargetIn }
export type { BotTargetKind, BotTargetMatch };


'use strict';

/**
 * SHARED ACCOUNT RESOLUTION (analysis)
 *
 * Central implementation of "preferredAccount / bare account reference →
 * 1.2.x accountId" for every analysis tool, including stamping the resolved ID
 * back into profiles/bots.json so later runs skip the chain lookup.
 *
 * trade_profitability.ts and grid_correction_check.ts used to each carry a
 * private copy of this decision tree, of the chain lookup and of the node
 * handling — all of it lives here now.
 */

import { getErrorMessage } from '../modules/utils/errors.js';
import { findBotKeyByAccountRef, isAccountIdRef, loadBotMeta, persistBotAccountId, resolveBotKey } from './bot_key_utils.js';
import { withReadOnlyClient } from './chain_pool.js';

/** Chain lookup seam: batch tools can reuse one connection across lookups. */
type NameLookup = (name: string) => Promise<string | null>;

/** Default lookup: ephemeral read-only client over the built-in node pool. */
async function lookupNameOnChain(name: string): Promise<string | null> {
    try {
        return await withReadOnlyClient(async (client) => {
            const accounts = await client.db('lookup_account_names', [[name]]);
            return Array.isArray(accounts) && accounts[0]?.id ? String(accounts[0].id) : null;
        });
    } catch (e) {
        console.warn(`  [warn] Account resolution failed: ${getErrorMessage(e)}`);
        return null;
    }
}

type ResolveSource = 'typed-id' | 'override-id' | 'override-resolved' | 'preferred-id' | 'stored' | 'resolved';
type ResolveFailure = 'bot-not-found' | 'no-preferred-account' | 'override-unresolved' | 'name-unresolved';

interface ResolveOptions {
    /** Explicit override (--account). Wins over the bot entry and is never persisted. */
    overrideAccount?: string | null;
    /** Ignore a stored accountId and re-resolve on chain (--refresh-account). */
    refresh?: boolean;
    /** Suppress informational output; failures are reported via `reason`. */
    quiet?: boolean;
    /** Chain lookup override (batch tools reuse one connection, tests stub it). */
    lookup?: NameLookup;
    /** Override profiles/bots.json (tests use a temp file). */
    botsFile?: string;
}

interface ResolvedAccount {
    accountId: string | null;
    botKey: string | null;
    botMeta: Record<string, unknown> | null;
    source: ResolveSource | null;
    reason: ResolveFailure | null;
}

/**
 * Persist a resolved ID onto the bot entry (no-op when it already matches) and
 * report the outcome. `previous` is the stored value the write replaces, if any.
 */
function persistResolvedAccountId(botKey: string, accountId: string, previous: string | null, quiet: boolean, botsFile?: string): boolean {
    const wrote = persistBotAccountId(botKey, accountId, botsFile);
    if (quiet) return wrote;
    if (wrote) {
        console.log(previous && previous !== accountId
            ? `  Updated stored accountId ${previous} → ${accountId} in profiles/bots.json for '${botKey}'`
            : `  Stored accountId ${accountId} in profiles/bots.json for '${botKey}'`);
    } else if (previous === accountId) {
        console.log(`  Stored accountId ${accountId} confirmed up to date`);
    } else {
        console.warn(`  [warn] Could not store accountId ${accountId} in profiles/bots.json for '${botKey}'`);
    }
    return wrote;
}

/**
 * Resolve the chain account for a bot entry:
 *   explicit override > typed 1.2.x preferredAccount > stored accountId >
 *   fresh chain lookup of the name.
 * The resolved ID is persisted onto the entry whenever it differs from the
 * stored one (an explicit override is never persisted — it is not the bot's
 * preferredAccount).
 */
async function resolveBotAccount(botKey: string, options: ResolveOptions = {}): Promise<ResolvedAccount> {
    const { overrideAccount = null, refresh = false, quiet = false, lookup = lookupNameOnChain, botsFile } = options;
    const botMeta = botKey ? loadBotMeta(botKey, botsFile) : null;

    // An explicit override always wins and is never persisted.
    const override = overrideAccount != null ? String(overrideAccount).trim() : '';
    if (override) {
        if (isAccountIdRef(override)) {
            return { accountId: override, botKey, botMeta, source: 'override-id', reason: null };
        }
        if (!quiet) console.log(`  Resolving account name '${override}'...`);
        const id = await lookup(override);
        if (!id) return { accountId: null, botKey, botMeta, source: null, reason: 'override-unresolved' };
        if (!quiet) console.log(`  → ${id}`);
        return { accountId: String(id), botKey, botMeta, source: 'override-resolved', reason: null };
    }

    if (!botMeta) return { accountId: null, botKey, botMeta: null, source: null, reason: 'bot-not-found' };

    const prefRaw = botMeta.preferredAccount != null ? String(botMeta.preferredAccount).trim() : '';
    if (!prefRaw) return { accountId: null, botKey, botMeta, source: null, reason: 'no-preferred-account' };

    const stored = isAccountIdRef(String(botMeta.accountId ?? '')) ? String(botMeta.accountId) : null;

    // A typed 1.2.x preferredAccount is authoritative — the stored accountId is
    // a derived cache and must never override it. Self-heal the cache.
    if (isAccountIdRef(prefRaw)) {
        if (stored !== prefRaw) persistResolvedAccountId(botKey, prefRaw, stored, quiet, botsFile);
        return { accountId: prefRaw, botKey, botMeta, source: 'preferred-id', reason: null };
    }

    // Name + fresh-enough cache + no refresh requested: offline-friendly fast path.
    if (stored && !refresh) {
        if (!quiet) console.log(`  Using stored accountId ${stored} from profiles/bots.json (no lookup needed; pass --refresh-account to re-verify)`);
        return { accountId: stored, botKey, botMeta, source: 'stored', reason: null };
    }

    if (!quiet) console.log(`  Resolving account name '${prefRaw}'...`);
    const id = await lookup(prefRaw);
    if (!id) return { accountId: null, botKey, botMeta, source: null, reason: 'name-unresolved' };
    if (!quiet) console.log(`  → ${id}`);
    persistResolvedAccountId(botKey, String(id), stored, quiet, botsFile);
    return { accountId: String(id), botKey, botMeta, source: 'resolved', reason: null };
}

/**
 * Resolve a bare account reference (1.2.x ID or name) to a chain account ID.
 * When a bot in profiles/bots.json claims the name, the resolved ID is
 * persisted onto that entry via resolveBotAccount.
 */
async function resolveAccountRef(accountRef: string, options: ResolveOptions = {}): Promise<ResolvedAccount> {
    const ref = String(accountRef ?? '').trim();
    if (isAccountIdRef(ref)) {
        return { accountId: ref, botKey: null, botMeta: null, source: 'typed-id', reason: null };
    }

    // Local profile first: a bot whose profile name/key matches the reference
    // resolves through its stored accountId/preferredAccount without any chain
    // lookup. This is what lets `dexbot pnl <bot>` work offline and avoids
    // treating a bot name as a chain account name.
    try {
        const botKey = resolveBotKey(ref, options.botsFile);
        if (botKey) return resolveBotAccount(botKey, options);
    } catch (_) {
        // bots.json issues must never break resolution; fall through to chain.
    }

    // A bot claiming this name is the persist target; its preferredAccount is
    // the same name, so resolveBotAccount owns the whole decision tree.
    let match: { botKey: string; meta: Record<string, unknown> } | null = null;
    try {
        match = findBotKeyByAccountRef(ref, options.botsFile);
    } catch (_) {
        // bots.json issues must never break resolution; fall through to chain.
    }
    if (match) return resolveBotAccount(match.botKey, options);

    const lookup = options.lookup ?? lookupNameOnChain;
    if (!options.quiet) console.log(`  Resolving account name '${ref}'...`);
    const id = await lookup(ref);
    if (!id) return { accountId: null, botKey: null, botMeta: null, source: null, reason: 'name-unresolved' };
    if (!options.quiet) console.log(`  → ${id}`);
    return { accountId: String(id), botKey: null, botMeta: null, source: 'resolved', reason: null };
}

export { resolveBotAccount, resolveAccountRef };

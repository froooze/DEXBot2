'use strict';

/**
 * Shared target resolution for chart-style CLI commands (`dexbot tv`, `dw`,
 * `liquid`). Keeping bot lookup and key formatting here prevents the commands
 * from drifting on which bots are recognised and how the "unknown target"
 * hint is rendered.
 */

import { isPoolIdRef, isPoolRefLike } from '../modules/liquidity_pool_ref.js';
import { computeBotKey, loadBotMeta, loadBotSettings, matchBotTargetIn } from '../analysis/bot_key_utils.js';
import type { BotEntry } from '../modules/bot_settings.js';

interface BotTarget {
    botKey: string;
    meta: BotEntry;
}

/** Pool id targets (`133` / `1.19.x`) — delegates to the shared pool-ref rules. */
function isPoolIdTarget(target: string): boolean {
    return isPoolIdRef(target);
}

/** True when a target could name a pool (numeric id or pool-token symbol). */
function isPoolTarget(target: string): boolean {
    return isPoolRefLike(target);
}

/** Find a bot by display name or by key (same rules as `dexbot tv`). */
function findBotByTarget(target: string): BotTarget | null {
    const settings = loadBotSettings();
    const entries: BotEntry[] = Array.isArray(settings?.bots) ? settings.bots : [];
    // Name/key matching is the shared `<bot|account>` rule set
    // (analysis/bot_key_utils); these commands take bot targets only — an
    // account can back several bots, so an account spelling would silently
    // chart whichever entry came first.
    const match = matchBotTargetIn(entries, target).find((m) => m.matchedBy !== 'account');
    if (!match) return null;
    // loadBotMeta canonicalises the pair symbols (analysis-wide convention).
    const meta = loadBotMeta(match.botKey) ?? (match.meta as unknown as BotEntry);
    return { botKey: match.botKey, meta };
}

/** Bot keys used in the unknown-target hint (first 8 shown by callers). */
function knownBotKeys(): string[] {
    const settings = loadBotSettings();
    const entries: BotEntry[] = Array.isArray(settings?.bots) ? settings.bots : [];
    return entries.map((entry, index) => computeBotKey(entry, index)).filter(Boolean);
}

/** Shared trailing hint for an unresolved target. */
function knownTargetsHint(includePool: boolean): string {
    const keys = knownBotKeys();
    const botHint = keys.length ? ` (${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''})` : '';
    return includePool
        ? `Use a bot name/key${botHint}, a pool id (133 / 1.19.133) or pool token, or AssetA/AssetB.`
        : `Use a bot name/key${botHint} or AssetA/AssetB.`;
}

export { isPoolIdTarget, isPoolTarget, findBotByTarget, knownBotKeys, knownTargetsHint };
export type { BotTarget };

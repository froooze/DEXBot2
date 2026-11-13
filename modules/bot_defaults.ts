/**
 * Central bot-defaults seeder — the single place that knows how
 * `DEFAULT_CONFIG` values are applied to bot data. Three modes:
 *
 *  * seedBotDraft          — `normalizeBotDraft` (editor new/edit seed): fills
 *                            every DEFAULT_CONFIG key except the excluded
 *                            pair/funds keys; preserves nulls and partial
 *                            objects so already-seeded entries stay byte-stable.
 *  * seedBotEntry          — `normalizeBotEntry` (runtime load): only the
 *                            `active` default; validation relies on most keys
 *                            being ABSENT, so entry seeding stays minimal.
 *  * seedBotRuntimeConfig  — `OrderManager` config: fills absent DEFAULT_CONFIG
 *                            keys with deep clones (never aliases the global
 *                            default) and passes provided values through
 *                            verbatim with `{ ...DEFAULT_CONFIG, ...config }`
 *                            semantics (key order included).
 *
 * Mode rules are pinned by tests/test_bot_defaults_characterization.ts and
 * tests/test_bot_defaults_parity.ts — update them together with this file.
 */

import { DEFAULT_CONFIG } from './constants.js';
import type { UnknownRecord, BotMetrics } from './types.js';

interface SeedOptions {
    /** Defaults source; omit to use the merged DEFAULT_CONFIG. */
    defaults?: UnknownRecord;
}

/**
 * DEFAULT_CONFIG keys the draft seed must NEVER add. Seeding these would change
 * persisted bots.json bytes for existing bots and pre-satisfy
 * `validateBotEntry`'s required-key check (assetA/assetB), hiding genuine
 * configuration mistakes from the validator. `activeOrders`/`reserveOrders` are
 * legacy aliases migrated to `coreOrders`/`edgeOrders`, kept here so an older
 * general.settings.json that still carries them does not fail the parity guard.
 */
export const DRAFT_EXCLUDED_KEYS = ['assetA', 'assetB', 'creditOnly', 'min_BTS_value', 'activeOrders', 'reserveOrders'];

/**
 * Draft seed order — kept identical to the historical if-chain so a freshly
 * created bot's JSON key order does not change. Together with
 * DRAFT_EXCLUDED_KEYS this must cover EVERY DEFAULT_CONFIG key; the parity test
 * fails when a new DEFAULT_CONFIG key is added without classifying it here.
 */
export const DRAFT_SEED_ORDER = [
    'weightDistribution', 'botFunds', 'coreOrders', 'edgeOrders',
    'active', 'dryRun', 'minPrice', 'maxPrice', 'incrementPercent',
    'targetSpreadPercent', 'startPrice', 'gridPrice',
];

/**
 * Spellings that mean "no explicit grid price" — delegate to startPrice.
 * `none`/`null`/`start`/`startprice` are the editor's documented aliases;
 * `n`/`no`/`false`/`0`/`f` are the boolean-style deactivating answers accepted
 * elsewhere in the editor, `s` is shorthand for `startPrice`, and the boolean
 * `false` covers a hand-edited `gridPrice: false`.
 */
const GRID_PRICE_UNSET_INPUTS = new Set(['none', 'null', 'start', 'startprice', 's', 'n', 'no', 'false', '0', 'f']);

/**
 * True when a grid-price value carries no reference and must degrade to the
 * startPrice fallback. Keeps `null`/`undefined`/`false`, empty/whitespace
 * strings, and the aliases above equivalent so the editor display, the prompt
 * parser, and the draft seeder all agree (the runtime already falls back on
 * anything non-numeric/non-AMA).
 * @param {*} value - Candidate grid-price value.
 * @returns {boolean}
 */
export function isUnsetGridPrice(value: unknown): boolean {
    if (value === null || value === undefined || value === false) return true;
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        return text === '' || GRID_PRICE_UNSET_INPUTS.has(text);
    }
    return false;
}

function clone<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
}

/**
 * Legacy bot-config key aliases: `activeOrders` → `coreOrders` and
 * `reserveOrders` → `edgeOrders`. Applied at every read/seed funnel so a
 * pre-rename or hand-edited `bots.json` keeps working: the new key wins when
 * both are present, the legacy key is dropped, and a later save rewrites the
 * entry in canonical form. Mutates and returns the passed object.
 *
 * Must run BEFORE fingerprinting and the live-config allowlist so both see the
 * canonical key (the maintained-key list and the raw-key fingerprint would
 * otherwise miss a legacy entry).
 * @param {Object} data - Bot entry or runtime config.
 * @returns {Object} The same object, aliased in place.
 */
export function migrateLegacyOrderKeys<T extends UnknownRecord>(data: T): T {
    const record = data as UnknownRecord;
    if (record.coreOrders === undefined && record.activeOrders !== undefined) {
        record.coreOrders = record.activeOrders;
    }
    if (record.edgeOrders === undefined && record.reserveOrders !== undefined) {
        record.edgeOrders = record.reserveOrders;
    }
    delete record.activeOrders;
    delete record.reserveOrders;
    return data;
}

/** Numbers migrate to `{ buy, sell: 0 }` (floored, clamped at 0); anything
 *  that is not a plain object becomes the default; plain objects — including
 *  partial ones — are kept verbatim. */
function seedEdgeOrders(value: unknown, def: unknown): unknown {
    if (typeof value === 'number') {
        return { buy: Math.max(0, Math.floor(value)), sell: 0 };
    }
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
        return clone(def);
    }
    return value;
}

/**
 * Editor draft seed (formerly the `normalizeBotDraft` if-chain in
 * modules/account_bots.ts). Deep-clones the input, then applies defaults:
 *
 *  * count objects (`weightDistribution`/`botFunds`/`coreOrders`): falsy
 *    input → default clone; truthy input (including partials) kept verbatim —
 *    never deep-filled;
 *  * `edgeOrders`: number migration / invalid → default (see seedEdgeOrders);
 *  * `startPrice`: undefined → `default || 'pool'` (falsy defaults fall back);
 *  * `gridPrice`: undefined → `DEFAULT_CONFIG.gridPrice` ("ama3" today),
 *    falling back to null only when the default itself is null (Phase 2:
 *    was a hardcoded null that ignored DEFAULT_CONFIG.gridPrice overrides);
 *  * other scalars: filled only when `=== undefined` — explicit nulls survive.
 */
export function seedBotDraft(base?: UnknownRecord | null, options: SeedOptions = {}): UnknownRecord {
    const defaults: UnknownRecord = options.defaults ?? DEFAULT_CONFIG;
    const data: UnknownRecord = migrateLegacyOrderKeys(JSON.parse(JSON.stringify(base ?? {})));
    for (const key of DRAFT_SEED_ORDER) {
        const def = defaults[key];
        if (key === 'edgeOrders') {
            data.edgeOrders = seedEdgeOrders(data.edgeOrders, def);
        } else if (key === 'startPrice') {
            if (data.startPrice === undefined) data.startPrice = def || 'pool';
        } else if (key === 'gridPrice') {
            // Unset spellings (false, "no", "none", ...) normalize to null so a
            // hand-edited gridPrice can never linger as a value the runtime only
            // silently degrades to startPrice.
            const gp = data.gridPrice === undefined ? def : data.gridPrice;
            data.gridPrice = isUnsetGridPrice(gp) ? null : gp;
        } else if (def !== null && typeof def === 'object') {
            if (!data[key]) data[key] = clone(def);
        } else if (data[key] === undefined) {
            data[key] = def;
        }
    }
    return data;
}

/**
 * Runtime entry default (formerly duplicated in `modules/bot_settings.ts` and
 * `claw/modules/dexbot_profiles.ts`). Only `active` is defaulted:
 *
 *  * missing/undefined → DEFAULT_CONFIG.active (the historical copy hardcoded
 *    `true`; sourcing it makes a DEFAULT_CONFIG.active override take effect);
 *  * present values pass through RAW — the spread deliberately wins, matching
 *    the `active !== false` convention used by every consumer (a present
 *    `null`/`0` stays `null`/`0` and classifies as active).
 *
 * No other DEFAULT_CONFIG key may be seeded here: `validateBotEntry` treats
 * missing keys as mistakes (assetA/assetB must be genuinely absent when
 * unconfigured).
 */
export function seedBotEntry<T extends UnknownRecord>(entry: T, options: SeedOptions = {}): T {
    const defaults: UnknownRecord = options.defaults ?? DEFAULT_CONFIG;
    const data = migrateLegacyOrderKeys({ ...entry });
    return { active: data.active === undefined ? defaults.active : data.active, ...data } as T;
}

/**
 * Runtime config seed (formerly `{ ...DEFAULT_CONFIG, ...config }` in the
 * OrderManager constructor). Produces exactly the spread result — same key
 * order, provided values passed through by reference, explicit-undefined
 * values winning — except that ABSENT defaults are deep CLONES, so mutating
 * `manager.config.botFunds` can no longer corrupt the global DEFAULT_CONFIG
 * (the historical shallow spread aliased every nested default object).
 */
export function seedBotRuntimeConfig(config: UnknownRecord = {}, options: SeedOptions = {}): UnknownRecord {
    const defaults: UnknownRecord = options.defaults ?? DEFAULT_CONFIG;
    const configKeys = new Set(Object.keys(config));
    const out: UnknownRecord = {};
    for (const key of Object.keys(defaults)) {
        out[key] = configKeys.has(key) ? config[key] : clone(defaults[key]);
    }
    for (const key of configKeys) {
        if (!(key in out)) out[key] = config[key];
    }
    return out;
}

/**
 * Fresh zeroed metrics for the bot and its order manager. Both layers used to
 * declare the shared counters independently, so a new shared counter had to be
 * added twice (and could drift). The manager spreads this base and adds its own
 * runtime-only counters (lock stats, sync timing, start time); the bot uses it
 * verbatim. Single source of truth for the shared `BotMetrics` defaults.
 * @returns {Object} A new metrics object with every shared counter zeroed
 */
export function createDefaultBotMetrics(): BotMetrics {
    return {
        fillsProcessed: 0,
        batchesExecuted: 0,
        fillProcessingTimeMs: 0,
        lockContentionEvents: 0,
        maxQueueDepth: 0,
        gridLockContention: 0,
        fundRecalcCount: 0,
        refusedCommitCount: 0,
        orphanFillCreditedCount: 0,
        restampBuyAboveAnchorCount: 0,
        boundaryDriftExceedsWindowCount: 0,
        gapBandPlacementShadowCount: 0,
        spreadCorrectionRefusedCount: 0,
        spreadCorrectionRefusalCauses: {},
        spreadCorrectionRetryCount: 0,
        stalePlanDroppedCount: 0,
        stalePlanProceedCount: 0,
        clampedNoopUpdateCount: 0,
        chunkAbortedOpCount: 0,
        reloadReplacedRailCount: 0
    };
}


import { getStorage } from './storage/index.js';
import { readBotsFileSync, writeJsonFileAtomic } from './bots_file_lock.js';
import { parseJsonWithComments } from './order/utils/system.js';
import { createBotKey } from './account_orders.js';
import { seedBotEntry, migrateLegacyOrderKeys } from './bot_defaults.js';
import { isSameBotName } from './utils/sanitize_key.js';
import { isPositiveNumber, isPositiveNumberOrPercent, toDecimal } from './order/utils/math.js';
import { resolveMinCollateralIncreaseThreshold } from './cr_planner.js';
import { getErrorMessage } from './utils/errors.js';
import { canonicalizeBotAssetSymbols } from './utils/asset_symbols.js';
import type { UnknownRecord } from './types.js';
import { isUnknownRecord } from './types.js';
const storage = getStorage();
const { writeJSON } = storage;

/** A single `debtPolicy.lending[]` entry (loosely typed: validated at runtime). */
export interface BotLendingEntry extends UnknownRecord {
    asset?: unknown;
    collateralAsset?: unknown;
    type?: unknown;
}

/** `debtPolicy` block of a bot entry. */
interface BotDebtPolicy extends UnknownRecord {
    lending?: BotLendingEntry[];
    maxCollateralAmount?: unknown;
}

/** A loosely-typed bot entry as read from bots.json / user input. */
export interface BotEntry extends UnknownRecord {
    name?: string;
    active?: boolean;
    creditOnly?: boolean;
    assetA?: string;
    assetB?: string;
    botKey?: string;
    botIndex?: number;
    preferredAccount?: string;
    /** Chain account id (1.2.x) stamped next to `preferredAccount` (see analysis/account_resolver.ts). */
    accountId?: string;
    coreOrders?: UnknownRecord;
    edgeOrders?: number | UnknownRecord;
    /** @deprecated legacy key, migrated to `coreOrders` at read time. */
    activeOrders?: UnknownRecord;
    /** @deprecated legacy key, migrated to `edgeOrders` at read time. */
    reserveOrders?: number | UnknownRecord;
    botFunds?: { buy?: unknown; sell?: unknown };
    debtPolicy?: BotDebtPolicy;
}

/** The top-level bots.json document. */
export interface BotSettingsFile extends UnknownRecord {
    bots?: BotEntry[];
}

function loadSettingsFile(filePath: string, { silent = false, exitOnError = true }: { silent?: boolean; exitOnError?: boolean } = {}): { config: BotSettingsFile; filePath: string } {
    if (!storage.exists(filePath)) {
        if (!silent) {
            console.error(`${filePath} not found. Run: dexbot bot`);
        }
        return { config: {}, filePath };
    }

    try {
        const { config } = readBotsFileSync(filePath, parseJsonWithComments);
        // Upgrade a pre-rename file in place: legacy `activeOrders`/
        // `reserveOrders` keys become `coreOrders`/`edgeOrders` and the file is
        // rewritten in canonical form. Idempotent; a failed write is
        // non-fatal because the in-memory config is already canonical.
        migratePersistedOrderKeys(filePath, config);
        return { config, filePath };
    } catch (err) {
        console.error('Failed to parse bot settings from', filePath);
        console.error('Error:', getErrorMessage(err));
        console.error('Please fix the JSON syntax and try again.');
        if (exitOnError) {
            throw err;
        }
        return { config: {}, filePath };
    }
}

function saveSettingsFile(config: UnknownRecord, filePath: string): void {
    try {
        writeJSON(filePath, config);
    } catch (err) {
        console.error('Failed to save bot settings to', filePath, '-', getErrorMessage(err));
        throw err;
    }
}

function resolveRawBotEntries(settings: unknown): BotEntry[] {
    if (!isUnknownRecord(settings)) return [];
    if (Array.isArray(settings.bots)) return settings.bots as BotEntry[];
    if (Object.keys(settings).length > 0) return [settings as BotEntry];
    return [];
}

/**
 * Persist the user-settings key upgrade: rewrite bots.json in canonical form
 * when any entry still carries the legacy `activeOrders`/`reserveOrders` keys.
 * Runs at the read funnel so an old file is transparently migrated.
 * @param {string} filePath - bots.json path
 * @param {unknown} config - Parsed bots.json document (mutated in place)
 * @returns {boolean} True when a legacy key was found and upgraded
 */
function migratePersistedOrderKeys(filePath: string, config: unknown): boolean {
    let changed = false;
    for (const entry of resolveRawBotEntries(config)) {
        if (isUnknownRecord(entry) && ('activeOrders' in entry || 'reserveOrders' in entry)) {
            migrateLegacyOrderKeys(entry);
            changed = true;
        }
    }
    if (changed) {
        try {
            writeJsonFileAtomic(filePath, config);
        } catch (err) {
            console.error('Failed to persist upgraded bot settings to', filePath, '-', getErrorMessage(err));
        }
    }
    return changed;
}

function normalizeBotEntry(entry: BotEntry, index: number = 0): BotEntry {
    // active default + raw passthrough live in modules/bot_defaults.ts
    // (shared with the claw copy — one semantics for both).
    const normalized = seedBotEntry(entry);
    // Asset symbols are canonical UPPERCASE on BitShares. A hand-edited
    // lowercase "assetA": "tokena" both fails the case-sensitive chain lookup
    // and breaks every strict symbol comparison downstream (e.g. the
    // core-asset side check that reads `assetA === 'CORE'`,
    // getBtsSide, fee/pool cache keys), so canonicalize at this single read
    // funnel — which key names hold a symbol is defined once, in
    // modules/utils/asset_symbols.canonicalizeBotAssetSymbols, shared with
    // analysis/bot_key_utils.loadBotMeta. botKey is unaffected: createBotKey
    // runs the pair through sanitizeKey, which is case-insensitive.
    const out: BotEntry = canonicalizeBotAssetSymbols({ ...normalized, botIndex: index });
    out.botKey = createBotKey(out, index);
    return out;
}

function normalizeBotEntries(rawEntries: unknown[]): BotEntry[] {
    return rawEntries.map((entry, index) => normalizeBotEntry(entry as BotEntry, index));
}

function selectBotEntry(settings: unknown, botName: string): BotEntry | null {
    const entries = resolveRawBotEntries(settings);
    if (!botName) return null;
    return entries.find((b) => b && isSameBotName(b.name, botName)) || null;
}

function selectActiveBotEntries(settings: unknown): BotEntry[] {
    return resolveRawBotEntries(settings).filter((entry) => entry && entry.active !== false);
}



function validateBotEntry(b: BotEntry, i: number, src: string): string | null {
    const problems: string[] = [];
    // Legacy `activeOrders`/`reserveOrders` keys are accepted and validated
    // under their canonical names so a pre-rename bots.json is not rejected.
    const entry = migrateLegacyOrderKeys({ ...b });
    const isCreditOnly = b.creditOnly === true;
    const required = isCreditOnly ? [] : ['assetA', 'assetB', 'coreOrders', 'botFunds'];
    for (const k of required) {
        if (!(k in entry)) problems.push(`missing '${k}'`);
    }

    if ('coreOrders' in entry) {
        if (typeof entry.coreOrders !== 'object' || entry.coreOrders === null) problems.push("'coreOrders' must be an object");
        else {
            if (!('buy' in entry.coreOrders)) problems.push("coreOrders missing 'buy'");
            if (!('sell' in entry.coreOrders)) problems.push("coreOrders missing 'sell'");
        }
    }

    if ('edgeOrders' in entry && entry.edgeOrders !== undefined && entry.edgeOrders !== null) {
        if (typeof entry.edgeOrders === 'number') {
            // Legacy numeric form migrates at read time (resolveEdgeCount):
            // { buy: n, sell: 0 }. Accept it here so a hand-edited bots.json
            // that bypassed the editor is not rejected for a form the runtime
            // still understands.
            if (!Number.isInteger(entry.edgeOrders) || entry.edgeOrders < 0) problems.push("'edgeOrders' numeric form must be a non-negative integer");
        } else if (typeof entry.edgeOrders !== 'object' || Array.isArray(entry.edgeOrders)) {
            problems.push("'edgeOrders' must be an object {buy, sell}");
        } else {
            for (const side of ['buy', 'sell'] as const) {
                const edgeOrders = entry.edgeOrders as UnknownRecord;
                const v = edgeOrders[side];
                if (v !== undefined && (!Number.isInteger(Number(v)) || Number(v) < 0)) problems.push(`'edgeOrders.${side}' must be a non-negative integer`);
            }
        }
    }

    if ('botFunds' in b) {
        if (typeof b.botFunds !== 'object' || b.botFunds === null) problems.push("'botFunds' must be an object");
        else {
            if (!('buy' in b.botFunds)) problems.push("botFunds missing 'buy'");
            if (!('sell' in b.botFunds)) problems.push("botFunds missing 'sell'");
        }
    }

    if ('debtPolicy' in b) {
        if (typeof b.debtPolicy !== 'object' || b.debtPolicy === null) {
            problems.push("'debtPolicy' must be an object");
        } else {
            const dp = b.debtPolicy;

            if (!Array.isArray(dp.lending) || dp.lending.length === 0) {
                problems.push("debtPolicy.lending must be a non-empty array");
            } else {
                dp.lending.forEach((item: BotLendingEntry, idx: number) => {
                    if (typeof item !== 'object' || item === null) {
                        problems.push(`debtPolicy.lending[${idx}] must be an object`);
                        return;
                    }
                    if (!item.collateralAsset || typeof item.collateralAsset !== 'string') {
                        problems.push(`debtPolicy.lending[${idx}].collateralAsset must be a non-empty string`);
                    }
                    if (!item.asset || typeof item.asset !== 'string') {
                        problems.push(`debtPolicy.lending[${idx}].asset must be a non-empty string`);
                    }
                    if (!['mpa', 'creditOffer'].includes(String(item.type))) {
                        problems.push(`debtPolicy.lending[${idx}].type must be 'mpa' or 'creditOffer'`);
                    }

                    // outputWeight: canonical field (deprecated 'ratio' alias removed)
                    if ('ratio' in item) {
                        problems.push(`debtPolicy.lending[${idx}].ratio is no longer supported; use outputWeight instead`);
                    }

                    if ('outputWeight' in item) {
                        const weightVal = item.outputWeight;
                        if (typeof weightVal !== 'number' || !Number.isFinite(weightVal) || weightVal < 0) {
                            problems.push(`debtPolicy.lending[${idx}].outputWeight must be a non-negative number`);
                        }
                    }

                    // maxBorrowAmount: optional, must be a fixed positive number (no percentage)
                    if ('maxBorrowAmount' in item) {
                        if (!isPositiveNumber(item.maxBorrowAmount)) {
                            problems.push(`debtPolicy.lending[${idx}].maxBorrowAmount must be a positive number (fixed amount, not percentage)`);
                        }
                    }

                    // maxBorrowAmountPerOperation: optional, must be a fixed positive number
                    if ('maxBorrowAmountPerOperation' in item) {
                        if (!isPositiveNumber(item.maxBorrowAmountPerOperation)) {
                            problems.push(`debtPolicy.lending[${idx}].maxBorrowAmountPerOperation must be a positive number`);
                        }
                    }

                    // maxCollateralAmount: optional, positive number or percentage
                    if ('maxCollateralAmount' in item && !isPositiveNumberOrPercent(item.maxCollateralAmount)) {
                        problems.push(`debtPolicy.lending[${idx}].maxCollateralAmount must be a positive number or percentage`);
                    }

                    if ('minCollateralIncreaseThreshold' in item) {
                        const referenceAmount = typeof item.minCollateralIncreaseThreshold === 'string' && item.minCollateralIncreaseThreshold.trim().endsWith('%')
                            ? 1
                            : null;
                        if (resolveMinCollateralIncreaseThreshold(item.minCollateralIncreaseThreshold, referenceAmount) === null) {
                            problems.push(`debtPolicy.lending[${idx}].minCollateralIncreaseThreshold must be a non-negative number or percentage`);
                        }
                    }

                    if (item.type === 'mpa') {
                        // MPA-specific validation (maxCollateralRatio is optional for MPA)
                        if ('targetCollateralRatio' in item) {
                            const tcr = Number(item.targetCollateralRatio);
                            if (!Number.isFinite(tcr) || tcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].targetCollateralRatio must be a positive number`);
                            }
                        }
                        if ('minCollateralRatio' in item) {
                            const mcr = Number(item.minCollateralRatio);
                            if (!Number.isFinite(mcr) || mcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].minCollateralRatio must be a positive number`);
                            }
                        }
                        if ('maxCollateralRatio' in item) {
                            const mxcr = Number(item.maxCollateralRatio);
                            if (!Number.isFinite(mxcr) || mxcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio must be a positive number`);
                            }
                        }
                        if ('minCollateralRatio' in item && 'maxCollateralRatio' in item) {
                            const mcr = Number(item.minCollateralRatio);
                            const mxcr = Number(item.maxCollateralRatio);
                            if (Number.isFinite(mcr) && Number.isFinite(mxcr) && mcr > mxcr) {
                                problems.push(`debtPolicy.lending[${idx}].minCollateralRatio (${mcr}) cannot exceed maxCollateralRatio (${mxcr})`);
                            }
                        }
                        if ('debtOnly' in item && typeof item.debtOnly !== 'boolean') {
                            problems.push(`debtPolicy.lending[${idx}].debtOnly must be a boolean`);
                        }
                    } else if (item.type === 'creditOffer') {
                        // Credit offer-specific validation (maxCollateralRatio is required)
                        if (!('maxCollateralRatio' in item)) {
                            problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio is required for creditOffer`);
                        } else {
                            const mxcr = Number(item.maxCollateralRatio);
                            if (!Number.isFinite(mxcr) || mxcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio must be a positive number`);
                            }
                        }
                        if ('maxFeeRatePerDay' in item) {
                            const fr = Number(item.maxFeeRatePerDay);
                            if (!Number.isFinite(fr) || fr < 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxFeeRatePerDay must be a non-negative number`);
                            }
                        }
                        if ('autoRepay' in item) {
                            const ar = Number(item.autoRepay);
                            if (![0, 1, 2].includes(ar)) {
                                problems.push(`debtPolicy.lending[${idx}].autoRepay must be 0, 1, or 2`);
                            }
                        }
                        if ('renewOnly' in item && typeof item.renewOnly !== 'boolean') {
                            problems.push(`debtPolicy.lending[${idx}].renewOnly must be a boolean`);
                        }
                        if ('useFreeCollateral' in item && typeof item.useFreeCollateral !== 'boolean') {
                            problems.push(`debtPolicy.lending[${idx}].useFreeCollateral must be a boolean`);
                        }
                        if ('allowedOfferIds' in item) {
                            if (!Array.isArray(item.allowedOfferIds)) {
                                problems.push(`debtPolicy.lending[${idx}].allowedOfferIds must be an array`);
                            }
                        }
                        if ('disallowedDealIds' in item) {
                            if (!Array.isArray(item.disallowedDealIds)) {
                                problems.push(`debtPolicy.lending[${idx}].disallowedDealIds must be an array`);
                            }
                        }
                    }
                });
            }

            // Global maxCollateralAmount: optional, caps total collateral across all lending items
            if ('maxCollateralAmount' in dp && !isPositiveNumberOrPercent(dp.maxCollateralAmount)) {
                problems.push("debtPolicy.maxCollateralAmount must be a positive number or percentage");
            }
        }
    }

    if (problems.length) {
        const name = b.name || `<unnamed-${i}>`;
        return `Bot[${i}] '${name}' (${src}) -> ${problems.join('; ')}`;
    }
    return null;
}

function collectValidationIssues(entries: BotEntry[], sourceName: string): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    entries.forEach((entry, index) => {
        const issue = validateBotEntry(entry, index, sourceName);
        if (issue) {
            if (entry.active) errors.push(issue);
            else warnings.push(issue);
        }
    });

    // Cross-bot validation: check for duplicate botKeys (sanitized names)
    for (const duplicateIssue of findDuplicateBotKeyIssues(entries)) {
        errors.push(duplicateIssue);
    }

    // Cross-bot validation: check if botFunds percentages sum > 100% per account
    const accountFunds: Record<string, { buy: number; sell: number; botNames: string[] }> = {};
    for (const entry of entries) {
        const account = entry.preferredAccount;
        if (!entry.active || !account || !entry.botFunds) continue;
        if (!accountFunds[account]) {
            accountFunds[account] = { buy: 0, sell: 0, botNames: [] };
        }
        const acc = accountFunds[account];
        acc.buy += toDecimal(entry.botFunds.buy);
        acc.sell += toDecimal(entry.botFunds.sell);
        acc.botNames.push(entry.name || entry.botKey || `bot-${entries.indexOf(entry)}`);
    }
    for (const [account, funds] of Object.entries(accountFunds)) {
        if (funds.botNames.length > 1) {
            if (funds.buy > 1) {
                warnings.push(
                    `[SHARED ACCOUNT] '${account}': bots [${funds.botNames.join(', ')}] allocate ` +
                    `${(funds.buy * 100).toFixed(0)}% of BUY funds (>100%). ` +
                    `Each bot will receive a proportional share (myPct / totalPct × chainBalance).`
                );
            }
            if (funds.sell > 1) {
                warnings.push(
                    `[SHARED ACCOUNT] '${account}': bots [${funds.botNames.join(', ')}] allocate ` +
                    `${(funds.sell * 100).toFixed(0)}% of SELL funds (>100%). ` +
                    `Each bot will receive a proportional share (myPct / totalPct × chainBalance).`
                );
            }
        }
    }

    return { errors, warnings };
}

function findDuplicateBotKeyIssues(entries: BotEntry[]): string[] {
    const seenKeys = new Map<string, number>();
    const duplicates: string[] = [];
    entries.forEach((entry, index) => {
        if (!entry.name) return;
        const key = createBotKey(entry, index);
        const existing = seenKeys.get(key);
        if (existing !== undefined) {
            duplicates.push(
                `Bot[${existing}] '${entries[existing].name}' and Bot[${index}] '${entry.name}' ` +
                `both produce botKey '${key}' — bot names must be unique.`
            );
        } else {
            seenKeys.set(key, index);
        }
    });
    return duplicates;
}

function assertNoDuplicateBotKeys(entries: BotEntry[], sourceName: string): void {
    const duplicates = findDuplicateBotKeyIssues(entries);
    if (duplicates.length > 0) {
        throw new Error(`Duplicate bot name(s) in ${sourceName}:\n${duplicates.map((e) => `  - ${e}`).join('\n')}`);
    }
}

export { assertNoDuplicateBotKeys, collectValidationIssues, loadSettingsFile, normalizeBotEntry, normalizeBotEntries, resolveRawBotEntries, saveSettingsFile, selectActiveBotEntries, selectBotEntry, validateBotEntry }


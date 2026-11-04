/**
 * modules/account_bots.ts - Bot Configuration Management
 *
 * Interactive CLI helper for editing bot profiles in profiles/bots.json.
 * Manages multi-bot configuration and metadata.
 *
 * ===============================================================================
 * EXPORTS (12 functions)
 * ===============================================================================
 *
 * MAIN ENTRY POINT:
 *   main() - Interactive CLI for bot configuration management
 *     Lists bots, allows add/edit/delete/activate operations
 *     Loads and saves profiles/bots.json
 *
 *   normalizeBotDraft(base) - Normalize a bot configuration draft
 *     Applies defaults and validation to raw bot config entries
 *
 *   loadGeneralSettings() - Load profiles/general.settings.json
 *
 * SUPPORTING EXPORTS:
 *   ensureBotAccountId, parseJsonWithComments, parseBooleanInput,
 *   colorGridPriceValue, formatPoolRefLabel, isPoolStartPrice,
 *   isPoolRefClearInput, resolveAdapterCommitPlan, sameAdapterFlags
 *
 * INTERNAL HELPERS (not exported):
 *   ask* prompt family (askString, askNumberWithBounds, askIntegerInRange,
 *   askNumberOrMultiplier, askNumberOrPercentage, askAsset, askAssetB,
 *   askStartPrice, askGridPriceMode, askPoolRef, askTargetSpreadPercent,
 *   askMaxPrice, askWeightDistribution, askWeightDistributionNoLegend,
 *   askLogLevel, askUpdaterBranch, askCronSchedule, askBoolean),
 *   loadBotsConfig, saveBotsConfig, listBots, selectBotIndex,
 *   saveGeneralSettings, isMultiplierString,
 *   colorPriceRangeValue, colorMultiplierInput,
 *   isPercentageString, colorPercentageInput,
 *   isDynamicPriceSource, colorStartPriceValue,
 *   colorBooleanFlag,
 *   parseCronToDelta, deltaToCron,
 *   normalizePercentageInput, promptBotData, promptGeneralSettings
 *
 * ===============================================================================
 *
 * BOT CONFIGURATION (profiles/bots.json):
 * {
 *   "bots": [
 *     {
 *       "name": "BTS/USD",
 *       "preferredAccount": "my-account",
 *       "assetA": "BTS",
 *       "assetB": "USD",
 *       "active": true,
 *       "dryRun": false,
 *       "startPrice": "pool",      // Price for order alignment: "pool", "book", or numeric
 *       "gridPrice": "ama3",       // Reference price for x-factor bounds (default "ama3"):
 *                                  //   "ama"/"ama1".."ama4" = market adapter writes a center snapshot to
 *                                  //              profiles/orders/<botKey>.dynamicgrid.json; grid reads the effective center on reset
 *                                  //   "pool" / "book" = live pair price reference (legacy, editor no longer offers it)
 *                                  //   <number> = fixed numeric reference (legacy)
 *                                  //   null     = use startPrice (legacy); also accepted: false, empty/blank,
 *                                  //              and the "none"/"null"/"start"/"startprice"/"s"/"n"/"no"/"f"/"0" spellings
 *       "minPrice": "2x",
 *       "maxPrice": "2x",
 *       "incrementPercent": 0.5,
 *       "targetSpreadPercent": 2,
 *       "weightDistribution": { "sell": 1, "buy": 1 },
 *       "botFunds": { "sell": "100%", "buy": "100%" },
 *       "coreOrders": { "sell": 20, "buy": 20 },
 *       "edgeOrders": { "buy": 0, "sell": 0 },  // Edge orders: extra live orders (buy: floor, sell: ceiling)
 *       "poolRef": null,              // Optional pinned pool ID for startPrice "pool"
 *       "debtPolicy": { ... },        // MPA/credit lending policy — docs/MPA_CREDIT_USAGE.md
 *       "min_BTS_value": 0,           // Minimum BTS value threshold for operations
 *     }
 *   ]
 * }
 *
 * GLOBAL SETTINGS CONFIGURATION (profiles/general.settings.json):
 * {
 *   "MARKET_ADAPTER": {
 *     "AMA_DELTA_THRESHOLD_PERCENT": 2  // % change in AMA center price triggers grid reset
 *   },
 *   "GRID_LIMITS": {
 *     "GRID_COMPARISON": {
 *       "RMS_PERCENTAGE": 14.3  // RMS divergence threshold triggers grid reset (set to 0 to disable)
 *     }
 *   }
 * }
 *
 * ===============================================================================
 */


import { path } from './path_api.js';
import { getStorage } from './storage/index.js';
import { ensureProfilesDirectory, readInput, sleep } from './order/utils/system.js';
import { setGlobalConsoleLevel, getGlobalConsoleLevel } from './order/logger.js';
import { GRID_LIMITS, RANGE_QUALITY, MARKET_ADAPTER, NODE_MANAGEMENT, INCREMENT_BOUNDS, buildDefaultGeneralSettings } from './constants.js';
import { seedBotDraft, isUnsetGridPrice } from './bot_defaults.js';
import { PATHS } from './paths.js';
import { SETTINGS_FILE, readGeneralSettings, writeGeneralSettings } from './general_settings.js';
import { parseJsonWithComments } from './order/utils/system.js';
import { assertNoDuplicateBotKeys, loadSettingsFile, normalizeBotEntry } from './bot_settings.js';
import type { BotEntry, BotSettingsFile } from './bot_settings.js';
import type { UnknownRecord } from './types.js';
import { getWhitelistFlags, hasWhitelistEntry, setWhitelistFlags, renameWhitelistEntry, removeWhitelistEntry, whitelistFile, AMA_ONLY_WHITELIST_FLAGS } from './market_adapter_whitelist.js';
import { BOT_LIVE_CONFIG_KEYS } from './runtime_settings.js';
import { mergeSettings } from './settings_merge.js';
import { getErrorMessage, getErrorCode } from './utils/errors.js';
import { normalizeAssetSymbol } from './utils/asset_symbols.js';
import { roundToDecimals, parseRelativeMultiplier } from './order/utils/math.js';
import { CLI_COLORS } from './cli_colors.js';
import { displayWidth, padDisplay } from './utils/text_width.js';
const storage = getStorage();
const { writeJSON } = storage;


const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const PROFILES_DIR = PATHS.PROFILES_DIR;
// Editor palette: values come from the centralized CLI_COLORS module
// (rendered output unchanged).
const COLORS = {
    reset: CLI_COLORS.reset,
    bold: CLI_COLORS.bold,
    white: CLI_COLORS.white,
    gray: CLI_COLORS.silver,
    blue: CLI_COLORS.blue,
    cyan: CLI_COLORS.sky,
    orange: CLI_COLORS.orange,
    yellow: CLI_COLORS.yellow,
    yellowBold: CLI_COLORS.yellowBold,
    green: CLI_COLORS.buy,
    greenBold: CLI_COLORS.greenBold,
    red: CLI_COLORS.boldRed,
    redStrong: CLI_COLORS.redStrong
};

/**
 * Loads the bots configuration from profiles/bots.json.
 * @returns {Object} An object containing the config and the file path.
 */
function loadBotsConfig(): { config: BotSettingsFile & { bots: BotEntry[] }; filePath: string } {
    const { config, filePath } = loadSettingsFile(BOTS_FILE, { silent: true, exitOnError: false });
    if (!config || typeof config !== 'object') return { config: { bots: [] }, filePath };
    if (!Array.isArray(config.bots)) config.bots = [];
    return { config: config as BotSettingsFile & { bots: BotEntry[] }, filePath };
}

/**
 * Saves the bots configuration to the specified file path.
 * @param {Object} config - The configuration object to save.
 * @param {string} filePath - The path to the file.
 * @throws {Error} If saving fails.
 */
function saveBotsConfig(config: unknown, filePath: string): void {
    try {
        ensureProfilesDirectory(PROFILES_DIR);
        const c = config as { bots?: unknown } | null;
        const entries = Array.isArray(c?.bots) ? c.bots : Array.isArray(config) ? config : [];
        if (entries.length >= 2) assertNoDuplicateBotKeys(entries, 'account_bots');
        writeJSON(filePath, config);
    } catch (err) {
        console.error('Failed to save bots configuration:', getErrorMessage(err));
        throw err;
    }
}

/**
 * Loads general settings from profiles/general.settings.json.
 * Delegates all merge logic to mergeSettings() in settings_merge.ts,
 * which handles per-section strategies, NODES⇄NODE_MANAGEMENT mapping,
 * and passthrough of unmapped NODES sub-keys.
 * @returns {Object} The loaded settings or default settings if the file doesn't exist.
 */
function loadGeneralSettings() {
    // Single canonical defaults document (modules/constants.ts) — same source
    // the first-run generator and the local-overrides merge use.
    const defaults = buildDefaultGeneralSettings();

    const settings = readGeneralSettings({
        fallback: null,
        onError: (err: unknown) => {
            console.error('Failed to load general settings:', getErrorMessage(err));
        }
    });

    const merged = mergeSettings(settings, defaults);

    // MARKET_ADAPTER validation for AMA_DELTA_THRESHOLD_PERCENT
    const configuredDeltaPercent = Number(merged.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT);
    const effectiveDeltaPercent = Number.isFinite(configuredDeltaPercent) && configuredDeltaPercent > 0
        ? configuredDeltaPercent
        : MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT;
    merged.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT = effectiveDeltaPercent;

    // MARKET_ADAPTER validation for AMA_SLOPE_DELTA_THRESHOLD_PERCENT (the
    // slope trigger factor: (value/100) x maxSlopePct). Same >0 guard so a
    // hand-edited 0/negative/NaN can never disable the slope reset silently.
    const configuredSlopeDeltaPercent = Number(merged.MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT);
    const effectiveSlopeDeltaPercent = Number.isFinite(configuredSlopeDeltaPercent) && configuredSlopeDeltaPercent > 0
        ? configuredSlopeDeltaPercent
        : MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT;
    merged.MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT = effectiveSlopeDeltaPercent;

    return merged;
}

/**
 * Saves general settings to profiles/general.settings.json.
 * @param {Object} settings - The settings object to save.
 */
function saveGeneralSettings(settings: Parameters<typeof writeGeneralSettings>[0]): void {
    try {
        writeGeneralSettings(settings);
        console.log(`\n✓ General settings saved to ${path.basename(SETTINGS_FILE)}`);
    } catch (err) {
        console.error('Failed to save general settings:', getErrorMessage(err));
    }
}

/**
 * Lists the configured bots to the console.
 * @param {Array<Object>} bots - The list of bot configuration objects.
 */
function listBots(bots: BotEntry[]): void {
    if (!bots.length) {
        console.log('  (no bot entries defined yet)');
        return;
    }
    const rows = bots.map((bot: BotEntry, index: number) => ({
        index: String(index + 1),
        name: bot.name || `<unnamed-${index + 1}>`,
        account: bot.preferredAccount || '?',
        pair: `${bot.assetA || '?'}/${bot.assetB || '?'}`,
        inactive: bot.active === false,
        dryRun: !!bot.dryRun
    }));
    const indexWidth = Math.max(1, ...rows.map(r => r.index.length));
    const nameWidth = Math.max('Name'.length, ...rows.map(r => displayWidth(r.name)));
    const accountWidth = Math.max('Account'.length, ...rows.map(r => displayWidth(r.account)));
    const pairWidth = Math.max('Pair'.length, ...rows.map(r => displayWidth(r.pair)));
    const header = [
        '#'.padEnd(indexWidth),
        padDisplay('Name', nameWidth),
        padDisplay('Account', accountWidth),
        padDisplay('Pair', pairWidth)
    ].join('  ');
    console.log(`  ${COLORS.yellowBold}${header}${COLORS.reset}`);
    for (const row of rows) {
        const flags = `${row.inactive ? ` ${COLORS.red}[inactive]${COLORS.reset}` : ''}${row.dryRun ? ` ${COLORS.yellow}(dryRun)${COLORS.reset}` : ''}`;
        console.log(
            `  ${COLORS.gray}${row.index.padEnd(indexWidth)}${COLORS.reset}  ` +
            `${COLORS.green}${padDisplay(row.name, nameWidth)}${COLORS.reset}  ` +
            `${COLORS.orange}${padDisplay(row.account, accountWidth)}${COLORS.reset}  ` +
            `${COLORS.cyan}${padDisplay(row.pair, pairWidth)}${COLORS.reset}${flags}`
        );
    }
}

/**
 * Prompts the user to select a bot from the list.
 * @param {Array<Object>} bots - The list of bots.
 * @param {string} promptMessage - The message to display.
 * @returns {Promise<number|string|null>} The selected index, '\x1b' if ESC, or null if invalid.
 */
async function selectBotIndex(bots: BotEntry[], promptMessage: string): Promise<number | '\x1b' | null> {
    if (!bots.length) return null;
    listBots(bots);
    const raw = (await readInput(`${promptMessage} [1-${bots.length}]: `)).trim();
    if (raw === '\x1b') return '\x1b';
    const idx = Number(raw);
    if (Number.isNaN(idx) || idx < 1 || idx > bots.length) {
        if (raw !== '') console.log('Invalid selection.');
        return null;
    }
    return idx - 1;
}

/**
 * Prompts the user for a string input.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The user input or default value.
 */
async function askString(promptText: string, defaultValue?: string): Promise<string | undefined> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const answer = await readInput(`${promptText}${suffix}: `);
    if (answer === '\x1b') return '\x1b';
    if (!answer) return defaultValue;
    return answer.trim();
}

/**
 * Prompts the user for a required string input.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askRequiredString(promptText: string, defaultValue?: string): Promise<string> {
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        if (value && value.trim()) return value.trim();
        console.log('This field is required.');
    }
}

/**
 * Prompts the user for a cron schedule using interval and time.
 * @param {string} _promptText - Unused; the prompt text is built below.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askCronSchedule(_promptText: string, defaultValue: string): Promise<string> {
    const current = parseCronToDelta(defaultValue);

    // Interval Prompt
    const days = await askNumberWithBounds('  Interval (days)', current.days, 1, 31);
    if (days === '\x1b' || typeof days !== 'number') return '\x1b';

    // Time Prompt
    let time = current.time;
    while (true) {
        const rawTime = await askString('  Time (HH:mm)', current.time);
        if (rawTime === '\x1b') return '\x1b';
        if (rawTime && /^([01]\d|2[0-3]):([0-5]\d)$/.test(rawTime)) {
            time = rawTime;
            break;
        }
        console.log('  Invalid time format. Use HH:mm (24h)');
    }

    return deltaToCron(days, time);
}

/**
 * Prompts the user for a branch and validates it.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askUpdaterBranch(promptText: string, defaultValue: string): Promise<string> {
    const validBranches = ['main', 'dev', 'test', 'auto'];
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = (value ?? '').toLowerCase().trim();
        if (validBranches.includes(lowered)) return lowered;
        console.log(`Invalid branch. Please choose from: ${validBranches.join(', ')}`);
    }
}

/**
 * Prompts the user for a log level and validates it.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askLogLevel(promptText: string, defaultValue: string): Promise<string> {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    while (true) {
        console.log(`Available levels: ${validLevels.join(', ')}`);
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = (value ?? '').toLowerCase().trim();
        if (validLevels.includes(lowered)) return lowered;
        console.log(`Invalid log level. Please choose from: ${validLevels.join(', ')}`);
    }
}

/**
 * Shared asset-symbol input loop: handles ESC, the empty-input default, and
 * normalizeAssetSymbol. An optional `validate` callback may reject a
 * normalized symbol by returning a message to print.
 */
async function askAssetSymbol(
    promptText: string,
    defaultValue?: string,
    validate?: (asset: string) => string | null,
): Promise<string> {
    while (true) {
        const displayDefault = defaultValue ? normalizeAssetSymbol(defaultValue) : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        const answer = await readInput(`${promptText}${suffix}: `);
        if (answer === '\x1b') return '\x1b';

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        const asset = normalizeAssetSymbol(answer);
        const reason = validate ? validate(asset) : null;
        if (reason) {
            console.log(reason);
            continue;
        }
        return asset;
    }
}

/**
 * Prompts the user for an asset symbol.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAsset(promptText: string, defaultValue?: string): Promise<string> {
    return askAssetSymbol(promptText, defaultValue);
}

/**
 * Prompts the user for Asset B, ensuring it's different from Asset A.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @param {string} assetA - The symbol of Asset A.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAssetB(promptText: string, defaultValue?: string, assetA?: string): Promise<string> {
    return askAssetSymbol(promptText, defaultValue, (assetB) =>
        assetB === assetA ? `Invalid: Asset B cannot be the same as Asset A (${assetA})` : null);
}

/**
 * Prompts the user for a weight distribution value, optionally printing the
 * value legend above the prompt.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {boolean} showLegend - Print the -1..2 legend line before prompting.
 * @returns {Promise<number|string|undefined>} The numeric value, '\x1b' if ESC, or undefined.
 */
async function askWeightDistributionValue(promptText: string, defaultValue: number | undefined, showLegend: boolean): Promise<number | string | undefined> {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    if (showLegend) {
        console.log(`  ${COLORS.cyan}-1=SuperValley${COLORS.reset} ←→ ${COLORS.blue}0=Valley${COLORS.reset} ←→ ${COLORS.gray}0.5=Neutral${COLORS.reset} ←→ ${COLORS.bold}${COLORS.orange}1=Mountain${COLORS.reset} ←→ ${COLORS.redStrong}2=SuperMountain${COLORS.reset}`);
    }
    return askNumeric(promptText, defaultValue, (parsed) =>
        parsed < MIN_WEIGHT || parsed > MAX_WEIGHT ? `Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.` : null);
}

/**
 * Prompts the user for a weight distribution value with a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string|undefined>} The numeric value, '\x1b' if ESC, or undefined.
 */
async function askWeightDistribution(promptText: string, defaultValue?: number): Promise<number | string | undefined> {
    return askWeightDistributionValue(promptText, defaultValue, true);
}

/**
 * Prompts the user for a weight distribution value without a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string|undefined>} The numeric value, '\x1b' if ESC, or undefined.
 */
async function askWeightDistributionNoLegend(promptText: string, defaultValue?: number): Promise<number | string | undefined> {
    return askWeightDistributionValue(promptText, defaultValue, false);
}

/**
 * Checks if a value is a multiplier string (e.g. "3x").
 * Delegates to the shared parser so the editor and the runtime resolver
 * agree on the exact same syntax (issue #15).
 * @param {*} value - The value to check.
 * @returns {boolean} True if it's a multiplier string.
 */
function isMultiplierString(value: unknown): boolean {
    return parseRelativeMultiplier(value) !== null;
}

/**
 * Colors a price value string for display: green when it is a relative
 * multiplier > 1x ("1.55x"), red when it is either a fixed price (no
 * relative scaling) or a sub-1x multiplier that resolves to the wrong side
 * of the grid ("0.7x" => 1.43x center).
 * Used for live input feedback: turns green the moment the "x" is typed.
 * @param {string} value - The value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorMultiplierInput(value: string): string {
    if (isMultiplierString(value)) {
        const m = parseRelativeMultiplier(value);
        // A bound multiplier < 1 resolves to the wrong side of the grid
        // ("0.7x" => 1.43x center), so flag it red like a fixed/non-relative
        // value rather than the usual "valid" green (issue #15).
        if (m !== null && m < 1) return `${COLORS.red}${value}${COLORS.reset}`;
        return `${COLORS.green}${value}${COLORS.reset}`;
    }
    return `${COLORS.red}${value}${COLORS.reset}`;
}

/**
 * Checks if a value is a percentage string (e.g. "50%").
 * @param {*} value - The value to check.
 * @returns {boolean} True if it's a percentage string.
 */
function isPercentageString(value: unknown): boolean {
    return typeof value === 'string' && /^[-+]?[0-9]+(?:\.[0-9]+)?%$/.test(value.trim());
}

/**
 * Colors a funds value string for display: green when it is a relative
 * percentage ("100%"), red when it is a fixed amount (no relative scaling).
 * Used for live input feedback: turns green the moment the "%" is typed.
 * @param {string} value - The value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorPercentageInput(value: unknown): string {
    if (isPercentageString(value)) return `${COLORS.green}${value}${COLORS.reset}`;
    return `${COLORS.red}${value}${COLORS.reset}`;
}

/**
 * Colors a price range value for display: green when it is a relative
 * multiplier > 1x ("1.55x"), red when it is either a fixed price (no
 * relative scaling) or a sub-1x multiplier resolving to the wrong side of
 * the grid (issue #15).
 * @param {*} value - The value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorPriceRangeValue(value: unknown): string {
    return colorRangeValueByQuality(String(value));
}

/**
 * Returns quality tier for a range multiplier: green/yellow/orange/red/fixed.
 * Thresholds come from RANGE_QUALITY in modules/constants.ts (single source of truth).
 * @param {*} value - Raw range value (e.g. "2x" or numeric).
 * @returns {string} Tier key.
 */
function getRangeQuality(value: unknown): string {
    const m = parseRelativeMultiplier(value);
    if (m === null) return 'fixed';
    if (m >= RANGE_QUALITY.GREEN_MIN) return 'green';
    if (m >= RANGE_QUALITY.YELLOW_MIN) return 'yellow';
    if (m < RANGE_QUALITY.RED_MAX) return 'red';
    if (m >= RANGE_QUALITY.ORANGE_MIN) return 'orange';
    return 'orange';
}

/**
 * Colors a range value by quality tier (mountain-style legend).
 * Tiers come from RANGE_QUALITY in modules/constants.ts (single source of truth).
 * @param {string} value - Raw value string.
 * @returns {string} ANSI-colored value.
 */
function colorRangeValueByQuality(value: string): string {
    // retain colorMultiplierInput for fixed-value fallback compatibility
    void colorMultiplierInput;
    const tier = getRangeQuality(value);
    if (tier === 'green') return `${COLORS.green}${value}${COLORS.reset}`;
    if (tier === 'yellow') return `${COLORS.yellowBold}${value}${COLORS.reset}`;
    if (tier === 'orange') return `${COLORS.orange}${value}${COLORS.reset}`;
    return `${COLORS.red}${value}${COLORS.reset}`;
}

/**
 * Prints pre-entry legend for Range inputs (mirrors weight mountain legend).
 */
function printRangeQualityLegend(): void {
    const fmt = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));
    console.log(`  ${COLORS.green}≥${fmt(RANGE_QUALITY.GREEN_MIN)}x: wide${COLORS.reset} ←→ ${COLORS.yellowBold}≥${fmt(RANGE_QUALITY.YELLOW_MIN)}x: effeciant${COLORS.reset} ←→ ${COLORS.orange}≥${fmt(RANGE_QUALITY.ORANGE_MIN)}x: tight${COLORS.reset} ←→ ${COLORS.red}<${fmt(RANGE_QUALITY.RED_MAX)}x: suizidal${COLORS.reset}`);
}

/**
 * Checks if a value is a dynamic price source ("pool", "book", or an AMA
 * keyword such as "ama" / "ama1".."ama4").
 * @param {*} value - The value to check.
 * @returns {boolean} True if it is a dynamic price source string.
 */
function isDynamicPriceSource(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const lower = value.trim().toLowerCase();
    return lower === 'pool' || lower === 'book' || /^ama(?:[1-4])?$/.test(lower);
}

/**
 * AMA grid-price values: the four explicit presets ama1..ama4 plus bare
 * "ama" (the pair's default preset). Bare "ama" is a valid green value but is
 * deliberately not listed in the prompt label. These are the ONLY values that
 * color green — pool/book/numeric/none stay accepted, just displayed red.
 */
const AMA_GRID_PRICE_PATTERN = /^ama(?:[1-4])?$/;

/**
 * Colors a start-price value for display: green when it is a dynamic source
 * ("pool"/"book"), red when it is a fixed numeric price (no live rescaling).
 * Used for live input feedback: turns green the moment a source keyword is typed.
 * @param {*} value - The start price value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorStartPriceValue(value: unknown): string {
    const text = String(value ?? '');
    if (isDynamicPriceSource(text)) return `${COLORS.green}${text}${COLORS.reset}`;
    return `${COLORS.red}${text}${COLORS.reset}`;
}

/**
 * Colors a grid-price value for display: GREEN only for AMA values
 * ("ama"/"ama1".."ama4"), RED for everything else — pool/book references,
 * numeric values and any unset grid price (null, false, blank/whitespace, and
 * the "none"/"s"/"no"/"f"/"start" aliases) which delegates to startPrice and is
 * therefore labeled "startPrice", always in red: the delegation itself is the
 * thing the editor wants replaced by an AMA preset.
 * @param {*} value - The grid price value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorGridPriceValue(value: unknown): string {
    if (isUnsetGridPrice(value)) {
        return `${COLORS.red}startPrice${COLORS.reset}`;
    }
    const text = String(value);
    if (AMA_GRID_PRICE_PATTERN.test(text.trim().toLowerCase())) return `${COLORS.green}${text}${COLORS.reset}`;
    return `${COLORS.red}${text}${COLORS.reset}`;
}

/**
 * True when a startPrice value selects the pair's automatically-resolved pool
 * (the "default" pool source, as opposed to a hand-pinned poolRef).
 * @param {*} value - A startPrice value (or any value to test).
 * @returns {boolean}
 */
function isPoolStartPrice(value: unknown): boolean {
    return String(value ?? '').trim().toLowerCase() === 'pool';
}

/**
 * True when the draft's startPrice resolves to the pair's default pool and no
 * poolRef is pinned, so the runtime auto-selects it for order alignment.
 * Deliberately NOT keyed on gridPrice === "pool": anchoring the grid reference
 * on the live market price is discouraged and stays red in the GridPrice
 * field, so the Pool label must not read as a green healthy default for that
 * case.
 * @param {*} data - The bot draft.
 * @returns {boolean}
 */
function startPriceUsesDefaultPool(data: { startPrice?: unknown } | null | undefined): boolean {
    return isPoolStartPrice(data?.startPrice);
}

/**
 * Colors the pool label for the editor summary. An unset poolRef does NOT
 * mean "no pool": when startPrice is "pool" the runtime auto-selects the
 * pair's default pool, so it reads green `default`. Otherwise the pin is
 * inert, shown as grey `none` so it does not compete with live values (a
 * gridPrice of "pool"/"book" is discouraged and stays red in its own field).
 * Display only — the stored poolRef is never changed here.
 * @param {*} data - The bot draft.
 * @returns {string} ANSI-colored pinned pool ID, `default` (green), or `none` (grey).
 */
function formatPoolRefLabel(data: { poolRef?: unknown; startPrice?: unknown } | null | undefined): string {
    // A pin only applies to startPrice "pool"; show it as ignored otherwise
    // so the summary never displays a value the editor no longer asks for.
    if (data?.poolRef && !startPriceUsesDefaultPool(data)) return `${COLORS.gray}ignored${COLORS.reset}`;
    if (data?.poolRef) return String(data.poolRef);
    if (startPriceUsesDefaultPool(data)) return `${COLORS.green}default${COLORS.reset}`;
    return `${COLORS.gray}none${COLORS.reset}`;
}

/**
 * Colors a boolean flag value for display: green when the flag is in its
 * healthy state, red when it is not.
 * @param {*} value - The boolean value to color.
 * @param {boolean} greenWhenTrue - True when `true` is the healthy state
 *                                   (e.g. Active), false when `false` is
 *                                   healthy (e.g. DryRun off).
 * @param {string} [offColor] - Color for the unhealthy value (default red);
 *                              pass a warn color for flags that are optional.
 * @returns {string} ANSI-colored "true"/"false" string.
 */
function colorBooleanFlag(value: unknown, greenWhenTrue: boolean, offColor: string = COLORS.red): string {
    const isTrue = !!value;
    const healthy = greenWhenTrue ? isTrue : !isTrue;
    const text = String(isTrue);
    return healthy ? `${COLORS.green}${text}${COLORS.reset}` : `${offColor}${text}${COLORS.reset}`;
}

/**
 * Converts a cron string to a readable format (days delta and time).
 * Only supports simple daily/multi-day patterns like "0 0 * /N * *".
 * @param {string} cron
 * @returns {Object} { days, time }
 */
function parseCronToDelta(cron: string): { days: number; time: string } {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return { days: 1, time: '00:00' };

    const min = parts[0].padStart(2, '0');
    const hour = parts[1].padStart(2, '0');
    let days = 1;

    if (parts[2].startsWith('*/')) {
        days = parseInt(parts[2].substring(2)) || 1;
    } else if (parts[2] === '*') {
        days = 1;
    }

    return { days, time: `${hour}:${min}` };
}

/**
 * Converts days delta and time to a cron string.
 * @param {number} days
 * @param {string} time - format "HH:mm"
 * @returns {string} cron string
 */
function deltaToCron(days: number, time: string): string {
    const [hour, min] = time.split(':').map((s: string) => parseInt(s));
    const dayPart = days > 1 ? `*/${days}` : '*';
    return `${min} ${hour} ${dayPart} * *`;
}

/**
 * Shared numeric-input loop: handles ESC and the empty-input default, then
 * delegates domain validation to `validate`. `validate` returns an error
 * message to print and retry, or null to accept the parsed value.
 */
async function askNumeric(
    promptText: string,
    defaultValue: number | undefined,
    validate: (parsed: number) => string | null,
): Promise<number | string | undefined> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumeric(promptText, defaultValue, validate);
    }
    const reason = validate(parsed);
    if (reason) {
        console.log(reason);
        return askNumeric(promptText, defaultValue, validate);
    }
    return parsed;
}

/**
 * Shared prompt loop for the typed-input family (multiplier / percentage /
 * start-price prompts): renders the default suffix, handles ESC and the empty
 * default, and prints-and-retries on rejection. `parse` maps non-empty input
 * to `{ value }` or `{ error }` (the message to print before re-prompting).
 */
interface AskTypedOptions<T> {
    promptText: string;
    defaultValue?: T;
    onBeforePrompt?: () => void;
    formatDefault?: (value: T) => string;
    colorize?: (input: string) => string;
    parse: (raw: string) => { value: T } | { error: string };
}

async function askTypedInput<T>(options: AskTypedOptions<T>): Promise<T | '\x1b' | undefined> {
    options.onBeforePrompt?.();
    const { promptText, defaultValue } = options;
    const shown = defaultValue !== undefined && defaultValue !== null
        ? ` [${options.formatDefault ? options.formatDefault(defaultValue) : String(defaultValue)}]`
        : '';
    const raw = (await readInput(`${promptText}${shown}: `, options.colorize ? { colorize: options.colorize } : {})).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const result = options.parse(raw);
    if ('error' in result) {
        console.log(result.error);
        return askTypedInput(options);
    }
    return result.value;
}

/**
 * Prompts the user for a number within specified bounds.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {number} minVal - The minimum allowed value.
 * @param {number} maxVal - The maximum allowed value.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askNumberWithBounds(promptText: string, defaultValue?: number, minVal: number = 0, maxVal: number = 100): Promise<number | string | undefined> {
    return askNumeric(promptText, defaultValue, (parsed) => {
        // Validate that number is finite (not Infinity, -Infinity, or NaN)
        if (!Number.isFinite(parsed)) return 'Please enter a valid finite number.';
        // Validate bounds
        if (parsed < minVal) return `Invalid ${promptText}: ${parsed}. Must be >= ${minVal}`;
        if (parsed > maxVal) return `Invalid ${promptText}: ${parsed}. Must be <= ${maxVal}`;
        return null;
    });
}

/**
 * Prompts the user for the target spread percentage.
 * Values are rounded to two decimal places: the displayed minimum, the
 * validation threshold, and the returned value all share cent precision.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {number} incrementPercent - The grid increment percentage.
 * @param {number} minSpreadFactor - The minimum spread factor from GRID_LIMITS.
 * @returns {Promise<number|string>} The spread percentage or '\x1b' if ESC.
 */
async function askTargetSpreadPercent(promptText: string, defaultValue?: number, incrementPercent: number = 0, minSpreadFactor: number = GRID_LIMITS.MIN_SPREAD_FACTOR): Promise<number | string | undefined> {
    const safeIncrement = Number.isFinite(incrementPercent) ? incrementPercent : 0;
    const safeMinSpreadFactor = Number.isFinite(minSpreadFactor) ? minSpreadFactor : GRID_LIMITS.MIN_SPREAD_FACTOR;
    const minRequired = roundToDecimals(safeIncrement * safeMinSpreadFactor, 2);
    const minRequiredLabel = minRequired.toFixed(2);
    const effectiveDefault = typeof defaultValue === 'number' && Number.isFinite(defaultValue) ? Math.max(roundToDecimals(defaultValue, 2), minRequired) : defaultValue;
    const suffix = effectiveDefault !== undefined && effectiveDefault !== null ? ` [${effectiveDefault.toFixed(2)}]` : '';
    const raw = (await readInput(`${promptText} (>= ${minRequiredLabel})${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return effectiveDefault;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate >= minSpreadFactor x incrementPercent (with floating point precision handling)
    if (parsed + Number.EPSILON < minRequired) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= ${safeMinSpreadFactor}x incrementPercent (${minRequiredLabel})`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate no negative
    if (parsed < 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Cannot be negative`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    return roundToDecimals(parsed, 2);
}

/**
 * Prompts the user for an integer within a range.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {number} minVal - The minimum allowed value.
 * @param {number} maxVal - The maximum allowed value.
 * @returns {Promise<number|string>} The integer or '\x1b' if ESC.
 */
async function askIntegerInRange(promptText: string, defaultValue?: number, minVal: number = 0, maxVal: number = 100): Promise<number | string | undefined> {
    return askNumeric(promptText, defaultValue, (parsed) => {
        // Validate that number is integer (not float)
        if (!Number.isInteger(parsed)) return `Invalid ${promptText}: ${parsed}. Must be an integer (no decimals)`;
        // Validate bounds
        if (parsed < minVal || parsed > maxVal) return `Invalid ${promptText}: ${parsed}. Must be between ${minVal} and ${maxVal}`;
        return null;
    });
}

/**
 * Validate a relative-multiplier input ("1.5x") for the price-bound prompts.
 * Returns the trimmed multiplier string when accepted, or the error message to
 * print when rejected. Single source of truth for the min/max direction rule.
 */
function validateMultiplierInput(promptText: string, raw: string): { value: string } | { error: string } {
    const trimmed = raw.trim();
    const multiplier = parseFloat(trimmed);
    if (multiplier <= 0) {
        return { error: `Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values` };
    }
    if (multiplier < 1) {
        // A sub-1x bound multiplier ("0.7x") resolves to the wrong side of the
        // grid. Reject so the rail can't land across the book (issue #15).
        const directionNote = /max/i.test(promptText)
            ? 'For maxPrice, "Nx" means center*N, so a multiplier < 1 places the bound BELOW the center. Use a value > 1.'
            : 'For minPrice, "Nx" means center/N, so a multiplier < 1 places the bound ABOVE the center. Use a value > 1 (e.g. "1.43x" for 70% of center).';
        return { error: `Invalid ${promptText}: "${trimmed}". ${directionNote}` };
    }
    return { value: trimmed };
}

/**
 * Prompts the user for a numeric value or a multiplier. Used for price
 * range bounds (currently only minPrice); multiplier validation assumes a
 * price-bound context and derives its min/max explanation from promptText.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askNumberOrMultiplier(promptText: string, defaultValue?: number | string): Promise<number | string | undefined> {
    return askTypedInput<number | string>({
        promptText,
        defaultValue,
        // Pre-entry legend for Range bounds (mirrors weight mountain legend)
        onBeforePrompt: () => { if (/^(minPrice|maxPrice)/i.test(promptText)) printRangeQualityLegend(); },
        formatDefault: colorPriceRangeValue,
        colorize: colorRangeValueByQuality,
        parse: (raw) => {
            if (isMultiplierString(raw)) {
                const result = validateMultiplierInput(promptText, raw);
                return 'error' in result ? result : { value: result.value };
            }
            const parsed = Number(raw);
            if (Number.isNaN(parsed)) return { error: 'Please enter a valid number or multiplier (e.g. 5x).' };
            // Validate that number is > 0 (for price inputs)
            if (parsed <= 0) return { error: `Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)` };
            return { value: parsed };
        },
    });
}

/**
 * Prompts the user for the maximum price, ensuring it's greater than minimum price.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @param {number|string} minPrice - The minimum price.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askMaxPrice(promptText: string, defaultValue?: number | string, minPrice?: number | string): Promise<number | string | undefined> {
    return askTypedInput<number | string>({
        promptText,
        defaultValue,
        onBeforePrompt: printRangeQualityLegend,
        formatDefault: colorPriceRangeValue,
        colorize: colorRangeValueByQuality,
        parse: (raw) => {
            if (isMultiplierString(raw)) {
                const result = validateMultiplierInput(promptText, raw);
                return 'error' in result ? result : { value: result.value };
            }
            const parsed = Number(raw);
            if (Number.isNaN(parsed)) return { error: 'Please enter a valid number or multiplier (e.g. 5x).' };
            // Validate that number is > 0 (for price inputs)
            if (parsed <= 0) return { error: `Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)` };
            // Validate that maxPrice > minPrice. Only comparable when minPrice is an
            // absolute value: a relative min ("2x") needs the grid center to resolve,
            // so it can't be checked here — the runtime bound validation covers it
            // (previously parseFloat("2x") == 2 wrongly rejected any absolute price <= 2).
            if (!isMultiplierString(minPrice)) {
                const minPriceValue = typeof minPrice === 'string' ? parseFloat(minPrice) : minPrice;
                if (minPriceValue != null && parsed <= minPriceValue) {
                    return { error: `Invalid ${promptText}: ${parsed}. Must be > minPrice (${minPriceValue})` };
                }
            }
            return { value: parsed };
        },
    });
}

/**
 * Normalizes a percentage string input.
 * @param {string} value - The input string.
 * @returns {string|null} The normalized percentage string or null if invalid.
 */
function normalizePercentageInput(value: string): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.endsWith('%')) return null;
    const numeric = Number(trimmed.slice(0, -1).trim());
    if (Number.isNaN(numeric)) return null;
    return `${numeric}%`;
}

/**
 * Prompts the user for a numeric value or a percentage.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askNumberOrPercentage(promptText: string, defaultValue?: number | string): Promise<number | string | undefined> {
    return askTypedInput<number | string>({
        promptText,
        defaultValue,
        formatDefault: colorPercentageInput,
        colorize: colorPercentageInput,
        parse: (raw) => {
            const percent = normalizePercentageInput(raw);
            if (percent !== null) return { value: percent };
            const parsed = Number(raw);
            if (Number.isNaN(parsed)) return { error: 'Please enter a valid number or percentage (e.g. 100, 50%).' };
            return { value: parsed };
        },
    });
}

/**
 * Parses a raw boolean answer.
 * Accepted: y/yes/true/1/t → true, n/no/false/0/f → false (case-insensitive);
 * empty input keeps the current/default value; anything else is rejected so
 * the caller can re-prompt (the old `startsWith('y')` rule silently parsed
 * "true" as false).
 * @param {string} raw - Raw prompt input.
 * @param {boolean} [defaultValue] - Value returned for empty input.
 * @returns {{ ok: boolean, value?: boolean }} ok=false for unrecognized input.
 */
function parseBooleanInput(raw: unknown, defaultValue?: boolean): { ok: boolean; value?: boolean } {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return { ok: true, value: !!defaultValue };
    if (value === 'y' || value === 'yes' || value === 'true' || value === '1' || value === 't') return { ok: true, value: true };
    if (value === 'n' || value === 'no' || value === 'false' || value === '0' || value === 'f') return { ok: true, value: false };
    return { ok: false };
}

/**
 * Prompts the user for a boolean value (Y/n).
 * Enter keeps the current/default value; unrecognized input re-prompts with
 * a hint instead of silently coercing. See parseBooleanInput for the exact
 * accepted spellings.
 * @param {string} promptText - The prompt text to display.
 * @param {boolean} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<boolean|string>} The boolean value or '\x1b' if ESC.
 */
async function askBoolean(promptText: string, defaultValue?: boolean): Promise<boolean | string | undefined> {
    const label = defaultValue ? 'Y/n' : 'y/N';
    for (;;) {
        const raw = (await readInput(`${promptText} (${label}): `)).trim().toLowerCase();
        if (raw === '\x1b') return '\x1b';
        const parsed = parseBooleanInput(raw, !!defaultValue);
        if (parsed.ok) return parsed.value;
        console.log('Please enter y/yes/true or n/no/false (Enter keeps the current value).');
    }
}

/**
 * Prompts the user for the start price (numeric or "pool"/"book").
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The start price or '\x1b' if ESC.
 */
async function askStartPrice(promptText: string, defaultValue?: number | string): Promise<number | string | undefined> {
    return askTypedInput<number | string>({
        promptText,
        defaultValue,
        formatDefault: colorStartPriceValue,
        colorize: colorStartPriceValue,
        parse: (raw) => {
            const lower = raw.toLowerCase();
            if (lower === 'pool' || lower === 'book') return { value: lower };
            // Accept numeric values (including decimals)
            const num = Number(raw);
            if (!Number.isNaN(num) && Number.isFinite(num)) return { value: num };
            return { error: 'Please enter "pool", "book", or a numeric value.' };
        },
    });
}

/**
 * Spellings that clear a `poolRef` pin, leaving the runtime to auto-select
 * the pair's default pool when the price mode asks for one. `default`/`pool`/
 * `auto` are accepted as aliases because the 3) Price summary labels the
 * unpinned pool state `default`, so typing what the summary shows must not be
 * rejected.
 */
const POOL_REF_CLEAR_INPUTS = new Set(['none', 'clear', 'off', 'no', 'default', 'pool', 'auto']);

/**
 * True when raw poolRef input is a clear/auto alias rather than a pool ID.
 * @param {*} value - Raw or normalized user input.
 * @returns {boolean}
 */
function isPoolRefClearInput(value: unknown): boolean {
    return POOL_REF_CLEAR_INPUTS.has(String(value ?? '').trim().toLowerCase());
}

/**
 * Prompts the user for an optional pool ID to pin price derivation.
 * Enter a pool ID (e.g. 48 or 1.19.48) to set/change the pin, or one of the
 * clear aliases ("none", "clear", or "default"/"pool"/"auto") to remove it.
 * Blank input keeps the current value. When no pin is set, the bracketed
 * default shows what the runtime will actually use: `default` when startPrice
 * is "pool" (the pair's auto-selected pool), otherwise `none` (inert) — this
 * mirrors the 3) Price summary label instead of always reading `none`.
 * @param {string} promptText - The prompt text to display.
 * @param {string|null|undefined} [currentValue] - The current poolRef value.
 * @param {boolean} [usesDefaultPool=false] - True when startPrice is "pool",
 *        so an unpinned value renders as `default` rather than `none`.
 * @returns {Promise<string|null|symbol>} Pool ID, null (cleared), or '\x1b' on ESC.
 */
async function askPoolRef(promptText: string, currentValue?: string | null | undefined, usesDefaultPool: boolean = false): Promise<string | null> {
    while (true) {
        const fallbackLabel = usesDefaultPool ? 'default' : 'none';
        const suffix = currentValue ? ` [${currentValue}]` : ` [${fallbackLabel}]`;
        const raw = (await readInput(`${promptText}${suffix}: `)).trim();
        if (raw === '\x1b') return '\x1b';
        if (!raw) return currentValue || null;

        if (isPoolRefClearInput(raw)) {
            return null;
        }

        const normalized = raw.startsWith('1.19.') ? raw : `1.19.${raw}`;
        const parts = normalized.split('.');
        if (parts.length === 3 && parts[0] === '1' && parts[1] === '19' && /^\d+$/.test(parts[2])) {
            return normalized;
        }
        console.log('Invalid — enter a pool number (e.g. 48), full ID (e.g. 1.19.48), or "none" to clear.');
    }
}

/**
 * Prompts the user for the grid price mode.
 * The label lists ama1..ama4; bare "ama" is accepted as well (green) but not
 * listed. The live colorizer echoes AMA input green and every other value
 * (pool/book/number/none) red — red only flags "not an AMA value", it does not
 * reject: pool, book, numeric references, none/null (delegate to startPrice)
 * and bare "ama" all stay accepted, exactly as before. Only input that is not
 * a value at all is rejected, with a red error line.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The current value, offered as the Enter default.
 * @returns {Promise<any>} The normalized grid-price value, the unchanged
 *                         current value on Enter, or '\x1b' if ESC.
 */
async function askGridPriceMode(promptText: string, defaultValue?: string | number | null): Promise<string | number | null> {
    while (true) {
        const coloredDefault = colorGridPriceValue(defaultValue ?? null);
        const raw = await readInput(`${promptText} [${coloredDefault}]: `, {
            colorize: (input: string) => colorGridPriceValue(input),
            // Keep whitespace so a deactivating space can be told apart from a
            // bare Enter that means "keep current".
            trimInput: false
        });
        if (raw === '\x1b') return '\x1b';
        // A bare Enter keeps the current value (an already-unset value is
        // normalized to null so it is stored as delegation). Whitespace-only
        // input is NOT a bare Enter: the live echo already previews it as red
        // startPrice, so it must overwrite with null — otherwise the preview
        // would promise startPrice while the old value silently survived.
        if (raw === '') return isUnsetGridPrice(defaultValue) ? null : (defaultValue === undefined ? null : defaultValue);

        const lower = raw.trim().toLowerCase();
        if (isUnsetGridPrice(lower)) return null;
        if (lower === 'pool') return lower;
        if (lower === 'book') return 'book';
        if (AMA_GRID_PRICE_PATTERN.test(lower)) return lower;

        const num = Number(raw);
        if (Number.isFinite(num) && num > 0) return num;

        console.log(`${COLORS.red}Please enter: ama1, ama2, ama3 or ama4 — also allowed: pool, book, ama, a positive number, or none (s/start, n/no/false/0/f).${COLORS.reset}`);
    }
}

/**
 * Normalizes a bot draft for editing or saving.
 * Preserves existing fields and strips unsupported runtime-managed fields.
 * @param {Object} [base={}] - The initial bot data to edit.
 * @returns {Object} A normalized bot draft.
 */
interface BotDraft extends UnknownRecord {
    accountId?: string;
    active?: boolean;
    coreOrders: { sell?: number; buy?: number };
    assetA?: string;
    assetB?: string;
    botFunds: { sell?: number | string; buy?: number | string };
    dryRun?: boolean;
    gridPrice?: string | number | null;
    incrementPercent?: number;
    maxPrice?: number | string;
    minPrice?: number | string;
    name?: string;
    poolRef?: string | null;
    preferredAccount?: string;
    edgeOrders?: { sell?: number; buy?: number };
    startPrice?: number | string;
    targetSpreadPercent?: number;
    weightDistribution: { sell: number; buy: number };
}

function normalizeBotDraft(base: BotDraft = {} as BotDraft): BotDraft {
    // Seeding rules live in modules/bot_defaults.ts (single defaults source).
    // Return type stays `any`: the editor prompt-flow treats drafts as dynamic
    // bags and its inference depends on it.
    return seedBotDraft(base) as unknown as BotDraft;
}

/**
 * Resolve data.preferredAccount to a chain account ID and stamp data.accountId
 * (persisted to profiles/bots.json on save). A typed 1.2.x ID is stored
 * directly; a name is resolved via chain lookup (lazy import so the config
 * editor never drags in the chain stack at module load). Fail-soft: when the
 * lookup fails or times out (offline), accountId is left unset with a warning
 * and analysis tools backfill it on their next successful lookup.
 *
 * CONTRACT: a cached accountId is only trusted when it was stored for the
 * current preferredAccount value. Callers that change preferredAccount MUST
 * either delete data.accountId first or pass force=true; otherwise a stale
 * ID is returned as 'cached' without verification.
 *
 * Side effects are contained: chain INFO/WARN spam is suppressed for the
 * duration of the lookup (setSuppressConnectionLog + the Logger global
 * console floor, both restored in `finally`), and the shared client is
 * disconnected afterwards so the configurator never holds a socket open
 * longer than needed (`dexbot bot` additionally disconnects and exits).
 * Residual edge: if our timeout abandons a still-in-flight connect sweep,
 * the stack's own total-timeout guard settles it later; the next lookup's
 * `finally` disconnects any socket it left behind.
 *
 * @warning Disconnects the SHARED chain client in `finally`. Call ONLY from
 * short-lived flows (bot configurator, one-shot scripts) that own no live
 * connection. NEVER from a long-running process (bot runtime, daemon,
 * concurrent worker) — it would drop the socket out from under the runtime.
 * @param {Object} data - Bot draft being edited.
 * @param {number} [timeoutMs=15000] - Max ms to wait for the chain lookup.
 * @param {boolean} [quiet=false] - Suppress console output.
 * @param {boolean} [force=false] - Ignore a cached accountId and re-resolve.
 * @returns {Promise<{id: string|null, reason: string}>} reason is one of
 *   'invalid' (no usable preferredAccount), 'id' (typed 1.2.x ID, stamped
 *   directly), 'cached' (previously verified ID reused, no chain hit),
 *   'resolved' (fresh chain lookup succeeded), 'not-found' (chain answered,
 *   no such account), 'timeout' (nodes unreachable within timeoutMs),
 *   'error' (import/lookup threw).
 */
async function ensureBotAccountId(data: Record<string, unknown>, timeoutMs = 15000, quiet = false, force = false): Promise<{ id: string | null; reason: string }> {
    if (!data || typeof data !== 'object') return { id: null, reason: 'invalid' };
    const ref = String(data.preferredAccount ?? '').trim();
    if (!ref) return { id: null, reason: 'invalid' };
    if (/^1\.2\.\d+$/.test(ref)) {
        if (data.accountId !== ref) data.accountId = ref;
        return { id: ref, reason: 'id' };
    }
    if (!force && data.accountId && /^1\.2\.\d+$/.test(String(data.accountId))) {
        return { id: String(data.accountId), reason: 'cached' };
    }
    let chainClient: typeof import('./bitshares_client.js') | null = null;
    let prevSuppress = false;
    let prevGlobalLevel: string | null = null;
    let suppressionArmed = false;
    try {
        chainClient = await import('./bitshares_client.js');
        prevSuppress = chainClient.isSuppressConnectionLog();
        prevGlobalLevel = getGlobalConsoleLevel();
        suppressionArmed = true;
        chainClient.setSuppressConnectionLog(true);
        setGlobalConsoleLevel('warn');
        const chainOrders = await import('./chain_orders.js');
        const timeoutErr = new Error(`account lookup timed out after ${timeoutMs}ms`) as Error & { code?: string };
        timeoutErr.code = 'ACCOUNT_LOOKUP_TIMEOUT';
        let id: string | null = null;
        try {
            id = await Promise.race([
                chainOrders.resolveAccountId(ref),
                sleep(timeoutMs).then(() => { throw timeoutErr; }),
            ]);
        } catch (err) {
            const reason = err && getErrorCode(err) === 'ACCOUNT_LOOKUP_TIMEOUT' ? 'timeout' : 'error';
            if (!quiet) {
                const hint = reason === 'timeout'
                    ? `nodes unreachable (timed out after ${timeoutMs}ms). Continuing without accountId — it will be stored automatically once a lookup succeeds.`
                    : `(${getErrorMessage(err)}). Continuing without accountId — it will be stored automatically once a lookup succeeds.`;
                console.log(`  ${COLORS.yellow}Could not resolve account '${ref}' to 1.2.x ${hint}${COLORS.reset}`);
            }
            return { id: null, reason };
        }
        if (id && /^1\.2\.\d+$/.test(String(id))) {
            data.accountId = String(id);
            if (!quiet) console.log(`  ${COLORS.green}Resolved account '${ref}' → ${id} (stored as accountId).${COLORS.reset}`);
            return { id: String(id), reason: 'resolved' };
        }
        if (!quiet) console.log(`  ${COLORS.yellow}Account '${ref}' not found on the blockchain. Continuing without accountId — fix the name and it will be stored automatically once a lookup succeeds.${COLORS.reset}`);
        return { id: null, reason: 'not-found' };
    } catch (err) {
        if (!quiet) console.log(`  ${COLORS.yellow}Could not resolve account '${ref}' to 1.2.x (${getErrorMessage(err)}). Continuing without accountId — it will be stored automatically once a lookup succeeds.${COLORS.reset}`);
        return { id: null, reason: 'error' };
    } finally {
        if (chainClient) {
            try { await chainClient.disconnectClient(); } catch (_) { /* best-effort cleanup */ }
            if (suppressionArmed) {
                try { chainClient.setSuppressConnectionLog(prevSuppress); } catch (_) { /* restore-only */ }
            }
        }
        if (suppressionArmed) {
            try { setGlobalConsoleLevel(prevGlobalLevel); } catch (_) { /* restore-only */ }
        }
    }
}

type BotEditorMode = 'new' | 'modify' | 'copy';

interface AdapterFlags {
    ama: boolean;
    dynamicWeight: boolean;
    asymmetricBounds: boolean;
}

interface AdapterCommitPlan {
    /** Source key to move first, or null when no entry is being renamed. */
    renameFrom: string | null;
    /** Key read to decide whether the stored flags already match. */
    compareKey: string;
    /** Key the flags are written to when they differ. */
    writeKey: string;
}

/**
 * Decide how an editor save should commit the adapter whitelist entry,
 * independent of I/O so the copy/rename semantics are unit-testable:
 *
 * - new bot      : no rename; compare and write the new key.
 * - modify       : no rename; compare and write the same key.
 * - modify/rename: move baseKey -> newKey; compare the source pre-move so an
 *                  unchanged flag set still performs the move.
 * - copy         : never moves — the source entry must survive — so compare
 *                  and write the new key.
 *
 * An empty newKey (or baseKey) can not be a rename target and falls back to
 * comparing the source.
 */
function resolveAdapterCommitPlan({ baseKey, newKey, isCopy }: { baseKey: string; newKey: string; isCopy: boolean }): AdapterCommitPlan {
    const base = String(baseKey || '');
    const next = String(newKey || '');
    const renameFrom = (!isCopy && base && next && base !== next) ? base : null;
    return {
        renameFrom,
        compareKey: isCopy ? next : (base || next),
        writeKey: next,
    };
}

/** Field-wise comparison of two adapter flag sets. */
function sameAdapterFlags(a: AdapterFlags, b: AdapterFlags): boolean {
    return a.ama === b.ama
        && a.dynamicWeight === b.dynamicWeight
        && a.asymmetricBounds === b.asymmetricBounds;
}

/**
 * Interactive menu to edit bot data.
 * @param {Object} [base={}] - The initial bot data to edit.
 * @param {number} [index=0] - Position the edited bot will occupy in the
 *   bots array (used to derive the same botKey the runtime uses for unnamed
 *   fallback entries).
 * @param {BotEditorMode} [mode='new'] - Editor intent. `copy` derives the
 *   source whitelist key from `sourceIndex` and never moves it; `modify`
 *   renames/moves the entry when the name changes; `new` starts empty.
 * @param {number} [sourceIndex=index] - Position the base entry currently
 *   occupies (differs from `index` only for copies).
 * @returns {Promise<{ data: any, commitAdapter: (() => 'saved'|'unchanged'|'failed')|null }|null>}
 *   The edited draft plus a commit hook for staged `6) Adapter` flags — the
 *   caller MUST run `commitAdapter()` only after its bots.json save succeeded
 *   (so a failed save never leaves the whitelist out of sync), or null when
 *   cancelled. The hook reports whether the whitelist write actually happened
 *   ('saved'), was unnecessary ('unchanged'), or failed ('failed', already
 *   printed as a warning) so the caller can fold it into one status line.
 */
async function promptBotData(base: BotDraft = {} as BotDraft, index = 0, mode: BotEditorMode = 'new', sourceIndex = index) {
    const data = normalizeBotDraft(base);

    // Market-adapter flags (6) Adapter) live in
    // profiles/market_adapter_whitelist.json keyed by botKey — the same file
    // the market adapter reads. Stage edits here and expose them through the
    // commit hook so Cancel (or a failed bots.json save) discards them
    // together with the rest of the draft.
    const baseEntry = base && typeof base === 'object' && Object.keys(base).length > 0 ? base : null;
    const baseBotKey = baseEntry ? String(normalizeBotEntry(baseEntry as BotEntry, sourceIndex).botKey || '') : '';
    const isNewBot = mode === 'new';
    const isCopy = mode === 'copy';
    let adapterStaged: { ama: boolean; dynamicWeight: boolean; asymmetricBounds: boolean } | null = null;
    const isAmaGridPriceDraft = () => /^ama(?:[1-4])?$/.test(String(data.gridPrice ?? '').trim().toLowerCase());
    // Staged menu-6 edits win. Otherwise an existing bot uses its stored entry;
    // a brand-new bot uses that entry too if one already exists for its key,
    // and only falls back to AMA pricing ON when there is no record at all — so
    // re-creating a previously configured key never silently flips its flags.
    const adapterFlags = () => {
        if (adapterStaged) return adapterStaged;
        const key = baseBotKey || String(normalizeBotEntry(data as BotEntry, index).botKey || '');
        if (!isNewBot) return getWhitelistFlags(key);
        return hasWhitelistEntry(key) ? getWhitelistFlags(key) : { ...AMA_ONLY_WHITELIST_FLAGS };
    };

    let finished = false;
    let cancelled = false;
    let showMenu = true;

    while (!finished) {
        if (showMenu) {
             console.log(`\n${COLORS.bold}--- Bot Editor: ` + (data.name || 'New Bot') + ` ---${COLORS.reset}`);
             console.log(`${COLORS.yellowBold}1) Pair:${COLORS.reset}      ${COLORS.cyan}${data.assetA || '?'} / ${data.assetB || '?'}${COLORS.reset}`);
             console.log(`${COLORS.yellowBold}2) Identity:${COLORS.reset}  ${COLORS.orange}Name:${COLORS.reset} ${data.name || '?'}, ${COLORS.orange}Account:${COLORS.reset} ${data.preferredAccount || '?'} | ${COLORS.orange}Active:${COLORS.reset} ${colorBooleanFlag(data.active, true)}, ${COLORS.orange}DryRun:${COLORS.reset} ${colorBooleanFlag(data.dryRun, false)}`);
             console.log(`${COLORS.yellowBold}3) Price:${COLORS.reset}     ${COLORS.orange}Range:${COLORS.reset} [${colorPriceRangeValue(data.minPrice)} - ${colorPriceRangeValue(data.maxPrice)}] | ${COLORS.orange}Start:${COLORS.reset} ${colorStartPriceValue(data.startPrice)}, ${COLORS.orange}Pool:${COLORS.reset} ${formatPoolRefLabel(data)} | ${COLORS.orange}GridPrice:${COLORS.reset} ${colorGridPriceValue(data.gridPrice)}`);
             console.log(`${COLORS.yellowBold}4) Grid:${COLORS.reset}      ${COLORS.orange}Weights:${COLORS.reset} (S:${data.weightDistribution.sell}, B:${data.weightDistribution.buy}) | ${COLORS.orange}Increment:${COLORS.reset} ${data.incrementPercent}%, ${COLORS.orange}Spread:${COLORS.reset} ${data.targetSpreadPercent}%`);
             console.log(`${COLORS.yellowBold}5) Inventory:${COLORS.reset} ${COLORS.orange}Sell:${COLORS.reset} ${colorPercentageInput(data.botFunds.sell)}, ${COLORS.orange}Buy:${COLORS.reset} ${colorPercentageInput(data.botFunds.buy)} | ${COLORS.orange}CoreOrder:${COLORS.reset} (S:${data.coreOrders.sell}, B:${data.coreOrders.buy}) | ${COLORS.orange}EdgeOrder:${COLORS.reset} (S:${data.edgeOrders?.sell ?? 0}, B:${data.edgeOrders?.buy ?? 0})`);
             {
                 const flags = adapterFlags();
                 const inert = !isAmaGridPriceDraft() && (flags.ama || flags.dynamicWeight || flags.asymmetricBounds);
                 const hint = inert ? ` ${COLORS.red}(needs gridPrice=ama)${COLORS.reset}` : '';
                 // Adapter flags read as a health state, not a neutral toggle:
                 // green = on (colorBooleanFlag's greenWhenTrue form, same
                 // helper section 2 uses for Active). Price is the gate for the
                 // other two, so off stays red; Weight/Range are optional
                 // riders, so off is a bright-yellow warning rather than an error.
                 console.log(`${COLORS.yellowBold}6) Adapter:${COLORS.reset}   ${COLORS.orange}Price:${COLORS.reset} ${colorBooleanFlag(flags.ama, true)}, ${COLORS.orange}Weight:${COLORS.reset} ${colorBooleanFlag(flags.dynamicWeight, true, COLORS.yellowBold)}, ${COLORS.orange}Range:${COLORS.reset} ${colorBooleanFlag(flags.asymmetricBounds, true, COLORS.yellowBold)}${hint}`);
             }
             console.log('--------------------------------------------------');
             console.log(`${COLORS.greenBold}S) Save & Exit${COLORS.reset}`);
             console.log(`${COLORS.white}C) Cancel (Discard changes)${COLORS.reset}`);
            showMenu = false;
        }

        const choice = (await readInput('Select section to edit or action: ', {
            validate: (input: string) => ['1', '2', '3', '4', '5', '6', 's', 'c'].includes(input.toLowerCase())
        })).trim().toLowerCase();

        if (choice === '\x1b') {
            finished = true;
            cancelled = true;
            break;
        }

        switch (choice) {
            case '1':
                const assetA = await askAsset('Asset A for selling', data.assetA);
                if (assetA === '\x1b') break;
                const assetB = await askAssetB('Asset B for buying', data.assetB, assetA);
                if (assetB === '\x1b') break;
                data.assetA = assetA;
                data.assetB = assetB;
                showMenu = true;
                break;
            case '2':
                const name = await askRequiredString('Bot name', data.name);
                if (name === '\x1b') break;
                let prefAcc = await askRequiredString('Blockchain account', data.preferredAccount);
                if (prefAcc === '\x1b') break;
                // Verify the account exists on the blockchain and stamp its ID.
                // Re-prompt while verification fails. A 'timeout' means the
                // nodes were unreachable (indistinguishable from a bad name
                // while offline); anything else means the name is unknown.
                {
                    const draft = { ...data, preferredAccount: prefAcc };
                    for (;;) {
                        const checked = await ensureBotAccountId(draft, 15000, true, true);
                        if (checked.id) break;
                        const why = checked.reason === 'timeout'
                            ? `nodes unreachable (lookup timed out). Check your connection and try again, or press Esc to cancel.`
                            : `account '${draft.preferredAccount}' not found on the blockchain. Check the name and try again, or press Esc to cancel.`;
                        console.log(`${COLORS.red}Error: ${why}${COLORS.reset}`);
                        const retry = await askRequiredString('Blockchain account', String(draft.preferredAccount ?? ''));
                        if (retry === '\x1b') { prefAcc = retry; break; }
                        draft.preferredAccount = retry;
                    }
                    if (prefAcc === '\x1b') break;
                    prefAcc = String(draft.preferredAccount);
                    data.accountId = draft.accountId;
                }
                const active = await askBoolean('Active', data.active);
                if (typeof active !== 'boolean') break;
                const dryRun = await askBoolean('Dry run', data.dryRun);
                if (typeof dryRun !== 'boolean') break;
                data.name = name;
                data.preferredAccount = prefAcc;
                data.active = active;
                data.dryRun = dryRun;
                showMenu = true;
                break;
            case '3':
                const minP = await askNumberOrMultiplier('minPrice', data.minPrice);
                if (minP === '\x1b') break;
                const maxP = await askMaxPrice('maxPrice', data.maxPrice, minP);
                if (maxP === '\x1b') break;
                const startP = await askStartPrice('startPrice (pool, book or price)', data.startPrice);
                if (startP === '\x1b') break;
                // poolRef only feeds startPrice "pool" (README: ignored for
                // book/fixed price), so don't ask when startPrice isn't pool —
                // an existing pin is kept dormant, not cleared, so switching
                // back to pool restores it.
                const poolR = isPoolStartPrice(startP)
                    ? await askPoolRef('poolRef (pinned pool ID for price source)', data.poolRef, true)
                    : (data.poolRef || null);
                if (poolR === '\x1b') break;
                const gp = await askGridPriceMode('gridPrice (ama1/ama2/ama3/ama4)', data.gridPrice);
                if (gp === '\x1b') break;
                data.minPrice = minP;
                data.maxPrice = maxP;
                data.startPrice = startP;
                data.poolRef = poolR || undefined;
                data.gridPrice = gp;
                showMenu = true;
                break;
            case '4':
                const wSell = await askWeightDistribution('Weight distribution (sell)', data.weightDistribution.sell);
                if (wSell === '\x1b') break;
                const wBuy = await askWeightDistributionNoLegend('Weight distribution (buy)', data.weightDistribution.buy);
                if (wBuy === '\x1b') break;
                const incrP = await askNumberWithBounds('incrementPercent', data.incrementPercent, INCREMENT_BOUNDS.MIN_PERCENT, INCREMENT_BOUNDS.MAX_PERCENT);
                if (incrP === '\x1b') break;
                if (typeof incrP !== 'number') break;
                const defaultSpread = data.targetSpreadPercent || incrP * 4;

                // Use current general settings for the validation limit
                const currentSettings = loadGeneralSettings();
                const targetS = await askTargetSpreadPercent('targetSpread %', defaultSpread, incrP, currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR);

                if (typeof targetS !== 'number') break;
                if (typeof wSell !== 'number' || typeof wBuy !== 'number') break;
                data.weightDistribution.sell = wSell;
                data.weightDistribution.buy = wBuy;
                data.incrementPercent = incrP;
                data.targetSpreadPercent = targetS;
                showMenu = true;
                break;
            case '5':
                const fSell = await askNumberOrPercentage('botFunds sell amount', data.botFunds.sell);
                if (fSell === undefined || fSell === '\x1b') break;
                const fBuy = await askNumberOrPercentage('botFunds buy amount', data.botFunds.buy);
                if (fBuy === undefined || fBuy === '\x1b') break;
                const oSell = await askIntegerInRange('coreOrders sell count', data.coreOrders.sell, 1, 100);
                if (typeof oSell !== 'number') break;
                const oBuy = await askIntegerInRange('coreOrders buy count', data.coreOrders.buy, 1, 100);
                if (typeof oBuy !== 'number') break;
                const rBuy = await askIntegerInRange('edgeOrders buy floor count (0 disables)', data.edgeOrders?.buy ?? 0, 0, 100);
                if (typeof rBuy !== 'number') break;
                const rSell = await askIntegerInRange('edgeOrders sell ceiling count (0 disables)', data.edgeOrders?.sell ?? 0, 0, 100);
                if (typeof rSell !== 'number') break;
                data.botFunds.sell = fSell;
                data.botFunds.buy = fBuy;
                data.coreOrders.sell = oSell;
                data.coreOrders.buy = oBuy;
                data.edgeOrders = { buy: rBuy, sell: rSell };
                showMenu = true;
                break;
            case '6': {
                // Per-bot market-adapter flags (Price = AMA pricing, Weight =
                // dynamic weights, Range = asymmetric range scaling).
                const flags = adapterFlags();
                if (!isAmaGridPriceDraft()) {
                    console.log(`${COLORS.gray}Note: these flags only take effect when gridPrice is ama/ama1..ama4 (set in 3) Price).${COLORS.reset}`);
                }
                const price = await askBoolean('AMA pricing (Price)', flags.ama);
                if (price === '\x1b') break;
                if (typeof price !== 'boolean') break;
                const weight = await askBoolean('Dynamic weights (Weight)', flags.dynamicWeight);
                if (weight === '\x1b') break;
                if (typeof weight !== 'boolean') break;
                const range = await askBoolean('Range scaling (Range)', flags.asymmetricBounds);
                if (range === '\x1b') break;
                if (typeof range !== 'boolean') break;
                adapterStaged = { ama: price, dynamicWeight: weight, asymmetricBounds: range };
                if (!price && (weight || range)) {
                    console.log(`${COLORS.yellow}Note: Weight/Range only take effect while Price (AMA) is enabled.${COLORS.reset}`);
                }
                showMenu = true;
                break;
            }
            case 's':
                // Final basic validation before saving
                if (!data.name || !data.assetA || !data.assetB || !data.preferredAccount) {
                    console.log(`${COLORS.red}Error: Name, Pair, and Account are required before saving.${COLORS.reset}`);
                    break;
                }
                {
                    const currentSettings = loadGeneralSettings();
                    const spreadFactor = Number.isFinite(currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR)
                        ? currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR
                        : GRID_LIMITS.MIN_SPREAD_FACTOR;
                    const minRequiredSpread = roundToDecimals((data.incrementPercent ?? 0) * spreadFactor, 2);
                    if ((data.targetSpreadPercent ?? 0) + Number.EPSILON < minRequiredSpread) {
                        console.log(`${COLORS.red}Error: targetSpreadPercent (${data.targetSpreadPercent}) must be >= ${spreadFactor}x incrementPercent (${minRequiredSpread.toFixed(2)}).${COLORS.reset}`);
                        break;
                    }
                }
                // Stamp accountId when possible (fail-soft when offline); the
                // Identity section above already hard-verifies the name on entry.
                await ensureBotAccountId(data);
                finished = true;
                break;
            case 'c':
                finished = true;
                cancelled = true;
                break;
            default:
                // Invalid choice - just ignore and prompt again without redisplaying menu
        }
    }

    if (cancelled) return null;

    // Staged 6) Adapter flags become a commit hook instead of an immediate
    // write: the caller runs it only after its bots.json save succeeded, so
    // the whitelist can never end up updated by a save that was rejected
    // (duplicate bot keys, write error). Writes are skipped when the staged
    // flags already match what is stored — an unchanged save never creates a
    // placeholder entry.
    const stagedFlags = adapterStaged;
    // Resolve the whitelist commit up front. A rename must arm the hook even
    // when menu 6 was never touched, otherwise the entry stays under the old
    // key and the renamed bot silently falls back to defaults. An unchanged
    // save still writes nothing.
    const newKey = String(normalizeBotEntry(data, index).botKey || '');
    const adapterPlan = resolveAdapterCommitPlan({ baseKey: baseBotKey, newKey, isCopy });
    const commitAdapter: (() => 'saved'|'unchanged'|'failed') | null = (stagedFlags || isNewBot || isCopy || adapterPlan.renameFrom) ? () => {
        const desired = stagedFlags || adapterFlags();
        // Read before any rename: for a rename the compare key still holds the
        // pre-move entry, which is what decides "unchanged".
        const unchanged = sameAdapterFlags(desired, getWhitelistFlags(adapterPlan.compareKey));
        if (adapterPlan.renameFrom && !renameWhitelistEntry(adapterPlan.renameFrom, adapterPlan.writeKey)) {
            console.log(`${COLORS.yellow}Adapter flags not saved — see the warning above.${COLORS.reset}`);
            return 'failed';
        }
        // Unchanged flags need no write — a successful rename above already
        // migrated the entry under the new key.
        if (unchanged) return 'unchanged';
        if (!setWhitelistFlags(adapterPlan.writeKey, desired)) {
            console.log(`${COLORS.yellow}Warning: adapter flags not saved — could not write ${whitelistFile()}.${COLORS.reset}`);
            return 'failed';
        }
        return 'saved';
    } : null;

    // Return the final data structure, preserving ALL fields from the normalized
    // draft (deep-copy of base + defaults, minus stripped runtime-managed fields).
    // A fixed whitelist here would silently drop custom overrides (logging, timing,
    // feeParams, gridLimits, poolRef, etc.) when the caller replaces the bot entry.
    return { data: { ...data }, commitAdapter };
}

/**
 * Interactive menu to edit general settings.
 * @returns {Promise<void>}
 */
async function promptGeneralSettings() {
    const settings = loadGeneralSettings();
    let finished = false;

     while (!finished) {
          console.log(`${COLORS.bold}--- General Settings (Global) ---${COLORS.reset}`);
          console.log(`${COLORS.yellowBold}1) Grid Drift:${COLORS.reset}   ${COLORS.orange}Funds:${COLORS.reset} ${settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE}%, ${COLORS.orange}RMS:${COLORS.reset} ${settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE}% | ${COLORS.orange}AMA Δ:${COLORS.reset} ${settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT}%, ${COLORS.orange}AMA-Slope Δ:${COLORS.reset} ${settings.MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT}%`);
          const hcIntervalMin = ((settings.NODES.healthCheck?.intervalMs || NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS) / 60000).toFixed(0);
          console.log(`${COLORS.yellowBold}2) Order Maint.:${COLORS.reset} ${COLORS.orange}Dust Threshold:${COLORS.reset} ${settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE}% | ${COLORS.orange}Health Check:${COLORS.reset} ${hcIntervalMin}min`);
          const nodeCount = (settings.NODES.list || []).length;
          const prefNodeDisplay = settings.NODES.selection?.preferredNode || 'none';
          console.log(`${COLORS.yellowBold}3) Node Config:${COLORS.reset}  ${COLORS.orange}Nodes:${COLORS.reset} ${nodeCount}, ${COLORS.orange}Preferred Node:${COLORS.reset} ${prefNodeDisplay}`);
          console.log(`${COLORS.yellowBold}4) Log Level:${COLORS.reset}    ${COLORS.orange}${settings.LOG_LEVEL}${COLORS.reset} (debug, info, warn, error)`);
          const updaterStatus = settings.UPDATER.ACTIVE ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`;
          const currentSched = parseCronToDelta(settings.UPDATER.SCHEDULE || "0 0 * * *");
          console.log(`${COLORS.yellowBold}5) Updater:${COLORS.reset}      [${updaterStatus}] ${COLORS.orange}Branch:${COLORS.reset} ${settings.UPDATER.BRANCH}, ${COLORS.orange}Interval:${COLORS.reset} ${currentSched.days}d, ${COLORS.orange}Time:${COLORS.reset} ${currentSched.time}`);
          const noticeStatus = settings.UPDATER.NOTICE_ENABLED !== false ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`;
          console.log(`   ${COLORS.orange}New-version notice:${COLORS.reset} [${noticeStatus}] ${COLORS.gray}(startup hint only, never auto-updates)${COLORS.reset}`);
          console.log('--------------------------------------------------');
          console.log(`${COLORS.greenBold}S) Save & Exit${COLORS.reset}`);
          console.log(`${COLORS.white}C) Cancel (Discard changes)${COLORS.reset}`);

         const choice = (await readInput('Select section to edit or action: ', {
              validate: (input: string) => ['1', '2', '3', '4', '5', 's', 'c'].includes(input)
         })).trim().toLowerCase();

        if (choice === '\x1b') {
            finished = true;
            break;
        }

        switch (choice) {
            case '1':
                const gRegen = await askNumberWithBounds('Grid Funds Regeneration %', settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE, 0.1, 50);
                if (gRegen === '\x1b') break;
                const rms = await askNumberWithBounds('RMS Divergence Threshold %', settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE, 1, 100);
                if (rms === '\x1b') break;
                const amaDelta = await askNumberWithBounds('AMA Δ', settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT, 0.1, 50.0);
                if (amaDelta === '\x1b') break;
                const amaSlopeDelta = await askNumberWithBounds('AMA-Slope Δ', settings.MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT, 0.1, 100.0);
                if (amaSlopeDelta === '\x1b') break;
                if (typeof gRegen !== 'number' || typeof rms !== 'number' || typeof amaDelta !== 'number' || typeof amaSlopeDelta !== 'number') break;
                settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE = gRegen;
                settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE = rms;
                settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT = amaDelta;
                settings.MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT = amaSlopeDelta;
                break;
            case '2':
                const dust = await askNumberWithBounds('Partial Dust Threshold %', settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE, 0.1, 50);
                if (dust === '\x1b') break;
                if (typeof dust !== 'number') break;
                settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE = dust;

                const hcInterval = await askIntegerInRange('Health Check Interval (min)', (settings.NODES.healthCheck?.intervalMs || NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS) / 60000, 1, 43200);
                if (hcInterval === '\x1b') break;
                if (typeof hcInterval !== 'number') break;
                if (!settings.NODES.healthCheck) settings.NODES.healthCheck = {};
                settings.NODES.healthCheck.intervalMs = hcInterval * 60000;
                break;
            case '3':
                settings.NODES.enabled = true;
                {
                    const currentList = settings.NODES.list && settings.NODES.list.length > 0
                        ? settings.NODES.list
                        : NODE_MANAGEMENT.DEFAULT_NODES;
                    let nodeList = [...currentList];
                    let editorCancelled = false;

                    while (true) {
                        console.log(`  ${COLORS.bold}=== Node List Editor ===${COLORS.reset}`);
                        nodeList.forEach((node, i) => {
                            console.log(`  ${COLORS.orange}${i + 1})${COLORS.reset} ${node}`);
                        });
                        console.log(`  ${COLORS.greenBold}A) Add node${COLORS.reset}`);
                        console.log(`  ${COLORS.red}R) Remove node${COLORS.reset}`);
                        console.log(`  ${COLORS.yellowBold}D) Done${COLORS.reset}`);

                        const nodeChoice = (await readInput('  Choice: ')).trim().toLowerCase();
                        if (nodeChoice === '\x1b') {
                            editorCancelled = true;
                            break;
                        }

                        if (nodeChoice === 'a') {
                            const newNode = await askString('  Enter node URL');
                            if (newNode === '\x1b') continue;
                            if (newNode && newNode.trim()) {
                                nodeList.push(newNode.trim());
                                console.log(`  ${COLORS.green}Added.${COLORS.reset} Count: ${nodeList.length}`);
                            }
                        } else if (nodeChoice === 'r') {
                            if (nodeList.length <= 1) {
                                console.log(`  ${COLORS.yellow}Need at least one node. Add another first.${COLORS.reset}`);
                                continue;
                            }
                            const removeIdx = await askIntegerInRange('  Enter node number to remove', 1, 1, nodeList.length);
                            if (removeIdx === '\x1b') continue;
                            if (typeof removeIdx !== 'number') continue;
                            const removed = nodeList.splice(removeIdx - 1, 1)[0];
                            console.log(`  ${COLORS.green}Removed:${COLORS.reset} ${removed}`);
                        } else if (nodeChoice === 'd') {
                            settings.NODES.list = nodeList;
                            break;
                        }
                    }

                    if (editorCancelled) break;
                }

                const prefNode = await askString('Preferred Node URL (leave empty for automatic selection)', settings.NODES.selection?.preferredNode || '');
                if (prefNode === '\x1b') break;
                if (!settings.NODES.selection) settings.NODES.selection = {};
                settings.NODES.selection.preferredNode = (prefNode ?? '').trim() || null;
                break;
            case '4':
                const newLevel = await askLogLevel('Enter log level', settings.LOG_LEVEL);
                if (newLevel === '\x1b') break;
                settings.LOG_LEVEL = newLevel;
                break;
            case '5':
                const upActive = await askBoolean('Enable Automated Updater', settings.UPDATER.ACTIVE !== false);
                if (upActive === '\x1b') break;
                if (typeof upActive !== 'boolean') break;
                settings.UPDATER.ACTIVE = upActive;

                 console.log(`  ${COLORS.gray}Branch:${COLORS.reset} ${COLORS.green}main${COLORS.reset}, ${COLORS.orange}dev${COLORS.reset}, ${COLORS.red}test${COLORS.reset}, or ${COLORS.blue}auto${COLORS.reset} (detected current)`);
                const branch = await askUpdaterBranch('Branch', settings.UPDATER.BRANCH);
                if (branch === '\x1b') break;

                const schedule = await askCronSchedule('Schedule', settings.UPDATER.SCHEDULE);
                if (schedule === '\x1b') break;

                settings.UPDATER.BRANCH = branch;

                settings.UPDATER.SCHEDULE = schedule;

                // Offered right after the updater switch: the notice is
                // independent of it (it never changes code), but operators
                // reach for this screen when they want the "new version out"
                // hint silenced or restored.
                const noticeOn = await askBoolean('Show "new version available" notice on startup', settings.UPDATER.NOTICE_ENABLED !== false);
                if (noticeOn === '\x1b') break;
                if (typeof noticeOn !== 'boolean') break;
                settings.UPDATER.NOTICE_ENABLED = noticeOn;
                break;
            case 's':
                saveGeneralSettings(settings);
                finished = true;
                break;
            case 'c':
                finished = true;
                break;
            default:
                console.log('Invalid choice.');
        }
    }
}

/**
 * Entry point exposing a menu-driven interface for creating, modifying, and reviewing bots.
 * @returns {Promise<void>}
 */
async function main() {
    console.log(`dexbot bot — bots.json configurator (writes ${BOTS_FILE})`);
    const { config, filePath } = loadBotsConfig();
    let exit = false;
     while (!exit) {
         console.log('\nActions:');
         console.log('  1) New bot');
         console.log('  2) Modify bot');
         console.log('  3) Delete bot');
         console.log('  4) Copy bot');
         console.log('  5) List bots');
         console.log('  6) General settings');
         console.log('  7) Exit (or press Enter)');
         const selection = (await readInput('Choose an action [1-7]: ')).trim();
         console.log('');

         if (selection === '\x1b' || selection === '7' || selection === '') {
             exit = true;
             continue;
         }

        switch (selection) {
            case '1': {
                while (true) {
                    try {
                        const result = await promptBotData({} as BotDraft, config.bots.length, 'new');
                        if (!result) break;
                        config.bots.push(result.data);
                        saveBotsConfig(config, filePath);
                        const adapterStatus = result.commitAdapter?.();
                        const adapterNote = adapterStatus === 'saved'
                            ? ` Adapter flags saved: Price/Weight apply on the adapter's next cycle; Range scaling after 'dexbot reset ${result.data.name}'.`
                            : '';
                        console.log(`\n${COLORS.green}Added bot '${result.data.name}' to ${path.basename(filePath)}.${adapterNote}${COLORS.reset}`);
                        // Return to the Actions menu instead of immediately
                        // opening another blank New Bot editor.
                        break;
                    } catch (err) {
                        console.log(`\n❌ Invalid input: ${getErrorMessage(err)}\n`);
                        break;
                    }
                }
                break;
            }
            case '2': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'modify or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    try {
                        const result = await promptBotData(config.bots[idx] as unknown as BotDraft, idx, 'modify');
                        if (result) {
                            config.bots[idx] = result.data;
                            saveBotsConfig(config, filePath);
                            const adapterStatus = result.commitAdapter?.();
                            const entry = result.data;
                            console.log(`saved settings '${entry.name}' in ${path.basename(filePath)}.${adapterStatus === 'saved' ? ' Adapter flags saved.' : ''}\n`);
                            console.log(`Live pickup (~1min, no reload needed): ${(BOT_LIVE_CONFIG_KEYS as readonly string[]).join(' / ')}.`);
                            console.log(`Grid geometry needs 'dexbot reset ${entry.name}' (or 'dexbot reload' for everything at once); market/account changes need 'dexbot reload'.\n`);
                        }
                    } catch (err) {
                        console.log(`\n❌ Invalid input: ${getErrorMessage(err)}\n`);
                    }
                }
                break;
            }
            case '3': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'delete or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    const placeholderName = config.bots[idx].name || `<unnamed-${idx + 1}>`;
                    const confirm = await askBoolean(`Delete '${placeholderName}'?`, false);
                    if (confirm === '\x1b') break;
                    if (confirm) {
                        // Derive the whitelist key before splicing (createBotKey
                        // uses the index only for unnamed fallback entries).
                        const removedKey = String(normalizeBotEntry(config.bots[idx], idx).botKey || '');
                        const removed = config.bots.splice(idx, 1)[0];
                        saveBotsConfig(config, filePath);
                        // Only after the bots.json save succeeded, drop the
                        // matching whitelist entry so a deleted bot leaves no
                        // stale flags behind (name reuse would inherit them).
                        if (!removeWhitelistEntry(removedKey)) {
                            console.log(`${COLORS.yellow}Warning: could not remove whitelist entry '${removedKey}' — check ${whitelistFile()}.${COLORS.reset}`);
                        }
                        console.log(`Removed bot '${removed.name || placeholderName}' from ${path.basename(filePath)}.\n`);
                    } else {
                        console.log('\nDeletion cancelled.');
                    }
                }
                break;
            }
            case '4': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'copy or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    try {
                        const result = await promptBotData(config.bots[idx] as unknown as BotDraft, idx + 1, 'copy', idx);
                        if (result) {
                            config.bots.splice(idx + 1, 0, result.data);
                            saveBotsConfig(config, filePath);
                            const adapterStatus = result.commitAdapter?.();
                            const adapterNote = adapterStatus === 'saved'
                                ? ` Adapter flags saved: Price/Weight apply on the adapter's next cycle; Range scaling after 'dexbot reset ${result.data.name}'.`
                                : '';
                            console.log(`${COLORS.green}Copied bot '${result.data.name}' into ${path.basename(filePath)}.${adapterNote}${COLORS.reset}\n`);
                        }
                    } catch (err) {
                        console.log(`\n❌ Invalid input: ${getErrorMessage(err)}\n`);
                    }
                }
                break;
            }
            case '5':
                listBots(config.bots);
                break;
            case '6':
                await promptGeneralSettings();
                break;
            case '7':
                exit = true;
                break;
            default:
                console.log('Unknown selection.');
        }
    }
    console.log('Botmanager closed!');
}

export { main, normalizeBotDraft, ensureBotAccountId, parseJsonWithComments, parseBooleanInput, colorGridPriceValue, formatPoolRefLabel, isPoolStartPrice, isPoolRefClearInput, loadGeneralSettings, resolveAdapterCommitPlan, sameAdapterFlags }


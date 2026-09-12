/**
 * modules/account_bots.ts - Bot Configuration Management
 *
 * Interactive CLI helper for editing bot profiles in profiles/bots.json.
 * Manages multi-bot configuration and metadata.
 *
 * ===============================================================================
 * EXPORTS (5 functions)
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
 *   parseJsonWithComments(raw) - Parse JSON with comment stripping
 *     (re-exported from ./order/utils/system.js)
 *
 *   parseCronToDelta(cronString) - Parse a cron expression to { days, time }
 *   deltaToCron(days, time) - Convert { days, time } back to a cron expression
 *
 * INTERNAL HELPERS (not exported):
 *   ask* prompt family (askString, askNumberWithBounds, askIntegerInRange,
 *   askNumberOrMultiplier, askNumberOrPercentage, askAsset, askAssetB,
 *   askStartPrice, askGridPriceMode, askPoolRef, askTargetSpreadPercent,
 *   askMaxPrice, askWeightDistribution, askWeightDistributionNoLegend,
 *   askLogLevel, askUpdaterBranch, askCronSchedule, askBoolean),
 *   loadBotsConfig, saveBotsConfig, listBots, selectBotIndex,
 *   loadGeneralSettings, saveGeneralSettings, isMultiplierString,
 *   colorPriceRangeValue, colorMultiplierInput,
 *   isPercentageString, colorPercentageInput,
 *   isDynamicPriceSource, colorStartPriceValue, colorGridPriceValue,
 *   colorBooleanFlag,
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
 *       "gridPrice": null,         // Reference price for x-factor bounds (3 options):
 *                                  //   "pool" / "book" = live pair price reference
 *                                  //   "ama"/"ama1".."ama4" = market adapter writes a center snapshot to
 *                                  //              profiles/orders/<botKey>.dynamicgrid.json; grid reads the effective center on reset
 *                                  //   <number> = fixed numeric reference
 *                                  //   null     = use startPrice
 *       "minPrice": "2x",
 *       "maxPrice": "2x",
 *       "incrementPercent": 0.5,
 *       "targetSpreadPercent": 2,
 *       "weightDistribution": { "sell": 1, "buy": 1 },
 *       "botFunds": { "sell": "100%", "buy": "100%" },
 *       "activeOrders": { "sell": 20, "buy": 20 },
 *       "reserveOrders": { "buy": 0, "sell": 0 },  // Edge reserves: extra live orders (buy: floor, sell: ceiling)
 *       "debtPolicy": "ignore",       // Debt policy: "ignore", "warn", or "block"
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
import { DEFAULT_CONFIG, GRID_LIMITS, TIMING, RANGE_QUALITY, LOG_LEVEL, UPDATER, MARKET_ADAPTER, NODE_MANAGEMENT, FILL_PROCESSING, PIPELINE_TIMING, CREDENTIAL_PROMPTS, MAINTENANCE, COW_PERFORMANCE, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, LOGGING_CONFIG, NATIVE_CLIENT, LAUNCHER } from './constants.js';
import { PATHS } from './paths.js';
import { SETTINGS_FILE, readGeneralSettings, writeGeneralSettings } from './general_settings.js';
import { parseJsonWithComments } from './order/utils/system.js';
import { assertNoDuplicateBotKeys, loadSettingsFile } from './bot_settings.js';
import { BOT_LIVE_CONFIG_KEYS } from './runtime_settings.js';
import { mergeSettings } from './settings_merge.js';
import { getErrorMessage } from './utils/errors.js';
import { roundToDecimals, parseRelativeMultiplier } from './order/utils/math.js';
import { CLI_COLORS } from './cli_colors.js';
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
function loadBotsConfig() {
    const { config, filePath } = loadSettingsFile(BOTS_FILE, { silent: true, exitOnError: false });
    if (!config || typeof config !== 'object') return { config: { bots: [] }, filePath };
    if (!Array.isArray(config.bots)) config.bots = [];
    return { config, filePath };
}

/**
 * Saves the bots configuration to the specified file path.
 * @param {Object} config - The configuration object to save.
 * @param {string} filePath - The path to the file.
 * @throws {Error} If saving fails.
 */
function saveBotsConfig(config: any, filePath: string): void {
    try {
        ensureProfilesDirectory(PROFILES_DIR);
        const entries = Array.isArray(config?.bots) ? config.bots : Array.isArray(config) ? config : [];
        if (entries.length >= 2) assertNoDuplicateBotKeys(entries, 'account_bots');
        writeJSON(filePath, config);
    } catch (err: any) {
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
    const defaults = {
        LOG_LEVEL: LOG_LEVEL,
        GRID_LIMITS: { ...GRID_LIMITS, GRID_COMPARISON: { ...GRID_LIMITS.GRID_COMPARISON } },
        TIMING: { ...TIMING },
        UPDATER: { ...UPDATER },
        MARKET_ADAPTER: { ...MARKET_ADAPTER },
        NODE_MANAGEMENT: { ...NODE_MANAGEMENT },
        DEFAULT_CONFIG: { ...DEFAULT_CONFIG },
        FILL_PROCESSING: { ...FILL_PROCESSING },
        PIPELINE_TIMING: { ...PIPELINE_TIMING },
        CREDENTIAL_PROMPTS: { ...CREDENTIAL_PROMPTS },
        MAINTENANCE: { ...MAINTENANCE },
        COW_PERFORMANCE: { ...COW_PERFORMANCE },
        INCREMENT_BOUNDS: { ...INCREMENT_BOUNDS },
        FEE_PARAMETERS: { ...FEE_PARAMETERS },
        API_LIMITS: { ...API_LIMITS },
        LOGGING_CONFIG: { ...LOGGING_CONFIG },
        NATIVE_CLIENT: { ...NATIVE_CLIENT },
        LAUNCHER: { ...LAUNCHER },
    };

    const settings = readGeneralSettings({
        fallback: null,
        onError: (err: any) => {
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

    return merged;
}

/**
 * Saves general settings to profiles/general.settings.json.
 * @param {Object} settings - The settings object to save.
 */
function saveGeneralSettings(settings: any): void {
    try {
        writeGeneralSettings(settings);
        console.log(`\n✓ General settings saved to ${path.basename(SETTINGS_FILE)}`);
    } catch (err: any) {
        console.error('Failed to save general settings:', getErrorMessage(err));
    }
}

/**
 * Lists the configured bots to the console.
 * @param {Array<Object>} bots - The list of bot configuration objects.
 */
function listBots(bots: any[]): void {
    if (!bots.length) {
        console.log('  (no bot entries defined yet)');
        return;
    }
    bots.forEach((bot: any, index: number) => {
        const name = bot.name || `<unnamed-${index + 1}>`;
        const inactiveSuffix = bot.active === false ? ' [inactive]' : '';
        const dryRunSuffix = bot.dryRun ? ' (dryRun)' : '';
        console.log(`  ${index + 1}: ${name}${inactiveSuffix}${dryRunSuffix} ${bot.assetA || '?'} / ${bot.assetB || '?'}`);
    });
}

/**
 * Prompts the user to select a bot from the list.
 * @param {Array<Object>} bots - The list of bots.
 * @param {string} promptMessage - The message to display.
 * @returns {Promise<number|string|null>} The selected index, '\x1b' if ESC, or null if invalid.
 */
async function selectBotIndex(bots: any[], promptMessage: string): Promise<any> {
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
async function askString(promptText: string, defaultValue?: any): Promise<any> {
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
async function askRequiredString(promptText: string, defaultValue?: any): Promise<any> {
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        if (value && value.trim()) return value.trim();
        console.log('This field is required.');
    }
}

/**
 * Prompts the user for a cron schedule using interval and time.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askCronSchedule(_promptText: string, defaultValue: string): Promise<any> {
    const current = parseCronToDelta(defaultValue);

    // Interval Prompt
    const days = await askNumberWithBounds('  Interval (days)', current.days, 1, 31);
    if (days === '\x1b') return '\x1b';

    // Time Prompt
    let time = current.time;
    while (true) {
        const rawTime = await askString('  Time (HH:mm)', current.time);
        if (rawTime === '\x1b') return '\x1b';
        if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(rawTime)) {
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
async function askUpdaterBranch(promptText: string, defaultValue: string): Promise<any> {
    const validBranches = ['main', 'dev', 'test', 'auto'];
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = value.toLowerCase().trim();
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
async function askLogLevel(promptText: string, defaultValue: string): Promise<any> {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    while (true) {
        console.log(`Available levels: ${validLevels.join(', ')}`);
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = value.toLowerCase().trim();
        if (validLevels.includes(lowered)) return lowered;
        console.log(`Invalid log level. Please choose from: ${validLevels.join(', ')}`);
    }
}

/**
 * Prompts the user for an asset symbol.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAsset(promptText: string, defaultValue?: any): Promise<any> {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        const answer = await readInput(`${promptText}${suffix}: `);
        if (answer === '\x1b') return '\x1b';

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        return answer.toUpperCase().trim();
    }
}

/**
 * Prompts the user for Asset B, ensuring it's different from Asset A.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @param {string} assetA - The symbol of Asset A.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAssetB(promptText: string, defaultValue?: any, assetA?: string): Promise<any> {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        const answer = await readInput(`${promptText}${suffix}: `);
        if (answer === '\x1b') return '\x1b';

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        const assetB = answer.toUpperCase().trim();

        // Validate that Asset B is different from Asset A
        if (assetB === assetA) {
            console.log(`Invalid: Asset B cannot be the same as Asset A (${assetA})`);
            continue;
        }

        return assetB;
    }
}

/**
 * Prompts the user for a weight distribution value with a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askWeightDistribution(promptText: string, defaultValue?: any): Promise<any> {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    console.log(`  ${COLORS.cyan}-1=SuperValley${COLORS.reset} ←→ ${COLORS.blue}0=Valley${COLORS.reset} ←→ ${COLORS.gray}0.5=Neutral${COLORS.reset} ←→ ${COLORS.bold}${COLORS.orange}1=Mountain${COLORS.reset} ←→ ${COLORS.redStrong}2=SuperMountain${COLORS.reset}`);
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistribution(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistribution(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for a weight distribution value without a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askWeightDistributionNoLegend(promptText: string, defaultValue?: any): Promise<any> {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Checks if a value is a multiplier string (e.g. "3x").
 * Delegates to the shared parser so the editor and the runtime resolver
 * agree on the exact same syntax (issue #15).
 * @param {*} value - The value to check.
 * @returns {boolean} True if it's a multiplier string.
 */
function isMultiplierString(value: any): boolean {
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
function isPercentageString(value: any): boolean {
    return typeof value === 'string' && /^[-+]?[0-9]+(?:\.[0-9]+)?%$/.test(value.trim());
}

/**
 * Colors a funds value string for display: green when it is a relative
 * percentage ("100%"), red when it is a fixed amount (no relative scaling).
 * Used for live input feedback: turns green the moment the "%" is typed.
 * @param {string} value - The value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorPercentageInput(value: any): string {
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
function colorPriceRangeValue(value: any): string {
    return colorRangeValueByQuality(String(value));
}

/**
 * Returns quality tier for a range multiplier: green/yellow/orange/red/fixed.
 * Thresholds come from RANGE_QUALITY in modules/constants.ts (single source of truth).
 * @param {*} value - Raw range value (e.g. "2x" or numeric).
 * @returns {string} Tier key.
 */
function getRangeQuality(value: any): string {
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
function isDynamicPriceSource(value: any): boolean {
    if (typeof value !== 'string') return false;
    const lower = value.trim().toLowerCase();
    return lower === 'pool' || lower === 'book' || /^ama(?:[1-4])?$/.test(lower);
}

/**
 * Colors a start-price value for display: green when it is a dynamic source
 * ("pool"/"book"), red when it is a fixed numeric price (no live rescaling).
 * Used for live input feedback: turns green the moment a source keyword is typed.
 * @param {*} value - The start price value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorStartPriceValue(value: any): string {
    const text = String(value ?? '');
    if (isDynamicPriceSource(text)) return `${COLORS.green}${text}${COLORS.reset}`;
    return `${COLORS.red}${text}${COLORS.reset}`;
}

/**
 * Colors a grid-price value for display: green for dynamic sources
 * ("pool"/"book"/AMA keywords), red for fixed numeric references. A null
 * gridPrice delegates to startPrice, so the "startPrice" label inherits the
 * start-price coloring.
 * @param {*} value - The grid price value to color.
 * @param {*} [startPrice] - The bot's current startPrice for null resolution.
 * @returns {string} ANSI-colored value string.
 */
function colorGridPriceValue(value: any, startPrice?: any): string {
    if (value === null || value === undefined) {
        const label = isDynamicPriceSource(startPrice)
            ? `${COLORS.green}startPrice${COLORS.reset}`
            : `${COLORS.red}startPrice${COLORS.reset}`;
        return label;
    }
    const text = String(value);
    if (isDynamicPriceSource(text)) return `${COLORS.green}${text}${COLORS.reset}`;
    return `${COLORS.red}${text}${COLORS.reset}`;
}

/**
 * Colors a boolean flag value for display: green when the flag is in its
 * healthy state, red when it is not.
 * @param {*} value - The boolean value to color.
 * @param {boolean} greenWhenTrue - True when `true` is the healthy state
 *                                   (e.g. Active), false when `false` is
 *                                   healthy (e.g. DryRun off).
 * @returns {string} ANSI-colored "true"/"false" string.
 */
function colorBooleanFlag(value: any, greenWhenTrue: boolean): string {
    const isTrue = !!value;
    const healthy = greenWhenTrue ? isTrue : !isTrue;
    const text = String(isTrue);
    return healthy ? `${COLORS.green}${text}${COLORS.reset}` : `${COLORS.red}${text}${COLORS.reset}`;
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
 * Prompts the user for a number within specified bounds.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {number} minVal - The minimum allowed value.
 * @param {number} maxVal - The maximum allowed value.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askNumberWithBounds(promptText: string, defaultValue?: any, minVal: number = 0, maxVal: number = 100): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= ${minVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    if (parsed > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be <= ${maxVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
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
async function askTargetSpreadPercent(promptText: string, defaultValue?: any, incrementPercent: number = 0, minSpreadFactor: number = GRID_LIMITS.MIN_SPREAD_FACTOR): Promise<any> {
    const safeIncrement = Number.isFinite(incrementPercent) ? incrementPercent : 0;
    const safeMinSpreadFactor = Number.isFinite(minSpreadFactor) ? minSpreadFactor : GRID_LIMITS.MIN_SPREAD_FACTOR;
    const minRequired = roundToDecimals(safeIncrement * safeMinSpreadFactor, 2);
    const minRequiredLabel = minRequired.toFixed(2);
    const effectiveDefault = Number.isFinite(defaultValue) ? Math.max(roundToDecimals(defaultValue, 2), minRequired) : defaultValue;
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
async function askIntegerInRange(promptText: string, defaultValue?: any, minVal: number = 0, maxVal: number = 100): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is integer (not float)
    if (!Number.isInteger(parsed)) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be an integer (no decimals)`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal || parsed > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be between ${minVal} and ${maxVal}`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
}

/**
 * Prompts the user for a numeric value or a multiplier. Used for price
 * range bounds (currently only minPrice); multiplier validation assumes a
 * price-bound context and derives its min/max explanation from promptText.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askNumberOrMultiplier(promptText: string, defaultValue?: any): Promise<any> {
    // Pre-entry legend for Range bounds (mirrors weight mountain legend)
    if (/^(minPrice|maxPrice)/i.test(promptText)) printRangeQualityLegend();
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${colorPriceRangeValue(defaultValue)}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `, { colorize: (input) => colorRangeValueByQuality(input) })).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askNumberOrMultiplier(promptText, defaultValue);
        }
        // A sub-1x bound multiplier ("0.7x") resolves to the wrong side of
        // the grid. Reject so the rail can't land across the book (issue #15).
        const directionNote = /max/i.test(promptText)
            ? 'For maxPrice, "Nx" means center*N, so a multiplier < 1 places the bound BELOW the center. Use a value > 1.'
            : 'For minPrice, "Nx" means center/N, so a multiplier < 1 places the bound ABOVE the center. Use a value > 1 (e.g. "1.43x" for 70% of center).';
        if (multiplier < 1) {
            console.log(`Invalid ${promptText}: "${trimmed}". ${directionNote}`);
            return askNumberOrMultiplier(promptText, defaultValue);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for the maximum price, ensuring it's greater than minimum price.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @param {number|string} minPrice - The minimum price.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askMaxPrice(promptText: string, defaultValue?: any, minPrice?: any): Promise<any> {
    printRangeQualityLegend();
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${colorPriceRangeValue(defaultValue)}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `, { colorize: (input) => colorRangeValueByQuality(input) })).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askMaxPrice(promptText, defaultValue, minPrice);
        }
        // For maxPrice a multiplier < 1 ("0.7x") resolves to center*0.7 — a
        // bound BELOW the center. Reject so the rail can't land across the book.
        if (multiplier < 1) {
            console.log(`Invalid ${promptText}: "${trimmed}". For maxPrice, "Nx" means center*N, so a multiplier < 1 places the bound BELOW the center. Use a value > 1.`);
            return askMaxPrice(promptText, defaultValue, minPrice);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that maxPrice > minPrice. Only comparable when minPrice is an
    // absolute value: a relative min ("2x") needs the grid center to resolve,
    // so it can't be checked here — the runtime bound validation covers it
    // (previously parseFloat("2x") == 2 wrongly rejected any absolute price <= 2).
    if (!isMultiplierString(minPrice)) {
        const minPriceValue = typeof minPrice === 'string' ? parseFloat(minPrice) : minPrice;
        if (parsed <= minPriceValue) {
            console.log(`Invalid ${promptText}: ${parsed}. Must be > minPrice (${minPriceValue})`);
            return askMaxPrice(promptText, defaultValue, minPrice);
        }
    }
    return parsed;
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
async function askNumberOrPercentage(promptText: string, defaultValue?: any): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${colorPercentageInput(defaultValue)}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `, { colorize: (input) => colorPercentageInput(input) })).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const percent = normalizePercentageInput(raw);
    if (percent !== null) return percent;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or percentage (e.g. 100, 50%).');
        return askNumberOrPercentage(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for a boolean value (Y/n).
 * @param {string} promptText - The prompt text to display.
 * @param {boolean} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<boolean|string>} The boolean value or '\x1b' if ESC.
 */
async function askBoolean(promptText: string, defaultValue?: any): Promise<any> {
    const label = defaultValue ? 'Y/n' : 'y/N';
    const raw = (await readInput(`${promptText} (${label}): `)).trim().toLowerCase();
    if (raw === '\x1b') return '\x1b';
    if (!raw) return !!defaultValue;
    return raw.startsWith('y');
}

/**
 * Prompts the user for the start price (numeric or "pool"/"book").
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The start price or '\x1b' if ESC.
 */
async function askStartPrice(promptText: string, defaultValue?: any): Promise<any> {
    while (true) {
        const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${colorStartPriceValue(defaultValue)}]` : '';
        const raw = (await readInput(`${promptText}${suffix}: `, {
            colorize: (input: string) => colorStartPriceValue(input)
        })).trim();

        if (raw === '\x1b') return '\x1b';

        if (!raw) {
            if (defaultValue !== undefined && defaultValue !== null) {
                return defaultValue;
            }
            return undefined;
        }

        const lower = raw.toLowerCase();
        if (lower === 'pool') return lower;
        if (lower === 'book') return 'book';

        // Accept numeric values (including decimals)
        const num = Number(raw);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
            return num;
        }

        console.log('Please enter "pool", "book", or a numeric value.');
    }
}

/**
 * Prompts the user for an optional pool ID to pin price derivation.
 * Enter a pool ID (e.g. 48 or 1.19.48) to set/change the pin, or enter
 * "none" / "clear" to remove it. Blank input keeps the current value.
 * @param {string} promptText - The prompt text to display.
 * @param {string|null|undefined} [currentValue] - The current poolRef value.
 * @returns {Promise<string|null|symbol>} Pool ID, null (cleared), or '\x1b' on ESC.
 */
async function askPoolRef(promptText: string, currentValue?: string | null | undefined): Promise<any> {
    while (true) {
        const suffix = currentValue ? ` [${currentValue}]` : ' [none]';
        const raw = (await readInput(`${promptText}${suffix} (none to clear): `)).trim();
        if (raw === '\x1b') return '\x1b';
        if (!raw) return currentValue || null;

        const lower = raw.toLowerCase();
        if (lower === 'none' || lower === 'clear' || lower === 'off' || lower === 'no') {
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
 * Prompts the user for the grid price mode (pool, book, ama, numeric, or startprice).
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @param {*} [startPrice] - The bot's current startPrice, used to color the
 *                           "startPrice" default label when gridPrice is null.
 * @returns {Promise<string>} The grid price mode or '\x1b' if ESC.
 */
async function askGridPriceMode(promptText: string, defaultValue?: any, startPrice?: any): Promise<any> {
    while (true) {
        const coloredDefault = defaultValue === null || defaultValue === undefined
            ? colorGridPriceValue(null, startPrice)
            : colorGridPriceValue(defaultValue);
        const raw = (await readInput(`${promptText} [${coloredDefault}]: `, {
            colorize: (input: string) => colorGridPriceValue(input)
        })).trim();
        if (raw === '\x1b') return '\x1b';
        if (!raw) return defaultValue === undefined ? null : defaultValue;

        const lower = raw.toLowerCase();
        if (lower === 'none' || lower === 'null' || lower === 'start' || lower === 'startprice') return null;
        if (lower === 'pool') return lower;
        if (lower === 'book') return 'book';
        if (/^ama(?:[1-4])?$/.test(lower)) return lower;

        const num = Number(raw);
        if (Number.isFinite(num) && num > 0) return num;

        console.log('Please enter: pool, book, ama, ama1..ama4, a positive number, or none/startprice.');
    }
}

/**
 * Normalizes a bot draft for editing or saving.
 * Preserves existing fields and strips unsupported runtime-managed fields.
 * @param {Object} [base={}] - The initial bot data to edit.
 * @returns {Object} A normalized bot draft.
 */
function normalizeBotDraft(base = {}) {
    const data = JSON.parse(JSON.stringify(base));

    if (!data.weightDistribution) data.weightDistribution = { ...DEFAULT_CONFIG.weightDistribution };
    if (!data.botFunds) data.botFunds = { ...DEFAULT_CONFIG.botFunds };
    if (!data.activeOrders) data.activeOrders = { ...DEFAULT_CONFIG.activeOrders };
    if (typeof data.reserveOrders === 'number') data.reserveOrders = { buy: Math.max(0, Math.floor(data.reserveOrders)), sell: 0 };
    if (data.reserveOrders === undefined || data.reserveOrders === null || typeof data.reserveOrders !== 'object' || Array.isArray(data.reserveOrders)) data.reserveOrders = { ...DEFAULT_CONFIG.reserveOrders };

    if (data.active === undefined) data.active = DEFAULT_CONFIG.active;
    if (data.dryRun === undefined) data.dryRun = DEFAULT_CONFIG.dryRun;
    if (data.minPrice === undefined) data.minPrice = DEFAULT_CONFIG.minPrice;
    if (data.maxPrice === undefined) data.maxPrice = DEFAULT_CONFIG.maxPrice;
    if (data.incrementPercent === undefined) data.incrementPercent = DEFAULT_CONFIG.incrementPercent;
    if (data.targetSpreadPercent === undefined) data.targetSpreadPercent = DEFAULT_CONFIG.targetSpreadPercent;
    if (data.startPrice === undefined) data.startPrice = data.startPrice || DEFAULT_CONFIG.startPrice || 'pool';
    if (data.gridPrice === undefined) data.gridPrice = null;
    delete data.gridPriceOffsetPct;
    delete data.gridPriceOffsetClampToBounds;
    return data;
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
async function ensureBotAccountId(data: any, timeoutMs = 15000, quiet = false, force = false): Promise<{ id: string | null; reason: string }> {
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
    let chainClient: any = null;
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
        const timeoutErr: any = new Error(`account lookup timed out after ${timeoutMs}ms`);
        timeoutErr.code = 'ACCOUNT_LOOKUP_TIMEOUT';
        let id: string | null = null;
        try {
            id = await Promise.race([
                chainOrders.resolveAccountId(ref),
                sleep(timeoutMs).then(() => { throw timeoutErr; }),
            ]);
        } catch (err: any) {
            const reason = err && err.code === 'ACCOUNT_LOOKUP_TIMEOUT' ? 'timeout' : 'error';
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
    } catch (err: any) {
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

/**
 * Interactive menu to edit bot data.
 * @param {Object} [base={}] - The initial bot data to edit.
 * @returns {Promise<Object|null>} The edited bot data or null if cancelled.
 */
async function promptBotData(base = {}) {
    const data = normalizeBotDraft(base);

    let finished = false;
    let cancelled = false;
    let showMenu = true;

    while (!finished) {
        if (showMenu) {
             console.log(`\n${COLORS.bold}--- Bot Editor: ` + (data.name || 'New Bot') + ` ---${COLORS.reset}`);
             console.log(`${COLORS.yellowBold}1) Pair:${COLORS.reset}       ${COLORS.cyan}${data.assetA || '?'} / ${data.assetB || '?'}${COLORS.reset}`);
             console.log(`${COLORS.yellowBold}2) Identity:${COLORS.reset}   ${COLORS.orange}Name:${COLORS.reset} ${data.name || '?'} , ${COLORS.orange}Account:${COLORS.reset} ${data.preferredAccount || '?'} , ${COLORS.orange}Active:${COLORS.reset} ${colorBooleanFlag(data.active, true)}, ${COLORS.orange}DryRun:${COLORS.reset} ${colorBooleanFlag(data.dryRun, false)}`);
             console.log(`${COLORS.yellowBold}3) Price:${COLORS.reset}      ${COLORS.orange}Range:${COLORS.reset} [${colorPriceRangeValue(data.minPrice)} - ${colorPriceRangeValue(data.maxPrice)}], ${COLORS.orange}Start:${COLORS.reset} ${colorStartPriceValue(data.startPrice)}, ${COLORS.orange}Pool:${COLORS.reset} ${data.poolRef || 'none'}, ${COLORS.orange}GridPrice:${COLORS.reset} ${colorGridPriceValue(data.gridPrice, data.startPrice)}`);
             console.log(`${COLORS.yellowBold}4) Grid:${COLORS.reset}       ${COLORS.orange}Weights:${COLORS.reset} (S:${data.weightDistribution.sell}, B:${data.weightDistribution.buy}), ${COLORS.orange}Incr:${COLORS.reset} ${data.incrementPercent}%, ${COLORS.orange}Spread:${COLORS.reset} ${data.targetSpreadPercent}%`);
             console.log(`${COLORS.yellowBold}5) Funding:${COLORS.reset}    ${COLORS.orange}Sell:${COLORS.reset} ${colorPercentageInput(data.botFunds.sell)}, ${COLORS.orange}Buy:${COLORS.reset} ${colorPercentageInput(data.botFunds.buy)} | ${COLORS.orange}Orders:${COLORS.reset} (S:${data.activeOrders.sell}, B:${data.activeOrders.buy}) | ${COLORS.orange}Reserve:${COLORS.reset} (S:${data.reserveOrders?.sell ?? 0}, B:${data.reserveOrders?.buy ?? 0})`);
             console.log('--------------------------------------------------');
             console.log(`${COLORS.greenBold}S) Save & Exit${COLORS.reset}`);
             console.log(`${COLORS.white}C) Cancel (Discard changes)${COLORS.reset}`);
            showMenu = false;
        }

        const choice = (await readInput('Select section to edit or action: ', {
            validate: (input: string) => ['1', '2', '3', '4', '5', 's', 'c'].includes(input.toLowerCase())
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
                let prefAcc = await askRequiredString('Preferred account', data.preferredAccount);
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
                        const retry = await askRequiredString('Preferred account', String(draft.preferredAccount ?? ''));
                        if (retry === '\x1b') { prefAcc = retry; break; }
                        draft.preferredAccount = retry;
                    }
                    if (prefAcc === '\x1b') break;
                    prefAcc = String(draft.preferredAccount);
                    data.accountId = draft.accountId;
                }
                const active = await askBoolean('Active', data.active);
                if (active === '\x1b') break;
                const dryRun = await askBoolean('Dry run', data.dryRun);
                if (dryRun === '\x1b') break;
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
                const startP = await askStartPrice('startPrice (pool, book or A/B)', data.startPrice);
                if (startP === '\x1b') break;
                const poolR = await askPoolRef('poolRef (pinned pool ID for price source)', data.poolRef);
                if (poolR === '\x1b') break;
                const gp = await askGridPriceMode('gridPrice (pool/book/ama/number/none)', data.gridPrice, data.startPrice);
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
                const defaultSpread = data.targetSpreadPercent || incrP * 4;

                // Use current general settings for the validation limit
                const currentSettings = loadGeneralSettings();
                const targetS = await askTargetSpreadPercent('targetSpread %', defaultSpread, incrP, currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR);

                if (targetS === '\x1b') break;
                data.weightDistribution.sell = wSell;
                data.weightDistribution.buy = wBuy;
                data.incrementPercent = incrP;
                data.targetSpreadPercent = targetS;
                showMenu = true;
                break;
            case '5':
                const fSell = await askNumberOrPercentage('botFunds sell amount', data.botFunds.sell);
                if (fSell === '\x1b') break;
                const fBuy = await askNumberOrPercentage('botFunds buy amount', data.botFunds.buy);
                if (fBuy === '\x1b') break;
                const oSell = await askIntegerInRange('activeOrders sell count', data.activeOrders.sell, 1, 100);
                if (oSell === '\x1b') break;
                const oBuy = await askIntegerInRange('activeOrders buy count', data.activeOrders.buy, 1, 100);
                if (oBuy === '\x1b') break;
                const rBuy = await askIntegerInRange('reserveOrders buy floor count (0 disables)', data.reserveOrders?.buy ?? 0, 0, 20);
                if (rBuy === '\x1b') break;
                const rSell = await askIntegerInRange('reserveOrders sell ceiling count (0 disables)', data.reserveOrders?.sell ?? 0, 0, 20);
                if (rSell === '\x1b') break;
                data.botFunds.sell = fSell;
                data.botFunds.buy = fBuy;
                data.activeOrders.sell = oSell;
                data.activeOrders.buy = oBuy;
                data.reserveOrders = { buy: rBuy, sell: rSell };
                showMenu = true;
                break;
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
                    const minRequiredSpread = roundToDecimals(data.incrementPercent * spreadFactor, 2);
                    if (data.targetSpreadPercent + Number.EPSILON < minRequiredSpread) {
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

    // Return the final data structure, preserving ALL fields from the normalized
    // draft (deep-copy of base + defaults, minus stripped runtime-managed fields).
    // A fixed whitelist here would silently drop custom overrides (logging, timing,
    // feeParams, gridLimits, poolRef, etc.) when the caller replaces the bot entry.
    return { ...data };
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
          console.log(`${COLORS.yellowBold}1) Grid Health:${COLORS.reset}   ${COLORS.orange}Ratio:${COLORS.reset} ${settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE}%, ${COLORS.orange}RMS:${COLORS.reset} ${settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE}%, ${COLORS.orange}AMA Delta:${COLORS.reset} ${settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT}%`);
          console.log(`${COLORS.yellowBold}2) Order Recovery:${COLORS.reset} ${COLORS.orange}Dust Threshold:${COLORS.reset} ${settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE}%`);
          const nodeCount = (settings.NODES.list || []).length;
          const hcIntervalMin = ((settings.NODES.healthCheck?.intervalMs || NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS) / 60000).toFixed(0);
          const prefNodeDisplay = settings.NODES.selection?.preferredNode || 'none';
          console.log(`${COLORS.yellowBold}3) Node Config:${COLORS.reset} ${COLORS.orange}Nodes:${COLORS.reset} ${nodeCount}, ${COLORS.orange}HealthChk:${COLORS.reset} ${hcIntervalMin}min, ${COLORS.orange}PrefNode:${COLORS.reset} ${prefNodeDisplay}`);
          console.log(`${COLORS.yellowBold}4) Log lvl:${COLORS.reset}      ${COLORS.orange}${settings.LOG_LEVEL}${COLORS.reset} (debug, info, warn, error)`);
          const updaterStatus = settings.UPDATER.ACTIVE ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`;
          const currentSched = parseCronToDelta(settings.UPDATER.SCHEDULE || "0 0 * * *");
          console.log(`${COLORS.yellowBold}5) Updater:${COLORS.reset}      [${updaterStatus}] ${COLORS.orange}Branch:${COLORS.reset} ${settings.UPDATER.BRANCH}, ${COLORS.orange}Interval:${COLORS.reset} ${currentSched.days}d, ${COLORS.orange}Time:${COLORS.reset} ${currentSched.time}`);
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
                const gRegen = await askNumberWithBounds('Grid Ratio Regeneration %', settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE, 0.1, 50);
                if (gRegen === '\x1b') break;
                const rms = await askNumberWithBounds('RMS Divergence Threshold %', settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE, 1, 100);
                if (rms === '\x1b') break;
                const amaDelta = await askNumberWithBounds('AMA Delta Threshold %', settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT, 0.1, 50.0);
                if (amaDelta === '\x1b') break;
                settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE = gRegen;
                settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE = rms;
                settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT = amaDelta;
                break;
            case '2':
                const dust = await askNumberWithBounds('Partial Dust Threshold %', settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE, 0.1, 50);
                if (dust === '\x1b') break;
                settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE = dust;
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
                            const removed = nodeList.splice(removeIdx - 1, 1)[0];
                            console.log(`  ${COLORS.green}Removed:${COLORS.reset} ${removed}`);
                        } else if (nodeChoice === 'd') {
                            settings.NODES.list = nodeList;
                            break;
                        }
                    }

                    if (editorCancelled) break;
                }

                const hcInterval = await askIntegerInRange('Health Check Interval (min)', (settings.NODES.healthCheck?.intervalMs || NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS) / 60000, 1, 43200);
                if (hcInterval === '\x1b') break;
                if (!settings.NODES.healthCheck) settings.NODES.healthCheck = {};
                settings.NODES.healthCheck.intervalMs = hcInterval * 60000;

                const prefNode = await askString('Preferred Node URL (leave empty for automatic selection)', settings.NODES.selection?.preferredNode || '');
                if (prefNode === '\x1b') break;
                if (!settings.NODES.selection) settings.NODES.selection = {};
                settings.NODES.selection.preferredNode = prefNode.trim() || null;
                break;
            case '4':
                const newLevel = await askLogLevel('Enter log level', settings.LOG_LEVEL);
                if (newLevel === '\x1b') break;
                settings.LOG_LEVEL = newLevel;
                break;
            case '5':
                const upActive = await askBoolean('Enable Automated Updater', settings.UPDATER.ACTIVE !== false);
                if (upActive === '\x1b') break;
                settings.UPDATER.ACTIVE = upActive;

                 console.log(`  ${COLORS.gray}Branch:${COLORS.reset} ${COLORS.green}main${COLORS.reset}, ${COLORS.orange}dev${COLORS.reset}, ${COLORS.red}test${COLORS.reset}, or ${COLORS.blue}auto${COLORS.reset} (detected current)`);
                const branch = await askUpdaterBranch('Branch', settings.UPDATER.BRANCH);
                if (branch === '\x1b') break;

                const schedule = await askCronSchedule('Schedule', settings.UPDATER.SCHEDULE);
                if (schedule === '\x1b') break;

                settings.UPDATER.BRANCH = branch;

                settings.UPDATER.SCHEDULE = schedule;
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
                        const entry = await promptBotData();
                        if (!entry) break;
                        config.bots.push(entry);
                        saveBotsConfig(config, filePath);
                        console.log(`\nAdded bot '${entry.name}' to ${path.basename(filePath)}.`);
                    } catch (err: any) {
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
                        const entry = await promptBotData(config.bots[idx]);
                        if (entry) {
                            config.bots[idx] = entry;
                            saveBotsConfig(config, filePath);
                            console.log(`saved settings '${entry.name}' in ${path.basename(filePath)}.\n`);
                            console.log(`Live pickup (~1min, no reload needed): ${(BOT_LIVE_CONFIG_KEYS as readonly string[]).join(' / ')}.`);
                            console.log(`Grid geometry needs 'dexbot reset ${entry.name}' (or 'dexbot reload' for everything at once); market/account changes need 'dexbot reload'.\n`);
                        }
                    } catch (err: any) {
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
                        const removed = config.bots.splice(idx, 1)[0];
                        saveBotsConfig(config, filePath);
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
                        const entry = await promptBotData(config.bots[idx]);
                        if (entry) {
                            config.bots.splice(idx + 1, 0, entry);
                            saveBotsConfig(config, filePath);
                            console.log(`Copied bot '${entry.name}' into ${path.basename(filePath)}.\n`);
                        }
                    } catch (err: any) {
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

export { main, normalizeBotDraft, ensureBotAccountId, parseJsonWithComments, parseCronToDelta, deltaToCron }


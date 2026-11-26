
import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import { DEFAULT_CONFIG, GRID_LIMITS, INCREMENT_BOUNDS } from '../../modules/constants.js';
import { resolveRelativePrice } from '../../modules/order/utils/math.js';
import { Config } from '../../modules/config.js';
import { PATHS, MANUAL_GRID_FULL_RESET_SOURCE } from '../../modules/paths.js';
import { writeJsonFileAtomic as baseWriteJsonFileAtomic } from '../../modules/bots_file_lock.js';
import { acquireFileLock } from '../../market_adapter/utils/file_lock.js';
import { assertNoDuplicateBotKeys, normalizeBotEntry } from '../../modules/bot_settings.js';
import { migrateLegacyOrderKeys } from '../../modules/bot_defaults.js';
import { BOT_LIVE_CONFIG_KEYS } from '../../modules/runtime_settings.js';
import { clone } from './utils.js';
import { createBotKey, sanitizeKey } from '../../modules/account_orders.js';
import { isSameBotName } from '../../modules/utils/sanitize_key.js';
const storage = getStorage();

import type { BotSettings, ProfileOptions, ClawProfileBundle } from './types.js';
import { getErrorMessage } from '../../modules/utils/errors.js';

const DEFAULT_MANIFEST_FILE = 'config.json';
const DEFAULT_BOTS_FILE = 'bots.json';
const DEFAULT_GENERAL_SETTINGS_FILE = 'general.settings.json';
const DEFAULT_MARKET_PROFILES_FILE = 'market_profiles.json';
const DEFAULT_ORDERS_DIR = 'orders';

const KNOWN_BOT_KEYS = new Set([
  'active', 'coreOrders', 'edgeOrders', 'assetA', 'assetAId', 'assetB', 'assetBId',
  'botFunds', 'debtPolicy', 'dryRun', 'gridPrice',
  'incrementPercent', 'maxPrice',
  'minPrice', 'name', 'preferredAccount', 'startPrice', 'strategy',
  'targetSpreadPercent', 'weightDistribution',
  // Added by normalization
  'botIndex', 'botKey'
]);
const BOT_SETTINGS_READ_ONLY_KEYS = new Set(['botIndex', 'botKey']);
const BOT_SETTINGS_TRIGGER_KEYS = new Set([
  'active',
  'coreOrders',
  'edgeOrders',
  'assetA',
  'assetAId',
  'assetB',
  'assetBId',
  'botFunds',
  'debtPolicy',
  'dryRun',
  'gridPrice',
  'incrementPercent',
  'maxPrice',
  'minPrice',
  'preferredAccount',
  'startPrice',
  'strategy',
  'targetSpreadPercent',
  'weightDistribution'
]);
const REQUIRED_BOT_KEY_ALIASES = {
  assetA: ['assetA', 'assetAId'],
  assetB: ['assetB', 'assetBId']
};

const BOT_SETTINGS_NESTED_KEYS = Object.freeze({
  coreOrders: new Set(['buy', 'sell']),
  edgeOrders: new Set(['buy', 'sell']),
  botFunds: new Set(['buy', 'sell']),
  weightDistribution: new Set(['buy', 'sell'])
});
const BOT_SETTINGS_STATE_FIELDS = Object.freeze({
  numeric: [
    'incrementPercent',
    'targetSpreadPercent'
  ],
  boolean: [
    'active',
    'dryRun'
  ],
  priceLike: [
    'startPrice',
    'gridPrice',
    'minPrice',
    'maxPrice'
  ],
  string: [
    'name',
    'preferredAccount',
    'assetA',
    'assetB',
    'assetAId',
    'assetBId',
    'strategy'
  ]
});

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: any) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumericString(value: any) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed));
}

function isPositiveNumericString(value: any) {
  if (!isNumericString(value)) {
    return false;
  }

  return Number(value.trim()) > 0;
}

function isPositiveMultiplierString(value: any) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?x$/i.test(trimmed)) {
    return false;
  }

  return parseFloat(trimmed) > 0;
}

function isPositivePriceLike(value: any) {
  return (
    (typeof value === 'number' && Number.isFinite(value) && value > 0) ||
    isPositiveNumericString(value) ||
    isPositiveMultiplierString(value)
  );
}

function resolveComparablePriceValue(value: any, startPrice: any = null, mode: string = 'min') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (isNumericString(value)) {
    return Number(value.trim());
  }

  if (typeof value === 'string' && Number.isFinite(startPrice)) {
    const resolved = resolveRelativePrice(value, startPrice, mode);
    return Number.isFinite(resolved) ? resolved : null;
  }

  return null;
}

function validateNestedBotSettingKeys(field: any, value: any, errors: any[]) {
  const allowedKeys = (BOT_SETTINGS_NESTED_KEYS as any)[field];
  if (!allowedKeys || !isPlainObject(value)) {
    return;
  }

  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`${field} contains unrecognized keys: ${unknownKeys.join(', ')}`);
  }
}

function normalizeBooleanField(value: any, fallback: any) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

function normalizeNumberField(value: any, fallback: any) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isPercentageString(value: any) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed.endsWith('%')) {
    return false;
  }

  const numeric = Number(trimmed.slice(0, -1).trim());
  return Number.isFinite(numeric);
}

function cloneBotSettings(value: any) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

/**
 * Normalize a partial bot settings object with defaults.
 * Fills missing fields from DEFAULT_CONFIG and clamps values within bounds.
 */
function normalizeBotSettings(bot: Partial<BotSettings> = {}) {
  const normalized = migrateLegacyOrderKeys(cloneBotSettings(bot) || {});

  normalized.active = normalizeBooleanField(normalized.active, DEFAULT_CONFIG.active);
  normalized.dryRun = normalizeBooleanField(normalized.dryRun, DEFAULT_CONFIG.dryRun);
  normalized.startPrice = normalized.startPrice === undefined ? DEFAULT_CONFIG.startPrice : normalized.startPrice;
  normalized.minPrice = normalized.minPrice === undefined ? DEFAULT_CONFIG.minPrice : normalized.minPrice;
  normalized.maxPrice = normalized.maxPrice === undefined ? DEFAULT_CONFIG.maxPrice : normalized.maxPrice;
  normalized.gridPrice = normalized.gridPrice === undefined ? DEFAULT_CONFIG.gridPrice : normalized.gridPrice;
  normalized.incrementPercent = normalized.incrementPercent === undefined
    ? DEFAULT_CONFIG.incrementPercent
    : normalizeNumberField(normalized.incrementPercent, DEFAULT_CONFIG.incrementPercent);
  normalized.targetSpreadPercent = normalized.targetSpreadPercent === undefined
    ? DEFAULT_CONFIG.targetSpreadPercent
    : normalizeNumberField(normalized.targetSpreadPercent, DEFAULT_CONFIG.targetSpreadPercent);
  normalized.weightDistribution = {
    ...cloneBotSettings(DEFAULT_CONFIG.weightDistribution),
    ...(isPlainObject(normalized.weightDistribution) ? normalized.weightDistribution : {})
  };
  normalized.botFunds = {
    ...cloneBotSettings(DEFAULT_CONFIG.botFunds),
    ...(isPlainObject(normalized.botFunds) ? normalized.botFunds : {})
  };
  normalized.coreOrders = {
    ...cloneBotSettings(DEFAULT_CONFIG.coreOrders),
    ...(isPlainObject(normalized.coreOrders) ? normalized.coreOrders : {})
  };
  // Legacy numeric form migrates to `{ buy: n, sell: 0 }` before the default
  // merge (mirrors the shared runtime resolver).
  if (typeof normalized.edgeOrders === 'number') {
    normalized.edgeOrders = { buy: Math.max(0, Math.floor(normalized.edgeOrders)), sell: 0 };
  }
  normalized.edgeOrders = {
    ...cloneBotSettings(DEFAULT_CONFIG.edgeOrders),
    ...(isPlainObject(normalized.edgeOrders) ? normalized.edgeOrders : {})
  };
  return normalized;
}

function mergeBotSettingsPatch(currentBot: Record<string, any> = {}, patch: Record<string, any> = {}) {
  const next = migrateLegacyOrderKeys(cloneBotSettings(currentBot) || {});
  patch = migrateLegacyOrderKeys({ ...patch });
  const patchKeys = Object.keys(patch || {});

  for (const key of patchKeys) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }

    if (['weightDistribution', 'botFunds', 'coreOrders', 'edgeOrders'].includes(key) && isPlainObject(value)) {
      next[key] = {
        ...(isPlainObject(next[key]) ? next[key] : {}),
        ...value
      };
      continue;
    }

    next[key] = value;
  }

  return next;
}

/**
 * Describe which bot settings are read-only vs writable, and which trigger a recalc.
 * Useful for tool-catalog generation and consumer-side validation.
 */
function describeBotSettingMutability() {
  const readOnly = [...BOT_SETTINGS_READ_ONLY_KEYS].sort();
  const writable = [...KNOWN_BOT_KEYS].filter((key) => !BOT_SETTINGS_READ_ONLY_KEYS.has(key)).sort();

  // triggerOnChange is the full trigger-eligible set; the default trigger
  // fires only for triggerOnChange minus livePickupOnChange (those are
  // applied by the running bot within ~1min, no resync needed).
  return {
    livePickupOnChange: [...(BOT_LIVE_CONFIG_KEYS as readonly string[])].sort(),
    readOnly,
    triggerOnChange: [...BOT_SETTINGS_TRIGGER_KEYS].sort(),
    writable
  };
}

/**
 * Default resync-trigger predicate: a trigger-eligible key that is NOT
 * applied live by the running bot. Single predicate for the validator
 * (triggerRequired) and the apply path (shouldWriteTrigger).
 */
function isResyncTriggerKey(key: string): boolean {
  return BOT_SETTINGS_TRIGGER_KEYS.has(key)
    && !(BOT_LIVE_CONFIG_KEYS as readonly string[]).includes(key);
}

function validateBotSettingsValue(field: any, value: any, errors: any[]) {
  const push = (message: any) => errors.push(message);

  switch (field) {
    case 'active':
    case 'dryRun':
      if (typeof value !== 'boolean') {
        push(`${field} must be a boolean`);
      }
      break;

    case 'name':
    case 'preferredAccount':
    case 'assetA':
    case 'assetB':
    case 'strategy':
      if (typeof value !== 'string' || value.trim() === '') {
        push(`${field} must be a non-empty string`);
      }
      break;

    case 'assetAId':
    case 'assetBId':
      if (typeof value !== 'string' || value.trim() === '') {
        push(`${field} must be a non-empty string`);
      }
      break;

    case 'incrementPercent': {
      const increment = Number(value);
      if (!Number.isFinite(increment) || increment <= 0) {
        push('incrementPercent must be a positive number');
        break;
      }
      if (Number.isFinite(INCREMENT_BOUNDS.MIN_PERCENT) && increment < INCREMENT_BOUNDS.MIN_PERCENT) {
        push(`incrementPercent must be >= ${INCREMENT_BOUNDS.MIN_PERCENT}`);
      }
      if (Number.isFinite(INCREMENT_BOUNDS.MAX_PERCENT) && increment > INCREMENT_BOUNDS.MAX_PERCENT) {
        push(`incrementPercent must be <= ${INCREMENT_BOUNDS.MAX_PERCENT}`);
      }
      break;
    }

    case 'targetSpreadPercent': {
      const spread = Number(value);
      if (!Number.isFinite(spread) || spread <= 0) {
        push('targetSpreadPercent must be a positive number');
      }
      break;
    }

    case 'startPrice':
      if (!isPositivePriceLike(value)
        && !(typeof value === 'string' && ['pool', 'book'].includes(value.toLowerCase()))) {
        push('startPrice must be a positive number, "pool", or "book"');
      }
      break;

    case 'gridPrice':
      if (value !== null
        && !isPositivePriceLike(value)
        && !(typeof value === 'string' && /^(pool|book|ama(?:[1-4])?)$/i.test(value))) {
        push('gridPrice must be null, a positive number, or one of pool/book/ama/ama1..ama4');
      }
      break;

    case 'minPrice':
    case 'maxPrice':
      if (!isPositivePriceLike(value)) {
        push(`${field} must be a positive number or a multiplier string like 3x`);
      }
      break;



    case 'weightDistribution':
      if (!isPlainObject(value)) {
        push('weightDistribution must be an object with sell and buy');
        break;
      }
      validateNestedBotSettingKeys('weightDistribution', value, errors);
      if (!isFiniteNumber(value.sell)) {
        push('weightDistribution.sell must be a finite number');
      }
      if (!isFiniteNumber(value.buy)) {
        push('weightDistribution.buy must be a finite number');
      }
      break;

    case 'botFunds':
      if (!isPlainObject(value)) {
        push('botFunds must be an object with sell and buy');
        break;
      }
      validateNestedBotSettingKeys('botFunds', value, errors);
      for (const side of ['sell', 'buy']) {
        const sideValue = value[side];
        if (sideValue === undefined) {
          continue;
        }
        if (typeof sideValue === 'number') {
          if (!Number.isFinite(sideValue) || sideValue < 0) {
            push(`botFunds.${side} must be a finite number greater than or equal to 0`);
          }
          continue;
        }
        if (typeof sideValue === 'string' && isPercentageString(sideValue)) {
          const numeric = Number(sideValue.trim().slice(0, -1).trim());
          if (numeric < 0) {
            push(`botFunds.${side} percentage must be greater than or equal to 0`);
          }
          continue;
        }
        push(`botFunds.${side} must be a finite number or a percentage string`);
      }
      break;

    case 'coreOrders':
      if (!isPlainObject(value)) {
        push('coreOrders must be an object with sell and buy');
        break;
      }
      validateNestedBotSettingKeys('coreOrders', value, errors);
      for (const side of ['sell', 'buy']) {
        const sideValue = value[side];
        if (sideValue === undefined) {
          continue;
        }
        if (!Number.isInteger(Number(sideValue)) || Number(sideValue) < 0) {
          push(`coreOrders.${side} must be an integer greater than or equal to 0`);
        }
      }
      break;

    case 'edgeOrders': {
      // Legacy numeric form is accepted and migrated at read time.
      const edgeValue = typeof value === 'number'
        ? { buy: value, sell: 0 }
        : value;
      if (typeof value === 'number' && (!Number.isInteger(value) || value < 0)) {
        push('edgeOrders numeric form must be a non-negative integer');
        break;
      }
      if (!isPlainObject(edgeValue)) {
        push('edgeOrders must be an object with sell and buy');
        break;
      }
      validateNestedBotSettingKeys('edgeOrders', edgeValue, errors);
      for (const side of ['sell', 'buy']) {
        const sideValue = edgeValue[side];
        if (sideValue === undefined) {
          continue;
        }
        if (!Number.isInteger(Number(sideValue)) || Number(sideValue) < 0) {
          push(`edgeOrders.${side} must be an integer greater than or equal to 0`);
        }
      }
      break;
    }

    case 'debtPolicy':
      if (value !== undefined && value !== null && typeof value !== 'object') {
        push('debtPolicy must be an object');
        break;
      }
      if (value && typeof value === 'object') {
        const lending = Array.isArray(value.lending) ? value.lending : [];
        for (let i = 0; i < lending.length; i++) {
          const item = lending[i];
          if (!item || typeof item !== 'object') {
            push(`debtPolicy.lending[${i}] must be an object`);
            continue;
          }
          if (!item.type || !['mpa', 'creditOffer'].includes(item.type)) {
            push(`debtPolicy.lending[${i}].type must be "mpa" or "creditOffer"`);
          }
          if (!item.collateralAsset || typeof item.collateralAsset !== 'string') {
            push(`debtPolicy.lending[${i}].collateralAsset must be a non-empty string`);
          }
          if (!item.asset || typeof item.asset !== 'string') {
            push(`debtPolicy.lending[${i}].asset must be a non-empty string`);
          }
        }
      }
      break;

    case 'botIndex':
    case 'botKey':
      push(`${field} is read-only`);
      break;

    default:
      break;
  }
}

/**
 * Validate a bot settings object against known keys, nested-key schemas, and bounds.
 * Returns collected errors and warnings without mutating the input.
 */
function validateBotSettingsState(bot: Record<string, any> = {}) {
  const errors: string[] = [];
  const warnings = [];
  // Legacy key aliases collapse before validation so a pre-rename entry is
  // neither rejected nor reported as an unrecognized key.
  bot = migrateLegacyOrderKeys({ ...bot });

  for (const field of Object.keys(BOT_SETTINGS_NESTED_KEYS)) {
    if (bot[field] !== undefined) {
      validateBotSettingsValue(field, bot[field], errors);
    }
  }

  for (const field of [
    ...BOT_SETTINGS_STATE_FIELDS.boolean,
    ...BOT_SETTINGS_STATE_FIELDS.numeric,
    ...BOT_SETTINGS_STATE_FIELDS.priceLike
  ].filter((field) => !(BOT_SETTINGS_NESTED_KEYS as any)[field])) {
    if (bot[field] !== undefined) {
      validateBotSettingsValue(field, bot[field], errors);
    }
  }

  for (const field of BOT_SETTINGS_STATE_FIELDS.string.filter((field) => !(BOT_SETTINGS_NESTED_KEYS as any)[field])) {
    if (bot[field] !== undefined) {
      validateBotSettingsValue(field, bot[field], errors);
    }
  }

  const increment = Number(bot.incrementPercent);
  const spread = Number(bot.targetSpreadPercent);
  if (Number.isFinite(increment) && Number.isFinite(spread)) {
    const minSpread = increment * GRID_LIMITS.MIN_SPREAD_FACTOR;
    if (spread + Number.EPSILON < minSpread) {
      errors.push(`targetSpreadPercent must be >= ${GRID_LIMITS.MIN_SPREAD_FACTOR}x incrementPercent (${minSpread.toFixed(6)})`);
    }
  }

  const resolvedStartPrice = resolveComparablePriceValue(bot.startPrice);
  const resolvedMinPrice = resolveComparablePriceValue(bot.minPrice, resolvedStartPrice, 'min');
  const resolvedMaxPrice = resolveComparablePriceValue(bot.maxPrice, resolvedStartPrice, 'max');
  if (resolvedMinPrice !== null && resolvedMaxPrice !== null) {
    if (resolvedMinPrice >= resolvedMaxPrice) {
      errors.push('minPrice must be less than maxPrice');
    }
  }

  if (resolvedStartPrice !== null) {
    if (resolvedMinPrice !== null && resolvedStartPrice < resolvedMinPrice) {
      errors.push('startPrice must be greater than or equal to minPrice');
    }
    if (resolvedMaxPrice !== null && resolvedStartPrice > resolvedMaxPrice) {
      errors.push('startPrice must be less than or equal to maxPrice');
    }
  }

  const unknownKeys = Object.keys(bot).filter((key) => !KNOWN_BOT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    warnings.push(`unrecognized keys: ${unknownKeys.join(', ')}`);
  }

  return {
    errors,
    warnings,
    valid: errors.length === 0
  };
}

/**
 * Validate a partial patch against a current bot's settings.
 * Returns validation result with merged settings, errors, warnings, and trigger-required flag.
 */
function validateBotSettingsPatch(patch: Record<string, any> = {}, currentBot: Record<string, any> = {}, options: Partial<ProfileOptions> = {}) {
  const errors: string[] = [];
  const warnings = [];
  const allowUnknownKeys = Boolean(options.allowUnknownKeys);

  if (!isPlainObject(patch)) {
    return {
      errors: ['patch must be a non-null object'],
      merged: cloneBotSettings(currentBot) || {},
      patchKeys: [],
      triggerRequired: false,
      valid: false,
      warnings: []
    };
  }

  patch = migrateLegacyOrderKeys({ ...patch });
  const patchKeys = Object.keys(patch);

  for (const key of patchKeys) {
    if (!KNOWN_BOT_KEYS.has(key)) {
      if (allowUnknownKeys) {
        warnings.push(`unrecognized patch key: ${key}`);
      } else {
        errors.push(`unrecognized patch key: ${key}`);
      }
      continue;
    }

    if (['weightDistribution', 'botFunds', 'coreOrders', 'edgeOrders'].includes(key) && isPlainObject(patch[key])) {
      validateNestedBotSettingKeys(key, patch[key], errors);
      const mergedField = {
        ...(isPlainObject(currentBot[key]) ? currentBot[key] : {}),
        ...patch[key]
      };
      validateBotSettingsValue(key, mergedField, errors);
      continue;
    }

    validateBotSettingsValue(key, patch[key], errors);
  }

  const merged = mergeBotSettingsPatch(currentBot, patch);
  const mergedValidation = validateBotSettingsState(normalizeBotSettings(merged));
  errors.push(...mergedValidation.errors.filter((entry) => !errors.includes(entry)));
  warnings.push(...mergedValidation.warnings);

  // Live-pickup keys (BOT_LIVE_CONFIG_KEYS, shared with the bot runtime) are
  // applied by the running bot within ~1min without restart or resync, so
  // they must not force a full grid-resync trigger on their own. A patch
  // touching only live keys writes no trigger; any non-live trigger key
  // keeps the previous behavior. Explicit options.trigger still overrides.
  const triggerRequired = patchKeys.some((key) => isResyncTriggerKey(key));

  return {
    errors,
    merged,
    patchKeys,
    triggerRequired,
    valid: errors.length === 0,
    warnings
  };
}

function buildBotSettingsView(bot: Record<string, any> | null, bundle: ClawProfileBundle | null, options: Record<string, any> = {}) {
  const current = cloneBotSettings(bot) || null;
  const effective = current ? normalizeBotSettings(current) : null;
  const currentValidation = current ? validateBotSettingsState(current) : { errors: [], warnings: [], valid: true };
  const effectiveValidation = effective ? validateBotSettingsState(effective) : { errors: [], warnings: [], valid: true };
  const mutability = describeBotSettingMutability();
  const b = bundle as any;
  const selectedBotFiles = current && bundle ? {
    gridPriceSnapshot: path.join(b.ordersDir || path.join(b.profilesDir, DEFAULT_ORDERS_DIR), `${current.botKey}.dynamicgrid.json`),
    orderSnapshot: path.join(b.ordersDir || path.join(b.profilesDir, DEFAULT_ORDERS_DIR), `${current.botKey}.json`),
    trigger: path.join(b.profilesDir, `recalculate.${current.botKey}.trigger`)
  } : null;

  return {
    current,
    defaults: cloneBotSettings(DEFAULT_CONFIG),
    effective,
    files: selectedBotFiles,
    identifier: options.identifier || null,
    mutability,
    rawValidation: currentValidation,
    validation: effectiveValidation
  };
}

/**
 * Extract raw bot entries from a bots.json settings object.
 * Handles both array format ({ bots: [...] }) and single-bot object format.
 */
function resolveRawBotEntries(settings: any) {
  if (!settings || typeof settings !== 'object') return [];
  if (Array.isArray(settings.bots)) return settings.bots;
  if (Object.keys(settings).length > 0) return [settings];
  return [];
}

/**
 * Validate a single bot entry for required keys and aliases.
 * Emits warnings via logger for missing required fields.
 */
function validateBotEntry(entry: any, index: any, logger: any) {
  const warnings = [];

  for (const [label, aliases] of Object.entries(REQUIRED_BOT_KEY_ALIASES)) {
    const hasAnyAlias = aliases.some((key) => {
      const value = entry[key];
      return value !== undefined && value !== null && value !== '';
    });
    if (!hasAnyAlias) {
      warnings.push(`bot[${index}]: missing required key '${label}'`);
    }
  }

  const unrecognizedKeys = [];
  for (const key of Object.keys(entry)) {
    if (!KNOWN_BOT_KEYS.has(key)) {
      unrecognizedKeys.push(key);
    }
  }

  if (logger && warnings.length > 0) {
    const warnFn = (typeof logger?.warn === 'function' ? logger.warn : typeof logger?.log === 'function' ? logger.log : console.warn);
    for (const warning of warnings) {
      warnFn.call(logger, `[dexbot-profiles] ${warning}`);
    }
  }
  if (logger && unrecognizedKeys.length > 0) {
    const debugFn = (typeof logger?.debug === 'function' ? logger.debug : typeof logger?.log === 'function' ? logger.log : console.debug);
    debugFn.call(logger, `[dexbot-profiles] bot[${index}]: unrecognized keys: ${unrecognizedKeys.join(', ')}`);
  }

  return warnings;
}

/**
 * Normalize an array of raw bot entries — clones, assigns keys and indices, applies defaults.
 */
async function normalizeBotEntries(rawEntries: Record<string, any>[], options: Partial<ProfileOptions> = {}) {
  const logger = options.logger || null;
  const results: any[] = [];
  for (const [index, entry] of rawEntries.entries()) {
    if (logger) {
      validateBotEntry(entry, index, logger);
    }
    // Shared seeder semantics with modules/bot_settings.normalizeBotEntry:
    // missing active → DEFAULT_CONFIG.active, present values pass through raw.
    results.push(normalizeBotEntry(entry, index));
  }
  return results;
}


function isFileLike(targetPath: any) {
  try {
    return storage.exists(targetPath) && storage.stat(targetPath).isFile();
  } catch {
    return false;
  }
}

function isDirectoryLike(targetPath: any) {
  try {
    return storage.exists(targetPath) && storage.stat(targetPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the profiles directory from a profile root path.
 * Checks root itself, root/profiles, and returns the first match.
 */
function resolveProfilesDir(profileRoot: any) {
  const candidates = [];
  const root = profileRoot ? path.resolve(profileRoot) : null;

  if (root) {
    candidates.push(root);
    candidates.push(path.join(root, 'profiles'));
    if (path.basename(root) === 'profiles') {
      candidates.push(path.dirname(root));
    }
  }

  if (Config.DEXBOT_PROFILE_ROOT) {
    const envRoot = path.resolve(Config.DEXBOT_PROFILE_ROOT);
    candidates.push(envRoot);
    candidates.push(path.join(envRoot, 'profiles'));
  }

  // No bare CWD/profiles candidate here: an existing home config is
  // authoritative (matching modules/paths.ts), and legacy cwd profiles are
  // handled by the central resolver's migration logic below.

  for (const candidate of candidates) {
    if (isFileLike(candidate)) {
      return path.dirname(candidate);
    }

    if (!isDirectoryLike(candidate)) {
      continue;
    }

    const manifestFile = path.join(candidate, DEFAULT_MANIFEST_FILE);
    const botsFile = path.join(candidate, DEFAULT_BOTS_FILE);
    const generalSettingsFile = path.join(candidate, DEFAULT_GENERAL_SETTINGS_FILE);
    const marketProfilesFile = path.join(candidate, DEFAULT_MARKET_PROFILES_FILE);

    if (
      storage.exists(manifestFile) ||
      storage.exists(botsFile) ||
      storage.exists(generalSettingsFile) ||
      storage.exists(marketProfilesFile)
    ) {
      return candidate;
    }
  }

  if (root && isDirectoryLike(root)) {
    return root;
  }

  // Fresh default: the central resolver (home for fresh/npm installs, with
  // legacy repo/cwd migration and DEXBOT_PROFILE_ROOT override). Do not fall
  // back to a bare CWD/profiles — that ignored a migrated home config.
  return PATHS.PROFILES_DIR;
}

function readJsonFile(filePath: any) {
  try {
    return storage.readJSON(filePath);
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read ${filePath}: ${getErrorMessage(error)}`);
  }
}

/**
 * Write JSON data atomically via file lock.
 * Acquires a lock on the target path, delegates to the shared atomic-write helper, then releases.
 */
async function writeJsonFileAtomic(filePath: any, data: any) {
  const release = await acquireFileLock(filePath);
  try {
    baseWriteJsonFileAtomic(filePath, data);
  } finally {
    await release();
  }
}

/**
 * Read a recalculate-trigger file and return its parsed payload.
 * Returns { exists, payload } — payload is null if empty or unparseable.
 */
function readTriggerFile(triggerPath: any) {
  try {
    const raw = storage.readFile(triggerPath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return { exists: true, payload: null };
    try {
      return { exists: true, payload: JSON.parse(trimmed) };
    } catch {
      return { exists: true, payload: trimmed };
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') return { exists: false, payload: null };
    throw err;
  }
}

function listFiles(dirPath: any) {
  try {
    return storage.readdir(dirPath).filter((name: string) => {
      const stat = storage.stat(path.join(dirPath, name));
      return stat.isFile();
    }).sort();
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Failed to list ${dirPath}: ${getErrorMessage(error)}`);
  }
}

/**
 * Match a bot entry against an identifier (string key, numeric index, or object ref).
 */
function matchBotIdentifier(bot: any, identifier: any) {
  if (!bot || identifier === null || identifier === undefined) {
    return false;
  }

  if (typeof identifier === 'object') {
    if (identifier.botKey && (bot.botKey === identifier.botKey || isSameBotName(bot.botKey, identifier.botKey))) {
      return true;
    }
    if (identifier.name && isSameBotName(bot.name, identifier.name)) {
      return true;
    }
    if (identifier.assetA && identifier.assetB && bot.assetA === identifier.assetA && bot.assetB === identifier.assetB) {
      return true;
    }
    if (identifier.assetAId && identifier.assetBId) {
      const botAId = bot.assetAId || null;
      const botBId = bot.assetBId || null;
      if (botAId === identifier.assetAId && botBId === identifier.assetBId) {
        return true;
      }
    }
    return false;
  }

  const value = String(identifier).trim();
  if (!value) {
    return false;
  }

  if (bot.botKey === value || isSameBotName(bot.botKey, value) || isSameBotName(bot.name, value)) {
    return true;
  }

  if (bot.assetA && bot.assetB && `${bot.assetA}/${bot.assetB}` === value) {
    return true;
  }

  if (bot.assetAId && bot.assetBId && `${bot.assetAId}/${bot.assetBId}` === value) {
    return true;
  }

  // Cross-match: identifier may use IDs while bot has symbols, or vice versa
  const [pairA, pairB] = value.includes('/') ? value.split('/', 2) : [null, null];
  if (pairA && pairB) {
    const botA = bot.assetA || bot.assetAId || null;
    const botB = bot.assetB || bot.assetBId || null;
    if (botA && botB && pairA === botA && pairB === botB) {
      return true;
    }
  }

  return sanitizeKey(bot.name) === sanitizeKey(value);
}

function findAmaProfile(bundle: any, bot: any) {
  const profiles = Array.isArray(bundle?.amaProfiles?.profiles) ? bundle.amaProfiles.profiles : [];
  if (profiles.length === 0 || !bot) {
    return null;
  }

  const botAssetA = bot.assetAId || bot.assetA || null;
  const botAssetB = bot.assetBId || bot.assetB || null;

  const match = profiles.find((profile: any) => {
    if (!profile || typeof profile !== 'object') {
      return false;
    }

    const profileAssetA = profile.assetAId || profile.assetA || null;
    const profileAssetB = profile.assetBId || profile.assetB || null;

    return profileAssetA === botAssetA && profileAssetB === botAssetB;
  });

  return match ? clone(match) : null;
}

/**
 * Build a profile context object for a specific bot from a loaded bundle.
 * Returns the current settings view, active state, and market context.
 */
function buildClawProfileContext(bundle: Record<string, any>, options: Partial<ProfileOptions> = {}) {
  if (!bundle || typeof bundle !== 'object') {
    return null;
  }

  const botIdentifier = options.botIdentifier || options.botRef || options.botKey || options.name || null;
  const selectedBot =
    options.selectedBot ||
    (botIdentifier ? bundle.bots.find((bot: any) => matchBotIdentifier(bot, botIdentifier)) : null) ||
    bundle.activeBots[0] ||
    bundle.bots[0] ||
    null;

  const selectedAmaProfile = findAmaProfile(bundle, selectedBot);
  const selectedOrderSnapshotPath = selectedBot ? path.join(bundle.ordersDir, `${selectedBot.botKey}.json`) : null;
  const selectedGridPriceSnapshotPath = selectedBot ? path.join(bundle.ordersDir, `${selectedBot.botKey}.dynamicgrid.json`) : null;
  const selectedTriggerPath = selectedBot ? path.join(bundle.profilesDir, `recalculate.${selectedBot.botKey}.trigger`) : null;
  const selectedOrderSnapshot = selectedBot
    ? clone(options.orderSnapshot !== undefined ? options.orderSnapshot : null)
    : null;
  const selectedGridPriceSnapshot = selectedBot
    ? clone(options.gridPriceSnapshot !== undefined ? options.gridPriceSnapshot : null)
    : null;

  return {
    profileRoot: bundle.profilesDir,
    runtime: {
      loadedAt: new Date().toISOString(),
      selectedBotRef: botIdentifier,
      sourceFiles: clone(bundle.files)
    },
    settings: {
      amaProfiles: clone(bundle.amaProfiles),
      bots: clone(bundle.bots),
      general: clone(bundle.generalSettings),
      manifest: clone(bundle.manifest)
    },
    selectedBot: selectedBot ? clone(selectedBot) : null,
    selectedBotFiles: selectedBot ? {
      gridPriceSnapshot: selectedGridPriceSnapshotPath,
      orderSnapshot: selectedOrderSnapshotPath,
      trigger: selectedTriggerPath
    } : null,
    selectedBotState: selectedBot ? {
      gridPriceSnapshot: selectedGridPriceSnapshot,
      orderSnapshot: selectedOrderSnapshot,
      selectedAmaProfile,
      triggerExists: selectedTriggerPath ? storage.exists(selectedTriggerPath) : false,
      triggerPayload: options.triggerPayload !== undefined ? options.triggerPayload : null
    } : null,
    summary: {
      activeBotCount: bundle.activeBots.length,
      amaProfileCount: Array.isArray(bundle.amaProfiles?.profiles) ? bundle.amaProfiles.profiles.length : 0,
      botCount: bundle.bots.length,
      hasAmaProfiles: Boolean(bundle.amaProfiles),
      hasGeneralSettings: Boolean(bundle.generalSettings),
      hasManifest: Boolean(bundle.manifest),
      orderFileCount: bundle.orderFiles.length
    }
  };
}

/**
 * Load the full DEXBot2 profile bundle from disk: bots.json, general.settings.json,
 * market_profiles.json, and order snapshots. Returns normalized parsings of each.
 */
async function loadDexbotProfileBundle(profileRoot: string | null, options: Partial<ProfileOptions> = {}) {
  const profilesDir = resolveProfilesDir(profileRoot || options.profileRoot);
  const ordersDir = path.join(profilesDir, DEFAULT_ORDERS_DIR);
  const manifestFile = options.manifestFile || path.join(profilesDir, DEFAULT_MANIFEST_FILE);
  const botsFile = options.botsFile || path.join(profilesDir, DEFAULT_BOTS_FILE);
  const generalSettingsFile = options.generalSettingsFile || path.join(profilesDir, DEFAULT_GENERAL_SETTINGS_FILE);
  const marketProfilesFile = options.marketProfilesFile || path.join(profilesDir, DEFAULT_MARKET_PROFILES_FILE);

  const [manifest, botsConfig, generalSettings, marketProfiles, orderFiles] = await Promise.all([
    readJsonFile(manifestFile),
    readJsonFile(botsFile),
    readJsonFile(generalSettingsFile),
    readJsonFile(marketProfilesFile),
    listFiles(ordersDir)
  ]);

  const bots = await normalizeBotEntries(resolveRawBotEntries(botsConfig), { logger: options.logger });
  const activeBots = bots.filter((bot) => bot.active !== false);
  const botsByKey = Object.fromEntries(bots.map((bot) => [bot.botKey, bot]));
  const botsByName = Object.fromEntries(bots.filter((bot) => bot.name).map((bot) => [bot.name, bot]));

  return {
    marketProfiles,
    amaProfiles: marketProfiles,
    activeBots,
    bots,
    botsByKey,
    botsByName,
    botsConfig,
    files: {
      marketProfiles: marketProfilesFile,
      amaProfiles: marketProfilesFile,
      bots: botsFile,
      generalSettings: generalSettingsFile,
      manifest: manifestFile,
      ordersDir
    },
    generalSettings,
    manifest,
    orderFiles,
    ordersDir,
    profilesDir
  };
}

/**
 * Create a locked profile adapter for reading, previewing, and applying bot settings.
 *
 * The adapter wraps bundle loading, settings validation, and atomic writes behind
 * per-file locks so concurrent updates do not clobber each other.
 *
 * @returns {Object} Adapter with loadBundle, getBotSettings,
 *   previewBotSettingsUpdate, applyBotSettingsPatch, updateBotSettings, getClawProfileContext
 */
function createDexbotProfileAdapter(profileRoot: string | null, options: Partial<ProfileOptions> = {}) {
  let cachedBundle: any = null;

  async function loadBundle(forceReload = false) {
    if (!cachedBundle || forceReload) {
      cachedBundle = await loadDexbotProfileBundle(profileRoot, options);
    }
    return cachedBundle;
  }

  function getProfilesDir() {
    return resolveProfilesDir(profileRoot || options.profileRoot);
  }

  async function getBotBundle(identifier: any, forceReload = false) {
    const bundle = await loadBundle(forceReload);
    const bot = bundle.bots.find((entry: any) => matchBotIdentifier(entry, identifier)) || null;
    if (!bot) {
      return null;
    }

    const orderSnapshotPath = path.join(bundle.ordersDir, `${bot.botKey}.json`);
    const gridPriceSnapshotPath = path.join(bundle.ordersDir, `${bot.botKey}.dynamicgrid.json`);
    const triggerPath = path.join(getProfilesDir(), `recalculate.${bot.botKey}.trigger`);

    const [orderSnapshot, gridPriceSnapshot, trigger] = await Promise.all([
      readJsonFile(orderSnapshotPath),
      readJsonFile(gridPriceSnapshotPath),
      readTriggerFile(triggerPath)
    ]);

    return {
      bot,
      files: {
        gridPriceSnapshot: gridPriceSnapshotPath,
        orderSnapshot: orderSnapshotPath,
        trigger: triggerPath
      },
      gridPriceSnapshot,
      orderSnapshot,
      triggerExists: trigger.exists,
      triggerPayload: trigger.payload
    };
  }

  async function getBotSettings(identifier: any, forceReload = false) {
    const bundle = await loadBundle(forceReload);
    const bot = identifier
      ? bundle.bots.find((entry: any) => matchBotIdentifier(entry, identifier)) || null
      : bundle.activeBots[0] || bundle.bots[0] || null;

    return buildBotSettingsView(bot, bundle, {
      identifier
    });
  }

  /**
   * Preview a bot settings patch without applying it.
   * Returns the current view, next view, validation errors/warnings, and whether a recalc trigger is required.
   */
  async function previewBotSettingsUpdate(identifier: any, patch: any, options: Record<string, any> = {}) {
    const bundle = await loadBundle(Boolean(options.forceReload));
    const bot = identifier
      ? bundle.bots.find((entry: any) => matchBotIdentifier(entry, identifier)) || null
      : bundle.activeBots[0] || bundle.bots[0] || null;
    if (!bot) {
      throw new Error(`Bot not found: ${identifier}`);
    }

    const validation = validateBotSettingsPatch(patch, bot, options);
    const nextBot = validation.merged;
    const currentValidation = validateBotSettingsState(bot);

    return {
      bot: cloneBotSettings(bot),
      changedKeys: validation.patchKeys,
      current: buildBotSettingsView(bot, bundle, { identifier }),
      errors: validation.errors,
      next: buildBotSettingsView(nextBot, bundle, { identifier }),
      patch: cloneBotSettings(patch) || {},
      triggerRequired: validation.triggerRequired,
      valid: validation.valid,
      warnings: [...currentValidation.warnings, ...validation.warnings]
    };
  }

  /**
   * Apply a bot settings patch atomically.
   * Acquires a file lock, validates the patch against current state, writes updated bots.json,
   * and writes the recalc trigger if the changed keys require one.
   */
  async function applyBotSettingsPatch(identifier: any, patch: any, options: Record<string, any> = {}) {
    if (!isPlainObject(patch)) {
      throw new Error('patch must be a non-null object');
    }

    const bundle = await loadBundle(true);
    const release = await acquireFileLock(bundle.files.bots);

    try {
      const currentBotsConfig = await readJsonFile(bundle.files.bots);
      const currentRawEntries = resolveRawBotEntries(currentBotsConfig);
      const currentBots = await normalizeBotEntries(currentRawEntries, { logger: options.logger });
      const bot = identifier
        ? currentBots.find((entry: any) => matchBotIdentifier(entry, identifier))
        : currentBots.find((entry: any) => entry.active !== false) || currentBots[0] || null;
      if (!bot) {
        throw new Error(`Bot not found: ${identifier}`);
      }

      if (!currentRawEntries[bot.botIndex]) {
        throw new Error(`Bot index ${bot.botIndex} out of range`);
      }

      const validation = validateBotSettingsPatch(patch, currentRawEntries[bot.botIndex], options);
      if (!validation.valid) {
        const error: any = new Error(`Bot settings validation failed:\n${validation.errors.map((entry) => `  - ${entry}`).join('\n')}`);
        error.validation = validation;
        throw error;
      }

      const nextEntry = validation.merged;
      const nextRawEntries = currentRawEntries.slice();
      nextRawEntries[bot.botIndex] = nextEntry;

      const dataToWrite = Array.isArray(currentBotsConfig)
        ? nextRawEntries
        : Array.isArray(currentBotsConfig?.bots)
          ? { ...currentBotsConfig, bots: nextRawEntries }
          : nextEntry;

      assertNoDuplicateBotKeys(nextRawEntries, 'applyBotSettingsPatch');

      await baseWriteJsonFileAtomic(bundle.files.bots, dataToWrite);

      let triggerPayload = null;
      let triggerPath = null;
      const shouldWriteTrigger = options.writeTrigger === true
        || options.trigger === true
        || (options.trigger === undefined && (
          options.triggerPayload !== undefined
          || validation.patchKeys.some((key) => isResyncTriggerKey(key))
        ));
      if (shouldWriteTrigger) {
        triggerPath = path.join(getProfilesDir(), `recalculate.${bot.botKey}.trigger`);
        // A settings patch that needs a recalc is an operator-initiated grid
        // rebuild: default to the same clean-slate source as `dexbot reset` so
        // the runtime drops the last-fill guards instead of anchoring the new
        // grid to the previous fill. Explicit caller intent wins: a custom
        // payload that already carries a `source` keeps it (any source other
        // than the clean-slate one is the normal-reset opt out), and
        // `triggerPayload: null` writes the legacy empty trigger.
        const customPayload = options.triggerPayload;
        if (customPayload === null) {
          triggerPayload = null;
        } else if (customPayload === undefined) {
          triggerPayload = {
            source: MANUAL_GRID_FULL_RESET_SOURCE,
            botKey: bot.botKey,
            changedKeys: validation.patchKeys,
            reason: options.triggerReason || 'settings_update',
            updatedAt: new Date().toISOString()
          };
        } else if (isPlainObject(customPayload)) {
          triggerPayload = {
            ...customPayload,
            source: customPayload.source ?? MANUAL_GRID_FULL_RESET_SOURCE,
          };
        } else {
          triggerPayload = customPayload;
        }
        storage.ensureDir(path.dirname(triggerPath));
        if (triggerPayload) {
          // Atomic tmp+rename: a running bot's trigger watcher must never parse
          // a half-written clean-slate payload as a legacy empty reset.
          storage.writeJSON(triggerPath, triggerPayload);
        } else {
          storage.writeFile(triggerPath, '', 'utf8');
        }
      }

      cachedBundle = null;
      const freshBundle = await loadBundle(true);
      const updatedBot = freshBundle.bots.find((entry: any) => entry.botIndex === bot.botIndex) || null;

      return {
        changedKeys: validation.patchKeys,
        current: buildBotSettingsView(bot, bundle, { identifier }),
        errors: [],
        next: buildBotSettingsView(updatedBot || nextEntry, freshBundle, { identifier }),
        patch: cloneBotSettings(patch) || {},
        reasoning: options.reasoning || [],
        triggerPath,
        triggerPayload,
        updatedBot: updatedBot ? cloneBotSettings(updatedBot) : cloneBotSettings(nextEntry),
        valid: true,
        warnings: validation.warnings
      };
    } finally {
      await release();
    }
  }


  async function getClawProfileContext(identifier: any, options: Record<string, any> = {}) {
    const bundle = await loadBundle(Boolean(options.forceReload));
    const bot = identifier ? bundle.bots.find((entry: any) => matchBotIdentifier(entry, identifier)) || null : null;
    const selectedBot = options.selectedBot || bot || bundle.activeBots[0] || bundle.bots[0] || null;
    const selectedBotBundle = selectedBot ? await getBotBundle(selectedBot.botKey, Boolean(options.forceReload)) : null;
    return buildClawProfileContext(bundle, {
      ...options,
      botIdentifier: identifier,
      gridPriceSnapshot: selectedBotBundle ? selectedBotBundle.gridPriceSnapshot : null,
      orderSnapshot: selectedBotBundle ? selectedBotBundle.orderSnapshot : null,
      selectedBot,
      triggerPayload: selectedBotBundle ? selectedBotBundle.triggerPayload : null
    });
  }

  async function updateBotSettings(identifier: any, patch: any) {
    if (!isPlainObject(patch)) {
      throw new Error('patch must be a non-null object');
    }

    const bundle = await loadBundle(true);
    const release = await acquireFileLock(bundle.files.bots);
    let selectedBotIndex = null;

    try {
      const currentBotsConfig = await readJsonFile(bundle.files.bots);
      const currentRawEntries = resolveRawBotEntries(currentBotsConfig);
      const currentBots = await normalizeBotEntries(currentRawEntries, { logger: options.logger });
      const bot = identifier
        ? currentBots.find((entry: any) => matchBotIdentifier(entry, identifier))
        : currentBots.find((entry: any) => entry.active !== false) || currentBots[0] || null;
      if (!bot) {
        throw new Error(`Bot not found: ${identifier}`);
      }

      if (!currentRawEntries[bot.botIndex]) {
        throw new Error(`Bot index ${bot.botIndex} out of range`);
      }
      selectedBotIndex = bot.botIndex;

      const validation = validateBotSettingsPatch(patch, currentRawEntries[bot.botIndex], {});
      if (!validation.valid) {
        const error: any = new Error(`Bot settings validation failed:\n${validation.errors.map((entry) => `  - ${entry}`).join('\n')}`);
        error.validation = validation;
        throw error;
      }

      const nextEntry = validation.merged;
      const nextRawEntries = currentRawEntries.slice();
      nextRawEntries[bot.botIndex] = nextEntry;

      const dataToWrite = Array.isArray(currentBotsConfig)
        ? nextRawEntries
        : Array.isArray(currentBotsConfig?.bots)
          ? { ...currentBotsConfig, bots: nextRawEntries }
          : nextEntry;

      assertNoDuplicateBotKeys(nextRawEntries, 'updateBotSettings');

      await baseWriteJsonFileAtomic(bundle.files.bots, dataToWrite);
    } finally {
      await release();
    }

    cachedBundle = null;
    const freshBundle = await loadBundle(true);
    return freshBundle.bots.find((entry: any) => entry.botIndex === selectedBotIndex) || null;
  }

  return {
    applyBotSettingsPatch,
    getBotSettings,
    getClawProfileContext,
    loadBundle,
    previewBotSettingsUpdate,
    updateBotSettings
  };
}

export { createBotKey, createDexbotProfileAdapter, matchBotIdentifier, normalizeBotEntries, resolveProfilesDir, resolveRawBotEntries, validateBotEntry, writeJsonFileAtomic }


'use strict';

import { PATHS } from './paths.js';
import { Config } from './config.js';
import { getStorage } from './storage/index.js';
import { getErrorMessage } from './utils/errors.js';

const storage = getStorage();
const { readJSON } = storage;

// Resolved per read (not at module load) so test overrides via the
// DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE config value take effect on
// modules that are already loaded.
function whitelistFile(): string {
    return Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE || PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();
}

interface WhitelistFlags {
    ama: boolean;
    dynamicWeight: boolean;
    asymmetricBounds: boolean;
}

let _whitelistCache: Map<string, WhitelistFlags> | false | null = null;

function resetMarketAdapterWhitelistCache(): void {
    _whitelistCache = null;
}

function normalizeEntry(entry: any): WhitelistFlags {
    if (entry === true) {
        return { ama: true, dynamicWeight: true, asymmetricBounds: true };
    }
    if (!entry || typeof entry !== 'object') {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return {
        ama: entry.ama === true,
        dynamicWeight: entry.dynamicWeight === true,
        asymmetricBounds: entry.asymmetricBounds === true,
    };
}

function loadMarketAdapterWhitelist(): Map<string, WhitelistFlags> | false {
    if (_whitelistCache !== null) return _whitelistCache;
    if (!storage.exists(whitelistFile())) {
        _whitelistCache = false;
        return _whitelistCache;
    }

    try {
        const json = readJSON(whitelistFile());
        const raw = json?.whitelist;
        const map = new Map<string, WhitelistFlags>();

        if (Array.isArray(raw)) {
            for (const botKey of raw) {
                map.set(String(botKey), { ama: true, dynamicWeight: false, asymmetricBounds: false });
            }
        } else if (raw && typeof raw === 'object') {
            for (const [botKey, entry] of Object.entries(raw)) {
                map.set(String(botKey), normalizeEntry(entry));
            }
        }

        _whitelistCache = map;
        return _whitelistCache;
    } catch (_: any) {
        console.warn(`[WARN] Failed to parse ${whitelistFile()}: ${getErrorMessage(_)}. All whitelist features disabled.`);
        _whitelistCache = false;
        return _whitelistCache;
    }
}

function getWhitelistFlags(botKey: string): WhitelistFlags {
    const whitelist = loadMarketAdapterWhitelist();
    if (whitelist === false || !botKey) {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return whitelist.get(String(botKey)) || { ama: false, dynamicWeight: false, asymmetricBounds: false };
}

function isBotWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).ama === true;
}

function isBotDynamicWeightWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).dynamicWeight === true;
}

function isBotAsymmetricBoundsWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).asymmetricBounds === true;
}

export { whitelistFile, resetMarketAdapterWhitelistCache, getWhitelistFlags, isBotWhitelisted, isBotDynamicWeightWhitelisted, isBotAsymmetricBoundsWhitelisted }


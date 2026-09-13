
import fs from 'node:fs';
import { loadSettingsFile, resolveRawBotEntries, normalizeBotEntries } from '../modules/bot_settings.js';
import { PATHS } from '../modules/paths.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../modules/utils/errors.js';
import { pathToFileURL } from 'node:url';
'use strict';


const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const WHITELIST_FILE = PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();

function loadNormalizedBots() {
    const { config } = loadSettingsFile(BOTS_FILE);
    const raw = resolveRawBotEntries(config);
    const normalized = normalizeBotEntries(raw);
    return normalized;
}

function isAmaGridPrice(value: any) {
    if (typeof value !== 'string') return false;
    return /^ama(?:[1-4])?$/i.test(value.trim());
}

function parseOptions(argv: string[]) {
    const dynamicWeightEnabled = argv.includes('--dynamic-weight=true') || argv.includes('--dynamic-weight') || argv.includes('--with-dynamic-weight');
    const dynamicWeightDisabled = argv.includes('--dynamic-weight=false') || argv.includes('--no-dynamic-weight');
    const asymmetricBoundsEnabled = argv.includes('--asymmetric-bounds=true') || argv.includes('--asymmetric-bounds') || argv.includes('--with-asymmetric-bounds');
    const asymmetricBoundsDisabled = argv.includes('--asymmetric-bounds=false') || argv.includes('--no-asymmetric-bounds');
    const pruneEnabled = argv.includes('--prune');

    const botKeys: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        let raw: string | null = null;
        let isBotFlag = false;
        if (arg === '--bot' || arg === '--bot-key' || arg === '--botKey') {
            isBotFlag = true;
            const next = argv[i + 1] ?? null;
            if (next && !next.startsWith('--')) {
                raw = next;
                i++;
            } else {
                throw new Error(`--bot requires a value: got '${next ?? ''}' (usage: --bot <botKey> or --bot=a,b)`);
            }
        } else if (arg.startsWith('--bot=')) {
            isBotFlag = true;
            raw = arg.slice('--bot='.length);
            if (!raw.trim()) throw new Error(`--bot requires a value: got '${arg}' (usage: --bot=<botKey>)`);
        } else if (arg.startsWith('--bot-key=')) {
            isBotFlag = true;
            raw = arg.slice('--bot-key='.length);
            if (!raw.trim()) throw new Error(`--bot-key requires a value: got '${arg}'`);
        } else if (arg.startsWith('--botKey=')) {
            isBotFlag = true;
            raw = arg.slice('--botKey='.length);
            if (!raw.trim()) throw new Error(`--botKey requires a value: got '${arg}'`);
        }
        if (isBotFlag && raw !== null) {
            const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
            if (parts.length === 0) throw new Error(`--bot requires a non-empty botKey (got '${raw}')`);
            // validate each key does not look like a flag
            for (const p of parts) {
                if (p.startsWith('--')) throw new Error(`--bot value looks like a flag: '${p}' (missing value for --bot?)`);
            }
            botKeys.push(...parts);
        }
    }

    return {
        dynamicWeight: dynamicWeightEnabled && !dynamicWeightDisabled,
        asymmetricBounds: asymmetricBoundsEnabled && !asymmetricBoundsDisabled,
        prune: pruneEnabled,
        botKeys,
    };
}

function loadExistingWhitelist() {
    if (!fs.existsSync(WHITELIST_FILE)) return {};

    let json;
    try {
        json = readJSON(WHITELIST_FILE);
    } catch (err: any) {
        process.stderr.write(`Warning: ignoring malformed ${WHITELIST_FILE}: ${getErrorMessage(err)}\n`);
        return {};
    }
    const raw = json?.whitelist;
    const entries: any = {};

    if (Array.isArray(raw)) {
        for (const botKey of raw) {
            if (botKey) entries[String(botKey)] = { ama: true, dynamicWeight: false, asymmetricBounds: false };
        }
    } else if (raw && typeof raw === 'object') {
        for (const [botKey, entry] of Object.entries(raw)) {
            entries[String(botKey)] = entry;
        }
    }

    return entries;
}

function buildWhitelist(bots: any, existingWhitelist: any = {}, options: ReturnType<typeof parseOptions> = parseOptions(process.argv)) {
    const entries = new Map<string, any>();

    for (const [botKey, entry] of Object.entries(existingWhitelist || {})) {
        entries.set(String(botKey), entry);
    }

    if (options.prune) {
        const configuredKeys = new Set<string>();
        for (const bot of bots) {
            const botKey = bot.botKey;
            if (botKey) configuredKeys.add(String(botKey));
        }
        for (const key of entries.keys()) {
            if (!configuredKeys.has(key)) {
                process.stderr.write(`prune: removed stale whitelist entry '${key}'\n`);
                entries.delete(key);
            }
        }
    }

    for (const bot of bots) {
        const botKey = bot.botKey;
        if (!botKey || !isAmaGridPrice(bot?.gridPrice)) continue;
        const key = String(botKey);
        const botKeys = options.botKeys ?? [];
        const isTargeted = botKeys.length > 0 && botKeys.includes(key);
        const isFilteredOut = botKeys.length > 0 && !isTargeted;
        if (isFilteredOut) continue;
        if (!entries.has(key)) {
            entries.set(key, {
                ama: true,
                dynamicWeight: options.dynamicWeight,
                asymmetricBounds: options.asymmetricBounds,
            });
        } else if (isTargeted) {
            // --bot implies overwrite for that key only
            const existing = entries.get(key) ?? {};
            entries.set(key, {
                ...existing,
                ama: true,
                dynamicWeight: options.dynamicWeight,
                asymmetricBounds: options.asymmetricBounds,
            });
        }
    }

    if (options.botKeys && options.botKeys.length > 0) {
        const configuredKeys = new Set(bots.map((b: any) => b?.botKey).filter(Boolean).map(String));
        for (const target of options.botKeys) {
            if (!configuredKeys.has(String(target))) {
                process.stderr.write(`Warning: --bot target '${target}' not found in ${BOTS_FILE} (no AMA bot matched; file written unchanged for that key)\n`);
            } else if (!bots.some((b: any) => String(b?.botKey) === String(target) && isAmaGridPrice(b?.gridPrice))) {
                process.stderr.write(`Warning: --bot target '${target}' has non-AMA gridPrice (whitelist unchanged for that key)\n`);
            }
        }
    }

    return {
        whitelist: Object.fromEntries([...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    };
}

function main() {
    let options: ReturnType<typeof parseOptions>;
    try {
        options = parseOptions(process.argv);
    } catch (err: any) {
        process.stderr.write(`whitelist: ${getErrorMessage(err)}\n`);
        process.stderr.write(`Usage: dexbot white [--dynamic-weight|--no-dynamic-weight] [--asymmetric-bounds|--no-asymmetric-bounds] [--prune] [--bot <botKey>]\n`);
        process.exit(1);
    }
    const bots = loadNormalizedBots();
    const existingWhitelist = loadExistingWhitelist();
    const whitelist = buildWhitelist(bots, existingWhitelist, options);
    const output = JSON.stringify(whitelist, null, 2) + '\n';

    fs.writeFileSync(WHITELIST_FILE, output, 'utf8');
    const botCount = Object.keys(whitelist.whitelist).length;
    process.stdout.write(`Wrote ${WHITELIST_FILE} with ${botCount} ${botCount === 1 ? 'bot' : 'bots'}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}

export { isAmaGridPrice, parseOptions, loadExistingWhitelist, buildWhitelist }


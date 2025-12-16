// Interactive CLI helper for editing the tracked bot profiles stored in profiles/bots.json.
const fs = require('fs');
const path = require('path');
const readlineSync = require('readline-sync');
const readline = require('readline');
const { execSync } = require('child_process');
const { DEFAULT_CONFIG } = require('./constants');

function parseJsonWithComments(raw) {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped);
}

const BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');


function ensureProfilesDirectory() {
    const dir = path.dirname(BOTS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function loadBotsConfig() {
    if (!fs.existsSync(BOTS_FILE)) {
        return { config: { bots: [] }, filePath: BOTS_FILE };
    }
    try {
        const content = fs.readFileSync(BOTS_FILE, 'utf8');
        if (!content || !content.trim()) return { config: { bots: [] }, filePath: BOTS_FILE };
        const parsed = parseJsonWithComments(content);
        if (!Array.isArray(parsed.bots)) parsed.bots = [];
        return { config: parsed, filePath: BOTS_FILE };
    } catch (err) {
        console.error('Failed to load bots configuration:', err.message);
        return { config: { bots: [] }, filePath: BOTS_FILE };
    }
}

function saveBotsConfig(config, filePath) {
    try {
            ensureProfilesDirectory();
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Failed to save bots configuration:', err.message);
        throw err;
    }
}

function listBots(bots) {
    if (!bots.length) {
        console.log('  (no bot entries defined yet)');
        return;
    }
    bots.forEach((bot, index) => {
        const name = bot.name || `<unnamed-${index + 1}>`;
        const inactiveSuffix = bot.active === false ? ' [inactive]' : '';
        const dryRunSuffix = bot.dryRun ? ' (dryRun)' : '';
        console.log(`  ${index + 1}: ${name}${inactiveSuffix}${dryRunSuffix} ${bot.assetA || '?'} / ${bot.assetB || '?'}`);
    });
}

function selectBotIndex(bots, promptMessage) {
    if (!bots.length) return null;
    listBots(bots);
    const raw = readlineSync.question(`${promptMessage} [1-${bots.length}]: `).trim();
    const idx = Number(raw);
    if (Number.isNaN(idx) || idx < 1 || idx > bots.length) {
        console.log('Invalid selection.');
        return null;
    }
    return idx - 1;
}

function askString(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const answer = readlineSync.question(`${promptText}${suffix}: `);
    if (!answer) return defaultValue;
    return answer.trim();
}

function askRequiredString(promptText, defaultValue) {
    while (true) {
        const value = askString(promptText, defaultValue);
        if (value && value.trim()) return value.trim();
        console.log('This field is required.');
    }
}

async function askAsset(promptText, defaultValue) {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        // Use readlineSync with mask to capture and display as uppercase
        const answer = readlineSync.question(`${promptText}${suffix}: `, {
            hideEchoBack: false
        }).trim();

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        return answer.toUpperCase();
    }
}

function askNumber(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumber(promptText, defaultValue);
    }
    return parsed;
}

function askWeightDistribution(promptText, defaultValue) {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    console.log('\x1b[33m  -1=SuperValley ←→ 0=Valley ←→ 0.5=Neutral ←→ 1=Mountain ←→ 2=SuperMountain\x1b[0m');
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
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

function askWeightDistributionNoLegend(promptText, defaultValue) {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
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

function isMultiplierString(value) {
    return typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value);
}

function askNumberOrMultiplier(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) return raw.trim();
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    return parsed;
}

function normalizePercentageInput(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.endsWith('%')) return null;
    const numeric = Number(trimmed.slice(0, -1).trim());
    if (Number.isNaN(numeric)) return null;
    return `${numeric}%`;
}

function askNumberOrPercentage(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
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

function askBoolean(promptText, defaultValue) {
    const label = defaultValue ? 'Y/n' : 'y/N';
    const raw = readlineSync.question(`${promptText} (${label}): `).trim().toLowerCase();
    if (!raw) return !!defaultValue;
    return raw.startsWith('y');
}

function askMarketPrice(promptText, defaultValue) {
    while (true) {
        const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
        const raw = readlineSync.question(`${promptText}${suffix}: `).trim();

        if (!raw) {
            if (defaultValue !== undefined && defaultValue !== null) {
                return defaultValue;
            }
            return undefined;
        }

        const lower = raw.toLowerCase();
        // Accept 'pool' or 'market' strings
        if (lower === 'pool' || lower === 'market') {
            return lower;
        }

        // Accept numeric values (including decimals)
        const num = Number(raw);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
            return num;
        }

        console.log('Please enter "pool", "market", or a numeric value.');
    }
}

async function promptBotData(base = {}) {
    const name = askRequiredString('Bot name', base.name);
    const assetA = await askAsset('Asset A for selling', base.assetA);
    const assetB = await askAsset('Asset B for buying', base.assetB);
    const active = askBoolean('Active', base.active !== undefined ? base.active : DEFAULT_CONFIG.active);
    const dryRun = askBoolean('Dry run', base.dryRun !== undefined ? base.dryRun : DEFAULT_CONFIG.dryRun);
    const preferredAccount = askRequiredString('Preferred account', base.preferredAccount);
    const marketPrice = askMarketPrice('marketPrice (pool, market or A/B)', base.marketPrice || 'pool');
    const minPrice = askNumberOrMultiplier('minPrice', base.minPrice !== undefined ? base.minPrice : DEFAULT_CONFIG.minPrice);
    const maxPrice = askNumberOrMultiplier('maxPrice', base.maxPrice !== undefined ? base.maxPrice : DEFAULT_CONFIG.maxPrice);
    const incrementPercent = askNumber('incrementPercent', base.incrementPercent !== undefined ? base.incrementPercent : DEFAULT_CONFIG.incrementPercent);
    const targetSpreadPercent = askNumber('targetSpreadPercent', base.targetSpreadPercent !== undefined ? base.targetSpreadPercent : DEFAULT_CONFIG.targetSpreadPercent);
    const weightSell = askWeightDistribution('Weight distribution (sell)', base.weightDistribution && base.weightDistribution.sell !== undefined ? base.weightDistribution.sell : DEFAULT_CONFIG.weightDistribution.sell);
    const weightBuy = askWeightDistributionNoLegend('Weight distribution (buy)', base.weightDistribution && base.weightDistribution.buy !== undefined ? base.weightDistribution.buy : DEFAULT_CONFIG.weightDistribution.buy);
    // Prompt sell first, then buy to make the config output match the desired ordering
    const fundsSell = askNumberOrPercentage('botFunds sell amount', base.botFunds && base.botFunds.sell !== undefined ? base.botFunds.sell : DEFAULT_CONFIG.botFunds.sell);
    const fundsBuy = askNumberOrPercentage('botFunds buy amount', base.botFunds && base.botFunds.buy !== undefined ? base.botFunds.buy : DEFAULT_CONFIG.botFunds.buy);
    const ordersSell = askNumber('activeOrders sell count', base.activeOrders && base.activeOrders.sell !== undefined ? base.activeOrders.sell : DEFAULT_CONFIG.activeOrders.sell);
    const ordersBuy = askNumber('activeOrders buy count', base.activeOrders && base.activeOrders.buy !== undefined ? base.activeOrders.buy : DEFAULT_CONFIG.activeOrders.buy);
    return {
        name,
        active,
        dryRun,
        preferredAccount: preferredAccount || undefined,
        assetA,
        assetB,
        marketPrice: marketPrice || undefined,
        minPrice,
        maxPrice,
        incrementPercent,
        targetSpreadPercent,
        weightDistribution: { sell: weightSell, buy: weightBuy },
        // Output sell first then buy for both botFunds and activeOrders
        botFunds: { sell: fundsSell, buy: fundsBuy },
        activeOrders: { sell: ordersSell, buy: ordersBuy },
        
    };
}

// Entry point exposing a menu-driven interface for creating, modifying, and reviewing bots.
async function main() {
    console.log('dexbot bots — bots.json configurator (writes profiles/bots.json)');
    const { config, filePath } = loadBotsConfig();
    let exit = false;
    while (!exit) {
        console.log('\nActions:');
        console.log('  1) New bot');
        console.log('  2) Modify bot');
        console.log('  3) Delete bot');
        console.log('  4) Copy bot');
        console.log('  5) List bots');
        console.log('  6) Exit');
        const selection = readlineSync.question('Choose an action [1-6]: ').trim();
        console.log('');
        switch (selection) {
            case '1': {
                const entry = await promptBotData();
                config.bots.push(entry);
                saveBotsConfig(config, filePath);
                console.log(`Added bot '${entry.name}' to ${path.basename(filePath)}.`);
                break;
            }
            case '2': {
                const idx = selectBotIndex(config.bots, 'Select bot to modify');
                if (idx === null) break;
                const entry = await promptBotData(config.bots[idx]);
                config.bots[idx] = entry;
                saveBotsConfig(config, filePath);
                console.log(`Updated bot '${entry.name}' in ${path.basename(filePath)}.`);
                break;
            }
            case '3': {
                const idx = selectBotIndex(config.bots, 'Select bot to delete');
                if (idx === null) break;
                const placeholderName = config.bots[idx].name || `<unnamed-${idx + 1}>`;
                const confirm = askBoolean(`Delete '${placeholderName}'?`, false);
                if (confirm) {
                    const removed = config.bots.splice(idx, 1)[0];
                    saveBotsConfig(config, filePath);
                    console.log(`Removed bot '${removed.name || placeholderName}' from ${path.basename(filePath)}.`);
                } else {
                    console.log('Deletion cancelled.');
                }
                break;
            }
            case '4': {
                const idx = selectBotIndex(config.bots, 'Select bot to copy');
                if (idx === null) break;
                const entry = await promptBotData(config.bots[idx]);
                config.bots.splice(idx + 1, 0, entry);
                saveBotsConfig(config, filePath);
                console.log(`Copied bot '${entry.name}' into ${path.basename(filePath)}.`);
                break;
            }
            case '5':
                listBots(config.bots);
                break;
            case '6':
                exit = true;
                break;
            default:
                console.log('Unknown selection.');
        }
    }
    console.log('Botmanager closed!');
}

module.exports = { main, parseJsonWithComments };

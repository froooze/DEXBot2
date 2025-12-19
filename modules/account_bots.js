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

async function askAssetB(promptText, defaultValue, assetA) {
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

        const assetB = answer.toUpperCase();

        // Validate that Asset B is different from Asset A
        if (assetB === assetA) {
            console.log(`Invalid: Asset B cannot be the same as Asset A (${assetA})`);
            continue;
        }

        return assetB;
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
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
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

function askNumberWithBounds(promptText, defaultValue, minVal, maxVal) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
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

function askTargetSpreadPercent(promptText, defaultValue, incrementPercent) {
    const minRequired = incrementPercent * 2;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue.toFixed(2)}]` : '';
    const raw = readlineSync.question(`${promptText} (>= ${minRequired.toFixed(2)})${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    // Validate >= 2x incrementPercent
    if (parsed < minRequired) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= 2x incrementPercent (${minRequired.toFixed(2)})`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    // Validate no negative
    if (parsed < 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Cannot be negative`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    return parsed;
}

function askIntegerInRange(promptText, defaultValue, minVal, maxVal) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
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

function askNumberOrMultiplier(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
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

function askMaxPrice(promptText, defaultValue, minPrice) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
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
    // Validate that maxPrice > minPrice
    const minPriceValue = typeof minPrice === 'string' ? parseFloat(minPrice) : minPrice;
    if (parsed <= minPriceValue) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > minPrice (${minPriceValue})`);
        return askMaxPrice(promptText, defaultValue, minPrice);
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
    // === Bot Configuration ===
    const name = askRequiredString('Bot name', base.name);
    const active = askBoolean('Active', base.active !== undefined ? base.active : DEFAULT_CONFIG.active);
    const dryRun = askBoolean('Dry run', base.dryRun !== undefined ? base.dryRun : DEFAULT_CONFIG.dryRun);
    const preferredAccount = askRequiredString('Preferred account', base.preferredAccount);

    console.log('');
    // === Trading Pair ===
    const assetA = await askAsset('Asset A for selling', base.assetA);
    const assetB = await askAssetB('Asset B for buying', base.assetB, assetA);

    console.log('');
    // === Price Range ===
    const marketPrice = askMarketPrice('marketPrice (pool, market or A/B)', base.marketPrice || 'pool');
    const minPrice = askNumberOrMultiplier('minPrice', base.minPrice !== undefined ? base.minPrice : DEFAULT_CONFIG.minPrice);
    // maxPrice must be > minPrice
    const maxPrice = askMaxPrice('maxPrice', base.maxPrice !== undefined ? base.maxPrice : DEFAULT_CONFIG.maxPrice, minPrice);

    console.log('');
    // === Grid Configuration ===
    // incrementPercent must be between 0.01 and 10 (prevents grid calculation errors)
    const incrementPercent = askNumberWithBounds('incrementPercent', base.incrementPercent !== undefined ? base.incrementPercent : DEFAULT_CONFIG.incrementPercent, 0.01, 10);
    // targetSpreadPercent must be >= 2x incrementPercent (default is 3x)
    const defaultSpread = base.targetSpreadPercent !== undefined ? base.targetSpreadPercent : incrementPercent * 4;
    const targetSpreadPercent = askTargetSpreadPercent('targetSpread %', defaultSpread, incrementPercent);
    const weightSell = askWeightDistribution('Weight distribution (sell)', base.weightDistribution && base.weightDistribution.sell !== undefined ? base.weightDistribution.sell : DEFAULT_CONFIG.weightDistribution.sell);
    const weightBuy = askWeightDistributionNoLegend('Weight distribution (buy)', base.weightDistribution && base.weightDistribution.buy !== undefined ? base.weightDistribution.buy : DEFAULT_CONFIG.weightDistribution.buy);

    console.log('');
    // === Funding & Orders ===
    // Prompt sell first, then buy to make the config output match the desired ordering
    const fundsSell = askNumberOrPercentage('botFunds sell amount', base.botFunds && base.botFunds.sell !== undefined ? base.botFunds.sell : DEFAULT_CONFIG.botFunds.sell);
    const fundsBuy = askNumberOrPercentage('botFunds buy amount', base.botFunds && base.botFunds.buy !== undefined ? base.botFunds.buy : DEFAULT_CONFIG.botFunds.buy);
    // activeOrders must be integers 1-50
    const ordersSell = askIntegerInRange('activeOrders sell count', base.activeOrders && base.activeOrders.sell !== undefined ? base.activeOrders.sell : DEFAULT_CONFIG.activeOrders.sell, 1, 50);
    const ordersBuy = askIntegerInRange('activeOrders buy count', base.activeOrders && base.activeOrders.buy !== undefined ? base.activeOrders.buy : DEFAULT_CONFIG.activeOrders.buy, 1, 50);

    // ===== COMPREHENSIVE INPUT VALIDATION =====

    // 1. Validate marketPrice (must be > 0)
    if (typeof marketPrice === 'number') {
        if (marketPrice <= 0) {
            throw new Error(`Invalid marketPrice: ${marketPrice}. Must be > 0 (positive number, not 'pool' or 'market')`);
        }
    }

    // 2. Validate minPrice and maxPrice
    // (Already validated in askNumberOrMultiplier() - no need to re-validate)
    if (typeof minPrice !== 'string' && typeof minPrice !== 'number') {
        throw new Error(`Invalid minPrice: ${minPrice}. Must be a number or "Nx" multiplier (e.g., "4x")`);
    }
    if (typeof maxPrice !== 'string' && typeof maxPrice !== 'number') {
        throw new Error(`Invalid maxPrice: ${maxPrice}. Must be a number or "Nx" multiplier (e.g., "4x")`);
    }

    // 3. Validate botFunds (must be > 0, <= 100%, any number format accepted)
    const validateBotFunds = (funds, side) => {
        let numValue;
        if (typeof funds === 'string') {
            // Percentage format "N%"
            if (funds.includes('%')) {
                numValue = parseFloat(funds);
                if (!Number.isFinite(numValue) || numValue <= 0 || numValue > 100) {
                    throw new Error(`Invalid botFunds ${side}: "${funds}". Percentage must be > 0% and <= 100%`);
                }
            } else {
                // Should not happen with askNumberOrPercentage, but defensive
                numValue = parseFloat(funds);
                if (!Number.isFinite(numValue) || numValue <= 0) {
                    throw new Error(`Invalid botFunds ${side}: ${funds}. Must be > 0 (number or percentage)`);
                }
            }
        } else if (typeof funds === 'number') {
            if (!Number.isFinite(funds) || funds <= 0) {
                throw new Error(`Invalid botFunds ${side}: ${funds}. Must be > 0 (positive number)`);
            }
        }
    };
    validateBotFunds(fundsSell, 'sell');
    validateBotFunds(fundsBuy, 'buy');

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
                try {
                    const entry = await promptBotData();
                    config.bots.push(entry);
                    saveBotsConfig(config, filePath);
                    console.log(`\nAdded bot '${entry.name}' to ${path.basename(filePath)}.`);
                } catch (err) {
                    console.log(`\n❌ Invalid input: ${err.message}\n`);
                }
                break;
            }
            case '2': {
                const idx = selectBotIndex(config.bots, 'Select bot to modify');
                if (idx === null) break;
                try {
                    const entry = await promptBotData(config.bots[idx]);
                    config.bots[idx] = entry;
                    saveBotsConfig(config, filePath);
                    console.log(`\nUpdated bot '${entry.name}' in ${path.basename(filePath)}.`);
                } catch (err) {
                    console.log(`\n❌ Invalid input: ${err.message}\n`);
                }
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
                    console.log(`\nRemoved bot '${removed.name || placeholderName}' from ${path.basename(filePath)}.`);
                } else {
                    console.log('\nDeletion cancelled.');
                }
                break;
            }
            case '4': {
                const idx = selectBotIndex(config.bots, 'Select bot to copy');
                if (idx === null) break;
                try {
                    const entry = await promptBotData(config.bots[idx]);
                    config.bots.splice(idx + 1, 0, entry);
                    saveBotsConfig(config, filePath);
                    console.log(`\nCopied bot '${entry.name}' into ${path.basename(filePath)}.`);
                } catch (err) {
                    console.log(`\n❌ Invalid input: ${err.message}\n`);
                }
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

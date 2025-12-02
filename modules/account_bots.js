const fs = require('fs');
const path = require('path');
const readline = require('readline-sync');
const { DEFAULT_CONFIG } = require('./order/constants');

const BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');

function parseJsonWithComments(raw) {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped);
}

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
        const name = bot.name || `<unnamed-${index}>`;
        const inactiveSuffix = bot.active === false ? ' [inactive]' : '';
        const dryRunSuffix = bot.dryRun ? ' (dryRun)' : '';
        console.log(`  ${index}: ${name}${inactiveSuffix}${dryRunSuffix} ${bot.assetA || '?'} / ${bot.assetB || '?'}`);
    });
}

function selectBotIndex(bots, promptMessage) {
    if (!bots.length) return null;
    listBots(bots);
    const raw = readline.question(`${promptMessage} [0-${bots.length - 1}]: `).trim();
    const idx = Number(raw);
    if (Number.isNaN(idx) || idx < 0 || idx >= bots.length) {
        console.log('Invalid selection.');
        return null;
    }
    return idx;
}

function askString(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const answer = readline.question(`${promptText}${suffix}: `);
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

function askNumber(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readline.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumber(promptText, defaultValue);
    }
    return parsed;
}

function isMultiplierString(value) {
    return typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value);
}

function askNumberOrMultiplier(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readline.question(`${promptText}${suffix}: `).trim();
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
    const raw = readline.question(`${promptText}${suffix}: `).trim();
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
    const raw = readline.question(`${promptText} (${label}): `).trim().toLowerCase();
    if (!raw) return !!defaultValue;
    return raw.startsWith('y');
}

function promptBotData(base = {}) {
    const name = askRequiredString('Bot name', base.name);
    const assetA = askRequiredString('Asset A', base.assetA);
    const assetB = askRequiredString('Asset B', base.assetB);
    const active = askBoolean('Active', base.active !== undefined ? base.active : DEFAULT_CONFIG.active);
    const dryRun = askBoolean('Dry run', base.dryRun !== undefined ? base.dryRun : DEFAULT_CONFIG.dryRun);
    const preferredAccount = askRequiredString('Preferred account', base.preferredAccount);
    const marketPrice = askString('marketPrice ("pool", "market", or numeric)', base.marketPrice);
    const minPrice = askNumberOrMultiplier('minPrice', base.minPrice !== undefined ? base.minPrice : DEFAULT_CONFIG.minPrice);
    const maxPrice = askNumberOrMultiplier('maxPrice', base.maxPrice !== undefined ? base.maxPrice : DEFAULT_CONFIG.maxPrice);
    const incrementPercent = askNumber('incrementPercent', base.incrementPercent !== undefined ? base.incrementPercent : DEFAULT_CONFIG.incrementPercent);
    const targetSpreadPercent = askNumber('targetSpreadPercent', base.targetSpreadPercent !== undefined ? base.targetSpreadPercent : DEFAULT_CONFIG.targetSpreadPercent);
    const weightSell = askNumber('Weight distribution (sell)', base.weightDistribution && base.weightDistribution.sell !== undefined ? base.weightDistribution.sell : DEFAULT_CONFIG.weightDistribution.sell);
    const weightBuy = askNumber('Weight distribution (buy)', base.weightDistribution && base.weightDistribution.buy !== undefined ? base.weightDistribution.buy : DEFAULT_CONFIG.weightDistribution.buy);
    const fundsBuy = askNumberOrPercentage('botFunds buy amount', base.botFunds && base.botFunds.buy !== undefined ? base.botFunds.buy : DEFAULT_CONFIG.botFunds.buy);
    const fundsSell = askNumberOrPercentage('botFunds sell amount', base.botFunds && base.botFunds.sell !== undefined ? base.botFunds.sell : DEFAULT_CONFIG.botFunds.sell);
    const ordersBuy = askNumber('activeOrders buy count', base.activeOrders && base.activeOrders.buy !== undefined ? base.activeOrders.buy : DEFAULT_CONFIG.activeOrders.buy);
    const ordersSell = askNumber('activeOrders sell count', base.activeOrders && base.activeOrders.sell !== undefined ? base.activeOrders.sell : DEFAULT_CONFIG.activeOrders.sell);

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
        botFunds: { buy: fundsBuy, sell: fundsSell },
        activeOrders: { buy: ordersBuy, sell: ordersSell }
    };
}

async function main() {
    console.log('dexbot bots — bots.json configurator (writes profiles/bots.json)');
    const { config, filePath } = loadBotsConfig();
    let exit = false;
    while (!exit) {
        console.log('\nActions:');
        console.log('  1) List bots');
        console.log('  2) New bot');
        console.log('  3) Copy bot');
        console.log('  4) Modify bot');
        console.log('  5) Delete bot');
        console.log('  6) Exit');
        const selection = readline.question('Choose an action [1-6]: ').trim();
        console.log('');
        switch (selection) {
            case '1':
                listBots(config.bots);
                break;
            case '2': {
                const entry = promptBotData();
                config.bots.push(entry);
                saveBotsConfig(config, filePath);
                console.log(`Added bot '${entry.name}' to ${path.basename(filePath)}.`);
                break;
            }
            case '3': {
                const idx = selectBotIndex(config.bots, 'Select bot to copy');
                if (idx === null) break;
                const entry = promptBotData(config.bots[idx]);
                config.bots.splice(idx + 1, 0, entry);
                saveBotsConfig(config, filePath);
                console.log(`Copied bot '${entry.name}' into ${path.basename(filePath)}.`);
                break;
            }
            case '4': {
                const idx = selectBotIndex(config.bots, 'Select bot to modify');
                if (idx === null) break;
                const entry = promptBotData(config.bots[idx]);
                config.bots[idx] = entry;
                saveBotsConfig(config, filePath);
                console.log(`Updated bot '${entry.name}' in ${path.basename(filePath)}.`);
                break;
            }
            case '5': {
                const idx = selectBotIndex(config.bots, 'Select bot to delete');
                if (idx === null) break;
                const confirm = askBoolean(`Delete '${config.bots[idx].name || `<unnamed-${idx}>`}?`, false);
                if (confirm) {
                    const removed = config.bots.splice(idx, 1)[0];
                    saveBotsConfig(config, filePath);
                    console.log(`Removed bot '${removed.name || `<unnamed-${idx}>`}' from ${path.basename(filePath)}.`);
                } else {
                    console.log('Deletion cancelled.');
                }
                break;
            }
            case '6':
                exit = true;
                break;
            default:
                console.log('Unknown selection.');
        }
    }
    console.log('Bots configuration helper exiting.');
}

module.exports = { main };

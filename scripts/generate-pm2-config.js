#!/usr/bin/env node
/**
 * Generate PM2 ecosystem.config.js from profiles/bots.json
 *
 * This script:
 * 1. Reads profiles/bots.json
 * 2. Creates log directories for each active bot
 * 3. Generates profiles/ecosystem.config.js with proper configuration
 *
 * Usage:
 *   node scripts/generate-pm2-config.js         # generate from profiles/bots.json
 *   node scripts/generate-pm2-config.js --dry   # dry-run, shows what would be generated
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry') || argv.includes('--dry-run');

const repoRoot = path.join(__dirname, '..');
const botsConfigPath = path.join(repoRoot, 'profiles', 'bots.json');
const profilesEcoConfigPath = path.join(repoRoot, 'profiles', 'ecosystem.config.js');
const profilesDir = path.join(repoRoot, 'profiles');
const logsDir = path.join(repoRoot, 'profiles', 'logs');

// Read and parse bots config
function readBotsConfig() {
    try {
        const content = fs.readFileSync(botsConfigPath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error('ERROR: Failed to read or parse bots.json:', err.message);
        process.exit(1);
    }
}

// Create logs directory if it doesn't exist
function ensureLogsDir() {
    if (!fs.existsSync(logsDir)) {
        if (dryRun) {
            console.log('[dry] Would create directory:', logsDir);
            return;
        }
        fs.mkdirSync(logsDir, { recursive: true });
        console.log('Created logs directory:', logsDir);
    }
}

// Generate app config for a single bot
function generateAppConfig(bot, index) {
    const botName = bot.name || `bot-${index}`;
    const market = `${bot.assetA}-${bot.assetB}`;
    const botNumber = String(index + 1).padStart(2, '0');

    return {
        name: botName,
        script: path.join(repoRoot, 'bot.js'),
        cwd: repoRoot,
        max_memory_restart: '200M',
        watch: false,
        autorestart: true,
        error_file: path.join(repoRoot, 'profiles', 'logs', `${botName}-error.log`),
        out_file: path.join(repoRoot, 'profiles', 'logs', `${botName}.log`),
        log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
        merge_logs: false,
        combine_logs: true,
        env: {
            NODE_ENV: 'production',
            BOT_NUMBER: botNumber,
            MARKET: market,
            PREFERRED_ACCOUNT: bot.preferredAccount || botName
        },
        max_restarts: 13,
        min_uptime: 86400000,
        restart_delay: 3000
    };
}

// Generate the full ecosystem config
function generateEcosystemConfig(botsConfig) {
    const apps = [];
    const bots = botsConfig.bots || [];

    bots.forEach((bot, index) => {
        if (bot.active) {
            apps.push(generateAppConfig(bot, index));
        }
    });

    return {
        apps
    };
}

// Format and write the ecosystem config file
function writeEcosystemConfig(config) {
    const configCode = `/**
 * PM2 ecosystem configuration
 *
 * Auto-generated from profiles/bots.json
 * Run 'npm run pm2:generate' to regenerate
 *
 * Each app runs ./bot.js inside the project root; pm2 will set environment variables
 * which your bot can read to pick the market, instance number and config.
 */

module.exports = ${JSON.stringify(config, null, 2)};
`;

    if (dryRun) {
        console.log('\n[dry] Would write to:', profilesEcoConfigPath);
        console.log('\n--- Generated ecosystem.config.js ---');
        console.log(configCode);
        console.log('--- End of generated file ---\n');
        return;
    }

    // Write profiles/ecosystem.config.js
    fs.writeFileSync(profilesEcoConfigPath, configCode, 'utf8');
    console.log('Generated profiles/ecosystem.config.js');
}

// Clean up old bot-specific symlinks
function cleanupOldSymlinks(botsConfig) {
    const bots = botsConfig.bots || [];

    bots.forEach(bot => {
        const botName = bot.name;
        const symlink = path.join(profilesDir, botName + '.config.js');

        if (fs.existsSync(symlink)) {
            if (dryRun) {
                console.log('[dry] Would remove old symlink:', symlink);
                return;
            }

            try {
                fs.unlinkSync(symlink);
                console.log('Removed old symlink:', botName + '.config.js');
            } catch (err) {
                // Ignore errors
            }
        }
    });
}

// Main execution
function main() {
    console.log('Generating PM2 ecosystem config from profiles/bots.json...');

    if (dryRun) {
        console.log('[DRY RUN MODE]\n');
    }

    // Read bots config
    const botsConfig = readBotsConfig();
    const activeBots = (botsConfig.bots || []).filter(b => b.active);

    if (activeBots.length === 0) {
        console.warn('WARNING: No active bots found in profiles/bots.json');
    } else {
        console.log(`Found ${activeBots.length} active bot(s):`);
        activeBots.forEach((bot, i) => {
            const market = `${bot.assetA}-${bot.assetB}`;
            console.log(`  [${i + 1}] ${bot.name} (${market})`);
        });
    }

    // Ensure logs directory exists
    ensureLogsDir();

    // Generate and write config
    const ecoConfig = generateEcosystemConfig(botsConfig);
    writeEcosystemConfig(ecoConfig);

    // Clean up old individual bot symlinks
    if (!dryRun) {
        console.log('\nCleaning up old bot-specific symlinks...');
        cleanupOldSymlinks(botsConfig);
    }

    if (!dryRun) {
        console.log('\nDone! You can now start the bots with:');
        console.log('  pm2 start profiles/ecosystem.config.js # Start all active bots (recommended)');
        console.log('  npm run pm2:start:profiles             # Start via npm');
        console.log('  npm run pm2:bot bot-name               # Using npm wrapper');
    }
}

main();

#!/usr/bin/env node
// node-only entry point — single bot instance launcher (process.argv, process.exit, stdin, child_process)
/**
 * bot.ts - Single Bot Instance Launcher
 *
 * PM2-friendly entry point for single grid trading bot.
 * Standalone launcher executed by PM2 for each configured bot.
 * Handles bot initialization, authentication, and continuous trading loop.
 *
 * ===============================================================================
 * STARTUP SEQUENCE
 * ===============================================================================
 *
 * 1. BOT CONFIGURATION LOADING
 *    - Reads bot settings from profiles/bots.json by bot name (from argv)
 *    - Validates bot exists in configuration
 *    - Reports market pair and account being used
 *    - Loads trading parameters (grid size, spread, order count, etc.)
 *
 * 2. AUTHENTICATION
 *    - First attempts credential daemon (Unix socket) for a session-only signing token
 *    - Falls back to interactive master password prompt if daemon unavailable
 *    - Master password never stored in environment variables
 *    - Legacy path still loads a raw private key into bot memory
 *
 * 3. BOT INITIALIZATION
 *    - Waits for BitShares blockchain connection (30 second timeout)
 *    - Uses pre-decrypted private key for transaction signing
 *    - Resolves account ID from BitShares
 *    - Initializes OrderManager with bot configuration
 *    - Sets up event handlers for fills and blockchain updates
 *
 * 4. GRID INITIALIZATION OR RESUME
 *    - Loads persisted grid snapshot if it exists and matches on-chain orders
 *    - Validates persisted grid against current blockchain state (reconciliation)
 *    - Detects offline fills and updates fund accounting automatically
 *    - Creates fresh grid if no valid persisted state found
 *    - Synchronizes grid state with BitShares blockchain
 *    - Places initial orders to reach target count
 *    - Note: Grid uses Copy-on-Write pattern for safe rebalancing (isolated working copies)
 *
 * 5. TRADING LOOP
 *    - Continuously monitors for fill events via blockchain subscriptions
 *    - Updates order status from chain data
 *    - Processes fills and updates fund accounting
 *    - Regenerates/rebalances grid as needed
 *    - Runs indefinitely (PM2 manages restart/stop/monitoring)
 */

// Restrict default file permissions: files created by this process default to
// 0o600 (owner-only) unless explicitly opened with a wider mode.  Protects
// keys.json and daemon-policies.json from world-readable exposure.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { setUmask } = require('./modules/config');
setUmask(0o077);

const { getStorage } = require('./modules/storage');
const storage = getStorage();
const { runtime } = require('./modules/runtime');
const { createPm2AwareLogger } = require('./modules/order/logger');
const DEXBot = require('./modules/dexbot_class').default;
const { normalizeBotEntry } = require('./modules/dexbot_class').default;
const { loadSettingsFile, resolveRawBotEntries, selectBotEntry, collectValidationIssues } = require('./modules/bot_settings');
const fundRegistry = require('./modules/fund_registry');
const { setupGracefulShutdown, registerCleanup, unregisterCleanup } = require('./modules/graceful_shutdown');
const chainKeys = require('./modules/chain_keys');
const { getKeyStore } = require('./modules/key_store');
const credentialPolicy = require('./modules/credential_policy');
const { PATHS } = require('./modules/paths');
const { Config } = require('./modules/config');
const { getErrorMessage } = require('./modules/utils/errors');
const { isSameBotName } = require('./modules/utils/sanitize_key');

// Setup graceful shutdown handlers
setupGracefulShutdown();

// Verify keys file permissions early — refuse to run if keys.json is
// world-readable (would indicate a prior run with a permissive umask).
if (typeof chainKeys.checkKeysFileSecurity === 'function') chainKeys.checkKeysFileSecurity();
// Same migration-aware check for daemon-policies.json.
if (typeof credentialPolicy.checkPolicyFileSecurity === 'function') credentialPolicy.checkPolicyFileSecurity(PATHS.PROFILES.DAEMON_POLICIES_JSON);
const launcherLogger = createPm2AwareLogger('bot.js');

const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

// Get bot name from args or environment
// Support both direct names (node dist/bot.js botname) and flag format (node dist/bot.js --botname)
// Flag format is used by PM2 for consistency with other CLI tools
let botNameArg = Config.ARGS[0];
if (botNameArg && botNameArg.startsWith('--')) {
    // Strip '--' prefix if present (e.g., --mybot becomes mybot)
    botNameArg = botNameArg.substring(2);
}
const botNameEnv = Config.BOT_NAME || Config.PREFERRED_ACCOUNT;
const botName = botNameArg || botNameEnv;

if (!botName) {
    launcherLogger.error('No bot name provided. Usage: node dist/bot.js <bot>');
    launcherLogger.error('Or set BOT_NAME or PREFERRED_ACCOUNT environment variable');
    runtime.exit(1);
}

/**
 * Loads the configuration for a specific bot from profiles/bots.json.
 * @param {string} name - The name of the bot to load.
 * @returns {Object} The bot configuration entry. Exits process on failure.
 */
function loadBotConfig(name: string) {
    if (!storage.exists(PROFILES_BOTS_FILE)) {
        launcherLogger.error(`${PROFILES_BOTS_FILE} not found. Run: dexbot bot`);
        runtime.exit(1);
    }

    try {
        const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
        const botEntry = selectBotEntry(config, name);

        // Validate all profile files at startup (skip for PM2 child processes and tests)
        if (!Config.DEXBOT_SKIP_PROFILE_VALIDATION && !Config.PM2_HOME) {
            const { validateAllProfiles, printValidationProblems } = require('./modules/validate_profiles');
            const result = validateAllProfiles();
            const ok = printValidationProblems(result);
            if (!ok) {
                launcherLogger.error('Fix the configuration errors above and restart.');
                runtime.exit(1);
            }
        }

        if (!botEntry) {
            const bots = resolveRawBotEntries(config);
            launcherLogger.error(`Bot '${name}' not found in ${PROFILES_BOTS_FILE}`);
            launcherLogger.error(`Available bots: ${bots.map((b: { name?: string }) => b.name).join(', ') || 'none'}`);
            runtime.exit(1);
        }

        return botEntry;
    } catch (err) {
        launcherLogger.error(`Error loading bot config: ${getErrorMessage(err)}`);
        runtime.exit(1);
    }
}

/**
 * Get signing secret for account from daemon or interactive prompt.
 * Tries daemon first (if running), then falls back to interactive master password prompt.
 * @param {string} accountName - The account name to retrieve key for.
 * @returns {Promise<string|Object>} A raw private key for legacy mode, or a daemon signing token.
 * @throws {Error} If both daemon and interactive authentication fail.
 */
async function getSigningSecretForAccount(accountName: string) {
    const keyStore = getKeyStore();
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
        const isNoisy = args.some(
            (arg) => typeof arg === 'string' && (arg.includes('bitshares_client') || arg.includes('modules/'))
        );
        if (!isNoisy) {
            origLog.apply(console, args);
        }
    };
    try {
        return await keyStore.resolveSigningKey(accountName);
    } finally {
        console.log = origLog;
    }
}

// Main entry point
(async () => {
    try {
        // Load bot configuration
        const botConfig = loadBotConfig(botName);

         // Load all bots from configuration to prevent pruning other active bots
          const { config: allBotsConfigData } = loadSettingsFile(PROFILES_BOTS_FILE);
          const allBotsConfig = resolveRawBotEntries(allBotsConfigData);
         
         // Normalized entries carry botKey and the default active=true that
         // raw profile entries omit. Both the warnings and the prune below
         // must use the same canonical definition of an active bot.
         let normalizedAll: any[] = [];
         try {
             normalizedAll = allBotsConfig.map((entry: any, idx: number) => normalizeBotEntry(entry, idx));
         } catch { /* fall back to raw keys below */ }

         // Surface shared-account allocation warnings that the monolithic
         // launcher prints but the PM2 path used to drop silently. The check
         // is optional when bot_settings is stubbed in startup tests.
         if (typeof collectValidationIssues === 'function') {
             try {
                 const validation = collectValidationIssues(normalizedAll.filter((b: any) => b.active !== false), 'bots.json');
                 for (const warning of validation.warnings || []) launcherLogger.warn(warning);
             } catch { /* non-fatal: profile validation already ran */ }
         }

         // Find the current bot's index in the unfiltered bots.json array
          const botIndex = allBotsConfig.findIndex((b: { name?: string }) => isSameBotName(b.name, botName));
         if (botIndex === -1) {
             throw new Error(`Bot "${botName}" not found in ${PROFILES_BOTS_FILE}`);
         }

         // Normalize config for current bot with correct index from unfiltered array
         const normalizedConfig = normalizeBotEntry(botConfig, botIndex);

        // Get signing secret from daemon or interactively
        const preferredAccount = normalizedConfig.preferredAccount;

        // Remove stale registry entries for bots no longer active. The bot's
        // own entry is (re-)registered idempotently during startup.
        if (typeof fundRegistry?.pruneAccount === 'function') {
            try {
                const activeKeys = (normalizedAll.length ? normalizedAll : allBotsConfig)
                    .filter((entry: any) => entry.active !== false && entry.preferredAccount === preferredAccount)
                    .map((entry: any) => entry.botKey || entry.name)
                    .map((key: unknown) => typeof key === 'string' ? require('./modules/utils/sanitize_key').sanitizeKey(key) : null)
                    .filter((key: string | null): key is string => !!key);
                await fundRegistry.pruneAccount(String(preferredAccount), activeKeys);
            } catch { /* non-fatal: registration retries on startup */ }
        }

        const signingSecret = await getSigningSecretForAccount(preferredAccount);

         // Create and start bot with log prefix for [bot.js] context
          const bot = new DEXBot(normalizedConfig, { logPrefix: '[bot.js]' });
          const botCleanupName = `Bot: ${botName}`;
          let botCleanupHandler: (() => void) | null = null;
          try {
              // Register bot cleanup on shutdown
              botCleanupHandler = () => bot.shutdown();
              registerCleanup(botCleanupName, botCleanupHandler);

              await bot.startWithPrivateKey(signingSecret);
          } catch (err) {
              // The bot's _runStartupSequence already invoked shutdown() once on
              // the failure path. Remove the registered cleanup so the LIFO
              // cleanup loop in graceful_shutdown.ts does not call shutdown() a
              // second time, and avoid the "double graceful shutdown" log pattern.
              if (botCleanupHandler) {
                  unregisterCleanup(botCleanupHandler);
              }
              // Attempt graceful cleanup before exiting
              try {
                  await bot.shutdown();
              } catch (shutdownErr) {
                  launcherLogger.error(`Error during cleanup: ${getErrorMessage(shutdownErr)}`);
              }
              throw err;
          }

     } catch (err) {
         launcherLogger.error(`Failed to start bot: ${getErrorMessage(err)}`);
         runtime.exit(1);
     }
})();
export {};

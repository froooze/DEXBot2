/**
 * modules/graceful_shutdown.ts - Process Shutdown Manager
 *
 * Centralized graceful shutdown handler for clean process termination.
 *
 * Features:
 * - Registers signal handlers (SIGTERM, SIGINT)
 * - Executes cleanup functions in reverse registration order
 * - Prevents duplicate shutdown execution
 * - Graceful cleanup with timeout protection
 * - Detailed shutdown logging
 *
 * ===============================================================================
 * EXPORTS (4 functions)
 * ===============================================================================
 *
 * 1. registerCleanup(name, cleanupFn) - Register cleanup function
 *    name: Description of cleanup operation (e.g., "Bot connection", "BitShares")
 *    cleanupFn: Async function to execute during shutdown
 *    Functions execute in reverse registration order (LIFO)
 *
 * 2. unregisterCleanup(name) - Unregister a previously registered cleanup
 *
 * 3. registerExitWipe(name, wipeFn) - Register a synchronous wipe callback
 *    that runs AFTER all LIFO cleanups, right before process exit (e.g. a
 *    best-effort disk wipe); returns an unregister function
 *
 * 4. setupGracefulShutdown() - Install signal and exception handlers
 *    Registers SIGTERM, SIGINT, uncaughtException, unhandledRejection handlers
 *    Should be called once at process startup
 *
 * ===============================================================================
 *
 * SHUTDOWN PROCESS:
 * 1. Receive SIGTERM or SIGINT signal
 * 2. Mark shutdown in progress (prevent duplicate execution)
 * 3. Log shutdown initiation
 * 4. Execute cleanup functions in reverse order (LIFO)
 * 5. Wait for all cleanups to complete (with timeout)
 * 6. Log shutdown status
 * 7. Exit process
 *
 * USAGE (from the repo root):
 * import { registerCleanup } from './modules/graceful_shutdown.js';
 *
 * // Register cleanups (executed in reverse order on shutdown)
 * registerCleanup('Database', async () => db.close());
 * registerCleanup('Bot', async () => bot.shutdown());
 * registerCleanup('BitShares', async () => BitShares.disconnect());
 *
 * On SIGTERM/SIGINT:
 * 1. BitShares disconnects
 * 2. Bot shuts down
 * 3. Database closes
 *
 * ===============================================================================
 *
 * BEST PRACTICES:
 * - Register cleanups for each major component
 * - Order matters: register in opposite order of initialization
 * - Keep cleanup functions quick and non-blocking where possible
 * - Handle cleanup errors gracefully (don't throw)
 *
 * ===============================================================================
 */




import Logger from './order/logger.js';
import { runtime } from './runtime.js';
import { getErrorMessage, getErrorField } from './utils/errors.js';
import { withTimeout } from './order/utils/timeout.js';

const CLEANUP_HANDLER_TIMEOUT_MS = 10000;
let cleanupHandlers: Array<{ name: string; handler: () => unknown }> = [];
let shutdownInProgress = false;
const shutdownLogger = new Logger('Shutdown');
const exitWipeCallbacks: Array<{ name: string; handler: () => unknown }> = [];

/**
 * Shared registration guard for the cleanup and exit-wipe lists. Both hold
 * `{ name, handler }` records and reject non-function handlers, so the
 * validation and push live in one place.
 * @private
 */
function registerHandler(
    list: Array<{ name: string; handler: () => unknown }>,
    name: string,
    handler: () => unknown,
    label: string,
): void {
    if (typeof handler !== 'function') {
        throw new Error(`${label} for '${name}' must be a function`);
    }
    list.push({ name, handler });
}

/**
 * Register a synchronous wipe callback that runs AFTER all LIFO cleanup
 * handlers have completed, immediately before process exit. Unlike regular
 * cleanup handlers (whose relative order depends on registration time), exit
 * wipes are guaranteed to be the final code that runs during shutdown — used
 * for security hygiene such as dropping signing-token HMAC secrets so no
 * in-flight continuation can still read them after the process is done.
 * @param {string} name - Description used in shutdown logs
 * @param {Function} wipeFn - Synchronous function to execute last
 */
function registerExitWipe(name: string, wipeFn: () => void) {
    registerHandler(exitWipeCallbacks, name, wipeFn, 'Exit wipe callback');
}

/**
 * Register a cleanup function to be called on graceful shutdown
 * Functions are called in LIFO order (last registered = first called)
 * @param {string} name - Name of the cleanup operation (for logging)
 * @param {Function} handler - Async or sync function to call on shutdown
 */
function registerCleanup(name: string, handler: () => unknown) {
    registerHandler(cleanupHandlers, name, handler, 'Cleanup handler');
}

/**
 * Remove a previously registered cleanup function.
 * Use this when a component fails to initialize and its cleanup must not run
 * on process exit. Returns true if a handler was removed.
 * @param {string|Function} nameOrHandler - Cleanup name or handler reference
 * @returns {boolean} True when a handler was found and removed
 */
function unregisterCleanup(nameOrHandler: string | (() => unknown)) {
    const initialLength = cleanupHandlers.length;
    if (typeof nameOrHandler === 'function') {
        for (let i = cleanupHandlers.length - 1; i >= 0; i--) {
            if (cleanupHandlers[i].handler === nameOrHandler) {
                cleanupHandlers.splice(i, 1);
            }
        }
    } else if (typeof nameOrHandler === 'string') {
        for (let i = cleanupHandlers.length - 1; i >= 0; i--) {
            if (cleanupHandlers[i].name === nameOrHandler) {
                cleanupHandlers.splice(i, 1);
            }
        }
    }
    return cleanupHandlers.length !== initialLength;
}

/**
 * Execute all registered cleanup handlers
 * @private
 */
async function executeCleanup() {
    if (shutdownInProgress) {
        return;
    }
    shutdownInProgress = true;

    shutdownLogger.info('Cleaning up resources...');

    // Execute handlers in LIFO order (last registered = first cleaned up)
    for (let i = cleanupHandlers.length - 1; i >= 0; i--) {
        const { name, handler } = cleanupHandlers[i];
        try {
            shutdownLogger.info(`Cleaning up: ${name}`);
            const result = handler();
            // Handle both async and sync handlers
            if (result && typeof (result as Promise<unknown>).then === 'function') {
                await withTimeout(
                    Promise.resolve(result).catch(() => {}),
                    CLEANUP_HANDLER_TIMEOUT_MS,
                    {
                        onTimeout: 'resolve',
                        defaultValue: undefined,
                        label: `cleanup:${name}`,
                        onTimeoutCallback: () => {
                            shutdownLogger.error(`✗ Cleanup timed out after ${CLEANUP_HANDLER_TIMEOUT_MS}ms: ${name} (handler still running in background)`);
                        },
                    }
                );
            }
            shutdownLogger.info(`✓ ${name}`);
        } catch (err) {
            shutdownLogger.error(`✗ Error cleaning up ${name}: ${getErrorMessage(err) || err}`);
        }
    }

    for (let i = 0; i < exitWipeCallbacks.length; i++) {
        const { name, handler } = exitWipeCallbacks[i];
        try {
            handler();
            shutdownLogger.info(`✓ ${name} (exit wipe)`);
        } catch (err) {
            shutdownLogger.error(`✗ Exit wipe ${name} failed: ${getErrorMessage(err) || err}`);
        }
    }

    shutdownLogger.info('Cleanup complete');
    await shutdownLogger.flush();
}

/**
 * Setup signal handlers for graceful shutdown
 * Should be called once at process startup
 */
function setupGracefulShutdown() {
    const signals = ['SIGTERM', 'SIGINT'];

    signals.forEach((signal) => {
        runtime.onSignal(signal, async () => {
            shutdownLogger.info(`Received ${signal}, initiating graceful shutdown...`);
            await executeCleanup();
            runtime.exit(0);
        });
    });

    // Exit wipes must also run on exit paths that bypass executeCleanup
    // (direct process.exit calls, event-loop drain). The 'exit' event only
    // allows synchronous work, which suits the wipe callbacks.
    runtime.onSignal('exit', () => {
        for (let i = 0; i < exitWipeCallbacks.length; i++) {
            try { exitWipeCallbacks[i].handler(); } catch (_) {}
        }
    });

    // Also handle uncaught exceptions
    runtime.onSignal('uncaughtException', async (err: unknown) => {
        shutdownLogger.error(`Uncaught exception: ${(err as { stack?: string })?.stack || err}`);
        await executeCleanup();
        // Drain stderr before exit so traces survive pipe to MONOLITHIC_ERROR_LOG
        runtime.exitAfterStderrDrain(1);
    });

    // Handle unhandled rejections
    runtime.onSignal('unhandledRejection', async (reason: unknown, promise: unknown) => {
        shutdownLogger.error(`Unhandled rejection at: ${promise} reason: ${getErrorField<string>(reason, 'stack') || reason}`);
        await executeCleanup();
        runtime.exitAfterStderrDrain(1);
    });
}

export { registerCleanup, unregisterCleanup, registerExitWipe, setupGracefulShutdown }


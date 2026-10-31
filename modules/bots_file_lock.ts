/**
 * modules/bots_file_lock.ts - File Synchronization Lock
 *
 * Thread-safe reading and writing of bots.json with in-memory locking.
 * Prevents race conditions between concurrent access within the same process.
 *
 * Locking Strategy:
 * - Re-entrant lock via AsyncLock (AsyncLocalStorage-based re-entrancy detection)
 * - Only one operation (read or write) at a time within the process
 * - Nested acquire from the same async context does not deadlock
 * - Cross-process safety relies on the atomic tmp-file + rename write
 *   (writeJsonFileAtomic); the in-memory lock alone does not span processes
 *
 * ===============================================================================
 * EXPORTS (4 functions)
 * ===============================================================================
 *
 * 1. readBotsFileWithLock(botsJsonPath, parseFunction) - Lock-protected async file read
 *    Returns: Promise<{content: string, config: Object}>
 *    Acquires lock, reads and parses file, releases lock
 *
 * 2. writeBotsFileWithLock(botsJsonPath, config) - Lock-protected async file write
 *    Returns: Promise<void>
 *    Acquires lock, writes JSON, releases lock
 *
 * 3. readBotsFileSync(botsJsonPath, parseFunction) - Synchronous file read (startup only)
 *    Returns: {content: string, config: Object}
 *    WARNING: Blocks event loop — only use before event loop is active
 *
 * 4. writeJsonFileAtomic(filePath, data) - Atomically write JSON via tmp file + rename
 *    Returns: void (synchronous)
 *    Stages to temp file in same directory, then renames into place
 *
 * ===============================================================================
 *
 * USAGE (from the repo root):
 * import { readBotsFileWithLock, writeBotsFileWithLock, readBotsFileSync } from './modules/bots_file_lock.js';
 * const { config } = await readBotsFileWithLock('./profiles/bots.json', JSON.parse);
 * await writeBotsFileWithLock('./profiles/bots.json', updatedConfig);
 *
 * ===============================================================================
 */




import { getStorage } from './storage/index.js';
import AsyncLock from './order/async_lock.js';
const storage = getStorage();

/**
 * Write a JSON document atomically — delegates to the unified StorageAdapter
 * which uses tmp-file + rename (atomic on POSIX and Windows).
 *
 * @param {string} targetPath - Path of the final JSON file.
 * @param {*} data - Anything `JSON.stringify` accepts.
 */
function writeJsonFileAtomic(targetPath: string, data: unknown) {
    storage.writeJSON(targetPath, data);
}

// Global re-entrant lock for bots.json file access.
// Uses AsyncLock which supports nested acquire calls via
// AsyncLocalStorage-based re-entrancy detection.
const botsFileLock = new AsyncLock();

/**
 * Parse a bots.json payload, applying the shared empty-file fallback. Both the
 * locked async read and the startup sync read go through this so the
 * empty-file default cannot drift between them.
 * @param {string} content - Raw file content
 * @param {Function} parseFunction - JSON parser function
 * @returns {{content: string, config: Object}} Content and parsed config
 */
function parseBotsContent<T>(content: string, parseFunction: (content: string) => T): { content: string; config: T } {
    if (!content || !content.trim()) {
        return { content: '', config: { bots: [] } as unknown as T };
    }
    return { content, config: parseFunction(content) };
}

/**
 * Safely read bots.json with lock protection (re-entrant safe).
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Function} parseFunction - JSON parser function (e.g., parseJsonWithComments)
 * @returns {Promise<{content: string, config: Object}>} File content and parsed config
 * @throws {Error} If file doesn't exist or JSON is invalid
 */
async function readBotsFileWithLock<T>(botsJsonPath: string, parseFunction: (content: string) => T): Promise<{ content: string; config: T }> {
    return botsFileLock.acquire(async () => {
        if (!storage.exists(botsJsonPath)) {
            throw new Error(`bots.json not found at ${botsJsonPath}`);
        }

        return parseBotsContent(storage.readFile(botsJsonPath), parseFunction);
    });
}

/**
 * Safely write bots.json with lock protection (re-entrant safe).
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Object} config - Configuration object to write
 * @returns {Promise<void>}
 * @throws {Error} If write fails
 */
async function writeBotsFileWithLock(botsJsonPath: string, config: unknown) {
    return botsFileLock.acquire(async () => {
        // Atomic write prevents readers (in this process or another) from
        // seeing a truncated file mid-write. The in-process semaphore here
        // serializes concurrent writers within the same process; the
        // tmp+rename is the cross-process safety net.
        writeJsonFileAtomic(botsJsonPath, config);
    });
}

/**
 * Synchronously read bots.json (startup only, no lock — the in-memory
 * AsyncLock is inherently async and cannot be used here).
 * WARNING: This blocks the event loop. Use the async version when possible.
 * Only use this for startup initialization before event loop is active.
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Function} parseFunction - JSON parser function
 * @returns {{content: string, config: Object}} File content and parsed config
 * @throws {Error} If file doesn't exist or JSON is invalid
 */
function readBotsFileSync<T>(botsJsonPath: string, parseFunction: (content: string) => T): { content: string; config: T } {
    if (!storage.exists(botsJsonPath)) {
        throw new Error(`bots.json not found at ${botsJsonPath}`);
    }

    return parseBotsContent(storage.readFile(botsJsonPath), parseFunction);
}

export { readBotsFileWithLock, writeBotsFileWithLock, readBotsFileSync, writeJsonFileAtomic }


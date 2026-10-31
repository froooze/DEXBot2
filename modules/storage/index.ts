/**
 * Storage abstraction layer.
 *
 * Provides a unified IStorageAdapter interface for all filesystem operations.
 *
 * Usage (from the repo root):
 *   import { getStorage } from './modules/storage/index.js';
 *   const storage = getStorage();
 *   const data = storage.readJSON('/path/to/file.json');
 *   storage.writeJSON('/path/to/file.json', { hello: 'world' });
 *   if (storage.exists('/path/to/file.json')) { ... }
 *
 * Node:    wraps fs.*Sync directly; writeJSON uses unified atomic tmp+rename.
 * Browser: in-memory Map backed by IndexedDB (call flush() to persist).
 *
 * Adapter selection:
 *   - If `isBrowser()` (modules/env.ts) → BrowserStorageAdapter
 *   - Otherwise → NodeStorageAdapter
 *   - Explicit override via `setAdapter(adapter)` for DI/testing.
 */

import type { IStorageAdapter } from './types.js';
import { isBrowser } from '../env.js';
import createBrowserStorageAdapter from './browser_adapter.js';
import NodeStorageAdapter from './node_adapter.js';

let _adapter: IStorageAdapter | null = null;

function getStorage(): IStorageAdapter {
  if (_adapter) return _adapter;

  if (isBrowser()) {
    _adapter = createBrowserStorageAdapter();
  } else {
    _adapter = new NodeStorageAdapter();
  }

  if (!_adapter) {
    throw new Error('No storage adapter available for this environment');
  }

  return _adapter;
}

/**
 * Override the storage adapter (for DI, testing, or explicit choice).
 * Pass `null` to reset to auto-detection on next `getStorage()` call.
 */
function setAdapter(adapter: IStorageAdapter | null) {
  _adapter = adapter;
}

export { getStorage, setAdapter };
export type { IStorageAdapter };

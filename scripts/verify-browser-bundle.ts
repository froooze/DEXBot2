/**
 * Verify that the browser-safe surface actually bundles for the web.
 *
 * Two layers of checks:
 *   1. Source-level: bundles modules/*.ts entry points with --platform=browser.
 *      esbuild applies the package.json "browser" field unconditionally during
 *      module resolution. Source-level tests catch resolve failures (missing
 *      files) and unexpected pull-through of heavy dependencies.
 *   2. Dist-level: builds dist/ via tsc, then bundles dist/modules/*.js entry
 *      points. The bundle is scanned for "(disabled):" markers — esbuild
 *      inserts these when a module is replaced via the "browser" field. Any
 *      marker means an entry on the "browser" field shadows a module that is
 *      supposed to be reachable from the browser-safe surface.
 *
 * Node-only entries are tested WITHOUT externalizing Node built-ins, so they
 * correctly fail with "Could not resolve 'fs'" / 'net' / 'https' etc.
 *
 * Usage: node dist/scripts/verify-browser-bundle.js
 * Invoked by: npm run verify:browser-bundle
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';
import mod from 'module';

// Complete list of Node.js built-in modules — generated at runtime.
const NODE_BUILTINS: string[] = [...(mod.builtinModules || [])];
// Older Node versions may not expose builtinModules — fallback to common set.
if (NODE_BUILTINS.length === 0) {
  NODE_BUILTINS.push(
    'fs', 'path', 'crypto', 'net', 'tls', 'http', 'https',
    'child_process', 'os', 'tty', 'perf_hooks', 'module', 'vm',
    'url', 'querystring', 'stream', 'buffer', 'assert', 'events',
    'util', 'punycode', 'string_decoder', 'timers', 'console',
    'readline', 'cluster', 'dns', 'dgram', 'worker_threads',
    'inspector', 'trace_events', 'async_hooks', 'diagnostics_channel',
  );
}

const EXTERNAL_ARGS = NODE_BUILTINS.flatMap(m => ['--external:' + m, '--external:node:' + m]);

interface BundleTest {
  label: string;
  entry: string;
  expectFail: boolean;
  externalizeNodeBuiltins: boolean;
  /**
   * Entry is a dist/ path. Triggers a `tsc` build if any test sets this flag.
   * Bundles are then scanned for "(disabled):" markers — esbuild inserts
   * these when a module is replaced via the package.json "browser" field.
   */
  dist?: boolean;
}

const TESTS: BundleTest[] = [
  // ── Browser-safe entries (should bundle) ──────────────────────
  {
    label: 'modules/env.ts (browser-safe)',
    entry: 'modules/env.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/liquidity_pool_ref.ts (browser-safe)',
    entry: 'modules/liquidity_pool_ref.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/chain_scan.ts (browser-safe)',
    entry: 'modules/chain_scan.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/asset_lookup.ts (browser-safe)',
    entry: 'modules/asset_lookup.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/crypto/index.ts (browser-safe)',
    entry: 'modules/crypto/index.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/storage/index.ts (browser-safe)',
    entry: 'modules/storage/index.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/config.ts (browser-safe)',
    entry: 'modules/config.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/runtime.ts (browser-safe)',
    entry: 'modules/runtime.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/utils/math.ts (browser-safe)',
    entry: 'modules/order/utils/math.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'claw/modules/claw_bridge.ts (browser-safe)',
    entry: 'claw/modules/claw_bridge.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'claw/modules/honest_ecosystem.ts (browser-safe)',
    entry: 'claw/modules/honest_ecosystem.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/bots_file_lock.ts (browser-safe)',
    entry: 'modules/bots_file_lock.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/general_settings.ts (browser-safe)',
    entry: 'modules/general_settings.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/bot_settings.ts (browser-safe)',
    entry: 'modules/bot_settings.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/node_health_cache.ts (browser-safe)',
    entry: 'modules/node_health_cache.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/strategy.ts (browser-safe)',
    entry: 'modules/order/strategy.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/accounting.ts (browser-safe)',
    entry: 'modules/order/accounting.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/grid.ts (browser-safe)',
    entry: 'modules/order/grid.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/account_orders.ts (browser-safe)',
    entry: 'modules/account_orders.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/validate_profiles.ts (browser-safe)',
    entry: 'modules/validate_profiles.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/index.ts (browser-safe)',
    entry: 'modules/order/index.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/manager.ts (browser-safe)',
    entry: 'modules/order/manager.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/working_grid.ts (browser-safe)',
    entry: 'modules/order/working_grid.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/storage/node_adapter.ts (browser-safe)',
    entry: 'modules/storage/node_adapter.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/order/export.ts (browser-safe)',
    entry: 'modules/order/export.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/crypto/sync.ts (browser-safe)',
    entry: 'modules/crypto/sync.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'market_adapter/core/kibana_client.ts (browser-safe)',
    entry: 'market_adapter/core/kibana_client.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    // The canonical AMA-slope estimator; guards the browser-safe surface now
    // that this module imports modules/constants.ts.
    label: 'market_adapter/core/strategies/dynamic_weight_series.ts (browser-safe)',
    entry: 'market_adapter/core/strategies/dynamic_weight_series.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/bitshares-native/serial/serializer.ts (browser-safe)',
    entry: 'modules/bitshares-native/serial/serializer.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/bitshares-native/serial/types.ts (browser-safe)',
    entry: 'modules/bitshares-native/serial/types.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    // Guards the shared ECC core and its browser entry now that ecc.browser.ts
    // delegates its curve math to modules/bitshares-native/crypto/ecc_core.ts.
    label: 'modules/bitshares-native/crypto/ecc.browser.ts (browser-safe)',
    entry: 'modules/bitshares-native/crypto/ecc.browser.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/utils/base58check.ts (browser-safe)',
    entry: 'modules/utils/base58check.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  {
    label: 'modules/paths.ts (browser-safe)',
    entry: 'modules/paths.ts',
    expectFail: false,
    externalizeNodeBuiltins: true,
  },
  // ── Dist-level entries (browser-safe after tsc + browser-field) ─
  // Catches stale `package.json` "browser" entries that shadow a module
  // which is supposed to be reachable from the browser-safe surface.
  // esbuild inserts "(disabled):<path>" markers for any module replaced
  // via the "browser" field; any such marker fails the test.
  {
    label: 'dist/modules/constants.js (browser-safe, dist)',
    entry: 'dist/modules/constants.js',
    expectFail: false,
    externalizeNodeBuiltins: true,
    dist: true,
  },
  {
    label: 'dist/modules/bots_file_lock.js (browser-safe, dist)',
    entry: 'dist/modules/bots_file_lock.js',
    expectFail: false,
    externalizeNodeBuiltins: true,
    dist: true,
  },
  {
    label: 'dist/modules/general_settings.js (browser-safe, dist)',
    entry: 'dist/modules/general_settings.js',
    expectFail: false,
    externalizeNodeBuiltins: true,
    dist: true,
  },
  {
    label: 'dist/modules/bot_settings.js (browser-safe, dist)',
    entry: 'dist/modules/bot_settings.js',
    expectFail: false,
    externalizeNodeBuiltins: true,
    dist: true,
  },
  {
    label: 'dist/modules/node_health_cache.js (browser-safe, dist)',
    entry: 'dist/modules/node_health_cache.js',
    expectFail: false,
    externalizeNodeBuiltins: true,
    dist: true,
  },
  // ── Node-only entries (should fail without externals) ─────────
  {
    label: 'claw/index.ts (node-only)',
    entry: 'claw/index.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
  {
    label: 'market_adapter/lp_chart_runner.ts (node-only)',
    entry: 'market_adapter/lp_chart_runner.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
  {
    label: 'modules/dexbot_fill_runtime.ts (node-only)',
    entry: 'modules/dexbot_fill_runtime.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
  {
    label: 'modules/dexbot_cow_runtime.ts (node-only)',
    entry: 'modules/dexbot_cow_runtime.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
  {
    label: 'modules/dexbot_state_recovery.ts (node-only)',
    entry: 'modules/dexbot_state_recovery.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
  {
    label: 'modules/dexbot_startup_runtime.ts (node-only)',
    entry: 'modules/dexbot_startup_runtime.ts',
    expectFail: true,
    externalizeNodeBuiltins: false,
  },
];

let passed = 0;
let failed = 0;

// Build dist/ if any test uses it. Required so that dist/ entries actually
// exist when esbuild tries to bundle them.
const needsDist = TESTS.some(t => t.dist);
if (needsDist) {
  console.log('Building dist/ via tsc (required for dist-level tests)...');
  const build = spawnSync('npx', ['tsc'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    encoding: 'utf-8',
    timeout: 300000,
  });
  if (build.status !== 0) {
    console.error('tsc build failed; dist-level tests cannot run.');
    process.exit(1);
  }
}

for (const { label, entry, expectFail, externalizeNodeBuiltins } of TESTS) {
  // Write to a temp file (not /dev/null) so we can scan the bundle for
  // "(disabled):" markers that esbuild inserts when a module is replaced
  // via the package.json "browser" field.
  const outfile = pathJoin(
    tmpdir(),
    `verify-browser-bundle-${process.pid}-${Math.random().toString(36).slice(2, 10)}.js`
  );

  const args = [
    'esbuild', '--platform=browser', '--bundle',
    `--outfile=${outfile}`,
    ...(externalizeNodeBuiltins ? EXTERNAL_ARGS : []),
    entry,
  ];

  const result = spawnSync('npx', args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 30000,
  });

  const exitOk = result.status === 0;
  const outcomeCorrect = exitOk === !expectFail;

  // For tests that should succeed, check the bundle for "(disabled):" markers
  // that correspond to the entry itself. esbuild inserts these when a module
  // is replaced via the package.json "browser" field. If the entry's path
  // is among them, the entry was incorrectly disabled — the original bug
  // pattern this layer exists to catch. Other disabled modules (e.g. lazy
  // Node-only fallbacks like storage/node_adapter) are expected and ignored.
  let entryDisabled = false;
  if (outcomeCorrect && !expectFail && existsSync(outfile)) {
    try {
      const bundle = readFileSync(outfile, 'utf-8');
      const entryKey = entry.replace(/\.js$/, '');
      entryDisabled = bundle.includes(`(disabled):${entryKey}`);
    } catch {}
  }

  try { unlinkSync(outfile); } catch {}

  if (outcomeCorrect && !entryDisabled) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    if (!outcomeCorrect) {
      console.log(`    Expected ${expectFail ? 'failure' : 'success'}, got ${exitOk ? 'success' : 'failure'}`);
      const lines = (result.stderr || '').trim().split('\n').slice(0, 6);
      for (const line of lines) console.log(`    ${line}`);
    }
    if (entryDisabled) {
      console.log(`    Entry "${entry}" was disabled by package.json "browser" field — module would be empty in browser bundle.`);
    }
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${TESTS.length} total`);
if (failed > 0) process.exit(1);

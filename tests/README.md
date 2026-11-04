# DEXBot2 Test Suite

Tests live as standalone `.ts` files under `tests/` (plus `claw/tests/` for the Claw integration). They are compiled to `dist/tests/` and `dist/claw/tests/` by the build and run from there with plain `node` — no test framework, no TypeScript loader. The suite uses Node's native `assert`.

`scripts/run-tests.ts` discovers every compiled `test_*.js` and runs them sequentially, echoing output and appending a timestamped log to `tests/tmp/`. Live-blockchain tests are opt-in via `RUN_LIVE_BITSHARES_TESTS=1` (see *Runner & environment* below).

## Quick Start

```bash
# Run all offline tests (builds production code + tests first)
npm test

# Run including live-blockchain tests
npm run test:live

# Run a single test file
npm run build:tests
node dist/tests/<file>.js
```

## Directory Layout

```
tests/
  helpers/          # Shared test infrastructure (stubs, mocks, utilities)
  tmp/              # Scratch space + per-run logs (gitignored)
  tsconfig.json     # Test-specific TS config (extends root)
  <name>.ts         # Test files (one file per module or concern)
claw/tests/         # Claw integration tests (same conventions, run by npm test)
```

`helpers/` contains reusable test support:
- `bitshares_client_stub.ts` — mock blockchain client
- `chain_orders_stub.ts` — order lifecycle test doubles
- `fee_cache_init.ts` — fee cache seeding for tests
- `order_test_helpers.ts` — order construction utilities + genesis ladders (`ageChainIdAssignment` settles a fixture's fresh chain id so absence scenarios test the decision, not the in-flight guard)
- `silent_logger.ts` — suppresses log output during tests
- `module_cache_stub.ts` — isolates module state per test
- `vault_fixture.ts` — chain-key vault fixtures
- `pm2_path_shim.ts` — PM2 path isolation for `pm2.ts` tests
- `esm_mocks.ts` + `esm_mock_hooks.mjs` / `esm_mock_loader.mjs` — loader-hook harness for stubbing compiled ESM named exports
- `unlock_test_helpers.ts`, `foreign_cred_stub.js`, `dynamic_weight_files.ts` — domain-specific helpers

## Runner & environment

`scripts/run-tests.ts` runs each compiled `test_*.js` file as its own `node` process (no shared state between tests). Knobs:

- `RUN_LIVE_BITSHARES_TESTS=1` — also run the live-chain tests; without it they are skipped and counted as `skippedLive`. The live set is the `liveTestFiles` allow-list in `scripts/run-tests.ts`.
- `DEXBOT_TEST_CONCURRENCY=N` — run N files in parallel (default `min(cores, 4)`; files are isolated with per-PID `tests/tmp` scratch space, so bounded parallelism is safe). Set `DEXBOT_TEST_CONCURRENCY=1` to force the old sequential order, which is useful when debugging an interleaved log.
- `DEXBOT_TEST_TIMEOUT_MS=N` — per-file watchdog (default `240000`); on expiry the child is `SIGTERM`/`SIGKILL`ed and marked `TIMEOUT`.
- `DEXBOT_SUPPRESS_WARNINGS=1` — add `--no-warnings` to children (hides the warnings the diagnostics summary is meant to surface).

Every run appends to `tests/tmp/test-run-<timestamp>.log` and prints an aggregate summary (per-test pass/fail, slowest tests, and a diagnostics scan for warn/error/circular-dependency/deprecation/leak patterns).

## Test Categories

Tests are organized by concern, **not** by directory — patterns like `test_<area>*.ts` indicate the focus area. Below is a thematic guide with representative files (run `ls tests/*.ts` for the full list).

### Core Infrastructure
Connection, subscriptions, node management, native chain client.
*Examples:* `test_subscriptions.ts`, `test_node_manager.ts`, `test_native_chain_client.ts`, `connection_test.ts`

### Account & Authentication
Key validation, balance queries, account selection.
*Examples:* `test_key_validation.ts`, `test_account_totals.ts`, `test_chain_keys_vault.ts`

### Market Data & Pricing
Price derivation, orderbook inspection, tolerance checks.
*Examples:* `test_market_price.ts`, `test_price_derive.ts`, `test_price_tolerance.ts`, `test_any_pair.ts`, `test_kibana_candles.ts`, `test_fetch_book_data.ts`, `test_window_cache.ts`

### Market Adapter
AMA signal processing, price offset, bound clamping, signal gates.
*Examples:* `test_market_adapter_logic.ts`, `test_market_adapter_service.ts`, `test_market_adapter_signal_gates.ts`, `test_market_adapter_integration_core.ts`

### Analysis & Charting
Research/analysis tools: chart generators, backtests, and the grid-reset replay used by the TradingView exporter ([GRID_RECALCULATION.md](../docs/GRID_RECALCULATION.md)).
*Examples:* `test_grid_reset_sim.ts`, `test_tradingview_chart_storage_key.ts`, `test_backtest_bot_fitting_logic.ts`

### Order Management & Execution
Order lifecycle, fill processing, trade history, batch execution.
*Examples:* `test_open_orders.ts`, `test_fills.ts`, `test_fill_batch_chunking.ts`, `test_fill_replay_guards.ts`, `test_uncertain_broadcast.ts`

### Order Lifecycle Registry
The single answer to "does this order exist on chain, and how sure are we" ([ORDER_LIFECYCLE.md](../docs/ORDER_LIFECYCLE.md)): phases (`unknown ≠ gone`), evidence monotonicity, the unresolved bound, the write funnel (including the COW whole-map commit), and the unified absence guard the sync/reconcile/recovery sites share.
*Files:* `test_order_lifecycle.ts` (registry + manager integration), `recon_fuzz.ts` (interleaving fuzzer; `RECON_FUZZ_SCENARIOS`/`RECON_FUZZ_STEPS` scale it)

### Strategy & Grid Logic
Grid generation, sizing, rotation, divergence detection, reconciliation.
*Examples:* `test_order_grid.ts`, `test_strategy_logic.ts`, `test_grid_reconcile.ts`, `test_working_grid.ts`, `test_rotation_order_sizing.ts`, `test_strategy_edge_cases.ts`, `test_edge_orders.ts`

### Copy-on-Write (COW) Rebalancing
Concurrent-safe rebalancing with isolated working grids — dedicated test suite.
*Examples:* `test_cow_master_plan.ts`, `test_cow_concurrent_fills.ts`, `test_cow_commit_guards.ts`, `test_cow_divergence_correction.ts`, `test_cow_static_analysis.ts`

### Fees & Accounting
Fee deduction, fund tracking, precision, invariant checks.
*Examples:* `test_accounting_logic.ts`, `test_fee_cache.ts`, `test_bts_fee_accounting.ts`, `test_core_fee_accounting.ts`, `test_funds.ts`, `test_precision_quantization.ts`

### Integration & Workflows
Cross-module scenarios: startup reconciliation, engine integration, market simulations.
*Examples:* `test_engine_integration.ts`, `test_market_scenarios.ts`, `test_grid_reconcile.ts` ([GRID_RECONCILE.md](../docs/GRID_RECONCILE.md)), `test_startup_decision.ts`, `test_main_loop_sync_fill_rebalance.ts`

### Credential Daemon & Runtime
Credential management, daemon lifecycle, session caching, debt policy.
*Examples:* `test_credential_daemon.ts`, `test_credential_runtime.ts`, `test_credential_session_cache.ts`, `test_credit_runtime.ts`

### PM2 & Process Management
PM2 lifecycle, startup ordering, bot supervision, launcher version reporting.
*Examples:* `test_pm2_logic.ts`, `test_pm2_main_output.ts`, `test_bot_supervisor.ts`, `test_unlock_main.ts`, `test_version_notice.ts`

### Diagnostics & Benchmarks
Interactive tools and performance benchmarks (not part of CI).
*Examples:* `connection_test.ts`, `diag_adapter_client.ts`, `diag_ws_nodes.ts`, `diag_ws_lifecycle.ts`, `benchmark_cow.ts`, `sim_batching.ts`, `repro_phantom_orders.ts`

### Browser Charts (Playwright)
End-to-end tests for the generated HTML charts (currently the `dexbot tv`
TradingView exporter). These load a real chart page in Firefox and assert on
canvas draw work and pixels, so they live under `tests/playwright/` as
`.spec.mjs` files and are **not** picked up by the plain `node` runner.

```bash
npm run test:playwright          # builds, then runs tests/playwright
```

The runner and browsers come from a global Playwright install (the repo keeps
zero runtime deps); `test:playwright` points `NODE_PATH` at `npm root -g`, and
the spec resolves `playwright/test` dynamically. That inline `NODE_PATH=` is
POSIX-shell syntax (Linux/macOS); on Windows set it in your shell
(`$env:NODE_PATH=(npm root -g)`) or add a local `playwright` devDependency.
**Firefox is the default target** (set in
`tests/playwright/playwright.config.mjs`) because that is the browser the
generated charts are hand-checked in. If Playwright or the Firefox build is
missing: `npm i -g playwright && npx playwright install firefox`.

`tv_chart_perf.spec.mjs` pins the range-band draw hook to the visible bar
window: it counts `CanvasRenderingContext2D.lineTo` calls to prove the band's
per-redraw cost scales with the viewport (not the full series), and diffs
canvas pixels to prove the band still spans the plot when zoomed in. By default
it generates a synthetic TV page; set `TV_CHART_HTML=<path>` to run the load
check against any already-generated chart HTML (the uPlot interception is
generic; the Range-band assertions are skipped when the page has no Range
toggle).

### Edge Cases & Regression
Tests targeting specific bugs, race conditions, and failure modes.
*Examples:* `test_critical_bug_fixes.ts`, `test_race_condition_fixes_batch1.ts`, `test_patch17_invariants.ts`, `test_shutdown_reentrancy.ts`, `test_multifill_opposite_partial.ts`, `test_correction_queue_staleness.ts`, `test_spread_pure_fund_driven.ts`, `test_spread_correction_resilience.ts`, `test_sync_lock_id_verification.ts`

### Utilities & Helpers
Shared utility functions, precision handling, chain helpers.
*Examples:* `test_utils.ts`, `test_chain_helpers.ts`, `test_precision_integration.ts`, `test_fund_cycling_trigger.ts`, `test_manager.ts`

---

## Key Architectural Patterns Tested

### Copy-on-Write (COW) Rebalancing
- Master grid remains immutable during rebalancing
- Working grids are isolated copies for planning
- Fills arriving mid-rebalance are synchronized
- Delta building identifies changes between grids
- Atomic commits apply changes only on success

**Reference:** [docs/COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md)

### Spread-Correction Resilience
- Refusal-cause classification and the transient/non-transient split are centralized (`SPREAD_CORRECTION_REFUSAL`)
- Plan-time CREATE dedupe withholds a plan whose destination was taken after planning
- The bounded fresh-master re-plan lands a transiently-refused correction on the retry
- The broadcast region is held across the plan/retry loop and released exactly once (including on throw)
- The out-of-spread watchdog tolerates transient refusals only up to its grace budget

**Reference:** [docs/architecture.md](../docs/architecture.md) (Spread Correction → Resilience)

### RMS Divergence Checking
- Quadratic penalty for large errors
- Concentrated errors raise RMS threshold
- Grid recalculation triggers at correct levels

### Fund Invariants
- Available funds never exceed free blockchain balance
- Committed funds tracked across state transitions
- Fee deductions and refunds maintain consistency
- No double-spending between orders

**Reference:** [docs/FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)

### Grid-Price Invariant & Hold Guards
- Every emitted order's price must equal its slot's genesis level (`priceForSlot(idx, genesis)`); off-grid emissions are blocked, not counted
- The guard itself plus the live batch wiring, escalation thresholds, and per-order stranded-hold clocks are each pinned and mutation-tested
- Adoption keeps the slot's own level; `loadGrid` repairs a pre-existing off-grid slot price
- A snapshot with no usable ladder is refused at load (`MISSING_GENESIS_POLICY` rebuild/halt) and the sync entry refuses rather than falling back to a tolerance matcher

**Reference:** [docs/GRID_PRICE_INVARIANT.md](../docs/GRID_PRICE_INVARIANT.md)

**Examples:** `test_grid_price_invariant_guard.ts`, `test_grid_price_invariant_wiring.ts`, `test_grid_price_slot_invariant.ts`, `test_final_pivot_gate.ts`, `test_hold_and_center_guards.ts`, `test_sync_out_of_grid_defer.ts`, `test_missing_genesis_policy.ts`, `test_last_fill_pivot_persistence.ts`

---

## Documentation References

- **Documentation Index:** [docs/README.md](../docs/README.md)
- **Module Architecture:** [modules/README.md](../modules/README.md)
- **Copy-on-Write:** [COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md)
- **Fund Accounting:** [FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)
- **Logging:** [LOGGING.md](../docs/LOGGING.md)
- **Developer Guide:** [developer_guide.md](../docs/developer_guide.md)

---

**Note:** Interactive/diagnostic scripts (`connection_test.ts`, `diag_*`, `benchmark_cow.ts`, `sim_batching.ts`, `repro_phantom_orders.ts`) require network access or real state and are **not** run by `npm test` — the runner only globs `test_*.js`. Run these manually when debugging.

## Harnesses (not run by `npm test`)

Two files are investigative harnesses rather than assertions about production
code, so they are deliberately *not* `test_*.ts`:

- `recon_fuzz.ts` — the interleaving fuzzer for the reconciliation engine. Drives
  the real `SyncEngine` against a scripted chain (landed / vanished / partially
  filled / orphaned / duplicated / lagging / unparseable reads), asserts
  policy-free invariants after **every** event, and shrinks a failing sequence to
  a seed + step count.

  ```bash
  npm run build:tests
  node dist/tests/recon_fuzz.js                          # 40 scenarios × 25 steps
  RECON_FUZZ_SCENARIOS=120 RECON_FUZZ_STEPS=40 node dist/tests/recon_fuzz.js
  RECON_FUZZ_TRACE=1 RECON_FUZZ_DEBUG=1 node dist/tests/recon_fuzz.js
  ```

  `RECON_FUZZ_SEED=<n> RECON_FUZZ_STEPS=<n>` replays a reported failure. The run
  fails if the scenarios are vacuous (coverage floors on placed-slot
  observations and on un-adoptable orphans), so a green run means the engine was
  actually exercised.

- `sim_batching.ts` — arithmetic mirror of the gap-slot batch sizing rule.

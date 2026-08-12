# Changelog

All notable changes to this project will be documented in this file.

## [1.4.13] - 2026-08-12 - COW Broadcast Serialization, Start Canonicalization, BitShares Onboarding

### 2026-08-12

- **Docs**: add a BitShares onboarding tutorial for first-time users — `docs/BITSHARES_ONBOARDING.md` walks new users from zero through their first live bot: what BitShares is and how its markets work, creating and funding an account (gateway assets like `XBTSX.USDT` vs market-pegged assets like `HONEST.USD`/bitAssets), choosing the right key (active vs owner vs memo vs login — and why the **active** key is the one DEXBot2 needs), importing it with `dexbot key`, creating a bot config and activating the market adapter, running a dry run, going live, and troubleshooting the most common first-run mistakes (wrong key type, unresolved account name, missing signing key, background-runtime behavior, log locations, forgotten master password, Node < 22.12 / `ERR_REQUIRE_ESM`, undrivable `startPrice` for pairs without a pool/book, insufficient BTS fee balance); linked from the root README (new "First Run" section + docs index) and `docs/README.md` (`docs/BITSHARES_ONBOARDING.md`, `README.md`, `docs/README.md`).
- **Chore**: ship the whole `claw/` directory in the npm package instead of cherry-picking sub-paths — the `files` whitelist now includes `claw` as a unit (covering `claw/skills`, runtimes, and scripts like `memu_runner.py`) so a published install can never drop parts of the claw runtime (`package.json`).

### 2026-08-10

- **Fix**: serialize COW broadcasts with a single-flight guard — two overlapping COW batches planning from the same base grid version caused the second commit to be refused (base-version mismatch) → adopt-from-chain → snapshot reload that could drop a placed order and produce orphan fills. A `_cowBroadcastInFlight` flag is set atomically before the broadcast and cleared only by the frame that claimed the slot; two wait points (entry optimization + authoritative pre-broadcast check-and-set) plus per-frame `heldBroadcastSlot` ownership so a batch that early-returns never clears a concurrent batch's in-flight flag; the wait is capped at 120s and breaks on shutdown. `isDiscardedCreate` no longer depends on `opContexts` being present so the PENDING_BROADCASTS reject path can't re-CREATE a duplicate once the original broadcast lands (`modules/dexbot_class.ts`, `modules/dexbot_cow_runtime.ts`, `tests/test_cow_single_flight.ts`).
- **Fix**: close fill-lock bypasses — `syncOpenOrdersAndProcessFills` now self-guards (it mutates grid state and can broadcast a rebalance), serializing unlocked callers through `_fillProcessingLock` while callers already inside run directly; `runDustHealthCheck` defers (with a warning) instead of cancelling dust without the lock, so the dust is picked up by the next locked maintenance tick or fill batch (`modules/dexbot_maintenance_runtime.ts`, `tests/test_lock_bypass_guards.ts`).
- **Fix**: harden the AsyncLock no-ALS fallback — the `_holding`-based fallback treated every concurrent caller as re-entrant and ran it immediately, allowing overlapping critical sections. Now only a call made synchronously inside the holder's own callback prologue is re-entrant; everything else queues, preserving mutual exclusion (async-nested calls in the fallback wait on the held lock until the timeout — a bounded fail-safe stall, never concurrent execution). Added `acquireIfNotHeld(lock, fn)` as the canonical re-entrancy guard and used it at the COW reconcile and open-orders sync chokepoints, plus a `DEXBOT_DISABLE_ASYNC_LOCAL_STORAGE` escape hatch for testability (`modules/order/async_lock.ts`, `modules/dexbot_cow_runtime.ts`, `modules/dexbot_maintenance_runtime.ts`, `tests/test_async_lock_no_als_fallback.ts`).
- **Refactor**: trim redundant no-ALS AsyncLock guards and close ESM packaging gaps — removed the dead `_holding && _syncPrologue` conjuncts (`_syncPrologue` is only set where `_holding` is already true and `forceRelease` cannot run mid-prologue), bumped `engines` to `>=22.12.0` (the codebase calls `require()` on sibling ESM modules, which only works unflagged from Node 22.12+; on 22.0–22.11 those throws `ERR_REQUIRE_ESM` at boot), added a package `exports` map (`"."` main entry, `./dist/*` deep imports, `./package.json`), and classified 7 more Node-only launcher modules as `false` in the browser field (`modules/order/async_lock.ts`, `package.json`, `package-lock.json`).
- **Refactor**: promote `dexbot start` as the canonical launch command — the monolithic launcher was historically `dexbot unlock` with `start` only an alias; now `start` is primary and `unlock` is documented as the legacy alias. Updated CLI help, launcher success/enable hints, all user-facing `dexbot unlock` strings (update.ts, supervisor_control.ts, postinstall.js banner, claw_launcher.ts, credential-daemon.ts) and the docs (README, WORKFLOW, MPA_CREDIT_USAGE, DEXBOT_COMPARISON, docs/README); internal references (mode labels, npm scripts, entry points) unchanged (`dexbot.ts`, `unlock.ts`, `scripts/update.ts`, `modules/launcher/supervisor_control.ts`, `scripts/postinstall.js`, `claw/modules/claw_launcher.ts`, `credential-daemon.ts`, `tests/test_unlock_output.ts`, `tests/test_unlock_control_output.ts`, `tests/test_dexbot_startup_output.ts`).
- **Chore**: remove all residual TUI dashboard references from the default branch — the Rust dashboard was already isolated to `dashboard-draft-legacy`, but leftover signals (`.gitignore`/`.dockerignore` entries, `docs/DEXBOT_COMPARISON.md` comparison row and doc-index strikethroughs, an `analysis/analyze_risk_profile.ts` log string) were still confusing DeepWiki's auto-generated docs into emitting a stale "TUI Dashboard" page; CHANGELOG historical mentions intentionally left intact (`.gitignore`, `.dockerignore`, `docs/DEXBOT_COMPARISON.md`, `analysis/analyze_risk_profile.ts`).

## [1.4.12] - 2026-08-09 - Full ESM Migration, Legacy-Compat Removal, Node >= 22

### 2026-08-10

- **Fix**: repair ESM direct-run guards and editor tsconfig coverage for analysis tools — the CJS→ESM migration left analysis CLI entry points using `require.main`, which throws a `ReferenceError` under `"type": "module"`, and added `import.meta` usage to `analysis/` and `claw/examples/` files that no tsconfig project covered (editors inferred CommonJS and flagged `import.meta` as TS1343). `require.main === module` is replaced with the argv-independent `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href` guard in `analyze_derivatives`, `derivative_chart_generator`, `backtest_ama_sweep`, `generate_unified_comparison_chart`, `optimizer_high_resolution`, and `analyze_lambda_vs_slow`; `analyze_tradingview` (CLI-only, nothing imports it) now calls `main().catch(...)` directly so the tradingview chart exporter no longer crashes on run. Added `analysis/tsconfig.json` and `claw/examples/tsconfig.json` (loose ESM, noEmit) mirroring `tests/tsconfig.json` so those directories resolve as ESM in editors, and un-ignored `analysis/tsconfig.json` for tracking (`analysis/*`, `claw/examples/*`, `.gitignore`).

### 2026-08-09

- **Fix**: align claw build emit options with the root build to keep `dist` consistent — enable `declaration`/`declarationMap`/`sourceMap` in `claw/tsconfig.json` so a claw build after `npm run build` never leaves a hybrid dist (regenerated `.js` without sourceMappingURL footers while stale `.d.ts`/`.js.map` lingered); export `CredentialDaemonResponse` for claw's declaration emit (`claw/tsconfig.json`, `modules/dexbot_credential_client.ts`).
- **Refactor**: remove the deprecated `debtPolicy.lending[].ratio` alias in favor of `outputWeight` — `ratio` now fails validation loudly ("no longer supported; use outputWeight instead") instead of silently defaulting to weight 1, so old configs cannot change behavior unnoticed (`modules/types.ts`, `modules/bot_settings.ts`, `modules/credit_runtime.ts`).
- **Refactor**: drop legacy `market`/`orderbook` price-source aliases and unify book terminology — `normalizeMarketSource` now accepts only `pool`/`book` (an unknown token falls back to `pool` instead of being misnormalized to `book`); `usesOrderbookMarketSource` renamed to `usesBookMarketSource` (`market_adapter/utils/chain.ts`, `market_adapter/market_adapter.ts`, `market_adapter/core/market_adapter_service.ts`, `dexbot.ts`).
- **Fix**: resolve 80 typecheck errors in `tests/tsconfig.json` — the CJS-pinned test suite used ESM syntax in `tests/helpers/*` stubs and `test_sync_excess_orphan.ts`/`test_strategy_reaction_cap_fix.ts`, and 12 more files had type-shape mismatches (untyped mock accounts, missing manager stubs, stale `@ts-expect-error` directives, etc.) (`tests/helpers/*`, `tests/test_*.ts`).
- **Refactor**: remove legacy compatibility and migration code that no active deployment exercises — dropped the pre-1.1.0 `{ bots: {...} }` wrapper migration in `account_orders`, the `unlock-start` candidate runtime paths in `bot_supervisor`, the claw `unlock-start` mode alias, the redundant per-record vault version check, and the silent `0o644 → 0o600` chmod auto-fix (a non-0o600 security/policy file now fails closed with an explicit permission error) (`modules/account_orders.ts`, `modules/launcher/bot_supervisor.ts`, `claw/modules/*`, `modules/chain_keys.ts`).
- **Fix**: never throw `Cannot require() ES Module in a cycle` on boot for Node 22.14 — the ESM migration left a cycle of `require()`-based imports to sibling ESM modules routing through the storage binding; on the server's Node 22.14.0 this deadlocked at startup and aborted every entrypoint (CLI/bot/pm2/unlock), while newer Node 22 versions only emitted an experimental warning that masked the failure in CI. `dexbot_maintenance_runtime` now imports storage statically and instantiates it once, and `dexbot_cow_runtime`/`dexbot_fill_runtime`/`processed_fill_store` replace `createRequire()`-based top-level requires with static imports (lazy require accessors kept where test mocks need call-time resolution); the extensionless `scripts/{bots,dexbot,keys,pm2,unlock}` wrappers were rewritten as real ESM that `createRequire()`s the tsx fallback and await-imports the built dist entry (`modules/dexbot_maintenance_runtime.ts`, `modules/dexbot_cow_runtime.ts`, `modules/dexbot_fill_runtime.ts`, `modules/order/processed_fill_store.ts`, `scripts/*`).
- **Fix**: restore the `createRequire` binding in `dexbot_fill_runtime` after the ESM migration removed it while leaving three lazy `require()` accessors (`buildFillKey`, `correctAllPriceMismatches`, `retryPersistenceIfNeeded`) — every queued fill then threw `ReferenceError: require is not defined`, permanently stalling the fill consumer with retry-every-~3s backoff; the sibling COW/maintenance runtimes were unaffected because they kept their own binding (`modules/dexbot_fill_runtime.ts`).
- **Fix**: restore same-order fill batching to eliminate phantom residuals — a same-order multi-fill batch (e.g. partial fill plus the dust fill consuming the rest in the same block) recomputed every fill's transition against the same stale pre-batch baseline, and last-wins batch application left a phantom PARTIAL residual equal to the sum of earlier fills (triggering fund-invariant CRITICALs and, below the 1% tolerance, corrupting the next COW cycle). Phase 6 now groups batch fill contexts by grid slot and emits a single cumulative transition per order against the pre-batch baseline (fully consumed → real full fill/SPREAD placeholder; partial → exact remaining size), while phase 3 still accounts each fill individually; the "fill-batch-committed" flush now also persists the raw per-fill keys so earlier same-order fills (already credited) are not re-credited on crash recovery (`modules/order/sync_engine.ts`, `modules/dexbot_fill_runtime.ts`, `tests/test_sync_fill_history_batch.ts`).
- **Fix**: explicitly cancel residual dust left on chain after sub-dust fills — the chain only auto-culls a residual when its QUOTE-side value truncates to 0, so a residual of ≥ 1 base unit with non-zero quote value stays on the book forever once the slot is virtualized. `syncFromFillHistory` now verifies the order against the chain (reusing the drift-refetch result when present) and emits a `residualCancel` request; `cancelResidualOrders()` performs a best-effort cancel (tolerating "order does not exist") before post-fill grid maintenance so the residual cannot be re-adopted into a slot as a ghost grid order (`modules/order/sync_engine.ts`, `modules/dexbot_fill_runtime.ts`, `tests/test_ghost_order_fix.ts`, `tests/test_sync_fill_history_batch.ts`).
- **Fix**: quiet duplicate-orphan self-heal and dedupe its cancellation — duplicate-price-level orphans are standard designed self-healing (a fully filled order leaves a sub-dust residual that collides with the rotated replacement, and the sync/reconcile layer cancels it); they were logged as ERROR/WARN and processed twice (the sync-layer cancel-only correction plus a reconcile Phase-2 cancel on a stale snapshot). Reconcile Phase-1 now defers duplicates the sync layer already owns (queued as cancel-only or own-cancelled within the 5s TTL), restoring the untracked-fund release the correction's cancel-only path does not perform — so one orphan is cancelled exactly once with exactly one fund release, preserving `chainTotal = chainFree + chainCommitted`. Duplicate detection logs downgraded warn→info; the skip is limited to `cancelOnly` entries so price-update/type-mismatch corrections are unaffected (`modules/order/grid_reconcile.ts`, `modules/order/sync_engine.ts`, `tests/test_grid_reconcile_regressions.ts`).
- **Fix**: release untracked funds even when a duplicate-orphan cancel hits "order does not exist" — when the sync-layer correction already cancelled the orphan and the 5s own-cancel TTL lapsed before reconcile's Phase-2 ran, the ORDER_GONE throw skipped the `addToChainFree` block and stranded the capital, breaking the `chainTotal = chainFree + chainCommitted` invariant. `_cancelChainOrder` now treats a gone order as a successful cancel when `releaseUntrackedFunds` is set (gated so matched-order cancels keep their old throw-and-log behavior). Persistent duplicate orphans no longer loop silently at `info`: re-detection of the same orderId (cancel keeps failing or the order keeps getting re-created) escalates to a `warn` rate-limited by `TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS`, with the shared detection counter reused from the existing recent-orderId map budget and cleared on confirmed cancel (`modules/order/grid_reconcile_internal.ts`, `modules/order/utils/order.ts`, `modules/order/grid_reconcile.ts`, `modules/order/sync_engine.ts`, `tests/test_grid_reconcile_regressions.ts`, `tests/test_duplicate_orphan_escalation.ts`).
- **Test**: prevent the master-password prompt from blocking `test_stale_daemon_cleanup` — the test stubbed `chainKeys.authenticate` by mutating its `require()` binding's property, but `credential_daemon.ts` imports `chain_keys` via `import * as`, which under tsx's ESM transform resolves a separate namespace object so the mutation never reached the controller and the real `authenticate()` prompted for a password, blocking all remaining tests. Switched to require-cache stubbing via `setCachedModule` (same pattern as `test_credential_controller_cleanup.ts`), preserving the real daemon-readiness/reporting logic for the file-based assertions (`tests/test_stale_daemon_cleanup.ts`).

### 2026-08-08

- **Feat**: migrate the codebase to native ES modules — the root and `claw/` packages flip to `"type": "module"` and the compiled `dist/` bundle now runs under Node's native ESM loader on Node >= 22. Entry shims (`bot.js`, `dexbot.js`, `pm2.js`, `unlock.js`, `credential-daemon.js`, `scripts/update.js`) are rewritten as ESM with top-level `await import()` and a dist-first / tsx-fallback loader; `createRequire(import.meta.url)` shims are added wherever `require()` is still needed (config, storage, crypto, chain_orders, order utils, and more); `tests/` and `claw/tests/` are pinned to `"type": "commonjs"` so the CJS test files keep running under tsx; direct-run guards using `pathToFileURL(process.argv[1])` are made argv-independent in 12 files; claw `memu:status`/`check` npm scripts switch to `--input-type=module` + `await import()` (`package.json`, `claw/package.json`, `*.js` shims, `modules/*`, `market_adapter/*`, `claw/*`, `scripts/*`).
- **Refactor**: drop the `ws` optional dependency and require Node >= 22 native `globalThis.WebSocket` — the `ws` fallback for pre-Node-22 environments kept `node_modules` non-empty in dev and made the "zero runtime dependencies" claim depend on install state. `transport.ts` now throws a clear error if native WebSocket is missing; `package.json` engines bumped from `>=18` to `>=22`; `optionalDependencies.ws` removed and lockfile regenerated (`modules/bitshares-native/transport.ts`, `package.json`, `package-lock.json`, `docs/architecture.md`).
- **Refactor**: remove legacy credential daemon compatibility code — dropped the legacy `broadcast-operation` request handler (all clients send `execute-operations`), the unreachable `hmacResult.skipped` branches, the `allowedOpTypes` backward-compat fallback in the policy engine, the unused `isBroadcast` client option, and the legacy `masterPasswordHash` SHA-256 field from `keys.json` normalization/setup/save (`credential-daemon.ts`, `modules/credential_policy.ts`, `modules/dexbot_credential_client.ts`, `modules/chain_keys.ts`, `modules/types.ts`).
- **Refactor**: remove pre-1.4.0 compatibility shims and the one-time migration script — deleted `modules/utils/fs_utils.ts` (backward-compat re-export of the unified `StorageAdapter`) and migrated ~80 call sites to destructure `getStorage()` directly; deleted `scripts/migrate_bot_keys.ts` (v1.1.0 unique-bot-names migration) and removed its auto-run call sites from `dexbot.ts`, `bot.ts`, and `unlock.ts` (`modules/**`, `market_adapter/**`, `claw/**`, `analysis/**`, `scripts/**`, `tests/**`).
- **Refactor**: replace hardcoded module literals with `constants.ts` references — magic numbers across `account_bots`, `bitshares-native/{subscriptions,tx/builder,tx_cache}`, `chain_orders`, `credential_policy`, `credit_runtime`, `dexbot_fill_runtime`, `dexbot_maintenance_runtime`, `bot_supervisor`, `node_manager`, `order/export`, and `order/utils/system` now point at canonical values so runtime tuning stays single-sourced (`modules/constants.ts`, and the per-file call sites listed above).
- **Refactor**: prune dead constants, helpers, and a dead AsyncLock queue method from a dead-code audit — removed genuinely unused keys (`DUST_CANCEL_DELAY_SEC`, `SUMMED_RELATIVE_SQUARED_DIFFERENCE`, `LIMIT_ORDERS_BATCH`, `TAKER_INDICATOR`, `MAX_COMMIT_MS`, `MAX_MEMORY_MB`, `INDEX_REBUILD_THRESHOLD`, `GRID_MEMORY_CRITICAL`), restored `MAX_REBALANCE_PLANNING_MS`/`STATE_CHANGE_HISTORY_MAX` (still referenced via magic numbers) and bound their call sites, removed `formatRatio`/`formatMetric5`/`getPrecisionForSide`/`deductOrderFeesFromFunds`/`clearQueue`, and deleted `tests/test_dust_cancel_delay_config_migration.ts` (`modules/constants.ts`, `modules/order/async_lock.ts`, `modules/order/format.ts`, `modules/order/utils/math.ts`, `modules/order/accounting.ts`, `modules/order/logger.ts`).
- **Fix**: restore re-entrancy recursion guards broken by the dead-code audit — `syncFromOpenOrders` and `reconcileAfterUncertainBroadcast` are self-recursive wrappers and the `!isReentrant()` gate is required again (the `acquire()` re-entrant short-circuit alone caused infinite recursion / `RangeError` in 6 tests); `requestGridReset` keeps its re-entrant branch so the fill consumer defers fills (`modules/order/sync_engine.ts`, `modules/dexbot_cow_runtime.ts`, `modules/dexbot_maintenance_runtime.ts`).
- **Fix**: make the claw build green and stop stray `.js` emission — `claw/tsconfig.json` `rootDir "." → ".."` and `outDir "../dist/claw" → "../dist"` eliminates 75x TS6059 (files not under rootDir) and the in-place stray `.js` byproducts; remaining claw type errors fixed (`CredentialDaemonResponse` trx envelope, nullable `profileRoot`, `deploymentMode === null` guard, pool `reserves` shape, `derivePoolPrice` poolRef/options overload, `Uint8Array` buffer type, explicit `observedRatio` null check, new `plugin-entry.d.ts` shim) (`claw/tsconfig.json`, `claw/modules/*`, `claw/runtimes/openclaw-plugin/*`).

## [1.4.11] - 2026-08-07 - Minimum-Slots Grid Guard, Credential-Daemon Restart, CLI Alias Hardening

### 2026-08-07

- **Feat**: add a minimum-slots guard to grid range scaling — the existing asymmetry clamp (`1 - 1/D`) only prevented the tightened bound from crossing the grid center; it did not stop that side from collapsing into a near-center sliver holding few or no active orders. New `ASYMMETRIC_BOUNDS_MIN_SCALE_SLOTS` (default 10, `0` disables; overridable per bot/market) guarantees at least N `incrementPercent` steps remain between the grid center and the narrowed bound while the widened side still extends freely. `asymmetricBounds` is now merged per-field across the `globals` → `pairs[].marketAdapterSettings` → `pairs[].botOverrides.<bot>` layers so a bot-level `minScaleSlots` no longer wipes a market-level `maxAsymmetryFactor` (`modules/constants.ts`, `modules/order/grid.ts`, `market_adapter/market_adapter.ts`, `market_adapter/core/market_adapter_service.ts`, `tests/test_grid_logic.ts`).
- **Fix**: `dexbot start` (and `status`/`stop`/`restart`/`delete`) no longer spawn a hard-coded `dist/unlock.js` — they use `buildRuntimeScriptArgs`, which resolves the unlock entry point per runtime layout (`dist/unlock.js` compiled, `unlock.ts` via tsx in source mode). Previously the source-mode path resolved `modules/dist/unlock.js` (ENOENT → silent `process.exit(0)`), so `dexbot start` was a silent no-op; removed the now-unused `BUILD_DIR` constant (`dexbot.ts`).
- **Test**: retarget the CLI tests that validated the in-process one-shot flow to `dexbot test` — after the `start` alias change that flow is covered by the `test` command. `test_dexbot_start_master_password_failure_output.ts`, `test_dexbot_startup_output.ts`, and `test_dexbot_daemon_ready_output.ts` now invoke `test` (previously 282-second suite stall + spurious failures from spawning the real `dist/unlock.js` unlocked password prompts); add `test_dexbot_start_alias_unlock.ts` guarding the `start`→unlock delegation (entry point + exit-status forwarding).
- **Fix**: `dexbot status`/`stat` after `dexbot stop` no longer reports "No DEXBot2 processes running" while the credential daemon still runs — `stop` stops bots + market adapter by design but keeps the daemon up for fast re-unlock. `dexbot.ts` now treats a live daemon (via `monolithic-cred.pid`) as a running runtime and delegates to `unlock status`, which gained a branch rendering the daemon (PID/memory/alive/ready/socket) alongside a note that the monolithic runtime (bots + adapter) is stopped; shared `resolveCredentialDaemonForStatus`, `printCredentialDaemonStatusBlock`, and `printMarketAdapterStatusBlock` helpers (`dexbot.ts`, `unlock.ts`, `tests/test_unlock_status_cred_daemon_only.ts`).
- **Docs**: Telegram module implementation and aligned EVOLUTION entry (`docs/TELEGRAM_IMPLEMENTATION.md`, `docs/EVOLUTION.md`).

### 2026-08-06

- **Docs**: fix stale EVOLUTION release header and broken internal doc links; add Telegram bot to the planned EVOLUTION features.

### 2026-08-05

- **Feat**: `dexbot restart` (no target) also restarts the credential daemon with a password prompt before restarting bots (guarded by `!target` + TTY); targeted restarts unaffected. Root-cause fix: `isAlive()` in `process_discovery.ts` discarded `runtime.kill(pid, 0)`'s return value and always returned `true`, so the credential-daemon kill waited the full 5s SIGTERM timeout despite normal exit; it now returns the kill result, with D-state detection at every kill stage as a safety net. `process.exit(0)` closes out spawned `unlock.js` runs and the noisy stop-signal log line is removed (`modules/launcher/monolithic_runtime.ts`, `modules/process_discovery.ts`, `unlock.ts`, `scripts/update.ts`).
- **Fix**: alias `dexbot start` → `unlock` (persistent monolithic runtime) instead of `test` (one-shot), properly pairing it with `dexbot stop`; `dexbot test <bot>` still runs one-shot (`dexbot.ts`, `README.md`, `docs/WORKFLOW.md`).
- **Refactor**: prune dead COW/diagnostic methods and orphaned exports — removed 14 zero-reference `OrderManager` methods and helpers (stale pre-guard copies from the earlier COW rewrite, accountant extraction, and immediate dust-cancel rework), `logGridDiagnostics` and the dormant `grid.displayDiagnostics` flag, and `writeSkillFile`; tests call `validateWorkingGridFunds` directly instead of the removed wrapper (`modules/order/manager.ts`, `modules/order/logger.ts`, `modules/constants.ts`, `claw/modules/skill_utils.ts`, `docs/*`).
- **Docs**: expose `docs/GRID_RECONCILE.md` in the root README and docs index.

## [1.4.10] - 2026-08-04

### 2026-08-04

- **Fix**: re-place zeroed boundary slots on reconcile and run spread check independent of divergence — after a COW batch dies on a stale order, `recoverExplicitStaleOrders` zeroes the consumed slot; reconcile's `_pickVirtualSlotsToActivate` now re-derives a funded size for these zeroed boundary-adjacent slots so they become pickable again instead of being skipped (`modules/order/grid_reconcile_internal.ts`, `modules/dexbot_state_recovery.ts`).
- **Fix**: prevent duplicate slot planning and fabricated-boundary promotion in spread correction — the 1.4.10 `|| o.type === SPREAD` addition made `orphanedVirtualCandidates` overlap `typedSpreadCandidates`, planning an empty in-rail SPREAD slot twice (each order sized ~half, misreported plan counts, silent drops by the COW same-batch collision filter); `spreadCandidates` is now deduped by slot id, keeping the orphaned-priority occurrence. The boundary-promotion walk is gated on a known committed boundary (`boundaryKnown`) so a fabricated `?? 0` boundary can never be returned and committed by the COW pipeline; `countGapBandSpread` resolves indexes via `parseSlotIndex` with array-position fallback for an order-independent count (`modules/order/grid.ts`, `modules/order/grid_reconcile_internal.ts`, `modules/order/utils/order.ts`, `modules/order/utils/math.ts`, `modules/dexbot_cow_runtime.ts`).
- **Fix**: stop pool-share supply short-circuit returning 0, unblocking LP credit pricing — `getAssetCurrentSupply` hit the `toFiniteNumber(undefined, undefined)` default-param trap (returned 0, not null) when the static asset object carries no `current_supply` (that value lives in the dynamic asset data object); the `>= 0` guard then accepted 0 and `deriveLiquidityPoolTokenValue` bailed at `supply <= 0`, silently breaking the LP-collateral credit conversion-rate path with hourly "unable to resolve credit offer price" warnings. The direct-supply shortcut now applies only when `current_supply` is present, falling through to the `get_objects(dynamic_asset_data_id)` lookup that carries the real supply; `-1` sentinel keeps the type check while never passing the `>= 0` guard (`modules/order/utils/system.ts`, `modules/order/sync_engine.ts`).
- **Feat**: empty-slot normalization and spread boundary promotion — all size-0 VIRTUAL slots are stored as `ORDER_TYPES.SPREAD` (side-neutral) during `loadGrid`, eliminating stale BUY/SELL type misleads in candidate-selection code; `currentSpreadCount`/`initialSpreadCount` now count gap-band SPREAD occupancy only; slot-picking accepts SPREAD-typed in-rail slots and re-types them to concrete BUY/SELL before activation; when the funded rail is full during spread correction, contiguous gap-band empty slots are promoted and the new boundary flows through the COW pipeline (`modules/order/grid.ts`, `modules/order/grid_reconcile_internal.ts`, `modules/order/accounting.ts`, `modules/dexbot_cow_runtime.ts`).
- **Refactor**: `virtualizeOrder` → `convertToSpreadPlaceholder` replaces ad-hoc `{...virtualizeOrder(), size: 0}` patches at 6 call sites; new `resolveGapBand` helper centralises gap-band geometry computation previously duplicated across 3 files (`modules/order/utils/order.ts`, `modules/order/utils/math.ts`, `modules/order/grid.ts`, `modules/order/accounting.ts`, `modules/order/grid_reconcile_internal.ts`, `modules/order/strategy.ts`, `modules/order/sync_engine.ts`, `modules/dexbot_state_recovery.ts`).
- **Refactor**: extract shared `isEmptyGridSlot` predicate — centralizes the "is this slot an empty placeholder?" check that existed as two inline copies with subtly different conditions (`loadGrid` forced any size-0 VIRTUAL slot to SPREAD including `type: null`; `assignGridRoles` additionally required `slot.type !== null`, a load-bearing guard for grid creation); `opts.allowNullType` captures that one real difference and `liveSlot` lets role assignment check the resolved runtime slot. No behavioral change (`modules/order/utils/order.ts`, `modules/order/grid.ts`).
- **Refactor**: deduplicate repeated validation, broadcast, and process-utility code — jscpd clones cut 102 → 88 (837 dup lines, 6,390 tokens). Extracted `credential_policy.ts` deny helpers (`asDeny`/`denyNotInList`/`denyBoundExceeded`/`denyAssetRefMismatch`) replacing ~250 lines of near-identical policy blocks with exact reason/verb/matchOnly strings preserved; shared `processSweepOrphanFill` fill-sweep in fill/startup runtimes; `DaemonKeyStore` broadcast helpers; promoted `formatUptime` and `isPidAlive` delegating to `getProcessDiscovery().isAlive()`; relocated `parseSlotIndex`; deduped price-collision guards (`modules/credential_policy.ts`, `modules/dexbot_fill_runtime.ts`, `modules/dexbot_startup_runtime.ts`, `modules/key_store.ts`, `modules/process_discovery.ts`, `modules/launcher/*`, `modules/order/utils/order.ts`, `modules/order/grid_reconcile_internal.ts`).
- **Chore**: remove dead default exports and unreferenced types — deleted 68 zero-reference type definitions from `modules/types.ts` (kept all types referenced via runtime/type imports or JSDoc `import()` tags) and unused `export default` declarations in `broadcast_failure.ts`, `daemon_node_health.ts`, `node_failure_ledger.ts`, `socket_json_client.ts`; every removal cross-checked against the source tree since ts-prune's dynamic-require false positives make its output unreliable (`modules/types.ts`, `modules/broadcast_failure.ts`, `modules/daemon_node_health.ts`, `modules/node_failure_ledger.ts`, `modules/socket_json_client.ts`).
- **Test**: new `test_spread_boundary_promotion.ts` covers boundary promotion flow, COW boundary propagation, and regression tests for the duplicate in-rail SPREAD slot and null-boundary promotion block; new `test_spread_check_orchestration.ts` drives full `checkSpreadCondition` orchestration for empty-rail scenarios (mid-grid empty rail promotes, rail-edge empty rail requests `boundary-at-rail-edge` resync); updated `test_grid_bloat.ts`, `test_cow_boundary_slot_replacement.ts`, `test_rail_reanchor_fix.ts` for SPREAD placeholder invariants.

### 2026-08-03

- **Fix**: `dexbot unlock credit` now daemonizes to the background like `dexbot unlock` but runs only the credit-only bot — the previous credit path skipped the monolithic background daemon and stayed foreground; the credential daemon detaches to the monolithic log files the same way (`unlock.ts`).
- **Docs**: remove the `dexbot unlock credit` line from the root README command list and clarify the credit-only worker's behavior in the docs (README.md, docs/WORKFLOW.md, docs/MPA_CREDIT_USAGE.md, docs/README.md).
- **Perf**: cut test-suite runtime 95s → 45s — fixed a real grid-generation bug found along the way: `createOrderGrid` with `incrementPercent <= 0` slipped past validation (bounds read from undefined `config.incrementBounds`) and the geometric loop spun until Node threw "Invalid array length"; now falls back to canonical `INCREMENT_BOUNDS` and rejects `<= 0` up front (`modules/order/grid.ts`). Test runner (`scripts/run-tests.ts`) captures per-child output (live echo + timestamped `tests/tmp/test-run-*.log`), reports per-test elapsed + slowest-top-10, aggregates warn/error/deprecation diagnostics, continues past failures, and moved live-chain/diagnostic-only scripts to the live skip set so `npm test` counts only genuine offline tests. Per-suite cuts: test_autoderive 15.2s→0.24s, test_grid_logic 6.9s→0.31s, test_credit_runtime 6.3s→0.32s, test_chain_keys_vault 4.8s→0.30s, test_dexbot_maintenance_runtime_dynamic_weights 5.1s→0.15s, test_race_condition_fixes_batch1 2.4s→0.36s, and more. `bot_supervisor` gains a `staggerDelayMs` option (default `STAGGER_DELAY_MS` unchanged) and `chain_keys` a bounded `DEXBOT_VAULT_SCRYPT_N` env override so tests can lower scrypt cost (production N=2^17 preserved) (`modules/launcher/bot_supervisor.ts`, `modules/chain_keys.ts`, `scripts/run-tests.ts`).

## [1.4.9] - 2026-08-03 - LP-Collateral Credit Conversion Rate, Top-Level Unlock Control Aliases

### 2026-08-03

- **Fix**: `_resolveCreditConversionRate` could not price pool-share collateral — the offer's `acceptable_collateral` map only carries a direct base/quote price, and a liquidity pool token has no such pair against the debt asset, producing repeated "unable to resolve credit offer price ... no usable last known price" warnings and freezing the collateral group's budget. When the collateral asset has `for_liquidity_pool`, the rate is now derived via `deriveLiquidityPoolTokenValue` (prices both pool reserve assets against the debt asset), cached/persisted with source `pool-derived`, falling back to the existing cached/missing path so non-pool behavior is unchanged; mirrors the existing `_calculateCollateralValueInDebtAsset` pool-token handling (`modules/credit_runtime.ts`).
- **Test**: `testLpCollateralResolvesCreditConversionRate` covers debt against a pool-share collateral and asserts a positive pool-derived rate (`tests/test_credit_runtime.ts`).
- **Feat**: add `dexbot stop`, `dexbot restart`, and `dexbot delete` as top-level aliases for the `unlock stop|restart|delete` monolithic controls; the shared switch case spawns `dist/unlock.js` with the resolved command and forwards all remaining args (targets like `all` or a bot name pass through). New aliases `stp`/`stopall` → `stop` and `restartall` → `restart` (`dexbot.ts`).
- **Docs**: update README and unlock doc comment/runtime hints to the flat `dexbot stop|restart|delete` forms, removing the duplicated `dexbot unlock` / `dexbot stat` entries (`README.md`, `unlock.ts`).

## [1.4.8] - 2026-08-01 - Uncertain-Broadcast Duplicate-Order Safety, Truncated-Read Ambiguity, COW Stale-Plan Replan

### 2026-08-01

- **Fix**: credential daemon broadcast retries are now limited to provably-untransmitted failures (pre-send connection/frame errors only); RPC timeouts and connection drops with a response pending are classified uncertain and never re-signed — reported as a typed `BROADCAST_DEADLINE` so the bot's verify-before-retry machinery checks chain inclusion before re-broadcasting (`modules/broadcast_failure.ts`, `credential-daemon.ts`).
- **Fix**: daemon broadcast retries pinned per node with rotation + blacklisting — all attempts stay on one node until provably untransmitted, then the node is reported to a new shared failure ledger (`modules/daemon_node_health.ts`) that blacklists it after the threshold and removes it from the shared health cache so bot processes stop preferring it (`modules/node_failure_ledger.ts`).
- **Fix**: uncertain broadcasts are never blindly re-sent to fallback nodes — `BroadcastUncertainError` propagates and the COW runtime re-broadcasts only on authoritative absence (non-empty, non-truncated chain read with no CREATE match); empty/landed states defer to poll-confirmed reconciliation (`modules/dexbot_cow_runtime.ts`, `modules/dexbot_credential_client.ts`).
- **Fix**: direct-key and claw broadcast paths classified via the same failure rules — direct-key broadcasts surface `BroadcastUncertainError` instead of a blind error so verify-before-retry engages; the claw daemon client delegates to the hardened client with a 30s outer deadline covering the daemon's 25s inner window (`modules/chain_orders.ts`, `modules/key_store.ts`, `claw/modules/chain_broadcast.ts`, `claw/modules/dexbot_credential_client.ts`).
- **Fix**: truncated `get_full_accounts` reads are treated as ambiguous (not authoritative absence) in every absence decision — new `readOpenOrdersWithMeta` propagates the `more_data_available.limit_orders` truncation flag; cancel-verify, discard, adoption, dust-cancel refetch, recovery, and reconcile sites defer on empty/truncated snapshots instead of freeing slots/capital or clearing broadcast protection for possibly-live orders (`modules/chain_orders.ts` + ~10 call sites).
- **Fix**: COW pre-broadcast staleness guard — a master-grid change during planning (fills, syncs) refuses to broadcast the stale plan, re-plans once from fresh master using the same fills (`replanStaleBatch`), restores the boundary-shift budget, and clears only the abandoned batch's own pending-broadcast entries; still-stale plans proceed + structural resync, and commit-refused-after-broadcast adopts placed orders from chain (`modules/dexbot_cow_runtime.ts`, `modules/order/manager.ts`).
- **Fix**: exactly-once working-grid stack discipline — `_pushWorkingGridRef`/`_popWorkingGridRef`/`_releaseWorkingGridRef` (marker-guarded, identity-checked) replace unconditional pops so aborted/never-pushed results can no longer underflow or steal a nested grid's stack entry; `_commitWorkingGrid` releases the entry on every settle path (`modules/order/manager.ts`, `modules/dexbot_cow_runtime.ts`).
- **Fix**: COW stale-placement guard made slot-id based and boundary-only — compares rail slot indices against the plan's own target boundary (fill-based veto lines dropped, since burst fills sit beyond legitimate re-place levels); UPDATE rotations covered via `newGridId` (`modules/order/manager.ts`, `modules/order/utils/order.ts`).
- **Fix**: credential daemon load crash — `require('./modules/logger')` returned the ESM namespace (no `module.exports` fallback), crashing with `Logger is not a constructor` and breaking the unlock bootstrap handshake (60s timeout); daemon now requires the ESM default explicitly and the launcher races child exit against the readiness probe (`credential-daemon.ts`, `modules/launcher/credential_daemon.ts`).
- **Fix**: daemon broadcast deadline now starts at request receipt (before the serialize queue wait) and guards fire after connect/signing-client init, so a deadline-aborted zombie can no longer land after the bot was told the outcome was uncertain (`credential-daemon.ts`, `modules/bitshares-native/transport.ts`).
- **Fix**: recovery isolation — `_recoverySyncInFlight` raised for the whole structural-resync reload so a fill arriving mid-reload cannot start a batch that overlaps it; open-orders sync loop and lightweight sync skip while the recovery reload is in flight (`modules/dexbot_maintenance_runtime.ts`).
- **Fix**: uncertain price updates drop the correction entry — the next sync re-detects any remaining mismatch instead of re-applying the same delta from a possibly-lagging read (double-shrink protection) (`modules/order/utils/order.ts`).
- **Fix**: grid regeneration bumps `_gridVersion` so an in-flight COW plan can never commit over a regenerated (zero-slot) grid; on-chain slots never reassigned to SPREAD; SPREAD-typed fills resolve the real BUY/SELL side so `deriveTargetBoundary` shifts and illegal SPREAD+on-chain states are impossible (`modules/order/grid.ts`, `modules/order/sync_engine.ts`).
- **Feat**: add reverse `dexbot enable` CLI command mirroring `disable` semantics (`<bot>` or `all`, unknown-bot error, already-active notice); both unified into `setBotActiveState` (`dexbot.ts`).
- **Refactor**: deduplicate node-health, socket, and chain-read logic — shared failure ledger, shared newline-JSON socket client, `readOpenOrdersWithMetaSafe` wrapper, unified CLI enable/disable (`modules/node_failure_ledger.ts`, `modules/socket_json_client.ts`, `modules/chain_orders.ts`, `dexbot.ts`).
- **Refactor**: split working-grid stack and COW guard paths into named steps — manager owns the push/pop contract, replan branch becomes `replanStaleBatch`, stale-placement veto extracted to `stalePlacementDropReason`, pre-retry verification split into per-op-kind verifiers (`modules/dexbot_cow_runtime.ts`, `modules/order/manager.ts`).
- **Tests**: new/expanded suites for uncertain-broadcast verify-before-retry (UNC-013h–l), broadcast failure classification, daemon node health blacklist/rotation, COW stale-slot guard, COW guard replan, credential daemon load, sync fill history batch, truncated-read deferral regressions.
- **Fix**: open-orders watchdog sync loop defers on truncated reads (was the last unguarded sync path); `syncOpenOrdersAndProcessFills` returns the post-fill re-read snapshot so targeted-sync `reconcileGridOrders` sees fresh chain state (`modules/dexbot_maintenance_runtime.ts`).
- **Refactor**: shared helpers replace inlined duplicates — `resolveSpreadOrderSide` (SPREAD side convention, 5 sites), `chainOrderMatchesSlot` (adoption tolerance matcher, 2 sites), `readOpenOrdersGuarded` (truncated/empty-read deferral, 14 sites) (`modules/chain_orders.ts`, `modules/order/utils/order.ts`, `modules/order/sync_engine.ts`, `modules/order/accounting.ts`, `modules/order/manager.ts`, `modules/order/grid_reconcile.ts`, `modules/order/grid_reconcile_internal.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/dexbot_startup_runtime.ts`, `modules/dexbot_state_recovery.ts`).
- **Test**: open-orders sync loop test mocks `readOpenOrdersWithMeta` and adds a truncated-read deferral phase; `resetFunds()` awaited at 13 test call sites to match the async contract (`tests/test_main_loop_sync_fill_rebalance.ts` + 11 test files).
- **Fix**: all remaining fallback/reset sync paths defer on truncated reads — post-reconnect safety-net, post-reset fallback, bootstrap fallback, open-orders-mode fill sync, full grid reload, trigger-file resync (trigger retained), and missing-CREATE-result recovery; absence on a partial `get_full_accounts` window would virtualize live ACTIVE slots and re-create duplicates (`modules/dexbot_cow_runtime.ts`, `modules/dexbot_fill_runtime.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/dexbot_startup_runtime.ts`, `modules/dexbot_state_recovery.ts`).
- **Test**: UNC-016e — `_recoverFromPersistedGrid` defers on a truncated read and never syncs from a partial snapshot (`tests/test_uncertain_broadcast.ts`).
- **Fix**: pinned `poolRef` price derivation now orients reserves to the bot's pair (B/A) — full-pair-reversed pools no longer return inverted prices, and partial-match pools (only one bot asset in the pinned pool) are oriented via the unmatched pool asset as the proxy; pins sharing no asset keep intrinsic proxy behavior (`modules/order/utils/withPoolRef.ts`).
- **Fix**: bot editor (`node dexbot bots`) no longer strips custom overrides on save — `promptBotData` returns the full normalized draft instead of a fixed field whitelist, so `logging`, `timing`, `feeParams`, `gridLimits`, `poolRef`, etc. survive editing a bot (`modules/account_bots.ts`).
- **Fix**: `askPoolRef` can clear a pinned pool via `none`/`clear`/`off`/`no`; blank input still preserves the current value, and `0` remains a valid pool ID (`modules/account_bots.ts`).
- **Tests**: poolRef orientation suites for full-pair-reversed and partial-match pins; reversed-proxy expectation corrected to the oriented value (`tests/test_pool_ref_price.ts`).

### 2026-08-02

- **Fix**: fills are now treated as authoritative — the transient `isGhost` "blocked CREATE" flag and ghost-order preservation (keeping `orderId` as a size-0 PARTIAL after a sub-dust other-side fill) are removed; such fills become regular full fills (`convertToSpreadPlaceholder`, `orderId` cleared) so rotation immediately plans the replacement instead of stalling the COW create pipeline (`modules/order/sync_engine.ts`, `modules/order/utils/order.ts`, `modules/dexbot_cow_runtime.ts`, `modules/order/grid_reconcile.ts`; removed `tests/test_isghost_leak_fix.ts`).
- **Fix**: keep the sell rail anchored to the boundary after a crawl-up — the active window excludes slots outside the boundary geometry, so stray gap-band sells become surplus and reconcile rotates them back onto the rail instead of leaving them parked inside the spread gap (`modules/order/strategy.ts`, `modules/order/grid_reconcile_internal.ts`, `tests/test_rail_reanchor_fix.ts`).
- **Fix**: wire the previously-dead unmatched-orphan auto-cancel into idle maintenance — runs only when targeted-drift reconcile finds nothing to adopt, cancels only `price-drift-orphan` orders, honors the pending-broadcast guard and per-cycle cap, unblocking the CREATE pipeline reconcile cannot service (`modules/dexbot_maintenance_runtime.ts`).
- **Fix**: suppress spurious fund-invariant CRITICAL during rapid multi-fill batches — new `_fillBatchInFlight` depth counter defers `_verifyFundInvariants` past the half-accounted window (fresh refresh vs. still-committed grid orders) and re-anchors account totals after accounting + grid mutation (`modules/order/manager.ts`, `modules/order/accounting.ts`, `modules/order/sync_engine.ts`).
- **Fix**: stale `accountTotals` fill gate — fill paths refresh the snapshot once up front and defer (`deferred:true`, replay-safe re-read next cycle) instead of committing against stale totals; busy wall-clock stays unaccounted only by design (`modules/order/manager.ts`, `modules/order/sync_engine.ts`, `modules/dexbot_fill_runtime.ts`).
- **Fix**: root-cause reconcile, phantom-cleanup, and stale-accounting guards — removed the per-attempt wall-clock that orphaned mid-batch creates, made phantom cleanup defer freshly-assigned `orderId`s invisible to a lagging read, and sharpened stale-accounting gates (`modules/order/grid.ts`, `modules/order/grid_reconcile.ts`, `modules/order/manager.ts`).
- **Fix**: clear scripts now include rotated logs (`*.log.1`, `*.log.2`) and `dexbot enable`/`disable` output no longer shows legacy PM2 hints (`scripts/clear-all.sh`, `scripts/clear-logs.sh`, `dexbot.ts`, `b9ddeced`).

## [1.4.7] - 2026-07-30 - Fund Accounting Race Hardening, Phantom-Order Startup Fix, Create-Cancel Loop Fix

### 2026-07-30

- **Fix**: verification snapshot captures `actualBuy`/`actualSell` at snapshot time under `_fundLock`; passes them to `_verifyFundInvariants` instead of reading `mgr.accountTotals` live outside the lock, closing the TOCTOU window between snapshot and verification (`modules/order/accounting.ts`).
- **Fix**: `adjustTotalBalance` now acquires `_fundLock` internally, protecting `mgr.accountTotals` mutations from concurrent `recalculateFunds` reads across all callers; extracted `_adjustTotalBalanceLocked` sync helper so `recordFillBalances` (which already holds `_fundLock`) avoids 2 redundant nested acquires (`modules/order/accounting.ts`, `modules/dexbot_maintenance_runtime.ts`).
- **Fix**: remove sub-minimum remnant orphan check in `_computeFillTransitionResult` — a fill leaving a sub-minimum remnant cleared the local slot while leaving the chain order alive as an untracked orphan; removal lets the existing ghost path preserve `orderId` as PARTIAL for proper COW clean-up (`modules/order/sync_engine.ts`, `tests/test_ghost_order_fix.ts`).
- **Fix**: prevent fund inflation on startup phantom-order cleanup — `_applyOrderUpdate` during reconciliation's phantom sanitization was missing `{ skipAccounting: true }`, causing ACTIVE→VIRTUAL transitions to inflate ChainFree by the phantom order's size each restart (`modules/order/grid_reconcile.ts`).
- **Fix**: create-cancel loop in Phase 3 grid reconciliation — Phase 2 now returns a `Set<string>` of created chain order IDs; batch path captures all IDs before `_applySync` (Phase A/B split); single-create path propagates ID even when `_applySync` throws; recovery sync fallback added (`modules/order/grid_reconcile.ts`, `modules/order/grid_reconcile_internal.ts`).
- **Fix**: negative free balance ordering — MANUAL-queue balance adjustments before IMMEDIATE flush with rollback on flush failure, enforcing invariant: dedup key persisted ⇔ balance adjustments applied; `accountTotalsStale` flag triggers fresh chain-balance fetch when `_updateOrder` fails (`modules/order/accounting.ts`, `modules/order/sync_engine.ts`).
- **Fix**: ghost order detection — explicit `isGhost: true` flag added; existing size≤0 && state===PARTIAL heuristic retained as fallback (`modules/order/sync_engine.ts`).
- **Chore**: declare `accountTotalsStale` field in manager class to satisfy strict field convention (`modules/order/manager.ts`).
- **Docs**: add `GRID_RECONCILE.md` — 3-phase startup reconciliation design doc covering Phase 1 (pure in-memory under `_gridLock`), Phase 2 (blockchain I/O outside lock), Phase 3 (stale surplus cleanup), edge cases, lock hierarchy reference, and cross-references to 10+ existing docs (`docs/GRID_RECONCILE.md`).

## [1.4.6] - 2026-07-29 - AsyncLock Nested Re-Entrancy Fix, Grid Type Reassignment

### 2026-07-30

- **Refactor**: lock hierarchy correction — swapped `_syncLock`/`_gridLock` levels (sync: 2, grid: 3) so both fill and reconcile paths acquire in ascending order; eliminated `gridLockAlreadyHeld: true` from 8 call sites and `syncFromOpenOrders`/`synchronizeWithChain` guards; restructured `grid_reconcile.ts` Phase 1 to pure in-memory planning under `_gridLock` with Phase 2 executing all blockchain I/O outside the lock; removed redundant outer `_gridLock` from Phase 3 surplus cancel loop ([design doc](docs/GRID_RECONCILE.md)).
- **Fix**: cross-chunk boundary shift cap — `deriveTargetBoundary` now computes a net shift and caps it at half the active window per `_processFillsWithBatching` call; a cross-chunk budget prevents cumulative overreaction from burst fills (e.g. 200 accumulated fills after reconnect no longer swing the boundary 200 slots). Budget is set inside the `try` block and cleaned up in `finally` to prevent stale-state leaks (`modules/dexbot_class.ts`, `modules/order/utils/order.ts`).
- **Refactor**: extract cross-chunk budget from `config._boundaryShiftBudget` to `manager._boundaryShiftBudget` — passed as explicit parameter to `deriveTargetBoundary` which returns `{ boundaryIdx, remainingBudget }` instead of mutating config. Eliminates the config-as-runtime-state code smell (`modules/dexbot_class.ts`, `modules/order/strategy.ts`, `modules/order/utils/order.ts`).
- **Docs**: document `loadGrid` side effects — type reassignment, `_gapSlots` mutation, phantom order sanitization (`modules/order/grid.ts`).
- **Test**: fix stale `loadGrid` slot type reassignment assertion — slot-3 (ACTIVE on-chain) is now corrected to BUY by position; test expectation updated to match new behavior (`tests/test_grid_bloat.ts`).

### 2026-07-29

- **Fix**: AsyncLock nested re-entrancy — ALS store changed from single symbol to `Set<symbol>` so outer lock identity is preserved across nested acquisitions; prevents self-deadlock when `lockA` is held and `lockB` is acquired inside it (`modules/order/async_lock.ts`).
- **Fix**: reassign slot types on grid load — all persisted slots are relabeled to match the current boundary + gapSlots on resume, preventing stale SPREAD/BUY/SELL types from causing ILLEGAL_SPREAD_STATE validation errors (`modules/order/grid.ts`, `modules/order/grid_reconcile.ts`, `modules/dexbot_startup_runtime.ts`).
- **Test**: add nested multi-lock re-entrancy tests (A-in-B and A→B→C) to force-release test suite (`tests/test_async_lock_force_release.ts`).
- **Fix**: replace single-value state fields with refcounts/stack for nesting safety — FileLock rewritten to use AsyncLock (was not re-entrant, deadlocked on nested call); `_bootstrapping` and `_broadcastingFlag` changed from `boolean` to refcount; `_currentWorkingGrid` changed from single ref to stack (`modules/bots_file_lock.ts`, `modules/order/manager.ts`).
- **Fix**: harden 4 additional state fields — `_batchInFlight`, `_recoverySyncInFlight`, `_blockchainFetchInFlight`, `_structuralGridResyncRunning` changed from `boolean` to number refcount; `_rebalanceState` made stack-aware in `_clearWorkingGridRef` and `_resetRebalanceStateToDepth`; unconditional NORMAL resets replaced with depth-aware calls in COW runtime (`modules/dexbot_class.ts`, `modules/dexbot_cow_runtime.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/dexbot_state_recovery.ts`, `modules/order/manager.ts`).
- **Fix**: lock hierarchy ABBA deadlock — `syncFromOpenOrders` with `gridLockAlreadyHeld` now skips `_syncLock` entirely instead of queuing behind a concurrent `_syncLock` holder while holding `_gridLock`; `_doSyncFromOpenOrders` is called directly (in-memory only, no RPC) (`modules/order/sync_engine.ts`). *(Superseded 2026-07-30 by full lock hierarchy correction: levels swapped, flag eliminated.)*
- **Fix**: lock hierarchy documentation — corrected Level 0/1 labeling: `_fillProcessingLock` is outermost (Level 0), `_divergenceLock` is Level 1, matching all code paths; updated `manager.ts`, `dexbot_class.ts`, `sync_engine.ts`, `developer_guide.md`, `DEXBOT_COMPARISON.md`.
- **Test**: add ABBA deadlock regression test (RC-1B) using real `SyncEngine.syncFromOpenOrders` with concurrent `_syncLock` holder (`tests/test_race_condition_fixes_batch1.ts`).
- **Fix**: stale fund snapshot in COW plan — `getChainFundsSnapshot()` now computes committed amounts directly from the orders map instead of reading `funds.committed.chain` which went stale inside nested `pauseFundRecalc` regions, preventing double-counting of virtualized order capital (`modules/order/manager.ts`).
- **Fix**: gap slot drift on rebalance — persisted `manager._gapSlots` from grid creation; all rebalance paths read stored value instead of recalculating from live config, preventing boundary/role mismatches when `targetSpreadPercent` or `gridLimits` change mid-cycle (`modules/order/grid.ts`, `modules/order/strategy.ts`, `modules/order/manager.ts`, `modules/order/utils/system.ts`).
- **Fix**: phantom order fund inflation — skip capital commitment accounting when auto-correcting phantom orders (ACTIVE/PARTIAL with no `orderId` → VIRTUAL), preventing `addToChainFree` from inflating `accountTotals` with funds never committed on-chain (`modules/order/manager.ts`).

## [1.4.5] - 2026-07-29 - Code-Review Hardening: Lock Safety, Error Handling, Structural Integrity

### 2026-07-29

- **Fix**: AsyncLock forceRelease concurrent execution — defer `_locked=false` via `_orphaned` flag when a callback is executing; prevent new acquirers from entering while stale callback is still running; lock stays held until stale callback settles (`modules/order/async_lock.ts`).
- **Fix**: applyGridUpdateBatch continues after fatal error — break loop on first false from `_applyOrderUpdate` (ILLEGAL_SPREAD_STATE) to prevent compounding an inconsistent grid (`modules/order/grid.ts`).
- **Fix**: persistGrid discards write failure — check `persistGridSnapshot` return; preserve dirty flag on failure so `flushGridDirty` does not clear it (`modules/order/grid_reconcile_internal.ts`).
- **Fix**: _createOrderFromGrid unsynchronized _applyOrderUpdate — wrap zero-slot transition in `_gridLock.acquire()` (`modules/order/manager.ts`).
- **Fix**: _executeStartupUpdateBatch partial finalization — per-entry try/catch; stop on first finalization failure; remaining entries skipped for next full sync (`modules/order/grid_reconcile_internal.ts`).
- **Fix**: _commitWorkingGrid returns true on recalc failure — re-throw `recalculateFunds` error so callers know commit is incomplete (`modules/order/manager.ts`).
- **Fix**: checkSpreadCondition swallows all errors — log at error level instead of warn; track `lastFailureAt` in recovery state for monitoring; removed magic counter that could crash startup (`modules/order/manager.ts`).
- **Fix**: stale lastPrice in TOCTOU re-plan path — refresh `lastPrice` from current grid state inside re-plan block to prevent stale data from biasing `determineOrderSideByFunds` (`modules/order/manager.ts`).
- **Fix**: remove re-entrancy landmine — removed `_gridLock` re-acquire from TOCTOU re-plan path (pure computations, no lock needed); added early-return guard for absent lock (`modules/order/grid.ts`).
- **Fix**: break circular dependency via inline `require` — `calculateGapSlots` uses `MathUtils` instead of `require('../grid')`; `updateGridFromBlockchainSnapshot` passes `applyGridDivergenceCorrections` as 5th parameter (`modules/order/utils/system.ts`).
- **Fix**: uncommitted boundary for slot classification — `getSlotCorrectType` uses `manager.boundaryIdx` (committed value) instead of `syncBoundaryToFunds` speculative result; prevents classification against a boundary never persisted (`modules/order/grid.ts`).
- **Fix**: remove dead `calculateGeometricSizeForSpreadCorrection` — no call sites; updated JSDoc TOC (`modules/order/grid.ts`).
- **Fix**: replace stale FIX comments with implemented patterns — lock guard and blockchain-outside-lock pattern already in place (`modules/order/grid.ts`).
- **Test**: update `test_async_lock_force_release.ts` for new forceRelease semantics (`tests/test_async_lock_force_release.ts`).
- **Test**: add `accountOrders` mock to `test_grid_dirty_flag_persistence.ts` for real persist path coverage (`tests/test_grid_dirty_flag_persistence.ts`).
- **Test**: update 4 test files + 4 mock stubs for 5-arg `updateGridFromBlockchainSnapshot` signature (`tests/test_cow_divergence_correction.ts`, `tests/test_dexbot_maintenance_runtime_dynamic_weights.ts`, `tests/test_maintenance_runtime_market_adapter_watchdog.ts`, `tests/test_fallback_cow_types_and_spread_crosser.ts`, `tests/test_unanchored_spread_correction.ts`).

## [1.4.4] - 2026-07-29 - COW Invariant Enforcement, Grid Engine Consolidation

### 2026-07-29

- **Fix**: remove COW-invariant violating master patching — `applyGridDivergenceCorrections` now returns `{ committed, boundaryChanged }` instead of patching master directly. Caller schedules `setTimeout(0)` retry on failed boundary-shift commit, keeping master stale but consistent. Removed `_applyFallbackCowTypes` and both call sites. `prepareSpreadCorrectionOrders` uses local `bIdx` instead of writing `manager.boundaryIdx` directly. `computeSideIdeals` reads slot counts from `calculatedSnap` instead of re-reading `manager.orders` under lock (`modules/order/utils/system.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/order/grid.ts`).
- **Fix**: COW pipeline code review fixes — 7 issues: added `_restoreBoundary` relaxed setter to eliminate startup `[COW]` warning noise; JSDoc for lazy cache getters/setters; forensic `createCount < totalOps` log in uncertain-broadcast handler; comment explaining `outOfSpread` non-reset in divergence corrections; test fix for grid bloat mock (`modules/dexbot_cow_runtime.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/order/manager.ts`, `modules/order/grid.ts`, `modules/order/utils/system.ts`).
- **Refactor**: consolidate grid engine — `getBtsSide` utility replaces 8 identical ternaries; precision functions delegate to unified `getPrecision()`; `computeBtsFeeImpact` extracted as shared BTS deficit helper for accounting and sizing paths; `getSellStartIdx` replaces 4 instances of `boundaryIdx + gapSlots + 1`; dust thresholds use named `GRID_LIMITS` constants; exported ESM consistency across 5 modules; removed dead `validateIndices`/`assertIndexConsistency`/`_repairIndices` from manager; extracted `assertOrdersStructurallySound` for tests (`modules/order/accounting.ts`, `modules/order/grid.ts`, `modules/order/grid_reconcile.ts`, `modules/order/manager.ts`, `modules/order/utils/math.ts`, `modules/order/utils/order.ts`, `modules/order/utils/validate.ts`, `modules/order/strategy.ts`, `modules/order/sync_engine.ts`).
- **Test**: replace `testFallbackCowTypes` with `testFailedCommitSignalsRetry` — asserts master NOT patched and correct return signal instead of post-patch state (`tests/test_fallback_cow_types_and_spread_crosser.ts`).
- **Test**: test cleanup — removed stale `_repairIndices` references from COW mutation detection allowlists and console output in 3 test files; converted `test_sync_excess_orphan.ts` and `test_strategy_reaction_cap_fix.ts` from mixed/require to all-ESM (`tests/test_cow_index_mutation_detection.ts`, `tests/test_cow_set_mutation_report.ts`, `tests/test_cow_static_analysis.ts`, `tests/test_sync_excess_orphan.ts`, `tests/test_strategy_reaction_cap_fix.ts`).

## [1.4.3] - 2026-07-29 - Boundary-Shift Preservation, Tolerance Violation Filter, PoolRef Price Derivation

### 2026-07-29

- **Fix**: preserve grid boundary-shift state across failed COW commits — new `_applyFallbackCowTypes` helper applies slot types + `_ordersByType` + `boundaryIdx` to master from the working grid on `!executed` and `catch` paths without touching sizes or orderIds. Prevents downstream code (`syncBoundaryToFunds` in `prepareSpreadCorrectionOrders`) from seeing stale pre-shift types, which produced wrong clamp bounds and missed spread-correction candidates (`modules/order/utils/system.ts`).
- **Fix**: SPREAD→BUY crosser handling — `applyGridDivergenceCorrections` Phase 2 now filters on-chain orders by **working grid type** (not master type), so a SPREAD→BUY crosser is correctly attributed to the BUY side instead of appearing as a "hole" that triggers a spurious CREATE. `updateGridFromBlockchainSnapshot` runs `assignGridRoles` **before** `_recalculateGridOrderSizesFromBlockchain` so the size math sees corrected slot types. `_recalculateGridOrderSizesFromBlockchain` reads types from the working grid when available, including boundary-crossing slots in the correct side's budget. `assignGridRoles` passes `{ assignOnChain: true }` so on-chain slots are reassigned during boundary shifts (`modules/order/grid.ts`, `modules/order/utils/system.ts`).
- **Fix**: edge-partial filter in `prepareSpreadCorrectionOrders` uses `getSlotCorrectType(o) === railType` instead of `o.type === railType`, matching the pattern already used by the spread/orphaned candidate pools (`modules/order/grid.ts`).
- **Fix**: prevent grid-edge gaps from per-batch abort — tolerance-based violations (`price_collision`, `chain_orphan_collision`, `same_batch_price_collision`) now filter only the violating CREATEs from the action list instead of aborting the entire batch. Hard `slot_occupied` violations still abort. `validateCreateTargetSlots` returns `violatingTargetIds` (`Set<string>`) for per-CREATE filtering (`modules/dexbot_cow_runtime.ts`, `modules/order/utils/validate.ts`).
- **Fix**: precision-0 tolerance overflow — `findPriceCollision` and `validateCreateTargetSlots` same-batch check compute tolerance for **both** entries' types and take `Math.min(tolTarget, tolItem)`. Prevents asymmetry false positives where `MIN_ORDER_SIZE_FACTOR=50` floor produces tolerance exceeding the grid increment (`modules/order/utils/math.ts`, `modules/order/utils/validate.ts`).
- **Fix**: use `pool.asset_a`/`pool.asset_b` for balance mapping in `withPoolRef` — resolves price inversion and wrong-precision bugs when bot assets are ordered differently from the pool's numeric ID ordering (`modules/order/utils/withPoolRef.ts`, thanks @usefuljohn).
- **Feat**: add `poolRef` for pinned pool price derivation — `withPoolRef(BitShares, poolRef)` returns a `PoolPriceOverrides` object that fetches the pinned pool directly via `get_objects`. `derivePriceWithPoolRef` integrates into the existing derivePrice chain. Interactive editor (`askPoolRef`) stores full `1.19.X` form (`modules/order/utils/withPoolRef.ts`, `modules/account_bots.ts`, `modules/order/grid.ts`, `modules/types.ts`).
- **Feat**: extract `withTimeout` utility — shared `withTimeout()` in `modules/order/utils/timeout.ts` replaces inline `Promise.race+setTimeout` across 7 call sites. Breaks circular dependency (`order/logger.ts → system.ts → order.ts → logger.ts → order/logger.ts`). No hardcoded timeout values remain at any call site (`modules/order/utils/timeout.ts`, `modules/order/logger.ts`, `modules/order/manager.ts`, `modules/launcher/credential_daemon.ts`, `modules/launcher/market_adapter_runtime.ts`, `modules/launcher/market_adapter_watchdog.ts`, `unlock.ts`, `modules/order/utils/system.ts`).
- **Chore**: update manifest versions to 1.4.3 across all package.json, lockfiles, plugin manifests, docs references (`package.json`, `package-lock.json`, `claw/package.json`, `claw/runtimes/openclaw-plugin/*.json`, `analysis/ama_fitting/package.json`, `claw/tests/test_claw_mcp_transport.ts`, `docs/README.md`, `docs/DEXBOT_COMPARISON.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`, `docs/EVOLUTION.md`).
- **Test**: new `test_fallback_cow_types_and_spread_crosser.ts` — 2 tests covering fallback type-only commit after failure (boundary, types, indexes, orderIds) and SPREAD→BUY crosser correctly attributed (no spurious CREATE) (`tests/test_fallback_cow_types_and_spread_crosser.ts`).
- **Test**: COW-COMMIT-011 — batch with tolerance-violating CREATEs verifies per-CREATE filtering leaves valid actions intact (`tests/test_cow_commit_guards.ts`).
- **Test**: `test_pool_ref_price.ts` — unit tests for `withPoolRef` and `derivePriceWithPoolRef` (`tests/test_pool_ref_price.ts`).
- **Test**: `test_with_timeout.ts` — updated import path to `./timeout` (`tests/test_with_timeout.ts`).

## [1.4.2] - 2026-07-28 - Spread Correction Direction Bias Removal, Precision-Based Collision Guard, Stale-Node Defense Completion

### 2026-07-28

- **Fix**: remove direction bias from spread correction — `determineOrderSideByFunds` simplified to pure fund-based selection (no longer pins side=SELL when marketPrice < centerPrice, eliminating permanent starvation when the preferred side has no correctable slots). `checkSpreadCondition` gets a starvation fallback: retries the opposite side when `prepareSpreadCorrectionOrders` returns zero candidates before aborting. `prepareSpreadCorrectionOrders` now calls `syncBoundaryToFunds` under grid lock before computing `getSlotCorrectType`, preventing stale boundary-based misclassification of SPREAD candidates. Eliminates 5 complexity items — direction switch, `hasDirection` guard, `_lastGridPricingContext` read, config.startPrice center fallback, and startup edge case (`modules/order/grid.ts`).
- **Fix**: replace hardcoded 1e-8 tolerance with precision-based `calculatePriceTolerance` in `validateCreateTargetSlots` same-batch duplicate check — near-miss duplicates within the asset precision window now caught consistently with the rest of the collision-detection pipeline (`modules/order/utils/validate.ts`).
- **Fix**: complete stale-node defense rollout — `_initializeAssets` call sites (grid.ts:543, 670, 997) wrapped in `withBlockchainRetry` for 30s timeout / 3-retry / node-failover. `finishBootstrap()` moved into work's own `finally` block so it only fires when reconciliation completes, not when `Promise.race` settles. Added `_resyncAborted` flag checked at 9 await boundaries inside reconciliation work, preventing `resetFunds`/`persistGrid`/`initializeGrid`/`reconcileGridOrders` from mutating manager state after the caller's error path started recovery. Fixed `require()` consistency — both per-attempt and final failover paths now use optional chaining on `getNodeManager?.()` to handle the circular dependency (`modules/order/grid.ts`, `modules/order/utils/system.ts`).

## [1.4.1] - 2026-07-28 - Bot-Hang Prevention, Blockchain Retry Centralization, CREATE Guard Extension

### 2026-07-28

- **Fix**: prevent bot hangs via centralized timeout + node failover — after exhausting 3-attempt retry budget, `withBlockchainRetry` force-blacklists the stuck node and reconnects to a healthy one. All blockchain ops (fetchAccountTotals, readOpenOrders, syncFromOpenOrders, reconcileGridOrders) get automatic failover. Default `_fillProcessingLock` acquisition timeout (20s) prevents indefinite waits. `recalculateGrid` wrapped in 10-minute `Promise.race` ceiling (`modules/order/utils/system.ts`, `modules/order/manager.ts`, `modules/order/grid.ts`).
- **Refactor**: centralize `withBlockchainRetry` into shared utility in `system.ts` — replaces local copy in `grid.ts` and inline `Promise.race` in `dexbot_startup_runtime.ts`, giving the startup path retries + node failover too (`modules/order/utils/system.ts`, `modules/order/grid.ts`, `modules/dexbot_startup_runtime.ts`).
- **Fix**: prevent duplicate grid-level CREATEs via 4-layer validator guard — `validateCreateTargetSlots` extended with slot occupancy, master grid price collision, chain orphan collision, and same-batch duplicate detection. Also hardens `checkSpreadCondition` against TOCTOU between lock release and broadcast (`modules/order/utils/validate.ts`, `modules/order/grid.ts`, `modules/dexbot_cow_runtime.ts`).
- **Fix**: prevent false-positive excess cancellation on fresh grid — guard `_reconcileStartupSide` cancelCount with `matchedOnGrid > 0` to avoid destroying legitimate orders when no grid slot yet assigned ([GRID_RECONCILE.md](docs/GRID_RECONCILE.md#fresh-grid-guard)). Fix reconcile timeout death spiral by overriding timeout to 300s so Phase 2 batch creates finish in one shot (`modules/order/grid.ts`, `modules/order/grid_reconcile_internal.ts`).
- **Fix**: prevent cross-side spread correction via boundary-correct type filter — hoist boundary computation before both candidate pools and filter `typedSpreadCandidates` by `getSlotCorrectType(o) === railType` to prevent activating a SPREAD slot on the wrong rail after fill-induced boundary shifts (`modules/order/grid.ts`).
- **Fix**: remove dead PARTIAL filter in `recalculateGrid` (raw chain `limit_order` objects never have a `state` property) and fix `withBlockchainRetry` logger arg — pass `manager.logger` directly instead of `{ logger: manager.logger }` (`modules/order/grid.ts`).
- **Fix**: cancel stale surplus orders after Phase 2 settles in reconcileGridOrders — new Phase 3 pass re-fetches chain orders and cancels any exceeding per-side target that are not tracked by any grid slot's `orderId` ([GRID_RECONCILE.md](docs/GRID_RECONCILE.md#phase-3--stale-surplus-cleanup)). Catches orphan orders whose ID was lost when the grid reinitialized mid-resync.
- **Test**: new `testNoExcessCancelWhenMatchedOnGridIsZero` regression test — fresh grid with `matchedOnGrid=0`, non-zero chainCount+targetCount asserts zero cancel calls (`tests/test_grid_reconcile_regressions.ts`).
- **Test**: `testPhase3CancelsStaleSurplusUntrackedByGrid` — 7 chain sells, target 5, all-VIRTUAL grid with matchedOnGrid=0, verifies Phase 3 cancels exactly 2 untracked surplus and does NOT cancel any tracked order (`tests/test_grid_reconcile_regressions.ts`).
- **Test**: 9 scenarios in `test_validate_create_target_slots.ts` covering all four guard layers, released slots, malformed chain candidates, and no-assets fallback (`tests/test_validate_create_target_slots.ts`).
- **Chore**: update manifest versions to 1.4.1 across all package.json, lockfiles, plugin manifests, docs references (`package.json`, `package-lock.json`, `claw/package.json`, `claw/runtimes/openclaw-plugin/*.json`, `analysis/ama_fitting/package.json`, `claw/tests/test_claw_mcp_transport.ts`, `docs/README.md`, `docs/DEXBOT_COMPARISON.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`, `docs/EVOLUTION.md`).

## [1.4.0] - 2026-07-27 - CJS-to-ESM Migration, Strict Mode Zero-Errors, Daemon-Signing Node Failover

### 2026-07-27

- **Refactor**: CJS→ESM + strict-mode fixes in credential daemon, startup runtime, and sync engine — no behavioral changes (`credential-daemon.ts`, `modules/credential_runtime.ts`, `modules/dexbot_credential_client.ts`, `modules/dexbot_startup_runtime.ts`, `modules/order/sync_engine.ts`).
- **Refactor**: complete CJS→ESM migration — all remaining `require()` calls converted to ESM `import` across every `.ts` file (modules/, market_adapter/, claw/, scripts/, analysis/, root files). Automated codemods handled the initial bulk conversion; this pass covers everything missed (`modules/**/*.ts`, `market_adapter/**/*.ts`, `claw/**/*.ts`, `scripts/**/*.ts`, `analysis/**/*.ts`, `*.ts`).
- **Refactor**: enable `strict: true` `noUnusedLocals` and `noUnusedParameters` in tsconfig — fixed all 213 TS6133/TS6192 unused-declaration errors across ~60 files. Remaining implicit-any annotations resolved with explicit `: any` type annotations (`tsconfig.json`).
- **Refactor**: fix all strict-mode type errors — resolved 1249 remaining TS2339/TS2345/TS2322/TS18047 errors (never-types from empty arrays and null-inferred variables) across 99 files with type annotations and null guards. Build produces zero TypeScript errors at all strict levels (`tsconfig.json`, 99 source files).
- **Chore**: update manifest versions to 1.4.0 across all package.json, lockfiles, plugin manifests, docs references (`package.json`, `package-lock.json`, `claw/package.json`, `claw/runtimes/openclaw-plugin/*.json`, `analysis/ama_fitting/package.json`, `claw/tests/test_claw_mcp_transport.ts`, `docs/README.md`, `docs/DEXBOT_COMPARISON.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`, `docs/EVOLUTION.md`).
- **Fix**: claw CJS/ESM compatibility — add `module.exports` to claw/index.ts, modules/order/async_lock.ts, and modules/order/index.ts so `tsx` `require()` resolves the default export correctly; fix `require()` destructuring in modules/storage/index.ts to extract `.default` from ESM-wrapped modules (`claw/index.ts`, `modules/order/async_lock.ts`, `modules/order/index.ts`, `modules/storage/index.ts`).
- **Feat**: claw `BitShares` proxy and `isConnected()` export — add `isConnected()` query function and a `BitShares` Proxy on the native chain client with `node` property routing to `getNodes()`, enabling claw modules to use the same `BitShares.node` access pattern as the main codebase (`claw/modules/bitshares_client.ts`).
- **Fix**: claw liquidity_pools — deduplicate `BitShares` import path by routing through `client.BitShares` instead of a stale top-level destructured import; extract `derivePoolPrice` and `derivePrice` as direct exports for external callers (`claw/modules/liquidity_pools.ts`).
- **Fix**: claw skill_utils storage import path — corrected from `../../modules/storage.js` to `../../modules/storage/index.js` to match the ESM module layout (`claw/modules/skill_utils.ts`).
- **Fix**: strict-mode `err.message` access in test and diagnostic files — 75 files changed from `err.message` to `getErrorMessage(err)` via the new `modules/utils/errors.ts` helper (`tests/diag_ws_lifecycle.ts`, `tests/diag_ws_nodes.ts`, `tests/test_*.ts`).
- **Fix**: complete CJS/ESM dual-export coverage — add `module.exports` to `bitshares-native/index.ts`, `bitshares-native/crypto/ecc_selector.ts`, `chain_keys.ts`, `chain_orders.ts`, `credit_runtime.ts`, `dexbot_class.ts`, `node_manager.ts`, `order/accounting.ts`, `order/async_lock.ts`, `order/index.ts`, `order/logger_state.ts`, `order/strategy.ts`, `order/sync_engine.ts`, `storage/browser_adapter.ts`, `storage/node_adapter.ts` so `tsx` `require()` resolves named/default exports in the same module record as ESM `import` (`modules/bitshares-native/index.ts`, `modules/bitshares-native/crypto/ecc_selector.ts`, `modules/chain_keys.ts`, `modules/chain_orders.ts`, `modules/credit_runtime.ts`, `modules/dexbot_class.ts`, `modules/node_manager.ts`, `modules/order/accounting.ts`, `modules/order/async_lock.ts`, `modules/order/index.ts`, `modules/order/logger_state.ts`, `modules/order/strategy.ts`, `modules/order/sync_engine.ts`, `modules/storage/browser_adapter.ts`, `modules/storage/node_adapter.ts`).
- **Fix**: `getOrderSize` — check `order?.size` directly with `!= null` to avoid JS default-param reinterpreting `undefined` as `0`, preserving fallback to `order?.amount` for both missing and `NaN` size values (`modules/order/utils/order.ts`).
- **Fix**: `modules/logger.ts` — simplify to re-export from `order/logger` with `createPm2AwareLogger` helper, drop stale JSDoc (`modules/logger.ts`).
- **Fix**: widen `Runtime.kill()` signal param type from `string` to `string | number` — removes the `as any` cast previously needed for numeric signals. Converts all `isAlive` callers (`bot_supervisor.ts`, `foreign_cred_daemon.ts`, `monolithic_runtime.ts`) from string `'0'` to numeric `0` for Node v24 compatibility, matching the already-committed `process_discovery.ts` fix (`modules/runtime.ts`, `modules/launcher/bot_supervisor.ts`, `modules/launcher/foreign_cred_daemon.ts`, `modules/launcher/monolithic_runtime.ts`).
- **Fix**: `test_grid_logic.ts` — correct pool gridPrice fallback assertion from `1000` to `100` to match the configured `startPrice` (`tests/test_grid_logic.ts`).
- **Chore**: remove 7 dead underscore-prefixed variables across 6 test files — `_NODE_MGMT_DEFAULTS`, `_botsFile`, `_bootstrapDeliveries`, `_realSyncFromOpenOrders`, `_effBuy2`, `_netAmount`, `_adopted`. These were renamed to suppress `noUnusedLocals` instead of being deleted (`tests/test_settings_merge.ts`, `tests/test_unlock_control_output.ts`, `tests/test_websocket_subscription_flow.ts`, `tests/test_sync_lock_routing.ts`, `tests/test_trade_profitability_fees.ts`, `tests/test_sync_logic.ts`).
- **Fix**: strict-mode type hygiene — drop unnecessary `: any` on storage, Promise<> type params, and `botKeyFromName(name: any)` → `name: string` across unlock.ts, pm2.ts, process_discovery.ts, and fs_utils.ts (`unlock.ts`, `pm2.ts`, `modules/process_discovery.ts`, `modules/utils/fs_utils.ts`).
- **Fix**: harden catch-block error message extraction — replaced all direct `.message` access on caught error variables with `getErrorMessage(err)` across 78 files (runtime modules, market adapter, CLI entry points, launcher, claw modules, scripts, tests). Created reusable `scripts/fix-err-message.ts` migration tool (`78 source files`, `scripts/fix-err-message.ts`).
- **Fix**: abort phantom-order reset when `_applyOrderUpdate` receives boolean as options — broken call at `grid_reconcile.ts:212-217` passed `false, 0` as positional args instead of an options object, causing `TypeError` that aborted the entire reconcile and produced permanent shortfall warnings (`modules/order/grid_reconcile.ts`).
- **Fix**: catch remaining ESM-migration regressions — `.catch()` handler in `manager.ts:725` used `err.message` instead of `getErrorMessage`; missing `getErrorMessage` import in `constants.ts` onError callback; `_buildOutsideInCreateGroups` callback changed from `Boolean(p?.gridOrder)` to `p?.gridOrder != null` accepting falsy values; additional `getErrorMessage` hardening across 17 files including `bitshares-native/subscriptions.ts` (5 spots), `chain_orders.ts`, `dexbot_maintenance_runtime.ts`, `credential-daemon.ts`, `bot.ts`, `dexbot.ts`, `unlock.ts`, and more — including a behavioral bug where `err?.message?.includes(...)` silently took the wrong recovery path (`modules/order/manager.ts`, `modules/constants.ts`, `modules/order/grid_reconcile_internal.ts`, `bitshares-native/subscriptions.ts`, `bitshares-native/transport.ts`, `bitshares-native/signing_client.ts`, `bitshares-native/tx/tx_cache.ts`, `chain_orders.ts`, `dexbot_maintenance_runtime.ts`, `dexbot_credential_client.ts`, `credential-daemon.ts`, `bot.ts`, `dexbot.ts`, `unlock.ts`, `market_adapter/ama_signal_runner.ts`, `market_adapter/lp_chart_runner.ts`, `claw/modules/bitshares_client.ts`, `claw/modules/position_manager_watch.ts`, `scripts/test-credit-renewal.ts`, `modules/order/utils/system.ts`).
- **Fix**: prevent doubled grid-level order creation at overlapping prices — three safety layers: (1) pre-broadcast price collision guard scanning `bot.manager.orders` for any ACTIVE/PARTIAL slot within `calculatePriceTolerance` of target price; (2) late-adoption of discarded CREATEs after uncertain-broadcast window; (3) spread-correction candidate dedup filtering overlapping prices. Also promotes sub-minimum dust as full fill to force rotation (`modules/dexbot_cow_runtime.ts`, `modules/order/grid.ts`, `modules/order/sync_engine.ts`).
- **Feat**: daemon-signing node failover — `executeViaDaemonToken` queries `getNodeManager()` for healthy nodes and injects `nodeUrl`, `fallbackNodes`, and `onNodeFailed` callback into daemon signing options automatically. `updateOrder`, `createOrder`, `executeBatch` accept `extraOptions` parameter forwarded as escape hatch for per-call overrides. Failover is automatic (`modules/chain_orders.ts`).
- **Feat**: remove ghost-order cancellation feature — immediate batch-cancel of "other-side rounds to 0" orphan orders removed across the stack (`dexbot_fill_runtime.ts`, `dexbot_class.ts`, `sync_engine.ts`, `types.ts`). Ghost-order chain remnants now handled by existing unmatched-orphan auto-cancel backstop (1–5 cancels/cycle) instead of immediate batch cancel. Tests updated (`tests/test_ghost_order_fix.ts`, `tests/test_sync_fill_history_batch.ts`).
- **Fix**: log pair-specific order count in sync start message — the "[SYNC] Starting synchronization from N blockchain orders..." message logged total open order count for the account (from `readOpenOrders` → `get_full_accounts`), not the count matching the bot's trading pair. Moved log line after the `parseChainOrder()` loop, using `parsedChainOrders.size` so the log reports only orders matching the configured assetA/assetB pair. Log now sits inside `mgr._syncLock.acquire(...)`, so force-released syncs skip the "starting" line entirely (`modules/order/sync_engine.ts`).
- **Fix**: remove garbled path suffix in `test_ama_slope_model` import (ESM migration artifact). Also fix two pre-existing test failures: `test_cow_commit_guards.ts` — add `synchronizeWithChain` mock + use distinct create prices to avoid same-batch price collision guard; `test_ghost_order_fix.ts` — update assertions for P4 sub-minimum dust promotion (remainder below `minAbsoluteOrderSize` is now VIRTUAL full fill) (`tests/test_ama_slope_model.ts`, `tests/test_cow_commit_guards.ts`, `tests/test_ghost_order_fix.ts`).
- **Fix**: bootstrap fund-drift false positive — `initializeStartupState()` called `finishBootstrap()` in its `finally` block before grid was loaded into `manager.orders`; drift check saw `gridBuy = 0` vs locked chain balances, always reporting massive BUY-side drift. Fix: removed premature `finishBootstrap()` — now runs only after grid is fully loaded and reconciled (`modules/dexbot_startup_runtime.ts`).
- **Fix** (superseded by fill polling below): subscription health-check cycling — server-side database API session TTL (~120s) silently killed notice stream while WebSocket stayed open; transport keepalive only pings `login_api` (API ID 1), not `database_api` (API ID 2). Original fix: call `get_dynamic_global_properties()` at start of each health-check tick to keep database API session alive. Superseded by active fill polling which does not depend on server-side session state (`modules/bitshares-native/subscriptions.ts`).
- **Refactor**: centralize price-collision detection and guard grid-reconcile create paths — moved `findPriceCollision` into `modules/order/utils/math.ts` as shared utility; `dexbot_cow_runtime.ts` and `grid.ts` import it instead of declaring local copies. Added collision guards to `_createOrderFromGrid` and `_executeStartupCreateGroupBatch` in `grid_reconcile_internal.ts` — rejects create operations when another placed order already exists within tolerance of target price. JSDoc documents that `_gridLock` MUST be held by caller (`modules/order/utils/math.ts`, `modules/order/grid.ts`, `modules/dexbot_cow_runtime.ts`, `modules/order/grid_reconcile_internal.ts`).
- **Refactor**: address review concerns — deduplicate `_extractRateFromCollateralMap` helper in `credit_runtime.ts` eliminating 3 nearly-identical rate-extraction blocks; hoist `_resolveAsset` outside pricing loops so asset resolution runs once per refresh. Export `RUNTIME_SETTINGS_KEYS` from `runtime_settings.ts`; `dexbot_maintenance_runtime.ts` uses `getRuntimeSettingsKeys()` instead of hardcoded list. Reorder `finishBootstrap` after `fetchAccountTotals` in `dexbot_startup_runtime.ts` so bootstrap drift check uses fresh balances. Add `Promise.race` timeout for `readOpenOrders` in `grid.ts` with proper `NodeJS.Timeout | undefined` typing. Derive `SYNC_LOCK_FORCE_RELEASE_AGE_MS` as `SYNC_LOCK_TIMEOUT_MS * 2` in `constants.ts` so user overrides propagate automatically (`modules/credit_runtime.ts`, `modules/runtime_settings.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/dexbot_startup_runtime.ts`, `modules/order/grid.ts`, `modules/constants.ts`).
- **Refactor**: replace silent-staleness watchdog + DB-ping keepalive with active fill polling at `FILL_POLL_INTERVAL_MS` (60s). Bitshares-core analysis confirmed `get_dynamic_global_properties()` has zero effect on subscriptions (no server-side TTL exists). Removed `startSubscriptionKeepalive()` and `SUBSCRIPTION_SILENT_THRESHOLD_MS`-based health check that triggered unnecessary `set_subscribe_callback` cycles every 2-3 minutes. New `startFillPolling()` runs `processObjects` per active subscription every `FILL_POLL_INTERVAL_MS`, discovering fills via `get_account_history` within 60s regardless of push notification delivery (`modules/bitshares-native/subscriptions.ts`, `modules/constants.ts`).

## [1.3.3] - 2026-07-25 - Runtime Extraction, Memory-Leak Hardening, Import Cleanup

### 2026-07-25

- **Feat**: extract COW batch execution runtime from `dexbot_class.ts` into new `dexbot_cow_runtime.ts` — moves `_cowBatchExecute`, `_executeCowTransaction`, `_processCowResult`, `_processCowFailure`, `_processCowConcurrent`, and `_cleanupCowTailTrap` into dedicated runtime module (`modules/dexbot_cow_runtime.ts`, `modules/dexbot_class.ts`).
- **Refactor**: extract fill queue methods into `dexbot_fill_runtime.ts` — moves `_processFillQueue`, `_processFillStage`, `_completeFill`, `_abortFill`, `_getFillSyncAccounts`, and helpers out of `dexbot_class.ts` (`modules/dexbot_fill_runtime.ts`, `modules/dexbot_class.ts`).
- **Refactor**: extract state recovery and startup runtime from `dexbot_class.ts` into new `dexbot_state_recovery.ts` and `dexbot_startup_runtime.ts` — isolates `_doStateRecovery`, `_adoptUnmatchedOrders`, `_rebroadcastPendingOrders`, startup lifecycle, and bootstrap guards (`modules/dexbot_state_recovery.ts`, `modules/dexbot_startup_runtime.ts`).
- **Refactor**: drop unused bot params from COW runtime wrappers — removes dead `assetA`/`assetB`/`marketId`/`profileName` parameters from `commitGrid`, `updateCommitmentSlack`, and `commitBatch` (`modules/dexbot_fill_runtime.ts`, `modules/order/grid.ts`).
- **Fix**: add `cwd` fallback for profile resolution in `paths.ts` — when `__dirname` is undefined (e.g. esm-shim context), fall back to `process.cwd()` to prevent profile-load failures (`modules/paths.ts`).
- **Fix**: remove dead imports and fix mock-breaking destructured imports across `modules/` — `crypto.js`, `utils.js`, `OrderError`, `system.ts` imports removed; `State`/`GridOrderState` imports converted to namespace access to preserve test monkey-patching (`modules/order/grid_reconcile.ts`, `modules/order/grid_reconcile_internal.ts`, `modules/order/utils/*.ts`, `modules/fund_registry.ts`, `modules/general_settings.ts`, `modules/launcher/*.ts`, `modules/chain_keys.ts`, `modules/credential_policy.ts`, `modules/key_store.ts`, `modules/bitshares-native/serial/types.ts`, `modules/order/*.ts`).
- **Fix**: promote v1.3.0 changelog entry from sub-section to top-level header (`CHANGELOG.md`).
- **Chore**: add `pretest` hook — automatically rebuilds the test fee cache via `npm run test:fee-cache` before test runner invocation; also reconciles `package.json` browser field entries and fixes a brittle log message in `test_cow_orchestration_fixes.ts` (`package.json`, `tests/helpers/fee_cache_init.ts`, `scripts/verify-browser-bundle.ts`).
- **Chore**: clean up dead import annotations, fix type annotations, and resolve mock regression from mock redefinition across test files (`tests/test_cow_commit_guards.ts`, `tests/test_cow_orchestration_fixes.ts`, `tests/test_cow_structural_resync.ts`, `tests/test_grid_persistence_guard.ts`, `tests/test_uncertain_broadcast.ts`, `tests/test_patch17_invariants.ts`).
- **Docs**: EVOLUTION.md stats refresh (Phase 6 cleanup, 1,857→1,857 commits, 200+→224 tests, 74→75 releases, ~54k→~67.6k LoC), module file listings per directory, doc cross-links updated (`docs/EVOLUTION.md`, `docs/README.md`, `docs/GRID_RECALCULATION.md`, `docs/DEXBOT_COMPARISON.md`, `tests/README.md`, `modules/README.md`, `market_adapter/README.md`, `docs/developer_guide.md`).
- **Fix**: credential daemon memory-leak hardening — store `nodeRefreshIntervalTimer` and `auditPruneIntervalTimer` as module-level vars (cleared in `shutdown()`), add `daemonShuttingDown` early-return in `processRequest()` to avoid misleading errors after secrets are zeroed, socket idle timeout (30s) and 1MB buffer cap to prevent idle connection accumulation and OOM, convert audit log queue from chained-Promise serial to parallel drain via `process.nextTick`, prune stale signing clients on every broadcast, add `CREDENTIAL_DAEMON_SOCKET_TIMEOUT_MS` and `CREDENTIAL_DAEMON_MAX_BUFFER_SIZE` constants (`credential-daemon.ts`, `modules/constants.ts`).

## [1.3.2] - 2026-07-24 - Dust Health Check, Lightweight Sync Fixes, Doc Updates

### 2026-07-24

- **Feat**: startup dust health check — run a single dust health check immediately at startup (not only after the 5-minute delay). Extracted cycle body into `_runDustHealthCheck()` for reuse between startup call and periodic timer (`modules/dexbot_class.ts`).
- **Fix**: remove early return in lightweight sync that skipped RMS divergence resync — `if (!assets) { ... return; }` exited `executeMaintenanceLogic` entirely, preventing the RMS divergence code from ever executing. Replaced with `if/else` so execution always falls through (`modules/dexbot_maintenance_runtime.ts`).
- **Fix**: lightweight sync pair-filter — counted ALL open orders on account via `readOpenOrders().length`, causing false-positive "chain=107 grid=40 (diff=67)" warnings when other pairs had orders. Filter chain count through `parseChainOrder()` to match only the bot's assetA/assetB (`modules/dexbot_maintenance_runtime.ts`).
- **Fix**: dust-handling improvements — lock-safe cancel (acquires `_fillProcessingLock` with 5s timeout, fallback to lock-less cancel if busy), deferred dust logging (logs when pipeline is non-empty), no-budget robustness (computes `idealSizes = []` instead of early-return on `budget <= 0`) (`modules/dexbot_class.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/order/grid.ts`).
- **Fix**: correct `dexbot stat` suggestion in unlock.ts messages — both console messages suggested `dexbot unlock stat` but the shorter `dexbot stat` works identically (`unlock.ts`).
- **Docs**: align README installation options and fix wording consistency — Option B comment "works everywhere", add missing Option C (local wrappers) to Installation section (`README.md`).
- **Docs**: document capital allocation pipeline (`funds.allocated` vs `chainFree`) — new Allocated row in Fund Components table, new Capital Allocation Pipeline section with pipeline diagram, renumber subsections, update Global Side Capping reference (`docs/FUND_MOVEMENT_AND_ACCOUNTING.md`).
- **Test**: new `test_lightweight_sync_chain_filter.ts` validates `parseChainOrder` correctly filters matching orders and classifies SELL/BUY types (`tests/test_lightweight_sync_chain_filter.ts`).
- **Test**: new `testNoBudgetReturnsEmptyDust` in `test_dust_rebalance_logic.ts` pins the no-budget branch (`tests/test_dust_rebalance_logic.ts`).

## [1.3.1] - 2026-07-24 - CLI Canonical Naming, Browser Exclusion Completeness, Doc Polish

### 2026-07-24

- **Feat**: add repo-root symlinks `dexbot`→`scripts/dexbot`, `pm2`→`scripts/pm2`, `unlock`→`scripts/unlock` so `./dexbot`, `./pm2`, `./unlock` work immediately after `npm install` with no global install. Wrappers try compiled `dist/` first, fall back to `tsx/cjs` for source.
- **Fix**: rename canonical CLI commands `keys`/`bots` → `key`/`bot` in `dexbot.ts` registry. Plural forms continue to work via alias map. Updated all switch cases, JSDoc, and user-facing strings (`dexbot.ts`, `bot.ts`, `pm2.ts`, `modules/account_bots.ts`, `modules/bot_settings.ts`, `scripts/README.md`, `scripts/reset-settings.sh`, `scripts/postinstall.js`, `docs/GRID_RECALCULATION.md`, `docs/WORKFLOW.md`, `AGENTS.md`, `README.md`).
- **Fix**: add missing browser exclusion entries for `modules/logger.js` and `modules/paths.js` to `package.json` browser false map (regression from 1.3.0 guard removal). Two entries: `./dist/modules/logger.js` and `./dist/modules/paths.js`.
- **Fix**: add missing browser exclusion for `modules/order/utils/system.js` — transitively imports `../../logger` and `../../paths` (both browser-false, resolve to `{}` stub) and instantiates `new Logger('System')` at module load time (`package.json`, `AGENTS.md`).
- **Fix**: add missing `npm link` to install-from-source command in Option B of README Quick Start (`README.md`).
- **Docs**: de-duplicate Quick Start setup commands, drop redundant `'bare'` from git clone instructions (`README.md`, `AGENTS.md`, `CHANGELOG.md`).

## [1.3.0] - 2026-07-23 - CLI Migration Completion, Market Adapter Cleanup, Doc Refresh

### 2026-07-23

- **Feat**: version bump 1.2.7 → 1.3.0 across all manifests (`package.json`, `package-lock.json`, `analysis/ama_fitting/package.json`, `claw/package.json`, `claw/runtimes/openclaw-plugin/*.json`, `claw/tests/test_claw_mcp_transport.ts`, `docs/DEXBOT_COMPARISON.md`, `docs/EVOLUTION.md`, `docs/MPA_CREDIT_USAGE.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`, `docs/WORKFLOW.md`, `docs/README.md`, `docs/architecture.md`).
- **Fix**: migrate all remaining `node unlock`/`node pm2` user-facing references to `dexbot unlock`/`dexbot pm2` across 22 source files — error messages, help text, doc comments, success banners, runtime command strings, ecosystem regeneration comments, and test assertions. Includes repo-root alternative notes (`./pm2`/`./unlock`) preserved in CLI entry points (`pm2.ts`, `unlock.ts`, `dexbot.ts`, `credential-daemon.ts`, `scripts/update.ts`, `modules/dexbot_class.ts`, `modules/launcher/*.ts`, `modules/constants.ts`, `claw/modules/claw_launcher.ts`, 4 test files).
- **Fix**: correct all repo-root alternative notes from `node unlock`/`node pm2` (which don't work — no `.js` at root) to `./unlock`/`./pm2`. Affected `unlock.ts`, `pm2.ts` (×2), `dexbot.ts`, `docs/docker.md`, `README.md`.
- **Fix**: replace fragile CLI strings in `claw/modules/claw_launcher.ts` `command:` fields (`dexbot unlock <name>`, `dexbot pm2 claw-only`, etc.) with CLI-agnostic mode labels (`'unlock'`, `'pm2 (claw-only)'`, `'test'`, `'drystart'`).
- **Fix**: remove browser-safe `typeof __filename` guard in `market_adapter.ts` — always available at runtime, no browser path (`market_adapter/market_adapter.ts`).
- **Fix**: update `claw/package.json` test script from compiled `.js` paths to `npx tsx` for `.ts` source files (all 16 test targets). Tests now run on source directly rather than compiled `dist/` output.
- **Fix**: remove stale `dexbot` ignore rule from `.gitignore` (no longer needed with intentional symlinks).
- **Docs**: update 17 documentation files — `README.md`, `docs/`, `claw/docs/`, `claw/skills/`, `claw/README.md`, `analysis/README.md` — with CLI invocation fixes, `dexbot unlock`/`dexbot pm2` as primary commands, repo-root alternative notes, version references updated to 1.3.0, position-health zone model correction (5-zone → 3-zone), green zone CR range fix (2.0 → 1.7–3.0), trend detector source correction, tradingview path correction, and module path clarifications.
- **Docs**: restructure `README.md` Quick Start into 3 self-contained copy-paste paths (global install, clone+npm link, clone+local wrappers). Add `npm link`/`npx` guidance to `scripts/postinstall.js` for local installs.
- **Docs**: update `scripts/README.md` entry-point table to show `./dexbot`/`./unlock`/`./pm2`.
- **Docs**: add JSDoc blocks to `_resolveMpaFeedPrice` and `_resolveCreditConversionRate` in `modules/credit_runtime.ts`. Refresh inline doc-comment exports listings in `modules/account_bots.ts`, `modules/chain_orders.ts`, `modules/bitshares_client.ts`, `modules/chain_keys.ts`, `modules/account_orders.ts`, `modules/order/format.ts`, `modules/order/utils/order.ts`. Fix stale comment in `analysis/analyze_kalman.ts`. Fix comment paths in `market_adapter/inputs/fetch_lp_data.ts`, `market_adapter/lp_chart_runner.ts`, `claw/modules/position_discovery.ts`.
- **Chore**: classify `market_adapter/market_adapter.ts` as Node-only in `AGENTS.md` and `package.json` `"browser": false` map (uses `__filename`, `path`, file-system paths — never browser-safe). Remove unused `ORDER_STATES.FILLED` constant from `modules/constants.ts`.

## [1.2.7] - 2026-07-23 - CLI Invocation Fix, ALS Re-Entrancy Test Fix

### 2026-07-23

- **Fix**: correct two AsyncLock tests for ALS-based re-entrant detection — Test 4 in `test_async_lock_force_release.ts` now calls nested `acquire()` from inside the lock's callback (same ALS context) and verifies concurrent callers queue; F6-T3 in `test_contention_and_dedup.ts` now expects contention detection from a different async context (`tests/test_async_lock_force_release.ts`, `tests/test_contention_and_dedup.ts`).
- **Docs**: replace `node dexbot` with `dexbot` across all user-facing documentation and help text — the `node dexbot` pattern does not work for globally installed npm packages since Node resolves arguments as file paths, not PATH binaries. Updated `README.md`, `docs/WORKFLOW.md`, `docs/GRID_RECALCULATION.md`, `market_adapter/README.md`, `scripts/README.md`, `scripts/reset-settings.sh`, `dexbot.ts`, `claw/modules/claw_launcher.ts`, `claw/modules/launcher_mode_detector.ts`.
- **Docs**: clarify `npm i -g dexbot` (was `npm i dexbot`) as required for global install; add note about repo-root users using `./scripts/dexbot` instead (`README.md`).

## [1.2.6] - 2026-07-23 - Batch Fill Sync, Crash-Durable Dedup, Ghost Batch Cancel, Config Overrides

### 2026-07-23

- **Feat**: batch fill history sync (`syncFromFillHistoryBatch`) — processes multiple fill-history events acquiring `_gridLock` once, batches drift refetch into single `get_objects` RPC via `batchReadOrders`, acquires all order locks once up-front, pauses fund recalc once. Replaces per-fill loop in `dexbot_class.ts` for 2+ fills in a block (`modules/order/sync_engine.ts`, `modules/chain_orders.ts`).
- **Feat**: crash-durable fill dedup window — persists recently-queued fill keys alongside master grid snapshot via new `_getRecentFillKeysSnapshot()`, restores at startup into `_recentlyQueuedFills`, merges with previous snapshot to avoid eviction loss between persist cycles (`modules/account_orders.ts`, `modules/order/utils/system.ts`, `modules/order/manager.ts`).
- **Feat**: ghost order batch cancellation — builds all cancel ops with `Promise.allSettled` for per-ID error tolerance, executes in chunks of `MAX_OPS_PER_TX`, marks successfully cancelled IDs per-chunk to avoid redundant re-attempts, falls back to individual `cancelOrder` on batch failure (`modules/order/sync_engine.ts`).
- **Feat**: grid lock contention telemetry — `AsyncLock onContention` callback fires on queue build-up and in `_processQueue` after callback completion, replaces removed `invariantViolations` metric (`modules/order/manager.ts`).
- **Feat**: fund sizing from allocated balances — `_getSizingContext`, `calculateAvailableFundsValue`, `getSideBudget` prefer `funds.allocated.{buy,sell}` over `accountTotals.{buyFree,sellFree}` (`modules/order/grid.ts`, `modules/order/utils/math.ts`, `modules/order/utils/order.ts`).
- **Feat**: runtime-config overrides — `resolveBotRuntimeSettings` includes `fillProcessing`, `pipelineTiming`, `apiLimits` with full override cascade (globals/market/pair/bot); `PIPELINE_TIMING` and `FILL_PROCESSING` lookups go through config with fallback to constants; new TS interfaces (`BotFillProcessingOverrides`, `BotPipelineTimingOverrides`, `BotApiLimitsOverrides`) (`modules/dexbot_fill_runtime.ts`).
- **Fix**: deduplicate `syncFromFillHistory` vs `syncFromFillHistoryBatch` — extracted three shared helpers (`_findMatchingGridOrder`, `_computeFillContext`, `_computeFillTransitionResult`) eliminating ~300 lines of nearly-identical drift-detection, ghost-detection, and state-transition logic (`modules/order/sync_engine.ts`).
- **Fix**: `_logThrottled` unbounded suppressed counter — capped at 1M to prevent pathological overflow; removed throwaway object on cache miss; removed redundant `Map.set()` on suppression path; removed dead `lastMessage` field (`modules/order/accounting.ts`).
- **Fix**: route all `_recoveryState` writes through setter — replaced `x._recoveryState = x._recoveryState || {}; x._recoveryState.Y = Z` and direct field mutations with `x._recoveryState = { ...x._recoveryState, Y: Z }` across 13 sites (`modules/dexbot_class.ts`, `dexbot_maintenance_runtime.ts`, `modules/order/accounting.ts`, `modules/order/manager.ts`).
- **Fix**: `_illegalStateSignal` direct write routed through `_lastIllegalState` setter (`modules/order/manager.ts:926`).
- **Fix**: stale-entry pruning in `_lastBlacklistWarnMs` when Map exceeds 64 entries (`modules/node_manager.ts:388`).
- **Fix**: removed `StrategyEngine` fee-event dedup subsystem (`_settledFeeEvents` map, `_pruneSettledFeeEvents`, `_buildFeeEventId`) — dedup now handled by `manager.processedFillTracker` upstream (`modules/order/strategy.ts`).
- **Fix**: removed `hasEquivalentRawOnChainOrder` (unused), `_getDriftToleranceMultiplier` (inlined), `_rollbackBalanceAdjustments` (dead code), `totalOnly` param from `adjustTotalBalance` (`modules/order/sync_engine.ts`, `modules/order/manager.ts`, `modules/order/accounting.ts`).
- **Fix**: consolidated `_shutdownStarted` → `_shuttingDown` (single guard flag) (`modules/dexbot_class.ts`).
- **Chore**: hoist dynamic `require('../chain_orders')` calls — replaced 3 lazy requires inside method bodies with single top-level const, uses module namespace object (not destructuring) so test monkey-patching continues to work (`modules/order/sync_engine.ts`).
- **Chore**: add `_recentFillKeysSnapshot` type — `any` → `Record<string, number> | null` (`modules/order/manager.ts:272`).
- **Chore**: update TABLE OF CONTENTS in `sync_engine.ts` to list `syncFromFillHistoryBatch` as method #6.
- **Test**: new `test_contention_and_dedup.ts` — AsyncLock contention callback, crash-durable fill key snapshot/restore.
- **Test**: new `test_sync_fill_history_batch.ts` — 9 coverage cases for batch sync.
- **Test**: chunk-boundary tests (F8-T1: 201 IDs → 2 batches, F8-T2: 200 IDs → single batch, F8-T3: empty → 0 batches).
- **Test**: updated `test_accounting_logic.ts` for inlined tracker access.
- **Test**: updated assertion for `requiresOpenOrdersSync` behavior.
- **Fix**: refresh dynamic weight distribution before all fill-rebalance paths — added `_refreshDynamicWeightDistribution` calls to three sites that previously relied on periodic refresh alone: `_consumeFillQueue` (live fill subscription), post-reconnect safety-net sync, and `_syncOpenOrdersAndProcessFills`. Weights can become stale between periodic refresh cycles, causing rebalances to use outdated weight distributions (`modules/dexbot_class.ts`).
- **Fix**: periodic blockchain fetch now refreshes dynamic weight distribution before processing fills — added `refreshDynamicWeightDistribution` call inside the fill-processing lock in `setupBlockchainFetchInterval` (`modules/dexbot_maintenance_runtime.ts`).
- **Test**: fix `test_periodic_sync_fill_rebalance.ts` — the test mock of `syncMarketAdapterOnPeriodicConfigCheck` via module-export assignment had no effect on the internal closure reference in the same file; added weight refresh before fill processing makes the flow consistent.
- **Test**: fix `test_market_adapter_service.ts` — three restart-backfill AMA3 test cases used `oldRawCount = 1836`, but the v1.1.3 AMA refit reduced warmup bars from 1927 to 1758, making `missingCount` negative. Updated `oldRawCount` to `1700` (`tests/test_market_adapter_service.ts`).
- **Docs**: fix stale numbers in `EVOLUTION.md` (commit count 1,743 → 1,827, LoC ~58,000 → ~54,000, release entries 62 → 70).

## [1.2.5] - 2026-07-22 - Redundant Open-Orders Sync Fix, Supervisor Updater Override, Base58 Deduplication, KeyStore Cleanup

### 2026-07-22

- **Fix**: redundant open-orders sync in `_processFillsCore` — `fillsWithoutBlock` could set `requiresOpenOrdersSync=true` and run an inline sync, but the fallback guard at line 2112 triggered a second identical sync. Now sets `anyRequiresSync=true` after `processValidFills(fillsWithoutBlock)` when the flag is active (`modules/dexbot_class.ts`).
- **Fix**: supervisor updater override — added `updaterActive` option to `createBotSupervisor` so callers can enable the updater job without mutating the frozen `UPDATER` constant. Threaded through `buildSupervisedApps` (`modules/launcher/bot_supervisor.ts`).
- **Fix**: `waitForStableStartup` event-loop hang — removed `.unref()` from poll timer so it keeps the event loop alive when all other handles close (`modules/launcher/bot_supervisor.ts`).
- **Fix**: unref credit/dust intervals — `.unref()` on `_creditWatchdogInterval` and `_dustHealthCheckTimer` so they don't prevent clean event-loop exit, matching existing `_credentialDaemonWatchdogInterval` pattern (`modules/dexbot_class.ts`).
- **Fix**: deduplicate inline base58 encode/decode — delegate `ecc.ts` and `ecc.browser.ts` to shared `modules/utils/base58check.ts`; export `base58Encode`/`base58Decode` for shared use (`modules/bitshares-native/crypto/ecc.ts`, `ecc.browser.ts`, `modules/utils/base58check.ts`).
- **Fix**: remove pure-delegation pass-through methods from `KeyStore` interface and both implementations — callers already use `chainKeys` directly (`modules/key_store.ts`).
- **Fix**: set `resolvedBotName` to `null` when `clawOnly` is true — no bot to resolve in claw-only mode (`modules/launcher/launch_modes.ts`).
- **Chore**: import `roundToDecimals` from `order/utils/math` directly instead of re-export shim in `cr_planner.ts` and `credit_runtime.ts`.
- **Test**: align 9 test files with recent production changes and fix pre-existing hanging-test failures (`tests/test_browser_abstractions.ts`, `test_dexbot_maintenance_runtime_dynamic_weights.ts`, `test_dexbot_start_master_password_failure_output.ts`, `test_dexbot_startup_dynamic_weight_wiring.ts`, `test_dust_cancel_delay_config_migration.ts`, `test_fill_batch_chunking.ts`, `test_grid_reconcile_regressions.ts`, `test_launcher_exports.ts`, `test_main_loop_sync_fill_rebalance.ts`).

## [1.2.4] - 2026-07-21 - Credential Daemon Memory - Signing Client Cache, Dispose(), Session Purge, Shallow Policy Copy

### 2026-07-21

- **Fix**: credential daemon memory — replace `JSON.parse(JSON.stringify(BUILTIN_DEFAULT_POLICY))` with shallow spread copy in `credential_policy.ts:667`, avoiding 50k+ deep-copy allocations daily (`credential_policy.ts`).
- **Fix**: simplify `queueAuditLogWork` — remove redundant promise wrapper + microtask per audit entry (`credential-daemon.ts:214-216`).
- **Fix**: hoist `wifToBuffer` to module scope with `_disposed` guard flag on `SigningClient` — `dispose()` now actually zeros WIF bytes; `newTx()`/`broadcast()` throw after dispose (`signing_client.ts`).
- **Feat**: add `signingClientCache` in credential daemon — keyed by `accountName:keyFingerprint(wif)`, 30-min TTL pruning, cache-aware `broadcastWithRetry` skips client creation on hit, detects key rotation via fingerprint (`credential-daemon.ts`).
- **Feat**: session lifecycle — `setInterval(purgeExpiredSessions, 300000)` replaces inline purge; `sessionPurgeInterval` cleared in shutdown (`credential-daemon.ts`).
- **Feat**: shutdown iterates signing client cache, disposes every entry, clears map (`credential-daemon.ts:1126-1131`).
- **Fix**: reconnect path disposes all cache entries before clear for heap-dump safety (`credential-daemon.ts`).

## [1.2.3] - 2026-07-21 - Uncertain-Broadcast Grid Corruption Fix, Unmatched-Order Adoption, Grid-Bloat Loop Fix

### 2026-07-21

- **Fix**: prevent grid corruption from uncertain broadcasts — discarded CREATEs in `_reconcileAfterUncertainBroadcast` left virtual slots stuck at size=0 (no follow-up rebalance). Now restores target size on virtual slots with no orderId (`modules/dexbot_class.ts`).
- **Fix**: unmatched chain orders no longer auto-cancelled — old guard destroyed legitimate on-chain positions to unblock CREATE batches. Replaced with `syncFromOpenOrders` adoption + unconditional structural resync. Preserves positions and prevents permanent gaps (`modules/dexbot_class.ts`).
- **Fix**: `_lastUnmatchedChainOrders` only overwritten when sync actually processed orders (>0 filled+updated+corrected). Prevents dropping stale entries on force-release or lock-contention early exits (`modules/dexbot_class.ts`).
- **Fix**: `isGridBloated` formula false-flagged full-rail grids (many virtual slots outside active window). Changed from `placedCount + gapSlots + 1` to `estimatedRailSize + gapSlots + MIN_SPREAD_ORDERS`. Prevents infinite bloat-resync loop (`modules/order/grid.ts`).
- **Fix**: `loadGrid` reassigns stale SPREAD/BUY/SELL types on virtual slots from old boundary positions — types are corrected on every grid load (`modules/order/grid.ts`).
- **Fix**: `_recoverFromPersistedGrid` returns `{ success: false }` when grid still bloated after reload, so `requestStructuralGridResync` falls through to full `requestGridReset` (`modules/dexbot_class.ts`).
- **Fix**: empty-side spread correction never fired — `shouldFlagOutOfSpread` returned 0 when either side had zero on-chain orders. Now returns nominal gap slot count so correction activates a SPREAD slot (`modules/order/utils/order.ts`).
- **Fix**: boundary-at-rail-edge triggers structural resync — when boundary crawl clamps to 0 or `allSlots.length-1`, fill pressure could wipe out a side. `checkSpreadCondition` now triggers `requestStructuralGridResync` when one side is empty and boundary leaves <2 slots (`modules/order/grid.ts`).
- **Fix**: TOCTOU silent abort in spread correction — when funds changed between lock release and broadcast, correction silently aborted indefinitely. Now re-plans with fresh funds instead (`modules/order/grid.ts`).
- **Fix**: budget dilution from virtual slots in `calculateGeometricSizeForSpreadCorrection` — counted all orders including hundreds of virtual slots, diluting correction size to dust. Now counts only on-chain (ACTIVE+PARTIAL) orders (`modules/order/grid.ts`).
- **Fix**: `adjustBudgetForBtsFees` regression — c3c0fcdc refactor clamped non-BTS budget to 0 when `sideFree=0` (all capital committed). Restored deduction against `allocated`, matching original semantic (`modules/order/utils/order.ts`).
- **Fix**: pending-broadcasts path extracted to a clean separate block in COW guard — no behavioral change, improves readability (`modules/dexbot_class.ts`).
- **Fix**: unmatched order sample logged for operator visibility — top 3 unmatched entries included in COW CREATE rejection log (`modules/dexbot_class.ts`).
- **Fix**: `_recoverFromPersistedGrid` rejects when unmatched chain orders remain after sync — prevents stale persisted grid from being accepted when it produces inconsistent state (`modules/dexbot_class.ts`).
- **Fix**: `_autoCancelOneUnmatchedOrphan` narrowed to only cancel `price-drift-orphan` entries — all other unmatched types (duplicate-price-level, already-matched-slot, etc.) are adoptable positions preserved for structural resync (`modules/dexbot_class.ts`).
- **Fix**: structural resync safeguard after `skipAccounting` restore in uncertain broadcast — schedules resync when discarded CREATEs were restored, ensuring fund accounting is recalculated (`modules/dexbot_class.ts`).
- **Fix**: `performGridResync` explicitly clears `_lastUnmatchedChainOrders` after successful rebuild — prevents COW guard from holding stale unmatched entries from before resync (`modules/dexbot_maintenance_runtime.ts`).
- **Fix**: improved logging when sync returns without processing in COW guard — distinguishes lock contention (debug) from stale unmatched entries (warn); updates `_lastUnmatchedChainOrders` when sync result has different unmatched count (`modules/dexbot_class.ts`).
- **Test**: `test_grid_logic.ts` — fixed `FreshinitializeGrid` typo (5 sites), updated `shouldFlagOutOfSpread` empty-side assertion from 0 to 4 (`tests/test_grid_logic.ts`).
- **Test**: `test_spread_redistribution_fallback.ts` — fixed by `adjustBudgetForBtsFees` regression fix above (`tests/test_spread_redistribution_fallback.ts`).
- **Test**: `test_cow_structural_resync.ts` — updated "auto-cancel succeeds" to test adoption path (cancel not called, batch rejected, resync requested) (`tests/test_cow_structural_resync.ts`).
- **Test**: `test_uncertain_broadcast.ts` — updated 3 existing tests to use `price-drift-orphan` reason; added 2 new tests: `testAutoCancelOnlyPriceDriftOrphans` and `testRecoverFromPersistedGridUnmatchedRemain` (`tests/test_uncertain_broadcast.ts`).
- **Test**: `test_grid_bloat.ts` — full-rail 290-slot "not bloated" case, `loadGrid` stale-virtual-slot type reassignment test (`tests/test_grid_bloat.ts`).

## [1.2.2] - 2026-07-21 - Invariant Sabotage Prevention, Regression Hardening, Code-Review Cleanup

### 2026-07-21

- **Fix**: prevent 3 invariant sabotage vectors in filled-order handling — (1) ghost-order virtualization defeats duplicate-CREATE guard: skip slots with `size===0` in `processFillsOnly`; (2) two-pass sync releases committed capital without fill proceeds: hardcode `skipAccounting=true` in pass-2; (3) fee-deduction failure silently over-credits `accountTotals`: escalate fee-fallback log from `warn` to `error` with explicit "fund tracking will over-credit" language. Also fix TOCTOU where `processFillAccounting` runs before order lock, and add `isMaker` default observability warning (`modules/order/accounting.ts`, `modules/order/strategy.ts`, `modules/order/sync_engine.ts`).
- **Fix**: harden 3 regression vectors from accounting/lock/maker-default fixes — (1) `skipAccounting` variable leak in sync-engine pass-2: hardcode `true` instead of passing local variable; (2) TOCTOU in POST-RESET and BOOTSTRAP tracked-fill paths: wrap `processFillAccounting` calls in per-order lock acquire/release with try/finally; (3) `is_maker` silent default observability: add `_warn` in orphan-fill fallback key builder, fix log label consistency (`modules/dexbot_class.ts`, `modules/dexbot_fill_runtime.ts`, `modules/order/sync_engine.ts`).
- **Fix**: orphan-fill tolerance widening disconnected — `_orphanFillsCreditedAt` declared on `DEXBot` but read from `OrderManager`; moved field + init to `OrderManager`, removed orphaned declaration/init from `DEXBot` (`modules/order/manager.ts`, `modules/dexbot_class.ts`).
- **Fix**: `requiresOpenOrdersSync` flag lost for filtered-out fills — per-block-group reset overwrote the flag before filtered fills entered any block; captured pre-loop as `initialRequiresSync`, preserved post-loop, added fallback sync pass (`modules/dexbot_class.ts`).
- **Fix**: remove dead code and misleading comment in fill-processing fallback block — `requiresOpenOrdersSync = false` reset was unused after fallback sync; replaced with accurate scope-exit comment (`modules/dexbot_class.ts`).
- **Fix**: correct arithmetic comment in orphan-fill death spiral test — `// receives.amount=500000 at precision 5 → 5.0` (`tests/test_orphan_fill_death_spiral.ts`).
- **Fix**: remove stale `(mgr as any)` casts on `_orphanFillsCreditedAt` — both `mgr` and `bot.manager` are already typed `any`; casts were redundant noise (`modules/order/accounting.ts`, `tests/test_orphan_fill_death_spiral.ts`).
- **Fix**: remove stale `package.json` browser entry for `./dist/modules/order/runner.js` — source file deleted, build artifact no longer produced (`package.json`).
- **Chore**: delete `modules/cli_whitelist_args.ts` + `tests/test_cli_whitelist_args.ts` (unused CLI arg builder).
- **Chore**: delete `modules/order/runner.ts` (moved to `scripts/runner.ts` as standalone CLI grid calc debugger).
- **Chore**: remove lazy-loaded `runOrderManagerCalculation` re-export from `modules/order/index.ts`.
- **Refactor**: move `roundTo`, `fixedTo`, `roundToDecimals` from `modules/utils/math_utils.ts` to `modules/order/utils/math.ts` with re-export shim.
- **Docs**: update `docs/COW_INVARIANTS.md`, `docs/developer_guide.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` for `AsyncLock` re-entrancy — removed `fillLockAlreadyHeld` parameter references.
- **Test**: add `tests/test_orphan_fill_death_spiral.ts` — regression coverage for orphan-fill tolerance widening and missing-history-ID fill handling.

## [1.2.1] - 2026-07-20 - Code-Review Fixes, Stale-Totals Safety, Correction Reliability, StateManager Inline

### 2026-07-20

- **Fix**: only shift boundary for adopted CREATEs in uncertain broadcast recovery — previously all planned CREATEs (including discarded ones) shifted the grid boundary, causing phantom order positions on next cycle (`modules/dexbot_class.ts`, `tests/`).
- **Fix**: stale `accountTotals` no longer HARD-ABORTs COW commit — transient staleness logs WARN and schedules recovery instead of throwing `ACCOUNTING_COMMITMENT_FAILED`. Also refresh totals after bootstrap to prevent unnecessary full recovery on first maintenance cycle (`modules/order/accounting.ts`, `modules/dexbot_class.ts`).
- **Fix**: credential daemon memory leak — `socket.end()` after final write; `socket.destroy()` on close/error to prevent socket half-close accumulation (210MB RSS growth over 7d). Also switch credential policy's `assetRefResolutionCache` from unbounded `Map` to `LRUCache` (`credential-daemon.ts`, `modules/credential_policy.ts`).
- **Fix**: order correction reliability — deduplicate orphan cancels by filtering `_lastUnmatchedChainOrders` after successful cancel; retain entries in `ordersNeedingPriceCorrection` on transient errors (don't drop from retry queue); skip redundant sequential fallback when recovery already resolved all pending updates (`modules/order/sync_engine.ts`, `modules/order/utils/order.ts`, `modules/order/grid_reconcile.ts`).
- **Test**: add regression coverage for stale accounting and `orderGone` dedup paths.
- **Refactor**: inline `StateManager` class into `OrderManager` — removes ~220 lines of wrapper delegation. State fields become direct `OrderManager` fields; public methods (`isBootstrapping`, `isBroadcastingActive`, etc.) move directly onto the manager. Backward-compat getter/setter pairs retained for `_recoveryState`, `_gridRegenState`, `_lastIllegalState`, `_lastAccountingFailure` (`modules/order/manager.ts`).
- **Refactor**: merge `SyncResult` and `FillHistoryResult` into a single `SyncResult` type with optional fields. Rename `StateManagerState` → `ManagerStateSnapshot` in types. Update JSDoc references (`modules/types.ts`, `modules/order/sync_engine.ts`).
- **Fix**: `pauseRecalcLogging` timer leak on nested calls — now clears the old watchdog before setting a new one (`modules/order/manager.ts`).
- **Fix**: force-released sync mutations no longer persist orphaned entries in `ordersNeedingPriceCorrection` — snapshot queue length before sync, truncate on generation-mismatch discard (`modules/order/sync_engine.ts`).
- **Fix**: false-positive recovery after stale-totals COW commit — refresh `accountTotals` before `recalculateFunds()` when the last accounting failure was `'stale'` (`modules/order/manager.ts`).
- **Fix**: `isPlanningActive()` side-effect widened — extracted auto-clear to `_clearStaleBroadcastFlag()` called once per maintenance tick; `isBroadcastingActive()` is now a pure getter with no side-effects (`modules/order/manager.ts`, `modules/dexbot_maintenance_runtime.ts`).
- **Fix**: remove dead argument to `_markGridDirty` at boundary adjustment site (`modules/dexbot_class.ts`).

## [1.2.0] - 2026-07-19 - Credit-Only Mode, Boundary Shift Recovery, Order System Hardening

### 2026-07-19

- **Feat**: add `creditOnly: true` bot flag — skips all grid trading infrastructure (validation, orders, fills, sync) and runs only the credit runtime for MPA position management and credit offer maintenance (`modules/constants.ts`, `modules/bot_settings.ts`, `modules/dexbot_class.ts`, `modules/launcher/launch_modes.ts`, `unlock.ts`).
- **Feat**: `node unlock credit` — auto-discovers the first active credit-only bot, skips monolithic background daemon (`unlock.ts`).
- **Feat**: add LRU fee cache to `get_required_fees` calls — `tx/tx_cache.ts` with configurable TTL (default 24h, env `TX_BUILDER_FEE_CACHE_TTL_MS`); `builder.ts:setRequiredFees` checks cache before RPC, stores on success; `signing_client.ts` invalidates on broadcast errors matching `/fee/i` (`modules/bitshares-native/tx/tx_cache.ts`, `modules/bitshares-native/tx/builder.ts`, `modules/bitshares-native/signing_client.ts`).
- **Feat**: extract `LRUCache` from `resolvers.ts` to own module `lru_cache.ts` (`modules/bitshares-native/lru_cache.ts`, `modules/bitshares-native/resolvers.ts`).
- **Fix**: recover lost boundary shift after uncertain broadcast discard — when COW broadcast fails with `BROADCAST_DEADLINE`, the recovery discards unconfirmed CREATEs but never applies the boundary shift the fill cycle's COW plan would have committed. Now calculates net boundary shift from all planned CREATEs and applies it directly (`modules/dexbot_class.ts:3199-3244`).
- **Fix**: `effectiveBotName` used in `MONOLITHIC_BOT_INFO_FILE` instead of raw `botName` (`unlock.ts:630`).
- **Fix**: restore missing v1.1.13 header in CHANGELOG.md (`CHANGELOG.md`).
- **Fix**: `mgr.startPrice` → `mgr.config.startPrice` in fund recalculation — SPREAD orders would silently be excluded from fund totals if they ever carried positive size (`modules/order/accounting.ts:391-392`).
- **Fix**: remove dead `typeof workingGrid.getBaseVersion === 'function'` guard — `WorkingGrid` has no such method, fallback always triggered (`modules/order/utils/validate.ts:966`).
- **Fix**: `_applySync` `cancelOrder` dual-signature — normalized from bare-string/object overload to canonical object form (`{ orderId, clearSize? }`). Changed `grid_reconcile.ts:387` bare-string call; simplified sync_engine.ts dispatch (`modules/order/sync_engine.ts`, `modules/order/grid_reconcile.ts`).
- **Fix**: `_rebalanceState.toLowerCase()` null guard — `_rebalanceState` is always initialized but now has defensive `|| ''` (`modules/order/manager.ts:1056`).
- **Fix**: stale broadcast flag permanently blocking rebalancing — `isPlanningActive()` now delegates to `_state.isBroadcastingActive()` which auto-clears after 120s instead of using raw `isBroadcasting()` which never cleared (`modules/order/manager.ts`).
- **Fix**: orphan-fill tolerance widening consumed on first invariant check — `_orphanFillsCreditedAt` no longer consumed inside `_verifyFundInvariants`; persists through full fill cycle so all `recalculateFunds` calls see consistent tolerance (`modules/order/accounting.ts`).
- **Fix**: grid-bloat resync loop in `loadGrid` — added `Grid.isGridBloatGraceActive()` and `Grid.clearGridBloatFlag()` shared helpers; `loadGrid` checks grace window before requesting resync; maintenance runtime deduplicates inline grace logic (`modules/order/grid.ts`, `modules/dexbot_maintenance_runtime.ts`).
- **Fix**: AsyncLock `forceRelease` orphaned timers — `clearTimeout(timer)` before rejecting queued items to prevent stale no-op callbacks lingering in the event loop (`modules/order/async_lock.ts`).
- **Fix**: parallel node connect with `Promise.any` — fastest node wins; slow perpetual retry after max attempts stays in slow mode instead of looping back to exponential (`modules/bitshares-native/transport.ts`).
- **Fix**: subscription re-entrancy guard — prevents concurrent history scan races; per-page timeout + total deadline for `fetchFillHistoryEntries` with proper timer cleanup (no timer leak) (`modules/bitshares-native/subscriptions.ts`).
- **Fix**: fund accounting stale-fetch guard — refuses optimistic deduction when `accountTotals` exceeds `MAX_ACCOUNT_TOTALS_AGE_MS`; deduplicated in-flight recovery via stored `_pendingRecovery` promise (`modules/order/accounting.ts`).
- **Fix**: sync generation counter force-releases orphan callbacks; order ID re-verification before locking in reconciliation (`modules/order/sync_engine.ts`).
- **Fix**: `getOnChainAssetBalances` gains `includeCreditDeals` option to subtract credit deal collateral from free balance (opt-in, backward-compatible) (`modules/chain_orders.ts`).
- **Fix**: credit runtime TTL-gated staleness for MPA feed prices, credit conversion rates, and `_getOfferById` cache — stale cache returns null instead of silently using outdated values (`modules/credit_runtime.ts`).
- **Fix**: order logger drain deadline — discards remaining lines after 10s; `flush()` accepts configurable timeout (`modules/order/logger.ts`).
- **Fix**: restore `fillOp.order_id` in dedup log messages — `_isNewFillKey` lost orderId context during dedup extraction refactor; added optional `orderId` param so logs read "Skipping duplicate fill for X" instead of bare message (`modules/dexbot_class.ts`).
- **Fix**: replace hardcoded `'buy'/'sell'` string literals with `ORDER_TYPES` constants in `checkFundDrift` (`modules/order/utils/validate.ts`).
- **Refactor**: convert `Grid` class (28 static methods, zero instance state) to plain exported functions. Self-calls use direct function references. No behavioral change (`modules/order/grid.ts`, all callers).
- **Refactor**: extract shared `adjustBudgetForBtsFees()` to eliminate BTS fee-reservation logic duplicated between `Grid._getSizingContext()` and `getSideBudget()`. Both call sites now use the same canonical math. Preserves the `Math.min(allocated, sideFree - btsDeficit * share)` cap from `getSideBudget`. Consolidates the `calculateOrderCreationFees` call (previously duplicated across both branches) into a single site (`modules/order/utils/order.ts`, `modules/order/grid.ts`).
- **Refactor**: split `grid_reconcile.ts` (1550 lines) — extracted 22 internal helpers into `grid_reconcile_internal.ts` (1067 lines). Main file reduced to 454 lines with the 3 public exports plus imports (`modules/order/grid_reconcile.ts`, `modules/order/grid_reconcile_internal.ts`).
- **Refactor**: make `AsyncLock` re-entrant — added `_holding` flag + `isReentrant()` check so `acquire()` from within the same execution context runs the callback directly instead of queueing (which would deadlock). Eliminates the `fillLockAlreadyHeld: true` parameter threaded through 25+ call sites across `dexbot_class.ts`, `dexbot_maintenance_runtime.ts`, `sync_engine.ts`, `grid_reconcile.ts`, `grid_reconcile_internal.ts`, `grid.ts`, `accounting.ts`, and the CR runtime. All callers now rely on the lock's intrinsic `isReentrant()` check; the `gridLockAlreadyHeld` flag (a separate grid-level re-entry flag) is kept only for `syncFromOpenOrders` / `_applySync` caller-skip semantics which is not replaced by lock-level reentrancy (`modules/order/async_lock.ts`, all callers).
- **Fix**: `getSideBudget` BTS `BTS_RESERVATION_MULTIPLIER` fallback — when `config.feeParams.BTS_RESERVATION_MULTIPLIER` is missing, falls back to `FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER` instead of returning `undefined` (which propagated as `NaN` through fee calculations). Both branches in `getSideBudget` now use the same default-safe path; the `adjustBudgetForBtsFees` helper callee already had this fallback (`modules/order/utils/order.ts:1156`).
- **Chore**: replace hardcoded `'active'/'partial'` string literals with `ORDER_STATES.ACTIVE/PARTIAL` in `calculateRequiredFunds` (`modules/order/utils/validate.ts:200`).
- **Chore**: replace hardcoded `'buy'/'sell'` string literals with `ORDER_TYPES.BUY/SELL` in same function (`modules/order/utils/validate.ts:202-203`).
- **Chore**: document `pauseFundRecalc`/`pauseRecalcLogging` coupling — JSDoc explains when to pair them vs use independently (`modules/order/manager.ts:838-868`).
- **Chore**: safety watchdog on `pauseRecalcLogging` — auto-resets after `SAFETY_PAUSE_TIMEOUT_MS` to prevent permanent debug-log suppression from missed finally block (`modules/order/manager.ts`).
- **Chore**: make `protectCommittedOrders` always-on in `syncFromOpenOrders` — `_committedOrderIds` is atomically rebuilt on every COW commit and is self-cleaning; the flag was only ever true at call sites that already held the fill lock, and was removed along with `fillLockAlreadyHeld` as part of AsyncLock reentrancy cleanup (`modules/order/sync_engine.ts`).
- **Chore**: rename `OPERATIONS.LIQUIDITY_POOL` → `LIQUIDITY_POOL_EXCHANGE` for consistency with core protocol naming; add `OP_LIQUIDITY_POOL_EXCHANGE` and `OPERATION_NAMES[63]` (`modules/bitshares-native/serial/chain_constants.ts`).
- **Chore**: reduce `SUBSCRIPTION_SILENT_THRESHOLD_MS` from 5min to 2min for faster dead-subscription detection (`modules/constants.ts`).
- **Docs**: new Credit-Only Mode section in `docs/MPA_CREDIT_USAGE.md`; removed redundant sections from `AGENTS.md` (template, quick commands), shortened Browser-Safe Surface, collapsed Node-only list.
- **Test**: `test_bot_settings.ts` covers creditOnly validation positive and required-fields negative cases.
- **Test**: happy-path and edge-case coverage for COW auto-cancel unmatched orders (`tests/test_cow_structural_resync.ts`).

## [1.1.14] - 2026-07-19 - Node Blacklist Sync, Async-Lock ForceRelease Safety, Gap Regression Fixes

### 2026-07-19

- **Fix**: synchronize node-failure blacklisting across broadcast and health-check paths — `reportNodeFailure` centralized in `node_manager.ts` so both `BROADCAST_DEADLINE` errors and health-check misses share one 24h blacklist budget (3 failures). `onNodeFailed` callback threaded through `CredentialClientOptions`; dust cancel and `key_store` paths forward failures. Blacklist cooldown reduced from 7d → 24h (`modules/node_manager.ts:564`, `modules/dexbot_credential_client.ts:43`, `modules/dexbot_maintenance_runtime.ts:1593`, `modules/constants.ts`).
- **Fix**: prevent stale async-lock callback from stealing lock after `forceRelease` — added generation counter to `AsyncLock`; `forceRelease` increments the generation, invalidating any in-flight callback's tag. Stale `finally` block exits silently instead of releasing the lock from under a legitimate holder (`modules/order/async_lock.ts`).
- **Fix**: close six gap regressions in the v1.1.13 recovery hardening — (1) snapshot sanity check ported into `_recoverFromPersistedGrid` (centralized `_rejectCorruptedGridSnapshot`), (2) duplicate orphan cancellation in `sync_engine.ts:864`, (3) sync lock force-release scope documentation, (4) lightweight consistency check gated on `!_batchInFlight && !_pendingBroadcasts`, (5) `recoveryExhaustedAt` exposed in `getMetrics()`, (6) grid bloat detection with `Grid.isGridBloated` static method and maintenance-runtime re-check. Also: `committedOrderIds` atomic swap (no intermediate empty state), COW uncertain escalation → `requestStructuralGridResync` on failure, dead constant cleanup (`modules/dexbot_class.ts`, `modules/order/sync_engine.ts`, `modules/order/grid.ts`, `modules/dexbot_maintenance_runtime.ts`).
- **Fix**: browser-compat — classify 11 additional node-only modules in `AGENTS.md` and `package.json` `"browser": false` map (`credential_runtime`, `dexbot_credential_client`, `node_health_cache`, `process_discovery`, `graceful_shutdown`, `order/logger`, `order/export`, `order/runner`, `storage/node_adapter`, `key_store`, `market_adapter/ama_signal_runner`).
- **Chore**: remove unnecessary `./` prefix in `bin` paths.

## [1.1.13] - 2026-07-18 - COW Recovery Hardening, Fee Cache Persistence, Node Fallback

### 2026-07-18

- **Fix**: centralized node-fallback retry for BROADCAST_DEADLINE — `executeOperationsViaCredentialDaemon` now accepts `fallbackNodes: string[]`. On `BroadcastUncertainError` it automatically cycles through fallbacks with a 1 s gap before raising the last error. Dust cancel (`cancelOrderWithNodeFallback`) passes the bot's healthy-node list (excluding primary) through; COW batch and other callers can reuse the same mechanism by passing `fallbackNodes` in `extraOptions`. Adds per-request `nodeUrl` passthrough in the credential daemon protocol and structured audit-log `nodeUrl` fields for multi-node timeout correlation (`modules/dexbot_credential_client.ts:223-289`, `credential-daemon.ts:411-413`).
- **Fix**: extend committed-order protection to 5 additional recovery sync sites — `_recoverAfterMissingCreateResults`, `_createOrderFromGrid` failure, `_cancelChainOrder` verifiedAfterFailure, `_recoverStartupSyncFailure`, and `cancelDustOrders` verifiedAfterFailure now pass `protectCommittedOrders` to prevent virtualization of COW-committed orders during chain-lag recovery. `readOpenOrders` case forwards `protectCommittedOrders` from options (`modules/dexbot_class.ts`, `modules/order/grid_reconcile.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/order/sync_engine.ts`).
- **Fix**: resolve orphan-fill death spiral from same-block cascade — block-level fill batching groups fills by `block_num` before COW; uncertain broadcast delay-recheck waits up to 3 blocks before discarding planned CREATEs; unmatched orders absorbed inline in structural guard instead of hard-rejecting the batch; per-cycle auto-cancel cap bumped from 1 to 5 during recovery; orphan-fill invariant tolerance widened 5x while flag is set (`modules/dexbot_class.ts`, `modules/order/accounting.ts`).
- **Fix**: prevent duplicate orders at same price from ghost-fill + uncertain broadcast recovery — ghost-order slot preservation keeps `PARTIAL` state with `orderId` intact instead of virtualizing to `VIRTUAL/SPREAD`; uncertain broadcast recovery always runs `syncFromOpenOrders` after adoption instead of short-circuiting when all CREATEs appear adopted (`modules/order/sync_engine.ts`, `modules/dexbot_class.ts`).
- **Fix**: reconcile-on-not-found, fresh-snapshot recovery, persisted-grid runtime reload — UPDATE→CREATE fallback when buildUpdateOrderOp throws "Order not found" converts to CREATE with same price/size; CANCEL "not found" demoted to debug log; fresh chain snapshot re-read before uncertain-broadcast recovery sync; pre-retry reconcile before retrying `BroadcastUncertainError`; new `_recoverFromPersistedGrid` method mirrors startup path (`modules/dexbot_class.ts`).
- **Fix**: log asymmetric bounds detail for bots with only `asymmetricBounds` enabled — `rawAsymmetryFactor`, `appliedAsymmetryFactor`, `maxAsymmetryFactor` exposed as top-level result fields; log gate fires independently on `gridRangeScalingWhitelisted` with fallback chain (`market_adapter_service.ts`, `market_adapter.ts`).
- **Feat**: persist fee cache to disk and retry per-asset lookups — `FEE_CACHE_RETRY_ATTEMPTS` (3) and `FEE_CACHE_RETRY_DELAY_MS` (1000) constants; `_loadFeeCacheFromDisk` seeds in-memory cache on boot; `_saveFeeCacheToDisk` persists via `storage.writeJSON`; 3-attempt retry loop with linear backoff per asset preserves last good on-disk copy on final failure (`modules/constants.ts`, `modules/order/utils/system.ts`, `modules/paths.ts`).

## [1.1.12] - 2026-07-18 - Committed Order Protection, Ghost Order Cleanup, Price Correction Queue, AMA Config Centralization

### 2026-07-18

- **Fix**: process queued price corrections on startup and in maintenance loop — corrections queued by syncFromOpenOrders (via ordersNeedingPriceCorrection) were only processed inside _consumeFillQueue, which only runs when new fills arrive. For an idle market where sync detects a price mismatch during startup, the correction sat in the queue indefinitely, stalling the pipeline. Now processed immediately after startup sync and at the start of every maintenance cycle (`modules/dexbot_class.ts:1339`, `modules/dexbot_maintenance_runtime.ts:1399`).
- **Fix**: protect committed orders from recovery sync virtualization — during UNCERTAIN broadcast and fund-invariant recovery, the full two-pass syncFromOpenOrders could virtualize orders that were correctly placed by prior successful COW commits when the chain snapshot lags behind confirmed transactions. New `_committedOrderIds` set tracked across COW commit boundaries; PASS 1 virtualization guard skips any orderId in the set (`modules/order/manager.ts`, `modules/order/sync_engine.ts`, `modules/dexbot_class.ts`, `modules/order/accounting.ts`).
- **Fix**: cancel residual ghost orders left on chain by other-side rounding — when a fill leaves a tiny residual where opposite-asset value rounds to 0 at blockchain precision, the grid slot was virtualized but the chain order was never cancelled. New `ghostOrderId` return field drains orphan cancellations via a per-session guarded set to avoid repeat attempts (`modules/dexbot_class.ts`, `modules/order/sync_engine.ts`, `tests/test_ghost_order_fix.ts`).
- **Fix**: remove hardcoded XRP-BTS defaults from analysis scripts and docs — all 6 analysis scripts now require `--bot-key` explicitly at runtime; documentation uses `EXAMPLE-BOT` placeholders instead of `XRP-BTS` (`analysis/analyze_dynamic_weight.ts`, `analysis/analyze_volatility.ts`, `analysis/analyze_kalman.ts`, `analysis/analyze_regime.ts`, `analysis/analyze_regime_windows.ts`, `analysis/analyze_derivatives.ts`, `docs/*.md`, `market_adapter/README.md`).
- **Feat**: centralize AMA config resolution in bot_key_utils for analysis tools — shared `loadBotMeta`, `resolveAmaConfig` (inline > profile > built-in with preset merge, erSmoothPeriod on all paths, fast/slow swap guard), and `resolveAmaKey` extracted from individual scripts. Dynamic chart legend now shows the resolved AMA label (AMA1/AMA2/AMA3/AMA4) instead of hardcoded AMA3 (`analysis/bot_key_utils.ts`, `analysis/analyze_dynamic_weight.ts`, `analysis/analyze_tradingview.ts`, `analysis/trend_detection/dynamic_weight_chart_generator.ts`).

## [1.1.11] - 2026-07-18 - npm publish, README install options, CLI dist resolution, .npmrc ignore

### 2026-07-18

- **Feat**: prepare npm publish as `dexbot` package — renamed package from `dexbot2` to `dexbot`, added `files`/`engines`/`os`/`preferGlobal` metadata, npm lifecycle scripts (`version`/`postversion`/`postinstall`), and keywords. Profile directory now respects `DEXBOT_PROFILE_ROOT` / `DEXBOT2_ROOT` env vars with auto-respawn fallback to `~/.config/dexbot2` on read-only project root. CLI scripts resolve from `dist/` via `buildRuntimeScriptArgs` instead of shelling out. New `dexbot clear-orders`, `clear-market-adapter`, `clear-all` commands. Shell scripts updated for `DEXBOT_PROFILE_ROOT` (`dexbot.ts`, `modules/paths.ts`, `pm2.ts`, `package.json`, `scripts/`).
- **Docs**: add `npm i dexbot` as Option A in Quick Start and Installation sections — users can now install from npm without cloning the repo; commands use `node dexbot` (`README.md`).
- **Docs**: clarify sync timeout log message — rephrase "result discarded" to "timeout won the race; next sync will reconcile chain state" for operator clarity (`modules/order/sync_engine.ts:372-373`).
- **Chore**: add `.npmrc` to `.gitignore` — prevents accidental commit of npm credentials (`.gitignore`).

## [1.1.10] - 2026-07-17 - Asymmetric Bounds Decoupling, CLI Stats Enhancement

### 2026-07-17

- **Feat**: show `range`/`weight` indicators in `stats` output — reads whitelist flags and appends them alongside AMA version: `example-bot (ama1, range, weight)` (`unlock.ts:824-834`).
- **Feat**: add `stats` as CLI alias for `status` command (`dexbot.ts:167,231`).
- **Fix**: propagate `asymmetricBounds` through snapshot writer, grid reader, and snapshot loader — three sites needed the root-level fallback for the `dynamicWeight: false, asymmetricBounds: true` path to work end-to-end (`market_adapter.ts`, `grid.ts`, `system.ts`).
- **Fix**: decouple asymmetric bounds metrics from `dynamicWeight` flag — `asymmetryMetrics` now always computed when `isAsymmetricBoundsWhitelisted`, using `amaSlope` as fallback data source when `dynamicWeightsPayload` is absent; display reads root-level `snapshot.asymmetricBounds` (`market_adapter_service.ts`, `analyze-orders.ts`).

## [1.1.9] - 2026-07-16 - Immediate Dust Cancel, Duplicate Price Guard, Cleanup & Simplification

### 2026-07-16

- **Fix**: restore total-operation timeout in `syncFromOpenOrders` — the earlier simplification replaced `Promise.race` with `AsyncLock`'s built-in timeout, which only covers queue-wait time. Re-added explicit `Promise.race` over the entire lock-acquire-plus-execution so a hanging sync (slow RPC) is still caught. Spurious-timeout recovery not restored (microtask race is negligible at 20s granularity) (`modules/order/sync_engine.ts:362-394`).
- **Fix**: harden `persistGrid` dirty-flag detection — replaced `arguments.length === 0` with `snapshotOrders === undefined` so the flag is correctly cleared even when callers pass `undefined` explicitly (e.g. `flushGridDirty` at `manager.ts:1143`, or test-wrappers forwarding arguments). Fixes `test_grid_dirty_flag_persistence.ts` DIRTY-011 (`modules/order/manager.ts:1791`).
- **Fix**: update `test_dust_rebalance_logic.ts` weight assertion — the `refreshDynamicWeightDistribution` calls were intentionally removed as redundant; the test now asserts the constructor/mock weights persist unchanged through dust cancel (`tests/test_dust_rebalance_logic.ts:293-302`).
- **Fix**: guard duplicate price level before any PASS 2 adoption attempt — moved the check to the top of the loop (before `findMatchingGridOrderByOpenOrder`), removed `matchedGridOrderIds` exclusion from the guard (permits inspection of siblings already adopted in the same PASS 2 iteration). 1 new regression test (`9ce0bd26`).
- **Fix**: wrap dust-cancel 5-min health check in fill-processing lock — extracted `_setupDustHealthCheckInterval` with `fillLockAlreadyHeld` option threaded through `cancelDustOrders`/`_cancelDustOrders`. 1 new regression test (`e9aa6372`).
- **Fix**: remove deferred dust-cancel timer system — cancel dust immediately on detection instead of timer-based deferral. Removed `_dustSinceMap`, `_dustRetryCount`, `_dustMaintenanceTimer`, `scheduleDustMaintenanceCheck`, `seedDustTimersFromPartialUpdates`, `getPendingDustDelayMs`, `syncDustMaps`, `recordDustFirstSeen`, `clearDustMaintenanceTimer`. Dust persistence removed from `storeMasterGrid`/`persistGridSnapshot`/`loadDustSince`/`loadDustRetryCount`. `DUST_CANCEL_DELAY_SEC` retained in `GRID_LIMITS` as unused for backward compat. Removed `dustCancelTriggeredAt`/`dustRecoveredFromChain` from `SyntheticFill`; simplified `DustCancelResult.batchResult`. Dust cancel delay prompt removed from interactive settings. Doc references updated across 5 files, ~740 lines of timer infrastructure deleted (`5224eb76`).
- **Feat**: unify order analyzer formatting and forward CLI args — `formatCurrency` for AMA price display, pico/femto/atto SI prefixes, comma separators for values >=1000, `--export` flag forwarded through `dexbot.ts` to analyze-orders script (`4b9d91da`).
- **Refactor**: dedup extraction, timer symmetry, lock cleanup, and sync timeout simplification — extracted `_isNewFillKey` helper (6 dedup blocks → ~15 lines), extracted lock wrapper from `_reconcileAfterUncertainBroadcast`, removed `Promise.race` + spurious-timeout recovery from `syncFromOpenOrders` (later revised — see fix above). Added `level` field to `AsyncLock`. Fixed `structuralResyncRequested` stripped in recovery setter and missing `_setupDustHealthCheckInterval` in trigger-reset startup path (`3a8656db`).
- **Refactor**: simplify stale-cleaned tracking, remove dead recovery data and redundant weight refresh calls — `_staleCleanedOrderIds` changed from `Map<any, any>` to `Map<string, number>` with simple TTL (removed gridId tracking, recycled-slot tombstone, 500-entry cap, `_fillRecordRetentionMs`). Removed 7 dead `lastFailureReason` write sites. Removed unreachable `_gridSidesUpdated.size > 0` pipeline check. Removed 4 redundant `refreshDynamicWeightDistribution` calls including the per-fill-batch hot path. Fixed 3 pre-existing test failures (`f5cfcb8d`).

## [1.1.8] - 2026-07-16 - Dust Timer Persistence, HTML Order Export, Chart Controls, Doc Cleanup

### 2026-07-16

- **Fix**: dust cancel timer now armed from all 4 detection entry points — reconnect safety-net sync, post-reset fill processing, periodic 5-min dust health check, and post-full-resync re-detect each call `_scheduleDustMaintenanceCheck` after seeding. Post-reset path wrapped in `_shuttingDown` guard (`038b81cb`).
- **Feat**: persist dust-cancel timer state (`_dustSinceMap`/`_dustRetryCount`) across restarts via grid snapshot — `storeMasterGrid` gains params, `persistGridSnapshot` backward-compat fallback, startup hydration before `_persistAndRecoverIfNeeded` with valid-order-ID pruning. Browser-safety: `exitAfterStderrDrain` in `Runtime` interface replaces direct `process.*` calls in `graceful_shutdown.ts`. 2 new persistence tests (`4c7c3afc`).
- **Feat**: HTML order analysis export with self-contained dark-themed report — CLI-matched ANSI colors, active/virtual contrast, `--export` shorthand, Dark Reader lock. `node dexbot help` command handler added (`9d0cdfba`).
- **Feat**: overhaul TradingView chart input controls — text inputs + custom stepper buttons (hold-to-repeat), Init Offset toggle, precision handling (`469c9ffd`).
- **Feat**: add lambda-vs-slow analysis script — 1D scan fixing ER=781/Fast=5.2, optimal Slow per λ, three-panel chart (`aa9a96c9`).
- **Chore**: trim verbose JSDoc/headers across 6 files, document `critical` LOG_LEVEL in README, dedupe `.gitignore`, clarify force-push in AGENTS.md (`f07931c9`).

## [1.1.7] - 2026-07-15 - Dust Cancel Hardening, Bootstrap Lifecycle, Order Analysis AMA Key, Doc Cleanup

### 2026-07-15

- **Fix**: dust cancel hardening — post-fill path missed pre-gate seeding; `executeMaintenanceLogic` missing post-seed timer schedule; `cancelDustOrders` prune skipped `_dustRetryCount` (extracted shared `syncDustMaps` helper); disable branch didn't clear retry map; no retry backoff on persistent failures (`MAX_DUST_CANCEL_RETRIES=10`); refetch errors burned cancel retry budget (isolated via inner try/catch); post-cancel reseed used stale weights; `performGridResync` missing weight refresh + stale ghost entries. 4 new tests. (`dbf68037`).
- **Fix**: bootstrap lifecycle consistency — `grid.ts` wraps `fullResync`/`initializeGrid` in try/finally to prevent stuck bootstrap flags; `dexbot_class.ts` wraps `reconcileAndPersistGrid` in bootstrap guards. Recovery state observability added (`_recoveryState.lastFailureAt/lastFailureReason`) across 5 deferred-failure sites (`ae8cd2eb`).
- **Fix**: lock contention reduction — split `reconcileGridOrders` into Phase 1 (compute + cancel under lock) and Phase 2 (batch ops outside lock); capture fund snapshot under lock with pre-flight verify to catch TOCTOU (`ae8cd2eb`).
- **Fix**: broadcast flag staleness — `isBroadcastingActive` auto-clears after 120s to prevent stuck flag; lock hierarchy doc with reentrancy warning (`ae8cd2eb`).
- **Fix**: spurious timeout mitigation — extract syncPromise from `Promise.race` with re-race recovery in both `sync_engine.ts` and `dexbot_class.ts` (`ae8cd2eb`).
- **Fix**: math hardening — clamp price tolerance sats to `MIN_ORDER_SIZE_FACTOR`; cap at `PRICE_TOLERANCE_MAX_PERCENT`/`MIN_ABSOLUTE`; warn on negative rounding diff (`ae8cd2eb`).
- **Feat**: resolve AMA key in `node dexbot order` output — shows specific AMA variant (AMA1/AMA2/AMA3/AMA4) instead of generic `AMA:` label; displays `Grid:` for numeric `gridPrice` bots; pool/book/startPrice bots omit the line. Bounds percentage shows `+`/`-` sign based on trend direction. New `testResolveAmaKey` test (`302cec96`).
- **Docs**: comprehensive doc cleanup across 30 files — ~25 JSDoc blocks added in claw subsystem; order subsystem method-table renumbering (grid 24→25); corrected stale references (KAMA→Kalman, .js→.ts, 2.5%→1.00% AMA delta threshold default); removed duplicate MEMU_RUNNER_SCRIPT path; removed stale FILLED/CANCELLED state refs from order index; QTradeX branding removal (`ac91bc28`).

## [1.1.6] - 2026-07-14 - Dust Detection Fix, Dedup Hardening, Chart AMA Alignment, amaS% Revert

### 2026-07-14

- **Fix**: dust detection now runs on partial-only fill batches — post-fill dust check was gated on `fullFillCount > 0`, so a partial fill that reduced an order below the dust threshold would be undetected until the 4-hour periodic blockchain fetch. Added `hasAnyFills`/`shouldRunDustDetection` independent of full fills, `performPeriodicGridChecks` after sync ticks, and targeted drift reconciliation after fill processing (`17f7cbc3`).
- **Fix**: orphan fill double-credit race — orphan fills `continue`d before reaching Layer 1/2 dedup checks, allowing a second delivery to slip through the async gap. Replicated Layer 1/2 dedup in all three orphan paths. Extended stale-cleaned tombstone retention from 5 min to 7 days (`_fillRecordRetentionMs`) with 500-entry hard cap. Subscription health watchdog now resubscribes once per feed stall instead of redundantly per account; re-entrancy guard added (`18ed90da`).
- **Fix**: TradingView chart AMA resolution drift — chart generator used `DEFAULT_AMA_KEY` (AMA3) instead of `selectedProfile.defaultAma` for `gridPrice: "ama"` and non-AMA grid prices. Added `.trim().toLowerCase()`, `AMA_KEYWORDS` Set, and built-in constants fallback to match the runtime's tolerant chain (`2aeffda7`).
- **Revert**: restore `DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT` from 0.08 back to 0.085 — reverses the v1.1.3 retune; requires a slightly stronger trend before the AMA weight offset reaches full effect (`modules/constants.ts`, `analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md`).

## [1.1.5] - 2026-07-14 - AMA Refit, Oversized Credit Deal Splitter & Per-op Borrow Cap

### 2026-07-14

- **Feat**: AMA refit on 3yr pool 133 1h data (2023-07 → 2026-07) with per-AMA λ weights (0.0031/0.0025/0.00185/0.0013) and SMA-warmup-aligned optimizer. Slow periods updated AMA1 73.3→62.1, AMA2 80.6→71.7, AMA3 88.7→82.7, AMA4 102.4→95.5. Default slow range narrowed 40-160→35-140. New `--fixEr` / `--fixFast` CLI flags fix ER=781 / Fast=5.2 and search Slow only. CLI validation adds `--ama1Cap`–`--ama4Weight` properties, removing 8 `(out as any)` casts. Stale references updated in market_adapter/README.md, TradingView README, and two test fixtures (`analysis/ama_fitting/optimizer_high_resolution.ts`, `modules/constants.ts`, `market_adapter/README.md`, `analysis/tradingview/README.md`, `tests/test_market_adapter_log_format.ts`, `tests/test_market_adapter_logic.ts`).
- **Feat**: add `maxBorrowAmountPerOperation` config field and `_splitOversizedCreditDeals` — when a credit deal exceeds `maxBorrowAmountPerOperation`, maintenance splits it into equal pieces via repay+reborrow cycles with 6s spacing. Planner clamps debtDelta by per-op cap on top of the total `maxBorrowAmount` ceiling. `min_deal_amount` guard skips deals where any piece would be below the offer's minimum deal size. `MAX_PIECES_PER_CYCLE=48` (new `TIMING.CREDIT_DEAL_SPLIT_MAX_PIECES`) prevents unbounded cycles. `_splitInFlight` concurrency guard prevents `runMaintenance` / `runCreditWatchdog` collisions. 6 new tests cover per-op rejection, offer-selection capping, correct split arithmetic, within-limit skip, no-limit skip, and error-pattern match (`modules/types.ts`, `modules/bot_settings.ts`, `modules/credit_runtime.ts`, `modules/cr_planner.ts`, `tests/test_credit_runtime.ts`).
- **Fix**: settle-delay resolution for credit splits now reads from the `TIMING` constant instead of `bot.config.TIMING.BLOCKCHAIN_SETTLE_DELAY_MS` — consistent with `dexbot_maintenance_runtime.ts`. Any per-bot `TIMING.BLOCKCHAIN_SETTLE_DELAY_MS` override in `bots.json` is no longer honoured for split pacing (`modules/credit_runtime.ts`).

## [1.1.4] - 2026-07-14 - AMA4 Slow Correction, Optimizer Range Tighten, Post-tag Doc Sync

### 2026-07-14

- **Fix**: correct AMA4 slowPeriod from 107.4 to 102.4 — aligns AMA4 with the same λ=0.0025 refit applied to AMA1-3 in v1.1.3. Fixes stale slowPeriod references in market_adapter/README.md, test fixtures, and TradingView chart generator (`modules/constants.ts`, `market_adapter/README.md`, `tests/test_market_adapter_log_format.ts`, `tests/test_market_adapter_logic.ts`, `analysis/tradingview/tradingview_uplot_chart_generator.ts`).
- **Feat**: narrow optimizer slow search range from 50-200 to 40-160 — focuses the geometric grid on the range where fitted winners consistently land, reducing wasted evaluations at uncompetitive extremes (`analysis/ama_fitting/optimizer_high_resolution.ts`).
- **Docs**: sync v1.1.3 release notes with amaS% retune (0.085→0.08), update DYNAMIC_WEIGHT_RESEARCH.md knob table, correct EVOLUTION.md commit count for v1.1.3 (2→4) and summary to include the amaS% retune (`CHANGELOG.md`, `analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md`, `docs/EVOLUTION.md`).

## [1.1.3] - 2026-07-13 - AMA Refit λ=0.0025, amaS% Retune, tsx Compatibility, Doc Fixes

### 2026-07-13

- **Refactor**: `BASE_DISTANCE_WEIGHT` / `DISTANCE_WEIGHT_STEP` linear step model replaced with individual per-AMA default `distanceWeight` values (0.0025, 0.0022, 0.0019, 0.00165). Added `--ama1Weight` through `--ama4Weight` CLI flags for per-AMA overrides (any subset, no all-or-none requirement). Simplified `lambdaSuffix` to always use `_w<λ1>_<λ2>_<λ3>_<λ4>` format. Removed obsolete `baseDistanceWeight` / `distanceWeightStep` / `customWeights` metadata fields (`analysis/ama_fitting/optimizer_high_resolution.ts`).
- **Docs**: expanded `analysis/ama_fitting/README.md` — added Auxiliary Tools section (calibrate_convergence_er.ts, analyze_ama_price_changes.ts), documented per-AMA default weight table and individual `--ama1Weight`–`--ama4Weight` override flags, updated output filename suffix to `_w<λ1>_<λ2>_<λ3>_<λ4>` format, added market_adapter hot-reload reference, cleaned up asset table and fetch path (`analysis/ama_fitting/README.md`).
- **Docs**: expanded `analysis/README.md` — added derivatives analysis entry and `npm run analysis:derivatives` script, fixed placeholder in trade_profitability CLI example, added missing `--file` examples for analyze_regime and analyze_kalman, linked trend_detection/README.md (`analysis/README.md`).
- **Docs**: expanded `analysis/bot_fitting/README.md` — documented shared_utils.ts, auto-derive behavior for `--results`, default ratio values, output filenames, CLI tuning flags table, and worker-thread parallelization (`analysis/bot_fitting/README.md`).
- **Docs**: updated `analysis/tradingview/README.md` — added `--scale` alias and date range fetching note, consolidated market adapter source section, updated default AMA slow period to 88.7 (`analysis/tradingview/README.md`).
- **Docs**: changed `--bot-key` from required to optional in DYNAMIC_WEIGHT_RESEARCH.md; fixed markdown link formatting in trend_detection/README.md (`analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md`, `analysis/trend_detection/README.md`).
- **Docs**: updated EVOLUTION.md summary and commit count (`docs/EVOLUTION.md`).
- **Chore**: reduce `DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT` from 0.085 to 0.08 — makes the AMA channel reach maximum influence more easily for improved responsiveness in trending markets (`665ab207`).

## [1.1.2] - 2026-07-13 - AMA Optimizer Improvements, Constants Tuning & Doc Sync

### 2026-07-13

- **Feat**: optimizer now auto-generates an interactive HTML chart alongside results JSON — uses `generateHTML` from `lp_chart_core` to render the four winning AMAs against LP price data (`analysis/ama_fitting/optimizer_high_resolution.ts`).
- **Feat**: output filenames include λ and step suffix (e.g. `_l0_0022_s0_0002`) for easy comparison across runs (`analysis/ama_fitting/optimizer_high_resolution.ts`).
- **Feat**: `export =` replaced with `module.exports =` in optimizer to fix `tsx v4` strip-only mode compatibility (`analysis/ama_fitting/optimizer_high_resolution.ts`).
- **Fix**: hardcoded `REPOS_THRESHOLD = 0.004` (0.4%) removed — `calcReposRate` replaced by `trackRepositions` wired to `MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT`. Analyzer now uses the production threshold (`analysis/ama_fitting/optimizer_high_resolution.ts`, `analysis/ama_fitting/analyze_ama_price_changes.ts`).
- **Fix**: `trackRepositions` extracted to shared utility then inlined back as a simplified single-threshold function — removed untracked shared file, kept logic in `analyze_ama_price_changes.ts`.
- **Fix**: all four AMA cap quantiles produced identical winners with constant λ — re-enabled `DISTANCE_WEIGHT_STEP = 0.0002` so λ varies per AMA for a clean tight-to-loose spectrum (`analysis/ama_fitting/optimizer_high_resolution.ts`).
- **Tune**: AMA1–AMA4 slow periods refitted on pool 133 1h data (2023-05 → 2026-05) with optimizer λ=0.0022/step=0.0002. Results: AMA1=80.6, AMA2=84.6, AMA3=93.1, AMA4=107.4 (`modules/constants.ts`).
- **Tune**: `BASE_DISTANCE_WEIGHT` set to 0.0022, `DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT` set to 0.085, amaS% knob range narrowed to 0.04–0.12 (`analysis/trend_detection/dynamic_weight_chart_generator.ts`, `modules/constants.ts`).
- **Docs**: sweep AMA slow values (112.7→93.1), tsx→node dist command updates, unified comparison chart notes, and amaS% research range in 5 documentation files.
- **Chore**: add `"tsx": { "tsconfig": true }` to root `package.json` (mitigation for `export =` in tsx v4).
- **Chore**: version bumped to 1.1.2 across all manifests.

## [1.1.1] - 2026-07-12 - Auto-startup Migration, Error Handling & Cleanup

### 2026-07-12

- **Feat**: auto-run `scripts/migrate_bot_keys.ts` on every bot startup — migration now runs from `dexbot.ts`, `bot.ts`, and `unlock.ts` so users who update the bot code automatically get their state files renamed without a manual step. Logs errors to stderr on failure (`scripts/migrate_bot_keys.ts`, `dexbot.ts:140`, `bot.ts:70`, `unlock.ts:89`).
- **Fix**: `runMigration()` now tracks JSON-key rewrites (whitelist, market adapter state/centers) in its return value — the CLI path no longer prints "No migrations needed" when only JSON keys were updated (`scripts/migrate_bot_keys.ts:291-297`).
- **Fix**: migration call in entry points wraps `require()` inside try/catch — import-time failures no longer crash silently; all errors are logged (`dexbot.ts:141`, `bot.ts:71`, `unlock.ts:90`).
- **Chore**: remove unused `scripts/query_credit_borrowers.ts` — no internal references.
- **Chore**: version bumped to 1.1.1 across all manifests.

## [1.1.0] - 2026-07-12 - Unique Bot Names, Dust Timer Fix & Credit Collateral Switching

### 2026-07-12

- **Feat**: remove stable ID suffix from botKey generation — `createBotKey()` for named bots now returns `sanitizeKey(name)` only, no `-id` or `-index` suffix. Bot identity is solely the sanitized bot name; duplicate names are enforced at all write paths (`modules/account_orders.ts:101`, `claw/modules/dexbot_profiles.ts:593`).
- **Feat**: enforce unique bot names across all write paths — `assertNoDuplicateBotKeys()` runs before every `bots.json` write: `applyBotSettingsPatch`, `updateBotSettings` (claw bridge), and `saveBotsConfig` (CLI editor). Duplicate sanitized names are rejected with a clear error (`modules/bot_settings.ts:300`, `claw/modules/dexbot_profiles.ts:1097,1235`, `modules/account_bots.ts:119`).
- **Feat**: add `scripts/migrate_bot_keys.ts` — one-time migration that renames order files, dynamic grids, triggers, candle files, logs, credit state, whitelist keys, and market adapter state/centers from the old `name-id`/`name-index` pattern to the new `sanitized-name` only format. Handles both `a1b2c3d4` stable ID and numeric index suffixes (`scripts/migrate_bot_keys.ts`).
- **Feat**: show bot name in order analyzer header, dim timestamp — adds `botName` field to analysis result, renders bot name after pair on the header line, timestamps displayed in gray (`5179b87d`).
- **Feat**: collateral switching on credit renewal — allow changing `collateralAsset` in bots.json to migrate existing credit deals to different collateral on next renewal. Deals with mismatched `collateralAssetId` are flagged with `collateralMismatch: true`, excluded from normal reborrow, and placed under the new posKey (`b6eeb4ec`).
- **Fix**: remove `_dustSinceMap.clear()` cascade that broke dust timers — wholesale clear in `executeMaintenanceLogic` and `performGridResync` destroyed firstSeen timestamps for all tracked orders when a single entry's cancel failed persistently. Timers now survive individual API errors, preserving the 30-second cancellation deadline (`2c478731`).
- **Refactor**: remove `_stableBotId()`, `persistMissingIds()`, and `id` field from normalization in `modules/bot_settings.ts`, `claw/modules/dexbot_profiles.ts`, and `market_adapter/inputs/fetch_cex_synthetic_data.ts` — stable IDs were a workaround for non-unique names and are no longer generated or persisted.
- **Fix**: `modules/credit_runtime.ts:293` — removed old ID-suffixed fallback in `botKey` construction; now uses `createBotKey()` directly with no ID fallback path.
- **Test**: update `test_bot_key_utils.ts` assertions — all 20 checks updated for the new "named bots use sanitized name only" rule.
- **Docs**: update `scripts/README.md` — fix typecheck description, add missing npm scripts and undocumented script entries (`69712e41`).
- **Docs**: update `modules/README.md` — add new module entries: `runtime_settings.ts`, `logger_state.ts`, `child_env.ts`, `headless_password.ts`, `market_adapter_watchdog.ts`, `monolithic_runtime.ts`, `status_reporting.ts`, `bitshares-native/index.ts` (`69712e41`).
- **Docs**: fix logging per-bot Q&A in `LOGGING.md` — per-bot logging customization `logging` field in bots.json is now documented with usage example and source references (`d7e34a98`).
- **Docs**: reorganize PM2 symlink entry out of CORE MAINTENANCE in scripts README — "Create PM2 Bot Symlinks" runs automatically on PM2 start, no longer a user-facing script entry (`9c21a560`).
- **Chore**: version bumped to 1.1.0 across all manifests.

## [1.0.14] - 2026-07-11 - Per-Bot Runtime Settings Override Pipeline & Doc Alignment

### 2026-07-11

- **Feat**: centralized per-bot runtime settings with override pipeline — bot configs previously read grid limits, fee params, timing, and increment bounds directly from `constants.ts`. A new `runtime_settings.ts` merge pipeline resolves settings from constants → market adapter globals → pair overrides → per-bot overrides. CamelCase-to-SCREAMING_CASE key conversion and nested object support. New `test_runtime_settings.ts` covers defaults, overrides, nested objects, and minimal config (`4e8ccc91`).
- **Docs**: comprehensive doc sweep aligning 13 documentation files with current codebase state — architecture diagrams, logging references, workflow procedures, security details, evolutionary history, COW invariants, credential security, DEXBot comparison, fund accounting, grid recalculation, and all four READMEs updated for accuracy and readability (`54e03c21`).
- **Fix**: correct TOC anchor links for emoji-prefixed headings in README — GitHub strips emoji from headings, adding a leading hyphen to anchors. All 10 Contents links now point to the correct `#-heading` slug (`4c4eeae1`).
- **Docs**: improve README scannability across four READMEs — added tables of contents, "Which section do I need?" quick-reference tables, and wrapped large parameter/file reference blocks in `<details>` collapsible sections for `README.md`, `claw/README.md`, `docs/MPA_CREDIT_USAGE.md`, and `market_adapter/README.md` (`1638a887`).
- **Chore**: version bumped to 1.0.14 across all manifests.

## [1.0.13] - 2026-07-10 - Grid Persistence Safety, Dust Pipeline Fix & Net Inventory Lots

### 2026-07-10

- **Fix**: persist master grid mutations made outside COW broadcast path — master grid changes via `_updateOrder`, sync engine size corrections, orphan adoption, and surplus-type-mismatch cancellations were never persisted because persistence was centralized in the COW broadcast success path. Seven gap sites fixed plus an end-of-tick dirty-flag safety net. New tests: `test_grid_dirty_flag_persistence.ts`, `test_grid_persistence_guard.ts`, `test_grid_persistence_warn.ts` (`3298f32a`).
- **Fix**: run dust check before pipeline gate — partial fills below dust threshold are now detected even when the pipeline is blocked (e.g. by pending price corrections from startup sync). A new `recordDustFirstSeen` helper starts the 30s cancellation timer from first detection so dust is cleared immediately when the pipeline empties. Changed `RUN_LOOP_DEFAULT_MS` from 5s to 5min for a more reasonable open-orders sync loop default (`8b9d3150`).
- **Fix**: use net inventory lots in trade profitability analyzer — buy lots now store net receives (baseAmount − marketFeeReal), so inventory matching reflects what the account actually held. Added EffBuy column to `--trades` detail output; skip fills with unresolved fee precision instead of silently setting fee to 0 (`70543e94`).
- **Docs**: improve analysis README readability for non-technical users — added question→tool mapping, Key Terms glossary, plain-English calibration workflow explanation, and reorganized sections (`51d7468e`).
- **Chore**: version bumped to 1.0.13 across all manifests.

## [1.0.12] - 2026-07-09 - Whitelist Normalization & CI Updates

### 2026-07-09

- **Fix**: normalize bot entries before whitelist key generation — bot names with mixed formatting now produce consistent whitelist keys, preventing false "not whitelisted" rejections during restart/stop operations (`988bc5a7`).
- **Fix**: remove green color from ecosystem config success log — the log entry now uses neutral formatting to avoid visual confusion with error states in terminal output (`2e72ee92`).
- **Ci**: bump docker actions to Node 24-compatible versions — CI pipeline actions updated to work with the latest Node.js runtime (`273ec3e6`).
- **Chore**: version bumped to 1.0.12 across all manifests.

## [1.0.11] - 2026-07-09 - Live bots.json, Drawdown Stability & Market Fee Model

### 2026-07-09

- **Fix**: prefer live `bots.json` over stale snapshot in restart/stop/delete summaries and status display — the launcher was reading a cached snapshot captured at startup, causing stale bot metadata when `bots.json` changed at runtime (`02e9d9f1`, `71e00e55`).
- **Fix**: refresh `launchedBotNames` on restart, pruning stale whitelist entries — restarted bots were blocked by their own stale PID-based whitelist entries from the previous lifecycle (`2c4cc202`).
- **Fix**: always establish stable peak for drawdown after 10 trades — early drawdown tracking now waits for a stable high-water mark before computing max drawdown, preventing misleading spikes on cold-start data (`413a455b`).
- **Fix**: show Bounds line for all AMA bots, hide `(0%)` when no asymmetry — the `analyze-orders` Bounds display was incorrectly suppressed for non-AMA bots (`672a7630`).
- **Feat**: implement BitShares market fee model in trade profitability analysis — `trade_profitability.ts` now accounts for the actual BitShares market fee schedule (maker/taker, fee tiers) instead of using a flat percentage, improving PnL accuracy for high-volume accounts (`454bff6a`).
- **Feat**: add grid range scaling display and signed delta to `analyze-orders` — shows the grid range as a percentage of the mid-price and the signed difference between current price and grid center, giving operators a quick visual on grid positioning (`af50b4f0`).
- **Refactor**: fee allocation, ESM imports, multi-quote safety, and metric naming in `trade_profitability.ts` — per-lot fee allocation, proportional fee splitting across legs, ESM-compatible imports, and clearer metric naming (`622f2880`, `8fd6a21d`).
- **Chore**: version bumped to 1.0.11 across all manifests.

## [1.0.10] - 2026-07-08 - PnL Metrics Overhaul, Kalman Tuning & Bot Discovery Fix

### 2026-07-06

 - **Fix**: remove cancel-ratio pre-filter from DEXBot account discovery — bots with high fill rates were incorrectly excluded from discovery results because they cancel few orders despite clear grid behavior. Grid analysis now solely determines DEXBot candidacy. Candidates found: 48→59 (`d514489f`).
- **Chore**: increase `DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT` from 0.75 to 0.8 — requires slightly stronger Kalman confirmation before the signal reaches full effect, matching the AMA-side tuning from v1.0.9 (`33eb4a5c`).

### 2026-07-07

- **Docs**: sync README updater default (ON→OFF) — `UPDATER.ACTIVE` was changed to `false` in v1.0.2 but README still listed the default as ON (`d3ee3f1b`).
- **Docs**: sync AGENTS.md with analysis scripts and claw modules — expanded from 7 to 15 analysis entries, consolidated claw module list, added `chain_queries`, `chain_broadcast`, `position_discovery`, `liquidity_pools` (`d5cead90`).

### 2026-07-08

- **Feat**: comprehensive trade PnL audit and cleanup — fixed fee accounting (per-lot→per-order), Sortino denominator, Sharpe capital divisor, maxRecoveryDays (peak-to-peak→trough-to-peak), cross-pair classification (now produces buys), early drawdown tracking, `percentile` interpolation, CSV quoting, maker ratio (both legs). Removed dead code (`avgBuyPrice`/`avgSellPrice`/`matchedBuyBase`/`matchedBuyQuote`). Default flow simplified: metrics on, detail off. Added activity metrics: fills-per-order distribution (mean/med/max, single-fill ratio), fills/day, avg volume/day. Streak count aggregated by exit order (round-trips). Removed Std PnL, skewness, kurtosis. Clean metric glossary in README. Flag cleanup: `--trades` re-enabled, `--no-pnl-summary` removed from help.
- **Chore**: version bumped to 1.0.10 across all manifests.

## [1.0.9] - 2026-07-06 - Trade PnL Analysis Tool & AMA Slope Tuning

### 2026-07-06

- **Feat**: add `analysis/trade_profitability.ts` — Kibana-driven FIFO/Sequential PnL analysis tool with 16 metrics (`879d7209`).
- **Feat**: add trade PnL metrics, sequential matching, and fee tracking (`ab4a403d`).
- **Chore**: reduce `DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT` from 0.085 to 0.08 (`0ba19df5`).
- **Chore**: version bumped to 1.0.9 across all manifests.

## [1.0.8] - 2026-07-05 - System Invariants Expansion & Shared Runtime Fix

### 2026-07-05

- **Fix**: prevent deadlock in secondary pending-broadcasts recovery path — second call site at `_updateOrdersOnChainBatchCOW` (line 3851) passed `fillLockAlreadyHeld: true` flag to `_reconcileAfterUncertainBroadcast`, fixing a missed deadlock path that fired when a CREATE batch was rejected due to prior pending broadcasts (`f5e4340e`).
- **Fix**: market adapter log duplication in shared runtime — the in-process `market_adapter_runtime.ts` used `stdio: 'inherit'`, piping all child stdout into dexbot.log. Changed to `'ignore'` to match the watchdog fix from v1.0.3.
- **Fix**: bot key resolution — extract shared bot key utils into `analysis/bot_key_utils.ts`, fix `roundTo` ReferenceError in browser-side chart JS, add `--use-cached` flag (later removed), add 20 tests (`e440cb3a`).
- **Fix**: remove `--use-cached` flag — always resolve to candle cache from `--source market_adapter`; removed centers-file fallback with no useful history data (`7eee1ac9`).
- **Docs**: comprehensive system invariants expansion — `docs/COW_INVARIANTS.md` rewritten with full coverage for COW pipeline, sync engine, maintenance runtime, grid structure, reconcile, batch/pipeline, fund registry, and subscriptions. All invariants now carry categorized prefixes (`INV-COW`, `INV-SYNC`, `INV-MAINT`, etc.).
- **Chore**: version bumped to 1.0.8 across all manifests.

## [1.0.7] - 2026-07-03 - BROADCAST_DEADLINE Graceful Recovery

### 2026-07-03

- **Fix**: prevent deadlock when broadcast fails with `BROADCAST_DEADLINE` — `_reconcileAfterUncertainBroadcast` now receives `fillLockAlreadyHeld: true` so it does not deadlock on the non-reentrant `_fillProcessingLock`. Previously the recovery path never ran, leaving the grid in an uncertain state and the process hung (`6035fe6f`).
- **Fix**: add bot-level retry for `BroadcastUncertainError` — if all daemon-side attempts expire against the 25s inner deadline, a fresh bot-level retry buys a new 25s window. Skips retry on `partialOnChainState` (pair-mode grouped creates) to prevent duplicate orders on chain (`6035fe6f`).
- **Feat**: make daemon broadcast retry count configurable — `CREDENTIAL_DAEMON_BROADCAST_RETRIES` in constants (default 3), up from hardcoded 2 (`6035fe6f`).
- **Feat**: subscription health watchdog for silent subscription death detection — monitors blockchain subscription health and triggers reconnection when the subscription silently drops without an error event (`5a20dbdd`).
- **Chore**: version bumped to 1.0.7 across all manifests.

## [1.0.6] - 2026-07-03 - Version Display & Project-Root Centralization

### 2026-07-03

- **Feat**: show DEXBot2 version in `node unlock status` command output — operators can now verify the running version without checking `package.json` (`9b3f4f18`).
- **Fix**: stop misclassifying partial fills as full when `rawOnChain` cache is stale — fill processor now re-queries on-chain state when cached order data is outdated, preventing incorrect order state transitions (`7405a29b`).
- **Fix**: rerun hint in `node dexbot test` now points at `node unlock` and preserves `--dryrun` mode — previous hint referenced the wrong entry point and dropped the dry-run flag (`cb7ff3cf`).
- **Refactor**: centralize project-root dist-detection via `isDistRuntime()` — `modules/config.ts` and `modules/paths.ts` now use the shared `isDistRuntime()` helper from `modules/utils/build_dir.ts` instead of duplicating inline `path.basename(__dirname) === 'modules' && path.basename(...) === 'dist'` checks (`5ab8cce`, follow-up fix).
- **Fix**: replace hardcoded `require('../../package.json')` in `claw/modules/skill_utils.ts` with `require(path.join(PATHS.PROJECT_ROOT, 'package.json'))` — uses the centralized project root instead of fragile relative path arithmetic (follow-up fix).
- **Chore**: version bumped to 1.0.6 across all manifests.

## [1.0.5] - 2026-07-01 - Grid Invariant Enforcement

### 2026-07-01

- **Fix**: prevent stale dust duplicates at the same price level — sync engine rejects orphan adoption when an active order already occupies that price. Reconcile unconditionally cancels duplicate chain orders on chain via `_cancelChainOrder` with `releaseUntrackedFunds: true` ([GRID_RECONCILE.md](docs/GRID_RECONCILE.md#duplicate-tolerance-5%C3%97-multiplier)). Dust detection expanded to interior partials sharing a price level with an active sibling.
- **Chore**: version bumped to 1.0.5 across all manifests.
- **Docs**: updated `CHANGELOG.md`, `docs/EVOLUTION.md`, `docs/README.md`, `docs/DEXBOT_COMPARISON.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`.

## [1.0.4] - 2026-07-01 - Update Script Hardening & Stash Leak Fix

### 2026-07-01

- **Fix**: prevent daemon-downtime-after-update — `detectMonolithicRuntime()` relied solely on the PID file; when the daemon shut down during git/npm operations the PID file was cleaned up, so detection returned null and no restart was attempted, leaving the user with no running bots. Added pre-update state snapshot (`monolithicWasRunning`, `hadMonolithicFiles`) captured before any git operations. Fallback auto-start via `node unlock` (TTY-gated) when daemon was alive before update but gone after build (`scripts/update.ts`).
- **Fix**: stash leak and broken working tree — `git stash push` now only runs when the working tree actually has local changes; replaces `git stash pop` with `git stash apply` + unconditional `git stash drop` to eliminate orphaned stash entries; auto-resolves conflicts via `git checkout --theirs` (stash = user's local changes should win); regenerates conflicted `package-lock.json` via `npm install` (`scripts/update.ts`).
- **Chore**: version bumped to 1.0.4 across all manifests (`package.json`, `package-lock.json`, `claw/package.json`, `analysis/ama_fitting/package.json`, `claw/runtimes/openclaw-plugin/package.json`, `claw/runtimes/openclaw-plugin/openclaw.plugin.json`).
- **Fix**: preserve SIGUSR2 monolithic restart when `UPDATER.ACTIVE` is false — monolithic wrapper's SIGUSR2 handler depended on `updater.pendingRestart` to signal bot restart after shutdown; with `UPDATER.ACTIVE` defaulting to `false`, the flag was never set, causing the exit handler to skip restart. Added a local `pendingRestart` boolean in `unlock.ts` independent of the updater (`4057e37c`).

## [1.0.3] - 2026-07-01 - Two-Step Candle Gap Repair

### 2026-07-01

- **Fix**: stop market adapter logs from duplicating into dexbot.log — watchdog spawned the adapter with stdout piped to dexbot.log, but the adapter already writes its own log file. Changed stdio to `'ignore'` and removed dead `outLog` parameter (`modules/launcher/market_adapter_watchdog.ts`, `unlock.ts`).
- **Feat**: two-step candle gap repair in market adapter — auto-fill gaps ≤24 candles (trusted no-trade threshold) directly without Kibana, then query Kibana only for larger gaps. Empty Kibana response is now treated as verified no-trade instead of leaving gaps "unresolved" (`market_adapter/core/market_adapter_service.ts`).
- **Chore**: version bumped to 1.0.3 across all manifests (`package.json`, `package-lock.json`, `claw/package.json`, `analysis/ama_fitting/package.json`, `claw/runtimes/openclaw-plugin/package.json`, `claw/runtimes/openclaw-plugin/openclaw.plugin.json`).
- **Test**: refactored gap repair tests for two-step auto-fill flow (`tests/test_market_adapter_service.ts`).
- **Docs**: corrected `disallowedDealIds` behavior (blocks reborrow only, not repay) in `docs/MPA_CREDIT_USAGE.md` and `docs/developer_guide.md`; documented `STALE_TAIL_THRESHOLD_CANDLES` constant and two-step gap repair in `market_adapter/README.md`; bumped version/commit references in `docs/README.md`, `docs/EVOLUTION.md`, `docs/DEXBOT_COMPARISON.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`.

## [1.0.2] - 2026-06-25 - Auto-Update Default & Update Script Hardening

### 2026-06-25

- **Chore**: disable auto-update by default (`UPDATER.ACTIVE: true` → `false`) — a DEX bot handling real funds should never silently change its code without explicit operator opt-in (`modules/constants.ts:1127`).
  - Existing installations with a pre-existing `UPDATER.ACTIVE: true` in `general.settings.json` are unaffected; the new default only applies to fresh installs or users who remove the `UPDATER` key from their settings.
- **Fix**: exit code 2 → 0 on "already up to date" — PM2's `cron_restart` treats non-zero exits as failures, causing false-positive error logs on every successful no-op tick (`scripts/update.ts:262`).
- **Fix**: restore stashed local changes after `git pull` with ref-specific pop — uses the exact stash ref (matched by message) instead of bare `git stash pop`, preventing cross-contamination with other stash entries. Also checks `git status --porcelain` for unmerged paths after pop and logs the error object on failure (`scripts/update.ts:299-307`).
- **Fix**: align DAEMON_ERRORS string checks with canonical constants — `DaemonKeyStore` in `key_store.ts` used locally-hardcoded strings (`'SESSION_EXPIRED'`, `'SOURCE_AUTH_DENIED'`) that did not match the actual daemon error values from `constants.ts:520`, causing session refresh/retry to silently never trigger. Removed the local shadow; test mocks updated to match (`0b2fdca`).
- **Fix**: canonicalize BROADCAST_DEADLINE, CREDENTIAL_DAEMON_UNAVAILABLE, and MASTER_PASSWORD_FAILED — adds `DAEMON_CODES` to `constants.ts` (modeled after `DAEMON_ERRORS`) and `MasterPasswordError.code` static property, replacing 12+ literal sites across the credential daemon, bot client, `dexbot_class`, `chain_keys`, and 4 test files with single-source-of-truth references to prevent silent recovery-path breakage from string drift.

## [1.0.1] - 2026-06-24 - Bootstrap Fill Pipeline, AccountOrders Simplification & Timer Guard

### 2026-06-24

- **Refactor**: route bootstrap fills through the standard fill pipeline — replaces the anomalous cross-side rotation logic in bootstrap mode with same-side replacement via `_processFillsWithBatching`, aligning bootstrap behavior with post-reset fill processing. Removes `calculateRotationOrderSizes` and stale caller comments (`848eba4e`).
- **Refactor**: simplify AccountOrders to one bot per file — removes the `{bots: {[key]: ...}}` wrapper from per-bot order files, eliminating the structural cause of the doubled-entry bug from bot-id migrations. Adds `_migrateLegacyWrapper` for one-time upgrade of v1.0.0 files. Drops `botKey` params from all per-instance methods (`973903ca`).
- **Fix**: guard deferred maintenance `timerOptions` against null/undefined spread — changes `...options` to `...(options || {})` to prevent rare "Grid maintenance options must be an object" errors during periodic blockchain fetches (`980e4a4d`).

## [1.0.0] - 2026-06-14 - First Stable Release

This release marks the project's first stable milestone. Includes 54 commits on top of 0.7.18: startup profile schema validation, a full logging system overhaul (write queue, rotation, JSON output, critical level, correlation IDs), AMA slope delta threshold from `maxSlopePct` × `deltaThresholdPct/100`, dashboard isolation to `dashboard-draft`, `--dryrun` flag for unlock launcher, `modules/README.md` for new-user orientation, final 54 TS strict error resolutions across test files, deferred race-condition items #9/#10/#13, on-chain authority resolution for signing key lookup, credential security hardening across 8 finding groups, comprehensive centralization of project-root resolution / fs+math utilities / magic numbers with regression fixing, error-path fallback hardening eliminating all silent catches, and a multi-wave stale-doc sweep (version numbers, test counts, broken links, default values, .js→.ts references). Post-release fixes add root credential file ownership bypass, transport keep-alive zombie connection recovery, phantom LP API method cleanup, stale AMA default-profile warning removal, read-only chain client API re-registration on reconnect, git remote preservation in the update script, an esbuild security patch, headless master password unlock mode for Docker/PaaS, Credit/MPA runtime embedded in the Claw bridge, credit runtime stale-cache and silent-drop fixes, credential daemon asset symbol resolution, credential policy empty-array truthiness fix, live pool reserves with fallback, and auto-discovery of test files. Later additions include credit runtime fixes for multi-asset collateral and stale reborrow guard, complete I/O pipeline centralization through `StorageAdapter` with 15 newly browser-safe modules and 28-check bundle verification, runtime path consolidation with shared `sleep()`/`writeJsonFileAtomic` utilities, and 3 final browser-compat gaps closed (`base58check.ts` Buffer-free, `ecc.ts` crypto routing, `paths.ts` env detection).

### 2026-06-11

- **Fix**: resolve last 54 TS strict errors across test files (`22f5857`, `d8f6373`, `294f834`, `11b13a2`, `e3022fb`, `48d4e90`, `65677a8`, `0ac4837`).
- **Fix**: deferred race items #9 (credential daemon shutdown guard), #10 (creator-use-pay from auth token refresh), #13 (double event re-subscription guard) (`e0ac76d`).
- **Docs**: add `modules/README.md` with new-user orientation and module map (`577cd32`).

### 2026-06-12

- **Feat**: startup profile schema validator — validates `bots.json` at boot and fixes 5 config risk patterns including `minPrice`/`maxPrice` type coercion, missing `gridPrice` fallback, overflow `incrementPercent`, and `botFunds` cap (`1e3afc6`).
- **Feat**: overhaul logging system — write queue (100ms batch flush), size-based rotation (1.1GB total budget, 5 files), JSON structured output, `critical` severity level, and correlation ID tracing across fill/order/adapter operations (`dc85882`).
- **Feat**: compute AMA slope delta threshold from `maxSlopePct × deltaThresholdPct/100` instead of requiring a literal threshold override (`d160839`).
- **Feat**: add `--dryrun` flag to unlock launcher (`b84a33e`).
- **Feat**: add repo-wide net lines chart to `analyze-git` — cumulative added/removed line delta from `--numstat` per merge-base (`0f69d95`).
- **Feat**: bump to v1.0.0 and sweep stale documentation (`1e7075f`).
- **Fix**: address 9 review issues — flush wiring, flush resolve, JSON separation, rotation test, JSDoc, and more (`c6e7c41`).
- **Refactor**: isolate `dashboard/` to `dashboard-draft` branch in repo (`8697d28`).
- **Docs**: remove `--isolated` flag from README (`3ebb025`).
- **Docs**: remove `AUDIT_v0.7.5_to_HEAD.md` (`1d584b2`).
- **Docs**: sweep stale `.js→.ts` references and fix wrong inline docs across the codebase (`329b072`).
- **Chore**: post-sprint cleanup — dashboard isolation, claw warning, doc updates (`4a11683`).

### 2026-06-13

- **Feat**: unblock v1.0.0 native release gate with mainnet corpus generator — generates realistic mainnet-sized test data for runtime validation (`ad6b628`).

### 2026-06-14

- **Feat**: on-chain authority resolution for signing key lookup — `getBtsKeyFromAccount` resolves active/memo keys via full account authority graph traversal with multi-sig weight threshold evaluation (`a06d465`).
- **Fix**: credential security hardening across 8 finding groups — C1 (credential socket cleanup), C2 (SIGHUP handler race), H1-H4 (HMAC token rotation gaps), M1/M4/M5 (master password verification and retry logic), L1-L8 (logging and lock file races) (`b74dfe4`).
- **Fix**: credential policy reload diagnostics, path-root helper resolution, and test accuracy improvements (`cc05428`).
- **Fix**: harden critical fallbacks and add logging to silent error paths — replaces bare `.catch(() => {})` patterns with proper error logging in remaining uncovered sites (`6b97b3f`).
- **Fix**: add logging to remaining silent catches and centralize timeout defaults — ensures no silent error swallowing remains in the codebase (`77a6ddb`).
- **Fix**: centralize remaining magic numbers and BUILD_DIR pattern — catches all magic numbers and hardcoded `'dist'` strings missed in earlier refactoring waves (`ec2e9a5`).
- **Fix**: address missed sites from centralized-cleanup series — typo'd constant, missed BUILD_DIR refactor, dead-code fallbacks, `fs_utils`/`math_utils` adoption, silent catches (`abea2f3`).
- **Refactor**: centralize project-root resolution via `resolveProjectRoot` — replaces ad-hoc `path.resolve(__dirname, '..')` patterns with a single `constants.resolveProjectRoot()` helper across all modules/order/, market_adapter, modules and launchers, claw, and test files (`73ce984`, `a77dc03`, `759f026`, `d43128c`).
- **Refactor**: finish centralizing path-root and script-ext helpers — extracts `runtime_entry.ts` path helpers into shared utility (`c1b3fb3`).
- **Refactor**: centralize fs and math utilities with regression fixes — extracts `fs_utils.ts` (atomic JSON, read/write, mkdirp) and `math_utils.ts` (clamp, precision rounding, integer math) from duplicated inline logic; regression fixes discovered during extraction applied (`dd8a510`).
- **Refactor**: centralize magic numbers and enforce explicit precision — extracts named constants across order sizing, fee calculation, and timeout domains; enforces explicit precision guards on all grid calculations (`1ca0802`).
- **Fix**: tighten docker build context — add `dist`, `claw`, and `market_adapter/inputs/data` to `.dockerignore`; document `market_adapter/data` and `market_adapter/state` volume mounts in `Dockerfile` run comment (`dc70c40`).
- **Version**: bump from 0.7.18 to 1.0.0 across all package.json manifests.
- **Docs**: fix stale version references in `DEXBOT_COMPARISON.md`, `EVOLUTION.md`, `FUND_MOVEMENT_AND_ACCOUNTING.md`, `README.md`.
- **Docs**: fix AMA delta threshold default in `README.md` (2% → 1%) and `GRID_RECALCULATION.md` example.
- **Docs**: remove broken `TEST_UPDATES_SUMMARY.md` links in `architecture.md`, `developer_guide.md`, `DEXBOT_COMPARISON.md` — replaced with `tests/README.md`.
- **Docs**: update test counts (188 `test_*.ts` files, 211 entries in `scripts/run-tests.ts`) and commit stats (1564) in `EVOLUTION.md` and `DEXBOT_COMPARISON.md`.
- **Docs**: remove `Pre-DEXBot2` section from `EVOLUTION.md`.

### 2026-06-15

- **Fix**: resolve keep-alive zombie connections (3 consecutive failures trigger autoreconnect via `ws.close()`), replace static `BitShares.disconnect()` with `disconnectClient()` at 4 shutdown call sites to eliminate ~12 misleading WARN entries per day, remove phantom `get_liquidity_pools_by_assets` LP API call (non-existent in BitShares Core 7.0.2), remove stale "no market profile matches — will use built-in AMA defaults" validation warning with 5 unused helper functions, add `onStatusChange` handler for read-only chain client to null and re-register stale API IDs after transport reconnect, reduce STALE hour counter noise in market adapter output (`36e1a95`).
- **Fix**: allow root to bypass credential file ownership check — `assertPrivatePathSecurity` now skips owner check when `currentUid === 0` so root can read non-root-owned `keys.json` without crashing; adds test coverage (`94d0c39`).
- **Fix**: preserve existing git remote in update script — remove remote-overwrite logic that forced HTTPS even when SSH keys were configured, preventing `git fetch` hangs (`9d6343a`).
- **Chore**: bump esbuild 0.28.0→0.28.1 (npm audit fix, GHSA-gv7w-rqvm-qjhr) and remove noisy root owner-bypass debugLog from `credential_runtime.ts` (`ad874a9`).
- **Feat**: headless (non-interactive) master password unlock mode — `--headless` + `--password-file` for Docker/PaaS deployments without an interactive TTY; password read from file or env var (`DEXBOT_MASTER_PASSWORD`), with security checks via `assertPrivatePathSecurity` (`b7b0040`).
- **Feat**: embed Credit/MPA runtime into Claw bridge via adapter factory — AI agents can now query, refresh, and trigger maintenance cycles on credit/MPA positions through Claw tool calls; 5 new tools (`credit-runtime-status/refresh/maintenance/watchdog/reborrows`), reborrows-in-flight guard, stale posState fix in maintenance loop (`cd7ef25`).
- **Fix**: credit runtime stale caches, silent drops, and proactive repay bundling — clear `_assetCache`/`_objectCache` on each `refreshState()`, strict-null check on `_borrowerDealsCache`, add logging to every reborrow drop/deferral path, fix `getMapEntries()` flat_map format for `[{key,value}]` pairs, new test for proactive-repay-with-inline-reborrow flow (`0dcbf93`).
- **Fix**: credential daemon asset symbol resolution via native chain client — add `setExternalAssetResolver()` hook to `credential_policy.ts`, register a resolver in the daemon using native chain client's `db.lookup_asset_symbols` instead of the never-initialized legacy global `BitShares` object (`8806422`).
- **Fix**: missing await in `resolveHonestPairPrice` and `test_claw_domain_logic` — the live-pool refactor made `resolveHardcodedHonestMoneyPrice` async but two callers still treated it as sync, silently breaking derived-price fallback for all non-HONEST.MONEY pairs (`a619193`).
- **Fix**: credential_policy empty-array truthiness, fee_params coverage, live pool reserves — all 16 allowlist `if (constraints.allowedFoo)` checks changed to `Array.isArray(…​) && …​.length > 0` so empty `[]` means "allow all" instead of "block all" (root cause of credit not updating on offers); added all 57 missing fee_parameters serializer definitions; added `fetchLivePoolReserves()` with live-first hardcoded-fallback logic (`1983585`).
- **Fix**: credential daemon security hardening and bootstrap env cleanup — file security checks at launcher entry (unlock.ts, pm2.ts), bootstrap socket path moved from env var to temp file with 0o600 mode, audit log size rotation (100 MB budget, 5 files), authority delegation docs, dead password-string path removal, auto-zero `botHmacSecret` on shutdown, `assertPrivatePathSecurity` on bootstrap temp dir (`a127c22`).
- **Fix**: auto-discover test files via `globSync`; purge TS types from chart template — replaces brittle 200-line manual test manifest with `fs.globSync` for `tests/test_*.ts` + `claw/tests/test_*.ts`; strips 3 TS annotations from browser-side chart template that caused `vm.Script` SyntaxError (`07cae81`).
- **Fix**: clean up dead code and stale docs in `scripts/` — remove unreachable `examples/bots.json` validation path and its `stripComments` helper from `validate_bots.ts`, fix `create-bot-symlinks.sh` description in `scripts/README.md`, remove stale `APP_VERSION` reference (`2e7dd33`).
- **Fix**: remove misleading "PM2 is not installed" message from `dexbot stat` — the `stat`/`status` command's PM2 fallback now prints "No DEXBot2 processes running." instead of confusing users when PM2 is not installed (`92e12c0`).
- **Fix**: demote fill-history polling logs from info to debug — 11 lines in `subscriptions.ts` changed from `.info()` to `.debug()` to reduce noise from messages that fire on every notice/tick (`8c7d029`).

### 2026-06-16

- **Fix**: include `daemon-audit.jsonl` in `node dexbot clear` log cleanup — the credential daemon's audit log was never deleted by `clear-logs.sh`, making historical `sign_denied` entries persist across restarts (`ab121e8`).
- **Docs**: add constants and overrides section to root README — explains frozen defaults in `modules/constants.ts` and how to override via `general.settings.json`; adds three-level JSON override example (global, pair, bot) to `market_adapter/README.md` (`9e41e30`).
- **Feat**: replace timing settings editor (fetch interval, sync delay, lock timeout) with a node configuration editor in the interactive general-settings menu — supports viewing/editing the node list, health check interval, and preferred node selection (`8662a0c`).
- **Feat**: consolidate settings merge into a single shared `modules/settings_merge.ts` — replaces dual merge paths (constants.ts and account_bots.ts) that used different strategies and missed sections. Adds 7 previously non-overridable sections and a 25-case test suite (`4d0ca0d`).
- **Feat**: shared-account fund registry (`modules/fund_registry.ts`) with stable bot keys and cross-bot invariants — prevents multiple bots sharing one BitShares account from over-allocating chain balance. Includes deterministic bot IDs (sha256-derived), atomic config writes, centralized percentage parsing, and 11 review-finding fixes covering broken key migration, regex collisions, TOCTOU races, and inline `require()` hoisting (`69543d8`).
- **Feat**: extend fund registry for credit/MPA collateral proportional allocation — coordinates credit bot collateral allocation across shared-account bots. Unifies registry key scheme to `botKey` (with stable 8-char id) to eliminate name-collision risks. Adds 16-test coverage (`cc3cb53`).
- **Feat**: vendor uPlot v1.6.32 as internal library under `analysis/uplot/` — replaces CDN-based uPlot loading in all 7 chart generators with local files, removing a runtime network dependency for offline analysis (`62efc53`).
- **Fix**: migrate `analyze-git` charts from Chart.js to uPlot — replaces CDN-dependent Chart.js with vendored `analysis/uplot/` for all 5 charts (bar chart, daily, cumulative, net core, net repo). Implements horizontal stacked bars via `uPlot.paths.bars()` with `stack()` + `bands`, swapped orientation (`x.ori=1`, `dir=-1`), dark theme styling, wheel-zoom support, and responsive resize (`b8b7b5f`).

### 2026-06-17

- **Fix**: use canonical ID-based bot keys in whitelist lookup and missing normalization paths — whitelist generation now uses the full `{name}-{id}` bot key format for all registry operations, preventing stale entries when bot names are reused (`d7a0085`).
- **Fix**: restore `this` context in de-this-ified method fallback calls — 3 methods in the collapsed-runtime bridge lost their receiver after refactoring; explicit `.bind(this)` restores correct dispatch (`875dfe4`).
- **Docs**: refresh DEXBot comparison — fund registry, authority resolution, CLI helpers, scoring (`6354b40`).

### 2026-06-18

- **Feat**: six portable abstractions for browser-portable core — `StorageAdapter` (in-memory Map for browser, `fs.*Sync` for Node via lazy adapter), `CryptoProvider` (Web Crypto vs Node crypto lazily selected), `Config` (load-time `process.env` snapshot), `PATHS` (guarded path resolution without `__dirname`), `ProcessDiscovery` (abstracted `/proc/` reads), and `KeyStore` portal interface (`03506ea`).
- **Feat**: `modules/env.ts` — `isBrowser()` / `hasProcess()` canonical environment detection, replacing 6+ inline `typeof window` / `typeof process` ternaries (`1dbeb75`).
- **Feat**: `modules/path_api.ts` — portable `path` abstraction guarded for ESM/browser; replaces direct `require('path')` in browser-safe modules (`68a68b6`).
- **Feat**: `modules/runtime.ts` — `Runtime` singleton abstracting `process.exit`, `process.kill`, `process.cwd`, `process.env`, `os.hostname`, `os.userInfo`; all Node calls route through this (`68a68b6`).
- **Feat**: `modules/crypto/pure_scrypt.ts`, `pure_ripemd160.ts`, `pure_secp256k1.ts` — pure-JS fallbacks for browser contexts where Web Crypto or native bindings are unavailable (`1dbeb75`).
- **Feat**: `modules/bitshares-native/crypto/ecc_selector.ts` — `getEcc()` lazy loader picking `ecc.browser.ts` (pure-JS) vs `ecc.ts` (Node native) based on environment (`1dbeb75`).
- **Feat**: `modules/bitshares-native/crypto/ecc.browser.ts` — pure-JS browser ECC implementation (458 lines), no native `secp256k1` bindings (`1dbeb75`).
- **Refactor**: wire `Runtime`, `Transport` (lazy `require('ws')`), and `CryptoProvider` into all production code — 140+ files updated to use the new abstractions (`5e73446`).
- **Refactor**: centralize `process.*` and `path` into portable abstractions — `process.exit()` → `runtime.exit()`, `process.env.X` → `Config.X`, `path.join(__dirname, ...)` → `PATHS.*`, `os.*` → `runtime.*`, `require('crypto')` → `getCrypto()` (`68a68b6`).

### 2026-06-19

- **Feat**: complete browser-safe surface across claw graph and config core — all `claw/modules/` and `modules/config.ts` paths now route through portable abstractions; no static Node imports reachable from browser bundles (`ffd5d03`).
- **Feat**: `modules/storage/browser_adapter.ts` — in-memory Map-based `StorageAdapter` for browser; `node_adapter.ts` loaded lazily via try/catch guard (`1dbeb75`).
- **Feat**: `scripts/verify-browser-bundle.ts` — new script that builds the browser bundle and checks for Node-only leaks (`1dbeb75`).
- **Fix**: close browser-safety gaps — `require('pm2')` and `require('ws')` made lazy (resolved at call time, not load time); `transport.requireWebSocket()` replaces top-level require; `runtime.*` routing covers all process.exit/kill/cwd calls; browser abstractions test covers all 19 sections (`14e869b`).
- **Fix**: close 3 browser-safety gaps from review — `runtime.getuid()` for root-owner check, `isBrowser()` gates in 4 remaining conditional paths, `ecc.browser.ts` `brainKeyToPrivateKey` missing pure-JS implementation (`33b51b6`).
- **Fix**: browser-compat — eliminate all static Node imports from browser-safe surface — remaining `require('fs')` / `require('os')` / `require('crypto')` top-level imports switched to lazy accessors; `modules/order/utils/system.ts` converted to use `getStorage()`/`getCrypto()` (`ac00b61`).
- **Fix**: align 3 tests with browser-compat abstractions — `test_launcher_exports.ts`, `test_dexbot_startup_output.ts`, `test_unlock_output.ts` updated for new runtime/storage signatures (`72c8f55`).
- **Fix**: hoist `DEXBOT_SKIP_PROFILE_VALIDATION` guard above `module_cache_stub` require in 5 startup tests to prevent premature profile validation at import time (`51c227c`).
- **Fix**: correct `PROJECT_ROOT` resolution for dist builds and centralise scripts-root arithmetic — ensures `resolveProjectRoot()` returns the correct path when running from compiled `dist/` output (`0ad6ba1`).
- **Test**: comprehensive browser abstraction tests — 1288-line `tests/test_browser_abstractions.ts` covering all 19 abstraction sections: `env.ts`, `config.ts`, `runtime.ts`, `paths.ts`, `path_api.ts`, `process_discovery.ts`, `storage/*`, `crypto/*`, `ecc_selector.ts`, `ecc.browser.ts`, `base58check.ts`, `transport.ts`, `sync.ts` (`607b6ae`).
- **Fix**: close remaining browser-compat gaps — lazy `require('account_orders')`, guarded grid `require()` calls, `env.hasProcess` dedup in utility modules (`f5dd9c9`).
- **Docs**: update CHANGELOG and EVOLUTION.md for browser compat commits (v1.0.0) (`1dea6e3`).

### 2026-06-20

- **Fix**: wrap raw `collateralAmount` with `assetId` for multi-asset credit offers — `_runCreditMaintenance` Phase 1 now passes `{amount, assetId}` instead of a bare number; `repayCreditDeal` and `processPendingReborrows` defensively normalize collateral amounts using `dealSummary.collateralAssetId` plus tests (`f94b370`).
- **Fix**: prevent stale pending reborrows from bypassing `renewOnly` guard — `processPendingReborrows` checks for newer on-chain deals from the same offer before reborrowing; Phase 1 prunes stale entries that existed before the `repayCreditDeal` call; `pendingRepayAmount` stored in deferred entries for accurate max-borrow enforcement (`b2a286b`).

### 2026-06-21

- **Feat**: centralize read/write pipeline through `StorageAdapter` — adds `appendFile`/`appendFileAsync` (sync+async append) and `createReadStream`/`createWriteStream` (Node stream passthrough) to the portable abstraction; migrates `order/logger.ts` and `order/export.ts` from direct `require('fs')` to `getStorage()`; reclassifies 15 modules from Node-only to browser-safe (`bots_file_lock`, `general_settings`, `bot_settings`, `node_health_cache`, `order/index`, `order/manager`, `order/working_grid`, `order/sync_engine`, `order/strategy`, `order/accounting`, `order/grid`, `account_orders`, `validate_profiles`); removes 4 stale `package.json` browser entries that shadowed now-safe modules; expands bundle verification to 28 checks (source + dist level) (`70a1c58`).
- **Refactor**: centralize runtime paths and consolidate 11 inline `setTimeout` promises into shared `sleep()` — banner-annotates all node-only entry points; migrates `bot.ts` `process.*` to `runtime`/`Config`; consolidates `writeJsonFileAtomic` (Claw `dexbot_profiles.ts` delegates to shared `bots_file_lock.ts`); normalizes import style in 7 mixed-import files (`import → require`) (`b5f210f`).
- **Fix**: close 3 browser-compat gaps — `base58check.ts` replaces all `Buffer.*` calls with `Uint8Array` equivalents (TextEncoder, manual concat), `ecc.ts` removes direct `require('crypto')` in favor of guarded `crypto/sync.ts`, `paths.ts` replaces inline `typeof __dirname` with `hasProcess()`; marks 5 serial/signing pipeline files node-only in `package.json` (`bitshares-native/crypto/ecc.js`, `serial/serializer.js`, `serial/types.js`, `signing_client.js`, `tx/builder.js`) (`35ea2f8`).
- **Docs**: sweep stale references and fix doc accuracy across 15 files (`2420ae4`).
- **Docs**: reclassify `modules/order/logger.ts` as browser-safe in AGENTS.md (`27574a6`).
- **Docs**: update AGENTS.md, CHANGELOG.md, EVOLUTION.md for Jun 20–21 changes (`f6ec218`).

### 2026-06-22

- **Refactor**: complete browser-safe surface enforcement with lazy require wrappers — wraps remaining direct `require()` calls in guard functions so bundlers can tree-shake Node-only modules at the call site (`d5af4d5`).
- **Fix**: resolve `storage/index.ts` `_require('./node_adapter')` resolving from wrong directory — uses full relative path from `modules/` root instead of relative to storage subdir (`4db0beb`).
- **Feat**: wire `disallowedDealIds` filter for credit deals (1.22.x) — `_addCreditOffer` and `createDeal` accept a `disallowedDealIds` set to exclude specific active deals from new credit offers (`c25cc4d`).
- **Feat**: rename lending item `ratio` to `outputWeight` with backward-compat shim — `outputWeight` is the canonical name; old `ratio` key still accepted with a deprecation warning (`4facec6`).
- **Fix**: narrow `disallowedDealIds` to reborrow-only exclusion — the filter now only blocks reborrows from excluded deals, not all matching-amount offers (`aa68e6c`).

## [0.7.18] - 2026-06-11 - @ts-nocheck Removal, Type Annotations, Race-Condition Batch 1 & DRY Refactoring

This release removes all remaining `@ts-nocheck` directives across production and analysis code (89 files), adds type annotations to 67 files resolving 1783 TS2339 errors, applies a comprehensive race-condition fix batch (atomic JSON writes, per-context in-flight flags, snapshot persist), tightens timeouts across the board, plugs a subscribe orphan-callback leak, and DRYs duplicated code across claw modules, tests, and unlock into shared utilities (~460 lines removed).

### 2026-06-11

#### Gradual Strict Typing: @ts-nocheck Removal
- Remove all 89 remaining `@ts-nocheck` directives from production `/modules/`, `market_adapter/`, `scripts/`, and `analysis/` directories; relax `tsconfig.json` from `strict: true` to selective strict checks for gradual migration (`ccaf14e`).
- Add type annotations across 67 files — class property declarations, options/destructured parameter interfaces, `Array.from` casts for TS 5→6 `unknown[]` change, method return types, and ~30 inline interfaces for config shapes. Purely additive, zero runtime impact (`d2d8561`).

#### Race-Condition Batch 1
- **RC-6: Atomic JSON writes**: New `writeJsonFileAtomic` helper (tmp+rename) replaces raw `fs.writeFileSync` across 5 writers (bots.json, general.settings.json, credit state, node health cache, node blacklist) to prevent torn reads on crash (`47b5011`).
- **RC-1: Per-context in-flight flags**: Split shared `_maintenanceInFlight` into separate `_maintenanceInFlight` / `_watchdogInFlight` flags in `CreditRuntime` so watchdog ticks are never starved by long maintenance cycles (`47b5011`).
- **RC-2: Sync engine owns `_gridLock`**: `createOrder`/`cancelOrder` acquire `_gridLock` inline inside the sync engine with `gridLockAlreadyHeld` escape for internal callers, preventing double-acquire / deadlock (`47b5011`).
- **RC-3: Snapshot persist**: `persistGrid` now accepts an explicit snapshot orders map — the live `manager.orders` map is never swapped during persistence, eliminating inconsistent `_ordersByState`/`_ordersByType` reads (`47b5011`).
- **RC-4: Position manager interval guards**: `syncInFlight` boolean guards overlapping watchdog ticks; timer is `unref()`'d so it doesn't prevent process exit (`47b5011`).
- **RC-5: Credential-daemon watchdog + shutdown guards**: Added `_credentialDaemonWatchdogInFlight` flag, `_shuttingDown` re-checks throughout fill pipeline and blockchain fetch intervals (`47b5011`).

#### Timeout Hardening & Leak Fixes
- Headline constants: `HISTORY_LOOKBACK_MAX` 100→50, `HISTORY_MAX_PAGES` 200→100, `SUBSCRIBE_TIMEOUT_MS` 60s→75s, consumer backoff 30-300s→15-60s (`730f6c9`).
- Runtime `api_limit_get_account_history` detection via `login_api.get_config()` — logs warning when the node's cap is below the static default (`730f6c9`).
- Fix subscribe orphan-callback leak: check `subscriptions.has(accountName)` after each await in `subscribe()` — rollback during async work no longer leaks callback closures (`730f6c9`).
- Add `withTimeout()` utility applied to native connect (90s), subscribe (60s), safety-net sync (25s), fill-processing lock (20s), with generation-counter for state consistency post-timeout (`86607ae`).
- Fill consumer exponential backoff watchdog: consecutive-failure tracking with 5-threshold immediate-retry → exponential 30-300s backoff, escalating log levels (`86607ae`).
- Master password attempt limit (configurable via `CREDENTIAL_PROMPTS.MAX_MASTER_PASSWORD_ATTEMPTS`) (`86607ae`).
- Credential daemon stop hardening: `SUPERVISOR_POLL_TIMEOUT_MS` (60s), `DAEMON_SIGKILL_DEADLINE_MS` (10s) (`86607ae`).
- Fix silent runtime import bug: `TRANSPORT` was destructured from wrong namespace (undefined at runtime) — corrected to `NATIVE_CLIENT.TRANSPORT` (`730f6c9`).

#### DRY Refactoring
- Shared modules created: `claw/modules/mcp_utils.ts` (MCP JSON-RPC infra), `claw/modules/skill_utils.ts` (skill generation), `tests/helpers/unlock_test_helpers.ts` (unlock test fixtures) — eliminating ~460 lines of duplication (`e199c6b`).
- `claw_catalog.ts`: 988→756 lines via factory functions for launcher/MEMU tools (`e199c6b`).
- `unlock.ts`: extracted `makeFinishGuard` helper for settled/timer/cleanup guard (`e199c6b`).
- Test files: `makeChainClientMock` factory in subscription flow test, 4 unlock test files converted to shared helpers (`e199c6b`).

#### Claw HMAC Recovery Alignment
- `claw/modules/chain_broadcast.ts` now sends SIGHUP + 500ms sleep on `SOURCE_AUTH_DENIED`, matching the main path in `chain_orders.ts` (`fe82fa2`).

#### Codebase Audit Cleanup
- Replace remaining hardcoded `'dist'` paths in 3 test files and `scripts/update.ts` with `BUILD_DIR` constant (`50ee8fa`).
- Fix fd leak in `file_lock.ts`: close opened fd in catch block when `writeFileSync` fails after `openSync` (`50ee8fa`).
- Add `CEX_API_DELAY_MS: 500` to constants; paginated CEX requests now delay between pages; HTTP errors skip page instead of throwing (`50ee8fa`).

#### Chores
- Bump version to 0.7.18 across all `package.json` manifests.

## [0.7.17] - 2026-06-10 - BUILD_DIR Centralization, HMAC Recovery & Doc Fixes

This release centralizes the hardcoded `'dist'` string into a `BUILD_DIR` constant across 50+ files, adds source-mode runtime support (tsx without pre-built `dist/`), hardens silent error paths with proper logging, and recovers from stale HMAC sessions without manual daemon restarts. It also bumps the version and fixes stale documentation references.

### 2026-06-10

#### BUILD_DIR Centralization & Source-Mode Runtime
- Centralize `BUILD_DIR` constant in `modules/constants.ts`; replace hardcoded `'dist'` across 50+ entry points and scripts (`c09176a`).
- Add source-mode runtime support: `runtime_entry.ts` picks `.ts` + `--import tsx` in source mode, `.js` in compiled mode; `unlock.ts`, `pm2.ts`, `bot_supervisor.ts`, and `market_adapter_runtime.ts` all delegate to the shared helper (`c09176a`).
- Add `buildRuntimeScriptPath` / `buildRuntimeScriptArgs` for consistent entry-point resolution across launcher paths (`c09176a`).
- Add PM2 `--node-args` for market-adapter app in source mode; PM2 ecosystem entries now carry `['--import', 'tsx']` when running from source (`c09176a`).

#### Test Runner Improvements
- Add `liveTestFiles` set + `RUN_LIVE_BITSHARES_TESTS=1` env var separating live-blockchain tests from standard test runs; skipped live tests display `[SKIPPED N live test(s)]` summary (`c09176a`).
- Set `NODE_OPTIONS=--no-warnings` in test runner to suppress circular-dep warnings (`c09176a`).
- Fix `test_fill_subscription_lifecycle.ts` — add missing `return` to `test()` IIFE so `await test(...)` actually waits (`c09176a`).
- Fix `test_connection_timeout_params.ts` — explicitly call `facade.getConnectionStatus()` to trigger lazy proxy init (`c09176a`).
- Fix `test_pm2_stop_delete_all.ts` — assert new credential-daemon-first stop order (`c09176a`).
- Fix `test_connection_trace.ts` — add per-node WS connect timeout and overall `BITSHARES_TRACE_TIMEOUT_MS` guard (`c09176a`).
- Fix `test_derivative_signal_trap_regression.ts` — skip with message instead of hard-exit when LP data file is absent in CI (`c09176a`).
- Fix `test_market_adapter_file_lock.ts` — spawn child with `tsx` matching production process regex (`c09176a`).

#### Error Handling Hardening
- Replace empty `.catch(() => {})` patterns with proper logging across `transport.ts`, `bitshares_client.ts` (both main and Claw), and `chain_broadcast.ts` (`89aad0a`).
- Add try/catch with re-resolve-and-retry around credential-daemon broadcast path in `chain_broadcast.ts` (`89aad0a`).
- Check `_updateOrder` return values at 6 call sites; log context-specific warnings instead of silently discarding validation failures (`89aad0a`).

#### Redundant Computation Reduction
- `compareGrids()`: call `recalculateFunds` once upfront, pass `skipRecalc:true` to both `_getSizingContext` calls (`89aad0a`).
- `node_manager.ts`: replace five `.filter()` passes with single `for…of` loop (`89aad0a`).
- `manager.ts`: replace 4 inline `actions.filter().length` calls with `summarizeActions(actions)` utility (`89aad0a`).

#### Shared Daemon Error Constants
- Add `DAEMON_ERRORS` (`SESSION_EXPIRED`, `SOURCE_AUTH_DENIED`) to `modules/constants.ts`; both `chain_orders.ts` and Claw broadcast use the same named constants (`89aad0a`).

#### HMAC Session Recovery
- Extend daemon retry branch in `executeViaDaemonToken` to catch `'invalid source authentication'` — send SIGHUP to re-load policy config, sleep 500ms, probe fresh session, retry the same operations (`598cb32`).
- Eliminates the manual-daemon-restart requirement after `botHmacSecret` rotation or startup race (`598cb32`).

#### Budget-Aware Shortfall Suppression
- Gate targeted-sync shortfall detection with `_hasBudgetForSide()` — bots with one side fully drained no longer hot-spin on RPC budget (`598cb32`).
- Uses the same `getSideBudget` formula as `strategy.ts:314-316`; try/catch fails open (`598cb32`).

#### Test & Code Cleanup
- Remove dead `anyRotations` assertions from `test_fill_batch_chunking.ts` (3 locations, stale since the return type was simplified in a01b00b) (`8de5586`).
- Logger migration: `bitshares_client.ts` replaces `console.log/warn` with `Logger('bitshares_client')` for consistent codebase output (`c09176a`).
- Legacy comment cleanup: remove stale `// FIX: Use logger instead of console.warn` in `grid.ts` (`89aad0a`).
- Replace hardcoded `'dist'` strings in `unlock.ts` with existing `BUILD_DIR` constant (missed during BUILD_DIR refactor) (`89aad0a`).

#### Codebase Audit Fixes
- Fix `outOfSpread` boolean type mismatch → numeric `0` in test logger stub (`test_logger.ts`).
- Fix stale `'market'` priceMode in `modules/types.ts` type definition → `'book'`.
- Fix stale `priceMode: 'market'` return value in `market_adapter/utils/chain.ts` → `'book'`.
- Rename `test_startup_reconcile*` test files to `test_grid_reconcile*` to match the renamed module.
- Remove stale `test_refactor.ts` archaic manual test (superseded by proper test suite).
- Rename `test_account_bots_draft.ts` → `test_account_bots_normalize.ts`.
- Clean up 149 empty LP test data directories under `market_adapter/inputs/data/lp/`.
- Replace hardcoded `'dist'` with `BUILD_DIR` constant in `module_cache_stub.ts` and `test_launcher_exports.ts`.
- Clean up stale `preparePartialOrderMove` comments in 2 test files.
- Clean up stale comment in `modules/order/index.ts` referencing removed `logger_state.js`.
- Use `"*.ts"` glob in `tsconfig.json` include (replaces explicit entry-point list); remove redundant strict flags already implied by `"strict": true`.

#### Documentation
- Fix stale version footer in `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` (v0.7.5 → v0.7.17).
- Fix stale release track, last commit date, total commits, and report date in `docs/DEXBOT_COMPARISON.md`.
- Update version context in `docs/README.md` from v0.7.15 to v0.7.17.
- Clean up stale `unlock-start` reference in `scripts/README.md`.
- Add v0.7.17 entry to `docs/EVOLUTION.md`.

#### Chores
- Bump version to 0.7.17 across all `package.json` manifests.

## [0.7.16] - 2026-06-10 - Pipeline Blocking Hardening & Dead Code Removal

This release eliminates three remaining categories of pipeline-blocking stale-state hazards, removes dead tracking variables, and cleans up documentation.

### 2026-06-10

#### Pipeline & Fill Processing
- Resolve pipeline self-blocking from stale `_gridSidesUpdated` flags: clear divergence flags before the maintenance pipeline check so a prior aborted tick cannot permanently block the next tick (`b49d051`).
  - Also clear ratio flags after an RMS structural resync completes.
- Remove dead `anyRotations` tracking, deduplicate fund recalculation in `initializeGrid` (`skipRecalc` parameter), and remove redundant post-fill `recalculateFunds` calls (`a01b00b`).
- Fix remaining stale-entry blocking risks (`eaf3258`):
  - `correctOrderPriceOnChain`: both surplus-cancel and price-update branches now remove correction entries in a `finally` block, covering all exit paths (success, skip, error).
  - Remove dormant `_batchRetryInFlight` property (never set in production).
  - Guard `updateGridFromBlockchainSnapshot` in `applyGridDivergenceCorrections` with try/catch that clears `_gridSidesUpdated` on failure.
- Rename "Grid Cache Regeneration" to "Grid Ratio Regeneration" in CLI settings labels (`b49d051`).

#### Documentation
- Clarify isolated runtime startup (`7b5fa5f`).
- Fix stale doc references and label format (`b49d051`).

#### Chores
- Remove `dry-run`/`print` from market adapter whitelist generation (`eaae0e5`).

#### Testing
- `npx tsx tests/test_cow_concurrent_fills.ts`
- `npx tsx tests/test_cow_divergence_correction.ts`
- `npx tsx tests/test_cow_structural_resync.ts`
- `npx tsx tests/test_patch17_invariants.ts`
- `npx tsx tests/test_targeted_drift_reconcile.ts`

## [0.7.15] - 2026-06-09 - Quiet Orderbook Candles & Launcher Bot Visibility

This release keeps orderbook-derived dynamic-grid snapshots advancing through ordinary quiet periods by carrying the last close forward across bounded no-trade gaps, while also making active bot names easier to spot in launcher and status output.

### 2026-06-09

#### Market Adapter
- Carry quiet orderbook candles forward through bounded no-trade gaps (`73fa79d`).
  - Book-sourced bots continue rewriting dynamic-grid snapshots during ordinary quiet periods instead of freezing on stale close values.
  - The existing verified long-silence path remains in place for larger inactivity windows.

#### Runtime & Launcher
- Highlight active bot names in green where launcher/status output lists running or affected bots.
  - `node dexbot start` now prints an explicit active-bot summary before handing off to the runtime.
  - `node unlock` startup summaries, whole-runtime control summaries, and `node unlock status` use the same active-bot highlighting.
  - Coloring remains disabled for non-TTY output and when `NO_COLOR` is set.
- Polish launcher and updater terminal wording/color.
  - Bot-count summaries now print `bot` or `bots` instead of the generic `bot(s)`.
  - Interactive success lines use green and important failure/error lines use red across `dexbot`, `unlock`, `pm2`, and the update script.
  - Redirected output and log-style output stay plain through the same TTY/`NO_COLOR` guard.

#### Testing
- `npx tsx tests/test_market_adapter_service.ts`
- `npx tsx tests/test_dexbot_startup_output.ts`
- `npx tsx tests/test_unlock_control_output.ts`
- `npx tsx tests/test_unlock_output.ts`
- `npx tsx tests/test_dexbot_start_master_password_failure_output.ts`
- `npx tsx tests/test_pm2_main_output.ts`

## [0.7.14] - 2026-06-09 - AMA Display Polish, Whitelist Safety & Unlock Controls

This release refines the live order/AMA terminal display, hardens market-adapter whitelist and dynamic-weight handling, makes monolithic unlock startup idempotent, and simplifies whole-runtime unlock controls while preserving isolated per-bot targets and legacy `all` arguments.

### 2026-06-09

#### Runtime & Launcher
- Make unlock monolithic startup idempotent (`93538d0`).
  - Re-running the monolithic launcher no longer creates duplicate runtime state when the background process is already active.
- Simplify whole-runtime unlock controls.
  - `node unlock stop` and `node unlock restart` are now the canonical monolithic controls.
  - `node unlock stop all` / `node unlock restart all` remain backward compatible.
  - `node unlock stop <botName>` / `node unlock restart <botName>` remain available for isolated per-bot control.
  - README examples, launcher help text, and parser coverage were updated.

#### Market Adapter & Dynamic Weights
- Preserve market adapter whitelist entries (`820592b`).
  - Whitelist generation no longer drops existing configured entries while refreshing adapter settings.
- Default whitelist dynamic weights off (`b32a869`).
  - Newly generated whitelist entries avoid enabling dynamic weighting implicitly.
- Refresh AMA dynamic grid snapshots every cycle (`1a9a9b5`).
  - Runtime snapshots stay current even when the market adapter does not otherwise trigger a grid reset.
- Gate dynamic weights on AMA whitelist (`e8188a4`).
  - Dynamic-weight display and behavior now require the relevant AMA whitelist configuration instead of only inferred bot state.
- Show AMA adapter status without dynamic weights (`d48cb0c`).
  - AMA status remains visible for whitelisted adapter bots even when dynamic weights are disabled.

#### CLI & Display
- Overhaul `node dexbot order` / analyze-orders output (`69a0068`).
  - Aligned terminal columns, richer AMA metadata, and 5-digit price formatting improve scanability of live order state.
- Show equal dynamic weights in the default terminal color instead of grey (`2e87acf`).
  - Neutral/equal weight state now reads consistently with normal terminal output.

#### Documentation
- Fix stale references across documentation (`a97623e`).
- Reorder version history chronologically and add v0.7.13 to the evolution report (`a366418`).

## [0.7.13] - 2026-06-06 - TradingView Orientation, CEX Synthetic Seeding & Runtime Polish

This release adds pair-orientation controls to TradingView analysis charts, introduces CEX synthetic candle seeding for market-adapter research data, tunes AMA reset/asymmetry defaults, and fixes several launcher/update/terminal UX rough edges discovered after v0.7.12.

### 2026-06-06

#### Analysis & Market Adapter
- Add pair orientation toggle to TradingView charts (`89f3900`).
  - TradingView uPlot output can now switch orientation so chart inspection matches either pair direction.
  - `analysis/tradingview/README.md` documents the new chart control.
- Add CEX synthetic candle seeding (`480d8b3`).
  - New `market_adapter/inputs/fetch_cex_synthetic_data.ts` fetcher seeds synthetic CEX candles for market-adapter data workflows.
  - `market_adapter/README.md` documents the new data source flow.
  - Root package scripts now expose `market-adapter:fetch-cex-synthetic`.

### 2026-06-05

#### Runtime & CLI Fixes
- Preserve masked terminal input editing (`5ab9be6`).
  - Shared read-input handling in `modules/order/utils/system.ts` now supports editing behavior while keeping sensitive input masked.
  - Added `tests/test_read_input.ts` plus launcher/runtime test coverage for the updated input path.
- Avoid duplicate build during update install (`d3ad915`).
  - `scripts/update.ts` skips the redundant install-time build when the update flow already rebuilds before restart.
- Keep key manager startup quiet (`201d0a3`).
  - `dexbot.ts` suppresses unintended startup noise from key-manager paths.

#### Defaults & Display
- Tune AMA reset and asymmetry defaults (`de6c134`).
  - Updated `modules/constants.ts` defaults and refreshed matching documentation in `analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md`, `docs/GRID_RECALCULATION.md`, and `market_adapter/README.md`.
- Darken active sell color in `node dexbot order` / analyze-orders display (`8af8317`).

### 2026-06-04

#### Documentation
- Remove stale `dexbot test` reference from the README CLI table (`89b2645`).

## [0.7.12] - 2026-06-04 - CLI Polish, Color Palette Fix & Documentation Sweep

This release adds several CLI quality-of-life improvements (`node dexbot default`, `stat`/`white` aliases, `start`→`test` rename, `restart all`/`stop all` canonical forms), lightens the terminal color palette for better readability, eliminates a doubled log line from CLI-only invocations, and sweeps 20 documentation files for stale references and architecture drift.

### 2026-06-04

#### CLI & UX
- Add `node dexbot default` (alias: `defaults`) CLI command to delete settings files and restore built-in defaults — runs `scripts/reset-settings.sh` (`adf4ae5`).
  - Lowered `DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT` (amaS%) default from 0.1 to 0.09 for more sensitive AMA channel response.
- Normalize `node unlock restart all` / `node unlock stop all` as canonical CLI forms with space-separated `all` parameter; backward compat preserved for hyphenated `restart-all`/`stop-all` forms (`373dcfe`).
  - Unlock doc comment deduplicated to `stop <botName>|all` / `restart <botName>|all`.
- Rename `dexbot start` to `dexbot test` as canonical CLI command; keep `start` as backward-compatible alias; add `dexbot unlock` as convenience wrapper for `node unlock` (`49fcca6`).
  - `stat` now recognized as `status`; `node unlock stop` now requires an explicit `<botName>` argument.
  - All launchers and internal scripts use the canonical command.
- Add `dexbot white` (alias for `whitelist`) and `dexbot stat` (alias for `status`) CLI shortcuts (`0a01b43`).
- Lighten terminal color palette across order display and analysis — standard ANSI colors shifted to bright variants (32m→92m, 33m→93m, 34m→94m, 31m→91m) and adjusted 256-color codes for a uniformly lighter palette (`1549ab5`).

#### Fixes
- Eliminate doubled "[NodeManager] Loaded config" log output — wrap top-level side-effect initialization in `bitshares_client.ts` in a lazy `ensureInitialized()` guard so commands like `stat`/`status` no longer trigger node-config loading at import time (`1969cec`).

#### Documentation
- Comprehensive documentation sweep across 20 files fixing stale references, statistics, and architecture drift (`47ca88f`).
  - **Rewritten**: `docs/architecture.md`, `docs/developer_guide.md`, `claw/docs/POSITION_HEALTH.md`, `claw/skills/margin-trading/references/position-management.md`, `dashboard/tui_dashboard_spec.md`.
  - **Minor fixes**: `AGENTS.md`, `docs/COPY_ON_WRITE_MASTER_PLAN.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`, `docs/DEXBOT_COMPARISON.md`, `docs/GRID_RECALCULATION.md`, `docs/LOGGING.md`, `docs/EVOLUTION.md`, `docs/PLAN_MIN_BTS_VALUE.md`, `scripts/README.md`, `dashboard/README.md`, `claw/README.md`, `claw/docs/AI_BOT_LIBRARY_API.md`, `claw/skills/trend-detection/references/service.md`, `market_adapter/README.md`, `analysis/README.md`.

#### Tests
- Updated `test_launcher_exports.ts` for canonical CLI forms and backward compat.
- Updated `test_dexbot_startup_output.ts` and `test_unlock_control_output.ts` for `start`→`test` rename.
- Updated color assertions in `test_analyze_orders_dynamic_weight.ts`, `test_market_price.ts`, `test_debug_orderbook.ts`, `test_any_pair.ts`.

## [0.7.11] - 2026-06-03 - COW Grid Integrity, Uncertain Broadcast Recovery, Unified Status & Dynamic Weight Display

This release closes several COW grid-integrity windows (missing-create results, unmatched chain orders, stale-slot binding), adds a typed recovery path for uncertain credential broadcasts, defends the launcher against foreign credential daemons, hardens the market adapter watchdog, lands two CLI polish items (`node dexbot clear` log cleanup and plural/singular CLI aliases), adds a unified `node dexbot status` command, integrates live dynamic weight and adapter-offline alerts into `node dexbot order`, and sweeps documentation for stale references and clarity.

### 2026-06-03

#### COW Grid Integrity
- Block COW creates on missing `chainOrderId` and unmatched grid drift (`c60e7ac`).
  - Pre-broadcast guard in `_updateOrdersOnChainBatchCOW` aborts the batch when `manager._lastUnmatchedChainOrders` is non-empty and a CREATE is planned, returning `reason: 'UNMATCHED_CHAIN_ORDERS'` and requesting structural resync.
  - Post-broadcast integrity check via new `_findMissingCreateResultContexts` — when a CREATE op returns no `chainOrderId`, the working grid is discarded, rebalance reset to NORMAL, a `missing-create-result` blocker is merged into `_lastUnmatchedChainOrders` (deduped by `reason:slotId:operationIndex`), and `_recoverAfterMissingCreateResults` runs an immediate chain sync. Recovery failures log CRITICAL and schedule structural resync.
  - Sync engine `findMatchingGridOrderByOpenOrder` now honors `requireAvailableSlot` / `excludeGridOrderIds`; both adoption call sites pass `matchedGridOrderIds` so already-adopted slots are skipped in the same pass.
  - Startup reconciliation now logs the top 5 nearest candidate slots per unmatched chain order via `describeNearestAdoptionCandidates` (with `type`/`price`/`size`/`occupied`/`primary-matchable`/`fallback-adoptable` tags) and escalates to `SUSPECTED DUPLICATE` (error) for near-matches within `tolerance * 5` (floored at 0.01). Magic numbers promoted to `SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` / `_FLOOR` constants.
  - Shared formatter extracted as `formatUnmatchedChainOrder` in `modules/order/utils/order.ts` and re-imported by `dexbot_class.ts` + `dexbot_maintenance_runtime.ts`; now also surfaces `fingerprint=...` for missing-create blockers.
- Harden COW uncertainty-recovery and orphan-cancel paths (`f722579`).
  - Credential daemon inner deadline raised from 20s → 25s (5s slack) so slow mainnet broadcasts no longer force the recovery path; outer window now genuinely contains the inner.
  - `_reconcileAfterUncertainBroadcast` short-circuits the heavy re-sync on the happy path (all CREATE fingerprints adopted, no discarded ops); `hadRotation` still set so callers treat it as state-changing. Eliminates "no adoptable slot" warnings for pre-existing, non-CREATE chain orders.
  - New `computeOutOfToleranceDriftTag` helper tags orphans with 1x–4x tolerance drift as `price-drift-orphan` (with `candidateSlotId`/`priceDiff`/`tolerance` diagnostics); `_autoCancelOneUnmatchedOrphan` now prefers these for cancellation. >4x drift still treated as normal orphan so structural resync discards them.
  - Pre-broadcast price freshness guard in `_updateOrdersOnChainBatchCOW` rebuilds the CREATE op with the live slot price if it has drifted since plan creation, defending against a manager/action planned-order divergence race.
  - Persistence commit guard: persistGrid result is now checked; on `skipped:true` / `isValid:false` the first attempt sets `_persistenceWarning` and retries once, on repeated failure logs error and calls `requestStructuralGridResync("persistence guard triggered after COW batch")`. `retryPersistenceIfNeeded` now correctly treats the new return shape as a boolean failure (old truthy-check bug fixed).
- Recover uncertain credential broadcasts safely (`377846d`).
  - New `BroadcastUncertainError`, broadcast-specific socket timeouts, daemon inner deadlines, typed `BROADCAST_DEADLINE` replies, and no-retry handling for uncertain broadcasts across `dexbot_credential_client.ts`, `chain_orders.ts`, `credential-daemon.ts`, and `claw/modules/chain_broadcast.ts`.
  - COW recovery: fingerprint CREATE ops, store pending broadcasts on the manager, reconcile uncertain batches from fresh chain snapshots, acquire the fill lock during recovery, adopt exact/near matches, and cap orphan auto-cancels to one per cycle. Raw BitShares `sell_price`/`for_sale` shapes and cleared-grid fallback paths handled explicitly.

#### Grid Reconciliation Recovery
- Harden grid reconciliation recovery paths (`4d90885`).
  - Shared cancel-op recorder added to `chain_orders.ts.executeBatch` so the recent-own-cancel guard now sees both direct and daemon-signed batch cancellations (was previously invisible on the daemon path, allowing non-economic fill/cancel artifacts).
  - Structural grid resync state initialized consistently across `dexbot_class.ts`, `modules/order/accounting.ts`, and `dexbot_maintenance_runtime.ts`; targeted sync takes the bot explicitly (no fragile `this` binding); cooldown stamps after successful reconciliation; running flag renamed for clarity.
  - `modules/order/startup_reconcile.ts` renamed to `modules/order/grid_reconcile.ts` and `reconcileGridOrders` exposed as the shared API; both `dexbot_class.ts` and `dexbot_maintenance_runtime.ts` import the renamed module.

#### Launcher & Runtime Hardening
- Detect and remove foreign credential daemons in `node unlock` (`0ebe075`).
  - New `modules/launcher/foreign_cred_daemon.ts` exposes `ensureNoForeignCredentialDaemon()` which probes the socket via `/proc/net/unix` + `/proc/<pid>/fd`, compares the live owner against the recorded ownership file, and SIGTERMs the foreign daemon when it matches the canonical credential-daemon script shape. `findCredentialSocketOwnerPid()` / `readCredentialSocketInode()` do the kernel lookup; the inode resolver compares the Path column EXACTLY (substring matching was a SIGTERM risk).
  - `unlock.ts.main()` calls `ensureNoForeignCredentialDaemon()` before `controller.ensureCredentialDaemon` so a foreign daemon can no longer answer the readiness probe and suppress the master-password prompt.
  - Readiness-probe predicate (`isLikelyCredentialDaemonProcess`) and candidate-aware helpers extracted and exported so tests exercise the SAME algorithm against temp-path candidates without overwriting real launcher files.
  - `node unlock status` now probes for a foreign daemon whenever the socket exists, regardless of the ready marker, matching `ensureNoForeignCredentialDaemon`'s coverage; foreign PID surfaced as `(foreign/unowned)`.
  - Cleanup covers four on-disk shapes: no-op when both files missing, unlink orphan ready marker, unlink stale socket without live owner, kill foreign live owner + unlink both. `readOwnedCredentialDaemonPid()` validates the recorded pid with the same shape predicate.
- Harden market adapter watchdog locks (`8d55db6`).
  - `market_adapter_runtime.ts` and `market_adapter/utils/file_lock.ts` now verify the lock PID is not a live market adapter before removal (prevents launcher/runtime from unlinking a held lock and starting a duplicate adapter) and recognize both JS and TS adapter entrypoints.
  - `unlock.ts` centralizes launcher/watchdog defaults in new `MARKET_ADAPTER.WATCHDOG_DEFAULTS` and `LAUNCHER.MONOLITHIC` constant groups; restarts budgets reset on config changes / stable uptime / cooldown; adapter log streams are closed on child exit.
- Rebuild updater bundle before restart (`05d7d3c`).
  - `scripts/update.ts` now runs `npm run build` during update and verifies the compiled `dexbot_class.js` marker exists and is newer than its source marker, eliminating the stale-bundle case where a source-only pull left `dist/` untouched while PM2 reloaded the previous compiled code.
  - Freshness check now fails the update explicitly when the source marker exists but `dist/modules/dexbot_class.js` was not produced (previously skipped validation when the compiled marker was missing).
- Harden native reconnect and shutdown handling (`2f34341`).
  - `modules/bitshares-native/transport.ts` and `modules/bitshares-native/subscriptions.ts` add socket-scoped close coalescing, connected-node connect no-op behavior, and per-subscription no-fill notice coalescing — reduces redundant reconnect / history-scan work under bursty websocket events.
  - `modules/bitshares_client.ts` adds a configured failover assessment cooldown so cascading close events don't repeatedly re-assess failover.
  - `modules/chain_orders.ts` + `modules/dexbot_class.ts`: successful local cancels are now recorded so the non-economic-artifact filter skips them; economic fills are still processed normally.
  - `modules/graceful_shutdown.ts` + `bot.ts` + `dexbot.ts`: handler-reference unregistering and idempotent bot shutdown — concurrent calls await the same shutdown promise; one failed startup can no longer remove another cleanup hook.

#### CLI & UX
- Add `node dexbot clear` subcommand for log cleanup (`5a98e59`).
  - Exposes the existing `scripts/clear-logs.sh` as a first-class CLI command (`'clear'` added to `CLI_COMMANDS`, `CLI_EXAMPLES`, `printCLIUsage`, and the "🛠️ BOT MANAGEMENT" doc-block). `case 'clear':` in `handleCLICommands` `spawnSync`s the script with `stdio: 'inherit'` and forwards the child exit code, mirroring the `order` subcommand pattern. The script's own `read` confirmation prompt is preserved.
  - README "🛠️ Bot Management" block updated to link `node dexbot clear`.
- Add CLI alias support (plural/singular) with docs in singular form (`b4b7d07`).
  - `dexbot.ts` `COMMAND_ALIASES` map resolves `node dexbot orders` → `order`, `node dexbot key` → `keys`, `node dexbot bot` → `bots` before the command switch. Help text and CLI examples always show the singular form (`order`, `key`, `bot`) per convention.
- Add `node dexbot status` command for unified runtime status (`b9de86d`).
  - Unifies status reporting under a single entry point that auto-detects the active runtime (unlock monolithic, isolated/supervisor, or PM2). Unlock path delegates to `node unlock status`; PM2 path runs `pm2 jlist` and renders a formatted table of known DEXBot2 processes. Graceful handling when PM2 is not installed or no processes found.
  - `dexbot.ts`: new `status` case in `handleCLICommands`. README updated to reference `node dexbot status` instead of raw `pm2 status`.
- Integrate dynamic weight and adapter-offline alert into `node dexbot order` (`74f24a1`).
  - `scripts/analyze-orders.ts` now reads `<botKey>.dynamicgrid.json` snapshots and renders `Weight: <live> (<static>) buy | <live> (<static>) sell` for AMA bots. Color rule: higher live weight = red, lower = green, equal/baseline = grey. Staleness threshold at 2× poll cycle (default 2h); stale snapshot appends a red `(adapter offline)` alert.
  - `formatFundsValue` replaces `formatCurrency`/`.toFixed(4)` in fund breakdown with up to 5 significant figures and K/M suffix.
  - Dead imports and unused variable declarations cleaned up; `main()` wrapped in `require.main === module` guard.

#### Documentation
- Clarify unlock as recommended runtime in README (`0813a39`).
  - Emphasize `node unlock` as the production runtime over PM2. Add `#` comments to all runtime control commands. Soften PM2 section as optional.
- Clarify `node dexbot start` as temporary testing only (`0c63cbc`).
  - README comment updated to avoid suggesting `node dexbot start` for production use.
- Sweep stale version references, file renames, hardcoded paths, and test counts (`f3e0656`).
  - `docs/README.md`: v0.7.7→v0.7.11 version context; `startup_reconcile`→`grid_reconcile` across all stale references (AGENTS.md, developer_guide.md, COPY_ON_WRITE_MASTER_PLAN.md, LOGGING.md).
  - `docs/DEXBOT_COMPARISON.md`: Date→2026-06-03, version→v0.7.11, last activity→2026-06-02.
  - `docs/EVOLUTION.md`: Test counts refreshed (190→208, 173→184+, 180→200+).
  - `CHANGELOG.md`: Removed hardcoded `/home/alex` machine paths from v0.7.6 entry.
  - `README.md`: Removed duplicate `node dexbot status` entry from PM2 section.

#### Tests
- New: `tests/test_unlock_foreign_cred_daemon.ts` (9 cases), `tests/test_unlock_foreign_cred_daemon_live.ts` (4 cases), `tests/helpers/foreign_cred_stub.js` (canonical credential-daemon stub), `tests/test_cow_orchestration_fixes.ts` (COW-FRESH-001/002, COW-PERSIST-001/002), `tests/test_sync_excess_orphan.ts` (SYNC-EXCESS-001/002b/003), `tests/test_uncertain_broadcast.ts` (UNC-008b/008c2 expectations updated), `tests/test_recent_own_cancels.ts`, `tests/test_cow_structural_resync.ts`, `tests/test_cow_commit_guards.ts` (COW-COMMIT-005/006 added, COW-COMMIT-007..010 extended for missing-create paths), `tests/test_transport_connect_noop.ts`, `tests/test_fill_replay_guards.ts`, `tests/test_native_subscriptions.ts`, `tests/test_shutdown_reentrancy.ts`. `scripts/run-tests.ts` registers the new test files. `claw/tests/test_claw_chain_layer.ts` extended for broadcast request typing.
- New: `tests/test_analyze_orders_dynamic_weight.ts` (17 cases covering AMA detection, snapshot staleness, weight formatting, and `analyzeOrder` integration). Registered in `scripts/run-tests.ts`.

## [0.7.10] - 2026-06-01 - Grid Recovery Smoothing, Runtime Drift Reconciliation & CLI Polish

This release hardens the runtime's self-healing paths against structural grid drift and live-order shortfalls, deduplicates the chain-sync/fill pipeline into a shared helper, makes launcher wrappers work without a prior `dist/` build, and adds a first-class `node dexbot order` subcommand plus colorized active-bot feedback in `node unlock status`.

### 2026-06-01

#### Grid Recovery & Runtime Drift Hardening
- Promote structural grid drift into an explicit resync path — unmatched chain orders are now carried out of sync, classified as structural drift, and trigger a single full grid resync instead of repeated invariant recovery attempts (`930870e`).
- Wire the deferred structural resync callback in `dexbot_class.ts`, defer credential recovery until bootstrap/broadcast state is idle, clear timers on shutdown, and reset the recovery attempt budget after a successful structural resync (`930870e`).
- Return unmatched chain order metadata from `sync_engine.ts` and refresh final startup chain counts from chain state in `startup_reconcile.ts` so operators see accurate final startup summaries (`930870e`).
- Add targeted chain-truth reconciliation for idle maintenance — when an active-order shortfall or fund drift is detected, fetch open orders, sync from chain truth, process detected fills, and run startup-style reconcile if shortfall/unmatched orders remain. Idle-gated with a 60s cooldown; a successful repair ends the current maintenance cycle for a clean follow-up pass (`f19cc51`).
- Guard post-reset spread correction with a fresh chain sync — refresh open orders immediately before post-reset spread correction, process detected fills, and skip spread correction when unmatched chain orders remain or sync fails, preventing false correction orders from stale local state (`2f1d3f9`).
- Defer fill queue consumption while order pipeline flags are active and restart the consumer from the batch `finally` block once the grid is coherent — prevents just-created orders from being credited through the orphan path when they fill before the batch commits their chain order id (`62fc990`).

#### CLI & Status UX
- Add `node dexbot order` subcommand — exposes the `scripts/analyze-orders.ts` analyzer as a first-class CLI command, integrated into `CLI_COMMANDS`, help text, and `CLI_EXAMPLES`, with `spawnSync` preserving ANSI colors and child exit codes (`2711e8e`).
- Surface active AMA bots in green in the `node unlock status` market adapter block so operators can confirm the market adapter wiring at a glance (`2711e8e`).
- Make launcher wrappers (`scripts/dexbot`, `scripts/pm2`, `scripts/unlock`, `scripts/bots`, `scripts/keys`, `scripts/update.js`) and root shims (`bot.js`, `credential-daemon.js`, `dexbot.js`, `pm2.js`, `unlock.js`) work without a prior `dist/` build — prefer compiled output when present, otherwise load the TypeScript entrypoint through `tsx/cjs` (`1ef1787`).
- Move process uptime into the memory line (`<rss> (<uptime>)`) for monolithic bot, credential daemon, and market adapter; add credential daemon memory reporting; add small ANSI helpers for section titles, labels, and yes/no values with `NO_COLOR` and TTY checks (`7579fe9`).
- Polish docs/CLI strings: add 🛠️ to the "BOT MANAGEMENT" header in the JSDoc usage block and reword the `node dexbot keys` description to "Set up master password and keyring" (`2711e8e`).
- Document `scripts/unlock` and the `node pm2`-compatible wrapper in `scripts/README.md` (`1ef1787`).

#### Refactoring
- Extract `_syncOpenOrdersAndProcessFills(tag)` in `dexbot_class.ts` — shared helper covering read-open-orders → synchronize-with-chain → process-fills → re-read/re-sync. Replaces three inlined copies across `dexbot_class.ts` and `dexbot_maintenance_runtime.ts` (`70c5839`).
- Switch `countLiveGridOrders` from scanning `manager.orders` to indexed `getOrdersByTypeAndState` lookups (ACTIVE + PARTIAL) with the `orderId` filter preserved to count only on-chain orders (`70c5839`).
- Remove a duplicate error log in `_catch` of the batch-end `setImmediate` callback that double-logged the same error with different phrasing (`70c5839`).
- Update test stubs: add `ORDER_TYPES`/`ORDER_STATES` values to module cache stubs in the dynamic-weights test, add `dryRun: true` to the unrelated RMS resync test, and add `_syncOpenOrdersAndProcessFills` + `getOrdersByTypeAndState` mocks to the targeted-drift-reconcile test (`70c5839`).

## [0.7.9] - 2026-06-01 - Unlock Status Health, Update Lifecycle Fixes & PM2 Cleanup

This release enhances unlock status output with market adapter and credential daemon health indicators, fixes the unlock update lifecycle to properly restart all runtime services, removes the stale PM2 reload wrapper, and polishes the README around PM2 de-emphasis and unlock mode clarity.

### 2026-06-01

#### Unlock Status Health
- Add credential daemon health detection and status display to unlock status output (`c25197a`).
- Add market adapter health detection and PID-file-based process detection to unlock status, covering both standard and isolated/PM2 modes (`f22dac5`).

#### Unlock Update Lifecycle Fixes
- Restart legacy unlock wrappers (isolated/PM2) after unlock update to ensure all runtime paths pick up new code (`1acd25c`).
- Restart market adapter during unlock updates so the adapter also runs fresh code after an update (`8b26c53`).
- List all runtime services (dexbot, credential daemon, market adapter) in unlock control summaries for complete operational visibility (`a9d8db4`).
- Avoid listing credential daemon service on restarts — only show it in status/start summaries since restart is not a credential-daemon operation (`41087cd`).

#### PM2 Wrapper Removal & README Polish
- Remove the `node pm2 reload` wrapper script (`scripts/reload-pm2.sh`) and clean up all stale references to it across files (`71da709`).
- Simplify supervisor description in README — remove redundant log note, consolidate general information into a dedicated section (`07b8709`).
- De-emphasize PM2 in README: clarify unlock as the primary start mode, reposition PM2 as an advanced/specialized option (`983f665`).

## [0.7.8] - 2026-05-31 - Rename unlock-start to unlock, Unify Launcher & Docs Polish

This release renames `unlock-start` to the simpler `unlock` command, unifies startup and control summaries under a single entry point, hardens monolithic runtime restart after auto-update, cleans up stale rename artifacts from the build, and adds a Performance & Speed section to the DEXBot comparison document.

### 2026-05-31

#### Launcher Command Consolidation
- Rename `unlock-start` to `unlock` — the primary start command is now simply `node unlock` instead of `node unlock-start`. Backward-compatible shim retained for existing scripts (`2ef1a11`).
- Unify startup and control summaries under the same `unlock` entry point — `node unlock` prints a combined status/help summary, `node unlock start` lauches the bot, `node unlock stop` sends graceful shutdown (`48e6bd7`).
- Align `unlock-start delete` flow with monolithic controls — the delete path now correctly stops monolithic (non-isolated) runtimes instead of bypassing them (`5617fbc`).
- Improve monolithic status reporting with clearer running/stopped state indicators (`09bf18b`).
- Fix monolithic runtime restart after auto-update — ensures the restart loop re-spawns the bot after the update script exits (`b204170`).
- Clean `dist/` before build to drop stale `unlock-start` compiled artifacts after the rename (`37f675b`).

#### Documentation
- Add **Performance & Speed** section to `docs/DEXBOT_COMPARISON.md` covering fill processing benchmarks, blockchain interaction efficiency, and resource usage characteristics (`62fef57`).

## [0.7.7] - 2026-05-31 - Default Daemonization, Auto-Update, Per-Bot Logs & MPA debtOnly

This release makes `node unlock` background-daemon mode the default with crash restart, adds auto-update to the monolithic path, introduces per-bot log files with credential daemon output redirect, adds the `debtOnly` MPA lending flag with tightened discriminated-union types, and cleans up the unlock CLI by removing the redundant `control` subcommand.

### 2026-05-30

#### Unlock CLI Simplification
- Remove redundant `control` subcommand from unlock CLI — `node unlock status` now works directly instead of `node unlock control status`. Updated `launch_modes.ts`, `unlock.ts` doc comment, `README.md` usage examples, and launcher export tests (`4af92bf`).

#### MPA debtOnly Flag & Type Tightening
- Add `debtOnly` boolean on MPA lending items in `cr_planner.ts` and `credit_runtime.ts`: keeps collateral constant, adjusts only debt to manage CR bands; planner zeros `collateralDelta` and clears `fallbackAction` when set; runtime skips collateral-only fallback on combined-op failure (`83f9052`).
- Reorganize `docs/MPA_CREDIT_USAGE.md` field tables into Common Required / Shared Optional / MPA-Specific / Credit-Offer-Specific sections; add `renewOnly`, `minDurationSeconds`, `debtOnly` to appropriate tables (`83f9052`).
- Change `DebtPolicyLendingEntry` from flat interface to discriminated union (`MpaLendingEntry | CreditOfferLendingEntry`) in `modules/types.ts`: credit-only fields (`autoReborrow`, `autoRepay`, etc.) only on credit variant; MPA-only fields (`debtOnly`, `minCollateralRatio`, etc.) only on MPA variant (`83f9052`).
- Fix `_findLendingItemForAsset` in `credit_runtime.ts` to accept optional `typeFilter` parameter — caller `repayCreditDeal` passes `'creditOffer'` to prevent returning an MPA item with silently undefined `autoReborrow`/`autoRepay` (`83f9052`).
- Remove `reborrowOnly` alias (pure alias of `renewOnly`) from type, doc, validation, and runtime (`83f9052`).
- Add 2 debtOnly planner tests and 2 bot settings validation tests (`83f9052`).

#### Auto-Update for Monolithic Path
- Add cron-based auto-update to unlock monolithic (default) path — previously only `--isolated` mode (via `bot_supervisor`) and `pm2` had this capability (`c2a6160`).
- Import `UPDATER` from constants, `parseCronExpression`/`getNextCronDate` from `bot_supervisor`; `scheduleMonolithicUpdateJob()` spawns `scripts/update.js` on configured `UPDATER.SCHEDULE` (`c2a6160`).
- Wrap monolithic bot spawn in restart loop: on successful update (exit 0), old bot receives SIGTERM and loop re-spawns with new code (`c2a6160`).
- Timer is `.unref()`'d to not block process exit; cancels cleanly on shutdown (`c2a6160`).

#### Auto-Update Bugfix: Prevent Unnecessary Restarts & PM2 Double-Reload
- Fix exit code 0 used for both "already up to date" and "update applied" — changed to exit 2 for no-updates, so unlock doesn't SIGTERM the bot on every cron tick when nothing changed (`3a0f465`).
- Add `DEXBOT_UPDATE_SKIP_RELOAD` guard in `scripts/update.ts` so update script skips PM2 reload when the launcher manages restart itself (`3a0f465`).
- Pass `DEXBOT_UPDATE_SKIP_RELOAD=1` to update child process from unlock via `buildScopedChildEnv({ extra })`, delegating reload coordination to the launcher lifecycle (`3a0f465`).

#### Background Daemon + Crash Restart
- Default `node unlock` monolithic mode now auto-daemonizes to background, writes PID file, and auto-restarts bot process on crash (13 attempts, 24h stable-uptime reset, 3s delay) (`e3a43f4`).
- Add `--foreground` flag for users who want terminal-attached mode with crash restart (same restart policy, no daemonization) (`e3a43f4`).
- Background logging pipes child stdout/stderr to `profiles/logs/dexbot.log`/`dexbot-error.log`; WriteStreams closed on child `close` event to prevent FD leaks across restarts (`e3a43f4`).
- Graceful shutdown: registers cleanup handler forwarding SIGTERM to dexbot child, waits up to 10s before `process.exit(0)`; prevents orphaned bots on `node unlock stop` (`e3a43f4`).
- `handleControl` restructuring flattens PID-file logic; corrupt/missing PID file falls through to existing isolated-supervisor socket path (`e3a43f4`).

### 2026-05-31

#### Per-Bot Log Files & Credential Daemon Output Redirect
- Logger auto-quiets console output when `logFile` is set — no terminal duplication of file-logged output (`fef7944`).
- OrderManager passes `logFile` from config to Logger at construction; DEXBot wires per-bot log path (`<name>.log`) into OrderManager at both creation sites (`fef7944`).
- Redirect credential daemon stdout/stderr to log files in monolithic background mode; add `stdio` passthrough option to `ensureCredentialDaemon` with proper `StdioOptions` type (`fef7944`).
- Add FD leak guard: proper cleanup of file descriptors on partial `openSync` failure (`fef7944`).

## [0.7.6] - 2026-05-30 - Launcher Hardening, Legacy Code Cleanup & Documentation Sweep

This patch release hardens the unlock launcher against signal-handler leaks and polling hangs, removes deprecated legacy migration code across the vault, config, and price-mode layers, fixes broken script references and hardcoded machine paths, and sweeps documentation for stale line numbers, broken paths, and outdated counts.

### 2026-05-29

#### Docker Build Fix
- Skip npm prepare script during Docker `npm ci` to prevent tsc failure before source COPY (`7142871`).

#### Unlock Isolated Mode Hardening
- Clean up leaked SIGINT/SIGTERM/SIGUSR1/SIGUSR2 signal handlers from `runIsolated`, `main`, and `forwardSignal` paths; store named handler references, extract `cleanupSignalHandlers()`/`cleanupBotHandlers()`, and call on all exit paths (normal close, error, polling rejection). Fix unguarded `setInterval` callback in `runIsolated` — wrap in try/catch, `reject(err)` on exception, clear interval and clean up signal handlers before rejecting. Add `Promise<number>` return type and remove `as any` cast. Add `settled` guard in `waitForSupervisorReady` poll loop to prevent post-settlement timer scheduling. Add regression test `test_unlock_isolated_poll_reject.ts` asserting `main()` settles (no hang) when `getStatus()` throws (`e6e114a`).

### 2026-05-30

#### Unlock Launcher Hardening
- **Daemon ownership**: Add `daemonReleased` flag in `main()`; `finally` block only calls `stopManagedDaemon()` when ownership was not explicitly released, preventing redundant no-op after detached-supervisor path releases the daemon. **Direct-run detection**: Replace fragile `.replace(/\.js$/, '')` with `path.parse().name` for correct `.ts` execution via ts-node. **Supervisor transient-error routing**: Add `isSupervisorTransientError()` helper; `waitForSupervisorReady` poll loop retries only on "No supervisor socket found" and "Connection timed out", surfacing unexpected errors immediately. **Signal forwarding**: Both `forwardSignal` and `credential_daemon.ts` `forwardSignal` now filter for `ESRCH` (process already gone) and rethrow unexpected errors. **Usage documentation**: Add bare `claw-only` alias and `BOT_NAME` environment variable to doc comment (`b9dbe36`).

#### Deprecated Pattern Removal & Broken Reference Fixes
- **Price mode aliases**: Remove `market` and `orderbook` legacy aliases across `system.ts`, `grid.ts`, `dexbot_class.ts`, `account_bots.ts`, `dexbot_profiles.ts`. Only `pool`/`book` accepted. **SHA-256 vault format**: Remove `hashPassword()`, `decryptLegacyRecord()`, `migrateLegacyVault()`. `unlockWithPassword()` and `verifyCurrentPassword()` now require scrypt v2. `main()` in `chain_keys.ts` no longer checks for `masterPasswordHash`. **DUST_CANCEL_DELAY_MIN** migration removed from `constants.ts` and `account_bots.ts`; legacy minute key is now ignored. **staleTailVerifiedTs** single-timestamp → range migration removed from `market_adapter_service.ts`. **deferPersistence** flag removed from `processed_fill_store.ts`. **AMA slope mode** `window`/`cumulative`/`legacy` recognition preserved with division-by-lookback intact for backward compatibility; new writes default to `perBar`. **AMA_SLOPE_PERCENT_MODE_WINDOW** export removed; `market_adapter.ts` fallback now uses `AMA_SLOPE_PERCENT_MODE_PER_BAR`. **Broken references**: `dashboard/src/actions.rs` — remove nonexistent `check-update.sh` action, change `node` → `npx tsx` + `.js` → `.ts`. `claw/package.json` — all `node scripts/*.js` → `npx tsx scripts/*.ts`. Updated `test_chain_keys_vault.ts` (remove legacy vault test, add `testLegacyVaultRejected`), `test_price_derive.ts` (remove legacy market alias test), `test_market_adapter_service.ts` (update legacy stale tail test for range format), `test_dust_cancel_delay_config_migration.ts` (test legacy minute key is ignored) (`ecc1c8d`).

#### Documentation Sweep
- **Stale line numbers** in `docs/architecture.md`: update `Object.freeze`, `deepFreeze`, `_gridVersion`, `_gridLock`, and encapsulation references to current positions. **Broken file paths**: `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` — `utils.ts` → `utils/` and `utils/system.ts`. `docs/LOGGING.md` — `utils.ts` → `utils/`. **Hardcoded machine paths**: `claw/docs/AI_BOT_LIBRARY_API.md` — 6 occurrences of machine-specific paths → `/path/to/DEXBot2`. 6 test files — replace machine-specific paths with `require.resolve()` variable. **Legacy labels**: `analysis/trend_detection/SIGNAL_DOCUMENTATION.md` — add "(Legacy)" title suffix and note pointing to `kalman_trend_analyzer.ts`. **Stale test counts**: `docs/EVOLUTION.md` — 172→173 across 3 locations. `docs/DEXBOT_COMPARISON.md` — 172→173, 101→102 across 5 locations, "JS codebase" → "TypeScript codebase". **Test count clarity**: `docs/LOGGING.md` — "25 tests" clarified as "logging-specific" throughout. **Misc**: `docs/PLAN_MIN_BTS_VALUE.md` — corrected claim that `test_non_bts_fee_handling.ts` exists (never created) (`4514af6`).

## [0.7.5] - 2026-05-25 - Removal of All Dependencies & TypeScript Migration

This release completes the removal of all external runtime dependencies and transitions the entire codebase from JavaScript to TypeScript. All source files, test files, and entry points are now `.ts` with strict mode enabled, compiled through `tsc` and run via `tsx` for development/testing. Thin `.js` shims at the root serve as stable entry points that route to compiled `dist/` output. The project's de facto zero-dependency philosophy is codified as an explicit architectural policy — no remaining npm dependencies at runtime, making the bot fully self-contained.

### 2026-05-23

#### Pre-Release Groundwork
- Document Injectable Module Interfaces plan, replacing the Event Bus in the Phase 6 roadmap (`45a0184`).
- Add optional AMA ER smoothing parameter for adaptive moving average tuning (`14b59d9`).
- Improve bot usage finder with retry logic, export, and help flags (`526413e`).

### 2026-05-24

#### Native BitShares Integration
- Replace `btsdex` npm dependency with native BitShares integration — inline chain operations, types, and broadcast logic (`52a2f8b`).
- Fix connection state leaks and PM2 credential daemon visibility in native client (`72b3a53`).
- Correct chain ID from testnet to real BitShares mainnet (`38d7248`).
- Fix chain ID, transport autoreconnect, and asset lookup crashes (`ae64038`).
- Fix broadcast expiration sent as Unix timestamp instead of ISO string (`fd47cd8`).
- Fix native ECC compatibility with BitShares chain — signature format, canonical enforcement, address spec (`9622254`).
- Fix `chainOrderId` extraction failure after daemon-mediated order creation (`4ddbbc2`).
- Remove `btsdex` npm dependency from Claw module (`9380e86`).
- Complete native BitShares cleanup of remaining `btsdex` references (`e8cf933`).
- Stabilize native reconnect and subscription lifecycle (`ae752ea`).

#### Stability & Foundation
- Normalize native broadcast array results for consistent return types (`e8f3e08`).
- Stabilize startup accounting and websocket idle connections (`6d50074`).
- Centralize native BitShares constants into `NATIVE_CLIENT` constants (`9ac2199`).
- Harden native fill detection under edge conditions (`32852fa`).
- Add zero-dependency isolated process management (`--isolated` mode) (`c3e6aa9`).
- Extract `_processFillsWithBatching` to consolidate fill-chunking pipeline (`4902f55`).
- Detect dust orders regardless of `ACTIVE`/`PARTIAL` state (`b7921f8`).
- Bypass idle check for dust-timer maintenance to prevent stalls (`0a06338`).

#### Zero-Dependency Policy
- Add "Zero-Dependency Policy" section to `docs/architecture.md` with rationale, trading-bot special-case justification, and implications (`187c403`).
- Update `docs/DEXBOT_COMPARISON.md` to reflect zero-mandatory-dependency state (native `bitshares-native/` replaces `btsdex`) (`187c403`).
- Update `docs/EVOLUTION.md` with v0.7.5 release entry, version history, and metadata (`187c403`).
- Bump version to 0.7.5 across manifests, lockfiles, and documentation references (`187c403`).

#### Complete TypeScript Transition
- Migrate all 48K+ lines of production JavaScript to TypeScript across `modules/`, `market_adapter/`, `claw/`, `scripts/`, `analysis/`, and root entry points (`733994b`).
- Convert all 158 test files from `.js` to `.ts` (`db2e4fc`).
- Fix review findings — type safety, native TypeScript correctness, entry points (`25dba97`).
- Address 13 review findings — ECC, test resolution, serialization, transport (`8b5149a`).
- Address comprehensive review — all findings fixed, verified against `bitshares-core` (`2e5356b`).
- Repair Docker and native release gates to reference compiled `dist/` output (`84c81dc`).
- Harden native fill subscriptions against missed history gaps (`2247c5b`).
- Update all `.md` references from `.js` → `.ts`, `btsdex` → `native`, `node` → `tsx` (`45ed4f0`).

#### Infrastructure & Build
- Add `tsconfig.json` with strict settings, `tsx` for test/script runners, `tsc` for production builds (`733994b`).
- Remove redundant double-build from update script (`ea9932e`).
- Wire `connectTimeoutMs` into `createChainClient` to match `TIMING.CONNECTION_TIMEOUT_MS` (`cf2319e`).

#### Post-Migration Fixes
- Harden `unlock` runtime launching for compiled mode (`5121fae`).
- Harden fill sync delivery and locking to prevent race conditions (`82a15f3`).
- Fix connection retry, dust gate, and log rotation config alignment (`d89a8ff`).

### 2026-05-25

#### Post-Migration Stabilization
- Repair update flow shims, bootstrap paths, safe-git entry guards after TS migration (`ad21d37`).
- Restore `NODES` key to `general.settings.json` defaults in `loadGeneralSettings` (`b6afedb`).
- Restore main branch retry behavior in `waitForConnected` (`d4117c9`).
- Only start `dexbot-adapter` when an AMA bot is actually running (`162ad31`).

#### TypeScript Strictness & Build
- Enable strict TypeScript for `modules/`, `market_adapter/`, and `scripts/` — full `noImplicitAny` / `strictNullChecks` (`1cc79b9`).
- Enable strict TypeScript for `claw/` with full coverage, resolving 594 type errors (`a863511`).
- Migrate `moduleResolution` from deprecated `"node"` to `"node16"` across all `tsconfig.json` files (`4875ff6`).
- Remove deprecated `ignoreDeprecations` from all `tsconfig.json` files (`1f6b213`).
- Make entry point `.js` shims work without pre-running `tsc` build (`55422a2`).
- Resolve `__dirname` path resolution bug in compiled `dist/` output (`86bb663`).
- Resolve post-migration regressions — timeout wiring, idle blocking, adapter gating, Claw types (`13d1fff`).

#### Zero-Dependency Enforcement
- Remove `openclaw` optional dependency to maintain strict zero-dep policy (`06587a3`).
- Remove dead file `modules/load_dist_with_mirrors.js` (`045f211`).
- Remove dead claw-side CR tuning code (`bot_auto_tuner`, `buildMarginTradingPlan`, `evaluateAndTune`) (`a50f369`).
- Remove unused `market_adapter/utils/ws_client.ts` wrapper (`4e67e4e`).
- Remove `export {}` from 11 CLI-only analysis runners and 2 market_adapter CLI scripts (`4e67e4e`).
- Remove compiled artifacts, old bot config backup, orphaned scripts, and empty directories (`372e83b`).

#### Stability & Recovery Hardening
- Harden fill replay handling for robustness under edge cases (`168f4a1`).
- Harden native fill subscriptions across activation gaps to prevent missed fills (`9d0ee98`).
- Prevent re-entrant `_fillProcessingLock` deadlock in recovery and grid reset paths (`7f32b60`).
- Prevent open-orders sync loop from blocking trigger reset and maintenance (`3710377`).
- Resolve credential daemon startup hang — use correct project root from `dist/` (`2469b76`).
- Cap bootstrap fill rotation batches to prevent excessive chain calls (`e7dd9c6`).

#### Accounting & Chain Corrections
- Honor Core asset maker fee discount in BTS fee accounting (`8acc6f1`).
- Align native keys and fee accounting with BitShares Core chain behavior (`56eb96c`).
- Centralize CR_ZONES, simplify MPA zone model, adjust fee rate constants (`90f6db7`).
- Consolidate graphene collateral ratio denominator into `constants.ts` (`1b9bebe`).
- Register credit operation serializers and fix `arrayType` sorting (`4792a78`).
- Resolve `setType` `object_id_type` sort order mismatch in transaction building (`d5ad1e4`).

#### Documentation
- Fold TypeScript migration into v0.7.5 release entry, remove from Phase 6 planned (`eaf79cc`).
- Fix stale `cli_utils.ts` reference in `analysis/README.md` (`4e67e4e`).
- Remove stale docs for completed migrations — `FALLBACK_ANALYSIS.md`, `FALLBACK_REMOVAL_SUMMARY.md`, `TYPESCRIPT_MIGRATION_ANALYSIS.md` (`372e83b`).

#### Refactoring & Code Quality
- Deduplicate utility functions across analysis and `market_adapter` — extract `writeJsonAtomic`, `PROJECT_ROOT`, `normalizePoolId`/`normalizeAssetSymbol`/pair helpers, `calcStdDev`, `loadCandleFile`, consolidate `toIntervalLabel` into canonical shared locations (`3781ef2`).
- Create `market_adapter/index.ts` barrel export for clean public API surface, following `modules/order/index.ts` pattern (`4e67e4e`).
- Fix schema in `backtest_bot_fitting.ts` — `loadAmaStrategies` now reads from correct `meta.amas.AMA1..4` keys (`4e67e4e`).

#### Analysis Tooling
- Derive regime thresholds from `HURST_ZONE_BAND` constant in `analyze_regime_windows.ts`, replacing hardcoded 0.55/0.45 to match runtime behavior (`bae01df`).

#### Dead Code & Stale Docs Cleanup
- Remove stale docs (`FALLBACK_ANALYSIS.md`, `FALLBACK_REMOVAL_SUMMARY.md`, `TYPESCRIPT_MIGRATION_ANALYSIS.md`) and obsolete shell scripts (`check-update.sh`, `dev-install.sh`, `setup-aliases.sh`) (`79ffbb7`).

### 2026-05-26

#### Fill Detection & Subscription Overhaul
- Add subscription reconnect retry with cursor-safe error propagation (`6f1b1ff`).
- Add reconnect fill-detection safety net — await subscription restore + post-reconnect sync (`6f6a2c8`).
- Fix websocket fill detection — subscription was silently dropping fills; rewrite notice handling with instance-based tracking and multi-account dispatch (`5ae4f04`).
- Harden fill detection with instance-based cursor filtering and diagnostic logging (`d0f7286`).
- Remove dead owner check in `shouldProcessNoticeForSubscription` (`8f79e31`).
- Fix notice-filter skip by reordering `shouldProcessNoticeForSubscription` checks (`46ca63f`).
- Replace history-scan fill detection with direct-notice dispatch for btsdex parity (`5dfa152`).
- Prevent `btsFeeState` mutation on frozen order object across all paths (`6860b05`).
- Restore `btsFeeState` and detect partial fills after grid reset (`e90ffa9`).

### 2026-05-27

#### Fill Detection Optimization & Fee Accounting
- Switch fill detection to unfiltered `get_account_history` for btsdex parity (`ddf22e0`).
- Add logging to `fetchFillHistoryEntries` and `processObjects`; skip initial catch-up in `subscribe()` (`0f4bef0`).
- Trigger history scan from `handleNotice` for Core-style object-change notices; defer cursor advance on callback failure (`7749bea`).
- Defer cursor advancement on callback failure across all fill delivery paths (`46accd6`).
- Optimize fill subscription — skip redundant RPCs, parallelize multi-account reconnect (`c88ff98`).
- Fix `btsFeeState` unit mismatch and correct cancel refund cap (`591f80c`).

#### BTS Fee Acquisition & AMM Pool Integration
- Add `min_BTS_value` for non-BTS paired bots — BTS fee acquisition via AMM pool (`34c4d06`).

#### Logging Centralization
- Centralize logging — remove dual constructor, migrate 9 modules from `console.*` to Logger (`2819d76`).

#### Post-Migration Fixes
- Add `tsx` fallback to pm2, credential-daemon, unlock, and update shims (`9f1e967`).

#### Stability & Recovery Hardening
- Fix BTS acquisition bugs, fee budget deduction, Logger test stubs, and `toFiniteNumber` import (`da2a2f8`).

#### Cleanup
- Strip deferredPaidFee complexity and unused constant (`7013d04`).

#### Documentation
- Sweep stale metrics, dead references, and `.js` remnants across 25 docs files (`75ad651`).

### 2026-05-28

#### Security & Credential Daemon Hardening
- Remove private-key export from daemon, fix memory zeroing, update security paper (`ba8905e`).
- Preserve daemon error messages in `sendDaemonRequest` (`47e2de8`).
- Fix bootstrap env leak, session churn, orphan double-credit, stale socket cleanup, size-drift precision, orphan dedup key entropy (`d7dc699`).

#### Type Safety & Native Module Cleanup
- Remove `@ts-nocheck` from 5 native modules, fix PM2 test hang, add brain-key golden vectors (`38ee843`).

#### Test Fixes
- Correct subscription test expectations to match production behavior (`408649e`).

## [0.7.4] - 2026-05-22 - Code Cleanup and Documentation Refresh

This patch cleans up unused code paths, refactors a shared validation helper, refreshes the full documentation set for clarity, completeness, and version alignment, and brings the JSDoc layer up to date across the entire codebase.

### 2026-05-22

#### JSDoc Accuracy Pass
- Fix 124 JSDoc inaccuracies across 41 files: 3 misplaced blocks (bitshares_client, math, grid), 7 wrong types/returns (chain_keys, credential_policy, claw_launcher, feed_price_source, chain_orders), and ~114 missing/optional param corrections across modules/order, claw, market_adapter, root, analysis, and scripts (`fecbc4a`).

#### Code Cleanup
- Remove unused dependency packages to reduce install footprint (`56a44df`).
- Inline the Base58Check key validation helper into `chain_keys.js`, eliminating a single-use internal module (`566c2e1`).

#### Documentation Refresh
- Fix duplicate LP Chart section in `scripts/README.md`.
- Clarify logging test count as logging-specific in `docs/LOGGING.md`.
- Update `docs/EVOLUTION.md` last-updated date, commit count, and version history entries with accurate git data.
- Bump version references to 0.7.4 across `docs/README.md`, `docs/DEXBOT_COMPARISON.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`, `docs/TYPESCRIPT_MIGRATION_ANALYSIS.md`, and `docs/EVOLUTION.md`.
- De-duplicate MCR/fee info between claw skill reference files (`honest-asset-list.md` → `honest-assets.md`).
- De-duplicate CR zone content between `POSITION_HEALTH.md` and `position-management.md`.
- De-duplicate pre-history lineage between `EVOLUTION.md` and `DEXBOT_COMPARISON.md`.
- Mark `tests/TEST_UPDATES_SUMMARY.md` as historical reference.

## [0.7.3] - 2026-05-22 - Adapter Packaging and Slope Helper Patch

This patch release aligns Docker launcher documentation with the current runtime layout and centralizes AMA slope conversion helpers used by market-adapter dynamic-weight configuration.

### 2026-05-22

#### Packaging, Runtime Docs, and AMA Slope Helpers
- Align Docker launcher behavior and adapter state documentation with the current runtime layout (`5dcc9eb`).
- Share AMA slope percent-mode, lookback normalization, and per-bar conversion helpers between the core market adapter service and profile override handling to prevent duplicated conversion semantics (`abcb8f9`).

## [0.7.2] - 2026-05-22 - Kalman Stability Patch

This patch release hardens the dynamic-weight Kalman trend path used by the market adapter and Claw trend logic. It focuses on numerical stability, invalid-input guards, and safer research-chart parameter ranges.

### 2026-05-22

#### Dynamic Weight Kalman Stability
- Preserve tuned Kalman filter configuration across analyzer resets, including tactical/modal process-noise settings and the observation time step (`41ccb90`).
- Ignore non-finite Kalman measurements and guard near-zero percentage denominators so bad feed values cannot leak NaN/Infinity into dynamic-weight analysis (`41ccb90`).
- Use structured constant-velocity process noise, Joseph covariance correction, and price-scaled initial covariance for more stable velocity and displacement estimates across very different price ranges (`41ccb90`).
- Prefer raw Kalman velocity/displacement fields in the dynamic-weight chart export so chart calculations retain precision (`41ccb90`).
- Tighten AMA/Kalman slope saturation controls in the dynamic-weight chart to avoid overly aggressive low-end knob values (`41ccb90`, `0a581b9`).

## [0.7.1] - 2026-05-22 - Share AMA Strategy and Readiness Fix

This patch release relocates the Kaufman AMA strategy implementation into the core production codebase so it is shared between the trading runtime, charts, and analysis scripts. It also fixes dynamic weight readiness by gating calculations on the ER period and lookback window rather than the full slow warmup window.

### 2026-05-22

#### Shared AMA Strategy & Readiness
- Relocated Kaufman AMA implementation (`analysis/ama_fitting/ama.js` -> `market_adapter/core/strategies/ama.js`) to share it with production market-adapter runtime (`c90d744`).
- Expose rolling SMA during warmup and seed recursion from the full ER-window SMA (`c90d744`).
- Gate slope calculations on `erPeriod` + `lookbackBars` instead of waiting for the full slowPeriod warmup, allowing usable slope signals to trigger sooner without sacrificing clipping safety (`c90d744`).

## [0.7.0] - 2026-05-18 - Final 0.7 Hardening and Signal Refinement


This update covers the final week of May 0.7 development, focusing on signal refinement, credential daemon stability, credit runtime fixes, and expanded analysis tools.

### 2026-05-08 to 2026-05-16

#### Signal Refinement and AMA Warmup

- Replaced first-price initialization and full convergence warmup with a progressive SMA-based warmup, ensuring smoother AMA anchoring from the first available candles (`6b1e183`, `3351e5b`).
- Clarified SMA warmup phases and medianed input start price handling in documentation to better reflect the underlying math (`582ebd`, `8b0bce6`).
- Updated AMA price and slope delta thresholds for more responsive signal transitions in volatile conditions (`6a1f59a`).
- Applied AMA slope as a direct market price offset, allowing the grid to proactively shift based on trend direction (`af946e8`).

#### Credential Daemon Stability and Hardening

- Stabilized the credential daemon with a major hardening pass: flattened promise chains, improved WebSocket write stability after reconnect, and added broadcast retries with node list mirroring (`2394958`, `0dd6a8e`, `c2fee0f`).
- Improved daemon lifecycle management: fixed immediate shutdown hangs, ignored SIGHUP, and prevented stray SIGINT from killing the process (`bf724ac`, `fdc513e`, `0dd6a8e`).
- Hardened daemon security policy and startup: added bootstrap socket verification, guarded against undefined chain state, and implemented interactive fallback when sockets are missing (`2903dda`, `e1588d9`, `42c6932`).
- Fixed PM2 restart loops and ensured the daemon exits cleanly on bootstrap failure instead of hanging (`304954a`, `aaa7137`).

#### Credit Runtime and MPA Corrections

- Corrected MPA target collateral ratio (CR) encoding and credit pruning logic to ensure accurate debt management (`48c79b5`).
- Made credit pricing pair-scoped and explicit, preventing price leakage across different market pairs (`6005bf1`).
- Preserved pending credit reborrow policy lookups so reborrowing decisions respect the latest configured policy (`75b895e`).

#### Expanded Analysis and Research Tooling

- Introduced the Risk Profile Analyzer with sigma metrics and AMA delta calibration for empirical risk assessment (`f3981e8`, `a3a4ba2`).
- Added a Trade Heatmap analyzer to visualize volume distribution by AMA deviation (`9217a4c`).
- Enhanced chart interactions with improved drag-pan calculations and added TradingView shortcuts for market adapter bot snapshots (`e036a77`, `9d5067e`).
- Integrated market profile AMA settings directly into the TradingView chart generator for high-fidelity research visualisations (`89053c0`).

#### Documentation and Lifecycle Improvements

- Refreshed the documentation index, reordered the analysis README around dynamic weights, and corrected links to the tuning cheat sheet (`9b5084e`, `5380dde`).
- Clarified market adapter signal vs. control logic, grid range market price offsets, and empirical risk management terminology (`f613adb`, `a4e0d0d`, `6c39039`).
- Standardized grid price terminology and updated AMA slope units across runtime and research tools (`cd8c1bc`, `f38c78e`).
- Improved market adapter lifecycle management and stability by hardening timestamp parsing and candle merge robustness (`a5f8006`, `dbdf286`).
- Aligned versioning and comparison docs to the final 0.7.0 state (`7121fee`).
- Promoted the release-facing documentation set to the tagged v0.7.0 line, including the docs index, comparison report, migration analysis, accounting reference, and evolution report.

### 2026-05-01 to 2026-05-07

#### Market Adapter Price Sources and Runtime Modes

- Added first-class support for orderbook-derived candles and fixed-price adapter modes, allowing the market adapter to operate from direct book data or an explicit configured price instead of only LP/Kibana history (`6662be9`).
- Replaced the market adapter's legacy dependency path with a lightweight raw WebSocket client for chain history access, reducing adapter startup weight and making connection behavior easier to isolate (`28979f5`).
- Added a native history fallback path and Kibana-first bootstrap behavior so the adapter can continue building warmup history when one source is incomplete or temporarily unavailable (`f4b75cc`, `23382df`, `882401a`).
- Moved grid recalculation documentation from `market_adapter/` into the central `docs/` tree and refreshed the docs around manual resets, trigger files, and adapter-to-grid handoff (`1dfc69d`, `4513904`).
- Consolidated market adapter trigger persistence so recalculation state is managed in one place instead of being duplicated across service paths (`6727a29`).

#### AMA Warmup, Dynamic Weights, and Signal Gating

- Fixed stale dynamic-weight application by rejecting cached dynamic weights when the base weights in `bots.json` change, preventing old runtime state from silently overriding fresh configuration (`733d0b8`).
- Refreshed the AMA center baseline when a manual grid reset is requested, keeping reset-triggered grids anchored to the current adapter baseline instead of an older center snapshot (`318d367`).
- Expanded AMA warmup behavior with a wider warmup window, corrected convergence calculations, and additional backfill handling when unresolved gaps remain in the candle stream (`23382df`, `4151311`, `35c3476`).
- Added stale-tail pruning and cached stale-tail verification so flat or gap-filled Kibana tails do not poison AMA warmup, while already-confirmed stale tails are not repeatedly queried (`5820c14`, `b257b33`, `4efa7f2`).
- Added AMA slope range reset state so slope-derived dynamic behavior can reset cleanly when market conditions move outside the tracked operating range (`903a4fd`).
- Lowered the default AMA delta threshold to 2% and aligned the documented grid reset defaults with the runtime constants (`2ca77e7`).
- Updated dynamic-weight defaults and removed noisy daemon audit logging to keep live adapter output focused on actionable state (`a3205a1`).

#### Asymmetric Bounds and Grid Placement

- Added asymmetric AMA-slope bound tilt, allowing grid bounds to bias with measured slope instead of applying only symmetric expansion around the center (`f2d8f18`).
- Centralized asymmetric bounds calculations into a dedicated core helper and added targeted tests, reducing duplicated clamp/tilt math across the adapter service (`6382571`).
- Passed tilted bounds through to `createOrderGrid()` and kept `dynamicgrid.json` center data fresh so generated grids reflect the adapter's latest asymmetric center and range (`50b4ca2`).
- Logged asymmetric bounds parameters in market adapter output to make live slope, range, and clamp decisions visible during diagnostics (`9554018`).
- Fixed the asymmetric bounds documentation example so documented defaults match the implementation (`1301688`).

#### BitShares Connectivity, Node Failover, and Fill Replay

- Hardened BitShares node failover with a persistent node blacklist and a 7-day cooldown, reducing repeat attempts against recently failing nodes (`21271c5`, `ef58415`).
- Added startup retry and node-manager coverage for default BitShares client behavior, RPC protocol handling, and blacklist state transitions (`21271c5`, `ef58415`).
- Tightened market adapter WebSocket lifecycle handling with per-cycle reconnects, explicit connection guards, intentional-disconnect handling, and guarded cleanup in `finally` paths (`c147e28`, `cbe06bf`, `2375e90`).
- Hardened fill replay persistence during credential outages so processed-fill state is not lost or partially written when the credential daemon is unavailable (`41aad06`).

#### Diagnostics, Cleanup, and Operational Scripts

- Added direct market adapter diagnostics for adapter-client behavior, WebSocket lifecycle checks, and node connectivity (`tests/diag_adapter_client.js`, `tests/diag_ws_lifecycle.js`, `tests/diag_ws_nodes.js`).
- Aligned market adapter diagnostics and tests with current runtime behavior after the refactor, including no-write paths, snapshot handling, and current latching semantics (`f6d9306`, `f33b3ff`).
- Extended `clear-market-adapter` cleanup so it also removes `dexbot-adapter` logs, making state-reset runs less likely to inherit stale operational output (`d05b933`).
- Renamed the settings cleanup script from `clean-settings.sh` to `reset-settings.sh` and updated script documentation so the command name matches its operational purpose (`0788722`).
- Clarified the market adapter whitelist requirement for live operation and updated whitelist generation around the new market adapter inputs (`61056f9`, `f2d8f18`).

#### Analysis and Research Tooling

- Decoupled the AMA fitting chart generator from `lp_chart_runner`, reducing coupling between fitting experiments and the LP chart orchestration path (`8f3b1d9`).
- Unified LP data source structure and removed hard-coded pool/asset references so analysis tools can be reused across markets more safely (`2d866d0`).
- Added AMA convergence calibration support and refreshed AMA fitting utilities around current warmup and convergence assumptions (`4151311`).
- Expanded `analysis/README.md` with a fuller subarea map, added signal-reference links, and reorganized the dynamic-weight research documentation for readability (`58fb6ff`, `26298af`).

#### Documentation Refresh

- Reorganized and trimmed the documentation index, then rebalanced section headings and labels so the docs hub points at the current architecture, analysis, market-adapter, and operational material (`152e78b`, `9e41790`, `f925c33`).
- Updated project evolution and roadmap documentation to reflect the current post-0.7 runtime direction and removed stale planning documents that no longer describe active behavior (`e1c78c1`).
- Expanded the market adapter README with current source modes, asymmetric bounds behavior, reset flow, logging fields, and whitelist guidance (`6662be9`, `f2d8f18`, `903a4fd`, `e9e7dbb`).
- Aligned user-facing defaults across the main README, market-adapter docs, and global bot-settings help text so AMA delta, dust-cancel, and example bot values match current runtime defaults.
- Refreshed version and roadmap-facing markdown in `docs/`, and updated comparison and migration analysis docs to match the current test-file count.

#### Test Coverage

- Added and expanded tests around market adapter service behavior, orderbook/fixed-price modes, AMA center snapshots, asymmetric bounds, dynamic-weight override wiring, Kibana candle handling, and market adapter log formatting.
- Added BitShares client and node-manager regression coverage for startup retry, default node-manager wiring, RPC protocol behavior, and persistent failover policy.
- Updated fill replay, COW, fee schedule, strategy, startup partial-fill, and maintenance-runtime tests to match the current runtime behavior after the adapter and persistence changes.

### 2026-03-01 to 2026-03-03

- Finished the market-adapter foundation by documenting AMA and grid recalculation semantics, clarifying `gridPrice` and AMA profile behavior, and tightening the README/docs around the new grid graphic.
- Finalized fixed-cap fill batching and shard-parallel AMA fitting, then tagged `v0.6.0` on March 3 with the merged `gridPrice` price-section behavior and market-adapter trigger wiring.
- Cleaned up LP charting and analysis helpers so the new adapter flow had a stable export path and consistent documentation.

### 2026-03-06 to 2026-03-24

- Expanded the AMA analysis toolchain with longer histories, date-range fetching, merged candle exports, and log-scaled LP charts.
- Promoted AMA3 defaults, refreshed adapter analytics, and removed stale references so market-adapter tuning matched the current codebase.
- Added dust-cancel delay handling and updated the settings, analyzer, and README flows so partial cleanup and startup timing stayed consistent.

### 2026-03-28 to 2026-04-05

- Expanded Claw runtime support with the bridge/runtime split, native BitShares integration, ZeroClaw support, and the direct tuning / reasoning bridge.
- Hardened fill replay handling and extracted the fill and maintenance runtimes, separating execution from orchestration and making replay-safe processing easier to reason about.
- Tightened credential-daemon startup and policy enforcement while keeping the launcher and PM2 flow aligned with the new runtime structure.

### 2026-04-09 to 2026-04-16

- Added the derivative analysis engine and then trimmed the live signal stack to the active set: SMA, fastSMA, MACD, RSI, and momentum gating.
- Moved market-offset control into market-profile policy, aligned the dry-run/write-output split, and added the AMA slope plus ATR dynamic-weight path.
- Introduced Hurst and Permutation Entropy regime detection, then completed the research-to-production parity work so the live adapter, research charts, and regime gate used the same defaults and clamps.
- Added the dynamic-weight research chart, volatility chart, and Kalman echo/latching work; also renamed the price mode from `market` to `book` for consistency.

### 2026-04-17 to 2026-04-24

- Added the TradingView/uPlot exporter and finished the debt runtime for MPA and credit workflows, including borrow, repay, and auto-reborrow paths.
- Hardened dynamic-weight persistence, closed-candle processing, and runtime alignment so the research chart and live adapter stayed in sync.
- Added LP credit-offer safety checks, consolidated whitelist handling, and deferred grid maintenance while active fills were present.
- Wrapped up the April hardening pass with market-adapter patch fixes, Claw validation coverage, simplified chart entrypoints, the internal `v0.7` metadata, and the first pass of the docs refresh.

### 2026-04-25 to 2026-05-01

- Expanded credit and MPA collateral policy, unified positive-value helpers, and tightened the runtime’s fee and borrow sizing paths.
- Simplified market-adapter diagnostics and startup behavior, including direct runtime management, explicit whitelist generation, and stricter latching/logging for adapter state.
- Reorganized the documentation hub, refreshed the market-adapter README, linked the dynamic-weight research docs, and updated the evolution report so the docs now point to the current codebase.
- Added the root changelog entry, linked it from the docs index and evolution report, and moved the hero image to `docs/media/DEXBot2.webp` for the README banner.

### 2026-05-16 to 2026-05-18

#### Credit Maintenance and Grid Reset Hardening

- Added collateral-gated credit increases so CR adjustments respect collateral availability before broadcasting (`a1f538b`).
- Introduced renew-only credit offer policy for deal renewal without fresh borrowing (`23a7115`).
- Hardened credit deal renewal with fallback offer safety to prevent unsafe renewals when primary offers are unavailable (`c820d8b`).
- Ensured credit maintenance runs during startup so debt positions are validated before trading begins (`5b93b67`).
- Synchronized local `autoRepay` state after successful `credit_deal_update` broadcast to prevent stale policy decisions (`23a7115`).
- Centralized grid reset metadata handling to prevent lost reset state across restarts (`2743744`).
- Preserved dynamic grid reset state so AMA-triggered resets survive maintenance cycles (`3e6b956`).
- Clarified empirical table sources in documentation for regime detection and dynamic weight references (`80f6ca0`).

## [0.6.0-patch.26] - 2026-02-28 - Documentation Updates: Simplified Architecture & Removed Split/Merge Logic

This patch updates documentation to reflect the simplified design philosophy of DEXBot2: **simplicity, constant spread, minimal blockchain interaction, closed-loop market dynamics, and powerful maintenance tools**. It clarifies that the bot achieves perfect market level and trading pattern handling through elegant mechanisms rather than complex partial-handling logic.

### Documentation Changes

All user-facing and developer documentation updated to emphasize the simplified, production-ready architecture:

- **docs/architecture.md**:
  - Added **Design Philosophy** section explaining core principles: constant spread, direct consolidation, minimal blockchain interaction, closed-loop dynamics, and maintenance tools
  - Updated **Fill Processing Flow** diagram to remove "Double Token" and "Double Replacement" special cases
  - Renamed **Scaled Spread Correction** to **Spread Correction (Fund-Aware Approach)** and simplified explanation
  - Emphasized constant target spread width, fund-safe constraints, and natural smoothing over multiple cycles
  - Removed references to complex merge/split decision logic

- **docs/FUND_MOVEMENT_AND_ACCOUNTING.md** (Section 4):
  - **Replaced** "Partial Order Handling (Merge & Split Logic)" with **"Simplified Consolidation"**
  - Removed complex merge/split decision flow and special-case logic
  - Clarified that dust partials are absorbed into next grid rebuild cycle (not handled by separate mechanics)
  - Updated fund dynamics explanation to show direct grid regeneration approach
  - Removed "ReactionCap bonus" and side-specific doubling flag mechanics from user-facing docs
  - Emphasized fund-safety and constant spread as core properties

- **docs/README.md** (Documentation Index):
  - Updated Architecture section to highlight **Design Philosophy** as first item
  - Replaced "Scaled Spread Correction" reference with "Spread Correction: Conservative, fund-aware maintenance"
  - Added partial consolidation summary to Fund Movement section
  - Emphasized 60-80% reduction in blockchain interaction vs legacy approaches

- **README.md** (Main User Documentation):
  - Updated **Features** section to highlight:
    - Constant Spread Maintenance (fixed gap without complex handling)
    - Minimal Blockchain Interaction (fund-driven, batch-based)
    - Powerful Maintenance Tools (boundary-crawl, regeneration, verification)
  - Replaced emphasis on "Persistent State Management" with "Powerful Maintenance Tools"
  - Added clarity on fill batching efficiency (1-4 fills/broadcast, ~24s for 29 fills)

### Why This Matters

The documentation now clearly communicates DEXBot2's core strength: **elegant simplicity**. The bot handles market dynamics through:
1. **Boundary-Crawl**: Natural price-following mechanism (no manual spread inflation)
2. **Fund-Driven Rebalancing**: All operations respect available funds (no forced allocations)
3. **Grid Regeneration**: Periodic rebuild absorbs partials naturally (no merge/split state machine)
4. **Constant Spread**: Predictable, fixed-width gap (no dynamic triggers)
5. **Recovery Retries**: Periodic self-healing (no permanent lockup)

This approach is:
- ✅ Simpler to understand and maintain
- ✅ More reliable (fewer edge cases)
- ✅ More efficient (60-80% fewer blockchain operations)
- ✅ Production-proven (handles market crashes, stale orders, orphan fills)

### Files Modified

- `README.md` - Features section
- `docs/architecture.md` - Design philosophy, fill flow, spread correction sections
- `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` - Section 4 complete rewrite
- `docs/README.md` - Architecture and Fund Movement index entries

### No Code Changes

This patch is **documentation-only**. All underlying mechanics remain unchanged—this update simply clarifies the existing simplified design that has been proven in production.

---

## [0.6.0-patch.25] - 2026-02-25 - CacheFunds Removal & Grid Regeneration Simplification

This patch removes the redundant `cacheFunds` tracking infrastructure and simplifies the grid regeneration trigger to use the directly-calculated `availableFunds` metric. Since fill proceeds are immediately added to `chainFree` (via `adjustTotalBalance`), a separate cache tracking mechanism creates unnecessary complexity without providing unique information beyond what `availableFunds` already calculates.

### Removed

- **CacheFunds Tracking Removed Entirely** (`modules/order/accounting.js`, `modules/order/manager.js`, `modules/account_orders.js`, `modules/dexbot_class.js`, `modules/order/utils/system.js`)
  - **Problem**: `cacheFunds` tracked accumulated fill proceeds and rotation surplus, but since these amounts are immediately available as part of `chainFree`, dual tracking creates redundancy and complexity.
  - **Impact**: Simplified codebase, removed async locking complexity from cache deductions, eliminated the need for separate cache consumption calculation during COW batch execution.
  - **Solution**:
    - Removed `_modifyCacheFunds()`, `modifyCacheFunds()`, `setCacheFundsAbsolute()` methods from Accountant
    - Removed `_getCacheFunds()`, `modifyCacheFunds()`, `setCacheFundsAbsolute()` wrappers from OrderManager
    - Removed `loadCacheFunds()`, `updateCacheFunds()` persistence methods from AccountOrders
    - Removed cacheFunds parameter from `storeMasterGrid()` and `persistGridSnapshot()`
    - Removed cacheFunds deductions from `processFillAccounting()` (proceeds now only go to `chainFree`)
    - Removed cacheFunds initialization/reset from startup and grid regeneration flows

- **Simplified Grid Regeneration Trigger** (`modules/order/grid.js`)
  - **Problem**: Grid regeneration ratio check used `MAX(cacheFunds, availableFunds)` which was overly conservative.
  - **Impact**: Unnecessary complexity with two-input max() when a single signal suffices.
  - **Solution**: Changed to use `availableFunds` directly as the sole ratio numerator:
    ```
    ratio = (availableFunds / allocatedCapital) * 100
    ```
  - Removed `cacheInput` and `cachePending` variables from ratio check
  - Removed `cacheFunds` parameter from `checkAndUpdateGridIfNeeded()` method signature

- **Removed Redundant COW Cache Deduction** (`modules/dexbot_class.js`)
  - **Problem**: `_calculateCacheConsumptionFromContexts` in `_updateOrdersOnChainBatchCOW()` was attempting to deduct from cacheFunds after capital was already consumed in `updateOptimisticFreeBalance`.
  - **Impact**: Double-deduction would have been a correctness bug (prevented by locking around modifyCacheFunds).
  - **Solution**: Removed the entire `_calculateCacheConsumptionFromContexts` call and associated cache deduction block from the COW batch post-execution flow.

### Updated Documentation

All `cacheFunds` and `cache remainder` references removed from the 7 core docs referenced by `docs/README.md`. Terminology updated to use `availableFunds`, `chainFree`, and `unallocated remainder` consistently.

- **docs/FUND_MOVEMENT_AND_ACCOUNTING.md**:
  - Removed `cacheFunds` from fund components table and all formulas
  - Updated critical invariants section to focus on `availableFunds` as sole signal
  - Clarified grid regeneration trigger uses `availableFunds` ratio only
  - Enhanced split/merge documentation with clearer examples and fund consumption tracking
  - Added decision flow diagram for partial order handling (Dust → Merge, Significant → Split)
  - Added violation response detail to Safety & Invariants section (what happens when invariants fail)
  - Completed dangling sentence in §1.5 (listed fully-allocated vs fund-capped slot distinction)
  - Added user-visible symptom to Mixed Order Fund Validation problem description
  - Updated BTS fee reservation to reference `BTS_RESERVATION_MULTIPLIER` constant with correct 5× default
  - Updated fee settlement and orphan-fill handler to reflect direct `chainFree` accounting

- **docs/architecture.md**:
  - Removed `cacheFunds` from all mermaid diagrams (inputs, engine, internal tracking, persisted state)
  - Updated fill crediting flow (`chainFree` instead of `cacheFunds`)
  - Updated persistence strategy (fund state derived at runtime, not separately persisted)
  - Fixed missing item 6 in "Recent Improvements" numbering
  - Updated module responsibility descriptions to remove "cache remainder" terminology

- **docs/developer_guide.md**:
  - Removed `cacheFunds` from fund components table and available funds formula
  - Fixed all `tests/unit/` paths to actual `tests/` directory (broken references)
  - Updated test file table to match real filenames (`test_strategy_logic.js`, etc.)
  - Updated test runner commands from `npx jest` to `node tests/<file>.js`
  - Updated FAQ entry for test locations

- **docs/TEST_UPDATES_SUMMARY.md**:
  - Fixed all `tests/unit/` paths to actual `tests/` directory
  - Fixed cross-reference from `§ 3.7` to correct `§ 3.6` for orphan-fill deduplication
  - Updated test runner commands
  - Added transition paragraph between bugfix regression tests and crash stress tests
  - Rewrote cacheFunds integration test section as fund tracking integration

- **docs/LOGGING.md**:
  - Updated batch processing log example and log tag table

- **docs/EVOLUTION.md**:
  - Updated fund management description

- **docs/COPY_ON_WRITE_MASTER_PLAN.md**:
  - Replaced dangling `/docs/INCIDENT_REPORT_XRP_BTS_PRICE_JUMP.md` reference with inline incident description

### Tests Updated

- `tests/test_cow_commit_guards.js` - Removed cache deduction assertions from 3 tests (005, 006, 007)
- `tests/test_bts_fee_accounting.js` - Simplified fee settlement test to verify baseCapital reduction only
- `tests/test_accounting_logic.js` - Removed cacheFunds-specific test
- `tests/test_grid_logic.js` - Updated ratio check test for availableFunds-only logic
- `tests/test_bts_fee_logic.js` - Removed cache verification from 2 fee settlement tests

**Test Result**: All 36+ test suites still passing (exit code 0)

### Core Lines Changed
**Total: ~700** (445 added, 694 removed, net: -249 across 40 files)
- `modules/order/accounting.js`: -85 lines (3 methods removed, 2 calls removed)
- `modules/order/manager.js`: -12 lines (3 methods removed)
- `modules/account_orders.js`: -48 lines (2 methods removed, 3 initialization blocks)
- `modules/dexbot_class.js`: -18 lines (removed persist call, startup restore)
- `modules/order/utils/system.js`: -6 lines (removed reset, param from persist call)
- `modules/order/grid.js`: -23 lines (simplified ratio check)
- Test updates: -35 lines across 20 test files
- Documentation: +180/-134 lines across 8 doc files (cleanup, fixes, added explanatory content)

### Benefit

- **Reduced Complexity**: Eliminated dual-tracking and async locking overhead in fund calculations
- **Cleaner Accounting**: Grid regeneration now uses single source of truth (`availableFunds`)
- **Simplified COW**: No longer needs to calculate/deduct cache consumption in COW batch flow
- **Same Behavior**: Grid still regenerates when available funds exceed 3% of allocated capital
- **Safer Code**: Fewer fund-tracking paths = fewer places for off-by-one errors

---

## [0.6.0-patch.24] - 2026-02-23 - Fill/Sync Consistency, Startup Ordering & COW Integer-Exact Accounting

This patch closes several post-patch.23 correctness gaps discovered in production-like fill/sync timing: stale-size residuals at 1-satoshi precision, startup sequencing that could reconcile before sync-detected fill rebalance, and COW optimistic cache deductions that could diverge from executed chain integers. It also hardens reconnect/recovery state transitions and unifies paired-create ordering across startup and COW execution.

### Fixed

- **COW Cache Deduction Aligned to Executed On-Chain Ints** (`modules/dexbot_class.js`, `modules/order/utils/validate.js`) - commit 7f02c09
  - **Problem**: Optimistic cache-fund deduction could be derived from planned float values instead of finalized integer operation amounts.
  - **Impact**: Small accounting drift could accumulate between tracked cache commitments and blockchain-executed values.
  - **Solution**: Route deduction paths through executed integer payloads so COW accounting mirrors exact on-chain amounts.

- **Outside-In Paired CREATE Ordering Shared Across Startup and COW** (`modules/dexbot_class.js`, `modules/order/startup_reconcile.js`, `modules/order/utils/order.js`) - commit c7a685f
  - **Problem**: Startup and COW paths used different create-order pairing/grouping behavior.
  - **Impact**: Inconsistent slot pairing and placement ordering between bootstrap and steady-state execution.
  - **Solution**: Introduced shared grouping helpers and standardized outside-in paired CREATE sequencing across both paths.

- **Startup Sync Fill Rebalance Executed Before Reconcile** (`modules/dexbot_class.js`) - commit c625551
  - **Problem**: Startup reconcile could run before sync-detected fills were fully rebalanced.
  - **Impact**: Reconcile decisions could be made against pre-rebalance state, increasing transient divergence risk.
  - **Solution**: Reordered startup flow to execute sync fill rebalance first, then run startup reconcile on updated state.

- **Eliminated 1-Satoshi Stale-Size Fill Residuals** (`modules/dexbot_class.js`, `modules/order/manager.js`, `modules/order/sync_engine.js`, `modules/order/utils/validate.js`) - commit 0334360
  - **Problem**: Precision-boundary edge cases could leave 1-sat residual size artifacts after fill/sync/COW transitions.
  - **Impact**: Residuals caused avoidable follow-up corrections and noisy state deltas.
  - **Solution**: Normalized stale-size handling in COW projection/sync paths so zero-equivalent dust at chain precision is cleared consistently.

- **Fill Recovery and Rebalance State Reset Hardening** (`modules/dexbot_class.js`, `modules/order/accounting.js`, `modules/order/sync_engine.js`) - commit d0de685
  - **Problem**: Recovery/resubscribe/rebalance state transitions could leave stale flags or incomplete reset behavior after reconnect/failure episodes.
  - **Impact**: Increased chance of delayed self-healing or repeated recovery loops under unstable connectivity.
  - **Solution**: Hardened recovery lifecycle resets across event patching, sync, accounting, and bot orchestration paths.

- **Sync No Longer Recomputes Order State from Chain Size** (`modules/order/sync_engine.js`, `modules/constants.js`) - commit f18ae6d
  - **Problem**: `resolveStateFromChainSize` introduced state inference in sync where state should remain commit-driven.
  - **Impact**: Sync pass could reclassify order state unexpectedly.
  - **Solution**: Removed chain-size-to-state resolver usage so sync preserves canonical state semantics.

- **Removed MAX_ORDER_FACTOR Cap Blocking Grid Resize on New Funds** (`modules/constants.js`, `modules/dexbot_class.js`) - commit 99d721a
  - **Problem**: A hard size-factor cap constrained legitimate resize operations after new funds became available.
  - **Impact**: Grid expansion under fresh capital could be artificially blocked.
  - **Solution**: Removed cap path to allow intended resize behavior while retaining existing safety checks.

### Documentation

- **COW Invariant Docs Added** (`docs/COW_INVARIANTS.md`, `docs/WORKFLOW.md`) - commit b76df19
  - Added explicit invariant contracts and promotion-review references for safer patch promotion audits.

### Testing

- Updated and expanded regressions in:
  - `tests/test_cow_commit_guards.js`
  - `tests/test_sync_logic.js`
  - `tests/test_accounting_logic.js`
  - `tests/test_cow_master_plan.js`
  - `tests/test_legacy_cow_projection.js`
  - `tests/test_startup_decision.js`

### Core Lines Changed
**Total: 564** (357 added, 207 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.23] - 2026-02-22 - Dust Rotation Guard, Legacy Builder Removal & PARTIAL Fund Invariant Fix

This patch closes two fund-accounting correctness gaps: dust-sized slots could still be reached via surplus→hole rotation despite CREATE filtering, and PARTIAL orders had their actual on-chain remaining size silently overwritten with the ideal target size in the COW projection step, causing a spurious fund-invariant violation. Legacy plan-builder helpers that duplicated COW execution logic are also removed.

### Fixed

- **Dust Rotation Guard in reconcileGrid** (`modules/order/utils/validate.js`, `modules/order/manager.js`) - commit af33cdd
  - **Problem**: `reconcileGrid` filtered dust only for CREATE leftovers. Surplus→hole rotation UPDATE paths bypassed the filter, allowing sub-double-dust target slots to receive rotation operations.
  - **Impact**: Tiny, uneconomical orders could still be scheduled via rotation UPDATE even when they would have been rejected as CREATE targets.
  - **Solution**: Added configurable `dustThresholdPercent` option to `reconcileGrid`. Healthy holes are now computed up front using `isCreateHealthy` before any surplus pairing occurs, ensuring the same dust threshold applies to both rotation and direct CREATE paths. `GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE` is now passed through both manager reconcile entry points for consistent runtime behaviour.

- **PARTIAL Order Size Preserved in COW Projection** (`modules/order/utils/validate.js`) - commit (current)
  - **Problem**: `projectTargetToWorkingGrid` unconditionally overwrote the working-grid order's `size` with `targetSize` (the ideal geometric size from `calculateTargetGrid`). For PARTIAL orders still on-chain, `targetSize` reflects the desired full size, not the actual remaining quantity. Because `reconcileGrid` intentionally emits no in-place UPDATE for this case (rotation-only design), no blockchain resize occurs — yet `recalculateFunds` was summing the ideal size as committed, inflating `chainBuy` by up to ~350 BTS.
  - **Impact**: Spurious CRITICAL fund-invariant violation (`trackedTotal > blockchainTotal`) after any partial buy fill, self-correcting only at the next 4-hour blockchain sync.
  - **Solution**: Added a narrowly scoped guard: when `keepOrderId` is true (order is still on-chain, same type) and `current.state === PARTIAL`, preserve current on-chain size instead of overwriting with `targetSize`. Preserve-path sizing is normalized to a finite non-negative value for safety, and redundant `hasOnChainId` duplication was removed because `isOrderOnChain` already guarantees an on-chain id.

### Refactored

- **Legacy Plan-Builder Removal** (`modules/dexbot_class.js`) - commit af33cdd
  - Removed `_buildCancelOps`, `_buildCreateOps`, `_buildSizeUpdateOps`, and `_buildRotationOps` — pre-COW helpers that duplicated execution logic now handled solely by the COW action execution path.
  - Centralized execution-time size and dust validation into `_resolveIdealSizeForValidation` to eliminate repeated logic across placement paths.

### Testing

- Added **COW-017** (`tests/test_cow_master_plan.js`) — asserts `reconcileGrid` emits no CREATE or rotation UPDATE for sub-double-dust target holes.
- Added **COW-018** (`tests/test_cow_master_plan.js`) — asserts `projectTargetToWorkingGrid` preserves `current.size` for PARTIAL on-chain orders (regression guard for the fund-invariant violation).
- Added **COW-018b** (`tests/test_cow_master_plan.js`) — asserts ACTIVE orders still receive the updated target size (fix is narrowly scoped to PARTIAL state).
- Added **COW-018c** (`tests/test_cow_master_plan.js`) — asserts malformed PARTIAL preserve-path sizes are normalized to safe finite non-negative values while retaining on-chain identity/state.
- Updated `tests/test_patch17_invariants.js` — removed stubs for deleted legacy builder methods.
- Updated `tests/test_rotation_fallback_recheck.js` — replaced legacy-helper invocation checks with assertions that those methods no longer exist.
- `npm test` ✓ (all 40+ tests pass, zero regressions)

### Core Lines Changed
**Total: ~580** (dust guard + legacy removal commit af33cdd: 183 added / 374 removed; PARTIAL fix: 10 added / 3 removed)

---

## [0.6.0-patch.22] - 2026-02-21 - Fill Accounting Alignment, COW Invariant Hardening & API Safety

This patch aligns BTS fee handling with the operation-fee lifecycle, hardens COW fill/rebalance flows against race conditions and edge cases, and replaces positional-boolean APIs with explicit options objects to prevent ordering bugs.

### Fixed
- **BTS Fill Accounting Alignment with Operation-Fee Lifecycle** (`modules/order/strategy.js`, `modules/order/accounting.js`) - commit 73754c8
  - **Problem**: Fill processing accrued/deducted BTS fees after proceeds already included maker refund projection, causing maker fills to be effectively charged twice across create + fill settlement.
  - **Impact**: Overcharging maker fills with combined refund-projected proceeds and additional fill-time BTS fee settlement.
  - **Solution**: Removed fill-time `btsFeesOwed` accrual/settlement from strategy. BTS fee handling now stays on operation events (create/update/cancel), and fill accounting focuses on proceeds via unified `getAssetFees('BTS', rawAmount, isMaker).netProceeds`.

- **COW Fill Handling and Accounting Invariants** (`modules/dexbot_class.js`, `modules/order/accounting.js`, `modules/order/strategy.js`, `modules/order/utils/validate.js`) - commit 7dbbb49
  - **Problem**: Fill rebalance flow was vulnerable to empty-batch execution paths, CREATE actions could target occupied slots in edge races, and side metadata drift could misclassify commitments after boundary flips.
  - **Impact**: Inconsistent empty payload handling, slot exclusivity violations, wrong-side optimistic deductions, and SPREAD invariant drift.
  - **Solution**: Centralized batch execution gating with shared empty-action handling across all call sites. Added pre-broadcast validation to reject CREATE actions on occupied ACTIVE/PARTIAL slots. Side resolution now prefers explicit order type and preserves committed side from slot type in target-grid projections.

- **COW Rebalance Invariant Race Elimination** (`modules/order/manager.js`, `modules/dexbot_class.js`) - commit b27619a
  - **Problem**: COW commit path triggered fund recalculation before optimistic accounting was applied, producing transient invariant violations.
  - **Impact**: Race condition between commit and recalc could produce false invariant failures.
  - **Solution**: Made `_commitWorkingGrid` recalculation optional via explicit `options.skipRecalc`. Commit path now defers recalculation to resume flow.

- **Order Edge-Cases Across Chain Modules** (`modules/chain_orders.js`, `modules/order/startup_reconcile.js`, `modules/chain_keys.js`, `modules/account_bots.js`) - commit 986a28a
  - **Problem**: `_ensureAccountSubscriber()` swallowed subscription failures, `createOrder()` could destructure `null` from `buildCreateOrderOp()`, `_getAssetPrecision()` returned `undefined` on missing metadata, and reconcile flow misinterpreted `{ skipped: true }` responses.
  - **Impact**: Silent subscription outages, TypeError on dust-sized orders, less actionable precision errors, and malformed success payload interpretation.
  - **Solution**: Log subscription failures with account context, return `{ skipped: true }` for intentionally skipped placements, add explicit CRITICAL throw for missing asset metadata, and handle skip explicitly in reconcile flow.

### Refactored
- **Positional-Boolean to Options Object API Migration** (`modules/order/manager.js`, `modules/order/sync_engine.js`, `modules/order/grid.js`, `modules/order/strategy.js`, `modules/order/utils/order.js`, `modules/dexbot_class.js`) - commit b27619a
  - Replaced legacy positional flags with explicit options objects for `_updateOrder`, `_applyOrderUpdate`, `applyGridUpdateBatch`, and `_runGridMaintenance`.
  - Removed legacy compatibility shims and enforced object options to prevent ambiguous call signatures that made ordering bugs easier to introduce.

- **Removed Redundant rawOnChain Deep-Clone** (`modules/order/working_grid.js`) - commit 4cb3430
  - Deep-clone block was redundant because partial-fill updates already use immutable replacement and operation builders consume cached rawOnChain from master state.
  - Updated WorkingGrid docs/comments to match actual shallow clone behavior (metadata-only nested clone).

### Documentation
- **Data-Flow Diagram and DEXBot Comparison** (`docs/architecture.md`, `docs/DEXBOT_COMPARISON.md`, `AGENTS.md`) - commit 6026de5
  - Added top-level data-oriented Mermaid flowchart to architecture.md (GitHub-compatible with br/ line breaks).
  - Added comprehensive DEXBot vs DEXBot2 comparison report (797 lines).
  - Clarified that agents must not proactively ask for or execute git write actions.

- **TOC Header Errors in 6 Module Files** (`modules/bots_file_lock.js`, `modules/graceful_shutdown.js`, `modules/order/async_lock.js`, `modules/order/format.js`, `modules/order/startup_reconcile.js`, `modules/order/sync_engine.js`) - commit 32be4dd
  - Fixed inaccurate section counts and added missing function entries across all affected modules.

- **Project Evolution Documentation** (`docs/EVOLUTION.md`) - commit 2ec1ae3
  - Added comprehensive 499-line EVOLUTION.md documenting project history and architectural decisions.

- **AGENTS.md Cleanup** - commit c47acd6
  - Removed obsolete "Recent Updates" section.

### Testing
- `node tests/test_strategy_logic.js` ✓
- `node tests/test_bts_fee_accounting.js` ✓
- `node tests/test_cow_commit_guards.js` ✓
- `node tests/test_cow_concurrent_fills.js` ✓
- `node tests/test_patch17_invariants.js` ✓
- `node tests/test_sync_logic.js` ✓
- `node tests/test_grid_logic.js` ✓
- `node tests/test_cow_master_plan.js` ✓
- `npm test` ✓

### Core Lines Changed
**Total: 1,282** (678 added, 604 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.21] - 2026-02-19 - StateManager Consolidation

Eliminated duplicate state tracking where `isBootstrapping` and `_isBroadcasting` were maintained as both direct `OrderManager` properties and `StateManager` fields, requiring both to be kept in sync and creating a latent bug class.

### Refactored
- **Consolidated Bootstrap and Broadcast State** (`modules/order/manager.js`, `modules/dexbot_class.js`, `modules/order/accounting.js`, `modules/order/grid.js`) - commit f9bc182
  - **Problem**: `isBootstrapping` and `_isBroadcasting` existed as direct `OrderManager` properties *and* as `StateManager` fields simultaneously. `isPipelineEmpty()` queried `broadcasting || this._isBroadcasting` — two paths to the same state — evidence of prior divergence.
  - **Impact**: Any code path that updated one tracker but not the other caused a silent divergence. The double-check was a defensive hedge that indicated the trackers had already drifted.
  - **Solution**: Removed `this._isBroadcasting` and `this.isBootstrapping` direct properties. `StateManager` is now the sole source of truth. All read sites updated to `this._state.isBootstrapping()` and `this._state.isBroadcastingActive()`. Deleted the tech debt TODO block that tracked this problem.
  - **Dead code removed**: Else-branch `manager.isBootstrapping = true` in `recalculateGrid()` — `startBootstrap()` always exists; the runtime fallback was unreachable.

### Fixed
- **Broken Test Case** (`tests/test_resync_invariants.js`) - commit f9bc182
  - Case 3 checked `level === 'warn'` but the code logs at `'error'`. Additionally `assets=null` caused an early return from `_verifyFundInvariants`, meaning the test never validated what it claimed. Rewrote to match the pattern of Cases 1 and 2.

### Testing
- `node tests/test_resync_invariants.js` ✓
- `node tests/test_manager_logic.js` ✓
- `node tests/test_accounting_logic.js` ✓
- `node tests/test_grid_logic.js` ✓
- `node tests/test_resync_balance_fix.js` ✓
- `node tests/test_cow_commit_guards.js` ✓
- `node tests/test_manager.js` ✓
- `node tests/test_cow_divergence_correction.js` ✓

### Core Lines Changed
**Total: 230** (133 added, 97 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.20] - 2026-02-18 - Atomic Boundary Shifts in COW Pipeline

This patch ensures boundary index shifts during divergence correction are atomic with slot-type reassignment, preventing temporary mismatches between `boundaryIdx` and slot roles during the COW planning-to-commit lifecycle.

### Fixed
- **Atomic Boundary Shifts in COW Divergence Updates** (`modules/order/utils/system.js`) - commit 86ab205
  - **Problem**: Boundary movement during divergence correction was threaded through manager state (`manager.boundaryIdx`) before the COW commit completed, risking temporary mismatch between boundary index and slot typing.
  - **Impact**: If blockchain execution failed after boundary was mutated, slot types would be inconsistent with the boundary index, potentially corrupting grid role assignments.
  - **Solution**: Introduced `pendingBoundaryIdx` to carry boundary changes through the COW pipeline. `updateGridFromBlockchainSnapshot` now accepts `overrideBoundaryIdx` and reassigns slot roles in the working grid before commit. `manager.boundaryIdx` is only updated atomically inside `_commitWorkingGrid`.

- **Boundary Clamping to Existing Orders** (`modules/order/utils/system.js`) - commit eabbaf6
  - **Problem**: Fund-driven boundary shifts could cross existing on-chain or virtual orders, causing slot-type inversions.
  - **Impact**: Boundary could jump over committed orders, leading to incorrect BUY/SELL role assignments.
  - **Solution**: `syncBoundaryToFunds` now clamps the new boundary index to the gap between the highest BUY slot and lowest SELL slot. Counts both virtual and active orders in clamp calculation. Returns `{ changed, newIdx }` instead of mutating manager state directly.

- **Working Grid Slot Role Reassignment** (`modules/order/grid.js`) - commit 86ab205
  - Extended `updateGridFromBlockchainSnapshot` with `overrideBoundaryIdx` parameter.
  - Reassigns slot roles in working grid when boundary changes, ensuring atomic commit of both types and boundary.

### Technical Details
- Boundary shifts now flow: `syncBoundaryToFunds()` → `pendingBoundaryIdx` → `updateGridFromBlockchainSnapshot(overrideBoundaryIdx)` → `_commitWorkingGrid()` → `manager.boundaryIdx`
- No manager state mutation before blockchain confirmation
- Clamp bounds derived from typed slots (BUY/SELL), not just on-chain orders

### Testing
- `node tests/test_unanchored_spread_correction.js` - Boundary regression tests
- `node tests/test_cow_commit_guards.js` - COW commit guards
- `node tests/test_boundary_sync_logic.js` - Boundary sync logic
- `node tests/test_cow_divergence_correction.js` - Divergence correction COW tests

### Core Lines Changed
**Total: 9,731** (6,730 added, 3,001 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.19] - 2026-02-14 to 2026-02-17 - Copy-on-Write (COW) Grid Architecture

This patch introduces a major architectural refactoring replacing the snapshot/rollback pattern with a cleaner Copy-on-Write approach. The master grid remains immutable until blockchain confirmation succeeds, eliminating state corruption risks and simplifying failure recovery.

### Added
- **Copy-on-Write (COW) Grid Architecture** (commit 2fc849b)
  - **WorkingGrid Class** (`modules/order/working_grid.js`): Clone of master grid for planning phase modifications without touching production state.
  - **Grid Index Utilities** (`modules/order/utils/grid_indexes.js`): Efficient index building for grid operations.
  - **Order Comparison Utilities** (`modules/order/utils/order_comparison.js`): Epsilon-based order comparison for robust equality checks.
  - **COW Performance Thresholds** (`modules/constants.js`): Performance monitoring for grid cloning operations.

### Changed
- **OrderManager** (`modules/order/manager.js`):
  - Replaced snapshot/rollback with COW pattern: `_applySafeRebalanceCOW()`, `_commitWorkingGrid()`
  - Added rebalance state tracking: `NORMAL → REBALANCING → BROADCASTING → CONFIRMED → NORMAL`
  - Implemented selective fill handling: individual fills processed immediately, full-side updates blocked during fills
  - Added working grid synchronization during fill processing to prevent stale data commits

- **DEXBot Core** (`modules/dexbot_class.js`):
  - Integrated COW broadcast path: `_updateOrdersOnChainBatchCOW()`
  - Atomic swap on success, discard on failure (master never partially modified)
  - Removed legacy rollback code (~55 lines)

- **Async-Safe Fund Accounting**:
  - Implemented semaphore-protected fund updates using `AsyncLock`
  - Converted fund tracking methods to async: `recalculateFunds()`, `setAccountTotals()`
  - Added `_fundsSemaphore` for atomic fund updates and snapshotting

- **Atomic Service Pattern**:
  - Unified locking architecture with `_gridLock` and `_fundLock`
  - Separated public (locked) and private (logic-only) method pairs
  - Consolidated multiple specialized locks into unified concurrency model

### Removed
- Snapshot/rollback pattern and associated rollback code
- Optimistic master grid modifications
- Pre-COW volatility freeze mechanism (superseded by atomic COW semantics)

### Technical Improvements
- **Simpler State Management**: No complex rollback code, clear before/after states
- **Atomic Commits**: All-or-nothing via swap, master never in limbo state
- **Better Consistency**: Master only changes after blockchain confirmation
- **Easier Debugging**: Clear separation between planning and committed state
- **Performance**: Sub-millisecond grid cloning (100 orders: ~0.03ms, 1000 orders: ~0.08ms, 5000 orders: ~0.5ms)

### Documentation
- Created comprehensive COW architecture documentation (`docs/COPY_ON_WRITE_MASTER_PLAN.md`)
- Consolidated 3 separate docs into single unified reference

### Testing
- Added `tests/test_cow_master_plan.js` - 10 COW-specific test cases
- Added `tests/test_working_grid.js` - WorkingGrid unit tests
- Added `tests/benchmark_cow.js` - Performance benchmarks
- All existing tests pass with new architecture

### Safety Guardrails
- Accountant dry-run validation before broadcasting
- Atomic COW semantics inherently handle volatility (no partial state commits)
- Automatic resync on blockchain failure via `startup_reconcile.js`
- Divergence checks and cache updates blocked during rebalance operations

### Fixes and Refinements (Post-Implementation)

**Critical Bug Fixes:**
- **Explicit Zero-Value Handling in COW Helpers** (`modules/order/utils/helpers.js`) - commit pending
  - Replaced `||` fallbacks with nullish coalescing (`??`) in fund and size derivation paths
  - Prevents explicit `0` values from being overwritten by fallback fields
  - Fixes optimistic UPDATE rendering and required-fund calculations when target size is zero

- **Post-Commit State Cleanup** (`modules/order/manager.js`) - commit 55ab7d1
  - Fixed bug where `recalculateFunds()` exception left system stuck in `BROADCASTING` state
  - Added try-finally block to ensure `_clearWorkingGridRef()` always executes

- **Fee Event Deduplication Memory Hardening** (`modules/order/strategy.js`) - commit 55ab7d1
  - Added LRU eviction for `_settledFeeEvents` Map (limit: 10,000 entries)
  - Prevents unbounded memory growth (~60MB worst case during high-fill periods)
  - Added sampling optimization (every 10th call) reducing CPU overhead ~90%

- **COW Deadlocks and Lock Routing** - commit 710e1d3
  - Fixed deadlock in `correctOrderPriceOnChain` (nested `_gridLock` acquire)
  - Fixed commit outside lock boundary with stale index usage
  - Added proper lock routing for all chain operations

- **Sync/Accounting Concurrency Hardening** - commit 584cb23
  - Ensured sync reconciliation executes under `_gridLock`
  - Added grid version tracking to detect stale working grids
  - Fixed PARTIAL/ACTIVE premature restoration with restore-ratio-based state resolution
  - Implemented atomic cache-funds setter and recovery cooldown/max-attempt policy

- **Bug Fixes from Post-Review** - commit ef03f39
  - Fixed `rawOnChain` cleared to undefined in sync_engine.js:551
  - Fixed `syncFromMaster` version mismatch in working_grid.js
  - Removed 208 lines of dead duplicate methods in accounting.js
- Fixed float precision in `_buildFeeEventId` using blockchain-integer dedupe keys
  - Fixed recovery `attemptCount` never decaying after max retries

**Refactoring:**
- **Gap-Slot Math Centralization** (`modules/order/utils/math.js`) - commit f19ff01
  - Consolidated spread-gap calculation into shared utility
  - Removed unused `grid_indexes.js` implementation
  - Hardened fallback behavior with config-default anchoring

- **COW Implementation Corrections** - commit 804ff55
  - Added missing `Object.freeze()` on grid commit
  - Added delta re-validation before commit
  - Removed duplicate `recalculateFunds()` and dead `_applySafeRebalance` wrapper

**Documentation and Testing:**
- **JSDoc Improvements** - commit 9d12283
  - Enhanced documentation for `processFilledOrders()`, `performSafeRebalance()`, `_buildStateUpdates()`
  - Documented COW pattern and decoupled architecture in strategy.js

- **Test Suite Fixes** - commit 9d12283
  - Fixed test hanging issue from BitConnections keeping event loop alive
  - Added `process.exit(0)` to 20 test files for clean exits

**Magic Number Elimination** (`modules/constants.js`) - commit 55ab7d1
- Added `TIMING.LOCK_REFRESH_MIN_MS: 250`
- Added `GRID_LIMITS.SATOSHI_CONVERSION_FACTOR: 1e8` (later removed; fee dedupe now uses per-asset precision via `floatToBlockchainInt`)
- Added `GRID_LIMITS.STATE_CHANGE_HISTORY_MAX: 100`
- Added `COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER: 500`
- Added `PIPELINE_TIMING.CACHE_EVICTION_RETENTION_RATIO: 0.75`
- Added `PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS: 180000`
- Added `PIPELINE_TIMING.MAX_FEE_EVENT_CACHE_SIZE: 10000`
- Added `PIPELINE_TIMING.FEE_EVENT_DEDUP_TTL_MS: 21600000`

**COW State/Action Semantics Centralization** - commit 4312230
- Added `REBALANCE_STATES` and `COW_ACTIONS` constants for shared contract
- Extracted `isRebalancing`/`isBroadcasting`/`isPlanningActive` helpers
- Centralized `_syncWorkingGridFromMasterMutation`, `_buildAbortedCOWResult`, and `_summarizeCowActions`
- Unified commit gate evaluation in `_evaluateWorkingGridCommit`
- Updated docs with COW state-machine cheat sheet

**Fill Rebalance Sizing and COW Consistency** - commit c620098
- Fixed target sizing distribution across full side topology (was concentrated in active window only)
- Fixed create args reusing stale `rawOnChain.for_sale` metadata
- Added precision-aware fund validation in blockchain integer space
- Normalized batch result envelope parsing
- Reordered maintenance: spread correction now runs after health/divergence

**OrderManager Refactoring** - commit b01f40f
- Extracted pure functions to `helpers.js` (~834 lines): `validateOrder()`, `reconcileGrid()`, `projectTargetToWorkingGrid()`, etc.
- Introduced `StateManager` class encapsulating rebalance/recovery/bootstrap flags
- Reduced `manager.js` from ~2,850 to ~1,200 lines

**Helpers Reorganization** - commit 18611c7
- Consolidated 7 scattered sections into 4 cohesive groups: DEPENDENCIES, VALIDATION, RECONCILIATION, MUTATIONS
- No logic changes - only section headers, TOC, and export groupings

**Critical Fill Handling Restoration** - commit f56e0c3
- Restored `processFilledOrders` two-step logic: accounting via strategy, then `performSafeRebalance()` for non-partial fills
- Restored `finishBootstrap` fund drift validation
- Restored `isPipelineEmpty` shadow locks and external broadcasting signal handling

**Deep Market Scan Revert** - commit 25a317c
- Reverted deep market scan feature to restore simpler `get_full_accounts` based order fetching
- Removed `_readMarketOrders()`, `_readOpenOrdersPaginated()`, and `marketAssets` parameters

**COW Accounting Invariant Fix** - commit fce0f0b
- Fixed fund invariant violation where new orders were set to ACTIVE immediately
- New orders now remain VIRTUAL until blockchain confirms placement
- Rotation orders get orderId cleared and state set to VIRTUAL
- Added 4 regression tests: COW-012 through COW-015

**COW Fill Rebalance Alignment** - commit 9022942
- Restricted in-place size updates to PARTIAL orders only
- Added action optimization pairing same-side CANCEL+CREATE into rotation-style UPDATE
- Added explicit `updateOrdersOnChainPlan()` + plan-to-COW projection helpers
- Manager now calls `processFillsOnly()` directly, removing legacy pass-through methods

**COW Rotation Accounting Stabilization** - commit 766fe37
- Reconcile now treats fill-driven updates as rotation-oriented (emit UPDATE only as rotations)
- Fixed `_processBatchResults` using wrong `getAssetFees` mode (proceeds vs schedule)
- Fixed rotation source slots remaining ACTIVE after successful rotation

**Post-Fill Maintenance and Divergence Alignment** - commit a4c4880
- Gated post-fill checks behind `shouldRunPostFillChecks` (requires full fill + rotation)
- Added explicit broadcasting state lifecycle calls around COW batch broadcast
- Cleaned up divergence trigger model (removed cooldown/re-arm state dependencies)

**Divergence COW Migration** - commit d322445
- Migrated divergence handling to full COW planning/execution with working-grid-first semantics
- Extended `_recalculateGridOrderSizesFromBlockchain` to support COW action collection
- Made `updateGridFromBlockchainSnapshot` return COW result instead of mutating master
- Added shared helpers `hasActionForOrder` and `removeActionsForOrder`

**Numeric Validation Unification and Legacy Pruning** - commit 3ea3be7
- Removed unused legacy functions: `applyOrderUpdate`, `applyOrderUpdatesBatch`, `buildIndices`, `swapMasterGrid`
- Unified `isNumeric` in `format.js`, removed duplicate from `math.js`
- Standardized utility usage across 8 modules (eliminated fragile `Number()` casts)
- Added TABLE OF CONTENTS to `math.js`, `order.js`, and `system.js`
- Consolidated duplicated `modifyCacheFunds` logic in `accounting.js`

**Documentation Updates** - commit b834192
- Relaxed git action gate policy from strict inference to user-directed writes
- Simplified interpretation rules while maintaining safety guardrails

**Code Review and Bug Fixes** - 2026-02-17
- **Fixed `getOrdersByTypeAndState(null, state)` Breaking Change** (`modules/order/manager.js`)
  - Restored support for `null` type parameter to return all orders with matching state
  - This fixes `logger.js` status display which passes `null` to get all ACTIVE/PARTIAL/VIRTUAL orders
  - Added JSDoc documenting the `null` type behavior

- **Documented Intentional Lock Timeout Race Behavior** (`modules/order/sync_engine.js`)
  - Added detailed comment explaining why `Promise.race` timeout behavior is intentional
  - Completing a sync fully then throwing is safer than aborting mid-sync (partial state corruption)
  - The timeout error triggers recovery which re-syncs anyway

- **Recovery Decay Logging Visibility** (`modules/order/accounting.js`)
  - Changed recovery attempt decay log from `debug` to `info` level
  - Operators can now monitor for repeated decay patterns indicating persistent issues
  - Added comment explaining monitoring rationale

- **Tech Debt Documentation** (`modules/order/manager.js`)
  - Added TODO comment documenting duplicate state management pattern
  - Currently `_state` (StateManager) and direct properties (`_isBroadcasting`, `isBootstrapping`) must be kept in sync
  - Documented refactor plan to consolidate to StateManager only

**Utils Consolidation and COW Hardening** - 2026-02-17
- **Utils Folder Consolidation** (commit 4bc88bc)
  - Merged `grid_indexes.js` into `order.js` (buildIndexes, validateIndexes)
  - Merged `order_comparison.js` into `order.js` (ordersEqual, buildDelta, getOrderSize)
  - Merged `strategy_logic.js` into `order.js` (deriveTargetBoundary, getSideBudget, calculateBudgetedSizes)
  - Renamed `helpers.js` → `validate.js` for more specific naming
  - Reduced utils folder from 7 files to 4 consolidated files
  - Updated all imports across modules and tests

- **COW Architecture Hardening** (commit 1fed7f2, 2a95540, ada36b7)
  - Eliminated all in-place mutations in COW pipeline
  - Implemented hybrid Copy-on-Write pattern with static mutation detection
  - Preserved explicit zero values in COW helpers using nullish coalescing (`??`)
  - Hardened test exits with `process.exit(0)` for clean termination

- **Documentation Improvements** (commit 17e7a18)
  - Enhanced `working_grid.js` header with 70+ line comprehensive documentation
  - Added COW pattern documentation to `manager.js`
  - Enhanced inline documentation in `math.js` for RMS divergence calculation
  - Removed ASCII workflow diagrams for reduced verbosity
  - Updated `docs/README.md` to remove "Patch" references
  - Updated `tests/README.md` to reflect native assert (no Jest)
  - Updated `scripts/README.md` test count (100+ test cases)

- **README.md Consolidation** (2026-02-17)
  - Removed redundant sections: OS-specific install details moved to short paragraph, technical details moved to docs/
  - Removed "Patch 17" markers from features (now standard functionality)
  - Removed obsolete `docs/PATCH17_18_DOCUMENTATION_UPDATES.md` planning document
  - Removed "Patch 8/12/17/18" references from architecture.md and other docs
  - Streamlined from 549 to ~260 lines while keeping all user-essential info

### Core Lines Changed
**Total: 4,059** (1,389 added, 2,670 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.18] - 2026-02-08 - Batching Hardening, Accounting Precision & Telemetry Optimization

This patch refines the adaptive fill batching introduced in patch 17, addressing regression gaps in cache accounting and deduplicating error recovery paths for better operational stability.

### Fixed
- **Cache Remainder Accuracy During Capped Resize** in `modules/order/grid.js` (commit 426455c)
  - **Problem**: Cache remainder was computed from ideal sizes even when the grid resize was capped by available funds.
  - **Impact**: Could lead to understated cache funds and skewed sizing decisions in subsequent cycles.
  - **Solution**: Track per-slot applied sizes and derive cache remainder from the actual allocated values.

- **Hard-Abort Cooldown Consistency** in `modules/dexbot_class.js` (commit 426455c)
  - **Problem**: Batch abort paths (Illegal State/Accounting) could skip arming maintenance cooldowns.
  - **Impact**: Maintenance could run prematurely immediately after a hard-abort recovery sync.
  - **Solution**: Explicitly arm `_maintenanceCooldownCycles` in both primary and retry hard-abort handlers.

- **Stale-Cancel Fast-Path for Single-Op Batches** in `modules/dexbot_class.js` (commit 426455c)
  - **Problem**: Stale-order retry handling only executed for batches with more than one operation.
  - **Impact**: Single-order cancel races unnecessarily triggered full state recovery syncs.
  - **Solution**: Applied stale-order cleanup logic to all batch sizes, enabling fast-path recovery for single-op cancel races.

- **Fill Reaction Cap Precision** in `modules/order/strategy.js` (commit 33eaecb)
  - **Problem**: Malformed or unknown fill types were incorrectly incrementing the boundary shift counter before validation.
  - **Impact**: Inflated reaction caps and unpredictable boundary crawl behavior.
  - **Solution**: Moved counter increments after type validation.

### Refactored
- **Edge-First Surplus Sorting** in `modules/order/strategy.js`
  - **Change**: Prioritize furthest-from-market surpluses (lowest Buy / highest Sell) for rotations.
  - **Reason**: Improves execution robustness by using stable edge orders for rotations and leaving volatile inner surpluses to potentially catch "surplus fills" during grid shifts.

- **Victim Cancel Safety Logic** in `modules/order/strategy.js`
  - **Change**: Explicitly detect and cancel "victim" dust orders when a rotation targets an occupied slot.
  - **Reason**: Maintains 1-to-1 mapping between grid slots and blockchain orders in the Edge-First system, preventing "ghost" capital on-chain.

- **Deduplicated Batch Hard-Abort Handling** in `modules/dexbot_class.js` (commit 7b1bb38)
  - Consolidated `ILLEGAL_ORDER_STATE` and `ACCOUNTING_COMMITMENT_FAILED` handling into a shared `_handleBatchHardAbort` helper.
  - Ensures identical recovery behavior across both primary and retry batch execution paths.

- **Strategy Scan Optimization** in `modules/order/strategy.js` (commit 33eaecb, refined in 016c316)
  - Implemented an advancing scan pointer (`_priorityScanStart`) in `pickPriorityFreeSlot`.
  - Pointer now advances past the selected slot, eliminating redundant linear scans across large grids within a single rebalance cycle.

- **Cooldown Logic Consolidation** in `modules/dexbot_class.js` (commit 33eaecb)
  - Merged separate cooldown blocks for partial and burst fills into a unified `[FILL-GATE]` mechanism.

### Added
- **Batch Size Telemetry** in `modules/dexbot_class.js` (commit 016c316)
  - Hard-abort recovery logs now include the number of operations in the failed batch (e.g., "illegal state during batch processing with 12 ops").
  - Improves diagnostic visibility into whether failures occur during large maintenance bursts or small retries.

- **New Regression Tests** in `tests/test_patch17_invariants.js`:
  - Added cache remainder parity check for capped grid resizes.
  - Added abort-cooldown arming verification.
  - Added single-stale-cancel fast-path verification.

### Testing
- All core test suites pass: `tests/test_strategy_logic.js`, `tests/test_patch17_invariants.js`, `tests/test_critical_bug_fixes.js`.
- Verified batching simulation across queue depths (1..20) to ensure adaptive tiers and anti-singleton tail logic.

### Core Lines Changed
**Total: 666** (471 added, 195 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.17] - 2026-02-07 - Adaptive Fill Batching, Periodic Recovery Retries & Orphan-Fill Double-Credit Prevention

Post-mortem analysis of the Feb 7 market crash (8% spike + reversal) revealed three structural weaknesses in the fill processing pipeline that cascaded into a 4.5-hour trading halt. This patch addresses all three root causes.

### Fixed
- **Adaptive Batch Fill Processing** in `modules/dexbot_class.js`, `modules/constants.js` (commits 21af7d2)
  - **Problem**: Fills processed one-at-a-time (~3s per broadcast). 29 fills = ~90s during which market outran bot, causing stale orders and orphan fills.
  - **Solution**: Group fills into stress-scaled batches (1/2/3/4 per broadcast based on queue depth). `processFilledOrders()` already supports multi-fill input; the bottleneck was the sequential 1-at-a-time loop.
  - **Config**: `FILL_PROCESSING.MAX_FILL_BATCH_SIZE` (default 4), `BATCH_STRESS_TIERS` (configurable stress tiers). Batch size 1 = legacy sequential behavior.
  - **Impact**: 29 fills processed in ~8 broadcasts (~24s) instead of 29 (~90s). Reduces market divergence window during fill bursts.

- **Periodic Recovery Retries** in `modules/order/accounting.js`, `modules/order/strategy.js` (commit 21af7d2)
  - **Problem**: One-shot `_recoveryAttempted` flag meant a single failed recovery bricked the bot permanently until the next `processFilledOrders()` call (which never comes if the bot can't trade). In crash: "Recovery already attempted" logged thousands of times over 4.5 hours.
  - **Solution**: Replace boolean guard with count+time-based retry system. Up to 5 attempts per episode with 60s minimum interval. `resetRecoveryState()` called by each fill cycle and periodic blockchain fetch. Follow-up hardening ensures explicit zero semantics are respected (`MAX_RECOVERY_ATTEMPTS=0` means unlimited) and adds compatibility fallback when `accountant.resetRecoveryState()` is unavailable.
  - **Config**: `PIPELINE_TIMING.RECOVERY_RETRY_INTERVAL_MS` (default 60000ms), `MAX_RECOVERY_ATTEMPTS` (default 5). Both overridable via `general.settings.json`.
  - **Impact**: After market settles, recovery auto-retries periodically instead of giving up after one failure. Bot self-heals within minutes instead of requiring manual restart.

- **Orphan-Fill Double-Credit Prevention** in `modules/dexbot_class.js` (commit 21af7d2)
  - **Problem**: When batch failed due to stale order (filled on-chain between sync and broadcast), cleanup freed slot (releasing funds to `chainFree`). Then orphan-fill handler ALSO credited proceeds — double-counting. In crash: 7 orphan fills at ~700 BTS each inflated trackedTotal by ~4,600 BTS, cascading into 47,842 BTS drift.
  - **Solution**: Track stale-cleaned order IDs in `_staleCleanedOrderIds`. Initial set-based guard was hardened to timestamp retention (Map + TTL pruning) so delayed/repeated orphan fill events are still blocked. Orphan-fill handler skips credit with explicit `[ORPHAN-FILL] Skipping double-credit` log.
  - **Impact**: Eliminates double-counting root cause that fed the fund invariant violations and recovery cascade.

- **Precision-Aware Logging Normalization** in `modules/order/format.js`, `modules/order/accounting.js`, `modules/order/strategy.js`, `modules/order/startup_reconcile.js`, `modules/order/logger.js`, `modules/dexbot_class.js` (commit pending)
  - **Problem**: Several debug/info logs emitted raw floating-point values (e.g. `52.82927000000115`) instead of chain-precision values, creating noise and false drift perception.
  - **Solution**: Added reusable precision helpers (`formatAmountByPrecision`, `formatSizeByOrderType`) and routed size logs through side-aware asset precision formatting.
  - **Impact**: Logs now consistently reflect blockchain precision across fill, accounting, startup reconcile, diagnostics, and placement-validation paths.

### Added
- **New Configuration Constants** in `modules/constants.js`:
  - `FILL_PROCESSING.MAX_FILL_BATCH_SIZE`: Maximum fills per rebalance batch (default 4).
  - `FILL_PROCESSING.BATCH_STRESS_TIERS`: Array of [minQueueDepth, batchSize] tuples for adaptive sizing.
  - `PIPELINE_TIMING.RECOVERY_RETRY_INTERVAL_MS`: Minimum time between recovery attempts (default 60000ms).
  - `PIPELINE_TIMING.MAX_RECOVERY_ATTEMPTS`: Max retries per recovery episode (default 5, 0 = unlimited).
- **New Accountant Method** in `modules/order/accounting.js`:
  - `resetRecoveryState()`: Resets retry counter and time for new fill cycle. Called by `processFilledOrders()` and periodic blockchain fetch.

### Testing
- All existing test suites pass: accounting, strategy, manager, grid, ghost order, BTS fee, engine integration, layer2 self-healing, critical bug fixes.
- Constants load and freeze correctly with new `PIPELINE_TIMING` export.
- `resetRecoveryState()` verified: resets count (0), time (0), and legacy flag (false).
- Backward compatible: batch size 1 = legacy one-at-a-time behavior.
- Follow-up verification: `node tests/test_periodic_sync_fill_rebalance.js`, `node tests/test_layer2_self_healing.js`.
- Precision-format verification: `node tests/test_strategy_logic.js`, `node tests/test_accounting_logic.js`, `node tests/test_startup_reconcile_regressions.js`.

### Core Lines Changed
**Total: 9,812** (7,072 added, 2,740 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.16] - 2026-02-07 - Runtime Safety, Sync Execution Completeness, Grid/Accounting Hardening & Ops Dashboard Scaffold

### Added
- **Operations Dashboard (Experimental Rust TUI Sidecar)** in `dashboard/` (commit 0d6af8f)
  - Added a ratatui/crossterm terminal dashboard loop with tabbed UI, periodic refresh ticks, centralized key handling, and stateful list navigation.
  - Added runtime snapshot ingestion that merges `profiles/bots.json`, `pm2 jlist` status, and per-bot log tails with basic alert signal detection.
  - Added guarded script action model (`safe` / `confirm` / `danger`) with confirmation modal flow and typed-token protection for dangerous actions.
  - Added dashboard docs/spec (`dashboard/README.md`, `docs/tui_dashboard_spec.md`) and repo hygiene updates (`dashboard/target` + generated aliases in `.gitignore`).
  - Scope guard: dashboard excludes branch-sync scripts (`ptest`, `pdev`, `pmain`) and operates as a sidecar, not a direct trading-logic mutator.

- **Clear-All Cleanup Script** (commit 3742d1c)
  - Added a new script command for broad local/runtime cleanup in one operation, reducing manual operational cleanup steps.

### Fixed
- **Sync-Detected Fills Now Execute Full Rebalance Pipeline** in `modules/dexbot_class.js` (commit 65f8970)
  - **Problem**: Two runtime sync paths detected fills but stopped at strategy computation.
  - **Fix**: Both main-loop and periodic sync paths now run the full chain: `synchronizeWithChain(...)` -> `processFilledOrders(...)` -> `updateOrdersOnChainBatch(...)` -> `persistGrid()`.
  - **Impact**: Full fills found during sync are now replaced/persisted immediately instead of waiting for unrelated future events.

- **Open-Order Watchdog Churn Reduction + Explicit Opt-In Polling** in `modules/order/sync_engine.js`, `modules/dexbot_class.js`, `modules/constants.js`, `dexbot.js` (commit a2d6fc4)
  - **Problem**: No-op pass-1 updates still called `_updateOrder(...)`, producing repeated logs/work and lock contention.
  - **Fix**: Added quantized size/state + raw-chain equivalence checks to suppress material no-op updates.
  - **Behavior Change**: Renamed runtime semantics to explicit open-orders watchdog loop and made polling opt-in by default (`OPEN_ORDERS_SYNC_LOOP_ENABLED=false`), with `OPEN_ORDERS_SYNC_LOOP_MS` as the interval override.

- **Lifecycle Shutdown and Account-Context Recovery Hardening** in `modules/dexbot_class.js`, `modules/order/accounting.js`, `modules/order/startup_reconcile.js` (commit 47ca2d8)
  - **Problem**: Duplicate/uncancelled loops and missing cleanup handles could leave watchers/listeners active post-shutdown; startup/trigger paths could proceed with unresolved account context.
  - **Fix**: Introduced managed runtime handles and dedicated start/stop loop controls, added explicit fs watcher/fill listener cleanup, added shutdown guards, enforced account-id resolution, and made trigger-reset short-circuit contingent on actual success.
  - **Impact**: Prevents background activity leakage and late read failures; startup/recovery now fail fast and deterministically when account context is unavailable.

- **Open-Order Reconciliation Safety Guards** in `modules/order/sync_engine.js` (commit 7ff07d7)
  - **Type mismatch safety**: Type-mismatched chain orders are queued for cancellation and skipped from reconciliation in the same pass (prevents slot mutation to false PARTIAL states).
  - **Pair validation safety**: Reconciliation now accepts only true market-pair orders (`assetA->assetB` or `assetB->assetA`) and rejects unrelated account orders.
  - **Correction queue consistency**: Regular price mismatches now update both returned corrections and `manager.ordersNeedingPriceCorrection` with dedupe/update semantics.

- **Accounting Resiliency Against Fee-Cache and Optimistic Drift Failures** in `modules/order/accounting.js` + `modules/order/sync_engine.js` (commit b6649e6)
  - Added fail-safe fallback in `_deductFeesFromProceeds()` when fee cache lookup fails (logs and uses raw proceeds).
  - Added explicit critical-path handling when `tryDeductFromChainFree()` fails, with immediate recovery scheduling.
  - Coalesced overlapping invariant checks into one in-flight run + latest pending snapshot to reduce noise and overlap.
  - Normalized BTS fee side selection and aligned missing `fillOp.is_maker` default to maker in sync for accounting parity.

- **Grid Generation and Spread-Correction Safety Hardening** in `modules/order/grid.js` (commits bafed2b, 59e1d8f)
  - Enforced `minPrice > 0` guard to prevent non-terminating downward progression.
  - Added fail-fast guards for empty level generation and imbalanced BUY/SELL rails.
  - Removed pre-broadcast local mutation from spread correction preparation to avoid local/chain drift when batch execution fails or does not execute.
  - Spread-correction outcomes now apply only when chain batch reports `executed=true`.
  - Increment validation now enforces configured `INCREMENT_BOUNDS` (0.01..10), replacing legacy 0..100 logic.

- **Dust Sizing Orientation Consistency (BUY Side)** in `modules/order/grid.js` (commit bafed2b)
  - **Problem**: BUY dust checks sorted slots opposite geometric sizing assumptions.
  - **Fix**: Normalized BUY slot sorting orientation to preserve correct ideal-size mapping under reverse allocation.
  - **Impact**: Eliminates threshold-adjacent BUY dust misclassification.

- **Strategy Safety: Fill-Type Validation + Self-Rotation Churn Prevention** in `modules/order/strategy.js` (commit 7b24491)
  - Invalid/missing fill types no longer consume SELL reaction budget implicitly; unknown types are warned and skipped.
  - Self-rotation candidates (`oldOrder.id === newGridId`) are converted to in-place updates and excluded from later cancellation flow.
  - Prevents unnecessary cancel/update churn and avoidable fee pressure.

- **OrderManager Waiter/State Guard Corrections** in `modules/order/manager.js` (commit 715ebd7)
  - `waitForAccountTotals` now creates/reuses waiter under lock but awaits outside lock to avoid serialized timeout behavior.
  - Readiness checks aligned to `buyFree/sellFree` semantics.
  - Explicit zero allocation caps are honored (`0` no longer treated as "no cap").
  - Added strict enum validation for order type/state updates, with backward-compat normalization for zero-size virtual placeholders.

- **Startup Reconcile Fund-Release and Race Recovery Hardening** in `modules/order/startup_reconcile.js` (commit e413e35)
  - Unmatched chain cancels now route through release-aware path to return optimistic free balances.
  - Stale-slot updates are skipped when slot already mapped to same orderId (prevents double-credit).
  - Resume persistence now awaits async `storeGrid` completion; chain-order ID extraction hardened against null entries.

### Refactored
- **Deduplicated Startup/Auth/Settings/Resolution Paths** across core modules (commit d479015)
  - Consolidated mirrored SELL/BUY startup reconciliation flows into shared side-parameterized helpers.
  - Unified general settings load/write behavior into shared utility consumed across modules.
  - Reused common account resolution/authentication paths to reduce divergence in sensitive startup/auth code.
  - Removed duplicate conversion helpers and hoisted shared int64 constants.

- **Grid Helper Consolidation + Dead Path Removal** in order modules (commit 4736777)
  - Centralized spread gap and dust helpers (`calculateGapSlots`, `hasAnyDust`, `getSizingContext`) and routed strategy/manager callers through shared implementations.
  - Removed stale manager state/methods/imports and aligned signatures to live call patterns.

- **Removed Dead `cacheFunds` Trigger Wiring in Grid Regen Checks** (commit 609ca12)
  - Removed unused `cacheFunds` parameter from `checkAndUpdateGridIfNeeded` and `compareGrids`, updated call sites/tests.
  - Clarifies that trigger behavior is driven by available funds (`buyFree/sellFree`), not unused cache fallback plumbing.

- **Legacy Utility Surface Pruning** in split utils modules (commit c820cbf)
  - Removed unreferenced helper exports from `modules/order/utils/{system,math,order}.js`.
  - Updated module documentation references to match current split utility architecture.

- **Post-Hardening Cleanup: Shared Account-Ref Utility Extraction** (commit 2d5f2fe)
  - Extracted common account reference fallback logic and improved code readability around lifecycle/account-resolution paths.

### Changed
- **Documentation and Repository Guidance Consolidation** (commits dabe591, 47ca2d8, e413e35)
  - Renamed OPENCODE guidance to `AGENTS.md` and standardized agent-doc references.
  - Added commit quality guidance for substantial changes (high-context body with problem/impact/solution + testing notes).
  - Added newline-safe commit/PR formatting guidance (heredoc-first patterns for CLI reliability).

### Quality Assurance
- Regression and behavior-lock tests added/updated across sync, startup reconcile, manager/account totals, grid logic, strategy reaction-cap/self-rotation, and full sync-fill rebalance execution paths.
- Dashboard build validation: `cargo check --manifest-path dashboard/Cargo.toml`.
- JavaScript runtime checks and focused Node test runs were executed per change set and documented in commit testing notes.


## [0.6.0-patch.15] - 2026-02-06 - Stale Order Recovery Hardening, Liquidity Pool Pagination & Type-Mismatch Correction Pipeline

### Fixed
- **Grid Reset Race Condition - Bootstrap Flag Guard** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: During grid reset, the `isBootstrapping` flag was checked before acquiring the fill processing lock. The flag could become false while waiting for lock acquisition, causing stale bootstrap code to execute for fills arriving during grid resync.
  - **Impact**: Fills received during grid recovery were processed with bootstrap logic even after bootstrap completed, preventing proper boundary slot reassignment and leaving the grid in an inconsistent state.
  - **Fix**: Moved `isBootstrapping` flag check inside the fill processing lock callback (line 691). If bootstrap finished while waiting, the code now skips the bootstrap handler and allows normal POST-RESET fill processing.
  - **Result**: Grid boundary slots are now properly reassigned after fill events during recovery

- **Fill Accounting in POST-RESET Path** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: The POST-RESET fill handler processed known grid fills but skipped the `processFillAccounting()` call, which only ran for unknown orders. This broke `cacheFunds` tracking.
  - **Impact**: Cache funds from grid fills during recovery were never credited, causing subsequent dust resize operations to fail due to insufficient cache funds.
  - **Fix**: Added `accountant.processFillAccounting()` call before the `processFilledOrders` rebalance pipeline (line 404).
  - **Result**: Fill proceeds are now correctly credited to cache funds during grid recovery

- **Doubled Flags Reset During Grid Regeneration** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: The `buySideIsDoubled` and `sellSideIsDoubled` flags persisted from the old grid through the regeneration process, reducing the effective target order count.
  - **Impact**: Grid stayed at reduced capacity (5 orders instead of 6) even after successful recovery.
  - **Fix**: Added doubled flag resets to the grid regeneration cleanup block (line 530).
  - **Result**: Grid reaches full target capacity after regeneration

- **FillType Logging Case Mismatch** in dexbot_class.js (commit 857c8f3)
  - **Root Cause**: FillType comparison used hardcoded uppercase `'BUY'` but `ORDER_TYPES.BUY` equals lowercase `'buy'`, causing the comparison to always fail (line 1050).
  - **Impact**: Fill logs always showed 'SELL' regardless of actual order type.
  - **Fix**: Changed comparison from `'BUY'` to `ORDER_TYPES.BUY` enum constant for case-sensitive match.
  - **Result**: Fill logs now correctly reflect the actual order type (buy vs sell)

- **Grid Divergence Threshold Denominator** in modules/order/grid.js (commit 857c8f3)
  - **Root Cause**: The threshold check used `(grid + pending)` as denominator for the divergence ratio, which could be much smaller than total allocated funds (line 741).
  - **Impact**: False-positive triggers when grid size < allocated funds, causing unnecessary sell order updates/rebalancing post-fill.
  - **Fix**: Changed denominator to use `allocated` funds with `chainTotal` fallback (free + locked balance).
  - **Result**: Divergence threshold now uses appropriate baseline, reducing false positives

- **Spread Correction Sizing Index Swap** in modules/order/grid.js (commit 857c8f3)
  - **Root Cause**: Geometric sizing produces arrays where weight distribution depends on the `reverse` parameter. For SELL orders (reverse=false), largest allocation is at index [0]. For BUY orders (reverse=true), largest is at index [N-1]. Code was returning smallest for both sides (line 1205).
  - **Impact**: Spread correction orders placed with dust-level sizes (~0.14) instead of ideal sizes (~0.30).
  - **Fix**: Swapped return indices: sell uses `sized[0]` (largest), buy uses `sized[N-1]` (largest for reversed array).
  - **Result**: Spread correction orders now place with appropriate sizing near market

- **Dust Partial Resize Fallback Source** in modules/order/strategy.js (commit 857c8f3)
  - **Root Cause**: Dust resize operations used `chainFree` (raw on-chain balance) as fallback, which was too aggressive. Available funds exhaustion should prevent resize unless fill proceeds become available (lines 534-541, 581).
  - **Impact**: Dust orders were being enlarged using raw on-chain funds when they should only use dedicated cache funds from fills.
  - **Fix**: Replaced `chainFree` fallback with `cacheFunds` (fill proceeds earmarked for grid operations). `cacheFunds` is safely available here since it's not consumed until after rebalance completes (lines 366-372).
  - **Result**: Dust orders only enlarge using fill proceeds, preventing fund exhaustion

- **Liquidity Pool Pagination for Price Discovery** in system.js (commit e9e09bc)
  - **Root Cause**: Pool lookup only fetched the first 100 pools using a single API call, missing pools with higher IDs on networks with >100 liquidity pools
  - **Impact**: Price derivation would fail for asset pairs in high-ID pools, silently falling back to market price and potentially using stale/incorrect pricing
  - **Fix**:
    - Implemented pagination loop with `startId` tracking through pool batches
    - Continues fetching 100-pool pages until target pool is found or all pools exhausted
    - Correctly handles `pools.length < PAGE_SIZE` condition to detect end of list
  - **Result**: Price discovery now works reliably for all liquidity pools regardless of pool ID value

- **Spread Threshold Configuration Key Correction** in grid.js (commit e9e09bc)
  - **Root Cause**: Spread correction code used non-existent config key `targetSpread`, which defaulted to `undefined` and fell back to 2.0%
  - **Impact**: Spread corrections used hardcoded 2.0% nominal spread instead of user-configured `targetSpreadPercent`, causing incorrect grid adjustments when users configured different spreads
  - **Fix**: Changed `manager.config.targetSpread` to `manager.config.targetSpreadPercent` (the actual config key)
  - **Result**: Spread corrections now use the user-configured target spread percentage

- **Type-Mismatch Order Cancellation Pipeline** in sync_engine.js and order.js (commit d2f4068)
  - **Root Cause**: When type mismatches were detected (e.g., grid slot reassigned from sell→buy but chain order retained original type), the code pushed a surplus entry to `manager.ordersNeedingPriceCorrection` but `correctOrderPriceOnChain()` treated it like a price update, attempting to call `updateOrder()` with undefined values (expectedPrice, size, type).
  - **Impact**: Type-mismatched chain orders were never cancelled, leaving stale orders on-chain that continued trading against the current grid configuration, causing incorrect balances and failed rotations.
  - **Fix**: Added explicit `isSurplus` handling in `correctOrderPriceOnChain()`:
    - Detects surplus entries early via `isSurplus` flag
    - Routes them to `accountOrders.cancelOrder()` instead of price update
    - Cleans up grid slot by converting to SPREAD placeholder (prevents phantom order references)
    - Returns `{ cancelled: true }` to distinguish from price corrections
  - **Result**: Type-mismatched chain orders are now properly cancelled and grid slots cleared, preventing phantom order accumulation

- **Multi-ID Stale Order Extraction from Batch Failures** in dexbot_class.js (commit d2f4068)
  - **Root Cause**: Batch failure handler only extracted the first stale order ID from error messages using single regex match, but errors can reference multiple stale orders across different BitShares node versions
  - **Issue**: Remaining stale order references in the batch weren't filtered out, causing retry with same failed operations and cascading failures
  - **Fix**:
    - Changed from single `match()` to `Set` with multiple regex patterns (`g` flag on fresh pattern objects)
    - Covers BitShares error format variants: "Limit order X does not exist", "Unable to find Object X", "object X does not exist|not found"
    - Cleans up ALL grid slots referencing any stale order ID (not just first)
    - Filters operations by Set membership check instead of single ID comparison
  - **Result**: Batch recovery now handles multi-ID stale order scenarios correctly, successfully retrying with all valid operations

- **Spread-Out-of-Range False Positive** in order.js (commit d2f4068)
  - **Root Cause**: `shouldFlagOutOfSpread()` returned `1` (flag) when either buy or sell side had zero active orders, even though spread is mathematically undefined with only one side
  - **Impact**: Triggered unnecessary spread corrections when one grid side was exhausted (e.g., all sell orders filled), causing thrashing and grid churn
  - **Fix**: Changed return value from `1` to `0` when `buyCount === 0 || sellCount === 0`, making it skip spread checks when an entire side is empty
  - **Result**: No false spread-out-of-range flags during normal one-sided inventory accumulation

- **Unused Parameter Removal** in dexbot_class.js (commit d2f4068)
  - Removed unused `ordersToPlace` and `ordersToRotate` parameters from `_processBatchResults()` method signature
  - These were passed from two call sites but never used in the method body
  - Cleanup reduces parameter coupling and simplifies the function contract

- **Recovery Cycle Documentation Clarification** in dexbot_class.js (commit d2f4068)
  - Added comment clarifying dual reset points for `_recoveryAttempted` flag:
    - Periodic reset: Every 10-minute cycle (`pauseFundRecalc` block at line 2164)
    - Fill-triggered reset: Only on actual fill events (in `processFilledOrders`)
  - Ensures accounting recovery can be re-attempted even when no fills occur for extended periods

### Core Lines Changed
**Total: 1,428** (1,390 added, 38 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.14] - 2026-02-05 - Critical Bug Fixes, Price Orientation, Fund Validation & Quantization Consolidation

### Added
- **Robust Ghost Order / Full-Fill Detection** in sync_engine.js (commit a8594f0)
  - Implemented detection for "effectively full" orders where the counter-asset (the side not defining the order size) rounds to zero on the blockchain.
  - Prevents untradable orders with tiny remainders from hanging in `PARTIAL` state and blocking rotations.
  - **Verification**: Added `tests/test_ghost_order_fix.js` covering real-world scenarios from production logs.

- **Unanchored Spread Correction Test Integration** (commit c8f4dc5)
  - Integrated `tests/test_unanchored_spread_correction.js` into the main test suite in package.json.
  - Fixed stale imports and ReferenceErrors in the test caused by utility refactoring.

- **Centralized Quantization Utilities** in math.js (commit 9f50184)
  - Extracted `quantizeFloat(value, precision)` - Float → int → float conversion eliminates floating-point accumulation errors
  - Extracted `normalizeInt(value, precision)` - Int → float → int conversion ensures integer alignment with precision boundaries
  - Consolidated from 5 separate implementations across dexbot_class.js, order.js, strategy.js, and chain_orders.js
  - **Result**: Single source of truth for precision logic, improved maintainability, all 34 test suites pass with no regressions

- **Startup Configuration Validation** in dexbot_class.js (commit 56dd4bd)
  - New method `_validateStartupConfig()` validates critical parameters at construction time:
    - Validates `startPrice` is numeric or valid mode (pool/book)
    - Validates `assetA` and `assetB` are present and non-empty
    - Validates `incrementPercent` is in valid range (0-100)
  - Consolidated error reporting shows all validation failures at once instead of cascading errors
  - Improves early error detection and clarifies business rules

- **Precision & Quantization Documentation** (commit d168fb2)
  - Added comprehensive Section 5.5 to FUND_MOVEMENT_AND_ACCOUNTING.md explaining precision issues and quantization utilities
  - Documented `quantizeFloat()` and `normalizeInt()` with detailed examples and use cases
  - Highlighted Patch 14 consolidation: 5 separate implementations → 1 centralized module
  - Added best practices table with 5 real-world scenarios for when to quantize
  - Added cross-references in architecture.md and new "Precision & Quantization Best Practices" section in developer_guide.md
  - Includes code examples showing correct vs incorrect float handling patterns

### Fixed
- **Correct Fund Validation Logic** in dexbot_class.js (commit ac1db74)
  - **Root Cause**: Fund validation computed available as `(chainFree + requiredFunds)`, then checked `if (required > available)`. This became checking `if (required > chainFree + required)` which is always false.
  - **Impact**: Validation never caught batches exceeding available balance, causing "Insufficient Balance" errors on execution despite passing validation.
  - **Fix**: Available funds now correctly equals current free balance (chainFree). Validation checks: `required <= available` where available = chainFree.
  - **Result**: Batches that exceed free balance are rejected BEFORE broadcasting, allowing both sides of order pairs to be created successfully.

- **Correct Price Orientation - B/A Standard** in system.js (commit cd0a249, documentation updated in commit 45eedac)
  - **Root Cause**: Commit ae6e169 incorrectly removed price inversion and reversed pool calculation, causing inverted prices in production.
  - **Fix**: Restored correct inversion logic: `1 / mid` for market prices (BitShares `get_order_book(A,B)` returns A/B format, need B/A)
  - **Example**: XRP/BTS market should be ~1350 (1 XRP = 1350 BTS), not 0.000752 (which is A/B inverted)
  - **Verification**: Pool price = `floatB / floatA` (3000000 BTS / 20000 XRP = 150 BTS/XRP); Market price = `1 / mid` (inverts API's A/B to B/A)
  - **Documentation Added**: Comprehensive developer guide section explaining price orientation standards, conversion tables, and debugging patterns (commit 45eedac)

- **Critical Edge Case & Data Integrity Fixes** in multiple files (commit 16d1651)
  - **Empty Grid Edge Case**: Added check in startup_reconcile.js to prevent `.every([])` returning true for empty edge order list - fixes false "grid edge fully active" reports
  - **Suspicious Order Size**: Changed silent return to throw error in order.js - order exceeding 1e15 satoshis indicates data corruption; forces recovery instead of continuing with phantom orders
  - **BTS Fee Handling**: Centralized fee calculation in accounting.js - **CRITICAL**: For BTS, refund is a SEPARATE transaction, not in fill amount. Don't add refund to fill proceeds (prevents double counting).
  - **Deadlock Prevention & AsyncLock Hardening**: Added timeout to sync lock acquisition in sync_engine.js (commit 16d1651, hardened in commit 276b07d)
    - Wraps lock acquisition with `Promise.race() + 20s timeout` to prevent indefinite hangs
    - Implemented `cancelToken` support in AsyncLock to enable safe operation cancellation
    - Added abortion check after lock acquisition to prevent "Zombie Sync" race conditions
    - Added `clearQueue()` method for emergency operation cleanup

- **Boundary and Precision Issues** in multiple files (commit 58a46d2)
  - **Negative Boundary Index**: Added immediate `Math.max(0, ...)` clamp to boundaryIdx calculation in strategy.js - prevents negative array indices during boundary initialization
  - **Precision Underflow**: Fixed precision calculation in order.js - when `assetA.precision < assetB.precision`, divide instead of multiply to prevent precision loss for asset pairs with different scales
  - **Overly Permissive Logging**: Enforced strict equality check `=== 0` in accounting.js instead of `=== 0 || === undefined` - prevents spurious debug logging with uninitialized depth counter

- **Removed Unused MAKER_REFUND_RATIO Constant** in constants.js
  - Removed unused and semantically confusing `MAKER_REFUND_RATIO: 0.1` constant
  - The correct refund logic uses `MAKER_REFUND_PERCENT: 0.9` which is the only one actually used in calculations
  - Cleanup reduces configuration confusion around fee parameters

- **Liquidity Pool Asset Mapping** in system.js (commit c8f4dc5)
  - Enhanced `derivePoolPrice` with explicit asset ID numerical ordering
  - Correctly maps BitShares' `balance_a`/`balance_b` (ordered by internal ID) to the bot's `assetA`/`assetB` regardless of which asset was created first on the network

- **Divergence Correction Race Protection** in system.js (commit a8594f0)
  - Implemented `_correctionsLock` acquisition in `applyGridDivergenceCorrections`
  - Prevents "Time-of-Check to Time-of-Use" (TOCTOU) race conditions where concurrent fill processing could interleave with structural grid updates

- **Rotation Size Overrun Prevention** in strategy.js (commit 02f61a2)
  - Fixed a bug where order sizes during rotations could exceed available capital
  - Rotation sizes are now strictly capped by the sum of available funds and released surplus from canceled orders

- **Rebalance Scoping Fix** in strategy.js (commit a8594f0)
  - Resolved a `ReferenceError` for `minHealthySize` variable that caused crashes during certain rebalance cycles

- **Extract Magic Numbers to Constants** in constants.js and affected modules (commit 56dd4bd, expanded with timeout constants in commit 8b29396)
  - **Fee Parameters**: `MAKER_FEE_PERCENT` (0.1), `MAKER_REFUND_PERCENT` (0.9), `TAKER_FEE_PERCENT` (1.0)
  - **Timing Constants** (commit 8b29396):
    - `SYNC_LOCK_TIMEOUT_MS` (20s): Deadlock prevention for sync lock acquisition
    - `CONNECTION_TIMEOUT_MS` (30s): BitShares client connection establishment
    - `DAEMON_STARTUP_TIMEOUT_MS` (60s): Private key daemon startup timeout
    - `RUN_LOOP_DEFAULT_MS` (5s): Main loop cycle delay default value
    - `CHECK_INTERVAL_MS` (100ms): Polling interval for connection/daemon readiness
  - **Grid Parameters**: `MAX_ORDER_FACTOR` (1.1) for max order sizing
  - **Impact**: Eliminated all hardcoded timeout values from 8 modules; centralized timing configuration in one location
  - Updated math.js, export.js, dexbot_class.js, bitshares_client.js, chain_keys.js, chain_orders.js, dexbot_class.js, startup_reconcile.js, sync_engine.js, pm2.js to use constants
  - Added fallback for MAX_ORDER_FACTOR in _getMaxOrderSize() with || 1.1 fallback

### Key Improvements
- **Accuracy**: Price derivation consistently reflects B/A standard; fund calculations prevent over-commitment
- **Robustness**: Ghost order detection ensures grid flow; quantization consolidation eliminates precision errors; validation catches configuration issues early
- **Stability**: Locking prevents race conditions; boundary clamping prevents array corruption; timeout prevents deadlocks; startup validation prevents cascading failures
- **Maintainability**: Centralized quantization logic, consolidated fee calculations, documented magic numbers reduce technical debt

---

## [0.6.0-patch.13] - 2026-02-03 - Spread Correction Redesign, Index Bug Fixes & Config Extraction Improvements

### Added
- **Edge-Based Spread Correction Strategy** in correctionManager.js (commit fe66916)
  - Replaces vulnerable mid-price based approach with conservative edge-based correction
  - **Priority 1**: Update existing PARTIAL orders at the gap edge (closest to market)
    - Calculates delta: min(idealSize - currentSize, availableFund)
    - Sets state to ACTIVE (already on-chain, no re-placement needed)
  - **Priority 2**: Activate SPREAD slots at the edge (fallback if no partials available)
    - BUY: Picks lowest price spread slot (extends wall upward gradually)
    - SELL: Picks highest price spread slot (extends wall downward gradually)
    - Sets state to VIRTUAL (goes through normal placement pipeline)
  - **Safety guarantee**: Processes ONE candidate per call (prevents cascade placements)
  - Enables incremental gap closure with manual verification between steps

### Enhanced
- **Spread Adjustment for Doubled Sides** in grid.js and strategy.js (commit e04f371)
  - When a side is flagged as doubled, adjust effective target spread by +1 increment
  - Widens spread goal, increases gapSlots boundary, maintains wider separation
  - Example: BUY side doubled at 1.60% → aims for 2.00% spread (+ 0.40% increment)
  - Compensates for having fewer orders on the doubled side

- **Bot Config Extraction Logic** in analyze-orders.js (commit 52f4d58)
  - Now matches order files to bot configs even when metadata is null
  - Extracts asset symbols directly from order file's assets object
  - Fallback pattern matching: "t-bts-2.json" → "T/BTS"
  - Safety fallback for currency symbols: uses "BASE"/"QUOTE" if null
  - Improved double-sided mode display: shows which specific sides (BUY/SELL) are doubled

### Fixed
- **Critical Index Mismatch Bugs** (commit 27b3f4a)
  - **Bug #1 in dexbot_class.js (lines 220-222)**:
    - Issue: Filtered active bots first, then mapped with new indices
    - Result: T-BTS (originally index 2) reassigned to index 1
    - Caused botKey mismatch: looking for t-bts-1.json instead of t-bts-2.json
    - Fix: Map with original indices first, then filter by active status

  - **Bug #2 in account_orders.js (lines 213-227)**:
    - Issue: Used filtered array indices in ensureBotEntries processing
    - Same root cause created wrong bot keys and metadata storage
    - Fix: Preserve original indices through map-filter-destructure chain

  - **Impact**:
    - Correct botKey generation ensures proper file matching
    - Metadata will be loaded from correct bot file
    - Metadata properly updates from null to actual values (e.g., TWENTIX/BTS)

- **Spread Threshold Calculation Simplification** in constants.js and strategy.js (commit 326cef5)
  - Replaced complex geometric formula for nominalSpread with direct config.targetSpread value
  - Simplified limitSpread from geometric formula to linear: limitSpread = nominalSpread + (incrementPercent × toleranceSteps)
  - Tolerance scales with doubled state: base 1 increment, +1 per doubled side (max 3 total)
  - **Result**: Respects MIN_SPREAD_FACTOR constraint, resolves false "out of spread" corrections
  - Verified: 100% test pass rate for 0.5% increment across 2.1x to 4.0x multipliers

### Key Improvements
- **Safety**: Edge-based correction eliminates geometric mean calculation vulnerabilities
- **Predictability**: Single-order-per-call approach enables verification and control
- **Correctness**: Fixed critical botKey generation bugs that caused config mismatches
- **Robustness**: Spread logic now respects constraints and properly handles doubled states
- **Observability**: Improved config extraction and metadata handling for diagnostics

### Testing
- All 107+ existing tests pass
- No regressions detected
- Verified spread threshold calculation across multiple multiplier ranges
- Config extraction tested with null metadata scenarios

### Core Lines Changed
**Total: 608** (407 added, 201 removed) - Root and modules/*.js files only

### Related Commits
- Builds on Patch 12 pipeline safety (non-destructive recovery principles)
- Complements Patch 11 order state predicates
- Fixes edge cases in order metadata handling from Patch 10

### Core Lines Changed
**Total: 6,125** (2,600 added, 3,525 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.12] - 2026-02-02 - Pipeline Safety Enhancement, Fund Availability Fix & Code Quality Improvements

### Added
- **Pipeline Timeout Safeguard** in manager.js (commit 6737d35)
  - 5-minute timeout on `isPipelineEmpty()` to prevent indefinite grid-maintenance blocking
  - Automatic flag clearing with warning logs when timeout triggers
  - `_pipelineBlockedSince` tracking for diagnostics
  - Non-destructive recovery (clears flags only, not orders)

- **Pipeline Health Diagnostic Method** in manager.js (commit 6737d35)
  - `getPipelineHealth()` returns 8 diagnostic fields
  - Blockage timestamp, duration (both milliseconds and human-readable), pending counts, affected sides
  - Enables production monitoring dashboards and alerting systems
  - Integrated into post-fill logging for operational visibility

- **Pipeline Timing Configuration** in constants.js (commit 6737d35)
  - `PIPELINE_TIMING.TIMEOUT_MS` (300000 ms / 5 minutes) - Conservative timeout preventing false positives

- **Stale Pipeline Operations Clearing** in manager.js (commit dd94044)
  - `clearStalePipelineOperations()` method explicitly handles timeout recovery
  - Separates timeout logic from `isPipelineEmpty()` query
  - Called from `_executeMaintenanceLogic()` for scheduled cleanup

### Refactored
- **Pipeline Timeout Logic Separation** in manager.js (commit dd94044)
  - Extracted timeout and clearing logic from `isPipelineEmpty()` into `clearStalePipelineOperations()`
  - `isPipelineEmpty()` now a pure query (except timestamp tracking)
  - `getPipelineHealth()` no longer calls `isPipelineEmpty()` internally
  - Improves separation of concerns and testability
  - Removes hidden side effects in query method

- **Fill Cleanup Counter Logic** in dexbot_class.js (commit 83b4dc6)
  - Removed redundant lazy initialization (counter already initialized in constructor)
  - Removed misleading "locally track" comment that incorrectly described synchronization
  - Simplified from 14 to 10 lines while maintaining same functionality
  - Clarified lock-based synchronization mechanism in comments

### Fixed
- **Mixed BUY/SELL Order Fund Availability Checks** in dexbot_class.js (commit 701352b)
  - **Problem 1 - Asset Mapping Regression**: After commit ee76bcd, BUY orders checked `sellFree` and SELL orders checked `buyFree` (inverted)
  - **Problem 2 - Mixed Order Handling**: `_buildCreateOps()` received both BUY and SELL orders but summed them together and only checked first order's type, causing false fund warnings
  - **Problem 3 - Per-Order Validation**: Used first order's type for validating all orders instead of each order's individual type
  - **Solution**:
    - Separate BUY and SELL orders into independent checks
    - BUY orders now correctly check `buyFree` (assetB capital)
    - SELL orders now correctly check `sellFree` (assetA inventory)
    - Each order validated against its own type, not first order's type
  - **Impact**: Accurate fund warnings, eliminates false positives for mixed placements

- **Critical Pipeline Vulnerability** (commit 6737d35)
  - **Problem**: Pipeline checks could block indefinitely if operations hung (network issues, stuck corrections)
  - **Solution**: 5-minute timeout with automatic recovery
  - **Impact**: Prevents bot from entering permanent locked state

- **Fill Persistence Error Clarity** in dexbot_class.js (commit ebc17ff)
  - **Problem**: Unclear what happens when fill persistence fails
  - **Solution**: Enhanced error message documents potential reprocessing on next run
  - **Impact**: Operators understand expected behavior without false alarm about bugs

### Documentation Enhancements
- Enhanced `_executeMaintenanceLogic()` header with:
  - 6-step maintenance sequence breakdown
  - Race-to-resize prevention rationale
  - Timeout safety guarantees
  - Detailed explanation of why pipeline consensus matters

- Enhanced `_runGridMaintenance()` header with:
  - 3 entry points (startup, periodic, post-fill)
  - Lock ordering explanation and deadlock prevention
  - Pipeline protection details

- Improved post-fill logging to show blockage duration
- Added inline comments explaining retry behavior on cleanup failure

### Benefits
- **Stability**: Pipeline no longer blocks indefinitely due to stuck operations
- **Observability**: getPipelineHealth() enables monitoring and alerting
- **Clarity**: Removed misleading comments, improved documentation
- **Quality**: Simplified code without losing functionality
- **Safety**: Non-destructive timeout prevents resource leaks

### Testing
- All 107+ existing tests pass
- No regressions detected
- All integration tests verified
- Backward compatible with existing code

### Related Commits
- Builds on commit a946c33 (grid maintenance race-to-resize fix)
- Complements pipeline consensus enforcement from Patch 11
- Includes refactoring in dd94044 (pipeline timeout separation)
- Fixes regression from ee76bcd (asset mapping in fund checks)

---

## [0.6.0-patch.11] - 2026-02-02 - Order State Predicate Centralization

### Added
- **Centralized Order State Helpers** in utils.js (commit 2fb171d)
  - `isOrderOnChain()` - ACTIVE or PARTIAL check
  - `isOrderVirtual()` - VIRTUAL check
  - `hasOnChainId()` - orderId existence check
  - `isOrderPlaced()` - on-chain AND has ID (safe placement)
  - `isPhantomOrder()` - on-chain WITHOUT ID (error detection)
  - `isSlotAvailable()` - virtual + no ID (reusable slot)
  - `virtualizeOrder()` - transitions order to VIRTUAL, clears blockchain metadata
  - `isOrderHealthy()` - comprehensive size validation (absolute + dust threshold)

- **Additional Centralized Helpers** in utils.js (commit d6560a8)
  - `getPartialsByType(orders)` - Returns `{buy: [], sell: []}` of partial orders by type
  - `validateAssetPrecisions(assets)` - Validates both asset precisions at once
  - `getPrecisionSlack(precision, factor)` - Calculates precision slack for float comparisons

### Refactored
- Replaced 34+ inline state checks across 6 modules with semantic helpers (commit 2fb171d)
  - **strategy.js**: -27 lines (role-assignment, surplus/shortage detection)
  - **manager.js**: -2 lines (SPREAD validation, phantom prevention)
  - **sync_engine.js**: rotation/fill cleanup uses helpers
  - **grid.js**: -10 lines (slot availability, phantom sanitization)
  - **startup_reconcile.js**: edge validation, price matching

- Replaced pattern duplications with centralized helpers (commit 56a7344)
  - **`getPartialsByType()` eliminated 3 duplications**: strategy.js, grid.js, startup_reconcile.js
  - **`getPrecisionSlack()` eliminated 2 duplications**: accounting.js, manager.js
  - **Net result**: -15 lines of duplication across 5 modules

### Fixed
- **Dynamic require in dexbot_class.js**: Moved `virtualizeOrder` import to module-level

### Core Lines Changed
**Total: 2,196** (1,686 added, 510 removed) - Root and modules/*.js files only

### Benefits
- Single source of truth for order state logic
- Semantic function names improve readability
- Centralized phantom order detection
- Consistent patterns across all modules

### Core Lines Changed
**Total: 2,717** (2,118 added, 599 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.10] - 2026-01-30 - Trigger Reset Stabilization, Fund Loss Prevention & Order State Management

### Added
- **Bootstrap Validation During Trigger Reset** (commit d1989eb)
  - **Feature**: Added fund drift validation at bootstrap completion to detect real bugs vs transient state mismatches.
  - **Mechanism**: `finishBootstrap()` validates drift when grid is stable; `validateGridStateForPersistence()` logs transient drift for observability without blocking regeneration.
  - **Benefit**: Distinguishes between genuine accounting errors and expected temporary state changes during grid rebuild.

- **Immediate Fill Processing After Trigger Reset** (commit d1989eb)
  - **Feature**: Checks `_incomingFillQueue` immediately after trigger reset completes and processes fills through rebalance pipeline.
  - **Mechanism**: Fills that occur during grid regeneration are now detected and replacement orders placed before spread check, maintaining grid consistency.
  - **Benefit**: Eliminates "holes" where filled orders aren't replaced, ensuring no gaps in grid coverage after reset.

- **Git Diff Watcher Script** (commit 165f380)
  - **Feature**: Added `scripts/watch-all-changes.sh` for interactive monitoring of uncommitted, committed, and pushed changes.
  - **Capabilities**: Smart auto-refresh (1s for uncommitted, 15s for committed), split-view file/diff search with fzf, toggle between full file and diff-only views.
  - **Benefit**: Enhanced development workflow for tracking changes across multiple states.

### Fixed
- **Comprehensive Trigger Reset Flow** (commit 3d90b2a)
  - **Problem**: Trigger reset was redundantly reinitializing fully-prepared state and running spread checks at wrong time, causing race conditions with partial order integration.
  - **Solution**:
    - Skip normal startup initialization after trigger reset (grid already fully initialized with orders placed, synced, and persisted).
    - Run only spread correction and bootstrap after reset instead of full initialization sequence.
    - Reorder maintenance steps: spread check FIRST, then divergence check (ensures wide spreads from reset are corrected before structural analysis).
    - Filter PARTIAL orders from chain sync before grid regeneration (remnants of old grid shouldn't be re-integrated).
    - Fix VIRTUAL→ACTIVE transitions: only mark as PARTIAL if previously ACTIVE (genuine partial fills), not on new matches with precision variance.
  - **Impact**: Eliminates race conditions and improves grid state consistency after trigger reset.

- **Grid Persistence After Trigger Reset** (commit 1ede196)
  - **Problem**: Destructured `persistedGrid` variable was stale after trigger reset, causing duplicate orders at same slots.
  - **Solution**: Changed `const persistedGrid` to `let` and directly reassign after reset so subsequent code uses regenerated grid.
  - **Impact**: Prevents duplicate order placement from using stale grid state.

- **Trigger File Reset Sequencing** (commit c7e5da9)
  - **Problem**: Trigger reset was handled after persisting old grid state, causing fund invariant violations (8 BTS) and persistence gate warnings.
  - **Solution**:
    - Activate fill listener FIRST before any orders placed.
    - Handle pending trigger reset IMMEDIATELY after listener activation.
    - Reload persisted grid from storage after reset (ensures grid matches regenerated state).
    - Skip fund drift validation during bootstrap (temporary mismatches expected during rebuild).
    - Refactor shared `_performGridResync()` for both startup and runtime trigger detection.
  - **Impact**: Eliminates fund invariant violations and persistence warnings during trigger reset.

- **100,000x Order Size Multiplier Bug** (commit c1dd906)
  - **Problem**: `rawOnChain.for_sale` was populated with float strings ("60.10317") instead of blockchain integers ("6010317"), causing delta calculations to be 100,000x too large.
  - **Solution**: Modified `buildCreateOrderOp()` to return both operation and `finalInts` (blockchain integers), updated `rawOnChain` population to use blockchain integers instead of float values.
  - **Impact**: Prevents massive order size mismatches and funding errors during order creation.

- **Phantom Fund Losses During Boundary-Crawl Rebalance** (commit 43ace9b)
  - **Problem**: 3,950 IOB.XRP phantom fund loss caused by three issues:
    1. Grid-resize calculated SELL sizes using wrong asset units (drained sellFree by 18.21 IOB.XRP).
    2. Accounting skipped in recovery paths, leaving funds locked in grid.committed.
    3. Type changes (SELL→BUY) applied before state transitions, releasing capital to wrong bucket.
  - **Solution**:
    - Enable accounting in batch validation/execution recovery paths (lines 1272, 1304 in dexbot_class.js).
    - Enable accounting in periodic blockchain fetch (line 661 in sync_engine.js).
    - Fix capital release order: state transitions applied BEFORE type changes so releases use original type.
  - **Impact**: Prevents phantom fund cascades, oversized orders, and grid invariant violations.

- **Type/State Change Processing Order** (commit ac329cd)
  - **Problem**: Boundary-driven type changes (BUY/SELL/SPREAD reassignment) and state changes (cancellations/virtualizations) applied in wrong order, causing fund releases with incorrect types.
  - **Solution**: Implement two-phase architecture:
    - PHASE 1: Apply type changes immediately via `mgr._updateOrder()` with `context='role-assignment'` BEFORE rebalancing logic runs.
    - PHASE 2: Apply state changes AFTER `rebalanceSideRobust()` completes.
  - **Impact**: Eliminates race condition where same order receives type + state change in one batch; improves code clarity and prevents future bugs.

- **Spread Check Logging Timing** (commit 09bf17f)
  - **Problem**: Spread condition check logic timing and logging were misaligned, causing state to be set at wrong time.
  - **Solution**: Keep spread check logic inside `rebalance()` to set `mgr.outOfSpread` at correct time, defer logging to AFTER persistGrid() via stored spread info.
  - **Impact**: Maintains correct state timing for subsequent operations while deferring log output to show actual on-chain state.

### Refactored
- **Mid-Price Calculation for Spread Correction** (commit 3d90b2a)
  - **Mechanism**: Added mid-price calculation in grid regeneration to identify valid order zones (BUY orders below mid-price, SELL orders above).
  - **Benefit**: Improves spread correction accuracy by properly validating order positioning.

- **Simplified Startup Resumption** (commit 3d90b2a)
  - **Change**: After trigger reset, resume main order manager loop with correct sequencing (spread check → health check → main loop) instead of full initialization.
  - **Impact**: Cleaner, more predictable flow with reduced redundant operations.

### Changed
- **Unused Imports Cleanup** (commit 165f380)
  - Removed unused `readline-sync` imports from `modules/account_bots.js` and `modules/chain_keys.js` (already using custom async methods).
  - Reduces unnecessary dependencies and improves code clarity.

- **Project Documentation** (commits 4a08821, d6be00b)
  - Added `AGENTS.md` as the shared project instruction file.
  - Renamed `opencode.md` to `OPENCODE.md` for consistency with convention.

### Performance
- **No Performance Regression**: All refactoring maintains identical operation counts; improvements are correctness-focused.

### Quality Assurance
- **Test Coverage**: All 35 test suites pass ✓
- **Correctness Improvements**:
  - Eliminated phantom fund loss scenarios through proper accounting and release ordering.
  - Fixed race conditions in trigger reset flow with explicit sequencing.
  - Prevented order duplication through proper grid state management.
  - Improved type/state change atomicity with two-phase architecture.

### Core Lines Changed
**Total: 511** (365 added, 146 removed) - Root and modules/*.js files only

### Core Lines Changed
**Total: 5,388** (1,216 added, 4,172 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.9] - 2026-01-28 - Startup Consolidation, Zero-Amount Prevention & Auto-Recovery

### Added
- **Startup Auto-Recovery for Accounting Drift** (commit 6f2e481)
  - **Feature**: Automatic recovery mechanism triggered during startup when accounting drift is detected.
  - **Mechanism**: Performs fresh blockchain balance fetch and full synchronization from open orders to reset optimistic drift.
  - **Benefit**: Prevents accumulated accounting errors from affecting bot operations and ensures clean state initialization.

### Fixed
- **Zero-Amount Order Prevention** (commit ca2a28e)
  - **Problem**: Strict minimum order size validation was missing, allowing zero-amount orders to be created and broadcast to blockchain, causing transaction failures and accounting drift.
  - **Solution**:
    - Enforced absolute minimum order size in both strategy and grid logic using `getMinOrderSize()`.
    - Added validation gate in `broadcastBatch()` to reject zero-amount operations before blockchain submission.
    - Implemented fresh balance fetch during batch failure recovery to reset optimistic drift to blockchain reality.
  - **Impact**: Prevents zero-size orders from corrupting chain state and triggering cascading recovery cycles.

- **Optimistic Accounting Drift Recovery** (commit ca2a28e)
  - **Problem**: Failed batch operations could leave optimistic accounting state desynchronized from actual blockchain totals.
  - **Solution**: Fresh `fetchAccountTotals()` call before synchronization resets optimistic tracking to true blockchain values.
  - **Safety**: Applied in both validation failure and execution failure paths to ensure consistent recovery.

### Refactored
- **Startup Sequence Deduplication** (commit f11cc3c)
  - **Problem**: 697 lines of duplicated startup code between `start()` and `startWithPrivateKey()` created maintenance burden and inconsistency risk.
  - **Solution**: Extracted shared logic into unified private methods:
    - `_initializeStartupState()`: Centralized state initialization
    - `_finishStartupSequence()`: Unified startup completion logic
    - `_setupAccountContext()`: Consolidated account setup
    - `_runGridMaintenance()`: Single grid maintenance entry point
    - `_executeMaintenanceLogic()`: Centralized threshold, divergence, spread, and health checks
  - **Refactored `placeInitialOrders()`**: Now uses `updateOrdersOnChainBatch()` for consistency.
  - **Impact**: Net reduction of ~280 lines with guaranteed identical startup behavior across all entry points.

- **Lock Ordering Fixes for Deadlock Prevention** (commit f11cc3c)
  - **Problem**: Inconsistent lock acquisition order between fill processing and grid maintenance could cause deadlocks.
  - **Solution**:
    - Enforce canonical lock order: `_fillProcessingLock → _divergenceLock`
    - Replace fragile `isLocked()` checks with explicit `fillLockAlreadyHeld` parameter
    - Add try-finally to ensure `isBootstrapping` flag is always cleared
    - Extend lock scope in startup to cover finishBootstrap and maintenance atomically
    - Add error handling in `_consumeFillQueue()` divergence lock
  - **Impact**: Eliminates potential deadlock scenarios and ensures atomic startup operations.

### Changed
- **Package Scripts Enhancement** (commits f02497d, 2f4a938)
  - Added `pdev` npm script: Synchronizes test branch to dev branch with safe remote push mode
  - Added `ptest` npm script: Synchronizes local test branch to origin/test safely without branch switching
  - **Benefit**: Streamlined development workflow with safer branch promotion

### Performance
- **No Performance Impact**: Startup deduplication maintains identical execution paths; refactoring is internal only.

### Quality Assurance
- **Code Quality Improvements**
  - Consolidated ~280 lines of duplicate startup code
  - Improved lock management with explicit parameter passing
  - Enhanced error handling in divergence lock acquisition
  - Maintainability improvement: Single source of truth for startup sequence and grid maintenance logic

### Core Lines Changed
**Total: 3,498** (2,426 added, 1,072 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.8] - 2026-01-25 - Spread Refinement, Inventory Sync & Operational Hardening

### Added
- **Layer 2 Self-Healing Recovery** (commit 8e88a6d)
  - **Feature**: Enhanced stabilization gate with automated recovery when transient fund drift is detected.
  - **Mechanism**: Attempts account refresh and full syncFromOpenOrders before re-verifying invariants.
  - **Benefit**: Prevents unnecessary halting from transient optimistic tracking drifts while maintaining safety against persistent corruption.
- **Fund-Driven Boundary Sync** (commit 7a443f5)
  - **Feature**: Implemented a new synchronization layer that aligns the grid boundary with the account's actual inventory distribution (buy/sell fund ratio).
  - **Benefit**: Automatically shifts the grid to favor the "heavier" side, ensuring the bot remains positioned where it has the most capital to trade.
- **Scaled Spread Correction** (commit 75e23b2)
  - **Feature**: Introduced dynamic spread correction that scales the number of replacement slots based on the severity of the widening.
  - **Safety**: Integrated a "double-dust" safety floor to prevent creating undersized orders during aggressive corrections.
- **Periodic Market Price Refresh** (commit ec97a02)
  - **Feature**: Added background market price updates every 4 hours (configurable).
  - **Impact**: Ensures that fund valuation and grid anchoring remain accurate even during long-running sessions without fills.

### Fixed
- **Rapid-Restart Cascade Defense (Layer 1 & Layer 2)** (commit ebca167)
  - **Problem**: Rapid bot restarts caused cascading fund drift (416 BTS), 2,470x order size mismatches, and 43 billion BTS delta calculation errors when orders filled on-chain while bot was offline.
  - **Solution - Layer 1**: Session timestamps (sessionId, createdAtMs) prevent stale grid orders from being matched to chain orders via orphan-fallback. Pre-restart orders are marked with `previousSessionMarker=true` and automatically skipped.
  - **Solution - Layer 2**: Stabilization gate (`checkFundDriftAfterFills()`) compares grid allocation + free balance vs actual blockchain totals before rebalancing. Aborts if drift exceeds tolerance, preventing cascade corruption spread.
  - **Impact**: Defense-in-depth protection with negligible overhead (O(1) check + <1ms scan).
- **Periodic Fetch Deadlock Resolution** (commit a2f76c9)
  - **Problem**: Periodic fetch operations could deadlock during boundary sync or fill processing, causing bot to hang.
  - **Solution**: Refined timeout logic and acquisition sequencing in periodic fetch handler.
  - **Impact**: Smooth background updates without blocking core operations.
- **Updater Restart Loop Prevention** (commits 95b6d15, 230af49)
  - **Problem**: Updater would trigger redundant restarts and fail to gracefully handle branches where local is ahead of remote.
  - **Solution**: Optimized branch switching detection and added checks to prevent unnecessary reloads when local is ahead.
  - **Impact**: Cleaner update cycle, fewer spurious restarts.
- **Grid Check API Breakage** (commit bf41543)
  - **Problem**: Periodic grid checks broke API contract and caused deadlock during fill processing.
  - **Solution**: Fixed deadlock and restored API compatibility.
- **Spread Gap Over-calculation & Alignment** (commit 77d01cd)
  - **Problem**: The grid was creating one more price gap than intended because it didn't account for the naturally occurring 'Center Gap' during symmetric centering.
  - **Solution**: Refined `gapSlots` calculation to `requiredSteps - 1` and standardized spread-check logic to use `gapSlots + 1` as the true gap distance.
- **BUY Side Sizing & Fee Accounting** (commits 6190e46, eea127b)
  - **Fix**: Resolved a sizing mismatch on the BUY side where fees were incorrectly applied to the base asset instead of the quote asset.
  - **Accuracy**: Now correctly accounts for market fees and BTS maker refunds in fill proceeds calculation, ensuring internal ledgers match blockchain totals.
- **Configurable Pricing Priority** (commit 46b39f8)
  - **Fix**: Disabled automatic `startPrice` derivation and refresh when a numeric value is explicitly provided in `bots.json`. This gives users absolute control over grid anchoring.
- **Strategic Grid Balance** (commit 2313bdd)
  - **Logic**: Implemented automatic target count reduction (-1) on "doubled" sides (sides with dust-consolidated orders) to prevent structural grid drift and maintain symmetry.

### Refactored
- **Unused Stabilization Constants Removal** (commit ebca167)
  - **Cleanup**: Removed unused STABILIZATION constants (MAX_DRIFT_BTS, MAX_DRIFT_PERCENT, INVARIANT_CHECK_TIMEOUT_MS, SESSION_BOUNDARY_GRACE_PERIOD_MS) from Layer 2 defense implementation.
  - **Rationale**: Implementation uses existing GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE instead; preset constants added unnecessary complexity without usage.
- **PM2 Orchestration & Credential Management** (commits 5ddd6cb, 3685332)
  - **Cleanup**: Integrated the credential daemon directly into the PM2 lifecycle and simplified the launcher logic.
  - **Visibility**: Renamed PM2 processes to `dexbot-cred` and `dexbot-update` for easier monitoring via `pm2 list`.
- **Legacy Spread Multiplier Removal** (commit 77d01cd)
  - **Cleanup**: Completely removed `SPREAD_WIDENING_MULTIPLIER` and replaced it with a neutral, fixed 1-slot tolerance buffer across all modules.
- **Out-of-Spread Metric Unification** (commit 0546487)
  - **Logic**: Refactored `outOfSpread` from a boolean flag to a numeric distance (steps), allowing for more precise structural updates during rebalancing.

### Performance
- **Pool ID Caching** (commit 490b793)
  - **Optimization**: Cached Liquidity Pool IDs in `derivePoolPrice` to eliminate redundant blockchain scans, significantly reducing API load during startup and refreshes.
  - **Cache Invalidation**: Validates cached pools against requested assets to prevent stale pool reuse
  - **Transparent Fallback**: Falls back to blockchain scan on cache miss, maintaining correctness

### Quality Assurance
- **Boundary Sync Integration Tests** (`tests/test_boundary_sync_logic.js`)
  - **Coverage**: 10+ test cases covering fund-driven boundary recalculation, rotation pairing, and target count reduction
  - **Tests Include**:
    - Boundary shifts with fund imbalance (validates fund-driven boundary logic)
    - Rotation pairing matches existing orders to desired slots
    - Doubled side reduces target count by 1 (prevents grid imbalance)
    - Boundary respects available funds (prevents overfunding)
    - Cache ratio threshold detection (20% GRID_REGENERATION_PERCENTAGE)
    - Grid divergence detection between persisted and calculated states
    - Bootstrap divergence ordering (threshold check → divergence check)
    - Pool ID cache hit/miss behavior
    - Cache invalidation on stale pools
    - Concurrent cache access integrity
  - **Impact**: Comprehensive validation of core boundary sync and startup grid check logic

- **Fee Calculation Backwards Compatibility Tests** (`tests/test_fee_backwards_compat.js`)
  - **Coverage**: 21+ test cases validating fee calculation changes and API compatibility
  - **Tests Include**:
    - **BTS Fee Object Structure**: Always returns object (never number) for BTS
    - **Old Fields Preserved**: `total`, `createFee`, `netFee` still present (legacy code compatibility)
    - **New Field Added**: `netProceeds` field for improved accounting
    - **Maker/Taker Differentiation**: 90% refund for makers preserved
    - **Non-BTS Assets**: Still return number (unchanged behavior)
    - **Mixed Asset Pattern**: Code handles both BTS and non-BTS safely
    - **Fee Math Accuracy**: Validates BTS maker/taker proceeds and non-BTS fee deduction
  - **Key Finding**: New `netProceeds` field is backwards compatible; code can safely use `typeof` checks to access it
  - **Impact**: Ensures no breaking changes to fee API while adding accounting precision

- **Code Quality Improvements**
  - **Trailing Whitespace**: Removed 34 lines of trailing whitespace across 10 files
    - `modules/dexbot_class.js`, `modules/order/runner.js`, `modules/order/grid.js`
    - `modules/order/accounting.js`, `modules/order/strategy.js`, `modules/account_bots.js`
    - `modules/order/startup_reconcile.js`, `modules/order/utils.js`, `dexbot.js`, `pm2.js`
  - **Whitespace Verification**: `git diff --cached --check` shows 0 issues post-cleanup
  - **Test Integration**: New tests added to npm test script (package.json)
  - **All Tests Passing**: Full test suite runs 32+ test files with no failures

### Changed
- **Documentation Overhaul**: Updated `FUND_MOVEMENT_AND_ACCOUNTING.md`, `architecture.md`, and `developer_guide.md` to reflect refined gap formulas, zone indexing, and new sync behaviors.
- **Research**: Added the 3-indicator reversal architecture to the trend detection analysis folder (`74203ab`).
- **Fee Calculation**: Added `netProceeds` field to BTS fee objects for improved accounting accuracy
  - **For Makers**: `netProceeds = assetAmount + (creationFee * 0.9)` (includes refund)
  - **For Takers**: `netProceeds = assetAmount` (no refund)
  - **Backwards Compat**: Non-BTS assets unchanged; BTS object structure is additive

### Technical Details Added
- **Locking Architecture**: New `_divergenceLock` in `_performGridChecks()` prevents races with fill processing during boundary sync
- **Startup Grid Checks**: New `_performGridChecks()` method consolidates fund threshold and divergence checks
  - **Phase 1**: Threshold check (cache ratio exceeds GRID_REGENERATION_PERCENTAGE)
  - **Phase 2**: Divergence check (only after threshold check fails, only during bootstrap)
  - **Atomic Operations**: Uses `_divergenceLock.acquire()` to prevent concurrent modifications
- **Fund-Driven Boundary Calculation**: Adjusts grid boundary based on inventory distribution (buy/sell fund ratio)
  - **Initialization**: Scans all grid slots and calculates fund-driven boundary position
  - **Role Assignment**: Adjusts BUY/SPREAD/SELL zone assignments based on new boundary
  - **Fund Respect**: Never exceeds available funds during slot activation
- **Rotation Pairing Algorithm**: Matches existing on-chain orders to desired slots
  - **Closest First**: Sorts active orders by market distance (best execution first)
  - **Adaptive Target Count**: Reduces by 1 on doubled sides to prevent structural drift
  - **Three Cases**: MATCH (update), ACTIVATE (new placement), DEACTIVATE (excessive)

---

## [0.6.0-patch.7] - 2026-01-23 - Architectural Hardening, Deep Consolidation & Performance Optimization

### Fixed
- **Deep Startup Consolidation & Refactoring** (commits 3898ae0, a3df538, aeb6850, c33568c)
  - **Problem**: CLI and PM2 startup paths had diverged into 100+ lines of duplicated, inconsistent logic, increasing maintenance burden and race condition risk.
  - **Solution**: Extracted shared logic into unified private methods:
    - `_executeStartupGridSequence()`: Centralized fund restoration, grid decision (resume/regenerate), and initial reconciliation.
    - `_initializeBootstrapPhase()`: Centralized AccountOrders setup, fill loading, and OrderManager creation.
    - `_resolveAccountId()`: Single source of truth for account resolution.
  - **Impact**: Guaranteed identical, hardened startup behavior across all entry points. Net reduction of ~200 lines of redundant code.

- **Startup Accounting Alignment (The "Fund Invariant" Fix)** (commit 64c7287)
  - **Problem**: When repurposing an on-chain order during startup, any reduction in size was "leaked" from internal tracking, causing a permanent discrepancy where `blockchainTotal > trackedTotal`.
  - **Solution**: Refactored `startup_reconcile.js` to use delta-based accounting.
    - Optimistically adds existing order size to `Free` balance before resizing.
    - Uses `skipAccounting: false` during synchronization to correctly deduct the new grid size.
  - **Impact**: Correctly tracks fund deltas (released or required) during startup, maintaining perfect 1:1 synchronization with blockchain totals.

- **Grid Resizing Performance & "Hang" Prevention** (commit 64c7287)
  - **Problem**: Modifying 300+ grid slots during rebalancing triggered a full fund recalculation and invariant check for *every single order*, causing massive log spam and process "hangs" during bootstrap.
  - **Solution**: Wrapped `Grid._updateOrdersForSide()` in `pauseFundRecalc()` and `resumeFundRecalc()` guards.
  - **Impact**: Fund totals are recalculated exactly once after the entire side is updated. Eliminates redundant processing and prevents logging-related performance degradation.

- **Earliest Phase Fill Capture** (commit a291f30)
  - **Problem**: Fills occurring during the few seconds of grid synchronization at startup could be missed or cause state collisions.
  - **Solution**: Moved `listenForFills` activation to the very beginning of the shared `_initializeBootstrapPhase()`.
  - **Hardening**: Fills arriving during setup are safely queued and only processed after the `isBootstrapping` flag is cleared and the startup lock is released.
  - **Impact**: Full capture of trading activity during any startup path (normal or reset).

- **Unified Grid Reset Logic** (commit 3898ae0)
  - **Problem**: Trigger-based resets used separate implementations for startup detection vs. runtime file watching.
  - **Solution**: Extracted shared regeneration logic into `_performGridReset()`.
  - **Impact**: Consistent behavior for config reloading, fund clearing, and trigger file removal across the entire bot lifecycle.

- **Phantom Orders Prevention with Defense-in-Depth** (commits c73e790, d36c180)
  - **Problem**: Orders could exist in ACTIVE/PARTIAL state without blockchain `orderId`, causing "doubled funds" warnings.
  - **Solution - Three Layer Defense**:
    1. **Primary Guard**: Centralized validation in `_updateOrder()` rejects ACTIVE/PARTIAL state without valid orderId.
    2. **Grid Protection**: Preserves order state during resizing instead of forcing ACTIVE.
    3. **Sync Cleanup**: Detects and converts nameless ACTIVE/PARTIAL orders to SPREAD placeholders.
  - **Impact**: Provides permanent protection against fund tracking corruption and high RMS divergence logs.

### Refactored
- **Strategy Logic Cleanup** (commit 3898ae0)
  - Simplified `countOrdersByType()` in `utils.js` by removing stale `pendingRotation` and `EffectiveActive` logic from older models.
- **Standardized Bootstrap Management** (commit 3898ae0)
  - Enforced formal `manager.startBootstrap()` and `finishBootstrap()` calls across all paths for consistent logging and invariant suppression.
- **Utils Module Organization** (commit 0e5e9e7)
  - Reorganized utils.js sections to match Table of Contents.

### Updated Documentation
- **PM2 Documentation** (commit a47ddbf)
  - Updated README to clarify PM2 orchestration and trigger detection for running bots.
- **Architecture & Developer Guides** (commit 86261fc)
  - Added "Phantom Order Prevention" and "Hardened Startup Sequence" sections.

### Core Lines Changed
**Total: 7,317** (5,326 added, 1,991 removed) - Root and modules/*.js files only

### Core Lines Changed
**Total: 6,217** (3,872 added, 2,345 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.6] - 2026-01-22 - Accounting Hardening & Asset Neutrality

### Added
- **Automated Branch Synchronization Script** (commit 0d7dac0, 1596c93)
  - New `pmain` script for automated synchronization between `dev`, `test`, and `main` branches.
  - Ensures proper push order (test -> dev -> main) to maintain consistency.
- **Gitignore for Generated Documentation** (commit 6ccf2cc)
  - Automatically ignores generated HTML documentation files from the repository.

### Fixed
- **Critical Accounting Inconsistency & Double-Deduction** (commit 2deb9fc)
  - Fixed bugs in `startup_reconcile`, `grid.js`, and `sync_engine` where initial order states triggered redundant optimistic deductions.
  - Sanitized phantom order cleanup to use `skipAccounting` preventing tracked balance inflation.
- **Resync Order Duplication** (commit 8d65e0b)
  - Implemented delta-based balance checks during resync to prevent creating duplicate orders.
  - Fixed `ReferenceError` in reconciliation logic.
- **False Positive Fund Invariants** (commit 16f15c7)
  - Silenced spurious "Fund invariant violation" warnings during resync and startup phases.
- **Signature Mismatch in Order Updates** (commit 90b27fe, 518f9f8)
  - Corrected `_updateOrder` signature mismatches across modules.
  - Implemented `_isBroadcasting` flag for improved operation tracking.
- **Build/Update Script Robustness** (commit 4082646, 1dea7a4)
  - Fixed shell script errors ("integer expression expected") and relaxed merge history checks.
- **Resync Atomic Re-verification & Locking**
  - Added "Just-in-Time" state verification in `startup_reconcile.js` to abort double-placements after recovery syncs.
  - Wrapped startup synchronization in `dexbot_class.js` with `_fillProcessingLock` to serialize early fill notifications.
- **BTS Fee Accounting during Sync**
  - Fixed bug where BTS fees were skipped during resync; fees are now always tracked even when asset accounting is disabled.

### Refactored
- **Asset Neutrality (Generic Variable Names)** (commit fc3fa9f)
  - Refactored codebase to replace asset-specific variable names (e.g., `currentXrpBalance`) with generic alternatives.
  - Improves multi-asset support and reduces confusion when trading non-XRP pairs.
- **Integer-First Alignment (rawOnChain)** (commit 92f0701)
  - Modernized core logic to fully align with the `rawOnChain` integer-tracking model.
- **Fund Management Streamlining** (commit 83fca8e)
  - Simplified fund state management and reduced transient logging noise.

### Updated Documentation
- **Consolidated Fund Guide** (commit ab7789c, 6b2d826)
  - Merged and expanded fund accounting and movement documentation into a single authoritative guide.
- **Modernized Architecture & Testing Docs** (commit 0e8c623)
  - Updated technical documentation to reflect recent architectural shifts and testing procedures.

---

## [0.6.0-patch.5] - 2026-01-21 - Security, Performance & AMA Integration

### Added
- **Unix Socket Credential Daemon** (commit 75e9eed)
  - Eliminates security vulnerability where master passwords were exposed via `MASTER_PASSWORD` environment variables
  - Implements daemon pattern that authenticates once and serves decrypted private keys securely via JSON-RPC
  - Password kept in RAM only, never written to disk
- **High-Precision Dual-AMA Trend Detection** (commit 372167c)
  - Implements production-ready trend detection using fast/slow Adaptive Moving Averages
  - Features parameter optimization (6240+ configs), backtesting, and interactive chart generation
- **QTradeX Export Functionality** (commit e78d676)
  - New `dexbot export <bot-name>` command to generate backtesting-compatible CSV files
  - Automatically parses PM2 logs to extract trades, fees, and sanitized settings

### Fixed
- **'Active No ID' Grid Corruption** (commit b35946a)
  - Prevents writing corrupted state to disk by downgrading nameless orders to VIRTUAL
  - Added self-healing logic to sanitize existing corrupted files on load
  - Orders now transition to ACTIVE only after confirmed blockchain broadcast
- **BTS Fee Deduction Unification** (commit 160fa9a)
  - Fixed capital drift by applying fees to all on-chain operations (rotations, size updates)
  - Ensures internal ledger perfectly matches blockchain total balances
- **Startup Reconciliation Index Overflow** (commit fc3c31a)
  - Resolved array index overflow when syncing large numbers of orders during bootstrap
- **Excess Order Cancellation Sorting** (commit e941aba)
  - Fixed asymmetry in how excess orders were prioritized for cancellation during grid compression

### Optimized
- **Memory-Only Integer Tracking** (commit 94dd4fa)
  - Transitioned from query-driven to memory-driven model using `rawOnChain` integer cache
  - Eliminates redundant API fetches during rotations and size updates (O(1) local updates)
  - Significantly improves reaction time and reduces blockchain API load
- **Logging System Refactor** (commit b44a370)
  - Consolidated logging logic and reduced CLI verbosity for cleaner PM2 logs

### Updated Documentation
- **docs/ama_strategies_guide.md**
  - Added comprehensive guide for the three Adaptive Moving Average strategies
- **docs/memory_tracking.md**
  - Documented new integer-based memory tracking architecture

### Core Lines Changed
**Total: 8,443** (6,939 added, 1,504 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.4] - 2026-01-15 - Rotation Sizing Formula Fix

### Fixed
- **Rotation Sizing Formula** (commit 63cdb02)
  - Reverted back to grid-difference formula: `gridDifference = idealSize - destinationSize`
  - Previous "fund-neutral" formula incorrectly credited source order size against new order budget
  - **Problem:** sourceSize credit breaks accounting when fill proceeds are already in available funds via cacheFunds
  - **Impact:** Rotation sizing now correctly caps against actual available funds on the rebalance side
  - **Formula:** `finalSize = destinationSize + min(gridDifference, remainingAvail)`
  - **Key Insight:** Available funds already include fill proceeds, source order release is handled separately in fund accounting
  - **Tests:** All 24+ rotation and fund accounting tests pass ✓

### Core Lines Changed
**Total: 31** (14 added, 17 removed) - Root and modules/*.js files only

### Updated Documentation
- **docs/fund_movement_logic.md**
  - Added new section "Rotation Sizing Formula" with mathematical explanation
  - Documented the gridDifference formula and why it's correct
  - Clarified relationship between available funds and rotation capital allocation
  - Explained how fill accounting via cacheFunds integrates with rotation sizing

### Core Lines Changed
**Total: 4,899** (1,511 added, 3,388 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.3] - 2026-01-15 - Rotation Logic & Fund Update Atomicity

### Fixed
- **Buy Order Rotation Logic** (commit 182c43c)
  - Fixed `calculateAvailableFundsValue()` double-deduction of fill proceeds in available funds calculation
  - Removed redundant `inFlight` subtraction that was causing "Available = 0" even with capital present
  - **Impact:** Rotations were being skipped when capital was actually available
  - **Solution:** chainFree is already "optimistic" and accounts for pending orders; no need for separate inFlight tracking

- **Startup Fund Invariant Violations** (commit 182c43c)
  - Added `isBootstrapping` guard to `_verifyFundInvariants()` to prevent false warnings during initial sync
  - Invariants now only checked once bootstrap phase completes (`mgr.isBootstrapping === false`)
  - **Impact:** Eliminates spurious warnings that mask actual issues

### Added
- **Fill Accounting Processing** (commit 182c43c)
  - New `processFillAccounting()` method in Accountant for atomic pays/receives handling
  - Called from sync_engine when fills are detected
  - Ensures internal state stays synchronized with blockchain state

- **Priority-Based Fill Processing** (commit fe14898)
  - Implemented priority queue for fill processing during bootstrap phase
  - Prevents race conditions during initial synchronization

### Refactored
- **Fund Update Atomicity Documentation** (commit 55c2326)
  - Made atomic fund update sequence explicit with step-by-step comments in `rebalance()`
  - **Step 1:** Apply state transitions (reduces chainFree via updateOptimisticFreeBalance)
  - **Step 2:** Deduct cacheFunds (while pauseFundRecalc still active)
  - **Step 3:** Recalculate all funds (everything now in sync)
  - Improves maintainability by making it clear that all fund state is consistent before any calculation

### Core Lines Changed
**Total: 1,663** (769 added, 894 removed) - Root and modules/*.js files only

---

## [0.6.0-patch.2] - 2026-01-15 - Fund Accounting Fixes & Startup Optimization

### Fixed
- **Fund Accounting Double-Counting Bug** (commit 5b4fc2f)
  - Fixed `Grid.determineOrderSideByFunds()` incorrectly adding cacheFunds to available funds
  - **Issue:** cacheFunds is already part of chainFree; adding it again inflates available by 100%+
  - **Impact:** Spread correction would overestimate available capital, potentially leading to over-allocation
  - **Solution:** Use only `available` in fund ratio calculations; cacheFunds is a reporting metric, not a deduction
  - **Reference:** See `docs/fund_movement_logic.md` section 4 for corrected accounting model

- **Rotation State Transitions** (commit 5b4fc2f)
  - Fixed `strategy.js` to properly transition old rotated orders to `VIRTUAL` state with `size: 0`
  - Ensures orders are properly cleaned up during rebalancing without requiring blockchain sync
  - `sync_engine.js` safely handles orders already in VIRTUAL state

### Optimized
- **Startup Fill Processing Lock** (commit c7e7188)
  - Replaced heavy `_fillProcessingLock.acquire()` wrapper during entire startup (~1-5 seconds) with `isBootstrapping` flag
  - **Benefit:** Fills still queue safely but processing is deferred until bootstrap completes
  - **Result:** Eliminates lock contention while maintaining all TOCTOU race prevention
  - **Implementation:** Check `isBootstrapping` in fill consumer loop to skip processing during startup

### Updated Documentation
- **docs/fund_movement_logic.md**
  - Corrected Available Funds formula: removed cacheFunds subtraction
  - Added detailed explanation of fund components and their purpose
  - Clarified cacheFunds lifecycle: it's part of chainFree, not a separate deduction
  - Added new section 5.1 on Rotation State Management with examples
  - Includes code examples showing proper state transitions during rotation

### All Tests Pass ✓
- 25+ test suites including fund accounting, partial orders, and rotation scenarios
- Multi-fill opposite partial order tests verify rotation state transitions

### Core Lines Changed
**Total: 2,120** (1,166 added, 954 removed) - Root and modules/*.js files only

---

## [0.6.0] - 2026-01-04 - Physical Rail Strategy, Merge/Split Consolidation & Engine Modularization (Updated 2026-01-14)

### Commit Statistics (v0.5.1 → v0.6.0)
**Total Commits:** 230

| Type | Count | Percentage |
|------|-------|------------|
| **fix** | 99 | 43.0% |
| **refactor** | 49 | 21.3% |
| **feat** | 34 | 14.8% |
| **docs** | 28 | 12.2% |
| **test** | 8 | 3.5% |
| **cleanup** | 8 | 3.5% |
| **style** | 4 | 1.7% |
| **chore** | 5 | 2.2% |

### Theme Breakdown
| Theme | Count | Description |
|-------|-------|-------------|
| **Grid/Spread/Order/Rotation** | 76 | Grid management, order placement, rotations |
| **Fund/Capital/Budget/Wallet** | 31 | Fund management, budgeting, capital cycling |
| **Concurrency/Race/Lock** | 16 | Race conditions, locking, concurrency safety |
| **Precision/Asset/Fee** | 19 | Asset precision, fee handling, validation |

### Added
- **Contiguous Physical Rail Strategy**: A major architectural evolution where the grid is treated as a solid "rail" of orders.
  - Ensures contiguous order placement without gaps.
  - Moves the entire rail physically with market price changes.
  - Significantly improves stability during high-volatility events.
- **MERGE vs SPLIT Consolidation**: Advanced decision logic for handling partial orders:
  - **MERGE (Dust)**: Tiny partials (< 5%) are absorbed and refilled with new capital to restore their full ideal size.
  - **SPLIT (Substantial)**: Larger partials are cleanly split, keeping the filled portion active on-chain while managing the remainder as a new virtual order.
- **Complete Constants Centralization**: Consolidated 60+ hardcoded magic numbers into a single source of truth
    - **New Constants Sections**:
      - `INCREMENT_BOUNDS`: Grid increment percentage bounds (0.01% - 10%)
      - `FEE_PARAMETERS`: BTS fee reservation multiplier (5), fallback fee (100), **maker refund ratio (10%)**
      - `API_LIMITS`: Pool batch size (100), scan batches (100), orderbook depth (5), limit orders batch (100)
      - `FILL_PROCESSING`: Fill mode ('history'), operation type (4), taker indicator (0)
      - `MAINTENANCE`: Cleanup probability (0.1)
      - **Note**: Bot requires asset precision metadata for all trading pairs. Without precision, the bot cannot safely calculate order sizes and will not operate.
   - **Note**: Asset precision fallback removed - bot now enforces strict precision requirements and fails loudly if asset metadata is unavailable
   - **Grid Constants Additions**:
     - `MIN_SPREAD_ORDERS`: Minimum number of spread orders (2)
     - `SPREAD_WIDENING_MULTIPLIER`: Buffer multiplier for spread condition threshold (1.5)
   - **Impact**: Eliminates scattered magic numbers across 10 files, improves maintainability and consistency

- **Enhanced Settings Configuration**:
  - Split `TIMING` configuration menu into two clear sections:
    - **Timing (Core)**: Fetch interval, sync delay, lock timeout
    - **Timing (Fill)**: Dedup window, cleanup interval, record retention
  - `EXPERT` section support for advanced settings (accessible via JSON-only, not menu)

- **Specialized Engine Architecture**: Modularized OrderManager into three focused engines
  - **Accountant Engine** (`accounting.js`): Fund tracking, invariant verification, fee management
  - **Strategy Engine** (`strategy.js`): Now implements the **Physical Rail** and **Unified Rebalancing** logic.
  - **Sync Engine** (`sync_engine.js`): Blockchain reconciliation and fill processing

- **Optimized Grid Diagnostics**: Added `logGridDiagnostics` to `Logger` providing a color-coded visualization of the grid.
- **Fund Invariant Verification System**: Automatic detection of fund accounting leaks with configurable tolerance.
- **Order Index Validation Method**: Defensive `validateIndices()` method for debugging index corruption.
- **Metrics Tracking System**: Enhanced observability with `getMetrics()` for production monitoring.

### Fixed (99 commits)
**Grid & Order Management (26 fixes)**
- Disable dynamic spread check during fill-replacement rotations to prevent conflicts
- Remove proactive spread correction from fill-processing loop
- Relax grid health check to support edge-first placement strategy
- Unify grid sizing budget, resolve botFunds % inconsistency and fee accounting
- Resolve budget double-counting in divergence check and align fund docs
- Apply full grid regeneration for divergence corrections to prevent Frankenstein grids
- Implement selective filtering strategy for order size updates to prevent fund leaks
- Resolve grid side update crash and improve cacheFunds accounting
- Improve spread correction and fix fill queue test logic
- Resolve 7 critical issues in strategy rebalancing
- Resolve 10 critical issues in strategy and grid rebalancing logic
- Prevent double dust partial creation
- Resolve placement and partial order handling in rebalancing
- Cap placements and refactor strategy helper methods
- Force reload persisted grid during divergence checks to ensure fresh data
- Ensure rotations complete after divergence correction instead of skipping
- Restore reverse parameter for BUY side allocation
- Correct fund validation for precision and update deltas
- Persist boundaryIdx and stabilize grid rebalancing logic
- Handle missing rotation orders and partial fills properly
- Resolve 4 critical issues in grid.js spread correction and locking
- Prevent race conditions in spread correction and grid startup
- Correct buy order sort order in Grid.checkGridHealth
- Restore minimum order size warning and refine rounding safety
- Finalize hardening with robust spread counting and rounding safety
- Ensure contiguous starting grid in startup_reconcile

**Fund Management (18 fixes)**
- Resolve fund inflation, precision handling, and align divergence check ideals
- Improve budget calculation and remove double-counting optimistic updates
- Preserve cacheFunds across rebalance cycles instead of recalculating
- Resolve ghost sizes and implement partial rotation priority during rebalancing
- Revert dust detection to dual-side (AND) logic
- Implement startup dual-dust check and harden index management
- Simplify fund distribution and stabilize active order sizes
- Resolve fund accounting leaks and excess order creation
- Fix high available funds and duplicate cleanup
- Resolve cacheFunds double-counting and prevent accounting errors
- Fix BTS fee over-reservation and implement Greedy Crawl rotations
- Resolve double BTS fee deduction in order sizing
- Restore btsFeesReservation to available funds calculation
- Refine fund tracking accuracy across rotation cycles
- Improve fund accuracy and reduce logging noise
- Add pre-flight fund validation before batch broadcast
- Restore is_maker filter and align dust detection budget calculation

**Concurrency & Race Conditions (16 fixes)**
- Resolve 4 critical cross-file issues with locking and graceful shutdown
- Fix security and error handling issues in pm2.js
- Fix 5 critical error handling issues in dexbot
- Fix race condition in waitForAccountTotals and SPREAD order tracking
- Prevent lock deadlocks in syncFromFillHistory() by adding nested try/finally blocks
- Eliminate 12 critical race conditions and concurrency issues in fill processing
- Fix concurrency issues and code quality in dexbot_class.js
- Resolve 6 race conditions and bugs in sync_engine.js
- Prevent race condition in waitForAccountTotals with concurrent calls
- Eliminate 9 race conditions in grid.js for production safety
- Restore fill listener activation BEFORE grid operations
- Implement strict trigger-based rebalancing and partial anchoring
- Improve code style and lock atomicity
- Add locking and precision improvements for concurrent safety
- Address 6 critical issues from code review
- Implement 9 critical bug fixes and improvements

**Precision & Fees (19 fixes)**
- Implement fail-fast logic for asset precision and strengthen tolerance checks
- Prevent and repair grid corruption caused by fake orderIds
- Remove precision fallback defaults - halt bot if precision unavailable
- Remove unused PRECISION_DEFAULTS constant and implement graceful halt on missing asset precision
- Correct precision calculation and order reconciliation logic
- Add await to async Grid.compareGrids() calls and improve error handling
- Account for both market and blockchain taker fees in fill processing
- Handle PARTIAL orders in fund summation (critical)
- Correct order type case matching in proceeds calculation
- Use filledOrder.type directly instead of undefined variable
- Restore market fee logic and physical role synchronization in StrategyEngine
- Cleanup magic numbers and finalize fund naming consistency
- Implement 6 Opus recommendations for robustness and observability
- Properly restore order states in ghost virtualization and refine validation
- Crash fix: correct method call updateAccountTotals to fetchAccountTotals
- Fix crash in grid resync by correcting method calls
- Remove null bytes from account_bots.js to fix encoding issues
- Add null/NaN guards and return values to addToChainFree
- Resolve 3 bugs in startup_reconcile.js (state comparison, array slicing, parameter validation)

**Strategy & Rebalancing (8 fixes)**
- Resolve critical strategy engine issues with state consistency and performance
- Apply 5 defensive fixes to Physical Rail Strategy
- Remove excessive maintenance resizing of active orders
- Implement strict trigger-based rebalancing and partial anchoring
- Restore grid.js functionality and improve bot stability
- Hardening strategy logic with transactional updates and safety checks
- Fix 8 critical and medium-priority bugs in manager.js and grid.js
- Implement side-wide double-order strategy for dust merges

**Error Handling & Validation (12 fixes)**
- Resolve critical issues in bot.js initialization and error handling
- Fix initialization and startup validation issues
- Improve general settings UI and input validation
- Silence transient warnings and prevent cacheFunds double-counting
- Only log divergence breakdown when exceeding regeneration threshold
- Process filled orders found during periodic and startup sync
- Implement strict trigger-based rebalancing
- Maintain ACTIVE state for DoubleOrders until below 100% size
- Finalize SPREAD and ACTIVE state management
- Add missing _persistWithRetry method to OrderManager
- Disable non-existent get_liquidity_pool_by_asset_ids direct lookup
- Remove legacy-testing-migration.md file

### Refactored (49 commits)
**Architecture & Modularization**
- Complete OrderManager modularization into specialized engines
- Extract strategy engine and finalize anchored multi-partial logic
- Extract strategy engine and finalize multi-partial consolidation
- Extract accounting logic and refine state transitions
- Improve dexbot_class architecture and consolidate grid checking logic
- Cleanup and stability improvements for physical rail strategy
- Contiguous physical Rail Strategy with Constant Spread
- Unified Rebalancing with explicit Physical Shift and Surplus Management

**Code Cleanup & Simplification**
- Remove 16+ unused functions and dead code modules
- Consolidate duplicate bot entry and authentication functions
- Remove emptyResult: inline factory method for result object
- Remove isExcluded: inline simple exclusion check
- Remove _recordStateTransition: dead metrics tracking code
- Remove checkSizesNearMinimum: inline wrapper for warning check
- Remove mapOrderSizes: inline thin wrapper function
- Remove getCachedFees function - getAssetFees is the preferred interface
- Remove checkPriceWithinTolerance wrapper function
- Remove assertIsHumanReadableFloat function
- Inline isRelativeMultiplierString and parseRelativeMultiplierString into resolveRelativePrice
- Remove onConnected: unused callback-based connection API
- Prune redundant passthrough methods in OrderManager
- Remove legacy code and deprecated fund management functions
- Final cleanup of legacy functions and storage logic
- Cleanup: Prune legacy/unused code from root scripts and update package.json

**Grid & Strategy Logic**
- Simplify strategy.js structure and fix partial order handling
- Simplify order validation with strict max order size constraint
- Optimize batch processing and remove unsafe interrupt logic
- Simplify rebalanceSideRobust logic and update tests
- Simplify rebalanceSideRobust algorithm documentation and implementation
- Simplify spread activation with sequential order placement
- Simplify updater schedule to interval/time in bot editor
- Simplify and standardize utils.js order subsystem utilities
- Simplify order type check to match main branch
- Remove redundant case conversion in runner.js

**Utilities & Formatting**
- Centralize numeric formatting to eliminate .toFixed() duplication
- Organize grid.js and utils.js into clear functional sections
- Eliminate duplicate gap calculation in rebalance
- Refine anchoring rules and revert rotation sorting
- Move legacy testing functions to dedicated module
- Final cleanup of legacy code and redundant logic across modules
- Consolidate persistence and cleanup ghost logic since 57f408c
- Clean up unused virtual order extraction in calculateSpreadFromOrders call
- Refactor tests to use modern StrategyEngine and remove legacy-testing.js

### Changed
- **Spread Zone Boundaries**: Implemented strict price boundaries (`highestActiveBuy < price < lowestActiveSell`) for rotations.
- **Rotation Selection Priority**: Refined selection logic to prioritize the lowest SPREAD slot for BUY rotations and highest for SELL.
- **Log Verbosity Control**: Silenced high-frequency logs in standard `info` mode.
- **Architecture**: Refactored OrderManager to delegate to specialized engines (Accountant, Strategy, Sync).
- **Fund Calculation Flow**: Optimized to walk active/partial orders using indices for performance.
- **State Transition Validation**: Enhanced state machine enforcement with logging and input validation.
- **Batch Fund Recalculation**: Pause/resume mechanism for multi-order operations with depth counter.
- **Updater Schedule**: Changed timing units to seconds for UI display, simplified to interval/time configuration.

### Documentation (28 commits)
- Update and standardize JSDoc documentation across modules
- Update and standardize JSDoc for root scripts (bot.js, dexbot.js, pm2.js)
- Add JSDoc headers to strategy.js methods
- Add comprehensive architecture and developer documentation
- Add comprehensive technical report on fund movement architecture
- Comprehensive documentation for order management system
- Add comprehensive code review report
- Update Features section: remove duplication and add current capabilities
- Update readme.md to reflect new update routine
- Enhance scripts/README.md with terminal-focused documentation and wrappers
- Add scripts/README.md documentation
- Update tests/README.md with comprehensive test list
- Update tests/README.md with test_market_scenarios.js entry
- Consolidate documentation and remove redundant files
- Update CHANGELOG for documentation improvements
- Enhance workflow documentation with comprehensive guide and troubleshooting
- Add development context and move workflow documentation
- Update README to reflect updated configuration approach
- Fix available funds formula documentation inconsistencies
- Update changelog for constants centralization in v0.6.0
- Document code review fixes in v0.5.2 changelog

### Testing (8 commits)
- Add comprehensive unit tests and quality improvements to order subsystem
- Add comprehensive engine integration tests
- Optimize test suite and fix fee accounting and grid sorting logic
- Update partial order tests for STEP 2.5 in-place handling
- Add Scenario 4 (Partial Handling) to market scenarios test
- Refactor tests to use modern StrategyEngine and remove legacy-testing.js
- Add high-priority documentation and sliding window transition tests
- Integrate fund calculation testing and recent bugfix coverage

### Cleanup (8 commits)
- Delete test_output directory and artifacts
- Remove temporary test artifacts and ignore tests/tmp/ directory
- Final cleanup of legacy functions and storage logic
- Remove Jest from production and clean up configuration
- Minor account_bots line formatting
- Add .gemini to gitignore and remove from git tracking
- Consolidate test improvements into dev branch

### Style (4 commits)
- Unify updater branch color in general settings menu
- Color-code branch and schedule options in CLI with improved readability
- Match general settings menu colors to account_bots editor
- Update bot editor color scheme for better readability and retro vibe

### Technical Details
- **Physical Rail Logic**: The strategy now calculates a "rail" of ideal prices and maps existing orders to these physical slots, ensuring continuity.
- **Ghost Virtualization**: Safely processes multiple partials by temporarily marking them as VIRTUAL during consolidation.
- **Atomic Fund Operations**: Uses `tryDeductFromChainFree()` pattern to prevent TOCTOU race conditions.
- **Fund Invariant Tolerance**: Dual-mode tolerance (Precision Slack + Percentage) for robust invariant checking.

### Performance Impact
- **Faster Fund Calculation**: Uses indices instead of walking all orders.
- **Batch Operations**: Pause/resume mechanism eliminates redundant recalculations.
- **Lock Refresh**: Prevents timeout during long reconciliation cycles.

### Testing
- All core tests passing (230 commits validated).
- New coverage for sliding window transitions and physical rail logic.
- Comprehensive engine integration tests with 99 bug fixes verified.
- Unit tests for order subsystem with quality improvements.
- Market scenarios test with Scenario 4 (Partial Handling).
- Fund calculation testing integrated with bugfix coverage.
- Test suite optimized with fee accounting and grid sorting logic fixes.

### Migration
- **No Breaking Changes**: Fully backward compatible with existing bots.
- **Automatic Initialization**: Legacy bots automatically migrate to new architecture.

---

- **Null Safety Hardening** (accounting.js, grid.js)
  - Added optional chaining (`?.`) to all manager.logger.log() calls
  - Protected manager._metrics access to prevent crashes if metrics uninitialized
  - Prevents runtime errors in edge cases where logger or metrics are null

- **Price Correction Lock Protection** (utils.js)
  - Price correction operations now acquire AsyncLock before modifying order state
  - Ensures lock is released via finally block even if correction operation fails
  - Prevents concurrent mutations during price correction snapshots
  - Note: Spread correction (grid.js) currently does not acquire locks before fund deduction - potential race condition for future improvement

### Changed
- **Architecture**: Refactored OrderManager to delegate to specialized engines
  - Manager now coordinates three engines instead of implementing all logic
  - Delegation methods maintain backward compatibility
  - Cleaner separation of concerns improves maintainability

- **Fund Calculation Flow**:
  - Walk active/partial orders (not all orders) for better performance
  - Indices (_ordersByState, _ordersByType) used for faster iteration
  - Dynamic precision-based slack for rounding tolerance

- **State Transition Validation**: Enhanced state machine enforcement
  - State transitions now logged and tracked for metrics
  - Input validation prevents invalid order states from corrupting grid
  - Proper handling of undefined intermediate states

- **Batch Fund Recalculation**: Pause/resume mechanism for multi-order operations
  - `pauseFundRecalc()` / `resumeFundRecalc()` with depth counter
  - Supports safe nesting for complex operations
  - Avoids redundant recalculations during batch updates

### Technical Details
- **Ghost Virtualization**: Safely process multiple partials without blocking each other
  - Temporarily mark partials as VIRTUAL during consolidation
  - Enables accurate target slot calculations
  - Automatic restoration with batch fund recalc to keep indices in sync
  - Error safety: try/catch ensures partial rollback on failure

- **Atomic Fund Operations**: Prevention of TOCTOU race conditions
  - `tryDeductFromChainFree()`: Atomic check-and-deduct pattern
  - Guards against race where multiple operations check same balance
  - Returns false if insufficient funds, preventing negative balances

- **Fund Invariant Tolerance**: Dual-mode tolerance for rounding noise
  - **Precision Slack**: 2 × 10^(-precision) units (e.g., 0.00000002 for 8-decimal assets)
  - **Percentage Tolerance**: 0.1% of chain total (default, configurable)
  - Uses maximum of both tolerances for flexibility

### Performance Impact
- **Faster Fund Calculation**: Uses indices instead of walking all orders (~3-10× faster for large grids)
- **Grid Lookup Optimization**: O(1) slotmap-based lookups instead of O(n) findIndex (~50× faster for large grids)
- **Batch Operations**: Pause/resume eliminates redundant recalculations
- **Lock Refresh**: Prevents timeout during long reconciliation (~5 second refresh cycles)
- **Fund Snapshot Capture**: Negligible overhead (<1ms per snapshot) despite comprehensive audit trail

### Summary Statistics

**Total Commits:** 230 commits analyzed and documented
- 99 bug fixes (43%) covering grid, funds, concurrency, precision, and strategy
- 49 refactor commits (21%) improving architecture and code quality
- 34 feature additions (15%) including new strategies and UI improvements
- 28 documentation updates (12%) enhancing developer experience
- 8 test improvements (3.5%) with comprehensive coverage
- 8 cleanup operations (3.5%) removing legacy code
- 4 style improvements (1.7%) for better code readability
- 5 chore updates (2.2%) for maintenance tasks

**Critical Focus Areas:**
- Grid & Order Management: 76 commits
- Fund Management: 31 commits
- Concurrency Safety: 16 commits
- Precision & Fees: 19 commits

**Quality Metrics:**
- All tests passing ✅
- 99 bug fixes validated across 6 categories
- 49 refactor commits improving maintainability
- Extensive documentation (28 commits) for long-term sustainability

---

## [0.5.1] - 2026-01-01 - Anchor & Refill Strategy, Precision Quantization & Operational Robustness

### Added
- **Anchor & Refill Strategy**: Major architectural upgrade for partial order handling. Instead of moving partials, the bot now anchors them in place.
  - **Case A: Merged Refill (Dust)**: Merges dust (< 5%) into the next geometric allocation and delays the opposite-side rotation until the dust portion is filled.
  - **Case B: Full Anchor (Substantial)**: Upgrades partials (>= 5%) to 100% ideal size and places the leftover capital as a residual order at the spread.
- **On-Chain Alignment for Refills**: The bot now broadcasts `limit_order_update` for dust refills to ensure on-chain sizes perfectly match the merged internal allocation.
- **Cumulative Fill Tracking**: Added `filledSinceRefill` property to accurately trigger delayed rotations across multiple partial fills.
- **Precision Quantization**: Implemented size quantization to exact blockchain precision before order placement, eliminating float rounding errors.
- **Pending-Aware Health Checks**: Updated `countOrdersByType` and `checkGridHealth` to recognize intentional gaps created by delayed rotations, preventing false-positive corrections.
- **Double-Aware Divergence Engine**: Updated `calculateGridSideDivergenceMetric` to account for merged dust sizes, preventing unnecessary grid resets for anchored orders.
- **Periodic Order Synchronization**: Added `readOpenOrders` to the 4-hour periodic fetch to automatically reconcile the internal grid with the blockchain source of truth.
- **Modernized Test Suite**: Added comprehensive unit, integration, and E2E tests for the Anchor & Refill strategy and precision fixes.

### Changed
- **Pipeline-Aware Monitoring**: `checkGridHealth` now only executes when the order pipeline is clear (no pending fills or corrections), increasing operational stability.
- **Memory-Chain Alignment**: Quantized order sizes are synchronized back to the internal memory state to ensure 1:1 parity with blockchain integers.
- **State Persistence**: Added full serialization for new strategy fields (`isDoubleOrder`, `mergedDustSize`, `pendingRotation`, `filledSinceRefill`).

### Fixed
- **Sync Reversion Protection**: Prevented the bot from prematurely reverting merged sizes back to old on-chain sizes during synchronization gaps.
- **Off-by-One Eradication**: Fixed a recurring issue where small float remainders would block grid flow or cause spurious partial-state transitions.
- **Race Condition Handling**: Improved observability and lock management in `dexbot_class.js` to ensure sequential consistency during high-volume fill events.

---

## [0.5.0] - 2025-12-31 - Stability Milestone: Global Terminology Migration, General Settings & Grid Health

### Added
- **Persistent General Settings**: Implemented a new architecture using `profiles/general.settings.json` for untracked user overrides.
- **Global Settings Manager**: Added a new sub-menu to `dexbot bots` to manage global parameters (Log lvl, Grid, Timing).
- **Grid Health Monitoring**: New system to monitor structural grid integrity and log violations (e.g., ACTIVE orders further from market than VIRTUAL slots).
- **Dual-Side Dust Recovery**: Automatically refills small partial orders (< 5%) to ideal geometric sizes using `cacheFunds` when detected on both sides.
- **Enhanced Spread Correction**: Implemented proactive spread correction that pools both `VIRTUAL` and `SPREAD` slots to identify the best candidates for narrowing the market spread.
- **Sequential Fill Queue**: Implemented thread-safe sequential processing of fill events using AsyncLock to prevent accounting race conditions.
- **Safe PM2 Lifecycle Management**: Added `pm2.js stop` and `pm2.js delete` commands that safely filter for dexbot-specific processes.
- **Robust Fill Detection**: Implemented `history` mode for fill processing to reliably match orders from blockchain events.

### Changed
- **Global Terminology Migration**: Renamed all occurrences of `marketPrice` to `startPrice` across codebase, CLI, and documentation to better reflect its role as the grid center.
- **Menu-Driven Bot Editor**: Refactored `modules/account_bots.js` into a sectional, menu-driven interface for faster configuration.
- **Simplified Update Process**: Removed fragile git stashing from `update.sh` and `update-dev.sh`; user settings are now preserved via untracked JSON.
- **CLI Command Renaming**: Renamed `dexbot stop` to `dexbot disable` for better alignment with its actual function (marking bots inactive in config).
- **Price Calculation Accuracy**: Updated `buildUpdateOrderOp` to use current sell amounts when deriving prices, fixing precision issues in small price moves.
- **Default Log Level**: Changed default `LOG_LEVEL` from `debug` to `info`.
- **Architectural Cleanup**: Consolidated core logic into pure utility functions to eliminate duplication and improve maintainability.

### Fixed
- **Fund Double-Counting**: Fixed a critical bug in `processFilledOrders` where proceeds were incorrectly added to available funds twice.
- **Startup Double-Initialization**: Resolved a race condition that could cause corrupted virtual order sizes during bot startup.
- **Reset Reliability**: Fixed `node dexbot reset` command to ensure a true hard reset from blockchain state, including hot-reloading of `bots.json`.
- **Stuck VIRTUAL Orders**: Added error handling for rotation synchronization to prevent orders from being stuck in a virtual state.
- **Logging Visibility**: Ensured all cancellation operations provide explicit success/fail messages in logs.
- **Offline Detection Fixes**: Resolved edge cases in offline partial fill detection to ensure capital efficiency on startup.
- **Update Script Robustness**: Refactored update scripts to use `git reset --hard` to forcefully clear environment conflicts (e.g., in `constants.js`).
- **Module Path Corrections**: Fixed incorrect relative paths in `startup_reconcile.js` and streamlined operational logging.

---

**Note on v0.4.6**: This version includes a backported critical cacheFunds double-counting fix that was originally released in v0.4.7, then retagged to v0.4.6 for proper patch versioning. v0.4.7 release was deleted. Users should upgrade to v0.4.6 to fix the 649.72 BTS discrepancy issue.

---

## [0.4.6] - 2025-12-28 - CacheFunds Double-Counting Fix, Fill Deduplication & Race Condition Prevention

### Fixed

#### 1. CRITICAL: CacheFunds Double-Counting in Partial Fills
- **Location**: `modules/order/manager.js` lines 570-596, 1618-1625
- **Problem**: Proceeds being counted twice in `cacheFunds` balance
  - When partial fill occurred, proceeds added to `chainFree` (buyFree/sellFree)
  - Then `available` recalculated from **updated** chainFree (which already included proceeds)
  - Both `proceeds + available` added to cacheFunds → **double-counting**
- **Impact**: User reported 649.72 BTS discrepancy in fund accounting
- **Bug Timeline**: Introduced in v0.4.0 with fund consolidation refactor, present through v0.4.5
- **Solution**:
  1. Calculate available BEFORE updating chainFree (lines 570-576)
  2. Update chainFree with proceeds (lines 578-610)
  3. Store pre-update available in `this._preFillAvailable` (line 596)
  4. Use stored value in `processFilledOrders()` (lines 1618-1625)
- **Result**: Proceeds counted exactly once while preserving fund cycling feature for new deposits

#### 2. CRITICAL: Fee Double-Deduction After Bot Restart
- **Location**: `modules/account_orders.js` lines 427-551, `modules/dexbot_class.js` lines 42-48, 77-251, 652-660
- **Problem**: Permanent fund loss on bot restart during fill processing
  - When bot restarts, same fills detected again from blockchain history
  - `processFilledOrders()` called twice with identical fills
  - BTS fees double-deducted from cacheFunds
- **Impact**: Every bot restart during active trading could lose funds (fees permanently deducted twice)
- **Solution**: Persistent fill ID deduplication with multi-layer protection
  - **In-Memory Layer (5 second window)**:
    - Fill key: `${orderId}:${blockNum}:${historyId}`
    - Prevents immediate reprocessing within 5 seconds
    - Location: `dexbot_class.js` lines 100-114
  - **Persistent Layer (1 hour window)**:
    - Saves processed fill IDs to disk after each batch
    - Loads persisted fills on startup to restore dedup memory
    - Prevents reprocessing across bot restarts
    - Locations: `dexbot_class.js` lines 222-235 (save), 652-660 (load)
  - **Automatic Cleanup**:
    - Runs ~10% of batches to minimize I/O overhead
    - Removes entries older than 1 hour to prevent unbounded growth
    - Location: `dexbot_class.js` lines 237-245
  - **Persistence Methods** (`account_orders.js` lines 427-551):
    - `loadProcessedFills()`: Load fill dedup map from disk
    - `updateProcessedFillsBatch()`: Efficiently save multiple fills
    - `cleanOldProcessedFills()`: Remove old entries
    - All protected by AsyncLock to prevent race conditions
- **Storage Format** (in `profiles/orders/{botKey}.json`):
  ```json
  {
    "bots": {
      "botkey": {
        "processedFills": {
          "1.7.12345:67890:hist123": 1703808000000,
          "1.7.12346:67891:hist124": 1703808005000
        }
      }
    }
  }
  ```
- **Defensive Impact**: Protects entire fill pipeline, not just fees
  - Prevents committed funds from being recalculated twice
  - Prevents fund cycling from being triggered twice
  - Prevents grid rebalancing from being triggered twice
  - Prevents order status changes from being processed twice

#### 3. 20+ Race Conditions: TOCTOU & Concurrent Access

**Overview**: Comprehensive race condition prevention using AsyncLock pattern with 7 lock instances protecting critical sections.

**A. File Persistence Races** (`account_orders.js`)
- **Problem**: Process A reads file → Process B writes update → Process A overwrites with stale data
- **Fix**: Persistence Lock + Reload-Before-Write Pattern
  - Lock: `_persistenceLock` (line 104)
  - Protected methods:
    - `storeMasterGrid()` (lines 275-278): Reload before writing grid snapshot
    - `updateCacheFunds()` (line 366): Reload before updating cache
    - `updateBtsFeesOwed()` (line 416): Reload before updating fees
    - `ensureBotEntries()` (line 152): Reload before ensuring entries
    - `updateProcessedFillsBatch()` (line 460): Reload before batch save
  - Pattern: Always reload from disk immediately before writing to prevent stale data overwrites

**B. Account Subscription Management Races** (`chain_orders.js`)
- **Problem**: Multiple concurrent calls to `listenForFills()` could create duplicate subscriptions
- **Fix**: Subscription Lock (line 37)
  - Protected operations:
    - `_ensureAccountSubscriber()` (line 174): Atomic subscription creation
    - `listenForFills()` (line 339): Atomic callback registration
    - Unsubscribe (line 349): Atomic callback removal
  - Result: Prevents duplicate subscriptions, ensures atomic add/remove of callbacks

**C. Account Resolution Cache Races** (`chain_orders.js`)
- **Problem**: Concurrent account name/ID resolutions could race in cache updates
- **Fix**: Resolution Lock (line 39)
  - Protected operations:
    - `resolveAccountName()` (line 103): Atomic name resolution with cache
    - `resolveAccountId()` (line 140): Atomic ID resolution with cache
  - Result: Ensures atomic cache check-and-set for account resolution

**D. Preferred Account State Races** (`chain_orders.js`)
- **Problem**: Global variables `preferredAccountId` and `preferredAccountName` accessed without synchronization
- **Fix**: Preferred Account Lock (line 38)
  - Warning comment (lines 64-65): "Access MUST be protected by _preferredAccountLock to prevent race conditions"
  - Protected operations:
    - `setPreferredAccount()` (line 76): Atomic state update
    - `getPreferredAccount()` (line 87): Thread-safe read
  - Result: All access goes through thread-safe getters/setters

**E. Fill Processing Races** (`dexbot_class.js`)
- **Problem**: Multiple fill events arriving simultaneously could interleave during processing
- **Fix**: Fill Processing Lock (line 47)
  - Protected operations:
    - Fill callback (line 83): Main fill event handler
    - Triggered resync (line 892): Resync when no rotation occurs
    - Order manager loop (line 961): Catch missed fills
  - Protected workflow:
    - Filter and deduplicate fills
    - Sync and collect filled orders
    - Handle price corrections
    - Batch rebalance and execution
    - Persist processed fills
  - Result: All fill processing serialized, preventing concurrent state modifications

**F. Divergence Correction Races** (`dexbot_class.js`)
- **Problem**: Concurrent divergence corrections could modify grid state simultaneously
- **Fix**: Divergence Lock (line 48)
  - Protected operations:
    - Post-rotation divergence (line 191): Divergence check after rotation
    - Timer-based divergence (line 1017): Periodic divergence check
  - Guard check (line 569): Skip divergence if lock already held (prevents queue buildup)
  - Result: Grid updates serialized, prevents concurrent modification conflicts

**G. Order Corrections List Races** (`manager.js`)
- **Problem**: Shared array `ordersNeedingPriceCorrection` accessed by multiple functions
- **Fix**: Corrections Lock (line 140)
  - Status: Declared and prepared for active use
  - Array accessed at: Lines 138, 843, 879, 1174, 1286, 1292, 1300, 1723, 1726, 2005, 2012
  - Result: Foundation laid for serialized price correction handling

**AsyncLock Summary Table**:

| Lock Instance | File | Protected Operations | Purpose |
|--------------|------|----------------------|---------|
| `_persistenceLock` | account_orders.js | storeMasterGrid, updateCacheFunds, updateBtsFeesOwed, ensureBotEntries, processedFills methods | File I/O synchronization, prevent stale data overwrites |
| `_subscriptionLock` | chain_orders.js | _ensureAccountSubscriber, listenForFills, unsubscribe | Account subscription management, prevent duplicate subscriptions |
| `_preferredAccountLock` | chain_orders.js | setPreferredAccount, getPreferredAccount | Preferred account state synchronization |
| `_resolutionLock` | chain_orders.js | resolveAccountName, resolveAccountId | Account resolution cache atomic updates |
| `_fillProcessingLock` | dexbot_class.js | Fill callback, triggered resync, order manager loop | Fill event processing serialization |
| `_divergenceLock` | dexbot_class.js | Post-rotation divergence, timer-based divergence | Divergence correction synchronization |
| `_correctionsLock` | manager.js | ordersNeedingPriceCorrection mutations | Price correction list synchronization (prepared) |

### Added
- **AsyncLock Utility**: New queue-based mutual exclusion system (modules/order/async_lock.js)
  - FIFO queue-based synchronization for async operations
  - Prevents concurrent operations from interfering with critical sections
  - Proper error handling and re-throwing
  - Used to protect all critical sections across codebase

- **Fresh Data Reload on Write**: All write operations reload from disk before persisting
  - `storeMasterGrid()`: Reloads before writing grid snapshot
  - `updateCacheFunds()`: Always reload to prevent stale data overwrites
  - `updateBtsFeesOwed()`: Always reload to ensure fresh state
  - Fixes race between processes where stale in-memory data overwrites fresh state

- **forceReload Option**: Added to all load methods for explicit fresh data reads
  - `loadBotGrid(botKey, forceReload)`: Optional fresh disk read
  - `loadCacheFunds(botKey, forceReload)`: Optional fresh disk read
  - `loadBtsFeesOwed(botKey, forceReload)`: Optional fresh disk read
  - `getDBAssetBalances(botKeyOrName, forceReload)`: Optional fresh disk read

### Changed
- **Per-Bot File Architecture**: Now protected with AsyncLock for safe concurrent writes
  - Existing per-bot mode (each bot has own file: `profiles/orders/{botKey}.json`) now race-safe
  - `_persistenceLock` serializes all write operations to prevent TOCTOU races
  - `ensureBotEntries()` now async with lock protection
  - Per-bot subscriptions and resolution cache also protected
  - Legacy shared mode still supported for backward compatibility

- **AsyncLock Patterns**: Multiple lock instances for different critical sections
  - `_fillProcessingLock`: Serializes fill event processing in dexbot_class
  - `_divergenceLock`: Protects divergence correction operations
  - `_correctionsLock`: Protects ordersNeedingPriceCorrection in manager
  - `_persistenceLock`: Protects file I/O operations in account_orders
  - `_subscriptionLock`: Protects accountSubscriptions map in chain_orders
  - `_preferredAccountLock`: Protects preferredAccount global state
  - `_resolutionLock`: Protects account resolution cache

- **Persistence Methods Now Async**:
  - `manager.deductBtsFees()`: Made async, uses lock
  - `manager._persistWithRetry()`: Made async
  - `manager._persistCacheFunds()`: Made async
  - `manager._persistBtsFeesOwed()`: Made async
  - `grid._clearAndPersistCacheFunds()`: Made async, awaited
  - `grid._persistCacheFunds()`: Made async, awaited
  - All callers properly await these methods

- **Account Subscription Management**: Atomic check-and-set with AsyncLock
  - `_ensureAccountSubscriber()`: Uses lock to prevent duplicate subscriptions
  - `listenForFills()`: Protects callback registration inside lock
  - `unsubscribe()`: Atomic removal with lock protection

### Technical Details
- **TOCTOU Fix**: Reload-before-write prevents stale in-memory overwrites
  - Example: Process A reads file, Process B writes update, Process A overwrites with stale data
  - Solution: Always reload immediately before writing
  - Applied to: storeMasterGrid, updateCacheFunds, updateBtsFeesOwed

- **Async/Await Consistency**: All async operations properly awaited
  - No fire-and-forget promises
  - Proper error propagation throughout call chains
  - Busy-wait loops replaced with proper async setTimeout

- **Lock Nesting**: Careful lock ordering prevents deadlocks
  - No nested lock acquisition (locks released before acquiring another)
  - Each critical section has single responsible lock

### Files Modified in v0.4.6

**New Files**:
- `modules/order/async_lock.js` (84 lines): AsyncLock utility implementation with FIFO queue-based synchronization

**Modified Files**:
- `modules/account_orders.js`:
  - Line 104: _persistenceLock declaration
  - Lines 145-232: ensureBotEntries with lock
  - Lines 269-312: storeMasterGrid with lock and reload-before-write
  - Lines 360-375: updateCacheFunds with lock and reload
  - Lines 410-425: updateBtsFeesOwed with lock and reload
  - Lines 427-551: processedFills tracking methods (NEW)

- `modules/chain_orders.js`:
  - Lines 37-39: Three lock declarations (_subscriptionLock, _resolutionLock, _preferredAccountLock)
  - Lines 64-65: Warning comment about lock requirements
  - Lines 76-90: setPreferredAccount/getPreferredAccount thread-safe wrappers
  - Lines 98-164: Account resolution with locks
  - Lines 173-206: _ensureAccountSubscriber with lock
  - Lines 295-364: listenForFills with lock protection

- `modules/dexbot_class.js`:
  - Lines 42-48: Fill dedup and lock declarations
  - Lines 77-251: Fill callback with deduplication logic
  - Lines 652-660: Load persisted fills on startup (NEW)

- `modules/order/manager.js`:
  - Line 140: _correctionsLock declaration
  - Lines 570-596: cacheFunds double-counting fix (_adjustFunds method)
  - Lines 1618-1625: Use pre-update available in processFilledOrders()

- `CHANGELOG.md`:
  - Complete v0.4.6 documentation

### Performance Impact

**Minimal Overhead**:
- AsyncLock uses efficient FIFO queue (O(1) operations)
- Locks held only during critical sections (milliseconds)
- Reload-before-write adds single disk read per write (~5ms, negligible vs network latency)
- Fill dedup cleanup runs only ~10% of batches, not every batch

**Benefits**:
- Eliminates fund loss from race conditions (saves 649.72+ BTS per release cycle)
- Prevents duplicate fill processing (reduces unnecessary grid operations)
- Ensures data consistency across bot restarts (reliable state recovery)
- Foundation for future concurrent enhancements

### Testing
- All 20 integration tests passing ✅
- Test coverage includes: ensureBotEntries, storeMasterGrid, cacheFunds persistence, fee deduction, fill dedup
- Grid comparison, startup reconciliation, partial order handling all verified
- No changes to fill processing logic or output; only adds deduplication layer

### Migration
- **Backward Compatible**: No breaking changes to APIs or configuration
- **No Schema Changes**: File format unchanged; existing bot data continues to work
- **Transparent to Users**: Race condition fixes are internal improvements
- **Automatic Initialization**: `processedFills` field auto-initialized if missing in existing bots

### Summary Statistics

**Total Fixes**: 23 critical bugs
- 1 cacheFunds double-counting fix
- 1 fee double-deduction fix
- 20+ race condition fixes (7 categories of TOCTOU and concurrent access issues)
- 1 defensive fill deduplication system (multi-layer protection)

**Implementation**:
- Total AsyncLock instances: 7
- Lines of code added: ~300
- Files modified: 5 existing + 1 new
- Tests passing: 20/20 ✅

**Risk Level**: LOW
- Simple addition of locks to existing code paths
- No core algorithm changes
- Fully backward compatible
- All tests passing

---

## [0.4.5] - 2025-12-27 - Partial Order Counting & Grid Navigation Fix

### Fixed
- **Partial Orders Not Counted in Grid Targets**: Critical bug in rebalancing logic
  - Partial filled orders were excluded from order target counting
  - Caused bot to create unnecessary orders even when at target capacity
  - Now counts both ACTIVE and PARTIAL orders toward target
  - Prevents "mixing up" of grid positions and erroneous order creation

- **Grid Navigation Limited by ID Namespace**: Critical bug in partial order movement
  - `preparePartialOrderMove()` used ID-based navigation (sell-N/buy-N)
  - Could not move partial orders across sell-*/buy-* namespace boundaries
  - Example: sell-173 (highest sell slot) couldn't move to buy-0 (adjacent by price)
  - **Now uses price-sorted navigation** for fluid grid movement
  - Partial orders can now move anywhere in the grid without artificial boundaries

### Added
- **`countOrdersByType()` Helper Function** in utils.js
  - Counts both ACTIVE and PARTIAL orders by type
  - Used consistently across order target comparisons
  - Ensures partial orders take up real grid positions

### Changed
- **Order Target Checks**: Updated to include partial orders
  - `checkSpreadCondition()` (line 1396): Includes partials in "both sides" check
  - Rebalancing checks (lines 1747, 1851): Uses `countOrdersByType()`

- **Spread Calculation**: Updated to include partial orders
  - `calculateCurrentSpread()` (line 2577): Combines ACTIVE + PARTIAL orders
  - Partial orders are on-chain and affect actual market spread

### Technical Details
- Grid is now treated as fluid: no artificial boundaries during fill handling
- Price-sorted navigation allows unrestricted partial order movement
- All 18 test suites pass
- Fixed crossed rotation test expectations (test_crossed_rotation.js)

---

## [0.4.4] - 2025-12-27 - Code Consolidation & BTS Fee Deduction Fix

### Fixed
- **BTS Fee Deduction on Wrong Side**: Critical bug in grid resize operations
  - Fixed fee deduction logic that incorrectly applied to non-BTS side during order resizing
  - XRP/BTS pairs: BTS fees no longer deducted from XRP (SELL side) funds
  - Buy side (assetB): Only deduct if assetB === 'BTS'
  - Sell side (assetA): Only deduct if assetA === 'BTS'
  - Fixes 70% order size reduction issue during grid resize

### Changed
- **Fee Multiplier Update**: Increased from 4x to 5x
  - Now reserves: 1x for initial creation + 4x for rotation buffer (was 3x)
  - Provides better buffer for multiple rotation cycles

### Refactored
- **Code Consolidation**: Moved 22 grid utility functions from grid.js to utils.js
  - Eliminated duplicate code and scattered inline requires
  - Centralized reusable utilities for consistent access across modules
  - Added 15 new utility functions for common operations

- **Grid Utilities Added to utils.js**:
  - Numeric: `toFiniteNumber`, `isValidNumber`, `compareBlockchainSizes`, `computeSizeAfterFill`
  - Order filtering: `filterOrdersByType`, `filterOrdersByTypeAndState`, `sumOrderSizes`, `mapOrderSizes`
  - Precision: `getPrecisionByOrderType`, `getPrecisionForSide`, `getPrecisionsForManager`
  - Size validation: `checkSizesBeforeMinimum`, `checkSizesNearMinimum`
  - Fee calculation: `calculateOrderCreationFees`, `deductOrderFeesFromFunds`
  - Grid sizing: `allocateFundsByWeights`, `calculateOrderSizes`, `calculateRotationOrderSizes`, `calculateGridSideDivergenceMetric`, `getOrderTypeFromUpdatedFlags`, `resolveConfiguredPriceBound`

- **Manager Helper Methods**: Added fund/chainFree tracking
  - `_getCacheFunds(side)`: Safe access to cache funds
  - `_getGridTotal(side)`: Safe access to grid totals
  - `_deductFromChainFree(orderType, size, operation)`: Track fund movements
  - `_addToChainFree(orderType, size, operation)`: Track fund releases

- **Code Cleanup**: Removed debug console.log statements from chain_orders.js

### Technical Details
- Reduced grid.js from 1190 to 635 lines (-46%)
- All 18 test suites pass
- Rotation and divergence check behavior unchanged
- Net +166 lines: Justified by new utilities and JSDoc documentation

---

## [0.4.3] - 2025-12-26 - Order Pairing, Rebalance & Fee Reservation Fixes

### Fixed
- **Asymmetric Rebalance Orders Logic for BUY Fills**: Corrected order matching in rebalanceOrders function
  - Fixed logic that incorrectly paired BUY orders during rebalancing operations
  - Ensures proper order pairing for asymmetric buy/sell scenarios

- **Order Pairing Sorting & Startup Reconciliation**: Optimized order matching algorithm
  - Implemented proper sorting for order pairing to ensure consistent matching
  - Improved startup reconciliation performance and reliability

- **Grid Data Corruption Prevention**: Added validation for order sizes and IDs
  - Prevented undefined size values from corrupting grid data
  - Added null ID checks to prevent invalid order state

- **BTS Fee Reservation During Resize**: Fixed target order selection
  - Use target orders for BTS fee reservation calculations during order resizing
  - Ensures accurate fee reservation across resize operations

- **4x Blockchain Fee Buffer Enforcement**: Corrected fee buffer application
  - Respect 4x blockchain fee buffer consistently during order resizing
  - Added 100 BTS fallback for adequate fee reservation

- **Grid Edge State Synchronization**: Fixed manager state sync after reducing largest order
  - Search by blockchain orderId to find matching grid order in manager.orders
  - Ensures manager's local grid state matches blockchain after order reduction

- **Grid Edge Order Reconciliation**: Refactored cancel+create for better efficiency
  - Replace reduce+restore with cancel+create approach (N+1 vs N+2 operations)
  - Phase 1: Cancel largest order to free funds
  - Phase 2: Update remaining orders to targets
  - Phase 3: Create new order for cancelled slot
  - Simplified logic with proper index alignment

- **Vacated Slot Size Preservation**: Fixed orphaned virtual orders from partial moves
  - Don't set vacated slots to size: 0 after partial order moves
  - Prevents "no size defined" warnings when slots are reused for new orders
  - Detects already-claimed slots to avoid conflicts with new order placement
  - Complements the "below target" path that uses vacated slots for new order creation

### Changed
- Removed unused `bot_instance.js` module for code cleanup
- Enhanced `startup_reconcile` documentation in README
- Optimized grid edge reconciliation strategy for fewer blockchain operations

---

## [0.4.2] - 2025-12-24 - Grid Recalculation Fixes & Documentation Updates

### Fixed
- **Grid Recalculation in Post-Rotation Divergence Flow**: Added missing grid recalculation call
  - **Problem**: Orders were losing size information during post-rotation divergence correction
  - **Symptoms**: "Skipping virtual X - no size defined" warnings, "Cannot read properties of undefined (reading 'toFixed')" batch errors
  - **Solution**: Added `Grid.updateGridFromBlockchainSnapshot()` call to post-rotation flow, matching startup and timer divergence paths
  - **Impact**: Prevents order size loss during divergence correction cycles

- **PARTIAL Order State Preservation at Startup**: Fixed state inconsistency during synchronization
  - **Problem**: PARTIAL orders (those with remaining amounts being filled) were unconditionally converted to ACTIVE state at startup
  - **Symptoms**: False divergence spikes (700%+ divergence), state mismatches between persistedGrid and calculatedGrid, unnecessary grid recalculations
  - **Solution**: Preserve PARTIAL state across bot restarts if already set; only convert VIRTUAL orders to ACTIVE when matched on-chain
  - **Impact**: Eliminates false divergence detection and maintains consistent order state across restarts

- **Redundant Grid Recalculation Removal**: Eliminated duplicate processing in divergence correction
  - **Problem**: Grid was being recalculated twice when divergence was detected (once by divergence check, once by correction function)
  - **Symptoms**: Double order size updates, unnecessary blockchain fetches, performance inefficiency
  - **Solution**: Removed redundant recalculation from `applyGridDivergenceCorrections()` since caller already recalculates
  - **Impact**: Single grid recalculation per divergence event, improved performance

- **BTS Fee Formula Documentation**: Updated outdated comments and logged output to accurately reflect the complete fee calculation formula
  - Fixed `modules/order/grid.js`: Changed comment from "2x multiplier" to "4x multiplier" to match actual implementation
  - Updated formula in 5 files to show complete formula: `available = max(0, chainFree - virtual - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)`
  - Fixed `modules/order/logger.js`: Console output now displays full formula instead of simplified version
  - Updated `modules/order/manager.js`: Changed variable name references from ambiguous "4xReservation" to proper "btsFeesReservation"
  - Fixed `modules/account_bots.js`: Comment now correctly states default targetSpreadPercent is 4x not 3x

---

## [0.4.1] - 2025-12-23 - Order Consolidation, Grid Edge Handling & Partial Order Fixes

### Features
- **Code Consolidation**: Eliminated ~1,000 lines of duplicate code across entry points
  - Extracted shared `DEXBot` class to `modules/dexbot_class.js` (822 lines)
  - bot.js refactored from 1,021 → 186 lines
  - dexbot.js refactored from 1,568 → 598 lines
  - Unified class-based approach with logPrefix options for context-specific behavior
  - Extracted `buildCreateOrderArgs()` utility to `modules/order/utils.js`

- **Conditional Rotation**: Smart order creation at grid boundaries
  - When active order count drops below target, creates new orders instead of rotating
  - Handles grid edge cases where fewer orders can be placed near min/max prices
  - Seamlessly transitions back to normal rotation when target is reached
  - Prevents perpetual deficit caused by edge boundary constraints
  - Comprehensive test coverage with edge case validation

- **Repository Statistics Analyzer**: Interactive git history visualization
  - Analyzes repository commits and generates beautiful HTML charts
  - Tracks added/deleted lines across codebase with daily granularity
  - Charts include daily changes and cumulative statistics
  - Configurable file pattern filtering for focused analysis
  - Script: `scripts/analyze-repo-stats.js`

### Fixed
- **Partial Order State Machine Invariant**: Guaranteed PARTIAL orders always have size > 0
  - Fixed bug in `synchronizeWithChain()` where PARTIAL could be set with size = 0
  - Proper state transitions: ACTIVE (size > 0) → PARTIAL (size > 0) → SPREAD (size = 0)
  - PARTIAL and SPREAD orders excluded from divergence calculations
  - Prevents invalid order states from persisting to storage

### Changed
- **Entry Point Architecture**: Simplified bot.js and dexbot.js to thin wrappers
  - Removed duplicate class definitions
  - All core logic now centralized in `modules/dexbot_class.js`
  - Reduces maintenance overhead and improves consistency
  - Options object pattern enables context-specific behavior (e.g., logPrefix)

### Testing
- Added comprehensive test suite for conditional rotation edge cases
- Added state machine validation tests for partial orders
- All tests passing with improved grid coverage scenarios

### Technical Details
- **Grid Coverage Recovery**: Gradual recovery mechanism for edge-bound grids
  - Shortage = `targetCount - currentActiveCount`
  - Creates `min(shortage, fillCount)` new orders per fill cycle
  - Continues until target is reached, then resumes rotation
  - Respects available virtual orders (no over-activation)

- **Code Quality**: Significant reduction in complexity and duplication
  - Common patterns unified in shared class
  - Easier to maintain and update core logic
  - Improved testability with centralized implementation

---

## [0.4.0] - 2025-12-22 - Fund Management Consolidation & Automatic Fund Cycling

### Features
- **Automatic Fund Cycling**: Available funds now automatically included in cacheFunds before rotation
  - Newly deposited funds immediately available for grid sizing
  - Grid resizes when deposits arrive, not just after fills
  - More responsive to market changes and new capital inflows

- **Unified Fund Management**: Complete consolidation of pendingProceeds into cacheFunds
  - Simplified fund tracking: single cacheFunds field for all unallocated funds
  - Cleaner codebase (272 line reduction in complexity)
  - Backward compatible: legacy pendingProceeds automatically migrated

### Changed
- **BREAKING CHANGE**: `pendingProceeds` field removed from storage schema
  - Affects: `profiles/orders/<bot-name>.json` files for existing bots
  - Migration: Use `scripts/migrate_pending_proceeds.js` before first startup with v0.4.0
  - Backward compat: Legacy pendingProceeds merged into cacheFunds on load

- **Fund Formula Updated**:
  ```
  OLD: available = max(0, chainFree - virtual - cacheFunds - btsFeesOwed) + pendingProceeds
  NEW: available = max(0, chainFree - virtual - cacheFunds - btsFeesOwed)
  ```

- **Grid Regeneration Threshold**: Now includes available funds
  - OLD: Checked only `cacheFunds / gridAllocation`
  - NEW: Checks `(cacheFunds + availableFunds) / gridAllocation`
  - Result: Grid resizes when deposits arrive, enabling fund cycling

- **Fee Deduction**: Now deducts BTS fees from cacheFunds instead of pendingProceeds
  - Called once per rotation cycle after all proceeds added
  - Cleaner integration with fund cycling

### Fixed
- **Partial Order Precision**: Fixed floating-point noise in partial fill detection
  - Now uses integer-based subtraction (blockchain-safe precision)
  - Converts orders to blockchain units, subtracts, converts back
  - Prevents false PARTIAL states from float arithmetic errors (e.g., 1e-18 floats)

- **Logger Undefined Variables**: Fixed references to removed pendingProceeds variables
  - Removed orphaned variable definitions
  - Cleaned up fund display logic in logFundsStatus()

- **Bot Metadata Initialization**: Fixed new order files being created with null metadata
  - Ensured `ensureBotEntries()` is called before any Grid initialization
  - Prevents order files from having null values for name, assetA, assetB
  - Metadata properly initialized from bot configuration in profiles/bots.json at startup
  - Applied fix to both bot.js and dexbot.js DEXBot classes

### Migration Guide
1. **Backup** your `profiles/orders/` directory before updating
2. **Run migration** (if you have existing bots with pendingProceeds):
   ```bash
   node scripts/migrate_pending_proceeds.js
   ```
3. **Restart bots**: Legacy data automatically merged into cacheFunds on load
   - No data loss - all proceeds preserved
   - Grid sizing adjusted automatically

### Technical Details
- **Fund Consolidation**: All proceeds and surpluses now consolidated in single cacheFunds field
- **Backward Compatibility**: Automatic merge of legacy pendingProceeds into cacheFunds during grid load
- **Storage**: Updated account_orders.js schema, removed pendingProceeds persistence methods
- **Test Coverage**: Added test_fund_cycling_trigger.js, test_crossed_rotation.js, test_fee_refinement.js

---

## [0.3.0] - 2025-12-19 - Grid Divergence Detection & Percentage-Based Thresholds

### Features
- **Grid Divergence Detection System**: Intelligent grid state monitoring and automatic regeneration
  - Quadratic error metric calculates divergence between in-memory and persisted grids: Σ((calculated - persisted) / persisted)² / count
  - Automatic grid size recalculation when divergence exceeds DIVERGENCE_THRESHOLD_PERCENTAGE (default: 1%)
  - Detects when cached fund reserves exceed configured percentage threshold (default: 3%)
  - Two independent triggering mechanisms ensure grid stays synchronized with actual blockchain orders

- **Percentage-Based Threshold System**: Standardized threshold configuration across the system
  - Replaced promille-based thresholds (0-1000 scale) with percentage-based (0-100 scale)
  - More intuitive configuration and easier to understand threshold values
  - DIVERGENCE_THRESHOLD_PERCENTAGE: Controls grid divergence detection sensitivity
  - GRID_REGENERATION_PERCENTAGE: Controls when cached funds trigger grid recalculation (default: 3%)

- **Enhanced Documentation**: Comprehensive threshold documentation with distribution analysis
  - Added Root Mean Square (RMS) explanation and threshold reference tables
  - Distribution analysis showing how threshold requirements change with error distribution patterns
  - Clear explanation of how same average error (e.g., 3.2%) requires different thresholds based on distribution
  - Migration guide for percentage-based thresholds
  - Mathematical formulas for threshold calculation and grid regeneration logic

### Changed
- **Breaking Change**: DIVERGENCE_THRESHOLD_Promille renamed to DIVERGENCE_THRESHOLD_PERCENTAGE
  - Configuration files using old name must be updated
  - Old: promille values (10 promille ≈ 1% divergence)
  - New: percentage values (1 = 1% divergence threshold)
  - Update pattern: divide old promille value by 10 to get new percentage value

- **Default Threshold Changes**: Improved defaults based on real-world testing
  - GRID_REGENERATION_PERCENTAGE: 1% → 3% (more stable, reduces unnecessary regeneration)
  - DIVERGENCE_THRESHOLD_PERCENTAGE: 10 promille → 1% (more sensitive divergence detection)

- **Grid Comparison Metrics**: Enhanced logging and comparison output
  - All threshold comparisons now use percentage-based values
  - Log output displays percentage divergence instead of promille
  - Clearer threshold comparison messages in grid update logging

### Fixed
- **Threshold Comparison Logic**: Corrected grid comparison triggering mechanism
  - Changed division from /1000 (promille) to /100 (percentage) in threshold calculations
  - Applied fixes to both BUY and SELL side grid regeneration logic (grid.js lines 1038-1040, 1063-1065)
  - Ensures accurate divergence detection and grid synchronization

### Technical Details
- **Quadratic Error Metric**: Sum of squared relative differences detects concentrated outliers
  - Formula: Σ((calculated - persisted) / persisted)² / count
  - Penalizes outliers more than simple average, reflects actual grid synchronization issues
  - RMS (Root Mean Square) = √(metric), provides alternative view of error magnitude

- **Distribution Scaling**: Threshold requirements scale with distribution evenness
  - Theoretical relationship: promille ≈ 1 + n (where n = ratio of perfect orders)
  - Example: 10% outlier distribution (n=9) requires ~10× higher threshold than 100% even distribution
  - Reference table in README documents thresholds for 1%→10% average errors across distributions

- **Grid Regeneration Mechanics**: Independent triggering mechanisms
  - Mechanism 1: Cache funds accumulating to GRID_REGENERATION_PERCENTAGE (3%) triggers recalculation
  - Mechanism 2: Grid divergence exceeding DIVERGENCE_THRESHOLD_PERCENTAGE (1%) triggers update
  - Both operate independently, ensuring grid stays synchronized with actual blockchain state

### Migration Guide
If upgrading from v0.2.0:
1. Update configuration files to use DIVERGENCE_THRESHOLD_PERCENTAGE instead of DIVERGENCE_THRESHOLD_Promille
2. Convert threshold values: new_value = old_promille_value / 10
   - Old: 10 promille → New: 1%
   - Old: 100 promille → New: 10%
3. Test with dryRun: true to verify threshold behavior matches expectations
4. Default GRID_REGENERATION_PERCENTAGE (3%) is now more conservative; adjust if needed

### Testing
- Comprehensive test coverage for grid divergence detection (test_grid_comparison.js)
- Validates quadratic error metric calculations across various distribution patterns
- Tests both cache funds and divergence triggers independently and in combination
- Percentage-based threshold comparisons verified across BUY and SELL sides

## [0.2.0] - 2025-12-12 - Startup Grid Reconciliation & Fee Caching System

### Features
- **Startup Grid Reconciliation System**: Intelligent grid recovery at startup
  - Price-based matching to resume persisted grids with existing on-chain orders
  - Smart regeneration decisions based on on-chain order states
  - Count-based reconciliation for order synchronization
  - Unified startup logic in both bot.js and dexbot.js

- **Fee Caching System**: Improved fill processing performance
  - One-time fee data loading to avoid repeated blockchain queries
  - Cache fee deductions throughout the trading session
  - Integrated into fill processing workflows

- **Enhanced Order Manager**: Better fund tracking and grid management
  - Improved chain order synchronization with price+size matching
  - Grid recalculation for full grid resync with better parameters
  - Enhanced logging and debug output for startup troubleshooting

- **Improved Account Handling**: Better restart operations
  - Set account info on manager during restart for balance calculations
  - Support percentage-based botFunds configuration at restart
  - Fetch on-chain balances before grid initialization if needed

### Fixed
- **Limit Order Update Calculation**: Fixed parameter handling in chain_orders.js
  - Corrected receive amount handling for price-change detection
  - Improved delta calculation when price changes toward/away from market
  - Added comprehensive validation for final amounts after delta adjustment

### Testing
- Comprehensive test coverage for new reconciliation logic
- Test startup decision logic with various grid/chain scenarios
- Test TwentyX-specific edge cases and recovery paths

## [0.1.2] - 2025-12-10 - Multi-Bot Fund Allocation & Update Script

### Features
- **Multi-Bot Fund Allocation**: Enforce botFunds percentage allocation when multiple bots share an account
  - Each bot respects its allocated percentage of chainFree (what's free on-chain)
  - Bot1 with 90% gets 90% of chainFree, Bot2 with 10% gets 10% of remaining
  - Prevents fund allocation conflicts in shared accounts
  - Applied at grid initialization for accurate startup sizing

### Fixed
- **Update Script**: Removed interactive merge prompts by using `git pull --rebase`
- **Script Permissions**: Made update.sh permanently executable via git config

## [0.1.1] - 2025-12-10 - Minimum Delta Enforcement

### Features
- **Minimum Delta Enforcement**: Enforce meaningful blockchain updates for price-only order moves
  - When price changes but amount delta is zero, automatically set delta to ±1
  - Only applies when order moves toward market center (economically beneficial)
  - Prevents wasted on-chain transactions for imperceptible price changes
  - Maintains grid integrity by pushing orders toward spread

### Fixed
- Eliminated zero-delta price-only updates that had no economic effect
- Improved order update efficiency for partial order price adjustments

## [0.1.0] - 2025-12-10 - Initial Release

### Features
- **Staggered Order Grid**: Geometric order grids with configurable weight distribution
- **Dynamic Rebalancing**: Automatic order updates after fills
- **Multi-Bot Support**: Run multiple bots simultaneously on different pairs
- **PM2 Process Management**: Production-ready process orchestration with auto-restart
- **Partial Order Handling**: Atomic moves for partially-filled orders
- **Fill Deduplication**: 5-second deduplication window prevents duplicate processing
- **Master Password Security**: Encrypted key storage with RAM-only password handling
- **Price Tolerance**: Intelligent blockchain rounding compensation
- **API Resilience**: Multi-API support with graceful fallbacks
- **Dry-Run Mode**: Safe simulation before live trading

### Fixed
- **Fill Processing in PM2 Mode**: Implemented complete 4-step fill processing pipeline for PM2-managed bots
  - Fill validation and deduplication
  - Grid synchronization with blockchain
  - Batch rebalancing and order updates
  - Proper order rotation with atomic transactions
- **Fund Fallback in Order Rotation**: Added fallback to available funds when proceeds exhausted
- **Price Derivation Robustness**: Enhanced pool price lookup with multiple API variant support


### Installation & Usage
See README.md for detailed installation and usage instructions.

### Documentation
- README.md: Complete feature overview and configuration guide
- modules/: Comprehensive module documentation
- examples/bots.json: Configuration templates
- tests/: 25+ test files covering all major functionality

### Notes
- First production-ready release for BitShares DEX market making
- Always test with `dryRun: true` before enabling live trading
- Secure your keys; do not commit private keys to version control
- Use `profiles/` directory for live configuration (not tracked by git)

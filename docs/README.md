# DEXBot2 Documentation

This directory contains the comprehensive technical documentation for the DEXBot2 trading bot. It is designed to guide developers from high-level architecture down to the nuances of fund accounting and state management.

**Version context:** v1.6.13 (released).

---

## User-Facing Workflows

### 🎓 [BitShares Onboarding](BITSHARES_ONBOARDING.md)
*Beginner tutorial for new BitShares users getting started with DEXBot2.*
- **Account Setup**: Register and fund a BitShares account
- **Keys Explained**: Owner vs active vs memo vs login key — and which one the bot needs
- **First Bot**: Import keys, create a bot config, and run a dry run
- **Troubleshooting**: The most common first-run mistakes and how to fix them

### 📡 [Market Adapter](../market_adapter/README.md)
*Live AMA pricing, dynamic weights, and recalc trigger orchestration.*
- **Quick Start**: Enable AMA, set the per-bot adapter flags in `dexbot bot`, and start DEXBot2
- **Settings**: Global, pair, and bot-specific adapter overrides
- **Dynamic Weights**: How adapter signals write live weight snapshots
- **Troubleshooting**: Common adapter startup and trigger issues

### 💳 [MPA and Credit Usage](MPA_CREDIT_USAGE.md)
*User-facing MPA and credit offer workflow guide.*
- **Debt Policy**: Per-bot `debtPolicy.lending` configuration where each item declares its own `collateralAsset`
- **Credit-Only Mode**: Run credit runtime without grid trading (`creditOnly: true`, `dexbot start credit` runs just that worker as a background daemon)
- **MPA Borrowing**: Call-order updates with debt-first CR planning
- **Credit Offers**: Accept/repay with auto-reborrow and LP-backed collateral valuation
- **Watchdog Timing**: Dedicated credit deal renewal interval and expiry threshold settings

### 📈 [Analysis](../analysis/README.md)
*Research runners, chart generators, and tuning helpers.*
- **Trend Detection**: Hurst, Kalman, and regime analysis tools
- **AMA Fitting**: Parameter fitting, comparison charts, and LP data workflows
- **Bot Fitting**: Grid parameter sweep backtests for AMA winners
- **TradingView Exports**: Chart export utilities for visual analysis
- **Trade Profitability**: FIFO-based PnL analysis from Kibana fill data (`trade_profitability.ts`), plus the self-contained HTML report behind `dexbot pnl` (`pnl_report.ts`) with a per-account month-shard fill cache (`fills_cache.ts`)
- **Bot Usage Discovery**: On-chain bot account finder and Kibana query helpers (`bot_usage/`)

### 🦀 [Claw](../claw/README.md)
*Bridge between DEXBot2 and external runtimes.*
- **Purpose**: Exposes BitShares capabilities and DEXBot2 infrastructure through JSON/CLI bridges, MCP, and runtime-native skill packaging for OpenClaw and compatible runtimes (see [claw/README.md](../claw/README.md) for the full list).
- **API Boundary**: Responsibility split between the AI decision layer and the DEXBot2 execution substrate ([AI_BOT_LIBRARY_API.md](../claw/docs/AI_BOT_LIBRARY_API.md))
- **Tuning Reference**: Practical grid-tuning baselines ([DEXBOT2_TUNING_CHEAT_SHEET.md](../claw/docs/DEXBOT2_TUNING_CHEAT_SHEET.md))
- **Position Management**: Short-position tracking, position health monitoring (3-zone CR model), and shared CR planning via `cr_planner.ts`
- **Skills**: Presentation-only, concept-reference, and launcher-orchestration skill packs for bitshares-guide, margin-trading, launcher-ops, and shared references

## Operational & Security

### 🔐 [Credential Security](CREDENTIAL_SECURITY.md)
*How private keys are protected at rest, in transit, and in RAM.*
- **Vault v2**: scrypt (N=2¹⁷) key derivation, per-record HKDF isolation, AES-256-GCM encryption
- **Daemon-backed signing**: primary bot flow uses signing tokens; all signing happens inside the daemon, raw keys never exported
- **Session cache**: encrypted HKDF re-encryption with a random salt that is never persisted
- **Runtime hardening**: lstat + owner/mode/type checks on all sockets and ready files; bootstrap socket destroyed after first use

### 📊 [Grid Recalculation](GRID_RECALCULATION.md)
*When and why the grid resets.*
- **Reset Sources**: Market-adapter bootstrap, AMA delta, AMA-slope range reset, RMS divergence correction, and fund regeneration
- **Configuration**: Per-source thresholds, whitelist requirements, and defaults
- **Trigger Execution**: How `profiles/recalculate.<botKey>.trigger` is consumed under the fill-processing lock

### 📉 [AMA-Slope Window](AMA_SLOPE_WINDOW.md)
*Why the Huber slope window is 16h and gated by a 3-bar persistence check.*
- **Decision**: `DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS` 20 → 16, `AMA_SLOPE_PERSIST_ENABLED` false → true (`AMA_SLOPE_PERSIST_BARS = 3`)
- **Rationale**: shorter, more responsive window plus the persistence gate cuts slope-reset churn (~35%) and whipsaw without changing the estimator
- **Evidence**: measured reset/lag/whipsaw table from a live 1h pool via `backtest_ama_slope_huber.ts`

### 🔁 [Grid Reconciliation](GRID_RECONCILE.md)
*How the bot re-aligns its intended grid with on-chain reality at startup.*
- **3-Phase Plan-then-Execute**: Phase 1 pure in-memory planning under `_gridLock`, Phase 2 blockchain execution outside the lock, Phase 3 fresh re-read and stale surplus cleanup
- **Safety Guardrails**: Fresh-grid `matchedOnGrid > 0` guard, exact slot-price duplicate cancel, freshly-assigned deferral, the `SURPLUS_CANCEL_GRACE_MS` fresh-placement grace, and truncated-read ambiguity handling
- **Partial Failure State**: No rollback on partial Phase 2 success; remaining mismatches caught by the next maintenance or startup cycle
- **Lock Hierarchy**: Canonical `_syncLock`/`_gridLock` level reference and the 1.4.6 ABBA deadlock correction

### 📝 [Logging System](LOGGING.md)
*Configuration reference for log levels, rotation, JSON output, and categories.*
- **5 Severity Levels**: `debug`, `info`, `warn`, `error`, `critical`.
- **Rotation**: Size-based (1.1GB total budget default), auto-prune (10 rotated files).
- **JSON Output**: Structured lines for log aggregators (opt-in).
- **Categories**: 6 independently enablable category groups.
- **Change Detection**: Skips redundant logs (40-50% reduction).
- **Batch Processing Logs**: Fill batching, recovery retry, and orphan-fill deduplication messages.
- **Fill History Scans**: The `Subscriptions` logger emits `fetchFillHistoryEntries: maxPages (X) reached` at `debug` level when the history scan hits its page cap — normal on busy accounts; see LOGGING.md for the `--partial-operations` diagnostic.

### 🐳 [Docker](docker.md)
*Container build, release images, and secure startup.*
- **Build Flow**: Docker-based packaging for the bot runtime
- **Release Images**: Container release and startup guidance
- **Security**: Notes on secure container launch behavior

### 🛠️ [Scripts](../scripts/README.md)
*CLI maintenance and diagnostic utilities.*
- **Update**: Safe production update via `dexbot update`
- **Reset & Cleanup**: Log/order wipes, settings resets, and market-adapter/claw state cleanup
- **Diagnostics**: Configuration audit, grid divergence/trading analysis, and candle/pool history checks

## Reference Docs

### 🏛️ [Architecture](architecture.md)
*The blueprint of the system.*
- **Design Philosophy**: Simplicity, constant spread, minimal blockchain interaction, and closed-loop market dynamics.
- **System Design**: High-level overview of how the bot components interact.
- **Module Responsibilities**: Detailed breakdown of the **Manager**, **Accountant**, **Strategy**, **SyncEngine**, **Grid**, **FillRuntime**, and **MaintenanceRuntime** modules.
- **Copy-on-Write Pattern**: Safe concurrent rebalancing with isolated working grids (see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md))
- **Fill Processing Pipeline**: Fixed-cap batch fill processing (`gapSlots+1` fills per broadcast; documented Feb 7 29-fill scenario: ~24s)
- **Spread Correction**: Conservative, fund-aware maintenance of constant spread width
- **Periodic Market Price Refresh**: Background 4-hour price updates
- **Pipeline Safety & Diagnostics**: 5-minute timeout safeguard and health monitoring
- **Data Flow**: Visualization of how market data becomes trading operations and then blockchain transactions.
- **Zero-Dependency Policy**: Formal policy rationale, trading-bot special-case justification, and practical implications (native blockchain client, crypto, testing, persistence)
- **Market Adapter Signal Pipeline**: AMA center, dynamic weights, regime detection, and collateral advisories
- **Credit/Debt Runtime**: Native MPA and credit offer workflows with CR planning and grid reset coupling; `creditOnly` mode for runtime-only operation without grid trading

### 🧬 [Lifecycle](LIFECYCLE.md)
*The end-to-end walkthrough (start here for the big picture).*
- **System Context**: What DEXBot2 talks to (chain, market data, storage, operator).
- **Startup / Bootstrap**: Decrypt keys → load metadata → rebuild master grid → sync → runtime loops.
- **Lifecycle A (Fill-Driven)**: Reactive path from an on-chain fill to a single atomic rebalance + broadcast.
- **Lifecycle B (Maintenance / AMA-Driven)**: Periodic path from `_performPeriodicGridChecks` → `executeMaintenanceLogic`.
- **Cross-Cutting Invariants**: COW boundary, fund SSOT, replay-safe fills, lock ordering.

### 🧩 [Copy-on-Write Master Plan](COPY_ON_WRITE_MASTER_PLAN.md)
*COW design, phases, and state machine details.*
- **Architecture**: Master-grid projection model and rebalance flow
- **Lifecycle**: State machine, rebalance/fill data flows, fill handling strategy, and operational rules
- **Safety**: Invariants and guardrails for concurrent updates

### 🔒 [COW Invariants](COW_INVARIANTS.md)
*Stable theory contract for COW pipeline.*
- **Non-negotiable invariants**: Master immutability, commit atomicity, projection rules, accounting separation
- **Subsystem Scope**: 13 `INV-*` prefix groups mapping each invariant to its runtime subsystem
- **Change Policy**: Required steps for an intentional invariant change — same-PR doc update, rationale, and regression tests

### 📐 [Grid-Price Invariant](GRID_PRICE_INVARIANT.md)
*Why a slot's emitted price must equal its genesis level — and how that failed.*
- **The invariant**: `order.price === priceForSlot(idx, genesis)`, and why range guards cannot substitute for it
- **Failure mechanism**: Chain price overwriting slot identity, pre-broadcast substitution, untrusted fill-guard pivot
- **Enforcement**: The six emission sites, the blocking rejection of off-grid emissions, the final pre-broadcast pivot gate, and the fail-open policy on unjudgeable inputs
- **Out-of-bounds policy**: Hold and surface; refill in-grid slots at their genesis price
- **Status**: Landed enforcement map, key constants, and why the removed 5% sanity gate must not be naively re-landed

### 💰 [Fund Movement & Accounting](FUND_MOVEMENT_AND_ACCOUNTING.md)
*The most critical part of the bot: safe capital management.*
- **Single Source of Truth**: How the bot avoids double-spending and out-of-sync balances.
- **Optimistic ChainFree**: The mechanism that allows the bot to trade with fill proceeds before they are finalized on-chain.
- **Fill Batch Processing**: Fixed-cap batching for efficient fill processing (`1..gapSlots+1` unified, deeper queues chunked at `gapSlots+1`)
- **Partial Order Consolidation**: Simplified, direct consolidation through grid rebuilding (no merge/split mechanics)
- **Dust Detection & Management**: Partials below the dust threshold are cancelled on-chain immediately on detection (no delay, no timer)
- **BTS Fee Object Structure**: `netProceeds` field for accounting precision
- **BUY Side Sizing & Fee Accounting**: Correct fee application by order side
- **Mixed Order Fund Validation**: Separate validation for BUY vs SELL order fund checks
- **Fee Management**: Detailed logic for BTS fee reservations and market fee deductions.

### 📖 [Developer Guide](developer_guide.md)
*Your daily companion for coding.*
- **Quick Start**: How to get the development environment running.
- **Module Deep-Dive**: In-depth analysis of the internal logic of each primary module.
- **Copy-on-Write Pattern**: How to work safely within the COW rebalance pipeline; `WorkingGrid` usage and master-grid commit rules (see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md))
- **Startup Sequence & Lock Ordering**: Consolidated startup with deadlock prevention
- **Zero-Amount Order Prevention**: Validation gates for healthy order sizes
- **Configurable startPrice & gridPrice**: Fixed numeric, pool, book-derived, or AMA keyword pricing modes
- **Pool ID Caching**: Optimization for price derivation
- **Order State Helper Functions**: Centralized predicate functions for state checking
- **Signal Concepts**: Dynamic weights, regime detection, and market adapter integration
- **Debt Policy**: Native MPA and credit offer configuration and runtime rules
- **Practical How-Tos**: Adding features step by step, common pitfalls to avoid, and useful debugging commands.
- **Glossary**: Definitions of project-specific terminology (e.g., "VIRTUAL order state", "Rotation", "Pipeline Safety", "WorkingGrid", "Atomic Commit", "Dynamic Weight", "Regime Detection").

### 🔄 [Workflow](WORKFLOW.md)
*How we build and release.*
- **Branching Strategy**: Explanation of the `test` → `dev` → `main` lifecycle.
- **CI/CD Patterns**: Standards for merging and ensuring code quality across branches.

### 🧪 [Test Suite](../tests/README.md)
*Test organization, categories, and key architectural patterns tested.*
- **Test Layout**: Directory structure, helpers, and quick-start commands
- **Categories**: Core infrastructure, order management, COW rebalancing, fees/accounting, integration, edge cases, and more
- **Architectural Patterns**: COW rebalancing, RMS divergence, fund invariants, and the grid-price invariant with doc cross-references

### 🧭 [Evolution Report](EVOLUTION.md)
*Project timeline and major architecture phases.*
- **Coverage**: Historical milestones from bootstrap through the current stable release; per-release detail lives in [CHANGELOG.md](../CHANGELOG.md)
- **Focus**: Architecture evolution, release history, and test growth

### ⏪ [Order Engine Retrospective](ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md)
*Why the post-1.0.0 order engine kept misbehaving — synthesis plus the incident/fix ledger.*
- **Part I — Synthesis**: root cause (uncertain broadcast), recurring bug families, meta-patterns, what actually fixed it, lessons
- **Part II — Incident & Fix Ledger**: preserved gap-band / ladder-recenter / orphan-fill / price-first plans with `LANDED`/`REVERTED`/`SUPERSEDED` status and commit hashes
- **Regression gate**: `npm run analysis:grid-check` (see [analysis/README.md](../analysis/README.md))

### 🗒️ [Changelog](../CHANGELOG.md)
*Release notes and documentation history.*
- **Scope**: Versioned notes per release

### 📐 [DEXBot2 vs the Power-Law Liquidity Curve](DEXBOT2_VS_POWER_LAW_CURVE.md)
*Design proposal comparing DEXBot2's weight + range allocation with AMM liquidity curves.*
- **Scope**: Constant-product, weighted-geometric-mean, and Reciprocal-CES curves vs the bot's order-book allocation
- **Audience**: Protocol designers evaluating an AMM that reproduces DEXBot2's allocation

### 🧮 [DEXBot vs DEXBot2 Comparison](DEXBOT_COMPARISON.md)
*Architectural, functional, and operational comparison with the original Python DEXBot.*
- **Scope**: Full side-by-side of technology stack, architecture, trading strategies, order management, configuration, blockchain integration, fund accounting, and concurrency safety
- **Audience**: Developers and operators evaluating or migrating between the two projects

---

## Source Code Map

While these docs explain the *why*, the *how* lives in the code. See the full [module index](../modules/README.md) for a complete directory walkthrough. Key source modules:

- **`modules/dexbot_class.ts`**: Bot initialization, account setup, lifecycle orchestration, credit runtime startup, and shared runtime wiring
- **`modules/dexbot_fill_runtime.ts`**: Fill processing, replay-safe accounting, and fill queue handling
- **`modules/dexbot_maintenance_runtime.ts`**: Open-orders sync loop, blockchain fetch loop, grid maintenance, trigger handling, and market adapter watchdog
- **`modules/order/manager.ts`**: Central controller with Copy-on-Write rebalancing pattern (see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md))
- **`modules/order/working_grid.ts`**: COW grid wrapper enabling safe concurrent rebalancing with isolated modifications
- **`modules/order/grid.ts`**: Grid generation, sizing, divergence detection, and spread management
- **`modules/order/accounting.ts`**: Fund tracking, available balance calculation, fee deduction, and committed fund management
- **`modules/order/processed_fill_store.ts`**: Processed fill dedupe tracker and persistence batching
- **`modules/order/strategy.ts`**: Grid rebalancing, order activation, consolidation, rotation, and spread management
- **`modules/order/sync_engine.ts`**: Blockchain synchronization, fill detection, order reconciliation
- **`modules/order/genesis_policy.ts`**: Missing-ladder refusal and the `MISSING_GENESIS_POLICY` rebuild/halt decision ([GRID_PRICE_INVARIANT.md](GRID_PRICE_INVARIANT.md))
- **`modules/version_notice.ts`**: The single version probe and status-line renderer for every entry point (`stat`/`pm2`/`start`/`restart`). Two sources (npm, then GitHub releases), a 12h cache for successes and a 15min backoff for failures, an explicit reason when it cannot answer, and a staged wait in `dexbot stat` ending in "no current version information" rather than silence
- **`modules/credit_runtime.ts`**: Bot-scoped debt workflow executor (MPA and credit offer accept/repay/reborrow)
- **`modules/cr_planner.ts`**: Shared collateral-ratio math layer for debt-first planning
- **`modules/order/utils/math.ts`**: Precision conversions, RMS divergence calculation, fund allocation math
- **`modules/order/utils/order.ts`**: Order state predicates, grid indexing, reconciliation helpers, delta building, index utilities
- **`modules/order/utils/validate.ts`**: Order validation, grid reconciliation, COW action building
- **`modules/order/utils/system.ts`**: System utilities, price derivation, fill deduplication
- **`modules/order/grid_reconcile.ts`**: Startup grid reconciliation and offline fill detection ([GRID_RECONCILE.md](GRID_RECONCILE.md))
- **`modules/credential_policy.ts`**: Signing policy validation and operation allowlists

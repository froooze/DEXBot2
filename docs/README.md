# DEXBot2 Documentation

This directory contains the comprehensive technical documentation for the DEXBot2 trading bot. It is designed to guide developers from high-level architecture down to the nuances of fund accounting and state management.

**Version context:** v1.4.13 is the current release.

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
- **Quick Start**: Enable AMA, generate the whitelist, and start DEXBot2
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
- **Trend Detection**: SMA, MACD, RSI, Hurst, Kalman, and regime analysis tools
- **AMA Fitting**: Parameter fitting, comparison charts, and LP data workflows
- **Bot Fitting**: Grid parameter sweep backtests for AMA winners
- **TradingView Exports**: Chart export utilities for visual analysis
- **Trade Profitability**: FIFO-based PnL analysis from Kibana fill data (`trade_profitability.ts`)
- **Bot Usage Discovery**: On-chain bot account finder and Kibana query helpers (`bot_usage/`)

### 🦀 [Claw](../claw/README.md)
*Bridge between DEXBot2 and external runtimes.*
- **Purpose**: Exposes BitShares capabilities and DEXBot2 infrastructure through JSON/CLI bridges, MCP, and runtime-native skill packaging for OpenClaw and compatible runtimes (see [claw/README.md](../claw/README.md) for the full list).
- **API Boundary**: Responsibility split between the AI decision layer and the DEXBot2 execution substrate ([AI_BOT_LIBRARY_API.md](../claw/docs/AI_BOT_LIBRARY_API.md))
- **Tuning Reference**: Practical grid-tuning baselines ([DEXBOT2_TUNING_CHEAT_SHEET.md](../claw/docs/DEXBOT2_TUNING_CHEAT_SHEET.md))
- **Position Management**: Health monitoring, margin planner, and dynamic weight policy
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

### 🔁 [Grid Reconciliation](GRID_RECONCILE.md)
*How the bot re-aligns its intended grid with on-chain reality at startup.*
- **3-Phase Plan-then-Execute**: Phase 1 pure in-memory planning under `_gridLock`, Phase 2 blockchain execution outside the lock, Phase 3 fresh re-read and stale surplus cleanup
- **Safety Guardrails**: Fresh-grid `matchedOnGrid > 0` guard, 5× duplicate tolerance, freshly-assigned deferral, and truncated-read ambiguity handling
- **Partial Failure State**: No rollback on partial Phase 2 success; remaining mismatches caught by the next maintenance or startup cycle
- **Lock Hierarchy**: Canonical `_syncLock`/`_gridLock` level reference and the 1.4.6 ABBA deadlock correction

### 📝 [Logging System](LOGGING.md)
*Configuration reference for log levels, rotation, JSON output, and categories.*
- **5 Severity Levels**: `debug`, `info`, `warn`, `error`, `critical`.
- **Rotation**: Size-based (1GB default), auto-prune (5 files).
- **JSON Output**: Structured lines for log aggregators (opt-in).
- **Categories**: 6 independently enablable category groups.
- **Change Detection**: Skips redundant logs (40-50% reduction).
- **Batch Processing Logs**: Fill batching, recovery retry, and orphan-fill deduplication messages.
- **Fill History Scans**: The `Subscriptions` logger emits `fetchFillHistoryEntries: maxPages (X) reached` at `info` level when the history scan hits its page cap — normal on busy accounts; see LOGGING.md for the `--partial-operations` diagnostic.

### 🐳 [Docker](docker.md)
*Container build, release images, and secure startup.*
- **Build Flow**: Docker-based packaging for the bot runtime
- **Release Images**: Container release and startup guidance
- **Security**: Notes on secure container launch behavior

### 🛠️ [Scripts](../scripts/README.md)
*CLI maintenance and diagnostic utilities.*
- **Update**: Safe production update via `dexbot update`
- **Reset & Cleanup**: Log wiping, setting resets, PM2 ecosystem regeneration
- **Analysis Helpers**: Diagnostic connection tests and health probes

## Reference Docs

### 🏛️ [Architecture](architecture.md)
*The blueprint of the system.*
- **Design Philosophy**: Simplicity, constant spread, minimal blockchain interaction, and closed-loop market dynamics.
- **System Design**: High-level overview of how the bot components interact.
- **Module Responsibilities**: Detailed breakdown of the **Manager**, **Accountant**, **Strategy**, **Grid**, **FillRuntime**, and **MaintenanceRuntime** modules.
- **Copy-on-Write Pattern**: Safe concurrent rebalancing with isolated working grids (see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md))
- **Fill Processing Pipeline**: Fixed-cap batch fill processing (1-4 fills per broadcast; documented Feb 7 29-fill scenario: ~24s)
- **Fund-Driven Boundary Sync**: Automatic grid alignment with inventory distribution
- **Spread Correction**: Conservative, fund-aware maintenance of constant spread width
- **Periodic Market Price Refresh**: Background 4-hour price updates
- **Pipeline Safety & Diagnostics**: 5-minute timeout safeguard and health monitoring
- **Data Flow**: Visualization of how market data becomes trading operations and then blockchain transactions.
- **Zero-Dependency Policy**: Formal policy rationale, trading-bot special-case justification, and practical implications (native blockchain client, crypto, testing, persistence)
- **Market Adapter Signal Pipeline**: AMA center, dynamic weights, regime detection, and collateral advisories
- **Credit/Debt Runtime**: Native MPA and credit offer workflows with CR planning and grid reset coupling; `creditOnly` mode for runtime-only operation without grid trading

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
- **Signal Concepts**: Dynamic weights, regime detection, derivative signals, and market adapter integration
- **Debt Policy**: Native MPA and credit offer configuration and runtime rules
- **Common Tasks**: Practical "how-to" guides for adding features or fixing bugs.
- **Glossary**: Definitions of project-specific terminology (e.g., "Virtual Orders", "Rotation", "Pipeline Safety", "Fund-Driven Boundary", "WorkingGrid", "COW Commit", "Dynamic Weight", "Regime Detection").

### 🔄 [Workflow](WORKFLOW.md)
*How we build and release.*
- **Branching Strategy**: Explanation of the `test` → `dev` → `main` lifecycle.
- **CI/CD Patterns**: Standards for merging and ensuring code quality across branches.

### 🧮 [DEXBot vs DEXBot2 Comparison](DEXBOT_COMPARISON.md)
*Architectural, functional, and operational comparison with the original Python DEXBot.*
- **Scope**: Full side-by-side of technology stack, architecture, trading strategies, order management, configuration, blockchain integration, fund accounting, and concurrency safety
- **Audience**: Developers and operators evaluating or migrating between the two projects

### 🧭 [Evolution Report](EVOLUTION.md)
*Project timeline and major architecture phases.*
- **Coverage**: Historical milestones from the initial December 2025 bootstrap through the v1.4.13 stable release (grid persistence safety, dust pipeline fix, net inventory lots); credit/debt runtime and maintenance hardening are covered under Phase 5 (Mar–Jun 2026)
- **Focus**: Architecture evolution, release history, test growth, and documentation changes

### 🗒️ [Changelog](../CHANGELOG.md)
*Release notes and documentation history.*
- **Scope**: Versioned notes for patch releases and the current unreleased documentation refresh

### 🧩 [Copy-on-Write Master Plan](COPY_ON_WRITE_MASTER_PLAN.md)
*COW design, phases, and state machine details.*
- **Architecture**: Master-grid projection model and rebalance flow
- **Lifecycle**: Implementation phases, commit boundaries, and test coverage
- **Safety**: Invariants and guardrails for concurrent updates

### 🔒 [COW Invariants](COW_INVARIANTS.md)
*Stable theory contract for COW pipeline.*
- **Non-negotiable invariants**: Master immutability, commit atomicity, projection rules, accounting separation
- **Test mapping**: Links each invariant to regression tests
- **Review checklist**: Quick-use verification for COW/accounting changes

### 🧪 [Test Suite](../tests/README.md)
*Test organization, categories, and key architectural patterns tested.*
- **Test Layout**: Directory structure, helpers, and quick-start commands
- **Categories**: Core infrastructure, order management, COW rebalancing, fees/accounting, integration, edge cases, and more
- **Architectural Patterns**: COW rebalancing, RMS divergence, and fund invariants with doc cross-references

### 💰 [Fund Movement & Accounting](FUND_MOVEMENT_AND_ACCOUNTING.md)
*The most critical part of the bot: safe capital management.*
- **Single Source of Truth**: How the bot avoids double-spending and out-of-sync balances.
- **Optimistic ChainFree**: The mechanism that allows the bot to trade with fill proceeds before they are finalized on-chain.
- **Fill Batch Processing**: Fixed-cap batching for efficient fill processing (`<=4` unified, `>4` chunked)
- **Partial Order Consolidation**: Simplified, direct consolidation through grid rebuilding (no merge/split mechanics)
- **Dust Detection & Management**: Partials below the dust threshold are cancelled on-chain immediately on detection (no delay, no timer)
- **BTS Fee Object Structure**: `netProceeds` field for accounting precision
- **BUY Side Sizing & Fee Accounting**: Correct fee application by order side
- **Mixed Order Fund Validation**: Separate validation for BUY vs SELL order fund checks
- **Fee Management**: Detailed logic for BTS fee reservations and market fee deductions.

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
- **`modules/credit_runtime.ts`**: Bot-scoped debt workflow executor (MPA and credit offer accept/repay/reborrow)
- **`modules/cr_planner.ts`**: Shared collateral-ratio math layer for debt-first planning
- **`modules/order/utils/math.ts`**: Precision conversions, RMS divergence calculation, fund allocation math
- **`modules/order/utils/order.ts`**: Order state predicates, grid indexing, reconciliation helpers, delta building, index utilities
- **`modules/order/utils/validate.ts`**: Order validation, grid reconciliation, COW action building
- **`modules/order/utils/system.ts`**: System utilities, price derivation, fill deduplication
- **`modules/order/grid_reconcile.ts`**: Startup grid reconciliation and offline fill detection ([GRID_RECONCILE.md](GRID_RECONCILE.md))
- **`modules/credential_policy.ts`**: Signing policy validation and operation allowlists

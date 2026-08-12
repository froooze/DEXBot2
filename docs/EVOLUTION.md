# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 1.4.13 stable release.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 1,950 commits over ~8 active months
- **Code Maturity**: Evolution from basic utilities to a ~70,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 247 automated test files
- **Releases**: 94 release entries (v0.1.0 to v1.4.13)

---

## Pre-History: Generational Lineage

DEXBot2 is the third generation of BitShares DEX trading bot development, preceded by two Python-based projects. See [DEXBOT_COMPARISON.md](DEXBOT_COMPARISON.md) for a full architectural comparison.

### Generation 0: StakeMachine (2017)
Proof-of-concept by Fabian Schuh (ChainSquad GmbH). Static buy/sell walls with event-driven subscription model.

### Generation 1: DEXBot Python v1.0.0 (2018–2020)
Production bot by Codaone Oy (worker proposal funded). PyQt5 GUI, three strategies (Staggered Orders, Relative Orders, King of the Hill), CCXT/CoinGecko feeds, SQLite persistence.

**Carried into DEXBot2**: Staggered grid concept, virtual/off-chain order tracking, market center price calculation.

---

## Timeline Overview

### Phase 1: Foundation & Core Architecture (December 2025)
Started Dec 2 with a JavaScript rewrite from the Python DEXBot. Built core trading infrastructure (BitShares client, grid calculation system, fund accounting, order management) and released v0.1.0–v0.3.0 within the first month, establishing the modular architecture, order lifecycle model, and process management that underpin the entire project.

### Phase 2: Stabilization & Advanced Features (January 2026)
Added AMA trend detection, blockchain integer-based precision system, comprehensive test suite, ghost order prevention, self-healing recovery layers, and fund-driven boundary sync. Ported the test suite from Jest to native Node.js assert to eliminate heavy dependencies. Resolved 12+ critical race conditions in fill processing.

### Phase 3: Architecture Refinement & COW Pattern (February 2026)
Implemented Copy-on-Write grid architecture with immutable master grid, atomic boundary shifts, and deadlock resolution. Added multi-node health checking and spread correction redesign with edge-based strategy.

### Phase 4: Market Adapter & Production Hardening (Late Feb - March 2026)
Consolidated the market adapter with split data sources, AMA-derived grid center, fixed-cap fill batching, and credential daemon scaffolding. Replaced cached fund tracking with real-time commitment accounting. Expanded the Claw runtime. Released v0.6.0. This decoupled signal generation from execution — the AMA-derived grid center feeds the order engine as a pure input.

---

### Phase 5: Signal Intelligence, Stable Release & Browser Compatibility (March – June 2026)

The project entered its most transformative phase: a derivative signal engine (dynamic trend-weighting, volatility scaling, regime classification) and a credit/debt MPA runtime were added, the codebase shed all external runtime dependencies while migrating fully to TypeScript, and a security audit of the unlock/daemon stack culminated in the first stable release — v1.0.0 on Jun 16, introducing profile validation, a shared-account fund registry with cross-bot invariants, and proportional collateral allocation. A browser-compatibility transformation followed — portable abstractions, pure-JS crypto, and storage-adapter I/O centralization made 140+ files browser-safe. This produced the multi-layered runtime that still shapes the project: COW order core, signal pipeline, credit/debt MPA runtime, and a browser-compatible core.

### Phase 6: Production Hardening & Iterative Refinement (June – July 2026)

Post-stable work focused on reliability: subscription health watchdogs, broadcast deadlock recovery at bot and daemon level, and documented system invariants. Iterative releases (v1.0.1–v1.3.3) delivered multi-round AMA refits, oversize credit deal splitting, COW broadcast recovery hardening, centralized node-fallback for BROADCAST_DEADLINE, credit-only mode, credential daemon memory fixes, and runtime extraction (COW, fill, state recovery) — an incremental-hardening phase that layered new subsystems (active fill polling, chart controls, HTML order export) onto the existing COW core without altering the core concurrency model.

### Phase 7: Concurrency Model Correction (Late July 2026)

CJS→ESM migration and strict-mode zero-errors across all source files completed the module transition. The v1.4.x releases that followed corrected the concurrency model — centralized `withBlockchainRetry` with node failover, a 4-layer duplicate CREATE guard, reordered lock hierarchy (`_syncLock`/`_gridLock` swap, refcount/stack nesting safety), AsyncLock forceRelease safety, and fund-accounting race hardening — fixing stale COW fund snapshots, phantom-order fund inflation, and the create-cancel loop.

### Phase 8: Uncertain-Broadcast Safety & Truncated-Read Ambiguity (Late July 2026)

v1.4.8 closed the duplicate-order and ambiguity classes found in an order-engine audit of test vs main. Broadcasts are never blindly re-signed — the credential daemon retries only provably-untransmitted failures (per-node pin + rotation + blacklist), and uncertain outcomes surface as typed errors so the COW runtime verifies chain inclusion before re-broadcasting. Truncated `get_full_accounts` reads are treated as ambiguous in every absence decision, so cancel/discard/recovery paths defer instead of freeing slots or capital for possibly-live orders. The COW pipeline also gained bounded stale-plan re-planning and exactly-once working-grid stack discipline.

### Phase 9: Native ESM Runtime & Legacy-Compat Removal (August 2026)

v1.4.12 completed the module transition to native ES modules (root + claw flip to `"type": "module"`, Node >= 22 native WebSocket, dist-first ESM entry shims), removed the remaining one-time upgrade shims and backward-compat paths, and pruned dead constants/helpers. Post-release hardening smoothed the migration's rough edges: a Node 22.14 require-cycle boot deadlock, a fill-runtime require-binding stall, phantom residuals from un-batched same-order fills, stranded chain dust after sub-dust fills, and duplicate-orphan self-healing that double-cancelled or stranded funds.

### Phase 10: Broadcast Serialization, Start Canonicalization & Onboarding (August 2026)

v1.4.13 added a single-flight guard that serializes overlapping COW broadcasts (preventing orphan fills), closed fill-lock bypasses, hardened the no-ALS AsyncLock fallback, fixed ESM packaging gaps (engines `>=22.12.0`, `exports` map, browser classification), promoted `dexbot start` to the canonical launch command, stripped residual TUI-dashboard references, and added a BitShares onboarding tutorial for new users.

---

## Development Statistics

The project has accumulated 247 automated test files across 94 release entries. See the **Version History** below for a per-release commit breakdown.

---

## Technical Challenges & Solutions

| Challenge | Solution | Impact |
|-----------|----------|--------|
| Race conditions in fill processing | AsyncLock pattern with atomic operations | Eliminated 12+ critical race conditions |
| Float precision in order sizes | Blockchain integer-based calculations (satoshi integers) | Deterministic behavior matching chain storage |
| Ghost orders (tiny remainders from partial fills) | Integer-based full-fill detection | Prevented stuck orders and fund drift |
| Grid corruption during divergence | Copy-on-Write with atomic boundary shifts | Safe concurrent modifications, no data loss |
| BTS fee accounting drift | Unified fee deduction model | Accurate fee tracking across all operations |
| Rapid-restart cascading failures | Layer 1 & Layer 2 self-healing defenses | Stable restart with automatic recovery |

---

## Documentation & Testing

Evolved from a basic README to a comprehensive framework (50+ docs entries, 80%+ JSDoc coverage, AGENTS.md). Testing matured from manual blockchain trials → Jest → lightweight Node.js assert across a 234-file suite covering unit, integration, simulation, and COW architectural guard tests.

---

## Conclusion

DEXBot2 has matured from a basic grid bot into a signal-intelligent, production-ready trading system.

---

## Post-1.0.0: Completed

- **Browser Compatibility**: Portable abstractions, pure-JS crypto, 140+ file refactor for browser-safe surface
- **Credit/MPA Runtime**: Multi-asset collateral support, stale reborrow fixes, oversize deal splitting with per-operation caps
- **I/O Centralization**: Full pipeline routed through storage adapter, shared atomic utilities across 20+ files
- **Self-Healing**: Structural resync, subscription watchdog, broadcast deadlock recovery at both bot and daemon level
- **Performance Analytics**: Kibana-driven FIFO/sequential trade PnL with 16 metrics
- **AMA Refits**: Multi-round parameter optimization with per-market weights and distance scaling
- **System Invariants**: Comprehensive documented invariants across all subsystems (COW, sync, grid, reconciliation)
- **Bot Identity**: Unique name enforcement with migration support
- **Credit-Only Mode**: Runtime-only operation for MPA/credit workflows without grid trading infrastructure
- **Docker Support**: Container build, release images, and secure container startup guidance
- **npm Package**: Published as npm package with versioned releases, lockfile sync, and dependency management
- **Grid Order Engine Hardening**: COW pipeline, zero-amount order prevention, fill batching, dust detection, spread correction, and deadlock recovery

## Post-1.0.0: Planned

- **Backtesting Engine**: Historical candle replay through the trading engine via exchange abstraction
- **Injectable Interfaces**: Dependency inversion at call boundaries for improved testability
- **Database + Validation**: SQLite persistence with Zod schema validation at the blockchain boundary
- **Telegram Bot**: built-in, owner-gated Telegram control surface bundled into DEXBot2 — a thin relay module that forwards intents into DEXBot2's hardened paths. Monitoring (`/status`, `/orders`, `/grid`, `/balance`, alerts) is owner-gated; control (`/start`, `/stop`, `/pause`, `/set`) requires an explicit opt-in plus a confirm step; DEXBot is the only writer and private keys never reach the module. Config via `TELEGRAM` block + `DEXBOT_TELEGRAM_TOKEN` env.

## Version History

Compact view; per-commit detail lives in [CHANGELOG.md](../CHANGELOG.md).

| Release | Commits | Theme |
|---------|--------:|-------|
| v0.1.0 → v0.2.0 | 29 | Core order/fund management, docs, tooling |
| v0.2.0 → v0.3.0 | 155 | Fund mgmt & BTS fees, grid divergence, persistence, race conditions |
| v0.3.0 → v0.4.0 | 18 | Fund consolidation, grid sizing/quantization, partial orders |
| v0.4.0 → v0.5.0 | 92 | AsyncLock race prevention, fill dedup, dust recovery, spread correction |
| v0.5.0 → v0.6.0 | 598 | COW architecture, strategy/sync engine, credential daemon, AMA prototype |
| v0.6.0 → v0.7.0 | 325 | AMA market adapter, credit/MPA debt runtime, analysis suite |
| v0.7.0 → v0.7.4 | 12 | AMA/Kalman stability, Docker launcher, docs refresh |
| v0.7.4 → v0.7.5 | 93 | Zero-dependency & TS migration, native BitShares, fill detection overhaul |
| v0.7.5 → v0.7.8 | 18 | Unlock/launcher hardening, background daemon, MPA `debtOnly` |
| v0.7.8 → v0.7.11 | 33 | Runtime self-healing, COW integrity, foreign-daemon defense, CLI polish |
| v0.7.11 → v0.7.15 | 31 | CLI/terminal polish, TradingView, CEX seeding, pipeline hardening |
| v0.7.15 → v0.7.18 | 19 | Build/dir centralization, `@ts-nocheck` removal, timeout hardening, DRY |
| v0.7.18 → v1.0.0 | 103 | First stable: profile validation, logging, credential security, browser compat |
| v1.0.0 → v1.0.4 | 15 | Auto-update hardening, candle gap repair, update-script fixes |
| v1.0.4 → v1.0.7 | 13 | Grid "one order per price" invariant, subscription watchdog, broadcast deadlock fix |
| v1.0.7 → v1.0.9 | 9 | Pending-broadcast deadlock, log dedup, trade PnL analysis tool |
| v1.0.9 → v1.0.11 | 20 | PnL metrics overhaul, live `bots.json`, BitShares market fee model |
| v1.0.11 → v1.0.13 | 17 | Whitelist normalization, grid persistence safety net, dust pipeline fix, net inventory lots |
| v1.0.13 → v1.0.14 | 4 | Per-bot runtime settings override pipeline, doc alignment & chart fix |
| v1.0.14 → v1.1.0 | 7 | Unique bot names, stable ID removal, migration script, duplicate name enforcement |
| v1.1.0 → v1.1.1 | 1 | Auto-startup migration, error handling, JSON-key tracking, cleanup |
| v1.1.1 → v1.1.2 | 1 | AMA refit (λ=0.0022/step=0.0002), optimizer chart output, constant tuning, doc sync |
| v1.1.2 → v1.1.3 | 4 | AMA refit (λ=0.0025/step=0.0003), per-AMA distance weights, tsx-CJS export fix, amaS% retune 0.085→0.08, doc sync |
| v1.1.3 → v1.1.4 | 3 | AMA4 slow correction 107.4→102.4, optimizer range 50-200→40-160, post-tag doc sync |
| v1.1.4 → v1.1.5 | 2 | AMA refit (per-AMA λ weights, SMA-warmup optimizer, slow 62.1/71.7/82.7/95.5), `maxBorrowAmountPerOperation` + oversized-deal splitter |
| v1.1.5 → v1.1.6 | 1 | amaS% revert 0.08→0.085 |
| v1.1.6 → v1.1.7 | 4 | Dust cancel hardening, bootstrap lifecycle fixes, lock reduction, order analysis AMA key, doc cleanup |
| v1.1.7 → v1.1.8 | 6 | HTML order export, chart controls, lambda-vs-slow script, doc cleanup |
| v1.1.8 → v1.1.9 | 6 | Immediate dust cancel, duplicate price guard, stale-cleaned simplification, dedup/lock cleanup, order analyzer formatting |
| v1.1.9 → v1.1.10 | 4 | Asymmetric bounds/dynamic-weight flag decoupling, propagation fixes, `stats` CLI alias, range/weight indicators in status output |
| v1.1.10 → v1.1.11 | 3 | npm publish prep, README install options, `.npmrc` ignore, sync log clarity |
| v1.1.11 → v1.1.12 | 5 | Committed order protection, ghost order cleanup, price correction queue, AMA config centralization, XRP-BTS default removal |
| v1.1.12 → v1.1.13 | 7 | COW recovery hardening (UPDATE→CREATE fallback, fresh-snapshot recovery, persisted-grid reload), fee cache persistence, node fallback, orphan-fill death spiral fix, duplicate order prevention, committed-order protection extension |
| v1.1.13 → v1.1.14 | 5 | Node-failure blacklist sync, async-lock forceRelease safety, six gap regression fixes, browser-compat classification, bin path cleanup |
| v1.1.14 → v1.2.0 | 11 | Credit-only mode, boundary shift recovery, order system hardening (stale broadcast flag, orphan-fill tolerance, grid-bloat resync, AsyncLock re-entrancy), parallel node connect, subscription re-entrancy guards, fund accounting stale-fetch guard, credit runtime TTL caching, transaction builder LRU fee cache, COW auto-cancel test coverage |
| v1.2.0 → v1.2.1 | 8 | Adopt-boundary shift fix, stale accountTotals no-harden-abort, credential daemon memory leak, order correction reliability (dedup orphan cancels, retry on transient errors, skip redundant fallback), StateManager inline refactor, SyncResult type unification, code-review fixes (timer leaks, dead args, orphaned mutations, false recovery, side-effect impure getter) |
| v1.2.1 → v1.2.2 | 4 | Invariant sabotage vector prevention (ghost-order, TOCTOU, fee over-credit), regression hardening (skipAccounting, committed-order escapes, stale fee fallback), code-review cleanup |
| v1.2.2 → v1.2.3 | 5 | Uncertain-broadcast grid corruption fix (discarded CREATE slot recovery), unmatched-order adoption via `syncFromOpenOrders`, grid-bloat loop fix (full-rail false-positive, stale SPREAD type, empty-side correction, boundary-at-rail-edge), budget-dilution fix (virtual-slot exclusion), budget-cap regression fix, COW structural-resync safeguard, test updates |
| v1.2.3 → v1.2.4 | 1 | Credential daemon memory — signing client cache (30-min TTL, fingerprint-based key rotation, dispose-then-delete contract), session purge interval, shallow policy copy, audit-log microtask reduction |
| v1.2.4 → v1.2.5 | 3 | Redundant open-orders sync fix, supervisor updater override, waitForStableStartup event-loop hang fix, unref credit/dust intervals, base58 deduplication, key_store delegation cleanup, launch_modes clawOnly fix, test alignment |
| v1.2.5 → v1.2.6 | 4 | Batch fill sync, crash-durable dedup, ghost batch cancel, config overrides, code-review fixes, EVOLUTION.md doc fix |
| v1.2.6 → v1.2.7 | 1 | `node dexbot` → `dexbot` across all docs/CLI text, `npm i -g dexbot`, ALS re-entrancy test fix |
| v1.2.7 → v1.3.0 | 1 | `dexbot unlock`/`dexbot pm2` rebranding, docstring sweep across 53 files, browser-field `market_adapter.js` exclusion, stale `typeof __filename` guard removal |
| v1.3.0 → v1.3.1 | 6 | Repo-root symlinks (`./dexbot`/`./pm2`/`./unlock`), CLI canonical naming `keys`/`bots`→`key`/`bot`, browser exclusion completeness (logger, paths, system), README `npm link` fix + Quick Start dedup |
| v1.3.1 → v1.3.2 | 6 | Startup dust health check, lightweight sync RMS/chain-filter fixes, dust-handling lock-safe cancel, `dexbot stat` CLI fix, capital allocation docs, README polish |
| v1.3.2 → v1.3.3 | 12 | Runtime extraction (COW, fill, state recovery), dead-import cleanup, profile resolution fix, credential daemon hardening, pretest hook, EVOLUTION.md refresh |
| v1.3.3 → v1.4.0 | 13 | CJS→ESM migration completion, strict-mode zero-errors, daemon-signing node failover, ghost-order cancellation, subscription keepalive fix, price-collision guard centralization, review-concerns dedup & runtime keys export, active fill polling |
| v1.4.0 → v1.4.1 | 8 | withBlockchainRetry centralization + node failover, 4-layer duplicate CREATE guard, fresh-grid excess cancel fix, timeout death spiral fix, spread correction type filter, dead PARTIAL filter cleanup, Phase 3 stale surplus cancellation |
| v1.4.1 → v1.4.2 | 3 | Spread correction direction bias removal, precision-based price collision guard, stale-node defense completion |
| v1.4.2 → v1.4.3 | 5 | Boundary-shift state preservation across failed COW commits, SPREAD→BUY crosser handling, per-batch tolerance violation filter (no full abort), precision-0 tolerance overflow fix, poolRef pinned-pool price derivation, withTimeout utility extraction + circular dep fix |
| v1.4.3 → v1.4.4 | 4 | COW invariant enforcement (retry on failed boundary-shift commit, no master patching), COW pipeline code review fixes, grid engine consolidation (deduplication, dead code removal, export cleanup), UNC-016 recovery test mock fix |
| v1.4.4 → v1.4.5 | 2 | Code-review hardening: AsyncLock forceRelease safety, grid update fatal error guard, persist write failure handling, TOCTOU stale price fix, re-entrancy deadlock removal, circular dependency breakage, uncommitted boundary classification fix, dead code cleanup |
| v1.4.5 → v1.4.6 | 8 | AsyncLock re-entrancy fix, grid type reassignment on load, refcount/stack hardening of state fields, lock hierarchy correction, stale COW fund snapshot fix, gapSlots persistence, phantom fund inflation fix, boundary shift cap |
| v1.4.6 → v1.4.7 | 5 | Fund accounting race hardening, phantom-order startup inflation fix, create-cancel loop fix, negative free balance ordering, GRID_RECONCILE.md |
| v1.4.7 → v1.4.8 | 26 | Uncertain-broadcast duplicate-order safety (verify-before-retry, per-node retry pin + blacklist), truncated-read ambiguity deferral (readOpenOrdersWithMeta), COW stale-plan replan + working-grid stack discipline, fill-authoritative rework, sell-rail re-anchor, orphan auto-cancel wiring, fill-batch fund-invariant deferral |
| v1.4.8 → v1.4.9 | 2 | LP-collateral credit conversion rate via AMM (pool-derived source), flat CLI aliases (dexbot stop/restart/delete) for monolithic unlock controls |
| v1.4.9 → v1.4.10 | 10 | Empty-slot normalization and spread boundary promotion, LP pool-share supply pricing fix, spread check independent of divergence, boundary-slot reconcile re-derivation, validation/broadcast dedup refactor, credit-unlock background daemon, test-suite runtime cut |
| v1.4.10 → v1.4.11 | 8 | Minimum-slots guard for grid range scaling, monolithic restart restarts credential daemon, dexbot start→unlock alias + runtime-layout-aware unlock spawn fix, dead COW/diagnostic code prune, GRID_RECONCILE.md exposure, Telegram docs, CLI test retargeting to `dexbot test`, `dexbot status` reporting a surviving credential daemon after `stop` |
| v1.4.11 → v1.4.12 | 21 | Full ESM migration (root + claw `"type": "module"`, dist-first entry shims, Node >= 22 native WebSocket, `ws` dep removal), legacy-compat removal (fs_utils shim, migrate_bot_keys, legacy daemon protocol, pre-1.1.0 wrapper migration, price-source/debtPolicy aliases), dead-code prune + re-entrancy guard restore, claw build aligned with root, 80 test typecheck errors fixed, ESM-cycle boot fix for Node 22.14, fill-runtime require-binding restore, same-order fill batching restore, residual-dust cancel, duplicate-orphan self-heal dedup + ORDER_GONE fund release, ESM direct-run guards + editor tsconfig coverage |
| v1.4.12 → v1.4.13 | 4 | COW broadcast serialization, fill-lock bypass guards, no-ALS AsyncLock hardening, ESM packaging gaps, `dexbot start` canonicalization, TUI-dashboard reference removal, BitShares onboarding tutorial, npm claw coverage |

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: August 12, 2026 (v1.4.13)
**Total Commits**: 1,999
**Date Range**: December 2, 2025 – August 12, 2026
**Repository**: DEXBot2 (BitShares DEX Trading Bot)

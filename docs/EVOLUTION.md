# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 1.7.1 release.

### Key Milestones
- **Project Inception**: December 2, 2025
- **Growth Phase**: 2,492 commits over ~9 active months
- **Code Maturity**: Evolution from basic utilities to a ~100,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 353 automated test files (14 live tests skipped)
- **Releases**: 152 version entries in the changelog (v0.1.0 to v1.7.1)

> **Post-1.0.0 "why":** the thematic story behind the hardening releases — root cause, recurring
> bug families, and lessons — lives in
> [ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md](ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md).
> This report stays chronological.

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

The project entered its most transformative phase: a derivative signal engine (dynamic trend-weighting, volatility scaling, regime classification) and a credit/debt MPA runtime were added, the codebase shed all external runtime dependencies while migrating fully to TypeScript, and a security audit of the unlock/daemon stack culminated in the first stable release — v1.0.0 on Jun 16 (profile validation, shared-account fund registry, proportional collateral). A browser-compatibility pass (portable abstractions, pure-JS crypto, storage-adapter I/O) made 140+ files browser-safe.

### Phase 6: Production Hardening & Iterative Refinement (June – July 2026)

Post-stable work focused on reliability: subscription watchdogs, broadcast deadlock recovery at bot and daemon level, and documented system invariants. Iterative releases (v1.0.1–v1.3.3) delivered multi-round AMA refits, oversize credit deal splitting, COW recovery hardening, centralized node-fallback, credit-only mode, and runtime extraction (COW, fill, state recovery) — an incremental-hardening phase that layered new subsystems onto the existing COW core without altering its concurrency model.

### Phase 7: COW Concurrency & Uncertain-Broadcast Hardening (Late July 2026)

After the CJS→ESM migration completed the module transition, the early v1.4.x releases corrected the COW concurrency model — centralized `withBlockchainRetry` with node failover, duplicate-CREATE guards, lock-hierarchy fixes, and fund-accounting race hardening — eliminating stale fund snapshots, phantom-order inflation, and the create-cancel loop. v1.4.8 then closed the uncertain-broadcast and truncated-read ambiguity classes: broadcasts are never blindly re-signed (retries only after verifying chain inclusion), and truncate-ambiguous reads defer cancel/discard decisions instead of freeing slots or capital for possibly-live orders.

### Phase 8: Native ESM Runtime, Broadcast Serialization & Onboarding (August 2026)

v1.4.12 completed the module transition to native ES modules (root + claw `"type": "module"`, Node >= 22 native WebSocket), removed the remaining legacy-compat shims, and pruned dead code. v1.4.13 followed with a single-flight guard that serializes overlapping COW broadcasts (preventing orphan fills), fill-lock bypass closures, `dexbot start` as the canonical launch command, and a BitShares onboarding tutorial.

### Phase 9: Post-ESM Cleanup, Consolidation & Hardening (August 2026)

The post-ESM releases consolidated state, packaging, and tooling while hardening the grid engine — profile state on a resolver-derived `~/.config/dexbot2` dir, in-place order rotations, npm auto-update, dead-code purge, and a compile-first runtime (tsx removed; every entry point and the test suite run compiled `dist` under plain node). Grid work capped COW broadcasts and chunked retry-on-uncertain, gated boundary promotion and persisted-restore against gap-floor poison, fixed spread-collapse via the shared `isSlotInRail` filter, and cleared silent-failure defects from a modules-wide audit. **v1.4.24** fixed native fill-gap recovery and LP pricing; **v1.4.25** froze genesis price-slots and hardened orphan/self-trade/fill-guard/shutdown paths.

---

## Architecture Deep-Dive: COW & Memory Tracking

Two mechanisms shaped the order engine after the browser/TypeScript era: the Copy-on-Write grid
and the memory-only integer tracking model. The construction detail that used to live in
`COPY_ON_WRITE_MASTER_PLAN.md` and `architecture.md` is recorded here; those docs now describe
only the current design.

### Copy-on-Write: three eras

- **Era 0 — original optimistic state (pre-v1.0):** the master grid was mutated directly during
  planning, with no isolation or rollback. A sudden market move corrupted in-flight state (the
  "Price Jump" incident — planning mutations applied straight to the master grid).
- **Era 1 — frozen master state (v1.0):** `Object.freeze()` on the master Map and `deepFreeze()`
  on order objects; every `_applyOrderUpdate` creates a new frozen Map via the immutable-swap
  pattern. Retained as defense-in-depth — it catches accidental in-place mutation of
  `manager.orders`.
- **Era 2 — Copy-on-Write (v2.0, current):** clone the master into a `WorkingGrid`, plan and
  broadcast on the clone, commit atomically on blockchain success (discard on failure). True
  transactional semantics; the master is never in an intermediate state.

The production code layers Era 1 and Era 2: freeze provides runtime mutation enforcement, COW
provides the plan → broadcast → commit/discard lifecycle.

### COW construction milestones (February–April 2026)

- `modules/order/working_grid.ts` (`WorkingGrid`: clone, delta, stale tracking) and
  `COW_PERFORMANCE` thresholds added.
- `performSafeRebalance` → `_applySafeRebalanceCOW`; `buildDelta`; `_commitWorkingGrid` atomic
  swap.
- COW broadcast path (`_updateOrdersOnChainBatchCOW`); legacy rollback code removed.
- Selective-abort fill strategy: individual fills continue, full-side updates block.
- Divergence corrections and `updateGridFromBlockchainSnapshot` migrated to the COW pattern.
- Atomic boundary shifts (patch 20): `pendingBoundaryIdx` carries boundary changes through the
  pipeline and applies them only at `_commitWorkingGrid`, so boundary position and slot BUY/SELL
  roles never transiently disagree during blockchain execution.
- Validation suites added: COW core, commit-guard, concurrent-fill, divergence-correction, and
  stale-plan/stack-discipline tests.

### Memory-only integer tracking

- **Raw order cache (`rawOnChain`):** grid slots store the exact blockchain order integers
  (satoshis); seeded from broadcast arguments on placement, updated in place on partial fills,
  refreshed on updates/rotations.
- **Chain-free planning:** redundant `readOpenOrders()` calls were removed from the size-update
  and rotation builders (`_buildSizeUpdateOps()`, `_buildRotationOps()`), and the
  `computeVirtualOpenOrders()` virtual-order computation was dropped; `buildUpdateOrderOp`
  gained an optional `cachedOrder` and returns `finalInts`.
- **Result:** batch updates and rotations run without blockchain fetches; only placements and
  recovery syncs query the chain (~10–20× faster high-frequency operations).
- **Self-healing:** a failed memory-driven transaction triggers a full state-recovery sync so the
  internal ledger stays consistent with the chain.

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

Evolved from a basic README to a comprehensive framework (50+ docs entries, 80%+ JSDoc coverage, AGENTS.md). Testing matured from manual blockchain trials → Jest → lightweight Node.js assert across the current suite covering unit, integration, simulation, and COW architectural guard tests.

---

## Post-1.0.0 Status

**Completed**: browser-safe core; credit/MPA runtime; storage-adapter I/O centralization; self-healing recovery; Kibana PnL analytics — terminal analyzer plus the self-contained HTML report behind `dexbot pnl` (`analysis/pnl_report.ts`), backed by a per-account month-shard fill cache (`analysis/fills_cache.ts`); credit-only mode; Docker support; npm package. For the grid order engine arc specifically (COW pipeline, orphan/self-trade/fill-guard hardening, invariants) see [ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md](ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md) §R4.

**Planned**: backtesting engine (historical candle replay via exchange abstraction); injectable interfaces at call boundaries; SQLite persistence + Zod validation at the blockchain boundary.

## Version History

Compact, era-level view; commit counts are `git rev-list --count <tag>..<tag>` over the current history (2026-11-04). The 107 commits up to and including the `v0.1.0` tag are not attributed to an era, so the current totals are 2,385 (`v0.1.0..HEAD`) and 2,492 (`HEAD`); the `v1.4.x` era rows overlap slightly because `v1.4.13` is not an ancestor of `v1.4.25` in the current history. Per-release detail lives in [CHANGELOG.md](../CHANGELOG.md); the thematic post-1.0.0 story in [ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md](ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md).

| Era | Commits | Theme |
|-----|--------:|-------|
| v0.1.0 → v0.6.0 | 892 | Foundation → COW architecture, strategy/sync engine, credential daemon, AMA prototype, credit/MPA runtime |
| v0.6.0 → v1.0.0 | 650 | Zero-dependency & TS migration, native BitShares, fill-detection overhaul, first stable release |
| v1.0.0 → v1.3.3 | 210 | Post-stable hardening, PnL analytics, auto-update, broadcast-deadlock fixes, AMA refits, credit-only mode, COW recovery hardening, runtime extraction |
| v1.3.3 → v1.4.13 | 141 | CJS→ESM completion, concurrency correction, uncertain-broadcast & truncated-read safety, native ESM runtime, broadcast serialization, onboarding |
| v1.4.13 → v1.4.25 | 129 | Profile-state centralization, consolidation, per-broadcast op cap, grid boundary/recovery hardening, tsx removal, genesis-frozen price-slots, self-trade & orphan fixes |
| v1.4.25 → v1.5.3 | 45 | Credit overview + whitelist-scoped CR, TradingView tooling, daemon-safe reload, gap-evacuation/rail-hole hardening, sync adoption hardening, boundary ownership |
| v1.5.3 → v1.6.0 | 39 | Node-failure ledger, grid regeneration, reserve ladder, live-config pickup, owed-crawl persistence, fill-anchored boundary recovery, TradingView overlay |
| v1.6.0 → v1.6.3 | 17 | Never-run-stale hardening, whitelist range-scaling opt-in, grid-price invariant, shard candle cache, correction-queue staleness, final pre-broadcast pivot gate |
| v1.6.3 → v1.6.4 | 19 | Fund-driven spread correction, batched correction cap, RMS divergence, invariant-doc contract, shared analysis modules, window-aware profitability, portable chart exports, range-threshold restore, dead-code purge |
| v1.6.4 → v1.6.5 | 16 | Editor-managed whitelist flags, centralized bot defaults/settings, log-symmetric range tilt, AMA gridPrice normalization, Pool/Health cues, AMA-slope Δ knob, dynamic-weight CLI, update self-heal, RMS log tagging |
| v1.6.5 → v1.6.6 | 13 | Stale-cancellation guard hardening, editor/CLI realignment, poolRef aliases + startPrice priority, legacy SMA/MACD/RSI analyzer archived, run-relative candle-cache migration dropped, dist-freshness exclude fix |
| v1.6.6 → v1.6.7 | 11 | Session/fill-channel recovery, clean-process ecosystem regen, onboarding redirect and key-manager link fixes, LAST-FILL-GUARD pivot persistence |
| v1.6.7 → v1.6.8 | 14 | Correction-drain budget + broadcast-deferral bounds, PM2 log capture + rotation, passive version notice, genesis-ladder refusal, reserve window exclusion, legacy tolerance-matcher removal, npm-tarball trim, TV grid-reset replay, bounded Kibana tail refresh, 1.4x range-threshold widening |
| v1.6.8 → v1.6.9 | 6 | Market-adapter cycle-CPU cuts, candle-boundary off-hour idle, spread-correction spread-tightening guard |
| v1.6.9 → v1.6.10 | 7 | Huber-robust AMA slope, asset-pair uppercase canonicalization, TradingView indicator ownership (auto opt-in, span bounds) and chart-view preservation |
| v1.6.10 → v1.6.11 | 6 | AMA-slope 3-bar persistence gate + 16h Huber lookback, EMA-smoothing removal, PnL HTML report + month-shard fill cache, five order-engine/lifecycle safety fixes |
| v1.6.11 → v1.6.12 | 27 | Explicit-`any` elimination + ratchet, shared ECC core & Firefox-safe pure-JS scrypt, worker-drain and fresh-placement cancel-grace safety fixes, funded spread correction, partial credit renewal, update install-layout classifier, AMA persistence-override fixes, test-suite speedup, dynamic-weight knob retune |
| v1.6.12 → v1.6.13 | 21 | Spread-stall cause reporting + chain sync on every stall, resync-cascade guards (uncertain broadcast / suspended persistence), month-shard candle cache, dedup & dead-code purge, npm 12 install & PM2 fixes |
| v1.6.13 → v1.6.14 | 18 | Last-fill guard + live market floor for spread correction, committed-size drift resize, COW pre-broadcast guards & P2 counters, fail-closed unknown geometry, order-key rename, worker-thread test runner |
| v1.6.14 → v1.6.15 | 20 | Spread-correction resilience (atomic plan/retry, bounded re-plan, transient-refusal grace), price-vs-amount level identity for low-precision assets, credit-renewal free-collateral top-up, TradingView 1h/chart fixes & live data-age badge, per-asset `dexbot rich`, ~4x parallel test runner |
| v1.6.15 → v1.6.16 | 14 | Monolithic per-bot control routing, orientation-shared candle cache, market-profile orientation tolerance, chart log-axis hang fix + viewport-clipped draw hooks, Firefox Playwright chart suite, adapter-whitelist rename/copy sync, `dexbot rich` symbol canonicalization, doc reconciliation |
| v1.6.16 → v1.6.17 | 11 | Last-fill direction guard, placeable-slot spread planning with named stalls, chain-truth funding + fill-anchored boundary re-anchor, owed-crawl consumption, restart auth-before-stop with cleared vault secret, pool-priced LP-share collateral, AMA slowPeriod/slope retune, BTS & per-token supply distribution analyzers |
| v1.6.17 → v1.6.18 | 19 | Partial-fill re-anchor recovery (stale-evac skip, residual allow-list, crawl subsumption, rotation-only repair), rail-derived boundary + live fill/chain prices, edge-fill pivot exclusion, guard arity pinning with explicit re-arm, per-slot last-fill exclusion count, CLI `--flag=value` walker, `__test` seam guard, export-surface cleanup |
| v1.6.18 → v1.7.0 | 11 | Liquidity depth chart + `dexbot liquid`/`liq`/`liqu`, `dexbot asset` supply distribution shortcut, pool id/pool-token chart targets + shared spawn runner, case-insensitive asset lookup, asset-report chain-request cuts, shared CLI terminal output, orphan-fill attribution + dark-level revive, stale-grid re-buy discipline, pivot clock provenance & read-time TTL |
| v1.7.0 → v1.7.1 | 22 | One existence record per slot (life-cycle registry, unknown-is-never-gone), typed three-valued broadcast outcome, timing-window policy inventory, reconciliation interleaving fuzzer, one writer per life-cycle clock, serialized placement region with lease re-verification, fill-marker idempotency, forced-retreat gap evacuation + committed-geometry sweep, unknown-gap-geometry fix, replay-safe stranded-boundary repair, stability-ranked node selection + flap scoring, chain-account `<bot>` targets for `credit`/`order`, fee-adjusted pool depth chart with both spreads, atomic branch promotion preflight |

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: November 4, 2026
**Total Commits**: 2,492
**Date Range**: December 2, 2025 – November 4, 2026
**Repository**: DEXBot2 (BitShares DEX Trading Bot)

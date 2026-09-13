# DEXBot2 Evolution Report

## Executive Summary

DEXBot2 is a sophisticated decentralized exchange trading bot for the BitShares blockchain. This report documents the complete evolution of the project from its inception in December 2025 through the current 1.6.1 stable release.

### Key Milestones
- **Project Inception**: December 2, 2025
 - **Growth Phase**: 2,215 commits over ~9 active months
- **Code Maturity**: Evolution from basic utilities to a ~100,000+ LoC intelligent TypeScript system
- **Stability**: Progression from manual testing to a suite of 280 automated test files
- **Releases**: 105 release entries (v0.1.0 to v1.6.1)

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

The post-ESM releases consolidated state, code, and tooling while hardening the grid engine. **State & packaging** (v1.4.14–v1.4.17): all user/runtime state centralized on a resolver-derived profiles dir (`~/.config/dexbot2/profiles`) safe from re-clones, read-only prefixes, and npm wipes; divergence surplus/hole pairs became in-place order rotations; npm auto-update shipped; duplicated EC-crypto/settings/asset-resolution code collapsed; dead exports purged; analysis tooling moved under strict TypeScript. **Grid hardening** (v1.4.19–v1.4.21): COW broadcasts capped at `MAX_OPS_PER_BROADCAST` (4) with chunked retry-on-uncertain; boundary promotion and persisted-boundary restore gated against gap-floor overrun poison behind a shared sell-rail ceiling enforced at commit and restore time; spread-collapse fixed via the shared `isSlotInRail` filter; silent-failure runtime defects from a modules-wide audit fixed (NaN fund-invariant tolerance, always-flush fill store, double-decremented fill guard). **Tooling & UX** (v1.4.20–v1.4.22): live/research clip parity with centralized chart sliders and analysis outputs on the central path resolver; claw logic deduplicated with hardened error paths; browser storage adapter persists deletions; editor green/red input feedback extended to funds and prices; compile-first runtime completed — tsx removed entirely, every entry point and the test suite running compiled dist under plain node through frozen-ESM-safe seams, plus exact AMA cold-start bootstrap sizing and research tools unified onto production slope/bounds math. Post-v1.4.22 work followed the same themes: bot-fitting backtests re-modeled on the production grid lifecycle, analysis tooling consolidated onto market_adapter sources, Kibana proxy-reset hardening, and TradingView price-axis interaction. **v1.4.24** fixed native fill-gap recovery and LP pricing; **v1.4.25** freezes genesis price-slots and hardens grid orphan/self-trade/fill-guard/shutdown paths, plus whitelist scoped `--bot` overwrite and Range quality legend.

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

Evolved from a basic README to a comprehensive framework (50+ docs entries, 80%+ JSDoc coverage, AGENTS.md). Testing matured from manual blockchain trials → Jest → lightweight Node.js assert across the current suite covering unit, integration, simulation, and COW architectural guard tests.

---

## Post-1.0.0 Status

**Completed**: browser-safe core (140+ files, portable abstractions, pure-JS crypto); credit/MPA runtime (multi-asset collateral, oversize deal splitting); storage-adapter I/O centralization; self-healing (structural resync, subscription watchdog, bot/daemon broadcast-deadlock recovery); Kibana-driven trade PnL analytics; multi-round AMA refits; documented subsystem invariants; bot identity enforcement; credit-only mode; Docker support; npm package with lockfile sync; hardened grid order engine (COW pipeline, zero-amount prevention, fill batching, dust detection, spread correction).

**Planned**: backtesting engine (historical candle replay via exchange abstraction); injectable interfaces at call boundaries; SQLite persistence + Zod validation at the blockchain boundary; Telegram bot (**not yet implemented**) — owner-gated monitoring (`/status`, `/orders`, `/grid`, `/balance`) and opt-in+confirm gated control (`/start`, `/stop`, `/pause`); DEXBot is the only writer, private keys never reach the module (`TELEGRAM` block + `DEXBOT_TELEGRAM_TOKEN` env).

## Version History

Compact, era-level view; per-release commit detail lives in [CHANGELOG.md](../CHANGELOG.md).

| Era | Commits | Theme |
|-----|--------:|-------|
| v0.1.0 → v0.6.0 | 1,217 | Foundation → COW architecture, strategy/sync engine, credential daemon, AMA prototype, credit/MPA runtime |
| v0.6.0 → v1.0.0 | 309 | Zero-dependency & TS migration, native BitShares, fill detection overhaul, first stable release |
| v1.0.0 → v1.1.0 | 85 | Post-stable hardening, PnL analytics, auto-update, broadcast deadlock fixes |
| v1.1.0 → v1.3.3 | 114 | AMA refits, credit-only mode, COW recovery hardening, runtime extraction |
| v1.3.3 → v1.4.8 | 74 | CJS→ESM completion, concurrency correction, uncertain-broadcast safety, truncated-read ambiguity |
| v1.4.8 → v1.4.13 | 45 | Native ESM runtime, broadcast serialization, onboarding |
| v1.4.13 → v1.4.19 | 36 | Profile-state centralization, code consolidation, per-broadcast op cap |
| v1.4.19 → v1.4.20 | 5 | Grid boundary promotion hardening, recovery poison gate, analysis output centralization |
| v1.4.20 → v1.4.21 | 15 | Runtime audit fixes, claw dedup hardening, boundary ceiling alignment, editor color feedback |
| v1.4.21 → v1.4.22 | 4 | tsx removal completion (dist-only runtime + tests), exact AMA bootstrap sizing, research-tool production parity |
| v1.4.22 → v1.4.23 | 12 | Even geometric AMA ladder, BTS fee-carve fix, sub-1x price-bound rejection, tradingview axis restore, doc realignment |
| v1.4.23 → v1.4.24 | 3 | Native fill gap recovery with eager coalesced retry, LP collateral offer-first pricing |
| v1.4.24 → v1.4.25 | 26 | Genesis-frozen price-slots, self-trade & fill-guard hardening, orphan & gap-band fixes, trigger/shutdown hardening, bot poll, grid monotonicity gate, whitelist scoped overwrite, Range legend |
| v1.4.25 → v1.5.0 | 13 | Credit overview CLI + whitelist-scoped CR on shared pricing math, one-step TradingView chart, daemon-safe reload, offline account-ID cache, case-insensitive bot identity, stale-pivot guard fix, partial-surplus rotation clamp, adapter ownership centralization, op-77 bot discovery split |
| v1.5.0 → v1.5.1 | 11 | Gap-evacuation guard allowance + rail-typed holes, persisted streaks with cancel-only teeth, vacated-rail refill, adoption/accounting/duplicate-guard hardening |
| v1.5.1 → v1.5.2 | 10 | Sync rejection handling across pass-1/pass-2 adoption, crossing-guard candidate sharing, empty-read confirmation, broadcast-price CREATE validation, stamped gap-evacuation re-proof, credit whole-account display + expiry, offline export fill-block derivation |
| v1.5.2 → v1.5.3 | 6 | Boundary ownership hardening (fund-driven sync removal, guard-skipped refill hold), COW broadcast/reconcile dedup, TradingView bot-grid range highlight, createOrder unknown-id materialize-or-error, curve-comparison docs |
| v1.5.3 → v1.6.0 | 37 | Node-failure strike ledger and broadcast-deferred fill rebalancing, trust-chain free-balance heal with deferred-drain tolerance, bidirectional grid-regeneration trigger, TradingView order overlay and chart pref namespacing, credit short-offer id display, live-config pickup (issue #27), reserve ladder anchored at resolved bounds + live-grid rail edges with single-source ordering and exact-size activation, owed-crawl persistence across refused broadcasts/restarts + hold-aware reload-safe lifecycle, fill-anchored boundary recovery + poisoned persisted-boundary erase, startup rail gate + static-center crawl fold, all `*-deferred` holds non-blocking + hold metrics surfaced, opt-in MPA price-feed charts + range-aware shared candle cache, range-band span parity on grid-less charts, orange range zone widened to 1.40x, docs reserve-ladder sweep, reserve-deficit targeted-sync trigger with window-exclusion counting, matched-surplus startup excess planning, shelf-order guards across reserve classification/placement/startup cancels/size recalc (issue #27 follow-ups), unified Kibana candle cache on runCachedWindows with fetch retry budgets, genuine-coverage LP window reuse, feed volume/AMA timeframe alignment, TradingView monthly candles/stat badges/rigid pan/volume toggle/feed affordance, credit full offer id + empty-pair Curr. CR hiding, live-config onboarding note |
| v1.6.0 → v1.6.1 | 3 | Never-run-stale hardening (level-triggered deferred-fill retry, stale-totals fill parking, out-of-spread watchdog, region-end fan-out, one-sided spread honesty), whitelist range-scaling opt-in defaults, live-save vs reset vs reload docs + power-law paper restructure |

---

**Report Originally Generated**: February 19, 2026
**Last Updated**: September 13, 2026
**Total Commits**: 2,215
**Date Range**: December 2, 2025 – September 13, 2026
**Repository**: DEXBot2 (BitShares DEX Trading Bot)

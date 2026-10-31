# DEXBot2 Order Engine Retrospective (Post-1.0.0)

> Single hub for the order engine's post-stable evolution: a **synthesis** of why it kept
> misbehaving (Part I) and the preserved **incident & fix ledger** (Part II), formerly
> `CONSOLIDATED_ORPHAN_FIX_SUMMARY.md`.
>
> **Sources:** `CHANGELOG.md` v1.0.0 → v1.6.14; `docs/GRID_PRICE_INVARIANT.md`;
> `docs/COW_INVARIANTS.md`. Generic terms only — no live markets, accounts, or order ids.
>
> **Scope / snapshot:** v1.0.0 → v1.6.14 (`f6c0df32`, 2026-10-12); the v1.6.4 → v1.6.14 arc
> is the §9 addendum below.
>
> **Section numbering:** Part II deliberately keeps its original `§0`–`§8` numbers because
> source-code comments and tests cite them (e.g. `… §2 fix #1`, `… §3 lineage`); §9 is a
> later addendum (v1.6.4 → v1.6.14) that extends, and does not renumber, that range. Part I
> uses `R1`–`R5` so the two never collide. The closing appendix is unnumbered (`A`).
>
> **How to read:** start with **Part I** for the explanation; drop into **Part II** when you need
> the per-incident evidence, commit hashes, and verification targets.
>
> **See also:** [GRID_PRICE_INVARIANT.md](GRID_PRICE_INVARIANT.md) ·
> [COW_INVARIANTS.md](COW_INVARIANTS.md) · [GRID_RECONCILE.md](GRID_RECONCILE.md) ·
> [EVOLUTION.md](EVOLUTION.md) · [CHANGELOG.md](../CHANGELOG.md).

---

## Contents

**Part I — Synthesis**
- R1. The one root cause
- R2. Recurring bug families
- R3. Meta-patterns (the actual "madness")
- R4. What actually fixed it
- R5. Lessons

**Part II — Incident & Fix Ledger**
- 0. Terminology
- 1. Gap-Band Orphan — Prevention Plan (P1–P6)
- 2. Ladder Recenter Orphan — Root Cause (Aug 26–30 2026)
- 3. Orphan-Fill & Fund-Invariant — Root Cause & Fix Plan
- 4. Price-First Alignment Plan
- 5. Cross-doc fix lineup (dependency order)
- 6. Consolidated invariants
- 7. Consolidated verification — grid-correction check as regression gate
- 8. Provenance & supersession record
- 9. COW Broadcast, Resync & Geometry Safety (v1.6.4 → v1.6.14) — addendum
  - 9.10 Review pass over v1.6.12 → v1.6.17 (findings P1–P5)
- A. Grid-Price Invariant — former failure trace (appendix)

---

## Part I — Synthesis

### R1. The one root cause

BitShares offers **no atomic grid swap**. The engine can only broadcast cancel /
limit-order-update / create operations over an unreliable network and then *guess* whether
they landed. A lost or ambiguous response — **"uncertain broadcast"** — means the bot either
forgets real orders (**orphans**) or re-places over live ones (**duplicates**). There is no
rollback, so the runtime is a perpetual reconciliation loop trying to infer chain truth from
local state.

**Everything below is fallout from that.**

### R2. Recurring bug families

| Family | Symptom | Representative handling |
|---|---|---|
| **Orphan orders** | Live chain orders absent from local state; locked funds, accidental cancels, re-placement | Adoption, committed-order protection, durable orphan gates — fixed/re-broken repeatedly |
| **Ghost / phantom orders** | Local slot with no real order, or a live order no slot owns; `size > 0` with no `orderId` | Virtualization guards, ghost-order cleanup, dust cancel |
| **Self-trading / crossing** | Re-pricing a BUY above own SELLs (or vice versa) | `LAST-FILL-GUARD` (pivot formula revised twice) + final pre-broadcast pivot gate |
| **Grid-price invariant** | Two sources of truth for a slot price (genesis ladder vs mutable `slot.price`); orphan adoption corrupted the ladder | Enforce ladder price at every emission site; escalate persistent violations to resync |
| **Boundary drift / gap band** | Buy/sell split index moved without matching fills, stranding live orders in the band | Prevention plans P1–P6 landed, then largely reverted; replaced by fill-driven boundary + last-fill guard |
| **Fund-accounting races** | Stale totals, optimistic deductions, "orphan-fill death spiral" | Lag guards, tolerance widening, rebuild-from-chain, invariant escalation |
| **Concurrency / locks** | Non-reentrant lock, force-release orphaned timers, TOCTOU, chunked-broadcast self-fills | Reentrant `AsyncLock`, generation counters, swept-band exclusion |
| **Infinite loops** | grid-bloat → resync → bloat; plan→skip→restore holes; `NO_FEASIBLE_BOUNDARY` freeze | Cooldowns, grace windows, minimal cancel ladders |
| **Silent hangs** | Retries that depended on a future event that never came | Level-triggered scheduling with time-based watchdogs |
| **Stale queues** | Queued price corrections replayed onto a resynced grid, reverting good placements | Pre-broadcast validation against the live slot |
| **Shelf / edge orders** | Non-grid orders poisoning every "orders on grid" counter (issue #27) | Slot-N gating across all counters |

Families **not** detailed in Part II: silent hangs and stale correction queues are covered in
`CHANGELOG.md` (v1.6.1 and v1.6.3 respectively); shelf/edge orders in issue #27 and the v1.6.x
notes; the grid-price invariant has its own doc — [GRID_PRICE_INVARIANT.md](GRID_PRICE_INVARIANT.md).

### R3. Meta-patterns (the actual "madness")

1. **Revert yo-yo.** `MarketAnchor` / `BOUNDARY-EVIDENCE` / `BAND-EXCLUSION` were added
   then reverted. Gap-band sweeps shipped and were pulled after cancelling legitimate
   orders. Part II annotates fixes as `LANDED` / `REVERTED` / `SUPERSEDED`.
2. **Guards on guards.** Each fix exposed a new failure mode, so the engine accumulated
   fallback paths, origin stamps, bypass flags, and tolerance knobs. New bug → another
   guard, rarely a simpler model.
3. **Incident documentation as a genre.** Part II exists because the same classes of bug
   kept returning and the fix plans themselves kept being superseded.
4. **Daemon vs demon.** The literal daemons (credential/signing/node) were boundable —
   socket leaks, shutdown races, node failover. The demons were *policy* for uncertain
   state; you can restart a daemon, you can only *model* an ambiguous broadcast, and the
   model kept being wrong.

### R4. What actually fixed it

- **Genesis-frozen price-slot determinism** (v1.4.25+): `slot-N` → exact ladder price
  becomes the single source of truth, replacing tolerance-based price matching. Killed a
  whole family of orphan/duplicate bugs.
- **Single ownership:** one writer for the boundary, one owner for the adapter/market
  config, one authoritative set of counters.
- **Global last-fill guard + final pre-broadcast gate:** one pivot rule, enforced at the
  last moment before broadcast, with fail-open semantics for unjudgeable ops.
- **Non-destructive recovery (v1.6.13+):** uncertain broadcasts and credential outages
  *defer* instead of rebuilding the grid, so a reset stops being the reflex response to
  ambiguity — see §9.1.
- **Fail-closed geometry (v1.6.14+):** an unknown boundary/gap is no longer coerced to a
  valid-looking `0` — see §9.1.

The winning strategy was **removing writers and sources of truth**, not adding handlers.

### R5. Lessons

1. In a no-atomicity, unreliable-response system, **state reconciliation is the product** —
   treat it as such.
2. Prefer **one source of truth** over many reconcilers with tolerances.
3. Guard at the **last responsible moment** (pre-broadcast), not at every intermediate step.
4. Every new guard is a liability if it is not backed by a **repair path**; self-healing
   beats fail-closed alone.
5. Make deferred work **level-triggered** — never let a retry depend on a future event.
6. If a fix class keeps returning, the model is wrong, not the fix.
7. Treat **ambiguity as deferral, not destruction** — a reset that clears guard state is
   another writer, and `Number(null) === 0` is how "unknown" becomes a confident `0`.

---

## Part II — Incident & Fix Ledger (formerly `CONSOLIDATED_ORPHAN_FIX_SUMMARY.md`)

**What this part is:** the per-incident evidence behind Part I's synthesis — root causes, fix
plans, `LANDED`/`REVERTED`/`SUPERSEDED` statuses, commit hashes, and verification targets.

> **Provenance:** consolidates four superseded test-branch plans, now deleted:
> `GAP_BAND_ORPHAN_PREVENTION_PLAN.md` · `LADDER_RECENTER_ORPHAN_ROOT_CAUSE.md` ·
> `ORPHAN_FILL_INVARIANT_ROOT_CAUSE_AND_FIX.md` · `PRICE_FIRST_ALIGNMENT_PLAN.md`.
> Content is merged in condensed form — incident data, fix lists, invariants, verification targets
> and rollback gates are preserved; some narrative rationale is compressed. The four originals
> were added only on `test`.

**Scope:** `modules/order/{grid,strategy,sync_engine,manager,grid_reconcile*}` · `modules/order/utils/{math,order,system}` · `modules/{dexbot_class,dexbot_cow_runtime,dexbot_maintenance_runtime,dexbot_fill_runtime,dexbot_state_recovery,chain_orders,config,constants,paths}` · `market_adapter` re-anchor triggers · `analysis/grid_correction_check.ts`
**Statuses corrected against `test` HEAD `a54863ca` (2026-08-31), refreshed against `1382f267` (2026-09-13):** the source docs' own wording (`proposed` / `analysis complete` / `investigation complete — fix plan pending` / `Phase 2 flag enabled`) predated later fix commits, so each plan item now carries a `LANDED` / `REVERTED` / `SUPERSEDED` annotation with the implementing commit hash. Key corrections: GAP P1–P5 landed `f94d6ec4` but the P2 sweep was reverted (`3713c496`) and the P1 writer + post-commit assert reverted (`e2898e51`); PRICE_FIRST Phase 2 projection was enabled (`1bbf1a23`) then removed (`3713c496`) — the anchor is shadow telemetry only.

---

### 0. Terminology

**Naming:** instance/order IDs are genericized (`bot-A` = grid bot, `bot-B`/`bot-C` = credit bots, `bot-D/D2` = grid bots; `<order-N>` = `1.7.x`). Same token = same order within a section. Market pairs are genericized as `<pair>`; account names `1.2.x` placeholders.

**Grid terms:** `boundary` = discrete sell/buy split index; `gap band` = `SPREAD/virtual` slots around boundary; `sellStartIdx = splitIdx - floor(gap/2) - 1`; center-priced ladder `createOrderGrid` = `startPrice × step^(k+½)` (`modules/order/grid.ts:441,449`); `MarketAnchor` = fill-derived `lastFillPrice/maxFilledSellPrice/minFilledBuyPrice/lastFillSide`; tolerance helpers `calculatePriceTolerance = (1/satsA+1/satsB)×price` (`modules/order/utils/math.ts:820-824`), `PRICE_TOLERANCE_MAX_PERCENT 0.01` (`constants.ts:461`).

**Validation tool:** `analysis/grid_correction_check.ts` (test-only, mirrors `analysis/trade_profitability.ts` Kibana path `https://kibana.bitshares.dev`, `bitshares-*`, `operation_type:4` `fill_order` only; `buildFillQuery`, paginated `search_after`, `_source` `block_data` fields). **Invariants:** `sell→sell` with no `buy` between must rise (`curr > prev`, equal OK), `buy→buy` must fall (`curr < prev`); `per-order` aggregated default (weighted avg collapses multi-fill `1.7.x`), `--per-fill` raw. Resolution via `bot_key_utils.ts` `loadBotMeta/computeBotKey`. Reports violations, `%`, daily histogram, time/range, table with price/Δ%/times/orderIds; `--json/--csv` export; exit `0` pass / `2` fail. Strict sat-level is ground truth (`--tolerance P` allows `b < a*(1-P/100)` sell / `b > a*(1+P/100)` buy). Used as regression gate below; pre-fix per-account baselines are intentionally omitted here — §7 states the targets (`0` violations).

---

### 1. Gap-Band Orphan — Prevention Plan (P1–P6)

> **Source:** former `GAP_BAND_ORPHAN_PREVENTION_PLAN.md` (deleted 2026-08-31; merged here) · **Status:** implemented `f94d6ec4` (2026-08-29), with subsequent amendments — landing map below.

**Landing map (corrected 2026-08-31):**
- **P1** — landed `f94d6ec4` (same-batch CANCEL injection in `COWRebalanceEngine.execute` + `_assertGapBandIntactPostCommit` cancelOnly). **REVERTED `e2898e51`** ("remove placement guards that interfered with normal operation") — both sites removed; stranding is now handled by `calculateIdealBoundary` + `LAST-FILL-GUARD` + adoption path (P3 gate removed `e7231534`).
- **P2** — landed `f94d6ec4`; **REVERTED `3713c496`** after a live-bot incident (the sweep cancelled two legitimate boundary buys under a stale boundary). In-gap chain orders are now *adopted* by the normal reconcile path once the boundary is re-derived via `calculateIdealBoundary`; cancellation is never used as a self-healing net.
- **P3** — landed `f94d6ec4` (`validateBoundaryAgainstChainEvidence` + reconcile phase-1 gate + `placementsAllowed` adoption-only mode); amended `3713c496` (anchor demoted to non-authoritative hint, can never veto); extended `a54863ca` (NO_FEASIBLE escalates a straddle-cancel ladder instead of freezing). **REVERTED `e7231534`** — `validateBoundaryAgainstChainEvidence` (`grid_reconcile.ts:359`) and `placementsAllowed` (`grid_reconcile_internal.ts:1601`) removed; **current** boundary derives from `calculateIdealBoundary` (`order/utils/order.ts:1216` via `grid.ts:160`) + `LAST-FILL-GUARD` (`manager.ts:1679`/`dexbot_cow_runtime.ts:1624`), not a P3 chain-evidence gate.
- **P4** — landed `f94d6ec4` (`dexbot_state_recovery.ts:581 rejectCorruptedGridSnapshot` clears in-memory + persisted boundary on reject). Live.
- **P5** — landed `f94d6ec4` (skip/defer logging + `STRUCTURAL_RESYNC_MAX_DEFER_MS` force, `dexbot_maintenance_runtime.ts:2242-2266`). Live.
- **P6** — landed `f94d6ec4` (2026-08-29) as boundary chain-evidence regression coverage, since superseded by the boundary-geometry suite (`tests/test_boundary_anchor_recovery.ts`, `tests/test_boundary_restore_validation.ts`) and the slot-invariant guard tests.

#### 1.1 Incident summary

*Incident window: 2026-08-29 09:29–12:00 UTC · `<pair>`, generic `1.2.x`/`1.7.x` ids.*

1. After corrupted-snapshot rejection, recovery restored **stale persisted boundary 131** while true market was ~140+ (`Restored boundary index: 131` then `[RECOVERY][SNAPSHOT-REJECT] drift sell=0.00 buy=2036.67`).
2. With boundary 131, slot-144 was valid sell-rail; startup reconcile adopted/updated unmatched chain sell to slot-144 (`Startup: Updating chain SELL ... -> grid slot-144`), broadcast in 35-op startup batch.
3. Fills swept up; price-anchored boundary correction (`2bc1efe3`) snapped boundary up. Slot-144 fell inside new gap band; local record re-typed `SPREAD/virtual, size->0, orderId=""` (spread normalization) while live chain order stayed inside gap.
4. No cleanup caught it: sync pass-2 only queues `cancelOnly` for orphans duplicating an **active price level** (slot-144 empty → no match); adoption refuses gap slots (`no adoptable slot found`); runtime reconcile only warns (`no active same-side grid order exists`); startup excess-cancel only on `chainCount > targetCount`.
5. Detector fired `09:33:57 GAP-BAND INVARIANT VIOLATION after commit: placed sell slot-136 ...` but only set `structuralResyncRequested`; resync was silently skipped/never ran. Orphan partially filled `09:53, 10:08, 11:36` via `Processing funds for unknown order ...`, fully filled ~12:00 bot offline.

**Core defect:** invariant *"no live order inside gap band"* enforced by detectors/warnings, never by a writer.

#### 1.2 P1 — Cancel in the same batch that strands (highest leverage)

*Status: LANDED `f94d6ec4`; REVERTED `e2898e51` — see landing map.*
- `calculateTargetGrid` (`modules/order/strategy.ts` SPREAD GUARD) already identifies stray in-band slots with live orders and keeps them `BUY/SELL`; comment claims `cancelled by sync pass-1 type-mismatch handling` — never fired. **Change:** emit `cancelOnly` ops for orderId-bearing in-band slots in same COW plan (model: duplicate-price `cancelOnly` at `sync_engine.ts` pass-2).
- Belt-and-braces: `_assertGapBandIntactPostCommit` (`manager.ts`) already collects `problems {id, price}`; on detection immediately queue `cancelOnly` for those ids instead of only flagging. **With P1, incident dies at 09:33:57 — stranded order cancelled same commit.**

#### 1.3 P2 — Gap-band orphan sweep (self-healing net)

*Status: LANDED `f94d6ec4`; REVERTED `3713c496` — replaced by adopt-after-chain-evidence-correction; see landing map.*
- Sync pass-2 (`sync_engine.ts` unmatched-chain branch) + runtime reconcile (`grid_reconcile.ts` phase-1): when unmatched chain price sits **strictly inside implied gap band** (shared `MathUtils.isSlotInRail` geometry test) → queue `cancelOnly` instead of `no adoptable slot found` / `no active same-side grid order exists`. Cleans any already-live orphan within one sync cycle.

#### 1.4 P3 — Never place against an unvalidated boundary (origin)

*Status: LANDED `f94d6ec4`; amended `3713c496`, `a54863ca`; **REVERTED `e7231534`** — gate removed, retained as historical context.*
Poison input was `_restoreBoundary(131)` from stale snapshot; `validatePersistedBoundary` couldn't catch (band empty at restore, stranding created by placement).
- **As landed:** after restore/rebuild, re-derived boundary from chain before placement: placed-order distribution (highest live BUY / lowest live SELL), market anchor, recent fill evidence via `computePriceAnchoredBoundaryTarget` (`order/utils/order.ts`). If derived disagreed beyond threshold, used derived + loud log.
- **Gate (removed):** `_reconcileStartupSide` (`grid_reconcile_internal.ts`) had `placementsAllowed` adoption-only mode — creating/price-updating into rail required boundary validated against chain+fills; without validation → deferred placements. Removed `e7231534` (P3 reverted) and fully deleted as dead code in current determinism cleanup — boundary now via `calculateIdealBoundary` + `LAST-FILL-GUARD`, not chain-evidence veto.

#### 1.5 P4 — Snapshot-reject must discard boundary

*Status: LANDED `f94d6ec4` — live.*
Sequence `Restored boundary index: 131` *then* `[SNAPSHOT-REJECT] Deleting corrupted snapshot` — rejected boundary stayed. In `recoverFromPersistedGrid` (`dexbot_state_recovery.ts`): validate first, restore only on pass; on fail discard boundary with snapshot, fall through to re-derivation (originally P3 `validateBoundaryAgainstChainEvidence`; P3 reverted `e7231534` — now `calculateIdealBoundary` + `LAST-FILL-GUARD`).

#### 1.6 P5 — Structural resync requests must not vanish

*Status: LANDED `f94d6ec4` — live.*
`09:33:57 Requesting structural resync` swallowed (`requestStructuralGridResync` in `dexbot_maintenance_runtime.ts` skips if already scheduled/running, `_batchInFlight` deferral re-arms timer uncapped). Hours unanswered.
- Log every skip/defer with reason; add max-defer deadline forcing resync after re-arms.

#### 1.7 P6 — Regression tests

*Status: LANDED, then superseded — the boundary chain-evidence and geometry assertions are now held by `tests/test_boundary_anchor_recovery.ts` (ANCHOR-001..004) and `tests/test_boundary_restore_validation.ts`.*
- A (P1): stale boundary → startup updates into slot X → boundary snaps past X → assert cancel emitted same batch, no live in-band. (P1 later reverted `e2898e51`.)
- B (P2): seed live orphan strictly inside gap with no duplicate price → sync/reconcile → assert `cancelOnly` within one cycle. (P2 reverted `3713c496`.)
- C (P3/P4): corrupted snapshot stale vs fill evidence → rebuild → assert placements use re-derived boundary, rejected boundary not reused. **Both tests deleted `e7231534`** with P3 revert; P4 behavior now covered by `test_dexbot_state_recovery` + `test_periodic_sync_fill_rebalance`.

#### 1.8 Rollout order

1. **P1+P2+P4** (writer cancel + sweep + reject-discard) — self-enforcing invariant
2. **P5** observability/force
3. **P3** re-derivation gate (largest surface, fast-follow) — **REVERTED `e7231534`** (gate removed; `placementsAllowed` deleted)
4. **P6** tests accompany each step (**DELETED `e7231534`** — no P6 tests remain)

---

### 2. Ladder Recenter Orphan — Root Cause (Aug 26–30 2026)

> **Source:** former `LADDER_RECENTER_ORPHAN_ROOT_CAUSE.md` (deleted 2026-08-31; merged here) · **Status:** fixes #1–#7 landed 2026-08-30.

#### 2.1 Symptom

Falling market Aug 28 after ~17:00 UTC: bot **placed new SELLs below own live sells** (self-undercut). Next day orphans filled on bounce, proceeds credited outside grid accounting (`[ORPHAN-FILL] Processing funds for unknown order`), drift `±22` slots `[ANCHOR-DIVERGENCE]` from Aug 29 12:40. Not boundary crawl — dominant trigger is **regeneration re-anchor** (separate from PRICE_FIRST lag mode).

#### 2.2 Reproduction (systemic, not bot-D-only)

*Audit window: post-`cd690000` ("heal and prevent sized-orphan phantom orders"), `2026-08-30T00:24:26Z→07:48Z`.*

| Metric | bot-A | bot-B | bot-C | Basis |
|---|---|---|---|---|
| Distinct orphaned IDs (`Unmatched chain order`) full log Aug 17–30 | 229 | 107 | 172 | full file |
| Distinct post-commit window | 58 | 60 | 91 | 00:24:26Z→end |
| Occurrences post-commit | 280 | 228 | 241 | same |
| Adoptions post-commit | 2 | 14 | 64 | vs orphans 1–2 orders magnitude low |
| `Restored boundary` (snapshot restores) | 51 | 53 | 52 | full file |
| Structural resyncs (`[CR-RESET] rms_structural_grid_resync`) | 2 | 2 | 2 | full file |

`00:00–00:24Z` quiet → 58/60/91 attributable to post-`cd690000` code. Confirms re-anchor (fix #1) is root cause; phantom-order heal treated symptom.

#### 2.3 Four modes, one symptom family

**Mode A — orphan (re-anchor) — primary.** Aug 28 evening: regeneration re-centers ladder, live asks unmanaged, new sell rail starts below them. Timeline Table §2.6.

**Mode B — lag (stale boundary).** Aug 29 09:32 swept up through sell rail slots 147–158 → then `09:32:21 Placed sell slot-129 -> <order-1>` filled 250 ms later, `09:32:33 slot-131`, `09:32:42 slot-132` — 15–25 levels below rail; `ANCHOR-DIVERGENCE projected=138 bookkept=123 drift=15`. Boundary crawled down with falling-market buys, re-rolled slots 129–132 as SELL into rising market. One instant fill set `maxFilledSellPrice=1044.79`, guard caught later attempts `15:47` (1 slot below) and `17:27` (4+8 below 1099.37/1112.62). **What PRICE_FIRST Phase 2 fixes.**

**Mode C — COW commit geometry (separate).** Attribution corrected: `Batch transaction failed: Execution error: Order does not exist … cannot update` confirmed post-commit on bot-B: `<order-4>` `00:28:51 chunk1/3`, `<order-5>` `06:43:09 chunk5/9`, `<order-6>` `00:29:30` (`limit_order_update delta=-2341206 targets missing`). Broadcast refs missing orderId, aborts partial grid. `GAP-BAND VIOLATION after commit` = 0 in post-commit bot-A/B/C logs (evidence is bot-D `4` + D2 `11` dated Aug 26/28/29). Need: (a) COW rejects placement inside gap pre-broadcast; (b) pre-broadcast existence check off slot→orderId map. Gap case hardening independent. **Status: (b) LANDED `552b3ed7` (v1.6.14) as `UPDATE_TARGET_MISSING`; (a) deliberately shipped as a non-gating shadow (`gapBandPlacementShadowCount`) — see §9.2.**

**Mode D — boundary-evidence re-derivation not persisted (freeze).** `grid_reconcile.ts:359-502` re-derives corrected boundary via `manager._restoreBoundary (:380)` but didn't survive next resync; bot-A re-derived at *every* hourly resync: `117→118 (00:28:48)`, `118→119 (01:00)`, `118→115 (02:00)`, `118→114 (03:00,04:00)`, `118→115 (04:30,05:00)`, `122→119 (07:00)` — 8× identical `ERROR` in ~7h. Bot-C `NO_FEASIBLE_BOUNDARY` → adoption-only at `00:27:17, 00:31:12, 04:27:48`; after `04:27:48` placed **zero orders 04:27:48→07:15:27 (~2h48m)** — only fills + `[ORPHAN-FILL]`. Earlier freeze `00:31→00:54`. Resumed only via fill-driven rotation `07:15`. → Fix #5 (LANDED).

**Post-commit hardening (§2.3 sub):** (1) lagging-node read-back thrash bot-B `06:43:09–06:47:09` after chunk5/9 fail — fresh CREATEs absent (`<order-7> likely lagging node`), protection piled to 14, all CREATEs rejected, 30s cap forced resync mid-broadcast ~4 min/24 events; (2) sync lock `timed out after 20000ms` + `[SYNC] abandoned force-released 69355ms` (~70s lost), bot-C ~110 `Structural resync defer` warnings at 250 ms/30s; (3) `[MAINT] n/m price correction(s) failed` ratios `2/3,2/2,1/8,2/25,1/23,1/14` — stale slot maps.

#### 2.4 Incident timeline (bot-D Aug 28 17:09→Aug 29 17:27)

| Time | Event |
|---|---|
| Aug 28 17:09 | Sells fill at 1110–1176 (slots 140–148), tracking correct |
| 17:10:01 | `[RECOVERY] structural full grid resync for pending broadcasts before COW create` → regeneration + AMA refreshed |
| 17:10:02 | **16+ live sells `[SYNC] Unmatched chain order ... no adoptable slot found`** diff 0.43–0.57 vs tolerance 0.036 |
| 17:10–18:37 | 7 more regenerations (14 on Aug 28), each re-anchors to newest AMA center, 31 distinct orphaned sells that evening; 2071 warnings |
| 17:34:33 | Mode B sells slots 132/135/136 (~1054–1064) below fill range |
| 17:36:03 | 11 sells slots 124–131/133/134 (~1028–1061); slot-124 filled 150 ms after |
| 17:37:48 | Recovery resync restores boundary 119 (from 139/142) mid-drop — Mode A; new sell rail below orphans. Boundary crawled 142→139 silently to ~123 by 17:36 → slots 124–136 re-rolled to SELL, 20–80 BTS below own 17:09 fills |
| 17:37:39–17:55:09 | Slots 124→130 swept (~3s), then 131→136 — all 14 filled |
| 17:45 | `[DIVERGENCE-COW] Boundary-shift commit blocked (RECOVERY_EXHAUSTED)` — loop: blocked→resync→orphans→divergence |
| 18:02 | First surplus cancels via DIVERGENCE-COW ~50 min after orphaning |
| Aug 29 12:29 | Orphaned sells fill on bounce → outside grid accounting |
| 12:40–17:27 | `[ANCHOR-DIVERGENCE]` ±22; 17:27 periodic sync finds 40 filled at once (buys 978–1026, sells 1099–1112); PLACEMENT-GUARD rotates up to 31 buys + 8 sells/batch |

+ 11 graceful restarts in 30h (`Restored boundary` 57×).

#### 2.5 Root-cause chain (code refs)

1. Ladder quantized to center. 2. Recovery resyncs re-anchor via two config points (see Fix #1). 3. Tolerance rounding-scale `≈0.036` at 1110 vs AMA shift `0.045%` → `~0.5` shift = 15× tolerance → pass-1 + pass-2 adoption (`sync_engine.ts:146-156,:1040-1060`) reject. 4. `PRICE_DRIFT_TOLERANCE_MULTIPLIER 4` (`constants.ts:557`) → budget 0.144 < 0.43 diff → no `price-drift-orphan` → only logged (`dexbot_maintenance_runtime.ts:1311-1317`). 5. Regenerated ladder sell rail below orphans → self-undercut; `maxFilledSellPrice/minFilledBuyPrice` built from grid-tracked fills only → guard unenforceable once orphans unmanaged; orphans later fill outside accounting.

#### 2.6 Ranked fixes (with 2026-08-30 landed status)

**#1 Stop re-anchoring on recovery resyncs (two config points, highest leverage) — LANDED 2026-08-30 (`4838bcb0`).**
`rms_structural_grid_resync` → both flipped: (`dexbot_maintenance_runtime.ts:2327` `requestGridReset` call, hardcoded `refreshCenterPrice:false`) + (`:102` `GRID_RESYNC_REASONS.rms_structural_grid_resync.shouldRefreshCenterPrice: false`, covers the `buildGridResyncOptions('rms_structural_grid_resync')` call sites at `:1710-1712`). Structural resync keeps geometry; re-anchor only on manual/trigger-file and `GRID_RESYNC_REASONS` market-adapter delta/slope/bootstrap — intentionally stay `true`. `requestGridReset` default `TRUE` (`:2194`) so manual resets still re-anchor. Risk if center moved: geometry briefly mispriced but managed vs orphaning.

**#2 Regeneration must preserve order identity (defense-in-depth) — LANDED bounded 4×.**
`recalculateGrid` after `initializeGrid` adopts `chainOpenOrders` into nearest slots at chain price before reconcile; alt widen pass-2 fallback to ~0.25 step for VIRTUAL only. `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER 4` (`constants.ts` GRID_LIMITS) → 0.144 at 1110 (~¼ step); bot-D diffs 0.43–0.57 beyond band — coherent layering: #1 removes large diffs, residual → #3 surplus cancel. Also pre-empts `price-drift-orphan` on empty slots. Invariant: resync (incl. startup reconcile) never leaves live order unmanaged. Also covers startup reconcile (bot-A `<order-8>` 06:42→07:00 adopted to slot-140 still `Unmatched`; `<order-9>` re-adopted 6× 01:00–05:00 then `06:42:15 ORPHAN-FILL`).

**#3 Reconcile is update-first: never pre-emptively cancel unmatched (revised) — LANDED 2026-08-30 revised.**
Original force-cancel regressed reset path (fresh grid no ACTIVE bindings → cancelled instead of batch-updated). Revised `reconcileGridOrders`: never cancels in duplicate/route phase; `_reconcileStartupSide` 1. updates onto target slots batched (`plannedUpdates → _executeStartupUpdateBatch`), 2. creates missing, 3. cancels surplus only (`chainCount-targetCount` farthest-first) + Phase-3 stale surplus beyond target on fresh post-Phase-2 read. Invariant holds via adoption-or-surplus; guard `matchedOnGrid>0 || neededSlots===0` prevents fresh-grid nuking; pending-broadcast protection stays.

**#4 Log live boundary on every role (observability, zero risk) — LANDED.**
Debug line: `[BOUNDARY] boundary=123 sellStart=128 spread=4 anchorProjected=138 maxFilledSell=1044.79` on role/placement — makes Mode B diagnosable.

**#5 Persist boundary-evidence + define NO_FEASIBLE recovery (Mode D, high impact) — LANDED 2026-08-30 (`4838bcb0`), extended `a54863ca`.**
(a) Persistence: `recalculateGrid` persists the reconciled grid after reconcile, so the `manager._restoreBoundary` re-derivation (`grid_reconcile.ts:380`) survives to the next cycle. After fix: `[BOUNDARY-EVIDENCE]` contradiction fires at most once per stale boundary. (b) NO_FEASIBLE: bounded periodic re-validation (5min cooldown, 20 attempts) landed with `4838bcb0`; `a54863ca` went further — the validator enumerates straddling orders (`conflictingBuyIds/conflictingSellIds`) and the reconcile escalates a cancel ladder (smaller single side → other side → both, `grid_reconcile.ts:417-444`), re-derives the boundary and proceeds with placements; the adoption-only freeze remains only as a defensive fallback.

**#6 Retry/backoff post-broadcast adoption read-back — LANDED (cooldown `4838bcb0` + retry `d808c052`).**
`deferUncertainBroadcastRead` (`dexbot_cow_runtime.ts:301`) 30s escalation cooldown bounds thrash; `adoptPlacedBatchFromChain` retries lagging/failed by-id reads (3 attempts, 2s/4s backoff) before deferring with pending-broadcast protection kept. Cross-node failover remains open.

**#7 Sync-lock/maintenance observability — LANDED.**
Throttle `Structural resync defer` to first/last per cap window (was 120/30s); log/retry `[MAINT] n/m failed` with orderId/reason.

**Mode C hardening — PARTIAL (2026-10-11).** (b) **LANDED** pre-broadcast UPDATE-target existence check off the slot→orderId map: `runPreBroadcastGuards` re-reads every UPDATE action's `orderId` via `chainOrders.batchReadOrders` and refuses the whole batch (`UPDATE_TARGET_MISSING`) + requests a structural resync when a tracked target is gone on chain, instead of letting a `limit_order_update` abort the chunk mid-broadcast. Fails open on a non-Map/errored read (chain rejection remains the backstop), and re-verifies each candidate missing id with a single `readSingleOrder` before declaring it gone so a node lagging behind a just-created order does not false-refuse. **Residual risk (accepted, safe direction):** if that second read also lags/returns null, the batch is refused — a skipped cycle + structural resync, never a half-applied grid. Unexplained `UPDATE_TARGET_MISSING` churn on a slow node is this mechanism. (No dedicated counter on this path, consistent with the other uncounted pre-broadcast refusals; it shows up in error logs.) (a) **SHADOW ONLY** gap-band placement check: non-spread-correction CREATE/UPDATE destinations inside the plan's gap band are counted (`_metrics.gapBandPlacementShadowCount`) and warned, never blocked — enforcement is deliberately withheld because spread correction legitimately places INTO the band and a hard reject would re-open the reverted P1/e2898e51 regression class. Note: the GAP-P1 same-batch cancel that covered commit-time in-gap placement was reverted `e2898e51`; **P3 gate removed `e7231534`** — commit-time in-gap placement is currently covered by `LAST-FILL-GUARD` + adoption (no chain-evidence veto).

#### 2.7 Relation to PRICE_FIRST draft

#1 removes Mode A & major boundary churn; PRICE_FIRST fixes Mode B (09:32 triple direct target, 17:27 sweep budget < displacement shows lag at scale); #5 complementary (draft solves *which* boundary, #5 makes it stick). Sequence: #1 → PRICE_FIRST flag → #2/#3 → #4/#5.

#### 2.8 Verification — moved to §7 (plus gap/Mode C/drift targets there)

---

### 3. Orphan-Fill & Fund-Invariant — Root Cause & Fix Plan

> **Source:** former `ORPHAN_FILL_INVARIANT_ROOT_CAUSE_AND_FIX.md` (deleted 2026-08-31; merged here) · **Status:** P0s + rotation landed `1b27f6eb`/`4838bcb0`/`d808c052`; P1 atomicity partial; duplicate-cancel hard-error and P2 counters still open.
> **Scope:** `dexbot_cow_runtime.ts`, `sync_engine.ts`, `chain_orders.ts`, `dexbot_state_recovery.ts`, `dexbot_maintenance_runtime.ts`, `strategy.ts`, `constants.ts` · **Evidence:** `profiles/logs/<bot>.log` Aug 28 17:40–17:57, Aug 29 15:13–15:19.

#### 3.1 TL;DR — one cascade

1. COW concurrency lets fill batch plan against stale master and double-place at same price. 2. Second batch commit refused (`master mutation during rebalancing`) → fresh chain orders not in master. 3. Fallback adoption re-reads capped `get_full_accounts` truncating freshest orders + lossy duplicate-price skip → master diverges. 4. Fund recalc flags violation → recovery deletes (now "corrupted") snapshot, regenerates from truncated read (40/42) permanently orphaning two orders. 5. Orphans fill no-slot → `ORPHAN-FILL` → more violations → recovery reloads stale boundary → slot-90 same-slot refill loop.

Slot-90 loop is *proximate* form; rotation suppression is mechanism, cascade is upstream cause detaching boundary.

#### 3.2 Full picture

**Step 1 — Race:** ~`17:40:39–51` market moved fast, buys filled, boundary crawled down, sells `<order-1>…<order-4>`, `<order-5>`, `<order-6>…<order-10>`. `_batchInFlight` serializes fill consumer but planning+broadcast not atomic with master commit: Batch A broadcasts `<order-1>…<order-4>,<order-5>` at `17:40:39`; Batch B plans stale, places `<order-6>/<order-7>` at same prices (`17:40:42 a COW broadcast is already in flight; deferring`), commit refused `17:40:51.237 [COW] Refusing stale working grid commit: master mutation during rebalancing` (now `utils/validate.ts:1102`), adoption `Orphaned chain order … duplicates price level of active slot-88` (`sync_engine.ts:906`).

**Step 2 — Refused → invariant:** Fresh sells not recorded, adoption `adoptPlacedBatchFromChain` (`dexbot_cow_runtime.ts:3364`) capped window drops freshest (`chain_orders.ts:573-638`), adoption lossy `<order-6> NOT adopted / <order-9>→slot-106 / <order-10>→slot-107`, collides with re-plan `Rejecting CREATE for slot-105/106 existing orderId=<order-8>/<order-9>` (`17:40:51.335`). Fund recalc `CRITICAL: Fund invariant violation (SELL): blockchainTotal (474877) != trackedTotal (473173) diff:1703.62 allowed:474.87`.

**Step 3 — Recovery:** `Fund invariant → state recovery (1/5)` → `Restored boundary 82` → `[SNAPSHOT-REJECT] drift sell=1703.62 — Deleting snapshot` → `Synchronization from 40 blockchain orders — TRUNCATED: 42 live, 40 read` → regeneration matches `165→91,167→108,168→110` but `169,174` never matched (dropped).

**Step 4 — ORPHAN-FILL:** `17:57:18 WARN [ORPHAN-FILL] Processing funds for unknown order <order-10>/<order-9> (not in grid but crediting proceeds)` — no slot virtualized → more violations → Aug 29 stale boundary `90` (`Restored boundary index: 90`).

**Step 5 — Rotation same-slot:** `15:19:06` partial fill `<order-11>` slot-90 dust `2.92`, dust detection cancelled the residual, synthesizing a fill with `skipBoundaryShift:true` (removed `1b27f6eb`; defensive check removed this commit — `order/utils/order.ts` and `manager.ts` no longer inspect `skipBoundaryShift`; reintroduction would silently restore the same-slot fill loop) → `isShiftEligibleFill` false → boundary crawl suppressed. `processFilledOrders` only rebalances non-partial (`manager.ts:1460`) but synthetic `isDelayedRotationTrigger` forces rebalance with boundary frozen → slot-90 stays `BUY` → `Placed buy slot-90 -> <order-12>` `15:19:15` → `FILL DETECTED slot-90` `15:19:39`. Boundary detached (`projected=72 drift -18`, `PROJECTION_ENABLED false` `constants.ts:729`; the projection override itself was removed `3713c496`) → buy above market re-fills. Root fix: filled buy should rotate (SELL or bottom BUY), not re-stamp same price — LANDED `1b27f6eb`.

#### 3.3 Fix plan (layered; statuses corrected against HEAD — see §3 header)

**P0 Reliable ID-based adoption after refused commit — LANDED `1b27f6eb` (hardened `d808c052`).** Kills orphan/invariant at source: `adoptPlacedBatchFromChain` builds `collectKnownOnChainOrderIds(mgr, placedResults, placedContexts)` (`dexbot_cow_runtime.ts:3281,3364`) = `mgr.grid[*].orderId ∪ fresh CREATE ids from `extractBatchOperationResults(result)[i][1]`↔`executedContexts[i]` (`:3293`); re-read by ID `chainOrders.batchReadOrders (chain_orders.ts:530)` → `syncFromOpenOrders(fullChain, {skipAccounting:false})`; lagging-node deferral: if ANY fresh CREATE id `null` → defer (`return false`) keep protection (later read adopts), by-id error → defer (no fallback to window); absent master ids = expected. `d808c052` added a retry (3 attempts, 2s/4s backoff) before deferring. Window read remains fallback only and defers on `truncated`.

**P0 Recovery must not lose orders when snapshot deleted — LANDED `1b27f6eb`.** `recoverFromPersistedGrid` (`dexbot_state_recovery.ts:314`) on truncated window falls back to `batchReadOrders` over `persistedGrid[*].orderId` (recovers bot's own incl. ID-adopted creates now persisted), without virtualizing ACTIVE; cannot discover brand-new orphans (prevented above); with no known ids still defers. Intentionally lossy for unenumeratable = reconcile virtualize-as-filled acceptable here; adoption path hard-defers.

**P1 Atomic plan→broadcast→commit — PARTIAL.** Landed pieces: `restoreBoundaryAfterAdoption` re-applies the batch's shifted boundary immediately after by-id adoption (`1b27f6eb`); Phase-2 reconcile wrapped in a refcounted broadcast flag with `_awaitBroadcastIdle` deferral (`d808c052`); stale-commit refusal lives at `utils/validate.ts:1102`. Still open: full re-plan from fresh master after winning `waitForCowBroadcastSingleFlight` + a COW-plan mutex covering the entire plan→broadcast→commit; dust-cancel `checkGridHealth` waits.

**P1 Rotation same-slot — LANDED core (`1b27f6eb`); sub-fixes superseded.** (1) `skipBoundaryShift:true` removed from both dust synthetic fills (was `dexbot_maintenance_runtime.ts:1821/:1826`) — dust fills are shift-eligible again; regression guard `tests/test_rotation_no_same_slot.ts` now 4 cases (ROT-4 same-slot loop case removed this commit, guard deleted); no defensive `skipBoundaryShift` check remains (`order/utils/order.ts` + `manager.ts` removed). Reintroduction of the flag would silently restore the same-slot fill loop. (2) moot — dust fills now trigger the crawl naturally. (3) SUPERSEDED — the Phase-2 projection override was removed entirely (`3713c496`); `ANCHOR.PROJECTION_ENABLED` (`constants.ts:729`) is an unused constant. (4) SUPERSEDED — the `d808c052` anchor-refill/price-sanity guard extensions were removed `e2898e51`; the original `calculateTargetGrid` fill-range rotation (`strategy.ts:345-369`) remains.

**P1 Duplicate-orphan cancellation reliable — OPEN (partially mitigated).** Verify `queueCorrection` cancelOnly (`sync_engine.ts:913`) executes, not blocked by in-flight; hard error if cannot cancel. `d808c052` mitigates the consequences (unknown-fill adoption-before-credit + empty-read guard) but the explicit verify/hard-error behavior is still open.

**P2 Observability — PARTIAL (counters landed 2026-09-13).** `d808c052` added anchor price-outlier rejection with rate-limited warns (that warn surface was later removed `e2898e51`). Since then the GRID-PRICE-INVARIANT guard added per-batch/per-site emitted-price counters and **blocks** an off-grid emission (`[GRID-PRICE-INVARIANT] site=<site> checked=N violated=M unchecked=K`, six emission sites) and a `pivotSlot=`/`pivotOffGrid=true` marker plus a numeric `pivotOffGrid=<n>` per-action count on the LAST-FILL-GUARD batch summary (the count says how many guarded probes used an unsnapped pivot) — see `docs/GRID_PRICE_INVARIANT.md`. Two self-healing escalations now sit on top of those counters: a slot rejected off-grid for
`GRID_PRICE_INVARIANT_RESYNC_THRESHOLD` (3) **consecutive** batches escalates to the structural resync
(`grid-price-invariant-violation`), because the recurring planner carries the slot's corrupt price straight
from `manager.orders` and would otherwise re-plan-and-reject it forever; and a deferred hold unchanged for
`DEFERRED_HOLD_ESCALATE_MS` (24h) escalates to the same resync (`deferred-hold-stale`), giving
"held indefinitely" the exit the per-cycle hold policy lacks. Both reuse the existing debounced,
batch-in-flight-aware resync path. The hold age is measured **per stranded
order** (`_strandedHoldSince`, a bot-scoped map keyed `id@price/size:reason`),
not from the whole-held-set signature clock (`_lastHeldChainOrderSignatureSince`
drives LOGGING only — a whole-set age clock would be reset by unrelated churn,
because one hold flapping in and out restarts it, starving a genuinely stranded
order of escalation forever — HOLD-010) and **not** from
`_lastUnmatchedChainOrdersAt` — the latter refreshes on every observing sync
and would make an age gate unfirable (HOLD-007).

Still open: none of the listed counters — all four landed 2026-10-11 (see below). Deferred-hold observability is no longer open — the `[HOLD]` summary now names side/price/size/reason/off-grid distance and slow-re-warns on an unchanged hold (`modules/dexbot_maintenance_runtime.ts`, `docs/GRID_PRICE_INVARIANT.md`).

P2 additions (2026-10-11, counter-only — none gated behavior):
- `refusedCommitCount` — incremented once in `recoverRefusedCommit` (the single funnel for all refused/uncertain commit paths), and only for genuine refusals: the poll-confirmed **success** path also routes through this funnel (adoption + fee deduction) and passes `refusedCommit: false`, so it is not counted.
- `orphanFillCreditedCount` — incremented in `applyReplaySafeOrphanFillAccounting` on an `applied` result (a real proceeds credit; not `duplicate`/`error`/`missing_key`).
- `restampBuyAboveAnchorCount` — `recordRestampBuyAboveAnchor` counts a BUY emitted at/above the last filled BUY pivot (guard bypass or unjudgeable pivot), warned once per batch; it never blocks.
- `boundaryDriftExceedsWindowCount` — `calculateTargetGrid` counts a derived boundary that jumps more than the active window in one plan (the detached-boundary signal the removed ANCHOR-DIVERGENCE telemetry used to carry), rate-limited warn.
- `gapBandPlacementShadowCount` — the Mode C(a) shadow above.

Spread-correction additions (counter-only, written on `manager._metrics` by `order/grid.ts` because the planner has no bot reference):
- `spreadCorrectionRefusedCount` / `spreadCorrectionRefusalCauses` — every spread-correction batch that failed to land, plus the per-`SPREAD_CORRECTION_REFUSAL`-cause breakdown.
- `spreadCorrectionRetryCount` — bounded fresh-master re-plan retries after a transient refusal.

All eight surface through `getMetrics()`; the five baseline counters via the existing `...bot._metrics` spread, and the manager-owned set (`boundaryDriftExceedsWindowCount` plus the three spread counters) via the `managerOwnedCounters()` overlay in `dexbot_maintenance_runtime.ts`, because those engines write on the manager's metrics object and have no bot reference.

#### 3.4 Key code references (from source table)

`dexbot_cow_runtime.ts:3281,3364` by-id adoption (`collectKnownOnChainOrderIds`/`adoptPlacedBatchFromChain`); `:3293` placed IDs from broadcast result; stale-commit refusal `utils/validate.ts:1102`; `sync_engine.ts:906-913` duplicate skip + `queueCorrection`; `chain_orders.ts:573-638` truncation cap; `:503 readSingleOrder, :530 batchReadOrders` immune; `dexbot_state_recovery.ts:314,581` recovery/reject; `dexbot_maintenance_runtime.ts:806 performGridResync`; `order/utils/order.ts:1560-1561` `isShiftEligibleFill`; `strategy.ts:345-369` fill-range rotation guard; `constants.ts:729` `PROJECTION_ENABLED` (unused since `3713c496`); `<bot>.log 15:19:06→39` slot-90 loop.

---

### 4. Price-First Alignment Plan

> **Source:** former `PRICE_FIRST_ALIGNMENT_PLAN.md` (deleted 2026-08-31; merged here) · **Status:** Phase 1 shipped and live as shadow telemetry; Phase 2 projection was enabled (`1bbf1a23`) then **removed** (`3713c496`) after a live-bot incident — the anchor veto overrode chain evidence and drove destructive gap-band cancels. The anchor is now observability-only; the boundary is chain-evidence-derived. Phase 3 is moot (no second write path to retire); boundary geometry is pinned by `tests/test_boundary_anchor_recovery.ts` (ANCHOR-001..004) and `tests/test_grid_price_slot_invariant.ts`.
> **Scope:** grid boundary state `modules/order/` · **Related:** three-layer crawl/anchor/guard fix.

#### 4.1 Goal

One source of truth `MarketAnchor` (fill-derived), boundary demoted to rebuildable cache. Phase 2 is goal; Phase 3 deletion conditional on soak evidence. **KPI:** `[PLACEMENT-GUARD]` rotations = 0 + divergence telemetry flatlined.

#### 4.2 Background

Grid's "where is market" maintained two ways that disagree: boundary (discrete, crawled) vs fill prices (continuous, authoritative). Every incident = boundary diverging from price.

#### 4.3 Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Price overrides funds, bounded fund floor (≤½ active window; severe shortfalls reduce sizes via `calculateBudgetedSizes`) | Preserve I1 unconditionally; sizing degrades gracefully |
| D2 | Projection reuses `getSellStartIdx`/`isSlotInRail` only | No new gap conventions, avoid baking `splitIdx - floor(gap/2) - 1` asymmetries |
| D3 | Single boolean flag `projectionEnabled` | One test matrix, legacy stays as rollback |
| D4 | Fills applied in block order (`block_num` before trailing) | Replay order would flip correction direction |
| D5 | Anchor never persisted — book-seeded (highest buy / lowest sell) startup, `startPrice` fallback | No schema/migration, fossilized book; guard covers until first fill |
| D6 | Deletion evidence-gated (14-day) | Phases 1–2 carry safety; deletion hygiene must earn risk |

#### 4.4 Invariants I1–I6

I1 No order on wrong side of just-filled price (`sell ≤ maxFill, buy > minFill`) — `test_last_fill_guard.ts` (LFG-1..7); I2 Single eligible fill ±1 crawl — `test_multi_partial_consolidation.ts`; I3 Just-filled BUY refills as BUY at fill price — `test_multifill_opposite_partial.ts`; I4 Boundary never exceeds gap-aware ceiling / collapses on degenerate geometry — `test_boundary_restore_validation.ts`; I5 Price-less fills degrade conservatively — `test_boundary_anchor_recovery.ts` ANCHOR-003; I6 COW-commit-only writes (`_setBoundary`) — `test_cow_boundary_slot_replacement.ts`.

#### 4.5 Phase 1 — MarketAnchor + divergence telemetry (no behavior change)

*Status: SHIPPED.*
In-memory `marketAnchor` on manager (`dexbot_fill_runtime.ts`) `lastFillPrice/maxFilledSellPrice/minFilledBuyPrice/lastFillSide/updatedAt` updated on eligible fill (`isShiftEligibleFill`), `buildFillKey` deduped, block ordered (D4, D5); book-seeding; shadow log `[ANCHOR-DIVERGENCE] projected=X bookkept=Y drift=Z` `|Z|>1` warn (>~3), thresholds `constants.ts`; freshness 15 min OR >3 increments beyond anchor (`ANCHOR_FRESHNESS`); replay protection history uses latest only; tagging replay vs live via `sync_engine.ts`. Gate: suite green + unit for idempotent/block/replay/freshness/book-seeding.

#### 4.6 Phase 2 — Projection live (goal)

*Status: SUPERSEDED — landed `1bbf1a23` (flag on), REMOVED `3713c496`.*
Pure `projectAnchorToGrid(anchor, allSlots, gapSlots)` via `computePriceAnchoredBoundaryTarget` (`order/utils/order.ts`), gap centered on traded range + I4 ceiling; `calculateTargetGrid` (`strategy.ts`): `boundaryIdx = anchorFresh ? project(...) : legacyDeriveTargetBoundary(...)` gated `projectionEnabled` (D3); fund floor D1 at most ½ window (`syncBoundaryToFunds/calculateFundDrivenBoundary` `utils/system.ts`); placement guard unchanged as enforcement I1; stale-anchor continues from last range decayed to AMA center (not fall back to crawl). Gate: suite green flag on/off + property harness random bursts/re-plans/replays/empty-book all I1–I6; flip per-bot start smaller, 48h soak watcher `ANCHOR-DIVERGENCE`/`PLACEMENT-GUARD`/fund friction. **Done = incident class closed, rollback = flag flip.**
**Post-mortem (`3713c496`):** the projection override plus the anchor's veto role let a fresh fill-anchor override chain evidence under a stale boundary, and the gap-band sweep then cancelled legitimate orders. Removed: the `projectionEnabled` gating, the `projectAnchorToGrid` boundary override, and the fund-floor pull in `calculateTargetGrid`. `strategy.ts:232-236` records the decision — the anchor is shadow telemetry only (`[ANCHOR-DIVERGENCE]`/`[ANCHOR-STALE]`). The original fill-range rotation guard remains at `strategy.ts:345-369`; the `d808c052` price-sanity/anchor-refill guard extensions were removed `e2898e51`.

#### 4.7 Phase 3 — Conditional deletion

*Status: MOOT — Phase 2 was removed (`3713c496`), so there is no second write path to retire; the legacy machinery below is the live path. Original gate: 14-day zero rotations + flat divergence.*
3a: `deriveTargetBoundary` collapses to initial-recovery + projection; delete `netShift`/cross-chunk budget/window-cap; delete `_boundaryShiftBudget/_boundaryShiftBudgetBase/_boundaryAnchor` (`dexbot_class.ts`) + re-plan restore (`dexbot_cow_runtime.ts`); fund sync now D1 floor only; spread-correction promotes via anchor; remaining readers projection-based; `manager._setBoundary` stays (I6). 3b: `account_orders.loadBoundaryIdx` (`validatePersistedBoundary` `dexbot_state_recovery.ts`) + `storeGrid` (`utils/system.ts`) stop persisting boundary; startup = load grid → book-seed → project. Gate: harness + fund-floor/recovery cases; kill-switch: corrupt/delete snapshot must converge from chain alone.

#### 4.8 Phase 4 — Boundary geometry coverage (pin, don't refactor)

*Status: LANDED with the projection, then superseded — boundary geometry is pinned by `tests/test_boundary_anchor_recovery.ts` (ANCHOR-001..004) and `tests/test_grid_price_slot_invariant.ts`.*

#### 4.9 Sequencing & risk

Work on `test`; per-phase mergeable unit with soak; flag flip is sharp edge — per-bot; D1 validated in soak; if 14-day never clean → stop at Phase 2 (guard+projection hold invariants).

| Phase | Size | Risk | Rollback |
|---|---|---|---|
| 1 | 2–3d | none | delete struct |
| 2 | 3–5d | medium | `projectionEnabled=false` |
| 3 | 3–4d | low (evidence-gated) | revert |
| 4 | 1d | none | n/a |

#### 4.10 Definition of Done

Goal (Phase 2): I1–I6 property pass, full suite green, harness random, 48h per-bot no fund-invariant; Full alignment (Phase 3): 14-day zero guard rotations + zero divergence warnings, no path increments `boundaryIdx` (only read/project), answer "where will next sell be?" from one struct.

---

### 5. Cross-doc fix lineup (deduplicated, dependency order)

1. **GAP P1+P2+P4** + **LADDER #1** earliest (gap writer + re-anchor stop — highest leverage, prevents Aug 28 cascade 7 regs×orphaning). — *GAP P1/P2 landed `f94d6ec4` then reverted (`3713c496`/`e2898e51`); GAP P4 + LADDER #1 live.*
2. **LADDER #4 / PRICE Phase 1** log-only, parallel. — *done (`4838bcb0`; Phase 1 telemetry live).*
3. **PRICE Phase 2** flag per-bot 48h (Mode B lag) — price-first truth. — *SUPERSEDED: landed `1bbf1a23`, removed `3713c496` (see §4).*
4. **LADDER #2/#3** identity + update-first hardening. — *done (`4838bcb0`).*
5. **LADDER #5 / ORPHAN P0 recovery-by-ID** persistence (long freeze). — *done (`4838bcb0`, extended `a54863ca`; recovery-by-ID `1b27f6eb`).*
6. **ORPHAN P0 ID-based adoption** + **P1 atomicity** (stale-plan race). — *P0 done (`1b27f6eb`, retry `d808c052`); atomicity partial.*
7. **ORPHAN P1 rotation + P1 duplicate + GAP P3/P5 + Mode C guards + P2 guardrails** fast-follow. — *rotation + GAP P5 done; GAP P3 reverted `e7231534` (`validateBoundaryAgainstChainEvidence`/`placementsAllowed` removed); Mode C pre-broadcast UPDATE guard and P2 counters LANDED `552b3ed7` (§9.2); the in-gap reject ships as a shadow, not a block.*
8. **PRICE Phase 3/4** only after evidence (`grid_correction_check` see §7). If soak never clean, stop at Phase 2. — *Phase 3 moot; Phase 4 golden tests landed.*

---

### 6. Consolidated invariants (what must hold after all fixes)

- **Gap-band (amended `3713c496`/`e2898e51`; **P3 reverted `e7231534`**):** in-gap chain orders are never cancelled as a self-healing net; they are adopted by the normal reconcile path once the boundary is re-derived via `calculateIdealBoundary` (P3 `validateBoundaryAgainstChainEvidence` gate removed `e7231534`). Placement into the band is prevented by `LAST-FILL-GUARD` / `findCrossedOrder`, not by P3 cancellation sweeps.
- **Identity:** every resync (incl. startup reconcile) leaves no live order unmanaged (adopted-or-cancelled-as-surplus, surplus = `chainCount-targetCount` farthest-first).
- **Monotonicity (grid-check):** adjacent same-direction fills monotonic rising sell / falling buy (equal OK).
- **I1–I6 PRICE_FIRST** plus COW-commit-only boundary writes and price-less degrades conservatively.

---

### 7. Consolidated verification — grid-correction check as regression gate

**Tooling (new):** `analysis/grid_correction_check.ts` (see §0) — primary external check for all docs' inversions; run per market:
```
npm run analysis:grid-check -- --bot-key <bot-key> --account 1.2.xxxxx --hours 168
npm run analysis:grid-check -- --bot-key <bot-key> --account 1.2.xxxxx --hours 720
npm run analysis:grid-check -- --bot-key <bot-key> --account 1.2.xxxxx --hours 168 --json out.json --csv out.csv
# cross-pair opt: --include-cross-pair ; per-fill opt: --per-fill ; tolerance opt: --tolerance 0.1
```
Pairs-checked base excludes cross-pair unless flagged; strict sat-level detection (`detectViolations`, `aggregateByOrder`).

**Targets (replay the windows in the 4 docs):**
- Regeneration unchanged center → `0` `Unmatched chain order`; recovery `rms_structural_grid_resync` not promote AMA.
- Shifted center → every live order adopted or immediate cancel (no silent unmanaged); startup reconcile replays: bot-A `<order-8>` 07:00 and `<order-9>` 6× loop must stay managed, no `ORPHAN-FILL`.
- Boundary re-derivation persists: bot-A `00:28–07:00` must not repeat `[BOUNDARY-EVIDENCE]` for unchanged chain.
- `NO_FEASIBLE_BOUNDARY` bot-C `04:27:48` resumes on next sync tick (bounded, not hours) with WARN.
- Post-broadcast read-back retry: bot-B `06:43` no `14` piled / forced resync mid-broadcast. *(Addressed v1.6.13–1.6.14 by the resync-cascade break (`7eb65c8e`) and the fresh-placement cancel grace (`85a7e7f0`); see §9.)*
- COW commit never places inside gap; pre-broadcast existence check: bot-B `<order-4/5>` + bot-D/D2 `GAP-BAND` fixtures → `0`. *(Amended: the commit-time in-gap cancel sweep was reverted `e2898e51` — current expectation is adoption-after-chain-evidence-correction; `0` unmanaged in-gap orders remains the target.)*
- Aug 28 burst `17:09–17:16` (3 regs/6m, sells 1110–1176) → `0` orphans, `0` sells below asks.
- **Orphan regression over ~7h post-`cd690000` on bot-A/B/C:** distinct `Unmatched` `58/60/91 → ~0` (full `229/107/172 → ~0`), `Fund invariant violation` `0` (was `3077.07→3184.93` etc.), `ORPHAN-FILL` `0` (was `7/33/22`), repeated `[BOUNDARY-EVIDENCE]` `0`, deferred minutes `0`, `[MAINT] n/m failed` `0`.
- **Grid-correction soak (external, strict):** pre-fix baselines on the affected markets showed double-digit `%` same-direction inversion rates over 7d/30d windows → `0` sustained. Sustain 48h per-bot (Phase 2) and 14-day zero-guard/divergence (Phase 3). *(Phase 2/3 soak gates moot since `3713c496` — projection removed; the divergence telemetry remains as a monitoring signal.)* **Failure = place `sell→sell` lower / `buy→buy` higher.**

Original doc regression excerpts preserved: GAP P6 A/B/C; LADDER §2.8 checks (10 bullets); ORPHAN §3 guardrails; PRICE §4.7/4.10 kill-switch. The randomized chaos/property harness was the PRICE_FIRST Phase 2 gate (§4.6), not part of LADDER §2.8.

---

### 8. Provenance & supersession record

- [x] Deleted the four superseded plans: `git rm docs/GAP_BAND_ORPHAN_PREVENTION_PLAN.md docs/LADDER_RECENTER_ORPHAN_ROOT_CAUSE.md docs/ORPHAN_FILL_INVARIANT_ROOT_CAUSE_AND_FIX.md docs/PRICE_FIRST_ALIGNMENT_PLAN.md` (staged 2026-08-31)
- [x] No other doc/index lists the four (verified 2026-08-31); `analysis/README.md` documents the `grid_correction_check` tool.
- [x] Stale `*.md` filename references in code comments/tests updated to the consolidated doc (9 module files, 6 test files), then re-pointed to this hub when it absorbed the summary.

*Generated 2026-08-31 from the 4 test-only docs at their HEAD contents; statuses corrected against `test` HEAD `a54863ca` the same day, then refreshed against `1382f267` (2026-09-13) and extended through v1.6.14 at `f6c0df32` (2026-10-12; see §9). Landed/reverted/superseded annotations carry commit hashes where known; **line references in §§1-4 were re-verified at `a54863ca` and are subject to drift** — treat them as pointers, not assertions. The GRID-PRICE-INVARIANT guard is **BLOCKING** at all six emission sites (CREATE / UPDATE / CREATE-FALLBACK in `modules/dexbot_cow_runtime.ts`, RECONCILE-CREATE / RECONCILE-UPDATE / STARTUP-CREATE in `modules/order/grid_reconcile_internal.ts`): an off-grid emission is skipped, not merely counted, so a `violated>0` line means an emission was *prevented* rather than a writer merely *pinned*. Counters are still reported (`site=`, `checked=`, `violated=`, `unchecked=`) for observability — see `docs/GRID_PRICE_INVARIANT.md`.*

---

### 9. COW Broadcast, Resync & Geometry Safety (v1.6.4 → v1.6.14)

> **Source:** `CHANGELOG.md` v1.6.4 → v1.6.14 · **Snapshot:** `f6c0df32` (2026-10-12).
> Extends the §§1–8 ledger; the `§0`–`§8` numbers are unchanged (code and tests cite them).

Sections 1–4 end with the prevention sweeps reverted: a cancel sweep on ambiguous evidence
proved worse than the orphan it targets. The post-1.6.3 arc is the constructive inverse —
**stop the engine from destroying good state**, and **fail closed when geometry is unknown**.

#### 9.1 The synthesis: avoid the destructive resync

R4's fixes (genesis determinism, one writer, the last-fill guard) closed the *orphan* family.
The remaining harm was self-inflicted: **structural resyncs fired on evidence that did not
justify them**, and each reset clears the LAST-FILL-GUARD pivot and any gap-evacuation streak.
The engine now treats uncertainty as *defer, never rebuild*:

- **Uncertain-broadcast reconciliation is master-aware** (`7eb65c8e`, v1.6.13):
  `resyncIfUnreconciled` treats a chain order as reconciled if master already tracks it
  (`collectKnownOnChainOrderIds`), not merely if it appears in this batch's adopted set.
  Before, a populated grid (`W` chain orders − `A` adopted ≫ 0) forced a full rebuild — and a
  LAST-FILL pivot wipe — after *every* uncertain broadcast.
- **A suspended persistence is a deferral, not divergence** (`7eb65c8e`): a credential-daemon
  outage (`persistGrid()` → `{skipped, suspended}`) marks the committed grid dirty for the
  end-of-tick flush instead of escalating to a resync. The daemon watchdog also sets the
  recovery flag that actually re-runs `resumeGridPersistence()` — previously a transient ping
  timeout suspended persistence for hours and cascade-resynced the grid many times in one window.
- **Unknown geometry fails closed** (`5003b8ef`, `750386ac`, `dc87ce01`, `249016e4`, v1.6.14):
  `Number(null) === 0` and `Number('') === 0` had made an unknown boundary/gap read as the
  *valid* value `0`, casting real geometry around slot 0. `Format.toKnownNumber` keeps
  `null`/`undefined`/`''` unknown (a genuine `0` stays `0`) across the gap-evacuation
  candidates, `geometryTypeForSlotIndex`, evac stamping, `optimizeRebalanceActions`,
  `planVacatedRailRefill`, `buildCowResultFromPlan`, the gap-band shadow and the guard
  fallback; `validateBoundaryCommit` rejects every other non-numeric value (`'abc'`, `NaN`,
  `Infinity`) as `non_integer_boundary` again (the 1.6.13 absent-aware rewrite had widened
  "garbage" to "no proposal").
- **The LAST-FILL reference survives regeneration** (`09dbaad7`, `f1c331bd`, v1.6.14): a
  bot-scoped last-market-fill row (price/type/fillsAt) is restored at startup under a 24h TTL,
  so a `clearGrid()`/regeneration no longer wipes the anti-through-trade pivot.
  `evaluateSpreadCorrectionReadiness()` is the single verdict (cold book = hard refuse; stale
  snapshot/unmatched orders = plan-but-withhold-the-bypass), with the NEWER of a live
  order-book/ticker read and the fill anchor as the crossing floor;
  `SPREAD_CORRECTION_SYNC_FRESH_MS` is the one trust window.

#### 9.2 Pre-broadcast atomicity — Mode C now guarded (`552b3ed7`, v1.6.14)

Mode C (§2.3) is the `Order does not exist … cannot update` abort that leaves a partially
applied grid. Its pre-broadcast existence check — the second of Mode C's two "Need"s — is now
implemented in `runPreBroadcastGuards`: every UPDATE action's tracked `orderId` is re-read
(`batchReadOrders`), fail-open on a non-Map/errored read, then re-verified one by one
(`readSingleOrder`) so a lagging node cannot manufacture an absence. Any target still missing
aborts the whole batch (`UPDATE_TARGET_MISSING`), pops the working grid and requests a
structural resync — the divergence is refused *before* the wire, never half-applied.

Mode C's first "Need" (reject placement inside the gap band pre-broadcast) was deliberately
**not** implemented as a block: spread correction legitimately places into the band (that is
what the LAST-FILL-GUARD bypass is for), and a hard reject re-opens the P1 regression class.
It ships as an observability **shadow** (`gapBandPlacementShadowCount`, warned, never gating).
`COW_ORIGINS` (`eca90ce6`, v1.6.13) makes the bypass's `origin` keys a single frozen constant,
so a typo can no longer silently disable the spread-correction / gap-evacuation bypass.

#### 9.3 Don't churn orders the pipeline just placed

- **Fresh-placement cancel grace** (`85a7e7f0`, v1.6.12): `SURPLUS_CANCEL_GRACE_MS` (15 min)
  timestamps placements (`_placedAt`) and surplus/cancel-only sweeps skip orders inside the
  window (covering the batched and serial paths; `grid-load`/`grid-init` excluded so restarts
  still sweep).
- **Spread correction repairs what it places** (`cd82cd8a`, v1.6.12): create-only, funded from
  available balance; a distance-sorted windowed-rail ordering bridges contiguously from the
  live window instead of leaving an interior hole. It tightens the spread rather than walking
  to the rail edge (`67377d58`, v1.6.9) and is fund-driven (`589cb30e`, v1.6.4).
- **Committed-size drift resize** (`16308f72`, `d8a97f76`, v1.6.14): an external
  deposit/withdrawal shifting a side's budget ≥3% resizes all of that side's on-chain orders
  on the next pipeline-empty tick; the trigger is unified in `checkAndUpdateGridIfNeeded` so the
  ratio legs cannot be consumed in isolation.
- **Orphan double-count pruned** (`1f272cee` v1.6.11, `073cceca` v1.6.12): slotless chain
  orders are counted as committed funds, so adopting one *into* a slot must remove the stale
  `_lastUnmatchedChainOrders` record; both success exits and the `createOrder` materialize
  branch prune it by chain id.

#### 9.4 Removing writers — the genesis cleanup (`b2f4a65f`, v1.6.8)

Appendix A's writer chain is closed at the source: a persisted grid with no usable price
ladder is **refused** at load (`MissingGenesisError` before any mutation;
`MISSING_GENESIS_POLICY` `rebuild`/`halt`) instead of loading ladder-less and degrading every
slot-price consumer to a tolerance matcher. The legacy tolerance matcher,
`findMatchingGridOrderByOpenOrder`, the `price-drift-orphan` auto-cancel and the pass-1
price-equality / duplicate-swap tolerance fallbacks are deleted, and `syncFromOpenOrders` is
fail-closed behind `_assertGenesisInvariant`. This is R4's "removing writers and sources of
truth" carried to its end: the no-ladder state that Appendix A's `slot.price` corruption
required is no longer reachable at runtime.

#### 9.5 Ledger (order-engine commits, v1.6.4 → v1.6.14)

| Commit | Release | Change |
|---|---|---|
| `589cb30e` | 1.6.4 | Spread correction purely fund-driven with a balance refresh fallback |
| `1f2fd7ae` | 1.6.4 | Fill/broadcast batch cap raised to `gapSlots + 1` |
| `f90c4b6c` | 1.6.4 | Include VIRTUAL orders in RMS structural divergence |
| `224f92ee` | 1.6.6 | Harden stale cancellation guards |
| `b14a1fc8` | 1.6.7 | Persist/restore the LAST-FILL-GUARD pivot with the grid snapshot |
| `cd6c15fb` | 1.6.7 | Fill-channel watchdog recovery and accounting |
| `8c4baa69` | 1.6.7 | Recover dead-but-open sessions; stop stale COW re-broadcasts |
| `b2f4a65f` | 1.6.8 | Refuse persisted grids with no usable price ladder (genesis policy) |
| `dbd86cc8` | 1.6.8 | Bound the correction drain by wall-clock; surface long grid-lock holds |
| `67377d58` | 1.6.9 | Spread correction tightens the spread instead of walking to the rail edge |
| `1f272cee` | 1.6.11 | Five order-engine/lifecycle fixes (orphan accounting, double-count, grace, …) |
| `85a7e7f0` | 1.6.12 | Defer cancels of freshly placed orders in COW reconcile/divergence |
| `073cceca` | 1.6.12 | Prune the deferred-orphan record when createOrder linkage binds the slot |
| `cd82cd8a` | 1.6.12 | Keep spread correction funded by repairing what it places |
| `7eb65c8e` | 1.6.13 | Break resync cascades; suspended persistence is a deferral |
| `edb53176` | 1.6.13 | Report spread-correction stall causes |
| `6480923c` | 1.6.13 | Sync with the chain on every spread-correction stall |
| `eca90ce6` | 1.6.13 | Centralize COW plan-origin labels in `COW_ORIGINS` |
| `09dbaad7` | 1.6.14 | Never let spread correction trade through the last real fill |
| `f1c331bd` | 1.6.14 | Single readiness gate + live market floor |
| `16308f72` | 1.6.14 | Resize the full side when a deposit slips past the fund ratio |
| `d8a97f76` | 1.6.14 | Harden committed-size drift; unify the fund trigger |
| `552b3ed7` | 1.6.14 | COW pre-broadcast UPDATE-target guard + P2 counters |
| `5003b8ef` | 1.6.14 | Guard unknown boundary/gap across gap-evacuation and COW shadow paths |
| `750386ac` | 1.6.14 | Guard unknown boundary in the gap-band shadow |
| `dc87ce01` | 1.6.14 | Close missed 1.6.13 regressions in absent geometry and the rebuild guard |
| `249016e4` | 1.6.14 | Keep `validateBoundaryCommit` fail-closed for garbage boundaries |

#### 9.6 Invariants added

- **Uncertainty defers, it does not rebuild:** a resync requires a chain order unknown to
  master, a non-suspension persist divergence, or a proven pre-broadcast UPDATE-target gap.
- **Unknown geometry is unknown:** no code path may coerce absent boundary/gap to `0`.
- **Atomic-or-refused:** a COW batch either applies wholly on chain or is refused before the
  wire; no `limit_order_update` may abort a chunk.
- **Placed is not surplus:** an order inside `SURPLUS_CANCEL_GRACE_MS` is never cancelled by a
  sweep running on a stale snapshot.

#### 9.7 The guard was a band, not an economic rule (`c86b4b0e`)

**Observed (2026-10-24/25, a live market-pair bot).** A dump swept the grid and the
market then held. Spread correction planned, the broadcast guard dropped the creates,
`SPREAD-STALE` reported **84 minutes with no correction placed**, and only a structural
re-center (grid rebuild) restored the spread. Two distinct guard defects, both from one
predicate:

1. **The pivot band ignored the fill's side.** `isLastFillGuardBlocked` judged against
   `pivot ± increment/2`:
   ```ts
   BUY  blocked if price > pivot * (1 - inc/2/100)
   SELL blocked if price < pivot * (1 + inc/2/100)
   ```
   The `lastType` argument was passed and never read. Consequences: a BUY **below** a SELL
   fill was blocked (the doc claimed "buy-below-sell is never gated"; the code gated it),
   and a SELL 0.2% **above** our cost was blocked after a BUY fill — exactly the spread
   edge, which correction places tighter than a full increment by design. Repair therefore
   depended on the `SPREAD_CORRECTION` bypass, which `09dbaad7` denies whenever a real fill
   reference exists — so after any fill, tightening was structurally impossible.
2. **Planner and guard disagreed.** `09dbaad7` intended a planner-side filter against the
   fill reference, but the implementation used the readiness *crossing floor*, which
   prefers a **fresh live market read** over the fill anchor. With a fresh read the planner
   admitted what the guard would drop, producing the live sequence
   `planned 2, placing 1 → Skipping sell CREATE … below last filled → Transient refusal 1/3
   → batch was prepared but not executed` — a whole cycle spent on a guaranteed refusal.

**Fix.** Direction only, one predicate shared by both sides:

```ts
BUY  blocked if price >= pivot    // never place a higher BUY
SELL blocked if price <= pivot    // never place a lower SELL
```

Equal price stays blocked (re-place at the filled level). The predicate lives in
`order/utils/system.ts` next to `resolveLastFillGuardReference`; `dexbot_cow_runtime`
re-exports it. The planner now filters every candidate pool (and boundary promotion) with
the **same** predicate before the quota slice, so a batch is never built out of ops the
guard will drop, and an unplaceable side reports it honestly.

**Deliberately not relaxed.** A lower SELL is still refused **when the last fill was a
SELL**: after a fill the sell window must move *up*, so a sell slot below the last sale is
evidence that the boundary/crawl is behind the fill — a geometry fault, not a placement
opportunity. The log confirms it: seven slots (147–153) filled in one sync, the boundary
then **moved down** to 146 (two commits each dropping owed crawls), leaving slots 151/152
as sell-zone holes below the last sale. A cost-basis rule (sell only above the last BUY)
would have *placed into* that corrupted geometry.

#### 9.8 Stalls that placement cannot repair get their own clocks

Three states were previously indistinguishable from patience and all waited for the
30-minute structural window:

- **Rail oversubscribed** — `availableFund = chainFree − virtual` reads 0 when the empty
  rail already reserves more than the account holds (live: free 454560.80 vs virtual
  456046.21, `planned 3, placing 0` for 84 minutes). Named in the log, flagged on the
  manager, escalated on `SPREAD_STALE_FUND_ESCALATE_MS` (5 min).
- **Geometry bind (`last-fill-blocked`)** — every tightening slot is at/through the last
  fill, i.e. the window is behind the fill. A distinct stall value, preserved through the
  starvation-fallback merge (`mergeSpreadStalls`), escalated on
  `SPREAD_STALE_GEOMETRY_ESCALATE_MS` (10 min).
- **Oscillating measurement** — one in-tolerance reading no longer clears the persistence
  clock; tolerance must hold for `SPREAD_STALE_IN_TOLERANCE_RESET_MS` (10 min), and a
  placed correction still clears it immediately. A single good glance between refusals was
  what let 84 minutes pass.

**RESOLVED (crawl consumption is now scoped).** The clear was ledger-wide while
the derivation folded a subset. `deriveTargetBoundary` now returns
`consumedCrawlIds`, the plan carries it to the commit (`_consumePendingFillCrawls`),
and only the applied records are dropped — a capped fold consumes a same-side
prefix up to the applied magnitude, so the remainder stays owed exactly once.
A commit without the wire consumes nothing. The instrumentation below remains
(and now reports `kept=M`), and the historical leak record is kept for context:

**Original finding (leak #6): the crawl ledger dropped records it never applied.** A commit clears
**all** owed fill crawls whenever the plan's boundary is accepted and not held
(`_clearPendingFillCrawls('boundary commit')`), while the derivation folds only the subset
that passes its batch-dedupe, edge classification and `fallbackCap`. Any excluded entry is
lost — the same class `77e763f6` fixed for the held boundary, still open for the rest, and
the mechanism behind a multi-slot sweep leaving the boundary *behind* the fills.

#### 9.9 Two deadlocks that were bookkeeping, not market (`430dee6a` follow-up)

Both incidents in §9.7/§9.8 ended in a rebuild. Neither was a fund shortage and
neither needed a new guard — each was a self-referential calculation that could
only be broken from outside.

**The budget that vetoed its own placement.** `available = chainFree −
virtualReservation` is the right question for "how much room is left beyond the
projected rail", but the correction then spends it on *that same projection*:
when the rail was sized from a larger balance (or from inventory locked in
resting orders), the reservation exceeds chain free, `available` reads 0, no
placement can consume the reservation, and it can never shrink. Live: free
454560.80 vs virtual 456046.21 — `planned 3, placing 0` every cycle for 84
minutes. The fix is arithmetic, not policy: for a known candidate set the budget
is `min(chainFree, min(virtualReservation, Σ candidate ideals))` when `available`
is 0 (`deriveChainTruthFundBudget`). Bound on both sides, and the chain rejects
an over-commit anyway.

**The crawl that could not catch up.** A boundary crawl is ±1 slot per committed
fill, so once a sweep leaves the window *behind* the fill, crawling is
arithmetically unable to recover: every tightening slot is then at/through the
fill, `passesLastFill` refuses all of them, and the funds sit in the stranded
resting inventory. The cheapest repair (rotate the stranded orders down) is
itself a lower sell, which the same guard forbids — three locks, no key. The fill
is the anchor: `SELL fill at f => boundary ≥ f − gapSlots`, `BUY fill at f =>
boundary ≤ f − 1` (`reanchorBoundaryFromLastFill`), subject to a real
fill-provenanced pivot, an on-ladder price and `validatePersistedBoundary`.

**Deliberately rejected: the pair ledger.** Making each fill mint its counter
order (reserve the exact proceeds) would prove per-trade funding and delete the
`fund-constrained prefix` logic — but it also turns the ladder into a set of
independent round trips, so sizes stop following the side budget. Spread repair
must stay fund-driven from the side pool: a SELL fill returns quote while the
same-side repair needs base, so no fill can ever fund its own side, and pairing
would hide that asymmetry instead of resolving it.

#### 9.10 Review pass over v1.6.12 → v1.6.17 (unreleased)

A code review of the whole 1.6.12→1.6.17 order-engine arc (90 commits) against
the three stated goals — buy-low/sell-high counter orders, never trading through
the last real fill, and repairing a stale/out-of-spread book from free funds —
found the arc sound and identified five gaps. All five are fixed here.

| # | Finding | Fix |
|---|---|---|
| P1 | The re-anchor ignored the crawl's EDGE-fill exclusion: `recordLastFilledPrices` armed the pivot on every fill, and the re-anchor is absolute, so one wick on a floor insurance BUY teleported the window to the grid floor (repro: boundary 29 → 0 on a 60-slot ladder; mirror at the ceiling). | Eligibility now lives at the single pivot writer: `collectEdgePinnedFillIds` (the placement pickers' own classifier) is applied in `recordLastFilledPrices`, so an edge fill can neither arm the guard nor anchor the geometry. Partials still anchor (a real trade; residual allow-listed). Pinned by `tests/test_edge_fill_pivot.ts`. |
| P2 | The rebuild site claimed "the guard re-arms on the first real fill of the new generation" while the read-time fallback silently kept the old-generation pivot — so after a re-center in a market that had moved away, one whole side read `last-fill-blocked` forever AND the 10-minute geometry clock rebuilt the new generation again every cooldown, with no way to succeed. | Re-arm is explicit and logged (`rearmLastFillPivotFromMarketFill`, provenance `fill`, original timestamp) so code and docs agree; the geometry escalation is capped at ONE re-center per pivot (`_lastGeometryResyncPivotKey`) and then reports that only a fill or the pivot TTL restores the side. The pivot's survival is the decision, not an accident. Pinned by `tests/test_last_fill_pivot_rearm.ts` and SLF-11. |
| P3 | `deriveRailBoundary` clamped the boundary to EVERY live rail order: one stray order 18 slots off clamped 138 → 115 and re-typed the whole window (self-legalizing the corrupt state), and it classified rails by slot id while the rest of the engine had moved to live chain prices. | Rail membership = the batch's own op destinations + master orders on their own side of the planned boundary; strays are skipped and named in the log; rail indices come from `resolveLiveOrderLadderPosition`; the result passes the shared `validatePersistedBoundary` gate (cancel/rotation sources allow-listed, sparse ladders excluded because that gate's ceiling is array-derived). Pinned by RAIL-10..14. |
| P4 | The crossing floor (`doesNotCrossMarket`) exists only in the spread-correction planner, so a generic reconcile/re-fill CREATE can execute as a taker fill where the planner would refuse. | Deliberately NOT blocked (a hard veto re-opens the counter-order deadlock: after a gap the counter sits across the floor by construction and executes at the best available price). Made visible instead: `warnCrossingCreate`, once per batch, from cached evidence only. Pinned by SLF-12. |
| P5 | `analysis/grid_correction_check.ts` still implemented the OLD `pivot ± increment/2` band and claimed to mirror the guard 1:1, so it reported the tightening placements the direction-only guard allows as violations. | Predicate reduced to the live direction rule (arity-pinned in LFG-5), report/help text updated, `--increment` documented as informational, edge-fill false-positive class documented. |

Simplifications landed with the fixes: one pivot resolver (two identical copies
merged), one boundary validator for the re-anchor and the rail clamp, one
eligibility rule for the crawl, the pivot and the anchor, the dead
`size`/`increment` parameters of `isLastFillGuardBlocked` removed (an increment
term is no longer reachable through it — LFG-5 pins the arity), and the batch
extremum extracted as `resolveFillAnchorIndex` (pure, batch-only).

---

### A. Grid-Price Invariant — former failure trace

> Companion to [GRID_PRICE_INVARIANT.md](GRID_PRICE_INVARIANT.md), which states the
> invariant and its live enforcement. This appendix preserves the historical trace
> that motivated the guard; the writers below are all closed.

**Two contradictory sources of truth** for "what price is this slot":

| Concept | Source | Used by (then) |
|---|---|---|
| Genesis table | `priceForSlot(idx, genesis)` | grid build, load validation |
| Live slot price | `slot.price`, mutated from chain | COW broadcast, fill-guard pivot |

Every observed violation was the second winning over the first. Five mechanisms fed it:

- **S1 — chain price overwrote the slot's identity price.** Orphan adoption set
  `price: chainOrder.price`, so a slot's id and its price could disagree.
- **S2 — pre-broadcast substitution re-broadcast the corrupted price.** The planned
  (genesis-derived) price was replaced with `liveSlot.price` — whatever S1 wrote — and
  logged at `debug`, so it was invisible.
- **S3 — guards tested range membership, never grid membership.**
- **S4 — the fill-guard pivot was untrusted.** `_lastFilledPrice` was written from fill
  prices at four sites, none validated against the grid.
- **S5 — bypasses skipped even that guard.** Spread-correction origins bypass it by
  design; the guard ran on the "final post-freshness price", i.e. the price S2 had
  already replaced.

The unifying hazard: an off-grid price becomes *grid evidence*, then is re-emitted as
if it were real market structure.

**The writer chain (both links now closed).**

1. **Adoption overwrote the grid level** — `modules/order/sync_engine.ts`, the legacy
   no-genesis fallback (`sync-pass2-adopt-orphan` branch):
   ```ts
   const adoptedOrder = {
       ...adoptedSlot, orderId: chainOrderId, type: chainOrder.type,
       state: adoptedState, size: chainOrder.size,
       price: chainOrder.price,   // <-- genesis price discarded
       ...
   };
   ```
   It also matched by price *tolerance* rather than `slotIndexForPrice` + `isSlotInRail`,
   so it could land an order in a slot whose genesis price was far away — then cement
   that distance.

2. **Pre-broadcast substitution propagated it** — `modules/dexbot_cow_runtime.ts`, the
   CREATE branch's `liveSlot`/`priceDrift` block:
   ```ts
   const effectiveOrder = (priceDrift > 0)
       ? { ...order, price: livePrice, ... }   // planned price discarded
       : order;
   ```
   The name "freshness" implied the live price was *more* correct — only safe if
   `slot.price` were invariantly a genesis level, the exact thing nothing enforced.

**Observed signature:** escalating BUYs at `0.363 → 0.565 → 0.614 → 0.739 → 0.793`
against a ~0.31 market — each a `BUY > pivot` violation — then matched lots sold back
at ~0.306 for roughly -61%, plus a 107-violation burst.

**Provenance caveat (recorded here, not in the contract doc).** Which writer
caused the 2026-08-30 event is **not confirmed**: the mechanism is proven real
at HEAD, but mapping it to that event is inference from fill
prices/timestamps plus the removed `d808c052`/`e2898e51` code. That window's
own logs are gone (retention starts 2026-09-11), so the attribution cannot
retroactively be tightened — treat the writer chain above as the class
mechanism, not as a per-event timeline.

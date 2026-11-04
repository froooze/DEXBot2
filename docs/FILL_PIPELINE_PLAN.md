# Fill Pipeline Consolidation Plan

**Status:** **approved 2026-11-04** — phases P0–P5 unblocked with the decision route
recorded in [§5.1](#51-decisions-accepted-2026-11-04). Three register entries changed
during the baseline review in [§10](#10-baseline-review-2026-11-04) (D2, D3, D6) and two
implementation details were tightened (D5, D8); the changes are binding and are marked on
the register entries.
**Scope:** how a fill (a chain execution against a grid slot) is ingested, booked,
turned into a grid plan, committed, and observed — and how the code around it can be
centralized, simplified and made deterministic.
**Audience:** order-engine maintainers and the operator who has to live with the
fail-closed trade-offs.
**Baseline:** `cb1041b6` (`test`, 2026-11-04 14:22) — the ratchet in P0 pins that tree.

Cross-links: [ORDER_LIFECYCLE](ORDER_LIFECYCLE.md) (existence record),
[COW_INVARIANTS](COW_INVARIANTS.md) (broadcast/plan contract),
[GRID_PRICE_INVARIANT](GRID_PRICE_INVARIANT.md) (level identity),
[TIMING_INVENTORY](TIMING_INVENTORY.md) (the self-healing windows this plan retires),
[GRID_RECONCILE](GRID_RECONCILE.md), [LOGGING](LOGGING.md),
[tests/README](../tests/README.md) (fuzz harnesses).

---

## 1. Problem statement

The fill path is not missing safeguards — it has too many of them, each answering the
same question from a different structure. Seven conflicts are visible in the current tree.

| # | Conflict | Where it lives today | What it has already produced |
|---|---|---|---|
| C1 | Fill dedupe has four layers and three granularities (fill key, chain-size delta, time window) | processed-fill store → `duplicate` (`dexbot_fill_runtime.ts:400`), `_chainSizeAppliedFills` + `alreadyAppliedChainSize` fallback (`sync_engine.ts:257`), persisted applied-amount markers, `_fillDedupeWindowMs` | double-released trade size, phantom residual, "duplicate was the second release, not the trade" |
| C2 | The fill reference has two values and four clocks | `_lastFilledAt`, `_lastMarketFillAt`, the persisted row clock, the TTL read at four sites, plus `lastFillPivotSource` | market-row clock inheritance, edge-wick pivot teleport |
| C3 | Two boundary authorities, with their budgets kept in mutable manager fields | absolute re-anchor vs owed relative crawl; `_boundaryReanchorBudget` set in `dexbot_class.ts:1222`, snapshot/restored in `strategy.ts:298-339` and `dexbot_cow_runtime.ts:3586-3595`; `_boundaryShiftBudget(+Base)` likewise | a nested fill cycle can fork a budget; extremum-vs-last-processed anchor |
| C4 | Plan validity is a judgement assembled from four signals, not an identity | live-geometry stamp, structural-rebuild flag, fill-pivot gate, `_lastHeldPlanSignature`, `replanStaleBatch` policy — which **proceeds anyway** when still stale (`dexbot_cow_runtime.ts:3476-3490`). `_gridVersion` already exists as a mutation counter (`manager.ts:2105`, `:3527`, `grid.ts:917`) and the working grid tracks `baseVersion`, but plans do not carry it | stale plan shipped with a duplicate-order backlog on chain |
| C5 | Deferral is composed per site, and one composition fails open | `hasUnsettledFills` peeks four raw fields and returns `{unsettled:false}` on any throw (`utils/system.ts:2009-2011`); combined differently at `maintenance:814`, `reconcile_internal:2257`, `state_recovery:855` | a swallowed exception makes a grid update look safe in a fail-closed system |
| C6 | "The band" has four definitions | live orders (`getGridBestPrices`), batch rails (`deriveRailBoundary`), analyze-order type buckets, `_spreadCountKnown`, plus the sweep's "in committed band" | a collapsed band reported on target while the chain disagreed |
| C7 | An order's **side** has two facts and no owner: the accounting side and the rail side | `sync_engine.ts:1985` stores the TRADED side into `slot.type` (dimension consistency for `size`), while rail identity is `geometryTypeForSlotIndex(index, boundary, gap)`; the correction validator (`utils/order.ts:797-811`) must require both, and nothing names the distinction | a fill-retagged wrong-rail order looked "repaired", its residual cancel was dropped, and the order stayed on the wrong side (`cb1041b6`) |

The unifying shape is the one the life-cycle registry already fixed for existence:
**one question answered in several places, so the answers can disagree**, and a
"wait, then guess" added wherever they did.

---

## 2. Target architecture

One sentence: fills enter through **one queue**, are booked by **one ledger**, become
**one plan** valid only at **one grid epoch**, and are committed only after **one chain
observation**.

```
chain read ──► fill events ──► ledger (booked keys, applied amounts)
                                   │
                                   ├─► pivot / geometry events
                                   │
                                   ▼
                            plan @ gridEpoch(fillKeys, chainReadAt)
                                   │
                        placement lease (existing)
                                   │
                            commit  ── fence: planEpoch === gridEpoch
                                   │
                            chain observation (watermark)
```

Ownership (one writer per fact, enforced by a ratchet test, not by review):

| Fact | Owner (single module) |
|---|---|
| "is this fill already booked?" | `order/fill_ledger.ts` |
| "what is the fill reference?" | `order/fill_reference.ts` (pivot log — proposed, see the pivot proposal in §3 P2) |
| "does this order exist, and how sure are we?" | `order/lifecycle.ts` (already) |
| "which side is this level on?" | `geometryTypeForSlotIndex` (rail side — **never** `slot.type`, which is the accounting side) |
| "may the grid mutate now?" | `resolveGridUpdateBlockers()` in `order/utils/system.ts` |
| "is this plan still valid?" | `gridEpoch` fence + plan record |
| "has the chain caught up?" | chain watermark |

New invariants live in the `INV-FILL-*` family (existing families:
ACC, BATCH, BROADCAST, COW, GRID, ID, LIFE, MAINT, PROJ, RECON, REG, STATE, SUB, SYNC,
TIME). Proposed core set: one credit per fill key; a plan may only be committed at the
epoch it was built on; an unreadable dedupe/state source is *unknown*, never *settled*;
a fill reference is never derived from a non-trade price for absolute geometry; a
deferral names one reason code; **`slot.type` is the accounting side and rail identity is
geometry — a repair proof needs both and never defaults unknown geometry** (C7).

---

## 3. Phases

Each phase ships independently and leaves the tree green. **A phase may not be merged
with an unproven gate**: the gate is the definition of "done" for that phase.

### P0 — Freeze the contract (1 d, no behaviour change)

- `docs/FILL_PIPELINE.md`: the six stages, the four states
  (`unknown / queued / booked / committed`), who writes what, and `INV-FILL-001..00N`.
- `tests/test_fill_pipeline_contract.ts`: a **ratchet**, not a spec. It enumerates the
  **ten call sites** of `_processFillsWithBatching` (`maintenance:2000,2144,3242,3852`,
  `fill_runtime:915,1495`, `startup:302,411,435,741`) plus the three non-call sites that
  must not silently become adapters (`dexbot_class:805` bootstrap mode, `:1178` the
  definition, `types.ts:350` the interface), the pivot-scalar writers, the four dedupe
  layers and the two budget fields, and fails when a **new** one appears.
- Gate: the ratchet goes red when a caller or writer is added. Later phases edit the
  test deliberately — that edit is the review.
- Risk: none behavioural; the only new failure mode is a red build on silent
  re-duplication, which is the point.

### P1 — One blocking decision, fail-closed (2 d)

- `resolveGridUpdateBlockers(source): { code, detail }[]` next to `hasUnsettledFills`;
  codes `fill-queued | fill-deferred | fill-in-flight | crawl-owed |
  broadcast-pending | placement-held | rebuild-active | unknown-blocker`
  (`snapshot-unsound` was dropped while implementing: the snapshot gate composes
  its own conditions and an unproduced code is a lie in a closed list).
- `hasUnsettledFills` becomes a projection over it; the `catch` at `:2009` becomes
  `unknown-blocker` → **blocked**. Raw field peeks move behind one typed accessor.
- The three named sites log reason codes, not prose; every call site can. Reasons become
  assertable in tests.
- Gates: a source-throws fixture must be blocked; a code-list test (adding a code is a
  deliberate edit); a grep-ratchet that nobody peeks those fields outside the accessor.
- Risk: a fail-closed accessor can stall fills. Bound it with the one-cycle defer and
  escalate to a structural resync after N consecutive blocked cycles (see D5).
- Scope note from `cb1041b6`: a **grid blocker** (may the grid mutate?) is not a
  **per-action wait** (`fresh-placement-grace`) and not a **must-not-wait** fact
  (`known-wrong-side`, proven by the correction queue's chain-observed `typeMismatch`).
  The resolver owns only the first; the other two stay with the planner and the
  correction queue, and P1 must not swallow them into a code.

### P2 — One fill identity, one ledger (3 d)

- `order/fill_ledger.ts` owns `fillKey(op)` — today `buildFillKey` and
  `buildOrphanFillFallbackKey` live in `dexbot_fill_runtime.ts:376,1277` and the
  accounting layer never sees the decision — **and `resolveFillSide(fillOp)`**, because
  `6afa0c4b` made the paid asset part of fill identity, plus an in-memory booked-key
  index and applied amounts per chain order id.
- Exit also removes `FILL_DEDUPE_WINDOW_MS` (the `_recentlyQueuedFills` window) **if**
  the store mark is proven synchronous at credit time; otherwise the window stays and P5
  keeps it.
- `processFillAccounting` consults the ledger first; `_chainSizeAppliedFills`,
  `alreadyAppliedChainSize` and the persisted applied-marker become **assertions**: on
  mismatch the ledger wins and logs `[FILL-LEDGER] divergence`. Same trick as
  `order/lifecycle.ts` (legacy structures become views).
- The fill event records **both sides** (`tradedSide` = accounting, `railSideAtFill` =
  geometry), because `sync_engine.ts:1985` retags `slot.type` to the traded side (C7).
- P2 removes duplicate **booking**, not geometric **re-validation**:
  `_validatePriceCorrectionEntry` must keep comparing rail geometry after the ledger
  lands, because a late fill can still retag a slot between drain and broadcast.
- Gates: the same fill applied twice through every entry point (queue, orphan sweep,
  bootstrap replay, post-reset) yields exactly one credit; existing idempotency suites
  pass untouched; a divergence fixture proves the assertion path cannot double-book.
- Risk: persistence contract — see D4 for where the authority lives.

### P3 — One consumer (5 d, highest risk)

- `requestFillDrain(bot, reason)` becomes the only entry point; the ten call sites
  enqueue instead of calling. A single serialized consumer owns
  drain → accounting → pivot append → plan → lease → commit → observe.
- A typed deferral enum replaces the `deferred` boolean and the five prose reasons; one
  retry policy; the three retry triggers (region-end hook, scheduled rebalance,
  maintenance tick) collapse into one idempotent schedule.
- Gates: N concurrent requests → one ordered drain; a deferred drain is retried by
  exactly one trigger; `recon_fuzz` drives `requestFillDrain` instead of the internals.
- Risk: startup/replay sequencing changes. Ship with coalescing behaviour-identical,
  then apply D2.

### P4 — Epoch fence (5 d, depends on P3)

- Introduce `gridEpoch` as the structural counterpart to `_gridVersion` (which keeps its
  cache-invalidation job — it bumps per slot mutation), bumped in one funnel behind
  `isPlanInvalidatingMutation`. Plans carry `{ planEpoch, fillKeys, chainReadAt }`.
  *(D3 amended during the baseline review — see §10.2.)* The predicate must treat a
  `type` change as structural **only when the rail side changes**: a partial fill
  retagging `slot.type` to the traded side (C7) is bookkeeping and must not invalidate
  the plan it belongs to, or P4 trips its own "correct plan refused" stop condition.
- `evaluateCommit` refuses on `planEpoch !== gridEpoch`; `replanStaleBatch` becomes
  "re-derive at the current epoch" and the "proceed anyway" branch is deleted. The
  four-signal staleness judgement demotes from gates to log fields — they were proxies
  for the epoch.
- Gates: fuzz op `mutate-before-commit` → zero chain ops; invariant "every broadcast
  has `planEpoch === gridEpoch` at broadcast time"; a mutation test that removes the
  check and watches the fuzzer catch a duplicate.
- Risk: deleting "proceed anyway" is sound only because P3 guarantees the invalidating
  fills are carried forward. Do not merge P4 before P3.

### P5 — Chain watermark, retire timers (5–10 d, last)

- Record `{ height, openOrderIdsHash, balancesHash }` per plan; commit requires a read
  at ≥ plan height. `getLivePendingBroadcasts`' TTL becomes "unknown until a watermark
  newer than the record".
- Remove the **four** fill-path `self-healing` windows from `TIMING_INVENTORY.md` one PR
  at a time (scope D6), each with the live-validation note; the remaining two need their
  own live evidence and are out of scope. The four must reach zero for this phase to be
  done.
- Gate: each removed window ships with the test that previously needed the timer plus
  live evidence; no phase is closed on tests alone.

---

## 4. What gets deleted (the simplification ledger)

| Today | After |
|---|---|
| 2 budget manager fields + 6 save/restore sites | 1 per-cycle context object |
| 3 shadow dedupe layers | assertions in 1 ledger |
| 4 staleness signals + "proceed anyway" | 1 epoch |
| 10 direct call sites of the batch processor | 1 queue, 1 consumer |
| 4 fill-reference clocks + `lastFillPivotSource` | 1 event log (pivot P0/P1 rides P2) |
| ≥5 deferral booleans/strings | 1 enum |

Net expectation: roughly −500 lines in `dexbot_cow_runtime` / `dexbot_fill_runtime`,
+800 in three focused modules. The win is fewer predicates, not fewer lines.

---

## 5. Decision register (decided 2026-11-04 — route in §5.1)

Each decision names the phase it unblocks, the options, the recommendation, and what
happens if the recommendation is rejected. **Operator decisions** are product/policy
risk trades; **engineering decisions** are internal contracts.

### D1 — Stale plan under an epoch mismatch *(operator; unblocks P4)*

The current policy deliberately proceeds with a stale plan and requests a resync,
because aborting would drop the fill set (`dexbot_cow_runtime.ts:3476-3490`).

- **A. Refuse and re-derive** — deterministic; costs one deferred cycle inside the
  unsettled-fill window. Requires P3.
- **B. Bounded re-plan, then refuse** — re-plan once, refuse if still stale; no
  "proceed".
- **C. Keep "proceed anyway" + resync** — status quo; keeps the duplicate window.

**Recommendation: A**, once P3 exists. Rejecting A means the fence cannot be described
as deterministic, and P4's gates must be rewritten to "proceed is logged, not
prevented" — in which case P4 is not worth doing before P5.

### D2 — Backlog replay ordering *(operator; unblocks P3 exit)*

`shouldCoalesceBacklogReplay` is opt-in today because a chunked replay once mutated the
boundary between broadcasts.

- **A. Mandatory coalescing** — one plan for the backlog, no boundary movement between
  broadcasts. Changes startup replay semantics.
- **B. Keep opt-in** — status quo; two behaviours to test forever.
- **C. Threshold** — coalesce above N fills, chunk below.

**Recommendation: A**, shipped only after P3's ordering test proves it. Rejecting A
keeps the chunked path as a permanent second behaviour; then P3's fence must also fence
*chunk boundaries*.

> **ACCEPTED 2026-11-04 — A, with a smaller diff than expected.** `6afa0c4b` already
> rolled the behaviour out operationally (every configured bot opts in via
> `fillProcessing.COALESCE_BACKLOG_REPLAY`) while the code default stays `false`
> (`constants.ts:1079`). The remaining work is therefore: keep the mechanism, prove it
> once with the P3 ordering test, then flip the default and delete the false path. No
> second production behaviour is being introduced — it is already in the field.

### D3 — Is `_gridVersion` the fence? *(engineering; unblocks P4)*

- **A. Promote it** to `gridEpoch` in the plan interface; one funnel bumps it.
- **B. Keep it private** (cache invalidation) and add a separate epoch.
- **C. No fence** — rely on the four existing signals.

**Recommendation: B** *(amended from A during the baseline review).* `_gridVersion` is
bumped in `_applyOrderUpdate` on **every** slot mutation (`manager.ts:2110`), including
size/balance bookkeeping, so promoting it as the plan fence would refuse correct plans
whenever accounting touches a slot — the exact stop condition in [§7](#7-stop-conditions).
Keep `_gridVersion` as the cache-invalidation counter it is, and add a **structural**
`gridEpoch` bumped from the same funnel behind one predicate
`isPlanInvalidatingMutation(oldSlot, newSlot, context)` (state, type, price, chain id,
slot set, boundary). Two counters, two questions, no duplication of purpose.

### D4 — Where the dedupe authority lives *(engineering; unblocks P2)*

`_processedFillStore` already persists fill keys; the snapshot carries the size markers.

- **A. New field in the grid snapshot** — survives with the grid, but couples fill
  history to the grid document.
- **B. Existing processed-fill store is the authority**, ledger is an in-memory index.
- **C. Both**, ledger wins, store keeps the audit trail.

**Recommendation: B** (the store already exists, is flushed by key, and survives grid
rebuilds). Rejecting B means adding a snapshot field, which then must be pruned,
versioned and migrated — an order of magnitude more work for no new guarantee.

### D5 — Fail-closed escalation *(operator; unblocks P1)*

A blocked resolver that is wrong stalls trading.

- **A. Blocked forever until the reason clears** — safest, can stall indefinitely.
- **B. Blocked, escalate to structural resync after N cycles** — self-healing, but
  reintroduces a timer.
- **C. Blocked only for a whitelist of codes**, unknown codes pass.

**Recommendation: B** with N named in the contract and logged —
`GRID_BLOCKED_ESCALATE_CYCLES`, a counter, not a `TIMING` entry. C is the fail-open bug
this phase exists to remove.

### D6 — Timer-removal scope in P5 *(operator; unblocks P5)*

- **A. All six self-healing windows** in this arc.
- **B. The four on the fill path now, the rest later.**
- **C. Only those with a live incident behind them.**

**Recommendation: B**, scope corrected to **four** windows (baseline review):
`FILL_BROADCAST_DEFER_MAX_MS`, `FILL_DEDUPE_WINDOW_MS`,
`CHAIN_SIZE_APPLIED_MARKER_TTL_MS`, `STRUCTURAL_REBUILD_DEFER_MAX_MS`. The remaining two
(`SURPLUS_CANCEL_GRACE_MS`, `PENDING_BROADCAST_TTL_MS`) are placement/broadcast policy and
stay out.

> **ACCEPTED 2026-11-04 — B, amended.** `FILL_DEDUPE_WINDOW_MS` moves **into P2** rather
> than P5: once `ProcessedFillStore` is the dedupe authority and is marked synchronously
> at credit time, the requeue window in `_isNewFillKey` is redundant. P2 must verify
> the synchronous mark; if it does not hold, the window stays and P5 keeps it.

### D7 — Does the epoch cover account state? *(engineering; unblocks P4)*

- **A. Grid only**, account freshness handled by the P5 watermark.
- **B. `{ gridEpoch, accountEpoch }`** — two fences from the start.

**Recommendation: A.** B adds a second number before there is evidence a single epoch
is insufficient; the fuzz op in P4 will say if that changes.

### D8 — Where the single consumer lives *(engineering; unblocks P3)*

- **A. Extend `dexbot_fill_runtime.ts`** — it becomes the pipeline.
- **B. New `modules/dexbot_fill_pipeline.ts`**, fill runtime keeps the ingest adapters.

**Recommendation: B** — the file is already 1,683 lines and the pipeline is a distinct
responsibility; keeping the name `fill_runtime` for "reading fills" makes the boundary
review-visible.

### D9 — Contract-test strictness *(engineering; unblocks P0)*

- **A. Ratchet**: a new caller/writer fails the suite.
- **B. Documentation only**: the contract is prose.

**Recommendation: A.** The tree already proves review discipline alone does not hold
(seven existence structures, four dedupe layers).

---

### 5.1 Decisions accepted 2026-11-04

| Decision | Route taken | Note |
|---|---|---|
| D1 stale plan at epoch mismatch | **A** — refuse and re-derive | A fence with a "proceed anyway" branch is documentation, not determinism |
| D2 backlog replay ordering | **A** — mandatory coalescing | Behaviour already rolled out operationally in `6afa0c4b`; remaining work is the default flip |
| D3 is `_gridVersion` the fence | **B (amended)** — keep it private, add a structural `gridEpoch` | `_gridVersion` bumps per slot mutation for cache invalidation (`manager.ts:2110`) |
| D4 dedupe authority | **B** — `order/processed_fill_store.ts` is the authority | The store already persists a `Map<fillKey, timestamp>` and is shared by bot and manager (`fill_runtime.ts:211`) |
| D5 fail-closed escalation | **B** — block, escalate after N cycles | Escalation is a **counter**, not a timing window (no new millisecond knob) |
| D6 timer-removal scope | **B (amended)** — four fill-path windows | `FILL_DEDUPE_WINDOW_MS` accelerated into P2 |
| D7 epoch scope | **A** — grid only, account freshness via the P5 watermark | |
| D8 single consumer location | **B** — new `modules/dexbot_fill_pipeline.ts` | Requires a `browser`-field `false` entry plus a bundle check |
| D9 contract strictness | **A** — ratchet test | Baseline pinned at `cb1041b6` |
---

## 6. Definition of done

1. `recon_fuzz` gains three operations (`mutate-before-commit`, `duplicate-fill-replay`,
   `lagging-read-then-fill`) and two invariants (epoch match, single credit).
2. No production write to a fill/dedupe/pivot field outside its owning module —
   enforced by the ratchet.
3. Every `INV-FILL-*` has a mutation test: revert the rule, the suite goes red.
4. The two historical incidents exist as replayable fixtures and pass.
5. `self-healing` timing windows reach the scope chosen in D6.

## 7. Stop conditions

- **P2** cannot reproduce the current credit count on the recorded fixtures → stop; keep
  the ledger assertion-only and do not delete the shadow layers.
- **P3** changes any credit or order count in the existing suite → revert to
  enqueue-only and re-scope.
- **P4**'s fuzz op finds a *correct* plan refused → the epoch is too coarse; model
  `{ epoch, account }` before widening the fence.
- **P5** cannot name the evidence that replaces a window → that window stays.

## 8. Sequencing and effort

| Phase | Effort | Blocked by |
|---|---|---|
| P0 contract + ratchet | 1 d | — (D9 accepted) |
| P1 blockers, fail-closed | 2 d | — (D5 accepted) |
| P2 ledger | 3 d | — (D4 accepted; ∥ P1) |
| P3 consumer | 5 d | D2 exit test, D8 module |
| P4 epoch fence | 5 d | D1, D7, P3, and the `gridEpoch` predicate (D3 amended) |
| P5 watermark + timers | 5–10 d | D6 (4 windows, one already in P2), P4 |

Total: ~3–4 weeks of focused work, each phase independently shippable.

## 9. Non-goals

- No new guards or allow-lists. Every phase removes a predicate or gives one an owner.
- No change to order sizes, boundary semantics, strategy, or market adaptation.
- No TTL widening; the only timing changes are removals (P5).
- Not a rewrite of `SyncEngine` adoption — P2/P4 touch its *inputs*, not its matching.

---

## 10. Baseline review (2026-11-04)

The plan was reviewed against the tree at `cb1041b6`, including the three commits that
landed after the v1.7.1 version bump.

### 10.1 What the three commits after the version bump changed for this plan

`3edf8cb3` — *release leaked broadcast regions and cancel wrong-side fills*

- The COW executor called `startBroadcasting()` before building ops, and every early
  return leaked the refcount until the 120 s stale-flag watchdog. **The fill consumer was
  frozen by a leaked region, not by a decision.** Consequence for P1: a held region is
  either *legitimate* (a live batch) or *a defect* (a leak); the blocker code must say
  which, using the existing watchdog age rather than a new rule. A non-zero
  "leaked-region released" count blocks P1 sign-off — it is a bug signal, not a wait.
- Type-mismatch corrections are now exempt from the 15-minute fresh-placement grace,
  because a known-wrong order must not rest. Consequence for P1: the surplus-cancel path
  must not be re-routed through the blocker resolver in a way that re-applies that grace.
- Tests added: `test_cow_guard_replan` (refcount balanced on zero-op/replan returns),
  `test_correction_queue_staleness`, `test_fill_batch_chunking` (16-fill backlog plans
  once and stamps the pivot from the whole cycle).

`6afa0c4b` — *derive fill side from paid asset, roll out backlog coalescing*

- `_computeFillContext()` now resolves the side from the fill's **paid asset** (pays quote
  = BUY, pays base = SELL) instead of `matchedGridOrder.type`. A retyped slot used to
  produce `filledAmount = 0` and a re-buy at the fill level. Consequence for P2: **side
  derivation is part of fill identity** and must live in the ledger module next to
  `fillKey(op)`; a ledger that keys a fill while a caller decides its side would
  re-introduce the split. The same guard is needed in the unmatched-fill attribution and
  the queued-pivot refresh (both already patched — P2 formalises it).
- Coalescing was rolled out operationally (all configured bots opt in via
  `fillProcessing.COALESCE_BACKLOG_REPLAY`; code default remains `false`,
  `constants.ts:1079`). Consequence for P3: the mechanism is proven in a live backlog;
  the exit criterion is the default flip, not a new behaviour.

`cb1041b6` — *never park a chain-observed wrong-side cancel*

- **A third side-fact appeared, and C7 was added for it.** Two guards each parked a
  known-wrong order for another cycle: the COW fresh-placement grace deferred every fresh
  CANCEL, and the correction queue's repair validator accepted a retagged `slot.type` as
  proof of repair. The fix (a) exempts a fresh CANCEL only when the correction queue holds
  a **chain-observed** `typeMismatch` for that chain id — a plan-shaped
  `reason: 'type-mismatch'` action still waits — and (b) requires `slot.type` **and** rail
  geometry to agree before a level counts as repaired.
- Consequence for P2: the ledger must carry both sides per fill; `resolveFillSide()` is
  the *accounting* resolver, not a rail classifier.
- Consequence for P4: `isPlanInvalidatingMutation` must not treat a traded-side retag as
  structural, or every partial fill refuses its own plan.
- Consequence for P1: three distinct concepts now share the word "defer" — grid blocker,
  per-action grace, must-not-wait. See the scope note in §3 P1.
- **Proof paths must not default unknown geometry.** The validator reads
  `manager.boundaryIdx` and `manager._gapSlots` raw and falls back to the stored-type
  check when either is unknown. That is the opposite of the `resolveGapSlots` rule (which
  substitutes the config-derived gap for *decisions*), and it is correct here: a repair
  proof may never invent a rail. Recorded in §10.3 so the next refactor does not "unify"
  the two reads.
- Tests: `test_fresh_placement_cancel_grace_paths` (exemption vs plain fresh surplus),
  `test_correction_queue_staleness` (fill-retagged slot on the opposite rail still
  cancels; gap-band level; genuinely repaired rail), `test_fill_transition_idempotency`
  (partial-fill transition keeps the traded side).

### 10.2 Defaults checked against the code

| Decision | Verified against | Finding |
|---|---|---|
| D4 = store authority | `order/processed_fill_store.ts` (`tracker: Map<string, number>`), `fill_runtime.ts:204-211` (bot store merged with `manager.processedFillTracker`, also published as `manager.processedFillStore`), `_isNewFillKey` (`dexbot_class.ts:667`) | Implementable and **cheaper than planned**: the accounting path already holds `fillKey` and can reach the same store through the manager. `_recentlyQueuedFills` (the time window) is the only layer that becomes redundant — hence the D6 amendment. |
| D5 = escalate after N | `fireStructuralResync(bot, reason, details, errorLabel, level)` (`utils/system.ts:3153`) is sync-safe and swallows its own errors | It needs a **bot**, while the resolver may only receive a manager. Keep `resolveGridUpdateBlockers()` pure (codes + counts) and let the fill consumer escalate. N is a counter (`GRID_BLOCKED_ESCALATE_CYCLES`), deliberately **not** a `TIMING` entry. |
| D3 = epoch | `_applyOrderUpdate` bumps `_gridVersion` (`manager.ts:2110`), COW commit bumps it (`:3527`), grid regeneration bumps it (`grid.ts:917`) | Too coarse as the fence: bookkeeping mutations would refuse correct plans. Requires the `isPlanInvalidatingMutation` predicate. |
| D2 = coalescing | `shouldCoalesceBacklogReplay` (`dexbot_class.ts:121-128`), `FILL_PROCESSING.COALESCE_BACKLOG_REPLAY: false` | Already in the field per bot; P3 exit is a one-line default flip plus deleting the false path. |
| D8 = new module | `package.json` `browser` field lists `dexbot_fill_runtime.js` and `dexbot_cow_runtime.js` → `false`; `scripts/verify-browser-bundle.ts` has an explicit browser-safe entry list | A new node-only module needs only `"./dist/modules/dexbot_fill_pipeline.js": false`; do **not** add it to the browser-safe entry list. |
| D6 = four windows | `TIMING_INVENTORY.md` removal table + `timing_policy.ts` classifications | Confirmed 4 fill-path windows; `FILL_DEDUPE_WINDOW_MS` can go in P2 (not P5) if the store mark is synchronous. |
| D9 = ratchet | `tests/test_public_surface_guard.ts` (scans production `.ts` files, fails on `__test` misuse) | The pattern exists; reuse its file-walk rather than writing a second scanner. |
| P0 baseline | `cb1041b6` | The three commits added no caller of `_processFillsWithBatching`; the ten-call-site list in P0 is unchanged. |
| C7 split | `sync_engine.ts:1985`, `utils/order.ts:797-811`, `geometryTypeForSlotIndex` (`utils/order.ts:1864`) | Confirms `slot.type` is now the accounting side. The helper already fails closed on unknown index/boundary/gap, so the new invariant needs no new code — only an owner and a test. |

### 10.3 Plan deltas accepted

1. **P2 absorbs two things:** `resolveFillSide(fillOp)` joins `fillKey(op)` as fill
   identity, and `FILL_DEDUPE_WINDOW_MS` removal moves from P5 to P2 (conditional on the
   synchronous store mark).
2. **P4 needs the mutation predicate** (`isPlanInvalidatingMutation`) before the fence can
   be trusted; `gridEpoch` is a second counter, not a rename of `_gridVersion`.
3. **P1 gains a defect signal:** leaked broadcast regions are counted and must reach zero
   for sign-off; the existing 120 s watchdog stays the detector.
4. **P3's coalescing exit is a default flip**, not a behaviour change — the rollout is
   already live.
5. **C7 enters the plan** (`cb1041b6`): rail side gets an owner
   (`geometryTypeForSlotIndex`), `slot.type` is documented as the accounting side, and
   P2 records both sides per fill event.
6. **P4's mutation predicate is refined by C7**: a traded-side retag is bookkeeping, a
   rail-side change is structural.
7. **Two geometry reads stay apart on purpose**: `resolveGapSlots` may default for
   decisions, a repair proof may not. Any future "unify the gap reader" cleanup must
   exclude `_validatePriceCorrectionEntry`.

---

## 11. Regression plan

Per phase: the canaries that must stay green, the failure signature that means "stop",
and the change an operator would notice.

### P0 — contract + ratchet
- Canaries: `test_public_surface_guard`, full suite.
- Signature: the ratchet fails on an **unchanged** tree → the baseline list is wrong; fix
  the list, never loosen the assertion.
- Operator-visible: nothing.

### P1 — blockers, fail-closed
- Canaries: `test_fill_transition_idempotency`, `test_cow_guard_replan` (region refcount),
  `test_fresh_placement_cancel_grace_paths` (grace vs known-wrong-side),
  `test_gap_evac_spread_collapse`, `test_spread_*`, `test_snapshot_reject_gate`.
- Signature: a cycle blocked while `hasUnsettledFills` reports settled → accessor bug;
  revert to the previous composition for that code, keep the code list.
- Signature: leaked-region count > 0 → the leak fix regressed; do not sign off P1.
- Operator-visible: a blocked grid update now names a code instead of a sentence; nothing
  else changes.

### P2 — fill ledger
- Canaries: `test_fill_transition_idempotency`, `test_orphan_fill_death_spiral`,
  `test_recent_own_cancels`, `test_fill_subscription_lifecycle`,
  `test_live_geometry_provenance` (FILL-SIDE-1..4), `test_fill_batch_chunking`, snapshot
  restore suites.
- Signature: any change in credit count or order count on the fixtures → stop (see §7).
- Signature: `[FILL-LEDGER] divergence` on a clean replay → the ledger is missing a
  booking path; add it, do not silence the assertion.
- Operator-visible: none by design; `FILL_DEDUPE_WINDOW_MS` disappears from the timing
  inventory if the conditional holds.

### P3 — single consumer
- Canaries: `test_fill_batch_chunking`, `test_cow_guard_replan`,
  `test_correction_queue_staleness`, startup/recovery suites, `recon_fuzz`.
- Signature: a fill credited twice or a drain executed twice in one cycle → stop and
  re-scope to enqueue-only.
- Signature: startup replay order changes → keep coalescing behaviour-identical and defer
  the default flip.
- Operator-visible: coalescing becomes the default (already opted in per bot), so a
  backlog replays as one plan.

### P4 — epoch fence
- Canaries: `recon_fuzz` (new `mutate-before-commit` op), working-grid suites,
  `test_price_collision_guard`, `test_gap_evac_*`,
  `test_correction_queue_staleness` (retag is not a repair, not a structural change).
- Signature: a correct plan refused → the predicate is too broad (bookkeeping counted as
  structural). Add the case to the predicate test; do not widen the fence.
- Signature: repeated re-derive on the same fill set → cap by a counter and log; never
  reintroduce a "proceed anyway".
- Operator-visible: one deferred cycle in the unsettled window instead of a possibly
  stale plan.

### P5 — watermark + timers
- Canaries: `test_timing_policy` (self-healing count must fall), one test per removed
  window, `recon_fuzz`.
- Signature: removing a window exposes a lost-state path → that window stays; record why
  in the inventory.
- Operator-visible: fewer, shorter stalls; the fill consumer reacts to evidence instead of
  a clock.

---

## 12. Immediate next steps

1. **P0.1** — write `docs/FILL_PIPELINE.md` (§2 of this plan + `INV-FILL-*`).
2. **P0.2** — `tests/test_fill_pipeline_contract.ts` pinned at `cb1041b6`, reusing the
   scanner from `test_public_surface_guard`.
3. **P1.1** — `resolveGridUpdateBlockers()` with eight codes; projection from
   `hasUnsettledFills`; fail-closed accessor.
4. **P1.2** — `GRID_BLOCKED_ESCALATE_CYCLES` counter (no `TIMING` entry) and the
   leaked-region signal.
5. **P2.1** — `fill_ledger.ts` owning `fillKey(op)`, `resolveFillSide(fillOp)`, and the
   `ProcessedFillStore.tracker` membership check.

---

## 13. Implementation log

### 2026-11-04 — P0, P1 and the P2 identity slice landed

Baseline for this log: `cb1041b6` + the P0/P1/P2 commit.

**P0 — contract + ratchet (done)**
- `docs/FILL_PIPELINE.md`: the six stages, four states, ownership table,
  `INV-FILL-001..007`. It states explicitly what is NOT covered yet (P3/P4/P5).
- `tests/test_fill_pipeline_contract.ts`: ratchet over ten batch-processor call
  sites, the two pivot writers, the three boundary-budget files, the nine dedupe
  references, the single fill-identity owner and the closed blocker code list.
- `docs/COW_INVARIANTS.md` refreshed while landing it: `INV-RECON-006` now records
  the chain-observed `typeMismatch` exemption (`cb1041b6` changed the code but not
  the invariant) and `INV-SYNC-008` records that the pays-asset mapping has one
  implementation and that `slot.type` is the accounting side.

**P1 — one blocking decision, fail-closed (done, one narrowing)**
- `resolveGridUpdateBlockers(source)` in `order/utils/system.ts` returns eight
  closed codes (`snapshot-unsound` was dropped from the declaration: the snapshot
  gate composes its own conditions in `dexbot_state_recovery.ts`, and an unused
  code would be a lie in the closed list); `readFillPipelineState()` is the single field reader and reports
  `ok: false` (→ `unknown-blocker`) instead of the old fail-open `{unsettled:
  false}` catch; `hasUnsettledFills()` is now only a projection, so the prose
  reason and the codes cannot disagree.
- Composition, not new evidence: the broadcast question goes through
  `getLivePendingBroadcasts` (`INV-BROADCAST-005`), the region through
  `isPlacementActive`, the rebuild through `isStructuralRebuildInProgress`.
- **Narrowing vs the original D5 text:** escalation fires only for
  `unknown-blocker`, not for any blocked cycle. A busy pipeline (fills in flight,
  an unresolved broadcast, a held region) is normal work with its own watchdog;
  escalating on it would resync healthy bots running long batches. The counter is
  `FILL_PROCESSING.GRID_BLOCKED_ESCALATE_CYCLES` (12 consecutive attempts), a
  cycle count and deliberately not a `TIMING` entry. Wired at the targeted-drift
  gate in `dexbot_maintenance_runtime.ts`, which is the per-attempt site that
  already refused the grid update. **Behavioural change:** that gate now defers on
  ANY blocker, not only the fill codes — the reconcile is chain-mutating and an
  unresolved broadcast/region is exactly the stale-master case it guards; the old
  condition could escalate on an unreadable probe and still reconcile in the same
  tick.
- The invariant this implements is `INV-FILL-004`: a grid blocker is not the
  per-action grace and not the known-wrong-side fact. The resolver owns only the
  first, which is why `resolveGridUpdateBlockers` does not read the correction
  queue.

**P2 slice — fill identity centralised (done)**
- `modules/order/fill_ledger.ts` owns `fillKeyOf` (with `buildFillKey` kept as an
  alias in `utils/order.ts`) and `resolveTradedSide`; `isFillBooked` exposes the
  persisted store's membership without claiming it (booking still belongs to the
  store, per D4=B).
- Wired into all three former copies: `SyncEngine._computeFillContext`,
  `attributeUnmatchedFillToGrid`, and the queued pivot refresh in
  `dexbot_cow_runtime.ts`. The SPREAD price fallback stays with the caller that
  owns the ladder (`resolveSpreadOrderSide`), as designed.
- Still open from P2: demoting `_chainSizeAppliedFills` / `alreadyAppliedChainSize`
  / the persisted marker to assertions, and removing `FILL_DEDUPE_WINDOW_MS`
  (conditional on proving the store mark is synchronous at credit time).

**Gates run**
- `npm test`: 356/356 files, 14 live skipped, 0 failed (353 before + 3 new).
- `typecheck`, `typecheck:analysis`, `check:any`, `verify:browser-bundle` (44/44)
  clean. `fill_ledger.ts` imports only constants, so it is browser-safe and needs
  no `browser`-field entry.

**Changed assumption for P4 (from the invariant review)**
`INV-COW-003` explicitly documents "still stale → proceed + structural resync".
P4 deletes that branch, so it is an **invariant change**: the same commit must
rewrite `INV-COW-003` (and note the new structural `gridEpoch` beside
`INV-COW-005`, whose `_gridVersion` bump stays) with the rationale and the
regression test, per the Change Policy in `COW_INVARIANTS.md`.

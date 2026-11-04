# Fill Pipeline

> **Status:** P0 (contract + ratchet), P1 (fail-closed grid blockers) and P2 (one fill
> identity + the dedupe authority) are **implemented** — `b2f43d8a` and the P2-tail commit.
> P3–P5 are sequenced below with their gates and stop conditions. This is the single
> fill-pipeline document: contract, decisions, remaining plan, regression canaries.
>
> **Baseline:** `cb1041b6` (`test`, 2026-11-04). The ratchet pins that tree.
>
> **Cross-links:** [ORDER_LIFECYCLE](ORDER_LIFECYCLE.md) (existence record),
> [COW_INVARIANTS](COW_INVARIANTS.md) (broadcast/plan contract),
> [GRID_PRICE_INVARIANT](GRID_PRICE_INVARIANT.md) (level identity),
> [TIMING_INVENTORY](TIMING_INVENTORY.md) (the windows this arc retires),
> [GRID_RECONCILE](GRID_RECONCILE.md), [tests/README](../tests/README.md) (fuzz harnesses).

---

## 1. Why this pipeline has its own document

The fill path is not missing safeguards — it has too many, each answering the same
question from a different structure, so the answers can disagree. Each conflict below
produced (or nearly produced) a live incident; the fix is an owner, not another guard.

| # | Conflict | What it already produced | State |
|---|---|---|---|
| C1 | Fill dedupe had four layers, three granularities: booked key, chain-size delta, applied-amount boolean, time window | double-released trade size (`3.6604 → 3.3046 → 2.9488`), phantom residual | **closed**: store is the authority, marked at credit time; boolean channel deleted; window re-scoped as a claim lease |
| C2 | The fill reference had two values and four clocks (`_lastFilledAt`, `_lastMarketFillAt`, persisted row clock, TTL at four sites) + `lastFillPivotSource` | market-row clock inheritance (REARM-6/7/8), edge-wick pivot teleport | open (pivot event log) |
| C3 | Two boundary authorities with budgets in mutable manager fields (re-anchor vs owed crawl), snapshot/restored at six sites | a nested fill cycle forks a budget; extremum-vs-last-processed anchor | open (P3) |
| C4 | Plan validity is a judgement over four signals, one of which **proceeds anyway** when still stale | stale plan shipped with a duplicate-order backlog on chain | open (P4) |
| C5 | Deferral composed per site; `hasUnsettledFills` failed **open** on a read error | a swallowed exception made a grid update look safe | **closed**: closed code list, unreadable = `unknown-blocker` |
| C6 | "The band" has four definitions (live orders, batch rails, analyzer buckets, `_spreadCountKnown`) | collapsed band reported on target while the chain disagreed | open (no phase claimed) |
| C7 | An order's **side** is two facts with no owner: accounting side (`slot.type`, retagged by a partial fill) and rail side (`geometryTypeForSlotIndex`) | a fill-retagged wrong-rail order looked "repaired"; its residual cancel was dropped (`cb1041b6`) | **named**: one owner per fact, never conflated |

The unifying shape is the one the life-cycle registry already fixed for existence: **one
question answered in several places**, and a "wait, then guess" added wherever they
disagreed.

---

## 2. Contract

### 2.1 The six stages

```
chain read ──► ingest ──► ledger ──► pivot/geometry ──► plan ──► lease ──► commit ──► observe
```

| # | Stage | Owner today | Contract |
|---|---|---|---|
| 1 | **Ingest** — a fill enters the queue | `dexbot_fill_runtime.ts`, subscriptions | Back-pressure at `MAX_INCOMING_FILL_QUEUE`; a rejected fill leaves the cursor retryable (`INV-SYNC-005`). |
| 2 | **Ledger** — identity + booked membership | `order/fill_ledger.ts` (identity), `order/processed_fill_store.ts` (authority) | `fillKeyOf()` is the only key builder; `isFillBooked()` the only membership test; the store is **marked at credit time** (before any balance moves) and rolled back if the credit fails. A booked key is refused at ingest with no clock. |
| 3 | **Pivot / geometry** — the fill as a market fact | `order/utils/system.ts` (`setLastFillPivot`, `reanchorBoundaryFromLastFill`) | Side from the paid asset (`resolveTradedSide`); price from fill economics, never the slot identity price (`INV-COW-011`); edge-pinned fills never arm the pivot. |
| 4 | **Plan** — the grid update | `order/grid.ts`, `dexbot_cow_runtime.ts` | Built on the working grid; carries the boundary-shift/re-anchor budgets of its cycle. The targeted-drift gate asks `resolveGridUpdateBlockers()` and defers on any code; the other gates use the fill-state projection. |
| 5 | **Lease** — exclusive chain mutation | `order/placement_lock.ts` | One region, one lease-liveness predicate, re-verified immediately before any CREATE/UPDATE broadcast (`INV-BROADCAST-005`). |
| 6 | **Commit / observe** — master swap, then chain observation | `order/manager.ts` | Commit is atomic (`INV-COW-002`); pending-broadcast liveness has one policy (`getLivePendingBroadcasts`). Not yet: no epoch fence (P4), so plan validity is still four signals. |

### 2.2 The four states of a fill

| State | Meaning | Written by |
|---|---|---|
| `unknown` | The fill exists; identity or side could not be resolved | `fill_ledger` returns `null`; the caller declines to book |
| `queued` | Accepted, not yet drained | ingest (stage 1) |
| `booked` | Accounting applied, key claimed in the store | `order/accounting.ts` via the store |
| `committed` | The grid mutation for it is on the master map | `order/manager.ts` commit funnel |

"Committed" is deliberately **not** "observed": a broadcast whose receipt was lost stays
pending until a chain read proves it landed or did not (`INV-LIFE-001`: unknown is never
gone).

### 2.3 Ownership — one writer per fact

Rails, not conventions: `tests/test_fill_pipeline_contract.ts` fails on a new writer.

| Fact | Owner | Forbidden second answer |
|---|---|---|
| chain identity of a fill | `fill_ledger.fillKeyOf` | any other key builder (`buildFillKey` is an alias) |
| which side a fill **traded** | `fill_ledger.resolveTradedSide` | reading `slot.type` as the traded side |
| which side a **level** is on | `geometryTypeForSlotIndex` | rail identity from `slot.type` (accounting side after a partial fill) |
| already booked | `processed_fill_store.tracker` (claimed at credit time) | a second time-window dedupe — the lease is not the horizon |
| may the grid mutate | `resolveGridUpdateBlockers` | per-site predicate composition |
| plan validity | *(open — P4 `gridEpoch`)* | the four-signal staleness judgement |

### 2.4 Invariants

- **INV-FILL-001 — One credit per fill key.** A fill key is
  `orderId:blockNum:historyId`; applying it twice is a no-op at every entry point (queue,
  orphan sweep, bootstrap replay, post-reset). The key is claimed before the credit and
  released on failure, so "credited" and "tracked" cannot disagree within a process; the
  claim lease (`FILL_DEDUPE_WINDOW_MS`) covers only claims restored from a crash.
- **INV-FILL-002 — The paid asset decides the side.** `slot.type` is a grid identity,
  never the traded side; a partial fill retags it to the traded side for dimensional
  consistency, which is exactly why it cannot be trusted for rail questions
  (`INV-SYNC-008`).
- **INV-FILL-003 — Unreadable is unknown, never settled.** A dedupe or pipeline source
  that cannot be read must block grid mutation (`unknown-blocker`), never read as "idle".
- **INV-FILL-004 — A grid blocker is not a per-action wait.** "May the grid mutate?"
  (pipeline, region, pending broadcast, rebuild) is separate from "may this CANCEL be
  deferred?" (`SURPLUS_CANCEL_GRACE_MS`, `INV-RECON-006`) and from "is this order
  known-wrong and must not wait?" (chain-observed `typeMismatch`). One resolver must not
  swallow the other two.
- **INV-FILL-005 — Escalation is a cycle counter, not a timing window.** A stuck state
  escalates after `FILL_PROCESSING.GRID_BLOCKED_ESCALATE_CYCLES` consecutive attempts,
  and only for `unknown-blocker`. Not a `TIMING` entry (`INV-TIME-001`).
- **INV-FILL-006 — Proof paths never default unknown geometry.** A repair proof needs the
  stored type **and** the rail geometry; when either is unknown it falls back to the type
  check and never invents a rail — the opposite of `resolveGapSlots`, which may default
  for *decisions*.
- **INV-FILL-007 — Fill economics beat slot identity.** The pivot and boundary anchor use
  the execution price from paid/received amounts; the slot price is a fallback, never the
  first choice (`INV-COW-011`).

---

## 3. What is implemented (P0–P2)

**P0 — contract + ratchet** (`docs/FILL_PIPELINE.md`, `b2f43d8a`)
`tests/test_fill_pipeline_contract.ts` pins: ten `_processFillsWithBatching` call sites,
the two pivot writers, the three boundary-budget files, the dedupe layer set (ten files,
including the `__chainSizeAppliedInt` writer), the single fill-identity owner, and the
closed blocker code list. Lists may shrink when a phase deletes a duplicate; growing one
requires editing the test — that edit is the review.

**P1 — one blocking decision, fail-closed** (`b2f43d8a`)
- `resolveGridUpdateBlockers(source)` returns eight codes: `fill-queued`, `fill-deferred`,
  `fill-in-flight`, `crawl-owed`, `broadcast-pending`, `placement-held`,
  `rebuild-active`, `unknown-blocker`. Composition only — the broadcast question goes
  through `getLivePendingBroadcasts` (read-only `gc:false` mode), the region through
  `isPlacementActive`, the rebuild through the manager flag.
- `readFillPipelineState()` is the single field reader; unreadable input is `ok: false`
  → `unknown-blocker`. `hasUnsettledFills()` is a projection over the fill codes only, so
  the prose reason and the codes cannot disagree.
- Escalation: `GRID_BLOCKED_ESCALATE_CYCLES` (12) consecutive attempts, **only** for
  `unknown-blocker`, fired from the targeted-drift gate; a busy pipeline is normal work
  and its own watchdogs bound it. That gate now defers on **any** blocker (it is
  chain-mutating), which is a deliberate behaviour change.

**P2 — one fill identity, one dedupe authority** (`b2f43d8a`, P2 tail)
- `order/fill_ledger.ts` owns `fillKeyOf` (with `buildFillKey` as an alias) and
  `resolveTradedSide`; wired into `_computeFillContext`, `attributeUnmatchedFillToGrid`
  and the queued pivot refresh. The SPREAD price fallback stays with
  `resolveSpreadOrderSide`.
- `processFillAccounting` claims the key in the store tracker **before** the credit and
  releases it on every failure path; `_applyBalanceAdjustments` is all-or-nothing, so a
  released claim can always be retried safely.
- `_isNewFillKey` asks the store first (`isFillBooked`, no clock).
- Deleted: `alreadyAppliedChainSize` / `__chainSizeAlreadyApplied` and the dead
  `consumeChainSizeAppliedFill` wrapper. One channel remains: `__chainSizeAppliedInt`.

### 3.1 Findings that changed the design

1. **`snapshot-unsound` dropped from the code list.** The snapshot gate composes its own
   conditions; an unproduced code is a lie in a closed list.
2. **Escalation narrowed to `unknown-blocker`,** and the target gate defers on any
   blocker. Escalating on a busy pipeline would resync healthy bots mid-batch.
3. **`FILL_DEDUPE_WINDOW_MS` stays — as a claim lease.** The original condition (store
   mark synchronous at credit time) now holds, but the window has a second role: claims
   restored from `_recentFillKeysSnapshot` after a crash are the one case where nobody
   knows whether the credit happened. Blocking them forever loses a fill; dropping them
   retries a possible credit. The **dedupe horizon** is `FILL_RECORD_RETENTION_MS` in the
   store (a booked key is refused at any age). Documented in `constants.ts`,
   `timing_policy.ts`, `TIMING_INVENTORY.md`.
4. **`_chainSizeAppliedFills` cannot become a store assertion.** It carries pass-1
   *size-application* evidence, a different fact from "this key was booked". Only its
   boolean view was removed; the amount accessor pair stays.
5. **The P0 ratchet missed the accounting writer** (`__chainSizeAppliedInt` did not match
   its regex). It now pins all ten files.
6. **P4 is an invariant change.** `INV-COW-003` documents "still stale → proceed +
   structural resync"; P4 deletes that branch and must rewrite the invariant (and record
   `gridEpoch` beside `INV-COW-005`, whose `_gridVersion` bump stays) in the same commit.

---

## 4. Remaining work

Each phase ships independently and leaves the tree green. A phase is done when its gate
passes — not when the code exists.

### P3 — One consumer (5 d, highest risk)

- `requestFillDrain(bot, reason)` becomes the only entry point; the ten call sites
  enqueue instead of calling. One serialized consumer owns
  drain → accounting → pivot append → plan → lease → commit → observe.
- A typed deferral enum replaces the `deferred` boolean and the prose reasons; one retry
  policy; the three retry triggers (region-end hook, scheduled rebalance, maintenance
  tick) collapse into one idempotent schedule.
- Coalescing exit (**D2=A**) is a **default flip** (`COALESCE_BACKLOG_REPLAY`) plus
  deleting the false path; the behaviour is already live per bot (`6afa0c4b`).
- New module (**D8=B**): `modules/dexbot_fill_pipeline.ts`; `fill_runtime` keeps ingest.
  Needs `"./dist/modules/dexbot_fill_pipeline.js": false` in the `browser` field; do not
  add it to the browser-safe entry list.
- Gates: N concurrent requests → one ordered drain; a deferred drain retried by exactly
  one trigger; `recon_fuzz` drives `requestFillDrain` instead of internals.
- Risk: startup/replay sequencing. Ship coalescing behaviour-identical, then flip.
- Stop: any credit or order-count change in the existing suite → revert to enqueue-only.

### P4 — Epoch fence (5 d, depends on P3)

- `gridEpoch` is the **structural** counterpart to `_gridVersion` (which keeps its
  per-mutation cache-invalidation job; **D3=B**). One funnel bumps it behind
  `isPlanInvalidatingMutation(oldSlot, newSlot, context)` — state, type, price, chain id,
  slot set, boundary — where a `type` change counts **only when the rail side changes**
  (a partial-fill retag is bookkeeping; counting it would refuse the very plan the fill
  belongs to).
- Plans carry `{ planEpoch, fillKeys, chainReadAt }`; `evaluateCommit` refuses on
  `planEpoch !== gridEpoch`; `replanStaleBatch` becomes "re-derive at the current epoch"
  and the "proceed anyway" branch is deleted (**D1=A**; grid only, no account epoch —
  **D7=A**). The four staleness signals demote from gates to log fields.
- Gates: fuzz op `mutate-before-commit` → zero chain ops; invariant "every broadcast has
  `planEpoch === gridEpoch` at broadcast time"; a mutation test that removes the check and
  watches the fuzzer catch a duplicate.
- Risk: deleting "proceed anyway" is sound only because P3 carries the invalidating fills
  forward. **Do not merge P4 before P3.**
- Stop: the fuzz op refuses a *correct* plan → model `{ epoch, account }` before widening.

### P5 — Chain watermark, retire timers (5–10 d, last)

- Record `{ height, openOrderIdsHash, balancesHash }` per plan; commit requires a read at
  ≥ plan height. `getLivePendingBroadcasts`' TTL becomes "unknown until a watermark newer
  than the record".
- Retire the four fill-path `self-healing` windows one PR at a time (**D6=B**):
  `FILL_BROADCAST_DEFER_MAX_MS`, `FILL_DEDUPE_WINDOW_MS`,
  `CHAIN_SIZE_APPLIED_MARKER_TTL_MS`, `STRUCTURAL_REBUILD_DEFER_MAX_MS`. The other two
  (`SURPLUS_CANCEL_GRACE_MS`, `PENDING_BROADCAST_TTL_MS`) are placement/broadcast policy
  and stay out.
  `FILL_DEDUPE_WINDOW_MS` needs a design first: a crash-restored claim must be resolved
  from chain-balance evidence (recompute the credit from chain truth) instead of by age.
- Gate: each removal ships with the test that previously needed the timer **plus** live
  evidence. No phase closes on tests alone.
- Stop: a removal exposes a lost-state path → that window stays, with the reason recorded
  in the inventory.

### Simplification ledger

Already gone: the fail-open blocker catch, the three side-resolution copies, the duplicate
key builder, the applied-amount boolean, the dead boolean wrapper.

| Today | After |
|---|---|
| 2 budget manager fields + 6 save/restore sites | 1 per-cycle context object (P3) |
| 3 remaining bookkeeping layers (marker, persisted marker, claim lease) | 1 ledger + assertions (P2 tail/P3) |
| 4 staleness signals + "proceed anyway" | 1 epoch (P4) |
| 10 direct call sites of the batch processor | 1 queue, 1 consumer (P3) |
| 4 fill-reference clocks + `lastFillPivotSource` | 1 event log (pivot P0/P1) |
| ≥5 deferral booleans/strings | 1 enum (P3) |

---

## 5. Decision register (accepted 2026-11-04)

| Decision | Route | Why | If reversed |
|---|---|---|---|
| **D1** stale plan at epoch mismatch | **A** — refuse and re-derive | a "proceed anyway" branch makes the fence documentation, not determinism | P4's gates must become "proceed is logged, not prevented" — not worth doing before P5 |
| **D2** backlog replay ordering | **A** — mandatory coalescing | already live per bot in `6afa0c4b`; only the default flip remains | chunked path stays a second permanent behaviour to test |
| **D3** is `_gridVersion` the fence | **B** — keep it private, add structural `gridEpoch` | `_gridVersion` bumps on every slot mutation (accounting included), so it would refuse correct plans | promoting it trips P4's own stop condition |
| **D4** dedupe authority | **B** — the processed-fill store | it already persists `Map<fillKey, timestamp>` and survives grid rebuilds | a snapshot field must be pruned, versioned and migrated |
| **D5** fail-closed escalation | **B** — block, escalate after N cycles | an indefinitely blocked trader is not acceptable; C (whitelist) is the fail-open bug | A risks an indefinite stall; C re-opens the bug |
| **D6** timer-removal scope | **B (amended)** — four fill-path windows | the other two are placement/broadcast policy | removing them without evidence trades a timer for a lost-state bug |
| **D7** epoch scope | **A** — grid only | no evidence a second number is needed; P4's fuzz op will say | adds a second fence before the first is proven |
| **D8** single consumer location | **B** — new `dexbot_fill_pipeline.ts` | `fill_runtime` is already ~1,700 lines; the boundary stays review-visible | the runtime becomes the pipeline and ingest loses its name |
| **D9** contract strictness | **A** — ratchet test | the tree proves review discipline alone does not hold (C1, C5) | the contract becomes prose again |

---

## 6. Definition of done, stop conditions, non-goals

**Done when**
1. `recon_fuzz` gains `mutate-before-commit`, `duplicate-fill-replay`,
   `lagging-read-then-fill`, and the invariants "epoch match" and "single credit".
2. No production write to a fill/dedupe/pivot field outside its owning module (ratchet).
3. Every `INV-FILL-*` has a mutation test: revert the rule, the suite goes red.
4. The historical incidents exist as replayable fixtures and pass.
5. The `self-healing` windows reach the D6 scope.

**Stop conditions** — P2 fixtures change credit count → stop; P3 changes any credit or
order count → revert to enqueue-only; P4 refuses a correct plan → widen the predicate,
never the fence; P5 cannot name the replacing evidence → the window stays.

**Non-goals** — no new guards or allow-lists (every phase removes a predicate or gives it
an owner); no change to order sizes, boundary semantics, strategy or market adaptation; no
TTL widening (the only timing changes are removals); no rewrite of `SyncEngine` adoption —
P2/P4 touch its inputs, not its matching.

---

## 7. Regression canaries and gates

| Phase | Canaries | Failure signature that means stop |
|---|---|---|
| P0 | `test_public_surface_guard`, full suite | ratchet red on an unchanged tree → fix the list, never loosen |
| P1 | `test_fill_transition_idempotency`, `test_cow_guard_replan`, `test_fresh_placement_cancel_grace_paths`, `test_snapshot_reject_gate` | a cycle blocked while `hasUnsettledFills` reports settled; leaked-region count > 0 |
| P2 | `test_fill_store_authority`, `test_fill_transition_idempotency`, `test_orphan_fill_death_spiral`, `test_recent_own_cancels`, `test_fill_subscription_lifecycle`, `test_fill_batch_chunking`, `test_pending_fill_crawls`, snapshot restore | credit/order count changes; `[FILL-LEDGER]` divergence on a clean replay |
| P3 | `test_fill_batch_chunking`, `test_cow_guard_replan`, `test_correction_queue_staleness`, startup/recovery, `recon_fuzz` | a fill credited twice, a drain run twice, or a replay-order change |
| P4 | `recon_fuzz` (`mutate-before-commit`), working-grid suites, `test_price_collision_guard`, `test_gap_evac_*`, `test_correction_queue_staleness` | a correct plan refused; repeated re-derive on one fill set |
| P5 | `test_timing_policy` (count must fall), one test per removed window, `recon_fuzz` | a removal exposes a lost-state path → that window stays |

## 8. Tests this document is held to

`tests/test_fill_pipeline_contract.ts` (ratchet: call sites, writers, dedupe layers,
identity owner, closed code list), `tests/test_grid_update_blockers.ts` (fail-closed
projection, each code, escalation semantics), `tests/test_fill_ledger.ts` (key shape,
paid-asset side, booked membership), `tests/test_fill_store_authority.ts` (claim at credit
time, in-flight duplicate refused, rollback and retry, atomic credit, ingest store check),
plus the behavioural canaries above.

## 9. Implementation log

| Date | Commit | Landed |
|---|---|---|
| 2026-11-04 | `b2f43d8a` | P0 contract + ratchet; P1 eight-code blocker resolver, fail-closed accessor, cycle-counter escalation, targeted-drift gate defers on any blocker; P2 identity (`fill_ledger.ts`) wired into three call sites. `COW_INVARIANTS` refreshed (`INV-RECON-006` exemption, `INV-SYNC-008` accounting-side/rail-side). |
| 2026-11-04 | P2 tail (this commit) | store claimed at credit time with rollback, all-or-nothing credit, `_isNewFillKey` store check, applied-amount boolean deleted, dead wrapper deleted, ratchet fixed to include the accounting writer. Findings 3–5 above recorded. |

Gates at this commit: `npm test` 357/357 files, 14 live skipped, 0 failed; `typecheck`,
`typecheck:analysis`, `check:any`, `verify:browser-bundle` (44/44), timing-policy audit
green.

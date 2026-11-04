# Fill Pipeline Contract

> **Status:** implemented for the parts marked ✅ (P0/P1/P2-slice of
> [FILL_PIPELINE_PLAN.md](FILL_PIPELINE_PLAN.md)); the rest of the plan is
> sequenced there. `tests/test_fill_pipeline_contract.ts` is the ratchet that
> keeps this document honest.
>
> **Scope:** what happens between "the chain executed against one of our orders"
> and "the grid has absorbed it" — and which module owns each step.

---

## Why this document exists

The fill path's failures are not missing safeguards. They are the same question
answered in several places, so the answers can disagree, plus a "wait, then
guess" added wherever they did. Three recent examples, each a different
question:

| Question | How many answers | What it caused |
|---|---|---|
| "Is this fill already booked?" | 4 layers, 3 granularities | double-released trade size, phantom residual |
| "Which side did this trade?" | 3 copies of the pays-asset map | a real SELL booked with quote precision (`filledAmount = 0`), re-bought at the fill level |
| "May the grid mutate now?" | per-site composition of 4 predicates, one failing **open** | a grid update from a stale master while 12 fills were queued |

This document names one owner per question. A change that adds a second answer
must show it here first, and the ratchet test will fail until it does.

---

## The six stages

```
chain read ──► ingest ──► ledger ──► pivot/geometry ──► plan ──► lease ──► commit ──► observe
```

| # | Stage | Owner today | Contract |
|---|---|---|---|
| 1 | **Ingest** — a fill enters the queue | `dexbot_fill_runtime.ts`, `dexbot_subscriptions` | Back-pressure at `MAX_INCOMING_FILL_QUEUE`; a rejected fill leaves the cursor retryable (`INV-SYNC-005`). |
| 2 | **Ledger** — identity + booked membership | `order/fill_ledger.ts` (identity), `order/processed_fill_store.ts` (authority) | `fillKeyOf()` is the only key builder; `isFillBooked()` is the only membership test; the store is the persisted truth. |
| 3 | **Pivot / geometry** — the fill as a market fact | `order/utils/system.ts` (`setLastFillPivot`, `reanchorBoundaryFromLastFill`) | Side comes from the paid asset (`resolveTradedSide`); price comes from fill economics, never the slot identity price (`INV-COW-011`). Edge-pinned fills never arm the pivot. |
| 4 | **Plan** — the grid update | `order/grid.ts`, `dexbot_cow_runtime.ts` | Built on the working grid; carries the boundary-shift/re-anchor budgets of its cycle. ✅ Since P1 the chain-mutating gates ask `resolveGridUpdateBlockers()` and defer on any code (wired at the targeted-drift gate; the other sites use the projection). |
| 5 | **Lease** — exclusive chain mutation | `order/placement_lock.ts` | One region, one lease-liveness predicate, re-verified immediately before any CREATE/UPDATE broadcast (`INV-BROADCAST-005`). |
| 6 | **Commit / observe** — master swap, then chain observation | `order/manager.ts` | The commit is atomic (`INV-COW-002`); pending-broadcast liveness has one policy (`getLivePendingBroadcasts`). ❌ The epoch fence (P4) is not implemented yet: plan validity is still judged by four signals, one of which can proceed anyway. |

## The four states of a fill

| State | Meaning | Written by |
|---|---|---|
| `unknown` | The fill exists; identity or side could not be resolved | `fill_ledger` returns `null`, caller declines to book |
| `queued` | Accepted, not yet drained | ingest (stage 1) |
| `booked` | Accounting applied, key claimed in the store | `order/accounting.ts` via the store |
| `committed` | The grid mutation for it is on the master map | `order/manager.ts` commit funnel |

"Committed" is deliberately **not** "observed": a broadcast whose receipt was
lost stays in the pending-broadcast set until a chain read proves it landed or
did not (`INV-LIFE-001`: unknown is never gone).

---

## Ownership (one writer per fact)

| Fact | Owner | Forbidden second answer |
|---|---|---|
| chain identity of a fill | `fill_ledger.fillKeyOf` | any other key builder (`buildFillKey` is an alias) |
| which side a fill traded | `fill_ledger.resolveTradedSide` | reading `slot.type` as the traded side |
| which side a **level** is on | `geometryTypeForSlotIndex` | rail identity from `slot.type` (it is the accounting side after a partial fill) |
| already booked | `processed_fill_store.tracker` | a second time-window dedupe |
| may the grid mutate | `resolveGridUpdateBlockers` | per-site predicate composition |
| plan validity | *(open — P4 epoch fence)* | the four-signal staleness judgement |

---

## Invariants

- **INV-FILL-001 — One credit per fill key.** A fill key is
  `orderId:blockNum:historyId`; applying the same key twice must be a no-op at
  every entry point (queue, orphan sweep, bootstrap replay, post-reset).
- **INV-FILL-002 — The paid asset decides the side.** `slot.type` is a grid
  identity, never the traded side; a partial fill retags it to the traded side
  for dimensional consistency, which is exactly why it cannot be trusted for
  rail questions (`INV-SYNC-008`).
- **INV-FILL-003 — Unreadable is unknown, never settled.** A dedupe or pipeline
  source that cannot be read must block grid mutation (`unknown-blocker`); it
  must never read as "idle".
- **INV-FILL-004 — A grid blocker is not a per-action wait.** "May the grid
  mutate?" (fill pipeline, region, pending broadcast, rebuild) is separate from
  "may this CANCEL be deferred?" (`SURPLUS_CANCEL_GRACE_MS`, `INV-RECON-006`)
  and from "is this order known-wrong and must not wait?" (the correction
  queue's chain-observed `typeMismatch`). One resolver must not swallow the
  other two.
- **INV-FILL-005 — Escalation is a cycle counter, not a timing window.** A
  stuck state escalates after `FILL_PROCESSING.GRID_BLOCKED_ESCALATE_CYCLES`
  consecutive attempts, and only for `unknown-blocker`. It is not a `TIMING`
  entry and must not become one (`INV-TIME-001`).
- **INV-FILL-006 — Proof paths never default unknown geometry.** A repair proof
  (e.g. `_validatePriceCorrectionEntry`) needs the stored type **and** the rail
  geometry; when either is unknown it falls back to the type check and never
  invents a rail. This is the opposite of `resolveGapSlots`, which may default
  for *decisions*.
- **INV-FILL-007 — Fill economics beat slot identity.** The pivot and the
  boundary anchor use the execution price derived from paid/received amounts;
  the slot price is a fallback, never the first choice (`INV-COW-011`).

---

## What is NOT in this contract (yet)

Sequenced in [FILL_PIPELINE_PLAN.md](FILL_PIPELINE_PLAN.md):

- **P3** — one consumer: ten call sites of `_processFillsWithBatching` still
  call the batch path directly; a typed deferral enum does not exist yet.
- **P4** — the epoch fence: a plan does not carry the grid epoch it was built
  on, and the "proceed anyway" branch still exists (`INV-COW-003`).
- **P5** — chain watermark: "caught-up sync" is still a timer, not a proof.

Each of those narrows this document when it lands; the ratchet test is what
makes the omission visible instead of forgotten.

## Tests

- `tests/test_fill_pipeline_contract.ts` — the ratchet: call sites, pivot
  writers, boundary budgets, dedupe layers, single identity owner, closed
  blocker code list.
- `tests/test_grid_update_blockers.ts` — fail-closed projection, each code,
  escalation semantics.
- `tests/test_fill_ledger.ts` — key shape, paid-asset side resolution,
  booked membership.
- `tests/test_fill_transition_idempotency.ts`, `tests/test_fill_batch_chunking.ts`,
  `tests/test_correction_queue_staleness.ts`, `tests/recon_fuzz.ts` — the
  behavioural canaries for this pipeline.

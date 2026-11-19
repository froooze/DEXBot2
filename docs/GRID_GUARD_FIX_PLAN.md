# LAST-FILL-GUARD fix plan (working copy)

> **Status:** Stages 0–5 done (Stage 3 spike); Stage 6 n/a. Stage 1 landed after a
> reproducing log case was found (re-detected duplicate orphans with repeated cancel
> queues). Recorded 2026-11-19.
> **Canonical history:** `docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md` §9.14.
> Generic terms only — no market, pair, account, bot or order id is named.

## Why this plan exists

A policy-aware `grid_correction_check` run over a live market-pair bot's runtime log
(2026-10-14 → 2026-11-18) reported **48 violations** out of 152 strict candidates
(104 policy divergences). Triage showed the runtime did not breach its own rule:

- 16 direction candidates: 8 were classified by pivot comparison, 8 were
  `unverifiable` and kept by the fail-toward-reporting policy.
- 32 same-level re-fill candidates: 30 predate the build carrying §9.12 Addendum 2/3;
  2 are a one-cycle marker-write race accepted as the in-memory marker limitation in
  §9.12 Addendum 3.
- **All 8 pivot-classified candidates would have passed the last pivot observation at
  or before their placement.** The FAIL is an audit-side defect.

Root cause: `analysis/pivot_timeline.ts` uses `pivotAtOrAfter` for both `plan-action`
and `placed` anchors. A `Placed` line is emitted at commit, *after* `runFinalPivotGate`
and the broadcast, so the first observation after it can belong to the **next** batch.
The fix is source-aware anchor selection — not promoting the deliberately
non-evidence "Pivot refreshed from N pending queued fill(s)" line.

## Stages

| # | Stage | Verdict | Status |
|---|---|---|---|
| 0 | Source-aware pivot anchoring + artifact section | P0 | **done** |
| 1 | Duplicate-orphan cancel verify/hard error | Landed after repro | done (bounded by-id verification at the drain) |
| 2 | Plan→broadcast atomicity | No runtime change; doc reconciliation | done |
| 3 | Chunk replay | Bounded spike | spike done: stop condition met, no code change |
| 4 | Final-gate observability | Counters only | done |
| 5 | Mirror provenance | Merged into Stage 0 | done |
| 6 | Non-goals | Unchanged | n/a |

### Stage 0 — source-aware pivot anchoring (P0)

- [x] In `classifyTransition` (`analysis/pivot_timeline.ts`), select the pivot by
  anchor kind: `plan-action` keeps `pivotAtOrAfter` (the gate follows the plan);
  `placed` uses the last **gate line** at/before the commit (`mode`/`final-gate`/
  `rearm`), bounded by `PIVOT_LOOKBACK_MS`. A `fill-pivot` is never a fallback;
  missing/too-distant gate lines yield `unverifiable`.
- [x] Extend every verdict with anchor kind/timestamp, pivot source (`src`) and
  pivot-selection rule, and surface them in the checker's **JSON and CSV** for
  violations, divergences and artifacts (`mirror.*` on FAIL entries), so a verdict
  can be re-checked without re-running.
- [x] Add a `pivotRule: 'forward'` classifier option so the checker can reproduce
  the old verdict and detect reclassified candidates.
- [x] In `analysis/grid_correction_check.ts`, add a `pivot-anchor-artifact` report
  section and JSON field. Reclassified candidates are **not deleted** — they are
  reported with both pivots. They are not failures and not ordinary divergences.
- [x] The refusal-marker short-circuit returns the matched `RefusalEvent` and writes
  its price/timestamp into `mirror.reason`, so the 6 marker FAILs carry real
  provenance instead of an all-null mirror (Finding 1 follow-up).
- [x] Regression tests: PT-11..PT-15 in `test_pivot_timeline_mirror.ts`, SL-11..SL-14
  in `test_same_level_refill_check.ts` (both kept paths, divergence provenance and
  the JSON/CSV export columns), FG-14; strict mode unchanged.
- [x] Gate: re-run over the same window → 152 strict candidates =
  **104 divergences + 11 artifacts + 37 violations**; 0 of the 37 are classified as
  violations by the corrected rule (31 are `unverifiable`, 6 same-level marker cases
  kept by the fail-toward-reporting path). No new false violations (0 added), 104
  divergences unchanged. Every JSON violation carries `mirror.verdict`/`reason`,
  the runtime pivot and the anchor, so these counts are re-checkable offline.
- [x] **Anchor-window decision (measured, no code change):** 7 of the 37 are on the
  fixed build — 5 `unverifiable` and 2 same-level marker cases. For the 5,
  Kibana fill times precede the bot's `FILL DETECTED` by 30–42 s, and the nearest
  `Placed` lines are *re-placements after detection*, not the order that filled.
  Widening `PLACEMENT_AFTER_FILL_MS` would mis-anchor them to a later gate, so they
  stay `unverifiable` (fail toward reporting). The 2 same-level cases are the
  accepted one-cycle marker-write race of §9.12 Addendum 3.

### Stage 1 — duplicate-orphan cancellation (deferred)

§3.3 P1 asks to verify a `queueCorrection` cancelOnly executes and to hard-error when
it cannot. `queueCorrection` (`modules/order/sync_engine.ts:1096–1124`) only enqueues;
verification belongs at the drain (`modules/order/utils/order.ts:1517+`), re-reading by
id with the existing lag-deferral pattern and escalating only after bounded retries.
Must verify *already-queued* cancels only — no reintroduction of the reverted P1/P2
cancel sweeps (§1). Enter only with a reproducing log or test.

Status: **landed**. The audited log contains re-detected duplicate orphans
(`re-detected 2×/3×; cancel may be failing or the order keeps getting re-created`)
and the same chain id queued for cancel twice seconds apart — evidence that a
"successful" broadcast was not proof the order was gone. Implementation:
`modules/order/utils/order.ts` verifies every already-queued `cancelOnly` entry
with a bounded by-id double read before finalizing: both reads are raced against
an explicit 3 s `withTimeout` (the chain_orders timeout bounds only the connection
wait; the transport RPC cap is 15 s), attempts/backoff and a 10 s per-drain
wall-clock budget come from `PIPELINE_TIMING.CANCEL_VERIFY_*` (the drain holds
`_gridLock`), and a lone batch absence without the second by-id read is never
proof (both reads hit the same
node/connection — the guard catches transient inconsistency, not a stale node;
next-sync re-detection remains the backstop). An inconclusive read defers
with the entry still queued; a confirmed still-live order logs a throttled hard
error and increments `duplicateOrphanCancelUnverifiedCount`, which is overlaid
into `getMetrics()`. Batch-path failures surface in `results`/`failed`; deadline
deferrals appear as `deferred` rows in `results` only (never in `failed`), and the
lagging pre-read path uses the same double-read rule. No new cancel sweep was
introduced — the reverted P1/P2 sweep class stays reverted. Covered by
`tests/test_duplicate_orphan_cancel_verification.ts` (VERIFY-01..11), the extended
`test_p2_observability_counters`, and updated mocks in `test_correction_queue_staleness`
/ `test_surplus_cancel_grace`.

### Stage 2 — atomicity status reconciliation (no runtime change)

Fresh-master re-plan after the single-flight is already implemented
(`modules/dexbot_cow_runtime.ts:5917–5960`); the placement lease is claimed before
planning and held through commit (`PLAN_LEASE_RESULT_KEY`, `claimPlacement`). Fill-less
stale plans are deliberately dropped (`replanStaleBatch:3594`, v1.7.3 changelog).
Annotated §3.3 P1 as LANDED core. The dust-cancel wait is moot: `checkGridHealth` is
detection-only (`order/grid.ts:3524–3539`) and `cancelDustOrders` holds the exclusive
placement region via `runWithPlacement` (`dexbot_maintenance_runtime.ts:3387+`). The log
signature `Plan stale pre-broadcast … dropping the batch` is the safe path for
fill-less plans. No runtime change was needed.

### Stage 3 — chunk replay (bounded spike)

`executeChunkedWithRetryOnUncertain` continues uncertain chunks, aborts the remainder
on definitive failure; `adoptPlacedBatchFromChain` reconciles landed ops by id. Any
replay must adopt by id first, re-plan only the unlanded remainder, and respect §2
Mode C's caveat that "never half-applied" holds only for the refusal path. Stop
condition: reproduce the `2/8` partial-chunk incident in a test; if not reproducible
on the current tree, record that and do not change broadcast behavior.

Spike result: `executeChunkedWithRetryOnUncertain`
(`modules/dexbot_cow_runtime.ts:1698–1807`) aborts the remaining chunks on a
definitive failure and records `chunkAbortedOpCount`; the failure is re-thrown with
partial-state markers for the existing by-id adoption/recovery path. Injecting a
failure at chunk 3 requires a test-only seam in the production broadcast helper —
there is none, and adding one would itself be a behavior change. Stop condition met:
incident not reproducible on the current tree, no broadcast code changed.

### Stage 4 — final-gate observability (counters only)

`runFinalPivotGate` (`:6888–6954`) already re-checks built ops against the refreshed
pivot before broadcast; `dropped=0` is not evidence of a failure. Add counters for
"pivot moved under batch" and for the fail-open gate catch (`:5651`) via
`bot._metrics`. No veto, no queue freeze — §9.13 "Deliberately not done" (3).

Implemented: `recordFinalGateMetric(bot, 'pivot-moved' | 'fail-open')` is the single
owner for `lastFillPivotMovedUnderBatchCount` and `lastFillGateFailOpenCount`, seeded
in `createDefaultBotMetrics()` and pinned by FG-14 in `test_final_pivot_gate.ts`.
No veto, no queue freeze, no behavior change.

### Stage 5 — mirror provenance

Merged into Stage 0: export anchor kind, pivot source and both timestamps. Do not
introduce a `queue-refresh` observation class.

### Stage 6 — non-goals

No refused-level marker persistence (§9.12 Addendum 3), no cooldown/backoff
(Addendum 2), no BUY-pivot P2 exemption and no crossing veto (§9.13 lines 1314–1322),
no general market-runaway re-anchor without soak evidence (§9.13 lines 1341–1343),
and no config/sizing or 24h-TTL change.

## Verification gate

```
npm run analysis:grid-check -- --bot-key <bot-key> \
  --runtime-log profiles/logs/<bot-name>.log --start <iso> --end <iso> \
  --json <out.json>
npm test && npm run typecheck:analysis && npm run check:any
```

Expected: 0 pivot-classified violations; 11 candidates under
`pivot-anchor-artifact`; same-level candidates annotated by deploy generation; 104
divergences still separate.
Keep green: `test_refused_level_refill_block`, `test_same_level_refill_check`,
`test_fill_one_counter_order`, `test_stale_grid_hardening`, `test_incident_replay`.

Note: the 4-way parallel runner has an intermittent cross-file fixture race in two
fund tests (they pass standalone; a re-run was 371/371). Pre-existing and unrelated
to this plan — do not read a single flaky parallel run as a regression.

## Decisions recorded

1. Reclassified candidates stay visible in a dedicated report section.
2. Stage 1 was held until a reproducing case existed; the log supplied one and the
   bounded by-id verification is now landed (see Stage 1 above).
3. The historical record is §9.14; this file is the executable working copy.

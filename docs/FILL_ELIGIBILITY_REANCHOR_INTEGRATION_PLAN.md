# Fill-Eligibility / Re-Anchor Integration Plan

> **Scope:** close the residual out-of-spread failure observed on a live market-pair bot
> after v1.7.3. Only the fix that the post-1.0 retrospective actually justifies is in
> scope; two tempting but rejected changes are recorded as **non-goals** below.
>
> **Evidence:** the attached bot log (snapshot ends 2026-11-17T15:06:15Z) and persisted
> grid snapshot, plus `CHANGELOG.md` v1.7.3 and
> [ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md](ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md).
> Generic terms only — no live markets, accounts, bot names, or order ids.
>
> **Branch:** all work on `test` (pipeline `test` → `dev` → `main`). Git write actions
> only on explicit request; promotion is a separate, later decision.

---

## 1. What happened (genericized)

A fast move in the quote asset left the grid window ~20 ladder steps below the live
market (~1600 vs a window ending near 1500). External takers swept the bot's cheap
bid rail. `setLastFillPivot()` correctly refused ~20 of those fills as *premium sweeps*
(7–27 steps from the live mid) and froze the pivot at the last legitimate window BUY
(`1574.1358`, slot ~134). But `reanchorBoundaryFromLastFill()` took its **batch extremum**
from those same ineligible fills and dragged the boundary down `117 → 116 → 113`. The
sell window was then re-created *below* the frozen pivot, where the direction rule
blocked every sell (`checked=20 passed=0 skipped=20`). At 15:06:09 the spread was
`5.87` against a `1.65` target; the planner requested 14 extra slots and found 2.

Snapshot state: best bid `1500.22`, best ask `1578.84` (5.24% realized), boundary `118`,
pivot `1574.1358 (buy)`, 3 owed BUY crawls, and two `SPREAD`-type slots with
`size > 0` but no chain id. A mid-incident COW chunk also aborted (`2/8` chunks landed,
`DIVERGENCE-COW … not executed`, fund invariant violation → recovery 2/5).

## 2. Already fixed vs residual gap

| Mechanism | Status | This incident |
|---|---|---|
| Off-market / wrong-side fills refused from arming the pivot (§9.12/P1) | v1.7.3 | Worked — pivot stayed on the real fill |
| Refused-level same-price refill marker (§9.12 addendum 2) | v1.7.3 | Worked — did **not** block the promotion (marker held a deeper level) |
| Stale-pivot expiry after the one re-center (`SPREAD_STALE_PIVOT_EXPIRE_MS`) | v1.7.3 | Would fire ~20 min after the re-center; capture ends before it |
| Level-triggered stale recheck (§9.12/P5) | v1.7.1/v1.7.3 | Present in this log historically; no line in the 6-min capture |
| **Eligibility at the re-anchor's batch extremum** | **not enforced** | **Root cause: ineligible fills moved the boundary** |
| Atomic-or-refused COW (§9.6) | claimed | Falsified by `2/8` chunks — narrow residual |

## 3. Change inventory

### C1 — one fill-eligibility rule for the re-anchor (primary, behaviour change)

**Files/functions**
- `modules/order/utils/system.ts`
  - `resolveFillAnchorIndex()` (~1696): accept an eligibility predicate, or filter the
    candidate set before extremum selection. Keep it a pure batch helper — do not add
    chain reads or a second classifier.
  - `reanchorBoundaryFromLastFill()` (~1527): pass only eligibility-filtered fills;
    when the batch has none eligible, fall back to the single fill-provenanced `ref`
    from `resolveFillProvenancedReference()` (~1757) instead of the sweep extremum.
  - Reuse `offMarketFill()` (~2572) and the shared edge/in-band classifiers from
    `modules/order/utils/order.ts` (`collectEdgePinnedFillIds` ~3636,
    `geometryTypeForSlotIndex` ~1835). Fail open on a missing/stale market read exactly
    as §9.12/P1 does — a cold grid must still anchor on its first real fill.
- `modules/order/strategy.ts` (~335): unchanged call site; the fix is inside the helper
  so no caller can bypass it (R3.5: no "one rule, several implementations").

**Invariant to enforce:** an off-market, wrong-side, gap-band, or edge-pinned fill can
neither arm the guard **nor move the geometry** (R5.9, §9.6, §9.10/P1, §9.12/P1).

### C2 — incident-replay regression coverage

Add cases (prefer extending existing suites over new files):
- `tests/test_boundary_fill_reanchor.ts` — `REANCHOR-22..24`: a batch mixing one
  eligible fill and several 20-step-off sweep BUYs must anchor on the eligible one;
  a batch of only ineligible fills must fall back to the provenanced ref; the
  off-market extremum must never produce a boundary below the pivot slot.
- `tests/test_edge_fill_pivot.ts`, `tests/test_pivot_geometry_eligibility.ts` —
  assert the same classifier decides pivot arming and geometry anchoring.
- `tests/test_incident_replay.ts` — end-to-end: fast market move → swept bid rail →
  every placed counter SELL stays above the pivot → spread returns to tolerance
  without a structural rebuild.
- Mutation check: verify the new cases **fail on the pre-fix tree** (the repo's
  established mutation discipline), then pass with C1.

### C3 — verify the existing watchdog/repair paths (no new behaviour unless a gate fails)

- `tests/test_prebroadcast_size_drift_guard.ts` — add the 15:05:00 signature
  (`limit_order_update` on a vanished target detected via size drift; `2/8` chunks;
  divergence deferred). Confirm v1.7.3's *in-place missing-target repair* and
  *clamped PARTIAL updates skipped* prevent `DIVERGENCE-COW … not executed` and the
  fund invariant violation. If the gate fails, fix that path in a **separate commit**;
  do not weaken the pre-broadcast guard (§9.2, §9.10/P4).
- `tests/test_spread_stale_pivot_expiry.ts` / `tests/test_stale_grid_hardening.ts` —
  confirm the 10-min geometry re-center then 20-min pivot expiry actually clear a
  runaway pivot and restore quoting around the live mid.
- `tests/test_pivot_timeline_mirror.ts` — confirm the line *“Pivot refreshed from N
  pending queued fill(s)”* is **not** an observation (§9.12 addendum 1).

### C4 — documentation reconciliation

- `docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md`
  - §9.6 and §9.10/P2 still say the 24h TTL is the only heal after the one re-center;
    record `SPREAD_STALE_PIVOT_EXPIRE_MS` (20 min) from v1.7.3.
  - §9.2 / §9.6's “never half-applied” must be qualified: the chain can still reject a
    chunk *after* the pre-broadcast check; v1.7.3's in-place repair is the recovery.
  - Record this incident as a short ledger row (generic terms) under §9.12 or a new
    §9.13, with the C1 fix and the two rejected changes.
- Related invariant docs (`GRID_RECONCILE.md`, `COW_INVARIANTS.md`) only where their
  wording contradicts the above. No version or release-note changes are part of this
  plan.

## 4. Non-goals (explicitly rejected, with rationale)

1. **Do not extend §9.12/P2's sell exemption to a BUY pivot.** The doc deliberately
   keeps “the BUY mirror blocked”; selling below the last BUY is below cost, and §9.7
   calls a lower SELL below the last fill a geometry fault, not an opportunity. The
   market-runaway case is owned by §9.10/P2 + §9.12/P5 + v1.7.3 pivot expiry.
2. **Do not scope or move the refused-level marker.** §9.12 addendum 2 explicitly
   rejects a cooldown/backoff on the correction loop, and the log shows the marker did
   not block the two placements. It has a documented 30-min lifetime already.
3. **Do not add a crossing veto.** §9.10/P4 and §9.2: a hard reject re-opens the
   counter-order deadlock; crossing CREATEs stay observation-only.
4. **Do not change config, sizing, or the 24h pivot TTL.** No new timing windows
   (TINV policy: classify before adding).

## 5. Integration sequence and gates

| Phase | Work | Exit gate |
|---|---|---|
| 0 | Baseline: capture pre-fix failure with the new tests (red) | New cases fail as expected on unmodified `test` HEAD |
| 1 | C1 only — eligibility at re-anchor | `npm test` green; `npm run typecheck`; `npm run check:any` |
| 2 | C2 — extend the four suites + mutation check | Mutation check confirms the tests bite |
| 3 | C3 — verification of size-drift/expiry/watchdog; fix in a **separate** commit only if a gate fails | No `DIVERGENCE-COW … not executed`, no fund invariant violation in the replay |
| 4 | C4 — doc reconciliation | Cross-reference check: no §9.6/§9.10/P2 statement contradicts v1.7.3 |
| 5 | Full gate | `npm test` (full suite), `npm run typecheck`, `npm run typecheck:analysis`, `npm run check:any`, `npm run verify:browser-bundle`, `npm run test:live` |

Offline audit after promotion (policy-aware by default):
```
npm run analysis:grid-check -- --bot-key <bot-key> --account <account-id> --hours 168
```
Expected: the sweep re-quotes are `policy-divergence`, not `violation`; no same-level
violations from the refused-level loop; direction verdicts unchanged.

## 6. Live verification after deployment

Watch the affected bot's log for one full market cycle:

- no `Re-anchored from the last fill: … slot <deep>` line whose fill was logged as
  *“premium sweep of our own rail”* in the same window;
- `[SPREAD-CORRECTION] Requested N extra slot(s), found M` with `M == N` when funded;
- realized spread ≤ `targetSpreadPercent × MIN_SPREAD_FACTOR` (here ≈ 1.65);
- no `DIVERGENCE-COW … not executed`, no `CRITICAL: Fund invariant violation`;
- if a pivot does strand a side, `[SPREAD-STALE]` shows the single re-center followed
  by the bounded expiry, not an indefinite veto;
- `pendingFillCrawls` drains and no `SPREAD` slot carries `size > 0` with an empty id.

## 7. Risks and rollback

- **Fail-open is deliberate** (§9.12/P1): with no fresh market read, an off-market fill
  may still anchor. That is safer than freezing a cold grid; do not "fix" it by
  inventing a stale-mid floor.
- **Fallback to the single provenanced ref** must still pass
  `validatePersistedBoundary`; a repair that strands more placed orders is refused
  (§9.11.3).
- **Concurrency:** keep every chain-mutating path inside the existing placement region
  (§9.11.3); the re-anchor is plan-time only.
- **Rollback:** C1 and C4 are isolated commits on `test`; reverting the C1 commit
  restores prior behaviour. No snapshot migration, config migration, or persisted
  schema change. If a bot is already stuck, the operator-side recovery (verify the
  watchdog, clear the expired pivot, re-center with `refreshCenterPrice: true` only
  after the fill pipeline is idle) is independent of this code change.

## 8. Commit and promotion discipline

- One atomic commit per phase, conventional prefix (`fix(order):`, `test(guards):`,
  `docs:`), body explains **why** and cites the retrospective sections.
- Stage only the scoped files; never restore or overwrite dirty files from another
  work in progress.
- No real bot/account/pair names, addresses, or order ids in commits, PRs, or docs —
  use `bot-A`, `<market-pair>`, `account-name`, `<order-N>`.
- Promotion `test` → `dev` → `main` is a separate, explicitly authorized action;
  do not run `ptest`/`pdev`/`pmain` force-push scripts unless asked.

## 9. Definition of done

1. C1 is live on `test` with the §9.6 invariant actually enforced at the re-anchor.
2. The replay suite reproduces the incident and fails without C1.
3. All gates in Phase 5 pass.
4. Live log shows the acceptance signals in §6 for one market cycle.
5. Retrospective and invariant docs match v1.7.3 and the new ledger row.
